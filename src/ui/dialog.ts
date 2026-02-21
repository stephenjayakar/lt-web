import { Surface } from '../engine/surface';
import { WINWIDTH, WINHEIGHT } from '../engine/constants';
import type { InputEvent } from '../engine/input';

export type DialogState = 'typing' | 'waiting' | 'done';

const FONT = '8px monospace';
const SPEAKER_FONT = '8px monospace';
const BOX_HEIGHT = 40;
const BOX_MARGIN = 2;
const INNER_PAD = 4;
const LINE_HEIGHT = 10;
/** Characters advanced per update() call (~2 chars per frame). */
const DEFAULT_TYPE_SPEED = 2;

const BG_COLOR = 'rgba(12, 12, 28, 0.92)';
const BORDER_COLOR = 'rgba(160, 160, 200, 0.5)';
const SPEAKER_COLOR = 'rgba(255, 220, 80, 1)';
const TEXT_COLOR = 'white';

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

  constructor(text: string, speaker?: string, typeSpeed?: number) {
    this.text = text;
    this.displayedText = '';
    this.charIndex = 0;
    this.speaker = speaker ?? '';
    this.state = 'typing';
    this.typeSpeed = typeSpeed ?? DEFAULT_TYPE_SPEED;
    this.frameCounter = 0;
    this.waitingForInput = false;
    this.currentLine = 0;

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

    const boxX = BOX_MARGIN;
    const boxY = WINHEIGHT - BOX_HEIGHT - BOX_MARGIN;
    const boxW = WINWIDTH - BOX_MARGIN * 2;

    // Background
    surf.fillRect(boxX, boxY, boxW, BOX_HEIGHT, BG_COLOR);

    // Pixel-art border
    surf.drawRect(boxX, boxY, boxW, BOX_HEIGHT, BORDER_COLOR);
    surf.drawRect(boxX + 1, boxY + 1, boxW - 2, BOX_HEIGHT - 2, 'rgba(80, 80, 120, 0.3)');

    let textY = boxY + INNER_PAD;
    const textX = boxX + INNER_PAD;

    // Speaker name (yellow)
    if (this.speaker) {
      surf.drawText(this.speaker, textX, textY, SPEAKER_COLOR, SPEAKER_FONT);
      textY += LINE_HEIGHT;
    }

    // Render displayed text, handling embedded newlines
    const textLines = this.displayedText.split('\n');
    for (const line of textLines) {
      surf.drawText(line, textX, textY, TEXT_COLOR, FONT);
      textY += LINE_HEIGHT;
    }

    // Waiting indicator — a small blinking triangle
    if (this.state === 'waiting') {
      this.frameCounter++;
      if (Math.floor(this.frameCounter / 20) % 2 === 0) {
        const indicatorX = boxX + boxW - 10;
        const indicatorY = boxY + BOX_HEIGHT - 10;
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
