import type { UnitObject } from '../objects/unit';
import type { ItemObject } from '../objects/item';
import type { CombatStrike } from './combat-solver';
import { CombatPhaseSolver, type RngMode } from './combat-solver';
import type { CombatResults, DamagePopup } from './map-combat';
import { BattleAnimation, type BattleAnimDrawData } from './battle-animation';


// ============================================================
// AnimationCombat — Full GBA-style battle scene controller.
// Coordinates two BattleAnimation instances through a multi-phase
// state machine, managing screen effects, HP bars, damage popups,
// and camera pans.
// ============================================================

// -- Screen shake patterns ---------------------------------------------------

const SHAKE_PATTERNS: Record<number, [number, number][]> = {
  1: [[3,3],[0,0],[0,0],[-3,-3],[0,0],[0,0],[3,3],[0,0],[-3,-3],[0,0],[3,3],[0,0],[-3,-3],[3,3],[0,0]],
  2: [[1,1],[1,1],[1,1],[-1,-1],[-1,-1],[-1,-1],[0,0]],
  3: [[3,3],[-3,-3],[3,3],[-3,3],[3,-3],[-3,-3],[3,3],[-3,3],[3,-3],[0,0],[3,3],[-3,-3],[3,3],[-3,3],[3,-3],[-3,-3],[3,3],[-3,3],[3,-3],[0,0],[0,0]],
  4: [[-6,6],[6,-6],[-5,5],[5,-5],[-4,4],[4,-4],[-3,3],[3,-3],[-2,2],[2,-2],[-1,1],[1,-1],[-1,1],[1,-1],[0,0],[0,0],[-5,5],[5,-5],[-4,4],[4,-4],[-3,3],[3,-3],[-2,2],[2,-2],[-1,1],[1,-1],[-1,1],[1,-1],[0,0],[0,0],[-3,3],[3,-3],[-2,2],[2,-2],[-1,1],[1,-1],[0,0],[0,0]],
};

const PLATFORM_SHAKE: [number, number][] = [[0,1],[0,0],[0,-1],[0,0],[0,1],[0,0],[-1,-1],[0,1],[0,0]];

// -- Duration constants ------------------------------------------------------

const FADE_DURATION_MS = 250;
const ENTRANCE_FRAMES = 14;
const INIT_PAUSE_FRAMES = 25;
const HP_DRAIN_MIN_FRAMES = 10;
const HP_DRAIN_MAX_FRAMES = 40;
const FADE_OUT_DURATION_MS = 250;

// -- Pan config per range ----------------------------------------------------

interface PanConfig {
  max: number;
  speed: number;
}

function getPanConfig(range: number): PanConfig {
  if (range <= 0) return { max: 0, speed: 0 };
  if (range === 1) return { max: 16, speed: 4 };
  if (range === 2) return { max: 32, speed: 8 };
  return { max: 120, speed: 25 };
}

// Re-export for consumers that imported from this file
export type { BattleAnimDrawData } from './battle-animation';
export { BattleAnimation } from './battle-animation';

/** Callback interface that BattleAnimation expects on its owner. */
export interface AnimationCombatOwner {
  startHit(anim: BattleAnimation): void;
  handleMiss(anim: BattleAnimation): void;
  spellHit(anim: BattleAnimation): void;
  castSpell(anim: BattleAnimation, effectNid: string | null): void;
  shake(intensity: number): void;
  platformShake(): void;
  pan(): void;
  playSound(name: string): void;
  showHitSpark(anim: BattleAnimation): void;
  showCritSpark(anim: BattleAnimation): void;
  screenBlend(frames: number, color: [number, number, number]): void;
  darken(): void;
  lighten(): void;
  endParentLoop(anim: BattleAnimation): void;
  spawnEffect(anim: BattleAnimation, effectNid: string, under: boolean): void;
}

// -- Render state interface --------------------------------------------------

export interface AnimationCombatRenderState {
  state: string;

  /** Viewbox iris rectangle (null when not active). */
  viewbox: { x: number; y: number; width: number; height: number } | null;

  /** Background dim level 0-1. */
  backgroundDim: number;

  /** Platform Y positions (animated). */
  leftPlatformY: number;
  rightPlatformY: number;
  platformShakeY: number;

  /** Battle sprite draw data. */
  leftDraw: BattleAnimDrawData;
  rightDraw: BattleAnimDrawData;

