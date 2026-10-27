import { expect, test, type Page } from '@playwright/test';

/**
 * Python unit arrival/departure presentation: event_functions add_unit /
 * remove_unit / move_unit / kill_unit and action.FadeIn/WarpIn/SwooshIn,
 * FadeOut/WarpOut/SwooshOut, Warp/FadeMove/Swoosh driving
 * UnitSprite.set_transition (450 ms, unit_sprite.py), plus DyingState.
 * Transitions never block the event; kill_unit's dying does.
 */

test.describe.configure({ mode: 'parallel' });

async function boot(page: Page): Promise<void> {
  await page.goto('/?harness=true&level=0&clean=true&bundle=false');
  await page.waitForFunction(() => (window as any).__harness?.ready === true, undefined, { timeout: 60_000 });
  await page.evaluate(() => (window as any).__harness.settle(600));
  await page.evaluate(() => {
    const g = (window as any).__gameRef;
    const played: string[] = [];
    (window as any).__sfx = played;
    const audio = g.audioManager;
    const original = audio.playSfx?.bind(audio);
    audio.playSfx = (nid: string, ...rest: unknown[]) => {
      played.push(nid);
      return original?.(nid, ...rest);
    };
  });
}

async function step(page: Page, frames: number): Promise<void> {
  await page.evaluate((n) => (window as any).__harness.stepFrames(n, null), frames);
}

/** Start an event and run it for one frame. */
async function startEvent(page: Page, nid: string, source: string[]): Promise<void> {
  await page.evaluate(({ nid, source }) => {
    const g = (window as any).__gameRef;
    g.db.events.set(nid, {
      name: nid, nid, trigger: nid, level_nid: g.currentLevel?.nid ?? null,
      condition: 'True', only_once: false, priority: 0, _source: source,
    });
    g.eventManager.triggerSpecific(nid, { type: nid }, true);
    g.state.change('event');
  }, { nid, source });
  await step(page, 3);
}

const fx = (page: Page, nid: string) => page.evaluate(async (nid) => {
  const g = (window as any).__gameRef;
  const mod = await import('/src/combat/map-unit-fx.ts');
  const unit = g.units.get(nid);
  const visual = unit ? mod.getUnitFx(unit) : null;
  return {
    transition: unit ? mod.getUnitTransition(unit) : null,
    position: unit?.position ?? null,
    drawAt: unit ? mod.getTransitionPosition(unit) : null,
    offBoard: mod.offBoardTransitionUnits().some((u: any) => u.nid === nid),
    opacity: visual?.opacity ?? 1,
    stretch: visual?.stretchY ?? 1,
    offset: visual?.offset ?? [0, 0],
    afterVar: g.gameVars.get('_after') ?? null,
    sfx: [...(window as any).__sfx],
  };
}, nid);

test('add_unit fades in on an inner tile without blocking, then draws normally', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => {
    const g = (window as any).__gameRef;
    g.board.removeUnit(g.units.get('Seth'));
  });
  await startEvent(page, 'TestFadeIn', ['add_unit;Seth;5,3;fade', 'game_var;_after;1']);
  const start = await fx(page, 'Seth');
  expect(start).toMatchObject({ transition: 'fade_in', position: [5, 3], afterVar: 1 });
  expect(start.opacity).toBeLessThan(0.2);
  await step(page, 14);
  const mid = await fx(page, 'Seth');
  expect(mid.opacity).toBeGreaterThan(0.4);
  expect(mid.opacity).toBeLessThan(0.7);
  await step(page, 20);
  expect((await fx(page, 'Seth')).transition).toBeNull();
});

test('add_unit on a map edge slides in a tile (fake_in), 2 px a frame', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => {
    const g = (window as any).__gameRef;
    g.board.removeUnit(g.units.get('Seth'));
  });
  await startEvent(page, 'TestFakeIn', ['add_unit;Seth;0,3;fade']);
  const start = await fx(page, 'Seth');
  expect(start.transition).toBe('fake_in');
  expect(start.offset[0]).toBeLessThan(0);
  expect(start.offset[0]).toBeGreaterThanOrEqual(-16);
  await step(page, 10);
  expect((await fx(page, 'Seth')).transition).toBeNull();
});

