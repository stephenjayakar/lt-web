/**
 * QA driver (dev/QA builds only; see docs/qa-tools.md).
 *
 * Runs once per stepped frame and answers whatever the game is waiting for,
 * through the same inputs and engine paths a player would use:
 *
 * - events: skip mode (as if START were pressed at the first line), held
 *   dialogs and alerts dismissed, choices answered by the policy;
 * - EOtF Act maps (free roam): walk up to a room and talk to it (the roam
 *   unit is placed beside the NPC instead of walked there);
 * - sub-rooms (shop/camp): talk to each service once, back out of shop
 *   screens, then take the exit;
 * - preparations: Fight;
 * - player phase: every player unit gets a QA AI preset and the engine's
 *   own AIState plays the phase (attack/heal/seize/visit), then the turn
 *   ends normally;
 * - leaf screens (shop, info, options...): BACK.
 *
 * It also keeps the per-floor log (rooms, levels, combats, deaths, events,
 * warnings) and detects a stuck game.
 */

import type { GameButton } from '../engine/input';
import { Policy, type ChoiceContext } from './qa-policy';
import type { QaLog } from './qa-log';
import { realNow } from './qa-clock';

export type DriverMode = 'off' | 'jump' | 'play';

export interface LevelRecord {
  nid: string;
  name: string;
  kind: 'hub' | 'act' | 'battle' | 'other';
  objective: string;
  turns: number;
  combats: number;
  playerDeaths: string[];
  enemyDeaths: number;
  result: string;
  realMs: number;
  frames: number;
}

export interface FloorRecord {
  floor: number | null;
  act: string | null;
  roomsOffered: string[];
  chosen: string[];
  levels: LevelRecord[];
  events: Record<string, number>;
  warnings: number;
  errors: number;
  notes: string[];
  realMs: number;
  frames: number;
}

/** QA AI presets: the engine AI plays the player phase with these. */
const QA_AI_FIGHTER = 'QA_Fighter';
const QA_AI_HEALER = 'QA_Healer';
const OBJECTIVE_REGIONS = ['Seize', 'Arrive', 'Escape', 'Defuse', 'Visit', 'Key Point', 'Switch'];

function behaviour(action: string, target: string, spec: unknown, viewRange: number, condition = '') {
  return {
    action, target, target_spec: spec, view_range: viewRange,
    invert_targeting: false, roam_speed: 100, desired_proximity: 0, condition,
  };
}

/**
 * The first turns are played patiently: attack what is in reach this turn,
 * otherwise hold so the enemy walks into the party instead of the party
 * walking into the enemy one unit at a time. From PATIENT_TURNS on, units
 * go for the objective regions and then pursue.
 */
const PATIENT_TURNS = 3;

export function registerQaAiPresets(game: any): void {
  const later = `game.turncount >= ${PATIENT_TURNS}`;
  const objectives = OBJECTIVE_REGIONS.map((spec) => behaviour('Interact', 'Event', spec, -4, later));
  game.db.ai.set(QA_AI_FIGHTER, {
    nid: QA_AI_FIGHTER,
    behaviours: [
      behaviour('Attack', 'Enemy', null, -2),
      ...objectives,
      behaviour('Attack', 'Enemy', null, -4, later),
    ],
    priority: 20,
    offense_bias: 2,
    roam_ai: false,
  });
  game.db.ai.set(QA_AI_HEALER, {
    nid: QA_AI_HEALER,
    behaviours: [
      behaviour('Support', 'Ally', null, -2),
      behaviour('Attack', 'Enemy', null, -2),
      ...objectives,
      behaviour('Move_to', 'Ally', null, -4, later),
    ],
    priority: 15,
    offense_bias: 1,
    roam_ai: false,
  });
}

