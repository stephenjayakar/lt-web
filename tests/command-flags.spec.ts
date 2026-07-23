/**
 * Blocking/no-block and no_banner flag matching per event command (P1 row:
 * "Match blocking/no-block, no-banner, immediate, and skip flags per
 * command"). Covers commands where a real-usage flag was found to be
 * silently ignored by the web port and was fixed as part of this pass:
 *
 * Python source of truth (lt-maker/app/events/event_functions.py):
 *  - give_item / remove_item / give_skill / remove_skill / break_item /
 *    give_money / give_bexp all show a banner.append + state.change('alert')
 *    (blocking) UNLESS the `no_banner` flag is present, in which case no
 *    banner is shown and the event does not block on it.
 *
 * Before this fix, the web's EventState never displayed any banner at all
 * for these seven commands (a visible regression vs Python for common event
 * scripts like `give_item;{unit};Elixir` or `give_skill;{unit};Locktouch;;no_banner`
 * mixed with un-flagged calls in the same script).
 *
 * Strategy: inject a test event and drain frames. When a banner is shown,
 * EventState blocks pointer advancement until the banner's ~3000ms display
 * timer elapses (see `this.banner = new Banner(text, undefined, 3000)` and
 * the "Banner timer" block in EventState.update). We use a `game_var` set by
 * the very next command in the script as the observable: with `no_banner`
 * the marker is set within a handful of frames; without it, the marker is
 * NOT set until the banner's ~180 frames (3000ms / ~16.7ms) have elapsed.
 */

import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';

async function waitForHarness(page: Page): Promise<void> {
  await page.waitForFunction(() => !!(window as any).__harness?.ready, { timeout: 15000 });
}

async function stepFrames(page: Page, count: number): Promise<void> {
  await page.evaluate((count) => (window as any).__harness.stepFrames(count, null), count);
}

async function installAndRunEvent(page: Page, nid: string, source: string[], frames: number): Promise<void> {
  await page.evaluate(
    ({ nid, source }) => {
      const g = (window as any).__gameRef;
      g.db.events.set(nid, {
        name: nid,
        nid,
        trigger: nid,
        level_nid: g.currentLevel?.nid ?? null,
        condition: 'True',
        only_once: false,
        priority: 0,
        _source: source,
      });
      g.eventManager.triggerSpecific(nid, { type: nid }, true);
      g.state.change('event');
    },
    { nid, source },
  );
  await stepFrames(page, frames);
}

async function getGameVar(page: Page, key: string): Promise<any> {
  return page.evaluate((key) => (window as any).__gameRef.gameVars.get(key), key);
}

async function configureLargeCamera(page: Page): Promise<void> {
  await page.evaluate(() => {
    const gameWindow = window as Window & {
      __gameRef: {
        camera: {
          setMapSize(widthTiles: number, heightTiles: number): void;
          forceTile(tileX: number, tileY: number): void;
        };
      };
    };
    gameWindow.__gameRef.camera.setMapSize(40, 30);
    gameWindow.__gameRef.camera.forceTile(0, 0);
  });
}

async function getAdjacentMoveTarget(page: Page, unitNid: string): Promise<string> {
  return page.evaluate((nid) => {
    const gameWindow = window as Window & {
      __gameRef: {
        units: { get(key: string): { position: [number, number] | null } | undefined };
        board: {
          checkBounds(x: number, y: number): boolean;
          getUnit(x: number, y: number): unknown;
        };
      };
    };
    const game = gameWindow.__gameRef;
    const position = game.units.get(nid)?.position;
    if (!position) throw new Error(`Unit ${nid} is not on the map`);
    const candidates: [number, number][] = [
      [position[0] + 1, position[1]],
      [position[0] - 1, position[1]],
      [position[0], position[1] + 1],
      [position[0], position[1] - 1],
    ];
    const target = candidates.find(([x, y]) =>
      game.board.checkBounds(x, y) && !game.board.getUnit(x, y));
    if (!target) throw new Error(`No adjacent move target for ${nid}`);
    return `${target[0]},${target[1]}`;
  }, unitNid);
}

async function configureUnitGroup(
  page: Page,
  groupNid: string,
  unitNid: string,
  target: string,
): Promise<void> {
  await page.evaluate(({ nid, unit, destination }) => {
    const gameWindow = window as Window & {
      __gameRef: {
        currentLevel: {
          unit_groups: Array<{
            nid: string;
            units: string[];
            positions: Record<string, [number, number]>;
          }>;
        } | null;
      };
    };
    const level = gameWindow.__gameRef.currentLevel;
    if (!level) throw new Error('No current level');
    const [x, y] = destination.split(',').map(Number);
    level.unit_groups.push({
      nid,
      units: [unit],
      positions: { [unit]: [x, y] },
    });
  }, { nid: groupNid, unit: unitNid, destination: target });
}

