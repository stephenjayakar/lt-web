/**
 * Map presentation regressions players reported from the hosted build,
 * read off the rendered canvas.
 *
 * - Python health_bar.MapHealthBar lerps the bar under each map sprite to
 *   the unit's HP over max(200 ms, 16 ms per point); map_combat applies
 *   each phase's HP actions at its 'anim' step, so the bars under the
 *   fighters drain strike by strike. The port drew the bar from currentHp,
 *   which the map combat only sets when it ends: the bar stayed full for
 *   the whole combat and then jumped.
 * - Python AIState hides the cursor when the enemy phase starts and draws
 *   only the map. The hosted build outlined the acting AI unit's tile in
 *   red as it walked, and CombatState showed the cursor again after every
 *   combat, so it followed each later enemy (AIState parks it on them).
 */
import { expect, test, type Page } from '@playwright/test';

const step = (page: Page, frames: number, input: string | null = null) =>
  page.evaluate(({ frames, input }) => (window as any).__harness.stepFrames(frames, input), { frames, input });
const topState = (page: Page) =>
  page.evaluate(() => (window as any).__gameRef.state.getCurrentState()?.name as string);

/**
 * Filled pixels of the unit's map HP bar on the canvas: map_health_bar's
 * row at (left + 1.., top + 14) up to the first outline-colored pixel.
 * (Map combat lunges move the bar with the sprite.)
 */
const BAR_WIDTH_SRC = `
  async function barWidth(unit) {
    const g = window.__gameRef;
    const { viewport } = await import('/src/engine/viewport.ts');
    const { getUnitFx } = await import('/src/combat/map-unit-fx.ts');
    const [camX, camY] = g.camera.getOffset();
    // The bar moves with the sprite (combat lunge offsets).
    const [fxX, fxY] = getUnitFx(unit)?.offset ?? [0, 0];
    const left = Math.round(unit.position[0] * 16 - camX + fxX);
    const top = Math.round(unit.position[1] * 16 - camY + fxY);
    const canvas = document.querySelector('canvas');
    const scale = canvas.width / viewport.width;
    const sy = Math.floor((top + 14) * scale + scale / 2);
    const data = canvas.getContext('2d').getImageData(0, sy, canvas.width, 1).data;
    let width = 0;
    for (let x = 1; x <= 13; x++) {
      const i = Math.floor((left + x) * scale + scale / 2) * 4;
      if (data[i] === 64 && data[i + 1] === 56 && data[i + 2] === 56) break;
      width++;
    }
    return width;
  }
`;

async function bootLevel0(page: Page): Promise<void> {
  await page.goto('/?harness=true&project=eotf.ltproj&level=0&clean=true&bundle=false');
  await page.waitForFunction(() => (window as any).__harness?.ready === true, undefined, { timeout: 90_000 });
  await page.evaluate(() => (window as any).__harness.settle?.(600));
}

