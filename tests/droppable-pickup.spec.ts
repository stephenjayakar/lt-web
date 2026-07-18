/**
 * Droppable-item pickup on kill (Python simple_combat.handle_item_gain parity).
 *
 * Python behavior (verified against lt-maker/app/engine/combat/simple_combat.py
 * handle_item_gain, app/events/event_functions.py give_item, and app/engine/action.py
 * GiveItem/PutItemInConvoy/SetDroppable):
 *  - Every item with `droppable = true` on a unit killed in combat transfers to
 *    the killer (RemoveItem + a synthesized give_item event).
 *  - The item's `droppable` flag is always cleared on transfer (SetDroppable(item, False)).
 *  - If the killer's inventory is full: a player killer still receives the item via a
 *    forced-add + item_discard flow in Python; this web port simplifies that to sending
 *    the drop straight to the convoy instead (documented deviation). A non-player killer
 *    with a full inventory simply does not receive the item (GiveItem.do() refuses to add
 *    for non-player when `item_funcs.inventory_full` is true) — the item is lost.
 *  - There is NO team-allegiance gate in handle_item_gain: an enemy unit that kills a
 *    player unit loots that unit's droppable items exactly like a player kill would.
 *  - An "AcquiredItem" banner ("{name} got {a/an} {item}.") is shown for direct pickups;
 *    a "SentToConvoy" banner ("{item} sent to convoy.") is shown for the convoy case.
 */

import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';

async function waitForHarness(page: Page): Promise<void> {
  await page.waitForFunction(() => !!(window as any).__harness?.ready, { timeout: 15000 });
}

async function stepFrames(page: Page, count: number): Promise<void> {
  await page.evaluate(
    (count) => (window as any).__harness.stepFrames(count, null),
    count,
  );
}

async function giveItem(page: Page, unitNid: string, itemNid: string): Promise<boolean> {
  return page.evaluate(
    ({ unitNid, itemNid }) => (window as any).__harness.giveItem(unitNid, itemNid),
    { unitNid, itemNid },
  );
}

async function equipItem(page: Page, unitNid: string, itemNid: string): Promise<boolean> {
  return page.evaluate(
    ({ unitNid, itemNid }) => (window as any).__harness.equipItem(unitNid, itemNid),
    { unitNid, itemNid },
  );
}

async function resolveCombat(page: Page, attackerNid: string, defenderNid: string): Promise<any> {
  return page.evaluate(
    ({ attackerNid, defenderNid }) => (window as any).__harness.resolveCombat(attackerNid, defenderNid),
    { attackerNid, defenderNid },
  );
}

async function turnwheelUndo(page: Page): Promise<boolean> {
  return page.evaluate(() => (window as any).__harness.turnwheelUndo());
}

async function saveSnapshot(page: Page): Promise<unknown> {
  return page.evaluate(() => (window as any).__harness.saveSnapshot());
}

async function loadSnapshot(page: Page, snapshot: unknown): Promise<boolean> {
  return page.evaluate((snap) => (window as any).__harness.loadSnapshot(snap), snapshot);
}

async function forceRngMode(page: Page, mode: string): Promise<void> {
  await page.evaluate((mode) => {
    const g = (window as any).__gameRef;
    if (g?.db) {
      if (!g.db._constants) g.db._constants = new Map();
      g.db._constants.set('rng_mode', mode);
    }
  }, mode);
}

async function setUnitHp(page: Page, unitNid: string, hp: number): Promise<void> {
  await page.evaluate(
    ({ unitNid, hp }) => {
      const g = (window as any).__gameRef;
      const unit = g?.units?.get?.(unitNid);
      if (unit) {
        unit.currentHp = hp;
        unit.dead = hp <= 0;
      }
    },
    { unitNid, hp },
  );
}

/** Mark a unit's item as droppable=true directly (test setup helper). */
async function markDroppable(page: Page, unitNid: string, itemNid: string): Promise<void> {
  await page.evaluate(
    ({ unitNid, itemNid }) => {
      const g = (window as any).__gameRef;
      const unit = g?.units?.get?.(unitNid);
      const item = unit?.items?.find((i: any) => i.nid === itemNid);
      if (item) item.droppable = true;
    },
    { unitNid, itemNid },
  );
}

async function getItemOwner(page: Page, itemNid: string): Promise<{ ownerNid: string | null; droppable: boolean; inConvoy: boolean } | null> {
  return page.evaluate((itemNid) => {
    const g = (window as any).__gameRef;
    for (const unit of g.units.values()) {
      const item = unit.items.find((i: any) => i.nid === itemNid);
      if (item) return { ownerNid: unit.nid, droppable: item.droppable, inConvoy: false };
    }
    const party = g.getParty?.();
    const convoyItem = party?.convoy?.find((i: any) => i.nid === itemNid);
    if (convoyItem) return { ownerNid: null, droppable: convoyItem.droppable, inConvoy: true };
    return null;
  }, itemNid);
}

