/**
 * unit-menu.spec.ts: the option menu's Unit chart (lt-maker
 * unit_menu_state.py, unit_menu.py, unit_table.py on the ui_framework).
 * The layout numbers and pixels below are the fork oracle's: its shots of
 * the same EX_2 scene (seven units) match the web pixel for pixel apart
 * from the map sprites' animation phase.
 */
import { expect, test, type Page } from '@playwright/test';

test.describe.configure({ mode: 'parallel' });

async function boot(page: Page): Promise<void> {
  await page.goto('/?harness=true&project=eotf.ltproj&level=EX_2&clean=true&bundle=false');
  await page.waitForFunction(() => (window as any).__harness?.ready === true, undefined, { timeout: 90_000 });
  await page.evaluate(async () => {
    const g = (window as any).__gameRef;
    const h = (window as any).__harness;
    g.eventManager.trigger = () => false;
    const source = [
      'load_unit;Termina;player', 'add_unit;Termina;7,8;immediate',
      'load_unit;Aeilem;player', 'add_unit;Aeilem;8,8;immediate',
      'load_unit;Alphabet;player', 'add_unit;Alphabet;9,8;immediate',
      'load_unit;Amant;player', 'add_unit;Amant;10,8;immediate',
      'load_unit;Gorbat;player', 'add_unit;Gorbat;7,9;immediate',
      'load_unit;Tinola;player', 'add_unit;Tinola;8,9;immediate',
      'load_unit;Pilus;player', 'add_unit;Pilus;9,9;immediate',
    ];
    g.db.events.set('QaUnits', {
      name: 'QaUnits', nid: 'QaUnits', trigger: 'QaUnits', level_nid: g.currentLevel?.nid ?? null,
      condition: 'True', only_once: false, priority: 0, _source: source,
    });
    g.eventManager.triggerSpecific('QaUnits', { type: 'QaUnits' }, true);
    g.state.change('event');
    h.stepFrames(30, null);
    g.state.change('option_menu');
    h.stepFrames(5, null);
  });
  // Let the chart's windows, sprites and icons load (the option menu asks).
  await page.waitForTimeout(500);
}

const press = (page: Page, button: string, frames = 1) => page.evaluate(({ button, frames }) => {
  const h = (window as any).__harness;
  h.stepFrames(1, button);
  h.stepFrames(frames, null);
}, { button, frames });

const chart = (page: Page) => page.evaluate(() => {
  const g = (window as any).__gameRef;
  const ui = g.state.allStates.get('unit_menu').ui;
  const table = ui.table;
  return {
    stack: g.state.getStackNames(),
    title: table.getPageTitle(),
    page: `${table.getPageNum() + 1} / ${table.getNumPages()}`,
    cursor: [...table.cursorPos],
    order: table.data.map((u: any) => u.nid),
    sortBy: ui.sortBy,
    ascending: ui.sortAscending,
  };
});

test('the option menu lists Unit first and opens the chart through the fades', async ({ page }) => {
  await boot(page);
  const labels = await page.evaluate(() =>
    (window as any).__gameRef.state.getCurrentState().menu.options.map((o: any) => o.label));
  expect(labels.slice(0, 3)).toEqual(['Unit', 'Objective', 'Options']);
  // SELECT on frame 0; transition_to starts on frame 1 and ends on frame 9
  // (133 ms on Python's integer clock), where unit_menu starts under
  // transition_in, which fades it in over 8 more.
  await press(page, 'SELECT', 7);
  expect(await page.evaluate(() => (window as any).__gameRef.state.getStackNames().at(-1))).toBe('transition_to');
  await press(page, null as any, 1);
  expect(await page.evaluate(() => (window as any).__gameRef.state.getStackNames().slice(-2)))
    .toEqual(['unit_menu', 'transition_in']);
  await press(page, null as any, 8);
  expect((await chart(page)).stack.at(-1)).toBe('unit_menu');

  // BACK fades out (transition_pop) to the option menu, which fades in.
  await press(page, 'BACK', 7);
  expect((await page.evaluate(() => (window as any).__gameRef.state.getStackNames().at(-1)))).toBe('transition_pop');
  await press(page, null as any, 1);
  expect(await page.evaluate(() => (window as any).__gameRef.state.getStackNames().slice(-2)))
    .toEqual(['option_menu', 'transition_in']);
});

