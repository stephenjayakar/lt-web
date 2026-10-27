import { isForkEngine } from '../engine/engine-flavor';
import type { UnitObject } from '../objects/unit';
import type { ItemObject } from '../objects/item';
import type { Database } from '../data/database';
import type { GameBoard } from '../objects/game-board';
import type { CombatStrike } from './combat-solver';
import { CombatPhaseSolver, type RngMode } from './combat-solver';
import {
  hasDamageOnMiss,
  eclipseDamage,
  eclipseFe7Damage,
  hasEclipse,
  hasEclipseFe7,
  lifelinkHealForStrike,
  usesConsumedByStrikes,
} from './item-system';
import {
  applyGroupCombatComponents,
  combatComponentExp,
  combatExpShare,
  grantPartnerCombatWexp,
  type WeaponRankUp,
} from './combat-components';
import type { ActionLog } from '../engine/action';
import { CombatResultAction } from './combat-result-action';
import {
  CombatLifecycleRecord,
  type CombatProcMark,
} from './combat-skill-lifecycle';
import { getCombatRandom, type RandomGameState } from '../engine/static-random';
import {
  cueFromMark,
  dedupeProcCues,
  displaySkillCues,
  isProcIconVisible,
  type CombatProcCue,
} from './proc-presentation';
import { applyExpGain } from '../engine/leveling';
import { applyPermanentDamage, checkEnemy } from './skill-system';
import { canCounterattack, computeCrit, computeDamage, computeHit, weaponTriangle } from './combat-calcs';
import { MapCombatInfo, type MapCombatInfoMethod, type MapCombatStats } from './map-combat-info';
import { MapAnimation } from '../rendering/map-animation';
import {
  applyPresentedStrikeHp,
  strikeEventHpDeltas,
  type StrikeEventCombat,
  type StrikeEventHook,
} from './strike-events';
import {
  addDamageNumbers,
  facingFor,
  markDying,
  setCombatPose,
  setCombatPoseOffset,
  startFlicker,
  startVibrate,
} from './map-unit-fx';

// ============================================================
// MapCombat - Manages the visual presentation of combat on the
// map.  Shows health bar changes, hit/miss effects frame by
// frame.
// ============================================================

/** Python MapCombat states (map_combat.py update). */
export type MapCombatState =
  | 'init' | 'init_pause' | 'begin_phase' | 'proc_animations' | 'start_anim'
  | 'sound' | 'anim' | 'hp_bar_wait' | 'end_phase_anim' | 'end_phase'
  | 'strike_events' | 'exp_wait' | 'post_combat' | 'done';

/** Detailed combat results returned by applyResults(). */
export interface CombatResults {
  attackerDead: boolean;
  defenderDead: boolean;
  expGained: number;
  /** Who earned expGained (Python handle_exp: player attacker, else player defender). */
  expUnit?: UnitObject | null;
  /** Stat gains from each level-up (may be empty). */
  levelUps: Record<string, number>[];
  /** Whether the attacker's weapon broke. */
  attackWeaponBroke: boolean;
  /** Whether the defender's weapon broke. */
  defenseWeaponBroke: boolean;
  /** Item dropped by the defender on death, or null. */
  droppedItem: import('../objects/item').ItemObject | null;
  /** WEXP granted to the initiating unit. */
  attackerWexpGained: number;
  /** Weapon rank crossed by the initiating unit, if any. */
  attackerRankUp: WeaponRankUp | null;
  /** Item selected by a successful Steal hook, pending reversible transfer. */
  stolenItem: import('../objects/item').ItemObject | null;
  /** Every defender killed by this encounter, including splash targets. */
  defenderDeaths?: UnitObject[];
  /** Droppable items found on dead defenders, paired with their owners. */
  droppedItems?: { unit: UnitObject; item: import('../objects/item').ItemObject }[];
  /** Map positions captured before reversible death removal. */
  deathPositions?: Map<UnitObject, [number, number] | null>;
}

export interface MapCombatGroup {
  /** Null for spell-style AOE where every affected unit is splash. */
  mainDefender: UnitObject | null;
  splashDefenders: UnitObject[];
  /**
   * EOtF merged multi-target: the splash list as the solver strikes it,
   * with a unit repeated once per time its position was chosen.
   */
  splashStrikes?: UnitObject[];
}

/** movement_counter: the map attack lunge offsets (counters.py). */
const ATTACK_MOVEMENT = [0, 1, 2, 3, 4, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 4, 3, 2, 1];

/** Floating damage number */
export interface DamagePopup {
  x: number;         // tile x
  y: number;         // tile y
  value: number;     // damage amount (0 = miss)
  isCrit: boolean;
  isHeal?: boolean;
  elapsed: number;   // ms since spawn
  duration: number;  // total lifetime ms
}

/** Per-unit animation offsets for rendering */
export interface CombatAnimState {
  /** Pixel offset for lunge animation [dx, dy] */
  lungeOffset: [number, number];
  /** Pixel offset for hit-shake [dx, dy] */
  shakeOffset: [number, number];
  /** Flash alpha (0 = no flash, 1 = full white overlay) */
  flashAlpha: number;
  /**
   * Additive/subtractive color blend applied to the unit sprite on hit
   * (Python `map_hit_add_blend` / `map_hit_sub_blend`). `tintAlpha` decays
   * the same way `flashAlpha` does. `null` when no tint is active.
   */
  tintColor: [number, number, number] | null;
  tintMode: 'add' | 'sub' | null;
  tintAlpha: number;
}

function freshAnimState(): CombatAnimState {
  return {
    lungeOffset: [0, 0],
    shakeOffset: [0, 0],
    flashAlpha: 0,
    tintColor: null,
    tintMode: null,
    tintAlpha: 0,
  };
}

export interface MapCombatOptions {
  /**
   * Resolve phases as the presentation reaches them (Python solver.do in
   * begin_phase) instead of all at construction, so start-combat events run
   * before the first strike is solved and strike events between strikes.
   */
  deferSolve?: boolean;
}

export class MapCombat implements StrikeEventCombat {
  attacker: UnitObject;
  /** Representative defender retained for single-combat UI compatibility. */
  defender: UnitObject;
  /** Python's main defender; only this unit can counter. */
  primaryDefender: UnitObject | null;
  splashDefenders: UnitObject[];
  defenders: UnitObject[];
  attackItem: ItemObject;
  defenseItem: ItemObject | null;
  strikes: CombatStrike[];
  procPlayback: CombatProcMark[];
  activeProcCues: CombatProcCue[] = [];
  readonly participants: UnitObject[];

