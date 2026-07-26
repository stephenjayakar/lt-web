import { expect, test, type Page } from '@playwright/test';

async function bootEotf(page: Page): Promise<void> {
  await page.goto('/?harness=true&project=eotf.ltproj&level=X&clean=true&bundle=false');
  await page.waitForFunction(() => (window as any).__harness?.ready === true, undefined, {
    timeout: 30_000,
  });
}

test.describe('Embrace of the Fog additive critical-damage expressions', () => {
  test('count-locks every authored static and dynamic expression', async ({ page }) => {
    await bootEotf(page);
    const result = await page.evaluate(() => {
      const game = (window as any).__gameRef;
      const collect = (componentNid: string) => [...game.db.skills.values()]
        .flatMap((skill: any) => skill.components
          .filter(([nid]: [string, unknown]) => nid === componentNid)
          .map(([, value]: [string, string]) => [skill.nid, value]));
      return {
        staticValues: collect('eval_crit_additional'),
        dynamicValues: collect('dynamic_crit_additional'),
      };
    });

    expect(result.staticValues).toEqual([
      ['Skillful_Strikes', "min(unit.get_stat('SKL') // 2, 20)"],
      ['Chaotic_Crackback', "min(20, (unit.get_max_hp() - unit.get_hp()))"],
      ['Snippy_Bunny_Reference', "25 + (0 if 'TrueDamage' in item.tags else target.get_stat('DEF') if not item_funcs.is_magic(unit, item) else target.get_stat('RES'))"],
      ['Didgeridoo_Effect', '8'],
      ['Didgeridoo_Plus_Effect', '12'],
      ['Didgeridoo_Equip', '5'],
      ['Didgeridoo_Plus_Equip', '8'],
      ['LGFG_Confident', '10'],
      ['LGFG_RuleOfCool_Child', '3'],
      ['Celestial_Extirpation_Stack', '2'],
      ['Where_are_we_Going_Helper', '15'],
      ['Frost_Shivs_Plus', '5'],
      ['Perfect_Flow', "2 * unit.get_stat('MOV') if has_skill(unit, 'Perfect_Flow_Max') else 2 * max(0, unit.get_stat('MOV') - utils.calculate_distance(unit.position, unit.previous_position)) "],
    ]);
    expect(result.dynamicValues).toEqual([
      ['Snippy_Bunny', "25 + (0 if 'TrueDamage' in item.tags else target.get_stat('DEF') if not item_funcs.is_magic(unit, item) else target.get_stat('RES'))"],
      ['Snippy_Bunny_True', "25 + (0 if 'TrueDamage' in item.tags else target.get_stat('DEF') if not item_funcs.is_magic(unit, item) else target.get_stat('RES'))"],
      ['Special_Someone', "5 if not 'Female' in unit.tags else 0"],
      ['Gentle_Giant', "max(0, unit.get_stat('CON') - u('Chantal_P').get_stat('CON'))"],
      ['Star_Strikes_Child', "min(10, unit.get_stat('SKL') // 5) if (unit.affinity == 'Light' or any([s.has_affinities and 'Light' in s.has_affinities.value for s in unit.skills])) else min(10, unit.get_stat('SKL') // 7)"],
      ['Critical_Chain_Effect', '10'],
      ['Critical_Zone_Aura_Helper', '5'],
      ['Critical_Zone_Aura_Child', '5'],
    ]);
  });

  test('evaluates the Python locals, conditions, and all authored expressions', async ({ page }) => {
    await bootEotf(page);
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { SkillObject } = await import('/src/objects/skill.ts');
      const { ItemObject } = await import('/src/objects/item.ts');
      const {
        modifyCritDamage,
        dynamicCritDamageAddition,
      } = await import('/src/combat/skill-system.ts');
      const unit = game.units.get('Player');
      const target = game.units.get('Keeper');
      const old = {
        unitSkills: unit.skills,
        targetSkills: target.skills,
        unitTags: [...unit.tags],
        targetTags: [...target.tags],
        unitStats: { ...unit.stats },
        targetStats: { ...target.stats },
        unitAffinity: unit.affinity,
        previousPosition: unit.previousPosition,
      };
      unit.stats.SKL = 30;
      unit.stats.MOV = 7;
      unit.stats.CON = 12;
      target.stats.DEF = 9;
      target.stats.RES = 4;
      unit.tags = [];
      unit.affinity = 'Light';
      unit.previousPosition = unit.position ? [unit.position[0] - 2, unit.position[1]] : null;
      const weapon = new ItemObject({
        nid: '_EotfCritExpressionWeapon',
        name: 'EotF Crit Expression Weapon',
        desc: '',
        components: [['weapon', null], ['item_tags', []]],
      });
      const defenseItem = new ItemObject({
        nid: '_EotfCritExpressionDefense',
        name: 'EotF Crit Expression Defense',
        desc: '',
        components: [['weapon', null]],
      });
      const staticUses = [...game.db.skills.values()].flatMap((prefab: any) =>
        prefab.components
          .filter(([nid]: [string, unknown]) => nid === 'eval_crit_additional')
          .map(([, expression]: [string, string]) => ({ nid: prefab.nid, expression })));
      const dynamicUses = [...game.db.skills.values()].flatMap((prefab: any) =>
        prefab.components
          .filter(([nid]: [string, unknown]) => nid === 'dynamic_crit_additional')
          .map(([, expression]: [string, string]) => ({ nid: prefab.nid, expression })));
      const staticResults = staticUses.map(({ nid, expression }) => {
        unit.skills = [new SkillObject({
          nid,
          name: nid,
          desc: '',
          components: [['eval_crit_additional', expression]],
        })];
        return [nid, modifyCritDamage(unit, weapon, game)];
      });
      const dynamicResults = dynamicUses.map(({ nid, expression }) => {
        unit.skills = [new SkillObject({
          nid,
          name: nid,
          desc: '',
          components: [['dynamic_crit_additional', expression]],
        })];
        return [
          nid,
          dynamicCritDamageAddition(
            unit, weapon, target, defenseItem, 'attack', [1, 2], 40, game,
          ),
        ];
      });

      unit.skills = [
        new SkillObject({
          nid: '_ActiveStaticCrit',
          name: 'Active static crit',
          desc: '',
          components: [
            ['condition', "item.nid == '_EotfCritExpressionWeapon'"],
            ['eval_crit_additional', "unit.get_stat('SKL') // 2"],
          ],
        }),
        new SkillObject({
          nid: '_InactiveStaticCrit',
          name: 'Inactive static crit',
          desc: '',
          components: [
            ['condition', 'False'],
            ['eval_crit_additional', '999'],
          ],
        }),
        new SkillObject({
          nid: '_DynamicLocalCrit',
          name: 'Dynamic local crit',
          desc: '',
          components: [[
            'dynamic_crit_additional',
            "base_value // 10 + attack_info[1] + (3 if mode == 'attack' else 30) + (4 if item2 else 40) + (5 if skill.nid == '_DynamicLocalCrit' else 50)",
          ]],
        }),
      ];
      const staticContext = modifyCritDamage(unit, weapon, game);
      const dynamicContext = dynamicCritDamageAddition(
        unit, weapon, target, defenseItem, 'attack', [1, 2], 40, game,
      );

      unit.skills = old.unitSkills;
      target.skills = old.targetSkills;
      unit.tags = old.unitTags;
      target.tags = old.targetTags;
      unit.stats = old.unitStats;
      target.stats = old.targetStats;
      unit.affinity = old.unitAffinity;
      unit.previousPosition = old.previousPosition;
      return { staticResults, dynamicResults, staticContext, dynamicContext };
    });

    expect(result.staticResults).toHaveLength(13);
    expect(result.dynamicResults).toHaveLength(8);
    expect(result.staticResults.every(([, value]) => Number.isFinite(value))).toBe(true);
    expect(result.dynamicResults.every(([, value]) => Number.isFinite(value))).toBe(true);
    expect(result.staticContext).toBe(15);
    expect(result.dynamicContext).toBe(18);
  });

  test('adds static and dynamic damage in scripted and normal critical strikes', async ({ page }) => {
    await bootEotf(page);
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const harness = (window as any).__harness;
      const { SkillObject } = await import('/src/objects/skill.ts');
      const { ItemObject } = await import('/src/objects/item.ts');
      const attacker = game.units.get('Player');
      const defender = game.units.get('Keeper');
      const old = {
        attackerSkills: attacker.skills,
        attackerItems: attacker.items,
        attackerWeapon: attacker.equippedWeapon,
        defenderItems: defender.items,
        defenderWeapon: defender.equippedWeapon,
        attackerStats: { ...attacker.stats },
        defenderStats: { ...defender.stats },
        attackerHp: attacker.currentHp,
        defenderHp: defender.currentHp,
        attackerDead: attacker.dead,
        defenderDead: defender.dead,
        attackerTeam: attacker.team,
        defenderTeam: defender.team,
      };
      attacker.team = 'player';
      defender.team = 'enemy';
      attacker.stats.STR = 10;
      attacker.stats.SKL = 100;
      attacker.stats.SPD = 5;
      defender.stats.DEF = 0;
      defender.stats.RES = 0;
      defender.stats.LCK = 0;
      defender.stats.SPD = 5;
      attacker.currentHp = 999;
      defender.currentHp = 999;
      attacker.dead = false;
      defender.dead = false;
      const weapon = new ItemObject({
        nid: '_EotfCritCombatWeapon',
        name: 'EotF Crit Combat Weapon',
        desc: '',
        components: [
          ['weapon', null],
          ['damage', 5],
          ['hit', 100],
          ['crit', 100],
          ['uses', 99],
        ],
      });
      attacker.items = [weapon];
      attacker.equippedWeapon = weapon;
      defender.items = [];
      defender.equippedWeapon = null;
      attacker.skills = [
        new SkillObject({
          nid: '_StaticCritCombat',
          name: 'Static crit combat',
          desc: '',
          components: [['eval_crit_additional', '7']],
        }),
        new SkillObject({
          nid: '_DynamicCritCombat',
          name: 'Dynamic crit combat',
          desc: '',
          components: [[
            'dynamic_crit_additional',
            "5 + attack_info[1] + (2 if mode == 'attack' else 50) + (3 if item2 is None else 30) + (4 if base_value > 0 else 40) + (6 if skill.nid == '_DynamicCritCombat' else 60)",
          ]],
        }),
      ];

      const reset = () => {
        attacker.currentHp = 999;
        defender.currentHp = 999;
        attacker.dead = false;
        defender.dead = false;
        weapon.uses = 99;
      };
      const hit = harness.resolveCombat('Player', 'Keeper', ['hit1', 'end']);
      reset();
      const scriptedCrit = harness.resolveCombat('Player', 'Keeper', ['crit1', 'end']);
      reset();
      harness.setConstant('rng_mode', 'lucky');
      const normalCrit = harness.resolveCombat('Player', 'Keeper');

      attacker.skills = old.attackerSkills;
      attacker.items = old.attackerItems;
      attacker.equippedWeapon = old.attackerWeapon;
      defender.items = old.defenderItems;
      defender.equippedWeapon = old.defenderWeapon;
      attacker.stats = old.attackerStats;
      defender.stats = old.defenderStats;
      attacker.currentHp = old.attackerHp;
      defender.currentHp = old.defenderHp;
      attacker.dead = old.attackerDead;
      defender.dead = old.defenderDead;
      attacker.team = old.attackerTeam;
      defender.team = old.defenderTeam;
      return {
        hit: hit?.strikeDetails[0],
        scriptedCrit: scriptedCrit?.strikeDetails[0],
        normalCrit: normalCrit?.strikeDetails[0],
      };
    });

    expect(result.hit.crit).toBe(false);
    expect(result.scriptedCrit.crit).toBe(true);
    expect(result.normalCrit.crit).toBe(true);
    expect(result.scriptedCrit.damage).toBe(result.hit.damage * 2 + 27);
    expect(result.normalCrit.damage).toBe(result.scriptedCrit.damage);
  });
});
