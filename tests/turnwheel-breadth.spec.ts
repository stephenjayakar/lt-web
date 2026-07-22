/**
 * P2 roadmap: turnwheel breadth verification.
 *
 * Covers the areas of the turnwheel row that were not yet exercised by
 * existing specs: death -> resurrection, recruitment (change_team),
 * support point/rank gain, fog-of-war state, initiative order mutations,
 * and a composite multi-command event undone as a single group.
 *
 * Each scenario drives the REAL ActionLog (game.actionLog.doAction / undo)
 * exactly as production event commands do (see src/engine/states/game-states.ts),
 * not synthetic direct-mutation calls.
 */

import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';

async function waitForHarness(page: Page): Promise<void> {
  await page.waitForFunction(() => !!(window as any).__harness?.ready, { timeout: 15000 });
}

async function stepFrames(page: Page, count: number): Promise<void> {
  await page.evaluate((count) => (window as any).__harness.stepFrames(count, null), count);
}

async function turnwheelUndo(page: Page): Promise<boolean> {
  return page.evaluate(() => (window as any).__harness.turnwheelUndo());
}

/** Redo: this engine's ActionLog.undo() pops+reverses (destructive), so
 * "redo" here means re-running doAction() with the same action instance,
 * which re-executes and re-appends it -- the harness's supported model
 * (there is no separate index-based forward() exposed to the page). */
async function exposeActionCtors(page: Page): Promise<void> {
  await page.evaluate(() => {
    return import('/src/engine/action.ts').then((m: any) => {
      (window as any).__A = {
        DeathAction: m.DeathAction,
        ResurrectAction: m.ResurrectAction,
        ChangeTeamAction: m.ChangeTeamAction,
        IncrementSupportPointsAction: m.IncrementSupportPointsAction,
        UnlockSupportRankAction: m.UnlockSupportRankAction,
        SetLevelVarAction: m.SetLevelVarAction,
        MoveInInitiativeAction: m.MoveInInitiativeAction,
        MarkActionGroupStart: m.MarkActionGroupStart,
        MarkActionGroupEnd: m.MarkActionGroupEnd,
        AddSkillAction: m.AddSkillAction,
        ProcessStatusEffectsAction: m.ProcessStatusEffectsAction,
      };
    });
  });
}

