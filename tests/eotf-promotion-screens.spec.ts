/**
 * eotf-promotion-screens.spec.ts: promotion.py's PromotionChoiceState and
 * PromotionState (with the ExpState level screen) on EOtF data. A Knight
 * Crest on a level 10 Mercenary opens the full-screen class choice
 * (Hero / Ranger), Change plays Promotion1 on the Mercenary and Promotion2
 * on the Vanguard (Hero) animation, then the level screen. EOtF keeps the
 * level (promote_level_reset is False). Screenshots are attached.
 */
import { expect, test, type Page } from '@playwright/test';

test.describe.configure({ mode: 'parallel' });

async function boot(page: Page): Promise<void> {
  await page.goto('/?harness=true&project=eotf.ltproj&level=87&clean=true&bundle=false');
  await page.waitForFunction(() => (window as any).__harness?.ready === true, undefined, { timeout: 90_000 });
  // A clean level 87 has no player units, so every player phase auto-ends
  // within the frame its upkeep finishes (Python FreeState.begin). An
  // unfinished player unit keeps the next player phase in 'free'.
  await page.evaluate(() => {
    const game = (window as any).__gameRef;
    game.spawnUnit(game.db.units.get('Hetja'), 'player', [9, 5], 'None');
  });
  for (let i = 0; i < 80; i++) {
    await step(page, 10);
    if (await stateName(page) === 'free') break;
  }
  expect(await stateName(page)).toBe('free');
}

async function step(page: Page, frames: number, input: string | null = null): Promise<void> {
  await page.evaluate(({ frames, input }) => (window as any).__harness.stepFrames(frames, input), { frames, input });
}

const stateName = (page: Page) =>
  page.evaluate(() => (window as any).__gameRef.state.getCurrentState()?.name);

/** A level 10 Mercenary holding a Knight Crest, selected on the map. */
async function mercenary(page: Page): Promise<void> {
  await page.evaluate(() => {
    const game = (window as any).__gameRef;
    // boot's Hetja keeps the phase from ending once this unit waits.
    const unit = game.spawnUnit(game.db.units.get('Player'), 'player', [8, 3], 'None');
    const klass = game.db.classes.get('Mercenary');
    unit.klass = 'Mercenary';
    unit.level = 10;
    unit.exp = 50;
    unit.wexp = { Sword: 31 };
    unit.finished = false;
    unit.hasMoved = false;
    unit.hasAttacked = false;
    unit.items = [];
    unit.stats = { ...klass.bases };
    unit.currentHp = unit.stats.HP;
    void game.loadMapSpriteForUnit(unit);
    const { ItemObject } = (window as any).__itemModule;
    const crest = new ItemObject(game.db.items.get('Knight Crest'));
    crest.owner = unit;
    unit.items.push(crest);
    game.selectedUnit = unit;
    game.cursor.setPos(8, 3);
    (window as any).__promoUnit = unit;
    (window as any).__beforeStats = { ...unit.stats };
  });
}

async function runUntil(page: Page, done: () => Promise<boolean>, budgetMs = 20_000): Promise<void> {
  const end = Date.now() + budgetMs;
  while (Date.now() < end) {
    if (await done()) return;
    await step(page, 6);
    await page.waitForTimeout(30);
  }
  throw new Error('timed out');
}

