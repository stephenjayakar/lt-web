/**
 * Parity tests for the `create_unit` and `set_position` event commands
 * (docs/parity: previously parser-recognized-but-dispatchless / unrecognized).
 *
 * Usage-scan note: a grep of every bundled project's event files
 * (lt-maker/*.ltproj/game_data/events/**) found ZERO live executions of any
 * of the 45 audit-flagged missing commands, and the only near-hits
 * (`trigger_script`, `say`) turned out to be either commented out (`#trigger_script`)
 * or false-positive substring matches inside dialogue text. Per the task's
 * fallback rule ("if fewer have any usage, implement ... the highest-value
 * zero-usage ones"), this slice implements `create_unit` — explicitly called
 * out as high value since it was parser-recognized but had no EventState
 * case, so any project event using it silently no-op'd — plus `set_position`,
 * which is small, self-contained, and has a real consumer ({e:position}).
 *
 * Covers:
 *  - create_unit: parser dispatch, auto-nid + {created_unit}, explicit nid,
 *    copy_stats, placement on the map, turnwheel undo (full un-creation),
 *    and save/load round trip.
 *  - set_position: overrides {e:position} for the rest of the event.
 */

import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';

async function waitForHarness(page: Page): Promise<void> {
  await page.waitForFunction(() => !!(window as any).__harness?.ready, { timeout: 15000 });
}

async function stepFrames(page: Page, count: number): Promise<void> {
  await page.evaluate((count) => (window as any).__harness.stepFrames(count, null), count);
}

async function settle(page: Page, maxFrames = 300): Promise<void> {
  await page.evaluate((maxFrames) => (window as any).__harness.settle(maxFrames), maxFrames);
}

async function turnwheelUndo(page: Page): Promise<boolean> {
  return page.evaluate(() => (window as any).__harness.turnwheelUndo());
}

async function pushEvent(page: Page, nid: string, source: string[]): Promise<number> {
  return page.evaluate(
    async ({ nid, source }) => {
      const g = (window as any).__gameRef;
      const { GameEvent } = await import('/src/events/event-manager.ts');
      const prefab = {
        nid,
        name: nid,
        trigger: 'test',
        level_nid: g.currentLevel?.nid ?? '0',
        condition: '',
        only_once: false,
        priority: 0,
        _source: source,
      };
      const event = new GameEvent(prefab, { type: 'test', levelNid: g.currentLevel?.nid ?? '0' });
      g.eventManager.eventQueue.push(event);
      g.state.change('event');
      return event.commands.length;
    },
    { nid, source },
  );
}

