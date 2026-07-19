/**
 * Rendering-parity verification slice (P6 roadmap row): tile layers,
 * autotiles, weather overlays, and camera positioning.
 *
 * Python references:
 *   - lt-maker/app/engine/objects/tilemap.py (LayerObject fade transitions,
 *     autotile frame timing)
 *   - lt-maker/app/engine/particles.py (weather particle systems)
 *   - lt-maker/app/engine/camera.py (camera movement/pan/clamping)
 *
 * This is a comparison/verification slice, not a rewrite: it locks in
 * constants ported from Python (autotile period, layer fade duration) with
 * structural + screenshot assertions, and documents accepted deviations
 * (see PLAN.md) where porting further would be out of scope for this pass.
 *
 * Screenshots use Playwright's Clock API to freeze/advance `Date.now()`
 * deterministically -- required because the render loop reads real time
 * for autotile frame selection and layer-fade progress. The weather
 * screenshot deliberately uses the 'night' overlay (a flat color wash with
 * zero particles, abundance=0 in weather.ts) rather than rain/snow, since
 * those particle systems spawn via unseeded Math.random() and would be
 * pixel-flaky across repeated runs.
 */

import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';

async function waitForHarness(page: Page): Promise<void> {
  await page.waitForFunction(() => !!(window as any).__harness?.ready, { timeout: 15000 });
}

async function stepFrames(page: Page, count: number): Promise<void> {
  await page.evaluate((count) => (window as any).__harness.stepFrames(count, null), count);
}

async function getRenderState(page: Page): Promise<any> {
  return page.evaluate(() => (window as any).__harness.getRenderState());
}

