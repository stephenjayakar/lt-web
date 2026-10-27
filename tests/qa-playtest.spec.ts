/**
 * Regressions found by playing EOtF in a real browser (qa/playtest).
 * Each case pins one player-visible bug to the Python reference behavior.
 */
import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';

test.describe.configure({ mode: 'parallel' });

async function boot(page: Page, level = 'DEBUG'): Promise<void> {
  await page.goto(`/?harness=true&level=${level}&bundle=false`);
  await page.waitForFunction(() => !!(window as any).__harness?.ready, { timeout: 15000 });
  await stepFrames(page, 5);
}

async function stepFrames(page: Page, count: number): Promise<void> {
  await page.evaluate((n) => (window as any).__harness.stepFrames(n, null), count);
}

async function runEvent(page: Page, nid: string, source: string[], frames: number): Promise<void> {
  await page.evaluate(({ nid, source }) => {
    const g = (window as any).__gameRef;
    g.db.events.set(nid, {
      name: nid, nid, trigger: nid, level_nid: g.currentLevel?.nid ?? null,
      condition: 'True', only_once: false, priority: 0, _source: source,
    });
    g.eventManager.triggerSpecific(nid, { type: nid }, true);
    g.state.change('event');
  }, { nid, source });
  await stepFrames(page, frames);
}

const gameVar = (page: Page, key: string) =>
  page.evaluate((k) => (window as any).__gameRef.gameVars.get(k), key);

test('music does not swallow the following event command', async ({ page }) => {
  await boot(page);
  // Python event_functions.music is a non-blocking fade_in. The web used to
  // block on a timer that advanced the pointer twice, skipping `b;bedroom`
  // in the EOtF intro (and every act intro background).
  await runEvent(page, 'qa_music_next', [
    'music;Nonexistent_Song',
    'game_var;after_music;1',
    'game_var;after_that;2',
  ], 20);
  expect(await gameVar(page, 'after_music')).toBe(1);
  expect(await gameVar(page, 'after_that')).toBe(2);
});

test('a bare transition toggles between close and open', async ({ page }) => {
  await boot(page);
  // Python: transition with no direction opens when closed, else closes.
  await runEvent(page, 'qa_transition_toggle', [
    'transition',
    'game_var;closed;1',
    'transition',
    'game_var;opened;1',
    'speak;;still running',
  ], 120);
  expect(await gameVar(page, 'closed')).toBe(1);
  expect(await gameVar(page, 'opened')).toBe(1);
  const alpha = await page.evaluate(() => {
    const s = (window as any).__gameRef.state.getCurrentState() as any;
    return s?.name === 'event' ? s.transitionAlpha : null;
  });
  expect(alpha).toBe(0);
});

test('only_once events stay spent across level loads (Python already_triggered_events)', async ({ page }) => {
  await boot(page);
  const fired = await page.evaluate(async () => {
    const g = (window as any).__gameRef;
    g.db.events.set('qa_once', {
      name: 'qa_once', nid: 'qa_once', trigger: 'qa_once', level_nid: null,
      condition: 'True', only_once: true, priority: 0, _source: ['game_var;qa_once_count;1'],
    });
    const first = g.eventManager.triggerSpecific('qa_once', { type: 'qa_once' });
    g.cleanUpLevel();
    await g.loadLevel(g.db.levels.keys().next().value);
    const second = g.eventManager.triggerSpecific('qa_once', { type: 'qa_once' });
    return { first, second };
  });
  expect(fired.first).toBe(true);
  expect(fired.second).toBe(false);
});

test('buildNew resets save-scoped state and rolls a random seed', async ({ page }) => {
  await boot(page);
  const result = await page.evaluate(() => {
    const g = (window as any).__gameRef;
    g.gameVars.set('Floor', 12);
    g.playtime = 5000;
    g.eventManager.restoreOnceTriggered(['stale']);
    g.buildNew();
    return {
      floor: g.gameVars.get('Floor'),
      seed: g.gameVars.get('_random_seed'),
      playtime: g.playtime,
      units: g.units.size,
      once: [...g.eventManager.getOnceTriggered()],
    };
  });
  expect(result.floor).toBeUndefined();
  expect(Number.isInteger(result.seed)).toBe(true);
  expect(result.seed).toBeGreaterThanOrEqual(0);
  expect(result.seed).toBeLessThan(1024);
  expect(result.playtime).toBe(0);
  expect(result.units).toBe(0);
  expect(result.once).toEqual([]);
});

test('New Game picks a save slot and starts the first non-DEBUG level', async ({ page }) => {
  await boot(page, '0');
  await page.evaluate(() => {
    const g = (window as any).__gameRef;
    g.gameVars.set('stale_var', 1);
    g.state.clear();
    g.state.change('title_new');
  });
  await stepFrames(page, 5);
  expect(await page.evaluate(() => (window as any).__gameRef.state.getCurrentState()?.name)).toBe('title_new');
  // Wait for slot metadata, then select the first slot.
  await page.waitForFunction(() => ((window as any).__gameRef.state.getCurrentState() as any)?.loaded === true);
  // Python TitleLoadState ignores input until the slot list has slid in.
  await stepFrames(page, 10);
  await page.evaluate(() => (window as any).__harness.stepFrames(1, 'SELECT'));
  // The harness drives frames manually; keep stepping while the level loads.
  for (let i = 0; i < 200; i++) {
    const done = await page.evaluate(() => (window as any).__gameRef.state.getStackNames().includes('free'));
    if (done) break;
    await page.waitForTimeout(100);
    await stepFrames(page, 2);
  }
  const after = await page.evaluate(() => {
    const g = (window as any).__gameRef;
    const levels = [...g.db.levels.keys()];
    const expected = levels[0] === 'DEBUG' ? levels[1] : levels[0];
    return { level: g.currentLevel?.nid, expected, stale: g.gameVars.get('stale_var'), slot: g.currentSaveSlot };
  });
  expect(after.level).toBe(after.expected);
  expect(after.stale).toBeUndefined();
  expect(after.slot).toBe(0);
});

test('icon sheets drop the LT colorkey background', async ({ page }) => {
  await boot(page);
  const alpha = await page.evaluate(async () => {
    const mod = await import('/src/ui/icons.ts');
    // Build an RGB sheet whose background is the (128,160,128) key.
    const c = document.createElement('canvas');
    c.width = 16; c.height = 16;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = 'rgb(128,160,128)';
    ctx.fillRect(0, 0, 16, 16);
    ctx.fillStyle = 'rgb(200,10,10)';
    ctx.fillRect(4, 4, 8, 8);
    const url = c.toDataURL('image/png');
    const origFetchImage = window.Image;
    void origFetchImage;
    // Route the sheet load through a blob URL by temporarily patching Image src.
    const OrigImage = window.Image;
    (window as any).Image = function () {
      const img = new OrigImage();
      const desc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src')!;
      Object.defineProperty(img, 'src', { set(v: string) { desc.set!.call(img, v.includes('qa_key_sheet') ? url : v); }, get() { return desc.get!.call(img); } });
      return img;
    } as any;
    const sheet = await mod.loadIconSheet('qa_key_sheet', '16');
    (window as any).Image = OrigImage;
    const probe = document.createElement('canvas');
    probe.width = 16; probe.height = 16;
    const pctx = probe.getContext('2d')!;
    pctx.drawImage(sheet as CanvasImageSource, 0, 0);
    return { corner: pctx.getImageData(0, 0, 1, 1).data[3], center: pctx.getImageData(8, 8, 1, 1).data[3] };
  });
  expect(alpha.corner).toBe(0);
  expect(alpha.center).toBe(255);
});