test('a Knight Crest opens the promotion choice, animation and level screen', async ({ page }, testInfo) => {
  await boot(page);
  await page.evaluate(async () => {
    (window as any).__itemModule = await import('/src/objects/item.ts');
  });
  await mercenary(page);
  await page.evaluate(() => (window as any).__gameRef.state.change('item_use'));
  await step(page, 2);
  expect(await stateName(page)).toBe('item_use');
  await step(page, 1, 'SELECT');
  await step(page, 2);
  expect(await stateName(page)).toBe('item_targeting');
  await step(page, 1, 'SELECT');
  await step(page, 2);
  expect(await stateName(page)).toBe('promotion_choice');

  const choice = await page.evaluate(() => {
    const s = (window as any).__gameRef.state.getCurrentState();
    return { options: s.classOptions, offset: s.animOffset };
  });
  expect(choice.options).toEqual(['Hero', 'Ranger']);
  // The animation swoops in from 120 px.
  await runUntil(page, async () => (await page.evaluate(() =>
    (window as any).__gameRef.state.getCurrentState().animOffset)) === 0);
  await page.waitForTimeout(800);
  await step(page, 30);
  await page.locator('canvas').screenshot({ path: testInfo.outputPath('choice-hero.png') });

  // DOWN: Ranger swoops out and back in with its own description.
  await step(page, 1, 'DOWN');
  await step(page, 4);
  const moved = await page.evaluate(() => {
    const s = (window as any).__gameRef.state.getCurrentState();
    return { index: s.menu.currentIndex, offset: s.animOffset };
  });
  expect(moved.index).toBe(1);
  expect(moved.offset).toBeGreaterThan(0);
  await step(page, 40);
  await page.locator('canvas').screenshot({ path: testInfo.outputPath('choice-ranger.png') });
  await step(page, 1, 'UP');
  await step(page, 30);

  // BACK cannot leave the child menu without closing it first.
  await step(page, 1, 'SELECT');
  await step(page, 3);
  expect(await page.evaluate(() => !!(window as any).__gameRef.state.getCurrentState().childMenu)).toBe(true);
  await page.locator('canvas').screenshot({ path: testInfo.outputPath('choice-change-cancel.png') });
  await step(page, 1, 'SELECT');
  await step(page, 2);
  expect(await stateName(page)).toBe('promotion');

  // Nothing is applied until the level screen.
  expect(await page.evaluate(() => (window as any).__promoUnit.klass)).toBe('Mercenary');
  await step(page, 60);
  await page.waitForTimeout(500);
  await step(page, 2);
  const mid = await page.evaluate(() => (window as any).__gameRef.state.getCurrentState().phase);
  expect(['right', 'left']).toContain(mid);
  await page.locator('canvas').screenshot({ path: testInfo.outputPath('promotion-anim.png') });

  await runUntil(page, async () => (await page.evaluate(() =>
    (window as any).__gameRef.state.getCurrentState()?.phase)) === 'left');
  await step(page, 40);
  await page.waitForTimeout(400);
  await step(page, 1);
  await page.locator('canvas').screenshot({ path: testInfo.outputPath('promotion-anim-left.png') });
  await step(page, 60);
  await page.locator('canvas').screenshot({ path: testInfo.outputPath('promotion-anim-left-2.png') });
  await runUntil(page, async () => (await page.evaluate(() =>
    (window as any).__gameRef.state.getCurrentState()?.phase)) === 'level_screen');
  await page.waitForTimeout(1500);
  await step(page, 2);
  await page.locator('canvas').screenshot({ path: testInfo.outputPath('promotion-level-screen.png') });

  await runUntil(page, async () => await stateName(page) === 'free');
  const result = await page.evaluate(() => {
    const unit = (window as any).__promoUnit;
    return {
      klass: unit.klass,
      level: unit.level,
      exp: unit.exp,
      finished: unit.finished,
      crest: unit.items.some((item: any) => item.nid === 'Knight Crest'),
      gained: Object.keys(unit.stats).some((stat) => unit.stats[stat] !== (window as any).__beforeStats[stat]),
      wexp: { ...unit.wexp },
    };
  });
  expect(result.klass).toBe('Hero');
  expect(result.level).toBe(10); // EOtF: promote_level_reset is False
  expect(result.exp).toBe(50);
  expect(result.finished).toBe(true);
  expect(result.crest).toBe(false);
  expect(result.gained).toBe(true);
  // Hero's Axe rank is usable but starts at 0 wexp in EOtF.
  expect(result.wexp).toEqual({ Sword: 31 });

  // The whole use (crest, class, stats) is one turnwheel-reversible span.
  const undone = await page.evaluate(() => {
    const game = (window as any).__gameRef;
    const unit = (window as any).__promoUnit;
    let guard = 0;
    while (unit.klass !== 'Mercenary' && guard++ < 200) game.actionLog.runActionBackward();
    return { klass: unit.klass, crest: unit.items.some((item: any) => item.nid === 'Knight Crest') };
  });
  expect(undone).toEqual({ klass: 'Mercenary', crest: true });
});

test('BACK from the item promotion choice returns to the map without spending the crest', async ({ page }) => {
  await boot(page);
  await page.evaluate(async () => {
    (window as any).__itemModule = await import('/src/objects/item.ts');
  });
  await mercenary(page);
  await page.evaluate(() => (window as any).__gameRef.state.change('item_use'));
  await step(page, 2);
  await step(page, 1, 'SELECT');
  await step(page, 2);
  await step(page, 1, 'SELECT');
  await step(page, 2);
  expect(await stateName(page)).toBe('promotion_choice');
  await step(page, 1, 'BACK');
  await step(page, 2);
  // Python PromotionChoiceState BACK: game.state.back() to the map (the
  // item's combat had cleared to free), HasNotAttacked and reverse_use.
  expect(await stateName(page)).toBe('free');
  const unit = await page.evaluate(() => {
    const u = (window as any).__promoUnit;
    const crest = u.items.find((item: any) => item.nid === 'Knight Crest');
    return {
      klass: u.klass,
      crest: !!crest,
      uses: crest ? crest.uses === crest.maxUses : null,
      finished: u.finished,
      hasAttacked: u.hasAttacked,
      canAct: u.canStillAct(),
    };
  });
  expect(unit).toEqual({
    klass: 'Mercenary', crest: true, uses: true, finished: false, hasAttacked: false, canAct: true,
  });
});

/** Give the selected Mercenary a Canter (canto 1) skill and an Iron Sword after the crest. */
async function cantoMercenary(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const game = (window as any).__gameRef;
    const unit = (window as any).__promoUnit;
    const { SkillObject } = await import('/src/objects/skill.ts');
    const { ItemObject } = (window as any).__itemModule;
    unit.skills.push(new SkillObject({
      nid: '_TestCanter', name: '_TestCanter', desc: '', icon_nid: '', icon_index: [0, 0],
      components: [['canter', 1]],
    } as any));
    const sword = new ItemObject(game.db.items.get('Iron_Sword'));
    sword.owner = unit;
    unit.items.push(sword);
    unit.movementLeft = 3;
    (window as any).__logStart = game.actionLog.actions.length;
  });
}

