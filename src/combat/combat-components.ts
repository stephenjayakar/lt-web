import type { Database } from '../data/database';
import type { ItemObject } from '../objects/item';
import { SkillObject } from '../objects/skill';
import type { UnitObject } from '../objects/unit';
import type { CombatStrike } from './combat-solver';
import {
  enemyExpMultiplier,
  enemyWexpMultiplier,
  expMultiplier,
  wexpMultiplier,
} from './skill-system';

export interface WeaponRankUp {
  rank: string;
  requirement: number;
}

export interface CombatComponentResults {
  /** Null means the item has no fixed EXP component and normal combat EXP should be used. */
  fixedExp: number | null;
  attackerWexpGained: number;
  attackerRankUp: WeaponRankUp | null;
  /** Item selected by a successful Steal hook; CombatState performs the reversible transfer. */
  stolenItem: ItemObject | null;
}

function addStatus(target: UnitObject, statusNid: string | undefined, db: Database): void {
  if (!statusNid || target.skills.some((skill) => skill.nid === statusNid)) return;
  const prefab = db.skills.get(statusNid);
  if (prefab) target.skills.push(new SkillObject(prefab));
}

/** Apply item on-hit/end-combat status hooks after the strike sequence has resolved. */
function applyStrikeStatuses(strikes: CombatStrike[], db: Database): void {
  for (const strike of strikes) {
    if (!strike.hit) continue;
    addStatus(strike.defender, strike.item.getComponent<string>('status_on_hit'), db);
  }
  for (const strike of strikes) {
    if (!strike.hit) continue;
    addStatus(strike.defender, strike.item.getComponent<string>('status_after_combat_on_hit'), db);
  }
}

function weaponExpCap(unit: UnitObject, weaponType: string, db: Database): number {
  const klass = db.classes.get(unit.klass);
  const entry = klass?.wexp_gain?.[weaponType];
  return Array.isArray(entry) && Number.isFinite(entry[2])
    ? Math.max(0, Number(entry[2]))
    : Number.MAX_SAFE_INTEGER;
}

function grantWexp(
  unit: UnitObject,
  item: ItemObject,
  target: UnitObject,
  strikes: CombatStrike[],
  unitDead: boolean,
  targetDead: boolean,
  db: Database,
): { amount: number; rankUp: WeaponRankUp | null } {
  const weaponType = item.getComponent<string>('weapon_type');
  if (!weaponType || unitDead || (!item.isWeapon() && !item.hasComponent('spell'))) {
    return { amount: 0, rankUp: null };
  }
  const marks = strikes.filter((strike) =>
    strike.attacker === unit && strike.item === item &&
    (strike.hit || db.getConstant('miss_wexp', false)),
  );
  if (marks.length === 0) return { amount: 0, rankUp: null };

  const base = Number(item.getComponent<number>('wexp') ?? 1);
  const markCount = db.getConstant('double_wexp', false) ? marks.length : 1;
  const killMultiplier = targetDead && db.getConstant('kill_wexp', false) ? 2 : 1;
  const multiplier = wexpMultiplier(unit, target) * enemyWexpMultiplier(target, unit);
  const amount = Math.max(0, Math.floor(base * markCount * killMultiplier * multiplier));
  if (amount === 0) return { amount: 0, rankUp: null };

  const oldWexp = unit.wexp[weaponType] ?? 0;
  unit.wexp[weaponType] = Math.min(weaponExpCap(unit, weaponType, db), oldWexp + amount);
  const rankUp = [...db.weaponRanks].reverse().find((rank) =>
    oldWexp < rank.requirement && unit.wexp[weaponType] >= rank.requirement,
  ) ?? null;
  return { amount: unit.wexp[weaponType] - oldWexp, rankUp };
}

