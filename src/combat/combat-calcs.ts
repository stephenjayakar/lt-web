import type { UnitObject } from '../objects/unit';
import type { ItemObject } from '../objects/item';
import type { Database } from '../data/database';
import type { NID, WeaponAdvantage } from '../data/types';
import type { GameBoard } from '../objects/game-board';
import * as itemSystem from './item-system';
import * as skillSystem from './skill-system';
import type { SupportEffect } from '../engine/support-system';
import { isForkEngine } from '../engine/engine-flavor';
import { evaluateEquationSource, pythonTruthy } from '../events/event-manager';

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
 * Python's equations.Parser: the right-hand side is split with
 * `re.split('([^a-zA-Z_])')`, every token naming a stat becomes
 * `(unit.stats['X'] + unit.stat_bonus('X'))` and every token naming an
 * equation becomes `equations['N'](equations, unit)`, and the result is
 * wrapped in `int(...)`. The substitution happens on raw tokens, inside string
 * literals too, exactly as Python does it.
 *
 * Here a stat token becomes `__stat__('X')` (the unit's stat with bonuses)
 * and an equation token `__equation__('N')`; the text is then evaluated by
 * the Python expression evaluator with `unit` bound to the expression-scope
 * unit wrapper. Cached per database and expression.
 */
const equationSources = new WeakMap<object, Map<string, string>>();
const noDatabaseSources = new Map<string, string>();

function equationNames(db: Database | null): { stats: Set<string>; equations: Set<string> } {
  const statNids = (db as any)?.stats?.map?.((stat: any) => stat?.nid).filter(Boolean);
  const stats = new Set<string>(statNids?.length ? statNids : STAT_NAMES);
  const equations = new Set<string>(
    (db?.getEquationNames?.() ?? []).filter((nid: string) => !!db?.getEquation(nid)),
  );
  return { stats, equations };
}

function equationSource(expr: string, db: Database | null): string {
  const cache = db ? (equationSources.get(db) ?? new Map<string, string>()) : noDatabaseSources;
  if (db && !equationSources.has(db)) equationSources.set(db, cache);
  let source = cache.get(expr);
  if (source === undefined) {
    const { stats, equations } = equationNames(db);
    source = expr.split(/([^a-zA-Z_])/).map((token) => {
      if (stats.has(token)) return `__stat__('${token}')`;
      if (equations.has(token)) return `__equation__('${token}')`;
      return token;
    }).join('');
    cache.set(expr, source);
  }
  return source;
}

const MAX_EQUATION_DEPTH = 64;
let equationDepth = 0;

function equationGlobals(
  unit: UnitObject,
  ctx: EquationContext | undefined,
  db: Database | null,
): Record<string, unknown> {
  return {
    __stat__: (stat: string) => unit.getStatValue(stat),
    __equation__: (nid: string) => {
      const expression = db?.getEquation(nid);
      if (!expression) throw new Error(`equation ${nid} has no expression`);
      return runEquation(expression, unit, ctx, db);
    },
    // Web-only conveniences other projects' equations use (Python's
    // equation namespace has only builtins, `equations` and `unit`).
    clamp: (value: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, value)),
    DB: {
      constants: {
        value: (name: string) => db?.getConstant(name, 0) ?? 0,
      },
    },
  };
}

function runEquation(
  expr: string,
  unit: UnitObject,
  ctx: EquationContext | undefined,
  db: Database | null,
): number {
  if (equationDepth >= MAX_EQUATION_DEPTH) throw new Error('equation recursion limit');
  equationDepth += 1;
  try {
    const value = evaluateEquationSource(
      `int(${equationSource(expr, db)})`,
      unit,
      _eqGameRef?.() ?? null,
      equationGlobals(unit, ctx, db),
    );
    return Number(value);
  } finally {
    equationDepth -= 1;
  }
}

/**
 * Evaluate an equation (or one-off expression) like Python's
 * `equations.Parser`: stat and equation tokens substituted, the whole
 * expression `int(...)`-truncated toward zero. A failing equation logs and
 * yields 0 (Python raises; there is no try around equation lookups).
 */
export function evaluateEquation(
  expr: string,
  unit: UnitObject,
  ctx?: EquationContext,
): number {
  const db = ctx?.db ?? (_eqGameRef?.()?.db as Database | undefined) ?? null;
  try {
    const value = runEquation(String(expr ?? ''), unit, ctx, db);
    return Number.isFinite(value) ? value : 0;
  } catch (error) {
    console.warn(`CombatCalcs: failed to evaluate equation "${expr}"`, error);
    return 0;
  }
}

/**
 * Truth value of an expression in the equation namespace (stat and equation
 * tokens substituted). False when it raises.
 */
