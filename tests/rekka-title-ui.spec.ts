import { expect, test } from '@playwright/test';

async function waitForHarness(page: import('@playwright/test').Page): Promise<void> {
  await page.waitForFunction(() => (window as any).__harness?.ready === true, {
    timeout: 60_000,
  });
}

test.describe('Rekka title presentation', () => {
  test('loads authored title resources, falls back for transparent art, and starts safely', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 480, height: 320 });
    await page.goto('/?harness=true&project=rekka.ltproj&level=0&clean=true&bundle=false');
    await waitForHarness(page);

    await page.evaluate(() => {
      const game = (window as any).__gameRef;
      game.audioManager.stopMusic();
      game.audioManager.clearCalls();
      game.state.clear();
      game.state.change('title');
      (window as any).__harness.stepFrames(3, null);
    });
    // Title art loads asynchronously; wait for it instead of a fixed sleep
    // that loses the race under parallel load.
    await page.waitForFunction(() => {
      const state = (window as any).__gameRef.state.getCurrentState() as any;
      return state?.name === 'title' && !!state.bgImage &&
        state.logoAssetLoaded && state.pressStartAssetLoaded;
    }, undefined, { timeout: 15_000 });
    const title = await page.evaluate(() => {
      const game = (window as any).__gameRef;
      (window as any).__harness.stepFrames(1, null);
      const state = game.state.getCurrentState() as any;
      return {
        state: state?.name,
        title: game.db.getConstant('title', null),
        titleMusic: game.db.getConstant('music_main', null),
        requestedMusic: game.audioManager.calls.find((call: any) => call.op === 'play')?.nid ?? null,
        backgroundLoaded: Boolean(state?.bgImage),
        logoAssetLoaded: state?.logoAssetLoaded,
        promptAssetLoaded: state?.pressStartAssetLoaded,
        logoHasVisiblePixels: Boolean(state?.logoImage),
        promptHasVisiblePixels: Boolean(state?.pressStartImage),
      };
    });

    expect(title).toEqual({
      state: 'title',
      title: 'Rekka no Ken Alternative',
      titleMusic: 'Groovin Magic (inst.)',
      requestedMusic: 'Groovin Magic (inst.)',
      backgroundLoaded: true,
      logoAssetLoaded: true,
      promptAssetLoaded: true,
      logoHasVisiblePixels: false,
      promptHasVisiblePixels: false,
    });

    await expect(page.locator('#game-canvas')).toHaveScreenshot('rekka-title-desktop.png', {
      maxDiffPixelRatio: 0.01,
    });

    const start = await page.evaluate(() => {
      const game = (window as any).__gameRef;
      game.audioManager.clearCalls();
      game.state.getCurrentState()?.takeInput('SELECT');
      (window as any).__harness.stepFrames(2, null);
      return {
        state: game.state.getCurrentState()?.name,
        startSfx: game.audioManager.calls.some(
          (call: any) => call.op === 'sfx' && call.nid === 'Start',
        ),
      };
    });
    expect(start).toEqual({ state: 'title_main', startSfx: true });
  });

  test('retains the 240×160 title composition in a narrow mobile viewport', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 320, height: 568 });
    await page.goto('/?harness=true&project=rekka.ltproj&level=0&clean=true&bundle=false');
    await waitForHarness(page);
    await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      game.state.clear();
      game.state.change('title');
      (window as any).__harness.stepFrames(3, null);
    });
    // The title panorama loads asynchronously; a fixed 100ms sleep raced it
    // under parallel load and screenshotted a bare background.
    await page.waitForFunction(() => {
      const state = (window as any).__gameRef.state.getCurrentState() as any;
      return state?.name === 'title' && !!state.bgImage;
    }, undefined, { timeout: 15_000 });
    await page.evaluate(() => (window as any).__harness.stepFrames(1, null));

    const geometry = await page.locator('#game-canvas').evaluate(async (canvas: HTMLCanvasElement) => {
      const rect = canvas.getBoundingClientRect();
      const { viewport } = await import('/src/engine/viewport.ts');
      return {
        backingWidth: canvas.width,
        backingHeight: canvas.height,
        cssWidth: Math.round(rect.width),
        cssHeight: Math.round(rect.height),
        logicalWidth: viewport.width,
        logicalHeight: viewport.height,
        withinViewport: rect.left >= 0 && rect.right <= window.innerWidth &&
          rect.top >= 0 && rect.bottom <= window.innerHeight,
      };
    });
    expect(geometry.logicalWidth).toBeGreaterThanOrEqual(240);
    expect(geometry.logicalHeight).toBeGreaterThanOrEqual(160);
    expect(geometry.backingWidth / geometry.backingHeight)
      .toBeCloseTo(geometry.cssWidth / geometry.cssHeight, 2);
    expect(geometry.withinViewport).toBe(true);

    await expect(page.locator('#game-canvas')).toHaveScreenshot('rekka-title-mobile.png', {
      maxDiffPixelRatio: 0.01,
    });
  });
});
