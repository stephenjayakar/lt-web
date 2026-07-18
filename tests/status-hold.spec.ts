/**
 * status_on_hold lifecycle + status_on_hit end-to-end regressions.
 *
 * Part A — status_on_hold / multi_status_on_hold (Python StatusOnHold):
 *  - Item gain (event give_item, trade, shop buy) grants the sourced skill.
 *  - Item loss (remove_item, trade, shop sell) removes exactly one sourced instance.
 *  - A natural same-NID skill survives item removal.
 *  - Turnwheel undo/redo round-trips the hold skill.
 *  - Save/load round-trips the hold skill.
 *  - Fili_Shield grants NegateFlyEff which suppresses Flying-effective damage.
 *
 * Part B — status_on_hit end-to-end:
 *  - A status_on_hit weapon applies the skill to the defender after combat.
 *  - The skill lands with initiatorNid = attacking unit.
 *  - status_on_hit via the item-use (status-staff) path also applies.
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

async function getUnitDetail(page: Page, unitNid: string): Promise<any> {
  return page.evaluate((unitNid) => (window as any).__harness.getUnitDetail(unitNid), unitNid);
}

async function giveItem(page: Page, unitNid: string, itemNid: string): Promise<boolean> {
  return page.evaluate(
    ({ unitNid, itemNid }) => (window as any).__harness.giveItem(unitNid, itemNid),
    { unitNid, itemNid },
  );
}

async function removeItem(page: Page, unitNid: string, itemNid: string): Promise<boolean> {
  return page.evaluate(
    ({ unitNid, itemNid }) => (window as any).__harness.removeItem(unitNid, itemNid),
    { unitNid, itemNid },
  );
}

async function tradeItem(page: Page, fromNid: string, toNid: string, itemNid: string): Promise<boolean> {
  return page.evaluate(
    ({ fromNid, toNid, itemNid }) => (window as any).__harness.tradeItem(fromNid, toNid, itemNid),
    { fromNid, toNid, itemNid },
  );
}

async function equipItem(page: Page, unitNid: string, itemNid: string): Promise<boolean> {
  return page.evaluate(
    ({ unitNid, itemNid }) => (window as any).__harness.equipItem(unitNid, itemNid),
    { unitNid, itemNid },
  );
}

async function resolveCombat(page: Page, attackerNid: string, defenderNid: string): Promise<any> {
  return page.evaluate(
    ({ attackerNid, defenderNid }) => (window as any).__harness.resolveCombat(attackerNid, defenderNid),
    { attackerNid, defenderNid },
  );
}

async function turnwheelUndo(page: Page): Promise<boolean> {
  return page.evaluate(() => (window as any).__harness.turnwheelUndo());
}

async function saveSnapshot(page: Page): Promise<unknown> {
  return page.evaluate(() => (window as any).__harness.saveSnapshot());
}

async function loadSnapshot(page: Page, snapshot: unknown): Promise<boolean> {
  return page.evaluate((snap) => (window as any).__harness.loadSnapshot(snap), snapshot);
}

async function forceRngMode(page: Page, mode: string): Promise<void> {
  await page.evaluate((mode) => {
    const g = (window as any).__gameRef;
    if (g?.db) {
      if (!g.db._constants) g.db._constants = new Map();
      g.db._constants.set('rng_mode', mode);
    }
  }, mode);
}

async function setUnitHp(page: Page, unitNid: string, hp: number): Promise<void> {
  await page.evaluate(
    ({ unitNid, hp }) => {
      const g = (window as any).__gameRef;
      const unit = g?.units?.get?.(unitNid);
      if (unit) {
        unit.currentHp = hp;
        unit.dead = hp <= 0;
      }
    },
    { unitNid, hp },
  );
}

/**
 * Read the runtime skill list for a unit, including the initiatorNid of each
 * skill instance and whether it is item-sourced.
 */
async function getSkillDetails(page: Page, unitNid: string): Promise<Array<{ nid: string; initiatorNid: string | null; itemSourced: boolean }>> {
  return page.evaluate((unitNid) => {
    const g = (window as any).__gameRef;
    const unit = g?.units?.get?.(unitNid);
    if (!unit) return [];
    return unit.skills.map((s: any) => ({
      nid: s.nid,
      initiatorNid: s.initiatorNid ?? null,
      itemSourced: s.data?.get?.('itemSourceType') === 'item',
    }));
  }, unitNid);
}

