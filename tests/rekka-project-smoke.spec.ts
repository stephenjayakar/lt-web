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

  test('event skill stacks and object-valued item loops preserve Rekka semantics', async ({ page }) => {
    await page.goto('/?harness=true&project=rekka.ltproj&level=0&clean=true&bundle=false');
    await waitForHarness(page);
    await page.evaluate(() => (window as any).__harness.stepFrames(3, null));

    await page.evaluate(() => {
      const game = (window as any).__gameRef;
      const lyn = game.units.get('Lyn');
      const target = game.units.get('101');
      if (!lyn || !target) throw new Error('Rekka Prologue units missing');
      const nid = 'TestRekkaStackAndClone';
      game.db.events.set(nid, {
        name: nid, nid, trigger: nid,
        level_nid: game.currentLevel?.nid ?? null,
        condition: 'True', only_once: false, priority: 0,
        _source: [
          'give_skill;Lyn;MomentumStack;;no_banner',
          'give_skill;Lyn;MomentumStack;;no_banner',
          'give_skill;Lyn;MomentumStack;;no_banner',
          'give_skill;Lyn;MomentumStack;;no_banner',
          'give_skill;Lyn;MomentumStack;;no_banner',
          'remove_skill;Lyn;MomentumStack;1;no_banner',
          'give_skill;Lyn;NineLives;;persistent;no_banner',
          'for;item_clone;[item for item in unit.items]',
          'give_item;101;{item_clone};no_banner',
          'endf',
          'game_var;rekka_stack_clone_done;yes',
        ],
      });
      game.levelVars.set('__target_items_before', target.items.length);
      game.levelVars.set('__source_item_nids', lyn.items.map((item: any) => item.nid));
      game.eventManager.triggerSpecific(nid, {
        type: nid,
        unitNid: lyn.nid,
        unit1: lyn,
      }, true);
      game.state.change('event');
    });
    await page.evaluate(() => (window as any).__harness.stepFrames(30, null));

    const result = await page.evaluate(() => {
      const game = (window as any).__gameRef;
      const lyn = game.units.get('Lyn');
      const target = game.units.get('101');
      const nineLives = lyn.skills.find((skill: any) => skill.nid === 'NineLives');
      const sourceNids = game.levelVars.get('__source_item_nids');
      const targetBefore = game.levelVars.get('__target_items_before');
      return {
        done: game.gameVars.get('rekka_stack_clone_done'),
        momentumStacks: lyn.skills.filter((skill: any) => skill.nid === 'MomentumStack').length,
        nineLivesSource: [
          nineLives?.data.get('sourceNid'),
          nineLives?.data.get('sourceType'),
        ],
        clonedNids: target.items.slice(targetBefore).map((item: any) => item.nid),
        sourceNids,
      };
    });
    expect(result).toEqual({
      done: 'yes',
      momentumStacks: 3,
      nineLivesSource: ['Lyn', 'personal'],
      clonedNids: result.sourceNids,
      sourceNids: result.sourceNids,
    });

    await page.evaluate(() => {
      const game = (window as any).__gameRef;
      const nid = 'TestRekkaRemoveAllStacks';
      game.db.events.set(nid, {
        name: nid, nid, trigger: nid,
        level_nid: game.currentLevel?.nid ?? null,
        condition: 'True', only_once: false, priority: 0,
        _source: ['remove_skill;Lyn;MomentumStack;;no_banner'],
      });
      game.eventManager.triggerSpecific(nid, { type: nid }, true);
      game.state.change('event');
    });
    await page.evaluate(() => (window as any).__harness.stepFrames(5, null));
    const remaining = await page.evaluate(() =>
      (window as any).__gameRef.units.get('Lyn').skills
        .filter((skill: any) => skill.nid === 'MomentumStack').length);
    expect(remaining).toBe(0);
  });

  test('permanent map animations are non-blocking and turnwheel-backed', async ({ page }) => {
    await page.goto('/?harness=true&project=rekka.ltproj&level=0&clean=true&bundle=false');
    await waitForHarness(page);
    await page.evaluate(() => {
      const game = (window as any).__gameRef;
      const nid = 'TestRekkaPermanentMapAnim';
      game.db.events.set(nid, {
        name: nid, nid, trigger: nid,
        level_nid: game.currentLevel?.nid ?? null,
        condition: 'True', only_once: false, priority: 0,
        _source: [
          'map_anim;BlueDot;Lyn;permanent',
          'game_var;rekka_map_anim_done;yes',
        ],
      });
      game.eventManager.triggerSpecific(nid, { type: nid }, true);
      game.state.change('event');
    });
    await page.evaluate(() => (window as any).__harness.stepFrames(3, null));

    const replay = await page.evaluate(() => {
      const game = (window as any).__gameRef;
      const snapshot = () => ({
        done: game.gameVars.get('rekka_map_anim_done'),
        animations: game.tilemap.animations
          .filter((animation: any) => animation.nid === 'BlueDot')
          .map((animation: any) => ({ loop: animation.loop })),
      });
      const added = snapshot();
      const marker = game.actionLog.undo();
      const animation = game.actionLog.undo();
      const undone = snapshot();
      animation.execute();
      marker.execute();
      return { added, undone, redone: snapshot() };
    });
    expect(replay).toEqual({
      added: { done: 'yes', animations: [{ loop: true }] },
      undone: { done: undefined, animations: [] },
      redone: { done: 'yes', animations: [{ loop: true }] },
    });
  });

  test('Chapter 28 Rath reinforcements spawn then move with no_follow as a flag', async ({ page }) => {
    await page.goto('/?harness=true&project=rekka.ltproj&level=28&clean=true&bundle=false');
    await waitForHarness(page);
    await page.evaluate(() => {
      const game = (window as any).__gameRef;
      const nid = 'TestRekkaRathinforcements';
      game.db.events.set(nid, {
        name: nid, nid, trigger: nid,
        level_nid: game.currentLevel?.nid ?? null,
        condition: 'True', only_once: false, priority: 0,
        _source: [
          'spawn_group;Rathinforcements;north;16,0;normal;stack;no_follow',
          'move_group;Rathinforcements;Rathinforcements;no_follow',
          'game_var;rekka_rath_group_done;yes',
        ],
      });
      game.eventManager.triggerSpecific(nid, { type: nid }, true);
      game.state.change('event');
    });
    await page.evaluate(() => (window as any).__harness.stepFrames(2, null));
    const blocking = await page.evaluate(() => {
      const game = (window as any).__gameRef;
      return {
        done: game.gameVars.get('rekka_rath_group_done'),
        moving: game.movementSystem.isMoving(),
      };
    });
    expect(blocking).toEqual({ done: undefined, moving: true });

    await page.evaluate(() => (window as any).__harness.stepFrames(100, null));
    const settled = await page.evaluate(() => {
      const game = (window as any).__gameRef;
      const expected = game.currentLevel.unit_groups
        .find((group: any) => group.nid === 'Rathinforcements').positions;
      return {
        done: game.gameVars.get('rekka_rath_group_done'),
        units: ['468', '469', 'Rath'].map((nid) => {
          const unit = game.units.get(nid);
          return {
            nid,
            position: [...unit.position],
            expected: expected[nid],
            board: game.board.getUnit(...unit.position)?.nid,
          };
        }),
      };
    });
    expect(settled.done).toBe('yes');
    for (const unit of settled.units) {
      expect(unit.position).toEqual(unit.expected);
      expect(unit.board).toBe(unit.nid);
    }
  });

  test('Rekka vendor and prep commands open with their project data', async ({ page }) => {
    await page.goto('/?harness=true&project=rekka.ltproj&level=0&clean=true&bundle=false');
    await waitForHarness(page);
    await page.evaluate(() => {
      const game = (window as any).__gameRef;
      const nid = 'TestRekkaVendor';
      game.db.events.set(nid, {
        name: nid, nid, trigger: nid,
        level_nid: game.currentLevel?.nid ?? null,
        condition: 'True', only_once: false, priority: 0,
        _source: ['shop;Lyn;Vulnerary,Heal,Fire;vendor'],
      });
      game.eventManager.triggerSpecific(nid, { type: nid }, true);
      game.state.change('event');
    });
    await page.evaluate(() => (window as any).__harness.stepFrames(3, null));
    const shop = await page.evaluate(() => {
      const state: any = (window as any).__gameRef.state.getCurrentState();
      return {
        state: state.name,
        unit: state.unit?.nid,
        items: state.shopItems.map((item: any) => item.nid),
      };
    });
    expect(shop).toEqual({
      state: 'shop',
      unit: 'Lyn',
      items: ['Vulnerary', 'Heal', 'Fire'],
    });

    await page.goto('/?harness=true&project=rekka.ltproj&level=7&clean=true&bundle=false');
    await waitForHarness(page);
    await page.evaluate(() => {
      const game = (window as any).__gameRef;
      const nid = 'TestRekkaPrep';
      game.db.events.set(nid, {
        name: nid, nid, trigger: nid,
        level_nid: game.currentLevel?.nid ?? null,
        condition: 'True', only_once: false, priority: 0,
        _source: ['prep;t;skateboard_p_instrumental'],
      });
      game.eventManager.triggerSpecific(nid, { type: nid }, true);
      game.state.change('event');
    });
    await page.evaluate(() => (window as any).__harness.stepFrames(3, null));
    const prep = await page.evaluate(() => {
      const game = (window as any).__gameRef;
      return {
        state: game.state.getCurrentState()?.name,
        pick: game.levelVars.get('_prep_pick'),
        music: game.gameVars.get('_prep_music'),
      };
    });
    expect(prep).toEqual({
      state: 'prep_main',
      pick: true,
      music: 'skateboard_p_instrumental',
    });
  });
});
