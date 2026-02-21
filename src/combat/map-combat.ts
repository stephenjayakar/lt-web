import type { UnitObject } from '../objects/unit';
import type { ItemObject } from '../objects/item';
import type { Database } from '../data/database';
import type { CombatStrike } from './combat-solver';
import { CombatPhaseSolver, type RngMode } from './combat-solver';

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
}

/** Duration constants (milliseconds) */
const INIT_DURATION_MS = 250; // ~15 frames at 60 fps
const STRIKE_DURATION_MS = 150; // Flash / strike animation
const HP_DRAIN_DURATION_MS = 333; // ~20 frames at 60 fps
const WAITING_DURATION_MS = 100; // Pause between strikes
const CLEANUP_DURATION_MS = 250; // Pause before done

export class MapCombat {
  attacker: UnitObject;
  defender: UnitObject;
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
  private defenderTargetHp: number;
  private hpDrainElapsed: number;
  private hpDrainStartAttacker: number;
  private hpDrainStartDefender: number;

  // Snapshot of real HP before combat (for result calculation)
  private attackerStartHp: number;
  private defenderStartHp: number;

  // Reference to DB for exp calculation
  private db: Database;

  constructor(
    attacker: UnitObject,
    attackItem: ItemObject,
    defender: UnitObject,
    defenseItem: ItemObject | null,
    db: Database,
    rngMode: RngMode,
  ) {
    this.attacker = attacker;
    this.attackItem = attackItem;
    this.defender = defender;
    this.defenseItem = defenseItem;
    this.db = db;

    // Solve the combat to get the strike sequence
    const solver = new CombatPhaseSolver();
    this.strikes = solver.resolve(attacker, attackItem, defender, defenseItem, db, rngMode);

    this.state = 'init';
    this.currentStrikeIndex = 0;
    this.frameTimer = 0;

    // Initialise HP display from current unit state
    this.attackerDisplayHp = attacker.currentHp;
    this.defenderDisplayHp = defender.currentHp;
    this.attackerTargetHp = attacker.currentHp;
    this.defenderTargetHp = defender.currentHp;
    this.hpDrainElapsed = 0;
    this.hpDrainStartAttacker = attacker.currentHp;
    this.hpDrainStartDefender = defender.currentHp;

    this.attackerStartHp = attacker.currentHp;
    this.defenderStartHp = defender.currentHp;
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
    };
  }

  /**
   * Apply final combat results to units (HP changes, death, exp, weapon uses).
   * Should be called once after the combat is done.
   *
   * Returns detailed results including stat gains from level-ups and
   * weapon breakage information.
   */
  applyResults(): CombatResults {
    // Walk through all strikes and apply HP changes to actual units
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

    // Clamp HP
    atkHp = Math.max(0, atkHp);
    defHp = Math.max(0, defHp);

    // Apply to units
    this.attacker.currentHp = atkHp;
    this.defender.currentHp = defHp;

    const attackerDead = atkHp <= 0;
    const defenderDead = defHp <= 0;

    if (attackerDead) {
      this.attacker.dead = true;
    }
    if (defenderDead) {
      this.defender.dead = true;
    }

    // Decrement weapon uses
    let attackWeaponBroke = false;
    let defenseWeaponBroke = false;

    if (attackerStrikeCount > 0 && this.attackItem.maxUses > 0) {
      // Decrement once per combat (not per strike) to match LT behavior
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

    // Calculate EXP
    const expGained = this.calculateExp(attackerDead, defenderDead);

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

    // Check for droppable items from dead defender
    let droppedItem: import('../objects/item').ItemObject | null = null;
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
    if (this.frameTimer >= STRIKE_DURATION_MS) {
      this.frameTimer = 0;

      // Apply this strike's damage to display HP targets
      const strike = this.strikes[this.currentStrikeIndex];
      if (strike && strike.hit) {
        // Record drain animation start points
        this.hpDrainStartAttacker = this.attackerTargetHp;
        this.hpDrainStartDefender = this.defenderTargetHp;

        if (strike.attacker === this.attacker) {
          this.defenderTargetHp = Math.max(0, this.defenderTargetHp - strike.damage);
        } else {
          this.attackerTargetHp = Math.max(0, this.attackerTargetHp - strike.damage);
        }
      } else {
        // Miss - still need drain start points for the (no-op) animation
        this.hpDrainStartAttacker = this.attackerTargetHp;
        this.hpDrainStartDefender = this.defenderTargetHp;
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
    this.defenderDisplayHp = lerp(this.hpDrainStartDefender, this.defenderTargetHp, t);

    if (t >= 1) {
      // Snap to target
      this.attackerDisplayHp = this.attackerTargetHp;
      this.defenderDisplayHp = this.defenderTargetHp;

      // Move to next strike or cleanup
      this.currentStrikeIndex++;
      this.frameTimer = 0;

      if (this.currentStrikeIndex >= this.strikes.length) {
        this.state = 'cleanup';
      } else if (this.attackerTargetHp <= 0 || this.defenderTargetHp <= 0) {
        // Someone died - end combat
        this.state = 'cleanup';
      } else {
        this.state = 'waiting';
      }
    }

    return false;
  }

  private updateWaiting(deltaMs: number): boolean {
    this.frameTimer += deltaMs;
    if (this.frameTimer >= WAITING_DURATION_MS) {
      this.frameTimer = 0;
      this.state = 'strike';
    }
    return false;
  }

  private updateCleanup(deltaMs: number): boolean {
    this.frameTimer += deltaMs;
    if (this.frameTimer >= CLEANUP_DURATION_MS) {
      this.frameTimer = 0;
      this.state = 'done';
      return true;
    }
    return false;
  }

  // ------------------------------------------------------------------
  // EXP calculation
  // ------------------------------------------------------------------

  /**
   * Calculate experience gained.
   * Base 30 exp for combat, +50 bonus for kill.
   * Scaled by level difference between attacker and defender.
   */
  private calculateExp(attackerDead: boolean, defenderDead: boolean): number {
    if (attackerDead) return 0;

    const BASE_EXP = 30;
    const KILL_BONUS = 50;

    // Level difference scaling: higher-level enemies give more exp
    const levelDiff = this.defender.level - this.attacker.level;
    // Scale factor: +/- 5 exp per level difference, clamped so exp doesn't go negative
    const levelScale = Math.max(0.1, 1 + levelDiff * 0.1);

    let exp = Math.round(BASE_EXP * levelScale);

    if (defenderDead) {
      exp += Math.round(KILL_BONUS * levelScale);
    }

    // Clamp to 1..100
    return Math.max(1, Math.min(100, exp));
  }
}

// ------------------------------------------------------------------
// Utility
// ------------------------------------------------------------------

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
