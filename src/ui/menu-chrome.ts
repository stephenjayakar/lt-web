/**
 * menu-chrome.ts — shared Python menu widgets for full-screen menu states.
 *
 * Ports the small pieces of LT's engine that every menu screen leans on:
 *   - SPRITES lookup (app/sprites.py + custom_sprites overrides)
 *   - menus.Cursor (the bobbing menu hand)
 *   - counters.arrow_counter / gui.ScrollArrow / gui.ScrollBar
 *   - FONT[...] blit helpers with a CSS fallback while fonts are loading
 *
 * Sprites load lazily; callers draw nothing for a sprite until it arrives,
 * mirroring how the rest of the web UI degrades while assets stream in.
 */

import { Surface } from '../engine/surface';
import { FRAMETIME, WINHEIGHT, WINWIDTH } from '../engine/constants';
import { viewport } from '../engine/viewport';
import { FONT } from '../rendering/bmp-font';
import { getMenuBackgroundSync } from './base-surf';

// ---------------------------------------------------------------------------
// SPRITES
// ---------------------------------------------------------------------------

interface SpriteResources {
  loadImage?(path: string): Promise<HTMLImageElement>;
}

const spriteCache: Map<string, HTMLImageElement | null> = new Map();

function loadUrl(url: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

/**
 * Python SPRITES.get(nid). `path` is relative to the engine `sprites/`
 * folder (e.g. 'menus/menu_hand', 'info_menu/info_hp'); Python indexes the
 * folder recursively by basename, so the project `custom_sprites/<basename>`
 * override is tried first when resources are supplied.
 */
export function getSprite(path: string, resources?: SpriteResources | null): HTMLImageElement | null {
  if (spriteCache.has(path)) return spriteCache.get(path) ?? null;
  spriteCache.set(path, null);
  const base = path.split('/').pop() ?? path;
  const load = async (): Promise<HTMLImageElement | null> => {
    if (resources?.loadImage) {
      const custom = await resources.loadImage(`resources/custom_sprites/${base}.png`).catch(() => null);
      if (custom) return custom;
    }
    return loadUrl(`/game-data/sprites/${path}.png`);
  };
  void load().then((img) => {
    if (img) spriteCache.set(path, img);
  });
  return null;
}

/** Start loading sprites ahead of their first draw. */
export function preloadSprites(paths: string[], resources?: SpriteResources | null): void {
  for (const path of paths) getSprite(path, resources);
}

/** Blit a sub-rectangle of a sprite (engine.subsurface + blit). */
export function blitSub(
  surf: Surface,
  img: HTMLImageElement | null,
  sx: number, sy: number, sw: number, sh: number,
  dx: number, dy: number,
): void {
  if (!img) return;
  surf.blitImage(img, sx, sy, sw, sh, dx, dy);
}

/** Blit a whole sprite at (x, y). */
export function blitSprite(surf: Surface, img: HTMLImageElement | null, x: number, y: number): void {
  if (!img) return;
  surf.blitImage(img, 0, 0, img.width, img.height, x, y);
}

/** Blit a sprite with Python make_translucent(t): t=0 opaque, t=1 invisible. */
export function blitTranslucent(
  surf: Surface,
  img: HTMLImageElement | null,
  x: number, y: number, transparency: number,
): void {
  if (!img) return;
  const prev = surf.getAlpha();
  surf.setAlpha(Math.max(0, Math.min(1, 1 - transparency)));
  surf.blitImage(img, 0, 0, img.width, img.height, x, y);
  surf.setAlpha(prev);
}

// ---------------------------------------------------------------------------
// Fonts
// ---------------------------------------------------------------------------

/** FONT[nid].width(text), with a rough estimate before fonts load. */
export function textWidth(font: string, text: string): number {
  const f = FONT[font];
  return f ? f.width(text) : text.length * 6;
}

/** FONT[font].blit(text, surf, (x, y)). */
export function blitText(surf: Surface, font: string, text: string, x: number, y: number, color?: string): void {
  const f = FONT[font];
  if (f) f.blit(surf, text, x, y, color);
  else surf.drawText(text, x, y, 'white', font);
}

/** FONT[font].blit_center(text, surf, (x, y)): centered on x. */
export function blitTextCenter(surf: Surface, font: string, text: string, x: number, y: number, color?: string): void {
  const w = textWidth(font, text);
  blitText(surf, font, text, x - Math.floor(w / 2), y, color);
}

/** FONT[font].blit_right(text, surf, (x, y)): text ends at x. */
export function blitTextRight(surf: Surface, font: string, text: string, x: number, y: number, color?: string): void {
  blitText(surf, font, text, x - textWidth(font, text), y, color);
}

// ---------------------------------------------------------------------------
// menus.Cursor
// ---------------------------------------------------------------------------

const CURSOR_ANIM = [0, 0, 0, 0, 0, 0, 0, 1, 1, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 4, 4, 4, 3, 3, 2, 2, 2, 1, 1, 1, 1];

/** Python menus.Cursor: the menu hand, bobbing horizontally. */
export class MenuCursor {
  counter = 0;
  yOffset = 0;
  private spritePath: string;

  constructor(spritePath = 'menus/menu_hand') {
    this.spritePath = spritePath;
  }

  yOffsetUp(): void { this.yOffset = 12; }
  yOffsetDown(): void { this.yOffset = -12; }

  update(): void {
    this.counter = (this.counter + 1) % CURSOR_ANIM.length;
  }

  private updateYOffset(): void {
    if (this.yOffset > 0) this.yOffset = Math.max(0, this.yOffset - 4);
    else if (this.yOffset < 0) this.yOffset = Math.min(0, this.yOffset + 4);
  }

  draw(surf: Surface, x: number, y: number): void {
    blitSprite(surf, getSprite(this.spritePath), x - 12 + CURSOR_ANIM[this.counter], y + 3 + this.yOffset);
    this.updateYOffset();
  }

  drawVert(surf: Surface, x: number, y: number): void {
    blitSprite(surf, getSprite(this.spritePath), x - 12, y + 3 + this.yOffset + CURSOR_ANIM[this.counter]);
    this.updateYOffset();
  }
}

// ---------------------------------------------------------------------------
// counters.arrow_counter / gui.ScrollArrow / gui.ScrollBar
// ---------------------------------------------------------------------------

/** Python counters.arrow_counter. */
export class ArrowCounter {
  private value: number;
  private increment: number[] = [];

  constructor(offset = 0) {
    this.value = offset;
  }

  update(): void {
    if (this.increment.length) this.value += this.increment.pop() as number;
    else this.value += 0.125;
    if (this.value >= 6) this.value = 0;
  }

  get(): number {
    return Math.floor(this.value);
  }

  pulse(): void {
    this.increment = [1, 1, 1, 1, 1, 1, 1, 1, 0.5, 0.5, 0.5, 0.5, 0.25, 0.25, 0.25];
  }
}

export type ScrollDirection = 'up' | 'down' | 'left' | 'right';

/** Draw a sprite region rotated 180 degrees (flip_horiz(flip_vert(...))). */
function blitRotated180(
  surf: Surface, img: HTMLImageElement,
  sx: number, sy: number, sw: number, sh: number, dx: number, dy: number,
): void {
  const ctx = surf.ctx;
  const s = surf.scale;
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.globalAlpha = surf.getAlpha();
  ctx.translate(Math.round((dx + sw) * s), Math.round((dy + sh) * s));
  ctx.scale(-1, -1);
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, Math.round(sw * s), Math.round(sh * s));
  ctx.restore();
}