export function evaluateEquationCondition(
  cond: string,
  unit: UnitObject,
  ctx?: EquationContext,
): boolean {
  const db = ctx?.db ?? (_eqGameRef?.()?.db as Database | undefined) ?? null;
  try {
    return pythonTruthy(evaluateEquationSource(
      equationSource(cond.trim(), db),
      unit,
      _eqGameRef?.() ?? null,
      equationGlobals(unit, ctx, db),
    ));
  } catch (error) {
    console.warn(`CombatCalcs: failed to evaluate equation condition "${cond}"`, error);
    return false;
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

/**
 * Python `item_funcs.is_magic(unit, item, distance)`: `magic`, or
 * `magic_at_range` beyond distance 1. EOtF's engine fork also counts
 * `eval_dragon` items held by a Dragon-tagged unit and `eval_dragon_magic`
 * items (used by cannot_use_magic_items and eval expressions).
 */
export function itemIsMagic(
  unit: UnitObject | null | undefined,
  item: ItemObject | null | undefined,
  distance: number = 0,
  db?: Database,
): boolean {
  if (!item) return false;
  if (item.hasComponent('magic')) return true;
  if (item.hasComponent('magic_at_range') && distance > 1) return true;
  if (!isForkEngine()) return false;
  if (item.hasComponent('eval_dragon_magic')) return true;
  return item.hasComponent('eval_dragon') && !!unit &&
    itemSystem.effectivenessTargetTags(unit, db ?? _eqGameRef?.()?.db).has('Dragon');
}

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

/**
 * EOtF's engine fork (combat_calcs.py, 2024 base) asks the item first:
 * `item_system.X_formula` (UNIQUE, defaulting to the stat's own equation),
 * and only when that is the default does `skill_system.X_formula` apply.
 * Upstream later put skill overrides and skill alternates ahead of the
 * item's formula (combat_calcs_utils.resolve_*_formula), so a skill like
 * Perfect_Balance_Proc beats a tome's MAGIC_DEFENSE there but not in EOtF.
 */
function forkFormula(
  itemFormula: string | undefined,
  fallback: string,
  skillFormula: () => string | undefined,
): string {
  if (itemFormula && itemFormula !== fallback) return itemFormula;
  return skillFormula() ?? fallback;
}

/**
 * The item a defender's skill modify hooks (modify_avoid / modify_resist /
 * modify_crit_avoid / modify_defense_speed) see. The fork passes the
 * attacker's weapon (`item_to_avoid`), falling back to the defender's own
 * weapon; upstream passes the defender's weapon.
 */
function defensiveSkillItem(item: ItemObject | null, itemToAvoid: ItemObject | null | undefined): ItemObject | null {
  return isForkEngine() ? itemToAvoid ?? item : item;
}

type RankBonusAttribute =
  'accuracy' | 'avoid' | 'crit' | 'dodge' | 'damage' | 'resist' | 'attack_speed' | 'defense_speed';

/**
 * Python combat_calcs.get_weapon_rank_bonus: the item's weapon type's
 * `rank_bonus` list. An entry with weapon_rank 'All' is returned as soon as
 * the scan reaches it; otherwise the entry with the highest requirement the
 * unit's wexp in that weapon type meets wins (ties keep the first). Python
 * never reads an entry's own weapon_type, so neither does this.
 */
export function weaponRankBonus(
  unit: UnitObject,
  item: ItemObject | null | undefined,
  db: Database,
): WeaponAdvantage | null {
  if (!item) return null;
  const type = itemSystem.weaponType(unit, item);
  if (!type) return null;
  const rankBonus = (db.weapons ?? []).find((weapon) => weapon.nid === type)?.rank_bonus ?? [];
  const wexp = Number(unit.wexp?.[type] ?? 0);
  let best: WeaponAdvantage | null = null;
  let highestRequirement = -1;
  for (const bonus of rankBonus as WeaponAdvantage[]) {
    if (bonus.weapon_rank === 'All') return bonus;
    const requirement = (db.weaponRanks ?? []).find((rank) => rank.rank === bonus.weapon_rank)?.requirement;
    if (requirement === undefined) continue;
    if (wexp >= requirement && requirement > highestRequirement) {
      highestRequirement = requirement;
      best = bonus;
    }
  }
  return best;
}

/** `int(weapon_rank_bonus.<attribute>)`, or 0 without a bonus. */
function rankBonus(
  unit: UnitObject,
  item: ItemObject | null | undefined,
  db: Database,
  attribute: RankBonusAttribute,
): number {
  const bonus = weaponRankBonus(unit, item, db);
  if (!bonus) return 0;
  return Math.trunc(Number(bonus[attribute] ?? 0)) || 0;
}

/**
 * Defender-side rank bonuses (avoid, dodge, resist, defense_speed) are an
 * upstream addition the EOtF fork lacks; its attacker-side ones match.
 */
function defensiveRankBonus(
  unit: UnitObject,
  item: ItemObject | null | undefined,
  db: Database,
  attribute: RankBonusAttribute,
): number {
  return isForkEngine() ? 0 : rankBonus(unit, item, db, attribute);
}

/** Calculate hit rate for an attacker. */
export function accuracy(
  unit: UnitObject,
  item: ItemObject,
  db: Database,
  game?: any,
  target?: UnitObject | null,
  item2?: ItemObject | null,
  mode: 'attack' | 'defense' | 'splash' = 'attack',
  attackInfo: [number, number] = [0, 0],
): number {
  game ??= _eqGameRef?.();
  // Python precedence: skill override > item override > skill alternate > item alternate > default.
  const formulaContext = { game, item, target };
  const eqName = isForkEngine()
    ? forkFormula(itemSystem.accuracyFormula(unit, item), 'HIT',
      () => skillSystem.accuracyFormula(unit, formulaContext))
    : skillSystem.accuracyFormulaOverride(unit) ??
      itemSystem.accuracyFormulaOverride(unit, item) ??
      skillSystem.accuracyFormula(unit, formulaContext) ??
      itemSystem.accuracyFormula(unit, item) ??
      'HIT';

  const baseHit = resolveEquation(db, eqName, 'SKL * 2 + LCK // 2', unit);
  const itemHit = itemSystem.hit(unit, item, game) ?? 0;

  // Add item + skill static modifiers
  const itemMod = itemSystem.modifyAccuracy(unit, item);
  const skillMod = skillSystem.modifyAccuracy(
    unit, item, game, target, item2, mode, attackInfo,
  );

  return baseHit + itemHit + rankBonus(unit, item, db, 'accuracy') + itemMod + skillMod;
}

/** Calculate avoid for a defender. */
export function avoid(
  unit: UnitObject,
  db: Database,
  board?: GameBoard | null,
  itemToAvoid?: ItemObject | null,
  game?: any,
  target?: UnitObject | null,
  mode: 'attack' | 'defense' | 'splash' = 'defense',
  attackInfo: [number, number] = [0, 0],
): number {
  game ??= _eqGameRef?.();
  // Defensive item formulas come from the attacking item in LT.
  const formulaContext = { game, item: itemToAvoid, target };
  const eqName = isForkEngine()
    ? forkFormula(itemToAvoid ? itemSystem.avoidFormula(unit, itemToAvoid) : undefined, 'AVOID',
      () => skillSystem.avoidFormula(unit, formulaContext))
    : skillSystem.avoidFormulaOverride(unit) ??
      (itemToAvoid ? itemSystem.avoidFormulaOverride(unit, itemToAvoid) : undefined) ??
      skillSystem.avoidFormula(unit, formulaContext) ??
      (itemToAvoid ? itemSystem.avoidFormula(unit, itemToAvoid) : undefined) ??
      'AVOID';

  // Python evaluates the AVOID equation against the unit's raw SPD and then
  // adds item_system.modify_avoid, which subtracts twice the weight penalty.
  // Substituting attack speed for SPD instead only matches that when SPD's
  // coefficient happens to be 2, so formulas like EotF's AVOID_SHACKLED
  // (SPD + LCK//2) diverged.
  const equippedWeapon = unit.items.find((i) => i.isWeapon()) ?? null;
  const avoidExpr = db.getEquation(eqName) ?? 'SPD * 2 + LCK // 2';
  const baseAvoid = evaluateEquation(avoidExpr, unit, { db });

  // Add skill static modifier
  const itemMod = equippedWeapon
    ? itemSystem.modifyAvoid(unit, equippedWeapon, game)
    : 0;
  const skillMod = skillSystem.modifyAvoid(
    unit, defensiveSkillItem(equippedWeapon, itemToAvoid), game, target, itemToAvoid, mode, attackInfo,
  );

  // Terrain avoid arrives through the tile's terrain status skill, which
  // position-status-system grants exactly as Python arrive() does.
  return baseAvoid + defensiveRankBonus(unit, equippedWeapon, db, 'avoid') + itemMod + skillMod;
}

/** Calculate damage output. */
export function damage(
  unit: UnitObject,
  item: ItemObject,
  db: Database,
  game?: any,
  target?: UnitObject | null,
  item2?: ItemObject | null,
  mode: 'attack' | 'defense' | 'splash' = 'attack',
  attackInfo: [number, number] = [0, 0],
): number {
  // Utility spells without a damage hook are non-damaging in LT; they do not
  // inherit STR/MAG merely because they enter the combat lifecycle.
  if (!item.hasComponent('damage') &&
      !item.hasComponent('damage_any') &&
      !item.hasComponent('eval_damage') &&
      !item.hasComponent('eval_damage_any') &&
      !item.hasComponent('equation_damage')) return 0;
  game ??= _eqGameRef?.();
  const formulaContext = { game, item, target };
  const eqName = isForkEngine()
    ? forkFormula(itemSystem.damageFormula(unit, item, game), 'DAMAGE',
      () => skillSystem.damageFormula(unit, formulaContext))
    : skillSystem.damageFormulaOverride(unit) ??
      itemSystem.damageFormulaOverride(unit, item) ??
      skillSystem.damageFormula(unit, formulaContext) ??
      itemSystem.damageFormula(unit, item, game) ??
      'DAMAGE';

  const magic = isMagic(item);
  const defaultExpr = magic ? 'MAG' : 'STR';
  const baseDmg = resolveEquation(db, eqName, defaultExpr, unit);
  const itemDmg = itemSystem.damage(unit, item, game) ?? 0;

  // Add item + skill static modifiers
  const itemMod = itemSystem.modifyDamage(unit, item);
  const skillMod = skillSystem.modifyDamage(
    unit, item, game, target, item2, mode, attackInfo,
  );

  return baseDmg + itemDmg + rankBonus(unit, item, db, 'damage') + itemMod + skillMod;
}

/** Calculate defense/resistance against an incoming attack item. */
export function defense(
  unit: UnitObject,
  attackItem: ItemObject,
  db: Database,
  board?: GameBoard | null,
  game?: any,
  target?: UnitObject | null,
  item?: ItemObject | null,
  mode: 'attack' | 'defense' | 'splash' = 'defense',
  attackInfo: [number, number] = [0, 0],
): number {
  game ??= _eqGameRef?.();
  // Python precedence mirrors the other formula hooks: defensive skill
  // override, attacking item override, defensive skill alternate, item alternate.
  const formulaContext = { game, item: attackItem, target };
  // The fork evaluates the attacking item's formula for the attacker.
  const formulaOverride = isForkEngine()
    ? forkFormula(itemSystem.resistFormula(target ?? unit, attackItem, game), 'DEFENSE',
      () => skillSystem.resistFormula(unit, formulaContext))
    : skillSystem.resistFormulaOverride(unit) ??
      itemSystem.resistFormulaOverride(unit, attackItem) ??
      skillSystem.resistFormula(unit, formulaContext) ??
      itemSystem.resistFormula(unit, attackItem, game);

  const magic = isMagic(attackItem);
  const defaultExpr = magic ? 'RES' : 'DEF';
  const eqName = formulaOverride ?? (magic ? 'MAGIC_DEFENSE' : 'DEFENSE');
  const baseDef = resolveEquation(db, eqName, defaultExpr, unit);

  // Add skill static modifier for resist
  const skillMod = skillSystem.modifyResist(
    unit, defensiveSkillItem(item ?? null, attackItem), game, target, attackItem, mode, attackInfo,
  );

  // Terrain DEF/RES come from the terrain status skill's stat_change.
  return baseDef + defensiveRankBonus(unit, item, db, 'resist') + skillMod;
}

/** Calculate attack speed (for doubling checks). */
export function attackSpeed(
  unit: UnitObject,
  item: ItemObject,
  db: Database,
  game?: any,
  target?: UnitObject | null,
  item2?: ItemObject | null,
  mode: 'attack' | 'defense' | 'splash' = 'attack',
  attackInfo: [number, number] = [0, 0],
): number {
  game ??= _eqGameRef?.();
  const formula = isForkEngine()
    ? forkFormula(itemSystem.attackSpeedFormula(unit, item), 'ATTACK_SPEED',
      () => skillSystem.attackSpeedFormula(unit))
    : skillSystem.attackSpeedFormulaOverride(unit) ??
      itemSystem.attackSpeedFormulaOverride(unit, item) ??
      skillSystem.attackSpeedFormula(unit) ??
      itemSystem.attackSpeedFormula(unit, item) ??
      'ATTACK_SPEED';

  // Python evaluates the ATTACK_SPEED equation on its own and applies weight
  // through item_system.modify_attack_speed below, so the equation itself is
  // never rewritten and weight is counted exactly once.
  const asExpr = db.getEquation(formula);
  const baseAS = asExpr
    ? evaluateEquation(asExpr, unit, { db, item })
    : unit.getStatValue('SPD');

  // Add item + skill static modifiers
  const itemMod = itemSystem.modifyAttackSpeed(unit, item, game);
  const skillMod = skillSystem.modifyAttackSpeed(
    unit, item, game, target, item2, mode, attackInfo,
  );

  return baseAS + rankBonus(unit, item, db, 'attack_speed') + itemMod + skillMod;
}

/** Calculate defense speed (for doubling checks on the defender side). */
export function defenseSpeed(
  unit: UnitObject,
  item: ItemObject | null,
  db: Database,
  itemToAvoid?: ItemObject | null,
  game?: any,
  target?: UnitObject | null,
  mode: 'attack' | 'defense' | 'splash' = 'defense',
  attackInfo: [number, number] = [0, 0],
): number {
  game ??= _eqGameRef?.();
  const formula = isForkEngine()
    ? forkFormula(itemToAvoid ? itemSystem.defenseSpeedFormula(unit, itemToAvoid) : undefined, 'DEFENSE_SPEED',
      () => skillSystem.defenseSpeedFormula(unit))
    : skillSystem.defenseSpeedFormulaOverride(unit) ??
      (itemToAvoid ? itemSystem.defenseSpeedFormulaOverride(unit, itemToAvoid) : undefined) ??
      skillSystem.defenseSpeedFormula(unit) ??
      (itemToAvoid ? itemSystem.defenseSpeedFormula(unit, itemToAvoid) : undefined) ??
      'DEFENSE_SPEED';

  // As with attack speed, weight arrives via modify_defense_speed below.
  const speedExpr = db.getEquation(formula);
  const base = speedExpr
    ? evaluateEquation(speedExpr, unit, { db, item })
    : unit.getStatValue('SPD');
  return base + defensiveRankBonus(unit, item, db, 'defense_speed') +
    (item ? itemSystem.modifyDefenseSpeed(unit, item, game) : 0) +
    skillSystem.modifyDefenseSpeed(
      unit, defensiveSkillItem(item, itemToAvoid), game, target, itemToAvoid, mode, attackInfo,
    );
}

export function critAccuracy(
  unit: UnitObject,
  item: ItemObject,
  db: Database,
  game?: any,
  target?: UnitObject | null,
  item2?: ItemObject | null,
  mode: 'attack' | 'defense' | 'splash' = 'attack',
  attackInfo: [number, number] = [0, 0],
): number {
  game ??= _eqGameRef?.();
  const formulaContext = { game, item, target };
  const formula = isForkEngine()
    ? forkFormula(itemSystem.critAccuracyFormula(unit, item), 'CRIT_HIT',
      () => skillSystem.critAccuracyFormula(unit, formulaContext))
    : skillSystem.critAccuracyFormulaOverride(unit) ??
      itemSystem.critAccuracyFormulaOverride(unit, item) ??
      skillSystem.critAccuracyFormula(unit, formulaContext) ??
      itemSystem.critAccuracyFormula(unit, item) ??
      'CRIT_HIT';
  const base = resolveEquation(db, formula, 'SKL // 2', unit);
  return base + (item.getComponent<number>('crit') ?? 0) + rankBonus(unit, item, db, 'crit') +
    itemSystem.modifyCritAccuracy(unit, item) +
    skillSystem.modifyCritAccuracy(
      unit, item, game, target, item2, mode, attackInfo,
    );
}

export function critAvoid(
  unit: UnitObject,
  item: ItemObject | null,
  itemToAvoid: ItemObject | null,
  db: Database,
  game?: any,
  target?: UnitObject | null,
  mode: 'attack' | 'defense' | 'splash' = 'defense',
  attackInfo: [number, number] = [0, 0],
): number {
  game ??= _eqGameRef?.();
  const formulaContext = { game, item: itemToAvoid, target };
  const formula = isForkEngine()
    ? forkFormula(itemToAvoid ? itemSystem.critAvoidFormula(unit, itemToAvoid) : undefined, 'CRIT_AVOID',
      () => skillSystem.critAvoidFormula(unit, formulaContext))
    : skillSystem.critAvoidFormulaOverride(unit) ??
      (itemToAvoid ? itemSystem.critAvoidFormulaOverride(unit, itemToAvoid) : undefined) ??
      skillSystem.critAvoidFormula(unit, formulaContext) ??
      (itemToAvoid ? itemSystem.critAvoidFormula(unit, itemToAvoid) : undefined) ??
      'CRIT_AVOID';
  return resolveEquation(db, formula, 'LCK', unit) + defensiveRankBonus(unit, item, db, 'dodge') +
    skillSystem.modifyCritAvoid(
      unit, defensiveSkillItem(item, itemToAvoid), game, target, itemToAvoid, mode, attackInfo,
    );
}

/**
 * Python's `combat_calcs` module as eval() sees it (evaluate.get_context
 * imports it; no caller passes a `combat_calcs` local). Signatures and
 * defaults follow combat_calcs.py: accuracy/crit_accuracy/attack_speed fall
 * back to unit.get_weapon(), accuracy and crit_accuracy are None for an item
 * without hit/crit, attack_speed without a weapon is defense_speed.
 */
export function pythonCombatCalcsModule(game: any): Record<string, (...args: any[]) => any> {
  const db = (): Database => game?.db ?? _eqGameRef?.()?.db;
  const rawUnit = (candidate: any): UnitObject => candidate?._raw ?? candidate;
  const rawItem = (candidate: any): ItemObject | null => candidate?._raw ?? candidate ?? null;
  const weaponOf = (unit: UnitObject, candidate: any): ItemObject | null =>
    rawItem(candidate) ?? getEquippedWeapon(unit, db(), game);
  const defenseSpeedOf = (unit: UnitObject, item: ItemObject | null, itemToAvoid: ItemObject | null) =>
    defenseSpeed(unit, item, db(), itemToAvoid, game);
  return {
    compute_advantage(unit1: any, unit2: any, item1: any, item2: any, advantage = true) {
      return computeAdvantage(rawUnit(unit1), rawUnit(unit2), rawItem(item1), rawItem(item2), !!advantage, db());
    },
    accuracy(candidate: any, candidateItem?: any) {
      const unit = rawUnit(candidate);
      const item = weaponOf(unit, candidateItem);
      if (!item || itemSystem.hit(unit, item, game) === null) return null;
      return accuracy(unit, item, db(), game);
    },
    avoid(candidate: any, _candidateItem: any, itemToAvoid?: any) {
      return avoid(rawUnit(candidate), db(), undefined, rawItem(itemToAvoid), game);
    },
    crit_accuracy(candidate: any, candidateItem?: any) {
      const unit = rawUnit(candidate);
      const item = weaponOf(unit, candidateItem);
      if (!item || itemSystem.crit(unit, item) === null) return null;
      return critAccuracy(unit, item, db(), game);
    },
    crit_avoid(candidate: any, candidateItem: any, itemToAvoid?: any) {
      return critAvoid(rawUnit(candidate), rawItem(candidateItem), rawItem(itemToAvoid), db(), game);
    },
    attack_speed(candidate: any, candidateItem?: any) {
      const unit = rawUnit(candidate);
      const item = weaponOf(unit, candidateItem);
      return item ? attackSpeed(unit, item, db(), game) : defenseSpeedOf(unit, null, null);
    },
    defense_speed(candidate: any, candidateItem: any, itemToAvoid?: any) {
      return defenseSpeedOf(rawUnit(candidate), rawItem(candidateItem), rawItem(itemToAvoid));
    },
    can_counterattack(attacker: any, attackItem: any, defender: any, _defenseItem?: any) {
      const rawAttacker = rawUnit(attacker);
      const rawDefender = rawUnit(defender);
      const rawAttackItem = rawItem(attackItem);
      return !!rawAttacker && !!rawDefender && !!rawAttackItem &&
        canCounterattack(rawAttacker, rawAttackItem, rawDefender, db(), game);
    },
  };
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
  attackInfo: [number, number] = [0, 0],
  defenseItem?: ItemObject | null,
): number {
  game ??= _eqGameRef?.();
  const defWeapon = defender.items.find((i) => i.isWeapon()) ?? null;
  const acc = accuracy(
    attacker, attackItem, db, game, defender, defWeapon, mode, attackInfo,
  );
  const avo = avoid(
    defender, db, board, attackItem, game, attacker, mode, attackInfo,
  );

  // Dynamic modifiers from items and skills (combat context)
  const itemDynAcc = itemSystem.dynamicAccuracy(
    attacker, attackItem, defender, defWeapon, mode, attackInfo, acc,
  );
  const skillDynAcc = skillSystem.dynamicAccuracy(
    attacker, attackItem, defender, defWeapon, mode, attackInfo, acc,
    game,
  );
  const skillDynAvo = skillSystem.dynamicAvoid(
    defender, defWeapon, attacker, attackItem, mode, attackInfo, avo,
    game,
  );

  // Support bonuses
  const atkSupport = getSupportBonusForCombat(attacker, game);
  const defSupport = getSupportBonusForCombat(defender, game);

  // Python compute_hit adds the weapon-triangle accuracy/avoid term before
  // subtracting avoid and before the single 0-100 clamp.
  const triangle = triangleFor(attackItem, defender, db, game, attacker, defenseItem);
  const raw = acc + itemDynAcc + skillDynAcc + triangle.hitBonus + atkSupport.accuracy -
    avo - skillDynAvo - defSupport.avoid;
  return Math.max(0, Math.min(100, raw));
}

/**
 * Weapon-triangle bonuses for `attacker`'s `attackItem` against the item the
 * defender fights back with. Python passes `def_item` explicitly: the
 * defender's weapon for a main strike, the attacker's item for a counter and
 * None for splash (no triangle). `undefined` resolves the equipped weapon.
 */
function triangleFor(
  attackItem: ItemObject,
  defender: UnitObject,
  db: Database,
  game: any,
  attacker: UnitObject,
  defenseItem: ItemObject | null | undefined,
): ReturnType<typeof weaponTriangle> {
  const item2 = defenseItem === undefined ? getEquippedWeapon(defender, db, game) : defenseItem;
  return weaponTriangle(attackItem, item2, db, attacker, defender);
}

/** Python `DB.constants.value('min_damage')` (EOtF uses 1, LT defaults to 0). */
export function minDamage(db: Database): number {
  const value = Number(db.getConstant('min_damage', 0));
  return Number.isFinite(value) ? Math.trunc(value) : 0;
}

/** `skill_system.critical_multiplier_formula` evaluated for the striker. */
export function criticalMultiplier(
  striker: UnitObject,
  item: ItemObject,
  target: UnitObject,
  db: Database,
  game?: any,
): number {
  const formula = skillSystem.criticalMultiplierFormula(
    striker,
    { game, item, target },
  ) ?? 'CRIT_MULT';
  const expression = db.getEquation(formula) ?? (formula === 'CRIT_MULT' ? '3' : formula);
  return Math.max(0, evaluateEquation(expression, striker, { db, item }));
}

/** `skill_system.critical_addition_formula` evaluated for the striker. */
export function criticalAddition(
  striker: UnitObject,
  item: ItemObject,
  target: UnitObject,
  db: Database,
  game?: any,
): number {
  const formula = skillSystem.criticalAdditionFormula(
    striker,
    { game, item, target },
  ) ?? 'CRIT_ADD';
  const expression = db.getEquation(formula) ?? (formula === 'CRIT_ADD' ? '0' : formula);
  return evaluateEquation(expression, striker, { db, item });
}

/**
 * Python `combat_calcs.compute_damage`, in its exact order (fork and
 * upstream agree):
 *   might = damage + item/skill dynamic_damage + weapon triangle + support
 *   int(might); - defense; - skill dynamic_resist; assist //2
 *   max(min_damage, ·)  (so a crit multiplies at least min_damage)
 *   crit: × crit multiplier, + crit addition (+ modify/dynamic crit addition)
 *   × damage_multiplier × resist_multiplier, then one int(max(min_damage, ·)).
 */
function computeDamageCore(
  attacker: UnitObject,
  attackItem: ItemObject,
  defender: UnitObject,
  db: Database,
  board: GameBoard | null | undefined,
  game: any,
  mode: 'attack' | 'defense' | 'splash',
  assist: boolean,
  attackInfo: [number, number],
  crit: boolean,
  defenseItem: ItemObject | null | undefined,
): number {
  game ??= _eqGameRef?.();
  const defWeapon = defender.items.find((i) => i.isWeapon()) ?? null;
  const atk = damage(
    attacker, attackItem, db, game, defender, defWeapon, mode, attackInfo,
  );
  const defenseMode = mode === 'attack' ? 'defense' : 'attack';
  const def = defense(
    defender, attackItem, db, board, game, attacker, defWeapon,
    defenseMode, attackInfo,
  );
  const triangle = triangleFor(attackItem, defender, db, game, attacker, defenseItem);

  // Effective damage and other dynamic might. EffectiveDamage folds the
  // attacker-only triangle damage advantage into its bonus when
  // `weapon_effectiveness_multiplied` (Python `compute_advantage_attr`).
  let might = atk;
  might += itemSystem.dynamicDamage(
    attacker, attackItem, defender, defWeapon, mode, attackInfo, might, db, game,
    triangle.attackerDamageAdvantage,
  );
  might += skillSystem.dynamicDamage(
    attacker, attackItem, defender, defWeapon, mode, attackInfo, might,
    game,
  );
  might += triangle.damageBonus;

  // Support bonuses
  const atkSupport = getSupportBonusForCombat(attacker, game);
  const defSupport = getSupportBonusForCombat(defender, game);
  might += atkSupport.damage - defSupport.resist;
  might = Math.trunc(might);

  might -= def;
  might -= skillSystem.dynamicResist(
    defender, defWeapon, attacker, attackItem, mode, attackInfo,
    might, game,
  );

  // Attack-stance partners deal half damage after defense.
  if (assist) might = Math.floor(might / 2);

  const floor = minDamage(db);
  might = Math.trunc(Math.max(floor, might));

  if (crit || skillSystem.critAnyway(attacker)) {
    might *= criticalMultiplier(attacker, attackItem, defender, db, game);
    let critAdd = criticalAddition(attacker, attackItem, defender, db, game);
    critAdd += skillSystem.modifyCritDamage(attacker, attackItem, game);
    critAdd += skillSystem.dynamicCritDamageAddition(
      attacker, attackItem, defender, defWeapon, mode, attackInfo, critAdd, game,
    );
    might += critAdd;
    // Thracia crit (+ total might × formula) has no supported content.
  }

  might *= skillSystem.damageMultiplier(
    attacker, attackItem, defender, defWeapon, mode, attackInfo, might, game,
  );
  might *= skillSystem.resistMultiplier(
    defender, defWeapon, attacker, attackItem, mode, attackInfo, might, game,
  );

  return Math.trunc(Math.max(floor, might));
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
  crit: boolean = false,
  defenseItem?: ItemObject | null,
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
      crit, defenseItem,
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

export function computeTrueSpeed(
  attacker: UnitObject,
  attackItem: ItemObject,
  defender: UnitObject,
  defenseItem: ItemObject | null,
  db: Database,
  game?: any,
  mode: 'attack' | 'defense' | 'splash' = 'attack',
  attackInfo: [number, number] = [0, 0],
): number {
  game ??= _eqGameRef?.();
  const defenseMode = mode === 'attack' ? 'defense' : 'attack';
  let speed = attackSpeed(
    attacker, attackItem, db, game, defender, defenseItem, mode, attackInfo,
  );
  speed -= defenseItem
    ? defenseSpeed(
      defender, defenseItem, db, attackItem, game, attacker,
      defenseMode, attackInfo,
    )
    : defender.getStatValue('SPD') +
      skillSystem.modifyDefenseSpeed(
        defender, null, game, attacker, attackItem, defenseMode, attackInfo,
      );
  const atkSupport = getSupportBonusForCombat(attacker, game);
  const defSupport = getSupportBonusForCombat(defender, game);
  speed += atkSupport.attack_speed - defSupport.defense_speed;
  speed += skillSystem.dynamicAttackSpeed(
    attacker, attackItem, defender, defenseItem, mode, attackInfo,
    speed, game,
  );
  speed -= skillSystem.dynamicDefenseSpeed(
    defender, defenseItem, attacker, attackItem, mode, attackInfo,
    speed, game,
  );
  return speed;
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
  game?: any,
  mode: 'attack' | 'defense' | 'splash' = 'attack',
  attackInfo: [number, number] = [0, 0],
): boolean {
  // Item can't double? (e.g., cannot_double component)
  if (!itemSystem.canDouble(attacker, attackItem)) return false;

  // Skill prevents doubling?
  if (skillSystem.noDouble(
    attacker, game, attackItem, defender, defenseItem, mode, attackInfo,
  )) return false;

  const thresholdExpr = db.getEquation('SPEED_TO_DOUBLE');
  const threshold = thresholdExpr ? evaluateEquation(thresholdExpr, attacker) : 4;

  return computeTrueSpeed(
    attacker, attackItem, defender,
    defenseItem ?? defender.items.find((i) => i.isWeapon()) ?? null,
    db, game, mode, attackInfo,
  ) >= threshold;
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
  game?: any,
  attackInfo: [number, number] = [0, 0],
): boolean {
  // defDouble skill allows the defender to double
  if (skillSystem.defDouble(defender)) {
    return canDouble(
      defender, defenseItem, attacker, attackItem, db, game, 'defense', attackInfo,
    );
  }
  // Standard: defender can double if their AS exceeds the attacker's
  return canDouble(
    defender, defenseItem, attacker, attackItem, db, game, 'defense', attackInfo,
  );
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
  const defWeapon = getEquippedWeapon(defender, _db, game);
  if (!defWeapon) return false;

  // Check if the weapon itself can counter
  if (!itemSystem.canCounter(defender, defWeapon)) return false;

  // Compute the Manhattan distance between the two units
  const aPos = attacker.position;
  const dPos = defender.position;
  if (!aPos || !dPos) return false;

  const dist = Math.abs(aPos[0] - dPos[0]) + Math.abs(aPos[1] - dPos[1]);

  // Check if defender has distant_counter (can counter at any range)
  const counterContext = {
    game,
    item: defWeapon,
    target: attacker,
    item2: attackItem,
    mode: 'defense',
  };
  if (skillSystem.distantCounter(defender, counterContext)) return true;

  // Check if defender has close_counter (can counter at range 1 with ranged weapon)
  if (dist === 1 && skillSystem.closeCounter(defender, counterContext)) return true;

  // Standard range check: defender can counter if distance is within their weapon's range
  const minRange = skillSystem.modifiedMinimumRange(defender, defWeapon, game);
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

/** Python weapons.CombatBonus after `modify(w_mod)`, as compute_advantage returns it. */
export interface CombatBonusValue {
  weapon_type: NID;
  weapon_rank: string;
  modification: number;
  damage: number;
  resist: number;
  accuracy: number;
  avoid: number;
  crit: number;
  dodge: number;
  attack_speed: number;
  defense_speed: number;
}

/** Python `combat_calcs.compute_advantage` (the bonus, or None). */
export function computeAdvantage(
  unit1: UnitObject,
  unit2: UnitObject,
  item1: ItemObject | null,
  item2: ItemObject | null,
  advantage: boolean,
  db: Database,
): CombatBonusValue | null {
  if (!item1 || !item2) return null;
  const type1 = itemSystem.weaponTriangleOverride(unit1, item1) || itemSystem.weaponType(unit1, item1);
  const type2 = itemSystem.weaponTriangleOverride(unit2, item2) || itemSystem.weaponType(unit2, item2);
  if (!type1 || !type2) return null;
  if (itemSystem.ignoreWeaponAdvantage(unit1, item1) || itemSystem.ignoreWeaponAdvantage(unit2, item2)) {
    return null;
  }
  const mod1 = itemSystem.modifyWeaponTriangle(unit1, item1);
  const mod2 = itemSystem.modifyWeaponTriangle(unit2, item2);
  const finalMod = Math.sign(mod1) * Math.sign(mod2) * Math.max(Math.abs(mod1), Math.abs(mod2));
  const weapon = db.weapons.find((candidate) => candidate.nid === type1);
  const bonuses = (advantage ? weapon?.advantage : weapon?.disadvantage) ?? [];
  // CombatBonus casts every effect to int on load, then modify() scales it.
  const make = (bonus: WeaponAdvantage): CombatBonusValue => {
    const effect = (value: unknown) => (Math.trunc(Number(value)) || 0) * finalMod;
    return {
      weapon_type: bonus.weapon_type,
      weapon_rank: bonus.weapon_rank,
      modification: finalMod,
      damage: effect(bonus.damage),
      resist: effect(bonus.resist),
      accuracy: effect(bonus.accuracy),
      avoid: effect(bonus.avoid),
      crit: effect(bonus.crit),
      dodge: effect(bonus.dodge),
      attack_speed: effect(bonus.attack_speed),
      defense_speed: effect(bonus.defense_speed),
    };
  };
  let highestRequirement = -1;
  let result: CombatBonusValue | null = null;
  for (const bonus of bonuses) {
    if (bonus.weapon_type !== 'All' && bonus.weapon_type !== type2) continue;
    if (bonus.weapon_rank === 'All') return make(bonus);
    const requirement = db.weaponRanks.find((rank) => rank.rank === bonus.weapon_rank)?.requirement ?? Infinity;
    if (Number(unit1.wexp[type1] ?? 0) >= requirement && requirement > highestRequirement) {
      highestRequirement = requirement;
      result = make(bonus);
    }
  }
  return result;
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
  game ??= _eqGameRef?.();
  const defWeapon = getEquippedWeapon(defender, db, game);
  const baseCrit = critAccuracy(
    attacker, attackItem, db, game, defender, defWeapon, mode, attackInfo,
  );
  const staticCritAvoid = critAvoid(
    defender, defWeapon, attackItem, db, game, attacker,
    mode === 'attack' ? 'defense' : 'attack', attackInfo,
  );

  // Support bonuses
  const atkSupport = getSupportBonusForCombat(attacker, game);
  const defSupport = getSupportBonusForCombat(defender, game);

  const baseValue = baseCrit + atkSupport.crit - staticCritAvoid - defSupport.dodge;
  const dynamicCrit = skillSystem.dynamicCritAccuracy(
    attacker,
    attackItem,
    defender,
    defWeapon,
    mode,
    attackInfo,
    baseValue,
    game,
  );
  const dynamicDodge = skillSystem.dynamicCritAvoid(
    defender,
    defWeapon,
    attacker,
    attackItem,
    mode,
    attackInfo,
    baseValue,
    game,
  );
  const raw = baseValue + dynamicCrit - dynamicDodge;
  const multiplier = skillSystem.critMultiplier(
    attacker,
    attackItem,
    defender,
    defWeapon,
    mode,
    attackInfo,
    raw,
    game,
  );
  return Math.max(0, Math.min(100, Math.trunc(raw * multiplier)));
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
  const itemExtra = itemSystem.dynamicMultiattacks(
    unit, item, target, defenseItem, mode, null, 0, game ?? _eqGameRef?.(),
  );
  count += itemExtra;

  // Dynamic multiattacks from skills
  const skillExtra = skillSystem.dynamicMultiattacks(
    unit, item, target, defenseItem, mode, attackInfo, count - 1, game,
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
  return Math.max(0, skillSystem.dynamicAttacks(
    unit, item, target, defenseItem, mode, attackInfo, 0, game,
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
  return Math.max(0, skillSystem.dynamicBlitzes(
    unit, item, target, defenseItem, mode, attackInfo, 0, game,
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
