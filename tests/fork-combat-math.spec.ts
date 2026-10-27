import { expect, test, type Page } from '@playwright/test';

/**
 * Python combat_calcs.compute_hit / compute_damage and the CombatPhaseSolver
 * state machine (fork and upstream agree on all of these):
 * - compute_hit adds the weapon triangle before the single 0-100 clamp;
 * - compute_damage clamps to min_damage before the crit terms and again at
 *   the end, and applies crit before damage_multiplier/resist_multiplier;
 * - remaining phases alternate (A D A D A), re-evaluated after each phase.
 */

async function boot(page: Page, project?: string): Promise<void> {
  const query = project ? `&project=${project}&level=X&clean=true` : '&level=DEBUG';
  await page.goto(`/?harness=true${query}&bundle=false`);
  await page.waitForFunction(() => (window as any).__harness?.ready === true, undefined, { timeout: 60_000 });
}

/** Strip Eirika/Bone down to deterministic stats on plain tiles (default project). */
async function prepareDuel(page: Page): Promise<void> {
  await page.evaluate(() => {
    const g = (window as any).__gameRef;
    const h = (window as any).__harness;
    const eirika = g.units.get('Eirika');
    const bone = g.units.get('Bone');
    h.setConstant('rng_mode', 'grandmaster');
    const [ex, ey] = eirika.position;
    g.board.removeUnit?.(bone.position[0], bone.position[1]);
    bone.position = [ex + 1, ey];
    for (const unit of [eirika, bone]) {
      unit.items = [];
      unit.equippedWeapon = null;
      unit.skills = [];
      Object.assign(unit.stats, { STR: 0, MAG: 0, SKL: 0, SPD: 0, LCK: 0, DEF: 0, RES: 0, HP: 60 });
      unit.currentHp = 60;
      unit.dead = false;
      unit.finished = false;
    }
  });
}