  /** Whole-screen shake pixel offset. */
  screenShake: [number, number];
  /** Full-screen color blend (null when inactive). */
  screenBlend: { color: [number, number, number]; alpha: number } | null;

  /** HP bar data per side. */
  leftHp: { current: number; max: number; name: string; weapon: string };
  rightHp: { current: number; max: number; name: string; weapon: string };

  /** Active damage popups. */
  damagePopups: DamagePopup[];

  /** Camera pan offset for ranged combat. */
  panOffset: number;

  /** Name tag slide progress 0 (hidden) to 1 (visible). */
  nameTagProgress: number;
  /** HP bar slide progress 0 (hidden) to 1 (visible). */
  hpBarProgress: number;
}

// -- State type --------------------------------------------------------------

type AnimCombatState =
  | 'init' | 'fade_in' | 'entrance' | 'init_pause'
  | 'begin_phase' | 'anim' | 'combat_hit' | 'hp_change' | 'end_phase'
  | 'end_combat' | 'exp_wait' | 'fade_out' | 'done';

// ============================================================
// AnimationCombat
// ============================================================

export class AnimationCombat implements AnimationCombatOwner {
  // -- Public references -----------------------------------------------------
  attacker: UnitObject;
  defender: UnitObject;

  // -- Constructor-assigned fields -------------------------------------------
  attackItem: ItemObject;
  defenseItem: ItemObject | null;
  db: any; // Database
  leftAnim: BattleAnimation;
  rightAnim: BattleAnimation;
  leftIsAttacker: boolean;

  // -- Solver / strikes ------------------------------------------------------
  strikes: CombatStrike[];
  currentStrikeIndex: number = 0;

  // -- State machine ---------------------------------------------------------
  state: AnimCombatState = 'init';
  stateTimer: number = 0;
  stateFrameCount: number = 0;

  // -- HP tracking -----------------------------------------------------------
  leftDisplayHp: number = 0;
  rightDisplayHp: number = 0;
  leftTargetHp: number = 0;
  rightTargetHp: number = 0;
  hpDrainStartLeft: number = 0;
  hpDrainStartRight: number = 0;
  hpDrainFrames: number = 0;
  hpDrainElapsedFrames: number = 0;
  attackerStartHp: number = 0;
  defenderStartHp: number = 0;

  // -- Screen shake ----------------------------------------------------------
  shakePattern: [number, number][] = [];
  shakeIndex: number = 0;
  platformShakePattern: [number, number][] = [];
  platformShakeIndex: number = 0;

  // -- Camera pan ------------------------------------------------------------
  panOffset: number = 0;
  panTarget: number = 0;
  panConfig: PanConfig = { max: 0, speed: 0 };
  panFocusLeft: boolean = true;

  // -- Screen blend ----------------------------------------------------------
  blendColor: [number, number, number] = [0, 0, 0];
  blendFramesTotal: number = 0;
  blendFramesRemaining: number = 0;

  // -- Background dim --------------------------------------------------------
  backgroundDim: number = 0;

  // -- Entrance / UI slide ---------------------------------------------------
  entranceProgress: number = 0;
  nameTagProgress: number = 0;
  hpBarProgress: number = 0;
  leftPlatformY: number = 80;
  rightPlatformY: number = 80;

  // -- Viewbox iris ----------------------------------------------------------
  viewboxCenterX: number = 120;
  viewboxCenterY: number = 80;

  // -- Damage popups ---------------------------------------------------------
  damagePopups: DamagePopup[] = [];

  // -- Current strike tracking -----------------------------------------------
  currentStrikeAttackerAnim: BattleAnimation | null = null;
  currentStrikeDefenderAnim: BattleAnimation | null = null;
  awaitingHit: boolean = false;

  // -- Results cache ---------------------------------------------------------
  cachedResults: CombatResults | null = null;

