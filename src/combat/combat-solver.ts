import type { UnitObject } from '../objects/unit';
import type { ItemObject } from '../objects/item';
import type { Database } from '../data/database';
import type { GameBoard } from '../objects/game-board';
import * as calcs from './combat-calcs';
import * as skillSystem from './skill-system';
import {
  CombatSkillLifecycle,
  type CombatProcMark,
} from './combat-skill-lifecycle';

// ============================================================
// CombatPhaseSolver - Resolves a full combat encounter into a
// sequence of strikes.
// Matches LT's CombatPhaseSolver from app/engine/combat/solver.py
// Now with vantage, desperation, and full skill dispatch.
// ============================================================

export type RngMode = 'classic' | 'true_hit' | 'true_hit_plus' | 'fates_hit' | 'grandmaster';
export type CombatMode = 'attack' | 'defense' | 'splash';

export interface CombatStrike {
  attacker: UnitObject;
  defender: UnitObject;
  item: ItemObject;
  hit: boolean;
  crit: boolean;
  damage: number;
  isCounter: boolean;
  mode?: CombatMode;
  attackInfo: [number, number];
  attackProcs?: CombatProcMark[];
  defenseProcs?: CombatProcMark[];
}

/** Valid CombatScript tokens for interact_unit. */
export type ScriptToken = 'hit1' | 'hit2' | 'crit1' | 'crit2' | 'miss1' | 'miss2' | '--' | 'end';

export class CombatPhaseSolver {
  private strikes: CombatStrike[];
  private randomRoll: () => number;
  private lifecycle: CombatSkillLifecycle | null = null;
  private phaseCounts: Map<UnitObject, number> = new Map();
  readonly procPlayback: CombatProcMark[] = [];

  constructor(randomRoll?: () => number, game?: any) {
    this.strikes = [];
    this.randomRoll = randomRoll ?? (() => Math.floor(Math.random() * 100));
    this.game = game;
  }

  private game: any;

  private beginLifecycle(
    db: Database,
    attacker: UnitObject,
    attackItem: ItemObject,
    defenders: UnitObject[],
    defenseItems: Map<UnitObject, ItemObject | null>,
  ): void {
    this.phaseCounts.clear();
    this.procPlayback.length = 0;
    this.lifecycle = new CombatSkillLifecycle(db, this.randomRoll, this.game);
    this.lifecycle.beginCombat(attacker, attackItem, defenders, defenseItems);
  }

  private finishLifecycle(strikes: CombatStrike[]): void {
    if (!this.lifecycle) return;
    this.lifecycle.endCombat(strikes);
    this.procPlayback.push(...this.lifecycle.marks);
    this.lifecycle = null;
  }

  private nextPhase(unit: UnitObject): number {
    const phase = this.phaseCounts.get(unit) ?? 0;
    this.phaseCounts.set(unit, phase + 1);
    return phase;
  }