async function configureOverworldEventRuntime(page: Page): Promise<void> {
  await page.evaluate(() => {
    let movementFrames = 0;
    let completion: (() => void) | null = null;
    const nodes = new Map([
      ['NodeA', { nid: 'NodeA', position: [0, 0] as [number, number] }],
      ['NodeB', { nid: 'NodeB', position: [10, 0] as [number, number] }],
    ]);
    const entities = new Map<string, any>([[
      'TestParty',
      {
        nid: 'TestParty',
        onNode: 'NodeA',
        displayPosition: [0, 0] as [number, number],
      },
    ]]);
    const controller = {
      nodes,
      roads: new Map([[
        'NodeA-NodeB',
        { nid: 'NodeA-NodeB', node1: 'NodeA', node2: 'NodeB' },
      ]]),
      enabledNodes: new Set<string>(),
      enabledRoads: new Set<string>(),
      enabledMenuOptions: new Map([['NodeA', new Map([['TestOption', true]])]]),
      visibleMenuOptions: new Map([['NodeA', new Map([['TestOption', true]])]]),
      entities,
      selectedPartyNid: 'TestParty',
      getNode: (nid: string) => nodes.get(nid),
      getPathPoints: () => [[0, 0], [10, 0]],
      movePartyToNode: (entityNid: string, nodeNid: string) => {
        const moved = entities.get(entityNid);
        const node = nodes.get(nodeNid);
        if (moved && node) {
          moved.onNode = nodeNid;
          moved.displayPosition = [...node.position];
        }
      },
      createEntity: (
        nid: string,
        dtype: string,
        dnid: string,
        team: string,
        nodeNid: string | null,
      ) => {
        const created = {
          nid,
          dtype,
          dnid,
          team,
          onNode: nodeNid,
          displayPosition: nodeNid ? [...nodes.get(nodeNid)!.position] : null,
        };
        entities.set(nid, created);
        return created;
      },
      removeEntity: (nid: string) => {
        entities.delete(nid);
        if (controller.selectedPartyNid === nid) controller.selectedPartyNid = null;
      },
    };
    const gameWindow = window as Window & {
      __gameRef: {
        overworldController: unknown;
        overworldMovement: unknown;
      };
    };
    gameWindow.__gameRef.overworldController = controller;
    gameWindow.__gameRef.overworldMovement = {
      beginMove: (
        _entity: unknown,
        _path: [number, number][],
        options?: { callback?: () => void },
      ) => {
        movementFrames = 30;
        completion = options?.callback ?? null;
      },
      isMoving: () => movementFrames > 0,
      update: () => {
        if (movementFrames <= 0) return;
        movementFrames--;
        if (movementFrames === 0) {
          completion?.();
          completion = null;
        }
      },
    };
  });
}

