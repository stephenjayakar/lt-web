/**
 * title-menu.ts — Python menus.Main / ChapterSelect / ModeSelect and the
 * TitleOption family (game_menus/menu_options.py) used by the title,
 * extras, new-game, load and save screens.
 *
 * Options are drawn on their option_bg sprite (title_menu_dark,
 * chapter_select_<color>, mode_bg) with the 'chapter' font, the selected one
 * on its *_highlight variant, and a pair of cursor_dragon hands bobbing
 * vertically either side of the current row.
 */

import { Surface } from '../engine/surface';
import { FRAMETIME } from '../engine/constants';
import { FONT } from '../rendering/bmp-font';
import { MenuCursor, baseSurf, blitSprite, blitText, getSprite, textWidth } from './menu-chrome';
import { isForkEngine } from '../engine/engine-flavor';
import { RECORDS } from '../engine/records';

const CURSOR_ANIM = [0, 0, 0, 0, 0, 0, 0, 1, 1, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 4, 4, 4, 3, 3, 2, 2, 2, 1, 1, 1, 1];

/** menus.Cursor(cursor_dragon) pair: draw_vert, the right one mirrored. */
class DragonCursors {
  counter = 0;

  update(): void {
    this.counter = (this.counter + 1) % CURSOR_ANIM.length;
  }

  draw(surf: Surface, leftX: number, rightX: number, y: number): void {
    const img = getSprite('menus/cursor_dragon');
    if (!img) return;
    const top = y + 3 + CURSOR_ANIM[this.counter];
    surf.blitImage(img, 0, 0, img.width, img.height, leftX - 12, top);
    const ctx = surf.ctx;
    const s = surf.scale;
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    ctx.translate(Math.round((rightX - 12 + img.width) * s), Math.round(top * s));
    ctx.scale(-1, 1);
    ctx.drawImage(img, 0, 0, img.width, img.height, 0, 0, Math.round(img.width * s), Math.round(img.height * s));
    ctx.restore();
  }
}

/**
 * TitleOption.draw_text: 'chapter' font in grey with a 1px outline that
 * additively pulses between (192, 248, 248) and (56, 48, 40).
 */
export function drawTitleText(surf: Surface, text: string, cx: number, cy: number, timeMs: number, outline = true): void {
  const font = FONT['chapter'];
  const width = font ? font.width(text) : textWidth('text', text);
  const height = font ? font.height : 16;
  const x = cx - Math.floor(width / 2);
  const y = cy - Math.floor(height / 2);
  const fontNid = FONT['chapter-grey'] ? 'chapter-grey' : 'chapter';
  if (outline && font) {
    const t = Math.sin(((Math.floor(timeMs / 10) % 180) * Math.PI) / 180);
    const c1 = [192, 248, 248];
    const c2 = [56, 48, 40];
    const color = c1.map((v, i) => Math.trunc((c2[i] - v) * Math.max(0, Math.min(1, t))) + v);
    const ow = width + 4;
    const oh = height + 2;
    const out = new Surface(ow, oh);
    for (const [dx, dy] of [[1, 0], [0, 1], [1, 2], [2, 1]]) blitText(out, fontNid, text, dx, dy);
    // image_mods.change_color: add the colour to every opaque pixel.
    const tint = new Surface(ow, oh);
    tint.ctx.fillStyle = `rgb(${color[0]},${color[1]},${color[2]})`;
    tint.ctx.fillRect(0, 0, tint.canvas.width, tint.canvas.height);
    tint.ctx.globalCompositeOperation = 'destination-in';
    tint.ctx.drawImage(out.canvas, 0, 0);
    out.ctx.globalCompositeOperation = 'lighter';
    out.ctx.drawImage(tint.canvas, 0, 0);
    out.ctx.globalCompositeOperation = 'source-over';
    surf.blit(out, x - 1, y - 1);
  }
  blitText(surf, fontNid, text, x, y);
}

export interface TitleMenuDrawOptions {
  showCursor?: boolean;
  flicker?: boolean;
}

/** Python menus.Main */
export class TitleMainMenu {
  options: string[];
  currentIndex = 0;
  protected optionBg: string;
  protected cursors = new DragonCursors();
  protected time = 0;
  protected translate: (text: string) => string;

  constructor(options: string[], optionBg = 'title_menu_dark', translate: (text: string) => string = (t) => t) {
    this.options = options;
    this.optionBg = optionBg;
    this.translate = translate;
  }

  getCurrent(): string {
    return this.options[this.currentIndex];
  }

