import { test, expect, type Page } from '@playwright/test';

/**
 * Python event argument parsing for item/money commands: flags are
 * recognised in any slot and items match by nid or uid
 * (event_commands._parse_command, Event._get_item_in_inventory).
 */

test.describe.configure({ mode: 'parallel' });

async function boot(page: Page): Promise<void> {
  await page.goto('/?harness=true&level=DEBUG&bundle=false');
  await page.waitForFunction(() => (window as any).__harness?.ready === true, undefined, {
    timeout: 60_000,
  });
  await page.evaluate(() => (window as any).__harness.stepFrames(5, null));
}

async function runEvent(page: Page, nid: string, source: string[]): Promise<void> {
  await page.evaluate(({ nid, source }) => {
    const g = (window as any).__gameRef;
    g.db.events.set(nid, {
      name: nid, nid, trigger: nid, level_nid: g.currentLevel?.nid ?? null,
      condition: 'True', only_once: false, priority: 0, _source: source,
    });
    g.eventManager.triggerSpecific(nid, { type: nid }, true);
    g.state.change('event');
  }, { nid, source });
  await page.evaluate(() => (window as any).__harness.stepFrames(30, null));
}

test.describe('Event item and money argument parity', () => {
  test('give_money with only the no_banner flag pays the current party', async ({ page }) => {
    await boot(page);
    const before = await page.evaluate(() => (window as any).__gameRef.getMoney());
    await runEvent(page, 'QaMoney', ['give_money;1000;no_banner', 'give_money;-300;no_banner']);
    const after = await page.evaluate(() => (window as any).__gameRef.getMoney());
    expect(after - before).toBe(700);
  });

  test('convoy give/remove ignore flags in the party slot and match uids', async ({ page }) => {
    await boot(page);
    const itemNid = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      return [...g.db.items.values()].find((item: any) => item.nid === 'Iron_Sword')?.nid
        ?? [...g.db.items.keys()][0];
    });
    await runEvent(page, 'QaConvoyGive', [`give_item;convoy;${itemNid};no_banner`]);
    const given = await page.evaluate((nid: string) => {
      const convoy = (window as any).__gameRef.getParty().convoy;
      const item = convoy.find((candidate: any) => candidate.nid === nid);
      return item ? item.uid : null;
    }, itemNid);
    expect(given).not.toBeNull();
    await runEvent(page, 'QaConvoyRemove', [`remove_item;convoy;${given};no_banner;no_warn`]);
    const remaining = await page.evaluate((uid: number) =>
      (window as any).__gameRef.getParty().convoy.some((candidate: any) => candidate.uid === uid), given);
    expect(remaining).toBe(false);
  });

  test('unlock spends the key whose can_unlock accepts the region', async ({ page }) => {
    await boot(page);
    const result = await page.evaluate(async () => {
      const g = (window as any).__gameRef;
      const { ItemObject } = await import('/src/objects/item.ts');
      const eirika = g.units.get('Eirika');
      const make = (nid: string, expression: string) => {
        const item = new ItemObject({
          nid, name: nid, desc: '', icon_nid: '', icon_index: [0, 0],
          components: [['uses', 3], ['can_unlock', expression]],
        });
        item.owner = eirika;
        return item;
      };
      const chestKey = make('QaChestKey', "region.nid.startswith('Chest')");
      const doorKey = make('QaDoorKey', "region.nid.startswith('Door')");
      eirika.items = [chestKey, doorKey, ...eirika.items];
      g.db.events.set('QaUnlock', {
        name: 'QaUnlock', nid: 'QaUnlock', trigger: 'QaUnlock', level_nid: g.currentLevel?.nid ?? null,
        condition: 'True', only_once: false, priority: 0, _source: ['unlock;Eirika'],
      });
      g.eventManager.triggerSpecific('QaUnlock', {
        type: 'QaUnlock', unit1: eirika, region: { nid: 'Door3', region_type: 'event' },
      }, true);
      g.state.change('event');
      (window as any).__harness.stepFrames(20, null);
      return { chest: chestKey.uses, door: doorKey.uses };
    });
    // The chest key would have been "first"; Python spends the door key.
    expect(result).toEqual({ chest: 3, door: 2 });
  });

  test('remove_item and move_item accept item uids', async ({ page }) => {
    await boot(page);
    const setup = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const eirika = g.units.get('Eirika');
      const seth = g.units.get('Seth');
      return { first: eirika.items[0]?.uid, firstNid: eirika.items[0]?.nid, sethCount: seth.items.length };
    });
    expect(setup.first).toBeDefined();
    await runEvent(page, 'QaMoveUid', [`move_item;Eirika;Seth;${setup.first}`]);
    const moved = await page.evaluate((uid: number) => {
      const g = (window as any).__gameRef;
      return {
        onSeth: g.units.get('Seth').items.some((item: any) => item.uid === uid),
        onEirika: g.units.get('Eirika').items.some((item: any) => item.uid === uid),
      };
    }, setup.first);
    expect(moved).toEqual({ onSeth: true, onEirika: false });
    await runEvent(page, 'QaRemoveUid', [`remove_item;Seth;${setup.first};no_banner`]);
    const removed = await page.evaluate((uid: number) =>
      (window as any).__gameRef.units.get('Seth').items.some((item: any) => item.uid === uid), setup.first);
    expect(removed).toBe(false);
  });
});
