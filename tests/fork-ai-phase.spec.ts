import { expect, test, type Page } from '@playwright/test';

/**
 * AI-phase behaviour found by the AI differential fuzz against EOtF's engine
 * (tools/oracle/fuzz-ai.mjs):
 * - ending the player turn runs the AI state for the player team first;
 * - the AI state keeps has_run_ai and its current group across the combat,
 *   movement and event states that run above it;
 * - PrimaryAI predictions apply the weapon triangle once (compute_damage and
 *   compute_hit already include it);
 * - PrimaryAI has no view-range filter on its targets;
 * - equally scored strike tiles break in CPython set order on the fork;
 * - AStar keeps Python's heap of (f, node) tuples and its neighbour order.
 *
 * Scenes use EOtF's hub map (level X): the open box x 21..28, y 11..15.
 */

async function bootEotf(page: Page): Promise<void> {
  await page.goto('/?harness=true&project=eotf.ltproj&level=X&clean=true&bundle=false');
  await page.waitForFunction(() => (window as any).__harness?.ready === true, undefined, { timeout: 60_000 });
  await page.evaluate(async () => {
    const g = (window as any).__gameRef;
    const { ItemObject } = await import('/src/objects/item.ts');
    const flavor = await import('/src/engine/engine-flavor.ts');
    for (const unit of [...g.units.values()]) if (unit.position) g.board.removeUnit(unit);
    const flat = { HP: 40, STR: 0, MAG: 0, SKL: 0, SPD: 0, LCK: 0, DEF: 0, RES: 0, CON: 5, MOV: 3 };
    const weapon = (nid: string, damage: number, extra: Array<[string, unknown]> = []) => new ItemObject({
      nid, name: nid, desc: '', icon_nid: '', icon_index: [0, 0],
      components: [['weapon', null], ['target_enemy', null], ['damage', damage], ['hit', 100],
        ['min_range', 1], ['max_range', 1], ['uses', 40], ...extra],
    } as any);
    const place = (unit: any, team: string, pos: [number, number], stats: Record<string, number> = {}) => {
      unit.team = team;
      unit.stats = { ...flat, ...stats };
      unit.currentHp = unit.stats.HP;
      unit.skills = [];
      unit.items = [];
      unit.equippedWeapon = null;
      unit.aiGroup = '';
      unit.resetTurnState();
      g.board.setUnit(pos[0], pos[1], unit);
      return unit;
    };
    const give = (unit: any, items: any[]) => {
      unit.items = items;
      for (const it of items) it.owner = unit;
      unit.autoequip?.();
    };
    const ai = (nid: string, behaviours: Array<Record<string, unknown>>) => {
      g.db.ai.set(nid, {
        nid, priority: 0, offense_bias: 2,
        behaviours: behaviours.map((b) => ({
          target_spec: null, invert_targeting: false, roam_speed: 0,
          desired_proximity: 0, condition: '', ...b,
        })),
      });
      return nid;
    };
    flavor.setForkEngine(true);
    (window as any).__phase = {
      g, place, give, weapon, ai, flavor,
      keeper: g.units.get('Keeper'), player: g.units.get('Player'), lib: g.units.get('Lib'),
    };
  });
}