  /**
   * Resolve a scripted combat encounter (from interact_unit).
   * The script is an ordered list of tokens that control both:
   *   (a) which side strikes next, and
   *   (b) whether the strike is forced hit/crit/miss.
   *
   * Tokens:
   *   hit1/crit1/miss1 → attacker (unit 1) strikes with forced outcome
   *   hit2/crit2/miss2 → defender (unit 2) strikes with forced outcome
   *   '--' → next natural strike (uses normal combat ordering + RNG)
   *   'end' → terminate combat immediately
   *
   * When the script is exhausted, remaining natural strikes play out
   * if there are any.
   */
  private resolveScripted(
    attacker: UnitObject,
    attackItem: ItemObject,
    defender: UnitObject,
    defenseItem: ItemObject | null,
    db: Database,
    rngMode: RngMode,
    script: string[],
    board?: GameBoard | null,
  ): CombatStrike[] {
    this.strikes = [];
    let attackerHp = attacker.currentHp;
    let defenderHp = defender.currentHp;
    const atkHp = { hp: attackerHp };
    const defHp = { hp: defenderHp };

    const phases = new Map<UnitObject, number>();
    // Process each script token
    for (const rawToken of script) {
      const token = rawToken.toLowerCase().trim();
      if (token === 'end') break;
      if (atkHp.hp <= 0 || defHp.hp <= 0) break;

      if (token === '--') {
        // Natural strike: use normal resolution for the next expected strike.
        // For simplicity, default to attacker if no script context.
        // (In Python this falls through to the state machine's normal logic,
        // but for our pre-computed approach we just do one attacker strike.)
        const phase = phases.get(attacker) ?? 0;
        phases.set(attacker, phase + 1);
        const strike = this.resolveStrike(
          attacker, attackItem, defender, db, rngMode, false, board, 'attack', [phase, 0],
        );
        this.strikes.push(strike);
        if (strike.hit) defHp.hp -= strike.damage;
      } else if (token === 'hit1' || token === 'crit1' || token === 'miss1') {
        // Attacker strikes with forced outcome
        const phase = phases.get(attacker) ?? 0;
        phases.set(attacker, phase + 1);
        const strike = this.resolveScriptedStrike(
          attacker, attackItem, defender, db, false, token, board, 'attack', [phase, 0],
        );
        this.strikes.push(strike);
        if (strike.hit) defHp.hp -= strike.damage;
      } else if (token === 'hit2' || token === 'crit2' || token === 'miss2') {
        // Defender strikes with forced outcome
        if (!defenseItem) continue; // Defender can't strike without a weapon
        const phase = phases.get(defender) ?? 0;
        phases.set(defender, phase + 1);
        const strike = this.resolveScriptedStrike(
          defender, defenseItem, attacker, db, true, token, board, 'defense', [phase, 0],
        );
        this.strikes.push(strike);
        if (strike.hit) atkHp.hp -= strike.damage;
      }
    }

    return this.strikes;
  }

  /**
   * Resolve a single strike with a forced outcome from a script token.
   */
  private resolveScriptedStrike(
    striker: UnitObject,
    item: ItemObject,
    target: UnitObject,
    db: Database,
    isCounter: boolean,
    token: string,
    board?: GameBoard | null,
    mode: CombatMode = isCounter ? 'defense' : 'attack',
    attackInfo: [number, number] = [0, 0],
    forcedAttackProcs?: CombatProcMark[],
  ): CombatStrike {
    const procs = this.lifecycle?.beginStrike(striker, item, target, forcedAttackProcs) ??
      { attack: [], defense: [] };
    const defWeapon = target.items.find((i) => i.isWeapon()) ?? null;
    const wt = calcs.weaponTriangle(item, defWeapon, db, striker);

    const isMiss = token.startsWith('miss');
    const isCrit = token.startsWith('crit');
    const hit = !isMiss;
    const crit = isCrit;

    let dmg = 0;
    if (hit) {
      const baseDmg = calcs.computeDamage(striker, item, target, db, board, undefined, mode);
      dmg = baseDmg + wt.damageBonus;
      if (crit) {
        const critDmgMod = skillSystem.modifyCritDamage(striker, item);
        const baseCritMult = 3;
        dmg = dmg * baseCritMult + critDmgMod;
      }
      dmg = Math.max(0, dmg);
    }

    const strike: CombatStrike = {
      attacker: striker,
      defender: target,
      item,
      hit,
      crit,
      damage: dmg,
      isCounter,
      mode,
      attackInfo,
      ...(procs.attack.length ? { attackProcs: procs.attack } : {}),
      ...(procs.defense.length ? { defenseProcs: procs.defense } : {}),
    };
    this.lifecycle?.endStrike(procs);
    return strike;
  }

