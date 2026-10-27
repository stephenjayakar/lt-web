/**
 * Finished units draw their gray image, as Python unit_sprite.update_state
 * does (`if self.unit.finished and not self.unit.is_dying:
 * set_image_state('gray')`; EOtF's fork does not change this, and EOtF sets
 * autogenerate_grey_map_sprites).
 *
 * Regression: the map combat presentation set the sprite to 'moving' for the
 * combat pose every drawn frame, and the unit collector skipped any sprite
 * left in 'moving' (assuming the movement system owned it), so every unit
 * that had fought stayed in its moving/standing image after its turn: player
 * units after attacking or using an item, and enemies after the AI acted.
 *
 * The check reads the real rendered canvas: every opaque pixel of the drawn
 * sprite frame must be gray on screen for a finished unit, and colored for
 * one that has not acted.
 */
import { expect, test, type Page } from '@playwright/test';

async function step(page: Page, frames: number, input: string | null = null): Promise<void> {
  await page.evaluate(({ frames, input }) => (window as any).__harness.stepFrames(frames, input), { frames, input });
}

const stateName = (page: Page) =>
  page.evaluate(() => (window as any).__gameRef.state.getCurrentState()?.name as string);

/** EOtF level 87 with Hetja (stays unfinished) and the Player next to an enemy. */
async function boot(page: Page, setup: string = ''): Promise<void> {
  await page.goto('/?harness=true&project=eotf.ltproj&level=87&clean=true&bundle=false');
  await page.waitForFunction(() => (window as any).__harness?.ready === true, undefined, { timeout: 90_000 });
  await page.evaluate(async (extra) => {
    const g = (window as any).__gameRef;
    g.spawnUnit(g.db.units.get('Hetja'), 'player', [9, 5], 'None');
    const player = g.spawnUnit(g.db.units.get('Player'), 'player', [8, 3], 'None');
    const enemy = [...g.units.values()].find((u: any) => u.team === 'enemy' && u.position) as any;
    g.board.removeUnit(enemy);
    g.board.setUnit(8, 4, enemy);
    // Level 87 starts with no player units, so its first turn auto-ends and an
    // enemy phase runs before the test acts. Generics can wield their items
    // (Python calculate_needed_wexp_from_items), so keep this one passive.
    enemy.ai = 'None';
    (window as any).__enemyNid = enemy.nid;
    if (extra === 'canto') {
      const { SkillObject } = await import('/src/objects/skill.ts');
      // Plain Canto does not move after attacking; Canto_Plus does (as Python).
      player.skills.push(new SkillObject(g.db.skills.get('Canto_Plus')));
      player.stats.HP = 99;
      player.currentHp = 99;
    }
    if (extra === 'vulnerary') {
      const { ItemObject } = await import('/src/objects/item.ts');
      const item = new ItemObject(g.db.items.get('Vulnerary'));
      item.owner = player;
      player.items.unshift(item);
      g.items.set(`gray_${item.uid}`, item);
      player.currentHp = Math.max(1, player.currentHp - 8);
    }
    await g.loadAllMapSprites?.();
  }, setup);
  for (let i = 0; i < 80; i++) {
    await step(page, 10);
    if (await stateName(page) === 'free') break;
  }
  await page.waitForTimeout(300);
  await step(page, 5);
  expect(await stateName(page)).toBe('free');
}

async function openMenu(page: Page, x: number, y: number): Promise<void> {
  await page.evaluate(({ x, y }) => (window as any).__gameRef.cursor.setPos(x, y), { x, y });
  await step(page, 1, 'SELECT');
  await step(page, 2);
  await step(page, 1, 'SELECT');
  await step(page, 8);
}

async function choose(page: Page, label: string): Promise<void> {
  const ok = await page.evaluate((wanted) => {
    const s = (window as any).__gameRef.state.getCurrentState() as any;
    const menu = s.confirm ?? s.child ?? s.menu;
    const index = menu?.options?.findIndex((o: any) =>
      o.label === wanted || o.item?.nid === wanted || o.value?.nid === wanted || String(o.label ?? '').includes(wanted)) ?? -1;
    if (index < 0) return JSON.stringify([s.name, menu?.options?.map((o: any) => o.label)]);
    menu.selectedIndex = index;
    return true;
  }, label);
  expect(ok, `menu option ${label}`).toBe(true);
  await step(page, 1, 'SELECT');
  await step(page, 3);
}

async function settleFree(page: Page): Promise<void> {
  for (let i = 0; i < 200 && (await stateName(page)) !== 'free'; i++) {
    await step(page, 8, i % 3 === 0 ? 'SELECT' : null);
    await page.waitForTimeout(25);
  }
  expect(await stateName(page)).toBe('free');
}

