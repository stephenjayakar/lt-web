/**
 * event-choice.ts — the `choice` event command's menu.
 *
 * Port of lt-maker/app/engine/game_menus/menu_components/generic_menu/
 * grid_choice.py (GridChoiceMenu) as used by player_choice.PlayerChoiceState:
 * one window holding an optional title line and a (cols x rows) grid of
 * options, aligned on screen with a 10px margin, scrolling when the data has
 * more rows/columns than the visible grid. Entry types draw an icon or map
 * sprite beside the text the way the Python option classes do.
 */

import { Surface } from '../engine/surface';
import type { InputEvent } from '../engine/input';
import type { MenuOption } from './menu';
import { getMenuBackgroundSync, getMenuHand, getMenuHighlight, loadMenuBgSprite } from './base-surf';
import { drawStyledText, measureStyledText } from './styled-text';
import { drawIcon16 } from './icons';
import type { HelpBox } from './help-menu';

let _audio: { playSfx(name: string): void } | null = null;
export function setEventChoiceAudio(am: { playSfx(name: string): void } | null): void {
  _audio = am;
}

export interface EventChoiceEntry {
  value: string;
  /** Display text (styled-text tags allowed). */
  text: string;
  icon?: { sheet: string; index: [number, number] } | null;
  /** Map sprite object (MapSprite) for type_unit / type_class entries. */
  sprite?: { draw(surf: Surface, x: number, y: number, ox: number, oy: number): void } | null;
  /** Right-aligned uses string for type_game_item entries. */
  uses?: string | null;
  /** Python option classes default to 104px for icon/sprite entries. */
  kind: 'text' | 'icon' | 'sprite';
}

export interface EventChoiceConfig {
  entries: EventChoiceEntry[];
  title: string | null;
  /** [columns, rows] visible grid; null = Python autosize (1 col, all rows). */
  size: [number, number] | null;
  rowWidth: number;
  /** Alignment name (center, top_left, ...) or an explicit [x, y]. */
  alignment: string | [number, number];
  orientation: 'vertical' | 'horizontal';
  bg: string | null;
  textAlign: 'left' | 'center' | 'right';
  noCursor: boolean;
  screenWidth: number;
  screenHeight: number;
  /**
   * PlayerChoiceState.help_boxes: per entry, the help pages INFO shows
   * (AUX cycles them). Empty or absent when the entry type has none.
   */
  helpBoxes?: HelpBox[][];
}

const MARGIN = 10;

export class EventChoiceMenu {
  options: MenuOption[];
  selectedIndex = 0;
  visible = true;
  private entries: EventChoiceEntry[];
  private cfg: EventChoiceConfig;
  private gridSize: [number, number];
  private itemSize: [number, number];
  private scroll: [number, number] = [0, 0];
  /** PlayerChoiceState.info_flag / hb_page. */
  infoFlag = false;
  helpPage = 0;

  constructor(cfg: EventChoiceConfig) {
    this.cfg = cfg;
    this.entries = cfg.entries;
    this.options = cfg.entries.map((entry) => ({ label: entry.text, value: entry.value, enabled: true }));
    if (cfg.size) {
      this.gridSize = [Math.max(1, cfg.size[0]), Math.max(1, cfg.size[1])];
    } else if (cfg.orientation === 'horizontal') {
      this.gridSize = [Math.max(1, this.entries.length), 1];
    } else {
      this.gridSize = [1, Math.max(1, this.entries.length)];
    }
    this.itemSize = this.determineItemSize();
    void loadMenuBgSprite('menu_highlight');
    void loadMenuBgSprite('menu_hand');
  }

  /** Width of one entry, matching TextOption (+24) / icon options (104). */
  private entryWidth(entry: EventChoiceEntry): number {
    if (entry.kind === 'text') return measureStyledText(entry.text, 'text') + 24;
    return 104;
  }