/** States the driver backs out of (leaf screens a policy has no use for). */
const BACK_OUT = new Set([
  'shop', 'info_menu', 'base_info_menu', 'option_menu', 'objective_menu', 'minimap', 'dialog_log',
  'settings_menu', 'trade', 'prep_trade', 'prep_trade_select', 'prep_items', 'supply_items',
  'prep_manage_select', 'base_manage', 'party_transfer', 'optimize_all_choice', 'prep_formation',
  'prep_formation_select', 'prep_market', 'prep_restock', 'base_codex', 'base_records', 'base_supports',
  'base_sound_room', 'base_achievement', 'base_convos', 'base_bexp_select', 'base_bexp_allocate',
  'base_market_select', 'turnwheel', 'menu', 'item', 'targeting', 'weapon_choice', 'move',
  // Between-chapter save prompt: BACK continues to the next level unsaved.
  'title_save', 'save_menu',
]);
/** States that advance on SELECT. */
const PRESS_SELECT = new Set([
  'alert', 'victory', 'promotion_choice', 'class_change_choice', 'item_discard', 'credit',
]);

export interface DriverOptions {
  skipEvents: boolean;
  maxTurns: number;
  forceWin: boolean;
  autoplay: boolean;
}

export class QaDriver {
  mode: DriverMode = 'off';
  policy: Policy;
  options: DriverOptions = { skipEvents: true, maxTurns: 40, forceWin: false, autoplay: true };
  /** Set by the controller to queue an ad-hoc script. */
  runScript: (lines: string[], nid?: string) => void = () => {};

  floors: FloorRecord[] = [];
  /** Why the driver stopped playing (set on game over / stuck / turn limit). */
  stopReason: string | null = null;
  frame = 0;

  private game: any;
  private log: QaLog;
  private cooldown = 0;
  private savedAi = new Map<any, string>();
  private choiceRepeats = new Map<string, number>();
  private visited = new Set<string>();
  private lastTop: any = null;
  private currentFloor: FloorRecord | null = null;
  private currentLevel: LevelRecord | null = null;
  private levelStartReal = 0;
  private levelStartFrame = 0;
  private floorStartReal = 0;
  private floorStartFrame = 0;
  private deadSeen = new Set<any>();
  /** Player unit nid -> dead at the last observation (deaths are edges). */
  private playerDead = new Map<string, boolean>();
  private lastSignature = '';
  private lastProgressFrame = 0;
  private lastProgressReal = 0;
  private stuckAttempts = 0;
  private forcedWinTurn = -1;

  constructor(game: any, log: QaLog, policy: Policy) {
    this.game = game;
    this.log = log;
    this.policy = policy;
    log.onLog = (text) => this.onEngineLog(text);
    log.onEntry = (entry) => {
      if (!this.currentFloor) return;
      if (entry.kind === 'warn') this.currentFloor.warnings += 1;
      else this.currentFloor.errors += 1;
    };
  }

  // -------------------------------------------------------------------------
  // Per-frame entry point
  // -------------------------------------------------------------------------

  /** Called before every stepped frame; returns the input for that frame. */
  tick(): GameButton | null {
    this.frame += 1;
    if (this.mode === 'off') return null;
    const game = this.game;
    const top = game.state.getCurrentState();
    const name: string = top?.name ?? '';
    if (top !== this.lastTop) {
      if (name === 'combat' && this.currentLevel) this.currentLevel.combats += 1;
      this.lastTop = top;
    }
    if (this.frame % 15 === 0) this.observe();
    if (this.mode === 'play' && this.frame % 60 === 0) this.checkStuck();

    // Skip mode must be re-applied: every new event resets it.
    if (name === 'event' && this.options.skipEvents) {
      top.skipMode = true;
      top.superSkip = true;
    }
    if (this.savedAi.size > 0 && (game.phase?.getCurrent?.() !== 'player' || name === 'free')) {
      this.restoreAi();
    }

    if (this.pendingInput) {
      const key = this.pendingInput;
      this.pendingInput = null;
      this.cooldown = 4;
      return key;
    }
    if (this.cooldown > 0) {
      this.cooldown -= 1;
      return null;
    }
    const input = this.decide(top, name);
    if (input !== undefined) this.cooldown = 4;
    return input ?? null;
  }

