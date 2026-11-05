/**
 * fork-ui-screens.spec.ts: screens compared against the EOtF fork oracle
 * (tools/oracle shots of the same EX_2 scenes):
 *
 * - the boss/rescue/droppable icon is blitted at (left - 8, top - 8) of the
 *   unit's tile (unit_sprite.py draw_hp); the web drew it 8 px right/down;
 * - the info menu and the map Supply screen open through transition_to and
 *   fade in (transition_in), and BACK leaves through transition_pop;
 * - the fork's info menu portrait is the plain portrait (no smile);
 * - the fork's objective menu puts the leader's map sprite at x 124 and
 *   right-aligns the name 42 px in;
 * - MenuState.begin puts the cursor back on the unit, so the unit menu
 *   reopened after a trade sits against the unit again.
 */
import { expect, test, type Page } from '@playwright/test';

test.describe.configure({ mode: 'parallel' });
test.use({ launchOptions: { args: ['--mute-audio'] } });

async function boot(page: Page): Promise<void> {
  await page.goto('/?harness=true&project=eotf.ltproj&level=EX_2&clean=true&bundle=false');
  await page.waitForFunction(() => (window as any).__harness?.ready === true, undefined, { timeout: 90_000 });
  await page.evaluate(() => {
    const g = (window as any).__gameRef;
    g.eventManager.trigger = () => false;
    (window as any).__harness.stepFrames(5, null);
  });
}

const step = (page: Page, frames: number, input: string | null = null) =>
  page.evaluate(({ frames, input }) => (window as any).__harness.stepFrames(frames, input), { frames, input });

const top = (page: Page, n = 1) =>
  page.evaluate((n) => (window as any).__gameRef.state.getStackNames().slice(-n), n);

/** The canvas in game pixels (RGB rows of 240). */
const grab = (page: Page) => page.evaluate(() => {
  const canvas = document.querySelector('canvas') as HTMLCanvasElement;
  const scale = canvas.width / 240;
  const ctx = canvas.getContext('2d')!;
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  const out: number[] = [];
  for (let y = 0; y < 160; y++) {
    for (let x = 0; x < 240; x++) {
      const i = ((y * scale + Math.floor(scale / 2)) * canvas.width + x * scale + Math.floor(scale / 2)) * 4;
      out.push(data[i], data[i + 1], data[i + 2]);
    }
  }
  return out;
});

function diffBox(a: number[], b: number[]): [number, number, number, number] | null {
  let box: [number, number, number, number] | null = null;
  for (let y = 0; y < 160; y++) {
    for (let x = 0; x < 240; x++) {
      const i = (y * 240 + x) * 3;
      if (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) > 30) {
        if (!box) box = [x, y, x, y];
        else box = [Math.min(box[0], x), Math.min(box[1], y), Math.max(box[2], x), Math.max(box[3], y)];
      }
    }
  }
  return box;
}

test('the boss icon is blitted at (left - 8, top - 8) of the tile', async ({ page }) => {
  await boot(page);
  const info = await page.evaluate(async () => {
    const g = (window as any).__gameRef;
    const dragon = g.units.get('Dragon');
    const [ox, oy] = g.camera.getOffset();
    // The icon's opaque bounds.
    const icon = g.unitMarkers.bossIcon as HTMLImageElement;
    const c = document.createElement('canvas');
    c.width = icon.width; c.height = icon.height;
    const ctx = c.getContext('2d')!;
    ctx.drawImage(icon, 0, 0);
    const px = ctx.getImageData(0, 0, c.width, c.height).data;
    let box: number[] | null = null;
    for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
      if (px[(y * c.width + x) * 4 + 3] > 0) {
        box = box ? [Math.min(box[0], x), Math.min(box[1], y), Math.max(box[2], x), Math.max(box[3], y)] : [x, y, x, y];
      }
    }
    return {
      boss: dragon.tags.includes('Boss'),
      left: Math.round(dragon.position[0] * 16 - ox),
      top: Math.round(dragon.position[1] * 16 - oy),
      iconBox: box,
    };
  });
  expect(info.boss).toBe(true);
  // Same frame, same clock: once with the icon's blink phase on (150-449 ms
  // into the 450 ms cycle), once with the tag cleared.
  await page.evaluate(() => {
    const real = performance.now.bind(performance);
    (window as any).__realNow = real;
    performance.now = () => 900 + 200;
  });
  await step(page, 1);
  const shown = await grab(page);
  await page.evaluate(() => {
    const g = (window as any).__gameRef;
    const dragon = g.units.get('Dragon');
    dragon.tags = dragon.tags.filter((t: string) => t !== 'Boss');
  });
  await step(page, 1);
  const hidden = await grab(page);
  const box = diffBox(shown, hidden);
  expect(box).not.toBeNull();
  const ib = info.iconBox!;
  expect(box).toEqual([info.left - 8 + ib[0], info.top - 8 + ib[1], info.left - 8 + ib[2], info.top - 8 + ib[3]]);
});

