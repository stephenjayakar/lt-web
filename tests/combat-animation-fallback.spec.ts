import { test, expect } from '@playwright/test';

test.describe('combat animation asset fallback', () => {
  test('uses team-paletted map sprites instead of debug blocks', async ({ page }) => {
    await page.goto('/?harness=true&level=0&clean=true&bundle=false');
    await page.waitForFunction(() => !!(window as any).__harness?.ready, { timeout: 15000 });
    const started = await page.evaluate(() => {
      const game = (window as any).__gameRef;
      const attacker = game.units.get('Eirika');
      const defender = [...game.units.values()].find((unit: any) =>
        unit.team === 'enemy' && unit.position && !unit.isDead());
      if (!attacker?.position || !defender) return false;
      game.board.moveUnit(defender, attacker.position[0], attacker.position[1] - 1);
      game.selectedUnit = attacker;
      game.combatTarget = defender;
      game.state.change('combat');
      return true;
    });
    expect(started).toBe(true);

    // Drive the real flow (red_cursor -> fade_in -> entrance) until the
    // scene has settled into init_pause with both spritesheets loaded.
    let resourced: { leftMain: boolean; rightMain: boolean } | null = null;
    for (let index = 0; index < 120 && !resourced; index++) {
      await page.evaluate(() => (window as any).__harness.stepFrames(2, null));
      resourced = await page.evaluate(() => {
        const state = (window as any).__gameRef.state.getCurrentState() as any;
        const combat = state?.name === 'combat' ? state.animCombat : null;
        if (!combat || combat.state !== 'init_pause') return null;
        const render = combat.getRenderState();
        return { leftMain: !!render.leftDraw.mainFrame, rightMain: !!render.rightDraw.mainFrame };
      });
      if (!resourced) await page.waitForTimeout(10);
    }
    expect(resourced).toEqual({ leftMain: true, rightMain: true });
    await page.evaluate(() => (window as any).__harness.stepFrames(1, null));

    const canvas = page.locator('canvas');
    await expect(canvas).toHaveScreenshot('combat-animation-resourced.png', {
      maxDiffPixelRatio: 0.01,
    });

    const fallback = await page.evaluate(() => {
      const state = (window as any).__gameRef.state.getCurrentState() as any;
      const combat = state?.animCombat;
      if (!combat) return null;
      combat.leftAnim.frameImages.clear();
      combat.rightAnim.frameImages.clear();
      const render = combat.getRenderState();
      return {
        leftMain: !!render.leftDraw.mainFrame,
        rightMain: !!render.rightDraw.mainFrame,
        leftMapSprite: !!(combat.leftIsAttacker ? combat.attacker : combat.defender).sprite,
        rightMapSprite: !!(combat.leftIsAttacker ? combat.defender : combat.attacker).sprite,
      };
    });
    expect(fallback).toEqual({
      leftMain: false,
      rightMain: false,
      leftMapSprite: true,
      rightMapSprite: true,
    });
    await page.evaluate(() => (window as any).__harness.stepFrames(1, null));
    await expect(canvas).toHaveScreenshot('combat-animation-map-sprite-fallback.png', {
      maxDiffPixelRatio: 0.01,
    });
  });
});
