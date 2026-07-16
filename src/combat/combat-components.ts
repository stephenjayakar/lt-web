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

function fixedExp(
  attacker: UnitObject,
  item: ItemObject,
  defender: UnitObject,
  strikes: CombatStrike[],
  attackerDead: boolean,
  db: Database,
): number | null {
  const value = item.getComponent<number>('exp');
  if (value === undefined) return null;
  const hit = strikes.some((strike) => strike.attacker === attacker && strike.item === item && strike.hit);
  if (attackerDead || attacker.team !== 'player' || !hit) return 0;
  const amount = Number(value) * expMultiplier(attacker, defender) * enemyExpMultiplier(defender, attacker);
  return Math.max(Number(db.getConstant('min_exp', 0)), Math.min(100, Math.floor(amount)));
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
  applyStrikeStatuses(strikes, db);
  const attackerWexp = grantWexp(
    attacker, attackItem, defender, strikes, attackerDead, defenderDead, db,
  );
  if (defenseItem) {
    grantWexp(defender, defenseItem, attacker, strikes, defenderDead, attackerDead, db);
  }
  return {
    fixedExp: fixedExp(attacker, attackItem, defender, strikes, attackerDead, db),
    attackerWexpGained: attackerWexp.amount,
    attackerRankUp: attackerWexp.rankUp,
  };
}
