/**
 * ability-targeting.spec.ts — Python general_states.TargetingState for the
 * map abilities (Trade, Rescue, Take, Give, Drop, Talk, Support, ...): the
 * cursor moves between valid positions with selection_helper's rules, a
 * pennant scrolls `<Ability>_desc`, and the trade/rescue/give previews are
 * drawn as ui_view / TargetingState draw them. Pixel samples come from the
 * EOtF engine's own render of the same preview.
 */
import { expect, test, type Page } from '@playwright/test';

async function bootHub(page: Page): Promise<void> {
  await page.addInitScript(() => localStorage.setItem('lt-web-settings', JSON.stringify({ autoend_turn: 0, window_display: 1 })));
  await page.goto('/?harness=true&project=eotf.ltproj&level=X&clean=true&bundle=false');
  await page.waitForFunction(() => (window as any).__harness?.ready === true, undefined, { timeout: 90_000 });
  // Keeper (actor) at (4, 9) between Player (3, 9) and Lib (5, 9), all on the
  // player team; Player carries No_Trade as in the hub.
  await page.evaluate(async () => {
    const g = (window as any).__gameRef;
    const h = (window as any).__harness;
    for (let i = 0; i < 30; i++) {
      h.stepFrames(10, null);
      if (['free', 'free_roam'].includes(g.state.getCurrentState()?.name)) break;
    }
    if (g.state.getCurrentState()?.name === 'free_roam') {
      g.roamInfo.roam = false;
      g.state.back();
      h.stepFrames(5, null);
    }
    h.setUnitIdentity('Keeper', { team: 'player' });
    h.setUnitIdentity('Lib', { team: 'player' });
    h.warpUnit('Keeper', 4, 9);
    h.warpUnit('Lib', 5, 9);
    const { ItemObject } = await import('/src/objects/item.ts');
    const { SkillObject } = await import('/src/objects/skill.ts');
    const lib = g.units.get('Lib');
    for (const nid of ['Epee', 'Rapier']) {
      const item = new ItemObject(g.db.items.get(nid));
      item.owner = lib;
      lib.items.push(item);
    }
    lib.stats.CON = 1;
    const player = g.units.get('Player');
    if (!player.skills.some((s: any) => s.nid === 'No_Trade')) player.skills.push(new SkillObject(g.db.skills.get('No_Trade')));
    const keeper = g.units.get('Keeper');
    keeper.finished = false;
    g.selectedUnit = keeper;
    g.cursor.setPos(4, 9);
    h.stepFrames(5, null);
    const fonts = await import('/src/rendering/bmp-font.ts');
    for (let i = 0; i < 100 && !fonts.areFontsReady(); i++) await new Promise((r) => setTimeout(r, 50));
    const sprites = await import('/src/ui/sprites.ts');
    await sprites.preloadSprites(['trade_window', 'trade_window1', 'rescue_window1', 'give_window1', 'pennant_bg']);
  });
}

async function openTargeting(page: Page, ability: string) {
  return page.evaluate((value) => {
    const g = (window as any).__gameRef;
    g.memory.set('ability', value);
    g.state.change('targeting');
    (window as any).__harness.stepFrames(3, null);
    const st = g.state.getCurrentState();
    return { state: st?.name, cursor: g.cursor.getPosition(), positions: st?.selection?.posList ?? null };
  }, ability);
}

