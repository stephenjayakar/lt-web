import type { UnitObject } from '../objects/unit';
import type { ItemObject } from '../objects/item';
import type { Database } from '../data/database';
import * as itemSystem from './item-system';
import * as skillSystem from './skill-system';

// ============================================================
// CombatCalcs - All combat calculation formulas.
// Matches LT's combat_calcs.py formulas.
// Now wired through item-system.ts and skill-system.ts dispatch.
// ============================================================

// ------------------------------------------------------------------
// Stat name tokens recognised in equation strings
// ------------------------------------------------------------------

const STAT_NAMES = [
  'HP', 'STR', 'MAG', 'SKL', 'SPD', 'LCK', 'DEF', 'RES', 'CON', 'MOV',
];

// ------------------------------------------------------------------
// Expression evaluator
// ------------------------------------------------------------------

/**
 * Evaluate a simple equation string with stat substitution.
 *
 * Replaces stat name tokens (HP, STR, MAG, ...) with the unit's stat
 * values, converts Python-style `//` (integer division) to
 * `Math.floor(a/b)`, and wraps bare `max`/`min` calls with `Math.max`
 * / `Math.min` before evaluating.
 *
 * Handles basic math ops: +, -, *, /, //, %, max(), min().
 */
export function evaluateEquation(expr: string, unit: UnitObject): number {
  let processed = expr;

  // Replace stat tokens with their numeric values.
  // Sort longest-first so e.g. "SPEED" doesn't partially match "SPD".
  // Use word-boundary regex to avoid false positives.
  const sortedStats = [...STAT_NAMES].sort((a, b) => b.length - a.length);
  for (const stat of sortedStats) {
    const re = new RegExp(`\\b${stat}\\b`, 'g');
    processed = processed.replace(re, String(unit.getStatValue(stat)));
  }

  // Convert Python-style integer division `//` to Math.floor.
  // We iteratively replace `a // b` patterns.  This handles simple
  // cases like `12 // 2` after stat substitution.
  processed = processed.replace(
    /(\b[\d.]+)\s*\/\/\s*([\d.]+\b)/g,
    (_match, a, b) => `Math.floor((${a})/(${b}))`,
  );

  // Wrap bare max/min with Math. prefix (only if not already prefixed).
  processed = processed.replace(/(?<!Math\.)(?<![\w.])\bmax\b/g, 'Math.max');
  processed = processed.replace(/(?<!Math\.)(?<![\w.])\bmin\b/g, 'Math.min');

  try {
    // Safe-ish evaluation via Function constructor (only numeric math).
    const fn = new Function('Math', `"use strict"; return (${processed});`);
    const result = fn(Math);
    return typeof result === 'number' && Number.isFinite(result)
      ? Math.floor(result)
      : 0;
  } catch {
    console.warn(`CombatCalcs: failed to evaluate equation "${expr}" -> "${processed}"`);
    return 0;
  }
}

// ------------------------------------------------------------------
// Helper: resolve an equation from the DB, falling back to a default
// ------------------------------------------------------------------

function resolveEquation(
  db: Database,
  eqName: string,
  defaultExpr: string,
  unit: UnitObject,
): number {
  const expr = db.getEquation(eqName) ?? defaultExpr;
  return evaluateEquation(expr, unit);
}

// ------------------------------------------------------------------
// Damage type helpers
// ------------------------------------------------------------------

function isMagic(item: ItemObject): boolean {
  // LT convention: if the weapon has a "magic" or "magic_at_range"
  // component it deals magic damage.  Also check weapon_type for
  // known magical types.
  if (item.hasComponent('magic') || item.hasComponent('magic_at_range')) {
    return true;
  }
  const wtype = item.getWeaponType();
  if (wtype) {
    const lower = wtype.toLowerCase();
    if (
      lower === 'dark' ||
      lower === 'light' ||
      lower === 'anima' ||
      lower === 'tome' ||
      lower === 'fire' ||
      lower === 'thunder' ||
      lower === 'wind' ||
      lower === 'staff'
    ) {
      return true;
    }
  }
  return false;
}

// ------------------------------------------------------------------
// Core formulas (now with component dispatch)
// ------------------------------------------------------------------

/** Calculate hit rate for an attacker. */
export function accuracy(unit: UnitObject, item: ItemObject, db: Database): number {
  // Check for skill formula override
  const formulaOverride = skillSystem.accuracyFormula(unit);
  const eqName = formulaOverride ?? 'HIT';

  const baseHit = resolveEquation(db, eqName, 'SKL * 2 + LCK // 2', unit);
  const itemHit = item.getHit();

  // Add item + skill static modifiers
  const itemMod = itemSystem.modifyAccuracy(unit, item);
  const skillMod = skillSystem.modifyAccuracy(unit, item);

  return baseHit + itemHit + itemMod + skillMod;
}

