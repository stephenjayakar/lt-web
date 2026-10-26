/**
 * Free-roam movement parity with EOtF's engine fork (Python
 * roam_player_movement_component, roam_ai_movement_component,
 * rationalize_movement_component, free_roam_ai):
 *  - allied units can be walked through, enemies block;
 *  - the sprite never visibly enters an impassable tile below it;
 *  - difficult terrain divides the top speed by its movement cost;
 *  - rationalizing slides the unit back at 6 tiles/s, to the nearest open
 *    tile when another unit holds its own;
 *  - free-roam paths are ThetaStar waypoints;
 *  - a roam AI (EOtF's Follow_Player) walks toward its target.
 */
import { expect, test, type Page } from '@playwright/test';

async function boot(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await page.waitForFunction(() => (window as any).__harness?.ready === true, undefined, {
    timeout: 60_000,
  });
}

test('player roam movement: allies pass, enemies block, walls, mcost, rationalize', async ({ page }) => {
  await boot(page, '/?harness=true&level=DEBUG&clean=true&bundle=false');
  const result = await page.evaluate(async () => {
    const rm = await import('/src/movement/roam-movement.ts');
    // A 6x6 mock board: row 4 is a wall, (1,1) costs 2.
    const grid = new Map<string, any>();
    const key = (x: number, y: number) => `${x},${y}`;
    const board = {
      width: 6, height: 6,
      checkBounds: (x: number, y: number) => x >= 0 && y >= 0 && x < 6 && y < 6,
      getMovementCost: (x: number, y: number) => (y === 4 ? 99 : x === 1 && y === 1 ? 2 : 1),
      getUnit: (x: number, y: number) => grid.get(key(x, y)) ?? null,
      setUnit: (x: number, y: number, unit: any) => { grid.set(key(x, y), unit); unit.position = [x, y]; },
      removeUnit: (unit: any) => {
        if (unit.position && grid.get(key(unit.position[0], unit.position[1])) === unit) grid.delete(key(unit.position[0], unit.position[1]));
        unit.position = null;
      },
    };
    const db = { classes: new Map(), teams: { alliances: [['other', 'player']] } };
    const mk = (nid: string, team: string, x: number, y: number) => {
      const unit: any = { nid, team, klass: 'X', tags: [], skills: [], position: null, sprite: null,
        getMovement: () => 5, isDead: () => false };
      board.setUnit(x, y, unit);
      return unit;
    };
    const units = new Map<string, any>();
    const game = { units, gameVars: new Map() };
    const run = (mc: any, frames: number) => { for (let i = 0; i < frames; i++) mc.update(1 / 60); };

    // Allies pass: walk right through an 'other' unit.
    const hero = mk('hero', 'player', 0, 0);
    const npc = mk('npc', 'other', 1, 0);
    units.set('hero', hero); units.set('npc', npc);
    const mc = new rm.RoamPlayerMovementComponent(hero, board, db, game);
    mc.setAcceleration(1, 0);
    let sharedTile = false;
    for (let i = 0; i < 40; i++) {
      mc.update(1 / 60);
      if (hero.position[0] === 1 && hero.position[1] === 0) sharedTile = true;
    }
    const passed = { sharedTile, heroX: hero.position[0], npcStillOnGrid: board.getUnit(1, 0) === npc };

    // Enemies block.
    grid.clear(); units.clear();
    const hero2 = mk('hero2', 'player', 0, 2);
    const foe = mk('foe', 'enemy', 1, 2);
    units.set('hero2', hero2); units.set('foe', foe);
    const mc2 = new rm.RoamPlayerMovementComponent(hero2, board, db, game);
    mc2.setAcceleration(1, 0);
    run(mc2, 40);
    const blocked = { heroTile: [...hero2.position], foeTile: [...foe.position] };

    // Walls: walking south toward row 4 never pushes the sprite past y = 3.
    grid.clear(); units.clear();
    const hero3 = mk('hero3', 'player', 3, 2);
    units.set('hero3', hero3);
    const mc3 = new rm.RoamPlayerMovementComponent(hero3, board, db, game);
    mc3.setAcceleration(0, 1);
    let maxY = 0;
    for (let i = 0; i < 60; i++) { mc3.update(1 / 60); maxY = Math.max(maxY, mc3.roamPosition.y); }

    // mcost 2 halves the top speed: 3 tiles/s instead of 6.
    grid.clear(); units.clear();
    const hero4 = mk('hero4', 'player', 1, 1);
    units.set('hero4', hero4);
    const mc4 = new rm.RoamPlayerMovementComponent(hero4, board, db, game);
    (mc4 as any).velocityY = 0;
    mc4.setAcceleration(0, -1);
    run(mc4, 2);
    (mc4 as any).accelerate(1, 0, -1);
    const slowSpeed = Math.abs((mc4 as any).velocityY);

    // Rationalize: slide from (2.4, 2) back to (2, 2) over several frames.
    grid.clear(); units.clear();
    const hero5 = mk('hero5', 'player', 2, 2);
    units.set('hero5', hero5);
    rm.setRoamPosition(hero5, { x: 2.4, y: 2 });
    const env = { board, db, game };
    const rat = new rm.RationalizeMovementComponent(hero5, env, () => null);
    rat.update(1 / 60);
    const afterOne = rm.getRoamPosition(hero5)?.x;
    let frames = 1;
    while (!rat.done && frames < 30) { rat.update(1 / 60); frames++; }
    const settled = { afterOne, frames, done: rat.done, pos: [...hero5.position], onGrid: board.getUnit(2, 2) === hero5, roam: rm.getRoamPosition(hero5) };

    // Rationalize onto a shared tile: goes to the nearest open tile instead.
    grid.clear(); units.clear();
    const keeper = mk('keeper', 'other', 0, 3);
    const hero6: any = { nid: 'hero6', team: 'player', klass: 'X', tags: [], skills: [], position: [0, 3], sprite: null,
      getMovement: () => 5, isDead: () => false };
    units.set('keeper', keeper); units.set('hero6', hero6);
    rm.setRoamPosition(hero6, { x: 0.3, y: 3 });
    const rat2 = new rm.RationalizeMovementComponent(hero6, env, () => [1, 3]);
    for (let i = 0; i < 30 && !rat2.done; i++) rat2.update(1 / 60);
    const shared = { goal: rat2.goal, pos: [...hero6.position], keeperOnGrid: board.getUnit(0, 3) === keeper };

    return { passed, blocked, maxY, slowSpeed, settled, shared, pyRound: [rm.pyRound(0.5), rm.pyRound(1.5), rm.pyRound(2.5), rm.pyRound(2.51)] };
  });
  expect(result.passed).toEqual({ sharedTile: true, heroX: expect.any(Number), npcStillOnGrid: true });
  expect(result.passed.heroX).toBeGreaterThanOrEqual(2);
  expect(result.blocked).toEqual({ heroTile: [0, 2], foeTile: [1, 2] });
  expect(result.maxY).toBeLessThanOrEqual(3.0001);
  expect(result.slowSpeed).toBeCloseTo(3, 5);
  expect(result.settled.afterOne).toBeCloseTo(2.3, 5);
  expect(result.settled.frames).toBeGreaterThan(2);
  expect(result.settled).toMatchObject({ done: true, pos: [2, 2], onGrid: true, roam: null });
  expect(result.shared).toEqual({ goal: [1, 3], pos: [1, 3], keeperOnGrid: true });
  expect(result.pyRound).toEqual([0, 2, 2, 3]);
});