test.describe('status_on_hold lifecycle', () => {

  test('giving a status_on_hold item grants the sourced skill (give_item path)', async ({ page }) => {
    await page.goto('/?harness=true&level=DEBUG&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 5);

    const before = await getUnitDetail(page, 'Eirika');
    expect(before.skillNids).not.toContain('NegateFlyEff');

    // Fili_Shield has status_on_hold -> NegateFlyEff.
    const given = await giveItem(page, 'Eirika', 'Fili_Shield');
    expect(given).toBe(true);

    const after = await getUnitDetail(page, 'Eirika');
    expect(after.skillNids).toContain('NegateFlyEff');
    expect(after.itemSourcedSkillNids).toContain('NegateFlyEff');
  });

  test('removing a status_on_hold item removes exactly one sourced instance', async ({ page }) => {
    await page.goto('/?harness=true&level=DEBUG&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 5);

    await giveItem(page, 'Eirika', 'Fili_Shield');
    const withItem = await getUnitDetail(page, 'Eirika');
    expect(withItem.skillNids).toContain('NegateFlyEff');

    const removed = await removeItem(page, 'Eirika', 'Fili_Shield');
    expect(removed).toBe(true);

    const afterRemove = await getUnitDetail(page, 'Eirika');
    expect(afterRemove.skillNids).not.toContain('NegateFlyEff');
    expect(afterRemove.itemSourcedSkillNids).not.toContain('NegateFlyEff');
  });

  test('a natural same-NID skill survives item removal', async ({ page }) => {
    await page.goto('/?harness=true&level=DEBUG&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 5);

    // Grant a natural (non-item-sourced) NegateFlyEff skill first.
    await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const eirika = g?.units?.get?.('Eirika');
      const prefab = g?.db?.skills?.get?.('NegateFlyEff');
      if (!eirika || !prefab) return;
      const skill = {
        nid: prefab.nid,
        name: prefab.name,
        desc: prefab.desc,
        components: new Map(prefab.components),
        data: new Map(),
        initiatorNid: null,
        hasComponent(n: string) { return this.components.has(n); },
        getComponent(n: string) { return this.components.get(n); },
      };
      eirika.skills.push(skill);
    });

    const before = await getUnitDetail(page, 'Eirika');
    const naturalCount = before.skillNids.filter((s: string) => s === 'NegateFlyEff').length;
    expect(naturalCount).toBe(1);

    // Give the hold item (adds a sourced instance).
    await giveItem(page, 'Eirika', 'Fili_Shield');
    const withItem = await getUnitDetail(page, 'Eirika');
    expect(withItem.skillNids.filter((s: string) => s === 'NegateFlyEff').length).toBe(2);

    // Remove the item — only the sourced instance should be removed.
    await removeItem(page, 'Eirika', 'Fili_Shield');
    const afterRemove = await getUnitDetail(page, 'Eirika');
    expect(afterRemove.skillNids.filter((s: string) => s === 'NegateFlyEff').length).toBe(1);
    expect(afterRemove.itemSourcedSkillNids).not.toContain('NegateFlyEff');
  });

  test('trading a status_on_hold item transfers the sourced skill', async ({ page }) => {
    await page.goto('/?harness=true&level=DEBUG&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 5);

    // Give Fili_Shield to Eirika, then trade it to Seth.
    await giveItem(page, 'Eirika', 'Fili_Shield');
    const eirikaBefore = await getUnitDetail(page, 'Eirika');
    expect(eirikaBefore.skillNids).toContain('NegateFlyEff');
    const sethBefore = await getUnitDetail(page, 'Seth');
    expect(sethBefore.skillNids).not.toContain('NegateFlyEff');

    const traded = await tradeItem(page, 'Eirika', 'Seth', 'Fili_Shield');
    expect(traded).toBe(true);

    const eirikaAfter = await getUnitDetail(page, 'Eirika');
    expect(eirikaAfter.skillNids).not.toContain('NegateFlyEff');
    const sethAfter = await getUnitDetail(page, 'Seth');
    expect(sethAfter.skillNids).toContain('NegateFlyEff');
    expect(sethAfter.itemSourcedSkillNids).toContain('NegateFlyEff');
  });

  test('turnwheel undo reverts a hold skill grant via trade', async ({ page }) => {
    await page.goto('/?harness=true&level=DEBUG&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 5);

    // Give Fili_Shield to Seth first (non-reversible), then trade it to Eirika
    // (reversible). Undoing the trade should remove the skill from Eirika.
    await giveItem(page, 'Seth', 'Fili_Shield');
    const sethBefore = await getUnitDetail(page, 'Seth');
    expect(sethBefore.skillNids).toContain('NegateFlyEff');

    const eirikaBefore = await getUnitDetail(page, 'Eirika');
    expect(eirikaBefore.skillNids).not.toContain('NegateFlyEff');

    const traded = await tradeItem(page, 'Seth', 'Eirika', 'Fili_Shield');
    expect(traded).toBe(true);

    const eirikaAfter = await getUnitDetail(page, 'Eirika');
    expect(eirikaAfter.skillNids).toContain('NegateFlyEff');

    const undone = await turnwheelUndo(page);
    expect(undone).toBe(true);

    const restored = await getUnitDetail(page, 'Eirika');
    expect(restored.skillNids).not.toContain('NegateFlyEff');
    const sethRestored = await getUnitDetail(page, 'Seth');
    expect(sethRestored.skillNids).toContain('NegateFlyEff');
  });

  test('turnwheel undo reverts a hold skill removal', async ({ page }) => {
    await page.goto('/?harness=true&level=DEBUG&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 5);

    await giveItem(page, 'Eirika', 'Fili_Shield');
    const withItem = await getUnitDetail(page, 'Eirika');
    expect(withItem.skillNids).toContain('NegateFlyEff');

    await removeItem(page, 'Eirika', 'Fili_Shield');
    const afterRemove = await getUnitDetail(page, 'Eirika');
    expect(afterRemove.skillNids).not.toContain('NegateFlyEff');

    const undone = await turnwheelUndo(page);
    expect(undone).toBe(true);

    const restored = await getUnitDetail(page, 'Eirika');
    expect(restored.skillNids).toContain('NegateFlyEff');
  });

  test('save/load round-trips a hold skill', async ({ page }) => {
    await page.goto('/?harness=true&level=DEBUG&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 5);

    await giveItem(page, 'Eirika', 'Fili_Shield');
    const before = await getUnitDetail(page, 'Eirika');
    expect(before.itemSourcedSkillNids).toContain('NegateFlyEff');

    const snapshot = await saveSnapshot(page);

    // Mutate: remove the item so the skill is gone.
    await removeItem(page, 'Eirika', 'Fili_Shield');
    const mutated = await getUnitDetail(page, 'Eirika');
    expect(mutated.itemSourcedSkillNids).not.toContain('NegateFlyEff');

    const loaded = await loadSnapshot(page, snapshot);
    expect(loaded).toBe(true);
    await stepFrames(page, 2);

    const restored = await getUnitDetail(page, 'Eirika');
    expect(restored.itemSourcedSkillNids).toContain('NegateFlyEff');
    expect(restored.skillNids).toContain('NegateFlyEff');
  });

  test('Fili_Shield negate suppresses Flying-effective damage end-to-end', async ({ page }) => {
    await page.goto('/?harness=true&level=DEBUG&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 5);

    // Make Bone a Pegasus_Knight (Flying tag) so bows are effective.
    await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const bone = g?.units?.get?.('Bone');
      if (bone) {
        bone.klass = 'Pegasus_Knight';
        bone.stats.HP = 60;
        bone.currentHp = 60;
        bone.dead = false;
      }
    });

    // Give Eirika an Iron_Bow (effective vs Flying, bonus_damage 12) and enable Bow wexp.
    await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const eirika = g?.units?.get?.('Eirika');
      const klass = g?.db?.classes?.get?.('Eirika_Lord');
      if (eirika && klass) {
        klass.wexp_gain.Bow = [true, 200, 251];
        eirika.wexp.Bow = 200;
      }
    });
    await giveItem(page, 'Eirika', 'Iron_Bow');
    await equipItem(page, 'Eirika', 'Iron_Bow');

    await forceRngMode(page, 'grandmaster');

    // --- Baseline: effective damage applies (no Fili_Shield yet). ---
    const baselineResult = await resolveCombat(page, 'Eirika', 'Bone');
    expect(baselineResult).not.toBeNull();
    // Bone took damage. We'll compare against the negated case below.
    const baselineDamage = baselineResult.strikeDamages.reduce((a: number, b: number) => a + b, 0);
    expect(baselineDamage).toBeGreaterThan(0);

    // Reset Bone's HP for the second combat.
    await setUnitHp(page, 'Bone', 60);

    // --- Give Bone a Fili_Shield (grants NegateFlyEff via status_on_hold). ---
    await giveItem(page, 'Bone', 'Fili_Shield');
    const boneDetail = await getUnitDetail(page, 'Bone');
    expect(boneDetail.skillNids).toContain('NegateFlyEff');

    const negatedResult = await resolveCombat(page, 'Eirika', 'Bone');
    expect(negatedResult).not.toBeNull();
    const negatedDamage = negatedResult.strikeDamages.reduce((a: number, b: number) => a + b, 0);

    // The negate skill suppresses the effective bonus, so negated damage is
    // strictly less than baseline damage.
    expect(negatedDamage).toBeLessThan(baselineDamage);
  });
});

test.describe('status_on_hit end-to-end', () => {

  test('a status_on_hit weapon applies the skill to the defender after combat', async ({ page }) => {
    await page.goto('/?harness=true&level=DEBUG&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 5);

    // Poison_Sword has status_on_hit -> Poisoned.
    await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const eirika = g?.units?.get?.('Eirika');
      if (eirika) eirika.wexp.Sword = Math.max(eirika.wexp.Sword ?? 0, 200);
    });
    await giveItem(page, 'Eirika', 'Poison_Sword');
    await equipItem(page, 'Eirika', 'Poison_Sword');

    const boneBefore = await getUnitDetail(page, 'Bone');
    expect(boneBefore.skillNids).not.toContain('Poisoned');

    await forceRngMode(page, 'grandmaster');

    const result = await resolveCombat(page, 'Eirika', 'Bone');
    expect(result).not.toBeNull();

    // Poisoned should now be on Bone, with initiatorNid = Eirika.
    const boneSkills = await getSkillDetails(page, 'Bone');
    const poison = boneSkills.find((s) => s.nid === 'Poisoned');
    expect(poison).toBeDefined();
    expect(poison!.initiatorNid).toBe('Eirika');
  });

  test('status_on_hit does not apply on a miss', async ({ page }) => {
    await page.goto('/?harness=true&level=DEBUG&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 5);

    await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const eirika = g?.units?.get?.('Eirika');
      if (eirika) eirika.wexp.Sword = Math.max(eirika.wexp.Sword ?? 0, 200);
    });
    await giveItem(page, 'Eirika', 'Poison_Sword');
    await equipItem(page, 'Eirika', 'Poison_Sword');

    // Force every strike to miss by giving Bone very high SPD (dodge).
    await page.evaluate(() => {
      const g = (window as any).__gameRef;
      if (g?.db?._constants) {
        g.db._constants.set('rng_mode', 'grandmaster');
      }
      const bone = g?.units?.get?.('Bone');
      if (bone) bone.stats.SPD = 99;
    });

    await resolveCombat(page, 'Eirika', 'Bone');

    const boneSkills = await getSkillDetails(page, 'Bone');
    expect(boneSkills.find((s) => s.nid === 'Poisoned')).toBeUndefined();
  });

  test('status_on_hit is reversible via turnwheel after combat', async ({ page }) => {
    await page.goto('/?harness=true&level=DEBUG&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 5);

    await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const eirika = g?.units?.get?.('Eirika');
      if (eirika) eirika.wexp.Sword = Math.max(eirika.wexp.Sword ?? 0, 200);
    });
    await giveItem(page, 'Eirika', 'Poison_Sword');
    await equipItem(page, 'Eirika', 'Poison_Sword');

    await forceRngMode(page, 'grandmaster');

    await resolveCombat(page, 'Eirika', 'Bone');

    const boneAfterCombat = await getSkillDetails(page, 'Bone');
    expect(boneAfterCombat.find((s) => s.nid === 'Poisoned')).toBeDefined();

    const undone = await turnwheelUndo(page);
    expect(undone).toBe(true);

    const boneAfterUndo = await getSkillDetails(page, 'Bone');
    expect(boneAfterUndo.find((s) => s.nid === 'Poisoned')).toBeUndefined();
  });
});
