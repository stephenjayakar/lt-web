import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

interface EotfLevel {
  nid: string;
  name: string;
}

const projectRoot = path.join(process.cwd(), 'lt-maker/eotf.ltproj');
const projectAvailable = fs.existsSync(path.join(projectRoot, 'game_data/levels.json'));
const levels = projectAvailable
  ? JSON.parse(fs.readFileSync(
      path.join(projectRoot, 'game_data/levels.json'),
      'utf8',
    )) as EotfLevel[]
  : [];
const settledStates = new Set(['free', 'free_roam', 'prep_main', 'base_main']);

function expectedAssetNoise(text: string): boolean {
  return /404|Failed to load resource|not found \S*\.(png|ogg|mp3|wav|idx)/i.test(text);
}

function compatibilityFailure(text: string): boolean {
  return /EventCondition(?: JS eval failed|: cannot evaluate)|unknown (?:state|command|component)|event UI component is not implemented|failed to load level|Unhandled|PAGEERROR/i.test(text);
}

async function waitForHarness(page: Page): Promise<void> {
  await page.waitForFunction(() => (window as any).__harness?.ready === true, {
    timeout: 30_000,
  });
}

test.describe('Embrace of the Fog project compatibility', () => {
  test.skip(!projectAvailable, 'lt-maker/eotf.ltproj is not installed');

  test('project picker discovers a linked EotF checkout with a friendly name', async ({ page }) => {
    await page.goto('/');
    await expect(
      page.getByRole('button', { name: 'Launch Embrace of the Fog' }),
    ).toBeVisible();
  });

  test('EotF expression scope exposes game units and item availability', async ({ page }) => {
    const failures: string[] = [];
    page.on('console', (message) => {
      const text = message.text();
      if (text.includes('EventCondition JS eval failed')) failures.push(text);
    });
    await page.goto('/?harness=true&project=eotf.ltproj&level=X&clean=true&bundle=false');
    await waitForHarness(page);

    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { evaluateCondition } = await import('/src/events/event-manager.ts');
      const unit = game.units.get('Player');
      const context = {
        game,
        unit1: unit,
        gameVars: game.gameVars,
        levelVars: game.levelVars,
      };
      return {
        keyblade: evaluateCondition(
          "item_system.available(unit, DB.items.get('Keyblade'))",
          context,
        ),
        pylon: evaluateCondition(
          "any([u.position for u in game.units if u.klass == 'Pylon' and not is_dead(u.nid)])",
          context,
        ),
      };
    });

    expect(result.keyblade).toEqual(expect.any(Boolean));
    expect(result.pylon).toEqual(expect.any(Boolean));
    expect(failures).toEqual([]);
  });

  test('all levels clean boot without runtime failures', async ({ page }) => {
    test.setTimeout(12 * 60_000);
    const failures: string[] = [];
    let currentLevel = 'startup';
    page.on('pageerror', (error) => {
      failures.push(`${currentLevel}: PAGEERROR: ${error.message}`);
    });
    page.on('console', (message) => {
      const text = message.text();
      if (!expectedAssetNoise(text) && compatibilityFailure(text)) {
        failures.push(`${currentLevel}: ${message.type().toUpperCase()}: ${text}`);
      }
    });

    for (const level of levels) {
      currentLevel = level.nid;
      await page.goto(`/?harness=true&project=eotf.ltproj&level=${encodeURIComponent(level.nid)}&clean=true&bundle=false`);
      await waitForHarness(page);
      await page.evaluate(() => (window as any).__harness.stepFrames(3, null));
      const state = await page.evaluate(() => (window as any).__harness.getState());
      if (state.levelNid !== level.nid) {
        failures.push(`${level.nid}: loaded level ${String(state.levelNid)}`);
      }
      if (!settledStates.has(state.currentStateName)) {
        failures.push(`${level.nid}: clean boot ended in ${String(state.currentStateName)}`);
      }
    }

    expect(failures, failures.join('\n')).toEqual([]);
  });

  test('all level-start event queues settle without compatibility failures', async ({ page }) => {
    test.setTimeout(15 * 60_000);
    const failures: string[] = [];
    let currentLevel = 'startup';
    page.on('pageerror', (error) => {
      failures.push(`${currentLevel}: PAGEERROR: ${error.message}`);
    });
    page.on('console', (message) => {
      const text = message.text();
      if (!expectedAssetNoise(text) && compatibilityFailure(text)) {
        failures.push(`${currentLevel}: ${message.type().toUpperCase()}: ${text}`);
      }
    });

    for (const level of levels) {
      currentLevel = level.nid;
      await page.goto(`/?harness=true&project=eotf.ltproj&level=${encodeURIComponent(level.nid)}&clean=false&bundle=false`);
      await waitForHarness(page);
      await page.evaluate(() => (window as any).__harness.settle(1_500));
      const state = await page.evaluate(() => (window as any).__harness.getState());
      if (state.levelNid !== level.nid) {
        failures.push(`${level.nid}: loaded level ${String(state.levelNid)}`);
      }
      if (!settledStates.has(state.currentStateName)) {
        failures.push(
          `${level.nid}: level_start ended in ${String(state.currentStateName)} [${state.stateStack.join(', ')}]`,
        );
      }
    }

    expect(failures, failures.join('\n')).toEqual([]);
  });
});
