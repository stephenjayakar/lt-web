import { test, expect } from '@playwright/test';

async function step(page: import('@playwright/test').Page, count = 3): Promise<void> {
  await page.evaluate((frames) => (window as any).__harness.stepFrames(frames, null), count);
}

test.describe('objective and dialog-log UI', () => {
  test('renders both flows, scrolls, closes, and serializes cleaned dialog', async ({ page }, testInfo) => {
    await page.goto('/?harness=true&level=0&clean=true&bundle=false&controls=true');
    await page.waitForFunction(() => !!(window as any).__harness?.ready, { timeout: 15000 });
    await page.evaluate(() => {
      const game = (window as any).__gameRef;
      game.currentLevel.objective.win = 'Seize the gate, then protect {comma} the village';
      game.currentLevel.objective.loss = 'Eirika falls';
      game.state.change('objective_menu');
    });
    await step(page);
    expect(await page.evaluate(() => (window as any).__gameRef.state.getCurrentState()?.name))
      .toBe('objective_menu');
    await page.locator('canvas').screenshot({ path: testInfo.outputPath('objective-menu.png') });

    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      game.state.getCurrentState()?.takeInput('BACK');
      const { appendDialogLogEntry } =
        await import('/src/engine/states/objective-dialog-states.ts');
      appendDialogLogEntry(game, 'Eirika', 'We move{w} now!|Stay together.');
      appendDialogLogEntry(game, 'Seth', 'Understood, milady.');
      game.state.change('dialog_log');
      return game.dialogLogEntries;
    });
    await step(page);
    expect(result).toEqual([
      { speaker: 'Eirika', text: 'We move now!\nStay together.' },
      { speaker: 'Seth', text: 'Understood, milady.' },
    ]);
    expect(await page.evaluate(() => (window as any).__gameRef.state.getCurrentState()?.name))
      .toBe('dialog_log');
    await page.locator('canvas').screenshot({ path: testInfo.outputPath('dialog-log.png') });

    const saved = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { buildSaveDict } = await import('/src/engine/save.ts');
      const dict = buildSaveDict(game);
      game.state.getCurrentState()?.takeInput('INFO');
      return {
        entries: dict.dialogLogEntries,
        stateBeforePop: game.state.getCurrentState()?.name,
      };
    });
    await step(page);
    expect(saved.entries).toEqual(result);
    expect(await page.evaluate(() => (window as any).__gameRef.state.getCurrentState()?.name))
      .not.toBe('dialog_log');
  });

  test('change_objective stores the evaluable string and re-evaluates it on draw', async ({ page }) => {
    await page.goto('/?harness=true&level=0&clean=true&bundle=false');
    await page.waitForFunction(() => !!(window as any).__harness?.ready, { timeout: 15000 });
    await step(page);
    await page.evaluate(() => {
      const game = (window as any).__gameRef;
      game.levelVars.set('seals', 2);
      game.db.events.set('QaObjective', {
        name: 'QaObjective', nid: 'QaObjective', trigger: 'QaObjective',
        level_nid: game.currentLevel?.nid ?? null, condition: 'True',
        only_once: false, priority: 0,
        _source: [
          'change_objective_simple;Seals: {v:seals}',
          'change_objective_win;Collect {e:v(\'seals\') + 1} seals',
        ],
      });
      game.eventManager.triggerSpecific('QaObjective', { type: 'QaObjective' }, true);
      game.state.change('event');
    });
    await step(page, 20);
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { evaluateText } = await import('/src/ui/hud.ts');
      const stored = { ...game.currentLevel.objective };
      const before = evaluateText(stored.simple, game);
      // Python ui_view.create_obj_info evaluates the stored string per draw.
      game.levelVars.set('seals', 5);
      const after = evaluateText(game.currentLevel.objective.simple, game);
      game.state.change('objective_menu');
      return { stored, before, after };
    });
    await step(page);
    const menuOptions = await page.evaluate(() =>
      (window as any).__gameRef.state.getCurrentState()?.options);
    expect(result.stored.simple).toBe('Seals: {v:seals}');
    expect(result.stored.win).toBe("Collect {e:v('seals') + 1} seals");
    expect(result.before).toBe('Seals: 2');
    expect(result.after).toBe('Seals: 5');
    expect(menuOptions).toContain('Collect 6 seals');
  });
});
