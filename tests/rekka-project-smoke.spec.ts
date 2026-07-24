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
const rekkaManifest = JSON.parse(fs.readFileSync(
  path.join(process.cwd(), 'docs/parity/rekka-compat.json'),
  'utf8',
));
const expressionComponentNids = new Set([
  'condition',
  'combat_condition',
  'allowed_weapons',
  'eval_galeforce',
  'witch_warp_expression',
]);

function componentExpressions(): string[] {
  const values = ['items.json', 'skills.json'].flatMap((filename) =>
    JSON.parse(fs.readFileSync(
      path.join(process.cwd(), 'lt-maker/rekka.ltproj/game_data', filename),
      'utf8',
    )));
  const expressions = new Set<string>();
  const visit = (value: unknown): void => {
    if (!Array.isArray(value)) return;
    if (typeof value[0] === 'string' && expressionComponentNids.has(value[0]) &&
        typeof value[1] === 'string') {
      expressions.add(value[1]);
    }
    for (const child of value) visit(child);
  };
  visit(values);
  return [...expressions].sort();
}

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

  test('all item and skill expressions evaluate without fallback errors', async ({ page }) => {
    const failures: string[] = [];
    page.on('console', (message) => {
      if (compatibilityFailure(message.text())) failures.push(message.text());
    });
    await page.goto('/?harness=true&project=rekka.ltproj&level=0&clean=true&bundle=false');
    await waitForHarness(page);

    await page.evaluate(async (expressions) => {
      const { evaluateCondition } = await import('/src/events/event-manager.ts');
      const game = (window as any).__gameRef;
      const unit = game.units.get('Lyn');
      const target = game.units.get('101');
      const item = unit.items.find((candidate: any) => candidate.nid === 'Iron_Sword');
      unit.equippedWeapon = item;
      const targetWeapon = target.items.find((candidate: any) => candidate.hasComponent('weapon'));
      target.equippedWeapon = targetWeapon ?? null;
      for (const expression of expressions) {
        evaluateCondition(expression, {
          game,
          unit1: unit,
          unit2: target,
          item,
          gameVars: game.gameVars,
          levelVars: game.levelVars,
          localArgs: new Map([
            ['mode', 'attack'],
            ['stat_changes', {}],
          ]),
        });
      }
    }, componentExpressions());

    expect(failures, [...new Set(failures)].join('\n')).toEqual([]);
  });

  test('all event conditions evaluate without fallback errors', async ({ page }) => {
    const failures: string[] = [];
    page.on('console', (message) => {
      const text = message.text();
      // This is a static syntax/namespace sweep using a Prologue context. A
      // TypeError can be expected when a condition names a unit or region that
      // only exists in another chapter; SyntaxError/ReferenceError is always a
      // runtime compatibility defect regardless of chapter context.
      if (/EventCondition JS eval failed/.test(text) &&
          /SyntaxError|ReferenceError/.test(text)) {
        failures.push(text);
      }
    });
    await page.goto('/?harness=true&project=rekka.ltproj&level=0&clean=true&bundle=false');
    await waitForHarness(page);

    await page.evaluate(async (expressions) => {
      const { evaluateCondition } = await import('/src/events/event-manager.ts');
      const game = (window as any).__gameRef;
      const unit = game.units.get('Lyn');
      const target = game.units.get('101');
      const item = unit.items.find((candidate: any) => candidate.nid === 'Iron_Sword');
      const region = game.currentLevel?.regions?.[0] ?? null;
      for (const expression of expressions) {
        evaluateCondition(expression, {
          game,
          unit1: unit,
          unit2: target,
          item,
          region,
          position: unit.position,
          gameVars: game.gameVars,
          levelVars: game.levelVars,
          localArgs: new Map([
            ['mode', 'attack'],
            ['stat_changes', {}],
          ]),
        });
      }
    }, (rekkaManifest.expressions.conditions as string[])
      .filter((expression) => !expression.includes('{')));

    expect(failures, [...new Set(failures)].join('\n')).toEqual([]);
  });
});