test.describe('Event command flag matching: no_banner', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/?harness=true&level=DEBUG&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 5);
  });

  test('give_item: no_banner skips the acquired-item banner block, un-flagged blocks', async ({ page }) => {
    // no_banner: marker set within a few frames (no banner block).
    await installAndRunEvent(page, 'test_give_item_no_banner', [
      'give_item;Eirika;Elixir;;no_banner',
      'game_var;marker;done',
    ], 5);
    expect(await getGameVar(page, 'marker')).toBe('done');

    // un-flagged: banner shown, so the marker should NOT be set yet after
    // a few frames, but should be set once the banner's timer elapses.
    await installAndRunEvent(page, 'test_give_item_banner', [
      'give_item;Eirika;Iron_Bow',
      'game_var;marker2;done',
    ], 5);
    expect(await getGameVar(page, 'marker2')).toBeUndefined();
    await stepFrames(page, 200);
    expect(await getGameVar(page, 'marker2')).toBe('done');
  });

  test('give_skill: no_banner skips the banner block, un-flagged blocks', async ({ page }) => {
    await installAndRunEvent(page, 'test_give_skill_no_banner', [
      'give_skill;Eirika;Locktouch;;no_banner',
      'game_var;marker;done',
    ], 5);
    expect(await getGameVar(page, 'marker')).toBe('done');

    await installAndRunEvent(page, 'test_give_skill_banner', [
      'give_skill;Seth;Locktouch',
      'game_var;marker2;done',
    ], 5);
    expect(await getGameVar(page, 'marker2')).toBeUndefined();
    await stepFrames(page, 200);
    expect(await getGameVar(page, 'marker2')).toBe('done');
  });

  test('remove_skill: no_banner skips the banner block, un-flagged blocks', async ({ page }) => {
    await installAndRunEvent(page, 'test_remove_skill_setup', [
      'give_skill;Eirika;Locktouch;;no_banner',
      'give_skill;Seth;Locktouch;;no_banner',
    ], 5);

    await installAndRunEvent(page, 'test_remove_skill_no_banner', [
      'remove_skill;Eirika;Locktouch;;no_banner',
      'game_var;marker;done',
    ], 5);
    expect(await getGameVar(page, 'marker')).toBe('done');

    await installAndRunEvent(page, 'test_remove_skill_banner', [
      'remove_skill;Seth;Locktouch',
      'game_var;marker2;done',
    ], 5);
    expect(await getGameVar(page, 'marker2')).toBeUndefined();
    await stepFrames(page, 200);
    expect(await getGameVar(page, 'marker2')).toBe('done');
  });

  test('break_item: no_banner skips the banner block for a player unit', async ({ page }) => {
    await installAndRunEvent(page, 'test_break_item_setup', [
      'give_item;Eirika;Iron_Bow;;no_banner',
      'give_item;Seth;Iron_Bow;;no_banner',
    ], 5);

    await installAndRunEvent(page, 'test_break_item_no_banner', [
      'break_item;Eirika;Iron_Bow;no_banner',
      'game_var;marker;done',
    ], 5);
    expect(await getGameVar(page, 'marker')).toBe('done');

    await installAndRunEvent(page, 'test_break_item_banner', [
      'break_item;Seth;Iron_Bow',
      'game_var;marker2;done',
    ], 5);
    expect(await getGameVar(page, 'marker2')).toBeUndefined();
    await stepFrames(page, 200);
    expect(await getGameVar(page, 'marker2')).toBe('done');
  });

  test('give_money: no_banner skips the banner block, un-flagged blocks', async ({ page }) => {
    await installAndRunEvent(page, 'test_give_money_no_banner', [
      'give_money;100;;no_banner',
      'game_var;marker;done',
    ], 5);
    expect(await getGameVar(page, 'marker')).toBe('done');

    await installAndRunEvent(page, 'test_give_money_banner', [
      'give_money;100',
      'game_var;marker2;done',
    ], 5);
    expect(await getGameVar(page, 'marker2')).toBeUndefined();
    await stepFrames(page, 200);
    expect(await getGameVar(page, 'marker2')).toBe('done');
  });

  test('give_bexp: no_banner skips the banner block, un-flagged blocks', async ({ page }) => {
    await installAndRunEvent(page, 'test_give_bexp_no_banner', [
      'give_bexp;10;;no_banner',
      'game_var;marker;done',
    ], 5);
    expect(await getGameVar(page, 'marker')).toBe('done');

    await installAndRunEvent(page, 'test_give_bexp_banner', [
      'give_bexp;10',
      'game_var;marker2;done',
    ], 5);
    expect(await getGameVar(page, 'marker2')).toBeUndefined();
    await stepFrames(page, 200);
    expect(await getGameVar(page, 'marker2')).toBe('done');
  });

  test('remove_item: no_banner skips the banner block, un-flagged blocks', async ({ page }) => {
    await installAndRunEvent(page, 'test_remove_item_setup', [
      'give_item;Eirika;Iron_Bow;;no_banner',
      'give_item;Seth;Iron_Bow;;no_banner',
    ], 5);

    await installAndRunEvent(page, 'test_remove_item_no_banner', [
      'remove_item;Eirika;Iron_Bow;;no_banner',
      'game_var;marker;done',
    ], 5);
    expect(await getGameVar(page, 'marker')).toBe('done');

    await installAndRunEvent(page, 'test_remove_item_banner', [
      'remove_item;Seth;Iron_Bow',
      'game_var;marker2;done',
    ], 5);
    expect(await getGameVar(page, 'marker2')).toBeUndefined();
    await stepFrames(page, 200);
    expect(await getGameVar(page, 'marker2')).toBe('done');
  });
});

test.describe('Event command flag matching: skip', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/?harness=true&level=DEBUG&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 5);
  });

  test('end_skip restores blocking for subsequent commands', async ({ page }) => {
    await installAndRunEvent(page, 'test_end_skip', [
      'wait;1000',
      'end_skip',
      'wait;1000',
      'game_var;after_end_skip;done',
    ], 5);

    await page.evaluate(() => {
      const harnessWindow = window as Window & {
        __harness: { stepFrames(count: number, input: string | null): void };
      };
      harnessWindow.__harness.stepFrames(1, 'BACK');
    });
    expect(await getGameVar(page, 'after_end_skip')).toBeUndefined();

    await stepFrames(page, 70);
    expect(await getGameVar(page, 'after_end_skip')).toBe('done');
  });
});