test('skip_save only sets the level var and never writes a save', async ({ page }) => {
  await boot(page);
  await runEvent(page, 'qa_skip_save', ['skip_save;t', 'game_var;after_skip;1'], 10);
  const result = await page.evaluate(async () => {
    const g = (window as any).__gameRef;
    const save = await import('/src/engine/save.ts');
    const slots = await save.loadSaveSlots(g.db.getConstant('game_nid', 'default'), 3);
    return { skip: g.levelVars.get('_skip_save'), saved: slots.some((s: any) => s.name !== '--NO DATA--') };
  });
  expect(await gameVar(page, 'after_skip')).toBe(1);
  expect(result.skip).toBe(true);
  expect(result.saved).toBe(false);
});

test('chapter end shows the between-chapter save unless _skip_save is set', async ({ page }) => {
  await boot(page, '0');
  await page.evaluate(() => {
    const g = (window as any).__gameRef;
    g.db.events.set('qa_end', {
      name: 'qa_end', nid: 'qa_end', trigger: 'qa_end', level_nid: null,
      condition: 'True', only_once: false, priority: 0, _source: ['win_game'],
    });
    g.eventManager.triggerSpecific('qa_end', { type: 'qa_end' }, true);
    if (g.state.getCurrentState()?.name !== 'event') g.state.change('event');
  });
  let stack: string[] = [];
  for (let i = 0; i < 300; i++) {
    stack = await page.evaluate(() => (window as any).__gameRef.state.getStackNames());
    if (stack.includes('title_save')) break;
    await page.waitForTimeout(30);
    // Advance any authored level_end dialog.
    await page.evaluate(() => (window as any).__harness.stepFrames(2, 'SELECT'));
  }
  expect(stack).toContain('title_save');
  // BACK proceeds into the next chapter without saving.
  await page.waitForFunction(() => ((window as any).__gameRef.state.getCurrentState() as any)?.loading === false);
  await page.evaluate(() => (window as any).__harness.stepFrames(1, 'BACK'));
  await stepFrames(page, 5);
  const after = await page.evaluate(() => (window as any).__gameRef.state.getStackNames());
  expect(after).not.toContain('title_save');
  expect(after[0]).toBe('free');
});

const press = (page: Page, input: string) =>
  page.evaluate((key) => (window as any).__harness.stepFrames(1, key), input);
const choiceState = (page: Page) => page.evaluate(() => {
  const s = (window as any).__gameRef.state.getCurrentState() as any;
  return { open: !!s?.choiceMenu, index: s?.choiceMenu?.selectedIndex ?? null };
});

test('choice: BACK is refused unless backable/persist; backable stores BACK only', async ({ page }) => {
  await boot(page);
  await runEvent(page, 'qa_choice_back', [
    'game_var;_last_choice;prev',
    'choice;pick;Pick one;A,B',
    'game_var;after_pick;1',
    'choice;pick2;Pick again;C,D;backable',
    'game_var;after_pick2;1',
  ], 5);
  await press(page, 'BACK');
  await stepFrames(page, 2);
  expect((await choiceState(page)).open).toBe(true);
  expect(await gameVar(page, 'after_pick')).toBeUndefined();
  await press(page, 'DOWN');
  await press(page, 'SELECT');
  await stepFrames(page, 3);
  expect(await gameVar(page, 'pick')).toBe('B');
  expect(await gameVar(page, '_last_choice')).toBe('B');
  expect(await gameVar(page, 'after_pick')).toBe(1);
  await press(page, 'BACK');
  await stepFrames(page, 3);
  expect(await gameVar(page, 'pick2')).toBe('BACK');
  expect(await gameVar(page, '_last_choice')).toBe('B');
  expect(await gameVar(page, 'after_pick2')).toBe(1);
});

test('choice: positional EventNid runs, hover var tracks the cursor, persist re-opens', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => {
    const g = (window as any).__gameRef;
    g.db.events.set('qa_sub', {
      name: 'qa_sub', nid: 'qa_sub', trigger: null, level_nid: null,
      condition: 'True', only_once: false, priority: 0, _source: ['inc_game_var;sub_runs'],
    });
  });
  await runEvent(page, 'qa_choice_persist', [
    'choice;menu;Menu;X,Y,Z;;;left;;qa_sub;;;;persist',
    'game_var;menu_done;1',
  ], 5);
  expect(await gameVar(page, 'menu_choice_hover')).toBe('X');
  await press(page, 'DOWN');
  await stepFrames(page, 1);
  expect(await gameVar(page, 'menu_choice_hover')).toBe('Y');
  await press(page, 'SELECT');
  await stepFrames(page, 8);
  expect(await gameVar(page, 'menu')).toBe('Y');
  expect(await gameVar(page, 'sub_runs')).toBe(1);
  // Persistent: the menu is back, cursor kept, parent not yet resumed.
  const reopened = await choiceState(page);
  expect(reopened.open).toBe(true);
  expect(reopened.index).toBe(1);
  expect(await gameVar(page, 'menu_done')).toBeUndefined();
  await press(page, 'BACK');
  await stepFrames(page, 3);
  expect(await gameVar(page, 'menu_done')).toBe(1);
});

test('styled text colours reach bitmap fonts drawn by nid', async ({ page }) => {
  await boot(page);
  const colors = await page.evaluate(async () => {
    const { Surface } = await import('/src/engine/surface.ts');
    const { drawStyledText } = await import('/src/ui/styled-text.ts');
    const sample = (markup: string) => {
      const surf = new Surface(64, 16, 1);
      drawStyledText(surf, markup, 0, 0, 'white', 'text');
      const data = surf.ctx.getImageData(0, 0, 64, 16).data;
      let red = 0;
      let white = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] === 0) continue;
        if (data[i] > 180 && data[i + 1] < 120) red++;
        if (data[i] > 200 && data[i + 1] > 200 && data[i + 2] > 200) white++;
      }
      return { red, white };
    };
    return { plain: sample('HHHH'), red: sample('<red>HHHH</>') };
  });
  expect(colors.plain.red).toBe(0);
  expect(colors.red.red).toBeGreaterThan(0);
});

test('expression unit proxy falls back to prefab fields like portrait_nid', async ({ page }) => {
  await boot(page);
  const value = await page.evaluate(async () => {
    const g = (window as any).__gameRef;
    const { evaluateExpression } = await import('/src/events/event-manager.ts');
    const unit = [...g.units.values()].find((u: any) => u.portraitNid);
    return { expected: unit.portraitNid, got: evaluateExpression(`u('${unit.nid}').portrait_nid`, { game: g, gameVars: g.gameVars, levelVars: g.levelVars }) };
  });
  expect(value.got).toBe(value.expected);
});

test('queuing the already-top state twice does not drain the stack', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => {
    const g = (window as any).__gameRef;
    g.db.events.set('qa_dup', {
      name: 'qa_dup', nid: 'qa_dup', trigger: 'qa_dup', level_nid: null,
      condition: 'True', only_once: false, priority: 0, _source: ['wait;100'],
    });
    g.eventManager.triggerSpecific('qa_dup', { type: 'qa_dup' }, true);
    g.state.change('event');
    g.state.change('event');
  });
  await stepFrames(page, 40);
  const stack = await page.evaluate(() => (window as any).__gameRef.state.getStackNames());
  expect(stack).toEqual(['free']);
});

