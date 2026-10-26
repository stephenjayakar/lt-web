import type { UnitObject } from '../objects/unit';
import type { ItemObject } from '../objects/item';
import type { CombatStrike } from './combat-solver';
import { CombatPhaseSolver, type RngMode } from './combat-solver';
import type { CombatResults } from './map-combat';
import {
  BattleAnimation,
  drawCanvas,
  fillScreen,
  setBattleAnimSpeed,
  type BattleAnimDrawData,
  type BattleAnimOwner,
} from './battle-animation';
import type { CombatEffectData, PaletteData } from './battle-anim-types';
import { loadEffectSpritesheet } from '../data/loaders/combat-anim-loader';
import { convertSpritesheetToFrames } from './sprite-loader';
import { computeHit, computeDamage, computeCrit, canCounterattack, isMagic, weaponTriangle } from './combat-calcs';
import {
  hasDamageOnMiss,
  eclipseDamage,
  eclipseFe7Damage,
  hasEclipse,
  hasEclipseFe7,
  lifelinkHealForStrike,
  usesConsumedByStrikes,
} from './item-system';
import type { ActionLog } from '../engine/action';
import { CombatResultAction } from './combat-result-action';
import { applyCombatComponents, combatExpShare } from './combat-components';
import { applyPermanentDamage, checkEnemy, unitHasTag } from './skill-system';
import {
  CombatLifecycleRecord,
  type CombatProcMark,
} from './combat-skill-lifecycle';
import {
  cueFromMark,
  dedupeProcCues,
  displaySkillCues,
  isProcIconVisible,
  PROC_CUE_DURATION_MS,
  type CombatProcCue,
} from './proc-presentation';
import { applyExpGain } from '../engine/leveling';
import { getCombatRandom, type RandomGameState } from '../engine/static-random';
import { Surface } from '../engine/surface';
import { WINWIDTH, WINHEIGHT, TILEWIDTH, TILEHEIGHT, TILEX, TILEY, FRAMETIME, getFrameCount } from '../engine/constants';
import { FONT } from '../rendering/bmp-font';
import { drawItemIcon } from '../ui/icons';
import { getCombatSprite } from './combat-sprites';
import { ScreenAnimation } from './screen-animation';
import { fxNow } from './map-unit-fx';
import {
  applyPresentedStrikeHp,
  strikeEventHpDeltas,
  type StrikeEventCombat,
  type StrikeEventHook,
} from './strike-events';

// ============================================================
// AnimationCombat - port of lt-maker/app/engine/combat/animation_combat.py
// (with the MockCombat helpers it inherits): the full-screen battle scene.
// ============================================================

type Color = [number, number, number];

/** MockCombat._shake sets. */
const SHAKE_SETS: Record<number, [number, number][]> = {
  1: [[3, 3], [0, 0], [0, 0], [-3, -3], [0, 0], [0, 0], [3, 3], [0, 0], [-3, -3], [0, 0],
    [3, 3], [0, 0], [-3, -3], [3, 3], [0, 0]],
  2: [[1, 1], [1, 1], [1, 1], [-1, -1], [-1, -1], [-1, -1], [0, 0]],
  3: [[0, 0], [-3, -3], [0, 0], [0, 0], [0, 0], [3, 3], [0, 0], [0, 0], [-3, -3], [0, 0],
    [0, 0], [3, 3], [0, 0], [-3, -3], [0, 0], [3, 3], [0, 0], [-3, -3], [3, 3], [3, 3],
    [0, 0]],
  4: [[-6, -6], [0, 0], [0, 0], [0, 0], [6, 6], [0, 0], [0, 0], [-6, -6], [0, 0], [0, 0],
    [6, 6], [0, 0], [-6, -6], [0, 0], [6, 6], [0, 0], [4, 4], [0, 0], [-4, -4], [0, 0],
    [4, 4], [0, 0], [-4, -4], [0, 0], [4, 4], [0, 0], [-2, -2], [0, 0], [2, 2], [0, 0],
    [-2, -2], [0, 0], [2, 2], [0, 0], [-1, -1], [0, 0], [1, 1], [0, 0]],
};

const PLATFORM_SHAKE: [number, number][] = [[0, 1], [0, 0], [0, -1], [0, 0], [0, 1], [0, 0], [-1, -1], [0, 1], [0, 0]];

const VIEWBOX_TIME = 250;
const ENTRANCE_FRAMES = 14;
const UI_SLIDE_MS = 10 * FRAMETIME;
const UI_SLIDE_SKIP_MS = 2.5 * FRAMETIME;
const SPRITE_LOAD_WAIT_MS = 1500;
/** health_bar.CombatHealthBar */
const HP_BAR_COLORS = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 5, 5, 5, 5, 5, 5, 4, 4, 3, 3, 2, 2, 1, 1];
const MAX_HP_PER_BAR = 40;

interface PanConfig {
  max: number;
  speed: number;
}

/** MockCombat.setup_pan, keyed by at_range (distance - 1). */
function getPanConfig(atRange: number): PanConfig {
  if (atRange === 1) return { max: 16, speed: 4 };
  if (atRange === 2) return { max: 32, speed: 8 };
  if (atRange >= 3) return { max: 120, speed: 25 };
  return { max: 0, speed: 0 };
}

export type { BattleAnimDrawData } from './battle-animation';
export { BattleAnimation } from './battle-animation';

/** CombatHealthBar: displayed HP drains 2 frames per point (4 when healing). */
class CombatHpBar {
  displayed: number;
  private old: number;
  private target: number;
  private transition = false;
  private timeForChange = 0;
  private elapsed = 0;

  constructor(hp: number) {
    this.displayed = hp;
    this.old = hp;
    this.target = hp;
  }

  setTarget(hp: number): void {
    this.target = hp;
  }

  get bigNumber(): boolean {
    return this.displayed !== this.target;
  }

  done(): boolean {
    return this.displayed === this.target;
  }

  update(deltaMs: number): void {
    const speed = this.displayed < this.target ? 4 * FRAMETIME : 2 * FRAMETIME;
    if (this.displayed !== this.target && !this.transition) {
      this.transition = true;
      this.timeForChange = Math.max(0, Math.abs(this.displayed - this.target) * speed);
      this.elapsed = 0;
    }
    if (!this.transition) return;
    this.elapsed += deltaMs;
    const time = this.timeForChange > 0 ? this.elapsed / this.timeForChange : 1;
    this.displayed = Math.trunc(this.old + (this.target - this.old) * Math.min(1, time));
    if (time >= 1) {
      this.displayed = this.target;
      this.old = this.displayed;
      this.transition = false;
    }
  }
}

// -- Render state interface (diagnostics/tests) -----------------------------

export interface AnimationCombatRenderState {
  state: string;
  /** Viewbox hole (x, y, w, h) in screen pixels, or null when unused. */
  viewbox: { x: number; y: number; width: number; height: number } | null;
  leftDraw: BattleAnimDrawData;
  rightDraw: BattleAnimDrawData;
  screenShake: [number, number];
  leftHp: { current: number; max: number; name: string; weapon: string; hit: number | null; damage: number | null; crit: number | null };
  rightHp: { current: number; max: number; name: string; weapon: string; hit: number | null; damage: number | null; crit: number | null };
  panOffset: number;
  isAtRange: boolean;
  nameOffset: number;
  barOffset: number;
  platformOffset: number;
  procCue: CombatProcCue | null;
}

type AnimCombatState =
  | 'init' | 'red_cursor' | 'fade_in' | 'entrance' | 'init_pause'
  | 'transform'
  | 'pre_proc' | 'begin_phase' | 'strike_events' | 'attack_proc' | 'defense_proc'
  | 'anim' | 'combat_hit' | 'hp_change' | 'end_phase'
  | 'end_combat' | 'exp_pause' | 'exp_wait' | 'revert'
  | 'fade_out_wait' | 'name_tags_out' | 'all_out' | 'fade_out' | 'done';

export interface TransformBattleAnimations {
  attackerTransform?: BattleAnimation | null;
  attackerRevert?: BattleAnimation | null;
  defenderTransform?: BattleAnimation | null;
  defenderRevert?: BattleAnimation | null;
}

interface BigDamageNumber {
  digit: number;
  idx: number;
  length: number;
  left: boolean;
  sheet: string;
  start: number;
}

// ============================================================
// AnimationCombat
// ============================================================

export class AnimationCombat implements BattleAnimOwner, StrikeEventCombat {
  attacker: UnitObject;
  defender: UnitObject;
  attackItem: ItemObject;
  defenseItem: ItemObject | null;
  db: any;
  leftAnim: BattleAnimation;
  rightAnim: BattleAnimation;
  leftIsAttacker: boolean;
  private mainLeftAnim: BattleAnimation;
  private mainRightAnim: BattleAnimation;
  private leftTransformAnim: BattleAnimation | null;
  private rightTransformAnim: BattleAnimation | null;
  private leftRevertAnim: BattleAnimation | null;
  private rightRevertAnim: BattleAnimation | null;

  // -- Solver / strikes ------------------------------------------------------
  strikes: CombatStrike[];
  procPlayback: CombatProcMark[];
  activeProcCue: CombatProcCue | null = null;
  private pendingProcCues: CombatProcCue[] = [];
  currentStrikeIndex: number = 0;
  /**
   * HUD stats (max HP, hit, damage, crit) snapshot. Python computes these in
   * AnimationCombat._set_stats at fixed points rather than every frame; each
   * evaluation walks every skill condition, so recomputing per frame cost
   * tens of milliseconds. Recomputed whenever the combat phase, strike, HP or
   * item uses change, which is when the inputs can change.
   */
  private hudStatsKey: string | null = null;
  private hudStats: {
    leftMax: number; rightMax: number;
    leftHit: number | null; leftDamage: number | null; leftCrit: number | null;
    rightHit: number | null; rightDamage: number | null; rightCrit: number | null;
  } | null = null;

