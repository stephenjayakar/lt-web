/**
 * Turnwheel history survives a save/load, as in Python, where
 * game_state.save writes `'action_log': self.action_log.save()` and load
 * restores it with turnwheel.ActionLog.restore (Action.save/restore
 * serialize every attribute, game objects by nid/uid).
 *
 * Each scenario plays real turns, saves, round-trips the save through JSON
 * (the cloud store's format), loads it, checks the board matches, then
 * opens the turnwheel and rewinds to the start and confirms: the board must
 * match the state before the turns.
 */
import { test, expect, type Page } from '@playwright/test';

async function boot(page: Page, level = 'DEBUG'): Promise<void> {
  await page.goto(`/?harness=true&level=${level}&bundle=false`);
  await page.waitForFunction(() => !!(window as any).__harness?.ready, { timeout: 15000 });
  await stepFrames(page, 5);
}

async function stepFrames(page: Page, count: number): Promise<void> {
  await page.evaluate((n) => (window as any).__harness.stepFrames(n, null), count);
}

async function press(page: Page, ...buttons: string[]): Promise<void> {
  for (const b of buttons) await page.evaluate((x) => (window as any).__harness.stepFrames(1, x), b);
}

const stackNames = (page: Page) =>
  page.evaluate(() => (window as any).__gameRef.state.getStackNames() as string[]);

async function settleToFree(page: Page, pressSelect = true): Promise<void> {
  await stepFrames(page, 3);
  // The level-up screen runs on wall-clock time, so let real time pass too.
  for (let i = 0; i < 400 && (await stackNames(page)).at(-1) !== 'free'; i++) {
    if (pressSelect && i % 2 === 0) await press(page, 'SELECT');
    await stepFrames(page, 10);
    await page.waitForTimeout(40);
  }
  expect((await stackNames(page)).at(-1)).toBe('free');
}

async function openUnitMenu(page: Page, nid: string, dest?: [number, number]): Promise<void> {
  await page.evaluate((unitNid) => {
    const g = (window as any).__gameRef;
    const u = g.getUnit(unitNid);
    g.cursor.setPos(u.position[0], u.position[1]);
  }, nid);
  await press(page, 'SELECT');
  await stepFrames(page, 2);
  if (dest) await page.evaluate((d) => (window as any).__gameRef.cursor.setPos(d[0], d[1]), dest);
  await press(page, 'SELECT');
  for (let i = 0; i < 30 && (await stackNames(page)).at(-1) !== 'menu'; i++) await stepFrames(page, 3);
  await stepFrames(page, 3);
}

async function chooseMenuLabel(page: Page, label: string): Promise<void> {
  const ok = await page.evaluate((wanted) => {
    const s = (window as any).__gameRef.state.getCurrentState() as any;
    const menu = s.confirm ?? s.child ?? s.menu;
    const index = menu?.options?.findIndex((o: any) => o.label === wanted) ?? -1;
    if (index < 0) return JSON.stringify([(window as any).__gameRef.state.getStackNames(), menu?.options?.map((o: any) => o.label)]);
    menu.selectedIndex = index;
    return true;
  }, label);
  expect(ok, `menu option ${label}`).toBe(true);
  await press(page, 'SELECT');
  await stepFrames(page, 3);
}

/** Board state compared before/after: everything the turnwheel restores. */
async function capture(page: Page): Promise<unknown> {
  return page.evaluate(() => {
    const g = (window as any).__gameRef;
    const units = [...g.units.values()].map((u: any) => ({
      nid: u.nid,
      team: u.team,
      position: u.position ? [...u.position] : null,
      hp: u.currentHp,
      exp: u.exp,
      level: u.level,
      stats: { ...u.stats },
      dead: !!u.dead,
      finished: !!u.finished,
      items: u.items.map((i: any) => [i.nid, i.uses, i.uid]),
      skills: u.skills.map((s: any) => s.nid).sort(),
    })).sort((a: any, b: any) => a.nid.localeCompare(b.nid));
    const convoy = [...g.parties.values()].map((p: any) => [p.nid, p.convoy.map((i: any) => i.nid)]);
    return { units, convoy, turn: g.turnCount };
  });
}

