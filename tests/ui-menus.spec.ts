import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import type { Page, TestInfo } from '@playwright/test';

/**
 * EOtF menu screens drawn with Python's sprites and bitmap fonts. Each case
 * opens a state, lets its lazily-loaded sprites arrive, screenshots it, and
 * checks that no CSS-font fallback text was drawn.
 */

const projectAvailable = fs.existsSync(path.join(process.cwd(), 'lt-maker/eotf.ltproj/game_data/levels.json'));

async function step(page: Page, frames = 3): Promise<void> {
  await page.evaluate((n) => (window as any).__harness.stepFrames(n, null), frames);
}

async function boot(page: Page, level = '2'): Promise<void> {
  await page.goto(`/?harness=true&project=eotf.ltproj&level=${level}&clean=true&bundle=false`);
  await page.waitForFunction(() => (window as any).__harness?.ready === true, { timeout: 60_000 });
  await page.evaluate(() => (window as any).__harness.settle(2_000, ['free', 'prep_main', 'base_main']));
  // Count Canvas fillText calls: menu text must come from bitmap fonts.
  await page.evaluate(() => {
    const w = window as any;
    w.__cssTextCalls = [];
    for (const proto of [OffscreenCanvasRenderingContext2D.prototype, CanvasRenderingContext2D.prototype]) {
      const original = proto.fillText;
      proto.fillText = function patched(this: any, text: string, ...rest: any[]) {
        w.__cssTextCalls.push(String(text));
        return (original as any).call(this, text, ...rest);
      } as any;
    }
  });
}

/** Wait for streamed sprites, then advance frames. */
async function settleAssets(page: Page, frames = 30): Promise<void> {
  await step(page, 2);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(300);
  await step(page, frames);
}

async function shot(page: Page, name: string, testInfo: TestInfo): Promise<void> {
  await page.locator('canvas').screenshot({ path: testInfo.outputPath(`${name}.png`) });
}

async function stateName(page: Page): Promise<string> {
  return page.evaluate(() => (window as any).__gameRef.state.getCurrentState()?.name);
}

async function press(page: Page, ...events: string[]): Promise<void> {
  for (const event of events) {
    await page.evaluate((e) => (window as any).__gameRef.state.getCurrentState()?.takeInput(e), event);
    await step(page, 2);
  }
}

async function cssText(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as any).__cssTextCalls.splice(0));
}

test.describe('EOtF menu screens use Python sprites and bitmap fonts', () => {
  test.skip(!projectAvailable, 'lt-maker/eotf.ltproj is not installed');

  test('settings menu', async ({ page }, testInfo) => {
    await boot(page);
    await page.evaluate(() => (window as any).__gameRef.state.change('settings_menu'));
    await settleAssets(page);
    expect(await stateName(page)).toBe('settings_menu');
    await cssText(page);
    await step(page, 2);
    await shot(page, 'settings-top', testInfo);
    await press(page, 'DOWN', 'DOWN');
    await step(page, 10);
    await shot(page, 'settings-config', testInfo);
    await press(page, 'UP', 'UP', 'RIGHT', 'DOWN');
    await step(page, 10);
    await shot(page, 'settings-controls', testInfo);
    expect(await cssText(page)).toEqual([]);
  });

  test('turnwheel overlay', async ({ page }, testInfo) => {
    await boot(page);
    await page.evaluate(() => (window as any).__gameRef.state.change('turnwheel'));
    await settleAssets(page);
    expect(await stateName(page)).toBe('turnwheel');
    await cssText(page);
    await step(page, 2);
    await shot(page, 'turnwheel', testInfo);
    expect(await cssText(page)).toEqual([]);
  });

  test('objective menu and dialog log', async ({ page }, testInfo) => {
    await boot(page);
    await page.evaluate(() => (window as any).__gameRef.state.change('objective_menu'));
    await settleAssets(page);
    expect(await stateName(page)).toBe('objective_menu');
    await cssText(page);
    await step(page, 2);
    await shot(page, 'objective-menu', testInfo);
    expect(await cssText(page)).toEqual([]);

    await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      game.state.getCurrentState()?.takeInput('BACK');
      const { appendDialogLogEntry } = await import('/src/engine/states/objective-dialog-states.ts');
      const speaker = [...game.units.values()].find((u: any) => u.team === 'player')?.nid ?? 'Player';
      appendDialogLogEntry(game, speaker, 'We move{w} now!|Stay together, and watch the fog.');
      appendDialogLogEntry(game, 'Narrator', 'The fog thickens around the camp.');
      game.state.change('dialog_log');
    });
    await settleAssets(page, 6);
    expect(await stateName(page)).toBe('dialog_log');
    await cssText(page);
    await step(page, 2);
    await shot(page, 'dialog-log', testInfo);
    expect(await cssText(page)).toEqual([]);
  });
});
