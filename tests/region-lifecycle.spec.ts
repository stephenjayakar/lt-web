import { test, expect, type Page } from '@playwright/test';

/**
 * Region lifecycle parity (Python action.AddRegion / RemoveRegion /
 * DecrementTimeRegion, GameState.get_terrain_nid / arrive, and
 * TurnChangeState.end's time-region countdown).
 */

test.describe.configure({ mode: 'parallel' });

async function boot(page: Page): Promise<void> {
  await page.goto('/?harness=true&level=0&clean=true&bundle=false');
  await page.waitForFunction(() => (window as any).__harness?.ready === true, undefined, {
    timeout: 60_000,
  });
  await page.evaluate(() => (window as any).__harness.stepFrames(3, null));
}

/** Install a level-scoped event and run it to completion. */
async function runEvent(page: Page, nid: string, source: string[]): Promise<void> {
  await page.evaluate(({ nid, source }) => {
    const g = (window as any).__gameRef;
    g.db.events.set(nid, {
      name: nid, nid, trigger: nid,
      level_nid: g.currentLevel?.nid ?? null,
      condition: 'True', only_once: false, priority: 0,
      _source: source,
    });
    g.eventManager.triggerSpecific(nid, { type: nid }, true);
    g.state.change('event');
  }, { nid, source });
  await page.evaluate(() => (window as any).__harness.stepFrames(30, null));
}

