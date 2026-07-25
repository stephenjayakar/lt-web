import { expect, test, type Page } from '@playwright/test';

async function bootEotf(page: Page): Promise<void> {
  await page.goto('/?harness=true&project=eotf.ltproj&level=X&clean=true&bundle=false');
  await page.waitForFunction(() => (window as any).__harness?.ready === true, undefined, {
    timeout: 30_000,
  });
}

test.describe('Embrace of the Fog self_nihil', () => {
  test('blocks real and synthetic skills across condition-aware dispatchers', async ({ page }) => {
    await bootEotf(page);
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { SkillObject } = await import('/src/objects/skill.ts');
      const { skillCondition } = await import('/src/combat/item-system.ts');
      const {
        canSelect,
        movementType,
      } = await import('/src/combat/skill-system.ts');
      const { combatArtReady } = await import('/src/combat/combat-art-system.ts');
      const { CombatSkillLifecycle } =
        await import('/src/combat/combat-skill-lifecycle.ts');
      const { ItemObject } = await import('/src/objects/item.ts');
      const { applySkillTurnHooks } =
        await import('/src/engine/skill-turn-lifecycle.ts');
      const { skillInfoPresentation } =
        await import('/src/engine/states/info-menu-state.ts');

      const unit = game.units.get('Player');
      const oldSkills = unit.skills;
      const realBerserk = new SkillObject(game.db.skills.get('Berserk'));
      const realBlocker = new SkillObject(game.db.skills.get('Legend'));

      unit.skills = [realBerserk];
      const realUnblocked = {
        condition: skillCondition(realBerserk, unit, game),
        selectable: canSelect(unit, game),
      };
      unit.skills = [realBerserk, realBlocker];
      const realBlocked = {
        condition: skillCondition(realBerserk, unit, game),
        selectable: canSelect(unit, game),
      };

      const make = (nid: string, components: [string, any][]) =>
        new SkillObject({ nid, name: nid, desc: '', components });
      const blocker = make('_SelfNihilBlocker', []);
      const gated = make('_SelfNihilGated', [
        ['self_nihil', [blocker.nid]],
        ['movement_type', 'Flying'],
        ['combat_art', '_SelfNihilChild'],
        ['upkeep_event', '_SelfNihilEvent'],
        ['grey_if_inactive', null],
      ]);
      const eventNids: string[] = [];
      const lifecycleGame = {
        actionLog: game.actionLog,
        db: game.db,
        gameVars: game.gameVars,
        levelVars: game.levelVars,
        eventManager: {
          triggerSpecific(nid: string) {
            eventNids.push(nid);
            return true;
          },
        },
      };

      unit.skills = [gated, blocker];
      const blocked = {
        movement: movementType(unit, 'Infantry', game),
        combatArt: combatArtReady(game, unit, gated),
        presentation: skillInfoPresentation(gated, unit, game),
      };
      applySkillTurnHooks(lifecycleGame, [unit], 'upkeep');
      const blockedEvents = [...eventNids];

      unit.skills = [gated];
      const unblocked = {
        movement: movementType(unit, 'Infantry', game),
        combatArt: combatArtReady(game, unit, gated),
        presentation: skillInfoPresentation(gated, unit, game),
      };
      applySkillTurnHooks(lifecycleGame, [unit], 'upkeep');
      const unblockedEvents = [...eventNids];

      const combatResource = make('_SelfNihilCombatResource', [
        ['self_nihil', [blocker.nid]],
        ['cost_mana', 1],
      ]);
      const combatItem = unit.items[0] ?? new ItemObject({
        nid: '_SelfNihilWeapon',
        name: 'Self Nihil Weapon',
        desc: '',
        components: [['weapon', null]],
      });
      const combatTarget = [...game.units.values()].find(
        (candidate: any) => candidate !== unit,
      ) ?? unit;
      const oldMana = unit.currentMana;
      unit.currentMana = 5;
      unit.skills = [combatResource, blocker];
      new CombatSkillLifecycle(game.db, () => 99, game).beginCombat(
        unit,
        combatItem,
        [combatTarget],
        new Map([[combatTarget, null]]),
      );
      const blockedMana = unit.currentMana;
      unit.skills = [combatResource];
      new CombatSkillLifecycle(game.db, () => 99, game).beginCombat(
        unit,
        combatItem,
        [combatTarget],
        new Map([[combatTarget, null]]),
      );
      const unblockedMana = unit.currentMana;
      unit.currentMana = oldMana;
      unit.skills = oldSkills;

      return {
        realValue: realBerserk.getComponent('self_nihil'),
        realUnblocked,
        realBlocked,
        blocked,
        blockedEvents,
        unblocked,
        unblockedEvents,
        blockedMana,
        unblockedMana,
      };
    });

    expect(result.realValue).toEqual(expect.arrayContaining([
      'Legend',
      'Hope_for_Humanity',
      'Master_of_the_Fog',
    ]));
    expect(result.realUnblocked).toEqual({
      condition: true,
      selectable: false,
    });
    expect(result.realBlocked).toEqual({
      condition: false,
      selectable: true,
    });
    expect(result.blocked).toEqual({
      movement: 'Infantry',
      combatArt: false,
      presentation: 'grey',
    });
    expect(result.blockedEvents).toEqual([]);
    expect(result.unblocked).toEqual({
      movement: 'Flying',
      combatArt: true,
      presentation: 'normal',
    });
    expect(result.unblockedEvents).toEqual(['_SelfNihilEvent']);
    expect(result.blockedMana).toBe(5);
    expect(result.unblockedMana).toBe(4);
  });
});
