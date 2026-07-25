import { expect, test, type Page } from '@playwright/test';

async function bootEotf(page: Page): Promise<void> {
  await page.goto('/?harness=true&project=eotf.ltproj&level=X&clean=true&bundle=false');
  await page.waitForFunction(() => (window as any).__harness?.ready === true, undefined, {
    timeout: 30_000,
  });
}

test.describe('Embrace of the Fog gain-skill combat hooks', () => {
  test('applies personal, reactive, and area grants with exact reversal', async ({ page }) => {
    await bootEotf(page);
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { SkillObject } = await import('/src/objects/skill.ts');
      const { ItemObject } = await import('/src/objects/item.ts');
      const { applyCombatSkillEndHooks } =
        await import('/src/combat/combat-lifecycle.ts');

      const attacker = game.units.get('Player');
      const defender = game.units.get('Keeper');
      const oldAttackerSkills = attacker.skills;
      const oldDefenderSkills = defender.skills;
      const oldDefenderItems = defender.items;
      const oldDefenderHp = defender.currentHp;
      const oldAttackerPosition = attacker.position;
      const oldDefenderPosition = defender.position;
      const oldDefenderTeam = defender.team;
      const item = new ItemObject({
        nid: '_EotfGainWeapon',
        name: 'EotF Gain Weapon',
        desc: '',
        components: [['weapon', null]],
      });
      const make = (nid: string, components: [string, any][]) =>
        new SkillObject({ nid, name: nid, desc: '', components });
      const strike = (hit: boolean, crit: boolean) => [{
        attacker,
        defender,
        item,
        hit,
        crit,
        damage: hit ? 5 : 0,
        isCounter: false,
        mode: 'attack',
        attackInfo: [0, 0] as [number, number],
      }];
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

      const personal = make('_EotfPersonalGains', [
        ['gain_skill_after_kill', 'Charged'],
        ['gain_skill_after_active_kill', 'Drive_Energy'],
        ['gain_skill_after_combat', 'Card'],
        ['gain_skill_after_attack', 'Rage'],
        ['gain_skill_after_crit', 'Perfect_Flow_Max'],
        ['drain_charge', 10],
      ]);
      personal.data.set('charge', 10);
      personal.data.set('total_charge', 10);
      attacker.skills = [personal];
      defender.skills = [];
      defender.items = [item];
      defender.currentHp = 0;
      const personalBefore = game.actionLog.actionIndex;
      const personalApplied = applyCombatSkillEndHooks(
        game, strike(true, true), attacker, defender,
      );
      const personalAfter = game.actionLog.actionIndex;
      const personalGranted = attacker.skills.slice(1).map(
        (skill: any) => ({ nid: skill.nid, initiator: skill.initiatorNid ?? null }),
      );
      const personalCharge = personal.data.get('charge');
      rewind(personalBefore);
      const personalRewound = {
        skills: attacker.skills.map((skill: any) => skill.nid),
        charge: personal.data.get('charge'),
      };
      redo(personalAfter);
      const personalRedone = attacker.skills.slice(1).map(
        (skill: any) => skill.nid,
      );

      const reactive = make('_EotfReactiveGain', [
        ['gain_skill_after_combat_on_take_hit', 'Empowered'],
        ['drain_charge', 2],
      ]);
      reactive.data.set('charge', 2);
      reactive.data.set('total_charge', 2);
      attacker.skills = [];
      defender.skills = [reactive];
      defender.currentHp = 10;
      const reactiveBefore = game.actionLog.actionIndex;
      const reactiveApplied = applyCombatSkillEndHooks(
        game, strike(true, false), attacker, defender,
      );
      const reactiveAfter = game.actionLog.actionIndex;
      const reactiveGrant = defender.skills.find(
        (skill: any) => skill.nid === 'Empowered',
      );
      const reactiveState = {
        initiator: reactiveGrant?.initiatorNid ?? null,
        charge: reactive.data.get('charge'),
      };
      rewind(reactiveBefore);
      const reactiveRewound = {
        granted: defender.skills.some((skill: any) => skill.nid === 'Empowered'),
        charge: reactive.data.get('charge'),
      };
      redo(reactiveAfter);
      const reactiveRedone = defender.skills.some(
        (skill: any) => skill.nid === 'Empowered',
      );

      const area = make('_EotfAreaGains', [
        ['aoe_gain_skill_after_combat', {
          skill: 'Prism_Buff',
          range: 2,
          affect_self: true,
          target: 'enemy',
        }],
        ['aoe_gain_skill_after_kill', {
          skill: 'Dazzled_Short',
          range: 2,
          affect_self: true,
          target: 'enemy',
        }],
        ['drain_charge', 4],
      ]);
      area.data.set('charge', 4);
      area.data.set('total_charge', 4);
      attacker.skills = [area];
      defender.skills = [];
      const adjacent = [
        [attacker.position[0] + 1, attacker.position[1]],
        [attacker.position[0] - 1, attacker.position[1]],
        [attacker.position[0], attacker.position[1] + 1],
        [attacker.position[0], attacker.position[1] - 1],
      ].find(([x, y]) => game.board.inBounds(x, y) && !game.board.getUnit(x, y));
      if (!adjacent) throw new Error('No adjacent tile for EotF area-grant test');
      game.board.moveUnit(defender, adjacent[0], adjacent[1]);
      defender.team = 'enemy';
      defender.currentHp = 0;
      const areaBefore = game.actionLog.actionIndex;
      const areaApplied = applyCombatSkillEndHooks(
        game, strike(true, false), attacker, defender,
      );
      const areaAfter = game.actionLog.actionIndex;
      const areaState = {
        attacker: attacker.skills.slice(1).map(
          (skill: any) => ({ nid: skill.nid, initiator: skill.initiatorNid ?? null }),
        ),
        defender: defender.skills.map(
          (skill: any) => ({ nid: skill.nid, initiator: skill.initiatorNid ?? null }),
        ),
        charge: area.data.get('charge'),
      };
      rewind(areaBefore);
      const areaRewound = {
        attacker: attacker.skills.map((skill: any) => skill.nid),
        defender: defender.skills.map((skill: any) => skill.nid),
        charge: area.data.get('charge'),
      };
      redo(areaAfter);
      const areaRedone = {
        attacker: attacker.skills.slice(1).map((skill: any) => skill.nid),
        defender: defender.skills.map((skill: any) => skill.nid),
      };

      const componentValue = (skillNid: string, componentNid: string) =>
        game.db.skills.get(skillNid)?.components.find(
          ([nid]: [string, any]) => nid === componentNid,
        )?.[1];
      const values = {
        afterKill: componentValue('Bounty_Reaper', 'gain_skill_after_kill'),
        afterActiveKill: componentValue(
          'Magictaker',
          'gain_skill_after_active_kill',
        ),
        afterCombat: componentValue(
          'Bellowing_Thunder',
          'gain_skill_after_combat',
        ),
        afterAttack: componentValue(
          'Charging_Descent',
          'gain_skill_after_attack',
        ),
        afterCrit: componentValue('Perfect_Flow', 'gain_skill_after_crit'),
        afterTakeHit: componentValue(
          'Impact_Absorption',
          'gain_skill_after_combat_on_take_hit',
        ),
        areaCombat: componentValue(
          'Prism_Effect',
          'aoe_gain_skill_after_combat',
        ),
        areaKill: componentValue('Sunshower', 'aoe_gain_skill_after_kill'),
      };

      attacker.skills = oldAttackerSkills;
      defender.skills = oldDefenderSkills;
      defender.items = oldDefenderItems;
      defender.currentHp = oldDefenderHp;
      if (oldDefenderPosition) {
        game.board.moveUnit(defender, oldDefenderPosition[0], oldDefenderPosition[1]);
      }
      attacker.position = oldAttackerPosition;
      defender.team = oldDefenderTeam;
      return {
        personal: {
          applied: personalApplied,
          granted: personalGranted,
          charge: personalCharge,
          rewound: personalRewound,
          redone: personalRedone,
        },
        reactive: {
          applied: reactiveApplied,
          state: reactiveState,
          rewound: reactiveRewound,
          redone: reactiveRedone,
        },
        area: {
          applied: areaApplied,
          state: areaState,
          rewound: areaRewound,
          redone: areaRedone,
        },
        values,
      };
    });

    expect(result.personal).toEqual({
      applied: 5,
      granted: [
        { nid: 'Charged', initiator: null },
        { nid: 'Drive_Energy', initiator: null },
        { nid: 'Card', initiator: null },
        { nid: 'Rage', initiator: null },
        { nid: 'Perfect_Flow_Max', initiator: 'Keeper' },
      ],
      charge: 5,
      rewound: { skills: ['_EotfPersonalGains'], charge: 10 },
      redone: ['Charged', 'Drive_Energy', 'Card', 'Rage', 'Perfect_Flow_Max'],
    });
    expect(result.reactive).toEqual({
      applied: 1,
      state: { initiator: 'Keeper', charge: 1 },
      rewound: { granted: false, charge: 2 },
      redone: true,
    });
    expect(result.area).toEqual({
      applied: 6,
      state: {
        attacker: [
          { nid: 'Prism_Buff', initiator: 'Player' },
        ],
        defender: [
          { nid: 'Prism_Buff', initiator: 'Player' },
        ],
        charge: 2,
      },
      rewound: {
        attacker: ['_EotfAreaGains'],
        defender: [],
        charge: 4,
      },
      redone: {
        attacker: ['Prism_Buff'],
        defender: ['Prism_Buff'],
      },
    });
    expect(result.values).toEqual({
      afterKill: 'Bounty_Reaper_Stack',
      afterActiveKill: 'Magictaker_Stack',
      afterCombat: 'Charged',
      afterAttack: 'Mov_Lock_Tri',
      afterCrit: 'Perfect_Flow_Max',
      afterTakeHit: 'Empowered',
      areaCombat: {
        skill: 'Prism_Buff',
        range: 3,
        affect_self: true,
        target: 'ally',
      },
      areaKill: {
        skill: 'Dazzled_Short',
        range: 2,
        affect_self: false,
        target: 'enemy',
      },
    });
  });

  test('records immediate miss and damage gains in the combat snapshot', async ({ page }) => {
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
        nid: '_EotfImmediateGainWeapon',
        name: 'EotF Immediate Gain Weapon',
        desc: '',
        components: [
          ['weapon', null],
          ['damage', 100],
          ['hit', 100],
          ['uses', 20],
        ],
      });
      attacker.items = [item];
      attacker.skills = [];
      defender.currentHp = Math.max(20, defender.maxHp);
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
      const makeHook = (component: string, child: string) => {
        const skill = new SkillObject({
          nid: `_Eotf_${component}`,
          name: component,
          desc: '',
          components: [
            [component, child],
            ['drain_charge', 2],
          ],
        });
        skill.data.set('charge', 2);
        skill.data.set('total_charge', 2);
        return skill;
      };

      const missHook = makeHook('gain_skill_after_take_miss', 'Toxin');
      defender.skills = [missHook];
      const missBefore = game.actionLog.actionIndex;
      const missCombat = new MapCombat(
        attacker,
        item,
        defender,
        null,
        game.db,
        'classic',
        game.board,
        ['miss1', 'end'],
        undefined,
        game,
      );
      missCombat.applyResults(game.actionLog);
      const missAfter = game.actionLog.actionIndex;
      const missState = {
        granted: defender.skills.some((skill: any) => skill.nid === 'Toxin'),
        initiator: defender.skills.find(
          (skill: any) => skill.nid === 'Toxin',
        )?.initiatorNid ?? null,
        charge: missHook.data.get('charge'),
      };
      rewind(missBefore);
      const missRewound = {
        granted: defender.skills.some((skill: any) => skill.nid === 'Toxin'),
        charge: missHook.data.get('charge'),
      };
      redo(missAfter);
      const missRedone = defender.skills.some(
        (skill: any) => skill.nid === 'Toxin',
      );

      const damageHook = makeHook('gain_skill_after_take_damage', 'Chiseled');
      defender.skills = [damageHook];
      defender.currentHp = Math.max(20, defender.maxHp);
      const damageBefore = game.actionLog.actionIndex;
      const damageCombat = new MapCombat(
        attacker,
        item,
        defender,
        null,
        game.db,
        'classic',
        game.board,
        ['hit1', 'end'],
        undefined,
        game,
      );
      damageCombat.applyResults(game.actionLog);
      const damageAfter = game.actionLog.actionIndex;
      const damageState = {
        granted: defender.skills.some((skill: any) => skill.nid === 'Chiseled'),
        initiator: defender.skills.find(
          (skill: any) => skill.nid === 'Chiseled',
        )?.initiatorNid ?? null,
        charge: damageHook.data.get('charge'),
      };
      rewind(damageBefore);
      const damageRewound = {
        granted: defender.skills.some((skill: any) => skill.nid === 'Chiseled'),
        charge: damageHook.data.get('charge'),
      };
      redo(damageAfter);
      const damageRedone = defender.skills.some(
        (skill: any) => skill.nid === 'Chiseled',
      );

      const componentValue = (skillNid: string, componentNid: string) =>
        game.db.skills.get(skillNid)?.components.find(
          ([nid]: [string, any]) => nid === componentNid,
        )?.[1];
      const values = {
        afterMiss: componentValue(
          'Dancing_Plague',
          'gain_skill_after_take_miss',
        ),
        afterDamage: componentValue(
          'Chisel',
          'gain_skill_after_take_damage',
        ),
      };
      attacker.skills = oldAttackerSkills;
      defender.skills = oldDefenderSkills;
      attacker.items = oldAttackerItems;
      defender.currentHp = oldDefenderHp;
      return {
        miss: {
          strikes: missCombat.strikes.map((strike: any) => ({
            hit: strike.hit,
            damage: strike.damage,
          })),
          state: missState,
          rewound: missRewound,
          redone: missRedone,
        },
        damage: {
          strikes: damageCombat.strikes.map((strike: any) => ({
            hit: strike.hit,
            damage: strike.damage,
          })),
          state: damageState,
          rewound: damageRewound,
          redone: damageRedone,
        },
        values,
      };
    });

    expect(result.miss).toEqual({
      strikes: [{ hit: false, damage: 0 }],
      state: { granted: true, initiator: 'Keeper', charge: 1 },
      rewound: { granted: false, charge: 2 },
      redone: true,
    });
    expect(result.damage.strikes).toHaveLength(1);
    expect(result.damage.strikes[0]).toMatchObject({ hit: true });
    expect(result.damage.strikes[0].damage).toBeGreaterThan(0);
    expect(result.damage.state).toEqual({
      granted: true,
      initiator: 'Keeper',
      charge: 1,
    });
    expect(result.damage.rewound).toEqual({ granted: false, charge: 2 });
    expect(result.damage.redone).toBe(true);
    expect(result.values).toEqual({
      afterMiss: 'Toxin',
      afterDamage: 'Chiseled',
    });
  });
});
