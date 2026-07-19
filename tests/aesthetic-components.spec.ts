/**
 * Aesthetic combat-feedback item component parity tests.
 *
 * Covers (Python `app/engine/item_components/aesthetic_components.py`):
 *  - map_hit_add_blend / map_hit_sub_blend: color tint flash on the target
 *    when hit in map combat (`on_hit` -> playback UnitTintAdd/UnitTintSub).
 *  - map_cast_pose: the caster stands and casts instead of lunging.
 *  - no_map_hp_display: suppresses the HP bar/drain display for this item use.
 *  - map_cast_sfx: plays a sound once per item use, hit or miss.
 *  - warning: yellow marker over an enemy the item is dangerous against
 *    (target_icon), approximated via `computeTargetIcon`.
 *
 * These are observed through `MapCombat` presentation state and the harness'
 * `resolveCombatAesthetics`/`computeTargetIcon` hooks rather than pixels,
 * matching the pattern used by effective-damage.spec.ts.
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

/** Set up Eirika with a fresh weapon (given extra components) vs. Bone, and
 * resolve combat once with grandmaster RNG (guaranteed hit) for deterministic
 * on_hit playback. Returns the aesthetics summary from the harness. */
async function resolveAesthetics(
  page: Page,
  itemNid: string,
  extraComponents: Array<[string, unknown]>,
): Promise<any> {
  return page.evaluate(({ itemNid, extraComponents }) => {
    const g = (window as any).__gameRef;
    const h = (window as any).__harness;
    const eirika = g?.units?.get?.('Eirika');
    const bone = g?.units?.get?.('Bone');
    if (!eirika || !bone) return null;

    h.setConstant('rng_mode', 'grandmaster');

    h.giveItem('Eirika', itemNid);
    const weapon = eirika.items.find((i: any) => i.nid === itemNid);
    if (!weapon) return null;
    for (const [k, v] of extraComponents) weapon.components.set(k, v);
    weapon.uses = 99;
    weapon.maxUses = 99;
    eirika.equippedWeapon = weapon;
    eirika.wexp.Sword = Math.max(eirika.wexp?.Sword ?? 0, 200);

    bone.currentHp = 999;
    bone.dead = false;
    bone.items = [];
    bone.equippedWeapon = null;

    eirika.currentHp = eirika.stats.HP;
    eirika.dead = false;
    eirika.finished = false;
    eirika.hasAttacked = false;

    return h.resolveCombatAesthetics('Eirika', 'Bone');
  }, { itemNid, extraComponents });
}

test.describe('aesthetic item components', () => {
  test('map_hit_add_blend records an additive tint on the target', async ({ page }) => {
    await page.goto('/?harness=true&level=DEBUG&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 5);

    const r = await resolveAesthetics(page, 'Iron_Sword', [
      ['map_hit_add_blend', [224, 96, 0]],
    ]);
    expect(r).not.toBeNull();
    expect(r.defenderTint).not.toBeNull();
    expect(r.defenderTint.mode).toBe('add');
    expect(r.defenderTint.color).toEqual([224, 96, 0]);
  });

  test('map_hit_sub_blend records a subtractive tint on the target', async ({ page }) => {
    await page.goto('/?harness=true&level=DEBUG&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 5);

    const r = await resolveAesthetics(page, 'Iron_Sword', [
      ['map_hit_sub_blend', [40, 40, 40]],
    ]);
    expect(r).not.toBeNull();
    expect(r.defenderTint).not.toBeNull();
    expect(r.defenderTint.mode).toBe('sub');
    expect(r.defenderTint.color).toEqual([40, 40, 40]);
  });

  test('an item with neither blend component records no tint', async ({ page }) => {
    await page.goto('/?harness=true&level=DEBUG&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 5);

    const r = await resolveAesthetics(page, 'Iron_Sword', []);
    expect(r).not.toBeNull();
    expect(r.defenderTint).toBeNull();
  });

  test('map_cast_pose is reported for the attacking item', async ({ page }) => {
    await page.goto('/?harness=true&level=DEBUG&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 5);

    const withPose = await resolveAesthetics(page, 'Iron_Sword', [['map_cast_pose', true]]);
    expect(withPose.attackerCastPose).toBe(true);

    const withoutPose = await resolveAesthetics(page, 'Iron_Sword', []);
    expect(withoutPose.attackerCastPose).toBe(false);
  });

  test('no_map_hp_display suppresses the HP display flag', async ({ page }) => {
    await page.goto('/?harness=true&level=DEBUG&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 5);

    const suppressed = await resolveAesthetics(page, 'Iron_Sword', [['no_map_hp_display', true]]);
    expect(suppressed.noMapHpDisplay).toBe(true);

    const shown = await resolveAesthetics(page, 'Iron_Sword', []);
    expect(shown.noMapHpDisplay).toBe(false);
  });

  test('map_cast_sfx plays the configured sound once on cast', async ({ page }) => {
    await page.goto('/?harness=true&level=DEBUG&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 5);

    const r = await resolveAesthetics(page, 'Iron_Sword', [['map_cast_sfx', 'RefreshDanceMap']]);
    expect(r).not.toBeNull();
    expect(r.playedSfx).toContain('RefreshDanceMap');
    expect(r.playedSfx.filter((s: string) => s === 'RefreshDanceMap').length).toBe(1);
  });

  test('map_cast_anim value is recorded for the item use', async ({ page }) => {
    await page.goto('/?harness=true&level=DEBUG&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 5);

    const r = await resolveAesthetics(page, 'Iron_Sword', [['map_cast_anim', 'MapSpiritbane']]);
    expect(r.castAnimValue).toBe('MapSpiritbane');
  });

  test('warning marker appears over an enemy for a Killer weapon', async ({ page }) => {
    await page.goto('/?harness=true&level=DEBUG&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 5);

    const icon = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const h = (window as any).__harness;
      const eirika = g?.units?.get?.('Eirika');
      const bone = g?.units?.get?.('Bone');
      if (!eirika || !bone) return null;
      h.giveItem('Eirika', 'Killing_Edge');
      eirika.wexp.Sword = Math.max(eirika.wexp?.Sword ?? 0, 200);
      return h.computeTargetIcon('Eirika', 'Killing_Edge', 'Bone');
    });
    expect(icon).toBe('warning');
  });

  test('warning marker does not appear over a non-enemy target', async ({ page }) => {
    await page.goto('/?harness=true&level=DEBUG&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 5);

    const icon = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const h = (window as any).__harness;
      const eirika = g?.units?.get?.('Eirika');
      const seth = g?.units?.get?.('Seth');
      if (!eirika || !seth) return null;
      h.giveItem('Eirika', 'Killing_Edge');
      eirika.wexp.Sword = Math.max(eirika.wexp?.Sword ?? 0, 200);
      return h.computeTargetIcon('Eirika', 'Killing_Edge', 'Seth');
    });
    expect(icon).toBeNull();
  });

  test('no warning marker without the warning/eval_warning component', async ({ page }) => {
    await page.goto('/?harness=true&level=DEBUG&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 5);

    const icon = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const h = (window as any).__harness;
      const eirika = g?.units?.get?.('Eirika');
      const bone = g?.units?.get?.('Bone');
      if (!eirika || !bone) return null;
      h.giveItem('Eirika', 'Iron_Sword');
      return h.computeTargetIcon('Eirika', 'Iron_Sword', 'Bone');
    });
    expect(icon).toBeNull();
  });
});
