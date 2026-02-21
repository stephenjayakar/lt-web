import type { UnitObject } from '../objects/unit';
import type { ItemObject } from '../objects/item';
import type { Database } from '../data/database';
import * as calcs from './combat-calcs';

// ============================================================
// CombatPhaseSolver - Resolves a full combat encounter into a
// sequence of strikes.
// Matches LT's CombatPhaseSolver from app/engine/combat/solver.py
// ============================================================

export type RngMode = 'classic' | 'true_hit' | 'true_hit_plus' | 'grandmaster';

export interface CombatStrike {
  attacker: UnitObject;
  defender: UnitObject;
  item: ItemObject;
  hit: boolean;
  crit: boolean;
  damage: number;
  isCounter: boolean;
}

export class CombatPhaseSolver {
  private strikes: CombatStrike[];

  constructor() {
    this.strikes = [];
  }

  /**
   * Resolve a complete combat encounter.
   * Returns an ordered array of all strikes that should occur.
   *
   * Strike order:
   *   1. Attacker strikes (x2 if brave weapon)
   *   2. Defender counter (if able) (x2 if brave weapon)
   *   3. Attacker double (if speed check passes) (x2 if brave weapon)
   *   4. Defender double counter (if speed check passes and can counter) (x2 if brave weapon)
   */
  resolve(
    attacker: UnitObject,
    attackItem: ItemObject,
    defender: UnitObject,
    defenseItem: ItemObject | null,
    db: Database,
    rngMode: RngMode,
  ): CombatStrike[] {
    this.strikes = [];

    // Track simulated HP for lethality checks (stop attacking dead units)
    let attackerHp = attacker.currentHp;
    let defenderHp = defender.currentHp;

    // Determine capabilities
    const defenderCanCounter = calcs.canCounterattack(attacker, attackItem, defender, db);
    const attackerDoubles = calcs.canDouble(attacker, attackItem, defender, defenseItem, db);
    const defenderDoubles =
      defenderCanCounter && defenseItem
        ? calcs.canDouble(defender, defenseItem, attacker, attackItem, db)
        : false;

    // Check for brave weapon (multi-attack component)
    const attackerBrave = attackItem.hasComponent('brave');
    const defenderBrave = defenseItem ? defenseItem.hasComponent('brave') : false;

    const attackerStrikeCount = attackerBrave ? 2 : 1;
    const defenderStrikeCount = defenderBrave ? 2 : 1;

    // 1. Attacker initial strikes
    for (let i = 0; i < attackerStrikeCount; i++) {
      if (defenderHp <= 0) break;
      const strike = this.resolveStrike(attacker, attackItem, defender, db, rngMode, false);
      this.strikes.push(strike);
      if (strike.hit) {
        defenderHp -= strike.damage;
      }
    }

    // 2. Defender counter
    if (defenderCanCounter && defenseItem && defenderHp > 0) {
      for (let i = 0; i < defenderStrikeCount; i++) {
        if (attackerHp <= 0) break;
        if (defenderHp <= 0) break;
        const strike = this.resolveStrike(defender, defenseItem, attacker, db, rngMode, true);
        this.strikes.push(strike);
        if (strike.hit) {
          attackerHp -= strike.damage;
        }
      }
    }

    // 3. Attacker double
    if (attackerDoubles && defenderHp > 0 && attackerHp > 0) {
      for (let i = 0; i < attackerStrikeCount; i++) {
        if (defenderHp <= 0) break;
        if (attackerHp <= 0) break;
        const strike = this.resolveStrike(attacker, attackItem, defender, db, rngMode, false);
        this.strikes.push(strike);
        if (strike.hit) {
          defenderHp -= strike.damage;
        }
      }
    }

    // 4. Defender double counter
    if (defenderDoubles && defenseItem && attackerHp > 0 && defenderHp > 0) {
      for (let i = 0; i < defenderStrikeCount; i++) {
        if (attackerHp <= 0) break;
        if (defenderHp <= 0) break;
        const strike = this.resolveStrike(defender, defenseItem, attacker, db, rngMode, true);
        this.strikes.push(strike);
        if (strike.hit) {
          attackerHp -= strike.damage;
        }
      }
    }

    return this.strikes;
  }

  /**
   * Roll for hit based on RNG mode.
   *
   * - classic: single RN, random(0..99) < hitChance
   * - true_hit: average of 2 RNs (standard Fire Emblem 2-RN system)
   * - true_hit_plus: average of 3 RNs
   * - grandmaster: always hits
   */
  private rollHit(hitChance: number, rngMode: RngMode): boolean {
    switch (rngMode) {
      case 'grandmaster':
        return true;

      case 'true_hit': {
        const r1 = Math.floor(Math.random() * 100);
        const r2 = Math.floor(Math.random() * 100);
        return (r1 + r2) / 2 < hitChance;
      }

      case 'true_hit_plus': {
        const r1 = Math.floor(Math.random() * 100);
        const r2 = Math.floor(Math.random() * 100);
        const r3 = Math.floor(Math.random() * 100);
        return (r1 + r2 + r3) / 3 < hitChance;
      }

      case 'classic':
      default: {
        return Math.floor(Math.random() * 100) < hitChance;
      }
    }
  }

  /**
   * Generate a single strike result.
   * Computes hit chance, crit chance, then rolls and determines damage.
   */
  private resolveStrike(
    striker: UnitObject,
    item: ItemObject,
    target: UnitObject,
    db: Database,
    rngMode: RngMode,
    isCounter: boolean,
  ): CombatStrike {
    // Compute hit chance with weapon triangle bonus
    const defWeapon = target.items.find((i) => i.isWeapon()) ?? null;
    const baseHit = calcs.computeHit(striker, item, target, db);
    const wt = calcs.weaponTriangle(item, defWeapon, db);
    const finalHit = Math.max(0, Math.min(100, baseHit + wt.hitBonus));

    // Compute crit chance
    const critChance = calcs.computeCrit(striker, item, target, db);

    // Roll for hit
    const hit = this.rollHit(finalHit, rngMode);

    // Roll for crit (only if hit lands)
    const crit = hit ? Math.floor(Math.random() * 100) < critChance : false;

    // Compute damage (0 on miss)
    let dmg = 0;
    if (hit) {
      const baseDmg = calcs.computeDamage(striker, item, target, db);
      dmg = baseDmg + wt.damageBonus;
      if (crit) {
        dmg *= 3; // Critical hit multiplier (LT default)
      }
      dmg = Math.max(0, dmg);
    }

    return {
      attacker: striker,
      defender: target,
      item,
      hit,
      crit,
      damage: dmg,
      isCounter,
    };
  }
}
