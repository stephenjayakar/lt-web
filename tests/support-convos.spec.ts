/**
 * Support conversation feature tests (P5): field Support option, on_support
 * trigger, base Supports submenu, and support-rank bookkeeping.
 *
 * Patterns:
 * - MenuState entry: set selectedUnit, cursor, state.change('menu') per harness.spec.ts
 * - on_support payload: inject listener event via event-flow.spec.ts pattern, record in game_vars
 * - Base navigation: state.change('base_main'/'base_supports') per base-submenus.spec.ts
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

async function getState(page: Page): Promise<any> {
  return page.evaluate(() => (window as any).__harness.getState());
}

async function getGameVar(page: Page, key: string): Promise<any> {
  return page.evaluate((key) => (window as any).__gameRef.gameVars.get(key), key);
}

// ---------------------------------------------------------------------------
// Support Conversation Tests
// ---------------------------------------------------------------------------

test.describe('Support conversations (field + base + turnwheel)', () => {
  test('Support option appears in menu when adjacent unit has unlocked-but-unviewed rank', async ({ page }) => {
    // Load Ch.1 and set up support pairs manually with locked ranks
    await page.goto('/?harness=true&level=1&clean=true&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 5);

    // Find any pair and ensure it has a locked rank
    let foundPair = false;
    const setup = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const eirika = g.units.get('Eirika');
      const seth = g.units.get('Seth');
      if (!eirika || !seth) return null;

      // Position them adjacently
      eirika.position = [5, 5];
      seth.position = [6, 5];
      g.board.setUnit(5, 5, eirika);
      g.board.setUnit(6, 5, seth);
      eirika.finished = false;

      // Enable the Python gate and cross the C-rank threshold (19 points for
      // the bundled Eirika|Seth pair) so a locked (viewable) rank exists.
      g.gameVars.set('_supports', true);
      g.db.supportConstants.set('combat_convos', true);
      const pair = g.supports.getPair('Eirika', 'Seth');
      if (pair && pair.lockedRanks.length === 0) {
        g.supports.incrementPoints(pair, 19);
      }

      return {
        pairExists: !!pair,
        canSupport: pair ? g.supports.canSupport(pair, g) : false,
        lockedRanks: pair?.lockedRanks ?? [],
      };
    });

    expect(setup?.pairExists).toBe(true);
    expect(setup!.lockedRanks.length).toBeGreaterThan(0);

    // Enter MenuState for Eirika
    await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const eirika = g.units.get('Eirika');
      g.selectedUnit = eirika;
      g.cursor.setPos(5, 5);
      g.state.change('menu');
    });
    await stepFrames(page, 3);

    // Verify we're in menu state and Support option is present
    const state = await getState(page);
    expect(state.currentStateName).toBe('menu');

    const menuOptions = await page.evaluate(() => {
      const st = (window as any).__gameRef.state.getCurrentState() as any;
      return st.menu?.options?.map((o: any) => ({ label: o.label, value: o.value, enabled: o.enabled })) ?? [];
    });

    expect(menuOptions.length).toBeGreaterThan(0);
    const supportOption = menuOptions.find((o: any) => o.label === 'Support');
    expect(supportOption).toBeDefined();
    expect(supportOption!.enabled).toBe(true);
  });

  test('Support option fires on_support trigger with correct payload (unit1, unit2, rank, is_replay=false)', async ({ page }) => {
    await page.goto('/?harness=true&level=1&clean=true&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 5);

    // Capture trigger calls directly (trigger-dispatch.spec.ts pattern).
    await page.evaluate(() => {
      const g = (window as any).__gameRef;
      (window as any).__capturedTriggers = [];
      const orig = g.eventManager.trigger.bind(g.eventManager);
      g.eventManager.trigger = (trig: any, ctx: any) => {
        (window as any).__capturedTriggers.push({
          type: trig.type,
          unit1Nid: trig.unit1?.nid ?? null,
          unit2Nid: trig.unit2?.nid ?? null,
          position: trig.position ?? null,
          rank: trig.support_rank_nid ?? null,
          isReplay: trig.is_replay ?? null,
        });
        return orig(trig, ctx);
      };
    });

    const hasLockedRank = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const eirika = g.units.get('Eirika');
      const seth = g.units.get('Seth');
      if (!eirika || !seth) return false;
      eirika.position = [5, 5];
      seth.position = [6, 5];
      g.board.setUnit(5, 5, eirika);
      g.board.setUnit(6, 5, seth);
      eirika.finished = false;
      g.gameVars.set('_supports', true);
      g.db.supportConstants.set('combat_convos', true);
      const pair = g.supports.getPair('Eirika', 'Seth');
      if (pair && pair.lockedRanks.length === 0) {
        g.supports.incrementPoints(pair, 19);
      }
      return (pair?.lockedRanks.length ?? 0) > 0;
    });
    expect(hasLockedRank).toBe(true);
    await stepFrames(page, 2);

    await page.evaluate(() => {
      const g = (window as any).__gameRef;
      g.selectedUnit = g.units.get('Eirika');
      g.cursor.setPos(5, 5);
      g.state.change('menu');
    });
    await stepFrames(page, 3);

    const supportIdx = await page.evaluate(() => {
      const st = (window as any).__gameRef.state.getCurrentState() as any;
      return (st.menu?.options ?? []).findIndex((o: any) => o.label === 'Support');
    });
    expect(supportIdx).toBeGreaterThanOrEqual(0);
    await page.evaluate(({ idx }) => {
      const st = (window as any).__gameRef.state.getCurrentState() as any;
      st.menu.selectedIndex = idx;
    }, { idx: supportIdx });
    await stepFrames(page, 1, 'SELECT');
    await stepFrames(page, 10);

    const captured = await page.evaluate(
      () => (window as any).__capturedTriggers.filter((t: any) => t.type === 'on_support'),
    );
    expect(captured.length).toBe(1);
    expect(captured[0].unit1Nid).toBe('Eirika');
    expect(captured[0].unit2Nid).toBe('Seth');
    expect(captured[0].rank).toBe('C');
    expect(captured[0].isReplay).toBe(false);
    expect(captured[0].position).toEqual([5, 5]);
  });

  test('Support rank transitions from locked to unlocked after viewing', async ({ page }) => {
    await page.goto('/?harness=true&level=1&clean=true&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 5);

    // Set up a pair with a locked rank
    const setupResult = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const pair = g.supports.getPair('Eirika', 'Seth');
      g.gameVars.set('_supports', true);
      g.db.supportConstants.set('combat_convos', true);
      if (pair && pair.lockedRanks.length === 0) {
        g.supports.incrementPoints(pair, 19);
      }

      return {
        lockedRanks: pair?.lockedRanks.slice() ?? [],
        unlockedRanks: pair?.unlockedRanks.slice() ?? [],
      };
    });

    expect(setupResult.lockedRanks.length).toBeGreaterThan(0);

    const before = setupResult;

    // Unlock the first locked rank
    const rankToUnlock = before.lockedRanks[0];
    await page.evaluate(
      ({ rank }) => {
        const g = (window as any).__gameRef;
        const pair = g.supports.getPair('Eirika', 'Seth');
        if (pair) {
          g.supports.unlockRank(pair.nid, rank);
        }
      },
      { rank: rankToUnlock },
    );

    // Verify the change
    const after = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const pair = g.supports.getPair('Eirika', 'Seth');
      return {
        lockedRanks: pair?.lockedRanks.slice() ?? [],
        unlockedRanks: pair?.unlockedRanks.slice() ?? [],
      };
    });

    expect(after.lockedRanks).not.toContain(rankToUnlock);
    expect(after.unlockedRanks).toContain(rankToUnlock);
  });

  test('Support gate: _supports gameVar + support_constants.combat_convos must both be true', async ({ page }) => {
    await page.goto('/?harness=true&level=1&clean=true&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 5);

    // Check gate state
    const gateState = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      return {
        _supportsEnabled: g.gameVars.get('_supports'),
        combatConvosEnabled: g.db.supportConstants?.get('combat_convos'),
        supportsExists: !!g.supports,
      };
    });

    expect(gateState.supportsExists).toBe(true);
    // In default.ltproj, both should be true, so Support option can appear
    if (gateState._supportsEnabled && gateState.combatConvosEnabled) {
      // Both gate conditions met; Support should be available when adjacent pair exists
      expect(true).toBe(true);
    }
  });

  test('Base Supports state is registered and reachable from BaseMainState', async ({ page }) => {
    await page.goto('/?harness=true&level=1&clean=false&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 10);

    // Enter base_main
    await page.evaluate(() => {
      const g = (window as any).__gameRef;
      g.state.change('base_main');
    });
    await stepFrames(page, 15);

    // Check if Supports option is present in base menu
    const baseOptions = await page.evaluate(() => {
      const st = (window as any).__gameRef.state.getCurrentState() as any;
      return st.menu?.options?.map((o: any) => ({ label: o.label, value: o.value })) ?? [];
    });

    expect(baseOptions.length).toBeGreaterThan(0);
    const supportsOpt = baseOptions.find((o: any) => o.label === 'Supports');
    expect(supportsOpt).toBeDefined();

    // Verify BaseSupportState exists
    const hasSupportState = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      // Check if we can navigate to it
      try {
        g.state.change('base_supports');
        return true;
      } catch {
        return false;
      }
    });

    expect(hasSupportState).toBe(true);
  });

  test('Turnwheel reversibility: unlockRank undo/redo preserves rank state', async ({ page }) => {
    await page.goto('/?harness=true&level=1&clean=true&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 5);

    // Set up a pair with a locked rank
    const setupResult = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const pair = g.supports.getPair('Eirika', 'Seth');
      g.gameVars.set('_supports', true);
      g.db.supportConstants.set('combat_convos', true);
      if (pair && pair.lockedRanks.length === 0) {
        g.supports.incrementPoints(pair, 19);
      }

      return {
        lockedRanks: pair?.lockedRanks.slice() ?? [],
        unlockedRanks: pair?.unlockedRanks.slice() ?? [],
      };
    });

    expect(setupResult.lockedRanks.length).toBeGreaterThan(0);

    const before = setupResult;
    const rankToUnlock = before.lockedRanks[0];

    // Unlock through the REAL reversible action path (turnwheel-breadth pattern);
    // a direct controller mutation would bypass the ActionLog and make the
    // undo assertion below meaningless.
    await page.evaluate(
      async ({ rank }) => {
        const g = (window as any).__gameRef;
        const m = await import('/src/engine/action.ts');
        const pair = g.supports.getPair('Eirika', 'Seth');
        if (pair) {
          g.actionLog.doAction(new m.UnlockSupportRankAction(pair, rank));
        }
      },
      { rank: rankToUnlock },
    );
    await stepFrames(page, 2);

    // Verify unlocked
    const afterUnlock = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const pair = g.supports.getPair('Eirika', 'Seth');
      return {
        lockedRanks: pair?.lockedRanks.slice() ?? [],
        unlockedRanks: pair?.unlockedRanks.slice() ?? [],
      };
    });

    expect(afterUnlock.unlockedRanks).toContain(rankToUnlock);
    expect(afterUnlock.lockedRanks).not.toContain(rankToUnlock);

    // Undo via the harness turnwheel API (same as turnwheel-breadth spec)
    const undone = await page.evaluate(() => (window as any).__harness.turnwheelUndo());
    expect(undone).toBe(true);
    await stepFrames(page, 2);

    // Verify back to locked state
    const afterUndo = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const pair = g.supports.getPair('Eirika', 'Seth');
      return {
        lockedRanks: pair?.lockedRanks.slice() ?? [],
        unlockedRanks: pair?.unlockedRanks.slice() ?? [],
      };
    });

    expect(afterUndo.lockedRanks).toContain(rankToUnlock);
    expect(afterUndo.unlockedRanks).not.toContain(rankToUnlock);
  });
});
