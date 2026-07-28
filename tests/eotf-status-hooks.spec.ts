import { expect, test, type Page } from '@playwright/test';

async function bootEotf(page: Page): Promise<void> {
  await page.goto('/?harness=true&project=eotf.ltproj&level=X&clean=true&bundle=false');
  await page.waitForFunction(() => (window as any).__harness?.ready === true, undefined, {
    timeout: 60_000,
  });
}

test.describe('Embrace of the Fog status-grant combat hooks', () => {
  test('applies per-strike attacker and defender statuses inside the combat snapshot', async ({ page }) => {
    await bootEotf(page);
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { SkillObject } = await import('/src/objects/skill.ts');
      const { ItemObject } = await import('/src/objects/item.ts');
      const { MapCombat } = await import('/src/combat/map-combat.ts');
      const attacker = game.units.get('Player');
      const defender = game.units.get('Keeper');
      const oldAttackerSkills = attacker.skills;
      const oldDefenderSkills = defender.skills;
      const oldAttackerItems = attacker.items;
      const oldDefenderHp = defender.currentHp;
      const item = new ItemObject({
        nid: '_EotfStatusWeapon',
        name: 'EotF Status Weapon',
        desc: '',
        components: [
          ['weapon', null],
          ['damage', 100],
          ['hit', 100],
          ['uses', 20],
        ],
      });
      attacker.items = [item];
      defender.currentHp = Math.max(20, defender.maxHp);
      const make = (nid: string, components: [string, any][], charge: number) => {
        const skill = new SkillObject({ nid, name: nid, desc: '', components: [
          ...components,
          ['drain_charge', charge],
        ] });
        skill.data.set('charge', charge);
        skill.data.set('total_charge', charge);
        return skill;
      };
      const rewind = (before: number) => {
        while (game.actionLog.actionIndex > before) {
          game.actionLog.runActionBackward();
        }
      };
      const redo = (after: number) => {
        while (game.actionLog.actionIndex < after) {
          game.actionLog.runActionForward();
        }
      };

      const attackHook = make('_EotfAfterHit', [
        ['give_status_after_hit', 'Burning'],
      ], 2);
      const defenseHook = make('_EotfOnTakeHit', [
        ['give_status_on_take_hit', 'Toxin'],
        ['give_statuses_on_take_hit', ['Blunted', 'Exposed']],
      ], 4);
      attacker.skills = [attackHook];
      defender.skills = [defenseHook];
      const hitBefore = game.actionLog.actionIndex;
      const hitCombat = new MapCombat(
        attacker, item, defender, null, game.db, 'classic', game.board,
        ['hit1', 'end'], undefined, game,
      );
      hitCombat.applyResults(game.actionLog);
      const hitAfter = game.actionLog.actionIndex;
      const hitState = {
        attacker: attacker.skills.slice(1).map(
          (skill: any) => ({ nid: skill.nid, initiator: skill.initiatorNid ?? null }),
        ),
        defender: defender.skills.slice(1).map(
          (skill: any) => ({ nid: skill.nid, initiator: skill.initiatorNid ?? null }),
        ),
        attackCharge: attackHook.data.get('charge'),
        defenseCharge: defenseHook.data.get('charge'),
      };
      rewind(hitBefore);
      const hitRewound = {
        attacker: attacker.skills.map((skill: any) => skill.nid),
        defender: defender.skills.map((skill: any) => skill.nid),
        attackCharge: attackHook.data.get('charge'),
        defenseCharge: defenseHook.data.get('charge'),
      };
      redo(hitAfter);
      const hitRedone = {
        attacker: attacker.skills.slice(1).map((skill: any) => skill.nid),
        defender: defender.skills.slice(1).map((skill: any) => skill.nid),
      };

      const missAttackHook = make('_EotfAfterHitMiss', [
        ['give_status_after_hit', 'Burning'],
      ], 2);
      const missDefenseHook = make('_EotfOnTakeMiss', [
        ['give_status_on_take_hit', 'Toxin'],
      ], 2);
      attacker.skills = [missAttackHook];
      defender.skills = [missDefenseHook];
      defender.currentHp = Math.max(20, defender.maxHp);
      const missBefore = game.actionLog.actionIndex;
      const missCombat = new MapCombat(
        attacker, item, defender, null, game.db, 'classic', game.board,
        ['miss1', 'end'], undefined, game,
      );
      missCombat.applyResults(game.actionLog);
      const missAfter = game.actionLog.actionIndex;
      const missState = {
        attacker: attacker.skills.slice(1).map((skill: any) => skill.nid),
        defender: defender.skills.slice(1).map((skill: any) => skill.nid),
        attackCharge: missAttackHook.data.get('charge'),
        defenseCharge: missDefenseHook.data.get('charge'),
      };
      rewind(missBefore);
      const missRewound = {
        attacker: attacker.skills.map((skill: any) => skill.nid),
        defender: defender.skills.map((skill: any) => skill.nid),
        attackCharge: missAttackHook.data.get('charge'),
        defenseCharge: missDefenseHook.data.get('charge'),
      };
      redo(missAfter);

      const blockedAttackHook = make('_EotfBlockedAfterHit', [
        ['give_status_after_hit', 'Burning'],
      ], 2);
      const immunity = new SkillObject({
        nid: '_EotfNegativeImmunity',
        name: 'Negative Immunity',
        desc: '',
        components: [['immune_status', null]],
      });
      attacker.skills = [blockedAttackHook];
      defender.skills = [immunity];
      defender.currentHp = Math.max(20, defender.maxHp);
      const blockedBefore = game.actionLog.actionIndex;
      const blockedCombat = new MapCombat(
        attacker, item, defender, null, game.db, 'classic', game.board,
        ['hit1', 'end'], undefined, game,
      );
      blockedCombat.applyResults(game.actionLog);
      const blockedAfter = game.actionLog.actionIndex;
      const blockedState = {
        burning: defender.skills.some((skill: any) => skill.nid === 'Burning'),
        charge: blockedAttackHook.data.get('charge'),
      };
      rewind(blockedBefore);
      const blockedRewound = {
        skills: defender.skills.map((skill: any) => skill.nid),
        charge: blockedAttackHook.data.get('charge'),
      };
      redo(blockedAfter);

      const componentValue = (skillNid: string, componentNid: string) =>
        game.db.skills.get(skillNid)?.components.find(
          ([nid]: [string, any]) => nid === componentNid,
        )?.[1];
      const values = {
        afterHit: componentValue('PoisonFangs', 'give_status_after_hit'),
        onTakeHit: componentValue('Everlasting_Flame', 'give_status_on_take_hit'),
        statusesOnTakeHit: componentValue(
          'Repel',
          'give_statuses_on_take_hit',
        ),
      };
      attacker.skills = oldAttackerSkills;
      defender.skills = oldDefenderSkills;
      attacker.items = oldAttackerItems;
      defender.currentHp = oldDefenderHp;
      return {
        hit: { state: hitState, rewound: hitRewound, redone: hitRedone },
        miss: { state: missState, rewound: missRewound },
        blocked: { state: blockedState, rewound: blockedRewound },
        values,
      };
    });

    expect(result.hit).toEqual({
      state: {
        attacker: [
          { nid: 'Toxin', initiator: 'Keeper' },
          { nid: 'Blunted', initiator: 'Keeper' },
          { nid: 'Exposed', initiator: 'Keeper' },
        ],
        defender: [{ nid: 'Burning', initiator: 'Player' }],
        attackCharge: 1,
        defenseCharge: 2,
      },
      rewound: {
        attacker: ['_EotfAfterHit'],
        defender: ['_EotfOnTakeHit'],
        attackCharge: 2,
        defenseCharge: 4,
      },
      redone: {
        attacker: ['Toxin', 'Blunted', 'Exposed'],
        defender: ['Burning'],
      },
    });
    expect(result.miss).toEqual({
      state: {
        attacker: ['Toxin'],
        defender: [],
        attackCharge: 2,
        defenseCharge: 1,
      },
      rewound: {
        attacker: ['_EotfAfterHitMiss'],
        defender: ['_EotfOnTakeMiss'],
        attackCharge: 2,
        defenseCharge: 2,
      },
    });
    expect(result.blocked).toEqual({
      state: { burning: false, charge: 1 },
      rewound: { skills: ['_EotfNegativeImmunity'], charge: 2 },
    });
    expect(result.values).toEqual({
      afterHit: 'Toxin',
      onTakeHit: 'Burning',
      statusesOnTakeHit: ['Dazzled', 'Exposed'],
    });
  });

  test('applies end-combat status families once with exact recipients and charge', async ({ page }) => {
    await bootEotf(page);
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { SkillObject } = await import('/src/objects/skill.ts');
      const { ItemObject } = await import('/src/objects/item.ts');
      const { applyCombatSkillEndHooks } =
        await import('/src/combat/combat-lifecycle.ts');
      const attacker = game.units.get('Player');
      const defender = game.units.get('Keeper');
      const splash = game.units.get('Lib');
      const oldAttackerSkills = attacker.skills;
      const oldDefenderSkills = defender.skills;
      const oldSplashSkills = splash.skills;
      const oldDefenderTeam = defender.team;
      const oldSplashTeam = splash.team;
      defender.team = 'enemy';
      splash.team = 'enemy';
      const item = new ItemObject({
        nid: '_EotfEndStatusWeapon',
        name: 'EotF End Status Weapon',
        desc: '',
        components: [['weapon', null]],
      });
      const make = (nid: string, components: [string, any][], charge: number) => {
        const skill = new SkillObject({ nid, name: nid, desc: '', components: [
          ...components,
          ['drain_charge', charge],
        ] });
        skill.data.set('charge', charge);
        skill.data.set('total_charge', charge);
        return skill;
      };
      const strike = (target: any) => ({
        attacker,
        defender: target,
        item,
        hit: true,
        crit: false,
        damage: 4,
        isCounter: false,
        mode: 'attack',
        attackInfo: [0, 0] as [number, number],
      });
      const rewind = (before: number) => {
        while (game.actionLog.actionIndex > before) {
          game.actionLog.runActionBackward();
        }
      };
      const redo = (after: number) => {
        while (game.actionLog.actionIndex < after) {
          game.actionLog.runActionForward();
        }
      };

      const standard = make('_EotfEndStatuses', [
        ['give_status_after_combat', 'Toxin'],
        ['give_status_after_attack', 'Chilled'],
        ['give_status_after_combat_on_hit', 'Dazzled'],
        ['give_statuses_after_combat', ['Blunted', 'Exposed']],
        ['better_give_status_after_combat_on_hit', 'Burning'],
      ], 10);
      attacker.skills = [standard];
      defender.skills = [];
      const standardBefore = game.actionLog.actionIndex;
      const standardApplied = applyCombatSkillEndHooks(
        game, [strike(defender)], attacker, defender,
      );
      const standardAfter = game.actionLog.actionIndex;
      const standardState = {
        statuses: defender.skills.map(
          (skill: any) => ({ nid: skill.nid, initiator: skill.initiatorNid ?? null }),
        ),
        charge: standard.data.get('charge'),
      };
      rewind(standardBefore);
      const standardRewound = {
        statuses: defender.skills.map((skill: any) => skill.nid),
        charge: standard.data.get('charge'),
      };
      redo(standardAfter);
      const standardRedone = defender.skills.map((skill: any) => skill.nid);

      const area = make('_EotfBetterStatus', [
        ['better_give_status_after_combat_on_hit', 'Burning'],
      ], 2);
      attacker.skills = [area];
      defender.skills = [];
      splash.skills = [];
      const areaBefore = game.actionLog.actionIndex;
      const areaApplied = applyCombatSkillEndHooks(
        game,
        [strike(defender), strike(splash)],
        attacker,
        defender,
      );
      const areaAfter = game.actionLog.actionIndex;
      const areaState = {
        defender: defender.skills.map((skill: any) => skill.nid),
        splash: splash.skills.map((skill: any) => skill.nid),
        charge: area.data.get('charge'),
      };
      rewind(areaBefore);
      const areaRewound = {
        defender: defender.skills.map((skill: any) => skill.nid),
        splash: splash.skills.map((skill: any) => skill.nid),
        charge: area.data.get('charge'),
      };
      redo(areaAfter);
      const areaRedone = {
        defender: defender.skills.map((skill: any) => skill.nid),
        splash: splash.skills.map((skill: any) => skill.nid),
      };

      const allyStandard = make('_EotfAllyStatus', [
        ['give_ally_status_after_combat', 'Didgeridoo_Effect'],
      ], 2);
      attacker.skills = [allyStandard];
      defender.skills = [];
      defender.team = 'player';
      const allyStandardApplied = applyCombatSkillEndHooks(
        game, [strike(defender)], attacker, defender,
      );
      const allyStandardState = {
        statuses: defender.skills.map((skill: any) => skill.nid),
        charge: allyStandard.data.get('charge'),
      };

      const allyArea = make('_EotfBetterAllyStatus', [
        ['better_give_ally_status_after_combat_on_hit', 'Blessed_Cloth_Effect_Child'],
      ], 2);
      attacker.skills = [allyArea];
      defender.skills = [];
      splash.skills = [];
      splash.team = 'player';
      const allyAreaApplied = applyCombatSkillEndHooks(
        game,
        [strike(defender), strike(splash)],
        attacker,
        defender,
      );
      const allyAreaState = {
        defender: defender.skills.map((skill: any) => skill.nid),
        splash: splash.skills.map((skill: any) => skill.nid),
        charge: allyArea.data.get('charge'),
      };

      const componentValue = (skillNid: string, componentNid: string) =>
        game.db.skills.get(skillNid)?.components.find(
          ([nid]: [string, any]) => nid === componentNid,
        )?.[1];
      const values = {
        afterCombat: componentValue('Disruption', 'give_status_after_combat'),
        afterAttack: componentValue('Winter_Chill', 'give_status_after_attack'),
        afterCombatHit: componentValue(
          'Scarlet_Edge',
          'give_status_after_combat_on_hit',
        ),
        statusesAfterCombat: componentValue(
          'Barbed',
          'give_statuses_after_combat',
        ),
        betterAfterHit: componentValue(
          'Bloody_Moon',
          'better_give_status_after_combat_on_hit',
        ),
        allyAfterCombat: componentValue(
          'Didgeridoo_Equip',
          'give_ally_status_after_combat',
        ),
        betterAllyAfterHit: componentValue(
          'Blessed_Cloth_Effect',
          'better_give_ally_status_after_combat_on_hit',
        ),
      };
      attacker.skills = oldAttackerSkills;
      defender.skills = oldDefenderSkills;
      splash.skills = oldSplashSkills;
      defender.team = oldDefenderTeam;
      splash.team = oldSplashTeam;
      return {
        standard: {
          applied: standardApplied,
          state: standardState,
          rewound: standardRewound,
          redone: standardRedone,
        },
        area: {
          applied: areaApplied,
          state: areaState,
          rewound: areaRewound,
          redone: areaRedone,
        },
        ally: {
          standard: {
            applied: allyStandardApplied,
            state: allyStandardState,
          },
          area: {
            applied: allyAreaApplied,
            state: allyAreaState,
          },
        },
        values,
      };
    });

    expect(result.standard).toEqual({
      applied: 6,
      state: {
        statuses: [
          { nid: 'Toxin', initiator: 'Player' },
          { nid: 'Chilled', initiator: 'Player' },
          { nid: 'Dazzled', initiator: 'Player' },
          { nid: 'Blunted', initiator: 'Player' },
          { nid: 'Exposed', initiator: 'Player' },
          { nid: 'Burning', initiator: 'Player' },
        ],
        charge: 5,
      },
      rewound: { statuses: [], charge: 10 },
      redone: ['Toxin', 'Chilled', 'Dazzled', 'Blunted', 'Exposed', 'Burning'],
    });
    expect(result.area).toEqual({
      applied: 2,
      state: {
        defender: ['Burning'],
        splash: ['Burning'],
        charge: 1,
      },
      rewound: { defender: [], splash: [], charge: 2 },
      redone: { defender: ['Burning'], splash: ['Burning'] },
    });
    expect(result.ally).toEqual({
      standard: {
        applied: 1,
        state: { statuses: ['Didgeridoo_Effect'], charge: 1 },
      },
      area: {
        applied: 2,
        state: {
          defender: ['Blessed_Cloth_Effect_Child'],
          splash: ['Blessed_Cloth_Effect_Child'],
          charge: 1,
        },
      },
    });
    expect(result.values).toEqual({
      afterCombat: 'Disrupted',
      afterAttack: 'Chilled',
      afterCombatHit: 'Burning',
      statusesAfterCombat: ['Blunted', 'Exposed'],
      betterAfterHit: 'Bleeding',
      allyAfterCombat: 'Didgeridoo_Effect',
      betterAllyAfterHit: 'Blessed_Cloth_Effect_Child',
    });
  });
});