test.describe('Region lifecycle', () => {
  test('timed regions count down on player turns, expire, and fire time_region_complete', async ({ page }) => {
    await boot(page);
    await page.evaluate(() => {
      const g = (window as any).__gameRef;
      // Leave only the player team so each turn_change returns to player phase.
      for (const unit of [...g.units.values()]) {
        if (unit.team !== 'player' && unit.position) {
          g.board.removeUnit(unit);
          unit.position = null;
        }
      }
      g.db.events.set('QaExpire', {
        name: 'QaExpire', nid: 'QaExpire', trigger: 'time_region_complete',
        level_nid: null, condition: "region.nid == 'QaTimed'", only_once: false,
        priority: 20,
        _source: [
          'game_var;qa_region;{region}',
          'game_var;qa_position;{position}',
          "game_var;qa_still_present;{e:'QaTimed' in [r.nid for r in game.level.regions]}",
        ],
      });
    });
    // String is positional and blank; TimeLeft uses the keyword form EOtF's
    // Death ability uses.
    await runEvent(page, 'QaAddTimed', ['add_region;QaTimed;3,2;2,2;normal;;TimeLeft=2']);

    const turn = async () => page.evaluate(() => {
      const g = (window as any).__gameRef;
      g.state.change('turn_change');
      for (let frame = 0; frame < 400; frame += 1) {
        (window as any).__harness.stepFrames(1, null);
        const name = g.state.getCurrentState()?.name;
        if (name === 'free' && !g.eventManager.hasActiveEvents()) break;
      }
      const region = g.currentLevel.regions.find((r: any) => r.nid === 'QaTimed');
      return {
        turn: g.turnCount,
        timeLeft: region ? region.time_left : null,
        present: !!region,
        expiredRegion: g.gameVars.get('qa_region') ?? null,
        expiredPosition: g.gameVars.get('qa_position') ?? null,
        stillPresent: g.gameVars.get('qa_still_present') ?? null,
      };
    });

    const start = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      return g.currentLevel.regions.find((r: any) => r.nid === 'QaTimed')?.time_left;
    });
    expect(start).toBe(2);
    const second = await turn();
    expect(second).toMatchObject({ turn: 2, present: true, timeLeft: 1, expiredRegion: null });
    const third = await turn();
    expect(third).toMatchObject({ turn: 3, present: false, expiredRegion: 'QaTimed' });
    // Python removes the region before its TimeRegionComplete event runs.
    expect(third.stillPresent).toBe(false);
    expect(String(third.expiredPosition).replace(/[[\]() ]/g, '')).toBe('3,2');
  });

  test('terrain and status regions apply immediately and reverse', async ({ page }) => {
    await boot(page);
    const result = await page.evaluate(async () => {
      const g = (window as any).__gameRef;
      const eirika = g.units.get('Eirika');
      const [x, y] = eirika.position;
      const terrainAt = () => g.board.getTerrain(x, y);
      const skillNids = () => eirika.skills.map((skill: any) => skill.nid);
      const forest = g.db.terrain.get('2');
      const wall = g.db.terrain.get('9');
      return {
        position: [x, y],
        baseTerrain: terrainAt(),
        baseDef: eirika.getStatValue('DEF'),
        forestStatus: forest.status,
        wallOpaque: wall.opaque,
        baseSkills: skillNids(),
      };
    });
    const [x, y] = result.position;
    expect(result.forestStatus).toBe('Forest');
    expect(result.baseSkills).not.toContain('Forest');

    await runEvent(page, 'QaForest', [`add_region;QaForest;${x},${y};1,1;terrain;2`]);
    const forested = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const eirika = g.units.get('Eirika');
      const [x, y] = eirika.position;
      return {
        terrain: g.board.getTerrain(x, y),
        skills: eirika.skills.map((skill: any) => skill.nid),
        def: eirika.getStatValue('DEF'),
      };
    });
    expect(forested.terrain).toBe('2');
    expect(forested.skills).toContain('Forest');
    expect(forested.def).toBe(result.baseDef + 1);

    // A wall terrain region beside her blocks movement and sight.
    await runEvent(page, 'QaWall', [`add_region;QaWall;${x + 1},${y};1,1;terrain;9`]);
    const walled = await page.evaluate(({ x, y }) => {
      const g = (window as any).__gameRef;
      const eirika = g.units.get('Eirika');
      return {
        terrain: g.board.getTerrain(x + 1, y),
        opaque: g.board.getOpacity([x + 1, y]),
        cost: g.board.getMovementCost(x + 1, y, g.db.classes.get(eirika.klass)?.movement_group, g.db),
      };
    }, { x, y });
    expect(walled.terrain).toBe('9');
    expect(walled.opaque).toBe(result.wallOpaque);
    expect(walled.cost).toBeGreaterThanOrEqual(99);

    await runEvent(page, 'QaRemove', ['remove_region;QaForest', 'remove_region;QaWall']);
    const restored = await page.evaluate(({ x, y }) => {
      const g = (window as any).__gameRef;
      const eirika = g.units.get('Eirika');
      const after = {
        terrain: g.board.getTerrain(x, y),
        wallTerrain: g.board.getTerrain(x + 1, y),
        skills: eirika.skills.map((skill: any) => skill.nid),
      };
      // Undo both removals: the forest region and its status come back.
      (window as any).__harness.turnwheelUndo();
      (window as any).__harness.turnwheelUndo();
      return {
        after,
        undone: {
          terrain: g.board.getTerrain(x, y),
          skills: eirika.skills.map((skill: any) => skill.nid),
        },
      };
    }, { x, y });
    expect(restored.after.terrain).toBe(result.baseTerrain);
    expect(restored.after.skills).not.toContain('Forest');
    expect(restored.undone.terrain).toBe('2');
    expect(restored.undone.skills).toContain('Forest');

    // Status regions grant their skill as soon as they are added.
    const statusSkill = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      return [...g.db.skills.values()].find((skill: any) =>
        skill.components.every(([nid]: [string]) => nid !== 'aura'))?.nid ?? null;
    });
    expect(statusSkill).not.toBeNull();
    await runEvent(page, 'QaStatus', [`add_region;QaStatus;${x},${y};1,1;status;${statusSkill}`]);
    const statused = await page.evaluate((nid: string) =>
      (window as any).__gameRef.units.get('Eirika').skills.some((skill: any) => skill.nid === nid),
    statusSkill);
    expect(statused).toBe(true);
  });

  test('terrain statuses do not affect fliers and supply full stat changes', async ({ page }) => {
    await boot(page);
    const result = await page.evaluate(async () => {
      const g = (window as any).__gameRef;
      const { avoid } = await import('/src/combat/combat-calcs.ts');
      const seth = g.units.get('Seth');
      const [x, y] = seth.position;
      g.board.setTerrain(x, y, '1');
      g.refreshPositionSkills();
            const plain = {
        avoid: avoid(seth, g.db, g.board, null, g),
        def: seth.getStatValue('DEF'),
      };
      g.board.setTerrain(x, y, '31'); // Fort: +20 avoid, +3 DEF
      g.refreshPositionSkills();
      const fort = {
        avoid: avoid(seth, g.db, g.board, null, g),
        def: seth.getStatValue('DEF'),
        skills: seth.skills.map((skill: any) => skill.nid),
      };
      g.board.setTerrain(x, y, '2'); // Forest has is_terrain
      g.refreshPositionSkills();
      const tagsBefore = [...seth.tags];
      seth.tags = [...seth.tags, 'Flying'];
      const flyingForest = {
        avoid: avoid(seth, g.db, g.board, null, g),
        def: seth.getStatValue('DEF'),
      };
      seth.tags = tagsBefore;
      return { plain, fort, flyingForest };
    });
    expect(result.fort.skills).toContain('Fort');
    expect(result.fort.avoid).toBe(result.plain.avoid + 20);
    expect(result.fort.def).toBe(result.plain.def + 3);
    // is_terrain statuses are inert for Flying units (Python TerrainSkill).
    expect(result.flyingForest.avoid).toBe(result.plain.avoid);
    expect(result.flyingForest.def).toBe(result.plain.def);
  });
});
