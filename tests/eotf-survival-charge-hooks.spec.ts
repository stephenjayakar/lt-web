import { expect, test, type Page } from '@playwright/test';

async function bootEotf(page: Page): Promise<void> {
  await page.goto('/?harness=true&project=eotf.ltproj&level=X&clean=true&bundle=false');
  await page.waitForFunction(() => (window as any).__harness?.ready === true, undefined, {
    timeout: 30_000,
  });
}

test.describe('Embrace of the Fog survival and charge hooks', () => {
  test('restores full HP after lethal combat and rewinds the consumed charge', async ({ page }) => {
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
        defenderDead: defender.dead,
      };
      const legend = new SkillObject(game.db.skills.get('Legend'));
      defender.skills = [legend];
      defender.currentHp = defender.maxHp;
      defender.dead = false;
      attacker.skills = [];
      const item = new ItemObject({
        nid: '_EotfFullMiracleWeapon',
        name: 'EotF Full Miracle Weapon',
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
      const before = {
        hp: defender.currentHp,
        dead: defender.dead,
        charge: legend.data.get('charge'),
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
      const afterIndex = game.actionLog.actionIndex;
      const changed = {
        hp: defender.currentHp,
        dead: defender.dead,
        charge: legend.data.get('charge'),
        saved: combat.miracleSaved.has(defender),
      };
      while (game.actionLog.actionIndex > beforeIndex) {
        game.actionLog.runActionBackward();
      }
      const reversed = {
        hp: defender.currentHp,
        dead: defender.dead,
        charge: legend.data.get('charge'),
      };
      while (game.actionLog.actionIndex < afterIndex) {
        game.actionLog.runActionForward();
      }
      const redone = {
        hp: defender.currentHp,
        dead: defender.dead,
        charge: legend.data.get('charge'),
      };
      const value = game.db.skills.get('Legend')?.components.find(
        ([nid]: [string, any]) => nid === 'full_miracle',
      )?.[1];
      attacker.skills = old.attackerSkills;
      defender.skills = old.defenderSkills;
      attacker.items = old.attackerItems;
      defender.currentHp = old.defenderHp;
      defender.dead = old.defenderDead;
      return { before, changed, reversed, redone, value, maxHp: defender.maxHp };
    });

    expect(result.changed).toEqual({
      hp: result.maxHp,
      dead: false,
      charge: 0,
      saved: true,
    });
    expect(result.reversed).toEqual(result.before);
    expect(result.redone).toEqual({
      hp: result.maxHp,
      dead: false,
      charge: 0,
    });
    expect(result.value).toBeNull();
  });

  test('increments active, enemy-combat, and kill charge with exact caps', async ({ page }) => {
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
        defenderHp: defender.currentHp,
        defenderTeam: defender.team,
      };
      const active = new SkillObject(game.db.skills.get('TriAttack'));
      const combat = new SkillObject(game.db.skills.get('Siege_Fighter'));
      const kill = new SkillObject(game.db.skills.get('Lightning_Strikes_Thrice'));
      const trigger = new SkillObject(game.db.skills.get('Flaming_Strikes'));
      attacker.skills = [active, combat, kill, trigger];
      defender.skills = [];
      defender.team = 'enemy';
      defender.currentHp = 0;
      const item = new ItemObject({
        nid: '_EotfChargeWeapon',
        name: 'EotF Charge Weapon',
        desc: '',
        components: [['weapon', null]],
      });
      const strike = {
        attacker,
        defender,
        item,
        hit: true,
        crit: false,
        damage: 1,
        isCounter: false,
        mode: 'attack',
        attackInfo: [0, 0] as [number, number],
      };
      const beforeIndex = game.actionLog.actionIndex;
      const snapshot = () => [active, combat, kill, trigger].map(
        (skill: any) => skill.data.get('charge'),
      );
      const before = snapshot();
      applyCombatSkillEndHooks(game, [strike], attacker, defender);
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
      const values = Object.fromEntries([
        ['active', ['TriAttack', 'active_combat_charge_increase']],
        ['combat', ['Siege_Fighter', 'combat_charge_increase_better']],
        ['kill', ['Lightning_Strikes_Thrice', 'kill_charge_increase']],
        ['trigger', ['Flaming_Strikes', 'combat_trigger_charge']],
      ].map(([key, [skillNid, componentNid]]) => [
        key,
        game.db.skills.get(skillNid)?.components.find(
          ([nid]: [string, any]) => nid === componentNid,
        )?.[1],
      ]));
      attacker.skills = old.attackerSkills;
      defender.skills = old.defenderSkills;
      defender.currentHp = old.defenderHp;
      defender.team = old.defenderTeam;
      return { before, changed, reversed, redone, values };
    });

    expect(result.before).toEqual([0, 0, 0, 3]);
    expect(result.changed).toEqual([1, 1, 1, 2]);
    expect(result.reversed).toEqual(result.before);
    expect(result.redone).toEqual(result.changed);
    expect(result.values).toEqual({
      active: 1,
      combat: 1,
      kill: 1,
      trigger: null,
    });
  });

  test('synchronizes shared charges and removes depleted skills reversibly', async ({ page }) => {
    await bootEotf(page);
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { SkillObject } = await import('/src/objects/skill.ts');
      const { triggerSkillCharge } =
        await import('/src/combat/combat-lifecycle.ts');
      const owner = game.units.get('Player');
      const ally = game.units.get('Lib');
      const old = {
        ownerSkills: owner.skills,
        allySkills: ally.skills,
        ownerTeam: owner.team,
        allyTeam: ally.team,
        ownerParty: owner.party,
        allyParty: ally.party,
      };
      owner.team = 'player';
      ally.team = 'player';
      owner.party = game.currentParty;
      ally.party = game.currentParty;
      const sharedOwner = new SkillObject(game.db.skills.get('Our_Last_Stand'));
      const sharedAlly = new SkillObject(game.db.skills.get('Our_Last_Stand'));
      const limited = new SkillObject(game.db.skills.get('Conservationist'));
      const depleted = new SkillObject(game.db.skills.get('Invincible_Once'));
      owner.skills = [sharedOwner, limited, depleted];
      ally.skills = [sharedAlly];
      const beforeIndex = game.actionLog.actionIndex;
      const snapshot = () => ({
        ownerShared: sharedOwner.data.get('charge'),
        allyShared: sharedAlly.data.get('charge'),
        limited: limited.data.get('charge'),
        depleted: depleted.data.get('charge'),
        depletedPresent: owner.skills.includes(depleted),
      });
      const before = snapshot();
      triggerSkillCharge(game, sharedOwner, owner);
      triggerSkillCharge(game, limited, owner);
      triggerSkillCharge(game, depleted, owner);
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
      const values = {
        shared: game.db.skills.get('Our_Last_Stand')?.components.find(
          ([nid]: [string, any]) => nid === 'drain_charge_all',
        )?.[1],
        limited: game.db.skills.get('Conservationist')?.components.find(
          ([nid]: [string, any]) => nid === 'limited_charge',
        )?.[1],
        depleted: game.db.skills.get('Invincible_Once')?.components.find(
          ([nid]: [string, any]) => nid === 'lost_on_charges_depleted',
        )?.[1],
      };
      owner.skills = old.ownerSkills;
      ally.skills = old.allySkills;
      owner.team = old.ownerTeam;
      ally.team = old.allyTeam;
      owner.party = old.ownerParty;
      ally.party = old.allyParty;
      return { before, changed, reversed, redone, values };
    });

    expect(result.before).toEqual({
      ownerShared: 2,
      allyShared: 2,
      limited: 4,
      depleted: 1,
      depletedPresent: true,
    });
    expect(result.changed).toEqual({
      ownerShared: 1,
      allyShared: 1,
      limited: 3,
      depleted: 0,
      depletedPresent: false,
    });
    expect(result.reversed).toEqual(result.before);
    expect(result.redone).toEqual(result.changed);
    expect(result.values).toEqual({
      shared: 2,
      limited: 4,
      depleted: 1,
    });
  });

  test('fires the EotF miracle event and consumes its charge after lethal damage', async ({
    page,
  }) => {
    await bootEotf(page);
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { SkillObject } = await import('/src/objects/skill.ts');
      const { ItemObject } = await import('/src/objects/item.ts');
      const { MapCombat } = await import('/src/combat/map-combat.ts');
      const {
        applyCombatSkillEndHooks,
        queueCombatSkillEvents,
      } = await import('/src/combat/combat-lifecycle.ts');
      const { damagePreventionSkill } = await import('/src/combat/skill-system.ts');
      const attacker = game.units.get('Player');
      const defender = game.units.get('Keeper');
      const old = {
        attackerSkills: attacker.skills,
        defenderSkills: defender.skills,
        attackerItems: attacker.items,
        defenderHp: defender.currentHp,
        defenderDead: defender.dead,
        defenderTags: defender.tags,
        eventManager: game.eventManager,
      };
      const happiness = new SkillObject(game.db.skills.get('HappinessMiracle'));
      defender.skills = [happiness];
      defender.tags = [];
      defender.currentHp = defender.maxHp;
      defender.dead = false;
      attacker.skills = [];
      const item = new ItemObject({
        nid: '_EotfEventMiracleWeapon',
        name: 'EotF Event Miracle Weapon',
        desc: '',
        components: [
          ['weapon', null],
          ['damage', 100],
          ['hit', 100],
          ['uses', 20],
        ],
      });
      attacker.items = [item];
      const triggered: any[] = [];
      game.eventManager = {
        triggerSpecific(nid: string, trigger: any) {
          triggered.push({
            nid,
            type: trigger.type,
            unit: trigger.unit1?.nid,
            target: trigger.unit2?.nid,
          });
          return true;
        },
      };
      const beforeIndex = game.actionLog.actionIndex;
      const before = {
        hp: defender.currentHp,
        dead: defender.dead,
        charge: happiness.data.get('charge'),
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
      const queued = queueCombatSkillEvents(
        game,
        combat.strikes,
        attacker,
        defender,
      );
      applyCombatSkillEndHooks(game, combat.strikes, attacker, defender);
      const afterIndex = game.actionLog.actionIndex;
      const survival = combat.strikes.find((strike: any) =>
        strike.survivalProc)?.survivalProc;
      const changed = {
        hp: defender.currentHp,
        dead: defender.dead,
        charge: happiness.data.get('charge'),
      };
      while (game.actionLog.actionIndex > beforeIndex) {
        game.actionLog.runActionBackward();
      }
      const reversed = {
        hp: defender.currentHp,
        dead: defender.dead,
        charge: happiness.data.get('charge'),
      };
      while (game.actionLog.actionIndex < afterIndex) {
        game.actionLog.runActionForward();
      }
      const redone = {
        hp: defender.currentHp,
        dead: defender.dead,
        charge: happiness.data.get('charge'),
      };
      defender.tags = ['IgnoringDamage'];
      defender.skills = [new SkillObject(game.db.skills.get('HappinessMiracle'))];
      const ignoredByTag = damagePreventionSkill(defender, true, new Set(), game) === null;
      attacker.skills = old.attackerSkills;
      defender.skills = old.defenderSkills;
      attacker.items = old.attackerItems;
      defender.currentHp = old.defenderHp;
      defender.dead = old.defenderDead;
      defender.tags = old.defenderTags;
      game.eventManager = old.eventManager;
      return {
        before,
        changed,
        reversed,
        redone,
        queued,
        triggered,
        ignoredByTag,
        survival: survival ? {
          skill: survival.skill.nid,
          component: survival.component,
          value: survival.value,
        } : null,
      };
    });

    expect(result.changed).toEqual({ hp: 1, dead: false, charge: 0 });
    expect(result.reversed).toEqual(result.before);
    expect(result.redone).toEqual(result.changed);
    expect(result.queued).toBe(1);
    expect(result.ignoredByTag).toBe(true);
    expect(result.triggered).toEqual([{
      nid: 'Global Item_HappinessCharm',
      type: 'True_Miracle_Event',
      unit: 'Keeper',
      target: 'Player',
    }]);
    expect(result.survival).toEqual({
      skill: 'HappinessMiracle',
      component: 'True_Miracle_Event',
      value: 'Global Item_HappinessCharm',
    });
  });

  test('evaluates target-aware defense proc rates and removes the temporary proc skill', async ({
    page,
  }) => {
    await bootEotf(page);
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { SkillObject } = await import('/src/objects/skill.ts');
      const { ItemObject } = await import('/src/objects/item.ts');
      const { CombatSkillLifecycle } =
        await import('/src/combat/combat-skill-lifecycle.ts');
      const attacker = game.units.get('Player');
      const defender = game.units.get('Keeper');
      const old = {
        attackerLevel: attacker.level,
        attackerTeam: attacker.team,
        defenderTeam: defender.team,
        defenderSkills: defender.skills,
        defenderItems: defender.items,
      };
      attacker.level = 37;
      attacker.team = 'player';
      defender.team = 'enemy';
      const undying = new SkillObject(game.db.skills.get('Undying'));
      defender.skills = [undying];
      const weapon = new ItemObject({
        nid: '_EotfProcWeapon',
        name: 'EotF Proc Weapon',
        desc: '',
        components: [['weapon', null]],
      });
      defender.items = [weapon];

      const successLifecycle = new CombatSkillLifecycle(game.db, () => 36, game);
      successLifecycle.beginCombat(attacker, weapon, [defender], new Map([[defender, weapon]]));
      const active = successLifecycle.beginStrike(attacker, weapon, defender);
      const during = {
        marks: active.defense.map((proc: any) => ({
          kind: proc.kind,
          parent: proc.parentSkill.nid,
          proc: proc.procSkill.nid,
        })),
        hasTemporary: defender.skills.some((skill: any) => skill.nid === 'Undying_Proc'),
      };
      successLifecycle.endStrike(active);
      const after = {
        hasTemporary: defender.skills.some((skill: any) => skill.nid === 'Undying_Proc'),
        marks: successLifecycle.marks.map((mark: any) => mark.procSkill.nid),
      };

      defender.skills = [new SkillObject(game.db.skills.get('Undying'))];
      const failureLifecycle = new CombatSkillLifecycle(game.db, () => 37, game);
      failureLifecycle.beginCombat(attacker, weapon, [defender], new Map([[defender, weapon]]));
      const failed = failureLifecycle.beginStrike(attacker, weapon, defender);

      const values = {
        expression: game.db.skills.get('Undying')?.components.find(
          ([nid]: [string, any]) => nid === 'eval_proc_rate',
        )?.[1],
        proc: game.db.skills.get('Undying')?.components.find(
          ([nid]: [string, any]) => nid === 'defense_proc_with_target',
        )?.[1],
      };
      attacker.level = old.attackerLevel;
      attacker.team = old.attackerTeam;
      defender.team = old.defenderTeam;
      defender.skills = old.defenderSkills;
      defender.items = old.defenderItems;
      return { during, after, failedCount: failed.defense.length, values };
    });

    expect(result.during).toEqual({
      marks: [{ kind: 'defense_proc', parent: 'Undying', proc: 'Undying_Proc' }],
      hasTemporary: true,
    });
    expect(result.after).toEqual({
      hasTemporary: false,
      marks: ['Undying_Proc'],
    });
    expect(result.failedCount).toBe(0);
    expect(result.values).toEqual({
      expression: 'min(target.level, 40)',
      proc: 'Undying_Proc',
    });
  });
});
