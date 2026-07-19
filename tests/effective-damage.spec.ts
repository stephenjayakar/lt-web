/**
 * effective_damage item-component parity tests.
 *
 * Covers the canonical `effective_damage` component (Armorslayer, Hammer,
 * Rapier, ballistae, ...) and the deprecated `effective`/`effective_tag` NIDs:
 *  - (multiplier - 1) * might + effective_bonus_damage bonus vs a tagged target.
 *  - Target tags include the unit's class tags from the db Klass def.
 *  - `negate` and matching `negate_tags` skills suppress effectiveness.
 *  - Non-matching `negate_tags` does not suppress.
 *  - Deprecated `effective` flat bonus still applies.
 *  - `weapon_effectiveness_multiplied` folds the weapon-triangle damage
 *    advantage into the effective might.
 *
 * Each scenario measures the damage delta between an otherwise-identical
 * combat with and without the effective component, isolating the component's
 * contribution exactly as Python `EffectiveDamage.dynamic_damage` would.
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

interface EffectiveMeasure {
  base: number | null;
  eff: number | null;
  diff: number | null;
  itemDamage: number;
}

interface BoneSkillSpec {
  components: Array<[string, unknown]>;
}

interface MeasureConfig {
  boneKlass?: string;
  boneTags?: string[];
  boneSkills?: BoneSkillSpec[];
  effective?: {
    canonical?: boolean;
    value?: Record<string, unknown>;
    tags?: string[];
    flat?: number;
    multiplier?: number;
  };
}

/**
 * Set up Eirika with an Iron_Sword and Bone per `cfg`, then run two combats
 * (baseline with no effective component, then with the configured effective
 * component) and return the per-combat damage dealt to Bone plus the diff.
 */
async function measureEffective(page: Page, cfg: MeasureConfig): Promise<EffectiveMeasure> {
  return page.evaluate((c: MeasureConfig) => {
    const g = (window as any).__gameRef;
    const h = (window as any).__harness;
    const eirika = g?.units?.get?.('Eirika');
    const bone = g?.units?.get?.('Bone');
    if (!eirika || !bone) return { base: null, eff: null, diff: null, itemDamage: 0 };

    // Grandmaster RNG: every strike hits, removing hit-roll noise so the
    // measured delta isolates the effective component's contribution.
    h.setConstant('rng_mode', 'grandmaster');

    // --- Eirika: a clean Iron_Sword wielder with zero crit chance. ---
    h.giveItem('Eirika', 'Iron_Sword');
    eirika.wexp.Sword = Math.max(eirika.wexp.Sword ?? 0, 200);
    h.equipItem('Eirika', 'Iron_Sword');
    let weapon = eirika.equippedWeapon;
    if (!weapon || weapon.nid !== 'Iron_Sword') {
      weapon = eirika.items.find((i: any) => i.nid === 'Iron_Sword');
      eirika.equippedWeapon = weapon;
    }
    weapon.uses = 99;
    weapon.maxUses = 99;
    // SPD 0 (not 6): matching Bone's forced SPD 0 avoids a speed-advantage
    // double attack, which would otherwise double the measured delta.
    eirika.stats.SPD = 0;
    eirika.stats.SKL = 0;
    eirika.stats.LCK = 0;
    // Force to-hit to exactly 100: under Grandmaster, damage is scaled by
    // trunc(damage * hit / 100) (weapon_components.py Damage.on_hit), which
    // does not distribute over addition -- trunc(A+d) - trunc(A) isn't
    // generally d for hit < 100, so a delta measurement (base vs. effective)
    // is only exact at hit=100. Iron_Sword's own hit (90) minus Bone's avoid
    // (klass-dependent, not otherwise controlled here) isn't reliably 100,
    // so bump the weapon's hit component directly and zero Bone's avoid
    // inputs (SPD/LCK) to guarantee it.
    weapon.components.set('hit', 1000); // saturate past any terrain/avoid penalty

    // --- Bone: configurable class/tags/skills, no counter by default. ---
    if (c.boneKlass) bone.klass = c.boneKlass;
    bone.tags = c.boneTags ?? [];
    bone.items = [];
    bone.equippedWeapon = null;
    bone.stats.SPD = 0;
    bone.stats.LCK = 0;
    // No other bone stat overrides: the effective bonus is measured as a
    // delta, so Bone's default DEF/RES cancel out.
    bone.skills = (c.boneSkills ?? []).map((s) => {
      const components = new Map<string, unknown>(s.components);
      return {
        nid: 'TestSkill',
        name: 'TestSkill',
        components,
        data: new Map<string, unknown>(),
        hasComponent(n: string) { return this.components.has(n); },
        getComponent(n: string) { return this.components.get(n); },
      };
    });

    const BONE_HP = 999;

    function clearEffective(): void {
      weapon.components.delete('effective_damage');
      weapon.components.delete('effective_tag');
      weapon.components.delete('effective');
      weapon.components.delete('effective_multiplier');
    }

    function run(): number | null {
      eirika.currentHp = eirika.stats.HP;
      eirika.dead = false;
      eirika.finished = false;
      eirika.hasAttacked = false;
      bone.currentHp = BONE_HP;
      bone.dead = false;
      weapon.uses = 99;
      weapon.maxUses = 99;
      const r = h.resolveCombat('Eirika', 'Bone');
      if (!r) return null;
      return BONE_HP - r.defenderHp;
    }

    clearEffective();
    const base = run();

    clearEffective();
    if (c.effective) {
      if (c.effective.canonical) {
        weapon.components.set('effective_damage', c.effective.value);
      } else {
        if (c.effective.tags) weapon.components.set('effective_tag', c.effective.tags);
        if (c.effective.flat != null) weapon.components.set('effective', c.effective.flat);
        if (c.effective.multiplier != null) weapon.components.set('effective_multiplier', c.effective.multiplier);
      }
    }
    const eff = run();

    const diff = base != null && eff != null ? eff - base : null;
    return { base, eff, diff, itemDamage: weapon.getDamage() };
  }, cfg);
}

