import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

interface RekkaLevel {
  nid: string;
  name: string;
}

const levels = JSON.parse(fs.readFileSync(
  path.join(process.cwd(), 'lt-maker/rekka.ltproj/game_data/levels.json'),
  'utf8',
)) as RekkaLevel[];
const settledStates = new Set(['free', 'prep_main', 'base_main']);

function expectedAssetNoise(text: string): boolean {
  return /404|Failed to load resource|not found \S*\.(png|ogg|mp3|wav|idx)/i.test(text);
}

function compatibilityFailure(text: string): boolean {
  return /EventCondition JS eval failed|unknown (?:state|command|component)|event UI component is not implemented|failed to load level|Unhandled|PAGEERROR/i.test(text);
}

async function waitForHarness(page: Page): Promise<void> {
  await page.waitForFunction(() => (window as any).__harness?.ready === true, {
    timeout: 30_000,
  });
}

test.describe('Rekka all-level compatibility', () => {
  test('all levels clean boot without runtime failures', async ({ page }) => {
    test.setTimeout(5 * 60_000);
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
      await page.goto(`/?harness=true&project=rekka.ltproj&level=${encodeURIComponent(level.nid)}&clean=true&bundle=false`);
      await waitForHarness(page);
      await page.evaluate(() => (window as any).__harness.stepFrames(3, null));
      const state = await page.evaluate(() => (window as any).__harness.getState());
      if (state.levelNid !== level.nid) {
        failures.push(`${level.nid}: loaded level ${String(state.levelNid)}`);
      }
      if (state.currentStateName !== 'free') {
        failures.push(`${level.nid}: clean boot ended in ${String(state.currentStateName)}`);
      }
    }

    expect(failures, failures.join('\n')).toEqual([]);
  });

  test('all playable level-start event queues settle', async ({ page }) => {
    test.setTimeout(8 * 60_000);
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

    for (const level of levels.filter((entry) => entry.nid !== 'DEBUG')) {
      currentLevel = level.nid;
      await page.goto(`/?harness=true&project=rekka.ltproj&level=${encodeURIComponent(level.nid)}&clean=false&bundle=false`);
      await waitForHarness(page);
      await page.evaluate(() => (window as any).__harness.settle(1_200));
      const state = await page.evaluate(() => (window as any).__harness.getState());
      if (state.levelNid !== level.nid) {
        failures.push(`${level.nid}: loaded level ${String(state.levelNid)}`);
      }
      if (!settledStates.has(state.currentStateName)) {
        failures.push(`${level.nid}: level_start ended in ${String(state.currentStateName)} [${state.stateStack.join(', ')}]`);
      }
    }

    expect(failures, failures.join('\n')).toEqual([]);
  });
});
