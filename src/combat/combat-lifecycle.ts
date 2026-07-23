import {
  evaluateCondition,
  evaluateExpression,
  type EventManager,
  type EventTrigger,
} from '../events/event-manager';
import type { ItemObject } from '../objects/item';
import type { UnitObject } from '../objects/unit';
import { SkillObject } from '../objects/skill';
import type { CombatStrike } from './combat-solver';
import type { CombatResults } from './map-combat';
import type { ActionLog } from '../engine/action';
import {
  ChangeManaAction,
  ChangeFatigueAction,
  SetItemDroppableAction,
  MoveItemBetweenUnitsAction,
  RemoveItemFromUnitAction,
  WarpUnitAction,
  SwapUnitsAction,
  AddSkillAction,
  SetSkillDataAction,
} from '../engine/action';
import type { Database } from '../data/database';
import type { GameBoard } from '../objects/game-board';
import {
  drawBackDestinations,
  pivotDestination,
  shoveDestination,
} from './item-system';
import { ignoreForcedMovement } from './skill-system';
import { evaluateEquation } from './combat-calcs';

interface CombatLifecycleGame {
  eventManager: EventManager | null;
  currentLevel?: { nid: string } | null;
  gameVars?: Map<string, unknown>;
  levelVars?: Map<string, unknown>;
  actionLog?: Pick<ActionLog, 'doAction'>;
  board?: GameBoard | null;
  db?: Database;
}

interface DroppableGame {
  getConstant: (nid: string, fallback?: any) => any;
}

/** Resolve Python Trade.end_combat's successful user/target pair. */
export function combatTradePair(
  strikes: CombatStrike[],
): { unit: UnitObject; partner: UnitObject } | null {
  const hit = strikes.find((strike) =>
    strike.hit && strike.item.hasComponent('trade') && !strike.attacker.isDead() &&
    !strike.defender.isDead());
  return hit ? { unit: hit.attacker, partner: hit.defender } : null;
}

function combatSkillEnabled(
  game: CombatLifecycleGame,
  unit: UnitObject,
  skill: SkillObject,
  target: UnitObject,
  item: ItemObject,
): boolean {
  const total = Number(skill.data.get('total_charge'));
  const charge = Number(skill.data.get('charge'));
  if (skill.hasComponent('build_charge') && Number.isFinite(total) && charge < total) return false;
  if ((skill.hasComponent('drain_charge') || skill.hasComponent('charges_per_turn')) &&
      Number.isFinite(charge) && charge <= 0) return false;
  const condition = skill.getComponent<string>('condition');
  return !condition || evaluateCondition(condition, {
    game,
    unit1: unit,
    unit2: target,
    item,
    position: unit.position ?? undefined,
    gameVars: game.gameVars,
    levelVars: game.levelVars,
    localArgs: new Map([['skill', skill]]),
  });
}

function triggerSkillCharge(
  game: CombatLifecycleGame,
  skill: SkillObject,
): void {
  if (!game.actionLog) return;
  if (skill.hasComponent('build_charge')) {
    game.actionLog.doAction(new SetSkillDataAction(skill, 'charge', 0));
  } else if (skill.hasComponent('drain_charge') || skill.hasComponent('charges_per_turn')) {
    const charge = Number(skill.data.get('charge') ?? 0);
    game.actionLog.doAction(new SetSkillDataAction(skill, 'charge', charge - 1));
  }
}

function grantCombatStatus(
  game: CombatLifecycleGame,
  source: UnitObject,
  target: UnitObject,
  skill: SkillObject,
  statusNid: string,
): number {
  const prefab = game.db?.skills.get(statusNid);
  if (!prefab || !game.actionLog) return 0;
  const status = new SkillObject(prefab);
  status.initiatorNid = source.nid;
  game.actionLog.doAction(new AddSkillAction(target, status));
  triggerSkillCharge(game, skill);
  return 1;
}

