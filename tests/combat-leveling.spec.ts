import { test, expect } from '@playwright/test';

test.describe('combat level-up growth modes', () => {
  test('EXP actions use deterministic dynamic growth points and rewind exactly', async ({ page }) => {
    await page.goto('/?harness=true&level=0&clean=true&bundle=false');
    await page.waitForFunction(() => !!(window as any).__harness?.ready, { timeout: 15000 });
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { GainExpAction, setActionGameRef } = await import('/src/engine/action.ts');
      const unit = game.units.get('Eirika');
      setActionGameRef(() => game);
      const before = {
        exp: unit.exp,
        level: unit.level,
        stats: { ...unit.stats },
        growths: { ...unit.growths },
        growthPoints: { ...unit.growthPoints },
        hp: unit.currentHp,
      };
      unit.exp = 99;
      unit.growths = Object.fromEntries(
        Object.keys(unit.growths).map((nid) => [nid, nid === 'STR' ? 50 : 0]),
      );
      unit.growthPoints = Object.fromEntries(
        Object.keys(unit.growths).map((nid) => [nid, 0]),
      );
      game.gameVars.set('_random_seed', 0);
      const action = new GainExpAction(unit, 1, 'dynamic');
      const nativeRandom = Math.random;
      Math.random = () => { throw new Error('legacy random level-up path used'); };
      try {
        game.actionLog.doAction(action);
        const changed = {
          exp: unit.exp,
          level: unit.level,
          stats: { ...unit.stats },
          growthPoints: { ...unit.growthPoints },
          hp: unit.currentHp,
        };
        game.actionLog.runActionBackward();
        const reversed = {
          exp: unit.exp,
          level: unit.level,
          stats: { ...unit.stats },
          growthPoints: { ...unit.growthPoints },
          hp: unit.currentHp,
        };
        game.actionLog.runActionForward();
        const redone = {
          exp: unit.exp,
          level: unit.level,
          stats: { ...unit.stats },
          growthPoints: { ...unit.growthPoints },
          hp: unit.currentHp,
        };
        return { before, changed, reversed, redone };
      } finally {
        Math.random = nativeRandom;
      }
    });

    expect(result.changed.level).toBe(result.before.level + 1);
    expect(result.changed.exp).toBe(0);
    expect(result.changed.growthPoints.STR).not.toBe(0);
    expect(result.reversed).toEqual({
      exp: 99,
      level: result.before.level,
      stats: result.before.stats,
      growthPoints: Object.fromEntries(
        Object.keys(result.before.growths).map((nid) => [nid, 0]),
      ),
      hp: result.before.hp,
    });
    expect(result.redone).toEqual(result.changed);
  });
});
