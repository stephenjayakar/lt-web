import { Surface } from '../engine/surface';
import { viewport } from '../engine/viewport';

const FONT_MAIN = '10px monospace';
const FONT_SUB = '8px monospace';
const CHAR_WIDTH_MAIN = 6; // approximate for 10px monospace
const CHAR_WIDTH_SUB = 5;  // approximate for 8px monospace

const DEFAULT_DURATION = 1000; // ms total
const FADE_IN_MS = 150;
const FADE_OUT_MS = 150;

const STRIP_HEIGHT = 32;
const BG_COLOR_BASE = [0, 0, 0] as const; // black
const TEXT_COLOR = 'white';
const SUB_TEXT_COLOR = 'rgba(200, 200, 220, 1)';

/**
 * Banner - Temporary centered text banner (e.g. "Player Phase", "Enemy Phase")
 */
export class Banner {
  private text: string;
  private subText: string;
  private timer: number;
  private duration: number;
  private fadeIn: number;
  private fadeOut: number;

  constructor(text: string, subText?: string, duration?: number) {
    this.text = text;
    this.subText = subText ?? '';
    this.duration = duration ?? DEFAULT_DURATION;
    this.fadeIn = FADE_IN_MS;
    this.fadeOut = FADE_OUT_MS;
    this.timer = 0;
  }

  /** Update timer. Returns true when done. */
  update(deltaMs: number): boolean {
    this.timer += deltaMs;
    return this.timer >= this.duration;
  }

  /** Get the elapsed time in milliseconds. */
  getElapsed(): number {
    return this.timer;
  }

  /** Draw the banner */
  draw(surf: Surface): void {
    if (this.timer >= this.duration) return;

    // Compute alpha based on fade in/out
    let alpha: number;
    if (this.timer < this.fadeIn) {
      // Fading in
      alpha = this.timer / this.fadeIn;
    } else if (this.timer > this.duration - this.fadeOut) {
      // Fading out
      alpha = (this.duration - this.timer) / this.fadeOut;
    } else {
      // Fully visible
      alpha = 1;
    }
    alpha = Math.max(0, Math.min(1, alpha));

    // Banner position: centered horizontally, 1/3 from top
    const stripY = Math.floor(viewport.height / 3) - Math.floor(STRIP_HEIGHT / 2);
    const totalHeight = this.subText ? STRIP_HEIGHT + 12 : STRIP_HEIGHT;

    // Semi-transparent black background strip (full width)
    const bgAlpha = 0.75 * alpha;
    surf.fillRect(
      0,
      stripY,
      viewport.width,
      totalHeight,
      `rgba(${BG_COLOR_BASE[0]}, ${BG_COLOR_BASE[1]}, ${BG_COLOR_BASE[2]}, ${bgAlpha})`,
    );

    // Subtle border lines
    const borderAlpha = 0.4 * alpha;
    surf.fillRect(0, stripY, viewport.width, 1, `rgba(160, 160, 200, ${borderAlpha})`);
    surf.fillRect(0, stripY + totalHeight - 1, viewport.width, 1, `rgba(160, 160, 200, ${borderAlpha})`);

    // Main text — centered
    const mainTextWidth = this.text.length * CHAR_WIDTH_MAIN;
    const mainTextX = Math.floor((viewport.width - mainTextWidth) / 2);
    const mainTextY = stripY + Math.floor((STRIP_HEIGHT - 10) / 2);
    const textAlpha = alpha;
    surf.drawText(
      this.text,
      mainTextX,
      mainTextY,
      `rgba(255, 255, 255, ${textAlpha})`,
      FONT_MAIN,
    );

    // Sub-text — centered below main text
    if (this.subText) {
      const subTextWidth = this.subText.length * CHAR_WIDTH_SUB;
      const subTextX = Math.floor((viewport.width - subTextWidth) / 2);
      const subTextY = stripY + STRIP_HEIGHT + 1;
      surf.drawText(
        this.subText,
        subTextX,
        subTextY,
        `rgba(200, 200, 220, ${textAlpha})`,
        FONT_SUB,
      );
    }
  }
}
