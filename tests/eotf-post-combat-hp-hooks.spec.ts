import { expect, test, type Page } from '@playwright/test';

async function bootEotf(page: Page): Promise<void> {
  await page.goto('/?harness=true&project=eotf.ltproj&level=X&clean=true&bundle=false');
  await page.waitForFunction(() => (window as any).__harness?.ready === true, undefined, {
    timeout: 60_000,
  });
}

test.describe('Embrace of the Fog post-combat HP hooks', () => {
  test('applies self lifelink variants in strike order with overkill clamping', async ({ page }) => {
    await bootEotf(page);
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { SkillObject } = await import('/src/objects/skill.ts');
      const { ItemObject } = await import('/src/objects/item.ts');
      const { MapCombat } = await import('/src/combat/map-combat.ts');
      const attacker = game.units.get('Player');
      const defender = game.units.get('Keeper');
      const old = {
        attackerSkills: attacker.skills,
        defenderSkills: defender.skills,
        attackerItems: attacker.items,
        attackerHp: attacker.currentHp,
        defenderHp: defender.currentHp,
      };
      const skill = new SkillObject({
        nid: '_EotfSelfLifelink',
        name: 'EotF Self Lifelink',
        desc: '',
        components: [
          ['lifelink', 0.5],
          ['shitty_lifelink', -0.1],
          ['eval_lifelink', "-5 if not any([s.ignore_damage for s in unit.skills]) else 0"],
          ['lifelink_on_crit', 0.2],
          ['drain_charge', 10],
        ],
      });
      skill.data.set('charge', 10);
      skill.data.set('total_charge', 10);
      const item = new ItemObject({
        nid: '_EotfLifelinkWeapon',
        name: 'EotF Lifelink Weapon',
        desc: '',
        components: [
          ['weapon', null],
          ['damage', 100],
          ['hit', 100],
          ['crit', 100],
          ['uses', 20],
        ],
      });
      attacker.skills = [skill];
      defender.skills = [];
      attacker.items = [item];
      attacker.currentHp = Math.max(1, attacker.maxHp - 12);
      defender.currentHp = Math.min(12, defender.maxHp);
      const beforeIndex = game.actionLog.actionIndex;
      const before = {
        attackerHp: attacker.currentHp,
        defenderHp: defender.currentHp,
        charge: skill.data.get('charge'),
      };
      const combat = new MapCombat(
        attacker,
        item,
        defender,
        null,
        game.db,
        'classic',
        game.board,
        ['crit1', 'end'],
        undefined,
        game,
      );
      combat.applyResults(game.actionLog);
      const afterIndex = game.actionLog.actionIndex;
      const strike = combat.strikes[0];
      const changed = {
        attackerHp: attacker.currentHp,
        defenderHp: defender.currentHp,
        charge: skill.data.get('charge'),
        damage: strike.damage,
        selfChange: strike.selfSkillHpChange,
      };
      while (game.actionLog.actionIndex > beforeIndex) {
        game.actionLog.runActionBackward();
      }
      const reversed = {
        attackerHp: attacker.currentHp,
        defenderHp: defender.currentHp,
        charge: skill.data.get('charge'),
      };
      while (game.actionLog.actionIndex < afterIndex) {
        game.actionLog.runActionForward();
      }
      const redone = {
        attackerHp: attacker.currentHp,
        defenderHp: defender.currentHp,
        charge: skill.data.get('charge'),
      };
      const componentValue = (skillNid: string, componentNid: string) =>
        game.db.skills.get(skillNid)?.components.find(
          ([nid]: [string, any]) => nid === componentNid,
        )?.[1];
      const values = {
        standard: componentValue('Laceration', 'lifelink'),
        unbounded: componentValue('Paper_Charm_R', 'shitty_lifelink'),
        evaluated: componentValue('Deflect_Child', 'eval_lifelink'),
        onCrit: componentValue('Optimized_Output_Helper', 'lifelink_on_crit'),
      };
      attacker.skills = old.attackerSkills;
      defender.skills = old.defenderSkills;
      attacker.items = old.attackerItems;
      attacker.currentHp = old.attackerHp;
      defender.currentHp = old.defenderHp;
      return {
        before,
        changed,
        reversed,
        redone,
        values,
        attackerMaxHp: attacker.maxHp,
      };
    });

    const trueDamage = Math.min(result.before.defenderHp, result.changed.damage);
    const expectedSelfChange =
      Math.trunc(trueDamage * 0.5) +
      Math.trunc(result.changed.damage * -0.1) +
      -5 +
      Math.trunc(trueDamage * 0.2);
    const expectedHp = Math.max(
      0,
      Math.min(result.attackerMaxHp, result.before.attackerHp + expectedSelfChange),
    );
    expect(result.changed).toEqual({
      attackerHp: expectedHp,
      defenderHp: 0,
      charge: 6,
      damage: result.changed.damage,
      selfChange: expectedSelfChange,
    });
    expect(result.reversed).toEqual(result.before);
    expect(result.redone).toEqual({
      attackerHp: expectedHp,
      defenderHp: 0,
      charge: 6,
    });
    expect(result.values).toEqual({
      standard: -0.5,
      unbounded: -1,
      evaluated: "-5 if not any([s.ignore_damage for s in unit.skills]) else 0",
      onCrit: 0.2,
    });
  });

  test('heals exact ally lifelink and ranged post-combat recipients reversibly', async ({ page }) => {
    await bootEotf(page);
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { SkillObject } = await import('/src/objects/skill.ts');
      const { ItemObject } = await import('/src/objects/item.ts');
      const { MapCombat } = await import('/src/combat/map-combat.ts');
      const { applyCombatSkillEndHooks } =
        await import('/src/combat/combat-lifecycle.ts');
      const attacker = game.units.get('Player');
      const defender = game.units.get('Keeper');
      const ally = game.units.get('Lib');
      const old = {
        attackerSkills: attacker.skills,
        defenderSkills: defender.skills,
        allySkills: ally.skills,
        attackerItems: attacker.items,
        attackerHp: attacker.currentHp,
        defenderHp: defender.currentHp,
        allyHp: ally.currentHp,
        attackerTeam: attacker.team,
        defenderTeam: defender.team,
        allyTeam: ally.team,
        attackerPosition: attacker.position,
        defenderPosition: defender.position,
        allyPosition: ally.position,
      };
      for (const unit of [attacker, defender, ally]) {
        if (unit.position) game.board.removeUnit(unit);
      }
      let origin: [number, number] | null = null;
      for (let y = 0; y < game.board.height - 1 && !origin; y++) {
        for (let x = 0; x < game.board.width - 1; x++) {
          if (!game.board.getUnit(x, y) &&
              !game.board.getUnit(x + 1, y) &&
              !game.board.getUnit(x + 1, y + 1)) {
            origin = [x, y];
            break;
          }
        }
      }
      if (!origin) throw new Error('No open EotF test cluster');
      attacker.team = 'player';
      ally.team = 'player';
      defender.team = 'enemy';
      game.board.setUnit(origin[0], origin[1], attacker);
      game.board.setUnit(origin[0] + 1, origin[1], defender);
      game.board.setUnit(origin[0] + 1, origin[1] + 1, ally);
      const lifelink = new SkillObject({
        nid: '_EotfAllyLifelink',
        name: 'EotF Ally Lifelink',
        desc: '',
        components: [
          ['ally_lifelink_target', 0.5],
          ['ally_lifelink_ranged', {
            percentage: 0.25,
            range: 2,
            'include self?': true,
          }],
          ['drain_charge', 10],
        ],
      });
      lifelink.data.set('charge', 10);
      lifelink.data.set('total_charge', 10);
      const item = new ItemObject({
        nid: '_EotfAllyLifelinkWeapon',
        name: 'EotF Ally Lifelink Weapon',
        desc: '',
        components: [
          ['weapon', null],
          ['damage', 100],
          ['hit', 100],
          ['uses', 20],
        ],
      });
      attacker.skills = [lifelink];
      defender.skills = [];
      ally.skills = [new SkillObject({
        nid: '_EotfDeepWounds',
        name: 'EotF Deep Wounds',
        desc: '',
        components: [[
          'empower_heal_received_multiplier',
          0.5000000000000001,
        ]],
      })];
      attacker.items = [item];
      attacker.currentHp = Math.max(1, attacker.maxHp - 20);
      ally.currentHp = Math.max(1, ally.maxHp - 20);
      defender.currentHp = Math.min(20, defender.maxHp);
      const lifelinkBeforeIndex = game.actionLog.actionIndex;
      const lifelinkBefore = {
        attackerHp: attacker.currentHp,
        defenderHp: defender.currentHp,
        allyHp: ally.currentHp,
        charge: lifelink.data.get('charge'),
      };
      const combat = new MapCombat(
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
      combat.applyResults(game.actionLog);
      const trueDamage = Math.min(
        lifelinkBefore.defenderHp,
        combat.strikes[0].damage,
      );
      const lifelinkChanged = {
        attackerHp: attacker.currentHp,
        defenderHp: defender.currentHp,
        allyHp: ally.currentHp,
        charge: lifelink.data.get('charge'),
        effects: combat.strikes[0].allySkillHpChanges?.map(
          (effect: any) => [effect.unit.nid, effect.amount],
        ),
        trueDamage,
      };
      while (game.actionLog.actionIndex > lifelinkBeforeIndex) {
        game.actionLog.runActionBackward();
      }
      const lifelinkReversed = {
        attackerHp: attacker.currentHp,
        defenderHp: defender.currentHp,
        allyHp: ally.currentHp,
        charge: lifelink.data.get('charge'),
      };
      game.actionLog.finalize();

      const strikeheal = new SkillObject({
        nid: '_EotfAllyStrikeheal',
        name: 'EotF Ally Strikeheal',
        desc: '',
        components: [
          ['ally_strikeheal_ranged', {
            'Amount/Percentage': 25,
            range: 2,
            'is percent?': true,
          }],
          ['drain_charge', 2],
        ],
      });
      strikeheal.data.set('charge', 2);
      strikeheal.data.set('total_charge', 2);
      attacker.skills = [strikeheal];
      attacker.currentHp = Math.max(1, attacker.maxHp - 20);
      ally.currentHp = Math.max(1, ally.maxHp - 20);
      const strikehealBeforeIndex = game.actionLog.actionIndex;
      const strikehealBefore = {
        attackerHp: attacker.currentHp,
        allyHp: ally.currentHp,
        charge: strikeheal.data.get('charge'),
      };
      applyCombatSkillEndHooks(
        game,
        combat.strikes,
        attacker,
        defender,
      );
      const strikehealAfterIndex = game.actionLog.actionIndex;
      const strikehealChanged = {
        attackerHp: attacker.currentHp,
        allyHp: ally.currentHp,
        charge: strikeheal.data.get('charge'),
      };
      while (game.actionLog.actionIndex > strikehealBeforeIndex) {
        game.actionLog.runActionBackward();
      }
      const strikehealReversed = {
        attackerHp: attacker.currentHp,
        allyHp: ally.currentHp,
        charge: strikeheal.data.get('charge'),
      };
      while (game.actionLog.actionIndex < strikehealAfterIndex) {
        game.actionLog.runActionForward();
      }
      const strikehealRedone = {
        attackerHp: attacker.currentHp,
        allyHp: ally.currentHp,
        charge: strikeheal.data.get('charge'),
      };
      const componentValue = (skillNid: string, componentNid: string) =>
        game.db.skills.get(skillNid)?.components.find(
          ([nid]: [string, any]) => nid === componentNid,
        )?.[1];
      const values = {
        target: componentValue('Vitalizing_Smite_Proc', 'ally_lifelink_target'),
        ranged: componentValue('Oculi_Ring_Effect', 'ally_lifelink_ranged'),
        strikeheal: componentValue('Chuang_Effect', 'ally_strikeheal_ranged'),
        receivedMultiplier: componentValue(
          'Deep_Wounds',
          'empower_heal_received_multiplier',
        ),
      };
      for (const unit of [attacker, defender, ally]) {
        if (unit.position) game.board.removeUnit(unit);
      }
      attacker.skills = old.attackerSkills;
      defender.skills = old.defenderSkills;
      ally.skills = old.allySkills;
      attacker.items = old.attackerItems;
      attacker.currentHp = old.attackerHp;
      defender.currentHp = old.defenderHp;
      ally.currentHp = old.allyHp;
      attacker.team = old.attackerTeam;
      defender.team = old.defenderTeam;
      ally.team = old.allyTeam;
      if (old.attackerPosition) game.board.setUnit(...old.attackerPosition, attacker);
      if (old.defenderPosition) game.board.setUnit(...old.defenderPosition, defender);
      if (old.allyPosition) game.board.setUnit(...old.allyPosition, ally);
      return {
        lifelink: {
          before: lifelinkBefore,
          changed: lifelinkChanged,
          reversed: lifelinkReversed,
        },
        strikeheal: {
          before: strikehealBefore,
          changed: strikehealChanged,
          reversed: strikehealReversed,
          redone: strikehealRedone,
        },
        maxHp: { attacker: attacker.maxHp, ally: ally.maxHp },
        values,
      };
    });

    const targetHeal = Math.trunc(result.lifelink.changed.trueDamage * 0.5);
    const rangedHeal = Math.trunc(result.lifelink.changed.trueDamage * 0.25);
    const modifiedTargetHeal = Math.trunc(targetHeal * 0.5000000000000001);
    const modifiedRangedHeal = Math.trunc(rangedHeal * 0.5000000000000001);
    expect(result.lifelink.changed).toEqual({
      attackerHp: Math.min(
        result.maxHp.attacker,
        result.lifelink.before.attackerHp + rangedHeal,
      ),
      defenderHp: 0,
      allyHp: Math.min(
        result.maxHp.ally,
        result.lifelink.before.allyHp + modifiedTargetHeal + modifiedRangedHeal,
      ),
      charge: 8,
      effects: [
        ['Lib', modifiedTargetHeal],
        ['Player', rangedHeal],
        ['Lib', modifiedRangedHeal],
      ],
      trueDamage: result.lifelink.changed.trueDamage,
    });
    expect(result.lifelink.reversed).toEqual(result.lifelink.before);
    const strikehealExpected = {
      attackerHp: Math.min(
        result.maxHp.attacker,
        result.strikeheal.before.attackerHp +
          Math.trunc(result.maxHp.attacker * 0.25),
      ),
      allyHp: Math.min(
        result.maxHp.ally,
        result.strikeheal.before.allyHp +
          Math.trunc(
            Math.trunc(result.maxHp.ally * 0.25) * 0.5000000000000001,
          ),
      ),
      charge: 1,
    };
    expect(result.strikeheal.changed).toEqual(strikehealExpected);
    expect(result.strikeheal.reversed).toEqual(result.strikeheal.before);
    expect(result.strikeheal.redone).toEqual(strikehealExpected);
    expect(result.values).toEqual({
      target: 0.5,
      ranged: {
        percentage: 0.5,
        range: 3,
        'include self?': true,
      },
      strikeheal: {
        'Amount/Percentage': 7,
        range: 2,
        'is percent?': true,
      },
      receivedMultiplier: 0.5000000000000001,
    });
  });

  test('applies damage, healing, recoil, and splash once with exact reversal', async ({ page }) => {
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
      const old = {
        attackerSkills: attacker.skills,
        defenderSkills: defender.skills,
        splashSkills: splash.skills,
        attackerHp: attacker.currentHp,
        defenderHp: defender.currentHp,
        splashHp: splash.currentHp,
        defenderTeam: defender.team,
        splashTeam: splash.team,
        attackerPosition: attacker.position,
        defenderPosition: defender.position,
        splashPosition: splash.position,
      };
      defender.team = 'enemy';
      splash.team = 'enemy';
      attacker.position = [1, 1];
      defender.position = [4, 4];
      splash.position = [5, 4];
      attacker.currentHp = Math.max(1, Math.min(5, attacker.maxHp));
      defender.currentHp = defender.maxHp;
      splash.currentHp = splash.maxHp;
      defender.skills = [];
      splash.skills = [];
      const make = (nid: string, component: [string, any]) => {
        const skill = new SkillObject({
          nid,
          name: nid,
          desc: '',
          components: [component, ['drain_charge', 2]],
        });
        skill.data.set('charge', 2);
        skill.data.set('total_charge', 2);
        return skill;
      };
      const skills = [
        make('_EotfBetterDamage', ['better_post_combat_damage', 4]),
        make('_EotfEvalDamage', [
          'eval_post_combat_damage',
          'target.get_max_hp() // 5',
        ]),
        make('_EotfHealing', ['post_combat_healing', 8]),
        make('_EotfEvalHealing', [
          'eval_post_combat_healing',
          'unit.get_max_hp() // 10',
        ]),
        make('_EotfRecoil', ['better_recoil', 4]),
        make('_EotfDamageAll', [
          'eval_post_combat_damage_all',
          "unit.get_stat('RES') // 3",
        ]),
        make('_EotfBetterSplash', ['better_post_combat_splash', {
          'Amount/Percentage': 20,
          range: 2,
          'is percent?': true,
        }]),
      ];
      attacker.skills = skills;
      const item = new ItemObject({
        nid: '_EotfPostCombatWeapon',
        name: 'EotF Post Combat Weapon',
        desc: '',
        components: [['weapon', null]],
      });
      const strike = (target: any) => ({
        attacker,
        defender: target,
        item,
        hit: true,
        crit: false,
        damage: 3,
        isCounter: false,
        mode: 'attack',
        attackInfo: [0, 0] as [number, number],
      });
      const strikes = [strike(defender), strike(splash)];
      const beforeIndex = game.actionLog.actionIndex;
      const before = {
        attackerHp: attacker.currentHp,
        defenderHp: defender.currentHp,
        splashHp: splash.currentHp,
      };
      const applied = applyCombatSkillEndHooks(
        game,
        strikes,
        attacker,
        defender,
      );
      const afterIndex = game.actionLog.actionIndex;
      const changed = {
        applied,
        attackerHp: attacker.currentHp,
        defenderHp: defender.currentHp,
        splashHp: splash.currentHp,
        charges: skills.map((skill: any) => skill.data.get('charge')),
      };
      while (game.actionLog.actionIndex > beforeIndex) {
        game.actionLog.runActionBackward();
      }
      const reversed = {
        attackerHp: attacker.currentHp,
        defenderHp: defender.currentHp,
        splashHp: splash.currentHp,
        charges: skills.map((skill: any) => skill.data.get('charge')),
      };
      while (game.actionLog.actionIndex < afterIndex) {
        game.actionLog.runActionForward();
      }
      const redone = {
        attackerHp: attacker.currentHp,
        defenderHp: defender.currentHp,
        splashHp: splash.currentHp,
        charges: skills.map((skill: any) => skill.data.get('charge')),
      };
      const values = Object.fromEntries([
        ['betterDamage', ['Warabe_Asobi', 'better_post_combat_damage']],
        ['evalDamage', ['Treacherous_Savagery', 'eval_post_combat_damage']],
        ['healing', ['Invincible_Item_2', 'post_combat_healing']],
        ['evalHealing', ['Defender_Arts_H', 'eval_post_combat_healing']],
        ['damageAll', ['Blind_Prophet', 'eval_post_combat_damage_all']],
        ['recoil', ['Burning', 'better_recoil']],
        ['splash', ['Hwei_Effect', 'better_post_combat_splash']],
      ].map(([key, [skillNid, componentNid]]) => [
        key,
        game.db.skills.get(skillNid)?.components.find(
          ([nid]: [string, any]) => nid === componentNid,
        )?.[1],
      ]));
      attacker.skills = old.attackerSkills;
      defender.skills = old.defenderSkills;
      splash.skills = old.splashSkills;
      attacker.currentHp = old.attackerHp;
      defender.currentHp = old.defenderHp;
      splash.currentHp = old.splashHp;
      defender.team = old.defenderTeam;
      splash.team = old.splashTeam;
      attacker.position = old.attackerPosition;
      defender.position = old.defenderPosition;
      splash.position = old.splashPosition;
      return {
        before,
        changed,
        reversed,
        redone,
        values,
        maxHp: {
          attacker: attacker.maxHp,
          defender: defender.maxHp,
          splash: splash.maxHp,
        },
        res: attacker.stats.RES ?? 0,
      };
    });

    const selfAfterHealing = Math.min(
      result.maxHp.attacker,
      result.before.attackerHp + 8 + Math.trunc(result.maxHp.attacker / 10),
    );
    const expected = {
      attackerHp: Math.max(1, selfAfterHealing - 4),
      defenderHp: Math.max(
        1,
        result.before.defenderHp -
          4 -
          Math.trunc(result.maxHp.defender / 5) -
          Math.trunc(result.res / 3) -
          Math.trunc(result.maxHp.defender * 0.2),
      ),
      splashHp: Math.max(
        1,
        result.before.splashHp -
          Math.trunc(result.res / 3) -
          Math.trunc(result.maxHp.splash * 0.2),
      ),
      charges: [1, 1, 1, 1, 1, 1, 1],
    };
    expect(result.changed).toMatchObject(expected);
    expect(result.changed.applied).toBeGreaterThanOrEqual(9);
    expect(result.reversed).toEqual({
      ...result.before,
      charges: [2, 2, 2, 2, 2, 2, 2],
    });
    expect(result.redone).toEqual(expected);
    expect(result.values).toEqual({
      betterDamage: 4,
      evalDamage: 'target.get_max_hp() // 5',
      healing: 8,
      evalHealing:
        "unit.get_max_hp() // 10 if 'Armor' in unit.tags else unit.get_max_hp() // 20",
      damageAll: "unit.get_stat('RES') // 3",
      recoil: 4,
      splash: {
        'Amount/Percentage': 20,
        range: 2,
        'is percent?': true,
      },
    });
  });
});
