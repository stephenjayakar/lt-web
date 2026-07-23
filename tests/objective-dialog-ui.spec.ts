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
});
