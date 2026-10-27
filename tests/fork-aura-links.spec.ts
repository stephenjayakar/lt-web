import { expect, test, type Page } from '@playwright/test';

/**
 * Aura links on EOtF's engine change only through game.arrive/leave (the unit
 * that moved re-pulls the auras at its tile and releases/propagates its own)
 * and through adding or removing an aura skill. A link between two units that
 * did neither stays, even when their alliance changed in between: a Raging
 * owner's enemy aura (Protective_Gaze) stays on an ally after Raging is gone
 * until one of the two moves (turn fuzz 23-031).
 *
 * Scene: EOtF's hub map (level X), open box x 21..28, y 11..15.
 */

async function bootEotf(page: Page): Promise<void> {
  await page.goto('/?harness=true&project=eotf.ltproj&level=X&clean=true&bundle=false');
  await page.waitForFunction(() => (window as any).__harness?.ready === true, undefined, { timeout: 60_000 });
  await page.evaluate(async () => {
    const g = (window as any).__gameRef;
    const flavor = await import('/src/engine/engine-flavor.ts');
    for (const unit of [...g.units.values()]) if (unit.position) g.board.removeUnit(unit);
    for (const unit of [...g.units.values()]) {
      unit.skills = [];
      unit.items = [];
      unit.equippedWeapon = null;
    }
    flavor.setForkEngine(true);
  });
}

test.describe('EOtF engine fork: aura links', () => {
  test.beforeEach(async ({ page }) => bootEotf(page));

  test('an enemy aura given under Raging stays on an ally until one of them moves', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const g = (window as any).__gameRef;
      const { SkillObject } = await import('/src/objects/skill.ts');
      const { AddSkillAction, RemoveSkillAction, WarpUnitAction } = await import('/src/engine/action.ts');
      const owner = g.units.get('Keeper');
      const ally = g.units.get('Player');
      const other = g.units.get('Lib');
      for (const unit of [owner, ally]) unit.team = 'player';
      other.team = 'enemy';
      g.board.setUnit(22, 13, owner);
      g.board.setUnit(24, 13, ally);
      g.board.setUnit(27, 15, other);
      const has = () => ally.skills.some((skill: any) => skill.nid === 'Protective_Gaze_Child');
      const warp = (unit: any, pos: [number, number]) =>
        g.actionLog.doAction(new WarpUnitAction(unit, pos, g.board));
      const raging = new SkillObject(g.db.skills.get('Raging_Plus'));
      g.actionLog.doAction(new AddSkillAction(owner, new SkillObject(g.db.skills.get('Protective_Gaze'))));
      const beforeRaging = has();
      g.actionLog.doAction(new AddSkillAction(owner, raging));
      const ragingNoMove = has();
      // The Raging owner moves: its aura propagates, and the ally counts as an enemy.
      warp(owner, [22, 12]);
      const afterOwnerMoves = has();
      g.actionLog.doAction(new RemoveSkillAction(owner, raging));
      const ragingGone = has();
      // A third unit moving does not touch the owner-ally link.
      warp(other, [27, 14]);
      const afterOtherMoves = has();
      // The ally moving re-decides its links: no longer an enemy.
      warp(ally, [24, 14]);
      const afterAllyMoves = has();
      return { beforeRaging, ragingNoMove, afterOwnerMoves, ragingGone, afterOtherMoves, afterAllyMoves };
    });
    expect(result).toEqual({
      beforeRaging: false,
      ragingNoMove: false,
      afterOwnerMoves: true,
      ragingGone: true,
      afterOtherMoves: true,
      afterAllyMoves: false,
    });
  });
});