/** Save, round-trip through JSON (as the cloud store does), and load. */
async function saveAndReload(page: Page): Promise<{ saved: number; dropped: number; restored: number }> {
  return page.evaluate(async () => {
    const h = (window as any).__harness;
    const g = (window as any).__gameRef;
    const dict = JSON.parse(JSON.stringify(h.saveSnapshot()));
    const ok = await h.loadSnapshot(dict);
    if (!ok) throw new Error('load failed');
    return { saved: dict.actionLog.actions.length, dropped: dict.actionLog.dropped, restored: g.actionLog.getLength() };
  });
}

/**
 * Open the turnwheel (event-style), rewind as far as it goes, confirm.
 * `requireFarPast` also checks it reached the first free action.
 */
async function rewindToStart(page: Page, requireFarPast = true): Promise<void> {
  await page.evaluate(() => {
    const g = (window as any).__gameRef;
    g.memory.set('event_turnwheel', true);
    g.state.change('turnwheel');
  });
  await stepFrames(page, 5);
  for (let i = 0; i < 80; i++) {
    if (await page.evaluate(() => (window as any).__gameRef.actionLog.atFarPast())) break;
    await press(page, 'LEFT');
    await stepFrames(page, 4);
  }
  if (requireFarPast) {
    expect(await page.evaluate(() => (window as any).__gameRef.actionLog.atFarPast())).toBe(true);
  }
  await press(page, 'SELECT');
  await stepFrames(page, 80);
  expect((await stackNames(page)).at(-1)).toBe('free');
}

/** Mark the current point as the turnwheel's far past (after test setup). */
async function startRecordingHere(page: Page): Promise<void> {
  await page.evaluate(() => (window as any).__gameRef.actionLog.setFirstFreeAction());
}

