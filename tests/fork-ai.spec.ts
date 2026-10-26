import { expect, test, type Page } from '@playwright/test';

/**
 * EOtF runs on a private engine fork whose ai_controller differs from
 * upstream lt-maker in a few places the web now follows per project:
 * - PrimaryAI.default_priority counts compute_blitzes in num_attacks;
 * - SecondaryAI keeps max_tp = 0 (only a positive score wins), skips items
 *   that deal 0 expected damage (no `attack_zero_dam` change), has no
 *   Interact "tile already occupied" term and no A* max_movement_limit.
 * Both engines also share rules the web used to miss: SecondaryAI never
 * advances for Attack/Support/Steal at view_range -2, and Move_away_from uses
 * smart_farthest_away_pos and ends the AI even when the best tile is home.
 *
 * Scenes are built on EOtF's hub map (level X): the open box x 21..28,
 * y 11..15 and the corridor x 10..28, y 12..14.
 */

async function bootEotf(page: Page): Promise<void> {
  await page.goto('/?harness=true&project=eotf.ltproj&level=X&clean=true&bundle=false');
  await page.waitForFunction(() => (window as any).__harness?.ready === true, undefined, { timeout: 60_000 });
  await page.evaluate(async () => {
    const g = (window as any).__gameRef;
    const { ItemObject } = await import('/src/objects/item.ts');
    const { SkillObject } = await import('/src/objects/skill.ts');
    const { setForkEngine } = await import('/src/engine/engine-flavor.ts');
    const keeper = g.units.get('Keeper');
    const player = g.units.get('Player');
    const lib = g.units.get('Lib');
    for (const unit of [...g.units.values()]) if (unit.position) g.board.removeUnit(unit);
    const flat = { HP: 40, STR: 0, MAG: 0, SKL: 0, SPD: 0, LCK: 0, DEF: 0, RES: 0, CON: 5, MOV: 3 };
    const item = (nid: string, components: Array<[string, unknown]>) => new ItemObject({
      nid, name: nid, desc: '', icon_nid: '', icon_index: [0, 0], components,
    } as any);
    const weapon = (nid: string, damage: number) => item(nid, [
      ['weapon', null], ['target_enemy', null], ['damage', damage], ['hit', 100],
      ['min_range', 1], ['max_range', 1], ['uses', 40],
    ]);
    const place = (unit: any, team: string, pos: [number, number], stats: Record<string, number> = {}) => {
      unit.team = team;
      unit.stats = { ...flat, ...stats };
      unit.currentHp = unit.stats.HP;
      unit.skills = [];
      unit.items = [];
      unit.aiGroup = '';
      unit.resetTurnState();
      g.board.setUnit(pos[0], pos[1], unit);
      return unit;
    };
    const ai = (nid: string, behaviours: Array<Record<string, unknown>>, offenseBias = 2) => {
      g.db.ai.set(nid, {
        nid, priority: 0, offense_bias: offenseBias,
        behaviours: behaviours.map((b) => ({
          target_spec: null, invert_targeting: false, roam_speed: 0,
          desired_proximity: 0, condition: '', ...b,
        })),
      });
      return nid;
    };
    const both = (unit: any) => {
      setForkEngine(true);
      const fork = g.aiController.getAction(unit);
      setForkEngine(false);
      const upstream = g.aiController.getAction(unit);
      setForkEngine(true);
      const brief = (a: any) => ({
        type: a.type, to: a.targetPosition ?? null, target: a.targetUnit?.nid ?? null,
      });
      return { fork: brief(fork), upstream: brief(upstream) };
    };
    (window as any).__forkAi = { g, keeper, player, lib, place, ai, weapon, item, both, SkillObject };
  });
}

