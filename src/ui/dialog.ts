import { Surface } from '../engine/surface';
import { viewport } from '../engine/viewport';
import type { InputEvent } from '../engine/input';
import type { EventPortrait } from '../events/event-portrait';
import { FONT as BMP_FONTS, areFontsReady } from '../rendering/bmp-font';

export type DialogState = 'typing' | 'waiting' | 'done';

const FONT = '8px monospace';
const SPEAKER_FONT = '8px monospace';
const BOX_HEIGHT = 40;
const BOX_MARGIN = 2;
const INNER_PAD = 4;
const LINE_HEIGHT = 10;
/** Characters advanced per update() call (~2 chars per frame). */
const DEFAULT_TYPE_SPEED = 2;

/** Minimum box height (2 lines of text + padding). */
const MIN_BOX_HEIGHT = 40;

const BG_COLOR = 'rgba(12, 12, 28, 0.92)';
const BORDER_COLOR = 'rgba(160, 160, 200, 0.5)';
const SPEAKER_COLOR = 'rgba(255, 220, 80, 1)';
const TEXT_COLOR = 'white';

/**
 * Shared offscreen canvas for measuring text width.
 * Created lazily on first use.
 */
let _measureCtx: OffscreenCanvasRenderingContext2D | null = null;
function getMeasureCtx(): OffscreenCanvasRenderingContext2D {
  if (!_measureCtx) {
    const c = new OffscreenCanvas(1, 1);
    _measureCtx = c.getContext('2d')!;
  }
  return _measureCtx;
}

/** Measure text pixel width using BMP fonts when available, else Canvas. */
function measureTextWidth(text: string, font: string): number {
  // Try BMP font width measurement first
  if (areFontsReady()) {
    const bmpFont = BMP_FONTS['text'];
    if (bmpFont) return bmpFont.width(text);
  }
  const ctx = getMeasureCtx();
  ctx.font = font;
  return ctx.measureText(text).width;
}

/**
 * Word-wrap a string to fit within `maxWidth` pixels using `font`.
 * Returns an array of lines. Preserves existing newlines.
 */
function wordWrap(text: string, maxWidth: number, font: string): string[] {
  const result: string[] = [];
  // First split on explicit newlines
  const paragraphs = text.split('\n');
  for (const para of paragraphs) {
    if (para === '') {
      result.push('');
      continue;
    }
    const words = para.split(' ');
    let currentLine = '';
    for (const word of words) {
      if (currentLine === '') {
        // First word on the line — always place it (even if too wide)
        currentLine = word;
      } else {
        const testLine = currentLine + ' ' + word;
        if (measureTextWidth(testLine, font) <= maxWidth) {
          currentLine = testLine;
        } else {
          result.push(currentLine);
          currentLine = word;
        }
      }
    }
    result.push(currentLine);
  }
  return result;
}

/** Speech bubble tail height. */
const TAIL_HEIGHT = 6;

/**
 * Dialog - Text box for character speech/narration.
 * Supports typewriter effect, wait for input, and line breaks.
 * Inline commands: {w} = wait for input, {br} = line break, | = wait + break
 */
export class Dialog {
  private text: string;
  private displayedText: string;
  private charIndex: number;
  private speaker: string;
  private state: DialogState;
  private typeSpeed: number;
  private frameCounter: number;
  private waitingForInput: boolean;
  private lines: string[];
  private currentLine: number;

  /** Optional portrait for speech bubble positioning. */
  private portrait: EventPortrait | null;

  constructor(text: string, speaker?: string, portrait?: EventPortrait, typeSpeed?: number) {
    this.text = text;
    this.displayedText = '';
    this.charIndex = 0;
    this.speaker = speaker ?? '';
    this.state = 'typing';
    this.typeSpeed = typeSpeed ?? DEFAULT_TYPE_SPEED;
    this.frameCounter = 0;
    this.waitingForInput = false;
    this.currentLine = 0;
    this.portrait = portrait ?? null;

    // Pre-process the text into logical segments split by | (wait+break)
    // We keep {w} and {br} inline for the typewriter to encounter.
    this.lines = this.text.split('|');
  }

  /** Process input. Returns true when dialog is complete. */
  handleInput(event: InputEvent): boolean {
    if (event === null) return false;

    if (event === 'SELECT') {
      if (this.state === 'typing') {
        // Skip to end of current line
        this._finishCurrentLine();
        return false;
      }
      if (this.state === 'waiting') {
        // Advance to next line or finish
        if (this.currentLine < this.lines.length - 1) {
          this.currentLine++;
          this.charIndex = 0;
          this.displayedText = '';
          this.state = 'typing';
          this.waitingForInput = false;
        } else {
          this.state = 'done';
          return true;
        }
        return false;
      }
      if (this.state === 'done') {
        return true;
      }
    }

    if (event === 'BACK') {
      // Skip entire dialog
      this._skipAll();
      return true;
    }

    return false;
  }