const CANONICAL_3X = {
  canonical: true,
  value: {
    effective_tags: ['Armor'],
    effective_multiplier: 3,
    effective_bonus_damage: 0,
    weapon_effectiveness_multiplied: false,
  },
};

test.describe('effective_damage item component', () => {
  test('canonical effective_damage vs Armor-tag class adds (multiplier-1)*might', async ({ page }) => {
    await page.goto('/?harness=true&level=DEBUG&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 5);

    // General class carries the "Armor" tag, exercising class-tag inclusion.
    const m = await measureEffective(page, { boneKlass: 'General', effective: CANONICAL_3X });
    expect(m.diff).not.toBeNull();
    // int((3 - 1) * itemDamage + 0) = 2 * itemDamage.
    expect(m.diff).toBe(2 * m.itemDamage);
  });

  test('effective_damage does nothing to a non-tagged target', async ({ page }) => {
    await page.goto('/?harness=true&level=DEBUG&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 5);

    const m = await measureEffective(page, { boneKlass: 'Brigand', boneTags: [], effective: CANONICAL_3X });
    expect(m.diff).not.toBeNull();
    expect(m.diff).toBe(0);
  });

  test('a negate skill suppresses effective_damage', async ({ page }) => {
    await page.goto('/?harness=true&level=DEBUG&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 5);

    const m = await measureEffective(page, {
      boneKlass: 'General',
      boneSkills: [{ components: [['negate', null]] }],
      effective: CANONICAL_3X,
    });
    expect(m.diff).not.toBeNull();
    expect(m.diff).toBe(0);
  });

  test('a matching negate_tags skill suppresses effective_damage', async ({ page }) => {
    await page.goto('/?harness=true&level=DEBUG&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 5);

    const m = await measureEffective(page, {
      boneKlass: 'General',
      boneSkills: [{ components: [['negate_tags', ['Armor']]] }],
      effective: CANONICAL_3X,
    });
    expect(m.diff).not.toBeNull();
    expect(m.diff).toBe(0);
  });

  test('a non-matching negate_tags skill does not suppress effective_damage', async ({ page }) => {
    await page.goto('/?harness=true&level=DEBUG&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 5);

    const m = await measureEffective(page, {
      boneKlass: 'General',
      boneSkills: [{ components: [['negate_tags', ['Flying']]] }],
      effective: CANONICAL_3X,
    });
    expect(m.diff).not.toBeNull();
    expect(m.diff).toBe(2 * m.itemDamage);
  });

  test('deprecated effective NID applies a flat bonus vs a tagged target', async ({ page }) => {
    await page.goto('/?harness=true&level=DEBUG&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 5);

    const m = await measureEffective(page, {
      boneKlass: 'General',
      effective: { canonical: false, tags: ['Armor'], flat: 10 },
    });
    expect(m.diff).not.toBeNull();
    // Deprecated EffectiveTag.dynamic_damage returns item.data['effective']
    // (a flat integer) when no effective_multiplier is set.
    expect(m.diff).toBe(10);
  });

  test('weapon triangle advantage folds into effective might when flag set', async ({ page }) => {
    await page.goto('/?harness=true&level=DEBUG&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 5);

    const result = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const h = (window as any).__harness;
      const eirika = g?.units?.get?.('Eirika');
      const bone = g?.units?.get?.('Bone');
      if (!eirika || !bone) return null;

      // Grandmaster RNG: every strike hits, removing hit-roll noise.
      h.setConstant('rng_mode', 'grandmaster');

      h.giveItem('Eirika', 'Iron_Sword');
      eirika.wexp.Sword = Math.max(eirika.wexp.Sword ?? 0, 200);
      h.equipItem('Eirika', 'Iron_Sword');
      let weapon = eirika.equippedWeapon;
      if (!weapon || weapon.nid !== 'Iron_Sword') {
        weapon = eirika.items.find((i: any) => i.nid === 'Iron_Sword');
        eirika.equippedWeapon = weapon;
      }
      weapon.uses = 99;
      weapon.maxUses = 99;
      // SPD 0: see measureEffective's comment (avoids a speed-advantage double).
      eirika.stats.SPD = 0;
      eirika.stats.SKL = 0;
      eirika.stats.LCK = 0;
      // Force to-hit to exactly 100 (see measureEffective's comment): a
      // Grandmaster damage-scaling delta is only exact when hit=100.
      weapon.components.set('hit', 1000); // saturate past any terrain/avoid penalty

      // General gives Bone the "Armor" tag so the effective component fires,
      // and an Iron_Axe creates a Sword-beats-Axe weapon-triangle advantage.
      bone.klass = 'General';
      bone.tags = [];
      bone.skills = [];
      bone.stats.SPD = 0;
      bone.stats.LCK = 0;

      const BONE_HP = 999;

      function setBoneWeapon(nid: string | null): void {
        bone.items = [];
        bone.equippedWeapon = null;
        if (nid) {
          h.giveItem('Bone', nid);
          const it = bone.items.find((i: any) => i.nid === nid);
          if (it) {
            bone.equippedWeapon = it;
            it.uses = 99;
            it.maxUses = 99;
          }
        }
      }

      function clearEffective(): void {
        weapon.components.delete('effective_damage');
      }

      function run(): number | null {
        eirika.currentHp = eirika.stats.HP;
        eirika.dead = false;
        eirika.finished = false;
        eirika.hasAttacked = false;
        bone.currentHp = BONE_HP;
        bone.dead = false;
        weapon.uses = 99;
        weapon.maxUses = 99;
        const r = h.resolveCombat('Eirika', 'Bone');
        if (!r) return null;
        return BONE_HP - r.defenderHp;
      }

      // Baseline with no defender weapon: weapon triangle contributes 0.
      setBoneWeapon(null);
      clearEffective();
      const baseNone = run();

      // Baseline with Iron_Axe: Sword advantage damage applies.
      setBoneWeapon('Iron_Axe');
      clearEffective();
      const baseAxe = run();
      const wtDmgBonus = baseAxe != null && baseNone != null ? baseAxe - baseNone : 0;

      // Effective might = item damage only (weapon_effectiveness_multiplied = false).
      clearEffective();
      weapon.components.set('effective_damage', {
        effective_tags: ['Armor'],
        effective_multiplier: 3,
        effective_bonus_damage: 0,
        weapon_effectiveness_multiplied: false,
      });
      const effNonMult = run();

      // Effective might = item damage + weapon-triangle damage advantage.
      clearEffective();
      weapon.components.set('effective_damage', {
        effective_tags: ['Armor'],
        effective_multiplier: 3,
        effective_bonus_damage: 0,
        weapon_effectiveness_multiplied: true,
      });
      const effMult = run();

      if (effNonMult == null || effMult == null || baseAxe == null) return null;
      const nonMultBonus = effNonMult - baseAxe;
      const multBonus = effMult - baseAxe;
      return {
        wtDmgBonus,
        itemDamage: weapon.getDamage(),
        nonMultBonus,
        multBonus,
        foldDiff: multBonus - nonMultBonus,
      };
    });

    expect(result).not.toBeNull();
    // Sword vs Axe yields a positive weapon-triangle damage advantage.
    expect(result!.wtDmgBonus).toBeGreaterThan(0);
    // Without folding, the bonus is (3 - 1) * itemDamage.
    expect(result!.nonMultBonus).toBe(2 * result!.itemDamage);
    // With folding, the weapon-triangle advantage is added to the might, so
    // the bonus grows by exactly (multiplier - 1) * wtDmgBonus = 2 * wtDmgBonus.
    expect(result!.foldDiff).toBe(2 * result!.wtDmgBonus);
  });
});
