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
    timeout: 60_000,
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

  test('?strict=true: unsupported expressions throw instead of returning false', async ({ page }) => {
    await page.goto('/?harness=true&strict=true&level=0&clean=true&bundle=false');
    await waitForHarness(page);

    let thrown = '';
    try {
      await page.evaluate(async () => {
        const { evaluateCondition } = await import('/src/events/event-manager.ts');
        const g = (window as any).__gameRef;
        evaluateCondition('totally_missing_namespace.call()', {
          game: g,
          gameVars: g.gameVars,
          levelVars: g.levelVars,
        });
      });
    } catch (error) {
      thrown = String(error);
    }
    expect(thrown).toContain('Unimplemented expression');
    expect(thrown).toContain('totally_missing_namespace.call()');
  });

  test('event command exceptions emit a reproducible execution trace', async ({ page }) => {
    const traces: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error' && message.text().startsWith('[EventTrace] ')) {
        traces.push(message.text());
      }
    });
    await page.goto('/?harness=true&level=0&clean=true&bundle=false');
    await waitForHarness(page);
    await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const unit = g.units.get('Eirika');
      g.selectedUnit = unit;
      g.db.events.set('TraceFailure', {
        name: 'TraceFailure', nid: 'TraceFailure', trigger: 'TraceFailure',
        level_nid: g.currentLevel?.nid ?? null,
        condition: 'True', only_once: false, priority: 0,
        _source: ['game_var;trace_should_not_run;yes'],
      });
      g.eventManager.triggerSpecific('TraceFailure', {
        type: 'TraceFailure',
        unitNid: unit.nid,
        unit1: unit,
        position: unit.position,
        localArgs: new Map([['mode', 'attack']]),
      }, true);
      g.state.change('event');
    });
    await stepFrames(page, 1);
    await page.evaluate(() => {
      const state = (window as any).__gameRef.state.getCurrentState() as any;
      state.executeCommand = () => {
        throw new Error('synthetic trace failure');
      };
    });
    try {
      await stepFrames(page, 1);
    } catch {
      // The command error is intentionally rethrown after the trace is logged.
    }

    expect(traces).toHaveLength(1);
    const trace = JSON.parse(traces[0].slice('[EventTrace] '.length));
    expect(trace).toMatchObject({
      eventId: 'TraceFailure',
      commandIndex: 0,
      command: { type: 'game_var', args: ['trace_should_not_run', 'yes'] },
      trigger: {
        type: 'TraceFailure',
        unitNid: 'Eirika',
        localArgs: { mode: 'attack' },
      },
      activeUnit: 'Eirika',
    });
    expect(trace.stateStack[0]).toBe('free');
    expect(trace.stateStack.at(-1)).toBe('event');
  });

  test('Rekka component inventory rejects a synthetic unsupported component', async ({ page }) => {
    const logs: string[] = [];
    page.on('console', (msg) => logs.push(msg.text()));
    await page.goto('/?harness=true&project=rekka.ltproj&level=0&clean=true&bundle=false&strict=true');
    await waitForHarness(page);

    const error = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      g.db.items.set('BogusItem', {
        nid: 'BogusItem',
        components: new Map([['definitely_not_a_component', true]]),
      });
      try {
        (window as any).__logUnknownComponents();
        return null;
      } catch (caught) {
        return String(caught);
      }
    });

    expect(error).toContain('Unimplemented item-component');
    const reported = logs.some((l) => l.includes('definitely_not_a_component'));
    expect(reported).toBe(true);
  });
});
