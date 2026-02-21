import type { UnitObject } from '../objects/unit';
import type { ItemObject } from '../objects/item';
import type { Database } from '../data/database';

// ============================================================
// CombatCalcs - All combat calculation formulas.
// Matches LT's combat_calcs.py formulas.
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
// Core formulas
// ------------------------------------------------------------------

/** Calculate hit rate for an attacker. */
export function accuracy(unit: UnitObject, item: ItemObject, db: Database): number {
  const baseHit = resolveEquation(db, 'HIT', 'SKL * 2 + LCK // 2', unit);
  return baseHit + item.getHit();
}

/** Calculate avoid for a defender. */
export function avoid(unit: UnitObject, db: Database): number {
  // Avoid uses AS (attack speed), which factors in equipped weapon weight.
  // Default: SPD*2 + LCK//2  (but SPD here means AS)
  const equippedWeapon = unit.items.find((i) => i.isWeapon());
  const weaponWeight = equippedWeapon ? equippedWeapon.getWeight() : 0;
  const spd = unit.getStatValue('SPD');
  const con = unit.getStatValue('CON');
  const as = spd - Math.max(0, weaponWeight - con);

  const avoidExpr = db.getEquation('AVOID') ?? 'SPD * 2 + LCK // 2';
  // Replace SPD with AS value in the avoid formula
  const processed = avoidExpr.replace(/\bSPD\b/g, String(as));
  return evaluateEquation(processed, unit);
}

/** Calculate damage output. */
export function damage(unit: UnitObject, item: ItemObject, db: Database): number {
  const magic = isMagic(item);
  const defaultExpr = magic ? 'MAG' : 'STR';
  const baseDmg = resolveEquation(db, 'DAMAGE', defaultExpr, unit);
  return baseDmg + item.getDamage();
}

/** Calculate defense/resistance against an incoming attack item. */
export function defense(unit: UnitObject, attackItem: ItemObject, db: Database): number {
  const magic = isMagic(attackItem);
  const defaultExpr = magic ? 'RES' : 'DEF';
  return resolveEquation(db, magic ? 'MAGIC_DEFENSE' : 'DEFENSE', defaultExpr, unit);
}

/** Calculate attack speed (for doubling checks). */
export function attackSpeed(unit: UnitObject, item: ItemObject, db: Database): number {
  const spd = unit.getStatValue('SPD');
  const con = unit.getStatValue('CON');
  const weight = item.getWeight();

  // Try DB equation first
  const asExpr = db.getEquation('ATTACK_SPEED');
  if (asExpr) {
    // Replace 'weight' token if present
    const processed = asExpr.replace(/\bweight\b/gi, String(weight));
    return evaluateEquation(processed, unit);
  }

  // Default: SPD - max(0, weight - CON)
  return spd - Math.max(0, weight - con);
}

// ------------------------------------------------------------------
// Composite formulas
// ------------------------------------------------------------------

/**
 * Compute final hit chance (attacker accuracy - defender avoid, clamped 0-100).
 */
export function computeHit(
  attacker: UnitObject,
  attackItem: ItemObject,
  defender: UnitObject,
  db: Database,
): number {
  const acc = accuracy(attacker, attackItem, db);
  const avo = avoid(defender, db);
  const raw = acc - avo;
  return Math.max(0, Math.min(100, raw));
}

/**
 * Compute final damage (attacker damage - defender defense, min 0).
 */
export function computeDamage(
  attacker: UnitObject,
  attackItem: ItemObject,
  defender: UnitObject,
  db: Database,
): number {
  const atk = damage(attacker, attackItem, db);
  const def = defense(defender, attackItem, db);
  return Math.max(0, atk - def);
}

/**
 * Check if attacker doubles defender.
 * Attacker doubles when their AS exceeds the defender's AS by at least
 * the SPEED_TO_DOUBLE threshold (default 4).
 */
export function canDouble(
  attacker: UnitObject,
  attackItem: ItemObject,
  defender: UnitObject,
  defenseItem: ItemObject | null,
  db: Database,
): boolean {
  const attackerAS = attackSpeed(attacker, attackItem, db);
  const defenderWeapon = defenseItem ?? defender.items.find((i) => i.isWeapon());
  const defenderAS = defenderWeapon
    ? attackSpeed(defender, defenderWeapon, db)
    : defender.getStatValue('SPD');

  const thresholdExpr = db.getEquation('SPEED_TO_DOUBLE');
  const threshold = thresholdExpr ? evaluateEquation(thresholdExpr, attacker) : 4;

  return attackerAS - defenderAS >= threshold;
}

/**
 * Check if defender can counterattack.
 * Defender must have a weapon equipped, and the attack distance must
 * be within the weapon's range.
 */
export function canCounterattack(
  attacker: UnitObject,
  attackItem: ItemObject,
  defender: UnitObject,
  _db: Database,
): boolean {
  // Find the defender's equipped weapon
  const defWeapon = defender.items.find((i) => i.isWeapon());
  if (!defWeapon) return false;

  // Compute the Manhattan distance between the two units
  const aPos = attacker.position;
  const dPos = defender.position;
  if (!aPos || !dPos) return false;

  const dist = Math.abs(aPos[0] - dPos[0]) + Math.abs(aPos[1] - dPos[1]);

  // Defender can counter if the distance is within their weapon's range
  const minRange = defWeapon.getMinRange();
  const maxRange = defWeapon.getMaxRange();
  return dist >= minRange && dist <= maxRange;
}

/**
 * Get weapon triangle advantage bonus.
 *
 * Looks up the attacker's weapon type advantages/disadvantages against
 * the defender's weapon type in the database weapon definitions.
 * Returns hit and damage bonuses (can be negative for disadvantage).
 */
export function weaponTriangle(
  attackItem: ItemObject,
  defenseItem: ItemObject | null,
  db: Database,
): { hitBonus: number; damageBonus: number } {
  const noBonus = { hitBonus: 0, damageBonus: 0 };
  if (!defenseItem) return noBonus;

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

  const raw = baseCrit + itemCrit - critAvoid;
  return Math.max(0, Math.min(100, raw));
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
