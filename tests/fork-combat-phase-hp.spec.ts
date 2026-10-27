import { expect, test, type Page } from '@playwright/test';

/**
 * EOtF's engine queues a phase's HP changes and applies them after the
 * phase: every strike in it reads the HP the phase began with (true damage,
 * lifelink, TrueMiracle), lifelink totals the phase's damage so far, and
 * the digits show the damage brush even when a survival hook changes the
 * HP. Each case mirrors a run of the fork engine with the same units:
 * Fuma Shuriken (9 true damage) and Thee (4 damage) from a 10 HP user.
 */

async function bootEotf(page: Page): Promise<void> {
  await page.goto('/?harness=true&project=eotf.ltproj&level=X&clean=true&bundle=false');
  await page.waitForFunction(() => (window as any).__harness?.ready === true, undefined, { timeout: 60_000 });
}

/** Browser-side helper source: synthetic units on an open row of the map. */
const ARENA = `
  async function makeArena(game, width) {
    const { UnitObject } = await import('/src/objects/unit.ts');
    const template = game.units.get('Player');
    const klass = game.db.classes.get(template.klass);
    let origin = null;
    for (let y = 0; y < game.board.height && !origin; y++) {
      for (let x = 2; x < game.board.width - width; x++) {
        const cells = Array.from({ length: width + 2 }, (_, i) => x - 2 + i);
        if (cells.every((cx) => !game.board.getUnit(cx, y) &&
            game.board.getMovementCost(cx, y, klass.movement_group ?? 'Infantry', game.db) < 99)) {
          origin = [x, y];
          break;
        }
      }
    }
    const made = [];
    const make = (nid, team, hp) => {
      const unit = new UnitObject({
        nid, name: nid, desc: '', variant: null, level: 1, klass: template.klass,
        tags: [], bases: { ...klass.bases }, growths: {}, stat_cap_modifiers: {},
        starting_items: [], learned_skills: [], unit_notes: [], fields: [],
        wexp_gain: {}, portrait_nid: '', affinity: '',
      }, klass);
      for (const stat of Object.keys(unit.stats)) {
        if (stat !== 'MOV' && stat !== 'CON') unit.stats[stat] = 0;
      }
      unit.stats.HP = 40;
      unit.currentHp = hp;
      unit.team = team;
      unit.skills = [];
      made.push(unit);
      return unit;
    };
    const cleanup = () => {
      for (const unit of made) {
        game.board.removeUnit(unit);
        game.units.delete?.(unit.nid);
      }
    };
    return { origin, make, cleanup };
  }
`;

