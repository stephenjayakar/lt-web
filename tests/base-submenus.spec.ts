/**
 * tests/base-submenus.spec.ts
 *
 * Covers the P5 base submenus slice: Records, Library/Guide (lore), Sound
 * Room, and the title-screen difficulty/mode select flow. Follows the same
 * harness patterns as the achievements slice in tests/harness.spec.ts
 * (open_achievements test): push states directly on the stack, drive with
 * stepFrames, and assert on the live state object plus game model fields.
 */

import { test, expect } from '@playwright/test';

async function waitForHarness(page: any) {
  await page.waitForFunction(
    () => (window as any).__harness?.ready === true,
    { timeout: 60_000 },
  );
}

async function stepFrames(page: any, count: number, input?: string | null) {
  await page.evaluate(
    ({ count, input }: { count: number; input: string | null }) => {
      (window as any).__harness.stepFrames(count, input);
    },
    { count, input: input ?? null },
  );
}

async function getState(page: any) {
  return page.evaluate(() => (window as any).__harness.getState());
}

test.describe('Base submenus (Records / Library / Guide / Sound Room)', () => {
  test('Codex hides Library/Records/Sound Room until data exists, then reaches each', async ({ page }) => {
    await page.goto('/?harness=true&level=0&clean=true&bundle=false');
    await waitForHarness(page);

    // Baseline: no unlocked lore, no completed chapters -> Library and
    // Records are absent from the Codex menu (matches Python's
    // BaseCodexChildState.get_options gating).
    await page.evaluate(() => {
      const game = (window as any).__gameRef;
      game.unlockedLore = [];
      game.records.turnsTaken = [];
      game.state.change('base_codex');
    });
    await stepFrames(page, 3);
    const baseline = await page.evaluate(() => {
      const state = (window as any).__gameRef.state.getCurrentState() as any;
      return state.menu.options.map((o: any) => o.value);
    });
    expect(baseline).not.toContain('library');
    expect(baseline).not.toContain('records');
    // Sound Room is unconditional in default.ltproj (sound_room_in_codex=true).
    expect(baseline).toContain('sound_room');

    // Unlock lore + record two chapters worth of turns -> options appear.
    await page.evaluate(() => {
      const game = (window as any).__gameRef;
      game.unlockedLore = ['Eirika'];
      game.records.turnsTaken = [
        { type: 'TurnRecord', turn: 1, levelNid: '0' },
        { type: 'TurnRecord', turn: 3, levelNid: '1' },
      ];
      game.state.change('base_main');
      game.state.change('base_codex');
    });
    await stepFrames(page, 3);
    const populated = await page.evaluate(() => {
      const state = (window as any).__gameRef.state.getCurrentState() as any;
      return state.menu.options.map((o: any) => o.value);
    });
    expect(populated).toEqual(expect.arrayContaining(['library', 'records', 'sound_room']));
    expect(populated).not.toContain('guide'); // default.ltproj lore has no Guide-category entries

    // Reach Library.
    await page.evaluate(() => {
      const state = (window as any).__gameRef.state.getCurrentState() as any;
      state.menu.selectedIndex = state.menu.options.findIndex((o: any) => o.value === 'library');
    });
    await stepFrames(page, 1, 'SELECT');
    await stepFrames(page, 3);
    expect((await getState(page)).currentStateName).toBe('base_library');
    await stepFrames(page, 1, 'BACK');
    await stepFrames(page, 3);
    expect((await getState(page)).currentStateName).toBe('base_codex');

    // Reach Records.
    await page.evaluate(() => {
      const state = (window as any).__gameRef.state.getCurrentState() as any;
      state.menu.selectedIndex = state.menu.options.findIndex((o: any) => o.value === 'records');
    });
    await stepFrames(page, 1, 'SELECT');
    await stepFrames(page, 3);
    expect((await getState(page)).currentStateName).toBe('base_records');
    await stepFrames(page, 1, 'BACK');
    await stepFrames(page, 3);
    expect((await getState(page)).currentStateName).toBe('base_codex');

    // Reach Sound Room.
    await page.evaluate(() => {
      const state = (window as any).__gameRef.state.getCurrentState() as any;
      state.menu.selectedIndex = state.menu.options.findIndex((o: any) => o.value === 'sound_room');
    });
    await stepFrames(page, 1, 'SELECT');
    await stepFrames(page, 3);
    expect((await getState(page)).currentStateName).toBe('base_sound_room');
    await stepFrames(page, 1, 'BACK');
    await stepFrames(page, 3);
    expect((await getState(page)).currentStateName).toBe('base_codex');
  });

  test('Library browser shows only unlocked lore and supports keyboard/mouse/cancel', async ({ page }) => {
    await page.goto('/?harness=true&level=0&clean=true&bundle=false');
    await waitForHarness(page);

    await page.evaluate(() => {
      const game = (window as any).__gameRef;
      // Eirika + Seth unlocked; Ephraim (also in DB.lore) left locked.
      game.unlockedLore = ['Eirika', 'Seth'];
      game.state.change('base_library');
    });
    await stepFrames(page, 3);

    const initial = await page.evaluate(() => {
      const state = (window as any).__gameRef.state.getCurrentState() as any;
      return {
        names: state.entries.map((e: any) => e.nid),
        selectedIndex: state.selectedIndex,
      };
    });
    expect(initial.names.sort()).toEqual(['Eirika', 'Seth']);
    expect(initial.names).not.toContain('Ephraim');
    expect(initial.selectedIndex).toBe(0);

    // Keyboard navigation.
    await stepFrames(page, 1, 'DOWN');
    const afterDown = await page.evaluate(() => {
      const state = (window as any).__gameRef.state.getCurrentState() as any;
      return state.selectedIndex;
    });
    expect(afterDown).toBe(1);

    // Mouse hover selects a row.
    await page.evaluate(() => {
      const game = (window as any).__gameRef;
      game.input.mouseMoved = true;
      game.input.getGameMousePos = () => [40, 27];
    });
    await stepFrames(page, 1);
    const afterHover = await page.evaluate(() => {
      const state = (window as any).__gameRef.state.getCurrentState() as any;
      return state.selectedIndex;
    });
    expect(afterHover).toBe(0);

    // Cancel pops back to whatever pushed it (free, since we changed directly).
    await stepFrames(page, 1, 'BACK');
    await stepFrames(page, 3);
    expect((await getState(page)).currentStateName).toBe('free');
  });

  test('Records screen reflects Recordkeeper chapter turncounts and MVP stats', async ({ page }) => {
    await page.goto('/?harness=true&level=0&clean=true&bundle=false');
    await waitForHarness(page);

    const setup = await page.evaluate(() => {
      const game = (window as any).__gameRef;
      game.records.clear();
      game.records.turnsTaken = [
        { type: 'TurnRecord', turn: 1, levelNid: '0' },
        { type: 'TurnRecord', turn: 4, levelNid: '0' },
        { type: 'TurnRecord', turn: 2, levelNid: '1' },
      ];
      const firstUnit = [...game.units.values()][0];
      game.records.kills = [{ type: 'KillRecord', turn: 1, levelNid: '0', killer: firstUnit.nid, killee: 'Enemy1' }];
      game.records.damage = [
        { type: 'DamageRecord', turn: 1, levelNid: '0', dealer: firstUnit.nid, receiver: 'Enemy1', itemNid: 'Iron_Sword', overDamage: 0, damage: 12, kind: 'hit' },
      ];
      game.state.change('base_records');
      return { unitNid: firstUnit.nid };
    });
    await stepFrames(page, 3);

    const chapters = await page.evaluate(() => {
      const state = (window as any).__gameRef.state.getCurrentState() as any;
      return state.chapters;
    });
    // records.py excludes the current chapter from the top-level list;
    // only prior chapters are shown in the chapter table.
    expect(chapters.length).toBe(1);
    const byLevel = Object.fromEntries(chapters.map((c: any) => [c.levelNid, c.turncount]));
    expect(byLevel['0']).toBe(4);
    expect(byLevel['1']).toBeUndefined();

    // Switch to the MVP tab with LEFT/RIGHT.
    await stepFrames(page, 1, 'LEFT');
    const mvpTab = await page.evaluate(() => {
      const state = (window as any).__gameRef.state.getCurrentState() as any;
      return { tab: state.tab, mvps: state.mvps };
    });
    expect(mvpTab.tab).toBe('mvp');
    const topRow = mvpTab.mvps.find((m: any) => m.unitNid === setup.unitNid);
    expect(topRow).toBeTruthy();
    expect(topRow.kills).toBe(1);
    expect(topRow.damage).toBe(12);

    await stepFrames(page, 1, 'BACK');
    await stepFrames(page, 3);
    expect((await getState(page)).currentStateName).toBe('free');
  });

  test('Sound Room lists tracks and records play/stop calls through AudioManager', async ({ page }) => {
    await page.goto('/?harness=true&level=0&clean=true&bundle=false');
    await waitForHarness(page);

    await page.evaluate(() => {
      const game = (window as any).__gameRef;
      (window as any).__playedMusic = [];
      (window as any).__stoppedMusic = 0;
      game.audioManager.playMusic = (nid: string) => {
        (window as any).__playedMusic.push(nid);
        return Promise.resolve();
      };
      game.audioManager.stopMusic = () => {
        (window as any).__stoppedMusic += 1;
      };
      game.state.change('base_sound_room');
    });
    await stepFrames(page, 3);

    // Wait for the async music.json track list to load (poll via stepFrames
    // since the harness advances frames manually, not via requestAnimationFrame).
    for (let i = 0; i < 30; i++) {
      const loaded = await page.evaluate(() => {
        const state = (window as any).__gameRef.state.getCurrentState() as any;
        return state?.name === 'base_sound_room' && state.loaded === true;
      });
      if (loaded) break;
      await stepFrames(page, 1);
    }

    const trackCount = await page.evaluate(() => {
      const state = (window as any).__gameRef.state.getCurrentState() as any;
      return state.trackNids.length;
    });
    expect(trackCount).toBeGreaterThan(0);

    // SELECT plays the highlighted track.
    await stepFrames(page, 1, 'SELECT');
    const played = await page.evaluate(() => (window as any).__playedMusic.slice());
    expect(played.length).toBe(1);

    // SELECT again stops it (toggle behavior).
    await stepFrames(page, 1, 'SELECT');
    const stoppedCount = await page.evaluate(() => (window as any).__stoppedMusic);
    expect(stoppedCount).toBeGreaterThanOrEqual(1);

    // BACK restores the previous base music (or stops if none configured).
    await stepFrames(page, 1, 'BACK');
    await stepFrames(page, 3);
    expect((await getState(page)).currentStateName).toBe('free');
  });
});

