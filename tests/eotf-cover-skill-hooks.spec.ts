import { expect, test, type Page } from '@playwright/test';

async function bootEotf(page: Page): Promise<void> {
  await page.goto('/?harness=true&project=eotf.ltproj&level=X&clean=true&bundle=false');
  await page.waitForFunction(() => (window as any).__harness?.ready === true, undefined, {
    timeout: 60_000,
  });
}

test.describe('Embrace of the Fog cover skill hooks', () => {
  test('count-locks all 13 cover and application-time stat uses', async ({ page }) => {
    await bootEotf(page);
    const uses = await page.evaluate(() => {
      const game = (window as any).__gameRef;
      const componentNids = [
        'redirect_damage',
        'redirect_partial_damage',
        'stat_change_at_apply_expression',
      ];
      return Object.fromEntries(componentNids.map((componentNid) => [
        componentNid,
        [...game.db.skills.values()].flatMap((skill: any) => skill.components
          .filter(([nid]: [string, unknown]) => nid === componentNid)
          .map(([, value]: [string, unknown]) => [skill.nid, value])),
      ]));
    });

    expect(uses).toEqual({
      redirect_damage: [
        ['Cover', null],
        ['Block', null],
        ['For_Her_Sake_Helper', null],
      ],
      redirect_partial_damage: [
        ['Partial_Block', 0.5],
        ['Defense_Zone_Aura_Child', 0.5],
      ],
      stat_change_at_apply_expression: [
        ['Cover', [
          ['DEF', "game.get_unit(skill.initiator_nid).get_stat('DEF') // 2"],
          ['RES', "game.get_unit(skill.initiator_nid).get_stat('RES') // 2"],
        ]],
        ['Formshifter_Buff', [
          ['MAG', "game.get_unit(skill.initiator_nid).get_stat('MAG') // 6"],
          ['STR', "game.get_unit(skill.initiator_nid).get_stat('MAG') // 6"],
          ['SKL', "game.get_unit(skill.initiator_nid).get_stat('MAG') // 6"],
          ['SPD', "game.get_unit(skill.initiator_nid).get_stat('MAG') // 6"],
          ['LCK', "game.get_unit(skill.initiator_nid).get_stat('MAG') // 6"],
          ['DEF', "game.get_unit(skill.initiator_nid).get_stat('MAG') // 6"],
          ['RES', "game.get_unit(skill.initiator_nid).get_stat('MAG') // 6"],
        ]],
        ['Magic_Overflow_Buff', [
          ['MAG', "game.get_unit(skill.initiator_nid).stats['MAG'] // 2"],
        ]],
        ['Starstruck_Stride', [
          ['STR', "min(game.get_unit(skill.initiator_nid).get_stat('MAG') // 2, 20)"],
          ['MAG', "min(game.get_unit(skill.initiator_nid).get_stat('MAG') // 2, 20)"],
        ]],
        ['Bubble_Shield_Status', [
          ['DEF', 'game.get_unit(skill.initiator_nid).get_max_hp() // 10'],
          ['RES', 'game.get_unit(skill.initiator_nid).get_max_hp() // 10'],
        ]],
        ['Zephyr_Flight_Status', [
          ['SPD', "game.get_unit(skill.initiator_nid).get_stat('SPD') // 3"],
        ]],
        ['Break_Out_Status', [
          ['STR', "game.get_unit(skill.owner_nid).stats['DEF']"],
        ]],
        ['Break_Out_Status_E', [
          ['STR', "game.get_unit(skill.owner_nid).stats['DEF']"],
        ]],
      ],
    });
  });

  test('freezes every real stat expression and round-trips owner/data exactly', async ({ page }) => {
    await bootEotf(page);
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { SkillObject } = await import('/src/objects/skill.ts');
      const { AddSkillAction, RemoveSkillAction } = await import('/src/engine/action.ts');
      const { buildSaveDict, restoreGameState } = await import('/src/engine/save.ts');
      const source = game.units.get('Player');
      const target = game.units.get('Keeper');
      source.skills = [];
      target.skills = [];
      source.stats.HP = 50;
      source.stats.DEF = 12;
      source.stats.RES = 8;
      source.stats.MAG = 60;
      source.stats.SPD = 15;
      target.stats.DEF = 7;
      target.stats.RES = 0;

      const nids = [
        'Cover',
        'Formshifter_Buff',
        'Magic_Overflow_Buff',
        'Starstruck_Stride',
        'Bubble_Shield_Status',
        'Zephyr_Flight_Status',
        'Break_Out_Status',
        'Break_Out_Status_E',
      ];
      const initialized: Record<string, unknown> = {};
      for (const nid of nids) {
        const skill = new SkillObject(game.db.skills.get(nid));
        skill.initiatorNid = source.nid;
        const add = new AddSkillAction(target, skill);
        add.execute();
        initialized[nid] = skill.data.get('stat_changes');
        new RemoveSkillAction(target, skill).execute();
      }

      const broken = new SkillObject({
        nid: '_BrokenFrozenStats',
        name: '',
        desc: '',
        components: [['stat_change_at_apply_expression', [
          ['DEF', 'missing_name + 1'],
        ]]],
      });
      broken.initiatorNid = source.nid;
      new AddSkillAction(target, broken).execute();
      const brokenChanges = broken.data.get('stat_changes');
      new RemoveSkillAction(target, broken).execute();

      const cover = new SkillObject(game.db.skills.get('Cover'));
      cover.initiatorNid = source.nid;
      new AddSkillAction(target, cover).execute();
      const beforeMutation = {
        owner: cover.ownerNid,
        cover: cover.data.get('cover'),
        stats: cover.data.get('stat_changes'),
        targetDef: target.getStatValue('DEF'),
        targetRes: target.getStatValue('RES'),
      };
      source.stats.DEF = 30;
      source.stats.RES = 30;
      const afterMutation = {
        stats: cover.data.get('stat_changes'),
        targetDef: target.getStatValue('DEF'),
        targetRes: target.getStatValue('RES'),
      };

      const save = buildSaveDict(game);
      await restoreGameState(game, save);
      const restoredTarget = game.units.get('Keeper');
      const restored = restoredTarget.skills.find((skill: any) => skill.nid === 'Cover');
      return {
        initialized,
        brokenChanges,
        beforeMutation,
        afterMutation,
        restored: {
          owner: restored?.ownerNid,
          initiator: restored?.initiatorNid,
          cover: restored?.data.get('cover'),
          stats: restored?.data.get('stat_changes'),
          targetDef: restoredTarget.getStatValue('DEF'),
          targetRes: restoredTarget.getStatValue('RES'),
        },
      };
    });

    expect(result.initialized).toEqual({
      Cover: { DEF: 6, RES: 4 },
      Formshifter_Buff: {
        MAG: 10, STR: 10, SKL: 10, SPD: 10, LCK: 10, DEF: 10, RES: 10,
      },
      Magic_Overflow_Buff: { MAG: 30 },
      Starstruck_Stride: { STR: 20, MAG: 20 },
      Bubble_Shield_Status: { DEF: 5, RES: 5 },
      Zephyr_Flight_Status: { SPD: 5 },
      Break_Out_Status: { STR: 7 },
      Break_Out_Status_E: { STR: 7 },
    });
    expect(result.brokenChanges).toEqual({ DEF: 0 });
    expect(result.beforeMutation).toEqual({
      owner: 'Keeper',
      cover: 'Player',
      stats: { DEF: 6, RES: 4 },
      targetDef: 13,
      targetRes: 4,
    });
    expect(result.afterMutation).toEqual({
      stats: { DEF: 6, RES: 4 },
      targetDef: 13,
      targetRes: 4,
    });
    expect(result.restored).toEqual({
      owner: 'Keeper',
      initiator: 'Player',
      cover: 'Player',
      stats: { DEF: 6, RES: 4 },
      targetDef: 13,
      targetRes: 4,
    });
  });

  test('redirects full damage per strike with charge and exact turnwheel replay', async ({ page }) => {
    await bootEotf(page);
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { SkillObject } = await import('/src/objects/skill.ts');
      const { ItemObject } = await import('/src/objects/item.ts');
      const { AddSkillAction } = await import('/src/engine/action.ts');
      const { MapCombat } = await import('/src/combat/map-combat.ts');
      const attacker = game.units.get('Player');
      const defender = game.units.get('Keeper');
      const coverUnit = game.units.get('Lib');
      attacker.skills = [];
      defender.skills = [];
      coverUnit.skills = [];
      attacker.team = 'player';
      defender.team = 'enemy';
      coverUnit.team = 'enemy';
      attacker.stats.STR = 0;
      attacker.stats.SKL = 0;
      attacker.stats.SPD = 5;
      defender.stats.DEF = 0;
      defender.stats.RES = 0;
      defender.stats.LCK = 0;
      defender.stats.SPD = 5;
      defender.stats.HP = 50;
      coverUnit.stats.HP = 50;
      attacker.currentHp = attacker.maxHp;
      defender.currentHp = 50;
      coverUnit.currentHp = 30;
      attacker.dead = false;
      defender.dead = false;
      coverUnit.dead = false;
      const weapon = new ItemObject({
        nid: '_CoverWeapon',
        name: '',
        desc: '',
        components: [
          ['weapon', null],
          ['damage', 12],
          ['hit', 100],
          ['uses', 99],
          ['eval_extra_damage', '7'],
        ],
      });
      attacker.items = [weapon];
      attacker.equippedWeapon = weapon;
      defender.items = [];
      defender.equippedWeapon = null;

      const coverSkill = new SkillObject({
        nid: '_ChargedCover',
        name: '',
        desc: '',
        components: [
          ['redirect_damage', null],
          ['drain_charge', 2],
        ],
      });
      coverSkill.initiatorNid = coverUnit.nid;
      new AddSkillAction(defender, coverSkill).execute();
      const beforeIndex = game.actionLog.actionIndex;
      const before = {
        defenderHp: defender.currentHp,
        coverHp: coverUnit.currentHp,
        charge: coverSkill.data.get('charge'),
      };
      const combat = new MapCombat(
        attacker,
        weapon,
        defender,
        null,
        game.db,
        'classic',
        game.board,
        ['hit1', 'hit1', 'end'],
        undefined,
        game,
      );
      const solved = {
        damages: combat.strikes.map((strike: any) => strike.damage),
        extras: combat.strikes.map((strike: any) => strike.extraDamage),
        redirects: combat.strikes.map((strike: any) =>
          (strike.redirectedDamage ?? []).map((effect: any) => [
            effect.unit.nid,
            effect.amount,
          ])),
        charge: coverSkill.data.get('charge'),
        participant: combat.participants.includes(coverUnit),
      };
      combat.applyResults(game.actionLog);
      const afterIndex = game.actionLog.actionIndex;
      const applied = {
        defenderHp: defender.currentHp,
        coverHp: coverUnit.currentHp,
        charge: coverSkill.data.get('charge'),
      };
      while (game.actionLog.actionIndex > beforeIndex) {
        game.actionLog.runActionBackward();
      }
      const rewound = {
        defenderHp: defender.currentHp,
        coverHp: coverUnit.currentHp,
        charge: coverSkill.data.get('charge'),
        sameSkill: defender.skills.includes(coverSkill),
      };
      while (game.actionLog.actionIndex < afterIndex) {
        game.actionLog.runActionForward();
      }
      const redone = {
        defenderHp: defender.currentHp,
        coverHp: coverUnit.currentHp,
        charge: coverSkill.data.get('charge'),
        sameSkill: defender.skills.includes(coverSkill),
      };
      return { before, solved, applied, rewound, redone };
    });

    expect(result.solved.damages).toEqual([0, 0]);
    expect(result.solved.extras).toEqual([0, 0]);
    expect(result.solved.redirects).toEqual([
      [['Lib', 12]],
      [['Lib', 12]],
    ]);
    expect(result.solved.charge).toBe(0);
    expect(result.solved.participant).toBe(true);
    expect(result.applied).toEqual({
      defenderHp: result.before.defenderHp,
      coverHp: result.before.coverHp - 24,
      charge: 0,
    });
    expect(result.rewound).toEqual({ ...result.before, sameSkill: true });
    expect(result.redone).toEqual({ ...result.applied, sameSkill: true });
  });

  test('preserves strict HP, partial truncation, conditions, and aura-owner cover', async ({ page }) => {
    await bootEotf(page);
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { SkillObject } = await import('/src/objects/skill.ts');
      const { ItemObject } = await import('/src/objects/item.ts');
      const { AddSkillAction } = await import('/src/engine/action.ts');
      const { CombatPhaseSolver } = await import('/src/combat/combat-solver.ts');
      const attacker = game.units.get('Player');
      const defender = game.units.get('Keeper');
      const coverUnit = game.units.get('Lib');
      attacker.team = 'player';
      defender.team = 'enemy';
      coverUnit.team = 'enemy';
      attacker.skills = [];
      defender.skills = [];
      attacker.stats.STR = 0;
      attacker.stats.SKL = 0;
      attacker.stats.SPD = 5;
      defender.stats.DEF = 0;
      defender.stats.RES = 0;
      defender.stats.LCK = 0;
      defender.stats.SPD = 5;
      defender.stats.HP = 50;
      coverUnit.stats.HP = 50;
      attacker.currentHp = attacker.maxHp;
      defender.currentHp = 50;
      coverUnit.currentHp = 50;
      defender.dead = false;
      coverUnit.dead = false;
      const weapon = new ItemObject({
        nid: '_PartialCoverWeapon',
        name: '',
        desc: '',
        components: [
          ['weapon', null],
          ['damage', 13],
          ['hit', 100],
          ['uses', 99],
          ['eval_extra_damage', '5'],
        ],
      });
      attacker.items = [weapon];
      attacker.equippedWeapon = weapon;
      defender.items = [];
      defender.equippedWeapon = null;

      const solve = (skill: any, coverHp: number) => {
        defender.skills = [];
        defender.currentHp = 50;
        coverUnit.currentHp = coverHp;
        coverUnit.dead = false;
        if (skill) {
          new AddSkillAction(defender, skill).execute();
        }
        return new CombatPhaseSolver(() => 0, game).resolve(
          attacker,
          weapon,
          defender,
          null,
          game.db,
          'classic',
          game.board,
          ['hit1', 'end'],
        )[0];
      };

      const baseline = solve(null, 50);
      const strictSkill = new SkillObject({
        nid: '_StrictCover',
        name: '',
        desc: '',
        components: [['redirect_damage', null]],
      });
      strictSkill.initiatorNid = coverUnit.nid;
      const strict = solve(strictSkill, baseline.damage);

      const partialSkill = new SkillObject({
        nid: '_PartialCover',
        name: '',
        desc: '',
        components: [['redirect_partial_damage', 0.5]],
      });
      partialSkill.initiatorNid = coverUnit.nid;
      const partial = solve(partialSkill, 50);

      const inactiveSkill = new SkillObject({
        nid: '_InactiveCover',
        name: '',
        desc: '',
        components: [
          ['condition', 'False'],
          ['redirect_damage', null],
        ],
      });
      inactiveSkill.initiatorNid = coverUnit.nid;
      const inactive = solve(inactiveSkill, 50);

      const aura = new SkillObject(game.db.skills.get('Defense_Zone_Aura_Child'));
      aura.data.set('auraOwnerNid', coverUnit.nid);
      const auraStrike = solve(aura, 50);
      return {
        baseline: {
          damage: baseline.damage,
          extra: baseline.extraDamage,
        },
        strict: {
          damage: strict.damage,
          redirects: strict.redirectedDamage?.length ?? 0,
        },
        partial: {
          damage: partial.damage,
          extra: partial.extraDamage,
          redirects: partial.redirectedDamage?.map((effect: any) => effect.amount),
        },
        inactive: {
          damage: inactive.damage,
          extra: inactive.extraDamage,
          redirects: inactive.redirectedDamage?.length ?? 0,
        },
        aura: {
          cover: aura.data.get('cover'),
          damage: auraStrike.damage,
          extra: auraStrike.extraDamage,
          redirects: auraStrike.redirectedDamage?.map((effect: any) => effect.amount),
        },
      };
    });

    expect(result.baseline).toEqual({ damage: 13, extra: 5 });
    expect(result.strict).toEqual({ damage: 13, redirects: 0 });
    expect(result.partial).toEqual({
      damage: 6,
      extra: 2,
      redirects: [6, 2],
    });
    expect(result.inactive).toEqual({ damage: 13, extra: 5, redirects: 0 });
    expect(result.aura).toEqual({
      cover: 'Lib',
      damage: 6,
      extra: 2,
      redirects: [6, 2],
    });
  });
});
