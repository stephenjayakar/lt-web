import { expect, test, type Page } from '@playwright/test';

async function bootEotf(page: Page): Promise<void> {
  await page.goto('/?harness=true&project=eotf.ltproj&level=X&clean=true&bundle=false');
  await page.waitForFunction(() => (window as any).__harness?.ready === true, undefined, {
    timeout: 30_000,
  });
}

test.describe('Embrace of the Fog all_brave skills', () => {
  test('count-locks all five authored marker uses', async ({ page }) => {
    await bootEotf(page);
    const uses = await page.evaluate(() => {
      const game = (window as any).__gameRef;
      return [...game.db.skills.values()]
        .filter((skill: any) =>
          skill.components.some(([nid]: [string, unknown]) => nid === 'all_brave'))
        .map((skill: any) => [
          skill.nid,
          skill.components.find(([nid]: [string, unknown]) => nid === 'all_brave')[1],
        ]);
    });
    expect(uses).toEqual([
      ['Disco_Inferno', null],
      ['Enchanted_Blade_P', null],
      ['Razing_Claws_Proc', null],
      ['Brave_Lion_Proc', null],
      ['Ethereal_Fist_Proc', null],
    ]);
  });

  test('adds one active strike in attack and defense modes and stacks with item brave', async ({ page }) => {
    await bootEotf(page);
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { SkillObject } = await import('/src/objects/skill.ts');
      const { ItemObject } = await import('/src/objects/item.ts');
      const { computeStrikeCount } = await import('/src/combat/combat-calcs.ts');
      const attacker = game.units.get('Player');
      const defender = game.units.get('Keeper');
      const active = new SkillObject({
        nid: '_AllBraveActive',
        name: 'All Brave Active',
        desc: '',
        icon_nid: '',
        icon_index: [0, 0],
        components: [['all_brave', null]],
      });
      const inactive = new SkillObject({
        nid: '_AllBraveInactive',
        name: 'All Brave Inactive',
        desc: '',
        icon_nid: '',
        icon_index: [0, 0],
        components: [['all_brave', null], ['condition', 'False']],
      });
      const normal = new ItemObject({
        nid: '_NormalWeapon',
        name: 'Normal Weapon',
        desc: '',
        components: [['weapon', null], ['damage', 1], ['hit', 100]],
      });
      const brave = new ItemObject({
        nid: '_BraveWeapon',
        name: 'Brave Weapon',
        desc: '',
        components: [['weapon', null], ['damage', 1], ['hit', 100], ['brave', null]],
      });
      const oldSkills = attacker.skills;
      try {
        attacker.skills = [active, inactive];
        return {
          attack: computeStrikeCount(
            attacker, normal, defender, null, 'attack', [0, 0], game,
          ),
          defense: computeStrikeCount(
            attacker, normal, defender, null, 'defense', [0, 0], game,
          ),
          stacked: computeStrikeCount(
            attacker, brave, defender, null, 'attack', [0, 0], game,
          ),
        };
      } finally {
        attacker.skills = oldSkills;
      }
    });

    expect(result).toEqual({ attack: 2, defense: 2, stacked: 3 });
  });
});
