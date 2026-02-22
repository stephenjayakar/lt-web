/**
 * credit-state.ts — Scrolling credits screen.
 *
 * Displays a vertically scrolling list of credit lines over a
 * panorama background (or dark fallback). The user can speed up
 * scrolling with DOWN and exit at any time with BACK/SELECT/START.
 *
 * Port of LT's credit state concept. No Python reference file exists;
 * this is built from the spec and matches the engine's state patterns.
 */

import { State, type StateResult } from '../state';
import type { Surface } from '../surface';
import { Surface as SurfaceClass } from '../surface';
import type { InputEvent } from '../input';
import { viewport } from '../viewport';
import { WINWIDTH, WINHEIGHT } from '../constants';
import { getMenuBackgroundSync } from '../../ui/base-surf';

// ---------------------------------------------------------------------------
// Lazy game reference (same pattern as other state files)
// ---------------------------------------------------------------------------

let _game: any = null;
export function setCreditGameRef(g: any): void {
  _game = g;
}
function getGame(): any {
  if (!_game) throw new Error('Game reference not set for credit state');
  return _game;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CreditLine {
  text: string;
  color: string;     // CSS color
  font: string;      // CSS font string
  isHeader: boolean;  // headers are larger/yellow
  y: number;          // pre-computed y offset from the top of the credit block
}

// ---------------------------------------------------------------------------
// Layout & styling constants
// ---------------------------------------------------------------------------

const HEADER_FONT = '12px monospace';
const SUBHEADER_FONT = '9px monospace';
const CREDIT_FONT = '8px monospace';
const SMALL_FONT = '7px monospace';

const GOLD = 'rgba(255,215,0,1)';
const YELLOW = 'rgba(255,255,128,1)';
const WHITE = 'rgba(240,240,255,1)';
const DIM_WHITE = 'rgba(180,180,210,1)';
const LIGHT_BLUE = 'rgba(150,190,255,1)';

const HEADER_LINE_HEIGHT = 24;
const SUBHEADER_LINE_HEIGHT = 18;
const CREDIT_LINE_HEIGHT = 16;
const BLANK_LINE_HEIGHT = 12;
const SECTION_GAP = 20;

const NORMAL_SCROLL_SPEED = 0.5;
const FAST_SCROLL_SPEED = 2.5;
const EXIT_DELAY_FRAMES = 90; // ~1.5 seconds after scrolling finishes

// ---------------------------------------------------------------------------
// Credit content definition
// ---------------------------------------------------------------------------

interface CreditEntry {
  text: string;
  type: 'title' | 'header' | 'subheader' | 'credit' | 'blank' | 'final';
}

function getDefaultCredits(): CreditEntry[] {
  return [
    { text: '', type: 'blank' },
    { text: '', type: 'blank' },
    { text: 'LEX TALIONIS', type: 'title' },
    { text: 'Web Engine', type: 'subheader' },
    { text: '', type: 'blank' },
    { text: '', type: 'blank' },
    { text: '- Original Engine -', type: 'header' },
    { text: 'rainlash', type: 'credit' },
    { text: '', type: 'blank' },
    { text: '', type: 'blank' },
    { text: '- Web Port -', type: 'header' },
    { text: 'Powered by TypeScript + Canvas 2D', type: 'credit' },
    { text: '', type: 'blank' },
    { text: '', type: 'blank' },
    { text: '- Based on Fire Emblem -', type: 'header' },
    { text: 'by Intelligent Systems / Nintendo', type: 'credit' },
    { text: '', type: 'blank' },
    { text: '', type: 'blank' },
    { text: '', type: 'blank' },
    { text: '', type: 'blank' },
    { text: 'Thank you for playing!', type: 'final' },
    { text: '', type: 'blank' },
    { text: '', type: 'blank' },
    { text: '', type: 'blank' },
  ];
}

// ---------------------------------------------------------------------------
// CreditState
// ---------------------------------------------------------------------------

export class CreditState extends State {
  override readonly name = 'credit';
  override readonly showMap = false;
  override readonly inLevel = false;

  private bgImage: HTMLImageElement | null = null;
  private bgSurf: SurfaceClass | null = null;
  private scrollY: number = 0;
  private scrollSpeed: number = NORMAL_SCROLL_SPEED;
  private creditLines: CreditLine[] = [];
  private totalHeight: number = 0;
  private finished: boolean = false;
  private exitTimer: number = 0;
  private speedingUp: boolean = false;

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  override start(): StateResult {
    const game = getGame();

    // Try to load a background panorama
    this.bgImage = null;
    this.bgSurf = null;

    const bgKey = game.memory?.get?.('credit_bg') ?? game.memory?.get?.('title_bg') ?? null;
    if (bgKey && game.resourceManager) {
      // Attempt to load background image asynchronously
      this.loadBackground(bgKey);
    }

    // Build credit lines
    this.creditLines = this.buildCreditLines();

    // Compute total content height
    if (this.creditLines.length > 0) {
      const lastLine = this.creditLines[this.creditLines.length - 1];
      this.totalHeight = lastLine.y + CREDIT_LINE_HEIGHT;
    } else {
      this.totalHeight = 0;
    }

    // Start scrolling from below the visible area
    this.scrollY = viewport.height;
    this.scrollSpeed = NORMAL_SCROLL_SPEED;
    this.finished = false;
    this.exitTimer = 0;
    this.speedingUp = false;

    // Hide cursor if available
    if (game.cursor) {
      game.cursor.visible = false;
    }

    // Lower music or play credits music
    if (game.audio) {
      try {
        game.audio.setMusicVolume?.(0.6);
      } catch {
        // ignore
      }
    }
  }

  override takeInput(event: InputEvent): StateResult {
    if (event === null) {
      // No input — restore normal scroll speed if we were speeding up
      this.speedingUp = false;
      this.scrollSpeed = NORMAL_SCROLL_SPEED;
      return;
    }

    // Immediate exit
    if (event === 'BACK' || event === 'SELECT' || event === 'START') {
      this.exitCredits();
      return 'repeat';
    }

    // Speed up scrolling
    if (event === 'DOWN') {
      this.speedingUp = true;
      this.scrollSpeed = FAST_SCROLL_SPEED;
    }
  }

  override update(): StateResult {
    // Advance scroll position
    this.scrollY -= this.scrollSpeed;

    // Check if we've scrolled past all content
    // Content is fully off the top when scrollY < -totalHeight
    if (this.scrollY < -this.totalHeight) {
      if (!this.finished) {
        this.finished = true;
        this.exitTimer = 0;
      }
    }

    // Auto-exit after a pause once finished
    if (this.finished) {
      this.exitTimer++;
      if (this.exitTimer >= EXIT_DELAY_FRAMES) {
        this.exitCredits();
        return 'repeat';
      }
    }

    // If DOWN is held, keep speed up (handled via the speedingUp flag)
    // The input system sends the event once; we maintain state via the flag.
    // However, since we can't reliably detect key release through InputEvent,
    // we gradually restore speed each frame the flag isn't refreshed.
    // The takeInput sets speedingUp=true on DOWN; we reset it after each update
    // cycle if no new DOWN arrives. This is approximated by decaying speed.
    if (this.speedingUp) {
      this.scrollSpeed = FAST_SCROLL_SPEED;
    } else {
      // Gradually return to normal speed
      if (this.scrollSpeed > NORMAL_SCROLL_SPEED) {
        this.scrollSpeed = Math.max(
          NORMAL_SCROLL_SPEED,
          this.scrollSpeed - 0.1,
        );
      }
    }
    // Reset flag — it will be set again next frame if DOWN is still pressed
    this.speedingUp = false;
  }

  override draw(surf: Surface): Surface {
    const vw = viewport.width;
    const vh = viewport.height;

    // 1. Background
    this.drawBackground(surf, vw, vh);

    // 2. Subtle vignette overlay for depth
    surf.fillRect(0, 0, vw, 24, 'rgba(0,0,0,0.3)');
    surf.fillRect(0, vh - 24, vw, 24, 'rgba(0,0,0,0.3)');

    // 3. Credit lines
    for (const line of this.creditLines) {
      const screenY = line.y - this.scrollY;

      // Cull lines off-screen (generous margin for large fonts)
      if (screenY < -30 || screenY > vh + 10) continue;

      // Skip blank lines (nothing to draw)
      if (line.text === '') continue;

      // Center text horizontally
      // Approximate character width based on font size
      const charWidth = line.isHeader ? 7 : (line.font === SUBHEADER_FONT ? 5.5 : 5);
      const textWidth = line.text.length * charWidth;
      const textX = Math.floor((vw - textWidth) / 2);

      // Fade near edges for a polished look
      let alpha = 1.0;
      if (screenY < 20) {
        alpha = Math.max(0, screenY / 20);
      } else if (screenY > vh - 30) {
        alpha = Math.max(0, (vh - screenY) / 30);
      }

      // Draw shadow for headers
      if (line.isHeader && alpha > 0.1) {
        const shadowColor = `rgba(0,0,0,${0.5 * alpha})`;
        surf.drawText(line.text, textX + 1, Math.floor(screenY) + 1, shadowColor, line.font);
      }

      // Apply alpha to the line color
      const color = this.applyAlpha(line.color, alpha);
      surf.drawText(line.text, textX, Math.floor(screenY), color, line.font);
    }

    return surf;
  }

  override finish(): void {
    // Restore music volume
    const game = getGame();
    if (game.audio) {
      try {
        game.audio.setMusicVolume?.(1.0);
      } catch {
        // ignore
      }
    }
  }

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  private exitCredits(): void {
    const game = getGame();
    game.state.back();
  }

  private loadBackground(key: string): void {
    const game = getGame();
    // Asynchronously load the panorama; it may arrive after a few frames
    if (game.resourceManager?.loadImage) {
      game.resourceManager.loadImage(key).then((img: HTMLImageElement | null) => {
        if (img) {
          this.bgImage = img;
        }
      }).catch(() => {
        // Failed to load — dark background will be used
      });
    }
  }

  private drawBackground(surf: Surface, vw: number, vh: number): void {
    if (this.bgImage) {
      // Scale panorama to fill the viewport
      try {
        surf.blitImage(
          this.bgImage,
          0, 0, this.bgImage.width, this.bgImage.height,
          0, 0,
        );
        // Darken the background so text is readable
        surf.fillRect(0, 0, vw, vh, 'rgba(0,0,0,0.55)');
      } catch {
        // Fallback on error
        surf.fill(8, 8, 20);
      }
    } else {
      // Dark gradient-like background
      surf.fill(8, 8, 20);
      // Subtle horizontal bands for visual interest
      for (let y = 0; y < vh; y += 32) {
        const bandAlpha = 0.03 + 0.02 * Math.sin(y * 0.05);
        surf.fillRect(0, y, vw, 16, `rgba(40,40,80,${bandAlpha})`);
      }
    }
  }

  private buildCreditLines(): CreditLine[] {
    const entries = getDefaultCredits();
    const lines: CreditLine[] = [];
    let currentY = 0;

    for (const entry of entries) {
      let font: string;
      let color: string;
      let isHeader: boolean;
      let lineHeight: number;

      switch (entry.type) {
        case 'title':
          font = HEADER_FONT;
          color = GOLD;
          isHeader = true;
          lineHeight = HEADER_LINE_HEIGHT;
          break;
        case 'header':
          font = SUBHEADER_FONT;
          color = YELLOW;
          isHeader = true;
          lineHeight = SUBHEADER_LINE_HEIGHT;
          break;
        case 'subheader':
          font = SUBHEADER_FONT;
          color = LIGHT_BLUE;
          isHeader = false;
          lineHeight = SUBHEADER_LINE_HEIGHT;
          break;
        case 'credit':
          font = CREDIT_FONT;
          color = WHITE;
          isHeader = false;
          lineHeight = CREDIT_LINE_HEIGHT;
          break;
        case 'final':
          font = SUBHEADER_FONT;
          color = GOLD;
          isHeader = true;
          lineHeight = SUBHEADER_LINE_HEIGHT;
          break;
        case 'blank':
        default:
          font = CREDIT_FONT;
          color = WHITE;
          isHeader = false;
          lineHeight = BLANK_LINE_HEIGHT;
          break;
      }

      lines.push({
        text: entry.text,
        color,
        font,
        isHeader,
        y: currentY,
      });

      currentY += lineHeight;
    }

    return lines;
  }

  /**
   * Apply an alpha multiplier to a CSS rgba() color string.
   * If the color doesn't match rgba format, wraps it in rgba.
   */
  private applyAlpha(color: string, alpha: number): string {
    if (alpha >= 0.99) return color;

    // Match rgba(r,g,b,a) pattern
    const rgbaMatch = color.match(
      /^rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*([\d.]+)\s*\)$/,
    );
    if (rgbaMatch) {
      const r = rgbaMatch[1];
      const g = rgbaMatch[2];
      const b = rgbaMatch[3];
      const a = parseFloat(rgbaMatch[4]) * alpha;
      return `rgba(${r},${g},${b},${a.toFixed(2)})`;
    }

    // Fallback: return as-is if format is unexpected
    return color;
  }
}
