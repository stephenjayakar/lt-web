import { expect, test, type Page } from '@playwright/test';

/**
 * EOtF runs on an engine fork whose sprites/ folder differs from upstream's:
 * a taller unit_info_bg (with its own hover-panel layout), a 30px-high
 * menu_bg_parchment, and fork-only sprites (public/fork-sprites). For a
 * project on the fork, the fork's copy wins over the upstream engine sprite;
 * the project's own custom_sprites still win over both.
 */

async function boot(page: Page, project: string): Promise<void> {
  await page.goto(`/?harness=true&project=${project}&level=${project === 'eotf.ltproj' ? 'X' : '0'}&clean=true&bundle=false`);
  await page.waitForFunction(() => (window as any).__harness?.ready === true, undefined, { timeout: 60_000 });
}

test.describe('EOtF engine fork sprites', () => {
  test('EOtF resolves engine sprites to the fork copy and draws the fork unit-info panel', async ({ page }) => {
    await boot(page, 'eotf.ltproj');
    const result = await page.evaluate(async () => {
      const { isForkEngine } = await import('/src/engine/engine-flavor.ts');
      const { spriteUrl, engineSpriteUrl, loadSprite } = await import('/src/ui/sprites.ts');
      const { loadMenuBgSprite } = await import('/src/ui/base-surf.ts');
      const bg = await loadSprite('unit_info_bg');
      const parchment = await loadMenuBgSprite('menu_bg_parchment');
      const game = (window as any).__gameRef;
      const unit = [...game.units.values()].find((u: any) => u.position && !u.generic && u.items.length > 0);
      const hud = game.hud;
      const panel = unit ? (hud as any).createUnitInfo(unit, game) : null;
      return {
        fork: isForkEngine(),
        unitInfo: spriteUrl('unit_info_bg'),
        menuBase: spriteUrl('menu_bg_base'),
        parchmentUrl: engineSpriteUrl('menu_bg_parchment', '/game-data/sprites/menus/menu_bg_parchment.png'),
        bgSize: bg ? [bg.width, bg.height] : null,
        parchmentSize: parchment ? [parchment.width, parchment.height] : null,
        panelSize: panel ? [panel.width, panel.height] : null,
        extraPurple: spriteUrl('damage_numbers_extra_purple'),
        levelScreen2: spriteUrl('LevelScreen2'),
      };
    });
    expect(result.fork).toBe(true);
    expect(result.unitInfo).toBe('/fork-sprites/menus/unit_info_bg.png');
    // Identical in both engines: stays on the upstream copy.
    expect(result.menuBase).toBe('/game-data/sprites/menus/menu_bg_base.png');
    expect(result.parchmentUrl).toBe('/fork-sprites/menus/menu_bg_parchment.png');
    expect(result.bgSize).toEqual([123, 60]);
    expect(result.parchmentSize).toEqual([48, 30]);
    expect(result.panelSize).toEqual([123, 60]);
    expect(result.extraPurple).toBe('/fork-sprites/damage_numbers/damage_numbers_extra_purple.png');
    expect(result.levelScreen2).toBe('/fork-sprites/exp_displays/LevelScreen2.png');
  });

  test('upstream projects keep the upstream engine sprites', async ({ page }) => {
    await boot(page, 'default.ltproj');
    const result = await page.evaluate(async () => {
      const { isForkEngine } = await import('/src/engine/engine-flavor.ts');
      const { spriteUrl, loadSprite } = await import('/src/ui/sprites.ts');
      const bg = await loadSprite('unit_info_bg');
      return { fork: isForkEngine(), url: spriteUrl('unit_info_bg'), size: bg ? [bg.width, bg.height] : null };
    });
    expect(result).toEqual({ fork: false, url: '/game-data/sprites/menus/unit_info_bg.png', size: [122, 48] });
  });
});