/** Calculate avoid for a defender. */
export function avoid(unit: UnitObject, db: Database): number {
  // Check for skill formula override
  const formulaOverride = skillSystem.avoidFormula(unit);
  const eqName = formulaOverride ?? 'AVOID';

  // Avoid uses AS (attack speed), which factors in equipped weapon weight.
  const equippedWeapon = unit.items.find((i) => i.isWeapon()) ?? null;
  const weaponWeight = equippedWeapon ? equippedWeapon.getWeight() : 0;
  const spd = unit.getStatValue('SPD');
  const con = unit.getStatValue('CON');
  const as = spd - Math.max(0, weaponWeight - con);

  const avoidExpr = db.getEquation(eqName) ?? 'SPD * 2 + LCK // 2';
  // Replace SPD with AS value in the avoid formula
  const processed = avoidExpr.replace(/\bSPD\b/g, String(as));
  const baseAvoid = evaluateEquation(processed, unit);

  // Add skill static modifier
  const skillMod = skillSystem.modifyAvoid(unit, equippedWeapon);

  return baseAvoid + skillMod;
}

/** Calculate damage output. */
export function damage(unit: UnitObject, item: ItemObject, db: Database): number {
  // Check for skill formula override
  const formulaOverride = skillSystem.damageFormula(unit);

  const magic = isMagic(item);
  const defaultExpr = magic ? 'MAG' : 'STR';
  const eqName = formulaOverride ?? 'DAMAGE';
  const baseDmg = resolveEquation(db, eqName, defaultExpr, unit);
  const itemDmg = item.getDamage();

  // Add item + skill static modifiers
  const itemMod = itemSystem.modifyDamage(unit, item);
  const skillMod = skillSystem.modifyDamage(unit, item);

  return baseDmg + itemDmg + itemMod + skillMod;
}

/** Calculate defense/resistance against an incoming attack item. */
export function defense(unit: UnitObject, attackItem: ItemObject, db: Database): number {
  // Check for skill formula override
  const formulaOverride = skillSystem.resistFormula(unit);

  const magic = isMagic(attackItem);
  const defaultExpr = magic ? 'RES' : 'DEF';
  const eqName = formulaOverride ?? (magic ? 'MAGIC_DEFENSE' : 'DEFENSE');
  const baseDef = resolveEquation(db, eqName, defaultExpr, unit);

  // Add skill static modifier for resist
  const skillMod = skillSystem.modifyResist(unit, null);

  return baseDef + skillMod;
}

/** Calculate attack speed (for doubling checks). */
export function attackSpeed(unit: UnitObject, item: ItemObject, db: Database): number {
  // Check for skill formula override
  const formulaOverride = skillSystem.attackSpeedFormula(unit);

  const spd = unit.getStatValue('SPD');
  const con = unit.getStatValue('CON');
  const weight = item.getWeight();

  let baseAS: number;

  // Try DB equation first
  const asExpr = db.getEquation(formulaOverride ?? 'ATTACK_SPEED');
  if (asExpr) {
    // Replace 'weight' token if present
    const processed = asExpr.replace(/\bweight\b/gi, String(weight));
    baseAS = evaluateEquation(processed, unit);
  } else {
    // Default: SPD - max(0, weight - CON)
    baseAS = spd - Math.max(0, weight - con);
  }

  // Add item + skill static modifiers
  const itemMod = itemSystem.modifyAttackSpeed(unit, item);
  const skillMod = skillSystem.modifyAttackSpeed(unit, item);

  return baseAS + itemMod + skillMod;
}

/** Calculate defense speed (for doubling checks on the defender side). */
export function defenseSpeed(unit: UnitObject, item: ItemObject, db: Database): number {
  // Check for skill formula override
  const formulaOverride = skillSystem.defenseSpeedFormula(unit);

  // If there's a dedicated defense speed formula, use it; otherwise same as attack speed
  const asExpr = db.getEquation(formulaOverride ?? 'DEFENSE_SPEED');
  if (asExpr) {
    const weight = item.getWeight();
    const processed = asExpr.replace(/\bweight\b/gi, String(weight));
    const base = evaluateEquation(processed, unit);
    const skillMod = skillSystem.modifyDefenseSpeed(unit, item);
    return base + skillMod;
  }

  // Fallback: use attack speed + defense speed modifier from skills
  const base = attackSpeed(unit, item, db);
  const defSpeedMod = skillSystem.modifyDefenseSpeed(unit, item);
  return base + defSpeedMod;
}

// ------------------------------------------------------------------
// Composite formulas (with dynamic modifiers + multipliers)
// ------------------------------------------------------------------

/**
 * Compute final hit chance (attacker accuracy - defender avoid, clamped 0-100).
 * Includes dynamic modifiers from items and skills.
 */
