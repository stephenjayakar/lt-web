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
  test('weapon-triangle skill conditions see the combat_calcs module', async ({ page }) => {
    const warnings: string[] = [];
    page.on('console', (message) => {
      if (message.text().includes('EventCondition JS eval failed')) warnings.push(message.text());
    });
    await bootEotf(page);
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { ItemObject } = await import('/src/objects/item.ts');
      const { evaluateCondition } = await import('/src/events/event-manager.ts');
      const unit = game.units.get('Player');
      const target = game.units.get('Keeper');
      const sword = new ItemObject(game.db.items.get('Iron_Sword'));
      const axe = new ItemObject(game.db.items.get('Iron_Axe'));
      const saved = {
        unitItems: unit.items, unitWeapon: unit.equippedWeapon,
        targetItems: target.items, targetWeapon: target.equippedWeapon, team: target.team,
      };
      unit.items = [sword];
      unit.equippedWeapon = sword;
      target.items = [axe];
      target.equippedWeapon = axe;
      target.team = 'enemy';
      const condition = (nid: string) => game.db.skills.get(nid).components
        .find(([component]: [string, unknown]) => component === 'combat_condition')[1] as string;
      // Combat hooks pass the solver's speed helpers as a `combat_calcs`
      // local (skill-system evaluatedSkillActive); Python's combat_calcs is
      // the module, which still provides compute_advantage.
      const context = (attacker: any, defender: any, item: any, item2: any) => ({
        game,
        unit1: attacker,
        unit2: defender,
        item,
        position: attacker.position ?? undefined,
        gameVars: game.gameVars,
        levelVars: game.levelVars,
        localArgs: new Map<string, unknown>([
          ['item2', item2],
          ['mode', 'attack'],
          ['combat_calcs', { attack_speed: () => 10, defense_speed: () => 5 }],
        ]),
      });
      const values = {
        adept: evaluateCondition(condition('Triangle_Adept'), context(unit, target, sword, axe)),
        expert: evaluateCondition(condition('Triangle_Expert'), context(unit, target, sword, axe)),
        veteranPlus: evaluateCondition(condition('Veteran_Plus'), context(unit, target, sword, axe)),
        // Disadvantaged side: the axe user against the sword.
        adeptLosing: evaluateCondition(condition('Triangle_Adept'), context(target, unit, axe, sword)),
        speedHelper: evaluateCondition('combat_calcs.attack_speed() > combat_calcs.defense_speed()',
          context(unit, target, sword, axe)),
      };
      Object.assign(unit, { items: saved.unitItems, equippedWeapon: saved.unitWeapon });
      Object.assign(target, { items: saved.targetItems, equippedWeapon: saved.targetWeapon, team: saved.team });
      return values;
    });
    expect(result).toEqual({
      adept: true,
      expert: true,
      veteranPlus: true,
      adeptLosing: false,
      speedHelper: true,
    });
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
});
