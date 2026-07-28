import { expect, test, type Page } from '@playwright/test';

async function bootEotf(page: Page): Promise<void> {
  await page.goto('/?harness=true&project=eotf.ltproj&level=X&clean=true&bundle=false');
  await page.waitForFunction(() => (window as any).__harness?.ready === true, undefined, {
    timeout: 60_000,
  });
}

test.describe('Embrace of the Fog skill combat formulas', () => {
  test('count-locks all 36 authored formula uses and their equations', async ({ page }) => {
    await bootEotf(page);
    const result = await page.evaluate(() => {
      const game = (window as any).__gameRef;
      const selected = new Set([
        'alternate_accuracy_formula',
        'alternate_avoid_formula',
        'alternate_crit_accuracy_formula',
        'alternate_crit_avoid_formula',
        'alternate_critical_addition_formula',
        'alternate_critical_multiplier_formula',
        'alternate_damage_formula',
        'alternate_resist_formula',
      ]);
      const counts: Record<string, number> = {};
      const invalid: string[] = [];
      for (const skill of game.db.skills.values()) {
        for (const [nid, value] of skill.components) {
          if (!selected.has(nid)) continue;
          counts[nid] = (counts[nid] ?? 0) + 1;
          if (typeof value !== 'string' || !game.db.equations.has(value)) {
            invalid.push(`${skill.nid}:${nid}:${String(value)}`);
          }
        }
      }
      return { counts, invalid };
    });

    expect(result).toEqual({
      counts: {
        alternate_accuracy_formula: 2,
        alternate_avoid_formula: 4,
        alternate_crit_accuracy_formula: 3,
        alternate_crit_avoid_formula: 1,
        alternate_critical_addition_formula: 1,
        alternate_critical_multiplier_formula: 7,
        alternate_damage_formula: 14,
        alternate_resist_formula: 4,
      },
      invalid: [],
    });
  });

  test('dispatches active equations and applies multiplier plus addition to crits', async ({ page }) => {
    await bootEotf(page);
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const harness = (window as any).__harness;
      const { SkillObject } = await import('/src/objects/skill.ts');
      const { ItemObject } = await import('/src/objects/item.ts');
      const skillSystem = await import('/src/combat/skill-system.ts');
      const calcs = await import('/src/combat/combat-calcs.ts');
      const attacker = game.units.get('Player');
      const defender = game.units.get('Keeper');
      const old = {
        attackerSkills: attacker.skills,
        attackerItems: attacker.items,
        attackerWeapon: attacker.equippedWeapon,
        defenderSkills: defender.skills,
        defenderItems: defender.items,
        defenderWeapon: defender.equippedWeapon,
        attackerHp: attacker.currentHp,
        defenderHp: defender.currentHp,
        attackerDead: attacker.dead,
        defenderDead: defender.dead,
        attackerLevel: attacker.level,
      };
      const equations = new Map([
        ['_SKILL_DAMAGE', '20'],
        ['_SKILL_RESIST', '5'],
        ['_SKILL_HIT', '30'],
        ['_SKILL_AVOID', '7'],
        ['_SKILL_CRIT', '40'],
        ['_SKILL_DODGE', '11'],
        ['_SKILL_CRIT_MULT', '4'],
        ['_SKILL_CRIT_ADD', 'unit.level // 2'],
      ]);
      const oldEquations = new Map<string, string | undefined>();
      for (const [nid, expression] of equations) {
        oldEquations.set(nid, game.db.equations.get(nid));
        game.db.equations.set(nid, expression);
      }
      const makeSkill = (nid: string, components: [string, unknown][]) =>
        new SkillObject({
          nid,
          name: nid,
          desc: '',
          icon_nid: '',
          icon_index: [0, 0],
          components,
        });
      const weapon = new ItemObject({
        nid: '_SkillFormulaWeapon',
        name: 'Skill Formula Weapon',
        desc: '',
        components: [
          ['weapon', null],
          ['damage', 0],
          ['hit', 0],
          ['crit', 0],
          ['uses', 99],
        ],
      });
      const inactive = makeSkill('_InactiveFormula', [
        ['alternate_damage_formula', '_INACTIVE_DAMAGE'],
        ['condition', 'False'],
      ]);
      const legacy = makeSkill('_LegacyFormulaAlias', [
        ['damage_formula', '_LEGACY_DAMAGE'],
      ]);
      const active = makeSkill('_ActiveFormulas', [
        ['alternate_damage_formula', '_SKILL_DAMAGE'],
        ['alternate_accuracy_formula', '_SKILL_HIT'],
        ['alternate_crit_accuracy_formula', '_SKILL_CRIT'],
        ['alternate_critical_multiplier_formula', '_SKILL_CRIT_MULT'],
        ['alternate_critical_addition_formula', '_SKILL_CRIT_ADD'],
      ]);
      const defense = makeSkill('_DefenseFormulas', [
        ['alternate_resist_formula', '_SKILL_RESIST'],
        ['alternate_avoid_formula', '_SKILL_AVOID'],
        ['alternate_crit_avoid_formula', '_SKILL_DODGE'],
      ]);

      try {
        attacker.skills = [inactive, legacy, active];
        defender.skills = [defense];
        attacker.items = [weapon];
        attacker.equippedWeapon = weapon;
        defender.items = [];
        defender.equippedWeapon = null;
        attacker.currentHp = 999;
        defender.currentHp = 999;
        attacker.dead = false;
        defender.dead = false;
        attacker.level = 10;

        const selected = {
          damage: calcs.damage(attacker, weapon, game.db, game, defender),
          resist: calcs.defense(defender, weapon, game.db, null, game, attacker),
          accuracy: calcs.accuracy(attacker, weapon, game.db, game, defender),
          avoid: calcs.avoid(defender, game.db, null, weapon, game, attacker),
          critAccuracy: calcs.critAccuracy(attacker, weapon, game.db, game, defender),
          critAvoid: calcs.critAvoid(defender, null, weapon, game.db, game, attacker),
          damageFormula: skillSystem.damageFormula(
            attacker,
            { game, item: weapon, target: defender },
          ),
        };
        const hit = harness.resolveCombat('Player', 'Keeper', ['hit1', 'end']);
        const crit = harness.resolveCombat('Player', 'Keeper', ['crit1', 'end']);
        return {
          selected,
          hitDamage: hit.strikeDetails[0].damage,
          critDamage: crit.strikeDetails[0].damage,
        };
      } finally {
        attacker.skills = old.attackerSkills;
        attacker.items = old.attackerItems;
        attacker.equippedWeapon = old.attackerWeapon;
        defender.skills = old.defenderSkills;
        defender.items = old.defenderItems;
        defender.equippedWeapon = old.defenderWeapon;
        attacker.currentHp = old.attackerHp;
        defender.currentHp = old.defenderHp;
        attacker.dead = old.attackerDead;
        defender.dead = old.defenderDead;
        attacker.level = old.attackerLevel;
        for (const [nid, expression] of oldEquations) {
          if (expression === undefined) game.db.equations.delete(nid);
          else game.db.equations.set(nid, expression);
        }
      }
    });

    expect(result.selected).toEqual({
      damage: 20,
      resist: 5,
      accuracy: 30,
      avoid: 7,
      critAccuracy: 40,
      critAvoid: 11,
      damageFormula: '_SKILL_DAMAGE',
    });
    expect(result.hitDamage).toBe(15);
    expect(result.critDamage).toBe(65);
  });
});
