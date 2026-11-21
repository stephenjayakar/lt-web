/**
 * First-frame and return-trip polish for menus (Python builds windows from
 * sprites it already holds, and keeps a menu's cursor while a child screen
 * is open).
 */
import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';

test.describe.configure({ mode: 'parallel' });

async function boot(page: Page): Promise<void> {
  await page.goto('/?harness=true&level=DEBUG&bundle=false');
  await page.waitForFunction(() => !!(window as any).__harness?.ready, { timeout: 30000 });
  await stepFrames(page, 5);
}

async function stepFrames(page: Page, count: number, input: string | null = null): Promise<void> {
  await page.evaluate(({ n, input }) => (window as any).__harness.stepFrames(n, input), { n: count, input });
}

const stack = (page: Page) => page.evaluate(() => (window as any).__gameRef.state.getStackNames() as string[]);

test('a window of a new size is cut from the loaded sprite on its first frame', async ({ page }) => {
  await boot(page);
  const result = await page.evaluate(async () => {
    const baseSurf = await import('/src/ui/base-surf.ts');
    await baseSurf.loadMenuBgSprite('menu_bg_base');
    // A size no screen has drawn yet.
    const surf = baseSurf.getMenuBackgroundSync(88, 56, 'menu_bg_base');
    const data = surf.ctx.getImageData(0, 0, surf.canvas.width, surf.canvas.height).data;
    // The fallback is a flat rgba(16,16,32,0.9) box; the real window has a
    // transparent rounded corner and a lighter border.
    const corner = [data[0], data[1], data[2], data[3]];
    const colours = new Set<string>();
    for (let i = 0; i < data.length; i += 4) colours.add(`${data[i]},${data[i + 1]},${data[i + 2]},${data[i + 3]}`);
    return { corner, colours: colours.size };
  });
  expect(result.colours, 'the 9-sliced window, not the flat fallback').toBeGreaterThan(3);
});

test('back from Objective, the map menu keeps its cursor on Objective', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => (window as any).__gameRef.state.change('option_menu'));
  await stepFrames(page, 5);
  await stepFrames(page, 3, 'DOWN');
  await stepFrames(page, 3, 'SELECT');
  for (let i = 0; i < 40 && !(await stack(page)).includes('objective_menu'); i++) await stepFrames(page, 5);
  expect(await stack(page)).toContain('objective_menu');
  await stepFrames(page, 20);
  await stepFrames(page, 3, 'BACK');
  for (let i = 0; i < 40 && (await stack(page)).at(-1) !== 'option_menu'; i++) await stepFrames(page, 5);
  const menu = await page.evaluate(() => {
    const g = (window as any).__gameRef;
    const state = g.state.getCurrentState() as any;
    return { name: state.name, selected: state.menu?.options?.[state.menu.selectedIndex]?.value ?? null };
  });
  expect(menu.name).toBe('option_menu');
  expect(menu.selected).toBe('objective');
});

test('the map menu stays drawn under the fade to the Objective screen', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => (window as any).__gameRef.state.change('option_menu'));
  await stepFrames(page, 5);
  await stepFrames(page, 3, 'DOWN');
  await stepFrames(page, 1, 'SELECT');
  const during = await page.evaluate(() => {
    const g = (window as any).__gameRef;
    const option = g.state.stack.find((state: any) => state.name === 'option_menu');
    return { top: g.state.getCurrentState()?.name, hasMenu: !!option?.menu };
  });
  // Python transition_to is transparent over the option menu.
  expect(during.top).toBe('transition_to');
  expect(during.hasMenu).toBe(true);
});
