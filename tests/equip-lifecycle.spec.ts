/**
 * Equipped-item lifecycle + equip-linked item component regressions.
 *
 * Covers:
 *  - Tracked equipped weapon/accessory state (equip/unequip/autoequip).
 *  - status_on_equip / multi_status_on_equip sourced skills (Runesword -> DarkOverride).
 *  - Removing the equipped item unequips and removes the sourced skill.
 *  - A natural same-NID skill survives equip/unequip cycles.
 *  - lifelink heals the attacker on hit (Nosferatu).
 *  - eclipse halves target HP and cannot double (no_double).
 *  - turnwheel undo/redo and save/load round trip for equip state + sourced skill.
 */

import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';

async function waitForHarness(page: Page): Promise<void> {
  await page.waitForFunction(() => !!(window as any).__harness?.ready, { timeout: 15000 });
}

async function stepFrames(page: Page, count: number, input?: string | null): Promise<void> {
  await page.evaluate(
    ({ count, input }) => (window as any).__harness.stepFrames(count, input ?? null),
    { count, input: input ?? null },
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

async function forceRngMode(page: Page, mode: string): Promise<void> {
  await page.evaluate((mode) => {
    (window as any).__harness?.setConstant('rng_mode', mode);
  }, mode);
}

test.describe('Equipped-item lifecycle & equip-linked components', () => {

  test('equipping Runesword adds DarkOverride sourced skill; unequipping removes it', async ({ page }) => {
    await page.goto('/?harness=true&level=DEBUG&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 5);

    const given = await giveItem(page, 'Eirika', 'Runesword');
    expect(given).toBe(true);

    await page.evaluate(() => {
      const eirika = (window as any).__gameRef?.units?.get?.('Eirika');
      if (eirika) eirika.wexp.Sword = Math.max(eirika.wexp.Sword ?? 0, 200);
    });

    const before = await getUnitDetail(page, 'Eirika');
    expect(before.itemSourcedSkillNids).not.toContain('DarkOverride');

    const equipped = await equipItem(page, 'Eirika', 'Runesword');
    expect(equipped).toBe(true);

    const after = await getUnitDetail(page, 'Eirika');
    expect(after.equippedWeaponNid).toBe('Runesword');
    expect(after.itemSourcedSkillNids).toContain('DarkOverride');
    expect(after.skillNids).toContain('DarkOverride');

    // Remove the Runesword from inventory -> unequip + skill removal.
    await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const eirika = g?.units?.get?.('Eirika');
      const runesword = eirika?.items?.find?.((i: any) => i.nid === 'Runesword');
      if (eirika && runesword) {
        const idx = eirika.items.indexOf(runesword);
        if (idx >= 0) eirika.items.splice(idx, 1);
        if (eirika.equippedWeapon === runesword) eirika.unequip(runesword);
        eirika.autoequip();
      }
    });

    const removed = await getUnitDetail(page, 'Eirika');
    expect(removed.itemSourcedSkillNids).not.toContain('DarkOverride');
  });

  test('a natural same-NID skill survives equip/unequip of an item granting it', async ({ page }) => {
    await page.goto('/?harness=true&level=DEBUG&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 5);

    await giveItem(page, 'Eirika', 'Runesword');
    await page.evaluate(() => {
      const eirika = (window as any).__gameRef?.units?.get?.('Eirika');
      if (eirika) eirika.wexp.Sword = Math.max(eirika.wexp.Sword ?? 0, 200);
    });

    // Grant a natural (non-item-sourced) DarkOverride skill.
    await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const eirika = g?.units?.get?.('Eirika');
      const prefab = g?.db?.skills?.get?.('DarkOverride');
      if (!eirika || !prefab) return;
      const skill = {
        nid: prefab.nid,
        name: prefab.name,
        desc: prefab.desc,
        components: new Map(prefab.components),
        data: new Map(),
        hasComponent(n: string) { return this.components.has(n); },
        getComponent(n: string) { return this.components.get(n); },
      };
      eirika.skills.push(skill);
    });

    const beforeEquip = await getUnitDetail(page, 'Eirika');
    const naturalCount = beforeEquip.skillNids.filter((s: string) => s === 'DarkOverride').length;
    expect(naturalCount).toBe(1);

    await equipItem(page, 'Eirika', 'Runesword');
    const afterEquip = await getUnitDetail(page, 'Eirika');
    expect(afterEquip.skillNids.filter((s: string) => s === 'DarkOverride').length).toBe(naturalCount + 1);

    // Remove the Runesword to force unequip.
    await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const eirika = g?.units?.get?.('Eirika');
      const runesword = eirika?.items?.find?.((i: any) => i.nid === 'Runesword');
      if (eirika && runesword) {
        const idx = eirika.items.indexOf(runesword);
        if (idx >= 0) eirika.items.splice(idx, 1);
        if (eirika.equippedWeapon === runesword) eirika.unequip(runesword);
        eirika.autoequip();
      }
    });

    const afterRemove = await getUnitDetail(page, 'Eirika');
    expect(afterRemove.skillNids.filter((s: string) => s === 'DarkOverride').length).toBe(naturalCount);
    expect(afterRemove.itemSourcedSkillNids).not.toContain('DarkOverride');
  });

  test('lifelink heals attacker on hit in map combat', async ({ page }) => {
    await page.goto('/?harness=true&level=DEBUG&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 5);
    await giveItem(page, 'Eirika', 'Nosferatu');
    await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const eirika = g?.units?.get?.('Eirika');
      const klass = g?.db?.classes?.get?.('Eirika_Lord');
      if (eirika && klass) {
        // Enable Dark weapon type for the test so Nosferatu is equippable.
        klass.wexp_gain.Dark = [true, 200, 251];
        eirika.wexp.Dark = 200;
      }
    });
    await equipItem(page, 'Eirika', 'Nosferatu');

    const eirikaDetail = await getUnitDetail(page, 'Eirika');
    await setUnitHp(page, 'Eirika', Math.max(1, Math.floor(eirikaDetail.maxHp / 2)));

    const boneDetail = await getUnitDetail(page, 'Bone');
    await setUnitHp(page, 'Bone', boneDetail.maxHp);

    await forceRngMode(page, 'grandmaster');

    const eirikaBefore = await getUnitDetail(page, 'Eirika');
    const result = await resolveCombat(page, 'Eirika', 'Bone');

    expect(result).not.toBeNull();
    expect(result.defenderHp).toBeLessThan(boneDetail.maxHp);
    // Lifelink 1.0: attacker heals by the damage dealt, clamped to maxHp.
    expect(result.attackerHp).toBeGreaterThanOrEqual(eirikaBefore.hp);
  });

  test('lifelink never heals overkill damage (per-strike HP clamp)', async ({ page }) => {
    await page.goto('/?harness=true&level=DEBUG&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 5);
    await giveItem(page, 'Eirika', 'Nosferatu');
    await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const eirika = g?.units?.get?.('Eirika');
      const klass = g?.db?.classes?.get?.('Eirika_Lord');
      if (eirika && klass) {
        klass.wexp_gain.Dark = [true, 200, 251];
        eirika.wexp.Dark = 200;
      }
    });
    await equipItem(page, 'Eirika', 'Nosferatu');

    await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const eirika = g?.units?.get?.('Eirika');
      const bone = g?.units?.get?.('Bone');
      if (!eirika || !bone) return;
      // Make Eirika's Nosferatu hit hard (magic damage = MAG + 10 - RES).
      eirika.stats.MAG = 20;
      eirika.stats.SKL = 0;
      // Strip Bone's weapons so it cannot counter; the heal is measured on
      // Eirika alone and any counter damage would muddy the assertion.
      bone.items = [];
      bone.equippedWeapon = null;
      bone.stats.RES = 0;
      // Tiny remaining HP so Eirika's strike massively overkills.
      bone.currentHp = 3;
      bone.dead = false;
      // Start Eirika well below max so the heal is observable and uncapped.
      eirika.currentHp = 5;
      eirika.dead = false;
    });

    await forceRngMode(page, 'grandmaster');

    const before = await getUnitDetail(page, 'Eirika');
    const result = await resolveCombat(page, 'Eirika', 'Bone');

    expect(result).not.toBeNull();
    expect(result.defenderHp).toBe(0);
    // Python clamps the per-strike heal to the target's remaining HP at strike
    // time: floor(min(damage, 3) * 1.0) = 3. Overkill damage (>> 3) never heals.
    expect(result.attackerHp - before.hp).toBe(3);
  });

  test('eclipse halves target HP and cannot double', async ({ page }) => {
    await page.goto('/?harness=true&level=DEBUG&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 5);
    await giveItem(page, 'Eirika', 'Eclipse');
    await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const eirika = g?.units?.get?.('Eirika');
      const klass = g?.db?.classes?.get?.('Eirika_Lord');
      if (eirika && klass) {
        klass.wexp_gain.Dark = [true, 200, 251];
        eirika.wexp.Dark = 200;
      }
    });
    await equipItem(page, 'Eirika', 'Eclipse');

    // Move Bone to (5,6) so distance from Eirika (2,6) is 3, within Eclipse range 3-10.
    await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const bone = g?.units?.get?.('Bone');
      if (g?.board && bone) {
        g.board.removeUnit(bone);
        g.board.setUnit(5, 6, bone);
        bone.position = [5, 6];
      }
    });

    const boneDetail = await getUnitDetail(page, 'Bone');
    await setUnitHp(page, 'Bone', boneDetail.maxHp);

    await forceRngMode(page, 'grandmaster');

    const result = await resolveCombat(page, 'Eirika', 'Bone');
    expect(result).not.toBeNull();

    const expectedDamage = Math.floor(boneDetail.maxHp / 2);
    expect(result.defenderHp).toBe(boneDetail.maxHp - expectedDamage);

    // no_double: exactly one strike total (no follow-up).
    expect(result.strikeCount).toBe(1);
  });

  test('turnwheel undo reverts an equip and its sourced skill', async ({ page }) => {
    await page.goto('/?harness=true&level=DEBUG&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 5);
    await giveItem(page, 'Eirika', 'Runesword');
    await page.evaluate(() => {
      const eirika = (window as any).__gameRef?.units?.get?.('Eirika');
      if (eirika) eirika.wexp.Sword = Math.max(eirika.wexp.Sword ?? 0, 200);
    });

    const before = await getUnitDetail(page, 'Eirika');
    const beforeWeapon = before.equippedWeaponNid;
    const beforeDarkOverride = before.skillNids.includes('DarkOverride');

    await equipItem(page, 'Eirika', 'Runesword');
    const after = await getUnitDetail(page, 'Eirika');
    expect(after.equippedWeaponNid).toBe('Runesword');
    expect(after.skillNids).toContain('DarkOverride');

    const undone = await turnwheelUndo(page);
    expect(undone).toBe(true);

    const restored = await getUnitDetail(page, 'Eirika');
    expect(restored.equippedWeaponNid).toBe(beforeWeapon);
    expect(restored.skillNids.includes('DarkOverride')).toBe(beforeDarkOverride);
  });

  test('save/load round trips equipped weapon and sourced skill', async ({ page }) => {
    await page.goto('/?harness=true&level=DEBUG&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 5);

    await giveItem(page, 'Eirika', 'Runesword');
    await page.evaluate(() => {
      const eirika = (window as any).__gameRef?.units?.get?.('Eirika');
      if (eirika) eirika.wexp.Sword = Math.max(eirika.wexp.Sword ?? 0, 200);
    });
    await equipItem(page, 'Eirika', 'Runesword');

    const before = await getUnitDetail(page, 'Eirika');
    expect(before.equippedWeaponNid).toBe('Runesword');
    expect(before.itemSourcedSkillNids).toContain('DarkOverride');

    const snapshot = await saveSnapshot(page);

    await page.evaluate(() => {
      const eirika = (window as any).__gameRef?.units?.get?.('Eirika');
      const runesword = eirika?.items?.find?.((i: any) => i.nid === 'Runesword');
      if (eirika && runesword) {
        const idx = eirika.items.indexOf(runesword);
        if (idx >= 0) eirika.items.splice(idx, 1);
        if (eirika.equippedWeapon === runesword) eirika.unequip(runesword);
        eirika.autoequip();
      }
    });
    const mutated = await getUnitDetail(page, 'Eirika');
    expect(mutated.itemSourcedSkillNids).not.toContain('DarkOverride');

    const loaded = await loadSnapshot(page, snapshot);
    expect(loaded).toBe(true);
    await stepFrames(page, 2);

    const restored = await getUnitDetail(page, 'Eirika');
    expect(restored.equippedWeaponNid).toBe('Runesword');
    expect(restored.itemSourcedSkillNids).toContain('DarkOverride');
  });
});
