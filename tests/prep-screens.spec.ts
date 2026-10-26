/**
 * prep-screens.spec.ts — Preparation screens against lt-maker/app/engine/prep.py.
 *
 * Drives Embrace of the Fog into a real `prep;t` chapter with an eight-unit
 * party and checks the Python layout contracts: PrepMainState is a map state
 * with a centred Choice, Pick Units is a 6x2 `menus.Table` at (110, 24) in
 * 'position' mode, and Formation selects/moves units on formation tiles.
 * Screenshots are attached for visual inspection.
 */

import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Page, type TestInfo } from '@playwright/test';

const projectRoot = path.join(process.cwd(), 'lt-maker/eotf.ltproj');
const projectAvailable = fs.existsSync(path.join(projectRoot, 'game_data/levels.json'));

const PARTY = ['Termina', 'Aeilem', 'Gorbat', 'Tinola', 'Viran', 'JG', 'Moudrost'];

async function step(page: Page, frames: number, input?: string): Promise<void> {
  await page.evaluate(({ frames, input }) => (window as any).__harness.stepFrames(frames, input ?? null),
    { frames, input: input ?? null });
}

/** Let sprite/font loads land (they resolve in real time), then render. */
async function settleImages(page: Page): Promise<void> {
  await step(page, 5);
  await page.waitForTimeout(500);
  await step(page, 30);
}

async function stack(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as any).__gameRef.state.stack.map((s: any) => s.name));
}

async function attachShot(page: Page, testInfo: TestInfo, name: string): Promise<Buffer> {
  const data: string = await page.evaluate(() => (window as any).__harness.screenshot());
  const png = Buffer.from(data.split(',')[1], 'base64');
  await testInfo.attach(name, { body: png, contentType: 'image/png' });
  fs.mkdirSync(testInfo.outputPath(), { recursive: true });
  fs.writeFileSync(testInfo.outputPath(`${name}.png`), png);
  return png;
}

/** Boot EOtF, give the Player party eight units, and open level 1's prep. */
async function openPrep(page: Page, prepSource?: string[]): Promise<void> {
  await page.goto('/?harness=true&project=eotf.ltproj&level=X&clean=false&bundle=false');
  await page.waitForFunction(() => (window as any).__harness?.ready === true, undefined, { timeout: 60_000 });
  await page.evaluate(() => (window as any).__harness.settle(12_000, ['free_roam']));
  await page.evaluate(async ({ party, prepSource }) => {
    const g = (window as any).__gameRef;
    g.roamInfo.roam = false;
    g.currentParty = 'Player';
    const player = g.getUnit('Player');
    player.party = 'Player';
    player.persistent = true;
    for (const nid of party) {
      const unit = g.spawnUnit(g.db.units.get(nid), 'player', null, 'None');
      unit.party = 'Player';
      unit.persistent = true;
    }
    g.cleanUpLevel();
    g.state.clear();
    g.state.change('free');
    (window as any).__harness.stepFrames(2);
    await (window as any).__harness.loadLevel('1');
    await g.loadAllMapSprites();
    if (prepSource) {
      // Replace the chapter's own prep call with a synthetic one.
      while (g.eventManager.hasActiveEvents()) g.eventManager.dequeueCurrentEvent();
      g.state.clear();
      g.state.change('free');
      g.db.events.set('qa_prep', {
        name: 'qa_prep', nid: 'qa_prep', trigger: 'qa_prep', level_nid: null,
        condition: 'True', only_once: false, priority: 0, _source: prepSource,
      });
      g.eventManager.triggerSpecific('qa_prep', { type: 'qa_prep' }, true);
      g.state.change('event');
    }
  }, { party: PARTY, prepSource: prepSource ?? null });
  await page.evaluate(() => (window as any).__harness.settle(15_000, ['prep_main']));
  await settleImages(page);
  expect((await stack(page)).at(-1)).toBe('prep_main');
}

