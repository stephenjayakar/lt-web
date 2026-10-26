/**
 * Python unit_sound.UnitSound parity: map footsteps.
 *
 * A path move plays `Map_Step_<sound>` on the loop's frames (Infantry: 0 and
 * 8, with the 'repeat' entry at 16 restarting the loop one update later) and stops the sounding
 * step when the move ends; `silent` moves are muted. Free roam plays the
 * steps while the roam unit moves, scaled by distance from the screen
 * centre. EOtF's hub also plays 'Select 2' / 'Error' on SELECT like the
 * fork's check_select.
 */
import { expect, test, type Page } from '@playwright/test';

async function boot(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await page.waitForFunction(() => (window as any).__harness?.ready === true, undefined, {
    timeout: 60_000,
  });
}

async function stepFrames(page: Page, count: number, input: string | null = null): Promise<void> {
  await page.evaluate(([n, i]) => (window as any).__harness.stepFrames(n, i), [count, input] as const);
}

test.describe('map footsteps (UnitSound)', () => {
  test('a path move plays the Infantry loop and stops the step at the end', async ({ page }) => {
    await boot(page, '/?harness=true&level=DEBUG&clean=true&bundle=false');
    await stepFrames(page, 5);
    const result = await page.evaluate(() => {
      const game = (window as any).__gameRef;
      const h = (window as any).__harness;
      const unit = [...game.units.values()].find((u: any) =>
        u.position && u.team === 'player' && !u.tags.includes('Flying')) as any;
      const [x, y] = unit.position;
      const path: [number, number][] = [];
      for (let i = 0; i <= 4; i++) path.push([x, y]);
      // Walk in place along a five-entry path (four tile steps) at 8 frames/tile.
      const calls = game.audioManager.calls;
      calls.length = 0;
      game.movementSystem.beginMove(unit, path, 1000 / (8 * (1000 / 60)));
      const log: Array<[number, string, string]> = [];
      for (let frame = 0; frame < 40; frame++) {
        const before = calls.length;
        h.stepFrames(1, null);
        for (const call of calls.slice(before)) {
          if (String(call.nid ?? '').startsWith('Map_Step') ) log.push([frame, call.op, call.nid]);
        }
      }
      return log;
    });
    const plays = result.filter(([, op]) => op === 'sfx');
    expect(plays.map(([, , nid]) => nid).slice(0, 3))
      .toEqual(['Map_Step_Infantry1', 'Map_Step_Infantry2', 'Map_Step_Infantry1']);
    expect(plays[1][0] - plays[0][0]).toBe(8);
    // Frame 16 is the 'repeat' update, so the loop restarts one update later.
    expect(plays[2][0] - plays[1][0]).toBe(9);
    const stop = result.find(([, op]) => op === 'sfxStop');
    expect(stop, 'the sounding step is stopped when the move ends').toBeTruthy();
    expect(result.filter(([frame, op]) => op === 'sfx' && frame > stop![0])).toEqual([]);
  });

  test('silent moves are muted and fliers use the Flier loop', async ({ page }) => {
    await boot(page, '/?harness=true&level=DEBUG&clean=true&bundle=false');
    await stepFrames(page, 5);
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const h = (window as any).__harness;
      const { playUnitSound, stopUnitSound, unitSoundState } = await import('/src/audio/unit-sound.ts');
      const unit = [...game.units.values()].find((u: any) => u.position && u.team === 'player') as any;
      const [x, y] = unit.position;
      const calls = game.audioManager.calls;
      calls.length = 0;
      game.movementSystem.beginMove(unit, [[x, y], [x, y], [x, y]], 6, undefined, undefined, true);
      h.stepFrames(30, null);
      const silentSteps = calls.filter((c: any) => String(c.nid ?? '').startsWith('Map_Step')).length;
      unit.tags = [...unit.tags, 'Flying'];
      playUnitSound(unit);
      const flier = unitSoundState(unit).sound;
      stopUnitSound(unit);
      unit.tags = unit.tags.filter((t: string) => t !== 'Flying');
      return { silentSteps, flier };
    });
    expect(result).toEqual({ silentSteps: 0, flier: 'Flier' });
  });

  test('free roam plays footsteps while walking, at a distance-scaled volume', async ({ page }) => {
    await boot(page, '/?harness=true&project=eotf.ltproj&level=X&clean=true&bundle=false');
    await page.waitForFunction(() =>
      (window as any).__gameRef?.state?.getCurrentState?.()?.name === 'free_roam', undefined, { timeout: 60_000 })
      .catch(() => undefined);
    const result = await page.evaluate(() => {
      const game = (window as any).__gameRef;
      const h = (window as any).__harness;
      for (let i = 0; i < 600 && game.state.getCurrentState()?.name !== 'free_roam'; i++) h.stepFrames(1, 'SELECT');
      const calls = game.audioManager.calls;
      calls.length = 0;
      game.input.keysDown.add('KeyS');
      h.stepFrames(40, null);
      game.input.keysDown.delete('KeyS');
      h.stepFrames(30, null);
      const steps = calls.filter((c: any) => String(c.nid ?? '').startsWith('Map_Step'));
      return {
        state: game.state.getCurrentState()?.name,
        played: steps.filter((c: any) => c.op === 'sfx').map((c: any) => c.nid),
        volumes: steps.filter((c: any) => c.op === 'sfx').map((c: any) => c.volume ?? 1),
        stopped: steps.some((c: any) => c.op === 'sfxStop'),
      };
    });
    expect(result.state).toBe('free_roam');
    expect(result.played.length).toBeGreaterThan(1);
    expect(result.played[0]).toMatch(/^Map_Step_/);
    expect(result.volumes.every((v: number) => v > 0 && v <= 1)).toBe(true);
    expect(result.stopped).toBe(true);
  });
});

