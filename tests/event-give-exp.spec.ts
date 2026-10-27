/**
 * event-give-exp.spec.ts: a non-silent event `give_exp` runs Python's
 * ExpState (level_up.py): the centred exp bar fills one point per frame,
 * a level-up shows the LevelUpMap logo and the level screen, the event
 * waits for it, and the gain is action-backed. At the level cap nothing
 * shows; negative exp levels down.
 */
import { expect, test, type Page } from '@playwright/test';

test.describe.configure({ mode: 'parallel' });

async function boot(page: Page): Promise<void> {
  await page.goto('/?harness=true&project=eotf.ltproj&level=EX_2&clean=true&bundle=false');
  await page.waitForFunction(() => (window as any).__harness?.ready === true, undefined, { timeout: 90_000 });
  // Frame clock: ExpState times itself with performance.now (Python's
  // engine.get_time), so every stepped frame advances it 1000/60 ms.
  await page.evaluate(() => {
    const harness = (window as any).__harness;
    let now = performance.now();
    Object.defineProperty(performance, 'now', { configurable: true, value: () => now });
    const stepOne = harness.stepFrames.bind(harness);
    harness.stepFrames = (count: number, input: string | null = null) => {
      for (let i = 0; i < count; i++) {
        now += 1000 / 60;
        stepOne(1, i === 0 ? input : null);
      }
    };
    harness.stepFrames(5, null);
  });
}

async function runScript(page: Page, nid: string, source: string[]): Promise<void> {
  await page.evaluate(({ nid, source }) => {
    const g = (window as any).__gameRef;
    g.db.events.set(nid, {
      name: nid, nid, trigger: nid, level_nid: g.currentLevel?.nid ?? null,
      condition: 'True', only_once: false, priority: 0, _source: source,
    });
    g.eventManager.triggerSpecific(nid, { type: nid }, true);
    g.state.change('event');
    (window as any).__harness.stepFrames(2, null);
  }, { nid, source });
}

const step = (page: Page, frames: number) =>
  page.evaluate((n) => (window as any).__harness.stepFrames(n, null), frames);

/** Step until the ExpState phase (or stack top) matches; 'no_exp' once it is gone. */
async function stepUntil(page: Page, phase: string, max = 600): Promise<number> {
  return page.evaluate(({ phase, max }) => {
    const g = (window as any).__gameRef;
    for (let i = 0; i < max; i++) {
      const top = g.state.getCurrentState();
      if (phase === 'no_exp' ? !g.state.getStackNames().includes('exp')
        : top?.name === 'exp' ? top.phase === phase : top?.name === phase) return i;
      (window as any).__harness.stepFrames(1, null);
    }
    return -1;
  }, { phase, max });
}

const unitInfo = (page: Page, nid: string) => page.evaluate((nid) => {
  const u = (window as any).__gameRef.units.get(nid);
  return { level: u.level, exp: u.exp, hp: u.currentHp, maxHp: u.maxHp, stats: { ...u.stats }, gp: { ...u.growthPoints } };
}, nid);

