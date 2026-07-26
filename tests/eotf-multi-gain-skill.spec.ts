import { expect, test, type Page } from '@playwright/test';

async function bootEotf(page: Page): Promise<void> {
  await page.goto('/?harness=true&project=eotf.ltproj&level=X&clean=true&bundle=false');
  await page.waitForFunction(() => (window as any).__harness?.ready === true, undefined, {
    timeout: 30_000,
  });
}

test.describe('Embrace of the Fog multi-skill combat grant', () => {
  test('grants the authored list in order, triggers charge once, and replays exactly', async ({
    page,
  }) => {
    await bootEotf(page);
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { ItemObject } = await import('/src/objects/item.ts');
      const { SkillObject } = await import('/src/objects/skill.ts');
      const { applyCombatSkillEndHooks } =
        await import('/src/combat/combat-lifecycle.ts');
      const attacker = game.units.get('Player');
      const defender = game.units.get('Keeper');
      const oldSkills = attacker.skills;
      const oldDefenderHp = defender.currentHp;
      const authored = [...game.db.skills.values()]
        .flatMap((skill: any) => skill.components
          .filter(([component]: [string, unknown]) =>
            component === 'gain_skills_after_combat')
          .map(([, value]: [string, unknown]) => ({ skill: skill.nid, value })));
      const source = new SkillObject({
        nid: '_MultiCombatGain',
        name: '',
        desc: '',
        icon_nid: '',
        icon_index: [0, 0],
        components: [
          ['gain_skills_after_combat', ['Adventure', 'Bond_Power']],
          ['drain_charge', 2],
        ],
      });
      source.data.set('charge', 2);
      source.data.set('total_charge', 2);
      const item = new ItemObject({
        nid: '_MultiGainWeapon',
        name: '',
        desc: '',
        icon_nid: '',
        icon_index: [0, 0],
        components: [['weapon', null]],
      });
      attacker.skills = [source];
      defender.currentHp = Math.max(1, defender.currentHp);
      const before = game.actionLog.actionIndex;
      const applied = applyCombatSkillEndHooks(game, [{
        attacker,
        defender,
        item,
        hit: true,
        crit: false,
        damage: 0,
        isCounter: false,
        mode: 'attack',
        attackInfo: [0, 0],
      }], attacker, defender);
      const after = game.actionLog.actionIndex;
      const granted = attacker.skills.slice(1).map((skill: any) => skill.nid);
      const charge = source.data.get('charge');
      while (game.actionLog.actionIndex > before) game.actionLog.runActionBackward();
      const rewound = {
        skills: attacker.skills.map((skill: any) => skill.nid),
        charge: source.data.get('charge'),
      };
      while (game.actionLog.actionIndex < after) game.actionLog.runActionForward();
      const redone = {
        skills: attacker.skills.slice(1).map((skill: any) => skill.nid),
        charge: source.data.get('charge'),
      };
      attacker.skills = oldSkills;
      defender.currentHp = oldDefenderHp;
      return { authored, applied, granted, charge, rewound, redone };
    });

    expect(result.authored).toEqual([{
      skill: 'Our_Power_Combined_Proc',
      value: ['Adventure', 'Bond_Power'],
    }]);
    expect(result).toMatchObject({
      applied: 2,
      granted: ['Adventure', 'Bond_Power'],
      charge: 1,
      rewound: { skills: ['_MultiCombatGain'], charge: 2 },
      redone: { skills: ['Adventure', 'Bond_Power'], charge: 1 },
    });
  });
});
