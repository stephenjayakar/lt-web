/**
 * map-hud.spec.ts — On-map UI geometry against lt-maker/app/engine/ui_view.py.
 *
 * The HUD (src/ui/hud.ts) records where it drew each element in
 * `game.hud.layout` ([x, y, w, h] in scene pixels). The expected numbers are
 * Python's: sprite sizes (tile_info_quick_opaque 45x44, unit_info_bg 122x48 upstream, 123x60 on the EOtF fork,
 * attack_info_crit_red 130x121) and the corner formulas in UIView.draw /
 * draw_attack_info. Screenshots are attached for visual inspection.
 */

import { expect, test, type Page } from '@playwright/test';

test.describe.configure({ mode: 'serial' });

async function bootLevel(page: Page): Promise<void> {
  await page.goto('/?harness=true&project=eotf.ltproj&level=1&clean=true&bundle=false');
  await page.waitForFunction(() => (window as any).__harness?.ready === true, undefined, { timeout: 90_000 });
  for (let i = 0; i < 60; i++) {
    await page.evaluate(() => (window as any).__harness.stepFrames(10, null));
    const state = await page.evaluate(() => (window as any).__gameRef.state.getCurrentState()?.name);
    if (state === 'free') break;
  }
  // Let the HUD sprites and fonts finish loading.
  await page.waitForFunction(async () => {
    const sprites = await import('/src/ui/sprites.ts');
    const fonts = await import('/src/rendering/bmp-font.ts');
    await sprites.preloadSprites(['tile_info_quick_opaque', 'unit_info_bg', 'attack_info_crit_red', 'combat_gem_blue']);
    return fonts.areFontsReady();
  }, undefined, { timeout: 30_000 });
}

async function cursorTo(page: Page, x: number, y: number, frames = 20): Promise<void> {
  await page.evaluate(({ x, y, frames }) => {
    (window as any).__gameRef.cursor.setPos(x, y);
    (window as any).__harness.stepFrames(frames, null);
  }, { x, y, frames });
}

async function layout(page: Page): Promise<Record<string, [number, number, number, number]>> {
  return page.evaluate(() => (window as any).__gameRef.hud.layout);
}

test('unit, tile and objective panels use the Python sprites and corners', async ({ page }, testInfo) => {
  await bootLevel(page);
  const scene = await page.evaluate(async () => {
    const { viewport } = await import('/src/engine/viewport.ts');
    return [viewport.width, viewport.height];
  });
  expect(scene).toEqual([240, 160]);

  // Cursor top-left on a unit: unit info bottom-left, terrain bottom-right,
  // objective top-right.
  await cursorTo(page, 5, 3);
  let boxes = await layout(page);
  // EOtF engine fork unit_info_bg: 123x60 (ui_view.create_unit_info).
  expect(boxes.unit).toEqual([0, 160 - 60, 123, 60]);
  expect(boxes.tile).toEqual([240 - 45 - 5, 160 - 44 - 3, 45, 44]);
  expect(boxes.objective[0] + boxes.objective[2]).toBe(240 - 4);
  expect(boxes.objective[1]).toBe(1);
  await page.locator('canvas').screenshot({ path: testInfo.outputPath('hud-cursor-topleft.png') });

  // Cursor bottom-right on a unit: unit info moves to the top-left and the
  // tile info slides out (mirrored) and back in on the left over 4+4 frames.
  await cursorTo(page, 12, 8, 2);
  boxes = await layout(page);
  expect(boxes.unit).toEqual([0, 0, 123, 60]);
  expect(boxes.tile[0]).toBeGreaterThan(240 - 45 - 5);
  await cursorTo(page, 12, 8, 10);
  boxes = await layout(page);
  expect(boxes.tile).toEqual([5, 160 - 44 - 3, 45, 44]);
  await page.locator('canvas').screenshot({ path: testInfo.outputPath('hud-cursor-bottomright.png') });

  // Onto an empty tile: the unit panel slides out 20 px per frame.
  await cursorTo(page, 9, 8, 1);
  expect((await layout(page)).unit).toEqual([-20, 0, 123, 60]);
  await cursorTo(page, 9, 8, 12);
  expect((await layout(page)).unit).toBeUndefined();

  // Outside legal states nothing but the sliding objective remains.
  await page.evaluate(() => {
    (window as any).__gameRef.state.change('option_menu');
    (window as any).__harness.stepFrames(3, null);
  });
  boxes = await layout(page);
  expect(boxes.tile).toBeUndefined();
  expect(boxes.unit).toBeUndefined();
});

