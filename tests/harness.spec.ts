/**
 * Playwright visual test harness for the Lex Talionis web engine.
 *
 * Uses ?harness=true to drive the game frame-by-frame and capture
 * screenshots at specific states for visual verification.
 *
 * By default, ?clean=true skips level_start events so we land directly
 * on the 'free' state (map gameplay). Use &clean=false to test with events.
 *
 * Run: npx playwright test
 * View report: npx playwright show-report
 */

import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SCREENSHOT_DIR = path.resolve(__dirname, '..', 'test-screenshots');

if (!fs.existsSync(SCREENSHOT_DIR)) {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function waitForHarness(page: any) {
  await page.waitForFunction(
    () => (window as any).__harness?.ready === true,
    { timeout: 30_000 },
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

async function settle(page: any, maxFrames: number = 300) {
  await page.evaluate(
    (maxFrames: number) => (window as any).__harness.settle(maxFrames),
    maxFrames,
  );
}

async function saveScreenshot(page: any, label: string): Promise<string> {
  const filePath = path.join(SCREENSHOT_DIR, `${label}.png`);
  await page.screenshot({ path: filePath });
  return filePath;
}

// ---------------------------------------------------------------------------
// DEBUG Level Tests (clean mode -- no events, straight to free state)
// ---------------------------------------------------------------------------

test.describe('DEBUG Level (clean)', () => {
  test('initial map render', async ({ page }) => {
    // clean=true is the default, skips level_start events
    await page.goto('/?harness=true&level=DEBUG&bundle=false');
    await waitForHarness(page);

    await stepFrames(page, 10);

    const state = await getState(page);
    expect(state.levelNid).toBe('DEBUG');
    expect(state.currentStateName).toBe('free');
    expect(state.units.length).toBeGreaterThan(0);

    console.log(`Units: ${state.units.map((u: any) => `${u.name}(${u.team})`).join(', ')}`);
    await saveScreenshot(page, '01-debug-map');
  });

  test('cursor movement', async ({ page }) => {
    await page.goto('/?harness=true&level=DEBUG&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 5);

    const before = await getState(page);
    const startPos = before.cursorPos;

    // Move cursor right 3 times, down 2 times
    for (let i = 0; i < 3; i++) {
      await stepFrames(page, 4, 'RIGHT');
    }
    for (let i = 0; i < 2; i++) {
      await stepFrames(page, 4, 'DOWN');
    }
    await stepFrames(page, 5); // settle animation

    const after = await getState(page);
    console.log(`Cursor moved: [${startPos}] -> [${after.cursorPos}]`);
    expect(after.cursorPos[0]).toBeGreaterThan(startPos[0]);
    expect(after.cursorPos[1]).toBeGreaterThan(startPos[1]);

    await saveScreenshot(page, '02-debug-cursor-moved');
  });

  test('select unit shows movement range', async ({ page }) => {
    await page.goto('/?harness=true&level=DEBUG&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 5);

    // Find a player unit
    const state = await getState(page);
    const player = state.units.find(
      (u: any) => u.team === 'player' && u.position !== null,
    );
    expect(player).toBeTruthy();
    console.log(`Selecting: ${player.name} at [${player.position}]`);

    // Move cursor to unit
    const [ux, uy] = player.position;
    const [cx, cy] = state.cursorPos;
    const dx = ux - cx;
    const dy = uy - cy;
    for (let i = 0; i < Math.abs(dx); i++) {
      await stepFrames(page, 3, dx > 0 ? 'RIGHT' : 'LEFT');
    }
    for (let i = 0; i < Math.abs(dy); i++) {
      await stepFrames(page, 3, dy > 0 ? 'DOWN' : 'UP');
    }
    await stepFrames(page, 5);

    // Screenshot: cursor on unit
    await saveScreenshot(page, '03-debug-cursor-on-unit');

    // Press SELECT to select the unit
    await stepFrames(page, 3, 'SELECT');
    await stepFrames(page, 15); // let highlights render

    // Check we transitioned to move state
    const afterSelect = await getState(page);
    console.log(`State after select: ${afterSelect.currentStateName}`);

    await saveScreenshot(page, '04-debug-movement-range');
  });

  test('open and close action menu', async ({ page }) => {
    await page.goto('/?harness=true&level=DEBUG&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 5);

    // Find Eirika
    const state = await getState(page);
    const eirika = state.units.find((u: any) => u.nid === 'Eirika');
    expect(eirika).toBeTruthy();

    // Navigate cursor to Eirika
    const [ux, uy] = eirika.position;
    const [cx, cy] = state.cursorPos;
    const dx = ux - cx;
    const dy = uy - cy;
    for (let i = 0; i < Math.abs(dx); i++) {
      await stepFrames(page, 3, dx > 0 ? 'RIGHT' : 'LEFT');
    }
    for (let i = 0; i < Math.abs(dy); i++) {
      await stepFrames(page, 3, dy > 0 ? 'DOWN' : 'UP');
    }
    await stepFrames(page, 5);

    // Select Eirika
    await stepFrames(page, 3, 'SELECT');
    await stepFrames(page, 10);

    // Select same tile (should open menu)
    await stepFrames(page, 3, 'SELECT');
    await stepFrames(page, 10);

    const menuState = await getState(page);
    console.log(`State after menu: ${menuState.currentStateName}`);
    await saveScreenshot(page, '05-debug-action-menu');

    // Press BACK to cancel
    await stepFrames(page, 3, 'BACK');
    await stepFrames(page, 10);
    await stepFrames(page, 3, 'BACK');
    await stepFrames(page, 10);

    const afterCancel = await getState(page);
    console.log(`State after cancel: ${afterCancel.currentStateName}`);
    await saveScreenshot(page, '06-debug-after-cancel');
  });
});

// ---------------------------------------------------------------------------
// Prologue Tests (clean mode)
// ---------------------------------------------------------------------------

test.describe('Prologue (clean)', () => {
  test('initial map render', async ({ page }) => {
    await page.goto('/?harness=true&level=0&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 10);

    const state = await getState(page);
    expect(state.levelNid).toBe('0');
    expect(state.currentStateName).toBe('free');
    console.log(`Prologue units: ${state.units.map((u: any) => `${u.name}(${u.team})`).join(', ')}`);

    await saveScreenshot(page, '07-prologue-map');
  });

  test('prologue map with cursor on enemy', async ({ page }) => {
    await page.goto('/?harness=true&level=0&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 5);

    // Find the boss (O'Neill)
    const state = await getState(page);
    const boss = state.units.find((u: any) => u.nid === "O'Neill");
    if (boss?.position) {
      const [bx, by] = boss.position;
      const [cx, cy] = state.cursorPos;
      const dx = bx - cx;
      const dy = by - cy;
      for (let i = 0; i < Math.abs(dx); i++) {
        await stepFrames(page, 3, dx > 0 ? 'RIGHT' : 'LEFT');
      }
      for (let i = 0; i < Math.abs(dy); i++) {
        await stepFrames(page, 3, dy > 0 ? 'DOWN' : 'UP');
      }
      await stepFrames(page, 5);

      console.log(`Cursor on boss: ${boss.name} at [${boss.position}]`);
      await saveScreenshot(page, '08-prologue-cursor-on-boss');
    }
  });
});

// ---------------------------------------------------------------------------
// Prologue with events (non-clean mode)
// ---------------------------------------------------------------------------

test.describe('Prologue (with events)', () => {
  test('initial event state', async ({ page }) => {
    await page.goto('/?harness=true&level=0&bundle=false&clean=false');
    await waitForHarness(page);
    await stepFrames(page, 5);

    const state = await getState(page);
    console.log(`State with events: ${state.currentStateName}`);
    // Prologue starts with intro events
    await saveScreenshot(page, '09-prologue-event');
  });
});