  // -- State machine ---------------------------------------------------------
  state: AnimCombatState = 'init';
  /** ms since the current state began (Python current_time). */
  stateTimer: number = 0;
  stateFrameCount: number = 0;
  /** Set by CombatState once the exp screen it shows over the scene ends. */
  expDone: boolean = false;

  // -- HP tracking -----------------------------------------------------------
  /** HP after the strikes shown so far (the actions Python applies). */
  leftTargetHp: number = 0;
  rightTargetHp: number = 0;
  private leftHpBar: CombatHpBar;
  private rightHpBar: CombatHpBar;
  attackerStartHp: number = 0;
  defenderStartHp: number = 0;

  // -- Shake -----------------------------------------------------------------
  private shakeSet: [number, number][] = [[0, 0]];
  private shakeOffset: [number, number] = [0, 0];
  private currentShake = 0;
  private platformShakeSet: [number, number][] = [[0, 0]];
  private platformShakeOffset: [number, number] = [0, 0];
  private platformCurrentShake = 0;

  // -- Pan -------------------------------------------------------------------
  panOffset: number = 0;
  panDir: number = 0;
  panConfig: PanConfig = { max: 0, speed: 0 };
  focusRight: boolean = false;

  // -- Darken / foreground -----------------------------------------------------
  private darkenBackground = 0;
  private targetDark = 0;
  private darkenUiBackground = 0;
  private foregroundColor: Color | null = null;
  private foregroundFrames = 0;
  private foregroundFadeOut = false;
  private foregroundFadeFrames = 0;

  // -- UI slide offsets (0 hidden .. 1 shown) ---------------------------------
  barOffset: number = 0;
  nameOffset: number = 0;
  platformOffset: number = 0;

  // -- Viewbox ---------------------------------------------------------------
  viewPos: [number, number] = [0, 0];
  cameraX: number = 0;
  cameraY: number = 0;
  viewbox: [number, number, number, number] | null = null;

  // -- Effects ---------------------------------------------------------------
  private animations: ScreenAnimation[] = [];
  private damageNumbers: BigDamageNumber[] = [];
  /** The anim whose strike is playing (Python current_battle_anim). */
  currentBattleAnim: BattleAnimation | null = null;
  private strikeApplied = false;
  private strikeHasHpBrush = false;

  cachedResults: CombatResults | null = null;
  private lifecycleRecord: CombatLifecycleRecord;
  private guardGaugeResults: Map<UnitObject, number> = new Map();
  private miracleRestoreHps: Map<UnitObject, number> = new Map();

  combatRange: number = 1;
  /** Python at_range = distance - 1. */
  atRange: number = 0;

  private static readonly FRAME_MS = FRAMETIME;
  private animFrameAccumulator = 0;

  /** START toggles Python _skip (battle_anim_speed 0.25, waits pass). */
  private skipFlag: boolean = false;
  get skipMode(): boolean {
    return this.skipFlag;
  }
  set skipMode(value: boolean) {
    this.skipFlag = value;
    setBattleAnimSpeed(value ? 0.25 : 1);
  }

  /** Instantly skip to the end of combat (no more animation). */
  skipToEnd(): void {
    if (this.solving || this.pendingStrikeEvents || this.phaseEvents.size > 0) {
      // Strikes still to solve or events to run between them: fast-forward.
      this.skipMode = true;
      return;
    }
    this.setState('done');
    setBattleAnimSpeed(1);
    this.onFinish?.();
    this.onFinish = null;
  }

  private solver: CombatPhaseSolver;
  /** Phases remain to be resolved (deferSolve). */
  private solving = false;
  private solveStarted = false;
  strikeEventHook: StrikeEventHook | null = null;
  pendingStrikeEvents: unknown[] | null = null;
  /** Each event phase's events, keyed by the phase's first strike index. */
  private phaseEvents: Map<number, unknown[]> = new Map();
  private strikeEventBaseline: Map<UnitObject, number> | null = null;
  /** Result HP walk over strikes [0, walked) (see walkStrikes). */
  private walk: { atkHp: number; defHp: number } | null = null;
  private walked = 0;

  // -- Effect sprite cache ---------------------------------------------------
  effectFrameCache: Map<string, Map<string, ImageBitmap | HTMLCanvasElement>> = new Map();
  effectLoadingSet: Set<string> = new Set();

  audioManager: { playSfx(name: string): void; stopSfx?(name: string): void } | null = null;
  /** Python start_battle_music, run after init_pause. */
  onStartBattleMusic: (() => void) | null = null;
  /** Python finish(): fade the battle music back once the scene is gone. */
  onFinish: (() => void) | null = null;
  /** Platforms (left as loaded, right already flipped) and optional panorama. */
  leftPlatform: HTMLImageElement | null = null;
  rightPlatform: HTMLImageElement | null = null;
  battleBackground: HTMLImageElement | null = null;
  private game: any;
  private participants: UnitObject[];

  constructor(
    attacker: UnitObject,
    attackItem: ItemObject,
    defender: UnitObject,
    defenseItem: ItemObject | null,
    db: any,
    rngMode: string,
    leftAnim: BattleAnimation,
    rightAnim: BattleAnimation,
    leftIsAttacker: boolean,
    board?: any,
    script?: string[] | null,
    randomGame?: RandomGameState | null,
    transformAnimations?: TransformBattleAnimations,
    options: { deferSolve?: boolean } = {},
  ) {
    if (attacker.strikePartner || defender.strikePartner) {
      throw new Error('AnimationCombat does not support attack-stance partners; use MapCombat');
    }
    this.attacker = attacker;
    this.defender = defender;
    this.attackItem = attackItem;
    this.defenseItem = defenseItem;
    this.db = db;
    this.game = randomGame as any;
    this.participants = [...new Set([
      attacker,
      defender,
      ...(attacker.rescuing ? [attacker.rescuing] : []),
      ...(defender.rescuing ? [defender.rescuing] : []),
    ])];
    this.leftIsAttacker = leftIsAttacker;
    this.mainLeftAnim = leftAnim;
    this.mainRightAnim = rightAnim;
    this.leftTransformAnim = leftIsAttacker
      ? transformAnimations?.attackerTransform ?? null
      : transformAnimations?.defenderTransform ?? null;
    this.rightTransformAnim = leftIsAttacker
      ? transformAnimations?.defenderTransform ?? null
      : transformAnimations?.attackerTransform ?? null;
    this.leftRevertAnim = leftIsAttacker
      ? transformAnimations?.attackerRevert ?? null
      : transformAnimations?.defenderRevert ?? null;
    this.rightRevertAnim = leftIsAttacker
      ? transformAnimations?.defenderRevert ?? null
      : transformAnimations?.attackerRevert ?? null;
    this.leftAnim = this.leftTransformAnim ?? this.mainLeftAnim;
    this.rightAnim = this.rightTransformAnim ?? this.mainRightAnim;

    const aPos = attacker.position;
    const dPos = defender.position;
    const range = (aPos && dPos)
      ? Math.abs(aPos[0] - dPos[0]) + Math.abs(aPos[1] - dPos[1])
      : 1;
    this.combatRange = range;
    this.atRange = range - 1;
    this.panConfig = getPanConfig(this.atRange);
    this.leftAnim.isLeft = true;
    this.rightAnim.isLeft = false;

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
      attacker, attackItem, defender, defenseItem, [], db, rngMode as RngMode, board, script,
    );
    this.strikes = [];
    // Live: lifecycle marks (pre-procs first) arrive as phases resolve.
    this.procPlayback = solver.procPlayback;
    this.solving = true;

    const leftUnit = leftIsAttacker ? attacker : defender;
    const rightUnit = leftIsAttacker ? defender : attacker;
    this.leftTargetHp = leftUnit.currentHp;
    this.rightTargetHp = rightUnit.currentHp;
    this.leftHpBar = new CombatHpBar(leftUnit.currentHp);
    this.rightHpBar = new CombatHpBar(rightUnit.currentHp);
    this.attackerStartHp = attacker.currentHp;
    this.defenderStartHp = defender.currentHp;
    if (!options.deferSolve) this.resolvePhases();

    // setup_pan: focus_right = attacker is right.
    this.focusRight = !leftIsAttacker;
    this.panOffset = this.focusRight ? -this.panConfig.max : this.panConfig.max;

