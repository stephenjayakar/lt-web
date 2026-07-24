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

  test('Split uses make_generic created_unit and clones the source loadout', async ({ page }) => {
    await page.goto('/?harness=true&project=rekka.ltproj&level=0&clean=true&bundle=false');
    await waitForHarness(page);
    const before = await page.evaluate(() => {
      const game = (window as any).__gameRef;
      const lyn = game.units.get('Lyn');
      return {
        unitNids: [...game.units.keys()],
        position: [...lyn.position],
        klass: lyn.klass,
        level: lyn.level,
        hp: lyn.stats.HP,
        items: lyn.items.map((item: any) => item.nid),
        skills: lyn.skills.map((skill: any) => skill.nid).sort(),
      };
    });
    await page.evaluate(() => {
      const game = (window as any).__gameRef;
      const lyn = game.units.get('Lyn');
      game.eventManager.triggerSpecific('Global Ability_Split', {
        type: 'Global Ability_Split',
        unitNid: lyn.nid,
        unit1: lyn,
      }, true);
      game.state.change('event');
    });
    await page.evaluate(() => (window as any).__harness.stepFrames(80, null));

    const split = await page.evaluate((oldNids) => {
      const game = (window as any).__gameRef;
      const created = [...game.units.values()].find((unit: any) =>
        !oldNids.includes(unit.nid) && unit.generic);
      if (!created) return null;
      return {
        nid: created.nid,
        team: created.team,
        klass: created.klass,
        level: created.level,
        position: created.position ? [...created.position] : null,
        hp: created.stats.HP,
        items: created.items.map((item: any) => item.nid),
        skills: created.skills.map((skill: any) => skill.nid).sort(),
      };
    }, before.unitNids);
    expect(split).not.toBeNull();
    expect(split!.team).toBe('player');
    expect(split!.klass).toBe(before.klass);
    expect(split!.level).toBe(before.level);
    expect(split!.items).toEqual(before.items);
    expect(split!.skills).toEqual(before.skills);
    expect(split!.hp).toBe(Math.floor(before.hp / 2));
    expect(Math.abs(split!.position[0] - before.position[0]) +
      Math.abs(split!.position[1] - before.position[1])).toBe(1);
  });

  test('Resourceful and Global Setup consume their exact dynamic option/component data', async ({ page }) => {
    await page.goto('/?harness=true&project=rekka.ltproj&level=0&clean=true&bundle=false');
    await waitForHarness(page);
    const resourcefulCondition = await page.evaluate(async () => {
      const { createItemTree } = await import('/src/objects/item.ts');
      const { SkillObject } = await import('/src/objects/skill.ts');
      const { evaluateCondition, evaluateExpression } = await import('/src/events/event-manager.ts');
      const game = (window as any).__gameRef;
      const lyn = game.units.get('Lyn');
      const ring = createItemTree(
        game.db.items.get('DuelRing'),
        (nid: string) => game.db.items.get(nid),
      );
      ring.owner = lyn;
      lyn.items.push(ring);
      lyn.equippedAccessory = ring;
      lyn.skills = lyn.skills.filter((skill: any) => skill.nid !== 'Duel');
      lyn.skills.push(new SkillObject(game.db.skills.get('Duel')));
      game.eventManager.triggerSpecific('Global Ability_Resourceful', {
        type: 'Global Ability_Resourceful',
        unitNid: lyn.nid,
        unit1: lyn,
      }, true);
      game.state.change('event');
      const context = { game, unit1: lyn, gameVars: game.gameVars, levelVars: game.levelVars };
      return {
        condition: evaluateCondition(
          '1 == item_funcs.num_stacks(unit, unit.get_accessory().status_on_equip.value)',
          context,
        ),
        expressionStatus: evaluateExpression(
          'unit.get_accessory().status_on_equip.value',
          context,
        ),
        expressionCount: evaluateExpression(
          "item_funcs.num_stacks(unit, 'Duel')",
          context,
        ),
        accessory: lyn.getEquippedAccessory()?.nid ?? null,
        status: lyn.getEquippedAccessory()?.getComponent('status_on_equip') ?? null,
        duelCount: lyn.skills.filter((skill: any) => skill.nid === 'Duel').length,
      };
    });
    expect(resourcefulCondition).toEqual({
      condition: true,
      expressionStatus: 'Duel',
      expressionCount: 1,
      accessory: 'DuelRing',
      status: 'Duel',
      duelCount: 1,
    });
    await page.evaluate(() => (window as any).__harness.stepFrames(10, null));
    const resourceful = await page.evaluate(() => {
      const lyn = (window as any).__gameRef.units.get('Lyn');
      return lyn.skills
        .filter((skill: any) => skill.nid === 'Duel')
        .map((skill: any) => skill.components.get('stax'));
    });
    expect(resourceful).toEqual([2]);

    await page.evaluate(() => {
      const game = (window as any).__gameRef;
      game.eventManager.triggerSpecific('Global Setup', {
        type: 'Global Setup',
      }, true);
      game.state.change('event');
    });
    await page.evaluate(() => (window as any).__harness.stepFrames(10, null));
    const setup = await page.evaluate(() => {
      const game = (window as any).__gameRef;
      return {
        convoy: game.gameVars.get('_convoy'),
        options: game.gameVars.get('_custom_additional_options'),
        disabled: game.gameVars.get('_custom_options_disabled'),
        desc: game.gameVars.get('_custom_info_desc'),
        events: game.gameVars.get('_custom_options_events'),
      };
    });
    expect(setup).toEqual({
      convoy: 1,
      options: ['Save'],
      disabled: [false],
      desc: ['Save the game.'],
      events: ['Please'],
    });
  });

  test('Glutton and both Capture Art branches pair their real event targets', async ({ page }) => {
    const scenarios = [
      { eventNid: 'Global Ability_GluttonInhale', hp: 20, branch: 'glutton' },
      { eventNid: 'Global Ability_CaptureArt', hp: 0, branch: 'capture-defeated' },
      { eventNid: 'Global Ability_CaptureArt', hp: 20, branch: 'capture-unarmed' },
    ];

    for (const scenario of scenarios) {
      await page.goto('/?harness=true&project=rekka.ltproj&level=0&clean=true&bundle=false');
      await waitForHarness(page);
      await page.evaluate(({ eventNid, hp }) => {
        const game = (window as any).__gameRef;
        const lyn = game.units.get('Lyn');
        const target = game.units.get('101');
        target.currentHp = Math.min(hp, target.getMaxHP());
        target.items = [];
        target.equippedWeapon = null;
        game.eventManager.triggerSpecific(eventNid, {
          type: eventNid,
          unitNid: lyn.nid,
          unit1: lyn,
          unit2: target,
        }, true);
        game.state.change('event');
      }, scenario);
      await page.evaluate(() => (window as any).__harness.stepFrames(12, null));

      const result = await page.evaluate(() => {
        const game = (window as any).__gameRef;
        const lyn = game.units.get('Lyn');
        const target = game.units.get('101');
        return {
          leaderTraveler: lyn.traveler,
          leaderRescuing: lyn.rescuing?.nid ?? null,
          targetRescuedBy: target.rescuedBy?.nid ?? null,
          targetPosition: target.position,
          targetHp: target.currentHp,
          inhaled: lyn.skills.some((skill: any) => skill.nid === 'Inhaled'),
        };
      });
      expect(result.leaderTraveler, scenario.branch).toBe('101');
      expect(result.leaderRescuing, scenario.branch).toBe('101');
      expect(result.targetRescuedBy, scenario.branch).toBe('Lyn');
      expect(result.targetPosition, scenario.branch).toBeNull();
      expect(result.targetHp, scenario.branch).toBeGreaterThan(0);
      expect(result.inhaled, scenario.branch).toBe(scenario.branch === 'glutton');
    }
  });

  test('Final chapter boss events add the Nergals group and load Final_2', async ({ page }) => {
    await page.goto('/?harness=true&project=rekka.ltproj&level=46&clean=true&bundle=false');
    await waitForHarness(page);
    await page.evaluate(() => {
      const game = (window as any).__gameRef;
      for (const nid of ['linus', 'ursula', 'uhai', 'kenneth', 'jerme', 'darin', 'brendan']) {
        game.levelVars.set(nid, 1);
      }
      game.eventManager.triggerSpecific('46 LloydDead', {
        type: 'combat_end',
      }, true);
      game.state.change('event');
    });
    await page.evaluate(() => (window as any).__harness.stepFrames(20, null));
    const groupResult = await page.evaluate(() => {
      const game = (window as any).__gameRef;
      const expected = [
        'Pent', 'Evilwood', 'Louise', 'BattaTheBeast', 'Nergal', 'EvilLyn', 'Hectour',
        'gen_r_1', 'gen_r_2', 'gen_r_3', 'druid_r_1', 'druid_r_2',
      ];
      return {
        positions: Object.fromEntries(expected.map((nid) => [
          nid,
          game.units.get(nid)?.position ?? null,
        ])),
        gateVisible: game.tilemap.layers.find((layer: any) => layer.nid === 'Gate')?.visible,
      };
    });
    expect(Object.values(groupResult.positions).every(Boolean)).toBe(true);
    expect(groupResult.gateVisible).toBe(false);

    await page.goto('/?harness=true&project=rekka.ltproj&level=46&clean=true&bundle=false');
    await waitForHarness(page);
    await page.evaluate(() => {
      const game = (window as any).__gameRef;
      for (const nid of ['one', 'two', 'three', 'four', 'five', 'six', 'seven']) {
        game.levelVars.set(nid, []);
      }
      game.eventManager.triggerSpecific('46 NergalDead', {
        type: 'combat_end',
      }, true);
      game.state.change('event');
    });
    await page.evaluate(() => (window as any).__harness.stepFrames(190, null));
    await page.waitForFunction(() => (window as any).__gameRef.tilemap?.nid === 'Final_2');
    expect(await page.evaluate(() => (window as any).__gameRef.tilemap.nid)).toBe('Final_2');
  });

  test('Chapter 7 preparations expose manage, formation, options, save, and fight', async ({ page }, testInfo) => {
    await page.goto('/?harness=true&project=rekka.ltproj&level=7&clean=false&bundle=false');
    await waitForHarness(page);
    await page.evaluate(() => (window as any).__harness.settle(1_200));
    await page.evaluate(() => {
      const game = (window as any).__gameRef;
      game.eventManager.triggerSpecific('Global Setup', { type: 'Global Setup' }, true);
      game.state.change('event');
      (window as any).__harness.settle(100);
    });

    const prep = await page.evaluate(() => {
      const game = (window as any).__gameRef;
      const state = game.state.getCurrentState() as any;
      return {
        state: state?.name,
        options: [...(state?.options ?? [])],
        convoy: game.gameVars.get('_convoy'),
        music: game.gameVars.get('_prep_music'),
      };
    });
    expect(prep).toEqual({
      state: 'prep_main',
      options: ['Pick Units', 'Manage', 'Formation', 'Options', 'Save', 'Fight'],
      convoy: 1,
      music: 'skateboard_p_instrumental',
    });
    await page.locator('#game-canvas').screenshot({
      path: testInfo.outputPath('rekka-chapter-7-preparations.png'),
    });

    const openPrepOption = async (label: string) => {
      await page.evaluate((wanted) => {
        const state = (window as any).__gameRef.state.getCurrentState() as any;
        state.cursor = state.options.indexOf(wanted);
      }, label);
      await page.evaluate(() => (window as any).__harness.stepFrames(1, 'SELECT'));
    };

    await openPrepOption('Manage');
    expect(await page.evaluate(() => (window as any).__gameRef.state.getCurrentState()?.name)).toBe('base_manage');
    await page.evaluate(() => (window as any).__harness.stepFrames(1, 'BACK'));
    expect(await page.evaluate(() => (window as any).__gameRef.state.getCurrentState()?.name)).toBe('prep_main');

    await openPrepOption('Formation');
    expect(await page.evaluate(() => (window as any).__gameRef.state.getCurrentState()?.name)).toBe('prep_formation');
    const formation = await page.evaluate(() => {
      const game = (window as any).__gameRef;
      const unit = [...game.units.values()].find((candidate: any) =>
        candidate.team === 'player' && candidate.position);
      const formationSpots = game.currentLevel.regions
        .filter((region: any) => region.region_type === 'formation')
        .flatMap((region: any) => {
          const positions = [];
          for (let x = 0; x < (region.size?.[0] ?? 1); x++) {
            for (let y = 0; y < (region.size?.[1] ?? 1); y++) {
              positions.push([region.position[0] + x, region.position[1] + y]);
            }
          }
          return positions;
        });
      const target = formationSpots.find(([x, y]: [number, number]) =>
        !game.board.getUnit(x, y));
      if (!unit || !target) return null;
      const before = [...unit.position];
      game.cursor.setPos(unit.position[0], unit.position[1]);
      game.state.getCurrentState().takeInput('SELECT');
      game.cursor.setPos(target[0], target[1]);
      game.state.getCurrentState().takeInput('SELECT');
      return { before, target, after: [...unit.position] };
    });
    expect(formation).not.toBeNull();
    expect(formation!.after).toEqual(formation!.target);
    expect(formation!.after).not.toEqual(formation!.before);
    await page.evaluate(() => (window as any).__harness.stepFrames(1, 'BACK'));

    await openPrepOption('Options');
    expect(await page.evaluate(() => (window as any).__gameRef.state.getCurrentState()?.name)).toBe('settings_menu');
    await page.evaluate(() => (window as any).__harness.stepFrames(1, 'BACK'));

    await openPrepOption('Save');
    expect(await page.evaluate(() => (window as any).__gameRef.state.getCurrentState()?.name)).toBe('save_menu');
    await page.evaluate(() => (window as any).__gameRef.state.back());
    await page.evaluate(() => (window as any).__harness.stepFrames(2, null));
    expect(await page.evaluate(() => (window as any).__gameRef.state.getCurrentState()?.name)).toBe('prep_main');
  });

  test('Rekka DEBUG base enables save and Continue resumes its parent event', async ({ page }) => {
    await page.goto('/?harness=true&project=rekka.ltproj&level=DEBUG&clean=false&bundle=false');
    await waitForHarness(page);
    await page.evaluate(() => (window as any).__harness.stepFrames(10, null));
    const baseOptions = await page.evaluate(() => {
      const state = (window as any).__gameRef.state.getCurrentState() as any;
      return {
        state: state?.name,
        options: state?.menu?.options.map((option: any) => ({
          label: option.label,
          enabled: option.enabled,
        })) ?? [],
      };
    });
    expect(baseOptions.state).toBe('base_main');
    expect(baseOptions.options).toEqual(expect.arrayContaining([
      { label: 'Manage', enabled: true },
      { label: 'Convos', enabled: true },
      { label: 'Codex', enabled: true },
      { label: 'Options', enabled: true },
      { label: 'Save', enabled: true },
      { label: 'Continue', enabled: true },
    ]));

    await page.evaluate(() => {
      const state = (window as any).__gameRef.state.getCurrentState() as any;
      state.menu.selectedIndex = state.menu.options.findIndex((option: any) => option.label === 'Save');
    });
    await page.evaluate(() => (window as any).__harness.stepFrames(1, 'SELECT'));
    expect(await page.evaluate(() => (window as any).__gameRef.state.getCurrentState()?.name)).toBe('save_menu');
    await page.evaluate(() => (window as any).__gameRef.state.back());
    await page.evaluate(() => (window as any).__harness.stepFrames(2, null));

    await page.evaluate(() => {
      const state = (window as any).__gameRef.state.getCurrentState() as any;
      state.menu.selectedIndex = state.menu.options.findIndex((option: any) => option.label === 'Continue');
    });
    await page.evaluate(() => (window as any).__harness.stepFrames(1, 'SELECT'));
    expect(await page.evaluate(() => (window as any).__gameRef.state.getCurrentState()?.name)).toBe('event');
    await page.evaluate(() => (window as any).__harness.settle(1_200));
    expect(await page.evaluate(() => (window as any).__gameRef.state.getCurrentState()?.name)).toBe('free');
  });

  test('Rekka chapter armory and vendor events open with their exact stock', async ({ page }) => {
    const scenarios = [
      {
        level: '3',
        eventNid: 'Global Armory',
        flavor: 'armory',
        items: ['Slim_Sword', 'Slim_Lance', 'Hand_Axe'],
      },
      {
        level: '7',
        eventNid: 'Global Vendor',
        flavor: 'vendor',
        items: ['Vulnerary', 'Heal', 'Fire'],
      },
    ];

    for (const scenario of scenarios) {
      await page.goto(`/?harness=true&project=rekka.ltproj&level=${scenario.level}&clean=true&bundle=false`);
      await waitForHarness(page);
      await page.evaluate(({ eventNid }) => {
        const game = (window as any).__gameRef;
        const shopper = [...game.units.values()].find((unit: any) => unit.team === 'player');
        game.getParty().money = 99_999;
        game.eventManager.triggerSpecific(eventNid, {
          type: eventNid,
          unitNid: shopper.nid,
          unit1: shopper,
        }, true);
        game.state.change('event');
      }, scenario);
      await page.evaluate(() => (window as any).__harness.stepFrames(30, null));

      const opened = await page.evaluate(() => {
        const game = (window as any).__gameRef;
        const state = game.state.getCurrentState() as any;
        return {
          state: state?.name,
          flavor: state?.shopFlavor,
          items: state?.shopItems.map((item: any) => item.nid) ?? [],
          stock: [...(state?.shopStock ?? [])],
        };
      });
      expect(opened).toEqual({
        state: 'shop',
        flavor: scenario.flavor,
        items: scenario.items,
        stock: scenario.items.map(() => -1),
      });
    }
  });
});
