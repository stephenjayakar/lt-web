import { expect, test, type Page } from '@playwright/test';

async function bootEotf(page: Page): Promise<void> {
  await page.goto('/?harness=true&project=eotf.ltproj&level=X&clean=true&bundle=false');
  await page.waitForFunction(() => (window as any).__harness?.ready === true, undefined, {
    timeout: 60_000,
  });
}

test.describe('Embrace of the Fog self-unload sequence abilities', () => {
  test('count-locks all five null-valued unload children and their parents', async ({ page }) => {
    await bootEotf(page);
    const authored = await page.evaluate(() => {
      const game = (window as any).__gameRef;
      const children: Array<{ nid: string; value: unknown }> = [];
      const parents: Array<{ nid: string; children: string[] }> = [];
      for (const item of game.db.items.values()) {
        const components = Array.isArray(item.components)
          ? item.components
          : [...item.components.entries()];
        const selfUnload = components.find(([nid]: [string, unknown]) =>
          nid === 'self_unload_unit');
        if (selfUnload) {
          children.push({ nid: item.nid, value: selfUnload[1] });
        }
        const sequence = components.find(([nid]: [string, unknown]) =>
          nid === 'sequence_item')?.[1];
        if (Array.isArray(sequence) && sequence.some((nid) =>
          game.db.items.get(String(nid))?.components.some(
            ([component]: [string, unknown]) => component === 'self_unload_unit',
          ))) {
          parents.push({ nid: item.nid, children: sequence.map(String) });
        }
      }
      const byNid = (left: { nid: string }, right: { nid: string }) =>
        left.nid.localeCompare(right.nid);
      return {
        children: children.sort(byNid),
        parents: parents.sort(byNid),
      };
    });

    expect(authored).toEqual({
      children: [
        { nid: 'HeavySlam_2', value: null },
        { nid: 'NoktJutsu_Icewind_Unload', value: null },
        { nid: 'Sink_or_Swim_Unload', value: null },
        { nid: 'SpotRoll_2', value: null },
        { nid: 'Sprint_2', value: null },
      ],
      parents: [
        { nid: 'HeavySlam_Hub', children: ['HeavySlam_1', 'HeavySlam_2'] },
        {
          nid: 'NoktJutsu_Icewind',
          children: ['NoktJutsu_Icewind_Load', 'NoktJutsu_Icewind_Unload'],
        },
        {
          nid: 'Sink_or_Swim',
          children: ['Sink_or_Swim_Store', 'Sink_or_Swim_Unload'],
        },
        { nid: 'SpotRoll', children: ['SpotRoll_1', 'SpotRoll_2'] },
        { nid: 'Sprint', children: ['Sprint_1', 'Sprint_2'] },
      ],
    });
  });

  test('uses the real Heavy Slam child to warp freely with exact replay', async ({ page }) => {
    await bootEotf(page);
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { createItemTree } = await import('/src/objects/item.ts');
      const { applyCoreSequenceItem } = await import('/src/engine/states/game-states.ts');
      const { targetRestrict } = await import('/src/combat/item-system.ts');
      const unit = game.units.get('Player');
      const prefab = game.db.items.get('HeavySlam_Hub');
      if (!unit?.position || !prefab) return null;
      const item = createItemTree(prefab, (nid: string) => game.db.items.get(nid));
      item.owner = unit;
      // This test isolates movement/replay; event routing has its own real-item case below.
      item.components.delete('event_after_combat_even_miss');
      const store = item.subitems[0];
      const unload = item.subitems[1];
      const origin = [...unit.position] as [number, number];
      const destinations = game.targetSystem.getValidTargetsRecursive(unit, unload)
        .filter(([x, y]: [number, number]) => x !== origin[0] || y !== origin[1]);
      const destination = destinations[0];
      if (!destination) return null;
      const occupied = game.board.getUnit(destination[0], destination[1]);
      const oldMov = unit.stats.MOV;
      const originalMovementCost = game.board.getMovementCost.bind(game.board);
      unit.stats.MOV = 7;
      game.board.getMovementCost = () => 6;
      const weaklyTraversable = targetRestrict(
        unit,
        unload,
        destination,
        [],
        { board: game.board, db: game.db, game },
      );
      game.board.getMovementCost = () => 8;
      const tooCostly = targetRestrict(
        unit,
        unload,
        destination,
        [],
        { board: game.board, db: game.db, game },
      );
      game.board.getMovementCost = originalMovementCost;
      unit.stats.MOV = oldMov;
      const beforeActionIndex = game.actionLog.actionIndex;
      unit.finished = false;
      unit.hasAttacked = false;
      game.selectedUnit = unit;
      const applied = applyCoreSequenceItem(
        unit,
        item,
        [[origin], [destination]],
      );
      const after = {
        applied,
        position: unit.position ? [...unit.position] : null,
        cursor: game.cursor.getPosition(),
        finished: unit.finished,
        hasAttacked: unit.hasAttacked,
        coreEffect: item.hasCoreUseEffect(),
        storeTargetsSelf: game.targetSystem.getValidTargetsRecursive(unit, store)
          .some(([x, y]: [number, number]) => x === destination[0] && y === destination[1]),
        destinationWasEmpty: occupied === null,
        weaklyTraversable,
        tooCostly,
      };
      const actionLog = game.actionLog as any;
      while (actionLog.actionIndex > beforeActionIndex) actionLog.runActionBackward();
      const reversed = {
        position: unit.position ? [...unit.position] : null,
        finished: unit.finished,
        hasAttacked: unit.hasAttacked,
      };
      while (actionLog.actionIndex < actionLog.actions.length - 1) {
        actionLog.runActionForward();
      }
      const redone = {
        position: unit.position ? [...unit.position] : null,
        finished: unit.finished,
        hasAttacked: unit.hasAttacked,
      };
      return { origin, destination, after, reversed, redone };
    });

    expect(result).not.toBeNull();
    expect(result!.after).toEqual({
      applied: true,
      position: result!.destination,
      cursor: result!.destination,
      finished: false,
      hasAttacked: false,
      coreEffect: true,
      storeTargetsSelf: true,
      destinationWasEmpty: true,
      weaklyTraversable: true,
      tooCostly: false,
    });
    expect(result!.reversed).toEqual({
      position: result!.origin,
      finished: false,
      hasAttacked: false,
    });
    expect(result!.redone).toEqual({
      position: result!.destination,
      finished: false,
      hasAttacked: false,
    });
  });

  test('routes the real Heavy Slam parent event without consuming its free action', async ({ page }) => {
    await bootEotf(page);
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { createItemTree } = await import('/src/objects/item.ts');
      const { applyCoreSequenceItem } = await import('/src/engine/states/game-states.ts');
      const unit = game.units.get('Player');
      const prefab = game.db.items.get('HeavySlam_Hub');
      if (!unit?.position || !prefab) return null;
      const item = createItemTree(prefab, (nid: string) => game.db.items.get(nid));
      item.owner = unit;
      const eventNid = 'Global Skill_HeavySlam';
      const eventPrefab = game.db.events.get(eventNid) ?? {
        nid: eventNid,
        name: eventNid,
        trigger: 'item_combat_event',
        level_nid: null,
        condition: '',
        only_once: false,
        priority: 0,
        _source: ['level_var;_self_unload_event_routed;True'],
      };
      const hadEvent = game.eventManager.getPrefab(eventNid) !== undefined;
      if (!hadEvent) game.eventManager.allEvents.set(eventNid, eventPrefab);
      const origin = [...unit.position] as [number, number];
      const destination = game.targetSystem.getValidTargetsRecursive(unit, item.subitems[1])
        .find(([x, y]: [number, number]) => x !== origin[0] || y !== origin[1]);
      if (!destination) return null;
      const queueBefore = game.eventManager.eventQueue.length;
      const beforeActionIndex = game.actionLog.actionIndex;
      unit.finished = false;
      const applied = applyCoreSequenceItem(unit, item, [[origin], [destination]]);
      const finishedAfter = unit.finished;
      const queued = game.eventManager.eventQueue.slice(queueBefore)
        .map((event: any) => ({
          nid: event.nid,
          unit: event.trigger?.unit1?.nid ?? event.unit1?.nid ?? null,
          targetPos: event.trigger?.localArgs?.get?.('target_pos') ??
            event.localArgs?.get?.('target_pos') ?? null,
        }));
      game.eventManager.eventQueue.splice(queueBefore);
      if (!hadEvent) game.eventManager.allEvents.delete(eventNid);
      while (game.actionLog.actionIndex > beforeActionIndex) {
        game.actionLog.runActionBackward();
      }
      return {
        applied,
        destination,
        finishedAfter,
        queued,
        origin,
        restored: unit.position ? [...unit.position] : null,
      };
    });

    expect(result).not.toBeNull();
    expect(result!.applied).toBe(true);
    expect(result!.finishedAfter).toBe(false);
    expect(result!.queued).toEqual([{
      nid: 'Global Skill_HeavySlam',
      unit: 'Player',
      targetPos: result!.destination,
    }]);
    expect(result!.restored).toEqual(result!.origin);
  });
});
