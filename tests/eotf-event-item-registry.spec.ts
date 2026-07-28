import { expect, test, type Page } from '@playwright/test';

async function bootEotf(page: Page): Promise<void> {
  await page.goto('/?harness=true&project=eotf.ltproj&level=X&clean=true&bundle=false');
  await page.waitForFunction(() => (window as any).__harness?.ready === true, undefined, {
    timeout: 60_000,
  });
}

test.describe('Embrace of the Fog item identity and registry', () => {
  test('resolves authored UID expressions and reversibly registers item trees', async ({ page }) => {
    await bootEotf(page);
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { evaluateExpression } = await import('/src/events/event-manager.ts');
      const { createItemTree } = await import('/src/objects/item.ts');
      const context = {
        game,
        gameVars: game.gameVars,
        levelVars: game.levelVars,
      };
      const registered = [...new Set(game.items.values())] as any[];
      const owned = registered.find((item) => item.owner);
      const componentItem = registered.find((item) => item.components.has('damage')) ?? owned;
      if (!owned || !componentItem) throw new Error('EOtF level X has no registered owned item');

      const authored = {
        getItem: 0,
        itemRegistry: 0,
        registerItem: 0,
      };
      for (const event of game.db.events.values()) {
        for (const line of event._source ?? []) {
          authored.getItem += [...line.matchAll(/game\.get_item\(/g)].length;
          authored.itemRegistry += [...line.matchAll(/game\.item_registry/g)].length;
          authored.registerItem += [...line.matchAll(/game\.register_item\(/g)].length;
        }
      }

      const warnings: string[] = [];
      const originalWarn = console.warn;
      console.warn = (...args: any[]) => {
        const text = args.map(String).join(' ');
        if (text.includes('EventCondition JS eval failed')) warnings.push(text);
        originalWarn(...args);
      };
      const lookup = {
        nid: evaluateExpression(`game.get_item(${owned.uid}).nid`, context),
        registryNid: evaluateExpression(`game.item_registry.get(${owned.uid}).nid`, context),
        ownerNid: evaluateExpression(`game.get_item(${owned.uid}).owner_nid`, context),
        componentValue: componentItem.components.has('damage')
          ? evaluateExpression(
            `game.get_item(${componentItem.uid}).components.get('damage').value`,
            context,
          )
          : null,
      };

      const treePrefab = [...game.db.items.values()].find((prefab: any) =>
        prefab.components.some(([nid]: [string, any]) =>
          nid === 'multi_item' || nid === 'sequence_item'));
      if (!treePrefab) throw new Error('EOtF has no recursive item prefab');
      const tree = createItemTree(treePrefab, (nid: string) => game.db.items.get(nid));
      const beforeIndex = game.actionLog.actionIndex;
      evaluateExpression('game.register_item(copied_item)', {
        ...context,
        localArgs: new Map([['copied_item', tree]]),
      });
      const afterRegister = [tree, ...tree.subitems].map((item: any) => ({
        uid: item.uid,
        found: game.getItem(item.uid) === item,
      }));
      game.actionLog.runActionBackward();
      const afterReverse = [tree, ...tree.subitems].map(
        (item: any) => game.getItem(item.uid) === null,
      );
      game.actionLog.runActionForward();
      const afterRedo = [tree, ...tree.subitems].map(
        (item: any) => game.getItem(item.uid) === item,
      );
      console.warn = originalWarn;

      return {
        authored,
        uniqueUids: new Set(registered.map((item) => item.uid)).size === registered.length,
        minimumUid: Math.min(...registered.map((item) => item.uid)),
        lookup,
        expected: {
          nid: owned.nid,
          ownerNid: owned.owner.nid,
          componentValue: componentItem.components.get('damage') ?? null,
        },
        treeSize: 1 + tree.subitems.length,
        actionDelta: game.actionLog.actionIndex - beforeIndex,
        afterRegister,
        afterReverse,
        afterRedo,
        warnings,
      };
    });

    expect(result.authored).toEqual({
      getItem: 256,
      itemRegistry: 2,
      registerItem: 2,
    });
    expect(result.uniqueUids).toBe(true);
    expect(result.minimumUid).toBeGreaterThanOrEqual(100);
    expect(result.lookup).toEqual({
      nid: result.expected.nid,
      registryNid: result.expected.nid,
      ownerNid: result.expected.ownerNid,
      componentValue: result.expected.componentValue,
    });
    expect(result.treeSize).toBeGreaterThan(1);
    expect(result.actionDelta).toBe(1);
    expect(result.afterRegister.every((entry) => entry.found)).toBe(true);
    expect(result.afterReverse.every(Boolean)).toBe(true);
    expect(result.afterRedo.every(Boolean)).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  test('event-created items register by UID and undo with their inventory gain', async ({ page }) => {
    await bootEotf(page);
    const setup = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { GameEvent } = await import('/src/events/event-manager.ts');
      const unit = game.units.get('Player');
      const beforeUids = unit.items.map((item: any) => item.uid);
      const beforeActionIndex = game.actionLog.actionIndex;
      game.eventManager.eventQueue.push(new GameEvent({
        nid: '_test_uid_give_item',
        name: 'UID Give Item',
        trigger: 'test',
        level_nid: 'X',
        condition: '',
        only_once: false,
        priority: 0,
        _source: ['give_item;Player;Vulnerary;no_banner'],
      }, { type: 'test', levelNid: 'X', unit1: unit }));
      game.state.change('event');
      return { beforeUids, beforeActionIndex };
    });
    await page.evaluate(() => (window as any).__harness.stepFrames(30, null));

    const result = await page.evaluate(({ beforeUids, beforeActionIndex }) => {
      const game = (window as any).__gameRef;
      const unit = game.units.get('Player');
      const created = unit.items.find((item: any) => !beforeUids.includes(item.uid));
      const registered = !!created && game.getItem(created.uid) === created;
      const uid = created?.uid ?? null;
      while (game.actionLog.actionIndex > beforeActionIndex) {
        game.actionLog.runActionBackward();
      }
      const reversed = uid !== null &&
        !unit.items.some((item: any) => item.uid === uid) &&
        game.getItem(uid) === null;
      while (game.actionLog.actionIndex < game.actionLog.actions.length - 1) {
        game.actionLog.runActionForward();
      }
      return {
        nid: created?.nid ?? null,
        uid,
        registered,
        reversed,
        redone: uid !== null &&
          unit.items.some((item: any) => item.uid === uid) &&
          game.getItem(uid)?.uid === uid,
      };
    }, setup);

    expect(result).toEqual({
      nid: 'Vulnerary',
      uid: expect.any(Number),
      registered: true,
      reversed: true,
      redone: true,
    });
  });

  test('round-trips UIDs and counter with legacy-save fallback', async ({ page }) => {
    await bootEotf(page);
    const snapshot = await page.evaluate(() => (window as any).__harness.saveSnapshot());
    const savedUids = snapshot.items.map((item: any) => item.uid);
    expect(savedUids.length).toBeGreaterThan(0);
    expect(new Set(savedUids).size).toBe(savedUids.length);
    expect(snapshot.itemCounter).toBeGreaterThan(Math.max(...savedUids));

    const loaded = await page.evaluate(
      (saved) => (window as any).__harness.loadSnapshot(saved),
      snapshot,
    );
    expect(loaded).toBe(true);
    const restored = await page.evaluate(async (saved) => {
      const game = (window as any).__gameRef;
      const { ItemObject } = await import('/src/objects/item.ts');
      const prefab = game.db.items.values().next().value;
      const next = new ItemObject(prefab);
      return {
        lookups: saved.items.map((item: any) => game.getItem(item.uid)?.nid ?? null),
        expected: saved.items.map((item: any) => item.nid),
        nextUid: next.uid,
      };
    }, snapshot);
    expect(restored.lookups).toEqual(restored.expected);
    expect(restored.nextUid).toBe(snapshot.itemCounter);

    const legacy = structuredClone(snapshot);
    delete legacy.itemCounter;
    for (const item of legacy.items) delete item.uid;
    expect(await page.evaluate(
      (saved) => (window as any).__harness.loadSnapshot(saved),
      legacy,
    )).toBe(true);
    const legacyUids = await page.evaluate(() =>
      [...new Set((window as any).__gameRef.items.values())].map((item: any) => item.uid));
    expect(new Set(legacyUids).size).toBe(legacyUids.length);
    expect(Math.min(...legacyUids)).toBeGreaterThanOrEqual(100);
  });
});
