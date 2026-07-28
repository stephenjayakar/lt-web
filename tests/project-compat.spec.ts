/**
 * Non-default project compatibility fixtures (P0 "representative non-default
 * project fixtures" + P7 "validate external projects" rows).
 *
 * Exercises the harness against the two bundled non-default `.ltproj`
 * projects via `?project=<name>.ltproj`:
 *
 *  - `rekka.ltproj` (FE7A): non-chunked data format (single JSON array files,
 *    metadata `as_chunks: false`), 899 EVNT-format events (semicolon
 *    commands with `if`/`elif`/`end` control-flow blocks), 48 levels. Also
 *    the project referenced by the Pair-up/Rescue-fallback parity slice
 *    (PLAN.md) as the classic-Rescue (non-Pair-Up) reference project. Its
 *    `Rescue` staff is a `sequence_item` of `Rescue1`/`Rescue2`, and
 *    `Rescue1` carries the `store_unit` component that drives the classic
 *    rescue-and-warp sequence (game-states.ts ~2510-2530).
 *
 *  - `testing_proj.ltproj` (LT): chunked data format (directory-per-type
 *    with `.orderkeys`, e.g. `game_data/levels/0.json`, `1.json`), also
 *    plain EVNT-format events. Distinctive feature: its Chapter 1
 *    intro event (`1_New_Event.json`) drives the achievements system
 *    (`create_achievement`/`complete_achievement`/`update_achievement`)
 *    end-to-end, including a hidden achievement and a banner-confirmed
 *    completion, then opens the base (`base;Arena`) — landing in the
 *    `prep_main` state. Achievement state is persisted to
 *    `localStorage['lt-achievements-LT']` (records.ts AchievementManager).
 *
 * Both projects use the EVNT (semicolon-command) event format, not PYEV1 —
 * verified directly against their `events.json`/`game_data/events/*.json`
 * (structured `commands` arrays are empty; the real program lives in the
 * `_source` text lines, parsed the same way as default.ltproj).
 *
 * Per PLAN.md "Known Limitations (per-project content)", missing
 * `combat_*.png` panoramas and other per-project asset 404s are EXPECTED
 * for non-default projects and are filtered out of the console/page-error
 * assertions below; only genuine load/parse/exec errors fail these tests.
 */

import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';

// ---------------------------------------------------------------------------
// Helpers (mirrors tests/harness.spec.ts / tests/save-fields.spec.ts conventions)
// ---------------------------------------------------------------------------

async function waitForHarness(page: Page): Promise<void> {
  await page.waitForFunction(() => (window as any).__harness?.ready === true, { timeout: 60_000 });
}

async function stepFrames(page: Page, count: number): Promise<void> {
  await page.evaluate((count) => (window as any).__harness.stepFrames(count, null), count);
}

async function settle(page: Page, maxFrames = 600): Promise<void> {
  await page.evaluate((maxFrames) => (window as any).__harness.settle(maxFrames), maxFrames);
}

async function getState(page: Page): Promise<any> {
  return page.evaluate(() => (window as any).__harness.getState());
}

async function saveSnapshot(page: Page): Promise<any> {
  return page.evaluate(() => (window as any).__harness.saveSnapshot());
}

async function loadSnapshot(page: Page, snapshot: any): Promise<boolean> {
  return page.evaluate((snap) => (window as any).__harness.loadSnapshot(snap), snapshot);
}

/**
 * Asset 404s are an expected, documented limitation for non-default projects
 * (missing combat_*.png panoramas, missing effects/palettes, etc.) --
 * PLAN.md "Known Limitations (per-project content)". Filter those out and
 * only surface genuine JS errors / unhandled exceptions / parse failures.
 */
function isExpectedAssetNoise(text: string): boolean {
  return /404|Failed to load resource|not found \S*\.(png|ogg|mp3|wav|idx)/i.test(text);
}

