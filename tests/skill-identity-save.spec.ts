/**
 * Skill identity save-field parity (docs/parity/runtime-inventory.md §4, gap #3).
 *
 * Verifies that distinct SkillObject instances survive save/load with identity
 * preserved — mirroring Python's per-instance `uid` / `owner_nid` /
 * `initiator_nid` / `subskill` persistence and the skill_registry keyed by uid.
 *
 * Covers:
 *  - Two units each holding a same-NID skill with different per-instance data
 *    remain distinct instances after save/load (no NID dedupe collapse).
 *  - Item-sourced skill (Runesword -> DarkOverride) reconnects to the restored
 *    ItemObject so mutating the item's `uses` is observable through the skill.
 *  - initiatorNid round-trips for a granted skill.
 *  - A natural same-NID skill plus an item-sourced same-NID skill on ONE unit
 *    survive together with their source tags intact.
 *  - Legacy save (no skillKey / skillCounter / uid / itemSourceKey) still loads
 *    via the re-derivation fallback.
 */

import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';

async function waitForHarness(page: Page): Promise<void> {
  await page.waitForFunction(() => !!(window as any).__harness?.ready, { timeout: 15000 });
}

async function stepFrames(page: Page, count: number): Promise<void> {
  await page.evaluate((count) => (window as any).__harness.stepFrames(count, null), count);
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

async function saveSnapshot(page: Page): Promise<any> {
  return page.evaluate(() => (window as any).__harness.saveSnapshot());
}

async function loadSnapshot(page: Page, snapshot: any): Promise<boolean> {
  return page.evaluate((snap) => (window as any).__harness.loadSnapshot(snap), snapshot);
}

/**
 * Read every skill instance on a unit with its per-instance uid, nid,
 * initiatorNid, item-source flag, and a snapshot of the data map.
 */
async function getSkillInstances(
  page: Page,
  unitNid: string,
): Promise<Array<{
  uid: number;
  nid: string;
  initiatorNid: string | null;
  itemSourced: boolean;
  data: Array<[string, any]>;
}>> {
  return page.evaluate((unitNid) => {
    const unit = (window as any).__gameRef?.units?.get?.(unitNid);
    if (!unit) return [];
    return unit.skills.map((s: any) => ({
      uid: s.uid,
      nid: s.nid,
      initiatorNid: s.initiatorNid ?? null,
      itemSourced: s.data?.get?.('itemSourceType') === 'item',
      data: Array.from(s.data.entries()) as Array<[string, any]>,
    }));
  }, unitNid);
}

/** Grant a real SkillObject instance (via DB prefab) with custom data + initiator. */
async function grantSkillInstance(
  page: Page,
  unitNid: string,
  skillNid: string,
  dataEntries: Array<[string, any]>,
  initiatorNid: string | null,
): Promise<void> {
  await page.evaluate(
    ({ unitNid, skillNid, dataEntries, initiatorNid }) => {
      const g = (window as any).__gameRef;
      const unit = g?.units?.get?.(unitNid);
      const prefab = g?.db?.skills?.get?.(skillNid);
      if (!unit || !prefab) return;
      // Use the real SkillObject constructor so uid is assigned.
      const SkillObject = (window as any).__SkillObjectCtor;
      const skill = SkillObject
        ? new SkillObject(prefab)
        : { nid: prefab.nid, name: prefab.name, desc: prefab.desc, components: new Map(prefab.components), data: new Map(), initiatorNid: null, hasComponent(n: string) { return this.components.has(n); }, getComponent(n: string) { return this.components.get(n); } };
      for (const [k, v] of dataEntries) skill.data.set(k, v);
      skill.initiatorNid = initiatorNid;
      unit.skills.push(skill);
    },
    { unitNid, skillNid, dataEntries, initiatorNid },
  );
}

/** Resolve the live ItemObject held by a unit (by item NID) and read its uses. */
async function getItemUses(page: Page, unitNid: string, itemNid: string): Promise<number | null> {
  return page.evaluate(
    ({ unitNid, itemNid }) => {
      const unit = (window as any).__gameRef?.units?.get?.(unitNid);
      const item = unit?.items?.find?.((i: any) => i.nid === itemNid);
      return item ? item.uses : null;
    },
    { unitNid, itemNid },
  );
}

/** Mutate the restored item's uses in place and confirm the skill's itemSource reflects it. */
async function mutateItemUsesAndReadSkillSource(
  page: Page,
  unitNid: string,
  itemNid: string,
  newUses: number,
  skillUid: number,
): Promise<{ itemUses: number; skillSourceUses: number | null }> {
  return page.evaluate(
    ({ unitNid, itemNid, newUses, skillUid }) => {
      const unit = (window as any).__gameRef?.units?.get?.(unitNid);
      const item = unit?.items?.find?.((i: any) => i.nid === itemNid);
      if (item) item.uses = newUses;
      const skill = unit?.skills?.find?.((s: any) => s.uid === skillUid);
      const src = skill?.data?.get?.('itemSource');
      return {
        itemUses: item ? item.uses : null,
        skillSourceUses: src ? src.uses : null,
      };
    },
    { unitNid, itemNid, newUses, skillUid },
  );
}

test.describe('Skill identity save-field parity', () => {

  test('two units with same-NID skills and different data survive save/load as distinct instances', async ({ page }) => {
    await page.goto('/?harness=true&level=DEBUG&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 5);

    // Expose the real SkillObject constructor so grantSkillInstance uses it.
    await page.evaluate(() => {
      const g = (window as any).__gameRef;
      // SkillObject isn't on window by default; pull it via the dynamic import path
      // used by the engine. Fall back to a synthetic shape if unavailable.
      (window as any).__SkillObjectCtor = null;
      import('/src/objects/skill.ts').then((m: any) => {
        (window as any).__SkillObjectCtor = m.SkillObject;
      }).catch(() => {});
    });
    await stepFrames(page, 2);

    // Grant Eirika and Seth each a Pavise instance with distinct per-instance data.
    await grantSkillInstance(page, 'Eirika', 'Pavise', [['counter', 1]], 'Eirika');
    await grantSkillInstance(page, 'Seth', 'Pavise', [['counter', 99]], 'Seth');

    const eirikaBefore = await getSkillInstances(page, 'Eirika');
    const sethBefore = await getSkillInstances(page, 'Seth');
    const eirikaPavise = eirikaBefore.find(s => s.nid === 'Pavise');
    const sethPavise = sethBefore.find(s => s.nid === 'Pavise');
    expect(eirikaPavise).toBeTruthy();
    expect(sethPavise).toBeTruthy();
    expect(eirikaPavise!.uid).not.toBe(sethPavise!.uid);
    expect(eirikaPavise!.data.find(([k]) => k === 'counter')?.[1]).toBe(1);
    expect(sethPavise!.data.find(([k]) => k === 'counter')?.[1]).toBe(99);

    const snapshot = await saveSnapshot(page);

    // Mutate runtime state so the load is observable.
    await page.evaluate(() => {
      const g = (window as any).__gameRef;
      for (const u of g.units.values()) u.skills = u.skills.filter((s: any) => s.nid !== 'Pavise');
    });

    const loaded = await loadSnapshot(page, snapshot);
    expect(loaded).toBe(true);
    await stepFrames(page, 2);

    const eirikaAfter = await getSkillInstances(page, 'Eirika');
    const sethAfter = await getSkillInstances(page, 'Seth');
    const eirikaPaviseAfter = eirikaAfter.find(s => s.nid === 'Pavise');
    const sethPaviseAfter = sethAfter.find(s => s.nid === 'Pavise');
    expect(eirikaPaviseAfter).toBeTruthy();
    expect(sethPaviseAfter).toBeTruthy();
    // Distinct uids preserved (identity, not NID dedupe).
    expect(eirikaPaviseAfter!.uid).toBe(eirikaPavise!.uid);
    expect(sethPaviseAfter!.uid).toBe(sethPavise!.uid);
    expect(eirikaPaviseAfter!.uid).not.toBe(sethPaviseAfter!.uid);
    // Per-instance data preserved.
    expect(eirikaPaviseAfter!.data.find(([k]) => k === 'counter')?.[1]).toBe(1);
    expect(sethPaviseAfter!.data.find(([k]) => k === 'counter')?.[1]).toBe(99);
  });

  test('item-sourced skill reconnects to the restored item instance (mutation visible through skill)', async ({ page }) => {
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
    expect(before.itemSourcedSkillNids).toContain('DarkOverride');

    const skillsBefore = await getSkillInstances(page, 'Eirika');
    const darkOverrideBefore = skillsBefore.find(s => s.nid === 'DarkOverride' && s.itemSourced);
    expect(darkOverrideBefore).toBeTruthy();
    const usesBefore = await getItemUses(page, 'Eirika', 'Runesword');

    const snapshot = await saveSnapshot(page);

    // Wipe runtime state.
    await page.evaluate(() => {
      const g = (window as any).__gameRef;
      g.units.clear();
    });

    const loaded = await loadSnapshot(page, snapshot);
    expect(loaded).toBe(true);
    await stepFrames(page, 2);

    const skillsAfter = await getSkillInstances(page, 'Eirika');
    const darkOverrideAfter = skillsAfter.find(s => s.nid === 'DarkOverride' && s.itemSourced);
    expect(darkOverrideAfter).toBeTruthy();
    // Per-instance uid preserved across save/load.
    expect(darkOverrideAfter!.uid).toBe(darkOverrideBefore!.uid);

    // Mutate the restored Runesword's uses; the DarkOverride skill's itemSource
    // reference must point at the SAME object, so the change is visible.
    const probe = await mutateItemUsesAndReadSkillSource(
      page, 'Eirika', 'Runesword', (usesBefore ?? 0) + 5, darkOverrideAfter!.uid,
    );
    expect(probe.itemUses).toBe((usesBefore ?? 0) + 5);
    expect(probe.skillSourceUses).toBe(probe.itemUses);
  });

  test('initiatorNid round-trips for a granted skill', async ({ page }) => {
    await page.goto('/?harness=true&level=DEBUG&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 5);

    await page.evaluate(() => {
      (window as any).__SkillObjectCtor = null;
      import('/src/objects/skill.ts').then((m: any) => {
        (window as any).__SkillObjectCtor = m.SkillObject;
      }).catch(() => {});
    });
    await stepFrames(page, 2);

    // Grant Eirika a Pavise with initiator = Seth.
    await grantSkillInstance(page, 'Eirika', 'Pavise', [], 'Seth');

    const before = await getSkillInstances(page, 'Eirika');
    const pavise = before.find(s => s.nid === 'Pavise');
    expect(pavise?.initiatorNid).toBe('Seth');

    const snapshot = await saveSnapshot(page);
    await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const eirika = g.units.get('Eirika');
      if (eirika) eirika.skills = eirika.skills.filter((s: any) => s.nid !== 'Pavise');
    });

    const loaded = await loadSnapshot(page, snapshot);
    expect(loaded).toBe(true);
    await stepFrames(page, 2);

    const after = await getSkillInstances(page, 'Eirika');
    const paviseAfter = after.find(s => s.nid === 'Pavise');
    expect(paviseAfter?.initiatorNid).toBe('Seth');
  });

  test('duplicate same-NID sourced + natural skill on one unit survives with correct sources', async ({ page }) => {
    await page.goto('/?harness=true&level=DEBUG&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 5);

    // Natural DarkOverride first.
    await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const eirika = g?.units?.get?.('Eirika');
      const prefab = g?.db?.skills?.get?.('DarkOverride');
      if (!eirika || !prefab) return;
      import('/src/objects/skill.ts').then((m: any) => {
        const skill = new m.SkillObject(prefab);
        eirika.skills.push(skill);
      }).catch(() => {});
    });
    await stepFrames(page, 2);

    // Item-sourced DarkOverride via Runesword equip.
    await giveItem(page, 'Eirika', 'Runesword');
    await page.evaluate(() => {
      const eirika = (window as any).__gameRef?.units?.get?.('Eirika');
      if (eirika) eirika.wexp.Sword = Math.max(eirika.wexp.Sword ?? 0, 200);
    });
    await equipItem(page, 'Eirika', 'Runesword');

    const before = await getSkillInstances(page, 'Eirika');
    const darkOverrides = before.filter(s => s.nid === 'DarkOverride');
    expect(darkOverrides.length).toBe(2);
    const natural = darkOverrides.find(s => !s.itemSourced);
    const sourced = darkOverrides.find(s => s.itemSourced);
    expect(natural).toBeTruthy();
    expect(sourced).toBeTruthy();
    expect(natural!.uid).not.toBe(sourced!.uid);

    const snapshot = await saveSnapshot(page);

    // Wipe and reload.
    await page.evaluate(() => {
      const g = (window as any).__gameRef;
      g.units.clear();
    });

    const loaded = await loadSnapshot(page, snapshot);
    expect(loaded).toBe(true);
    await stepFrames(page, 2);

    const after = await getSkillInstances(page, 'Eirika');
    const darkOverridesAfter = after.filter(s => s.nid === 'DarkOverride');
    expect(darkOverridesAfter.length).toBe(2);
    const naturalAfter = darkOverridesAfter.find(s => !s.itemSourced);
    const sourcedAfter = darkOverridesAfter.find(s => s.itemSourced);
    expect(naturalAfter).toBeTruthy();
    expect(sourcedAfter).toBeTruthy();
    // Per-instance uids preserved.
    expect(naturalAfter!.uid).toBe(natural!.uid);
    expect(sourcedAfter!.uid).toBe(sourced!.uid);
    // Sourced skill's itemSource reconnected (it has the itemSourceType tag).
    expect(sourcedAfter!.data.some(([k, v]) => k === 'itemSourceType' && v === 'item')).toBe(true);
  });

  test('legacy save (no skillKey/uid/skillCounter/itemSourceKey) still loads via re-derivation fallback', async ({ page }) => {
    await page.goto('/?harness=true&level=DEBUG&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 5);

    // Set up an item-sourced skill (Runesword -> DarkOverride).
    await giveItem(page, 'Eirika', 'Runesword');
    await page.evaluate(() => {
      const eirika = (window as any).__gameRef?.units?.get?.('Eirika');
      if (eirika) eirika.wexp.Sword = Math.max(eirika.wexp.Sword ?? 0, 200);
    });
    await equipItem(page, 'Eirika', 'Runesword');
    const before = await getUnitDetail(page, 'Eirika');
    expect(before.itemSourcedSkillNids).toContain('DarkOverride');

    // Build a new-format snapshot, then strip the new-format skill fields to
    // simulate a legacy save: no skillCounter, no skillKey on SkillSaveData,
    // no itemSourceKey, no uid, and unit.skillInstances without skillKey.
    const snapshot = await saveSnapshot(page);
    const legacy = JSON.parse(JSON.stringify(snapshot)) as any;
    delete legacy.skillCounter;
    for (const sk of legacy.skills) {
      delete sk.skillKey;
      delete sk.uid;
      delete sk.itemSourceKey;
      delete sk.ownerNid;
      delete sk.initiatorNid;
    }
    for (const u of legacy.units) {
      if (u.skillInstances) {
        for (const si of u.skillInstances) {
          delete si.skillKey;
        }
      }
    }

    // Wipe runtime state.
    await page.evaluate(() => {
      const g = (window as any).__gameRef;
      g.units.clear();
    });

    const loaded = await loadSnapshot(page, legacy);
    expect(loaded).toBe(true);
    await stepFrames(page, 2);

    // Legacy fallback re-derives item-sourced skills from equipped items.
    const after = await getUnitDetail(page, 'Eirika');
    expect(after.equippedWeaponNid).toBe('Runesword');
    expect(after.itemSourcedSkillNids).toContain('DarkOverride');
    expect(after.skillNids).toContain('DarkOverride');
  });
});
