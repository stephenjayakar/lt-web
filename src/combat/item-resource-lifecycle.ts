import { evaluateExpression } from '../events/event-manager';
import type { ActionLog } from '../engine/action';
import {
  GainMoneyAction,
  RemoveSkillAction,
  SetCurrentHpAction,
  SetItemDataAction,
} from '../engine/action';
import type { ItemObject } from '../objects/item';
import type { UnitObject } from '../objects/unit';
import type { Database } from '../data/database';

export interface ItemResourceGame {
  actionLog?: Pick<ActionLog, 'doAction'>;
  currentParty?: string;
  gameVars?: Map<string, unknown>;
  levelVars?: Map<string, unknown>;
  turnCount?: number;
  db?: Database;
}

type ItemOverrideEntriesEvaluator = (
  unit: UnitObject,
  item: ItemObject,
  game?: ItemResourceGame,
) => [string, unknown][];

let itemOverrideEntriesEvaluator: ItemOverrideEntriesEvaluator | null = null;

/** Registered by item-system without introducing an item-system import cycle. */
export function setItemOverrideEntriesEvaluator(
  evaluator: ItemOverrideEntriesEvaluator,
): void {
  itemOverrideEntriesEvaluator = evaluator;
}

function resourceComponents(
  unit: UnitObject,
  item: ItemObject,
  game?: ItemResourceGame,
): [string, unknown][] {
  return [
    ...item.components.entries(),
    ...(itemOverrideEntriesEvaluator?.(unit, item, game) ?? []),
  ];
}

interface StackCost {
  skill: string;
  amount: number;
}

function optionRecord(raw: unknown): Record<string, unknown> {
  if (Array.isArray(raw)) {
    return Object.fromEntries(raw.filter(
      (entry): entry is [string, unknown] =>
        Array.isArray(entry) && entry.length >= 2 && typeof entry[0] === 'string',
    ));
  }
  return raw && typeof raw === 'object'
    ? raw as Record<string, unknown>
    : {};
}

function evaluatedCost(
  expression: unknown,
  unit: UnitObject,
  item: ItemObject,
  game?: ItemResourceGame,
): number | null {
  if (typeof expression === 'number') return Math.trunc(expression);
  if (typeof expression !== 'string') return null;
  try {
    const result = Number(evaluateExpression(expression, {
      game,
      unit1: unit,
      item,
      position: unit.position ?? undefined,
      gameVars: game?.gameVars,
      levelVars: game?.levelVars,
    }));
    return Number.isFinite(result) ? Math.trunc(result) : null;
  } catch {
    return null;
  }
}

function stackCost(
  component: string,
  raw: unknown,
  unit: UnitObject,
  item: ItemObject,
  game?: ItemResourceGame,
): StackCost | null {
  if (component === 'stack_cost') {
    return typeof raw === 'string' ? { skill: raw, amount: 1 } : null;
  }
  const options = optionRecord(raw);
  const skill = options.skill;
  if (typeof skill !== 'string') return null;
  const amount = component === 'eval_stack_cost'
    ? evaluatedCost(options.amount, unit, item, game)
    : Number(options.amount);
  if (amount === null || !Number.isFinite(amount)) return null;
  return { skill, amount: Math.max(0, Math.trunc(amount)) };
}

/** Availability contributed by HP, stack, and cooldown resource components. */
export function itemResourcesAvailable(
  unit: UnitObject,
  item: ItemObject,
  components: Map<string, unknown> = item.components,
  game?: ItemResourceGame,
): boolean {
  for (const [component, raw] of components) {
    if (component === 'eval_hp_cost') {
      const amount = evaluatedCost(raw, unit, item, game);
      if (amount === null || unit.currentHp <= amount) return false;
    } else if (
      component === 'stack_cost' ||
      component === 'stack_cost_multi' ||
      component === 'eval_stack_cost'
    ) {
      const cost = stackCost(component, raw, unit, item, game);
      if (!cost) return false;
      const stacks = unit.skills.filter((skill) => skill.nid === cost.skill).length;
      if (stacks < cost.amount) return false;
    } else if (
      component === 'cooldown' &&
      Number(item.data.get('cooldown') ?? 0) !== 0
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Consume resources whose Python hooks run at start_combat.
 * Each removed stack is its original SkillObject, so rewind restores identity.
 */
export function applyItemStartResourceHooks(
  game: ItemResourceGame,
  unit: UnitObject,
  item: ItemObject,
): number {
  if (!game.actionLog) return 0;
  let applied = 0;
  for (const [component, raw] of resourceComponents(unit, item, game)) {
    if (component === 'gold_cost') {
      const amount = Number(raw);
      if (Number.isFinite(amount) && amount > 0) {
        game.actionLog.doAction(new GainMoneyAction(-amount, game.currentParty));
        applied++;
      }
    } else if (
      component === 'stack_cost' ||
      component === 'stack_cost_multi' ||
      component === 'eval_stack_cost'
    ) {
      const cost = stackCost(component, raw, unit, item, game);
      if (!cost) continue;
      const stacks = unit.skills
        .filter((skill) => skill.nid === cost.skill)
        .slice(0, cost.amount);
      for (const skill of stacks) {
        game.actionLog.doAction(new RemoveSkillAction(unit, skill));
        applied++;
      }
    }
  }
  return applied;
}

/** Apply HP cost and generic cooldown once after a successful item use. */
export function applyItemEndResourceHooks(
  game: ItemResourceGame,
  unit: UnitObject,
  item: ItemObject,
): number {
  if (!game.actionLog) return 0;
  let applied = 0;
  for (const [component, raw] of resourceComponents(unit, item, game)) {
    if (component === 'eval_hp_cost') {
      const amount = evaluatedCost(raw, unit, item, game);
      if (amount !== null) {
        game.actionLog.doAction(new SetCurrentHpAction(unit, unit.currentHp - amount));
        applied++;
      }
    } else if (component === 'cooldown') {
      const amount = Math.max(0, Math.trunc(Number(raw)));
      if (Number.isFinite(amount)) {
        game.actionLog.doAction(new SetItemDataAction(item, 'cooldown', amount));
        applied++;
      }
    }
  }
  return applied;
}

/** Tick owned item cooldowns at the unit's upkeep in component order. */
export function applyItemUpkeepResourceHooks(
  game: ItemResourceGame,
  unit: UnitObject,
  extraItems: ItemObject[] = [],
): number {
  if (!game.actionLog) return 0;
  const visited = new Set<ItemObject>();
  let applied = 0;
  const visit = (item: ItemObject): void => {
    if (visited.has(item)) return;
    visited.add(item);
    for (const child of item.subitems) visit(child);

    const current = Number(item.data.get('cooldown') ?? 0);
    if (!item.hasComponent('cooldown') || current <= 0) return;
    const starting = Math.max(0, Number(item.data.get('starting_cooldown') ?? 0));
    const next = item.hasComponent('start_cooldown') && game.turnCount === 1
      ? starting
      : current - 1;
    game.actionLog!.doAction(new SetItemDataAction(item, 'cooldown', next));
    applied++;
  };
  for (const item of unit.items) visit(item);
  for (const item of extraItems) visit(item);
  return applied;
}

/** Reset cooldown data at the chapter boundary; this mirrors Python's direct cleanup. */
export function applyItemEndChapterResourceHooks(item: ItemObject): void {
  if (!item.hasComponent('cooldown')) return;
  const value = item.hasComponent('start_cooldown')
    ? Number(item.data.get('starting_cooldown') ?? 0)
    : 0;
  item.setData('cooldown', Math.max(0, value));
}