  state: MapCombatState;
  currentStrikeIndex: number;
  /** ms since the current state began (Python current_time). */
  /** Milliseconds since the combat started (Python engine.get_time()). */
  private clock = 0;
  /** `clock` when the current state began (Python last_update). */
  private stateStart = 0;
  /** START toggles Python's _skip: every timed wait passes immediately. */
  skipMode = false;
  private firstPhase = true;
  private castPose = false;
  /** Python MoveCameraState after begin_phase: wait for the camera pan. */
  private cameraHold = false;
  /**
   * The solver's InitState: Python's first begin_phase gets no actions or
   * playback from it and tries again next frame.
   */
  private solverInitStep = true;
  private hpBarTime = 0;
  /** Python's cursor tile for this phase (what combat_attacker faces). */
  private cursorTarget: [number, number] | null = null;
  private lungeUnit: UnitObject | null = null;
  private lungeNet: [number, number] = [0, 0];
  private lungeCount = 0;
  private lungeStarted = false;
  private lungeFresh = false;
  /** HP after each presented strike (the actions Python applies at 'anim'). */
  private presentedHps: Map<UnitObject, number>;
  /** Python health_bars: one MapCombatInfo per displayed unit. */
  private infos: Map<UnitObject, MapCombatInfo> = new Map();
  private mapAnimations: MapAnimation[] = [];

  // Snapshot of real HP before combat (for result calculation)
  private attackerStartHp: number;

  // Reference to DB for exp calculation
  private db: Database;
  private game: any;

  // Animation state for rendering
  attackerAnim: CombatAnimState;
  defenderAnim: CombatAnimState;
  defenderAnims: Map<UnitObject, CombatAnimState>;
  damagePopups: DamagePopup[];

  private defenderStartHps: Map<UnitObject, number>;

  // Audio (optional, set after construction to enable combat SFX)
  audioManager: { playSfx(name: string): void } | null = null;
  private cachedResults: CombatResults | null = null;
  private lifecycleRecord: CombatLifecycleRecord;
  private guardGaugeResults: Map<UnitObject, number> = new Map();
  /** Units saved from death by a 'miracle' skill (see CombatPhaseSolver.miracleSaved). */
  private miracleSavedSet: Set<UnitObject> = new Set();
  private miracleRestoreHps: Map<UnitObject, number> = new Map();

  /** Public read-only view of which units were saved from death this combat by 'miracle'. */
  get miracleSaved(): ReadonlySet<UnitObject> {
    return this.miracleSavedSet;
  }
  private unitAnims: Map<UnitObject, CombatAnimState> = new Map();

  /** map_cast_pose: attacker stands and casts instead of lunging. */
  readonly attackerCastPose: boolean;
  /** no_map_hp_display: suppress HP bar/drain display for this item use. */
  readonly noMapHpDisplay: boolean;
  /** map_cast_anim (Python CastAnim playback) of the initiating item. */
  castAnimValue: string | null = null;

  private solver: CombatPhaseSolver;
  /** Phases remain to be resolved (deferSolve). */
  private solving = false;
  private solveStarted = false;
  strikeEventHook: StrikeEventHook | null = null;
  pendingStrikeEvents: unknown[] | null = null;
  /** Each event phase's events, keyed by the phase's first strike index. */
  private phaseEvents: Map<number, unknown[]> = new Map();
  /** Participant HP when the pending strike events started. */
  private strikeEventBaseline: Map<UnitObject, number> | null = null;
  /** Result HP walk over strikes [0, walked) (see walkStrikes). */
  private walk: { atkHp: number; defenderHps: Map<UnitObject, number> } | null = null;
  private walked = 0;

  constructor(
    attacker: UnitObject,
    attackItem: ItemObject,
    defender: UnitObject,
    defenseItem: ItemObject | null,
    db: Database,
    rngMode: RngMode,
    board?: GameBoard | null,
    script?: string[] | null,
    group?: MapCombatGroup,
    randomGame?: RandomGameState | null,
    options: MapCombatOptions = {},
  ) {
    this.attacker = attacker;
    this.attackItem = attackItem;
    this.defender = defender;
    this.primaryDefender = group ? group.mainDefender : defender;
    this.splashDefenders = [...new Set(group?.splashDefenders ?? [])]
      .filter((unit) => unit !== this.primaryDefender);
    this.defenders = [...new Set([
      ...(this.primaryDefender ? [this.primaryDefender] : []),
      ...this.splashDefenders,
    ])];
    if (this.defenders.length === 0) this.defenders = [defender];
    this.defenseItem = this.primaryDefender ? defenseItem : null;
    this.db = db;
    const game = randomGame as any;
    this.game = game;
    const travelers = [attacker, ...this.defenders]
      .map((unit) => unit.traveler ? game?.getUnit?.(unit.traveler) ?? null : null)
      .filter((unit): unit is UnitObject => !!unit);
    this.participants = [...new Set([
      attacker,
      ...this.defenders,
      ...(attacker.strikePartner ? [attacker.strikePartner] : []),
      ...(this.primaryDefender?.strikePartner ? [this.primaryDefender.strikePartner] : []),
      ...travelers,
    ])];

    // Solve the combat to get the strike sequence. Proc/charge mutations and
    // the persistent combat RNG are captured before resolution for turnwheel.
    this.lifecycleRecord = new CombatLifecycleRecord(
      this.participants,
      randomGame ?? null,
    );
    const solver = new CombatPhaseSolver(
      randomGame ? () => getCombatRandom(randomGame) : undefined,
      randomGame,
    );
    this.solver = solver;
    solver.beginSession(
      attacker,
      attackItem,
      group ? this.primaryDefender : defender,
      group ? this.defenseItem : defenseItem,
      group
        ? group.splashStrikes?.filter((unit) => unit !== this.primaryDefender) ?? this.splashDefenders
        : [],
      db,
      rngMode,
      board,
      script,
    );
    this.strikes = [];
    // Live: lifecycle marks arrive as phases resolve.
    this.procPlayback = solver.procPlayback;
    this.solving = true;

    this.state = 'init';
    this.currentStrikeIndex = 0;

    this.attackerStartHp = attacker.currentHp;
    this.defenderStartHps = new Map(this.defenders.map((unit) => [unit, unit.currentHp]));
    this.presentedHps = new Map(this.participants.map((unit) => [unit, unit.currentHp]));
    if (!options.deferSolve) this.resolvePhases();

    // Animation state
    this.attackerAnim = freshAnimState();
    this.unitAnims.set(attacker, this.attackerAnim);
    this.defenderAnims = new Map(this.defenders.map((unit) => [unit, freshAnimState()]));
    this.defenderAnim = this.defenderAnims.get(defender) ?? freshAnimState();
    if (!this.defenderAnims.has(defender)) this.defenderAnims.set(defender, this.defenderAnim);
    for (const unit of this.participants) {
      if (!this.unitAnims.has(unit)) {
        this.unitAnims.set(unit, this.defenderAnims.get(unit) ?? freshAnimState());
      }
    }
    this.damagePopups = [];

    // map_cast_pose (Python `MapCastPose`): the caster stands in place and
    // plays its "cast" pose rather than lunging into melee. Approximated in
    // the web renderer by suppressing the lunge offset for that unit.
    this.attackerCastPose = attackItem.hasComponent('map_cast_pose');

    // no_map_hp_display (Python `NoMapHPDisplay`): suppress the target HP
    // bar/drain display for non-combat item uses (most staves/statuses).
    this.noMapHpDisplay = attackItem.hasComponent('no_map_hp_display');

    this.castAnimValue = attackItem.getComponent<string>('map_cast_anim') ?? null;
  }

