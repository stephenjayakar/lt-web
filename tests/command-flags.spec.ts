/**
 * Blocking/no-block and no_banner flag matching per event command (P1 row:
 * "Match blocking/no-block, no-banner, immediate, and skip flags per
 * command"). Covers commands where a real-usage flag was found to be
 * silently ignored by the web port and was fixed as part of this pass:
 *
 * Python source of truth (lt-maker/app/events/event_functions.py):
 *  - give_item / remove_item / give_skill / remove_skill / break_item /
 *    give_money / give_bexp all show a banner.append + state.change('alert')
 *    (blocking) UNLESS the `no_banner` flag is present, in which case no
 *    banner is shown and the event does not block on it.
 *
 * Before this fix, the web's EventState never displayed any banner at all
 * for these seven commands (a visible regression vs Python for common event
 * scripts like `give_item;{unit};Elixir` or `give_skill;{unit};Locktouch;;no_banner`
 * mixed with un-flagged calls in the same script).
 *
 * Strategy: inject a test event and drain frames. When a banner is shown,
 * EventState blocks pointer advancement until the banner's ~3000ms display
 * timer elapses (see `this.banner = new Banner(text, undefined, 3000)` and
 * the "Banner timer" block in EventState.update). We use a `game_var` set by
 * the very next command in the script as the observable: with `no_banner`
 * the marker is set within a handful of frames; without it, the marker is
 * NOT set until the banner's ~180 frames (3000ms / ~16.7ms) have elapsed.
 */

import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';

async function waitForHarness(page: Page): Promise<void> {
  await page.waitForFunction(() => !!(window as any).__harness?.ready, { timeout: 15000 });
}

async function stepFrames(page: Page, count: number): Promise<void> {
  await page.evaluate((count) => (window as any).__harness.stepFrames(count, null), count);
}

async function installAndRunEvent(page: Page, nid: string, source: string[], frames: number): Promise<void> {
  await page.evaluate(
    ({ nid, source }) => {
      const g = (window as any).__gameRef;
      g.db.events.set(nid, {
        name: nid,
        nid,
        trigger: nid,
        level_nid: g.currentLevel?.nid ?? null,
        condition: 'True',
        only_once: false,
        priority: 0,
        _source: source,
      });
      g.eventManager.triggerSpecific(nid, { type: nid }, true);
      g.state.change('event');
    },
    { nid, source },
  );
  await stepFrames(page, frames);
}

async function getGameVar(page: Page, key: string): Promise<any> {
  return page.evaluate((key) => (window as any).__gameRef.gameVars.get(key), key);
}

