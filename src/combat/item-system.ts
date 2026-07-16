/**
 * item_system.ts — Dispatch layer for item component hooks.
 *
 * Mirrors LT's generated item_system.py. For each hook, iterates the
 * item's components and resolves the result via the appropriate policy
 * (UNIQUE, ALL_DEFAULT_FALSE, NUMERIC_ACCUM, etc.).
 *
 * Components are stored as Map<string, any> on ItemObject. The component
 * NID determines behaviour; the value is the stored data.
 */

import type { UnitObject } from '../objects/unit';
import type { ItemObject } from '../objects/item';
import type { GameBoard } from '../objects/game-board';
import type { Database } from '../data/database';
import { evaluateCondition } from '../events/event-manager';
import type { CombatStrike } from './combat-solver';

export type TargetPosition = [number, number];

/**
 * Union the positions contributed by LT's basic target components.
 *
 * Mirrors item_system_base.valid_targets(): every component that defines the
 * hook contributes positions to one shared set. Range, fog, line-of-sight,
 * splash, and target-restriction filtering belong to TargetSystem.
 */
export function validTargets(
  unit: UnitObject,
  item: ItemObject,
  board: GameBoard,
  db: Database,
): TargetPosition[] {
  const targets = new Map<string, TargetPosition>();
  const add = (position: TargetPosition): void => {
    targets.set(`${position[0]},${position[1]}`, position);
  };

  if (item.hasComponent('target_tile')) {
    for (let x = 0; x < board.width; x++) {
      for (let y = 0; y < board.height; y++) add([x, y]);
    }
  }

  const targetUnits = item.hasComponent('target_unit');
  const targetEnemies = item.hasComponent('target_enemy');
  const targetAllies = item.hasComponent('target_ally');
  if (targetUnits || targetEnemies || targetAllies) {
    for (const other of board.getAllUnits()) {
      if (!other.position || other.isDead()) continue;
      if (targetUnits ||
          (targetEnemies && !db.areAllied(unit.team, other.team)) ||
          (targetAllies && db.areAllied(unit.team, other.team))) {
        add([other.position[0], other.position[1]]);
      }
    }
  }

  return [...targets.values()];
}

export interface TargetRestrictionContext {
  board: GameBoard;
  db: Database;
  game?: any;
}

export interface SplashContext {
  board: GameBoard;
  db: Database;
  evaluateRangeEquation?: (equationNid: string) => number;
}

export interface SplashResult {
  mainTarget: TargetPosition | null;
  splash: TargetPosition[];
}

/** Python Repair.item_restrict: finite-use, damaged, and not explicitly unrepairable. */
export function isRepairableItem(item: ItemObject): boolean {
  return item.maxUses > 0 && item.uses < item.maxUses && !item.hasComponent('unrepairable');
}

function positionsInRadius(
  center: TargetPosition,
  radius: number,
  board: GameBoard,
): TargetPosition[] {
  const positions: TargetPosition[] = [];
  for (let x = center[0] - radius; x <= center[0] + radius; x++) {
    for (let y = center[1] - radius; y <= center[1] + radius; y++) {
      if (board.inBounds(x, y) && Math.abs(x - center[0]) + Math.abs(y - center[1]) <= radius) {
        positions.push([x, y]);
      }
    }
  }
  return positions;
}

