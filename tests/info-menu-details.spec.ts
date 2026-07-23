import { test, expect } from '@playwright/test';

test.describe('unit info growth, support, and WEXP detail', () => {
  test('shows a safe fourth page and exposes rank progress data', async ({ page }, testInfo) => {
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

    const skillPage = await page.evaluate(() => {
      const state = (window as any).__gameRef.state.getCurrentState() as any;
      state.takeInput('RIGHT');
      state.takeInput('RIGHT');
      return state.currentPage;
    });
    expect(skillPage).toBe(2);
    await page.evaluate(() => (window as any).__harness.stepFrames(2, null));
    await page.locator('canvas').screenshot({ path: testInfo.outputPath('info-wexp.png') });

    const growthPage = await page.evaluate(() => {
      const state = (window as any).__gameRef.state.getCurrentState() as any;
      state.takeInput('RIGHT');
      return state.currentPage;
    });
    expect(growthPage).toBe(3);
    await page.evaluate(() => (window as any).__harness.stepFrames(2, null));
    await page.locator('canvas').screenshot({ path: testInfo.outputPath('info-growth-supports.png') });
  });
});
