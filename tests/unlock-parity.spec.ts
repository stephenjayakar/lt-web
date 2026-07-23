import { expect, test } from '@playwright/test';

async function waitForHarness(page: import('@playwright/test').Page): Promise<void> {
  await page.waitForFunction(() => !!(window as any).__harness?.ready, { timeout: 15000 });
}

test.describe('door and chest unlock parity', () => {
  test('honors item expressions, item availability, Locktouch, and nested multi-items', async ({ page }) => {
    await page.goto('/?harness=true&level=0&clean=true&bundle=false');
    await waitForHarness(page);

    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { ItemObject } = await import('/src/objects/item.ts');
      const { SkillObject } = await import('/src/objects/skill.ts');
      const { canUnlock } = await import('/src/combat/item-system.ts');
      const { evaluateCondition } = await import('/src/events/event-manager.ts');
      const unit = game.units.get('Eirika');
      if (!unit) return null;

      const makeItem = (nid: string, components: [string, any][]) => new ItemObject({
        nid, name: nid, desc: '', icon_nid: '', icon_index: [0, 0], components,
      });
      const door = { nid: 'Door7', region_type: 'event' };
      const chest = { nid: 'Chest2', region_type: 'event' };
      const doorKey = makeItem('_DoorKey', [
        ['can_unlock', "region.nid.startswith('Door')"],
      ]);
      const chestKey = makeItem('_ChestKey', [
        ['can_unlock', "region.nid.startswith('Chest')"],
      ]);
      const restrictedKey = makeItem('_RestrictedKey', [
        ['can_unlock', 'True'],
        ['prf_class', ['Thief']],
      ]);

      const direct = {
        door: canUnlock(unit, doorKey, door, game),
        doorOnChest: canUnlock(unit, doorKey, chest, game),
        chest: canUnlock(unit, chestKey, chest, game),
      };

      const oldItems = [...unit.items];
      const oldSkills = [...unit.skills];
      unit.items = [restrictedKey];
      const unavailableKey = {
        door: unit.canUnlock(door),
        condition: evaluateCondition('unit.can_unlock(region)', {
          game, unit1: unit, region: door,
        }),
      };

      unit.items = [doorKey];
      const availableDoorKey = {
        door: unit.canUnlock(door),
        chest: unit.canUnlock(chest),
        condition: evaluateCondition('unit.can_unlock(region)', {
          game, unit1: unit, region: door,
        }),
      };

      unit.items = [];
      unit.skills = [new SkillObject({
        nid: '_Locktouch', name: 'Locktouch', desc: '',
        icon_nid: '', icon_index: [0, 0],
        components: [['locktouch', null]],
      })];
      const locktouch = {
        door: unit.canUnlock(door),
        chest: unit.canUnlock(chest),
      };

      unit.skills = [];
      const outer = makeItem('_OuterKeys', [['multi_item', ['_InnerKeys']]]);
      const inner = makeItem('_InnerKeys', [['multi_item', ['_NestedDoorKey']]]);
      const nestedKey = makeItem('_NestedDoorKey', [
        ['can_unlock', "region.nid.startswith('Door')"],
      ]);
      outer.subitems = [inner];
      inner.parentItem = outer;
      inner.subitems = [nestedKey];
      nestedKey.parentItem = inner;
      unit.items = [outer];
      const nested = {
        door: unit.canUnlock(door),
        chest: unit.canUnlock(chest),
      };

      unit.items = oldItems;
      unit.skills = oldSkills;
      return { direct, unavailableKey, availableDoorKey, locktouch, nested };
    });

    expect(result).toEqual({
      direct: { door: true, doorOnChest: false, chest: true },
      unavailableKey: { door: false, condition: false },
      availableDoorKey: { door: true, chest: false, condition: true },
      locktouch: { door: true, chest: true },
      nested: { door: true, chest: false },
    });
  });
});