  // -- Combat range ----------------------------------------------------------
  combatRange: number = 1;

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
  ) {
    this.attacker = attacker;
    this.defender = defender;
    this.attackItem = attackItem;
    this.defenseItem = defenseItem;
    this.db = db;
    this.leftAnim = leftAnim;
    this.rightAnim = rightAnim;
    this.leftIsAttacker = leftIsAttacker;

    // Wire up animation owner/partner references and set side/range.
    // pair() sets: owner, partner, right, atRange, entranceFrames, initPosition.
    // Left combatant: right=false (sprite x-offsets mirrored).
    // Right combatant: right=true (sprite x-offsets used as-authored).
    const aPos = attacker.position;
    const dPos = defender.position;
    const range = (aPos && dPos)
      ? Math.abs(aPos[0] - dPos[0]) + Math.abs(aPos[1] - dPos[1])
      : 1;
    this.leftAnim.pair(this, this.rightAnim, false, range, ENTRANCE_FRAMES, [0, 0]);
    this.rightAnim.pair(this, this.leftAnim, true, range, ENTRANCE_FRAMES, [0, 0]);
    this.leftAnim.isLeft = true;
    this.rightAnim.isLeft = false;

    // Set initial standing pose so sprites are visible during entrance
    const standPose = range > 1 ? 'RangedStand' : 'Stand';
    this.leftAnim.setPose(standPose);
    this.rightAnim.setPose(standPose);

    // Solve strikes
    const solver = new CombatPhaseSolver();
    this.strikes = solver.resolve(attacker, attackItem, defender, defenseItem, db, rngMode as RngMode);

    // HP init
    const leftUnit = leftIsAttacker ? attacker : defender;
    const rightUnit = leftIsAttacker ? defender : attacker;
    this.leftDisplayHp = leftUnit.currentHp;
    this.rightDisplayHp = rightUnit.currentHp;
    this.leftTargetHp = leftUnit.currentHp;
    this.rightTargetHp = rightUnit.currentHp;
    this.attackerStartHp = attacker.currentHp;
    this.defenderStartHp = defender.currentHp;

    // Combat range (reuse range computed above for pair())
    this.combatRange = range;
    this.panConfig = getPanConfig(this.combatRange);

    // Viewbox center on defender
    if (dPos) {
      this.viewboxCenterX = dPos[0] * 16 + 8;
      this.viewboxCenterY = dPos[1] * 16 + 8;
    }
  }

  // ================================================================
  // Main update
  // ================================================================

  update(deltaMs: number): boolean {
    // Advance frame-based timers
    this.stateTimer += deltaMs;

    // Update screen shake
    this.advanceShake();
    this.advancePlatformShake();
    this.advanceBlend();

    // Update damage popups
    for (const p of this.damagePopups) {
      p.elapsed += deltaMs;
    }
    this.damagePopups = this.damagePopups.filter(p => p.elapsed < p.duration);

    // Advance pan
    this.advancePan();

    switch (this.state) {
      case 'init':        return this.updateInit();
      case 'fade_in':     return this.updateFadeIn();
      case 'entrance':    return this.updateEntrance();
      case 'init_pause':  return this.updateInitPause();
      case 'begin_phase': return this.updateBeginPhase();
      case 'anim':        return this.updateAnim();
      case 'combat_hit':  return this.updateCombatHit();
      case 'hp_change':   return this.updateHpChange();
      case 'end_phase':   return this.updateEndPhase();
      case 'end_combat':  return this.updateEndCombat();
      case 'exp_wait':    return this.updateExpWait();
      case 'fade_out':    return this.updateFadeOut();
      case 'done':        return true;
    }
  }

  // ================================================================
  // State updates
  // ================================================================

  private updateInit(): boolean {
    // One-frame setup
    this.transition('fade_in');
    return false;
  }

  private updateFadeIn(): boolean {
    const progress = Math.min(1, this.stateTimer / FADE_DURATION_MS);
    // Background dims as iris closes
    this.backgroundDim = progress;
    if (progress >= 1) {
      this.backgroundDim = 1;
      this.transition('entrance');
    }
    return false;
  }

  private updateEntrance(): boolean {
    this.stateFrameCount++;
    const t = Math.min(1, this.stateFrameCount / ENTRANCE_FRAMES);
    this.entranceProgress = t;

    // Platforms slide up from below screen to resting position (offset 0)
    // Start offset is enough to push platforms off the bottom of the 160px screen
    this.leftPlatformY = lerp(80, 0, easeOutQuad(t));
    this.rightPlatformY = lerp(80, 0, easeOutQuad(t));

    // Name tags and HP bars slide in
    this.nameTagProgress = t;
    this.hpBarProgress = Math.min(1, Math.max(0, (t - 0.3) / 0.7));

    // Update both anims each frame
    this.leftAnim.update();
    this.rightAnim.update();

    if (this.stateFrameCount >= ENTRANCE_FRAMES) {
      this.nameTagProgress = 1;
      this.hpBarProgress = 1;
      this.transition('init_pause');
    }
    return false;
  }

  private updateInitPause(): boolean {
    this.stateFrameCount++;
    this.leftAnim.update();
    this.rightAnim.update();
    if (this.stateFrameCount >= INIT_PAUSE_FRAMES) {
      this.transition('begin_phase');
    }
    return false;
  }

  private updateBeginPhase(): boolean {
    if (this.currentStrikeIndex >= this.strikes.length) {
      this.transition('end_combat');
      return false;
    }

    const strike = this.strikes[this.currentStrikeIndex];
    const isLeftAttacking = this.isLeftUnit(strike.attacker);
    const atkAnim = isLeftAttacking ? this.leftAnim : this.rightAnim;
    const defAnim = isLeftAttacking ? this.rightAnim : this.leftAnim;

    this.currentStrikeAttackerAnim = atkAnim;
    this.currentStrikeDefenderAnim = defAnim;
    this.awaitingHit = true;

    // Set attacker pose
    const pose = strike.crit ? 'Critical' : 'Attack';
    atkAnim.setPose(pose);

    // Set defender to standing pose (ranged or melee)
    const defPose = this.combatRange > 1 ? 'RangedStand' : 'Stand';
    defAnim.setPose(defPose);

    this.transition('anim');
    return false;
  }

  private updateAnim(): boolean {
    this.leftAnim.update();
    this.rightAnim.update();

    // The hit is processed via the startHit callback when the animation
    // fires the start_hit command. Once both anims return to idle/done,
    // proceed to end_phase.
    if (!this.awaitingHit && this.currentStrikeAttackerAnim) {
      const atkDone = this.currentStrikeAttackerAnim.isIdle() || this.currentStrikeAttackerAnim.isDone();
      const defDone = this.currentStrikeDefenderAnim!.isIdle() || this.currentStrikeDefenderAnim!.isDone();
      if (atkDone && defDone) {
        this.transition('end_phase');
      }
    }
    return false;
  }

  private updateCombatHit(): boolean {
    // One-frame state: the actual hit processing happens in startHit()
    // which transitions us here. Now set up HP drain and go to hp_change.
    this.hpDrainElapsedFrames = 0;
    this.transition('hp_change');
    return false;
  }

  private updateHpChange(): boolean {
    this.hpDrainElapsedFrames++;

    // Animate HP bars
    const t = Math.min(1, this.hpDrainElapsedFrames / Math.max(1, this.hpDrainFrames));
    this.leftDisplayHp = lerp(this.hpDrainStartLeft, this.leftTargetHp, t);
    this.rightDisplayHp = lerp(this.hpDrainStartRight, this.rightTargetHp, t);

    // Check for death
    if (t >= 0.5) {
      if (this.leftTargetHp <= 0) {
        this.leftAnim.startDeath();
      }
      if (this.rightTargetHp <= 0) {
        this.rightAnim.startDeath();
      }
    }

    this.leftAnim.update();
    this.rightAnim.update();

    if (t >= 1) {
      // Snap HP
      this.leftDisplayHp = this.leftTargetHp;
      this.rightDisplayHp = this.rightTargetHp;

      // Resume attacker animation
      if (this.currentStrikeAttackerAnim) {
        this.currentStrikeAttackerAnim.resume();
      }
      this.awaitingHit = false;

      // Return to anim state so the attacker can finish its animation
      this.transition('anim');
    }
    return false;
  }

  private updateEndPhase(): boolean {
    // Advance to next strike
    this.currentStrikeIndex++;
    this.currentStrikeAttackerAnim = null;
    this.currentStrikeDefenderAnim = null;

    // If someone died, skip to end_combat
    if (this.leftTargetHp <= 0 || this.rightTargetHp <= 0) {
      this.transition('end_combat');
    } else {
      this.transition('begin_phase');
    }
    return false;
  }

  private updateEndCombat(): boolean {
    // Set both anims to Stand
    this.leftAnim.setPose('Stand');
    this.rightAnim.setPose('Stand');
    this.leftAnim.update();
    this.rightAnim.update();

    // Wait for both to settle
    const leftIdle = this.leftAnim.isIdle() || this.leftAnim.isDone();
    const rightIdle = this.rightAnim.isIdle() || this.rightAnim.isDone();
    if (leftIdle && rightIdle) {
      this.transition('exp_wait');
    }
    return false;
  }

  private updateExpWait(): boolean {
    // Cache results
    this.cachedResults = this.computeResults();
    this.transition('fade_out');
    return false;
  }

  private updateFadeOut(): boolean {
    const progress = Math.min(1, this.stateTimer / FADE_OUT_DURATION_MS);
    // Iris expands back
    this.backgroundDim = 1 - progress;
    if (progress >= 1) {
      this.state = 'done';
      return true;
    }
    return false;
  }

  // ================================================================
  // State transition helper
  // ================================================================

  private transition(newState: AnimCombatState): void {
    this.state = newState;
    this.stateTimer = 0;
    this.stateFrameCount = 0;
  }

  // ================================================================
  // BattleAnimation owner callbacks
  // ================================================================

  startHit(anim: BattleAnimation): void {
    if (this.currentStrikeIndex >= this.strikes.length) return;
    const strike = this.strikes[this.currentStrikeIndex];

    // Record HP drain start values
    this.hpDrainStartLeft = this.leftTargetHp;
    this.hpDrainStartRight = this.rightTargetHp;

    const defAnim = (anim === this.leftAnim) ? this.rightAnim : this.leftAnim;
    const isLeftDefending = (defAnim === this.leftAnim);

    if (strike.hit) {
      // Apply damage to target HP
      if (isLeftDefending) {
        this.leftTargetHp = Math.max(0, this.leftTargetHp - strike.damage);
      } else {
        this.rightTargetHp = Math.max(0, this.rightTargetHp - strike.damage);
      }

      // Determine HP drain duration
      const hpChange = strike.damage;
      this.hpDrainFrames = Math.max(HP_DRAIN_MIN_FRAMES, Math.min(HP_DRAIN_MAX_FRAMES, hpChange));

      // Defender takes hit
      const damagedPose = this.combatRange > 1 ? 'RangedDamaged' : 'Damaged';
      defAnim.setPose(damagedPose);

      // Screen shake
      const shakeIntensity = strike.crit ? 4 : 1;
      this.shake(shakeIntensity);
      this.platformShake();

      // Recoil offset
      defAnim.lrOffset = [-1, -2, -3, -2, -1];

      // Spawn damage popup
      const defUnit = strike.defender;
      if (defUnit.position) {
        this.damagePopups.push({
          x: defUnit.position[0],
          y: defUnit.position[1],
          value: strike.damage,
          isCrit: strike.crit,
          elapsed: 0,
          duration: 600,
        });
      }
    } else {
      // Miss
      this.hpDrainFrames = HP_DRAIN_MIN_FRAMES;
      defAnim.setPose('Dodge');

      const defUnit = strike.defender;
      if (defUnit.position) {
        this.damagePopups.push({
          x: defUnit.position[0],
          y: defUnit.position[1],
          value: 0,
          isCrit: false,
          elapsed: 0,
          duration: 500,
        });
      }
    }

    // Transition to combat_hit so hp_change begins
    this.transition('combat_hit');
  }

  handleMiss(anim: BattleAnimation): void {
    const defAnim = (anim === this.leftAnim) ? this.rightAnim : this.leftAnim;
    defAnim.setPose('Dodge');
  }

  spellHit(anim: BattleAnimation): void {
    // Treat the same as startHit but with spell shake
    this.startHit(anim);
    // Override shake to spell type
    this.shakePattern = [...(SHAKE_PATTERNS[3] ?? [])];
    this.shakeIndex = 0;
  }

  castSpell(_anim: BattleAnimation, _effectNid: string | null): void {
    // Spell effect spawning is delegated to the renderer via getRenderState.
    // No-op here; the animation system handles the visual.
  }

  shake(intensity: number): void {
    const pattern = SHAKE_PATTERNS[intensity];
    if (pattern) {
      this.shakePattern = [...pattern];
      this.shakeIndex = 0;
    }
  }

  platformShake(): void {
    this.platformShakePattern = [...PLATFORM_SHAKE];
    this.platformShakeIndex = 0;
  }

  pan(): void {
    if (this.panConfig.max === 0) return;
    this.panFocusLeft = !this.panFocusLeft;
    this.panTarget = this.panFocusLeft ? -this.panConfig.max : this.panConfig.max;
  }

  playSound(_name: string): void {
    // Audio playback is handled externally. This is a hook point
    // for the game state that owns us to intercept via subclass or wrapper.
  }

  showHitSpark(_anim: BattleAnimation): void {
    // Visual effect handled by renderer using getRenderState.
  }

  showCritSpark(_anim: BattleAnimation): void {
    // Visual effect handled by renderer using getRenderState.
  }

  screenBlend(frames: number, color: [number, number, number]): void {
    this.blendColor = color;
    this.blendFramesTotal = frames;
    this.blendFramesRemaining = frames;
  }

  darken(): void {
    this.backgroundDim = Math.min(1, this.backgroundDim + 0.3);
  }

  lighten(): void {
    this.backgroundDim = Math.max(0, this.backgroundDim - 0.3);
  }

  endParentLoop(anim: BattleAnimation): void {
    // Break the animation's parent loop. Delegate directly to the anim.
    // This is called by child effect animations to signal their parent
    // should stop looping and proceed.
    anim.resume();
  }

  spawnEffect(_anim: BattleAnimation, _effectNid: string, _under: boolean): void {
    // Effect spawning is managed by the renderer layer.
  }

  // ================================================================
  // Results
  // ================================================================

  applyResults(): CombatResults {
    if (this.cachedResults) {
      return this.cachedResults;
    }
    return this.computeResults();
  }

  private computeResults(): CombatResults {
    let atkHp = this.attackerStartHp;
    let defHp = this.defenderStartHp;
    let attackerStrikeCount = 0;
    let defenderStrikeCount = 0;

    for (const strike of this.strikes) {
      if (strike.attacker === this.attacker) {
        attackerStrikeCount++;
      } else {
        defenderStrikeCount++;
      }
      if (!strike.hit) continue;
      if (strike.attacker === this.attacker) {
        defHp -= strike.damage;
      } else {
        atkHp -= strike.damage;
      }
    }

    atkHp = Math.max(0, atkHp);
    defHp = Math.max(0, defHp);

    this.attacker.currentHp = atkHp;
    this.defender.currentHp = defHp;

    const attackerDead = atkHp <= 0;
    const defenderDead = defHp <= 0;

    if (attackerDead) this.attacker.dead = true;
    if (defenderDead) this.defender.dead = true;

    // Weapon uses
    let attackWeaponBroke = false;
    let defenseWeaponBroke = false;

    if (attackerStrikeCount > 0 && this.attackItem.maxUses > 0) {
      attackWeaponBroke = this.attackItem.decrementUses();
      if (attackWeaponBroke) {
        const idx = this.attacker.items.indexOf(this.attackItem);
        if (idx !== -1) this.attacker.items.splice(idx, 1);
      }
    }

    if (defenderStrikeCount > 0 && this.defenseItem && this.defenseItem.maxUses > 0) {
      defenseWeaponBroke = this.defenseItem.decrementUses();
      if (defenseWeaponBroke) {
        const idx = this.defender.items.indexOf(this.defenseItem);
        if (idx !== -1) this.defender.items.splice(idx, 1);
      }
    }

    // EXP
    const expGained = this.calculateExp(attackerDead, defenderDead);

    let levelUps: Record<string, number>[] = [];
    const growthMode = (this.db.getConstant?.('growths_choice', 'random') as string) || 'random';

    if (!attackerDead && this.attacker.team === 'player' && expGained > 0) {
      this.attacker.exp += expGained;
      while (this.attacker.exp >= 100) {
        this.attacker.exp -= 100;
        const gains = this.attacker.levelUp(growthMode);
        levelUps.push(gains);
      }
    }

    let droppedItem: ItemObject | null = null;
    if (defenderDead && !attackerDead) {
      for (const item of this.defender.items) {
        if (item.droppable) {
          droppedItem = item;
          break;
        }
      }
    }

    return {
      attackerDead,
      defenderDead,
      expGained,
      levelUps,
      attackWeaponBroke,
      defenseWeaponBroke,
      droppedItem,
    };
  }

  private calculateExp(attackerDead: boolean, defenderDead: boolean): number {
    if (attackerDead) return 0;

    const BASE_EXP = 30;
    const KILL_BONUS = 50;
    const levelDiff = this.defender.level - this.attacker.level;
    const levelScale = Math.max(0.1, 1 + levelDiff * 0.1);

    let exp = Math.round(BASE_EXP * levelScale);
    if (defenderDead) {
      exp += Math.round(KILL_BONUS * levelScale);
    }
    return Math.max(1, Math.min(100, exp));
  }

  // ================================================================
  // Render state
  // ================================================================

  getRenderState(): AnimationCombatRenderState {
    const leftUnit = this.leftIsAttacker ? this.attacker : this.defender;
    const rightUnit = this.leftIsAttacker ? this.defender : this.attacker;
    const leftItem = this.leftIsAttacker ? this.attackItem : this.defenseItem;
    const rightItem = this.leftIsAttacker ? this.defenseItem : this.attackItem;

    // Viewbox iris
    let viewbox: AnimationCombatRenderState['viewbox'] = null;
    if (this.state === 'fade_in') {
      const progress = Math.min(1, this.stateTimer / FADE_DURATION_MS);
      const maxW = 240;
      const maxH = 160;
      const w = maxW * (1 - progress);
      const h = maxH * (1 - progress);
      viewbox = {
        x: this.viewboxCenterX - w / 2,
        y: this.viewboxCenterY - h / 2,
        width: w,
        height: h,
      };
    } else if (this.state === 'fade_out') {
      const progress = Math.min(1, this.stateTimer / FADE_OUT_DURATION_MS);
      const maxW = 240;
      const maxH = 160;
      const w = maxW * progress;
      const h = maxH * progress;
      viewbox = {
        x: this.viewboxCenterX - w / 2,
        y: this.viewboxCenterY - h / 2,
        width: w,
        height: h,
      };
    }

    // Screen shake
    const screenShake = this.getCurrentShake();

    // Platform shake
    const platformShakeY = this.getCurrentPlatformShake();

    // Screen blend
    let screenBlendData: AnimationCombatRenderState['screenBlend'] = null;
    if (this.blendFramesRemaining > 0 && this.blendFramesTotal > 0) {
      const alpha = this.blendFramesRemaining / this.blendFramesTotal;
      screenBlendData = { color: this.blendColor, alpha };
    }

    return {
      state: this.state,
      viewbox,
      backgroundDim: this.backgroundDim,
      leftPlatformY: this.leftPlatformY,
      rightPlatformY: this.rightPlatformY,
      platformShakeY,
      leftDraw: this.leftAnim.getDrawData(),
      rightDraw: this.rightAnim.getDrawData(),
      screenShake,
      screenBlend: screenBlendData,
      leftHp: {
        current: Math.max(0, Math.round(this.leftDisplayHp)),
        max: leftUnit.maxHp,
        name: leftUnit.name,
        weapon: leftItem?.name ?? '',
      },
      rightHp: {
        current: Math.max(0, Math.round(this.rightDisplayHp)),
        max: rightUnit.maxHp,
        name: rightUnit.name,
        weapon: rightItem?.name ?? '',
      },
      damagePopups: this.damagePopups,
      panOffset: this.panOffset,
      nameTagProgress: this.nameTagProgress,
      hpBarProgress: this.hpBarProgress,
    };
  }

  // ================================================================
  // Internal helpers
  // ================================================================

  /** Determine if a unit corresponds to the left-side animation. */
  private isLeftUnit(unit: UnitObject): boolean {
    if (this.leftIsAttacker) {
      return unit === this.attacker;
    }
    return unit === this.defender;
  }

  private advanceShake(): void {
    if (this.shakeIndex < this.shakePattern.length) {
      this.shakeIndex++;
    }
  }

  private getCurrentShake(): [number, number] {
    if (this.shakeIndex > 0 && this.shakeIndex <= this.shakePattern.length) {
      return this.shakePattern[this.shakeIndex - 1];
    }
    return [0, 0];
  }

  private advancePlatformShake(): void {
    if (this.platformShakeIndex < this.platformShakePattern.length) {
      this.platformShakeIndex++;
    }
  }

  private getCurrentPlatformShake(): number {
    if (this.platformShakeIndex > 0 && this.platformShakeIndex <= this.platformShakePattern.length) {
      return this.platformShakePattern[this.platformShakeIndex - 1][1];
    }
    return 0;
  }

  private advancePan(): void {
    if (this.panConfig.max === 0) return;
    if (this.panOffset < this.panTarget) {
      this.panOffset = Math.min(this.panTarget, this.panOffset + this.panConfig.speed);
    } else if (this.panOffset > this.panTarget) {
      this.panOffset = Math.max(this.panTarget, this.panOffset - this.panConfig.speed);
    }
  }

  private advanceBlend(): void {
    if (this.blendFramesRemaining > 0) {
      this.blendFramesRemaining--;
    }
  }
}

// ============================================================
// Utility
// ============================================================

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function easeOutQuad(t: number): number {
  return t * (2 - t);
}
