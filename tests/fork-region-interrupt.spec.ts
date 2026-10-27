import { expect, test, type Page } from '@playwright/test';

/**
 * Python movement_funcs.check_region_interrupt + UnitPathMovementComponent +
 * action.Wait.remove_interrupt_regions (both engines): a walk stops on the
 * first interrupt_move region tile, the surprise applies HasAttacked and a
 * Wait, and the Wait fires the region trigger and removes only_once regions.
 */

async function bootEotf(page: Page): Promise<void> {
  await page.goto('/?harness=true&project=eotf.ltproj&level=X&clean=true&bundle=false');
  await page.waitForFunction(() => (window as any).__harness?.ready === true, undefined, {
    timeout: 60_000,
  });
}

async function stepFrames(page: Page, n: number, input?: string): Promise<void> {
  await page.evaluate(({ n, input }) => (window as any).__harness.stepFrames(n, input), { n, input });
}

/** Install a trap region on the second tile of a 3+ tile path and a trigger event. */
async function installTrap(page: Page, unitNid: string, condition: string, onlyOnce: boolean) {
  return page.evaluate(({ unitNid, condition, onlyOnce }) => {
    const game = (window as any).__gameRef;
    const unit = game.units.get(unitNid);
    const moves: [number, number][] = game.pathSystem.getValidMoves(unit, game.board);
    let chosen: { dest: [number, number]; path: [number, number][] } | null = null;
    for (const dest of moves) {
      if (game.board.getUnit(dest[0], dest[1])) continue;
      const path = game.pathSystem.getPath(unit, dest[0], dest[1], game.board);
      if (path && path.length >= 3 && (!chosen || path.length < chosen.path.length)) {
        chosen = { dest, path };
      }
    }
    if (!chosen) return null;
    const trap = chosen.path[1];
    game.currentLevel.regions.push({
      nid: '_TestTrap', region_type: 'event', position: [trap[0], trap[1]], size: [1, 1],
      sub_nid: '_TestTrapHit', condition, time_left: null, only_once: onlyOnce,
      interrupt_move: true, hide_time: false,
    });
    game.db.events.set('_TestTrapHit', {
      name: '_TestTrapHit', nid: '_TestTrapHit', trigger: '_TestTrapHit',
      level_nid: game.currentLevel?.nid ?? null, condition: 'True', only_once: false, priority: 0,
      _source: [
        'game_var;_test_trap_hits;{e:v("_test_trap_hits", 0) + 1}',
        // The walker's flags as the trigger runs (a phase can end, and
        // ResetAll clear them, in the frame the event finishes).
        'game_var;_test_trap_flags;[unit.has_attacked, unit.finished]',
      ],
    });
    game.gameVars.set('_test_trap_hits', 0);
    return { start: [...unit.position], dest: chosen.dest, trap, pathLength: chosen.path.length };
  }, { unitNid, condition, onlyOnce });
}