/** Resolve the item's main target and affected splash positions. */
export function splash(
  unit: UnitObject,
  item: ItemObject,
  position: TargetPosition,
  context: SplashContext,
): SplashResult {
  const board = context.board;
  const spell = isSpell(unit, item);
  const blastValue = item.getComponent<number>('blast_aoe')
    ?? item.getComponent<number>('enemy_blast_aoe')
    ?? item.getComponent<number>('ally_blast_aoe')
    ?? item.getComponent<number>('smart_blast_aoe');
  const equationBlast = item.getComponent<string>('equation_blast_aoe')
    ?? item.getComponent<string>('ally_equation_blast_aoe');

  if (blastValue !== undefined || equationBlast) {
    const radius = equationBlast
      ? Math.max(0, context.evaluateRangeEquation?.(equationBlast) ?? 0)
      : Math.max(0, Number(blastValue));
    const positions = positionsInRadius(position, radius, board);
    const enemyOnly = item.hasComponent('enemy_blast_aoe') ||
      (item.hasComponent('smart_blast_aoe') && item.hasComponent('target_enemy'));
    const allyOnly = item.hasComponent('ally_blast_aoe') || item.hasComponent('ally_equation_blast_aoe') ||
      (item.hasComponent('smart_blast_aoe') && item.hasComponent('target_ally'));
    const affected = positions.filter((candidate) => {
      const target = board.getUnit(candidate[0], candidate[1]);
      if (!target) return false;
      if (enemyOnly) return !context.db.areAllied(unit.team, target.team);
      if (allyOnly) return context.db.areAllied(unit.team, target.team);
      return true;
    });
    if (spell) return { mainTarget: null, splash: affected };
    const mainTarget = board.getUnit(position[0], position[1]) ? position : null;
    return {
      mainTarget,
      splash: affected.filter((candidate) => candidate[0] !== position[0] || candidate[1] !== position[1]),
    };
  }

  if (item.hasComponent('all_allies_aoe') || item.hasComponent('all_allies_except_self_aoe')) {
    const excludeSelf = item.hasComponent('all_allies_except_self_aoe');
    return {
      mainTarget: null,
      splash: board.getAllUnits()
        .filter((target) => target.position && context.db.areAllied(unit.team, target.team) && (!excludeSelf || target !== unit))
        .map((target) => [target.position![0], target.position![1]] as TargetPosition),
    };
  }

  if (item.hasComponent('all_enemies_aoe')) {
    const affected = board.getAllUnits()
      .filter((target) => target.position && !context.db.areAllied(unit.team, target.team))
      .map((target) => [target.position![0], target.position![1]] as TargetPosition);
    return spell
      ? { mainTarget: null, splash: affected }
      : { mainTarget: board.getUnit(position[0], position[1]) ? position : null, splash: affected };
  }

  return { mainTarget: position, splash: [] };
}

/** Positions highlighted by splash preview; defaults to the selected position. */
export function splashPositions(
  unit: UnitObject,
  item: ItemObject,
  position: TargetPosition,
  context: SplashContext,
): TargetPosition[] {
  const result = splash(unit, item, position, context);
  const positions = new Map<string, TargetPosition>();
  if (result.mainTarget) positions.set(`${result.mainTarget[0]},${result.mainTarget[1]}`, result.mainTarget);
  for (const candidate of result.splash) positions.set(`${candidate[0]},${candidate[1]}`, candidate);
  return positions.size > 0 ? [...positions.values()] : [position];
}

export function numTargets(_unit: UnitObject, item: ItemObject): number {
  return Math.max(1, Number(item.getComponent<number>('multi_target') ?? 1));
}

export function allowSameTarget(_unit: UnitObject, item: ItemObject): boolean {
  return item.hasComponent('allow_same_target');
}

export function allowLessThanMaxTargets(_unit: UnitObject, item: ItemObject): boolean {
  return item.hasComponent('allow_less_than_max_targets');
}

export function ignoreLineOfSight(_unit: UnitObject, item: ItemObject): boolean {
  return item.hasComponent('ignore_line_of_sight');
}

export function allowTargetInFogOfWar(_unit: UnitObject, item: ItemObject): boolean {
  return item.hasComponent('target_fog_of_war');
}

export function ignoreFogOfWar(_unit: UnitObject, item: ItemObject): boolean {
  return item.hasComponent('ignore_fog_of_war');
}

function usesOption(item: ItemObject, key: 'lose_uses_on_miss' | 'one_loss_per_combat'): boolean {
  const value = item.getComponent<any>('uses_options');
  if (value && !Array.isArray(value) && typeof value === 'object') return !!value[key];
  if (Array.isArray(value)) {
    const entry = value.find((candidate: any) => Array.isArray(candidate) && candidate[0] === key);
    return entry ? entry[1] === true || entry[1] === 'T' : false;
  }
  return false;
}