test('speak honours speak styles and runs inline {c:} commands mid-line', async ({ page }) => {
  await boot(page);
  await runEvent(page, 'qa_speak_style', [
    'speak;;Hello there.{c:game_var;inline_ran;1} More.;center;;cinematic',
  ], 4);
  const box = await page.evaluate(() => {
    const s = (window as any).__gameRef.state.getCurrentState() as any;
    const d = s.dialog;
    return { font: d?.fontType, color: d?.fontColor, lines: d?.numLines, bg: d?.backgroundName, pos: d?.position, h: d?.height };
  });
  expect(box.font).toBe('chapter');
  expect(box.color).toBe('grey');
  expect(box.lines).toBe(5);
  expect(box.bg).toBeNull();
  const vh = await page.evaluate(async () => (await import('/src/engine/viewport.ts')).viewport.height);
  expect(box.pos[1]).toBe(Math.floor(vh / 2) - Math.floor(box.h / 2));
  for (let i = 0; i < 20 && (await gameVar(page, 'inline_ran')) !== 1; i++) await stepFrames(page, 5);
  expect(await gameVar(page, 'inline_ran')).toBe(1);
  const text = await page.evaluate(() => ((window as any).__gameRef.state.getCurrentState() as any).dialog?.displayedText ?? '');
  expect(text.startsWith('Hello there.')).toBe(true);
});

// ---------------------------------------------------------------------------
// Tactical menus (Python general_states MenuState / ItemChildState /
// OptionMenuState / TradeState / CantoWaitState)
// ---------------------------------------------------------------------------

const stackNames = (page: Page) =>
  page.evaluate(() => (window as any).__gameRef.state.getStackNames() as string[]);
const topMenuLabels = (page: Page) => page.evaluate(() => {
  const s = (window as any).__gameRef.state.getCurrentState() as any;
  return (s?.menu?.options ?? []).map((o: any) => o.label) as string[];
});

async function openUnitMenu(page: Page, nid: string): Promise<void> {
  await page.evaluate((unitNid) => {
    const g = (window as any).__gameRef;
    const u = g.getUnit(unitNid);
    g.cursor.setPos(u.position[0], u.position[1]);
  }, nid);
  await press(page, 'SELECT');
  await stepFrames(page, 2);
  await press(page, 'SELECT');
  await stepFrames(page, 3);
}

async function chooseMenuLabel(page: Page, label: string): Promise<void> {
  const ok = await page.evaluate((wanted) => {
    const s = (window as any).__gameRef.state.getCurrentState() as any;
    const menu = s.confirm ?? s.child ?? s.menu;
    const index = menu.options.findIndex((o: any) => o.label === wanted);
    if (index < 0) return false;
    menu.selectedIndex = index;
    return true;
  }, label);
  expect(ok, `menu option ${label}`).toBe(true);
  await press(page, 'SELECT');
  await stepFrames(page, 3);
}

test('trading returns to the action menu; BACK then commits and waits', async ({ page }) => {
  await boot(page);
  // Pegasus_Knight learns Canto at level 1; without it the trade commits.
  await page.evaluate(() => {
    const u = (window as any).__gameRef.getUnit('Vanessa');
    u.skills = u.skills.filter((s: any) => s.nid !== 'Canto');
    u.hasCanto = false;
  });
  await openUnitMenu(page, 'Vanessa');
  // Pegasus_Knight's class tag Mounted makes RESCUE_AID 25 - CON, as Python
  // reads unit.tags with class tags, so an adjacent ally can be rescued.
  expect(await topMenuLabels(page)).toEqual(['Rescue', 'Item', 'Trade', 'Wait']);
  await chooseMenuLabel(page, 'Trade');
  // Python TargetingState: the cursor starts on the partner; SELECT opens the trade.
  expect((await stackNames(page)).at(-1)).toBe('targeting');
  await press(page, 'SELECT');
  await stepFrames(page, 2);
  expect((await stackNames(page)).at(-1)).toBe('trade');
  const before = await page.evaluate(() => (window as any).__gameRef.getUnit('Vanessa').items.map((i: any) => i.nid));
  await press(page, 'SELECT');
  await press(page, 'SELECT');
  await stepFrames(page, 2);
  const after = await page.evaluate(() => (window as any).__gameRef.getUnit('Vanessa').items.map((i: any) => i.nid));
  expect(after).not.toEqual(before);
  await press(page, 'BACK');
  await stepFrames(page, 3);
  // Python TradeState.back -> MenuState; trading again is still offered.
  expect((await stackNames(page)).at(-1)).toBe('menu');
  expect(await topMenuLabels(page)).toContain('Trade');
  let flags = await page.evaluate(() => {
    const u = (window as any).__gameRef.getUnit('Vanessa');
    return { finished: u.finished, traded: u.hasTraded };
  });
  expect(flags).toEqual({ finished: false, traded: true });
  await press(page, 'BACK');
  await stepFrames(page, 3);
  flags = await page.evaluate(() => {
    const u = (window as any).__gameRef.getUnit('Vanessa');
    return { finished: u.finished, traded: u.hasTraded };
  });
  expect(flags.finished).toBe(true);
  expect(await stackNames(page)).toEqual(['free']);
});

test('Canto after a trade moves again and offers only canto_wait', async ({ page }) => {
  await boot(page);
  // Vanessa's class (Pegasus_Knight) gives her Canto.
  expect(await page.evaluate(() =>
    (window as any).__gameRef.getUnit('Vanessa').skills.some((s: any) => s.nid === 'Canto'))).toBe(true);
  await openUnitMenu(page, 'Vanessa');
  await chooseMenuLabel(page, 'Trade');
  await press(page, 'SELECT');
  await stepFrames(page, 2);
  await press(page, 'SELECT');
  await press(page, 'SELECT');
  await press(page, 'BACK');
  await stepFrames(page, 3);
  await press(page, 'BACK');
  await stepFrames(page, 3);
  expect((await stackNames(page)).at(-1)).toBe('move');
  // A Canto unit cannot cancel its committed action.
  await press(page, 'BACK');
  await stepFrames(page, 2);
  expect((await stackNames(page)).at(-1)).toBe('move');
  const target = await page.evaluate(() => {
    const g = (window as any).__gameRef;
    const u = g.getUnit('Vanessa');
    const moves = g.state.getCurrentState().validMoves as [number, number][];
    const dest = moves.find(([x, y]) => (x !== u.position[0] || y !== u.position[1]) && !g.board.getUnit(x, y))!;
    g.cursor.setPos(dest[0], dest[1]);
    return dest;
  });
  await press(page, 'SELECT');
  for (let i = 0; i < 40 && (await stackNames(page)).at(-1) !== 'canto_wait'; i++) await stepFrames(page, 3);
  expect((await stackNames(page)).at(-1)).toBe('canto_wait');
  expect(await topMenuLabels(page)).toEqual(['Wait']);
  await press(page, 'SELECT');
  await stepFrames(page, 3);
  const unit = await page.evaluate(() => {
    const u = (window as any).__gameRef.getUnit('Vanessa');
    return { finished: u.finished, position: u.position };
  });
  expect(unit).toEqual({ finished: true, position: target });
});