test.describe('interrupt_move regions', () => {
  test('a player walk stops on the trap, waits, fires the trigger, and removes the only_once region', async ({ page }) => {
    await bootEotf(page);
    const setup = await installTrap(page, 'Player', "not 'TrapBreaker' in unit.tags", true);
    expect(setup).not.toBeNull();
    await page.evaluate(({ dest }) => {
      const game = (window as any).__gameRef;
      const unit = game.units.get('Player');
      unit.resetTurnState();
      game.selectedUnit = unit;
      game.state.change('move');
      (window as any).__testDest = dest;
    }, { dest: setup!.dest });
    await stepFrames(page, 3);
    await page.evaluate(({ dest }) => (window as any).__gameRef.cursor.setPos(dest[0], dest[1]), { dest: setup!.dest });
    await stepFrames(page, 2, 'SELECT');
    await stepFrames(page, 180);
    const result = await page.evaluate(() => {
      const game = (window as any).__gameRef;
      const unit = game.units.get('Player');
      return {
        position: [...unit.position],
        hasAttacked: unit.hasAttacked,
        finished: unit.finished,
        hits: game.gameVars.get('_test_trap_hits'),
        regionPresent: game.currentLevel.regions.some((region: any) => region.nid === '_TestTrap'),
        // Level X is a free-roam hub, so free hands straight to free_roam.
        state: ['free', 'free_roam'].includes(game.state.getCurrentState()?.name),
      };
    });
    expect(result).toEqual({
      position: setup!.trap,
      hasAttacked: true,
      finished: true,
      hits: 1,
      regionPresent: false,
      state: true,
    });
  });

  test('the region condition and TrapBreaker skill tag let a unit walk through', async ({ page }) => {
    await bootEotf(page);
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { interruptMovePath, checkRegionInterrupt } = await import('/src/movement/region-interrupt.ts');
      const { SkillObject } = await import('/src/objects/skill.ts');
      const unit = game.units.get('Player');
      const [x, y] = unit.position;
      const path: [number, number][] = [[x, y], [x + 1, y], [x + 2, y]];
      game.currentLevel.regions.push({
        nid: '_TestTrap2', region_type: 'event', position: [x + 1, y], size: [1, 1],
        sub_nid: 'Mine', condition: "not 'TrapBreaker' in unit.tags", time_left: null,
        only_once: false, interrupt_move: true, hide_time: false,
      });
      const oldSkills = unit.skills;
      unit.skills = [];
      const stopped = interruptMovePath(unit, path, game);
      const breakerSkill = [...game.db.skills.values()].find((skill: any) =>
        skill.components.some(([nid, value]: [string, any]) =>
          nid === 'has_tags' && Array.isArray(value) && value.includes('TrapBreaker')));
      unit.skills = [new SkillObject(breakerSkill)];
      const breaker = interruptMovePath(unit, path, game);
      unit.skills = oldSkills;
      const atStart = checkRegionInterrupt(unit, game).length;
      game.currentLevel.regions = game.currentLevel.regions.filter((r: any) => r.nid !== '_TestTrap2');
      return { stopped, breaker, atStart };
    });
    expect(result.stopped.surprise).toBe(true);
    expect(result.stopped.path).toHaveLength(2);
    expect(result.breaker.surprise).toBe(false);
    expect(result.breaker.path).toHaveLength(3);
    expect(result.atStart).toBe(0);
  });

  test('an AI walk stops on the trap, skips its attack, and waits', async ({ page }) => {
    await bootEotf(page);
    const setup = await installTrap(page, 'Keeper', 'True', false);
    expect(setup).not.toBeNull();
    await page.evaluate(({ dest }) => {
      const game = (window as any).__gameRef;
      const keeper = game.units.get('Keeper');
      keeper.team = 'enemy';
      keeper.resetTurnState();
      const path = game.pathSystem.getPath(keeper, dest[0], dest[1], game.board);
      const player = game.units.get('Player');
      const original = game.aiController.getAction.bind(game.aiController);
      (window as any).__aiActions = 0;
      game.aiController.getAction = (unit: any) => {
        if (unit !== keeper) return original(unit);
        (window as any).__aiActions++;
        // An attack from the far end of the walk: the trap must cancel it.
        return {
          type: 'attack', targetPosition: dest, movePath: path,
          targetUnit: player, item: keeper.items[0] ?? null,
        };
      };
      game.phase.setCurrentTeam('enemy');
      game.state.clear();
      game.state.change('ai');
    }, { dest: setup!.dest });
    // Read the flags as soon as the trap fires, before turn_change resets them.
    for (let frame = 0; frame < 200; frame += 2) {
      await stepFrames(page, 2);
      const hit = await page.evaluate(() => (window as any).__gameRef.gameVars.get('_test_trap_hits'));
      if (hit) break;
    }
    const result = await page.evaluate(() => {
      const game = (window as any).__gameRef;
      const keeper = game.units.get('Keeper');
      const flags = game.gameVars.get('_test_trap_flags') ?? [];
      return {
        position: [...keeper.position],
        hasAttacked: !!flags[0],
        finished: !!flags[1],
        hits: game.gameVars.get('_test_trap_hits'),
        regionPresent: game.currentLevel.regions.some((region: any) => region.nid === '_TestTrap'),
        actions: (window as any).__aiActions,
      };
    });
    expect(result).toMatchObject({
      position: setup!.trap,
      hasAttacked: true,
      finished: true,
      hits: 1,
      // Not only_once: the trigger fired but the region stays.
      regionPresent: true,
      actions: 1,
    });
  });

  test('WaitAction removes only_once interrupt regions reversibly and triggers once', async ({ page }) => {
    await bootEotf(page);
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { WaitAction, setActionGameRef } = await import('/src/engine/action.ts');
      setActionGameRef(() => game);
      const unit = game.units.get('Player');
      const [x, y] = unit.position;
      game.currentLevel.regions.push({
        nid: '_TestTrap3', region_type: 'normal', position: [x, y], size: [1, 1],
        sub_nid: '', condition: 'True', time_left: null,
        only_once: true, interrupt_move: true, hide_time: false,
      });
      const present = () => game.currentLevel.regions.some((r: any) => r.nid === '_TestTrap3');
      unit.finished = false;
      game.actionLog.doAction(new WaitAction(unit));
      const afterWait = present();
      game.actionLog.runActionBackward();
      const afterUndo = present();
      game.actionLog.runActionForward();
      const afterRedo = present();
      return { afterWait, afterUndo, afterRedo };
    });
    expect(result).toEqual({ afterWait: false, afterUndo: true, afterRedo: false });
  });

  test('an event move_unit walk stops on the trap (check_position runs for event moves)', async ({ page }) => {
    await bootEotf(page);
    const setup = await installTrap(page, 'Player', 'True', false);
    expect(setup).not.toBeNull();
    await page.evaluate(({ dest }) => {
      const game = (window as any).__gameRef;
      game.db.events.set('_TestEventMove', {
        name: '_TestEventMove', nid: '_TestEventMove', trigger: '_TestEventMove',
        level_nid: game.currentLevel?.nid ?? null, condition: 'True', only_once: false, priority: 0,
        _source: [`move_unit;Player;${dest[0]},${dest[1]}`, 'game_var;_test_moved;1'],
      });
      game.eventManager.triggerSpecific('_TestEventMove', { type: '_TestEventMove' }, true);
      game.state.change('event');
    }, { dest: setup!.dest });
    for (let frame = 0; frame < 300; frame += 5) {
      await stepFrames(page, 5);
      if (await page.evaluate(() => (window as any).__gameRef.gameVars.get('_test_moved'))) break;
    }
    const result = await page.evaluate(() => {
      const game = (window as any).__gameRef;
      return {
        position: [...game.units.get('Player').position],
        moved: game.gameVars.get('_test_moved'),
      };
    });
    expect(result).toEqual({ position: setup!.trap, moved: 1 });
  });

  test('an AI canto retreat stops on the trap, then waits and fires the trigger', async ({ page }) => {
    await bootEotf(page);
    const setup = await installTrap(page, 'Keeper', 'True', false);
    expect(setup).not.toBeNull();
    await page.evaluate(async ({ dest }) => {
      const game = (window as any).__gameRef;
      const { SkillObject } = await import('/src/objects/skill.ts');
      const keeper = game.units.get('Keeper');
      keeper.team = 'enemy';
      keeper.resetTurnState();
      keeper.skills = [new SkillObject({
        nid: '_TestCanto', name: '_TestCanto', desc: '', icon_nid: '', icon_index: [0, 0],
        components: [['canto_plus', null]],
      } as any)];
      const path = game.pathSystem.getPath(keeper, dest[0], dest[1], game.board);
      game.aiController.getCantoRetreatAction = (unit: any) =>
        unit === keeper ? { type: 'move', targetPosition: dest, movePath: path } : null;
      game.phase.setCurrentTeam('enemy');
      game.state.clear();
      game.state.change('ai');
      (window as any).__setupCanto = () => {
        const ai = game.state.getCurrentState();
        ai.aiUnits = [keeper];
        ai.currentAiIndex = 0;
        ai.waitingForCombat = true;
        ai.pendingCombatTarget = null;
        keeper.hasAttacked = true;
      };
    }, { dest: setup!.dest });
    await stepFrames(page, 2);
    await page.evaluate(() => (window as any).__setupCanto());
    for (let frame = 0; frame < 200; frame += 2) {
      await stepFrames(page, 2);
      const hit = await page.evaluate(() => (window as any).__gameRef.gameVars.get('_test_trap_hits'));
      if (hit) break;
    }
    const result = await page.evaluate(() => {
      const game = (window as any).__gameRef;
      const keeper = game.units.get('Keeper');
      return {
        position: [...keeper.position],
        finished: keeper.finished,
        hits: game.gameVars.get('_test_trap_hits'),
      };
    });
    expect(result).toEqual({ position: setup!.trap, finished: true, hits: 1 });
  });

  // Python game_board.can_move_through lets the player path through an enemy
  // it can't see under fog; UnitPathMovementComponent then stops the walk
  // before it (check_position's enemy clause) as a surprise. check_position
  // tests the current tile's interrupt regions before the next tile's enemy.
  async function installAmbush(page: Page, trap: boolean) {
    return page.evaluate(({ trap }) => {
      const game = (window as any).__gameRef;
      const player = game.units.get('Player');
      const keeper = game.units.get('Keeper');
      keeper.team = 'enemy';
      game.levelVars.set('_fog_of_war', true);
      game.levelVars.set('_fog_of_war_type', 1);
      game.levelVars.set('_fog_of_war_radius', 1);
      game.recalculateAllFow();
      const fog = game.getCurrentFogInfo();
      const moves: [number, number][] = game.pathSystem.getValidMoves(player, game.board);
      let chosen: { dest: [number, number]; path: [number, number][] } | null = null;
      for (const dest of moves) {
        if (game.board.getUnit(dest[0], dest[1])) continue;
        if (game.board.inVision(dest, 'player', fog, game.db, game.getAllUnits())) continue;
        const path = game.pathSystem.getPath(player, dest[0], dest[1], game.board);
        if (!path || path.length < 4) continue;
        if (path.some(([x, y]: [number, number], i: number) => i > 0 && game.board.getUnit(x, y))) continue;
        if (!chosen || path.length < chosen.path.length) chosen = { dest, path };
      }
      if (!chosen) return null;
      game.board.moveUnit(keeper, chosen.dest[0], chosen.dest[1]);
      game.recalculateAllFow();
      if (trap) {
        const tile = chosen.path[1];
        game.currentLevel.regions.push({
          nid: '_TestTrap', region_type: 'event', position: [tile[0], tile[1]], size: [1, 1],
          sub_nid: '_TestTrapHit', condition: 'True', time_left: null, only_once: false,
          interrupt_move: true, hide_time: false,
        });
        game.db.events.set('_TestTrapHit', {
          name: '_TestTrapHit', nid: '_TestTrapHit', trigger: '_TestTrapHit',
          level_nid: game.currentLevel?.nid ?? null, condition: 'True', only_once: false, priority: 0,
          _source: ['game_var;_test_trap_hits;{e:v("_test_trap_hits", 0) + 1}'],
        });
        game.gameVars.set('_test_trap_hits', 0);
      }
      const after = game.pathSystem.getValidMoves(player, game.board);
      return {
        dest: chosen.dest,
        path: game.pathSystem.getPath(player, chosen.dest[0], chosen.dest[1], game.board),
        hiddenSelectable: after.some(([x, y]: [number, number]) => x === chosen!.dest[0] && y === chosen!.dest[1]),
      };
    }, { trap });
  }

  async function walkPlayerTo(page: Page, dest: [number, number]) {
    await page.evaluate(() => {
      const game = (window as any).__gameRef;
      const unit = game.units.get('Player');
      unit.resetTurnState();
      game.selectedUnit = unit;
      game.state.change('move');
    });
    await stepFrames(page, 3);
    await page.evaluate(({ dest }) => (window as any).__gameRef.cursor.setPos(dest[0], dest[1]), { dest });
    await stepFrames(page, 2, 'SELECT');
    await stepFrames(page, 180);
    return page.evaluate(() => {
      const game = (window as any).__gameRef;
      const unit = game.units.get('Player');
      return {
        position: [...unit.position],
        hasAttacked: unit.hasAttacked,
        finished: unit.finished,
        hits: game.gameVars.get('_test_trap_hits') ?? null,
        state: ['free', 'free_roam'].includes(game.state.getCurrentState()?.name),
      };
    });
  }

  test('fog ambush: the player paths through an unseen enemy and is stopped before it', async ({ page }) => {
    await bootEotf(page);
    const setup = await installAmbush(page, false);
    expect(setup).not.toBeNull();
    expect(setup!.hiddenSelectable).toBe(true);
    const path = setup!.path;
    expect(path[path.length - 1]).toEqual(setup!.dest);
    const result = await walkPlayerTo(page, setup!.dest);
    expect(result).toEqual({
      position: path[path.length - 2],
      hasAttacked: true,
      finished: true,
      hits: null,
      state: true,
    });
  });

  test('fog ambush: an interrupt region earlier on the path stops the walk first', async ({ page }) => {
    await bootEotf(page);
    const setup = await installAmbush(page, true);
    expect(setup).not.toBeNull();
    const result = await walkPlayerTo(page, setup!.dest);
    expect(result).toEqual({
      position: setup!.path[1],
      hasAttacked: true,
      finished: true,
      hits: 1,
      state: true,
    });
  });

  test('check_position order: current-tile region before next-tile enemy; event moves ignore enemies', async ({ page }) => {
    await bootEotf(page);
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { interruptMovePath } = await import('/src/movement/region-interrupt.ts');
      const player = game.units.get('Player');
      const keeper = game.units.get('Keeper');
      keeper.team = 'enemy';
      const [x, y] = player.position;
      const path: [number, number][] = [[x, y], [x + 1, y], [x + 2, y], [x + 3, y]];
      for (const [px, py] of path.slice(1)) {
        const other = game.board.getUnit(px, py);
        if (other && other !== keeper) game.board.removeUnit(other);
      }
      game.board.moveUnit(keeper, x + 2, y);
      const ambush = interruptMovePath(player, path, game);
      const eventMove = interruptMovePath(player, path, game, { event: true });
      game.currentLevel.regions.push({
        nid: '_TestTrap4', region_type: 'event', position: [x + 1, y], size: [1, 1],
        sub_nid: 'Mine', condition: 'True', time_left: null,
        only_once: false, interrupt_move: true, hide_time: false,
      });
      const both = interruptMovePath(player, path, game);
      const eventTrap = interruptMovePath(player, path, game, { event: true });
      return { ambush, eventMove, both, eventTrap };
    });
    expect(result.ambush).toEqual({ path: result.ambush.path.slice(0, 2), surprise: true });
    expect(result.ambush.path).toHaveLength(2);
    expect(result.eventMove.path).toHaveLength(4);
    expect(result.eventMove.surprise).toBe(false);
    // The region on tile 1 and the enemy on tile 2 both stop the unit on
    // tile 1; for an event move only the region does.
    expect(result.both.path).toHaveLength(2);
    expect(result.both.surprise).toBe(true);
    expect(result.eventTrap.path).toHaveLength(2);
    expect(result.eventTrap.surprise).toBe(true);
  });
});