export function loseUsesOnMiss(_unit: UnitObject, item: ItemObject): boolean {
  return usesOption(item, 'lose_uses_on_miss');
}

export function oneLossPerCombat(_unit: UnitObject, item: ItemObject): boolean {
  return usesOption(item, 'one_loss_per_combat');
}

/** Number of durability points consumed by one side's resolved strikes. */
export function usesConsumedByStrikes(
  unit: UnitObject,
  item: ItemObject,
  strikes: CombatStrike[],
): number {
  const ownStrikes = strikes.filter((strike) => strike.attacker === unit && strike.item === item);
  const qualifying = ownStrikes.filter((strike) => strike.hit || loseUsesOnMiss(unit, item));
  if (oneLossPerCombat(unit, item)) return qualifying.length > 0 ? 1 : 0;
  return qualifying.length;
}

/** Apply every component target restriction (ALL policy). */
export function targetRestrict(
  unit: UnitObject,
  item: ItemObject,
  defPos: TargetPosition,
  splash: TargetPosition[],
  context: TargetRestrictionContext,
): boolean {
  const affectedUnits = [defPos, ...splash]
    .map((position) => context.board.getUnit(position[0], position[1]))
    .filter((target): target is UnitObject => !!target);

  if (item.hasComponent('heal') || item.hasComponent('equation_heal')) {
    if (!affectedUnits.some((target) => target.currentHp < target.maxHp)) return false;
  }

  if (item.hasComponent('refresh') && !affectedUnits.some((target) => target.finished)) {
    return false;
  }

  if (item.hasComponent('restore') || item.hasComponent('restore_specific')) {
    const specific = item.getComponent<string>('restore_specific');
    const canRestore = affectedUnits.some((target) => target.skills.some((skill) =>
      specific ? skill.nid === specific : skill.hasComponent('negative'),
    ));
    if (!canRestore) return false;
  }

  if (item.hasComponent('repair')) {
    const defender = context.board.getUnit(defPos[0], defPos[1]);
    if (!defender || !defender.items.some(isRepairableItem)) return false;
  }

  if (item.hasComponent('empty_tile_target_restrict') &&
      context.board.getUnit(defPos[0], defPos[1])) {
    return false;
  }

  if (item.hasComponent('traversable_tile_target_restrict')) {
    const movementGroup = context.db.classes.get(unit.klass)?.movement_group ?? 'Infantry';
    const movementCost = context.board.getMovementCost(defPos[0], defPos[1], movementGroup, context.db);
    if (movementCost > unit.getMovement()) return false;
  }

  const expression = item.getComponent<string>('eval_target_restrict_2');
  if (expression) {
    const positions = [defPos, ...splash];
    const passes = positions.some((targetPos) => evaluateCondition(expression, {
      game: context.game,
      unit1: unit,
      unit2: context.board.getUnit(targetPos[0], targetPos[1]),
      position: unit.position ?? undefined,
      item,
      gameVars: context.game?.gameVars,
      levelVars: context.game?.levelVars,
      localArgs: new Map([['target_pos', targetPos]]),
    }));
    if (!passes) return false;
  }

  return true;
}

/** Relative positions allowed by eval_special_range, or null when unrestricted. */
export function rangeRestrict(
  _unit: UnitObject,
  item: ItemObject,
  maxRange: number,
): Set<string> | null {
  const expression = item.getComponent<string>('eval_special_range');
  if (!expression) return null;

  const allowed = new Set<string>();
  try {
    const jsExpression = expression
      .replace(/\bTrue\b/g, 'true')
      .replace(/\bFalse\b/g, 'false')
      .replace(/\band\b/g, '&&')
      .replace(/\bor\b/g, '||')
      .replace(/\bnot\b/g, '!');
    const predicate = new Function('x', 'y', `"use strict"; return Boolean(${jsExpression});`);
    for (let x = -maxRange; x <= maxRange; x++) {
      for (let y = -maxRange; y <= maxRange; y++) {
        if (predicate(x, y)) allowed.add(`${x},${y}`);
      }
    }
  } catch (error) {
    console.warn(`ItemSystem: eval_special_range failed for "${expression}"`, error);
  }
  return allowed;
}