test('action menu offers Spells for staff users and routes them to item targeting', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => {
    const g = (window as any).__gameRef;
    const v = g.getUnit('Vanessa');
    v.currentHp = Math.max(1, v.currentHp - 5);
  });
  await openUnitMenu(page, 'Moulder');
  const labels = await topMenuLabels(page);
  expect(labels[0]).toBe('Spells');
  expect(labels).not.toContain('Attack');
  await chooseMenuLabel(page, 'Spells');
  expect((await stackNames(page)).at(-1)).toBe('weapon_choice');
  expect(await topMenuLabels(page)).toEqual(['Heal']);
  await press(page, 'SELECT');
  await stepFrames(page, 3);
  expect((await stackNames(page)).at(-1)).toBe('item_targeting');
});

test('item menu: Python item rows, child options, discard confirm', async ({ page }) => {
  await boot(page);
  await openUnitMenu(page, 'Vanessa');
  await chooseMenuLabel(page, 'Item');
  expect((await stackNames(page)).at(-1)).toBe('item');
  const rows = await page.evaluate(() => {
    const s = (window as any).__gameRef.state.getCurrentState() as any;
    return { width: s.menu.width, rows: s.menu.options.map((o: any) => [o.label, !!o.itemRow]) };
  });
  expect(rows.width).toBe(104);
  expect(rows.rows).toEqual([['Slim Lance', true], ['Javelin', true], ['Vulnerary', true]]);
  await page.evaluate(() => { ((window as any).__gameRef.state.getCurrentState() as any).menu.selectedIndex = 1; });
  await press(page, 'SELECT');
  await stepFrames(page, 2);
  const child = await page.evaluate(() => {
    const s = (window as any).__gameRef.state.getCurrentState() as any;
    return { labels: s.child.options.map((o: any) => o.label), y: s.child.y, px: s.menu.x, py: s.menu.y };
  });
  expect(child.labels).toEqual(['Equip', 'Trade', 'Discard']);
  // Python Simple.get_topleft beside the parent's current row.
  expect(child.y).toBe(child.py + 16 + (child.px < 120 ? 4 : 8));
  await chooseMenuLabel(page, 'Discard');
  await chooseMenuLabel(page, 'Yes');
  const items = await page.evaluate(() => (window as any).__gameRef.getUnit('Vanessa').items.map((i: any) => i.nid));
  expect(items).toEqual(['Slim_Lance', 'Vulnerary']);
});

test('free state: BACK does nothing, START opens the minimap', async ({ page }) => {
  await boot(page);
  await press(page, 'BACK');
  await stepFrames(page, 2);
  expect(await stackNames(page)).toEqual(['free']);
  await press(page, 'START');
  await stepFrames(page, 2);
  expect((await stackNames(page)).at(-1)).toBe('minimap');
});

test('option menu follows Python order and confirms End', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => (window as any).__gameRef.state.change('option_menu'));
  await stepFrames(page, 2);
  const labels = await topMenuLabels(page);
  // Permadeath mode: Suspend instead of Save; End last; no Minimap entry.
  expect(labels.slice(-3)).toEqual(['Options', 'Suspend', 'End']);
  expect(labels[0]).toBe('Objective');
  expect(labels).not.toContain('Minimap');
  await chooseMenuLabel(page, 'End');
  const confirm = await page.evaluate(() =>
    ((window as any).__gameRef.state.getCurrentState() as any).confirm?.options.map((o: any) => o.label));
  expect(confirm).toEqual(['Yes', 'No']);
  await chooseMenuLabel(page, 'No');
  expect((await stackNames(page)).at(-1)).toBe('option_menu');
  expect(await page.evaluate(() => (window as any).__gameRef.phase.getCurrent())).toBe('player');
  await chooseMenuLabel(page, 'End');
  await chooseMenuLabel(page, 'Yes');
  await stepFrames(page, 5);
  expect(await stackNames(page)).not.toContain('option_menu');
  expect(await page.evaluate(() => (window as any).__gameRef.phase.getCurrent())).not.toBe('player');
});

test('prep Fight resumes the level-start stack so the player phase change runs', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => {
    const g = (window as any).__gameRef;
    g.levelVars.delete('_turn1_upkeep_done');
    g.cursor.setPos(0, 0);
    g.db.events.set('qa_prep', {
      name: 'qa_prep', nid: 'qa_prep', trigger: 'qa_prep', level_nid: null,
      condition: 'True', only_once: false, priority: 0, _source: ['prep', 'game_var;after_prep;1'],
    });
    g.eventManager.triggerSpecific('qa_prep', { type: 'qa_prep' }, true);
    // The level-start stack (enterStartedLevel): free, status_upkeep,
    // phase_change, then the level_start event on top.
    g.state.clear();
    g.state.change('free');
    g.state.change('status_upkeep');
    g.state.change('phase_change');
    g.state.change('event');
  });
  for (let i = 0; i < 40 && (await stackNames(page)).at(-1) !== 'prep_main'; i++) await stepFrames(page, 3);
  expect(await stackNames(page)).toEqual(['free', 'status_upkeep', 'phase_change', 'event', 'prep_main']);
  await page.evaluate(() => ((window as any).__gameRef.state.getCurrentState() as any).fight());
  for (let i = 0; i < 100 && (await stackNames(page)).join() !== 'free'; i++) await stepFrames(page, 5);
  expect(await stackNames(page)).toEqual(['free']);
  const result = await page.evaluate(() => {
    const g = (window as any).__gameRef;
    return {
      after: g.gameVars.get('after_prep'),
      upkeep: g.levelVars.get('_turn1_upkeep_done'),
      cursor: g.cursor.getPosition(),
      lord: g.getUnit('Eirika').position,
    };
  });
  expect(result.after).toBe(1);
  expect(result.upkeep).toBe(true);
  // PhaseIn autocursor: the Lord-tagged unit.
  expect(result.cursor).toEqual(result.lord);
});

test('settings persist globally', async ({ page }) => {
  await boot(page);
  const result = await page.evaluate(async () => {
    const settings = await import('/src/engine/states/settings-state.ts');
    settings.setSetting('unit_speed', 50);
    return {
      stored: JSON.parse(localStorage.getItem('lt-web-settings') ?? '{}').unit_speed,
      read: settings.getSetting('unit_speed'),
    };
  });
  expect(result).toEqual({ stored: 50, read: 50 });
});

test('choice menus use Python Simple sizing (text + 24, floored to 8)', async ({ page }) => {
  await boot(page);
  const sizes = await page.evaluate(async () => {
    const { ChoiceMenu } = await import('/src/ui/menu.ts');
    const { measureStyledText } = await import('/src/ui/styled-text.ts');
    const menu = new ChoiceMenu([
      { label: 'Rescue', value: 'r', enabled: true },
      { label: 'Wait', value: 'w', enabled: true },
    ], 0, 0);
    const w = measureStyledText('Rescue', 'text') + 24;
    return { width: menu.width, expected: w - (w % 8) };
  });
  expect(sizes.width).toBe(sizes.expected);
});

