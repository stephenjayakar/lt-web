/**
 * P2 roadmap hygiene: village-visit only_once region consumption reversibility,
 * and loadLevel() prefab-aliasing fix (PLAN.md P2 items).
 *
 * Covers:
 *  - Consuming sibling Visit/Destructible only_once regions (as happens on a
 *    village tile) is now routed through RemoveRegionAction, so turnwheel
 *    undo restores both regions at their original list positions, and
 *    re-consuming afterward is a clean single removal (no double bookkeeping).
 *  - loadLevel() no longer aliases the DB level prefab: runtime region/layer
 *    mutations do not leak into a subsequent clean reload of the same level.
 *  - Save -> undo a region consumption via turnwheel -> save/load round trip
 *    preserves the undone (restored) region state.
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

async function exposeActionCtors(page: Page): Promise<void> {
  await page.evaluate(() => {
    return import('/src/engine/action.ts').then((m: any) => {
      (window as any).__AddRegionActionCtor = m.AddRegionAction;
      (window as any).__RemoveRegionActionCtor = m.RemoveRegionAction;
      (window as any).__MarkActionGroupStartCtor = m.MarkActionGroupStart;
      (window as any).__MarkActionGroupEndCtor = m.MarkActionGroupEnd;
    });
  });
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

async function getRegionNids(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const g = (window as any).__gameRef;
    return (g.currentLevel?.regions ?? []).map((r: any) => r.nid);
  });
}

/** Simulate the production "consume village siblings" flow: two RemoveRegionAction
 *  calls issued inside the same action group, exactly as game-states.ts now does
 *  at both only_once consumption sites. */
async function consumeSiblingRegions(
  page: Page,
  visitNid: string,
  destroyNid: string,
): Promise<void> {
  await page.evaluate(
    ({ visitNid, destroyNid }) => {
      const g = (window as any).__gameRef;
      const RemoveRegionAction = (window as any).__RemoveRegionActionCtor;
      const MarkActionGroupStart = (window as any).__MarkActionGroupStartCtor;
      const MarkActionGroupEnd = (window as any).__MarkActionGroupEndCtor;
      g.actionLog.doAction(new MarkActionGroupStart(null, 'test'));
      g.actionLog.doAction(new RemoveRegionAction(visitNid, g.currentLevel.regions));
      g.actionLog.doAction(new RemoveRegionAction(destroyNid, g.currentLevel.regions));
      g.actionLog.doAction(new MarkActionGroupEnd('test'));
    },
    { visitNid, destroyNid },
  );
}

