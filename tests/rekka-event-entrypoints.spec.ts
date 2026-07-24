import { expect, test } from '@playwright/test';

test('all 899 Rekka events construct through their direct entrypoint', async ({ page }) => {
  await page.goto('/?harness=true&project=rekka.ltproj&level=0&clean=true&bundle=false&strict=true');
  await page.waitForFunction(() => (window as any).__harness?.ready === true, {
    timeout: 30_000,
  });

  const coverage = await page.evaluate(() => {
    const game = (window as any).__gameRef;
    const manager = game.eventManager as any;
    const prefabs = [...game.db.events.values()] as any[];
    const originalActionLog = manager.actionLog;
    const originalConsoleLog = console.log;
    const failures: string[] = [];
    let queued = 0;
    let empty = 0;
    let parsedCommands = 0;

    // This is a construction/dispatch inventory, not a campaign mutation run.
    // Isolate each entrypoint from only-once actions and the prior event queue.
    manager.actionLog = null;
    console.log = () => {};
    try {
      for (const prefab of prefabs) {
        manager.eventQueue.length = 0;
        manager.restoreOnceTriggered([]);
        try {
          const fired = manager.triggerSpecific(prefab.nid, {
            type: prefab.trigger ?? 'direct_entrypoint_audit',
            levelNid: prefab.level_nid ?? game.currentLevel?.nid,
            unit1: game.units.get('Lyn'),
            unit2: game.units.get('Batta'),
            position: [0, 0],
            localArgs: new Map(),
          }, true);
          const event = manager.getCurrentEvent() as any;
          const hasExecutableSource = (prefab._source ?? []).some((line: string) => {
            const trimmed = line.trim();
            return trimmed.length > 0 && !trimmed.startsWith('#');
          });
          if (hasExecutableSource) {
            if (!fired || event?.nid !== prefab.nid) {
              failures.push(`${prefab.nid}: executable source did not queue`);
            } else {
              queued += 1;
              parsedCommands += event.commands?.length ?? 0;
            }
          } else if (fired) {
            failures.push(`${prefab.nid}: empty source unexpectedly queued`);
          } else {
            empty += 1;
          }
        } catch (error) {
          failures.push(`${prefab.nid}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    } finally {
      console.log = originalConsoleLog;
      manager.actionLog = originalActionLog;
      manager.eventQueue.length = 0;
      manager.restoreOnceTriggered([]);
    }

    return {
      total: prefabs.length,
      uniqueNids: new Set(prefabs.map((prefab) => prefab.nid)).size,
      queued,
      empty,
      parsedCommands,
      failures,
    };
  });

  expect(coverage.total).toBe(899);
  expect(coverage.uniqueNids).toBe(899);
  expect(coverage.queued).toBe(889);
  expect(coverage.empty).toBe(10);
  expect(coverage.parsedCommands).toBeGreaterThan(3_900);
  expect(coverage.failures, coverage.failures.join('\n')).toEqual([]);
});
