import { expect, test, type Page } from '@playwright/test';

async function bootEotf(page: Page): Promise<void> {
  await page.goto('/?harness=true&project=eotf.ltproj&level=X&clean=true&bundle=false');
  await page.waitForFunction(() => (window as any).__harness?.ready === true, undefined, {
    timeout: 60_000,
  });
}

test.describe('Embrace of the Fog after-gain propagation', () => {
  test('count-locks the two authored hardcoded status propagators', async ({ page }) => {
    await bootEotf(page);
    const inventory = await page.evaluate(() => {
      const selected = new Set(['bloody_moon', 'ride_the_lightning']);
      const rows: Array<{ skill: string; component: string; value: unknown }> = [];
      const game = (window as any).__gameRef;
      for (const skill of game.db.skills.values()) {
        for (const [component, value] of skill.components) {
          if (selected.has(component)) rows.push({ skill: skill.nid, component, value });
        }
      }
      return rows;
    });

    expect(inventory).toEqual([
      {
        skill: 'Bloody_Moon_Enemy',
        component: 'bloody_moon',
        value: null,
      },
      {
        skill: 'Ride_the_Lightning_Helper_Aura',
        component: 'ride_the_lightning',
        value: null,
      },
    ]);
  });

  test('Bloody Moon grants capped Beast stacks and reverses the complete chain', async ({
    page,
  }) => {
    await bootEotf(page);
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { SkillObject } = await import('/src/objects/skill.ts');
      const { ActionLog, AddSkillAction } = await import('/src/engine/action.ts');
      const afflicted = game.units.get('Keeper');
      const beast = game.units.get('Player');
      const old = {
        afflictedSkills: afflicted.skills,
        afflictedTeam: afflicted.team,
        afflictedPosition: afflicted.position,
        beastSkills: beast.skills,
        beastTeam: beast.team,
        beastPosition: beast.position,
        beastTags: beast.tags,
        beastDead: beast.dead,
        stratagems: game.gameVars.get('Active_Stratagems'),
      };
      afflicted.team = 'enemy';
      afflicted.position ??= [4, 4];
      afflicted.skills = [
        new SkillObject(game.db.skills.get('Bloody_Moon_Enemy')),
      ];
      beast.team = 'player';
      beast.position ??= [5, 4];
      beast.dead = false;
      beast.tags = [...new Set([...beast.tags, 'Beast'])];
      beast.skills = [];
      game.gameVars.set('Active_Stratagems', ['Bloody_Moon']);
      const { skillCondition } = await import('/src/combat/item-system.ts');
      const conditionActive = skillCondition(
        afflicted.skills[0],
        afflicted,
        game,
      );
      const actionLog = new ActionLog();
      const before = actionLog.actionIndex;
      for (let index = 0; index < 6; index++) {
        actionLog.doAction(new AddSkillAction(
          afflicted,
          new SkillObject(game.db.skills.get('Bleeding')),
        ));
      }
      const after = actionLog.actionIndex;
      const snapshot = () => ({
        bleeding: afflicted.skills.filter(
          (skill: any) => skill.nid === 'Bleeding',
        ).length,
        pursuit: beast.skills.filter(
          (skill: any) => skill.nid === 'Bloody_Moon_Effect',
        ).length,
        movement: beast.skills.filter(
          (skill: any) => skill.nid === 'Bloody_Moon_Effect_2',
        ).length,
        effectUids: beast.skills.map((skill: any) => skill.uid),
      });
      const changed = snapshot();
      while (actionLog.actionIndex > before) actionLog.runActionBackward();
      const reversed = snapshot();
      while (actionLog.actionIndex < after) actionLog.runActionForward();
      const redone = snapshot();

      while (actionLog.actionIndex > before) actionLog.runActionBackward();
      game.gameVars.set('Active_Stratagems', []);
      const inactiveLog = new ActionLog();
      inactiveLog.doAction(new AddSkillAction(
        afflicted,
        new SkillObject(game.db.skills.get('Bleeding')),
      ));
      const inactive = snapshot();

      afflicted.skills = old.afflictedSkills;
      afflicted.team = old.afflictedTeam;
      afflicted.position = old.afflictedPosition;
      beast.skills = old.beastSkills;
      beast.team = old.beastTeam;
      beast.position = old.beastPosition;
      beast.tags = old.beastTags;
      beast.dead = old.beastDead;
      if (old.stratagems === undefined) {
        game.gameVars.delete('Active_Stratagems');
      } else {
        game.gameVars.set('Active_Stratagems', old.stratagems);
      }
      return {
        changed,
        reversed,
        redone,
        inactive,
        conditionActive,
      };
    });

    expect(result.conditionActive).toBe(true);
    expect(result.changed).toMatchObject({
      bleeding: 6,
      pursuit: 5,
      movement: 2,
    });
    expect(result.reversed).toEqual({
      bleeding: 0,
      pursuit: 0,
      movement: 0,
      effectUids: [],
    });
    expect(result.redone).toEqual(result.changed);
    expect(result.inactive).toMatchObject({
      bleeding: 1,
      pursuit: 0,
      movement: 0,
    });
  });

  test('Ride the Lightning propagates Charged within three spaces with exact replay', async ({
    page,
  }) => {
    await bootEotf(page);
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { SkillObject } = await import('/src/objects/skill.ts');
      const { ActionLog, AddSkillAction } = await import('/src/engine/action.ts');
      const source = game.units.get('Player');
      const recipient = game.units.get('Keeper');
      const old = {
        sourceSkills: source.skills,
        sourceTeam: source.team,
        sourcePosition: source.position,
        recipientSkills: recipient.skills,
        recipientTeam: recipient.team,
        recipientPosition: recipient.position,
        recipientDead: recipient.dead,
      };
      source.team = 'player';
      source.position = [1, 1];
      source.skills = [
        new SkillObject(game.db.skills.get('Ride_the_Lightning_Helper_Aura')),
      ];
      recipient.team = 'player';
      recipient.position = [4, 1];
      recipient.dead = false;
      recipient.skills = [
        new SkillObject(game.db.skills.get('Ride_the_Lightning')),
      ];
      const actionLog = new ActionLog();
      const before = actionLog.actionIndex;
      actionLog.doAction(new AddSkillAction(
        source,
        new SkillObject(game.db.skills.get('Charged')),
      ));
      const after = actionLog.actionIndex;
      const snapshot = () => ({
        source: source.skills.filter((skill: any) => skill.nid === 'Charged')
          .map((skill: any) => ({
            uid: skill.uid,
            initiator: skill.initiatorNid,
          })),
        recipient: recipient.skills.filter(
          (skill: any) => skill.nid === 'Charged',
        ).map((skill: any) => ({
          uid: skill.uid,
          initiator: skill.initiatorNid,
        })),
      });
      const changed = snapshot();
      while (actionLog.actionIndex > before) actionLog.runActionBackward();
      const reversed = snapshot();
      while (actionLog.actionIndex < after) actionLog.runActionForward();
      const redone = snapshot();

      source.skills = old.sourceSkills;
      source.team = old.sourceTeam;
      source.position = old.sourcePosition;
      recipient.skills = old.recipientSkills;
      recipient.team = old.recipientTeam;
      recipient.position = old.recipientPosition;
      recipient.dead = old.recipientDead;
      return { changed, reversed, redone, recipientNid: recipient.nid };
    });

    expect(result.changed.source).toHaveLength(1);
    expect(result.changed.recipient).toHaveLength(1);
    expect(result.changed.recipient[0].initiator).toBe(result.recipientNid);
    expect(result.reversed).toEqual({ source: [], recipient: [] });
    expect(result.redone).toEqual(result.changed);
  });
});
