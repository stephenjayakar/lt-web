/**
 * harness.ts -- Deterministic test harness for the Lex Talionis web engine.
 *
 * When activated via ?harness=true, this module:
 *   - Replaces the requestAnimationFrame game loop with manual frame stepping
 *   - Exposes window.__harness with APIs for:
 *     - stepFrames(n, input?) -- advance N frames with optional input
 *     - screenshot() -- capture the current canvas as a PNG data URL
 *     - getState() -- snapshot of current game state (units, cursor, etc.)
 *     - injectInput(button) -- queue an input for the next frame
 *     - loadLevel(nid) -- load a specific level
 *     - waitForReady() -- wait until the game is fully loaded and stable
 *
 * Playwright tests drive the game through this API.
 */

import type { GameState } from './engine/game-state';
import type { Surface } from './engine/surface';
import type { InputEvent, GameButton } from './engine/input';
import { FRAMETIME, updateAnimationCounters } from './engine/constants';
import { ItemObject } from './objects/item';
import { EquipItemAction, RemoveItemFromUnitAction, TradeAction, WarpUnitAction, AddSkillAction, RemoveSkillAction } from './engine/action';
import { isItemSourcedSkill, computeTargetIcon } from './combat/item-system';
import { isAuraSourcedSkill } from './combat/aura-system';
import { SkillObject } from './objects/skill';
import { MapCombat } from './combat/map-combat';
import { applyDroppableItemPickups } from './combat/combat-lifecycle';
import * as saveSystem from './engine/save';

