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
import { SkillObject } from '../objects/skill';
import { createItemTree, setItemRangeEvaluator, type ItemObject } from '../objects/item';
import type { GameBoard } from '../objects/game-board';
import type { Database } from '../data/database';
import {
  evaluateCondition,
  evaluateExpression,
  setItemAvailabilityEvaluator,
} from '../events/event-manager';
import type { CombatStrike } from './combat-solver';
import {
  alternateSplash,
  armsthriftRestoration,
  checkAlly,
  checkEnemy,
  empowerSplash,
  inventoryCapacityOffsets,
  movementType,
  skillConditionActive,
  type AlternateSplash,
} from './skill-system';

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
  game?: any,
): TargetPosition[] {
  const targets = new Map<string, TargetPosition>();
  const add = (position: TargetPosition): void => {
    targets.set(`${position[0]},${position[1]}`, position);
  };

  const specificTargetExpression = item.getComponent<string>('target_specific_tile');
  if (specificTargetExpression) {
    try {
      const resolved = evaluateExpression(specificTargetExpression, {
        game,
        unit1: unit,
        item,
        position: unit.position ?? undefined,
        gameVars: game?.gameVars,
        levelVars: game?.levelVars,
      });
      const pending: unknown[] = [resolved];
      while (pending.length > 0) {
        const candidate = pending.pop();
        if (!Array.isArray(candidate)) continue;
        if (candidate.length === 2 &&
            candidate.every((coordinate) => typeof coordinate === 'number' && Number.isFinite(coordinate))) {
          const position: TargetPosition = [candidate[0], candidate[1]];
          if (position[0] >= 0 && position[0] < board.width &&
              position[1] >= 0 && position[1] < board.height) {
            add(position);
          }
        } else {
          pending.push(...candidate);
        }
      }
    } catch (error) {
      console.error(
        `target_specific_tile component failed to evaluate expression ${specificTargetExpression}`,
        error,
      );
    }
  }

  if (item.hasComponent('target_tile')) {
    for (let x = 0; x < board.width; x++) {
      for (let y = 0; y < board.height; y++) add([x, y]);
    }
  }

  if (item.hasComponent('target_tile_unless_ally')) {
    for (let x = 0; x < board.width; x++) {
      for (let y = 0; y < board.height; y++) {
        const occupant = board.getUnit(x, y);
        if (!occupant || !checkAlly(unit, occupant, db)) add([x, y]);
      }
    }
  }

  const targetUnits = item.hasComponent('target_unit');
  const targetEnemies = item.hasComponent('target_enemy');
  const targetAllies = item.hasComponent('target_ally');
  if (targetUnits || targetEnemies || targetAllies) {
    for (const other of board.getAllUnits()) {
      if (!other.position || other.isDead()) continue;
      if (targetUnits ||
          (targetEnemies && checkEnemy(unit, other, db)) ||
          (targetAllies && checkAlly(unit, other, db))) {
        add([other.position[0], other.position[1]]);
      }
    }
  }

  if (item.hasComponent('unlock_staff')) {
    for (const region of game?.currentLevel?.regions ?? []) {
      if (region.region_type !== 'event' ||
          !String(region.condition ?? '').includes('can_unlock')) continue;
      for (let x = region.position[0]; x < region.position[0] + region.size[0]; x++) {
        for (let y = region.position[1]; y < region.position[1] + region.size[1]; y++) {
          add([x, y]);
        }
      }
    }
  }

  if (item.hasComponent('phasewalk') ||
      item.hasComponent('charge') ||
      item.hasComponent('bullrush')) {
    for (const target of rekkaMovementEndpoints(unit, item, board, db, game).keys()) {
      const [x, y] = target.split(',').map(Number);
      add([x, y]);
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
  game?: any;
  evaluateRangeEquation?: (equationNid: string) => number;
}

export interface SplashResult {
  mainTarget: TargetPosition | null;
  splash: TargetPosition[];
}

function componentList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  return value === undefined || value === null ? [] : [String(value)];
}

type RekkaMovementComponent = 'phasewalk' | 'charge' | 'bullrush';

/**
 * Project-local straight-line movement item endpoints.
 *
 * Keys are the adjacent direction-selection tiles exposed as item targets;
 * values are the actual landing tiles. This preserves the custom Python
 * components' unusual target shape and their exact Phasewalk scan vs.
 * Charge/Bullrush fixed-distance behavior.
 */
export function rekkaMovementEndpoints(
  unit: UnitObject,
  item: ItemObject,
  board: GameBoard,
  db: Database,
  game?: any,
): Map<string, TargetPosition> {
  const component: RekkaMovementComponent | null =
    item.hasComponent('phasewalk') ? 'phasewalk' :
      item.hasComponent('charge') ? 'charge' :
        item.hasComponent('bullrush') ? 'bullrush' : null;
  const endpoints = new Map<string, TargetPosition>();
  if (!component || !unit.position) return endpoints;

  const allowedTerrain = new Set(componentList(item.getComponent(component)));
  const defaultMovement = db.classes.get(unit.klass)?.movement_group ?? 'Infantry';
  const movementGroup = movementType(unit, defaultMovement, game);
  const status = ([x, y]: TargetPosition): 0 | 1 | 2 => {
    const traversable = board.getMovementCost(x, y, movementGroup, db) < 99;
    if (traversable) return 0;
    return allowedTerrain.has(String(board.getTerrain(x, y))) ? 1 : 2;
  };
  const distance = component === 'charge'
    ? Math.trunc(unit.getMovement() / 2)
    : unit.getMovement();

  for (const [dx, dy] of [[0, 1], [0, -1], [-1, 0], [1, 0]] as TargetPosition[]) {
    const adjacent: TargetPosition = [unit.position[0] + dx, unit.position[1] + dy];
    if (!board.checkBounds(adjacent[0], adjacent[1])) continue;

    if (component === 'phasewalk') {
      if (status(adjacent) !== 1) continue;
      let current: TargetPosition = [unit.position[0], unit.position[1]];
      while (true) {
        current = [current[0] + dx, current[1] + dy];
        if (!board.checkBounds(current[0], current[1])) break;
        const currentStatus = status(current);
        if (currentStatus === 2) break;
        if (currentStatus === 0) {
          endpoints.set(`${adjacent[0]},${adjacent[1]}`, current);
          break;
        }
      }
      continue;
    }

    if (status(adjacent) !== 0 || distance <= 0) continue;
    const endpoint: TargetPosition = [
      unit.position[0] + dx * distance,
      unit.position[1] + dy * distance,
    ];
    if (!board.checkBounds(endpoint[0], endpoint[1]) || status(endpoint) !== 0) continue;
    endpoints.set(`${adjacent[0]},${adjacent[1]}`, endpoint);
  }
  return endpoints;
}

function cleave2Positions(
  position: TargetPosition,
  board: GameBoard,
): TargetPosition[] {
  const positions: TargetPosition[] = [];
  for (let dx = -2; dx <= 2; dx++) {
    for (let dy = -2; dy <= 2; dy++) {
      if (dx === 0 && dy === 0) continue;
      const candidate: TargetPosition = [position[0] + dx, position[1] + dy];
      if (board.checkBounds(candidate[0], candidate[1])) positions.push(candidate);
    }
  }
  return positions;
}

function availabilitySkillActive(unit: UnitObject, skill: UnitObject['skills'][number], item: ItemObject, game?: any): boolean {
  return skillConditionActive(skill, unit, { game, item });
}

function itemComponentsAvailable(
  unit: UnitObject,
  item: ItemObject,
  components: Map<string, any>,
  db: Database,
  game?: any,
): boolean {
  if ((components.has('uses') || components.has('c_uses')) && item.uses <= 0) return false;
  if (components.has('no_attack_after_move') && unit.hasMoved) return false;
  const hpCost = components.get('hp_cost');
  if (typeof hpCost === 'number' && unit.currentHp <= hpCost) return false;
  const goldCost = components.get('gold_cost');
  if (typeof goldCost === 'number' && Number(game?.getMoney?.() ?? 0) < goldCost) return false;
  if (components.has('cooldown') && Number(item.data.get('cooldown') ?? 0) !== 0) return false;

  const mana = Number((unit as any).currentMana ?? db.getEquation('MANA') ?? 0);
  const manaCost = components.get('mana_cost');
  if (typeof manaCost === 'number' && mana < manaCost) return false;
  const evalManaCost = components.get('eval_mana_cost');
  if (typeof evalManaCost === 'string') {
    const cost = Number(evaluateExpression(evalManaCost, {
      game, unit1: unit, item, position: unit.position ?? undefined,
      gameVars: game?.gameVars, levelVars: game?.levelVars,
    }));
    if (Number.isFinite(cost) && mana < cost) return false;
  }

  const exemptWeaponType = components.get('weapon_type_exempt') as string | undefined;
  const weaponType = (components.get('weapon_type') as string | undefined) ?? exemptWeaponType;
  if (weaponType && !exemptWeaponType) {
    const klass = db.classes.get(unit.klass);
    const classEntry = klass?.wexp_gain?.[weaponType];
    if (!classEntry) return false;
    const usableTypes = new Set(Object.entries(klass.wexp_gain)
      .filter(([, entry]) => entry[0])
      .map(([nid]) => nid));
    for (const skill of unit.skills) {
      if (!skill.hasComponent('wexp_usable_skill') &&
          !skill.hasComponent('wexp_unusable_skill')) continue;
      if (!availabilitySkillActive(unit, skill, item, game)) continue;
      for (const nid of componentList(skill.getComponent('wexp_usable_skill'))) usableTypes.add(nid);
      for (const nid of componentList(skill.getComponent('wexp_unusable_skill'))) usableTypes.delete(nid);
    }
    if (!usableTypes.has(weaponType) || Number(unit.wexp[weaponType] ?? 0) <= 0) return false;
  }

  const magicRank = components.get('magic_weapon_rank') as string | undefined;
  const rank = (components.get('weapon_rank') as string | undefined) ?? magicRank;
  if (rank && weaponType) {
    const requirement = db.weaponRanks.find((candidate) => candidate.rank === rank)?.requirement;
    const magicianBypass = !!magicRank && unit.tags.includes('Magician');
    if (!magicianBypass &&
        requirement !== undefined &&
        Number(unit.wexp[weaponType] ?? 0) < requirement) return false;
  }

  const allowedUnits = components.get('prf_unit');
  if (allowedUnits !== undefined && !componentList(allowedUnits).includes(unit.nid)) return false;
  const allowedClasses = components.get('prf_class');
  if (allowedClasses !== undefined && !componentList(allowedClasses).includes(unit.klass)) return false;
  const allowedTags = components.get('prf_tags');
  if (allowedTags !== undefined && !componentList(allowedTags).some((tag) => unit.tags.includes(tag))) return false;
  const allowedAffinities = components.get('prf_affinity');
  if (allowedAffinities !== undefined && !componentList(allowedAffinities).includes(unit.affinity)) return false;

  const expression = components.get('eval_available') as string | undefined;
  if (expression && !evaluateCondition(expression, {
    game,
    unit1: unit,
    item,
    position: unit.position ?? undefined,
    gameVars: game?.gameVars,
    levelVars: game?.levelVars,
  })) return false;

  return true;
}

/** Python item_system.available(): item and active item-override hooks only. */
export function itemSystemAvailable(
  unit: UnitObject,
  item: ItemObject,
  db: Database,
  game?: any,
): boolean {
  if (!itemComponentsAvailable(unit, item, item.components, db, game)) return false;

  // Active item_override skills append item-prefab components to the child's
  // ordinary hook dispatch. Availability hooks on those prefabs must also pass.
  for (const skill of unit.skills) {
    const overrideNid = skill.getComponent<string>('item_override');
    if (!overrideNid || !availabilitySkillActive(unit, skill, item, game)) continue;
    const override = overrideNid ? db.items.get(overrideNid) : null;
    if (override && !itemComponentsAvailable(
      unit, item, new Map(override.components), db, game,
    )) return false;
  }

  if (item.parentItem && !itemComponentsAvailable(
    unit, item.parentItem, item.parentItem.components, db, game,
  )) return false;

  return true;
}

/**
 * Python item_funcs.available(): both item_system and skill_system availability
 * hooks must pass.
 */
export function available(
  unit: UnitObject,
  item: ItemObject,
  db: Database,
  game?: any,
): boolean {
  if (!itemSystemAvailable(unit, item, db, game)) return false;

  for (const skill of unit.skills) {
    if (!skill.hasComponent('cannot_use_items') &&
        !skill.hasComponent('cannot_use_items_except_armor') &&
        !skill.hasComponent('cannot_use_magic_items')) continue;
    if (!availabilitySkillActive(unit, skill, item, game)) continue;
    if (skill.hasComponent('cannot_use_items')) return false;
    if (skill.hasComponent('cannot_use_items_except_armor') &&
        weaponType(unit, item) !== 'Gear') return false;
    if (skill.hasComponent('cannot_use_magic_items') &&
        (item.hasComponent('magic') || item.hasComponent('magic_at_range'))) return false;
  }

  return true;
}

setItemAvailabilityEvaluator((unit, item, db, game) => {
  const runtimeItem = typeof item?.hasComponent === 'function'
    ? item
    : createItemTree(item, (nid) => db.items.get(nid));
  return itemSystemAvailable(unit, runtimeItem, db, game);
});

setItemRangeEvaluator((kind, unit, item, game) =>
  kind === 'minimum'
    ? minimumRange(unit, item, game)
    : maximumRange(unit, item, game));

/** Python item_system.can_unlock: evaluate this item's region restriction. */
export function canUnlock(
  unit: UnitObject,
  item: ItemObject,
  region: any,
  game?: any,
): boolean {
  const expression = item.getComponent<unknown>('can_unlock');
  if (expression === undefined) return false;
  if (typeof expression !== 'string') return !!expression;
  const trimmed = expression.trim();
  if (trimmed === 'True' || trimmed === 'true') return true;
  if (trimmed === 'False' || trimmed === 'false') return false;

  const startsWith = trimmed.match(
    /^region\.nid\.startswith\(\s*(['"])(.*?)\1\s*\)$/,
  );
  if (startsWith) return String(region?.nid ?? '').startsWith(startsWith[2]);

  try {
    return evaluateCondition(trimmed, {
      game,
      unit1: unit,
      region,
      item,
      position: unit.position ?? undefined,
      gameVars: game?.gameVars,
      levelVars: game?.levelVars,
    });
  } catch (error) {
    console.error(`Could not evaluate can_unlock expression ${trimmed}`, error);
    return false;
  }
}

/** Python menu_after_combat hook. */
export function menuAfterCombat(_unit: UnitObject, item: ItemObject): boolean {
  return item.hasComponent('menu_after_combat') ||
    item.hasComponent('attack_after_combat');
}

/** Python can_attack_after_combat hook. */
export function canAttackAfterCombat(_unit: UnitObject, item: ItemObject): boolean {
  return item.hasComponent('attack_after_combat');
}

/** Python no_attack_after_move hook. */
export function noAttackAfterMove(_unit: UnitObject, item: ItemObject): boolean {
  return item.hasComponent('no_attack_after_move');
}

/** Python Transform/base component marker used by battle presentation. */
export function transforms(_unit: UnitObject, item: ItemObject): boolean {
  return item.hasComponent('transform');
}

/** Equipped-item stat bonus for one stat (Python item_system.stat_change). */
export function statChange(_unit: UnitObject, item: ItemObject, statNid: string): number {
  const changes = item.getComponent<unknown>('stat_change');
  if (!Array.isArray(changes)) return 0;
  let total = 0;
  for (const entry of changes) {
    if (Array.isArray(entry) && entry[0] === statNid && typeof entry[1] === 'number') {
      total += entry[1];
    }
  }
  return total;
}

/** Python Repair.item_restrict: finite-use, damaged, and not explicitly unrepairable. */
export function isRepairableItem(item: ItemObject): boolean {
  return item.maxUses > 0 && item.uses < item.maxUses && !item.hasComponent('unrepairable');
}

/** Match LT's separate accessory/non-accessory inventory capacity. */
export function inventoryCapacity(
  unit: UnitObject,
  accessory: boolean,
  db: Database,
): number {
  const offsets = inventoryCapacityOffsets(unit);
  const base = Number(db.getConstant(accessory ? 'num_accessories' : 'num_items', accessory ? 0 : 5));
  return Math.max(0, base + (accessory ? offsets.accessories : offsets.items));
}

export function inventoryFull(unit: UnitObject, item: ItemObject, db: Database): boolean {
  const accessory = item.isAccessory();
  const limit = inventoryCapacity(unit, accessory, db);
  const count = unit.items.filter((candidate) => candidate.isAccessory() === accessory).length;
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

/** Rekka Trace eligibility for a target inventory item. */
export function traceItemRestrict(
  unit: UnitObject,
  targetItem: ItemObject,
  db: Database,
): boolean {
  const tags = targetItem.getComponent<unknown>('item_tags');
  const itemTags = Array.isArray(tags) ? tags.map(String) : tags ? [String(tags)] : [];
  if (itemTags.includes('NoTrace')) return false;
  if (!targetItem.nid.includes('Fragarach') && targetItem.uses <= 0) return false;
  if (targetItem.isAccessory()) {
    return false;
  }
  if (targetItem.hasComponent('locked') || targetItem.hasComponent('undiscardable')) return false;
  return !inventoryFull(unit, targetItem, db);
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
    if (target === 'enemy') return checkEnemy(unit, other, context.db);
    if (target === 'ally') return checkAlly(unit, other, context.db);
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
  // UnlockStaff explicitly suppresses every other splash/AOE component.
  if (item.hasComponent('unlock_staff')) return { mainTarget: position, splash: [] };

  if (item.hasComponent('cleave_2_range_aoe')) {
    return {
      mainTarget: board.getUnit(position[0], position[1]) ? position : null,
      splash: cleave2Positions(position, board)
        .filter(([x, y]) => !!board.getUnit(x, y)),
    };
  }
  if (item.hasComponent('enemy_big_cleave_aoe') && unit.position) {
    const positions: TargetPosition[] = [];
    for (let dx = -2; dx <= 2; dx++) {
      for (let dy = -2; dy <= 2; dy++) {
        const candidate: TargetPosition = [unit.position[0] + dx, unit.position[1] + dy];
        if (board.inBounds(candidate[0], candidate[1]) &&
            !samePosition(candidate, position)) positions.push(candidate);
      }
    }
    return {
      mainTarget: board.getUnit(position[0], position[1]) ? position : null,
      splash: affectedUnits(positions, unit, context, 'enemy'),
    };
  }
  if (item.hasComponent('all_units_aoe')) {
    return {
      mainTarget: null,
      splash: board.getAllUnits()
        .filter((target) => !!target.position)
        .map((target) => [target.position![0], target.position![1]] as TargetPosition),
    };
  }
  const spell = isSpell(unit, item);
  const extraRange = empowerSplash(unit);
  const blastValue = item.getComponent<number>('blast_aoe')
    ?? item.getComponent<number>('enemy_blast_aoe')
    ?? item.getComponent<number>('ally_blast_aoe')
    ?? item.getComponent<number>('smart_blast_aoe');
  const evaluatedSmartBlast = item.getComponent<string>('eval_smartblast_aoe');
  const evaluatedAllyBlast = item.getComponent<string>('eval_ally_blast_aoe');
  const equationBlast = item.getComponent<string>('equation_blast_aoe')
    ?? item.getComponent<string>('ally_equation_blast_aoe');

  if (blastValue !== undefined || evaluatedSmartBlast || evaluatedAllyBlast || equationBlast) {
    const radius = (evaluatedSmartBlast || evaluatedAllyBlast
      ? Math.max(0, evaluatedItemNumber(
        evaluatedSmartBlast ?? evaluatedAllyBlast, unit, item, context.game,
      ))
      : equationBlast
      ? Math.max(0, context.evaluateRangeEquation?.(equationBlast) ?? 0)
      : Math.max(0, Number(blastValue))) + extraRange;
    const enemyOnly = !!evaluatedSmartBlast || item.hasComponent('enemy_blast_aoe') ||
      (item.hasComponent('smart_blast_aoe') && item.hasComponent('target_enemy'));
    const allyOnly = !!evaluatedAllyBlast ||
      item.hasComponent('ally_blast_aoe') || item.hasComponent('ally_equation_blast_aoe') ||
      (item.hasComponent('smart_blast_aoe') && item.hasComponent('target_ally'));
    const result = resolveBlast(
      unit, item, position, context, radius, enemyOnly ? 'enemy' : allyOnly ? 'ally' : 'all',
    );
    return resultOrAlternate(
      evaluatedAllyBlast ? { mainTarget: null, splash: result.splash } : result,
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
        .filter((target) => target.position && checkAlly(unit, target, context.db) && (!excludeSelf || target !== unit))
        .map((target) => [target.position![0], target.position![1]] as TargetPosition),
    }, unit, item, position, context);
  }

  if (item.hasComponent('all_enemies_aoe')) {
    const affected = board.getAllUnits()
      .filter((target) => target.position && checkEnemy(unit, target, context.db))
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
  if (item.hasComponent('cleave_2_range_aoe')) {
    // The custom Python preview deliberately highlights only empty tiles.
    return cleave2Positions(position, board)
      .filter(([x, y]) => !board.getUnit(x, y));
  }
  if (item.hasComponent('enemy_big_cleave_aoe') && unit.position) {
    const positions: TargetPosition[] = [];
    for (let dx = -2; dx <= 2; dx++) {
      for (let dy = -2; dy <= 2; dy++) {
        const candidate: TargetPosition = [unit.position[0] + dx, unit.position[1] + dy];
        if (!board.inBounds(candidate[0], candidate[1]) ||
            samePosition(candidate, position)) continue;
        const occupant = board.getUnit(candidate[0], candidate[1]);
        if (!occupant || checkEnemy(unit, occupant, context.db)) positions.push(candidate);
      }
    }
    return positions;
  }
  if (item.hasComponent('all_units_aoe')) {
    const positions: TargetPosition[] = [];
    for (let x = 0; x < board.width; x++) {
      for (let y = 0; y < board.height; y++) positions.push([x, y]);
    }
    return positions;
  }
  const extraRange = empowerSplash(unit);
  const blastValue = item.getComponent<number>('blast_aoe')
    ?? item.getComponent<number>('enemy_blast_aoe')
    ?? item.getComponent<number>('ally_blast_aoe')
    ?? item.getComponent<number>('smart_blast_aoe');
  const evaluatedSmartBlast = item.getComponent<string>('eval_smartblast_aoe');
  const evaluatedAllyBlast = item.getComponent<string>('eval_ally_blast_aoe');
  const equationBlast = item.getComponent<string>('equation_blast_aoe')
    ?? item.getComponent<string>('ally_equation_blast_aoe');
  if (blastValue !== undefined || evaluatedSmartBlast || evaluatedAllyBlast || equationBlast) {
    const radius = (evaluatedSmartBlast || evaluatedAllyBlast
      ? Math.max(0, evaluatedItemNumber(
        evaluatedSmartBlast ?? evaluatedAllyBlast, unit, item, context.game,
      ))
      : equationBlast
      ? Math.max(0, context.evaluateRangeEquation?.(equationBlast) ?? 0)
      : Math.max(0, Number(blastValue))) + extraRange;
    let positions = positionsInRadius(position, radius, board);
    const enemyOnly = !!evaluatedSmartBlast || item.hasComponent('enemy_blast_aoe') ||
      (item.hasComponent('smart_blast_aoe') && item.hasComponent('target_enemy'));
    if (enemyOnly) {
      positions = positions.filter((candidate) => {
        const other = board.getUnit(candidate[0], candidate[1]);
        return !other || checkEnemy(unit, other, context.db);
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
        return !other || checkEnemy(unit, other, context.db);
      });
    if (positions.length > 0) return positions;
  }
  if ((item.hasComponent('line_aoe') || item.hasComponent('enemy_line_aoe')) && unit.position) {
    let positions = raytrace(unit.position, position).filter((candidate) => !samePosition(candidate, unit.position!));
    if (item.hasComponent('enemy_line_aoe')) {
      positions = positions.filter((candidate) => {
        const other = board.getUnit(candidate[0], candidate[1]);
        return !other || checkEnemy(unit, other, context.db);
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
        if (!other || checkEnemy(unit, other, context.db)) positions.push([x, y]);
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
          return !other || checkEnemy(unit, other, context.db);
        });
    }
    let positions = positionsInRadius(position, extraRange, board);
    const enemyOnly = alternate === 'enemy_blast' ||
      (alternate === 'smart_blast' && item.hasComponent('target_enemy'));
    if (enemyOnly) {
      positions = positions.filter((candidate) => {
        const other = board.getUnit(candidate[0], candidate[1]);
        return !other || checkEnemy(unit, other, context.db);
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
  const baseLoss = oneLossPerCombat(unit, item) ? (qualifying.length > 0 ? 1 : 0) : qualifying.length;
  const persistentRestoration = armsthriftRestoration(unit, item);
  const restored = qualifying.reduce((total, strike) => {
    const procRestoration = item.hasComponent('unrepairable')
      ? 0
      : (strike.attackProcs ?? []).reduce((sum, mark) => {
          const value = mark.procSkill.getComponent<number>('armsthrift');
          return sum + (typeof value === 'number' ? Math.max(0, value - 1) : 0);
        }, 0);
    return total + persistentRestoration + procRestoration;
  }, 0);
  return Math.max(0, baseLoss - restored);
}

function movementGroup(unit: UnitObject, db: Database): string {
  return movementType(unit, db.classes.get(unit.klass)?.movement_group ?? 'Infantry');
}

export function shoveDestination(
  target: UnitObject,
  anchor: TargetPosition,
  magnitude: number,
  context: TargetRestrictionContext,
): TargetPosition | null {
  if (!target.position || magnitude <= 0) return null;
  const dx = target.position[0] - anchor[0];
  const dy = target.position[1] - anchor[1];
  if (dx === 0 && dy === 0) return null;
  const step: TargetPosition = Math.abs(dx) >= Math.abs(dy)
    ? [dx > 0 ? 1 : -1, 0]
    : [0, dy > 0 ? 1 : -1];
  let destination: TargetPosition = [target.position[0], target.position[1]];
  for (let index = 1; index <= magnitude; index++) {
    const candidate: TargetPosition = [
      target.position[0] + step[0] * index,
      target.position[1] + step[1] * index,
    ];
    if (!context.board.inBounds(candidate[0], candidate[1])) return null;
    const occupant = context.board.getUnit(candidate[0], candidate[1]);
    if (occupant && occupant !== target) return null;
    if (context.board.getMovementCost(
      candidate[0], candidate[1], movementGroup(target, context.db), context.db,
    ) >= 99) return null;
    destination = candidate;
  }
  return destination;
}

export function pivotDestination(
  unit: UnitObject,
  anchor: TargetPosition,
  magnitude: number,
  context: TargetRestrictionContext,
): TargetPosition | null {
  if (!unit.position || magnitude <= 0) return null;
  const dx = Math.max(-1, Math.min(1, unit.position[0] - anchor[0]));
  const dy = Math.max(-1, Math.min(1, unit.position[1] - anchor[1]));
  const destination: TargetPosition = [anchor[0] - dx * magnitude, anchor[1] - dy * magnitude];
  if (!context.board.inBounds(destination[0], destination[1]) ||
      context.board.getUnit(destination[0], destination[1])) return null;
  const cost = context.board.getMovementCost(
    destination[0], destination[1], movementGroup(unit, context.db), context.db,
  );
  return cost <= unit.getMovement() ? destination : null;
}

export function drawBackDestinations(
  unit: UnitObject,
  target: UnitObject,
  magnitude: number,
  context: TargetRestrictionContext,
): [TargetPosition, TargetPosition] | null {
  if (!unit.position || !target.position || magnitude <= 0) return null;
  const dx = Math.max(-1, Math.min(1, target.position[0] - unit.position[0]));
  const dy = Math.max(-1, Math.min(1, target.position[1] - unit.position[1]));
  const unitDestination: TargetPosition = [
    unit.position[0] - dx * magnitude,
    unit.position[1] - dy * magnitude,
  ];
  const targetDestination: TargetPosition = [
    target.position[0] - dx * magnitude,
    target.position[1] - dy * magnitude,
  ];
  if (!context.board.inBounds(unitDestination[0], unitDestination[1]) ||
      !context.board.inBounds(targetDestination[0], targetDestination[1]) ||
      context.board.getUnit(unitDestination[0], unitDestination[1])) return null;
  const unitCost = context.board.getMovementCost(
    unitDestination[0], unitDestination[1], movementGroup(unit, context.db), context.db,
  );
  const targetCost = context.board.getMovementCost(
    targetDestination[0], targetDestination[1], movementGroup(target, context.db), context.db,
  );
  return unitCost <= unit.getMovement() && targetCost <= target.getMovement()
    ? [unitDestination, targetDestination]
    : null;
}

/** Rekka custom `advance`: move user and target forward along both axes. */
export function advanceDestinations(
  unit: UnitObject,
  target: UnitObject,
  magnitude: number,
  context: TargetRestrictionContext,
): [TargetPosition, TargetPosition] | null {
  if (!unit.position || !target.position || magnitude <= 0) return null;
  const dx = Math.max(-1, Math.min(1, target.position[0] - unit.position[0]));
  const dy = Math.max(-1, Math.min(1, target.position[1] - unit.position[1]));
  const unitDestination: TargetPosition = [
    unit.position[0] + dx * magnitude,
    unit.position[1] + dy * magnitude,
  ];
  const targetDestination: TargetPosition = [
    target.position[0] + dx * magnitude,
    target.position[1] + dy * magnitude,
  ];
  if (!context.board.checkBounds(targetDestination[0], targetDestination[1]) ||
      context.board.getUnit(targetDestination[0], targetDestination[1])) return null;
  const unitCost = context.board.getMovementCost(
    unitDestination[0], unitDestination[1], movementGroup(unit, context.db), context.db,
  );
  const targetCost = context.board.getMovementCost(
    targetDestination[0], targetDestination[1], movementGroup(target, context.db), context.db,
  );
  return unitCost <= unit.getMovement() && targetCost <= target.getMovement()
    ? [unitDestination, targetDestination]
    : null;
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

  if ((item.hasComponent('eval_damage') || item.hasComponent('eval_extra_damage')) &&
      !affectedUnits.some((target) => checkEnemy(unit, target, context.db))) {
    return false;
  }

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

  if (item.hasComponent('promote')) {
    const defender = context.board.getUnit(defPos[0], defPos[1]);
    if (!defender) return false;
    const klass = context.db.classes.get(defender.klass);
    if (!klass || !klass.turns_into || klass.turns_into.length === 0) return false;
  }

  if (item.hasComponent('force_promote')) {
    const defender = context.board.getUnit(defPos[0], defPos[1]);
    if (!defender) return false;
  }

  if (item.hasComponent('class_change')) {
    const defender = context.board.getUnit(defPos[0], defPos[1]);
    const prefab = defender ? context.db.units.get(defender.nid) as any : null;
    if (!defender || defender.generic ||
        !Array.isArray(prefab?.alternate_classes) ||
        prefab.alternate_classes.length === 0) return false;
  }

  if (item.hasComponent('permanent_stat_change')) {
    const changes = item.getNumericComponentMap('permanent_stat_change');
    const canApply = affectedUnits.some((target) => Object.entries(changes).some(([stat, amount]) =>
      amount <= 0 || target.getStatValue(stat) < target.getStatCap(stat),
    ));
    if (!canApply) return false;
  }

  if (item.hasComponent('unlock_staff')) {
    const validRegion = (context.game?.currentLevel?.regions ?? []).some((region: any) =>
      region.region_type === 'event' &&
      String(region.condition ?? '').includes('can_unlock') &&
      defPos[0] >= region.position[0] && defPos[0] < region.position[0] + region.size[0] &&
      defPos[1] >= region.position[1] && defPos[1] < region.position[1] + region.size[1],
    );
    if (!validRegion) return false;
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

  if (item.hasComponent('trace')) {
    const defender = context.board.getUnit(defPos[0], defPos[1]);
    if (!defender ||
        !defender.items.some((candidate) => traceItemRestrict(unit, candidate, context.db))) {
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
    const movementGroup = movementType(
      unit,
      context.db.classes.get(unit.klass)?.movement_group ?? 'Infantry',
      context.game,
    );
    const movementCost = context.board.getMovementCost(defPos[0], defPos[1], movementGroup, context.db);
    if (movementCost > unit.getMovement()) return false;
  }

  if (item.hasComponent('shove_target_restrict')) {
    const magnitude = Number(item.getComponent<number>('shove_target_restrict') ?? 1);
    const canShove = affectedUnits.some((target) =>
      !target.skills.some((skill) => skill.hasComponent('ignore_forced_movement')) &&
      !!unit.position && !!shoveDestination(target, unit.position, magnitude, context));
    if (!canShove) return false;
  }

  if (item.hasComponent('pivot_target_restrict')) {
    const magnitude = Number(item.getComponent<number>('pivot_target_restrict') ?? 1);
    const canPivot = affectedUnits.some((target) =>
      !unit.skills.some((skill) => skill.hasComponent('ignore_forced_movement')) &&
      !!target.position && !!pivotDestination(unit, target.position, magnitude, context));
    if (!canPivot) return false;
  }

  if (item.hasComponent('draw_back_target_restrict')) {
    const magnitude = Number(item.getComponent<number>('draw_back_target_restrict') ?? 1);
    const canDrawBack = affectedUnits.some((target) =>
      !target.skills.some((skill) => skill.hasComponent('ignore_forced_movement')) &&
      !!drawBackDestinations(unit, target, magnitude, context));
    if (!canDrawBack) return false;
  }

  if (item.hasComponent('advance_target_restrict')) {
    const magnitude = Number(item.getComponent<number>('advance_target_restrict') ?? 1);
    const canAdvance = affectedUnits.some((target) =>
      !target.skills.some((skill) => skill.hasComponent('ignore_forced_movement')) &&
      !!advanceDestinations(unit, target, magnitude, context));
    if (!canAdvance) return false;
  }

  if (item.hasComponent('phasewalk') ||
      item.hasComponent('charge') ||
      item.hasComponent('bullrush')) {
    const endpoints = rekkaMovementEndpoints(unit, item, context.board, context.db, context.game);
    if (!endpoints.has(`${defPos[0]},${defPos[1]}`)) return false;
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
// Value hooks (UNIQUE — the last defining component wins)
// ============================================================

/**
 * Resolve the built-in Value component through Python's UNIQUE hook order.
 *
 * Ordinary item components come first. Active item_override skills are then
 * considered from the end of the unit's skill list, with the first override
 * defining `value` winning. This is equivalent to Python's reverse scan plus
 * component-NID deduplication before `utils.unique(values)` selects the last
 * defining component.
 */
function resolvePriceValue(
  unit: UnitObject | null,
  item: ItemObject,
  db: Database,
  game?: unknown,
): number | null {
  if (unit) {
    for (let index = unit.skills.length - 1; index >= 0; index--) {
      const skill = unit.skills[index];
      const overrideNid = skill.getComponent<string>('item_override');
      if (!overrideNid || !skillCondition(skill, unit, game)) continue;
      const override = db.items.get(overrideNid);
      if (!override) continue;
      const overrideValue = override.components.find(([nid]) => nid === 'value')?.[1];
      if (overrideValue !== undefined) return Number(overrideValue);
    }
  }

  const value = item.getComponent<number>('value');
  return value === undefined ? null : Number(value);
}

/** Python item_system.full_price: unscaled Value component, or None. */
export function fullPrice(
  unit: UnitObject | null,
  item: ItemObject,
  db: Database,
  game?: unknown,
): number | null {
  return resolvePriceValue(unit, item, db, game);
}

/** Python item_system.buy_price: Value scaled by ordinary remaining uses. */
export function buyPrice(
  unit: UnitObject | null,
  item: ItemObject,
  db: Database,
  game?: unknown,
): number | null {
  const value = resolvePriceValue(unit, item, db, game);
  if (value === null) return null;
  if (item.uses) {
    return value * item.uses / Number(item.data.get('starting_uses'));
  }
  return value;
}

/** Python item_system.sell_price: buy scaling followed by sell_modifier. */
export function sellPrice(
  unit: UnitObject | null,
  item: ItemObject,
  db: Database,
  game?: unknown,
): number | null {
  const value = buyPrice(unit, item, db, game);
  return value === null ? null : value * Number(db.getConstant('sell_modifier', 0.5));
}

/** Get the weapon type NID, or undefined. */
export function weaponType(_unit: UnitObject, item: ItemObject): string | undefined {
  return item.getComponent<string>('weapon_type') ??
    item.getComponent<string>('weapon_type_exempt');
}

function evaluatedItemNumber(
  expression: unknown,
  unit: UnitObject,
  item: ItemObject,
  game?: any,
  fallback = 0,
): number {
  if (typeof expression === 'number') return Math.trunc(expression);
  if (typeof expression !== 'string') return fallback;
  const value = Number(evaluateExpression(expression, {
    game,
    unit1: unit,
    item,
    position: unit.position ?? undefined,
    gameVars: game?.gameVars,
    levelVars: game?.levelVars,
  }));
  return Number.isFinite(value) ? Math.trunc(value) : fallback;
}

function evaluatedItemCondition(
  component: string,
  unit: UnitObject,
  item: ItemObject,
  game?: any,
): boolean {
  const expression = item.getComponent<unknown>(component);
  return typeof expression === 'string' && evaluateCondition(expression, {
    game,
    unit1: unit,
    item,
    position: unit.position ?? undefined,
    gameVars: game?.gameVars,
    levelVars: game?.levelVars,
  });
}

/** Get base damage value from the weapon, including EotF evaluated hooks. */
export function damage(unit: UnitObject, item: ItemObject, game?: any): number | null {
  if (item.hasComponent('eval_damage')) {
    return evaluatedItemNumber(item.getComponent('eval_damage'), unit, item, game);
  }
  if (item.hasComponent('eval_damage_any')) {
    return evaluatedItemNumber(item.getComponent('eval_damage_any'), unit, item, game);
  }
  return item.getComponent<number>('damage') ??
    item.getComponent<number>('damage_any') ??
    null;
}

/** Get base hit value from the weapon, including EotF evaluated hooks. */
export function hit(unit: UnitObject, item: ItemObject, game?: any): number | null {
  if (item.hasComponent('eval_hit')) {
    return evaluatedItemNumber(item.getComponent('eval_hit'), unit, item, game, 80);
  }
  return item.getComponent<number>('hit') ?? null;
}

/** EotF's separate non-critical damage instance. */
export function extraDamage(unit: UnitObject, item: ItemObject, game?: any): number {
  return evaluatedItemNumber(item.getComponent('eval_extra_damage'), unit, item, game);
}

/** Get base crit value from the weapon. */
export function crit(_unit: UnitObject, item: ItemObject): number | null {
  return item.getComponent<number>('crit') ?? null;
}

/** Get the minimum range. */
export function minimumRange(unit: UnitObject, item: ItemObject, game?: any): number {
  if (item.hasComponent('eval_min_range')) {
    return evaluatedItemNumber(item.getComponent('eval_min_range'), unit, item, game);
  }
  return item.getComponent<number>('min_range') ?? 0;
}

/** Get the maximum range. */
export function maximumRange(unit: UnitObject, item: ItemObject, game?: any): number {
  if (item.hasComponent('eval_max_range')) {
    return evaluatedItemNumber(item.getComponent('eval_max_range'), unit, item, game);
  }
  return item.getComponent<number>('max_range') ?? 0;
}

/** Get the weapon rank requirement. */
export function weaponRank(_unit: UnitObject, item: ItemObject): string | undefined {
  return item.getComponent<string>('weapon_rank') ??
    item.getComponent<string>('magic_weapon_rank');
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
  // Python NoDouble item component (nid 'no_double') prevents doubling.
  if (item.hasComponent('no_double')) return false;
  if (item.hasComponent('cannot_double')) return false;
  return true;
}

// ============================================================
// Formula hooks (UNIQUE)
// ============================================================

export function damageFormula(unit: UnitObject, item: ItemObject, game?: any): string | undefined {
  if (item.hasComponent('eval_magic')) {
    return evaluatedItemCondition('eval_magic', unit, item, game) ? 'MAGIC_DAMAGE' : 'DAMAGE';
  }
  if (item.hasComponent('eval_dragon')) {
    return evaluatedItemCondition('eval_dragon', unit, item, game) ? 'MAGIC_DAMAGE' : 'DAMAGE';
  }
  if (item.hasComponent('eval_dragon_magic')) return 'MAGIC_DAMAGE';
  return item.getComponent<string>('alternate_damage_formula');
}

export function damageFormulaOverride(_unit: UnitObject, item: ItemObject): string | undefined {
  return item.getComponent<string>('damage_formula_override');
}

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

export function resistFormula(unit: UnitObject, item: ItemObject, game?: any): string | undefined {
  if (item.hasComponent('eval_magic')) {
    return evaluatedItemCondition('eval_magic', unit, item, game) ? 'MAGIC_DEFENSE' : 'DEFENSE';
  }
  if (item.hasComponent('eval_dragon')) {
    return evaluatedItemCondition('eval_dragon', unit, item, game) ? 'WORSE_DEFENSE' : 'DEFENSE';
  }
  if (item.hasComponent('eval_dragon_magic')) {
    return evaluatedItemCondition('eval_dragon_magic', unit, item, game)
      ? 'WORSE_DEFENSE'
      : 'MAGIC_DEFENSE';
  }
  return item.getComponent<string>('alternate_resist_formula');
}

export function resistFormulaOverride(_unit: UnitObject, item: ItemObject): string | undefined {
  return item.getComponent<string>('resist_formula_override');
}

export function critAccuracyFormula(_unit: UnitObject, item: ItemObject): string | undefined {
  return item.getComponent<string>('alternate_crit_accuracy_formula');
}

export function critAccuracyFormulaOverride(_unit: UnitObject, item: ItemObject): string | undefined {
  return item.getComponent<string>('crit_accuracy_formula_override');
}

export function critAvoidFormula(_unit: UnitObject, item: ItemObject): string | undefined {
  return item.getComponent<string>('alternate_crit_avoid_formula');
}

export function critAvoidFormulaOverride(_unit: UnitObject, item: ItemObject): string | undefined {
  return item.getComponent<string>('crit_avoid_formula_override');
}

export function attackSpeedFormula(_unit: UnitObject, item: ItemObject): string | undefined {
  return item.getComponent<string>('alternate_attack_speed_formula');
}

export function attackSpeedFormulaOverride(_unit: UnitObject, item: ItemObject): string | undefined {
  return item.getComponent<string>('attack_speed_formula_override');
}

export function defenseSpeedFormula(_unit: UnitObject, item: ItemObject): string | undefined {
  return item.getComponent<string>('alternate_defense_speed_formula');
}

export function defenseSpeedFormulaOverride(_unit: UnitObject, item: ItemObject): string | undefined {
  return item.getComponent<string>('defense_speed_formula_override');
}

/** Does this item ignore weapon advantage? */
export function ignoreWeaponAdvantage(_unit: UnitObject, item: ItemObject): boolean {
  return item.hasComponent('ignore_weapon_advantage');
}

export function weaponTriangleOverride(_unit: UnitObject, item: ItemObject): string | null {
  return item.getComponent<string>('weapon_triangle_override') ?? null;
}

/** Python's NUMERIC_MULTIPLY item hook, with a default multiplier of one. */
export function modifyWeaponTriangle(_unit: UnitObject, item: ItemObject): number {
  let result = 1;
  if (item.hasComponent('reaver')) result *= -2;
  if (item.hasComponent('double_triangle')) result *= 2;
  const custom = item.getComponent<number>('custom_triangle_multiplier');
  if (typeof custom === 'number') result *= custom;
  return result;
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
export function modifyAvoid(unit: UnitObject, item: ItemObject, game?: any): number {
  let total = 0;
  const mod = item.getComponent<number>('modify_avoid');
  if (typeof mod === 'number') total += mod;
  if (item.hasComponent('eval_weight')) {
    const weight = evaluatedItemNumber(item.getComponent('eval_weight'), unit, item, game);
    total -= 2 * Math.max(0, weight - unit.getStatValue('CON'));
  }
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
export function modifyAttackSpeed(unit: UnitObject, item: ItemObject, game?: any): number {
  let total = 0;
  const mod = item.getComponent<number>('modify_attack_speed');
  if (typeof mod === 'number') total += mod;
  if (item.hasComponent('eval_weight')) {
    const weight = evaluatedItemNumber(item.getComponent('eval_weight'), unit, item, game);
    total -= Math.max(0, weight - unit.getStatValue('CON'));
  }
  return total;
}

/** Defense-speed counterpart of EotF's evaluated weight hook. */
export function modifyDefenseSpeed(unit: UnitObject, item: ItemObject, game?: any): number {
  if (!item.hasComponent('eval_weight')) return 0;
  const weight = evaluatedItemNumber(item.getComponent('eval_weight'), unit, item, game);
  return -Math.max(0, weight - unit.getStatValue('CON'));
}

// ============================================================
// Dynamic modifier hooks (NUMERIC_ACCUM with combat context)
// ============================================================

/**
 * Dynamic damage modifier — effective damage, situational bonuses, etc.
 * Called during combat with full attacker/defender context.
 *
 * `db` and `game` are required to resolve the target's class tags and any
 * skill `condition` expressions for the negate check. `advantageDamage` is
 * the attacker-only weapon-triangle damage contribution (Python
 * `combat_calcs.compute_advantage_attr(unit, target, item, item2, 'damage')`),
 * supplied by the caller to avoid a circular import with combat-calcs; it is
 * folded into the effective might only when `weapon_effectiveness_multiplied`
 * is true (matching Python `EffectiveDamage.dynamic_damage`).
 */
export function dynamicDamage(
  unit: UnitObject,
  item: ItemObject,
  target: UnitObject,
  _item2: ItemObject | null,
  _mode: string,
  _attackInfo: any,
  _baseValue: number,
  db?: Database,
  game?: any,
  advantageDamage?: number,
): number {
  let total = 0;

  // Canonical effective_damage component (dict form).
  const eff = item.getComponent<EffectiveDamageValue>('effective_damage');
  if (eff) {
    total += effectiveDamageContribution(
      unit, item, target, eff, db, game, advantageDamage ?? 0,
    );
  }

  // Deprecated effective_tag + effective / effective_multiplier path.
  // Python `EffectiveTag.dynamic_damage`: tags come from `effective_tag`,
  // the bonus from `effective_multiplier` (multiplier on might) or a flat
  // `effective` integer. Negation mirrors the deprecated `_check_negate`,
  // which does NOT consult `skill_system.condition`.
  const depTags = item.getComponent<string[]>('effective_tag');
  if (Array.isArray(depTags) && depTags.length > 0) {
    if (isEffectiveAgainstTags(target, depTags, db) &&
        !checkEffectiveNegate(target, depTags, game, false)) {
      const mult = item.getComponent<number>('effective_multiplier');
      if (typeof mult === 'number') {
        const might = Number(damage(unit, item) ?? 0);
        total += Math.trunc((mult - 1) * might);
      } else {
        total += Number(item.getComponent<number>('effective') ?? 0);
      }
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
 * Canonical `effective_damage` contribution. Mirrors Python
 * `EffectiveDamage.dynamic_damage`: might = item damage component; when
 * `weapon_effectiveness_multiplied` (default true), the attacker's
 * weapon-triangle damage advantage is added to might; the bonus is
 * `int((multiplier - 1) * might + effective_bonus_damage)`.
 */
function effectiveDamageContribution(
  unit: UnitObject,
  item: ItemObject,
  target: UnitObject,
  eff: EffectiveDamageValue,
  db: Database | undefined,
  game: any,
  advantageDamage: number,
): number {
  const tags: string[] = Array.isArray(eff.effective_tags) ? eff.effective_tags : [];
  if (!isEffectiveAgainstTags(target, tags, db)) return 0;
  if (checkEffectiveNegate(target, tags, game, true)) return 0;
  const multiplier = Number(eff.effective_multiplier ?? 3);
  const bonusDamage = Number(eff.effective_bonus_damage ?? 0);
  const weaponMultiplied = eff.weapon_effectiveness_multiplied !== false; // default true
  let might = Number(damage(unit, item) ?? 0);
  if (weaponMultiplied) might += advantageDamage;
  return Math.trunc((multiplier - 1) * might + bonusDamage);
}

/**
 * Shape of the canonical `effective_damage` item component value, as stored
 * in the default project (e.g. Armorslayer, Hammer, Rapier, ballistae).
 * Defaults: effective_multiplier 3, effective_bonus_damage 0,
 * show_effectiveness_flash true, weapon_effectiveness_multiplied true.
 */
interface EffectiveDamageValue {
  effective_tags?: string[];
  effective_multiplier?: number;
  effective_bonus_damage?: number;
  show_effectiveness_flash?: boolean;
  weapon_effectiveness_multiplied?: boolean;
}

/**
 * Tags used for effectiveness checks: the unit's own tags, its class tags
 * (from the db Klass def), and tags granted by skills with a `has_tags`
 * component. Mirrors Python `UnitObject.tags`, which unions
 * `self._tags | class.tags | skill_system.additional_tags(self)`.
 */
export function effectivenessTargetTags(target: UnitObject, db?: Database): Set<string> {
  const tags = new Set<string>(target.tags ?? []);
  if (db) {
    const klass = db.classes.get(target.klass);
    if (klass?.tags) for (const t of klass.tags) tags.add(t);
  }
  for (const skill of target.skills) {
    const has = skill.getComponent<string[]>('has_tags');
    if (Array.isArray(has)) for (const t of has) tags.add(t);
  }
  return tags;
}

/** Any effective tag present on the target's effective tag set. */
function isEffectiveAgainstTags(
  target: UnitObject,
  effectiveTags: string[],
  db?: Database,
): boolean {
  if (effectiveTags.length === 0) return false;
  const targetTags = effectivenessTargetTags(target, db);
  return effectiveTags.some((t) => targetTags.has(t));
}

/**
 * Python `skill_system.condition(skill, unit)`: every component defining a
 * `condition` must pass. The web stores at most one `condition` component
 * per skill (Map-keyed), so we evaluate that single expression when present
 * against the unit's equipped weapon, matching Python's fallback
 * (`item = unit.equipped_weapon`).
 */
export function skillCondition(skill: SkillObject, unit: UnitObject, game?: any): boolean {
  return skillConditionActive(skill, unit, { game });
}

/**
 * Python `EffectiveDamage._check_negate` (canonical) and
 * `EffectiveIcon._check_negate` (deprecated). When `useCondition` is true
 * (canonical path), the negate skill must itself be active via
 * `skill_system.condition`; the deprecated path skips that check, matching
 * Python. Negation fires on any `negate` component or a `negate_tags`
 * component whose tag list intersects the item's effective tags.
 */
function checkEffectiveNegate(
  target: UnitObject,
  effectiveTags: string[],
  game: any,
  useCondition: boolean,
): boolean {
  for (const skill of target.skills) {
    if (useCondition && !skillCondition(skill, target, game)) continue;
    if (skill.hasComponent('negate')) return true;
    const negateTags = skill.getComponent<string[]>('negate_tags');
    if (Array.isArray(negateTags) &&
        negateTags.some((t) => effectiveTags.includes(t))) {
      return true;
    }
  }
  return false;
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
  mode: string,
  _attackInfo: unknown,
  _baseValue: number,
): number {
  if (item.hasComponent('brave')) return 1;
  if (item.hasComponent('brave_on_attack') && mode === 'attack') return 1;
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

// ============================================================
// Equip lifecycle hooks (status_on_equip / multi_status_on_equip)
// ============================================================

/** Source-tag keys stored on a skill granted by an equipped item. */
export const ITEM_SOURCE_KEY = 'itemSource';
export const ITEM_SOURCE_TYPE_KEY = 'itemSourceType';
export const ITEM_SOURCE_NID_KEY = 'itemSourceNid';

/** True when `skill` was granted by an item's status_on_equip hook. */
export function isItemSourcedSkill(skill: SkillObject): boolean {
  return skill.data.get(ITEM_SOURCE_TYPE_KEY) === 'item';
}

/**
 * Fire on_equip_item / on_unequip_item component hooks for `item`.
 * `equip=true` adds sourced skills; `equip=false` removes one sourced instance.
 * Mirrors Python StatusOnEquip / MultiStatusOnEquip.
 */
export function dispatchEquipHooks(
  unit: UnitObject,
  item: ItemObject,
  equip: boolean,
  db: Database | undefined,
): void {
  const skillNids = collectStatusOnEquipNids(item);
  for (const skillNid of skillNids) {
    if (equip) addItemSourcedSkill(unit, item, skillNid, db);
    else removeOneItemSourcedSkill(unit, item, skillNid);
  }
}


/** Collect every status_on_equip / multi_status_on_equip NID from the item tree. */
function collectStatusOnEquipNids(item: ItemObject): string[] {
  const nids: string[] = [];
  const single = item.getComponent<string>('status_on_equip');
  if (single) nids.push(single);
  const multi = item.getComponent<string[]>('multi_status_on_equip');
  if (Array.isArray(multi)) nids.push(...multi);
  // multi_item children contribute their own equip statuses.
  for (const sub of item.subitems) nids.push(...collectStatusOnEquipNids(sub));
  return nids;
}

/** Add a sourced skill instance, leaving any natural same-NID skill untouched. */
function addItemSourcedSkill(
  unit: UnitObject,
  item: ItemObject,
  skillNid: string,
  db: Database | undefined,
): void {
  const prefab = db?.skills?.get?.(skillNid);
  if (!prefab) return;
  const skill = new SkillObject(prefab);
  skill.data.set(ITEM_SOURCE_KEY, item);
  skill.data.set(ITEM_SOURCE_TYPE_KEY, 'item');
  skill.data.set(ITEM_SOURCE_NID_KEY, item.nid);
  unit.skills.push(skill);
  if (skill.hasComponent('canto')) unit.hasCanto = true;
}

/** Remove exactly one item-sourced instance of `skillNid` for `item`. */
function removeOneItemSourcedSkill(unit: UnitObject, item: ItemObject, skillNid: string): void {
  for (let i = unit.skills.length - 1; i >= 0; i--) {
    const skill = unit.skills[i];
    if (skill.nid === skillNid &&
        skill.data.get(ITEM_SOURCE_TYPE_KEY) === 'item' &&
        skill.data.get(ITEM_SOURCE_KEY) === item) {
      unit.skills.splice(i, 1);
      break;
    }
  }
  unit.hasCanto = unit.skills.some((s) => s.hasComponent('canto'));
}

/** Remove every item-sourced skill for `item` (used on save-load re-derivation). */
export function removeAllItemSourcedSkills(unit: UnitObject): void {
  unit.skills = unit.skills.filter((skill) => !isItemSourcedSkill(skill));
  unit.hasCanto = unit.skills.some((s) => s.hasComponent('canto'));
}


// ============================================================
// Inventory lifecycle hooks (status_on_hold / multi_status_on_hold)
// ============================================================

/**
 * Fire on_add_item / on_remove_item component hooks for `item`.
 * `add=true` adds sourced skills; `add=false` removes one sourced instance.
 * Mirrors Python StatusOnHold / MultiStatusOnHold.
 *
 * Unlike status_on_equip, these fire when the item enters or leaves the
 * unit's INVENTORY, regardless of equip state.
 */
export function dispatchHoldHooks(
  unit: UnitObject,
  item: ItemObject,
  add: boolean,
  db: Database | undefined,
): void {
  const skillNids = collectStatusOnHoldNids(item);
  for (const skillNid of skillNids) {
    if (add) addItemSourcedSkill(unit, item, skillNid, db);
    else removeOneItemSourcedSkill(unit, item, skillNid);
  }
}

/** Collect every status_on_hold / multi_status_on_hold NID from the item tree. */
function collectStatusOnHoldNids(item: ItemObject): string[] {
  const nids: string[] = [];
  const single = item.getComponent<string>('status_on_hold');
  if (single) nids.push(single);
  const multi = item.getComponent<string[]>('multi_status_on_hold');
  if (Array.isArray(multi)) nids.push(...multi);
  // multi_item children contribute their own hold statuses.
  for (const sub of item.subitems) nids.push(...collectStatusOnHoldNids(sub));
  return nids;
}

// ============================================================
// Combat component hooks: eclipse (on_hit) and lifelink (after_strike)
// ============================================================

/**
 * Eclipse on_hit: target loses floor(currentHp/2). Returns the damage to
 * apply (and 0 triggers a No Damage marker). Python `Eclipse.on_hit`.
 */
export function eclipseDamage(currentHp: number): number {
  return Math.floor(currentHp / 2);
}

/** Eclipse FE7 on_hit reduces the target to exactly 1 HP. */
export function eclipseFe7Damage(currentHp: number): number {
  return Math.max(0, currentHp - 1);
}

/** Whether `item` (or its subitem tree) carries an eclipse_fe7 component. */
export function hasEclipseFe7(item: ItemObject): boolean {
  if (item.hasComponent('eclipse_fe7')) return true;
  return item.subitems.some((subitem) => hasEclipseFe7(subitem));
}

/** Whether `item` (or its subitem tree) carries a damage_on_miss component. */
export function hasDamageOnMiss(item: ItemObject): boolean {
  if (item.hasComponent('damage_on_miss')) return true;
  return item.subitems.some((subitem) => hasDamageOnMiss(subitem));
}

/** Damage dealt by damage_on_miss, or null when the item tree lacks the hook. */
export function damageOnMiss(item: ItemObject, normalDamage: number): number | null {
  const multiplier = item.getComponent<number>('damage_on_miss');
  if (typeof multiplier === 'number') return Math.trunc(normalDamage * multiplier);
  for (const subitem of item.subitems) {
    const damage = damageOnMiss(subitem, normalDamage);
    if (damage !== null) return damage;
  }
  return null;
}

/** Whether `item` (or its subitem tree) carries an eclipse component. */
export function hasEclipse(item: ItemObject): boolean {
  if (item.hasComponent('eclipse')) return true;
  return item.subitems.some((sub) => hasEclipse(sub));
}

/**
 * Lifelink after_strike: heal for a single hitting strike, clamping that
 * strike's damage to the defender's remaining HP at strike time so overkill
 * damage never heals. Returns floor(clamped * value), or 0 when the item
 * tree has no lifelink component or the strike is not a hitting strike by
 * `striker` with `item` (or one of its subitems).
 *
 * Mirrors Python `Lifelink.after_strike`, which clamps the per-strike total
 * damage to `target.get_hp()` (the target's current HP at strike time, before
 * the queued ChangeHP action applies) before multiplying by the lifelink
 * fraction. Apply inside the HP-walk loop and cap the striker's HP at max.
 */
export function lifelinkHealForStrike(
  striker: UnitObject,
  item: ItemObject,
  strike: CombatStrike,
  defenderRemainingHp: number,
): number {
  const value = lifelinkValue(item);
  if (value === null) return 0;
  if (strike.attacker !== striker || !strike.hit) return 0;
  if (strike.item !== item && !isSubitemOf(strike.item, item)) return 0;
  const remaining = Math.max(0, defenderRemainingHp);
  const clamped = Math.max(0, Math.min(strike.damage, remaining));
  return Math.floor(clamped * value);
}

/** Return the lifelink fraction (0..1) if the item tree carries one. */
function lifelinkValue(item: ItemObject): number | null {
  const direct = item.getComponent<number>('lifelink');
  if (typeof direct === 'number') return direct;
  for (const sub of item.subitems) {
    const v = lifelinkValue(sub);
    if (v !== null) return v;
  }
  return null;
}

function isSubitemOf(candidate: ItemObject, parent: ItemObject): boolean {
  let node = candidate.parentItem;
  while (node) {
    if (node === parent) return true;
    node = node.parentItem;
  }
  return false;
}

/**
 * Python `Warning.target_icon` / `EvalWarning.target_icon`: a marker shown
 * over an enemy unit while targeting, warning that the item is dangerous
 * against them (Killer weapons -> 'warning'; effective-weapon evaluated
 * conditions -> 'danger').
 *
 * `eval_warning`'s Python string is an arbitrary evaluated expression
 * (`evaluate.evaluate`). The web has no general expression evaluator wired
 * into targeting, so this approximates only the common default-project
 * pattern: an unconfigured/`'True'` value means "always danger against an
 * enemy". No default.ltproj item actually ships a non-trivial eval_warning
 * expression, so this covers the real-world usage; anything more exotic is
 * deferred (documented in PLAN.md).
 */
export function computeTargetIcon(
  unit: UnitObject,
  item: ItemObject,
  target: UnitObject,
  db: Database,
  game?: any,
): 'warning' | 'danger' | null {
  const isEnemy = !unit.isAlly(target.team, db.teams.alliances);
  if (!isEnemy) return null;

  if (item.hasComponent('warning') && available(unit, item, db, game)) {
    return 'warning';
  }

  if (item.hasComponent('eval_warning')) {
    const expr = String(item.getComponent<string>('eval_warning') ?? 'True').trim();
    if (expr === 'True' || expr === '') return 'danger';
    // Non-trivial expressions are not evaluated on the web; skip.
  }

  return null;
}
