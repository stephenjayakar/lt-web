import { test, expect, type Page } from '@playwright/test';

async function waitForHarness(page: Page): Promise<void> {
  await page.waitForFunction(() => !!(window as any).__harness?.ready, { timeout: 15_000 });
}

test.describe('Web player shell', () => {
  test('campaign launcher is accessible and explains supported input', async ({ page }) => {
    await page.goto('/');

    await expect(page.getByRole('heading', { name: 'Choose your campaign' })).toBeVisible();
    await expect(page.getByText('keyboard, pointer, touch, and gamepad input')).toBeVisible();

    const campaigns = page.getByLabel('Available campaigns').getByRole('button');
    await expect(campaigns).toHaveCount(3);
    await expect(page.getByRole('button', { name: 'Launch Default Campaign' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Launch Rekka' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Launch Testing Proj' })).toBeVisible();
  });

  test('control help is usable without leaking input into the game', async ({ page }) => {
    await page.goto('/?harness=true&level=DEBUG&clean=true&bundle=false&controls=true');
    await waitForHarness(page);

    const controls = page.getByRole('button', { name: 'Controls' });
    await controls.click();
    await expect(page.getByRole('region', { name: 'Game controls' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Keyboard' })).toBeVisible();

    const pendingInput = await page.evaluate(() => {
      const input = (window as any).__gameRef.input;
      return input.processInput(16);
    });
    expect(pendingInput).toBeNull();

    await page.getByRole('button', { name: 'Close controls' }).click();
    await expect(page.getByRole('region', { name: 'Game controls' })).toBeHidden();
    await expect(page.getByLabel('Game display')).toBeFocused();
  });

  test('audio state is visible and mute restores the configured levels', async ({ page }) => {
    await page.goto('/?harness=true&level=DEBUG&clean=true&bundle=false&controls=true');
    await waitForHarness(page);

    const mute = page.getByRole('button', { name: 'Mute audio' });
    await expect(mute).toContainText('Sound on');
    await mute.click();
    await expect(page.getByRole('button', { name: 'Unmute audio' })).toContainText('Muted');
    expect(await page.evaluate(() => {
      const audio = (window as any).__gameRef.audioManager;
      return [audio.getMusicVolume(), audio.getSfxVolume()];
    })).toEqual([0, 0]);

    await page.getByRole('button', { name: 'Unmute audio' }).click();
    await expect(page.getByRole('button', { name: 'Mute audio' })).toContainText('Sound on');
    expect(await page.evaluate(() => {
      const audio = (window as any).__gameRef.audioManager;
      return [audio.getMusicVolume(), audio.getSfxVolume()];
    })).toEqual([0.7, 1]);
  });

  test('keyboard repeat, blur release, and browser shortcuts behave predictably', async ({ page }) => {
    await page.goto('/?harness=true&level=DEBUG&clean=true&bundle=false&controls=true');
    await waitForHarness(page);

    const prevention = await page.evaluate(() => ({
      mapped: window.dispatchEvent(new KeyboardEvent('keydown', {
        code: 'ArrowRight',
        bubbles: true,
        cancelable: true,
      })),
      unmapped: window.dispatchEvent(new KeyboardEvent('keydown', {
        code: 'KeyQ',
        bubbles: true,
        cancelable: true,
      })),
    }));
    expect(prevention).toEqual({ mapped: false, unmapped: true });

    const repeated = await page.evaluate(() => {
      const input = (window as any).__gameRef.input;
      const first = input.processInput(16);
      input.endFrame();
      const held = input.processInput(400);
      window.dispatchEvent(new Event('blur'));
      input.endFrame();
      return {
        first,
        held,
        afterBlur: input.processInput(16),
        rightStillPressed: input.isPressed('RIGHT'),
      };
    });
    expect(repeated).toEqual({
      first: 'RIGHT',
      held: 'RIGHT',
      afterBlur: null,
      rightStillPressed: false,
    });
  });

  test('an already-connected gamepad and its d-pad navigate without clobbering keys', async ({ page }) => {
    await page.goto('/?harness=true&level=DEBUG&clean=true&bundle=false&controls=true');
    await waitForHarness(page);

    const result = await page.evaluate(() => {
      const buttons = Array.from({ length: 16 }, () => ({ pressed: false, value: 0 }));
      buttons[15] = { pressed: true, value: 1 };
      const gamepad = {
        id: 'Test Gamepad',
        index: 0,
        connected: true,
        timestamp: 1,
        mapping: 'standard',
        axes: [0, 0, 0, 0],
        buttons,
        vibrationActuator: null,
      };
      Object.defineProperty(navigator, 'getGamepads', {
        configurable: true,
        value: () => [gamepad],
      });
      const input = (window as any).__gameRef.input;
      const dpad = input.processInput(16);
      input.endFrame();
      buttons[15] = { pressed: false, value: 0 };
      input.processInput(16);
      return { dpad, released: !input.isPressed('RIGHT') };
    });
    expect(result).toEqual({ dpad: 'RIGHT', released: true });
  });

  test('touch controls feed the same abstract input queue', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/?harness=true&level=DEBUG&clean=true&bundle=false&controls=true');
    await waitForHarness(page);

    const touchControls = page.getByLabel('Touch game controls');
    await expect(touchControls).toBeVisible();
    await touchControls.getByRole('button', { name: 'A', exact: true }).click();

    const inputEvent = await page.evaluate(() => {
      const input = (window as any).__gameRef.input;
      return input.processInput(16);
    });
    expect(inputEvent).toBe('SELECT');
  });

  test('portrait play preserves the minimum logical menu width', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/?harness=true&level=DEBUG&clean=true&bundle=false&controls=true');
    await waitForHarness(page);

    const dimensions = await page.evaluate(async () => {
      const { viewport } = await import('/src/engine/viewport.ts');
      return { width: viewport.width, height: viewport.height };
    });

    expect(dimensions.width).toBeGreaterThanOrEqual(240);
    expect(dimensions.height).toBeGreaterThanOrEqual(160);
  });

  test('touch controls occupy a dock outside the game canvas', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/?harness=true&level=DEBUG&clean=true&bundle=false&controls=true');
    await waitForHarness(page);

    const canvasBox = await page.locator('#game-canvas').boundingBox();
    const controlsBox = await page.getByLabel('Touch game controls').boundingBox();
    expect(canvasBox).not.toBeNull();
    expect(controlsBox).not.toBeNull();
    expect(canvasBox!.height).toBeLessThan(844);
    expect(controlsBox!.y).toBeGreaterThanOrEqual(canvasBox!.y + canvasBox!.height);
  });

  test('startup status reports progress and offers recovery actions', async ({ page }) => {
    await page.goto('/?harness=true&level=DEBUG&clean=true&bundle=false');
    await waitForHarness(page);

    await page.evaluate(async () => {
      const { installStartupStatus } = await import('/src/ui/web-startup.ts');
      const status = installStartupStatus('testing_proj.ltproj');
      status.update('Loading portraits…');
      status.fail('Portrait manifest could not be read.');
    });

    await expect(page.getByText('Unable to open campaign')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Something went wrong' })).toBeVisible();
    await expect(page.getByText('Portrait manifest could not be read.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Retry' })).toBeFocused();
    await expect(page.getByRole('button', { name: 'Choose another campaign' })).toBeVisible();
  });
});
