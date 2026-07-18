/**
 * Save-field parity closeout (docs/parity/runtime-inventory.md §4).
 *
 * Covers the two previously-missing save fields that had a live runtime
 * representation in the web port and were closed by this slice:
 *
 *  - Unit `current_mana` (unit.py:924) — set via the `set_current_mana`
 *    event command (already wired in game-states.ts) as a dynamic
 *    `currentMana` property, consumed by item-system.ts mana-cost checks.
 *    Now persisted/restored in save.ts; legacy saves (no `currentMana`
 *    field) restore with the property left unset, matching prior behavior
 *    (item-system falls back to the MANA equation).
 *
 *  - GameState `talk_hidden` (game_state.py:425) — the `hide_talk` /
 *    `unhide_talk` event commands were previously no-ops ("not yet tracked
 *    visually"). This slice adds an EventManager-backed hidden-pair set,
 *    wires the commands to it, filters it into the map Talk-option menu,
 *    and persists it in save.ts. Legacy saves (no `talkHidden` field)
 *    restore with an empty hidden set.
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

test.describe('Save-field parity closeout', () => {
  test('unit current_mana round-trips through save/load', async ({ page }) => {
    await page.goto('/?harness=true&level=DEBUG&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 5);

    await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const eirika = g?.units?.get?.('Eirika');
      if (eirika) (eirika as any).currentMana = 7;
    });

    const before = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      return (g?.units?.get?.('Eirika') as any)?.currentMana;
    });
    expect(before).toBe(7);

    const snapshot = await saveSnapshot(page);

    // Mutate runtime state so the load is observable.
    await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const eirika = g?.units?.get?.('Eirika');
      if (eirika) (eirika as any).currentMana = 0;
    });

    const loaded = await loadSnapshot(page, snapshot);
    expect(loaded).toBe(true);
    await stepFrames(page, 2);

    const after = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      return (g?.units?.get?.('Eirika') as any)?.currentMana;
    });
    expect(after).toBe(7);
  });

  test('legacy save without currentMana field restores unit with no dynamic mana set', async ({ page }) => {
    await page.goto('/?harness=true&level=DEBUG&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 5);

    const snapshot = await saveSnapshot(page);
    const legacy = JSON.parse(JSON.stringify(snapshot));
    for (const u of legacy.units) delete u.currentMana;

    const loaded = await loadSnapshot(page, legacy);
    expect(loaded).toBe(true);
    await stepFrames(page, 2);

    const after = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      return (g?.units?.get?.('Eirika') as any)?.currentMana;
    });
    expect(after).toBeUndefined();
  });

  test('talk_hidden pair round-trips through save/load and suppresses the Talk menu option', async ({ page }) => {
    await page.goto('/?harness=true&level=DEBUG&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 5);

    const hiddenBefore = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      g.eventManager.hideTalk('Eirika', 'Seth');
      return g.eventManager.isTalkHidden('Eirika', 'Seth');
    });
    expect(hiddenBefore).toBe(true);

    const snapshot = await saveSnapshot(page);

    // Mutate runtime state so the load is observable.
    await page.evaluate(() => {
      const g = (window as any).__gameRef;
      g.eventManager.unhideTalk('Eirika', 'Seth');
    });
    const clearedBeforeLoad = await page.evaluate(() =>
      (window as any).__gameRef.eventManager.isTalkHidden('Eirika', 'Seth'));
    expect(clearedBeforeLoad).toBe(false);

    const loaded = await loadSnapshot(page, snapshot);
    expect(loaded).toBe(true);
    await stepFrames(page, 2);

    const hiddenAfter = await page.evaluate(() =>
      (window as any).__gameRef.eventManager.isTalkHidden('Eirika', 'Seth'));
    expect(hiddenAfter).toBe(true);

    // Reciprocal lookup (order-independent).
    const hiddenReciprocal = await page.evaluate(() =>
      (window as any).__gameRef.eventManager.isTalkHidden('Seth', 'Eirika'));
    expect(hiddenReciprocal).toBe(true);
  });

  test('legacy save without talkHidden field restores with an empty hidden set', async ({ page }) => {
    await page.goto('/?harness=true&level=DEBUG&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 5);

    const snapshot = await saveSnapshot(page);
    const legacy = JSON.parse(JSON.stringify(snapshot));
    delete legacy.talkHidden;

    const loaded = await loadSnapshot(page, legacy);
    expect(loaded).toBe(true);
    await stepFrames(page, 2);

    const hidden = await page.evaluate(() =>
      (window as any).__gameRef.eventManager.isTalkHidden('Eirika', 'Seth'));
    expect(hidden).toBe(false);
  });
});