test('objective loss text alone never forces a game over (Python: events own lose_game)', async ({ page }) => {
  await boot(page);
  const setup = await page.evaluate(() => {
    const g = (window as any).__gameRef;
    const victim = g.getUnit('Moulder');
    const enemy = g.getUnit('Bone');
    g.currentLevel.objective = { ...g.currentLevel.objective, loss: 'Moulder dies' };
    const spot = [[1, 0], [-1, 0], [0, 1], [0, -1]]
      .map(([dx, dy]) => [victim.position[0] + dx, victim.position[1] + dy])
      .find(([x, y]) => g.board.inBounds(x, y) && !g.board.getUnit(x, y));
    if (!spot) return false;
    g.board.moveUnit(enemy, spot[0], spot[1]);
    victim.currentHp = 1;
    g.selectedUnit = enemy;
    g.combatTarget = victim;
    g.combatScript = ['hit1', 'end'];
    g.memory.set('combat_item', enemy.items[0]);
    g.state.change('combat');
    return true;
  });
  expect(setup).toBe(true);
  await stepFrames(page, 2);
  for (let i = 0; i < 120; i++) {
    const done = await page.evaluate(() => (window as any).__gameRef.state.getCurrentState()?.name !== 'combat');
    if (done) break;
    await page.evaluate(() => (window as any).__harness.stepFrames(10, null));
    await page.waitForTimeout(50);
  }
  const result = await page.evaluate(() => {
    const g = (window as any).__gameRef;
    return { dead: g.getUnit('Moulder').isDead(), stack: g.state.getStackNames() };
  });
  expect(result.dead).toBe(true);
  expect(result.stack).not.toContain('game_over');
});

test('expressions support Python seq.index (EOtF hub music track list)', async ({ page }) => {
  await boot(page);
  const values = await page.evaluate(async () => {
    const { evaluateExpression } = await import('/src/events/event-manager.ts');
    const g = (window as any).__gameRef;
    const ctx = { game: g, gameVars: g.gameVars, levelVars: g.levelVars };
    return [
      evaluateExpression("[1, 2, 3].index(2)", ctx),
      evaluateExpression("'abc'.index('c')", ctx),
      evaluateExpression("[str(['Track 1','Track 2'].index(s)) + '|' + s for s in ['Track 1','Track 2']]", ctx),
    ];
  });
  expect(values).toEqual([1, 2, ['0|Track 1', '1|Track 2']]);
});

test('free roam fades in the level phase music on begin (Python FreeRoamState.begin)', async ({ page }) => {
  await boot(page);
  const calls = await page.evaluate(async () => {
    const g = (window as any).__gameRef;
    const seen: string[] = [];
    g.audioManager.fadeIn = async (nid: string) => { seen.push(nid); };
    g.currentLevel.music = { ...(g.currentLevel.music ?? {}), player_phase: 'QA_Hub_Song' };
    g.roamInfo.roam = true;
    g.roamInfo.roamUnitNid = 'Eirika';
    g.state.change('free_roam');
    (window as any).__harness.stepFrames(3, null);
    return seen;
  });
  expect(calls).toContain('QA_Hub_Song');
});

test('choice sub-events draw the paused parent (tables + chosen menu) underneath', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => {
    const g = (window as any).__gameRef;
    g.db.events.set('qa_sub_child', {
      name: 'qa_sub_child', nid: 'qa_sub_child', trigger: null, level_nid: null,
      condition: 'True', only_once: false, priority: 0, _source: ['speak;;Child running'],
    });
  });
  await runEvent(page, 'qa_sub_parent', [
    'table;qa_tbl;A,B;;1,2',
    'choice;qa_pick;Pick;X,Y;EventNid=qa_sub_child',
    'game_var;after_parent;1',
  ], 5);
  await press(page, 'SELECT');
  await stepFrames(page, 6);
  const drawn = await page.evaluate(() => {
    const g = (window as any).__gameRef;
    const s = g.state.getCurrentState() as any;
    let tableDraws = 0;
    let menuDraws = 0;
    const original = s.drawEventTables.bind(s);
    s.drawEventTables = (surf: any) => { if (s.eventTables.has('qa_tbl')) tableDraws++; original(surf); };
    const suspended = s.suspendedChoiceEvents.at(-1);
    if (suspended?.menu) {
      const drawMenu = suspended.menu.draw.bind(suspended.menu);
      suspended.menu.draw = (surf: any) => { menuDraws++; drawMenu(surf); };
    }
    (window as any).__harness.stepFrames(1, null);
    s.drawEventTables = original;
    return { parked: s.parkedOrder.length, tableDraws, menuDraws, child: !!s.dialog };
  });
  expect(drawn.child).toBe(true);
  expect(drawn.parked).toBeGreaterThan(0);
  expect(drawn.tableDraws).toBeGreaterThan(0);
  expect(drawn.menuDraws).toBeGreaterThan(0);
});

test('phase change shows the Python turnbanner (PhaseIn)', async ({ page }) => {
  await boot(page);
  const info = await page.evaluate(() => {
    const g = (window as any).__gameRef;
    g.state.change('phase_change');
    (window as any).__harness.stepFrames(2, null);
    const s = g.state.getCurrentState() as any;
    return { name: s.name, banner: s.banner?.constructor?.name ?? null };
  });
  expect(info).toEqual({ name: 'phase_change', banner: 'PhaseIn' });
});

test('a missing {v:} becomes ?? and an un-evaluable if is False (EOtF gacha Recall)', async ({ page }) => {
  await boot(page);
  await runEvent(page, 'qa_missing_var', [
    'if;len({v:qa_never_set}) > 0',
    '    game_var;qa_branch;then',
    'else',
    '    game_var;qa_branch;else',
    'end',
    'game_var;qa_text;x{v:qa_never_set}y',
  ], 10);
  expect(await gameVar(page, 'qa_branch')).toBe('else');
  expect(await gameVar(page, 'qa_text')).toBe('x??y');
});

test('suspend saves the stack beneath the menu and Continue restores it with autocursor', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => (window as any).__gameRef.cursor.setPos(0, 0));
  await page.evaluate(() => (window as any).__gameRef.state.change('option_menu'));
  await stepFrames(page, 2);
  await chooseMenuLabel(page, 'Suspend');
  await chooseMenuLabel(page, 'Yes');
  for (let i = 0; i < 50 && (await stackNames(page)).at(-1) !== 'title'; i++) {
    await page.waitForTimeout(50);
    await stepFrames(page, 2);
  }
  expect((await stackNames(page)).at(-1)).toBe('title');
  const saved = await page.evaluate(async () => {
    const { loadSuspend } = await import('/src/engine/save.ts');
    const g = (window as any).__gameRef;
    g.cursor.setPos(0, 0);
    const ok = await loadSuspend(g);
    return { ok, stack: g.state.getStackNames() };
  });
  expect(saved).toEqual({ ok: true, stack: ['free'] });
  const after = await page.evaluate(async () => {
    const { resumeLoadedGame } = await import('/src/engine/states/save-load-state.ts');
    const g = (window as any).__gameRef;
    await resumeLoadedGame(g, 'suspend');
    (window as any).__harness.stepFrames(2, null);
    return { stack: g.state.getStackNames(), cursor: g.cursor.getPosition(), lord: g.getUnit('Eirika').position };
  });
  expect(after.stack).toEqual(['free']);
  expect(after.cursor).toEqual(after.lord);
});

test('expressions expose DB.weapon_ranks and unit_funcs.usable_wtypes (EOtF reward Availability table)', async ({ page }) => {
  await boot(page);
  const values = await page.evaluate(async () => {
    const { evaluateExpression } = await import('/src/events/event-manager.ts');
    const g = (window as any).__gameRef;
    const ctx = { game: g, gameVars: g.gameVars, levelVars: g.levelVars };
    const firstRank = g.db.weaponRanks[0];
    return {
      rank: evaluateExpression(`DB.weapon_ranks.get('${firstRank.rank}').requirement`, ctx),
      expected: firstRank.requirement,
      sword: evaluateExpression("'Sword' in unit_funcs.usable_wtypes(game.get_unit('Eirika'))", ctx),
      axe: evaluateExpression("'Axe' in unit_funcs.usable_wtypes(game.get_unit('Eirika'))", ctx),
    };
  });
  expect(values.rank).toBe(values.expected);
  expect(values.sword).toBe(true);
  expect(values.axe).toBe(false);
});

