import { expect, test, type Page } from '@playwright/test';

async function bootEotf(page: Page): Promise<void> {
  await page.goto('/?harness=true&project=eotf.ltproj&level=X&clean=true&bundle=false');
  await page.waitForFunction(() => (window as any).__harness?.ready === true, undefined, {
    timeout: 30_000,
  });
}

test.describe('Embrace of the Fog inventory capacity hooks', () => {
  test('count-locks all seven authored slot modifiers and resolves Python UNIQUE hooks', async ({
    page,
  }) => {
    await bootEotf(page);
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { SkillObject } = await import('/src/objects/skill.ts');
      const { inventoryCapacity } = await import('/src/combat/item-system.ts');
      const { inventoryCapacityOffsets } = await import('/src/combat/skill-system.ts');
      const unit = game.units.get('Player');
      const oldSkills = unit.skills;
      const wanted = new Set([
        'additional_accessories',
        'additional_inventory',
        'change_item_slots',
      ]);
      const authored: Array<{ skill: string; component: string; value: unknown }> = [];
      for (const skill of game.db.skills.values()) {
        for (const [component, value] of skill.components) {
          if (wanted.has(component)) authored.push({ skill: skill.nid, component, value });
        }
      }
      authored.sort((left, right) =>
        left.skill.localeCompare(right.skill) ||
        left.component.localeCompare(right.component));
      const real = (nid: string) => new SkillObject(game.db.skills.get(nid));
      const snapshot = () => ({
        offsets: inventoryCapacityOffsets(unit, game),
        items: inventoryCapacity(unit, false, game.db),
        accessories: inventoryCapacity(unit, true, game.db),
      });

      unit.skills = [real('Fashionable')];
      const accessories = snapshot();
      unit.skills = [real('Inventory_Management')];
      const inventory = snapshot();
      unit.skills = [real('Handcuffed')];
      const handcuffed = snapshot();

      unit.skills = [
        real('Fashionable'),
        real('Inventory_Management'),
        real('Handcuffed'),
      ];
      const independentLast = snapshot();

      const inactive = new SkillObject({
        nid: '_InactiveSlots',
        name: '',
        desc: '',
        icon_nid: '',
        icon_index: [0, 0],
        components: [['condition', 'False'], ['change_item_slots', 99]],
      });
      const charged = new SkillObject({
        nid: '_ChargedSlots',
        name: '',
        desc: '',
        icon_nid: '',
        icon_index: [0, 0],
        components: [['build_charge', 2], ['change_item_slots', 8]],
      });
      unit.skills = [real('Inventory_Management'), inactive, charged];
      const gated = snapshot();
      charged.data.set('charge', 2);
      const chargedActive = snapshot();

      unit.skills = oldSkills;
      return {
        authored,
        base: {
          items: Number(game.db.getConstant('num_items', 5)),
          accessories: Number(game.db.getConstant('num_accessories', 0)),
        },
        accessories,
        inventory,
        handcuffed,
        independentLast,
        gated,
        chargedActive,
      };
    });

    expect(result.authored).toEqual([
      { skill: 'Bag_Master', component: 'additional_inventory', value: 1 },
      { skill: 'Chained_Plates', component: 'additional_accessories', value: 1 },
      { skill: 'Fashionable', component: 'additional_accessories', value: 1 },
      { skill: 'Handcuffed', component: 'change_item_slots', value: -2 },
      { skill: 'Inventory_Management', component: 'additional_inventory', value: 1 },
      { skill: 'One_Chosen_Weapon', component: 'additional_accessories', value: 2 },
      { skill: 'Solfrid_Inv', component: 'additional_inventory', value: 1 },
    ]);
    expect(result.accessories).toEqual({
      offsets: { items: -1, accessories: 1 },
      items: result.base.items - 1,
      accessories: result.base.accessories + 1,
    });
    expect(result.inventory).toEqual({
      offsets: { items: 1, accessories: -1 },
      items: result.base.items + 1,
      accessories: Math.max(0, result.base.accessories - 1),
    });
    expect(result.handcuffed).toEqual({
      offsets: { items: -2, accessories: 0 },
      items: Math.max(0, result.base.items - 2),
      accessories: result.base.accessories,
    });
    expect(result.independentLast.offsets).toEqual({ items: -2, accessories: -1 });
    expect(result.gated.offsets).toEqual({ items: 1, accessories: -1 });
    expect(result.chargedActive.offsets).toEqual({ items: 8, accessories: -1 });
  });
});
