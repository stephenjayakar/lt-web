import { expect, test, type Page } from '@playwright/test';

/**
 * EOtF's engine fork turnwheel (turnwheel.py predates upstream's action-group
 * markers):
 * - a unit's group starts at a plain Move/Teleport (not a Canto move) and
 *   ends at that unit's Wait or death; turnwheel locks are groups of their
 *   own; a move still open at the end of the log is dropped;
 * - stepping over a lock group sets the lock and keeps going;
 * - the option menu opens the turnwheel only with uses left (unset reads as
 *   1); upstream also treats -1 as unlimited, the fork shows Turnwheel_empty.
 */

async function bootEotf(page: Page): Promise<void> {
  await page.goto('/?harness=true&project=eotf.ltproj&level=X&clean=true&bundle=false');
  await page.waitForFunction(() => (window as any).__harness?.ready === true, undefined, { timeout: 60_000 });
}

test.describe('EOtF engine fork turnwheel', () => {
  test.beforeEach(async ({ page }) => bootEotf(page));

  test('groups run from a plain move to the same unit\'s wait; locks split them', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const g = (window as any).__gameRef;
      const A = await import('/src/engine/action.ts');
      const { setForkEngine } = await import('/src/engine/engine-flavor.ts');
      const keeper = g.units.get('Keeper');
      const lib = g.units.get('Lib');
      for (const unit of [keeper, lib]) if (unit.position) g.board.removeUnit(unit);
      g.board.setUnit(22, 13, keeper);
      g.board.setUnit(24, 13, lib);
      const move = (unit: any, canto = false) => {
        const action = new A.MoveAction(unit, unit.position, unit.position, g.board, 0);
        action.canto = canto;
        return action;
      };
      const teleport = new A.WarpUnitAction(lib, [24, 13], g.board);
      teleport.turnwheelMove = true;
      const actions = [
        new A.MarkActionGroupStart(keeper, 'free'), // 0 (ignored by the fork)
        move(keeper),                               // 1 starts Keeper
        new A.SetMovementLeftAction(keeper, 1),     // 2
        new A.WaitAction(lib),                      // 3 another unit: no end
        new A.WaitAction(keeper),                   // 4 ends Keeper
        new A.MarkActionGroupEnd('free'),           // 5
        new A.MarkPhase('enemy'),                   // 6
        new A.LockTurnwheel(true),                  // 7
        teleport,                                   // 8 starts Lib
        move(lib, true),                            // 9 canto: no new group
        new A.DeathAction(lib, g.board),            // 10 ends Lib
        move(keeper),                               // 11 open at the end: dropped
        new A.SetMovementLeftAction(keeper, 2),     // 12
      ];
      const brief = (groups: any[]) => groups.map((group: any) => group.type === 'move'
        ? `move:${group.unit.nid}:${group.begin}-${group.end}`
        : group.type === 'phase' ? `phase:${group.phaseName}:${group.actionIndex}`
          : group.type === 'lock' ? `lock:${group.lock}:${group.actionIndex}`
            : `extra:${group.lastMoveIndex}-${group.actionIndex}`);
      setForkEngine(true);
      const fork = brief(A.ActionLog.getActionGroups(actions, -1));
      setForkEngine(false);
      const upstream = brief(A.ActionLog.getActionGroups(actions, -1));
      setForkEngine(true);
      return { fork, upstream };
    });
    expect(result.fork).toEqual([
      'move:Keeper:1-4', 'phase:enemy:6', 'lock:true:7', 'move:Lib:8-10', 'extra:11-12',
    ]);
    expect(result.upstream).toEqual(['move:Keeper:0-5', 'phase:enemy:6', 'extra:7-12']);
  });

  test('stepping back over a lock group restores the earlier lock and goes on', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const g = (window as any).__gameRef;
      const A = await import('/src/engine/action.ts');
      const keeper = g.units.get('Keeper');
      if (keeper.position) g.board.removeUnit(keeper);
      g.board.setUnit(22, 13, keeper);
      const log = new A.ActionLog();
      log.doAction(new A.MarkPhase('player'));
      log.doAction(new A.LockTurnwheel(true));
      log.doAction(new A.MoveAction(keeper, [22, 13], [23, 13], g.board, 1));
      log.doAction(new A.WaitAction(keeper));
      log.doAction(new A.LockTurnwheel(false));
      log.setUp();
      const lockedAtEnd = log.locked;
      const noop = () => {};
      // Back over the trailing lock group into Keeper's move (its end).
      const back = log.backward(noop);
      const afterBack = { index: log.actionIndex, locked: log.locked };
      // Forward over the lock group: it sets its lock and carries on.
      log.forward(noop);
      return { lockedAtEnd, back: back !== null, afterBack, afterForward: { index: log.actionIndex, locked: log.locked } };
    });
    expect(result.lockedAtEnd).toBe(true);
    expect(result.back).toBe(true);
    expect(result.afterBack).toEqual({ index: 3, locked: true });
    expect(result.afterForward).toEqual({ index: 4, locked: false });
  });

  test('the option menu turnwheel needs uses left; -1 is unlimited only upstream', async ({ page }) => {
    const pick = async (fork: boolean, uses: number | null) => {
      await page.evaluate(async ({ fork, uses }) => {
        const g = (window as any).__gameRef;
        const { setForkEngine } = await import('/src/engine/engine-flavor.ts');
        setForkEngine(fork);
        g.roamInfo = { ...(g.roamInfo ?? {}), roam: false };
        g.gameVars.set('_turnwheel', true);
        if (uses === null) g.gameVars.delete('_current_turnwheel_uses');
        else g.gameVars.set('_current_turnwheel_uses', uses);
        g.state.clear();
        g.state.change('free');
        g.state.change('option_menu');
        (window as any).__harness.stepFrames(3);
        const st: any = g.state.getCurrentState();
        st.menu.selectedIndex = st.menu.options.findIndex((o: any) => o.value === 'turnwheel');
      }, { fork, uses });
      await page.evaluate(() => (window as any).__harness.stepFrames(1, 'SELECT'));
      await page.evaluate(() => (window as any).__harness.stepFrames(5));
      return page.evaluate(() => (window as any).__gameRef.state.getCurrentState()?.name);
    };
    const forkUnset = await pick(true, null);
    const forkInfinite = await pick(true, -1);
    const upstreamInfinite = await pick(false, -1);
    const upstreamEmpty = await pick(false, 0);
    await page.evaluate(async () => {
      const { setForkEngine } = await import('/src/engine/engine-flavor.ts');
      setForkEngine(true);
    });
    expect({ forkUnset, forkInfinite, upstreamInfinite, upstreamEmpty }).toEqual({
      forkUnset: 'turnwheel', forkInfinite: 'alert', upstreamInfinite: 'turnwheel', upstreamEmpty: 'alert',
    });
  });
});
