import { test, expect } from '@playwright/test';

test.describe('resource-backed unit art', () => {
  test('loads map sprites and uses them when an optional portrait is absent', async ({ page }, testInfo) => {
    await page.goto('/?harness=true&level=0&clean=true&bundle=false');
    await page.waitForFunction(() => !!(window as any).__harness?.ready, { timeout: 15000 });
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      await game.loadAllMapSprites();
      const missing = [...game.units.values()]
        .filter((unit: any) => unit.position)
        .filter((unit: any) => game.db.classes.get(unit.klass)?.map_sprite_nid)
        .filter((unit: any) => !unit.sprite)
        .map((unit: any) => unit.nid);
      const unit = game.units.get('Eirika');
      const oldPortrait = unit.portraitNid;
      unit.portraitNid = '';
      game.infoMenuUnit = unit;
      game.state.change('info_menu');
      return { missing, oldPortrait };
    });
    await page.evaluate(() => (window as any).__harness.stepFrames(4, null));
    expect(result.missing).toEqual([]);
    await page.locator('canvas').screenshot({ path: testInfo.outputPath('map-sprite-portrait-fallback.png') });
    await page.evaluate((portrait) => {
      (window as any).__gameRef.infoMenuUnit.portraitNid = portrait;
    }, result.oldPortrait);
  });
});
