/**
 * Save-field parity closeout (docs/parity/runtime-inventory.md §4).
 *
 * Covers the two previously-missing save fields that had a live runtime
 * representation in the web port and were closed by this slice:
 *
 *  - Unit `current_mana` (unit.py:924) — set via the `set_current_mana`
 *    event command (already wired in game-states.ts) as a dynamic
 *    `currentMana` property, consumed by item-system.ts mana-cost checks.
 *    Now persisted/restored in save.ts; legacy saves (no `currentMana`
 *    field) restore with the property left unset, matching prior behavior
 *    (item-system falls back to the MANA equation).
 *
 *  - GameState `talk_hidden` (game_state.py:425) — the `hide_talk` /
 *    `unhide_talk` event commands were previously no-ops ("not yet tracked
 *    visually"). This slice adds an EventManager-backed hidden-pair set,
 *    wires the commands to it, filters it into the map Talk-option menu,
 *    and persists it in save.ts. Legacy saves (no `talkHidden` field)
 *    restore with an empty hidden set.
 */

import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';

async function waitForHarness(page: Page): Promise<void> {
  await page.waitForFunction(() => !!(window as any).__harness?.ready, { timeout: 15000 });
}

async function stepFrames(page: Page, count: number): Promise<void> {
  await page.evaluate((count) => (window as any).__harness.stepFrames(count, null), count);
}

async function saveSnapshot(page: Page): Promise<any> {
  return page.evaluate(() => (window as any).__harness.saveSnapshot());
}

async function loadSnapshot(page: Page, snapshot: any): Promise<boolean> {
  return page.evaluate((snap) => (window as any).__harness.loadSnapshot(snap), snapshot);
}

