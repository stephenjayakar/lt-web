import { test, expect, type Page } from '@playwright/test';

/**
 * Zero-usage command batch 1 (P1 completeness): set_skill_data, set_mode_rng,
 * set_mode_autolevels, show_minimap, set_game_board_bounds,
 * remove_game_board_bounds, dump_vars, delete_save.
 *
 * Python references: event_functions.py:2158 (set_skill_data), :2382
 * (set_mode_rng), :2367 (set_mode_autolevels), :3532 (show_minimap), :890/:901
 * (board bounds), :3996 (dump_vars), :769 (delete_save).
 */

async function waitForHarness(page: Page): Promise<void> {
  await page.waitForFunction(() => (window as any).__harness?.ready === true, undefined, {
    timeout: 30_000,
  });
}

async function stepFrames(page: Page, n: number, input?: string): Promise<void> {
  await page.evaluate(
    ({ n, input }) => (window as any).__harness.stepFrames(n, input),
    { n, input },
  );
}

/** Install a level-scoped event and run it to completion. */
async function runEvent(page: Page, nid: string, source: string[]): Promise<void> {
  await page.evaluate(({ nid, source }) => {
    const g = (window as any).__gameRef;
    g.db.events.set(nid, {
      name: nid, nid, trigger: nid,
      level_nid: g.currentLevel?.nid ?? null,
      condition: 'True', only_once: false, priority: 0,
      _source: source,
    });
    g.eventManager.triggerSpecific(nid, { type: nid }, true);
    g.state.change('event');
  }, { nid, source });
  await stepFrames(page, 30);
}

async function boot(page: Page): Promise<void> {
  await page.goto('/?harness=true&level=0&clean=true&bundle=false');
  await waitForHarness(page);
  await stepFrames(page, 3);
}

