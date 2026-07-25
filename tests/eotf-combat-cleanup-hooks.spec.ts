import { expect, test, type Page } from '@playwright/test';

async function bootEotf(page: Page): Promise<void> {
  await page.goto('/?harness=true&project=eotf.ltproj&level=X&clean=true&bundle=false');
  await page.waitForFunction(() => (window as any).__harness?.ready === true, undefined, {
    timeout: 30_000,
  });
}

test.describe('Embrace of the Fog combat cleanup hooks', () => {
  test('turns strike damage into permanent max-HP loss and restores fields/stacks', async ({ page }) => {
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
        defenderHp: defender.currentHp,
        defenderStats: { ...defender.stats },
        defenderFields: new Map(defender.fields),
      };
      const undeath = new SkillObject(game.db.skills.get('Undeath'));
      defender.skills = [undeath];
      const tracked = Math.max(1, defender.maxHp - 2);
      defender.fields.set('Undeath_Current_HP', tracked);
      defender.currentHp = tracked;
      attacker.skills = [];
      const item = new ItemObject({
        nid: '_EotfPermanentDamageWeapon',
        name: 'EotF Permanent Damage Weapon',
        desc: '',
        components: [
          ['weapon', null],
          ['damage', 100],
          ['hit', 100],
          ['uses', 20],
        ],
      });
      attacker.items = [item];
      const beforeIndex = game.actionLog.actionIndex;
      const snapshot = () => ({
        hp: defender.currentHp,
        maxHp: defender.maxHp,
        baseHp: defender.stats.HP,
        field: defender.fields.get('Undeath_Current_HP'),
        skills: defender.skills.map((skill: any) => skill.nid),
      });
      const before = snapshot();
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
      const afterIndex = game.actionLog.actionIndex;
      const changed = snapshot();
      while (game.actionLog.actionIndex > beforeIndex) {
        game.actionLog.runActionBackward();
      }
      const reversed = snapshot();
      while (game.actionLog.actionIndex < afterIndex) {
        game.actionLog.runActionForward();
      }
      const redone = snapshot();
      const realValue = game.db.skills.get('Undeath')?.components.find(
        ([nid]: [string, any]) => nid === 'permanent_damage',
      )?.[1];
      attacker.skills = old.attackerSkills;
      defender.skills = old.defenderSkills;
      attacker.items = old.attackerItems;
      defender.currentHp = old.defenderHp;
      defender.stats = old.defenderStats;
      defender.fields = old.defenderFields;
      return { before, changed, reversed, redone, realValue };
    });

    expect(result.changed).toEqual({
      hp: 0,
      maxHp: 1,
      baseHp: 1,
      field: 1,
      skills: ['Undeath', 'Undying_Will', 'Undying_Will'],
    });
    expect(result.reversed).toEqual(result.before);
    expect(result.redone).toEqual(result.changed);
    expect(result.realValue).toBeNull();
  });

  test('heals on kill and removes an enemy status with exact reversal', async ({ page }) => {
    await bootEotf(page);
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { SkillObject } = await import('/src/objects/skill.ts');
      const { ItemObject } = await import('/src/objects/item.ts');
      const { applyCombatSkillEndHooks } =
        await import('/src/combat/combat-lifecycle.ts');
      const attacker = game.units.get('Player');
      const defender = game.units.get('Keeper');
      const old = {
        attackerSkills: attacker.skills,
        defenderSkills: defender.skills,
        attackerHp: attacker.currentHp,
        defenderHp: defender.currentHp,
        defenderTeam: defender.team,
      };
      const flat = new SkillObject({
        nid: '_EotfHealOnKill',
        name: 'EotF Heal On Kill',
        desc: '',
        components: [['heal_on_kill', 2]],
      });
      const evaluated = new SkillObject({
        nid: '_EotfEvalHealOnKill',
        name: 'EotF Eval Heal On Kill',
        desc: '',
        components: [[
          'eval_heal_on_kill',
          "8 if has_skill(unit, 'Aramitama') else 4",
        ]],
      });
      const shatter = new SkillObject({
        nid: '_EotfRemoveStatus',
        name: 'EotF Remove Status',
        desc: '',
        components: [
          ['remove_status_after_combat', 'Frozen'],
          ['drain_charge', 2],
        ],
      });
      const frozen = new SkillObject(game.db.skills.get('Frozen'));
      attacker.skills = [flat, evaluated, shatter];
      defender.skills = [frozen];
      defender.team = 'enemy';
      attacker.currentHp = Math.max(1, attacker.maxHp - 10);
      defender.currentHp = 0;
      const item = new ItemObject({
        nid: '_EotfCleanupWeapon',
        name: 'EotF Cleanup Weapon',
        desc: '',
        components: [['weapon', null]],
      });
      const strike = {
        attacker,
        defender,
        item,
        hit: true,
        crit: false,
        damage: 10,
        isCounter: false,
        mode: 'attack',
        attackInfo: [0, 0] as [number, number],
      };
      const beforeIndex = game.actionLog.actionIndex;
      const before = {
        hp: attacker.currentHp,
        defenderSkills: defender.skills.map((skill: any) => skill.nid),
        charge: shatter.data.get('charge'),
      };
      applyCombatSkillEndHooks(game, [strike], attacker, defender);
      const afterIndex = game.actionLog.actionIndex;
      const changed = {
        hp: attacker.currentHp,
        defenderSkills: defender.skills.map((skill: any) => skill.nid),
        charge: shatter.data.get('charge'),
      };
      while (game.actionLog.actionIndex > beforeIndex) {
        game.actionLog.runActionBackward();
      }
      const reversed = {
        hp: attacker.currentHp,
        defenderSkills: defender.skills.map((skill: any) => skill.nid),
        charge: shatter.data.get('charge'),
      };
      while (game.actionLog.actionIndex < afterIndex) {
        game.actionLog.runActionForward();
      }
      const redone = {
        hp: attacker.currentHp,
        defenderSkills: defender.skills.map((skill: any) => skill.nid),
        charge: shatter.data.get('charge'),
      };
      const componentValue = (skillNid: string, componentNid: string) =>
        game.db.skills.get(skillNid)?.components.find(
          ([nid]: [string, any]) => nid === componentNid,
        )?.[1];
      const values = {
        flat: componentValue('Rosethorn', 'heal_on_kill'),
        evaluated: componentValue('Warabe_Asobi', 'eval_heal_on_kill'),
        remove: componentValue('Shatter', 'remove_status_after_combat'),
      };
      attacker.skills = old.attackerSkills;
      defender.skills = old.defenderSkills;
      attacker.currentHp = old.attackerHp;
      defender.currentHp = old.defenderHp;
      defender.team = old.defenderTeam;
      return { before, changed, reversed, redone, values, maxHp: attacker.maxHp };
    });

    const expected = {
      hp: Math.min(result.maxHp, result.before.hp + 6),
      defenderSkills: [],
      charge: 1,
    };
    expect(result.changed).toEqual(expected);
    expect(result.reversed).toEqual(result.before);
    expect(result.redone).toEqual(expected);
    expect(result.values).toEqual({
      flat: 2,
      evaluated: "8 if has_skill(unit, 'Aramitama') else 4",
      remove: 'Frozen',
    });
  });

  test('counts enemy combats, honors splash flags, and preserves self-plus-ally decrements', async ({ page }) => {
    await bootEotf(page);
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { SkillObject } = await import('/src/objects/skill.ts');
      const { ItemObject } = await import('/src/objects/item.ts');
      const { applyCombatSkillEndHooks } =
        await import('/src/combat/combat-lifecycle.ts');
      const unit = game.units.get('Player');
      const enemy = game.units.get('Keeper');
      const oldSkills = unit.skills;
      const oldEnemyTeam = enemy.team;
      enemy.team = 'enemy';
      const item = new ItemObject({
        nid: '_EotfExpiryWeapon',
        name: 'EotF Expiry Weapon',
        desc: '',
        components: [['weapon', null]],
      });
      const strike = (defender: any, mode: string = 'attack') => ({
        attacker: unit,
        defender,
        item,
        hit: true,
        crit: false,
        damage: 1,
        isCounter: false,
        mode,
        attackInfo: [0, 0] as [number, number],
      });

      const blinded = new SkillObject(game.db.skills.get('Blinded'));
      unit.skills = [blinded];
      const beforeIndex = game.actionLog.actionIndex;
      const initial = {
        combats: blinded.data.get('combats'),
        present: unit.skills.includes(blinded),
      };
      applyCombatSkillEndHooks(game, [strike(enemy)], unit, enemy);
      const afterOne = {
        combats: blinded.data.get('combats'),
        present: unit.skills.includes(blinded),
      };
      applyCombatSkillEndHooks(game, [strike(enemy)], unit, enemy);
      const afterIndex = game.actionLog.actionIndex;
      const afterTwo = {
        combats: blinded.data.get('combats'),
        present: unit.skills.includes(blinded),
      };
      while (game.actionLog.actionIndex > beforeIndex) {
        game.actionLog.runActionBackward();
      }
      const reversed = {
        combats: blinded.data.get('combats'),
        present: unit.skills.includes(blinded),
      };
      while (game.actionLog.actionIndex < afterIndex) {
        game.actionLog.runActionForward();
      }
      const redone = {
        combats: blinded.data.get('combats'),
        present: unit.skills.includes(blinded),
      };
      while (game.actionLog.actionIndex > beforeIndex) {
        game.actionLog.runActionBackward();
      }
      game.actionLog.finalize();

      const flying = new SkillObject(game.db.skills.get('Temp_Flying'));
      unit.skills = [flying];
      applyCombatSkillEndHooks(game, [strike(enemy, 'splash')], unit, enemy);
      const splashFlag = {
        combats: flying.data.get('combats'),
        present: unit.skills.includes(flying),
      };

      const selfExpiry = new SkillObject({
        nid: '_EotfSelfExpiry',
        name: 'EotF Self Expiry',
        desc: '',
        components: [['lost_on_end_next_combat', [
          ['NumberOfCombats (X)', '2', ''],
          ['LostOnSelf (T/F)', 'T', ''],
          ['LostOnAlly (T/F)', 'T', ''],
          ['LostOnEnemy (T/F)', 'F', ''],
          ['LostOnSplash (T/F)', 'F', ''],
        ]]],
      });
      unit.skills = [selfExpiry];
      applyCombatSkillEndHooks(game, [strike(unit)], unit, unit);
      const self = {
        combats: selfExpiry.data.get('combats'),
        present: unit.skills.includes(selfExpiry),
      };
      const values = {
        blinded: game.db.skills.get('Blinded')?.getComponent?.(
          'lost_on_end_next_combat',
        ) ?? game.db.skills.get('Blinded')?.components.find(
          ([nid]: [string, any]) => nid === 'lost_on_end_next_combat',
        )?.[1],
        flying: game.db.skills.get('Temp_Flying')?.components.find(
          ([nid]: [string, any]) => nid === 'lost_on_end_next_combat',
        )?.[1],
      };
      unit.skills = oldSkills;
      enemy.team = oldEnemyTeam;
      return {
        initial,
        afterOne,
        afterTwo,
        reversed,
        redone,
        splashFlag,
        self,
        values,
      };
    });

    expect(result.initial).toEqual({ combats: '2', present: true });
    expect(result.afterOne).toEqual({ combats: 1, present: true });
    expect(result.afterTwo).toEqual({ combats: 0, present: false });
    expect(result.reversed).toEqual(result.initial);
    expect(result.redone).toEqual(result.afterTwo);
    expect(result.splashFlag).toEqual({ combats: '2', present: true });
    expect(result.self).toEqual({ combats: 0, present: false });
    expect(result.values.blinded).toEqual([
      ['NumberOfCombats (X)', '2', 'Number of combats before expiration'],
      ['LostOnSelf (T/F)', 'F', 'Lost after self combat (e.g. vulnerary)'],
      ['LostOnAlly (T/F)', 'F', 'Lost after combat with an ally'],
      ['LostOnEnemy (T/F)', 'T', 'Lost after combat with an enemy'],
      ['LostOnSplash (T/F)', 'T', 'Lost after combat if using an AOE item'],
    ]);
    expect(result.values.flying[4][1]).toBe('F');
  });
});