/** Apply Python's persistent post-strike/end-combat status skill hooks. */
export function applyCombatSkillEndHooks(
  game: CombatLifecycleGame,
  strikes: CombatStrike[],
  initiator?: UnitObject,
  primaryTarget?: UnitObject,
): number {
  if (!game.actionLog || !game.db) return 0;
  let applied = 0;
  const pairs = new Map<string, {
    unit: UnitObject;
    target: UnitObject;
    item: ItemObject;
    strikes: CombatStrike[];
  }>();
  for (const strike of strikes) {
    const key = `${strike.attacker.nid}:${strike.defender.nid}:${strike.item.nid}`;
    const pair = pairs.get(key) ?? {
      unit: strike.attacker,
      target: strike.defender,
      item: strike.item,
      strikes: [],
    };
    pair.strikes.push(strike);
    pairs.set(key, pair);
  }
  if (initiator && primaryTarget && strikes[0]) {
    const addPassivePair = (unit: UnitObject, target: UnitObject): void => {
      const key = `${unit.nid}:${target.nid}:passive`;
      if (!pairs.has(key) && ![...pairs.values()].some(
        (pair) => pair.unit === unit && pair.target === target,
      )) {
        pairs.set(key, { unit, target, item: strikes[0].item, strikes: [] });
      }
    };
    addPassivePair(initiator, primaryTarget);
    addPassivePair(primaryTarget, initiator);
  }

  for (const { unit, target, item, strikes: pairStrikes } of pairs.values()) {
    const isAlly = game.db.areAllied(unit.team, target.team);
    for (const skill of [...unit.skills]) {
      if (!combatSkillEnabled(game, unit, skill, target, item)) continue;

      const afterHit = skill.getComponent<string>('give_status_after_hit');
      if (afterHit) {
        for (const strike of pairStrikes.filter((candidate) => candidate.hit)) {
          applied += grantCombatStatus(game, unit, strike.defender, skill, afterHit);
        }
      }

      const afterCombat = skill.getComponent<string>('give_status_after_combat');
      if (afterCombat && !isAlly) {
        applied += grantCombatStatus(game, unit, target, skill, afterCombat);
      }
      const allyAfterCombat = skill.getComponent<string>('give_ally_status_after_combat');
      if (allyAfterCombat && isAlly) {
        applied += grantCombatStatus(game, unit, target, skill, allyAfterCombat);
      }
      const afterAttack = skill.getComponent<string>('give_status_after_attack');
      if (afterAttack && pairStrikes.length > 0) {
        applied += grantCombatStatus(game, unit, target, skill, afterAttack);
      }
      const afterCombatHit = skill.getComponent<string>('give_status_after_combat_on_hit');
      if (afterCombatHit && pairStrikes.some((strike) => strike.hit)) {
        applied += grantCombatStatus(game, unit, target, skill, afterCombatHit);
      }
    }
  }
  return applied;
}

/** Matches Python banner.AcquiredItem: "{name} got {article} {item}." with no article for possessive names. */
export function droppableAcquiredBannerText(unit: UnitObject, item: ItemObject): string {
  if (item.name.includes("'")) return `${unit.name} got ${item.name}.`;
  const article = /^[aeiouAEIOU]/.test(item.name) ? 'an' : 'a';
  return `${unit.name} got ${article} ${item.name}.`;
}

/** Matches Python banner.SentToConvoy: "{item} sent to convoy." */
export function droppableSentToConvoyBannerText(item: ItemObject): string {
  return `${item.name} sent to convoy.`;
}

export interface DroppablePickupResult {
  /** Banner text for each pickup, in order, for the caller to display. */
  banners: string[];
  /**
   * Player units force-given a drop while at capacity: the caller must route
   * the player through the 'item_discard' state after combat resolves
   * (Python's force_give -> item_discard flow).
   */
  pendingDiscards: Array<{ unit: UnitObject; item: ItemObject }>;
}

/**
 * Applies Python's simple_combat.handle_item_gain: every droppable item on a
 * unit killed this combat transfers to the killer (the attacker for defender
 * deaths, or the primary defender if the attacker itself died). No team
 * allegiance gate exists in Python — an enemy killing a player unit loots its
 * droppable items exactly like a player killing an enemy.
 *
 * A full PLAYER killer is force-given the item anyway (over capacity) and
 * reported in `pendingDiscards` so the caller can open the 'item_discard'
 * state, matching Python's GiveItem force_give -> item_discard flow. A full
 * non-player killer matches Python's GiveItem silent refusal: the item is
 * removed from the dead unit and lost.
 */
