/**
 * already_triggered_events + full region-state save-field parity
 * (docs/parity/runtime-inventory.md §4, gaps: already_triggered_events,
 * full RegionObject state).
 *
 * Covers:
 *  - An only_once event does not re-fire after a save/load round trip.
 *  - Turnwheel undo restores an only_once event's triggerability (mirrors
 *    Python's action.OnlyOnceEvent.reverse).
 *  - A region created at runtime via add_region survives save/load with all
 *    its fields intact.
 *  - A region removed at runtime (via remove_region) stays gone after
 *    save/load.
 *  - A legacy save lacking the `regions` field still loads correctly
 *    (prefab fallback path, filtered by legacy regionNids).
 */

import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';

async function waitForHarness(page: Page): Promise<void> {
  await page.waitForFunction(() => !!(window as any).__harness?.ready, { timeout: 15000 });
}

async function stepFrames(page: Page, count: number): Promise<void> {
  await page.evaluate((count) => (window as any).__harness.stepFrames(count, null), count);
}

async function saveSnapshot(page: Page): Promise<any> {
  return page.evaluate(() => (window as any).__harness.saveSnapshot());
}

async function loadSnapshot(page: Page, snapshot: any): Promise<boolean> {
  return page.evaluate((snap) => (window as any).__harness.loadSnapshot(snap), snapshot);
}

async function turnwheelUndo(page: Page): Promise<boolean> {
  return page.evaluate(() => (window as any).__harness.turnwheelUndo());
}

/** Inject a synthetic only_once event prefab directly into the live DB events map
 *  (same Map reference the EventManager was constructed from). */
async function installTestEvent(page: Page, nid: string, triggerType: string): Promise<void> {
  await page.evaluate(
    ({ nid, triggerType }) => {
      const g = (window as any).__gameRef;
      g.db.events.set(nid, {
        name: nid,
        nid,
        trigger: triggerType,
        level_nid: null,
        condition: 'True',
        only_once: true,
        priority: 0,
        // A single no-op command so the event isn't immediately "done" (which
        // would make triggerSpecific report failure even though only_once
        // marking still happened).
        _source: ['wait;1'],
      });
    },
    { nid, triggerType },
  );
}

/** Fire a specific event by nid via EventManager.triggerSpecific, going through
 *  the action log so only_once marking is reversible. Returns whether it fired. */
async function triggerSpecificEvent(page: Page, nid: string): Promise<boolean> {
  return page.evaluate((nid) => {
    const g = (window as any).__gameRef;
    return g.eventManager.triggerSpecific(nid, { type: 'test_trigger', levelNid: g.currentLevel?.nid ?? '' }, false);
  }, nid);
}

async function addRegion(
  page: Page,
  args: { nid: string; pos: [number, number]; size: [number, number]; regionType: string; subNid: string },
): Promise<void> {
  await page.evaluate((args) => {
    const g = (window as any).__gameRef;
    const AddRegionAction = (window as any).__AddRegionActionCtor;
    const newRegion = {
      nid: args.nid,
      region_type: args.regionType,
      position: args.pos,
      size: args.size,
      sub_nid: args.subNid,
      condition: 'True',
      time_left: 42,
      only_once: true,
      interrupt_move: false,
      hide_time: false,
    };
    if (!g.currentLevel.regions) g.currentLevel.regions = [];
    g.actionLog.doAction(new AddRegionAction(newRegion, g.currentLevel.regions));
  }, args);
}

async function removeRegion(page: Page, nid: string): Promise<void> {
  await page.evaluate((nid) => {
    const g = (window as any).__gameRef;
    const RemoveRegionAction = (window as any).__RemoveRegionActionCtor;
    g.actionLog.doAction(new RemoveRegionAction(nid, g.currentLevel.regions));
  }, nid);
}

async function getRegionNids(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const g = (window as any).__gameRef;
    return (g.currentLevel?.regions ?? []).map((r: any) => r.nid);
  });
}

async function getRegion(page: Page, nid: string): Promise<any> {
  return page.evaluate((nid) => {
    const g = (window as any).__gameRef;
    return (g.currentLevel?.regions ?? []).find((r: any) => r.nid === nid) ?? null;
  }, nid);
}

async function exposeActionCtors(page: Page): Promise<void> {
  await page.evaluate(() => {
    return import('/src/engine/action.ts').then((m: any) => {
      (window as any).__AddRegionActionCtor = m.AddRegionAction;
      (window as any).__RemoveRegionActionCtor = m.RemoveRegionAction;
    });
  });
}

