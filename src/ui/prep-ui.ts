/**
 * prep-ui.ts — Python menus/menu_options/background primitives used by the
 * preparation and base screens.
 *
 * Ports, from lt-maker/app/engine:
 *   - background.create_background (ScrollingBackground over a panorama,
 *     falling back to `default_background`) and SpriteBackground (focus_fade)
 *   - menus.Cursor, gui.ScrollBar
 *   - menus.Table with menu_options.UnitOption / BasicOption cells
 *   - menus.Choice (vertical/horizontal) with BasicOption / ItemOption rows
 *   - menus.draw_unit_items / draw_unit_top / draw_unit_face, prep.draw_funds
 *
 * All coordinates are Python's 240x160 layout; callers add `screenOrigin()`
 * so the layout stays centred when the viewport is larger.
 */

import { Surface } from '../engine/surface';
import { cachedItemHelpBox } from './help-menu';
import { viewport } from '../engine/viewport';
import { getFrameCount, TILEWIDTH, TILEHEIGHT } from '../engine/constants';
import type { UnitObject } from '../objects/unit';
import type { ItemObject } from '../objects/item';
import type { LoreEntry } from '../data/types';
import { FONT } from '../rendering/bmp-font';
import { getMenuBackgroundSync } from './base-surf';
import { getSprite as getRegistrySprite } from './sprites';
import { drawIcon16 } from './icons';
import { isForkEngine } from '../engine/engine-flavor';
import {
  available as itemAvailable,
  buyPrice as itemBuyPrice,
  fullPrice as itemFullPrice,
  sellPrice as itemSellPrice,
  weaponType as itemWeaponType,
  itemTextColor,
} from '../combat/item-system';
import { priceSkillMultiplier } from '../combat/skill-system';

export const WINWIDTH = 240;
export const WINHEIGHT = 160;

/** Top-left of the centred 240x160 Python layout inside the viewport. */
export function screenOrigin(): [number, number] {
  return [
    Math.max(0, Math.floor((viewport.width - WINWIDTH) / 2)),
    Math.max(0, Math.floor((viewport.height - WINHEIGHT) / 2)),
  ];
}

// ---------------------------------------------------------------------------
// Sprites
// ---------------------------------------------------------------------------

/** A drawable sprite image (the canvas behind a SPRITES Surface). */
export type SpriteImage = HTMLCanvasElement & { width: number; height: number };

/**
 * Python SPRITES.get(nid) via the shared SPRITES registry (src/ui/sprites.ts:
 * project custom_sprites override engine sprites). Null until loaded.
 */
export function getSprite(nid: string): SpriteImage | null {
  const surf = getRegistrySprite(nid);
  return surf ? (surf.canvas as unknown as SpriteImage) : null;
}

/** Start loading every sprite the prep screens use. */
export function preloadPrepSprites(): void {
  for (const nid of [
    'focus_fade', 'buttons', 'scroll_bar', 'prep_top', 'funds_display', 'menu_bg_base',
    'menu_bg_white', 'menu_bg_brown', 'menu_gem_small', 'menu_gem_brown', 'menu_shimmer1',
    'menu_shimmer2', 'menu_shimmer3', 'menu_highlight', 'menu_hand', 'menu_hand_rotated',
  ]) getSprite(nid);
}

/** Python base_surf.create_base_surf (cached 9-slice). */
export function baseSurf(width: number, height: number, nid = 'menu_bg_base'): Surface {
  return getMenuBackgroundSync(width, height, nid);
}

/** Blit a surface at Python make_translucent(surf, t) opacity. */
export function blitTranslucent(dest: Surface, src: Surface, x: number, y: number, translucency: number): void {
  const prev = src.getAlpha();
  src.setAlpha(1 - translucency);
  dest.blit(src, x, y);
  src.setAlpha(prev);
}

/** Surface.blitImage draws at the destination surface's alpha. */
function blitSprite(surf: Surface, img: HTMLImageElement | HTMLCanvasElement | null, x: number, y: number, alpha = 1): void {
  if (!img) return;
  const prev = surf.getAlpha();
  surf.setAlpha(alpha);
  surf.blitImage(img, 0, 0, img.width, img.height, x, y);
  surf.setAlpha(prev);
}

