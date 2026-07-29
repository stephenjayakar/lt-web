import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

interface EotfLevel {
  nid: string;
  name: string;
}

const projectRoot = path.join(process.cwd(), 'lt-maker/eotf.ltproj');
const projectAvailable = fs.existsSync(path.join(projectRoot, 'game_data/levels.json'));
const levels = projectAvailable
  ? JSON.parse(fs.readFileSync(
      path.join(projectRoot, 'game_data/levels.json'),
      'utf8',
    )) as EotfLevel[]
  : [];
const eotfManifest = projectAvailable
  ? JSON.parse(fs.readFileSync(
      path.join(process.cwd(), 'docs/parity/eotf-compat.json'),
      'utf8',
    ))
  : null;
const settledStates = new Set(['free', 'free_roam', 'prep_main', 'base_main']);
const requestedLevelNids = new Set(
  (process.env.EOTF_LEVELS ?? '').split(',').map((nid) => nid.trim()).filter(Boolean),
);

function expectedAssetNoise(text: string): boolean {
  return /404|Failed to load resource|not found \S*\.(png|ogg|mp3|wav|idx)/i.test(text);
}

function compatibilityFailure(text: string): boolean {
  return /EventCondition(?: JS eval failed|: cannot evaluate)|unknown (?:state|command|component)|event UI component is not implemented|failed to load level|Unhandled|PAGEERROR/i.test(text);
}

async function waitForHarness(page: Page): Promise<void> {
  await page.waitForFunction(() => (window as any).__harness?.ready === true, {
    timeout: 60_000,
  });
}

type CanvasHandle = ReturnType<Page['locator']>;

/**
 * Wait until the canvas differs from `before`. The fresh-profile title flow
 * runs without the harness, so first paint is the only available signal that
 * the project finished booting. Note this detects *any* repaint, including
 * title animation, so it marks boot completion rather than state transitions.
 */
async function waitForCanvasChange(
  canvas: CanvasHandle,
  before: Buffer,
  timeout = 120_000,
): Promise<Buffer> {
  const deadline = Date.now() + timeout;
  let current = before;
  while (Date.now() < deadline) {
    current = await canvas.screenshot();
    if (!current.equals(before)) return current;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`canvas did not change within ${timeout}ms`);
}

async function initializeCampaignRecords(page: Page): Promise<void> {
  await page.goto('/?harness=true&project=eotf.ltproj&level=X&clean=true&bundle=false');
  await waitForHarness(page);
  await page.evaluate(async () => {
    const game = (window as any).__gameRef;
    const records = await import('/src/engine/records.ts');
    const { GameEvent } = await import('/src/events/event-manager.ts');
    records.RECORDS.clear();
    const prerequisiteNames = ['Records_Setup', 'x. Create Item Pools'];
    const prefabs = prerequisiteNames.map((name) => {
      const prefab = [...game.db.events.values()]
        .find((event: any) => event.name === name);
      if (!prefab) throw new Error(`Missing EOtF ${name} event`);
      return prefab;
    });
    game.eventManager.eventQueue.push(...prefabs.map((prefab) =>
      new GameEvent(prefab, {
        type: 'on_startup',
        levelNid: 'X',
      }, () => game)));
    game.state.change('event');
  });
  await page.evaluate(
    (states) => (window as any).__harness.settle(2_000, states),
    [...settledStates],
  );
  await page.evaluate(() => {
    const harnessWindow = window as any;
    const game = harnessWindow.__gameRef;
    // Represents authored 0. Setup plus the first playable node after level_end.
    for (const [key, value] of [
      ['Floor', 1],
      ['Game_Level', 1],
      ['accumulated_exp', 0],
      ['accumulated_wexp', 0],
      ['battle_songs', []],
      ['act1_songs', ['No_Sound']],
      ['act2_songs', ['No_Sound']],
      ['act3_songs', ['No_Sound']],
      ['act4_songs', ['No_Sound']],
    ]) {
      game.gameVars.set(key, value);
    }
    harnessWindow.__eotfCampaignBaseline = harnessWindow.__harness.saveSnapshot();
  });
  const initialized = await page.evaluate(async () => {
    const game = (window as any).__gameRef;
    const { RECORDS } = await import('/src/engine/records.ts');
    return {
      availableUnits: RECORDS.get('Available_Units'),
      inheritance: RECORDS.get('skill_inheritance'),
      gameSpeed: RECORDS.get('Game_Speed'),
      ironCount: game.gameVars.get('irons')?.length,
      weaponPoolCount: game.gameVars.get('wep_pool_D')?.length,
    };
  });
  expect(initialized).toEqual({
    availableUnits: ['Player'],
    inheritance: { Nothing: 'None', Patchwork: 'Player' },
    gameSpeed: 1,
    ironCount: 10,
    weaponPoolCount: expect.any(Number),
  });
  expect(initialized.weaponPoolCount).toBeGreaterThan(0);
}

