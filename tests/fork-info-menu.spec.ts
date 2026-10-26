/**
 * fork-info-menu.spec.ts: EOtF engine-fork layouts for the unit info menu
 * (info_menu_state.py / info_graph.py), the multi-page help boxes that
 * colour-tagged keywords add (AUX cycles them, `n/m` counter), INFO help on
 * item/skill `choice` entries (player_choice.py), and the fork's 10-stat
 * LevelScreen2 / 136px ExpBar (level_up.py). Default projects keep upstream.
 */
import { expect, test, type Page } from '@playwright/test';

test.describe.configure({ mode: 'parallel' });

const EOTF = '/?harness=true&project=eotf.ltproj&level=X&clean=true&bundle=false';
const DEFAULT = '/?harness=true&level=0&clean=true&bundle=false';

async function boot(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await page.waitForFunction(() => (window as any).__harness?.ready === true, undefined, { timeout: 90_000 });
}

async function step(page: Page, frames: number, input: string | null = null): Promise<void> {
  await page.evaluate(({ frames, input }) => (window as any).__harness.stepFrames(frames, input), { frames, input });
}

/** Open the info menu on EOtF's lead with a tagged weapon, an accessory, skills and 10 weapon types. */
async function openEotfInfo(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const g = (window as any).__gameRef;
    const { createItemTree } = await import('/src/objects/item.ts');
    const { SkillObject } = await import('/src/objects/skill.ts');
    const unit = [...g.units.values()].find((u: any) => u.team === 'player');
    unit.tags = [...unit.tags, 'Wyvern', 'Armor'];
    const klass = g.db.classes.get(unit.klass);
    klass.wexp_gain = { ...klass.wexp_gain };
    for (const w of ['Sword', 'Lance', 'Axe', 'Bow', 'Knife', 'Anima', 'Light', 'Dark', 'Staff', 'Stone']) {
      unit.wexp[w] = 40;
      klass.wexp_gain[w] = { usable: true, wexp_gain: 0, cap: 0 };
    }
    for (const nid of ['Dancing_Blade', 'Alert_Charm']) {
      const item = createItemTree(g.db.items.get(nid), (n: string) => g.db.items.get(n));
      item.owner = unit;
      unit.items.push(item);
    }
    for (const nid of ['Magictaker', 'Fatigue', 'Fatigue']) {
      const skill = new SkillObject(g.db.skills.get(nid));
      skill.owner = unit;
      unit.skills.push(skill);
    }
    g.infoMenuUnit = unit;
    g.memory.set('info_menu_state', 'personal_data');
    g.state.change('info_menu');
  });
  await step(page, 4);
}

const input = async (page: Page, event: string): Promise<void> => {
  await page.evaluate((e) => (window as any).__gameRef.state.getCurrentState().takeInput(e), event);
  await step(page, 16);
};

/** Registered info-menu boxes: aabb, page count and first-page text (HelpDialog name/lines). */
const registry = (page: Page, state: string) => page.evaluate((state) => {
  const s = (window as any).__gameRef.state.getCurrentState();
  return (s.registry.get(state) ?? []).map((bb: any) => {
    const made = bb.make();
    const pages = Array.isArray(made) ? made : [made];
    const first = pages[0];
    return { aabb: bb.aabb, pages: pages.length, text: [first.name ?? '', ...(first.lines ?? [])].join(' ') };
  });
}, state);