  /** Instantly skip to the end of combat (no more animation). */
  skipToEnd(): void {
    if (this.solving || this.pendingStrikeEvents || this.phaseEvents.size > 0) {
      // Phases still to solve or events to run between strikes: Python's
      // skip only speeds the presentation up, so fast-forward through it.
      this.skipMode = true;
      return;
    }
    this.finishPresentation();
    this.state = 'done';
  }

  /**
   * Resolve phases until one has strike events (they run when the
   * presentation reaches it) or the combat has no more phases.
   */
  private resolvePhases(): void {
    if (!this.solving) return;
    if (!this.solveStarted) {
      this.solveStarted = true;
      // Start-combat events ran before the first phase: start from the HP
      // they left, as Python's solver and health bars do.
      this.attackerStartHp = this.attacker.currentHp;
      this.defenderStartHps = new Map(this.defenders.map((unit) => [unit, unit.currentHp]));
      this.presentedHps = new Map(this.participants.map((unit) => [unit, unit.currentHp]));
    }
    for (;;) {
      const first = this.strikes.length;
      const phase = this.solver.resolveNextPhase();
      if (!phase) {
        this.finishSolve();
        return;
      }
      this.strikes.push(...phase);
      for (const strike of phase) {
        for (const effect of [...(strike.allySkillHpChanges ?? []), ...(strike.redirectedDamage ?? [])]) {
          if (this.participants.includes(effect.unit)) continue;
          this.participants.push(effect.unit);
          if (!this.presentedHps.has(effect.unit)) this.presentedHps.set(effect.unit, effect.unit.currentHp);
        }
      }
      const events = this.strikeEventHook?.(phase) ?? [];
      if (events.length > 0) {
        this.phaseEvents.set(first, events);
        return;
      }
      // A hit that shoves/swaps: solve on only once the presentation has
      // shown it and the units have moved (handlePlayback).
      if (this.solver.hasPendingMovement) return;
    }
  }

  private finishSolve(): void {
    this.solving = false;
    this.guardGaugeResults = new Map(this.solver.guardGaugeResults);
    this.miracleSavedSet = new Set(this.solver.miracleSaved);
    this.miracleRestoreHps = new Map(this.solver.miracleRestoreHp);
    this.lifecycleRecord.finish();
  }

  /**
   * Python runs a phase's events after its begin_phase and before its hit:
   * apply the strikes shown so far, then hand the events to CombatState.
   */
  private startStrikeEvents(index: number, events: unknown[]): void {
    this.strikeEventBaseline = applyPresentedStrikeHp(this.game, this.participants, () => {
      this.walkStrikes(index);
      const walk = this.walk!;
      this.attacker.currentHp = Math.max(0, Math.min(this.attacker.maxHp, walk.atkHp));
      for (const [unit, hp] of walk.defenderHps) {
        unit.currentHp = Math.max(0, Math.min(unit.maxHp, hp));
      }
    });
    this.pendingStrikeEvents = events;
    this.setState('strike_events');
  }

  resumeAfterStrikeEvents(): void {
    if (!this.pendingStrikeEvents) return;
    const deltas = strikeEventHpDeltas(this.strikeEventBaseline ?? new Map());
    this.pendingStrikeEvents = null;
    this.strikeEventBaseline = null;
    if (deltas.size > 0) {
      this.solver.adjustSimulatedHp(deltas);
      const walk = this.walk!;
      for (const [unit, delta] of deltas) {
        if (unit === this.attacker) walk.atkHp += delta;
        if (walk.defenderHps.has(unit)) walk.defenderHps.set(unit, walk.defenderHps.get(unit)! + delta);
        this.presentedHps.set(unit, unit.currentHp);
        this.infos.get(unit)?.hpBar.setTarget(unit.currentHp);
      }
    }
    this.setState('proc_animations');
  }

  /**
   * Advance the combat by one frame (Python MapCombat.update).
   * Returns true when the combat is fully complete.
   */
  update(deltaMs: number): boolean {
    for (const cue of this.activeProcCues) cue.elapsed += deltaMs;
    this.activeProcCues = this.activeProcCues.filter((cue) => cue.elapsed < cue.duration);
    if (this.state === 'done') return true;
    this.clock += deltaMs;
    const skip = this.skipMode;

    switch (this.state) {
      case 'init':
        this.setState('init_pause');
        break;
      case 'init_pause':
        if (skip || this.over(200)) this.setState('begin_phase');
        break;
      case 'begin_phase':
        if (this.solverInitStep) {
          this.solverInitStep = false;
          break;
        }
        this.beginPhase();
        // Python begin_phase with no phase left calls clean_up and the
        // combat is over in that same update.
        if ((this.state as MapCombatState) === 'exp_wait') {
          this.endCombat();
          return true;
        }
        break;
      case 'strike_events':
        // CombatState runs pendingStrikeEvents, then resumeAfterStrikeEvents.
        break;
      case 'proc_animations':
        // Python red_cursor runs once MoveCameraState has popped. (A camera
        // nobody updates, as when a combat is played out directly, gives up
        // after a second.)
        if (this.cameraHold && !skip && this.game?.camera?.isAtTarget && !this.game.camera.isAtTarget() &&
            this.clock - this.stateStart < 1000) break;
        this.cameraHold = false;
        this.setState('start_anim');
        break;
      case 'start_anim':
        // EOtF's fork (lt-maker 5078af9f) waits 400 ms here; upstream 200.
        if (skip || this.over(isForkEngine() ? 400 : 200)) {
          this.playCastAnimations();
          this.setState('sound');
        }
        break;
      case 'sound':
        if (skip || this.over(250)) {
          const strike = this.currentStrike();
          if (strike && !this.castPose) this.startLunge(strike.attacker);
          const castSfx = strike?.item.getComponent<string>('map_cast_sfx');
          if (castSfx) this.audioManager?.playSfx(castSfx);
          this.setState('anim');
        }
        break;
      case 'anim':
        if (skip || this.over(83)) {
          this.handlePlayback();
          for (const info of this.infos.values()) info.update(0, true);
          this.hpBarTime = this.infos.size > 0
            ? Math.max(...[...this.infos.values()].map((info) => info.timeForChange))
            : 0;
          this.setState('hp_bar_wait');
        }
        break;
      case 'hp_bar_wait':
        if (skip || this.over(this.hpBarTime)) this.setState('end_phase_anim');
        break;
      case 'end_phase_anim':
        if (skip || (this.castPose && this.over(250)) || this.over(550)) {
          const strike = this.currentStrike();
          if (strike) this.faceCombatant(strike.attacker);
          if (isForkEngine() && !this.castPose) {
            // The fork's single end_phase (no map_cast_pose) goes straight
            // on to the next phase.
            this.currentStrikeIndex++;
            this.setState('begin_phase');
          } else {
            this.setState('end_phase');
          }
        }
        break;
      case 'end_phase':
        if (skip || !this.castPose || this.over(550)) {
          this.castPose = false;
          this.currentStrikeIndex++;
          this.setState('begin_phase');
        }
        break;
      case 'exp_wait':
      case 'post_combat':
        this.endCombat();
        return true;
    }

    if (this.state !== 'begin_phase' && this.state !== 'proc_animations') {
      for (const info of this.infos.values()) info.update(deltaMs, true);
    }
    this.advanceLunge();
    for (const anim of this.mapAnimations) anim.update();
    this.mapAnimations = this.mapAnimations.filter((anim) => !anim.done);
    return false;
  }