test.describe('turnwheel history across save/load', () => {
  test('move + combat with exp and a level-up rewinds after a reload', async ({ page }) => {
    await boot(page);
    await page.evaluate(() => {
      const g = (window as any).__gameRef;
      g.getUnit('Eirika').exp = 99;
      (window as any).__harness.setConstant('rng_mode', 'grandmaster');
    });
    await startRecordingHere(page);
    const before = await capture(page);
    await openUnitMenu(page, 'Eirika');
    await chooseMenuLabel(page, 'Attack');
    await settleToFree(page);
    const after = await capture(page) as any;
    const eirika = after.units.find((u: any) => u.nid === 'Eirika');
    expect(eirika.level, 'the attack levels Eirika up').toBeGreaterThan(
      (before as any).units.find((u: any) => u.nid === 'Eirika').level);

    const counts = await saveAndReload(page);
    expect(counts.dropped).toBe(0);
    expect(counts.restored).toBe(counts.saved);
    expect(await capture(page)).toEqual(after);

    await rewindToStart(page);
    expect(await capture(page)).toEqual(before);
  });

  test('trade and item use rewind after a reload', async ({ page }) => {
    await boot(page);
    await page.evaluate(() => {
      const h = (window as any).__harness;
      const g = (window as any).__gameRef;
      h.giveItem('Seth', 'Vulnerary');
      g.getUnit('Seth').currentHp = 5;
    });
    await startRecordingHere(page);
    const before = await capture(page);

    // Trade: Vanessa swaps an item with Moulder, then waits.
    await openUnitMenu(page, 'Vanessa');
    await chooseMenuLabel(page, 'Trade');
    await press(page, 'SELECT'); // targeting: confirm the partner
    await stepFrames(page, 2);
    await press(page, 'SELECT');
    await press(page, 'SELECT');
    await stepFrames(page, 2);
    await press(page, 'BACK');
    await stepFrames(page, 3);
    await chooseMenuLabel(page, 'Wait');
    await settleToFree(page, false);

    // Item use: Seth drinks the Vulnerary.
    await openUnitMenu(page, 'Seth');
    await chooseMenuLabel(page, 'Item');
    const picked = await page.evaluate(() => {
      const s = (window as any).__gameRef.state.getCurrentState() as any;
      const menu = s.menu ?? s.child;
      const index = menu.options.findIndex((o: any) => String(o.label ?? o.item?.name ?? '').includes('Vulnerary') || o.value?.nid === 'Vulnerary' || o.item?.nid === 'Vulnerary');
      if (index < 0) return false;
      menu.selectedIndex = index;
      return true;
    });
    expect(picked).toBe(true);
    await press(page, 'SELECT');
    await stepFrames(page, 3);
    await chooseMenuLabel(page, 'Use');
    await settleToFree(page);

    const after = await capture(page) as any;
    const seth = after.units.find((u: any) => u.nid === 'Seth');
    expect(seth.hp).toBeGreaterThan(5);
    expect(after).not.toEqual(before);

    const counts = await saveAndReload(page);
    expect(counts.dropped).toBe(0);
    expect(await capture(page)).toEqual(after);
    await rewindToStart(page);
    expect(await capture(page)).toEqual(before);
  });

  test('event add_unit / give_item / remove_unit rewind after a reload', async ({ page }) => {
    await boot(page);
    await startRecordingHere(page);
    const before = await capture(page);
    // The turnwheel steps over action groups, so (as in Python) actions an
    // event takes after a unit's turn rewind as that turn's trailing group.
    await openUnitMenu(page, 'Eirika');
    await chooseMenuLabel(page, 'Wait');
    await settleToFree(page, false);
    await page.evaluate(() => {
      const g = (window as any).__gameRef;
      g.db.events.set('tw_save_event', {
        name: 'tw_save_event', nid: 'tw_save_event', trigger: 'tw_save_event',
        level_nid: g.currentLevel?.nid ?? null, condition: 'True', only_once: false, priority: 0,
        _source: [
          'make_generic;tw_generic;Fighter;3;enemy',
          'add_unit;tw_generic;7,7;immediate',
          'give_item;Eirika;Iron_Axe',
          'give_item;Seth;Elixir',
          'remove_unit;Moulder;immediate',
          'set_current_hp;Seth;10',
        ],
      });
      g.eventManager.triggerSpecific('tw_save_event', { type: 'tw_save_event' }, true);
      g.state.change('event');
    });
    await settleToFree(page);
    const after = await capture(page) as any;
    expect(after.units.find((u: any) => u.nid === 'tw_generic')?.position).toEqual([7, 7]);
    expect(after.units.find((u: any) => u.nid === 'Moulder')?.position).toBeNull();
    expect(after.units.find((u: any) => u.nid === 'Eirika').items.map((i: any) => i[0])).toContain('Iron_Axe');

    const counts = await saveAndReload(page);
    expect(counts.dropped).toBe(0);
    expect(await capture(page)).toEqual(after);
    await rewindToStart(page);
    const rewound = await capture(page) as any;
    // The generic is unregistered again by the rewind (as in Python).
    expect(rewound).toEqual(before);
  });

  test('a save without an action log (pre-1.1.0) loads with an empty turnwheel', async ({ page }) => {
    await boot(page);
    await openUnitMenu(page, 'Eirika');
    await chooseMenuLabel(page, 'Wait');
    await settleToFree(page, false);
    const result = await page.evaluate(async () => {
      const h = (window as any).__harness;
      const g = (window as any).__gameRef;
      const dict = JSON.parse(JSON.stringify(h.saveSnapshot()));
      delete dict.actionLog;
      const ok = await h.loadSnapshot(dict);
      return { ok, length: g.actionLog.getLength(), canRewind: !g.actionLog.atFarPast() };
    });
    expect(result).toEqual({ ok: true, length: 0, canRewind: false });
  });

  test('cloud saves keep the turnwheel history (CloudStore with a stub client)', async ({ page }) => {
    await boot(page);
    await startRecordingHere(page);
    const before = await capture(page);
    await openUnitMenu(page, 'Seth', [5, 5]);
    await chooseMenuLabel(page, 'Wait');
    await settleToFree(page, false);
    const after = await capture(page);
    const result = await page.evaluate(async () => {
      const g = (window as any).__gameRef;
      const { CloudStore } = await import('/src/storage/cloud-store.ts');
      const storage = await import('/src/storage/storage.ts');
      const save = await import('/src/engine/save.ts');
      const writes: string[] = [];
      const client: any = {
        call: async (_kind: string, path: string, args: any) => {
          if (path === 'kv:hydrate') return [];
          if (path === 'kv:setInline') writes.push(args.key);
          return { updatedAt: Date.now() };
        },
        fetchSite: async (url: string) => {
          writes.push(url);
          return { ok: true, json: async () => ({ updatedAt: Date.now() }), text: async () => '' };
        },
      };
      const store = new CloudStore(client, 'tw-user');
      await store.hydrate();
      const previousSave = storage.getSaveStore();
      const previousSync = storage.getSyncStore();
      storage.installStores(store.saveStore(), store.syncStore());
      try {
        await save.saveGame(g, 3, 'battle');
        const savedLength = g.actionLog.getLength();
        g.actionLog.clear();
        const ok = await save.loadGame(g, 3);
        return { ok, savedLength, restored: g.actionLog.getLength(), wrote: writes.some((w) => w.includes('-3')) };
      } finally {
        storage.installStores(previousSave, previousSync);
      }
    });
    expect(result.ok).toBe(true);
    expect(result.wrote).toBe(true);
    expect(result.restored).toBe(result.savedLength);
    expect(await capture(page)).toEqual(after);
    await rewindToStart(page);
    expect(await capture(page)).toEqual(before);
  });
});

