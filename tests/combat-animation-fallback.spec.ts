import { test, expect } from '@playwright/test';

test.describe('combat animation asset fallback', () => {
  test('uses team-paletted map sprites instead of debug blocks', async ({ page }, testInfo) => {
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

    for (let index = 0; index < 60; index++) {
      await page.evaluate(() => (window as any).__harness.stepFrames(2, null));
      const ready = await page.evaluate(() => {
        const state = (window as any).__gameRef.state.getCurrentState() as any;
        return state?.name === 'combat' && !!state.animCombat?.getRenderState?.().leftDraw?.mainFrame;
      });
      if (ready) break;
    }

    const fallback = await page.evaluate(() => {
      const state = (window as any).__gameRef.state.getCurrentState() as any;
      const combat = state?.animCombat;
      if (!combat) return null;
      combat.leftAnim.frameImages.clear();
      combat.rightAnim.frameImages.clear();
      combat.state = 'entrance';
      combat.stateTimer = 700;
      combat.leftAnim.opacity = 255;
      combat.rightAnim.opacity = 255;
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
    await page.locator('canvas').screenshot({ path: testInfo.outputPath('combat-map-sprite-fallback.png') });
  });
});