test.describe('Python compute_hit/compute_damage order and phase alternation', () => {
  test('triangle accuracy is added before the hit clamp', async ({ page }) => {
    await boot(page);
    await prepareDuel(page);
    const result = await page.evaluate(async () => {
      const g = (window as any).__gameRef;
      const h = (window as any).__harness;
      const calcs = await import('/src/combat/combat-calcs.ts');
      const eirika = g.units.get('Eirika');
      const bone = g.units.get('Bone');
      h.giveItem('Eirika', 'Iron_Axe');
      h.giveItem('Bone', 'Iron_Sword');
      const axe = eirika.items.find((i: any) => i.nid === 'Iron_Axe');
      const sword = bone.items.find((i: any) => i.nid === 'Iron_Sword');
      eirika.equippedWeapon = axe;
      bone.equippedWeapon = sword;
      eirika.wexp.Axe = 200;
      bone.wexp.Sword = 200;
      eirika.stats.SKL = 40;
      const acc = calcs.accuracy(eirika, axe, g.db, g);
      const avo = calcs.avoid(bone, g.db, g.board, axe, g, eirika);
      const triangle = calcs.weaponTriangle(axe, sword, g.db, eirika, bone).hitBonus;
      return {
        raw: acc - avo,
        triangle,
        hit: calcs.computeHit(eirika, axe, bone, g.db, g.board, g),
        noTriangle: calcs.computeHit(eirika, axe, bone, g.db, g.board, g, 'attack', [0, 0], null),
      };
    });
    expect(result.raw).toBeGreaterThan(100 - result.triangle);
    expect(result.triangle).toBeLessThan(0);
    // Python: clamp(raw + triangle); the old web clamped raw to 100 first.
    expect(result.hit).toBe(Math.min(100, result.raw + result.triangle));
    expect(result.hit).toBeGreaterThan(100 + result.triangle);
    expect(result.noTriangle).toBe(100);
  });

  test('a weapon without a hit component always hits in the forecast and AI', async ({ page }) => {
    // Python compute_hit: accuracy() is None without a hit hook -> 10000, which
    // forecasts and the AI clamp to 100 (EOtF Vortex, Spark, Ragnarok, ...).
    await boot(page);
    await prepareDuel(page);
    const result = await page.evaluate(async () => {
      const g = (window as any).__gameRef;
      const h = (window as any).__harness;
      const calcs = await import('/src/combat/combat-calcs.ts');
      const eirika = g.units.get('Eirika');
      const bone = g.units.get('Bone');
      h.giveItem('Eirika', 'Iron_Axe');
      const axe = eirika.items.find((i: any) => i.nid === 'Iron_Axe');
      eirika.equippedWeapon = axe;
      eirika.wexp.Axe = 200;
      bone.stats.SPD = 40;
      bone.stats.LCK = 40;
      const withHit = calcs.computeHit(eirika, axe, bone, g.db, g.board, g);
      axe.components.delete('hit');
      return { withHit, noHit: calcs.computeHit(eirika, axe, bone, g.db, g.board, g) };
    });
    expect(result.withHit).toBeLessThan(100);
    expect(result.noHit).toBe(100);
  });

  test('crit applies before damage multipliers with one final truncation', async ({ page }) => {
    await boot(page);
    await prepareDuel(page);
    const result = await page.evaluate(async () => {
      const g = (window as any).__gameRef;
      const h = (window as any).__harness;
      const calcs = await import('/src/combat/combat-calcs.ts');
      const { SkillObject } = await import('/src/objects/skill.ts');
      const eirika = g.units.get('Eirika');
      const bone = g.units.get('Bone');
      h.giveItem('Eirika', 'Iron_Sword');
      const sword = eirika.items.find((i: any) => i.nid === 'Iron_Sword');
      eirika.equippedWeapon = sword;
      eirika.stats.STR = 10;
      const normal = calcs.computeDamage(eirika, sword, bone, g.db, g.board, g, 'attack', false, [0, 0], false, null);
      eirika.skills = [new SkillObject({
        nid: '_Half', name: '_Half', desc: '', icon_nid: '', icon_index: [0, 0],
        components: [['damage_multiplier', 0.5]],
      } as any)];
      return {
        normal,
        halved: calcs.computeDamage(eirika, sword, bone, g.db, g.board, g, 'attack', false, [0, 0], false, null),
        halvedCrit: calcs.computeDamage(eirika, sword, bone, g.db, g.board, g, 'attack', false, [0, 0], true, null),
        critMult: calcs.criticalMultiplier(eirika, sword, bone, g.db, g),
      };
    });
    expect(result.critMult).toBe(3);
    expect(result.halved).toBe(Math.trunc(result.normal * 0.5));
    // Python int(normal * 3 * 0.5); the old web did floor(normal * 0.5) * 3.
    expect(result.halvedCrit).toBe(Math.trunc(result.normal * 3 * 0.5));
    expect(result.normal % 2).toBe(1);
  });

  test('remaining phases alternate like the Python state machine', async ({ page }) => {
    await boot(page);
    await prepareDuel(page);
    const order = await page.evaluate(async () => {
      const g = (window as any).__gameRef;
      const h = (window as any).__harness;
      const { SkillObject } = await import('/src/objects/skill.ts');
      const eirika = g.units.get('Eirika');
      const bone = g.units.get('Bone');
      h.giveItem('Eirika', 'Iron_Sword');
      h.giveItem('Bone', 'Iron_Sword');
      for (const unit of [eirika, bone]) {
        unit.equippedWeapon = unit.items[0];
        unit.items[0].uses = 99;
        unit.wexp.Sword = 200;
        unit.stats.STR = 1;
      }
      const extra = (nid: string, value: string) => new SkillObject({
        nid, name: nid, desc: '', icon_nid: '', icon_index: [0, 0],
        components: [['dynamic_attacks', value]],
      } as any);
      eirika.skills = [extra('_TwoMore', '2')];
      bone.skills = [extra('_OneMore', '1')];
      const result = h.resolveCombat('Eirika', 'Bone', undefined, true);
      return result.strikeDetails.map((s: any) => (s.striker === 'attacker' ? 'A' : 'D')).join('');
    });
    // Attacker 3 phases, defender 2: Python gives A D A D A (old web: A D A A D).
    expect(order).toBe('ADADA');
  });

  test('EOtF min_damage floors hits before crit and at the end', async ({ page }) => {
    await boot(page, 'eotf.ltproj');
    const result = await page.evaluate(async () => {
      const g = (window as any).__gameRef;
      const calcs = await import('/src/combat/combat-calcs.ts');
      const { ItemObject } = await import('/src/objects/item.ts');
      const units = [...g.units.values()].filter((u: any) => u.position);
      const [attacker, defender] = units;
      const pebble = new ItemObject({
        nid: '_Pebble', name: '_Pebble', desc: '', icon_nid: '', icon_index: [0, 0],
        components: [['weapon', null], ['damage', 0]],
      } as any);
      const saved = defender.stats.DEF;
      defender.stats.DEF = 99;
      const out = {
        minDamage: calcs.minDamage(g.db),
        critMult: calcs.criticalMultiplier(attacker, pebble, defender, g.db, g),
        hit: calcs.computeDamage(attacker, pebble, defender, g.db, g.board, g, 'attack', false, [0, 0], false, null),
        crit: calcs.computeDamage(attacker, pebble, defender, g.db, g.board, g, 'attack', false, [0, 0], true, null),
      };
      defender.stats.DEF = saved;
      return out;
    });
    expect(result.minDamage).toBe(1);
    expect(result.hit).toBe(1);
    expect(result.crit).toBe(result.critMult);
  });

  test('resolve_weapon reads the equipped weapon on the fork, the first weapon upstream', async ({ page }) => {
    await boot(page);
    const result = await page.evaluate(async () => {
      const g = (window as any).__gameRef;
      const calcs = await import('/src/combat/combat-calcs.ts');
      const flavor = await import('/src/engine/engine-flavor.ts');
      const unit = g.units.get('Eirika');
      const savedEquipped = unit.equippedWeapon;
      const first = unit.items.find((item: any) => item.isWeapon());
      unit.equippedWeapon = null;
      const wasFork = flavor.isForkEngine();
      try {
        flavor.setForkEngine(false);
        const upstream = calcs.resolveWeapon(unit)?.nid ?? null;
        flavor.setForkEngine(true);
        const fork = calcs.resolveWeapon(unit)?.nid ?? null;
        return { first: first?.nid ?? null, upstream, fork };
      } finally {
        flavor.setForkEngine(wasFork);
        unit.equippedWeapon = savedEquipped;
      }
    });
    // The upstream port keeps its first-weapon fallback (and must not recurse).
    expect(result.first).not.toBeNull();
    expect(result.upstream).toBe(result.first);
    expect(result.fork).toBeNull();
  });
});