test('EOtF info menu follows the fork page layouts', async ({ page }, testInfo) => {
  await boot(page, EOTF);
  await openEotfInfo(page);

  // Page 1: TYPE row (Type_desc) replaces RAT; four pages even without notes.
  const personal = await registry(page, 'personal_data');
  expect(personal.some((bb) => bb.text.includes('typings'))).toBe(true);
  expect(personal.some((bb) => bb.text.includes('combat rating'))).toBe(false);
  // No class-skill strip on page 1 (its boxes sat at y >= 128).
  expect(personal.some((bb) => bb.aabb[1] >= 128 && bb.aabb[2] === 16)).toBe(false);
  await page.locator('canvas').screenshot({ path: testInfo.outputPath('fork-info-personal.png') });

  // Page 2: battle box at 108 with AS (not Rng) top right; accessory 4px lower.
  await input(page, 'RIGHT');
  expect(await page.evaluate(() => (window as any).__gameRef.state.getCurrentState().currentPage)).toBe(1);
  const equipment = await registry(page, 'equipment');
  const topRight = equipment.find((bb) => bb.aabb[0] === 96 + 78 && bb.aabb[1] === 108);
  expect(topRight?.text).toContain('Attack Speed');
  const itemRows = equipment.filter((bb) => bb.aabb[2] === 120).map((bb) => bb.aabb[1]);
  expect(itemRows).toEqual([24, 40, 3 * 16 + 28]);
  // Dancing Blade's description links Fettered (lore) and Canter (skill).
  const blade = equipment.find((bb) => bb.aabb[1] === 40);
  expect(blade?.pages).toBe(3);
  await page.locator('canvas').screenshot({ path: testInfo.outputPath('fork-info-equipment.png') });

  // Page 3: up to 10 weapon ranks, supports start below five rows.
  await input(page, 'RIGHT');
  const wexp = (await registry(page, 'support_skills')).filter((bb) => bb.text.includes('mastery level'));
  expect(wexp.length).toBe(10);
  expect(Math.max(...wexp.map((bb) => bb.aabb[1]))).toBe(24 + 4 + 64);
  await page.locator('canvas').screenshot({ path: testInfo.outputPath('fork-info-wexp.png') });

  // Page 4: class skills at y 36, other skills ("statuses") at y 108.
  await input(page, 'RIGHT');
  expect(await page.evaluate(() => (window as any).__gameRef.state.getCurrentState().currentPage)).toBe(3);
  const notes = await registry(page, 'notes');
  const skillRows = notes.filter((bb) => bb.aabb[2] === 16 && bb.aabb[3] === 16 && bb.aabb[0] >= 96);
  expect(skillRows.some((bb) => bb.aabb[1] === 36)).toBe(true);
  expect(skillRows.filter((bb) => bb.aabb[1] === 108).map((bb) => bb.aabb[0])).toEqual([98, 122]);
  await page.locator('canvas').screenshot({ path: testInfo.outputPath('fork-info-skills.png') });
  // RIGHT wraps back to page 1.
  await input(page, 'RIGHT');
  expect(await page.evaluate(() => (window as any).__gameRef.state.getCurrentState().currentPage)).toBe(0);
});

test('AUX cycles the linked help pages of an info-menu box', async ({ page }, testInfo) => {
  await boot(page, EOTF);
  await openEotfInfo(page);
  await input(page, 'RIGHT');
  await input(page, 'INFO');
  await input(page, 'DOWN');
  const state = () => page.evaluate(() => {
    const s = (window as any).__gameRef.state.getCurrentState();
    return { y: s.currentBB?.aabb[1], page: s.currentBB?.page, total: s.currentBB?.boxes?.length };
  });
  expect(await state()).toEqual({ y: 40, page: 0, total: 3 });
  await input(page, 'AUX');
  expect(await state()).toEqual({ y: 40, page: 1, total: 3 });
  await page.locator('canvas').screenshot({ path: testInfo.outputPath('fork-info-help-page2.png') });
  await input(page, 'AUX');
  await input(page, 'AUX');
  expect((await state()).page).toBe(0);
  // Moving to another box resets it to its first page.
  await input(page, 'AUX');
  await input(page, 'UP');
  await input(page, 'DOWN');
  expect(await state()).toEqual({ y: 40, page: 0, total: 3 });
});

