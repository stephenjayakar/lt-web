/**
 * Items leaving a unit's inventory are unequipped, as Python's
 * unit.remove_item does for StoreItem, TradeItem, TradeItemWithConvoy and
 * the convoy take/give actions. Before, "Give all" in unit management left
 * EOtF's Gorbat with Killer Helm still equipped (and its statuses applied)
 * while the helm sat in the convoy.
 */
import { test, expect } from '@playwright/test';

test('store, trade and convoy swap unequip the leaving item; undo re-equips', async ({ page }) => {
  await page.goto('/?harness=true&level=DEBUG&clean=true&bundle=false');
  await page.waitForFunction(() => (window as any).__harness?.ready === true, undefined, { timeout: 60_000 });
  const result = await page.evaluate(async () => {
    const A: any = await import('/src/engine/action.ts');
    const g = (window as any).__gameRef;
    const players = [...g.units.values()].filter((u: any) => u.team === 'player' && u.position);
    const unit = players.find((u: any) => u.equippedWeapon);
    const other = players.find((u: any) => u !== unit);
    if (!unit || !other) return null;
    const weapon = unit.equippedWeapon;
    const out: Record<string, unknown> = {};

    g.actionLog.doAction(new A.StoreItemAction(unit, weapon));
    out.storedStillEquipped = unit.equippedWeapon === weapon;
    out.storedInInventory = unit.items.includes(weapon);
    g.actionLog.undo();
    out.undoStoreReequipped = unit.equippedWeapon === weapon;

    const index = unit.items.indexOf(weapon);
    g.actionLog.doAction(new A.TradeAction(unit, index, other, other.items.length));
    out.tradedStillEquipped = unit.equippedWeapon === weapon;
    out.otherHasWeapon = other.items.includes(weapon);
    g.actionLog.undo();
    out.undoTradeReequipped = unit.equippedWeapon === weapon;

    const party = g.getParty();
    const convoyItem = unit.items.find((i: any) => i !== weapon) ?? weapon;
    if (convoyItem !== weapon) {
      g.actionLog.doAction(new A.StoreItemAction(unit, convoyItem));
      g.actionLog.doAction(new A.TradeItemWithConvoy(unit, convoyItem, weapon));
      out.swappedStillEquipped = unit.equippedWeapon === weapon;
      out.weaponInConvoy = party.convoy.includes(weapon);
    }
    return out;
  });
  expect(result).not.toBeNull();
  expect(result).toMatchObject({
    storedStillEquipped: false,
    storedInInventory: false,
    undoStoreReequipped: true,
    tradedStillEquipped: false,
    otherHasWeapon: true,
    undoTradeReequipped: true,
  });
  if ('swappedStillEquipped' in result!) {
    expect(result).toMatchObject({ swappedStillEquipped: false, weaponInConvoy: true });
  }
});