test.describe('Preparation screens (Python prep.py parity)', () => {
  test.skip(!projectAvailable, 'lt-maker/eotf.ltproj is not installed');

  test('prep main is a map state with Python options and custom prep options', async ({ page }, testInfo) => {
    test.slow();
    await openPrep(page, ['prep;t;;Check Seals;true;Menu_Seal_Check']);
    const main = await page.evaluate(() => {
      const state = (window as any).__gameRef.state.getCurrentState();
      const [x, y] = state.menu.getTopleft();
      return {
        transparent: state.transparent,
        options: state.options,
        topleft: [x, y],
        width: state.menu.getMenuWidth(),
        cursorVisible: (window as any).__gameRef.cursor.visible,
      };
    });
    expect(main.transparent, 'PrepMainState is a MapState: the map shows through').toBe(true);
    expect(main.options).toEqual(['Pick Units', 'Manage', 'Formation', 'Check Seals', 'Options', 'Save', 'Fight']);
    // menus.Choice(topleft='center'): centred on the 240x160 window.
    expect(main.topleft[0]).toBe(Math.floor(120 - main.width / 2));
    expect(main.cursorVisible).toBe(false);
    await attachShot(page, testInfo, 'prep-main');
  });

  test('Pick Units is the 6x2 position-mode unit table with deploy toggling', async ({ page }, testInfo) => {
    test.slow();
    await openPrep(page);
    await step(page, 1, 'SELECT');
    await settleImages(page);
    expect((await stack(page)).at(-1)).toBe('prep_pick');

    const layout = await page.evaluate(() => {
      const state = (window as any).__gameRef.state.getCurrentState();
      const menu = state.menu;
      return {
        rows: menu.rows,
        columns: menu.columns,
        topleft: menu.topleft,
        mode: menu.mode,
        width: menu.getMenuWidth(),
        height: menu.getMenuHeight(),
        order: state.units.map((u: any) => [u.name, !!u.position]),
      };
    });
    expect(layout).toMatchObject({ rows: 6, columns: 2, topleft: [110, 24], mode: 'position', width: 128, height: 104 });
    // Deployed (placed) units come before benched ones.
    const firstBenched = layout.order.findIndex(([, placed]: [string, boolean]) => !placed);
    expect(layout.order.slice(firstBenched).every(([, placed]: [string, boolean]) => !placed)).toBe(true);
    expect(layout.order.map(([name]: [string]) => name)).toContain('L. T.');

    const shot = await attachShot(page, testInfo, 'pick-units');
    expect(shot.length).toBeGreaterThan(1000);

    // Undeploy the first placed unit, then deploy it again.
    const before = await page.evaluate(() => (window as any).__gameRef.state.getCurrentState().menu.getCurrentUnit().position);
    expect(before).not.toBeNull();
    await step(page, 1, 'SELECT');
    await step(page, 2);
    const removed = await page.evaluate(() => (window as any).__gameRef.state.getCurrentState().menu.getCurrentUnit().position);
    expect(removed).toBeNull();
    await step(page, 1, 'SELECT');
    await step(page, 2);
    const restored = await page.evaluate(() => (window as any).__gameRef.state.getCurrentState().menu.getCurrentUnit().position);
    expect(restored).not.toBeNull();

    // Slots are full (4/4): a benched unit cannot be added.
    const blocked = await page.evaluate(() => {
      const state = (window as any).__gameRef.state.getCurrentState();
      const idx = state.units.findIndex((u: any) => !u.position);
      state.menu.moveTo(idx);
      return state.units[idx].nid;
    });
    await step(page, 1, 'SELECT');
    await step(page, 2);
    expect(await page.evaluate((nid) => (window as any).__gameRef.getUnit(nid).position, blocked)).toBeNull();

    // INFO opens the info menu for the hovered unit, BACK restores the cursor.
    await step(page, 1, 'INFO');
    await step(page, 3);
    expect((await stack(page)).at(-1)).toBe('info_menu');
    await step(page, 1, 'BACK');
    await step(page, 3);
    const current = await page.evaluate(() => (window as any).__gameRef.state.getCurrentState().menu.getCurrentUnit().nid);
    expect(current).toBe(blocked);
    await step(page, 1, 'BACK');
    await step(page, 3);
    expect((await stack(page)).at(-1)).toBe('prep_main');
  });

  test('Formation selects a unit with the hand marker and moves it to a formation tile', async ({ page }, testInfo) => {
    test.slow();
    await openPrep(page);
    await page.evaluate(() => {
      const state = (window as any).__gameRef.state.getCurrentState();
      state.cursor = state.options.indexOf('Formation');
    });
    await step(page, 1, 'SELECT');
    await settleImages(page);
    expect((await stack(page)).at(-1)).toBe('prep_formation');

    const setup = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const spots = g.currentLevel.regions.filter((r: any) => r.region_type === 'formation')
        .map((r: any) => r.position);
      const types = spots.map(([x, y]: [number, number]) => g.highlight.getHighlights().get(`${x},${y}`));
      const occupied = spots.find(([x, y]: [number, number]) => g.board.getUnit(x, y));
      const unit = g.board.getUnit(occupied[0], occupied[1]);
      // Free one formation tile so the unit has somewhere to go.
      const other = spots.find(([x, y]: [number, number]) =>
        (x !== occupied[0] || y !== occupied[1]) && g.board.getUnit(x, y));
      const bench = g.board.getUnit(other[0], other[1]);
      g.board.removeUnit(bench);
      bench.position = null;
      g.cursor.setPos(occupied[0], occupied[1]);
      return { types, unit: unit.nid, from: occupied, to: other };
    });
    expect(setup.types.every((t: string) => t === 'formation')).toBe(true);

    await step(page, 1, 'SELECT');
    await step(page, 3);
    expect((await stack(page)).at(-1)).toBe('prep_formation_select');
    await attachShot(page, testInfo, 'formation-select');

    await page.evaluate(({ to }) => (window as any).__gameRef.cursor.setPos(to[0], to[1]), { to: setup.to });
    await step(page, 1, 'SELECT');
    await step(page, 3);
    expect((await stack(page)).at(-1)).toBe('prep_formation');
    const moved = await page.evaluate((nid) => (window as any).__gameRef.getUnit(nid).position, setup.unit);
    expect(moved).toEqual(setup.to);

    await step(page, 1, 'BACK');
    await step(page, 3);
    expect((await stack(page)).at(-1)).toBe('prep_main');
  });
});