test.describe('EOtF engine fork AI', () => {
  test.beforeEach(async ({ page }) => bootEotf(page));

  test('PrimaryAI counts blitzes as extra attacks, which changes the chosen target', async ({ page }) => {
    const result = await page.evaluate(() => {
      const { keeper, player, lib, place, ai, weapon, both, SkillObject } = (window as any).__forkAi;
      // Guard AI at (14,13) with targets on both sides; no speed, no crit.
      place(keeper, 'enemy', [14, 13]);
      keeper.items = [weapon('_ForkSpear', 16)];
      keeper.skills = [new SkillObject({
        nid: '_ForkBlitz', name: '_ForkBlitz', desc: '', icon_nid: '', icon_index: [0, 0],
        components: [['dynamic_blitzes', '2']],
      })];
      keeper.ai = ai('_ForkGuard', [{ action: 'Attack', target: 'Enemy', view_range: -1 }]);
      // Player cannot counter and takes 10 (25% of 40 HP).
      place(player, 'player', [15, 13], { DEF: 6 });
      // Lib takes 16 (40%) but counters for 20.
      place(lib, 'player', [13, 13]);
      lib.items = [weapon('_ForkAxe', 20)];
      return both(keeper);
    });
    // One attack: Player 0.5 vs Lib 0.43. Three attacks (1 + 2 blitzes):
    // Player 0.83 vs Lib 0.97 -- the fork goes for the bigger hit.
    expect(result.upstream).toMatchObject({ type: 'attack', target: 'Player' });
    expect(result.fork).toMatchObject({ type: 'attack', target: 'Lib' });
  });

  test('SecondaryAI does not advance on a target it cannot damage (no attack_zero_dam)', async ({ page }) => {
    const result = await page.evaluate(() => {
      const { keeper, player, place, ai, weapon, both } = (window as any).__forkAi;
      place(keeper, 'enemy', [10, 13]);
      keeper.items = [weapon('_ForkStick', 0)];
      keeper.ai = ai('_ForkPursue', [{ action: 'Attack', target: 'Enemy', view_range: -4 }]);
      place(player, 'player', [25, 13], { DEF: 20 });
      return both(keeper);
    });
    // Upstream scores the 0-damage target (attack_zero_dam) and walks 3 tiles.
    expect(result.upstream).toEqual({ type: 'move', to: [13, 13], target: 'Player' });
    // The fork drops it (score 0 never beats max_tp 0) and waits.
    expect(result.fork).toEqual({ type: 'wait', to: null, target: null });
  });

  test('SecondaryAI keeps max_tp 0: a path longer than e^4 tiles is never chosen', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { g, keeper, place } = (window as any).__forkAi;
      const { setForkEngine } = await import('/src/engine/engine-flavor.ts');
      place(keeper, 'enemy', [10, 13]);
      const controller = g.aiController as any;
      const original = controller.pathSystem.getPath;
      const limits: unknown[] = [];
      // A 60-tile route (distance term 1 - ln(60)/4 < 0) that stays home.
      controller.pathSystem.getPath = (unit: any, x: number, y: number, board: any, options: any) => {
        if (x === 28 && y === 13) {
          limits.push(options?.maxMovementLimit);
          return Array.from({ length: 60 }, () => [10, 13]);
        }
        return original.call(controller.pathSystem, unit, x, y, board, options);
      };
      const behaviour = {
        action: 'Move_to', target: 'Position', target_spec: [28, 13], view_range: -4,
        invert_targeting: false, roam_speed: 0, desired_proximity: 0, condition: '',
      };
      try {
        setForkEngine(true);
        const fork = controller.pythonSecondaryAI(keeper, behaviour, [[28, 13]]);
        setForkEngine(false);
        const upstream = controller.pythonSecondaryAI(keeper, behaviour, [[28, 13]]);
        return { fork, upstream: upstream?.type ?? null, limits };
      } finally {
        setForkEngine(true);
        controller.pathSystem.getPath = original;
      }
    });
    // Fork: no target accepted -> the behaviour fails (null, try the next one).
    expect(result.fork).toBeNull();
    // Upstream accepts any non-None score; the best tile is home, so it waits.
    expect(result.upstream).toBe('wait');
    // Upstream A* caps single-tile cost at the unit's movement; the fork does
    // not. (The target is beyond double move, so only the widened pass paths.)
    expect(result.limits).toEqual([undefined, 3]);
  });

  test('Interact has no occupied-tile penalty on the fork', async ({ page }) => {
    const result = await page.evaluate(() => {
      const { g, keeper, lib, place, ai, both } = (window as any).__forkAi;
      place(keeper, 'enemy', [21, 13]);
      // An ally stands on the near tile of the region; the far tile is free.
      place(lib, 'enemy', [23, 13]);
      g.currentLevel.regions.push(
        { nid: '_fork_near', region_type: 'event', position: [23, 13], size: [1, 1], sub_nid: 'Fork_Seize',
          condition: 'True', time_left: null, only_once: false, interrupt_move: false },
        { nid: '_fork_far', region_type: 'event', position: [22, 11], size: [1, 1], sub_nid: 'Fork_Seize',
          condition: 'True', time_left: null, only_once: false, interrupt_move: false },
      );
      keeper.ai = ai('_ForkSeize', [{ action: 'Interact', target: 'Event', target_spec: 'Fork_Seize', view_range: -4 }]);
      const out = both(keeper);
      g.currentLevel.regions = g.currentLevel.regions.filter((r: any) => !r.nid.startsWith('_fork_'));
      return out;
    });
    // Upstream: the free far tile wins on the +15 term and is reached this turn.
    expect(result.upstream).toEqual({ type: 'interact', to: [22, 11], target: null });
    // Fork: the nearer (occupied) tile wins on distance alone; the unit stops
    // short of the ally and does not interact.
    expect(result.fork.type).toBe('move');
    expect(result.fork.to).toEqual([22, 13]);
  });

  test('Attack at view_range -2 never advances when nothing is in reach (both engines)', async ({ page }) => {
    const result = await page.evaluate(() => {
      const { keeper, player, place, ai, weapon, both } = (window as any).__forkAi;
      place(keeper, 'enemy', [10, 13]);
      keeper.items = [weapon('_ForkSword', 10)];
      keeper.ai = ai('_ForkSingle', [{ action: 'Attack', target: 'Enemy', view_range: -2 }]);
      place(player, 'player', [16, 13]);
      return both(keeper);
    });
    expect(result.fork).toEqual({ type: 'wait', to: null, target: null });
    expect(result.upstream).toEqual({ type: 'wait', to: null, target: null });
  });

  test('Move_away_from follows smart_farthest_away_pos and stays put when cornered', async ({ page }) => {
    const result = await page.evaluate(() => {
      const { keeper, player, place, ai, weapon, both } = (window as any).__forkAi;
      const behaviours = [
        { action: 'Move_away_from', target: 'Enemy', view_range: -2 },
        { action: 'Move_to', target: 'Position', target_spec: [21, 11], view_range: -4 },
      ];
      place(keeper, 'enemy', [14, 13]);
      keeper.items = [weapon('_ForkKnife', 5)];
      keeper.ai = ai('_ForkFlee', behaviours);
      // Threats west (3 away) and north-west (2 away): away = (0.75, 0.25).
      place(player, 'player', [11, 13]);
      const lib = (window as any).__forkAi.lib;
      place(lib, 'player', [13, 12]);
      const open = both(keeper);
      // Cornered in the south-east of the box with the threat up-left: every
      // other tile points toward it, so home is best and the AI just waits
      // instead of running the Move_to behaviour.
      const g = (window as any).__forkAi.g;
      g.board.removeUnit(lib);
      g.board.removeUnit(player);
      g.board.removeUnit(keeper);
      place(keeper, 'enemy', [28, 15]);
      keeper.items = [weapon('_ForkKnife', 5)];
      place(player, 'player', [27, 13]);
      const cornered = both(keeper);
      return { open, cornered };
    });
    expect(result.open.fork).toEqual({ type: 'move', to: [17, 13], target: null });
    expect(result.open.upstream).toEqual(result.open.fork);
    expect(result.cornered.fork).toEqual({ type: 'wait', to: null, target: null });
    expect(result.cornered.upstream).toEqual(result.cornered.fork);
  });
});