test.describe('turnwheel history across save/load: AI phase', () => {
  test('an enemy phase and turn change save without loss and save again identically', async ({ page }) => {
    await boot(page);
    await startRecordingHere(page);
    const before = await capture(page);
    // A player turn first, so the turnwheel has a group to rewind to (it
    // cannot be confirmed inside the locked enemy phase).
    await openUnitMenu(page, 'Seth');
    await chooseMenuLabel(page, 'Wait');
    await settleToFree(page, false);
    // End the player phase from the option menu (SELECT on an empty tile).
    await page.evaluate(() => {
      const g = (window as any).__gameRef;
      for (let y = 0; y < g.board.height; y++) {
        for (let x = 0; x < g.board.width; x++) {
          if (!g.board.getUnit(x, y)) { g.cursor.setPos(x, y); return; }
        }
      }
    });
    await press(page, 'SELECT');
    await stepFrames(page, 5);
    await chooseMenuLabel(page, 'End');
    // Let the enemy phase play out and control return to the player.
    for (let i = 0; i < 300; i++) {
      const state = await page.evaluate(() => {
        const g = (window as any).__gameRef;
        return [g.state.getStackNames().at(-1), g.phase?.getCurrent?.(), g.turnCount];
      });
      if (state[0] === 'free' && state[1] === 'player' && state[2] === 2) break;
      if (i % 3 === 0) await press(page, 'SELECT');
      await stepFrames(page, 10);
      await page.waitForTimeout(20);
    }
    const after = await capture(page) as any;
    expect(after.turn).toBe(2);

    const saved = await page.evaluate(() => JSON.stringify((window as any).__harness.saveSnapshot()));
    const types = await page.evaluate(() =>
      [...new Set((window as any).__gameRef.actionLog.getActions().map((a: any) => a.constructor.name))]);
    expect(types).toContain('IncrementTurnAction');

    // Control: rewind without a reload.
    await rewindToStart(page);
    const control = await capture(page);
    expect(control).toEqual(before);

    const result = await page.evaluate(async (json) => {
      const h = (window as any).__harness;
      const g = (window as any).__gameRef;
      const { saveActionLog } = await import('/src/engine/action-serialization.ts');
      const first = JSON.parse(json);
      const ok = await h.loadSnapshot(first);
      const second = JSON.stringify(saveActionLog(g, g.actionLog));
      return { ok, dropped: first.actionLog.dropped, same: second === JSON.stringify(first.actionLog) };
    }, saved);
    expect(result.ok).toBe(true);
    expect(result.dropped).toBe(0);
    expect(result.same, 'restoring and saving again reproduces the saved log').toBe(true);
    expect(await capture(page)).toEqual(after);
    await rewindToStart(page);
    expect(await capture(page)).toEqual(control);
  });
});

/** Undo (reverse) every action after `index`, newest first. */
async function undoBackTo(page: Page, index: number): Promise<void> {
  await page.evaluate((stop) => {
    const g = (window as any).__gameRef;
    while (g.actionLog.getLength() - 1 > stop) g.actionLog.undo();
  }, index);
}