/** Attach page/console error collectors, returning a getter for unexpected errors. */
function collectErrors(page: Page): () => string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`PAGEERROR: ${e.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`CONSOLE: ${msg.text()}`);
  });
  return () => errors.filter((e) => !isExpectedAssetNoise(e));
}

// ---------------------------------------------------------------------------
// rekka.ltproj (FE7A) -- non-chunked format, classic Rescue fallback
// ---------------------------------------------------------------------------

test.describe('rekka.ltproj compatibility', () => {
  test('level 0 clean boot: map loads, units placed, no unexpected errors', async ({ page }) => {
    const unexpectedErrors = collectErrors(page);
    await page.goto('/?harness=true&project=rekka.ltproj&level=0&clean=true&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 10);

    const state = await getState(page);
    expect(state.levelNid).toBe('0');
    expect(state.currentStateName).toBe('free');
    expect(state.units.length).toBeGreaterThan(0);
    const nids = state.units.map((u: any) => u.nid);
    expect(nids).toContain('Lyn');
    expect(nids).toContain('Batta');

    expect(unexpectedErrors()).toEqual([]);
  });

  test('level 0 intro events run to completion (EVNT if/elif blocks), no unexpected errors', async ({ page }) => {
    const unexpectedErrors = collectErrors(page);
    await page.goto('/?harness=true&project=rekka.ltproj&level=0&clean=false&bundle=false');
    await waitForHarness(page);
    await settle(page, 600);

    const state = await getState(page);
    // The level_start event chain (Global Setup, 0 GiveGold, etc.) resolves
    // to ordinary map gameplay with no stuck event queue.
    expect(state.currentStateName).toBe('free');
    expect(state.levelNid).toBe('0');

    expect(unexpectedErrors()).toEqual([]);
  });

  test('combat resolution: Lyn vs enemy Soldier via resolveCombat', async ({ page }) => {
    await page.goto('/?harness=true&project=rekka.ltproj&level=0&clean=true&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 10);

    // Lyn starts with an unequipped Iron_Sword in this project (non-generic
    // units are not auto-equipped on level load); force-equip it directly,
    // matching the pattern used in tests/combat-goldens.spec.ts.
    await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const lyn = g.units.get('Lyn');
      const sword = lyn.items.find((i: any) => i.nid === 'Iron_Sword');
      lyn.equippedWeapon = sword;
    });
    await page.evaluate(() => (window as any).__harness.warpUnit('101', 12, 7));

    const result = await page.evaluate(() =>
      (window as any).__harness.resolveCombat('Lyn', '101', undefined, true),
    );

    expect(result).not.toBeNull();
    expect(result.strikeCount).toBeGreaterThan(0);
    expect(typeof result.attackerHp).toBe('number');
    expect(typeof result.defenderHp).toBe('number');
  });

  test('save/load round trip after combat', async ({ page }) => {
    await page.goto('/?harness=true&project=rekka.ltproj&level=0&clean=true&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 10);

    await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const lyn = g.units.get('Lyn');
      const sword = lyn.items.find((i: any) => i.nid === 'Iron_Sword');
      lyn.equippedWeapon = sword;
    });
    await page.evaluate(() => (window as any).__harness.warpUnit('101', 12, 7));
    await page.evaluate(() => (window as any).__harness.resolveCombat('Lyn', '101', undefined, true));

    const before = await getState(page);
    const snapshot = await saveSnapshot(page);
    expect(snapshot).toBeTruthy();

    const loaded = await loadSnapshot(page, snapshot);
    expect(loaded).toBe(true);

    const after = await getState(page);
    expect(after.levelNid).toBe(before.levelNid);
    expect(after.units.map((u: any) => u.nid).sort()).toEqual(before.units.map((u: any) => u.nid).sort());
    const lynBefore = before.units.find((u: any) => u.nid === 'Lyn');
    const lynAfter = after.units.find((u: any) => u.nid === 'Lyn');
    expect(lynAfter.hp).toBe(lynBefore.hp);
  });

  test('project-specific: classic Rescue sequence-item data loads (Rescue -> Rescue1/Rescue2, store_unit)', async ({ page }) => {
    await page.goto('/?harness=true&project=rekka.ltproj&level=0&clean=true&bundle=false');
    await waitForHarness(page);

    const info = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const rescue = g.db.items.get('Rescue');
      const rescue1 = g.db.items.get('Rescue1');
      const comps = (rescue?.components ?? []) as Array<[string, unknown]>;
      const rescue1Comps = (rescue1?.components ?? []) as Array<[string, unknown]>;
      const sequenceEntry = comps.find((c) => c[0] === 'sequence_item');
      return {
        hasSequenceItem: !!sequenceEntry,
        sequenceChildren: sequenceEntry?.[1],
        rescue1HasStoreUnit: rescue1Comps.some((c) => c[0] === 'store_unit'),
      };
    });

    expect(info.hasSequenceItem).toBe(true);
    expect(info.sequenceChildren).toEqual(['Rescue1', 'Rescue2']);
    expect(info.rescue1HasStoreUnit).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// testing_proj.ltproj (LT) -- chunked format, achievements system
// ---------------------------------------------------------------------------

test.describe('testing_proj.ltproj compatibility', () => {
  test('level 1 clean boot: map loads, units placed, no unexpected errors', async ({ page }) => {
    const unexpectedErrors = collectErrors(page);
    await page.goto('/?harness=true&project=testing_proj.ltproj&level=1&clean=true&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 10);

    const state = await getState(page);
    expect(state.levelNid).toBe('1');
    expect(state.currentStateName).toBe('free');
    expect(state.units.length).toBeGreaterThan(0);
    const nids = state.units.map((u: any) => u.nid);
    expect(nids).toContain('Eirika');
    expect(nids).toContain('Seth');

    expect(unexpectedErrors()).toEqual([]);
  });

  test('combat resolution: Eirika vs enemy Soldier via resolveCombat', async ({ page }) => {
    await page.goto('/?harness=true&project=testing_proj.ltproj&level=1&clean=true&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 10);

    await page.evaluate(() => (window as any).__harness.warpUnit('101', 26, 3));
    const result = await page.evaluate(() =>
      (window as any).__harness.resolveCombat('Eirika', '101', undefined, true),
    );

    expect(result).not.toBeNull();
    expect(result.strikeCount).toBeGreaterThan(0);
  });

  test('save/load round trip after combat', async ({ page }) => {
    await page.goto('/?harness=true&project=testing_proj.ltproj&level=1&clean=true&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 10);

    await page.evaluate(() => (window as any).__harness.warpUnit('101', 26, 3));
    await page.evaluate(() => (window as any).__harness.resolveCombat('Eirika', '101', undefined, true));

    const before = await getState(page);
    const snapshot = await saveSnapshot(page);
    expect(snapshot).toBeTruthy();

    const loaded = await loadSnapshot(page, snapshot);
    expect(loaded).toBe(true);

    const after = await getState(page);
    expect(after.levelNid).toBe(before.levelNid);
    const eirikaBefore = before.units.find((u: any) => u.nid === 'Eirika');
    const eirikaAfter = after.units.find((u: any) => u.nid === 'Eirika');
    expect(eirikaAfter.hp).toBe(eirikaBefore.hp);
  });

  test('project-specific: Chapter 1 intro event drives achievements end-to-end into base', async ({ page }) => {
    const unexpectedErrors = collectErrors(page);
    await page.goto('/?harness=true&project=testing_proj.ltproj&level=1&clean=false&bundle=false');
    await waitForHarness(page);
    await settle(page, 600);

    // 1_New_Event.json's level_start event runs create_achievement /
    // complete_achievement / update_achievement, then `base;Arena`.
    const state = await getState(page);
    expect(state.currentStateName).toBe('base_manage');

    const achievements = await page.evaluate(() => {
      const raw = localStorage.getItem('lt-achievements-LT');
      return raw ? JSON.parse(raw) : null;
    });
    expect(achievements).not.toBeNull();
    const byNid: Record<string, any> = Object.fromEntries(
      (achievements as any[]).map((a) => [a.nid, a]),
    );
    expect(byNid.Sample?.complete).toBe(true);
    expect(byNid.Smaple2?.complete).toBe(true);
    expect(byNid.Sample3?.complete).toBe(true);
    expect(byNid.Sample3?.hidden).toBe(true);
    expect(byNid.Sample4?.complete).toBe(true);

    expect(unexpectedErrors()).toEqual([]);
  });
});