export interface HarnessAPI {
  /** Step the game forward by N frames. Optionally inject an input on the first frame. */
  stepFrames: (count: number, input?: GameButton | null) => void;
  /** Capture a screenshot as a PNG data URL. */
  screenshot: () => Promise<string>;
  /** Get a snapshot of current game state. */
  getState: () => HarnessState;
  /** Queue an input for the next stepFrames call. */
  injectInput: (button: GameButton) => void;
  /** Load a level by NID and transition to the free state. */
  loadLevel: (levelNid: string) => Promise<void>;
  /** Load a level, skip all level_start events, go directly to free state. */
  loadLevelClean: (levelNid: string) => Promise<void>;
  /** Wait until the game has finished loading and is ready. */
  waitForReady: () => Promise<boolean>;
  /** Whether the harness is ready (game loaded). */
  ready: boolean;
  /** Run N frames, allowing events/transitions to settle (auto-skips event text). */
  settle: (maxFrames: number) => void;
  /** Give an item (by DB NID) to a unit (by NID). Returns true if successful. */
  giveItem: (unitNid: string, itemNid: string) => boolean;
  /** Remove an item (by NID) from a unit's inventory via a reversible action. */
  removeItem: (unitNid: string, itemNid: string) => boolean;
  /** Trade an item between two units via a reversible TradeAction. */
  tradeItem: (fromNid: string, toNid: string, itemNid: string) => boolean;
  /** Kill a unit by NID (set HP to 0, mark dead). For testing win conditions. */
  killUnit: (unitNid: string) => boolean;
  /** Warp a unit to a new board position via a reversible WarpUnitAction (turnwheel-safe). */
  warpUnit: (unitNid: string, x: number, y: number) => boolean;
  /** Grant a skill (by DB NID) to a unit via a reversible AddSkillAction (turnwheel-safe). */
  addSkill: (unitNid: string, skillNid: string) => boolean;
  /** Remove a skill (by DB NID) from a unit via a reversible RemoveSkillAction (turnwheel-safe). */
  removeSkill: (unitNid: string, skillNid: string) => boolean;
  /** Trigger a game event by firing a trigger. Returns true if events were queued. */
  triggerEvent: (triggerType: string) => boolean;
  /** Get detailed unit state including equipped weapon/accessory and skills. */
  getUnitDetail: (unitNid: string) => UnitDetail | null;
  /** Force-equip an item on a unit via a reversible EquipItemAction (turnwheel-safe). */
  equipItem: (unitNid: string, itemNid: string) => boolean;
  /**
   * Override a DB constant for the current test (e.g. `rng_mode`,
   * `glancing_hit`). Writes directly to `game.db.constants` (the real Map
   * the engine reads via `Database.getConstant`), not a stand-in -- this is
   * the only supported way for a spec to reach into DB internals.
   */
  setConstant: (key: string, value: boolean | number | string) => void;
  /**
   * Directly resolve map combat between attacker and defender without UI.
   * Returns results. An optional CombatScript (hit1/crit1/miss1/hit2/crit2/
   * miss2/--/end tokens, per interact_unit) forces specific strike outcomes
   * for deterministic scripted-combat testing.
   *
   * `useDefenderWeapon` defaults to false for backward compatibility with
   * existing specs that assume the defender never counters; pass true to
   * resolve with the defender's actual equipped weapon so counterattacks,
   * vantage, and desperation behave like real map combat (Python always
   * lets the defender counter when able).
   */
  resolveCombat: (
    attackerNid: string,
    defenderNid: string,
    script?: string[],
    useDefenderWeapon?: boolean,
  ) => CombatResultSummary | null;
  /** Save current game state to a named slot and return the serialized snapshot. */
  saveSnapshot: () => unknown;
  /** Restore game state from a previously saved snapshot. */
  loadSnapshot: (snapshot: unknown) => Promise<boolean>;
  /** Undo the last action group via the turnwheel. */
  turnwheelUndo: () => boolean;
  /**
   * Directly resolve map combat and return aesthetic-presentation state
   * (tint blends, cast pose, HP-display suppression, recorded SFX) for
   * asserting cosmetic item components without driving the UI frame loop.
   */
  resolveCombatAesthetics: (attackerNid: string, defenderNid: string) => CombatAestheticsSummary | null;
  /** Pure evaluation of an item's target-icon warning marker against a target. */
  computeTargetIcon: (unitNid: string, itemNid: string, targetNid: string) => 'warning' | 'danger' | null;
  /**
   * Directly ask the real AIController what action a unit would take,
   * without stepping frames. Returns a simplified summary for assertions.
   */
  aiGetAction: (unitNid: string) => AiActionSummary | null;
  /** Overwrite a unit's identity fields (faction/party/aiGroup/team) for AI target_spec fixtures. */
  setUnitIdentity: (
    unitNid: string,
    fields: { faction?: string; party?: string; aiGroup?: string; team?: string },
  ) => boolean;
  /** Mark an AI group as active/inactive (mirrors Python's game.ai_group_active). */
  setAiGroupActive: (groupId: string, active: boolean) => void;
  /** Set the terrain NID at a board position (for Terrain target_spec fixtures). */
  setTerrain: (x: number, y: number, terrainNid: string) => void;
  /** Structural snapshot of the current tilemap: layer visibility/fade state, autotile frame, weather, camera. */
  getRenderState: () => RenderStateSummary | null;
  /** Show/hide a tilemap layer directly (bypassing the event system), for deterministic rendering tests. */
  setLayer: (nid: string, visible: boolean, transition?: 'fade' | 'immediate', nowMs?: number) => boolean;
  /** Force autotile animation + layer fade transitions to a specific elapsed time (ms), for deterministic frames. */
  forceTilemapTime: (ms: number) => void;
  /** Add a weather effect by NID (bypassing the event system). */
  addWeather: (nid: string) => void;
  /** Remove a weather effect by NID. */
  removeWeather: (nid: string) => void;
  /** Force the camera to an exact pixel position (bypassing easing), for deterministic screenshots. */
  forceCameraPosition: (x: number, y: number) => void;
  /** Set the camera's target position and let it ease toward it (does NOT snap). */
  setCameraTarget: (x: number, y: number) => void;
}

export interface RenderStateSummary {
  layers: Array<{ nid: string; visible: boolean; foreground: boolean; state: 'fade_in' | 'fade_out' | null; renderAlpha: number }>;
  autotileFrame: number;
  weatherNids: string[];
  camera: { x: number; y: number; targetX: number; targetY: number };
}

export interface AiActionSummary {
  type: string;
  targetUnitNid: string | null;
  targetPosition: [number, number] | null;
  movePathLength: number;
}

export interface CombatAestheticsSummary {
  noMapHpDisplay: boolean;
  attackerCastPose: boolean;
  castAnimValue: string | null;
  /** SFX names recorded by the stub audio manager during this resolution, in order. */
  playedSfx: string[];
  /** First recorded tint on the defender's animation state, if any. */
  defenderTint: { color: [number, number, number]; mode: 'add' | 'sub' } | null;
}

export interface HarnessState {
  currentStateName: string | undefined;
  stateStack: string[];
  turnCount: number;
  cursorPos: [number, number];
  units: Array<{
    nid: string;
    name: string;
    team: string;
    position: [number, number] | null;
    hp: number;
    maxHp: number;
    isDead: boolean;
  }>;
  levelNid: string | null;
}

