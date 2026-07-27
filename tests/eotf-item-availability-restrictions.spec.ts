import { expect, test, type Page } from '@playwright/test';

async function bootEotf(page: Page): Promise<void> {
  await page.goto('/?harness=true&project=eotf.ltproj&level=X&clean=true&bundle=false');
  await page.waitForFunction(() => (window as any).__harness?.ready === true, undefined, {
    timeout: 30_000,
  });
}

test.describe('Embrace of the Fog item availability restrictions', () => {
  test('count-locks all 12 uses and preserves standard versus evaluated magic', async ({
    page,
  }) => {
    await bootEotf(page);
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { ItemObject } = await import('/src/objects/item.ts');
      const { SkillObject } = await import('/src/objects/skill.ts');
      const { available } = await import('/src/combat/item-system.ts');
      const unit = game.units.get('Player');
      const oldSkills = unit.skills;
      const wanted = new Set([
        'cannot_use_items',
        'cannot_use_items_enemy',
        'cannot_use_magic_items',
        'cannot_use_magic_items_eval',
      ]);
      const counts: Record<string, number> = {};
      const nonNull: string[] = [];
      for (const skill of game.db.skills.values()) {
        for (const [component, value] of skill.components) {
          if (!wanted.has(component)) continue;
          counts[component] = (counts[component] ?? 0) + 1;
          if (value !== null) nonNull.push(`${skill.nid}:${component}`);
        }
      }
      const item = (nid: string, components: [string, unknown][]) => new ItemObject({
        nid,
        name: '',
        desc: '',
        icon_nid: '',
        icon_index: [0, 0],
        components,
      });
      const physical = item('_Physical', [['weapon', null]]);
      const enemy = item('_Enemy', [['target_enemy', null]]);
      const ally = item('_Ally', [['target_ally', null]]);
      const magic = item('_Magic', [['magic', null]]);
      const rangedMagic = item('_RangedMagic', [['magic_at_range', null]]);
      const evalMagicTrue = item('_EvalMagicTrue', [['eval_magic', 'True']]);
      const evalMagicFalse = item('_EvalMagicFalse', [['eval_magic', 'False']]);
      const evalDragonTrue = item('_EvalDragonTrue', [['eval_dragon', 'True']]);
      const dragonMagic = item('_DragonMagic', [['eval_dragon_magic', 'False']]);
      const real = (nid: string) => new SkillObject(game.db.skills.get(nid));
      const allowed = (candidate: InstanceType<typeof ItemObject>) =>
        available(unit, candidate, game.db, game);

      unit.skills = [real('Ethereal')];
      const enemyRestriction = { enemy: allowed(enemy), ally: allowed(ally) };

      unit.skills = [real('Silence')];
      const evaluatedRestriction = {
        physical: allowed(physical),
        magic: allowed(magic),
        rangedMagic: allowed(rangedMagic),
        evalMagicTrue: allowed(evalMagicTrue),
        evalMagicFalse: allowed(evalMagicFalse),
        evalDragonTrue: allowed(evalDragonTrue),
        dragonMagic: allowed(dragonMagic),
      };

      unit.skills = [real('Visceral_Tastes')];
      const standardRestriction = {
        physical: allowed(physical),
        magic: allowed(magic),
        rangedMagic: allowed(rangedMagic),
        evalMagicTrue: allowed(evalMagicTrue),
      };

      unit.skills = [new SkillObject({
        nid: '_InactiveEnemyRestriction',
        name: '',
        desc: '',
        icon_nid: '',
        icon_index: [0, 0],
        components: [['condition', 'False'], ['cannot_use_items_enemy', null]],
      })];
      const inactive = allowed(enemy);
      unit.skills = oldSkills;
      return {
        counts,
        nonNull,
        enemyRestriction,
        evaluatedRestriction,
        standardRestriction,
        inactive,
      };
    });

    expect(result.counts).toEqual({
      cannot_use_items: 6,
      cannot_use_items_enemy: 1,
      cannot_use_magic_items: 3,
      cannot_use_magic_items_eval: 2,
    });
    expect(result.nonNull).toEqual([]);
    expect(result.enemyRestriction).toEqual({ enemy: false, ally: true });
    expect(result.evaluatedRestriction).toEqual({
      physical: true,
      magic: false,
      rangedMagic: true,
      evalMagicTrue: false,
      evalMagicFalse: true,
      evalDragonTrue: false,
      dragonMagic: false,
    });
    expect(result.standardRestriction).toEqual({
      physical: true,
      magic: false,
      rangedMagic: true,
      evalMagicTrue: true,
    });
    expect(result.inactive).toBe(true);
  });

  test('no_equip vetoes equipping and auto-equipping authored ability weapons', async ({
    page,
  }) => {
    await bootEotf(page);
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { ItemObject } = await import('/src/objects/item.ts');
      const unit = game.units.get('Player');

      // Python resolves `equippable` ALL_DEFAULT_FALSE: a component returning
      // False outranks the `weapon` component returning True.
      const make = (nid: string, components: [string, unknown][]) => new ItemObject({
        nid,
        name: '',
        desc: '',
        icon_nid: '',
        icon_index: [0, 0],
        components,
      });
      const plain = make('_PlainWeapon', [['weapon', null]]);
      const barred = make('_NoEquipWeapon', [['weapon', null], ['no_equip', null]]);

      const originalItems = unit.items.slice();
      const originalWeapon = unit.equippedWeapon;

      // Auto-equip must skip the barred weapon and settle on the plain one,
      // even though the barred weapon comes first in the inventory.
      unit.items.length = 0;
      unit.items.push(barred, plain);
      unit.equippedWeapon = null;
      unit.autoequip();
      const autoEquipped = unit.equippedWeapon?.nid ?? null;

      // A barred weapon alone must leave the unit with nothing equipped.
      unit.items.length = 0;
      unit.items.push(barred);
      unit.equippedWeapon = null;
      unit.autoequip();
      const aloneEquipped = unit.equippedWeapon?.nid ?? null;

      const canEquip = {
        plain: unit.canEquip(plain),
        barred: unit.canEquip(barred),
      };

      // Every authored EotF item carrying no_equip must be refused.
      const authoredRefused: string[] = [];
      let authoredCount = 0;
      for (const dbItem of game.db.items.values()) {
        if (!dbItem.components.some(([nid]: [string]) => nid === 'no_equip')) continue;
        authoredCount += 1;
        if (unit.canEquip(new ItemObject(dbItem))) authoredRefused.push(dbItem.nid);
      }

      unit.items.length = 0;
      unit.items.push(...originalItems);
      unit.equippedWeapon = originalWeapon;

      return { autoEquipped, aloneEquipped, canEquip, authoredCount, authoredRefused };
    });

    expect(result.canEquip).toEqual({ plain: true, barred: false });
    expect(result.autoEquipped).toBe('_PlainWeapon');
    expect(result.aloneEquipped).toBeNull();
    expect(result.authoredCount).toBe(37);
    expect(result.authoredRefused).toEqual([]);
  });
});