test.describe('Event command flag matching: no_block', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/?harness=true&level=DEBUG&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 5);
  });

  test('transition continues the script during a no_block fade, but otherwise blocks', async ({ page }) => {
    await installAndRunEvent(page, 'test_transition_no_block', [
      'transition;close;1000;;;no_block',
      'game_var;no_block_marker;done',
      'wait;1000',
    ], 5);
    expect(await getGameVar(page, 'no_block_marker')).toBe('done');
    const fadeAlpha = await page.evaluate(() => {
      const gameWindow = window as Window & {
        __gameRef: { state: { getCurrentState(): unknown } };
      };
      const state = gameWindow.__gameRef.state.getCurrentState() as {
        transitionAlpha?: unknown;
      };
      return typeof state.transitionAlpha === 'number' ? state.transitionAlpha : null;
    });
    expect(fadeAlpha).not.toBeNull();
    expect(fadeAlpha!).toBeGreaterThan(0);
    expect(fadeAlpha!).toBeLessThan(1);
    await stepFrames(page, 70);

    await installAndRunEvent(page, 'test_transition_blocking', [
      'transition;close;1000',
      'game_var;blocking_marker;done',
    ], 5);
    expect(await getGameVar(page, 'blocking_marker')).toBeUndefined();
    await stepFrames(page, 70);
    expect(await getGameVar(page, 'blocking_marker')).toBe('done');
  });

  test('add_portrait blocks for its fade unless no_block is set', async ({ page }) => {
    await installAndRunEvent(page, 'test_add_portrait_blocking', [
      'add_portrait;Eirika;Left',
      'game_var;add_portrait_blocking;done',
    ], 5);
    expect(await getGameVar(page, 'add_portrait_blocking')).toBeUndefined();
    for (let attempt = 0; attempt < 12; attempt++) {
      if (await getGameVar(page, 'add_portrait_blocking') === 'done') break;
      await stepFrames(page, 10);
    }
    expect(await getGameVar(page, 'add_portrait_blocking')).toBe('done');
    await page.goto('/?harness=true&level=DEBUG&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 5);

    await installAndRunEvent(page, 'test_add_portrait_no_block', [
      'add_portrait;Eirika;Left;;;;no_block',
      'game_var;add_portrait_no_block;done',
    ], 15);
    await stepFrames(page, 1);
    expect(await getGameVar(page, 'add_portrait_no_block')).toBe('done');
  });

  test('remove_portrait blocks for its fade unless no_block is set', async ({ page }) => {
    await installAndRunEvent(page, 'test_remove_portrait_blocking', [
      'add_portrait;Eirika;Left;;;;no_block',
      'remove_portrait;Eirika',
      'game_var;remove_portrait_blocking;done',
    ], 5);
    expect(await getGameVar(page, 'remove_portrait_blocking')).toBeUndefined();
    await stepFrames(page, 20);
    expect(await getGameVar(page, 'remove_portrait_blocking')).toBe('done');
    await page.goto('/?harness=true&level=DEBUG&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 5);

    await installAndRunEvent(page, 'test_remove_portrait_no_block', [
      'add_portrait;Eirika;Left;;;;no_block',
      'remove_portrait;Eirika;;;no_block',
      'game_var;remove_portrait_no_block;done',
    ], 15);
    await stepFrames(page, 1);
    expect(await getGameVar(page, 'remove_portrait_no_block')).toBe('done');
  });

  test('move_portrait blocks for travel unless no_block is set', async ({ page }) => {
    await installAndRunEvent(page, 'test_move_portrait_blocking', [
      'add_portrait;Eirika;Left;;;;no_block',
      'move_portrait;Eirika;Right',
      'game_var;move_portrait_blocking;done',
    ], 5);
    expect(await getGameVar(page, 'move_portrait_blocking')).toBeUndefined();
    for (let attempt = 0; attempt < 6; attempt++) {
      if (await getGameVar(page, 'move_portrait_blocking') === 'done') break;
      await stepFrames(page, 10);
    }
    expect(await getGameVar(page, 'move_portrait_blocking')).toBe('done');
    await page.goto('/?harness=true&level=DEBUG&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 5);

    await installAndRunEvent(page, 'test_move_portrait_no_block', [
      'add_portrait;Eirika;Left;;;;no_block',
      'move_portrait;Eirika;Right;;no_block',
      'game_var;move_portrait_no_block;done',
    ], 15);
    await stepFrames(page, 1);
    expect(await getGameVar(page, 'move_portrait_no_block')).toBe('done');
  });

  test('bop and mirror portrait commands honor no_block', async ({ page }) => {
    await installAndRunEvent(page, 'test_bop_portrait_blocking', [
      'add_portrait;Eirika;Left;;;;no_block',
      'bop_portrait;Eirika;1;100',
      'game_var;bop_portrait_blocking;done',
    ], 5);
    expect(await getGameVar(page, 'bop_portrait_blocking')).toBeUndefined();
    await stepFrames(page, 30);
    expect(await getGameVar(page, 'bop_portrait_blocking')).toBe('done');
    await page.goto('/?harness=true&level=DEBUG&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 5);

    await installAndRunEvent(page, 'test_mirror_portrait_no_block', [
      'add_portrait;Eirika;Left;;;;no_block',
      'mirror_portrait;Eirika;;no_block',
      'bop_portrait;Eirika;1;100;no_block',
      'game_var;portrait_no_block;done',
    ], 15);
    await stepFrames(page, 1);
    expect(await getGameVar(page, 'portrait_no_block')).toBe('done');
  });

  test('dialog commands continue and auto-close under no_block', async ({ page }) => {
    await installAndRunEvent(page, 'test_speak_blocking', [
      'speak;Narrator;Blocking line',
      'game_var;speak_blocking;done',
    ], 5);
    expect(await getGameVar(page, 'speak_blocking')).toBeUndefined();

    await page.goto('/?harness=true&level=DEBUG&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 5);
    await installAndRunEvent(page, 'test_dialog_no_block', [
      'speak;Narrator;First line;no_block',
      'game_var;speak_no_block;done',
      'say;Narrator;Second;line;no_block',
      'game_var;say_no_block;done',
      'narrate;Narrator;Third line;no_block',
      'game_var;narrate_no_block;done',
      'wait;1000',
    ], 5);
    expect(await getGameVar(page, 'speak_no_block')).toBe('done');
    expect(await getGameVar(page, 'say_no_block')).toBe('done');
    expect(await getGameVar(page, 'narrate_no_block')).toBe('done');

    await stepFrames(page, 30);
    const dialogActive = await page.evaluate(() => {
      const gameWindow = window as Window & {
        __gameRef: { state: { getCurrentState(): unknown } };
      };
      const state = gameWindow.__gameRef.state.getCurrentState() as {
        dialog?: unknown;
      };
      return state.dialog != null;
    });
    expect(dialogActive).toBe(false);
  });
});

test.describe('Event command flag matching: camera flags', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/?harness=true&level=1&clean=true&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 5);
    await configureLargeCamera(page);
  });

  test('move and center cursor distinguish blocking, no_block, and immediate', async ({ page }) => {
    await installAndRunEvent(page, 'test_cursor_no_block', [
      'move_cursor;17,15;;no_block',
      'game_var;cursor_no_block;done',
      'wait;1000',
    ], 2);
    expect(await getGameVar(page, 'cursor_no_block')).toBe('done');
    const movingCamera = await page.evaluate(() => {
      const gameWindow = window as Window & {
        __gameRef: {
          camera: { getPosition(): [number, number]; getTarget(): [number, number] };
        };
      };
      const camera = gameWindow.__gameRef.camera;
      return { position: camera.getPosition(), target: camera.getTarget() };
    });
    expect(movingCamera.position).not.toEqual(movingCamera.target);

    await page.goto('/?harness=true&level=1&clean=true&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 5);
    await configureLargeCamera(page);
    await installAndRunEvent(page, 'test_cursor_blocking', [
      'move_cursor;17,15',
      'game_var;cursor_blocking;done',
    ], 2);
    expect(await getGameVar(page, 'cursor_blocking')).toBeUndefined();
    await stepFrames(page, 100);
    expect(await getGameVar(page, 'cursor_blocking')).toBe('done');

    await page.goto('/?harness=true&level=1&clean=true&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 5);
    await configureLargeCamera(page);
    await installAndRunEvent(page, 'test_cursor_immediate', [
      'center_cursor;17,15;;immediate',
      'game_var;cursor_immediate;done',
    ], 2);
    expect(await getGameVar(page, 'cursor_immediate')).toBe('done');
    const snappedCamera = await page.evaluate(() => {
      const gameWindow = window as Window & {
        __gameRef: {
          camera: { getPosition(): [number, number]; getTarget(): [number, number] };
        };
      };
      const camera = gameWindow.__gameRef.camera;
      return { position: camera.getPosition(), target: camera.getTarget() };
    });
    expect(snappedCamera.position).toEqual(snappedCamera.target);
  });

  test('flicker_cursor immediate snaps before its mandatory display wait', async ({ page }) => {
    await installAndRunEvent(page, 'test_flicker_immediate', [
      'flicker_cursor;17,15;immediate',
      'game_var;flicker_done;yes',
    ], 5);
    expect(await getGameVar(page, 'flicker_done')).toBeUndefined();
    await stepFrames(page, 70);
    expect(await getGameVar(page, 'flicker_done')).toBe('yes');
    const cursorVisible = await page.evaluate(() => {
      const gameWindow = window as Window & {
        __gameRef: { cursor: { visible: boolean } };
      };
      return gameWindow.__gameRef.cursor.visible;
    });
    expect(cursorVisible).toBe(false);
  });
});

test.describe('Event command flag matching: unit movement', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/?harness=true&level=DEBUG&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 5);
  });

  test('move_unit animates while default blocks and no_block dispatches onward', async ({ page }) => {
    let target = await getAdjacentMoveTarget(page, 'Eirika');
    await installAndRunEvent(page, 'test_move_unit_blocking', [
      `move_unit;Eirika;${target};normal;;600`,
      'game_var;move_unit_blocking;done',
    ], 2);
    expect(await getGameVar(page, 'move_unit_blocking')).toBeUndefined();
    const blockingMovement = await page.evaluate(() => {
      const gameWindow = window as Window & {
        __gameRef: { movementSystem: { isMoving(): boolean } };
      };
      return gameWindow.__gameRef.movementSystem.isMoving();
    });
    expect(blockingMovement).toBe(true);
    await stepFrames(page, 50);
    expect(await getGameVar(page, 'move_unit_blocking')).toBe('done');

    await page.goto('/?harness=true&level=DEBUG&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 5);
    target = await getAdjacentMoveTarget(page, 'Eirika');
    await installAndRunEvent(page, 'test_move_unit_no_block', [
      `move_unit;Eirika;${target};normal;;600;no_block`,
      'game_var;move_unit_no_block;done',
      'wait;1000',
    ], 2);
    expect(await getGameVar(page, 'move_unit_no_block')).toBe('done');
    const nonBlockingMovement = await page.evaluate(() => {
      const gameWindow = window as Window & {
        __gameRef: { movementSystem: { isMoving(): boolean } };
      };
      return gameWindow.__gameRef.movementSystem.isMoving();
    });
    expect(nonBlockingMovement).toBe(true);
  });

  test('move_group shares blocking and no_block movement semantics', async ({ page }) => {
    let target = await getAdjacentMoveTarget(page, 'Eirika');
    await configureUnitGroup(page, 'test_move_group', 'Eirika', target);
    await installAndRunEvent(page, 'test_move_group_blocking', [
      'move_group;test_move_group;;normal;giveup',
      'game_var;move_group_blocking;done',
    ], 2);
    expect(await getGameVar(page, 'move_group_blocking')).toBeUndefined();
    await stepFrames(page, 20);
    expect(await getGameVar(page, 'move_group_blocking')).toBe('done');

    await page.goto('/?harness=true&level=DEBUG&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 5);
    target = await getAdjacentMoveTarget(page, 'Eirika');
    await configureUnitGroup(page, 'test_move_group', 'Eirika', target);
    await installAndRunEvent(page, 'test_move_group_no_block', [
      'move_group;test_move_group;;normal;giveup;no_block',
      'game_var;move_group_no_block;done',
      'wait;1000',
    ], 2);
    expect(await getGameVar(page, 'move_group_no_block')).toBe('done');
    const movementActive = await page.evaluate(() => {
      const gameWindow = window as Window & {
        __gameRef: { movementSystem: { isMoving(): boolean } };
      };
      return gameWindow.__gameRef.movementSystem.isMoving();
    });
    expect(movementActive).toBe(true);
  });
});