test.describe('Event + region save-field parity', () => {

  test('an only_once event does not re-fire after a save/load round trip', async ({ page }) => {
    await page.goto('/?harness=true&level=DEBUG&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 5);

    await installTestEvent(page, 'TestOnceEvent1', 'test_trigger_1');

    const firstFire = await triggerSpecificEvent(page, 'TestOnceEvent1');
    expect(firstFire).toBe(true);

    const secondFire = await triggerSpecificEvent(page, 'TestOnceEvent1');
    expect(secondFire).toBe(false);

    const snapshot = await saveSnapshot(page);
    expect(snapshot.alreadyTriggeredEvents).toContain('TestOnceEvent1');

    const loaded = await loadSnapshot(page, snapshot);
    expect(loaded).toBe(true);
    await stepFrames(page, 2);

    // Re-install the prefab (a fresh EventManager was constructed on restore,
    // but it shares the same db.events map, so this is only needed if the
    // restore path cleared it -- verify it's still there).
    const thirdFire = await triggerSpecificEvent(page, 'TestOnceEvent1');
    expect(thirdFire).toBe(false);
  });

  test('turnwheel undo restores an only_once event triggerability', async ({ page }) => {
    await page.goto('/?harness=true&level=DEBUG&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 5);

    await installTestEvent(page, 'TestOnceEvent2', 'test_trigger_2');

    const firstFire = await triggerSpecificEvent(page, 'TestOnceEvent2');
    expect(firstFire).toBe(true);

    const secondFire = await triggerSpecificEvent(page, 'TestOnceEvent2');
    expect(secondFire).toBe(false);

    const undone = await turnwheelUndo(page);
    expect(undone).toBe(true);

    const thirdFire = await triggerSpecificEvent(page, 'TestOnceEvent2');
    expect(thirdFire).toBe(true);
  });

  test('a region created at runtime via add_region survives save/load with all fields intact', async ({ page }) => {
    await page.goto('/?harness=true&level=DEBUG&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 5);
    await exposeActionCtors(page);

    await addRegion(page, {
      nid: 'RuntimeRegion1',
      pos: [3, 4],
      size: [2, 2],
      regionType: 'event',
      subNid: 'MySubEvent',
    });

    const before = await getRegion(page, 'RuntimeRegion1');
    expect(before).toBeTruthy();
    expect(before.position).toEqual([3, 4]);
    expect(before.size).toEqual([2, 2]);
    expect(before.region_type).toBe('event');
    expect(before.sub_nid).toBe('MySubEvent');
    expect(before.only_once).toBe(true);
    expect(before.time_left).toBe(42);

    const snapshot = await saveSnapshot(page);
    const regionRecord = snapshot.level.regions.find((r: any) => r.nid === 'RuntimeRegion1');
    expect(regionRecord).toBeTruthy();

    // Wipe runtime region list to prove restore rebuilds it from the save.
    await page.evaluate(() => {
      const g = (window as any).__gameRef;
      g.currentLevel = { ...g.currentLevel, regions: [] };
    });

    const loaded = await loadSnapshot(page, snapshot);
    expect(loaded).toBe(true);
    await stepFrames(page, 2);

    const after = await getRegion(page, 'RuntimeRegion1');
    expect(after).toBeTruthy();
    expect(after.position).toEqual([3, 4]);
    expect(after.size).toEqual([2, 2]);
    expect(after.region_type).toBe('event');
    expect(after.sub_nid).toBe('MySubEvent');
    expect(after.only_once).toBe(true);
    expect(after.time_left).toBe(42);
  });

  test('a region removed at runtime via remove_region stays gone after save/load', async ({ page }) => {
    await page.goto('/?harness=true&level=DEBUG&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 5);
    await exposeActionCtors(page);

    await addRegion(page, {
      nid: 'RuntimeRegion2',
      pos: [5, 5],
      size: [1, 1],
      regionType: 'normal',
      subNid: '',
    });
    expect(await getRegionNids(page)).toContain('RuntimeRegion2');

    await removeRegion(page, 'RuntimeRegion2');
    expect(await getRegionNids(page)).not.toContain('RuntimeRegion2');

    const snapshot = await saveSnapshot(page);
    expect(snapshot.level.regions.some((r: any) => r.nid === 'RuntimeRegion2')).toBe(false);

    // Add it back at runtime to prove restore doesn't resurrect it from the prefab.
    await addRegion(page, {
      nid: 'RuntimeRegion2',
      pos: [9, 9],
      size: [1, 1],
      regionType: 'normal',
      subNid: '',
    });
    expect(await getRegionNids(page)).toContain('RuntimeRegion2');

    const loaded = await loadSnapshot(page, snapshot);
    expect(loaded).toBe(true);
    await stepFrames(page, 2);

    expect(await getRegionNids(page)).not.toContain('RuntimeRegion2');
  });

  test('a legacy save lacking the regions field still loads correctly (prefab fallback)', async ({ page }) => {
    await page.goto('/?harness=true&level=DEBUG&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 5);

    const prefabRegionNids = await getRegionNids(page);

    const snapshot = await saveSnapshot(page);
    const legacy = JSON.parse(JSON.stringify(snapshot));
    // Simulate a legacy save: no `regions` field, only the old `regionNids`.
    legacy.level.regionNids = legacy.level.regions.map((r: any) => r.nid);
    delete legacy.level.regions;
    delete legacy.alreadyTriggeredEvents;

    // Wipe runtime state so the load is observable.
    await page.evaluate(() => {
      const g = (window as any).__gameRef;
      g.currentLevel = { ...g.currentLevel, regions: [] };
    });

    const loaded = await loadSnapshot(page, legacy);
    expect(loaded).toBe(true);
    await stepFrames(page, 2);

    // Legacy fallback rebuilds from the prefab, filtered to the saved NIDs.
    const after = await getRegionNids(page);
    expect(after.sort()).toEqual(prefabRegionNids.sort());
  });
});