export function applyDroppableItemPickups(
  actionLog: Pick<ActionLog, 'doAction'>,
  db: DroppableGame,
  results: CombatResults,
  attacker: UnitObject,
  dropRecipient: UnitObject | null,
): DroppablePickupResult {
  const banners: string[] = [];
  const pendingDiscards: Array<{ unit: UnitObject; item: ItemObject }> = [];
  for (const { unit: deadUnit, item } of results.droppedItems ?? []) {
    const killer = deadUnit === attacker ? dropRecipient : attacker;
    if (!killer) continue;
    actionLog.doAction(new SetItemDroppableAction(item, false));
    const accessory = item.hasComponent('accessory');
    const limit = Number(db.getConstant(accessory ? 'num_accessories' : 'num_items', accessory ? 0 : 5));
    const count = killer.items.filter((candidate) => candidate.hasComponent('accessory') === accessory).length;
    const full = count >= limit;
    if (!full) {
      actionLog.doAction(new MoveItemBetweenUnitsAction(deadUnit, killer, item));
      banners.push(droppableAcquiredBannerText(killer, item));
    } else if (killer.team === 'player') {
      // Python force-gives the item (over capacity) and then opens the
      // item_discard state for the player to choose what to store/discard.
      actionLog.doAction(new MoveItemBetweenUnitsAction(deadUnit, killer, item));
      banners.push(droppableAcquiredBannerText(killer, item));
      pendingDiscards.push({ unit: killer, item });
    } else {
      // Python's GiveItem.do() silently refuses to add to a full non-player
      // inventory; the item is simply removed from the dead unit and lost.
      actionLog.doAction(new RemoveItemFromUnitAction(deadUnit, item));
    }
  }
  return { banners, pendingDiscards };
}

