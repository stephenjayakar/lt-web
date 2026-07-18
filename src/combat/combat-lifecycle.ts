import type { EventManager, EventTrigger } from '../events/event-manager';
import type { ItemObject } from '../objects/item';
import type { UnitObject } from '../objects/unit';
import type { CombatStrike } from './combat-solver';
import type { CombatResults } from './map-combat';
import type { ActionLog } from '../engine/action';
import {
  SetItemDroppableAction,
  MoveItemBetweenUnitsAction,
  RemoveItemFromUnitAction,
} from '../engine/action';

interface CombatLifecycleGame {
  eventManager: EventManager | null;
  currentLevel?: { nid: string } | null;
}

interface DroppableGame {
  getConstant: (nid: string, fallback?: any) => any;
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
