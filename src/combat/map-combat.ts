import type { UnitObject } from '../objects/unit';
import type { ItemObject } from '../objects/item';
import type { Database } from '../data/database';
import type { GameBoard } from '../objects/game-board';
import type { CombatStrike } from './combat-solver';
import { CombatPhaseSolver, type RngMode } from './combat-solver';
import { usesConsumedByStrikes } from './item-system';
import { applyGroupCombatComponents, type WeaponRankUp } from './combat-components';
import type { ActionLog } from '../engine/action';
import { CombatResultAction } from './combat-result-action';

// ============================================================
// MapCombat - Manages the visual presentation of combat on the
// map.  Shows health bar changes, hit/miss effects frame by
// frame.
// ============================================================

export type MapCombatState = 'init' | 'strike' | 'hp_change' | 'waiting' | 'cleanup' | 'done';

/** Detailed combat results returned by applyResults(). */
export interface CombatResults {
  attackerDead: boolean;
  defenderDead: boolean;
  expGained: number;
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
}

/** Duration constants (milliseconds) */
const INIT_DURATION_MS = 150;  // Pre-combat pause
const STRIKE_DURATION_MS = 130; // Lunge + strike animation
const HP_DRAIN_DURATION_MS = 250; // HP bar drain animation
const WAITING_DURATION_MS = 80;  // Pause between strikes
const CLEANUP_DURATION_MS = 180; // Pause before done

/** Animation sub-timings within STRIKE phase (ms) */
const LUNGE_DURATION_MS = 80;  // Attacker moves toward defender
const LUNGE_RETURN_MS = 50;    // Attacker snaps back

/** Shake animation during HP drain */
const SHAKE_FREQUENCY = 40;    // ms per oscillation
const SHAKE_AMPLITUDE = 2;     // pixels

/** Floating damage number */
export interface DamagePopup {
  x: number;         // tile x
  y: number;         // tile y
  value: number;     // damage amount (0 = miss)
  isCrit: boolean;
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
}

export class MapCombat {
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

  state: MapCombatState;
  currentStrikeIndex: number;
  frameTimer: number;

  // HP display state (for animated HP drain)
  attackerDisplayHp: number;
  defenderDisplayHp: number;

  // Internal targets for HP animation
  private attackerTargetHp: number;
  private hpDrainElapsed: number;
  private hpDrainStartAttacker: number;

  // Snapshot of real HP before combat (for result calculation)
  private attackerStartHp: number;

  // Reference to DB for exp calculation
  private db: Database;

  // Animation state for rendering
  attackerAnim: CombatAnimState;
  defenderAnim: CombatAnimState;
  defenderAnims: Map<UnitObject, CombatAnimState>;
  damagePopups: DamagePopup[];

  private defenderStartHps: Map<UnitObject, number>;
  private defenderTargetHps: Map<UnitObject, number>;
  private defenderDisplayHps: Map<UnitObject, number>;
  private defenderDrainStartHps: Map<UnitObject, number>;

  // Audio (optional, set after construction to enable combat SFX)
  audioManager: { playSfx(name: string): void } | null = null;
  private hitSoundPlayed: boolean = false;
  private cachedResults: CombatResults | null = null;

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

    // Solve the combat to get the strike sequence
    const solver = new CombatPhaseSolver();
    this.strikes = group
      ? solver.resolveGroup(
        attacker,
        attackItem,
        this.primaryDefender,
        this.defenseItem,
        this.splashDefenders,
        db,
        rngMode,
        board,
        script,
      )
      : solver.resolve(attacker, attackItem, defender, defenseItem, db, rngMode, board, script);

    this.state = 'init';
    this.currentStrikeIndex = 0;
    this.frameTimer = 0;

    // Initialise HP display from current unit state
    this.attackerDisplayHp = attacker.currentHp;
    this.defenderDisplayHp = defender.currentHp;
    this.attackerTargetHp = attacker.currentHp;
    this.hpDrainElapsed = 0;
    this.hpDrainStartAttacker = attacker.currentHp;

    this.attackerStartHp = attacker.currentHp;

    this.defenderStartHps = new Map(this.defenders.map((unit) => [unit, unit.currentHp]));
    this.defenderTargetHps = new Map(this.defenderStartHps);
    this.defenderDisplayHps = new Map(this.defenderStartHps);
    this.defenderDrainStartHps = new Map(this.defenderStartHps);

