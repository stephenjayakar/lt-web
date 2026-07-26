import type { Database } from '../data/database';
import type { ItemObject } from '../objects/item';
import { SkillObject } from '../objects/skill';
import type { UnitObject } from '../objects/unit';
import type { CombatStrike } from './combat-solver';
import {
  enemyExpMultiplier,
  enemyWexpMultiplier,
  checkEnemy,
  expMultiplier,
  wexpMultiplier,
} from './skill-system';

export interface WeaponRankUp {
  rank: string;
  requirement: number;
}

export interface CombatComponentResults {
  /** Null means the item has no EXP component and fallback combat EXP should be used. */
  fixedExp: number | null;
  attackerWexpGained: number;
  attackerRankUp: WeaponRankUp | null;
  /** Item selected by a successful Steal hook; CombatState performs the reversible transfer. */
  stolenItem: ItemObject | null;
}

function addStatus(
  target: UnitObject,
  statusNid: string | undefined,
  db: Database,
  initiator?: UnitObject,
): void {
  if (!statusNid || target.skills.some((skill) => skill.nid === statusNid)) return;
  const prefab = db.skills.get(statusNid);
  if (!prefab) return;
  const skill = new SkillObject(prefab);
  // Python StatusOnHit: action.AddSkill(target, value, unit) — initiator is attacker.
  if (initiator) skill.initiatorNid = initiator.nid;
  target.skills.push(skill);
}

/** Apply item on-hit/end-combat status hooks after the strike sequence has resolved. */
function applyStrikeStatuses(strikes: CombatStrike[], db: Database): void {
  for (const strike of strikes) {
    if (!strike.hit) continue;
    for (const [componentNid, value] of strike.item.components) {
      if (componentNid === 'fatigue_on_hit') {
        const amount = Number(value);
        if (Number.isFinite(amount)) {
          strike.defender.currentFatigue = Math.max(
            0,
            (strike.defender.currentFatigue ?? 0) + amount,
          );
        }
      }
    }
  }
  for (const strike of strikes) {
    if (!strike.hit) continue;
    addStatus(
      strike.defender,
      strike.item.getComponent<string>('status_after_combat_on_hit'),
      db,
      strike.attacker,
    );
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

/** Grant WEXP to an attack-stance participant using the partner's combat item. */
export function grantPartnerCombatWexp(
  partner: UnitObject,
  item: ItemObject,
  mainTarget: UnitObject | null,
  strikes: CombatStrike[],
  partnerDead: boolean,
  deadTargets: Set<UnitObject>,
  db: Database,
): WeaponRankUp | null {
  return grantGroupWexp(
    partner, item, mainTarget, strikes, partnerDead, deadTargets, db,
  ).rankUp;
}

export function internalLevel(unit: UnitObject, db: Database): number {
  let klass = db.classes.get(unit.klass);
  if (!klass) return unit.level;
  if (klass.tier === 0) return unit.level - klass.max_level;
  if (klass.tier === 1) return unit.level;
  let result = unit.level;
  for (let remaining = 5; remaining > 0 && klass.promotes_from; remaining--) {
    const parent = db.classes.get(klass.promotes_from);
    if (!parent) break;
    result += parent.max_level;
    klass = parent;
    if (klass.tier <= 0) break;
  }
  return result;
}

function levelExp(unit: UnitObject, target: UnitObject, db: Database): number {
  const promoteReset = db.getConstant('promote_level_reset', true);
  const levelDiff = promoteReset
    ? internalLevel(target, db) - internalLevel(unit, db)
    : target.level - unit.level;
  const formula = String(db.getConstant('exp_formula', 'standard'));
  if (formula === 'gompertz') {
    const max = Number(db.getConstant('gexp_max', 30)) + 1;
    const min = Number(db.getConstant('gexp_min', 1));
    const slope = Number(db.getConstant('gexp_slope', 0.25));
    const intercept = Number(db.getConstant('gexp_intercept', 10));
    const magnitude = max - min;
    const offset = Math.log(-Math.log((intercept - min) / magnitude)) / slope;
    return min + magnitude * Math.exp(-Math.exp(-slope * (levelDiff - offset)));
  }
  if (formula === 'standard') {
    const offset = Number(db.getConstant('exp_offset', 0));
    const curve = Number(db.getConstant('exp_curve', 0.035));
    const magnitude = Number(db.getConstant('exp_magnitude', 10));
    return magnitude * Math.exp((levelDiff + offset) * curve);
  }
  return 0;
}

function modifyExp(
  value: number,
  unit: UnitObject,
  target: UnitObject,
  deadTargets: Set<UnitObject>,
  db: Database,
): number {
  const selfMultiplier = expMultiplier(unit, target);
  const enemyMultiplier = enemyExpMultiplier(target, unit);
  let result = value * selfMultiplier * enemyMultiplier;
  if (deadTargets.has(target)) {
    result *= Number(db.getConstant('kill_multiplier', 1));
    if (target.tags.includes('Boss')) {
      result += Math.trunc(Number(db.getConstant('boss_bonus', 0)) * selfMultiplier * enemyMultiplier);
    }
  }
  return result;
}

function groupComponentExp(
  attacker: UnitObject,
  item: ItemObject,
  strikes: CombatStrike[],
  attackerDead: boolean,
  deadTargets: Set<UnitObject>,
  db: Database,
): number | null {
  const hasFixed = item.hasComponent('exp');
  const hasLevel = item.hasComponent('level_exp');
  if (!hasFixed && !hasLevel) return null;
  if (attackerDead || attacker.team !== 'player') return 0;
  const hitDefenders = new Set(strikes
    .filter((strike) => strike.attacker === attacker && strike.item === item && strike.hit)
    .map((strike) => strike.defender)
    .filter((target) => !target.tags.includes('Tile')));
  const damagedDefenders = new Set(strikes
    .filter((strike) => strike.attacker === attacker && strike.item === item &&
      strike.hit && strike.damage > 0 && checkEnemy(attacker, strike.defender, db))
    .map((strike) => strike.defender)
    .filter((target) => !target.tags.includes('Tile')));
  let total = 0;
  const minExp = Number(db.getConstant('min_exp', 0));
  if (hasFixed) {
    let componentTotal = 0;
    const value = Number(item.getComponent<number>('exp') ?? 0);
    for (const defender of hitDefenders) {
      componentTotal += modifyExp(value, attacker, defender, deadTargets, db);
    }
    total += Math.max(minExp, Math.min(100, Math.floor(componentTotal)));
  }
  if (hasLevel) {
    let componentTotal = 0;
    for (const defender of damagedDefenders) {
      componentTotal += modifyExp(levelExp(attacker, defender, db), attacker, defender, deadTargets, db);
    }
    total += Math.max(minExp, Math.min(100, Math.floor(componentTotal)));
  }
  return Math.max(-100, Math.min(100, Math.trunc(total)));
}

function resolveStolenItem(
  attacker: UnitObject,
  item: ItemObject,
  defender: UnitObject,
  strikes: CombatStrike[],
): ItemObject | null {
  const steals = item.hasComponent('steal') || item.hasComponent('gba_steal') ||
    item.hasComponent('steal_con') || item.hasComponent('gimme_that') ||
    item.hasComponent('thief_staff');
  if (!steals) return null;
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
    fixedExp: groupComponentExp(attacker, attackItem, strikes, attackerDead, deadDefenders, db),
    attackerWexpGained: attackerWexp.amount,
    attackerRankUp: attackerWexp.rankUp,
    stolenItem: mainDefender
      ? resolveStolenItem(attacker, attackItem, mainDefender, strikes)
      : null,
  };
}