test('INFO on a map unit opens the info menu through the fades, with the plain fork portrait', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => {
    const g = (window as any).__gameRef;
    const yusha = g.units.get('Yusha');
    g.cursor.setPos(yusha.position[0], yusha.position[1]);
  });
  // FreeState _handle_info: next_state info_menu + transition_to in the
  // INFO frame (0); its 133 ms run out on frame 9, where info_menu starts
  // and fades in (transition_in, 8 more frames).
  await step(page, 1, 'INFO');
  await step(page, 8);
  expect(await top(page)).toEqual(['transition_to']);
  await step(page, 1);
  expect(await top(page, 2)).toEqual(['info_menu', 'transition_in']);
  await step(page, 8);
  expect(await top(page)).toEqual(['info_menu']);

  // The portrait panel (x 8, y 8, 80x72) is the sheet's face rows from
  // info_offset, without upstream's smile overlay.
  const portrait = await page.evaluate(async () => {
    const g = (window as any).__gameRef;
    const { getPortrait } = await import('/src/ui/menu-chrome.ts');
    const unit = g.units.get('Yusha');
    const meta = g.db.portraits.get(unit.portraitNid);
    const sheet = getPortrait(g.resources, unit.portraitNid) as HTMLImageElement | HTMLCanvasElement;
    const c = document.createElement('canvas');
    c.width = 128; c.height = 112;
    const sctx = c.getContext('2d')!;
    sctx.drawImage(sheet as CanvasImageSource, 0, 0);
    const offset = Number(meta?.info_offset ?? 0);
    const src = sctx.getImageData(8, offset, 80, 72).data;
    const canvas = document.querySelector('canvas') as HTMLCanvasElement;
    const scale = canvas.width / 240;
    const ctx = canvas.getContext('2d')!;
    const dst = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let opaque = 0;
    let mismatched = 0;
    for (let y = 0; y < 72; y++) for (let x = 0; x < 80; x++) {
      const s = (y * 80 + x) * 4;
      const [r, gg, b, a] = [src[s], src[s + 1], src[s + 2], src[s + 3]];
      // Opaque, non-colourkey pixels only.
      if (a < 255 || (r === 128 && gg === 160 && b === 128)) continue;
      opaque++;
      const d = (((8 + y) * scale + Math.floor(scale / 2)) * canvas.width + (8 + x) * scale + Math.floor(scale / 2)) * 4;
      if (Math.abs(dst[d] - r) + Math.abs(dst[d + 1] - gg) + Math.abs(dst[d + 2] - b) > 12) mismatched++;
    }
    return { opaque, mismatched };
  });
  expect(portrait.opaque).toBeGreaterThan(1000);
  expect(portrait.mismatched).toBe(0);

  // BACK leaves through transition_pop.
  await step(page, 1, 'BACK');
  expect(await top(page)).toEqual(['transition_pop']);
  await step(page, 9);
  const after = await top(page, 3);
  expect(after).not.toContain('info_menu');
  expect(after).toContain('free');
});

test('the fork objective menu draws the leader map sprite at x 124', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => {
    (window as any).__gameRef.state.change('objective_menu');
  });
  await step(page, 12);
  expect(await top(page)).toEqual(['objective_menu']);
  // Hold the sprite's animation clock for the comparison.
  await page.evaluate(() => { performance.now = () => 5000; });
  await step(page, 1);
  const result = await page.evaluate(async () => {
    const g = (window as any).__gameRef;
    const { passiveFrame } = await import('/src/ui/menu-chrome.ts');
    const leader = g.state.getCurrentState().partyLeader();
    const frame = passiveFrame(leader.sprite) as any;
    const fc = frame.canvas as HTMLCanvasElement;
    const src = fc.getContext('2d')!.getImageData(0, 0, fc.width, fc.height).data;
    const fscale = fc.width / frame.width;
    const canvas = document.querySelector('canvas') as HTMLCanvasElement;
    const scale = canvas.width / 240;
    const dst = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
    const at = (ox: number) => {
      let opaque = 0;
      let mismatched = 0;
      for (let y = 0; y < frame.height; y++) for (let x = 0; x < frame.width; x++) {
        const s = ((y * fscale) * fc.width + x * fscale) * 4;
        if (src[s + 3] < 255) continue;
        opaque++;
        const d = (((82 + y) * scale + Math.floor(scale / 2)) * canvas.width + (ox + x) * scale + Math.floor(scale / 2)) * 4;
        if (Math.abs(dst[d] - src[s]) + Math.abs(dst[d + 1] - src[s + 1]) + Math.abs(dst[d + 2] - src[s + 2]) > 12) mismatched++;
      }
      return { opaque, mismatched };
    };
    return { fork: at(124), upstream: at(116) };
  });
  expect(result.fork.opaque).toBeGreaterThan(50);
  expect(result.fork.mismatched).toBe(0);
  expect(result.upstream.mismatched).toBeGreaterThan(10);
});

test('MenuState.begin puts the cursor back on the unit', async ({ page }) => {
  await boot(page);
  const result = await page.evaluate(() => {
    const g = (window as any).__gameRef;
    const h = (window as any).__harness;
    const yusha = g.units.get('Yusha');
    g.selectedUnit = yusha;
    g._moveOrigin = [...yusha.position];
    // As after a trade or targeting: the cursor was left elsewhere.
    g.cursor.setPos(0, 0);
    g.state.change('menu');
    h.stepFrames(2, null);
    const hover = g.cursor.getHover();
    return { stack: g.state.getStackNames().slice(-1), cursor: [hover.x, hover.y], unit: yusha.position };
  });
  expect(result.stack).toEqual(['menu']);
  expect(result.cursor).toEqual(result.unit);
});