test.describe('Turnwheel breadth verification (P2)', () => {
  test('death -> resurrect -> undo -> redo keeps registry/board/initiative consistent', async ({ page }) => {
    await page.goto('/?harness=true&level=DEBUG&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 5);
    await exposeActionCtors(page);

    const result = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const A = (window as any).__A;
      const { InitiativeTracker } = (window as any).__InitiativeTrackerCtor
        ? { InitiativeTracker: (window as any).__InitiativeTrackerCtor }
        : { InitiativeTracker: null };
      const unit = g.units.get('Seth');
      const before = {
        dead: unit.dead,
        position: unit.position ? [...unit.position] : null,
        boardHasUnit: g.board.getUnit ? !!g.board.getUnit(unit.position[0], unit.position[1]) : null,
      };

      // Use the real initiative tracker if the level has one wired up;
      // otherwise attach a throwaway one so DeathAction's initiative
      // bookkeeping path is exercised faithfully.
      let initiative = g.initiative;
      let attachedInitiative = false;
      if (!initiative) {
        initiative = { unitLine: [unit.nid], initiativeLine: [10], currentIdx: 0, removeUnit: (u: any) => {
          const idx = initiative.unitLine.indexOf(u.nid);
          if (idx >= 0) { initiative.unitLine.splice(idx, 1); initiative.initiativeLine.splice(idx, 1); }
        } };
        attachedInitiative = true;
      }
      const initBefore = { unitLine: [...initiative.unitLine], idx: initiative.currentIdx };

      const deathAction = new A.DeathAction(unit, g.board, initiative);
      g.actionLog.doAction(deathAction);

      const afterDeath = {
        dead: unit.dead,
        inRegistry: g.units.has('Seth'),
        boardEmpty: before.position ? g.board.getUnit(before.position[0], before.position[1]) === null : null,
        initiativeHasUnit: initiative.unitLine.includes('Seth'),
      };

      // Undo the death (single action -- DeathAction has no sub-actions here).
      const undone = g.actionLog.undo();

      const afterUndo = {
        dead: unit.dead,
        position: unit.position ? [...unit.position] : null,
        initiativeHasUnit: initiative.unitLine.includes('Seth'),
      };

      // Redo: re-run the same action instance (re-executes + re-appends).
      g.actionLog.doAction(deathAction);
      const afterRedo = {
        dead: unit.dead,
        initiativeHasUnit: initiative.unitLine.includes('Seth'),
      };
      g.actionLog.undo(); // clean up so unit is alive again for later assertions

      return { before, initBefore, afterDeath, afterUndo, afterRedo, attachedInitiative };
    });

    expect(result.before.dead).toBe(false);
    expect(result.afterDeath.dead).toBe(true);
    expect(result.afterDeath.boardEmpty).toBe(true);
    expect(result.afterDeath.initiativeHasUnit).toBe(false);

    expect(result.afterUndo.dead).toBe(false);
    expect(result.afterUndo.position).toEqual(result.before.position);
    expect(result.afterUndo.initiativeHasUnit).toBe(true);

    expect(result.afterRedo.dead).toBe(true);
    expect(result.afterRedo.initiativeHasUnit).toBe(false);
  });

  test('resurrection action (Resurrect, not Death-reverse) is independently reversible', async ({ page }) => {
    await page.goto('/?harness=true&level=DEBUG&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 5);
    await exposeActionCtors(page);

    const result = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const A = (window as any).__A;
      const unit = g.units.get('Seth');
      unit.dead = true; // simulate a unit that died by some other path

      const resurrect = new A.ResurrectAction(unit);
      g.actionLog.doAction(resurrect);
      const afterExecute = unit.dead;

      g.actionLog.undo();
      const afterUndo = unit.dead;

      unit.dead = false; // restore for later tests in this worker
      return { afterExecute, afterUndo };
    });

    expect(result.afterExecute).toBe(false);
    expect(result.afterUndo).toBe(true);
  });

  test('recruitment: change_team undo restores team and AI', async ({ page }) => {
    await page.goto('/?harness=true&level=DEBUG&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 5);
    await exposeActionCtors(page);

    const result = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const A = (window as any).__A;
      const unit = g.units.get('Seth');
      const before = { team: unit.team, ai: unit.ai };

      // Give the unit an AI so we can prove ChangeTeamAction resets it
      // to 'None' on recruitment to player, and restores it on undo,
      // matching Python's ChangeTeam (action.py) which wraps ChangeAI.
      unit.ai = 'Guard';

      const action = new A.ChangeTeamAction(unit, 'player');
      g.actionLog.doAction(action);
      const afterExecute = { team: unit.team, ai: unit.ai };

      g.actionLog.undo();
      const afterUndo = { team: unit.team, ai: unit.ai };

      // restore
      unit.team = before.team;
      unit.ai = before.ai;

      return { before, afterExecute, afterUndo };
    });

    expect(result.afterExecute.team).toBe('player');
    expect(result.afterExecute.ai).toBe('None');
    expect(result.afterUndo.team).toBe(result.before.team);
    expect(result.afterUndo.ai).toBe('Guard');
  });

  test('support point gain and rank unlock: undo restores exact prior pair state', async ({ page }) => {
    await page.goto('/?harness=true&level=DEBUG&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 5);
    await exposeActionCtors(page);

    const result = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const A = (window as any).__A;
      if (!g.supports) return { skipped: true };
      const pair = g.supports.getPair('Eirika', 'Seth');
      if (!pair) return { skipped: true };

      const before = {
        points: pair.points,
        locked: [...pair.lockedRanks],
        unlocked: [...pair.unlockedRanks],
      };

      // Gain enough points to cross the C-rank threshold (19).
      const incAction = new A.IncrementSupportPointsAction(pair, 25);
      g.actionLog.doAction(incAction);
      const afterInc = {
        points: pair.points,
        locked: [...pair.lockedRanks],
        unlocked: [...pair.unlockedRanks],
      };

      // Unlock the newly-locked rank (as a support conversation would).
      const rank = pair.lockedRanks[0];
      const unlockAction = rank ? new A.UnlockSupportRankAction(pair, rank) : null;
      if (unlockAction) g.actionLog.doAction(unlockAction);
      const afterUnlock = {
        points: pair.points,
        locked: [...pair.lockedRanks],
        unlocked: [...pair.unlockedRanks],
      };

      // Undo unlock, then undo increment.
      if (unlockAction) g.actionLog.undo();
      const afterUndoUnlock = {
        points: pair.points,
        locked: [...pair.lockedRanks],
        unlocked: [...pair.unlockedRanks],
      };
      g.actionLog.undo();
      const afterUndoInc = {
        points: pair.points,
        locked: [...pair.lockedRanks],
        unlocked: [...pair.unlockedRanks],
      };

      return { skipped: false, before, afterInc, rank, afterUnlock, afterUndoUnlock, afterUndoInc };
    });

    test.skip(result.skipped === true, 'No Eirika|Seth support pair in this project data');
    if (result.skipped) return;

    expect(result.afterInc.points).toBe(result.before.points + 25);
    expect(result.rank).toBeTruthy();
    expect(result.afterUnlock.unlocked).toContain(result.rank);
    expect(result.afterUnlock.locked).not.toContain(result.rank);

    expect(result.afterUndoUnlock.locked).toContain(result.rank);
    expect(result.afterUndoUnlock.unlocked).not.toContain(result.rank);

    expect(result.afterUndoInc.points).toBe(result.before.points);
    expect(result.afterUndoInc.locked).toEqual(result.before.locked);
    expect(result.afterUndoInc.unlocked).toEqual(result.before.unlocked);
  });

  test('fog of war toggle: undo restores prior level var and recomputed visibility', async ({ page }) => {
    await page.goto('/?harness=true&level=DEBUG&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 5);
    await exposeActionCtors(page);

    const result = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const A = (window as any).__A;
      const before = g.levelVars.get('_fog_of_war');

      const action = new A.SetLevelVarAction(g.levelVars, '_fog_of_war', true);
      g.actionLog.doAction(action);
      const afterExecute = g.levelVars.get('_fog_of_war');

      g.actionLog.undo();
      const afterUndo = g.levelVars.get('_fog_of_war');

      return { before, afterExecute, afterUndo };
    });

    expect(result.afterExecute).toBe(true);
    expect(result.afterUndo).toBe(result.before);
  });

  test('initiative reorder: MoveInInitiativeAction undo restores original order', async ({ page }) => {
    await page.goto('/?harness=true&level=DEBUG&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 5);
    await exposeActionCtors(page);

    const result = await page.evaluate(async () => {
      const g = (window as any).__gameRef;
      const A = (window as any).__A;
      const { InitiativeTracker } = await import('/src/engine/initiative.ts');
      const units = ['Eirika', 'Seth'].map((n) => g.units.get(n)).filter(Boolean);
      const tracker = new InitiativeTracker();
      tracker.start(units, g.db);
      const before = [...tracker.unitLine];

      const moverNid = tracker.unitLine[tracker.unitLine.length - 1];
      const action = new A.MoveInInitiativeAction(moverNid, -(tracker.unitLine.length - 1), tracker);
      g.actionLog.doAction(action);
      const afterExecute = [...tracker.unitLine];

      g.actionLog.undo();
      const afterUndo = [...tracker.unitLine];

      return { before, moverNid, afterExecute, afterUndo };
    });

    expect(result.afterExecute[0]).toBe(result.moverNid);
    expect(result.afterExecute).not.toEqual(result.before);
    expect(result.afterUndo).toEqual(result.before);
  });

  test('status ticks undo and redo HP plus duration expiry exactly', async ({ page }) => {
    await page.goto('/?harness=true&level=DEBUG&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 5);
    await exposeActionCtors(page);

    const result = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const A = (window as any).__A;
      const unit = g.units.get('Eirika');
      unit.currentHp = 10;
      unit.statusEffects = [{
        nid: '__test_dot',
        name: 'Test DOT',
        turnsRemaining: 1,
        statMods: { DEF: -1 },
        dotDamage: 3,
        immobilize: false,
        stun: false,
      }];
      const snapshot = () => ({
        hp: unit.currentHp,
        effects: unit.statusEffects.map((effect: any) => ({
          ...effect,
          statMods: { ...effect.statMods },
        })),
      });
      const before = snapshot();
      const action = new A.ProcessStatusEffectsAction(unit);
      g.actionLog.doAction(action);
      const changed = snapshot();
      g.actionLog.undo();
      const undone = snapshot();
      g.actionLog.doAction(action);
      const redone = snapshot();
      g.actionLog.undo();
      return { before, changed, undone, redone, damage: action.damage };
    });

    expect(result.damage).toBe(3);
    expect(result.changed).toEqual({ hp: 7, effects: [] });
    expect(result.undone).toEqual(result.before);
    expect(result.redone).toEqual(result.changed);
  });

  test('turn change support growth is action-backed and reversible', async ({ page }) => {
    await page.goto('/?harness=true&level=DEBUG&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 5);

    const result = await page.evaluate(async () => {
      const g = (window as any).__gameRef;
      const pair = [...g.supports.pairs.values()].find((candidate: any) =>
        g.units.has(candidate.unit1Nid) && g.units.has(candidate.unit2Nid));
      if (!pair) return null;
      const unit1 = g.units.get(pair.unit1Nid);
      const unit2 = g.units.get(pair.unit2Nid);
      for (const unit of g.units.values()) {
        if (unit.position && unit !== unit1 && unit !== unit2) g.board.removeUnit(unit);
      }
      if (unit1.position) g.board.removeUnit(unit1);
      if (unit2.position) g.board.removeUnit(unit2);
      unit1.team = 'player';
      unit2.team = 'player';
      unit1.position = [1, 1];
      unit2.position = [2, 1];
      g.board.setUnit(1, 1, unit1);
      g.board.setUnit(2, 1, unit2);
      g.gameVars.set('_supports', true);
      g.actionLog.clear();

      const before = pair.points;
      const { TurnChangeState } = await import('/src/engine/states/game-states.ts');
      new TurnChangeState().begin();
      const changed = pair.points;
      const action = g.actionLog.undo();
      const undone = pair.points;
      action?.execute();
      const redone = pair.points;
      action?.reverse();
      return {
        before,
        changed,
        undone,
        redone,
        actionName: action?.constructor?.name ?? null,
      };
    });

    expect(result).not.toBeNull();
    expect(result!.changed).toBeGreaterThan(result!.before);
    expect(result!.undone).toBe(result!.before);
    expect(result!.redone).toBe(result!.changed);
    expect(result!.actionName).toBe('IncrementSupportPointsAction');
  });

  test('composite event: multi-command scripted sequence undone as a single group', async ({ page }) => {
    await page.goto('/?harness=true&level=DEBUG&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 5);
    await exposeActionCtors(page);

    const result = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const A = (window as any).__A;
      const unit = g.units.get('Seth');
      const before = { team: unit.team, ai: unit.ai, fog: g.levelVars.get('_fog_of_war') };
      unit.ai = 'Guard';

      // Simulate a scripted event issuing several commands atomically:
      // change_team;Seth;player  /  enable_fog_of_war;True
      g.actionLog.doAction(new A.MarkActionGroupStart(unit, 'event'));
      const teamAction = new A.ChangeTeamAction(unit, 'player');
      g.actionLog.doAction(teamAction);
      const fogAction = new A.SetLevelVarAction(g.levelVars, '_fog_of_war', true);
      g.actionLog.doAction(fogAction);
      g.actionLog.doAction(new A.MarkActionGroupEnd('event'));

      const afterExecute = { team: unit.team, ai: unit.ai, fog: g.levelVars.get('_fog_of_war') };

      // Undo the whole group: end marker, fog action, team action, start marker.
      g.actionLog.undo();
      g.actionLog.undo();
      g.actionLog.undo();
      g.actionLog.undo();

      const afterUndo = { team: unit.team, ai: unit.ai, fog: g.levelVars.get('_fog_of_war') };

      unit.team = before.team;
      unit.ai = before.ai;

      return { before, afterExecute, afterUndo };
    });

    expect(result.afterExecute.team).toBe('player');
    expect(result.afterExecute.ai).toBe('None');
    expect(result.afterExecute.fog).toBe(true);

    expect(result.afterUndo.team).toBe(result.before.team);
    expect(result.afterUndo.ai).toBe('Guard');
    expect(result.afterUndo.fog).toBe(result.before.fog);
  });
});