test('attack forecast slides in at the Python corner', async ({ page }, testInfo) => {
  await bootLevel(page);
  const state = await page.evaluate(() => {
    const game = (window as any).__gameRef;
    const harness = (window as any).__harness;
    harness.setUnitIdentity('104', { team: 'player' });
    harness.warpUnit('104', 6, 6);
    harness.warpUnit('103_grounded', 7, 6);
    for (const nid of ['104', '103_grounded']) {
      game.getUnit(nid).klass = 'Lord';
      game.getUnit(nid).wexp.Sword = 999;
    }
    harness.giveItem('104', 'Iron_Sword');
    harness.equipItem('104', 'Iron_Sword');
    harness.giveItem('103_grounded', 'Steel_Sword');
    harness.equipItem('103_grounded', 'Steel_Sword');
    const unit = game.getUnit('104');
    unit.finished = false;
    game.selectedUnit = unit;
    game.cursor.setPos(6, 6);
    game.state.change('targeting');
    harness.stepFrames(2, null);
    return game.state.getCurrentState()?.name;
  });
  expect(state).toBe('targeting');
  // Cursor on the target at x=7 (> TILEX // 2 - 1): window at x = -19 - offset.
  let boxes = await layout(page);
  expect(boxes.attack[0]).toBeLessThan(-19);
  await page.evaluate(() => (window as any).__harness.stepFrames(6, null));
  boxes = await layout(page);
  expect(boxes.attack).toEqual([-19, 4, 130, 121]);
  await page.evaluate(async () => {
    await new Promise((resolve) => setTimeout(resolve, 300));
    (window as any).__harness.stepFrames(1, null);
  });
  await page.locator('canvas').screenshot({ path: testInfo.outputPath('hud-attack-forecast.png') });
});

test('minimap is built from Minimap_Tiles cells like minimap.py', async ({ page }, testInfo) => {
  await bootLevel(page);
  await page.waitForFunction(async () => {
    const sprites = await import('/src/ui/sprites.ts');
    await sprites.preloadSprites(['Minimap_Tiles', 'Minimap_Sprites', 'Minimap_Cursor']);
    return true;
  });
  const result = await page.evaluate(async () => {
    const game = (window as any).__gameRef;
    const sprites = await import('/src/ui/sprites.ts');
    game.state.change('minimap');
    (window as any).__harness.stepFrames(25, null);
    const state = game.state.getCurrentState();
    const tiles = sprites.getSprite('Minimap_Tiles')!;
    // First Grass-minimap tile without a unit on it.
    let grass: [number, number] | null = null;
    for (let y = 0; y < game.tilemap.height && !grass; y++) {
      for (let x = 0; x < game.tilemap.width && !grass; x++) {
        const terrain = game.db.terrain.get(game.board.getTerrain(x, y));
        if (terrain?.minimap === 'Grass' && !game.board.getUnit(x, y)) grass = [x, y];
      }
    }
    const built = state.minimap.surf.getPixel(grass![0] * 4 + 1, grass![1] * 4 + 1);
    // MinimapCatalog.single_map['Grass'] = (1, 0).
    const expected = tiles.getPixel(1 * 4 + 1, 0 * 4 + 1);
    return { name: state.name, built, expected };
  });
  expect(result.name).toBe('minimap');
  expect(result.built).toEqual(result.expected);
  await page.locator('canvas').screenshot({ path: testInfo.outputPath('minimap.png') });
});

