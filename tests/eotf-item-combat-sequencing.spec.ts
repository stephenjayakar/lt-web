import { expect, test, type Page } from '@playwright/test';

async function bootEotf(page: Page): Promise<void> {
  await page.goto('/?harness=true&project=eotf.ltproj&level=X&clean=true&bundle=false');
  await page.waitForFunction(() => (window as any).__harness?.ready === true, undefined, {
    timeout: 60_000,
  });
}

test.describe('Embrace of the Fog item combat sequencing', () => {
  test('count-locks all 437 authored action, brave, counter, double, and miss-damage uses', async ({ page }) => {
    await bootEotf(page);
    const inventory = await page.evaluate(() => {
      const game = (window as any).__gameRef;
      const flags = new Set([
        'attack_after_combat',
        'brave',
        'brave_on_attack',
        'cannot_be_countered',
        'cannot_counter',
        'no_double',
      ]);
      const selected = new Set([...flags, 'damage_on_miss']);
      const counts: Record<string, number> = {};
      const invalid: string[] = [];
      for (const item of game.db.items.values()) {
        for (const [nid, value] of item.components) {
          if (!selected.has(nid)) continue;
          counts[nid] = (counts[nid] ?? 0) + 1;
          if (flags.has(nid) && value !== null) {
            invalid.push(`${item.nid}:${nid}:flag`);
          } else if (nid === 'damage_on_miss' &&
              (typeof value !== 'number' || value < 0)) {
            invalid.push(`${item.nid}:${nid}:multiplier`);
          }
        }
      }
      return { counts, invalid };
    });

    expect(inventory).toEqual({
      counts: {
        attack_after_combat: 248,
        brave: 7,
        brave_on_attack: 23,
        cannot_be_countered: 28,
        cannot_counter: 40,
        damage_on_miss: 3,
        no_double: 88,
      },
      invalid: [],
    });
  });

  test('uses the equipped weapon and exact Python counter and doubling defaults', async ({ page }) => {
    await bootEotf(page);
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { ItemObject } = await import('/src/objects/item.ts');
      const items = await import('/src/combat/item-system.ts');
      const { canCounterattack } = await import('/src/combat/combat-calcs.ts');
      const attacker = game.units.get('Player');
      const defender = game.units.get('Keeper');
      if (!attacker || !defender) return null;
      const old = {
        attackerItems: attacker.items,
        defenderItems: defender.items,
        attackerWeapon: attacker.equippedWeapon,
        defenderWeapon: defender.equippedWeapon,
        attackerPosition: attacker.position ? [...attacker.position] : null,
        defenderPosition: defender.position ? [...defender.position] : null,
        defenderSkills: defender.skills,
      };
      const make = (nid: string, components: [string, unknown][]) => {
        const item = new ItemObject({
          nid, name: '', desc: '', icon_nid: '', icon_index: [0, 0], components,
        });
        return item;
      };
      const attackWeapon = make('_AttackWeapon', [
        ['weapon', null], ['min_range', 1], ['max_range', 1],
      ]);
      const weapon = make('_CounterWeapon', [
        ['weapon', null], ['min_range', 1], ['max_range', 1],
      ]);
      const blocked = make('_CounterBlocked', [
        ['weapon', null], ['cannot_counter', null], ['min_range', 1], ['max_range', 1],
      ]);
      const uncounterable = make('_CannotBeCountered', [
        ['weapon', null], ['cannot_be_countered', null],
      ]);
      const noDouble = make('_NoDouble', [['weapon', null], ['no_double', null]]);
      const siege = make('_Siege', [['siege_weapon', null]]);
      const spell = make('_Spell', [['spell', null]]);
      const usable = make('_Usable', [['usable', null]]);
      for (const item of [
        attackWeapon, weapon, blocked, uncounterable, noDouble, siege, spell, usable,
      ]) {
        item.owner = item === uncounterable ? attacker : defender;
      }

      attacker.items = [attackWeapon];
      attacker.equippedWeapon = attackWeapon;
      attackWeapon.owner = attacker;
      defender.items = [blocked, weapon];
      defender.equippedWeapon = weapon;
      weapon.owner = defender;
      defender.skills = [];
      attacker.position = [2, 2];
      defender.position = [3, 2];
      const equippedNormal = canCounterattack(
        attacker, attacker.equippedWeapon, defender, game.db, game,
      );
      defender.equippedWeapon = blocked;
      const equippedBlocked = canCounterattack(
        attacker, attacker.equippedWeapon, defender, game.db, game,
      );
      defender.equippedWeapon = weapon;
      const attackBlocksCounter = canCounterattack(
        attacker, uncounterable, defender, game.db, game,
      );
      const defaults = {
        weapon: [
          items.canCounter(defender, weapon),
          items.canBeCountered(defender, weapon),
          items.canDouble(defender, weapon),
        ],
        blocked: items.canCounter(defender, blocked),
        noDouble: items.canDouble(defender, noDouble),
        siege: [
          items.canCounter(defender, siege),
          items.canBeCountered(defender, siege),
          items.canDouble(defender, siege),
        ],
        spell: [
          items.canCounter(defender, spell),
          items.canBeCountered(defender, spell),
          items.canDouble(defender, spell),
        ],
        usable: [
          items.canCounter(defender, usable),
          items.canBeCountered(defender, usable),
          items.canDouble(defender, usable),
        ],
      };

      attacker.items = old.attackerItems;
      defender.items = old.defenderItems;
      attacker.equippedWeapon = old.attackerWeapon;
      defender.equippedWeapon = old.defenderWeapon;
      attacker.position = old.attackerPosition as [number, number] | null;
      defender.position = old.defenderPosition as [number, number] | null;
      defender.skills = old.defenderSkills;
      return { equippedNormal, equippedBlocked, attackBlocksCounter, defaults };
    });

    expect(result).toEqual({
      equippedNormal: true,
      equippedBlocked: false,
      attackBlocksCounter: false,
      defaults: {
        weapon: [true, true, true],
        blocked: false,
        noDouble: false,
        siege: [false, false, true],
        spell: [false, false, false],
        usable: [false, false, false],
      },
    });
  });

  test('accumulates base and override brave and miss-damage hooks with action retention', async ({ page }) => {
    await bootEotf(page);
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { ItemObject } = await import('/src/objects/item.ts');
      const { SkillObject } = await import('/src/objects/skill.ts');
      const items = await import('/src/combat/item-system.ts');
      const unit = game.units.get('Player');
      const target = game.units.get('Keeper');
      if (!unit || !target) return null;
      const oldSkills = unit.skills;
      game.db.items.set('_SequencingOverride', {
        nid: '_SequencingOverride',
        name: '',
        desc: '',
        icon_nid: '',
        icon_index: [0, 0],
        components: [
          ['brave', null],
          ['brave_on_attack', null],
          ['damage_on_miss', 0.33],
          ['cannot_counter', null],
        ],
      });
      const override = new SkillObject({
        nid: '_SequencingOverrideSkill',
        name: '',
        desc: '',
        icon_nid: '',
        icon_index: [0, 0],
        components: [['item_override', '_SequencingOverride']],
      });
      const item = new ItemObject({
        nid: '_SequencingBase',
        name: '',
        desc: '',
        icon_nid: '',
        icon_index: [0, 0],
        components: [
          ['weapon', null],
          ['brave', null],
          ['brave_on_attack', null],
          ['damage_on_miss', 0.5],
          ['attack_after_combat', null],
        ],
      });
      item.owner = unit;
      unit.skills = [override];
      const active = {
        attackExtra: items.dynamicMultiattacks(
          unit, item, target, null, 'attack', [0, 0], 0,
        ),
        defenseExtra: items.dynamicMultiattacks(
          unit, item, target, null, 'defense', [0, 0], 0,
        ),
        missDamage: items.damageOnMiss(item, 11),
        canCounter: items.canCounter(unit, item),
        menu: items.menuAfterCombat(unit, item),
        retainsAttack: items.canAttackAfterCombat(unit, item),
      };
      override.components.set('condition', 'False');
      const inactive = {
        attackExtra: items.dynamicMultiattacks(
          unit, item, target, null, 'attack', [0, 0], 0,
        ),
        defenseExtra: items.dynamicMultiattacks(
          unit, item, target, null, 'defense', [0, 0], 0,
        ),
        missDamage: items.damageOnMiss(item, 11),
        canCounter: items.canCounter(unit, item),
      };
      unit.skills = oldSkills;
      game.db.items.delete('_SequencingOverride');
      return { active, inactive };
    });

    expect(result).toEqual({
      active: {
        attackExtra: 4,
        defenseExtra: 2,
        missDamage: 8,
        canCounter: false,
        menu: true,
        retainsAttack: true,
      },
      inactive: {
        attackExtra: 2,
        defenseExtra: 1,
        missDamage: 5,
        canCounter: true,
      },
    });
  });
});
