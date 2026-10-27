import { expect, test, type Page } from '@playwright/test';

/**
 * EOtF engine fork: Reset runs on_refresh (NullRefresh) outside
 * phase_change/prep_main, chapter clean_up runs on_drop (RescueBonus), and
 * Rescue/Drop with Canto marks HasTraded instead of waiting.
 */

async function bootEotf(page: Page): Promise<void> {
  await page.goto('/?harness=true&project=eotf.ltproj&level=X&clean=true&bundle=false');
  await page.waitForFunction(() => (window as any).__harness?.ready === true, undefined, {
    timeout: 60_000,
  });
}

test.describe('fork reset, rescue and drop', () => {
  test('ResetAction applies NullRefresh outside phase change unless AlwaysRefresh', async ({ page }) => {
    await bootEotf(page);
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { SkillObject } = await import('/src/objects/skill.ts');
      const { ResetAction } = await import('/src/engine/action.ts');
      const unit = game.units.get('Player');
      const old = { skills: unit.skills, finished: unit.finished, attacked: unit.hasAttacked };
      const flags = () => ({
        finished: unit.finished, hasAttacked: unit.hasAttacked,
        hasMoved: unit.hasMoved, hasTraded: unit.hasTraded,
      });
      const enchain = () => new SkillObject(game.db.skills.get('Enchain_Status'));

      unit.skills = [enchain()];
      unit.finished = true;
      unit.hasAttacked = true;
      const reset = new ResetAction(unit);
      game.actionLog.doAction(reset);
      const blocked = flags();
      game.actionLog.runActionBackward();
      const reversed = flags();
      game.actionLog.runActionForward();
      const redone = flags();

      unit.skills = [enchain(), new SkillObject(game.db.skills.get('Block_Nope'))];
      game.actionLog.doAction(new ResetAction(unit));
      const alwaysRefresh = flags();

      unit.skills = [enchain()];
      unit.finished = true;
      const realGetCurrentState = game.state.getCurrentState.bind(game.state);
      game.state.getCurrentState = () => ({ name: 'phase_change' });
      try {
        game.actionLog.doAction(new ResetAction(unit));
      } finally {
        game.state.getCurrentState = realGetCurrentState;
      }
      const phaseChange = flags();

      unit.skills = old.skills;
      unit.finished = old.finished;
      unit.hasAttacked = old.attacked;
      return { blocked, reversed, redone, alwaysRefresh, phaseChange };
    });
    const waited = { finished: true, hasAttacked: true, hasMoved: true, hasTraded: true };
    const fresh = { finished: false, hasAttacked: false, hasMoved: false, hasTraded: false };
    expect(result.blocked).toEqual(waited);
    expect(result.reversed).toMatchObject({ finished: true, hasAttacked: true });
    expect(result.redone).toEqual(waited);
    expect(result.alwaysRefresh).toEqual(fresh);
    expect(result.phaseChange).toEqual(fresh);
  });

  test('chapter clean-up drops the traveler and removes its rescue bonus skill', async ({ page }) => {
    await bootEotf(page);
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { SkillObject } = await import('/src/objects/skill.ts');
      const { RescueAction } = await import('/src/engine/action.ts');
      const rescuer = game.units.get('Player');
      const traveler = game.units.get('Keeper');
      rescuer.skills = [];
      traveler.skills = [new SkillObject(game.db.skills.get('Edible'))];
      const [x, y] = rescuer.position;
      game.board.moveUnit(traveler, x + 1, y);
      game.actionLog.doAction(new RescueAction(rescuer, traveler, game.board));
      const rescued = rescuer.skills.map((skill: any) => skill.nid);
      game.cleanUpLevel();
      return {
        rescued,
        after: rescuer.skills.map((skill: any) => skill.nid),
        rescuing: rescuer.rescuing?.nid ?? null,
      };
    });
    expect(result.rescued).toContain('Eat');
    expect(result.after).not.toContain('Eat');
    expect(result.after).not.toContain('Rescue');
    expect(result.rescuing).toBeNull();
  });

  test('Rescue and Drop with Canto mark HasTraded instead of waiting', async ({ page }) => {
    await bootEotf(page);
    const setup = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { SkillObject } = await import('/src/objects/skill.ts');
      const rescuer = game.units.get('Player');
      const traveler = game.units.get('Keeper');
      rescuer.skills = [new SkillObject(game.db.skills.get('Canto'))];
      traveler.skills = [];
      traveler.stats.CON = 1;
      rescuer.resetTurnState();
      const [x, y] = rescuer.position;
      game.board.moveUnit(traveler, x + 1, y);
      game.selectedUnit = rescuer;
      game.memory.set('ability', 'rescue');
      game.state.change('targeting');
      return { team: traveler.team };
    });
    expect(setup.team).toBe('other');
    await page.evaluate(() => (window as any).__harness.stepFrames(4));
    await page.evaluate(() => (window as any).__harness.stepFrames(4, 'SELECT'));
    const rescued = await page.evaluate(() => {
      const game = (window as any).__gameRef;
      const unit = game.units.get('Player');
      return {
        traveler: unit.rescuing?.nid ?? null,
        hasTraded: unit.hasTraded,
        finished: unit.finished,
      };
    });
    expect(rescued).toEqual({ traveler: 'Keeper', hasTraded: true, finished: false });

    await page.evaluate(() => {
      const game = (window as any).__gameRef;
      const unit = game.units.get('Player');
      unit.hasRescued = false;
      unit.hasTraded = false;
      game.selectedUnit = unit;
      game.memory.set('ability', 'drop');
      game.state.change('targeting');
    });
    await page.evaluate(() => (window as any).__harness.stepFrames(4));
    const target = await page.evaluate(() => {
      const game = (window as any).__gameRef;
      const state = game.state.getCurrentState();
      const tile = state?.selection?.posList?.[0] ?? null;
      if (tile) game.cursor.setPos(tile[0], tile[1]);
      return { state: state?.name, tile };
    });
    expect(target.state).toBe('targeting');
    expect(target.tile).not.toBeNull();
    await page.evaluate(() => (window as any).__harness.stepFrames(4, 'SELECT'));
    const dropped = await page.evaluate(() => {
      const game = (window as any).__gameRef;
      const unit = game.units.get('Player');
      return {
        traveler: unit.rescuing?.nid ?? null,
        hasTraded: unit.hasTraded,
        finished: unit.finished,
      };
    });
    expect(dropped).toEqual({ traveler: null, hasTraded: true, finished: false });
  });
});
