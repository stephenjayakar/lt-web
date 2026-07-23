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
