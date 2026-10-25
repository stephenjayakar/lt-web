import { Surface } from '../engine/surface';
import type { InputEvent } from '../engine/input';
import { getMenuBackgroundSync, getMenuHand, getMenuHighlight } from './base-surf';
import { drawStyledText, measureStyledText } from './styled-text';
import { drawIcon16 } from './icons';

/** Optional audio manager reference set by game state for menu sounds. */
let _menuAudioManager: { playSfx(name: string): void } | null = null;
export function setMenuAudioManager(am: { playSfx(name: string): void } | null): void {
  _menuAudioManager = am;
}

/** Python menu_options.ItemOption row: icon, name, right-aligned uses. */
export interface MenuItemRow {
  iconNid: string | null;
  iconIndex: [number, number];
  uses: string;
  mainColor: string;
  usesColor: string;
}

export interface MenuOption {
  label: string;
  value: string;
  enabled: boolean;
  description?: string;
  itemRow?: MenuItemRow;
}

/** Python ItemOption.width(). */
const ITEM_OPTION_WIDTH = 104;

/** Padding inside the menu box (pixels). */
const PADDING_X = 6;
const PADDING_Y = 4;
const ROW_HEIGHT = 16;
/** Python menus.Cursor.anim (hand bob, one step per drawn frame). */
const CURSOR_ANIM = [0, 0, 0, 0, 0, 0, 0, 1, 1, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 4, 4, 4, 3, 3, 2, 2, 2, 1, 1, 1, 1];

/**
 * Choice menu - vertical list of selectable options.
 * Used for action menus (Attack, Item, Wait, etc.)
 */
export class ChoiceMenu {
  options: MenuOption[];
  selectedIndex: number;
  visible: boolean;
  x: number;
  y: number;
  width: number;
  private cursorCounter = 0;

  constructor(options: MenuOption[], x: number, y: number) {
    this.options = options;
    this.selectedIndex = 0;
    this.visible = true;
    this.x = x;
    this.y = y;

    // Auto-size to rendered content: markup is zero-width and inline icons
    // occupy one 16px cell, matching Python's TaggedTextChunk contract.
    let maxWidth = 0;
    for (const option of options) {
      maxWidth = Math.max(maxWidth, measureStyledText(option.label, 'text'));
    }
    // Nine-slice backgrounds render in 8px cells. Keep the menu, highlight,
    // and hitbox on the same rounded width instead of letting the background
    // floor independently and leave the selection rectangle hanging outside.
    // Python Simple.get_menu_width: widest BasicOption (text + 24) floored
    // to a multiple of 8.
    let optionWidth = maxWidth + 24;
    if (options.some((option) => option.itemRow)) optionWidth = Math.max(optionWidth, ITEM_OPTION_WIDTH);
    this.width = Math.max(16, optionWidth - (optionWidth % 8));

    // Ensure the first selected option is enabled (skip disabled ones)
    this._skipToNextEnabled(1);
  }

  /** Handle input, returns selected option value or null */
  handleInput(event: InputEvent): { selected: string } | { back: true } | null {
    if (!this.visible || event === null) return null;

    switch (event) {
      case 'UP':
        this.moveUp();
        _menuAudioManager?.playSfx?.('Select 6');
        return null;
      case 'DOWN':
        this.moveDown();
        _menuAudioManager?.playSfx?.('Select 6');
        return null;
      case 'SELECT': {
        const opt = this.getCurrentOption();
        if (opt.enabled) {
          _menuAudioManager?.playSfx?.('Select 1');
          return { selected: opt.value };
        }
        _menuAudioManager?.playSfx?.('Error');
        return null;
      }
      case 'BACK':
        _menuAudioManager?.playSfx?.('Select 4');
        return { back: true };
      default:
        return null;
    }
  }