/**
 * Fraction of the unit's drawn sprite pixels that are gray on the canvas
 * (the cursor is parked off the unit first).
 */
async function grayFraction(page: Page, nid: string): Promise<{ fraction: number; pixels: number; finished: boolean }> {
  await page.evaluate(() => {
    const g = (window as any).__gameRef;
    g.cursor.setPos(0, 0);
  });
  await step(page, 2);
  return page.evaluate(async (unitNid) => {
    const g = (window as any).__gameRef;
    const { viewport } = await import('/src/engine/viewport.ts');
    const unit = g.units.get(unitNid);
    const frame = unit.sprite.getCurrentFrame();
    const [camX, camY] = g.camera.getOffset();
    const left = unit.position[0] * 16 - camX - Math.max(0, Math.floor((frame.width - 16) / 2));
    const top = unit.position[1] * 16 - camY - 24;
    const canvas = document.querySelector('canvas') as HTMLCanvasElement;
    const scale = canvas.width / viewport.width;
    const screen = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height);
    const sprite = frame.getImageData();

    let pixels = 0;
    let gray = 0;
    for (let y = 0; y < frame.height; y++) {
      for (let x = 0; x < frame.width; x++) {
        const si = (y * sprite.width + x) * 4;
        if (sprite.data[si + 3] < 255) continue;
        // Skip the HP bar rows drawn over the tile (top + 13..14).
        const ty = top + y - (unit.position[1] * 16 - camY);
        if (ty === 13 || ty === 14) continue;
        const sx = Math.floor((left + x) * scale + scale / 2);
        const sy = Math.floor((top + y) * scale + scale / 2);
        if (sx < 0 || sy < 0 || sx >= canvas.width || sy >= canvas.height) continue;
        const i = (sy * canvas.width + sx) * 4;
        const [r, gg, b] = [screen.data[i], screen.data[i + 1], screen.data[i + 2]];
        pixels++;
        if (Math.max(r, gg, b) - Math.min(r, gg, b) <= 10) gray++;
      }
    }
    return { fraction: pixels ? gray / pixels : 0, pixels, finished: !!unit.finished };
  }, nid);
}

async function expectGray(page: Page, nid: string): Promise<void> {
  const result = await grayFraction(page, nid);
  expect(result.finished, `${nid} finished`).toBe(true);
  expect(result.pixels).toBeGreaterThan(20);
  expect(result.fraction, `${nid} draws gray`).toBeGreaterThan(0.95);
}

async function expectColored(page: Page, nid: string): Promise<void> {
  const result = await grayFraction(page, nid);
  expect(result.finished).toBe(false);
  expect(result.fraction, `${nid} draws in color`).toBeLessThan(0.8);
}