test('remove_unit warp keeps drawing the unit on its old tile with Warp, flicker and flowers', async ({ page }) => {
  await boot(page);
  await startEvent(page, 'TestWarpOut', ['remove_unit;Seth;warp', 'game_var;_after;1']);
  const start = await fx(page, 'Seth');
  expect(start).toMatchObject({ transition: 'warp_out', position: null, drawAt: [4, 4], offBoard: true, afterVar: 1 });
  expect(start.sfx).toContain('Warp');
  await step(page, 30);
  const end = await fx(page, 'Seth');
  expect(end).toMatchObject({ transition: null, drawAt: null, offBoard: false });
});

test('remove_unit swoosh stretches the sprite upward as it fades', async ({ page }) => {
  await boot(page);
  await startEvent(page, 'TestSwooshOut', ['remove_unit;Seth;swoosh']);
  await step(page, 20);
  const mid = await fx(page, 'Seth');
  expect(mid.transition).toBe('swoosh_out');
  expect(mid.stretch).toBeGreaterThan(1.5);
  expect(mid.sfx).toContain('Sword Whoosh');
});

test('move_unit fade fades out on the old tile, then in on the new one', async ({ page }) => {
  await boot(page);
  await startEvent(page, 'TestFadeMove', ['move_unit;Seth;6,4;fade', 'game_var;_after;1']);
  const start = await fx(page, 'Seth');
  expect(start).toMatchObject({ transition: 'fade_move', position: [6, 4], drawAt: [4, 4], afterVar: 1 });
  await step(page, 30);
  const second = await fx(page, 'Seth');
  expect(second).toMatchObject({ transition: 'fade_in', drawAt: [6, 4] });
});

test('kill_unit plays the dying fade (Death sfx) and blocks the event until Die', async ({ page }) => {
  await boot(page);
  await startEvent(page, 'TestKill', ['kill_unit;Seth', 'game_var;_after;1']);
  const dying = await page.evaluate(async () => {
    const g = (window as any).__gameRef;
    const mod = await import('/src/combat/map-unit-fx.ts');
    const seth = g.units.get('Seth');
    return {
      state: g.state.getCurrentState()?.name,
      onMap: !!seth.position,
      dying: mod.isUnitDying(seth),
      after: g.gameVars.get('_after') ?? null,
    };
  });
  expect(dying).toEqual({ state: 'dying', onMap: true, dying: true, after: null });
  await step(page, 30);
  const dead = await page.evaluate(() => {
    const g = (window as any).__gameRef;
    const seth = g.units.get('Seth');
    return { onMap: !!seth.position, dead: seth.isDead(), after: g.gameVars.get('_after') ?? null, sfx: (window as any).__sfx };
  });
  expect(dead).toMatchObject({ onMap: false, dead: true, after: 1 });
  expect(dead.sfx).toContain('Death');
});

test('a warp-in frame draws the Warp animation and petals over the arriving unit', async ({ page }, testInfo) => {
  await boot(page);
  await page.evaluate(() => {
    const g = (window as any).__gameRef;
    g.board.removeUnit(g.units.get('Seth'));
    g.camera.focusTile?.(5, 3);
  });
  await startEvent(page, 'TestWarpIn', ['add_unit;Seth;5,3;warp']);
  await step(page, 14);
  const state = await fx(page, 'Seth');
  expect(state.transition).toBe('warp_in');
  expect(state.sfx).toContain('WarpEnd');
  const canvas = page.locator('canvas').first();
  await canvas.screenshot({ path: testInfo.outputPath('warp-in.png') });
});

test('open_convoy opens supply_items even without the _convoy game var', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => (window as any).__gameRef.gameVars.delete('_convoy'));
  await startEvent(page, 'TestConvoyNoVar', ['open_convoy;Eirika']);
  await step(page, 5);
  expect(await page.evaluate(() => (window as any).__gameRef.state.getCurrentState()?.name)).toBe('supply_items');
});

test('the Warp/Swoosh sheets and warp petals load with the project', async ({ page }) => {
  await boot(page);
  await page.waitForFunction(async () => {
    const { transitionArtReady } = await import('/src/engine/states/game-states.ts');
    return transitionArtReady();
  }, undefined, { timeout: 10_000 });
});

