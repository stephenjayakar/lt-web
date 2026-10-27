import { expect, test, type Page } from '@playwright/test';

/**
 * AI target and movement rules found by the AI differential fuzz and the
 * first-turn level sweep against EOtF's engine:
 * - paths never step outside the game board bounds (Python's BoundedGrid has
 *   no neighbours there), so Pursue on Tournament heads for the player, not
 *   for the spectators in the stands;
 * - PrimaryAI scores empty tiles too: a target_tile blast is thrown at the
 *   tile whose splash is worth most (EV_Hopeful's Frosty_Bomb), and the
 *   combat ends with no unit2;
 * - skill abilities are scored without item_funcs.available, but
 *   AIController.attack refuses an unavailable item: the unit walks up and
 *   waits (Thunderstruck without its Thundersparks);
 * - a blast whose damage is 0 adds no splash lethality (Python tests the
 *   damage hook's truthiness), so the Observer fires Ocular Ray, not Eye of
 *   Judgment;
 * - the AI state waits for a combat queued by a walk's callback, so the
 *   attacker still takes its canto step;
 * - asking for a unit's weapon never equips one on the fork.
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
    const item = (nid: string, components: Array<[string, unknown]>) => new ItemObject({
      nid, name: nid, desc: '', icon_nid: '', icon_index: [0, 0], components,
    } as any);
    const place = (unit: any, team: string, pos: [number, number], stats: Record<string, number> = {}) => {
      unit.team = team;
      unit.stats = { ...flat, ...stats };
      unit.currentHp = unit.stats.HP;
      unit.skills = [];
      unit.items = [];
      unit.equippedWeapon = null;
      unit.equippedAccessory = null;
      unit.aiGroup = '';
      unit.ai = 'None';
      unit.resetTurnState();
      g.board.setUnit(pos[0], pos[1], unit);
      return unit;
    };
    const give = (unit: any, items: any[]) => {
      unit.items = items;
      for (const it of items) it.owner = unit;
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
    (window as any).__tgt = {
      g, place, give, item, ai, flavor,
      keeper: g.units.get('Keeper'), player: g.units.get('Player'), lib: g.units.get('Lib'),
    };
  });
}

/** End the player turn and step until the next player phase starts. */
async function runEnemyPhase(page: Page): Promise<void> {
  const turn = await page.evaluate(async () => {
    const { g } = (window as any).__tgt;
    const { setSetting } = await import('/src/engine/states/settings-state.ts');
    setSetting('confirm_end', 0);
    g.roamInfo = { ...(g.roamInfo ?? {}), roam: false };
    const before = g.turnCount;
    g.state.clear();
    g.state.change('free');
    g.state.change('option_menu');
    (window as any).__harness.stepFrames(3);
    const st: any = g.state.getCurrentState();
    st.menu.selectedIndex = st.menu.options.findIndex((o: any) => o.value === 'end_turn');
    return before;
  });
  await page.evaluate(() => (window as any).__harness.stepFrames(1, 'SELECT'));
  for (let i = 0; i < 200; i++) {
    const done = await page.evaluate((before) => {
      const { g } = (window as any).__tgt;
      (window as any).__harness.stepFrames(10);
      return g.turnCount > before && g.phase.getCurrent() === 'player' &&
        g.state.getCurrentState()?.name === 'free';
    }, turn);
    if (done) return;
  }
  throw new Error('enemy phase did not finish');
}