  /** Simple.move_down(first_push=True) with no scrolling limit. */
  moveDown(): boolean {
    if (!this.options.length) return false;
    this.currentIndex = (this.currentIndex + 1) % this.options.length;
    return true;
  }

  moveUp(): boolean {
    if (!this.options.length) return false;
    this.currentIndex = (this.currentIndex - 1 + this.options.length) % this.options.length;
    return true;
  }

  moveTo(idx: number): void {
    this.currentIndex = Math.max(0, Math.min(this.options.length - 1, idx));
  }

  update(): void {
    this.cursors.update();
    this.time += FRAMETIME;
  }

  protected bgName(_idx: number): string {
    return this.optionBg;
  }

  protected optionSize(idx: number): [number, number] {
    const img = getSprite(`menus/${this.bgName(idx)}`);
    return img ? [img.width, img.height] : [136, 24];
  }

  /** TitleOption.draw / draw_highlight / ChapterSelectOption.draw_flicker */
  protected drawOption(surf: Surface, idx: number, cx: number, top: number, variant: '' | '_highlight' | '_flicker'): void {
    const name = this.bgName(idx);
    const [w, h] = this.optionSize(idx);
    const left = cx - Math.floor(w / 2);
    blitSprite(surf, getSprite(`menus/${name}${variant}`) ?? getSprite(`menus/${name}`), left, Math.floor(top));
    drawTitleText(surf, this.translate(this.options[idx]), left + Math.floor(w / 2), Math.floor(top + h / 2 + 1), this.time);
  }

  draw(surf: Surface, cx: number, cy: number, opts: TitleMenuDrawOptions = {}): void {
    const n = this.options.length;
    if (!n) return;
    const [w, h] = this.optionSize(0);
    this.options.forEach((_, idx) => {
      const top = cy - (n / 2 - idx) * (h + 1);
      this.drawOption(surf, idx, cx, top, idx === this.currentIndex ? '_highlight' : '');
    });
    if (opts.showCursor ?? true) {
      const height = Math.floor(cy - 12 - (n / 2 - this.currentIndex) * (h + 1));
      this.cursors.draw(surf, cx - Math.floor(w / 2) - 8 - 8, cx + Math.floor(w / 2) - 8 + 8, height);
    }
  }
}

/** Python menus.ChapterSelect: save-slot style list with coloured backs. */
export class ChapterSelectMenu extends TitleMainMenu {
  colors: string[];
  private relPosY = 0;

  constructor(options: string[], colors: string[], translate?: (text: string) => string) {
    super(options, 'chapter_select', translate);
    this.colors = colors;
  }

  private get useRelY(): boolean {
    return this.options.length > 3;
  }

  setText(idx: number, text: string): void {
    this.options[idx] = text;
  }

  setColor(idx: number, color: string): void {
    this.colors[idx] = color;
  }

  protected override bgName(idx: number): string {
    return `chapter_select_${this.colors[idx] ?? 'green'}`;
  }

  override moveDown(): boolean {
    const moved = super.moveDown();
    if (this.useRelY) this.relPosY -= 30;
    return moved;
  }

  override moveUp(): boolean {
    const moved = super.moveUp();
    if (this.useRelY) this.relPosY += 30;
    return moved;
  }

  override update(): void {
    super.update();
    if (this.useRelY) {
      if (this.relPosY > 0) this.relPosY = Math.max(0, this.relPosY - 8);
      else if (this.relPosY < 0) this.relPosY = Math.min(0, this.relPosY + 8);
    }
  }

  override draw(surf: Surface, cx: number, cy: number, opts: TitleMenuDrawOptions = {}): void {
    const n = this.options.length;
    if (!n) return;
    const start = Math.max(0, this.currentIndex - 3);
    const shown = this.options.slice(start, this.currentIndex + 3);
    const [w, h] = this.optionSize(0);
    shown.forEach((_, i) => {
      const idx = start + i;
      const diff = idx - this.currentIndex;
      const top = this.useRelY
        ? cy + diff * (h + 1) + this.relPosY
        : cy + idx * (h + 1) - Math.floor((n * (h + 1)) / 2);
      const variant = idx !== this.currentIndex ? '' : opts.flicker ? '_flicker' : '_highlight';
      this.drawOption(surf, idx, cx, top, variant);
    });
    if (opts.showCursor ?? true) {
      const height = this.useRelY
        ? cy - 12
        : Math.floor(cy - 12 - (shown.length / 2 - (this.currentIndex - start)) * (h + 1));
      this.cursors.draw(surf, cx - Math.floor(w / 2) - 8 - 8, cx + Math.floor(w / 2) - 8 + 8, height);
    }
  }
}

