/**
 * Engine-facing regressions for the Python expression evaluator: the eval
 * context (game, unit wrappers, combat_calcs, query helpers) and call-site
 * exception handling, on the real Embrace of the Fog project.
 */
import { expect, test, type Page } from '@playwright/test';

async function bootEotf(page: Page): Promise<void> {
  await page.goto('/?harness=true&project=eotf.ltproj&level=X&clean=true&bundle=false');
  await page.waitForFunction(() => (window as any).__harness?.ready === true, undefined, {
    timeout: 90_000,
  });
}

test.describe('Python expression evaluator in the EOtF engine', () => {
  test('weapon-triangle skills activate through the real combat hooks', async ({ page }) => {
    const warnings: string[] = [];
    page.on('console', (message) => {
      const text = message.text();
      if (text.includes('EventCondition JS eval failed') || text.includes('Python evaluation error')) {
        warnings.push(text);
      }
    });
    await bootEotf(page);
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { ItemObject } = await import('/src/objects/item.ts');
      const { SkillObject } = await import('/src/objects/skill.ts');
      const skillSystem = await import('/src/combat/skill-system.ts');
      const unit = game.units.get('Player');
      const target = game.units.get('Keeper');
      const sword = new ItemObject(game.db.items.get('Iron_Sword'));
      const axe = new ItemObject(game.db.items.get('Iron_Axe'));
      const saved = {
        unitItems: unit.items, unitWeapon: unit.equippedWeapon, unitSkills: unit.skills,
        targetItems: target.items, targetWeapon: target.equippedWeapon, targetSkills: target.skills,
        team: target.team,
      };
      unit.items = [sword];
      unit.equippedWeapon = sword;
      target.items = [axe];
      target.equippedWeapon = axe;
      target.team = 'enemy';
      const only = (holder: any, nid: string) => {
        holder.skills = [new SkillObject(game.db.skills.get(nid))];
      };
      // Python CombatCondition: evaluate(value, unit, target, unit.position,
      // {'item', 'item2', 'mode', 'skill'}); combat_calcs is the module.
      const values: Record<string, number> = {};
      only(unit, 'Triangle_Adept');
      values.adeptDamage = skillSystem.dynamicDamage(unit, sword, target, axe, 'attack', [0, 0], 0, game);
      only(target, 'Triangle_Adept');
      values.adeptLosingDamage = skillSystem.dynamicDamage(target, axe, unit, sword, 'defense', [0, 0], 0, game);
      only(unit, 'Triangle_Taker_Child');
      values.takerChildDamage = skillSystem.dynamicDamage(unit, sword, target, axe, 'attack', [0, 0], 0, game);
      only(unit, 'Veteran_Plus');
      values.veteranPlusSpeed = skillSystem.dynamicAttackSpeed(unit, sword, target, axe, 'attack', [0, 0], 0, game);
      only(unit, 'Veteran');
      values.veteranSpeed = skillSystem.dynamicAttackSpeed(unit, sword, target, axe, 'attack', [0, 0], 0, game);
      // Veteran_Helper sits on the disadvantaged side: the axe user facing
      // a sword loses 99 defense speed.
      only(target, 'Veteran_Helper');
      values.veteranHelperSpeed = skillSystem.dynamicDefenseSpeed(target, axe, unit, sword, 'defense', [0, 0], 0, game);
      Object.assign(unit, { items: saved.unitItems, equippedWeapon: saved.unitWeapon, skills: saved.unitSkills });
      Object.assign(target, {
        items: saved.targetItems, equippedWeapon: saved.targetWeapon, skills: saved.targetSkills, team: saved.team,
      });
      return values;
    });
    expect(result).toEqual({
      adeptDamage: 7,
      adeptLosingDamage: 0,
      takerChildDamage: 2,
      veteranPlusSpeed: 99,
      veteranSpeed: 99,
      veteranHelperSpeed: -99,
    });
    expect(warnings).toEqual([]);
  });

  test('combat_calcs in eval() is the module with Python signatures', async ({ page }) => {
    const warnings: string[] = [];
    page.on('console', (message) => {
      const text = message.text();
      if (text.includes('EventCondition JS eval failed') || text.includes('Python evaluation error')) {
        warnings.push(text);
      }
    });
    await bootEotf(page);
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { ItemObject } = await import('/src/objects/item.ts');
      const calcs = await import('/src/combat/combat-calcs.ts');
      const { evaluateExpression } = await import('/src/events/event-manager.ts');
      const unit = game.units.get('Player');
      const target = game.units.get('Keeper');
      const sword = new ItemObject(game.db.items.get('Iron_Sword'));
      const axe = new ItemObject(game.db.items.get('Iron_Axe'));
      const saved = {
        unitItems: unit.items, unitWeapon: unit.equippedWeapon,
        targetItems: target.items, targetWeapon: target.equippedWeapon,
      };
      unit.items = [sword];
      unit.equippedWeapon = sword;
      target.items = [axe];
      target.equippedWeapon = axe;
      const context = {
        game, unit1: unit, unit2: target, item: sword,
        gameVars: game.gameVars, levelVars: game.levelVars,
        // A local named combat_calcs would shadow the module, as in Python;
        // no engine caller passes one.
        localArgs: new Map<string, unknown>([['item', sword], ['item2', axe], ['mode', 'attack']]),
      };
      const run = (expression: string) => evaluateExpression(expression, context);
      const values = {
        attackSpeed: run('combat_calcs.attack_speed(unit)'),
        defenseSpeed: run('combat_calcs.defense_speed(target, item2)'),
        accuracy: run('combat_calcs.accuracy(unit, item)'),
        avoid: run('combat_calcs.avoid(target, item2, item)'),
        critAccuracy: run('combat_calcs.crit_accuracy(unit, unit.get_weapon())'),
        critAvoid: run('combat_calcs.crit_avoid(target, item2, item)'),
        advantage: run('combat_calcs.compute_advantage(unit, target, item, item2).accuracy'),
        noAdvantage: run('combat_calcs.compute_advantage(unit, target, item, None)'),
        canCounter: run('combat_calcs.can_counterattack(unit, item, target, item2)'),
        expected: {
          attackSpeed: calcs.attackSpeed(unit, sword, game.db, game),
          defenseSpeed: calcs.defenseSpeed(target, axe, game.db, null, game),
          accuracy: calcs.accuracy(unit, sword, game.db, game),
          avoid: calcs.avoid(target, game.db, undefined, sword, game),
          critAccuracy: calcs.critAccuracy(unit, sword, game.db, game),
          critAvoid: calcs.critAvoid(target, axe, sword, game.db, game),
        },
      };
      Object.assign(unit, { items: saved.unitItems, equippedWeapon: saved.unitWeapon });
      Object.assign(target, { items: saved.targetItems, equippedWeapon: saved.targetWeapon });
      return values;
    });
    const { expected, ...actual } = result;
    expect(actual).toEqual({
      ...expected,
      advantage: expect.any(Number),
      noAdvantage: null,
      canCounter: expect.any(Boolean),
    });
    expect(result.advantage).toBeGreaterThan(0);
    expect(warnings).toEqual([]);
  });

  test('list concatenation and comparisons follow Python in event conditions', async ({ page }) => {
    await bootEotf(page);
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { evaluateCondition, evaluateExpression } = await import('/src/events/event-manager.ts');
      const context = { game, gameVars: game.gameVars, levelVars: game.levelVars };
      game.levelVars.set('seen', ['a']);
      return {
        listEquality: evaluateCondition('[1] + [2] == [1, 2]', context),
        concatenation: evaluateExpression("v('seen') + ['b']", context),
        sum: evaluateCondition('1 + 2 == 3', context),
        maxCall: evaluateExpression('max(1 + 1, 3)', context),
        needle: evaluateCondition("'a' + '|' + 'b' not in ['a|b']", context),
        chained: evaluateCondition('1 < 2 < 3 and not 3 < 2 < 1', context),
        unsetVar: evaluateExpression("v('missing_var_for_test')", context),
      };
    });
    expect(result).toEqual({
      listEquality: true,
      concatenation: ['a', 'b'],
      sum: true,
      maxCall: 3,
      needle: false,
      chained: true,
      unsetVar: null,
    });
  });

  test('Python-equivalent failures are not reported as unimplemented', async ({ page }) => {
    const gaps: string[] = [];
    const pythonErrors: string[] = [];
    page.on('console', (message) => {
      const text = message.text();
      if (text.includes('EventCondition JS eval failed') || text.includes('Unimplemented expression')) gaps.push(text);
      if (text.includes('(Python-equivalent)')) pythonErrors.push(text);
    });
    await bootEotf(page);
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { evaluateCondition, evaluateInt } = await import('/src/events/event-manager.ts');
      const context = { game, unit1: game.units.get('Player'), gameVars: game.gameVars, levelVars: game.levelVars };
      return {
        // AttributeError on None (no unit2), as Python's except-clause sees it.
        noTarget: evaluateCondition("'Boss' in unit2.tags", context),
        // int(None) raises inside the call site's try: fallback value.
        intOfNone: evaluateInt("unit.get_field('never_set_field')", context, 7),
        // Authored text CPython also rejects.
        syntax: evaluateCondition("if v('x')", context),
      };
    });
    expect(result).toEqual({ noTarget: false, intOfNone: 7, syntax: false });
    expect(gaps).toEqual([]);
    expect(pythonErrors).toHaveLength(3);
  });

  test('a missing engine helper is reported as unported, not as a Python error', async ({ page }) => {
    const gaps: string[] = [];
    const pythonErrors: string[] = [];
    page.on('console', (message) => {
      const text = message.text();
      if (text.includes('[StrictMode] Unimplemented expression')) gaps.push(text);
      if (text.includes('(Python-equivalent)')) pythonErrors.push(text);
    });
    await bootEotf(page);
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { evaluateCondition } = await import('/src/events/event-manager.ts');
      const context = { game, unit1: game.units.get('Player'), gameVars: game.gameVars, levelVars: game.levelVars };
      return {
        // The real item_funcs module may have it: possibly unported.
        missingHelper: evaluateCondition('item_funcs.helper_the_port_lacks(unit)', context),
        // A plain Python value has a fixed attribute set: Python raises too.
        stringAttribute: evaluateCondition("'abc'.nope()", context),
      };
    });
    expect(result).toEqual({ missingHelper: false, stringAttribute: false });
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toContain('helper_the_port_lacks');
    expect(pythonErrors).toHaveLength(1);
  });

  test('module helpers EOtF calls exist with Python behavior', async ({ page }) => {
    await bootEotf(page);
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { ItemObject } = await import('/src/objects/item.ts');
      const { evaluateExpression } = await import('/src/events/event-manager.ts');
      const unit = game.units.get('Player');
      const target = game.units.get('Keeper');
      const saved = { items: unit.items, targetPosition: target.position, targetTeam: target.team };
      const accessory = [...game.db.items.values()].find((prefab: any) =>
        prefab.components?.some?.(([nid]: [string]) => nid === 'accessory' || nid === 'equippable_accessory'));
      const sword = new ItemObject(game.db.items.get('Iron_Sword'));
      unit.items = [sword];
      const context = {
        game, unit1: unit, unit2: target, gameVars: game.gameVars, levelVars: game.levelVars,
        localArgs: new Map<string, unknown>([
          ['sword', sword],
          ['ring', accessory ? new ItemObject(accessory) : null],
        ]),
      };
      const run = (expression: string) => evaluateExpression(expression, context);
      const values = {
        swordIsAccessory: run('item_system.is_accessory(unit, sword)'),
        ringIsAccessory: accessory ? run('item_system.is_accessory(unit, ring)') : true,
        numItems: run('item_funcs.get_num_items(unit)'),
        numItemsConstant: game.db.getConstant('num_items', 5),
        numAccessories: run('item_funcs.get_num_accessories(unit)'),
        inventoryFull: run('item_funcs.inventory_full(unit, sword)'),
        weaklyTraversableHere: run('movement_funcs.check_weakly_traversable(unit, unit.position)'),
        weaklyTraversableOffMap: run('movement_funcs.check_weakly_traversable(unit, (-1, -1))'),
        flankedAlone: run('unit_funcs.check_flanked(unit)'),
        klassSkills: run('get_klass(unit).get_skills()'),
        learnedSkills: game.db.classes.get(unit.klass).learned_skills.map((entry: [number, string]) => entry[1]),
      };
      unit.items = saved.items;
      return values;
    });
    expect(result).toEqual({
      swordIsAccessory: false,
      ringIsAccessory: true,
      numItems: expect.any(Number),
      numItemsConstant: expect.anything(),
      numAccessories: expect.any(Number),
      inventoryFull: false,
      weaklyTraversableHere: true,
      weaklyTraversableOffMap: false,
      flankedAlone: false,
      klassSkills: result.learnedSkills,
      learnedSkills: expect.any(Array),
    });
    expect(result.numItems).toBeGreaterThanOrEqual(Number(result.numItemsConstant));
  });
});
