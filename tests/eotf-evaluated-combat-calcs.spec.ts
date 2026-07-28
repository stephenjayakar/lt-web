import { expect, test, type Page } from '@playwright/test';
import { prefabsWithComponent, skills } from './helpers/project-data';

async function bootEotf(page: Page): Promise<void> {
  await page.goto('/?harness=true&project=eotf.ltproj&level=X&clean=true&bundle=false');
  await page.waitForFunction(() => (window as any).__harness?.ready === true, undefined, {
    timeout: 60_000,
  });
}

const COMPONENTS = [
  'stat_change_expression',
  'stat_multiplier',
  'eval_damage',
  'eval_hit',
  'eval_avoid',
  'eval_crit',
  'dynamic_damage',
  'dynamic_resist',
  'dynamic_accuracy',
  'dynamic_avoid',
  'dynamic_crit_accuracy',
  'dynamic_crit_avoid',
  'dynamic_attack_speed',
  'dynamic_defense_speed',
  'dynamic_damage_multiplier',
];

test.describe('Embrace of the Fog evaluated combat calculations', () => {
  // Authored-catalog counts, so this reads the project data directly rather
  // than booting it in a browser.
  test('count-locks all 647 authored component uses', () => {
    const authored = skills();
    const counts = Object.fromEntries(COMPONENTS.map((componentNid) => [
      componentNid,
      new Set(prefabsWithComponent(authored, componentNid)).size,
    ]));

    expect(counts).toEqual({
      stat_change_expression: 84,
      stat_multiplier: 34,
      eval_damage: 30,
      eval_hit: 21,
      eval_avoid: 10,
      eval_crit: 17,
      dynamic_damage: 228,
      dynamic_resist: 70,
      dynamic_accuracy: 31,
      dynamic_avoid: 32,
      dynamic_crit_accuracy: 34,
      dynamic_crit_avoid: 24,
      dynamic_attack_speed: 18,
      dynamic_defense_speed: 8,
      dynamic_damage_multiplier: 6,
    });
    expect(Object.values(counts).reduce((total, count) => total + count, 0)).toBe(647);
  });

  test('applies stat, static, dynamic, multiplier, and true-speed hooks', async ({ page }) => {
    await bootEotf(page);
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { SkillObject } = await import('/src/objects/skill.ts');
      const { ItemObject } = await import('/src/objects/item.ts');
      const calcs = await import('/src/combat/combat-calcs.ts');
      const skills = await import('/src/combat/skill-system.ts');
      const unit = game.units.get('Player');
      const target = game.units.get('Keeper');
      unit.team = 'player';
      target.team = 'enemy';
      unit.stats.STR = 20;
      unit.stats.SPD = 10;
      unit.stats.CON = 10;
      unit.stats.SKL = 20;
      unit.stats.LCK = 10;
      target.stats.SPD = 14;
      target.stats.CON = 10;
      target.stats.LCK = 5;
      target.stats.DEF = 0;
      target.stats.RES = 0;
      const item = new ItemObject({
        nid: '_EvaluatedCombatWeapon',
        name: 'Evaluated combat weapon',
        desc: '',
        components: [
          ['weapon', null], ['damage', 0], ['hit', 50], ['crit', 0],
          ['weight', 0], ['min_range', 1], ['max_range', 1],
        ],
      });
      const item2 = new ItemObject({
        nid: '_EvaluatedCombatDefense',
        name: 'Evaluated combat defense',
        desc: '',
        components: [
          ['weapon', null], ['damage', 0], ['hit', 50],
          ['weight', 0], ['min_range', 1], ['max_range', 1],
        ],
      });
      unit.items = [item];
      unit.equippedWeapon = item;
      target.items = [item2];
      target.equippedWeapon = item2;
      const active = new SkillObject({
        nid: '_EvaluatedCombatActive',
        name: 'Evaluated combat active',
        desc: '',
        components: [
          ['stat_change_expression', [['STR', '5']]],
          ['stat_multiplier', [['STR', 1.5]]],
          ['eval_damage', '3'],
          ['eval_hit', '4'],
          ['eval_avoid', '5'],
          ['eval_crit', '6'],
          ['dynamic_damage', "base_value // 10 + attack_info[1] + 7"],
          ['dynamic_resist', '8'],
          ['dynamic_accuracy', '9'],
          ['dynamic_avoid', '10'],
          ['dynamic_crit_accuracy', '11'],
          ['dynamic_crit_avoid', '12'],
          ['dynamic_attack_speed', '13'],
          ['dynamic_defense_speed', '14'],
          ['dynamic_damage_multiplier', '0.5'],
        ],
      });
      const inactive = new SkillObject({
        nid: '_EvaluatedCombatInactive',
        name: 'Evaluated combat inactive',
        desc: '',
        components: [
          ['condition', 'False'],
          ['eval_damage', '999'],
          ['dynamic_damage', '999'],
        ],
      });
      unit.skills = [active, inactive];
      target.skills = [new SkillObject({
        nid: '_EvaluatedCombatTarget',
        name: 'Evaluated combat target',
        desc: '',
        components: [
          ['eval_avoid', '5'],
          ['dynamic_resist', '8'],
          ['dynamic_avoid', '10'],
          ['dynamic_crit_avoid', '12'],
          ['dynamic_defense_speed', '14'],
        ],
      })];
      const context: [number, number] = [1, 2];
      const hooks = {
        stat: unit.getStatValue('STR'),
        staticDamage: skills.modifyDamage(
          unit, item, game, target, item2, 'attack', context,
        ),
        staticHit: skills.modifyAccuracy(
          unit, item, game, target, item2, 'attack', context,
        ),
        staticAvoid: skills.modifyAvoid(
          unit, item, game, target, item2, 'attack', context,
        ),
        staticCrit: skills.modifyCritAccuracy(
          unit, item, game, target, item2, 'attack', context,
        ),
        dynamicDamage: skills.dynamicDamage(
          unit, item, target, item2, 'attack', context, 30, game,
        ),
        dynamicResist: skills.dynamicResist(
          target, item2, unit, item, 'attack', context, 30, game,
        ),
        dynamicHit: skills.dynamicAccuracy(
          unit, item, target, item2, 'attack', context, 30, game,
        ),
        dynamicAvoid: skills.dynamicAvoid(
          target, item2, unit, item, 'attack', context, 30, game,
        ),
        dynamicCrit: skills.dynamicCritAccuracy(
          unit, item, target, item2, 'attack', context, 30, game,
        ),
        dynamicDodge: skills.dynamicCritAvoid(
          target, item2, unit, item, 'attack', context, 30, game,
        ),
        multiplier: skills.damageMultiplier(
          unit, item, target, item2, 'attack', context, 30, game,
        ),
        trueSpeed: calcs.computeTrueSpeed(
          unit, item, target, item2, game.db, game, 'attack', context,
        ),
        doubles: calcs.canDouble(
          unit, item, target, item2, game.db, game, 'attack', context,
        ),
      };
      unit.stats.STR = 10;
      unit.skills = [];
      target.skills = [];
      const baseline = {
        damage: calcs.computeDamage(
          unit, item, target, game.db, game.board, game, 'attack', false, context,
        ),
        hit: calcs.computeHit(
          unit, item, target, game.db, game.board, game, 'attack', context,
        ),
        crit: calcs.computeCrit(
          unit, item, target, game.db, game, 'attack', context,
        ),
        doubles: calcs.canDouble(
          unit, item, target, item2, game.db, game, 'attack', context,
        ),
      };
      unit.skills = [new SkillObject({
        nid: '_PipelineAttacker',
        name: 'Pipeline attacker',
        desc: '',
        components: [
          ['eval_damage', '3'],
          ['eval_hit', '4'],
          ['eval_crit', '6'],
          ['dynamic_damage', '7'],
          ['dynamic_accuracy', '9'],
          ['dynamic_crit_accuracy', '11'],
          ['dynamic_attack_speed', '13'],
          ['dynamic_damage_multiplier', '0.5'],
        ],
      })];
      target.skills = [new SkillObject({
        nid: '_PipelineDefender',
        name: 'Pipeline defender',
        desc: '',
        components: [
          ['eval_avoid', '5'],
          ['dynamic_resist', '2'],
          ['dynamic_avoid', '10'],
          ['dynamic_crit_avoid', '12'],
        ],
      })];
      const pipeline = {
        damage: calcs.computeDamage(
          unit, item, target, game.db, game.board, game, 'attack', false, context,
        ),
        hit: calcs.computeHit(
          unit, item, target, game.db, game.board, game, 'attack', context,
        ),
        crit: calcs.computeCrit(
          unit, item, target, game.db, game, 'attack', context,
        ),
        doubles: calcs.canDouble(
          unit, item, target, item2, game.db, game, 'attack', context,
        ),
      };
      return { hooks, baseline, pipeline };
    });

    expect(result.hooks).toEqual({
      stat: 35,
      staticDamage: 3,
      staticHit: 4,
      staticAvoid: 5,
      staticCrit: 6,
      dynamicDamage: 12,
      dynamicResist: 8,
      dynamicHit: 9,
      dynamicAvoid: 10,
      dynamicCrit: 11,
      dynamicDodge: 12,
      multiplier: 0.5,
      trueSpeed: -5,
      doubles: false,
    });
    expect(result.pipeline.damage).toBe(9);
    expect(result.pipeline.hit - result.baseline.hit).toBe(-2);
    expect(result.pipeline.crit - result.baseline.crit).toBe(5);
    expect(result.baseline.doubles).toBe(false);
    expect(result.pipeline.doubles).toBe(true);
  });

  test('evaluates every authored expression with EotF runtime helpers', async ({ page }) => {
    const failures: string[] = [];
    page.on('console', (message) => {
      if (message.text().includes('EventCondition JS eval failed')) {
        failures.push(message.text());
      }
    });
    await bootEotf(page);
    const result = await page.evaluate(async (componentNids) => {
      const game = (window as any).__gameRef;
      const { SkillObject } = await import('/src/objects/skill.ts');
      const { ItemObject } = await import('/src/objects/item.ts');
      const { evaluateExpression } = await import('/src/events/event-manager.ts');
      const unit = game.units.get('Player');
      const target = game.units.get('Keeper');
      const ally = game.units.get('Lib');
      unit.team = 'player';
      target.team = 'enemy';
      ally.team = 'player';
      unit.position = [2, 2];
      target.position = [3, 2];
      ally.position = [2, 3];
      unit.previousPosition = [1, 2];
      unit.wexp.Sword = 99;
      unit.wexp.Axe = 99;
      unit.wexp.Bow = 99;
      const item = new ItemObject({
        nid: 'Multitool',
        name: 'Test Blade',
        desc: '',
        components: [
          ['weapon', null], ['weapon_type', 'Sword'], ['weapon_rank', 'S'],
          ['damage', 10], ['weight', 6], ['item_tags', ['Gun', 'Blade']],
          ['status_on_equip', 'Iustitae'],
          ['effective_damage', { tags: ['Dragon'] }],
        ],
      });
      item.subitems = [new ItemObject({
        nid: '_Subitem',
        name: 'Subitem',
        desc: '',
        components: [['weapon', null]],
      })];
      unit.items = [item];
      unit.equippedWeapon = item;
      target.items = [item];
      target.equippedWeapon = item;
      const parent = new SkillObject({
        nid: '_ExpressionParent',
        name: 'Expression parent',
        desc: '',
        components: [],
      });
      parent.ownerNid = unit.nid;
      const helpers = [
        'Dark_Energy', 'Grit', 'Fatigue', 'Soul', 'Stars', 'Solar_Energy',
        'Chreos_Stack', 'Revelation_Child', 'Vows', 'Lunar_Sign',
        'Pendulum_Power', 'Astral_Storm', 'Astral_Storm_Plus',
      ].map((nid) => new SkillObject({
        nid,
        name: nid,
        desc: '',
        components: [],
      }));
      for (const helper of helpers) helper.data.set('charge', 3);
      unit.skills = helpers;
      target.skills = [
        new SkillObject({
          nid: '_NegativeTerrain',
          name: 'Negative terrain',
          desc: '',
          components: [
            ['negative', null], ['is_terrain', null], ['dazzled', null],
          ],
        }),
      ];
      game.levelVars.set('bonus_units', [unit.nid]);
      game.levelVars.set('in_combat', 1);
      const expressions = [...game.db.skills.values()].flatMap((prefab: any) =>
        prefab.components.flatMap(([component, value]: [string, unknown]) => {
          if (!componentNids.includes(component)) return [];
          const values = component === 'stat_change_expression'
            ? (value as [string, string][]).map((entry) => entry[1])
            : component === 'stat_multiplier' ? [] : [value];
          return values
            .filter((expression): expression is string => typeof expression === 'string')
            .map((expression) => ({ prefab, component, expression }));
        }));
      const skillNids = new Set(expressions.flatMap(({ expression }) =>
        [...expression.matchAll(/\bget_skill\([^,]+,\s*['\"]([^'\"]+)['\"]/g)]
          .map((match) => match[1])));
      for (const nid of skillNids) {
        if (unit.skills.some((skill: any) => skill.nid === nid)) continue;
        const helper = new SkillObject({
          nid,
          name: nid,
          desc: '',
          components: [],
        });
        helper.data.set('charge', 3);
        unit.skills.push(helper);
      }
      const itemNids = new Set(expressions.flatMap(({ expression }) =>
        [...expression.matchAll(/\bget_item\([^,]+,\s*['\"]([^'\"]+)['\"]/g)]
          .map((match) => match[1])));
      for (const nid of itemNids) {
        if (unit.items.some((candidate: any) => candidate.nid === nid)) continue;
        const helper = new ItemObject({
          nid,
          name: nid,
          desc: '',
          components: [['weapon', null], ['damage', 1], ['weight', 1]],
        });
        helper.subitems = [item.subitems[0]];
        unit.items.push(helper);
      }
      const aliases = new Set(expressions.flatMap(({ expression }) =>
        [...expression.matchAll(/\bu\(\s*['\"]([^'\"]+)['\"]/g)]
          .map((match) => match[1])));
      for (const alias of aliases) {
        if (!game.units.has(alias)) game.units.set(alias, target);
      }
      const combatCalcs = {
        accuracy: () => 80,
        avoid: () => 20,
        crit_accuracy: () => 30,
        crit_avoid: () => 10,
        attack_speed: () => 20,
        defense_speed: () => 10,
        can_counterattack: () => true,
      };
      const values = expressions.map(({ prefab, component, expression }) => {
        const skill = new SkillObject(prefab);
        skill.data.set('multiSkillSource', parent);
        const value = evaluateExpression(expression, {
          game,
          unit1: unit,
          unit2: target,
          item,
          position: unit.position,
          gameVars: game.gameVars,
          levelVars: game.levelVars,
          localArgs: new Map([
            ['item2', item],
            ['mode', 'attack'],
            ['skill', skill],
            ['attack_info', [0, 0]],
            ['base_value', 20],
            ['combat_calcs', combatCalcs],
          ]),
        });
        return {
          nid: prefab.nid,
          component,
          expression,
          value: Number(value),
        };
      });
      for (const alias of aliases) {
        if (alias !== target.nid) game.units.delete(alias);
      }
      return {
        total: values.length,
        invalid: values.filter(({ value }) => !Number.isFinite(value)),
      };
    }, COMPONENTS);

    expect(result.total).toBeGreaterThan(647);
    expect(failures).toEqual([]);
    expect(result.invalid).toEqual([]);
  });
});
