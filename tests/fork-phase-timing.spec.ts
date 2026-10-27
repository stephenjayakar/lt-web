/**
 * fork-phase-timing.spec.ts: enemy phases and map combat run on the EOtF
 * engine's frame timing. The frame counts are the fork oracle's
 * (tools/oracle, `exec` + per-frame state snapshots on EX_2 with events off):
 *
 * - AIState runs one AIController.act step a frame (think and move, attack,
 *   canto), so a unit with nothing to do takes three frames, not six plus
 *   the decision frame; the phase ends into turn_change in that frame.
 * - PhaseIn shows for 1368 ms from its begin frame (83 frames).
 * - Map combat: the solver's InitState costs the first begin_phase a frame,
 *   the fork's start_anim waits 400 ms, its single end_phase 550 ms, all on
 *   Python's integer millisecond clock; the combat ends in the begin_phase
 *   that finds no phase left, and the dying fade starts in that frame.
 * - Units walk unit_speed ms per tile (8 frames at 120 ms), before the
 *   frame's states update, as Python's MovementState does.
 */
import { expect, test, type Page } from '@playwright/test';

test.describe.configure({ mode: 'parallel' });

async function boot(page: Page): Promise<void> {
  await page.goto('/?harness=true&project=eotf.ltproj&level=EX_2&clean=true&bundle=false');
  await page.waitForFunction(() => (window as any).__harness?.ready === true, undefined, { timeout: 90_000 });
  // As the oracle: `"events": false` (no trigger-based events), map
  // combat, no auto end turn.
  await page.evaluate(async () => {
    const g = (window as any).__gameRef;
    const { setSetting } = await import('/src/engine/states/settings-state.ts');
    setSetting('animation', 'Never');
    setSetting('autoend_turn', 0);
    g.eventManager.trigger = () => false;
    (window as any).__harness.stepFrames(5, null);
  });
}

/** Frames until `until` holds, stepping one at a time (-1 if never). */
async function framesUntil(page: Page, until: string, max = 2000): Promise<{ frames: number; log: string[] }> {
  return page.evaluate(({ until, max }) => {
    const g = (window as any).__gameRef;
    const h = (window as any).__harness;
    const check = new Function('g', `return (${until});`) as (g: any) => boolean;
    const log: string[] = [];
    let last = '';
    for (let frame = 1; frame <= max; frame++) {
      h.stepFrames(1, null);
      const now = g.state.getStackNames().slice(-3).join('/');
      if (now !== last) log.push(`${frame}:${now}`);
      last = now;
      if (check(g)) return { frames: frame, log };
    }
    return { frames: -1, log };
  }, { until, max });
}

test('an enemy phase whose units do nothing ends on the fork frame', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => {
    const g = (window as any).__gameRef;
    g.units.get('Dragon').ai = 'None';
    g.state.change('ai');
  });
  const result = await framesUntil(page,
    "g.state.getCurrentState()?.name === 'free' && g.phase.getCurrent() === 'player' && g.turnCount === 2");
  // Oracle: player AI 3 frames, enemy banner 83, enemy AI 3, player banner 83.
  expect(result.frames, result.log.join(' ')).toBe(176);
  // Phase banners start in the frame the AI phase ends.
  expect(result.log[1]).toBe('5:ai/status_upkeep/phase_change');
});

test('each idle AI unit costs three frames (think, attack, canto)', async ({ page }) => {
  await boot(page);
  const added = await page.evaluate(async () => {
    const g = (window as any).__gameRef;
    const prefab = g.db.units.get('Termina');
    const free: [number, number][] = [];
    for (let y = 0; y < g.board.height && free.length < 4; y++) {
      for (let x = 0; x < g.board.width && free.length < 4; x++) {
        if (!g.board.getUnit(x, y) && x > 10) free.push([x, y]);
      }
    }
    for (let i = 0; i < free.length; i++) {
      const unit = g.spawnUnit({ ...prefab, nid: `_Idle${i}` }, 'enemy', free[i], 'None');
      g.units.set(unit.nid, unit);
      g.board.setUnit(free[i][0], free[i][1], unit);
    }
    g.units.get('Dragon').ai = 'None';
    g.state.change('ai');
    return free.length;
  });
  expect(added).toBe(4);
  const result = await framesUntil(page,
    "g.state.getCurrentState()?.name === 'free' && g.phase.getCurrent() === 'player' && g.turnCount === 2");
  expect(result.frames, result.log.join(' ')).toBe(176 + 3 * added);
});

test('an enemy walks three tiles, attacks and kills on the fork frames', async ({ page }) => {
  await boot(page);
  // EX_2: the Dragon (6,2) pursues Yusha at (6,6): three tiles to (6,5).
  await page.evaluate(() => {
    const g = (window as any).__gameRef;
    (window as any).__harness.warpUnit('Yusha', 6, 6);
    g.state.change('ai');
  });
  const walk = await framesUntil(page, "g.movementSystem.isMoving()");
  // Oracle: the Dragon thinks and starts its walk on frame 89.
  expect(walk.frames, walk.log.join(' ')).toBe(89);
  const combat = await framesUntil(page, "g.state.getStackNames().includes('combat')");
  // Three tiles at 8 frames each; the combat and its MoveCameraState are
  // pushed in the frame the walk ends (frame 113).
  expect(walk.frames + combat.frames).toBe(113);
  const done = await framesUntil(page,
    "g.state.getCurrentState()?.name === 'free' && g.phase.getCurrent() === 'player'", 1200);
  // Oracle: free again on frame 338.
  expect(walk.frames + combat.frames + done.frames, done.log.join(' ')).toBe(338);
});

test('player map combat ends on the fork frame', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => {
    const g = (window as any).__gameRef;
    (window as any).__harness.warpUnit('Yusha', 6, 3);
    const yusha = g.units.get('Yusha');
    g.selectedUnit = yusha;
    g.combatTarget = g.units.get('Dragon');
    g.memory.set('combat_item', yusha.equippedWeapon ?? yusha.items[0]);
    g.state.change('combat');
  });
  const result = await framesUntil(page, "g.state.getCurrentState()?.name === 'free'", 600);
  // Oracle: 238 frames (Yusha strikes, the Dragon's counter kills him, the
  // dying fade). The web's 83 ms 'anim' wait has a frame less here: Python's
  // integer clock makes it 5 or 6 frames depending on its phase.
  expect(result.frames, result.log.join(' ')).toBeGreaterThanOrEqual(237);
  expect(result.frames).toBeLessThanOrEqual(238);
});