  /**
   * Resolve one Python-shaped main+splash encounter.
   *
   * The main defender follows normal combat ordering and is the only target
   * that can counter. Splash targets are processed immediately after each
   * propagated attacker strike. Unless double_splash is enabled, only the
   * first attacker subattack reaches splash targets.
   */
  resolveGroup(
    attacker: UnitObject,
    attackItem: ItemObject,
    mainDefender: UnitObject | null,
    defenseItem: ItemObject | null,
    splashDefenders: UnitObject[],
    db: Database,
    rngMode: RngMode,
    board?: GameBoard | null,
    script?: string[] | null,
  ): CombatStrike[] {
    const splash = [...new Set(splashDefenders)].filter((unit) => unit !== mainDefender);
    if (splash.length === 0 && mainDefender) {
      return this.resolve(attacker, attackItem, mainDefender, defenseItem, db, rngMode, board, script);
    }

    const doubleSplash = !!db.getConstant('double_splash', false);
    const splashHp = new Map(splash.map((unit) => [unit, unit.currentHp]));
    const result: CombatStrike[] = [];
    let propagatedAttacks = 0;

    this.beginLifecycle(
      db,
      attacker,
      attackItem,
      [...(mainDefender ? [mainDefender] : []), ...splash],
      new Map([
        ...(mainDefender ? [[mainDefender, defenseItem] as [UnitObject, ItemObject | null]] : []),
        ...splash.map((unit) => [unit, null] as [UnitObject, ItemObject | null]),
      ]),
    );

    const appendSplash = (
      forcedToken?: string,
      sourceStrike?: CombatStrike,
      explicitAttackInfo?: [number, number],
    ): void => {
      if (!doubleSplash && propagatedAttacks > 0) return;
      let sharedAttackProcs = sourceStrike?.attackProcs;
      for (const target of splash) {
        const hp = splashHp.get(target) ?? 0;
        if (hp <= 0 && !skillSystem.ignoreDyingInCombat(target)) continue;
        const strike = forcedToken
          ? this.resolveScriptedStrike(
            attacker, attackItem, target, db, false, forcedToken, board, 'splash',
            sourceStrike?.attackInfo ?? explicitAttackInfo ?? [propagatedAttacks, 0],
            sharedAttackProcs,
          )
          : this.resolveStrike(
            attacker, attackItem, target, db, rngMode, false, board, 'splash',
            sourceStrike?.attackInfo ?? explicitAttackInfo ?? [propagatedAttacks, 0],
            sharedAttackProcs,
          );
        result.push(strike);
        sharedAttackProcs ??= strike.attackProcs;
        if (strike.hit) {
          const nextHp = hp - strike.damage;
          splashHp.set(target, skillSystem.ignoreDyingInCombat(target) && nextHp <= 0 ? 1 : nextHp);
        }
      }
      propagatedAttacks++;
    };

    if (script && script.length > 0) {
      let attackerHp = attacker.currentHp;
      let defenderHp = mainDefender?.currentHp ?? 0;
      for (const rawToken of script) {
        const token = rawToken.toLowerCase().trim();
        if (token === 'end' || attackerHp <= 0 || (mainDefender && defenderHp <= 0)) break;
        if (token === 'hit2' || token === 'crit2' || token === 'miss2') {
          if (!mainDefender || !defenseItem) continue;
          const phase = this.nextPhase(mainDefender);
          const strike = this.resolveScriptedStrike(
            mainDefender, defenseItem, attacker, db, true, token, board, 'defense', [phase, 0],
          );
          result.push(strike);
          if (strike.hit) attackerHp -= strike.damage;
          continue;
        }
        const forcedToken = token === '--' ? undefined : token;
        if (mainDefender) {
          const phase = this.nextPhase(attacker);
          const strike = forcedToken
            ? this.resolveScriptedStrike(
              attacker, attackItem, mainDefender, db, false, forcedToken, board, 'attack', [phase, 0],
            )
            : this.resolveStrike(
              attacker, attackItem, mainDefender, db, rngMode, false, board, 'attack', [phase, 0],
            );
          result.push(strike);
          if (strike.hit) defenderHp -= strike.damage;
          appendSplash(forcedToken, strike);
        } else {
          appendSplash(forcedToken, undefined, [this.nextPhase(attacker), 0]);
        }
      }
      this.strikes = result;
      this.finishLifecycle(result);
      return result;
    }

    if (mainDefender) {
      const mainStrikes = [...this.resolveCore(
        attacker, attackItem, mainDefender, defenseItem, db, rngMode, board,
      )];
      for (const strike of mainStrikes) {
        result.push(strike);
        if (strike.attacker === attacker) appendSplash(undefined, strike);
      }
    } else {
      const reference = splash[0];
      if (reference) {
        const strikeCount = doubleSplash
          ? calcs.computeStrikeCount(attacker, attackItem, reference, null)
          : 1;
        const phase = this.nextPhase(attacker);
        for (let idx = 0; idx < strikeCount; idx++) appendSplash(undefined, undefined, [phase, idx]);
      }
    }

    this.strikes = result;
    this.finishLifecycle(result);
    return result;
  }

