import { expect, test, type Page } from '@playwright/test';

async function bootEotf(page: Page): Promise<void> {
  await page.goto('/?harness=true&project=eotf.ltproj&level=X&clean=true&bundle=false');
  await page.waitForFunction(() => (window as any).__harness?.ready === true, undefined, {
    timeout: 60_000,
  });
}

test.describe('Embrace of the Fog generic combat procs', () => {
  test('count-locks every attack/defense proc and equation-backed rate', async ({ page }) => {
    await bootEotf(page);
    const result = await page.evaluate(() => {
      const game = (window as any).__gameRef;
      const parents: Array<[string, string, string]> = [];
      const rates: Array<[string, unknown]> = [];
      const invalid: string[] = [];
      for (const skill of game.db.skills.values()) {
        for (const [nid, value] of skill.components) {
          if (nid === 'attack_proc' || nid === 'defense_proc') {
            parents.push([skill.nid, nid, value]);
            if (typeof value !== 'string' || !game.db.skills.has(value)) {
              invalid.push(`${skill.nid}:${nid}:child`);
            }
          } else if (nid === 'proc_rate') {
            rates.push([skill.nid, value]);
            if (typeof value !== 'number' &&
                (typeof value !== 'string' || !game.db.equations.has(value))) {
              invalid.push(`${skill.nid}:proc_rate:equation`);
            }
          }
        }
      }
      return { parents, rates, invalid };
    });

    expect(result.parents).toEqual([
      ['Devils_Reversal', 'attack_proc', 'Devils_Reversal_Proc'],
      ['Devils_Reversal_Weapon', 'attack_proc', 'Devils_Reversal_Proc'],
      ['Devils_Reversal_Temp', 'attack_proc', 'Devils_Reversal_Proc'],
      ['First_Strike', 'attack_proc', 'First_Strike_child'],
      ['Sol_Proc_Chance', 'attack_proc', 'Sol_Proc'],
      ['Pavise', 'defense_proc', 'Pavise_Proc'],
      ['Pulsar', 'attack_proc', 'Pulsar_Proc'],
      ['Thracian_Miracle', 'defense_proc', 'Thracian_Miracle_Proc'],
      ['Unceasing_Urge', 'attack_proc', 'Unceasing_Urge_Proc'],
      ['Voices_On_High', 'attack_proc', 'Voices_On_High_Proc'],
      ['Devils_Reversal_Burning', 'attack_proc', 'Devils_Reversal_Burning_Proc'],
      ['Boundary_Of_Death', 'attack_proc', 'Boundary_Of_Death_Child'],
      ['Immaculate', 'defense_proc', 'Immaculate_Proc'],
    ]);
    expect(result.rates).toEqual([
      ['Devils_Reversal', 'DEVIL_REVERSAL'],
      ['Devils_Reversal_Weapon', 'DEVIL_REVERSAL'],
      ['Devils_Reversal_Temp', 'DEVIL_REVERSAL'],
      ['Sol_Proc_Chance', 'LUCK'],
      ['Pavise', 'SKILL'],
      ['Pulsar', 'SKILL'],
      ['Thracian_Miracle', 'TRIPLE_LUCK'],
      ['Unceasing_Urge', 'DAMAGE'],
      ['Voices_On_High', 'LUCK'],
      ['Devils_Reversal_Burning', 'DEVIL_REVERSAL_BURNING'],
      ['Boundary_Of_Death', 'QUARTER'],
      ['Immaculate', 'MAGIC_DEFENSE'],
    ]);
    expect(result.invalid).toEqual([]);
  });

  test('real Pulsar and Pavise children affect one strike then clean up', async ({ page }) => {
    await bootEotf(page);
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { SkillObject } = await import('/src/objects/skill.ts');
      const { ItemObject } = await import('/src/objects/item.ts');
      const { CombatPhaseSolver } = await import('/src/combat/combat-solver.ts');
      const attacker = game.units.get('Player');
      const defender = game.units.get('Keeper');
      const old = {
        attackerSkills: attacker.skills, defenderSkills: defender.skills,
        attackerItems: attacker.items, defenderItems: defender.items,
        attackerWeapon: attacker.equippedWeapon, defenderWeapon: defender.equippedWeapon,
        attackerStats: { ...attacker.stats }, defenderStats: { ...defender.stats },
        attackerHp: attacker.currentHp, defenderHp: defender.currentHp,
        attackerDead: attacker.dead, defenderDead: defender.dead,
        attackerTeam: attacker.team, defenderTeam: defender.team,
        attackerPosition: attacker.position, defenderPosition: defender.position,
      };
      const weapon = new ItemObject({
        nid: '_EotfProcWeapon', name: 'EotF Proc Weapon', desc: '',
        components: [['weapon', null], ['damage', 20], ['hit', 100], ['uses', 99]],
      });
      const resolve = () => {
        const solver = new CombatPhaseSolver(() => 0, game);
        const strikes = solver.resolve(
          attacker, weapon, defender, null, game.db, 'classic', null, ['hit1', 'end'],
        );
        return {
          damage: strikes[0].damage,
          attackProc: strikes[0].attackProcs?.[0]?.procSkill.nid ?? null,
          defenseProc: strikes[0].defenseProcs?.[0]?.procSkill.nid ?? null,
          playback: solver.procPlayback.map((mark: any) =>
            `${mark.kind}:${mark.parentSkill.nid}:${mark.procSkill.nid}`),
        };
      };
      try {
        attacker.team = 'player'; defender.team = 'enemy';
        attacker.position = [1, 1]; defender.position = [2, 1];
        attacker.stats.STR = 0; defender.stats.DEF = 0;
        attacker.currentHp = 100; defender.currentHp = 100;
        attacker.dead = false; defender.dead = false;
        attacker.items = [weapon]; attacker.equippedWeapon = weapon;
        defender.items = []; defender.equippedWeapon = null;

        attacker.skills = []; defender.skills = [];
        const baseline = resolve();
        const pulsar = new SkillObject(game.db.skills.get('Pulsar'));
        pulsar.components.set('proc_rate', 100);
        attacker.skills = [pulsar];
        const attack = resolve();
        const attackRemaining = attacker.skills.map((skill: any) => skill.nid);

        attacker.skills = [];
        const pavise = new SkillObject(game.db.skills.get('Pavise'));
        pavise.components.set('proc_rate', 100);
        defender.skills = [pavise];
        const defense = resolve();
        const defenseRemaining = defender.skills.map((skill: any) => skill.nid);
        return { baseline, attack, defense, attackRemaining, defenseRemaining };
      } finally {
        attacker.skills = old.attackerSkills; defender.skills = old.defenderSkills;
        attacker.items = old.attackerItems; defender.items = old.defenderItems;
        attacker.equippedWeapon = old.attackerWeapon;
        defender.equippedWeapon = old.defenderWeapon;
        attacker.stats = old.attackerStats; defender.stats = old.defenderStats;
        attacker.currentHp = old.attackerHp; defender.currentHp = old.defenderHp;
        attacker.dead = old.attackerDead; defender.dead = old.defenderDead;
        attacker.team = old.attackerTeam; defender.team = old.defenderTeam;
        attacker.position = old.attackerPosition; defender.position = old.defenderPosition;
      }
    });

    expect(result.baseline.damage).toBe(20);
    expect(result.attack).toEqual({
      damage: 60, attackProc: 'Pulsar_Proc', defenseProc: null,
      playback: ['attack_proc:Pulsar:Pulsar_Proc'],
    });
    expect(result.defense).toEqual({
      damage: 10, attackProc: null, defenseProc: 'Pavise_Proc',
      playback: ['defense_proc:Pavise:Pavise_Proc'],
    });
    expect(result.attackRemaining).toEqual(['Pulsar']);
    expect(result.defenseRemaining).toEqual(['Pavise']);
  });
});