test.describe('finished units draw gray (unit_sprite.update_state)', () => {
  test('after Wait', async ({ page }) => {
    await boot(page);
    await openMenu(page, 8, 3);
    await choose(page, 'Wait');
    await settleFree(page);
    await expectGray(page, 'Player');
    await expectColored(page, 'Hetja');
  });

  test('after attacking (map combat pose)', async ({ page }) => {
    await boot(page);
    await openMenu(page, 8, 3);
    await choose(page, 'Attack');
    await settleFree(page);
    // Move the (surviving) enemy below away so its sprite does not overlap.
    await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const enemy = g.units.get((window as any).__enemyNid);
      if (enemy?.position) {
        g.board.removeUnit(enemy);
        g.board.setUnit(1, 1, enemy);
      }
    });
    await expectGray(page, 'Player');
    await expectColored(page, 'Hetja');
    await page.screenshot({ path: test.info().outputPath('after-attack.png') });
  });

  test('after Canto ends (attack, canto move, Wait)', async ({ page }) => {
    await boot(page, 'canto');
    // (8,3) is boxed in; move the Player and its enemy to open ground.
    const start = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const player = g.units.get('Player');
      const enemy = g.units.get((window as any).__enemyNid);
      for (let y = 2; y < g.board.height - 2; y++) {
        for (let x = 2; x < g.board.width - 2; x++) {
          if (g.board.getUnit(x, y) || g.board.getUnit(x, y + 1)) continue;
          g.board.removeUnit(player);
          g.board.setUnit(x, y, player);
          g.board.removeUnit(enemy);
          g.board.setUnit(x, y + 1, enemy);
          const moves = g.pathSystem.getValidMoves(player, g.board) as [number, number][];
          if (moves.filter(([mx, my]) => !g.board.getUnit(mx, my)).length >= 4) return [x, y];
        }
      }
      return null;
    });
    expect(start).not.toBeNull();
    await openMenu(page, start![0], start![1]);
    await choose(page, 'Attack');
    // Resolve the combat; Canto then reopens the move state.
    for (let i = 0; i < 200; i++) {
      const top = await stateName(page);
      if (top === 'move') break;
      await step(page, 8, ['combat', 'targeting', 'weapon_choice'].includes(top) && i % 3 === 0 ? 'SELECT' : null);
      await page.waitForTimeout(25);
    }
    expect(await stateName(page)).toBe('move');
    const dest = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const unit = g.units.get('Player');
      const moves = (g.state.getCurrentState().validMoves ?? []) as [number, number][];
      if (!moves.length) return { none: true, left: unit.movementLeft, stack: g.state.getStackNames() } as any;
      const target = moves.find(([x, y]) => (x !== unit.position[0] || y !== unit.position[1]) && !g.board.getUnit(x, y) && y < unit.position[1]) ??
        moves.find(([x, y]) => (x !== unit.position[0] || y !== unit.position[1]) && !g.board.getUnit(x, y));
      if (!target) return { none: true, moves, pos: unit.position, left: unit.movementLeft } as any;
      g.cursor.setPos(target[0], target[1]);
      return target;
    });
    expect((dest as any).none, JSON.stringify(dest)).toBeUndefined();
    await step(page, 1, 'SELECT');
    for (let i = 0; i < 60 && !['canto_wait', 'menu'].includes(await stateName(page)); i++) await step(page, 4);
    await step(page, 3);
    await choose(page, 'Wait');
    await settleFree(page);
    expect(await page.evaluate(() => (window as any).__gameRef.units.get('Player').position)).toEqual(dest);
    await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const enemy = g.units.get((window as any).__enemyNid);
      if (enemy?.position) {
        g.board.removeUnit(enemy);
        g.board.setUnit(1, 1, enemy);
      }
    });
    await expectGray(page, 'Player');
  });

  test('after using an item', async ({ page }) => {
    await boot(page, 'vulnerary');
    await openMenu(page, 8, 3);
    await choose(page, 'Item');
    await choose(page, 'Vulnerary');
    await choose(page, 'Use');
    await settleFree(page);
    await expectGray(page, 'Player');
  });

  test('enemies that have attacked draw gray during the enemy phase', async ({ page }) => {
    await boot(page);
    const attacker = await page.evaluate(async () => {
      const g = (window as any).__gameRef;
      const h = (window as any).__harness;
      const player = g.units.get('Player');
      player.stats.HP = 99;
      player.currentHp = 99;
      // An AI unit that does nothing does not wait (Python too), so put an
      // enemy that attacks the Player from (8,4) there.
      const placed = g.units.get((window as any).__enemyNid);
      g.board.removeUnit(placed);
      g.board.setUnit(1, 1, placed);
      for (const nid of [...g.db.units.keys()] as string[]) {
        if (g.units.get(nid)) continue;
        const enemy = g.spawnUnit(g.db.units.get(nid), 'enemy', [8, 4], 'Attack');
        if (!enemy) continue;
        enemy.aiGroup = '';
        if (h.aiGetAction(enemy.nid)?.type === 'attack') {
          await g.loadMapSpriteForUnit(enemy);
          return enemy.nid;
        }
        g.board.removeUnit(enemy);
        g.units.delete(enemy.nid);
      }
      return null;
    });
    expect(attacker, 'an enemy that attacks from (8,4)').not.toBeNull();
    // Hetja and the Player wait; the player phase ends on its own.
    await openMenu(page, 9, 5);
    await choose(page, 'Wait');
    await settleFree(page);
    await openMenu(page, 8, 3);
    await choose(page, 'Wait');
    let finishedInAi = false;
    for (let i = 0; i < 1600 && !finishedInAi; i++) {
      await step(page, 1);
      if (i % 4 === 0) await page.waitForTimeout(5);
      finishedInAi = await page.evaluate((nid) => {
        const g = (window as any).__gameRef;
        const unit = g.units.get(nid);
        return g.phase?.getCurrent?.() === 'enemy' && g.state.getCurrentState()?.name === 'ai' &&
          !!unit?.finished && !unit.dead && !g.movementSystem.isUnitMoving(unit);
      }, attacker);
    }
    expect(finishedInAi, 'the attacker finished its action in the AI phase').toBe(true);
    await step(page, 1);
    const sprite = await page.evaluate((nid) => (window as any).__gameRef.units.get(nid).sprite.state, attacker);
    expect(sprite).toBe('gray');
  });
});