test.describe('Event command batch 3 (zero-usage completeness)', () => {
  test('set_skill_data sets a skill data key reversibly', async ({ page }) => {
    await boot(page);
    // Prologue Eirika starts skill-less; grant one from the DB first.
    const skillNid = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      return [...g.db.skills.keys()][0] ?? null;
    });
    expect(skillNid).not.toBeNull();
    await runEvent(page, 'TestGrantSkill', [`give_skill;Eirika;${skillNid};no_banner`]);
    const hasSkill = await page.evaluate(
      (nid: string) => !!(window as any).__gameRef.units.get('Eirika').skills.find((s: any) => s.nid === nid),
      skillNid,
    );
    expect(hasSkill).toBe(true);
    await runEvent(page, 'TestSetSkillData', [
      `set_skill_data;Eirika;${skillNid};charge;5`,
    ]);
    const result = await page.evaluate((skillNid: string) => {
      const g = (window as any).__gameRef;
      const skill = g.units.get('Eirika').skills.find((s: any) => s.nid === skillNid);
      const value = skill.data.get('charge');
      const undone = (window as any).__harness.turnwheelUndo();
      const afterUndo = skill.data.has('charge');
      return { value, undone, afterUndo };
    }, skillNid);
    expect(result.value).toBe(5);
    expect(result.undone).toBe(true);
    expect(result.afterUndo).toBe(false);
  });

  test('set_mode_rng changes the difficulty mode rng and rejects invalid options', async ({ page }) => {
    await boot(page);
    await runEvent(page, 'TestSetRng', ['set_mode_rng;grandmaster']);
    let mode = await page.evaluate(() => (window as any).__gameRef.currentMode?.rng_mode);
    expect(mode).toBe('grandmaster');
    await runEvent(page, 'TestSetRngBad', ['set_mode_rng;bogus_mode']);
    mode = await page.evaluate(() => (window as any).__gameRef.currentMode?.rng_mode);
    expect(mode).toBe('grandmaster'); // unchanged on invalid input
  });

  test('set_mode_autolevels routes hidden/boss flags to the right fields', async ({ page }) => {
    await boot(page);
    await runEvent(page, 'TestAutolevels', [
      'set_mode_autolevels;3',
      'set_mode_autolevels;4;hidden',
      'set_mode_autolevels;5;boss',
      'set_mode_autolevels;6;hidden;boss',
    ]);
    const m = await page.evaluate(() => {
      const cm = (window as any).__gameRef.currentMode;
      return {
        enemyTrue: cm.enemyTruelevels,
        enemyAuto: cm.enemyAutolevels,
        bossTrue: cm.bossTruelevels,
        bossAuto: cm.bossAutolevels,
      };
    });
    expect(m).toEqual({ enemyTrue: 3, enemyAuto: 4, bossTrue: 5, bossAuto: 6 });
  });

  test('show_minimap blocks the event on the minimap state and resumes on close', async ({ page }) => {
    await boot(page);
    await page.evaluate(() => {
      const g = (window as any).__gameRef;
      g.db.events.set('TestMinimap', {
        name: 'TestMinimap', nid: 'TestMinimap', trigger: 'TestMinimap',
        level_nid: g.currentLevel?.nid ?? null,
        condition: 'True', only_once: false, priority: 0,
        _source: ['show_minimap', 'game_var;after_minimap;yes'],
      });
      g.eventManager.triggerSpecific('TestMinimap', { type: 'TestMinimap' }, true);
      g.state.change('event');
    });
    await stepFrames(page, 25); // let the minimap arrive transition finish
    const mid = await page.evaluate(() => ({
      state: (window as any).__gameRef.state.getCurrentState()?.name,
      after: (window as any).__gameRef.gameVars.get('after_minimap'),
    }));
    expect(mid.state).toBe('minimap');
    expect(mid.after).toBeUndefined();
    // Close the minimap; the event should resume and run the next command.
    await stepFrames(page, 1, 'BACK');
    await stepFrames(page, 40); // exit transition + event resume
    const after = await page.evaluate(() => (window as any).__gameRef.gameVars.get('after_minimap'));
    expect(after).toBe('yes');
  });

  test('set_game_board_bounds restricts movement and undoes; remove restores natural bounds', async ({ page }) => {
    await boot(page);
    const before = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      return { bounds: [...g.board.bounds], moves: (window as any).__harness ? g.pathSystem?.getValidMoves?.(g.units.get('Eirika'), g.board)?.length ?? -1 : -1 };
    });
    await runEvent(page, 'TestBounds', ['set_game_board_bounds;0;0;3;3']);
    const constrained = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const moves = g.pathSystem?.getValidMoves?.(g.units.get('Eirika'), g.board) ?? [];
      return {
        bounds: [...g.board.bounds],
        outOfBounds: moves.filter((m: [number, number]) => m[0] > 3 || m[1] > 3).length,
      };
    });
    expect(constrained.bounds).toEqual([0, 0, 3, 3]);
    expect(constrained.outOfBounds).toBe(0);
    // Turnwheel undo restores the previous bounds.
    const undone = await page.evaluate(() => {
      const ok = (window as any).__harness.turnwheelUndo();
      return { ok, bounds: [...(window as any).__gameRef.board.bounds] };
    });
    expect(undone.ok).toBe(true);
    expect(undone.bounds).toEqual(before.bounds);
    // And remove_game_board_bounds resets to natural after another set.
    await runEvent(page, 'TestBounds2', [
      'set_game_board_bounds;1;1;4;4',
      'remove_game_board_bounds',
    ]);
    const natural = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      return { bounds: [...g.board.bounds], w: g.tilemap.width, h: g.tilemap.height };
    });
    expect(natural.bounds).toEqual([0, 0, natural.w - 1, natural.h - 1]);
  });

  test('board bounds persist through save/load', async ({ page }) => {
    await boot(page);
    await runEvent(page, 'TestBoundsSave', ['set_game_board_bounds;0;0;5;5']);
    const result = await page.evaluate(async () => {
      const h = (window as any).__harness;
      const g = (window as any).__gameRef;
      const snap = h.saveSnapshot();
      g.board.resetBounds();
      const loaded = await h.loadSnapshot(snap);
      return { loaded: !!loaded, bounds: [...g.board.bounds] };
    });
    expect(result.bounds).toEqual([0, 0, 5, 5]);
  });

  test('dump_vars logs game and level vars without disturbing the event', async ({ page }) => {
    await boot(page);
    const logs: string[] = [];
    page.on('console', (msg) => {
      if (msg.text().includes('[dump_vars]')) logs.push(msg.text());
    });
    await runEvent(page, 'TestDump', [
      'game_var;dump_probe;42',
      'dump_vars',
      'game_var;after_dump;yes',
    ]);
    const after = await page.evaluate(() => (window as any).__gameRef.gameVars.get('after_dump'));
    expect(after).toBe('yes');
    expect(logs.length).toBeGreaterThanOrEqual(2); // game_vars + level_vars lines
    expect(logs.some((l) => l.includes('dump_probe'))).toBe(true);
  });

  test('delete_save removes a saved slot', async ({ page }) => {
    await boot(page);
    const saved = await page.evaluate(async () => {
      const g = (window as any).__gameRef;
      const saveModule = await import('/src/engine/save.ts');
      // Create a real save in slot 7, confirm it loads, then delete via command.
      await saveModule.saveGame(g, 7);
      return saveModule.loadGame(g, 7);
    });
    expect(saved).toBe(true);
    await runEvent(page, 'TestDeleteSave', ['delete_save;7']);
    // Give the async deletion a moment, then verify the slot is gone.
    await page.waitForTimeout(500);
    const loadedAfter = await page.evaluate(async () => {
      const g = (window as any).__gameRef;
      const saveModule = await import('/src/engine/save.ts');
      return saveModule.loadGame(g, 7).catch(() => false);
    });
    expect(loadedAfter).toBe(false);
  });
});
