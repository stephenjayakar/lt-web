/**
 * eotf-unit-dex.spec.ts: the engine fork's unit dex (base_copy_info_menu.py,
 * state 'base_info_menu') that EOtF opens from the option-menu "Gallery"
 * (`show_pokedex`), from INFO on a `type_dex_unit` choice, and from AUX in
 * prep/base manage. Screenshots are attached for inspection.
 */
import { expect, test, type Page } from '@playwright/test';

test.describe.configure({ mode: 'parallel' });

async function boot(page: Page): Promise<void> {
  await page.goto('/?harness=true&project=eotf.ltproj&level=X&clean=true&bundle=false');
  await page.waitForFunction(() => (window as any).__harness?.ready === true, undefined, { timeout: 90_000 });
  await page.evaluate(async () => {
    const { RECORDS } = await import('/src/engine/records.ts');
    RECORDS.replace('Available_Units', ['Player', 'Libra_P']);
    RECORDS.replace('Seen_Units', ['Hetja']);
    RECORDS.replace('Density_10_Cleared', false);
    RECORDS.replace('__is_favorited__Player__', true);
    RECORDS.replace('Tacita_3', true);
    RECORDS.replace('forename', true);
    RECORDS.replace('PlayerBootes', true);
  });
}

async function step(page: Page, frames: number, input: string | null = null): Promise<void> {
  await page.evaluate(({ frames, input }) => (window as any).__harness.stepFrames(frames, input), { frames, input });
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
}

const stateName = (page: Page) =>
  page.evaluate(() => (window as any).__gameRef.state.getCurrentState()?.name);

const dex = (page: Page) => page.evaluate(() => {
  const s = (window as any).__gameRef.state.getCurrentState();
  return {
    unit: s.currentUnit(),
    index: s.selectedIdx,
    count: s.allUnits.length,
    panel: s.detailPanel.state,
    left: s.detailPanel.leftSide,
    page: s.detailPanel.pageIdx,
    mode: s.detailPanel.mode,
    info: s.detailPanel.infoFlag,
    option: s.detailPanel.optionMenu.state,
  };
});

/** Let portraits, sprites and panoramas finish their async loads. */
async function settle(page: Page): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await page.waitForTimeout(250);
    await step(page, 2);
  }
}

test('show_pokedex opens the unit dex and resumes the event on BACK', async ({ page }, testInfo) => {
  await boot(page);
  await runEvent(page, 'dex_open', ['show_pokedex', 'game_var;after_dex;1']);
  for (let i = 0; i < 40 && await stateName(page) !== 'base_info_menu'; i++) await step(page, 2);
  expect(await stateName(page)).toBe('base_info_menu');
  await step(page, 1);

  const info = await dex(page);
  // Every Playable unit except Libra_P before Density 10 is cleared.
  const expected = await page.evaluate(() => [...(window as any).__gameRef.db.units.values()]
    .filter((u: any) => u.tags.includes('Playable') && u.nid !== 'Libra_P').map((u: any) => u.nid));
  expect(info.count).toBe(expected.length);
  expect(info.unit).toBe(expected[0]);
  expect(info.panel).toBe('inactive');

  const hidden = await page.evaluate(() => {
    const s = (window as any).__gameRef.state.getCurrentState();
    return ['Player', 'Hetja', 'Yasukage', 'Gemini_F'].map((nid) => s.isHidden(nid));
  });
  expect(hidden).toEqual([false, false, true, true]);

  await settle(page);
  await page.locator('canvas').screenshot({ path: testInfo.outputPath('dex-wheel.png') });

  await step(page, 1, 'DOWN');
  expect((await dex(page)).index).toBe(1);
  await step(page, 10);

  await step(page, 1, 'BACK');
  await step(page, 10);
  expect(await page.evaluate(() => (window as any).__gameRef.gameVars.get('after_dex'))).toBe(1);
});