test('non-silent give_exp fills the exp bar, levels up and pauses the event', async ({ page }) => {
  await boot(page);
  const before = await page.evaluate(() => {
    const g = (window as any).__gameRef;
    const u = g.units.get('Yusha');
    u.exp = 30;
    u.currentHp = u.maxHp - 1;
    return { level: u.level, actions: g.actionLog.actions.length };
  });
  const start = await unitInfo(page, 'Yusha');
  await runScript(page, 'QaGiveExp', ['give_exp;Yusha;90', 'game_var;qa_after_exp;1']);
  expect(await page.evaluate(() => (window as any).__gameRef.state.getCurrentState().name)).toBe('exp');

  // exp0: the bar fills at the screen centre (fork bar: 136x24 at 52,68).
  expect(await stepUntil(page, 'exp0')).toBeGreaterThanOrEqual(0);
  await step(page, 40);
  const pixels = await page.evaluate(() => {
    const canvas = document.querySelector('canvas') as HTMLCanvasElement;
    const scale = canvas.width / 240;
    const ctx = canvas.getContext('2d')!;
    const at = (x: number, y: number) => Array.from(ctx.getImageData(x * scale + 1, y * scale + 1, 1, 1).data);
    const g = (window as any).__gameRef;
    return { fill: at(52 + 10 + 2, 68 + 11), frame: at(52 + 1, 68 + 12), exp: g.units.get('Yusha').exp, top: g.state.getCurrentState().phase };
  });
  // Fill pixels are the expbar 'middle' strip (warm yellow), not the map.
  expect(pixels.fill[0]).toBeGreaterThan(200);
  expect(pixels.fill[2]).toBeLessThan(140);
  // The gain is not applied while the bar runs.
  expect(pixels.exp).toBe(30);
  expect(await page.evaluate(() => (window as any).__gameRef.gameVars.get('qa_after_exp') ?? null)).toBeNull();

  expect(await stepUntil(page, 'level_up')).toBeGreaterThanOrEqual(0);
  const mid = await unitInfo(page, 'Yusha');
  expect(mid.level).toBe(start.level + 1);
  // ApplyStatChanges(..., increase_current_stats=False): HP stays.
  expect(mid.hp).toBe(start.hp);
  // dark_fuzz_background over the map.
  const dark = await page.evaluate(() => (window as any).__gameRef.state.getCurrentState().name);
  expect(dark).toBe('exp');
  expect(await stepUntil(page, 'level_screen')).toBeGreaterThanOrEqual(0);
  expect(await stepUntil(page, 'no_exp', 900)).toBeGreaterThanOrEqual(0);
  await step(page, 5);
  const after = await unitInfo(page, 'Yusha');
  expect(after.exp).toBe(20);
  expect(after.level).toBe(before.level + 1);
  expect(await page.evaluate(() => (window as any).__gameRef.gameVars.get('qa_after_exp'))).toBe(1);

  // Every mutation went through the action log: reversing restores the unit.
  const reverted = await page.evaluate((count) => {
    const g = (window as any).__gameRef;
    const added = g.actionLog.actions.slice(count);
    for (const action of added.reverse()) action.reverse();
    const u = g.units.get('Yusha');
    return { level: u.level, exp: u.exp, hp: u.currentHp, stats: { ...u.stats }, gp: { ...u.growthPoints }, names: added.map((a: any) => a.constructor.name) };
  }, before.actions);
  expect(reverted.level).toBe(start.level);
  expect(reverted.exp).toBe(30);
  expect(reverted.hp).toBe(start.hp);
  expect(reverted.stats).toEqual(start.stats);
  expect(reverted.gp).toEqual(start.gp);
});

test('give_exp at the level cap shows nothing; negative exp levels down', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => {
    const g = (window as any).__gameRef;
    const u = g.units.get('Yusha');
    u.level = Number(g.db.classes.get(u.klass).max_level ?? 20);
    u.exp = 0;
  });
  await runScript(page, 'QaCapExp', ['give_exp;Yusha;50', 'game_var;qa_cap;1']);
  await step(page, 3);
  expect(await page.evaluate(() => (window as any).__gameRef.gameVars.get('qa_cap'))).toBe(1);
  expect((await unitInfo(page, 'Yusha')).exp).toBe(0);

  await page.evaluate(() => {
    const u = (window as any).__gameRef.units.get('Yusha');
    u.level = 2;
    u.exp = 20;
  });
  const start = await unitInfo(page, 'Yusha');
  await runScript(page, 'QaLoseExp', ['give_exp;Yusha;-50', 'game_var;qa_lost;1']);
  expect(await stepUntil(page, 'exp-100')).toBeGreaterThanOrEqual(0);
  expect(await stepUntil(page, 'no_exp', 900)).toBeGreaterThanOrEqual(0);
  await step(page, 3);
  const after = await unitInfo(page, 'Yusha');
  expect(after.level).toBe(1);
  expect(after.exp).toBe(70);
  // Stats only go down (get_next_level_up of the level lost, negated).
  expect(Object.keys(start.stats).every((nid) => after.stats[nid] <= start.stats[nid])).toBe(true);
  expect(await page.evaluate(() => (window as any).__gameRef.gameVars.get('qa_lost'))).toBe(1);
});
