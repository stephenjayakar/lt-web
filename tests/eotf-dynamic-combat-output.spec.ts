import { expect, test, type Page } from '@playwright/test';

async function bootEotf(page: Page): Promise<void> {
  await page.goto('/?harness=true&project=eotf.ltproj&level=X&clean=true&bundle=false');
  await page.waitForFunction(() => (window as any).__harness?.ready === true, undefined, {
    timeout: 60_000,
  });
}

test.describe('Embrace of the Fog dynamic combat output', () => {
  test('count-locks all 54 authored component uses', async ({ page }) => {
    await bootEotf(page);
    const uses = await page.evaluate(() => {
      const game = (window as any).__gameRef;
      const nids = [
        'dynamic_attacks',
        'dynamic_multiattacks',
        'dynamic_blitzes',
        'eval_extra_damage',
        'alternate_magic_damage_formula',
        'dynamic_stat_change',
      ];
      return Object.fromEntries(nids.map((nid) => [
        nid,
        [...game.db.skills.values()].flatMap((skill: any) => skill.components
          .filter(([component]: [string, unknown]) => component === nid)
          .map(([, value]: [string, unknown]) => [skill.nid, value])),
      ]));
    });

    expect(uses.dynamic_attacks).toHaveLength(13);
    expect(uses.dynamic_multiattacks).toHaveLength(23);
    expect(uses.dynamic_blitzes).toHaveLength(6);
    expect(uses.eval_extra_damage).toHaveLength(7);
    expect(uses.alternate_magic_damage_formula).toHaveLength(3);
    expect(uses.dynamic_stat_change).toHaveLength(2);
    expect(Object.values(uses).flat()).toHaveLength(54);
    expect(uses.dynamic_multiattacks.every(([, value]: [string, unknown]) =>
      typeof value === 'string')).toBe(true);
  });

  test('evaluates phase, multi-hit, formula, and Python helper expressions', async ({ page }) => {
    await bootEotf(page);
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { SkillObject } = await import('/src/objects/skill.ts');
      const { ItemObject } = await import('/src/objects/item.ts');
      const calcs = await import('/src/combat/combat-calcs.ts');
      const skillSystem = await import('/src/combat/skill-system.ts');
      const { evaluateExpression } = await import('/src/events/event-manager.ts');
      const unit = game.units.get('Player');
      const target = game.units.get('Keeper');
      const oldSkills = unit.skills;
      const oldTargetItems = target.items;
      const oldTargetWeapon = target.equippedWeapon;
      const weapon = new ItemObject({
        nid: '_DynamicOutputWeapon',
        name: 'Dynamic output weapon',
        desc: '',
        components: [['weapon', null], ['damage', 1], ['hit', 100]],
      });
      const defenseWeapon = new ItemObject({
        nid: '_DynamicOutputDefense',
        name: 'Dynamic output defense',
        desc: '',
        components: [['weapon', null], ['damage', 1], ['hit', 100]],
      });
      target.items = [defenseWeapon];
      target.equippedWeapon = defenseWeapon;
      unit.skills = [new SkillObject({
        nid: '_DynamicOutput',
        name: 'Dynamic output',
        desc: '',
        components: [
          ['dynamic_attacks', 'int(3 // 2)'],
          ['dynamic_multiattacks', 'len(set([1, 1, 2]))'],
          ['dynamic_blitzes', 'utils.clamp(2, 0, 1)'],
          ['alternate_magic_damage_formula', 'MAGIC_DAMAGE'],
        ],
      })];
      const values = {
        phases: calcs.computeExtraAttackPhases(
          unit, weapon, target, defenseWeapon, 'attack', [0, 0], game,
        ),
        strikes: calcs.computeStrikeCount(
          unit, weapon, target, defenseWeapon, 'attack', [0, 0], game,
        ),
        blitzes: calcs.computeBlitzPhases(
          unit, weapon, target, defenseWeapon, 'attack', [0, 0], game,
        ),
        formula: skillSystem.damageFormula(unit),
        stringStacks: evaluateExpression(
          "get_stacks('Player', '_DynamicOutput')",
          {
            game,
            unit1: unit,
            gameVars: game.gameVars,
            levelVars: game.levelVars,
          },
        ),
      };
      unit.skills = oldSkills;
      target.items = oldTargetItems;
      target.equippedWeapon = oldTargetWeapon;
      return values;
    });

    expect(result).toEqual({
      phases: 1,
      strikes: 3,
      blitzes: 1,
      formula: 'MAGIC_DAMAGE',
      stringStacks: 1,
    });
  });

  test('evaluates every authored dynamic numeric expression without fallback errors', async ({ page }) => {
    const failures: string[] = [];
    page.on('console', (message) => {
      if (message.text().includes('EventCondition JS eval failed')) {
        failures.push(message.text());
      }
    });
    await bootEotf(page);
    const results = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { SkillObject } = await import('/src/objects/skill.ts');
      const { ItemObject } = await import('/src/objects/item.ts');
      const { evaluateExpression } = await import('/src/events/event-manager.ts');
      const unit = game.units.get('Player');
      const target = game.units.get('Keeper');
      const item = new ItemObject({
        nid: '_ExpressionWeapon',
        name: 'Expression weapon',
        desc: '',
        components: [['weapon', null], ['item_tags', ['AbilityItem']]],
      });
      const item2 = new ItemObject({
        nid: '_ExpressionDefense',
        name: 'Expression defense',
        desc: '',
        components: [['weapon', null]],
      });
      unit.skills = [
        new SkillObject(game.db.skills.get('Astral_Storm')),
        new SkillObject(game.db.skills.get('Astral_Storm_Plus')),
        new SkillObject(game.db.skills.get('Pendulum_Power')),
      ];
      unit.skills[0].data.set('charge', 2);
      unit.skills[1].data.set('charge', 3);
      const componentNids = new Set([
        'dynamic_attacks',
        'dynamic_multiattacks',
        'dynamic_blitzes',
        'eval_extra_damage',
        'dynamic_stat_change',
      ]);
      const expressions = [...game.db.skills.values()].flatMap((prefab: any) =>
        prefab.components.flatMap(([component, value]: [string, unknown]) => {
          if (!componentNids.has(component)) return [];
          const values = component === 'dynamic_stat_change'
            ? (value as [string, string][]).map((entry) => entry[1])
            : [value];
          return values
            .filter((expression): expression is string => typeof expression === 'string')
            .map((expression) => ({ nid: prefab.nid, component, expression }));
        }));
      return expressions.map(({ nid, component, expression }) => {
        const skill = new SkillObject({
          nid,
          name: nid,
          desc: '',
          components: [[component, expression]],
        });
        const value = evaluateExpression(expression, {
          game,
          unit1: unit,
          unit2: target,
          item,
          position: unit.position,
          gameVars: game.gameVars,
          levelVars: game.levelVars,
          localArgs: new Map([
            ['item2', item2],
            ['mode', 'attack'],
            ['skill', skill],
            ['attack_info', [0, 0]],
            ['base_value', 0],
            ['playback', []],
            ['combat_calcs', {
              attack_speed: () => 20,
              defense_speed: () => 10,
            }],
          ]),
        });
        return { nid, component, expression, value: Number(value) };
      });
    });

    expect(results).toHaveLength(53);
    expect(
      results.filter(({ value }) => !Number.isFinite(value)),
    ).toEqual([]);
    expect(failures).toEqual([]);
  });

  test('orders blitzes before counters and keeps extra damage separate', async ({ page }) => {
    await bootEotf(page);
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { SkillObject } = await import('/src/objects/skill.ts');
      const { ItemObject } = await import('/src/objects/item.ts');
      const { CombatPhaseSolver } = await import('/src/combat/combat-solver.ts');
      const attacker = game.units.get('Player');
      const defender = game.units.get('Keeper');
      attacker.team = 'player';
      defender.team = 'enemy';
      attacker.position = [2, 2];
      defender.position = [3, 2];
      attacker.stats.SPD = 10;
      defender.stats.SPD = 10;
      attacker.stats.SKL = 100;
      defender.stats.SKL = 100;
      attacker.stats.LCK = 0;
      defender.stats.LCK = 0;
      attacker.currentHp = 999;
      defender.currentHp = 999;
      attacker.dead = false;
      defender.dead = false;
      const attackItem = new ItemObject({
        nid: '_DynamicAttackWeapon',
        name: 'Dynamic attack weapon',
        desc: '',
        components: [
          ['weapon', null], ['damage', 1], ['hit', 100], ['uses', 99],
          ['min_range', 1], ['max_range', 1],
        ],
      });
      const defenseItem = new ItemObject({
        nid: '_DynamicDefenseWeapon',
        name: 'Dynamic defense weapon',
        desc: '',
        components: [
          ['weapon', null], ['damage', 1], ['hit', 100], ['uses', 99],
          ['min_range', 1], ['max_range', 1],
        ],
      });
      attacker.items = [attackItem];
      attacker.equippedWeapon = attackItem;
      defender.items = [defenseItem];
      defender.equippedWeapon = defenseItem;
      attacker.skills = [new SkillObject({
        nid: '_DynamicCombatOutput',
        name: 'Dynamic combat output',
        desc: '',
        components: [
          ['dynamic_multiattacks', '1'],
          ['dynamic_blitzes', '1'],
          ['dynamic_attacks', '1'],
          ['eval_extra_damage', '7'],
        ],
      })];
      defender.skills = [];
      const strikes = new CombatPhaseSolver(() => 0, game).resolve(
        attacker, attackItem, defender, defenseItem, game.db, 'classic', game.board,
      );
      return strikes.map((strike: any) => ({
        attacker: strike.attacker.nid,
        phase: strike.attackInfo[0],
        extraDamage: strike.extraDamage,
      }));
    });

    expect(result.map((strike) => strike.attacker)).toEqual([
      'Player', 'Player',
      'Player', 'Player',
      'Keeper',
      'Player', 'Player',
    ]);
    expect(result.filter((strike) => strike.attacker === 'Player')
      .map((strike) => strike.phase)).toEqual([0, 0, 1, 1, 2, 2]);
    expect(result.filter((strike) => strike.attacker === 'Player')
      .every((strike) => strike.extraDamage === 7)).toBe(true);
    expect(result.find((strike) => strike.attacker === 'Keeper')?.extraDamage).toBe(0);
  });

  test('freezes dynamic stat changes for damage previews and clears the cache', async ({ page }) => {
    await bootEotf(page);
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { SkillObject } = await import('/src/objects/skill.ts');
      const { ItemObject } = await import('/src/objects/item.ts');
      const { computeDamage } = await import('/src/combat/combat-calcs.ts');
      const attacker = game.units.get('Player');
      const defender = game.units.get('Keeper');
      const weapon = new ItemObject({
        nid: '_DynamicStatWeapon',
        name: 'Dynamic stat weapon',
        desc: '',
        components: [['weapon', null], ['damage', 0], ['hit', 100]],
      });
      attacker.stats.STR = 10;
      defender.stats.DEF = 0;
      attacker.skills = [];
      const baseline = computeDamage(attacker, weapon, defender, game.db, game.board, game);
      const skill = new SkillObject({
        nid: '_DynamicStat',
        name: 'Dynamic stat',
        desc: '',
        components: [
          ['combat_condition', 'skill_system.check_enemy(unit, target)'],
          ['dynamic_stat_change', [['STR', '5']]],
        ],
      });
      attacker.team = 'player';
      defender.team = 'enemy';
      attacker.skills = [skill];
      const boosted = computeDamage(attacker, weapon, defender, game.db, game.board, game);
      return {
        delta: boosted - baseline,
        cached: skill.data.has('_dynamic_stat_changes'),
      };
    });

    expect(result).toEqual({ delta: 5, cached: false });
  });
});