test('event tables show the text of nid|text entries (Python SimpleMenuUI.parse_data)', async ({ page }) => {
  await boot(page);
  await runEvent(page, 'qa_table_split', [
    'table;qa_split;[\'Eirika|<green>Hero</>\', \'Seth|Knight\'];Title;2,1;80;EntryType=type_unit;expression',
    'speak;;hold',
  ], 6);
  const drawn = await page.evaluate(async () => {
    const { Surface } = await import('/src/engine/surface.ts');
    const s = (window as any).__gameRef.state.getCurrentState() as any;
    const surf = new Surface(240, 160);
    const texts: string[] = [];
    const original = surf.drawText.bind(surf);
    (surf as any).drawText = (text: string, ...rest: any[]) => { texts.push(text); return original(text, ...rest); };
    s.drawEventTables(surf);
    return texts;
  });
  expect(drawn).toContain('Hero');
  expect(drawn).toContain('Knight');
  expect(drawn.join(' ')).not.toContain('|');
});

test('give_money;N;no_banner does not treat the flag as a party (money survived suspend)', async ({ page }) => {
  await boot(page);
  const before = await page.evaluate(() => (window as any).__gameRef.getMoney());
  await runEvent(page, 'qa_give_money_flag', ['give_money;200;no_banner', 'game_var;qa_done;1'], 10);
  const result = await page.evaluate(async () => {
    const g = (window as any).__gameRef;
    const { buildSaveDict } = await import('/src/engine/save.ts');
    const saved = buildSaveDict(g);
    return {
      money: g.getMoney(),
      partyKeys: [...g.parties.keys()],
      savedMoney: saved.parties.filter((p: any) => p.nid === g.currentParty).map((p: any) => p.money),
    };
  });
  expect(await gameVar(page, 'qa_done')).toBe(1);
  expect(result.money).toBe(before + 200);
  expect(result.partyKeys).not.toContain('no_banner');
  expect(result.savedMoney).toEqual([before + 200]);
});

test('title menu starts on Continue when a suspend exists (Python menus.Main index 0)', async ({ page }) => {
  await boot(page);
  await page.evaluate(async () => {
    const { suspendGame } = await import('/src/engine/save.ts');
    const g = (window as any).__gameRef;
    await suspendGame(g);
    g.state.clear();
    g.state.change('title_main');
  });
  let info: { options: string[]; current: string | null } = { options: [], current: null };
  for (let i = 0; i < 40 && !info.options.includes('Continue'); i++) {
    await stepFrames(page, 2);
    await page.waitForTimeout(25);
    info = await page.evaluate(() => {
      const s = (window as any).__gameRef.state.getCurrentState() as any;
      return { options: s.options ?? [], current: s.menu?.getCurrent?.() ?? null };
    });
  }
  expect(info.options[0]).toBe('Continue');
  expect(info.current).toBe('Continue');
});

test('{e:} resolves {d:Data.{v:key}.field} with the raw key (EOtF upgrade costs)', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => {
    const g = (window as any).__gameRef;
    if (!g.db.rawData) g.db.rawData = new Map();
    g.db.rawData.set('QA_Upgrades', [{ nid: 'Gold_Up', cost: 100, cost_mult: 2 }]);
    g.gameVars.set('qa_hover', 'Gold_Up');
  });
  await runEvent(page, 'qa_data_key', [
    "game_var;qa_cost;{e:int({d:QA_Upgrades.{v:qa_hover}.cost} * ({d:QA_Upgrades.{v:qa_hover}.cost_mult} ** 1))}",
  ], 6);
  expect(await gameVar(page, 'qa_cost')).toBe(200);
});

test('the Mouse setting off ignores mouse clicks (Python InputManager)', async ({ page }) => {
  await boot(page);
  const result = await page.evaluate(async () => {
    const settings = await import('/src/engine/states/settings-state.ts');
    const g = (window as any).__gameRef;
    const canvas = document.querySelector('canvas')!;
    const click = () => canvas.dispatchEvent(new MouseEvent('mousedown', { button: 0, clientX: 20, clientY: 20, bubbles: true }));
    settings.setSetting('mouse', 0);
    g.input.mouseClick = null;
    click();
    const off = g.input.mouseClick;
    settings.setSetting('mouse', 1);
    click();
    const on = g.input.mouseClick;
    g.input.mouseClick = null;
    return { off, on };
  });
  expect(result.off).toBeNull();
  expect(result.on).toBe('SELECT');
});

test('dialog talk boops follow the talk_boop setting and no_sound flag (Python Dialog.play_talk_boop)', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => {
    const g = (window as any).__gameRef;
    (window as any).__qaPlayed = [];
    const original = g.audioManager.playSfx.bind(g.audioManager);
    g.audioManager.playSfx = (nid: string) => { (window as any).__qaPlayed.push(nid); return original(nid); };
  });
  const reset = async () => page.evaluate(() => { (window as any).__qaPlayed = []; });
  const played = async () => page.evaluate(() => [...(window as any).__qaPlayed] as string[]);
  const setTalkBoop = async (value: number) => page.evaluate(async (v) => {
    const settings = await import('/src/engine/states/settings-state.ts');
    settings.setSetting('talk_boop', v);
  }, value);

  await setTalkBoop(1);
  await reset();
  await runEvent(page, 'qa_boop_on', ['speak;Narrator;Hello there my friend'], 40);
  // Throttled to one boop per 32 ms of real time (Python get_true_time).
  expect(await played()).toContain('Talk_Boop');
  await page.evaluate(() => (window as any).__gameRef.state.getCurrentState().takeInput('BACK'));
  await stepFrames(page, 10);

  await reset();
  await runEvent(page, 'qa_boop_flag', ['speak;Narrator;Hello there my friend;no_sound'], 40);
  expect(await played()).not.toContain('Talk_Boop');
  await page.evaluate(() => (window as any).__gameRef.state.getCurrentState().takeInput('BACK'));
  await stepFrames(page, 10);

  await setTalkBoop(0);
  await reset();
  await runEvent(page, 'qa_boop_off', ['speak;Narrator;Hello there my friend'], 40);
  expect(await played()).not.toContain('Talk_Boop');
  await page.evaluate(() => (window as any).__gameRef.state.getCurrentState().takeInput('SELECT'));
  expect(await played()).toContain('Select 1');
  await setTalkBoop(1);
});