/** Colorkeyed copies of project portrait sheets. */
const portraitSheets = new Map<string, HTMLCanvasElement | null>();
export function getPortraitSheet(game: any, nid: string): HTMLCanvasElement | null {
  if (!nid) return null;
  if (portraitSheets.has(nid)) return portraitSheets.get(nid) ?? null;
  portraitSheets.set(nid, null);
  void game.resources?.tryLoadImage?.(`resources/portraits/${nid}.png`).then((img: HTMLImageElement | null) => {
    if (!img) return;
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth || img.width;
    canvas.height = img.naturalHeight || img.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;
    ctx.drawImage(img, 0, 0);
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
    for (let i = 0; i < data.data.length; i += 4) {
      if (data.data[i] === 128 && data.data[i + 1] === 160 && data.data[i + 2] === 128) data.data[i + 3] = 0;
    }
    ctx.putImageData(data, 0, 0);
    portraitSheets.set(nid, canvas);
  });
  return null;
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

export function textWidth(text: string, font = 'text'): number {
  return FONT[font]?.width(text) ?? text.length * 5;
}

/** FONT[font].blit with an optional palette colour (null = font default). */
export function drawText(surf: Surface, text: string, x: number, y: number, color: string | null = null, font = 'text'): void {
  surf.drawText(text, x, y, color ?? 'white', font);
}

export function drawTextRight(surf: Surface, text: string, x: number, y: number, color: string | null = null, font = 'text'): void {
  drawText(surf, text, x - textWidth(text, font), y, color, font);
}

export function drawTextCenter(surf: Surface, text: string, x: number, y: number, color: string | null = null, font = 'text'): void {
  drawText(surf, text, x - Math.floor(textWidth(text, font) / 2), y, color, font);
}

// ---------------------------------------------------------------------------
// Backgrounds
// ---------------------------------------------------------------------------

/**
 * Python background.create_background(name): a ScrollingBackground over the
 * panorama (scroll_speed 50), or `default_background` when the project has
 * no panorama of that name (EOtF has no `rune_background`).
 */
export class ScrollingBackground {
  private image: HTMLImageElement | null = null;
  readonly scrollSpeed: number;

  constructor(game: any, name: string, scrollSpeed = 50) {
    this.scrollSpeed = scrollSpeed;
    const resources = game.resources;
    void (async () => {
      let img: HTMLImageElement | null = await resources?.tryLoadImage?.(`resources/panoramas/${name}.png`) ?? null;
      if (!img && name !== 'default_background') {
        img = await resources?.tryLoadImage?.('resources/panoramas/default_background.png') ?? null;
      }
      this.image = img;
    })();
  }

  draw(surf: Surface): void {
    const img = this.image;
    if (!img) {
      surf.fill(0, 0, 0);
      return;
    }
    const width = img.naturalWidth || img.width;
    // engine.get_time() / scroll_speed; frame-clocked (60 fps) so harness
    // screenshots stay deterministic.
    const counter = ((getFrameCount() * 1000 / 60) / this.scrollSpeed) % width;
    for (let x = -counter; x < viewport.width; x += width) {
      for (let y = 0; y < viewport.height; y += img.height) {
        surf.blitImage(img, 0, 0, width, img.height, Math.floor(x), y);
      }
    }
  }
}

/**
 * Python base.base_background: the `_base_bg_name` panorama scaled to the
 * window (PanoramaBackground), else `default_background` scrolling at 50.
 */
export function createBaseBackground(game: any): { draw(surf: Surface): void } {
  const name = String(game.gameVars?.get('_base_bg_name') ?? '');
  let image: HTMLImageElement | null = null;
  let fallback: ScrollingBackground | null = null;
  if (name) {
    void game.resources?.tryLoadImage?.(`resources/panoramas/${name}.png`).then((img: HTMLImageElement | null) => {
      if (img) image = img;
      else fallback = new ScrollingBackground(game, 'default_background');
    });
  } else {
    fallback = new ScrollingBackground(game, 'default_background');
  }
  return {
    draw(surf: Surface): void {
      if (image) {
        const w = image.naturalWidth || image.width;
        const h = image.naturalHeight || image.height;
        const scale = Math.max(viewport.width / WINWIDTH, viewport.height / WINHEIGHT, 1);
        const dw = WINWIDTH * scale;
        const dh = WINHEIGHT * scale;
        const s = surf.scale;
        surf.ctx.imageSmoothingEnabled = false;
        surf.ctx.drawImage(image, 0, 0, w, h,
          Math.round(((viewport.width - dw) / 2) * s), Math.round(((viewport.height - dh) / 2) * s),
          Math.round(dw * s), Math.round(dh * s));
      } else if (fallback) {
        fallback.draw(surf);
      } else {
        surf.fill(0, 0, 0);
      }
    },
  };
}

/** Python background.SpriteBackground (focus_fade over the prep map). */
export class SpriteBackground {
  private nid: string;
  private fade: number;
  state: 'in' | 'out' | 'normal';

  constructor(nid: string, fade = true) {
    this.nid = nid;
    this.fade = fade ? 100 : 0;
    this.state = fade ? 'in' : 'normal';
    getSprite(nid);
  }

  /** Returns true once a fade-out has completed. */
  draw(surf: Surface): boolean {
    let done = false;
    if (this.state === 'in') {
      this.fade -= 4;
      if (this.fade <= 0) { this.fade = 0; this.state = 'normal'; }
    } else if (this.state === 'out') {
      this.fade += 4;
      if (this.fade >= 100) { this.fade = 100; done = true; }
    }
    const img = getSprite(this.nid);
    if (img) {
      const x = Math.floor(viewport.width / 2 - img.width / 2);
      const y = Math.floor(viewport.height / 2 - img.height / 2);
      blitSprite(surf, img, x, y, 1 - this.fade / 100);
    }
    return done;
  }

  fadeIn(): void { this.state = 'in'; }
  fadeOut(): void { this.state = 'out'; }
}

// ---------------------------------------------------------------------------
// Cursor & scroll bar
// ---------------------------------------------------------------------------

const CURSOR_ANIM = [0, 0, 0, 0, 0, 0, 0, 1, 1, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 4, 4, 4, 3, 3, 2, 2, 2, 1, 1, 1, 1];

/** Python menus.Cursor. */
export class MenuCursor {
  counter = 0;
  yOffset = 0;
  private spriteNid: string;

  constructor(spriteNid = 'menu_hand') {
    this.spriteNid = spriteNid;
  }

  yOffsetUp(): void { this.yOffset = 12; }
  yOffsetDown(): void { this.yOffset = -12; }
  update(): void { this.counter = (this.counter + 1) % CURSOR_ANIM.length; }

  private updateYOffset(): void {
    if (this.yOffset > 0) this.yOffset = Math.max(0, this.yOffset - 4);
    else if (this.yOffset < 0) this.yOffset = Math.min(0, this.yOffset + 4);
  }

  draw(surf: Surface, x: number, y: number): void {
    blitSprite(surf, getSprite(this.spriteNid), x - 12 + CURSOR_ANIM[this.counter], y + 3 + this.yOffset);
    this.updateYOffset();
  }

  drawVert(surf: Surface, x: number, y: number): void {
    blitSprite(surf, getSprite(this.spriteNid), x - 12, y + 3 + this.yOffset + CURSOR_ANIM[this.counter]);
    this.updateYOffset();
  }
}

/** Python gui.ScrollBar. */
export class ScrollBar {
  private arrowCounter = 0;

  draw(surf: Surface, topright: [number, number], scroll: number, limit: number, numOptions: number, optionHeight = 16): void {
    this.arrowCounter += 0.125;
    if (this.arrowCounter >= 6) this.arrowCounter = 0;
    const sheet = getSprite('scroll_bar');
    if (!sheet) return;
    const x = topright[0] - 9;
    const y = topright[1] + 12;
    const height = limit * optionHeight - 20;
    const startFraction = scroll / numOptions;
    const endFraction = Math.min(1, (scroll + limit) / numOptions);
    surf.blitImage(sheet, 0, 0, 7, 1, x, y);
    surf.blitImage(sheet, 0, 2, 7, 1, x, y + height + 2);
    for (let num = 1; num < height + 2; num++) surf.blitImage(sheet, 0, 1, 7, 1, x, y + num);
    const startPos = Math.floor(startFraction * height);
    const endPos = Math.floor(endFraction * height);
    for (let num = startPos; num <= endPos; num++) surf.blitImage(sheet, 0, 3, 7, 1, x, y + num + 1);
    const frame = Math.floor(this.arrowCounter);
    if (startPos > 0) surf.blitImage(sheet, 8, 4 + frame * 6, 8, 6, x - 1, y - 7);
    if (endPos < height) surf.blitImage(sheet, 0, 4 + frame * 6, 8, 6, x - 1, y + height + 4);
  }
}

/** BasicOption.draw_highlight: menu_highlight tiled 5px in, 9px down. */
export function drawMenuHighlight(surf: Surface, x: number, y: number, menuWidth: number): void {
  const highlight = getSprite('menu_highlight');
  if (!highlight) return;
  const slots = Math.floor((menuWidth - 10) / highlight.width);
  for (let slot = 0; slot < slots; slot++) {
    surf.blitImage(highlight, 0, 0, highlight.width, highlight.height, x + 5 + slot * highlight.width, y + 9);
  }
}

// ---------------------------------------------------------------------------
// Unit helpers
// ---------------------------------------------------------------------------

export function getRescuer(game: any, unit: UnitObject): UnitObject | null {
  for (const other of game.units?.values?.() ?? []) {
    if (other.traveler === unit.nid) return other;
  }
  return null;
}

/** Python game.check_for_region(position, 'formation'). */
export function inFormation(game: any, position: [number, number] | null | undefined): boolean {
  if (!position) return false;
  for (const region of game.currentLevel?.regions ?? []) {
    if (region.region_type !== 'formation') continue;
    const [rx, ry] = region.position;
    const w = region.size?.[0] ?? 1;
    const h = region.size?.[1] ?? 1;
    if (position[0] >= rx && position[0] < rx + w && position[1] >= ry && position[1] < ry + h) return true;
  }
  return false;
}

/** Python Table modes used by UnitOption.get_color / draw_map_sprite. */
export type UnitTableMode = 'position' | 'prep_manage' | 'unit' | null;

function unitOptionColor(game: any, unit: UnitObject, mode: UnitTableMode, ignore: boolean): string | null {
  if (ignore) return 'grey';
  if (mode !== 'position' && mode !== 'prep_manage') return null;
  if (unit.tags?.includes('Blacklist')) return 'red';
  if (game.db?.getConstant?.('fatigue', false) && game.gameVars?.get('_fatigue') &&
      typeof (unit as any).getFatigue === 'function' &&
      (unit as any).getFatigue() >= (unit as any).getMaxFatigue()) return 'red';
  const rescuer = getRescuer(game, unit);
  if (!unit.position && !(rescuer && rescuer.position)) return 'grey';
  if (unit.position && (!inFormation(game, unit.position) || unit.tags?.includes('Required'))) return 'green';
  return null;
}

/** Python GenericAnimCounter.from_frames_back_and_forth frame index. */
function backAndForthFrame(frameCount: number, durations: number[]): number {
  const lengths = [...durations, ...durations.slice(1, -1).reverse()];
  const order = [...durations.keys(), ...[...durations.keys()].slice(1, -1).reverse()];
  let t = frameCount % lengths.reduce((a, b) => a + b, 0);
  for (let i = 0; i < order.length; i++) {
    if (t < lengths[i]) return order[i];
    t -= lengths[i];
  }
  return 0;
}

/** UnitOption.draw_map_sprite: the 64x48 frame drawn at (x - 20, y - 25). */
export function drawUnitMapSprite(
  surf: Surface, game: any, unit: UnitObject, x: number, y: number,
  kind: 'passive' | 'gray' | 'active',
): void {
  const frame = unitStandFrame(game, unit, kind);
  if (frame) surf.blit(frame, x - 20, y - 24 - 1);
}

/**
 * Python unit.sprite.create_image(kind): the unit's current 64x48 stand frame
 * (passive/gray cycle 32-4-32 frames, active 20-4-20), or null while the map
 * sprite loads.
 */
export function unitStandFrame(game: any, unit: UnitObject, kind: 'passive' | 'gray' | 'active'): Surface | null {
  const sprite: any = unit.sprite;
  if (!sprite) {
    if (!(unit as any)._prepSpriteRequested && game.loadMapSpriteForUnit) {
      (unit as any)._prepSpriteRequested = true;
      void game.loadMapSpriteForUnit(unit);
    }
    return null;
  }
  const frames: Surface[] = sprite.getStandFrames?.(kind) ?? [];
  const index = backAndForthFrame(getFrameCount(), kind === 'active' ? [20, 4, 20] : [32, 4, 32]);
  return frames.length ? frames[index % frames.length] : sprite.getCurrentFrame?.() ?? null;
}

// ---------------------------------------------------------------------------
// Table (menus.Table)
// ---------------------------------------------------------------------------

export type TableEntry = { kind: 'unit'; unit: UnitObject } | { kind: 'text'; text: string };

interface TableOption {
  entry: TableEntry | null;
  ignore: boolean;
}

/**
 * The window a menus.Choice/Table actually draws. EOtF's engine resets every
 * such menu onto the window skin whatever background its caller asked for,
 * so clear (null) and brown menus become skin windows there.
 */
export function forcedMenuBackground(background: string | null): string | null {
  return isForkEngine() ? 'menu_bg_base' : background;
}

export class Table {
  rows: number;
  columns: number;
  topleft: [number, number];
  mode: UnitTableMode = null;
  background: string;
  gem = false;
  shimmer = 0;
  options: TableOption[] = [];
  currentIndex = 0;
  scroll = 0;
  takesInput = true;
  drawCursor = 1;
  fakeCursorIdx: number | null = null;
  readonly cursor = new MenuCursor();
  readonly stationaryCursor = new MenuCursor();
  private scrollBar = new ScrollBar();
  private game: any;

  constructor(game: any, entries: TableEntry[], layout: [number, number], topleft: [number, number], background = 'menu_bg_base') {
    this.game = game;
    this.rows = layout[0];
    this.columns = layout[1];
    this.topleft = topleft;
    this.background = background;
    this.createOptions(entries);
  }

  setMode(mode: UnitTableMode): void { this.mode = mode; }

  createOptions(entries: TableEntry[]): void {
    this.options = entries.length
      ? entries.map((entry) => ({ entry, ignore: false }))
      : [{ entry: null, ignore: true }];
  }

  updateOptions(entries: TableEntry[]): void {
    const ignores = this.options.map((o) => o.ignore);
    this.createOptions(entries);
    this.options.forEach((o, i) => { if (i < ignores.length && o.entry) o.ignore = ignores[i]; });
    this.currentIndex = Math.max(0, Math.min(this.currentIndex, this.options.length - 1));
  }

  setIgnore(ignores: boolean[]): void {
    this.options.forEach((option, idx) => { option.ignore = idx >= ignores.length ? true : ignores[idx]; });
    const first = this.options.findIndex((o) => !o.ignore);
    if (first >= 0) this.currentIndex = first;
  }

  getCurrent(): TableEntry | null {
    return this.options[this.currentIndex]?.entry ?? null;
  }

  getCurrentUnit(): UnitObject | null {
    const entry = this.getCurrent();
    return entry?.kind === 'unit' ? entry.unit : null;
  }

  getCurrentText(): string | null {
    const entry = this.getCurrent();
    return entry?.kind === 'text' ? entry.text : null;
  }

  update(): void {
    if (this.drawCursor === 1) this.cursor.update();
  }

  private trueCoords(idx: number): [number, number] {
    return [Math.floor(idx / this.columns), idx % this.columns];
  }
  private exists(row: number, col: number): boolean {
    if (col >= this.columns || row < 0 || col < 0) return false;
    return row * this.columns + col < this.options.length;
  }
  private idxCoords(row: number, col: number): number { return row * this.columns + col; }
  private getBottom(col: number): number {
    if (col >= this.options.length % this.columns) return Math.floor(this.options.length / this.columns) - 1;
    return Math.floor(this.options.length / this.columns);
  }
  private getRight(row: number): number {
    if (row >= Math.floor(this.options.length / this.columns)) return (this.options.length % this.columns) - 1;
    return this.columns - 1;
  }
  private numRows(): number { return Math.ceil(this.options.length / this.columns); }

  moveTo(idx: number): boolean {
    const scroll = this.scroll;
    idx = Math.max(0, Math.min(idx, this.options.length - 1));
    if (this.options[idx].ignore) return false;
    this.currentIndex = idx;
    const [row] = this.trueCoords(idx);
    this.scroll = Math.max(row - this.rows + 1, Math.min(this.scroll, row));
    return scroll !== this.scroll;
  }

  moveDown(firstPush = true): boolean {
    if (this.options.every((o) => o.ignore)) return false;
    const oldIndex = this.currentIndex;
    let [row, col] = this.trueCoords(oldIndex);
    let idx = oldIndex;
    for (;;) {
      row += 1;
      if (this.exists(row, col)) {
        // pass
      } else if (firstPush) {
        row = 0;
        this.scroll = 0;
      } else {
        const candidates: number[] = [];
        for (let r = 0; r < row; r++) {
          if (this.exists(r, col) && !this.options[this.idxCoords(r, col)].ignore) candidates.push(r);
        }
        row = Math.max(...candidates);
        idx = this.idxCoords(row, col);
        break;
      }
      idx = this.idxCoords(row, col);
      if (row > this.scroll + this.rows - 2) this.scroll += 1;
      else if (row !== 0) this.cursor.yOffsetDown();
      if (!this.options[idx].ignore) break;
    }
    this.currentIndex = idx;
    if (oldIndex === this.currentIndex) this.cursor.yOffset = 0;
    this.scroll = Math.max(0, Math.min(this.scroll, Math.max(0, this.numRows() - this.rows)));
    return oldIndex !== this.currentIndex;
  }

  moveUp(firstPush = true): boolean {
    if (this.options.every((o) => o.ignore)) return false;
    const oldIndex = this.currentIndex;
    let [row, col] = this.trueCoords(oldIndex);
    const numRows = this.numRows();
    let idx = oldIndex;
    for (;;) {
      row -= 1;
      if (this.exists(row, col)) {
        // pass
      } else if (firstPush) {
        row = this.getBottom(col);
        this.scroll = numRows - this.rows;
      } else {
        const candidates: number[] = [];
        for (let r = 0; r < numRows; r++) {
          if (this.exists(r, col) && !this.options[this.idxCoords(r, col)].ignore) candidates.push(r);
        }
        row = Math.min(...candidates);
        idx = this.idxCoords(row, col);
        break;
      }
      idx = this.idxCoords(row, col);
      if (row < this.scroll + 1) this.scroll -= 1;
      else if (row !== this.getBottom(col)) this.cursor.yOffsetUp();
      if (!this.options[idx].ignore) break;
    }
    this.currentIndex = idx;
    this.scroll = Math.max(0, this.scroll);
    if (oldIndex === this.currentIndex) this.cursor.yOffset = 0;
    return oldIndex !== this.currentIndex;
  }

  moveRight(_firstPush = true): boolean {
    if (this.options.every((o) => o.ignore)) return false;
    const oldIndex = this.currentIndex;
    let [row, col] = this.trueCoords(oldIndex);
    let idx = oldIndex;
    const numRows = this.numRows();
    for (;;) {
      col += 1;
      if (this.exists(row, col)) {
        // pass
      } else if (idx >= this.options.length - 1) {
        break;
      } else if (row < numRows - 1) {
        row += 1;
        col = 0;
        if (row > this.scroll + this.rows - 2) {
          this.scroll += 1;
          this.scroll = Math.max(0, Math.min(this.scroll, Math.max(0, numRows - this.rows)));
        }
      } else {
        let last = 0;
        this.options.forEach((o, i) => { if (!o.ignore) last = i; });
        idx = last;
        break;
      }
      idx = this.idxCoords(row, col);
      if (!this.options[idx].ignore) break;
    }
    if (!this.options[idx].ignore) this.currentIndex = idx;
    return oldIndex !== this.currentIndex;
  }

  moveLeft(_firstPush = true): boolean {
    if (this.options.every((o) => o.ignore)) return false;
    const oldIndex = this.currentIndex;
    let [row, col] = this.trueCoords(oldIndex);
    let idx = oldIndex;
    for (;;) {
      col -= 1;
      if (this.exists(row, col)) {
        // pass
      } else if (row > 0) {
        row -= 1;
        col = this.getRight(row);
        if (row < this.scroll + 1) {
          this.scroll -= 1;
          this.scroll = Math.max(0, this.scroll);
        }
      } else {
        idx = this.options.findIndex((o) => !o.ignore);
        break;
      }
      idx = this.idxCoords(row, col);
      if (!this.options[idx].ignore) break;
    }
    if (!this.options[idx].ignore) this.currentIndex = idx;
    return oldIndex !== this.currentIndex;
  }

  private optionWidth(option: TableOption): number {
    if (!option.entry) return textWidth('Nothing') + 24;
    if (option.entry.kind === 'unit') return 64;
    return textWidth(option.entry.text) + 24;
  }

  private cellWidth(): number {
    const width = Math.max(...this.options.map((o) => this.optionWidth(o)));
    return width - (width % 8);
  }

  getMenuWidth(): number {
    const maxWidth = Math.max(...this.options.map((o) => {
      const w = this.optionWidth(o);
      return w - (w % 8);
    }));
    let total = maxWidth * this.columns;
    total -= total % 8;
    if (this.mode === 'unit' || this.mode === 'prep_manage') total += 32;
    return total;
  }

  getMenuHeight(): number {
    return 16 * this.rows + 8;
  }

  private drawBg(surf: Surface, ox: number, oy: number): void {
    const [x, y] = this.topleft;
    const bg = baseSurf(this.getMenuWidth(), this.getMenuHeight(), forcedMenuBackground(this.background) ?? 'menu_bg_base');
    blitTranslucent(surf, bg, ox + x, oy + y, 0.1);
    if (this.gem) {
      blitSprite(surf, getSprite(this.gem === true ? 'menu_gem_small' : 'menu_gem_brown'), ox + x - 2, oy + y - 4, 0.9);
    }
    if (this.shimmer) {
      const sprite = getSprite(`menu_shimmer${this.shimmer}`);
      if (sprite) {
        const w = bg.width + 2;
        const h = bg.height + 4;
        blitSprite(surf, sprite, ox + x - 2 + w - sprite.width - 1, oy + y - 4 + h - sprite.height - 5, 0.9);
      }
    }
  }

  /** Python Table.get_rects: [index, x, y, w, h] for every visible cell. */
  getRects(ox = 0, oy = 0): [number, number, number, number, number][] {
    const [tx, ty] = this.topleft;
    const start = this.scroll * this.columns;
    const end = (this.scroll + this.rows) * this.columns;
    const width = this.cellWidth();
    const rects: [number, number, number, number, number][] = [];
    for (let i = start; i < Math.min(end, this.options.length); i++) {
      const rel = i - start;
      let left = ox + tx + (rel % this.columns) * width;
      const top = oy + ty + 4 + Math.floor(rel / this.columns) * 16;
      if (this.mode === 'unit' || this.mode === 'prep_manage') left += 16;
      rects.push([i, left, top, width, 16]);
    }
    return rects;
  }

  /** Python Simple.handle_mouse; returns the hovered index or -1. */
  handleMouse(gx: number, gy: number, ox = 0, oy = 0): number {
    for (const [idx, x, y, w, h] of this.getRects(ox, oy)) {
      if (gx >= x && gx <= x + w && gy >= y && gy <= y + h) {
        if (!this.options[idx].ignore) this.moveTo(idx);
        return idx;
      }
    }
    return -1;
  }

  draw(surf: Surface, ox = 0, oy = 0): void {
    const game = this.game;
    const [tx, ty] = this.topleft;
    this.drawBg(surf, ox, oy);

    let drawScrollBar = false;
    if (this.options.length > this.rows * this.columns) {
      drawScrollBar = true;
      this.scrollBar.draw(surf, [ox + tx + this.getMenuWidth(), oy + ty], this.scroll, this.rows, this.numRows());
    }

    const width = this.cellWidth();
    for (const [idx, left, top] of this.getRects(ox, oy)) {
      const option = this.options[idx];
      const highlighted = idx === this.currentIndex && this.takesInput && !!this.drawCursor;
      const fake = idx === this.fakeCursorIdx;
      this.drawOption(surf, game, option, left, top, highlighted || fake, drawScrollBar ? width - 8 : width);
      if (fake) this.stationaryCursor.draw(surf, left, top);
      if (highlighted) this.cursor.draw(surf, left, top);
    }
    if (!this.options.some((o) => o.entry)) {
      drawText(surf, 'Nothing', ox + tx + 16, oy + ty + 4, 'grey');
    }
  }

  private drawOption(surf: Surface, game: any, option: TableOption, x: number, y: number, highlight: boolean, menuWidth: number): void {
    const entry = option.entry;
    if (!entry) return;
    if (entry.kind === 'unit') {
      const unit = entry.unit;
      if (highlight) drawMenuHighlight(surf, x, y, 64);
      let kind: 'passive' | 'gray' | 'active' = highlight ? 'active' : 'passive';
      if (this.mode === 'position' && !unit.position && !getRescuer(game, unit)) kind = 'gray';
      drawUnitMapSprite(surf, game, unit, x, y, kind);
      const color = unitOptionColor(game, unit, this.mode, option.ignore);
      const font = textWidth(unit.name) > 44 ? 'narrow' : 'text';
      drawText(surf, unit.name, x + 20, y, color, font);
      return;
    }
    if (highlight) drawMenuHighlight(surf, x, y, menuWidth);
    drawText(surf, entry.text, x + 5, y, option.ignore ? 'grey' : null);
  }
}

// ---------------------------------------------------------------------------
// Choice (menus.Choice) with BasicOption / ItemOption rows
// ---------------------------------------------------------------------------

export type ChoiceEntry =
  | { kind: 'text'; text: string }
  | { kind: 'item'; item: ItemObject; owner?: UnitObject | null }
  /** EmptyOption: an unselectable filler row. */
  | { kind: 'empty' }
  /** BasicOption('') used by menus.Trade for open inventory slots. */
  | { kind: 'blank' }
  /** menu_options.LoreOption (84 wide); `header` rows show the category. */
  | { kind: 'lore'; lore: LoreEntry; header: boolean };

interface ChoiceOption {
  entry: ChoiceEntry;
  ignore: boolean;
}

export type ChoiceTopleft = [number, number] | 'center' | ['center', number] | [number, 'center'];

export class Choice {
  options: ChoiceOption[] = [];
  currentIndex = 0;
  scroll = 0;
  limit = 1000;
  topleft: ChoiceTopleft;
  background: string | null;
  gem: boolean | 'brown' = true;
  shimmer = 0;
  horizontal = false;
  highlight = true;
  takesInput = true;
  drawCursor = 1;
  fakeCursorIdx: number | null = null;
  /** Choice.set_convoy: ConvoyItemOption rows (112 wide) and the owner face. */
  isConvoy = false;
  /** menus.Shop disp_value: ValueItemOption rows (152 wide). */
  dispValue: 'buy' | 'sell' | null = null;
  /** menus.Shop stock: StockValueItemOption rows (168 wide). */
  stock: number[] | null = null;
  /** Choice.set_hard_limit: pad with EmptyOptions up to `limit`. */
  hardLimit = false;
  /** Unit at the convoy/shop (ConvoyItemOption colours, shop prices). */
  owner: UnitObject | null = null;
  /** Choice.set_color with a font nid (e.g. the shop's 'convo-white'). */
  textFont = 'text';
  readonly cursor = new MenuCursor();
  readonly stationaryCursor = new MenuCursor();
  private scrollBar = new ScrollBar();
  private game: any;

  constructor(game: any, entries: ChoiceEntry[] | string[], topleft: ChoiceTopleft = 'center', background: string | null = 'menu_bg_base') {
    this.game = game;
    this.topleft = topleft;
    this.background = background;
    this.setOptions(entries);
  }

  setOptions(entries: ChoiceEntry[] | string[]): void {
    const list: ChoiceEntry[] = (entries as any[]).map((e) => typeof e === 'string' ? { kind: 'text', text: e } : e);
    this.options = list.map((entry) => ({ entry, ignore: entry.kind === 'empty' }));
    if (this.hardLimit) {
      while (this.options.length < this.limit) this.options.push({ entry: { kind: 'empty' }, ignore: true });
    } else if (this.options.length === 0) {
      this.options = [{ entry: { kind: 'text', text: 'Nothing' }, ignore: true }];
    }
    this.currentIndex = Math.max(0, Math.min(this.currentIndex, this.options.length - 1));
  }

  setLimit(limit: number): void { this.limit = Math.max(2, limit); }

  setIgnore(ignores: boolean[]): void {
    this.options.forEach((option, idx) => { option.ignore = idx >= ignores.length ? true : ignores[idx]; });
    const first = this.options.findIndex((o) => !o.ignore);
    if (first >= 0) this.currentIndex = first;
  }

  getCurrent(): ChoiceEntry | null { return this.options[this.currentIndex]?.entry ?? null; }
  getCurrentText(): string | null {
    const e = this.getCurrent();
    return e?.kind === 'text' ? e.text : null;
  }
  getCurrentItem(): ItemObject | null {
    const e = this.getCurrent();
    return e?.kind === 'item' ? e.item : null;
  }

  itemAt(idx: number): ItemObject | null {
    const e = this.options[idx]?.entry;
    return e?.kind === 'item' ? e.item : null;
  }

  /** Simple.info_flag (INFO help box for the current item). */
  infoFlag = false;

  /** Simple.toggle_info */
  toggleInfo(): void {
    this.infoFlag = !this.infoFlag;
  }

  /** Choice.vert_draw_info: the current item's help box below its row. */
  drawInfo(surf: Surface, ox = 0, oy = 0): void {
    const item = this.getCurrentItem();
    if (!item) return;
    const rect = this.getRects(0, 0).find(([idx]) => idx === this.currentIndex);
    if (!rect) return;
    const [, rx, ry] = rect;
    const box = cachedItemHelpBox(item);
    if (this.getTopleft()[0] < WINWIDTH / 2) box.draw(surf, rx - 4, ry + 16, false, [ox, oy]);
    else box.draw(surf, rx + this.getMenuWidth(), ry + 16, true, [ox, oy]);
  }

  update(): void {
    if (this.drawCursor === 1) this.cursor.update();
  }

  // --- Simple.move_down/up wrapped by Choice's ignore skipping ---
  private simpleMoveDown(firstPush: boolean): boolean {
    if (!firstPush && this.currentIndex >= this.options.length - 1) return false;
    this.currentIndex += 1;
    if (firstPush && this.currentIndex > this.options.length - 1) {
      this.currentIndex = 0;
      this.scroll = 0;
    } else if (this.currentIndex > this.scroll + this.limit - 2 && this.scroll + this.limit < this.options.length) {
      this.scroll += 1;
    } else {
      this.cursor.yOffsetDown();
    }
    if (this.limit < this.options.length) this.scroll = Math.min(this.options.length - this.limit, this.scroll);
    return true;
  }

  private simpleMoveUp(firstPush: boolean): boolean {
    if (!firstPush && this.currentIndex <= 0) return false;
    this.currentIndex -= 1;
    if (firstPush && this.currentIndex < 0) {
      this.currentIndex = this.options.length - 1;
      this.scroll = this.currentIndex - this.limit + 1;
    } else if (this.currentIndex < this.scroll + 1) {
      this.scroll -= 1;
    } else {
      this.cursor.yOffsetUp();
    }
    this.scroll = Math.max(0, this.scroll);
    return true;
  }

  moveDown(firstPush = true): boolean {
    if (this.options.every((o) => o.ignore)) return false;
    let moved = false;
    if (firstPush) {
      moved = this.simpleMoveDown(true);
      while (this.options[this.currentIndex].ignore) {
        this.cursor.yOffset = 0;
        moved = this.simpleMoveDown(true);
      }
      if (this.currentIndex === this.options.findIndex((o) => !o.ignore)) this.cursor.yOffset = 0;
    } else if (this.options.slice(this.currentIndex + 1).some((o) => !o.ignore)) {
      moved = this.simpleMoveDown(false);
      while (this.options[this.currentIndex].ignore) moved = this.simpleMoveDown(false);
    }
    if (this.horizontal) this.cursor.yOffset = 0;
    return moved;
  }

  moveUp(firstPush = true): boolean {
    if (this.options.every((o) => o.ignore)) return false;
    let moved = false;
    if (firstPush) {
      moved = this.simpleMoveUp(true);
      while (this.options[this.currentIndex].ignore) {
        this.cursor.yOffset = 0;
        moved = this.simpleMoveUp(true);
      }
      let last = -1;
      this.options.forEach((o, i) => { if (!o.ignore) last = i; });
      if (this.currentIndex === last) this.cursor.yOffset = 0;
    } else if (this.options.slice(0, this.currentIndex).some((o) => !o.ignore)) {
      moved = this.simpleMoveUp(false);
      while (this.options[this.currentIndex].ignore) moved = this.simpleMoveUp(false);
    }
    if (this.horizontal) this.cursor.yOffset = 0;
    return moved;
  }

  moveTo(idx: number): boolean {
    idx = Math.max(0, Math.min(idx, this.options.length - 1));
    if (this.options[idx].ignore) return false;
    const scroll = this.scroll;
    let guard = 0;
    while (this.currentIndex < idx && guard++ < 1000) this.moveDown(true);
    while (this.currentIndex > idx && guard++ < 2000) this.moveUp(true);
    return scroll !== this.scroll;
  }

  private optionWidth(option: ChoiceOption): number {
    const e = option.entry;
    if (e.kind === 'empty' && this.options.some((o) => o.entry.kind === 'lore')) return 80;
    if (e.kind === 'item' || e.kind === 'empty') {
      if (this.stock) return 168;
      if (this.dispValue) return e.kind === 'empty' ? 104 : 152;
      if (this.isConvoy) return 112;
      return 104;
    }
    if (e.kind === 'blank') return 104;
    if (e.kind === 'lore') return 84;
    // HorizOption.width is the bare text width; BasicOption adds 24.
    return textWidth(e.text) + (this.horizontal ? 0 : 24);
  }

  getMenuWidth(): number {
    if (this.horizontal) return this.options.reduce((sum, o) => sum + this.optionWidth(o) + 8, 0) + 16;
    const maxWidth = Math.max(...this.options.map((o) => this.optionWidth(o)));
    return maxWidth - (maxWidth % 8);
  }

  getMenuHeight(): number {
    if (this.horizontal) return 24;
    return Math.min(this.limit, this.options.length) * 16 + 8;
  }

  getTopleft(): [number, number] {
    const t = this.topleft;
    if (t === 'center') {
      return [Math.floor(WINWIDTH / 2 - this.getMenuWidth() / 2), Math.floor(WINHEIGHT / 2 - this.getMenuHeight() / 2)];
    }
    if (t[0] === 'center') return [Math.floor(WINWIDTH / 2 - this.getMenuWidth() / 2), t[1] as number];
    if (t[1] === 'center') return [t[0] as number, Math.floor(WINHEIGHT / 2 - this.getMenuHeight() / 2)];
    return [t[0] as number, t[1] as number];
  }

  /** [index, x, y, w, h] for visible rows (Python get_vert_rects / get_horiz_rects). */
  getRects(ox = 0, oy = 0): [number, number, number, number, number][] {
    const [x, y] = this.getTopleft();
    const rects: [number, number, number, number, number][] = [];
    if (this.horizontal) {
      let running = 0;
      this.options.forEach((o, i) => {
        const w = this.optionWidth(o);
        rects.push([i, ox + x + running, oy + y + 4, w, 16]);
        running += w + 8;
      });
      return rects;
    }
    const end = Math.min(this.options.length, this.scroll + this.limit);
    for (let i = this.scroll; i < end; i++) {
      rects.push([i, ox + x, oy + y + 4 + (i - this.scroll) * 16, this.optionWidth(this.options[i]), 16]);
    }
    return rects;
  }

  handleMouse(gx: number, gy: number, ox = 0, oy = 0): number {
    for (const [idx, x, y, w, h] of this.getRects(ox, oy)) {
      if (gx >= x && gx <= x + w && gy >= y && gy <= y + h) {
        if (!this.options[idx].ignore) this.moveTo(idx);
        return idx;
      }
    }
    return -1;
  }

  draw(surf: Surface, ox = 0, oy = 0): void {
    if (this.horizontal) { this.horizDraw(surf, ox, oy); return; }
    const [x, y] = this.getTopleft();
    const width = this.getMenuWidth();
    const height = this.getMenuHeight();
    const background = forcedMenuBackground(this.background);
    if (background) {
      blitTranslucent(surf, baseSurf(width, height, background), ox + x, oy + y, 0.1);
      if (this.gem) blitSprite(surf, getSprite(this.gem === 'brown' ? 'menu_gem_brown' : 'menu_gem_small'), ox + x - 2, oy + y - 4, 0.9);
      if (this.shimmer) {
        const sprite = getSprite(`menu_shimmer${this.shimmer}`);
        if (sprite) blitSprite(surf, sprite, ox + x + width - sprite.width - 1, oy + y + height - sprite.height - 5, 0.9);
      }
      // Choice.show_face: translucent portrait of the hovered item's owner.
      const owner = (this.isConvoy || this.dispValue === 'sell') ? this.getCurrentItem()?.owner : null;
      if (owner?.portraitNid) {
        const sheet = getPortraitSheet(this.game, owner.portraitNid);
        if (sheet) {
          const prev = surf.getAlpha();
          surf.setAlpha(0.45);
          surf.blitImage(sheet, 0, 0, 96, 80, ox + x + Math.floor((width + 2) / 2) - 46, oy + y + height - 85);
          surf.setAlpha(prev);
        }
      }
    }
    let drawScrollBar = false;
    if (this.options.length > this.limit) {
      drawScrollBar = true;
      this.scrollBar.draw(surf, [ox + x + width, oy + y], this.scroll, this.limit, this.options.length);
    }
    for (const [idx, left, top] of this.getRects(ox, oy)) {
      const option = this.options[idx];
      const current = this.highlight && idx === this.currentIndex && this.takesInput && !!this.drawCursor;
      if (current) drawMenuHighlight(surf, left, top, drawScrollBar ? width - 8 : width);
      this.drawOption(surf, option, idx, left, top);
      if (idx === this.fakeCursorIdx) this.stationaryCursor.draw(surf, left, top);
      if (idx === this.currentIndex && this.takesInput && this.drawCursor) this.cursor.draw(surf, left, top);
    }
  }

  private drawOption(surf: Surface, option: ChoiceOption, idx: number, x: number, y: number): void {
    const e = option.entry;
    if (e.kind === 'item' && (this.dispValue || this.isConvoy)) {
      const game = this.game;
      const item = e.item;
      const [main, usesColor] = itemOptionColors(game, item, option.ignore, this.isConvoy ? this.owner : null, this.isConvoy);
      if (item.iconNid) drawIcon16(surf, item.iconNid, [Number(item.iconIndex?.[0]) || 0, Number(item.iconIndex?.[1]) || 0], x + 2, y);
      drawText(surf, item.name, x + 20, y, main, textWidth(item.name) > 60 ? 'narrow' : 'text');
      if (!this.dispValue) {
        drawTextRight(surf, itemUsesString(item), x + 99, y, usesColor);
        return;
      }
      drawTextRight(surf, itemUsesString(item), x + 100, y, usesColor);
      const width = this.stock ? 168 : 152;
      let valueColor = 'grey';
      let valueString = '--';
      if (this.dispValue === 'buy') {
        const value = shopPrice(game, this.owner, item, 'buy');
        if (value) {
          valueString = String(value);
          if (value <= (game.getMoney?.() ?? 0)) valueColor = 'blue';
        }
      } else {
        const value = shopPrice(game, item.owner ?? this.owner, item, 'sell');
        if (itemValue(game, item)) {
          valueString = String(value);
          valueColor = 'blue';
        }
      }
      drawTextRight(surf, valueString, x + width - 6, y, valueColor);
      if (this.stock) {
        const stock = this.stock[idx] ?? -1;
        // EOtF's engine prints a sold-out (0) stock in red.
        drawTextRight(surf, stock >= 0 ? String(stock) : '--', x + 128, y, stock === 0 && isForkEngine() ? 'red' : main);
      }
      return;
    }
    if (e.kind === 'lore') {
      // LoreOption.draw: category (yellow) on header rows, else the name.
      const text = String((e.header ? e.lore.category : (e.lore.name || e.lore.title)) ?? '');
      drawText(surf, text, x + 6, y, e.header ? 'yellow' : (option.ignore ? 'grey' : null), textWidth(text) > 78 ? 'narrow' : 'text');
      return;
    }
    if (e.kind === 'text' && this.textFont !== 'text') {
      drawText(surf, e.text, x + 5, y, option.ignore ? 'grey' : null, this.textFont);
      return;
    }
    drawChoiceOption(surf, this.game, e, option.ignore, x, y);
  }

  private horizDraw(surf: Surface, ox: number, oy: number): void {
    const [x, y] = this.getTopleft();
    const background = forcedMenuBackground(this.background);
    if (background) {
      blitTranslucent(surf, baseSurf(this.getMenuWidth(), 24, background), ox + x, oy + y, 0.5);
    }
    for (const [idx, left, top, w] of this.getRects(ox, oy)) {
      const option = this.options[idx];
      const current = idx === this.currentIndex && this.takesInput && !!this.drawCursor;
      if (this.highlight && (current || idx === this.fakeCursorIdx)) drawMenuHighlight(surf, left, top, w + 14);
      this.drawOption(surf, option, idx, left, top);
      if (idx === this.fakeCursorIdx) this.stationaryCursor.draw(surf, left, top);
      if (current) this.cursor.draw(surf, left, top);
    }
  }
}

function drawChoiceOption(surf: Surface, game: any, entry: ChoiceEntry, ignore: boolean, x: number, y: number): void {
  if (entry.kind === 'text') {
    drawText(surf, entry.text, x + 5, y, ignore ? 'grey' : null);
  } else if (entry.kind === 'item') {
    drawItemOption(surf, game, entry.item, x, y, { ignore, owner: entry.owner ?? null });
  }
}

// ---------------------------------------------------------------------------
// ItemOption
// ---------------------------------------------------------------------------

/** Python item.value (raw Value component). */
function itemValue(game: any, item: ItemObject): number {
  return Number(itemFullPrice(null, item, game.db, game) ?? 0) || 0;
}

/** Python item_funcs.buy_price / sell_price (skill-modified, truncated). */
export function shopPrice(game: any, unit: UnitObject | null, item: ItemObject, kind: 'buy' | 'sell'): number {
  const raw = kind === 'buy'
    ? itemBuyPrice(unit, item, game.db, game)
    : itemSellPrice(unit, item, game.db, game);
  if (!raw) return 0;
  const mult = unit ? priceSkillMultiplier(unit, item, kind === 'buy' ? 'change_buy_price' : 'change_sell_price', game) : 1;
  return Math.trunc(raw * mult);
}

/** Python ItemOption uses string (uses, parent uses, c_uses, cooldown). */
export function itemUsesString(item: ItemObject): string {
  const data: Map<string, any> = (item as any).data ?? new Map();
  if (item.maxUses > 0) return String(item.uses);
  const parent = item.parentItem;
  if (parent && parent.maxUses > 0 && parent.uses) return String(parent.uses);
  if (data.get('c_uses') !== undefined && data.get('c_uses') !== null) return String(data.get('c_uses'));
  const parentData: Map<string, any> | undefined = (parent as any)?.data;
  if (parentData?.get('c_uses')) return String(parentData.get('c_uses'));
  if (data.get('cooldown') !== undefined && data.get('cooldown') !== null) return String(data.get('cooldown'));
  return '--';
}

/** Python ItemOption.get_color -> [mainColor, usesColor]. */
export function itemOptionColors(
  game: any, item: ItemObject, ignore: boolean, convoyOwner: UnitObject | null = null, convoy = false,
): [string | null, string] {
  const owner: UnitObject | null = convoyOwner ?? item.owner ?? null;
  if (convoy) {
    // ConvoyItemOption.get_color: availability for the unit at the convoy.
    const textColor = itemTextColor(item);
    if (ignore) return ['grey', 'grey'];
    if (textColor) return [String(textColor), 'blue'];
    let ok = true;
    if (owner) { try { ok = itemAvailable(owner, item, game.db, game); } catch { ok = true; } }
    return ok ? [null, 'blue'] : ['grey', 'grey'];
  }
  let main: string | null = 'grey';
  let uses = 'grey';
  const textColor = itemTextColor(item);
  const isAvailable = (unit: UnitObject | null) => {
    if (!unit) return true;
    try { return itemAvailable(unit, item, game.db, game); } catch { return true; }
  };
  if (ignore) {
    // grey
  } else if (textColor) {
    main = String(textColor);
    if (!(owner && !isAvailable(owner))) uses = 'blue';
  } else if (item.droppable && !convoyOwner) {
    main = 'green';
    uses = 'green';
  } else if (isForkEngine() && item.hasComponent('c_uses')) {
    // EOtF fork ItemOption.get_color: chapter-use items get purple uses.
    main = null;
    uses = 'purple';
  } else if (!owner || isAvailable(owner)) {
    main = null;
    uses = 'blue';
  }
  return [main, uses];
}

/** Python ItemOption.draw (104 wide: icon, name, uses right-aligned at x + 99). */
export function drawItemOption(
  surf: Surface, game: any, item: ItemObject, x: number, y: number,
  opts: { ignore?: boolean; owner?: UnitObject | null } = {},
): void {
  if (item.iconNid) drawIcon16(surf, item.iconNid, [Number(item.iconIndex?.[0]) || 0, Number(item.iconIndex?.[1]) || 0], x + 2, y);
  const [main, uses] = itemOptionColors(game, item, !!opts.ignore, opts.owner ?? null);
  const font = textWidth(item.name) > 60 ? 'narrow' : 'text';
  drawText(surf, item.name, x + 20, y, main, font);
  drawTextRight(surf, itemUsesString(item), x + 99, y, uses);
}

// ---------------------------------------------------------------------------
// draw_unit_items and friends
// ---------------------------------------------------------------------------

export function totalItemSlots(game: any): number {
  return Number(game.db?.getConstant?.('num_items', 5) ?? 5) + Number(game.db?.getConstant?.('num_accessories', 0) ?? 0);
}

/** Python icons.draw_chibi: the 32x32 chibi at (96, 16) of the portrait sheet. */
export function drawChibi(surf: Surface, game: any, portraitNid: string, x: number, y: number): void {
  const sheet = getPortraitSheet(game, portraitNid);
  if (sheet) surf.blitImage(sheet, 96, 16, 32, 32, x, y);
}

/** Python menus.draw_unit_top. */
export function drawUnitTop(surf: Surface, game: any, x: number, y: number, unit: UnitObject | null): void {
  const top = getSprite('prep_top');
  if (top) surf.blitImage(top, 0, 0, top.width, top.height, x - 6, y - top.height);
  if (!unit) return;
  if (unit.portraitNid) drawChibi(surf, game, unit.portraitNid, x + 3, y - 35);
  drawTextCenter(surf, unit.name, x + 68, y - 35);
  drawTextRight(surf, String(unit.level), x + 72, y - 19, null, 'text-blue');
  drawTextRight(surf, String(unit.exp ?? 0), x + 97, y - 19, null, 'text-blue');
}

/** Python menus.draw_unit_face (translucent 96x76 face in the item box). */
export function drawUnitFace(surf: Surface, game: any, x: number, y: number, unit: UnitObject, right: boolean): void {
  const sheet = getPortraitSheet(game, unit.portraitNid);
  if (!sheet) return;
  const offset = Number(game.db?.portraits?.get?.(unit.portraitNid)?.info_offset ?? 0);
  const sy = Math.max(0, offset - 4);
  const left = x + 4 + 1;
  const top = y + (16 * totalItemSlots(game) + 8) - 4 - 76;
  const ctx = surf.ctx;
  const s = surf.scale;
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.globalAlpha = 0.5;
  if (right) {
    ctx.translate(Math.round((left + 96) * s), 0);
    ctx.scale(-1, 1);
    ctx.drawImage(sheet, 0, sy, 96, 76, 0, Math.round(top * s), 96 * s, 76 * s);
  } else {
    ctx.drawImage(sheet, 0, sy, 96, 76, Math.round(left * s), Math.round(top * s), 96 * s, 76 * s);
  }
  ctx.restore();
}

/** Python menus.make_bg_surf + draw_unit_items. */
export function drawUnitItems(
  surf: Surface, game: any, x: number, y: number, unit: UnitObject | null,
  opts: { includeTop?: boolean; includeBottom?: boolean; includeFace?: boolean; right?: boolean; shimmer?: number } = {},
): void {
  if (opts.includeTop) drawUnitTop(surf, game, x, y, unit);
  if (opts.includeBottom === false) return;
  const height = 16 * totalItemSlots(game) + 8;
  const bg = baseSurf(104, height, 'menu_bg_base');
  blitTranslucent(surf, bg, x, y, 0.1);
  if (opts.shimmer) {
    const img = getSprite(`menu_shimmer${opts.shimmer}`);
    if (img) blitSprite(surf, img, x + bg.width - img.width - 1, y + bg.height - img.height - 5, 0.9);
  }
  if (!unit) return;
  if (opts.includeFace) drawUnitFace(surf, game, x, y, unit, opts.right ?? true);
  const items = unit.items.filter((item) => !item.isAccessory());
  const accessories = unit.items.filter((item) => item.isAccessory());
  items.forEach((item, idx) => drawItemOption(surf, game, item, x, y + idx * 16 + 4));
  const numItems = Number(game.db?.getConstant?.('num_items', 5) ?? 5);
  accessories.forEach((item, idx) => drawItemOption(surf, game, item, x, y + numItems * 16 + idx * 16 + 4));
}

/**
 * Python prep.draw_funds: "C: Info" and the funds display. The EOtF fork
 * moves the Info line up to y=128 and adds "V: Gallery" (AUX) at y=143.
 */
export function drawFunds(surf: Surface, game: any, ox = 0, oy = 0): void {
  const fork = isForkEngine();
  const helper = 'C';
  const infoY = fork ? 128 : 143;
  drawText(surf, helper, ox + 123, oy + infoY, null, 'text-yellow');
  drawText(surf, ': Info', ox + 123 + textWidth(helper, 'text-blue'), oy + infoY);
  if (fork) {
    const aux = 'V';
    drawText(surf, aux, ox + 123, oy + 143, null, 'text-yellow');
    drawText(surf, ': Gallery', ox + 123 + textWidth(aux, 'text-blue'), oy + 143);
  }
  const funds = getSprite('funds_display');
  if (funds) surf.blitImage(funds, 0, 0, funds.width, funds.height, ox + 168, oy + 137);
  drawTextRight(surf, String(game.getMoney?.() ?? 0), ox + 219, oy + 141, null, 'text-blue');
}

/** Python prep.PrepManageState.create_quick_disp (Manage / Optimize All legend). */
export function drawQuickDisp(surf: Surface, x: number, y: number): void {
  const commands = ['Manage', 'Optimize All'];
  const width = 49 + Math.max(...commands.map((c) => textWidth(c)));
  blitTranslucent(surf, baseSurf(width, 40, 'menu_bg_brown'), x, y, 0.1);
  const buttons = getSprite('buttons');
  if (buttons) {
    surf.blitImage(buttons, 0, 66, 14, 13, x + 20 - 7, y + 18 - 13);
    surf.blitImage(buttons, 0, 165, 33, 9, x + 20 - 16, y + 32 - 9);
  }
  commands.forEach((command, idx) => drawText(surf, command, x + 38, y + idx * 16 + 3));
}

/** Python PrepFormationSelectState hand marker over a map tile. */
const MARKER_OFFSET = [0, 1, 2, 3, 4, 5, 4, 3, 2, 1];
export function drawFormationHand(surf: Surface, game: any, pos: [number, number], bob: boolean): void {
  const marker = getSprite('menu_hand_rotated');
  if (!marker) return;
  const [camX, camY] = game.camera?.getOffset?.() ?? [0, 0];
  const x = pos[0] * TILEWIDTH - camX + 2;
  const offset = bob ? MARKER_OFFSET[Math.floor(getFrameCount() / 3) % MARKER_OFFSET.length] : 0;
  const y = (pos[1] - 1) * TILEHEIGHT - camY + offset;
  surf.blitImage(marker, 0, 0, marker.width, marker.height, x, y);
}

/** First-push semantics from the web input manager (Python FluidScroll). */
export function isFirstPush(game: any, dir: string): boolean {
  const input = game.input;
  if (!input?.isPressed) return true;
  return !input.isPressed(dir) || !!input.justPressed?.(dir);
}

/** Python banner.Custom shown through AlertState (menu_bg_base box, gem). */
export class CustomAlert {
  readonly text: string;
  private startTime: number | null = null;
  done = false;

  constructor(text: string) {
    this.text = text;
  }

  update(): void {
    const now = performance.now();
    if (this.startTime === null) this.startTime = now;
    if (now - this.startTime > 3000) this.done = true;
  }

  /** AlertState.take_input: any input after time_to_pause dismisses. */
  takeInput(event: string | null): void {
    if (event && this.startTime !== null && performance.now() - this.startTime > 300) this.done = true;
  }

  draw(surf: Surface): void {
    let length = textWidth(this.text) + 16;
    length -= length % 8;
    const x = Math.floor(viewport.width / 2 - (length + 2) / 2);
    const y = Math.floor(viewport.height / 2 - (24 + 4) / 2);
    blitTranslucent(surf, baseSurf(length, 24, 'menu_bg_base'), x + 2, y + 4, 0.1);
    blitSprite(surf, getSprite('menu_gem_small'), x, y, 0.9);
    drawText(surf, this.text, x + 6, y + 12 - 8 + 3);
  }
}

// ---------------------------------------------------------------------------
// Trade (menus.Trade)
// ---------------------------------------------------------------------------

/** Python icons.get_portrait (96x80 face) drawn optionally flipped. */
export function drawPortrait(
  surf: Surface, game: any, unit: UnitObject, x: number, y: number,
  crop: [number, number, number, number] = [0, 0, 96, 80], flip = false,
): void {
  const sheet = getPortraitSheet(game, unit.portraitNid);
  if (!sheet) return;
  const [sx, sy, sw, sh] = crop;
  const ctx = surf.ctx;
  const s = surf.scale;
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  if (flip) {
    ctx.translate(Math.round((x + sw) * s), 0);
    ctx.scale(-1, 1);
    ctx.drawImage(sheet, sx, sy, sw, sh, 0, Math.round(y * s), sw * s, sh * s);
  } else {
    ctx.drawImage(sheet, sx, sy, sw, sh, Math.round(x * s), Math.round(y * s), sw * s, sh * s);
  }
  ctx.restore();
}

/** Python menus.Trade.get_items: items + blank slots, accessories + blank slots. */
export function tradeEntries(game: any, unit: UnitObject): ChoiceEntry[] {
  const numItems = Number(game.db?.getConstant?.('num_items', 5) ?? 5);
  const numAccessories = Number(game.db?.getConstant?.('num_accessories', 0) ?? 0);
  const items = unit.items.filter((i) => !i.isAccessory());
  const accessories = unit.items.filter((i) => i.isAccessory());
  const entries: ChoiceEntry[] = items.map((item) => ({ kind: 'item', item }));
  for (let n = items.length; n < numItems; n++) entries.push({ kind: 'blank' });
  for (const item of accessories) entries.push({ kind: 'item', item });
  for (let n = accessories.length; n < numAccessories; n++) entries.push({ kind: 'blank' });
  return entries;
}

export class TradeMenu {
  readonly owner: UnitObject;
  readonly partner: UnitObject;
  menu1: Choice;
  menu2: Choice;
  selectingHand: [number, number] = [0, 0];
  otherHand: [number, number] | null = null;
  selectedIdx: [number, number] | null = null;
  private game: any;

  constructor(game: any, owner: UnitObject, partner: UnitObject) {
    this.game = game;
    this.owner = owner;
    this.partner = partner;
    const limit = Math.min(5, totalItemSlots(game));
    this.menu1 = new Choice(game, tradeEntries(game, owner), [11, 68]);
    this.menu1.setLimit(limit);
    this.menu2 = new Choice(game, tradeEntries(game, partner), [125, 68]);
    this.menu2.setLimit(limit);
    this.menu2.drawCursor = 0;
  }

  private menuFor(side: number): Choice { return side === 0 ? this.menu1 : this.menu2; }

  hasSelection(): boolean { return this.selectedIdx !== null; }

  /** menus.Trade.toggle_info / draw_info for the menu under the selecting hand. */
  get infoFlag(): boolean { return this.menuFor(this.selectingHand[0]).infoFlag; }
  toggleInfo(): void {
    const flag = !this.infoFlag;
    this.menu1.infoFlag = flag;
    this.menu2.infoFlag = flag;
  }
  drawInfo(surf: Surface, ox = 0, oy = 0): void {
    if (this.infoFlag) this.menuFor(this.selectingHand[0]).drawInfo(surf, ox, oy);
  }

  /** The selected [owner, item|null] and the hovered [owner, item|null]. */
  selectedItem(): [UnitObject, ItemObject | null] | null {
    if (!this.selectedIdx) return null;
    const [side, idx] = this.selectedIdx;
    return [side === 0 ? this.owner : this.partner, this.menuFor(side).itemAt(idx)];
  }
  currentItem(): [UnitObject, ItemObject | null] {
    const [side, idx] = this.selectingHand;
    return [side === 0 ? this.owner : this.partner, this.menuFor(side).itemAt(idx)];
  }

  setSelectedOption(): void {
    this.otherHand = this.selectingHand;
    this.selectedIdx = [...this.selectingHand] as [number, number];
    const [side, idx] = this.selectingHand;
    const other = this.menuFor(1 - side);
    const mine = this.menuFor(side);
    const good = other.options.filter((o) => !o.ignore && o.entry.kind === 'item');
    const empty = other.options.map((o, i) => (o.ignore || o.entry.kind !== 'item' ? i : -1)).filter((i) => i >= 0);
    if (good.length > totalItemSlots(this.game)) other.moveTo(idx);
    else if (empty.length) other.moveTo(empty[0]);
    else other.moveTo(good.length);
    other.cursor.yOffset = 0;
    this.selectingHand = [1 - side, other.currentIndex];
    mine.fakeCursorIdx = idx;
    other.drawCursor = 1;
    mine.drawCursor = 0;
  }

  unsetSelectedOption(): void {
    this.selectedIdx = null;
    this.selectingHand = this.otherHand ?? this.selectingHand;
    this.otherHand = null;
    this.menu1.fakeCursorIdx = null;
    this.menu2.fakeCursorIdx = null;
    const [side, idx] = this.selectingHand;
    const menu = this.menuFor(side);
    menu.moveTo(idx);
    this.selectingHand = [side, menu.currentIndex];
    menu.drawCursor = 1;
    this.menuFor(1 - side).drawCursor = 0;
  }

  updateOptions(): void {
    const i1 = this.menu1.currentIndex;
    const i2 = this.menu2.currentIndex;
    this.menu1.setOptions(tradeEntries(this.game, this.owner));
    this.menu2.setOptions(tradeEntries(this.game, this.partner));
    this.menu1.currentIndex = Math.min(i1, this.menu1.options.length - 1);
    this.menu2.currentIndex = Math.min(i2, this.menu2.options.length - 1);
  }

  moveDown(firstPush = true): boolean {
    const [side, old] = this.selectingHand;
    const menu = this.menuFor(side);
    menu.currentIndex = old;
    menu.moveDown(firstPush);
    this.selectingHand = [side, menu.currentIndex];
    return menu.currentIndex !== old;
  }

  moveUp(firstPush = true): boolean {
    const [side, old] = this.selectingHand;
    const menu = this.menuFor(side);
    menu.currentIndex = old;
    menu.moveUp(firstPush);
    this.selectingHand = [side, menu.currentIndex];
    return menu.currentIndex !== old;
  }

  moveLeft(): boolean {
    if (this.selectingHand[0] !== 1) return false;
    const valid = this.menu1.options.filter((o) => !o.ignore).length;
    this.menu1.moveTo(Math.max(0, Math.min(this.selectingHand[1], valid - 1)));
    this.selectingHand = [0, this.menu1.currentIndex];
    this.menu1.drawCursor = 1;
    this.menu1.cursor.yOffset = 0;
    this.menu2.drawCursor = 0;
    return true;
  }

  moveRight(): boolean {
    if (this.selectingHand[0] !== 0) return false;
    const valid = this.menu2.options.filter((o) => !o.ignore).length;
    this.menu2.moveTo(Math.max(0, Math.min(this.selectingHand[1], valid - 1)));
    this.selectingHand = [1, this.menu2.currentIndex];
    this.menu2.drawCursor = 1;
    this.menu2.cursor.yOffset = 0;
    this.menu1.drawCursor = 0;
    return true;
  }

  /** Mouse hover: move the selecting hand onto the hovered row. */
  handleMouse(gx: number, gy: number, ox = 0, oy = 0): number {
    for (const side of [0, 1]) {
      const menu = this.menuFor(side);
      for (const [idx, x, y, w, h] of menu.getRects(ox, oy)) {
        if (gx >= x && gx <= x + w && gy >= y && gy <= y + h) {
          menu.moveTo(idx);
          if (this.selectingHand[0] !== side) {
            menu.drawCursor = 1;
            this.menuFor(1 - side).drawCursor = 0;
          }
          this.selectingHand = [side, idx];
          return idx;
        }
      }
    }
    return -1;
  }

  update(): void {
    this.menu1.update();
    this.menu2.update();
  }

  draw(surf: Surface, ox = 0, oy = 0): void {
    const game = this.game;
    const nameSurf = getSprite('trade_name');
    if (nameSurf) {
      surf.blitImage(nameSurf, 0, 0, nameSurf.width, nameSurf.height, ox - 4, oy - 1);
      surf.blitImage(nameSurf, 0, 0, nameSurf.width, nameSurf.height, ox + WINWIDTH - nameSurf.width + 4, oy - 1);
    }
    drawText(surf, this.owner.name, ox + 24 - Math.floor(textWidth(this.owner.name) / 2), oy);
    drawText(surf, this.partner.name, ox + WINWIDTH - 24 - Math.floor(textWidth(this.partner.name) / 2), oy);
    drawPortrait(surf, game, this.owner, ox + 11 + 52 - 48, oy, [0, 3, 96, 68], true);
    drawPortrait(surf, game, this.partner, ox + 125 + 52 - 48, oy, [0, 3, 96, 68], false);
    this.menu1.draw(surf, ox, oy);
    this.menu2.draw(surf, ox, oy);
  }
}

/** Python trade.check_trade. */
export function checkTrade(
  game: any, item1: ItemObject | null, owner1: UnitObject | null, item2: ItemObject | null, owner2: UnitObject | null,
): boolean {
  if (item1 === item2) return false; // same item, or two open slots

  if (owner1 === owner2) return true;
  if (item1 && item1.hasComponent('locked')) return false;
  if (item2 && item2.hasComponent('locked')) return false;
  if (item1 && item2 && item1.isAccessory() === item2.isAccessory()) return true;
  const numItems = Number(game.db?.getConstant?.('num_items', 5) ?? 5);
  const numAccessories = Number(game.db?.getConstant?.('num_accessories', 0) ?? 0);
  const count = (u: UnitObject, acc: boolean) => u.items.filter((i) => i.isAccessory() === acc).length;
  if (item1 && owner2) {
    if (count(owner2, item1.isAccessory()) >= (item1.isAccessory() ? numAccessories : numItems)) return false;
  }
  if (item2 && owner1) {
    if (count(owner1, item2.isAccessory()) >= (item2.isAccessory() ? numAccessories : numItems)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Convoy / Market (menus.Convoy, menus.Market)
// ---------------------------------------------------------------------------

/** Python gui.ScrollArrow ('left'/'right' page arrows). */
class PageArrow {
  private counter: number;
  private increment: number[] = [];
  private offset: number[] = [];
  private direction: 'left' | 'right';
  private x: number;
  private y: number;

  constructor(direction: 'left' | 'right', topleft: [number, number], offset = 0) {
    this.direction = direction;
    this.x = topleft[0];
    this.y = topleft[1];
    this.counter = offset;
  }

  pulse(): void {
    this.increment = [1, 1, 1, 1, 1, 1, 1, 1, .5, .5, .5, .5, .25, .25, .25];
    this.offset = [4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 3, 3, 3, 3, 2, 2, 2, 1, 1];
  }

  draw(surf: Surface, ox: number, oy: number): void {
    this.counter += this.increment.length ? this.increment.pop()! : 0.125;
    if (this.counter >= 6) this.counter = 0;
    const sheet = getSprite('page_arrows');
    if (!sheet) return;
    const frame = Math.floor(this.counter);
    const shift = this.offset.length ? this.offset.shift()! : 0;
    if (this.direction === 'left') {
      surf.blitImage(sheet, frame * 8, 0, 8, 14, ox + this.x - shift, oy + this.y);
    } else {
      // flip_horiz(flip_vert(page_arrows)): rotate the sheet 180 degrees.
      const ctx = surf.ctx;
      const s = surf.scale;
      ctx.save();
      ctx.imageSmoothingEnabled = false;
      ctx.translate(Math.round((ox + this.x + shift + 8) * s), Math.round((oy + this.y + 14) * s));
      ctx.scale(-1, -1);
      ctx.drawImage(sheet, (5 - frame) * 8, 0, 8, 14, 0, 0, 8 * s, 14 * s);
      ctx.restore();
    }
  }
}

/** Python icons.draw_weapon (optionally greyed). */
function drawWeaponIcon(surf: Surface, game: any, weaponNid: string, x: number, y: number, gray: boolean): void {
  const def = (game.db?.weapons ?? []).find((w: any) => w.nid === weaponNid);
  if (!def?.icon_nid) return;
  const idx: [number, number] = [Number(def.icon_index?.[0]) || 0, Number(def.icon_index?.[1]) || 0];
  if (!gray) { drawIcon16(surf, def.icon_nid, idx, x, y); return; }
  const tmp = new Surface(16, 16);
  drawIcon16(tmp, def.icon_nid, idx, 0, 0);
  surf.blit(tmp.makeGray(), x, y);
}

/** menus.Inventory entries for a Choice (items, empty slots, accessories). */
export function inventoryChoiceEntries(game: any, unit: UnitObject): ChoiceEntry[] {
  const numItems = Number(game.db?.getConstant?.('num_items', 5) ?? 5);
  const numAccessories = Number(game.db?.getConstant?.('num_accessories', 0) ?? 0);
  const items = unit.items.filter((i) => !i.isAccessory());
  const accessories = unit.items.filter((i) => i.isAccessory());
  const entries: ChoiceEntry[] = items.map((item) => ({ kind: 'item', item }));
  for (let n = items.length; n < numItems; n++) entries.push({ kind: 'empty' });
  for (const item of accessories) entries.push({ kind: 'item', item });
  for (let n = accessories.length; n < numAccessories; n++) entries.push({ kind: 'empty' });
  return entries;
}

export interface ConvoyOptions {
  includeOtherUnits?: boolean;
  dispValue?: 'buy' | 'sell' | null;
  /** Market: fixed item list instead of convoy + party items. */
  marketItems?: ItemObject[] | null;
  /** Market: party items including the owner's (Python Market). */
  market?: boolean;
  showStock?: boolean;
  stockOf?: (item: ItemObject) => number;
}

/**
 * Python menus.Convoy (and menus.Market when `market` is set): one Choice
 * per visible weapon type with a weapon-icon tab strip, the unit's
 * Inventory bottom-left, owner panel and page arrows.
 */
export class ConvoyMenu {
  readonly unit: UnitObject;
  readonly topleft: [number, number];
  readonly opts: ConvoyOptions;
  takesInput = true;
  order: string[];
  menus = new Map<string, Choice>();
  inventory: Choice | null = null;
  selectionIndex = 0;
  menuIndex = 0;
  locked = false;
  gotoFlag = false;
  infoFlag = false;
  private menuWidth: number;
  private leftArrow: PageArrow;
  private rightArrow: PageArrow;
  private game: any;

  constructor(game: any, owner: UnitObject, topleft: [number, number], opts: ConvoyOptions = {}) {
    this.game = game;
    this.unit = owner;
    this.topleft = topleft;
    this.opts = opts;
    this.order = (game.db?.weapons ?? []).filter((w: any) => !w.hide_from_display).map((w: any) => w.nid);
    if (!this.order.includes('Default')) this.order.push('Default');
    this.menuWidth = opts.dispValue ? 152 : 112;
    const [x, y] = topleft;
    this.leftArrow = new PageArrow('left', [x - 4, y - 14]);
    this.rightArrow = new PageArrow('right', [x + this.menuWidth - 4, y - 14], 0.5);
    this.buildMenus();
    if (opts.market) {
      this.selectionIndex = 1;
      this.inventory = null;
    } else {
      for (const menu of this.menus.values()) menu.takesInput = false;
    }
  }

  private allItems(): ItemObject[] {
    const game = this.game;
    if (this.opts.market && this.opts.marketItems) return this.opts.marketItems;
    const items: ItemObject[] = [...(game.getParty?.()?.convoy ?? [])];
    if (this.opts.market || (this.opts.includeOtherUnits ?? true)) {
      for (const unit of (game.getUnitsInParty?.() ?? []) as UnitObject[]) {
        if (!this.opts.market && unit.nid === this.unit.nid) continue;
        items.push(...unit.items.filter((i) => !i.hasComponent('locked')));
      }
    }
    return items;
  }

  /** Python Convoy.get_sorted_dict (successive stable sorts). */
  private sortedDict(): Map<string, ItemObject[]> {
    const game = this.game;
    const all = this.allItems();
    const dict = new Map<string, ItemObject[]>();
    for (const wType of this.order) {
      if (wType !== 'Default') dict.set(wType, all.filter((i) => itemWeaponType(this.unit, i) === wType));
    }
    dict.set('Default', all.filter((i) => !itemWeaponType(this.unit, i)));
    const full = (i: ItemObject) => Number(itemFullPrice(this.unit, i, game.db, game) ?? 0) || 0;
    const sell = (i: ItemObject) => Number(itemSellPrice(this.unit, i, game.db, game) ?? 0) || 0;
    for (const list of dict.values()) {
      list.sort((a, b) =>
        (Number(!!a.owner) - Number(!!b.owner)) || (full(a) - full(b)) || (sell(a) - sell(b)) ||
        (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    }
    return dict;
  }

  private fill(menu: Choice, items: ItemObject[]): void {
    if (this.opts.showStock) menu.stock = items.map((i) => this.opts.stockOf?.(i) ?? -1);
    const idx = menu.currentIndex;
    menu.setOptions(items.map((item) => ({ kind: 'item' as const, item })));
    menu.currentIndex = Math.min(idx, menu.options.length - 1);
    menu.scroll = Math.max(0, Math.min(menu.scroll, menu.options.length - menu.limit));
  }

  private buildMenus(): void {
    const dict = this.sortedDict();
    this.menus.clear();
    for (const wType of this.order) {
      const menu = new Choice(this.game, [], this.topleft);
      menu.owner = this.unit;
      menu.isConvoy = !this.opts.dispValue;
      menu.dispValue = this.opts.dispValue ?? null;
      menu.setLimit(7);
      menu.hardLimit = true;
      menu.gem = false;
      menu.shimmer = 2;
      this.fill(menu, dict.get(wType) ?? []);
      this.menus.set(wType, menu);
    }
    if (!this.opts.market) {
      const height = totalItemSlots(this.game) * 16 + 8;
      this.inventory = new Choice(this.game, inventoryChoiceEntries(this.game, this.unit), [12, WINHEIGHT - height - 4]);
      this.inventory.gem = false;
      this.inventory.shimmer = 2;
    }
  }

  updateOptions(): void {
    if (this.inventory) {
      const idx = this.inventory.currentIndex;
      this.inventory.setOptions(inventoryChoiceEntries(this.game, this.unit));
      this.inventory.currentIndex = Math.min(idx, this.inventory.options.length - 1);
    }
    const dict = this.sortedDict();
    for (const [name, menu] of this.menus) this.fill(menu, dict.get(name) ?? []);
  }

  getMenu(): Choice { return this.menus.get(this.order[this.menuIndex])!; }

  /** menus.Convoy.toggle_info */
  toggleInfo(): void {
    this.infoFlag = !this.infoFlag;
  }

  /** menus.Convoy.draw_info: help for the inventory or the open convoy tab. */
  drawInfo(surf: Surface, ox = 0, oy = 0): void {
    const menu = this.selectionIndex === 0 ? this.inventory : this.getMenu();
    menu?.drawInfo(surf, ox, oy);
  }
  getCurrent(): ItemObject | null {
    return this.selectionIndex === 0 ? this.inventory?.getCurrentItem() ?? null : this.getMenu().getCurrentItem();
  }
  getConvoyCurrent(): ItemObject | null { return this.getMenu().getCurrentItem(); }
  getInventoryCurrent(): ItemObject | null { return this.inventory?.getCurrentItem() ?? null; }
  getCurrentIndex(): number {
    return this.selectionIndex === 0 ? this.inventory?.currentIndex ?? 0 : this.getMenu().currentIndex;
  }
  getScrolledIndex(): number { return this.getMenu().scroll; }
  getContext(): 'inventory' | 'convoy' { return this.selectionIndex === 0 ? 'inventory' : 'convoy'; }

  /** Market stock of the hovered item (-1 when unlimited). */
  getStock(): number {
    if (!this.opts.showStock) return -1;
    const menu = this.getMenu();
    return menu.stock?.[menu.currentIndex] ?? -1;
  }

  setTakesInput(value: boolean): void {
    this.takesInput = value;
    if (this.opts.market) for (const menu of this.menus.values()) menu.takesInput = value;
  }

  moveToInventory(): void {
    this.getMenu().takesInput = false;
    this.selectionIndex = 0;
    if (this.inventory) this.inventory.takesInput = true;
    this.locked = true;
  }

  moveToConvoy(): void {
    if (this.inventory) this.inventory.takesInput = false;
    this.selectionIndex = this.menuIndex + 1;
    this.getMenu().takesInput = true;
    this.locked = true;
  }

  moveToItemType(item: ItemObject): void {
    const wType = itemWeaponType(this.unit, item);
    this.menuIndex = wType && this.order.includes(wType) ? this.order.indexOf(wType) : this.order.length - 1;
    this.gotoFlag = true;
  }

  unlock(): void { this.locked = false; }

  moveDown(firstPush = true): boolean {
    return this.selectionIndex === 0 ? !!this.inventory?.moveDown(firstPush) : this.getMenu().moveDown(firstPush);
  }
  moveUp(firstPush = true): boolean {
    return this.selectionIndex === 0 ? !!this.inventory?.moveUp(firstPush) : this.getMenu().moveUp(firstPush);
  }

  private setActive(selection: number): void {
    if (!this.opts.market) {
      if (this.selectionIndex === 0) { if (this.inventory) this.inventory.takesInput = false; }
      else this.getMenu().takesInput = false;
    }
    this.selectionIndex = selection;
    if (selection > 0) this.menuIndex = selection - 1;
    if (!this.opts.market) {
      if (selection === 0) { if (this.inventory) this.inventory.takesInput = true; }
      else this.getMenu().takesInput = true;
    }
  }

  moveLeft(firstPush = true): boolean {
    const n = this.order.length;
    if (this.opts.market) {
      if (this.selectionIndex === 1) this.setActive(firstPush ? n : 1);
      else { this.setActive(this.selectionIndex - 1); this.leftArrow.pulse(); }
      return true;
    }
    if (this.selectionIndex === 0) {
      if (this.locked || !firstPush) return false;
      this.setActive(n);
    } else if (this.selectionIndex === 1) {
      this.setActive(this.locked ? n : 0);
    } else {
      this.setActive(this.selectionIndex - 1);
      this.leftArrow.pulse();
    }
    return true;
  }

  moveRight(firstPush = true): boolean {
    const n = this.order.length;
    if (this.opts.market) {
      if (this.selectionIndex === n) this.setActive(firstPush ? 1 : n);
      else { this.setActive(this.selectionIndex + 1); this.rightArrow.pulse(); }
      return true;
    }
    if (this.selectionIndex === 0) {
      if (this.locked || !firstPush) return false;
      const target = this.gotoFlag ? this.menuIndex + 1 : 1;
      this.gotoFlag = false;
      this.setActive(target);
    } else if (this.selectionIndex === n) {
      this.setActive(this.locked ? 1 : 0);
    } else {
      this.setActive(this.selectionIndex + 1);
      this.rightArrow.pulse();
    }
    return true;
  }

  handleMouse(gx: number, gy: number, ox = 0, oy = 0): number {
    const main = this.menus.get(this.order[Math.max(0, this.selectionIndex - 1)]);
    for (const menu of [main, this.inventory]) {
      if (!menu) continue;
      for (const [idx, x, y, w, h] of menu.getRects(ox, oy)) {
        if (gx >= x && gx <= x + w && gy >= y && gy <= y + h) {
          menu.moveTo(idx);
          return idx;
        }
      }
    }
    return -1;
  }

  update(): void {
    this.getMenu().update();
    this.inventory?.update();
  }

  draw(surf: Surface, ox = 0, oy = 0): void {
    const game = this.game;
    const nameSurf = getSprite('trade_name');
    if (nameSurf) surf.blitImage(nameSurf, 0, 0, nameSurf.width, nameSurf.height, ox - 4, oy - 1);
    drawText(surf, this.unit.name, ox + 24 - Math.floor(textWidth(this.unit.name) / 2), oy);
    if (!this.opts.dispValue) drawPortrait(surf, game, this.unit, ox + 18, oy, [0, 0, 96, 68], true);
    blitTranslucent(surf, baseSurf(96, 24, 'menu_bg_base'), ox + 156, oy, 0.4);
    const item = this.getCurrent();

    const dist = (this.menuWidth - 10) / this.order.length;
    const [x, y] = this.topleft;
    for (let idx = this.order.length - 1; idx >= 0; idx--) {
      if (idx === this.selectionIndex - 1) continue;
      drawWeaponIcon(surf, game, this.order[idx], ox + x + 3 + Math.floor(idx * dist), oy + y - 14, true);
    }
    const sel = this.selectionIndex - 1;
    if (sel >= 0 && sel < this.order.length) {
      const tx = ox + x + 3 + Math.floor(sel * dist);
      drawWeaponIcon(surf, game, this.order[sel], tx, oy + y - 14, false);
      const shine = getSprite('weapon_shine');
      if (shine) surf.blitImage(shine, 0, 0, shine.width, shine.height, tx, oy + y - 14);
    }

    this.getMenu().draw(surf, ox, oy);
    this.inventory?.draw(surf, ox, oy);
    const owner = item?.owner ?? null;
    drawText(surf, owner && this.takesInput ? `Owner: ${owner.name}` : 'Owner: ---', ox + 160, oy + 4);
    this.leftArrow.draw(surf, ox, oy);
    this.rightArrow.draw(surf, ox, oy);
  }
}
