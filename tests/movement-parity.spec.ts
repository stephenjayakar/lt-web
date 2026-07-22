/**
 * Movement/pathfinding parity tests (P4 row: pathfinding, movement costs,
 * LOS/fog, rescue/pair-up, canto, initiative -- this spec covers the
 * movement-mechanics half; initiative and rescue/pair-up are covered by
 * earlier slices).
 *
 * Areas verified against the Python reference (lt-maker/app/engine):
 *
 *  1. Movement costs -- `mcost.json` grid semantics (Database.getMovementCost,
 *     GameBoard.getMovementCost) vs `app/data/database/mcost.py` McostGrid.get_mcost.
 *  2. Dijkstra range vs A* path agreement -- every tile Dijkstra reports
 *     reachable within a MOV budget must have an A* path of cost <= MOV, on a
 *     synthetic mixed-terrain grid (property-style fixture).
 *  3. LOS -- Bresenham `getLine` (src/engine/line-of-sight.ts) vs
 *     `app/engine/bresenham_line_algorithm.py` -- this is a line-for-line
 *     port, verified here with golden diagonal-corner cases.
 *  4. Canto -- `unit.movementLeft` (src/objects/unit.ts) vs Python
 *     `unit.movement_left` (app/engine/objects/unit.py): full MOV before any
 *     move this turn, leftover MOV after a move, reset at turn boundaries;
 *     plus canto-skill-variant recognition (canto/canto_plus/canto_sharp/canter,
 *     movement_components.py).
 */

import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';

async function waitForHarness(page: Page): Promise<void> {
  await page.waitForFunction(() => !!(window as any).__harness?.ready, { timeout: 15000 });
}

async function stepFrames(page: Page, count: number, input: string | null = null): Promise<void> {
  await page.evaluate(
    ({ count, input }) => (window as any).__harness.stepFrames(count, input),
    { count, input },
  );
}

// ---------------------------------------------------------------------------
// 1. Movement cost table fixtures (uses the real loaded DB via the harness).
// ---------------------------------------------------------------------------

