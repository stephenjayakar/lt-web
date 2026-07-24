import { expect, test } from '@playwright/test';

async function waitForHarness(page: import('@playwright/test').Page): Promise<void> {
  await page.waitForFunction(() => (window as any).__harness?.ready === true, {
    timeout: 30_000,
  });
}

test.describe('Rekka visual baselines', () => {
  test('representative chapter map renders project tiles, units, and HUD', async ({ page }) => {
    await page.goto('/?harness=true&project=rekka.ltproj&level=7&clean=true&bundle=false');
    await waitForHarness(page);
    await page.evaluate(async () => {
      (window as any).__harness.stepFrames(5, null);
      await new Promise((resolve) => setTimeout(resolve, 100));
      (window as any).__harness.stepFrames(1, null);
    });
    await expect(page.locator('#game-canvas')).toHaveScreenshot('rekka-chapter-7-map.png', {
      maxDiffPixelRatio: 0.01,
    });
  });

  test('project dialogue renders its portraits and held text', async ({ page }) => {
    await page.goto('/?harness=true&project=rekka.ltproj&level=DEBUG&clean=true&bundle=false');
    await waitForHarness(page);
    await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const nid = '_RekkaVisualDialogue';
      game.db.events.set(nid, {
        nid,
        name: 'Rekka visual dialogue',
        trigger: nid,
        level_nid: 'DEBUG',
        condition: 'True',
        only_once: false,
        priority: 0,
        _source: [
          'change_background;BlackBackground',
          'multi_add_portrait;Marcel;Left;Lyn;Right',
          'speak;Marcel;I miss home',
          'multi_remove_portrait;Marcel;Lyn',
        ],
      });
      game.eventManager.triggerSpecific(nid, {
        type: 'direct_visual_check',
        levelNid: 'DEBUG',
      }, true);
      game.state.change('event');
      for (let index = 0; index < 60; index++) {
        (window as any).__harness.stepFrames(1, null);
        const state = game.state.getCurrentState() as any;
        if (state?.dialog) {
          state.dialog.handleInput('SELECT');
          state.dialog.handleInput('SELECT');
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    });
    await page.waitForTimeout(300);
    await page.evaluate(() => (window as any).__harness.stepFrames(1, null));
    expect(await page.evaluate(
      () => (window as any).__gameRef.state.getCurrentState()?.dialog?.isWaiting(),
    )).toBe(true);
    await expect(page.locator('#game-canvas')).toHaveScreenshot('rekka-dialogue.png', {
      maxDiffPixelRatio: 0.01,
    });
  });

  test('save selection remains contained at the logical resolution', async ({ page }) => {
    await page.goto('/?harness=true&project=rekka.ltproj&level=7&clean=true&bundle=false');
    await waitForHarness(page);
    await page.evaluate(() => {
      const game = (window as any).__gameRef;
      game.state.change('save_menu');
      (window as any).__harness.stepFrames(2, null);
    });
    await page.waitForTimeout(100);
    await page.evaluate(() => (window as any).__harness.stepFrames(1, null));
    expect(await page.evaluate(
      () => (window as any).__gameRef.state.getCurrentState()?.name,
    )).toBe('save_menu');
    await expect(page.locator('#game-canvas')).toHaveScreenshot('rekka-save-select.png', {
      maxDiffPixelRatio: 0.01,
    });
  });
});