test('warning markers sit above enemies holding warning items (draw_markers)', async ({ page }) => {
  await bootLevel(page);
  await page.waitForFunction(async () => {
    const sprites = await import('/src/ui/sprites.ts');
    await sprites.preloadSprites(['marker_warning']);
    return true;
  });
  const changed = await page.evaluate(() => {
    const game = (window as any).__gameRef;
    const harness = (window as any).__harness;
    harness.setUnitIdentity('104', { team: 'player' });
    game.cursor.setPos(...game.getUnit('104').position);
    const enemy = game.getUnit('105');
    const [ex, ey] = enemy.position;
    const region = () => {
      harness.stepFrames(1, null);
      const ctx = (document.querySelector('canvas') as HTMLCanvasElement).getContext('2d')!;
      // Marker box: (left - 2, top - 14) + 16x16 (+2 px bob), canvas at 2x.
      return Array.from(ctx.getImageData((ex * 16 - 2) * 2, (ey * 16 - 14) * 2, 32, 36).data);
    };
    const before = region();
    enemy.klass = 'Lord';
    enemy.wexp.Sword = 999;
    harness.giveItem('105', 'Killing_Edge');
    const after = region();
    return before.filter((value, i) => value !== after[i]).length;
  });
  expect(changed).toBeGreaterThan(50);
});

test('project custom_sprites override engine sprites like Python SPRITES', async ({ page }) => {
  await bootLevel(page);
  const urls = await page.evaluate(async () => {
    const sprites = await import('/src/ui/sprites.ts');
    return {
      spellWindow2: sprites.spriteUrl('spell_window2'),
      spellWindow1: sprites.spriteUrl('spell_window1'),
      tileInfo: sprites.spriteUrl('tile_info_quick_opaque'),
      missing: sprites.spriteUrl('no_such_sprite'),
    };
  });
  expect(urls.spellWindow2).toBe('/game-data/eotf.ltproj/resources/custom_sprites/menu/2/spell_window2.png');
  expect(urls.spellWindow1).toBe('/game-data/sprites/displays/spell_window1.png');
  expect(urls.tileInfo).toBe('/game-data/sprites/menus/tile_info_quick_opaque.png');
  expect(urls.missing).toBeNull();
});

test('banners are Python menu windows centred on the scene', async ({ page }) => {
  await bootLevel(page);
  const result = await page.evaluate(async () => {
    const { Surface } = await import('/src/engine/surface.ts');
    const banner = await import('/src/ui/banner.ts');
    const sprites = await import('/src/ui/sprites.ts');
    const styled = await import('/src/ui/styled-text.ts');
    await sprites.preloadSprites(['menu_gem_small', 'turnbanner_player', 'phase_transition']);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const bbox = (surf: any): number[] => {
      const data = surf.getImageData();
      let x0 = Infinity; let y0 = Infinity; let x1 = -1; let y1 = -1;
      for (let y = 0; y < data.height; y++) {
        for (let x = 0; x < data.width; x++) {
          if (data.data[(y * data.width + x) * 4 + 3] > 0) {
            x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
          }
        }
      }
      return [x0, y0, x1 - x0 + 1, y1 - y0 + 1];
    };
    const text = banner.acquiredItemText('Phantom', 'Iron Sword');
    const b = new banner.Banner(text, { kind: 'item', iconNid: '', iconIndex: [0, 0] });
    // EOtF's window_display skin (menu_bg_base1, menu_gem_small1) loads on
    // first use; draw once to start those loads.
    b.draw(new Surface(240, 160));
    await new Promise((resolve) => setTimeout(resolve, 300));
    const surf = new Surface(240, 160);
    b.draw(surf);
    let length = styled.measureStyledText(text, 'text') + 16;
    length -= length % 8;
    length += 16;
    const phase = new banner.PhaseIn('player');
    for (let i = 0; i < 40; i++) phase.update();
    const phaseSurf = new Surface(240, 160);
    phase.draw(phaseSurf);
    return {
      text,
      box: bbox(surf),
      expectedW: length + 2,
      phaseBox: bbox(phaseSurf),
      phaseTopRow: phaseSurf.getPixel(8, 8)[3] > 0,
    };
  });
  expect(result.text).toBe('<blue>Phantom</> got an <blue>Iron Sword</>.');
  // Window (w + 2) x 28 with the gem at its top-left, blitted at the centre.
  expect(result.box[2]).toBe(result.expectedW);
  expect(result.box[0]).toBe(Math.floor(120 - result.expectedW / 2));
  expect(result.box[1]).toBe(Math.floor(80 - 28 / 2));
  // PhaseIn at ~667 ms: squares close in from the top edge.
  expect(result.phaseTopRow).toBe(true);
});