  private determineItemSize(): [number, number] {
    let maxWidth = 0;
    for (const entry of this.entries) maxWidth = Math.max(maxWidth, this.entryWidth(entry));
    if (!this.entries.length) return [80, 16];
    if (this.cfg.title) {
      const perCol = Math.floor(measureStyledText(this.cfg.title, 'text') / this.gridSize[0]);
      maxWidth = Math.max(perCol, maxWidth);
    }
    return [this.cfg.rowWidth || maxWidth, 16];
  }

  /** Total grid in (cols, rows) over all data, Python _total_grid_size. */
  private totalGrid(): [number, number] {
    const n = Math.max(1, this.entries.length);
    if (this.cfg.orientation === 'vertical') {
      const cols = this.gridSize[0];
      return [cols, Math.floor((n - 1) / cols) + 1];
    }
    const rows = this.gridSize[1];
    return [Math.floor((n - 1) / rows) + 1, rows];
  }

  private coordOf(idx: number): [number, number] {
    const [cols] = this.totalGrid();
    return [idx % cols, Math.floor(idx / cols)];
  }

  pixelSize(): [number, number] {
    const titleWidth = this.cfg.title ? measureStyledText(this.cfg.title, 'text') : 0;
    const titleHeight = this.cfg.title ? 16 : 0;
    const [iw, ih] = this.itemSize;
    const w = Math.max(this.gridSize[0] * iw, titleWidth) + 16;
    const h = this.gridSize[1] * ih + titleHeight + 8;
    return [w, h];
  }

  screenPosition(): [number, number] {
    const [w, h] = this.pixelSize();
    if (Array.isArray(this.cfg.alignment)) return this.cfg.alignment;
    const a = this.cfg.alignment.toLowerCase();
    const sw = this.cfg.screenWidth;
    const sh = this.cfg.screenHeight;
    const x = a.endsWith('left') ? MARGIN
      : a.endsWith('right') ? sw - w - MARGIN
        : Math.floor(sw / 2) - Math.floor(w / 2);
    const y = a.startsWith('top') ? MARGIN
      : a.startsWith('bottom') ? sh - h - MARGIN
        : Math.floor(sh / 2) - Math.floor(h / 2);
    return [x, y];
  }

  private moveCursor(idx: number): void {
    if (!this.entries.length) return;
    this.selectedIndex = Math.max(0, Math.min(idx, this.entries.length - 1));
    const [cx, cy] = this.coordOf(this.selectedIndex);
    const [cols, rows] = this.gridSize;
    let [sx, sy] = this.scroll;
    if (cx < sx) sx = cx;
    else if (cx >= sx + cols) sx = cx - cols + 1;
    if (cy < sy) sy = cy;
    else if (cy >= sy + rows) sy = cy - rows + 1;
    this.scroll = [sx, sy];
  }

  setCursor(idx: number): void {
    this.moveCursor(idx);
  }

  getCurrentOption(): MenuOption {
    return this.options[this.selectedIndex];
  }

  /** Python GridChoiceMenu.move_* with first_push wrapping. */
  private move(direction: 'UP' | 'DOWN' | 'LEFT' | 'RIGHT'): boolean {
    const n = this.entries.length;
    if (!n) return false;
    const [cols, rows] = this.totalGrid();
    let next = this.selectedIndex;
    if (direction === 'RIGHT') next = (this.selectedIndex + 1) % n;
    else if (direction === 'LEFT') next = (this.selectedIndex - 1 + n) % n;
    else if (direction === 'UP') {
      next = this.selectedIndex - cols;
      if (next < 0) next += cols * rows;
      while (next >= n) next -= cols;
    } else {
      next = this.selectedIndex + cols;
      if (next >= n) next %= cols;
    }
    if (next === this.selectedIndex) return false;
    this.moveCursor(next);
    return true;
  }

  /** Whether any entry has help pages (Python `if self.help_boxes`). */
  hasHelpBoxes(): boolean {
    return (this.cfg.helpBoxes ?? []).some((pages) => pages.length > 0);
  }