/** Python gui.ScrollArrow. */
export class ScrollArrow {
  x: number;
  y: number;
  direction: ScrollDirection;
  private counter: ArrowCounter;
  private offset: number[] = [];

  constructor(direction: ScrollDirection, x = 0, y = 0, offset = 0) {
    this.direction = direction;
    this.x = x;
    this.y = y;
    this.counter = new ArrowCounter(offset);
  }

  pulse(): void {
    this.counter.pulse();
    this.offset = [4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 3, 3, 3, 3, 2, 2, 2, 1, 1];
  }

  draw(surf: Surface): void {
    this.counter.update();
    const bump = this.offset.length ? (this.offset.shift() as number) : 0;
    const frame = this.counter.get();
    if (this.direction === 'up' || this.direction === 'down') {
      const img = getSprite('scroll_arrows');
      if (!img) return;
      // The down image is the up sheet rotated 180 degrees, so frame N of the
      // rotated sheet is source row (5 - N).
      if (this.direction === 'up') {
        surf.blitImage(img, 0, frame * 8, 14, 8, this.x, this.y - bump);
      } else {
        blitRotated180(surf, img, 0, img.height - (frame + 1) * 8, 14, 8, this.x, this.y + bump);
      }
    } else {
      const img = getSprite('page_arrows');
      if (!img) return;
      if (this.direction === 'left') {
        surf.blitImage(img, frame * 8, 0, 8, 14, this.x - bump, this.y);
      } else {
        blitRotated180(surf, img, img.width - (frame + 1) * 8, 0, 8, 14, this.x + bump, this.y);
      }
    }
  }
}

