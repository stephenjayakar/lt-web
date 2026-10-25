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
