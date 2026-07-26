import type { UnitObject } from '../objects/unit';
import type { ItemObject } from '../objects/item';
import type { Database } from '../data/database';
import type { GameBoard } from '../objects/game-board';
import * as itemSystem from './item-system';
import * as skillSystem from './skill-system';
import { getTerrainBonusesForUnit } from './terrain-bonuses';
import type { SupportEffect } from '../engine/support-system';

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
// Lazy game/db reference for equation context
// ------------------------------------------------------------------

let _eqGameRef: (() => any) | null = null;

/** Set the game reference getter for equation evaluation context. */
export function setEquationGameRef(getter: () => any): void {
  _eqGameRef = getter;
}

// ------------------------------------------------------------------
// Expression evaluator
// ------------------------------------------------------------------

/**
 * Extended equation evaluation context. When provided, allows equations
 * to reference other named equations, game constants, query functions,
 * and additional variables beyond bare stat tokens.
 */
interface EquationContext {
  /** Secondary unit for two-unit equations (e.g., combat formulas). */
  unit2?: UnitObject | null;
  /** Specific item context (e.g., for item component expressions). */
  item?: ItemObject | null;
  /** Database for equation/constant lookups. */
  db?: Database | null;
}

// ------------------------------------------------------------------
// Shared expression-rewrite helpers (used by evaluateEquation and
// evaluateEquationCondition so conditions stay in parity with equations)
// ------------------------------------------------------------------

/**
 * Rewrite every Python floor-division `//` into `Math.floor((L)/(R))`.
 *
 * Operates on the post-substitution expression where stat tokens and
 * equation nids have already been replaced by numeric literals. For each
 * `//` occurrence the left operand is found by walking back over a balanced
 * parenthesised group, identifier, or numeric literal; the right operand
 * symmetrically walks forward. Repeats until no `//` remains.
 *
 * The previous regex `/(\b[\d.]+)\s*\/\/\s*([\d.]+\b)/g` only matched numeric
 * literals on both sides, so any compound left operand such as `(HP - 10)//2`
 * survived untouched and the trailing `//...` parsed as a JS line comment,
 * silently truncating the expression (broke `RATING`, `MAGIC_RANGE`, etc.).
 */
function rewriteFloorDiv(expr: string): string {
  let out = expr;
  for (let iter = 0; iter < 1024; iter++) {
    const idx = out.indexOf('//');
    if (idx === -1) break;

    // --- Walk back over the left operand ---
    let i = idx - 1;
    while (i >= 0 && (out[i] === ' ' || out[i] === '\t' || out[i] === '\n')) i--;
    let leftStart: number;
    if (i >= 0 && out[i] === ')') {
      let depth = 1;
      i--;
      while (i >= 0 && depth > 0) {
        if (out[i] === ')') depth++;
        else if (out[i] === '(') depth--;
        if (depth === 0) break;
        i--;
      }
      leftStart = i;
    } else {
      while (i >= 0 && /[A-Za-z0-9_.]/.test(out[i])) i--;
      leftStart = i + 1;
    }

    // --- Walk forward over the right operand ---
    let j = idx + 2;
    while (j < out.length && (out[j] === ' ' || out[j] === '\t' || out[j] === '\n')) j++;
    let rightEnd: number;
    if (j < out.length && out[j] === '(') {
      let depth = 1;
      j++;
      while (j < out.length && depth > 0) {
        if (out[j] === '(') depth++;
        else if (out[j] === ')') depth--;
        if (depth === 0) break;
        j++;
      }
      rightEnd = j + 1;
    } else {
      while (j < out.length && /[A-Za-z0-9_.]/.test(out[j])) j++;
      rightEnd = j;
    }

    if (leftStart >= idx || rightEnd <= idx + 2) {
      // Malformed — bail to avoid an infinite loop.
      return out;
    }
    const left = out.slice(leftStart, idx).trim();
    const right = out.slice(idx + 2, rightEnd).trim();
    const replacement = `Math.floor((${left})/(${right}))`;
    out = out.slice(0, leftStart) + replacement + out.slice(rightEnd);
  }
  return out;
}

/** Python truthiness for the condition-eval path. */
function _pythonTruthy(val: unknown): boolean {
  if (typeof val === 'boolean') return val;
  if (typeof val === 'number') return val !== 0 && Number.isFinite(val);
  if (typeof val === 'string') return val.length > 0;
  if (val === null || val === undefined) return false;
  if (Array.isArray(val)) return val.length > 0;
  return true;
}

