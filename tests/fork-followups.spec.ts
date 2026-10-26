import { expect, test, type Page } from '@playwright/test';

/**
 * Fork-parity follow-ups: behaviour the EOtF engine fork (and upstream
 * lt-maker) resolves strike by strike or per refresh, pinned against the
 * Python sources.
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
      unit.stats.HP = 80;
      unit.currentHp = 80;
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

const SWORD = [
  ['weapon', null], ['target_enemy', null], ['min_range', 1], ['max_range', 1],
  ['damage', 1], ['hit', 100], ['crit', 0], ['weight', 0], ['weapon_type', 'Sword'],
  ['weapon_rank', 'E'],
];

test.describe('EOtF fork-parity follow-ups', () => {
  test('shove moves the target on the hit, so a melee defender cannot counter', async ({ page }) => {
    await bootEotf(page);
    const result = await page.evaluate(async ({ arenaSrc, sword }) => {
      const game = (window as any).__gameRef;
      // eslint-disable-next-line no-new-func
      const makeArena = new Function(`${arenaSrc}; return makeArena;`)();
      const { ItemObject } = await import('/src/objects/item.ts');
      const { MapCombat } = await import('/src/combat/map-combat.ts');
      const { applyCombatItemEndHooks } = await import('/src/combat/combat-lifecycle.ts');
      const arena = await makeArena(game, 4);
      if (!arena.origin) return null;
      const [x, y] = arena.origin;
      const attacker = arena.make('_ShoveAttacker', 'player');
      const defender = arena.make('_ShoveDefender', 'enemy');
      game.board.setUnit(x, y, attacker);
      game.board.setUnit(x + 1, y, defender);
      const shoveSword = new ItemObject({
        nid: '_ShoveSword', name: '_ShoveSword', desc: '', icon_nid: '', icon_index: [0, 0],
        components: [...sword, ['shove', 1]],
      } as any);
      const sword2 = new ItemObject({
        nid: '_PlainSword', name: '_PlainSword', desc: '', icon_nid: '', icon_index: [0, 0],
        components: sword,
      } as any);
      attacker.items = [shoveSword];
      shoveSword.owner = attacker;
      attacker.equippedWeapon = shoveSword;
      defender.items = [sword2];
      sword2.owner = defender;
      defender.equippedWeapon = sword2;
      for (const unit of [attacker, defender]) {
        unit.stats.SPD = 5;
        unit.stats.SKL = 30;
      }

      const before = game.actionLog.actionIndex;
      const combat = new MapCombat(
        attacker, shoveSword, defender, sword2, game.db, 'grandmaster', game.board,
        null, undefined, game,
      );
      // The solver waits for the presentation before solving past the shove.
      const resolvedAtStart = (combat as any).strikes.length;
      const movedAtStart = defender.position ? [...defender.position] : null;
      let guard = 0;
      while (!combat.update(1000) && guard++ < 500) { /* play out */ }
      combat.applyResults(game.actionLog);
      const strikes = (combat as any).strikes.map(
        (strike: any) => `${strike.attacker.nid}>${strike.defender.nid}`,
      );
      // End-of-combat item hooks must not shove a second time.
      applyCombatItemEndHooks(game, (combat as any).strikes);
      const after = defender.position ? [...defender.position] : null;
      while (game.actionLog.actionIndex > before) game.actionLog.runActionBackward();
      const rewound = defender.position ? [...defender.position] : null;
      arena.cleanup();
      return { origin: [x, y], resolvedAtStart, movedAtStart, strikes, after, rewound };
    }, { arenaSrc: ARENA, sword: SWORD });
    expect(result).not.toBeNull();
    const [x, y] = result!.origin;
    expect(result!.resolvedAtStart).toBe(1);
    expect(result!.movedAtStart).toEqual([x + 1, y]);
    expect(result!.strikes).toEqual(['_ShoveAttacker>_ShoveDefender']);
    expect(result!.after).toEqual([x + 2, y]);
    expect(result!.rewound).toEqual([x + 1, y]);
  });

  test('a weapon that runs out of uses mid-combat strikes no more', async ({ page }) => {
    await bootEotf(page);
    const result = await page.evaluate(async ({ arenaSrc, sword }) => {
      const game = (window as any).__gameRef;
      // eslint-disable-next-line no-new-func
      const makeArena = new Function(`${arenaSrc}; return makeArena;`)();
      const { ItemObject } = await import('/src/objects/item.ts');
      const { CombatPhaseSolver } = await import('/src/combat/combat-solver.ts');
      const arena = await makeArena(game, 3);
      if (!arena.origin) return null;
      const [x, y] = arena.origin;
      const attacker = arena.make('_UsesAttacker', 'player');
      const defender = arena.make('_UsesDefender', 'enemy');
      game.board.setUnit(x, y, attacker);
      game.board.setUnit(x + 1, y, defender);
      const makeSword = (nid: string, extra: unknown[][]) => new ItemObject({
        nid, name: nid, desc: '', icon_nid: '', icon_index: [0, 0],
        components: [...sword, ...extra],
      } as any);
      const run = (atkExtra: unknown[][], defExtra: unknown[][], atkSpd: number, defSpd: number) => {
        const atkItem = makeSword('_AtkSword', atkExtra);
        const defItem = makeSword('_DefSword', defExtra);
        attacker.items = [atkItem];
        atkItem.owner = attacker;
        attacker.equippedWeapon = atkItem;
        defender.items = [defItem];
        defItem.owner = defender;
        defender.equippedWeapon = defItem;
        attacker.stats.SPD = atkSpd;
        defender.stats.SPD = defSpd;
        const solver = new CombatPhaseSolver(() => 0, game);
        return solver.resolve(attacker, atkItem, defender, defItem, game.db, 'classic', game.board)
          .map((strike: any) => strike.isCounter ? 'D' : 'A')
          .join('');
      };
      const out = {
        // Attacker doubles; one use: no follow-up.
        attackerOneUse: run([['uses', 1]], [], 30, 0),
        attackerTwoUses: run([['uses', 2]], [], 30, 0),
        // Brave with one use: one strike.
        braveOneUse: run([['uses', 1], ['brave', null]], [], 5, 5),
        // Defender doubles with a one-use weapon: one counter (A D, not A D D).
        defenderOneUse: run([], [['uses', 1]], 0, 30),
        // one_loss_per_combat spends its use at end_combat only.
        oneLossPerCombat: run([['uses', 1], ['uses_options', [['one_loss_per_combat', true]]]], [], 30, 0),
      };
      arena.cleanup();
      return out;
    }, { arenaSrc: ARENA, sword: SWORD });
    expect(result).toEqual({
      attackerOneUse: 'AD',
      attackerTwoUses: 'ADA',
      braveOneUse: 'AD',
      defenderOneUse: 'AD',
      oneLossPerCombat: 'ADA',
    });
  });
});