function eventNid(item: ItemObject, component: string): string | null {
  const value = item.getComponent<any>(component);
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function triggerForStrike(strike: CombatStrike, _attackIndex: number): EventTrigger {
  const targetPosition = strike.defender.position
    ? [...strike.defender.position] as [number, number]
    : null;
  const item2 = strike.defender.items.find((item) => item.isWeapon()) ?? null;
  return {
    type: 'item_combat_event',
    unit1: strike.attacker,
    unit2: strike.defender,
    unitNid: strike.attacker.nid,
    position: strike.attacker.position
      ? [...strike.attacker.position] as [number, number]
      : undefined,
    item: strike.item,
    localArgs: new Map<string, any>([
      ['target_pos', targetPosition],
      ['mode', strike.mode ?? (strike.isCounter ? 'defense' : 'attack')],
      ['attack_info', [...strike.attackInfo]],
      ['item', strike.item],
      ['item2', item2],
    ]),
  };
}

/**
 * Queue hidden EventAfterInitiatedCombat skill hooks at Python's
 * skill-system end-combat point. Only active skills on the initiating side
 * participate; defenders are deliberately not scanned.
 */
export function queueAfterInitiatedCombatEvents(
  game: CombatLifecycleGame,
  bearer: UnitObject,
  target: UnitObject,
  item: ItemObject,
  item2: ItemObject | null,
  mode: string,
): number {
  const manager = game.eventManager;
  if (!manager || mode !== 'attack') return 0;

  let queued = 0;
  for (const skill of bearer.skills) {
    const nid = skill.getComponent<unknown>('event_after_initiated_combat');
    if (typeof nid !== 'string' || nid.length === 0) continue;
    const condition = skill.getComponent<string>('condition');
    if (condition && !evaluateCondition(condition, {
      game,
      unit1: bearer,
      unit2: target,
      position: bearer.position ?? undefined,
      item,
      gameVars: game.gameVars,
      levelVars: game.levelVars,
    })) continue;

    if (manager.triggerSpecific(nid, {
      type: 'event_after_initiated_combat',
      unit1: bearer,
      unit2: target,
      unitNid: bearer.nid,
      position: bearer.position
        ? [...bearer.position] as [number, number]
        : undefined,
      localArgs: new Map<string, unknown>([
        ['item', item],
        ['item2', item2],
        ['mode', mode],
      ]),
    })) queued++;
  }
  return queued;
}

/** Apply item end-combat resource hooks once per item that participated. */
export function applyCombatItemEndHooks(game: CombatLifecycleGame, strikes: CombatStrike[]): number {
  if (!game.actionLog || !game.db) return 0;
  const processed = new Set<ItemObject>();
  let applied = 0;
  for (const strike of strikes) {
    if (processed.has(strike.item)) continue;
    processed.add(strike.item);
    const itemMarks = strikes.filter((candidate) => candidate.item === strike.item);
    const firstMark = itemMarks[0];
    const hitMarks = [...new Map(
      itemMarks
        .filter((candidate) => candidate.hit)
        .map((candidate) => [candidate.defender.nid, candidate]),
    ).values()];
    if (game.board) {
      for (const componentNid of strike.item.components.keys()) {
        const marks = componentNid === 'shove_on_end_combat' ||
          componentNid === 'swap_on_end_combat'
          ? [firstMark]
          : hitMarks;
        for (const mark of marks) {
          if ((componentNid === 'shove' || componentNid === 'shove_on_end_combat') &&
              mark.attacker.position && !ignoreForcedMovement(mark.defender)) {
            const destination = shoveDestination(
              mark.defender,
              mark.attacker.position,
              Number(strike.item.getComponent<number>(componentNid) ?? 1),
              { board: game.board, db: game.db, game },
            );
            if (destination) {
              game.actionLog.doAction(new WarpUnitAction(mark.defender, destination, game.board));
              applied++;
            }
          } else if ((componentNid === 'swap' || componentNid === 'swap_on_end_combat') &&
              mark.attacker.position && mark.defender.position &&
              !ignoreForcedMovement(mark.attacker) && !ignoreForcedMovement(mark.defender) &&
              (!mark.isCounter || componentNid === 'swap')) {
            game.actionLog.doAction(new SwapUnitsAction(mark.attacker, mark.defender, game.board));
            applied++;
          } else if (componentNid === 'pivot' && mark.defender.position &&
              !ignoreForcedMovement(mark.attacker)) {
            const destination = pivotDestination(
              mark.attacker,
              mark.defender.position,
              Number(strike.item.getComponent<number>('pivot') ?? 1),
              { board: game.board, db: game.db, game },
            );
            if (destination) {
              game.actionLog.doAction(new WarpUnitAction(mark.attacker, destination, game.board));
              applied++;
            }
          } else if (componentNid === 'draw_back' && !ignoreForcedMovement(mark.defender)) {
            const destinations = drawBackDestinations(
              mark.attacker,
              mark.defender,
              Number(strike.item.getComponent<number>('draw_back') ?? 1),
              { board: game.board, db: game.db, game },
            );
            if (destinations) {
              game.actionLog.doAction(new WarpUnitAction(mark.attacker, destinations[0], game.board));
              game.actionLog.doAction(new WarpUnitAction(mark.defender, destinations[1], game.board));
              applied += 2;
            }
          }
        }
      }
    }
    const fatigue = strike.item.getComponent<number>('fatigue');
    if (!strike.isCounter && typeof fatigue === 'number' && fatigue !== 0) {
      game.actionLog.doAction(new ChangeFatigueAction(strike.attacker, fatigue));
      applied++;
    }

    const expression = strike.item.getComponent<unknown>('gain_mana_after_combat');
    if (typeof expression === 'string' && expression.length > 0) {
      try {
        const amount = Math.trunc(Number(evaluateExpression(expression, {
          game,
          unit1: strike.attacker,
          unit2: strike.defender,
          position: strike.attacker.position ?? undefined,
          item: strike.item,
          gameVars: game.gameVars,
          levelVars: game.levelVars,
        })));
        if (!Number.isFinite(amount)) continue;
        const manaExpression = game.db.getEquation('MANA') ?? '0';
        const maximum = Math.max(
          0,
          Math.trunc(evaluateEquation(manaExpression, strike.attacker, {
            db: game.db as any,
            item: strike.item,
          })),
        );
        game.actionLog.doAction(new ChangeManaAction(strike.attacker, amount, maximum));
        applied++;
      } catch (error) {
        console.error(`Could not evaluate ${expression}`, error);
      }
    }
  }
  return applied;
}

/**
 * Queue item component events in Python hook order after strike resolution.
 * Specific events bypass their prefab condition, matching trigger_specific_event.
 */
export function queueCombatItemEvents(game: CombatLifecycleGame, strikes: CombatStrike[]): number {
  const manager = game.eventManager;
  if (!manager) return 0;
  let queued = 0;

  strikes.forEach((strike, index) => {
    if (!strike.hit) return;
    for (const component of ['event_on_use', 'event_on_hit']) {
      const nid = eventNid(strike.item, component);
      if (nid && manager.triggerSpecific(nid, triggerForStrike(strike, index))) queued++;
    }
  });

  const itemStrikes = new Map<ItemObject, CombatStrike[]>();
  for (const strike of strikes) {
    const marks = itemStrikes.get(strike.item) ?? [];
    marks.push(strike);
    itemStrikes.set(strike.item, marks);
  }
  for (const [item, marks] of itemStrikes) {
    const hits = marks.filter((strike) => strike.hit);
    const lastMark = marks[marks.length - 1];
    const lastHit = hits[hits.length - 1];
    const hitComponents = [
      'event_after_use',
      'event_after_combat',
      'event_after_combat_on_hit',
    ];
    if (lastHit) {
      for (const component of hitComponents) {
        const nid = eventNid(item, component);
        if (nid && manager.triggerSpecific(nid, triggerForStrike(lastHit, marks.indexOf(lastHit)))) {
          queued++;
        }
      }
    }
    const evenMissNid = eventNid(item, 'event_after_combat_even_miss');
    if (evenMissNid && lastMark &&
        manager.triggerSpecific(evenMissNid, triggerForStrike(lastMark, marks.length - 1))) {
      queued++;
    }
  }
  return queued;
}
