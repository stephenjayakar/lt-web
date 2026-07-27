/**
 * Deterministic golden combat-scenario matrix (P4 roadmap row).
 *
 * Locks CombatPhaseSolver strike ordering + damage to Python parity for:
 * weapon triangle, brave, vantage, desperation, vantage+desperation
 * precedence, vantage+brave, miracle (survive-then-die), effective damage
 * (Armorslayer exact numbers). Every scenario uses `grandmaster` RNG (the
 * web harness always hits under grandmaster, see combat-solver.ts rollHit)
 * and crit:0 weapons so outcomes are fully deterministic; expected damage
 * values are hand-computed from the DAMAGE/DEFENSE equations
 * (`STR + item.might - DEF`, see lt-maker default.ltproj equations.json)
 * and cross-checked against lt-maker/app/engine/combat/solver.py ordering.
 *
 * Reference: lt-maker/app/engine/combat/solver.py (InitState/AttackerState/
 * DefenderState get_next_state), lt-maker/app/engine/skill_components/
 * combat2_components.py (Miracle.cleanup_combat, Vantage, Desperation).
 *
 * Full scripted-combat token coverage beyond the current smoke cases remains
 * separate work. Natural combat does re-evaluate strike counts, counter
 * eligibility, and doubling between phases, so mid-combat status changes
 * influence later phases like Python's state machine.
 */

import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';

async function waitForHarness(page: Page): Promise<void> {
  await page.waitForFunction(() => !!(window as any).__harness?.ready, { timeout: 15000 });
}

async function stepFrames(page: Page, count: number): Promise<void> {
  await page.evaluate(
    (count) => (window as any).__harness.stepFrames(count, null),
    count,
  );
}

interface RawSkillSpec {
  nid: string;
  components: Array<[string, unknown]>;
}

/** Build a bare-bones runtime skill object matching SkillObject's duck-typed API. */
function makeSkillSetup() {
  return `
    function makeSkill(spec) {
      const components = new Map(spec.components);
      const data = new Map();
      const buildCharge = components.get('build_charge');
      const drainCharge = components.get('drain_charge') ?? components.get('charges_per_turn');
      if (typeof buildCharge === 'number') {
        data.set('charge', 0);
        data.set('total_charge', buildCharge);
      } else if (typeof drainCharge === 'number') {
        data.set('charge', drainCharge);
        data.set('total_charge', drainCharge);
      }
      return {
        nid: spec.nid,
        name: spec.nid,
        components,
        data,
        hasComponent(n) { return this.components.has(n); },
        getComponent(n) { return this.components.get(n); },
      };
    }
  `;
}

/** Shared setup: Eirika (attacker) vs Bone (defender), stats fully overridden for determinism. */
interface UnitSpec {
  weaponNid: string | null;
  str?: number;
  weaponComponents?: Array<[string, unknown]>;
  def?: number;
  spd?: number;
  hp?: number;
  currentHp?: number;
  skills?: RawSkillSpec[];
}

interface SetupConfig {
  eirika: UnitSpec;
  bone: UnitSpec;
}

async function setupAndResolve(
  page: Page,
  cfg: SetupConfig,
  script?: string[],
): Promise<any> {
  return page.evaluate(({ cfg, script, skillSetupSrc }) => {
    // eslint-disable-next-line no-new-func
    const makeSkill = new Function(`${skillSetupSrc}; return makeSkill;`)();
    const g = (window as any).__gameRef;
    const h = (window as any).__harness;
    const eirika = g?.units?.get?.('Eirika');
    const bone = g?.units?.get?.('Bone');
    if (!eirika || !bone) return null;

    h.setConstant('rng_mode', 'grandmaster');

    // Both units must stand on a terrain tile with a zero defense/avoid bonus
    // for the hand-computed damage numbers below to hold (Bone's default map
    // position is Forest, +1 DEF; Eirika's is Plain, +0). Move Bone onto a
    // neighboring Plain tile so `defense()`'s terrain term is 0 for both.
    const [ex, ey] = eirika.position;
    bone.position = [ex + 1, ey];

    function applyUnit(unit: any, spec: any): void {
      unit.items = [];
      unit.equippedWeapon = null;
      if (spec.weaponNid) {
        h.giveItem(unit.nid, spec.weaponNid);
        const item = unit.items.find((i: any) => i.nid === spec.weaponNid);
        if (item) {
          unit.wexp[item.getWeaponType?.() ?? ''] = 200;
          unit.equippedWeapon = item;
          item.uses = 99;
          for (const [nid, value] of spec.weaponComponents ?? []) {
            item.components.set(nid, value);
          }
          item.maxUses = 99;
        }
      }
      if (spec.str != null) unit.stats.STR = spec.str;
      if (spec.def != null) unit.stats.DEF = spec.def;
      if (spec.spd != null) unit.stats.SPD = spec.spd;
      // SKL 0 (not just item crit:0): computeCrit's base term is SKL // 2,
      // so a nonzero SKL still grants crit chance even on a crit:0 weapon --
      // now that the rng_mode fixture typo is fixed and 'grandmaster' really
      // applies, that stray crit chance is no longer masked by a different
      // fallback RNG mode happening to not roll a crit on this stream, and
      // would otherwise make these "fully deterministic" goldens flaky.
      unit.stats.SKL = 0;
      unit.stats.LCK = 0;
      if (spec.hp != null) unit.stats.HP = spec.hp;
      unit.currentHp = spec.currentHp ?? unit.stats.HP;
      unit.dead = false;
      unit.finished = false;
      unit.hasAttacked = false;
      unit.skills = (spec.skills ?? []).map((s: any) => makeSkill(s));
    }

    applyUnit(eirika, cfg.eirika);
    applyUnit(bone, cfg.bone);

    return h.resolveCombat('Eirika', 'Bone', script, true);
  }, { cfg, script, skillSetupSrc: makeSkillSetup() });
}

