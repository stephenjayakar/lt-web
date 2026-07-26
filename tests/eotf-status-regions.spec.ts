import { expect, test, type Page } from '@playwright/test';

async function bootGrigol(page: Page): Promise<void> {
  await page.goto('/?harness=true&project=eotf.ltproj&level=Grigol&clean=true&bundle=false');
  await page.waitForFunction(() => (window as any).__harness?.ready === true, undefined, {
    timeout: 30_000,
  });
}

test.describe('Embrace of the Fog status-region lifecycle', () => {
  test('applies all four authored sources with precedence and movement replay', async ({
    page,
  }) => {
    await bootGrigol(page);
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { MoveAction } = await import('/src/engine/action.ts');
      const { SkillObject } = await import('/src/objects/skill.ts');
      const unit = [...game.units.values()].find(
        (candidate: any) => candidate.position && !candidate.isDead(),
      );
      if (!unit?.position) throw new Error('No positioned Grigol unit');
      const regions = game.currentLevel.regions.filter(
        (region: any) => region.region_type === 'status',
      );
      const house = regions.find((region: any) => region.nid === 'House_1');
      if (!house) throw new Error('Missing House_1 status region');
      const contains = (region: any, x: number, y: number) =>
        x >= region.position[0] && x < region.position[0] + region.size[0] &&
        y >= region.position[1] && y < region.position[1] + region.size[1];
      const findOpen = (inside: boolean): [number, number] | null => {
        for (let y = 0; y < game.board.height; y++) {
          for (let x = 0; x < game.board.width; x++) {
            if (!!contains(house, x, y) !== inside || game.board.getUnit(x, y)) continue;
            if (!inside && regions.some((region: any) => contains(region, x, y))) continue;
            return [x, y];
          }
        }
        return null;
      };
      const inside = findOpen(true);
      const outside = findOpen(false);
      if (!inside || !outside) throw new Error('Missing open region test tiles');
      const old = {
        position: [...unit.position],
        skills: unit.skills,
        movementLeft: unit.movementLeft,
        hasMoved: unit.hasMoved,
        condition: house.condition,
      };
      const sourced = () => unit.skills.find((skill: any) =>
        skill.data.get('positionStatusRegionNid') === house.nid);

      game.board.moveUnit(unit, outside[0], outside[1]);
      const before = game.actionLog.actionIndex;
      game.actionLog.doAction(new MoveAction(unit, outside, inside, game.board, 0));
      const after = game.actionLog.actionIndex;
      const appliedStatus = sourced();
      const applied = {
        nid: appliedStatus?.nid ?? null,
        uid: appliedStatus?.uid ?? null,
        source: appliedStatus?.data.get('positionStatusSourceType') ?? null,
      };
      while (game.actionLog.actionIndex > before) game.actionLog.runActionBackward();
      const rewound = sourced()?.nid ?? null;
      while (game.actionLog.actionIndex < after) game.actionLog.runActionForward();
      const redoneStatus = sourced();
      const redone = {
        nid: redoneStatus?.nid ?? null,
        uid: redoneStatus?.uid ?? null,
        sameObject: redoneStatus === appliedStatus,
      };

      const flying = new SkillObject(game.db.skills.get('Flying'));
      unit.skills.push(flying);
      game.refreshPositionSkills();
      const ignored = sourced()?.nid ?? null;
      const gain = new SkillObject(game.db.skills.get('Ambush_Predator'));
      unit.skills.push(gain);
      game.refreshPositionSkills();
      const restored = sourced()?.nid ?? null;

      house.condition = 'False';
      game.refreshPositionSkills();
      const conditioned = sourced()?.nid ?? null;

      house.condition = old.condition;
      unit.skills = old.skills;
      unit.movementLeft = old.movementLeft;
      unit.hasMoved = old.hasMoved;
      game.board.moveUnit(unit, old.position[0], old.position[1]);
      return {
        regions: regions.map((region: any) => ({
          nid: region.nid,
          skill: region.sub_nid,
        })),
        applied,
        rewound,
        redone,
        ignored,
        restored,
        conditioned,
      };
    });

    expect(result.regions).toEqual([
      { nid: 'Outside', skill: 'Outdoors' },
      { nid: 'House_1', skill: 'house_1' },
      { nid: 'House_2', skill: 'house_2' },
      { nid: 'House_3', skill: 'house_3' },
    ]);
    expect(result.applied).toMatchObject({
      nid: 'house_1',
      source: 'region',
    });
    expect(result.rewound).toBeNull();
    expect(result.redone).toEqual({
      nid: 'house_1',
      uid: result.applied.uid,
      sameObject: true,
    });
    expect(result.ignored).toBeNull();
    expect(result.restored).toBe('house_1');
    expect(result.conditioned).toBeNull();
  });

  test('re-derives the exact region source after a save round trip', async ({ page }) => {
    await bootGrigol(page);
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const unit = [...game.units.values()].find(
        (candidate: any) => candidate.position && !candidate.isDead(),
      );
      const region = game.currentLevel.regions.find(
        (candidate: any) => candidate.nid === 'House_1',
      );
      if (!unit || !region) throw new Error('Missing Grigol save fixtures');
      let destination: [number, number] | null = null;
      for (let y = region.position[1]; y < region.position[1] + region.size[1]; y++) {
        for (let x = region.position[0]; x < region.position[0] + region.size[0]; x++) {
          if (!game.board.getUnit(x, y)) {
            destination = [x, y];
            break;
          }
        }
        if (destination) break;
      }
      if (!destination) throw new Error('No open House_1 save tile');
      game.board.moveUnit(unit, destination[0], destination[1]);
      const before = unit.skills.find((skill: any) =>
        skill.data.get('positionStatusRegionNid') === region.nid);
      const snapshot = (window as any).__harness.saveSnapshot();
      game.board.removeUnit(unit);
      const loaded = await (window as any).__harness.loadSnapshot(snapshot);
      const restored = game.units.get(unit.nid);
      const after = restored.skills.filter((skill: any) =>
        skill.data.get('positionStatusRegionNid') === region.nid);
      game.board.removeUnit(restored);
      const removed = restored.skills.some((skill: any) =>
        skill.data.get('positionStatusRegionNid') === region.nid);
      return {
        loaded,
        before: before && {
          nid: before.nid,
          source: before.data.get('positionStatusSourceType'),
        },
        after: after.map((skill: any) => ({
          nid: skill.nid,
          source: skill.data.get('positionStatusSourceType'),
        })),
        removed,
      };
    });

    expect(result).toEqual({
      loaded: true,
      before: { nid: 'house_1', source: 'region' },
      after: [{ nid: 'house_1', source: 'region' }],
      removed: false,
    });
  });
});
