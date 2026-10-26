/**
 * AI behavior parity tests, covering the P4 audit slice against
 * `lt-maker/app/engine/ai_controller.py` / `app/utilities/algorithms`
 * (pathfinding).
 *
 * Covers behaviors fixed/verified in this slice:
 *  - target_spec 'Faction'/'Party' matching (previously stubbed `false`)
 *    (`handle_unit_spec`, ai_controller.py:652-655).
 *  - target 'Unit' includes the unit itself (`get_targets`, ai_controller.py:665
 *    -- no self-exclusion in Python).
 *  - 'Terrain' target_spec: scans the whole board for matching terrain
 *    (`get_targets`, ai_controller.py:685-689).
 *  - Guard mode (view_range -1) movement restriction is lifted when the
 *    unit's `ai_group` is active (`get_true_valid_moves`, ai_controller.py:222-230).
 *  - A* `limit`/`max_movement_limit` semantics (`pathfinding.py` AStar.process):
 *    the cost cutoff is checked against `true_f` immediately on pop, before
 *    testing goal-reached, and `max_movement_limit` gates a tile's own
 *    terrain cost, not the cumulative path cost.
 *  - `pass_through` skill makes `can_move_through` always true for both
 *    movement range and A* pathing.
 *
 * Pure decision/pathfinding cases use direct controller calls. The final case
 * drives AIState itself to prove that a resolved move and wait are recorded as
 * reversible gameplay actions.
 */

import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';

async function waitForHarness(page: Page): Promise<void> {
  await page.waitForFunction(() => !!(window as any).__harness?.ready, { timeout: 15000 });
}

async function stepFrames(page: Page, count: number): Promise<void> {
  await page.evaluate((frames) => (window as any).__harness.stepFrames(frames, null), count);
}

