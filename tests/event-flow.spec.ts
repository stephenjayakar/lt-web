/**
 * Audit coverage for EVNT/PYEV1 nested flow control (docs/parity/
 * runtime-inventory.md §1 P1 row: "Audit all trigger payloads and EVNT/PYEV1
 * parity, including nested flow control").
 *
 * Strategy: inject a test event prefab directly into `game.db.events` and
 * queue it via `game.eventManager.triggerSpecific()` (bypasses condition
 * matching so we can exercise the flow-control interpreter directly),
 * push the 'event' state, step frames, and assert on `game_vars` set by
 * whichever branch actually executed. Covers both the EVNT command
 * interpreter (src/engine/states/game-states.ts executeCommand) and the
 * PYEV1 python-syntax interpreter (src/events/python-events.ts).
 */

import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';

async function waitForHarness(page: Page): Promise<void> {
  await page.waitForFunction(() => !!(window as any).__harness?.ready, { timeout: 15000 });
}

async function stepFrames(page: Page, count: number, input?: string | null): Promise<void> {
  await page.evaluate(
    ({ count, input }) => (window as any).__harness.stepFrames(count, input ?? null),
    { count, input: input ?? null },
  );
}

async function installAndRunEvent(
  page: Page,
  nid: string,
  source: string[],
  triggerUnitNid?: string,
): Promise<void> {
  await page.evaluate(
    ({ nid, source, triggerUnitNid }) => {
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
      const trig: any = { type: nid };
      if (triggerUnitNid) trig.unit1 = g.units.get(triggerUnitNid);
      g.eventManager.triggerSpecific(nid, trig, true);
      g.state.change('event');
    },
    { nid, source, triggerUnitNid },
  );
  // state.change() only queues; run enough frames to drain the whole script
  // (each 'wait' consumes ~1 frame; give generous headroom for nested blocks).
  await stepFrames(page, 40);
}

async function getGameVar(page: Page, key: string): Promise<any> {
  return page.evaluate((key) => (window as any).__gameRef.gameVars.get(key), key);
}