  /** Update typewriter effect. Called once per frame. */
  update(): void {
    if (this.state !== 'typing') return;

    const currentLineText = this.lines[this.currentLine] ?? '';

    for (let i = 0; i < this.typeSpeed; i++) {
      if (this.charIndex >= currentLineText.length) {
        // End of current line segment
        if (this.currentLine < this.lines.length - 1) {
          // There's another segment after this | separator — wait for input
          this.state = 'waiting';
          this.waitingForInput = true;
        } else {
          this.state = 'waiting';
          this.waitingForInput = true;
        }
        return;
      }

      // Check for inline commands
      const remaining = currentLineText.slice(this.charIndex);

      if (remaining.startsWith('{w}')) {
        // Wait for input
        this.charIndex += 3;
        this.state = 'waiting';
        this.waitingForInput = true;
        return;
      }

      if (remaining.startsWith('{br}')) {
        // Line break
        this.charIndex += 4;
        this.displayedText += '\n';
        continue;
      }

      // Normal character
      this.displayedText += currentLineText[this.charIndex];
      this.charIndex++;
    }
  }

  /** Draw the dialog box */
  draw(surf: Surface): void {
    if (this.state === 'done') return;

    // Compute box position — either relative to portrait or at bottom
    let boxX: number;
    let boxW: number;
    let tailX: number | null = null; // Speech bubble tail X position

    if (this.portrait) {
      // Position dialog as speech bubble relative to portrait
      const portraitCenter = this.portrait.getDesiredCenter();
      boxW = Math.min(viewport.width - 8, 120); // Slightly narrower for speech bubble
      boxX = Math.max(2, Math.min(portraitCenter - boxW / 2, viewport.width - boxW - 2));
      tailX = Math.max(boxX + 6, Math.min(portraitCenter, boxX + boxW - 6));
    } else {
      // Default: full-width bar at bottom of screen
      boxX = BOX_MARGIN;
      boxW = viewport.width - BOX_MARGIN * 2;
    }

    // Word-wrap displayed text to fit within box
    const availableTextW = boxW - INNER_PAD * 2;
    const wrappedLines = wordWrap(this.displayedText, availableTextW, FONT);

    // Count how many lines we need (speaker + text lines)
    const speakerLines = this.speaker ? 1 : 0;
    const totalLines = speakerLines + wrappedLines.length;
    const boxH = Math.max(MIN_BOX_HEIGHT, totalLines * LINE_HEIGHT + INNER_PAD * 2);

    // Compute Y position (depends on box height)
    let boxY: number;
    if (this.portrait) {
      // Place above the portrait
      boxY = Math.max(2, this.portrait.position[1] - boxH - TAIL_HEIGHT - 2);
      // If that puts it off-screen, place below
      if (boxY < 2) {
        boxY = this.portrait.position[1] + 80 + TAIL_HEIGHT + 2;
      }
    } else {
      boxY = viewport.height - boxH - BOX_MARGIN;
    }

    // Background
    surf.fillRect(boxX, boxY, boxW, boxH, BG_COLOR);

    // Pixel-art border
    surf.drawRect(boxX, boxY, boxW, boxH, BORDER_COLOR);
    surf.drawRect(boxX + 1, boxY + 1, boxW - 2, boxH - 2, 'rgba(80, 80, 120, 0.3)');

    // Speech bubble tail pointing toward portrait
    if (tailX !== null && this.portrait) {
      const tailBaseY = boxY + boxH;
      // Small triangle tail
      for (let i = 0; i < TAIL_HEIGHT; i++) {
        const tw = TAIL_HEIGHT - i;
        surf.fillRect(tailX - tw, tailBaseY + i, tw * 2, 1, BG_COLOR);
      }
    }

    let textY = boxY + INNER_PAD;
    const textX = boxX + INNER_PAD;

    // Speaker name (yellow)
    if (this.speaker) {
      surf.drawText(this.speaker, textX, textY, SPEAKER_COLOR, SPEAKER_FONT);
      textY += LINE_HEIGHT;
    }

    // Render word-wrapped text lines
    for (const line of wrappedLines) {
      surf.drawText(line, textX, textY, TEXT_COLOR, FONT);
      textY += LINE_HEIGHT;
    }

    // Waiting indicator — a small blinking triangle
    if (this.state === 'waiting') {
      this.frameCounter++;
      if (Math.floor(this.frameCounter / 20) % 2 === 0) {
        const indicatorX = boxX + boxW - 10;
        const indicatorY = boxY + boxH - 10;
        surf.fillRect(indicatorX, indicatorY, 4, 4, TEXT_COLOR);
      }
    }
  }

  /** Check if done */
  isDone(): boolean {
    return this.state === 'done';
  }

  /** Finish typing the current line instantly. */
  private _finishCurrentLine(): void {
    const currentLineText = this.lines[this.currentLine] ?? '';
    // Strip inline commands for display
    let text = currentLineText.slice(this.charIndex);
    text = text.replace(/\{w\}/g, '').replace(/\{br\}/g, '\n');
    this.displayedText += text;
    this.charIndex = currentLineText.length;

    if (this.currentLine < this.lines.length - 1) {
      this.state = 'waiting';
      this.waitingForInput = true;
    } else {
      this.state = 'waiting';
      this.waitingForInput = true;
    }
  }

  /** Skip the entire dialog immediately. */
  private _skipAll(): void {
    this.state = 'done';
    this.currentLine = this.lines.length - 1;
    this.charIndex = (this.lines[this.currentLine] ?? '').length;
  }
}
