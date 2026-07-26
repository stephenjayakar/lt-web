import { expect, test, type Page } from '@playwright/test';

async function bootEotf(page: Page): Promise<void> {
  await page.goto('/?harness=true&project=eotf.ltproj&level=X&clean=true&bundle=false');
  await page.waitForFunction(() => (window as any).__harness?.ready === true, undefined, {
    timeout: 30_000,
  });
}

test.describe('Embrace of the Fog Armsthrift Always', () => {
  test('restores item trees after combat and replays before temporary-skill cleanup', async ({
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
      const oldTeam = defender.team;
      defender.team = 'enemy';

      const source = new SkillObject(game.db.skills.get('Armsthrift_Patcher_2'));
      attacker.skills = [source];
      const parent = new ItemObject({
        nid: '_ArmsthriftParent',
        name: '',
        desc: '',
        icon_nid: '',
        icon_index: [0, 0],
        components: [
          ['uses', 10],
          ['uses_options', {
            lose_uses_on_miss: false,
            one_loss_per_combat: false,
          }],
        ],
      });
      const child = new ItemObject({
        nid: '_ArmsthriftChild',
        name: '',
        desc: '',
        icon_nid: '',
        icon_index: [0, 0],
        components: [
          ['weapon', null],
          ['uses', 5],
          ['uses_options', {
            lose_uses_on_miss: false,
            one_loss_per_combat: false,
          }],
        ],
      });
      parent.subitems = [child];
      child.parentItem = parent;
      parent.setUses(2);
      child.setUses(1);
      const strike = {
        attacker,
        defender,
        item: child,
        hit: false,
        crit: false,
        damage: 0,
        isCounter: false,
        mode: 'attack',
        attackInfo: [0, 0] as [number, number],
      };
      const beforeIndex = game.actionLog.actionIndex;
      const before = {
        parent: parent.uses,
        child: child.uses,
        skills: attacker.skills.map((skill: any) => skill.nid),
      };
      const applied = applyCombatSkillEndHooks(
        game,
        [strike],
        attacker,
        defender,
      );
      const afterIndex = game.actionLog.actionIndex;
      const changed = {
        parent: parent.uses,
        child: child.uses,
        skills: attacker.skills.map((skill: any) => skill.nid),
      };
      while (game.actionLog.actionIndex > beforeIndex) {
        game.actionLog.runActionBackward();
      }
      const reversed = {
        parent: parent.uses,
        child: child.uses,
        skills: attacker.skills.map((skill: any) => skill.nid),
      };
      while (game.actionLog.actionIndex < afterIndex) {
        game.actionLog.runActionForward();
      }
      const redone = {
        parent: parent.uses,
        child: child.uses,
        skills: attacker.skills.map((skill: any) => skill.nid),
      };
      const authored = [...game.db.skills.values()]
        .filter((skill: any) => skill.components.some(
          ([nid]: [string, unknown]) => nid === 'armsthrift_always',
        ))
        .map((skill: any) => ({
          nid: skill.nid,
          value: skill.components.find(
            ([nid]: [string, unknown]) => nid === 'armsthrift_always',
          )?.[1],
        }));

      attacker.skills = oldSkills;
      defender.team = oldTeam;
      return { authored, applied, before, changed, reversed, redone };
    });

    expect(result.authored).toEqual([{
      nid: 'Armsthrift_Patcher_2',
      value: 1,
    }]);
    expect(result.applied).toBe(3);
    expect(result.changed).toEqual({
      parent: 3,
      child: 2,
      skills: [],
    });
    expect(result.reversed).toEqual(result.before);
    expect(result.redone).toEqual(result.changed);
  });

  test('requires uses options, skips unrepairable items, and does not drain charge', async ({
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
      const oldTeam = defender.team;
      defender.team = 'enemy';
      const source = new SkillObject({
        nid: '_ArmsthriftAlways',
        name: '',
        desc: '',
        icon_nid: '',
        icon_index: [0, 0],
        components: [
          ['armsthrift_always', 2],
          ['drain_charge', 2],
        ],
      });
      source.data.set('charge', 2);
      source.data.set('total_charge', 2);
      attacker.skills = [source];
      const makeItem = (
        nid: string,
        components: [string, unknown][],
      ) => {
        const item = new ItemObject({
          nid,
          name: '',
          desc: '',
          icon_nid: '',
          icon_index: [0, 0],
          components: [['weapon', null], ['uses', 5], ...components],
        });
        item.setUses(1);
        return item;
      };
      const noOptions = makeItem('_NoOptions', []);
      const unrepairable = makeItem('_Unrepairable', [
        ['uses_options', {}],
        ['unrepairable', null],
      ]);
      const chapterUses = new ItemObject({
        nid: '_ChapterUses',
        name: '',
        desc: '',
        icon_nid: '',
        icon_index: [0, 0],
        components: [
          ['weapon', null],
          ['c_uses', 5],
          ['uses_options', {}],
        ],
      });
      chapterUses.setUses(1);
      const invoke = (item: any) => applyCombatSkillEndHooks(game, [{
        attacker,
        defender,
        item,
        hit: false,
        crit: false,
        damage: 0,
        isCounter: false,
        mode: 'attack',
        attackInfo: [0, 0],
      }], attacker, defender);
      const applied = [
        invoke(noOptions),
        invoke(unrepairable),
        invoke(chapterUses),
      ];
      const output = {
        applied,
        noOptions: noOptions.uses,
        unrepairable: unrepairable.uses,
        chapterUses: chapterUses.uses,
        chapterData: chapterUses.data.get('c_uses'),
        charge: source.data.get('charge'),
      };
      attacker.skills = oldSkills;
      defender.team = oldTeam;
      return output;
    });

    expect(result).toEqual({
      applied: [0, 0, 1],
      noOptions: 1,
      unrepairable: 1,
      chapterUses: 3,
      chapterData: 3,
      charge: 2,
    });
  });
});