test.describe('Event command flag matching: unit death', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/?harness=true&level=DEBUG&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 5);
  });

  test('kill_unit blocks for map death unless immediate', async ({ page }) => {
    await installAndRunEvent(page, 'test_kill_unit_blocking', [
      'kill_unit;Seth',
      'game_var;kill_unit_blocking;done',
    ], 2);
    expect(await getGameVar(page, 'kill_unit_blocking')).toBeUndefined();
    await stepFrames(page, 40);
    expect(await getGameVar(page, 'kill_unit_blocking')).toBe('done');

    await page.goto('/?harness=true&level=DEBUG&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 5);
    await installAndRunEvent(page, 'test_kill_unit_immediate', [
      'kill_unit;Seth;immediate',
      'game_var;kill_unit_immediate;done',
    ], 2);
    expect(await getGameVar(page, 'kill_unit_immediate')).toBe('done');
  });
});

test.describe('Event command flag matching: progression', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/?harness=true&level=DEBUG&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 5);
  });

  test('give_exp presents a blocking gain unless silent', async ({ page }) => {
    await installAndRunEvent(page, 'test_give_exp_blocking', [
      'give_exp;Eirika;1',
      'game_var;give_exp_blocking;done',
    ], 2);
    expect(await getGameVar(page, 'give_exp_blocking')).toBeUndefined();
    await stepFrames(page, 55);
    expect(await getGameVar(page, 'give_exp_blocking')).toBe('done');

    await page.goto('/?harness=true&level=DEBUG&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 5);
    await installAndRunEvent(page, 'test_give_exp_silent', [
      'give_exp;Eirika;1;silent',
      'game_var;give_exp_silent;done',
    ], 2);
    expect(await getGameVar(page, 'give_exp_silent')).toBe('done');
  });
});