export function computeHit(
  attacker: UnitObject,
  attackItem: ItemObject,
  defender: UnitObject,
  db: Database,
): number {
  const acc = accuracy(attacker, attackItem, db);
  const avo = avoid(defender, db);

  // Dynamic modifiers from items and skills (combat context)
  const defWeapon = defender.items.find((i) => i.isWeapon()) ?? null;
  const itemDynAcc = itemSystem.dynamicAccuracy(attacker, attackItem, defender, defWeapon, 'attack', null, acc);
  const skillDynAcc = skillSystem.dynamicAccuracy(attacker, attackItem, defender, defWeapon, 'attack', null, acc);
  const skillDynAvo = skillSystem.dynamicAvoid(defender, defWeapon, attacker, attackItem, 'defense', null, avo);

  const raw = acc + itemDynAcc + skillDynAcc - avo - skillDynAvo;
  return Math.max(0, Math.min(100, raw));
}

/**
 * Compute final damage (attacker damage - defender defense, min 0).
 * Includes dynamic modifiers, effective damage, and multipliers.
 */
export function computeDamage(
  attacker: UnitObject,
  attackItem: ItemObject,
  defender: UnitObject,
  db: Database,
): number {
  const atk = damage(attacker, attackItem, db);
  const def = defense(defender, attackItem, db);

  // Dynamic modifiers from items and skills
  const defWeapon = defender.items.find((i) => i.isWeapon()) ?? null;
  const baseDmg = atk - def;

  const itemDynDmg = itemSystem.dynamicDamage(attacker, attackItem, defender, defWeapon, 'attack', null, baseDmg);
  const skillDynDmg = skillSystem.dynamicDamage(attacker, attackItem, defender, defWeapon, 'attack', null, baseDmg);
  const skillDynResist = skillSystem.dynamicResist(defender, defWeapon, attacker, attackItem, 'defense', null, def);

  let finalDmg = baseDmg + itemDynDmg + skillDynDmg - skillDynResist;

  // Apply damage multiplier from attacker skills
  const dmgMult = skillSystem.damageMultiplier(attacker, attackItem, defender, defWeapon, 'attack', null, finalDmg);
  finalDmg = Math.floor(finalDmg * dmgMult);

  // Apply resist multiplier from defender skills
  const resMult = skillSystem.resistMultiplier(defender, defWeapon, attacker, attackItem, 'defense', null, finalDmg);
  if (resMult !== 1) {
    finalDmg = Math.floor(finalDmg / resMult);
  }

  return Math.max(0, finalDmg);
}

/**
 * Check if attacker doubles defender.
 * Now checks item canDouble and skill noDouble/defDouble.
 */
export function canDouble(
  attacker: UnitObject,
  attackItem: ItemObject,
  defender: UnitObject,
  defenseItem: ItemObject | null,
  db: Database,
): boolean {
  // Item can't double? (e.g., cannot_double component)
  if (!itemSystem.canDouble(attacker, attackItem)) return false;

  // Skill prevents doubling?
  if (skillSystem.noDouble(attacker)) return false;

  const attackerAS = attackSpeed(attacker, attackItem, db);

  // Use defense speed for the defender's side
  const defenderWeapon = defenseItem ?? defender.items.find((i) => i.isWeapon()) ?? null;
  const defenderAS = defenderWeapon
    ? defenseSpeed(defender, defenderWeapon, db)
    : defender.getStatValue('SPD');

  const thresholdExpr = db.getEquation('SPEED_TO_DOUBLE');
  const threshold = thresholdExpr ? evaluateEquation(thresholdExpr, attacker) : 4;

  return attackerAS - defenderAS >= threshold;
}

/**
 * Check if defender can counter-double (double on the counter).
 * Only possible if defender has defDouble skill or via normal speed comparison.
 */
export function canDefenderDouble(
  attacker: UnitObject,
  attackItem: ItemObject,
  defender: UnitObject,
  defenseItem: ItemObject,
  db: Database,
): boolean {
  // defDouble skill allows the defender to double
  if (skillSystem.defDouble(defender)) {
    return canDouble(defender, defenseItem, attacker, attackItem, db);
  }
  // Standard: defender can double if their AS exceeds the attacker's
  return canDouble(defender, defenseItem, attacker, attackItem, db);
}

/**
 * Check if defender can counterattack.
 * Now checks distant_counter, close_counter, and item canCounter/canBeCountered.
 */