  /** Returns an input, null for "acted without input", undefined for "nothing to do". */
  private decide(top: any, name: string): GameButton | null | undefined {
    if (!top) return undefined;
    if (name === 'event') return this.handleEvent(top);
    if (BACK_OUT.has(name)) return 'BACK';
    if (PRESS_SELECT.has(name)) return 'SELECT';
    if (name === 'text_entry') return this.handleTextEntry(top);
    if (this.mode !== 'play') return undefined;
    if (name === 'prep_main') return this.handlePrep(top);
    if (name === 'prep_pick') return 'BACK';
    if (name === 'free_roam') return this.handleRoam(top);
    if (name === 'free') return this.handleFree();
    if (name === 'game_over' || name.startsWith('title')) {
      if (!this.stopReason) this.stopReason = name === 'game_over' ? 'game over' : `returned to ${name}`;
      return undefined;
    }
    return undefined;
  }

  // -------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------

  private handleEvent(ev: any): GameButton | null | undefined {
    if (ev.choiceMenu) return this.answerChoice(ev);
    if (ev.dialog) return 'START';
    if (ev.banner && ev.bannerIsAlert) return 'SELECT';
    if (ev.chapterTitlePhase && ev.chapterTitlePhase !== 'none') return 'SELECT';
    return undefined;
  }

  private answerChoice(ev: any): GameButton | null {
    const menu = ev.choiceMenu;
    const levelNid = this.game.currentLevel?.nid ?? null;
    const nid: string | null = ev.choiceNid ?? null;
    const key = `${levelNid}|${nid}`;
    const repeats = this.choiceRepeats.get(key) ?? 0;
    const ctx: ChoiceContext = {
      nid,
      title: String(menu.cfg?.title ?? ''),
      options: (menu.options ?? []).map((o: any) => ({ label: String(o.label ?? ''), value: String(o.value ?? ''), enabled: o.enabled !== false })),
      backable: !!(ev.choiceBackable || ev.choicePersist),
      level: levelNid,
      floor: this.game.gameVars.get('Floor'),
      repeats,
    };
    const decision = this.policy.choose(ctx);
    this.choiceRepeats.set(key, repeats + 1);
    if ('back' in decision) {
      this.note(`choice ${nid ?? '?'}: BACK`);
      return 'BACK';
    }
    menu.setCursor?.(decision.index);
    if (!menu.setCursor) menu.selectedIndex = decision.index;
    const chosen = ctx.options[decision.index];
    if (nid !== 'New_Party') this.note(`choice ${nid ?? '?'}${ctx.title ? ` "${ctx.title.slice(0, 40)}"` : ''}: ${chosen?.value ?? decision.index}`);
    return 'SELECT';
  }

  private handlePrep(prep: any): GameButton | null | undefined {
    const options: string[] = prep.options ?? [];
    const fight = options.indexOf('Fight');
    if (fight < 0) return undefined;
    prep.cursor = fight;
    return 'SELECT';
  }

  private handleTextEntry(state: any): GameButton | null {
    this.note('text_entry: backed out');
    return 'BACK';
  }

  // -------------------------------------------------------------------------
  // Free roam (EOtF Act maps and sub-rooms)
  // -------------------------------------------------------------------------

