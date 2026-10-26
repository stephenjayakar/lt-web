import { expect, test, type Page } from '@playwright/test';
import { projectInstalled } from './helpers/project-data';

/**
 * Python combat_calcs.get_weapon_rank_bonus feeds the weapon type's
 * `rank_bonus` into accuracy, avoid, crit_accuracy, crit_avoid, damage,
 * defense, attack_speed and defense_speed. An entry's own weapon_type is
 * never read; 'All' returns on sight; otherwise the highest met requirement
 * wins. The EOtF fork lacks the defender-side bonuses.
 */

async function boot(page: Page, query: string): Promise<void> {
  await page.goto(`/?harness=true&${query}&clean=true&bundle=false`);
  await page.waitForFunction(() => (window as any).__harness?.ready === true, undefined, { timeout: 60_000 });
}

test.describe('weapon rank bonuses', () => {
  test('a synthetic rank_bonus feeds every combat stat by wexp requirement', async ({ page }) => {
    await boot(page, 'level=0');
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const calcs = await import('/src/combat/combat-calcs.ts');
      const { setForkEngine, isForkEngine } = await import('/src/engine/engine-flavor.ts');
      const { ItemObject } = await import('/src/objects/item.ts');
      const db = game.db;
      const unit = game.units.get('Eirika');
      const other = [...game.units.values()].find((candidate: any) => candidate.team === 'enemy') as any;
      const sword = new ItemObject({
        nid: '_RankSword', name: '_RankSword', desc: '', icon_nid: '', icon_index: [0, 0],
        components: [['weapon', null], ['weapon_type', 'Sword'], ['damage', 5], ['hit', 80], ['crit', 0], ['weight', 0]],
      } as any);
      sword.owner = unit;
      const savedItems = unit.items;
      unit.items = [sword];
      const weapon = db.weapons.find((entry: any) => entry.nid === 'Sword');
      const savedBonus = weapon.rank_bonus;
      const savedWexp = unit.wexp.Sword;
      const savedFork = isForkEngine();
      const entry = (rank: string, value: number, type = 'Sword') => ({
        weapon_type: type, weapon_rank: rank,
        accuracy: String(value), avoid: value + 1, crit: value + 2, dodge: value + 3,
        damage: value + 4, resist: value + 5, attack_speed: value + 6, defense_speed: value + 7,
      });
      const requirement = (rank: string) => db.weaponRanks.find((r: any) => r.rank === rank).requirement;
      const stats = () => ({
        accuracy: calcs.accuracy(unit, sword, db, game, other, null),
        avoid: calcs.avoid(unit, db, game.board, null, game, other),
        crit: calcs.critAccuracy(unit, sword, db, game, other, null),
        dodge: calcs.critAvoid(unit, sword, null, db, game, other),
        damage: calcs.damage(unit, sword, db, game, other, null),
        resist: calcs.defense(unit, sword, db, game.board, game, other, sword),
        attackSpeed: calcs.attackSpeed(unit, sword, db, game, other, null),
        defenseSpeed: calcs.defenseSpeed(unit, sword, db, null, game, other),
      });
      const delta = (base: Record<string, number>) => {
        const now = stats() as Record<string, number>;
        return Object.fromEntries(Object.keys(base).map((key) => [key, now[key] - base[key]]));
      };
      try {
        setForkEngine(false);
        weapon.rank_bonus = [];
        unit.wexp.Sword = requirement('A');
        const base = stats() as Record<string, number>;
        // The D entry names Lance: Python ignores an entry's weapon_type.
        weapon.rank_bonus = [entry('B', 10), entry('D', 20, 'Lance')];
        const atA = delta(base);
        unit.wexp.Sword = requirement('D');
        const atD = delta(base);
        unit.wexp.Sword = requirement('D') - 1;
        const belowD = delta(base);
        weapon.rank_bonus = [entry('E', 30), entry('All', 40), entry('S', 50)];
        const all = delta(base);
        unit.wexp.Sword = requirement('A');
        weapon.rank_bonus = [entry('B', 10)];
        setForkEngine(true);
        const fork = delta(base);
        return { atA, atD, belowD, all, fork };
      } finally {
        setForkEngine(savedFork);
        weapon.rank_bonus = savedBonus;
        unit.wexp.Sword = savedWexp;
        unit.items = savedItems;
      }
    });

    const bonus = (value: number) => ({
      accuracy: value, avoid: value + 1, crit: value + 2, dodge: value + 3,
      damage: value + 4, resist: value + 5, attackSpeed: value + 6, defenseSpeed: value + 7,
    });
    expect(result.atA).toEqual(bonus(10));
    expect(result.atD).toEqual(bonus(20));
    expect(result.belowD).toEqual({
      accuracy: 0, avoid: 0, crit: 0, dodge: 0, damage: 0, resist: 0, attackSpeed: 0, defenseSpeed: 0,
    });
    // 'All' returns as soon as the scan reaches it, even past a met E entry.
    expect(result.all).toEqual(bonus(40));
    // The fork keeps only the attacker-side bonuses.
    expect(result.fork).toEqual({
      ...bonus(10), avoid: 0, dodge: 0, resist: 0, defenseSpeed: 0,
    });
  });

  test('Rekka S-rank forecasts match Python combat_calcs', async ({ page }) => {
    test.skip(!projectInstalled('rekka.ltproj'), 'lt-maker/rekka.ltproj is not installed');
    await boot(page, 'project=rekka.ltproj&level=0');
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { computeHit, computeDamage, computeCrit } = await import('/src/combat/combat-calcs.ts');
      const db = game.db;
      const weaponOf = (unit: any) => unit.items.find((item: any) => item.isWeapon());
      const forecast = (attacker: any, defender: any) => {
        const aw = weaponOf(attacker);
        const dw = weaponOf(defender);
        return {
          attacker: [
            computeHit(attacker, aw, defender, db, game.board, game, 'attack', [0, 0], dw),
            computeDamage(attacker, aw, defender, db, game.board, game, 'attack', false, [0, 0], false, dw),
            computeCrit(attacker, aw, defender, db, game, 'attack'),
          ],
          defender: [
            computeHit(defender, dw, attacker, db, game.board, game, 'defense', [0, 0], aw),
            computeDamage(defender, dw, attacker, db, game.board, game, 'defense', false, [0, 0], false, aw),
            computeCrit(defender, dw, attacker, db, game, 'defense'),
          ],
        };
      };

      // rekka-visual-baselines targeting forecast: Lyn (forest) vs Batta (plain).
      const lyn = game.units.get('Lyn');
      const batta = game.units.get('Batta');
      lyn.equippedWeapon = weaponOf(lyn);
      batta.equippedWeapon = weaponOf(batta);
      lyn.wexp.Sword = 999;
      batta.wexp.Axe = 999;
      if (batta.position) game.board.removeUnit(batta);
      const [x, y] = lyn.position;
      const spot = [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]
        .find(([tx, ty]) => game.board.inBounds(tx, ty) && !game.board.getUnit(tx, ty))!;
      game.board.setUnit(spot[0], spot[1], batta);
      const lynForecast = forecast(lyn, batta);

      // rekka-visual-baselines full battle: Dorcas vs Batta, both on Hill.
      const dorcas = game.buildUnit(db.units.get('Dorcas'), 'player', 'None');
      const brigand = game.buildUnit(db.units.get('Batta'), 'enemy', 'None');
      dorcas.wexp.Axe = 999;
      brigand.wexp.Axe = 999;
      game.units.set('_RankDorcas', dorcas);
      game.units.set('_RankBatta', brigand);
      game.board.setUnit(0, 0, dorcas);
      game.board.setUnit(1, 0, brigand);
      return {
        terrain: [game.board.getTerrain(0, 0), game.board.getTerrain(1, 0)],
        lyn: lynForecast,
        dorcas: forecast(dorcas, brigand),
      };
    });

    // Python: S-rank bonus +15 hit, +3 damage, +15 crit on both sides.
    expect(result.lyn).toEqual({ attacker: [100, 10, 14], defender: [40, 15, 11] });
    expect(result.terrain).toEqual(['20', '20']);
    expect(result.dorcas).toEqual({ attacker: [64, 12, 14], defender: [53, 15, 13] });
  });
});