test.describe('EOtF engine fork: AI phase', () => {
  test.beforeEach(async ({ page }) => bootEotf(page));

  test('End runs the player team\'s AI first and waits nobody', async ({ page }) => {
    await page.evaluate(async () => {
      const { g, keeper, player, lib, place, give, weapon, ai } = (window as any).__phase;
      const { setSetting } = await import('/src/engine/states/settings-state.ts');
      setSetting('confirm_end', 0);
      g.roamInfo = { ...(g.roamInfo ?? {}), roam: false };
      // A player unit with an Attack preset next to an "other"-team target.
      place(keeper, 'player', [22, 13]);
      give(keeper, [weapon('_PhaseSword', 5)]);
      keeper.ai = ai('_PhaseAuto', [{ action: 'Attack', target: 'Enemy', view_range: -1 }]);
      place(lib, 'enemy', [23, 13], { HP: 60 });
      place(player, 'player', [27, 15]);
      player.ai = 'None';
      g.state.clear();
      g.state.change('free');
      g.state.change('option_menu');
      (window as any).__harness.stepFrames(3);
      const st: any = g.state.getCurrentState();
      st.menu.selectedIndex = st.menu.options.findIndex((o: any) => o.value === 'end_turn');
    });
    await page.evaluate(() => (window as any).__harness.stepFrames(1, 'SELECT'));
    let hp = 60;
    for (let i = 0; i < 120 && hp === 60; i++) {
      await page.evaluate(() => (window as any).__harness.stepFrames(10));
      hp = await page.evaluate(() => (window as any).__phase.lib.currentHp);
    }
    const result = await page.evaluate(() => {
      const { player } = (window as any).__phase;
      return { playerFinished: player.finished };
    });
    expect(hp).toBeLessThan(60);
    // Python's End does not Wait idle player units.
    expect(result.playerFinished).toBe(false);
  });

  test('the AI state keeps has_run_ai and its group when a state above it pops', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { g } = (window as any).__phase;
      const { AIState } = await import('/src/engine/states/game-states.ts');
      const state: any = new AIState();
      state.start();
      state.ranAi.add('marker');
      state.curGroup = 'center';
      state.begin();
      return { kept: state.ranAi.has('marker'), group: state.curGroup, stack: g.state.getStackNames?.() ?? null };
    });
    expect(result.kept).toBe(true);
    expect(result.group).toBe('center');
  });

  test('AI predictions count the weapon triangle once', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { g, keeper, player, place, give, weapon } = (window as any).__phase;
      const { computeDamage, computeHit } = await import('/src/combat/combat-calcs.ts');
      place(keeper, 'enemy', [22, 13], { STR: 5, SKL: 2 });
      place(player, 'player', [23, 13], { STR: 6, DEF: 7 });
      const axe = weapon('_PhaseAxe', 8, [['weapon_type', 'Axe'], ['hit', 75]]);
      const lance = weapon('_PhaseLance', 7, [['weapon_type', 'Lance'], ['hit', 80]]);
      give(keeper, [axe]);
      give(player, [lance]);
      keeper.equippedWeapon = axe;
      player.equippedWeapon = lance;
      const ctl: any = g.aiController;
      return {
        ai: ctl.predictedDamage(keeper, axe, player),
        calc: computeDamage(keeper, axe, player, g.db, g.board, g, 'attack', false, [0, 0], false, lance),
        aiHit: ctl.predictedHit(keeper, axe, player),
        calcHit: Math.min(100, computeHit(keeper, axe, player, g.db, g.board, g, 'attack', [0, 0], lance)),
      };
    });
    expect(result.ai).toBe(result.calc);
    expect(result.aiHit).toBe(result.calcHit);
  });

  test('PrimaryAI targets anything its moves reach, whatever the view range', async ({ page }) => {
    const result = await page.evaluate(() => {
      const { g, keeper, player, place, give, weapon, ai } = (window as any).__phase;
      place(keeper, 'enemy', [22, 13]);
      give(keeper, [weapon('_PhaseSpear', 5)]);
      // View range 2, but the target is 4 tiles away and reachable (MOV 3 + 1).
      keeper.ai = ai('_PhaseShortSight', [{ action: 'Attack', target: 'Enemy', view_range: 2 }]);
      place(player, 'player', [26, 13]);
      const action = g.aiController.getAction(keeper);
      return { type: action.type, target: action.targetUnit?.nid ?? null };
    });
    expect(result).toEqual({ type: 'attack', target: 'Player' });
  });

  test('equal strike tiles break in CPython set order on the fork', async ({ page }) => {
    const result = await page.evaluate(() => {
      const { g, keeper, player, place, give, weapon, ai } = (window as any).__phase;
      place(keeper, 'enemy', [22, 13]);
      give(keeper, [weapon('_PhaseSword', 5)]);
      keeper.ai = ai('_PhaseTie', [{ action: 'Attack', target: 'Enemy', view_range: -4 }]);
      // Strike tiles (24,12) and (25,13) are both 3 moves away; Python's
      // fresh set of the two iterates (25,13) first and keeps the first.
      place(player, 'player', [25, 12]);
      const action = g.aiController.getAction(keeper);
      return action.targetPosition;
    });
    expect(result).toEqual([25, 13]);
  });

  test('AStar follows Python\'s heap and neighbour order on ties', async ({ page }) => {
    const paths = await page.evaluate(async () => {
      const { AStar } = await import('/src/pathfinding/pathfinding.ts');
      const costs: Record<string, number> = { '3,1': 2, '3,2': 2, '2,3': 99, '5,4': 3 };
      const run = (start: [number, number], goal: [number, number], adj: boolean) => {
        const astar = new AStar(8, 6);
        for (const [key, cost] of Object.entries(costs)) {
          const [x, y] = key.split(',').map(Number);
          astar.setCost(x, y, cost);
        }
        return astar.process(start[0], start[1], goal[0], goal[1], () => true, adj, 0);
      };
      return [
        run([0, 0], [6, 4], false),
        run([1, 5], [6, 0], true),
        run([0, 2], [7, 2], false),
        run([7, 5], [0, 0], true),
      ];
    });
    // Paths from EOtF's engine AStar on the same grid.
    expect(paths).toEqual([
      [[0, 0], [1, 0], [2, 0], [3, 0], [4, 0], [4, 1], [4, 2], [4, 3], [5, 3], [6, 3], [6, 4]],
      [[1, 5], [2, 5], [2, 4], [3, 4], [3, 3], [4, 3], [4, 2], [5, 2], [5, 1], [6, 1]],
      [[0, 2], [1, 2], [2, 2], [3, 2], [4, 2], [5, 2], [6, 2], [7, 2]],
      [[7, 5], [6, 5], [6, 4], [6, 3], [5, 3], [4, 3], [4, 2], [4, 1], [4, 0], [3, 0], [2, 0], [1, 0]],
    ]);
  });
});