test.describe('combat golden matrix', () => {
  test('standard order: attacker strikes, defender counters, no doubling', async ({ page }) => {
    await page.goto('/?harness=true&level=DEBUG&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 5);

    // Eirika STR10 + Iron_Sword(5) - Bone DEF2 = 13. Bone STR8 + Iron_Sword(5) - Eirika DEF0 = 13.
    // Equal SPD (diff 0 < SPEED_TO_DOUBLE=4): no doubling either side.
    // Both sides' to-hit: SKL 0 * 2 + LCK//2 0 + item hit 90 - avoid (SPD 5 * 2 + LCK 0 = 10) = 80.
    // Grandmaster scales damage by to-hit% (weapon_components.py Damage.on_hit):
    // trunc(13 * 80 / 100) = 10, for both the attack and the counter.
    const r = await setupAndResolve(page, {
      eirika: { weaponNid: 'Iron_Sword', str: 10, def: 0, spd: 5, hp: 999 },
      bone: { weaponNid: 'Iron_Sword', str: 8, def: 2, spd: 5, hp: 999 },
    });
    expect(r).not.toBeNull();
    expect(r.strikeDetails.map((s: any) => s.striker)).toEqual(['attacker', 'defender']);
    expect(r.strikeDetails[0].damage).toBe(10);
    expect(r.strikeDetails[1].damage).toBe(10);
    expect(r.strikeDetails[1].isCounter).toBe(true);
    expect(r.attackerHp).toBe(999 - 10);
    expect(r.defenderHp).toBe(999 - 10);
  });

  test('attacker doubles when speed advantage >= SPEED_TO_DOUBLE (4)', async ({ page }) => {
    await page.goto('/?harness=true&level=DEBUG&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 5);

    const r = await setupAndResolve(page, {
      eirika: { weaponNid: 'Iron_Sword', str: 10, def: 0, spd: 9, hp: 999 },
      bone: { weaponNid: 'Iron_Sword', str: 8, def: 2, spd: 5, hp: 999 },
    });
    expect(r).not.toBeNull();
    // Python order for a plain double: attack, counter, attack-double.
    expect(r.strikeDetails.map((s: any) => s.striker)).toEqual(['attacker', 'defender', 'attacker']);
    // Attacker to-hit is unaffected by its own SPD (80, as in the standard-order
    // case above): trunc(13 * 80 / 100) = 10 for both attacker strikes.
    // Bone's counter to-hit uses Eirika's now-higher AS (SPD9, weight5 <= CON5,
    // so AS=9): avoid = AS*2 = 18, to-hit = 90 - 18 = 72; trunc(13*72/100) = 9.
    expect(r.strikeDetails.map((s: any) => s.damage)).toEqual([10, 9, 10]);
  });

  test('weapon triangle: Sword > Axe advantage flips sign with attacker/defender swapped', async ({ page }) => {
    await page.goto('/?harness=true&level=DEBUG&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 5);

    // Sword-wielding Eirika vs Axe-wielding Bone: triangle favors Eirika.
    const swordVsAxe = await setupAndResolve(page, {
      eirika: { weaponNid: 'Iron_Sword', str: 10, def: 0, spd: 5, hp: 999 },
      bone: { weaponNid: 'Iron_Axe', str: 8, def: 2, spd: 5, hp: 999 },
    });
    // Axe-wielding Eirika vs Sword-wielding Bone: triangle now disfavors Eirika
    // (Axe < Sword), the mirror image of the above.
    const axeVsSword = await setupAndResolve(page, {
      eirika: { weaponNid: 'Iron_Axe', str: 10, def: 0, spd: 5, hp: 999 },
      bone: { weaponNid: 'Iron_Sword', str: 8, def: 2, spd: 5, hp: 999 },
    });
    expect(swordVsAxe).not.toBeNull();
    expect(axeVsSword).not.toBeNull();
    const swordAdvantageDmg = swordVsAxe.strikeDetails[0].damage;
    const axeDisadvantageDmg = axeVsSword.strikeDetails[0].damage;
    // Same base stats/might (STR10+Iron_Sword-or-Axe damage(5 or 8)-DEF2), but
    // Iron_Axe has higher base might (8) than Iron_Sword (5); the triangle
    // bonus is what we're isolating, so compare against the neutral (no
    // opposing weapon) case for each attacker weapon instead of each other.
    const swordVsUnarmed = await setupAndResolve(page, {
      eirika: { weaponNid: 'Iron_Sword', str: 10, def: 0, spd: 5, hp: 999 },
      bone: { weaponNid: null, str: 8, def: 2, spd: 5, hp: 999 },
    });
    const axeVsUnarmed = await setupAndResolve(page, {
      eirika: { weaponNid: 'Iron_Axe', str: 10, def: 0, spd: 5, hp: 999 },
      bone: { weaponNid: null, str: 8, def: 2, spd: 5, hp: 999 },
    });
    const swordTriangleBonus = swordAdvantageDmg - swordVsUnarmed.strikeDetails[0].damage;
    const axeTriangleBonus = axeDisadvantageDmg - axeVsUnarmed.strikeDetails[0].damage;
    // Sword beats Axe: positive damage bonus. Axe loses to Sword: non-positive
    // (Python's advantage table is symmetric-signed across the matchup).
    expect(swordTriangleBonus).toBeGreaterThan(0);
    expect(axeTriangleBonus).toBeLessThanOrEqual(0);
  });

  test('brave weapon: two consecutive attacker strikes before the counter', async ({ page }) => {
    await page.goto('/?harness=true&level=DEBUG&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 5);

    // Brave_Sword might 9: 10 + 9 - 2 = 17 per strike, twice, then one counter.
    // Brave_Sword's lower hit stat brings Eirika's to-hit to 65 (vs Iron_Sword's
    // 80 above): trunc(17 * 65 / 100) = 11 for each attacker strike.
    const r = await setupAndResolve(page, {
      eirika: { weaponNid: 'Brave_Sword', str: 10, def: 0, spd: 5, hp: 999 },
      bone: { weaponNid: 'Iron_Sword', str: 8, def: 2, spd: 5, hp: 999 },
    });
    expect(r).not.toBeNull();
    // Bone doubles back. Python applies weight through modify_attack_speed:
    // Eirika AS = SPD 5 - max(0, Brave_Sword 12 - CON 5) = -2, while Bone's
    // AS = SPD 5 - max(0, Iron_Sword 5 - CON 12) = 5. The gap of 7 clears
    // SPEED_TO_DOUBLE (4), so the counter comes twice.
    expect(r.strikeDetails.map((s: any) => s.striker))
      .toEqual(['attacker', 'attacker', 'defender', 'defender']);
    expect(r.strikeDetails[0].damage).toBe(11);
    expect(r.strikeDetails[1].damage).toBe(11);
    expect(r.strikeDetails[2].isCounter).toBe(true);
  });

  test('brave_on_attack doubles only the initiating unit, not a counterattack', async ({ page }) => {
    await page.goto('/?harness=true&level=DEBUG&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 5);

    const initiating = await setupAndResolve(page, {
      eirika: {
        weaponNid: 'Iron_Sword',
        weaponComponents: [['brave_on_attack', null]],
        str: 10, def: 0, spd: 5, hp: 999,
      },
      bone: { weaponNid: 'Iron_Sword', str: 8, def: 2, spd: 5, hp: 999 },
    });
    expect(initiating).not.toBeNull();
    expect(initiating.strikeDetails.map((strike: any) => strike.striker))
      .toEqual(['attacker', 'attacker', 'defender']);

    const countering = await setupAndResolve(page, {
      eirika: { weaponNid: 'Iron_Sword', str: 10, def: 0, spd: 5, hp: 999 },
      bone: {
        weaponNid: 'Iron_Sword',
        weaponComponents: [['brave_on_attack', null]],
        str: 8, def: 2, spd: 5, hp: 999,
      },
    });
    expect(countering).not.toBeNull();
    expect(countering.strikeDetails.map((strike: any) => strike.striker))
      .toEqual(['attacker', 'defender']);
    expect(countering.strikeDetails[1].isCounter).toBe(true);
  });

  test('vantage: defender with vantage strikes first', async ({ page }) => {
    await page.goto('/?harness=true&level=DEBUG&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 5);

    const r = await setupAndResolve(page, {
      eirika: { weaponNid: 'Iron_Sword', str: 10, def: 0, spd: 5, hp: 999 },
      bone: {
        weaponNid: 'Iron_Sword', str: 8, def: 2, spd: 5, hp: 999,
        skills: [{ nid: 'Vantage', components: [['vantage', null]] }],
      },
    });
    expect(r).not.toBeNull();
    expect(r.strikeDetails.map((s: any) => s.striker)).toEqual(['defender', 'attacker']);
    expect(r.strikeDetails[0].isCounter).toBe(true);
  });

  test('desperation: all attacker strikes (incl. double) resolve before the counter', async ({ page }) => {
    await page.goto('/?harness=true&level=DEBUG&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 5);

    const r = await setupAndResolve(page, {
      eirika: {
        weaponNid: 'Iron_Sword', str: 10, def: 0, spd: 9, hp: 999,
        skills: [{ nid: 'Desperation', components: [['desperation', null]] }],
      },
      bone: { weaponNid: 'Iron_Sword', str: 8, def: 2, spd: 5, hp: 999 },
    });
    expect(r).not.toBeNull();
    // Without desperation this would be [attacker, defender, attacker]; with
    // it, both attacker strikes (initial + double) go before the counter.
    expect(r.strikeDetails.map((s: any) => s.striker)).toEqual(['attacker', 'attacker', 'defender']);
  });

  test('vantage + desperation precedence: vantage wins the opening strike, desperation still chains the attacker double', async ({ page }) => {
    await page.goto('/?harness=true&level=DEBUG&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 5);

    const r = await setupAndResolve(page, {
      eirika: {
        weaponNid: 'Iron_Sword', str: 10, def: 0, spd: 9, hp: 999,
        skills: [{ nid: 'Desperation', components: [['desperation', null]] }],
      },
      bone: {
        weaponNid: 'Iron_Sword', str: 8, def: 2, spd: 5, hp: 999,
        skills: [{ nid: 'Vantage', components: [['vantage', null]] }],
      },
    });
    expect(r).not.toBeNull();
    // Python solver.py InitState checks defender_has_vantage() first (defender
    // opens), then AttackerState's desperation branch chains both attacker
    // strikes before ceding back to the defender (who has no double here).
    expect(r.strikeDetails.map((s: any) => s.striker)).toEqual(['defender', 'attacker', 'attacker']);
    expect(r.strikeDetails[0].isCounter).toBe(true);
  });

  test('vantage + brave: defender opens, then both brave attacker strikes land back to back', async ({ page }) => {
    await page.goto('/?harness=true&level=DEBUG&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 5);

    const r = await setupAndResolve(page, {
      eirika: { weaponNid: 'Brave_Sword', str: 10, def: 0, spd: 5, hp: 999 },
      bone: {
        weaponNid: 'Iron_Sword', str: 8, def: 2, spd: 5, hp: 999,
        skills: [{ nid: 'Vantage', components: [['vantage', null]] }],
      },
    });
    expect(r).not.toBeNull();
    // Vantage moves Bone's first counter ahead of the brave strikes; Bone's
    // weight-driven attack-speed lead (see the brave-weapon case above) then
    // adds the doubled counter at the end.
    expect(r.strikeDetails.map((s: any) => s.striker))
      .toEqual(['defender', 'attacker', 'attacker', 'defender']);
    // Same Brave_Sword-vs-Iron_Sword to-hit (65) as the plain brave-weapon
    // case above: trunc(17 * 65 / 100) = 11 for each attacker strike.
    expect(r.strikeDetails[1].damage).toBe(11);
    expect(r.strikeDetails[2].damage).toBe(11);
  });

  test('miracle: survives lethal damage at 1 HP once, then dies once the charge is spent', async ({ page }) => {
    await page.goto('/?harness=true&level=DEBUG&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 5);

    // Eirika deals 10 + 5 - 2 = 13 damage; Bone starts each round at 10 HP,
    // so every hit is lethal absent Miracle. drain_charge:1 gives exactly one
    // save before the skill goes inactive (Python DrainCharge.condition:
    // charge > 0; TriggerCharge decrements to 0 on use).
    const cfg = {
      eirika: { weaponNid: 'Iron_Sword', str: 10, def: 0, spd: 5, hp: 999 },
      bone: {
        weaponNid: null, str: 8, def: 2, spd: 5, hp: 999, currentHp: 10,
        skills: [{ nid: 'Miracle', components: [['miracle', null], ['drain_charge', 1]] }],
      },
    };
    const first = await setupAndResolve(page, cfg);
    expect(first).not.toBeNull();
    expect(first.defenderMiracleSaved).toBe(true);
    expect(first.defenderDead).toBe(false);
    expect(first.defenderHp).toBe(1);

    // Second combat: Bone's currentHp carries over from the first (=1) via
    // the harness's real unit references; the skill object also persists so
    // its charge (now 0) is still attached. Force Bone back to 10 HP to
    // repeat the lethal-hit setup, but reuse the same skill array via a
    // dedicated in-page continuation so the charge state is untouched.
    const second = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const h = (window as any).__harness;
      const bone = g?.units?.get?.('Bone');
      bone.currentHp = 10;
      bone.dead = false;
      const eirika = g?.units?.get?.('Eirika');
      eirika.dead = false;
      eirika.finished = false;
      eirika.hasAttacked = false;
      return h.resolveCombat('Eirika', 'Bone', undefined, true);
    });
    expect(second).not.toBeNull();
    expect(second.defenderMiracleSaved).toBe(false);
    expect(second.defenderDead).toBe(true);
    expect(second.defenderHp).toBe(0);
  });

  test('Armorslayer effective damage: exact flat bonus_damage vs an Armor-tagged target', async ({ page }) => {
    await page.goto('/?harness=true&level=DEBUG&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 5);

    // default.ltproj Armorslayer: damage 8, effective_bonus_damage 16,
    // effective_multiplier 1.0 (so the (multiplier-1)*might term is 0 and the
    // Armor-tag bonus is purely the flat +16). Base: 10 + 8 - 2 = 16; with the
    // effective bonus: 16 + 16 = 32. General is an Armor-tagged class.
    // Armorslayer's own hit stat (Bone unarmed, no weapon-triangle term) gives
    // to-hit 70; Grandmaster scales damage by to-hit%: trunc(32 * 70 / 100) = 22.
    const r = await page.evaluate(async () => {
      const g = (window as any).__gameRef;
      const h = (window as any).__harness;
      const eirika = g?.units?.get?.('Eirika');
      const bone = g?.units?.get?.('Bone');
      h.setConstant('rng_mode', 'grandmaster');
      // See setupAndResolve: reposition Bone off Forest (+1 DEF) onto Plain.
      const [ex, ey] = eirika.position;
      bone.position = [ex + 1, ey];
      eirika.items = [];
      h.giveItem('Eirika', 'Armorslayer');
      eirika.wexp.Sword = 200;
      h.equipItem('Eirika', 'Armorslayer');
      const weapon = eirika.items.find((i: any) => i.nid === 'Armorslayer');
      weapon.uses = 99;
      weapon.maxUses = 99;
      eirika.stats.STR = 10;
      eirika.stats.DEF = 0;
      eirika.stats.SPD = 5;
      // SKL 0: see setupAndResolve's applyUnit for why (crit chance isn't
      // gated by the weapon's crit:0 alone).
      eirika.stats.SKL = 0;
      eirika.stats.LCK = 0;
      eirika.stats.HP = 999;
      eirika.currentHp = 999;
      eirika.dead = false;
      bone.klass = 'General';
      bone.tags = ['Armor'];
      bone.items = [];
      bone.equippedWeapon = null;
      bone.stats.DEF = 2;
      bone.stats.SPD = 5;
      bone.stats.HP = 999;
      bone.currentHp = 999;
      bone.dead = false;
      bone.skills = [];
      return h.resolveCombat('Eirika', 'Bone', undefined, true);
    });
    expect(r).not.toBeNull();
    expect(r.strikeDetails[0].damage).toBe(22);
  });

  test('damage_on_miss deals its fraction of normal damage on a forced miss', async ({ page }) => {
    await page.goto('/?harness=true&level=DEBUG&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 5);

    const result = await setupAndResolve(
      page,
      {
        eirika: {
          weaponNid: 'Iron_Sword',
          str: 10,
          def: 0,
          spd: 5,
          hp: 999,
          weaponComponents: [['damage_on_miss', 0.5]],
        },
        bone: { weaponNid: null, str: 8, def: 2, spd: 5, hp: 999 },
      },
      ['miss1', 'end'],
    );
    expect(result).not.toBeNull();
    expect(result.strikeDetails).toHaveLength(1);
    expect(result.strikeDetails[0].hit).toBe(false);
    expect(result.defenderHp).toBe(993);
  });

  test('eclipse_fe7 reduces the target to one HP on hit', async ({ page }) => {
    await page.goto('/?harness=true&level=DEBUG&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 5);

    const result = await setupAndResolve(
      page,
      {
        eirika: {
          weaponNid: 'Iron_Sword',
          str: 10,
          def: 0,
          spd: 5,
          hp: 999,
          weaponComponents: [['eclipse_fe7', null]],
        },
        bone: {
          weaponNid: null,
          str: 8,
          def: 2,
          spd: 5,
          hp: 37,
          currentHp: 37,
        },
      },
      ['hit1', 'end'],
    );
    expect(result).not.toBeNull();
    expect(result.strikeDetails).toHaveLength(1);
    expect(result.strikeDetails[0].hit).toBe(true);
    expect(result.defenderHp).toBe(1);
  });

  test('scripted combat: forced hit1/hit2 tokens control strike order and outcome', async ({ page }) => {
    await page.goto('/?harness=true&level=DEBUG&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 5);

    // 'hit2' before 'hit1' forces the defender to strike first even without
    // vantage, exercising CombatScript token precedence (see interact_unit /
    // resolveScripted). 10 + 5 - 2 = 13 for Eirika; 8 + 5 - 0 = 13 for Bone.
    const r = await setupAndResolve(
      page,
      {
        eirika: { weaponNid: 'Iron_Sword', str: 10, def: 0, spd: 5, hp: 999 },
        bone: { weaponNid: 'Iron_Sword', str: 8, def: 2, spd: 5, hp: 999 },
      },
      ['hit2', 'hit1', 'end'],
    );
    expect(r).not.toBeNull();
    expect(r.strikeDetails.map((s: any) => s.striker)).toEqual(['defender', 'attacker']);
    expect(r.strikeDetails.every((s: any) => s.hit)).toBe(true);
  });

  test('weapon weight lowers attack speed, defense speed, and avoid', async ({ page }) => {
    await page.goto('/?harness=true&level=DEBUG&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 5);

    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { ItemObject } = await import('/src/objects/item.ts');
      const cc = await import('/src/combat/combat-calcs.ts');
      const unit = game.units.get('Eirika');
      const saved = { stats: { ...unit.stats }, items: unit.items.slice() };
      unit.stats.SPD = 10;
      unit.stats.CON = 3;
      unit.stats.LCK = 0;

      const make = (nid: string, weight: number) => new ItemObject({
        nid,
        name: '',
        desc: '',
        icon_nid: '',
        icon_index: [0, 0],
        components: [['weapon', null], ['weight', weight]],
      });
      // Weight 9 against CON 3 costs 6 attack speed and 12 avoid; weight 2 is
      // under CON so it costs nothing. Python applies this through the
      // modify_attack_speed / modify_avoid hooks, not inside ATTACK_SPEED.
      const heavy = make('_Heavy', 9);
      const light = make('_Light', 2);

      unit.items = [heavy];
      const avoidHeavy = cc.avoid(unit, game.db, null, null, game);
      unit.items = [light];
      const avoidLight = cc.avoid(unit, game.db, null, null, game);

      const out = {
        asLight: cc.attackSpeed(unit, light, game.db, game),
        asHeavy: cc.attackSpeed(unit, heavy, game.db, game),
        dsHeavy: cc.defenseSpeed(unit, heavy, game.db, null, game),
        avoidDelta: avoidLight - avoidHeavy,
      };
      unit.stats = saved.stats;
      unit.items = saved.items;
      return out;
    });

    expect(result.asLight).toBe(10);
    expect(result.asHeavy).toBe(4);
    expect(result.dsHeavy).toBe(4);
    // AVOID is SPD*2 + LCK, and modify_avoid subtracts twice the penalty.
    expect(result.avoidDelta).toBe(12);
  });
});
