import { Surface } from '../engine/surface';
import type { InputEvent } from '../engine/input';
import { getMenuBackgroundSync } from './base-surf';

/** Optional audio manager reference set by game state for menu sounds. */
let _menuAudioManager: { playSfx(name: string): void } | null = null;
export function setMenuAudioManager(am: { playSfx(name: string): void } | null): void {
  _menuAudioManager = am;
}

export interface MenuOption {
  label: string;
  value: string;
  enabled: boolean;
  description?: string;
}

/** Padding inside the menu box (pixels). */
const PADDING_X = 6;
const PADDING_Y = 4;
const ROW_HEIGHT = 16;
const FONT = '8px monospace';
/** Approximate width of a single character in the 8px monospace font. */
const CHAR_WIDTH = 5;

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

  constructor(options: MenuOption[], x: number, y: number) {
    this.options = options;
    this.selectedIndex = 0;
    this.visible = true;
    this.x = x;
    this.y = y;

    // Auto-size width to longest label + padding
    let maxLen = 0;
    for (const opt of options) {
      if (opt.label.length > maxLen) {
        maxLen = opt.label.length;
      }
    }
    this.width = maxLen * CHAR_WIDTH + PADDING_X * 2;

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

  /** Draw the menu */
  draw(surf: Surface): void {
    if (!this.visible) return;

    const totalHeight = this.options.length * ROW_HEIGHT + PADDING_Y * 2;

    // 9-slice menu background (falls back to dark surface if sprite not loaded yet)
    const bgSurf = getMenuBackgroundSync(this.width, totalHeight);
    surf.blit(bgSurf, this.x, this.y);

    for (let i = 0; i < this.options.length; i++) {
      const opt = this.options[i];
      const rowX = this.x;
      const rowY = this.y + PADDING_Y + i * ROW_HEIGHT;

      // Highlight selected row
      if (i === this.selectedIndex) {
        surf.fillRect(
          rowX + 1,
          rowY,
          this.width - 2,
          ROW_HEIGHT,
          'rgba(80, 80, 140, 0.7)',
        );
      }

      // Text color: white for enabled, gray for disabled
      const color = opt.enabled ? 'white' : 'rgba(128, 128, 128, 1)';
      surf.drawText(opt.label, rowX + PADDING_X, rowY + 4, color, FONT);
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
    if (!opt.enabled) return null;

    this.selectedIndex = rowIdx;
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