test.describe('EOtF engine fork: HP within a combat phase', () => {
  test('splash lifelink totals the phase and reads phase-start HP (fork engine numbers)', async ({ page }) => {
    await bootEotf(page);
    const result = await page.evaluate(async (arenaSrc) => {
      const game = (window as any).__gameRef;
      // eslint-disable-next-line no-new-func
      const makeArena = new Function(`${arenaSrc}; return makeArena;`)();
      const { ItemObject } = await import('/src/objects/item.ts');
      const { SkillObject } = await import('/src/objects/skill.ts');
      const { CombatPhaseSolver } = await import('/src/combat/combat-solver.ts');
      const arena = await makeArena(game, 4);
      if (!arena.origin) return null;
      const [x, y] = arena.origin;
      const user = arena.make('_PhaseUser', 'player', 10);
      const near = arena.make('_PhaseNear', 'enemy', 5);
      const far = arena.make('_PhaseFar', 'enemy', 40);
      game.board.setUnit(x, y, user);
      game.board.setUnit(x + 1, y, near);
      game.board.setUnit(x + 2, y, far);
      const fuma = new ItemObject(game.db.items.get('Fuma_Shuriken'));
      fuma.owner = user;
      const thee = new ItemObject(game.db.items.get('Thee'));
      thee.owner = user;
      user.items = [fuma, thee];
      const sol = () => new SkillObject(game.db.skills.get('Sol_Proc'));
      const run = (item: any, splash: any[], skills: any[], hps: number[]) => {
        user.skills = skills;
        user.currentHp = 10;
        near.currentHp = hps[0];
        far.currentHp = hps[1];
        const solver: any = new CombatPhaseSolver(() => 0, game);
        const strikes = solver.resolveGroup(user, item, null, null, splash, game.db, 'classic', game.board);
        return {
          strikes: strikes.map((strike: any) => `${strike.defender.nid.slice(6)}:${strike.damage}`),
          heals: strikes.map((strike: any) => strike.selfSkillHpChange ?? 0),
          user: solver.simulatedHp(user),
          near: solver.simulatedHp(near),
          far: solver.simulatedHp(far) ?? far.currentHp,
        };
      };
      try {
        return {
          // EOtF's set order for this line puts the far target first.
          splash: run(fuma, [far, near], [sol()], [5, 40]),
          braveSplash: run(fuma, [far, near], [sol(), new SkillObject(game.db.skills.get('Bravery'))], [5, 40]),
          duplicate: run(thee, [near, near], [sol()], [5, 40]),
        };
      } finally {
        arena.cleanup();
      }
    }, ARENA);
    expect(result).not.toBeNull();
    // Fork engine: heal 4 (9 dealt) then 2 (9 + 5 = 14, clamped to the near
    // target's 5 HP): user 10 -> 16, near 5 -> 0, far 40 -> 31.
    expect(result!.splash).toEqual({
      strikes: ['Far:9', 'Near:9'], heals: [4, 2], user: 16, near: 0, far: 31,
    });
    // Bravery: a second phase; the near target starts it at 0 HP, so its
    // lifelink clamps to 0 and heals nothing. User 10 -> 20, far -> 22.
    expect(result!.braveSplash).toEqual({
      strikes: ['Far:9', 'Near:9', 'Far:9', 'Near:9'], heals: [4, 2, 4, 0], user: 20, near: 0, far: 22,
    });
    // Thee on one unit twice: both brushes are 4 true damage against the
    // 5 HP it began the phase with; lifelink 2 + 2 (fork engine: 10 -> 14).
    expect(result!.duplicate).toEqual({
      strikes: ['Near:4', 'Near:4'], heals: [2, 2], user: 14, near: 0, far: 40,
    });
  });

  test('TrueMiracle checks each strike against phase-start HP and keeps the brush digits', async ({ page }) => {
    await bootEotf(page);
    const result = await page.evaluate(async (arenaSrc) => {
      const game = (window as any).__gameRef;
      // eslint-disable-next-line no-new-func
      const makeArena = new Function(`${arenaSrc}; return makeArena;`)();
      const { ItemObject } = await import('/src/objects/item.ts');
      const { SkillObject } = await import('/src/objects/skill.ts');
      const { CombatPhaseSolver } = await import('/src/combat/combat-solver.ts');
      const arena = await makeArena(game, 4);
      if (!arena.origin) return null;
      const [x, y] = arena.origin;
      const user = arena.make('_MiracleUser', 'player', 30);
      const foe = arena.make('_MiracleFoe', 'enemy', 3);
      game.board.setUnit(x, y, user);
      game.board.setUnit(x + 1, y, foe);
      foe.skills = [new SkillObject(game.db.skills.get('True_Miracle'))];
      const thee = new ItemObject(game.db.items.get('Thee'));
      thee.owner = user;
      user.stats.HP = 30;
      const knife = new ItemObject(game.db.items.get('Aqua_Knife'));
      knife.owner = user;
      user.items = [thee, knife];
      const duplicate = (hp: number) => {
        foe.currentHp = hp;
        const solver: any = new CombatPhaseSolver(() => 0, game);
        const strikes = solver.resolveGroup(user, thee, null, null, [foe, foe], game.db, 'classic', game.board);
        return {
          procs: strikes.filter((strike: any) => strike.survivalProc).length,
          shown: strikes.map((strike: any) => strike.shownDamage ?? strike.damage),
          hp: solver.simulatedHp(foe),
        };
      };
      const single = () => {
        foe.currentHp = 5;
        const solver: any = new CombatPhaseSolver(() => 0, game);
        const [strike] = solver.resolve(user, knife, foe, null, game.db, 'classic', game.board, ['hit1', 'end']);
        return {
          shownDamage: strike.shownDamage, shownExtra: strike.shownExtraDamage,
          applied: strike.damage + (strike.extraDamage ?? 0), hp: solver.simulatedHp(foe),
        };
      };
      try {
        return { three: duplicate(3), six: duplicate(6), nine: duplicate(9), single: single() };
      } finally {
        arena.cleanup();
      }
    }, ARENA);
    expect(result).not.toBeNull();
    // Fork engine: both 4s are lethal against 3 HP, each becomes -2: 3 -> 1 -> 0.
    expect(result!.three).toEqual({ procs: 2, shown: [4, 4], hp: 0 });
    // Neither 4 is lethal against 6 HP on its own: 6 -> 2 -> 0, no save.
    expect(result!.six).toEqual({ procs: 0, shown: [4, 4], hp: 0 });
    expect(result!.nine).toEqual({ procs: 0, shown: [4, 4], hp: 1 });
    // Aqua Knife into 5 HP: the digits stay 6 and 3, the unit ends at 1.
    expect(result!.single).toEqual({ shownDamage: 6, shownExtra: 3, applied: 4, hp: 1 });
  });

  test('line AOE strikes in the engine\'s set order', async ({ page }) => {
    await bootEotf(page);
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { ItemObject } = await import('/src/objects/item.ts');
      const { splash } = await import('/src/combat/item-system.ts');
      const { setForkEngine } = await import('/src/engine/engine-flavor.ts');
      const user = { nid: '_LineUser', team: 'player', position: [12, 8], skills: [], tags: [], klass: game.units.get('Player').klass };
      const near = { nid: '_LineNear', team: 'enemy', position: [12, 7], skills: [], tags: [], klass: user.klass };
      const far = { nid: '_LineFar', team: 'enemy', position: [12, 6], skills: [], tags: [], klass: user.klass };
      const units = new Map([['12,8', user], ['12,7', near], ['12,6', far]]);
      const board = {
        width: 30, height: 30,
        getUnit: (x: number, y: number) => units.get(`${x},${y}`) ?? null,
        inBounds: () => true,
        checkBounds: () => true,
        getAllUnits: () => [...units.values()],
      };
      const fuma = new ItemObject(game.db.items.get('Fuma_Shuriken'));
      const ctx = { board, db: game.db, game };
      const fork = splash(user as any, fuma, [12, 6], ctx as any).splash;
      setForkEngine(false);
      const upstream = splash(user as any, fuma, [12, 6], ctx as any);
      setForkEngine(true);
      return { fork, upstream: upstream.splash };
    });
    // The fork engine's splash list for this exact line: [(12, 6), (12, 7)].
    expect(result.fork).toEqual([[12, 6], [12, 7]]);
    expect(result.upstream).toEqual([[12, 7]]);
  });
});