test.describe('Python TargetingState for map abilities', () => {
  test('selection helper reproduces CPython set order and directional moves', async ({ page }) => {
    await page.goto('/?harness=true&project=eotf.ltproj&level=X&clean=true&bundle=false');
    await page.waitForFunction(() => (window as any).__harness?.ready === true, undefined, { timeout: 90_000 });
    const result = await page.evaluate(async () => {
      const { SelectionHelper, pythonSetOrder } = await import('/src/engine/selection-helper.ts');
      const helper = new SelectionHelper([[3, 9], [5, 9], [4, 8], [4, 10]]);
      return {
        // list({(3, 9), (5, 9)}) and a resize past 4 entries, both from CPython 3.11.
        pair: pythonSetOrder([[3, 9], [5, 9]]),
        many: pythonSetOrder([[0, 0], [1, 2], [7, 3], [2, 2], [9, 9], [4, 1]]),
        order: helper.posList,
        closest: helper.getClosest([4, 9]),
        up: helper.getUp([4, 9]),
        downFromBottom: helper.getDown([4, 10]),
        next: helper.getNext(helper.posList[helper.posList.length - 1]),
      };
    });
    expect(result.pair).toEqual([[5, 9], [3, 9]]);
    expect(result.many).toEqual([[1, 2], [9, 9], [0, 0], [7, 3], [2, 2], [4, 1]]);
    expect(result.order).toEqual([[5, 9], [4, 10], [3, 9], [4, 8]]);
    expect(result.closest).toEqual(result.order[0]);
    expect(result.up).toEqual([4, 8]);
    // Nothing further down: fall back to the closest position overall.
    expect(result.downFromBottom).toEqual([4, 10]);
    expect(result.next).toEqual(result.order[0]);
  });

  test('Trade: cursor on the partner, pennant, skinned trade preview, SELECT opens the trade', async ({ page }, testInfo) => {
    await bootHub(page);
    const opened = await openTargeting(page, 'trade');
    // No_Trade keeps Player out; only Lib is a partner.
    expect(opened).toEqual({ state: 'targeting', cursor: [5, 9], positions: [[5, 9]] });
    await page.evaluate(async () => {
      for (let i = 0; i < 10; i++) {
        (window as any).__harness.stepFrames(3, null);
        await new Promise((r) => setTimeout(r, 40));
      }
    });
    await page.locator('canvas').screenshot({ path: testInfo.outputPath('trade-targeting.png') });

    const preview = await page.evaluate(async () => {
      const g = (window as any).__gameRef;
      const hud = await import('/src/ui/hud.ts');
      const { Surface } = await import('/src/engine/surface.ts');
      g.cursor.setPos(0, 0);
      const surf = new Surface(240, 160);
      surf.fill(0, 0, 0, 1);
      hud.drawTradePreview(surf, g, g.units.get('Lib'), [false, true]);
      g.cursor.setPos(5, 9);
      const pick = (x: number, y: number) => surf.getPixel(x, y).slice(0, 3);
      return {
        samples: [pick(130, 5), pick(150, 12), pick(160, 30), pick(200, 40), pick(235, 59), pick(126, 60), pick(140, 20)],
      };
    });
    // The EOtF engine's draw_trade_preview of the same unit on black.
    expect(preview.samples).toEqual([
      [72, 36, 0], [223, 223, 223], [118, 92, 65], [120, 93, 67], [129, 101, 79], [0, 0, 0], [152, 200, 128],
    ]);

    await page.evaluate(() => (window as any).__harness.stepFrames(1, 'SELECT'));
    await page.evaluate(() => (window as any).__harness.stepFrames(3, null));
    const trade = await page.evaluate(() => {
      const st = (window as any).__gameRef.state.getCurrentState();
      return { state: st?.name, partner: st?.tradePartner?.nid ?? null };
    });
    expect(trade).toEqual({ state: 'trade', partner: 'Lib' });
  });

  test('Rescue: Python set order picks the first target, rescue preview, BACK and SELECT', async ({ page }, testInfo) => {
    await bootHub(page);
    const opened = await openTargeting(page, 'rescue');
    // Both neighbours can be carried; list({(3, 9), (5, 9)}) starts on (5, 9).
    expect(opened).toEqual({ state: 'targeting', cursor: [5, 9], positions: [[5, 9], [3, 9]] });
    await page.evaluate(() => (window as any).__harness.stepFrames(1, 'LEFT'));
    expect(await page.evaluate(() => (window as any).__gameRef.cursor.getPosition())).toEqual([3, 9]);
    await page.evaluate(() => (window as any).__harness.stepFrames(1, 'AUX'));
    expect(await page.evaluate(() => (window as any).__gameRef.cursor.getPosition())).toEqual([5, 9]);
    await page.evaluate(async () => {
      for (let i = 0; i < 10; i++) {
        (window as any).__harness.stepFrames(3, null);
        await new Promise((r) => setTimeout(r, 40));
      }
    });
    await page.locator('canvas').screenshot({ path: testInfo.outputPath('rescue-targeting.png') });

    await page.evaluate(() => (window as any).__harness.stepFrames(1, 'BACK'));
    await page.evaluate(() => (window as any).__harness.stepFrames(2, null));
    expect(await page.evaluate(() => (window as any).__gameRef.state.getCurrentState()?.name)).toBe('free');

    await openTargeting(page, 'rescue');
    await page.evaluate(() => (window as any).__harness.stepFrames(1, 'SELECT'));
    await page.evaluate(() => (window as any).__harness.stepFrames(3, null));
    const rescued = await page.evaluate(() => {
      const keeper = (window as any).__gameRef.units.get('Keeper');
      return { carrying: keeper.rescuing?.nid ?? null, finished: keeper.finished };
    });
    expect(rescued).toEqual({ carrying: 'Lib', finished: true });
  });

  test('Talk marks HasTraded and fires on_talk for the unit under the cursor', async ({ page }) => {
    await bootHub(page);
    const result = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const h = (window as any).__harness;
      const fired: string[] = [];
      const em = g.eventManager;
      em.getEventsForTrigger = (t: any) => (t.type === 'on_talk' ? [{ nid: 'fake_talk' }] : []);
      const trigger = em.trigger.bind(em);
      em.trigger = (t: any, ctx: any) => {
        if (t.type === 'on_talk') {
          fired.push(`${t.unit1?.nid}->${t.unit2?.nid}`);
          return false;
        }
        return trigger(t, ctx);
      };
      g.state.change('menu');
      h.stepFrames(2, null);
      g.memory.set('ability', 'talk');
      g.state.change('targeting');
      h.stepFrames(2, null);
      const start = g.cursor.getPosition();
      h.stepFrames(1, 'LEFT');
      const moved = g.cursor.getPosition();
      h.stepFrames(1, 'SELECT');
      h.stepFrames(3, null);
      const keeper = g.units.get('Keeper');
      return { start, moved, fired, hasTraded: keeper.hasTraded, finished: keeper.finished, top: g.state.getCurrentState()?.name };
    });
    expect(result.start).toEqual([5, 9]);
    expect(result.moved).toEqual([3, 9]);
    expect(result.fired).toEqual(['Keeper->Player']);
    expect(result.hasTraded).toBe(true);
    expect(result.finished).toBe(false);
    expect(result.top).toBe('menu');
  });

  test('Steal: trade preview while targeting, the picker at the Choice spot, BACK to the menu', async ({ page }) => {
    await bootHub(page);
    const result = await page.evaluate(async () => {
      const g = (window as any).__gameRef;
      const h = (window as any).__harness;
      h.setUnitIdentity('Lib', { team: 'enemy' });
      // GBA steal takes non-weapons only: give Lib a Vulnerary to steal.
      const { ItemObject } = await import('/src/objects/item.ts');
      const lib = g.units.get('Lib');
      const vulnerary = new ItemObject(g.db.items.get('Vulnerary'));
      vulnerary.owner = lib;
      lib.items.push(vulnerary);
      const keeper = g.units.get('Keeper');
      h.giveItem('Keeper', 'Steal');
      const steal = keeper.items.find((i: any) => i.nid === 'Steal');
      g.state.change('menu');
      h.stepFrames(2, null);
      g.memory.set('item_use_item', steal);
      g.state.change('item_targeting');
      h.stepFrames(3, null);
      const targeting = g.state.getCurrentState()?.name;
      const cursor = g.cursor.getPosition();
      h.stepFrames(1, 'SELECT');
      h.stepFrames(2, null);
      const st = g.state.getCurrentState();
      const picker = st.targetItemMenu?.choice;
      const pickerInfo = picker ? {
        topleft: picker.getTopleft(), width: picker.getMenuWidth(),
        items: picker.options.map((o: any) => o.entry.item?.nid),
        cursorVisible: g.cursor.visible,
      } : null;
      h.stepFrames(1, 'BACK');
      h.stepFrames(3, null);
      return { targeting, cursor, pickerInfo, after: g.state.getCurrentState()?.name };
    });
    expect(result.targeting).toBe('item_targeting');
    expect(result.cursor).toEqual([5, 9]);
    // Python ItemTargetingState: menus.Choice(target, eligible items) at the
    // automatic spot (cursor right of the middle column -> (14, 8)).
    expect(result.pickerInfo).toEqual({ topleft: [240 - 104 - 14, 8], width: 104, items: ['Vulnerary'], cursorVisible: false });
    // BACK pops the picker and the targeting state, back to the action menu.
    expect(result.after).toBe('menu');
  });

  test('map highlights: hover shows the light ranges as sprites that grow in', async ({ page }) => {
    await bootHub(page);
    const result = await page.evaluate(async () => {
      const g = (window as any).__gameRef;
      const h = (window as any).__harness;
      const sprites = await import('/src/ui/sprites.ts');
      await sprites.preloadSprites(['highlight_lightblue', 'highlight_lightred', 'highlight_blue', 'highlight_red']);
      g.cursor.setPos(0, 0);
      h.stepFrames(3, null);
      g.cursor.setPos(4, 9);
      h.stepFrames(1, null);
      const first = g.highlight.spriteLayers().map((l: any) => [l.type, l.sprite, l.cutoff]);
      h.stepFrames(10, null);
      const settled = g.highlight.spriteLayers().map((l: any) => [l.type, l.cutoff]);
      g.cursor.setPos(0, 0);
      h.stepFrames(2, null);
      const cleared = g.highlight.spriteLayers().length;
      return { first, settled, cleared };
    });
    // Keeper (Great_Knight) hovered: light move range and, for its weapons,
    // the light attack range; a new layer starts 7 px in and grows by a pixel
    // per drawn frame.
    expect(result.first.some((l: any[]) => l[0] === 'possible_move' && l[1] === 'highlight_lightblue')).toBe(true);
    expect(result.first.some((l: any[]) => l[2] > 0)).toBe(true);
    expect(result.settled.every((l: any[]) => l[1] === 0)).toBe(true);
    expect(result.cleared).toBe(0);
  });
});