test('free-roam paths are ThetaStar waypoints', async ({ page }) => {
  await boot(page, '/?harness=true&level=DEBUG&clean=true&bundle=false');
  const result = await page.evaluate(() => {
    const game = (window as any).__gameRef;
    const unit = [...game.units.values()].find((u: any) => u.position) as any;
    const [x, y] = unit.position;
    // Find a reachable goal three to six tiles away diagonally.
    for (const [dx, dy] of [[4, 3], [-4, 3], [4, -3], [-4, -3], [3, 2], [-3, 2], [3, -2], [-3, -2]]) {
      const gx = x + dx;
      const gy = y + dy;
      if (gx < 0 || gy < 0 || gx >= game.board.width || gy >= game.board.height) continue;
      const astar = game.pathSystem.getPath(unit, gx, gy, game.board, { canMoveThrough: () => true });
      const theta = game.pathSystem.getPath(unit, gx, gy, game.board, { freeMovement: true });
      if (!astar || !theta) continue;
      return { astar: astar.length, theta: theta.length, start: theta[0], end: theta[theta.length - 1], goal: [gx, gy], from: [x, y] };
    }
    return null;
  });
  expect(result).not.toBeNull();
  expect(result!.theta).toBeLessThan(result!.astar);
  expect(result!.start).toEqual(result!.from);
  expect(result!.end).toEqual(result!.goal);
});

test("EOtF's Follow_Player roam AI walks toward the Roamer", async ({ page }) => {
  await boot(page, '/?harness=true&project=eotf.ltproj&level=X&clean=true&bundle=false');
  const result = await page.evaluate(() => {
    const game = (window as any).__gameRef;
    const h = (window as any).__harness;
    for (let i = 0; i < 600 && game.state.getCurrentState()?.name !== 'free_roam'; i++) h.stepFrames(1, 'SELECT');
    const roam = game.state.getCurrentState();
    if (roam?.name !== 'free_roam') return { state: roam?.name };
    const player = game.getUnit(game.roamInfo.roamUnitNid);
    player.tags = [...player.tags, 'Roamer'];
    const dist = (u: any) => Math.abs(u.position[0] - player.position[0]) + Math.abs(u.position[1] - player.position[1]);
    const npcs = [...game.units.values()].filter((u: any) => u !== player && u.position && u.team === 'other') as any[];
    npcs.sort((a, b) => dist(b) - dist(a));
    const follower = npcs[0];
    follower.roamAi = 'Follow_Player';
    roam.aiHandler.addUnit(follower);
    const before = dist(follower);
    // The hub's walls make it detour first; give it ten seconds.
    h.stepFrames(600, null);
    return { state: game.state.getCurrentState()?.name, before, after: dist(follower), ai: roam.aiHandler.containsUnit(follower) };
  });
  expect(result.state).toBe('free_roam');
  expect(result.ai).toBe(true);
  expect(result.after).toBeLessThan(result.before!);
});
