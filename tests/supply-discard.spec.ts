/**
 * Supply/convoy and item_discard state parity tests.
 *
 * Ports lt-maker's supply_items (prep.PrepItemsState) and item_discard
 * (general_states.ItemDiscardState) player states. See PLAN.md for the
 * tracked rows and src/engine/states/supply-state.ts for the implementation.
 *
 * Deviations from Python (documented in PLAN.md): the supply screen is a
 * single flat sorted give/take list rather than the multi-tab convoy menu,
 * and prep/base entry uses the first living party unit rather than the
 * per-unit Manage flow.
 */

import { test, expect } from '@playwright/test';

async function waitForHarness(page: any) {
  await page.waitForFunction(
    () => (window as any).__harness?.ready === true,
    { timeout: 60_000 },
  );
}

async function stepFrames(page: any, count: number, input?: string | null) {
  await page.evaluate(
    ({ count, input }: { count: number; input: string | null }) => {
      (window as any).__harness.stepFrames(count, input);
    },
    { count, input: input ?? null },
  );
}

async function getState(page: any) {
  return page.evaluate(() => (window as any).__harness.getState());
}

test.describe('Supply/convoy and item_discard states', () => {
  test('Supply is reachable from the prep menu when _convoy is enabled', async ({ page }) => {
    await page.goto('/?harness=true&level=0&clean=true&bundle=false');
    await waitForHarness(page);

    const setup = await page.evaluate(() => {
      const game = (window as any).__gameRef;
      game.gameVars.set('_convoy', true);
      game.state.change('prep_main');
      return { ok: true };
    });
    expect(setup.ok).toBe(true);

    await stepFrames(page, 2);
    expect((await getState(page)).currentStateName).toBe('prep_main');

    // Python route: Prep -> Manage -> first unit -> Supply.
    await stepFrames(page, 1, 'DOWN');
    await stepFrames(page, 1, 'SELECT');
    await stepFrames(page, 2);
    expect((await getState(page)).currentStateName).toBe('base_manage');
    await stepFrames(page, 1, 'SELECT');
    await stepFrames(page, 1, 'DOWN');
    await stepFrames(page, 1, 'SELECT');
    await stepFrames(page, 2);
    expect((await getState(page)).currentStateName).toBe('supply_items');

    // Cancel unwinds Supply -> Manage options -> unit list -> prep.
    await stepFrames(page, 1, 'BACK');
    await stepFrames(page, 2);
    await stepFrames(page, 1, 'BACK');
    await stepFrames(page, 1, 'BACK');
    await stepFrames(page, 2);
    expect((await getState(page)).currentStateName).toBe('prep_main');
  });

  test('Supply is reachable from the base menu when _convoy is enabled', async ({ page }) => {
    await page.goto('/?harness=true&level=0&clean=true&bundle=false');
    await waitForHarness(page);

    await page.evaluate(() => {
      const game = (window as any).__gameRef;
      game.gameVars.set('_convoy', true);
      game.state.change('base_main');
    });

    await stepFrames(page, 2);
    expect((await getState(page)).currentStateName).toBe('base_main');

    // Python route: Base -> Manage -> first unit -> Supply.
    await stepFrames(page, 1, 'SELECT');
    await stepFrames(page, 2);
    expect((await getState(page)).currentStateName).toBe('base_manage');
    await stepFrames(page, 1, 'SELECT');
    await stepFrames(page, 1, 'DOWN');
    await stepFrames(page, 1, 'SELECT');
    await stepFrames(page, 2);
    expect((await getState(page)).currentStateName).toBe('supply_items');

    await stepFrames(page, 1, 'BACK');
    await stepFrames(page, 2);
    await stepFrames(page, 1, 'BACK');
    await stepFrames(page, 1, 'BACK');
    await stepFrames(page, 2);
    expect((await getState(page)).currentStateName).toBe('base_main');
  });

  test('give/take round trip goes through reversible actions and undoes exactly', async ({ page }) => {
    await page.goto('/?harness=true&level=0&clean=true&bundle=false');
    await waitForHarness(page);

    const setup = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { ItemObject } = await import('/src/objects/item.ts');
      const unit = game.units.get('Eirika');
      const party = game.getParty();
      if (!unit || !party) return null;

      game.gameVars.set('_convoy', true);
      unit.items = [];
      const ironSword = new ItemObject(game.db.items.get('Iron_Sword'));
      ironSword.owner = unit;
      unit.items.push(ironSword);

      party.convoy.length = 0;
      const vulnerary = new ItemObject(game.db.items.get('Vulnerary'));
      party.convoy.push(vulnerary);

      const beforeActionIndex = game.actionLog.actionIndex;
      game.memory.set('supply_unit', unit);
      game.state.change('supply_items');
      return {
        unitNid: unit.nid,
        beforeActionIndex,
        beforeUnitItems: unit.items.map((i: any) => i.nid),
        beforeConvoy: party.convoy.map((i: any) => i.nid),
      };
    });
    expect(setup).not.toBeNull();

    await stepFrames(page, 2);
    expect((await getState(page)).currentStateName).toBe('supply_items');

    // Row 0 is "Give Iron_Sword": give it to the convoy.
    await stepFrames(page, 1, 'SELECT');
    await stepFrames(page, 1);
    const afterGive = await page.evaluate(({ unitNid }) => {
      const game = (window as any).__gameRef;
      const unit = game.units.get(unitNid);
      return {
        unitItems: unit.items.map((i: any) => i.nid),
        convoy: game.getParty().convoy.map((i: any) => i.nid),
      };
    }, { unitNid: setup!.unitNid });
    expect(afterGive.unitItems).toEqual([]);
    expect(afterGive.convoy.sort()).toEqual(['Iron_Sword', 'Vulnerary']);

    // Now both items are Take rows; take the first (Iron_Sword sorts before
    // Vulnerary: weapons first).
    await stepFrames(page, 1, 'SELECT');
    await stepFrames(page, 1);
    const afterTake = await page.evaluate(({ unitNid }) => {
      const game = (window as any).__gameRef;
      const unit = game.units.get(unitNid);
      return {
        unitItems: unit.items.map((i: any) => i.nid),
        convoy: game.getParty().convoy.map((i: any) => i.nid),
      };
    }, { unitNid: setup!.unitNid });
    expect(afterTake.unitItems).toEqual(['Iron_Sword']);
    expect(afterTake.convoy).toEqual(['Vulnerary']);

    // Undo both actions restores the original layout exactly.
    const restored = await page.evaluate(({ unitNid, beforeActionIndex }) => {
      const game = (window as any).__gameRef;
      const log = game.actionLog;
      for (let i = 0; i < 20 && log.actionIndex > beforeActionIndex; i++) log.undo();
      const unit = game.units.get(unitNid);
      return {
        unitItems: unit.items.map((i: any) => i.nid),
        convoy: game.getParty().convoy.map((i: any) => i.nid),
      };
    }, { unitNid: setup!.unitNid, beforeActionIndex: setup!.beforeActionIndex });
    expect(restored.unitItems).toEqual(setup!.beforeUnitItems);
    expect(restored.convoy).toEqual(setup!.beforeConvoy);
  });

  test('take from convoy is a no-op when the unit is at capacity', async ({ page }) => {
    await page.goto('/?harness=true&level=0&clean=true&bundle=false');
    await waitForHarness(page);

    const setup = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { ItemObject } = await import('/src/objects/item.ts');
      const unit = game.units.get('Eirika');
      const party = game.getParty();
      if (!unit || !party) return null;

      game.gameVars.set('_convoy', true);
      const numItems = Number(game.db.getConstant('num_items', 5));
      unit.items = [];
      for (let i = 0; i < numItems; i++) {
        const item = new ItemObject(game.db.items.get('Iron_Sword'));
        item.owner = unit;
        unit.items.push(item);
      }
      party.convoy.length = 0;
      party.convoy.push(new ItemObject(game.db.items.get('Vulnerary')));

      game.memory.set('supply_unit', unit);
      game.state.change('supply_items');
      return { unitNid: unit.nid, numItems };
    });
    expect(setup).not.toBeNull();

    await stepFrames(page, 2);
    expect((await getState(page)).currentStateName).toBe('supply_items');

    // The take row (last row) is disabled; even forcing selection onto it
    // and pressing SELECT must not transfer.
    const attempted = await page.evaluate(({ unitNid }) => {
      const game = (window as any).__gameRef;
      const state = game.state.getCurrentState();
      const menu = (state as any).menu;
      menu.selectedIndex = menu.options.length - 1; // the Take Vulnerary row
      const takeRowEnabled = menu.options[menu.options.length - 1].enabled;
      state.takeInput('SELECT');
      const unit = game.units.get(unitNid);
      return {
        takeRowEnabled,
        unitItemCount: unit.items.length,
        convoyCount: game.getParty().convoy.length,
      };
    }, { unitNid: setup!.unitNid });
    expect(attempted.takeRowEnabled).toBe(false);
    expect(attempted.unitItemCount).toBe(setup!.numItems);
    expect(attempted.convoyCount).toBe(1);
  });

  test('over-capacity combat pickup force-adds and routes through forced item_discard to convoy', async ({ page }) => {
    await page.goto('/?harness=true&level=0&clean=true&bundle=false');
    await waitForHarness(page);

    const setup = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { ItemObject } = await import('/src/objects/item.ts');
      const { applyDroppableItemPickups } = await import('/src/combat/combat-lifecycle.ts');
      const killer = game.units.get('Eirika');
      const victim = game.units.get('Seth');
      const party = game.getParty();
      if (!killer || !victim || !party) return null;

      game.gameVars.set('_convoy', true);
      // Give the killer convoy access on the map so item_discard resolves to
      // STORAGE mode (Python SupplyAbility gate via the Convoy tag).
      if (!killer.tags.includes('Convoy')) killer.tags.push('Convoy');

      const numItems = Number(game.db.getConstant('num_items', 5));
      killer.items = [];
      for (let i = 0; i < numItems; i++) {
        const item = new ItemObject(game.db.items.get('Iron_Sword'));
        item.owner = killer;
        killer.items.push(item);
      }
      party.convoy.length = 0;

      const drop = new ItemObject(game.db.items.get('Vulnerary'));
      drop.owner = victim;
      drop.droppable = true;
      victim.items = [drop];

      const results = { droppedItems: [{ unit: victim, item: drop }] };
      const pickup = applyDroppableItemPickups(
        game.actionLog, game.db, results as any, killer, null,
      );

      // Mirror CombatState cleanup: queue pending discards and push the state.
      if (pickup.pendingDiscards.length > 0) {
        game.memory.set('item_discard_queue', pickup.pendingDiscards);
        game.state.change('item_discard');
      }

      return {
        killerNid: killer.nid,
        numItems,
        banners: pickup.banners,
        pendingCount: pickup.pendingDiscards.length,
        killerItemCount: killer.items.length,
        dropDroppable: drop.droppable,
      };
    });
    expect(setup).not.toBeNull();
    // Force-added over capacity, with the acquired banner (not sent-to-convoy).
    expect(setup!.pendingCount).toBe(1);
    expect(setup!.killerItemCount).toBe(setup!.numItems + 1);
    expect(setup!.banners).toEqual(['Eirika got a Vulnerary.']);
    expect(setup!.dropDroppable).toBe(false);

    await stepFrames(page, 2);
    expect((await getState(page)).currentStateName).toBe('item_discard');

    // Cannot cancel while over capacity.
    await stepFrames(page, 1, 'BACK');
    await stepFrames(page, 2);
    expect((await getState(page)).currentStateName).toBe('item_discard');

    // The newly gained item is locked (force_give) and cannot be chosen.
    const lockInfo = await page.evaluate(() => {
      const game = (window as any).__gameRef;
      const state = game.state.getCurrentState();
      const menu = (state as any).menu;
      return {
        lastRowEnabled: menu.options[menu.options.length - 1].enabled,
        firstRowEnabled: menu.options[0].enabled,
      };
    });
    expect(lockInfo.lastRowEnabled).toBe(false); // the new Vulnerary
    expect(lockInfo.firstRowEnabled).toBe(true);

    // Choose the first Iron_Sword: STORAGE mode sends it to the convoy and
    // the state resolves itself.
    await stepFrames(page, 1, 'SELECT');
    await stepFrames(page, 2);

    const outcome = await page.evaluate(({ killerNid }) => {
      const game = (window as any).__gameRef;
      const killer = game.units.get(killerNid);
      return {
        state: game.state.getCurrentState()?.name,
        killerItems: killer.items.map((i: any) => i.nid),
        convoy: game.getParty().convoy.map((i: any) => i.nid),
      };
    }, { killerNid: setup!.killerNid });
    expect(outcome.state).not.toBe('item_discard');
    expect(outcome.killerItems).toEqual([
      'Iron_Sword', 'Iron_Sword', 'Iron_Sword', 'Iron_Sword', 'Vulnerary',
    ]);
    expect(outcome.convoy).toEqual(['Iron_Sword']);
  });

  test('convoy transfers survive a save/load round trip', async ({ page }) => {
    await page.goto('/?harness=true&level=0&clean=true&bundle=false');
    await waitForHarness(page);

    const setup = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { ItemObject } = await import('/src/objects/item.ts');
      const { StoreItemAction, TakeItemFromConvoy } = await import('/src/engine/action.ts');
      const unit = game.units.get('Eirika');
      const party = game.getParty();
      if (!unit || !party) return null;

      game.gameVars.set('_convoy', true);
      unit.items = [];
      const ironSword = new ItemObject(game.db.items.get('Iron_Sword'));
      ironSword.owner = unit;
      unit.items.push(ironSword);
      party.convoy.length = 0;
      const vulnerary = new ItemObject(game.db.items.get('Vulnerary'));
      party.convoy.push(vulnerary);

      // Transfer both directions through the reversible actions.
      game.actionLog.doAction(new StoreItemAction(unit, ironSword));
      game.actionLog.doAction(new TakeItemFromConvoy(unit, vulnerary));

      return {
        unitNid: unit.nid,
        unitItems: unit.items.map((i: any) => i.nid),
        convoy: party.convoy.map((i: any) => i.nid),
      };
    });
    expect(setup).not.toBeNull();
    expect(setup!.unitItems).toEqual(['Vulnerary']);
    expect(setup!.convoy).toEqual(['Iron_Sword']);

    const roundTrip = await page.evaluate(async ({ unitNid }) => {
      const game = (window as any).__gameRef;
      const snapshot = (window as any).__harness.saveSnapshot();
      const ok = await (window as any).__harness.loadSnapshot(snapshot);
      const unit = game.units.get(unitNid);
      return {
        ok,
        unitItems: unit.items.map((i: any) => i.nid),
        convoy: game.getParty().convoy.map((i: any) => i.nid),
      };
    }, { unitNid: setup!.unitNid });

    expect(roundTrip.ok).toBe(true);
    expect(roundTrip.unitItems).toEqual(setup!.unitItems);
    expect(roundTrip.convoy).toEqual(setup!.convoy);
  });
});