test.describe('Rendering parity: tile layers, autotiles, weather, camera', () => {
  test('autotile frame index advances on the Python-derived period (fps=29 -> 483ms/frame, 16 frames)', async ({ page }) => {
    await page.clock.install({ time: 1_000_000 });
    await page.goto('/?harness=true&level=0&clean=true&bundle=false');
    await waitForHarness(page);

    // frame = floor(currentTime / floor(29*16.66)) % 16 = floor(currentTime/483) % 16
    await page.clock.setFixedTime(1_000_000);
    await stepFrames(page, 1);
    let state = await getRenderState(page);
    const frame0 = Math.floor(1_000_000 / 483) % 16;
    expect(state.autotileFrame).toBe(frame0);

    // Advance by exactly one autotile period -- frame index must increment by 1 (mod 16).
    await page.clock.setFixedTime(1_000_000 + 483);
    await stepFrames(page, 1);
    state = await getRenderState(page);
    expect(state.autotileFrame).toBe((frame0 + 1) % 16);

    // Sub-period advance must NOT change the frame.
    await page.clock.setFixedTime(1_000_000 + 483 + 100);
    await stepFrames(page, 1);
    state = await getRenderState(page);
    expect(state.autotileFrame).toBe((frame0 + 1) % 16);

    // Screenshot comparison across two frame indices -- deterministic since
    // Prologue's tilemap and autotile atlas are static assets.
    await page.clock.setFixedTime(1_000_000);
    await stepFrames(page, 1);
    await expect(page).toHaveScreenshot('autotile-frame-a.png', { maxDiffPixelRatio: 0.02 });

    await page.clock.setFixedTime(1_000_000 + 483);
    await stepFrames(page, 1);
    await expect(page).toHaveScreenshot('autotile-frame-b.png', { maxDiffPixelRatio: 0.02 });
  });

  test('show_layer/hide_layer fade transitions match Python (333ms, LayerObject.show/hide)', async ({ page }) => {
    await page.clock.install({ time: 2_000_000 });
    await page.goto('/?harness=true&level=3&clean=true&bundle=false');
    await waitForHarness(page);

    // Door1 starts hidden in Chapter_3's tilemap prefab.
    let state = await getRenderState(page);
    const door1Before = state.layers.find((l: any) => l.nid === 'Door1');
    expect(door1Before.visible).toBe(false);
    expect(door1Before.state).toBe(null);

    // Chest1 starts visible.
    const chest1Before = state.layers.find((l: any) => l.nid === 'Chest1');
    expect(chest1Before.visible).toBe(true);
    expect(chest1Before.state).toBe(null);

    const t0 = 2_000_000;
    await page.evaluate((t0) => {
      (window as any).__harness.setLayer('Door1', true, 'fade', t0);
      (window as any).__harness.setLayer('Chest1', false, 'fade', t0);
    }, t0);

    // Immediately after triggering: Door1 visible flips true but starts fully
    // transparent (translucence=1 -> renderAlpha=0); Chest1 visible flips
    // false but is still drawn (shouldDraw() true while fade_out), starting
    // fully opaque (translucence=0 -> renderAlpha=1).
    await page.clock.setFixedTime(t0);
    await stepFrames(page, 1);
    state = await getRenderState(page);
    let door1 = state.layers.find((l: any) => l.nid === 'Door1');
    let chest1 = state.layers.find((l: any) => l.nid === 'Chest1');
    expect(door1.visible).toBe(true);
    expect(door1.state).toBe('fade_in');
    expect(door1.renderAlpha).toBeCloseTo(0, 1);
    expect(chest1.visible).toBe(false);
    expect(chest1.state).toBe('fade_out');
    expect(chest1.renderAlpha).toBeCloseTo(1, 1);

    // Halfway through the 333ms transition.
    await page.clock.setFixedTime(t0 + 166);
    await stepFrames(page, 1);
    state = await getRenderState(page);
    door1 = state.layers.find((l: any) => l.nid === 'Door1');
    chest1 = state.layers.find((l: any) => l.nid === 'Chest1');
    expect(door1.renderAlpha).toBeGreaterThan(0.3);
    expect(door1.renderAlpha).toBeLessThan(0.7);
    expect(chest1.renderAlpha).toBeGreaterThan(0.3);
    expect(chest1.renderAlpha).toBeLessThan(0.7);
    await expect(page).toHaveScreenshot('layer-fade-halfway.png', { maxDiffPixelRatio: 0.02 });

    // Past the transition window: fade completes and state clears (Python:
    // translucence <= 0 -> state=None for fade_in, >= 1 -> state=None for fade_out).
    await page.clock.setFixedTime(t0 + 400);
    await stepFrames(page, 1);
    state = await getRenderState(page);
    door1 = state.layers.find((l: any) => l.nid === 'Door1');
    chest1 = state.layers.find((l: any) => l.nid === 'Chest1');
    expect(door1.state).toBe(null);
    expect(door1.visible).toBe(true);
    expect(door1.renderAlpha).toBe(1);
    expect(chest1.state).toBe(null);
    expect(chest1.visible).toBe(false);
    await expect(page).toHaveScreenshot('layer-fade-complete.png', { maxDiffPixelRatio: 0.02 });
  });

  test('immediate layer transition pops instantly with no fade (Python quick_show/quick_hide)', async ({ page }) => {
    await page.clock.install({ time: 3_000_000 });
    await page.goto('/?harness=true&level=3&clean=true&bundle=false');
    await waitForHarness(page);

    await page.evaluate(() => {
      (window as any).__harness.setLayer('Door1', true, 'immediate');
    });
    await stepFrames(page, 1);
    const state = await getRenderState(page);
    const door1 = state.layers.find((l: any) => l.nid === 'Door1');
    expect(door1.visible).toBe(true);
    expect(door1.state).toBe(null);
    expect(door1.renderAlpha).toBe(1);
  });

  test('weather overlay (night) renders a deterministic full-screen tint at a forced frame', async ({ page }) => {
    await page.clock.install({ time: 4_000_000 });
    await page.goto('/?harness=true&level=0&clean=true&bundle=false');
    await waitForHarness(page);

    await page.evaluate(() => (window as any).__harness.addWeather('night'));
    await stepFrames(page, 2);
    const state = await getRenderState(page);
    expect(state.weatherNids).toContain('night');

    await expect(page).toHaveScreenshot('weather-night-overlay.png', { maxDiffPixelRatio: 0.02 });

    await page.evaluate(() => (window as any).__harness.removeWeather('night'));
    await stepFrames(page, 1);
    const stateAfter = await getRenderState(page);
    expect(stateAfter.weatherNids).not.toContain('night');
  });

  test('camera renders at a known forced pan position', async ({ page }) => {
    await page.clock.install({ time: 5_000_000 });
    // Chapter 3's tilemap (272x256px) is larger than the test viewport, so a
    // forced offset has room to actually move (unlike Chapter 1, whose
    // 240x160px map exactly equals this viewport and always clamps to (0,0)).
    await page.goto('/?harness=true&level=3&clean=true&bundle=false');
    await waitForHarness(page);

    await page.evaluate(() => (window as any).__harness.forceCameraPosition(16, 8));
    await stepFrames(page, 1);
    const state = await getRenderState(page);
    expect(state.camera.x).toBe(16);
    expect(state.camera.y).toBe(8);
    expect(state.camera.targetX).toBe(16);
    expect(state.camera.targetY).toBe(8);

    await expect(page).toHaveScreenshot('camera-forced-position.png', { maxDiffPixelRatio: 0.02 });
  });
});