// ============================================================
// Value hooks (UNIQUE — return the first/only defined value)
// ============================================================

/** Get the weapon type NID, or undefined. */
export function weaponType(_unit: UnitObject, item: ItemObject): string | undefined {
  return item.getComponent<string>('weapon_type');
}

/** Get base damage value from the weapon. */
export function damage(_unit: UnitObject, item: ItemObject): number | null {
  return item.getComponent<number>('damage') ?? null;
}

/** Get base hit value from the weapon. */
export function hit(_unit: UnitObject, item: ItemObject): number | null {
  return item.getComponent<number>('hit') ?? null;
}

/** Get base crit value from the weapon. */
export function crit(_unit: UnitObject, item: ItemObject): number | null {
  return item.getComponent<number>('crit') ?? null;
}

/** Get the minimum range. */
export function minimumRange(_unit: UnitObject, item: ItemObject): number {
  return item.getComponent<number>('min_range') ?? 0;
}

/** Get the maximum range. */
export function maximumRange(_unit: UnitObject, item: ItemObject): number {
  return item.getComponent<number>('max_range') ?? 0;
}

/** Get the weapon rank requirement. */
export function weaponRank(_unit: UnitObject, item: ItemObject): string | undefined {
  return item.getComponent<string>('weapon_rank');
}

/** Get the weight of the item. */
export function weight(_unit: UnitObject, item: ItemObject): number {
  return item.getComponent<number>('weight') ?? 0;
}

// ============================================================
// Boolean hooks (ALL_DEFAULT_FALSE)
// ============================================================

/** Is this a weapon? */
export function isWeapon(_unit: UnitObject, item: ItemObject): boolean {
  return item.hasComponent('weapon');
}

/** Is this a spell/magic weapon? */
export function isSpell(_unit: UnitObject, item: ItemObject): boolean {
  return item.hasComponent('spell') || item.hasComponent('magic');
}

/** Can this item counter? */
export function canCounter(_unit: UnitObject, item: ItemObject): boolean {
  // Default true for weapons unless 'no_counter' is set
  if (!item.hasComponent('weapon')) return false;
  if (item.hasComponent('no_counter')) return false;
  return true;
}

/** Can this item be countered? */
export function canBeCountered(_unit: UnitObject, item: ItemObject): boolean {
  if (item.hasComponent('cannot_be_countered')) return false;
  return true;
}

/** Can this weapon double? */
export function canDouble(_unit: UnitObject, item: ItemObject): boolean {
  if (item.hasComponent('cannot_double')) return false;
  return true;
}

/** Does this item ignore weapon advantage? */
export function ignoreWeaponAdvantage(_unit: UnitObject, item: ItemObject): boolean {
  return item.hasComponent('ignore_weapon_advantage');
}

// ============================================================
// Static modifier hooks (NUMERIC_ACCUM — sum all contributions)
// ============================================================

/** Bonus damage from item components. */
export function modifyDamage(_unit: UnitObject, item: ItemObject): number {
  let total = 0;
  // 'modify_damage' component on the item itself
  const mod = item.getComponent<number>('modify_damage');
  if (typeof mod === 'number') total += mod;
  return total;
}

/** Bonus resist/defense from item components. */
export function modifyResist(_unit: UnitObject, item: ItemObject): number {
  let total = 0;
  const mod = item.getComponent<number>('modify_resist');
  if (typeof mod === 'number') total += mod;
  return total;
}

/** Bonus accuracy from item components. */
export function modifyAccuracy(_unit: UnitObject, item: ItemObject): number {
  let total = 0;
  const mod = item.getComponent<number>('modify_accuracy');
  if (typeof mod === 'number') total += mod;
  return total;
}

/** Bonus avoid from item components. */
export function modifyAvoid(_unit: UnitObject, item: ItemObject): number {
  let total = 0;
  const mod = item.getComponent<number>('modify_avoid');
  if (typeof mod === 'number') total += mod;
  return total;
}

/** Bonus crit accuracy from item components. */
export function modifyCritAccuracy(_unit: UnitObject, item: ItemObject): number {
  let total = 0;
  const mod = item.getComponent<number>('modify_crit_accuracy');
  if (typeof mod === 'number') total += mod;
  return total;
}

