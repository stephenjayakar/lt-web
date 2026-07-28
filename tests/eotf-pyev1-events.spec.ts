import { expect, test, type Page } from '@playwright/test';

async function bootEotf(page: Page, level = 'X'): Promise<void> {
  await page.goto(
    `/?harness=true&project=eotf.ltproj&level=${encodeURIComponent(level)}&clean=true&bundle=false`,
  );
  await page.waitForFunction(() => (window as any).__harness?.ready === true, undefined, {
    timeout: 60_000,
  });
}

test.describe('Embrace of the Fog raw PYEV1 events', () => {
  test("God's Image copies a compatible weapon into Ayla's vessel reversibly", async ({ page }) => {
    const warnings: string[] = [];
    page.on('console', (message) => {
      const text = message.text();
      if (/PYEV1|EventCondition JS eval failed|invalid owner\/item|lacks component|unknown command/i.test(text)) {
        warnings.push(text);
      }
    });
    await bootEotf(page);
    const setup = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { GameEvent } = await import('/src/events/event-manager.ts');
      const { createItemTree } = await import('/src/objects/item.ts');
      const aylaPrefab = game.db.units.get('Ayla');
      const swordPrefab = game.db.items.get('Iron_Sword');
      const eventPrefab = [...game.db.events.values()].find(
        (event: any) => event.name === 'Ability_Gods_Image',
      );
      const rawPyevNames = [...game.db.events.values()]
        .filter((event: any) => event._source?.[0]?.trim() === '#pyev1')
        .map((event: any) => event.name)
        .sort();
      if (!aylaPrefab || !swordPrefab || !eventPrefab) {
        throw new Error('Missing authored EOtF God’s Image fixtures');
      }

      for (const unit of game.units.values()) unit.items = [];
      const carrier = game.units.get('Keeper');
      carrier.position = [1, 1];
      carrier.dead = false;
      carrier.currentHp = Math.max(1, carrier.stats.HP ?? 1);
      carrier.tags = (carrier.tags ?? []).filter((tag: string) => tag !== 'Tile');
      const sword = createItemTree(swordPrefab, (nid: string) => game.db.items.get(nid));
      sword.owner = carrier;
      carrier.items.push(sword);
      game.registerItemTreeDirect(sword, `_test_candidate_${sword.uid}`);

      const ayla = game.buildUnit(aylaPrefab, 'player', 'None');
      ayla.position = null;
      game.units.set(ayla.nid, ayla);
      const vessel = ayla.items.find((item: any) => item.nid === 'False_Vessel');
      const beforeActionIndex = game.actionLog.actionIndex;
      game.gameVars.set('_random_seed', 0);
      const event = new GameEvent(eventPrefab, {
        type: 'test',
        levelNid: 'X',
        unit1: ayla,
      }, () => game);
      game.eventManager.eventQueue.push(event);
      game.state.change('event');
      return {
        vesselUid: vessel.uid,
        beforeActionIndex,
        rawPyevNames,
        sword: {
          name: sword.name,
          minRange: sword.components.get('min_range'),
          maxRange: sword.components.get('max_range'),
          weaponType: sword.components.get('weapon_type'),
        },
      };
    });
    await page.evaluate(() => (window as any).__harness.stepFrames(120, null));

    const result = await page.evaluate(({ vesselUid, beforeActionIndex }) => {
      const game = (window as any).__gameRef;
      const ayla = game.units.get('Ayla');
      const vessel = game.getItem(vesselUid);
      const child = vessel?.subitems[0] ?? null;
      const snapshot = () => child ? {
        nid: child.nid,
        uid: child.uid,
        name: child.name,
        desc: child.desc,
        ownerNid: child.owner?.nid ?? null,
        parentUid: child.parentItem?.uid ?? null,
        registered: game.getItem(child.uid) === child,
        damage: child.components.get('damage'),
        minRange: child.components.get('min_range'),
        maxRange: child.components.get('max_range'),
        weaponTypeExempt: child.components.get('weapon_type_exempt'),
      } : null;
      const applied = snapshot();
      while (game.actionLog.actionIndex > beforeActionIndex) {
        game.actionLog.runActionBackward();
      }
      const reversed = {
        childCount: vessel.subitems.length,
        registered: applied ? game.getItem(applied.uid) !== null : true,
      };
      while (game.actionLog.actionIndex < game.actionLog.actions.length - 1) {
        game.actionLog.runActionForward();
      }
      return {
        applied,
        reversed,
        redone: snapshot(),
        currentState: game.state.currentStateName,
      };
    }, setup);

    expect(warnings).toEqual([]);
    expect(setup.rawPyevNames).toEqual(['Ability_Gods_Image', 'Hide_Nikume_Python']);
    expect(result.applied).not.toBeNull();
    expect(result.applied).toMatchObject({
      nid: 'Image',
      uid: expect.any(Number),
      name: `${setup.sword.weaponType} Image`,
      ownerNid: 'Ayla',
      parentUid: setup.vesselUid,
      registered: true,
      damage: 1,
      minRange: setup.sword.minRange,
      maxRange: setup.sword.maxRange,
      weaponTypeExempt: setup.sword.weaponType,
    });
    expect(result.applied?.desc).toContain(`Copied from ${setup.sword.name}.`);
    expect(result.reversed).toEqual({ childCount: 0, registered: false });
    expect(result.redone).toEqual(result.applied);
    expect(result.currentState).not.toBe('event');
  });

  test('Hide Nikume updates boundary display state without executing its false branch', async ({ page }) => {
    const warnings: string[] = [];
    page.on('console', (message) => {
      const text = message.text();
      if (/PYEV1|unknown command/i.test(text)) warnings.push(text);
    });
    await bootEotf(page, 'Nikume');
    await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { GameEvent } = await import('/src/events/event-manager.ts');
      const eventPrefab = [...game.db.events.values()].find(
        (event: any) => event.name === 'Hide_Nikume_Python',
      );
      game.boundaryDisplayingUnits = new Set(['Nikume_E', 'Other']);
      game.boundaryResetVersion = 0;
      game.eventManager.eventQueue.push(new GameEvent(eventPrefab, {
        type: 'test',
        levelNid: 'Nikume',
      }, () => game));
      game.state.change('event');
    });
    await page.evaluate(() => (window as any).__harness.stepFrames(30, null));
    const result = await page.evaluate(() => {
      const game = (window as any).__gameRef;
      return {
        displaying: [...game.boundaryDisplayingUnits],
        resetVersion: game.boundaryResetVersion,
        currentState: game.state.currentStateName,
      };
    });
    expect(result).toEqual({
      displaying: ['Other'],
      resetVersion: 1,
      currentState: expect.not.stringMatching(/^event$/),
    });
    expect(warnings).toEqual([]);
  });
});