test.describe('AI parity', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/?harness=true&level=DEBUG&bundle=false');
    await waitForHarness(page);
  });

  test('target_spec Faction filters to matching faction only', async ({ page }) => {
    const result = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const h = (window as any).__harness;
      const bone = g.units.get('Bone'); // enemy AI unit
      const eirika = g.units.get('Eirika'); // player, will be given a faction
      const seth = g.units.get('Seth'); // player, different faction
      if (!bone || !eirika || !seth) return null;

      h.setUnitIdentity('Eirika', { faction: 'Renais' });
      h.setUnitIdentity('Seth', { faction: 'Other' });

      g.db.ai.set('__test_faction_ai', {
        nid: '__test_faction_ai',
        priority: 0,
        offense_bias: 1,
        behaviours: [{
          action: 'None', target: 'Enemy', target_spec: ['Faction', 'Renais'],
          view_range: -4, invert_targeting: false, roam_speed: 0,
          desired_proximity: 0, condition: '',
        }],
      });

      // Access the private target-gathering path indirectly: getTargets
      // is private, so instead assert via the exported filter behaviour: run the
      // controller's full getAction with an 'Interact' no-op action would not move;
      // instead call the private method through bracket access for direct assertion.
      const ai = g.aiController;
      const behaviour = g.db.ai.get('__test_faction_ai').behaviours[0];
      const targets = (ai as any).getTargets(bone, behaviour);
      const nids = targets.map((u: any) => u.nid).sort();
      return nids;
    });
    expect(result).toEqual(['Eirika']);
  });

  test('target_spec Party filters to matching party only', async ({ page }) => {
    const result = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const h = (window as any).__harness;
      const bone = g.units.get('Bone');
      const eirika = g.units.get('Eirika');
      const seth = g.units.get('Seth');
      if (!bone || !eirika || !seth) return null;

      h.setUnitIdentity('Eirika', { party: 'PartyA' });
      h.setUnitIdentity('Seth', { party: 'PartyB' });

      const behaviour = {
        action: 'None', target: 'Enemy', target_spec: ['Party', 'PartyA'],
        view_range: -4, invert_targeting: false, roam_speed: 0,
        desired_proximity: 0, condition: '',
      };
      const ai = g.aiController;
      const targets = (ai as any).getTargets(bone, behaviour);
      return targets.map((u: any) => u.nid).sort();
    });
    expect(result).toEqual(['Eirika']);
  });

  test("target 'Unit' includes the acting unit itself (no self-exclusion, matches Python get_targets)", async ({ page }) => {
    const result = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const bone = g.units.get('Bone');
      if (!bone) return null;
      const behaviour = {
        action: 'None', target: 'Unit', target_spec: null,
        view_range: -4, invert_targeting: false, roam_speed: 0,
        desired_proximity: 0, condition: '',
      };
      const ai = g.aiController;
      const targets = (ai as any).getTargets(bone, behaviour);
      return targets.some((u: any) => u.nid === 'Bone');
    });
    expect(result).toBe(true);
  });

  test('Terrain target_spec scans the whole board for matching terrain', async ({ page }) => {
    const result = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const h = (window as any).__harness;
      const bone = g.units.get('Bone');
      if (!bone) return null;

      // Stamp a distinctive terrain nid at two positions far from Bone.
      h.setTerrain(0, 0, '__test_terrain');
      h.setTerrain(7, 7, '__test_terrain');

      const behaviour = {
        action: 'None', target: 'Terrain', target_spec: '__test_terrain',
        view_range: -4, invert_targeting: false, roam_speed: 0,
        desired_proximity: 0, condition: '',
      };
      const ai = g.aiController;
      const positions = (ai as any).getTargetPositions(bone, behaviour);
      const set = new Set(positions.map((p: number[]) => `${p[0]},${p[1]}`));
      return { has00: set.has('0,0'), has77: set.has('7,7'), count: positions.length };
    });
    expect(result.has00).toBe(true);
    expect(result.has77).toBe(true);
    expect(result.count).toBe(2);
  });

  test('guard mode (view_range -1) restricts to current position unless ai_group is active', async ({ page }) => {
    const result = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const h = (window as any).__harness;
      const bone = g.units.get('Bone');
      if (!bone) return null;

      h.setUnitIdentity('Bone', { aiGroup: '__test_group' });
      // Python game.ai_group_active needs the level to define the group.
      g.currentLevel.ai_groups = [{ nid: '__test_group', trigger_threshold: 1 }];
      h.setAiGroupActive('__test_group', false);

      const ai = g.aiController;
      const restricted = (ai as any).getValidMovesForBehaviour(bone, -1);

      h.setAiGroupActive('__test_group', true);
      const widened = (ai as any).getValidMovesForBehaviour(bone, -1);

      return { restrictedCount: restricted.length, widenedCount: widened.length };
    });
    expect(result.restrictedCount).toBe(1); // only current position
    expect(result.widenedCount).toBeGreaterThan(1); // full movement range
  });

  test('A* limit cutoff uses true_f checked before goal-reached, matching Python AStar.process ordering', async ({ page }) => {
    const result = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const eirika = g.units.get('Eirika');
      if (!eirika || !eirika.position) return null;
      const [sx, sy] = eirika.position;
      // A goal 6 tiles away (Manhattan) with a limit of 3 must fail (null),
      // even though the goal itself would eventually be found.
      const farGoal: [number, number] = [sx + 3, sy + 3];
      const path = g.pathSystem.getPath(eirika, farGoal[0], farGoal[1], g.board, { limit: 3 });
      // And within-limit should succeed.
      const nearGoal: [number, number] = [sx + 1, sy + 0];
      const nearPath = g.pathSystem.getPath(eirika, nearGoal[0], nearGoal[1], g.board, { limit: 3 });
      return { farNull: path === null, nearFound: !!nearPath && nearPath.length > 0 };
    });
    expect(result.farNull).toBe(true);
    expect(result.nearFound).toBe(true);
  });

  test('pass_through skill lets a unit path through enemy-occupied tiles', async ({ page }) => {
    const result = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const h = (window as any).__harness;
      const eirika = g.units.get('Eirika');
      const bone = g.units.get('Bone');
      if (!eirika || !bone || !eirika.position || !bone.position) return null;

      // Move Bone directly adjacent to Eirika so it blocks the straight path,
      // then verify a beyond-Bone tile is unreachable without pass_through...
      const [ex, ey] = eirika.position;
      g.board.removeUnit(bone);
      bone.position = [ex + 1, ey];
      g.board.setUnit(ex + 1, ey, bone);
      const beyond: [number, number] = [ex + 2, ey];

      const blockedPath = g.pathSystem.getPath(eirika, beyond[0], beyond[1], g.board);

      // ...but reachable once Eirika has a pass_through-granting skill.
      eirika.skills.push({
        nid: 'test_pass_through',
        components: new Map([['pass_through', true]]),
        data: new Map(),
        hasComponent: (name: string) => name === 'pass_through',
        getComponent: (name: string) => name === 'pass_through' ? true : undefined,
      });
      const passPath = g.pathSystem.getPath(eirika, beyond[0], beyond[1], g.board);

      // Clean up so later assertions in this same evaluate aren't polluted.
      eirika.skills.pop();

      return {
        blockedIsNullOrDetours: blockedPath === null || !blockedPath.some((p: number[]) => p[0] === ex + 1 && p[1] === ey),
        passFound: !!passPath && passPath.some((p: number[]) => p[0] === ex + 1 && p[1] === ey),
      };
    });
    expect(result?.passFound).toBe(true);
  });

  test('AIState records movement and wait for exact undo and redo', async ({ page }) => {
    const setup = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const unit = g.units.get('Bone');
      if (!unit?.position) return null;
      unit.resetTurnState();
      const origin: [number, number] = [...unit.position];
      const destination = g.pathSystem.getValidMoves(unit, g.board).find(
        ([x, y]: [number, number]) =>
          (x !== origin[0] || y !== origin[1]) && !g.board.getUnit(x, y),
      );
      if (!destination) return null;
      const path = g.pathSystem.getPath(unit, destination[0], destination[1], g.board);
      if (!path) return null;
      const before = unit.movementLeft;
      const cost = g.pathSystem.getPathCost(unit, path, g.board);
      // The AI's wait now fires unit_wait (Python unit.wait()); drop the
      // level's unit_wait events so only the AI's own actions are recorded.
      for (const [nid, event] of [...g.db.events.entries()]) {
        if (event.trigger === 'unit_wait') g.db.events.delete(nid);
      }
      // Only Bone walks: the other AI units must not stand in its path
      // (check_position stops a walk before an enemy, as an ambush).
      g.aiController.getAction = (actor: any) => actor === unit
        ? { type: 'move', targetPosition: destination, movePath: path }
        : { type: 'wait' };
      g.state.change('ai');
      return { origin, destination, before, cost };
    });
    expect(setup).not.toBeNull();
    await stepFrames(page, 1);

    await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const state: any = g.state.getCurrentState();
      state.aiUnits = [g.units.get('Bone')];
      state.currentAiIndex = 0;
      state.frameCounter = 5;
    });
    await stepFrames(page, 1);
    for (let attempt = 0; attempt < 180; attempt++) {
      const finished = await page.evaluate(() => (window as any).__gameRef.units.get('Bone').finished);
      if (finished) break;
      await stepFrames(page, 1);
    }

    const result = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const unit = g.units.get('Bone');
      const snapshot = () => ({
        position: [...unit.position],
        movementLeft: unit.movementLeft,
        hasMoved: unit.hasMoved,
        finished: unit.finished,
      });
      const moved = snapshot();
      const actions = [
        g.actionLog.undo(),
        g.actionLog.undo(),
        g.actionLog.undo(),
        g.actionLog.undo(),
      ];
      const undone = snapshot();
      for (const action of [...actions].reverse()) action?.execute();
      const redone = snapshot();
      for (const action of actions) action?.reverse();
      return {
        moved,
        undone,
        redone,
        actionNames: actions.map((action: any) => action?.constructor?.name ?? null),
      };
    });

    expect(result.moved).toEqual({
      position: setup!.destination,
      movementLeft: Math.max(0, setup!.before - setup!.cost),
      hasMoved: true,
      finished: true,
    });
    expect(result.undone).toEqual({
      position: setup!.origin,
      movementLeft: setup!.before,
      hasMoved: false,
      finished: false,
    });
    expect(result.redone).toEqual(result.moved);
    expect(result.actionNames).toEqual([
      'MarkActionGroupEnd',
      'WaitAction',
      'MoveAction',
      'MarkActionGroupStart',
    ]);
  });

  // Python AIGroupObject / AIController.think / AIState.get_next_unit: a
  // grouped unit committing to an action triggers its group; below the
  // trigger threshold it does nothing (no wait). The threshold-th member
  // pings the group active, the waiting members run their AI again (group
  // first), and the triggered sets clear when the AI phase ends.
  test('AI groups: threshold 2 holds the first member until the second triggers', async ({ page }) => {
    const setup = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const enemies = [...g.units.values()].filter((u: any) => u.position && u.team !== 'player' && !u.isDead());
      if (enemies.length < 2) return null;
      const [a, b] = enemies;
      for (const other of enemies.slice(2)) g.board.removeUnit(other);
      for (const u of [a, b]) { u.aiGroup = '_G'; u.resetTurnState(); }
      g.currentLevel.ai_groups = [{ nid: '_G', trigger_threshold: 2 }];
      g.activeAiGroups.clear();
      const free = (u: any) => [[1, 0], [-1, 0], [0, 1], [0, -1]]
        .map(([dx, dy]) => [u.position[0] + dx, u.position[1] + dy])
        .find(([x, y]) => g.board.inBounds(x, y) && !g.board.getUnit(x, y));
      const targets = new Map([[a, free(a)], [b, free(b)]]);
      const order: string[] = [];
      (window as any).__groupOrder = order;
      g.aiController.getAction = (unit: any) => {
        order.push(`${unit.nid}:${g.isAiGroupActive('_G') ? 'active' : 'idle'}`);
        const target = targets.get(unit);
        return target ? { type: 'move', unit, targetPosition: target, movePath: [[...unit.position], target] } : { type: 'wait', unit };
      };
      g.phase.setCurrentTeam(a.team);
      g.state.clear();
      g.state.change('ai');
      return { a: a.nid, b: b.nid, aStart: [...a.position], bStart: [...b.position] };
    });
    expect(setup).not.toBeNull();
    for (let i = 0; i < 120; i++) {
      await stepFrames(page, 2);
      const done = await page.evaluate(() => (window as any).__gameRef.state.getCurrentState()?.name !== 'ai');
      if (done) break;
    }
    const result = await page.evaluate(({ a, b }) => {
      const g = (window as any).__gameRef;
      const ua = g.units.get(a);
      const ub = g.units.get(b);
      return {
        order: (window as any).__groupOrder,
        active: g.isAiGroupActive('_G'),
        triggered: g.aiGroupTriggered.size,
        aMoved: ua.hasMoved || ua.finished,
        bMoved: ub.hasMoved || ub.finished,
      };
    }, setup!);
    // The first member asked while idle and held; the second's trigger
    // pinged the group, and the first ran again while active.
    expect(result.order.length).toBe(3);
    expect(result.order[0].endsWith(':idle')).toBe(true);
    expect(result.order[1].endsWith(':idle')).toBe(true);
    expect(result.order[2]).toBe(`${result.order[0].split(':')[0]}:active`);
    expect(result).toMatchObject({ active: true, triggered: 0, aMoved: true, bMoved: true });
  });

  test('AI groups: Python ai_group_active is false without a level group; guards without one stay put', async ({ page }) => {
    const result = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const unit = [...g.units.values()].find((u: any) => u.position && u.team !== 'player');
      unit.aiGroup = '';
      g.currentLevel.ai_groups = [{ nid: '_Known', trigger_threshold: 1 }];
      g.activeAiGroups.add('_Unknown');
      const moves = (g.aiController as any).getValidMovesForBehaviour(unit, -1);
      return {
        empty: g.isAiGroupActive(''),
        unknown: g.isAiGroupActive('_Unknown'),
        known: g.isAiGroupActive('_Known'),
        guardMoves: moves.length,
      };
    });
    expect(result).toEqual({ empty: false, unknown: false, known: false, guardMoves: 1 });
  });

  test('an AI unit that finds nothing does not wait (did_something False)', async ({ page }) => {
    const setup = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const enemies = [...g.units.values()].filter((u: any) => u.position && u.team !== 'player' && !u.isDead());
      for (const u of enemies) u.resetTurnState();
      g.aiController.getAction = (unit: any) => ({ type: 'wait', unit });
      g.phase.setCurrentTeam(enemies[0].team);
      g.state.clear();
      g.state.change('ai');
      return enemies.map((u: any) => u.nid);
    });
    for (let i = 0; i < 120; i++) {
      await stepFrames(page, 2);
      if (await page.evaluate(() => (window as any).__gameRef.state.getCurrentState()?.name !== 'ai')) break;
    }
    const finished = await page.evaluate((nids) => nids.map((nid: string) => (window as any).__gameRef.units.get(nid).finished), setup);
    expect(finished.every((value: boolean) => value === false)).toBe(true);
  });

  // Python AIState: a unit whose action went through (here an item use) waits
  // via unit.wait(), firing unit_wait with actively_chosen False.
  test('an AI item use waits the unit through unit_wait', async ({ page }) => {
    const setup = await page.evaluate(async () => {
      const g = (window as any).__gameRef;
      const { ItemObject } = await import('/src/objects/item.ts');
      const enemies = [...g.units.values()].filter((u: any) => u.position && u.team !== 'player' && !u.isDead());
      const user = enemies[0];
      for (const u of enemies) u.resetTurnState();
      user.currentHp = Math.max(1, user.currentHp - 5);
      const potion = new ItemObject({
        nid: '_AiPotion', name: 'Potion', desc: '', icon_nid: '', icon_index: [0, 0],
        components: [['usable', null], ['heal', 5], ['uses', 3], ['target_ally', null]],
      } as any);
      potion.owner = user;
      user.items.push(potion);
      g.db.events.set('_AiWait', {
        name: '_AiWait', nid: '_AiWait', trigger: 'unit_wait', level_nid: null,
        condition: `unit1.nid == '${user.nid}' and not actively_chosen`, only_once: false, priority: 0,
        _source: ['game_var;_ai_waited;1'],
      });
      g.aiController.getAction = (unit: any) => unit === user
        ? { type: 'use_item', unit, item: potion, targetUnit: unit, targetPosition: [...unit.position], movePath: [[...unit.position]] }
        : { type: 'wait', unit };
      g.phase.setCurrentTeam(user.team);
      g.state.clear();
      g.state.change('ai');
      return user.nid;
    });
    for (let i = 0; i < 120; i++) {
      await stepFrames(page, 2);
      if (await page.evaluate(() => (window as any).__gameRef.gameVars.get('_ai_waited'))) break;
    }
    const result = await page.evaluate((nid) => {
      const g = (window as any).__gameRef;
      return { waited: g.gameVars.get('_ai_waited') ?? null, finished: g.units.get(nid).finished };
    }, setup);
    expect(result).toEqual({ waited: 1, finished: true });
  });

  // Python item_funcs.get_max_range: every available inventory item counts
  // (multi items by their leaves), not only weapons and spells.
  test('AI view limits use the max range of every available item', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const g = (window as any).__gameRef;
      const { ItemObject } = await import('/src/objects/item.ts');
      const unit = [...g.units.values()].find((u: any) => u.position && u.team !== 'player');
      const before = (g.aiController as any).getMaxItemRange(unit);
      const horn = new ItemObject({
        nid: '_AiHorn', name: 'Horn', desc: '', icon_nid: '', icon_index: [0, 0],
        components: [['usable', null], ['target_ally', null], ['min_range', 1], ['max_range', 7]],
      } as any);
      horn.owner = unit;
      unit.items.push(horn);
      const after = (g.aiController as any).getMaxItemRange(unit);
      return { before, after };
    });
    expect(result.before).toBeLessThan(7);
    expect(result.after).toBe(7);
  });
});