test.describe('map visuals', () => {
  test('map HP bars drain strike by strike during map combat (MapHealthBar)', async ({ page }) => {
    await bootLevel0(page);
    await page.evaluate(() => {
      const game = (window as any).__gameRef;
      const h = (window as any).__harness;
      const units = [...game.units.values()].filter((u: any) => u.position && !u.isDead() && u.team === 'enemy');
      const [attacker, defender] = units as any[];
      attacker.team = 'player';
      game.board.moveUnit(defender, attacker.position[0] + 1, attacker.position[1]);
      for (const unit of [attacker, defender]) {
        h.giveItem(unit.nid, 'Iron_Sword');
        unit.equippedWeapon = unit.items.find((item: any) => item.nid === 'Iron_Sword');
      }
      attacker.stats.HP = 30;
      attacker.currentHp = 30;
      defender.stats.HP = 12;
      defender.currentHp = 12;
      (window as any).__pair = [attacker, defender];
    });
    // Let the bars settle on the HP set above before the combat starts.
    await step(page, 30);
    await page.evaluate(() => {
      const game = (window as any).__gameRef;
      const [attacker, defender] = (window as any).__pair;
      game.selectedUnit = attacker;
      game.combatTarget = defender;
      game.combatScript = ['hit1', 'miss2'];
      game.state.change('combat');
    });
    const samples = await page.evaluate(async (src) => {
      const barWidth = new Function(`${src}; return barWidth;`)();
      const game = (window as any).__gameRef;
      const h = (window as any).__harness;
      const [, defender] = (window as any).__pair;
      const out: { inCombat: boolean; width: number; hp: number }[] = [];
      for (let frame = 0; frame < 600; frame++) {
        h.stepFrames(1, null);
        const inCombat = game.state.getStackNames().includes('combat');
        out.push({ inCombat, width: await barWidth(defender), hp: defender.currentHp });
        if (!inCombat && frame > 20 && out.length > 40 && !out[out.length - 30].inCombat) break;
      }
      return out;
    }, BAR_WIDTH_SRC);

    const full = samples[0].width;
    const finalHp = samples[samples.length - 1].hp;
    const finalWidth = Math.trunc(12 * finalHp / 12) + 1;
    expect(full, 'full bar before the strike').toBe(13);
    expect(finalHp).toBeLessThan(12);
    expect(samples[samples.length - 1].width).toBe(finalWidth);
    const inCombat = samples.filter((s) => s.inCombat);
    // The strike's damage shows on the map bar while the combat plays...
    expect(inCombat.some((s) => s.width === finalWidth), 'bar drained before the combat ended').toBe(true);
    // ...ticking down over frames rather than jumping.
    const between = new Set(inCombat.map((s) => s.width).filter((w) => w < full && w > finalWidth));
    expect(between.size, `intermediate widths ${[...between]}`).toBeGreaterThanOrEqual(2);
    // Never back up once drained.
    for (let i = 1; i < samples.length; i++) expect(samples[i].width).toBeLessThanOrEqual(samples[i - 1].width);
  });

  test('the map HP bar lerps to a changed HP instead of jumping', async ({ page }) => {
    await bootLevel0(page);
    const widths = await page.evaluate(async (src) => {
      const barWidth = new Function(`${src}; return barWidth;`)();
      const game = (window as any).__gameRef;
      const h = (window as any).__harness;
      const unit = [...game.units.values()].find((u: any) => u.position && u.team === 'enemy') as any;
      unit.stats.HP = 30;
      unit.currentHp = 30;
      h.stepFrames(30, null);
      const out = [await barWidth(unit)];
      // 30 -> 6: max(200, 24 * 16) = 384 ms, about 23 frames.
      unit.currentHp = 6;
      for (let i = 0; i < 30; i++) {
        h.stepFrames(1, null);
        out.push(await barWidth(unit));
      }
      return out;
    }, BAR_WIDTH_SRC);
    expect(widths[0]).toBe(13);
    expect(widths[1], 'first frame after the change').toBeGreaterThan(11);
    expect(widths[12], 'half way').toBeGreaterThan(4);
    expect(widths[12]).toBeLessThan(11);
    expect(widths[widths.length - 1]).toBe(Math.trunc(12 * 6 / 30) + 1);
  });

  test('enemy phase draws no cursor or marker box on the acting enemies', async ({ page }) => {
    await page.goto('/?harness=true&project=eotf.ltproj&level=87&clean=true&bundle=false');
    await page.waitForFunction(() => (window as any).__harness?.ready === true, undefined, { timeout: 90_000 });
    await page.evaluate(async () => {
      const g = (window as any).__gameRef;
      g.spawnUnit(g.db.units.get('Hetja'), 'player', [9, 5], 'None');
      const player = g.spawnUnit(g.db.units.get('Player'), 'player', [8, 3], 'None');
      player.stats.HP = 99;
      player.currentHp = 99;
      for (const unit of g.units.values()) if (unit.team === 'enemy') unit.ai = 'None';
      await g.loadAllMapSprites?.();
    });
    for (let i = 0; i < 100 && (await topState(page)) !== 'free'; i++) await step(page, 10);
    expect(await topState(page)).toBe('free');
    // Two enemies that walk a few tiles and attack, one after the other.
    const attackers = await page.evaluate(async () => {
      const g = (window as any).__gameRef;
      const h = (window as any).__harness;
      const found: string[] = [];
      for (const pos of [[8, 7], [6, 5], [11, 3], [5, 3], [10, 7], [4, 4]]) {
        if (found.length >= 2) break;
        if (g.board.getUnit(pos[0], pos[1])) continue;
        for (const nid of [...g.db.units.keys()] as string[]) {
          if (g.units.get(nid)) continue;
          const enemy = g.spawnUnit(g.db.units.get(nid), 'enemy', pos, 'Attack');
          if (!enemy) continue;
          enemy.aiGroup = '';
          const action = h.aiGetAction(enemy.nid);
          if (action?.type === 'attack' && action.movePathLength > 2) {
            await g.loadMapSpriteForUnit(enemy);
            found.push(enemy.nid);
            break;
          }
          g.board.removeUnit(enemy);
          g.units.delete(enemy.nid);
        }
      }
      return found;
    });
    expect(attackers.length).toBe(2);
    for (const [x, y] of [[9, 5], [8, 3]]) {
      await page.evaluate(({ x, y }) => (window as any).__gameRef.cursor.setPos(x, y), { x, y });
      await step(page, 1, 'SELECT');
      await step(page, 2);
      await step(page, 1, 'SELECT');
      await step(page, 8);
      await page.evaluate(() => {
        const s = (window as any).__gameRef.state.getCurrentState() as any;
        const menu = s.menu ?? s.child;
        menu.selectedIndex = menu.options.findIndex((o: any) => o.label === 'Wait');
      });
      await step(page, 1, 'SELECT');
      for (let i = 0; i < 30 && (await topState(page)) !== 'free' && x === 9; i++) await step(page, 8);
    }

    const result = await page.evaluate(async (nids) => {
      const g = (window as any).__gameRef;
      const h = (window as any).__harness;
      const { viewport } = await import('/src/engine/viewport.ts');
      const canvas = document.querySelector('canvas') as HTMLCanvasElement;
      const scale = canvas.width / viewport.width;
      /** Share of a tile's 2 px border that is drawn red. */
      const redRing = (tx: number, ty: number): number => {
        const [camX, camY] = g.camera.getOffset();
        const left = Math.round(tx * 16 - camX);
        const top = Math.round(ty * 16 - camY);
        const data = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
        let red = 0;
        let total = 0;
        for (let y = 0; y < 16; y++) {
          for (let x = 0; x < 16; x++) {
            if (x > 1 && x < 14 && y > 1 && y < 14) continue;
            const sx = Math.floor((left + x) * scale + scale / 2);
            const sy = Math.floor((top + y) * scale + scale / 2);
            if (sx < 0 || sy < 0 || sx >= canvas.width || sy >= canvas.height) continue;
            const i = (sy * canvas.width + sx) * 4;
            total++;
            if (data[i] >= 170 && data[i + 1] <= 130 && data[i + 2] <= 130 && data[i] - data[i + 1] >= 80) red++;
          }
        }
        return total ? red / total : 0;
      };
      let movingFrames = 0;
      let worstRing = 0;
      const cursorFrames: string[] = [];
      for (let frame = 0; frame < 1500; frame++) {
        h.stepFrames(1, null);
        const names: string[] = g.state.getStackNames();
        if (g.phase.getCurrent() !== 'enemy' || !names.includes('ai')) {
          if (frame > 100 && g.phase.getCurrent() === 'player') break;
          continue;
        }
        if (g.cursor.visible) cursorFrames.push(`${frame}:${names.join('>')}`);
        for (const nid of nids) {
          const unit = g.units.get(nid);
          if (!unit?.position || !g.movementSystem.isUnitMoving(unit)) continue;
          movingFrames++;
          const offset = g.movementSystem.getVisualOffset(unit) ?? [0, 0];
          worstRing = Math.max(worstRing, redRing(unit.position[0], unit.position[1]),
            redRing(unit.position[0] + offset[0], unit.position[1] + offset[1]));
        }
      }
      return { movingFrames, worstRing, cursorFrames: cursorFrames.slice(0, 5), cursorCount: cursorFrames.length };
    }, attackers);

    expect(result.movingFrames, 'both enemies walked').toBeGreaterThan(8);
    expect(result.cursorCount, `cursor drawn in the AI phase: ${result.cursorFrames}`).toBe(0);
    expect(result.worstRing, 'red box around a moving enemy').toBeLessThan(0.5);
  });
});
