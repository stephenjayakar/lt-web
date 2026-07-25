import { expect, test, type Page } from '@playwright/test';

async function bootEotf(page: Page): Promise<void> {
  await page.goto('/?harness=true&project=eotf.ltproj&level=X&clean=true&bundle=false');
  await page.waitForFunction(() => (window as any).__harness?.ready === true, undefined, {
    timeout: 30_000,
  });
}

test.describe('Embrace of the Fog event skill hooks', () => {
  test('preserves combat playback, kill charge, and reversible upkeep grants', async ({ page }) => {
    await bootEotf(page);
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { SkillObject } = await import('/src/objects/skill.ts');
      const { ItemObject } = await import('/src/objects/item.ts');
      const { evaluateCondition } = await import('/src/events/event-manager.ts');
      const { queueCombatSkillEvents } =
        await import('/src/combat/combat-lifecycle.ts');
      const { applySkillTurnHooks } =
        await import('/src/engine/skill-turn-lifecycle.ts');

      const attacker = game.units.get('Player');
      const defender = game.units.get('Keeper');
      const oldAttackerSkills = attacker.skills;
      const oldDefenderSkills = defender.skills;
      const oldDefenderHp = defender.currentHp;
      const combatItem = new ItemObject({
        nid: '_EotfEventWeapon',
        name: 'EotF Event Weapon',
        desc: '',
        components: [['weapon', null]],
      });
      const make = (nid: string, components: [string, any][]) =>
        new SkillObject({ nid, name: nid, desc: '', components });
      const killSkill = make('_EotfKillHook', [
        ['event_after_kill', '_EotfKillEvent'],
        ['drain_charge', 3],
      ]);
      killSkill.data.set('charge', 2);
      killSkill.data.set('total_charge', 3);
      const combatSkill = make('_EotfCombatHook', [
        ['event_after_combat', 'Global Ability_Fili_Flight'],
      ]);
      attacker.skills = [killSkill];
      defender.skills = [combatSkill];
      defender.currentHp = 0;

      const calls: any[] = [];
      const originalEventManager = game.eventManager;
      game.eventManager = {
        triggerSpecific(nid: string, trigger: any) {
          calls.push({ nid, trigger });
          return true;
        },
      };
      const beforeKillAction = game.actionLog.actionIndex;
      const queued = queueCombatSkillEvents(game, [{
        attacker,
        defender,
        item: combatItem,
        hit: false,
        crit: false,
        damage: 0,
        isCounter: false,
        mode: 'attack',
        attackInfo: [0, 0],
      }], attacker, defender, combatItem, combatItem);
      const charged = killSkill.data.get('charge');
      game.actionLog.runActionBackward();
      const rewoundCharge = killSkill.data.get('charge');
      game.actionLog.runActionForward();
      const redoneCharge = killSkill.data.get('charge');
      const playbackCall = calls.find(
        (call) => call.nid === 'Global Ability_Fili_Flight',
      );
      const playback = playbackCall?.trigger.localArgs.get('playback');
      const playbackCondition = evaluateCondition(
        "any(p.attacker is not unit and (p.main_attacker is not unit or p.attacker is not p.main_attacker.strike_partner) for p in [x for x in playback if x.nid in ('mark_miss')])",
        {
          game,
          unit1: defender,
          unit2: attacker,
          gameVars: game.gameVars,
          levelVars: game.levelVars,
          localArgs: playbackCall?.trigger.localArgs,
        },
      );
      const realUpkeep = new SkillObject(game.db.skills.get('Quick_Reload'));
      attacker.skills = [realUpkeep];
      calls.length = 0;
      const upkeepEffects = applySkillTurnHooks(game, [attacker], 'upkeep');
      const upkeepCall = calls[0];

      const grantSource = make('_EotfUpkeepGrant', [
        ['upkeep_skill_gain', 'Spectral_Steed_Status'],
      ]);
      attacker.skills = [grantSource];
      const beforeGrantAction = game.actionLog.actionIndex;
      const grantEffects = applySkillTurnHooks(game, [attacker], 'upkeep');
      const granted = attacker.skills.some(
        (skill: any) => skill.nid === 'Spectral_Steed_Status',
      );
      game.actionLog.runActionBackward();
      const removedOnRewind = !attacker.skills.some(
        (skill: any) => skill.nid === 'Spectral_Steed_Status',
      );
      game.actionLog.runActionForward();
      const restoredOnRedo = attacker.skills.some(
        (skill: any) => skill.nid === 'Spectral_Steed_Status',
      );

      const values = {
        eventAfterCombat: game.db.skills.get('Fili_Flight')
          ?.components.find(([nid]: [string, any]) => nid === 'event_after_combat')?.[1],
        eventAfterKill: game.db.skills.get('DishOut')
          ?.components.find(([nid]: [string, any]) => nid === 'event_after_kill')?.[1],
        upkeepEvent: game.db.skills.get('Quick_Reload')
          ?.components.find(([nid]: [string, any]) => nid === 'upkeep_event')?.[1],
        upkeepSkillGain: game.db.skills.get('Spectral_Steed')
          ?.components.find(([nid]: [string, any]) => nid === 'upkeep_skill_gain')?.[1],
      };

      attacker.skills = oldAttackerSkills;
      defender.skills = oldDefenderSkills;
      defender.currentHp = oldDefenderHp;
      game.eventManager = originalEventManager;
      return {
        queued,
        combatCalls: playback ? [
          playback[0].nid,
          playback[0].attacker.nid,
          playback[0].main_attacker.nid,
        ] : null,
        playbackCondition,
        charged,
        rewoundCharge,
        redoneCharge,
        killActions: game.actionLog.actionIndex - beforeKillAction,
        upkeep: {
          nid: upkeepCall?.nid,
          type: upkeepCall?.trigger.type,
          unit1: upkeepCall?.trigger.unit1.nid,
          unit2: upkeepCall?.trigger.unit2.nid,
          item: upkeepCall?.trigger.localArgs.get('item'),
          mode: upkeepCall?.trigger.localArgs.get('mode'),
          effects: upkeepEffects.map((effect: any) => effect.component),
        },
        grant: {
          effects: grantEffects.map((effect: any) => effect.component),
          granted,
          removedOnRewind,
          restoredOnRedo,
          actions: game.actionLog.actionIndex - beforeGrantAction,
        },
        values,
      };
    });

    expect(result.queued).toBe(2);
    expect(result.combatCalls).toEqual(['mark_miss', 'Player', 'Player']);
    expect(result.playbackCondition).toBe(true);
    expect([result.charged, result.rewoundCharge, result.redoneCharge]).toEqual([
      1, 2, 1,
    ]);
    expect(result.killActions).toBeGreaterThanOrEqual(1);
    expect(result.upkeep).toEqual({
      nid: 'Global Stratagem_Quick_Reload',
      type: 'upkeep_event',
      unit1: 'Player',
      unit2: 'Player',
      item: null,
      mode: null,
      effects: ['upkeep_event'],
    });
    expect(result.grant).toEqual({
      effects: ['upkeep_skill_gain'],
      granted: true,
      removedOnRewind: true,
      restoredOnRedo: true,
      actions: 1,
    });
    expect(result.values).toEqual({
      eventAfterCombat: 'Global Ability_Fili_Flight',
      eventAfterKill: 'Global Ability_DishOut',
      upkeepEvent: 'Global Stratagem_Quick_Reload',
      upkeepSkillGain: 'Spectral_Steed_Status',
    });
  });
});
