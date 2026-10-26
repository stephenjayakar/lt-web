import { test, expect } from '@playwright/test';

test.describe('unit info growth, support, and WEXP detail', () => {
  test('pages follow Python info_states and AUX toggles growths', async ({ page }, testInfo) => {
    await page.goto('/?harness=true&level=0&clean=true&bundle=false');
    await page.waitForFunction(() => !!(window as any).__harness?.ready, { timeout: 15000 });
    const setup = await page.evaluate(() => {
      const game = (window as any).__gameRef;
      const unit = game.units.get('Eirika');
      const partner = game.units.get('Seth');
      const pair = game.supports?.getPair(unit.nid, partner.nid);
      game.gameVars.set('_supports', true);
      if (pair && pair.unlockedRanks.length === 0) pair.unlockedRanks.push('C');
      unit.wexp.Sword = 45;
      unit.growthPoints.STR = 3.5;
      game.infoMenuUnit = unit;
      game.state.change('info_menu');
      return {
        pairs: game.supports?.getPairsForUnit(unit.nid).length ?? 0,
      };
    });
    await page.evaluate(() => (window as any).__harness.stepFrames(4, null));
    expect(setup.pairs).toBeGreaterThan(0);

    const input = async (event: string): Promise<number> => {
      await page.evaluate((e) => (window as any).__gameRef.state.getCurrentState().takeInput(e), event);
      // Let the page slide transition finish before the next input.
      await page.evaluate(() => (window as any).__harness.stepFrames(16, null));
      return page.evaluate(() => (window as any).__gameRef.state.getCurrentState().currentPage);
    };

    // AUX on personal data swaps in the growth view (Python growth_flag).
    expect(await input('AUX')).toBe(0);
    await page.locator('canvas').screenshot({ path: testInfo.outputPath('info-growths.png') });

    expect(await input('RIGHT')).toBe(1);
    expect(await input('RIGHT')).toBe(2);
    await page.locator('canvas').screenshot({ path: testInfo.outputPath('info-wexp-supports.png') });
    // Without unit notes the fourth 'notes' page is skipped and RIGHT wraps.
    expect(await input('RIGHT')).toBe(0);
  });
});