test('chart pages, cursor and sorting follow unit_menu.py', async ({ page }) => {
  await boot(page);
  await press(page, 'SELECT', 20);
  let state = await chart(page);
  expect(state.title).toBe('Character');
  expect(state.page).toBe('1 / 6');
  expect(state.cursor).toEqual([0, 0]);
  expect(state.order).toEqual(['Yusha', 'Termina', 'Aeilem', 'Alphabet', 'Amant', 'Gorbat', 'Tinola', 'Pilus']);

  // Rows: the seventh row scrolls the 6-row window; RIGHT on a row turns
  // the page and puts the cursor back on the name column.
  for (let i = 0; i < 7; i++) await press(page, 'DOWN', 8);
  state = await chart(page);
  expect(state.cursor).toEqual([0, 7]);
  const titles = [state.title];
  for (let i = 0; i < 6; i++) {
    await press(page, 'RIGHT', 20);
    titles.push((await chart(page)).title);
  }
  expect(titles).toEqual(['Character', 'Vital Statistics', 'Vital Statistics', 'Equipment',
    'Weapon Level', 'Weapon Level', 'Weapon Level']);
  expect((await chart(page)).page).toBe('6 / 6');

  // Back up to the Name header and sort: the first SELECT on the current
  // sort key flips it to ascending, which Python sorts with reverse=True.
  for (let i = 0; i < 8; i++) await press(page, 'UP', 8);
  expect((await chart(page)).cursor).toEqual([0, 0]);
  await press(page, 'SELECT', 4);
  state = await chart(page);
  expect(state.ascending).toBe(true);
  expect(state.order).toEqual(['Yusha', 'Tinola', 'Termina', 'Pilus', 'Gorbat', 'Amant', 'Alphabet', 'Aeilem']);
  await press(page, 'SELECT', 4);
  state = await chart(page);
  expect(state.ascending).toBe(false);
  expect(state.order).toEqual(['Aeilem', 'Alphabet', 'Amant', 'Gorbat', 'Pilus', 'Termina', 'Tinola', 'Yusha']);

  // A stat header sorts by its column; LEFT from page 6's header lands on
  // page 5's last header.
  await press(page, 'LEFT', 20);
  state = await chart(page);
  expect(state.page).toBe('5 / 6');
  expect(state.cursor[1]).toBe(0);
  expect(state.cursor[0]).toBeGreaterThan(0);
});

test('chart layout and pixels match the oracle', async ({ page }) => {
  await boot(page);
  await press(page, 'SELECT', 30);
  await press(page, 'DOWN', 8);
  const result = await page.evaluate(async () => {
    const g = (window as any).__gameRef;
    const { getSprite } = await import('/src/ui/sprites.ts');
    const ui = g.state.allStates.get('unit_menu').ui;
    const base = ui.base;
    const positions = base.generateChildPositions();
    const table = ui.table;
    const canvas = document.querySelector('canvas') as HTMLCanvasElement;
    const scale = canvas.width / 240;
    const ctx = canvas.getContext('2d')!;
    const px = (x: number, y: number) => Array.from(ctx.getImageData(x * scale, y * scale, 1, 1).data).slice(0, 3);
    const box = getSprite('world_map_location_box');
    return {
      // unit_info_box (0,0), sort box right/top (margin 4, 5), the table
      // centred at the bottom (232x120, margin bottom 3): (4, 37).
      positions: [...positions.values()].map(([x, y]: [number, number]) => [Math.trunc(x), Math.trunc(y)]),
      tableSize: table.size,
      overflow: table.overflow,
      nameListWidth: table.leftUnitNameList.width,
      columnWidths: table.rightUnitDataGrid.table.slice(0, 5).map((col: any) => col.width),
      pageWidth: table.rightUnitDataGrid.width,
      stripWidth: table.rightUnitDataGrid.twidth,
      boxPixel: box ? [px(3, 14), Array.from(box.getPixel(3, 14)).slice(0, 3)] : null,
      // The cursor row's equipment_highlight (lightened) under row 1.
      highlight: px(60, 37 + 3 + 16 + 12),
      rowBg: px(60, 37 + 3 + 16 * 3 + 12),
    };
  });
  expect(result.positions).toEqual([[0, 0], [164, 5], [4, 37], [207, 24]]);
  expect(result.tableSize).toEqual([232, 120]);
  expect(result.overflow).toEqual([16, 16, 16, 0]);
  expect(result.nameListWidth).toBe(69);
  expect(result.columnWidths).toEqual([45, 24, 24, 24, 24]);
  expect(result.pageWidth).toBe(150);
  expect(result.stripWidth).toBe(900);
  expect(result.boxPixel?.[0]).toEqual(result.boxPixel?.[1]);
  // The highlight is lighter than the plain body.
  const sum = (c: number[]) => c[0] + c[1] + c[2];
  expect(sum(result.highlight)).toBeGreaterThan(sum(result.rowBg) + 60);
});

test('SELECT on a unit closes the chart and the option menu on that unit', async ({ page }) => {
  await boot(page);
  await press(page, 'SELECT', 30);
  await press(page, 'DOWN', 8);
  await press(page, 'DOWN', 8);
  await press(page, 'SELECT', 2);
  const result = await page.evaluate(() => {
    const g = (window as any).__gameRef;
    const cursor = g.cursor.getHover();
    return { stack: g.state.getStackNames(), cursor: [cursor.x, cursor.y], termina: g.units.get('Termina').position };
  });
  expect(result.stack.includes('unit_menu')).toBe(false);
  expect(result.stack.includes('option_menu')).toBe(false);
  expect(result.cursor).toEqual(result.termina);
});
