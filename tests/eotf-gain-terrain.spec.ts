import { expect, test, type Page } from '@playwright/test';

async function bootEotf(page: Page): Promise<void> {
  await page.goto('/?harness=true&project=eotf.ltproj&level=X&clean=true&bundle=false');
  await page.waitForFunction(() => (window as any).__harness?.ready === true, undefined, {
    timeout: 30_000,
  });
}

test.describe('Embrace of the Fog Gain Terrain override', () => {
  test('restores terrain bonuses with Python false-priority resolution', async ({ page }) => {
    await bootEotf(page);
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { SkillObject } = await import('/src/objects/skill.ts');
      const {
        ignoreRegionStatus,
        ignoreTerrain,
      } = await import('/src/combat/skill-system.ts');
      const {
        getTerrainBonuses,
        getTerrainBonusesForUnit,
      } = await import('/src/combat/terrain-bonuses.ts');
      const unit = game.units.get('Player');
      const oldSkills = unit.skills;
      const oldPosition = unit.position;
      const terrain = [...game.db.terrain.values()].find((candidate: any) => {
        const [def, avoid] = getTerrainBonuses(candidate, game.db);
        return candidate.status && (def !== 0 || avoid !== 0);
      });
      if (!terrain) throw new Error('No terrain with a combat bonus');
      const expected = getTerrainBonuses(terrain, game.db);
      const board = { getTerrain: () => terrain.nid };
      unit.position = [0, 0];
      const flying = new SkillObject(game.db.skills.get('Flying'));
      const gain = new SkillObject(game.db.skills.get('Ambush_Predator'));

      unit.skills = [flying];
      const ignored = {
        terrain: ignoreTerrain(unit, game),
        region: ignoreRegionStatus(unit, game),
        bonus: getTerrainBonusesForUnit(unit, board as any, game.db, game),
      };
      unit.skills = [flying, gain];
      const restored = {
        terrain: ignoreTerrain(unit, game),
        region: ignoreRegionStatus(unit, game),
        bonus: getTerrainBonusesForUnit(unit, board as any, game.db, game),
      };
      const inactiveGain = new SkillObject({
        nid: '_InactiveGainTerrain',
        name: '',
        desc: '',
        icon_nid: '',
        icon_index: [0, 0],
        components: [['condition', 'False'], ['gain_terrain', null]],
      });
      unit.skills = [flying, inactiveGain];
      const inactive = {
        terrain: ignoreTerrain(unit, game),
        region: ignoreRegionStatus(unit, game),
      };
      const authored = [...game.db.skills.values()].flatMap((skill: any) =>
        skill.components.filter(([nid]: [string, unknown]) => nid === 'gain_terrain')
          .map(([, value]: [string, unknown]) => ({ skill: skill.nid, value })));
      unit.skills = oldSkills;
      unit.position = oldPosition;
      return { authored, expected, ignored, restored, inactive };
    });

    expect(result.authored).toEqual([{ skill: 'Ambush_Predator', value: null }]);
    expect(result.ignored).toEqual({
      terrain: true,
      region: true,
      bonus: [0, 0],
    });
    expect(result.restored).toEqual({
      terrain: false,
      region: false,
      bonus: result.expected,
    });
    expect(result.inactive).toEqual({ terrain: true, region: true });
  });
});
