import { expect, test, type Page } from '@playwright/test';

/**
 * Python UnitObject.tags = own tags | class tags | skill additional_tags.
 * EOtF relies on class tags (Door/Wall/Pylon classes carry 'Tile') and on
 * skill has_tags (Convoy, AlwaysRefresh, ...).
 */

async function bootEotf(page: Page): Promise<void> {
  await page.goto('/?harness=true&project=eotf.ltproj&level=X&clean=true&bundle=false');
  await page.waitForFunction(() => (window as any).__harness?.ready === true, undefined, {
    timeout: 60_000,
  });
}

test.describe('fork unit tag union', () => {
  test('class tags and skill has_tags count as unit tags in engine and event checks', async ({ page }) => {
    await bootEotf(page);
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { unitHasTag, unitTags } = await import('/src/combat/skill-system.ts');
      const { evaluateCondition, evaluateExpression } = await import('/src/events/event-manager.ts');
      const { SkillObject } = await import('/src/objects/skill.ts');
      const unit = game.units.get('Keeper');
      const oldKlass = unit.klass;
      const oldSkills = unit.skills;
      unit.klass = 'Door20';
      unit.skills = [];
      const door = {
        ownTile: unit.tags.includes('Tile'),
        tile: unitHasTag(unit, 'Tile', game),
        condition: evaluateCondition("'Tile' in unit.tags", { game, unit1: unit }),
        notCondition: evaluateCondition("'Tile' not in unit.tags", { game, unit1: unit }),
        listed: (evaluateExpression('[u.nid for u in game.get_all_units()]', { game }) as string[])
          .includes(unit.nid),
      };
      unit.klass = oldKlass;
      unit.skills = [new SkillObject(game.db.skills.get('Convoy'))];
      const skillTags = {
        convoy: unitHasTag(unit, 'Convoy', game),
        adj: unitTags(unit, game).has('AdjConvoy'),
        condition: evaluateCondition("'Convoy' in unit.tags", { game, unit1: unit }),
      };
      unit.skills = oldSkills;
      return { door, skillTags, listedAfter: (evaluateExpression(
        '[u.nid for u in game.get_all_units()]', { game },
      ) as string[]).includes(unit.nid) };
    });
    expect(result.door).toEqual({
      ownTile: false, tile: true, condition: true, notCondition: false, listed: false,
    });
    expect(result.skillTags).toEqual({ convoy: true, adj: true, condition: true });
    expect(result.listedAfter).toBe(true);
  });

  test('Supply uses skill-granted Convoy tags and refuses Temporary units', async ({ page }) => {
    await bootEotf(page);
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { supplyAvailableOnMap } = await import('/src/engine/states/supply-state.ts');
      const { SkillObject } = await import('/src/objects/skill.ts');
      const unit = game.units.get('Player');
      const oldSkills = unit.skills;
      const oldTags = [...unit.tags];
      const oldConvoy = game.gameVars.get('_convoy');
      game.gameVars.set('_convoy', true);
      unit.skills = [];
      const without = supplyAvailableOnMap(unit, game);
      unit.skills = [new SkillObject(game.db.skills.get('Bag_of_Holding'))];
      const withSkill = supplyAvailableOnMap(unit, game);
      unit.tags.push('Temporary');
      const temporary = supplyAvailableOnMap(unit, game);
      unit.tags = oldTags;
      unit.skills = oldSkills;
      if (oldConvoy === undefined) game.gameVars.delete('_convoy');
      else game.gameVars.set('_convoy', oldConvoy);
      return { hasPosition: !!unit.position, without, withSkill, temporary };
    });
    expect(result.hasPosition).toBe(true);
    expect(result.without).toBe(false);
    expect(result.withSkill).toBe(true);
    expect(result.temporary).toBe(false);
  });
});