test.describe('turnwheel history across save/load: action coverage', () => {
  test('a sweep of reversible event commands restores and reverses like the live log', async ({ page }) => {
    await boot(page);
    const start = await page.evaluate(() => (window as any).__gameRef.actionLog.getLength() - 1);
    const before = await capture(page);
    await page.evaluate(() => {
      const g = (window as any).__gameRef;
      g.db.events.set('tw_sweep', {
        name: 'tw_sweep', nid: 'tw_sweep', trigger: 'tw_sweep', level_nid: g.currentLevel?.nid ?? null,
        condition: 'True', only_once: false, priority: 0,
        _source: [
          'give_skill;Eirika;Canto', 'remove_skill;Eirika;Canto', 'give_money;500', 'give_bexp;100',
          'set_stats;Seth;STR,3', 'give_exp;Seth;50', 'add_tag;Seth;Boss', 'remove_tag;Seth;Boss',
          'change_team;Moulder;other', 'change_ai;Bone;None', 'set_current_hp;Bone;1',
          'add_region;tw_reg;3,3;event;Visit', 'remove_region;tw_reg', 'game_var;tw_v;5', 'level_var;tw_l;7',
          'kill_unit;Bone', 'resurrect;Bone', 'change_class;101;Sage', 'give_item;convoy;Iron_Sword',
          'remove_item;Eirika;Rapier', 'set_item_uses;Seth;Silver_Lance;3', 'add_lore;Ephraim',
        ],
      });
      g.eventManager.triggerSpecific('tw_sweep', { type: 'tw_sweep' }, true);
      g.state.change('event');
    });
    await settleToFree(page);
    const after = await capture(page);
    const saved = await page.evaluate(() => JSON.stringify((window as any).__harness.saveSnapshot()));

    await undoBackTo(page, start);
    const control = await capture(page);
    expect(control).toEqual(before);

    const result = await page.evaluate(async (json) => {
      const h = (window as any).__harness;
      const g = (window as any).__gameRef;
      const { saveActionLog } = await import('/src/engine/action-serialization.ts');
      const dict = JSON.parse(json);
      const ok = await h.loadSnapshot(dict);
      return {
        ok,
        dropped: dict.actionLog.dropped,
        same: JSON.stringify(saveActionLog(g, g.actionLog)) === JSON.stringify(dict.actionLog),
        types: [...new Set(g.actionLog.getActions().map((a: any) => a.constructor.name))],
      };
    }, saved);
    expect(result).toMatchObject({ ok: true, dropped: 0, same: true });
    for (const type of ['AddSkillAction', 'RemoveSkillAction', 'SetUnitExpAction', 'ChangeTeamAction',
      'AddRegionAction', 'RemoveRegionAction', 'DeathAction', 'ResurrectAction', 'ClassChangeAction',
      'PutItemInConvoy', 'RemoveItemFromUnitAction', 'SetItemUsesAction']) {
      expect(result.types).toContain(type);
    }
    expect(await capture(page)).toEqual(after);
    await undoBackTo(page, start);
    expect(await capture(page)).toEqual(control);
  });

  test('an EOtF enemy phase (fork AI, skills, combat) round-trips without loss', async ({ page }) => {
    await page.goto('/?harness=true&project=eotf.ltproj&level=Grigol&clean=true&bundle=false');
    await page.waitForFunction(() => (window as any).__harness?.ready === true, undefined, { timeout: 60_000 });
    const result = await page.evaluate(async () => {
      const h = (window as any).__harness;
      const g = (window as any).__gameRef;
      // Put player units beside four enemies so the AI phase fights.
      const enemies = [...g.units.values()].filter((u: any) => u.position && u.team === 'enemy').slice(0, 4) as any[];
      const names = [...g.db.units.keys()].slice(0, 12);
      let next = 0;
      for (const enemy of enemies) {
        const [x, y] = enemy.position;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          if (!g.board.checkBounds(x + dx, y + dy) || g.board.getUnit(x + dx, y + dy)) continue;
          while (next < names.length && g.units.get(names[next])) next++;
          const prefab = g.db.units.get(names[next]);
          if (prefab) g.spawnUnit(prefab, 'player', [x + dx, y + dy], 'None');
          next++;
          break;
        }
      }
      await g.loadAllMapSprites?.();
      const fought = () => g.actionLog.getActions().some((a: any) => a.constructor.name === 'CombatResultAction');
      for (let k = 0; k < 800 && !(fought() && g.state.getStackNames().at(-1) === 'free'); k++) {
        h.stepFrames(10, k % 3 === 0 ? 'SELECT' : null);
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      const { saveActionLog } = await import('/src/engine/action-serialization.ts');
      const dict = JSON.parse(JSON.stringify(h.saveSnapshot()));
      const types = [...new Set(g.actionLog.getActions().map((a: any) => a.constructor.name))];
      const ok = await h.loadSnapshot(dict);
      return {
        ok,
        turn: g.turnCount,
        dropped: dict.actionLog.dropped,
        restored: g.actionLog.getLength() === dict.actionLog.actions.length,
        same: JSON.stringify(saveActionLog(g, g.actionLog)) === JSON.stringify(dict.actionLog),
        types,
      };
    });
    expect(result).toMatchObject({ ok: true, dropped: 0, restored: true, same: true });
    expect(result.turn).toBeGreaterThanOrEqual(2);
    expect(result.types).toContain('CombatResultAction');
  });
});