  /** Map combat presentation for the renderer. */
  getRenderState(): {
    state: MapCombatState;
    currentStrike: CombatStrike | null;
    attackerHp: number;
    defenderHp: number;
    attackerMaxHp: number;
    defenderMaxHp: number;
    attackerAnim: CombatAnimState;
    defenderAnim: CombatAnimState;
    defenders: { unit: UnitObject; hp: number; maxHp: number; anim: CombatAnimState }[];
    assistants: { unit: UnitObject; anim: CombatAnimState }[];
    damagePopups: DamagePopup[];
    /** no_map_hp_display: suppress HP bar rendering for this item use. */
    noMapHpDisplay: boolean;
    /** map_cast_pose: attacker plays its cast pose instead of lunging. */
    attackerCastPose: boolean;
    /** map_cast_anim: animation nid played on the target tile per strike. */
    castAnimValue: string | null;
    procCues: CombatProcCue[];
    /** Python health_bars: MapCombatInfo windows, in draw order. */
    infos: MapCombatInfo[];
    /** Hit/miss/cast map animations (MapAnimation) to draw over the map. */
    mapAnimations: MapAnimation[];
  } {
    const strike = this.currentStrike();
    const hpOf = (unit: UnitObject) => this.infos.get(unit)?.hpBar.displayedHp ?? this.presentedHps.get(unit) ?? unit.currentHp;
    return {
      state: this.state,
      currentStrike: strike,
      attackerHp: Math.max(0, hpOf(this.attacker)),
      defenderHp: Math.max(0, hpOf(this.defender)),
      attackerMaxHp: this.attacker.maxHp,
      defenderMaxHp: this.defender.maxHp,
      attackerAnim: this.attackerAnim,
      defenderAnim: this.defenderAnim,
      defenders: this.defenders.map((unit) => ({
        unit,
        hp: Math.max(0, hpOf(unit)),
        maxHp: unit.maxHp,
        anim: this.defenderAnims.get(unit) ?? this.defenderAnim,
      })),
      assistants: this.participants
        .filter((unit) => unit !== this.attacker && !this.defenders.includes(unit) && !!unit.position)
        .map((unit) => ({ unit, anim: this.unitAnims.get(unit)! })),
      damagePopups: this.damagePopups,
      noMapHpDisplay: this.noMapHpDisplay,
      attackerCastPose: this.attackerCastPose,
      castAnimValue: this.castAnimValue,
      procCues: this.activeProcCues,
      infos: [...this.infos.values()],
      mapAnimations: this.mapAnimations,
    };
  }

  /**
   * Apply final combat results to units (HP changes, death, exp, weapon uses).
   * Should be called once after the combat is done.
   *
   * Returns detailed results including stat gains from level-ups and
   * weapon breakage information.
   */
  applyResults(actionLog?: ActionLog): CombatResults {
    if (this.cachedResults) return this.cachedResults;
    if (actionLog) {
      const action = new CombatResultAction<CombatResults>(
        this.participants,
        [...new Set([
          this.attackItem,
          ...(this.defenseItem ? [this.defenseItem] : []),
          ...this.strikes.map((strike) => strike.item),
        ])],
        () => this.computeResults(),
        this.lifecycleRecord,
      );
      actionLog.doAction(action);
      this.cachedResults = action.getResult();
      return this.cachedResults;
    }
    this.cachedResults = this.computeResults();
    return this.cachedResults;
  }

  /**
   * Walk the result HP through strikes [walked, upTo). The walk persists so
   * HP applied before strike events (and the events' own HP changes, added
   * by resumeAfterStrikeEvents) carry into the final results.
   */
  private walkStrikes(upTo: number): void {
    const walk = this.walk ??= {
      atkHp: this.attackerStartHp,
      defenderHps: new Map(this.defenderStartHps),
    };
    let atkHp = walk.atkHp;
    const defenderHps = walk.defenderHps;
    // Python set_hp clamps to get_max_hp(), which includes stat bonuses.
    const attackerMaxHp = this.attacker.maxHp;

    for (; this.walked < upTo; this.walked++) {
      const strike = this.strikes[this.walked];
      if (!strike.hit && !hasDamageOnMiss(strike.item)) {
        // Skill lifelink / live_to_serve and item lifelink can heal on a
        // miss (EOtF: from the phase's earlier strikes).
        const missHeal = (strike.selfSkillHpChange ?? 0) + (strike.itemLifelinkHeal ?? 0);
        if (missHeal !== 0) {
          if (strike.attacker === this.attacker) {
            atkHp = Math.max(0, Math.min(attackerMaxHp, atkHp + missHeal));
          } else if (defenderHps.has(strike.attacker)) {
            defenderHps.set(strike.attacker, Math.max(0, Math.min(
              strike.attacker.maxHp,
              (defenderHps.get(strike.attacker) ?? strike.attacker.currentHp) + missHeal,
            )));
          }
        }
        continue;
      }
      let damage = strike.damage;
      if (strike.hit && (hasEclipseFe7(strike.item) || hasEclipse(strike.item))) {
        const targetHp = strike.defender === this.attacker
          ? atkHp
          : (defenderHps.get(strike.defender) ?? strike.defender.currentHp);
        damage = hasEclipseFe7(strike.item)
          ? eclipseFe7Damage(targetHp)
          : eclipseDamage(targetHp);
      }
      damage += strike.extraDamage ?? 0;
      if (strike.defender === this.attacker) {
        const itemHeal = lifelinkHealForStrike(
          strike.attacker,
          strike.attacker === this.attacker
            ? this.attackItem
            : (this.defenseItem ?? strike.item),
          strike,
          atkHp,
        );
        const selfChange = itemHeal + (strike.selfSkillHpChange ?? 0);
        // EOtF: an initiator striking itself (interact_unit's self-heal
        // abilities) has one HP; keep its own changes on it.
        const selfStrike = isForkEngine() && strike.attacker === this.attacker;
        if (selfStrike) {
          atkHp = Math.max(0, Math.min(attackerMaxHp, atkHp + selfChange));
        } else if (defenderHps.has(strike.attacker)) {
          defenderHps.set(
            strike.attacker,
            Math.max(0, Math.min(
              strike.attacker.maxHp,
              (defenderHps.get(strike.attacker) ?? strike.attacker.currentHp) +
                selfChange,
            )),
          );
        }
        atkHp = Math.min(
          this.attacker.maxHp,
          atkHp - damage + (strike.defenderSkillHpChange ?? 0),
        );
      } else if (defenderHps.has(strike.defender)) {
        const before = defenderHps.get(strike.defender) ?? strike.defender.currentHp;
        // Lifelink after_strike: heal per hitting attacker strike, clamping
        // the strike's damage to the defender's remaining HP so overkill
        // damage never heals. Mirrors Python `Lifelink.after_strike`.
        const itemHeal = lifelinkHealForStrike(
          strike.attacker,
          strike.attacker === this.attacker
            ? this.attackItem
            : (this.defenseItem ?? strike.item),
          strike,
          before,
        );
        const selfChange = itemHeal + (strike.selfSkillHpChange ?? 0);
        if (strike.attacker === this.attacker) {
          atkHp = Math.max(0, Math.min(attackerMaxHp, atkHp + selfChange));
        } else if (defenderHps.has(strike.attacker)) {
          defenderHps.set(
            strike.attacker,
            Math.max(0, Math.min(
              strike.attacker.maxHp,
              (defenderHps.get(strike.attacker) ?? strike.attacker.currentHp) +
                selfChange,
            )),
          );
        }
        defenderHps.set(
          strike.defender,
          Math.min(
            strike.defender.maxHp,
            before - damage + (strike.defenderSkillHpChange ?? 0),
          ),
        );
      }
      for (const effect of strike.allySkillHpChanges ?? []) {
        if (effect.unit === this.attacker) {
          atkHp = Math.max(0, Math.min(attackerMaxHp, atkHp + effect.amount));
        } else if (defenderHps.has(effect.unit)) {
          defenderHps.set(
            effect.unit,
            Math.max(0, Math.min(
              effect.unit.maxHp,
              (defenderHps.get(effect.unit) ?? effect.unit.currentHp) + effect.amount,
            )),
          );
        } else {
          effect.unit.currentHp = Math.max(
            0,
            Math.min(effect.unit.maxHp, effect.unit.currentHp + effect.amount),
          );
        }
      }
      for (const effect of strike.redirectedDamage ?? []) {
        if (effect.unit === this.attacker) {
          atkHp = Math.max(0, atkHp - effect.amount);
        } else if (defenderHps.has(effect.unit)) {
          defenderHps.set(
            effect.unit,
            Math.max(
              0,
              (defenderHps.get(effect.unit) ?? effect.unit.currentHp) -
                effect.amount,
            ),
          );
        } else {
          effect.unit.currentHp = Math.max(
            0,
            effect.unit.currentHp - effect.amount,
          );
          if (effect.unit.currentHp <= 0) effect.unit.dead = true;
        }
      }
      const collapsePermanentHp = (unit: UnitObject): void => {
        if (unit === this.attacker) {
          atkHp = applyPermanentDamage(
            unit,
            atkHp,
            this.game ?? { db: this.db },
          );
        } else if (defenderHps.has(unit)) {
          defenderHps.set(
            unit,
            applyPermanentDamage(
              unit,
              defenderHps.get(unit) ?? unit.currentHp,
              this.game ?? { db: this.db },
            ),
          );
        }
      };
      collapsePermanentHp(strike.attacker);
      collapsePermanentHp(strike.defender);
    }
    walk.atkHp = atkHp;
  }

