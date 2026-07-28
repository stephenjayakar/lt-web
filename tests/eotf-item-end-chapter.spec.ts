import { expect, test, type Page } from '@playwright/test';

async function bootEotf(page: Page): Promise<void> {
  await page.goto('/?harness=true&project=eotf.ltproj&level=X&clean=true&bundle=false');
  await page.waitForFunction(() => (window as any).__harness?.ready === true, undefined, {
    timeout: 60_000,
  });
}

test.describe('Embrace of the Fog remove-on-end-chapter items', () => {
  test('count-locks all eleven null-valued temporary items', async ({ page }) => {
    await bootEotf(page);
    const authored = await page.evaluate(() => {
      const game = (window as any).__gameRef;
      const entries: Array<{ nid: string; value: unknown }> = [];
      for (const item of game.db.items.values()) {
        const component = item.components.find(
          ([nid]: [string, unknown]) => nid === 'remove_on_end_chapter',
        );
        if (component) entries.push({ nid: item.nid, value: component[1] });
      }
      return entries.sort((left, right) => left.nid.localeCompare(right.nid));
    });

    expect(authored).toEqual([
      { nid: 'Gambit_Vulnerary', value: null },
      { nid: 'Iron_Striker', value: null },
      { nid: 'Iron_Striker_Plus', value: null },
      { nid: 'Mini_Shiv', value: null },
      { nid: 'Teffen_Barkskin_Balm', value: null },
      { nid: 'Teffen_Cunning_Potion', value: null },
      { nid: 'Teffen_Essence_Of_Darkness', value: null },
      { nid: 'Teffen_Essence_Of_Steel', value: null },
      { nid: 'Teffen_Mine', value: null },
      { nid: 'Teffen_Pure_Water', value: null },
      { nid: 'Teffen_Vulnerary', value: null },
    ]);
  });

  test('removes unit and convoy items reversibly before persistence', async ({ page }) => {
    await bootEotf(page);
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { ItemObject } = await import('/src/objects/item.ts');
      const unit = game.units.get('Player');
      const party = game.getParty();
      if (!unit || !party) return null;
      const runtime = (nid: string) => new ItemObject(game.db.items.get(nid));
      const keep = new ItemObject({
        nid: '_ChapterKeep', name: '', desc: '', icon_nid: '', icon_index: [0, 0],
        components: [],
      });
      const convoyBefore = new ItemObject({
        nid: '_ConvoyBefore', name: '', desc: '', icon_nid: '', icon_index: [0, 0],
        components: [],
      });
      const convoyAfter = new ItemObject({
        nid: '_ConvoyAfter', name: '', desc: '', icon_nid: '', icon_index: [0, 0],
        components: [],
      });
      const unitTemp = runtime('Iron_Striker');
      const unitTemp2 = runtime('Gambit_Vulnerary');
      const convoyTemp = runtime('Teffen_Mine');
      unit.party = game.currentParty;
      unit.persistent = true;
      unit.items = [keep, unitTemp, unitTemp2];
      unit.items.forEach((item: any) => { item.owner = unit; });
      party.convoy = [convoyBefore, convoyTemp, convoyAfter];
      for (const other of game.units.values()) {
        if (other !== unit) other.items = [];
      }
      game.items.clear();
      for (const item of [
        keep, unitTemp, unitTemp2, convoyBefore, convoyTemp, convoyAfter,
      ]) {
        game.items.set(item.nid, item);
      }

      const beforeActionIndex = game.actionLog.actionIndex;
      const removed = game.applyItemEndChapterHooks();
      const snapshot = () => ({
        unitItems: unit.items.map((item: any) => item.nid),
        convoy: party.convoy.map((item: any) => item.nid),
        owners: [unitTemp.owner?.nid ?? null, unitTemp2.owner?.nid ?? null],
      });
      const applied = snapshot();
      while (game.actionLog.actionIndex > beforeActionIndex) {
        game.actionLog.runActionBackward();
      }
      const reversed = snapshot();
      while (game.actionLog.actionIndex < game.actionLog.actions.length - 1) {
        game.actionLog.runActionForward();
      }
      const redone = snapshot();

      // Restore once more, then prove the real full cleanup invokes the same
      // hook before it snapshots persistent inventories.
      while (game.actionLog.actionIndex > beforeActionIndex) {
        game.actionLog.runActionBackward();
      }
      game.cleanUpLevel();
      const persistedNids = [...game.persistentItems.values()]
        .map((item: any) => item.nid)
        .sort();
      return {
        removed,
        applied,
        reversed,
        redone,
        afterCleanup: {
          unitItems: unit.items.map((item: any) => item.nid),
          convoy: party.convoy.map((item: any) => item.nid),
          persistedNids,
        },
      };
    });

    expect(result).not.toBeNull();
    expect(result!.removed).toBe(3);
    expect(result!.applied).toEqual({
      unitItems: ['_ChapterKeep'],
      convoy: ['_ConvoyBefore', '_ConvoyAfter'],
      owners: [null, null],
    });
    expect(result!.reversed).toEqual({
      unitItems: ['_ChapterKeep', 'Iron_Striker', 'Gambit_Vulnerary'],
      convoy: ['_ConvoyBefore', 'Teffen_Mine', '_ConvoyAfter'],
      owners: ['Player', 'Player'],
    });
    expect(result!.redone).toEqual(result!.applied);
    expect(result!.afterCleanup).toEqual({
      unitItems: ['_ChapterKeep'],
      convoy: ['_ConvoyBefore', '_ConvoyAfter'],
      persistedNids: ['_ChapterKeep', '_ConvoyAfter', '_ConvoyBefore'],
    });
  });

  test('force_chapter_clean_up runs the same temporary-item hook', async ({ page }) => {
    await bootEotf(page);
    const setup = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { ItemObject } = await import('/src/objects/item.ts');
      const { GameEvent } = await import('/src/events/event-manager.ts');
      const unit = game.units.get('Player');
      if (!unit?.position) return null;
      const item = new ItemObject(game.db.items.get('Teffen_Vulnerary'));
      item.owner = unit;
      unit.items = [item];
      unit.currentHp = 1;
      const event = new GameEvent({
        nid: '_test_force_chapter_cleanup',
        name: '',
        trigger: 'test',
        level_nid: game.currentLevel?.nid ?? null,
        condition: '',
        only_once: false,
        priority: 0,
        _source: ['force_chapter_clean_up'],
      }, { type: 'test', unit1: unit });
      game.eventManager.eventQueue.push(event);
      game.state.change('event');
      return { unitNid: unit.nid, itemNid: item.nid };
    });
    expect(setup).not.toBeNull();
    await page.evaluate(() => (window as any).__harness.stepFrames(8, null));
    const outcome = await page.evaluate(({ unitNid, itemNid }) => {
      const game = (window as any).__gameRef;
      const unit = game.units.get(unitNid);
      return {
        hasItem: unit.items.some((item: any) => item.nid === itemNid),
        hp: unit.currentHp,
        maxHp: unit.maxHp,
        position: unit.position,
      };
    }, setup!);
    expect(outcome).toEqual({
      hasItem: false,
      hp: outcome.maxHp,
      maxHp: outcome.maxHp,
      position: null,
    });
  });
});
