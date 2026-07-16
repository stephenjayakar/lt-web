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
import { alternateSplash, empowerSplash, type AlternateSplash } from './skill-system';

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
  evaluateEquation?: (equationNid: string, unit: UnitObject, item?: ItemObject) => number;
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

/** Match LT's separate accessory/non-accessory inventory capacity. */
export function inventoryFull(unit: UnitObject, item: ItemObject, db: Database): boolean {
  const accessory = item.hasComponent('accessory');
  const limit = Number(db.getConstant(accessory ? 'num_accessories' : 'num_items', accessory ? 0 : 5));
  const count = unit.items.filter((candidate) => candidate.hasComponent('accessory') === accessory).length;
  return count >= limit;
}

export function unstealable(_unit: UnitObject, item: ItemObject): boolean {
  return item.hasComponent('locked') || item.hasComponent('unstealable');
}

/** Per-item Steal eligibility; generic Steal allows unequipped weapons, GBA Steal does not. */
export function stealItemRestrict(
  stealer: UnitObject,
  stealItem: ItemObject,
  defender: UnitObject,
  targetItem: ItemObject,
  db: Database,
): boolean {
  if (unstealable(defender, targetItem) || inventoryFull(stealer, targetItem, db)) return false;
  if (stealItem.hasComponent('gba_steal')) {
    return !targetItem.isWeapon() && !targetItem.isSpell();
  }
  return targetItem !== defender.getEquippedWeapon();
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

function samePosition(left: TargetPosition, right: TargetPosition): boolean {
  return left[0] === right[0] && left[1] === right[1];
}

/** LT's taxicab-grid raytrace, including both endpoints. */
function raytrace(start: TargetPosition, end: TargetPosition): TargetPosition[] {
  let [x, y] = start;
  const dx0 = Math.abs(end[0] - start[0]);
  const dy0 = Math.abs(end[1] - start[1]);
  const xInc = end[0] > start[0] ? 1 : -1;
  const yInc = end[1] > start[1] ? 1 : -1;
  let error = dx0 - dy0;
  const dx = dx0 * 2;
  const dy = dy0 * 2;
  const result: TargetPosition[] = [];
  let remaining = 1 + dx0 + dy0;
  while (remaining > 0) {
    result.push([x, y]);
    if (error > 0) {
      x += xInc;
      error -= dy;
    } else {
      y += yInc;
      error += dx;
    }
    remaining--;
  }
  return result;
}

function adjacentToUnit(unit: UnitObject, board: GameBoard): TargetPosition[] {
  if (!unit.position) return [];
  const positions: TargetPosition[] = [];
  for (let x = unit.position[0] - 1; x <= unit.position[0] + 1; x++) {
    for (let y = unit.position[1] - 1; y <= unit.position[1] + 1; y++) {
      if ((x !== unit.position[0] || y !== unit.position[1]) && board.inBounds(x, y)) {
        positions.push([x, y]);
      }
    }
  }
  return positions;
}

interface ShapeBlastValue {
  shape: TargetPosition[];
  target: 'ally' | 'enemy' | 'all';
  range: number;
}

function shapeBlastValue(value: unknown): ShapeBlastValue {
  const normalized = Array.isArray(value) && value.every((entry) => Array.isArray(entry) && entry.length === 2)
    ? Object.fromEntries(value as [string, unknown][])
    : (value && typeof value === 'object' ? value as Record<string, unknown> : {});
  const shape = Array.isArray((normalized as any).shape)
    ? (normalized as any).shape.filter((entry: unknown) =>
      Array.isArray(entry) && entry.length >= 2 && Number.isFinite(Number(entry[0])) && Number.isFinite(Number(entry[1])),
    ).map((entry: unknown[]) => [Number(entry[0]), Number(entry[1])] as TargetPosition)
    : [];
  const target = (normalized as any).target;
  return {
    shape,
    target: target === 'enemy' || target === 'all' ? target : 'ally',
    range: Math.max(0, Number((normalized as any).range ?? 1)),
  };
}

function shapedPositions(
  center: TargetPosition,
  value: ShapeBlastValue,
  extraRange: number,
  board: GameBoard,
): TargetPosition[] {
  const positions = new Map<string, TargetPosition>();
  for (let distance = 1; distance <= value.range + extraRange; distance++) {
    for (const [dx, dy] of value.shape) {
      const candidate: TargetPosition = [center[0] + distance * dx, center[1] + distance * dy];
      if (board.inBounds(candidate[0], candidate[1])) {
        positions.set(`${candidate[0]},${candidate[1]}`, candidate);
      }
    }
  }
  return [...positions.values()];
}

function affectedUnits(
  positions: TargetPosition[],
  unit: UnitObject,
  context: SplashContext,
  target: 'ally' | 'enemy' | 'all',
): TargetPosition[] {
  return positions.filter((candidate) => {
    const other = context.board.getUnit(candidate[0], candidate[1]);
    if (!other) return false;
    if (target === 'enemy') return !context.db.areAllied(unit.team, other.team);
    if (target === 'ally') return context.db.areAllied(unit.team, other.team);
    return true;
  });
}

function resolveBlast(
  unit: UnitObject,
  item: ItemObject,
  position: TargetPosition,
  context: SplashContext,
  radius: number,
  target: 'ally' | 'enemy' | 'all',
): SplashResult {
  const affected = affectedUnits(positionsInRadius(position, radius, context.board), unit, context, target);
  if (isSpell(unit, item)) return { mainTarget: null, splash: affected };
  const mainTarget = context.board.getUnit(position[0], position[1]) ? position : null;
  return { mainTarget, splash: affected.filter((candidate) => !samePosition(candidate, position)) };
}

function resolveCleave(
  unit: UnitObject,
  position: TargetPosition,
  context: SplashContext,
): SplashResult {
  const nearby = adjacentToUnit(unit, context.board).filter((candidate) => !samePosition(candidate, position));
  return {
    mainTarget: context.board.getUnit(position[0], position[1]) ? position : null,
    splash: affectedUnits(nearby, unit, context, 'enemy'),
  };
}

function alternateSplashResult(
  kind: AlternateSplash,
  unit: UnitObject,
  item: ItemObject,
  position: TargetPosition,
  context: SplashContext,
): SplashResult {
  if (kind === 'enemy_cleave') return resolveCleave(unit, position, context);
  const target = kind === 'enemy_blast' ? 'enemy'
    : kind === 'smart_blast' && item.hasComponent('target_enemy') ? 'enemy'
      : kind === 'smart_blast' && item.hasComponent('target_ally') ? 'ally' : 'all';
  return resolveBlast(unit, item, position, context, empowerSplash(unit), target);
}

function itemIsUnsplashable(item: ItemObject): boolean {
  return item.hasComponent('unsplashable') || item.hasComponent('shape_blast_aoe');
}

function resultOrAlternate(
  result: SplashResult,
  unit: UnitObject,
  item: ItemObject,
  position: TargetPosition,
  context: SplashContext,
): SplashResult {
  if (result.mainTarget || result.splash.length > 0) return result;
  const alternate = alternateSplash(unit);
  return alternate && !itemIsUnsplashable(item)
    ? alternateSplashResult(alternate, unit, item, position, context)
    : result;
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
  const extraRange = empowerSplash(unit);
  const blastValue = item.getComponent<number>('blast_aoe')
    ?? item.getComponent<number>('enemy_blast_aoe')
    ?? item.getComponent<number>('ally_blast_aoe')
    ?? item.getComponent<number>('smart_blast_aoe');
  const equationBlast = item.getComponent<string>('equation_blast_aoe')
    ?? item.getComponent<string>('ally_equation_blast_aoe');

  if (blastValue !== undefined || equationBlast) {
    const radius = (equationBlast
      ? Math.max(0, context.evaluateRangeEquation?.(equationBlast) ?? 0)
      : Math.max(0, Number(blastValue))) + extraRange;
    const enemyOnly = item.hasComponent('enemy_blast_aoe') ||
      (item.hasComponent('smart_blast_aoe') && item.hasComponent('target_enemy'));
    const allyOnly = item.hasComponent('ally_blast_aoe') || item.hasComponent('ally_equation_blast_aoe') ||
      (item.hasComponent('smart_blast_aoe') && item.hasComponent('target_ally'));
    return resultOrAlternate(
      resolveBlast(unit, item, position, context, radius, enemyOnly ? 'enemy' : allyOnly ? 'ally' : 'all'),
      unit, item, position, context,
    );
  }

  if (item.hasComponent('shape_blast_aoe')) {
    const value = shapeBlastValue(item.getComponent('shape_blast_aoe'));
    const affected = affectedUnits(shapedPositions(position, value, extraRange, board), unit, context, value.target);
    const result: SplashResult = spell ? { mainTarget: null, splash: affected } : {
      mainTarget: board.getUnit(position[0], position[1]) ? position : null,
      splash: affected.filter((candidate) => !samePosition(candidate, position)),
    };
    return resultOrAlternate(result, unit, item, position, context);
  }

  if (item.hasComponent('enemy_cleave_aoe')) {
    return resultOrAlternate(resolveCleave(unit, position, context), unit, item, position, context);
  }

  if ((item.hasComponent('line_aoe') || item.hasComponent('enemy_line_aoe')) && unit.position) {
    const line = raytrace(unit.position, position).filter((candidate) => !samePosition(candidate, unit.position!));
    const target = item.hasComponent('enemy_line_aoe') ? 'enemy' : 'all';
    const affected = affectedUnits(line, unit, context, target);
    const result: SplashResult = spell ? { mainTarget: null, splash: affected } : {
      mainTarget: board.getUnit(position[0], position[1]) ? position : null,
      splash: affected.filter((candidate) => !samePosition(candidate, position)),
    };
    return resultOrAlternate(result, unit, item, position, context);
  }

  if (item.hasComponent('all_allies_aoe') || item.hasComponent('all_allies_except_self_aoe')) {
    const excludeSelf = item.hasComponent('all_allies_except_self_aoe');
    return resultOrAlternate({
      mainTarget: null,
      splash: board.getAllUnits()
        .filter((target) => target.position && context.db.areAllied(unit.team, target.team) && (!excludeSelf || target !== unit))
        .map((target) => [target.position![0], target.position![1]] as TargetPosition),
    }, unit, item, position, context);
  }

  if (item.hasComponent('all_enemies_aoe')) {
    const affected = board.getAllUnits()
      .filter((target) => target.position && !context.db.areAllied(unit.team, target.team))
      .map((target) => [target.position![0], target.position![1]] as TargetPosition);
    const result = spell
      ? { mainTarget: null, splash: affected }
      : { mainTarget: board.getUnit(position[0], position[1]) ? position : null, splash: affected };
    return resultOrAlternate(result, unit, item, position, context);
  }

  const alternate = alternateSplash(unit);
  if (alternate && !itemIsUnsplashable(item)) {
    return alternateSplashResult(alternate, unit, item, position, context);
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
  const board = context.board;
  const extraRange = empowerSplash(unit);
  const blastValue = item.getComponent<number>('blast_aoe')
    ?? item.getComponent<number>('enemy_blast_aoe')
    ?? item.getComponent<number>('ally_blast_aoe')
    ?? item.getComponent<number>('smart_blast_aoe');
  const equationBlast = item.getComponent<string>('equation_blast_aoe')
    ?? item.getComponent<string>('ally_equation_blast_aoe');
  if (blastValue !== undefined || equationBlast) {
    const radius = (equationBlast
      ? Math.max(0, context.evaluateRangeEquation?.(equationBlast) ?? 0)
      : Math.max(0, Number(blastValue))) + extraRange;
    let positions = positionsInRadius(position, radius, board);
    const enemyOnly = item.hasComponent('enemy_blast_aoe') ||
      (item.hasComponent('smart_blast_aoe') && item.hasComponent('target_enemy'));
    if (enemyOnly) {
      positions = positions.filter((candidate) => {
        const other = board.getUnit(candidate[0], candidate[1]);
        return !other || !context.db.areAllied(unit.team, other.team);
      });
    }
    return positions;
  }
  if (item.hasComponent('shape_blast_aoe')) {
    const positions = shapedPositions(position, shapeBlastValue(item.getComponent('shape_blast_aoe')), extraRange, board);
    return positions.length > 0 ? positions : [position];
  }
  if (item.hasComponent('enemy_cleave_aoe')) {
    const positions = adjacentToUnit(unit, board)
      .filter((candidate) => !samePosition(candidate, position))
      .filter((candidate) => {
        const other = board.getUnit(candidate[0], candidate[1]);
        return !other || !context.db.areAllied(unit.team, other.team);
      });
    if (positions.length > 0) return positions;
  }
  if ((item.hasComponent('line_aoe') || item.hasComponent('enemy_line_aoe')) && unit.position) {
    let positions = raytrace(unit.position, position).filter((candidate) => !samePosition(candidate, unit.position!));
    if (item.hasComponent('enemy_line_aoe')) {
      positions = positions.filter((candidate) => {
        const other = board.getUnit(candidate[0], candidate[1]);
        return !other || !context.db.areAllied(unit.team, other.team);
      });
    }
    if (positions.length > 0) return positions;
  }
  if (item.hasComponent('all_allies_aoe') || item.hasComponent('all_allies_except_self_aoe')) {
    const positions: TargetPosition[] = [];
    for (let x = 0; x < board.width; x++) for (let y = 0; y < board.height; y++) positions.push([x, y]);
    return positions;
  }
  if (item.hasComponent('all_enemies_aoe')) {
    const positions: TargetPosition[] = [];
    for (let x = 0; x < board.width; x++) {
      for (let y = 0; y < board.height; y++) {
        const other = board.getUnit(x, y);
        if (!other || !context.db.areAllied(unit.team, other.team)) positions.push([x, y]);
      }
    }
    return positions;
  }
  const alternate = alternateSplash(unit);
  if (alternate && !itemIsUnsplashable(item)) {
    if (alternate === 'enemy_cleave') {
      return adjacentToUnit(unit, board)
        .filter((candidate) => !samePosition(candidate, position))
        .filter((candidate) => {
          const other = board.getUnit(candidate[0], candidate[1]);
          return !other || !context.db.areAllied(unit.team, other.team);
        });
    }
    let positions = positionsInRadius(position, extraRange, board);
    const enemyOnly = alternate === 'enemy_blast' ||
      (alternate === 'smart_blast' && item.hasComponent('target_enemy'));
    if (enemyOnly) {
      positions = positions.filter((candidate) => {
        const other = board.getUnit(candidate[0], candidate[1]);
        return !other || !context.db.areAllied(unit.team, other.team);
      });
    }
    return positions;
  }
  return [position];
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

  if (item.hasComponent('steal') || item.hasComponent('gba_steal')) {
    const defender = context.board.getUnit(defPos[0], defPos[1]);
    if (!defender) return false;
    const stealAtk = context.evaluateEquation?.('STEAL_ATK', unit, item) ?? unit.getStatValue('SPD');
    const stealDef = context.evaluateEquation?.('STEAL_DEF', defender, item) ?? defender.getStatValue('SPD');
    if (stealAtk < stealDef) return false;
    if (!defender.items.some((candidate) => stealItemRestrict(unit, item, defender, candidate, context.db))) {
      return false;
    }
  }

  if (item.hasComponent('unload_unit')) {
    if (context.board.getUnit(defPos[0], defPos[1])) return false;
    const defaultClass = context.db.classes.values().next().value;
    const movementGroup = defaultClass?.movement_group ?? 'Infantry';
    if (context.board.getMovementCost(defPos[0], defPos[1], movementGroup, context.db) > 5) return false;
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
  if (item.hasComponent('spell')) return false;
  if (item.hasComponent('cannot_be_countered')) return false;
  return true;
}

/** Can this weapon double? */
export function canDouble(_unit: UnitObject, item: ItemObject): boolean {
  if (item.hasComponent('spell')) return false;
  if (item.hasComponent('cannot_double')) return false;
  return true;
}

// ============================================================
// Formula hooks (UNIQUE)
// ============================================================

export function accuracyFormula(_unit: UnitObject, item: ItemObject): string | undefined {
  return item.getComponent<string>('alternate_accuracy_formula');
}

export function accuracyFormulaOverride(_unit: UnitObject, item: ItemObject): string | undefined {
  return item.getComponent<string>('accuracy_formula_override');
}

export function avoidFormula(_unit: UnitObject, item: ItemObject): string | undefined {
  return item.getComponent<string>('alternate_avoid_formula');
}

export function avoidFormulaOverride(_unit: UnitObject, item: ItemObject): string | undefined {
  return item.getComponent<string>('avoid_formula_override');
}

export function resistFormula(_unit: UnitObject, item: ItemObject): string | undefined {
  return item.getComponent<string>('alternate_resist_formula');
}

export function resistFormulaOverride(_unit: UnitObject, item: ItemObject): string | undefined {
  return item.getComponent<string>('resist_formula_override');
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