  private computeResults(): CombatResults {
    // Walk the remaining strikes and apply HP changes to actual units.
    this.walkStrikes(this.strikes.length);
    let atkHp = this.walk!.atkHp;
    const defenderHps = this.walk!.defenderHps;

    // Miracle: a unit that would die at the end of combat is instead
    // resurrected at 1 HP (Python Miracle.cleanup_combat). The solver has
    // already determined eligibility (skill present + charge available) and
    // consumed the charge; here we just apply the floor to the actual HP.
    if (atkHp <= 0 && this.miracleSavedSet.has(this.attacker)) {
      atkHp = this.miracleRestoreHps.get(this.attacker) ?? 1;
    }
    for (const [unit, hp] of defenderHps) {
      if (hp <= 0 && this.miracleSavedSet.has(unit)) {
        defenderHps.set(unit, this.miracleRestoreHps.get(unit) ?? 1);
      }
    }

    // Clamp HP
    atkHp = Math.max(0, Math.min(this.attacker.maxHp, atkHp));

    // Apply to units
    this.attacker.currentHp = atkHp;
    for (const [unit, hp] of defenderHps) {
      // EOtF: the initiator's HP is atkHp even when it is also its target.
      if (isForkEngine() && unit === this.attacker) continue;
      unit.currentHp = Math.max(0, Math.min(unit.maxHp, hp));
    }
    for (const [unit, gauge] of this.guardGaugeResults) unit.currentGuardGauge = gauge;
    if (this.db.getConstant('pairup', false)) {
      this.attacker.builtGuard = true;
      if (this.primaryDefender) this.primaryDefender.builtGuard = true;
    }

    // Units at 0 HP are not dead yet: clean_up's game.death.should_die marks
    // them is_dying, their UnitDeath events run, and the Die action at the
    // end of the dying fade sets `dead` (Python simple_combat.clean_up).
    const attackerDead = atkHp <= 0;
    const defenderDeaths = this.defenders.filter((unit) => unit.currentHp <= 0);
    const deadDefenders = new Set(defenderDeaths);
    const defenderDead = deadDefenders.has(this.defender);

    // Decrement each combatant's own weapon. Attack-stance partners can use
    // a different item from their leader, so their uses and breakage must be
    // tracked independently.
    const consumeUses = (unit: UnitObject, item: ItemObject | null): boolean => {
      if (!item) return false;
      const uses = usesConsumedByStrikes(unit, item, this.strikes);
      let broke = false;
      if (uses > 0 && item.maxUses > 0) {
        for (let index = 0; index < uses && item.uses > 0; index++) {
          broke = item.decrementUses() || broke;
        }
        // EOtF's engine: chapter uses (c_uses) never break the item; at 0 it
        // is only unusable (unequipped) until the chapter ends.
        const chapterUsesOnly = isForkEngine() && item.hasComponent('c_uses') && !item.hasComponent('uses');
        if (broke && chapterUsesOnly) {
          // Unequipped later, after the end-of-combat hooks
          // (applyUnusableCombatItems, Python handle_unusable_items).
          broke = false;
        } else if (broke && !item.hasComponent('no_break_out_of_uses')) {
          const inventoryIndex = unit.items.indexOf(item);
          if (inventoryIndex !== -1) unit.items.splice(inventoryIndex, 1);
          if (unit.equippedWeapon === item || unit.equippedAccessory === item) unit.unequip(item);
          unit.autoequip();
        }
      }
      return broke;
    };
    const attackerPartner = this.attacker.strikePartner;
    const defenderPartner = this.primaryDefender?.strikePartner ?? null;
    const attackerPartnerItem = attackerPartner
      ? this.strikes.find((strike) => strike.attacker === attackerPartner && strike.assist)?.item ?? null
      : null;
    const defenderPartnerItem = defenderPartner
      ? this.strikes.find((strike) => strike.attacker === defenderPartner && strike.assist)?.item ?? null
      : null;
    const attackWeaponBroke = consumeUses(this.attacker, this.attackItem);
    const defenseWeaponBroke = this.primaryDefender
      ? consumeUses(this.primaryDefender, this.defenseItem)
      : false;
    if (attackerPartner) consumeUses(attackerPartner, attackerPartnerItem);
    if (defenderPartner) consumeUses(defenderPartner, defenderPartnerItem);

    const componentResults = applyGroupCombatComponents(
      this.attacker,
      this.attackItem,
      this.primaryDefender,
      this.defenseItem,
      this.strikes,
      attackerDead,
      deadDefenders,
      this.db,
      this.game,
    );
    if (attackerPartner && attackerPartnerItem) {
      grantPartnerCombatWexp(
        attackerPartner,
        attackerPartnerItem,
        this.primaryDefender,
        this.strikes,
        attackerPartner.isDead(),
        deadDefenders,
        this.db,
      );
    }
    if (defenderPartner && defenderPartnerItem) {
      grantPartnerCombatWexp(
        defenderPartner,
        defenderPartnerItem,
        this.attacker,
        this.strikes,
        defenderPartner.isDead(),
        new Set(attackerDead ? [this.attacker] : []),
        this.db,
      );
    }

    // Python simple_combat.calculate_exp is item_system.exp only: items with
    // no exp/level_exp component grant nothing. ExpState then clamps the
    // gain at the level cap and levels with the unit's growth method.
    const expShare = combatExpShare(
      this.attacker, componentResults.fixedExp ?? 0, attackerDead,
      this.primaryDefender, this.defenseItem,
      !!this.primaryDefender && deadDefenders.has(this.primaryDefender),
      this.strikes, this.db,
    );
    let expGained = expShare.amount;
    let levelUps: Record<string, number>[] = [];
    if (expShare.unit && expGained > 0) {
      ({ applied: expGained, levelUps } = applyExpGain(expShare.unit, expGained, undefined, this.game));
    }
    // handle_paired_exp only runs with the pairup constant; a plain rescue
    // traveler earns no guard-stance exp.
    const pairup = Boolean(this.db.getConstant('pairup', false));
    if (!pairup) {
      // No partner or guard-stance exp.
    } else if (attackerPartner && !attackerPartner.isDead() && attackerPartner.team === 'player') {
      this.grantPairedExp(
        attackerPartner,
        Math.floor(combatComponentExp(
          attackerPartner, attackerPartnerItem ?? attackerPartner.equippedWeapon,
          this.strikes, false, deadDefenders, this.db,
        ) / 2),
      );
    } else if (this.attacker.rescuing && this.attacker.rescuing.team === 'player') {
      this.grantGuardExp(this.attacker, this.attacker.rescuing);
    }
    if (!pairup) {
      // No partner or guard-stance exp.
    } else if (defenderPartner && defenderPartner.team === 'player') {
      this.grantPairedExp(
        defenderPartner,
        Math.floor(combatComponentExp(
          defenderPartner, defenderPartnerItem ?? defenderPartner.equippedWeapon,
          this.strikes, false, new Set(attackerDead ? [this.attacker] : []), this.db,
        ) / 2),
      );
    } else if (this.primaryDefender?.rescuing && this.primaryDefender.rescuing.team === 'player') {
      this.grantGuardExp(this.primaryDefender, this.primaryDefender.rescuing);
    }

    // Python (simple_combat.handle_item_gain): every droppable item on a killed
    // unit transfers to the killer, not just the first. Defender deaths transfer
    // to the attacker; if the attacker dies, its droppable items transfer to the
    // (primary) defender instead.
    const droppedItems: { unit: UnitObject; item: import('../objects/item').ItemObject }[] = [];
    if (!attackerDead) {
      for (const unit of defenderDeaths) {
        for (const item of unit.items.slice()) {
          if (item.droppable) droppedItems.push({ unit, item });
        }
      }
    } else if (this.primaryDefender) {
      for (const item of this.attacker.items.slice()) {
        if (item.droppable) droppedItems.push({ unit: this.attacker, item });
      }
    }
    const droppedItem = droppedItems[0]?.item ?? null;

    this.attacker.strikePartner = null;
    if (this.primaryDefender) this.primaryDefender.strikePartner = null;

    return {
      attackerDead,
      defenderDead,
      expGained,
      expUnit: expShare.unit,
      levelUps,
      attackWeaponBroke,
      defenseWeaponBroke,
      droppedItem,
      attackerWexpGained: componentResults.attackerWexpGained,
      attackerRankUp: componentResults.attackerRankUp,
      stolenItem: componentResults.stolenItem,
      defenderDeaths,
      droppedItems,
      deathPositions: new Map([this.attacker, ...this.defenders].map((unit) => [
        unit,
        unit.position ? [...unit.position] as [number, number] : null,
      ])),
    };
  }

