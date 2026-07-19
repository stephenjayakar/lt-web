/**
 * Glancing-hit damage (Active Next Slice follow-up item 2).
 *
 * lt-maker/app/engine/combat/solver.py process():
 *   elif roll >= unclamped_hit - DB.constants.value('glancing_hit') and not guard_hit:
 *       item_system.on_glancing_hit(...)
 *
 * i.e. among strikes that hit (roll < to_hit) and are not a crit, a roll
 * that lands in the top `glancing_hit`-wide band just below to-hit is a
 * "glancing" hit: half damage (weapon_components.py Damage.on_glancing_hit:
 * `damage //= 2`, truncating toward zero), applied *after* Grandmaster's
 * hit%-scaling (on_glancing_hit re-derives the Grandmaster-scaled damage
 * the same way on_hit does, then halves it).
 *
 * The band check is gated purely by the `glancing_hit` DB constant (percent
 * width, default 0/false = feature off) -- it is not restricted to a
 * specific rng_mode, so this file exercises it under 'classic' (single-roll,
 * fully controllable via a fixed randomRoll callback) as well as confirming
 * 'grandmaster' composes correctly (roll is always 0, so glancing there
 * triggers whenever `0 <= glancing_hit` while still hitting, i.e. whenever
 * `0 < hit <= glancing_hit`).
 *
 * Ported: src/combat/combat-solver.ts resolveStrike (glancing flag +
 * halved damage) and rollHitDetailed (exposes the raw roll + effective
 * hit-chance so the glancing band can reuse the same draw the hit check
 * used, matching Python's single `generate_roll()` call).
 */

import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';

async function waitForHarness(page: Page): Promise<void> {
  await page.waitForFunction(() => !!(window as any).__harness?.ready, { timeout: 15000 });
}