  resolve(
    attacker: UnitObject,
    attackItem: ItemObject,
    defender: UnitObject,
    defenseItem: ItemObject | null,
    db: Database,
    rngMode: RngMode,
    board?: GameBoard | null,
    script?: string[] | null,
  ): CombatStrike[] {
    this.beginLifecycle(
      db,
      attacker,
      attackItem,
      [defender],
      new Map([[defender, defenseItem]]),
    );
    const strikes = this.resolveCore(
      attacker, attackItem, defender, defenseItem, db, rngMode, board, script,
    );
    this.finishLifecycle(strikes);
    return strikes;
  }

  /**
   * Resolve a complete combat encounter.
   * Returns an ordered array of all strikes that should occur.
   *
   * Standard strike order:
   *   1. Attacker strikes (x brave)
   *   2. Defender counter (if able) (x brave)
   *   3. Attacker double (if speed check passes) (x brave)
   *   4. Defender double counter (if speed + defDouble) (x brave)
   *
   * Modified by:
   *   - Vantage: defender strikes first if they have vantage
   *   - Desperation: attacker does all strikes before counter
   *   - Disvantage: attacker goes second (opposite of vantage)
   *
   * If `script` is provided, uses resolveScripted() instead of
   * the normal combat flow.
   */
  private resolveCore(
    attacker: UnitObject,
    attackItem: ItemObject,
    defender: UnitObject,
    defenseItem: ItemObject | null,
    db: Database,
    rngMode: RngMode,
    board?: GameBoard | null,
    script?: string[] | null,
  ): CombatStrike[] {
    // If a combat script is provided, use scripted resolution
    if (script && script.length > 0) {
      return this.resolveScripted(attacker, attackItem, defender, defenseItem, db, rngMode, script, board);
    }
    this.strikes = [];

    // Track simulated HP for lethality checks (stop attacking dead units)
    let attackerHp = attacker.currentHp;
    let defenderHp = defender.currentHp;

    // Determine capabilities
    const defenderCanCounter = calcs.canCounterattack(attacker, attackItem, defender, db);
    const attackerDoubles = calcs.canDouble(attacker, attackItem, defender, defenseItem, db);
    const defenderDoubles =
      defenderCanCounter && defenseItem
        ? calcs.canDefenderDouble(attacker, attackItem, defender, defenseItem, db)
        : false;

    // Compute strike counts (brave weapons, dynamic multiattacks from skills)
    const attackerStrikeCount = calcs.computeStrikeCount(
      attacker, attackItem, defender, defenseItem,
    );
    const defenderStrikeCount = defenseItem
      ? calcs.computeStrikeCount(defender, defenseItem, attacker, attackItem)
      : 1;

    // Check for skill-based ordering
    const defenderHasVantage = defenderCanCounter && defenseItem &&
      skillSystem.vantage(defender) && !skillSystem.disvantage(attacker);
    const attackerHasDesperation = skillSystem.desperation(attacker);
    const attackerHasDisvantage = skillSystem.disvantage(attacker) &&
      !skillSystem.vantage(attacker);

    // Check ignoreDyingInCombat (miracle)
    const attackerMiracle = skillSystem.ignoreDyingInCombat(attacker);
    const defenderMiracle = skillSystem.ignoreDyingInCombat(defender);

    // Helper: execute a series of strikes for one side
    const doStrikes = (
      striker: UnitObject,
      item: ItemObject,
      target: UnitObject,
      count: number,
      isCounter: boolean,
      strikerHpRef: { hp: number },
      targetHpRef: { hp: number },
      targetMiracle: boolean,
    ) => {
      const phase = this.phaseCounts.get(striker) ?? 0;
      for (let i = 0; i < count; i++) {
        if (targetHpRef.hp <= 0) break;
        if (strikerHpRef.hp <= 0) break;
        const strike = this.resolveStrike(
          striker, item, target, db, rngMode, isCounter, board,
          isCounter ? 'defense' : 'attack', [phase, i],
        );
        this.strikes.push(strike);
        if (strike.hit) {
          targetHpRef.hp -= strike.damage;
          // Miracle: target survives at 1 HP if they would die
          if (targetMiracle && targetHpRef.hp <= 0) {
            targetHpRef.hp = 1;
          }
        }
      }
      this.phaseCounts.set(striker, phase + 1);
    };

    const atkHp = { hp: attackerHp };
    const defHp = { hp: defenderHp };

    // ---- Determine strike ordering based on skills ----

    if (defenderHasVantage && defenseItem) {
      // VANTAGE: Defender strikes first
      // 1. Defender initial counter
      doStrikes(defender, defenseItem, attacker, defenderStrikeCount, true, defHp, atkHp, attackerMiracle);

      // 2. Attacker strikes (all if desperation, normal otherwise)
      if (attackerHasDesperation) {
        // Desperation: attacker does initial + double together
        doStrikes(attacker, attackItem, defender, attackerStrikeCount, false, atkHp, defHp, defenderMiracle);
        if (attackerDoubles) {
          doStrikes(attacker, attackItem, defender, attackerStrikeCount, false, atkHp, defHp, defenderMiracle);
        }
      } else {
        doStrikes(attacker, attackItem, defender, attackerStrikeCount, false, atkHp, defHp, defenderMiracle);
      }

      // 3. Defender double counter (if not desperation, which already went)
      if (!attackerHasDesperation && defenderDoubles) {
        doStrikes(defender, defenseItem, attacker, defenderStrikeCount, true, defHp, atkHp, attackerMiracle);
      }

      // 4. Attacker double (if not desperation, which already went)
      if (!attackerHasDesperation && attackerDoubles) {
        doStrikes(attacker, attackItem, defender, attackerStrikeCount, false, atkHp, defHp, defenderMiracle);
      }

      // 5. If desperation, defender double counter last
      if (attackerHasDesperation && defenderDoubles) {
        doStrikes(defender, defenseItem, attacker, defenderStrikeCount, true, defHp, atkHp, attackerMiracle);
      }

    } else if (attackerHasDisvantage && defenderCanCounter && defenseItem) {
      // DISVANTAGE: Attacker goes second (similar to vantage but without being a skill on the defender)
      doStrikes(defender, defenseItem, attacker, defenderStrikeCount, true, defHp, atkHp, attackerMiracle);
      doStrikes(attacker, attackItem, defender, attackerStrikeCount, false, atkHp, defHp, defenderMiracle);
      if (defenderDoubles) {
        doStrikes(defender, defenseItem, attacker, defenderStrikeCount, true, defHp, atkHp, attackerMiracle);
      }
      if (attackerDoubles) {
        doStrikes(attacker, attackItem, defender, attackerStrikeCount, false, atkHp, defHp, defenderMiracle);
      }

    } else if (attackerHasDesperation) {
      // DESPERATION: All attacker strikes before any counter
      // 1. Attacker initial + double
      doStrikes(attacker, attackItem, defender, attackerStrikeCount, false, atkHp, defHp, defenderMiracle);
      if (attackerDoubles) {
        doStrikes(attacker, attackItem, defender, attackerStrikeCount, false, atkHp, defHp, defenderMiracle);
      }

      // 2. Defender counter
      if (defenderCanCounter && defenseItem) {
        doStrikes(defender, defenseItem, attacker, defenderStrikeCount, true, defHp, atkHp, attackerMiracle);
        // 3. Defender double counter
        if (defenderDoubles) {
          doStrikes(defender, defenseItem, attacker, defenderStrikeCount, true, defHp, atkHp, attackerMiracle);
        }
      }

    } else {
      // STANDARD: attacker -> counter -> attacker double -> counter double
      // 1. Attacker initial strikes
      doStrikes(attacker, attackItem, defender, attackerStrikeCount, false, atkHp, defHp, defenderMiracle);

      // 2. Defender counter
      if (defenderCanCounter && defenseItem) {
        doStrikes(defender, defenseItem, attacker, defenderStrikeCount, true, defHp, atkHp, attackerMiracle);
      }

      // 3. Attacker double
      if (attackerDoubles) {
        doStrikes(attacker, attackItem, defender, attackerStrikeCount, false, atkHp, defHp, defenderMiracle);
      }

      // 4. Defender double counter
      if (defenderDoubles && defenseItem) {
        doStrikes(defender, defenseItem, attacker, defenderStrikeCount, true, defHp, atkHp, attackerMiracle);
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
        const r1 = this.randomRoll();
        const r2 = this.randomRoll();
        return Math.floor((r1 + r2) / 2) < hitChance;
      }

      case 'true_hit_plus': {
        const r1 = this.randomRoll();
        const r2 = this.randomRoll();
        const r3 = this.randomRoll();
        return Math.floor((r1 + r2 + r3) / 3) < hitChance;
      }

      case 'fates_hit': {
        const clamped = Math.max(0, Math.min(100, hitChance));
        const adjusted = Math.round(
          clamped + (40 / 3) * (clamped / 100) *
          Math.sin((0.02 * clamped - 1) * Math.PI),
        );
        return this.randomRoll() < adjusted;
      }

      case 'classic':
      default: {
        return this.randomRoll() < hitChance;
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
    board?: GameBoard | null,
    mode: CombatMode = isCounter ? 'defense' : 'attack',
    attackInfo: [number, number] = [0, 0],
    forcedAttackProcs?: CombatProcMark[],
  ): CombatStrike {
    const procs = this.lifecycle?.beginStrike(striker, item, target, forcedAttackProcs) ??
      { attack: [], defense: [] };
    // Compute hit chance with weapon triangle bonus
    const defWeapon = target.items.find((i) => i.isWeapon()) ?? null;
    const baseHit = calcs.computeHit(striker, item, target, db, board, undefined, mode);
    const wt = calcs.weaponTriangle(item, defWeapon, db, striker);
    const finalHit = Math.max(0, Math.min(100, baseHit + wt.hitBonus));

    // Compute crit chance
    let critChance = calcs.computeCrit(striker, item, target, db, undefined, mode);

    // critAnyway skill: ensure at least some crit chance
    if (skillSystem.critAnyway(striker) && critChance <= 0) {
      critChance = 1; // Minimal crit chance if skill is active
    }

    // Roll for hit
    // Items without a hit hook (Steal, Warp, utility staves) auto-hit in LT.
    const hit = item.hasComponent('hit') ? this.rollHit(finalHit, rngMode) : true;

    // Roll for crit (only if hit lands)
    const crit = hit ? this.randomRoll() < critChance : false;

    // Compute damage (0 on miss)
    let dmg = 0;
    if (hit) {
      const baseDmg = calcs.computeDamage(striker, item, target, db, board, undefined, mode);
      dmg = baseDmg + wt.damageBonus;

      // Crit damage
      if (crit) {
        const critDmgMod = skillSystem.modifyCritDamage(striker, item);
        const baseCritMult = 3; // LT default
        dmg = dmg * baseCritMult + critDmgMod;
      }

      dmg = Math.max(0, dmg);
    }

    const strike: CombatStrike = {
      attacker: striker,
      defender: target,
      item,
      hit,
      crit,
      damage: dmg,
      isCounter,
      mode,
      attackInfo,
      ...(procs.attack.length ? { attackProcs: procs.attack } : {}),
      ...(procs.defense.length ? { defenseProcs: procs.defense } : {}),
    };
    this.lifecycle?.endStrike(procs);
    return strike;
  }
}