test.describe('Difficulty/mode selection (title new-game flow)', () => {
  test('single-mode projects skip the picker and set game.currentMode directly', async ({ page }) => {
    await page.goto('/?harness=true&level=0&clean=true&bundle=false');
    await waitForHarness(page);

    await page.evaluate(() => {
      const game = (window as any).__gameRef;
      game.currentMode = null;
      game.state.change('title_mode');
    });
    await stepFrames(page, 3);
    const result = await page.evaluate(() => {
      const game = (window as any).__gameRef;
      return {
        state: game.state.getCurrentState()?.name ?? null,
        modeNid: game.currentMode?.nid ?? null,
        modeCount: game.db.difficultyModes.length,
      };
    });
    // default.ltproj ships exactly one ("Normal") difficulty mode, so Python's
    // TitleModeState.difficulty_choice() is false and the picker is skipped —
    // we land straight on level_select with currentMode already set.
    expect(result.modeCount).toBe(1);
    expect(result.state).toBe('level_select');
    expect(result.modeNid).toBe('Normal');

    // Back out to a known state for hygiene.
    await page.evaluate(() => (window as any).__gameRef.state.change('free'));
  });

  test('multi-mode fixture shows a navigable picker (keyboard + mouse) and stores the choice', async ({ page }) => {
    await page.goto('/?harness=true&level=0&clean=true&bundle=false');
    await waitForHarness(page);

    // Synthesize a second difficulty mode in-memory (no bundled project ships
    // more than one), then re-enter the state so its length-check branches
    // into the picker, matching Python's behavior for multi-mode projects.
    await page.evaluate(() => {
      const game = (window as any).__gameRef;
      const normal = game.db.difficultyModes[0];
      const hard = { ...normal, nid: 'Hard', name: 'Hard' };
      game.db.difficultyModes = [normal, hard];
      game.currentMode = null;
      game.state.change('title_mode');
    });
    await stepFrames(page, 3);

    const opened = await page.evaluate(() => {
      const state = (window as any).__gameRef.state.getCurrentState() as any;
      return { name: state?.name, cursor: state?.cursor, count: state?.availableModes?.length };
    });
    expect(opened.name).toBe('title_mode');
    expect(opened.count).toBe(2);
    expect(opened.cursor).toBe(0);

    // Keyboard: move down to "Hard".
    await stepFrames(page, 1, 'DOWN');
    const afterDown = await page.evaluate(() => {
      const state = (window as any).__gameRef.state.getCurrentState() as any;
      return state.cursor;
    });
    expect(afterDown).toBe(1);

    await stepFrames(page, 1, 'SELECT');
    const chosen = await page.evaluate(() => {
      const game = (window as any).__gameRef;
      return {
        state: game.state.getCurrentState()?.name ?? null,
        modeNid: game.currentMode?.nid ?? null,
      };
    });
    expect(chosen.state).toBe('level_select');
    expect(chosen.modeNid).toBe('Hard');

    // Restore db state and go back to a known state for hygiene.
    await page.evaluate(() => {
      const game = (window as any).__gameRef;
      game.db.difficultyModes = game.db.difficultyModes.filter((m: any) => m.nid !== 'Hard');
      game.state.change('free');
    });
  });

  test('BACK from the multi-mode picker returns to the previous state', async ({ page }) => {
    await page.goto('/?harness=true&level=0&clean=true&bundle=false');
    await waitForHarness(page);

    await page.evaluate(() => {
      const game = (window as any).__gameRef;
      const normal = game.db.difficultyModes[0];
      const hard = { ...normal, nid: 'Hard2', name: 'Hard2' };
      game.db.difficultyModes = [normal, hard];
      game.currentMode = null;
      game.state.change('title_mode');
    });
    await stepFrames(page, 3);
    expect((await getState(page)).currentStateName).toBe('title_mode');

    await stepFrames(page, 1, 'BACK');
    await stepFrames(page, 2);
    expect((await getState(page)).currentStateName).toBe('free');

    await page.evaluate(() => {
      const game = (window as any).__gameRef;
      game.db.difficultyModes = game.db.difficultyModes.filter((m: any) => m.nid !== 'Hard2');
    });
  });
});