export function canCounterattack(
  attacker: UnitObject,
  attackItem: ItemObject,
  defender: UnitObject,
  _db: Database,
): boolean {
  // Check if attacker's weapon can't be countered
  if (!itemSystem.canBeCountered(attacker, attackItem)) return false;

  // Check if defender's skills prevent countering
  if (!skillSystem.canCounter(defender)) return false;

  // Find the defender's equipped weapon
  const defWeapon = defender.items.find((i) => i.isWeapon());
  if (!defWeapon) return false;

  // Check if the weapon itself can counter
  if (!itemSystem.canCounter(defender, defWeapon)) return false;

  // Compute the Manhattan distance between the two units
  const aPos = attacker.position;
  const dPos = defender.position;
  if (!aPos || !dPos) return false;

  const dist = Math.abs(aPos[0] - dPos[0]) + Math.abs(aPos[1] - dPos[1]);

  // Check if defender has distant_counter (can counter at any range)
  if (skillSystem.distantCounter(defender)) return true;

  // Check if defender has close_counter (can counter at range 1 with ranged weapon)
  if (dist === 1 && skillSystem.closeCounter(defender)) return true;

  // Standard range check: defender can counter if distance is within their weapon's range
  const minRange = defWeapon.getMinRange();
  const maxRange = defWeapon.getMaxRange();
  return dist >= minRange && dist <= maxRange;
}

/**
 * Get weapon triangle advantage bonus.
 * Now checks ignoreWeaponAdvantage from items.
 */
export function weaponTriangle(
  attackItem: ItemObject,
  defenseItem: ItemObject | null,
  db: Database,
  attacker?: UnitObject,
): { hitBonus: number; damageBonus: number } {
  const noBonus = { hitBonus: 0, damageBonus: 0 };
  if (!defenseItem) return noBonus;

  // Check if either item ignores weapon advantage
  if (attacker && itemSystem.ignoreWeaponAdvantage(attacker, attackItem)) return noBonus;

  const atkType = attackItem.getWeaponType();
  const defType = defenseItem.getWeaponType();
  if (!atkType || !defType) return noBonus;

  // Look up the attacker's weapon type definition
  const atkWeaponDef = db.weapons.find((w) => w.nid === atkType);
  if (!atkWeaponDef) return noBonus;

  // Check advantages
  for (const adv of atkWeaponDef.advantage) {
    if (adv.weapon_type === defType) {
      return {
        hitBonus: parseNumericValue(adv.accuracy),
        damageBonus: parseNumericValue(adv.damage),
      };
    }
  }

  // Check disadvantages
  // Note: disadvantage entries already store negative values in the data
  // (e.g. damage: "-1", accuracy: "-15"), so we use them directly.
  for (const dis of atkWeaponDef.disadvantage) {
    if (dis.weapon_type === defType) {
      return {
        hitBonus: parseNumericValue(dis.accuracy),
        damageBonus: parseNumericValue(dis.damage),
      };
    }
  }

  return noBonus;
}

/** Parse a numeric value from a weapon advantage string (may be a number or equation). */
function parseNumericValue(value: string): number {
  const n = Number(value);
  if (Number.isFinite(n)) return n;
  return 0;
}

/**
 * Compute crit rate.
 * Crit = attacker crit - defender crit avoid, clamped 0-100.
 * Now includes item + skill crit modifiers.
 */
export function computeCrit(
  attacker: UnitObject,
  attackItem: ItemObject,
  defender: UnitObject,
  db: Database,
): number {
  const baseCrit = resolveEquation(db, 'CRIT', 'SKL // 2', attacker);
  const itemCrit = attackItem.getComponent<number>('crit') ?? 0;
  const critAvoid = resolveEquation(db, 'CRIT_AVOID', 'LCK', defender);

  // Skill modifiers
  const skillCritAcc = skillSystem.modifyCritAccuracy(attacker, attackItem);
  const skillCritAvo = skillSystem.modifyCritAvoid(defender, null);

  // Item crit modifier
  const itemCritMod = itemSystem.modifyCritAccuracy(attacker, attackItem);

  const raw = baseCrit + itemCrit + skillCritAcc + itemCritMod - critAvoid - skillCritAvo;
  return Math.max(0, Math.min(100, raw));
}

/**
 * Compute the number of strikes for one side (base + brave + dynamic multiattacks).
 */
export function computeStrikeCount(
  unit: UnitObject,
  item: ItemObject,
  target: UnitObject,
  defenseItem: ItemObject | null,
): number {
  let count = 1;

  // Brave from items
  const itemExtra = itemSystem.dynamicMultiattacks(unit, item, target, defenseItem, 'attack', null, 0);
  count += itemExtra;

  // Dynamic multiattacks from skills
  const skillExtra = skillSystem.dynamicMultiattacks(unit, item, target, defenseItem, 'attack', null, 0);
  count += skillExtra;

  return count;
}

// ------------------------------------------------------------------
// Legacy convenience wrappers (used by AI / other subsystems)
// ------------------------------------------------------------------

/** Get the first usable weapon from a unit's inventory. */
export function getEquippedWeapon(unit: UnitObject): ItemObject | null {
  for (const item of unit.items) {
    if (item.isWeapon()) return item;
  }
  return null;
}
