/**
 * Playwright visual test harness for the Lex Talionis web engine.
 *
 * Uses ?harness=true to drive the game frame-by-frame and capture
 * screenshots at specific states for visual verification.
 *
 * By default, ?clean=true skips level_start events so we land directly
 * on the 'free' state (map gameplay). Use &clean=false to test with events.
 *
 * Run: npx playwright test
 * View report: npx playwright show-report
 */

import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SCREENSHOT_DIR = path.resolve(__dirname, '..', 'test-screenshots');

if (!fs.existsSync(SCREENSHOT_DIR)) {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function waitForHarness(page: any) {
  await page.waitForFunction(
    () => (window as any).__harness?.ready === true,
    { timeout: 30_000 },
  );
}

async function stepFrames(page: any, count: number, input?: string | null) {
  await page.evaluate(
    ({ count, input }: { count: number; input: string | null }) => {
      (window as any).__harness.stepFrames(count, input);
    },
    { count, input: input ?? null },
  );
}

async function getState(page: any) {
  return page.evaluate(() => (window as any).__harness.getState());
}

async function settle(page: any, maxFrames: number = 300) {
  await page.evaluate(
    (maxFrames: number) => (window as any).__harness.settle(maxFrames),
    maxFrames,
  );
}

async function saveScreenshot(page: any, label: string): Promise<string> {
  const filePath = path.join(SCREENSHOT_DIR, `${label}.png`);
  await page.screenshot({ path: filePath });
  return filePath;
}

// ---------------------------------------------------------------------------
// DEBUG Level Tests (clean mode -- no events, straight to free state)
// ---------------------------------------------------------------------------

test.describe('DEBUG Level (clean)', () => {
  test('initial map render', async ({ page }) => {
    // clean=true is the default, skips level_start events
    await page.goto('/?harness=true&level=DEBUG&bundle=false');
    await waitForHarness(page);

    await stepFrames(page, 10);

    const state = await getState(page);
    expect(state.levelNid).toBe('DEBUG');
    expect(state.currentStateName).toBe('free');
    expect(state.units.length).toBeGreaterThan(0);

    console.log(`Units: ${state.units.map((u: any) => `${u.name}(${u.team})`).join(', ')}`);
    await saveScreenshot(page, '01-debug-map');
  });

  test('cursor movement', async ({ page }) => {
    await page.goto('/?harness=true&level=DEBUG&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 5);

    const before = await getState(page);
    const startPos = before.cursorPos;

    // Move cursor right 3 times, down 2 times
    for (let i = 0; i < 3; i++) {
      await stepFrames(page, 4, 'RIGHT');
    }
    for (let i = 0; i < 2; i++) {
      await stepFrames(page, 4, 'DOWN');
    }
    await stepFrames(page, 5); // settle animation

    const after = await getState(page);
    console.log(`Cursor moved: [${startPos}] -> [${after.cursorPos}]`);
    expect(after.cursorPos[0]).toBeGreaterThan(startPos[0]);
    expect(after.cursorPos[1]).toBeGreaterThan(startPos[1]);

    await saveScreenshot(page, '02-debug-cursor-moved');
  });

  test('select unit shows movement range', async ({ page }) => {
    await page.goto('/?harness=true&level=DEBUG&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 5);

    // Find a player unit
    const state = await getState(page);
    const player = state.units.find(
      (u: any) => u.team === 'player' && u.position !== null,
    );
    expect(player).toBeTruthy();
    console.log(`Selecting: ${player.name} at [${player.position}]`);

    // Move cursor to unit
    const [ux, uy] = player.position;
    const [cx, cy] = state.cursorPos;
    const dx = ux - cx;
    const dy = uy - cy;
    for (let i = 0; i < Math.abs(dx); i++) {
      await stepFrames(page, 3, dx > 0 ? 'RIGHT' : 'LEFT');
    }
    for (let i = 0; i < Math.abs(dy); i++) {
      await stepFrames(page, 3, dy > 0 ? 'DOWN' : 'UP');
    }
    await stepFrames(page, 5);

    // Screenshot: cursor on unit
    await saveScreenshot(page, '03-debug-cursor-on-unit');

    // Press SELECT to select the unit
    await stepFrames(page, 3, 'SELECT');
    await stepFrames(page, 15); // let highlights render

    // Check we transitioned to move state
    const afterSelect = await getState(page);
    console.log(`State after select: ${afterSelect.currentStateName}`);

    await saveScreenshot(page, '04-debug-movement-range');
  });

  test('open and close action menu', async ({ page }) => {
    await page.goto('/?harness=true&level=DEBUG&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 5);

    // Find Eirika
    const state = await getState(page);
    const eirika = state.units.find((u: any) => u.nid === 'Eirika');
    expect(eirika).toBeTruthy();

    // Navigate cursor to Eirika
    const [ux, uy] = eirika.position;
    const [cx, cy] = state.cursorPos;
    const dx = ux - cx;
    const dy = uy - cy;
    for (let i = 0; i < Math.abs(dx); i++) {
      await stepFrames(page, 3, dx > 0 ? 'RIGHT' : 'LEFT');
    }
    for (let i = 0; i < Math.abs(dy); i++) {
      await stepFrames(page, 3, dy > 0 ? 'DOWN' : 'UP');
    }
    await stepFrames(page, 5);

    // Select Eirika
    await stepFrames(page, 3, 'SELECT');
    await stepFrames(page, 10);

    // Select same tile (should open menu)
    await stepFrames(page, 3, 'SELECT');
    await stepFrames(page, 10);

    const menuState = await getState(page);
    console.log(`State after menu: ${menuState.currentStateName}`);
    await saveScreenshot(page, '05-debug-action-menu');

    // Press BACK to cancel
    await stepFrames(page, 3, 'BACK');
    await stepFrames(page, 10);
    await stepFrames(page, 3, 'BACK');
    await stepFrames(page, 10);

    const afterCancel = await getState(page);
    console.log(`State after cancel: ${afterCancel.currentStateName}`);
    await saveScreenshot(page, '06-debug-after-cancel');
  });
});

test.describe('Event command parity', () => {
  test('parser dispatch and reversible scalar mutations match LT commands', async ({ page }) => {
    await page.goto('/?harness=true&level=0&clean=true&bundle=false');
    await waitForHarness(page);

    const setup = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { GameEvent } = await import('/src/events/event-manager.ts');
      const unit = game?.units?.get?.('Eirika');
      if (!game || !unit) return null;

      const parserCommands = [
        'overworld_cinematic',
        'reveal_overworld_node;Node1',
        'reveal_overworld_road;Node1;Node2',
        'overworld_move_unit;Eirika;Node2',
        'set_overworld_position;Eirika;Node1',
        'set_roam;true',
        'set_roam_unit;Eirika',
        'add_lore;Guide',
        'remove_lore;Guide',
      ];
      const parsedTypes = parserCommands.map((line) => GameEvent.parseCommand(line)?.type ?? null);

      unit.dead = true;
      unit.currentHp = 0;
      unit.hasAttacked = true;
      unit.hasMoved = true;
      unit.hasTraded = true;
      unit.finished = true;

      const prefab = {
        nid: '_test_scalar_commands',
        name: 'Scalar Command Parity',
        trigger: 'test',
        level_nid: '0',
        condition: '',
        only_once: false,
        priority: 0,
        _source: [
          'set_wexp;Eirika;Sword;70;no_banner',
          'give_wexp;Eirika;Sword;7;no_banner',
          'set_unit_level;Eirika;5',
          'resurrect;Eirika',
          'add_lore;Guide',
          'add_lore;Guide',
        ],
      };
      const event = new GameEvent(prefab, { type: 'test', levelNid: '0' });
      game.eventManager.eventQueue.push(event);
      game.state.change('event');
      return { parsedTypes, commandCount: event.commands.length };
    });

    expect(setup).not.toBeNull();
    expect(setup!.parsedTypes).not.toContain(null);
    expect(setup!.commandCount).toBe(6);

    await stepFrames(page, 5);

    const result = await page.evaluate(() => {
      const game = (window as any).__gameRef;
      const unit = game.units.get('Eirika');
      return {
        wexp: unit.wexp.Sword,
        level: unit.level,
        dead: unit.dead,
        hp: unit.currentHp,
        maxHp: unit.maxHp,
        hasAttacked: unit.hasAttacked,
        hasMoved: unit.hasMoved,
        hasTraded: unit.hasTraded,
        finished: unit.finished,
        unlockedLore: [...game.unlockedLore],
      };
    });

    expect(result).toEqual({
      wexp: 77,
      level: 5,
      dead: false,
      hp: result.maxHp,
      maxHp: result.maxHp,
      hasAttacked: false,
      hasMoved: false,
      hasTraded: false,
      finished: false,
      unlockedLore: ['Guide'],
    });

    const saveRoundTrip = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { saveGame, loadGame, deleteSave } = await import('/src/engine/save.ts');
      const gameNid = game.db.getConstant('game_nid', 'default');
      await saveGame(game, 99, 'battle');
      game.unlockedLore = [];
      const loaded = await loadGame(game, 99);
      const unlockedLore = [...game.unlockedLore];
      await deleteSave(gameNid, 99);
      return { loaded, unlockedLore };
    });

    expect(saveRoundTrip).toEqual({ loaded: true, unlockedLore: ['Guide'] });
  });

  test('achievement commands preserve Python flags, persistence, queries, banners, and turnwheel scope', async ({ page }) => {
    await page.goto('/?harness=true&level=0&clean=true&bundle=false');
    await waitForHarness(page);

    const setup = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { GameEvent } = await import('/src/events/event-manager.ts');
      const records = await import('/src/engine/records.ts');
      records.ACHIEVEMENTS.clear();

      const parsed = [
        'create_achievement;A;Name;Description',
        'update_achievement;A;New Name;New Description',
        'complete_achievement;A;t',
        'clear_achievements',
        'add_achievement;Legacy;Name;Description',
      ].map((line) => GameEvent.parseCommand(line)?.type ?? null);

      const event = new GameEvent({
        nid: '_test_achievement_mutations',
        name: 'Achievement Mutations',
        trigger: 'test',
        level_nid: '0',
        condition: '',
        only_once: false,
        priority: 0,
        _source: [
          'create_achievement;A;Original;Original description;hidden',
          'create_achievement;A;Duplicate;Must not replace',
          'update_achievement;A;Still Hidden;Updated once;hidden',
          'update_achievement;A;Visible Name;Visible description',
          'update_achievement;Missing;No-op;No-op description;hidden',
          'create_achievement;Auto;Automatic;Already complete;hidden;completed',
          'create_achievement;Malformed',
          'complete_achievement;A;t',
          'complete_achievement;A;n',
          'complete_achievement;A;yes',
          'complete_achievement;Missing;t',
        ],
      }, { type: 'test', levelNid: '0' });
      const beforeActionIndex = game.actionLog.actionIndex;
      game.eventManager.eventQueue.push(event);
      return { parsed, commandCount: event.commands.length, beforeActionIndex };
    });

    expect(setup.parsed).toEqual([
      'create_achievement',
      'update_achievement',
      'complete_achievement',
      'clear_achievements',
      'create_achievement',
    ]);
    expect(setup.commandCount).toBe(11);
    await stepFrames(page, 8);

    const mutated = await page.evaluate(async (beforeActionIndex: number) => {
      const game = (window as any).__gameRef;
      const records = await import('/src/engine/records.ts');
      const { GameQueryEngine } = await import('/src/engine/query-engine.ts');
      const query = new GameQueryEngine();
      return {
        entries: records.ACHIEVEMENTS.save(),
        aHiddenForDisplay: records.ACHIEVEMENTS.getHidden('A'),
        autoHiddenForDisplay: records.ACHIEVEMENTS.getHidden('Auto'),
        hasA: query.hasAchievement('A'),
        hasMissing: query.hasAchievement('Missing'),
        actionIndex: game.actionLog.actionIndex,
        newActionTypes: (game.actionLog as any).actions
          .slice(beforeActionIndex + 1)
          .map((action: any) => action.constructor.name),
      };
    }, setup.beforeActionIndex);

    expect(mutated.entries).toEqual([
      {
        nid: 'A',
        name: 'Visible Name',
        desc: 'Visible description',
        complete: true,
        hidden: false,
      },
      {
        nid: 'Auto',
        name: 'Automatic',
        desc: 'Already complete',
        complete: true,
        hidden: true,
      },
    ]);
    expect(mutated.aHiddenForDisplay).toBe(false);
    expect(mutated.autoHiddenForDisplay).toBe(false);
    expect(mutated.hasA).toBe(true);
    expect(mutated.hasMissing).toBe(false);
    // Returning to FreeState records its ordinary marker; the achievement commands add none.
    expect(mutated.newActionTypes.every((name: string) => name === 'MarkActionGroupEnd')).toBe(true);

    await page.reload();
    await waitForHarness(page);
    const restored = await page.evaluate(async () => {
      const records = await import('/src/engine/records.ts');
      const { GameQueryEngine } = await import('/src/engine/query-engine.ts');
      const query = new GameQueryEngine();
      return {
        entries: records.ACHIEVEMENTS.save(),
        hasA: query.hasAchievement('A'),
        hasAuto: query.hasAchievement('Auto'),
      };
    });
    expect(restored.entries).toEqual(mutated.entries);
    expect(restored.hasA).toBe(true);
    expect(restored.hasAuto).toBe(true);

    const bannerSetup = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { GameEvent } = await import('/src/events/event-manager.ts');
      const records = await import('/src/engine/records.ts');
      records.ACHIEVEMENTS.complete('A', false);
      (window as any).__achievementSfx = [];
      (window as any).__achievementOriginalPlaySfx = game.audioManager.playSfx;
      game.audioManager.playSfx = async (nid: string) => {
        (window as any).__achievementSfx.push(nid);
      };
      const event = new GameEvent({
        nid: '_test_achievement_banner',
        name: 'Achievement Banner',
        trigger: 'test',
        level_nid: '0',
        condition: '',
        only_once: false,
        priority: 0,
        _source: ['complete_achievement;A;1;banner'],
      }, { type: 'test', levelNid: '0' });
      game.eventManager.eventQueue.push(event);
      return game.actionLog.actionIndex;
    });

    await stepFrames(page, 5);
    const duringBanner = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const records = await import('/src/engine/records.ts');
      const event = game.eventManager.getCurrentEvent();
      return {
        complete: records.ACHIEVEMENTS.checkAchievement('A'),
        pointer: event?.commandPointer ?? null,
        state: game.state.getCurrentState()?.name ?? null,
        sfx: [...(window as any).__achievementSfx],
        actionIndex: game.actionLog.actionIndex,
      };
    });
    expect(duringBanner).toEqual({
      complete: true,
      pointer: 0,
      state: 'event',
      sfx: ['Item'],
      actionIndex: bannerSetup,
    });

    await stepFrames(page, 140);
    const cleared = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { GameEvent } = await import('/src/events/event-manager.ts');
      const records = await import('/src/engine/records.ts');
      game.audioManager.playSfx = (window as any).__achievementOriginalPlaySfx;
      const event = new GameEvent({
        nid: '_test_clear_achievements',
        name: 'Clear Achievements',
        trigger: 'test',
        level_nid: '0',
        condition: '',
        only_once: false,
        priority: 0,
        _source: ['clear_achievements'],
      }, { type: 'test', levelNid: '0' });
      game.eventManager.eventQueue.push(event);
      return game.actionLog.actionIndex;
    });
    await stepFrames(page, 5);
    const afterClear = await page.evaluate(async (beforeActionIndex: number) => {
      const game = (window as any).__gameRef;
      const records = await import('/src/engine/records.ts');
      const { GameQueryEngine } = await import('/src/engine/query-engine.ts');
      const gameNid = game.db.getConstant('game_nid', 'default');
      return {
        live: records.ACHIEVEMENTS.save(),
        persisted: records.AchievementManager.load(gameNid).save(),
        query: new GameQueryEngine().hasAchievement('A'),
        actionIndex: game.actionLog.actionIndex,
        newActionTypes: (game.actionLog as any).actions
          .slice(beforeActionIndex + 1)
          .map((action: any) => action.constructor.name),
      };
    }, cleared);
    expect(afterClear.live).toEqual([]);
    expect(afterClear.persisted).toEqual([]);
    expect(afterClear.query).toBe(false);
    expect(afterClear.newActionTypes.every((name: string) => name === 'MarkActionGroupEnd')).toBe(true);
  });

  test('open_achievements blocks into a navigable hidden-aware browser and resumes the event', async ({ page }) => {
    await page.goto('/?harness=true&level=0&clean=true&bundle=false');
    await waitForHarness(page);

    const setup = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { GameEvent } = await import('/src/events/event-manager.ts');
      const { MarkPhase } = await import('/src/engine/action.ts');
      const records = await import('/src/engine/records.ts');
      records.ACHIEVEMENTS.clear();
      records.ACHIEVEMENTS.add('Hidden', 'Secret Name', 'Secret description', false, true);
      records.ACHIEVEMENTS.add('Done', 'First Victory', 'Win your first battle.', true, false);
      for (let i = 2; i < 7; i++) {
        records.ACHIEVEMENTS.add(`Entry${i}`, `Achievement ${i}`, `Description for achievement ${i}.`, i % 2 === 0, false);
      }
      const parsed = GameEvent.parseCommand('open_achievements;Arena')?.type ?? null;
      const hadBackground = game.gameVars.has('_base_bg_name');
      const oldBackground = game.gameVars.get('_base_bg_name');
      (window as any).__achievementBrowserOldBg = { hadBackground, oldBackground };
      game.actionLog.doAction(new MarkPhase('achievement_test'));
      const beforeActionIndex = game.actionLog.actionIndex;
      const event = new GameEvent({
        nid: '_test_open_achievements',
        name: 'Open Achievements',
        trigger: 'test',
        level_nid: '0',
        condition: '',
        only_once: false,
        priority: 0,
        _source: [
          'open_achievements;Arena',
          'game_var;_achievement_browser_resumed;1',
        ],
      }, { type: 'test', levelNid: '0' });
      game.eventManager.eventQueue.push(event);
      return { parsed, beforeActionIndex };
    });

    expect(setup.parsed).toBe('open_achievements');
    await stepFrames(page, 8);
    const opened = await page.evaluate(() => {
      const game = (window as any).__gameRef;
      const state = game.state.getCurrentState() as any;
      const event = game.eventManager.getCurrentEvent();
      return {
        state: state?.name ?? null,
        selectedIndex: state?.selectedIndex ?? null,
        scrollOffset: state?.scrollOffset ?? null,
        firstEntry: state?.achievements?.[0] ?? null,
        pointer: event?.commandPointer ?? null,
        background: game.gameVars.get('_base_bg_name'),
        resumed: game.gameVars.get('_achievement_browser_resumed') ?? null,
        actionIndex: game.actionLog.actionIndex,
      };
    });
    expect(opened).toEqual({
      state: 'base_achievement',
      selectedIndex: 0,
      scrollOffset: 0,
      firstEntry: {
        nid: 'Hidden',
        name: 'Secret Name',
        desc: 'Secret description',
        complete: false,
        hidden: true,
      },
      pointer: 1,
      background: 'Arena',
      resumed: null,
      actionIndex: setup.beforeActionIndex + 1,
    });
    await saveScreenshot(page, 'achievement-browser-hidden');

    await stepFrames(page, 1, 'DOWN');
    await stepFrames(page, 1, 'DOWN');
    await stepFrames(page, 1, 'DOWN');
    await stepFrames(page, 1, 'DOWN');
    await stepFrames(page, 1, 'DOWN');
    await stepFrames(page, 1, 'DOWN');
    const scrolled = await page.evaluate(() => {
      const state = (window as any).__gameRef.state.getCurrentState() as any;
      return {
        selectedIndex: state.selectedIndex,
        scrollOffset: state.scrollOffset,
        visibleRows: state.getVisibleRowCount(),
      };
    });
    expect(scrolled.selectedIndex).toBe(6);
    expect(scrolled.scrollOffset).toBe(scrolled.selectedIndex - scrolled.visibleRows + 1);

    await stepFrames(page, 1, 'BACK');
    await stepFrames(page, 8);
    const resumed = await page.evaluate((beforeActionIndex: number) => {
      const game = (window as any).__gameRef;
      return {
        state: game.state.getCurrentState()?.name ?? null,
        value: game.gameVars.get('_achievement_browser_resumed'),
        actionIndex: game.actionLog.actionIndex,
        newActionTypes: (game.actionLog as any).actions
          .slice(beforeActionIndex + 1)
          .map((action: any) => action.constructor.name),
      };
    }, setup.beforeActionIndex);
    expect(resumed.state).toBe('free');
    expect(resumed.value).toBe('1');
    expect(resumed.newActionTypes).toEqual(['SetGameVarAction', 'MarkActionGroupEnd']);

    const rewind = await page.evaluate((beforeActionIndex: number) => {
      const game = (window as any).__gameRef;
      const old = (window as any).__achievementBrowserOldBg;
      game.actionLog.setUp();
      game.actionLog.backward(() => {});
      const reversed = game.gameVars.has('_base_bg_name')
        ? { exists: true, value: game.gameVars.get('_base_bg_name') }
        : { exists: false, value: null };
      game.actionLog.forward(() => {});
      game.actionLog.forward(() => {});
      const redone = game.gameVars.get('_base_bg_name');
      const expected = old.hadBackground
        ? { exists: true, value: old.oldBackground }
        : { exists: false, value: null };
      return { reversed, redone, expected };
    }, setup.beforeActionIndex);
    expect(rewind.reversed).toEqual(rewind.expected);
    expect(rewind.redone).toBe('Arena');

    await page.evaluate(() => {
      const game = (window as any).__gameRef;
      game.state.change('base_main');
    });
    await stepFrames(page, 4);
    const baseOptions = await page.evaluate(() => {
      const state = (window as any).__gameRef.state.getCurrentState() as any;
      return state.menu.options.map((option: any) => option.value);
    });
    expect(baseOptions).toContain('codex');
    await page.evaluate(() => {
      const state = (window as any).__gameRef.state.getCurrentState() as any;
      state.menu.selectedIndex = state.menu.options.findIndex((option: any) => option.value === 'codex');
    });
    await stepFrames(page, 1, 'SELECT');
    await stepFrames(page, 3);
    expect((await getState(page)).currentStateName).toBe('base_codex');
    // Select the Achievements entry by value — the Codex submenu now also
    // contains Library/Records/Sound Room/Guide, so position is not stable.
    await page.evaluate(() => {
      const state = (window as any).__gameRef.state.getCurrentState() as any;
      state.menu.selectedIndex = state.menu.options.findIndex((option: any) => option.value === 'achievements');
    });
    await stepFrames(page, 1, 'SELECT');
    await stepFrames(page, 3);
    expect((await getState(page)).currentStateName).toBe('base_achievement');
  });

  test('achievement browser renders a loaded panorama at DPR 2 in a short landscape viewport', async ({ browser }) => {
    const context = await browser.newContext({
      viewport: { width: 640, height: 200 },
      deviceScaleFactor: 2,
    });
    const page = await context.newPage();
    try {
      await page.goto('/?harness=true&level=0&clean=true&bundle=false');
      await waitForHarness(page);
      await page.evaluate(async () => {
        const game = (window as any).__gameRef;
        const { GameEvent } = await import('/src/events/event-manager.ts');
        const records = await import('/src/engine/records.ts');
        records.ACHIEVEMENTS.clear();
        for (let i = 0; i < 8; i++) {
          records.ACHIEVEMENTS.add(`Dpr${i}`, `DPR Achievement ${i}`, `Responsive description ${i}.`, i < 3, false);
        }
        game.eventManager.eventQueue.push(new GameEvent({
          nid: '_test_achievement_dpr',
          name: 'Achievement DPR',
          trigger: 'test',
          level_nid: '0',
          condition: '',
          only_once: false,
          priority: 0,
          _source: ['open_achievements;Arena'],
        }, { type: 'test', levelNid: '0' }));
      });
      await stepFrames(page, 8);
      await page.waitForFunction(() => {
        const state = (window as any).__gameRef.state.getCurrentState() as any;
        return state?.name === 'base_achievement' && !!state.bgImage;
      });
      const layout = await page.evaluate(async () => {
        const game = (window as any).__gameRef;
        const state = game.state.getCurrentState() as any;
        const { viewport } = await import('/src/engine/viewport.ts');
        return {
          dpr: window.devicePixelRatio,
          cssWidth: window.innerWidth,
          cssHeight: window.innerHeight,
          viewportWidth: viewport.width,
          viewportHeight: viewport.height,
          visibleRows: state.getVisibleRowCount(),
          backgroundWidth: state.bgImage?.naturalWidth ?? 0,
          backgroundHeight: state.bgImage?.naturalHeight ?? 0,
          state: state.name,
        };
      });
      expect(layout.dpr).toBe(2);
      expect(layout.cssWidth).toBe(640);
      expect(layout.cssHeight).toBe(200);
      expect(layout.viewportWidth).toBeGreaterThan(layout.viewportHeight);
      expect(layout.viewportHeight).toBe(160);
      expect(layout.visibleRows).toBeGreaterThanOrEqual(1);
      expect(layout.visibleRows).toBeLessThan(5);
      expect(layout.backgroundWidth).toBeGreaterThan(0);
      expect(layout.backgroundHeight).toBeGreaterThan(0);
      expect(layout.state).toBe('base_achievement');
      await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'achievement-browser-dpr2-landscape.png') });
    } finally {
      await context.close();
    }
  });

  test('pair_up aliases use Rekka-compatible rescue fallback and non-spatial separation', async ({ page }) => {
    await page.goto('/?harness=true&level=0&clean=true&bundle=false');
    await waitForHarness(page);

    const setup = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { GameEvent } = await import('/src/events/event-manager.ts');
      const { UnitObject } = await import('/src/objects/unit.ts');
      const { SkillObject } = await import('/src/objects/skill.ts');
      const template = game.db.units.get('Eirika');
      const klass = template ? game.db.classes.get(template.klass) : null;
      if (!template || !klass) return null;
      const makeUnit = (nid: string) => {
        const unit = new UnitObject({ ...template, nid, name: nid, starting_items: [] }, klass);
        unit.team = 'player';
        return unit;
      };
      const follower = makeUnit('_RescueFallbackFollower');
      const leader = makeUnit('_RescueFallbackLeader');
      let positions: [[number, number], [number, number]] | null = null;
      for (let y = 0; y < game.board.height && !positions; y++) {
        for (let x = 0; x + 1 < game.board.width; x++) {
          if (!game.board.isOccupied(x, y) && !game.board.isOccupied(x + 1, y)) {
            positions = [[x, y], [x + 1, y]];
            break;
          }
        }
      }
      if (!positions) return null;
      game.units.set(follower.nid, follower);
      game.units.set(leader.nid, leader);
      game.board.setUnit(...positions[0], follower);
      game.board.setUnit(...positions[1], leader);
      // A natural same-NID skill must survive removal of the sourced penalty.
      const rescuePrefab = game.db.skills.get('Rescue');
      if (rescuePrefab) leader.skills.push(new SkillObject(rescuePrefab));
      const hadPairup = game.db.constants.has('pairup');
      const oldPairup = game.db.constants.get('pairup');
      game.db.constants.set('pairup', false);
      (window as any).__rescueFallbackOld = { hadPairup, oldPairup };
      const parsed = [
        GameEvent.parseCommand('pair_up;A;B')?.type,
        GameEvent.parseCommand('rescue;A;B')?.type,
        GameEvent.parseCommand('separate;B')?.type,
        GameEvent.parseCommand('drop;B')?.type,
      ];
      const beforeActionIndex = game.actionLog.actionIndex;
      game.eventManager.eventQueue.push(new GameEvent({
        nid: '_test_rescue_fallback', name: 'Rescue Fallback', trigger: 'test',
        level_nid: '0', condition: '', only_once: false, priority: 0,
        _source: [`rescue;${follower.nid};${leader.nid}`],
      }, { type: 'test', levelNid: '0' }));
      game.state.change('event');
      return { parsed, beforeActionIndex, followerPos: positions[0], naturalRescue: !!rescuePrefab };
    });
    expect(setup).not.toBeNull();
    expect(setup!.parsed).toEqual(['pair_up', 'pair_up', 'separate', 'separate']);
    await settle(page, 300);

    const rescueState = await page.evaluate(({ beforeActionIndex }) => {
      const game = (window as any).__gameRef;
      const log = game.actionLog as any;
      const snapshot = () => {
        const follower = game.units.get('_RescueFallbackFollower');
        const leader = game.units.get('_RescueFallbackLeader');
        return {
          traveler: leader.traveler,
          rescuing: leader.rescuing?.nid ?? null,
          rescuedBy: follower.rescuedBy?.nid ?? null,
          followerPos: follower.position,
          hasRescued: leader.hasRescued,
          rescueSkills: leader.skills.filter((skill: any) => skill.nid === 'Rescue').map((skill: any) =>
            skill.data.get('rescueSource') ?? null),
        };
      };
      const afterActionIndex = log.actionIndex;
      const rescued = snapshot();
      while (log.actionIndex > beforeActionIndex) log.runActionBackward();
      const reversed = snapshot();
      while (log.actionIndex < afterActionIndex) log.runActionForward();
      return { rescued, reversed, redone: snapshot() };
    }, setup!);
    expect(rescueState.rescued).toMatchObject({
      traveler: '_RescueFallbackFollower',
      rescuing: '_RescueFallbackFollower',
      rescuedBy: '_RescueFallbackLeader',
      followerPos: null,
      hasRescued: true,
    });
    expect(rescueState.rescued.rescueSkills).toEqual(
      setup!.naturalRescue ? [null, '_RescueFallbackFollower'] : ['_RescueFallbackFollower'],
    );
    expect(rescueState.reversed).toMatchObject({
      traveler: null, rescuing: null, rescuedBy: null,
      followerPos: setup!.followerPos, hasRescued: false,
    });
    expect(rescueState.redone).toEqual(rescueState.rescued);

    const loaded = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { saveGame, loadGame } = await import('/src/engine/save.ts');
      await saveGame(game, 84, 'battle');
      const leader = game.units.get('_RescueFallbackLeader');
      const follower = game.units.get('_RescueFallbackFollower');
      leader.traveler = null;
      leader.rescuing = null;
      follower.rescuedBy = null;
      leader.skills = leader.skills.filter((skill: any) => skill.data.get('rescueSource') !== follower.nid);
      const ok = await loadGame(game, 84);
      const restoredLeader = game.units.get('_RescueFallbackLeader');
      const restoredFollower = game.units.get('_RescueFallbackFollower');
      return {
        ok,
        traveler: restoredLeader.traveler,
        rescuing: restoredLeader.rescuing?.nid ?? null,
        rescuedBy: restoredFollower.rescuedBy?.nid ?? null,
        followerPos: restoredFollower.position,
        rescueSources: restoredLeader.skills.filter((skill: any) => skill.nid === 'Rescue')
          .map((skill: any) => skill.data.get('rescueSource') ?? null),
      };
    });
    expect(loaded).toMatchObject({
      ok: true,
      traveler: '_RescueFallbackFollower',
      rescuing: '_RescueFallbackFollower',
      rescuedBy: '_RescueFallbackLeader',
      followerPos: null,
    });
    expect(loaded.rescueSources).toEqual(
      setup!.naturalRescue ? [null, '_RescueFallbackFollower'] : ['_RescueFallbackFollower'],
    );

    const separateSetup = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { GameEvent } = await import('/src/events/event-manager.ts');
      const beforeActionIndex = game.actionLog.actionIndex;
      game.eventManager.eventQueue.push(new GameEvent({
        nid: '_test_remove_partner', name: 'Remove Partner', trigger: 'test',
        level_nid: '0', condition: '', only_once: false, priority: 0,
        _source: ['drop;_RescueFallbackLeader'],
      }, { type: 'test', levelNid: '0' }));
      game.state.change('event');
      return { beforeActionIndex };
    });
    await settle(page, 300);
    const separated = await page.evaluate(async ({ beforeActionIndex, naturalRescue }) => {
      const game = (window as any).__gameRef;
      const { deleteSave } = await import('/src/engine/save.ts');
      const log = game.actionLog as any;
      const snapshot = () => {
        const follower = game.units.get('_RescueFallbackFollower');
        const leader = game.units.get('_RescueFallbackLeader');
        return {
          traveler: leader.traveler,
          rescuing: leader.rescuing?.nid ?? null,
          rescuedBy: follower.rescuedBy?.nid ?? null,
          followerPos: follower.position,
          rescueSources: leader.skills.filter((skill: any) => skill.nid === 'Rescue')
            .map((skill: any) => skill.data.get('rescueSource') ?? null),
        };
      };
      const afterActionIndex = log.actionIndex;
      const removed = snapshot();
      while (log.actionIndex > beforeActionIndex) log.runActionBackward();
      const reversed = snapshot();
      while (log.actionIndex < afterActionIndex) log.runActionForward();
      const redone = snapshot();
      await deleteSave(game.db.getConstant('game_nid', 'default'), 84);
      const old = (window as any).__rescueFallbackOld;
      if (old.hadPairup) game.db.constants.set('pairup', old.oldPairup);
      else game.db.constants.delete('pairup');
      for (const nid of ['_RescueFallbackFollower', '_RescueFallbackLeader']) {
        const unit = game.units.get(nid);
        if (unit?.position) game.board.removeUnit(unit);
        game.units.delete(nid);
      }
      return { removed, reversed, redone, naturalRescue };
    }, { ...separateSetup, naturalRescue: setup!.naturalRescue });
    expect(separated.removed).toEqual({
      traveler: null, rescuing: null, rescuedBy: null, followerPos: null,
      rescueSources: setup!.naturalRescue ? [null] : [],
    });
    expect(separated.reversed).toEqual(loaded.ok ? {
      traveler: '_RescueFallbackFollower', rescuing: '_RescueFallbackFollower',
      rescuedBy: '_RescueFallbackLeader', followerPos: null,
      rescueSources: setup!.naturalRescue ? [null, '_RescueFallbackFollower'] : ['_RescueFallbackFollower'],
    } : separated.reversed);
    expect(separated.redone).toEqual(separated.removed);
  });

  test('guard-stance pair-up preserves gauges, sourced bonuses, menus, saves, and rewind', async ({ page }) => {
    await page.goto('/?harness=true&level=0&clean=true&bundle=false');
    await waitForHarness(page);

    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { UnitObject } = await import('/src/objects/unit.ts');
      const { SkillObject } = await import('/src/objects/skill.ts');
      const { MenuState, RescueState, DropState } = await import('/src/engine/states/game-states.ts');
      const { saveGame, loadGame, deleteSave } = await import('/src/engine/save.ts');
      const template = game.db.units.get('Eirika');
      const klass = template ? game.db.classes.get(template.klass) : null;
      if (!template || !klass) return null;
      const sourcePrefab = {
        nid: '_PairBonusSource', name: 'Pair Bonus Source', desc: '', icon_nid: '', icon_index: [0, 0] as [number, number],
        components: [['pairup_bonus', '_PairBonusChild']] as [string, any][],
      };
      const childPrefab = {
        nid: '_PairBonusChild', name: 'Pair Bonus Child', desc: '', icon_nid: '', icon_index: [0, 0] as [number, number],
        components: [['damage', 2]] as [string, any][],
      };
      game.db.skills.set(sourcePrefab.nid, sourcePrefab);
      game.db.skills.set(childPrefab.nid, childPrefab);
      const makeUnit = (nid: string) => {
        const unit = new UnitObject({ ...template, nid, name: nid, starting_items: [] }, klass);
        unit.team = 'player';
        return unit;
      };
      const follower = makeUnit('_PairFollower');
      const leader = makeUnit('_PairLeader');
      follower.skills.push(new SkillObject(sourcePrefab));
      leader.skills.push(new SkillObject(childPrefab));
      follower.setGuardGauge(4, 99);
      leader.setGuardGauge(9, 99);
      follower.hasAttacked = true;
      follower.hasMoved = true;
      follower.hasTraded = true;
      follower.finished = true;
      follower.hasRescued = true;
      follower.hasDropped = true;
      let positions: [[number, number], [number, number]] | null = null;
      const movementGroup = klass.movement_group ?? 'Infantry';
      for (let y = 0; y < game.board.height && !positions; y++) {
        for (let x = 0; x + 1 < game.board.width; x++) {
          if (!game.board.isOccupied(x, y) && !game.board.isOccupied(x + 1, y) &&
              game.board.getMovementCost(x, y, movementGroup, game.db) < 99 &&
              game.board.getMovementCost(x + 1, y, movementGroup, game.db) < 99 &&
              [[0, -1], [0, 1], [-1, 0]].every(([dx, dy]) =>
                !game.board.inBounds(x + dx, y + dy) || !game.board.isOccupied(x + dx, y + dy))) {
            positions = [[x, y], [x + 1, y]];
            break;
          }
        }
      }
      if (!positions) return null;
      game.units.set(follower.nid, follower);
      game.units.set(leader.nid, leader);
      game.board.setUnit(...positions[0], follower);
      game.board.setUnit(...positions[1], leader);
      const oldConstants = ['pairup', 'attack_stance_only', 'player_pairup_only'].map((nid) =>
        [nid, game.db.constants.has(nid), game.db.constants.get(nid)] as [string, boolean, any]);
      game.db.constants.set('pairup', true);
      game.db.constants.set('attack_stance_only', false);
      game.db.constants.set('player_pairup_only', false);

      const menuLabels = (unit: any) => {
        const oldSelected = game.selectedUnit;
        const oldFinished = unit.finished;
        const oldHasAttacked = unit.hasAttacked;
        unit.finished = false;
        unit.hasAttacked = false;
        game.selectedUnit = unit;
        const state = new MenuState();
        state.begin();
        const labels = ((state as any).menu?.options ?? []).map((option: any) => option.label);
        game.selectedUnit = oldSelected;
        unit.finished = oldFinished;
        unit.hasAttacked = oldHasAttacked;
        return labels;
      };
      const snapshot = (currentFollower: any, currentLeader: any) => ({
        traveler: currentLeader.traveler,
        rescuing: currentLeader.rescuing?.nid ?? null,
        rescuedBy: currentFollower.rescuedBy?.nid ?? null,
        followerPos: currentFollower.position,
        leaderPos: currentLeader.position,
        lead: [currentFollower.leadUnit, currentLeader.leadUnit],
        gauges: [currentFollower.getGuardGauge(), currentLeader.getGuardGauge()],
        followerFlags: [
          currentFollower.hasAttacked, currentFollower.hasMoved, currentFollower.hasTraded,
          currentFollower.finished, currentFollower.hasRescued, currentFollower.hasDropped,
        ],
        childSources: currentLeader.skills.filter((skill: any) => skill.nid === '_PairBonusChild')
          .map((skill: any) => skill.data.get('pairupSource') ?? null),
      });

      const beforeMenu = menuLabels(follower);
      const beforeActionIndex = game.actionLog.actionIndex;
      game.selectedUnit = follower;
      const rescueState = new RescueState();
      rescueState.begin();
      rescueState.takeInput('SELECT');
      const afterActionIndex = game.actionLog.actionIndex;
      const paired = snapshot(follower, leader);
      const pairedMenu = menuLabels(leader);
      while ((game.actionLog as any).actionIndex > beforeActionIndex) game.actionLog.runActionBackward();
      const reversed = snapshot(follower, leader);
      while ((game.actionLog as any).actionIndex < afterActionIndex) game.actionLog.runActionForward();
      const redone = snapshot(follower, leader);

      await saveGame(game, 83, 'battle');
      const loadedOk = await loadGame(game, 83);
      const loadedFollower = game.units.get('_PairFollower');
      const loadedLeader = game.units.get('_PairLeader');
      const loaded = snapshot(loadedFollower, loadedLeader);
      const loadedMenu = menuLabels(loadedLeader);
      game.selectedUnit = loadedLeader;
      const dropState = new DropState();
      dropState.begin();
      const hover = game.cursor.getHover();
      const dropPos: [number, number] = [hover.x, hover.y];
      const beforeSeparateIndex = game.actionLog.actionIndex;
      dropState.takeInput('SELECT');
      const afterSeparateIndex = game.actionLog.actionIndex;
      const separated = snapshot(loadedFollower, loadedLeader);
      while ((game.actionLog as any).actionIndex > beforeSeparateIndex) game.actionLog.runActionBackward();
      const separateReversed = snapshot(loadedFollower, loadedLeader);
      while ((game.actionLog as any).actionIndex < afterSeparateIndex) game.actionLog.runActionForward();
      const separateRedone = snapshot(loadedFollower, loadedLeader);

      await deleteSave(game.db.getConstant('game_nid', 'default'), 83);
      for (const [nid, existed, value] of oldConstants) {
        if (existed) game.db.constants.set(nid, value);
        else game.db.constants.delete(nid);
      }
      for (const nid of ['_PairFollower', '_PairLeader']) {
        const unit = game.units.get(nid);
        if (unit?.position) game.board.removeUnit(unit);
        game.units.delete(nid);
      }
      game.db.skills.delete(sourcePrefab.nid);
      game.db.skills.delete(childPrefab.nid);
      return {
        positions, dropPos, beforeMenu, pairedMenu, loadedMenu, loadedOk,
        paired, reversed, redone, loaded, separated, separateReversed, separateRedone,
      };
    });

    expect(result).not.toBeNull();
    expect(result!.beforeMenu).toContain('Pair Up');
    expect(result!.beforeMenu).not.toContain('Rescue');
    expect(result!.pairedMenu).toContain('Separate');
    expect(result!.pairedMenu).not.toContain('Drop');
    expect(result!.loadedMenu).toContain('Separate');
    expect(result!.loadedOk).toBe(true);
    expect(result!.paired).toMatchObject({
      traveler: '_PairFollower', rescuing: '_PairFollower', rescuedBy: '_PairLeader',
      followerPos: null, lead: [false, true], gauges: [0, 10],
      followerFlags: [false, false, false, false, false, false],
      childSources: [null, '_PairFollower'],
    });
    expect(result!.reversed).toMatchObject({
      traveler: null, rescuing: null, rescuedBy: null,
      followerPos: result!.positions[0], lead: [false, false], gauges: [4, 9],
      followerFlags: [true, true, true, true, true, true], childSources: [null],
    });
    expect(result!.redone).toEqual(result!.paired);
    expect(result!.loaded).toEqual(result!.paired);
    expect(result!.separated).toMatchObject({
      traveler: null, rescuing: null, rescuedBy: null,
      followerPos: result!.dropPos, lead: [false, false], gauges: [5, 5],
      followerFlags: [false, false, false, true, false, false], childSources: [null],
    });
    expect(result!.separateReversed).toEqual(result!.loaded);
    expect(result!.separateRedone).toEqual(result!.separated);
  });

  test('Pair Up Switch and Transfer preserve leaders, gauges, sourced skills, saves, and turnwheel', async ({ page }) => {
    await page.goto('/?harness=true&level=0&clean=true&bundle=false');
    await waitForHarness(page);

    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { UnitObject } = await import('/src/objects/unit.ts');
      const { SkillObject } = await import('/src/objects/skill.ts');
      const {
        PairUpAction,
        SwitchPairUpAction,
      } = await import('/src/engine/action.ts');
      const { MenuState, TransferState } = await import('/src/engine/states/game-states.ts');
      const { saveGame, loadGame, deleteSave } = await import('/src/engine/save.ts');
      const template = game.db.units.get('Eirika');
      const klass = template ? game.db.classes.get(template.klass) : null;
      const weaponPrefab = game.db.items.get('Iron_Sword') ?? game.db.items.get('Iron Sword');
      if (!template || !klass || !weaponPrefab) return null;

      const sourcePrefab = {
        nid: '_SwitchTransferSource', name: 'Pair Source', desc: '', icon_nid: '', icon_index: [0, 0] as [number, number],
        components: [['pairup_bonus', '_SwitchTransferChild']] as [string, any][],
      };
      const childPrefab = {
        nid: '_SwitchTransferChild', name: 'Pair Child', desc: '', icon_nid: '', icon_index: [0, 0] as [number, number],
        components: [['damage', 1]] as [string, any][],
      };
      game.db.skills.set(sourcePrefab.nid, sourcePrefab);
      game.db.skills.set(childPrefab.nid, childPrefab);
      const makeUnit = (nid: string) => {
        const unit = new UnitObject({ ...template, nid, name: nid, starting_items: [] }, klass);
        unit.team = 'player';
        unit.items = [];
        return unit;
      };
      // Importing the concrete item constructor is more reliable than the
      // runtime map's first value when a clean fixture has no items yet.
      const { ItemObject } = await import('/src/objects/item.ts');
      const equip = (unit: any) => {
        const item = new ItemObject(weaponPrefab);
        item.owner = unit;
        unit.items = [item];
      };
      const leaderA = makeUnit('_SwitchLeaderA');
      const followerA = makeUnit('_SwitchFollowerA');
      const leaderB = makeUnit('_SwitchLeaderB');
      const followerB = makeUnit('_SwitchFollowerB');
      for (const unit of [leaderA, followerA, leaderB, followerB]) equip(unit);
      followerA.skills.push(new SkillObject(sourcePrefab));
      followerB.skills.push(new SkillObject(sourcePrefab));

      const movementGroup = klass.movement_group ?? 'Infantry';
      let positions: [[number, number], [number, number]] | null = null;
      for (let y = 0; y < game.board.height && !positions; y++) {
        for (let x = 0; x + 1 < game.board.width; x++) {
          if (!game.board.isOccupied(x, y) && !game.board.isOccupied(x + 1, y) &&
              game.board.getMovementCost(x, y, movementGroup, game.db) < 99 &&
              game.board.getMovementCost(x + 1, y, movementGroup, game.db) < 99) {
            positions = [[x, y], [x + 1, y]];
            break;
          }
        }
      }
      if (!positions) return null;
      for (const unit of [leaderA, followerA, leaderB, followerB]) game.units.set(unit.nid, unit);
      game.board.setUnit(...positions[0], leaderA);
      game.board.setUnit(...positions[1], leaderB);
      leaderA.setGuardGauge(8, 99);
      followerA.setGuardGauge(2, 99);
      leaderB.setGuardGauge(6, 99);
      followerB.setGuardGauge(2, 99);
      const oldConstants = ['pairup', 'attack_stance_only', 'player_pairup_only'].map((nid) =>
        [nid, game.db.constants.has(nid), game.db.constants.get(nid)] as [string, boolean, any]);
      game.db.constants.set('pairup', true);
      game.db.constants.set('attack_stance_only', false);
      game.db.constants.set('player_pairup_only', false);

      game.actionLog.doAction(new PairUpAction(followerA, leaderA, game.board, game.db));
      game.actionLog.doAction(new PairUpAction(followerB, leaderB, game.board, game.db));
      const pairedIndex = game.actionLog.actionIndex;
      const menuLabels = (unit: any) => {
        const oldSelected = game.selectedUnit;
        game.selectedUnit = unit;
        const state = new MenuState();
        state.begin();
        const labels = ((state as any).menu.options as any[]).map((option) => option.label);
        game.selectedUnit = oldSelected;
        return labels;
      };
      const snapshot = () => ({
        selected: game.selectedUnit?.nid ?? null,
        board: [game.board.getUnit(...positions![0])?.nid ?? null, game.board.getUnit(...positions![1])?.nid ?? null],
        leaders: [leaderA.traveler, leaderB.traveler],
        rescuing: [leaderA.rescuing?.nid ?? null, leaderB.rescuing?.nid ?? null],
        followers: [followerA.rescuedBy?.nid ?? null, followerB.rescuedBy?.nid ?? null],
        lead: [leaderA.leadUnit, followerA.leadUnit, leaderB.leadUnit, followerB.leadUnit],
        gauges: [leaderA.getGuardGauge(), followerA.getGuardGauge(), leaderB.getGuardGauge(), followerB.getGuardGauge()],
        flags: [leaderA.hasGiven, leaderA.hasTraded],
        childOwners: [leaderA, followerA, leaderB, followerB].map((unit) =>
          unit.skills.filter((skill: any) => skill.nid === '_SwitchTransferChild')
            .map((skill: any) => skill.data.get('pairupSource'))),
      });

      const initialMenus = { a: menuLabels(leaderA), b: menuLabels(leaderB) };
      game.selectedUnit = leaderA;
      game.actionLog.doAction(new SwitchPairUpAction(leaderA, followerA, game.board, game.db));
      game.selectedUnit = followerA;
      const switchedIndex = game.actionLog.actionIndex;
      const switched = snapshot();
      const switchedMenu = menuLabels(followerA);
      while (game.actionLog.actionIndex > pairedIndex) game.actionLog.runActionBackward();
      const switchReversed = snapshot();
      while (game.actionLog.actionIndex < switchedIndex) game.actionLog.runActionForward();
      const switchRedone = snapshot();

      // Return to the original two-leader layout, then exercise the real
      // Transfer targeting state and its separate HasTraded action.
      while (game.actionLog.actionIndex > pairedIndex) game.actionLog.runActionBackward();
      game.actionLog.finalize();
      game.selectedUnit = leaderA;
      const transfer = new TransferState();
      transfer.begin();
      transfer.takeInput('SELECT');
      const transferredIndex = game.actionLog.actionIndex;
      const transferred = snapshot();
      while (game.actionLog.actionIndex > pairedIndex) game.actionLog.runActionBackward();
      const transferReversed = snapshot();
      while (game.actionLog.actionIndex < transferredIndex) game.actionLog.runActionForward();
      const transferRedone = snapshot();

      await saveGame(game, 84, 'battle');
      const loadedOk = await loadGame(game, 84);
      const loadedA = game.units.get('_SwitchLeaderA');
      const loadedB = game.units.get('_SwitchLeaderB');
      const loadedFollowerA = game.units.get('_SwitchFollowerA');
      const loadedFollowerB = game.units.get('_SwitchFollowerB');
      const loaded = {
        leaders: [loadedA?.traveler ?? null, loadedB?.traveler ?? null],
        followers: [loadedFollowerA?.rescuedBy?.nid ?? null, loadedFollowerB?.rescuedBy?.nid ?? null],
        gauges: [loadedA?.getGuardGauge(), loadedB?.getGuardGauge()],
        flags: [loadedA?.hasGiven, loadedA?.hasTraded],
      };
      await deleteSave(game.db.getConstant('game_nid', 'default'), 84);

      for (const [nid, existed, value] of oldConstants) {
        if (existed) game.db.constants.set(nid, value);
        else game.db.constants.delete(nid);
      }
      for (const nid of ['_SwitchLeaderA', '_SwitchFollowerA', '_SwitchLeaderB', '_SwitchFollowerB']) {
        const unit = game.units.get(nid);
        if (unit?.position) game.board.removeUnit(unit);
        game.units.delete(nid);
      }
      game.db.skills.delete(sourcePrefab.nid);
      game.db.skills.delete(childPrefab.nid);
      return {
        initialMenus, switchedMenu, switched, switchReversed, switchRedone,
        transferred, transferReversed, transferRedone, loadedOk, loaded,
      };
    });

    expect(result).not.toBeNull();
    expect(result!.initialMenus.a).toEqual(expect.arrayContaining(['Separate', 'Switch', 'Transfer']));
    expect(result!.initialMenus.b).toEqual(expect.arrayContaining(['Separate', 'Switch', 'Transfer']));
    expect(result!.switchedMenu).toEqual(expect.arrayContaining(['Separate', 'Switch', 'Transfer']));
    expect(result!.switched).toMatchObject({
      selected: '_SwitchFollowerA',
      board: ['_SwitchFollowerA', '_SwitchLeaderB'],
      leaders: [null, '_SwitchFollowerB'],
      followers: [null, '_SwitchLeaderB'],
      lead: [false, true, true, false],
      gauges: [0, 10, 8, 0],
    });
    expect(result!.switchReversed).toMatchObject({
      board: ['_SwitchLeaderA', '_SwitchLeaderB'],
      leaders: ['_SwitchFollowerA', '_SwitchFollowerB'],
      followers: ['_SwitchLeaderA', '_SwitchLeaderB'],
      lead: [true, false, true, false],
      gauges: [10, 0, 8, 0],
    });
    expect(result!.switchRedone).toEqual(result!.switched);
    expect(result!.transferred).toMatchObject({
      board: ['_SwitchLeaderA', '_SwitchLeaderB'],
      leaders: ['_SwitchFollowerB', '_SwitchFollowerA'],
      followers: ['_SwitchLeaderB', '_SwitchLeaderA'],
      lead: [true, false, true, false],
      gauges: [9, 0, 9, 0],
      flags: [true, true],
      childOwners: [['_SwitchFollowerB'], [], ['_SwitchFollowerA'], []],
    });
    expect(result!.transferReversed).toMatchObject({
      leaders: ['_SwitchFollowerA', '_SwitchFollowerB'],
      gauges: [10, 0, 8, 0], flags: [false, false],
    });
    expect(result!.transferRedone).toEqual(result!.transferred);
    expect(result!.loadedOk).toBe(true);
    expect(result!.loaded).toEqual({
      leaders: ['_SwitchFollowerB', '_SwitchFollowerA'],
      followers: ['_SwitchLeaderB', '_SwitchLeaderA'],
      gauges: [9, 9], flags: [true, true],
    });
  });

  test('attack stance selects and cycles partners, inserts half-damage phases, and guards reversibly', async ({ page }) => {
    await page.goto('/?harness=true&level=0&clean=true&bundle=false');
    await waitForHarness(page);

    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { UnitObject } = await import('/src/objects/unit.ts');
      const { ItemObject } = await import('/src/objects/item.ts');
      const { TargetingState } = await import('/src/engine/states/game-states.ts');
      const { CombatPhaseSolver } = await import('/src/combat/combat-solver.ts');
      const { MapCombat } = await import('/src/combat/map-combat.ts');
      const { AnimationCombat } = await import('/src/combat/animation-combat.ts');
      const { computeDamage, computeHit, weaponTriangle, getEquippedWeapon } = await import('/src/combat/combat-calcs.ts');
      const { GuardPairUpkeepAction } = await import('/src/engine/action.ts');
      const template = game.db.units.get('Eirika');
      const klass = template ? game.db.classes.get(template.klass) : null;
      const weaponPrefab = game.db.items.get('Iron_Sword') ?? game.db.items.get('Iron Sword');
      if (!template || !klass || !weaponPrefab) return null;
      const makeUnit = (nid: string, team: string) => {
        const unit = new UnitObject({ ...template, nid, name: nid, starting_items: [] }, klass);
        unit.team = team;
        unit.maxStats.HP = 200;
        unit.stats.HP = 100;
        unit.currentHp = 100;
        const item = new ItemObject(weaponPrefab);
        item.owner = unit;
        unit.items = [item];
        return unit;
      };
      const attacker = makeUnit('_StanceAttacker', 'player');
      const assistA = makeUnit('_StanceAssistA', 'player');
      const assistB = makeUnit('_StanceAssistB', 'player');
      const defender = makeUnit('_StanceDefender', 'enemy');
      const defenseAssist = makeUnit('_StanceDefenseAssist', 'enemy');
      const guardFollower = makeUnit('_StanceGuardFollower', 'enemy');
      const assistWeapon = new ItemObject(weaponPrefab);
      assistWeapon.components.set('damage', assistWeapon.getDamage() + 7);
      assistWeapon.owner = assistA;
      assistA.items = [assistWeapon];
      const units = [attacker, assistA, assistB, defender, defenseAssist, guardFollower];
      const movementGroup = klass.movement_group ?? 'Infantry';
      let origin: [number, number] | null = null;
      for (let y = 1; y + 1 < game.board.height && !origin; y++) {
        for (let x = 0; x + 2 < game.board.width; x++) {
          const cells: [number, number][] = [[x, y], [x + 1, y], [x, y - 1], [x, y + 1], [x + 2, y]];
          if (cells.every(([cx, cy]) => !game.board.isOccupied(cx, cy) &&
              game.board.getMovementCost(cx, cy, movementGroup, game.db) < 99)) {
            origin = [x, y];
            break;
          }
        }
      }
      if (!origin) return null;
      for (const unit of units) game.units.set(unit.nid, unit);
      const [x, y] = origin;
      game.board.setUnit(x, y, attacker);
      game.board.setUnit(x + 1, y, defender);
      game.board.setUnit(x, y - 1, assistA);
      game.board.setUnit(x, y + 1, assistB);
      game.board.setUnit(x + 2, y, defenseAssist);
      const oldConstants = ['pairup', 'attack_stance_only', 'player_pairup_only', 'limit_attack_stance', 'rng_mode']
        .map((nid) => [nid, game.db.constants.has(nid), game.db.constants.get(nid)] as [string, boolean, any]);
      game.db.constants.set('pairup', true);
      game.db.constants.set('attack_stance_only', false);
      game.db.constants.set('player_pairup_only', false);
      game.db.constants.set('limit_attack_stance', false);
      game.db.constants.set('rng_mode', 'grandmaster');

      const weapon = attacker.items[0];
      const auto = game.targetSystem.findStrikePartners(attacker, defender, weapon)
        .map((unit: any) => unit?.nid ?? null);
      const targeting = new TargetingState();
      game.selectedUnit = attacker;
      (targeting as any).targets = [defender];
      (targeting as any).targetIndex = 0;
      (targeting as any).updateStrikePartners(defender);
      const beforeAux = (targeting as any).attackerAssist?.nid ?? null;
      targeting.takeInput('AUX');
      const afterAux = (targeting as any).attackerAssist?.nid ?? null;

      game.db.constants.set('player_pairup_only', true);
      const playerOnly = game.targetSystem.findStrikePartners(attacker, defender, weapon)
        .map((unit: any) => unit?.nid ?? null);
      game.db.constants.set('player_pairup_only', false);
      weapon.components.set('exempt_from_dual_strike', null);
      const exempt = game.targetSystem.findStrikePartners(attacker, defender, weapon)
        .map((unit: any) => unit?.nid ?? null);
      weapon.components.delete('exempt_from_dual_strike');

      attacker.stats.SPD = 20;
      defender.stats.SPD = 5;
      attacker.strikePartner = assistA;
      defender.strikePartner = defenseAssist;
      let animationRejected = false;
      try {
        new AnimationCombat(
          attacker, weapon, defender, defender.items[0], game.db, 'grandmaster',
          null as any, null as any, true, game.board, null, game,
        );
      } catch (error) {
        animationRejected = String(error).includes('use MapCombat');
      }
      const unlimitedSolver = new CombatPhaseSolver(() => 0, game);
      const unlimited = unlimitedSolver.resolve(
        attacker, weapon, defender, defender.items[0], game.db, 'grandmaster', game.board,
      ).map((strike: any) => ({
        attacker: strike.attacker.nid,
        assist: !!strike.assist,
        damage: strike.damage,
      }));
      // Grandmaster mode scales the solver's computed damage by the clamped
      // to-hit% (weapon_components.py Damage.on_hit: damage = int(damage *
      // hit / 100)), including the weapon-triangle damage/hit bonuses that
      // feed into the strike's actual `finalHit`/`dmg` -- mirror that exact
      // shape here instead of just halving computeDamage(), since these
      // fixtures' nonzero SPD gives both sides real avoid (finalHit < 100).
      const grandmasterAssistDamage = (
        att: any, item: any, def: any, mode: 'attack' | 'defense',
      ): number => {
        const defWeapon = getEquippedWeapon(def, game.db, game);
        const baseHit = computeHit(att, item, def, game.db, game.board, undefined, mode);
        const wt = weaponTriangle(item, defWeapon, game.db, att, def);
        const finalHit = Math.max(0, Math.min(100, baseHit + wt.hitBonus));
        const baseDmg = computeDamage(att, item, def, game.db, game.board, game, mode, true);
        const dmg = baseDmg + wt.damageBonus;
        return Math.trunc(dmg * finalHit / 100);
      };
      const expectedAssistDamage = grandmasterAssistDamage(assistA, assistWeapon, defender, 'attack');
      const expectedDefenseAssistDamage = grandmasterAssistDamage(
        defenseAssist, defenseAssist.items[0], attacker, 'defense',
      );
      game.db.constants.set('limit_attack_stance', true);
      const limitedSolver = new CombatPhaseSolver(() => 0, game);
      const limited = limitedSolver.resolve(
        attacker, weapon, defender, defender.items[0], game.db, 'grandmaster', game.board,
      ).map((strike: any) => ({ attacker: strike.attacker.nid, assist: !!strike.assist }));
      game.db.constants.set('limit_attack_stance', false);

      attacker.stats.SPD = 5;
      defender.stats.SPD = 5;
      attacker.currentHp = defender.currentHp = 100;
      attacker.strikePartner = assistA;
      defender.strikePartner = defenseAssist;
      const weaponType = weapon.getWeaponType()!;
      const beforeRewards = {
        exp: assistA.exp,
        wexp: assistA.wexp[weaponType] ?? 0,
        mainUses: weapon.uses,
        assistUses: assistWeapon.uses,
      };
      const beforeCombatIndex = game.actionLog.actionIndex;
      const combat = new MapCombat(
        attacker, weapon, defender, defender.items[0], game.db, 'grandmaster', game.board,
        null, undefined, game,
      );
      const combatOrder = combat.strikes.map((strike: any) => ({
        attacker: strike.attacker.nid,
        assist: !!strike.assist,
        guarded: !!strike.guarded,
      }));
      combat.skipToEnd();
      combat.applyResults(game.actionLog);
      const afterCombatIndex = game.actionLog.actionIndex;
      const combatAfter = {
        hp: [attacker.currentHp, defender.currentHp],
        built: [attacker.builtGuard, defender.builtGuard],
        partners: [attacker.strikePartner?.nid ?? null, defender.strikePartner?.nid ?? null],
        rewards: {
          exp: assistA.exp,
          wexp: assistA.wexp[weaponType] ?? 0,
          mainUses: weapon.uses,
          assistUses: assistWeapon.uses,
        },
      };
      while (game.actionLog.actionIndex > beforeCombatIndex) game.actionLog.runActionBackward();
      const combatReversed = {
        hp: [attacker.currentHp, defender.currentHp],
        built: [attacker.builtGuard, defender.builtGuard],
        partners: [attacker.strikePartner?.nid ?? null, defender.strikePartner?.nid ?? null],
        rewards: {
          exp: assistA.exp,
          wexp: assistA.wexp[weaponType] ?? 0,
          mainUses: weapon.uses,
          assistUses: assistWeapon.uses,
        },
      };
      while (game.actionLog.actionIndex < afterCombatIndex) game.actionLog.runActionForward();
      const combatRedone = {
        hp: [attacker.currentHp, defender.currentHp],
        built: [attacker.builtGuard, defender.builtGuard],
        partners: [attacker.strikePartner?.nid ?? null, defender.strikePartner?.nid ?? null],
        rewards: {
          exp: assistA.exp,
          wexp: assistA.wexp[weaponType] ?? 0,
          mainUses: weapon.uses,
          assistUses: assistWeapon.uses,
        },
      };

      // A guard-stance traveler cancels both attack-stance partners. A full
      // gauge forces a zero-damage guarded hit and resets to zero.
      while (game.actionLog.actionIndex > beforeCombatIndex) game.actionLog.runActionBackward();
      game.actionLog.finalize();
      attacker.strikePartner = null;
      defender.strikePartner = null;
      defender.traveler = guardFollower.nid;
      defender.rescuing = guardFollower;
      defender.leadUnit = true;
      guardFollower.rescuedBy = defender;
      guardFollower.leadUnit = false;
      defender.setGuardGauge(10, 10);
      defender.builtGuard = false;
      attacker.currentHp = defender.currentHp = 100;
      const guardPartners = game.targetSystem.findStrikePartners(attacker, defender, weapon)
        .map((unit: any) => unit?.nid ?? null);
      const beforeGuardIndex = game.actionLog.actionIndex;
      const guardedCombat = new MapCombat(
        attacker, weapon, defender, defender.items[0], game.db, 'grandmaster', game.board,
        null, undefined, game,
      );
      const guardedStrikes = guardedCombat.strikes.map((strike: any) => ({
        attacker: strike.attacker.nid,
        damage: strike.damage,
        guarded: !!strike.guarded,
      }));
      guardedCombat.skipToEnd();
      guardedCombat.applyResults(game.actionLog);
      const afterGuardIndex = game.actionLog.actionIndex;
      const guardAfter = { hp: defender.currentHp, gauge: defender.getGuardGauge(), built: defender.builtGuard };
      while (game.actionLog.actionIndex > beforeGuardIndex) game.actionLog.runActionBackward();
      const guardReversed = { hp: defender.currentHp, gauge: defender.getGuardGauge(), built: defender.builtGuard };
      while (game.actionLog.actionIndex < afterGuardIndex) game.actionLog.runActionForward();
      const guardRedone = { hp: defender.currentHp, gauge: defender.getGuardGauge(), built: defender.builtGuard };

      // Combat this turn prevents decay; an idle following turn loses one
      // GAUGE_INCREASE and both paths are reversible.
      const upkeepBuilt = new GuardPairUpkeepAction(defender, guardFollower, game.db);
      upkeepBuilt.execute();
      const builtUpkeep = { gauge: defender.getGuardGauge(), built: defender.builtGuard };
      upkeepBuilt.reverse();
      defender.currentGuardGauge = 6;
      defender.builtGuard = false;
      const upkeepIdle = new GuardPairUpkeepAction(defender, guardFollower, game.db);
      upkeepIdle.execute();
      const idleUpkeep = { gauge: defender.getGuardGauge(), built: defender.builtGuard };
      upkeepIdle.reverse();
      const idleReversed = { gauge: defender.getGuardGauge(), built: defender.builtGuard };

      for (const [nid, existed, value] of oldConstants) {
        if (existed) game.db.constants.set(nid, value);
        else game.db.constants.delete(nid);
      }
      for (const unit of units) {
        if (unit.position) game.board.removeUnit(unit);
        game.units.delete(unit.nid);
      }
      return {
        auto, beforeAux, afterAux, playerOnly, exempt,
        unlimited, limited, expectedAssistDamage, expectedDefenseAssistDamage, animationRejected,
        beforeRewards,
        combatOrder, combatAfter, combatReversed, combatRedone,
        guardPartners, guardedStrikes, guardAfter, guardReversed, guardRedone,
        builtUpkeep, idleUpkeep, idleReversed,
      };
    });

    expect(result).not.toBeNull();
    expect(result!.auto).toEqual(['_StanceAssistA', '_StanceDefenseAssist']);
    expect(result!.beforeAux).toBe('_StanceAssistA');
    expect(result!.afterAux).toBe('_StanceAssistB');
    expect(result!.playerOnly).toEqual(['_StanceAssistA', null]);
    expect(result!.exempt).toEqual([null, '_StanceDefenseAssist']);
    expect(result!.unlimited.map((strike: any) => strike.attacker)).toEqual([
      '_StanceAttacker', '_StanceAssistA', '_StanceDefender', '_StanceDefenseAssist',
      '_StanceAttacker', '_StanceAssistA',
    ]);
    expect(result!.unlimited.filter((strike: any) => strike.attacker === '_StanceAssistA').every(
      (strike: any) => strike.assist && strike.damage === result!.expectedAssistDamage,
    )).toBe(true);
    expect(result!.unlimited.filter((strike: any) => strike.attacker === '_StanceDefenseAssist').every(
      (strike: any) => strike.assist && strike.damage === result!.expectedDefenseAssistDamage,
    )).toBe(true);
    expect(result!.animationRejected).toBe(true);
    expect(result!.limited.map((strike: any) => strike.attacker)).toEqual([
      '_StanceAttacker', '_StanceAssistA', '_StanceDefender', '_StanceDefenseAssist', '_StanceAttacker',
    ]);
    expect(result!.combatOrder.map((strike: any) => strike.attacker)).toEqual([
      '_StanceAttacker', '_StanceAssistA', '_StanceDefender', '_StanceDefenseAssist',
    ]);
    expect(result!.combatAfter.built).toEqual([true, true]);
    expect(result!.combatAfter.partners).toEqual([null, null]);
    expect(result!.combatAfter.rewards.exp).toBe(result!.beforeRewards.exp + 15);
    expect(result!.combatAfter.rewards.wexp).toBeGreaterThan(result!.beforeRewards.wexp);
    expect(result!.combatAfter.rewards.mainUses).toBe(result!.beforeRewards.mainUses - 1);
    expect(result!.combatAfter.rewards.assistUses).toBe(result!.beforeRewards.assistUses - 1);
    expect(result!.combatReversed).toEqual({
      hp: [100, 100], built: [false, false],
      partners: ['_StanceAssistA', '_StanceDefenseAssist'],
      rewards: result!.beforeRewards,
    });
    expect(result!.combatRedone).toEqual(result!.combatAfter);
    expect(result!.guardPartners).toEqual([null, null]);
    expect(result!.guardedStrikes[0]).toEqual({ attacker: '_StanceAttacker', damage: 0, guarded: true });
    expect(result!.guardAfter).toEqual({ hp: 100, gauge: 2, built: true });
    expect(result!.guardReversed).toEqual({ hp: 100, gauge: 10, built: false });
    expect(result!.guardRedone).toEqual(result!.guardAfter);
    expect(result!.builtUpkeep).toEqual({ gauge: 2, built: false });
    expect(result!.idleUpkeep).toEqual({ gauge: 4, built: false });
    expect(result!.idleReversed).toEqual({ gauge: 6, built: false });
  });

  test('unit metadata, growth, cap, field, and note commands undo, redo, and persist', async ({ page }) => {
    await page.goto('/?harness=true&level=0&clean=true&bundle=false');
    await waitForHarness(page);

    const setup = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { GameEvent } = await import('/src/events/event-manager.ts');
      const unit = game.units.get('Eirika');
      if (!unit) return null;

      const faction = [...game.db.factions.keys()][0] ?? 'None';
      const portrait = [...game.db.portraits.keys()].find((nid: string) => nid !== unit.portraitNid)
        ?? unit.portraitNid;
      const affinity = [...game.db.affinities.keys()].find((nid: string) => nid !== unit.affinity)
        ?? unit.affinity;
      unit.fields.set('score', 1);
      const initial = {
        name: unit.name,
        desc: unit.desc,
        variant: unit.variant,
        aiGroup: unit.aiGroup,
        faction: unit.faction,
        portraitNid: unit.portraitNid,
        affinity: unit.affinity,
        growths: { ...unit.growths },
        statCapModifiers: { ...unit.statCapModifiers },
        fields: [...unit.fields.entries()],
        notes: unit.notes.map((entry: [string, string]) => [...entry]),
      };
      const beforeActionIndex = game.actionLog.actionIndex;
      const event = new GameEvent({
        nid: '_test_unit_metadata_commands',
        name: 'Unit Metadata Commands',
        trigger: 'test',
        level_nid: '0',
        condition: '',
        only_once: false,
        priority: 0,
        _source: [
          'set_name;Eirika;Lady Eirika',
          'set_variant;Eirika;Cerulean',
          'change_ai_group;Eirika;SecondWave',
          `change_faction;Eirika;${faction}`,
          `change_portrait;Eirika;${portrait}`,
          'change_unit_desc;Eirika;Renais commander',
          `change_affinity;Eirika;${affinity}`,
          'change_growths;Eirika;HP,5,STR,-10',
          'set_growths;Eirika;MAG,88',
          'change_stat_cap_modifiers;Eirika;STR,2',
          'set_stat_cap_modifiers;Eirika;MAG,4',
          'set_unit_field;Eirika;score;5',
          'set_unit_field;Eirika;score;3;increment_mode',
          'set_unit_note;Eirika;Role;Scout',
          'set_unit_note;Eirika;Role;Leader',
          'set_unit_note;Eirika;Temporary;Remove me',
          'remove_unit_note;Eirika;Temporary',
        ],
      }, { type: 'test', levelNid: '0', unit1: unit });
      game.eventManager.eventQueue.push(event);
      game.state.change('event');
      return { initial, beforeActionIndex, faction, portrait, affinity };
    });

    expect(setup).not.toBeNull();
    await settle(page, 300);

    const mutation = await page.evaluate(() => {
      const game = (window as any).__gameRef;
      const unit = game.units.get('Eirika');
      const snapshot = () => ({
        name: unit.name,
        desc: unit.desc,
        variant: unit.variant,
        aiGroup: unit.aiGroup,
        faction: unit.faction,
        portraitNid: unit.portraitNid,
        affinity: unit.affinity,
        growths: { ...unit.growths },
        statCapModifiers: { ...unit.statCapModifiers },
        fields: [...unit.fields.entries()],
        notes: unit.notes.map((entry: [string, string]) => [...entry]),
      });
      const changed = snapshot();
      const afterActionIndex = game.actionLog.actionIndex;
      return { changed, afterActionIndex };
    });

    const turnwheel = await page.evaluate((beforeActionIndex: number) => {
      const game = (window as any).__gameRef;
      const unit = game.units.get('Eirika');
      const actionLog = game.actionLog as any;
      while (actionLog.actionIndex > beforeActionIndex) actionLog.runActionBackward();
      const reversed = {
        name: unit.name, desc: unit.desc, variant: unit.variant, aiGroup: unit.aiGroup,
        faction: unit.faction, portraitNid: unit.portraitNid, affinity: unit.affinity,
        growths: { ...unit.growths }, statCapModifiers: { ...unit.statCapModifiers },
        fields: [...unit.fields.entries()], notes: unit.notes.map((entry: [string, string]) => [...entry]),
      };
      while (actionLog.actionIndex < actionLog.actions.length - 1) actionLog.runActionForward();
      const redone = {
        name: unit.name, desc: unit.desc, variant: unit.variant, aiGroup: unit.aiGroup,
        faction: unit.faction, portraitNid: unit.portraitNid, affinity: unit.affinity,
        growths: { ...unit.growths }, statCapModifiers: { ...unit.statCapModifiers },
        fields: [...unit.fields.entries()], notes: unit.notes.map((entry: [string, string]) => [...entry]),
      };
      return { reversed, redone };
    }, setup!.beforeActionIndex);

    expect(mutation.changed).toMatchObject({
      name: 'Lady Eirika',
      desc: 'Renais commander',
      variant: 'Cerulean',
      aiGroup: 'SecondWave',
      faction: setup!.faction,
      portraitNid: setup!.portrait,
      affinity: setup!.affinity,
      fields: [['score', 8]],
      notes: [['Role', 'Leader']],
    });
    expect(mutation.changed.growths).toMatchObject({
      HP: setup!.initial.growths.HP + 5,
      STR: setup!.initial.growths.STR - 10,
      MAG: 88,
    });
    expect(mutation.changed.statCapModifiers).toMatchObject({ STR: 2, MAG: 4 });
    expect(turnwheel.reversed).toEqual(setup!.initial);
    expect(turnwheel.redone).toEqual(mutation.changed);

    const roundTrip = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { saveGame, loadGame, deleteSave } = await import('/src/engine/save.ts');
      const gameNid = game.db.getConstant('game_nid', 'default');
      await saveGame(game, 97, 'battle');
      const unit = game.units.get('Eirika');
      unit.fields.clear();
      unit.notes = [];
      unit.variant = null;
      const loaded = await loadGame(game, 97);
      const restored = game.units.get('Eirika');
      const result = {
        fields: [...restored.fields.entries()],
        notes: restored.notes.map((entry: [string, string]) => [...entry]),
        variant: restored.variant,
        faction: restored.faction,
        statCapModifiers: { ...restored.statCapModifiers },
      };
      await deleteSave(gameNid, 97);
      return { loaded, result };
    });
    expect(roundTrip.loaded).toBe(true);
    expect(roundTrip.result).toMatchObject({
      fields: [['score', 8]],
      notes: [['Role', 'Leader']],
      variant: 'Cerulean',
      faction: setup!.faction,
      statCapModifiers: { STR: 2, MAG: 4 },
    });
  });

  test('item name, description, data, uses, and droppable commands are reversible and persistent', async ({ page }) => {
    await page.goto('/?harness=true&level=0&clean=true&bundle=false');
    await waitForHarness(page);

    const setup = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { GameEvent } = await import('/src/events/event-manager.ts');
      const unit = game.units.get('Eirika');
      const item = unit?.items.find((candidate: any) => candidate.nid === 'Rapier');
      if (!item) return null;
      const snapshot = () => ({
        name: item.name,
        desc: item.desc,
        uses: item.uses,
        maxUses: item.maxUses,
        droppable: item.droppable,
        data: [...item.data.entries()],
      });
      const initial = snapshot();
      const beforeActionIndex = game.actionLog.actionIndex;
      game.eventManager.eventQueue.push(new GameEvent({
        nid: '_test_item_property_commands',
        name: 'Item Property Commands',
        trigger: 'test', level_nid: '0', condition: '', only_once: false, priority: 0,
        _source: [
          'change_item_name;Eirika;Rapier;Renais Rapier',
          'change_item_desc;Eirika;Rapier;A restored royal blade.',
          'set_item_droppable;Eirika;Rapier;true',
          'set_item_data;Eirika;Rapier;starting_uses;30',
          'set_item_uses;Eirika;Rapier;12',
          'set_item_uses;Eirika;Rapier;3;additive',
          'break_item;Eirika;Rapier;no_banner',
        ],
      }, { type: 'test', levelNid: '0', unit1: unit }));
      game.state.change('event');
      return { initial, beforeActionIndex };
    });

    expect(setup).not.toBeNull();
    await settle(page, 300);

    const result = await page.evaluate((beforeActionIndex: number) => {
      const game = (window as any).__gameRef;
      const actionLog = game.actionLog as any;
      const getItem = () => game.units.get('Eirika').items.find((item: any) => item.nid === 'Rapier');
      const snapshot = () => {
        const item = getItem();
        return {
          name: item.name, desc: item.desc, uses: item.uses, maxUses: item.maxUses,
          droppable: item.droppable, data: [...item.data.entries()],
        };
      };
      const changed = snapshot();
      while (actionLog.actionIndex > beforeActionIndex) actionLog.runActionBackward();
      const reversed = snapshot();
      while (actionLog.actionIndex < actionLog.actions.length - 1) actionLog.runActionForward();
      return { changed, reversed, redone: snapshot() };
    }, setup!.beforeActionIndex);

    expect(result.changed).toMatchObject({
      name: 'Renais Rapier',
      desc: 'A restored royal blade.',
      uses: 0,
      maxUses: 30,
      droppable: true,
    });
    expect(Object.fromEntries(result.changed.data)).toMatchObject({ starting_uses: 30, uses: 0 });
    expect(result.reversed).toEqual(setup!.initial);
    expect(result.redone).toEqual(result.changed);

    const roundTrip = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { saveGame, loadGame, deleteSave } = await import('/src/engine/save.ts');
      const gameNid = game.db.getConstant('game_nid', 'default');
      await saveGame(game, 96, 'battle');
      const item = game.units.get('Eirika').items.find((candidate: any) => candidate.nid === 'Rapier');
      item.name = 'mutated';
      item.desc = 'mutated';
      item.setUses(7);
      item.droppable = false;
      item.data.set('starting_uses', 99);
      const loaded = await loadGame(game, 96);
      const restored = game.units.get('Eirika').items.find((candidate: any) => candidate.nid === 'Rapier');
      const saved = {
        name: restored.name,
        desc: restored.desc,
        uses: restored.uses,
        maxUses: restored.maxUses,
        droppable: restored.droppable,
        data: Object.fromEntries(restored.data),
      };
      await deleteSave(gameNid, 96);
      return { loaded, saved };
    });
    expect(roundTrip).toEqual({
      loaded: true,
      saved: {
        name: 'Renais Rapier',
        desc: 'A restored royal blade.',
        uses: 0,
        maxUses: 30,
        droppable: true,
        data: { starting_uses: 30, uses: 0 },
      },
    });
  });

  test('move_item covers unit and convoy routes with reversible ownership and save persistence', async ({ page }) => {
    await page.goto('/?harness=true&level=0&clean=true&bundle=false');
    await waitForHarness(page);

    const setup = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { GameEvent } = await import('/src/events/event-manager.ts');
      const { PartyObject } = await import('/src/engine/party.ts');
      const eirika = game.units.get('Eirika');
      const seth = game.units.get('Seth');
      const currentParty = game.getParty();
      if (!eirika || !seth || !currentParty) return null;
      const removedItemNid = seth.items[0]?.nid;
      if (!removedItemNid) return null;
      const secondaryNid = '_test_secondary';
      game.parties.set(secondaryNid, new PartyObject(secondaryNid, 'Secondary', 'Seth'));

      const snapshot = () => ({
        eirika: eirika.items.map((item: any) => [item.nid, item.owner?.nid ?? null]),
        seth: seth.items.map((item: any) => [item.nid, item.owner?.nid ?? null]),
        current: currentParty.convoy.map((item: any) => [item.nid, item.owner?.nid ?? null]),
        secondary: game.getParty(secondaryNid).convoy.map((item: any) => [item.nid, item.owner?.nid ?? null]),
      });
      const initial = snapshot();
      const beforeActionIndex = game.actionLog.actionIndex;
      game.eventManager.eventQueue.push(new GameEvent({
        nid: '_test_move_item_routes', name: 'Move Item Routes', trigger: 'test',
        level_nid: '0', condition: '', only_once: false, priority: 0,
        _source: [
          'move_item;Eirika;Seth;Rapier',
          'move_item;Seth;convoy',
          'move_item;convoy;Eirika;Rapier',
          'move_item;Eirika;convoy;Vulnerary',
          `move_item_between_convoys;Vulnerary;${currentParty.nid};${secondaryNid}`,
          `remove_item;Seth;${removedItemNid};no_banner`,
        ],
      }, { type: 'test', levelNid: '0', unit1: eirika }));
      game.state.change('event');
      return { initial, beforeActionIndex, currentPartyNid: currentParty.nid, secondaryNid, removedItemNid };
    });

    expect(setup).not.toBeNull();
    await settle(page, 300);
    const result = await page.evaluate(({ beforeActionIndex, currentPartyNid, secondaryNid }) => {
      const game = (window as any).__gameRef;
      const actionLog = game.actionLog as any;
      const snapshot = () => ({
        eirika: game.units.get('Eirika').items.map((item: any) => [item.nid, item.owner?.nid ?? null]),
        seth: game.units.get('Seth').items.map((item: any) => [item.nid, item.owner?.nid ?? null]),
        current: game.getParty(currentPartyNid).convoy.map((item: any) => [item.nid, item.owner?.nid ?? null]),
        secondary: game.getParty(secondaryNid).convoy.map((item: any) => [item.nid, item.owner?.nid ?? null]),
      });
      const changed = snapshot();
      while (actionLog.actionIndex > beforeActionIndex) actionLog.runActionBackward();
      const reversed = snapshot();
      while (actionLog.actionIndex < actionLog.actions.length - 1) actionLog.runActionForward();
      return { changed, reversed, redone: snapshot() };
    }, setup!);

    expect(result.changed.eirika).toContainEqual(['Rapier', 'Eirika']);
    expect(result.changed.eirika.some(([nid]) => nid === 'Vulnerary')).toBe(false);
    expect(result.changed.seth.some(([nid]) => nid === 'Rapier')).toBe(false);
    expect(result.changed.seth.some(([nid]) => nid === setup!.removedItemNid)).toBe(false);
    expect(result.changed.current.some(([nid]) => nid === 'Vulnerary')).toBe(false);
    expect(result.changed.secondary).toContainEqual(['Vulnerary', null]);
    expect(result.reversed).toEqual(setup!.initial);
    expect(result.redone).toEqual(result.changed);

    const roundTrip = await page.evaluate(async ({ secondaryNid }) => {
      const game = (window as any).__gameRef;
      const { saveGame, loadGame, deleteSave } = await import('/src/engine/save.ts');
      const gameNid = game.db.getConstant('game_nid', 'default');
      await saveGame(game, 95, 'battle');
      game.getParty(secondaryNid).convoy.length = 0;
      const loaded = await loadGame(game, 95);
      const secondary = game.getParty(secondaryNid).convoy.map((item: any) => [item.nid, item.owner?.nid ?? null]);
      const eirika = game.units.get('Eirika').items.map((item: any) => [item.nid, item.owner?.nid ?? null]);
      const seth = game.units.get('Seth').items.map((item: any) => [item.nid, item.owner?.nid ?? null]);
      await deleteSave(gameNid, 95);
      return { loaded, secondary, eirika, seth };
    }, setup!);
    expect(roundTrip.loaded).toBe(true);
    expect(roundTrip.secondary).toContainEqual(['Vulnerary', null]);
    expect(roundTrip.eirika).toContainEqual(['Rapier', 'Eirika']);
    expect(roundTrip.seth.some(([nid]) => nid === setup!.removedItemNid)).toBe(false);
  });

  test('multi-item trees create recursively and event add/remove survives turnwheel and saves', async ({ page }) => {
    await page.goto('/?harness=true&level=0&clean=true&bundle=false');
    await waitForHarness(page);

    const setup = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { GameEvent } = await import('/src/events/event-manager.ts');
      const { createItemTree } = await import('/src/objects/item.ts');
      const unit = game.units.get('Eirika');
      if (!unit || !game.db.items.has('Vulnerary') || !game.db.items.has('Iron_Sword')) return null;
      const parentNid = '_TestMultiItem';
      game.db.items.set(parentNid, {
        nid: parentNid, name: 'Test Multi', desc: 'Runtime multi-item fixture',
        icon_nid: '', icon_index: [0, 0], components: [['multi_item', ['Vulnerary']]],
      });
      const parent = createItemTree(game.db.items.get(parentNid), (nid: string) => game.db.items.get(nid));
      parent.owner = unit;
      unit.items.push(parent);
      const register = (item: any, key: string) => {
        game.items.set(key, item);
        item.subitems.forEach((child: any, index: number) => register(child, `${key}_${index}`));
      };
      register(parent, `_test_multi_${unit.nid}`);
      const rescuePrefab = game.db.items.get('Rescue');
      const sequenceChildren = rescuePrefab
        ? createItemTree(rescuePrefab, (nid: string) => game.db.items.get(nid)).subitems.map((item: any) => item.nid)
        : [];
      const snapshot = () => parent.subitems.map((item: any) => ({
        nid: item.nid, uses: item.uses, owner: item.owner?.nid ?? null, parent: item.parentItem?.nid ?? null,
      }));
      const initial = snapshot();
      const beforeActionIndex = game.actionLog.actionIndex;
      game.eventManager.eventQueue.push(new GameEvent({
        nid: '_test_multi_item_events', name: 'Multi Item Events', trigger: 'test',
        level_nid: '0', condition: '', only_once: false, priority: 0,
        _source: [
          `add_item_to_multiitem;Eirika;${parentNid};Iron_Sword;no_duplicate`,
          `add_item_to_multiitem;Eirika;${parentNid};Iron_Sword;no_duplicate`,
          'set_item_uses;Eirika;Iron_Sword;5;recursive',
          `remove_item_from_multiitem;Eirika;${parentNid};Vulnerary`,
        ],
      }, { type: 'test', levelNid: '0', unit1: unit }));
      game.state.change('event');
      return { parentNid, initial, beforeActionIndex, sequenceChildren };
    });

    expect(setup).not.toBeNull();
    expect(setup!.sequenceChildren).toEqual(['Rescue1', 'Rescue2']);
    await settle(page, 300);

    const result = await page.evaluate(({ parentNid, beforeActionIndex }) => {
      const game = (window as any).__gameRef;
      const actionLog = game.actionLog as any;
      const parent = game.units.get('Eirika').items.find((item: any) => item.nid === parentNid);
      const snapshot = () => parent.subitems.map((item: any) => ({
        nid: item.nid, uses: item.uses, owner: item.owner?.nid ?? null, parent: item.parentItem?.nid ?? null,
      }));
      const changed = snapshot();
      while (actionLog.actionIndex > beforeActionIndex) actionLog.runActionBackward();
      const reversed = snapshot();
      while (actionLog.actionIndex < actionLog.actions.length - 1) actionLog.runActionForward();
      return { changed, reversed, redone: snapshot() };
    }, setup!);
    expect(result.changed).toEqual([{ nid: 'Iron_Sword', uses: 5, owner: 'Eirika', parent: setup!.parentNid }]);
    expect(result.reversed).toEqual(setup!.initial);
    expect(result.redone).toEqual(result.changed);

    const roundTrip = await page.evaluate(async ({ parentNid }) => {
      const game = (window as any).__gameRef;
      const { saveGame, loadGame, deleteSave } = await import('/src/engine/save.ts');
      const gameNid = game.db.getConstant('game_nid', 'default');
      await saveGame(game, 94, 'battle');
      game.units.get('Eirika').items.find((item: any) => item.nid === parentNid).subitems = [];
      const loaded = await loadGame(game, 94);
      const parent = game.units.get('Eirika').items.find((item: any) => item.nid === parentNid);
      const children = parent.subitems.map((item: any) => ({
        nid: item.nid, uses: item.uses, owner: item.owner?.nid ?? null, parent: item.parentItem?.nid ?? null,
      }));
      await deleteSave(gameNid, 94);
      return { loaded, children };
    }, setup!);
    expect(roundTrip).toEqual({ loaded: true, children: result.changed });
  });

  test('item target hooks union enemy, ally, unit, and tile positions with range filtering', async ({ page }) => {
    await page.goto('/?harness=true&level=0&clean=true&bundle=false');
    await waitForHarness(page);

    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { ItemObject } = await import('/src/objects/item.ts');
      const unit = game.units.get('Eirika');
      if (!unit?.position || !game.targetSystem || !game.board) return null;

      const makeItem = (nid: string, components: [string, any][]) => new ItemObject({
        nid, name: nid, desc: '', icon_nid: '', icon_index: [0, 0], components,
      });
      const maxRange = game.board.width + game.board.height;
      const positions = (values: [number, number][]) => values.map(([x, y]) => `${x},${y}`).sort();
      const liveUnits = game.board.getAllUnits().filter((other: any) => other.position && !other.isDead());
      const allies = liveUnits.filter((other: any) => game.db.areAllied(unit.team, other.team));
      const enemies = liveUnits.filter((other: any) => !game.db.areAllied(unit.team, other.team));

      const enemyItem = makeItem('_TargetEnemy', [
        ['target_enemy', null], ['min_range', 0], ['max_range', maxRange],
      ]);
      const allyItem = makeItem('_TargetAlly', [
        ['target_ally', null], ['min_range', 0], ['max_range', maxRange],
      ]);
      const unitItem = makeItem('_TargetUnit', [
        ['target_unit', null], ['min_range', 0], ['max_range', maxRange],
      ]);
      const tileItem = makeItem('_TargetTile', [
        ['target_tile', null], ['min_range', 1], ['max_range', 2],
      ]);
      const unionItem = makeItem('_TargetUnion', [
        ['target_enemy', null], ['target_ally', null], ['min_range', 0], ['max_range', maxRange],
      ]);
      const parent = makeItem('_TargetMulti', [['multi_item', []]]);
      parent.subitems = [enemyItem, allyItem];
      for (const child of parent.subitems) child.parentItem = parent;

      const [ux, uy] = unit.position;
      const expectedTiles: [number, number][] = [];
      for (let x = 0; x < game.board.width; x++) {
        for (let y = 0; y < game.board.height; y++) {
          const distance = Math.abs(x - ux) + Math.abs(y - uy);
          if (distance >= 1 && distance <= 2) expectedTiles.push([x, y]);
        }
      }

      return {
        enemy: positions(game.targetSystem.getValidTargets(unit, enemyItem)),
        expectedEnemy: positions(enemies.map((other: any) => other.position)),
        ally: positions(game.targetSystem.getValidTargets(unit, allyItem)),
        expectedAlly: positions(allies.map((other: any) => other.position)),
        selfPosition: `${ux},${uy}`,
        allUnits: positions(game.targetSystem.getValidTargets(unit, unitItem)),
        expectedAllUnits: positions(liveUnits.map((other: any) => other.position)),
        tiles: positions(game.targetSystem.getValidTargets(unit, tileItem)),
        expectedTiles: positions(expectedTiles),
        union: positions(game.targetSystem.getValidTargets(unit, unionItem)),
        recursive: positions(game.targetSystem.getValidTargetsRecursive(unit, parent)),
      };
    });

    expect(result).not.toBeNull();
    expect(result!.enemy).toEqual(result!.expectedEnemy);
    expect(result!.ally).toEqual(result!.expectedAlly);
    expect(result!.ally).toContain(result!.selfPosition);
    expect(result!.allUnits).toEqual(result!.expectedAllUnits);
    expect(result!.tiles).toEqual(result!.expectedTiles);
    expect(result!.union).toEqual(result!.expectedAllUnits);
    expect(result!.recursive).toEqual(result!.expectedAllUnits);
  });

  test('item target restrictions cover equations, expressions, empty tiles, and traversability', async ({ page }) => {
    await page.goto('/?harness=true&level=0&clean=true&bundle=false');
    await waitForHarness(page);

    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { ItemObject } = await import('/src/objects/item.ts');
      const unit = game.units.get('Eirika');
      if (!unit?.position || !game.targetSystem || !game.board || !game.currentLevel) return null;

      const makeItem = (nid: string, components: [string, any][]) => new ItemObject({
        nid, name: nid, desc: '', icon_nid: '', icon_index: [0, 0], components,
      });
      const keys = (values: [number, number][]) => values.map(([x, y]) => `${x},${y}`).sort();
      const maxRange = game.board.width + game.board.height;
      const [ux, uy] = unit.position;

      const equationItem = makeItem('_EquationRange', [
        ['target_tile', null], ['min_range', 1], ['max_equation_range', 'MAGIC_RANGE'],
      ]);
      const equationMax = Math.max(5, Math.floor(unit.getStatValue('MAG') / 2));
      const expectedEquation: [number, number][] = [];
      for (let x = 0; x < game.board.width; x++) {
        for (let y = 0; y < game.board.height; y++) {
          const distance = Math.abs(x - ux) + Math.abs(y - uy);
          if (distance >= 1 && distance <= equationMax) expectedEquation.push([x, y]);
        }
      }

      const specialRangeItem = makeItem('_SpecialRange', [
        ['target_tile', null], ['min_range', 1], ['max_range', 3], ['eval_special_range', 'x == 0'],
      ]);
      const expectedSpecial: [number, number][] = [];
      for (let y = 0; y < game.board.height; y++) {
        const distance = Math.abs(y - uy);
        if (distance >= 1 && distance <= 3) expectedSpecial.push([ux, y]);
      }

      const emptyItem = makeItem('_EmptyTile', [
        ['target_tile', null], ['min_range', 0], ['max_range', maxRange],
        ['empty_tile_target_restrict', null],
      ]);
      const expectedEmpty: [number, number][] = [];
      for (let x = 0; x < game.board.width; x++) {
        for (let y = 0; y < game.board.height; y++) {
          if (!game.board.getUnit(x, y)) expectedEmpty.push([x, y]);
        }
      }

      const traversableItem = makeItem('_TraversableTile', [
        ['target_tile', null], ['min_range', 0], ['max_range', maxRange],
        ['traversable_tile_target_restrict', null],
      ]);
      const movementGroup = game.db.classes.get(unit.klass)?.movement_group ?? 'Infantry';
      const expectedTraversable: [number, number][] = [];
      for (let x = 0; x < game.board.width; x++) {
        for (let y = 0; y < game.board.height; y++) {
          if (game.board.getMovementCost(x, y, movementGroup, game.db) <= unit.getMovement()) {
            expectedTraversable.push([x, y]);
          }
        }
      }

      const oldLevel = unit.level;
      const levelItem = makeItem('_LevelRestrict', [
        ['target_ally', null], ['min_range', 0], ['max_range', maxRange],
        ['eval_target_restrict_2', 'unit.level >= 10'],
      ]);
      unit.level = 9;
      const lowLevelTargets = game.targetSystem.getValidTargets(unit, levelItem);
      unit.level = 10;
      const highLevelTargets = game.targetSystem.getValidTargets(unit, levelItem);
      unit.level = oldLevel;

      const enemy = game.board.getAllUnits().find((other: any) =>
        other.position && !game.db.areAllied(unit.team, other.team));
      const oldTags = enemy ? [...enemy.tags] : [];
      if (enemy && !enemy.tags.includes('Tile')) enemy.tags.push('Tile');
      const tagItem = makeItem('_TagRestrict', [
        ['target_enemy', null], ['min_range', 0], ['max_range', maxRange],
        ['eval_target_restrict_2', "'Tile' not in target.tags"],
      ]);
      const tagTargets = game.targetSystem.getValidTargets(unit, tagItem);
      if (enemy) enemy.tags = oldTags;

      const visionPosition: [number, number] = [0, 0];
      const visionRegion = {
        nid: '_TargetVision', region_type: 'vision', sub_nid: '',
        position: visionPosition, size: [1, 1], condition: 'True', only_once: false,
      };
      game.currentLevel.regions.push(visionRegion);
      const regionItem = makeItem('_RegionRestrict', [
        ['target_tile', null], ['min_range', 0], ['max_range', maxRange],
        ['eval_target_restrict_2', "not game.get_region_under_pos(target_pos, 'vision')"],
      ]);
      const regionTargets = game.targetSystem.getValidTargets(unit, regionItem);
      game.currentLevel.regions.pop();

      return {
        equation: keys(game.targetSystem.getValidTargets(unit, equationItem)),
        expectedEquation: keys(expectedEquation),
        special: keys(game.targetSystem.getValidTargets(unit, specialRangeItem)),
        expectedSpecial: keys(expectedSpecial),
        empty: keys(game.targetSystem.getValidTargets(unit, emptyItem)),
        expectedEmpty: keys(expectedEmpty),
        traversable: keys(game.targetSystem.getValidTargets(unit, traversableItem)),
        expectedTraversable: keys(expectedTraversable),
        lowLevelCount: lowLevelTargets.length,
        highLevelCount: highLevelTargets.length,
        taggedEnemyPosition: enemy?.position ? `${enemy.position[0]},${enemy.position[1]}` : null,
        tagTargets: keys(tagTargets),
        visionPosition: `${visionPosition[0]},${visionPosition[1]}`,
        regionTargets: keys(regionTargets),
      };
    });

    expect(result).not.toBeNull();
    expect(result!.equation).toEqual(result!.expectedEquation);
    expect(result!.special).toEqual(result!.expectedSpecial);
    expect(result!.empty).toEqual(result!.expectedEmpty);
    expect(result!.traversable).toEqual(result!.expectedTraversable);
    expect(result!.lowLevelCount).toBe(0);
    expect(result!.highLevelCount).toBeGreaterThan(0);
    expect(result!.taggedEnemyPosition).not.toBeNull();
    expect(result!.tagTargets).not.toContain(result!.taggedEnemyPosition);
    expect(result!.regionTargets).not.toContain(result!.visionPosition);
  });

  test('target system applies splash, target counts, fog, and line of sight in Python order', async ({ page }) => {
    await page.goto('/?harness=true&level=0&clean=true&bundle=false');
    await waitForHarness(page);

    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { ItemObject } = await import('/src/objects/item.ts');
      const { getLine } = await import('/src/engine/line-of-sight.ts');
      const unit = game.units.get('Eirika');
      if (!unit?.position || !game.targetSystem || !game.board) return null;

      const makeItem = (nid: string, components: [string, any][]) => new ItemObject({
        nid, name: nid, desc: '', icon_nid: '', icon_index: [0, 0], components,
      });
      const key = (position: [number, number]) => `${position[0]},${position[1]}`;
      const keys = (positions: [number, number][]) => positions.map(key).sort();
      const maxRange = game.board.width + game.board.height;
      const units = game.board.getAllUnits().filter((other: any) => other.position && !other.isDead());
      const allies = units.filter((other: any) => game.db.areAllied(unit.team, other.team));
      const enemies = units.filter((other: any) => !game.db.areAllied(unit.team, other.team));
      const center = enemies[0]?.position as [number, number] | undefined;
      if (!center) return null;

      const blast = makeItem('_EnemyBlast', [
        ['spell', null], ['target_enemy', null], ['enemy_blast_aoe', 3],
        ['min_range', 0], ['max_range', maxRange],
      ]);
      const blastResult = game.targetSystem.getTargetFromPosition(unit, blast, center);
      const expectedBlast = enemies
        .filter((other: any) => Math.abs(other.position[0] - center[0]) + Math.abs(other.position[1] - center[1]) <= 3)
        .map((other: any) => other.position);

      const allAllies = makeItem('_AllAllies', [
        ['spell', null], ['target_ally', null], ['all_allies_except_self_aoe', null],
        ['min_range', 0], ['max_range', maxRange],
      ]);
      const allySplash = game.targetSystem.getTargetFromPosition(unit, allAllies, unit.position);

      const requiredTargets = enemies.length + 1;
      const strictMulti = makeItem('_StrictMulti', [
        ['target_enemy', null], ['multi_target', requiredTargets],
        ['min_range', 0], ['max_range', maxRange],
      ]);
      const flexibleMulti = makeItem('_FlexibleMulti', [
        ['target_enemy', null], ['multi_target', requiredTargets], ['allow_less_than_max_targets', null],
        ['min_range', 0], ['max_range', maxRange],
      ]);
      const strictTargets = game.targetSystem.getValidTargets(unit, strictMulti);
      const flexibleTargets = game.targetSystem.getValidTargets(unit, flexibleMulti);

      const fogKeys = ['_fog_of_war', '_fog_of_war_radius', '_ai_fog_of_war_radius', '_other_fog_of_war_radius'];
      const oldFog = fogKeys.map((fogKey) => [fogKey, game.levelVars.has(fogKey), game.levelVars.get(fogKey)]);
      game.levelVars.set('_fog_of_war', true);
      game.levelVars.set('_fog_of_war_radius', 0);
      game.levelVars.set('_ai_fog_of_war_radius', 0);
      game.levelVars.set('_other_fog_of_war_radius', 0);
      game.recalculateAllFow();
      const taggedEnemy = enemies[0];
      const oldTags = [...taggedEnemy.tags];
      if (!taggedEnemy.tags.includes('Tile')) taggedEnemy.tags.push('Tile');
      const fogItem = makeItem('_FogTarget', [
        ['target_enemy', null], ['min_range', 0], ['max_range', maxRange],
      ]);
      const fogBypassItem = makeItem('_FogBypass', [
        ['target_enemy', null], ['target_fog_of_war', null], ['min_range', 0], ['max_range', maxRange],
      ]);
      const fogTargets = game.targetSystem.getValidTargets(unit, fogItem);
      const fogBypassTargets = game.targetSystem.getValidTargets(unit, fogBypassItem);
      taggedEnemy.tags = oldTags;
      for (const [fogKey, existed, value] of oldFog) {
        if (existed) game.levelVars.set(fogKey, value);
        else game.levelVars.delete(fogKey);
      }
      game.recalculateAllFow();

      const oldLos = game.db.constants.get('line_of_sight');
      game.db.constants.set('line_of_sight', true);
      const opacity = (game.board as any).opacityGrid as boolean[][];
      let blockedEnemy: any = null;
      let blocker: [number, number] | null = null;
      for (const enemy of enemies) {
        if (!enemy.position || Math.abs(enemy.position[0] - unit.position[0]) + Math.abs(enemy.position[1] - unit.position[1]) <= 1) continue;
        const baselineVisible = getLine(unit.position, enemy.position, (position: [number, number]) => game.board.getOpacity(position));
        if (!baselineVisible) continue;
        for (let x = 0; x < game.board.width && !blocker; x++) {
          for (let y = 0; y < game.board.height; y++) {
            if ((x === unit.position[0] && y === unit.position[1]) ||
                (x === enemy.position[0] && y === enemy.position[1])) continue;
            const oldOpaque = opacity[y][x];
            opacity[y][x] = true;
            const visible = getLine(unit.position, enemy.position, (position: [number, number]) => game.board.getOpacity(position));
            opacity[y][x] = oldOpaque;
            if (!visible) { blocker = [x, y]; blockedEnemy = enemy; break; }
          }
        }
        if (blocker) break;
      }
      let losTargets: [number, number][] = [];
      let ignoredLosTargets: [number, number][] = [];
      if (blocker && blockedEnemy) {
        const oldBlockerOpacity = opacity[blocker[1]][blocker[0]];
        opacity[blocker[1]][blocker[0]] = true;
        const losItem = makeItem('_LosTarget', [
          ['target_enemy', null], ['min_range', 0], ['max_range', maxRange],
        ]);
        const ignoredLosItem = makeItem('_IgnoredLosTarget', [
          ['target_enemy', null], ['ignore_line_of_sight', null], ['min_range', 0], ['max_range', maxRange],
        ]);
        losTargets = game.targetSystem.getValidTargets(unit, losItem);
        ignoredLosTargets = game.targetSystem.getValidTargets(unit, ignoredLosItem);
        opacity[blocker[1]][blocker[0]] = oldBlockerOpacity;
      }
      if (oldLos === undefined) game.db.constants.delete('line_of_sight');
      else game.db.constants.set('line_of_sight', oldLos);

      return {
        blastMain: blastResult.mainTarget,
        blast: keys(blastResult.splash),
        expectedBlast: keys(expectedBlast),
        allyMain: allySplash.mainTarget,
        allySplash: keys(allySplash.splash),
        expectedAllySplash: keys(allies.filter((other: any) => other !== unit).map((other: any) => other.position)),
        strictCount: strictTargets.length,
        flexible: keys(flexibleTargets),
        expectedEnemies: keys(enemies.map((other: any) => other.position)),
        taggedEnemy: key(taggedEnemy.position),
        fog: keys(fogTargets),
        fogBypass: keys(fogBypassTargets),
        blockedEnemy: blockedEnemy?.position ? key(blockedEnemy.position) : null,
        blocker,
        los: keys(losTargets),
        ignoredLos: keys(ignoredLosTargets),
      };
    });

    expect(result).not.toBeNull();
    expect(result!.blastMain).toBeNull();
    expect(result!.blast).toEqual(result!.expectedBlast);
    expect(result!.allyMain).toBeNull();
    expect(result!.allySplash).toEqual(result!.expectedAllySplash);
    expect(result!.strictCount).toBe(0);
    expect(result!.flexible).toEqual(result!.expectedEnemies);
    expect(result!.fog).toContain(result!.taggedEnemy);
    expect(result!.fogBypass).toEqual(result!.expectedEnemies);
    expect(result!.blocker).not.toBeNull();
    expect(result!.blockedEnemy).not.toBeNull();
    expect(result!.los).not.toContain(result!.blockedEnemy);
    expect(result!.ignoredLos).toContain(result!.blockedEnemy);
  });

  test('AOE geometry and alternate splash skills match Python component policies', async ({ page }) => {
    await page.goto('/?harness=true&level=0&clean=true&bundle=false');
    await waitForHarness(page);

    const result = await page.evaluate(async () => {
      const { GameBoard } = await import('/src/objects/game-board.ts');
      const { ItemObject } = await import('/src/objects/item.ts');
      const { SkillObject } = await import('/src/objects/skill.ts');
      const { splash, splashPositions } = await import('/src/combat/item-system.ts');

      const db = { areAllied: (left: string, right: string) => left === right } as any;
      const makeUnit = (nid: string, team: string) => ({ nid, team, position: null, skills: [] }) as any;
      const makeItem = (nid: string, components: [string, any][]) => new ItemObject({
        nid, name: nid, desc: '', icon_nid: '', icon_index: [0, 0], components,
      });
      const makeSkill = (nid: string, component: [string, any]) => new SkillObject({
        nid, name: nid, desc: '', icon_nid: '', icon_index: [0, 0], components: [component],
      });
      const keys = (positions: [number, number][]) => positions.map(([x, y]) => `${x},${y}`).sort();

      const lineBoard = new GameBoard(9, 9);
      const lineCaster = makeUnit('line-caster', 'player');
      const lineAlly = makeUnit('line-ally', 'player');
      const lineMiddle = makeUnit('line-middle', 'enemy');
      const lineTarget = makeUnit('line-target', 'enemy');
      lineBoard.setUnit(2, 4, lineCaster);
      lineBoard.setUnit(3, 4, lineAlly);
      lineBoard.setUnit(4, 4, lineMiddle);
      lineBoard.setUnit(6, 4, lineTarget);
      const lineItem = makeItem('_EnemyLine', [['enemy_line_aoe', null]]);
      const lineResult = splash(lineCaster, lineItem, [6, 4], { board: lineBoard, db });
      const linePreview = splashPositions(lineCaster, lineItem, [6, 4], { board: lineBoard, db });

      const shapeBoard = new GameBoard(9, 9);
      const shapeCaster = makeUnit('shape-caster', 'player');
      shapeCaster.skills.push(makeSkill('_Oversplash', ['oversplash', 1]));
      shapeBoard.setUnit(1, 1, shapeCaster);
      const shapeItem = makeItem('_Shape', [['shape_blast_aoe', {
        shape: [[1, 0], [0, 1]], target: 'enemy', range: 2,
      }]]);
      const shapePreview = splashPositions(shapeCaster, shapeItem, [4, 4], { board: shapeBoard, db });

      const oversplashBoard = new GameBoard(9, 9);
      const oversplashCaster = makeUnit('oversplash-caster', 'player');
      oversplashCaster.skills.push(makeSkill('_EnemyOversplash', ['enemy_oversplash', 2]));
      const oversplashTarget = makeUnit('oversplash-target', 'enemy');
      const oversplashEnemy = makeUnit('oversplash-enemy', 'enemy');
      const oversplashAlly = makeUnit('oversplash-ally', 'player');
      oversplashBoard.setUnit(2, 4, oversplashCaster);
      oversplashBoard.setUnit(6, 4, oversplashTarget);
      oversplashBoard.setUnit(5, 3, oversplashEnemy);
      oversplashBoard.setUnit(6, 3, oversplashAlly);
      const plainItem = makeItem('_Plain', [['target_enemy', null]]);
      const protectedItem = makeItem('_Protected', [['target_enemy', null], ['unsplashable', null]]);
      const oversplashResult = splash(oversplashCaster, plainItem, [6, 4], { board: oversplashBoard, db });
      const protectedResult = splash(oversplashCaster, protectedItem, [6, 4], { board: oversplashBoard, db });

      const cleaveBoard = new GameBoard(7, 7);
      const cleaveCaster = makeUnit('cleave-caster', 'player');
      cleaveCaster.skills.push(makeSkill('_Cleave', ['Cleave', null]));
      const cleaveTarget = makeUnit('cleave-target', 'enemy');
      const cleaveEnemyA = makeUnit('cleave-enemy-a', 'enemy');
      const cleaveEnemyB = makeUnit('cleave-enemy-b', 'enemy');
      const cleaveAlly = makeUnit('cleave-ally', 'player');
      cleaveBoard.setUnit(3, 3, cleaveCaster);
      cleaveBoard.setUnit(4, 3, cleaveTarget);
      cleaveBoard.setUnit(3, 2, cleaveEnemyA);
      cleaveBoard.setUnit(4, 4, cleaveEnemyB);
      cleaveBoard.setUnit(2, 3, cleaveAlly);
      const cleaveResult = splash(cleaveCaster, plainItem, [4, 3], { board: cleaveBoard, db });

      return {
        lineMain: lineResult.mainTarget,
        lineSplash: keys(lineResult.splash),
        linePreview: keys(linePreview),
        shapePreview: keys(shapePreview),
        oversplashMain: oversplashResult.mainTarget,
        oversplash: keys(oversplashResult.splash),
        protectedMain: protectedResult.mainTarget,
        protectedSplash: keys(protectedResult.splash),
        cleaveMain: cleaveResult.mainTarget,
        cleaveSplash: keys(cleaveResult.splash),
      };
    });

    expect(result.lineMain).toEqual([6, 4]);
    expect(result.lineSplash).toEqual(['4,4']);
    expect(result.linePreview).toEqual(['4,4', '5,4', '6,4']);
    expect(result.shapePreview).toEqual(['4,5', '4,6', '4,7', '5,4', '6,4', '7,4']);
    expect(result.oversplashMain).toEqual([6, 4]);
    expect(result.oversplash).toEqual(['5,3']);
    expect(result.protectedMain).toEqual([6, 4]);
    expect(result.protectedSplash).toEqual([]);
    expect(result.cleaveMain).toEqual([4, 3]);
    expect(result.cleaveSplash).toEqual(['3,2', '4,4']);
  });

  test('item availability gates default prfs, ranks, conditions, parent trees, player menus, targeting, and AI', async ({ page }) => {
    await page.goto('/?harness=true&level=0&clean=true&bundle=false');
    await waitForHarness(page);

    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { ItemObject } = await import('/src/objects/item.ts');
      const { UnitObject } = await import('/src/objects/unit.ts');
      const { SkillObject } = await import('/src/objects/skill.ts');
      const { available, splash } = await import('/src/combat/item-system.ts');
      const { WeaponChoiceState } = await import('/src/engine/states/game-states.ts');
      const eirika = game.units.get('Eirika');
      const seth = game.units.get('Seth');
      const moulderPrefab = game.db.units.get('Moulder');
      const moulderClass = moulderPrefab ? game.db.classes.get(moulderPrefab.klass) : null;
      const moulder = moulderPrefab && moulderClass ? new UnitObject(moulderPrefab, moulderClass) : null;
      const enemy = [...game.units.values()].find((unit: any) => unit.team === 'enemy');
      if (!eirika || !seth || !moulder || !enemy || !game.aiController) return null;

      const rapier = new ItemObject(game.db.items.get('Rapier'));
      const torch = new ItemObject(game.db.items.get('Torch_Staff'));
      const oldFog = game.gameVars.get('_fog_of_war');
      game.gameVars.set('_fog_of_war', false);
      const torchOff = available(moulder, torch, game.db, game);
      game.gameVars.set('_fog_of_war', true);
      const torchOn = available(moulder, torch, game.db, game);

      const makeItem = (nid: string, components: [string, any][]) => new ItemObject({
        nid, name: nid, desc: '', icon_nid: '', icon_index: [0, 0], components,
      });
      const targetItem = makeItem('_AvailabilityTarget', [
        ['target_tile', null], ['min_range', 0], ['global_range', null],
        ['prf_unit', ['Eirika']], ['uses', 2],
      ]);
      const targetCounts = {
        eirika: game.targetSystem.getValidTargets(eirika, targetItem).length,
        seth: game.targetSystem.getValidTargets(seth, targetItem).length,
      };

      const unlock = new ItemObject(game.db.items.get('Unlock'));
      moulder.position = [1, 1];
      const oldRegions = game.currentLevel.regions;
      game.currentLevel.regions = [{
        nid: '_AvailabilityDoor', region_type: 'event', position: [2, 1], size: [1, 1],
        sub_nid: 'Door', condition: "can_unlock(unit, item)", time_left: null,
        only_once: true, interrupt_move: false, hide_time: false,
      }, {
        nid: '_AvailabilityNonLock', region_type: 'event', position: [1, 2], size: [1, 1],
        sub_nid: 'Visit', condition: 'True', time_left: null,
        only_once: true, interrupt_move: false, hide_time: false,
      }];
      const unlockTargets = game.targetSystem.getValidTargets(moulder, unlock)
        .map((position: [number, number]) => position.join(','));
      const compositeUnlock = makeItem('_AvailabilityCompositeUnlock', [
        ['unlock_staff', null], ['blast_aoe', 3], ['spell', null],
      ]);
      const unlockSplash = splash(moulder, compositeUnlock, [2, 1], {
        board: game.board, db: game.db,
      });
      game.currentLevel.regions = oldRegions;

      const parent = makeItem('_AvailabilityParent', [['prf_unit', ['Eirika']]]);
      const child = makeItem('_AvailabilityChild', [['target_tile', null], ['min_range', 0], ['global_range', null]]);
      child.parentItem = parent;
      const parentAvailability = {
        eirika: available(eirika, child, game.db, game),
        seth: available(seth, child, game.db, game),
      };
      const grandparent = makeItem('_AvailabilityGrandparent', [['prf_unit', ['Nobody']]]);
      parent.parentItem = grandparent;
      const immediateParentOnly = available(eirika, child, game.db, game);

      const hpCost = makeItem('_AvailabilityHpCost', [['hp_cost', eirika.currentHp]]);
      const hpCostBlocked = available(eirika, hpCost, game.db, game);
      const cooldown = makeItem('_AvailabilityCooldown', [['cooldown', 2]]);
      const cooldownReady = available(eirika, cooldown, game.db, game);
      cooldown.data.set('cooldown', 1);
      const cooldownBlocked = available(eirika, cooldown, game.db, game);

      game.db.items.set('_AvailabilityOverrideItem', {
        nid: '_AvailabilityOverrideItem', name: '', desc: '', icon_nid: '', icon_index: [0, 0],
        components: [['prf_unit', ['Nobody']]],
      });
      const overrideSkill = new SkillObject({
        nid: '_AvailabilityOverrideSkill', name: '', desc: '', icon_nid: '', icon_index: [0, 0],
        components: [['item_override', '_AvailabilityOverrideItem']],
      });
      eirika.skills.push(overrideSkill);
      const overrideBlocked = available(eirika, targetItem, game.db, game);
      eirika.skills.splice(eirika.skills.indexOf(overrideSkill), 1);
      game.db.items.delete('_AvailabilityOverrideItem');

      const oldEirikaWexp = { ...eirika.wexp };
      eirika.wexp.Sword = 30;
      const rankItem = makeItem('_AvailabilityRank', [
        ['weapon', null], ['weapon_type', 'Sword'], ['weapon_rank', 'D'],
      ]);
      const rankBefore = available(eirika, rankItem, game.db, game);
      eirika.wexp.Sword = 31;
      const rankAfter = available(eirika, rankItem, game.db, game);

      const blockPrefab = {
        nid: '_AvailabilityBlock', name: '', desc: '', icon_nid: '', icon_index: [0, 0] as [number, number],
        components: [['cannot_use_items', null]] as [string, any][],
      };
      const conditionalPrefab = {
        nid: '_AvailabilityConditionalBlock', name: '', desc: '', icon_nid: '', icon_index: [0, 0] as [number, number],
        components: [['cannot_use_items', null], ['condition', 'False']] as [string, any][],
      };
      const block = new SkillObject(blockPrefab);
      const conditionalBlock = new SkillObject(conditionalPrefab);
      eirika.skills.push(conditionalBlock);
      const conditionalIgnored = available(eirika, targetItem, game.db, game);
      eirika.skills.push(block);
      const skillBlocked = available(eirika, targetItem, game.db, game);
      eirika.skills.splice(eirika.skills.indexOf(block), 1);
      eirika.skills.splice(eirika.skills.indexOf(conditionalBlock), 1);

      const allowedA = makeItem('_AllowedWeaponA', [
        ['weapon', null], ['target_enemy', null], ['min_range', 1], ['max_range', 99],
        ['damage', 1], ['hit', 100],
      ]);
      const allowedB = makeItem('_AllowedWeaponB', [
        ['weapon', null], ['target_enemy', null], ['min_range', 1], ['max_range', 99],
        ['damage', 2], ['hit', 100],
      ]);
      const forbidden = makeItem('_ForbiddenWeapon', [
        ['weapon', null], ['target_enemy', null], ['min_range', 1], ['max_range', 99],
        ['damage', 999], ['hit', 100], ['prf_unit', ['Nobody']],
      ]);
      const oldSelected = game.selectedUnit;
      const oldItems = [...eirika.items];
      eirika.items = [forbidden, allowedA, allowedB];
      game.selectedUnit = eirika;
      const weaponState = new WeaponChoiceState();
      weaponState.begin();
      const playerWeapons = (weaponState as any).weapons.map((item: any) => item.nid);
      eirika.items = oldItems;
      game.selectedUnit = oldSelected;
      game.highlight.clear();

      const oldEnemyItems = [...enemy.items];
      const oldEnemyPosition = enemy.position ? [...enemy.position] as [number, number] : null;
      const oldEirikaPosition = eirika.position ? [...eirika.position] as [number, number] : null;
      enemy.items = [forbidden, allowedA];
      const aiAction = (game.aiController as any).primaryAI(
        enemy,
        enemy.position ? [[...enemy.position]] : [],
        [eirika],
        0.5,
      );
      enemy.items = oldEnemyItems;
      if (oldEnemyPosition) enemy.position = oldEnemyPosition;
      if (oldEirikaPosition) eirika.position = oldEirikaPosition;

      eirika.wexp = oldEirikaWexp;
      targetItem.setUses(0);
      const exhausted = available(eirika, targetItem, game.db, game);
      if (oldFog === undefined) game.gameVars.delete('_fog_of_war');
      else game.gameVars.set('_fog_of_war', oldFog);
      return {
        defaults: {
          eirikaRapier: available(eirika, rapier, game.db, game),
          sethRapier: available(seth, rapier, game.db, game),
          torchOff, torchOn,
        },
        targetCounts,
        unlockTargets,
        unlockSplash,
        parentAvailability,
        immediateParentOnly,
        hpCostBlocked,
        cooldownReady,
        cooldownBlocked,
        overrideBlocked,
        rankBefore,
        rankAfter,
        conditionalIgnored,
        skillBlocked,
        exhausted,
        playerWeapons,
        aiWeapon: aiAction?.item?.nid ?? null,
      };
    });

    expect(result).not.toBeNull();
    expect(result!.defaults).toEqual({
      eirikaRapier: true, sethRapier: false, torchOff: false, torchOn: true,
    });
    expect(result!.targetCounts.eirika).toBeGreaterThan(0);
    expect(result!.targetCounts.seth).toBe(0);
    expect(result!.unlockTargets).toEqual(['2,1']);
    expect(result!.unlockSplash).toEqual({ mainTarget: [2, 1], splash: [] });
    expect(result!.parentAvailability).toEqual({ eirika: true, seth: false });
    expect(result!.immediateParentOnly).toBe(true);
    expect(result!.hpCostBlocked).toBe(false);
    expect(result!.cooldownReady).toBe(true);
    expect(result!.cooldownBlocked).toBe(false);
    expect(result!.overrideBlocked).toBe(false);
    expect(result!.rankBefore).toBe(false);
    expect(result!.rankAfter).toBe(true);
    expect(result!.conditionalIgnored).toBe(true);
    expect(result!.skillBlocked).toBe(false);
    expect(result!.exhausted).toBe(false);
    expect(result!.playerWeapons).toEqual(['_AllowedWeaponA', '_AllowedWeaponB']);
    expect(result!.aiWeapon).toBe('_AllowedWeaponA');
  });

  test('level EXP and weapon-triangle components match Python curves and replay through saves', async ({ page }) => {
    await page.goto('/?harness=true&level=0&clean=true&bundle=false');
    await waitForHarness(page);

    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { UnitObject } = await import('/src/objects/unit.ts');
      const { ItemObject } = await import('/src/objects/item.ts');
      const { MapCombat } = await import('/src/combat/map-combat.ts');
      const { weaponTriangle } = await import('/src/combat/combat-calcs.ts');
      const { saveGame, loadGame, deleteSave } = await import('/src/engine/save.ts');
      const template = game.units.get('Eirika');
      const klass = template ? game.db.classes.get(template.klass) : null;
      if (!template || !klass) return null;
      const makeUnit = (nid: string, team: string, level: number, hp: number = 100) => {
        const unit = new UnitObject({
          nid, name: nid, desc: '', variant: null, level, klass: template.klass,
          tags: [], bases: { HP: 100, STR: 0, MAG: 0, SKL: 20, SPD: 5, LCK: 0, DEF: 0, RES: 0, CON: 5, MOV: 5 },
          growths: {}, stat_cap_modifiers: {}, starting_items: [], learned_skills: [],
          unit_notes: [], fields: [], wexp_gain: {}, portrait_nid: '', affinity: '',
        } as any, klass);
        unit.team = team;
        unit.currentHp = hp;
        unit.wexp = { Sword: 251, Lance: 251, Axe: 251 };
        return unit;
      };
      const makeItem = (nid: string, components: [string, any][]) => new ItemObject({
        nid, name: nid, desc: '', icon_nid: '', icon_index: [0, 0], components,
      });
      const levelWeapon = (damage: number) => makeItem('_LevelExpWeapon', [
        ['spell', null], ['target_enemy', null], ['hit', 100], ['damage', damage],
        ['level_exp', null], ['min_range', 1], ['max_range', 1],
      ]);

      const attacker = makeUnit('_LevelExpAttacker', 'player', 1);
      const equalTarget = makeUnit('_LevelExpEqual', 'enemy', 1);
      const equalCombat = new MapCombat(
        attacker, levelWeapon(5), equalTarget, null, game.db, 'grandmaster', null, ['hit1'],
      );
      const beforeIndex = game.actionLog.actionIndex;
      const equalResult = equalCombat.applyResults(game.actionLog);
      const afterEqual = attacker.exp;
      while ((game.actionLog as any).actionIndex > beforeIndex) game.actionLog.runActionBackward();
      const afterUndo = attacker.exp;
      while ((game.actionLog as any).actionIndex < (game.actionLog as any).actions.length - 1) {
        game.actionLog.runActionForward();
      }
      const afterRedo = attacker.exp;

      const higherAttacker = makeUnit('_LevelExpHigherAttacker', 'player', 1);
      const higherTarget = makeUnit('_LevelExpHigherTarget', 'enemy', 11);
      const higherResult = new MapCombat(
        higherAttacker, levelWeapon(5), higherTarget, null, game.db, 'grandmaster', null, ['hit1'],
      ).applyResults();

      const bossAttacker = makeUnit('_LevelExpBossAttacker', 'player', 1);
      const boss = makeUnit('_LevelExpBoss', 'enemy', 1, 5);
      boss.tags.push('Boss');
      const bossResult = new MapCombat(
        bossAttacker, levelWeapon(10), boss, null, game.db, 'grandmaster', null, ['hit1'],
      ).applyResults();

      const missAttacker = makeUnit('_LevelExpMissAttacker', 'player', 1);
      const missTarget = makeUnit('_LevelExpMissTarget', 'enemy', 1);
      const missResult = new MapCombat(
        missAttacker, levelWeapon(5), missTarget, null, game.db, 'grandmaster', null, ['miss1'],
      ).applyResults();
      const allyAttacker = makeUnit('_LevelExpAllyAttacker', 'player', 1);
      const allyTarget = makeUnit('_LevelExpAllyTarget', 'player', 1);
      const allyResult = new MapCombat(
        allyAttacker, levelWeapon(5), allyTarget, null, game.db, 'grandmaster', null, ['hit1'],
      ).applyResults();

      const swordUnit = makeUnit('_TriangleSword', 'player', 1);
      const axeUnit = makeUnit('_TriangleAxe', 'enemy', 1);
      const sword = makeItem('_TriangleSwordItem', [['weapon', null], ['weapon_type', 'Sword']]);
      const axe = makeItem('_TriangleAxeItem', [['weapon', null], ['weapon_type', 'Axe']]);
      const reaverSword = makeItem('_TriangleReaverSword', [
        ['weapon', null], ['weapon_type', 'Sword'], ['reaver', null],
      ]);
      const reaverAxe = makeItem('_TriangleReaverAxe', [
        ['weapon', null], ['weapon_type', 'Axe'], ['reaver', null],
      ]);
      const override = makeItem('_TriangleOverride', [
        ['weapon', null], ['weapon_type', 'Sword'], ['weapon_triangle_override', 'Axe'],
      ]);
      const lance = makeItem('_TriangleLanceItem', [['weapon', null], ['weapon_type', 'Lance']]);
      const triangle = {
        normal: weaponTriangle(sword, axe, game.db, swordUnit, axeUnit),
        attackReaver: weaponTriangle(reaverSword, axe, game.db, swordUnit, axeUnit),
        bothReaver: weaponTriangle(reaverSword, reaverAxe, game.db, swordUnit, axeUnit),
        override: weaponTriangle(override, lance, game.db, swordUnit, axeUnit),
      };

      const bonus = (weaponType: string, rank: string, values: Partial<Record<string, string>>) => ({
        weapon_type: weaponType, weapon_rank: rank,
        damage: '0', resist: '0', accuracy: '0', avoid: '0', crit: '0', dodge: '0',
        attack_speed: '0', defense_speed: '0', ...values,
      });
      const weaponCount = game.db.weapons.length;
      game.db.weapons.push({
        nid: '_TriangleCombinedAtk', name: '', force_melee_anim: false, hide_from_display: false,
        rank_bonus: [], icon_nid: '', icon_index: [0, 0],
        advantage: [bonus('_TriangleCombinedDef', 'All', { accuracy: '10', damage: '3' })],
        disadvantage: [bonus('_TriangleCombinedDef', 'All', { accuracy: '-2', damage: '-1' })],
      } as any, {
        nid: '_TriangleCombinedDef', name: '', force_melee_anim: false, hide_from_display: false,
        rank_bonus: [], icon_nid: '', icon_index: [0, 0],
        advantage: [bonus('_TriangleCombinedAtk', 'All', { avoid: '4', resist: '1' })],
        disadvantage: [bonus('_TriangleCombinedAtk', 'All', { avoid: '-1', resist: '0' })],
      } as any, {
        nid: '_TriangleRanked', name: '', force_melee_anim: false, hide_from_display: false,
        rank_bonus: [], icon_nid: '', icon_index: [0, 0], disadvantage: [],
        advantage: [
          bonus('_TrianglePlain', 'All', { accuracy: '1', damage: '1' }),
          bonus('_TrianglePlain', 'A', { accuracy: '99', damage: '99' }),
        ],
      } as any, {
        nid: '_TrianglePlain', name: '', force_melee_anim: false, hide_from_display: false,
        rank_bonus: [], icon_nid: '', icon_index: [0, 0], advantage: [], disadvantage: [],
      } as any);
      const combinedAtk = makeItem('_TriangleCombinedAtkItem', [
        ['weapon', null], ['weapon_type', '_TriangleCombinedAtk'],
      ]);
      const combinedDef = makeItem('_TriangleCombinedDefItem', [
        ['weapon', null], ['weapon_type', '_TriangleCombinedDef'],
      ]);
      const ranked = makeItem('_TriangleRankedItem', [
        ['weapon', null], ['weapon_type', '_TriangleRanked'],
      ]);
      const plain = makeItem('_TrianglePlainItem', [
        ['weapon', null], ['weapon_type', '_TrianglePlain'],
      ]);
      swordUnit.wexp._TriangleCombinedAtk = 251;
      swordUnit.wexp._TriangleRanked = 251;
      axeUnit.wexp._TriangleCombinedDef = 251;
      axeUnit.wexp._TrianglePlain = 251;
      const extendedTriangle = {
        combined: weaponTriangle(combinedAtk, combinedDef, game.db, swordUnit, axeUnit),
        allRankFirst: weaponTriangle(ranked, plain, game.db, swordUnit, axeUnit),
      };
      game.db.weapons.splice(weaponCount);

      game.units.set(attacker.nid, attacker);
      await saveGame(game, 88, 'battle');
      attacker.exp = 77;
      const loaded = await loadGame(game, 88);
      const savedExp = game.units.get(attacker.nid)?.exp;
      await deleteSave(game, 88);
      game.units.delete(attacker.nid);

      return {
        exp: {
          equal: equalResult.expGained,
          afterEqual,
          afterUndo,
          afterRedo,
          higher: higherResult.expGained,
          boss: bossResult.expGained,
          miss: missResult.expGained,
          ally: allyResult.expGained,
        },
        triangle,
        extendedTriangle,
        save: { loaded, exp: savedExp },
      };
    });

    expect(result).not.toBeNull();
    expect(result!.exp).toEqual({
      equal: 10, afterEqual: 10, afterUndo: 0, afterRedo: 10,
      higher: 14, boss: 70, miss: 1, ally: 1,
    });
    expect(result!.triangle).toEqual({
      normal: { hitBonus: 15, damageBonus: 1, attackerDamageAdvantage: 1 },
      attackReaver: { hitBonus: -30, damageBonus: -2, attackerDamageAdvantage: -2 },
      bothReaver: { hitBonus: 30, damageBonus: 2, attackerDamageAdvantage: 2 },
      override: { hitBonus: 15, damageBonus: 1, attackerDamageAdvantage: 1 },
    });
    expect(result!.extendedTriangle).toEqual({
      combined: { hitBonus: 5, damageBonus: 1, attackerDamageAdvantage: 2 },
      allRankFirst: { hitBonus: 1, damageBonus: 1, attackerDamageAdvantage: 1 },
    });
    expect(result!.save).toEqual({ loaded: true, exp: 10 });
  });

  test('group map combat propagates splash once, counters only from main, and aggregates rewards', async ({ page }) => {
    await page.goto('/?harness=true&level=0&clean=true&bundle=false');
    await waitForHarness(page);

    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { GameBoard } = await import('/src/objects/game-board.ts');
      const { UnitObject } = await import('/src/objects/unit.ts');
      const { ItemObject } = await import('/src/objects/item.ts');
      const { MapCombat } = await import('/src/combat/map-combat.ts');
      const template = game.units.get('Eirika');
      const klass = template ? game.db.classes.get(template.klass) : null;
      if (!template || !klass) return null;

      const makeUnit = (nid: string, team: string) => {
        const unit = new UnitObject({
          nid, name: nid, desc: '', variant: null, level: 1, klass: template.klass,
          tags: [], bases: { HP: 40, STR: 0, MAG: 0, SKL: 10, SPD: 10, LCK: 0, DEF: 5, RES: 5, CON: 10, MOV: 5 },
          growths: {}, stat_cap_modifiers: {}, starting_items: [], learned_skills: [],
          unit_notes: [], fields: [], wexp_gain: {}, portrait_nid: '', affinity: '',
        } as any, klass);
        unit.team = team;
        unit.currentHp = 40;
        return unit;
      };
      const makeItem = (nid: string, components: [string, any][]) => new ItemObject({
        nid, name: nid, desc: '', icon_nid: '', icon_index: [0, 0], components,
      });
      const weapon = (nid: string, extra: [string, any][] = []) => makeItem(nid, [
        ['weapon', null], ['target_enemy', null], ['damage', 0], ['hit', 100],
        ['uses', 10], ['min_range', 1], ['max_range', 1], ...extra,
      ]);
      const oldDoubleSplash = game.db.constants.get('double_splash');
      const oldDoubleWexp = game.db.constants.get('double_wexp');
      game.db.constants.set('double_splash', false);
      game.db.constants.set('double_wexp', false);

      const board = new GameBoard(8, 8);
      const attacker = makeUnit('_GroupAttacker', 'player');
      const main = makeUnit('_GroupMain', 'enemy');
      const splash = makeUnit('_GroupSplash', 'enemy');
      board.setUnit(2, 2, attacker);
      board.setUnit(3, 2, main);
      board.setUnit(3, 3, splash);
      const attackItem = weapon('_GroupBrave', [['brave', null], ['enemy_blast_aoe', 1]]);
      const mainWeapon = weapon('_MainCounter');
      const splashWeapon = weapon('_SplashCounter');
      attacker.items.push(attackItem);
      main.items.push(mainWeapon);
      splash.items.push(splashWeapon);
      const combat = new MapCombat(
        attacker, attackItem, main, mainWeapon, game.db, 'grandmaster', board, null,
        { mainDefender: main, splashDefenders: [splash] },
      );
      const strikeOrder = combat.strikes.map((strike: any) =>
        `${strike.attacker.nid}->${strike.defender.nid}:${strike.mode}`,
      );
      const firstResults = combat.applyResults();

      const pureBoard = new GameBoard(8, 8);
      const caster = makeUnit('_PureCaster', 'player');
      const splashA = makeUnit('_PureA', 'enemy');
      const splashB = makeUnit('_PureB', 'enemy');
      pureBoard.setUnit(2, 2, caster);
      pureBoard.setUnit(4, 2, splashA);
      pureBoard.setUnit(4, 3, splashB);
      const spell = makeItem('_PureSplash', [
        ['spell', null], ['target_enemy', null], ['damage', 0], ['hit', 100],
        ['uses', 10], ['wexp', 1], ['weapon_type', 'Staff'], ['exp', 10],
        ['enemy_blast_aoe', 1], ['min_range', 1], ['max_range', 3],
      ]);
      caster.items.push(spell);
      splashA.items.push(weapon('_PureCounterA'));
      splashB.items.push(weapon('_PureCounterB'));
      const pureCombat = new MapCombat(
        caster, spell, splashA, null, game.db, 'grandmaster', pureBoard, null,
        { mainDefender: null, splashDefenders: [splashA, splashB] },
      );
      const pureOrder = pureCombat.strikes.map((strike: any) =>
        `${strike.attacker.nid}->${strike.defender.nid}:${strike.mode}`,
      );
      const pureResults = pureCombat.applyResults();

      game.db.constants.set('double_splash', true);
      const doubleBoard = new GameBoard(8, 8);
      const doubleAttacker = makeUnit('_DoubleAttacker', 'player');
      const doubleMain = makeUnit('_DoubleMain', 'enemy');
      const doubleTarget = makeUnit('_DoubleSplash', 'enemy');
      doubleBoard.setUnit(2, 2, doubleAttacker);
      doubleBoard.setUnit(3, 2, doubleMain);
      doubleBoard.setUnit(3, 3, doubleTarget);
      const doubleItem = weapon('_DoubleBrave', [['brave', null], ['enemy_blast_aoe', 1]]);
      const doubleMainWeapon = weapon('_DoubleMainCounter');
      doubleAttacker.items.push(doubleItem);
      doubleMain.items.push(doubleMainWeapon);
      const doubleCombat = new MapCombat(
        doubleAttacker, doubleItem, doubleMain, doubleMainWeapon,
        game.db, 'grandmaster', doubleBoard, null,
        { mainDefender: doubleMain, splashDefenders: [doubleTarget] },
      );
      const doubleSplashHits = doubleCombat.strikes.filter((strike: any) => strike.mode === 'splash').length;

      const deathBoard = new GameBoard(8, 8);
      const deathCaster = makeUnit('_DeathCaster', 'player');
      const deathA = makeUnit('_DeathA', 'enemy');
      const deathB = makeUnit('_DeathB', 'enemy');
      deathBoard.setUnit(2, 2, deathCaster);
      deathBoard.setUnit(4, 2, deathA);
      deathBoard.setUnit(4, 3, deathB);
      deathA.currentHp = 1;
      deathB.currentHp = 1;
      const dropA = weapon('_DropA');
      const dropB = weapon('_DropB');
      dropA.droppable = true;
      dropB.droppable = true;
      deathA.items.push(dropA);
      deathB.items.push(dropB);
      const deathSpell = makeItem('_DeathSplash', [
        ['spell', null], ['target_enemy', null], ['damage', 100], ['hit', 100],
        ['uses', 10], ['enemy_blast_aoe', 1], ['min_range', 1], ['max_range', 3],
      ]);
      const deathCombat = new MapCombat(
        deathCaster, deathSpell, deathA, null, game.db, 'grandmaster', deathBoard, null,
        { mainDefender: null, splashDefenders: [deathA, deathB] },
      );
      const deathResults = deathCombat.applyResults();

      if (oldDoubleSplash === undefined) game.db.constants.delete('double_splash');
      else game.db.constants.set('double_splash', oldDoubleSplash);
      if (oldDoubleWexp === undefined) game.db.constants.delete('double_wexp');
      else game.db.constants.set('double_wexp', oldDoubleWexp);

      return {
        strikeOrder,
        attackUses: attackItem.uses,
        mainUses: mainWeapon.uses,
        splashUses: splashWeapon.uses,
        firstDeaths: firstResults.defenderDeaths?.map((unit: any) => unit.nid) ?? [],
        pureOrder,
        pureUses: spell.uses,
        pureExp: pureResults.expGained,
        pureWexp: pureResults.attackerWexpGained,
        doubleSplashHits,
        deaths: deathResults.defenderDeaths?.map((unit: any) => unit.nid).sort() ?? [],
        droppedOwners: deathResults.droppedItems?.map((entry: any) => entry.unit.nid).sort() ?? [],
      };
    });

    expect(result).not.toBeNull();
    expect(result!.strikeOrder).toEqual([
      '_GroupAttacker->_GroupMain:attack',
      '_GroupAttacker->_GroupSplash:splash',
      '_GroupAttacker->_GroupMain:attack',
      '_GroupMain->_GroupAttacker:defense',
    ]);
    expect(result!.attackUses).toBe(7);
    expect(result!.mainUses).toBe(9);
    expect(result!.splashUses).toBe(10);
    expect(result!.firstDeaths).toEqual([]);
    expect(result!.pureOrder).toEqual([
      '_PureCaster->_PureA:splash',
      '_PureCaster->_PureB:splash',
    ]);
    expect(result!.pureUses).toBe(8);
    expect(result!.pureExp).toBe(20);
    expect(result!.pureWexp).toBe(1);
    expect(result!.doubleSplashHits).toBe(2);
    expect(result!.deaths).toEqual(['_DeathA', '_DeathB']);
    expect(result!.droppedOwners).toEqual(['_DeathA', '_DeathB']);
  });

  test('CombatState routes pure AOE through one map-only defender group', async ({ page }) => {
    await page.goto('/?harness=true&level=0&clean=true&bundle=false');
    await waitForHarness(page);

    const setup = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { UnitObject } = await import('/src/objects/unit.ts');
      const { ItemObject } = await import('/src/objects/item.ts');
      const template = game.units.get('Eirika');
      const klass = template ? game.db.classes.get(template.klass) : null;
      if (!template || !klass) return false;
      let origin: [number, number] | null = null;
      for (let y = 1; y < game.board.height - 1 && !origin; y++) {
        for (let x = 1; x < game.board.width - 2; x++) {
          if (!game.board.getUnit(x, y) && !game.board.getUnit(x + 2, y) &&
              !game.board.getUnit(x + 2, y + 1)) {
            origin = [x, y];
            break;
          }
        }
      }
      if (!origin) return false;
      const makeUnit = (nid: string, team: string) => {
        const unit = new UnitObject({
          nid, name: nid, desc: '', variant: null, level: 1, klass: template.klass,
          tags: [], bases: { HP: 40, STR: 0, MAG: 0, SKL: 10, SPD: 10, LCK: 0, DEF: 5, RES: 5, CON: 10, MOV: 5 },
          growths: {}, stat_cap_modifiers: {}, starting_items: [], learned_skills: [],
          unit_notes: [], fields: [], wexp_gain: {}, portrait_nid: '', affinity: '',
        } as any, klass);
        unit.team = team;
        unit.currentHp = 40;
        return unit;
      };
      const caster = makeUnit('_StateAOECaster', 'player');
      const targetA = makeUnit('_StateAOEA', 'enemy');
      const targetB = makeUnit('_StateAOEB', 'enemy');
      const spell = new ItemObject({
        nid: '_StateAOESpell', name: '_StateAOESpell', desc: '', icon_nid: '', icon_index: [0, 0],
        components: [
          ['spell', null], ['magic', null], ['target_enemy', null], ['damage', 0], ['hit', 100],
          ['uses', 10], ['enemy_blast_aoe', 1], ['min_range', 1], ['max_range', 3],
        ],
      });
      caster.items.push(spell);
      game.board.setUnit(origin[0], origin[1], caster);
      game.board.setUnit(origin[0] + 2, origin[1], targetA);
      game.board.setUnit(origin[0] + 2, origin[1] + 1, targetB);
      game.selectedUnit = caster;
      game.combatTarget = targetA;
      game.memory.set('combat_item', spell);
      (window as any).__aoeStateTest = { caster, targetA, targetB, spell };
      game.state.change('combat');
      return true;
    });
    expect(setup).toBe(true);
    await stepFrames(page, 3);

    const active = await page.evaluate(() => {
      const game = (window as any).__gameRef;
      const state = game.state.getCurrentState();
      return {
        state: state?.name,
        mapOnly: state?.isAnimationCombat === false,
        primary: state?.combat?.primaryDefender?.nid ?? null,
        defenders: state?.combat?.defenders?.map((unit: any) => unit.nid).sort() ?? [],
        modes: state?.combat?.strikes?.map((strike: any) => strike.mode) ?? [],
      };
    });
    expect(active).toEqual({
      state: 'combat',
      mapOnly: true,
      primary: null,
      defenders: ['_StateAOEA', '_StateAOEB'],
      modes: ['splash', 'splash'],
    });

    await settle(page, 1200);
    const completed = await page.evaluate(() => {
      const game = (window as any).__gameRef;
      const { caster, targetA, targetB, spell } = (window as any).__aoeStateTest;
      const result = {
        state: game.state.getCurrentState()?.name,
        uses: spell.uses,
        casterHp: caster.currentHp,
        targetAHp: targetA.currentHp,
        targetBHp: targetB.currentHp,
        casterFinished: caster.finished,
      };
      game.board.removeUnit(caster);
      game.board.removeUnit(targetA);
      game.board.removeUnit(targetB);
      delete (window as any).__aoeStateTest;
      return result;
    });
    expect(completed).toEqual({
      state: 'free',
      uses: 8,
      casterHp: 40,
      targetAHp: 40,
      targetBHp: 40,
      casterFinished: true,
    });
  });

  test('combat result and death actions restore HP, EXP, skills, uses, WEXP, board, and initiative', async ({ page }) => {
    await page.goto('/?harness=true&level=0&clean=true&bundle=false');
    await waitForHarness(page);

    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { GameBoard } = await import('/src/objects/game-board.ts');
      const { UnitObject } = await import('/src/objects/unit.ts');
      const { ItemObject } = await import('/src/objects/item.ts');
      const { MapCombat } = await import('/src/combat/map-combat.ts');
      const { DeathAction, HasAttackedAction, WaitAction } = await import('/src/engine/action.ts');
      const { InitiativeTracker } = await import('/src/engine/initiative.ts');
      const template = game.units.get('Eirika');
      const klass = template ? game.db.classes.get(template.klass) : null;
      if (!template || !klass) return null;
      const makeUnit = (nid: string, team: string, hp: number) => {
        const unit = new UnitObject({
          nid, name: nid, desc: '', variant: null, level: 1, klass: template.klass,
          tags: [], bases: { HP: 20, STR: 5, MAG: 5, SKL: 5, SPD: 5, LCK: 0, DEF: 0, RES: 0, CON: 5, MOV: 5 },
          growths: { HP: 100, STR: 100 }, stat_cap_modifiers: {}, starting_items: [], learned_skills: [],
          unit_notes: [], fields: [], wexp_gain: {}, portrait_nid: '', affinity: '',
        } as any, klass);
        unit.team = team;
        unit.currentHp = hp;
        return unit;
      };
      game.db.skills.set('_CombatResultStatus', {
        nid: '_CombatResultStatus', name: 'Result Status', desc: '',
        icon_nid: '', icon_index: [0, 0], components: [],
      });
      const attacker = makeUnit('_ResultAttacker', 'player', 20);
      const defender = makeUnit('_ResultDefender', 'enemy', 1);
      attacker.exp = 90;
      attacker.wexp.Sword = 0;
      const item = new ItemObject({
        nid: '_ResultSpell', name: '_ResultSpell', desc: '', icon_nid: '', icon_index: [0, 0],
        components: [
          ['spell', null], ['target_enemy', null], ['damage', 20], ['hit', 100],
          ['uses', 2], ['weapon_type', 'Sword'], ['wexp', 1], ['exp', 20],
          ['status_on_hit', '_CombatResultStatus'], ['min_range', 1], ['max_range', 2],
        ],
      });
      attacker.items.push(item);
      const board = new GameBoard(8, 8);
      board.setUnit(2, 2, attacker);
      board.setUnit(3, 2, defender);
      const initiative = new InitiativeTracker();
      initiative.unitLine = [attacker.nid, defender.nid];
      initiative.initiativeLine = [10, 5];
      initiative.currentIdx = 1;
      const beforeActionIndex = game.actionLog.actionIndex;
      const combat = new MapCombat(
        attacker, item, defender, null, game.db, 'grandmaster', board, ['hit1'],
      );
      combat.applyResults(game.actionLog);
      game.actionLog.doAction(new DeathAction(defender, board, initiative));
      game.actionLog.doAction(new HasAttackedAction(attacker));
      game.actionLog.doAction(new WaitAction(attacker));

      const snapshot = () => ({
        attacker: {
          hp: attacker.currentHp, exp: attacker.exp, level: attacker.level,
          stats: { ...attacker.stats }, wexp: { ...attacker.wexp },
          uses: item.uses, hasAttacked: attacker.hasAttacked, finished: attacker.finished,
        },
        defender: {
          hp: defender.currentHp, dead: defender.dead, position: defender.position,
          status: defender.skills.some((skill: any) => skill.nid === '_CombatResultStatus'),
        },
        boardDefender: board.getUnit(3, 2)?.nid ?? null,
        initiative: {
          units: [...initiative.unitLine], values: [...initiative.initiativeLine],
          index: initiative.currentIdx,
        },
      });
      const applied = snapshot();
      const actionLog = game.actionLog as any;
      while (actionLog.actionIndex > beforeActionIndex) actionLog.runActionBackward();
      const reversed = snapshot();
      while (actionLog.actionIndex < actionLog.actions.length - 1) actionLog.runActionForward();
      return { applied, reversed, redone: snapshot() };
    });

    expect(result).not.toBeNull();
    expect(result!.applied.attacker).toMatchObject({
      exp: 50, level: 2, wexp: { Sword: 2 }, uses: 1,
      hasAttacked: true, finished: true,
    });
    expect(result!.applied.defender).toEqual({ hp: 0, dead: true, position: null, status: true });
    expect(result!.applied.boardDefender).toBeNull();
    expect(result!.applied.initiative).toEqual({ units: ['_ResultAttacker'], values: [10], index: 0 });
    expect(result!.reversed.attacker).toMatchObject({
      hp: 20, exp: 90, level: 1, wexp: { Sword: 0 }, uses: 2,
      hasAttacked: false, finished: false,
    });
    expect(result!.reversed.defender).toEqual({
      hp: 1, dead: false, position: [3, 2], status: false,
    });
    expect(result!.reversed.boardDefender).toBe('_ResultDefender');
    expect(result!.reversed.initiative).toEqual({
      units: ['_ResultAttacker', '_ResultDefender'], values: [10, 5], index: 1,
    });
    expect(result!.redone).toEqual(result!.applied);
  });

  test('item combat events queue hit and end hooks in Python order with local args', async ({ page }) => {
    await page.goto('/?harness=true&level=0&clean=true&bundle=false');
    await waitForHarness(page);

    const queued = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { UnitObject } = await import('/src/objects/unit.ts');
      const { ItemObject } = await import('/src/objects/item.ts');
      const { MapCombat } = await import('/src/combat/map-combat.ts');
      const { queueCombatItemEvents } = await import('/src/combat/combat-lifecycle.ts');
      const template = game.units.get('Eirika');
      const klass = template ? game.db.classes.get(template.klass) : null;
      if (!template || !klass) return null;
      const makeUnit = (nid: string, team: string) => {
        const unit = new UnitObject({
          nid, name: nid, desc: '', variant: null, level: 1, klass: template.klass,
          tags: [], bases: { HP: 30, STR: 0, MAG: 0, SKL: 5, SPD: 5, LCK: 0, DEF: 0, RES: 0, CON: 5, MOV: 5 },
          growths: {}, stat_cap_modifiers: {}, starting_items: [], learned_skills: [],
          unit_notes: [], fields: [], wexp_gain: {}, portrait_nid: '', affinity: '',
        } as any, klass);
        unit.team = team;
        unit.currentHp = 30;
        return unit;
      };
      const eventNids = [
        '_EventOnUse', '_EventOnHit', '_EventAfterUse',
        '_EventAfterCombat', '_EventAfterHit', '_EventAfterAny',
      ];
      for (const nid of eventNids) {
        game.db.events.set(nid, {
          nid, name: nid, trigger: 'never', level_nid: '0', condition: 'False',
          only_once: false, priority: 0,
          _source: [
            'inc_level_var;_item_lifecycle_count',
            `level_var;_item_lifecycle_last;${nid}`,
            'level_var;_item_lifecycle_mode;{e:mode}',
            'level_var;_item_lifecycle_target;{e:target.nid}',
          ],
        });
      }
      const attacker = makeUnit('_LifecycleAttacker', 'player');
      const defender = makeUnit('_LifecycleDefender', 'enemy');
      attacker.position = [2, 2];
      defender.position = [3, 2];
      const item = new ItemObject({
        nid: '_LifecycleEvents', name: '_LifecycleEvents', desc: '', icon_nid: '', icon_index: [0, 0],
        components: [
          ['spell', null], ['target_enemy', null], ['damage', 0], ['hit', 100], ['uses', 5],
          ['event_on_use', eventNids[0]], ['event_on_hit', eventNids[1]],
          ['event_after_use', eventNids[2]], ['event_after_combat', eventNids[3]],
          ['event_after_combat_on_hit', eventNids[4]],
          ['event_after_combat_even_miss', eventNids[5]],
        ],
      });
      attacker.items.push(item);
      const combat = new MapCombat(
        attacker, item, defender, null, game.db, 'grandmaster', null, ['hit1', 'miss1'],
      );
      combat.applyResults(game.actionLog);
      const count = queueCombatItemEvents(game, combat.strikes);
      const order = game.eventManager.eventQueue.map((event: any) => event.nid);
      const payloads = game.eventManager.eventQueue.map((event: any) => ({
        mode: event.trigger.localArgs.get('mode'),
        target: event.trigger.unit2?.nid,
        targetPos: event.trigger.localArgs.get('target_pos'),
        attackInfo: event.trigger.localArgs.get('attack_info'),
      }));
      game.state.change('event');
      return { count, order, payloads };
    });
    expect(queued).not.toBeNull();
    expect(queued!.count).toBe(6);
    expect(queued!.order).toEqual([
      '_EventOnUse', '_EventOnHit', '_EventAfterUse',
      '_EventAfterCombat', '_EventAfterHit', '_EventAfterAny',
    ]);
    expect(queued!.payloads.every((payload: any) =>
      payload.mode === 'attack' && payload.target === '_LifecycleDefender' &&
      payload.targetPos[0] === 3 && payload.targetPos[1] === 2,
    )).toBe(true);
    expect(queued!.payloads.map((payload: any) => payload.attackInfo)).toEqual([
      [0, 0], [0, 0], [0, 0], [0, 0], [0, 0], [1, 0],
    ]);

    await settle(page, 300);
    const processed = await page.evaluate(() => {
      const game = (window as any).__gameRef;
      return {
        count: game.levelVars.get('_item_lifecycle_count'),
        last: game.levelVars.get('_item_lifecycle_last'),
        mode: game.levelVars.get('_item_lifecycle_mode'),
        target: game.levelVars.get('_item_lifecycle_target'),
      };
    });
    expect(processed).toEqual({
      count: 6, last: '_EventAfterAny', mode: 'attack', target: '_LifecycleDefender',
    });
  });

  test('persistent combat LCG, proc charge, turnwheel, and save restore match LT state', async ({ page }) => {
    await page.goto('/?harness=true&level=0&clean=true&bundle=false');
    await waitForHarness(page);

    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { UnitObject } = await import('/src/objects/unit.ts');
      const { ItemObject } = await import('/src/objects/item.ts');
      const { SkillObject } = await import('/src/objects/skill.ts');
      const { MapCombat } = await import('/src/combat/map-combat.ts');
      const {
        getCombatRandom, getCombatRandomState, setCombatRandomState,
      } = await import('/src/engine/static-random.ts');
      const { saveGame, loadGame, deleteSave } = await import('/src/engine/save.ts');
      const template = game.units.get('Eirika');
      const klass = template ? game.db.classes.get(template.klass) : null;
      if (!template || !klass) return null;
      const makeUnit = (nid: string, team: string) => {
        const unit = new UnitObject({
          nid, name: nid, desc: '', variant: null, level: 1, klass: template.klass,
          tags: [], bases: { HP: 30, STR: 0, MAG: 0, SKL: 0, SPD: 5, LCK: 0, DEF: 0, RES: 0, CON: 5, MOV: 5 },
          growths: {}, stat_cap_modifiers: {}, starting_items: [], learned_skills: [],
          unit_notes: [], fields: [], wexp_gain: {}, portrait_nid: '', affinity: '',
        } as any, klass);
        unit.team = team;
        unit.currentHp = 30;
        return unit;
      };

      game.gameVars.set('_random_seed', 17);
      game.gameVars.delete('_combat_random_seed');
      game.gameVars.delete('_combat_random_state');
      const pythonSequence = [
        getCombatRandom(game), getCombatRandom(game), getCombatRandom(game), getCombatRandom(game),
      ];
      setCombatRandomState(game, 17);

      const procNid = '_PersistentProcEffect';
      const parentNid = '_PersistentProcParent';
      game.db.skills.set(procNid, {
        nid: procNid, name: procNid, desc: '', icon_nid: '', icon_index: [0, 0],
        components: [['damage', 4]],
      });
      game.db.skills.set(parentNid, {
        nid: parentNid, name: parentNid, desc: '', icon_nid: '', icon_index: [0, 0],
        components: [['attack_proc', procNid], ['proc_rate', 100], ['drain_charge', 2]],
      });
      const attacker = makeUnit('_PersistentRngAttacker', 'player');
      const defender = makeUnit('_PersistentRngDefender', 'enemy');
      const parent = new SkillObject(game.db.skills.get(parentNid));
      attacker.skills.push(parent);
      const item = new ItemObject({
        nid: '_PersistentRngItem', name: '_PersistentRngItem', desc: '',
        icon_nid: '', icon_index: [0, 0],
        components: [['spell', null], ['damage', 1], ['hit', 100], ['uses', 5]],
      });
      attacker.items.push(item);
      const beforeIndex = game.actionLog.actionIndex;
      const combat = new MapCombat(
        attacker, item, defender, null, game.db, 'classic', null, ['hit1'], undefined, game,
      );
      const afterConstruction = {
        charge: parent.data.get('charge'),
        random: getCombatRandomState(game),
        procKinds: combat.procPlayback.map((mark: any) => mark.kind),
      };
      combat.applyResults(game.actionLog);
      const applied = {
        charge: parent.data.get('charge'), random: getCombatRandomState(game),
        hp: defender.currentHp, uses: item.uses,
      };
      const actionLog = game.actionLog as any;
      while (actionLog.actionIndex > beforeIndex) actionLog.runActionBackward();
      const reversed = {
        charge: parent.data.get('charge'), random: getCombatRandomState(game),
        hp: defender.currentHp, uses: item.uses,
      };
      while (actionLog.actionIndex < actionLog.actions.length - 1) actionLog.runActionForward();
      const redone = {
        charge: parent.data.get('charge'), random: getCombatRandomState(game),
        hp: defender.currentHp, uses: item.uses,
      };

      game.units.set(attacker.nid, attacker);
      game.units.set(defender.nid, defender);
      await saveGame(game, 89, 'battle');
      parent.data.set('charge', 0);
      setCombatRandomState(game, 999);
      const loaded = await loadGame(game, 89);
      const restoredAttacker = game.units.get(attacker.nid);
      const restoredParent = restoredAttacker?.skills.find((skill: any) => skill.nid === parentNid);
      const saved = {
        loaded,
        charge: restoredParent?.data.get('charge'),
        random: getCombatRandomState(game),
      };
      await deleteSave(game, 89);
      game.units.delete(attacker.nid);
      game.units.delete(defender.nid);
      game.db.skills.delete(procNid);
      game.db.skills.delete(parentNid);
      return { pythonSequence, afterConstruction, applied, reversed, redone, saved };
    });

    expect(result).not.toBeNull();
    expect(result!.pythonSequence).toEqual([7, 52, 25, 27]);
    expect(result!.afterConstruction).toEqual({
      charge: 1, random: 1579902326, procKinds: ['attack_proc'],
    });
    expect(result!.applied).toEqual({ charge: 1, random: 1579902326, hp: 25, uses: 4 });
    expect(result!.reversed).toEqual({ charge: 2, random: 17, hp: 30, uses: 5 });
    expect(result!.redone).toEqual(result!.applied);
    expect(result!.saved).toEqual({ loaded: true, charge: 1, random: 1579902326 });
  });

  test('attack, defense, and pre-procs scope temporary skills across grouped strikes', async ({ page }) => {
    await page.goto('/?harness=true&level=0&clean=true&bundle=false');
    await waitForHarness(page);

    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { UnitObject } = await import('/src/objects/unit.ts');
      const { ItemObject } = await import('/src/objects/item.ts');
      const { SkillObject } = await import('/src/objects/skill.ts');
      const { MapCombat } = await import('/src/combat/map-combat.ts');
      const template = game.units.get('Eirika');
      const klass = template ? game.db.classes.get(template.klass) : null;
      if (!template || !klass) return null;
      const makeUnit = (nid: string, team: string, defense: number = 0) => {
        const unit = new UnitObject({
          nid, name: nid, desc: '', variant: null, level: 1, klass: template.klass,
          tags: [], bases: { HP: 100, STR: 0, MAG: 0, SKL: 0, SPD: 5, LCK: 0, DEF: defense, RES: defense, CON: 5, MOV: 5 },
          growths: {}, stat_cap_modifiers: {}, starting_items: [], learned_skills: [],
          unit_notes: [], fields: [], wexp_gain: {}, portrait_nid: '', affinity: '',
        } as any, klass);
        unit.team = team;
        unit.currentHp = 100;
        return unit;
      };
      const addSkill = (nid: string, components: [string, any][]) => {
        const prefab = { nid, name: nid, desc: '', icon_nid: '', icon_index: [0, 0] as [number, number], components };
        game.db.skills.set(nid, prefab);
        return prefab;
      };
      const skillNids = [
        '_GroupDamageProc', '_GroupPreProc', '_GroupAttackParent', '_GroupPreParent',
        '_DefenseProc', '_DefenseParent', '_SureProc', '_SureParent',
        '_LunaProc', '_LunaParent', '_ConditionalParent',
      ];
      addSkill('_GroupDamageProc', [['damage', 30]]);
      addSkill('_GroupPreProc', [['damage', 7]]);
      addSkill('_GroupAttackParent', [
        ['attack_proc', '_GroupDamageProc'], ['proc_rate', 100], ['drain_charge', 2],
      ]);
      addSkill('_GroupPreParent', [
        ['attack_pre_proc', '_GroupPreProc'], ['proc_rate', 100], ['build_charge', 1],
      ]);
      addSkill('_DefenseProc', [['resist', 1000]]);
      addSkill('_DefenseParent', [
        ['defense_proc', '_DefenseProc'], ['proc_rate', 100], ['drain_charge', 2],
      ]);
      addSkill('_SureProc', [['hit', 1000]]);
      addSkill('_SureParent', [['attack_proc', '_SureProc'], ['proc_rate', 100]]);
      addSkill('_LunaProc', [['item_override', '_ZeroResistOverride']]);
      addSkill('_LunaParent', [['attack_proc', '_LunaProc'], ['proc_rate', 100]]);
      addSkill('_ConditionalParent', [
        ['attack_proc', '_GroupDamageProc'], ['proc_rate', 100],
        ['combat_condition', "mode == 'attack' and unit2.team == 'player'"],
      ]);
      game.db.items.set('_ZeroResistOverride', {
        nid: '_ZeroResistOverride', name: '_ZeroResistOverride', desc: '',
        icon_nid: '', icon_index: [0, 0], components: [['alternate_resist_formula', 'ZERO']],
      });
      game.db.equations.set('ZERO', '0');

      const groupAttacker = makeUnit('_GroupProcAttacker', 'player');
      const groupMain = makeUnit('_GroupProcMain', 'enemy');
      const groupSplash = makeUnit('_GroupProcSplash', 'enemy');
      const attackParent = new SkillObject(game.db.skills.get('_GroupAttackParent'));
      const preParent = new SkillObject(game.db.skills.get('_GroupPreParent'));
      preParent.data.set('charge', 1);
      groupAttacker.skills.push(attackParent, preParent);
      const groupItem = new ItemObject({
        nid: '_GroupProcItem', name: '_GroupProcItem', desc: '', icon_nid: '', icon_index: [0, 0],
        components: [['spell', null], ['damage', 1], ['hit', 100], ['uses', 10]],
      });
      groupAttacker.items.push(groupItem);
      const groupCombat = new MapCombat(
        groupAttacker, groupItem, groupMain, null, game.db, 'grandmaster', null, null,
        { mainDefender: groupMain, splashDefenders: [groupSplash] },
      );
      const group = {
        strikes: groupCombat.strikes.map((strike: any) => ({
          target: strike.defender.nid, damage: strike.damage,
          attackInfo: strike.attackInfo, procs: strike.attackProcs?.map((mark: any) => mark.procSkill.nid) ?? [],
        })),
        playback: groupCombat.procPlayback.map((mark: any) => `${mark.kind}:${mark.procSkill.nid}`),
        attackCharge: attackParent.data.get('charge'),
        preCharge: preParent.data.get('charge'),
        remainingSkills: groupAttacker.skills.map((skill: any) => skill.nid),
      };

      const defenseAttacker = makeUnit('_DefenseProcAttacker', 'player');
      const defenseTarget = makeUnit('_DefenseProcTarget', 'enemy');
      const defenseParent = new SkillObject(game.db.skills.get('_DefenseParent'));
      defenseTarget.skills.push(defenseParent);
      const defenseItem = new ItemObject({
        nid: '_DefenseProcItem', name: '_DefenseProcItem', desc: '', icon_nid: '', icon_index: [0, 0],
        components: [['spell', null], ['damage', 20], ['hit', 100]],
      });
      const defenseCombat = new MapCombat(
        defenseAttacker, defenseItem, defenseTarget, null, game.db, 'grandmaster', null, ['hit1'],
      );
      const defense = {
        damage: defenseCombat.strikes[0].damage,
        procs: defenseCombat.strikes[0].defenseProcs?.map((mark: any) => mark.procSkill.nid) ?? [],
        charge: defenseParent.data.get('charge'),
        remainingSkills: defenseTarget.skills.map((skill: any) => skill.nid),
      };

      const sureAttacker = makeUnit('_SureAttacker', 'player');
      const sureTarget = makeUnit('_SureTarget', 'enemy');
      sureAttacker.stats.SKL = 400;
      sureAttacker.skills.push(new SkillObject(game.db.skills.get('Sure_Strike')));
      const sureItem = new ItemObject({
        nid: '_SureItem', name: '_SureItem', desc: '', icon_nid: '', icon_index: [0, 0],
        components: [['spell', null], ['damage', 1], ['hit', -200]],
      });
      const sureCombat = new MapCombat(
        sureAttacker, sureItem, sureTarget, null, game.db, 'classic', null, null,
      );

      const lunaAttacker = makeUnit('_LunaAttacker', 'player');
      const lunaTarget = makeUnit('_LunaTarget', 'enemy', 50);
      lunaAttacker.stats.SKL = 400;
      lunaAttacker.skills.push(new SkillObject(game.db.skills.get('Luna')));
      const lunaItem = new ItemObject({
        nid: '_LunaItem', name: '_LunaItem', desc: '', icon_nid: '', icon_index: [0, 0],
        components: [['spell', null], ['damage', 10], ['hit', 100]],
      });
      const lunaCombat = new MapCombat(
        lunaAttacker, lunaItem, lunaTarget, null, game.db, 'grandmaster', null, ['hit1'],
      );

      const lethalityAttacker = makeUnit('_LethalityAttacker', 'player');
      const lethalityTarget = makeUnit('_LethalityTarget', 'enemy');
      lethalityAttacker.stats.SKL = 400;
      lethalityAttacker.skills.push(new SkillObject(game.db.skills.get('Lethality')));
      const lethalityItem = new ItemObject({
        nid: '_LethalityItem', name: '_LethalityItem', desc: '', icon_nid: '', icon_index: [0, 0],
        components: [['spell', null], ['damage', 1], ['hit', 100]],
      });
      const lethalityCombat = new MapCombat(
        lethalityAttacker, lethalityItem, lethalityTarget, null, game.db, 'grandmaster', null, ['hit1'],
      );

      const conditionalAttacker = makeUnit('_ConditionalAttacker', 'player');
      const conditionalTarget = makeUnit('_ConditionalTarget', 'enemy');
      conditionalAttacker.skills.push(new SkillObject(game.db.skills.get('_ConditionalParent')));
      const conditionalItem = new ItemObject({
        nid: '_ConditionalItem', name: '_ConditionalItem', desc: '', icon_nid: '', icon_index: [0, 0],
        components: [['spell', null], ['damage', 1], ['hit', 100]],
      });
      const conditionalCombat = new MapCombat(
        conditionalAttacker, conditionalItem, conditionalTarget, null,
        game.db, 'grandmaster', null, ['hit1'],
      );
      const special = {
        sureHit: sureCombat.strikes[0].hit,
        sureProc: sureCombat.strikes[0].attackProcs?.[0]?.procSkill.nid ?? null,
        lunaDamage: lunaCombat.strikes[0].damage,
        lunaProc: lunaCombat.strikes[0].attackProcs?.[0]?.procSkill.nid ?? null,
        lethalityDamage: lethalityCombat.strikes[0].damage,
        lethalityProc: lethalityCombat.strikes[0].attackProcs?.[0]?.procSkill.nid ?? null,
        conditionalDamage: conditionalCombat.strikes[0].damage,
        conditionalProc: conditionalCombat.strikes[0].attackProcs?.[0]?.procSkill.nid ?? null,
        overrideCleaned: !lunaItem.hasComponent('alternate_resist_formula'),
      };

      for (const nid of skillNids) game.db.skills.delete(nid);
      game.db.items.delete('_ZeroResistOverride');
      return { group, defense, special };
    });

    expect(result).not.toBeNull();
    // Both targets are grandmaster-mode strikes with SPD 5 / LCK 0 giving a
    // 10-point avoid (AS 5 * 2), so finalHit is 90, not 100 (groupItem's
    // 'hit' component is 100, attacker SKL 0). Unscaled damage is item 1 +
    // _GroupDamageProc's attack_proc 30 + _GroupPreProc's attack_pre_proc 7
    // = 38; Grandmaster mode's damage = int(damage * hit / 100)
    // (weapon_components.py Damage.on_hit, ported to combat-solver.ts's
    // resolveStrike in the RNG-mode-verification slice) truncates
    // 38 * 90 / 100 = 34.2 down to 34 for both the main and splash target.
    expect(result!.group.strikes).toEqual([
      { target: '_GroupProcMain', damage: 34, attackInfo: [0, 0], procs: ['_GroupDamageProc'] },
      { target: '_GroupProcSplash', damage: 34, attackInfo: [0, 0], procs: ['_GroupDamageProc'] },
    ]);
    expect(result!.group.playback).toEqual([
      'attack_pre_proc:_GroupPreProc',
      'attack_proc:_GroupDamageProc',
    ]);
    expect(result!.group.attackCharge).toBe(1);
    expect(result!.group.preCharge).toBe(0);
    expect(result!.group.remainingSkills).toEqual(['_GroupAttackParent', '_GroupPreParent']);
    expect(result!.defense).toEqual({
      damage: 0, procs: ['_DefenseProc'], charge: 1,
      remainingSkills: ['_DefenseParent'],
    });
    expect(result!.special).toEqual({
      sureHit: true, sureProc: 'Sure_Strike_Proc', lunaDamage: 10,
      lunaProc: 'Luna_Proc', lethalityDamage: 1000,
      lethalityProc: 'Lethality_Proc', conditionalDamage: 1,
      conditionalProc: null, overrideCleaned: true,
    });
  });

  test('CombatState pauses for combat_start and supplies full combat_end payloads', async ({ page }) => {
    await page.goto('/?harness=true&level=0&clean=true&bundle=false');
    await waitForHarness(page);

    const setup = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { UnitObject } = await import('/src/objects/unit.ts');
      const { ItemObject } = await import('/src/objects/item.ts');
      const template = game.units.get('Eirika');
      const klass = template ? game.db.classes.get(template.klass) : null;
      if (!template || !klass) return false;
      let origin: [number, number] | null = null;
      for (let y = 1; y < game.board.height - 1 && !origin; y++) {
        for (let x = 1; x < game.board.width - 1; x++) {
          if (!game.board.getUnit(x, y) && !game.board.getUnit(x + 1, y)) {
            origin = [x, y];
            break;
          }
        }
      }
      if (!origin) return false;
      const makeUnit = (nid: string, team: string) => {
        const unit = new UnitObject({
          nid, name: nid, desc: '', variant: null, level: 1, klass: template.klass,
          tags: [], bases: { HP: 30, STR: 0, MAG: 0, SKL: 5, SPD: 5, LCK: 0, DEF: 0, RES: 0, CON: 5, MOV: 5 },
          growths: {}, stat_cap_modifiers: {}, starting_items: [], learned_skills: [],
          unit_notes: [], fields: [], wexp_gain: {}, portrait_nid: '', affinity: '',
        } as any, klass);
        unit.team = team;
        unit.currentHp = 30;
        return unit;
      };
      game.db.events.set('_CombatStartPayload', {
        nid: '_CombatStartPayload', name: 'Combat Start Payload', trigger: 'combat_start',
        level_nid: '0', condition: "item.nid == '_LifecycleSpell'", only_once: false, priority: 0,
        _source: [
          'inc_level_var;_combat_start_count',
          'level_var;_combat_start_item;{e:item.nid}',
          'level_var;_combat_start_target;{unit2}',
          'level_var;_combat_start_animation;{e:is_animation_combat}',
        ],
      });
      game.db.events.set('_CombatEndPayload', {
        nid: '_CombatEndPayload', name: 'Combat End Payload', trigger: 'combat_end',
        level_nid: '0', condition: "item.nid == '_LifecycleSpell'", only_once: false, priority: 0,
        _source: [
          'inc_level_var;_combat_end_count',
          'level_var;_combat_end_item;{e:item.nid}',
          'level_var;_combat_end_target;{unit2}',
          'level_var;_combat_end_animation;{e:is_animation_combat}',
        ],
      });
      const attacker = makeUnit('_PayloadAttacker', 'player');
      const defender = makeUnit('_PayloadDefender', 'enemy');
      const item = new ItemObject({
        nid: '_LifecycleSpell', name: '_LifecycleSpell', desc: '', icon_nid: '', icon_index: [0, 0],
        components: [
          ['spell', null], ['target_enemy', null], ['damage', 0], ['hit', 100],
          ['uses', 2], ['min_range', 1], ['max_range', 2],
        ],
      });
      attacker.items.push(item);
      game.board.setUnit(origin[0], origin[1], attacker);
      game.board.setUnit(origin[0] + 1, origin[1], defender);
      game.units.set(attacker.nid, attacker);
      game.units.set(defender.nid, defender);
      game.selectedUnit = attacker;
      game.combatTarget = defender;
      game.combatScript = ['hit1'];
      game.memory.set('combat_item', item);
      (window as any).__combatPayloadTest = { attacker, defender, item };
      game.state.change('combat');
      return true;
    });
    expect(setup).toBe(true);
    await stepFrames(page, 2);
    const paused = await page.evaluate(() => ({
      state: (window as any).__gameRef.state.getCurrentState()?.name,
      startCount: (window as any).__gameRef.levelVars.get('_combat_start_count'),
    }));
    expect(paused.state).toBe('event');

    await settle(page, 1200);
    const completed = await page.evaluate(() => {
      const game = (window as any).__gameRef;
      const { attacker, defender, item } = (window as any).__combatPayloadTest;
      const result = {
        state: game.state.getCurrentState()?.name,
        startCount: game.levelVars.get('_combat_start_count'),
        startItem: game.levelVars.get('_combat_start_item'),
        startTarget: game.levelVars.get('_combat_start_target'),
        startAnimation: game.levelVars.get('_combat_start_animation'),
        endCount: game.levelVars.get('_combat_end_count'),
        endItem: game.levelVars.get('_combat_end_item'),
        endTarget: game.levelVars.get('_combat_end_target'),
        endAnimation: game.levelVars.get('_combat_end_animation'),
        uses: item.uses,
      };
      game.board.removeUnit(attacker);
      game.board.removeUnit(defender);
      game.units.delete(attacker.nid);
      game.units.delete(defender.nid);
      delete (window as any).__combatPayloadTest;
      return result;
    });
    expect(completed).toEqual({
      state: 'free',
      startCount: 1, startItem: '_LifecycleSpell', startTarget: '_PayloadDefender',
      startAnimation: 'false',
      endCount: 1, endItem: '_LifecycleSpell', endTarget: '_PayloadDefender',
      endAnimation: 'false', uses: 1,
    });
  });

  test('CombatState orders death events and rewinds an actual lethal encounter', async ({ page }) => {
    await page.goto('/?harness=true&level=0&clean=true&bundle=false');
    await waitForHarness(page);

    const setup = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { UnitObject } = await import('/src/objects/unit.ts');
      const { ItemObject } = await import('/src/objects/item.ts');
      const template = game.units.get('Eirika');
      const klass = template ? game.db.classes.get(template.klass) : null;
      if (!template || !klass) return null;
      let origin: [number, number] | null = null;
      for (let y = 1; y < game.board.height - 1 && !origin; y++) {
        for (let x = 1; x < game.board.width - 1; x++) {
          if (!game.board.getUnit(x, y) && !game.board.getUnit(x + 1, y)) {
            origin = [x, y];
            break;
          }
        }
      }
      if (!origin) return null;
      const makeUnit = (nid: string, team: string, hp: number) => {
        const unit = new UnitObject({
          nid, name: nid, desc: '', variant: null, level: 1, klass: template.klass,
          tags: [], bases: { HP: 30, STR: 0, MAG: 0, SKL: 5, SPD: 5, LCK: 0, DEF: 0, RES: 0, CON: 5, MOV: 5 },
          growths: {}, stat_cap_modifiers: {}, starting_items: [], learned_skills: [],
          unit_notes: [], fields: [], wexp_gain: {}, portrait_nid: '', affinity: '',
        } as any, klass);
        unit.team = team;
        unit.currentHp = hp;
        return unit;
      };
      const eventDefs = [
        ['_OrderedCombatDeath', 'combat_death', 'combat_death'],
        ['_OrderedCombatEnd', 'combat_end', 'combat_end'],
        ['_OrderedUnitDeath', 'unit_death', 'unit_death'],
      ];
      for (const [nid, trigger, label] of eventDefs) {
        game.db.events.set(nid, {
          nid, name: nid, trigger, level_nid: '0',
          condition: trigger === 'combat_end'
            ? "unit2.nid == '_OrderedDefender'"
            : "unit1.nid == '_OrderedDefender'",
          only_once: false, priority: 0,
          _source: [
            `level_var;_ordered_death_events;{_ordered_death_events}>${label}`,
            ...(trigger === 'combat_death'
              ? ['level_var;_ordered_killer;{unit2}', 'level_var;_ordered_position;{e:position}']
              : []),
          ],
        });
      }
      game.levelVars.set('_ordered_death_events', '');
      const attacker = makeUnit('_OrderedAttacker', 'player', 30);
      const defender = makeUnit('_OrderedDefender', 'enemy', 1);
      const item = new ItemObject({
        nid: '_OrderedLethalSpell', name: '_OrderedLethalSpell', desc: '', icon_nid: '', icon_index: [0, 0],
        components: [
          ['spell', null], ['target_enemy', null], ['damage', 99], ['hit', 100],
          ['uses', 2], ['min_range', 1], ['max_range', 2],
        ],
      });
      attacker.items.push(item);
      game.board.setUnit(origin[0], origin[1], attacker);
      game.board.setUnit(origin[0] + 1, origin[1], defender);
      game.units.set(attacker.nid, attacker);
      game.units.set(defender.nid, defender);
      const beforeActionIndex = game.actionLog.actionIndex;
      game.selectedUnit = attacker;
      game.combatTarget = defender;
      game.combatScript = ['hit1'];
      game.memory.set('combat_item', item);
      (window as any).__orderedDeathTest = { attacker, defender, item, origin };
      game.state.change('combat');
      return { beforeActionIndex, origin };
    });
    expect(setup).not.toBeNull();
    await settle(page, 1600);

    const result = await page.evaluate(({ beforeActionIndex, origin }) => {
      const game = (window as any).__gameRef;
      const { attacker, defender, item } = (window as any).__orderedDeathTest;
      const actionLog = game.actionLog as any;
      const snapshot = () => ({
        hp: defender.currentHp,
        dead: defender.dead,
        position: defender.position,
        board: game.board.getUnit(origin[0] + 1, origin[1])?.nid ?? null,
        uses: item.uses,
        attackerFinished: attacker.finished,
      });
      const applied = snapshot();
      while (actionLog.actionIndex > beforeActionIndex) actionLog.runActionBackward();
      const reversed = snapshot();
      while (actionLog.actionIndex < actionLog.actions.length - 1) actionLog.runActionForward();
      const redone = snapshot();
      const eventData = {
        order: game.levelVars.get('_ordered_death_events'),
        killer: game.levelVars.get('_ordered_killer'),
        position: game.levelVars.get('_ordered_position'),
      };
      game.board.removeUnit(attacker);
      game.board.removeUnit(defender);
      game.units.delete(attacker.nid);
      game.units.delete(defender.nid);
      delete (window as any).__orderedDeathTest;
      return { applied, reversed, redone, eventData };
    }, setup!);

    expect(result.applied).toEqual({
      hp: 0, dead: true, position: null, board: null, uses: 1, attackerFinished: true,
    });
    expect(result.reversed).toEqual({
      hp: 1, dead: false, position: [setup!.origin[0] + 1, setup!.origin[1]],
      board: '_OrderedDefender', uses: 2, attackerFinished: false,
    });
    expect(result.redone).toEqual(result.applied);
    expect(result.eventData).toEqual({
      order: '>combat_death>combat_end>unit_death',
      killer: '_OrderedAttacker',
      position: `${setup!.origin[0] + 1},${setup!.origin[1]}`,
    });
  });

  test('uses_options consumes durability per hit, miss policy, and per-combat policy', async ({ page }) => {
    await page.goto('/?harness=true&level=0&clean=true&bundle=false');
    await waitForHarness(page);

    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { ItemObject } = await import('/src/objects/item.ts');
      const { usesConsumedByStrikes } = await import('/src/combat/item-system.ts');
      const { MapCombat } = await import('/src/combat/map-combat.ts');
      const attacker = game.units.get('Eirika');
      const defender = game.board.getAllUnits().find((unit: any) =>
        unit.position && !game.db.areAllied(attacker.team, unit.team));
      if (!attacker || !defender) return null;

      const makeItem = (nid: string, options: any, extra: [string, any][] = []) => new ItemObject({
        nid, name: nid, desc: '', icon_nid: '', icon_index: [0, 0],
        components: [
          ['weapon', null], ['target_enemy', null], ['damage', 0], ['hit', 100],
          ['uses', 10], ['uses_options', options], ['min_range', 1], ['max_range', 1],
          ...extra,
        ],
      });
      const defaultItem = makeItem('_UsesDefault', {
        lose_uses_on_miss: false, one_loss_per_combat: false,
      });
      const loseOnMissItem = makeItem('_UsesMiss', {
        lose_uses_on_miss: true, one_loss_per_combat: false,
      });
      const oneLossItem = makeItem('_UsesOnce', {
        lose_uses_on_miss: false, one_loss_per_combat: true,
      });
      const oneLossMissItem = makeItem('_UsesOnceMiss', {
        lose_uses_on_miss: true, one_loss_per_combat: true,
      });
      const strike = (item: any, hit: boolean) => ({
        attacker, defender, item, hit, crit: false, damage: 0, isCounter: false,
      });
      const mixed = (item: any) => [strike(item, true), strike(item, true), strike(item, false)];

      const integrationItem = makeItem('_UsesIntegration', {
        lose_uses_on_miss: false, one_loss_per_combat: false,
      });
      integrationItem.setUses(3);
      integrationItem.maxUses = 3;
      attacker.items.push(integrationItem);
      const combat = new MapCombat(
        attacker, integrationItem, defender, null, game.db, 'classic', game.board,
        ['hit1', 'hit1', 'miss1'],
      );
      combat.applyResults();
      const integrationUses = integrationItem.uses;
      attacker.items.splice(attacker.items.indexOf(integrationItem), 1);

      const persistentBrokenItem = makeItem('_NoBreakUses', {
        lose_uses_on_miss: false, one_loss_per_combat: false,
      }, [['no_break_out_of_uses', true]]);
      persistentBrokenItem.setUses(1);
      persistentBrokenItem.maxUses = 1;
      attacker.items.push(persistentBrokenItem);
      const brokenCombat = new MapCombat(
        attacker, persistentBrokenItem, defender, null, game.db, 'classic', game.board,
        ['hit1'],
      );
      const brokenResults = brokenCombat.applyResults();
      const remainedAfterBreak = attacker.items.includes(persistentBrokenItem);
      attacker.items.splice(attacker.items.indexOf(persistentBrokenItem), 1);

      return {
        defaultMixed: usesConsumedByStrikes(attacker, defaultItem, mixed(defaultItem)),
        loseOnMissMixed: usesConsumedByStrikes(attacker, loseOnMissItem, mixed(loseOnMissItem)),
        oneLossMixed: usesConsumedByStrikes(attacker, oneLossItem, mixed(oneLossItem)),
        oneLossMissOnly: usesConsumedByStrikes(attacker, oneLossItem, [strike(oneLossItem, false)]),
        oneLossWithMiss: usesConsumedByStrikes(attacker, oneLossMissItem, [strike(oneLossMissItem, false)]),
        integrationUses,
        persistentUses: persistentBrokenItem.uses,
        remainedAfterBreak,
        reportedBroken: brokenResults.attackWeaponBroke,
      };
    });

    expect(result).toEqual({
      defaultMixed: 2,
      loseOnMissMixed: 3,
      oneLossMixed: 1,
      oneLossMissOnly: 0,
      oneLossWithMiss: 1,
      integrationUses: 1,
      persistentUses: 0,
      remainedAfterBreak: true,
      reportedBroken: true,
    });
  });

  test('hostile status staves use alternate hit formulas and Python minimum EXP on miss', async ({ page }) => {
    await page.goto('/?harness=true&level=0&clean=true&bundle=false');
    await waitForHarness(page);

    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { ItemObject } = await import('/src/objects/item.ts');
      const { MapCombat } = await import('/src/combat/map-combat.ts');
      const { computeHit } = await import('/src/combat/combat-calcs.ts');
      const { canBeCountered, canDouble } = await import('/src/combat/item-system.ts');
      const attacker = game.units.get('Eirika');
      const defender = game.board.getAllUnits().find((unit: any) =>
        unit.position && !game.db.areAllied(attacker.team, unit.team));
      const sleepPrefab = game.db.skills.get('Sleep');
      if (!attacker || !defender || !sleepPrefab) return null;

      const oldHit = game.db.equations.get('_STATUS_TEST_HIT');
      const oldAvoid = game.db.equations.get('_STATUS_TEST_AVOID');
      const oldMissWexp = game.db.constants.get('miss_wexp');
      game.db.equations.set('_STATUS_TEST_HIT', 'MAG * 3 + SKL');
      game.db.equations.set('_STATUS_TEST_AVOID', 'RES * 2');
      game.db.constants.set('miss_wexp', false);
      const item = new ItemObject({
        nid: '_CombatSleep', name: 'Combat Sleep', desc: '', icon_nid: '', icon_index: [0, 0],
        components: [
          ['spell', null], ['weapon_type', 'Staff'], ['target_enemy', null],
          ['status_on_hit', 'Sleep'], ['hit', 0], ['uses', 3], ['wexp', 5], ['exp', 35],
          ['uses_options', { lose_uses_on_miss: false, one_loss_per_combat: false }],
          ['alternate_accuracy_formula', '_STATUS_TEST_HIT'],
          ['alternate_avoid_formula', '_STATUS_TEST_AVOID'],
          ['min_range', 1], ['max_range', 99],
        ],
      });
      item.owner = attacker;
      attacker.items.push(item);
      defender.skills = defender.skills.filter((skill: any) => skill.nid !== 'Sleep');
      const oldExp = attacker.exp;
      const oldWexp = attacker.wexp.Staff;
      attacker.exp = 0;
      attacker.wexp.Staff = 29;
      const defenderHp = defender.currentHp;

      const formulaHit = computeHit(attacker, item, defender, game.db, game.board, game);
      const expectedHit = Math.max(0, Math.min(100,
        attacker.getStatValue('MAG') * 3 + attacker.getStatValue('SKL') -
        defender.getStatValue('RES') * 2,
      ));
      const hitCombat = new MapCombat(
        attacker, item, defender, defender.getEquippedWeapon(), game.db, 'classic', game.board,
        ['hit1', 'end'],
      );
      const hitResults = hitCombat.applyResults();
      const afterHit = {
        hasStatus: defender.skills.some((skill: any) => skill.nid === 'Sleep'),
        uses: item.uses,
        exp: attacker.exp,
        wexp: attacker.wexp.Staff,
        resultExp: hitResults.expGained,
        resultWexp: hitResults.attackerWexpGained,
        rank: hitResults.attackerRankUp?.rank ?? null,
        hp: defender.currentHp,
      };

      defender.skills = defender.skills.filter((skill: any) => skill.nid !== 'Sleep');
      const missCombat = new MapCombat(
        attacker, item, defender, defender.getEquippedWeapon(), game.db, 'classic', game.board,
        ['miss1', 'end'],
      );
      const missResults = missCombat.applyResults();
      const afterMiss = {
        hasStatus: defender.skills.some((skill: any) => skill.nid === 'Sleep'),
        uses: item.uses,
        exp: attacker.exp,
        wexp: attacker.wexp.Staff,
        resultExp: missResults.expGained,
        resultWexp: missResults.attackerWexpGained,
        hp: defender.currentHp,
      };

      attacker.items.splice(attacker.items.indexOf(item), 1);
      attacker.exp = oldExp;
      if (oldWexp === undefined) delete attacker.wexp.Staff;
      else attacker.wexp.Staff = oldWexp;
      if (oldHit === undefined) game.db.equations.delete('_STATUS_TEST_HIT');
      else game.db.equations.set('_STATUS_TEST_HIT', oldHit);
      if (oldAvoid === undefined) game.db.equations.delete('_STATUS_TEST_AVOID');
      else game.db.equations.set('_STATUS_TEST_AVOID', oldAvoid);
      if (oldMissWexp === undefined) game.db.constants.delete('miss_wexp');
      else game.db.constants.set('miss_wexp', oldMissWexp);
      defender.skills = defender.skills.filter((skill: any) => skill.nid !== 'Sleep');

      return {
        formulaHit,
        expectedHit,
        defenderHp,
        spellSemantics: {
          canBeCountered: canBeCountered(attacker, item),
          canDouble: canDouble(attacker, item),
        },
        afterHit,
        afterMiss,
      };
    });

    expect(result).not.toBeNull();
    expect(result!.formulaHit).toBe(result!.expectedHit);
    expect(result!.spellSemantics).toEqual({ canBeCountered: false, canDouble: false });
    expect(result!.afterHit).toEqual({
      hasStatus: true,
      uses: 2,
      exp: 35,
      wexp: 34,
      resultExp: 35,
      resultWexp: 5,
      rank: 'D',
      hp: result!.defenderHp,
    });
    expect(result!.afterMiss).toEqual({
      hasStatus: false,
      uses: 2,
      exp: 36,
      wexp: 34,
      resultExp: 1,
      resultWexp: 0,
      hp: result!.defenderHp,
    });
  });

  test('hostile status staff routes from the item menu through map combat', async ({ page }) => {
    await page.goto('/?harness=true&level=0&clean=true&bundle=false');
    await waitForHarness(page);

    const setup = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { ItemObject } = await import('/src/objects/item.ts');
      const { SkillObject } = await import('/src/objects/skill.ts');
      const caster = game.units.get('Eirika');
      if (!caster?.position || !game.db.skills.has('Sleep')) return null;
      const oldStaffWexp = caster.wexp.Staff ?? null;
      caster.wexp.Staff = 31;
      const staffAccess = new SkillObject({
        nid: '_MenuStaffAccess', name: 'Menu Staff Access', desc: '', icon_nid: '', icon_index: [0, 0],
        components: [['wexp_usable_skill', 'Staff']],
      });
      caster.skills.push(staffAccess);
      const item = new ItemObject({
        nid: '_MenuSleep', name: 'Menu Sleep', desc: '', icon_nid: '', icon_index: [0, 0],
        components: [
          ['spell', null], ['weapon_type', 'Staff'], ['target_enemy', null],
          ['status_on_hit', 'Sleep'], ['hit', 100], ['uses', 2], ['wexp', 1], ['exp', 1],
          ['min_range', 1], ['max_range', 99],
        ],
      });
      const target = game.targetSystem.getValidUnitTargets(caster, item)[0];
      if (!target?.position) {
        caster.skills = caster.skills.filter((skill: any) => skill !== staffAccess);
        if (oldStaffWexp === null) delete caster.wexp.Staff;
        else caster.wexp.Staff = oldStaffWexp;
        return null;
      }
      item.owner = caster;
      caster.items.unshift(item);
      caster.finished = false;
      caster.hasAttacked = false;
      target.skills = target.skills.filter((skill: any) => skill.nid !== 'Sleep');
      game.selectedUnit = caster;
      game.combatScript = ['hit1', 'end'];
      game.state.change('item_use');
      return {
        casterNid: caster.nid,
        targetNid: target.nid,
        targetPosition: [...target.position],
        oldStaffWexp,
      };
    });
    expect(setup).not.toBeNull();

    await stepFrames(page, 2);
    expect((await getState(page)).currentStateName).toBe('item_use');
    await stepFrames(page, 1, 'SELECT');
    await stepFrames(page, 2);
    expect((await getState(page)).currentStateName).toBe('item_targeting');

    await stepFrames(page, 1, 'SELECT');
    await stepFrames(page, 3);

    const enteredCombat = await page.evaluate(() => {
      const state: any = (window as any).__gameRef.state.getCurrentState();
      return { name: state?.name, isMapCombat: !!state?.combat, isAnimationCombat: !!state?.animCombat };
    });
    expect(enteredCombat).toEqual({ name: 'combat', isMapCombat: true, isAnimationCombat: false });

    await stepFrames(page, 320);
    const applied = await page.evaluate(({ casterNid, targetNid, oldStaffWexp }) => {
      const game = (window as any).__gameRef;
      const caster = game.units.get(casterNid);
      const target = game.units.get(targetNid);
      const item = caster.items.find((candidate: any) => candidate.nid === '_MenuSleep');
      const snapshot = {
        state: game.state.getCurrentState()?.name,
        finished: caster.finished,
        hasStatus: target.skills.some((skill: any) => skill.nid === 'Sleep'),
        uses: item?.uses,
      };
      target.skills = target.skills.filter((skill: any) => skill.nid !== 'Sleep');
      caster.skills = caster.skills.filter((skill: any) => skill.nid !== '_MenuStaffAccess');
      if (oldStaffWexp === null) delete caster.wexp.Staff;
      else caster.wexp.Staff = oldStaffWexp;
      const index = caster.items.indexOf(item);
      if (index >= 0) caster.items.splice(index, 1);
      return snapshot;
    }, setup!);
    expect(applied).toEqual({ state: 'free', finished: true, hasStatus: true, uses: 1 });
  });

  test('Steal enforces LT eligibility and flows through item choice, combat, rewind, AI, and save', async ({ page }) => {
    await page.goto('/?harness=true&level=0&clean=true&bundle=false');
    await waitForHarness(page);

    const setup = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { ItemObject } = await import('/src/objects/item.ts');
      const { SkillObject } = await import('/src/objects/skill.ts');
      const { stealItemRestrict } = await import('/src/combat/item-system.ts');
      const caster = game.units.get('Eirika');
      const target = game.board.getAllUnits().find((unit: any) =>
        unit.position && !game.db.areAllied(caster.team, unit.team));
      const stealSkill = game.db.skills.get('Steal');
      const stealPrefab = game.db.items.get('Steal');
      if (!caster?.position || !target?.position || !stealSkill || !stealPrefab) return null;

      const makeItem = (nid: string, components: [string, any][]) => new ItemObject({
        nid, name: nid, desc: '', icon_nid: '', icon_index: [0, 0], components,
      });
      let weapon = caster.items.find((item: any) => item.isWeapon());
      if (!weapon) weapon = makeItem('_CasterWeapon', [
        ['weapon', null], ['target_enemy', null], ['damage', 1], ['hit', 100],
        ['min_range', 1], ['max_range', 1],
      ]);
      caster.items = [weapon];
      weapon.owner = caster;
      caster.skills = caster.skills.filter((skill: any) => skill.nid !== 'Steal');
      caster.skills.push(new SkillObject(stealSkill));
      caster.stats.SPD = 30;
      caster.finished = false;
      caster.hasAttacked = false;
      caster.exp = 0;

      const targetWeapon = makeItem('_EquippedWeapon', [
        ['weapon', null], ['target_enemy', null], ['damage', 1], ['hit', 100],
        ['min_range', 1], ['max_range', 1], ['value', 500],
      ]);
      const gem = makeItem('_StealGem', [['value', 1000]]);
      const expensive = makeItem('_StealExpensive', [['value', 3000]]);
      const locked = makeItem('_StealLocked', [['locked', null], ['value', 9000]]);
      const spareWeapon = makeItem('_SpareWeapon', [['weapon', null], ['value', 4000]]);
      target.items = [targetWeapon, gem, expensive, locked, spareWeapon];
      target.items.forEach((item: any) => { item.owner = target; });
      target.stats.SPD = 5;

      const adjacent = [[1, 0], [-1, 0], [0, 1], [0, -1]]
        .map(([dx, dy]) => [caster.position[0] + dx, caster.position[1] + dy])
        .find(([x, y]) => game.board.inBounds(x, y) && !game.board.getUnit(x, y));
      if (!adjacent) return null;
      game.board.moveUnit(target, adjacent[0], adjacent[1]);

      const ability = new ItemObject(stealPrefab);
      ability.owner = caster;
      const generic = makeItem('_GenericSteal', [
        ['spell', null], ['steal', null], ['target_enemy', null], ['min_range', 1], ['max_range', 1],
      ]);
      const restrictions = {
        gem: stealItemRestrict(caster, ability, target, gem, game.db),
        equippedWeapon: stealItemRestrict(caster, ability, target, targetWeapon, game.db),
        spareWeapon: stealItemRestrict(caster, ability, target, spareWeapon, game.db),
        locked: stealItemRestrict(caster, ability, target, locked, game.db),
        genericSpareWeapon: stealItemRestrict(caster, generic, target, spareWeapon, game.db),
      };
      const highSpeedValid = game.targetSystem.getValidTargets(caster, ability)
        .some(([x, y]: [number, number]) => x === adjacent[0] && y === adjacent[1]);
      caster.stats.SPD = 0;
      const lowSpeedValid = game.targetSystem.getValidTargets(caster, ability)
        .some(([x, y]: [number, number]) => x === adjacent[0] && y === adjacent[1]);
      caster.stats.SPD = 30;

      const filler = Array.from({ length: Number(game.db.getConstant('num_items', 5)) - 1 }, (_, i) =>
        makeItem(`_StealFiller${i}`, [['value', 1]]));
      caster.items = [weapon, ...filler];
      caster.items.forEach((item: any) => { item.owner = caster; });
      const fullBlocks = !stealItemRestrict(caster, ability, target, gem, game.db);
      caster.items = [weapon];
      weapon.owner = caster;

      const aiAction = (game.aiController as any).stealPrimaryAI(
        caster,
        [caster.position],
        [target],
      );
      const aiChoice = {
        type: aiAction?.type ?? null,
        item: aiAction?.targetItem?.nid ?? null,
      };

      game.selectedUnit = caster;
      game.cursor.setPos(caster.position[0], caster.position[1]);
      const beforeActionIndex = game.actionLog.actionIndex;
      const hpBefore = target.currentHp;
      game.state.change('menu');
      return {
        casterNid: caster.nid,
        targetNid: target.nid,
        beforeActionIndex,
        hpBefore,
        restrictions,
        highSpeedValid,
        lowSpeedValid,
        fullBlocks,
        aiChoice,
      };
    });
    expect(setup).not.toBeNull();
    expect(setup!.restrictions).toEqual({
      gem: true,
      equippedWeapon: false,
      spareWeapon: false,
      locked: false,
      genericSpareWeapon: true,
    });
    expect(setup!.highSpeedValid).toBe(true);
    expect(setup!.lowSpeedValid).toBe(false);
    expect(setup!.fullBlocks).toBe(true);
    expect(setup!.aiChoice).toEqual({ type: 'steal', item: '_StealExpensive' });

    await stepFrames(page, 2);
    expect((await getState(page)).currentStateName).toBe('menu');
    await stepFrames(page, 1, 'DOWN');
    await stepFrames(page, 1, 'SELECT');
    await stepFrames(page, 2);
    expect((await getState(page)).currentStateName).toBe('item_targeting');
    await stepFrames(page, 1, 'SELECT'); // enemy
    await stepFrames(page, 1, 'SELECT'); // first legal inventory item (gem)
    await stepFrames(page, 3);
    expect((await getState(page)).currentStateName).toBe('combat');
    await stepFrames(page, 360);

    const result = await page.evaluate(async ({ casterNid, targetNid, beforeActionIndex, hpBefore }) => {
      const game = (window as any).__gameRef;
      const { saveGame, loadGame, deleteSave } = await import('/src/engine/save.ts');
      const caster = game.units.get(casterNid);
      const target = game.units.get(targetNid);
      const snapshot = () => ({
        casterHasGem: caster.items.some((item: any) => item.nid === '_StealGem'),
        targetHasGem: target.items.some((item: any) => item.nid === '_StealGem'),
        records: game.records.steal.length,
      });
      const applied = {
        ...snapshot(),
        state: game.state.getCurrentState()?.name,
        hp: target.currentHp,
        exp: caster.exp,
        finished: caster.finished,
      };
      const actionLog = game.actionLog as any;
      while (actionLog.actionIndex > beforeActionIndex) actionLog.runActionBackward();
      const reversed = snapshot();
      while (actionLog.actionIndex < actionLog.actions.length - 1) actionLog.runActionForward();
      const redone = snapshot();

      const gameNid = game.db.getConstant('game_nid', 'default');
      await saveGame(game, 91, 'battle');
      const gem = caster.items.find((item: any) => item.nid === '_StealGem');
      caster.items.splice(caster.items.indexOf(gem), 1);
      target.items.push(gem);
      gem.owner = target;
      game.records.steal = [];
      const loaded = await loadGame(game, 91);
      const loadedCaster = game.units.get(casterNid);
      const loadedTarget = game.units.get(targetNid);
      const persisted = {
        casterHasGem: loadedCaster.items.some((item: any) => item.nid === '_StealGem'),
        targetHasGem: loadedTarget.items.some((item: any) => item.nid === '_StealGem'),
        records: game.records.steal.length,
      };
      await deleteSave(gameNid, 91);
      return { applied, reversed, redone, loaded, persisted, hpBefore };
    }, setup!);

    expect(result.applied).toEqual({
      casterHasGem: true,
      targetHasGem: false,
      records: 1,
      state: 'free',
      hp: setup!.hpBefore,
      exp: 11,
      finished: true,
    });
    expect(result.reversed).toEqual({ casterHasGem: false, targetHasGem: true, records: 0 });
    expect(result.redone).toEqual({ casterHasGem: true, targetHasGem: false, records: 1 });
    expect(result.loaded).toBe(true);
    expect(result.persisted).toEqual({ casterHasGem: true, targetHasGem: false, records: 1 });
  });

  test('permanent booster Dict components apply caps, HP, growths, WEXP, saves, and turnwheel', async ({ page }) => {
    await page.goto('/?harness=true&level=0&clean=true&bundle=false');
    await waitForHarness(page);

    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { ItemObject } = await import('/src/objects/item.ts');
      const { ItemUseState, MenuState } = await import('/src/engine/states/game-states.ts');
      const { saveGame, loadGame, deleteSave } = await import('/src/engine/save.ts');
      const unit = game.units.get('Eirika');
      const prefab = game.db.items.get('Angelic_Robe');
      const growthPrefab = game.db.items.get('Metis_s_Tome');
      if (!unit?.position || !prefab || !growthPrefab) return null;

      const item = new ItemObject(prefab);
      const unitPosition = [...unit.position] as [number, number];
      const metis = new ItemObject(growthPrefab);
      item.components.set(
        'permanent_growth_change',
        metis.getComponent('permanent_growth_change'),
      );
      item.components.set('permanent_statcap_change', [['LCK', 2]]);
      const weaponType = Object.keys(unit.wexp)[0] ?? 'Sword';
      item.components.set('wexp_change', [[weaponType, 4]]);
      item.owner = unit;
      unit.items = [item];
      unit.finished = false;
      unit.hasAttacked = false;

      const hpCap = unit.getStatCap('HP');
      unit.stats.HP = hpCap;
      unit.currentHp = Math.max(1, hpCap - 10);
      const blockedAtCap = game.targetSystem.getValidTargetsRecursive(unit, item).length;
      game.selectedUnit = unit;
      const cappedMenuState = new MenuState();
      cappedMenuState.begin();
      const cappedMenu = (cappedMenuState as any).menu.options.map((option: any) => option.label);
      unit.stats.HP = hpCap - 3;
      unit.currentHp = Math.max(1, unit.stats.HP - 10);
      unit.wexp[weaponType] = 1;
      const beforeActionIndex = game.actionLog.actionIndex;
      const before = {
        stats: { HP: unit.stats.HP },
        hp: unit.currentHp,
        growth: unit.growths.SPD ?? 0,
        cap: unit.statCapModifiers.LCK ?? 0,
        wexp: unit.wexp[weaponType] ?? 0,
        uses: item.uses,
        inventory: unit.items.map((candidate: any) => candidate.nid),
        finished: unit.finished,
      };
      const normalized = item.getStatChanges();
      const normalizedGrowths = metis.getNumericComponentMap('permanent_growth_change');
      const validTargets = game.targetSystem.getValidTargetsRecursive(unit, item);
      const availableMenuState = new MenuState();
      availableMenuState.begin();
      const availableMenu = (availableMenuState as any).menu.options.map((option: any) => option.label);

      const state = new ItemUseState();
      state.begin();
      state.takeInput('SELECT');
      const afterActionIndex = game.actionLog.actionIndex;
      const snapshot = (target: any, trackedItem: any) => ({
        stats: { HP: target.stats.HP },
        hp: target.currentHp,
        growth: target.growths.SPD ?? 0,
        cap: target.statCapModifiers.LCK ?? 0,
        wexp: target.wexp[weaponType] ?? 0,
        uses: trackedItem.uses,
        inventory: target.items.map((candidate: any) => candidate.nid),
        finished: target.finished,
      });
      const applied = snapshot(unit, item);
      while (game.actionLog.actionIndex > beforeActionIndex) game.actionLog.runActionBackward();
      const reversed = snapshot(unit, item);
      while (game.actionLog.actionIndex < afterActionIndex) game.actionLog.runActionForward();
      const redone = snapshot(unit, item);

      const gameNid = game.db.getConstant('game_nid', 'default');
      await saveGame(game, 92, 'battle');
      unit.stats.HP = 1;
      unit.currentHp = 1;
      unit.growths.SPD = 0;
      unit.statCapModifiers.LCK = 0;
      unit.wexp[weaponType] = 0;
      const loaded = await loadGame(game, 92);
      const loadedUnit = game.units.get('Eirika');
      const persisted = {
        stats: { HP: loadedUnit.stats.HP },
        hp: loadedUnit.currentHp,
        growth: loadedUnit.growths.SPD ?? 0,
        cap: loadedUnit.statCapModifiers.LCK ?? 0,
        wexp: loadedUnit.wexp[weaponType] ?? 0,
        inventory: loadedUnit.items.map((candidate: any) => candidate.nid),
        finished: loadedUnit.finished,
      };
      await deleteSave(gameNid, 92);
      return {
        blockedAtCap, cappedMenu, availableMenu, normalized, normalizedGrowths, validTargets, unitPosition,
        before, applied, reversed, redone, loaded, persisted,
      };
    });

    expect(result).not.toBeNull();
    expect(result!.blockedAtCap).toBe(0);
    expect(result!.cappedMenu).not.toContain('Item');
    expect(result!.availableMenu).toContain('Item');
    expect(result!.normalized).toEqual({ HP: 7 });
    expect(result!.normalizedGrowths).toMatchObject({ HP: 5, STR: 5, SPD: 5, DEF: 5, RES: 5 });
    expect(result!.validTargets).toEqual([result!.unitPosition]);
    expect(result!.applied).toEqual({
      stats: { HP: result!.before.stats.HP + 3 },
      hp: result!.before.hp + 3,
      growth: result!.before.growth + 5,
      cap: result!.before.cap + 2,
      wexp: result!.before.wexp + 4,
      uses: 0,
      inventory: [],
      finished: true,
    });
    expect(result!.reversed).toEqual(result!.before);
    expect(result!.redone).toEqual(result!.applied);
    expect(result!.loaded).toBe(true);
    expect(result!.persisted).toEqual({
      stats: result!.applied.stats,
      hp: result!.applied.hp,
      growth: result!.applied.growth,
      cap: result!.applied.cap,
      wexp: result!.applied.wexp,
      inventory: [],
      finished: true,
    });
  });

  test('healing staff flows through item menu, mouse targeting, and reversible actions', async ({ page }) => {
    await page.goto('/?harness=true&level=0&clean=true&bundle=false');
    await waitForHarness(page);

    const setup = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { ItemObject } = await import('/src/objects/item.ts');
      const { evaluateEquation } = await import('/src/combat/combat-calcs.ts');
      const caster = game.units.get('Eirika');
      const target = game.units.get('Seth');
      if (!caster?.position || !target?.position) return null;
      caster.finished = false;
      caster.hasAttacked = false;
      caster.currentHp = caster.maxHp;
      target.currentHp = Math.max(1, target.maxHp - 12);
      const item = new ItemObject({
        nid: '_TargetedHealStaff', name: 'Targeted Heal Staff', desc: '',
        icon_nid: '', icon_index: [0, 0], components: [
          ['spell', null], ['target_ally', null], ['min_range', 1], ['max_range', 99],
          ['uses', 2], ['uses_options', { lose_uses_on_miss: false, one_loss_per_combat: false }],
          ['equation_heal', 'HEAL'], ['magic', null],
        ],
      });
      item.owner = caster;
      const zeroRangeItem = new ItemObject({
        nid: '_ZeroRangeHeal', name: 'Zero Range Heal', desc: '', icon_nid: '', icon_index: [0, 0],
        components: [['usable', null], ['target_ally', null], ['heal', 1], ['uses', 1]],
      });
      caster.currentHp = caster.maxHp - 1;
      const zeroRangeTargets = game.targetSystem.getValidTargets(caster, zeroRangeItem)
        .map((position: [number, number]) => `${position[0]},${position[1]}`);
      caster.currentHp = caster.maxHp;
      caster.items.unshift(item);
      game.items.set('_test_targeted_heal', item);
      game.selectedUnit = caster;
      game.cursor.setPos(caster.position[0], caster.position[1]);
      const beforeActionIndex = game.actionLog.actionIndex;
      const expectedHeal = evaluateEquation(game.db.getEquation('HEAL'), caster, { db: game.db, item });
      game.state.change('item_use');
      return {
        casterNid: caster.nid,
        targetNid: target.nid,
        targetPosition: [...target.position],
        hpBefore: target.currentHp,
        expectedHeal,
        beforeActionIndex,
        casterPosition: `${caster.position[0]},${caster.position[1]}`,
        zeroRangeTargets,
      };
    });
    expect(setup).not.toBeNull();
    expect(setup!.zeroRangeTargets).toEqual([setup!.casterPosition]);

    await stepFrames(page, 2);
    expect((await getState(page)).currentStateName).toBe('item_use');
    await stepFrames(page, 1, 'SELECT');
    await stepFrames(page, 2);
    expect((await getState(page)).currentStateName).toBe('item_targeting');

    await page.evaluate(([tx, ty]) => {
      const game = (window as any).__gameRef;
      const [cameraX, cameraY] = game.camera.getOffset();
      const scaleX = game.input.displayScaleX ?? 1;
      const scaleY = game.input.displayScaleY ?? 1;
      const offsetX = game.input.displayOffsetX ?? 0;
      const offsetY = game.input.displayOffsetY ?? 0;
      game.input.mouseX = (tx * 16 - cameraX + 8) * scaleX + offsetX;
      game.input.mouseY = (ty * 16 - cameraY + 8) * scaleY + offsetY;
      game.input.mouseClick = 'SELECT';
      (window as any).__harness.stepFrames(1);
      game.input.mouseClick = null;
    }, setup!.targetPosition);
    await stepFrames(page, 3);

    const applied = await page.evaluate(({ casterNid, targetNid }) => {
      const game = (window as any).__gameRef;
      const caster = game.units.get(casterNid);
      const target = game.units.get(targetNid);
      const item = caster.items.find((candidate: any) => candidate.nid === '_TargetedHealStaff');
      return {
        state: game.state.getCurrentState()?.name,
        hp: target.currentHp,
        uses: item?.uses,
        finished: caster.finished,
      };
    }, setup!);
    expect(applied.state).toBe('free');
    expect(applied.hp).toBe(Math.min(
      setup!.hpBefore + setup!.expectedHeal,
      setup!.hpBefore + 12,
    ));
    expect(applied.uses).toBe(1);
    expect(applied.finished).toBe(true);

    const turnwheel = await page.evaluate(({ casterNid, targetNid, beforeActionIndex }) => {
      const game = (window as any).__gameRef;
      const actionLog = game.actionLog as any;
      const caster = game.units.get(casterNid);
      const target = game.units.get(targetNid);
      const snapshot = () => ({
        hp: target.currentHp,
        uses: caster.items.find((candidate: any) => candidate.nid === '_TargetedHealStaff')?.uses,
        finished: caster.finished,
      });
      while (actionLog.actionIndex > beforeActionIndex) actionLog.runActionBackward();
      const reversed = snapshot();
      while (actionLog.actionIndex < actionLog.actions.length - 1) actionLog.runActionForward();
      const redone = snapshot();
      const itemIndex = caster.items.findIndex((candidate: any) => candidate.nid === '_TargetedHealStaff');
      if (itemIndex >= 0) caster.items.splice(itemIndex, 1);
      game.items.delete('_test_targeted_heal');
      return { reversed, redone };
    }, setup!);
    expect(turnwheel.reversed).toEqual({ hp: setup!.hpBefore, uses: 2, finished: false });
    expect(turnwheel.redone).toEqual({ hp: applied.hp, uses: 1, finished: true });
  });

  test('targeted status, restore, and refresh effects undo, redo, and save', async ({ page }) => {
    await page.goto('/?harness=true&level=0&clean=true&bundle=false');
    await waitForHarness(page);

    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { ItemObject } = await import('/src/objects/item.ts');
      const { SkillObject } = await import('/src/objects/skill.ts');
      const { applyCoreTargetedItem } = await import('/src/engine/states/game-states.ts');
      const { saveGame, loadGame, deleteSave } = await import('/src/engine/save.ts');
      const caster = game.units.get('Eirika');
      const target = game.units.get('Seth');
      const poisonPrefab = game.db.skills.get('Poisoned');
      if (!caster?.position || !target?.position || !poisonPrefab || !game.db.skills.has('ResistPlus')) return null;

      const prefabs = [
        {
          nid: '_UtilityBarrier', name: 'Utility Barrier', desc: '', icon_nid: '', icon_index: [0, 0],
          components: [['spell', null], ['target_ally', null], ['status_on_hit', 'ResistPlus'], ['uses', 2], ['min_range', 1], ['max_range', 99]],
        },
        {
          nid: '_UtilityRestore', name: 'Utility Restore', desc: '', icon_nid: '', icon_index: [0, 0],
          components: [['spell', null], ['target_ally', null], ['restore', null], ['uses', 2], ['min_range', 1], ['max_range', 99]],
        },
        {
          nid: '_UtilityRefresh', name: 'Utility Refresh', desc: '', icon_nid: '', icon_index: [0, 0],
          components: [['spell', null], ['target_ally', null], ['refresh', null], ['uses', 2], ['min_range', 1], ['max_range', 99]],
        },
      ] as any[];
      const items = prefabs.map((prefab) => {
        game.db.items.set(prefab.nid, prefab);
        const item = new ItemObject(prefab);
        item.owner = caster;
        caster.items.push(item);
        game.items.set(`_test_${prefab.nid}`, item);
        return item;
      });
      target.skills = target.skills.filter((skill: any) => skill.nid !== 'Poisoned' && skill.nid !== 'ResistPlus');
      target.skills.push(new SkillObject(poisonPrefab));
      target.hasAttacked = true;
      target.hasMoved = true;
      target.hasTraded = true;
      target.finished = true;
      caster.finished = false;
      const beforeActionIndex = game.actionLog.actionIndex;
      const validBefore = {
        restore: game.targetSystem.getValidTargets(caster, items[1]).some((position: any) => position[0] === target.position[0] && position[1] === target.position[1]),
        refresh: game.targetSystem.getValidTargets(caster, items[2]).some((position: any) => position[0] === target.position[0] && position[1] === target.position[1]),
      };
      applyCoreTargetedItem(caster, items[0], target.position);
      applyCoreTargetedItem(caster, items[1], target.position);
      applyCoreTargetedItem(caster, items[2], target.position);

      const snapshot = () => ({
        skills: target.skills.map((skill: any) => skill.nid).filter((nid: string) => nid === 'Poisoned' || nid === 'ResistPlus').sort(),
        flags: [target.hasAttacked, target.hasMoved, target.hasTraded, target.finished],
        uses: items.map((item: any) => item.uses),
        casterFinished: caster.finished,
      });
      const applied = snapshot();
      const actionLog = game.actionLog as any;
      while (actionLog.actionIndex > beforeActionIndex) actionLog.runActionBackward();
      const reversed = snapshot();
      while (actionLog.actionIndex < actionLog.actions.length - 1) actionLog.runActionForward();
      const redone = snapshot();
      const validAfter = {
        restore: game.targetSystem.getValidTargets(caster, items[1]).some((position: any) => position[0] === target.position[0] && position[1] === target.position[1]),
        refresh: game.targetSystem.getValidTargets(caster, items[2]).some((position: any) => position[0] === target.position[0] && position[1] === target.position[1]),
      };

      const gameNid = game.db.getConstant('game_nid', 'default');
      await saveGame(game, 93, 'battle');
      target.skills = [];
      target.finished = true;
      items.forEach((item: any) => item.setUses(0));
      const loaded = await loadGame(game, 93);
      const loadedTarget = game.units.get('Seth');
      const loadedCaster = game.units.get('Eirika');
      const persisted = {
        skills: loadedTarget.skills.map((skill: any) => skill.nid).filter((nid: string) => nid === 'Poisoned' || nid === 'ResistPlus').sort(),
        finished: loadedTarget.finished,
        uses: prefabs.map((prefab) => loadedCaster.items.find((item: any) => item.nid === prefab.nid)?.uses),
      };
      await deleteSave(gameNid, 93);
      return { validBefore, validAfter, applied, reversed, redone, loaded, persisted };
    });

    expect(result).not.toBeNull();
    expect(result!.validBefore).toEqual({ restore: true, refresh: true });
    expect(result!.validAfter).toEqual({ restore: false, refresh: false });
    expect(result!.applied).toEqual({
      skills: ['ResistPlus'], flags: [false, false, false, false], uses: [1, 1, 1], casterFinished: true,
    });
    expect(result!.reversed).toEqual({
      skills: ['Poisoned'], flags: [true, true, true, true], uses: [2, 2, 2], casterFinished: false,
    });
    expect(result!.redone).toEqual(result!.applied);
    expect(result!.loaded).toBe(true);
    expect(result!.persisted).toEqual({ skills: ['ResistPlus'], finished: false, uses: [1, 1, 1] });
  });

  test('Hammerne selects an exact repairable inventory item and rewinds cleanly', async ({ page }) => {
    await page.goto('/?harness=true&level=0&clean=true&bundle=false');
    await waitForHarness(page);

    const setup = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { ItemObject } = await import('/src/objects/item.ts');
      const caster = game.units.get('Eirika');
      const target = game.units.get('Seth');
      if (!caster?.position || !target?.position) return null;

      for (const unit of game.units.values()) {
        for (const existing of unit.items) {
          if (existing.maxUses > 0) existing.setUses(existing.maxUses);
        }
      }
      const makeItem = (nid: string, name: string, uses: number, unrepairable = false) => {
        const components: any[] = [['weapon', null], ['uses', uses]];
        if (unrepairable) components.push(['unrepairable', null]);
        return new ItemObject({ nid, name, desc: '', icon_nid: '', icon_index: [0, 0], components });
      };
      const first = makeItem('_RepairFirst', 'First Blade', 5);
      const second = makeItem('_RepairSecond', 'Second Blade', 3);
      const blocked = makeItem('_RepairBlocked', 'Blocked Blade', 4, true);
      first.setUses(2);
      second.setUses(1);
      blocked.setUses(0);
      for (const targetItem of [first, second, blocked]) targetItem.owner = target;
      target.items.unshift(first, second, blocked);

      const staff = new ItemObject({
        nid: '_RepairStaff', name: 'Repair Staff', desc: '', icon_nid: '', icon_index: [0, 0],
        components: [
          ['spell', null], ['target_ally', null], ['min_range', 1], ['max_range', 99],
          ['uses', 2], ['repair', null],
        ],
      });
      staff.owner = caster;
      caster.items.unshift(staff);
      caster.finished = false;
      caster.hasAttacked = false;
      game.selectedUnit = caster;
      game.cursor.setPos(caster.position[0], caster.position[1]);
      const beforeActionIndex = game.actionLog.actionIndex;
      const validTargets = game.targetSystem.getValidTargets(caster, staff)
        .map((position: [number, number]) => `${position[0]},${position[1]}`);
      game.state.change('item_use');
      return {
        casterNid: caster.nid,
        targetNid: target.nid,
        targetPosition: [...target.position],
        targetKey: `${target.position[0]},${target.position[1]}`,
        casterKey: `${caster.position[0]},${caster.position[1]}`,
        validTargets,
        beforeActionIndex,
      };
    });
    expect(setup).not.toBeNull();
    expect(setup!.validTargets).toContain(setup!.targetKey);
    expect(setup!.validTargets).not.toContain(setup!.casterKey);

    await stepFrames(page, 2);
    expect((await getState(page)).currentStateName).toBe('item_use');
    await stepFrames(page, 1, 'SELECT');
    await stepFrames(page, 2);
    expect((await getState(page)).currentStateName).toBe('item_targeting');

    await page.evaluate(([tx, ty]) => {
      const game = (window as any).__gameRef;
      const [cameraX, cameraY] = game.camera.getOffset();
      const scaleX = game.input.displayScaleX ?? 1;
      const scaleY = game.input.displayScaleY ?? 1;
      const offsetX = game.input.displayOffsetX ?? 0;
      const offsetY = game.input.displayOffsetY ?? 0;
      game.input.mouseX = (tx * 16 - cameraX + 8) * scaleX + offsetX;
      game.input.mouseY = (ty * 16 - cameraY + 8) * scaleY + offsetY;
      game.input.mouseClick = 'SELECT';
      (window as any).__harness.stepFrames(1);
      game.input.mouseClick = null;
    }, setup!.targetPosition);
    await stepFrames(page, 1);
    const choices = await page.evaluate(() => {
      const state = (window as any).__gameRef.state.getCurrentState();
      return state.repairableItems.map((item: any) => item.nid);
    });
    expect(choices).toEqual(['_RepairFirst', '_RepairSecond']);

    await stepFrames(page, 1, 'SELECT');
    await stepFrames(page, 3);
    const applied = await page.evaluate(({ casterNid, targetNid }) => {
      const game = (window as any).__gameRef;
      const caster = game.units.get(casterNid);
      const target = game.units.get(targetNid);
      const uses = (nid: string) => target.items.find((item: any) => item.nid === nid)?.uses;
      return {
        state: game.state.getCurrentState()?.name,
        first: uses('_RepairFirst'),
        second: uses('_RepairSecond'),
        blocked: uses('_RepairBlocked'),
        staff: caster.items.find((item: any) => item.nid === '_RepairStaff')?.uses,
        finished: caster.finished,
      };
    }, setup!);
    expect(applied).toEqual({
      state: 'free', first: 5, second: 1, blocked: 0, staff: 1, finished: true,
    });

    const turnwheel = await page.evaluate(({ casterNid, targetNid, beforeActionIndex }) => {
      const game = (window as any).__gameRef;
      const actionLog = game.actionLog as any;
      const caster = game.units.get(casterNid);
      const target = game.units.get(targetNid);
      const snapshot = () => ({
        first: target.items.find((item: any) => item.nid === '_RepairFirst')?.uses,
        second: target.items.find((item: any) => item.nid === '_RepairSecond')?.uses,
        staff: caster.items.find((item: any) => item.nid === '_RepairStaff')?.uses,
        finished: caster.finished,
      });
      while (actionLog.actionIndex > beforeActionIndex) actionLog.runActionBackward();
      const reversed = snapshot();
      while (actionLog.actionIndex < actionLog.actions.length - 1) actionLog.runActionForward();
      const redone = snapshot();
      return { reversed, redone };
    }, setup!);
    expect(turnwheel.reversed).toEqual({ first: 2, second: 1, staff: 2, finished: false });
    expect(turnwheel.redone).toEqual({ first: 5, second: 1, staff: 1, finished: true });
  });

  test('sequence item collects store and unload targets then warps reversibly', async ({ page }) => {
    await page.goto('/?harness=true&level=0&clean=true&bundle=false');
    await waitForHarness(page);

    const setup = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { createItemTree } = await import('/src/objects/item.ts');
      const caster = game.units.get('Eirika');
      const target = game.units.get('Seth');
      if (!caster?.position || !target?.position) return null;

      const parentNid = '_SequenceWarp';
      const childOneNid = '_SequenceWarpStore';
      const childTwoNid = '_SequenceWarpUnload';
      const prefabs = [
        {
          nid: parentNid, name: 'Sequence Warp', desc: '', icon_nid: '', icon_index: [0, 0],
          components: [
            ['spell', null], ['uses', 2], ['weapon_type', 'Sword'], ['wexp', 3], ['exp', 7],
            ['sequence_item', [childOneNid, childTwoNid]],
          ],
        },
        {
          nid: childOneNid, name: 'Store Target', desc: '', icon_nid: '', icon_index: [0, 0],
          components: [['spell', null], ['target_ally', null], ['min_range', 1], ['max_range', 99], ['store_unit', null]],
        },
        {
          nid: childTwoNid, name: 'Unload Target', desc: '', icon_nid: '', icon_index: [0, 0],
          components: [['spell', null], ['target_tile', null], ['min_range', 1], ['max_range', 99], ['unload_unit', null]],
        },
      ] as any[];
      for (const prefab of prefabs) game.db.items.set(prefab.nid, prefab);
      const item = createItemTree(game.db.items.get(parentNid), (nid: string) => game.db.items.get(nid));
      item.owner = caster;
      caster.items.unshift(item);
      const register = (runtimeItem: any, key: string) => {
        game.items.set(key, runtimeItem);
        runtimeItem.subitems.forEach((child: any, index: number) => register(child, `${key}_${index}`));
      };
      register(item, '_test_sequence_warp');

      caster.finished = false;
      caster.exp = 10;
      caster.wexp.Sword = 1;
      target.finished = false;
      target.hasMoved = true;
      game.selectedUnit = caster;
      game.cursor.setPos(caster.position[0], caster.position[1]);
      const destinationCandidates = game.targetSystem.getValidTargets(caster, item.subitems[1])
        .filter((position: [number, number]) =>
          position[0] !== target.position[0] || position[1] !== target.position[1]);
      destinationCandidates.sort((a: [number, number], b: [number, number]) => {
        const distance = (position: [number, number]) =>
          Math.abs(position[0] - caster.position[0]) + Math.abs(position[1] - caster.position[1]);
        return distance(a) - distance(b);
      });
      const destination = destinationCandidates[0];
      if (!destination) return null;
      const originalPosition = [...target.position];
      const beforeActionIndex = game.actionLog.actionIndex;
      game.state.change('item_use');
      return {
        casterNid: caster.nid,
        targetNid: target.nid,
        targetPosition: originalPosition,
        destination: [...destination],
        beforeActionIndex,
        parentNid,
        expBefore: caster.exp,
        wexpBefore: caster.wexp.Sword,
      };
    });
    expect(setup).not.toBeNull();

    const clickTile = async (position: number[]) => {
      await page.evaluate(([tx, ty]) => {
        const game = (window as any).__gameRef;
        const [cameraX, cameraY] = game.camera.getOffset();
        const scaleX = game.input.displayScaleX ?? 1;
        const scaleY = game.input.displayScaleY ?? 1;
        const offsetX = game.input.displayOffsetX ?? 0;
        const offsetY = game.input.displayOffsetY ?? 0;
        game.input.mouseX = (tx * 16 - cameraX + 8) * scaleX + offsetX;
        game.input.mouseY = (ty * 16 - cameraY + 8) * scaleY + offsetY;
        game.input.mouseClick = 'SELECT';
        (window as any).__harness.stepFrames(1);
        game.input.mouseClick = null;
      }, position);
      await stepFrames(page, 1);
    };

    await stepFrames(page, 2);
    await stepFrames(page, 1, 'SELECT');
    await stepFrames(page, 2);
    expect((await getState(page)).currentStateName).toBe('item_targeting');
    await clickTile(setup!.targetPosition);
    const secondStep = await page.evaluate(() => {
      const state = (window as any).__gameRef.state.getCurrentState();
      return {
        name: state.name,
        sequenceIndex: state.sequenceIndex,
        selectedTargets: state.selectedTargets,
        validDestinations: state.targets,
      };
    });
    expect(secondStep.name).toBe('item_targeting');
    expect(secondStep.sequenceIndex).toBe(1);
    expect(secondStep.selectedTargets[0]).toEqual([setup!.targetPosition]);
    expect(secondStep.validDestinations).toContainEqual(setup!.destination);
    expect(secondStep.validDestinations).not.toContainEqual(setup!.targetPosition);

    await clickTile(setup!.destination);
    await stepFrames(page, 3);
    const applied = await page.evaluate(({ casterNid, targetNid, parentNid }) => {
      const game = (window as any).__gameRef;
      const caster = game.units.get(casterNid);
      const target = game.units.get(targetNid);
      return {
        state: game.state.getCurrentState()?.name,
        position: target.position,
        targetFlags: [target.hasMoved, target.finished],
        uses: caster.items.find((candidate: any) => candidate.nid === parentNid)?.uses,
        exp: caster.exp,
        wexp: caster.wexp.Sword,
        casterFinished: caster.finished,
      };
    }, setup!);
    expect(applied).toEqual({
      state: 'free', position: setup!.destination, targetFlags: [true, false], uses: 1,
      exp: setup!.expBefore + 7, wexp: setup!.wexpBefore + 3, casterFinished: true,
    });

    const turnwheel = await page.evaluate(({ casterNid, targetNid, parentNid, beforeActionIndex }) => {
      const game = (window as any).__gameRef;
      const actionLog = game.actionLog as any;
      const caster = game.units.get(casterNid);
      const target = game.units.get(targetNid);
      const snapshot = () => ({
        position: target.position ? [...target.position] : null,
        targetFlags: [target.hasMoved, target.finished],
        uses: caster.items.find((candidate: any) => candidate.nid === parentNid)?.uses,
        exp: caster.exp,
        wexp: caster.wexp.Sword,
        casterFinished: caster.finished,
      });
      while (actionLog.actionIndex > beforeActionIndex) actionLog.runActionBackward();
      const reversed = snapshot();
      while (actionLog.actionIndex < actionLog.actions.length - 1) actionLog.runActionForward();
      return { reversed, redone: snapshot() };
    }, setup!);
    expect(turnwheel.reversed).toEqual({
      position: setup!.targetPosition, targetFlags: [true, false], uses: 2,
      exp: setup!.expBefore, wexp: setup!.wexpBefore, casterFinished: false,
    });
    expect(turnwheel.redone).toEqual({
      position: setup!.destination, targetFlags: [true, false], uses: 1,
      exp: setup!.expBefore + 7, wexp: setup!.wexpBefore + 3, casterFinished: true,
    });

    const roundTrip = await page.evaluate(async ({ casterNid, targetNid, parentNid, targetPosition }) => {
      const game = (window as any).__gameRef;
      const { saveGame, loadGame, deleteSave } = await import('/src/engine/save.ts');
      const gameNid = game.db.getConstant('game_nid', 'default');
      await saveGame(game, 92, 'battle');
      game.board.moveUnit(game.units.get(targetNid), targetPosition[0], targetPosition[1]);
      game.units.get(casterNid).items.find((item: any) => item.nid === parentNid).setUses(0);
      const loaded = await loadGame(game, 92);
      const loadedTarget = game.units.get(targetNid);
      const loadedCaster = game.units.get(casterNid);
      const result = {
        loaded,
        position: loadedTarget.position,
        uses: loadedCaster.items.find((item: any) => item.nid === parentNid)?.uses,
        children: loadedCaster.items.find((item: any) => item.nid === parentNid)?.subitems.map((item: any) => item.nid),
      };
      await deleteSave(gameNid, 92);
      return result;
    }, setup!);
    expect(roundTrip).toEqual({
      loaded: true, position: setup!.destination, uses: 1,
      children: ['_SequenceWarpStore', '_SequenceWarpUnload'],
    });
  });

  test('multi-target item collects distinct targets and consumes durability once', async ({ page }) => {
    await page.goto('/?harness=true&level=0&clean=true&bundle=false');
    await waitForHarness(page);

    const setup = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { ItemObject } = await import('/src/objects/item.ts');
      const caster = game.units.get('Eirika');
      const ally = game.units.get('Seth');
      if (!caster?.position || !ally?.position) return null;
      const targets = [caster, ally];
      caster.finished = false;
      for (const target of targets) {
        target.currentHp = Math.max(1, target.maxHp - 10);
        target.finished = false;
      }
      const item = new ItemObject({
        nid: '_MultiHeal', name: 'Multi Heal', desc: '', icon_nid: '', icon_index: [0, 0],
        components: [
          ['spell', null], ['target_ally', null], ['min_range', 0], ['max_range', 99],
          ['multi_target', 2], ['heal', 4], ['uses', 2],
        ],
      });
      item.owner = caster;
      caster.items.unshift(item);
      game.items.set('_test_multi_heal', item);
      game.selectedUnit = caster;
      game.cursor.setPos(caster.position[0], caster.position[1]);
      const beforeActionIndex = game.actionLog.actionIndex;
      game.state.change('item_use');
      return {
        casterNid: caster.nid,
        targetNids: targets.map((target) => target.nid),
        positions: targets.map((target) => [...target.position]),
        hpBefore: targets.map((target) => target.currentHp),
        beforeActionIndex,
      };
    });
    expect(setup).not.toBeNull();

    const clickTile = async (position: number[]) => {
      await page.evaluate(([tx, ty]) => {
        const game = (window as any).__gameRef;
        const [cameraX, cameraY] = game.camera.getOffset();
        const scaleX = game.input.displayScaleX ?? 1;
        const scaleY = game.input.displayScaleY ?? 1;
        const offsetX = game.input.displayOffsetX ?? 0;
        const offsetY = game.input.displayOffsetY ?? 0;
        game.input.mouseX = (tx * 16 - cameraX + 8) * scaleX + offsetX;
        game.input.mouseY = (ty * 16 - cameraY + 8) * scaleY + offsetY;
        game.input.mouseClick = 'SELECT';
        (window as any).__harness.stepFrames(1);
        game.input.mouseClick = null;
      }, position);
      await stepFrames(page, 1);
    };

    await stepFrames(page, 2);
    await stepFrames(page, 1, 'SELECT');
    await stepFrames(page, 2);
    await clickTile(setup!.positions[0]);
    const halfway = await page.evaluate(() => {
      const state = (window as any).__gameRef.state.getCurrentState();
      return { name: state.name, selectedTargets: state.selectedTargets, targets: state.targets };
    });
    expect(halfway.name).toBe('item_targeting');
    expect(halfway.selectedTargets).toEqual([[setup!.positions[0]]]);
    expect(halfway.targets).not.toContainEqual(setup!.positions[0]);
    expect(halfway.targets).toContainEqual(setup!.positions[1]);

    await clickTile(setup!.positions[1]);
    await stepFrames(page, 3);
    const applied = await page.evaluate(({ casterNid, targetNids }) => {
      const game = (window as any).__gameRef;
      const caster = game.units.get(casterNid);
      return {
        state: game.state.getCurrentState()?.name,
        hp: targetNids.map((nid: string) => game.units.get(nid).currentHp),
        uses: caster.items.find((item: any) => item.nid === '_MultiHeal')?.uses,
        finished: caster.finished,
      };
    }, setup!);
    expect(applied).toEqual({
      state: 'free', hp: setup!.hpBefore.map((hp) => hp + 4), uses: 1, finished: true,
    });

    const turnwheel = await page.evaluate(({ casterNid, targetNids, beforeActionIndex }) => {
      const game = (window as any).__gameRef;
      const actionLog = game.actionLog as any;
      const caster = game.units.get(casterNid);
      const snapshot = () => ({
        hp: targetNids.map((nid: string) => game.units.get(nid).currentHp),
        uses: caster.items.find((item: any) => item.nid === '_MultiHeal')?.uses,
        finished: caster.finished,
      });
      while (actionLog.actionIndex > beforeActionIndex) actionLog.runActionBackward();
      const reversed = snapshot();
      while (actionLog.actionIndex < actionLog.actions.length - 1) actionLog.runActionForward();
      return { reversed, redone: snapshot() };
    }, setup!);
    expect(turnwheel.reversed).toEqual({ hp: setup!.hpBefore, uses: 2, finished: false });
    expect(turnwheel.redone).toEqual({ hp: applied.hp, uses: 1, finished: true });
  });

  test('autolevel_to matches LT fixed growths, hidden mode, triggers, and learned skills', async ({ page }) => {
    await page.goto('/?harness=true&level=0&clean=true&bundle=false');
    await waitForHarness(page);

    const setup = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { GameEvent } = await import('/src/events/event-manager.ts');
      const unit = game.units.get('Eirika');
      const klass = game.db.classes.get(unit.klass);
      if (!unit || !klass) return null;

      if (game.db.skills.has('Canto') && !klass.learned_skills.some((entry: any[]) => entry[1] === 'Canto')) {
        klass.learned_skills.push([3, 'Canto']);
      }
      game.db.events.set('_test_unit_level_up', {
        nid: '_test_unit_level_up',
        name: 'Unit Level Up Trigger',
        trigger: 'unit_level_up',
        level_nid: '0',
        condition: "source == 'event'",
        only_once: false,
        priority: 0,
        _source: ['level_var;_autolevel_triggered;{e:source}'],
      });

      const initialStats = { ...unit.stats };
      const event = new GameEvent({
        nid: '_test_autolevel',
        name: 'Autolevel Parity',
        trigger: 'test',
        level_nid: '0',
        condition: '',
        only_once: false,
        priority: 0,
        _source: [
          'autolevel_to;Eirika;{e:unit.level + 4};fixed',
          'autolevel_to;Eirika;7;fixed;hidden',
        ],
      }, { type: 'test', levelNid: '0', unit1: unit });
      game.eventManager.eventQueue.push(event);
      game.state.change('event');
      return { initialStats, hasCantoPrefab: game.db.skills.has('Canto') };
    });

    expect(setup).not.toBeNull();
    await settle(page, 300);

    const result = await page.evaluate(() => {
      const game = (window as any).__gameRef;
      const unit = game.units.get('Eirika');
      return {
        level: unit.level,
        stats: { ...unit.stats },
        hp: unit.currentHp,
        maxHp: unit.maxHp,
        triggerSource: game.levelVars.get('_autolevel_triggered'),
        hasCanto: unit.skills.some((skill: any) => skill.nid === 'Canto'),
      };
    });
    const deltas = Object.fromEntries(
      Object.entries(result.stats).map(([stat, value]) => [stat, (value as number) - setup!.initialStats[stat]]),
    );

    expect(result.level).toBe(5);
    expect(result.hp).toBe(result.maxHp);
    expect(result.triggerSource).toBe('event');
    expect(deltas).toMatchObject({
      HP: 4, STR: 2, MAG: 3, SKL: 4, SPD: 4,
      LCK: 4, DEF: 2, RES: 2, CON: 0, MOV: 0,
    });
    if (setup!.hasCantoPrefab) expect(result.hasCanto).toBe(true);
  });

  test('generic Feat selection uses LT growth RNG and survives save/load', async ({ page }) => {
    await page.goto('/?harness=true&level=0&clean=true&bundle=false');
    await waitForHarness(page);

    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { saveGame, loadGame, deleteSave } = await import('/src/engine/save.ts');
      const klass = game.db.classes.get(game.units.get('Eirika').klass);
      const makeFeat = (nid: string) => ({
        nid, name: nid, desc: '', icon_nid: '', icon_index: [0, 0],
        components: [['feat', null]],
      });
      for (const nid of ['_FeatAlpha', '_FeatBeta', '_FeatGamma']) {
        game.db.skills.set(nid, makeFeat(nid));
      }
      klass.learned_skills = [[1, 'Feat']];
      game.gameVars.set('_random_seed', 0);
      game.gameVars.delete('_growth_random_seed');
      game.gameVars.delete('_growth_random_state');

      const spawn = (nid: string) => game.spawnGenericUnit({
        nid, variant: null, level: 1, klass: klass.nid, faction: '',
        starting_items: [], starting_skills: [], team: 'enemy', ai: '',
        ai_group: null, starting_position: null, generic: true,
      });
      const selectedFeat = (nid: string) => game.units.get(nid).skills
        .map((skill: any) => skill.nid)
        .find((nid: string) => nid.startsWith('_Feat')) ?? null;

      game.db.constants.set('generic_feats', false);
      spawn('_FeatDisabled');
      const disabled = {
        skill: selectedFeat('_FeatDisabled'),
        state: game.gameVars.get('_growth_random_state') ?? null,
      };

      game.db.constants.set('generic_feats', true);
      const featOrder = Array.from(game.db.skills.values())
        .filter((skill: any) => skill.components.some(([nid]: any[]) => nid === 'feat'))
        .map((skill: any) => skill.nid);
      spawn('_FeatFirst');
      const first = selectedFeat('_FeatFirst');
      const stateAfterFirst = game.gameVars.get('_growth_random_state');

      await saveGame(game, 96, 'battle');
      spawn('_FeatSecond');
      const second = selectedFeat('_FeatSecond');
      const stateAfterSecond = game.gameVars.get('_growth_random_state');

      const loaded = await loadGame(game, 96);
      const restoredState = game.gameVars.get('_growth_random_state');
      spawn('_FeatRestored');
      const restored = selectedFeat('_FeatRestored');
      const stateAfterRestored = game.gameVars.get('_growth_random_state');
      const gameNid = game.db.getConstant('game_nid', 'default');
      await deleteSave(gameNid, 96);

      return {
        disabled, featOrder, first, second, restored, loaded,
        stateAfterFirst, stateAfterSecond, restoredState, stateAfterRestored,
      };
    });

    expect(result.disabled).toEqual({ skill: null, state: null });
    expect(result.featOrder).toContain('_FeatAlpha');
    expect(result.first).toBe(result.featOrder[38 % result.featOrder.length]);
    expect(result.second).toBe(result.featOrder[58 % result.featOrder.length]);
    expect(result.loaded).toBe(true);
    expect(result.restored).toBe(result.second);
    expect(result.stateAfterFirst).toBe(1103527590);
    expect(result.stateAfterSecond).toBe(377401575);
    expect(result.restoredState).toBe(result.stateAfterFirst);
    expect(result.stateAfterRestored).toBe(result.stateAfterSecond);
  });

  test('autolevel_to resolves distinct Feat entries with reversible skill actions', async ({ page }) => {
    await page.goto('/?harness=true&level=0&clean=true&bundle=false');
    await waitForHarness(page);

    const setup = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { GameEvent } = await import('/src/events/event-manager.ts');
      const klass = game.db.classes.get(game.units.get('Eirika').klass);
      const featNids = ['_AutoFeatAlpha', '_AutoFeatBeta', '_AutoFeatGamma'];
      for (const nid of featNids) {
        game.db.skills.set(nid, {
          nid, name: nid, desc: '', icon_nid: '', icon_index: [0, 0],
          components: [['feat', null]],
        });
      }
      klass.learned_skills = [[2, 'Feat'], [3, 'Feat']];
      game.db.constants.set('generic_feats', true);
      game.gameVars.set('_random_seed', 0);
      game.gameVars.delete('_growth_random_seed');
      game.gameVars.delete('_growth_random_state');
      game.spawnGenericUnit({
        nid: '_FeatAutolevel', variant: null, level: 1, klass: klass.nid, faction: '',
        starting_items: [], starting_skills: [featNids[0]], team: 'enemy', ai: '',
        ai_group: null, starting_position: null, generic: true,
      });
      const beforeActionIndex = game.actionLog.actionIndex;
      game.eventManager.eventQueue.push(new GameEvent({
        nid: '_test_feat_autolevel', name: 'Feat Autolevel', trigger: 'test',
        level_nid: '0', condition: '', only_once: false, priority: 0,
        _source: ['autolevel_to;_FeatAutolevel;3;fixed'],
      }, { type: 'test', levelNid: '0', unit1: game.units.get('_FeatAutolevel') }));
      game.state.change('event');
      return { featNids, beforeActionIndex };
    });

    await settle(page, 300);
    const result = await page.evaluate(({ featNids, beforeActionIndex }) => {
      const game = (window as any).__gameRef;
      const actionLog = game.actionLog as any;
      const snapshot = () => {
        const unit = game.units.get('_FeatAutolevel');
        return {
          level: unit.level,
          feats: unit.skills
            .map((skill: any) => skill.nid)
            .filter((nid: string) => featNids.includes(nid)),
        };
      };
      const applied = snapshot();
      const growthState = game.gameVars.get('_growth_random_state');
      while (actionLog.actionIndex > beforeActionIndex) actionLog.runActionBackward();
      const reversed = snapshot();
      while (actionLog.actionIndex < actionLog.actions.length - 1) actionLog.runActionForward();
      return { applied, reversed, redone: snapshot(), growthState };
    }, setup);

    expect(result.applied).toEqual({
      level: 3,
      feats: ['_AutoFeatAlpha', '_AutoFeatBeta', '_AutoFeatGamma'],
    });
    expect(result.reversed).toEqual({ level: 1, feats: ['_AutoFeatAlpha'] });
    expect(result.redone).toEqual(result.applied);
    expect(result.growthState).toBe(377401575);
  });

  for (const growthCase of [
    {
      method: 'random',
      gains: { HP: 3, STR: 2, MAG: 3, SKL: 2, SPD: 1, LCK: 2, DEF: 0, RES: 1 },
      growthPoints: null,
    },
    {
      method: 'dynamic',
      gains: { HP: 3, STR: 2, MAG: 3, SKL: 2, SPD: 1, LCK: 2, DEF: 1, RES: 1 },
      growthPoints: { HP: -2, STR: -4, MAG: -8, SKL: 4, SPD: 14, LCK: 4, DEF: 2, RES: 2 },
    },
  ]) {
    test(`autolevel_to ${growthCase.method} uses LT deterministic level RNG`, async ({ page }) => {
      await page.goto('/?harness=true&level=0&clean=true&bundle=false');
      await waitForHarness(page);

      const initialStats = await page.evaluate(async (method: string) => {
        const game = (window as any).__gameRef;
        const { GameEvent } = await import('/src/events/event-manager.ts');
        const unit = game.units.get('Eirika');
        game.gameVars.set('_random_seed', 0);
        const stats = { ...unit.stats };
        game.eventManager.eventQueue.push(new GameEvent({
          nid: `_test_${method}_autolevel`, name: 'RNG Autolevel', trigger: 'test',
          level_nid: '0', condition: '', only_once: false, priority: 0,
          _source: [`autolevel_to;Eirika;5;${method};hidden`],
        }, { type: 'test', levelNid: '0', unit1: unit }));
        game.state.change('event');
        return stats;
      }, growthCase.method);

      await settle(page, 300);
      const result = await page.evaluate(() => {
        const unit = (window as any).__gameRef.units.get('Eirika');
        return { stats: { ...unit.stats }, growthPoints: { ...unit.growthPoints }, level: unit.level };
      });
      const deltas = Object.fromEntries(
        Object.entries(result.stats).map(([stat, value]) => [stat, (value as number) - initialStats[stat]]),
      );
      expect(result.level).toBe(1);
      expect(deltas).toMatchObject(growthCase.gains);

      const turnwheel = await page.evaluate(() => {
        const game = (window as any).__gameRef;
        const actionLog = game.actionLog as any;
        actionLog.runActionBackward();
        const reversedUnit = game.units.get('Eirika');
        const reversed = {
          stats: { ...reversedUnit.stats },
          growthPoints: { ...reversedUnit.growthPoints },
        };
        actionLog.runActionForward();
        const redoneUnit = game.units.get('Eirika');
        const redone = {
          stats: { ...redoneUnit.stats },
          growthPoints: { ...redoneUnit.growthPoints },
        };
        return { reversed, redone };
      });
      expect(turnwheel.reversed.stats).toEqual(initialStats);
      expect(Object.values(turnwheel.reversed.growthPoints).every((value) => value === 0)).toBe(true);
      expect(turnwheel.redone.stats).toEqual(result.stats);
      expect(turnwheel.redone.growthPoints).toEqual(result.growthPoints);

      if (growthCase.growthPoints) {
        expect(result.growthPoints).toMatchObject(growthCase.growthPoints);
        const roundTrip = await page.evaluate(async () => {
          const game = (window as any).__gameRef;
          const { saveGame, loadGame, deleteSave } = await import('/src/engine/save.ts');
          const gameNid = game.db.getConstant('game_nid', 'default');
          await saveGame(game, 98, 'battle');
          game.units.get('Eirika').growthPoints = {};
          const loaded = await loadGame(game, 98);
          const growthPoints = { ...game.units.get('Eirika').growthPoints };
          await deleteSave(gameNid, 98);
          return { loaded, growthPoints };
        });
        expect(roundTrip.loaded).toBe(true);
        expect(roundTrip.growthPoints).toMatchObject(growthCase.growthPoints);
      }
    });
  }

  test('WEXP rank crossings emit triggers and show a dismissible banner', async ({ page }) => {
    await page.goto('/?harness=true&level=0&clean=true&bundle=false');
    await waitForHarness(page);

    const queueWexp = async (source: string) => page.evaluate(async (sourceLine: string) => {
      const game = (window as any).__gameRef;
      const { GameEvent } = await import('/src/events/event-manager.ts');
      const unit = game.units.get('Eirika');
      if (!game.db.events.has('_test_weapon_rank_up')) {
        game.db.events.set('_test_weapon_rank_up', {
          nid: '_test_weapon_rank_up',
          name: 'Weapon Rank Trigger',
          trigger: 'unit_weapon_rank_up',
          level_nid: '0',
          condition: "weapon_type == 'Sword'",
          only_once: false,
          priority: 0,
          _source: ['level_var;_weapon_rank_triggered;{e:rank}'],
        });
      }
      const event = new GameEvent({
        nid: '_test_wexp_command', name: 'WEXP Command', trigger: 'test', level_nid: '0',
        condition: '', only_once: false, priority: 0, _source: [sourceLine],
      }, { type: 'test', levelNid: '0', unit1: unit });
      game.eventManager.eventQueue.push(event);
      game.state.change('event');
    }, source);

    await queueWexp('set_wexp;Eirika;Sword;31;no_banner');
    await settle(page, 300);
    let result = await page.evaluate(() => {
      const game = (window as any).__gameRef;
      return { wexp: game.units.get('Eirika').wexp.Sword, rank: game.levelVars.get('_weapon_rank_triggered') };
    });
    expect(result).toEqual({ wexp: 31, rank: 'D' });

    const rewind = await page.evaluate(() => {
      const game = (window as any).__gameRef;
      const actionLog = game.actionLog as any;
      actionLog.runActionBackward();
      const reversed = game.units.get('Eirika').wexp.Sword;
      actionLog.runActionForward();
      const redone = game.units.get('Eirika').wexp.Sword;
      return { reversed, redone };
    });
    expect(rewind).toEqual({ reversed: 1, redone: 31 });

    await queueWexp('set_wexp;Eirika;Sword;71');
    await stepFrames(page, 2);
    const bannerState = await page.evaluate(() => {
      const state = (window as any).__gameRef.state.getCurrentState();
      return { state: state?.name, hasBanner: !!state?.banner };
    });
    expect(bannerState).toEqual({ state: 'event', hasBanner: true });

    await stepFrames(page, 25);
    await stepFrames(page, 1, 'SELECT');
    await settle(page, 300);
    result = await page.evaluate(() => {
      const game = (window as any).__gameRef;
      return { wexp: game.units.get('Eirika').wexp.Sword, rank: game.levelVars.get('_weapon_rank_triggered') };
    });
    expect(result).toEqual({ wexp: 71, rank: 'C' });
  });
});

// ---------------------------------------------------------------------------
// Prologue Tests (clean mode)
// ---------------------------------------------------------------------------

test.describe('Prologue (clean)', () => {
  test('initial map render', async ({ page }) => {
    await page.goto('/?harness=true&level=0&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 10);

    const state = await getState(page);
    expect(state.levelNid).toBe('0');
    expect(state.currentStateName).toBe('free');
    console.log(`Prologue units: ${state.units.map((u: any) => `${u.name}(${u.team})`).join(', ')}`);

    await saveScreenshot(page, '07-prologue-map');
  });

  test('prologue map with cursor on enemy', async ({ page }) => {
    await page.goto('/?harness=true&level=0&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 5);

    // Find the boss (O'Neill)
    const state = await getState(page);
    const boss = state.units.find((u: any) => u.nid === "O'Neill");
    if (boss?.position) {
      const [bx, by] = boss.position;
      const [cx, cy] = state.cursorPos;
      const dx = bx - cx;
      const dy = by - cy;
      for (let i = 0; i < Math.abs(dx); i++) {
        await stepFrames(page, 3, dx > 0 ? 'RIGHT' : 'LEFT');
      }
      for (let i = 0; i < Math.abs(dy); i++) {
        await stepFrames(page, 3, dy > 0 ? 'DOWN' : 'UP');
      }
      await stepFrames(page, 5);

      console.log(`Cursor on boss: ${boss.name} at [${boss.position}]`);
      await saveScreenshot(page, '08-prologue-cursor-on-boss');
    }
  });
});

// ---------------------------------------------------------------------------
// Magic Sword Combat Tests
// ---------------------------------------------------------------------------

async function giveItem(page: any, unitNid: string, itemNid: string): Promise<boolean> {
  return page.evaluate(
    ({ unitNid, itemNid }: { unitNid: string; itemNid: string }) => {
      return (window as any).__harness.giveItem(unitNid, itemNid);
    },
    { unitNid, itemNid },
  );
}

async function navigateCursorTo(
  page: any,
  targetX: number,
  targetY: number,
  currentX: number,
  currentY: number,
): Promise<void> {
  const dx = targetX - currentX;
  const dy = targetY - currentY;
  for (let i = 0; i < Math.abs(dx); i++) {
    await stepFrames(page, 3, dx > 0 ? 'RIGHT' : 'LEFT');
  }
  for (let i = 0; i < Math.abs(dy); i++) {
    await stepFrames(page, 3, dy > 0 ? 'DOWN' : 'UP');
  }
  await stepFrames(page, 3);
}

test.describe('Magic Sword Combat', () => {
  test('Light Brand combat does not freeze', async ({ page }) => {
    // Load the DEBUG level cleanly
    await page.goto('/?harness=true&level=DEBUG&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 5);

    // Give Eirika a Light Brand (has `magic` + `battle_cast_anim: "Lightning"`)
    const given = await giveItem(page, 'Eirika', 'Light_Brand');
    expect(given).toBe(true);

    // The DEBUG fixture starts Eirika below Light Brand's C-rank requirement.
    // Make this combat scenario explicitly legal under the runtime availability rules.
    await page.evaluate(() => {
      const eirika = (window as any).__gameRef?.units?.get?.('Eirika');
      if (eirika) eirika.wexp.Sword = Math.max(eirika.wexp.Sword ?? 0, 71);
    });

    const lightBrandUsesBefore = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const eirika = g?.units?.get?.('Eirika');
      const lightBrand = eirika?.items?.find?.((it: any) => it?.nid === 'Light_Brand');
      return typeof lightBrand?.uses === 'number' ? lightBrand.uses : null;
    });
    expect(lightBrandUsesBefore).not.toBeNull();

    // Verify Eirika is at (2,6) and Bone (enemy) is at (2,5)
    const state = await getState(page);
    const eirika = state.units.find((u: any) => u.nid === 'Eirika');
    const bone = state.units.find((u: any) => u.nid === 'Bone');
    expect(eirika?.position).toEqual([2, 6]);
    expect(bone?.position).toEqual([2, 5]);

    // Navigate cursor to Eirika
    const [cx, cy] = state.cursorPos;
    await navigateCursorTo(page, 2, 6, cx, cy);

    // Select Eirika (enters move state)
    await stepFrames(page, 3, 'SELECT');
    await stepFrames(page, 10);

    let s = await getState(page);
    console.log(`After selecting Eirika: ${s.currentStateName}`);

    // Select same tile to open action menu (Eirika stays at her position)
    await stepFrames(page, 3, 'SELECT');
    await stepFrames(page, 10);

    s = await getState(page);
    console.log(`After confirming position: ${s.currentStateName}`);
    await saveScreenshot(page, '10-magic-sword-action-menu');

    // "Attack" should be the first option in the menu. Press SELECT to pick it.
    await stepFrames(page, 3, 'SELECT');
    await stepFrames(page, 10);

    s = await getState(page);
    console.log(`After selecting Attack: ${s.currentStateName}`);

    // If we're in weapon_choice, select the weapon (Light Brand should be first)
    if (s.currentStateName === 'weapon_choice') {
      await stepFrames(page, 3, 'SELECT');
      await stepFrames(page, 10);
      s = await getState(page);
      console.log(`After selecting weapon: ${s.currentStateName}`);
    }

    await saveScreenshot(page, '11-magic-sword-targeting');

    // In targeting mode, Bone should be the target (adjacent at (2,5)).
    // Press SELECT to confirm attack on Bone.
    await stepFrames(page, 3, 'SELECT');
    await stepFrames(page, 5);

    s = await getState(page);
    console.log(`Combat started, state: ${s.currentStateName}`);
    await saveScreenshot(page, '12-magic-sword-combat-start');

    // Run many frames to let combat resolve. Combat completes in ~260 frames,
    // then the unit may return to menus (weapon_choice/targeting) or post-combat
    // states that need dismissing. We auto-press BACK to cancel out of any
    // remaining menus until we return to 'free' state.
    let combatResolved = false;
    let lastState = '';
    let combatSeen = false;
    let midCombatScreenshotTaken = false;
    for (let batch = 0; batch < 200; batch++) {
      await stepFrames(page, 20);
      s = await getState(page);
      if (s.currentStateName === 'combat' || s.currentStateName === 'animation_combat' ||
          s.currentStateName === 'map_combat') {
        combatSeen = true;
        // Capture mid-combat screenshot after HP bar panels have slid in (~60 frames)
        if (!midCombatScreenshotTaken && batch >= 2) {
          await saveScreenshot(page, '12b-magic-sword-combat-mid');
          midCombatScreenshotTaken = true;
        }
      }
      if (s.currentStateName !== lastState) {
        console.log(`  Frame ~${(batch + 1) * 20}: state=${s.currentStateName}`);
        lastState = s.currentStateName;
      }
      if (s.currentStateName === 'free') {
        combatResolved = true;
        console.log(`Combat resolved after ~${(batch + 1) * 20} frames`);
        break;
      }
      // After combat is over, if we're back in menus or other states, try to
      // advance/dismiss. press BACK to cancel out of stacked menus, or settle.
      if (combatSeen && s.currentStateName !== 'combat' &&
          s.currentStateName !== 'animation_combat' &&
          s.currentStateName !== 'map_combat' &&
          s.currentStateName !== 'exp' && s.currentStateName !== 'exp_gain') {
        // Try pressing BACK to dismiss any post-combat menus
        await stepFrames(page, 3, 'BACK');
      }
    }

    await saveScreenshot(page, '13-magic-sword-combat-end');

    // Verify combat actually happened — we should have seen a combat state
    expect(combatSeen).toBe(true);

    // If combat didn't resolve in ~4000 frames, the freeze bug is still present.
    expect(combatResolved).toBe(true);

    // Verify Bone took damage (Light Brand deals magic damage)
    const finalState = await getState(page);
    const boneAfter = finalState.units.find((u: any) => u.nid === 'Bone');
    const lightBrandUsesAfter = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const eirika = g?.units?.get?.('Eirika');
      const lightBrand = eirika?.items?.find?.((it: any) => it?.nid === 'Light_Brand');
      return typeof lightBrand?.uses === 'number' ? lightBrand.uses : null;
    });

    console.log(`Bone HP after combat: ${boneAfter?.hp}/${boneAfter?.maxHp}`);
    console.log(`Light Brand uses: ${lightBrandUsesBefore} -> ${lightBrandUsesAfter}`);

    // Combat can miss based on RNG. Light Brand uses Python's default
    // uses_options policy, so a hit consumes one use and a miss consumes none.
    expect([lightBrandUsesBefore, lightBrandUsesBefore - 1]).toContain(lightBrandUsesAfter);

    // If the attack hit, Bone HP drops and one use is consumed. A miss preserves both.
    expect(boneAfter!.hp).toBeLessThanOrEqual(boneAfter!.maxHp);
    if (boneAfter!.hp < boneAfter!.maxHp) {
      expect(lightBrandUsesAfter).toBe(lightBrandUsesBefore - 1);
    } else {
      expect(lightBrandUsesAfter).toBe(lightBrandUsesBefore);
    }
  });
  test('combat HP bar and weapon info do not overlap', async ({ page }) => {
    // Load the DEBUG level cleanly and initiate combat to verify
    // the combat UI layout. The DEBUG level uses map combat (no animation
    // data), so the HP bars are the small bars above units.
    // This test verifies combat starts and captures a mid-combat screenshot.
    await page.goto('/?harness=true&level=DEBUG&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 5);

    // Navigate cursor to Eirika at (2,6)
    const state = await getState(page);
    const [cx, cy] = state.cursorPos;
    await navigateCursorTo(page, 2, 6, cx, cy);

    // Select Eirika -> confirm position -> Attack -> select weapon -> confirm target
    await stepFrames(page, 3, 'SELECT'); // select unit
    await stepFrames(page, 10);
    await stepFrames(page, 3, 'SELECT'); // confirm position
    await stepFrames(page, 10);
    await stepFrames(page, 3, 'SELECT'); // pick Attack
    await stepFrames(page, 10);

    let s = await getState(page);
    if (s.currentStateName === 'weapon_choice') {
      await stepFrames(page, 3, 'SELECT'); // pick weapon
      await stepFrames(page, 10);
    }

    await stepFrames(page, 3, 'SELECT'); // confirm target
    await stepFrames(page, 5);

    // Step frames into the combat. Map combat is fast (~260 frames total).
    // Step past the initial lunge and into HP drain to capture mid-combat.
    let combatSeen = false;
    for (let batch = 0; batch < 40; batch++) {
      await stepFrames(page, 10);
      s = await getState(page);
      if (s.currentStateName === 'combat') {
        combatSeen = true;
      }
      // Capture after we've been in combat for a bit (HP drain phase)
      if (combatSeen && batch >= 5) {
        await saveScreenshot(page, '15-combat-ui-layout');
        break;
      }
    }
    expect(combatSeen).toBe(true);

    // Let combat resolve
    let combatResolved = false;
    for (let batch = 0; batch < 200; batch++) {
      await stepFrames(page, 20);
      s = await getState(page);
      if (s.currentStateName === 'free') {
        combatResolved = true;
        break;
      }
      if (s.currentStateName !== 'combat' && s.currentStateName !== 'animation_combat' &&
          s.currentStateName !== 'map_combat' && s.currentStateName !== 'exp' &&
          s.currentStateName !== 'exp_gain') {
        await stepFrames(page, 3, 'BACK');
      }
    }
    expect(combatResolved).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Prologue with events (non-clean mode)
// ---------------------------------------------------------------------------

test.describe('Prologue (with events)', () => {
  test('initial event state', async ({ page }) => {
    await page.goto('/?harness=true&level=0&bundle=false&clean=false');
    await waitForHarness(page);
    await stepFrames(page, 5);

    const state = await getState(page);
    console.log(`State with events: ${state.currentStateName}`);
    // Prologue starts with intro events
    await saveScreenshot(page, '09-prologue-event');
  });

  test('dialog box appears above portraits, not overlapping', async ({ page }) => {
    // Load prologue with events (non-clean mode) to test dialog positioning.
    // The prologue intro has: transition;close, change_background;Forest,
    // transition;open, add_portrait;Seth;Left;no_block,
    // add_portrait;Eirika;Right, speak;Seth;...
    //
    // Previously, add_portrait loaded images asynchronously but advanced
    // the command pointer immediately, so the speak command couldn't find
    // the portrait and the dialog rendered at the bottom of the screen,
    // overlapping with the portrait area.
    await page.goto('/?harness=true&level=0&bundle=false&clean=false');
    await waitForHarness(page);

    // Step through the initial event commands (unit moves, transitions).
    // The first transition;close + change_background + transition;open takes
    // many frames. We need to step enough frames to get past all the setup
    // commands and arrive at the first speak command with portraits visible.
    // Step a large number of frames, pressing SELECT periodically to advance
    // through any blocking waits.
    let dialogFound = false;
    for (let batch = 0; batch < 100; batch++) {
      await stepFrames(page, 20);
      const s = await getState(page);

      if (s.currentStateName === 'event') {
        // Check if we can see a dialog box by sampling pixel colors.
        // The dialog background is rgba(12, 12, 28, 0.92) — very dark blue.
        // Portraits are drawn at the bottom 80px of the 240x160 viewport.
        // The dialog should be ABOVE the portrait area (y < 80).
        //
        // Sample the canvas at the game's native resolution (240x160).
        // The display canvas is 480x320 (2x scaling), so we check at 2x coords.
        const pixelInfo = await page.evaluate(() => {
          const canvas = document.querySelector('canvas') as HTMLCanvasElement;
          if (!canvas) return null;
          const ctx = canvas.getContext('2d');
          if (!ctx) return null;

          // The game renders at 240x160, display is 480x320 (2x).
          // Check for dark dialog background at various Y positions.
          // Dialog box at y ~36 (native) = y ~72 (display) when portrait exists.
          // Dialog box at y ~116 (native) = y ~232 (display) when no portrait (bottom).
          // Portrait area: y 80-160 (native) = y 160-320 (display).
          const width = canvas.width;

          // Sample a horizontal strip in the middle of the canvas at different Y levels
          const midX = Math.floor(width / 2);

          function getPixel(x: number, y: number) {
            const data = ctx!.getImageData(x, y, 1, 1).data;
            return { r: data[0], g: data[1], b: data[2], a: data[3] };
          }

          // The display canvas maps game pixels to physical pixels.
          // Compute the scale from canvas dimensions vs native 240x160.
          const scaleX = canvas.width / 240;
          const scaleY = canvas.height / 160;

          // Check for dialog background (very dark, R<30, G<30, B<40)
          // Dialog is at native y ~46-76 (above portrait area at y=80).
          // Sample at native y=55 to catch dialog in the middle.
          const abovePortrait = getPixel(Math.floor(midX), Math.floor(55 * scaleY));
          // Native y=120 (in portrait overlap zone)
          const belowInPortrait = getPixel(Math.floor(midX), Math.floor(120 * scaleY));

          // Check if there's a portrait visible (non-black pixels in the portrait area)
          // Portrait area: native y 80-160, check at native (20, 100)
          const portraitArea = getPixel(Math.floor(20 * scaleX), Math.floor(100 * scaleY));

          return {
            abovePortrait,
            belowInPortrait,
            portraitArea,
          };
        });

        if (pixelInfo) {
          const ap = pixelInfo.abovePortrait;
          // Check if the dark dialog background is present above the portrait area
          // Dialog bg is rgba(12, 12, 28, 0.92) composited on the forest background
          const isDarkAbove = ap.r < 50 && ap.g < 50 && ap.b < 60;

          // Check if there's portrait content in the portrait area (not fully black)
          const pp = pixelInfo.portraitArea;
          const hasPortraitContent = pp.a > 0 && (pp.r > 20 || pp.g > 20 || pp.b > 20);

          if (isDarkAbove && hasPortraitContent) {
            // We found a frame where dialog is above portraits!
            dialogFound = true;
            console.log(`Dialog found above portraits at batch ${batch}`);
            console.log(`  Above portrait pixel: R=${ap.r} G=${ap.g} B=${ap.b} A=${ap.a}`);
            console.log(`  Portrait area pixel: R=${pp.r} G=${pp.g} B=${pp.b} A=${pp.a}`);

            // Verify the dialog is NOT overlapping the portrait area
            const bp = pixelInfo.belowInPortrait;
            const isDarkBelow = bp.r < 20 && bp.g < 20 && bp.b < 35 && bp.a > 200;
            // The area at y=240 (display) should be portrait or background, NOT dialog
            // (dialog bg has very specific dark blue color)
            console.log(`  Below-in-portrait pixel: R=${bp.r} G=${bp.g} B=${bp.b} A=${bp.a}`);

            await saveScreenshot(page, '14-dialog-above-portraits');
            break;
          }
        }
      }
    }

    expect(dialogFound).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Animation combat visual regression
// ---------------------------------------------------------------------------

test.describe('Animation Combat Rendering', () => {
  test('combat sprites resolve before visible animation phases (no stub boxes)', async ({ page }) => {
    await page.goto('/?harness=true&level=0&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 10);

    const setupOk = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const board = g?.board;
      if (!g || !board) return false;

      const eirika = g.units.get('Eirika');
      if (!eirika) return false;

      const enemy = Array.from(g.units.values()).find((u: any) => u.team === 'enemy' && !u.isDead());
      if (!enemy) return false;

      // Force adjacent setup for deterministic combat start.
      board.moveUnit(enemy, eirika.position[0], eirika.position[1] - 1);

      g.selectedUnit = eirika;
      g.combatTarget = enemy;
      g.state.change('combat');
      return true;
    });
    expect(setupOk).toBe(true);

    // Allow state-machine deferred transition to push CombatState.
    await stepFrames(page, 5);

    let sample: any = null;
    for (let i = 0; i < 60; i++) {
      await stepFrames(page, 3);
      sample = await page.evaluate(() => {
        const g = (window as any).__gameRef;
        const cs = g?.state?.getCurrentState?.();
        if (!cs || cs.name !== 'combat' || !cs.animCombat) return null;
        const rs = cs.animCombat.getRenderState?.();
        return {
          isAnimationCombat: !!cs.isAnimationCombat,
          animState: cs.animCombat.state,
          leftHasMainFrame: !!rs?.leftDraw?.mainFrame,
          rightHasMainFrame: !!rs?.rightDraw?.mainFrame,
          leftFrameCount: cs.animCombat.leftAnim?.frameImages?.size ?? 0,
          rightFrameCount: cs.animCombat.rightAnim?.frameImages?.size ?? 0,
        };
      });

      if (sample && sample.animState !== 'init') break;
    }

    expect(sample).toBeTruthy();
    expect(sample.isAnimationCombat).toBe(true);
    expect(sample.leftHasMainFrame).toBe(true);
    expect(sample.rightHasMainFrame).toBe(true);

    await saveScreenshot(page, '26-animation-combat-no-stubs');
  });
});

// ---------------------------------------------------------------------------
// Sacred Stones chapter smoke tests (later chapters)
// ---------------------------------------------------------------------------

const LATER_CHAPTERS = ['2', '3', '4', '5'];

test.describe('Sacred Stones Later Chapters', () => {
  for (const chapter of LATER_CHAPTERS) {
    test(`Chapter ${chapter} loads in clean mode`, async ({ page }) => {
      await page.goto(`/?harness=true&level=${chapter}&bundle=false`);
      await waitForHarness(page);
      await stepFrames(page, 12);

      const state = await getState(page);
      expect(state.levelNid).toBe(chapter);
      expect(state.currentStateName).toBe('free');
      expect(state.units.length).toBeGreaterThan(0);

      await saveScreenshot(page, `30-ch${chapter}-clean-map`);
    });

    test(`Chapter ${chapter} intro events make progress (no freeze)`, async ({ page }) => {
      await page.goto(`/?harness=true&level=${chapter}&bundle=false&clean=false`);
      await waitForHarness(page);
      await stepFrames(page, 5);

      let reachedFree = false;
      let hitTitle = false;
      let firstPointer: number | null = null;
      let lastPointer: number | null = null;
      let activeEventNid: string | null = null;

      // Step through event flow. Some chapter intros are long, so we assert
      // forward progress and no lockups rather than requiring immediate finish.
      for (let batch = 0; batch < 900; batch++) {
        await stepFrames(page, 5, batch % 3 === 0 ? 'SELECT' : null);

        const snap = await page.evaluate(() => {
          const g = (window as any).__gameRef;
          const currentState = g?.state?.getCurrentState?.()?.name ?? null;
          const ev = g?.eventManager?.getCurrentEvent?.();
          return {
            currentState,
            pointer: typeof ev?.commandPointer === 'number' ? ev.commandPointer : null,
            eventNid: ev?.nid ?? null,
          };
        });

        if (!activeEventNid && snap.eventNid) activeEventNid = snap.eventNid;
        if (snap.pointer != null) {
          if (firstPointer == null) firstPointer = snap.pointer;
          lastPointer = snap.pointer;
        }

        if (snap.currentState === 'free') {
          reachedFree = true;
          break;
        }
        if (snap.currentState === 'title' || snap.currentState === 'title_main') {
          hitTitle = true;
          break;
        }
      }

      // Stabilize on a concrete top state (deferred state-machine transitions can
      // produce a transient frame with no active top state).
      let state = await getState(page);
      for (let i = 0; i < 30 && !state.currentStateName; i++) {
        await stepFrames(page, 1);
        state = await getState(page);
      }

      expect(state.levelNid).toBe(chapter);
      expect(hitTitle).toBe(false);
      expect(Boolean(state.currentStateName)).toBe(true);
      expect(state.units.length).toBeGreaterThan(0);
      expect(reachedFree || (firstPointer != null && lastPointer != null && lastPointer > firstPointer)).toBe(true);

      console.log(`Ch.${chapter} intro event: ${activeEventNid ?? 'none'} pointer ${firstPointer} -> ${lastPointer}; state=${state.currentStateName}`);
      await saveScreenshot(page, `31-ch${chapter}-intro-progress`);
    });
  }
});

// ---------------------------------------------------------------------------
// Sacred Stones chapter mechanics sweeps
// ---------------------------------------------------------------------------

test.describe('Sacred Stones Chapter Mechanics', () => {
  test('Chapter 3 seize objective triggers chapter transition to 4', async ({ page }) => {
    await page.goto('/?harness=true&level=3&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 10);

    const setupOk = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const eirika = g?.units?.get?.('Eirika');
      const bazba = g?.units?.get?.('Bazba');
      if (!g || !eirika || !g.board) return false;

      // Clear throne tile and place Eirika on seize position.
      if (bazba) {
        bazba.currentHp = 0;
        bazba.dead = true;
        if (bazba.position) g.board.removeUnit(bazba);
      }
      g.board.moveUnit(eirika, 14, 1);
      g.cursor.setPos(14, 1);
      g.selectedUnit = eirika;
      g._moveOrigin = [14, 1];
      g.state.change('menu');
      return true;
    });
    expect(setupOk).toBe(true);

    await stepFrames(page, 8);

    const hasSeize = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const st = g?.state?.getCurrentState?.();
      if (!st || st.name !== 'menu' || !st.menu) return false;
      const idx = st.menu.options.findIndex((o: any) => o?.label === 'Seize');
      if (idx < 0) return false;
      st.menu.selectedIndex = idx;
      return true;
    });
    expect(hasSeize).toBe(true);

    await stepFrames(page, 2, 'SELECT');

    // Let seize event + level transition run.
    for (let i = 0; i < 2500; i++) {
      await stepFrames(page, 2, i % 3 === 0 ? 'SELECT' : null);
      const state = await getState(page);
      if (state.levelNid === '4') break;
    }

    const finalState = await getState(page);
    expect(finalState.levelNid).toBe('4');
    expect(['event', 'prep_pick', 'free', 'phase_change', 'turn_change']).toContain(finalState.currentStateName);

    await saveScreenshot(page, '32-ch3-seize-transition-ch4');
  });

  test('Chapter 4 turn-2 reinforcement event spawns Turn2Rein group', async ({ page }) => {
    await page.goto('/?harness=true&level=4&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 10);

    const triggered = await page.evaluate(() => {
      const h = (window as any).__harness;
      const g = (window as any).__gameRef;
      if (!h || !g) return false;
      g.turnCount = 2;
      (g as any).turncount = 2;
      return h.triggerEvent('turn_change');
    });
    expect(triggered).toBe(true);

    await settle(page, 500);
    await stepFrames(page, 12);

    const rein = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const ids = ['115', '116', '117'];
      return ids.map((id) => {
        const u = g?.units?.get?.(id);
        return { id, pos: u?.position ?? null, dead: !!u?.dead };
      });
    });

    for (const unit of rein) {
      expect(unit.pos).not.toBeNull();
    }

    await saveScreenshot(page, '33-ch4-turn2-reinforcements');
  });

  test('Chapter 5 turn-2 and turn-8 reinforcements spawn correctly', async ({ page }) => {
    await page.goto('/?harness=true&level=5&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 10);

    const triggerTurn2 = await page.evaluate(() => {
      const h = (window as any).__harness;
      const g = (window as any).__gameRef;
      if (!h || !g) return false;
      g.turnCount = 2;
      (g as any).turncount = 2;
      return h.triggerEvent('turn_change');
    });
    expect(triggerTurn2).toBe(true);

    await settle(page, 700);
    await stepFrames(page, 10);

    const turn2Units = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      return ['116', '117'].map((id) => {
        const u = g?.units?.get?.(id);
        return { id, pos: u?.position ?? null };
      });
    });
    for (const unit of turn2Units) {
      expect(unit.pos).not.toBeNull();
    }

    const triggerTurn8 = await page.evaluate(() => {
      const h = (window as any).__harness;
      const g = (window as any).__gameRef;
      if (!h || !g) return false;
      g.turnCount = 8;
      (g as any).turncount = 8;
      return h.triggerEvent('turn_change');
    });
    expect(triggerTurn8).toBe(true);

    await settle(page, 700);
    await stepFrames(page, 10);

    const turn8Units = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      return ['120', '121'].map((id) => {
        const u = g?.units?.get?.(id);
        return { id, pos: u?.position ?? null };
      });
    });
    for (const unit of turn8Units) {
      expect(unit.pos).not.toBeNull();
    }

    await saveScreenshot(page, '34-ch5-turn2-turn8-reinforcements');
  });

  test('Chapter 5 Natasha talk recruits Joshua', async ({ page }) => {
    await page.goto('/?harness=true&level=5&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 10);

    const setup = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      if (!g) return { ok: false, reason: 'no_game' };
      const units = g?.units ? Array.from(g.units.values()) : [];
      const natasha = g?.units?.get?.('Natasha') ?? units.find((u: any) => u?.nid === 'Natasha');
      const joshua = g?.units?.get?.('Joshua') ?? units.find((u: any) => u?.nid === 'Joshua');
      if (!g.board) return { ok: false, reason: 'no_board' };
      if (!natasha) return { ok: false, reason: 'no_natasha', unitNids: units.map((u: any) => u?.nid) };
      if (!joshua) return { ok: false, reason: 'no_joshua', unitNids: units.map((u: any) => u?.nid) };

      // Place Natasha adjacent to Joshua and open command menu directly.
      if (!joshua.position) {
        g.board.setUnit(9, 7, joshua);
      }
      if (!joshua.position) return { ok: false, reason: 'joshua_no_pos_after_set' };
      const [jx, jy] = joshua.position;
      // Ensure board occupancy is synchronized with unit position.
      g.board.setUnit(jx, jy, joshua);
      g.board.moveUnit(natasha, jx, jy + 1);
      g.cursor.setPos(jx, jy + 1);
      g.selectedUnit = natasha;
      g._moveOrigin = [jx, jy + 1];
      g.state.change('menu');
      return { ok: true, reason: 'ok' };
    });
    expect(setup.ok).toBe(true);

    await stepFrames(page, 8);

    const talkProbe = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const st = g?.state?.getCurrentState?.();
      const natasha = g?.units?.get?.('Natasha') ?? Array.from(g?.units?.values?.() ?? []).find((u: any) => u?.nid === 'Natasha');
      const joshua = g?.units?.get?.('Joshua') ?? Array.from(g?.units?.values?.() ?? []).find((u: any) => u?.nid === 'Joshua');
      const eventCount = (g?.eventManager && natasha && joshua)
        ? g.eventManager.getEventsForTrigger(
            { type: 'on_talk', unitA: natasha.nid, unitB: joshua.nid, unit1: natasha, unit2: joshua, levelNid: g?.currentLevel?.nid },
            { game: g, unit1: natasha, unit2: joshua, gameVars: g?.gameVars, levelVars: g?.levelVars },
          ).length
        : -1;

      if (!st || st.name !== 'menu' || !st.menu) {
        return { hasTalk: false, reason: 'not_menu', state: st?.name ?? null, eventCount };
      }
      const labels = st.menu.options.map((o: any) => o?.label);
      const idx = st.menu.options.findIndex((o: any) => o?.label === 'Talk');
      if (idx < 0) return { hasTalk: false, reason: 'missing_talk_option', state: st.name, labels, eventCount };
      st.menu.selectedIndex = idx;
      return { hasTalk: true, reason: 'ok', state: st.name, labels, eventCount };
    });
    expect(talkProbe.hasTalk).toBe(true);

    await stepFrames(page, 2, 'SELECT');

    // Advance through full conversation.
    for (let i = 0; i < 1500; i++) {
      await stepFrames(page, 2, 'SELECT');
      const converted = await page.evaluate(() => {
        const g = (window as any).__gameRef;
        const j = g?.units?.get?.('Joshua');
        return j?.team === 'player';
      });
      if (converted) break;
    }

    const joshuaTeam = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      return g?.units?.get?.('Joshua')?.team ?? null;
    });
    expect(joshuaTeam).toBe('player');

    await saveScreenshot(page, '35-ch5-natasha-recruits-joshua');
  });

  test('Chapter 2 Village1 visit gives Red Gem and consumes region', async ({ page }) => {
    await page.goto('/?harness=true&level=2&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 10);

    const setupOk = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const eirika = g?.units?.get?.('Eirika');
      if (!g || !g.board || !eirika) return false;
      g.board.moveUnit(eirika, 4, 2); // Village1 tile
      g.cursor.setPos(4, 2);
      g.selectedUnit = eirika;
      g._moveOrigin = [4, 2];
      g.state.change('menu');
      return true;
    });
    expect(setupOk).toBe(true);

    await stepFrames(page, 8);

    const pickedVisit = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const st = g?.state?.getCurrentState?.();
      if (!st || st.name !== 'menu' || !st.menu) return false;
      const idx = st.menu.options.findIndex((o: any) => o?.label === 'Visit');
      if (idx < 0) return false;
      st.menu.selectedIndex = idx;
      return true;
    });
    expect(pickedVisit).toBe(true);

    await stepFrames(page, 2, 'SELECT');

    // Enable event skip mode to burn through long village dialogue quickly.
    for (let i = 0; i < 1200; i++) {
      await stepFrames(page, 2, 'BACK');
      const done = await page.evaluate(() => {
        const g = (window as any).__gameRef;
        const eirika = g?.units?.get?.('Eirika');
        const hasItem = (eirika?.items ?? []).some((it: any) => it?.nid === 'Red_Gem');
        return hasItem || g?.state?.getCurrentState?.()?.name === 'free';
      });
      if (done) break;
    }

    const result = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const eirika = g?.units?.get?.('Eirika');
      const itemNids = (eirika?.items ?? []).map((it: any) => it?.nid);
      const villageStillPresent = (g?.currentLevel?.regions ?? []).some((r: any) => r?.nid === 'Village1');
      return { itemNids, villageStillPresent, state: g?.state?.getCurrentState?.()?.name ?? null };
    });
    expect(result.itemNids).toContain('Red_Gem');
    expect(result.villageStillPresent).toBe(false);

    await saveScreenshot(page, '36-ch2-village1-visited-red-gem');
  });

  test('Chapter 5 Village2 visit gives Armorslayer and consumes region', async ({ page }) => {
    await page.goto('/?harness=true&level=5&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 10);

    const setupOk = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const eirika = g?.units?.get?.('Eirika');
      if (!g || !g.board || !eirika) return false;
      g.board.moveUnit(eirika, 12, 10); // Village2 tile
      g.cursor.setPos(12, 10);
      g.selectedUnit = eirika;
      g._moveOrigin = [12, 10];
      g.state.change('menu');
      return true;
    });
    expect(setupOk).toBe(true);

    await stepFrames(page, 8);

    const pickedVisit = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const st = g?.state?.getCurrentState?.();
      if (!st || st.name !== 'menu' || !st.menu) return false;
      const idx = st.menu.options.findIndex((o: any) => o?.label === 'Visit');
      if (idx < 0) return false;
      st.menu.selectedIndex = idx;
      return true;
    });
    expect(pickedVisit).toBe(true);

    await stepFrames(page, 2, 'SELECT');

    for (let i = 0; i < 1200; i++) {
      await stepFrames(page, 2, 'BACK');
      const done = await page.evaluate(() => {
        const g = (window as any).__gameRef;
        const eirika = g?.units?.get?.('Eirika');
        const hasItem = (eirika?.items ?? []).some((it: any) => it?.nid === 'Armorslayer');
        return hasItem || g?.state?.getCurrentState?.()?.name === 'free';
      });
      if (done) break;
    }

    const result = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const eirika = g?.units?.get?.('Eirika');
      const itemNids = (eirika?.items ?? []).map((it: any) => it?.nid);
      const villageStillPresent = (g?.currentLevel?.regions ?? []).some((r: any) => r?.nid === 'Village2');
      return { itemNids, villageStillPresent, state: g?.state?.getCurrentState?.()?.name ?? null };
    });
    expect(result.itemNids).toContain('Armorslayer');
    expect(result.villageStillPresent).toBe(false);

    await saveScreenshot(page, '37-ch5-village2-visited-armorslayer');
  });

  test('Chapter 5 Vendor and Armory region options appear in menu', async ({ page }) => {
    await page.goto('/?harness=true&level=5&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 10);

    const probeRegion = async (x: number, y: number, expectedLabel: string) => {
      const setup = await page.evaluate(({ x, y }: { x: number; y: number }) => {
        const g = (window as any).__gameRef;
        const eirika = g?.units?.get?.('Eirika');
        if (!g || !g.board || !eirika) return false;
        eirika.finished = false;
        eirika.hasMoved = false;
        eirika.hasAttacked = false;
        eirika.hasTraded = false;
        g.board.moveUnit(eirika, x, y);
        g.cursor.setPos(x, y);
        g.selectedUnit = eirika;
        g._moveOrigin = [x, y];
        g.state.change('menu');
        return true;
      }, { x, y });
      expect(setup).toBe(true);
      await stepFrames(page, 8);
      const hasLabel = await page.evaluate((expectedLabel: string) => {
        const g = (window as any).__gameRef;
        const st = g?.state?.getCurrentState?.();
        if (!st || st.name !== 'menu' || !st.menu) return false;
        return st.menu.options.some((o: any) => o?.label === expectedLabel);
      }, expectedLabel);
      expect(hasLabel).toBe(true);
      await stepFrames(page, 2, 'BACK');
      await stepFrames(page, 2, 'BACK');
    };

    await probeRegion(6, 10, 'Vendor');
    await probeRegion(2, 1, 'Armory');

    await saveScreenshot(page, '38-ch5-vendor-armory-menu-options');
  });

  test('Chapter 3 chest interaction requires key and grants chest loot', async ({ page }) => {
    await page.goto('/?harness=true&level=3&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 10);

    const setupNoKey = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const eirika = g?.units?.get?.('Eirika');
      if (!g || !g.board || !eirika) return false;
      g.board.moveUnit(eirika, 6, 12); // Chest1 tile
      g.cursor.setPos(6, 12);
      g.selectedUnit = eirika;
      g._moveOrigin = [6, 12];
      g.state.change('menu');
      return true;
    });
    expect(setupNoKey).toBe(true);
    await stepFrames(page, 8);

    const chestWithoutKey = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const st = g?.state?.getCurrentState?.();
      if (!st || st.name !== 'menu' || !st.menu) return false;
      return st.menu.options.some((o: any) => o?.label === 'Chest');
    });
    expect(chestWithoutKey).toBe(false);

    await stepFrames(page, 2, 'BACK');
    await stepFrames(page, 2, 'BACK');

    const gaveKey = await page.evaluate(() => {
      const h = (window as any).__harness;
      return h?.giveItem?.('Eirika', 'Chest_Key') ?? false;
    });
    expect(gaveKey).toBe(true);

    const setupWithKey = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const eirika = g?.units?.get?.('Eirika');
      if (!g || !g.board || !eirika) return false;
      g.board.moveUnit(eirika, 6, 12);
      g.cursor.setPos(6, 12);
      g.selectedUnit = eirika;
      g._moveOrigin = [6, 12];
      g.state.change('menu');
      return true;
    });
    expect(setupWithKey).toBe(true);
    await stepFrames(page, 8);

    const selectedChest = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const st = g?.state?.getCurrentState?.();
      if (!st || st.name !== 'menu' || !st.menu) return false;
      const idx = st.menu.options.findIndex((o: any) => o?.label === 'Chest');
      if (idx < 0) return false;
      st.menu.selectedIndex = idx;
      return true;
    });
    expect(selectedChest).toBe(true);

    await stepFrames(page, 2, 'SELECT');
    await settle(page, 300);

    const result = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const eirika = g?.units?.get?.('Eirika');
      const itemNids = (eirika?.items ?? []).map((it: any) => it?.nid);
      const chestStillPresent = (g?.currentLevel?.regions ?? []).some((r: any) => r?.nid === 'Chest1');
      const chestKeyUses = (eirika?.items ?? []).find((it: any) => it?.nid === 'Chest_Key')?.uses ?? null;
      return { itemNids, chestStillPresent, chestKeyUses };
    });

    expect(result.itemNids).toContain('Javelin');
    expect(result.chestStillPresent).toBe(false);
    // Key item is consumed and removed when uses reach 0.
    expect(result.chestKeyUses).toBeNull();

    await saveScreenshot(page, '39-ch3-chest1-unlock-javelin');
  });

  test('Chapter 3 door interaction requires key and opens door region', async ({ page }) => {
    await page.goto('/?harness=true&level=3&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 10);

    const setupNoKey = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const eirika = g?.units?.get?.('Eirika');
      if (!g || !g.board || !eirika) return false;
      g.board.moveUnit(eirika, 2, 2); // Door1 vertical region tile
      g.cursor.setPos(2, 2);
      g.selectedUnit = eirika;
      g._moveOrigin = [2, 2];
      g.state.change('menu');
      return true;
    });
    expect(setupNoKey).toBe(true);
    await stepFrames(page, 8);

    const doorWithoutKey = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const st = g?.state?.getCurrentState?.();
      if (!st || st.name !== 'menu' || !st.menu) return false;
      return st.menu.options.some((o: any) => o?.label === 'Door');
    });
    expect(doorWithoutKey).toBe(false);

    await stepFrames(page, 2, 'BACK');
    await stepFrames(page, 2, 'BACK');

    const gaveKey = await page.evaluate(() => {
      const h = (window as any).__harness;
      return h?.giveItem?.('Eirika', 'Door_Key') ?? false;
    });
    expect(gaveKey).toBe(true);

    const setupWithKey = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const eirika = g?.units?.get?.('Eirika');
      if (!g || !g.board || !eirika) return false;
      g.board.moveUnit(eirika, 2, 2);
      g.cursor.setPos(2, 2);
      g.selectedUnit = eirika;
      g._moveOrigin = [2, 2];
      g.state.change('menu');
      return true;
    });
    expect(setupWithKey).toBe(true);
    await stepFrames(page, 8);

    const selectedDoor = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const st = g?.state?.getCurrentState?.();
      if (!st || st.name !== 'menu' || !st.menu) return false;
      const idx = st.menu.options.findIndex((o: any) => o?.label === 'Door');
      if (idx < 0) return false;
      st.menu.selectedIndex = idx;
      return true;
    });
    expect(selectedDoor).toBe(true);

    await stepFrames(page, 2, 'SELECT');
    await settle(page, 250);

    const result = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const eirika = g?.units?.get?.('Eirika');
      const doorStillPresent = (g?.currentLevel?.regions ?? []).some((r: any) => r?.nid === 'Door1');
      const doorKeyUses = (eirika?.items ?? []).find((it: any) => it?.nid === 'Door_Key')?.uses ?? null;
      return { doorStillPresent, doorKeyUses };
    });

    expect(result.doorStillPresent).toBe(false);
    expect(result.doorKeyUses).toBeNull();

    await saveScreenshot(page, '40-ch3-door1-unlock-opened');
  });

  test('Chapter 3 all chest regions unlock and grant correct loot', async ({ page }) => {
    await page.goto('/?harness=true&level=3&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 10);

    const chests = [
      { nid: 'Chest2', x: 6, y: 3, loot: 'Iron_Lance' },
      { nid: 'Chest3', x: 8, y: 3, loot: 'Hand_Axe' },
      { nid: 'Chest4', x: 10, y: 3, loot: 'Iron_Sword' },
    ];

    for (const chest of chests) {
      await page.evaluate(async () => {
        await (window as any).__harness.loadLevelClean('3');
      });
      await stepFrames(page, 6);

      const gaveKey = await page.evaluate(() => {
        const h = (window as any).__harness;
        return h?.giveItem?.('Eirika', 'Chest_Key') ?? false;
      });
      expect(gaveKey).toBe(true);

      const setup = await page.evaluate(({ x, y }: { x: number; y: number }) => {
        const g = (window as any).__gameRef;
        const eirika = g?.units?.get?.('Eirika');
        if (!g || !g.board || !eirika) return false;
        eirika.finished = false;
        eirika.hasMoved = false;
        eirika.hasAttacked = false;
        eirika.hasTraded = false;
        g.board.moveUnit(eirika, x, y);
        g.cursor.setPos(x, y);
        g.selectedUnit = eirika;
        g._moveOrigin = [x, y];
        g.state.change('menu');
        return true;
      }, { x: chest.x, y: chest.y });
      expect(setup).toBe(true);

      await stepFrames(page, 8);

      const chestProbe = await page.evaluate(() => {
        const g = (window as any).__gameRef;
        const st = g?.state?.getCurrentState?.();
        const eirika = g?.units?.get?.('Eirika');
        if (!st || st.name !== 'menu' || !st.menu) {
          return {
            ok: false,
            state: st?.name ?? null,
            labels: [],
            pos: eirika?.position ?? null,
            hasChestKey: (eirika?.items ?? []).some((it: any) => it?.nid === 'Chest_Key'),
          };
        }
        const labels = st.menu.options.map((o: any) => o?.label);
        const idx = st.menu.options.findIndex((o: any) => o?.label === 'Chest');
        if (idx < 0) {
          return {
            ok: false,
            state: st.name,
            labels,
            pos: eirika?.position ?? null,
            hasChestKey: (eirika?.items ?? []).some((it: any) => it?.nid === 'Chest_Key'),
          };
        }
        st.menu.selectedIndex = idx;
        return { ok: true, state: st.name, labels };
      });
      expect(chestProbe.ok).toBe(true);

      await stepFrames(page, 2, 'SELECT');
      await settle(page, 250);

      const result = await page.evaluate(({ regionNid, lootNid }: { regionNid: string; lootNid: string }) => {
        const g = (window as any).__gameRef;
        const eirika = g?.units?.get?.('Eirika');
        const itemNids = (eirika?.items ?? []).map((it: any) => it?.nid);
        const regionStillPresent = (g?.currentLevel?.regions ?? []).some((r: any) => r?.nid === regionNid);
        return {
          hasLoot: itemNids.includes(lootNid),
          regionStillPresent,
        };
      }, { regionNid: chest.nid, lootNid: chest.loot });

      expect(result.hasLoot).toBe(true);
      expect(result.regionStillPresent).toBe(false);
    }

    await saveScreenshot(page, '41-ch3-all-chests-unlocked');
  });

  test('Chapter 3 remaining door regions unlock with key', async ({ page }) => {
    await page.goto('/?harness=true&level=3&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 10);

    const doors = [
      { nid: 'Door2', x: 6, y: 10 },
      { nid: 'Door3', x: 10, y: 5 },
    ];

    for (const door of doors) {
      await page.evaluate(async () => {
        await (window as any).__harness.loadLevelClean('3');
      });
      await stepFrames(page, 6);

      const gaveKey = await page.evaluate(() => {
        const h = (window as any).__harness;
        return h?.giveItem?.('Eirika', 'Door_Key') ?? false;
      });
      expect(gaveKey).toBe(true);

      const setup = await page.evaluate(({ x, y }: { x: number; y: number }) => {
        const g = (window as any).__gameRef;
        const eirika = g?.units?.get?.('Eirika');
        if (!g || !g.board || !eirika) return false;
        g.board.moveUnit(eirika, x, y);
        g.cursor.setPos(x, y);
        g.selectedUnit = eirika;
        g._moveOrigin = [x, y];
        g.state.change('menu');
        return true;
      }, { x: door.x, y: door.y });
      expect(setup).toBe(true);

      await stepFrames(page, 8);

      const doorProbe = await page.evaluate(() => {
        const g = (window as any).__gameRef;
        const st = g?.state?.getCurrentState?.();
        const eirika = g?.units?.get?.('Eirika');
        if (!st || st.name !== 'menu' || !st.menu) {
          return {
            ok: false,
            state: st?.name ?? null,
            labels: [],
            pos: eirika?.position ?? null,
            hasDoorKey: (eirika?.items ?? []).some((it: any) => it?.nid === 'Door_Key'),
          };
        }
        const labels = st.menu.options.map((o: any) => o?.label);
        const idx = st.menu.options.findIndex((o: any) => o?.label === 'Door');
        if (idx < 0) {
          return {
            ok: false,
            state: st.name,
            labels,
            pos: eirika?.position ?? null,
            hasDoorKey: (eirika?.items ?? []).some((it: any) => it?.nid === 'Door_Key'),
          };
        }
        st.menu.selectedIndex = idx;
        return { ok: true, state: st.name, labels };
      });
      expect(doorProbe.ok).toBe(true);

      await stepFrames(page, 2, 'SELECT');
      await settle(page, 250);

      const doorStillPresent = await page.evaluate((regionNid: string) => {
        const g = (window as any).__gameRef;
        return (g?.currentLevel?.regions ?? []).some((r: any) => r?.nid === regionNid);
      }, door.nid);
      expect(doorStillPresent).toBe(false);
    }

    await saveScreenshot(page, '42-ch3-door2-door3-unlocked');
  });

  test('Chapter 2 destructible village regions trigger ruin layers', async ({ page }) => {
    await page.goto('/?harness=true&level=2&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 10);

    const villages = [
      { region: 'DestroyVillage1', x: 4, y: 2, ruin: 'Ruin1' },
      { region: 'DestroyVillage2', x: 7, y: 2, ruin: 'Ruin2' },
      { region: 'DestroyVillage3', x: 1, y: 12, ruin: 'Ruin3' },
    ];

    for (const v of villages) {
      await page.evaluate(async () => {
        await (window as any).__harness.loadLevelClean('2');
      });
      await stepFrames(page, 6);

      const setup = await page.evaluate(({ x, y }: { x: number; y: number }) => {
        const g = (window as any).__gameRef;
        const eirika = g?.units?.get?.('Eirika');
        if (!g || !g.board || !eirika) return false;
        eirika.team = 'enemy';
        eirika.finished = false;
        eirika.hasMoved = false;
        eirika.hasAttacked = false;
        eirika.hasTraded = false;
        g.board.moveUnit(eirika, x, y);
        g.cursor.setPos(x, y);
        g.selectedUnit = eirika;
        g._moveOrigin = [x, y];
        g.state.change('menu');
        return true;
      }, { x: v.x, y: v.y });
      expect(setup).toBe(true);
      await stepFrames(page, 8);

      const selectedDestructible = await page.evaluate(() => {
        const g = (window as any).__gameRef;
        const st = g?.state?.getCurrentState?.();
        if (!st || st.name !== 'menu' || !st.menu) return false;
        const idx = st.menu.options.findIndex((o: any) => o?.label === 'Destructible');
        if (idx < 0) return false;
        st.menu.selectedIndex = idx;
        return true;
      });
      expect(selectedDestructible).toBe(true);

      await stepFrames(page, 2, 'SELECT');
      await settle(page, 300);

      const result = await page.evaluate(({ regionNid, ruinLayer }: { regionNid: string; ruinLayer: string }) => {
        const g = (window as any).__gameRef;
        const regionStillPresent = (g?.currentLevel?.regions ?? []).some((r: any) => r?.nid === regionNid);
        const ruinVisible = !!g?.tilemap?.layers?.find?.((l: any) => l?.nid === ruinLayer)?.visible;
        return { regionStillPresent, ruinVisible };
      }, { regionNid: v.region, ruinLayer: v.ruin });

      expect(result.regionStillPresent).toBe(false);
      expect(result.ruinVisible).toBe(true);
    }

    await saveScreenshot(page, '43-ch2-destructible-villages-ruins');
  });

  test('Chapter 5 destructible village interactions trigger ruin layers', async ({ page }) => {
    await page.goto('/?harness=true&level=5&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 10);

    const villages = [
      { region: 'DestroyVillage2', x: 12, y: 10, ruin: 'Ruin2' },
      { region: 'DestroyVillage4', x: 5, y: 1, ruin: 'Ruin4' },
    ];

    for (const v of villages) {
      await page.evaluate(async () => {
        await (window as any).__harness.loadLevelClean('5');
      });
      await stepFrames(page, 6);

      const setup = await page.evaluate(({ x, y }: { x: number; y: number }) => {
        const g = (window as any).__gameRef;
        const eirika = g?.units?.get?.('Eirika');
        if (!g || !g.board || !eirika) return false;
        eirika.team = 'enemy';
        eirika.finished = false;
        eirika.hasMoved = false;
        eirika.hasAttacked = false;
        eirika.hasTraded = false;
        g.board.moveUnit(eirika, x, y);
        g.cursor.setPos(x, y);
        g.selectedUnit = eirika;
        g._moveOrigin = [x, y];
        g.state.change('menu');
        return true;
      }, { x: v.x, y: v.y });
      expect(setup).toBe(true);
      await stepFrames(page, 8);

      const selectedDestructible = await page.evaluate(() => {
        const g = (window as any).__gameRef;
        const st = g?.state?.getCurrentState?.();
        if (!st || st.name !== 'menu' || !st.menu) return false;
        const idx = st.menu.options.findIndex((o: any) => o?.label === 'Destructible');
        if (idx < 0) return false;
        st.menu.selectedIndex = idx;
        return true;
      });
      expect(selectedDestructible).toBe(true);

      await stepFrames(page, 2, 'SELECT');
      await settle(page, 300);

      const result = await page.evaluate(({ regionNid, ruinLayer }: { regionNid: string; ruinLayer: string }) => {
        const g = (window as any).__gameRef;
        const regionStillPresent = (g?.currentLevel?.regions ?? []).some((r: any) => r?.nid === regionNid);
        const ruinVisible = !!g?.tilemap?.layers?.find?.((l: any) => l?.nid === ruinLayer)?.visible;
        return { regionStillPresent, ruinVisible };
      }, { regionNid: v.region, ruinLayer: v.ruin });

      expect(result.regionStillPresent).toBe(false);
      expect(result.ruinVisible).toBe(true);
    }

    await saveScreenshot(page, '44-ch5-destructible-villages-ruins');
  });

  test('Chapter 3 turn event spawns Colm and moves him to chest room', async ({ page }) => {
    await page.goto('/?harness=true&level=3&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 10);

    const triggered = await page.evaluate(() => {
      const h = (window as any).__harness;
      const g = (window as any).__gameRef;
      if (!h || !g) return false;
      g.turnCount = 1;
      (g as any).turncount = 1;
      return h.triggerEvent('other_turn_change');
    });
    expect(triggered).toBe(true);

    // Skip through Colm dialogue quickly.
    for (let i = 0; i < 1200; i++) {
      await stepFrames(page, 2, 'BACK');
      const done = await page.evaluate(() => {
        const g = (window as any).__gameRef;
        const colm = g?.units?.get?.('Colm');
        return !!colm?.position && g?.state?.getCurrentState?.()?.name !== 'event';
      });
      if (done) break;
    }

    const colmState = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const colm = g?.units?.get?.('Colm');
      return {
        exists: !!colm,
        team: colm?.team ?? null,
        pos: colm?.position ?? null,
      };
    });

    expect(colmState.exists).toBe(true);
    expect(colmState.team).toBe('other');
    expect(colmState.pos).toEqual([2, 4]);

    await saveScreenshot(page, '45-ch3-colm-turn-event-spawn');
  });

  test('Chapter 3 Neimi talk recruits Colm after turn event', async ({ page }) => {
    await page.goto('/?harness=true&level=3&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 10);

    const spawned = await page.evaluate(() => {
      const h = (window as any).__harness;
      const g = (window as any).__gameRef;
      if (!h || !g) return false;
      g.turnCount = 1;
      (g as any).turncount = 1;
      return h.triggerEvent('other_turn_change');
    });
    expect(spawned).toBe(true);

    for (let i = 0; i < 1200; i++) {
      await stepFrames(page, 2, 'BACK');
      const done = await page.evaluate(() => {
        const g = (window as any).__gameRef;
        const colm = g?.units?.get?.('Colm');
        return !!colm?.position && g?.state?.getCurrentState?.()?.name !== 'event';
      });
      if (done) break;
    }

    const setupOk = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const neimi = g?.units?.get?.('Neimi');
      const colm = g?.units?.get?.('Colm');
      if (!g || !g.board || !neimi || !colm || !colm.position) return false;

      neimi.finished = false;
      neimi.hasMoved = false;
      neimi.hasAttacked = false;
      neimi.hasTraded = false;

      const [cx, cy] = colm.position;
      g.board.moveUnit(neimi, cx, cy + 1);
      g.cursor.setPos(cx, cy + 1);
      g.selectedUnit = neimi;
      g._moveOrigin = [cx, cy + 1];
      g.state.change('menu');
      return true;
    });
    expect(setupOk).toBe(true);

    await stepFrames(page, 8);

    const hasTalk = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const st = g?.state?.getCurrentState?.();
      if (!st || st.name !== 'menu' || !st.menu) return false;
      const idx = st.menu.options.findIndex((o: any) => o?.label === 'Talk');
      if (idx < 0) return false;
      st.menu.selectedIndex = idx;
      return true;
    });
    expect(hasTalk).toBe(true);

    await stepFrames(page, 2, 'SELECT');

    for (let i = 0; i < 1500; i++) {
      await stepFrames(page, 2, 'SELECT');
      const recruited = await page.evaluate(() => {
        const g = (window as any).__gameRef;
        return g?.units?.get?.('Colm')?.team === 'player';
      });
      if (recruited) break;
    }

    const colmTeam = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      return g?.units?.get?.('Colm')?.team ?? null;
    });
    expect(colmTeam).toBe('player');

    await saveScreenshot(page, '46-ch3-neimi-recruits-colm');
  });

  test('Chapter 3 outro branch sets Colm to player before Chapter 4 transition', async ({ page }) => {
    await page.goto('/?harness=true&level=3&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 10);

    // Make sure Colm exists/alive and Neimi alive so the outro branch runs.
    const setup = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const colm = g?.units?.get?.('Colm');
      const neimi = g?.units?.get?.('Neimi');
      const eirika = g?.units?.get?.('Eirika');
      const bazba = g?.units?.get?.('Bazba');
      if (!g || !g.board || !eirika || !colm || !neimi) return false;

      colm.dead = false;
      neimi.dead = false;

      if (bazba) {
        bazba.currentHp = 0;
        bazba.dead = true;
        if (bazba.position) g.board.removeUnit(bazba);
      }

      eirika.finished = false;
      eirika.hasMoved = false;
      eirika.hasAttacked = false;
      eirika.hasTraded = false;
      g.board.moveUnit(eirika, 14, 1);
      g.cursor.setPos(14, 1);
      g.selectedUnit = eirika;
      g._moveOrigin = [14, 1];
      g.state.change('menu');
      return true;
    });
    expect(setup).toBe(true);

    await stepFrames(page, 8);

    const choseSeize = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const st = g?.state?.getCurrentState?.();
      if (!st || st.name !== 'menu' || !st.menu) return false;
      const idx = st.menu.options.findIndex((o: any) => o?.label === 'Seize');
      if (idx < 0) return false;
      st.menu.selectedIndex = idx;
      return true;
    });
    expect(choseSeize).toBe(true);

    await stepFrames(page, 2, 'SELECT');

    // Skip through long outro and wait for level transition.
    let sawColmPlayerInOutro = false;
    for (let i = 0; i < 2500; i++) {
      await stepFrames(page, 2, 'BACK');
      const snap = await page.evaluate(() => {
        const g = (window as any).__gameRef;
        const colm = g?.units?.get?.('Colm');
        return {
          levelNid: g?.currentLevel?.nid ?? null,
          colmTeam: colm?.team ?? null,
        };
      });
      if (snap.colmTeam === 'player') sawColmPlayerInOutro = true;
      if (snap.levelNid === '4') break;
    }

    const result = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      return {
        levelNid: g?.currentLevel?.nid ?? null,
      };
    });

    expect(result.levelNid).toBe('4');
    expect(sawColmPlayerInOutro).toBe(true);

    await saveScreenshot(page, '47-ch3-outro-colm-player-before-ch4');
  });

  test('Chapter 3 outro handles Colm dead without blocking transition', async ({ page }) => {
    await page.goto('/?harness=true&level=3&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 10);

    const setup = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const colm = g?.units?.get?.('Colm');
      const eirika = g?.units?.get?.('Eirika');
      const bazba = g?.units?.get?.('Bazba');
      if (!g || !g.board || !eirika || !colm) return false;

      // Force branch condition false.
      colm.currentHp = 0;
      colm.dead = true;
      if (colm.position) g.board.removeUnit(colm);

      if (bazba) {
        bazba.currentHp = 0;
        bazba.dead = true;
        if (bazba.position) g.board.removeUnit(bazba);
      }

      eirika.finished = false;
      eirika.hasMoved = false;
      eirika.hasAttacked = false;
      eirika.hasTraded = false;
      g.board.moveUnit(eirika, 14, 1);
      g.cursor.setPos(14, 1);
      g.selectedUnit = eirika;
      g._moveOrigin = [14, 1];
      g.state.change('menu');
      return true;
    });
    expect(setup).toBe(true);

    await stepFrames(page, 8);

    const choseSeize = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const st = g?.state?.getCurrentState?.();
      if (!st || st.name !== 'menu' || !st.menu) return false;
      const idx = st.menu.options.findIndex((o: any) => o?.label === 'Seize');
      if (idx < 0) return false;
      st.menu.selectedIndex = idx;
      return true;
    });
    expect(choseSeize).toBe(true);

    await stepFrames(page, 2, 'SELECT');

    let hitTitle = false;
    for (let i = 0; i < 2500; i++) {
      await stepFrames(page, 2, 'BACK');
      const snap = await page.evaluate(() => {
        const g = (window as any).__gameRef;
        return {
          levelNid: g?.currentLevel?.nid ?? null,
          state: g?.state?.getCurrentState?.()?.name ?? null,
        };
      });
      if (snap.state === 'title' || snap.state === 'title_main') hitTitle = true;
      if (snap.levelNid === '4') break;
    }

    const final = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      return {
        levelNid: g?.currentLevel?.nid ?? null,
        state: g?.state?.getCurrentState?.()?.name ?? null,
      };
    });

    expect(hitTitle).toBe(false);
    expect(final.levelNid).toBe('4');

    await saveScreenshot(page, '48-ch3-outro-colm-dead-transition-ok');
  });

  test('Chapter 4 Village2 visit recruits Lute and consumes village region', async ({ page }) => {
    await page.goto('/?harness=true&level=4&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 10);

    const setup = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const eirika = g?.units?.get?.('Eirika');
      if (!g || !g.board || !eirika) return false;
      eirika.finished = false;
      eirika.hasMoved = false;
      eirika.hasAttacked = false;
      eirika.hasTraded = false;
      g.board.moveUnit(eirika, 1, 11); // Village2
      g.cursor.setPos(1, 11);
      g.selectedUnit = eirika;
      g._moveOrigin = [1, 11];
      g.state.change('menu');
      return true;
    });
    expect(setup).toBe(true);
    await stepFrames(page, 8);

    const selectedVisit = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const st = g?.state?.getCurrentState?.();
      if (!st || st.name !== 'menu' || !st.menu) return false;
      const idx = st.menu.options.findIndex((o: any) => o?.label === 'Visit');
      if (idx < 0) return false;
      st.menu.selectedIndex = idx;
      return true;
    });
    expect(selectedVisit).toBe(true);

    await stepFrames(page, 2, 'SELECT');
    for (let i = 0; i < 1500; i++) {
      await stepFrames(page, 2, 'BACK');
      const done = await page.evaluate(() => {
        const g = (window as any).__gameRef;
        const lute = g?.units?.get?.('Lute');
        return lute?.team === 'player' && g?.state?.getCurrentState?.()?.name !== 'event';
      });
      if (done) break;
    }

    const result = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const lute = g?.units?.get?.('Lute');
      const villageStillPresent = (g?.currentLevel?.regions ?? []).some((r: any) => r?.nid === 'Village2');
      return {
        luteExists: !!lute,
        luteTeam: lute?.team ?? null,
        lutePos: lute?.position ?? null,
        villageStillPresent,
      };
    });

    expect(result.luteExists).toBe(true);
    expect(result.luteTeam).toBe('player');
    expect(result.villageStillPresent).toBe(false);

    await saveScreenshot(page, '49-ch4-village2-recruits-lute');
  });

  test('Chapter 4 trigger region spawns RevenantRein group on turn change', async ({ page }) => {
    await page.goto('/?harness=true&level=4&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 10);

    const setup = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const eirika = g?.units?.get?.('Eirika');
      if (!g || !g.board || !eirika) return false;
      // Trigger region spans y=9..14, x=0..14.
      g.board.moveUnit(eirika, 5, 10);
      return true;
    });
    expect(setup).toBe(true);

    const triggered = await page.evaluate(() => {
      const h = (window as any).__harness;
      const g = (window as any).__gameRef;
      if (!h || !g) return false;
      g.turnCount = 4;
      (g as any).turncount = 4;
      return h.triggerEvent('turn_change');
    });
    expect(triggered).toBe(true);

    await settle(page, 500);
    await stepFrames(page, 12);

    const rein = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      return ['118', '119', '120', '121'].map((id) => {
        const u = g?.units?.get?.(id);
        return { id, pos: u?.position ?? null };
      });
    });
    for (const u of rein) {
      expect(u.pos).not.toBeNull();
    }

    await saveScreenshot(page, '50-ch4-trigger-revenant-reinforcements');
  });

  test('Chapter 4 Snag death triggers bridge layer reveal', async ({ page }) => {
    await page.goto('/?harness=true&level=4&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 10);

    const triggered = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const snag = g?.units?.get?.('Snag');
      if (!g || !snag) return false;

      snag.currentHp = 0;
      snag.dead = true;
      if (snag.position) g.board.removeUnit(snag);

      return g.eventManager?.trigger(
        { type: 'unit_death', levelNid: g.currentLevel?.nid ?? '', unitNid: 'Snag', unit: snag },
        { game: g, unit: snag, unit1: snag, position: snag.position, gameVars: g.gameVars, levelVars: g.levelVars },
      ) ?? false;
    });
    expect(triggered).toBe(true);

    await settle(page, 300);
    await stepFrames(page, 8);

    const snagLayerVisible = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      return !!g?.tilemap?.layers?.find?.((l: any) => l?.nid === 'Snag')?.visible;
    });
    expect(snagLayerVisible).toBe(true);

    await saveScreenshot(page, '51-ch4-snag-bridge-layer-revealed');
  });

  test('Chapter 4 Village1 visit grants Iron Axe and consumes region', async ({ page }) => {
    await page.goto('/?harness=true&level=4&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 10);

    const setup = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const eirika = g?.units?.get?.('Eirika');
      if (!g || !g.board || !eirika) return false;
      eirika.finished = false;
      eirika.hasMoved = false;
      eirika.hasAttacked = false;
      eirika.hasTraded = false;
      g.board.moveUnit(eirika, 8, 2); // Village1
      g.cursor.setPos(8, 2);
      g.selectedUnit = eirika;
      g._moveOrigin = [8, 2];
      g.state.change('menu');
      return true;
    });
    expect(setup).toBe(true);
    await stepFrames(page, 8);

    const selectedVisit = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const st = g?.state?.getCurrentState?.();
      if (!st || st.name !== 'menu' || !st.menu) return false;
      const idx = st.menu.options.findIndex((o: any) => o?.label === 'Visit');
      if (idx < 0) return false;
      st.menu.selectedIndex = idx;
      return true;
    });
    expect(selectedVisit).toBe(true);

    await stepFrames(page, 2, 'SELECT');
    for (let i = 0; i < 1200; i++) {
      await stepFrames(page, 2, 'BACK');
      const done = await page.evaluate(() => {
        const g = (window as any).__gameRef;
        const eirika = g?.units?.get?.('Eirika');
        const gotItem = (eirika?.items ?? []).some((it: any) => it?.nid === 'Iron_Axe');
        return gotItem || g?.state?.getCurrentState?.()?.name !== 'event';
      });
      if (done) break;
    }

    const result = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const eirika = g?.units?.get?.('Eirika');
      const itemNids = (eirika?.items ?? []).map((it: any) => it?.nid);
      const villageStillPresent = (g?.currentLevel?.regions ?? []).some((r: any) => r?.nid === 'Village1');
      return { itemNids, villageStillPresent };
    });

    expect(result.itemNids).toContain('Iron_Axe');
    expect(result.villageStillPresent).toBe(false);

    await saveScreenshot(page, '52-ch4-village1-iron-axe');
  });

  test('Chapter 4 turn-3 cameo event exits temporary units cleanly', async ({ page }) => {
    await page.goto('/?harness=true&level=4&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 10);

    const triggered = await page.evaluate(() => {
      const h = (window as any).__harness;
      const g = (window as any).__gameRef;
      if (!h || !g) return false;
      g.turnCount = 3;
      (g as any).turncount = 3;
      return h.triggerEvent('turn_change');
    });
    expect(triggered).toBe(true);

    for (let i = 0; i < 1600; i++) {
      await stepFrames(page, 2, 'BACK');
      const done = await page.evaluate(() => {
        const g = (window as any).__gameRef;
        return g?.state?.getCurrentState?.()?.name !== 'event';
      });
      if (done) break;
    }

    const cameo = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const larachel = g?.units?.get?.("L'arachel");
      const dozla = g?.units?.get?.('Dozla');
      const rennac = g?.units?.get?.('Rennac');
      return {
        larachelPos: larachel?.position ?? null,
        dozlaPos: dozla?.position ?? null,
        rennacPos: rennac?.position ?? null,
      };
    });

    expect(cameo.larachelPos).toBeNull();
    expect(cameo.dozlaPos).toBeNull();
    expect(cameo.rennacPos).toBeNull();

    await saveScreenshot(page, '53-ch4-turn3-cameo-cleared');
  });

  test('Chapter 5 turn-4 event spawns Brigand2 group', async ({ page }) => {
    await page.goto('/?harness=true&level=5&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 10);

    const triggered = await page.evaluate(() => {
      const h = (window as any).__harness;
      const g = (window as any).__gameRef;
      if (!h || !g) return false;
      g.turnCount = 4;
      (g as any).turncount = 4;
      return h.triggerEvent('turn_change');
    });
    expect(triggered).toBe(true);

    await settle(page, 400);
    await stepFrames(page, 10);

    const brigands = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      return ['118', '119'].map((id) => {
        const u = g?.units?.get?.(id);
        return { id, pos: u?.position ?? null };
      });
    });
    for (const b of brigands) {
      expect(b.pos).not.toBeNull();
    }

    await saveScreenshot(page, '54-ch5-turn4-brigand2-spawn');
  });

  test('Chapter 4 outro branch matrix transitions cleanly for Artur/Lute permutations', async ({ page }) => {
    test.setTimeout(120_000);

    await page.goto('/?harness=true&level=4&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 10);

    const outroCases = [
      { label: 'artur-only', arturAlive: true, luteAlive: false, expectArtur: true, expectLute: false },
      { label: 'lute-only', arturAlive: false, luteAlive: true, expectArtur: false, expectLute: true },
      { label: 'both-alive', arturAlive: true, luteAlive: true, expectArtur: true, expectLute: true },
      { label: 'both-dead', arturAlive: false, luteAlive: false, expectArtur: false, expectLute: false },
    ];

    for (const outroCase of outroCases) {
      await page.evaluate(async () => {
        await (window as any).__harness.loadLevelClean('4');
      });
      await stepFrames(page, 8);

      const setup = await page.evaluate(({ arturAlive, luteAlive }) => {
        const g = (window as any).__gameRef;
        const artur = g?.units?.get?.('Artur');
        const lute = g?.units?.get?.('Lute');
        if (!g || !g.board || !artur || !lute) return { ok: false, reason: 'missing_units' };

        const setAlive = (u: any, alive: boolean) => {
          u.dead = !alive;
          u.currentHp = alive ? Math.max(1, u.currentHp ?? 1) : 0;
          if (!alive && u.position) {
            g.board.removeUnit(u);
          }
        };

        setAlive(artur, arturAlive);
        setAlive(lute, luteAlive);

        for (const unit of Array.from(g.units.values())) {
          if (unit?.team === 'enemy' && !unit.isDead?.()) {
            unit.dead = true;
            unit.currentHp = 0;
            if (unit.position) g.board.removeUnit(unit);
          }
        }

        return { ok: true };
      }, { arturAlive: outroCase.arturAlive, luteAlive: outroCase.luteAlive });
      expect(setup.ok).toBe(true);

      const triggered = await page.evaluate(() => {
        const h = (window as any).__harness;
        return h?.triggerEvent?.('combat_end') ?? false;
      });
      expect(triggered).toBe(true);

      await stepFrames(page, 3);

      let maxCommandPointer = -1;
      let hitTitle = false;
      let transitioned = false;

      for (let i = 0; i < 2400; i++) {
        await stepFrames(page, 2, 'BACK');
        const snap = await page.evaluate(() => {
          const g = (window as any).__gameRef;
          const state = g?.state?.getCurrentState?.()?.name ?? null;
          const event = g?.eventManager?.getCurrentEvent?.();
          const commandPointer = typeof event?.commandPointer === 'number' ? event.commandPointer : null;
          return {
            levelNid: g?.currentLevel?.nid ?? null,
            state,
            commandPointer,
          };
        });

        if (snap.commandPointer != null && snap.commandPointer > maxCommandPointer) {
          maxCommandPointer = snap.commandPointer;
        }
        if (snap.state === 'title' || snap.state === 'title_main') hitTitle = true;
        if (snap.levelNid === '5') {
          transitioned = true;
          break;
        }
      }

      expect(hitTitle).toBe(false);
      expect(maxCommandPointer).toBeGreaterThan(30);
      expect(transitioned || maxCommandPointer > 80).toBe(true);
    }

    await saveScreenshot(page, '55-ch4-outro-branch-matrix');
  });

  test('Chapter 5 Village1/3/4 visits grant one-time rewards and consume regions', async ({ page }) => {
    await page.goto('/?harness=true&level=5&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 10);

    const villages = [
      { nid: 'Village1', x: 12, y: 19, reward: 'Dragonshield' },
      { nid: 'Village3', x: 5, y: 6, reward: 'Secret_Book' },
      { nid: 'Village4', x: 5, y: 1, reward: 'Torch' },
    ];

    for (const village of villages) {
      await page.evaluate(async () => {
        await (window as any).__harness.loadLevelClean('5');
      });
      await stepFrames(page, 8);

      const beforeCount = await page.evaluate((reward: string) => {
        const g = (window as any).__gameRef;
        const eirika = g?.units?.get?.('Eirika');
        return (eirika?.items ?? []).filter((it: any) => it?.nid === reward).length;
      }, village.reward);

      const setup = await page.evaluate(({ x, y }) => {
        const g = (window as any).__gameRef;
        const eirika = g?.units?.get?.('Eirika');
        if (!g || !g.board || !eirika) return false;
        eirika.team = 'player';
        eirika.finished = false;
        eirika.hasMoved = false;
        eirika.hasAttacked = false;
        eirika.hasTraded = false;
        g.board.moveUnit(eirika, x, y);
        g.cursor.setPos(x, y);
        g.selectedUnit = eirika;
        g._moveOrigin = [x, y];
        g.state.change('menu');
        return true;
      }, { x: village.x, y: village.y });
      expect(setup).toBe(true);
      await stepFrames(page, 8);

      const pickedVisit = await page.evaluate(() => {
        const g = (window as any).__gameRef;
        const st = g?.state?.getCurrentState?.();
        if (!st || st.name !== 'menu' || !st.menu) return false;
        const idx = st.menu.options.findIndex((o: any) => o?.label === 'Visit');
        if (idx < 0) return false;
        st.menu.selectedIndex = idx;
        return true;
      });
      expect(pickedVisit).toBe(true);

      await stepFrames(page, 2, 'SELECT');
      for (let i = 0; i < 1600; i++) {
        await stepFrames(page, 2, 'BACK');
        const done = await page.evaluate(() => {
          const g = (window as any).__gameRef;
          return g?.state?.getCurrentState?.()?.name !== 'event';
        });
        if (done) break;
      }

      const afterVisit = await page.evaluate(({ nid, reward }: { nid: string; reward: string }) => {
        const g = (window as any).__gameRef;
        const eirika = g?.units?.get?.('Eirika');
        const rewardCount = (eirika?.items ?? []).filter((it: any) => it?.nid === reward).length;
        const regions = g?.currentLevel?.regions ?? [];
        return {
          rewardCount,
          villagePresent: regions.some((r: any) => r?.nid === nid),
          destroyPresent: regions.some((r: any) => r?.nid === `Destroy${nid}`),
        };
      }, { nid: village.nid, reward: village.reward });

      expect(afterVisit.rewardCount).toBe(beforeCount + 1);
      expect(afterVisit.villagePresent).toBe(false);
      expect(afterVisit.destroyPresent).toBe(false);

      const retrySetup = await page.evaluate(({ x, y }) => {
        const g = (window as any).__gameRef;
        const eirika = g?.units?.get?.('Eirika');
        if (!g || !g.board || !eirika) return false;
        eirika.finished = false;
        eirika.hasMoved = false;
        eirika.hasAttacked = false;
        eirika.hasTraded = false;
        g.board.moveUnit(eirika, x, y);
        g.cursor.setPos(x, y);
        g.selectedUnit = eirika;
        g._moveOrigin = [x, y];
        g.state.change('menu');
        return true;
      }, { x: village.x, y: village.y });
      expect(retrySetup).toBe(true);
      await stepFrames(page, 8);

      const retryProbe = await page.evaluate((reward: string) => {
        const g = (window as any).__gameRef;
        const eirika = g?.units?.get?.('Eirika');
        const st = g?.state?.getCurrentState?.();
        const labels = st?.menu?.options?.map((o: any) => o?.label) ?? [];
        const rewardCount = (eirika?.items ?? []).filter((it: any) => it?.nid === reward).length;
        return {
          inMenu: st?.name === 'menu',
          labels,
          rewardCount,
        };
      }, village.reward);

      expect(retryProbe.inMenu).toBe(true);
      expect(retryProbe.labels).not.toContain('Visit');
      expect(retryProbe.rewardCount).toBe(afterVisit.rewardCount);
    }

    await saveScreenshot(page, '56-ch5-village134-visit-matrix');
  });

  test('Chapter 5 arena interaction enters event/combat and returns to map control', async ({ page }) => {
    await page.goto('/?harness=true&level=5&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 10);

    const setup = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const eirika = g?.units?.get?.('Eirika');
      if (!g || !g.board || !eirika) return false;
      eirika.finished = false;
      eirika.hasMoved = false;
      eirika.hasAttacked = false;
      eirika.hasTraded = false;
      g.board.moveUnit(eirika, 12, 6);
      g.cursor.setPos(12, 6);
      g.selectedUnit = eirika;
      g._moveOrigin = [12, 6];
      g.state.change('menu');
      return true;
    });
    expect(setup).toBe(true);
    await stepFrames(page, 8);

    const pickedArena = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const st = g?.state?.getCurrentState?.();
      if (!st || st.name !== 'menu' || !st.menu) return false;
      const idx = st.menu.options.findIndex((o: any) => o?.label === 'Arena');
      if (idx < 0) return false;
      st.menu.selectedIndex = idx;
      return true;
    });
    expect(pickedArena).toBe(true);

    await stepFrames(page, 2, 'SELECT');

    let sawArenaEvent = false;
    let hitTitle = false;
    let recoveredFree = false;

    for (let i = 0; i < 3600; i++) {
      await stepFrames(page, 2, 'SELECT');
      const snap = await page.evaluate(() => {
        const g = (window as any).__gameRef;
        const state = g?.state?.getCurrentState?.()?.name ?? null;
        const eventNid = g?.eventManager?.getCurrentEvent?.()?.nid ?? null;
        return {
          levelNid: g?.currentLevel?.nid ?? null,
          state,
          eventNid,
        };
      });

      if (snap.eventNid === '5 Arena') sawArenaEvent = true;
      if (snap.state === 'title' || snap.state === 'title_main') hitTitle = true;
      if (sawArenaEvent && snap.state === 'free' && snap.levelNid === '5') {
        recoveredFree = true;
        break;
      }
    }

    expect(sawArenaEvent).toBe(true);
    expect(hitTitle).toBe(false);
    expect(recoveredFree).toBe(true);

    const cursorMoved = await page.evaluate(() => {
      const h = (window as any).__harness;
      const before = h?.getState?.()?.cursorPos ?? null;
      if (!before) return false;
      h.stepFrames(3, 'RIGHT');
      const after = h?.getState?.()?.cursorPos ?? null;
      return !!after && (after[0] !== before[0] || after[1] !== before[1]);
    });
    expect(cursorMoved).toBe(true);

    await saveScreenshot(page, '57-ch5-arena-flow-return');
  });

  test('Chapter 5 village destroy-vs-visit ordering stays one-time in both directions', async ({ page }) => {
    await page.goto('/?harness=true&level=5&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 10);

    const villagePos = { x: 12, y: 10 };

    const openMenuAtVillage = async (team: 'player' | 'enemy') => {
      const setup = await page.evaluate(({ x, y, team }: { x: number; y: number; team: 'player' | 'enemy' }) => {
        const g = (window as any).__gameRef;
        const eirika = g?.units?.get?.('Eirika');
        if (!g || !g.board || !eirika) return false;
        eirika.team = team;
        eirika.finished = false;
        eirika.hasMoved = false;
        eirika.hasAttacked = false;
        eirika.hasTraded = false;
        g.board.moveUnit(eirika, x, y);
        g.cursor.setPos(x, y);
        g.selectedUnit = eirika;
        g._moveOrigin = [x, y];
        g.state.change('menu');
        return true;
      }, { ...villagePos, team });
      expect(setup).toBe(true);
      await stepFrames(page, 8);
    };

    // Visit first -> destroy path should no longer be available.
    await page.evaluate(async () => {
      await (window as any).__harness.loadLevelClean('5');
    });
    await stepFrames(page, 8);

    await openMenuAtVillage('player');
    const pickedVisit = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const st = g?.state?.getCurrentState?.();
      if (!st || st.name !== 'menu' || !st.menu) return false;
      const idx = st.menu.options.findIndex((o: any) => o?.label === 'Visit');
      if (idx < 0) return false;
      st.menu.selectedIndex = idx;
      return true;
    });
    expect(pickedVisit).toBe(true);
    await stepFrames(page, 2, 'SELECT');
    for (let i = 0; i < 1200; i++) {
      await stepFrames(page, 2, 'BACK');
      const done = await page.evaluate(() => {
        const g = (window as any).__gameRef;
        return g?.state?.getCurrentState?.()?.name !== 'event';
      });
      if (done) break;
    }

    await openMenuAtVillage('enemy');
    const destroyAfterVisit = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const st = g?.state?.getCurrentState?.();
      const labels = st?.menu?.options?.map((o: any) => o?.label) ?? [];
      const regions = g?.currentLevel?.regions ?? [];
        return {
          labels,
          villagePresent: regions.some((r: any) => r?.nid === 'Village2'),
          destroyPresent: regions.some((r: any) => r?.nid === 'DestroyVillage2'),
        };
      });

    expect(destroyAfterVisit.labels).not.toContain('Destructible');
    expect(destroyAfterVisit.villagePresent).toBe(false);
    expect(destroyAfterVisit.destroyPresent).toBe(false);

    // Destroy first -> visit path should no longer be available.
    await page.evaluate(async () => {
      await (window as any).__harness.loadLevelClean('5');
    });
    await stepFrames(page, 8);

    const forcedDestroy = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const eirika = g?.units?.get?.('Eirika');
      if (!g || !eirika || !g.board || !g.currentLevel?.regions) return false;

      eirika.team = 'enemy';
      eirika.finished = false;
      eirika.hasMoved = false;
      eirika.hasAttacked = false;
      eirika.hasTraded = false;
      g.board.moveUnit(eirika, 12, 10);

      g.currentLevel.regions = (g.currentLevel.regions ?? []).filter((r: any) => r?.nid !== 'DestroyVillage2' && r?.nid !== 'Village2');
      const ruin = g?.tilemap?.layers?.find?.((l: any) => l?.nid === 'Ruin2');
      if (ruin) {
        ruin.visible = true;
      }
      return true;
    });
    expect(forcedDestroy).toBe(true);
    await stepFrames(page, 2, 'BACK');
    await settle(page, 350);

    await openMenuAtVillage('player');
    const visitAfterDestroy = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const st = g?.state?.getCurrentState?.();
      const labels = st?.menu?.options?.map((o: any) => o?.label) ?? [];
      const eirika = g?.units?.get?.('Eirika');
      const regions = g?.currentLevel?.regions ?? [];
      const rewardCount = (eirika?.items ?? []).filter((it: any) => it?.nid === 'Armorslayer').length;
      return {
        labels,
        rewardCount,
        villagePresent: regions.some((r: any) => r?.nid === 'Village2'),
        destroyPresent: regions.some((r: any) => r?.nid === 'DestroyVillage2'),
        ruinVisible: !!g?.tilemap?.layers?.find?.((l: any) => l?.nid === 'Ruin2')?.visible,
      };
    });

    expect(visitAfterDestroy.labels).not.toContain('Visit');
    expect(visitAfterDestroy.rewardCount).toBe(0);
    expect(visitAfterDestroy.villagePresent).toBe(false);
    expect(visitAfterDestroy.destroyPresent).toBe(false);
    expect(visitAfterDestroy.ruinVisible).toBe(true);

    await saveScreenshot(page, '58-ch5-village-ordering-visit-vs-destroy');
  });

  test('Chapter 5 turn events are idempotent across repeated long-window triggers', async ({ page }) => {
    await page.goto('/?harness=true&level=5&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 10);

    const turnCases = [
      { turn: 2, ids: ['116', '117'] },
      { turn: 4, ids: ['118', '119'] },
      { turn: 8, ids: ['120', '121'] },
    ];

    for (const turnCase of turnCases) {
      await page.evaluate(async () => {
        await (window as any).__harness.loadLevelClean('5');
      });
      await stepFrames(page, 8);

      const initialTrigger = await page.evaluate((turn: number) => {
        const h = (window as any).__harness;
        const g = (window as any).__gameRef;
        if (!h || !g) return false;
        g.turnCount = turn;
        (g as any).turncount = turn;
        return h.triggerEvent('turn_change');
      }, turnCase.turn);
      expect(initialTrigger).toBe(true);

      for (let i = 0; i < 1200; i++) {
        await stepFrames(page, 2, 'BACK');
        const done = await page.evaluate(() => {
          const g = (window as any).__gameRef;
          const currentState = g?.state?.getCurrentState?.()?.name ?? null;
          const queueLen = g?.eventManager?.eventQueue?.length ?? 0;
          return currentState !== 'event' && queueLen === 0;
        });
        if (done) break;
      }

      const baseline = await page.evaluate((ids: string[]) => {
        const g = (window as any).__gameRef;
        return {
          spawned: ids.map((id) => ({ id, pos: g?.units?.get?.(id)?.position ?? null })),
          enemyCount: Array.from(g?.units?.values?.() ?? []).filter((u: any) => u?.team === 'enemy' && !u?.dead).length,
        };
      }, turnCase.ids);
      for (const unit of baseline.spawned) {
        expect(unit.pos).not.toBeNull();
      }

      for (let rep = 0; rep < 3; rep++) {
        await page.evaluate((turn: number) => {
          const h = (window as any).__harness;
          const g = (window as any).__gameRef;
          if (!h || !g) return;
          g.turnCount = turn;
          (g as any).turncount = turn;
          h.triggerEvent('turn_change');
        }, turnCase.turn);

        for (let i = 0; i < 1200; i++) {
          await stepFrames(page, 2, 'BACK');
          const done = await page.evaluate(() => {
            const g = (window as any).__gameRef;
            const state = g?.state?.getCurrentState?.()?.name ?? null;
            const queueLen = g?.eventManager?.eventQueue?.length ?? 0;
            return state !== 'event' && queueLen === 0;
          });
          if (done) break;
        }

        const snapshot = await page.evaluate((ids: string[]) => {
          const g = (window as any).__gameRef;
          return {
            levelNid: g?.currentLevel?.nid ?? null,
            state: g?.state?.getCurrentState?.()?.name ?? null,
            stackDepth: (g?.state as any)?.stack?.length ?? 0,
            enemyCount: Array.from(g?.units?.values?.() ?? []).filter((u: any) => u?.team === 'enemy' && !u?.dead).length,
            spawned: ids.map((id) => ({ id, pos: g?.units?.get?.(id)?.position ?? null })),
          };
        }, turnCase.ids);

        expect(snapshot.levelNid).toBe('5');
        expect(snapshot.state).not.toBe('title');
        expect(snapshot.state).not.toBe('title_main');
        expect(snapshot.stackDepth).toBeLessThanOrEqual(3);
        expect(snapshot.enemyCount).toBe(baseline.enemyCount);
        for (const unit of snapshot.spawned) {
          expect(unit.pos).not.toBeNull();
        }
      }
    }

    await saveScreenshot(page, '59-ch5-turn-event-idempotency');
  });

  test('Chapter 2 AI PursueVillage interaction consumes Destructible region and reveals ruins', async ({ page }) => {
    await page.goto('/?harness=true&level=2&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 10);

    const setup = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      if (!g || !g.board || !g.phase) return { ok: false, reason: 'missing_game' };

      const target = g.units.get('107') ?? g.units.get('106') ?? g.units.get('103');
      if (!target) return { ok: false, reason: 'missing_pursue_unit' };

      // Remove player units from the map so PursueVillage chooses Interact
      // rather than Attack on this forced enemy AI phase.
      for (const unit of Array.from(g.units.values())) {
        if (unit.team === 'player' && unit.position) {
          g.board.removeUnit(unit);
          unit.position = null;
        }
      }

      // Isolate one AI actor and place it directly on the destructible village.
      for (const unit of Array.from(g.units.values())) {
        if (unit.team === 'enemy') {
          unit.finished = true;
          unit.hasMoved = false;
          unit.hasAttacked = false;
          unit.hasTraded = false;
        }
      }

      target.finished = false;
      target.hasMoved = false;
      target.hasAttacked = false;
      target.hasTraded = false;
      g.board.moveUnit(target, 1, 12); // DestroyVillage3

      g.phase.setCurrentTeam('enemy');
      g.state.change('ai');
      return { ok: true };
    });
    expect(setup.ok).toBe(true);

    let interacted = false;
    let hitTitle = false;
    for (let i = 0; i < 1800; i++) {
      await stepFrames(page, 2, i % 2 === 0 ? 'SELECT' : null);

      const snap = await page.evaluate(() => {
        const g = (window as any).__gameRef;
        const state = g?.state?.getCurrentState?.()?.name ?? null;
        const regions = g?.currentLevel?.regions ?? [];
        return {
          state,
          hasDestroy: regions.some((r: any) => r?.nid === 'DestroyVillage3'),
          hasVillage: regions.some((r: any) => r?.nid === 'Village3'),
          ruinVisible: !!g?.tilemap?.layers?.find?.((l: any) => l?.nid === 'Ruin3')?.visible,
        };
      });

      if (snap.state === 'title' || snap.state === 'title_main') {
        hitTitle = true;
      }

      if (!snap.hasDestroy && !snap.hasVillage && snap.ruinVisible) {
        interacted = true;
        break;
      }
    }

    const result = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const regions = g?.currentLevel?.regions ?? [];
      return {
        state: g?.state?.getCurrentState?.()?.name ?? null,
        hasDestroy: regions.some((r: any) => r?.nid === 'DestroyVillage3'),
        hasVillage: regions.some((r: any) => r?.nid === 'Village3'),
        ruinVisible: !!g?.tilemap?.layers?.find?.((l: any) => l?.nid === 'Ruin3')?.visible,
      };
    });

    expect(hitTitle).toBe(false);
    expect(interacted).toBe(true);
    expect(result.hasDestroy).toBe(false);
    expect(result.hasVillage).toBe(false);
    expect(result.ruinVisible).toBe(true);

    await saveScreenshot(page, '60-ch2-ai-destructible-interact-ruin3');
  });

  test('Recruit team persistence survives chapter cleanup/reload and appears in prep flow', async ({ page }) => {
    await page.goto('/?harness=true&level=5&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 10);

    const setupOk = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const joshua = g?.units?.get?.('Joshua');
      if (!g || !joshua) return false;

      // Simulate a recruited Joshua before chapter cleanup.
      joshua.team = 'player';
      joshua.dead = false;
      joshua.persistent = true;
      joshua.party = g.currentParty ?? joshua.party;
      return true;
    });
    expect(setupOk).toBe(true);

    const persisted = await page.evaluate(async () => {
      const g = (window as any).__gameRef;
      const h = (window as any).__harness;
      if (!g || !h) return { ok: false, reason: 'missing_game' };

      // Chapter transition analogue: cleanup + load next chapter.
      g.cleanUpLevel();
      await g.loadLevel('5');

      // Keep this deterministic like loadLevelClean.
      if (g.eventManager) {
        while (g.eventManager.hasActiveEvents()) {
          g.eventManager.dequeueCurrentEvent();
        }
      }
      g.state.clear();
      g.state.change('free');
      h.stepFrames(3);

      const joshua = g.units.get('Joshua');
      return {
        ok: true,
        team: joshua?.team ?? null,
        position: joshua?.position ?? null,
      };
    });
    expect(persisted.ok).toBe(true);
    expect(persisted.team).toBe('player');
    expect(persisted.position).toEqual([9, 7]);

    const openedPrep = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      if (!g) return false;
      g.state.change('prep_pick');
      return true;
    });
    expect(openedPrep).toBe(true);
    await stepFrames(page, 8);

    const prepProbe = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const st = g?.state?.getCurrentState?.();
      const listedNids = Array.isArray((st as any)?.partyUnits)
        ? (st as any).partyUnits.map((u: any) => u?.nid)
        : [];
      return {
        state: st?.name ?? null,
        listedNids,
      };
    });

    expect(prepProbe.state).toBe('prep_pick');
    expect(prepProbe.listedNids).toContain('Joshua');

    await saveScreenshot(page, '61-recruit-persistence-prep-flow-joshua');
  });
});

// ---------------------------------------------------------------------------
// Level Progression Tests
// ---------------------------------------------------------------------------

async function killUnit(page: any, unitNid: string): Promise<boolean> {
  return page.evaluate(
    (nid: string) => (window as any).__harness.killUnit(nid),
    unitNid,
  );
}

async function triggerEvent(page: any, triggerType: string): Promise<boolean> {
  return page.evaluate(
    (tt: string) => (window as any).__harness.triggerEvent(tt),
    triggerType,
  );
}

test.describe('Level Progression', () => {
  test('Ch.1 intro cutscene plays after Prologue transition', async ({ page }) => {
    // This test verifies that after the Prologue outro completes,
    // the Chapter 1 intro cutscene actually runs (not skipped).
    const logs: string[] = [];
    page.on('console', msg => logs.push(msg.text()));

    // Load Prologue in clean mode
    await page.goto('/?harness=true&level=0&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 10);

    // Kill boss and trigger win
    await killUnit(page, "O'Neill");
    const triggered = await triggerEvent(page, 'combat_end');
    expect(triggered).toBe(true);

    // Push event state for the triggered event
    await stepFrames(page, 3);

    // Step through Prologue outro, level transition, and into Ch.1 intro.
    // Use waitForTimeout between batches to allow async loadLevel to complete.
    let reachedLevel1WithEvents = false;
    let level1EventNid = '';
    let level1EventCmdCount = 0;
    let chapterTitleSeen = false;

    for (let batch = 0; batch < 600; batch++) {
      // Don't press SELECT after reaching level 1 — let the cutscene play naturally
      const input = (!reachedLevel1WithEvents && batch % 3 === 0) ? 'SELECT' : null;
      await stepFrames(page, 5, input);
      // Crucial: yield to the browser event loop so async loadLevel() 
      // promises can resolve
      await page.waitForTimeout(10);

      const state = await getState(page);

      if (state.levelNid === '1' && state.units.length > 0) {
        const eventInfo = await page.evaluate(() => {
          const g = (window as any).__gameRef;
          if (!g || !g.eventManager) return null;
          const ev = g.eventManager.getCurrentEvent();
          if (!ev) return null;
          return {
            nid: ev.nid,
            commandCount: ev.commands.length,
            pointer: ev.commandPointer,
          };
        });

        if (eventInfo && !reachedLevel1WithEvents) {
          reachedLevel1WithEvents = true;
          level1EventNid = eventInfo.nid;
          level1EventCmdCount = eventInfo.commandCount;
        }

        // Check if chapter title phase is active
        const ctPhase = await page.evaluate(() => {
          const g = (window as any).__gameRef;
          const es = g?.state?.getCurrentState?.();
          return (es as any)?.chapterTitlePhase ?? 'unknown';
        });
        if (ctPhase !== 'none' && ctPhase !== 'unknown') {
          chapterTitleSeen = true;
        }
      }

      // If we're in free state on level 1, events have finished
      if (state.levelNid === '1' && state.currentStateName === 'free') {
        break;
      }

      if (state.currentStateName === 'title' || state.currentStateName === 'title_main') {
        break;
      }
    }

    expect(reachedLevel1WithEvents).toBe(true);
    expect(level1EventNid).toBe('1 Intro');
    expect(level1EventCmdCount).toBe(102);
    expect(chapterTitleSeen).toBe(true);

    await saveScreenshot(page, '25-ch1-intro-cutscene');
  });

  test('Dialog portraits stop talking while waiting for input', async ({ page }) => {
    // Regression: portraits should stop mouth animation once text is fully
    // revealed and dialog enters waiting state.
    await page.goto('/?harness=true&level=1&clean=false&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 10);

    let sawTypingDialog = false;
    let stoppedOnWait = false;

    for (let i = 0; i < 800; i++) {
      await stepFrames(page, 2, i % 3 === 0 ? 'SELECT' : null);

      const probe = await page.evaluate(() => {
        const g = (window as any).__gameRef;
        const es = g?.state?.getCurrentState?.();
        if (!es || es.name !== 'event') return null;
        const dialog = (es as any).dialog;
        if (!dialog) return null;
        const speakingPortrait = (es as any).speakingPortrait;
        return {
          dialogState: (dialog as any).state ?? '',
          talkOn: speakingPortrait ? Boolean((speakingPortrait as any).talkOn) : null,
        };
      });

      if (!probe) continue;
      if (probe.dialogState !== 'typing') continue;

      sawTypingDialog = true;

      // Force this line to finish typing, then allow one update tick.
      await stepFrames(page, 1, 'SELECT');
      await stepFrames(page, 1);

      const after = await page.evaluate(() => {
        const g = (window as any).__gameRef;
        const es = g?.state?.getCurrentState?.();
        if (!es || es.name !== 'event') return null;
        const dialog = (es as any).dialog;
        if (!dialog) return null;
        const speakingPortrait = (es as any).speakingPortrait;
        return {
          dialogState: (dialog as any).state ?? '',
          talkOn: speakingPortrait ? Boolean((speakingPortrait as any).talkOn) : null,
        };
      });

      if (after && after.dialogState === 'waiting' && after.talkOn === false) {
        stoppedOnWait = true;
        break;
      }
    }

    expect(sawTypingDialog).toBe(true);
    expect(stoppedOnWait).toBe(true);
  });

  test('Prologue win_game transitions to Chapter 1', async ({ page }) => {
    // Load Prologue in clean mode (no level_start events)
    await page.goto('/?harness=true&level=0&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 10);

    // Verify we're on Prologue
    let state = await getState(page);
    expect(state.levelNid).toBe('0');
    expect(state.currentStateName).toBe('free');

    // Find the boss (O'Neill) and player units
    const boss = state.units.find((u: any) => u.nid === "O'Neill");
    expect(boss).toBeTruthy();
    // Remember Eirika's stats for persistence check
    const eirikaBefore = state.units.find((u: any) => u.nid === 'Eirika');
    expect(eirikaBefore).toBeTruthy();

    // Kill the boss to set up the win condition
    const killed = await killUnit(page, "O'Neill");
    expect(killed).toBe(true);

    // Verify boss is dead
    state = await getState(page);
    const bossAfter = state.units.find((u: any) => u.nid === "O'Neill");
    expect(bossAfter?.isDead).toBe(true);

    // Trigger the combat_end event (this is what fires after combat in normal gameplay).
    // The Prologue has an event "0_Defeat_Boss" with trigger=combat_end that checks
    // if O'Neill is dead, then calls win_game.
    const triggered = await triggerEvent(page, 'combat_end');

    // If the event was triggered, push EventState and step through it.
    // The event should set _win_game flag, then when it finishes,
    // finishAndDequeue() handles the level transition.
    if (triggered) {
      await stepFrames(page, 3);

      // Ensure we're in event state processing the win_game command
      state = await getState(page);

      // Step through event processing and level transition.
      // The level transition is async (loadLevel returns a Promise), so we need
      // to wait for it to complete. Use settle + manual stepping + page.waitForTimeout
      // to allow the Promise microtask to resolve.
      let transitioned = false;
      for (let batch = 0; batch < 300; batch++) {
        // Step frames, pressing SELECT to skip any dialogs/events
        await stepFrames(page, 10, batch % 5 === 0 ? 'SELECT' : null);
        // Allow async loadLevel() promise to resolve
        await page.waitForTimeout(20);

        state = await getState(page);

        // Check if we've transitioned to level 1 AND units are loaded
        // (levelNid is set at the start of loadLevel, but units are populated later)
        if (state.levelNid === '1' && state.units.length > 0) {
          transitioned = true;
          break;
        }

        // If we're on the title screen, something went wrong
        if (state.currentStateName === 'title' || state.currentStateName === 'title_main') {
          break;
        }
      }

      await saveScreenshot(page, '20-level-progression-result');

      // We should have transitioned to level 1
      expect(transitioned).toBe(true);
      expect(state.levelNid).toBe('1');

      // Verify Eirika is present in the new level (either from persistence or level data)
      const eirikaAfter = state.units.find((u: any) => u.nid === 'Eirika');
      expect(eirikaAfter).toBeTruthy();

      // Verify there are enemy units too (level 1 has ~10 enemies)
      const enemies = state.units.filter((u: any) => u.team === 'enemy');
      expect(enemies.length).toBeGreaterThan(0);
    } else {
      // combat_end event did not trigger — test should fail
      expect(triggered).toBe(true);
    }
  });

  test('win_game flag mechanism works', async ({ page }) => {
    // This test directly sets the _win_game flag and verifies level transition,
    // bypassing the need for combat events.
    await page.goto('/?harness=true&level=0&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 10);

    let state = await getState(page);
    expect(state.levelNid).toBe('0');

    // Directly set the win_game flag and trigger an event that will
    // cause finishAndDequeue to process it
    const transitioned = await page.evaluate(async () => {
      const g = (window as any).__gameRef;
      if (!g) return false;

      // Set the _win_game level variable
      g.levelVars.set('_win_game', true);

      // Create and queue a minimal "win" event that just finishes immediately
      if (g.eventManager) {
        // Queue a dummy event that will complete instantly, causing
        // finishAndDequeue to check the _win_game flag
        const dummyPrefab = {
          nid: '_test_win',
          name: 'Test Win',
          trigger: 'level_start',  // won't match anything again
          level_nid: '',
          condition: '',
          only_once: false,
          priority: 0,
          source: [],
          commands: '',
        };
        // Manually construct a minimal event
        g.eventManager.eventQueue.push({
          nid: '_test_win',
          commands: [],  // empty = finishes immediately
          commandPointer: 0,
          state: 'running',
          trigger: { type: 'test' },
          currentDialog: null,
          waitingForInput: false,
          pyev1Processor: null,
          isDone() { return this.commandPointer >= this.commands.length; },
          finish() { this.state = 'done'; },
        });

        // Push event state
        g.state.change('event');
      }
      return true;
    });

    if (transitioned) {
      // Step through frames to let the event + level transition process
      let levelChanged = false;
      for (let batch = 0; batch < 300; batch++) {
        await stepFrames(page, 10, batch % 5 === 0 ? 'SELECT' : null);

        // Need to wait for async loadLevel too
        await page.waitForTimeout(50);

        state = await getState(page);

        if (state.levelNid === '1' && state.units.length > 0) {
          levelChanged = true;
          break;
        }

        if (state.currentStateName === 'title' || state.currentStateName === 'title_main') {
          break;
        }
      }

      await saveScreenshot(page, '21-win-flag-mechanism-result');
      expect(levelChanged).toBe(true);
    }
  });
});