test.describe('create_unit / set_position event commands', () => {
  test('parser recognizes both commands', async ({ page }) => {
    await page.goto('/?harness=true&level=0&clean=true&bundle=false');
    await waitForHarness(page);

    const parsedTypes = await page.evaluate(async () => {
      const { GameEvent } = await import('/src/events/event-manager.ts');
      return [
        "create_unit;Eirika;NewEirika;;5,5",
        'set_position;5,5',
      ].map((line) => GameEvent.parseCommand(line)?.type ?? null);
    });

    expect(parsedTypes).toEqual(['create_unit', 'set_position']);
  });

  test('create_unit with an explicit nid places a copy on the map', async ({ page }) => {
    await page.goto('/?harness=true&level=0&clean=true&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 5);

    const before = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      return { hasUnit: g.units.has('EirikaClone1'), actionIndex: g.actionLog.actionIndex };
    });
    expect(before.hasUnit).toBe(false);

    await pushEvent(page, '_test_create_unit_1', [
      'create_unit;Eirika;EirikaClone1;;6,6;fade;giveup;copy_stats',
    ]);
    await stepFrames(page, 5);
    await settle(page);

    const after = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const unit = g.units.get('EirikaClone1');
      const template = g.units.get('Eirika');
      return {
        exists: !!unit,
        position: unit?.position ?? null,
        onBoard: g.board?.getUnit?.(6, 6)?.nid ?? null,
        klass: unit?.klass ?? null,
        templateKlass: template?.klass ?? null,
        statsMatchTemplate: unit && template ? JSON.stringify(unit.stats) === JSON.stringify(template.stats) : false,
      };
    });

    expect(after.exists).toBe(true);
    expect(after.position).toEqual([6, 6]);
    expect(after.onBoard).toBe('EirikaClone1');
    expect(after.klass).toBe(after.templateKlass);
    expect(after.statsMatchTemplate).toBe(true);
  });

  test('create_unit with a blank nid auto-assigns and sets {created_unit}', async ({ page }) => {
    await page.goto('/?harness=true&level=0&clean=true&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 5);

    await pushEvent(page, '_test_create_unit_2', [
      'create_unit;Eirika;;;',
      'game_var;created_unit_nid;{eval:created_unit}',
    ]);
    await stepFrames(page, 5);
    await settle(page);

    const result = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const createdNid = g.gameVars.get('created_unit_nid');
      const created = createdNid ? g.units.get(createdNid) : null;
      return { createdNid, created: created ? { nid: created.nid, position: created.position } : null };
    });

    // {eval:created_unit} must resolve to the auto-assigned nid (a numeric
    // string >= 201, mirroring Python's str_utils.get_next_int('201', ...)).
    expect(result.createdNid).toMatch(/^\d+$/);
    expect(Number(result.createdNid)).toBeGreaterThanOrEqual(201);
    expect(result.created).not.toBeNull();
    // Off-map since no Position was given.
    expect(result.created!.position).toBeNull();
  });

  test('create_unit without a target position stays off-map', async ({ page }) => {
    await page.goto('/?harness=true&level=0&clean=true&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 5);

    await pushEvent(page, '_test_create_unit_3', [
      'create_unit;Eirika;EirikaOffMap;;',
    ]);
    await stepFrames(page, 5);
    await settle(page);

    const result = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const unit = g.units.get('EirikaOffMap');
      return { exists: !!unit, position: unit ? (unit.position ?? null) : 'missing' };
    });

    expect(result.exists).toBe(true);
    expect(result.position).toBeNull();
  });

  test('create_unit is fully reversed by turnwheel undo', async ({ page }) => {
    await page.goto('/?harness=true&level=0&clean=true&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 5);

    await pushEvent(page, '_test_create_unit_undo', [
      'create_unit;Eirika;EirikaUndoMe;;7,7',
    ]);
    await stepFrames(page, 5);
    await settle(page);

    const createdCheck = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      return {
        exists: g.units.has('EirikaUndoMe'),
        onBoard: g.board?.getUnit?.(7, 7)?.nid ?? null,
      };
    });
    expect(createdCheck.exists).toBe(true);
    expect(createdCheck.onBoard).toBe('EirikaUndoMe');

    const undone = await turnwheelUndo(page);
    expect(undone).toBe(true);

    const afterUndo = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      return {
        exists: g.units.has('EirikaUndoMe'),
        onBoard: g.board?.getUnit?.(7, 7)?.nid ?? null,
      };
    });
    expect(afterUndo.exists).toBe(false);
    expect(afterUndo.onBoard).toBeNull();
  });

  test('create_unit survives a save/load round trip', async ({ page }) => {
    await page.goto('/?harness=true&level=0&clean=true&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 5);

    await pushEvent(page, '_test_create_unit_save', [
      'create_unit;Eirika;EirikaSaved;;8,8',
    ]);
    await stepFrames(page, 5);
    await settle(page);

    const roundTrip = await page.evaluate(async () => {
      const g = (window as any).__gameRef;
      const { saveGame, loadGame, deleteSave } = await import('/src/engine/save.ts');
      const gameNid = g.db.getConstant('game_nid', 'default');
      await saveGame(g, 98, 'battle');
      g.units.delete('EirikaSaved');
      const loaded = await loadGame(g, 98);
      const exists = g.units.has('EirikaSaved');
      const position = g.units.get('EirikaSaved')?.position ?? null;
      await deleteSave(gameNid, 98);
      return { loaded, exists, position };
    });

    expect(roundTrip).toEqual({ loaded: true, exists: true, position: [8, 8] });
  });

  test('set_position overrides {e:position} for the rest of the event', async ({ page }) => {
    await page.goto('/?harness=true&level=0&clean=true&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 5);

    await pushEvent(page, '_test_set_position', [
      'set_position;9,3',
      'game_var;captured_position;{eval:position}',
    ]);
    await stepFrames(page, 5);
    await settle(page);

    const result = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      return g.gameVars.get('captured_position');
    });

    // {eval:position} stringifies the [x, y] tuple resolved from ctx.position.
    expect(String(result)).toContain('9');
    expect(String(result)).toContain('3');
  });
});
