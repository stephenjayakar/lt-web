import { expect, test, type Page } from '@playwright/test';

async function bootEotf(page: Page): Promise<void> {
  await page.goto('/?harness=true&project=eotf.ltproj&level=X&clean=true&bundle=false');
  await page.waitForFunction(() => (window as any).__harness?.ready === true, undefined, {
    timeout: 30_000,
  });
}

test.describe('Embrace of the Fog dynamic item range and AOE hooks', () => {
  test('uses evaluated range in item dispatch and live target discovery', async ({ page }) => {
    await bootEotf(page);
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const harness = (window as any).__harness;
      const { ItemObject } = await import('/src/objects/item.ts');
      const { SkillObject } = await import('/src/objects/skill.ts');
      const { minimumRange, maximumRange } = await import('/src/combat/item-system.ts');
      const attacker = game.units.get('Player');
      const defender = game.units.get('Keeper');
      harness.warpUnit(attacker.nid, 5, 5);
      harness.warpUnit(defender.nid, 8, 5);
      attacker.team = 'player';
      defender.team = 'enemy';
      const spark = new ItemObject(game.db.items.get('Spark'));
      // Keep the authored range hooks while removing its personal/proficiency
      // gates so the harness unit can exercise normal TargetSystem routing.
      spark.components.delete('prf_unit');
      spark.components.delete('weapon_type');
      spark.components.delete('weapon_rank');
      const oldSkills = attacker.skills;
      attacker.skills = [];
      const ordinary = {
        minimum: minimumRange(attacker, spark, game),
        maximum: maximumRange(attacker, spark, game),
        objectMinimum: spark.getMinRange(attacker, game),
        objectMaximum: spark.getMaxRange(attacker, game),
        targets: game.targetSystem.getValidTargets(attacker, spark),
      };
      attacker.skills = [new SkillObject(game.db.skills.get('Focus_Mode'))];
      const focused = {
        minimum: minimumRange(attacker, spark, game),
        maximum: maximumRange(attacker, spark, game),
        objectMinimum: spark.getMinRange(attacker, game),
        objectMaximum: spark.getMaxRange(attacker, game),
        targets: game.targetSystem.getValidTargets(attacker, spark),
      };
      attacker.skills = oldSkills;
      return {
        ordinary: {
          ...ordinary,
          hasDistanceThree: ordinary.targets.some(([x, y]: [number, number]) => x === 8 && y === 5),
        },
        focused: {
          ...focused,
          hasDistanceThree: focused.targets.some(([x, y]: [number, number]) => x === 8 && y === 5),
        },
      };
    });

    expect(result.ordinary).toEqual(expect.objectContaining({
      minimum: 2,
      maximum: 2,
      objectMinimum: 2,
      objectMaximum: 2,
      hasDistanceThree: false,
    }));
    expect(result.focused).toEqual(expect.objectContaining({
      minimum: 3,
      maximum: 3,
      objectMinimum: 3,
      objectMaximum: 3,
      hasDistanceThree: true,
    }));
  });

  test('resolves evaluated smart and ally blasts with Python target semantics', async ({ page }) => {
    await bootEotf(page);
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { ItemObject } = await import('/src/objects/item.ts');
      const { SkillObject } = await import('/src/objects/skill.ts');
      const { UnitObject } = await import('/src/objects/unit.ts');
      const { splash, splashPositions } = await import('/src/combat/item-system.ts');
      const attacker = game.units.get('Player');
      const prefab = game.db.units.get('Player');
      const klass = game.db.classes.get(attacker.klass);
      const makeUnit = (nid: string, team: string) => {
        const unit = new UnitObject({ ...prefab, nid, name: nid, starting_items: [] }, klass);
        unit.team = team;
        return unit;
      };
      const centerEnemy = makeUnit('_AoeCenterEnemy', 'enemy');
      const farEnemy = makeUnit('_AoeFarEnemy', 'enemy');
      const nearbyAlly = makeUnit('_AoeNearbyAlly', 'player');
      const board = game.board;
      const oldOnChange = board.onUnitPositionChanged;
      board.onUnitPositionChanged = undefined;
      if (attacker.position) board.removeUnit(attacker);
      board.setUnit(5, 5, attacker);
      board.setUnit(8, 5, centerEnemy);
      board.setUnit(8, 7, farEnemy);
      board.setUnit(8, 6, nearbyAlly);
      const context = { board, db: game.db, game };

      const smoke = new ItemObject(game.db.items.get('Smoke_Bomb'));
      const oldSkills = attacker.skills;
      attacker.skills = [];
      const ordinaryPreview = splashPositions(attacker, smoke, [8, 5], context);
      const ordinary = splash(attacker, smoke, [8, 5], context);
      attacker.skills = [new SkillObject(game.db.skills.get('Bolas'))];
      const empoweredPreview = splashPositions(attacker, smoke, [8, 5], context);
      const empowered = splash(attacker, smoke, [8, 5], context);

      const rainfall = new ItemObject(game.db.items.get('Rainfall'));
      attacker.skills = Array.from({ length: 4 }, () =>
        new SkillObject(game.db.skills.get('Convergeance')));
      const allyBlast = splash(attacker, rainfall, [8, 5], context);

      const key = ([x, y]: [number, number]) => `${x},${y}`;
      const output = {
        ordinaryPreview: ordinaryPreview.map(key),
        ordinary: {
          main: ordinary.mainTarget ? key(ordinary.mainTarget) : null,
          splash: ordinary.splash.map(key),
        },
        empoweredPreview: empoweredPreview.map(key),
        empowered: {
          main: empowered.mainTarget ? key(empowered.mainTarget) : null,
          splash: empowered.splash.map(key),
        },
        allyBlast: {
          main: allyBlast.mainTarget ? key(allyBlast.mainTarget) : null,
          splash: allyBlast.splash.map(key),
        },
      };
      attacker.skills = oldSkills;
      for (const unit of [centerEnemy, farEnemy, nearbyAlly]) board.removeUnit(unit);
      board.onUnitPositionChanged = oldOnChange;
      return output;
    });

    expect(result.ordinary.main).toBe('8,5');
    expect(result.ordinary.splash).not.toContain('8,7');
    expect(result.ordinaryPreview).not.toContain('8,6');
    expect(result.empowered.main).toBe('8,5');
    expect(result.empowered.splash).toContain('8,7');
    expect(result.empoweredPreview).toContain('8,7');
    expect(result.empoweredPreview).not.toContain('8,6');
    expect(result.allyBlast.main).toBeNull();
    expect(result.allyBlast.splash).toContain('8,6');
    expect(result.allyBlast.splash).not.toContain('8,5');
    expect(result.allyBlast.splash).not.toContain('8,7');
  });

  test('evaluates phase, charge, and named-unit range/AOE expressions', async ({ page }) => {
    await bootEotf(page);
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const harness = (window as any).__harness;
      const { ItemObject } = await import('/src/objects/item.ts');
      const { SkillObject } = await import('/src/objects/skill.ts');
      const { UnitObject } = await import('/src/objects/unit.ts');
      const { maximumRange, splashPositions } = await import('/src/combat/item-system.ts');
      const unit = game.units.get('Player');
      harness.warpUnit(unit.nid, 5, 5);
      unit.team = game.phase.getCurrent();
      const oldSkills = unit.skills;
      const helper = new SkillObject(game.db.skills.get('SoL_Helper'));
      helper.data.set('charge', 1);
      unit.skills = [
        helper,
        new SkillObject(game.db.skills.get('HeavensentandSublime')),
      ];
      const sword = new ItemObject(game.db.items.get('Sword_of_Light'));
      const center: [number, number] = [8, 5];
      const swordPreview = splashPositions(unit, sword, center, {
        board: game.board,
        db: game.db,
        game,
      });
      const swordRadius = Math.max(...swordPreview.map(([x, y]: [number, number]) =>
        Math.abs(x - center[0]) + Math.abs(y - center[1])));

      const prefab = game.db.units.get('Player');
      const klass = game.db.classes.get(unit.klass);
      const clone = new UnitObject({
        ...prefab,
        nid: 'Kaku_Klone',
        name: 'Kaku Klone',
        starting_items: [],
      }, klass);
      clone.position = [9, 5];
      const oldClone = game.units.get('Kaku_Klone');
      game.units.set('Kaku_Klone', clone);
      const pillars = new ItemObject(game.db.items.get('Ninpo_Pillars'));
      const namedUnitRange = maximumRange(unit, pillars, game);
      if (oldClone) game.units.set('Kaku_Klone', oldClone);
      else game.units.delete('Kaku_Klone');
      unit.skills = oldSkills;
      return { swordRadius, namedUnitRange };
    });

    expect(result).toEqual({ swordRadius: 2, namedUnitRange: 4 });
  });

  test('supports all-unit, big-cleave, and tile-unless-ally authored targeting', async ({ page }) => {
    await bootEotf(page);
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { ItemObject } = await import('/src/objects/item.ts');
      const { UnitObject } = await import('/src/objects/unit.ts');
      const { splash, splashPositions, validTargets } =
        await import('/src/combat/item-system.ts');
      const attacker = game.units.get('Player');
      const prefab = game.db.units.get('Player');
      const klass = game.db.classes.get(attacker.klass);
      const makeUnit = (nid: string, team: string) => {
        const unit = new UnitObject({ ...prefab, nid, name: nid, starting_items: [] }, klass);
        unit.team = team;
        return unit;
      };
      const enemy = makeUnit('_BigCleaveEnemy', 'enemy');
      const splashEnemy = makeUnit('_BigCleaveSplashEnemy', 'enemy');
      const ally = makeUnit('_BigCleaveAlly', 'player');
      const board = game.board;
      const oldOnChange = board.onUnitPositionChanged;
      board.onUnitPositionChanged = undefined;
      if (attacker.position) board.removeUnit(attacker);
      attacker.team = 'player';
      board.setUnit(5, 5, attacker);
      board.setUnit(7, 7, enemy);
      board.setUnit(7, 6, splashEnemy);
      board.setUnit(6, 5, ally);
      const context = { board, db: game.db, game };
      const allUnits = new ItemObject(game.db.items.get('Big_Red_Button'));
      const cleave = new ItemObject(game.db.items.get('Big_Cleave_OR'));
      const volley = new ItemObject(game.db.items.get('Volleyshot'));
      const allResult = splash(attacker, allUnits, [5, 5], context);
      const allPreview = splashPositions(attacker, allUnits, [5, 5], context);
      const cleaveResult = splash(attacker, cleave, [7, 7], context);
      const cleavePreview = splashPositions(attacker, cleave, [7, 7], context);
      const volleyTargets = validTargets(attacker, volley, board, game.db, game);
      const key = ([x, y]: [number, number]) => `${x},${y}`;
      const output = {
        allMain: allResult.mainTarget,
        allSplash: allResult.splash.map(key),
        allPreviewCount: allPreview.length,
        boardArea: board.width * board.height,
        cleaveMain: cleaveResult.mainTarget ? key(cleaveResult.mainTarget) : null,
        cleaveSplash: cleaveResult.splash.map(key),
        cleavePreview: cleavePreview.map(key),
        volleyTargets: volleyTargets.map(key),
      };
      for (const unit of [enemy, splashEnemy, ally]) board.removeUnit(unit);
      board.onUnitPositionChanged = oldOnChange;
      return output;
    });

    expect(result.allMain).toBeNull();
    expect(result.allSplash).toEqual(expect.arrayContaining(['5,5', '6,5', '7,7']));
    expect(result.allPreviewCount).toBe(result.boardArea);
    expect(result.cleaveMain).toBe('7,7');
    expect(result.cleaveSplash).toContain('7,6');
    expect(result.cleaveSplash).not.toContain('7,7');
    expect(result.cleaveSplash).not.toContain('6,5');
    expect(result.cleavePreview).not.toContain('6,5');
    expect(result.volleyTargets).toContain('7,7');
    expect(result.volleyTargets).not.toContain('6,5');
  });

  test('executes every real EotF value in the supported range/AOE family', async ({ page }) => {
    await bootEotf(page);
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { ItemObject } = await import('/src/objects/item.ts');
      const itemSystem = await import('/src/combat/item-system.ts');
      const unit = game.units.get('Player');
      const componentNids = new Set([
        'eval_min_range', 'eval_max_range', 'eval_smartblast_aoe',
        'eval_ally_blast_aoe', 'all_units_aoe', 'enemy_big_cleave_aoe',
        'target_tile_unless_ally',
      ]);
      const counts: Record<string, number> = {};
      const failures: string[] = [];
      const position: [number, number] = unit.position ?? [0, 0];
      const context = { board: game.board, db: game.db, game };
      for (const prefab of game.db.items.values()) {
        const selected = prefab.components.filter(([nid]: [string, any]) =>
          componentNids.has(nid));
        if (selected.length === 0) continue;
        const item = new ItemObject(prefab);
        for (const [nid] of selected) {
          counts[nid] = (counts[nid] ?? 0) + 1;
          try {
            if (nid === 'eval_min_range') {
              const value = itemSystem.minimumRange(unit, item, game);
              if (!Number.isFinite(value)) failures.push(`${prefab.nid}:${nid}:${value}`);
            } else if (nid === 'eval_max_range') {
              const value = itemSystem.maximumRange(unit, item, game);
              if (!Number.isFinite(value)) failures.push(`${prefab.nid}:${nid}:${value}`);
            } else if (nid === 'target_tile_unless_ally') {
              itemSystem.validTargets(unit, item, game.board, game.db, game);
            } else {
              itemSystem.splash(unit, item, position, context);
              itemSystem.splashPositions(unit, item, position, context);
            }
          } catch (error) {
            failures.push(`${prefab.nid}:${nid}:${String(error)}`);
          }
        }
      }
      return { counts, failures };
    });

    expect(result.failures).toEqual([]);
    expect(result.counts).toEqual({
      eval_min_range: 3,
      eval_max_range: 24,
      eval_smartblast_aoe: 20,
      eval_ally_blast_aoe: 4,
      all_units_aoe: 2,
      enemy_big_cleave_aoe: 1,
      target_tile_unless_ally: 4,
    });
  });
});