test('the detail panel slides open, pages, shows help and toggles favourites', async ({ page }, testInfo) => {
  await boot(page);
  await page.evaluate(() => {
    const g = (window as any).__gameRef;
    g.memory.set('curr_unit_info', 'Player');
    g.state.change('base_info_menu');
  });
  await step(page, 3);
  expect((await dex(page)).unit).toBe('Player');

  await step(page, 1, 'SELECT');
  await step(page, 2);
  const mid = await dex(page);
  expect(mid.panel).toBe('expand');
  expect(mid.left).toBeLessThan(144);
  await step(page, 12);
  expect(await dex(page)).toMatchObject({ panel: 'active', left: 48, page: 0, mode: 'Stat' });
  await settle(page);
  await page.locator('canvas').screenshot({ path: testInfo.outputPath('dex-vital.png') });

  // AUX swaps bases for growths.
  await step(page, 1, 'AUX');
  expect((await dex(page)).mode).toBe('Growth');
  await step(page, 3);
  await page.locator('canvas').screenshot({ path: testInfo.outputPath('dex-growths.png') });

  // RIGHT to the items page; INFO opens the item help box.
  await step(page, 1, 'RIGHT');
  await step(page, 3);
  expect((await dex(page)).page).toBe(1);
  await step(page, 1, 'INFO');
  await settle(page);
  expect((await dex(page)).info).toBe(true);
  const box = await page.evaluate(() => {
    const s = (window as any).__gameRef.state.getCurrentState();
    const graph = s.detailPanel.infoGraph;
    return { aabb: graph.currentBB?.aabb, boxes: graph.currentBB?.boxes.length, items: graph.boxes().length };
  });
  // Dragonstone_LT at slot 0 (x = 1, y = 21) registered at DETAIL_LEFT + 3, 25.
  expect(box.aabb).toEqual([147, 25, 16, 16]);
  // Base item plus the purchased-or-not Sapphire Ring upgrade item.
  expect(box.items).toBe(2);
  await page.locator('canvas').screenshot({ path: testInfo.outputPath('dex-items-help.png') });
  await step(page, 1, 'DOWN');
  expect(await page.evaluate(() => (window as any).__gameRef.state.getCurrentState().detailPanel.infoGraph.currentBB.aabb[1]))
    .toBe(97);
  await step(page, 1, 'INFO');
  expect((await dex(page)).info).toBe(false);

  // Upgrades and seals pages.
  await step(page, 1, 'RIGHT');
  await step(page, 1, 'RIGHT');
  await settle(page);
  expect((await dex(page)).page).toBe(3);
  await page.locator('canvas').screenshot({ path: testInfo.outputPath('dex-upgrades.png') });
  await step(page, 1, 'RIGHT');
  await settle(page);
  await page.locator('canvas').screenshot({ path: testInfo.outputPath('dex-seals.png') });

  // SELECT opens the favourite menu; SELECT toggles the record.
  await step(page, 1, 'SELECT');
  expect((await dex(page)).option).toBe('active');
  await step(page, 1, 'SELECT');
  const fav = await page.evaluate(async () => {
    const { RECORDS } = await import('/src/engine/records.ts');
    return RECORDS.get('__is_favorited__Player__');
  });
  expect(fav).toBe(false);
  await step(page, 3);
  await page.locator('canvas').screenshot({ path: testInfo.outputPath('dex-favourite-menu.png') });
  await step(page, 1, 'BACK');
  expect((await dex(page)).option).toBe('inactive');

  // UP/DOWN still scroll the wheel with the panel open; BACK retracts it.
  await step(page, 1, 'DOWN');
  expect((await dex(page)).unit).not.toBe('Player');
  await step(page, 1, 'BACK');
  await step(page, 12);
  expect((await dex(page)).panel).toBe('inactive');
  // The event API reads the same record.
  const sorted = await page.evaluate(async () => {
    const { evaluateExpression } = await import('/src/events/event-manager.ts');
    const g = (window as any).__gameRef;
    return evaluateExpression("game.is_favorited('Player')", { game: g, gameVars: g.gameVars, levelVars: g.levelVars });
  });
  expect(sorted).toBe(false);
});

test('hidden units are black with ??? and an unknown identity page', async ({ page }, testInfo) => {
  await boot(page);
  await page.evaluate(() => {
    const g = (window as any).__gameRef;
    g.memory.set('curr_unit_info', null);
    g.state.change('base_info_menu');
  });
  await step(page, 3);
  // Jump to Yasukage, which is neither recruited nor seen.
  await page.evaluate(() => {
    const s = (window as any).__gameRef.state.getCurrentState();
    s.selectedIdx = s.allUnits.index('Yasukage');
    s.detailPanel.setCurrentUnit('Yasukage');
  });
  await step(page, 1, 'SELECT');
  await step(page, 14);
  await settle(page);
  expect((await dex(page)).panel).toBe('active');
  await page.locator('canvas').screenshot({ path: testInfo.outputPath('dex-hidden.png') });
  // INFO has no boxes on an unknown page.
  await step(page, 1, 'RIGHT');
  await step(page, 1, 'INFO');
  expect((await dex(page)).info).toBe(false);
});

test('INFO on a type_dex_unit choice opens the dex at the hovered unit', async ({ page }) => {
  await boot(page);
  await runEvent(page, 'dex_choice', [
    "choice;picked;Who?;Hetja,Player;Dimensions=8,1;EntryType=type_dex_unit",
    'game_var;after_choice;1',
  ]);
  await step(page, 10);
  await step(page, 1, 'DOWN');
  await step(page, 1, 'INFO');
  await step(page, 3);
  expect(await stateName(page)).toBe('base_info_menu');
  expect((await dex(page)).unit).toBe('Player');
  await step(page, 1, 'BACK');
  await step(page, 3);
  expect(await stateName(page)).toBe('event');
  await step(page, 1, 'SELECT');
  await step(page, 5);
  expect(await page.evaluate(() => (window as any).__gameRef.gameVars.get('picked'))).toBe('Player');
});
