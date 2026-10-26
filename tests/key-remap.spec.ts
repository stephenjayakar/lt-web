/**
 * key-remap.spec.ts: the Controls settings page rebinds keyboard keys
 * (settings.py SettingsMenuState get_input + input_manager change_keymap).
 *
 * - SELECT on a control row listens for a key; an unbound key becomes that
 *   button's only key, saved in the settings sync store as key_<BUTTON>.
 * - A key already bound to another button is refused with an
 *   'Invalid Choice!' alert; BACK cancels.
 * - The input layer applies the new map at once, the old keys stop working,
 *   untouched buttons keep the web defaults, and Restore Defaults brings the
 *   original map back. Virtual (touch) buttons are unaffected.
 */
import { expect, test, type Page } from '@playwright/test';

test.use({ launchOptions: { args: ['--mute-audio'] } });

const DEFAULT = '/?harness=true&level=0&clean=true&bundle=false';

async function boot(page: Page): Promise<void> {
  await page.goto(DEFAULT);
  await page.waitForFunction(() => (window as any).__harness?.ready === true, undefined, { timeout: 90_000 });
}

async function step(page: Page, frames: number): Promise<void> {
  await page.evaluate((frames) => (window as any).__harness.stepFrames(frames, null), frames);
}

/** Press a game button straight into the current state. */
async function button(page: Page, event: string): Promise<void> {
  await page.evaluate((e) => (window as any).__gameRef.state.getCurrentState().takeInput(e), event);
  await step(page, 2);
}

/** Press a physical key and route this frame's input event to the current state, like the main loop. */
async function key(page: Page, code: string): Promise<string | null> {
  await page.evaluate((code) => {
    window.dispatchEvent(new KeyboardEvent('keydown', { code, bubbles: true }));
    window.dispatchEvent(new KeyboardEvent('keyup', { code, bubbles: true }));
  }, code);
  const event = await page.evaluate(() => {
    const g = (window as any).__gameRef;
    const ev = g.input.processInput(16);
    g.state.getCurrentState().takeInput(ev);
    g.input.endFrame();
    return ev;
  });
  await step(page, 2);
  return event;
}

const settings = (page: Page) => page.evaluate(() => {
  const s = (window as any).__gameRef.state.getCurrentState();
  return { phase: s.phase, alert: s.alert?.text ?? null, row: s.controlsMenu.currentIndex };
});

const stored = (page: Page) => page.evaluate(async () => {
  const { getSyncStore } = await import('/src/storage/storage.ts');
  const raw = getSyncStore().getItem('lt-web-settings');
  const parsed = raw ? JSON.parse(raw) : {};
  return Object.fromEntries(Object.entries(parsed).filter(([k]) => k.startsWith('key_')));
});

const map = (page: Page, codes: string[]) => page.evaluate(async (codes) => {
  const { currentKeyMap } = await import('/src/engine/states/settings-state.ts');
  const m = currentKeyMap();
  return codes.map((c) => m[c] ?? null);
}, codes);

test('Controls page rebinds a key, refuses bound keys, applies it to input and restores defaults', async ({ page }, testInfo) => {
  await boot(page);
  await page.evaluate(async () => {
    const { restoreDefaultKeyBindings } = await import('/src/engine/states/settings-state.ts');
    restoreDefaultKeyBindings();
    (window as any).__gameRef.state.change('settings_menu');
  });
  await step(page, 30);
  expect(await map(page, ['KeyZ', 'Enter', 'KeyX', 'KeyW', 'KeyK'])).toEqual(['SELECT', 'SELECT', 'BACK', 'UP', null]);

  // Controls tab, first row (SELECT), start listening.
  await button(page, 'RIGHT');
  await button(page, 'DOWN');
  await button(page, 'SELECT');
  expect(await settings(page)).toEqual({ phase: 'get_input', alert: null, row: 0 });
  await page.locator('canvas').screenshot({ path: testInfo.outputPath('controls-listening.png') });

  // A key bound to another button (C = INFO) is refused.
  expect(await key(page, 'KeyC')).toBe('INFO');
  expect(await settings(page)).toEqual({ phase: 'controls', alert: 'Invalid Choice!', row: 0 });
  await page.locator('canvas').screenshot({ path: testInfo.outputPath('controls-invalid.png') });
  await step(page, 200);
  expect((await settings(page)).alert).toBe(null);

  // BACK cancels listening without a change.
  await button(page, 'SELECT');
  expect(await key(page, 'KeyX')).toBe('BACK');
  expect(await settings(page)).toEqual({ phase: 'controls', alert: null, row: 0 });
  expect(await stored(page)).toEqual({});

  // An unbound key (K) becomes SELECT's only key.
  await button(page, 'SELECT');
  expect(await key(page, 'KeyK')).toBe(null);
  expect(await settings(page)).toEqual({ phase: 'controls', alert: null, row: 0 });
  expect(await stored(page)).toEqual({ key_SELECT: 'KeyK' });
  expect(await map(page, ['KeyK', 'KeyZ', 'Enter', 'KeyX', 'KeyW'])).toEqual(['SELECT', null, null, 'BACK', 'UP']);
  await page.locator('canvas').screenshot({ path: testInfo.outputPath('controls-rebound.png') });

  // The input layer uses it at once: K selects, Z does nothing; touch still works.
  const presses = await page.evaluate(() => {
    const input = (window as any).__gameRef.input;
    const press = (code: string): string | null => {
      window.dispatchEvent(new KeyboardEvent('keydown', { code, bubbles: true }));
      const ev = input.processInput(16);
      input.endFrame();
      window.dispatchEvent(new KeyboardEvent('keyup', { code, bubbles: true }));
      input.processInput(16);
      input.endFrame();
      return ev;
    };
    const k = press('KeyK');
    const z = press('KeyZ');
    input.pressVirtual('SELECT');
    const touch = input.processInput(16);
    input.endFrame();
    input.releaseVirtual('SELECT');
    input.processInput(16);
    input.endFrame();
    return { k, z, touch, held: input.isPressed('SELECT') };
  });
  expect(presses).toEqual({ k: 'SELECT', z: null, touch: 'SELECT', held: false });

  // The web help panel lists the new binding.
  const rows = await page.evaluate(async () => {
    const { installWebControls } = await import('/src/ui/web-controls.ts');
    const g = (window as any).__gameRef;
    const root = installWebControls(g.input);
    (root.querySelector('[data-help]') as HTMLButtonElement).click();
    const text = root.querySelector('[data-keyboard-rows]')!.textContent;
    root.remove();
    return text;
  });
  expect(rows).toContain('KSelect');
  expect(rows).toContain('X / EscBack');

  // Restore Defaults (last row) brings back the original map.
  for (let i = 0; i < 9; i++) await button(page, 'DOWN');
  expect((await settings(page)).row).toBe(9);
  await button(page, 'SELECT');
  expect(await stored(page)).toEqual({});
  expect(await map(page, ['KeyZ', 'Enter', 'KeyK'])).toEqual(['SELECT', 'SELECT', null]);
});