  /** Draw the menu (Python Choice.vert_draw + BasicOption.draw/_highlight). */
  draw(surf: Surface): void {
    if (!this.visible) return;

    const totalHeight = this.options.length * ROW_HEIGHT + PADDING_Y * 2;

    // 9-slice menu background (falls back to dark surface if sprite not loaded yet)
    const bgSurf = getMenuBackgroundSync(this.width, totalHeight);
    surf.blit(bgSurf, this.x, this.y);

    const highlight = getMenuHighlight();
    for (let i = 0; i < this.options.length; i++) {
      const opt = this.options[i];
      const rowX = this.x;
      const rowY = this.y + PADDING_Y + i * ROW_HEIGHT;

      if (i === this.selectedIndex) {
        if (highlight) {
          // BasicOption.draw_highlight: menu_highlight tiled 5px in, 9px down.
          const slots = Math.floor((this.width - 10) / highlight.width);
          for (let slot = 0; slot < slots; slot++) {
            surf.blitImage(highlight, 0, 0, highlight.width, highlight.height,
              rowX + 5 + slot * highlight.width, rowY + 9);
          }
        } else {
          surf.fillRect(rowX + 1, rowY, this.width - 2, ROW_HEIGHT, 'rgba(80, 80, 140, 0.7)');
        }
      }

      const row = opt.itemRow;
      if (row) {
        // ItemOption.draw: icon (x+2), name (x+20, narrow past 60px), uses
        // right-aligned at x + width - 5.
        if (row.iconNid) drawIcon16(surf, row.iconNid, row.iconIndex, rowX + 2, rowY);
        const font = measureStyledText(opt.label, 'text') > 60 ? 'narrow' : 'text';
        surf.drawText(opt.label, rowX + 20, rowY, row.mainColor, font);
        surf.drawTextRight(row.uses, rowX + this.width - 5, rowY, row.usesColor, 'text');
        continue;
      }
      // BasicOption.draw: text at (x + 5, top); grey when ignored.
      const color = opt.enabled ? 'white' : 'grey';
      drawStyledText(surf, opt.label, rowX + 5, rowY, color, 'text');
    }

    // menus.Cursor.draw: menu_hand at (x - 12 + bob, top + 3).
    const hand = getMenuHand();
    if (hand && this.options.length > 0) {
      this.cursorCounter = (this.cursorCounter + 1) % CURSOR_ANIM.length;
      const top = this.y + PADDING_Y + this.selectedIndex * ROW_HEIGHT;
      surf.blitImage(hand, 0, 0, hand.width, hand.height,
        this.x - 12 + CURSOR_ANIM[this.cursorCounter], top + 3);
    }
  }

  /** Get currently highlighted option */
  getCurrentOption(): MenuOption {
    return this.options[this.selectedIndex];
  }

  /** Move selection up, skipping disabled options */
  moveUp(): void {
    if (this.options.length === 0) return;
    const start = this.selectedIndex;
    do {
      this.selectedIndex =
        (this.selectedIndex - 1 + this.options.length) % this.options.length;
    } while (!this.options[this.selectedIndex].enabled && this.selectedIndex !== start);
  }

  /** Move selection down, skipping disabled options */
  moveDown(): void {
    if (this.options.length === 0) return;
    const start = this.selectedIndex;
    do {
      this.selectedIndex = (this.selectedIndex + 1) % this.options.length;
    } while (!this.options[this.selectedIndex].enabled && this.selectedIndex !== start);
  }

  /**
   * Handle a mouse click at game-pixel coordinates.
   * Returns the selected option, back, or null.
   * @param gameX  Game-pixel X coordinate of the click.
   * @param gameY  Game-pixel Y coordinate of the click.
   * @param button 'SELECT' for LMB, 'BACK' for RMB.
   */
  handleClick(
    gameX: number,
    gameY: number,
    button: 'SELECT' | 'BACK',
  ): { selected: string } | { back: true } | null {
    if (!this.visible) return null;

    if (button === 'BACK') {
      _menuAudioManager?.playSfx?.('Select 4');
      return { back: true };
    }

    // Check if click is within the menu bounds
    const totalHeight = this.options.length * ROW_HEIGHT + PADDING_Y * 2;
    if (
      gameX < this.x || gameX > this.x + this.width ||
      gameY < this.y || gameY > this.y + totalHeight
    ) {
      return null;
    }

    // Determine which row was clicked
    const relY = gameY - this.y - PADDING_Y;
    const rowIdx = Math.floor(relY / ROW_HEIGHT);
    if (rowIdx < 0 || rowIdx >= this.options.length) return null;

    const opt = this.options[rowIdx];
    if (!opt.enabled) {
      _menuAudioManager?.playSfx?.('Error');
      return null;
    }

    this.selectedIndex = rowIdx;
    _menuAudioManager?.playSfx?.('Select 1');
    return { selected: opt.value };
  }

  /**
   * Update hover highlight based on mouse position (game-pixel coords).
   * Call each frame when mouse is over the menu area.
   */
  handleMouseHover(gameX: number, gameY: number): void {
    if (!this.visible) return;

    const totalHeight = this.options.length * ROW_HEIGHT + PADDING_Y * 2;
    if (
      gameX < this.x || gameX > this.x + this.width ||
      gameY < this.y || gameY > this.y + totalHeight
    ) {
      return;
    }

    const relY = gameY - this.y - PADDING_Y;
    const rowIdx = Math.floor(relY / ROW_HEIGHT);
    if (rowIdx >= 0 && rowIdx < this.options.length && this.options[rowIdx].enabled) {
      if (this.selectedIndex !== rowIdx) {
        _menuAudioManager?.playSfx?.('Select 6');
      }
      this.selectedIndex = rowIdx;
    }
  }

  /** Skip to the next enabled option in the given direction (1 or -1). */
  private _skipToNextEnabled(dir: 1 | -1): void {
    if (this.options.length === 0) return;
    if (this.options[this.selectedIndex].enabled) return;
    const start = this.selectedIndex;
    do {
      this.selectedIndex =
        (this.selectedIndex + dir + this.options.length) % this.options.length;
    } while (!this.options[this.selectedIndex].enabled && this.selectedIndex !== start);
  }
}