/** Python gui.ScrollBar. */
export class ScrollBar {
  private counter = new ArrowCounter();

  draw(
    surf: Surface,
    topRightX: number, topRightY: number,
    scroll: number, limit: number, numOptions: number, optionHeight = 16,
  ): void {
    this.counter.update();
    const img = getSprite('scroll_bar');
    if (!img) return;
    const x = topRightX - 9;
    const y = topRightY + 12;
    const height = limit * optionHeight - 20;
    const startFraction = scroll / numOptions;
    const endFraction = Math.min(1, (scroll + limit) / numOptions);

    surf.blitImage(img, 0, 0, 7, 1, x, y);
    surf.blitImage(img, 0, 2, 7, 1, x, y + height + 2);
    for (let num = 1; num < height + 2; num++) surf.blitImage(img, 0, 1, 7, 1, x, y + num);

    const startPos = Math.floor(startFraction * height);
    const endPos = Math.floor(endFraction * height);
    for (let num = startPos; num <= endPos; num++) surf.blitImage(img, 0, 3, 7, 1, x, y + num + 1);

    const frame = this.counter.get();
    if (startPos > 0) surf.blitImage(img, 8, 4 + frame * 6, 8, 6, x - 1, y - 7);
    if (endPos < height) surf.blitImage(img, 0, 4 + frame * 6, 8, 6, x - 1, y + height + 4);
  }
}

// ---------------------------------------------------------------------------
// 240x160 scene placement
// ---------------------------------------------------------------------------

/**
 * Python lays every menu out on a fixed WINWIDTH x WINHEIGHT window. The web
 * viewport can be wider or taller, so menu states draw their Python layout
 * into a 240x160 scene surface and present it centered; backgrounds still
 * cover the whole viewport.
 */
export class MenuScene {
  readonly surf = new Surface(WINWIDTH, WINHEIGHT);

  /** Clear the scene for a new frame and return it. */
  begin(): Surface {
    this.surf.clear();
    return this.surf;
  }

  /** Top-left of the centered scene in viewport coordinates. */
  static origin(): { x: number; y: number } {
    return {
      x: Math.floor((viewport.width - WINWIDTH) / 2),
      y: Math.floor((viewport.height - WINHEIGHT) / 2),
    };
  }

  /** Blit the scene centered onto the viewport surface. */
  present(target: Surface): void {
    const { x, y } = MenuScene.origin();
    target.blit(this.surf, x, y);
  }
}

// ---------------------------------------------------------------------------
// background.create_background
// ---------------------------------------------------------------------------

interface PanoramaResources {
  loadImage?(path: string): Promise<HTMLImageElement>;
  tryLoadJsonSilent?<T>(path: string): Promise<T | null>;
}

/**
 * Python background.create_background(nid, scroll=True): a panorama from
 * resources/panoramas, falling back to default_background. Single-frame
 * panoramas scroll horizontally (ScrollingBackground, 50 ms per pixel);
 * multi-frame ones animate at 125 ms per frame (PanoramaBackground).
 */
export class MenuBackground {
  private frames: HTMLImageElement[] = [];
  private elapsed = 0;
  private scroll: boolean;
  /** ScrollingBackground.scroll_speed after create_background's override. */
  scrollSpeed = 50;
  /** PanoramaBackground.speed */
  frameSpeed = 125;