export interface UnitDetail {
  nid: string;
  name: string;
  team: string;
  hp: number;
  maxHp: number;
  isDead: boolean;
  position: [number, number] | null;
  equippedWeaponNid: string | null;
  equippedAccessoryNid: string | null;
  itemNids: string[];
  skillNids: string[];
  /** Skill NIDs that were granted by an equipped item (status_on_equip). */
  itemSourcedSkillNids: string[];
  /** Skill NIDs that were granted by another unit's aura. */
  auraSourcedSkillNids: string[];
}

export interface CombatResultSummary {
  attackerHp: number;
  defenderHp: number;
  attackerDead: boolean;
  defenderDead: boolean;
  strikeCount: number;
  /** Damage dealt by each strike (in order). */
  strikeDamages: number[];
  /**
   * Per-strike detail (in order): who struck, whether it was a counter
   * (defender striking back), whether it hit, and dealt damage. Useful for
   * asserting exact Python-parity strike ordering (vantage/desperation/brave).
   */
  strikeDetails: Array<{ striker: 'attacker' | 'defender'; isCounter: boolean; hit: boolean; crit: boolean; damage: number }>;
  /** True if the attacker survived combat only via a 'miracle' skill cleanup. */
  attackerMiracleSaved: boolean;
  /** True if the defender survived combat only via a 'miracle' skill cleanup. */
  defenderMiracleSaved: boolean;
}

/**
 * Create and install the test harness on window.__harness.
 * Call this instead of starting the rAF game loop.
 */
