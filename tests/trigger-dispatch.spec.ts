/**
 * Parity coverage for the newly-wired event triggers (docs/parity/
 * runtime-inventory.md §1): unit_wait, unit_select, unit_deselect,
 * on_prep_start, on_base_start.
 *
 * Strategy: monkey-patch game.eventManager.trigger to record every call's
 * trigger object (type/unitNid/position/region/localArgs), then drive the
 * real UI flow (cursor select, menu Wait, cancel-back) or push the prep/base
 * states directly, and assert on what was captured.
 *
 * on_support and during_unit_level_up are intentionally NOT covered here —
 * see PLAN.md / runtime-inventory.md for the deferral notes (no support
 * conversation UI exists yet in the web port; during_unit_level_up has no
 * clean event-pump seam in the CombatState level-up animation).
 */

import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';

async function waitForHarness(page: Page): Promise<void> {
  await page.waitForFunction(() => !!(window as any).__harness?.ready, { timeout: 15000 });
}

async function stepFrames(page: Page, count: number, input?: string | null): Promise<void> {
  await page.evaluate(
    ({ count, input }) => (window as any).__harness.stepFrames(count, input ?? null),
    { count, input: input ?? null },
  );
}

/** Install a capture hook on game.eventManager.trigger; returns nothing, use readCaptured() to inspect. */
async function installCapture(page: Page): Promise<void> {
  await page.evaluate(() => {
    const g = (window as any).__gameRef;
    (window as any).__captured = [];
    const orig = g.eventManager.trigger.bind(g.eventManager);
    g.eventManager.trigger = (trig: any, ctx: any) => {
      (window as any).__captured.push({
        type: trig.type,
        unitNid: trig.unitNid,
        position: trig.position,
        regionNid: trig.region?.nid ?? null,
        activelyChosen: trig.localArgs?.get('actively_chosen') ?? null,
        supportRankNid: trig.localArgs?.get('support_rank_nid') ?? null,
        source: trig.source ?? null,
        statChanges: trig.statChanges ?? null,
      });
      return orig(trig, ctx);
    };
  });
}

async function readCaptured(page: Page): Promise<any[]> {
  return page.evaluate(() => (window as any).__captured ?? []);
}

/** Register a level-scoped test event for the given trigger type, so triggering
 * queues a real GameEvent (exercising the full match/dispatch path, not just
 * the capture hook). Uses a single no-op `wait` command so the event doesn't
 * finish instantly. */
async function installTestEvent(page: Page, nid: string, triggerType: string): Promise<void> {
  await page.evaluate(
    ({ nid, triggerType }) => {
      const g = (window as any).__gameRef;
      g.db.events.set(nid, {
        name: nid,
        nid,
        trigger: triggerType,
        level_nid: g.currentLevel?.nid ?? null,
        condition: 'True',
        only_once: false,
        priority: 0,
        _source: ['wait;1'],
      });
    },
    { nid, triggerType },
  );
}

