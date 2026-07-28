import { expect, test, type Page } from '@playwright/test';

async function bootEotf(page: Page): Promise<void> {
  await page.goto('/?harness=true&project=eotf.ltproj&level=X&clean=true&bundle=false');
  await page.waitForFunction(() => (window as any).__harness?.ready === true, undefined, {
    timeout: 60_000,
  });
}

test.describe('Embrace of the Fog expression growth modifiers', () => {
  test('count-locks all three skills and evaluates real record-driven growths', async ({
    page,
  }) => {
    await bootEotf(page);
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { SkillObject } = await import('/src/objects/skill.ts');
      const { growthChange } = await import('/src/combat/skill-system.ts');
      const { RECORDS } = await import('/src/engine/records.ts');
      const unit = game.units.get('Player');
      const oldSkills = unit.skills;
      const oldDensity = RECORDS.get('current_density');
      const authored: Array<{ skill: string; entries: number }> = [];
      for (const skill of game.db.skills.values()) {
        const value = skill.components.find(
          ([component]: [string, unknown]) => component === 'growth_change_expression',
        )?.[1];
        if (Array.isArray(value)) authored.push({ skill: skill.nid, entries: value.length });
      }
      authored.sort((left, right) => left.skill.localeCompare(right.skill));

      RECORDS.set('current_density', 7);
      unit.skills = [new SkillObject(game.db.skills.get('Fogbound'))];
      const fogbound = {
        hp: growthChange(unit, 'HP', game),
        str: growthChange(unit, 'STR', game),
      };

      const staticGrowth = new SkillObject({
        nid: '_StaticGrowth',
        name: '',
        desc: '',
        icon_nid: '',
        icon_index: [0, 0],
        components: [['growth_change', [['HP', 6]]]],
      });
      const inactiveGrowth = new SkillObject({
        nid: '_InactiveGrowth',
        name: '',
        desc: '',
        icon_nid: '',
        icon_index: [0, 0],
        components: [
          ['condition', 'False'],
          ['growth_change_expression', [['HP', '99']]],
        ],
      });
      unit.skills = [
        staticGrowth,
        new SkillObject(game.db.skills.get('Fogbound')),
        inactiveGrowth,
      ];
      const combined = growthChange(unit, 'HP', game);

      unit.skills = oldSkills;
      if (oldDensity === null) RECORDS.delete('current_density');
      else RECORDS.set('current_density', oldDensity);
      return { authored, fogbound, combined };
    });

    expect(result.authored).toEqual([
      { skill: 'Avenger', entries: 8 },
      { skill: 'Avenger_Plus', entries: 8 },
      { skill: 'Fogbound', entries: 8 },
    ]);
    expect(result.fogbound).toEqual({ hp: 14, str: 14 });
    expect(result.combined).toBe(20);
  });
});
