import { expect, test, type Page } from '@playwright/test';

async function bootEotf(page: Page): Promise<void> {
  await page.goto('/?harness=true&project=eotf.ltproj&level=X&clean=true&bundle=false');
  await page.waitForFunction(() => (window as any).__harness?.ready === true, undefined, {
    timeout: 60_000,
  });
}

const MARKERS = [
  'berserked',
  'blinded',
  'dazzled',
  'fatal_block',
  'fatal_damage',
  'no_stackz',
  'null_sweep',
  'paragon',
] as const;

test.describe('Embrace of the Fog expression marker components', () => {
  test('count-locks all 51 authored marker uses and null value shapes', async ({ page }) => {
    await bootEotf(page);
    const inventory = await page.evaluate((markers) => {
      const game = (window as any).__gameRef;
      const selected = new Set(markers);
      const counts: Record<string, number> = {};
      const invalid: string[] = [];
      for (const skill of game.db.skills.values()) {
        for (const [component, value] of skill.components) {
          if (!selected.has(component)) continue;
          counts[component] = (counts[component] ?? 0) + 1;
          if (value !== null) invalid.push(`${skill.nid}:${component}`);
        }
      }
      return { counts, invalid };
    }, [...MARKERS]);

    expect(inventory).toEqual({
      counts: {
        berserked: 7,
        blinded: 6,
        dazzled: 5,
        fatal_block: 14,
        fatal_damage: 9,
        no_stackz: 5,
        null_sweep: 3,
        paragon: 2,
      },
      invalid: [],
    });
  });

  test('exposes marker truthiness to real death, combat, target, and stack expressions', async ({
    page,
  }) => {
    await bootEotf(page);
    const result = await page.evaluate(async (markers) => {
      const game = (window as any).__gameRef;
      const { SkillObject } = await import('/src/objects/skill.ts');
      const { ItemObject } = await import('/src/objects/item.ts');
      const { evaluateExpression } = await import('/src/events/event-manager.ts');
      const unit = game.units.get('Player');
      const target = game.units.get('Keeper');
      const old = {
        unitSkills: unit.skills,
        targetSkills: target.skills,
        unitTeam: unit.team,
        targetTeam: target.team,
        units: game.units,
        unitHp: unit.currentHp,
      };
      const make = (nid: string, components: [string, unknown][]) =>
        new SkillObject({
          nid,
          name: nid,
          desc: '',
          icon_nid: '',
          icon_index: [0, 0],
          components,
        });
      const context = (item: any = null) => ({
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
        ]),
      });

      const truthiness: Record<string, { present: boolean; absent: boolean }> = {};
      for (const marker of markers) {
        unit.skills = [make(`_${marker}`, [[marker, null]])];
        const expression = `any([s.${marker} for s in unit.skills])`;
        const present = Boolean(evaluateExpression(expression, context()));
        unit.skills = [make('_Plain', [])];
        const absent = Boolean(evaluateExpression(expression, context()));
        truthiness[marker] = { present, absent };
      }

      unit.team = 'enemy';
      target.team = 'enemy';
      unit.skills = [make('_FatalSource', [['fatal_damage', null]])];
      game.units = new Map([[unit.nid, unit]]);
      const deathExpression =
        "not any([u for u in game.get_enemy_units() if u.nid != unit.nid]) " +
        'and any([s.fatal_damage for s in unit.skills])';
      const fatalLastEnemy = Boolean(evaluateExpression(deathExpression, context()));
      game.units.set(target.nid, target);
      const fatalWithSurvivor = Boolean(evaluateExpression(deathExpression, context()));

      unit.currentHp = 8;
      unit.skills = [];
      const fatalBlockExpression =
        'unit.get_hp() <= 10 and not any([s.fatal_block for s in unit.skills])';
      const fatalUnblocked = Boolean(evaluateExpression(fatalBlockExpression, context()));
      unit.skills = [make('_FatalBlock', [['fatal_block', null]])];
      const fatalBlocked = Boolean(evaluateExpression(fatalBlockExpression, context()));

      const stackable = make('_Stackable', [['stack', 3]]);
      const excluded = make('_ExcludedStack', [['stack', 3], ['no_stackz', null]]);
      const hidden = make('_HiddenStack', [['stack', 3], ['hidden', null]]);
      unit.skills = [stackable, excluded, hidden];
      const stackExpression =
        '[s.nid for s in unit.skills if not s.no_stackz and not s.hidden ' +
        'and s.stack and (s.stack.value > len([x for x in unit.skills if x.nid == s.nid]))]';
      const stackCandidates = evaluateExpression(stackExpression, context());

      target.skills = [make('_Dazzled', [['dazzled', null]])];
      const dazzled = Number(evaluateExpression(
        '99 if any([s.dazzled for s in target.skills]) else 0',
        context(),
      ));
      target.skills = [make('_Blinded', [['blinded', null]])];
      const aquila = new ItemObject({
        nid: 'Aquila',
        name: 'Aquila',
        desc: '',
        icon_nid: '',
        icon_index: [0, 0],
        components: [['weapon', null], ['item_tags', []]],
      });
      const blinded = Boolean(evaluateExpression(
        "any([s.blinded for s in target.skills]) and " +
        "not 'TrueDamage' in item.tags and 'Aquila' == item.nid",
        context(aquila),
      ));
      target.skills = [make('_NullSweep', [['null_sweep', null]])];
      const sweepAllowed = Boolean(evaluateExpression(
        'not any([s.null_sweep for s in target.skills])',
        context(),
      ));
      unit.skills = [make('_Berserked', [['berserked', null]])];
      const berserkHits = Number(evaluateExpression(
        '2 if any([s.berserked for s in unit.skills]) else 1',
        context(),
      ));
      target.skills = [make('_Paragon', [['paragon', null]])];
      const paragon = Boolean(evaluateExpression(
        'any([s.paragon for s in target.skills])',
        context(),
      ));

      unit.skills = old.unitSkills;
      target.skills = old.targetSkills;
      unit.team = old.unitTeam;
      target.team = old.targetTeam;
      game.units = old.units;
      unit.currentHp = old.unitHp;
      return {
        truthiness,
        fatalLastEnemy,
        fatalWithSurvivor,
        fatalUnblocked,
        fatalBlocked,
        stackCandidates,
        dazzled,
        blinded,
        sweepAllowed,
        berserkHits,
        paragon,
      };
    }, [...MARKERS]);

    expect(result.truthiness).toEqual(Object.fromEntries(
      MARKERS.map((marker) => [marker, { present: true, absent: false }]),
    ));
    expect(result).toMatchObject({
      fatalLastEnemy: true,
      fatalWithSurvivor: false,
      fatalUnblocked: true,
      fatalBlocked: false,
      stackCandidates: ['_Stackable'],
      dazzled: 99,
      blinded: true,
      sweepAllowed: false,
      berserkHits: 2,
      paragon: true,
    });
  });
});