test.describe('Trigger dispatch parity', () => {
  test('unit_wait fires with actively_chosen=true and no region on explicit player Wait', async ({ page }) => {
    await page.goto('/?harness=true&level=DEBUG&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 5);
    await installCapture(page);
    await installTestEvent(page, 'TestUnitWait1', 'unit_wait');

    // Eirika starts at [2, 6] in DEBUG.json, not on a region tile.
    await page.evaluate(() => {
      const g = (window as any).__gameRef;
      g.cursor.setPos(2, 6);
    });

    // Select the unit (free -> move)
    await stepFrames(page, 1, 'SELECT');
    let state = await page.evaluate(() => (window as any).__gameRef.state.getCurrentState()?.name);
    expect(state).toBe('move');

    // Confirm staying in place (move -> menu). MenuState populates its
    // options one frame after the transition (begin() runs on the *next*
    // update() call), so settle with an extra no-input frame.
    await stepFrames(page, 1, 'SELECT');
    await stepFrames(page, 1, null);
    state = await page.evaluate(() => (window as any).__gameRef.state.getCurrentState()?.name);
    expect(state).toBe('menu');

    // Force the menu cursor onto the 'wait' option and confirm.
    const waitIndex: number = await page.evaluate(() => {
      const st = (window as any).__gameRef.state.getCurrentState();
      const idx = st.menu.options.findIndex((o: any) => o.value === 'wait');
      st.menu.selectedIndex = idx;
      return idx;
    });
    expect(waitIndex).toBeGreaterThanOrEqual(0);
    await stepFrames(page, 1, 'SELECT');

    const captured = await readCaptured(page);
    const waitEvents = captured.filter((c) => c.type === 'unit_wait');
    expect(waitEvents.length).toBeGreaterThanOrEqual(1);
    const ev = waitEvents[0];
    expect(ev.unitNid).toBe('Eirika');
    expect(ev.position).toEqual([2, 6]);
    expect(ev.activelyChosen).toBe(true);
    expect(ev.regionNid).toBeNull();
  });

  test('unit_wait fires with region payload when the unit is standing on a region', async ({ page }) => {
    await page.goto('/?harness=true&level=DEBUG&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 5);
    await installCapture(page);

    // Teleport Eirika onto the Armory region [5, 7] before selecting.
    await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const unit = g.units.get('Eirika');
      g.board.moveUnit(unit, 5, 7);
      g.cursor.setPos(5, 7);
    });

    await stepFrames(page, 1, 'SELECT'); // free -> move
    await stepFrames(page, 1, 'SELECT'); // move -> menu (stay in place)
    await stepFrames(page, 1, null); // let MenuState.begin() populate options

    const waitIndex: number = await page.evaluate(() => {
      const st = (window as any).__gameRef.state.getCurrentState();
      const idx = st.menu.options.findIndex((o: any) => o.value === 'wait');
      st.menu.selectedIndex = idx;
      return idx;
    });
    expect(waitIndex).toBeGreaterThanOrEqual(0);
    await stepFrames(page, 1, 'SELECT');

    const captured = await readCaptured(page);
    const waitEvents = captured.filter((c) => c.type === 'unit_wait');
    expect(waitEvents.length).toBeGreaterThanOrEqual(1);
    expect(waitEvents[0].regionNid).toBe('Armory');
  });

  test('unit_select fires on cursor select and unit_deselect fires on cancel-back', async ({ page }) => {
    await page.goto('/?harness=true&level=DEBUG&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 5);
    await installCapture(page);
    await installTestEvent(page, 'TestUnitSelect1', 'unit_select');
    await installTestEvent(page, 'TestUnitDeselect1', 'unit_deselect');

    await page.evaluate(() => {
      const g = (window as any).__gameRef;
      g.cursor.setPos(2, 6); // Eirika
    });

    await stepFrames(page, 1, 'SELECT'); // free -> move (unit_select fires; the
    // injected TestUnitSelect1 event queues, so 'event' gets pushed on top of 'move').
    let state = await page.evaluate(() => (window as any).__gameRef.state.getCurrentState()?.name);
    expect(state).toBe('event');

    let captured = await readCaptured(page);
    const selectEvents = captured.filter((c) => c.type === 'unit_select');
    expect(selectEvents.length).toBe(1);
    expect(selectEvents[0].unitNid).toBe('Eirika');
    expect(selectEvents[0].position).toEqual([2, 6]);

    // Flush the injected event's single `wait;1` command so it pops back to
    // 'move'. Poll one SELECT at a time and stop as soon as we leave 'event'
    // to avoid overshooting into the action menu.
    for (let i = 0; i < 10; i++) {
      state = await page.evaluate(() => (window as any).__gameRef.state.getCurrentState()?.name);
      if (state !== 'event') break;
      await stepFrames(page, 1, 'SELECT');
    }
    state = await page.evaluate(() => (window as any).__gameRef.state.getCurrentState()?.name);
    expect(state).toBe('move');

    // BACK cancels the move -> back to free, firing unit_deselect (which then
    // queues TestUnitDeselect1, pushing 'event' again on top of 'free').
    await stepFrames(page, 1, 'BACK');
    state = await page.evaluate(() => (window as any).__gameRef.state.getCurrentState()?.name);
    expect(state).toBe('event');

    captured = await readCaptured(page);
    const deselectEvents = captured.filter((c) => c.type === 'unit_deselect');
    expect(deselectEvents.length).toBe(1);
    expect(deselectEvents[0].unitNid).toBe('Eirika');
    expect(deselectEvents[0].position).toEqual([2, 6]);
  });

  test('on_prep_start fires when entering the prep state', async ({ page }) => {
    await page.goto('/?harness=true&level=DEBUG&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 5);
    await installCapture(page);
    await installTestEvent(page, 'TestPrepStart1', 'on_prep_start');

    await page.evaluate(() => {
      const g = (window as any).__gameRef;
      g.state.change('prep_main');
    });
    // state.change() only queues the transition; start()/begin() run on the
    // *next* update() call, so settle with two frames.
    await stepFrames(page, 2);

    const captured = await readCaptured(page);
    const events = captured.filter((c) => c.type === 'on_prep_start');
    expect(events.length).toBe(1);
  });

  test('on_base_start fires when entering the base state', async ({ page }) => {
    await page.goto('/?harness=true&level=DEBUG&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 5);
    await installCapture(page);
    await installTestEvent(page, 'TestBaseStart1', 'on_base_start');

    await page.evaluate(() => {
      const g = (window as any).__gameRef;
      g.state.change('base_main');
    });
    await stepFrames(page, 2);

    const captured = await readCaptured(page);
    const events = captured.filter((c) => c.type === 'on_base_start');
    expect(events.length).toBe(1);
  });
});
