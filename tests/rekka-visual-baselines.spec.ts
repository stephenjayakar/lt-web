import { expect, test } from '@playwright/test';

async function waitForHarness(page: import('@playwright/test').Page): Promise<void> {
  await page.waitForFunction(() => (window as any).__harness?.ready === true, {
    timeout: 60_000,
  });
}

test.describe('Rekka visual baselines', () => {
  test('representative chapter map renders project tiles, units, and HUD', async ({ page }) => {
    await page.goto('/?harness=true&project=rekka.ltproj&level=7&clean=true&bundle=false');
    await waitForHarness(page);
    await page.evaluate(async () => {
      (window as any).__harness.stepFrames(5, null);
      await new Promise((resolve) => setTimeout(resolve, 100));
      (window as any).__harness.stepFrames(1, null);
    });
    await expect(page.locator('#game-canvas')).toHaveScreenshot('rekka-chapter-7-map.png', {
      maxDiffPixelRatio: 0.01,
    });
  });

  test('project dialogue renders its portraits and held text', async ({ page }) => {
    await page.goto('/?harness=true&project=rekka.ltproj&level=DEBUG&clean=true&bundle=false');
    await waitForHarness(page);
    await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const nid = '_RekkaVisualDialogue';
      game.db.events.set(nid, {
        nid,
        name: 'Rekka visual dialogue',
        trigger: nid,
        level_nid: 'DEBUG',
        condition: 'True',
        only_once: false,
        priority: 0,
        _source: [
          'change_background;BlackBackground',
          'multi_add_portrait;Marcel;Left;Lyn;Right',
          'speak;Marcel;I miss home',
          'multi_remove_portrait;Marcel;Lyn',
        ],
      });
      game.eventManager.triggerSpecific(nid, {
        type: 'direct_visual_check',
        levelNid: 'DEBUG',
      }, true);
      game.state.change('event');
      for (let index = 0; index < 60; index++) {
        (window as any).__harness.stepFrames(1, null);
        const state = game.state.getCurrentState() as any;
        if (state?.dialog) {
          state.dialog.handleInput('SELECT');
          state.dialog.handleInput('SELECT');
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    });
    await page.waitForTimeout(300);
    await page.evaluate(() => (window as any).__harness.stepFrames(1, null));
    expect(await page.evaluate(
      () => (window as any).__gameRef.state.getCurrentState()?.dialog?.isWaiting(),
    )).toBe(true);
    await expect(page.locator('#game-canvas')).toHaveScreenshot('rekka-dialogue.png', {
      maxDiffPixelRatio: 0.01,
    });
  });

  test('save selection remains contained at the logical resolution', async ({ page }) => {
    await page.goto('/?harness=true&project=rekka.ltproj&level=7&clean=true&bundle=false');
    await waitForHarness(page);
    await page.evaluate(() => {
      const game = (window as any).__gameRef;
      game.state.change('save_menu');
      (window as any).__harness.stepFrames(2, null);
    });
    await page.waitForTimeout(100);
    await page.evaluate(() => (window as any).__harness.stepFrames(1, null));
    expect(await page.evaluate(
      () => (window as any).__gameRef.state.getCurrentState()?.name,
    )).toBe('save_menu');
    await expect(page.locator('#game-canvas')).toHaveScreenshot('rekka-save-select.png', {
      maxDiffPixelRatio: 0.01,
    });
  });

  test('Rekka full battle animation loads authored combat art and platforms', async ({ page }) => {
    await page.goto('/?harness=true&project=rekka.ltproj&level=0&clean=true&bundle=false');
    await waitForHarness(page);
    const started = await page.evaluate(() => {
      const game = (window as any).__gameRef;
      const attacker = game.buildUnit(game.db.units.get('Dorcas'), 'player', 'None');
      const defender = game.buildUnit(game.db.units.get('Batta'), 'enemy', 'None');
      attacker.equippedWeapon = attacker.items.find((item: any) => item.isWeapon());
      defender.equippedWeapon = defender.items.find((item: any) => item.isWeapon());
      attacker.wexp.Axe = 999;
      defender.wexp.Axe = 999;
      game.units.set('_ForecastDorcas', attacker);
      game.units.set('_ForecastBatta', defender);
      let location: [number, number] | null = null;
      for (let y = 0; y < game.board.height && !location; y++) {
        for (let x = 0; x + 1 < game.board.width; x++) {
          const left = game.db.terrain.get(game.board.getTerrain(x, y));
          const right = game.db.terrain.get(game.board.getTerrain(x + 1, y));
          if (left?.background && left.background !== 'BlackBackground' &&
              right?.background && right.background !== 'BlackBackground' &&
              !game.board.getUnit(x, y) && !game.board.getUnit(x + 1, y)) {
            location = [x, y];
            break;
          }
        }
      }
      if (!location) return false;
      game.board.setUnit(location[0], location[1], attacker);
      game.board.setUnit(location[0] + 1, location[1], defender);
      attacker.finished = false;
      game.selectedUnit = attacker;
      game.combatTarget = defender;
      game.state.change('combat');
      return true;
    });
    expect(started).toBe(true);

    for (let index = 0; index < 100; index++) {
      await page.evaluate(() => (window as any).__harness.stepFrames(2, null));
      const ready = await page.evaluate(() => {
        const state = (window as any).__gameRef.state.getCurrentState() as any;
        return state?.name === 'combat' &&
          !!state.animCombat?.getRenderState?.().leftDraw?.mainFrame &&
          !!state.animCombat?.getRenderState?.().rightDraw?.mainFrame;
      });
      if (ready) break;
      await page.waitForTimeout(10);
    }
    const render = await page.evaluate(() => {
      const state = (window as any).__gameRef.state.getCurrentState() as any;
      const combat = state?.animCombat;
      if (!combat) return null;
      combat.state = 'entrance';
      combat.stateTimer = 700;
      combat.leftAnim.opacity = 255;
      combat.rightAnim.opacity = 255;
      const frame = combat.getRenderState();
      return {
        left: Boolean(frame.leftDraw.mainFrame),
        right: Boolean(frame.rightDraw.mainFrame),
      };
    });
    expect(render).toEqual({ left: true, right: true });
    await page.waitForTimeout(250);
    await page.evaluate(() => (window as any).__harness.stepFrames(1, null));
    await expect(page.locator('#game-canvas')).toHaveScreenshot(
      'rekka-full-battle-animation.png',
      { maxDiffPixelRatio: 0.01 },
    );
  });

  test('Rekka targeting forecast and map combat remain readable', async ({ page }) => {
    await page.goto('/?harness=true&project=rekka.ltproj&level=0&clean=true&bundle=false');
    await waitForHarness(page);
    await page.evaluate(() => {
      const game = (window as any).__gameRef;
      const attacker = game.units.get('Lyn');
      const defender = game.units.get('Batta');
      attacker.equippedWeapon = attacker.items.find((item: any) => item.isWeapon());
      defender.equippedWeapon = defender.items.find((item: any) => item.isWeapon());
      attacker.wexp.Sword = 999;
      defender.wexp.Axe = 999;
      if (defender.position) game.board.removeUnit(defender);
      const [x, y] = attacker.position;
      const destination = [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]
        .find(([tx, ty]) => game.board.inBounds(tx, ty) && !game.board.getUnit(tx, ty));
      game.board.setUnit(destination[0], destination[1], defender);
      game.camera.forceTile(x, y);
      attacker.finished = false;
      game.selectedUnit = attacker;
      game.state.change('targeting');
      (window as any).__harness.stepFrames(2, null);
    });
    expect(await page.evaluate(
      () => (window as any).__gameRef.state.getCurrentState()?.name,
    )).toBe('targeting');
    await expect(page.locator('#game-canvas')).toHaveScreenshot(
      'rekka-combat-forecast.png',
      { maxDiffPixelRatio: 0.01 },
    );

    await page.evaluate(() => {
      const game = (window as any).__gameRef;
      // Utility/spell presentation intentionally routes through MapCombat.
      game.selectedUnit.equippedWeapon.components.set('spell', true);
      (window as any).__harness.stepFrames(1, 'SELECT');
      (window as any).__harness.stepFrames(45, null);
    });
    expect(await page.evaluate(
      () => (window as any).__gameRef.state.getCurrentState()?.name,
    )).toBe('combat');
    await expect(page.locator('#game-canvas')).toHaveScreenshot(
      'rekka-map-combat.png',
      { maxDiffPixelRatio: 0.01 },
    );
  });
});