test.describe('Region reversibility + loadLevel prefab-aliasing (P2 hygiene)', () => {
  test('sibling only_once regions consumed on a village tile are reversible via turnwheel', async ({ page }) => {
    await page.goto('/?harness=true&level=DEBUG&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 5);
    await exposeActionCtors(page);

    await addRegion(page, { nid: 'Village1', pos: [2, 2], size: [1, 1], regionType: 'event', subNid: 'Visit' });
    await addRegion(page, { nid: 'DestroyVillage1', pos: [2, 2], size: [1, 1], regionType: 'event', subNid: 'Destructible' });

    const beforeNids = await getRegionNids(page);
    expect(beforeNids).toContain('Village1');
    expect(beforeNids).toContain('DestroyVillage1');
    const visitIndex = beforeNids.indexOf('Village1');
    const destroyIndex = beforeNids.indexOf('DestroyVillage1');

    // Simulate the production consumption (both siblings removed atomically).
    await consumeSiblingRegions(page, 'Village1', 'DestroyVillage1');
    const afterConsume = await getRegionNids(page);
    expect(afterConsume).not.toContain('Village1');
    expect(afterConsume).not.toContain('DestroyVillage1');

    // MarkActionGroupEnd, RemoveRegionAction(Destroy...), RemoveRegionAction(Visit...),
    // MarkActionGroupStart were pushed in that order; undo() pops one action at a
    // time (LIFO), so 4 undos fully unwind this group.
    await turnwheelUndo(page); // undo group end marker
    await turnwheelUndo(page); // undo removal of DestroyVillage1
    await turnwheelUndo(page); // undo removal of Village1
    await turnwheelUndo(page); // undo group start marker

    const restored = await getRegionNids(page);
    expect(restored).toContain('Village1');
    expect(restored).toContain('DestroyVillage1');
    expect(restored.indexOf('Village1')).toBe(visitIndex);
    expect(restored.indexOf('DestroyVillage1')).toBe(destroyIndex);

    // Re-consuming after undo behaves like a fresh, single removal (no
    // leftover/double-removed bookkeeping from the undone attempt).
    await consumeSiblingRegions(page, 'Village1', 'DestroyVillage1');
    const afterReconsume = await getRegionNids(page);
    expect(afterReconsume).not.toContain('Village1');
    expect(afterReconsume).not.toContain('DestroyVillage1');
    expect(afterReconsume.length).toBe(beforeNids.length - 2);
  });

  test('loadLevel() clean reload is pristine: FAILS pre-fix, PASSES post-fix (prefab aliasing)', async ({ page }) => {
    await page.goto('/?harness=true&level=DEBUG&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 5);
    await exposeActionCtors(page);

    const originalNids = await getRegionNids(page);

    // Mutate runtime region state directly on game.currentLevel.regions (as
    // only_once consumption does) and toggle a layer's visibility.
    await addRegion(page, { nid: 'MutationProbeRegion', pos: [1, 1], size: [1, 1], regionType: 'normal', subNid: '' });
    await page.evaluate(() => {
      const g = (window as any).__gameRef;
      if (g.tilemap?.layers?.length) {
        g.tilemap.layers[0].visible = false;
      }
    });

    const mutatedNids = await getRegionNids(page);
    expect(mutatedNids).toContain('MutationProbeRegion');

    // Clean reload of the same level.
    await page.evaluate(() => (window as any).__harness.loadLevel('DEBUG'));
    await stepFrames(page, 2);

    const reloadedNids = await getRegionNids(page);
    // The runtime-added region must NOT survive into a fresh load -- if it
    // does, game.currentLevel was aliasing the shared DB prefab object.
    expect(reloadedNids).not.toContain('MutationProbeRegion');
    expect(reloadedNids.sort()).toEqual(originalNids.sort());

    const layerVisible = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      return g.tilemap?.layers?.[0]?.visible;
    });
    expect(layerVisible).toBe(true);
  });

  test('save -> turnwheel-undo a region consumption -> save/load preserves restored state', async ({ page }) => {
    await page.goto('/?harness=true&level=DEBUG&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 5);
    await exposeActionCtors(page);

    await addRegion(page, { nid: 'Village2', pos: [3, 3], size: [1, 1], regionType: 'event', subNid: 'Visit' });
    await addRegion(page, { nid: 'DestroyVillage2', pos: [3, 3], size: [1, 1], regionType: 'event', subNid: 'Destructible' });

    await consumeSiblingRegions(page, 'Village2', 'DestroyVillage2');
    expect(await getRegionNids(page)).not.toContain('Village2');

    // Undo the whole group (4 pushed actions).
    await turnwheelUndo(page);
    await turnwheelUndo(page);
    await turnwheelUndo(page);
    await turnwheelUndo(page);

    const restoredNids = await getRegionNids(page);
    expect(restoredNids).toContain('Village2');
    expect(restoredNids).toContain('DestroyVillage2');

    const snapshot = await saveSnapshot(page);
    expect(snapshot.level.regions.some((r: any) => r.nid === 'Village2')).toBe(true);
    expect(snapshot.level.regions.some((r: any) => r.nid === 'DestroyVillage2')).toBe(true);

    // Wipe runtime state to prove the reload rebuilds from the save, not the prefab.
    await page.evaluate(() => {
      const g = (window as any).__gameRef;
      g.currentLevel = { ...g.currentLevel, regions: [] };
    });

    const loaded = await loadSnapshot(page, snapshot);
    expect(loaded).toBe(true);
    await stepFrames(page, 2);

    const afterLoad = await getRegionNids(page);
    expect(afterLoad).toContain('Village2');
    expect(afterLoad).toContain('DestroyVillage2');
  });
});