  constructor(nid: string, resources: PanoramaResources | null | undefined, scroll = true) {
    this.scroll = scroll;
    void this.load(nid, resources);
  }

  get loaded(): boolean {
    return this.frames.length > 0;
  }

  private async load(nid: string, resources: PanoramaResources | null | undefined): Promise<void> {
    if (!resources?.loadImage) return;
    const entries = await resources.tryLoadJsonSilent?.<unknown[]>('resources/panoramas/panoramas.json')
      .catch(() => null) ?? null;
    const frameCount = (name: string): number | null => {
      if (!Array.isArray(entries)) return 1;
      for (const entry of entries) {
        if (Array.isArray(entry) && entry[0] === name) return Number(entry[1]) || 1;
        if (entry && typeof entry === 'object' && (entry as { nid?: string }).nid === name) {
          return Number((entry as { num_frames?: number }).num_frames) || 1;
        }
      }
      return null;
    };
    for (const name of [nid, 'default_background']) {
      const count = frameCount(name);
      if (count === null) continue;
      const frames: HTMLImageElement[] = [];
      if (count > 1) {
        for (let i = 0; i < count; i++) {
          const img = await resources.loadImage(`resources/panoramas/${name}${i}.png`).catch(() => null);
          if (img) frames.push(img);
        }
      } else {
        const img = await resources.loadImage(`resources/panoramas/${name}.png`).catch(() => null);
        if (img) frames.push(img);
      }
      if (frames.length) {
        this.frames = frames;
        return;
      }
    }
  }

  /** Advance one engine frame. */
  update(dtMs = FRAMETIME): void {
    this.elapsed += dtMs;
  }

  /** Draw covering the whole viewport (scene-centered). */
  draw(surf: Surface): void {
    if (!this.frames.length) {
      surf.fill(0, 0, 0);
      return;
    }
    const { x: ox, y: oy } = MenuScene.origin();
    if (this.frames.length === 1 && this.scroll) {
      const image = this.frames[0];
      const width = image.width;
      const counter = (this.elapsed / this.scrollSpeed) % width;
      if (oy > 0 || image.height < viewport.height) surf.fill(0, 0, 0);
      let x = ox - counter;
      while (x > 0) x -= width;
      for (; x < viewport.width; x += width) {
        surf.blitImage(image, 0, 0, image.width, image.height, x, oy);
      }
      return;
    }
    const idx = Math.floor(this.elapsed / this.frameSpeed) % this.frames.length;
    const image = this.frames[idx];
    // PanoramaBackground autoscales to WINWIDTH x WINHEIGHT and centers;
    // stretch to cover the viewport so nothing shows around the edges.
    const coverScale = Math.max(viewport.width / WINWIDTH, viewport.height / WINHEIGHT);
    const dw = WINWIDTH * coverScale;
    const dh = WINHEIGHT * coverScale;
    const s = surf.scale;
    surf.ctx.imageSmoothingEnabled = false;
    surf.ctx.drawImage(
      image, 0, 0, image.width, image.height,
      Math.round(((viewport.width - dw) / 2) * s), Math.round(((viewport.height - dh) / 2) * s),
      Math.round(dw * s), Math.round(dh * s),
    );
  }
}

/** Python base_surf.create_base_surf (cached nine-slice window). */
export function baseSurf(width: number, height: number, nid = 'menu_bg_base'): Surface {
  return getMenuBackgroundSync(width, height, nid);
}

/** Blit a base surf with image_mods.make_translucent(t) applied. */
export function blitBaseSurf(
  surf: Surface, width: number, height: number, nid: string, x: number, y: number, transparency = 0,
): void {
  const bg = baseSurf(width, height, nid);
  const alpha = bg.getAlpha();
  bg.setAlpha(Math.max(0, Math.min(1, 1 - transparency)));
  surf.blit(bg, x, y);
  bg.setAlpha(alpha);
}

// ---------------------------------------------------------------------------
// text_funcs.line_wrap
// ---------------------------------------------------------------------------

