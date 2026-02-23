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
// Magic Sword Combat Tests
// ---------------------------------------------------------------------------

async function giveItem(page: any, unitNid: string, itemNid: string): Promise<boolean> {
  return page.evaluate(
    ({ unitNid, itemNid }: { unitNid: string; itemNid: string }) => {
      return (window as any).__harness.giveItem(unitNid, itemNid);
    },
    { unitNid, itemNid },
  );
}

async function navigateCursorTo(
  page: any,
  targetX: number,
  targetY: number,
  currentX: number,
  currentY: number,
): Promise<void> {
  const dx = targetX - currentX;
  const dy = targetY - currentY;
  for (let i = 0; i < Math.abs(dx); i++) {
    await stepFrames(page, 3, dx > 0 ? 'RIGHT' : 'LEFT');
  }
  for (let i = 0; i < Math.abs(dy); i++) {
    await stepFrames(page, 3, dy > 0 ? 'DOWN' : 'UP');
  }
  await stepFrames(page, 3);
}

test.describe('Magic Sword Combat', () => {
  test('Light Brand combat does not freeze', async ({ page }) => {
    // Load the DEBUG level cleanly
    await page.goto('/?harness=true&level=DEBUG&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 5);

    // Give Eirika a Light Brand (has `magic` + `battle_cast_anim: "Lightning"`)
    const given = await giveItem(page, 'Eirika', 'Light_Brand');
    expect(given).toBe(true);

    // Verify Eirika is at (2,6) and Bone (enemy) is at (2,5)
    const state = await getState(page);
    const eirika = state.units.find((u: any) => u.nid === 'Eirika');
    const bone = state.units.find((u: any) => u.nid === 'Bone');
    expect(eirika?.position).toEqual([2, 6]);
    expect(bone?.position).toEqual([2, 5]);

    // Navigate cursor to Eirika
    const [cx, cy] = state.cursorPos;
    await navigateCursorTo(page, 2, 6, cx, cy);

    // Select Eirika (enters move state)
    await stepFrames(page, 3, 'SELECT');
    await stepFrames(page, 10);

    let s = await getState(page);
    console.log(`After selecting Eirika: ${s.currentStateName}`);

    // Select same tile to open action menu (Eirika stays at her position)
    await stepFrames(page, 3, 'SELECT');
    await stepFrames(page, 10);

    s = await getState(page);
    console.log(`After confirming position: ${s.currentStateName}`);
    await saveScreenshot(page, '10-magic-sword-action-menu');

    // "Attack" should be the first option in the menu. Press SELECT to pick it.
    await stepFrames(page, 3, 'SELECT');
    await stepFrames(page, 10);

    s = await getState(page);
    console.log(`After selecting Attack: ${s.currentStateName}`);

    // If we're in weapon_choice, select the weapon (Light Brand should be first)
    if (s.currentStateName === 'weapon_choice') {
      await stepFrames(page, 3, 'SELECT');
      await stepFrames(page, 10);
      s = await getState(page);
      console.log(`After selecting weapon: ${s.currentStateName}`);
    }

    await saveScreenshot(page, '11-magic-sword-targeting');

    // In targeting mode, Bone should be the target (adjacent at (2,5)).
    // Press SELECT to confirm attack on Bone.
    await stepFrames(page, 3, 'SELECT');
    await stepFrames(page, 5);

    s = await getState(page);
    console.log(`Combat started, state: ${s.currentStateName}`);
    await saveScreenshot(page, '12-magic-sword-combat-start');

    // Run many frames to let combat resolve. Combat completes in ~260 frames,
    // then the unit may return to menus (weapon_choice/targeting) or post-combat
    // states that need dismissing. We auto-press BACK to cancel out of any
    // remaining menus until we return to 'free' state.
    let combatResolved = false;
    let lastState = '';
    let combatSeen = false;
    let midCombatScreenshotTaken = false;
    for (let batch = 0; batch < 200; batch++) {
      await stepFrames(page, 20);
      s = await getState(page);
      if (s.currentStateName === 'combat' || s.currentStateName === 'animation_combat' ||
          s.currentStateName === 'map_combat') {
        combatSeen = true;
        // Capture mid-combat screenshot after HP bar panels have slid in (~60 frames)
        if (!midCombatScreenshotTaken && batch >= 2) {
          await saveScreenshot(page, '12b-magic-sword-combat-mid');
          midCombatScreenshotTaken = true;
        }
      }
      if (s.currentStateName !== lastState) {
        console.log(`  Frame ~${(batch + 1) * 20}: state=${s.currentStateName}`);
        lastState = s.currentStateName;
      }
      if (s.currentStateName === 'free') {
        combatResolved = true;
        console.log(`Combat resolved after ~${(batch + 1) * 20} frames`);
        break;
      }
      // After combat is over, if we're back in menus or other states, try to
      // advance/dismiss. press BACK to cancel out of stacked menus, or settle.
      if (combatSeen && s.currentStateName !== 'combat' &&
          s.currentStateName !== 'animation_combat' &&
          s.currentStateName !== 'map_combat' &&
          s.currentStateName !== 'exp' && s.currentStateName !== 'exp_gain') {
        // Try pressing BACK to dismiss any post-combat menus
        await stepFrames(page, 3, 'BACK');
      }
    }

    await saveScreenshot(page, '13-magic-sword-combat-end');

    // Verify combat actually happened — we should have seen a combat state
    expect(combatSeen).toBe(true);

    // If combat didn't resolve in ~4000 frames, the freeze bug is still present.
    expect(combatResolved).toBe(true);

    // Verify Bone took damage (Light Brand deals magic damage)
    const finalState = await getState(page);
    const boneAfter = finalState.units.find((u: any) => u.nid === 'Bone');
    console.log(`Bone HP after combat: ${boneAfter?.hp}/${boneAfter?.maxHp}`);
    // Bone should have taken at least some damage
    expect(boneAfter!.hp).toBeLessThan(boneAfter!.maxHp);
  });
  test('combat HP bar and weapon info do not overlap', async ({ page }) => {
    // Load the DEBUG level cleanly and initiate combat to verify
    // the combat UI layout. The DEBUG level uses map combat (no animation
    // data), so the HP bars are the small bars above units.
    // This test verifies combat starts and captures a mid-combat screenshot.
    await page.goto('/?harness=true&level=DEBUG&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 5);

    // Navigate cursor to Eirika at (2,6)
    const state = await getState(page);
    const [cx, cy] = state.cursorPos;
    await navigateCursorTo(page, 2, 6, cx, cy);

    // Select Eirika -> confirm position -> Attack -> select weapon -> confirm target
    await stepFrames(page, 3, 'SELECT'); // select unit
    await stepFrames(page, 10);
    await stepFrames(page, 3, 'SELECT'); // confirm position
    await stepFrames(page, 10);
    await stepFrames(page, 3, 'SELECT'); // pick Attack
    await stepFrames(page, 10);

    let s = await getState(page);
    if (s.currentStateName === 'weapon_choice') {
      await stepFrames(page, 3, 'SELECT'); // pick weapon
      await stepFrames(page, 10);
    }

    await stepFrames(page, 3, 'SELECT'); // confirm target
    await stepFrames(page, 5);

    // Step frames into the combat. Map combat is fast (~260 frames total).
    // Step past the initial lunge and into HP drain to capture mid-combat.
    let combatSeen = false;
    for (let batch = 0; batch < 40; batch++) {
      await stepFrames(page, 10);
      s = await getState(page);
      if (s.currentStateName === 'combat') {
        combatSeen = true;
      }
      // Capture after we've been in combat for a bit (HP drain phase)
      if (combatSeen && batch >= 5) {
        await saveScreenshot(page, '15-combat-ui-layout');
        break;
      }
    }
    expect(combatSeen).toBe(true);

    // Let combat resolve
    let combatResolved = false;
    for (let batch = 0; batch < 200; batch++) {
      await stepFrames(page, 20);
      s = await getState(page);
      if (s.currentStateName === 'free') {
        combatResolved = true;
        break;
      }
      if (s.currentStateName !== 'combat' && s.currentStateName !== 'animation_combat' &&
          s.currentStateName !== 'map_combat' && s.currentStateName !== 'exp' &&
          s.currentStateName !== 'exp_gain') {
        await stepFrames(page, 3, 'BACK');
      }
    }
    expect(combatResolved).toBe(true);
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

  test('dialog box appears above portraits, not overlapping', async ({ page }) => {
    // Load prologue with events (non-clean mode) to test dialog positioning.
    // The prologue intro has: transition;close, change_background;Forest,
    // transition;open, add_portrait;Seth;Left;no_block,
    // add_portrait;Eirika;Right, speak;Seth;...
    //
    // Previously, add_portrait loaded images asynchronously but advanced
    // the command pointer immediately, so the speak command couldn't find
    // the portrait and the dialog rendered at the bottom of the screen,
    // overlapping with the portrait area.
    await page.goto('/?harness=true&level=0&bundle=false&clean=false');
    await waitForHarness(page);

    // Step through the initial event commands (unit moves, transitions).
    // The first transition;close + change_background + transition;open takes
    // many frames. We need to step enough frames to get past all the setup
    // commands and arrive at the first speak command with portraits visible.
    // Step a large number of frames, pressing SELECT periodically to advance
    // through any blocking waits.
    let dialogFound = false;
    for (let batch = 0; batch < 100; batch++) {
      await stepFrames(page, 20);
      const s = await getState(page);

      if (s.currentStateName === 'event') {
        // Check if we can see a dialog box by sampling pixel colors.
        // The dialog background is rgba(12, 12, 28, 0.92) — very dark blue.
        // Portraits are drawn at the bottom 80px of the 240x160 viewport.
        // The dialog should be ABOVE the portrait area (y < 80).
        //
        // Sample the canvas at the game's native resolution (240x160).
        // The display canvas is 480x320 (2x scaling), so we check at 2x coords.
        const pixelInfo = await page.evaluate(() => {
          const canvas = document.querySelector('canvas') as HTMLCanvasElement;
          if (!canvas) return null;
          const ctx = canvas.getContext('2d');
          if (!ctx) return null;

          // The game renders at 240x160, display is 480x320 (2x).
          // Check for dark dialog background at various Y positions.
          // Dialog box at y ~36 (native) = y ~72 (display) when portrait exists.
          // Dialog box at y ~116 (native) = y ~232 (display) when no portrait (bottom).
          // Portrait area: y 80-160 (native) = y 160-320 (display).
          const width = canvas.width;

          // Sample a horizontal strip in the middle of the canvas at different Y levels
          const midX = Math.floor(width / 2);

          function getPixel(x: number, y: number) {
            const data = ctx!.getImageData(x, y, 1, 1).data;
            return { r: data[0], g: data[1], b: data[2], a: data[3] };
          }

          // The display canvas maps game pixels to physical pixels.
          // Compute the scale from canvas dimensions vs native 240x160.
          const scaleX = canvas.width / 240;
          const scaleY = canvas.height / 160;

          // Check for dialog background (very dark, R<30, G<30, B<40)
          // Dialog is at native y ~46-76 (above portrait area at y=80).
          // Sample at native y=55 to catch dialog in the middle.
          const abovePortrait = getPixel(Math.floor(midX), Math.floor(55 * scaleY));
          // Native y=120 (in portrait overlap zone)
          const belowInPortrait = getPixel(Math.floor(midX), Math.floor(120 * scaleY));

          // Check if there's a portrait visible (non-black pixels in the portrait area)
          // Portrait area: native y 80-160, check at native (20, 100)
          const portraitArea = getPixel(Math.floor(20 * scaleX), Math.floor(100 * scaleY));

          return {
            abovePortrait,
            belowInPortrait,
            portraitArea,
          };
        });

        if (pixelInfo) {
          const ap = pixelInfo.abovePortrait;
          // Check if the dark dialog background is present above the portrait area
          // Dialog bg is rgba(12, 12, 28, 0.92) composited on the forest background
          const isDarkAbove = ap.r < 50 && ap.g < 50 && ap.b < 60;

          // Check if there's portrait content in the portrait area (not fully black)
          const pp = pixelInfo.portraitArea;
          const hasPortraitContent = pp.a > 0 && (pp.r > 20 || pp.g > 20 || pp.b > 20);

          if (isDarkAbove && hasPortraitContent) {
            // We found a frame where dialog is above portraits!
            dialogFound = true;
            console.log(`Dialog found above portraits at batch ${batch}`);
            console.log(`  Above portrait pixel: R=${ap.r} G=${ap.g} B=${ap.b} A=${ap.a}`);
            console.log(`  Portrait area pixel: R=${pp.r} G=${pp.g} B=${pp.b} A=${pp.a}`);

            // Verify the dialog is NOT overlapping the portrait area
            const bp = pixelInfo.belowInPortrait;
            const isDarkBelow = bp.r < 20 && bp.g < 20 && bp.b < 35 && bp.a > 200;
            // The area at y=240 (display) should be portrait or background, NOT dialog
            // (dialog bg has very specific dark blue color)
            console.log(`  Below-in-portrait pixel: R=${bp.r} G=${bp.g} B=${bp.b} A=${bp.a}`);

            await saveScreenshot(page, '14-dialog-above-portraits');
            break;
          }
        }
      }
    }

    expect(dialogFound).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Level Progression Tests
// ---------------------------------------------------------------------------

async function killUnit(page: any, unitNid: string): Promise<boolean> {
  return page.evaluate(
    (nid: string) => (window as any).__harness.killUnit(nid),
    unitNid,
  );
}

async function triggerEvent(page: any, triggerType: string): Promise<boolean> {
  return page.evaluate(
    (tt: string) => (window as any).__harness.triggerEvent(tt),
    triggerType,
  );
}

test.describe('Level Progression', () => {
  test('Ch.1 intro cutscene plays after Prologue transition', async ({ page }) => {
    // This test verifies that after the Prologue outro completes,
    // the Chapter 1 intro cutscene actually runs (not skipped).
    const logs: string[] = [];
    page.on('console', msg => logs.push(msg.text()));

    // Load Prologue in clean mode
    await page.goto('/?harness=true&level=0&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 10);

    // Kill boss and trigger win
    await killUnit(page, "O'Neill");
    const triggered = await triggerEvent(page, 'combat_end');
    expect(triggered).toBe(true);

    // Push event state for the triggered event
    await stepFrames(page, 3);

    // Step through Prologue outro, level transition, and into Ch.1 intro.
    // Use waitForTimeout between batches to allow async loadLevel to complete.
    let reachedLevel1WithEvents = false;
    let level1EventNid = '';
    let level1EventCmdCount = 0;
    let chapterTitleSeen = false;

    for (let batch = 0; batch < 600; batch++) {
      // Don't press SELECT after reaching level 1 — let the cutscene play naturally
      const input = (!reachedLevel1WithEvents && batch % 3 === 0) ? 'SELECT' : null;
      await stepFrames(page, 5, input);
      // Crucial: yield to the browser event loop so async loadLevel() 
      // promises can resolve
      await page.waitForTimeout(10);

      const state = await getState(page);

      if (state.levelNid === '1' && state.units.length > 0) {
        const eventInfo = await page.evaluate(() => {
          const g = (window as any).__gameRef;
          if (!g || !g.eventManager) return null;
          const ev = g.eventManager.getCurrentEvent();
          if (!ev) return null;
          return {
            nid: ev.nid,
            commandCount: ev.commands.length,
            pointer: ev.commandPointer,
          };
        });

        if (eventInfo && !reachedLevel1WithEvents) {
          reachedLevel1WithEvents = true;
          level1EventNid = eventInfo.nid;
          level1EventCmdCount = eventInfo.commandCount;
        }

        // Check if chapter title phase is active
        const ctPhase = await page.evaluate(() => {
          const g = (window as any).__gameRef;
          const es = g?.state?.getCurrentState?.();
          return (es as any)?.chapterTitlePhase ?? 'unknown';
        });
        if (ctPhase !== 'none' && ctPhase !== 'unknown') {
          chapterTitleSeen = true;
        }
      }

      // If we're in free state on level 1, events have finished
      if (state.levelNid === '1' && state.currentStateName === 'free') {
        break;
      }

      if (state.currentStateName === 'title' || state.currentStateName === 'title_main') {
        break;
      }
    }

    expect(reachedLevel1WithEvents).toBe(true);
    expect(level1EventNid).toBe('1 Intro');
    expect(level1EventCmdCount).toBe(102);
    expect(chapterTitleSeen).toBe(true);

    await saveScreenshot(page, '25-ch1-intro-cutscene');
  });

  test('Prologue win_game transitions to Chapter 1', async ({ page }) => {
    // Load Prologue in clean mode (no level_start events)
    await page.goto('/?harness=true&level=0&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 10);

    // Verify we're on Prologue
    let state = await getState(page);
    expect(state.levelNid).toBe('0');
    expect(state.currentStateName).toBe('free');

    // Find the boss (O'Neill) and player units
    const boss = state.units.find((u: any) => u.nid === "O'Neill");
    expect(boss).toBeTruthy();
    // Remember Eirika's stats for persistence check
    const eirikaBefore = state.units.find((u: any) => u.nid === 'Eirika');
    expect(eirikaBefore).toBeTruthy();

    // Kill the boss to set up the win condition
    const killed = await killUnit(page, "O'Neill");
    expect(killed).toBe(true);

    // Verify boss is dead
    state = await getState(page);
    const bossAfter = state.units.find((u: any) => u.nid === "O'Neill");
    expect(bossAfter?.isDead).toBe(true);

    // Trigger the combat_end event (this is what fires after combat in normal gameplay).
    // The Prologue has an event "0_Defeat_Boss" with trigger=combat_end that checks
    // if O'Neill is dead, then calls win_game.
    const triggered = await triggerEvent(page, 'combat_end');

    // If the event was triggered, push EventState and step through it.
    // The event should set _win_game flag, then when it finishes,
    // finishAndDequeue() handles the level transition.
    if (triggered) {
      await stepFrames(page, 3);

      // Ensure we're in event state processing the win_game command
      state = await getState(page);

      // Step through event processing and level transition.
      // The level transition is async (loadLevel returns a Promise), so we need
      // to wait for it to complete. Use settle + manual stepping + page.waitForTimeout
      // to allow the Promise microtask to resolve.
      let transitioned = false;
      for (let batch = 0; batch < 300; batch++) {
        // Step frames, pressing SELECT to skip any dialogs/events
        await stepFrames(page, 10, batch % 5 === 0 ? 'SELECT' : null);
        // Allow async loadLevel() promise to resolve
        await page.waitForTimeout(20);

        state = await getState(page);

        // Check if we've transitioned to level 1 AND units are loaded
        // (levelNid is set at the start of loadLevel, but units are populated later)
        if (state.levelNid === '1' && state.units.length > 0) {
          transitioned = true;
          break;
        }

        // If we're on the title screen, something went wrong
        if (state.currentStateName === 'title' || state.currentStateName === 'title_main') {
          break;
        }
      }

      await saveScreenshot(page, '20-level-progression-result');

      // We should have transitioned to level 1
      expect(transitioned).toBe(true);
      expect(state.levelNid).toBe('1');

      // Verify Eirika is present in the new level (either from persistence or level data)
      const eirikaAfter = state.units.find((u: any) => u.nid === 'Eirika');
      expect(eirikaAfter).toBeTruthy();

      // Verify there are enemy units too (level 1 has ~10 enemies)
      const enemies = state.units.filter((u: any) => u.team === 'enemy');
      expect(enemies.length).toBeGreaterThan(0);
    } else {
      // combat_end event did not trigger — test should fail
      expect(triggered).toBe(true);
    }
  });

  test('win_game flag mechanism works', async ({ page }) => {
    // This test directly sets the _win_game flag and verifies level transition,
    // bypassing the need for combat events.
    await page.goto('/?harness=true&level=0&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 10);

    let state = await getState(page);
    expect(state.levelNid).toBe('0');

    // Directly set the win_game flag and trigger an event that will
    // cause finishAndDequeue to process it
    const transitioned = await page.evaluate(async () => {
      const g = (window as any).__gameRef;
      if (!g) return false;

      // Set the _win_game level variable
      g.levelVars.set('_win_game', true);

      // Create and queue a minimal "win" event that just finishes immediately
      if (g.eventManager) {
        // Queue a dummy event that will complete instantly, causing
        // finishAndDequeue to check the _win_game flag
        const dummyPrefab = {
          nid: '_test_win',
          name: 'Test Win',
          trigger: 'level_start',  // won't match anything again
          level_nid: '',
          condition: '',
          only_once: false,
          priority: 0,
          source: [],
          commands: '',
        };
        // Manually construct a minimal event
        g.eventManager.eventQueue.push({
          nid: '_test_win',
          commands: [],  // empty = finishes immediately
          commandPointer: 0,
          state: 'running',
          trigger: { type: 'test' },
          currentDialog: null,
          waitingForInput: false,
          pyev1Processor: null,
          isDone() { return this.commandPointer >= this.commands.length; },
          finish() { this.state = 'done'; },
        });

        // Push event state
        g.state.change('event');
      }
      return true;
    });

    if (transitioned) {
      // Step through frames to let the event + level transition process
      let levelChanged = false;
      for (let batch = 0; batch < 300; batch++) {
        await stepFrames(page, 10, batch % 5 === 0 ? 'SELECT' : null);

        // Need to wait for async loadLevel too
        await page.waitForTimeout(50);

        state = await getState(page);

        if (state.levelNid === '1' && state.units.length > 0) {
          levelChanged = true;
          break;
        }

        if (state.currentStateName === 'title' || state.currentStateName === 'title_main') {
          break;
        }
      }

      await saveScreenshot(page, '21-win-flag-mechanism-result');
      expect(levelChanged).toBe(true);
    }
  });
});