async function openCrestChoice(page: Page): Promise<void> {
  await page.evaluate(() => (window as any).__gameRef.state.change('item_use'));
  await step(page, 2);
  await step(page, 1, 'SELECT');
  await step(page, 2);
  await step(page, 1, 'SELECT');
  await step(page, 2);
  expect(await stateName(page)).toBe('promotion_choice');
}

test('BACK from the promotion choice with Canto returns to the Canto move and re-gives the crest last', async ({ page }) => {
  await boot(page);
  await page.evaluate(async () => {
    (window as any).__itemModule = await import('/src/objects/item.ts');
  });
  await mercenary(page);
  await cantoMercenary(page);
  await openCrestChoice(page);
  await step(page, 1, 'BACK');
  await step(page, 2);
  // Python: the item's combat ran handle_state_stack first (HasAttacked,
  // Canto -> 'move' + SetMovementLeft(canto_movement)); BACK pops to that
  // MoveState with HasNotAttacked, and reverse_use GiveItems the broken
  // crest back at the end of the inventory.
  expect(await stateName(page)).toBe('move');
  const result = await page.evaluate(() => {
    const game = (window as any).__gameRef;
    const u = (window as any).__promoUnit;
    const snapshot = () => ({
      items: u.items.map((item: any) => item.nid),
      movementLeft: u.movementLeft,
      hasAttacked: u.hasAttacked,
      finished: u.finished,
    });
    const after = { ...snapshot(), selected: game.selectedUnit === u, crestFull: u.items[1]?.uses === u.items[1]?.maxUses };
    const undone = [];
    while (game.actionLog.actions.length > (window as any).__logStart) undone.push(game.actionLog.undo());
    const reverted = snapshot();
    for (const action of undone.reverse()) action?.execute();
    return { after, reverted, redone: snapshot() };
  });
  expect(result.after).toEqual({
    items: ['Iron_Sword', 'Knight Crest'], movementLeft: 1, hasAttacked: false, finished: false,
    selected: true, crestFull: true,
  });
  expect(result.reverted).toEqual({
    items: ['Knight Crest', 'Iron_Sword'], movementLeft: 3, hasAttacked: false, finished: false,
  });
  expect(result.redone).toEqual({
    items: ['Iron_Sword', 'Knight Crest'], movementLeft: 1, hasAttacked: false, finished: false,
  });
});

test('promoting with Canto ends in the Canto move instead of waiting', async ({ page }) => {
  await boot(page);
  await page.evaluate(async () => {
    (window as any).__itemModule = await import('/src/objects/item.ts');
  });
  await mercenary(page);
  await cantoMercenary(page);
  await openCrestChoice(page);
  await step(page, 1, 'SELECT');
  await step(page, 2);
  await step(page, 1, 'SELECT');
  expect(await stateName(page)).toBe('promotion');
  await runUntil(page, async () => await stateName(page) !== 'promotion', 40_000);
  // Python handle_state_stack pushed the Canto 'move' before the screens.
  expect(await stateName(page)).toBe('move');
  const result = await page.evaluate(() => {
    const u = (window as any).__promoUnit;
    return {
      klass: u.klass,
      items: u.items.map((item: any) => item.nid),
      movementLeft: u.movementLeft,
      hasAttacked: u.hasAttacked,
      finished: u.finished,
    };
  });
  expect(result).toEqual({
    klass: 'Hero', items: ['Iron_Sword'], movementLeft: 1, hasAttacked: true, finished: false,
  });
});

test('a non-silent event promote plays the promotion screen and resumes the event', async ({ page }) => {
  await boot(page);
  await page.evaluate(async () => {
    (window as any).__itemModule = await import('/src/objects/item.ts');
  });
  await mercenary(page);
  await page.evaluate(() => {
    const g = (window as any).__gameRef;
    const nid = 'promo_event';
    g.db.events.set(nid, {
      name: nid, nid, trigger: nid, level_nid: g.currentLevel?.nid ?? null, condition: 'True',
      only_once: false, priority: 0,
      _source: [`promote;${(window as any).__promoUnit.nid};Hero`, 'game_var;after_promo;1'],
    });
    g.eventManager.triggerSpecific(nid, { type: nid }, true);
    g.state.change('event');
  });
  await runUntil(page, async () => await stateName(page) === 'promotion');
  expect(await page.evaluate(() => (window as any).__gameRef.gameVars.get('after_promo'))).toBeUndefined();
  await runUntil(page, async () => (await page.evaluate(() =>
    (window as any).__gameRef.gameVars.get('after_promo'))) === 1, 30_000);
  expect(await page.evaluate(() => (window as any).__promoUnit.klass)).toBe('Hero');
});