test.describe('EVNT/PYEV1 nested flow control', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/?harness=true&level=DEBUG&bundle=false');
    await waitForHarness(page);
    await stepFrames(page, 5);
  });

  test('EVNT: 3-deep if/elif/else picks the correct nested branch', async ({ page }) => {
    // level_var/game_var used here as markers: only the executed leaf sets
    // `flow_result`. Structure:
    //   if False
    //     game_var;flow_result;outer_if      (should NOT run)
    //   elif True
    //     if False
    //       game_var;flow_result;mid_if      (should NOT run)
    //     elif False
    //       game_var;flow_result;mid_elif    (should NOT run)
    //     else
    //       if True
    //         game_var;flow_result;inner_if_true   (SHOULD run)
    //       else
    //         game_var;flow_result;inner_else       (should NOT run)
    //       end
    //     end
    //   else
    //     game_var;flow_result;outer_else    (should NOT run)
    //   end
    //   wait;1
    await installAndRunEvent(page, 'TestFlow3Deep', [
      'if;False',
      'game_var;flow_result;outer_if',
      'elif;True',
      'if;False',
      'game_var;flow_result;mid_if',
      'elif;False',
      'game_var;flow_result;mid_elif',
      'else',
      'if;True',
      'game_var;flow_result;inner_if_true',
      'else',
      'game_var;flow_result;inner_else',
      'end',
      'end',
      'else',
      'game_var;flow_result;outer_else',
      'end',
      'wait;1',
    ]);

    expect(await getGameVar(page, 'flow_result')).toBe('inner_if_true');
  });

  test('EVNT: typed variables resolve inside nested eval substitutions', async ({ page }) => {
    await installAndRunEvent(page, 'TestNestedEvalVariables', [
      "level_var;choices;['North', 'South']",
      'level_var;choice_index;1',
      'game_var;nested_choice;{eval:{v:choices}[{v:choice_index}]}',
      "game_var;joined_position;{eval:','.join([str(unit.position[0]), str(unit.position[1])])}",
    ], 'Eirika');

    const result = await page.evaluate(() => {
      const game = (window as any).__gameRef;
      return {
        choices: game.levelVars.get('choices'),
        choiceIndex: game.levelVars.get('choice_index'),
        nestedChoice: game.gameVars.get('nested_choice'),
        joinedPosition: game.gameVars.get('joined_position'),
        position: game.units.get('Eirika').position.join(','),
      };
    });
    expect(result).toEqual({
      choices: ['North', 'South'],
      choiceIndex: 1,
      nestedChoice: 'South',
      joinedPosition: result.position,
      position: result.position,
    });
  });

  test('EVNT: game random expressions are deterministic and turnwheel-reversible', async ({ page }) => {
    await installAndRunEvent(page, 'TestOtherRandomFirst', [
      'level_var;random_roll;game.get_random(4, 9)',
    ]);
    const first = await page.evaluate(() => {
      const game = (window as any).__gameRef;
      return {
        value: game.levelVars.get('random_roll'),
        seed: game.gameVars.get('_other_random_seed'),
        state: game.gameVars.get('_other_random_state'),
      };
    });
    expect(first.value).toBeGreaterThanOrEqual(4);
    expect(first.value).toBeLessThanOrEqual(9);

    const undone = await page.evaluate(() => {
      const game = (window as any).__gameRef;
      const actions = [
        game.actionLog.undo(),
        game.actionLog.undo(),
        game.actionLog.undo(),
      ];
      return {
        actionNames: actions.map((action: any) => action?.constructor?.name ?? null),
        hasValue: game.levelVars.has('random_roll'),
        hasSeed: game.gameVars.has('_other_random_seed'),
        hasState: game.gameVars.has('_other_random_state'),
      };
    });
    expect(undone).toEqual({
      actionNames: ['SetLevelVarAction', 'SetGameVarAction', 'SetGameVarAction'],
      hasValue: false,
      hasSeed: false,
      hasState: false,
    });

    await installAndRunEvent(page, 'TestOtherRandomSecond', [
      'level_var;random_roll;game.get_random(4, 9)',
    ]);
    expect(await page.evaluate(() =>
      (window as any).__gameRef.levelVars.get('random_roll'))).toBe(first.value);
  });

  test('EVNT: elif chain evaluates unit-field conditions and only one branch fires', async ({ page }) => {
    // Discover Eirika's actual level from the loaded fixture rather than
    // assuming a value, then assert the elif branch matching her exact
    // level (not the `> level` branch or the fallthrough else) fires.
    const eirikaLevel: number = await page.evaluate(
      () => (window as any).__gameRef.units.get('Eirika').level,
    );
    await installAndRunEvent(page, 'TestFlowUnitCond', [
      `if;unit1.level > ${eirikaLevel}`,
      'game_var;flow_unit;too_high',
      `elif;unit1.level == ${eirikaLevel}`,
      'game_var;flow_unit;matched_level',
      'else',
      'game_var;flow_unit;fallthrough',
      'end',
      'wait;1',
    ], 'Eirika');

    expect(await getGameVar(page, 'flow_unit')).toBe('matched_level');
  });

  test('EVNT: `finish` inside a nested if performs an early exit, skipping later commands', async ({ page }) => {
    await installAndRunEvent(page, 'TestFlowEarlyExit', [
      'game_var;flow_stage;started',
      'if;True',
      'game_var;flow_stage;entered_if',
      'finish',
      'game_var;flow_stage;unreachable_in_if',
      'end',
      'game_var;flow_stage;unreachable_after_if',
    ]);

    expect(await getGameVar(page, 'flow_stage')).toBe('entered_if');
  });

  test('EVNT: for loop iterates every value and endf returns to loop start on nesting', async ({ page }) => {
    await installAndRunEvent(page, 'TestFlowForLoop', [
      'game_var;flow_count;0',
      'for;i;a,b,c',
      'inc_game_var;flow_count',
      'endf',
      "level_var;loop_source;['a', 'b', 'c', 'd']",
      'game_var;filtered_count;0',
      "for;value;[entry for entry in {v:loop_source} if entry != 'b']",
      'inc_game_var;filtered_count',
      'endf',
      "level_var;rooms;['Combat', 'Shop']",
      'game_var;shadow_result;missed',
      "for;rooms;['Combat']",
      "if;'{rooms}' == 'Combat'",
      'game_var;shadow_result;hit',
      'end',
      'endf',
      'wait;1',
    ]);

    expect(await getGameVar(page, 'flow_count')).toBe(3);
    expect(await getGameVar(page, 'filtered_count')).toBe(3);
    expect(await getGameVar(page, 'shadow_result')).toBe('hit');
  });

  test('PYEV1: 3-deep if/elif/else picks the correct nested branch', async ({ page }) => {
    await installAndRunEvent(page, 'TestPyev1Flow3Deep', [
      '#pyev1',
      'if False:',
      '    $game_var "flow_result_py" "outer_if"',
      'elif True:',
      '    if False:',
      '        $game_var "flow_result_py" "mid_if"',
      '    elif False:',
      '        $game_var "flow_result_py" "mid_elif"',
      '    else:',
      '        if True:',
      '            $game_var "flow_result_py" "inner_if_true"',
      '        else:',
      '            $game_var "flow_result_py" "inner_else"',
      'else:',
      '    $game_var "flow_result_py" "outer_else"',
    ]);

    expect(await getGameVar(page, 'flow_result_py')).toBe('inner_if_true');
  });

  test('PYEV1: for loop over a list visits every element', async ({ page }) => {
    await installAndRunEvent(page, 'TestPyev1ForLoop', [
      '#pyev1',
      '$game_var "flow_count_py" "0"',
      'for x in [1, 2, 3]:',
      '    $inc_game_var "flow_count_py"',
    ]);

    expect(await getGameVar(page, 'flow_count_py')).toBe(3);
  });
});