test.describe('Event command flag matching: state transitions', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/?harness=true&level=DEBUG&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 5);
  });

  test('menu commands fade by default and enter immediately when flagged', async ({ page }) => {
    await installAndRunEvent(page, 'test_menu_transition', [
      'open_unit_management',
    ], 3);
    const transitionState = await page.evaluate(() => {
      const gameWindow = window as Window & {
        __gameRef: {
          state: { getCurrentState(): { name: string; transitionAlpha?: number } | null };
        };
      };
      const state = gameWindow.__gameRef.state.getCurrentState();
      return { name: state?.name, alpha: state?.transitionAlpha ?? 0 };
    });
    expect(transitionState.name).toBe('event');
    expect(transitionState.alpha).toBeGreaterThan(0);
    await stepFrames(page, 15);
    const fadedStateName = await page.evaluate(() => {
      const gameWindow = window as Window & {
        __gameRef: { state: { getCurrentState(): { name: string } | null } };
      };
      return gameWindow.__gameRef.state.getCurrentState()?.name;
    });
    expect(fadedStateName).toBe('base_manage');

    await page.goto('/?harness=true&level=DEBUG&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 5);
    await installAndRunEvent(page, 'test_menu_immediate', [
      'open_unit_management;;immediate',
    ], 2);
    const immediateStateName = await page.evaluate(() => {
      const gameWindow = window as Window & {
        __gameRef: { state: { getCurrentState(): { name: string } | null } };
      };
      return gameWindow.__gameRef.state.getCurrentState()?.name;
    });
    expect(immediateStateName).toBe('base_manage');
  });
});