  private handleRoam(roam: any): GameButton | null | undefined {
    const game = this.game;
    if (game.eventManager?.hasActiveEvents()) return undefined;
    const roamNid: string | undefined = game.roamInfo?.roamUnitNid;
    const roamUnit = roamNid ? game.getUnit(roamNid) : null;
    if (!roamUnit?.position || !roam.movementComponent) return undefined;
    const levelNid: string = game.currentLevel?.nid ?? '';
    if (levelNid === 'X') return undefined; // the hub is driven by jump()
    const talkable = (game.getAllUnits() as any[]).filter((u) =>
      u !== roamUnit && u.position && !u.isDead() && game.eventManager?.hasTalkPair?.(roamUnit.nid, u.nid));
    const rooms = talkable
      .filter((u) => /^room/.test(u.nid))
      .map((u) => ({ nid: u.nid as string, kind: this.roomKind(u.nid) }));
    // Shop/camp sub-rooms, and Act maps that are only a service stop (Act 4's
    // first floors): visit the services, then take the exit.
    const subroom = Number(game.gameVars.get('in_subroom') ?? 0) === 1 || rooms.length === 0;
    let target: any = null;
    if (subroom) {
      const scope = `${levelNid}|${game.gameVars.get('Floor')}|sub`;
      target = talkable.find((u) => u.nid !== 'exit' && !this.visited.has(`${scope}|${u.nid}`) && this.policy.wantsService(u.nid));
      if (target) this.visited.add(`${scope}|${target.nid}`);
      else target = talkable.find((u) => u.nid === 'exit') ?? null;
      if (target) this.note(`talk ${target.nid}`);
    } else {
      if (this.currentFloor && this.currentFloor.roomsOffered.length === 0) {
        this.currentFloor.roomsOffered = rooms.map((r) => `${r.kind}${this.roomReward(r.nid)}`);
      }
      const pick = this.policy.chooseRoom(rooms);
      target = pick ? talkable.find((u) => u.nid === pick) : null;
      if (target) {
        const label = `${this.roomKind(target.nid)}${this.roomReward(target.nid)}`;
        // A press can be dropped (a state starting that frame); log the retry once.
        const chosen = this.currentFloor?.chosen;
        if (chosen && chosen[chosen.length - 1] !== label) {
          chosen.push(label);
          this.note(`room ${target.nid} = ${label}`);
        }
      } else {
        target = talkable.find((u) => u.nid === 'exit') ?? null;
      }
    }
    if (!target) return undefined;
    if (!this.placeBeside(roam, roamUnit, target)) return undefined;
    return 'SELECT';
  }

  private roomKind(nid: string): string {
    if (nid === 'room4') return 'Elite';
    const value = this.game.levelVars?.get?.(nid);
    return value === undefined || value === null ? nid : String(value);
  }

  private roomReward(nid: string): string {
    const reward = this.game.levelVars?.get?.(`${nid}_reward`);
    return reward ? `(${reward})` : '';
  }

  /** Put the roam unit on a free tile next to `target` (Python talk range). */
  private placeBeside(roam: any, unit: any, target: any): boolean {
    const game = this.game;
    const [tx, ty] = target.position;
    const candidates: [number, number][] = [[tx, ty + 1], [tx - 1, ty], [tx + 1, ty], [tx, ty - 1]];
    for (const [x, y] of candidates) {
      if (!game.board.inBounds(x, y)) continue;
      const occupant = game.board.getUnit(x, y);
      if (occupant && occupant !== unit) continue;
      game.board.removeUnit(unit);
      unit.position = [x, y];
      game.board.setUnit(x, y, unit);
      // EOtF's talk range is 1.0 measured strictly from the sprite's
      // sub-tile position, so stand a little closer than a full tile, as a
      // player walking into the NPC does.
      roam.movementComponent.roamPosition = { x: x + (tx - x) * 0.45, y: y + (ty - y) * 0.45 };
      return true;
    }
    return false;
  }

  // -------------------------------------------------------------------------
  // Player phase
  // -------------------------------------------------------------------------

  private handleFree(): GameButton | null | undefined {
    const game = this.game;
    if (!this.options.autoplay) return undefined;
    if (game.phase?.getCurrent?.() !== 'player') return undefined;
    if (game.eventManager?.hasActiveEvents()) return undefined;
    const turn = Number(game.turnCount ?? 0);
    if (turn > this.options.maxTurns) {
      if (this.options.forceWin) {
        if (this.forcedWinTurn !== turn) {
          this.forcedWinTurn = turn;
          this.note(`turn limit ${this.options.maxTurns}: forced win`);
          if (this.currentLevel) this.currentLevel.result = 'forced win';
          this.runScript(['win_game'], 'QA_Force_Win');
        }
        return undefined;
      }
      if (!this.stopReason) this.stopReason = `turn limit (${this.options.maxTurns}) on level ${game.currentLevel?.nid}`;
      return undefined;
    }
    const units = (game.getAllUnits() as any[]).filter((u) =>
      u.team === 'player' && u.position && !u.isDead() && !u.finished);
    for (const unit of units) {
      if (!this.savedAi.has(unit)) this.savedAi.set(unit, unit.ai);
      unit.ai = this.presetFor(unit);
    }
    game.state.change('ai');
    return null;
  }

