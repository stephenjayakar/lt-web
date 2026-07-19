/**
 * Aura propagation and cleanup (P3 roadmap row).
 *
 * Mirrors lt-maker/app/engine/aura_funcs.py + the `Aura`/`AuraRange`/
 * `AuraTarget` skill components (status_components.py): a unit with an
 * `aura` skill component radiates a child skill to units within
 * `aura_range` tiles that match `aura_target` ('ally' | 'enemy' | 'unit').
 *
 * DEBUG level roster/positions (lt-maker/default.ltproj/game_data/levels/
 * DEBUG.json): Bone (enemy) [2,5], Eirika (player) [2,6], 103 (enemy)
 * [4,9], Seth (player) [5,4], Moulder (player) [1,2], Vanessa (player)
 * [2,2], 101 (player) [4,6].
 *
 * Inspiration (default.ltproj skills.json): aura -> Inspiration_child,
 * aura_range 3, aura_target ally.
 * TestEnemyAura (synthetic fixture appended to default.ltproj
 * skills.json for this spec): aura -> TestEnemyAura_child, aura_range 2,
 * aura_target enemy.
 *
 * Covers:
 *  - Holder radiates the child skill to allies in range only (not enemies,
 *    not out-of-range allies).
 *  - Moving a unit into/out of range grants/removes the child skill.
 *  - Holder death/removal clears the aura from everyone it was affecting.
 *  - An enemy-target aura affects enemies only (not allies).
 *  - Turnwheel undo of a (warp) move restores aura state.
 *  - Save/load round trip re-derives aura coverage.
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

async function addSkill(page: Page, unitNid: string, skillNid: string): Promise<boolean> {
  return page.evaluate(
    ({ unitNid, skillNid }) => (window as any).__harness.addSkill(unitNid, skillNid),
    { unitNid, skillNid },
  );
}

async function killUnit(page: Page, unitNid: string): Promise<boolean> {
  return page.evaluate((unitNid) => (window as any).__harness.killUnit(unitNid), unitNid);
}

async function warpUnit(page: Page, unitNid: string, x: number, y: number): Promise<boolean> {
  return page.evaluate(
    ({ unitNid, x, y }) => (window as any).__harness.warpUnit(unitNid, x, y),
    { unitNid, x, y },
  );
}

async function turnwheelUndo(page: Page): Promise<boolean> {
  return page.evaluate(() => (window as any).__harness.turnwheelUndo());
}

async function saveSnapshot(page: Page): Promise<any> {
  return page.evaluate(() => (window as any).__harness.saveSnapshot());
}

async function loadSnapshot(page: Page, snapshot: any): Promise<boolean> {
  return page.evaluate((snap) => (window as any).__harness.loadSnapshot(snap), snapshot);
}

test.describe('Aura propagation and cleanup', () => {
  test('holder radiates child skill to allies in range, not to enemies or out-of-range allies', async ({ page }) => {
    await page.goto('/?harness=true&level=DEBUG&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 5);

    // Eirika [2,6] gets Inspiration (range 3, ally-only).
    const granted = await addSkill(page, 'Eirika', 'Inspiration');
    expect(granted).toBe(true);
    await stepFrames(page, 2);

    // '101' [4,6] is an ally at distance 2 -> in range, should receive the child.
    const oneOhOne = await getUnitDetail(page, '101');
    expect(oneOhOne.skillNids).toContain('Inspiration_child');
    expect(oneOhOne.auraSourcedSkillNids).toContain('Inspiration_child');

    // Bone [2,5] is an enemy at distance 1 -> in range but wrong target filter.
    const bone = await getUnitDetail(page, 'Bone');
    expect(bone.skillNids).not.toContain('Inspiration_child');

    // Seth [5,4] is an ally at distance 5 -> out of range.
    const seth = await getUnitDetail(page, 'Seth');
    expect(seth.skillNids).not.toContain('Inspiration_child');

    // The holder itself never receives its own child skill.
    const eirika = await getUnitDetail(page, 'Eirika');
    expect(eirika.skillNids).not.toContain('Inspiration_child');
  });

  test('moving into and out of range grants and removes the child skill', async ({ page }) => {
    await page.goto('/?harness=true&level=DEBUG&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 5);

    await addSkill(page, 'Eirika', 'Inspiration'); // [2,6], range 3, ally
    await stepFrames(page, 2);

    // Seth starts at [5,4] (distance 5) -> out of range.
    let seth = await getUnitDetail(page, 'Seth');
    expect(seth.skillNids).not.toContain('Inspiration_child');

    // Warp Seth to [3,6] (distance 1) -> now in range.
    const warped = await warpUnit(page, 'Seth', 3, 6);
    expect(warped).toBe(true);
    await stepFrames(page, 2);

    seth = await getUnitDetail(page, 'Seth');
    expect(seth.skillNids).toContain('Inspiration_child');

    // Warp Seth back out to [5,4] -> loses the child skill again.
    await warpUnit(page, 'Seth', 5, 4);
    await stepFrames(page, 2);

    seth = await getUnitDetail(page, 'Seth');
    expect(seth.skillNids).not.toContain('Inspiration_child');
  });

  test('holder death/removal clears the aura from affected units', async ({ page }) => {
    await page.goto('/?harness=true&level=DEBUG&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 5);

    await addSkill(page, 'Eirika', 'Inspiration'); // [2,6], range 3, ally
    await stepFrames(page, 2);

    let oneOhOne = await getUnitDetail(page, '101');
    expect(oneOhOne.skillNids).toContain('Inspiration_child');

    const killed = await killUnit(page, 'Eirika');
    expect(killed).toBe(true);
    await stepFrames(page, 2);

    oneOhOne = await getUnitDetail(page, '101');
    expect(oneOhOne.skillNids).not.toContain('Inspiration_child');
  });

  test('enemy-target aura affects enemies only', async ({ page }) => {
    await page.goto('/?harness=true&level=DEBUG&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 5);

    // Eirika [2,6] gets a synthetic enemy-target aura (range 2).
    const granted = await addSkill(page, 'Eirika', 'TestEnemyAura');
    expect(granted).toBe(true);
    await stepFrames(page, 2);

    // Bone [2,5] is an enemy at distance 1 -> in range, should receive it.
    const bone = await getUnitDetail(page, 'Bone');
    expect(bone.skillNids).toContain('TestEnemyAura_child');

    // '101' [4,6] is an ally at distance 2 -> in range but wrong target filter.
    const oneOhOne = await getUnitDetail(page, '101');
    expect(oneOhOne.skillNids).not.toContain('TestEnemyAura_child');
  });

  test('turnwheel undo of a move restores aura state', async ({ page }) => {
    await page.goto('/?harness=true&level=DEBUG&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 5);

    await addSkill(page, 'Eirika', 'Inspiration'); // [2,6], range 3, ally
    await stepFrames(page, 2);

    let seth = await getUnitDetail(page, 'Seth');
    expect(seth.skillNids).not.toContain('Inspiration_child');

    // Warp Seth into range via a reversible action, confirm the aura applies.
    await warpUnit(page, 'Seth', 3, 6);
    await stepFrames(page, 2);
    seth = await getUnitDetail(page, 'Seth');
    expect(seth.position).toEqual([3, 6]);
    expect(seth.skillNids).toContain('Inspiration_child');

    // Undo the warp via the turnwheel -> Seth returns to his old position and
    // loses the aura-granted child skill again.
    const undone = await turnwheelUndo(page);
    expect(undone).toBe(true);
    await stepFrames(page, 2);

    seth = await getUnitDetail(page, 'Seth');
    expect(seth.position).toEqual([5, 4]);
    expect(seth.skillNids).not.toContain('Inspiration_child');
  });

  test('save/load round trip re-derives aura coverage', async ({ page }) => {
    await page.goto('/?harness=true&level=DEBUG&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 5);

    await addSkill(page, 'Eirika', 'Inspiration'); // [2,6], range 3, ally
    await stepFrames(page, 2);

    let oneOhOne = await getUnitDetail(page, '101');
    expect(oneOhOne.skillNids).toContain('Inspiration_child');

    const snapshot = await saveSnapshot(page);
    expect(snapshot).toBeTruthy();

    // Mutate state after the snapshot: move Eirika out of range of '101'.
    await warpUnit(page, 'Eirika', 9, 9);
    await stepFrames(page, 2);
    oneOhOne = await getUnitDetail(page, '101');
    expect(oneOhOne.skillNids).not.toContain('Inspiration_child');

    // Restore the snapshot -> Eirika is back at her saved position and '101'
    // has the aura-granted child skill re-derived fresh from live state.
    const loaded = await loadSnapshot(page, snapshot);
    expect(loaded).toBe(true);
    await stepFrames(page, 2);

    const eirika = await getUnitDetail(page, 'Eirika');
    expect(eirika.position).toEqual([2, 6]);

    oneOhOne = await getUnitDetail(page, '101');
    expect(oneOhOne.skillNids).toContain('Inspiration_child');
    expect(oneOhOne.auraSourcedSkillNids).toContain('Inspiration_child');
  });
});