  // ------------------------------------------------------------------
  // Presentation (Python MapCombat states)
  // ------------------------------------------------------------------

  /** clean_up1: survivors return to their normal map sprite; done. */
  private endCombat(): void {
    for (const unit of this.participants) {
      if (!this.isPresentedDying(unit)) setCombatPose(unit, null);
    }
    this.state = 'done';
  }

  private setState(state: MapCombatState): void {
    this.state = state;
    this.stateStart = this.clock;
  }

  /**
   * Python `engine.get_time() - last_update > ms` on its integer millisecond
   * clock: a whole number of frames that adds up to exactly `ms` is not
   * over it yet (24 frames are 400 ms, so a 400 ms wait takes 25), and an
   * 83 ms wait takes five or six frames depending on the clock's phase.
   */
  private over(ms: number): boolean {
    return Math.trunc(this.clock + 1e-6) - Math.trunc(this.stateStart + 1e-6) > ms;
  }

  /**
   * begin_phase's cursor.set_pos: the camera's set_xy keeps the cursor three
   * tiles inside the screen, and MoveCameraState holds the combat until the
   * camera rests. Returns whether it has to pan.
   */
  private moveCursorTo(target: [number, number]): boolean {
    const camera = this.game?.camera;
    if (!camera?.trackTile) return false;
    this.game.cursor?.setPos?.(target[0], target[1]);
    camera.trackTile(target[0], target[1]);
    return !camera.isAtTarget();
  }

  private currentStrike(): CombatStrike | null {
    return this.currentStrikeIndex < this.strikes.length ? this.strikes[this.currentStrikeIndex] : null;
  }

  /** Units whose presented HP reaches 0 and no miracle restores (is_dying). */
  private isPresentedDying(unit: UnitObject): boolean {
    return (this.presentedHps.get(unit) ?? 1) <= 0 && !this.miracleRestoreHps.has(unit);
  }

