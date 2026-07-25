import { expect, test, type Page } from '@playwright/test';

async function bootEotf(page: Page): Promise<void> {
  await page.goto('/?harness=true&project=eotf.ltproj&level=X&clean=true&bundle=false');
  await page.waitForFunction(() => (window as any).__harness?.ready === true, undefined, {
    timeout: 30_000,
  });
}

test.describe('Embrace of the Fog post-combat HP hooks', () => {
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