    this.viewPos = dPos ? [dPos[0], dPos[1]] : aPos ? [aPos[0], aPos[1]] : [0, 0];
  }

  private get leftUnit(): UnitObject {
    return this.leftIsAttacker ? this.attacker : this.defender;
  }

  private get rightUnit(): UnitObject {
    return this.leftIsAttacker ? this.defender : this.attacker;
  }

  // ================================================================
  // Main update (AnimationCombat.update)
  // ================================================================

  /** Battle anim ticks owed for this update (fixed 60 FPS steps). */
  private computeAnimTicks(deltaMs: number): number {
    this.animFrameAccumulator += deltaMs;
    let ticks = 0;
    while (this.animFrameAccumulator >= AnimationCombat.FRAME_MS - 0.001) {
      this.animFrameAccumulator -= AnimationCombat.FRAME_MS;
      ticks++;
    }
    return Math.min(ticks, 4);
  }

  update(deltaMs: number): boolean {
    this.stateTimer += deltaMs;
    this.stateFrameCount++;
    const skip = this.skipFlag;
    let finished = false;

    switch (this.state) {
      case 'init': this.updateInit(); break;
      case 'red_cursor':
        if (skip || this.stateTimer > 400) {
          this.game?.cursor?.combatHide?.();
          this.setState('fade_in');
        }
        break;
      case 'fade_in': this.updateFadeIn(); break;
      case 'entrance': this.updateEntrance(); break;
      case 'init_pause': this.updateInitPause(); break;
      case 'transform': this.updateTransform(); break;
      case 'pre_proc': this.updateProcCue(); break;
      case 'begin_phase': this.updateBeginPhase(); break;
      case 'strike_events': break; // CombatState runs pendingStrikeEvents
      case 'attack_proc': this.updateProcCue(); break;
      case 'defense_proc': this.updateProcCue(); break;
      case 'anim': this.updateAnim(); break;
      case 'combat_hit': this.updateCombatHit(); break;
      case 'hp_change': this.updateHpChange(); break;
      case 'end_phase': this.updateEndPhase(); break;
      case 'end_combat': this.updateEndCombat(); break;
      case 'exp_pause':
        if (skip || this.stateTimer > 450) this.setState('exp_wait');
        break;
      case 'exp_wait':
        // CombatState applies the results and shows the exp bar over the
        // scene (Python clean_up1 pushes ExpState), then sets expDone.
        if (this.expDone) this.updateExpWait();
        break;
      case 'revert': this.updateRevert(); break;
      case 'fade_out_wait': this.updateFadeOutWait(); break;
      case 'name_tags_out': {
        const exit = skip ? UI_SLIDE_SKIP_MS : UI_SLIDE_MS;
        this.nameOffset = Math.max(0, 1 - this.stateTimer / exit);
        if (this.stateTimer > exit) {
          this.nameOffset = 0;
          this.setState('all_out');
        }
        break;
      }
      case 'all_out': {
        const exit = skip ? UI_SLIDE_SKIP_MS : UI_SLIDE_MS;
        this.barOffset = Math.max(0, 1 - this.stateTimer / exit);
        this.platformOffset = this.barOffset;
        if (this.stateTimer > exit) {
          this.barOffset = 0;
          this.platformOffset = 0;
          this.setState('fade_out');
        }
        break;
      }
      case 'fade_out':
        this.buildViewbox(VIEWBOX_TIME - this.stateTimer);
        if (this.stateTimer > VIEWBOX_TIME) {
          this.onFinish?.();
          this.onFinish = null;
          setBattleAnimSpeed(1);
          this.setState('done');
          finished = true;
        }
        break;
      case 'done':
        return true;
    }

    // Python: hp bars update, then update_anims (battle anims + shake).
    this.leftHpBar.update(deltaMs);
    this.rightHpBar.update(deltaMs);
    const ticks = this.computeAnimTicks(deltaMs);
    for (let i = 0; i < ticks; i++) this.updateAnims();
    return finished;
  }

  /** MockCombat.update_anims */
  private updateAnims(): void {
    this.leftAnim.update();
    this.rightAnim.update();
    if (this.currentShake) {
      this.shakeOffset = this.shakeSet[this.currentShake - 1];
      this.currentShake++;
      if (this.currentShake > this.shakeSet.length) this.currentShake = 0;
    }
    if (this.platformCurrentShake) {
      this.platformShakeOffset = this.platformShakeSet[this.platformCurrentShake - 1];
      this.platformCurrentShake++;
      if (this.platformCurrentShake > this.platformShakeSet.length) this.platformCurrentShake = 0;
    }
  }

  // ================================================================
  // State updates
  // ================================================================

  private setState(state: AnimCombatState): void {
    this.state = state;
    this.stateTimer = 0;
    this.stateFrameCount = 0;
  }

  /** Kept for callers that set states directly. */
  private transition(state: AnimCombatState): void {
    this.setState(state);
  }

  private updateInit(): void {
    // Python init -> red_cursor (400 ms). The web additionally waits for the
    // spritesheets so placeholder frames never show.
    const leftReady = this.leftAnim.getDrawData().mainFrame != null;
    const rightReady = this.rightAnim.getDrawData().mainFrame != null;
    if ((leftReady && rightReady) || this.stateTimer >= SPRITE_LOAD_WAIT_MS) {
      // red_cursor: the red combat cursor on the defender for 400 ms.
      const cursor = this.game?.cursor;
      cursor?.setPos?.(this.viewPos[0], this.viewPos[1]);
      cursor?.combatShow?.();
      this.setState('red_cursor');
    }
  }

  /** build_viewbox */
  private buildViewbox(currentTime: number): void {
    const mul = Math.max(0, Math.min(1, currentTime / VIEWBOX_TIME));
    const trueX = this.viewPos[0] - this.cameraX + 0.5;
    const trueY = this.viewPos[1] - this.cameraY + 0.5;
    const vbX = Math.trunc(mul * trueX * TILEWIDTH);
    const vbY = Math.trunc(mul * trueY * TILEHEIGHT);
    const vbW = Math.trunc(WINWIDTH - vbX - (mul * (TILEX - trueX)) * TILEWIDTH);
    const vbH = Math.trunc(WINHEIGHT - vbY - (mul * (TILEY - trueY)) * TILEHEIGHT);
    this.viewbox = [vbX, vbY, vbW, vbH];
  }

  private updateFadeIn(): void {
    this.buildViewbox(this.stateTimer);
    if (this.stateTimer > VIEWBOX_TIME) {
      this.viewbox = [this.viewbox![0], this.viewbox![1], 0, 0];
      this.setState('entrance');
      this.pairBattleAnimations(ENTRANCE_FRAMES);
    }
  }

  private updateEntrance(): void {
    const t = this.stateTimer / UI_SLIDE_MS;
    this.barOffset = Math.min(1, t);
    this.nameOffset = Math.min(1, t);
    this.platformOffset = Math.min(1, t);
    if (this.skipFlag || this.stateTimer > UI_SLIDE_MS) {
      this.barOffset = this.nameOffset = this.platformOffset = 1;
      this.setState('init_pause');
    }
  }

  private updateInitPause(): void {
    if (this.skipFlag || this.stateTimer > 25 * FRAMETIME) {
      // battle_music, then transforms or pre_proc.
      this.onStartBattleMusic?.();
      this.onStartBattleMusic = null;
      if (this.leftTransformAnim || this.rightTransformAnim) {
        if (this.leftTransformAnim) this.leftAnim.initiateTransform();
        if (this.rightTransformAnim) this.rightAnim.initiateTransform();
        this.setState('transform');
      } else {
        this.beginPreProcPhase();
      }
    }
  }

  private updateTransform(): void {
    if (!this.leftAnim.done() || !this.rightAnim.done()) return;
    this.leftAnim = this.mainLeftAnim;
    this.rightAnim = this.mainRightAnim;
    this.pairBattleAnimations(0);
    this.beginPreProcPhase();
  }

  private beginPreProcPhase(): void {
    const preProcCues = (kind: 'attack_pre_proc' | 'defense_pre_proc') =>
      this.procPlayback
        .filter((mark) => mark.kind === kind && isProcIconVisible(mark))
        .map(cueFromMark)
        .reverse();
    this.pendingProcCues = dedupeProcCues([
      ...preProcCues('attack_pre_proc'),
      ...preProcCues('defense_pre_proc'),
      ...displaySkillCues([this.attacker, this.defender], this.game),
    ]);
    if (this.pendingProcCues.length > 0) this.startNextProcCue('pre_proc');
    else this.transition('begin_phase');
  }

  /**
   * Resolve phases until one has strike events (run when the presentation
   * reaches it) or the combat has no more phases.
   */
  private resolvePhases(): void {
    if (!this.solving) return;
    if (!this.solveStarted) {
      this.solveStarted = true;
      // Start-combat events ran before the first phase was solved.
      this.attackerStartHp = this.attacker.currentHp;
      this.defenderStartHp = this.defender.currentHp;
      this.leftTargetHp = this.leftUnit.currentHp;
      this.rightTargetHp = this.rightUnit.currentHp;
      this.leftHpBar.setTarget(this.leftTargetHp);
      this.rightHpBar.setTarget(this.rightTargetHp);
    }
    for (;;) {
      const first = this.strikes.length;
      const phase = this.solver.resolveNextPhase();
      if (!phase) {
        this.solving = false;
        this.guardGaugeResults = new Map(this.solver.guardGaugeResults);
        this.miracleRestoreHps = new Map(this.solver.miracleRestoreHp);
        this.lifecycleRecord.finish();
        return;
      }
      this.strikes.push(...phase);
      for (const strike of phase) {
        for (const effect of [...(strike.allySkillHpChanges ?? []), ...(strike.redirectedDamage ?? [])]) {
          if (!this.participants.includes(effect.unit)) this.participants.push(effect.unit);
        }
      }
      const events = this.strikeEventHook?.(phase) ?? [];
      if (events.length > 0) {
        this.phaseEvents.set(first, events);
        return;
      }
      // A hit that shoves/swaps: the next resolveNextPhase() moves the units
      // once the presentation has shown the hit.
      if (this.solver.hasPendingMovement) return;
    }
  }

  resumeAfterStrikeEvents(): void {
    if (!this.pendingStrikeEvents) return;
    const deltas = strikeEventHpDeltas(this.strikeEventBaseline ?? new Map());
    this.pendingStrikeEvents = null;
    this.strikeEventBaseline = null;
    if (deltas.size > 0) {
      this.solver.adjustSimulatedHp(deltas);
      const walk = this.walk!;
      walk.atkHp += deltas.get(this.attacker) ?? 0;
      walk.defHp += deltas.get(this.defender) ?? 0;
      this.leftTargetHp = this.leftUnit.currentHp;
      this.rightTargetHp = this.rightUnit.currentHp;
      this.leftHpBar.setTarget(this.leftTargetHp);
      this.rightHpBar.setTarget(this.rightTargetHp);
    }
    this.transition('begin_phase');
  }

  private updateBeginPhase(): void {
    if (this.currentStrikeIndex >= this.strikes.length) this.resolvePhases();
    if (this.currentStrikeIndex >= this.strikes.length) {
      this.transition('end_combat');
      return;
    }
    const events = this.phaseEvents.get(this.currentStrikeIndex);
    if (events) {
      // Python runs the phase's events before its proc cues and hit: apply
      // the strikes shown so far, then hand the events to CombatState.
      this.phaseEvents.delete(this.currentStrikeIndex);
      const index = this.currentStrikeIndex;
      this.strikeEventBaseline = applyPresentedStrikeHp(this.game, this.participants, () => {
        this.walkStrikes(index);
        const walk = this.walk!;
        this.attacker.currentHp = Math.max(0, Math.min(this.attacker.maxHp, walk.atkHp));
        this.defender.currentHp = Math.max(0, Math.min(this.defender.maxHp, walk.defHp));
      });
      this.pendingStrikeEvents = events;
      this.transition('strike_events');
      return;
    }
    const strike = this.strikes[this.currentStrikeIndex];
    this.pendingProcCues = [
      ...(strike.attackProcs ?? []).filter(isProcIconVisible).map(cueFromMark).reverse(),
      ...(strike.defenseProcs ?? []).filter(isProcIconVisible).map(cueFromMark).reverse(),
    ];
    if (this.pendingProcCues.length > 0) {
      this.startNextProcCue();
      return;
    }
    this.setUpCombatAnimation(strike);
  }

  /** set_up_combat_animation */
  private setUpCombatAnimation(strike: CombatStrike): void {
    this.transition('anim');
    const anim = this.isLeftUnit(strike.attacker) ? this.leftAnim : this.rightAnim;
    this.currentBattleAnim = anim;
    this.strikeApplied = false;
    this.strikeHasHpBrush = false;
    const connected = strike.hit || hasDamageOnMiss(strike.item);
    if (strike.crit && strike.hit) anim.startAnim('Critical');
    else if (connected) anim.startAnim('Attack');
    else anim.startAnim('Miss');
    this.focusRight = anim === this.rightAnim;
    this.moveCamera();
  }

  private startNextProcCue(forcedState?: 'pre_proc'): void {
    const cue = this.pendingProcCues.shift() ?? null;
    this.activeProcCue = cue;
    if (!cue) return;
    const isRight = !this.isLeftUnit(cue.unit);
    const sideAnim = isRight ? this.rightAnim : this.leftAnim;
    if (this.getEffectData(cue.skill.nid)) {
      // mark_proc: the skill's combat effect on its owner's side.
      const effect = sideAnim.getEffect?.(cue.skill.nid, false, 'Attack');
      if (effect) sideAnim.addEffect(effect);
    }
    // add_proc_icon focuses the camera on the skill owner.
    this.focusRight = isRight;
    this.moveCamera();
    this.transition(forcedState ?? (cue.kind === 'defense_proc' ? 'defense_proc' : 'attack_proc'));
  }

  private updateProcCue(): void {
    if (this.activeProcCue) this.activeProcCue.elapsed = this.stateTimer;
    if (this.stateTimer < PROC_CUE_DURATION_MS) return;
    const effectsDone = [this.leftAnim, this.rightAnim].every((anim) =>
      anim.effects.every((effect: any) => effect.isDone()) &&
      anim.underEffects.every((effect: any) => effect.isDone()));
    if (!effectsDone) return;
    const procState = this.state;
    if (this.pendingProcCues.length > 0) {
      this.startNextProcCue(procState === 'pre_proc' ? 'pre_proc' : undefined);
    } else if (procState === 'pre_proc') {
      this.activeProcCue = null;
      this.transition('begin_phase');
    } else {
      this.activeProcCue = null;
      const strike = this.strikes[this.currentStrikeIndex];
      if (strike) this.setUpCombatAnimation(strike);
      else this.transition('end_combat');
    }
  }

  private updateAnim(): void {
    if (this.leftAnim.done() && this.rightAnim.done()) this.transition('end_phase');
  }

  /** combat_hit: clean_up0 (death marks) then hp_change. */
  private updateCombatHit(): void {
    this.transition('hp_change');
  }

  private updateHpChange(): void {
    const anim = this.currentBattleAnim;
    const proceed = anim ? anim.canProceed() : true;
    if (this.stateTimer > 27 * FRAMETIME && this.leftHpBar.done() && this.rightHpBar.done() && proceed) {
      anim?.resume();
      if (this.leftTargetHp <= 0) this.leftAnim.startDyingAnimation();
      if (this.rightTargetHp <= 0) this.rightAnim.startDyingAnimation();
      if ((this.leftTargetHp <= 0 || this.rightTargetHp <= 0) && anim && anim.state !== 'dying') {
        anim.waitForDying();
      }
      this.transition('anim');
    }
  }

  private updateEndPhase(): void {
    this.currentStrikeIndex++;
    this.currentBattleAnim = null;
    this.transition('begin_phase');
  }

  private updateEndCombat(): void {
    if (this.leftAnim.done() && this.rightAnim.done()) {
      this.focusExp();
      this.moveCamera();
      this.transition('exp_pause');
    }
  }

  /** revert_transform (runs once CombatState's exp screen is finished). */
  private updateExpWait(): void {
    const leftAlive = this.leftTargetHp > 0;
    const rightAlive = this.rightTargetHp > 0;
    const useLeftRevert = !this.skipFlag && leftAlive && this.leftRevertAnim;
    const useRightRevert = !this.skipFlag && rightAlive && this.rightRevertAnim;
    if (!useLeftRevert && !useRightRevert) {
      this.transition('fade_out_wait');
      return;
    }
    if (useLeftRevert) this.leftAnim = useLeftRevert;
    if (useRightRevert) this.rightAnim = useRightRevert;
    this.pairBattleAnimations(0);
    if (useLeftRevert) this.leftAnim.initiateTransform();
    if (useRightRevert) this.rightAnim.initiateTransform();
    this.transition('revert');
  }

  private updateRevert(): void {
    const leftDone = !this.leftRevertAnim || this.leftTargetHp <= 0 || this.leftAnim.done();
    const rightDone = !this.rightRevertAnim || this.rightTargetHp <= 0 || this.rightAnim.done();
    if (leftDone && rightDone) this.transition('fade_out_wait');
  }

  private updateFadeOutWait(): void {
    if (this.skipFlag || this.stateTimer > 820) {
      this.leftAnim.finish();
      this.rightAnim.finish();
      this.transition('name_tags_out');
    }
  }

  /** pair_battle_animations: sprites grow in from their map tiles. */
  private pairBattleAnimations(entranceFrames: number): void {
    const tile = (unit: UnitObject): [number, number] => unit.position
      ? [(unit.position[0] - this.cameraX) * TILEWIDTH, (unit.position[1] - this.cameraY) * TILEHEIGHT]
      : [0, 0];
    this.leftAnim.pair(this, this.rightAnim, false, this.atRange, 14, tile(this.leftUnit));
    this.leftAnim.entranceCounter = entranceFrames;
    this.rightAnim.pair(this, this.leftAnim, true, this.atRange, 14, tile(this.rightUnit));
    this.rightAnim.entranceCounter = entranceFrames;
    this.leftAnim.isLeft = true;
    this.rightAnim.isLeft = false;
  }

  // ================================================================
  // BattleAnimOwner callbacks (AnimationCombat / MockCombat)
  // ================================================================

  private currentStrike(): CombatStrike | null {
    return this.currentStrikeIndex < this.strikes.length ? this.strikes[this.currentStrikeIndex] : null;
  }

  /** get_damage: damage of this strike's damage_hit/damage_crit brush. */
  private getDamage(): number {
    const strike = this.currentStrike();
    if (!strike || !(strike.hit || hasDamageOnMiss(strike.item)) || strike.damage < 0) return 0;
    return strike.damage;
  }

  private teamColor(unit: UnitObject): string {
    return this.db?.teams?.defs?.find((team: { nid: string }) => team.nid === unit.team)?.combatColor ?? 'blue';
  }

  private specialBossCrit(defender: UnitObject, afterAttack: boolean): boolean {
    const strike = this.currentStrike();
    if (!strike || !this.db?.getConstant?.('boss_crit', false) || !strike.hit || strike.crit) return false;
    if (!unitHasTag(defender, 'Boss')) return false;
    const hp = defender === this.leftUnit ? this.leftTargetHp : this.rightTargetHp;
    return afterAttack ? hp <= 0 : this.getDamage() >= hp;
  }

  /** _apply_actions + _handle_playback for the current strike (once). */
  startHit(_anim: BattleAnimation, miss: boolean = false): void {
    this.applyStrike(true);
    if (miss) this.missAnim();
  }

  private applyStrike(sound: boolean): void {
    const strike = this.currentStrike();
    if (!strike || this.strikeApplied) return;
    this.strikeApplied = true;
    const defenderIsLeft = this.isLeftUnit(strike.defender);
    const connected = strike.hit || hasDamageOnMiss(strike.item);
    if (!connected) {
      if (sound) this.playSound('Miss'); // 'Attack Miss 2' -> 'Miss'
      return;
    }
    const total = strike.damage + (strike.extraDamage ?? 0);
    const before = defenderIsLeft ? this.leftTargetHp : this.rightTargetHp;
    const after = Math.max(0, Math.min(strike.defender.maxHp, before - total));
    if (defenderIsLeft) {
      this.leftTargetHp = after;
      this.leftHpBar.setTarget(after);
    } else {
      this.rightTargetHp = after;
      this.rightHpBar.setTarget(after);
    }
    this.strikeHasHpBrush = true;
    this.transition('combat_hit');

    // handle_damage_numbers
    const damage = strike.damage;
    if (damage < 0) this.addDamageNumbers(-damage, defenderIsLeft, 'cyan');
    else if (damage > 0) this.addDamageNumbers(damage, defenderIsLeft, strike.crit ? 'yellow' : 'red');
    // The EOtF fork's AnimationCombat.handle_damage_numbers has no
    // extra_damage branch: the extra instance drains the HP bar with no
    // digits (only MapCombat draws them, in extra_purple).
    if (!sound) return;

    // hit_sound brushes (heals play only on the map).
    if (damage < 0) return;
    const lethal = after <= 0;
    const configured = strike.item.getComponent<string>('map_hit_sfx');
    const crit = () => `Critical Hit ${1 + Math.floor(Math.random() * 2)}`;
    const bossCrit = this.specialBossCrit(strike.defender, true);
    let name: string;
    if (configured) name = configured;
    else if (damage === 0) name = 'No Damage';
    else if (strike.crit) {
      if (lethal) this.playSound('Final Hit');
      name = crit();
    } else if (strike.glancing) name = lethal ? 'Final Hit' : 'No Damage';
    else name = lethal ? 'Final Hit' : `Attack Hit ${1 + Math.floor(Math.random() * 5)}`;
    if (bossCrit) {
      if (name.startsWith('Attack Hit')) name = crit();
      else if (name.startsWith('Final Hit')) this.playSound(crit());
    }
    this.playSound(name);
  }

  spellHit(_anim: BattleAnimation): void {
    this.applyStrike(true);
    if (!this.strikeHasHpBrush) this.currentBattleAnim?.resume();
    const strike = this.currentStrike();
    if (strike && this.getDamage() <= 0 && strike.damage >= 0 && (strike.hit || hasDamageOnMiss(strike.item))) {
      this.noDamage();
    }
  }

  hitModifiers(): void {
    const strike = this.currentStrike();
    if (this.getDamage() > 0 && strike?.glancing) this.glancingHit();
  }

  /** AnimationCombat.shake: pick the shake set from the strike playback. */
  shake(): void {
    const strike = this.currentStrike();
    if (!strike || !(strike.hit || hasDamageOnMiss(strike.item)) || strike.damage < 0) return;
    const damage = strike.damage;
    if (strike.crit) {
      this.rawShake(damage > 0 ? 4 : 2);
    } else if (damage > 0) {
      const magic = isMagic(strike.item) && (strike.item.hasComponent('magic') || this.combatRange > 1);
      if (this.specialBossCrit(strike.defender, false)) this.rawShake(4);
      else this.rawShake(magic ? 3 : 1);
    } else {
      this.rawShake(2);
    }
  }

  /** MockCombat._shake */
  rawShake(num: number): void {
    const set = SHAKE_SETS[num];
    if (!set) return;
    this.currentShake = 1;
    this.shakeSet = set;
  }

  platformShake(): void {
    this.platformCurrentShake = 1;
    this.platformShakeSet = PLATFORM_SHAKE;
  }

  screenFlash(numFrames: number, color: Color, fadeOut: number = 0): void {
    this.foregroundFrames = numFrames;
    this.foregroundColor = color;
    this.foregroundFadeFrames = fadeOut;
    this.foregroundFadeOut = false;
  }

  darken(): void {
    this.targetDark += 0.5;
  }

  lighten(): void {
    this.targetDark -= 0.5;
  }

  setBrightness(value: number): void {
    this.targetDark = 1 - value;
  }

  darkenUi(): void {
    this.darkenUiBackground = 1;
  }

  lightenUi(): void {
    this.darkenUiBackground = -3;
  }

  panAway(): void {
    this.focusRight = !this.focusRight;
    this.moveCamera();
  }

  /** pan_back: focus whoever strikes next, else the exp recipient. */
  panBack(): void {
    // state_machine.get_next_state(): the solver advances when the strike's
    // actions apply, so after the hit this is the following strike.
    const next = this.strikes[this.currentStrikeIndex + (this.strikeApplied ? 1 : 0)] ?? null;
    if (next) this.focusRight = !this.isLeftUnit(next.attacker);
    else this.focusExp();
    this.moveCamera();
  }

  private focusExp(): void {
    if (this.attacker.team === 'player') this.focusRight = this.attacker === this.rightUnit;
    else if (this.defender.team === 'player') this.focusRight = this.defender === this.rightUnit;
  }

  private moveCamera(): void {
    if (!this.panConfig) return;
    if (this.focusRight && this.panOffset !== -this.panConfig.max) this.panDir = -this.panConfig.speed;
    else if (!this.focusRight && this.panOffset !== this.panConfig.max) this.panDir = this.panConfig.speed;
  }

  /** Set camera offset (in pixels) so the viewbox iris can compute tile-relative positions. */
  setCameraOffset(pixelX: number, pixelY: number): void {
    this.cameraX = pixelX / TILEWIDTH;
    this.cameraY = pixelY / TILEHEIGHT;
  }

  playSound(name: string): void {
    this.audioManager?.playSfx(name);
  }

  stopSound(name: string): void {
    this.audioManager?.stopSfx?.(name);
  }

  spellEffectNid(_anim: BattleAnimation): string | null {
    const item = this.currentStrike()?.item ?? this.attackItem;
    return item.getComponent<string>('battle_cast_anim') ?? item.nid;
  }

  private spawnScreenAnimation(nid: string, position: [number, number], additive: boolean, flip: boolean = false): void {
    const prefab = this.db?.mapAnimations?.get?.(nid);
    if (!prefab) return;
    const anim = new ScreenAnimation(prefab, position, flip);
    anim.additive = additive;
    this.animations.push(anim);
    const resources = this.game?.resources;
    if (!resources?.loadImage) {
      anim.done = true;
      return;
    }
    void resources.loadImage(`resources/animations/${nid}.png`)
      .then((image: HTMLImageElement) => anim.setImage(image))
      .catch(() => { anim.done = true; });
  }

  hitSpark(): void {
    if (this.getDamage() > 0) {
      if (this.currentStrike()?.glancing) {
        this.glancingHit();
      } else {
        const right = this.currentBattleAnim === this.rightAnim;
        const position: [number, number] = right
          ? [-110 + WINWIDTH / 2 - 120, -30]
          : [-40 + WINWIDTH / 2 - 120, -30];
        this.spawnScreenAnimation('HitSpark', position, true);
      }
    } else {
      this.noDamage();
    }
  }

  critSpark(): void {
    if (this.getDamage() > 0) {
      const flip = this.currentBattleAnim !== this.rightAnim;
      this.spawnScreenAnimation('CritSpark', [-40 + WINWIDTH / 2 - 120, -30], true, flip);
    } else {
      this.noDamage();
    }
  }

  private noDamage(): void {
    const right = this.currentBattleAnim === this.rightAnim;
    const color = this.teamColor(right ? this.rightUnit : this.leftUnit);
    this.spawnScreenAnimation(`NoDamage${color[0].toUpperCase()}${color.slice(1)}`, right ? [52, 21] : [WINWIDTH / 2, 21], false);
    if (this.currentBattleAnim) this.currentBattleAnim.lrOffset = [-1, -2, -3, -2, -1];
  }

  private glancingHit(): void {
    const right = this.currentBattleAnim === this.rightAnim;
    const color = this.teamColor(right ? this.rightUnit : this.leftUnit);
    this.spawnScreenAnimation(`GlancingHit${color[0].toUpperCase()}${color.slice(1)}`, right ? [64, 21] : [WINWIDTH / 2, 21], false);
    if (this.currentBattleAnim) this.currentBattleAnim.lrOffset = [-1, -3, -5, -3, -1];
  }

  private missAnim(): void {
    const right = this.currentBattleAnim === this.rightAnim;
    const color = this.teamColor(right ? this.rightUnit : this.leftUnit);
    this.spawnScreenAnimation(`Miss${color[0].toUpperCase()}${color.slice(1)}`, right ? [72, 21] : [128, 21], false);
  }

  private addDamageNumbers(damage: number, left: boolean, color: string): void {
    const digits = String(damage);
    const now = fxNow();
    for (let idx = 0; idx < digits.length; idx++) {
      this.damageNumbers.push({
        digit: Number(digits[idx]), idx, length: digits.length, left,
        sheet: `damage_numbers_${color}`, start: now,
      });
    }
  }

  // ================================================================
  // Effect data / sprites
  // ================================================================

  getEffectData(effectNid: string): CombatEffectData | null {
    return this.db.combatEffects?.get(effectNid) ?? null;
  }

  getEffectFrameImages(effectNid: string): Map<string, ImageBitmap | HTMLCanvasElement> {
    const cached = this.effectFrameCache.get(effectNid);
    if (cached) return cached;
    let frames = this.effectLoading.get(effectNid);
    if (!frames) {
      frames = new Map();
      this.effectLoading.set(effectNid, frames);
      void this.loadEffectSprites(effectNid, frames);
    }
    return frames;
  }

  private effectLoading = new Map<string, Map<string, ImageBitmap | HTMLCanvasElement>>();

  private async loadEffectSprites(
    effectNid: string,
    target: Map<string, ImageBitmap | HTMLCanvasElement>,
  ): Promise<void> {
    try {
      const effectData = this.db.combatEffects?.get(effectNid) as CombatEffectData | undefined;
      if (!effectData) return;
      const resources = (globalThis as any).__ltResources ?? this.game?.resources;
      if (!resources) return;
      const img = await loadEffectSpritesheet(resources, effectNid);
      if (!img) return;
      const palettes = this.db.combatPalettes as Map<string, PaletteData> | undefined;
      let palette: PaletteData | null = null;
      if (effectData.palettes.length > 0) {
        const [, paletteNid] = effectData.palettes[0];
        palette = palettes?.get(paletteNid) ?? null;
      }
      const frames = convertSpritesheetToFrames(img, effectData.frames, palette);
      // Every child effect shares this map, so frames appear in place.
      for (const [nid, canvas] of frames) target.set(nid, canvas);
      this.effectFrameCache.set(effectNid, target);
    } catch (e) {
      console.warn(`AnimationCombat: failed to load effect "${effectNid}":`, e);
    }
  }

  // ================================================================
  // Results
  // ================================================================

  applyResults(actionLog?: ActionLog): CombatResults {
    if (this.cachedResults) {
      return this.cachedResults;
    }
    if (actionLog) {
      const action = new CombatResultAction<CombatResults>(
        this.participants,
        [this.attackItem, ...(this.defenseItem ? [this.defenseItem] : [])],
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
   * HP applied before strike events (and the events' own HP changes) carry
   * into the final results.
   */
  private walkStrikes(upTo: number): void {
    const walk = this.walk ??= { atkHp: this.attackerStartHp, defHp: this.defenderStartHp };
    let atkHp = walk.atkHp;
    let defHp = walk.defHp;
    const attackerMaxHp = this.attacker.stats['HP'] ?? 0;

    for (; this.walked < upTo; this.walked++) {
      const strike = this.strikes[this.walked];
      if (!strike.hit && !hasDamageOnMiss(strike.item)) {
        // Skill lifelink / live_to_serve can heal on a miss (EOtF fork).
        const missHeal = strike.selfSkillHpChange ?? 0;
        if (missHeal !== 0) {
          if (strike.attacker === this.attacker) {
            atkHp = Math.max(0, Math.min(attackerMaxHp, atkHp + missHeal));
          } else {
            defHp = Math.max(0, Math.min(this.defender.maxHp, defHp + missHeal));
          }
        }
        continue;
      }
      let damage = strike.damage;
      if (strike.hit && (hasEclipseFe7(strike.item) || hasEclipse(strike.item))) {
        const targetHp = strike.attacker === this.attacker ? defHp : atkHp;
        damage = hasEclipseFe7(strike.item)
          ? eclipseFe7Damage(targetHp)
          : eclipseDamage(targetHp);
      }
      damage += strike.extraDamage ?? 0;
      if (strike.attacker === this.attacker) {
        const itemHeal = lifelinkHealForStrike(
          strike.attacker,
          this.attackItem,
          strike,
          defHp,
        );
        atkHp = Math.max(0, Math.min(
          attackerMaxHp,
          atkHp + itemHeal + (strike.selfSkillHpChange ?? 0),
        ));
        defHp = Math.min(
          this.defender.maxHp,
          defHp - damage + (strike.defenderSkillHpChange ?? 0),
        );
      } else {
        const itemHeal = lifelinkHealForStrike(
          strike.attacker,
          this.defenseItem ?? strike.item,
          strike,
          atkHp,
        );
        defHp = Math.max(0, Math.min(
          this.defender.maxHp,
          defHp + itemHeal + (strike.selfSkillHpChange ?? 0),
        ));
        atkHp = Math.min(
          this.attacker.maxHp,
          atkHp - damage + (strike.defenderSkillHpChange ?? 0),
        );
      }
      for (const effect of strike.allySkillHpChanges ?? []) {
        if (effect.unit === this.attacker) {
          atkHp = Math.max(0, Math.min(attackerMaxHp, atkHp + effect.amount));
        } else if (effect.unit === this.defender) {
          defHp = Math.max(0, Math.min(
            this.defender.maxHp,
            defHp + effect.amount,
          ));
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
        } else if (effect.unit === this.defender) {
          defHp = Math.max(0, defHp - effect.amount);
        } else {
          effect.unit.currentHp = Math.max(
            0,
            effect.unit.currentHp - effect.amount,
          );
          if (effect.unit.currentHp <= 0) effect.unit.dead = true;
        }
      }
      if (strike.attacker === this.attacker) {
        atkHp = applyPermanentDamage(
          strike.attacker,
          atkHp,
          this.game ?? { db: this.db },
        );
      } else {
        defHp = applyPermanentDamage(
          strike.attacker,
          defHp,
          this.game ?? { db: this.db },
        );
      }
      if (strike.defender === this.attacker) {
        atkHp = applyPermanentDamage(
          strike.defender,
          atkHp,
          this.game ?? { db: this.db },
        );
      } else {
        defHp = applyPermanentDamage(
          strike.defender,
          defHp,
          this.game ?? { db: this.db },
        );
      }
    }
    walk.atkHp = atkHp;
    walk.defHp = defHp;
  }

  private computeResults(): CombatResults {
    this.walkStrikes(this.strikes.length);
    let atkHp = this.walk!.atkHp;
    let defHp = this.walk!.defHp;

    if (atkHp <= 0 && this.miracleRestoreHps.has(this.attacker)) {
      atkHp = this.miracleRestoreHps.get(this.attacker) ?? 1;
    }
    if (defHp <= 0 && this.miracleRestoreHps.has(this.defender)) {
      defHp = this.miracleRestoreHps.get(this.defender) ?? 1;
    }
    atkHp = Math.max(0, Math.min(this.attacker.maxHp, atkHp));
    defHp = Math.max(0, Math.min(this.defender.maxHp, defHp));

    this.attacker.currentHp = atkHp;
    this.defender.currentHp = defHp;
    for (const [unit, gauge] of this.guardGaugeResults) unit.currentGuardGauge = gauge;
    if (this.db.getConstant('pairup', false)) {
      this.attacker.builtGuard = true;
      this.defender.builtGuard = true;
    }

    const attackerDead = atkHp <= 0;
    const defenderDead = defHp <= 0;

    if (attackerDead) this.attacker.dead = true;
    if (defenderDead) this.defender.dead = true;

    // Weapon uses
    let attackWeaponBroke = false;
    let defenseWeaponBroke = false;

    const attackerUses = usesConsumedByStrikes(this.attacker, this.attackItem, this.strikes);
    if (attackerUses > 0 && this.attackItem.maxUses > 0) {
      for (let i = 0; i < attackerUses && this.attackItem.uses > 0; i++) {
        attackWeaponBroke = this.attackItem.decrementUses() || attackWeaponBroke;
      }
      if (attackWeaponBroke && !this.attackItem.hasComponent('no_break_out_of_uses')) {
        const idx = this.attacker.items.indexOf(this.attackItem);
        if (idx !== -1) this.attacker.items.splice(idx, 1);
        if (this.attacker.equippedWeapon === this.attackItem || this.attacker.equippedAccessory === this.attackItem) {
          this.attacker.unequip(this.attackItem);
        }
        this.attacker.autoequip();
      }
    }

    const defenderUses = this.defenseItem
      ? usesConsumedByStrikes(this.defender, this.defenseItem, this.strikes)
      : 0;
    if (defenderUses > 0 && this.defenseItem && this.defenseItem.maxUses > 0) {
      for (let i = 0; i < defenderUses && this.defenseItem.uses > 0; i++) {
        defenseWeaponBroke = this.defenseItem.decrementUses() || defenseWeaponBroke;
      }
      if (defenseWeaponBroke && !this.defenseItem.hasComponent('no_break_out_of_uses')) {
        const idx = this.defender.items.indexOf(this.defenseItem);
        if (idx !== -1) this.defender.items.splice(idx, 1);
        if (this.defender.equippedWeapon === this.defenseItem || this.defender.equippedAccessory === this.defenseItem) {
          this.defender.unequip(this.defenseItem);
        }
        this.defender.autoequip();
      }
    }

    const componentResults = applyCombatComponents(
      this.attacker,
      this.attackItem,
      this.defender,
      this.defenseItem,
      this.strikes,
      attackerDead,
      defenderDead,
      this.db,
      this.game,
    );

    // Python simple_combat.calculate_exp is item_system.exp only: items with
    // no exp/level_exp component grant nothing. ExpState then clamps the
    // gain at the level cap and levels with the unit's growth method.
    const expShare = combatExpShare(
      this.attacker, componentResults.fixedExp ?? 0, attackerDead,
      this.defender, this.defenseItem, defenderDead, this.strikes, this.db,
    );
    let expGained = expShare.amount;
    let levelUps: Record<string, number>[] = [];
    if (expShare.unit && expGained > 0) {
      ({ applied: expGained, levelUps } = applyExpGain(expShare.unit, expGained, undefined, this.game));
    }
    // handle_paired_exp (guard stance) only runs with the pairup constant.
    if (this.db.getConstant?.('pairup', false)) {
      if (this.attacker.rescuing && this.attacker.rescuing.team === 'player') {
        this.grantGuardFollowerExp(this.attacker, this.attacker.rescuing);
      }
      if (this.defender.rescuing && this.defender.rescuing.team === 'player') {
        this.grantGuardFollowerExp(this.defender, this.defender.rescuing);
      }
    }

    // Python (simple_combat.handle_item_gain): every droppable item on the
    // killed unit transfers to the killer, not just the first.
    const droppedItems: { unit: UnitObject; item: ItemObject }[] = [];
    if (defenderDead && !attackerDead) {
      for (const item of this.defender.items.slice()) {
        if (item.droppable) droppedItems.push({ unit: this.defender, item });
      }
    } else if (attackerDead && !defenderDead) {
      for (const item of this.attacker.items.slice()) {
        if (item.droppable) droppedItems.push({ unit: this.attacker, item });
      }
    }
    const droppedItem = droppedItems[0]?.item ?? null;

    return {
      attackerDead,
      defenderDead,
      expGained,
      expUnit: expShare.unit,
      levelUps,
      attackWeaponBroke,
      defenseWeaponBroke,
      droppedItem,
      droppedItems,
      attackerWexpGained: componentResults.attackerWexpGained,
      attackerRankUp: componentResults.attackerRankUp,
      stolenItem: componentResults.stolenItem,
      deathPositions: new Map([this.attacker, this.defender].map((unit) => [
        unit,
        unit.position ? [...unit.position] as [number, number] : null,
      ])),
    };
  }

  private grantGuardFollowerExp(leader: UnitObject, follower: UnitObject): void {
    const guardedHits = this.strikes.filter(
      (strike) => strike.guarded && strike.defender === leader,
    ).length;
    if (guardedHits <= 0) return;
    const minimum = Number(this.db.getConstant('min_exp', 0));
    const magnitude = Number(this.db.getConstant('exp_magnitude', 10));
    applyExpGain(follower, Math.max(minimum, Math.min(100, guardedHits * magnitude)), undefined, this.game);
  }


  // ================================================================
  // HUD stats (Python _set_stats) and render state
  // ================================================================

  private getHudStats(): NonNullable<AnimationCombat['hudStats']> {
    const leftUnit = this.leftUnit;
    const rightUnit = this.rightUnit;
    const leftItem = this.leftIsAttacker ? this.attackItem : this.defenseItem;
    const rightItem = this.leftIsAttacker ? this.defenseItem : this.attackItem;
    const hudKey = `${this.state}|${this.currentStrikeIndex}|${leftUnit.currentHp}|${rightUnit.currentHp}|` +
      `${leftItem?.uses ?? ''}|${rightItem?.uses ?? ''}|${leftItem?.nid ?? ''}|${rightItem?.nid ?? ''}`;
    if (this.hudStatsKey !== hudKey || !this.hudStats) {
      this.hudStatsKey = hudKey;
      // Defender stats are None (drawn '--') when it cannot counter.
      const defenderCounters = !!this.defenseItem &&
        canCounterattack(this.attacker, this.attackItem, this.defender, this.db, this.game);
      const sideStats = (unit: UnitObject, item: ItemObject | null, target: UnitObject) => {
        const isAttacker = unit === this.attacker;
        if (!item || (!isAttacker && !defenderCounters)) return { hit: null, damage: null, crit: null };
        const mode = isAttacker ? 'attack' : 'defense';
        return {
          hit: computeHit(unit, item, target, this.db, null, this.game, mode),
          damage: Math.max(0, computeDamage(unit, item, target, this.db, null, this.game, mode)),
          crit: this.db?.getConstant?.('crit', true) !== false
            ? computeCrit(unit, item, target, this.db, this.game, mode)
            : 0,
        };
      };
      const left = sideStats(leftUnit, leftItem, rightUnit);
      const right = sideStats(rightUnit, rightItem, leftUnit);
      this.hudStats = {
        leftMax: leftUnit.maxHp,
        rightMax: rightUnit.maxHp,
        leftHit: left.hit, leftDamage: left.damage, leftCrit: left.crit,
        rightHit: right.hit, rightDamage: right.damage, rightCrit: right.crit,
      };
    }
    return this.hudStats;
  }

  getRenderState(): AnimationCombatRenderState {
    const leftItem = this.leftIsAttacker ? this.attackItem : this.defenseItem;
    const rightItem = this.leftIsAttacker ? this.defenseItem : this.attackItem;
    const hud = this.getHudStats();
    const vb = this.viewbox;
    return {
      state: this.state,
      viewbox: vb ? { x: vb[0], y: vb[1], width: vb[2], height: vb[3] } : null,
      leftDraw: this.leftAnim.getDrawData(),
      rightDraw: this.rightAnim.getDrawData(),
      screenShake: this.shakeOffset,
      leftHp: {
        current: this.leftHpBar.displayed, max: hud.leftMax, name: this.leftUnit.name,
        weapon: leftItem?.name ?? '', hit: hud.leftHit, damage: hud.leftDamage, crit: hud.leftCrit,
      },
      rightHp: {
        current: this.rightHpBar.displayed, max: hud.rightMax, name: this.rightUnit.name,
        weapon: rightItem?.name ?? '', hit: hud.rightHit, damage: hud.rightDamage, crit: hud.rightCrit,
      },
      panOffset: this.panOffset,
      isAtRange: this.atRange > 0,
      nameOffset: this.nameOffset,
      barOffset: this.barOffset,
      platformOffset: this.platformOffset,
      procCue: this.activeProcCue,
    };
  }

  // ================================================================
  // Drawing (AnimationCombat.draw / MockCombat.draw_ui)
  // ================================================================

  /** The map fuzz (75% black outside the viewbox) CombatState draws first. */
  drawViewboxFuzz(surf: Surface): void {
    if (!this.viewbox) return;
    const [x, y, w, h] = this.viewbox;
    const color = 'rgba(0,0,0,0.75)';
    if (w <= 0) {
      surf.fillRect(0, 0, WINWIDTH, WINHEIGHT, color);
      return;
    }
    if (y > 0) surf.fillRect(0, 0, WINWIDTH, y, color);
    if (y + h < WINHEIGHT) surf.fillRect(0, y + h, WINWIDTH, WINHEIGHT - y - h, color);
    if (x > 0) surf.fillRect(0, y, x, h, color);
    if (x + w < WINWIDTH) surf.fillRect(x + w, y, WINWIDTH - x - w, h, color);
  }

  /** Whether anything of the battle scene is drawn this frame. */
  get sceneVisible(): boolean {
    return this.state !== 'init' && this.state !== 'red_cursor' && this.state !== 'done';
  }

  draw(surf: Surface): void {
    if (this.state === 'done') return;
    this.drawViewboxFuzz(surf);
    if (this.battleBackground) {
      surf.drawImageFull(this.battleBackground, 0, 0,
        this.battleBackground.naturalWidth || WINWIDTH, this.battleBackground.naturalHeight || WINHEIGHT);
    }
    const [leftRange, rightRange, totalShakeX, totalShakeY] = this.drawUi(surf);
    const shake: [number, number] = [-totalShakeX, totalShakeY];

    // Actor drawn last (second); before any strike, [left, right].
    const actor = this.currentBattleAnim;
    const order: Array<[BattleAnimation, number]> = actor === this.leftAnim
      ? [[this.rightAnim, rightRange], [this.leftAnim, leftRange]]
      : [[this.leftAnim, leftRange], [this.rightAnim, rightRange]];
    const [first, second] = order;
    first[0].drawUnder(surf, shake, first[1], this.panOffset);
    second[0].drawUnder(surf, shake, second[1], this.panOffset);
    first[0].draw(surf, shake, first[1], this.panOffset);
    second[0].draw(surf, shake, second[1], this.panOffset);
    second[0].drawOver(surf, shake, second[1], this.panOffset);
    first[0].drawOver(surf, shake, first[1], this.panOffset);
    this.drawMissingAnimFallback(surf, this.leftAnim, this.leftUnit, false, totalShakeY);
    this.drawMissingAnimFallback(surf, this.rightAnim, this.rightUnit, true, totalShakeY);

    // Animations (sparks, miss, no damage)
    this.animations = this.animations.filter((anim) => !anim.update());
    for (const anim of this.animations) anim.draw(surf);

    this.drawDamageNumbers(surf, leftRange, rightRange, totalShakeX);

    // UI fades in/out only during the slide states; otherwise it is shown.
    const fadeStates = ['name_tags_out', 'all_out', 'entrance', 'fade_in', 'red_cursor', 'init', 'fade_out'];
    if (!fadeStates.includes(this.state)) {
      this.nameOffset = 1;
      this.barOffset = 1;
    }
    this.drawCombatUi(surf);

    // Foreground screen flash (always additive)
    if (this.foregroundColor || this.foregroundFadeFrames) {
      if (this.foregroundColor) {
        let alpha = 1;
        if (this.foregroundFadeOut) alpha = 1 - this.foregroundFrames / this.foregroundFadeFrames;
        // make_translucent_blend(color, alpha*255) darkens the added color.
        fillScreen(surf, this.foregroundColor, 'add', Math.max(0, Math.min(1, 1 - alpha)));
      }
      this.foregroundFrames--;
      if (this.foregroundFrames <= 0) {
        if (this.foregroundFadeFrames && !this.foregroundFadeOut) {
          this.foregroundFrames = this.foregroundFadeFrames;
          this.foregroundFadeOut = true;
        } else {
          this.foregroundFadeFrames = 0;
          this.foregroundFrames = 0;
          this.foregroundColor = null;
          this.foregroundFadeOut = false;
        }
      }
    }
  }

  /**
   * Web-only: when a spritesheet failed to load, stand the unit's real
   * (team-paletted) map sprite on its platform instead of drawing nothing.
   * Python never reaches this: a missing resource selects map combat.
   */
  private drawMissingAnimFallback(surf: Surface, anim: BattleAnimation, unit: UnitObject, right: boolean, shakeY: number): void {
    if (anim.state === 'inert' || anim.frameImages.size > 0 || this.platformOffset <= 0) return;
    const frame = (unit.sprite as any)?.getCurrentFrame?.();
    if (!(frame instanceof Surface)) return;
    const platformW = this.atRange ? 100 : 87;
    const top = WINHEIGHT - 72 + (WINHEIGHT - 72) * (1 - this.platformOffset) + shakeY;
    const half = Math.floor(WINWIDTH / 2);
    const platformX = right
      ? half + (this.atRange ? 11 + this.panConfig.max + this.panOffset : 0)
      : half - platformW - (this.atRange ? 11 + this.panConfig.max - this.panOffset : 0);
    const previous = frame.getAlpha();
    frame.setAlpha(Math.max(0, Math.min(255, anim.opacity)) / 255);
    surf.blit(frame, platformX + Math.floor((platformW - frame.width) / 2), top - frame.height + 8);
    frame.setAlpha(previous);
  }

  /** MockCombat.draw_ui: dark overlay, pan, platforms; returns offsets. */
  private drawUi(surf: Surface): [number, number, number, number] {
    const platformTrans = WINHEIGHT - 72;
    const platformTop = WINHEIGHT - 72;
    if (this.darkenBackground || this.targetDark) {
      surf.fillRect(0, 0, WINWIDTH, WINHEIGHT, `rgba(0,0,0,${Math.max(0, Math.min(1, this.darkenBackground))})`);
      if (this.targetDark > this.darkenBackground) this.darkenBackground += 0.125;
      else if (this.targetDark < this.darkenBackground) this.darkenBackground -= 0.125;
    }
    if (this.panDir !== 0) {
      this.panOffset += this.panDir;
      if (this.panOffset > this.panConfig.max) {
        this.panOffset = this.panConfig.max;
        this.panDir = 0;
      } else if (this.panOffset < -this.panConfig.max) {
        this.panOffset = -this.panConfig.max;
        this.panDir = 0;
      }
    }
    const totalShakeX = this.shakeOffset[0] + this.platformShakeOffset[0];
    const totalShakeY = this.shakeOffset[1] + this.platformShakeOffset[1];
    const showPlatforms = !this.battleBackground || !!this.db?.getConstant?.('battle_platforms', false);
    if (showPlatforms && this.leftPlatform && this.rightPlatform) {
      const top = platformTop + (platformTrans - this.platformOffset * platformTrans) + totalShakeY;
      const lw = this.leftPlatform.naturalWidth || this.leftPlatform.width;
      const lh = this.leftPlatform.naturalHeight || this.leftPlatform.height;
      const rw = this.rightPlatform.naturalWidth || this.rightPlatform.width;
      const rh = this.rightPlatform.naturalHeight || this.rightPlatform.height;
      const half = Math.floor(WINWIDTH / 2);
      if (this.atRange) {
        surf.drawImageFull(this.leftPlatform, half - lw - 11 - this.panConfig.max + totalShakeX + this.panOffset, top, lw, lh);
        surf.drawImageFull(this.rightPlatform, half + 11 + this.panConfig.max + totalShakeX + this.panOffset, top, rw, rh, 1, true);
      } else {
        surf.drawImageFull(this.leftPlatform, half - lw + totalShakeX, top, lw, lh);
        surf.drawImageFull(this.rightPlatform, half + totalShakeX, top, rw, rh, 1, true);
      }
    }
    const rightRange = this.atRange ? 24 + this.panConfig.max : 0;
    const leftRange = this.atRange ? -24 - this.panConfig.max : 0;
    return [leftRange, rightRange, totalShakeX, totalShakeY];
  }

  /** gui.DamageNumber (big variant) per MockCombat.draw_damage_numbers. */
  private drawDamageNumbers(surf: Surface, leftRange: number, rightRange: number, totalShakeX: number): void {
    const now = fxNow();
    this.damageNumbers = this.damageNumbers.filter((num) => now - num.start <= 1200);
    for (const num of this.damageNumbers) {
      const sheet = getCombatSprite(num.sheet);
      if (!sheet) continue;
      const elapsed = now - num.start;
      const initTime = 50 * num.idx + 50;
      if (elapsed <= initTime) continue;
      const stateTime = elapsed - initTime;
      let top = 0;
      let alpha = 1;
      if (stateTime <= 400) {
        top = 10 * Math.exp(-stateTime / 250) * Math.sin(stateTime / 25);
        alpha = 1 - Math.max(0, Math.min(1, (200 - stateTime) / 200));
      } else if (elapsed > initTime + 1000) {
        const fade = elapsed - initTime - 1000;
        top = fade / 10;
        alpha = 1 - Math.max(0, Math.min(1, fade / 150));
      }
      const x = num.left
        ? WINWIDTH / 2 - 26 + leftRange - totalShakeX + this.panOffset
        : WINWIDTH / 2 + 26 + rightRange - totalShakeX + this.panOffset;
      const digit = new OffscreenCanvas(16, 16);
      digit.getContext('2d')!.drawImage(sheet.canvas, num.digit * 16, 0, 16, 16, 0, 0, 16, 16);
      drawCanvas(surf, digit, x - 7 * num.length + 14 * num.idx, WINHEIGHT - 120 - top, 16, 16, 'normal', alpha);
    }
  }

  /** Name tags and HP/stat bars (initial_paint_setup + the draw tail). */
  private drawCombatUi(surf: Surface): void {
    const crit = this.db?.getConstant?.('crit', true) !== false;
    const ui = new Surface(WINWIDTH, WINHEIGHT);
    const leftColor = this.teamColor(this.leftUnit);
    const rightColor = this.teamColor(this.rightUnit);
    const leftItem = this.leftIsAttacker ? this.attackItem : this.defenseItem;
    const rightItem = this.leftIsAttacker ? this.defenseItem : this.attackItem;
    const hud = this.getHudStats();
    const shake = this.shakeOffset;
    const pick = (base: string, color: string) => getCombatSprite(`${base}_${color}`) ?? getCombatSprite(`${base}_blue`);

    const textFont = (text: string, limit: number) =>
      (FONT['text'] && FONT['text'].width(text) > limit ? FONT['narrow'] : FONT['text']) ?? FONT['text'];

    // Bars
    const barBase = crit ? 'combat_main_crit' : 'combat_main';
    const leftBarSprite = pick(`${barBase}_left`, leftColor);
    const rightBarSprite = pick(`${barBase}_right`, rightColor);
    const critY = crit ? 7 : 0;
    const drawBar = (
      sprite: Surface | null, item: ItemObject | null, other: ItemObject | null,
      unit: UnitObject, target: UnitObject, bar: CombatHpBar, max: number,
      nameX: number, hpX: number, itemX: number, statsRight: number,
      stats: [number | null, number | null, number | null],
    ): Surface | null => {
      if (!sprite) return null;
      const surfBar = sprite.copy();
      if (item) {
        const font = textFont(item.name, 56);
        font?.blitCenter(surfBar, item.name, nameX, 5 + (crit ? 8 : 0), 'brown');
      }
      this.drawCombatHpBar(surfBar, bar, max, hpX, 30 + critY);
      if (item) {
        drawItemIcon(surfBar, item as any, itemX + 2, 2 + critY + 4);
        if (checkEnemy(unit, target, this.db, this.game)) {
          const arrows = getCombatSprite('arrow_advantage');
          const triangle = weaponTriangle(item, other, this.db, unit, target);
          const sign = Math.sign(triangle.hitBonus || triangle.damageBonus);
          if (arrows && sign !== 0) {
            const frame = Math.floor(getFrameCount() / 8) % 3;
            surfBar.blitFrom(arrows, frame * 7, sign > 0 ? 0 : 10, 7, 10, itemX + 11, 2 + critY + 8);
          }
        }
      }
      const small = FONT['number_small2'];
      if (small) {
        const fmt = (value: number | null, clamp: boolean) =>
          value === null ? '--' : String(clamp ? Math.max(0, Math.min(100, value)) : value);
        small.blitRight(surfBar, fmt(stats[0], true), statsRight, 0);
        small.blitRight(surfBar, fmt(stats[1], false), statsRight, 8);
        if (crit) small.blitRight(surfBar, fmt(stats[2], true), statsRight, 16);
      }
      return surfBar;
    };
    const leftBar = drawBar(leftBarSprite, leftItem, rightItem, this.leftUnit, this.rightUnit,
      this.leftHpBar, hud.leftMax, Math.floor(WINWIDTH / 4) + 31, 27, 45, 42,
      [hud.leftHit, hud.leftDamage, hud.leftCrit]);
    const rightBar = drawBar(rightBarSprite, rightItem, leftItem, this.rightUnit, this.leftUnit,
      this.rightHpBar, hud.rightMax, Math.floor(WINWIDTH / 4) - 13, 25, 1, Math.floor(WINWIDTH / 2) - 3,
      [hud.rightHit, hud.rightDamage, hud.rightCrit]);

    const barTrans = 52;
    const leftX = -3 + shake[0];
    if (leftBar) {
      const y = WINHEIGHT - leftBar.height + (barTrans - this.barOffset * barTrans) + shake[1];
      ui.blit(leftBar, leftX, y);
      if (rightBar) ui.blit(rightBar, Math.floor(WINWIDTH / 2) + shake[0], y);
    }

    // Name tags
    const top = -60 + this.nameOffset * 60 + shake[1];
    const leftName = pick('combat_name_left', leftColor);
    if (leftName) {
      const tag = leftName.copy();
      textFont(this.leftUnit.name, 52)?.blitCenter(tag, this.leftUnit.name, 30, 8, 'brown');
      ui.blit(tag, leftX, top);
    }
    const rightName = pick('combat_name_right', rightColor);
    if (rightName) {
      const tag = rightName.copy();
      textFont(this.rightUnit.name, 52)?.blitCenter(tag, this.rightUnit.name, 36, 8, 'brown');
      ui.blit(tag, WINWIDTH + 3 - tag.width + shake[0], top);
    }

    // color_ui: darken the UI during the level-up screen
    if (this.darkenUiBackground) {
      this.darkenUiBackground = Math.min(this.darkenUiBackground, 4);
      const c = 255 - Math.abs(this.darkenUiBackground * 24);
      const image = ui.getImageData();
      const d = image.data;
      for (let i = 0; i < d.length; i += 4) {
        d[i] = Math.trunc(d[i] * c / 255);
        d[i + 1] = Math.trunc(d[i + 1] * c / 255);
        d[i + 2] = Math.trunc(d[i + 2] * c / 255);
      }
      ui.putImageData(image);
      this.darkenUiBackground++;
    }
    surf.blit(ui, 0, 0);
  }

  /** CombatHealthBar.draw: the HP number and a row of blips. */
  private drawCombatHpBar(surf: Surface, bar: CombatHpBar, maxHp: number, left: number, top: number): void {
    const font = bar.bigNumber ? FONT['number_big2'] : FONT['number_small2'];
    font?.blitRight(surf, bar.displayed <= 240 ? String(bar.displayed) : '??', left, top - 4);
    const full = getCombatSprite('full_hp_blip');
    const empty = getCombatSprite('empty_hp_blip');
    if (!full || !empty) return;
    const tick = HP_BAR_COLORS[Math.floor(fxNow() / 16.67) % HP_BAR_COLORS.length];
    const row = (rowMax: number, rowHp: number, x: number, y: number) => {
      for (let i = 0; i < rowMax; i++) {
        if (i < rowHp) surf.blitFrom(full, tick * 2, 0, 2, full.height, x + i * 2, y);
        else surf.blit(empty, x + i * 2, y);
      }
      if (rowMax === rowHp) surf.blitFrom(full, tick * 2, 0, 1, full.height, x + rowMax * 2, y);
      else surf.blitFrom(empty, 0, 0, 1, empty.height, x + rowMax * 2, y);
    };
    const hp = Math.max(0, bar.displayed);
    if (maxHp <= MAX_HP_PER_BAR) {
      row(maxHp, hp, left + 5, top + 1);
    } else {
      const capped = Math.min(maxHp, 2 * MAX_HP_PER_BAR);
      const current = hp > 2 * MAX_HP_PER_BAR ? hp % (2 * MAX_HP_PER_BAR) : hp;
      row(Math.min(capped, MAX_HP_PER_BAR), Math.min(current, MAX_HP_PER_BAR), left + 5, top - 4 + full.height);
      row(Math.max(capped - MAX_HP_PER_BAR, 0), Math.max(current - MAX_HP_PER_BAR, 0), left + 5, top - 4);
    }
  }

  // ================================================================
  // Internal helpers
  // ================================================================

  /** Determine if a unit corresponds to the left-side animation. */
  private isLeftUnit(unit: UnitObject): boolean {
    if (this.leftIsAttacker) return unit === this.attacker;
    return unit === this.defender;
  }
}