    // Animation state
    this.attackerAnim = { lungeOffset: [0, 0], shakeOffset: [0, 0], flashAlpha: 0 };
    this.defenderAnims = new Map(this.defenders.map((unit) => [unit, {
      lungeOffset: [0, 0] as [number, number],
      shakeOffset: [0, 0] as [number, number],
      flashAlpha: 0,
    }]));
    this.defenderAnim = this.defenderAnims.get(defender) ?? {
      lungeOffset: [0, 0], shakeOffset: [0, 0], flashAlpha: 0,
    };
    if (!this.defenderAnims.has(defender)) this.defenderAnims.set(defender, this.defenderAnim);
    this.damagePopups = [];
  }

  /** Instantly skip to the end of combat (no more animation). */
  skipToEnd(): void {
    this.state = 'done';
  }

  /**
   * Advance the combat by one frame.
   * Returns true when the combat is fully complete.
   */
  update(deltaMs: number): boolean {
    switch (this.state) {
      case 'init':
        return this.updateInit(deltaMs);
      case 'strike':
        return this.updateStrike(deltaMs);
      case 'hp_change':
        return this.updateHpChange(deltaMs);
      case 'waiting':
        return this.updateWaiting(deltaMs);
      case 'cleanup':
        return this.updateCleanup(deltaMs);
      case 'done':
        return true;
    }
  }

  /** Get the current combat state for rendering. */
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
    damagePopups: DamagePopup[];
  } {
    const strike =
      this.currentStrikeIndex < this.strikes.length
        ? this.strikes[this.currentStrikeIndex]
        : null;

    return {
      state: this.state,
      currentStrike: strike,
      attackerHp: Math.max(0, Math.round(this.attackerDisplayHp)),
      defenderHp: Math.max(0, Math.round(this.defenderDisplayHp)),
      attackerMaxHp: this.attacker.maxHp,
      defenderMaxHp: this.defender.maxHp,
      attackerAnim: this.attackerAnim,
      defenderAnim: this.defenderAnim,
      defenders: this.defenders.map((unit) => ({
        unit,
        hp: Math.max(0, Math.round(this.defenderDisplayHps.get(unit) ?? unit.currentHp)),
        maxHp: unit.maxHp,
        anim: this.defenderAnims.get(unit) ?? this.defenderAnim,
      })),
      damagePopups: this.damagePopups,
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
        [this.attacker, ...this.defenders],
        [this.attackItem, ...(this.defenseItem ? [this.defenseItem] : [])],
        () => this.computeResults(),
      );
      actionLog.doAction(action);
      this.cachedResults = action.getResult();
      return this.cachedResults;
    }
    this.cachedResults = this.computeResults();
    return this.cachedResults;
  }

  private computeResults(): CombatResults {
    // Walk through all strikes and apply HP changes to actual units
    let atkHp = this.attackerStartHp;
    const defenderHps = new Map(this.defenderStartHps);

    for (const strike of this.strikes) {
      if (!strike.hit) continue;
      if (strike.defender === this.attacker) {
        atkHp -= strike.damage;
      } else if (defenderHps.has(strike.defender)) {
        defenderHps.set(
          strike.defender,
          (defenderHps.get(strike.defender) ?? strike.defender.currentHp) - strike.damage,
        );
      }
    }

    // Clamp HP
    atkHp = Math.max(0, atkHp);

    // Apply to units
    this.attacker.currentHp = atkHp;
    for (const [unit, hp] of defenderHps) unit.currentHp = Math.max(0, hp);

    const attackerDead = atkHp <= 0;
    const defenderDeaths = this.defenders.filter((unit) => unit.currentHp <= 0);
    const deadDefenders = new Set(defenderDeaths);
    const defenderDead = deadDefenders.has(this.defender);

    if (attackerDead) {
      this.attacker.dead = true;
    }
    for (const unit of defenderDeaths) unit.dead = true;

    // Decrement weapon uses
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
      }
    }

    const defenderUses = this.primaryDefender && this.defenseItem
      ? usesConsumedByStrikes(this.primaryDefender, this.defenseItem, this.strikes)
      : 0;
    if (defenderUses > 0 && this.primaryDefender && this.defenseItem && this.defenseItem.maxUses > 0) {
      for (let i = 0; i < defenderUses && this.defenseItem.uses > 0; i++) {
        defenseWeaponBroke = this.defenseItem.decrementUses() || defenseWeaponBroke;
      }
      if (defenseWeaponBroke && !this.defenseItem.hasComponent('no_break_out_of_uses')) {
        const idx = this.primaryDefender.items.indexOf(this.defenseItem);
        if (idx !== -1) this.primaryDefender.items.splice(idx, 1);
      }
    }

    const componentResults = applyGroupCombatComponents(
      this.attacker,
      this.attackItem,
      this.primaryDefender,
      this.defenseItem,
      this.strikes,
      attackerDead,
      deadDefenders,
      this.db,
    );

    // Fixed staff EXP replaces the ordinary level-difference combat formula.
    const expGained = componentResults.fixedExp ?? this.calculateExp(attackerDead, deadDefenders);

    // Grant EXP and perform level-ups with growth rolls
    let levelUps: Record<string, number>[] = [];
    const growthMode = (this.db.getConstant('growths_choice', 'random') as string) || 'random';

    if (!attackerDead && this.attacker.team === 'player' && expGained > 0) {
      this.attacker.exp += expGained;
      while (this.attacker.exp >= 100) {
        this.attacker.exp -= 100;
        const gains = this.attacker.levelUp(growthMode);
        levelUps.push(gains);
      }
    }

    const droppedItems: { unit: UnitObject; item: import('../objects/item').ItemObject }[] = [];
    if (!attackerDead) {
      for (const unit of defenderDeaths) {
        const item = unit.items.find((candidate) => candidate.droppable);
        if (item) droppedItems.push({ unit, item });
      }
    }
    const droppedItem = droppedItems[0]?.item ?? null;

    return {
      attackerDead,
      defenderDead,
      expGained,
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
  // State update methods
  // ------------------------------------------------------------------

  private updateInit(deltaMs: number): boolean {
    this.frameTimer += deltaMs;
    if (this.frameTimer >= INIT_DURATION_MS) {
      this.frameTimer = 0;

      if (this.strikes.length === 0) {
        this.state = 'cleanup';
      } else {
        this.state = 'strike';
      }
    }
    return false;
  }

  private updateStrike(deltaMs: number): boolean {
    this.frameTimer += deltaMs;

    // Compute lunge animation: attacker moves toward defender
    const strike = this.strikes[this.currentStrikeIndex];
    if (strike) {
      const strikerAnim = strike.attacker === this.attacker
        ? this.attackerAnim
        : this.defenderAnims.get(strike.attacker) ?? this.defenderAnim;
      const targetAnim = strike.defender === this.attacker
        ? this.attackerAnim
        : this.defenderAnims.get(strike.defender) ?? this.defenderAnim;

      // Compute direction from striker to target (in tile coords)
      const strikerUnit = strike.attacker;
      const targetUnit = strike.defender;
      if (strikerUnit.position && targetUnit.position) {
        const dx = targetUnit.position[0] - strikerUnit.position[0];
        const dy = targetUnit.position[1] - strikerUnit.position[1];
        const dist = Math.abs(dx) + Math.abs(dy);
        const ndx = dist > 0 ? dx / dist : 0;
        const ndy = dist > 0 ? dy / dist : 0;

        if (this.frameTimer <= LUNGE_DURATION_MS) {
          // Lunge forward
          const t = this.frameTimer / LUNGE_DURATION_MS;
          const lungePixels = 6; // max pixels to lunge
          strikerAnim.lungeOffset = [ndx * lungePixels * t, ndy * lungePixels * t];
        } else {
          // Snap back
          const returnT = (this.frameTimer - LUNGE_DURATION_MS) / LUNGE_RETURN_MS;
          const lungePixels = 6;
          const eased = Math.min(1, returnT);
          strikerAnim.lungeOffset = [ndx * lungePixels * (1 - eased), ndy * lungePixels * (1 - eased)];
        }

        // Flash on the target at the moment of impact (peak of lunge)
        if (this.frameTimer >= LUNGE_DURATION_MS * 0.8 && this.frameTimer <= LUNGE_DURATION_MS * 1.2) {
          if (strike.hit) {
            targetAnim.flashAlpha = strike.crit ? 0.8 : 0.5;
          }
          // Play hit/miss sound at impact
          if (!this.hitSoundPlayed && this.audioManager) {
            this.hitSoundPlayed = true;
            if (strike.hit) {
              if (strike.crit) {
                this.audioManager.playSfx('Critical Hit 1');
              } else {
                this.audioManager.playSfx('Attack Hit ' + (Math.random() < 0.5 ? '1' : '2'));
              }
            } else {
              this.audioManager.playSfx('Attack Miss 2');
            }
          }
        } else {
          targetAnim.flashAlpha = Math.max(0, targetAnim.flashAlpha - deltaMs * 0.005);
        }
      }
    }

    if (this.frameTimer >= STRIKE_DURATION_MS) {
      this.frameTimer = 0;
      this.hitSoundPlayed = false;

      // Reset lunge offsets
      this.attackerAnim.lungeOffset = [0, 0];
      for (const anim of this.defenderAnims.values()) anim.lungeOffset = [0, 0];

      // Apply this strike's damage to display HP targets
      for (const [unit, hp] of this.defenderDisplayHps) {
        this.defenderDrainStartHps.set(unit, hp);
      }
      if (strike && strike.hit) {
        // Record drain animation start points
        this.hpDrainStartAttacker = this.attackerTargetHp;
        if (strike.defender === this.attacker) {
          this.attackerTargetHp = Math.max(0, this.attackerTargetHp - strike.damage);
        } else if (this.defenderTargetHps.has(strike.defender)) {
          this.defenderTargetHps.set(
            strike.defender,
            Math.max(0, (this.defenderTargetHps.get(strike.defender) ?? 0) - strike.damage),
          );
        }

        // Spawn damage popup on the defender
        const targetUnit = strike.defender;
        if (targetUnit.position) {
          this.damagePopups.push({
            x: targetUnit.position[0],
            y: targetUnit.position[1],
            value: strike.damage,
            isCrit: strike.crit,
            elapsed: 0,
            duration: 600,
          });
        }
      } else if (strike && !strike.hit) {
        // Miss - still need drain start points for the (no-op) animation
        this.hpDrainStartAttacker = this.attackerTargetHp;

        // Spawn "MISS" popup
        const targetUnit = strike.defender;
        if (targetUnit.position) {
          this.damagePopups.push({
            x: targetUnit.position[0],
            y: targetUnit.position[1],
            value: 0, // 0 = miss
            isCrit: false,
            elapsed: 0,
            duration: 500,
          });
        }
      } else {
        this.hpDrainStartAttacker = this.attackerTargetHp;
      }

      this.hpDrainElapsed = 0;
      this.state = 'hp_change';
    }
    return false;
  }

  private updateHpChange(deltaMs: number): boolean {
    this.hpDrainElapsed += deltaMs;
    const t = Math.min(1, this.hpDrainElapsed / HP_DRAIN_DURATION_MS);

    // Linearly interpolate display HP toward target
    this.attackerDisplayHp = lerp(this.hpDrainStartAttacker, this.attackerTargetHp, t);
    for (const unit of this.defenders) {
      this.defenderDisplayHps.set(
        unit,
        lerp(
          this.defenderDrainStartHps.get(unit) ?? unit.currentHp,
          this.defenderTargetHps.get(unit) ?? unit.currentHp,
          t,
        ),
      );
    }
    this.defenderDisplayHp = this.defenderDisplayHps.get(this.defender) ?? this.defenderDisplayHp;

    // Hit-shake on the unit that took damage
    const strike = this.currentStrikeIndex < this.strikes.length
      ? this.strikes[this.currentStrikeIndex]
      : null;
    if (strike && strike.hit && t < 0.6) {
      // Oscillating shake
      const shakeT = this.hpDrainElapsed / SHAKE_FREQUENCY;
      const decay = 1 - t / 0.6; // fade shake out over first 60% of drain
      const shakeX = Math.round(Math.sin(shakeT * Math.PI * 2) * SHAKE_AMPLITUDE * decay);

      const targetAnim = strike.defender === this.attacker
        ? this.attackerAnim
        : this.defenderAnims.get(strike.defender) ?? this.defenderAnim;
      targetAnim.shakeOffset = [shakeX, 0];
    } else {
      // Reset shakes
      this.attackerAnim.shakeOffset = [0, 0];
      for (const anim of this.defenderAnims.values()) anim.shakeOffset = [0, 0];
    }

    // Decay flash alpha
    this.attackerAnim.flashAlpha = Math.max(0, this.attackerAnim.flashAlpha - deltaMs * 0.004);
    for (const anim of this.defenderAnims.values()) {
      anim.flashAlpha = Math.max(0, anim.flashAlpha - deltaMs * 0.004);
    }

    // Update damage popups
    this.updateDamagePopups(deltaMs);

    if (t >= 1) {
      // Snap to target
      this.attackerDisplayHp = this.attackerTargetHp;
      for (const unit of this.defenders) {
        this.defenderDisplayHps.set(unit, this.defenderTargetHps.get(unit) ?? unit.currentHp);
      }
      this.defenderDisplayHp = this.defenderDisplayHps.get(this.defender) ?? this.defenderDisplayHp;

      // Reset shakes
      this.attackerAnim.shakeOffset = [0, 0];
      for (const anim of this.defenderAnims.values()) anim.shakeOffset = [0, 0];

      // Move to next strike or cleanup
      this.currentStrikeIndex++;
      this.frameTimer = 0;

      if (this.currentStrikeIndex >= this.strikes.length) {
        this.state = 'cleanup';
      } else {
        this.state = 'waiting';
      }
    }

    return false;
  }

  private updateWaiting(deltaMs: number): boolean {
    this.frameTimer += deltaMs;
    // Keep updating popups during pauses
    this.updateDamagePopups(deltaMs);
    if (this.frameTimer >= WAITING_DURATION_MS) {
      this.frameTimer = 0;
      this.state = 'strike';
    }
    return false;
  }

  private updateCleanup(deltaMs: number): boolean {
    this.frameTimer += deltaMs;
    this.updateDamagePopups(deltaMs);
    // Reset all animation offsets during cleanup
    this.attackerAnim.lungeOffset = [0, 0];
    this.attackerAnim.shakeOffset = [0, 0];
    this.attackerAnim.flashAlpha = 0;
    for (const anim of this.defenderAnims.values()) {
      anim.lungeOffset = [0, 0];
      anim.shakeOffset = [0, 0];
      anim.flashAlpha = 0;
    }
    if (this.frameTimer >= CLEANUP_DURATION_MS) {
      this.frameTimer = 0;
      this.state = 'done';
      return true;
    }
    return false;
  }

  /** Advance all active damage popups, removing expired ones. */
  private updateDamagePopups(deltaMs: number): void {
    for (const popup of this.damagePopups) {
      popup.elapsed += deltaMs;
    }
    this.damagePopups = this.damagePopups.filter(p => p.elapsed < p.duration);
  }

  // ------------------------------------------------------------------
  // EXP calculation
  // ------------------------------------------------------------------

  /**
   * Calculate experience gained.
   * Base 30 exp for combat, +50 bonus for kill.
   * Scaled by level difference between attacker and defender.
   */
  private calculateExp(attackerDead: boolean, deadDefenders: Set<UnitObject>): number {
    if (attackerDead) return 0;

    const BASE_EXP = 30;
    const KILL_BONUS = 50;

    const damagedDefenders = new Set(this.strikes
      .filter((strike) =>
        strike.attacker === this.attacker && strike.hit && strike.damage > 0 &&
        !strike.defender.tags.includes('Tile'),
      )
      .map((strike) => strike.defender));
    let exp = 0;
    for (const defender of damagedDefenders) {
      // Level difference scaling: higher-level enemies give more exp
      const levelDiff = defender.level - this.attacker.level;
      const levelScale = Math.max(0.1, 1 + levelDiff * 0.1);
      let defenderExp = Math.round(BASE_EXP * levelScale);
      if (deadDefenders.has(defender)) defenderExp += Math.round(KILL_BONUS * levelScale);
      exp += defenderExp;
    }

    // Python aggregates unique damaged defenders, then clamps the encounter.
    return damagedDefenders.size > 0 ? Math.max(1, Math.min(100, exp)) : 0;
  }
}

// ------------------------------------------------------------------
// Utility
// ------------------------------------------------------------------

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