test.describe('Glancing hits', () => {
  test('classic mode: roll in the glancing band halves damage; out of band is a normal hit', async ({ page }) => {
    await page.goto('/?harness=true&level=0&clean=true&bundle=false');
    await waitForHarness(page);

    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { UnitObject } = await import('/src/objects/unit.ts');
      const { ItemObject } = await import('/src/objects/item.ts');
      const { CombatPhaseSolver } = await import('/src/combat/combat-solver.ts');
      const { computeDamage } = await import('/src/combat/combat-calcs.ts');

      const template = game.units.get('Eirika');
      const klass = template ? game.db.classes.get(template.klass) : null;
      if (!template || !klass) return null;

      // SPD/LCK 0 so avoid() = SPD*2 + LCK//2 = 0 -- to-hit is then exactly
      // the item's `hit` value (SKL 0 too, so accuracy's SKL*2 term is 0).
      const makeUnit = (nid: string, str: number) => {
        const unit = new UnitObject({
          nid, name: nid, desc: '', variant: null, level: 1, klass: template.klass,
          tags: [], bases: { HP: 30, STR: str, MAG: 0, SKL: 0, SPD: 0, LCK: 0, DEF: 0, RES: 0, CON: 5, MOV: 5 },
          growths: {}, stat_cap_modifiers: {}, starting_items: [], learned_skills: [],
          unit_notes: [], fields: [], wexp_gain: {}, portrait_nid: '', affinity: '',
        } as any, klass);
        unit.currentHp = 30;
        return unit;
      };

      // hit 80, crit 0 (default) -- crit is disabled so only hit/glancing/miss compete.
      const makeItem = (nid: string, hit: number) => new ItemObject({
        nid, name: nid, desc: '', icon_nid: '', icon_index: [0, 0],
        components: [['weapon', null], ['damage', 0], ['hit', hit], ['uses', 99]],
      });

      const attacker = makeUnit('_GlA', 20);
      const defender = makeUnit('_GlDef', 0);
      const item = makeItem('_GlItem', 80);
      attacker.items.push(item);
      const baseDamage = computeDamage(attacker, item, defender, game.db, null, game, 'attack', false);

      const oldBand = game.db.constants.get('glancing_hit');
      game.db.constants.set('glancing_hit', 15); // band = [65, 80)

      // roll=70: hit (70 < 80) AND in the glancing band (70 >= 80-15=65) -> glancing, half damage.
      const solverGlancing = new CombatPhaseSolver(() => 70, game);
      const strikesGlancing = solverGlancing.resolve(attacker, item, defender, null, game.db, 'classic', null, null);

      // roll=50: hit (50 < 80) but below the band (50 < 65) -> normal hit, full damage.
      const solverNormal = new CombatPhaseSolver(() => 50, game);
      const strikesNormal = solverNormal.resolve(attacker, item, defender, null, game.db, 'classic', null, null);

      // roll=90: miss (90 >= 80) -- outside the hit range entirely, never glancing.
      const solverMiss = new CombatPhaseSolver(() => 90, game);
      const strikesMiss = solverMiss.resolve(attacker, item, defender, null, game.db, 'classic', null, null);

      if (oldBand === undefined) game.db.constants.delete('glancing_hit');
      else game.db.constants.set('glancing_hit', oldBand);

      return {
        baseDamage,
        glancing: {
          hit: strikesGlancing[0]?.hit, crit: strikesGlancing[0]?.crit,
          glancingFlag: strikesGlancing[0]?.glancing, damage: strikesGlancing[0]?.damage,
        },
        normal: {
          hit: strikesNormal[0]?.hit, glancingFlag: strikesNormal[0]?.glancing,
          damage: strikesNormal[0]?.damage,
        },
        miss: {
          hit: strikesMiss[0]?.hit, glancingFlag: strikesMiss[0]?.glancing,
          damage: strikesMiss[0]?.damage,
        },
      };
    });

    expect(result).not.toBeNull();
    expect(result!.baseDamage).toBeGreaterThan(0);
    // Glancing: half of base damage, truncated toward zero.
    expect(result!.glancing).toEqual({
      hit: true, crit: false, glancingFlag: true,
      damage: Math.trunc(result!.baseDamage / 2),
    });
    // In-band-adjacent but below the band: full, un-halved damage.
    expect(result!.normal).toEqual({ hit: true, glancingFlag: undefined, damage: result!.baseDamage });
    // Outside the to-hit range entirely: a miss, never glancing.
    expect(result!.miss).toEqual({ hit: false, glancingFlag: undefined, damage: 0 });
  });

  test('glancing_hit constant gates the feature: band=0 (default/off) never produces a glancing hit', async ({ page }) => {
    await page.goto('/?harness=true&level=0&clean=true&bundle=false');
    await waitForHarness(page);

    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { UnitObject } = await import('/src/objects/unit.ts');
      const { ItemObject } = await import('/src/objects/item.ts');
      const { CombatPhaseSolver } = await import('/src/combat/combat-solver.ts');

      const template = game.units.get('Eirika');
      const klass = template ? game.db.classes.get(template.klass) : null;
      if (!template || !klass) return null;

      const makeUnit = (nid: string, str: number) => {
        const unit = new UnitObject({
          nid, name: nid, desc: '', variant: null, level: 1, klass: template.klass,
          tags: [], bases: { HP: 30, STR: str, MAG: 0, SKL: 0, SPD: 0, LCK: 0, DEF: 0, RES: 0, CON: 5, MOV: 5 },
          growths: {}, stat_cap_modifiers: {}, starting_items: [], learned_skills: [],
          unit_notes: [], fields: [], wexp_gain: {}, portrait_nid: '', affinity: '',
        } as any, klass);
        unit.currentHp = 30;
        return unit;
      };
      const makeItem = (nid: string, hit: number) => new ItemObject({
        nid, name: nid, desc: '', icon_nid: '', icon_index: [0, 0],
        components: [['weapon', null], ['damage', 0], ['hit', hit], ['uses', 99]],
      });

      const attacker = makeUnit('_GlOffA', 20);
      const defender = makeUnit('_GlOffDef', 0);
      const item = makeItem('_GlOffItem', 80);
      attacker.items.push(item);

      const oldBand = game.db.constants.get('glancing_hit');
      game.db.constants.delete('glancing_hit'); // getConstant falls back to default 0.

      // Same roll=70 that produced a glancing hit above, but with the
      // constant unset (default off): must be a full, un-halved normal hit.
      const solver = new CombatPhaseSolver(() => 70, game);
      const strikes = solver.resolve(attacker, item, defender, null, game.db, 'classic', null, null);

      if (oldBand === undefined) game.db.constants.delete('glancing_hit');
      else game.db.constants.set('glancing_hit', oldBand);

      return { hit: strikes[0]?.hit, glancingFlag: strikes[0]?.glancing, damage: strikes[0]?.damage };
    });

    expect(result).not.toBeNull();
    expect(result!.hit).toBe(true);
    expect(result!.glancingFlag).toBeUndefined();
    expect(result!.damage).toBeGreaterThan(0);
  });

  test('grandmaster mode: glancing applies whenever 0 < to-hit <= glancing_hit, composing with Grandmaster damage scaling', async ({ page }) => {
    await page.goto('/?harness=true&level=0&clean=true&bundle=false');
    await waitForHarness(page);

    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { UnitObject } = await import('/src/objects/unit.ts');
      const { ItemObject } = await import('/src/objects/item.ts');
      const { CombatPhaseSolver } = await import('/src/combat/combat-solver.ts');
      const { computeDamage } = await import('/src/combat/combat-calcs.ts');

      const template = game.units.get('Eirika');
      const klass = template ? game.db.classes.get(template.klass) : null;
      if (!template || !klass) return null;

      const makeUnit = (nid: string, str: number) => {
        const unit = new UnitObject({
          nid, name: nid, desc: '', variant: null, level: 1, klass: template.klass,
          tags: [], bases: { HP: 30, STR: str, MAG: 0, SKL: 0, SPD: 0, LCK: 0, DEF: 0, RES: 0, CON: 5, MOV: 5 },
          growths: {}, stat_cap_modifiers: {}, starting_items: [], learned_skills: [],
          unit_notes: [], fields: [], wexp_gain: {}, portrait_nid: '', affinity: '',
        } as any, klass);
        unit.currentHp = 30;
        return unit;
      };
      const makeItem = (nid: string, hit: number) => new ItemObject({
        nid, name: nid, desc: '', icon_nid: '', icon_index: [0, 0],
        components: [['weapon', null], ['damage', 0], ['hit', hit], ['uses', 99]],
      });

      // Grandmaster's roll is fixed at 0, so glancing triggers whenever
      // `0 >= to_hit - glancing_hit`, i.e. `to_hit <= glancing_hit`, while
      // still hitting (`to_hit > 0`). hit=10, glancing_hit=15 -> both hold.
      const attacker = makeUnit('_GmGlA', 20);
      const defender = makeUnit('_GmGlDef', 0);
      const item = makeItem('_GmGlItem', 10);
      attacker.items.push(item);
      const baseDamage = computeDamage(attacker, item, defender, game.db, null, game, 'attack', false);
      const expectedGrandmasterDmg = Math.trunc(baseDamage * 10 / 100);

      const oldBand = game.db.constants.get('glancing_hit');
      game.db.constants.set('glancing_hit', 15);
      const solver = new CombatPhaseSolver(() => 0, game);
      const strikes = solver.resolve(attacker, item, defender, null, game.db, 'grandmaster', null, null);
      if (oldBand === undefined) game.db.constants.delete('glancing_hit');
      else game.db.constants.set('glancing_hit', oldBand);

      return {
        baseDamage,
        hit: strikes[0]?.hit,
        glancingFlag: strikes[0]?.glancing,
        damage: strikes[0]?.damage,
        expectedGrandmasterDmg,
      };
    });

    expect(result).not.toBeNull();
    expect(result!.baseDamage).toBeGreaterThan(0);
    expect(result!.hit).toBe(true);
    expect(result!.glancingFlag).toBe(true);
    // Grandmaster scaling first (trunc(base * hit/100)), then glancing halves it.
    expect(result!.damage).toBe(Math.trunc(result!.expectedGrandmasterDmg / 2));
  });
});