test('INFO shows item/skill help on choice entries; AUX pages through links', async ({ page }, testInfo) => {
  await boot(page, EOTF);
  const run = async (nid: string, source: string[]): Promise<void> => {
    await page.evaluate(({ nid, source }) => {
      const g = (window as any).__gameRef;
      g.db.events.set(nid, {
        name: nid, nid, trigger: nid, level_nid: g.currentLevel?.nid ?? null,
        condition: 'True', only_once: false, priority: 0, _source: source,
      });
      g.eventManager.triggerSpecific(nid, { type: nid }, true);
      g.state.change('event');
    }, { nid, source });
    await step(page, 10);
  };
  const menu = () => page.evaluate(() => {
    const m = (window as any).__gameRef.state.getCurrentState().choiceMenu;
    return m ? { info: m.infoFlag, page: m.helpPage, pages: (m.cfg.helpBoxes ?? []).map((p: any[]) => p.length) } : null;
  });
  await run('item_choice', ['choice;picked;Buy?;Dancing_Blade,Vulnerary;EntryType=type_base_item']);
  expect(await menu()).toEqual({ info: false, page: 0, pages: [3, 1] });
  await step(page, 1, 'INFO');
  await step(page, 20);
  expect((await menu())?.info).toBe(true);
  await page.locator('canvas').screenshot({ path: testInfo.outputPath('fork-choice-item-help.png') });
  await step(page, 1, 'AUX');
  await step(page, 20);
  expect((await menu())?.page).toBe(1);
  await page.locator('canvas').screenshot({ path: testInfo.outputPath('fork-choice-item-help-page2.png') });
  // Moving the cursor resets the page; INFO hides the box again.
  await step(page, 1, 'DOWN');
  expect((await menu())?.page).toBe(0);
  await step(page, 1, 'INFO');
  expect((await menu())?.info).toBe(false);
  await step(page, 1, 'SELECT');
  await step(page, 5);
  expect(await page.evaluate(() => (window as any).__gameRef.gameVars.get('picked'))).toBe('Vulnerary');

  await run('skill_choice', ['choice;picked2;Learn?;Wounded;EntryType=type_skill']);
  expect((await menu())?.pages).toEqual([3]);
  await step(page, 1, 'INFO');
  expect((await menu())?.info).toBe(true);
  await step(page, 1, 'INFO');
  await step(page, 1, 'SELECT');
  await step(page, 5);
  // The fork has no help boxes for game-item choices.
  await run('game_item_choice', ['choice;picked3;Which?;1;EntryType=type_game_item']);
  expect((await menu())?.pages).toEqual([]);
});

test('EOtF level screen shows 10 stats in two columns of 5 on LevelScreen2; ExpBar is 136px', async ({ page }) => {
  await boot(page, EOTF);
  const result = await page.evaluate(async () => {
    const g = (window as any).__gameRef;
    const m = await import('/src/ui/exp-display.ts');
    await m.loadExpDisplaySprites();
    const unit = [...g.units.values()].find((u: any) => u.team === 'player');
    const screen: any = new m.LevelUpScreen(unit, {}, 1, 2, g.db.stats, null, null, 'Test', null);
    const bar: any = new m.ExpBar(10, true);
    return {
      stats: screen.statList.length, width: screen.width, height: screen.height,
      col2: screen.getPosition(5), col1last: screen.getPosition(4), bar: bar.width, inset: bar.numberInset,
    };
  });
  expect(result).toEqual({
    stats: 10, width: 133, height: 123, col2: [74, 35], col1last: [10, 4 * 16 + 35], bar: 136, inset: 4,
  });
});

test('default project keeps the upstream info menu, level screen and ExpBar', async ({ page }) => {
  await boot(page, DEFAULT);
  await page.evaluate(() => {
    const g = (window as any).__gameRef;
    g.infoMenuUnit = g.units.get('Eirika');
    g.memory.set('info_menu_state', 'personal_data');
    g.state.change('info_menu');
  });
  await step(page, 4);
  const personal = await registry(page, 'personal_data');
  expect(personal.some((bb) => bb.text.includes('typings'))).toBe(false);
  await input(page, 'RIGHT');
  const equipment = await registry(page, 'equipment');
  expect(equipment.some((bb) => bb.aabb[1] === 104 && bb.aabb[0] === 96 + 78)).toBe(true);
  const result = await page.evaluate(async () => {
    const g = (window as any).__gameRef;
    const m = await import('/src/ui/exp-display.ts');
    await m.loadExpDisplaySprites();
    const screen: any = new m.LevelUpScreen(g.units.get('Eirika'), {}, 1, 2, g.db.stats, null, null, 'Test', null);
    const bar: any = new m.ExpBar(10, true);
    return { stats: screen.statList.length, height: screen.height, col2: screen.getPosition(4)[1], bar: bar.width };
  });
  expect(result).toEqual({ stats: 8, height: 107, col2: 35, bar: 144 });
});