test.describe('Event command flag matching: map animation', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/?harness=true&level=DEBUG&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 5);
  });

  test('add_unit_map_anim blocks one-shot playback unless no_block', async ({ page }) => {
    const animationNid = await page.evaluate(() => {
      const gameWindow = window as Window & {
        __gameRef: { db: { mapAnimations: Map<string, unknown> } };
      };
      const nid = gameWindow.__gameRef.db.mapAnimations.keys().next().value;
      if (typeof nid !== 'string') throw new Error('Fixture has no map animation');
      return nid;
    });
    await installAndRunEvent(page, 'test_map_anim_blocking', [
      `add_unit_map_anim;${animationNid};Eirika;1`,
      'game_var;map_anim_blocking;done',
    ], 2);
    expect(await getGameVar(page, 'map_anim_blocking')).toBeUndefined();
    await stepFrames(page, 180);
    expect(await getGameVar(page, 'map_anim_blocking')).toBe('done');

    await page.goto('/?harness=true&level=DEBUG&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 5);
    await installAndRunEvent(page, 'test_map_anim_no_block', [
      `add_unit_map_anim;${animationNid};Eirika;1;no_block`,
      'game_var;map_anim_no_block;done',
    ], 2);
    expect(await getGameVar(page, 'map_anim_no_block')).toBe('done');
  });
});