test.describe('Embrace of the Fog project compatibility', () => {
  test.skip(!projectAvailable, 'lt-maker/eotf.ltproj is not installed');

  test('authored startup records initialize campaign prerequisites', async ({ page }) => {
    await initializeCampaignRecords(page);
  });

  test('engine fires on_startup so authored persistent records exist', async ({ page }) => {
    // Deliberately does NOT use initializeCampaignRecords: that helper queues
    // Records_Setup by hand, which masked the engine never firing on_startup
    // at all. EotF creates Progress, its currencies, and its unit lists there,
    // and its hub gates the opening conversation on Progress — so without this
    // the game replays that conversation forever.
    await page.goto('/?harness=true&project=eotf.ltproj&level=X&clean=false&bundle=false');
    await waitForHarness(page);
    await page.evaluate(
      (states) => (window as any).__harness.settle(6_000, states),
      [...settledStates],
    );

    const result = await page.evaluate(async () => {
      const records = await import('/src/engine/records.ts');
      return {
        progress: records.RECORDS.get('Progress'),
        essence: records.RECORDS.get('Essence'),
        gameSpeed: records.RECORDS.get('Game_Speed'),
        availableUnits: records.RECORDS.get('Available_Units'),
        inheritance: records.RECORDS.get('skill_inheritance'),
      };
    });

    expect(result.progress).toBe(0);
    expect(result.essence).toBe(0);
    expect(result.gameSpeed).toBe(1);
    expect(result.availableUnits).toEqual(['Player']);
    expect(result.inheritance).toEqual({ Nothing: 'None', Patchwork: 'Player' });
  });

  test('fresh title new-game flow reaches the authored intro and persists initialization', async ({ page }) => {
    // Cold-boots the unbundled project from a cleared profile, which is the
    // slowest scenario in the suite once the serial worker is saturated.
    test.slow();
    const failures: string[] = [];
    page.on('console', (message) => {
      const text = message.text();
      if (compatibilityFailure(text)) failures.push(text);
    });
    await page.addInitScript(() => localStorage.clear());
    await page.goto('/?project=eotf.ltproj');
    const canvas = page.getByRole('img', { name: 'Game display' })
      .or(page.locator('canvas'));
    await expect(canvas).toBeVisible();
    // The first frames are blank until the unbundled project finishes loading,
    // and that boot dominates the test under full-suite load. Wait for the
    // render loop to paint the title before starting the timed input sequence,
    // so the waits below only have to cover state transitions.
    const blankImage = await canvas.screenshot();
    await waitForCanvasChange(canvas, blankImage);
    await page.waitForTimeout(750);
    const titleImage = await canvas.screenshot();

    // Advance one screen: send the key, wait for the canvas to actually
    // repaint, then dwell so the incoming state finishes drawing. A fixed
    // sleep alone desynchronises under parallel load, because a slow frame
    // lands the next key press before the previous screen exists.
    const advance = async (previous: Buffer): Promise<Buffer> => {
      await page.keyboard.press('Enter');
      await waitForCanvasChange(canvas, previous);
      await page.waitForTimeout(750);
      return canvas.screenshot();
    };

    let screen = titleImage;
    screen = await advance(screen);
    screen = await advance(screen);

    // Drive the remaining confirmations until the intro records itself. This
    // flow has no state handle outside harness mode — `__gameRef` is not
    // exposed — so the only robust signal is the record the intro writes.
    // Every screen from here advances on SELECT, so a repeated press can only
    // move the flow forward; polling absorbs a slow frame under parallel load
    // instead of stranding the test on a press that landed too early.
    const introRecorded = async (): Promise<boolean> => page.evaluate(() => {
      const raw = localStorage.getItem('lt-persistent-records-EotF');
      if (!raw) return false;
      return JSON.parse(raw).some(
        (entry: { nid?: string; value?: unknown }) =>
          entry.nid === 'watched_intro' && entry.value === 1,
      );
    });

    let recorded = false;
    for (let attempt = 0; attempt < 40 && !recorded; attempt += 1) {
      await page.keyboard.press('Enter');
      await page.waitForTimeout(1_000);
      recorded = await introRecorded();
    }
    expect(recorded, 'intro never recorded watched_intro').toBe(true);

    // Each `advance` above already fails if a screen never repaints, which is
    // the real transition signal. Comparing single captured frames between
    // screens was flaky rather than strict: these menus animate, so two
    // captures of *different* screens can legitimately match, and two of the
    // same screen can differ. Screen-by-screen navigation is covered by
    // base-submenus.spec.ts; what this test uniquely proves is that a fresh
    // profile reaches the authored intro and persists its record.
    expect(failures, failures.join('\n')).toEqual([]);
  });

  test('real project save, turnwheel, RNG, rendering, audio, and inputs remain coherent', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(
      '/?harness=true&project=eotf.ltproj&level=X&clean=true&bundle=false&controls=true',
    );
    await waitForHarness(page);
    const canvas = page.locator('#game-canvas');
    await expect(canvas).toBeVisible();
    const rendered = await canvas.screenshot();
    expect(rendered.byteLength).toBeGreaterThan(1_000);

    const persistence = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const harness = (window as any).__harness;
      const { SetGameVarAction } = await import('/src/engine/action.ts');
      const { getCombatRandom, setCombatRandomState } =
        await import('/src/engine/static-random.ts');
      game.gameVars.delete('_eotf_checkpoint');
      game.actionLog.doAction(new SetGameVarAction(
        game.gameVars,
        '_eotf_checkpoint',
        42,
      ));
      const applied = game.gameVars.get('_eotf_checkpoint');
      const undone = harness.turnwheelUndo();
      const afterUndo = game.gameVars.get('_eotf_checkpoint');
      game.actionLog.doAction(new SetGameVarAction(
        game.gameVars,
        '_eotf_checkpoint',
        42,
      ));
      game.gameVars.set('_random_seed', 37);
      setCombatRandomState(game, 37);
      const snapshot = harness.saveSnapshot();
      const expectedNextRoll = getCombatRandom(game);
      game.gameVars.set('_eotf_checkpoint', 99);
      const loaded = await harness.loadSnapshot(snapshot);
      return {
        applied,
        undone,
        afterUndo,
        loaded,
        restored: game.gameVars.get('_eotf_checkpoint'),
        replayedRoll: getCombatRandom(game),
        expectedNextRoll,
      };
    });
    expect(persistence).toEqual({
      applied: 42,
      undone: true,
      afterUndo: undefined,
      loaded: true,
      restored: 42,
      replayedRoll: persistence.expectedNextRoll,
      expectedNextRoll: expect.any(Number),
    });

    const keyboard = await page.evaluate(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', {
        code: 'ArrowRight',
        bubbles: true,
        cancelable: true,
      }));
      const input = (window as any).__gameRef.input;
      const event = input.processInput(16);
      window.dispatchEvent(new KeyboardEvent('keyup', {
        code: 'ArrowRight',
        bubbles: true,
      }));
      input.endFrame();
      return event;
    });
    expect(keyboard).toBe('RIGHT');

    expect(await page.evaluate(() => {
      const canvas = document.querySelector('#game-canvas')!;
      canvas.dispatchEvent(new MouseEvent('mousedown', {
        button: 0,
        clientX: 30,
        clientY: 30,
        bubbles: true,
      }));
      const input = (window as any).__gameRef.input;
      const event = input.mouseClick;
      canvas.dispatchEvent(new MouseEvent('mouseup', {
        button: 0,
        clientX: 30,
        clientY: 30,
        bubbles: true,
      }));
      input.endFrame();
      return event;
    })).toBe('SELECT');

    const touchControls = page.getByLabel('Touch game controls');
    await expect(touchControls).toBeVisible();
    await touchControls.getByRole('button', { name: 'A', exact: true }).click();
    expect(await page.evaluate(() => {
      const input = (window as any).__gameRef.input;
      const event = input.processInput(16);
      input.endFrame();
      return event;
    })).toBe('SELECT');

    expect(await page.evaluate(() => {
      const buttons = Array.from({ length: 16 }, () => ({
        pressed: false,
        value: 0,
      }));
      buttons[15] = { pressed: true, value: 1 };
      Object.defineProperty(navigator, 'getGamepads', {
        configurable: true,
        value: () => [{
          id: 'EOtF Checkpoint Gamepad',
          index: 0,
          connected: true,
          timestamp: 1,
          mapping: 'standard',
          axes: [0, 0, 0, 0],
          buttons,
        }],
      });
      const input = (window as any).__gameRef.input;
      return input.processInput(16);
    })).toBe('RIGHT');

    const mute = page.getByRole('button', { name: 'Mute audio' });
    await mute.click();
    expect(await page.evaluate(() => {
      const audio = (window as any).__gameRef.audioManager;
      return [audio.getMusicVolume(), audio.getSfxVolume()];
    })).toEqual([0, 0]);
    await page.getByRole('button', { name: 'Unmute audio' }).click();
    expect(await page.evaluate(() => {
      const audio = (window as any).__gameRef.audioManager;
      return [audio.getMusicVolume(), audio.getSfxVolume()];
    })).toEqual([0.7, 1]);
  });

  test('authored base checkpoint exposes services, difficulty, lore, and summoning', async ({ page }) => {
    const failures: string[] = [];
    page.on('console', (message) => {
      const text = message.text();
      if (compatibilityFailure(text)) failures.push(text);
    });
    await initializeCampaignRecords(page);
    await page.evaluate(() => (window as any).__harness.loadLevel('X'));
    await page.evaluate(
      (states) => (window as any).__harness.settle(4_000, states),
      [...settledStates],
    );
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { RECORDS } = await import('/src/engine/records.ts');
      const { GameEvent } = await import('/src/events/event-manager.ts');
      const baseState = (window as any).__harness.getState().currentStateName;
      const regionNids = game.currentLevel.regions.map((region: any) => region.nid);
      const player = game.units.get('Player');
      RECORDS.set('E_Strats_level', 0);
      RECORDS.set('current_density', 0);
      const eventSpecs = [
        {
          name: 'c. Difficulty_Menu_Sub',
          trigger: {
            type: 'script',
            levelNid: 'X',
            localArgs: new Map([['modifier', 'E_Strats']]),
          },
        },
        {
          name: 'Ability_Lesser_Summoning',
          trigger: {
            type: 'event_on_hit',
            levelNid: 'X',
            unit1: player,
            position: [4, 9] as [number, number],
          },
        },
      ];
      const events = eventSpecs.map(({ name, trigger }) => {
        const prefab = [...game.db.events.values()]
          .find((event: any) => event.name === name);
        if (!prefab) throw new Error(`Missing authored base event ${name}`);
        return new GameEvent(prefab, trigger, () => game);
      });
      game.eventManager.eventQueue.push(...events);
      game.state.change('event');
      await (window as any).__harness.settle(
        2_000,
        ['free', 'free_roam', 'prep_main', 'base_main'],
      );
      const summoned = [...game.units.values()].find((unit: any) =>
        unit.nid !== 'Player' &&
        unit.fields?.get?.('Summoned_by') === 'Lesser_Summoning');
      return {
        baseState,
        finalState: (window as any).__harness.getState().currentStateName,
        regionNids,
        lore: game.unlockedLore,
        density: RECORDS.get('current_density'),
        modifier: RECORDS.get('E_Strats_level'),
        summon: summoned && {
          klass: summoned.klass,
          summoner: summoned.fields.get('Summoner'),
          temporary: summoned.tags.includes('Temporary'),
          position: summoned.position,
        },
      };
    });
    expect(result.baseState).toBe('free_roam');
    expect(result.finalState).toBe('free_roam');
    expect(result.regionNids).toEqual(expect.arrayContaining([
      'Gacha', 'Skill_Swap', 'Bar', 'Music', 'Records',
    ]));
    expect(result.lore).toEqual(expect.arrayContaining([
      'Typings', 'Interaction', 'WeaponTriangle',
    ]));
    expect(result.modifier).toBe(1);
    expect(result.density).toBeGreaterThanOrEqual(1);
    expect(result.summon).toEqual({
      klass: 'Ghost',
      summoner: 'Player',
      temporary: true,
      position: [4, 9],
    });
    expect(failures, failures.join('\n')).toEqual([]);
  });

  test('authored run systems and short/full act checkpoints settle deterministically', async ({ page }) => {
    const failures: string[] = [];
    page.on('console', (message) => {
      const text = message.text();
      if (compatibilityFailure(text)) failures.push(text);
    });
    await initializeCampaignRecords(page);
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const harness = (window as any).__harness;
      const { RECORDS } = await import('/src/engine/records.ts');
      const { GameEvent } = await import('/src/events/event-manager.ts');
      const run = async (
        name: string,
        levelNid: string | null = null,
        trigger: Record<string, any> = {},
      ) => {
        const prefab = [...game.db.events.values()].find((event: any) =>
          event.name === name && (levelNid === null || event.level_nid === levelNid));
        if (!prefab) throw new Error(`Missing authored run event ${name} (${levelNid})`);
        const event = new GameEvent(prefab, {
          type: 'script',
          levelNid: game.currentLevel?.nid ?? 'X',
          ...trigger,
        }, () => game);
        game.eventManager.eventQueue.push(event);
        game.state.change('event');
        harness.stepFrames(1, null);
        await harness.settle(
          3_000,
          ['free', 'free_roam', 'prep_main', 'base_main'],
        );
        return event;
      };

      const chapters: Record<string, string[]> = { full: [], short: [] };
      for (const [mode, speed, floors] of [
        ['full', 1, [1, 15, 30, 45]],
        ['short', 2, [1, 10, 20, 30]],
      ] as const) {
        RECORDS.set('Game_Speed', speed);
        game.gameVars.set('Alter_Act', 1);
        for (const floor of floors) {
          game.gameVars.set('Floor', floor);
          await run('Get_Next_Chapter');
          chapters[mode].push(game.gameVars.get('_goto_level'));
        }
      }

      RECORDS.set('Camp_EXP_level', 1);
      RECORDS.set('Fatigue_level', 0);
      const player = game.units.get('Player');
      const expBefore = player.exp;
      await run('On_Enter_Camp');

      await run('Generate_Shop_Items', 'Act_1');
      game.gameVars.set('Active_Stratagems', []);
      await run('Global_Give_Stratagem', null, {
        localArgs: new Map([['stratagem', 'Infantry_Rush']]),
      });
      RECORDS.set('Game_Speed', 1);
      game.gameVars.set('Floor', 14);
      await run('Global Get_Trial_Room');
      await run('Support Gain', null, { item: 'C' });

      return {
        chapters,
        campExp: player.exp - expBefore,
        armoryItems: game.levelVars.get('armory_items'),
        vendorItems: game.levelVars.get('vendor_items'),
        stratagems: game.gameVars.get('Active_Stratagems'),
        trialRoom: game.gameVars.get('in_trial_room'),
        state: harness.getState().currentStateName,
      };
    });
    expect(result.chapters).toEqual({
      full: ['Act_1', 'Act_2', 'Act_3', 'Act_4'],
      short: ['Act_1', 'Act_2', 'Act_3', 'Act_4'],
    });
    expect(result.campExp).toBe(13);
    expect(result.armoryItems).toHaveLength(10);
    expect(result.vendorItems).toHaveLength(5);
    expect(result.stratagems).toContain('Infantry_Rush');
    expect(result.trialRoom).toBe(1);
    expect(result.state).toBe('free_roam');
    expect(failures, failures.join('\n')).toEqual([]);
  });

  test('authored victory returns from a battle map to the persistent base', async ({ page }) => {
    const failures: string[] = [];
    page.on('console', (message) => {
      const text = message.text();
      if (compatibilityFailure(text)) failures.push(text);
    });
    await initializeCampaignRecords(page);
    await page.evaluate(() => (window as any).__harness.loadLevelClean('10'));
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const harness = (window as any).__harness;
      const { GameEvent } = await import('/src/events/event-manager.ts');
      game.gameVars.set('_goto_level', 'X');
      const prefab = [...game.db.events.values()].find((event: any) =>
        event.name === 'Win_Condition' && event.level_nid === '10');
      if (!prefab) throw new Error('Missing authored level 10 Win_Condition');
      game.eventManager.eventQueue.push(new GameEvent(prefab, {
        type: 'script',
        levelNid: '10',
      }, () => game));
      game.state.change('event');
      harness.stepFrames(2, null);
      for (let frame = 0; frame < 3_000 && game.currentLevel?.nid !== 'X'; frame += 1) {
        harness.stepFrames(1, frame % 5 === 0 ? 'BACK' : null);
        const { promise, resolve } = Promise.withResolvers<void>();
        setTimeout(resolve, 0);
        await promise;
      }
      await harness.settle(
        4_000,
        ['free', 'free_roam', 'prep_main', 'base_main'],
      );
      return {
        previous: game.gameVars.get('_prev_level_nid'),
        level: game.currentLevel?.nid,
        state: harness.getState().currentStateName,
      };
    });
    expect(result).toMatchObject({
      previous: '10',
      level: 'X',
    });
    expect(result.state).toMatch(/^free(?:_roam)?$/);
    expect(failures, failures.join('\n')).toEqual([]);
  });

  test('authored defeat return persists metaprogression and exits the run', async ({ page }) => {
    const failures: string[] = [];
    page.on('console', (message) => {
      const text = message.text();
      if (compatibilityFailure(text)) failures.push(text);
    });
    await initializeCampaignRecords(page);
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const harness = (window as any).__harness;
      const { RECORDS } = await import('/src/engine/records.ts');
      const { GameEvent } = await import('/src/events/event-manager.ts');
      for (const [nid, value] of [
        ['currency_blocker', 'Unlocked'],
        ['Essence', 10],
        ['Flame', 20],
        ['Fragments', 30],
        ['Master_Seals', 0],
        ['Spark_Shards', 0],
        ['Spark_Stones', 0],
      ]) RECORDS.set(nid, value);
      for (const [nid, value] of [
        ['Floor', 1],
        ['run_essence', 7],
        ['run_flame', 5],
        ['run_fragments', 3],
        ['run_seals', 0],
        ['run_sparks', 0],
        ['ms_tracker', []],
      ]) game.gameVars.set(nid, value);
      const prefab = [...game.db.events.values()]
        .find((event: any) => event.name === 'Global_Loss');
      if (!prefab) throw new Error('Missing authored Global_Loss event');
      game.eventManager.eventQueue.push(new GameEvent(prefab, {
        type: 'script',
        levelNid: 'X',
      }, () => game));
      game.state.change('event');
      harness.stepFrames(1, null);
      await harness.settle(3_000, [
        'title_start', 'title_main', 'game_over', 'free', 'free_roam',
      ]);
      return {
        blocker: RECORDS.get('currency_blocker'),
        essence: RECORDS.get('Essence'),
        flame: RECORDS.get('Flame'),
        fragments: RECORDS.get('Fragments'),
        state: harness.getState().currentStateName,
      };
    });
    expect(result).toMatchObject({
      blocker: 'Locked',
      essence: 17,
      flame: 25,
      fragments: 33,
    });
    expect(result.state).toMatch(/^(title_start|title_main|game_over)$/);
    expect(failures, failures.join('\n')).toEqual([]);
  });

  test('authored high-volume payload flows mutate records, units, components, and nested args', async ({ page }) => {
    const failures: string[] = [];
    page.on('console', (message) => {
      const text = message.text();
      if (compatibilityFailure(text)) failures.push(text);
    });
    await initializeCampaignRecords(page);
    await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { RECORDS } = await import('/src/engine/records.ts');
      const { GameEvent } = await import('/src/events/event-manager.ts');
      RECORDS.set('Shiki_Ouji_Gain_A', 1);
      RECORDS.delete('Shiki_Ouji_Gain_B');
      game.gameVars.set('b_unit_bonuses', 0);
      game.gameVars.set('run_essence', 0);
      const eventNames = ['c. Challenge_Unlocks', 'Item_EssenceRender'];
      const prefabs = eventNames.map((name) => {
        const prefab = [...game.db.events.values()]
          .find((event: any) => event.name === name);
        if (!prefab) throw new Error(`Missing authored payload event ${name}`);
        return prefab;
      });
      game.eventManager.eventQueue.push(...prefabs.map((prefab) =>
        new GameEvent(prefab, {
          type: 'script',
          levelNid: game.currentLevel?.nid ?? 'X',
        }, () => game)));
      game.state.change('event');
    });
    await page.evaluate(
      (states) => (window as any).__harness.settle(2_000, states),
      [...settledStates],
    );
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { RECORDS } = await import('/src/engine/records.ts');
      const unit = game.units.get('Shiki_Ouji');
      const inherited = unit?.skills?.find((skill: any) => skill.nid === 'Nothing');
      return {
        joined: RECORDS.get('Shiki_Ouji_Gain_B'),
        available: RECORDS.get('Available_Units'),
        unitTeam: unit?.team,
        inherited: inherited?.hasComponent?.('inherited') ?? false,
        runEssence: game.gameVars.get('run_essence'),
        state: (window as any).__harness.getState().currentStateName,
      };
    });
    expect(result).toEqual({
      joined: 1,
      available: expect.arrayContaining(['Player', 'Shiki_Ouji']),
      unitTeam: 'player',
      inherited: true,
      runEssence: 5,
      state: expect.stringMatching(/^(free|free_roam|prep_main|base_main)$/),
    });
    expect(failures, failures.join('\n')).toEqual([]);
  });

  test('project picker discovers a linked EotF checkout with a friendly name', async ({ page }) => {
    await page.goto('/');
    await expect(
      page.getByRole('button', { name: 'Launch Embrace of the Fog' }),
    ).toBeVisible();
  });

  test('EotF expression scope exposes game units and item availability', async ({ page }) => {
    const failures: string[] = [];
    page.on('console', (message) => {
      const text = message.text();
      if (text.includes('EventCondition JS eval failed')) failures.push(text);
    });
    await page.goto('/?harness=true&project=eotf.ltproj&level=X&clean=true&bundle=false');
    await waitForHarness(page);

    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { evaluateCondition } = await import('/src/events/event-manager.ts');
      const unit = game.units.get('Player');
      const context = {
        game,
        unit1: unit,
        gameVars: game.gameVars,
        levelVars: game.levelVars,
      };
      return {
        keyblade: evaluateCondition(
          "item_system.available(unit, DB.items.get('Keyblade'))",
          context,
        ),
        pylon: evaluateCondition(
          "any([u.position for u in game.units if u.klass == 'Pylon' and not is_dead(u.nid)])",
          context,
        ),
      };
    });

    expect(result.keyblade).toEqual(expect.any(Boolean));
    expect(result.pylon).toEqual(expect.any(Boolean));
    expect(failures).toEqual([]);
  });

  test('all 4937 conditions, 249 evals, and 646 loops execute in strict mode', async ({ page }) => {
    await initializeCampaignRecords(page);

    const inventory = eotfManifest.expressions as {
      conditions: string[];
      evalSubstitutions: string[];
      loops: string[];
    };
    expect(inventory.conditions).toHaveLength(4_937);
    expect(inventory.evalSubstitutions).toHaveLength(249);
    expect(inventory.loops).toHaveLength(646);

    const result = await page.evaluate(async (expressions) => {
      const { evaluateCondition, evaluateExpression } =
        await import('/src/events/event-manager.ts');
      const { ItemObject } = await import('/src/objects/item.ts');
      const { SkillObject } = await import('/src/objects/skill.ts');
      const { RECORDS } = await import('/src/engine/records.ts');
      const game = (window as any).__gameRef;
      const unit = game.units.get('Player');
      const item = game.db.items.get('Iron_Sword');
      const expressionSkills = [
        'Undying_Flesh',
        'Animus_Graft',
        'Rhythms_Crescendo',
        'Call_to_Execution_Sub',
        'TakePrisoner_Plus',
        'Undying_Will',
        'Cloud_Mark',
        'Patchwork',
      ].map((nid) => {
        const skill = new SkillObject({
          nid,
          name: nid,
          desc: '',
          components: [
            ['stack', 1],
            ['copysafe', ['Patchwork']],
            ['subskills', ['Patchwork']],
          ],
        });
        skill.data.set('charge', 1);
        skill.initiatorNid = unit.nid;
        return skill;
      });
      unit.skills.push(...expressionSkills);
      const savedRecords = RECORDS.save();
      RECORDS.set('skill_inheritance', { Patchwork: 'Player' });
      const failures: string[] = [];
      const warnings: string[] = [];
      const originalWarn = console.warn;
      console.warn = (...args: any[]) => {
        warnings.push(args.map((arg) =>
          arg instanceof Error ? `${arg.name}: ${arg.message}` : String(arg)).join(' '));
      };
      const all = [
        ...expressions.conditions,
        ...expressions.evalSubstitutions,
        ...expressions.loops,
      ].join('\n');
      const originalItemsLength = unit.items.length;
      const originalWeapon = unit.equippedWeapon;
      const originalTraveler = unit.traveler;
      const savedFields = new Map(unit.fields);
      const savedItemRegistry = new Map(game.items);
      const originalPosition = unit.position;
      unit.position = [1, 1];
      const expressionItemNids = [...all.matchAll(
        /\bget_item\([^,]+,\s*['"]([^'"]+)['"]\)/g,
      )].map((match) => match[1]);
      for (const nid of expressionItemNids) {
        if (unit.items.some((candidate: any) => candidate.nid === nid)) continue;
        const prefab = game.db.items.get(nid);
        if (!prefab) continue;
        const runtimeItem = new ItemObject(prefab);
        if (runtimeItem.subitems.length === 0 && nid !== 'Iron_Sword') {
          const childPrefab = game.db.items.get('Iron_Sword');
          if (childPrefab) runtimeItem.subitems.push(new ItemObject(childPrefab));
        }
        unit.items.push(runtimeItem);
      }
      const fixtureWeapon = unit.items.find((candidate: any) =>
        candidate.nid === 'Iron_Sword') ?? new ItemObject(item);
      if (!unit.items.includes(fixtureWeapon)) unit.items.push(fixtureWeapon);
      (fixtureWeapon as any).uid = 1;
      for (const runtimeItem of unit.items) {
        game.items.set(`expression_${runtimeItem.uid}_${runtimeItem.nid}`, runtimeItem);
      }
      unit.equippedWeapon = fixtureWeapon;
      unit.traveler = unit.nid;
      unit.fields.set('Summoner', unit.nid);
      unit.fields.set('Pair_Up_Skills', ['Patchwork']);
      unit.fields.set('Promoted_Weapon', 'Sword');

      const unitAliases = new Set([
        ...[...all.matchAll(/(?:game\.get_unit|u)\(['"]([^'"]+)['"]\)/g)]
          .map((match) => match[1]),
        'Patchwork',
        'Player_X',
      ]);
      const addedAliases: string[] = [];
      for (const nid of unitAliases) {
        if (!game.units.has(nid)) {
          game.units.set(nid, unit);
          addedAliases.push(nid);
        }
      }

      const oldRegions = game.currentLevel.regions;
      const regionAliases = [...all.matchAll(
        /(?:game\.get_region|game\.level\.regions\.get)\(['"]([^'"]+)['"]\)/g,
      )].map((match) => match[1]);
      game.currentLevel.regions = [
        ...oldRegions,
        ...regionAliases
          .filter((nid, index) => regionAliases.indexOf(nid) === index)
          .map((nid) => ({
            nid,
            region_type: 'event',
            sub_nid: nid,
            position: [1, 1],
            size: [1, 1],
            condition: 'True',
          })),
      ];

      const unitVariableNids = new Set([
        ...[...all.matchAll(/\bu\(\s*['"]\{(?:v:)?([A-Za-z_][A-Za-z0-9_]*)\}['"]/g)]
          .map((match) => match[1]),
        ...[...all.matchAll(/\bu\(\s*v\(['"]([A-Za-z_][A-Za-z0-9_]*)['"]\)/g)]
          .map((match) => match[1]),
        ...[...all.matchAll(/\bgame\.get_unit\(['"]\{(?:v:)?([A-Za-z_][A-Za-z0-9_]*)\}['"]/g)]
          .map((match) => match[1]),
        ...[...all.matchAll(/\bget_item\(['"]\{(?:v:)?([A-Za-z_][A-Za-z0-9_]*)\}['"]/g)]
          .map((match) => match[1]),
      ]);
      const skillVariableNids = new Set(
        [...all.matchAll(/\bget_skill\([^,]+,\s*['"]\{(?:v:)?([A-Za-z_][A-Za-z0-9_]*)\}['"]/g)]
          .map((match) => match[1]),
      );
      const itemUidVariableNids = new Set(
        [...all.matchAll(/\bgame\.get_item\(\s*(?:int\(\s*)?v\(['"]([A-Za-z_][A-Za-z0-9_]*)['"]/g)]
          .map((match) => match[1]),
      );
      const weaponTypeVariableNids = new Set(
        [...all.matchAll(/\.wexp_gain\.get\(['"]\{(?:v:)?([A-Za-z_][A-Za-z0-9_]*)\}['"]/g)]
          .map((match) => match[1]),
      );
      const iterableVariableNids = new Set([
        ...[...all.matchAll(/\bfor\s+\w+\s+in\s+\{v:([A-Za-z_][A-Za-z0-9_]*)\}/g)]
          .map((match) => match[1]),
        ...[...all.matchAll(/\bfor\s+\w+\s+in\s+v\(['"]([^'"]+)['"]/g)]
          .map((match) => match[1]),
        ...[...all.matchAll(/\bin\s+\{v:([A-Za-z_][A-Za-z0-9_]*)\}/g)]
          .map((match) => match[1]),
        ...[...all.matchAll(/\{eval:\{v:([A-Za-z_][A-Za-z0-9_]*)\}\}/g)]
          .map((match) => match[1]),
      ]);
      const variableNids = new Set([
        ...[...all.matchAll(/\{v:([A-Za-z_][A-Za-z0-9_]*)\}/g)]
          .map((match) => match[1]),
        ...[...all.matchAll(/\bv\(['"]([^'"]+)['"]/g)]
          .map((match) => match[1]),
        ...[...all.matchAll(/game\.(?:level_vars|game_vars)\.get\(['"]([^'"]+)['"]/g)]
          .map((match) => match[1]),
        ...[...all.matchAll(/\{(?!e:|eval:|v:)([A-Za-z_][A-Za-z0-9_]*)\}/g)]
          .map((match) => match[1]),
      ]);
      const valueFor = (nid: string): any => {
        const listValued = /(?:all|list|pool|units|items|skills|classes|positions|tiles|path)/i
          .test(nid);
        let value: any = 1;
        if (itemUidVariableNids.has(nid)) value = fixtureWeapon.uid;
        else if (weaponTypeVariableNids.has(nid)) value = 'Sword';
        else if (unitVariableNids.has(nid)) value = 'Player';
        else if (skillVariableNids.has(nid)) value = 'Patchwork';
        else if (/(?:pos|position|tile|path)/i.test(nid)) value = [1, 1];
        else if (/(?:item|weapon|wep|usable|pool)/i.test(nid)) value = 'Iron_Sword';
        else if (/(?:skill)/i.test(nid)) value = 'Patchwork';
        else if (/(?:class|klass)/i.test(nid)) value = 'Archer';
        else if (/(?:stat|growth|wexp)/i.test(nid)) value = 'HP';
        else if (/(?:unit|player|enemy|ally|friend|party)/i.test(nid)) value = 'Player';
        else if (/(?:tag)/i.test(nid)) value = '';
        if (iterableVariableNids.has(nid) && !Array.isArray(value)) return [value];
        return listValued ? [value] : value;
      };
      const savedVariables = new Map<string, { level: any; game: any }>();
      for (const nid of variableNids) {
        savedVariables.set(nid, {
          level: game.levelVars.get(nid),
          game: game.gameVars.get(nid),
        });
        game.levelVars.set(nid, valueFor(nid));
      }

      const simpleLocals = expressions.evalSubstitutions
        .filter((expression) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(expression));
      const localArgs = new Map<string, any>(
        simpleLocals.map((nid) => [nid, valueFor(nid)]),
      );
      localArgs.set('mode', 'attack');
      localArgs.set('target_pos', [1, 1]);
      localArgs.set('created_unit', unit);
      localArgs.set('item2', item);
      localArgs.set('unit', unit);
      localArgs.set('target_foe', unit);
      localArgs.set('unit_pos', [1, 1]);
      localArgs.set('guy', 'Player');
      localArgs.set('playback', [
        {
          nid: 'mark_hit',
          attacker: unit,
          defender: unit,
          main_attacker: unit,
        },
      ]);
      const context = {
        game,
        unit1: unit,
        unit2: unit,
        item,
        region: game.currentLevel.regions[0],
        position: [1, 1],
        gameVars: game.gameVars,
        levelVars: game.levelVars,
        localArgs,
      };
      const resolveVariable = (nid: string): any => {
        if (localArgs.has(nid)) return localArgs.get(nid);
        if (game.levelVars.has(nid)) return game.levelVars.get(nid);
        if (game.gameVars.has(nid)) return game.gameVars.get(nid);
        return valueFor(nid);
      };
      const serializableVariable = (value: any, seen = new WeakSet<object>()): any => {
        if (!value || typeof value !== 'object') return value;
        if (typeof value.nid === 'string') return value.nid;
        if (seen.has(value)) return null;
        seen.add(value);
        if (Array.isArray(value)) {
          return value.map((entry) => serializableVariable(entry, seen));
        }
        if (value instanceof Map) {
          return Object.fromEntries([...value.entries()].map(([key, entry]) =>
            [String(key), serializableVariable(entry, seen)]));
        }
        return Object.fromEntries(Object.entries(value).map(([key, entry]) =>
          [key, serializableVariable(entry, seen)]));
      };
      const serializeVariable = (nid: string) =>
        JSON.stringify(serializableVariable(resolveVariable(nid)));
      const serializeScalarVariable = (nid: string) => {
        const value = resolveVariable(nid);
        return JSON.stringify(serializableVariable(
          Array.isArray(value) ? value[0] : value,
        ));
      };
      const substituteVars = (expression: string) => expression
        .replace(
          /\bu\((['"])\{(?:e|eval):.*\}\1\)(?=,)/g,
          'u("Player")',
        )
        .replace(
          /\bu\((['"])\{(?:e|eval):[\s\S]*?\}\1\)/g,
          'u("Player")',
        )
        .replace(
          /RECORDS\.get\('skill_inheritance'\)\.get\([^)]*\)/g,
          '"Player"',
        )
        .replace(/(['"])\{v:([A-Za-z_][A-Za-z0-9_]*)\}\1/g,
          (_match, _quote, nid) => serializeScalarVariable(nid))
        .replace(/\{v:([A-Za-z_][A-Za-z0-9_]*)\}/g,
          (_match, nid) => serializeVariable(nid))
        .replace(/(['"])\{([A-Za-z_][A-Za-z0-9_]*)\}\1/g,
          (_match, _quote, nid) => serializeScalarVariable(nid))
        .replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g,
          (_match, nid) => serializeVariable(nid))
        .replace(/\{(?:e|eval):([^{}]+)\}/g, '$1');

      let conditionCount = 0;
      for (const expression of expressions.conditions) {
        try {
          const value = evaluateCondition(substituteVars(expression), context);
          if (typeof value !== 'boolean') {
            failures.push(`condition non-boolean: ${expression}`);
          } else {
            conditionCount++;
          }
        } catch (error) {
          failures.push(`condition: ${expression}: ${String(error)}`);
        }
      }

      let evalCount = 0;
      for (const expression of expressions.evalSubstitutions) {
        try {
          const value = evaluateExpression(substituteVars(expression), context);
          if (value === undefined) failures.push(`eval undefined: ${expression}`);
          else evalCount++;
        } catch (error) {
          failures.push(`eval: ${expression}: ${String(error)}`);
        }
      }

      let loopCount = 0;
      for (const loop of expressions.loops) {
        const separator = loop.indexOf(';');
        const expression = substituteVars(loop.slice(separator + 1))
          .replace(/;(?:no_warn|from_python)\s*$/, '');
        try {
          const value = evaluateExpression(expression, context);
          if (!value || typeof value[Symbol.iterator] !== 'function') {
            failures.push(`loop non-iterable: ${expression} <= ${loop}`);
          } else {
            Array.from(value);
            loopCount++;
          }
        } catch (error) {
          failures.push(`loop: ${loop}: ${String(error)}`);
        }
      }

      console.warn = originalWarn;
      unit.skills = unit.skills.filter((skill: any) => !expressionSkills.includes(skill));
      unit.items.splice(originalItemsLength);
      unit.equippedWeapon = originalWeapon;
      unit.traveler = originalTraveler;
      unit.fields = savedFields;
      unit.position = originalPosition;
      game.items.clear();
      for (const [key, runtimeItem] of savedItemRegistry) {
        game.items.set(key, runtimeItem);
      }
      for (const nid of addedAliases) game.units.delete(nid);
      game.currentLevel.regions = oldRegions;
      for (const [nid, saved] of savedVariables) {
        if (saved.level === undefined) game.levelVars.delete(nid);
        else game.levelVars.set(nid, saved.level);
        if (saved.game === undefined) game.gameVars.delete(nid);
        else game.gameVars.set(nid, saved.game);
      }
      RECORDS.restore(savedRecords);
      RECORDS.persist();
      return { failures, warnings, conditionCount, evalCount, loopCount };
    }, inventory);

    expect(
      result.failures,
      [...result.failures.slice(0, 100), ...result.warnings.slice(-100)].join('\n'),
    ).toEqual([]);
    expect(result).toMatchObject({
      conditionCount: 4_937,
      evalCount: 249,
      loopCount: 646,
    });
    expect(result.warnings, result.warnings.join('\n')).toEqual([]);
  });

  test('EotF component markers and values retain Python expression shape', async ({ page }) => {
    const failures: string[] = [];
    page.on('console', (message) => {
      const text = message.text();
      if (text.includes('EventCondition JS eval failed')) failures.push(text);
    });
    await initializeCampaignRecords(page);

    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { SkillObject } = await import('/src/objects/skill.ts');
      const { evaluateExpression } = await import('/src/events/event-manager.ts');
      const unit = game.units.get('Player');
      const added = [
        'Shove',
        'Fire_Sovereign',
        'Graveyard_Bash',
        'Jealous_Patrons',
        'Beastform',
        'Gemini_Impact_Proc',
      ].map(
        (nid) => new SkillObject(game.db.skills.get(nid)),
      );
      unit.skills.push(...added);
      const context = {
        game,
        unit1: unit,
        gameVars: game.gameVars,
        levelVars: game.levelVars,
      };
      const values = {
        copySafe: evaluateExpression(
          "[s.nid for s in unit.skills if s.copysafe]",
          context,
        ),
        fireAffinity: evaluateExpression(
          "any([s.has_affinities and 'Fire' in s.has_affinities.value for s in unit.skills])",
          context,
        ),
        subskills: evaluateExpression(
          "get_skill(unit, 'Graveyard_Bash').subskills.value",
          context,
        ),
        shoveCost: evaluateExpression(
          "DB.skills.get('Shove').components.get('tether_parameters').value.get('cost')",
          context,
        ),
        contractSkills: evaluateExpression(
          "[s.nid for s in DB.skills if s.components.get('tether_parameters') and s.components.get('tether_parameters').value.get('level') == 99]",
          context,
        ),
        markerSkills: evaluateExpression(
          "[s.nid for s in unit.skills if s.shit or s.blue or s.combat_art_proc]",
          context,
        ),
        inheritanceKeys: evaluateExpression(
          "[key for key in RECORDS.get('skill_inheritance')]",
          context,
        ),
        classGrowth: evaluateExpression(
          "DB.classes.get('Archer').growths.get('SKL', 0)",
          context,
        ),
        classBowUsable: evaluateExpression(
          "DB.classes.get('Archer').wexp_gain.get('Bow').usable",
          context,
        ),
      };
      unit.skills.splice(unit.skills.length - added.length, added.length);
      return values;
    });

    expect(result.copySafe).toEqual(expect.arrayContaining(['Shove', 'Fire_Sovereign']));
    expect(result.fireAffinity).toBe(true);
    expect(result.subskills).toEqual(['Graveyard_Bash_P', 'Graveyard_Bash_O']);
    expect(result.shoveCost).toBe(20);
    expect(result.contractSkills).toEqual(expect.arrayContaining([
      'Ice_Sovereign',
      'Water_Sovereign',
      'Wind_Sovereign',
      'Earth_Sovereign',
      'Anima_Sovereign',
    ]));
    expect(result.markerSkills).toEqual(expect.arrayContaining([
      'Jealous_Patrons',
      'Beastform',
      'Gemini_Impact_Proc',
    ]));
    expect(result.inheritanceKeys).toEqual(['Nothing', 'Patchwork']);
    expect(result.classGrowth).toBe(40);
    expect(result.classBowUsable).toBe(true);
    expect(failures).toEqual([]);
  });

  test('EotF strict inventory accepts verified markers and rejects unknown NIDs', async ({ page }) => {
    await page.goto('/?harness=true&project=eotf.ltproj&level=X&clean=true&bundle=false');
    await waitForHarness(page);

    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const {
        EOTF_ITEM_COMPONENT_COUNT,
        EOTF_ITEM_COMPONENTS,
        EOTF_SKILL_COMPONENTS,
        EOTF_SKILL_COMPONENT_COUNT,
      } = await import('/src/engine/eotf-component-support.ts');
      const savedItems = [...game.db.items.values()].map((prefab: any) =>
        [prefab, prefab.components] as const);
      const savedSkills = [...game.db.skills.values()].map((prefab: any) =>
        [prefab, prefab.components] as const);
      for (const [prefab] of savedItems) {
        prefab.components = prefab.components.filter(([nid]: [string, any]) =>
          EOTF_ITEM_COMPONENTS.has(nid));
      }
      for (const [prefab] of savedSkills) {
        prefab.components = prefab.components.filter(([nid]: [string, any]) =>
          EOTF_SKILL_COMPONENTS.has(nid));
      }
      const originalUrl = location.href;
      history.replaceState(null, '', `${location.pathname}${location.search}&strict=true`);
      let verifiedError: string | null = null;
      let unknownError: string | null = null;
      let countError: string | null = null;
      try {
        try {
          (window as any).__logUnknownComponents();
        } catch (error) {
          verifiedError = String(error);
        }
        const removedNid = EOTF_ITEM_COMPONENTS.values().next().value;
        if (!removedNid) throw new Error('Expected a verified EOtF item component');
        EOTF_ITEM_COMPONENTS.delete(removedNid);
        try {
          (window as any).__logUnknownComponents();
        } catch (error) {
          countError = String(error);
        } finally {
          EOTF_ITEM_COMPONENTS.add(removedNid);
        }
        game.db.items.set('_EotfUnknownComponentProbe', {
          nid: '_EotfUnknownComponentProbe',
          components: [['definitely_not_an_eotf_component', null]],
        });
        try {
          (window as any).__logUnknownComponents();
        } catch (error) {
          unknownError = String(error);
        }
      } finally {
        game.db.items.delete('_EotfUnknownComponentProbe');
        for (const [prefab, components] of savedItems) prefab.components = components;
        for (const [prefab, components] of savedSkills) prefab.components = components;
        history.replaceState(null, '', originalUrl);
      }
      return {
        verifiedError,
        unknownError,
        countError,
        itemCount: EOTF_ITEM_COMPONENTS.size,
        skillCount: EOTF_SKILL_COMPONENTS.size,
        expectedItemCount: EOTF_ITEM_COMPONENT_COUNT,
        expectedSkillCount: EOTF_SKILL_COMPONENT_COUNT,
      };
    });

    expect(result.verifiedError).toBeNull();
    expect(result.unknownError).toContain('definitely_not_an_eotf_component');
    // Derived from the contract constant: removing one verified NID must be
    // reported with both exact counts. Hardcoding them here would mean editing
    // this assertion every time a component is legitimately verified.
    expect(result.countError).toContain(
      `expected ${result.expectedItemCount}, got ${result.expectedItemCount - 1}`,
    );
    expect(result.itemCount).toBe(result.expectedItemCount);
    expect(result.skillCount).toBe(result.expectedSkillCount);
  });

  test('all levels clean boot without runtime failures @milestone', async ({ page }) => {
    test.setTimeout(12 * 60_000);
    const failures: string[] = [];
    let currentLevel = 'startup';
    page.on('pageerror', (error) => {
      failures.push(`${currentLevel}: PAGEERROR: ${error.message}`);
    });
    page.on('console', (message) => {
      const text = message.text();
      if (!expectedAssetNoise(text) && compatibilityFailure(text)) {
        failures.push(`${currentLevel}: ${message.type().toUpperCase()}: ${text}`);
      }
    });

    for (const level of levels) {
      if (requestedLevelNids.size > 0 && !requestedLevelNids.has(level.nid)) continue;
      currentLevel = level.nid;
      await page.goto(`/?harness=true&project=eotf.ltproj&level=${encodeURIComponent(level.nid)}&clean=true&bundle=false`);
      await waitForHarness(page);
      await page.evaluate(() => (window as any).__harness.stepFrames(3, null));
      const state = await page.evaluate(() => (window as any).__harness.getState());
      if (state.levelNid !== level.nid) {
        failures.push(`${level.nid}: loaded level ${String(state.levelNid)}`);
      }
      if (!settledStates.has(state.currentStateName)) {
        failures.push(`${level.nid}: clean boot ended in ${String(state.currentStateName)}`);
      }
    }

    expect(failures, failures.join('\n')).toEqual([]);
  });

  test.describe('all level-start event queues settle without compatibility failures @milestone', () => {
    test.describe.configure({ mode: 'parallel' });
    const shardCount = 4;
    for (let shard = 0; shard < shardCount; shard++) {
      test(`catalog shard ${shard + 1}/${shardCount}`, async ({ page }) => {
        test.setTimeout(15 * 60_000);
        const failures: string[] = [];
        const observedFailures = new Set<string>();
        let currentLevel = 'startup';
        page.on('pageerror', (error) => {
          failures.push(`${currentLevel}: PAGEERROR: ${error.message}`);
        });
        page.on('console', (message) => {
          const text = message.text();
          if (!expectedAssetNoise(text) && compatibilityFailure(text)) {
            const failure = `${currentLevel}: ${message.type().toUpperCase()}: ${text.split('\n', 1)[0]}`;
            if (!observedFailures.has(failure)) {
              observedFailures.add(failure);
              failures.push(failure);
            }
          }
        });

        await initializeCampaignRecords(page);
        for (const [index, level] of levels.entries()) {
          if (index % shardCount !== shard) continue;
          if (requestedLevelNids.size > 0 && !requestedLevelNids.has(level.nid)) continue;
          currentLevel = level.nid;
          await page.evaluate(async (levelNid) => {
            const harnessWindow = window as any;
            const restored = await harnessWindow.__harness.loadSnapshot(
              harnessWindow.__eotfCampaignBaseline,
            );
            if (!restored) throw new Error('Failed to restore EOtF campaign baseline');
            await harnessWindow.__harness.loadLevel(levelNid);
          }, level.nid);
          await page.evaluate(
            (states) => (window as any).__harness.settle(300, states),
            [...settledStates],
          );
          const state = await page.evaluate(() => {
            const game = (window as any).__gameRef;
            return {
              ...((window as any).__harness.getState()),
              activeEvents: game.eventManager?.hasActiveEvents() ?? false,
            };
          });
          if (state.levelNid !== level.nid) {
            failures.push(`${level.nid}: loaded level ${String(state.levelNid)}`);
          }
          const terminal = !state.currentStateName &&
            state.stateStack.length === 0 &&
            !state.activeEvents;
          if (!settledStates.has(state.currentStateName) && !terminal) {
            failures.push(
              `${level.nid}: level_start ended in ${String(state.currentStateName)} [${state.stateStack.join(', ')}]`,
            );
          }
        }
      });
    }
  });
});