test('grid_opacity and show_bounds settings draw the map grid and bounds (Python MapView.draw_grid)', async ({ page }) => {
  await boot(page);
  const result = await page.evaluate(async () => {
    const settings = await import('/src/engine/states/settings-state.ts');
    const g = (window as any).__gameRef;
    const harness = (window as any).__harness;
    g.state.change('free');
    harness.stepFrames(3, null);
    const canvas = document.querySelector('canvas') as HTMLCanvasElement;
    const ctx = canvas.getContext('2d')!;
    const scale = canvas.width / 240;
    const sample = (points: Array<[number, number]>) => {
      harness.stepFrames(1, null);
      return points.map(([x, y]) => Array.from(ctx.getImageData(x * scale, y * scale, 1, 1).data.slice(0, 3)).join(','));
    };
    const cull = g.camera.getCullRect();
    const offsetX = cull.x + 16;
    const offsetY = cull.y + 16;
    // A vertical grid line sits at world x = 16 * col - 1.
    const col = Math.floor(offsetX / 16) + 4;
    const lineX = 16 * col - 1 - offsetX;
    const points: Array<[number, number]> = [3, 5, 7, 9, 11].map((row) => [lineX, 16 * row + 8 - offsetY]);
    settings.setSetting('grid_opacity', 0);
    settings.setSetting('show_bounds', 0);
    const off = sample(points);
    settings.setSetting('grid_opacity', 255);
    const on = sample(points);
    settings.setSetting('grid_opacity', 0);

    // Bounds: thick lines just outside a non-regular board bound.
    const saved = [...g.board.bounds];
    const bx = Math.floor(offsetX / 16) + 2;
    const by = Math.floor(offsetY / 16) + 2;
    g.board.bounds = [bx, by, bx + 4, by + 4];
    const boundPoints: Array<[number, number]> = [1, 2, 3].map((k) => [bx * 16 - 1 - offsetX, (by + k) * 16 + 4 - offsetY]);
    const boundsOff = sample(boundPoints);
    settings.setSetting('show_bounds', 1);
    const boundsOn = sample(boundPoints);
    settings.setSetting('show_bounds', 0);
    g.board.bounds = saved;
    return { off, on, boundsOff, boundsOn };
  });
  expect(result.on).toEqual(['0,0,0', '0,0,0', '0,0,0', '0,0,0', '0,0,0']);
  expect(result.off.some((pixel) => pixel !== '0,0,0')).toBe(true);
  expect(result.boundsOn).not.toEqual(result.boundsOff);
});

test('unchoice re-opens the choice with the cursor where it was (Python PlayerChoiceState.unchoose)', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => {
    const g = (window as any).__gameRef;
    g.db.events.set('qa_unchoice_sub', {
      name: 'qa_unchoice_sub', nid: 'qa_unchoice_sub', trigger: null, level_nid: null,
      condition: 'True', only_once: false, priority: 0,
      _source: ['if;{v:qa_uc_count} < 1', 'game_var;qa_uc_count;{v:qa_uc_count} + 1', 'unchoice', 'end'],
    });
    g.gameVars.set('qa_uc_count', 0);
  });
  await runEvent(page, 'qa_unchoice_parent', [
    'choice;qa_uc;Pick;A,B,C,D;EventNid=qa_unchoice_sub',
    'game_var;qa_uc_done;1',
  ], 5);
  await press(page, 'DOWN');
  await press(page, 'DOWN');
  await press(page, 'SELECT');
  await stepFrames(page, 12);
  const after = await page.evaluate(() => {
    const s = (window as any).__gameRef.state.getCurrentState() as any;
    return { open: !!s.choiceMenu, index: s.choiceMenu?.selectedIndex ?? null };
  });
  expect(after).toEqual({ open: true, index: 2 });
});

test('type_chibi tables lay out like Python SimpleIconTable (bg centred on the cells)', async ({ page }) => {
  await boot(page);
  await runEvent(page, 'qa_chibi_table', [
    "table;qa_chibis;Amelia,Artur,Amelia,Artur;;1,4;32;top;;type_chibi",
    'wait;100000',
  ], 5);
  const record = async () => page.evaluate(() => {
    const s = (window as any).__gameRef.state.getCurrentState() as any;
    const blits: number[][] = [];
    const images: number[][] = [];
    const fake = {
      width: 240, height: 160, scale: 1,
      blit: (src: any, x: number, y: number) => blits.push([x, y, src.width, src.height]),
      ctx: { imageSmoothingEnabled: false, drawImage: (...a: number[]) => images.push(a.slice(5, 9)) },
    };
    s.drawEventTables(fake);
    return { blits, images };
  });
  await record();
  await page.waitForTimeout(500);
  const { blits, images } = await record();
  // Content 128x32 at ((240 - 128) / 2, 10); bg 136x40 centred on it.
  expect(blits[0]).toEqual([52, 6, 136, 40]);
  expect(images.map((a) => [a[0], a[1]])).toEqual([[56, 10], [88, 10], [120, 10], [152, 10]]);
});

test('AI Move_to Position Starting walks back to an empty start tile (Python SecondaryAI)', async ({ page }) => {
  await boot(page);
  const result = await page.evaluate(() => {
    const g = (window as any).__gameRef;
    const bone = g.units.get('Bone');
    const ai = g.aiController;
    const moves: [number, number][] = ai.pathSystem.getValidMoves(bone, g.board);
    const home = moves.find(([x, y]) => (x !== bone.position[0] || y !== bone.position[1]) && !g.board.getUnit(x, y));
    if (!home) return null;
    bone.startingPosition = [home[0], home[1]];
    g.db.ai.set('__qa_home', {
      nid: '__qa_home', priority: 0, offense_bias: 1,
      behaviours: [{ action: 'Move_to', target: 'Position', target_spec: 'Starting', view_range: -4,
        invert_targeting: false, roam_speed: 0, desired_proximity: 0, condition: '' }],
    });
    bone.ai = '__qa_home';
    const action = ai.getAction(bone);
    return { type: action.type, to: action.targetPosition, home };
  });
  expect(result).not.toBeNull();
  expect(result!.type).toBe('move');
  expect(result!.to).toEqual(result!.home);
});

test('AI Interact with no path to the region falls through to the next behaviour (Python SecondaryAI)', async ({ page }) => {
  await boot(page);
  const result = await page.evaluate(() => {
    const g = (window as any).__gameRef;
    const bone = g.units.get('Bone');
    const ai = g.aiController;
    const group = ai.pathSystem.getMovementGroup(bone);
    let wall: [number, number] | null = null;
    for (let y = 0; y < g.board.height && !wall; y++) {
      for (let x = 0; x < g.board.width && !wall; x++) {
        if (g.board.getMovementCost(x, y, group, g.db) >= 99 && !g.board.getUnit(x, y)) wall = [x, y];
      }
    }
    if (!wall) return null;
    g.currentLevel.regions.push({ nid: 'qa_wall', region_type: 'event', position: wall, size: [1, 1],
      sub_nid: 'QA_Wall', condition: 'True', time_left: null, only_once: false, interrupt_move: false });
    g.db.ai.set('__qa_wall', {
      nid: '__qa_wall', priority: 0, offense_bias: 1,
      behaviours: [
        { action: 'Interact', target: 'Event', target_spec: 'QA_Wall', view_range: -4,
          invert_targeting: false, roam_speed: 0, desired_proximity: 0, condition: '' },
        { action: 'Move_to', target: 'Position', target_spec: [bone.position[0], bone.position[1]], view_range: -4,
          invert_targeting: false, roam_speed: 0, desired_proximity: 0, condition: '' },
      ],
    });
    bone.ai = '__qa_wall';
    const action = ai.getAction(bone);
    g.currentLevel.regions = g.currentLevel.regions.filter((r: any) => r.nid !== 'qa_wall');
    return { type: action.type, to: action.targetPosition ?? null };
  });
  test.skip(result === null, 'no impassable tile on the DEBUG map');
  // The second behaviour targets Bone's own tile, so Python's AI is done and waits.
  expect(result).toEqual({ type: 'wait', to: null });
});

