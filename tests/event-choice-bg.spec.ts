/**
 * event-choice-bg.spec.ts: the `choice`/`table` BG argument
 * (event_functions.choice/table -> grid_choice._build_bg / SimpleMenuUI ->
 * base_surf.create_base_surf) and TextEvaluator._evaluate_vars for `{v:}`.
 *
 * - Upstream uses an authored BG: `*_bg*` sprites are 9-sliced, any other
 *   sprite is blitted once, unscaled, at the window's top-left.
 * - The EOtF fork ignores an authored BG and keeps the skinned menu_bg_base.
 * - `{v:x}` prints a var that holds None as 'None' (no fall-through from
 *   level_vars to game_vars), `{var:x}` is an alias, a missing var is '??'.
 */
import { expect, test, type Page } from '@playwright/test';

test.describe.configure({ mode: 'parallel' });
test.use({ launchOptions: { args: ['--mute-audio'] } });

const DEFAULT = '/?harness=true&level=0&clean=true&bundle=false';
const EOTF = '/?harness=true&project=eotf.ltproj&level=X&clean=true&bundle=false';

async function boot(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await page.waitForFunction(() => (window as any).__harness?.ready === true, undefined, { timeout: 90_000 });
}

async function step(page: Page, frames: number, input: string | null = null): Promise<void> {
  await page.evaluate(({ frames, input }) => (window as any).__harness.stepFrames(frames, input), { frames, input });
}

async function run(page: Page, nid: string, source: string[]): Promise<void> {
  await page.evaluate(({ nid, source }) => {
    const g = (window as any).__gameRef;
    g.db.events.set(nid, {
      name: nid, nid, trigger: nid, level_nid: g.currentLevel?.nid ?? null,
      condition: 'True', only_once: false, priority: 0, _source: source,
    });
    g.eventManager.triggerSpecific(nid, { type: nid }, true);
    g.state.change('event');
  }, { nid, source });
  await step(page, 10);
}

const choiceBg = (page: Page) => page.evaluate(() =>
  (window as any).__gameRef.state.getCurrentState().choiceMenu?.cfg?.bg ?? null);

const tableBgs = (page: Page) => page.evaluate(() =>
  [...(window as any).__gameRef.state.getCurrentState().eventTables.values()].map((t: any) => t.background));

test('upstream choice/table draw an authored BG; non-_bg sprites are blitted unscaled', async ({ page }, testInfo) => {
  await boot(page, DEFAULT);
  // create_base_surf: menu_bg_brown is 9-sliced over the whole window,
  // menu_gem_small (14x12) sits once at the top-left of a transparent surface.
  const alpha = await page.evaluate(async () => {
    const { getMenuBackground } = await import('/src/ui/base-surf.ts');
    const read = async (nid: string, x: number, y: number): Promise<number> => {
      const surf: any = await getMenuBackground(64, 48, nid);
      const s = surf.scale;
      return surf.canvas.getContext('2d').getImageData(Math.floor(x * s), Math.floor(y * s), 1, 1).data[3];
    };
    return {
      size: await getMenuBackground(64, 48, 'menu_gem_small').then((surf: any) => [surf.width, surf.height]),
      gemInside: await read('menu_gem_small', 6, 6),
      gemOutside: await read('menu_gem_small', 40, 30),
      slicedFar: await read('menu_bg_brown', 40, 30),
    };
  });
  expect(alpha.size).toEqual([64, 48]);
  expect(alpha.gemInside).toBeGreaterThan(0);
  expect(alpha.gemOutside).toBe(0);
  expect(alpha.slicedFar).toBe(255);

  await run(page, 'bg_choice', [
    'table;tb;Note;Title;;;top_left;menu_bg_brown',
    'table;tb2;Other;;;;bottom_left',
    'choice;pick;Pick?;Alpha,Beta;BG=menu_bg_brown',
  ]);
  expect(await choiceBg(page)).toBe('menu_bg_brown');
  expect(await tableBgs(page)).toEqual(['menu_bg_brown', 'menu_bg_base']);
  await step(page, 10);
  await page.locator('canvas').screenshot({ path: testInfo.outputPath('choice-bg-brown.png') });
  await step(page, 1, 'SELECT');
  await step(page, 5);
  expect(await page.evaluate(() => (window as any).__gameRef.gameVars.get('pick'))).toBe('Alpha');

  await run(page, 'nobg_choice', ['choice;pick2;Pick?;Alpha,Beta;BG=menu_bg_brown;no_bg']);
  expect(await choiceBg(page)).toBe(null);
});

test('EOtF fork choice/table ignore an authored BG', async ({ page }) => {
  await boot(page, EOTF);
  await run(page, 'fork_bg_choice', [
    'table;tb;Note;;;;top_left;menu_bg_brown',
    'choice;pick;Pick?;Alpha,Beta;BG=menu_bg_brown',
  ]);
  expect(await choiceBg(page)).toBe('menu_bg_base');
  expect(await tableBgs(page)).toEqual(['menu_bg_base']);
});

test('{v:} prints None for a None var without falling through; {var:} alias; missing is ??', async ({ page }) => {
  await boot(page, DEFAULT);
  await page.evaluate(() => {
    const g = (window as any).__gameRef;
    g.levelVars.set('nv', null);
    g.gameVars.set('nv', 'from_game');
    g.gameVars.set('gnone', null);
    g.gameVars.set('gv', 'game');
  });
  await run(page, 'var_text', [
    "if;'{v:nv}' == 'None'", 'game_var;r1;1', 'end',
    "if;'{v:gnone}' == 'None'", 'game_var;r2;1', 'end',
    "if;'{var:gv}' == 'game'", 'game_var;r3;1', 'end',
    "if;'{v:missing}' == '??'", 'game_var;r4;1', 'end',
    // Nested evals still resolve innermost first.
    "if;'{e:{e:1 + 1} * 3}' == '6'", 'game_var;r5;1', 'end',
  ]);
  const result = await page.evaluate(() => {
    const g = (window as any).__gameRef;
    return ['r1', 'r2', 'r3', 'r4', 'r5'].map((key) => g.gameVars.get(key) ?? null);
  });
  expect(result).toEqual([1, 1, 1, 1, 1]);
});

test('a quoted {v:} inside {e:} is the var text, so int vars concatenate as str', async ({ page }) => {
  // EOtF Act intros name floor rooms with {e:'room' + '{v:counter}' + '_reward'};
  // Python substitutes '1' (a str), never a bare int that would raise TypeError.
  await boot(page, DEFAULT);
  await run(page, 'quoted_var', [
    'level_var;counter;1',
    "level_var;{e:'room' + '{v:counter}' + '_reward'};'gold'",
    "if;{e:'{v:counter}' == '1'}", 'game_var;q1;1', 'end',
    "if;{e:{v:counter} + 1} == 2", 'game_var;q2;1', 'end',
  ]);
  const result = await page.evaluate(() => {
    const g = (window as any).__gameRef;
    return [g.levelVars.get('room1_reward') ?? null, g.gameVars.get('q1') ?? null, g.gameVars.get('q2') ?? null];
  });
  expect(result).toEqual(['gold', 1, 1]);
});
