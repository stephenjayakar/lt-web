import { Surface } from '../engine/surface';
import type { InputEvent } from '../engine/input';

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
        return null;
      case 'DOWN':
        this.moveDown();
        return null;
      case 'SELECT': {
        const opt = this.getCurrentOption();
        if (opt.enabled) {
          return { selected: opt.value };
        }
        return null;
      }
      case 'BACK':
        return { back: true };
      default:
        return null;
    }
  }

  /** Draw the menu */
  draw(surf: Surface): void {
    if (!this.visible) return;

    const totalHeight = this.options.length * ROW_HEIGHT + PADDING_Y * 2;

    // Dark semi-transparent background
    surf.fillRect(this.x, this.y, this.width, totalHeight, 'rgba(16, 16, 32, 0.85)');

    // 1px border
    surf.drawRect(this.x, this.y, this.width, totalHeight, 'rgba(180, 180, 220, 0.6)');

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