function grantGroupWexp(
  unit: UnitObject,
  item: ItemObject,
  mainTarget: UnitObject | null,
  strikes: CombatStrike[],
  unitDead: boolean,
  deadTargets: Set<UnitObject>,
  db: Database,
): { amount: number; rankUp: WeaponRankUp | null } {
  const weaponType = item.getComponent<string>('weapon_type');
  if (!weaponType || unitDead || (!item.isWeapon() && !item.hasComponent('spell'))) {
    return { amount: 0, rankUp: null };
  }
  const marks = strikes.filter((strike) =>
    strike.attacker === unit && strike.item === item &&
    (strike.hit || db.getConstant('miss_wexp', false)),
  );
  if (marks.length === 0) return { amount: 0, rankUp: null };

  const base = Number(item.getComponent<number>('wexp') ?? 1);
  let rawAmount = 0;
  if (db.getConstant('double_wexp', false)) {
    for (const mark of marks) {
      const target = mark.defender;
      const killMultiplier = deadTargets.has(target) && db.getConstant('kill_wexp', false) ? 2 : 1;
      rawAmount += base * killMultiplier *
        wexpMultiplier(unit, target) * enemyWexpMultiplier(target, unit);
    }
  } else {
    const killMultiplier = db.getConstant('kill_wexp', false) &&
      marks.some((mark) => deadTargets.has(mark.defender)) ? 2 : 1;
    const multiplier = mainTarget
      ? wexpMultiplier(unit, mainTarget) * enemyWexpMultiplier(mainTarget, unit)
      : wexpMultiplier(unit, null);
    rawAmount = base * killMultiplier * multiplier;
  }
  const amount = Math.max(0, Math.floor(rawAmount));
  if (amount === 0) return { amount: 0, rankUp: null };

  const oldWexp = unit.wexp[weaponType] ?? 0;
  unit.wexp[weaponType] = Math.min(weaponExpCap(unit, weaponType, db), oldWexp + amount);
  const rankUp = [...db.weaponRanks].reverse().find((rank) =>
    oldWexp < rank.requirement && unit.wexp[weaponType] >= rank.requirement,
  ) ?? null;
  return { amount: unit.wexp[weaponType] - oldWexp, rankUp };
}

function groupFixedExp(
  attacker: UnitObject,
  item: ItemObject,
  strikes: CombatStrike[],
  attackerDead: boolean,
  deadTargets: Set<UnitObject>,
  db: Database,
): number | null {
  const value = item.getComponent<number>('exp');
  if (value === undefined) return null;
  if (attackerDead || attacker.team !== 'player') return 0;
  const defenders = new Set(strikes
    .filter((strike) => strike.attacker === attacker && strike.item === item && strike.hit)
    .map((strike) => strike.defender)
    .filter((target) => !target.tags.includes('Tile')));
  if (defenders.size === 0) return 0;
  let total = 0;
  for (const defender of defenders) {
    const selfMultiplier = expMultiplier(attacker, defender);
    const enemyMultiplier = enemyExpMultiplier(defender, attacker);
    let amount = Number(value) * selfMultiplier * enemyMultiplier;
    if (deadTargets.has(defender)) {
      amount *= Number(db.getConstant('kill_multiplier', 1));
      if (defender.tags.includes('Boss')) {
        amount += Number(db.getConstant('boss_bonus', 0)) * selfMultiplier * enemyMultiplier;
      }
    }
    total += amount;
  }
  return Math.max(Number(db.getConstant('min_exp', 0)), Math.min(100, Math.floor(total)));
}

function resolveStolenItem(
  attacker: UnitObject,
  item: ItemObject,
  defender: UnitObject,
  strikes: CombatStrike[],
): ItemObject | null {
  if (!item.hasComponent('steal') && !item.hasComponent('gba_steal')) return null;
  const targetItem = item.data.get('target_item') as ItemObject | undefined;
  item.data.delete('target_item');
  const hit = strikes.some((strike) => strike.attacker === attacker && strike.item === item && strike.hit);
  return hit && targetItem && defender.items.includes(targetItem) ? targetItem : null;
}

/** Resolve component hooks shared by map and full-animation combat. */
export function applyCombatComponents(
  attacker: UnitObject,
  attackItem: ItemObject,
  defender: UnitObject,
  defenseItem: ItemObject | null,
  strikes: CombatStrike[],
  attackerDead: boolean,
  defenderDead: boolean,
  db: Database,
): CombatComponentResults {
  return applyGroupCombatComponents(
    attacker,
    attackItem,
    defender,
    defenseItem,
    strikes,
    attackerDead,
    new Set(defenderDead ? [defender] : []),
    db,
  );
}

/** Resolve hooks and aggregate rewards across a main+splash defender group. */
export function applyGroupCombatComponents(
  attacker: UnitObject,
  attackItem: ItemObject,
  mainDefender: UnitObject | null,
  defenseItem: ItemObject | null,
  strikes: CombatStrike[],
  attackerDead: boolean,
  deadDefenders: Set<UnitObject>,
  db: Database,
): CombatComponentResults {
  applyStrikeStatuses(strikes, db);
  const attackerWexp = grantGroupWexp(
    attacker, attackItem, mainDefender, strikes, attackerDead, deadDefenders, db,
  );
  if (mainDefender && defenseItem) {
    grantWexp(
      mainDefender,
      defenseItem,
      attacker,
      strikes,
      deadDefenders.has(mainDefender),
      attackerDead,
      db,
    );
  }
  return {
    fixedExp: groupFixedExp(attacker, attackItem, strikes, attackerDead, deadDefenders, db),
    attackerWexpGained: attackerWexp.amount,
    attackerRankUp: attackerWexp.rankUp,
    stolenItem: mainDefender
      ? resolveStolenItem(attacker, attackItem, mainDefender, strikes)
      : null,
  };
}