export function installHarness(
  game: GameState,
  gameSurface: Surface,
  displayCanvas: HTMLCanvasElement,
  displayCtx: CanvasRenderingContext2D,
): void {
  let pendingInput: GameButton | null = null;
  let isReady = false;

  function stepOneFrame(input: InputEvent): void {
    game.frameDeltaMs = FRAMETIME;
    gameSurface.clear();

    let repeat = true;
    let iterations = 0;
    const maxIterations = 10;

    while (repeat && iterations < maxIterations) {
      const inputForThisIteration = iterations === 0 ? input : null;
      const [, shouldRepeat] = game.state.update(inputForThisIteration, gameSurface);
      repeat = shouldRepeat;
      iterations++;
    }

    updateAnimationCounters();
    game.movementSystem.update(FRAMETIME);

    // Blit to display canvas
    displayCtx.imageSmoothingEnabled = false;
    displayCtx.clearRect(0, 0, displayCanvas.width, displayCanvas.height);
    displayCtx.drawImage(gameSurface.canvas, 0, 0);
  }

  const harness: HarnessAPI = {
    ready: false,

    stepFrames(count: number, input?: GameButton | null): void {
      const firstInput = input ?? pendingInput;
      pendingInput = null;

      for (let i = 0; i < count; i++) {
        const frameInput = i === 0 ? firstInput : null;
        stepOneFrame(frameInput);
      }
    },

    async screenshot(): Promise<string> {
      return displayCanvas.toDataURL('image/png');
    },

    getState(): HarnessState {
      const current = game.state.getCurrentState();
      const units: HarnessState['units'] = [];
      for (const unit of game.units.values()) {
        units.push({
          nid: unit.nid,
          name: unit.name,
          team: unit.team,
          position: unit.position ? [unit.position[0], unit.position[1]] : null,
          hp: unit.currentHp,
          maxHp: unit.stats['HP'] ?? 0,
          isDead: unit.isDead(),
        });
      }

      // Access state stack via getCurrentState -- we need to peek at the full stack
      // The state machine doesn't expose the stack directly, so we get what we can
      const stateStack: string[] = [];
      if (current) {
        stateStack.push(current.name);
      }

      return {
        currentStateName: current?.name,
        stateStack,
        turnCount: game.turnCount,
        cursorPos: game.cursor.getPosition(),
        units,
        levelNid: game.currentLevel?.nid ?? null,
      };
    },

    injectInput(button: GameButton): void {
      pendingInput = button;
    },

    async loadLevel(levelNid: string): Promise<void> {
      await game.loadLevel(levelNid);
      game.state.clear();
      game.state.change('free');

      // Process deferred transitions. FreeState itself will push EventState
      // when level_start events are queued; avoid manually pushing 'event' here
      // to prevent duplicate stacked EventState instances.
      for (let i = 0; i < 3; i++) {
        stepOneFrame(null);
      }

      isReady = true;
      harness.ready = true;
    },

    async loadLevelClean(levelNid: string): Promise<void> {
      // Load level but DON'T trigger level_start events -- for pure map rendering tests
      await game.loadLevel(levelNid);
      // Clear any queued events from level_start by draining the queue
      if (game.eventManager) {
        while (game.eventManager.hasActiveEvents()) {
          game.eventManager.dequeueCurrentEvent();
        }
      }
      game.state.clear();
      game.state.change('free');

      // Step frames to process the state transition and render
      for (let i = 0; i < 3; i++) {
        stepOneFrame(null);
      }

      isReady = true;
      harness.ready = true;
    },

    async waitForReady(): Promise<boolean> {
      // Poll until ready (used by Playwright's waitForFunction)
      return isReady;
    },

    giveItem(unitNid: string, itemNid: string): boolean {
      const itemPrefab = game.db.items.get(itemNid);
      if (!itemPrefab) {
        console.warn(`[Harness] Item "${itemNid}" not found in DB`);
        return false;
      }
      const unit = game.units.get(unitNid);
      if (!unit) {
        console.warn(`[Harness] Unit "${unitNid}" not found`);
        return false;
      }
      const item = new ItemObject(itemPrefab);
      item.owner = unit;
      unit.items.unshift(item); // put at front so it's auto-equipped
      unit.onAddItem(item);
      unit.autoequip();
      game.items.set(`${unit.nid}_${item.nid}_${unit.items.length}`, item);
      return true;
    },

    removeItem(unitNid: string, itemNid: string): boolean {
      const unit = game.units.get(unitNid);
      if (!unit) return false;
      const item = unit.items.find((i) => i.nid === itemNid);
      if (!item) return false;
      game.actionLog.doAction(new RemoveItemFromUnitAction(unit, item));
      return true;
    },

    tradeItem(fromNid: string, toNid: string, itemNid: string): boolean {
      const from = game.units.get(fromNid);
      const to = game.units.get(toNid);
      if (!from || !to) return false;
      const indexA = from.items.findIndex((i) => i.nid === itemNid);
      if (indexA < 0) return false;
      const indexB = to.items.length; // append at end
      game.actionLog.doAction(new TradeAction(from, indexA, to, indexB));
      return true;
    },

    settle(maxFrames: number): void {
      for (let i = 0; i < maxFrames; i++) {
        stepOneFrame(null);
        const current = game.state.getCurrentState();
        // If we're in the 'free' state, we've settled
        if (current?.name === 'free') {
          break;
        }
        // Press SELECT to advance through dialog, menus, events, base screens, etc.
        if (current?.name === 'event' || current?.name === 'base_main' ||
            current?.name === 'base_convos' || current?.name === 'title' ||
            current?.name === 'title_main' || current?.name === 'phase_change' ||
            current?.name === 'turn_change') {
          stepOneFrame('SELECT');
        }
      }
    },

    killUnit(unitNid: string): boolean {
      const unit = game.units.get(unitNid);
      if (!unit) {
        console.warn(`[Harness] Unit "${unitNid}" not found`);
        return false;
      }
      unit.currentHp = 0;
      unit.dead = true;
      // Remove from board if present
      if (unit.position && game.board) {
        game.board.removeUnit(unit);
      }
      return true;
    },

    warpUnit(unitNid: string, x: number, y: number): boolean {
      const unit = game.units.get(unitNid);
      if (!unit || !unit.position || !game.board) return false;
      if (!game.board.inBounds(x, y)) return false;
      game.actionLog.doAction(new WarpUnitAction(unit, [x, y], game.board));
      return true;
    },

    addSkill(unitNid: string, skillNid: string): boolean {
      const unit = game.units.get(unitNid);
      if (!unit) return false;
      const prefab = game.db?.skills?.get?.(skillNid);
      if (!prefab) return false;
      game.actionLog.doAction(new AddSkillAction(unit, new SkillObject(prefab)));
      game.refreshAuras?.();
      return true;
    },

    removeSkill(unitNid: string, skillNid: string): boolean {
      const unit = game.units.get(unitNid);
      if (!unit) return false;
      const skill = unit.skills.find((s) => s.nid === skillNid);
      if (!skill) return false;
      game.actionLog.doAction(new RemoveSkillAction(unit, skill));
      game.refreshAuras?.();
      return true;
    },

    triggerEvent(triggerType: string): boolean {
      if (!game.eventManager) return false;
      const levelNid = game.currentLevel?.nid ?? '';
      return game.eventManager.trigger(
        { type: triggerType, levelNid },
        { game, gameVars: game.gameVars, levelVars: game.levelVars },
      );
    },

    getUnitDetail(unitNid: string): UnitDetail | null {
      const unit = game.units.get(unitNid);
      if (!unit) return null;
      const itemSourcedSkillNids = unit.skills
        .filter((s) => isItemSourcedSkill(s))
        .map((s) => s.nid);
      const auraSourcedSkillNids = unit.skills
        .filter((s) => isAuraSourcedSkill(s))
        .map((s) => s.nid);
      return {
        nid: unit.nid,
        name: unit.name,
        team: unit.team,
        hp: unit.currentHp,
        maxHp: unit.stats['HP'] ?? 0,
        isDead: unit.isDead(),
        position: unit.position ? [unit.position[0], unit.position[1]] : null,
        equippedWeaponNid: unit.equippedWeapon?.nid ?? null,
        equippedAccessoryNid: unit.equippedAccessory?.nid ?? null,
        itemNids: unit.items.map((i) => i.nid),
        skillNids: unit.skills.map((s) => s.nid),
        itemSourcedSkillNids,
        auraSourcedSkillNids,
      };
    },

    equipItem(unitNid: string, itemNid: string): boolean {
      const unit = game.units.get(unitNid);
      if (!unit) return false;
      const item = unit.items.find((i) => i.nid === itemNid);
      if (!item) return false;
      if (!unit.canEquip(item)) return false;
      game.actionLog.doAction(new EquipItemAction(unit, item));
      return true;
    },

    setConstant(key: string, value: boolean | number | string): void {
      game.db.constants.set(key, value);
    },

    resolveCombat(
      attackerNid: string,
      defenderNid: string,
      script?: string[],
      useDefenderWeapon?: boolean,
    ): CombatResultSummary | null {
      const attacker = game.units.get(attackerNid);
      const defender = game.units.get(defenderNid);
      if (!attacker || !defender || !attacker.position || !defender.position) return null;
      const weapon = attacker.equippedWeapon;
      if (!weapon) return null;
      const defenseItem = useDefenderWeapon ? (defender.equippedWeapon ?? null) : null;
      const rngMode = (game.db.getConstant('rng_mode', 'true_hit') as string) as any;
      const mc = new MapCombat(
        attacker, weapon, defender, defenseItem,
        game.db, rngMode, game.board, script ?? null, undefined, game,
      );
      const results = mc.applyResults(game.actionLog);
      applyDroppableItemPickups(game.actionLog, game.db, results, attacker, defender);
      return {
        attackerHp: attacker.currentHp,
        defenderHp: defender.currentHp,
        attackerDead: results.attackerDead,
        defenderDead: results.defenderDead,
        strikeCount: mc.strikes.length,
        strikeDamages: mc.strikes.map((s) => (s.hit ? s.damage : 0)),
        strikeDetails: mc.strikes.map((s) => ({
          striker: s.attacker === attacker ? 'attacker' : 'defender',
          isCounter: s.isCounter,
          hit: s.hit,
          crit: s.crit,
          damage: s.hit ? s.damage : 0,
        })),
        attackerMiracleSaved: mc.miracleSaved.has(attacker),
        defenderMiracleSaved: mc.miracleSaved.has(defender),
      };
    },

    saveSnapshot(): unknown {
      return saveSystem.buildSaveDict(game);
    },

    async loadSnapshot(snapshot: unknown): Promise<boolean> {
      try {
        await saveSystem.restoreGameState(game, snapshot as any);
        return true;
      } catch (err) {
        console.warn('[Harness] loadSnapshot failed:', err);
        return false;
      }
    },

    resolveCombatAesthetics(attackerNid: string, defenderNid: string): CombatAestheticsSummary | null {
      const attacker = game.units.get(attackerNid);
      const defender = game.units.get(defenderNid);
      if (!attacker || !defender || !attacker.position || !defender.position) return null;
      const weapon = attacker.equippedWeapon;
      if (!weapon) return null;
      const rngMode = (game.db.getConstant('rng_mode', 'true_hit') as string) as any;
      const mc = new MapCombat(
        attacker, weapon, defender, null,
        game.db, rngMode, game.board, null, undefined, game,
      );
      const playedSfx: string[] = [];
      mc.audioManager = { playSfx: (name: string) => playedSfx.push(name) };
      let defenderTint: CombatAestheticsSummary['defenderTint'] = null;
      let guard = 0;
      while (mc.state !== 'done' && guard < 2000) {
        mc.update(16);
        guard++;
        if (!defenderTint) {
          const anim = mc.getRenderState().defenders.find((d) => d.unit === defender)?.anim;
          if (anim?.tintColor && anim.tintMode) {
            defenderTint = { color: anim.tintColor, mode: anim.tintMode };
          }
        }
      }
      mc.applyResults();
      return {
        noMapHpDisplay: mc.noMapHpDisplay,
        attackerCastPose: mc.attackerCastPose,
        castAnimValue: mc.castAnimValue,
        playedSfx,
        defenderTint,
      };
    },

    computeTargetIcon(unitNid: string, itemNid: string, targetNid: string): 'warning' | 'danger' | null {
      const unit = game.units.get(unitNid);
      const target = game.units.get(targetNid);
      if (!unit || !target) return null;
      const item = unit.items.find((i) => i.nid === itemNid);
      if (!item) return null;
      return computeTargetIcon(unit, item, target, game.db, game);
    },

    aiGetAction(unitNid: string): AiActionSummary | null {
      const unit = game.units.get(unitNid);
      if (!unit || !game.aiController) return null;
      const action = game.aiController.getAction(unit);
      return {
        type: action.type,
        targetUnitNid: action.targetUnit?.nid ?? null,
        targetPosition: action.targetPosition ?? null,
        movePathLength: action.movePath?.length ?? 0,
      };
    },

    setUnitIdentity(
      unitNid: string,
      fields: { faction?: string; party?: string; aiGroup?: string; team?: string },
    ): boolean {
      const unit = game.units.get(unitNid);
      if (!unit) return false;
      if (fields.faction !== undefined) unit.faction = fields.faction;
      if (fields.party !== undefined) unit.party = fields.party;
      if (fields.aiGroup !== undefined) unit.aiGroup = fields.aiGroup;
      if (fields.team !== undefined) unit.team = fields.team;
      return true;
    },

    setAiGroupActive(groupId: string, active: boolean): void {
      if (!groupId) return;
      if (active) {
        game.activateAiGroup(groupId);
      } else {
        game.activeAiGroups.delete(groupId);
      }
    },

    setTerrain(x: number, y: number, terrainNid: string): void {
      game.board?.setTerrain(x, y, terrainNid);
    },

    getRenderState(): RenderStateSummary | null {
      if (!game.tilemap) return null;
      const layers = game.tilemap.layers.map((l) => ({
        nid: l.nid,
        visible: l.visible,
        foreground: l.foreground,
        state: l.state,
        renderAlpha: l.renderAlpha,
      }));
      const autotileFrame = game.tilemap.getAutotileFrameIndex();
      const weatherNids = game.tilemap.weather.map((w) => w.nid);
      const [cx, cy] = game.camera.getPosition();
      const [tx, ty] = game.camera.getTarget();
      return { layers, autotileFrame, weatherNids, camera: { x: cx, y: cy, targetX: tx, targetY: ty } };
    },

    setLayer(nid: string, visible: boolean, transition?: 'fade' | 'immediate', nowMs?: number): boolean {
      if (!game.tilemap) return false;
      const t = nowMs ?? Date.now();
      if (visible) {
        game.tilemap.showLayer(nid, transition ?? 'fade', t);
      } else {
        game.tilemap.hideLayer(nid, transition ?? 'fade', t);
      }
      return true;
    },

    forceTilemapTime(ms: number): void {
      game.tilemap?.updateAutotiles(ms);
    },

    addWeather(nid: string): void {
      game.tilemap?.addWeather(nid);
    },

    removeWeather(nid: string): void {
      game.tilemap?.removeWeather(nid);
    },

    forceCameraPosition(x: number, y: number): void {
      game.camera.forcePosition(x, y);
    },

    setCameraTarget(x: number, y: number): void {
      game.camera.setTarget(x, y);
    },

    turnwheelUndo(): boolean {
      const log = game.actionLog;
      if (!log || typeof log.undo !== 'function') return false;
      try {
        const action = log.undo();
        return action !== null;
      } catch (err) {
        console.warn('[Harness] turnwheelUndo failed:', err);
        return false;
      }
    },
  };

  // Expose on window for Playwright access
  (window as any).__harness = harness;
}