  /** begin_phase: next strike, or clean_up0 when the solver has no more. */
  private beginPhase(): void {
    if (!this.currentStrike()) this.resolvePhases();
    const strike = this.currentStrike();
    if (!strike) {
      // clean_up0: game.death.should_die for every unit at 0 HP.
      for (const unit of this.participants) {
        if (this.isPresentedDying(unit)) markDying(unit);
      }
      this.setState('exp_wait');
      return;
    }
    if (!this.noMapHpDisplay) this.buildInfos();
    if (this.firstPhase) {
      this.showFirstPhaseProcCues();
      this.firstPhase = false;
    }
    this.showStrikeProcCues(strike);

    // Sprites: combat_attacker faces the cursor (the target), the other side
    // faces back (combat_defender / combat_counter).
    const counter = strike.attacker !== this.attacker;
    const main = this.primaryDefender;
    this.cursorTarget = counter
      ? this.attacker.position
      : main?.position ?? strike.defender.position ?? null;
    this.cameraHold = !this.skipMode && !!this.cursorTarget && this.moveCursorTo(this.cursorTarget);
    this.faceCombatant(strike.attacker);
    if (counter) this.faceToward(this.attacker, strike.attacker);
    else if (main) this.faceToward(main, this.attacker);
    this.castPose = strike.item.hasComponent('map_cast_pose');
    const events = this.phaseEvents.get(this.currentStrikeIndex);
    if (events) {
      this.phaseEvents.delete(this.currentStrikeIndex);
      this.startStrikeEvents(this.currentStrikeIndex, events);
      return;
    }
    this.setState('proc_animations');
  }

  /** combat_attacker: face the cursor tile using the move frames. */
  private faceCombatant(unit: UnitObject): void {
    const target = this.cursorTarget;
    if (!unit.position || !target) return;
    setCombatPose(unit, facingFor(target[0] - unit.position[0], target[1] - unit.position[1]));
    if (this.lungeUnit === unit) this.lungeUnit = null;
  }

  private faceToward(unit: UnitObject, other: UnitObject): void {
    if (!unit.position || !other.position) return;
    setCombatPose(unit, facingFor(other.position[0] - unit.position[0], other.position[1] - unit.position[1]));
  }

  /** combat_anim: the attack_movement_counter lunge toward the cursor. */
  private startLunge(unit: UnitObject): void {
    const target = this.cursorTarget;
    if (!unit.position || !target) return;
    const dx = target[0] - unit.position[0];
    const dy = target[1] - unit.position[1];
    setCombatPose(unit, facingFor(dx, dy));
    this.lungeUnit = unit;
    this.lungeNet = [Math.sign(dx), Math.sign(dy)];
    this.lungeCount = 0;
    this.lungeStarted = true;
    // The sprite update for the frame that set combat_anim already ran.
    this.lungeFresh = true;
  }

  /**
   * UnitSprite.update_state('combat_anim') reads the shared movement counter
   * once for x and once for y, so it steps twice per frame.
   */
  private advanceLunge(): void {
    const unit = this.lungeUnit;
    if (!unit) return;
    if (this.lungeFresh) {
      this.lungeFresh = false;
      return;
    }
    const read = () => {
      if (this.lungeStarted) {
        this.lungeCount++;
        if (this.lungeCount >= ATTACK_MOVEMENT.length) {
          this.lungeCount = 0;
          this.lungeStarted = false;
        }
      }
      return ATTACK_MOVEMENT[this.lungeCount];
    };
    const x = this.lungeNet[0] * read();
    const y = this.lungeNet[1] * read();
    setCombatPoseOffset(unit, [x, y]);
  }

  /** Python _build_health_bars for the 1v1 / single-splash layouts. */
  private buildInfos(): void {
    const main = this.primaryDefender;
    if ((main && this.splashDefenders.length > 0) || this.splashDefenders.length > 1) {
      this.infos.clear();
      return;
    }
    const pairup = !!this.db.getConstant('pairup', false) && !this.db.getConstant('attack_stance_only', false);
    const guard = (unit: UnitObject) => (pairup ? unit.currentGuardGauge ?? 0 : null);
    const setInfo = (
      method: MapCombatInfoMethod,
      unit: UnitObject,
      item: ItemObject | null,
      target: UnitObject | null,
      stats: MapCombatStats,
    ) => {
      const existing = this.infos.get(unit);
      if (existing) existing.updateStats(stats);
      else {
        this.infos.set(unit, new MapCombatInfo(
          method, unit, item, target, stats,
          this.presentedHps.get(unit) ?? unit.currentHp,
          this.db, (u, t, i) => this.advantageSign(u, t, i),
        ));
      }
    };
    const attackStats = (target: UnitObject): MapCombatStats => [
      computeHit(this.attacker, this.attackItem, target, this.db, null, this.game, 'attack'),
      computeDamage(this.attacker, this.attackItem, target, this.db, null, this.game, 'attack'),
      computeCrit(this.attacker, this.attackItem, target, this.db, this.game, 'attack'),
      guard(this.attacker),
    ];
    if (main) {
      setInfo('p1', this.attacker, this.attackItem, main, attackStats(main));
      if (main !== this.attacker) {
        const canCounter = !!this.defenseItem &&
          canCounterattack(this.attacker, this.attackItem, main, this.db, this.game);
        const stats: MapCombatStats = canCounter && this.defenseItem
          ? [
            computeHit(main, this.defenseItem, this.attacker, this.db, null, this.game, 'defense'),
            computeDamage(main, this.defenseItem, this.attacker, this.db, null, this.game, 'defense'),
            computeCrit(main, this.defenseItem, this.attacker, this.db, this.game, 'defense'),
            guard(main),
          ]
          : [null, null, null, guard(main)];
        setInfo('p2', main, this.defenseItem, this.attacker, stats);
      }
    } else if (this.splashDefenders.length === 1) {
      const splash = this.splashDefenders[0];
      const stats = attackStats(splash);
      stats[3] = null;
      setInfo('p1', this.attacker, this.attackItem, splash, stats);
      setInfo('splash', splash, null, this.attacker, [null, null, null, null]);
    }
  }

  /** Sign of the weapon-triangle modification shown by the advantage arrow. */
  private advantageSign(unit: UnitObject, target: UnitObject, item: ItemObject): number {
    if (!checkEnemy(unit, target, this.db, this.game)) return 0;
    const targetItem = target === this.attacker ? this.attackItem : (target === this.primaryDefender ? this.defenseItem : null);
    const triangle = weaponTriangle(item, targetItem, this.db, unit, target);
    const sign = Math.sign(triangle.hitBonus || triangle.damageBonus);
    return sign;
  }

  /** start_anim: map_cast_anim on the cursor, map_target_cast_anim on targets. */
  private playCastAnimations(): void {
    const strike = this.currentStrike();
    if (!strike) return;
    const castAnim = strike.item.getComponent<string>('map_cast_anim');
    if (castAnim && this.cursorTarget) this.spawnMapAnimation(castAnim, this.cursorTarget);
    const targetCast = strike.item.getComponent<string>('map_target_cast_anim');
    if (targetCast && strike.defender.position) this.spawnMapAnimation(targetCast, strike.defender.position);
  }

  private spawnMapAnimation(nid: string, position: [number, number]): void {
    const prefab = this.db.mapAnimations?.get?.(nid);
    if (!prefab) return;
    const anim = new MapAnimation(prefab, position[0], position[1]);
    this.mapAnimations.push(anim);
    const resources = this.game?.resources;
    if (!resources?.loadImage) {
      anim.done = true;
      return;
    }
    void resources.loadImage(`resources/animations/${nid}.png`)
      .then((image: HTMLImageElement) => anim.setImage(image))
      .catch(() => { anim.done = true; });
  }

  private playSfx(name: string): void {
    this.audioManager?.playSfx(name);
  }