/** Bonus crit damage from item components. */
export function modifyCritDamage(_unit: UnitObject, item: ItemObject): number {
  let total = 0;
  const mod = item.getComponent<number>('modify_crit_damage');
  if (typeof mod === 'number') total += mod;
  return total;
}

/** Attack speed modifier from item components (e.g., from weight). */
export function modifyAttackSpeed(_unit: UnitObject, item: ItemObject): number {
  let total = 0;
  const mod = item.getComponent<number>('modify_attack_speed');
  if (typeof mod === 'number') total += mod;
  return total;
}

// ============================================================
// Dynamic modifier hooks (NUMERIC_ACCUM with combat context)
// ============================================================

/**
 * Dynamic damage modifier — effective damage, situational bonuses, etc.
 * Called during combat with full attacker/defender context.
 */
export function dynamicDamage(
  unit: UnitObject,
  item: ItemObject,
  target: UnitObject,
  _item2: ItemObject | null,
  _mode: string,
  _attackInfo: any,
  _baseValue: number,
): number {
  let total = 0;

  // Effective damage: check if the weapon is effective against the target
  const effectiveComp = item.getComponent<any>('effective');
  if (effectiveComp) {
    const tags: string[] = effectiveComp.effective_tags ?? effectiveComp ?? [];
    const multiplier: number = effectiveComp.effective_multiplier ?? 3;
    const bonusDamage: number = effectiveComp.effective_bonus_damage ?? 0;

    // Check if target has any of the effective tags
    const targetTags = target.tags ?? [];
    const isEffective = (Array.isArray(tags) ? tags : []).some(
      (tag: string) => targetTags.includes(tag),
    );

    if (isEffective) {
      if (effectiveComp.weapon_effectiveness_multiplied) {
        // Multiply the weapon's base damage
        const weaponDmg = item.getDamage();
        total += weaponDmg * (multiplier - 1); // -1 because base is already counted
      }
      total += bonusDamage;
    }
  }

  // magic_at_range: swap from physical to magical damage formula at range > 1.
  // Python MagicAtRange.dynamic_damage subtracts DAMAGE (STR) and adds MAGIC_DAMAGE (MAG),
  // subtracts DEFENSE target and adds MAGIC_DEFENSE target, effectively swapping formulas.
  if (item.hasComponent('magic_at_range')) {
    const uPos = unit.position;
    const tPos = target.position;
    if (uPos && tPos) {
      const dist = Math.abs(uPos[0] - tPos[0]) + Math.abs(uPos[1] - tPos[1]);
      if (dist > 1) {
        const normalDamage = unit.getStatValue('STR');
        const newDamage = unit.getStatValue('MAG');
        const normalResist = target.getStatValue('DEF');
        const newResist = target.getStatValue('RES');
        total += -normalDamage + newDamage + normalResist - newResist;
      }
    }
  }

  // Brave component: handled via dynamicMultiattacks instead
  return total;
}

/**
 * Dynamic extra attacks (e.g., brave weapons).
 * Returns the number of additional multi-attacks (0 = normal).
 */
export function dynamicMultiattacks(
  _unit: UnitObject,
  item: ItemObject,
  _target: UnitObject,
  _item2: ItemObject | null,
  _mode: string,
  _attackInfo: any,
  _baseValue: number,
): number {
  // Brave: weapon hits twice per attack
  if (item.hasComponent('brave')) return 1;
  return 0;
}

/** Dynamic accuracy modifier. */
export function dynamicAccuracy(
  _unit: UnitObject,
  _item: ItemObject,
  _target: UnitObject,
  _item2: ItemObject | null,
  _mode: string,
  _attackInfo: any,
  _baseValue: number,
): number {
  return 0;
}

/** Dynamic attack speed modifier. */
export function dynamicAttackSpeed(
  _unit: UnitObject,
  _item: ItemObject,
  _target: UnitObject,
  _item2: ItemObject | null,
  _mode: string,
  _attackInfo: any,
  _baseValue: number,
): number {
  return 0;
}