test.describe('turnwheel history: title-screen loads', () => {
  test('loading a different save from the load menu replaces the action log', async ({ page }) => {
    await boot(page);
    await openUnitMenu(page, 'Eirika');
    await chooseMenuLabel(page, 'Wait');
    await settleToFree(page, false);
    const slotA = await page.evaluate(async () => {
      const g = (window as any).__gameRef;
      const save = await import('/src/engine/save.ts');
      await save.saveGame(g, 0, 'battle');
      return g.actionLog.getActions().map((a: any) => a.constructor.name);
    });
    // Slot 1: written by an older build (no action log).
    await page.evaluate(async () => {
      const g = (window as any).__gameRef;
      const save = await import('/src/engine/save.ts');
      const { getSaveStore } = await import('/src/storage/storage.ts');
      await save.saveGame(g, 1, 'battle');
      const gameNid = g.db.getConstant('game_nid', 'default');
      const store = getSaveStore();
      const dict = await store.get(`${gameNid}-1`);
      delete dict.actionLog;
      await store.set(`${gameNid}-1`, dict);
    });
    // Keep playing this session so the live log grows past both saves.
    for (const nid of ['Seth', 'Vanessa']) {
      await openUnitMenu(page, nid);
      await chooseMenuLabel(page, 'Wait');
      await settleToFree(page, false);
    }
    const session = await page.evaluate(() => (window as any).__gameRef.actionLog.getLength());
    expect(session).toBeGreaterThan(slotA.length);

    const loadFromMenu = (slot: number) => page.evaluate(async (idx) => {
      const g = (window as any).__gameRef;
      const h = (window as any).__harness;
      g.state.clear();
      g.state.change('load_menu');
      h.stepFrames(2, null);
      for (let i = 0; i < 60; i++) {
        const s = g.state.getCurrentState() as any;
        if (s?.name === 'load_menu' && !s.loading) break;
        await new Promise((r) => setTimeout(r, 0));
        h.stepFrames(1, null);
      }
      h.stepFrames(10, null);
      const state = g.state.getCurrentState() as any;
      state.selectSlot(idx);
      state.takeInput('SELECT');
      for (let i = 0; i < 100 && state.restoring; i++) await new Promise((r) => setTimeout(r, 10));
      h.stepFrames(5, null);
      return {
        types: g.actionLog.getActions().map((a: any) => a.constructor.name),
        index: g.actionLog.actionIndex,
        message: state.message ?? null,
      };
    }, slot);

    const loadedA = await loadFromMenu(0);
    expect(loadedA.message ?? '').not.toMatch(/Load failed/);
    expect(loadedA.types, 'slot 0 brings back exactly its own history').toEqual(slotA);
    expect(loadedA.index).toBe(slotA.length - 1);

    const loadedOld = await loadFromMenu(1);
    // A pre-1.1.0 save starts with an empty history; FreeState.begin then
    // drops its usual turnwheel anchor into the empty log.
    expect(loadedOld.types, 'none of the session or slot 0 history leaks in').toEqual(['MarkActionGroupEnd']);

    await page.evaluate(async () => {
      const g = (window as any).__gameRef;
      const save = await import('/src/engine/save.ts');
      const gameNid = g.db.getConstant('game_nid', 'default');
      await save.deleteSave(gameNid, 0);
      await save.deleteSave(gameNid, 1);
    });
  });
});