  /** PlayerChoiceState INFO on an item/skill choice: toggle the help box. */
  toggleInfo(): boolean {
    if (this.infoFlag) {
      _audio?.playSfx('Info Out');
      this.infoFlag = false;
      return true;
    }
    if (!this.hasHelpBoxes()) return false;
    _audio?.playSfx('Info In');
    this.infoFlag = true;
    return true;
  }

  /** EOtF fork: AUX while the help box is up shows the entry's next page. */
  nextHelpPage(): boolean {
    if (!this.infoFlag || !this.hasHelpBoxes()) return false;
    this.helpPage += 1;
    return true;
  }

  handleInput(event: InputEvent): { selected: string } | { back: true } | null {
    if (!this.visible || event === null) return null;
    const horizontalOk = this.cfg.orientation === 'horizontal' || this.gridSize[0] > 1;
    const verticalOk = this.cfg.orientation === 'vertical' || this.gridSize[1] > 1;
    if ((event === 'RIGHT' || event === 'LEFT') && horizontalOk) {
      this.helpPage = 0;
      if (this.move(event)) _audio?.playSfx('Select 6');
      return null;
    }
    if ((event === 'UP' || event === 'DOWN') && verticalOk) {
      this.helpPage = 0;
      if (this.move(event)) _audio?.playSfx('Select 6');
      return null;
    }
    if (event === 'SELECT') {
      const option = this.options[this.selectedIndex];
      if (!option) return null;
      _audio?.playSfx('Select 1');
      return { selected: option.value };
    }
    if (event === 'BACK') return { back: true };
    return null;
  }

  /** Index of the visible option under a game-pixel point, or -1. */
  private indexAt(gx: number, gy: number): number {
    const [left, top] = this.screenPosition();
    const optionsTop = top + 3 + (this.cfg.title ? 16 : 0);
    const [iw, ih] = this.itemSize;
    const col = Math.floor((gx - left) / iw);
    const row = Math.floor((gy - optionsTop) / ih);
    if (col < 0 || row < 0 || col >= this.gridSize[0] || row >= this.gridSize[1]) return -1;
    const [cols] = this.totalGrid();
    const idx = (row + this.scroll[1]) * cols + col + this.scroll[0];
    return idx >= 0 && idx < this.entries.length ? idx : -1;
  }

  handleMouseHover(gx: number, gy: number): void {
    const idx = this.indexAt(gx, gy);
    if (idx >= 0 && idx !== this.selectedIndex) {
      this.moveCursor(idx);
      _audio?.playSfx('Select 6');
    }
  }

  handleClick(gx: number, gy: number, button: 'SELECT' | 'BACK'): { selected: string } | { back: true } | null {
    if (button === 'BACK') return { back: true };
    const idx = this.indexAt(gx, gy);
    if (idx < 0) return null;
    this.moveCursor(idx);
    _audio?.playSfx('Select 1');
    return { selected: this.options[idx].value };
  }

  private drawEntry(surf: Surface, entry: EventChoiceEntry, x: number, y: number, width: number): void {
    if (entry.kind === 'text') {
      const textW = measureStyledText(entry.text, 'text');
      const tx = this.cfg.textAlign === 'center'
        ? x + Math.floor((width - textW) / 2)
        : this.cfg.textAlign === 'right' ? x + width - 5 - textW : x + 5;
      drawStyledText(surf, entry.text, tx, y, 'white', 'text');
      return;
    }
    if (entry.kind === 'sprite') {
      // Python parse_unit: the unit's 'passive' image, never the grey one.
      const sprite = entry.sprite as any;
      const previous = sprite?.state;
      if (sprite && previous === 'gray') sprite.state = 'standing';
      entry.sprite?.draw(surf, x + 4, y - 1, 0, 0);
      if (sprite) sprite.state = previous;
    } else if (entry.icon) {
      drawIcon16(surf, entry.icon.sheet, entry.icon.index, x + 2, y);
    }
    const reserve = entry.uses ? 36 : 20;
    const font = measureStyledText(entry.text, 'text') > width - reserve ? 'narrow' : 'text';
    drawStyledText(surf, entry.text, x + 20, y, 'white', font);
    if (entry.uses) {
      surf.drawTextRight(entry.uses, x + width - 5, y, 'blue', 'text');
    }
  }