/** Python menus.ModeSelect (ModeOption: mode_bg, no outline). */
export class ModeSelectMenu extends TitleMainMenu {
  ignore: boolean[] = [];

  constructor(options: string[], translate?: (text: string) => string) {
    super(options, 'mode_bg', translate);
  }

  protected override drawOption(surf: Surface, idx: number, cx: number, top: number, variant: '' | '_highlight' | '_flicker'): void {
    const [w, h] = this.optionSize(idx);
    const left = cx - Math.floor(w / 2);
    blitSprite(surf, getSprite(`menus/mode_bg${variant === '_highlight' ? '_highlight' : ''}`), left, Math.floor(top));
    const text = this.translate(this.options[idx]);
    const font = this.ignore[idx] ? 'chapter-black' : 'chapter-grey';
    const fw = textWidth(FONT[font] ? font : 'text', text);
    blitText(surf, FONT[font] ? font : 'text', text, left + Math.floor(w / 2) - Math.floor(fw / 2),
      Math.floor(top + h / 2 + 1) - 8);
  }
}

/** Start loading the title-menu sprites before the first draw. */
/**
 * Title panorama nid. The EOtF fork's TitleStartState shows
 * `title_background_2` once RECORDS has True_Ending_Cleared but not
 * Extra_Ending_Cleared; the other title states reuse that background.
 */
export function titleBackgroundNid(): string {
  if (isForkEngine() && RECORDS?.get('True_Ending_Cleared') && !RECORDS.get('Extra_Ending_Cleared')) {
    return 'title_background_2';
  }
  return 'title_background';
}

export function preloadTitleMenuSprites(): void {
  const names = ['cursor_dragon', 'title_menu_dark', 'title_menu_dark_highlight', 'mode_bg', 'mode_bg_highlight',
    'menu_highlight', 'menu_shimmer2'];
  for (const color of ['green', 'blue', 'red']) {
    names.push(`chapter_select_${color}`, `chapter_select_${color}_highlight`, `chapter_select_${color}_flicker`);
  }
  for (const name of names) getSprite(`menus/${name}`);
}

/** save.get_save_title: option names and difficulty-mode colours for save slots. */
export function chapterSelectFromSlots(
  slots: { name: string; displayName?: string | null; mode?: string | null }[],
  db: any,
): ChapterSelectMenu {
  const modes: any[] = Array.isArray(db?.difficultyModes) ? db.difficultyModes : [];
  const options = slots.map((slot) => slot.displayName || slot.name);
  const colors = slots.map((slot) => modes.find((m) => m.nid === slot.mode)?.color || 'green');
  return new ChapterSelectMenu(options, colors, (t) => db?.translate?.(t) ?? t);
}

/** Python menus.Choice with set_horizontal(True) (e.g. Overwrite / Back). */
export class HorizontalChoice {
  options: string[];
  currentIndex = 0;
  private cursor = new MenuCursor();

  constructor(options: string[]) {
    this.options = options;
  }

  moveDown(): boolean {
    this.currentIndex = (this.currentIndex + 1) % this.options.length;
    return true;
  }

  moveUp(): boolean {
    this.currentIndex = (this.currentIndex - 1 + this.options.length) % this.options.length;
    return true;
  }

  getCurrent(): string {
    return this.options[this.currentIndex];
  }

  update(): void {
    this.cursor.update();
  }

  draw(surf: Surface, x: number, y: number, opts: { background?: boolean; highlight?: boolean } = {}): void {
    const widths = this.options.map((o) => textWidth('text', o));
    const width = widths.reduce((sum, w) => sum + w + 8, 0) + 16;
    if (opts.background ?? true) {
      const bg = baseSurf(width, 24, 'menu_bg_base');
      const prev = bg.getAlpha();
      bg.setAlpha(0.5);
      surf.blit(bg, x, y);
      bg.setAlpha(prev);
    }
    const highlight = (opts.highlight ?? opts.background ?? true) ? getSprite('menus/menu_highlight') : null;
    let running = 0;
    this.options.forEach((option, idx) => {
      const left = x + running;
      const top = y + 4;
      if (idx === this.currentIndex && highlight) {
        for (let slot = 0; slot < Math.floor((widths[idx] + 14 - 10) / highlight.width); slot++) {
          blitSprite(surf, highlight, left + 5 + slot * highlight.width, top + 9);
        }
      }
      blitText(surf, 'text', option, left + 5, top);
      if (idx === this.currentIndex) this.cursor.draw(surf, left, top);
      running += widths[idx] + 8;
    });
  }
}
