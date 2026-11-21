/**
 * Each event owns its transition fade (Python Event.transition_state,
 * transition_progress, transition_color). A trigger_script child starts
 * unfaded and draws its dialogue above a parent's closed fade; a child that
 * ends closed takes its fade with it; a menu opened through Python's
 * transition_to state hands the event back unfaded.
 *
 * The web port used to keep one fade for every event the EventState ran, so
 * text came up on a fully black screen ("black screens when text is coming
 * up"): EOtF's first-run Controls tutorial, run under the hub Setup event's
 * closed transition, typed its box underneath the black.
 */
import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';

test.describe.configure({ mode: 'parallel' });

async function boot(page: Page): Promise<void> {
  await page.goto('/?harness=true&level=DEBUG&bundle=false');
  await page.waitForFunction(() => !!(window as any).__harness?.ready, { timeout: 30000 });
  await stepFrames(page, 5);
}

async function stepFrames(page: Page, count: number, input: string | null = null): Promise<void> {
  await page.evaluate(({ n, input }) => (window as any).__harness.stepFrames(n, input), { n: count, input });
}

async function addEvents(page: Page, events: Record<string, string[]>): Promise<void> {
  await page.evaluate((events) => {
    const g = (window as any).__gameRef;
    for (const [nid, source] of Object.entries(events)) {
      g.db.events.set(nid, {
        name: nid, nid, trigger: nid, level_nid: g.currentLevel?.nid ?? null,
        condition: 'True', only_once: false, priority: 0, _source: source,
      });
    }
  }, events);
}

async function runEvent(page: Page, nid: string, frames: number): Promise<void> {
  await page.evaluate((nid) => {
    const g = (window as any).__gameRef;
    g.eventManager.triggerSpecific(nid, { type: nid }, true);
    g.state.change('event');
  }, nid);
  await stepFrames(page, frames);
}

/** Brightest pixel (r+g+b, 0..765) and how many pixels are not near-black. */
async function canvasLight(page: Page): Promise<{ max: number; lit: number }> {
  return page.evaluate(() => {
    const canvas = document.getElementById('game-canvas') as HTMLCanvasElement;
    const ctx = canvas.getContext('2d')!;
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let max = 0;
    let lit = 0;
    for (let i = 0; i < data.length; i += 4) {
      const light = data[i] + data[i + 1] + data[i + 2];
      if (light > max) max = light;
      if (light > 90) lit++;
    }
    return { max, lit };
  });
}

const eventState = (page: Page) => page.evaluate(() => {
  const g = (window as any).__gameRef;
  const s = g.state.stack.find((state: any) => state.name === 'event');
  return {
    top: g.state.getCurrentState()?.name,
    event: s?.currentEvent?.nid ?? null,
    alpha: s?.transitionAlpha ?? null,
    dialog: !!s?.dialog,
    typing: s?.dialog ? !s.dialog.isDone?.() : null,
  };
});

test('a trigger_script child types its text above the parent\'s closed fade', async ({ page }) => {
  await boot(page);
  await addEvents(page, {
    qa_parent: ['transition;close', 'trigger_script;qa_child', 'game_var;qa_parent_done;1'],
    qa_child: ['speak;;You can read this over the black screen.;center'],
  });
  await runEvent(page, 'qa_parent', 40);
  const state = await eventState(page);
  expect(state.event).toBe('qa_child');
  expect(state.dialog).toBe(true);
  // The child's own fade is open; the parent's stays closed underneath.
  expect(state.alpha).toBe(0);
  await stepFrames(page, 120);
  const light = await canvasLight(page);
  expect(light.max, 'the dialog box must be visible, not covered by the parent fade').toBeGreaterThan(300);
  expect(light.lit).toBeGreaterThan(500);
});

test('a child that ends closed takes its fade with it; the parent speaks unfaded', async ({ page }) => {
  await boot(page);
  await addEvents(page, {
    qa_parent2: ['trigger_script;qa_child2', 'speak;;Back on the map.'],
    qa_child2: ['transition;close'],
  });
  await runEvent(page, 'qa_parent2', 160);
  const state = await eventState(page);
  expect(state.event).toBe('qa_parent2');
  expect(state.dialog).toBe(true);
  expect(state.alpha).toBe(0);
  const light = await canvasLight(page);
  expect(light.max).toBeGreaterThan(300);
});

test('a parent\'s closed fade comes back when its child ends', async ({ page }) => {
  await boot(page);
  await addEvents(page, {
    qa_parent3: ['transition;close', 'trigger_script;qa_child3', 'wait;100000'],
    qa_child3: ['transition;open'],
  });
  await runEvent(page, 'qa_parent3', 120);
  const state = await eventState(page);
  // Python: the child's open fades only the child's own overlay; the parent
  // is still closed once it resumes.
  expect(state.event).toBe('qa_parent3');
  expect(state.alpha).toBe(1);
});

test('back from open_unit_management, the event is not left behind a black fade', async ({ page }) => {
  await boot(page);
  await addEvents(page, {
    qa_manage: ['open_unit_management', 'speak;;Welcome back.'],
  });
  await runEvent(page, 'qa_manage', 30);
  expect((await eventState(page)).top).toBe('base_manage');
  // Leave the manage screen the way the player does.
  for (let i = 0; i < 40; i++) {
    const top = (await eventState(page)).top;
    if (top === 'event') break;
    await stepFrames(page, 15, 'BACK');
  }
  await stepFrames(page, 90);
  const state = await eventState(page);
  expect(state.top).toBe('event');
  expect(state.dialog).toBe(true);
  expect(state.alpha).toBe(0);
  expect((await canvasLight(page)).max).toBeGreaterThan(300);
});

const eotfAvailable = fs.existsSync(path.join(process.cwd(), 'lt-maker/eotf.ltproj/game_data/levels.json'));

test('EOtF: the first-run Controls tutorial is readable after the intro', async ({ page }) => {
  test.skip(!eotfAvailable, 'lt-maker/eotf.ltproj is not installed');
  test.slow();
  await page.goto('/?harness=true&project=eotf.ltproj&level=X&clean=false&bundle=false');
  await page.waitForFunction(() => !!(window as any).__harness?.ready, { timeout: 60000 });
  // Press through the intro cutscene until the hub Setup event runs its
  // Controls child (Python: drawn over Setup's closed transition).
  let reached = false;
  for (let i = 0; i < 600 && !reached; i++) {
    await stepFrames(page, 6, i % 2 === 0 ? 'SELECT' : null);
    const s = await eventState(page);
    reached = s.event === 'X w. Controls' && s.dialog;
  }
  expect(reached, 'the intro must hand over to the Controls tutorial').toBe(true);
  await stepFrames(page, 60);
  const state = await eventState(page);
  expect(state.event).toBe('X w. Controls');
  expect(state.alpha).toBe(0);
  const light = await canvasLight(page);
  expect(light.max, 'the Controls box must show over the black hub').toBeGreaterThan(300);
  expect(light.lit).toBeGreaterThan(2000);
});