test.describe('Event command flag matching: overlay sprites', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/?harness=true&level=DEBUG&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 5);
  });

  test('overlay entry and exit animations block unless no_block', async ({ page }) => {
    await installAndRunEvent(page, 'test_overlay_blocking', [
      'draw_overlay_sprite;test_overlay;cursor;0,0;0;fade;200',
      'game_var;overlay_draw_blocking;done',
      'remove_overlay_sprite;test_overlay;fade;200',
      'game_var;overlay_remove_blocking;done',
      'wait;1000',
    ], 2);
    expect(await getGameVar(page, 'overlay_draw_blocking')).toBeUndefined();
    await stepFrames(page, 16);
    expect(await getGameVar(page, 'overlay_draw_blocking')).toBe('done');
    expect(await getGameVar(page, 'overlay_remove_blocking')).toBeUndefined();
    await stepFrames(page, 16);
    expect(await getGameVar(page, 'overlay_remove_blocking')).toBe('done');

    await page.goto('/?harness=true&level=DEBUG&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 5);
    await installAndRunEvent(page, 'test_overlay_no_block', [
      'draw_overlay_sprite;test_overlay;cursor;0,0;0;fade;200;no_block',
      'remove_overlay_sprite;test_overlay;fade;200;no_block',
      'game_var;overlay_no_block;done',
    ], 2);
    expect(await getGameVar(page, 'overlay_no_block')).toBe('done');
  });
});
test.describe('Event command flag matching: overworld presentation', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/?harness=true&level=DEBUG&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 5);
    await configureOverworldEventRuntime(page);
  });

  test('overworld movement and reveals distinguish blocking flags', async ({ page }) => {
    await installAndRunEvent(page, 'test_overworld_move_blocking', [
      'overworld_move_unit;TestParty;NodeB',
      'game_var;overworld_move_blocking;done',
    ], 2);
    expect(await getGameVar(page, 'overworld_move_blocking')).toBeUndefined();
    await stepFrames(page, 40);
    expect(await getGameVar(page, 'overworld_move_blocking')).toBe('done');

    await page.goto('/?harness=true&level=DEBUG&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 5);
    await configureOverworldEventRuntime(page);
    await installAndRunEvent(page, 'test_overworld_move_no_block', [
      'overworld_move_unit;TestParty;NodeB;no_block',
      'game_var;overworld_move_no_block;done',
    ], 2);
    expect(await getGameVar(page, 'overworld_move_no_block')).toBe('done');

    await page.goto('/?harness=true&level=DEBUG&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 5);
    await configureOverworldEventRuntime(page);
    await installAndRunEvent(page, 'test_overworld_reveal_blocking', [
      'reveal_overworld_node;NodeB',
      'game_var;overworld_reveal_blocking;done',
    ], 2);
    expect(await getGameVar(page, 'overworld_reveal_blocking')).toBeUndefined();
    await stepFrames(page, 40);
    expect(await getGameVar(page, 'overworld_reveal_blocking')).toBe('done');

    await page.goto('/?harness=true&level=DEBUG&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 5);
    await configureOverworldEventRuntime(page);
    await installAndRunEvent(page, 'test_overworld_reveal_immediate', [
      'reveal_overworld_node;NodeB;immediate',
      'game_var;overworld_reveal_immediate;done',
    ], 2);
    expect(await getGameVar(page, 'overworld_reveal_immediate')).toBe('done');

  });

  test('overworld reveals and movement undo and redo through actions', async ({ page }) => {
    await page.evaluate(() => (window as any).__gameRef.actionLog.clear());
    await installAndRunEvent(page, 'test_overworld_reveal_action', [
      'reveal_overworld_node;NodeB;immediate',
    ], 3);
    const reveal = await page.evaluate(() => {
      const game = (window as any).__gameRef;
      const action = game.actionLog.undo();
      const undone = !game.overworldController.enabledNodes.has('NodeB');
      action?.execute();
      const redone = game.overworldController.enabledNodes.has('NodeB');
      action?.reverse();
      return { undone, redone, actionName: action?.constructor?.name ?? null };
    });
    expect(reveal).toEqual({
      undone: true,
      redone: true,
      actionName: 'EnableOverworldElementAction',
    });

    await page.evaluate(() => (window as any).__gameRef.actionLog.clear());
    await installAndRunEvent(page, 'test_overworld_move_action', [
      'overworld_move_unit;TestParty;NodeB',
    ], 3);
    await stepFrames(page, 40);
    const movement = await page.evaluate(() => {
      const game = (window as any).__gameRef;
      const entity = game.overworldController.entities.get('TestParty');
      const changed = entity.onNode;
      const action = game.actionLog.undo();
      const undone = entity.onNode;
      action?.execute();
      const redone = entity.onNode;
      action?.reverse();
      return { changed, undone, redone, actionName: action?.constructor?.name ?? null };
    });
    expect(movement).toEqual({
      changed: 'NodeB',
      undone: 'NodeA',
      redone: 'NodeB',
      actionName: 'MoveOverworldEntityAction',
    });

    await page.evaluate(() => (window as any).__gameRef.actionLog.clear());
    await installAndRunEvent(page, 'test_overworld_data_actions', [
      'reveal_overworld_road;NodeA;NodeB;immediate',
      'set_overworld_menu_option_enabled;NodeA;TestOption;False',
      'set_overworld_menu_option_visible;NodeA;TestOption;False',
      'create_overworld_entity;TestCreated;Eirika;player',
      'create_overworld_entity;TestCreated;;;delete',
      'disable_overworld_entity;TestParty;no_animate',
    ], 8);
    const data = await page.evaluate(() => {
      const game = (window as any).__gameRef;
      const ow = game.overworldController;
      const snapshot = () => ({
        road: ow.enabledRoads.has('NodeA-NodeB'),
        enabled: ow.enabledMenuOptions.get('NodeA').get('TestOption'),
        visible: ow.visibleMenuOptions.get('NodeA').get('TestOption'),
        created: ow.entities.has('TestCreated'),
        partyNode: ow.entities.get('TestParty').onNode,
        partyPosition: ow.entities.get('TestParty').displayPosition,
      });
      const changed = snapshot();
      const actions = Array.from({ length: 6 }, () => game.actionLog.undo());
      const undone = snapshot();
      for (const action of [...actions].reverse()) action?.execute();
      const redone = snapshot();
      for (const action of actions) action?.reverse();
      return {
        changed,
        undone,
        redone,
        actionNames: actions.map((action: any) => action?.constructor?.name ?? null),
      };
    });
    expect(data.changed).toEqual({
      road: true,
      enabled: false,
      visible: false,
      created: false,
      partyNode: null,
      partyPosition: null,
    });
    expect(data.undone).toEqual({
      road: false,
      enabled: true,
      visible: true,
      created: false,
      partyNode: 'NodeA',
      partyPosition: [0, 0],
    });
    expect(data.redone).toEqual(data.changed);
    expect(data.actionNames).toEqual([
      'DisableOverworldEntityAction',
      'RemoveOverworldEntityAction',
      'CreateOverworldEntityAction',
      'SetOverworldMenuOptionAction',
      'SetOverworldMenuOptionAction',
      'EnableOverworldElementAction',
    ]);
  });
});