test.describe('Save-field parity closeout', () => {
  test('unit current_mana round-trips through save/load', async ({ page }) => {
    await page.goto('/?harness=true&level=DEBUG&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 5);

    await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const eirika = g?.units?.get?.('Eirika');
      if (eirika) (eirika as any).currentMana = 7;
    });

    const before = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      return (g?.units?.get?.('Eirika') as any)?.currentMana;
    });
    expect(before).toBe(7);

    const snapshot = await saveSnapshot(page);

    // Mutate runtime state so the load is observable.
    await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const eirika = g?.units?.get?.('Eirika');
      if (eirika) (eirika as any).currentMana = 0;
    });

    const loaded = await loadSnapshot(page, snapshot);
    expect(loaded).toBe(true);
    await stepFrames(page, 2);

    const after = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      return (g?.units?.get?.('Eirika') as any)?.currentMana;
    });
    expect(after).toBe(7);
  });

  test('legacy save without currentMana field restores unit with no dynamic mana set', async ({ page }) => {
    await page.goto('/?harness=true&level=DEBUG&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 5);

    const snapshot = await saveSnapshot(page);
    const legacy = JSON.parse(JSON.stringify(snapshot));
    for (const u of legacy.units) delete u.currentMana;

    const loaded = await loadSnapshot(page, legacy);
    expect(loaded).toBe(true);
    await stepFrames(page, 2);

    const after = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      return (g?.units?.get?.('Eirika') as any)?.currentMana;
    });
    expect(after).toBeUndefined();
  });

  test('talk_hidden pair round-trips through save/load and suppresses the Talk menu option', async ({ page }) => {
    await page.goto('/?harness=true&level=DEBUG&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 5);

    const hiddenBefore = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      g.eventManager.hideTalk('Eirika', 'Seth');
      return g.eventManager.isTalkHidden('Eirika', 'Seth');
    });
    expect(hiddenBefore).toBe(true);

    const snapshot = await saveSnapshot(page);

    // Mutate runtime state so the load is observable.
    await page.evaluate(() => {
      const g = (window as any).__gameRef;
      g.eventManager.unhideTalk('Eirika', 'Seth');
    });
    const clearedBeforeLoad = await page.evaluate(() =>
      (window as any).__gameRef.eventManager.isTalkHidden('Eirika', 'Seth'));
    expect(clearedBeforeLoad).toBe(false);

    const loaded = await loadSnapshot(page, snapshot);
    expect(loaded).toBe(true);
    await stepFrames(page, 2);

    const hiddenAfter = await page.evaluate(() =>
      (window as any).__gameRef.eventManager.isTalkHidden('Eirika', 'Seth'));
    expect(hiddenAfter).toBe(true);

    // Reciprocal lookup (order-independent).
    const hiddenReciprocal = await page.evaluate(() =>
      (window as any).__gameRef.eventManager.isTalkHidden('Seth', 'Eirika'));
    expect(hiddenReciprocal).toBe(true);
  });

  test('legacy save without talkHidden field restores with an empty hidden set', async ({ page }) => {
    await page.goto('/?harness=true&level=DEBUG&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 5);

    const snapshot = await saveSnapshot(page);
    const legacy = JSON.parse(JSON.stringify(snapshot));
    delete legacy.talkHidden;

    const loaded = await loadSnapshot(page, legacy);
    expect(loaded).toBe(true);
    await stepFrames(page, 2);

    const hidden = await page.evaluate(() =>
      (window as any).__gameRef.eventManager.isTalkHidden('Eirika', 'Seth'));
    expect(hidden).toBe(false);
  });

  test('initiative, roam, fog, and overworld runtime state round-trip together', async ({ page }) => {
    await page.goto('/?harness=true&level=DEBUG&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 5);

    const snapshot = await page.evaluate(async () => {
      const g = (window as any).__gameRef;
      const { InitiativeTracker } = await import('/src/engine/initiative.ts');
      const { OverworldManager } = await import('/src/engine/overworld/overworld-manager.ts');
      const prefab = {
        nid: 'SaveTestOverworld',
        name: 'Save Test',
        tilemap: null,
        music: null,
        border_tile_width: 0,
        overworld_nodes: [
          {
            nid: 'NodeA',
            name: 'Node A',
            pos: [1, 2],
            icon: '',
            level: null,
            menu_options: [{
              nid: 'TestOption',
              event: null,
              option_name: 'Test',
              visible: true,
              enabled: true,
            }],
          },
          {
            nid: 'NodeB',
            name: 'Node B',
            pos: [5, 6],
            icon: '',
            level: null,
            menu_options: [],
          },
        ],
        map_paths: { 'NodeA-NodeB': [[1, 2], [5, 6]] },
      };
      g.db.overworlds.set(prefab.nid, prefab);
      const overworld = new OverworldManager(prefab);
      overworld.enabledNodes.add('NodeA');
      overworld.enabledRoads.add('NodeA-NodeB');
      overworld.createEntity('TestParty', 'unit', 'Eirika', 'player', 'NodeA');
      overworld.selectEntity('TestParty');
      overworld.toggleMenuOptionEnabled('NodeA', 'TestOption', false);
      overworld.setNodeProperty('NodeA', 'visited');
      overworld.nextLevel = 'DEBUG';
      g.overworldController = overworld;

      const initiative = new InitiativeTracker();
      initiative.unitLine = ['Seth', 'Eirika'];
      initiative.initiativeLine = [17, 11];
      initiative.currentIdx = 1;
      initiative.drawMe = false;
      g.initiative = initiative;
      g.roamInfo.roam = true;
      g.roamInfo.roamUnitNid = 'Eirika';
      g.levelVars.set('_fog_of_war', true);
      g.levelVars.set('_fog_of_war_radius', 4);
      return (window as any).__harness.saveSnapshot();
    });

    await page.evaluate(() => {
      const g = (window as any).__gameRef;
      g.initiative.clear();
      g.roamInfo.roam = false;
      g.roamInfo.roamUnitNid = null;
      g.levelVars.delete('_fog_of_war');
      g.overworldController = null;
    });
    expect(await loadSnapshot(page, snapshot)).toBe(true);
    const restored = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const ow = g.overworldController;
      return {
        initiative: {
          units: [...g.initiative.unitLine],
          values: [...g.initiative.initiativeLine],
          currentIdx: g.initiative.currentIdx,
          drawMe: g.initiative.drawMe,
        },
        roam: { roam: g.roamInfo.roam, unit: g.roamInfo.roamUnitNid },
        fog: {
          active: g.levelVars.get('_fog_of_war'),
          radius: g.levelVars.get('_fog_of_war_radius'),
        },
        overworld: {
          prefab: ow?.prefab?.nid,
          nodes: [...(ow?.enabledNodes ?? [])],
          roads: [...(ow?.enabledRoads ?? [])],
          selected: ow?.selectedPartyNid,
          entity: ow?.entities.get('TestParty'),
          option: ow?.enabledMenuOptions.get('NodeA')?.get('TestOption'),
          properties: [...(ow?.nodeProperties.get('NodeA') ?? [])],
          nextLevel: ow?.nextLevel,
        },
      };
    });
    expect(restored).toEqual({
      initiative: {
        units: ['Seth', 'Eirika'],
        values: [17, 11],
        currentIdx: 1,
        drawMe: false,
      },
      roam: { roam: true, unit: 'Eirika' },
      fog: { active: true, radius: 4 },
      overworld: {
        prefab: 'SaveTestOverworld',
        nodes: ['NodeA'],
        roads: ['NodeA-NodeB'],
        selected: 'TestParty',
        entity: {
          nid: 'TestParty',
          dtype: 'unit',
          dnid: 'Eirika',
          onNode: 'NodeA',
          team: 'player',
          displayPosition: [1, 2],
        },
        option: false,
        properties: ['visited'],
        nextLevel: 'DEBUG',
      },
    });
  });

  test('an in-progress event queue and state stack resume after load', async ({ page }) => {
    await page.goto('/?harness=true&level=DEBUG&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 5);
    await page.evaluate(async () => {
      const g = (window as any).__gameRef;
      const { GameEvent } = await import('/src/events/event-manager.ts');
      const prefab = {
        nid: 'SaveInProgressEvent',
        name: 'Save In Progress',
        trigger: 'test',
        level_nid: 'DEBUG',
        condition: '',
        only_once: false,
        priority: 0,
        _source: [
          'game_var;before_save;done',
          'wait;1000',
          'game_var;after_load;done',
        ],
      };
      g.db.events.set(prefab.nid, prefab);
      const triggerUnit = [...g.units.values()][0];
      g.eventManager.eventQueue.push(new GameEvent(prefab, {
        type: 'test',
        levelNid: 'DEBUG',
        unit1: triggerUnit,
        localArgs: new Map([['nested', { unit: triggerUnit }]]),
      }, () => g));
      g.state.change('event');
    });
    await stepFrames(page, 4);
    const before = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      return {
        before: g.gameVars.get('before_save'),
        after: g.gameVars.get('after_load'),
        pointer: g.eventManager.getCurrentEvent()?.commandPointer,
        state: g.state.getCurrentState()?.name,
      };
    });
    expect(before).toEqual({
      before: 'done',
      after: undefined,
      pointer: 1,
      state: 'event',
    });
    const eventSnapshot = await saveSnapshot(page);
    await page.evaluate(() => {
      const g = (window as any).__gameRef;
      g.gameVars.delete('before_save');
      g.eventManager.eventQueue = [];
    });
    expect(await loadSnapshot(page, eventSnapshot)).toBe(true);
    const resumed = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      return {
        before: g.gameVars.get('before_save'),
        pointer: g.eventManager.getCurrentEvent()?.commandPointer,
        state: g.state.getCurrentState()?.name,
        stack: g.state.getStackNames(),
        triggerIdentity:
          g.eventManager.getCurrentEvent()?.trigger.unit1 ===
          g.units.get(g.eventManager.getCurrentEvent()?.trigger.unit1?.nid),
        nestedTriggerIdentity: (() => {
          const nested = g.eventManager.getCurrentEvent()?.trigger.localArgs?.get('nested');
          return nested?.unit === g.units.get(nested?.unit?.nid);
        })(),
      };
    });
    expect(resumed.before).toBe('done');
    expect(resumed.pointer).toBe(1);
    expect(resumed.state).toBe('event');
    expect(resumed.stack.at(-1)).toBe('event');
    expect(resumed.triggerIdentity).toBe(true);
    expect(resumed.nestedTriggerIdentity).toBe(true);
    await stepFrames(page, 80);
    const after = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      return {
        after: g.gameVars.get('after_load'),
        activeEvents: g.eventManager.eventQueue.length,
      };
    });
    expect(after).toEqual({ after: 'done', activeEvents: 0 });
  });

  test('suspend, battle, restart, deletion, and legacy defaults preserve save semantics', async ({ page }) => {
    await page.goto('/?harness=true&level=DEBUG&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 5);
    const result = await page.evaluate(async () => {
      const g = (window as any).__gameRef;
      const save = await import('/src/engine/save.ts');
      const gameNid = g.db.getConstant('game_nid', 'default');

      await save.deleteSuspend(gameNid);
      g.gameVars.set('save_semantics', 'suspend');
      await save.suspendGame(g);
      const suspendExists = await save.hasSuspend(gameNid);
      g.gameVars.set('save_semantics', 'mutated');
      const suspendLoaded = await save.loadSuspend(g);
      const suspendValue = g.gameVars.get('save_semantics');
      const suspendDeleted = !(await save.hasSuspend(gameNid));
      const suspendCannotReload = !(await save.loadSuspend(g));

      g.gameVars.set('save_semantics', 'restart');
      await save.saveGame(g, 77, 'start');
      g.gameVars.set('save_semantics', 'battle');
      await save.saveGame(g, 77, 'battle');
      g.gameVars.set('save_semantics', 'mutated');
      const restartLoaded = await save.loadRestart(g, 77);
      const restartValue = g.gameVars.get('save_semantics');
      const battleLoaded = await save.loadGame(g, 77);
      const battleValue = g.gameVars.get('save_semantics');
      const slots = await save.loadSaveSlots(gameNid, 78);
      const battleKind = slots[77].kind;

      const legacy = (window as any).__harness.saveSnapshot();
      delete legacy.initiative;
      delete legacy.overworld;
      delete legacy.eventQueue;
      delete legacy.stateStack;
      const legacyLoaded = await (window as any).__harness.loadSnapshot(legacy);

      await save.deleteSave(gameNid, 77);
      const battleDeleted = !(await save.loadGame(g, 77));
      const restartDeleted = !(await save.loadRestart(g, 77));
      return {
        suspendExists,
        suspendLoaded,
        suspendValue,
        suspendDeleted,
        suspendCannotReload,
        restartLoaded,
        restartValue,
        battleLoaded,
        battleValue,
        battleKind,
        legacyLoaded,
        battleDeleted,
        restartDeleted,
      };
    });
    expect(result).toEqual({
      suspendExists: true,
      suspendLoaded: true,
      suspendValue: 'suspend',
      suspendDeleted: true,
      suspendCannotReload: true,
      restartLoaded: true,
      restartValue: 'restart',
      battleLoaded: true,
      battleValue: 'battle',
      battleKind: 'battle',
      legacyLoaded: true,
      battleDeleted: true,
      restartDeleted: true,
    });
  });

  test('per-save records and support progress round-trip exactly', async ({ page }) => {
    await page.goto('/?harness=true&level=DEBUG&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 5);
    const snapshot = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      g.records.append('kill', 7, 'DEBUG', 'Eirika', 'Bandit');
      const pairs = g.supports.pairs;
      pairs.set('SavePair', {
        nid: 'SavePair',
        unit1Nid: 'Eirika',
        unit2Nid: 'Seth',
        points: 42,
        lockedRanks: ['A'],
        unlockedRanks: ['C', 'B'],
        pointsGainedThisChapter: 9,
        ranksGainedThisChapter: 1,
      });
      return (window as any).__harness.saveSnapshot();
    });
    await page.evaluate(() => {
      const g = (window as any).__gameRef;
      g.records.kills = [];
      const pair = g.supports.pairs.get('SavePair');
      pair.points = 0;
      pair.lockedRanks = [];
      pair.unlockedRanks = [];
      pair.pointsGainedThisChapter = 0;
      pair.ranksGainedThisChapter = 0;
    });
    expect(await loadSnapshot(page, snapshot)).toBe(true);
    const restored = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const pair = g.supports.pairs.get('SavePair');
      return {
        kills: g.records.kills,
        support: {
          points: pair.points,
          lockedRanks: pair.lockedRanks,
          unlockedRanks: pair.unlockedRanks,
          pointsGainedThisChapter: pair.pointsGainedThisChapter,
          ranksGainedThisChapter: pair.ranksGainedThisChapter,
        },
      };
    });
    expect(restored.kills).toEqual([{
      type: 'KillRecord',
      turn: 7,
      levelNid: 'DEBUG',
      killer: 'Eirika',
      killee: 'Bandit',
    }]);
    expect(restored.support).toEqual({
      points: 42,
      lockedRanks: ['A'],
      unlockedRanks: ['C', 'B'],
      pointsGainedThisChapter: 9,
      ranksGainedThisChapter: 1,
    });
  });
});