test('free state auto-ends the turn when no player units are left (Python FreeState.begin)', async ({ page }) => {
  await boot(page);
  const result = await page.evaluate(async () => {
    const settings = await import('/src/engine/states/settings-state.ts');
    settings.setSetting('autoend_turn', 1);
    const g = (window as any).__gameRef;
    for (const unit of Array.from(g.units.values()) as any[]) {
      if (unit.team === 'player' && unit.position) {
        g.board.removeUnit(unit);
        unit.position = null;
      }
    }
    g.state.change('free');
    (window as any).__harness.stepFrames(6, null);
    return { enemies: g.board.getTeamUnits('enemy').length, stack: g.state.getStackNames() };
  });
  expect(result.enemies).toBeGreaterThan(0);
  expect(result.stack).not.toEqual(['free']);
});

test('a bare transition toggles the event\'s own state, so close-then-open ends open after a black screen (Python Event.transition_state)', async ({ page }) => {
  await boot(page);
  // An earlier event in the same chain (EOtF's level-start scripts) leaves
  // the screen closed when this one starts.
  await page.evaluate(() => {
    const g = (window as any).__gameRef;
    const add = (nid: string, source: string[]) => g.db.events.set(nid, {
      name: nid, nid, trigger: nid, level_nid: g.currentLevel?.nid ?? null,
      condition: 'True', only_once: false, priority: 0, _source: source,
    });
    add('qa_transition_close', ['transition;close']);
    add('qa_transition_toggle', [
      'transition',
      'game_var;qa_between;1',
      'transition',
      'game_var;qa_after;1',
      'wait;100000',
    ]);
    g.eventManager.triggerSpecific('qa_transition_close', { type: 'qa_transition_close' }, true);
    g.eventManager.triggerSpecific('qa_transition_toggle', { type: 'qa_transition_toggle' }, true);
    g.state.change('event');
  });
  await stepFrames(page, 180);
  const result = await page.evaluate(() => {
    const g = (window as any).__gameRef;
    const s = g.state.getCurrentState() as any;
    return { after: g.gameVars.get('qa_after'), alpha: s.transitionAlpha, hold: s.transitionHoldBlack };
  });
  expect(result.after).toBe(1);
  expect(result.alpha).toBe(0);
  expect(result.hold).toBe(false);
});

test('main_menu returns to the title once its event ends (Python EventState.end_event)', async ({ page }) => {
  await boot(page);
  await runEvent(page, 'qa_main_menu', ['game_var;qa_before;1', 'main_menu', 'game_var;qa_after;1'], 30);
  const result = await page.evaluate(() => {
    const g = (window as any).__gameRef;
    return { after: g.gameVars.get('qa_after'), stack: g.state.getStackNames() };
  });
  expect(result.after).toBe(1);
  expect(result.stack).toEqual(['title']);
});

test('`a + b not in xs` keeps Python precedence, so EOtF Stratagem_Select_Enemy picks are distinct', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => {
    const g = (window as any).__gameRef;
    if (!g.db.rawData) g.db.rawData = new Map();
    g.db.rawData.set('QA_Strats', [
      { nid: 'A', name: 'Alpha', stratagem_type: 'Enemy' },
      { nid: 'B', name: 'Beta', stratagem_type: 'Enemy' },
      { nid: 'C', name: 'Gamma', stratagem_type: 'Enemy' },
    ]);
    g.gameVars.set('Active_Stratagems', []);
  });
  await runEvent(page, 'qa_strat_loop', [
    'level_var;choices;[]',
    'for;strats;range(3)',
    "    level_var;choices;{v:choices} + [game.get_random_choice([s.nid + '|' + s.name for s in game.get_data('QA_Strats') if s.nid + '|' + s.name not in {v:choices} and s.stratagem_type == 'Enemy' and s.nid not in {v:Active_Stratagems}])]",
    'endf',
    'game_var;qa_choices;{v:choices}',
  ], 20);
  const choices = await page.evaluate(() => (window as any).__gameRef.levelVars.get('choices'));
  expect(Array.isArray(choices) ? [...choices].sort() : choices).toEqual(['A|Alpha', 'B|Beta', 'C|Gamma']);
});

test('`+` binds tighter than comparisons and argument commas (Python precedence)', async ({ page }) => {
  await boot(page);
  await runEvent(page, 'qa_add_precedence', [
    'game_var;qa_eq;{e:1 + 2 == 3}',
    'game_var;qa_max;{e:max(1 + 1, 3)}',
    'game_var;qa_and;{e:1 + 2 > 2 and True}',
    "game_var;qa_list;{e:len([1] + [2, 3])}",
  ], 10);
  const vars = await page.evaluate(() => {
    const g = (window as any).__gameRef;
    return ['qa_eq', 'qa_max', 'qa_and', 'qa_list'].map((k) => g.gameVars.get(k));
  });
  expect(vars).toEqual([true, 3, true, 3]);
});

test('adjacent fillRects leave no seam at a fractional render scale (fog of war tiles)', async ({ page }) => {
  await boot(page);
  const seam = await page.evaluate(async () => {
    const { Surface } = await import('/src/engine/surface.ts');
    const surf = Surface.frame(240, 160, 3.7);
    for (let x = 0; x < 240; x += 16) surf.fillRect(x, 0, 16, 16, 'rgba(0,0,0,1)');
    const data = surf.ctx.getImageData(0, 0, Math.round(240 * 3.7), 1).data;
    const gaps: number[] = [];
    for (let px = 0; px < data.length / 4; px++) if (data[px * 4 + 3] === 0) gaps.push(px);
    return gaps;
  });
  expect(seam).toEqual([]);
});

test('nested {e:} tags evaluate innermost first (EOtF Global_Give_Exp alert)', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => {
    const g = (window as any).__gameRef;
    g.db.events.set('qa_nested_child', {
      name: 'qa_nested_child', nid: 'qa_nested_child', trigger: null, level_nid: null,
      condition: 'True', only_once: false, priority: 0,
      _source: ["game_var;qa_name;{e:u('{e:receiver}').name}"],
    });
  });
  await runEvent(page, 'qa_nested_parent', [
    "trigger_script_with_args;qa_nested_child;receiver,{e:game.get_unit('Eirika')}",
  ], 20);
  const result = await page.evaluate(() => {
    const g = (window as any).__gameRef;
    return { name: g.gameVars.get('qa_name'), expected: g.getUnit('Eirika')?.name };
  });
  expect(result.name).toBe(result.expected);
});

test('a quoted {v:} inside {e:} stays a string (EOtF room reward vars)', async ({ page }) => {
  await boot(page);
  // Python's TextEvaluator substitutes str(value) as text, so
  // `{e:'room' + '{v:counter}' + '_reward'}` with counter = 1 evaluates
  // 'room' + '1' + '_reward'. The web typed the number and dropped the
  // quotes ('room' + 1 -> TypeError), so EOtF's Act intro never set
  // room1_reward/room2_reward/room3_reward.
  await runEvent(page, 'qa_quoted_var', [
    'level_var;counter;1',
    'level_var;qa_list;[1, 2]',
    "level_var;{e:'room' + '{v:counter}' + '_reward'};'Money'",
    "game_var;qa_text;{e:'{v:qa_list}' + '!'}",
  ], 20);
  const result = await page.evaluate(() => {
    const g = (window as any).__gameRef;
    return { reward: g.levelVars.get('room1_reward'), text: g.gameVars.get('qa_text') };
  });
  expect(result).toEqual({ reward: 'Money', text: '[1, 2]!' });
});