test.describe('EOtF engine fork: AI targets and bounds', () => {
  test.beforeEach(async ({ page }) => bootEotf(page));

  test('paths and moves never cross tiles outside the board bounds', async ({ page }) => {
    const result = await page.evaluate(() => {
      const { g, keeper, player, place } = (window as any).__tgt;
      const saved = [...g.board.bounds];
      place(keeper, 'enemy', [23, 13], { MOV: 6 });
      place(player, 'player', [27, 13]);
      const reach = () => g.pathSystem.getValidMoves(keeper, g.board)
        .filter(([x]: [number, number]) => x > 25).length;
      const path = () =>
        g.pathSystem.getPath(keeper, 27, 13, g.board, { adjGoodEnough: true, limit: 99 });
      // Bounds ending at x 25 leave the player two tiles outside them: no
      // tile next to it is a neighbour, so there is no path at all.
      g.board.setBounds(saved[0], saved[1], 25, saved[3]);
      const bounded = { path: path(), reach: reach() };
      g.board.setBounds(saved[0], saved[1], saved[2], saved[3]);
      const open = { path: path(), reach: reach() };
      return { bounded, open };
    });
    expect(result.bounded).toEqual({ path: null, reach: 0 });
    expect(result.open.path).toEqual([[23, 13], [24, 13], [25, 13], [26, 13]]);
    expect(result.open.reach).toBeGreaterThan(0);
  });

  test('a goal whose neighbours are all out of bounds has no path', async ({ page }) => {
    const paths = await page.evaluate(async () => {
      const { AStar } = await import('/src/pathfinding/pathfinding.ts');
      const run = (bounds: [number, number, number, number] | null) => {
        const astar = new AStar(8, 6);
        astar.bounds = bounds;
        return astar.process(4, 4, 4, 0, () => true, true, 20);
      };
      // Python Tournament: the stands (row 0) lie outside bounds starting at y 2.
      return { bounded: run([0, 2, 7, 5]), open: run(null) };
    });
    expect(paths.bounded).toBeNull();
    expect(paths.open).toEqual([[4, 4], [4, 3], [4, 2], [4, 1]]);
  });

  test('PrimaryAI throws a tile blast at the empty tile whose splash scores most', async ({ page }) => {
    const decision = await page.evaluate(() => {
      const { g, keeper, player, lib, place, give, item, ai } = (window as any).__tgt;
      place(keeper, 'enemy', [22, 13], { MOV: 0 });
      give(keeper, [item('_TgtBomb', [
        ['target_tile', null], ['min_range', 2], ['max_range', 3], ['uses', 3],
        ['blast_aoe', 1], ['usable', null], ['damage', 5], ['hit', 100],
      ])]);
      keeper.ai = ai('_TgtBomber', [{ action: 'Attack', target: 'Enemy', view_range: -4 }]);
      // Both players sit one tile from the empty (24,13): hitting either one
      // alone scores less than catching both in the splash.
      place(player, 'player', [24, 12], { HP: 6 });
      place(lib, 'player', [24, 14], { HP: 6 });
      const action = g.aiController.getAction(keeper);
      return {
        type: action.type, item: action.item?.nid ?? null,
        tile: action.targetTile ?? null, unit: action.targetUnit?.nid ?? null,
      };
    });
    expect(decision).toEqual({ type: 'attack', item: '_TgtBomb', tile: [24, 13], unit: null });

    await runEnemyPhase(page);
    const hp = await page.evaluate(() => {
      const { player, lib, keeper } = (window as any).__tgt;
      return { player: player.currentHp, lib: lib.currentHp, uses: keeper.items[0]?.uses ?? null };
    });
    expect(hp).toEqual({ player: 1, lib: 1, uses: 2 });
  });

  test('a damage-0 blast adds no splash lethality, whatever the caster stats', async ({ page }) => {
    const result = await page.evaluate(() => {
      const { g, keeper, player, lib, place, give, item } = (window as any).__tgt;
      place(keeper, 'enemy', [22, 13], { MAG: 30 });
      const fog = item('_TgtFog', [
        ['spell', null], ['magic', null], ['target_tile', null], ['min_range', 1], ['max_range', 3],
        ['blast_aoe', 1], ['damage', 0], ['hit', 100],
      ]);
      give(keeper, [fog]);
      place(player, 'player', [24, 12], { HP: 10 });
      place(lib, 'player', [24, 14], { HP: 10 });
      const ctl: any = g.aiController;
      const score = () => ctl.computePrimaryPriority(
        keeper, fog, [24, 13], [22, 13], [22, 13], [player, lib], 2,
      );
      return { score: score(), hurts: ctl.predictedDamage(keeper, fog, player) };
    });
    // MAG 30 would kill either player, but Python's splash term tests
    // `if item_system.damage(unit, item):`, which is 0.
    expect(result.hurts).toBeGreaterThan(0);
    expect(result.score).toBe(0);
  });

  test('an unaffordable skill ability is scored; the AI walks up, starts no combat and waits', async ({ page }) => {
    const decision = await page.evaluate(async () => {
      const { g, keeper, player, place, ai } = (window as any).__tgt;
      const { SkillObject } = await import('/src/objects/skill.ts');
      g.db.items.set('_TgtSpark', {
        nid: '_TgtSpark', name: '_TgtSpark', desc: '', icon_nid: '', icon_index: [0, 0],
        components: [['weapon', null], ['target_enemy', null], ['damage', 10], ['hit', 100],
          ['min_range', 1], ['max_range', 1], ['no_equip', null],
          ['stack_cost_multi', { skill: 'Thundersparks', amount: 3 }]],
      });
      place(keeper, 'enemy', [22, 13]);
      keeper.skills = [new SkillObject({
        nid: '_TgtSparkSkill', name: '_TgtSparkSkill', desc: '', icon_nid: '', icon_index: [0, 0],
        components: [['ability', '_TgtSpark']],
      } as any)];
      keeper.ai = ai('_TgtSparker', [{ action: 'Attack', target: 'Enemy', view_range: -4 }]);
      place(player, 'player', [25, 13]);
      const action = g.aiController.getAction(keeper);
      return { type: action.type, item: action.item?.nid ?? null, move: action.targetPosition ?? null };
    });
    expect(decision).toEqual({ type: 'attack', item: '_TgtSpark', move: [24, 13] });

    await runEnemyPhase(page);
    const after = await page.evaluate(() => {
      const { g, keeper, player } = (window as any).__tgt;
      return {
        hp: player.currentHp, at: keeper.position, rng: g.gameVars.get?.('_combat_random_state') ?? null,
        attacked: keeper.hasAttacked,
      };
    });
    expect(after.hp).toBe(40);
    expect(after.at).toEqual([24, 13]);
    expect(after.attacked).toBe(false);
  });

  test('a unit that walks up to attack still takes its canto step afterwards', async ({ page }) => {
    await page.evaluate(async () => {
      const { g, keeper, player, place, give, item, ai } = (window as any).__tgt;
      const { SkillObject } = await import('/src/objects/skill.ts');
      place(keeper, 'enemy', [22, 13]);
      give(keeper, [item('_TgtCantoLance', [['weapon', null], ['target_enemy', null], ['damage', 1],
        ['hit', 100], ['min_range', 1], ['max_range', 1], ['uses', 40]])]);
      keeper.equip(keeper.items[0]);
      keeper.skills = [new SkillObject(g.db.skills.get('Canter'))];
      keeper.ai = ai('_TgtCanter', [{ action: 'Attack', target: 'Enemy', view_range: -4 }]);
      place(player, 'player', [25, 13]);
    });
    await runEnemyPhase(page);
    const after = await page.evaluate(() => {
      const { keeper, player } = (window as any).__tgt;
      return { at: keeper.position, hp: player.currentHp };
    });
    // It struck from (24,13), then Canter's one tile took it away again.
    expect(after.hp).toBe(39);
    expect(after.at).not.toEqual([24, 13]);
    expect(Math.abs(after.at[0] - 24) + Math.abs(after.at[1] - 13)).toBe(1);
  });

  test('asking for a weapon never equips one on the fork', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { g, keeper, place, give, item, flavor } = (window as any).__tgt;
      const { getEquippedWeapon } = await import('/src/combat/combat-calcs.ts');
      const read = (fork: boolean) => {
        flavor.setForkEngine(fork);
        place(keeper, 'enemy', [22, 13]);
        give(keeper, [item('_TgtLance', [['weapon', null], ['target_enemy', null], ['damage', 5],
          ['hit', 100], ['min_range', 1], ['max_range', 1]])]);
        const got = getEquippedWeapon(keeper, g.db, g)?.nid ?? null;
        return { got, equipped: keeper.equippedWeapon?.nid ?? null };
      };
      const out = { fork: read(true), upstream: read(false) };
      flavor.setForkEngine(true);
      return out;
    });
    expect(result.fork).toEqual({ got: null, equipped: null });
    // The upstream port still derives and caches one.
    expect(result.upstream).toEqual({ got: '_TgtLance', equipped: '_TgtLance' });
  });
});
