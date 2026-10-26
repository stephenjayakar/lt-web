import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import type { Page, TestInfo } from '@playwright/test';

/**
 * EOtF menu screens drawn with Python's sprites and bitmap fonts. Each case
 * opens a state, lets its lazily-loaded sprites arrive, screenshots it, and
 * checks that no CSS-font fallback text was drawn.
 */

const projectAvailable = fs.existsSync(path.join(process.cwd(), 'lt-maker/eotf.ltproj/game_data/levels.json'));

async function step(page: Page, frames = 3): Promise<void> {
  await page.evaluate((n) => (window as any).__harness.stepFrames(n, null), frames);
}

async function boot(page: Page, level = '2'): Promise<void> {
  // Clean boots skip level events, so there are no player units and Python's
  // FreeState would auto-end the empty player phase; stay in free instead.
  await page.addInitScript(() => localStorage.setItem('lt-web-settings', JSON.stringify({ autoend_turn: 0 })));
  await page.goto(`/?harness=true&project=eotf.ltproj&level=${level}&clean=true&bundle=false`);
  await page.waitForFunction(() => (window as any).__harness?.ready === true, { timeout: 60_000 });
  await page.evaluate(() => (window as any).__harness.settle(2_000, ['free', 'prep_main', 'base_main']));
  // Count Canvas fillText calls: menu text must come from bitmap fonts.
  await page.evaluate(() => {
    const w = window as any;
    w.__cssTextCalls = [];
    for (const proto of [OffscreenCanvasRenderingContext2D.prototype, CanvasRenderingContext2D.prototype]) {
      const original = proto.fillText;
      proto.fillText = function patched(this: any, text: string, ...rest: any[]) {
        w.__cssTextCalls.push(String(text));
        return (original as any).call(this, text, ...rest);
      } as any;
    }
  });
}

/** Wait for streamed sprites, then advance frames. */
async function settleAssets(page: Page, frames = 30): Promise<void> {
  await step(page, 2);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(300);
  await step(page, frames);
}

async function shot(page: Page, name: string, testInfo: TestInfo): Promise<void> {
  await page.locator('canvas').screenshot({ path: testInfo.outputPath(`${name}.png`) });
}

async function stateName(page: Page): Promise<string> {
  return page.evaluate(() => (window as any).__gameRef.state.getCurrentState()?.name);
}

async function press(page: Page, ...events: string[]): Promise<void> {
  for (const event of events) {
    await page.evaluate((e) => (window as any).__gameRef.state.getCurrentState()?.takeInput(e), event);
    await step(page, 2);
  }
}

async function cssText(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as any).__cssTextCalls.splice(0));
}