test('the unit panel lets map sprites show through like Python (the Act 2 "glyph")', async ({ page }, testInfo) => {
  // The playtest saw a faint shape before "L. T." on level 87. It is a
  // Fleet ship's white sail under the panel: unit_info_bg is 75% opaque
  // (alpha 191) in both the engine and the EOtF fork sprite, and Python's
  // create_unit_info blits it with per-pixel alpha over the map. The panel
  // surface itself carries nothing between the chibi and the name.
  await page.goto('/?harness=true&project=eotf.ltproj&level=87&clean=true&bundle=false');
  await page.waitForFunction(() => (window as any).__harness?.ready === true, undefined, { timeout: 90_000 });
  for (let i = 0; i < 60; i++) {
    await page.evaluate(() => (window as any).__harness.stepFrames(10, null));
    if (await page.evaluate(() => (window as any).__gameRef.state.getCurrentState()?.name) === 'free') break;
  }
  await page.evaluate(() => {
    const game = (window as any).__gameRef;
    const harness = (window as any).__harness;
    game.spawnUnit(game.db.units.get('Player'), 'player', [7, 2], 'None');
    harness.forceCameraPosition(0, 0);
    harness.warpUnit('Fleet_2', 3, 1); // sail under the name area
    game.cursor.setPos(7, 2);
    harness.stepFrames(30, null);
  });
  await page.waitForFunction(async () => {
    const sprites = await import('/src/ui/sprites.ts');
    await sprites.preloadSprites(['unit_info_bg']);
    const fonts = await import('/src/rendering/bmp-font.ts');
    return fonts.areFontsReady();
  });
  await page.waitForTimeout(800);

  const sample = () => page.evaluate(async () => {
    const game = (window as any).__gameRef;
    (window as any).__harness.stepFrames(3, null);
    const sprites = await import('/src/ui/sprites.ts');
    const bg = sprites.getSprite('unit_info_bg')!;
    const panel = game.hud.unitInfoDisp;
    const [px, py] = game.hud.layout.unit;
    // An empty stretch of the EOtF fork panel: right of the short name, above
    // the HP bar (the item icon row starts at x 38).
    const strip: [number, number, number, number] = [100, 26, 14, 10];
    let panelMatchesBg = true;
    for (let y = strip[1]; y < strip[1] + strip[3]; y++) {
      for (let x = strip[0]; x < strip[0] + strip[2]; x++) {
        if (panel.getPixel(x, y).join() !== bg.getPixel(x, y).join()) panelMatchesBg = false;
      }
    }
    const canvas = document.querySelector('canvas') as HTMLCanvasElement;
    const scale = canvas.width / 240;
    const data = canvas.getContext('2d')!.getImageData(
      (px + strip[0]) * scale, (py + strip[1]) * scale, strip[2] * scale, strip[3] * scale).data;
    return { panelMatchesBg, alpha: bg.getPixel(48, 12)[3], screen: Array.from(data) };
  });

  // Put the sail under the sampled strip of the panel (camera at 0,0).
  await page.evaluate(() => {
    const game = (window as any).__gameRef;
    const [px, py] = game.hud.layout.unit;
    (window as any).__harness.warpUnit('Fleet_2', Math.floor((px + 100) / 16), Math.floor((py + 26) / 16));
    (window as any).__harness.stepFrames(3, null);
  });
  const withShip = await sample();
  await page.locator('canvas').screenshot({ path: testInfo.outputPath('hud-panel-over-ship.png') });
  await page.evaluate(() => (window as any).__harness.warpUnit('Fleet_2', 12, 8));
  const withoutShip = await sample();
  await page.locator('canvas').screenshot({ path: testInfo.outputPath('hud-panel-over-sea.png') });

  expect(withShip.alpha).toBe(191);
  expect(withShip.panelMatchesBg).toBe(true);
  expect(withoutShip.panelMatchesBg).toBe(true);
  const changed = withShip.screen.filter((value, i) => value !== withoutShip.screen[i]).length;
  expect(changed).toBeGreaterThan(20);
});
