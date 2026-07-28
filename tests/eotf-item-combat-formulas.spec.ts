import { expect, test, type Page } from '@playwright/test';

async function bootEotf(page: Page): Promise<void> {
  await page.goto('/?harness=true&project=eotf.ltproj&level=X&clean=true&bundle=false');
  await page.waitForFunction(() => (window as any).__harness?.ready === true, undefined, {
    timeout: 60_000,
  });
}

test.describe('Embrace of the Fog core item combat formulas', () => {
  test('count-locks all 441 authored formula, effectiveness, range-magic, and triangle uses', async ({ page }) => {
    await bootEotf(page);
    const inventory = await page.evaluate(() => {
      const game = (window as any).__gameRef;
      const formulas = new Set([
        'alternate_accuracy_formula',
        'alternate_attack_speed_formula',
        'alternate_avoid_formula',
        'alternate_damage_formula',
        'alternate_defense_speed_formula',
        'alternate_resist_formula',
      ]);
      const flags = new Set([
        'magic_at_range', 'ignore_weapon_advantage', 'reaver',
      ]);
      const selected = new Set([
        ...formulas,
        'effective_damage',
        'effective',
        'effective_tag',
        'custom_triangle_multiplier',
        ...flags,
      ]);
      const counts: Record<string, number> = {};
      const invalid: string[] = [];
      for (const item of game.db.items.values()) {
        for (const [nid, value] of item.components) {
          if (!selected.has(nid)) continue;
          counts[nid] = (counts[nid] ?? 0) + 1;
          if (formulas.has(nid) &&
              (typeof value !== 'string' || !game.db.equations.has(value))) {
            invalid.push(`${item.nid}:${nid}:equation`);
          } else if (flags.has(nid) && value !== null) {
            invalid.push(`${item.nid}:${nid}:flag`);
          } else if (nid === 'custom_triangle_multiplier' &&
              typeof value !== 'number') {
            invalid.push(`${item.nid}:${nid}:number`);
          } else if (nid === 'effective' && typeof value !== 'number') {
            invalid.push(`${item.nid}:${nid}:number`);
          } else if (nid === 'effective_tag' &&
              (!Array.isArray(value) ||
                value.some((tag: unknown) => typeof tag !== 'string'))) {
            invalid.push(`${item.nid}:${nid}:tags`);
          } else if (nid === 'effective_damage') {
            const valid = value && typeof value === 'object' &&
              Array.isArray(value.effective_tags) &&
              value.effective_tags.every((tag: unknown) => typeof tag === 'string') &&
              typeof value.effective_multiplier === 'number' &&
              typeof value.effective_bonus_damage === 'number' &&
              typeof value.show_effectiveness_flash === 'boolean';
            if (!valid) invalid.push(`${item.nid}:${nid}:options`);
          }
        }
      }
      return { counts, invalid };
    });

    expect(inventory).toEqual({
      counts: {
        alternate_accuracy_formula: 2,
        alternate_attack_speed_formula: 1,
        alternate_avoid_formula: 2,
        alternate_damage_formula: 119,
        alternate_defense_speed_formula: 1,
        alternate_resist_formula: 129,
        custom_triangle_multiplier: 3,
        effective: 7,
        effective_damage: 154,
        effective_tag: 7,
        ignore_weapon_advantage: 5,
        magic_at_range: 4,
        reaver: 7,
      },
      invalid: [],
    });
  });

  test('selects every alternate item equation through the combat dispatcher', async ({ page }) => {
    await bootEotf(page);
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { ItemObject } = await import('/src/objects/item.ts');
      const items = await import('/src/combat/item-system.ts');
      const unit = game.units.get('Player');
      if (!unit) return null;
      const item = new ItemObject({
        nid: '_FormulaItem',
        name: '',
        desc: '',
        icon_nid: '',
        icon_index: [0, 0],
        components: [
          ['alternate_damage_formula', 'DOUBLE_MAGIC'],
          ['alternate_resist_formula', 'WORSE_DEFENSE'],
          ['alternate_accuracy_formula', 'DOUBLE_LUCK'],
          ['alternate_avoid_formula', 'HEALTH_AVOID'],
          ['alternate_attack_speed_formula', 'ZERO'],
          ['alternate_defense_speed_formula', 'ONE_HUNDRED'],
        ],
      });
      return {
        damage: items.damageFormula(unit, item, game),
        resist: items.resistFormula(unit, item, game),
        accuracy: items.accuracyFormula(unit, item),
        avoid: items.avoidFormula(unit, item),
        attackSpeed: items.attackSpeedFormula(unit, item),
        defenseSpeed: items.defenseSpeedFormula(unit, item),
      };
    });

    expect(result).toEqual({
      damage: 'DOUBLE_MAGIC',
      resist: 'WORSE_DEFENSE',
      accuracy: 'DOUBLE_LUCK',
      avoid: 'HEALTH_AVOID',
      attackSpeed: 'ZERO',
      defenseSpeed: 'ONE_HUNDRED',
    });
  });

  test('accumulates base and override effectiveness, ranged magic, and triangle multipliers', async ({ page }) => {
    await bootEotf(page);
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { ItemObject } = await import('/src/objects/item.ts');
      const { SkillObject } = await import('/src/objects/skill.ts');
      const {
        dynamicDamage,
        modifyWeaponTriangle,
      } = await import('/src/combat/item-system.ts');
      const unit = game.units.get('Player');
      const target = game.units.get('Keeper');
      if (!unit || !target) return null;
      const old = {
        unitSkills: unit.skills,
        targetSkills: target.skills,
        unitStats: { ...unit.stats },
        targetStats: { ...target.stats },
        unitPosition: unit.position ? [...unit.position] : null,
        targetPosition: target.position ? [...target.position] : null,
        targetTags: [...target.tags],
      };
      game.db.items.set('_FormulaOverride', {
        nid: '_FormulaOverride',
        name: '',
        desc: '',
        icon_nid: '',
        icon_index: [0, 0],
        components: [
          ['effective_damage', {
            effective_tags: ['Monster'],
            effective_multiplier: 2,
            effective_bonus_damage: 1,
            show_effectiveness_flash: true,
          }],
          ['custom_triangle_multiplier', 3],
          ['magic_at_range', null],
        ],
      });
      const override = new SkillObject({
        nid: '_FormulaOverrideSkill',
        name: '',
        desc: '',
        icon_nid: '',
        icon_index: [0, 0],
        components: [['item_override', '_FormulaOverride']],
      });
      const item = new ItemObject({
        nid: '_FormulaBase',
        name: '',
        desc: '',
        icon_nid: '',
        icon_index: [0, 0],
        components: [
          ['damage', 10],
          ['effective_damage', {
            effective_tags: ['Monster'],
            effective_multiplier: 3,
            effective_bonus_damage: 2,
            show_effectiveness_flash: true,
          }],
          ['custom_triangle_multiplier', 2],
          ['magic_at_range', null],
        ],
      });
      item.owner = unit;
      unit.skills = [override];
      target.skills = [];
      unit.stats.STR = 10;
      unit.stats.MAG = 15;
      target.stats.DEF = 7;
      target.stats.RES = 3;
      unit.position = [2, 2];
      target.position = [4, 2];
      target.tags = ['Monster'];

      const activeDamage = dynamicDamage(
        unit, item, target, null, 'attack', [0, 0], 10, game.db, game, 0,
      );
      const activeTriangle = modifyWeaponTriangle(unit, item);
      override.components.set('condition', 'False');
      const baseDamage = dynamicDamage(
        unit, item, target, null, 'attack', [0, 0], 10, game.db, game, 0,
      );
      const baseTriangle = modifyWeaponTriangle(unit, item);
      override.components.delete('condition');
      target.skills = [new SkillObject({
        nid: '_NegateMonster',
        name: '',
        desc: '',
        icon_nid: '',
        icon_index: [0, 0],
        components: [['negate_tags', ['Monster']]],
      })];
      const negatedDamage = dynamicDamage(
        unit, item, target, null, 'attack', [0, 0], 10, game.db, game, 0,
      );

      unit.skills = old.unitSkills;
      target.skills = old.targetSkills;
      unit.stats = old.unitStats;
      target.stats = old.targetStats;
      unit.position = old.unitPosition as [number, number] | null;
      target.position = old.targetPosition as [number, number] | null;
      target.tags = old.targetTags;
      game.db.items.delete('_FormulaOverride');
      return {
        activeDamage,
        activeTriangle,
        baseDamage,
        baseTriangle,
        negatedDamage,
      };
    });

    expect(result).toEqual({
      // (20 + 2) + (10 + 1) effectiveness + two ranged-magic swaps of 9.
      activeDamage: 51,
      activeTriangle: 6,
      // Base effectiveness 22 + one ranged-magic swap of 9.
      baseDamage: 31,
      baseTriangle: 2,
      // Negation blocks effectiveness, but both ranged-magic hooks still run.
      negatedDamage: 18,
    });
  });
});