test.describe('EOtF menu screens use Python sprites and bitmap fonts', () => {
  test.skip(!projectAvailable, 'lt-maker/eotf.ltproj is not installed');

  test('settings menu', async ({ page }, testInfo) => {
    await boot(page);
    await page.evaluate(() => (window as any).__gameRef.state.change('settings_menu'));
    await settleAssets(page);
    expect(await stateName(page)).toBe('settings_menu');
    await cssText(page);
    await step(page, 2);
    await shot(page, 'settings-top', testInfo);
    await press(page, 'DOWN', 'DOWN');
    await step(page, 10);
    await shot(page, 'settings-config', testInfo);
    await press(page, 'UP', 'UP', 'RIGHT', 'DOWN');
    await step(page, 10);
    await shot(page, 'settings-controls', testInfo);
    expect(await cssText(page)).toEqual([]);
  });

  test('turnwheel overlay', async ({ page }, testInfo) => {
    await boot(page);
    await page.evaluate(() => (window as any).__gameRef.state.change('turnwheel'));
    await settleAssets(page);
    expect(await stateName(page)).toBe('turnwheel');
    await cssText(page);
    await step(page, 2);
    await shot(page, 'turnwheel', testInfo);
    expect(await cssText(page)).toEqual([]);
  });

  test('unit info menu pages', async ({ page }, testInfo) => {
    await boot(page);
    const unitName = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      // An authored EOtF player unit (portrait, items, weapon ranks).
      const unit = game.units.get('Termina') ??
        game.spawnUnit(game.db.units.get('Termina'), 'player', null, 'None');
      await game.loadAllMapSprites?.();
      game.infoMenuUnit = unit;
      game.state.change('info_menu');
      return unit.name;
    });
    await settleAssets(page);
    expect(await stateName(page)).toBe('info_menu');
    await cssText(page);
    await step(page, 2);
    await shot(page, 'info-personal', testInfo);
    expect(unitName).toBeTruthy();
    const pages: number[] = [];
    for (const name of ['info-equipment', 'info-skills']) {
      await press(page, 'RIGHT');
      await step(page, 20);
      pages.push(await page.evaluate(() => (window as any).__gameRef.state.getCurrentState().currentPage));
      await shot(page, name, testInfo);
    }
    expect(pages).toEqual([1, 2]);
    // Mid-slide frame: the page slides in from the right like Python.
    await press(page, 'LEFT');
    await shot(page, 'info-slide', testInfo);
    await step(page, 20);
    // INFO opens Python's help boxes (InfoGraph); arrows move between them.
    await press(page, 'LEFT');
    await step(page, 20);
    await press(page, 'INFO');
    await step(page, 20);
    await shot(page, 'info-help-item', testInfo);
    await press(page, 'DOWN', 'DOWN');
    await step(page, 20);
    await shot(page, 'info-help-stat', testInfo);
    await press(page, 'INFO');
    await step(page, 10);
    expect(await cssText(page)).toEqual([]);
  });

  test('victory, game over, credits and text entry', async ({ page }, testInfo) => {
    await boot(page);
    const open = async (name: string, setup?: string): Promise<void> => {
      await page.evaluate(([state, extra]) => {
        const game = (window as any).__gameRef;
        if (extra === 'text') {
          game.memory.set('text_entry', ['answer', 'Who sent you here?', 16, ['numbers_and_punctuation'], true, null, 0]);
        }
        game.state.change(state);
      }, [name, setup ?? ''] as const);
      await settleAssets(page);
      expect(await stateName(page)).toBe(name);
      await cssText(page);
      await step(page, 2);
      await shot(page, name, testInfo);
      expect(await cssText(page)).toEqual([]);
    };
    await open('victory');
    await page.evaluate(() => (window as any).__gameRef.state.back());
    await step(page, 2);
    await open('text_entry', 'text');
    const typed = await page.evaluate(() => {
      const state = (window as any).__gameRef.state.getCurrentState();
      state.takeInput('RIGHT');
      state.takeInput('SELECT');
      state.takeInput('DOWN');
      state.takeInput('SELECT');
      return state.currentText;
    });
    expect(typed).toBe('Bb');
    await press(page, 'START');
    await step(page, 4);
    await shot(page, 'text_confirm', testInfo);
    await press(page, 'SELECT');
    await step(page, 2);
    expect(await page.evaluate(() => (window as any).__gameRef.gameVars.get('answer'))).toBe('Bb');
    await open('credit');
    await page.evaluate(() => (window as any).__gameRef.state.back());
    await step(page, 2);
    await open('game_over');
    await page.waitForTimeout(200);
    await step(page, 120);
    await shot(page, 'game_over-late', testInfo);
  });

  test('title main, extras, new game and save screens', async ({ page }, testInfo) => {
    await boot(page);
    const open = async (name: string, frames = 30): Promise<void> => {
      await page.evaluate((state) => (window as any).__gameRef.state.change(state), name);
      await settleAssets(page, frames);
      expect(await stateName(page)).toBe(name);
      await cssText(page);
      await step(page, 2);
      await shot(page, name, testInfo);
      expect(await cssText(page)).toEqual([]);
    };
    await page.evaluate(() => (window as any).__gameRef.state.clear());
    await open('title_main');
    await press(page, 'DOWN');
    await step(page, 2);
    expect(await page.evaluate(() => (window as any).__gameRef.state.getCurrentState().menu.getCurrent()))
      .toBe('Extras');
    await open('title_extras');
    await page.evaluate(() => (window as any).__gameRef.state.back());
    await step(page, 2);
    await open('title_new');
    await page.evaluate(() => (window as any).__gameRef.state.back());
    await step(page, 2);
    await open('save_menu');
  });

  test('shop buy and sell', async ({ page }, testInfo) => {
    await boot(page);
    await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { ItemObject } = await import('/src/objects/item.ts');
      const unit = game.units.get('Termina') ??
        game.spawnUnit(game.db.units.get('Termina'), 'player', null, 'None');
      game.getParty().money = 1500;
      game.shopUnit = unit;
      game.shopItems = [...game.db.items.values()]
        .filter((prefab: any) => prefab.components?.some?.((c: any) => (c[0] ?? c.nid) === 'value'))
        .slice(0, 6)
        .map((prefab: any) => new ItemObject(prefab));
      game.shopStock = game.shopItems.map(() => -1);
      game.shopFlavor = 'armory';
      game.state.change('shop');
    });
    await settleAssets(page, 60);
    expect(await stateName(page)).toBe('shop');
    await cssText(page);
    await step(page, 2);
    await shot(page, 'shop-open', testInfo);
    // The opener may span several {w} pages; SELECT advances it like Python.
    for (let i = 0; i < 6; i++) {
      if (await page.evaluate(() => (window as any).__gameRef.state.getCurrentState().phase) === 'choice') break;
      await press(page, 'SELECT');
      await step(page, 4);
    }
    expect(await page.evaluate(() => (window as any).__gameRef.state.getCurrentState().phase)).toBe('choice');
    await shot(page, 'shop-choice', testInfo);
    await press(page, 'SELECT');
    await step(page, 40);
    await shot(page, 'shop-buy', testInfo);
    // INFO shows Python's ItemHelpDialog for the hovered weapon.
    await press(page, 'INFO');
    await page.waitForTimeout(300);
    await step(page, 20);
    await shot(page, 'shop-buy-info', testInfo);
    await press(page, 'INFO');
    await step(page, 10);
    const before = await page.evaluate(() => (window as any).__gameRef.getMoney());
    await press(page, 'SELECT');
    await step(page, 30);
    const after = await page.evaluate(() => (window as any).__gameRef.getMoney());
    expect(after).toBeLessThan(before);
    await shot(page, 'shop-bought', testInfo);
    await press(page, 'BACK', 'RIGHT');
    await step(page, 30);
    await shot(page, 'shop-sell-choice', testInfo);
    expect(await cssText(page)).toEqual([]);
  });

  test('event location card and credits roll', async ({ page }, testInfo) => {
    await boot(page);
    await page.evaluate(() => {
      const g = (window as any).__gameRef;
      g.db.events.set('UiMenusEventCards', {
        name: 'UiMenusEventCards', nid: 'UiMenusEventCards', trigger: 'UiMenusEventCards',
        level_nid: g.currentLevel?.nid ?? null, condition: 'True', only_once: false, priority: 0,
        _source: [
          'location_card;Room 3',
          'credits;Development Team;Lord Tweed,RandomWizard;center;wait',
        ],
      });
      g.eventManager.triggerSpecific('UiMenusEventCards', { type: 'UiMenusEventCards' }, true);
      g.state.change('event');
    });
    await settleAssets(page, 30);
    await cssText(page);
    await step(page, 2);
    await shot(page, 'location-card', testInfo);
    await step(page, 200);
    await step(page, 60);
    await shot(page, 'credits-roll', testInfo);
    expect(await cssText(page)).toEqual([]);
  });

  test('chapter title card', async ({ page }, testInfo) => {
    await boot(page);
    await page.evaluate(() => {
      const g = (window as any).__gameRef;
      g.db.events.set('UiMenusChapterTitle', {
        name: 'UiMenusChapterTitle', nid: 'UiMenusChapterTitle', trigger: 'UiMenusChapterTitle',
        level_nid: g.currentLevel?.nid ?? null, condition: 'True', only_once: false, priority: 0,
        _source: ['chapter_title;;The Fog Rises'],
      });
      g.eventManager.triggerSpecific('UiMenusChapterTitle', { type: 'UiMenusChapterTitle' }, true);
      g.state.change('event');
    });
    await settleAssets(page, 10);
    await cssText(page);
    await step(page, 240);
    expect(await page.evaluate(() => (window as any).__gameRef.state.getCurrentState()?.chapterTitlePhase))
      .toBe('wait');
    await shot(page, 'chapter-title', testInfo);
    expect(await cssText(page)).toEqual([]);
  });

  test('map trade uses the Python trade window', async ({ page }, testInfo) => {
    await boot(page);
    await page.evaluate(() => {
      const game = (window as any).__gameRef;
      const termina = game.units.get('Termina') ??
        game.spawnUnit(game.db.units.get('Termina'), 'player', null, 'None');
      const aeilem = game.units.get('Aeilem') ??
        game.spawnUnit(game.db.units.get('Aeilem'), 'player', null, 'None');
      game.selectedUnit = termina;
      game.memory.set('trade_partner', aeilem);
      game.state.change('trade');
    });
    await settleAssets(page, 20);
    expect(await stateName(page)).toBe('trade');
    await cssText(page);
    await press(page, 'SELECT');
    await step(page, 4);
    await shot(page, 'map-trade', testInfo);
    await press(page, 'BACK', 'INFO');
    await step(page, 20);
    await shot(page, 'map-trade-info', testInfo);
    expect(await cssText(page)).toEqual([]);
  });

  test('objective menu and dialog log', async ({ page }, testInfo) => {
    await boot(page);
    await page.evaluate(() => (window as any).__gameRef.state.change('objective_menu'));
    await settleAssets(page);
    expect(await stateName(page)).toBe('objective_menu');
    await cssText(page);
    await step(page, 2);
    await shot(page, 'objective-menu', testInfo);
    expect(await cssText(page)).toEqual([]);

    await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      game.state.getCurrentState()?.takeInput('BACK');
      const { appendDialogLogEntry } = await import('/src/engine/states/objective-dialog-states.ts');
      const speaker = [...game.units.values()].find((u: any) => u.team === 'player')?.nid ?? 'Player';
      appendDialogLogEntry(game, speaker, 'We move{w} now!|Stay together, and watch the fog.');
      appendDialogLogEntry(game, 'Narrator', 'The fog thickens around the camp.');
      game.state.change('dialog_log');
    });
    await settleAssets(page, 6);
    expect(await stateName(page)).toBe('dialog_log');
    await cssText(page);
    await step(page, 2);
    await shot(page, 'dialog-log', testInfo);
    expect(await cssText(page)).toEqual([]);
  });
});
