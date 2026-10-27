import { expect, test, type Page } from '@playwright/test';

/**
 * EOtF's engine runs combats with no main target (line/all-enemy AOE and
 * merged multi-target weapons) through its ordinary attacker phases with
 * double_splash on. The expected numbers mirror runs of the fork engine
 * itself: Fuma Shuriken (9 true damage) against a 60 HP target.
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
    const make = (nid, team) => {
      const unit = new UnitObject({
        nid, name: nid, desc: '', variant: null, level: 1, klass: template.klass,
        tags: [], bases: { ...klass.bases }, growths: {}, stat_cap_modifiers: {},
        starting_items: [], learned_skills: [], unit_notes: [], fields: [],
        wexp_gain: {}, portrait_nid: '', affinity: '',
      }, klass);
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

test.describe('EOtF engine fork: combats with no main target', () => {
  test('line AOE repeats its whole splash for dynamic attacks, multiattacks and blitzes', async ({ page }) => {
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
      const user = arena.make('_AoeUser', 'player');
      const foe = arena.make('_AoeFoe', 'enemy');
      game.board.setUnit(x, y, user);
      game.board.setUnit(x + 1, y, foe);
      const fuma = new ItemObject(game.db.items.get('Fuma_Shuriken'));
      fuma.owner = user;
      user.items = [fuma];
      const run = (skillNids: string[], hp: number) => {
        user.skills = skillNids.map((nid) => {
          const skill = new SkillObject(game.db.skills.get(nid));
          if (nid === 'Final_Strike') skill.data.set('charge', 3);
          return skill;
        });
        foe.stats.HP = Math.max(foe.stats.HP, 60);
        foe.currentHp = hp;
        const strikes = new CombatPhaseSolver(() => 0, game).resolveGroup(
          user, fuma, null, null, [foe], game.db, 'classic', game.board,
        );
        return {
          strikes: strikes.length,
          dealt: strikes.reduce((total: number, strike: any) => total + strike.damage, 0),
          attackInfo: strikes.map((strike: any) => strike.attackInfo.join(',')),
        };
      };
      try {
        return {
          plain: run([], 60),
          thrice: run(['Lightning_Strikes_Thrice_Proc'], 60),
          braveBlitz: run(['Bravery', 'Grinding_Combo'], 60),
          deadTarget: run(['Lightning_Strikes_Thrice_Proc'], 5),
          finalStrike: run(['Final_Strike'], 60),
        };
      } finally {
        arena.cleanup();
      }
    }, ARENA);
    expect(result).not.toBeNull();
    expect(result!.plain).toMatchObject({ strikes: 1, dealt: 9 });
    // dynamic_attacks 2: three attacker phases, 60 -> 33 in the fork engine.
    expect(result!.thrice).toMatchObject({ strikes: 3, dealt: 27, attackInfo: ['0,0', '1,0', '2,0'] });
    // Bravery doubles each phase and Grinding Combo adds a blitz: 60 -> 24.
    expect(result!.braveBlitz).toMatchObject({ strikes: 4, dealt: 36, attackInfo: ['0,0', '0,1', '1,0', '1,1'] });
    // The splash entry is struck again after it reaches 0 HP.
    expect(result!.deadTarget.strikes).toBe(3);
    // The attacker's combat_condition sees target=None: Final Strike stays off.
    expect(result!.finalStrike.strikes).toBe(1);
  });

  test('a multi_target position chosen twice strikes that unit twice, even once it is down', async ({ page }) => {
    await bootEotf(page);
    const result = await page.evaluate(async (arenaSrc) => {
      const game = (window as any).__gameRef;
      // eslint-disable-next-line no-new-func
      const makeArena = new Function(`${arenaSrc}; return makeArena;`)();
      const { ItemObject } = await import('/src/objects/item.ts');
      const { resolveForkMultiTargetGroup } = await import('/src/engine/states/game-states.ts');
      const { CombatPhaseSolver } = await import('/src/combat/combat-solver.ts');
      const { MapCombat } = await import('/src/combat/map-combat.ts');
      const { setForkEngine } = await import('/src/engine/engine-flavor.ts');
      const arena = await makeArena(game, 4);
      if (!arena.origin) return null;
      const [x, y] = arena.origin;
      const user = arena.make('_DupUser', 'player');
      const foe = arena.make('_DupFoe', 'enemy');
      game.board.setUnit(x, y, user);
      game.board.setUnit(x + 2, y, foe);
      const thee = new ItemObject(game.db.items.get('Thee'));
      thee.owner = user;
      user.items = [thee];
      user.equippedWeapon = thee;
      const group = resolveForkMultiTargetGroup(game, user, thee, [[x + 2, y], [x + 2, y]]);
      const strikesAt = (hp: number) => {
        foe.currentHp = hp;
        return new CombatPhaseSolver(() => 0, game).resolveGroup(
          user, thee, null, null, group.splashStrikes, game.db, 'classic', game.board,
        ).map((strike: any) => `${strike.defender.nid}:${strike.attackInfo.join(',')}`);
      };
      const alive = strikesAt(foe.maxHp);
      const down = strikesAt(1);
      foe.currentHp = foe.maxHp;
      const combat = new MapCombat(
        user, thee, foe, null, game.db, 'classic', game.board, null,
        { mainDefender: null, splashDefenders: group.splashDefenders, splashStrikes: group.splashStrikes },
        game,
      );
      const map = {
        defenders: combat.defenders.map((unit: any) => unit.nid),
        strikes: combat.strikes.length,
      };
      setForkEngine(false);
      foe.currentHp = foe.maxHp;
      const upstream = new CombatPhaseSolver(() => 0, game).resolveGroup(
        user, thee, null, null, group.splashStrikes, game.db, 'classic', game.board,
      ).length;
      setForkEngine(true);
      foe.currentHp = foe.maxHp;
      arena.cleanup();
      return {
        splash: group.splashDefenders.map((unit: any) => unit.nid),
        splashStrikes: group.splashStrikes.map((unit: any) => unit.nid),
        alive, down, map, upstream,
      };
    }, ARENA);
    expect(result).toEqual({
      splash: ['_DupFoe'],
      splashStrikes: ['_DupFoe', '_DupFoe'],
      // One attacker phase, one strike per entry (fork engine: HP 10 -> 8).
      alive: ['_DupFoe:0,0', '_DupFoe:0,0'],
      down: ['_DupFoe:0,0', '_DupFoe:0,0'],
      map: { defenders: ['_DupFoe'], strikes: 2 },
      upstream: 1,
    });
  });
});