/** Replace named equation references with their recursively-evaluated values. */
function _substituteEquationNids(
  processed: string,
  unit: UnitObject,
  ctx: EquationContext | undefined,
  db: Database | null,
  originalExpr: string,
): string {
  if (!db) return processed;
  const eqNames = db.getEquationNames?.() ?? [];
  // Sort longest-first to avoid partial matches
  const sortedEqs = [...eqNames].sort((a, b) => b.length - a.length);
  for (const eqName of sortedEqs) {
    // Don't replace stat names — those are handled by stat substitution
    if (STAT_NAMES.includes(eqName)) continue;
    const re = new RegExp(`\\b${eqName}\\b`, 'g');
    if (re.test(processed)) {
      // Avoid infinite recursion: only resolve if the equation differs
      const eqExpr = db.getEquation(eqName);
      if (eqExpr && eqExpr !== originalExpr) {
        const eqValue = evaluateEquation(eqExpr, unit, ctx);
        processed = processed.replace(re, String(eqValue));
      }
    }
  }
  return processed;
}

/** Replace stat tokens, unit.X accessors, and DB.constants.value(...) calls. */
function _substituteStatsAndUnit(
  processed: string,
  unit: UnitObject,
  db: Database | null,
): string {
  const sortedStats = [...STAT_NAMES].sort((a, b) => b.length - a.length);
  for (const stat of sortedStats) {
    const re = new RegExp(`\\b${stat}\\b`, 'g');
    processed = processed.replace(re, String(unit.getStatValue(stat)));
  }

  processed = processed.replace(/\bunit\.level\b/g, String(unit.level));
  processed = processed.replace(/\bunit\.klass\b/g, `"${unit.klass}"`);
  processed = processed.replace(
    /\bunit\.get_internal_level\s*\(\s*\)/g,
    String(_getInternalLevel(unit, db)),
  );

  if (db) {
    processed = processed.replace(
      /\bDB\.constants\.value\s*\(\s*['"](.+?)['"]\s*\)/g,
      (_m, constName) => {
        const val = db.getConstant(constName, 0);
        return typeof val === 'number' ? String(val) : `"${val}"`;
      },
    );
  }
  return processed;
}

/** Wrap bare Python builtins (max/min/abs/int/float) with JS equivalents. */
function _wrapBuiltins(processed: string): string {
  processed = processed.replace(/(?<!Math\.)(?<![\w.])\bmax\b/g, 'Math.max');
  processed = processed.replace(/(?<!Math\.)(?<![\w.])\bmin\b/g, 'Math.min');
  processed = processed.replace(/(?<!Math\.)(?<![\w.])\babs\b/g, 'Math.abs');
  // Python int() -> Math.floor()
  processed = processed.replace(/(?<![\w.])\bint\s*\(/g, 'Math.floor(');
  // Python float() -> Number()
  processed = processed.replace(/(?<![\w.])\bfloat\s*\(/g, 'Number(');
  return processed;
}

/**
 * Evaluate an equation string with stat substitution and extended context.
 *
 * Supports:
 *   - Stat token substitution: HP, STR, MAG, ... → unit stat values
 *   - Python ternary: `X if COND else Y`
 *   - Python integer division: `a // b` → `Math.floor(a/b)`
 *   - Named equation references: equation names → recursive evaluation
 *   - `max()`, `min()`, `abs()`, `int()`, `float()` builtins
 *   - `unit.level`, `unit.klass`, `unit.get_internal_level()` access
 *   - `clamp(value, lo, hi)` utility
 *   - Game constants via `DB.constants.value('name')` pattern
 */
export function evaluateEquation(
  expr: string,
  unit: UnitObject,
  ctx?: EquationContext,
): number {
  let processed = expr;

  // Handle Python ternary: "X if COND else Y" -> JS ternary
  const ternaryRe = /^(.+?)\s+if\s+(.+?)\s+else\s+(.+)$/;
  const ternaryMatch = processed.match(ternaryRe);
  if (ternaryMatch) {
    const valueExpr = ternaryMatch[1].trim();
    const condExpr = ternaryMatch[2].trim();
    const elseExpr = ternaryMatch[3].trim();

    const condResult = evaluateEquationCondition(condExpr, unit, ctx);
    return condResult
      ? evaluateEquation(valueExpr, unit, ctx)
      : evaluateEquation(elseExpr, unit, ctx);
  }

  // Resolve the database for equation lookups
  const db = ctx?.db ?? (_eqGameRef?.()?.db as Database | undefined) ?? null;

  // Replace named equation references FIRST (before stat substitution)
  // so that e.g. HIT (equation) doesn't collide with HIT (stat if it existed).
  processed = _substituteEquationNids(processed, unit, ctx, db, expr);

  // Replace stat tokens, unit.X accessors, and DB.constants.value(...) calls
  processed = _substituteStatsAndUnit(processed, unit, db);

  // Convert Python-style integer division `//` to Math.floor.
  // Operand-aware: any `//` whose operands are parenthesised groups,
  // identifiers, or numeric literals is rewritten. The previous regex
  // `/(\b[\d.]+)\s*\/\/\s*([\d.]+\b)/g` only matched numeric literals on
  // both sides, so `(HP - 10)//2` survived and the rest of the expression
  // became a JS line comment, silently truncating it.
  processed = rewriteFloorDiv(processed);

  // Wrap bare max/min/abs/int/float with Math/JS equivalents
  processed = _wrapBuiltins(processed);

  try {
    // Build evaluation context with clamp utility and math
    const clamp = (val: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, val));
    const fn = new Function(
      'Math', 'clamp',
      `"use strict"; return (${processed});`,
    );
    const result = fn(Math, clamp);
    return typeof result === 'number' && Number.isFinite(result)
      ? Math.floor(result)
      : 0;
  } catch {
    console.warn(`CombatCalcs: failed to evaluate equation "${expr}" -> "${processed}"`);
    return 0;
  }
}

/** Helper: compute a unit's internal level (accounting for promotion tiers). */
function _getInternalLevel(unit: UnitObject, db: Database | null): number {
  if (!db) return unit.level;
  const klassDef = db.classes?.get(unit.klass);
  if (!klassDef) return unit.level;
  const tier = klassDef.tier ?? 0;
  if (tier > 0) {
    // For promoted classes, add the max level of the base (unpromoted) tier
    const maxLevel = db.getConstant('max_level', 20) as number;
    return unit.level + maxLevel * tier;
  }
  return unit.level;
}

/**
 * Evaluate a condition within an equation expression.
 *
 * Handles Python condition forms used in default-project equation ternaries:
 *   - Boolean literals (`True` / `False`)
 *   - `'Tag' in unit.tags` / `'Tag' not in unit.tags` (also inside compounds)
 *   - `unit.klass == 'ClassName'` and any `==`/`!=`/`>=`/`<=`/`>`/`<` comparison
 *   - Python logical operators `and` / `or` / `not` (word-boundary rewrite to
 *     `&&` / `||` / `!`; identifiers containing these substrings are untouched)
 *   - Python truthiness for the ternary path (0/'' /empty array → false)
 *
 * The expression is rewritten to JS with the same substitutions as
 * `evaluateEquation` (equation nids, stat tokens, unit.X, DB.constants,
 * floor-div, builtins) and evaluated via `new Function`. Unknown conditions
 * fall back to `true` to preserve prior behaviour.
 */
export function evaluateEquationCondition(
  cond: string,
  unit: UnitObject,
  ctx?: EquationContext,
): boolean {
  const trimmed = cond.trim();

  // Boolean literals
  if (trimmed === 'True' || trimmed === 'true') return true;
  if (trimmed === 'False' || trimmed === 'false') return false;

  const db = ctx?.db ?? (_eqGameRef?.()?.db as Database | undefined) ?? null;

  let processed = trimmed;

  // Replace tag-membership forms with boolean literals. Handle `not in`
  // before `in` so the `not in` form isn't partially consumed. Non-anchored
  // so compound conditions like `'Mounted' in unit.tags and LCK > 3` work.
  processed = processed.replace(
    /['"]([^'"]+)['"]\s+not\s+in\s+unit\.tags/g,
    (_m, tag) => `(${!(unit.tags?.includes(tag) ?? false)})`,
  );
  processed = processed.replace(
    /['"]([^'"]+)['"]\s+in\s+unit\.tags/g,
    (_m, tag) => `(${unit.tags?.includes(tag) ?? false})`,
  );

  // Shared substitutions: equation nids, stat tokens, unit.X, DB.constants.
  processed = _substituteEquationNids(processed, unit, ctx, db, trimmed);
  processed = _substituteStatsAndUnit(processed, unit, db);
  processed = rewriteFloorDiv(processed);
  processed = _wrapBuiltins(processed);

  // Python logical operators → JS. `\b` ensures we never touch identifiers
  // that merely contain these substrings (e.g. `bandana`, `format`, `door`).
  // Apply after builtin wrapping so `Math.floor` (contains `or`) is already
  // in place — though `\bor\b` would not match inside it anyway because `_`
  // and letters are word chars with no boundary between them.
  processed = processed.replace(/\bTrue\b/g, 'true');
  processed = processed.replace(/\bFalse\b/g, 'false');
  processed = processed.replace(/\band\b/g, '&&');
  processed = processed.replace(/\bor\b/g, '||');
  processed = processed.replace(/\bnot\b/g, '!');

  try {
    const clamp = (val: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, val));
    const fn = new Function(
      'Math', 'clamp',
      `"use strict"; return (${processed});`,
    );
    const result = fn(Math, clamp);
    return _pythonTruthy(result);
  } catch {
    console.warn(`CombatCalcs: unknown equation condition "${cond}" -> "${processed}"`);
    return true;
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
  return evaluateEquation(expr, unit, { db });
}

// ------------------------------------------------------------------
// Damage type helpers
// ------------------------------------------------------------------

export function isMagic(item: ItemObject): boolean {
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
  const game = _eqGameRef?.();
  // Python precedence: skill override > item override > skill alternate > item alternate > default.
  const eqName = skillSystem.accuracyFormulaOverride(unit) ??
    itemSystem.accuracyFormulaOverride(unit, item) ??
    skillSystem.accuracyFormula(unit) ??
    itemSystem.accuracyFormula(unit, item) ??
    'HIT';

  const baseHit = resolveEquation(db, eqName, 'SKL * 2 + LCK // 2', unit);
  const itemHit = itemSystem.hit(unit, item, game) ?? 0;

  // Add item + skill static modifiers
  const itemMod = itemSystem.modifyAccuracy(unit, item);
  const skillMod = skillSystem.modifyAccuracy(unit, item);

  return baseHit + itemHit + itemMod + skillMod;
}

/** Calculate avoid for a defender. */
export function avoid(
  unit: UnitObject,
  db: Database,
  board?: GameBoard | null,
  itemToAvoid?: ItemObject | null,
): number {
  // Defensive item formulas come from the attacking item in LT.
  const eqName = skillSystem.avoidFormulaOverride(unit) ??
    (itemToAvoid ? itemSystem.avoidFormulaOverride(unit, itemToAvoid) : undefined) ??
    skillSystem.avoidFormula(unit) ??
    (itemToAvoid ? itemSystem.avoidFormula(unit, itemToAvoid) : undefined) ??
    'AVOID';

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
  const itemMod = equippedWeapon
    ? itemSystem.modifyAvoid(unit, equippedWeapon, _eqGameRef?.())
    : 0;
  const skillMod = skillSystem.modifyAvoid(unit, equippedWeapon);

  // Add terrain avoid bonus
  const terrainAvo = board ? getTerrainBonusesForUnit(unit, board, db)[1] : 0;

  return baseAvoid + itemMod + skillMod + terrainAvo;
}

/** Calculate damage output. */
export function damage(unit: UnitObject, item: ItemObject, db: Database): number {
  // Utility spells without a damage hook are non-damaging in LT; they do not
  // inherit STR/MAG merely because they enter the combat lifecycle.
  if (!item.hasComponent('damage') &&
      !item.hasComponent('damage_any') &&
      !item.hasComponent('eval_damage') &&
      !item.hasComponent('eval_damage_any') &&
      !item.hasComponent('equation_damage')) return 0;
  const game = _eqGameRef?.();
  const eqName = skillSystem.damageFormulaOverride(unit) ??
    itemSystem.damageFormulaOverride(unit, item) ??
    skillSystem.damageFormula(unit) ??
    itemSystem.damageFormula(unit, item, game) ??
    'DAMAGE';

  const magic = isMagic(item);
  const defaultExpr = magic ? 'MAG' : 'STR';
  const baseDmg = resolveEquation(db, eqName, defaultExpr, unit);
  const itemDmg = itemSystem.damage(unit, item, game) ?? 0;

  // Add item + skill static modifiers
  const itemMod = itemSystem.modifyDamage(unit, item);
  const skillMod = skillSystem.modifyDamage(unit, item);

  return baseDmg + itemDmg + itemMod + skillMod;
}

/** Calculate defense/resistance against an incoming attack item. */
export function defense(unit: UnitObject, attackItem: ItemObject, db: Database, board?: GameBoard | null): number {
  const game = _eqGameRef?.();
  // Python precedence mirrors the other formula hooks: defensive skill
  // override, attacking item override, defensive skill alternate, item alternate.
  const formulaOverride = skillSystem.resistFormulaOverride(unit) ??
    itemSystem.resistFormulaOverride(unit, attackItem) ??
    skillSystem.resistFormula(unit) ??
    itemSystem.resistFormula(unit, attackItem, game);

  const magic = isMagic(attackItem);
  const defaultExpr = magic ? 'RES' : 'DEF';
  const eqName = formulaOverride ?? (magic ? 'MAGIC_DEFENSE' : 'DEFENSE');
  const baseDef = resolveEquation(db, eqName, defaultExpr, unit);

  // Add skill static modifier for resist
  const skillMod = skillSystem.modifyResist(unit, null);

  // Add terrain defense bonus (only for physical attacks)
  const terrainDef = (!magic && board) ? getTerrainBonusesForUnit(unit, board, db)[0] : 0;

  return baseDef + skillMod + terrainDef;
}

/** Calculate attack speed (for doubling checks). */
export function attackSpeed(unit: UnitObject, item: ItemObject, db: Database): number {
  const formula = skillSystem.attackSpeedFormulaOverride(unit) ??
    itemSystem.attackSpeedFormulaOverride(unit, item) ??
    skillSystem.attackSpeedFormula(unit) ??
    itemSystem.attackSpeedFormula(unit, item) ??
    'ATTACK_SPEED';

  const spd = unit.getStatValue('SPD');
  const con = unit.getStatValue('CON');
  const weight = item.getWeight();

  let baseAS: number;

  // Try DB equation first
  const asExpr = db.getEquation(formula);
  if (asExpr) {
    // Replace 'weight' token if present
    const processed = asExpr.replace(/\bweight\b/gi, String(weight));
    baseAS = evaluateEquation(processed, unit, { db, item });
  } else {
    // Default: SPD - max(0, weight - CON)
    baseAS = spd - Math.max(0, weight - con);
  }

  // Add item + skill static modifiers
  const itemMod = itemSystem.modifyAttackSpeed(unit, item, _eqGameRef?.());
  const skillMod = skillSystem.modifyAttackSpeed(unit, item);

  return baseAS + itemMod + skillMod;
}

/** Calculate defense speed (for doubling checks on the defender side). */
export function defenseSpeed(
  unit: UnitObject,
  item: ItemObject,
  db: Database,
  itemToAvoid?: ItemObject | null,
): number {
  const formula = skillSystem.defenseSpeedFormulaOverride(unit) ??
    (itemToAvoid ? itemSystem.defenseSpeedFormulaOverride(unit, itemToAvoid) : undefined) ??
    skillSystem.defenseSpeedFormula(unit) ??
    (itemToAvoid ? itemSystem.defenseSpeedFormula(unit, itemToAvoid) : undefined) ??
    'DEFENSE_SPEED';

  const speedExpr = db.getEquation(formula);
  let base: number;
  if (speedExpr) {
    const weight = item.getWeight();
    const processed = speedExpr.replace(/\bweight\b/gi, String(weight));
    base = evaluateEquation(processed, unit, { db, item });
  } else {
    const spd = unit.getStatValue('SPD');
    const con = unit.getStatValue('CON');
    base = spd - Math.max(0, item.getWeight() - con);
  }
  return base +
    itemSystem.modifyDefenseSpeed(unit, item, _eqGameRef?.()) +
    skillSystem.modifyDefenseSpeed(unit, item);
}

// ------------------------------------------------------------------
// Composite formulas (with dynamic modifiers + multipliers)
// ------------------------------------------------------------------

/**
 * Compute final hit chance (attacker accuracy - defender avoid, clamped 0-100).
 * Includes dynamic modifiers from items and skills, plus support bonuses.
 */
export function computeHit(
  attacker: UnitObject,
  attackItem: ItemObject,
  defender: UnitObject,
  db: Database,
  board?: GameBoard | null,
  game?: any,
  mode: 'attack' | 'defense' | 'splash' = 'attack',
): number {
  const acc = accuracy(attacker, attackItem, db);
  const avo = avoid(defender, db, board, attackItem);

  // Dynamic modifiers from items and skills (combat context)
  const defWeapon = defender.items.find((i) => i.isWeapon()) ?? null;
  const itemDynAcc = itemSystem.dynamicAccuracy(attacker, attackItem, defender, defWeapon, mode, null, acc);
  const skillDynAcc = skillSystem.dynamicAccuracy(attacker, attackItem, defender, defWeapon, mode, null, acc);
  const skillDynAvo = skillSystem.dynamicAvoid(defender, defWeapon, attacker, attackItem, mode, null, avo);

  // Support bonuses
  const atkSupport = getSupportBonusForCombat(attacker, game);
  const defSupport = getSupportBonusForCombat(defender, game);

  const raw = acc + itemDynAcc + skillDynAcc + atkSupport.accuracy - avo - skillDynAvo - defSupport.avoid;
  return Math.max(0, Math.min(100, raw));
}

/**
 * Compute final damage (attacker damage - defender defense, min 0).
 * Includes dynamic modifiers, effective damage, multipliers, and support bonuses.
 */
function computeDamageCore(
  attacker: UnitObject,
  attackItem: ItemObject,
  defender: UnitObject,
  db: Database,
  board?: GameBoard | null,
  game?: any,
  mode: 'attack' | 'defense' | 'splash' = 'attack',
  assist: boolean = false,
  attackInfo: [number, number] = [0, 0],
): number {
  const atk = damage(attacker, attackItem, db);
  const def = defense(defender, attackItem, db, board);

  // Dynamic modifiers from items and skills
  const defWeapon = defender.items.find((i) => i.isWeapon()) ?? null;
  const baseDmg = atk - def;

  // Attacker-only weapon-triangle damage advantage, folded into the
  // effective might by `EffectiveDamage.dynamic_damage` when
  // `weapon_effectiveness_multiplied` is true (Python `compute_advantage_attr`).
  const advantageDamage = weaponTriangle(
    attackItem, defWeapon, db, attacker, defender,
  ).attackerDamageAdvantage;
  const itemDynDmg = itemSystem.dynamicDamage(
    attacker, attackItem, defender, defWeapon, mode, attackInfo, baseDmg, db, game, advantageDamage,
  );
  const skillDynDmg = skillSystem.dynamicDamage(
    attacker, attackItem, defender, defWeapon, mode, attackInfo, baseDmg,
  );
  const skillDynResist = skillSystem.dynamicResist(
    defender, defWeapon, attacker, attackItem, mode, attackInfo, def,
  );

  // Support bonuses
  const atkSupport = getSupportBonusForCombat(attacker, game);
  const defSupport = getSupportBonusForCombat(defender, game);

  let finalDmg = baseDmg + itemDynDmg + skillDynDmg - skillDynResist + atkSupport.damage - defSupport.resist;

  // Attack-stance partners deal half damage after defense, matching LT's
  // compute_assist_damage path. Multipliers are applied after the reduction.
  if (assist) finalDmg = Math.floor(finalDmg / 2);

  // Apply damage multiplier from attacker skills
  const dmgMult = skillSystem.damageMultiplier(
    attacker, attackItem, defender, defWeapon, mode, attackInfo, finalDmg,
  );
  finalDmg = Math.floor(finalDmg * dmgMult);

  // Apply resist multiplier from defender skills
  const resMult = skillSystem.resistMultiplier(
    defender, defWeapon, attacker, attackItem, mode, attackInfo, finalDmg, game,
  );
  finalDmg = Math.floor(finalDmg * resMult);

  return Math.max(0, finalDmg);
}

export function computeDamage(
  attacker: UnitObject,
  attackItem: ItemObject,
  defender: UnitObject,
  db: Database,
  board?: GameBoard | null,
  game?: any,
  mode: 'attack' | 'defense' | 'splash' = 'attack',
  assist: boolean = false,
  attackInfo: [number, number] = [0, 0],
): number {
  const defWeapon = defender.items.find((candidate) => candidate.isWeapon()) ?? null;
  const attackerHasDynamicStats = attacker.skills.some((skill) =>
    skill.hasComponent('dynamic_stat_change'));
  const defenderHasDynamicStats = defender.skills.some((skill) =>
    skill.hasComponent('dynamic_stat_change'));
  const preparedAttacker = attackerHasDynamicStats &&
    !attacker.skills.some((skill) => skill.data.has('_dynamic_stat_changes'));
  const preparedDefender = defenderHasDynamicStats &&
    !defender.skills.some((skill) => skill.data.has('_dynamic_stat_changes'));
  if (preparedAttacker) {
    skillSystem.prepareDynamicStatChanges(
      attacker, attackItem, defender, defWeapon,
      mode === 'defense' ? 'defense' : 'attack', game,
    );
  }
  if (preparedDefender) {
    skillSystem.prepareDynamicStatChanges(
      defender, defWeapon, attacker, attackItem,
      mode === 'attack' ? 'defense' : 'attack', game,
    );
  }
  try {
    return computeDamageCore(
      attacker, attackItem, defender, db, board, game, mode, assist, attackInfo,
    );
  } finally {
    if (preparedAttacker) skillSystem.clearDynamicStatChanges(attacker);
    if (preparedDefender) skillSystem.clearDynamicStatChanges(defender);
  }
}

export function computeAssistDamage(
  attacker: UnitObject,
  attackItem: ItemObject,
  defender: UnitObject,
  db: Database,
  board?: GameBoard | null,
  game?: any,
  mode: 'attack' | 'defense' | 'splash' = 'attack',
): number {
  return computeDamage(attacker, attackItem, defender, db, board, game, mode, true);
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
    ? defenseSpeed(defender, defenderWeapon, db, attackItem)
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
  game?: any,
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
  const minRange = defWeapon.getMinRange(defender, game);
  const maxRange = skillSystem.modifiedMaximumRange(defender, defWeapon, game);
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
  defender?: UnitObject,
): { hitBonus: number; damageBonus: number; attackerDamageAdvantage: number } {
  const noBonus = { hitBonus: 0, damageBonus: 0, attackerDamageAdvantage: 0 };
  if (!defenseItem) return noBonus;

  // Check if either item ignores weapon advantage
  if (attacker && itemSystem.ignoreWeaponAdvantage(attacker, attackItem)) return noBonus;
  if (defender && itemSystem.ignoreWeaponAdvantage(defender, defenseItem)) return noBonus;

  const atkType = attacker
    ? itemSystem.weaponTriangleOverride(attacker, attackItem) ?? attackItem.getWeaponType()
    : attackItem.getWeaponType();
  const defType = defender
    ? itemSystem.weaponTriangleOverride(defender, defenseItem) ?? defenseItem.getWeaponType()
    : defenseItem.getWeaponType();
  if (!atkType || !defType) return noBonus;

  // Look up the attacker's weapon type definition
  const atkWeaponDef = db.weapons.find((w) => w.nid === atkType);
  if (!atkWeaponDef) return noBonus;

  const modifier1 = attacker ? itemSystem.modifyWeaponTriangle(attacker, attackItem) : 1;
  const modifier2 = defender ? itemSystem.modifyWeaponTriangle(defender, defenseItem) : 1;
  const finalModifier = Math.sign(modifier1) * Math.sign(modifier2) *
    Math.max(Math.abs(modifier1), Math.abs(modifier2));
  const requirement = (rank: string): number =>
    rank === 'All' ? -1 : db.weaponRanks.find((candidate) => candidate.rank === rank)?.requirement ?? Infinity;
  const resolveBonus = (
    sourceUnit: UnitObject | undefined,
    sourceType: string,
    targetType: string,
    bonuses: typeof atkWeaponDef.advantage,
  ) => {
    let best: (typeof bonuses)[number] | null = null;
    let bestRequirement = -1;
    const wexp = sourceUnit ? Number(sourceUnit.wexp[sourceType] ?? 0) : Number.MAX_SAFE_INTEGER;
    for (const bonus of bonuses) {
      if (bonus.weapon_type !== 'All' && bonus.weapon_type !== targetType) continue;
      if (bonus.weapon_rank === 'All') return bonus;
      const required = requirement(bonus.weapon_rank);
      if (wexp >= required && required > bestRequirement) {
        best = bonus;
        bestRequirement = required;
      }
    }
    return best;
  };
  const attackerAdvantage = resolveBonus(attacker, atkType, defType, atkWeaponDef.advantage);
  const attackerDisadvantage = resolveBonus(attacker, atkType, defType, atkWeaponDef.disadvantage);
  const defWeaponDef = db.weapons.find((weapon) => weapon.nid === defType);
  const defenderAdvantage = defWeaponDef
    ? resolveBonus(defender, defType, atkType, defWeaponDef.advantage)
    : null;
  const defenderDisadvantage = defWeaponDef
    ? resolveBonus(defender, defType, atkType, defWeaponDef.disadvantage)
    : null;
  const sum = (bonuses: Array<(typeof atkWeaponDef.advantage)[number] | null>, attribute: 'accuracy' | 'damage' | 'avoid' | 'resist') =>
    bonuses.reduce((total, bonus) => total + (bonus ? parseNumericValue(bonus[attribute]) : 0), 0);
  return {
    hitBonus: Math.trunc((
      sum([attackerAdvantage, attackerDisadvantage], 'accuracy') -
      sum([defenderAdvantage, defenderDisadvantage], 'avoid')
    ) * finalModifier),
    damageBonus: Math.trunc((
      sum([attackerAdvantage, attackerDisadvantage], 'damage') -
      sum([defenderAdvantage, defenderDisadvantage], 'resist')
    ) * finalModifier),
    // Attacker-only weapon-triangle damage advantage, matching Python
    // `combat_calcs.compute_advantage_attr(unit, target, item, item2, 'damage')`
    // (excludes the defender's resist advantage). Folded into the effective
    // might by `EffectiveDamage.dynamic_damage` when weapon_effectiveness_multiplied.
    attackerDamageAdvantage: Math.trunc(
      sum([attackerAdvantage, attackerDisadvantage], 'damage') * finalModifier,
    ),
  };
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
 * Now includes item + skill crit modifiers and support bonuses.
 */
export function computeCrit(
  attacker: UnitObject,
  attackItem: ItemObject,
  defender: UnitObject,
  db: Database,
  game?: any,
  mode: 'attack' | 'defense' | 'splash' = 'attack',
  attackInfo: [number, number] = [0, 0],
): number {
  const critFormula = skillSystem.critAccuracyFormulaOverride(attacker) ??
    itemSystem.critAccuracyFormulaOverride(attacker, attackItem) ??
    skillSystem.critAccuracyFormula(attacker) ??
    itemSystem.critAccuracyFormula(attacker, attackItem) ??
    'CRIT_HIT';
  const avoidFormula = skillSystem.critAvoidFormulaOverride(defender) ??
    itemSystem.critAvoidFormulaOverride(attacker, attackItem) ??
    skillSystem.critAvoidFormula(defender) ??
    itemSystem.critAvoidFormula(attacker, attackItem) ??
    'CRIT_AVOID';
  const baseCrit = resolveEquation(db, critFormula, 'SKL // 2', attacker);
  const itemCrit = attackItem.getComponent<number>('crit') ?? 0;
  const critAvoid = resolveEquation(db, avoidFormula, 'LCK', defender);

  // Skill modifiers
  const skillCritAcc = skillSystem.modifyCritAccuracy(attacker, attackItem);
  const skillCritAvo = skillSystem.modifyCritAvoid(defender, null);

  // Item crit modifier
  const itemCritMod = itemSystem.modifyCritAccuracy(attacker, attackItem);

  // Support bonuses
  const atkSupport = getSupportBonusForCombat(attacker, game);
  const defSupport = getSupportBonusForCombat(defender, game);

  const baseValue = baseCrit + itemCrit + skillCritAcc + itemCritMod + atkSupport.crit
    - critAvoid - skillCritAvo - defSupport.dodge;
  const dynamicCrit = skillSystem.dynamicCritAccuracy(
    attacker,
    attackItem,
    defender,
    getEquippedWeapon(defender, db, game),
    mode,
    attackInfo,
    baseValue,
    game,
  );
  const raw = baseValue + dynamicCrit;
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
  mode: 'attack' | 'defense' = 'attack',
  attackInfo: [number, number] = [0, 0],
  game?: any,
): number {
  let count = 1;

  // Brave from items
  const itemExtra = itemSystem.dynamicMultiattacks(unit, item, target, defenseItem, mode, null, 0);
  count += itemExtra;

  // Dynamic multiattacks from skills
  const db = game?.db ?? _eqGameRef?.()?.db;
  const combatCalcs = db ? {
    attack_speed: (candidate: any) => attackSpeed(candidate?._raw ?? candidate, item, db),
    defense_speed: (candidate: any, candidateItem: any) => defenseSpeed(
      candidate?._raw ?? candidate,
      candidateItem?._raw ?? candidateItem ?? defenseItem ?? item,
      db,
      item,
    ),
  } : undefined;
  const skillExtra = skillSystem.dynamicMultiattacks(
    unit, item, target, defenseItem, mode, attackInfo, count - 1, game, combatCalcs,
  );
  count += skillExtra;

  return Math.max(1, count);
}

/** Extra attack phases from skills, excluding ordinary speed doubling. */
export function computeExtraAttackPhases(
  unit: UnitObject,
  item: ItemObject,
  target: UnitObject,
  defenseItem: ItemObject | null,
  mode: 'attack' | 'defense',
  attackInfo: [number, number],
  game?: any,
): number {
  const db = game?.db ?? _eqGameRef?.()?.db;
  const combatCalcs = db ? {
    attack_speed: (candidate: any) => attackSpeed(candidate?._raw ?? candidate, item, db),
    defense_speed: (candidate: any, candidateItem: any) => defenseSpeed(
      candidate?._raw ?? candidate,
      candidateItem?._raw ?? candidateItem ?? defenseItem ?? item,
      db,
      item,
    ),
  } : undefined;
  return Math.max(0, skillSystem.dynamicAttacks(
    unit, item, target, defenseItem, mode, attackInfo, 0, game, combatCalcs,
  ));
}

/** EotF follow-up phases that resolve before the opponent can counter. */
export function computeBlitzPhases(
  unit: UnitObject,
  item: ItemObject,
  target: UnitObject,
  defenseItem: ItemObject | null,
  mode: 'attack' | 'defense',
  attackInfo: [number, number],
  game?: any,
): number {
  const db = game?.db ?? _eqGameRef?.()?.db;
  const combatCalcs = db ? {
    attack_speed: (candidate: any) => attackSpeed(candidate?._raw ?? candidate, item, db),
    defense_speed: (candidate: any, candidateItem: any) => defenseSpeed(
      candidate?._raw ?? candidate,
      candidateItem?._raw ?? candidateItem ?? defenseItem ?? item,
      db,
      item,
    ),
  } : undefined;
  return Math.max(0, skillSystem.dynamicBlitzes(
    unit, item, target, defenseItem, mode, attackInfo, 0, game, combatCalcs,
  ));
}

// ------------------------------------------------------------------
// Support bonus helper
// ------------------------------------------------------------------

const EMPTY_SUPPORT_EFFECT: SupportEffect = {
  damage: 0, resist: 0, accuracy: 0, avoid: 0,
  crit: 0, dodge: 0, attack_speed: 0, defense_speed: 0,
};

/**
 * Get the aggregate support bonus for a unit in combat.
 * Calls the SupportController if available, otherwise returns zeros.
 */
export function getSupportBonusForCombat(unit: UnitObject, game?: any): SupportEffect {
  if (!game?.supports) return EMPTY_SUPPORT_EFFECT;
  try {
    return game.supports.getSupportRankBonus(unit, game.board, game.db, game);
  } catch {
    return EMPTY_SUPPORT_EFFECT;
  }
}

// ------------------------------------------------------------------
// Legacy convenience wrappers (used by AI / other subsystems)
// ------------------------------------------------------------------

/** Get the first usable weapon from a unit's inventory. */
export function getEquippedWeapon(
  unit: UnitObject,
  db?: Database,
  game?: any,
): ItemObject | null {
  // Tracked equipped weapon is authoritative (Python `unit.equipped_weapon`).
  if (unit.equippedWeapon) return unit.equippedWeapon;
  // Fallback for units constructed before autoequip ran: derive and cache.
  if (db && typeof unit.autoequip === 'function') {
    unit.autoequip();
    if (unit.equippedWeapon) return unit.equippedWeapon;
  }
  return null;
}
