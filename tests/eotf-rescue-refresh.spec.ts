import { expect, test, type Page } from '@playwright/test';

async function bootEotf(page: Page): Promise<void> {
  await page.goto('/?harness=true&project=eotf.ltproj&level=X&clean=true&bundle=false');
  await page.waitForFunction(() => (window as any).__harness?.ready === true, undefined, {
    timeout: 30_000,
  });
}

test.describe('Embrace of the Fog rescue and refresh hooks', () => {
  test('Null Refresh forces Wait, honors AlwaysRefresh, and replays exactly', async ({
    page,
  }) => {
    await bootEotf(page);
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { SkillObject } = await import('/src/objects/skill.ts');
      const {
        ActionLog,
        RefreshUnitAction,
      } = await import('/src/engine/action.ts');
      const unit = game.units.get('Player');
      const oldSkills = unit.skills;
      const oldTags = unit.tags;
      const oldFlags = {
        hasAttacked: unit.hasAttacked,
        hasMoved: unit.hasMoved,
        hasTraded: unit.hasTraded,
        finished: unit.finished,
        hasRescued: unit.hasRescued,
        hasDropped: unit.hasDropped,
        hasTaken: unit.hasTaken,
        hasGiven: unit.hasGiven,
        movementLeft: unit.movementLeft,
      };
      const setFlags = () => {
        unit.hasAttacked = false;
        unit.hasMoved = true;
        unit.hasTraded = false;
        unit.finished = true;
        unit.hasRescued = true;
        unit.hasDropped = false;
        unit.hasTaken = true;
        unit.hasGiven = false;
        unit.movementLeft = 2;
      };
      const snapshot = () => ({
        hasAttacked: unit.hasAttacked,
        hasMoved: unit.hasMoved,
        hasTraded: unit.hasTraded,
        finished: unit.finished,
        hasRescued: unit.hasRescued,
        hasDropped: unit.hasDropped,
        hasTaken: unit.hasTaken,
        hasGiven: unit.hasGiven,
        movementLeft: unit.movementLeft,
      });
      unit.skills = [new SkillObject(game.db.skills.get('Enchain_Status'))];
      unit.tags = unit.tags.filter((tag: string) => tag !== 'AlwaysRefresh');
      setFlags();
      const actionLog = new ActionLog();
      const before = snapshot();
      actionLog.doAction(new RefreshUnitAction(unit));
      const blocked = snapshot();
      actionLog.runActionBackward();
      const reversed = snapshot();
      actionLog.runActionForward();
      const redone = snapshot();

      setFlags();
      unit.tags = [...unit.tags, 'AlwaysRefresh'];
      const bypassLog = new ActionLog();
      bypassLog.doAction(new RefreshUnitAction(unit));
      const bypassed = snapshot();
      const authored = [...game.db.skills.values()]
        .flatMap((skill: any) => skill.components
          .filter(([component]: [string, unknown]) => component === 'null_refresh')
          .map(([, value]: [string, unknown]) => ({ skill: skill.nid, value })));

      unit.skills = oldSkills;
      unit.tags = oldTags;
      Object.assign(unit, oldFlags);
      return { authored, before, blocked, reversed, redone, bypassed };
    });

    expect(result.authored).toEqual([
      { skill: 'Nope_Child', value: null },
      { skill: 'Enchain_Status', value: null },
    ]);
    expect(result.blocked).toEqual({
      hasAttacked: true,
      hasMoved: true,
      hasTraded: true,
      finished: true,
      hasRescued: false,
      hasDropped: false,
      hasTaken: false,
      hasGiven: false,
      movementLeft: expect.any(Number),
    });
    expect(result.reversed).toEqual(result.before);
    expect(result.redone).toEqual(result.blocked);
    expect(result.bypassed).toEqual({
      hasAttacked: false,
      hasMoved: false,
      hasTraded: false,
      finished: false,
      hasRescued: false,
      hasDropped: false,
      hasTaken: false,
      hasGiven: false,
      movementLeft: expect.any(Number),
    });
  });

  test('traveler rescue bonuses follow Rescue and Drop with stable identity', async ({
    page,
  }) => {
    await bootEotf(page);
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { GameBoard } = await import('/src/objects/game-board.ts');
      const { SkillObject } = await import('/src/objects/skill.ts');
      const {
        ActionLog,
        DropAction,
        RescueAction,
      } = await import('/src/engine/action.ts');
      const rescuer = game.units.get('Player');
      const traveler = game.units.get('Keeper');
      const old = {
        rescuerSkills: rescuer.skills,
        rescuerPosition: rescuer.position,
        rescuerRescuing: rescuer.rescuing,
        rescuerTraveler: rescuer.traveler,
        rescuerHasRescued: rescuer.hasRescued,
        rescuerHasDropped: rescuer.hasDropped,
        travelerSkills: traveler.skills,
        travelerPosition: traveler.position,
        travelerRescuedBy: traveler.rescuedBy,
      };
      rescuer.skills = [];
      rescuer.rescuing = null;
      rescuer.traveler = null;
      rescuer.hasRescued = false;
      rescuer.hasDropped = false;
      traveler.skills = [new SkillObject(game.db.skills.get('Servable'))];
      traveler.rescuedBy = null;
      const board = new GameBoard(5, 5);
      board.setUnit(1, 1, rescuer);
      board.setUnit(1, 2, traveler);
      const actionLog = new ActionLog();
      const rescue = new RescueAction(rescuer, traveler, board);
      actionLog.doAction(rescue);
      const rescued = {
        traveler: rescuer.traveler,
        targetPosition: traveler.position,
        bonus: rescuer.skills
          .filter((skill: any) => skill.nid === 'Serve_Forth')
          .map((skill: any) => ({
            uid: skill.uid,
            initiator: skill.initiatorNid,
            source: skill.data.get('rescueBonusSource'),
          })),
      };
      const drop = new DropAction(rescuer, traveler, board, [2, 1]);
      actionLog.doAction(drop);
      const dropped = {
        traveler: rescuer.traveler,
        targetPosition: traveler.position,
        bonus: rescuer.skills.filter(
          (skill: any) => skill.nid === 'Serve_Forth',
        ).length,
      };
      actionLog.runActionBackward();
      const dropReversed = {
        traveler: rescuer.traveler,
        targetPosition: traveler.position,
        bonusUids: rescuer.skills
          .filter((skill: any) => skill.nid === 'Serve_Forth')
          .map((skill: any) => skill.uid),
      };
      actionLog.runActionBackward();
      const rescueReversed = {
        traveler: rescuer.traveler,
        targetPosition: traveler.position,
        bonus: rescuer.skills.filter(
          (skill: any) => skill.nid === 'Serve_Forth',
        ).length,
      };
      actionLog.runActionForward();
      const rescueRedone = {
        traveler: rescuer.traveler,
        targetPosition: traveler.position,
        bonusUids: rescuer.skills
          .filter((skill: any) => skill.nid === 'Serve_Forth')
          .map((skill: any) => skill.uid),
      };
      actionLog.runActionForward();
      const dropRedone = {
        traveler: rescuer.traveler,
        targetPosition: traveler.position,
        bonus: rescuer.skills.filter(
          (skill: any) => skill.nid === 'Serve_Forth',
        ).length,
      };
      const authored = [...game.db.skills.values()]
        .flatMap((skill: any) => skill.components
          .filter(([component]: [string, unknown]) => component === 'rescue_bonus')
          .map(([, value]: [string, unknown]) => ({ skill: skill.nid, value })));

      board.removeUnit(traveler);
      board.removeUnit(rescuer);
      rescuer.skills = old.rescuerSkills;
      rescuer.position = old.rescuerPosition;
      rescuer.rescuing = old.rescuerRescuing;
      rescuer.traveler = old.rescuerTraveler;
      rescuer.hasRescued = old.rescuerHasRescued;
      rescuer.hasDropped = old.rescuerHasDropped;
      traveler.skills = old.travelerSkills;
      traveler.position = old.travelerPosition;
      traveler.rescuedBy = old.travelerRescuedBy;
      return {
        authored,
        rescued,
        dropped,
        dropReversed,
        rescueReversed,
        rescueRedone,
        dropRedone,
      };
    });

    expect(result.authored).toEqual([
      { skill: 'Edible', value: 'Eat' },
      { skill: 'Servable', value: 'Serve_Forth' },
      { skill: 'Servable_Plus', value: 'Serve_Forth_Plus' },
    ]);
    expect(result.rescued).toMatchObject({
      traveler: 'Keeper',
      targetPosition: null,
      bonus: [{
        initiator: 'Keeper',
        source: 'Keeper',
      }],
    });
    expect(result.dropped).toEqual({
      traveler: null,
      targetPosition: [2, 1],
      bonus: 0,
    });
    expect(result.dropReversed).toEqual({
      traveler: 'Keeper',
      targetPosition: null,
      bonusUids: [result.rescued.bonus[0].uid],
    });
    expect(result.rescueReversed).toEqual({
      traveler: null,
      targetPosition: [1, 2],
      bonus: 0,
    });
    expect(result.rescueRedone).toEqual(result.dropReversed);
    expect(result.dropRedone).toEqual(result.dropped);
  });
});
