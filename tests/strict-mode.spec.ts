import { test, expect, type Page } from '@playwright/test';

/**
 * Strict-mode behavior for unimplemented commands/components (P7).
 *
 * Semantics under test (src/engine/strict-mode.ts):
 * - Default (no ?strict): unknown commands warn once per NID and the event
 *   advances past them (graceful production behavior).
 * - ?strict=true: reportUnimplemented throws, failing loudly.
 * - Project load logs an unknown-component inventory summary, re-runnable in
 *   harness mode via window.__logUnknownComponents().
 */

async function waitForHarness(page: Page): Promise<void> {
  await page.waitForFunction(() => (window as any).__harness?.ready === true, undefined, {
    timeout: 30_000,
  });
}

async function stepFrames(page: Page, n: number, input?: string): Promise<void> {
  await page.evaluate(
    ({ n, input }) => (window as any).__harness.stepFrames(n, input),
    { n, input },
  );
}

/** Install and run a level-scoped event whose script contains an unknown command. */
async function installAndRunBogusEvent(page: Page, nid: string): Promise<void> {
  await page.evaluate((nid: string) => {
    const g = (window as any).__gameRef;
    g.db.events.set(nid, {
      name: nid,
      nid,
      trigger: nid,
      level_nid: g.currentLevel?.nid ?? null,
      condition: 'True',
      only_once: false,
      priority: 0,
      _source: [
        'game_var;before_bogus;yes',
        'totally_bogus_command;arg1',
        'game_var;after_bogus;yes',
      ],
    });
    g.eventManager.triggerSpecific(nid, { type: nid }, true);
    g.state.change('event');
  }, nid);
  await stepFrames(page, 40);
}

test.describe('Strict mode (unimplemented command/component reporting)', () => {
  test('default mode: unknown command warns once and the event advances past it', async ({ page }) => {
    const warns: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'warning' && msg.text().includes('Unimplemented')) warns.push(msg.text());
    });
    await page.goto('/?harness=true&level=0&clean=true&bundle=false');
    await waitForHarness(page);

    await installAndRunBogusEvent(page, 'TestBogusLoose');
    // Run the same unknown command in a second event to prove per-NID dedupe.
    await installAndRunBogusEvent(page, 'TestBogusLoose2');

    const vars = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      return {
        before: g.gameVars.get('before_bogus'),
        after: g.gameVars.get('after_bogus'),
      };
    });
    // Event advanced past the bogus command and executed the command after it.
    expect(vars.before).toBe('yes');
    expect(vars.after).toBe('yes');
    // Warned exactly once for the unique NID despite two executions.
    const bogusWarns = warns.filter((w) => w.includes('totally_bogus_command'));
    expect(bogusWarns.length).toBe(1);
  });

  test('?strict=true: unknown command fails loudly instead of advancing', async ({ page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(String(err)));
    const errorLogs: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') errorLogs.push(msg.text());
    });
    await page.goto('/?harness=true&strict=true&level=0&clean=true&bundle=false');
    await waitForHarness(page);

    // In strict mode the throw fires synchronously during event parsing,
    // so the injection evaluate itself rejects — that IS the loud failure.
    let thrown = '';
    try {
      await installAndRunBogusEvent(page, 'TestBogusStrict');
    } catch (err) {
      thrown = String(err);
    }
    const after = await page.evaluate(
      () => (window as any).__gameRef.gameVars.get('after_bogus'),
    );
    const loud =
      thrown.includes('totally_bogus_command') ||
      [...pageErrors, ...errorLogs].some((e) => e.includes('totally_bogus_command'));
    // The command after the bogus one must NOT have run, and the failure is loud.
    expect(after).toBeUndefined();
    expect(loud).toBe(true);
  });

  test('component inventory scan reports a synthetic bogus component', async ({ page }) => {
    const logs: string[] = [];
    page.on('console', (msg) => logs.push(msg.text()));
    await page.goto('/?harness=true&level=0&clean=true&bundle=false');
    await waitForHarness(page);

    await page.evaluate(() => {
      const g = (window as any).__gameRef;
      g.db.items.set('BogusItem', {
        nid: 'BogusItem',
        components: new Map([['definitely_not_a_component', true]]),
      });
      (window as any).__logUnknownComponents();
    });

    const reported = logs.some((l) => l.includes('definitely_not_a_component'));
    expect(reported).toBe(true);
  });
});