  /**
   * anim: Python _handle_playback + _apply_actions for this strike's default
   * item playback (solver/item_system_base on_hit/on_crit/on_miss).
   */
  private handlePlayback(): void {
    const strike = this.currentStrike();
    if (!strike) return;
    // _apply_actions: the phase's on-hit ForcedMovement/Swap lands with the hit.
    if (this.currentStrikeIndex === this.strikes.length - 1) this.solver.applyPendingMovement();
    const target = strike.defender;
    const anim = this.unitAnims.get(target) ?? (target === this.attacker ? this.attackerAnim : this.defenderAnim);
    const shakeAll = (num: number) => {
      const forced = (strike.attackProcs?.length ?? 0) > 0 ? 3 : num;
      for (const info of this.infos.values()) info.shake(forced);
    };
    const connected = strike.hit || hasDamageOnMiss(strike.item);
    if (!connected) {
      this.playSfx('Attack Miss 2');
      if (target.position) this.spawnMapAnimation('MapMiss', target.position);
      return;
    }

    const damage = strike.damage;
    const total = damage + (strike.extraDamage ?? 0);
    const before = this.presentedHps.get(target) ?? target.currentHp;
    const after = Math.max(0, Math.min(target.maxHp, before - total));
    this.presentedHps.set(target, after);
    this.infos.get(target)?.hpBar.setTarget(after);
    const lethal = after <= 0;

    if (damage < 0) {
      // Heal on_hit: HealHit + MapHeal sound + heal-size map animation,
      // only when it heals something (Python's true_heal > 0).
      if (after <= before) return;
      const heal = -damage;
      addDamageNumbers(target, heal, 'small_cyan');
      this.playSfx('MapHeal');
      const name = heal >= 30 ? 'MapBigHealTrans' : heal >= 15 ? 'MapMediumHealTrans' : 'MapSmallHealTrans';
      if (target.position) this.spawnMapAnimation(name, target.position);
      return;
    }

    // EOtF: the digits show the damage brush even when a survival hook
    // changed the HP the strike applies.
    const shownDamage = strike.shownDamage ?? damage;
    let hitSoundPlayed = false;
    const hitSound = (name: string) => {
      hitSoundPlayed = true;
      this.playSfx(name);
    };
    const configuredSfx = strike.item.getComponent<string>('map_hit_sfx');
    if (configuredSfx) hitSound(configuredSfx);
    const addBlend = strike.item.getComponent<[number, number, number]>('map_hit_add_blend');
    const subBlend = strike.item.getComponent<[number, number, number]>('map_hit_sub_blend');
    let itemTint = false;
    if (addBlend) {
      startFlicker(target, 0, 333, addBlend, 'add');
      anim.tintColor = addBlend;
      anim.tintMode = 'add';
      itemTint = true;
    } else if (subBlend) {
      startFlicker(target, 0, 333, subBlend, 'sub');
      anim.tintColor = subBlend;
      anim.tintMode = 'sub';
      itemTint = true;
    }

    if (strike.crit) {
      addDamageNumbers(target, shownDamage, 'small_yellow');
      if (shownDamage === 0) {
        hitSound('No Damage');
        if (target.position) this.spawnMapAnimation('MapNoDamage', target.position);
      }
      shakeAll(3);
      // crit_vibrate: in 10 frames, vibrate for 12 frames.
      startVibrate(target, 166, 200);
      if (!hitSoundPlayed) {
        if (lethal) this.playSfx('Final Hit');
        this.playSfx(`Critical Hit ${1 + Math.floor(Math.random() * 2)}`);
      }
      // crit_tint: a 2-frame flash, again 5 frames later, then a fading one.
      startFlicker(target, 0, 33, [255, 255, 255]);
      startFlicker(target, 83, 33, [255, 255, 255]);
      startFlicker(target, 166, 333, [255, 255, 255], 'add', true);
    } else {
      addDamageNumbers(target, shownDamage, 'small_red');
      if (strike.glancing) {
        if (target.position) {
          this.spawnMapAnimation(damage === 0 ? 'MapNoDamage' : 'MapGlancingHit', target.position);
        }
        if (lethal) {
          shakeAll(2);
          if (!hitSoundPlayed) hitSound('Final Hit');
        } else {
          shakeAll(4);
          if (!hitSoundPlayed) hitSound('No Damage');
        }
      } else {
        if (damage === 0) {
          hitSound('No Damage');
          if (target.position) this.spawnMapAnimation('MapNoDamage', target.position);
        }
        if (lethal) {
          shakeAll(2);
          if (!hitSoundPlayed) hitSound('Final Hit');
        } else {
          shakeAll(1);
          if (!hitSoundPlayed) hitSound(`Attack Hit ${1 + Math.floor(Math.random() * 5)}`);
        }
      }
      if (!itemTint) startFlicker(target, 0, 333, [255, 255, 255]);
    }
    // EOtF fork map_combat `extra_damage` brush: purple digits beside the hit.
    // EOtF draws one set per extra-damage instance, all at the same spot.
    const shownExtra = strike.shownExtraDamage ?? strike.extraDamage ?? 0;
    if (shownExtra > 0) {
      const instances = Math.max(1, strike.extraDamageInstances ?? 1);
      for (let index = 0; index < instances; index++) {
        addDamageNumbers(target, Math.trunc(shownExtra / instances), 'extra_purple');
      }
    }
  }

  /** Clear every combat pose/lunge (skip, or the end of the presentation). */
  private finishPresentation(): void {
    this.lungeUnit = null;
    for (const unit of this.participants) {
      if (this.isPresentedDying(unit)) markDying(unit);
      else setCombatPose(unit, null);
    }
  }

  private showFirstPhaseProcCues(): void {
    const preProcCues = this.procPlayback
      .filter((mark) =>
        (mark.kind === 'attack_pre_proc' || mark.kind === 'defense_pre_proc') &&
        isProcIconVisible(mark))
      .map(cueFromMark);
    this.activeProcCues.push(...dedupeProcCues([
      ...preProcCues,
      ...displaySkillCues(this.participants, this.game),
    ]));
  }

  private showStrikeProcCues(strike: CombatStrike): void {
    const marks = [...(strike.attackProcs ?? []), ...(strike.defenseProcs ?? [])];
    this.activeProcCues.push(...dedupeProcCues(
      marks.filter(isProcIconVisible).map(cueFromMark),
    ));
  }

  // ------------------------------------------------------------------
  // EXP (Python simple_combat.handle_paired_exp)
  // ------------------------------------------------------------------

  private grantPairedExp(unit: UnitObject, amount: number): void {
    if (amount <= 0) return;
    applyExpGain(unit, Math.max(0, Math.min(100, amount)), undefined, this.game);
  }

  private grantGuardExp(leader: UnitObject, follower: UnitObject): void {
    const guardedHits = this.strikes.filter((strike) => strike.guarded && strike.defender === leader).length;
    const minExp = Number(this.db.getConstant('min_exp', 0));
    const magnitude = Number(this.db.getConstant('exp_magnitude', 10));
    const amount = Math.max(minExp, Math.min(100, guardedHits * magnitude));
    this.grantPairedExp(follower, amount);
  }
}