  draw(surf: Surface): void {
    if (!this.visible) return;
    const [left, top] = this.screenPosition();
    const [w, h] = this.pixelSize();
    if (this.cfg.bg) surf.blit(getMenuBackgroundSync(w, h, this.cfg.bg), left, top);
    let optionsY = top + 3;
    if (this.cfg.title) {
      drawStyledText(surf, this.cfg.title, left + 5, top + 3, 'white', 'text');
      optionsY += 16;
    }
    const [iw, ih] = this.itemSize;
    const [cols, rows] = this.gridSize;
    const [totalCols] = this.totalGrid();
    const [sx, sy] = this.scroll;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const idx = (r + sy) * totalCols + (c + sx);
        if (idx >= this.entries.length || c + sx >= totalCols) continue;
        const ex = left + c * iw;
        const ey = optionsY + r * ih;
        if (idx === this.selectedIndex) {
          // Python BaseOption.draw_highlight: tile menu_highlight 5px in, 9px down.
          const highlight = getMenuHighlight();
          if (highlight) {
            for (let slot = 0; slot < Math.floor((iw - 10) / highlight.width); slot++) {
              surf.blitImage(highlight, 0, 0, highlight.width, highlight.height,
                ex + 5 + slot * highlight.width, ey + 9);
            }
          } else {
            surf.fillRect(ex + 5, ey + 9, iw - 10, 6, 'rgba(80, 80, 140, 0.7)');
          }
        }
        this.drawEntry(surf, this.entries[idx], ex, ey, iw);
      }
    }
    // Cursor hand (grid_choice._draw_cursor: px - 13, py + 3).
    if (!this.cfg.noCursor && this.entries.length) {
      const [cx, cy] = this.coordOf(this.selectedIndex);
      const px = left + (cx - sx) * iw - 13;
      const py = optionsY + (cy - sy) * ih + 3;
      const hand = getMenuHand();
      const bob = Math.floor((performance.now() / 120) % 4);
      if (hand) surf.blitImage(hand, 0, 0, hand.width, hand.height, px + (bob < 2 ? bob : 4 - bob), py);
    }
    // Scroll indicators when more rows exist than fit.
    const [, totalRows] = this.totalGrid();
    if (totalRows > rows) {
      const barX = left + w - 6;
      const barTop = optionsY;
      const barH = rows * ih;
      surf.fillRect(barX, barTop, 2, barH, 'rgba(40,40,72,0.8)');
      const thumbH = Math.max(4, Math.floor(barH * rows / totalRows));
      const thumbY = barTop + Math.floor((barH - thumbH) * sy / Math.max(1, totalRows - rows));
      surf.fillRect(barX, thumbY, 2, thumbH, 'rgba(232,232,248,1)');
    }
    this.drawHelpBox(surf);
  }

  /**
   * PlayerChoiceState.draw info box: below the hovered option (4px left of
   * it) on the left half of the screen, else right-aligned to the menu's
   * right edge.
   */
  private drawHelpBox(surf: Surface): void {
    if (!this.infoFlag || !this.entries.length) return;
    const pages = this.cfg.helpBoxes?.[this.selectedIndex] ?? [];
    if (!pages.length) return;
    if (this.helpPage >= pages.length) this.helpPage = 0;
    const box = pages[this.helpPage];
    const [left, top] = this.screenPosition();
    const [cx, cy] = this.coordOf(this.selectedIndex);
    const [iw, ih] = this.itemSize;
    const px = Math.max(0, Math.min(this.cfg.screenWidth, left + (cx - this.scroll[0]) * iw));
    const py = Math.max(0, Math.min(this.cfg.screenHeight,
      top + (this.cfg.title ? 16 : 0) + (cy - this.scroll[1]) * ih));
    if (px < Math.floor(this.cfg.screenWidth / 2)) box.draw(surf, px - 4, py + 16);
    else box.draw(surf, px + this.pixelSize()[0], py + 16, true);
  }
}