/** Python text_funcs.line_wrap: greedy word wrap to `width` pixels. */
export function lineWrap(font: string, text: string, width: number): string[] {
  const chunks = text.trim().split(' ').filter(Boolean).reverse();
  const space = textWidth(font, ' ');
  const lines: string[] = [];
  while (chunks.length) {
    const line: string[] = [];
    let len = 0;
    while (chunks.length) {
      const w = textWidth(font, chunks[chunks.length - 1].replace(/<[^>]*>/g, ''));
      if (len + w <= width) {
        line.push(chunks.pop() as string);
        len += w + space;
      } else {
        break;
      }
    }
    if (line.length) lines.push(line.join(' '));
    else lines.push(chunks.pop() as string);
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Portraits (RESOURCES.portraits + icons.get_chibi)
// ---------------------------------------------------------------------------

type KeyedImage = HTMLImageElement | HTMLCanvasElement;
const portraitCache: Map<string, KeyedImage | null> = new Map();

/** Make COLORKEY (128, 160, 128) pixels transparent, like engine.set_colorkey. */
export function applyColorkey(img: HTMLImageElement): KeyedImage {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth || img.width;
    canvas.height = img.naturalHeight || img.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx || !canvas.width || !canvas.height) return img;
    ctx.drawImage(img, 0, 0);
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const px = data.data;
    for (let i = 0; i < px.length; i += 4) {
      if (px[i] === 128 && px[i + 1] === 160 && px[i + 2] === 128) px[i + 3] = 0;
    }
    ctx.putImageData(data, 0, 0);
    return canvas;
  } catch {
    return img;
  }
}

/** A colorkeyed project image (e.g. 'resources/icons80/x.png'), loaded lazily. */
export function getKeyedImage(
  resources: { loadImage?(path: string): Promise<HTMLImageElement> } | null | undefined,
  path: string,
): KeyedImage | null {
  if (portraitCache.has(path)) return portraitCache.get(path) ?? null;
  portraitCache.set(path, null);
  void resources?.loadImage?.(path)
    .then((img) => portraitCache.set(path, applyColorkey(img)))
    .catch(() => undefined);
  return null;
}

/** The colorkeyed portrait sheet for `nid`, loading lazily (null until ready). */
export function getPortrait(
  resources: { loadImage?(path: string): Promise<HTMLImageElement> } | null | undefined,
  nid: string | null | undefined,
): KeyedImage | null {
  if (!nid) return null;
  return getKeyedImage(resources, `resources/portraits/${nid}.png`);
}

/** icons.draw_chibi: the 32x32 chibi at (width - 32, 16) of the portrait. */
export function drawChibi(
  surf: Surface,
  resources: { loadImage?(path: string): Promise<HTMLImageElement> } | null | undefined,
  nid: string | null | undefined,
  x: number, y: number,
): void {
  const img = getPortrait(resources, nid);
  if (!img) return;
  surf.blitImage(img, img.width - 32, 16, 32, 32, x, y);
}

/** Python unit.sprite.create_image('passive'): the standing frame. */
export function passiveFrame(sprite: unknown): Surface | null {
  const s = sprite as { state?: string; getCurrentFrame?(): Surface } | null;
  if (!s?.getCurrentFrame) return null;
  const prev = s.state;
  s.state = 'standing';
  const frame = s.getCurrentFrame();
  s.state = prev;
  return frame ?? null;
}

/** Python unit.name, falling back to the DB unit prefab, then the raw key. */
export function unitDisplayName(game: any, nidOrName: string): string {
  const unit = game?.units?.get?.(nidOrName) ?? game?.getUnit?.(nidOrName);
  if (unit?.name) return unit.name;
  const prefab = game?.db?.units?.get?.(nidOrName);
  return prefab?.name ?? nidOrName;
}

/** Python datetime-based playtime "H:MM:SS" (hours capped at 99). */
export function formatPlaytime(ms: number): string {
  const seconds = Math.floor(Math.max(0, ms) / 1000);
  const hours = Math.min(Math.floor(seconds / 3600), 99);
  const minutes = String(Math.floor((seconds % 3600) / 60)).padStart(2, '0');
  return `${hours}:${minutes}:${String(seconds % 60).padStart(2, '0')}`;
}