test.describe('Droppable-item pickup on kill', () => {
  test('killer gains a droppable item from a killed defender, with droppable cleared', async ({ page }) => {
    await page.goto('/?harness=true&level=DEBUG&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 5);

    await giveItem(page, 'Bone', 'Elixir');
    await markDroppable(page, 'Bone', 'Elixir');

    await giveItem(page, 'Eirika', 'Iron_Bow');
    await equipItem(page, 'Eirika', 'Iron_Bow');
    await forceRngMode(page, 'grandmaster');
    await setUnitHp(page, 'Bone', 1);

    const result = await resolveCombat(page, 'Eirika', 'Bone');
    expect(result).not.toBeNull();
    expect(result.defenderDead).toBe(true);

    const owner = await getItemOwner(page, 'Elixir');
    expect(owner).not.toBeNull();
    expect(owner!.ownerNid).toBe('Eirika');
    expect(owner!.droppable).toBe(false);
  });

  test('overflowing a player killer inventory sends the drop to the convoy instead', async ({ page }) => {
    await page.goto('/?harness=true&level=DEBUG&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 5);

    await giveItem(page, 'Bone', 'Elixir');
    await markDroppable(page, 'Bone', 'Elixir');

    // Fill Eirika's non-accessory inventory to the num_items limit (default 5),
    // including her equipped bow, so there's no room left for the drop.
    await giveItem(page, 'Eirika', 'Iron_Bow');
    await equipItem(page, 'Eirika', 'Iron_Bow');
    await giveItem(page, 'Eirika', 'Slim_Sword');
    await giveItem(page, 'Eirika', 'Iron_Sword');
    await giveItem(page, 'Eirika', 'Steel_Sword');

    await forceRngMode(page, 'grandmaster');
    await setUnitHp(page, 'Bone', 1);

    const result = await resolveCombat(page, 'Eirika', 'Bone');
    expect(result).not.toBeNull();
    expect(result.defenderDead).toBe(true);

    const owner = await getItemOwner(page, 'Elixir');
    expect(owner).not.toBeNull();
    expect(owner!.inConvoy).toBe(true);
    expect(owner!.ownerNid).toBeNull();
    expect(owner!.droppable).toBe(false);
  });

  test('an enemy killing a player unit loots the droppable item (no team gate in Python)', async ({ page }) => {
    await page.goto('/?harness=true&level=DEBUG&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 5);

    await giveItem(page, 'Eirika', 'Elixir');
    await markDroppable(page, 'Eirika', 'Elixir');

    await giveItem(page, 'Bone', 'Iron_Bow');
    await equipItem(page, 'Bone', 'Iron_Bow');
    await forceRngMode(page, 'grandmaster');
    await setUnitHp(page, 'Eirika', 1);

    const result = await resolveCombat(page, 'Bone', 'Eirika');
    expect(result).not.toBeNull();
    expect(result.defenderDead).toBe(true);

    const owner = await getItemOwner(page, 'Elixir');
    expect(owner).not.toBeNull();
    expect(owner!.ownerNid).toBe('Bone');
    expect(owner!.droppable).toBe(false);
  });

  test('turnwheel undo returns the item to the dead unit and restores droppable', async ({ page }) => {
    await page.goto('/?harness=true&level=DEBUG&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 5);

    await giveItem(page, 'Bone', 'Elixir');
    await markDroppable(page, 'Bone', 'Elixir');

    await giveItem(page, 'Eirika', 'Iron_Bow');
    await equipItem(page, 'Eirika', 'Iron_Bow');
    await forceRngMode(page, 'grandmaster');
    await setUnitHp(page, 'Bone', 1);

    await resolveCombat(page, 'Eirika', 'Bone');
    const afterKill = await getItemOwner(page, 'Elixir');
    expect(afterKill!.ownerNid).toBe('Eirika');
    expect(afterKill!.droppable).toBe(false);

    // Undo the pickup transfer, then the droppable-flag clear.
    expect(await turnwheelUndo(page)).toBe(true);
    expect(await turnwheelUndo(page)).toBe(true);

    const restored = await getItemOwner(page, 'Elixir');
    expect(restored).not.toBeNull();
    expect(restored!.ownerNid).toBe('Bone');
    expect(restored!.droppable).toBe(true);
  });

  test('save/load round-trips a droppable pickup', async ({ page }) => {
    await page.goto('/?harness=true&level=DEBUG&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 5);

    await giveItem(page, 'Bone', 'Elixir');
    await markDroppable(page, 'Bone', 'Elixir');

    await giveItem(page, 'Eirika', 'Iron_Bow');
    await equipItem(page, 'Eirika', 'Iron_Bow');
    await forceRngMode(page, 'grandmaster');
    await setUnitHp(page, 'Bone', 1);

    await resolveCombat(page, 'Eirika', 'Bone');
    const beforeSave = await getItemOwner(page, 'Elixir');
    expect(beforeSave!.ownerNid).toBe('Eirika');
    expect(beforeSave!.droppable).toBe(false);

    const snapshot = await saveSnapshot(page);

    // Mutate away from the saved state (undo the pickup).
    await turnwheelUndo(page);
    await turnwheelUndo(page);
    const mutated = await getItemOwner(page, 'Elixir');
    expect(mutated!.ownerNid).toBe('Bone');

    const loaded = await loadSnapshot(page, snapshot);
    expect(loaded).toBe(true);
    await stepFrames(page, 2);

    const restored = await getItemOwner(page, 'Elixir');
    expect(restored).not.toBeNull();
    expect(restored!.ownerNid).toBe('Eirika');
    expect(restored!.droppable).toBe(false);
  });
});