// Python Event._move_unit has no swoosh branch: move_group / spawn_group
// with MovementType swoosh leave the unit where it is.
test('move_group with swoosh does not move the unit, as Python', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => {
    const g = (window as any).__gameRef;
    g.currentLevel.unit_groups.push({ nid: '_SwooshGroup', units: ['Seth'], positions: { Seth: [6, 4] } });
  });
  await startEvent(page, 'TestSwooshGroup', ['move_group;_SwooshGroup;;swoosh']);
  await step(page, 10);
  const state = await fx(page, 'Seth');
  expect(state).toMatchObject({ position: [4, 4], transition: null });
});

// Python MovementSystem.update: a following event move keeps the cursor on
// the unit and centers the camera on it tile by tile (not on the target).
test('move_unit follows the walking unit with the cursor', async ({ page }) => {
  await boot(page);
  const target = await page.evaluate(() => {
    const g = (window as any).__gameRef;
    g.cursor.setPos(0, 0);
    const seth = g.units.get('Seth');
    let best: number[] | null = null;
    for (const [x, y] of g.pathSystem.getValidMoves(seth, g.board)) {
      const path = g.pathSystem.getPath(seth, x, y, g.board);
      if (path && path.length >= 4 && !g.board.getUnit(x, y)) { best = [x, y]; break; }
    }
    return best;
  });
  expect(target).not.toBeNull();
  await startEvent(page, 'TestFollow', [`move_unit;Seth;${target![0]},${target![1]}`]);
  const samples: Array<{ unit: number[]; cursor: number[] }> = [];
  for (let i = 0; i < 6; i++) {
    await step(page, 4);
    samples.push(await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const hover = g.cursor.getHover();
      return { unit: [...g.units.get('Seth').position], cursor: [hover.x, hover.y] };
    }));
  }
  for (const sample of samples) expect(sample.cursor).toEqual(sample.unit);
  expect(new Set(samples.map((sample) => sample.unit.join(','))).size).toBeGreaterThan(1);
});

// Python move_unit (normal): no path -> logged error, the unit stays put.
test('move_unit with no path leaves the unit where it is', async ({ page }) => {
  await boot(page);
  const target = await page.evaluate(() => {
    const g = (window as any).__gameRef;
    const seth = g.units.get('Seth');
    for (let y = 0; y < g.board.height; y++) {
      for (let x = 0; x < g.board.width; x++) {
        if (g.board.getUnit(x, y)) continue;
        const path = g.pathSystem.getPath(seth, x, y, g.board);
        if (!path || path.length === 0) return [x, y];
      }
    }
    return null;
  });
  expect(target).not.toBeNull();
  await startEvent(page, 'TestNoPath', [`move_unit;Seth;${target![0]},${target![1]}`, 'game_var;_after;1']);
  const state = await fx(page, 'Seth');
  expect(state).toMatchObject({ position: [4, 4], afterVar: 1 });
});

// Python move_unit: `_parse_pos(position) if position else starting_position`.
// A Position that does not parse (an unset {v:...} reads '??', as in EOtF's
// Hurricane_Caught upkeep event) moves nobody; only a missing one falls back
// to the starting tile.
test('move_unit with an unparseable position leaves the unit where it is', async ({ page }) => {
  await boot(page);
  const start = await page.evaluate(() => {
    const g = (window as any).__gameRef;
    const seth = g.units.get('Seth');
    const free = [[4, 5], [5, 4], [3, 4], [4, 3]].find(([x, y]) => !g.board.getUnit(x, y));
    seth.startingPosition = free;
    return { position: seth.position, free };
  });
  await startEvent(page, 'TestBadPos', ['move_unit;Seth;{v:_no_such_var};immediate', 'game_var;_after;1']);
  const bad = await fx(page, 'Seth');
  expect(bad).toMatchObject({ position: start.position, afterVar: 1 });
  await startEvent(page, 'TestNoPos', ['move_unit;Seth;;immediate', 'game_var;_after2;1']);
  const fallback = await fx(page, 'Seth');
  expect(fallback.position).toEqual(start.free);
});