test('EOtF hub SELECT plays Error with nothing to interact with (fork check_select)', async ({ page }) => {
  await boot(page, '/?harness=true&project=eotf.ltproj&level=X&clean=true&bundle=false');
  const result = await page.evaluate(() => {
    const game = (window as any).__gameRef;
    const h = (window as any).__harness;
    for (let i = 0; i < 600 && game.state.getCurrentState()?.name !== 'free_roam'; i++) h.stepFrames(1, 'SELECT');
    const roam = game.state.getCurrentState();
    if (roam?.name !== 'free_roam') return { state: roam?.name };
    // Find a tile with no unit within talk range and no event region.
    const unit = game.getUnit(game.roamInfo.roamUnitNid);
    const regions = game.currentLevel.regions ?? [];
    const inRegion = (x: number, y: number) => regions.some((r: any) =>
      String(r.region_type ?? '').toLowerCase() === 'event' &&
      x >= r.position[0] && x < r.position[0] + r.size[0] && y >= r.position[1] && y < r.position[1] + r.size[1]);
    let spot: [number, number] | null = null;
    for (let y = 0; y < game.board.height && !spot; y++) {
      for (let x = 0; x < game.board.width && !spot; x++) {
        if (game.board.getUnit(x, y) || inRegion(x, y)) continue;
        const near = [...game.units.values()].some((u: any) =>
          u !== unit && u.position && Math.abs(u.position[0] - x) + Math.abs(u.position[1] - y) <= 1);
        if (!near) spot = [x, y];
      }
    }
    if (!spot) return { state: 'no-spot' };
    game.board.removeUnit(unit);
    game.board.setUnit(spot[0], spot[1], unit);
    roam.movementComponent.roamPosition = { x: spot[0], y: spot[1] };
    const calls = game.audioManager.calls;
    calls.length = 0;
    h.stepFrames(1, 'SELECT');
    h.stepFrames(2, null);
    return {
      state: game.state.getCurrentState()?.name,
      sfx: calls.filter((c: any) => c.op === 'sfx' && !String(c.nid).startsWith('Map_Step')).map((c: any) => c.nid),
    };
  });
  expect(result.state).toBe('free_roam');
  expect(result.sfx).toEqual(['Error']);
});