  private presetFor(unit: any): string {
    const heals = (unit.items ?? []).some((item: any) =>
      item?.hasComponent?.('heal') || item?.hasComponent?.('magic_heal'));
    return heals ? QA_AI_HEALER : QA_AI_FIGHTER;
  }

  private restoreAi(): void {
    for (const [unit, ai] of this.savedAi) unit.ai = ai;
    this.savedAi.clear();
  }

  // -------------------------------------------------------------------------
  // Floor / level tracking
  // -------------------------------------------------------------------------

  private onEngineLog(text: string): void {
    if (!this.currentFloor) return;
    const match = /^EventManager: (?:specifically )?triggered "([^"]+)"/.exec(text);
    if (match) {
      const nid = match[1];
      this.currentFloor.events[nid] = (this.currentFloor.events[nid] ?? 0) + 1;
    }
  }

  note(text: string): void {
    const floor = this.currentFloor;
    if (floor && floor.notes.length < 80) floor.notes.push(text);
  }

  /** Start tracking (called when play starts). */
  beginTracking(): void {
    this.floors = [];
    this.currentFloor = null;
    this.currentLevel = null;
    this.stopReason = null;
    this.playerDead.clear();
    this.observe();
  }

  /** Close the open records (called when play stops). */
  finishTracking(result: string): void {
    this.closeLevel(result);
    this.closeFloor();
  }

  private observe(): void {
    const game = this.game;
    const levelNid: string | null = game.currentLevel?.nid ?? null;
    const floorVar = game.gameVars?.get?.('Floor');
    const floor = typeof floorVar === 'number' ? floorVar : null;
    if (this.mode !== 'play') return;
    // Global_Level_End raises Floor while the finished battle is still the
    // current level; the floor record changes once the next level is up.
    const floorChanged = !this.currentFloor || this.currentFloor.floor !== floor;
    const stillInBattle = this.currentLevel?.kind === 'battle' && this.currentLevel.nid === levelNid;
    if (floorChanged && !stillInBattle) {
      this.closeLevel(this.currentLevel?.kind === 'battle' ? 'won' : 'left');
      this.closeFloor();
      this.openFloor(floor);
    }
    if (levelNid && this.currentLevel?.nid !== levelNid) {
      this.closeLevel(this.currentLevel?.kind === 'battle' ? 'won' : 'left');
      this.openLevel(levelNid);
    }
    const level = this.currentLevel;
    if (level) {
      level.turns = Math.max(level.turns, Number(game.turnCount ?? 0));
      for (const unit of game.getAllUnits() as any[]) {
        const dead = !!unit.isDead?.();
        if (unit.team === 'player') {
          // Units are rebuilt between levels, so track deaths by nid.
          const before = this.playerDead.get(unit.nid);
          if (dead && before === false) level.playerDeaths.push(`${unit.nid}@T${game.turnCount}`);
          this.playerDead.set(unit.nid, dead);
          continue;
        }
        if (!dead || this.deadSeen.has(unit)) continue;
        this.deadSeen.add(unit);
        if (unit.team === 'enemy' || unit.team === 'enemy2') level.enemyDeaths += 1;
      }
    }
  }

  private openFloor(floor: number | null): void {
    this.floorStartReal = realNow();
    this.floorStartFrame = this.frame;
    this.choiceRepeats.clear();
    this.currentFloor = {
      floor,
      act: null,
      roomsOffered: [],
      chosen: [],
      levels: [],
      events: {},
      warnings: 0,
      errors: 0,
      notes: [],
      realMs: 0,
      frames: 0,
    };
    this.floors.push(this.currentFloor);
  }

  private closeFloor(): void {
    const floor = this.currentFloor;
    if (!floor) return;
    floor.realMs = Math.round(realNow() - this.floorStartReal);
    floor.frames = this.frame - this.floorStartFrame;
    this.currentFloor = null;
  }

  private openLevel(nid: string): void {
    const game = this.game;
    const prefab = game.db.levels.get(nid);
    const tags: string[] = prefab?.tags ?? [];
    const kind: LevelRecord['kind'] = nid === 'X' ? 'hub'
      : tags.includes('Roam_Map') ? 'act'
        : prefab && !prefab.roam ? 'battle' : 'other';
    this.levelStartReal = realNow();
    this.levelStartFrame = this.frame;
    this.deadSeen = new Set((game.getAllUnits() as any[]).filter((u) => u.isDead?.()));
    this.choiceRepeats.clear();
    this.forcedWinTurn = -1;
    this.currentLevel = {
      nid,
      name: String(prefab?.name ?? nid),
      kind,
      objective: String(prefab?.objective?.win ?? ''),
      turns: 0,
      combats: 0,
      playerDeaths: [],
      enemyDeaths: 0,
      result: '',
      realMs: 0,
      frames: 0,
    };
    if (kind === 'act' && this.currentFloor) this.currentFloor.act = nid;
    this.currentFloor?.levels.push(this.currentLevel);
  }

  private closeLevel(result: string): void {
    const level = this.currentLevel;
    if (!level) return;
    if (!level.result) level.result = result;
    level.realMs = Math.round(realNow() - this.levelStartReal);
    level.frames = this.frame - this.levelStartFrame;
    this.currentLevel = null;
  }

  /** Mark the open battle as lost (game over). */
  markLoss(reason: string): void {
    if (this.currentLevel && !this.currentLevel.result) this.currentLevel.result = reason;
  }

  // -------------------------------------------------------------------------
  // Stuck detection
  // -------------------------------------------------------------------------

  private signature(): string {
    const game = this.game;
    const event = game.eventManager?.getCurrentEvent?.();
    const units = (game.getAllUnits() as any[])
      .filter((u) => u.position)
      .map((u) => `${u.nid}${u.position[0]},${u.position[1]}${u.currentHp}${u.finished ? 'f' : ''}`)
      .join(';');
    return [
      game.state.getStackNames().join('>'),
      game.currentLevel?.nid,
      game.turnCount,
      game.phase?.getCurrent?.(),
      event?.nid,
      event?.commandPointer,
      units.length,
      units,
    ].join('|');
  }

  private checkStuck(): void {
    const sig = this.signature();
    const now = realNow();
    if (sig !== this.lastSignature) {
      this.lastSignature = sig;
      this.lastProgressFrame = this.frame;
      this.lastProgressReal = now;
      this.stuckAttempts = 0;
      return;
    }
    const idleFrames = this.frame - this.lastProgressFrame;
    const idleMs = now - this.lastProgressReal;
    if (idleFrames < 3600 || idleMs < 10_000) return;
    const top = this.game.state.getStackNames().join('>');
    if (this.stuckAttempts < 3) {
      const key: GameButton = (['BACK', 'SELECT', 'START'] as const)[this.stuckAttempts];
      this.log.record('qa', `stuck for ${idleFrames} frames in ${top}; pressing ${key}`);
      this.note(`stuck in ${top}: ${key}`);
      this.pendingInput = key;
      this.stuckAttempts += 1;
      this.lastProgressFrame = this.frame;
      this.lastProgressReal = now;
      return;
    }
    if (!this.stopReason) this.stopReason = `stuck in ${top}`;
  }

  /** An input queued by stuck recovery, consumed by the controller. */
  pendingInput: GameButton | null = null;
}