test.describe('Event command flag matching: no_banner', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/?harness=true&level=DEBUG&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 5);
  });

  test('give_item: no_banner skips the acquired-item banner block, un-flagged blocks', async ({ page }) => {
    // no_banner: marker set within a few frames (no banner block).
    await installAndRunEvent(page, 'test_give_item_no_banner', [
      'give_item;Eirika;Elixir;;no_banner',
      'game_var;marker;done',
    ], 5);
    expect(await getGameVar(page, 'marker')).toBe('done');

    // un-flagged: banner shown, so the marker should NOT be set yet after
    // a few frames, but should be set once the banner's timer elapses.
    await installAndRunEvent(page, 'test_give_item_banner', [
      'give_item;Eirika;Iron_Bow',
      'game_var;marker2;done',
    ], 5);
    expect(await getGameVar(page, 'marker2')).toBeUndefined();
    await stepFrames(page, 200);
    expect(await getGameVar(page, 'marker2')).toBe('done');
  });

  test('give_skill: no_banner skips the banner block, un-flagged blocks', async ({ page }) => {
    await installAndRunEvent(page, 'test_give_skill_no_banner', [
      'give_skill;Eirika;Locktouch;;no_banner',
      'game_var;marker;done',
    ], 5);
    expect(await getGameVar(page, 'marker')).toBe('done');

    await installAndRunEvent(page, 'test_give_skill_banner', [
      'give_skill;Seth;Locktouch',
      'game_var;marker2;done',
    ], 5);
    expect(await getGameVar(page, 'marker2')).toBeUndefined();
    await stepFrames(page, 200);
    expect(await getGameVar(page, 'marker2')).toBe('done');
  });

  test('remove_skill: no_banner skips the banner block, un-flagged blocks', async ({ page }) => {
    await installAndRunEvent(page, 'test_remove_skill_setup', [
      'give_skill;Eirika;Locktouch;;no_banner',
      'give_skill;Seth;Locktouch;;no_banner',
    ], 5);

    await installAndRunEvent(page, 'test_remove_skill_no_banner', [
      'remove_skill;Eirika;Locktouch;;no_banner',
      'game_var;marker;done',
    ], 5);
    expect(await getGameVar(page, 'marker')).toBe('done');

    await installAndRunEvent(page, 'test_remove_skill_banner', [
      'remove_skill;Seth;Locktouch',
      'game_var;marker2;done',
    ], 5);
    expect(await getGameVar(page, 'marker2')).toBeUndefined();
    await stepFrames(page, 200);
    expect(await getGameVar(page, 'marker2')).toBe('done');
  });

  test('break_item: no_banner skips the banner block for a player unit', async ({ page }) => {
    await installAndRunEvent(page, 'test_break_item_setup', [
      'give_item;Eirika;Iron_Bow;;no_banner',
      'give_item;Seth;Iron_Bow;;no_banner',
    ], 5);

    await installAndRunEvent(page, 'test_break_item_no_banner', [
      'break_item;Eirika;Iron_Bow;no_banner',
      'game_var;marker;done',
    ], 5);
    expect(await getGameVar(page, 'marker')).toBe('done');

    await installAndRunEvent(page, 'test_break_item_banner', [
      'break_item;Seth;Iron_Bow',
      'game_var;marker2;done',
    ], 5);
    expect(await getGameVar(page, 'marker2')).toBeUndefined();
    await stepFrames(page, 200);
    expect(await getGameVar(page, 'marker2')).toBe('done');
  });

  test('give_money: no_banner skips the banner block, un-flagged blocks', async ({ page }) => {
    await installAndRunEvent(page, 'test_give_money_no_banner', [
      'give_money;100;;no_banner',
      'game_var;marker;done',
    ], 5);
    expect(await getGameVar(page, 'marker')).toBe('done');

    await installAndRunEvent(page, 'test_give_money_banner', [
      'give_money;100',
      'game_var;marker2;done',
    ], 5);
    expect(await getGameVar(page, 'marker2')).toBeUndefined();
    await stepFrames(page, 200);
    expect(await getGameVar(page, 'marker2')).toBe('done');
  });

  test('give_bexp: no_banner skips the banner block, un-flagged blocks', async ({ page }) => {
    await installAndRunEvent(page, 'test_give_bexp_no_banner', [
      'give_bexp;10;;no_banner',
      'game_var;marker;done',
    ], 5);
    expect(await getGameVar(page, 'marker')).toBe('done');

    await installAndRunEvent(page, 'test_give_bexp_banner', [
      'give_bexp;10',
      'game_var;marker2;done',
    ], 5);
    expect(await getGameVar(page, 'marker2')).toBeUndefined();
    await stepFrames(page, 200);
    expect(await getGameVar(page, 'marker2')).toBe('done');
  });

  test('remove_item: no_banner skips the banner block, un-flagged blocks', async ({ page }) => {
    await installAndRunEvent(page, 'test_remove_item_setup', [
      'give_item;Eirika;Iron_Bow;;no_banner',
      'give_item;Seth;Iron_Bow;;no_banner',
    ], 5);

    await installAndRunEvent(page, 'test_remove_item_no_banner', [
      'remove_item;Eirika;Iron_Bow;;no_banner',
      'game_var;marker;done',
    ], 5);
    expect(await getGameVar(page, 'marker')).toBe('done');

    await installAndRunEvent(page, 'test_remove_item_banner', [
      'remove_item;Seth;Iron_Bow',
      'game_var;marker2;done',
    ], 5);
    expect(await getGameVar(page, 'marker2')).toBeUndefined();
    await stepFrames(page, 200);
    expect(await getGameVar(page, 'marker2')).toBe('done');
  });
});

test.describe('Event command flag matching: skip', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/?harness=true&level=DEBUG&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 5);
  });

  test('end_skip restores blocking for subsequent commands', async ({ page }) => {
    await installAndRunEvent(page, 'test_end_skip', [
      'wait;1000',
      'end_skip',
      'wait;1000',
      'game_var;after_end_skip;done',
    ], 5);

    await page.evaluate(() => {
      const harnessWindow = window as Window & {
        __harness: { stepFrames(count: number, input: string | null): void };
      };
      harnessWindow.__harness.stepFrames(1, 'BACK');
    });
    expect(await getGameVar(page, 'after_end_skip')).toBeUndefined();

    await stepFrames(page, 70);
    expect(await getGameVar(page, 'after_end_skip')).toBe('done');
  });
});

test.describe('Event command flag matching: no_block', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/?harness=true&level=DEBUG&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 5);
  });

  test('transition continues the script during a no_block fade, but otherwise blocks', async ({ page }) => {
    await installAndRunEvent(page, 'test_transition_no_block', [
      'transition;close;1000;;;no_block',
      'game_var;no_block_marker;done',
      'wait;1000',
    ], 5);
    expect(await getGameVar(page, 'no_block_marker')).toBe('done');
    const fadeAlpha = await page.evaluate(() => {
      const gameWindow = window as Window & {
        __gameRef: { state: { getCurrentState(): unknown } };
      };
      const state = gameWindow.__gameRef.state.getCurrentState() as {
        transitionAlpha?: unknown;
      };
      return typeof state.transitionAlpha === 'number' ? state.transitionAlpha : null;
    });
    expect(fadeAlpha).not.toBeNull();
    expect(fadeAlpha!).toBeGreaterThan(0);
    expect(fadeAlpha!).toBeLessThan(1);
    await stepFrames(page, 70);

    await installAndRunEvent(page, 'test_transition_blocking', [
      'transition;close;1000',
      'game_var;blocking_marker;done',
    ], 5);
    expect(await getGameVar(page, 'blocking_marker')).toBeUndefined();
    await stepFrames(page, 70);
    expect(await getGameVar(page, 'blocking_marker')).toBe('done');
  });
});