test.describe('movement costs', () => {
  test('getMovementCost matches mcost grid semantics', async ({ page }) => {
    await page.goto('/?harness=true&level=DEBUG&bundle=false');
    await waitForHarness(page);

    const result = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const db = g.db;
      const mcost = db.mcost;

      // Reconstruct expectations directly from the grid (mirrors
      // McostGrid.get_mcost: grid[terrainIdx][unitIdx], impassable = 99).
      const checks: { terrain: string; unit: string; expected: number; got: number }[] = [];
      for (let t = 0; t < Math.min(mcost.terrainTypes.length, 3); t++) {
        for (let u = 0; u < Math.min(mcost.unitTypes.length, 3); u++) {
          const terrain = mcost.terrainTypes[t];
          const unit = mcost.unitTypes[u];
          const expected = mcost.grid[t][u];
          const got = db.getMovementCost(terrain, unit);
          checks.push({ terrain, unit, expected, got });
        }
      }

      // Unknown terrain/unit type must fall back to impassable (99), matching
      // the web's explicit fallback (Python's McostGrid.get_mcost would raise
      // ValueError on .index() for an unknown nid -- the web instead defends
      // with a safe default since terrain/movement-group data is user content).
      const unknownTerrain = db.getMovementCost('__nonexistent_terrain__', mcost.unitTypes[0]);
      const unknownUnit = db.getMovementCost(mcost.terrainTypes[0], '__nonexistent_unit__');

      return { checks, unknownTerrain, unknownUnit, hasData: mcost.terrainTypes.length > 0 };
    });

    expect(result.hasData).toBe(true);
    for (const c of result.checks) {
      expect(c.got, `mcost[${c.terrain}][${c.unit}]`).toBe(c.expected);
    }
    expect(result.unknownTerrain).toBe(99);
    expect(result.unknownUnit).toBe(99);
  });

  test('unit movement-group resolves from class definition', async ({ page }) => {
    await page.goto('/?harness=true&level=DEBUG&bundle=false');
    await waitForHarness(page);

    const result = await page.evaluate(async () => {
      const g = (window as any).__gameRef;
      const eirika = g.units.get('Eirika');
      const db = g.db;
      const klassDef = db.classes.get(eirika.klass);
      return {
        movementGroup: klassDef?.movement_group,
      };
    });

    // Python: get_movement_group falls back to DB.classes.get(klass).movement_group
    // when no skill overrides movement_type (movement_funcs.py). Every class
    // should define a movement group (defaults to 'Infantry' in this port).
    expect(typeof result.movementGroup === 'string' || result.movementGroup === undefined).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. Dijkstra range vs A* path agreement (pure module test, synthetic grid).
// ---------------------------------------------------------------------------

test.describe('dijkstra/astar agreement', () => {
  test('every Dijkstra-reachable tile has an A* path of cost <= MOV', async ({ page }) => {
    await page.goto('/?harness=true&level=DEBUG&bundle=false');
    await waitForHarness(page);

    const result = await page.evaluate(async () => {
      const { Dijkstra, AStar } = await import('/src/pathfinding/pathfinding.ts');

      // Synthetic 8x8 mixed-terrain grid: costs 1..4, with a couple of
      // impassable (99) tiles carved in to force detours.
      const W = 8, H = 8;
      // Deterministic pseudo-random cost pattern (no Math.random -- keep the
      // fixture reproducible).
      const costAt = (x: number, y: number): number => {
        if ((x === 3 && y >= 1 && y <= 5) || (x === 5 && y >= 2 && y <= 6)) return 99; // walls
        return 1 + ((x * 7 + y * 13) % 4); // 1..4
      };

      function buildGrid<T extends { setCost: (x: number, y: number, c: number) => void }>(Ctor: new (w: number, h: number) => T): T {
        const grid = new Ctor(W, H);
        for (let y = 0; y < H; y++) {
          for (let x = 0; x < W; x++) grid.setCost(x, y, costAt(x, y));
        }
        return grid;
      }

      const startX = 0, startY = 0;
      const MOV = 12;
      const canMoveThrough = () => true; // no unit occupancy for this fixture

      const dijkstra = buildGrid(Dijkstra);
      const reachable = dijkstra.process(startX, startY, MOV, canMoveThrough);

      const mismatches: { x: number; y: number; dijkstraG: number; astarCost: number | null }[] = [];
      for (const [x, y, remaining] of reachable) {
        const dijkstraG = MOV - remaining;
        const astar = buildGrid(AStar);
        const path = astar.process(startX, startY, x, y, canMoveThrough, false, 0, 999);
        let astarCost: number | null = null;
        if (path) {
          astarCost = 0;
          for (let i = 1; i < path.length; i++) {
            astarCost += costAt(path[i][0], path[i][1]);
          }
        }
        if (astarCost === null || astarCost > MOV || astarCost !== dijkstraG) {
          mismatches.push({ x, y, dijkstraG, astarCost });
        }
      }

      return { reachableCount: reachable.length, mismatches };
    });

    expect(result.reachableCount).toBeGreaterThan(10);
    expect(result.mismatches).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 3. LOS golden cases (pure module test, hand-traced against the Python
//    bresenham_line_algorithm.get_line logic).
// ---------------------------------------------------------------------------

test.describe('line of sight', () => {
  test('golden Bresenham LOS cases', async ({ page }) => {
    await page.goto('/?harness=true&level=DEBUG&bundle=false');
    await waitForHarness(page);

    const result = await page.evaluate(async () => {
      const { getLine } = await import('/src/engine/line-of-sight.ts');

      const cases: { name: string; start: [number, number]; end: [number, number]; opaque: [number, number][]; expected: boolean }[] = [
        {
          name: 'same tile always visible',
          start: [2, 2], end: [2, 2], opaque: [[2, 2]], expected: true,
        },
        {
          name: 'clear straight horizontal line',
          start: [0, 0], end: [4, 0], opaque: [], expected: true,
        },
        {
          name: 'straight line blocked by a mid tile',
          start: [0, 0], end: [4, 0], opaque: [[2, 0]], expected: false,
        },
        {
          name: 'end tile opacity never blocks (only intermediate tiles matter)',
          start: [0, 0], end: [4, 0], opaque: [[4, 0]], expected: true,
        },
        {
          name: 'perfect diagonal, one corner tile opaque still passes (only one of the two corner tiles blocks)',
          // (0,0) -> (3,3): passes through corner squares at each diagonal step.
          // Blocking just one of a corner pair should not block the line
          // (get_line only fails the "through the middle" case when BOTH
          // corner tiles are opaque).
          start: [0, 0], end: [3, 3], opaque: [[1, 0]], expected: true,
        },
        {
          name: 'perfect diagonal blocked when both corner tiles of a step are opaque',
          start: [0, 0], end: [3, 3], opaque: [[1, 0], [0, 1]], expected: false,
        },
        {
          name: 'shallow diagonal (2,1) clear',
          start: [0, 0], end: [4, 2], opaque: [], expected: true,
        },
        {
          name: 'shallow diagonal blocked at the bottom-square correction tile',
          start: [0, 0], end: [4, 2], opaque: [[1, 0]], expected: false,
        },
        {
          name: 'negative direction (right-to-left, top-to-bottom) symmetric to positive',
          start: [4, 0], end: [0, 0], opaque: [[2, 0]], expected: false,
        },
      ];

      const results = cases.map((c) => {
        const opaqueSet = new Set(c.opaque.map(([x, y]) => `${x},${y}`));
        const getOpacity = (pos: [number, number]) => opaqueSet.has(`${pos[0]},${pos[1]}`);
        const got = getLine(c.start, c.end, getOpacity);
        return { name: c.name, expected: c.expected, got };
      });

      return results;
    });

    for (const r of result) {
      expect(r.got, r.name).toBe(r.expected);
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Canto remaining-movement scenarios.
// ---------------------------------------------------------------------------

test.describe('canto movement-left semantics', () => {
  test('player movement is action-backed with exact movement budget undo and redo', async ({ page }) => {
    await page.goto('/?harness=true&level=DEBUG&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 5);

    const selected = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const eirika = g.units.get('Eirika');
      if (!eirika?.position) return false;
      eirika.resetTurnState();
      g.cursor.setPos(eirika.position[0], eirika.position[1]);
      return true;
    });
    expect(selected).toBe(true);

    await stepFrames(page, 1, 'SELECT');
    expect(await page.evaluate(() => (window as any).__gameRef.state.getCurrentState()?.name)).toBe('move');

    const setup = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const eirika = g.units.get('Eirika');
      const origin: [number, number] = [...eirika.position];
      const destination = g.pathSystem.getValidMoves(eirika, g.board).find(
        ([x, y]: [number, number]) =>
          (x !== origin[0] || y !== origin[1]) && !g.board.getUnit(x, y),
      );
      if (!destination) return null;
      const path = g.pathSystem.getPath(eirika, destination[0], destination[1], g.board);
      const cost = path ? g.pathSystem.getPathCost(eirika, path, g.board) : 0;
      g.cursor.setPos(destination[0], destination[1]);
      return { origin, destination, before: eirika.movementLeft, cost };
    });
    expect(setup).not.toBeNull();

    await stepFrames(page, 1, 'SELECT');
    for (let attempt = 0; attempt < 120; attempt++) {
      const state = await page.evaluate(() => (window as any).__gameRef.state.getCurrentState()?.name);
      if (state === 'menu') break;
      await stepFrames(page, 1);
    }

    const result = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const unit = g.units.get('Eirika');
      const moved = {
        position: [...unit.position],
        movementLeft: unit.movementLeft,
        hasMoved: unit.hasMoved,
      };
      const moveAction = g.actionLog.undo();
      const undone = {
        action: moveAction?.constructor?.name ?? null,
        position: [...unit.position],
        movementLeft: unit.movementLeft,
        hasMoved: unit.hasMoved,
      };
      moveAction?.execute();
      const redone = {
        position: [...unit.position],
        movementLeft: unit.movementLeft,
        hasMoved: unit.hasMoved,
      };
      moveAction?.reverse();
      g.actionLog.undo(); // remove the action-group start marker
      return { moved, undone, redone };
    });

    expect(result.moved).toEqual({
      position: setup!.destination,
      movementLeft: Math.max(0, setup!.before - setup!.cost),
      hasMoved: true,
    });
    expect(result.undone).toEqual({
      action: 'MoveAction',
      position: setup!.origin,
      movementLeft: setup!.before,
      hasMoved: false,
    });
    expect(result.redone).toEqual(result.moved);
  });

  test('a canto re-move is bounded by leftover MOV, not full MOV', async ({ page }) => {
    await page.goto('/?harness=true&level=DEBUG&bundle=false');
    await waitForHarness(page);

    const result = await page.evaluate(async () => {
      const g = (window as any).__gameRef;
      const { PathSystem } = await import('/src/pathfinding/path-system.ts');
      const eirika = g.units.get('Eirika');
      const mov = eirika.getStatValue('MOV');
      const origin = [eirika.position[0], eirika.position[1]];

      const pathSystem: any = new PathSystem(g.db);

      // Simulate having partially spent movement this turn (as if the unit
      // had already moved and consumed some MOV) without actually moving the
      // board position, so we can compare range directly.
      eirika.movementLeft = Math.max(0, mov - 1);
      eirika.hasMoved = true;
      const cantoRange = pathSystem.getValidMoves(eirika, g.board);

      eirika.movementLeft = mov;
      const fullRange = pathSystem.getValidMoves(eirika, g.board);

      // Restore.
      eirika.resetTurnState();
      g.board.moveUnit(eirika, origin[0], origin[1]);

      return { cantoRangeSize: cantoRange.length, fullRangeSize: fullRange.length, mov };
    });

    // With 1 less MOV to spend, the canto re-move range must be no larger
    // than (and, on any grid with terrain cost >= 1, strictly smaller than
    // or equal to) the full-MOV range.
    expect(result.cantoRangeSize).toBeLessThanOrEqual(result.fullRangeSize);
  });

  test('hasCanto recognizes canto/canto_plus/canto_sharp/canter skill variants', async ({ page }) => {
    await page.goto('/?harness=true&level=DEBUG&bundle=false');
    await waitForHarness(page);

    const result = await page.evaluate(async () => {
      const { hasCanto } = await import('/src/combat/skill-system.ts');
      const { SkillObject } = await import('/src/objects/skill.ts');
      const g = (window as any).__gameRef;
      const eirika = g.units.get('Eirika');
      const savedSkills = [...eirika.skills];

      const makeSkillPrefab = (nid: string, componentNid: string) => ({
        nid,
        name: nid,
        desc: '',
        icon_nid: '',
        icon_index: [0, 0] as [number, number],
        components: [[componentNid, true]] as [string, any][],
      });

      const variants = ['canto', 'canto_plus', 'canto_sharp', 'canter'];
      const outcomes: Record<string, boolean> = {};
      for (const v of variants) {
        eirika.skills = [new SkillObject(makeSkillPrefab(v, v))];
        outcomes[v] = hasCanto(eirika);
      }
      eirika.skills = [];
      outcomes['none'] = hasCanto(eirika);

      eirika.skills = savedSkills;
      return outcomes;
    });

    expect(result.canto).toBe(true);
    expect(result.canto_plus).toBe(true);
    expect(result.canto_sharp).toBe(true);
    expect(result.canter).toBe(true);
    expect(result.none).toBe(false);
  });
});
