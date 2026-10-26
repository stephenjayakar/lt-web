/**
 * dialog.ts — speech/narration text box.
 *
 * Port of lt-maker/app/engine/dialog.py (Dialog): a `message_bg_base`
 * window holding `num_lines` lines of 16px text in the speak style's font
 * (default black 'convo'), typed out character by character with short
 * pauses after punctuation, a waiting cursor at {w}, lines that scroll up
 * when more than `num_lines` are needed, a speech tail toward the speaking
 * portrait, and a name tag when there is a speaker but no portrait.
 *
 * Speak styles (position, width, num_lines, background, font colour/type,
 * cursor, tail) arrive through `DialogStyle`; the caller resolves Python's
 * built-in and project speak styles.
 */

import { Surface } from '../engine/surface';
import { engineSpriteUrl } from './sprites';
import { viewport } from '../engine/viewport';
import type { InputEvent } from '../engine/input';
import type { EventPortrait } from '../events/event-portrait';
import { FONT, areFontsReady } from '../rendering/bmp-font';
import { getMenuBackgroundSync, loadMenuBgSprite } from './base-surf';
import { drawIconByAlias } from './icons';
import { getSetting } from '../engine/states/settings-state';

/** Audio for Python Dialog.play_talk_boop. */
let _dialogAudio: { playSfx(name: string): void } | null = null;
export function setDialogAudio(am: { playSfx(name: string): void } | null): void {
  _dialogAudio = am;
}

export type DialogState =
  | 'transition_in'
  | 'process'
  | 'pause'
  | 'pause_before_wait'
  | 'wait'
  | 'new_line'
  | 'command_pause'
  | 'done';

export interface DialogStyle {
  /** Alignment name (center, top, bottom_left, ...) or explicit [x, y]. */
  position?: string | [number, number] | null;
  width?: number | null;
  numLines?: number | null;
  background?: string | null;
  fontColor?: string | null;
  fontType?: string | null;
  drawCursor?: boolean | null;
  messageTail?: string | null;
  transparency?: number | null;
  nameTagBg?: string | null;
  autosize?: boolean;
  hold?: boolean;
  /** Speak style boop_sound (Python default styles use 'Talk_Boop'). */
  boopSound?: string | null;
  /** The `no_sound` speak flag: no boops for this dialog. */
  noSound?: boolean;
  /**
   * Set text_width (and width = text_width + 16) after sizing, the way
   * Python callers assign d.text_width / d.width on a built Dialog.
   */
  textWidth?: number | null;
}

const FRAME_MS = 1000 / 60;
const TRANSITION_MS = 10 * FRAME_MS;
const PAUSE_BEFORE_WAIT_MS = 9 * FRAME_MS;
const PAUSE_MS = 3 * FRAME_MS;
const CURSOR_OFFSET = [
  ...Array<number>(20).fill(0), 1, 1, ...Array<number>(8).fill(2), 1, 1,
];
const PORTRAIT_HEIGHT = 80;
const PUNCTUATION = new Set(['.', ',', ';', '!', '?']);
/** Placeholder char standing for an inline <icon> in the visible stream. */
const ICON_CHAR = '\u0001';

/** A visible character with its tag-stack colour and font (Python TaggedText chunk). */
type Glyph = { ch: string; color: string; font: string; icon: string | null };

/** Python dialog.process_dialog_shorthand. */
function processShorthand(text: string): string {
  if (!text) return text;
  return text
    .replace(/\n/g, '{br}')
    .replace(/\|/g, '{w}{br}')
    .replace(/\{semicolon\}/g, ';')
    .replace(/\{lt\}/g, '<').replace(/\{gt\}/g, '>')
    .replace(/\{lcb\}/g, '{').replace(/\{rcb\}/g, '}');
}

function fontFor(type: string) {
  return areFontsReady() ? (FONT[type] ?? FONT.convo ?? FONT.text ?? null) : null;
}

function measure(fontType: string, text: string): number {
  const font = fontFor(fontType);
  return font ? font.width(text) : text.length * 6;
}

export class Dialog {
  static readonly TRANSITION_DURATION_MS = TRANSITION_MS;

  private plainText: string;
  private speaker: string;
  private portrait: EventPortrait | null;
  private textSpeedMs: number;
  private speed: number;
  private startingSpeed: number;
  private autoClose: boolean;
  private noWait = false;
  private _state: DialogState = 'transition_in';

  private fontType: string;
  private fontColor: string;
  private numLines: number;
  private drawCursorFlag: boolean;
  private backgroundName: string | null;
  private messageTail: string | null;
  private transparency: number;
  private nameTagBg: string;
  private hold: boolean;
  private boopSound: string | null;
  /** Python should_speak_sound ({tgs} toggles it). */
  private shouldSpeakSound: boolean;
  private lastSoundUpdate = -Infinity;

  /** Commands and visible characters in typing order. */
  private textCommands: string[] = [];
  /** Visible glyphs (tags resolved to colours, icons as one glyph). */
  private glyphs: Glyph[] = [];
  /** [start, stop) glyph ranges, one per text line. */
  private textIndices: Array<{ start: number; stop: number }> = [];
  private textIndex = 0;
  /** Index into `glyphs` of the next visible glyph to reveal. */
  private glyphCursor = 0;
  private totalUpdates = 0;
  private yOffset = 0;
  private lastUpdate = 0;
  private elapsed = 0;
  private transitionProgress = 0;
  private cursorOffsetIndex = 0;
  private pendingCommands: string[] = [];
  private commandWaitMs = 0;

  width: number;
  height: number;
  private textWidth: number;
  private textHeight: number;
  position: [number, number];

  constructor(
    text: string,
    speaker?: string,
    portrait?: EventPortrait,
    textSpeedMs?: number,
    speedMult?: number,
    autoClose: boolean = false,
    style: DialogStyle = {},
  ) {
    this.speaker = speaker ?? '';
    this.portrait = portrait ?? null;
    this.textSpeedMs = textSpeedMs ?? 32;
    this.speed = speedMult ?? 1;
    this.startingSpeed = this.speed;
    this.autoClose = autoClose;
    this.fontType = style.fontType || 'convo';
    this.fontColor = style.fontColor || 'black';
    this.numLines = style.numLines && style.numLines > 0 ? style.numLines : 2;
    this.drawCursorFlag = style.drawCursor ?? true;
    const bg = style.background === undefined ? 'message_bg_base' : style.background;
    this.backgroundName = bg && bg !== 'None' && bg !== 'clear' ? bg : null;
    const tail = style.messageTail === undefined ? 'message_bg_tail' : style.messageTail;
    this.messageTail = tail && tail !== 'None' ? tail : null;
    this.transparency = style.transparency ?? 0.05;
    this.nameTagBg = style.nameTagBg || 'name_tag';
    this.hold = !!style.hold;
    this.boopSound = style.boopSound && style.boopSound !== 'None' ? style.boopSound : null;
    this.shouldSpeakSound = !style.noSound;
    if (this.backgroundName) void loadMenuBgSprite(this.backgroundName);
    if (this.messageTail) void loadMenuBgSprite(this.messageTail);

    this.plainText = processShorthand(text ?? '');
    let body = this.plainText;
    if (body.endsWith('{no_wait}')) {
      body = body.slice(0, -'{no_wait}'.length);
      this.noWait = true;
    } else if (!body.endsWith('{w}')) {
      body += '{w}';
    }
    this.parse(body);

    const winW = viewport.width;
    const winH = viewport.height;
    if (style.width) {
      this.width = style.width + (style.width % 8 ? 8 - (style.width % 8) : 0);
      this.textWidth = Math.max(8, this.width - 16);
      this.textHeight = Math.max(16, 16 * this.numLines);
      this.height = this.textHeight + 16;
    } else if (this.portrait || style.autosize) {
      this.textWidth = Math.max(48, Math.min(this.determineWidth(), winW - 32));
      this.width = this.textWidth + 24 - (this.textWidth % 8);
      if (this.width <= winW - 16) this.width += 8;
      this.textHeight = Math.max(16, 16 * this.numLines);
      this.height = this.textHeight + 16;
    } else {
      this.textWidth = winW - 24;
      this.textHeight = this.numLines * 16;
      this.width = this.textWidth + 16;
      this.height = this.textHeight + 16;
    }

    if (style.textWidth) {
      this.textWidth = style.textWidth;
      this.width = style.textWidth + 16;
    }

    const position = style.position ?? null;
    let x: number;
    let y: number;
    if (Array.isArray(position)) {
      [x, y] = position;
    } else if (position) {
      [x, y] = Dialog.calcAlign([this.width, this.height], position, winW, winH);
    } else if (this.portrait) {
      if (this.width >= winW - 8) {
        x = 4;
      } else {
        const desired = this.portrait.getDesiredCenter();
        x = Math.max(8, Math.min(desired - Math.floor(this.width / 2), winW - 8 - this.width));
        if (x % 8 !== 0) x += 4;
        if (x === 0) x = 4;
      }
      y = winH - this.height - PORTRAIT_HEIGHT - 4;
    } else {
      x = 4;
      y = winH - this.height - 4;
    }
    this.position = [x, y];
  }

  /** Python ui_funcs.calc_align with the dialog margins (4, 4, 2, 2). */
  static calcAlign(size: [number, number], alignment: string, winW: number, winH: number): [number, number] {
    const [w, h] = size;
    const a = alignment.toLowerCase();
    const x = a.endsWith('left') ? 4 : a.endsWith('right') ? winW - (4 + w) : Math.floor(winW / 2) - Math.floor(w / 2);
    const y = a.startsWith('top') ? 2 : a.startsWith('bottom') ? winH - (2 + h) : Math.floor(winH / 2) - Math.floor(h / 2);
    return [x, y];
  }

  // -------------------------------------------------------------------------
  // Parsing
  // -------------------------------------------------------------------------

  private parse(body: string): void {
    // Python styled_text_parser: a font-name tag switches the font, a colour
    // tag the colour; each `</>` pops one tag.
    const tagStack: Array<{ color: string; font: string }> = [{ color: this.fontColor, font: this.fontType }];
    const top = () => tagStack[tagStack.length - 1];
    let i = 0;
    while (i < body.length) {
      if (body[i] === '{') {
        const end = body.indexOf('}', i);
        if (end > i) {
          let depth = 0;
          let close = -1;
          for (let k = i; k < body.length; k++) {
            if (body[k] === '{') depth++;
            else if (body[k] === '}') {
              depth--;
              if (depth === 0) { close = k; break; }
            }
          }
          const command = body.slice(i, (close >= 0 ? close : end) + 1);
          if (command.startsWith('{c:') || command.startsWith('{command:')) {
            const inner = command.slice(command.indexOf(':') + 1, -1);
            this.textCommands.push(`{p:${inner}}`);
          } else {
            this.textCommands.push(command);
          }
          i += command.length;
          continue;
        }
      }
      if (body.startsWith('<icon>', i)) {
        const end = body.indexOf('</>', i + 6);
        if (end > i) {
          this.glyphs.push({ ch: ICON_CHAR, ...top(), icon: body.slice(i + 6, end).trim() });
          this.textCommands.push(ICON_CHAR);
          i = end + 3;
          continue;
        }
      }
      if (body.startsWith('</>', i)) {
        if (tagStack.length > 1) tagStack.pop();
        i += 3;
        continue;
      }
      if (body[i] === '<') {
        const end = body.indexOf('>', i + 1);
        if (end > i) {
          const tag = body.slice(i + 1, end).trim().toLowerCase();
          const current = top();
          if (!tag.includes('-') && areFontsReady() && FONT[tag]) {
            tagStack.push({ color: current.color, font: tag });
          } else {
            const font = fontFor(current.font);
            tagStack.push({ color: font?.hasColor(tag) ? tag : current.color, font: current.font });
          }
          i = end + 1;
          continue;
        }
      }
      this.glyphs.push({ ch: body[i], ...top(), icon: null });
      this.textCommands.push(body[i]);
      i += 1;
    }
  }

  private glyphWidth(start: number, stop: number): number {
    let width = 0;
    let run = '';
    let runFont = this.fontType;
    for (let g = start; g < stop && g < this.glyphs.length; g++) {
      const glyph = this.glyphs[g];
      if (glyph.icon) {
        width += measure(runFont, run) + 16;
        run = '';
      } else {
        if (glyph.font !== runFont) {
          width += measure(runFont, run);
          run = '';
          runFont = glyph.font;
        }
        run += glyph.ch;
      }
    }
    return width + measure(runFont, run);
  }

  /** Python Dialog.determine_width for portrait/autosized boxes. */
  private determineWidth(): number {
    const winW = viewport.width;
    const split = (block: string, forceLines?: number): string[] => {
      let lines = forceLines ?? this.numLines;
      if (!forceLines && block.length <= 24) lines = 1;
      const total = measure(this.fontType, block);
      const out: string[][] = Array.from({ length: lines }, () => []);
      let newLine = false;
      let which = 0;
      for (const ch of block) {
        if (newLine && ch === ' ') {
          which++;
          newLine = false;
          if (which >= out.length) break;
          continue;
        }
        if (which >= out.length) out.push([]);
        out[which].push(ch);
        const so = measure(this.fontType, out[which].join(''));
        if (lines > 1 && so >= Math.floor(total / lines) - 5) newLine = true;
        else if (so >= winW - 16) newLine = true;
      }
      return out.map((l) => l.join(''));
    };
    let width = 0;
    let current = '';
    let precededByWait = false;
    let waitingCursor = false;
    let lastLines: string[] = [];
    let currentWidth = 0;
    const attemptSplit = !this.plainText.includes('{sub_break}');
    const flush = (force: boolean): void => {
      lastLines = force || !attemptSplit ? split(current, 1) : split(current);
      currentWidth = Math.max(0, ...lastLines.map((l) => measure(this.fontType, l)));
      width = Math.max(width, currentWidth);
      if (lastLines.length === 1) waitingCursor = true;
    };
    for (const command of this.textCommands) {
      if (['{br}', '{break}', '{clear}', '{sub_break}'].includes(command)) {
        flush(!precededByWait);
        current = '';
        precededByWait = false;
      } else if (command === '{w}' || command === '{wait}') {
        precededByWait = true;
      } else if (command.startsWith('{')) {
        // other command
      } else {
        current += command === ICON_CHAR ? '  ' : command;
      }
    }
    if (current) flush(false);
    if (waitingCursor && lastLines.length === 1) {
      width += Math.max(0, Math.min(currentWidth - width + 16, 16));
    }
    return width;
  }

  // -------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------

  private get state(): DialogState {
    return this._state;
  }

  private set state(value: DialogState) {
    this._state = value;
  }

  /** Unnarrowed state read (nextChar() mutates the state behind TS's back). */
  private currentState(): DialogState {
    return this._state;
  }

  private addTextIndices(whitespace: boolean): void {
    const last = this.textIndices[this.textIndices.length - 1];
    if (last) {
      const start = whitespace ? last.stop + 1 : last.stop;
      this.textIndices.push({ start, stop: start });
    } else {
      this.textIndices.push({ start: 0, stop: 0 });
    }
  }

  private nextLine(whitespace = false): void {
    if (this.textIndices.length > this.numLines - 1) {
      this.state = 'new_line';
      this.yOffset = 16;
    } else {
      this.state = 'process';
    }
    this.addTextIndices(whitespace);
  }

  private doneProcessing(): boolean {
    return this.textIndex >= this.textCommands.length;
  }

  private pause(): void {
    this.state = 'pause';
    this.lastUpdate = this.elapsed;
  }

  private pauseBeforeWait(): void {
    this.state = 'pause_before_wait';
    this.lastUpdate = this.elapsed;
  }

  private nextWord(): string {
    let word = '';
    for (const command of this.textCommands.slice(this.textIndex + 1)) {
      if (command === ' ') break;
      if (command.length > 1 && command.startsWith('{')) break;
      word += command;
    }
    return word;
  }

  private increment(): void {
    const last = this.textIndices[this.textIndices.length - 1];
    if (last) last.stop += 1;
    this.glyphCursor += 1;
  }

  /** Python Dialog.play_talk_boop. */
  private playTalkBoop(): void {
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (getSetting('talk_boop') && now - this.lastSoundUpdate > 32 && this.shouldSpeakSound) {
      this.lastSoundUpdate = now;
      if (this.boopSound) _dialogAudio?.playSfx(this.boopSound);
    }
  }

  private nextChar(sound: boolean = false): void {
    if (this.doneProcessing()) {
      this.pauseBeforeWait();
      return;
    }
    const command = this.textCommands[this.textIndex];
    if (command === '{br}' || command === '{break}' || command === '{sub_break}') {
      this.nextLine();
    } else if (command === '{w}' || command === '{wait}') {
      this.pauseBeforeWait();
    } else if (command === '{clear}') {
      const lastStop = this.textIndices[this.textIndices.length - 1]?.stop ?? 0;
      this.textIndices = [{ start: lastStop, stop: lastStop }];
    } else if (command === '{p}') {
      this.state = 'command_pause';
    } else if (command.startsWith('{p:')) {
      this.pendingCommands.push(command.slice(3, -1));
      this.state = 'command_pause';
    } else if (command === '{max_speed}') {
      this.speed = 0;
    } else if (command === '{starting_speed}') {
      this.speed = this.startingSpeed;
    } else if (/^\{speed:(\d+(?:\.\d+)?)\}$/.test(command)) {
      this.speed = Number(command.slice(7, -1));
    } else if (command === '{tgs}') {
      this.shouldSpeakSound = !this.shouldSpeakSound;
    } else if (command.startsWith('{')) {
      // Unknown / presentation-only command ({tgm}, ...)
    } else if (command === ' ') {
      const last = this.textIndices[this.textIndices.length - 1];
      const nextWidth = this.glyphWidth(last.start, last.stop + this.nextWord().length + 1);
      if (nextWidth > this.textWidth) {
        this.nextLine(true);
        this.glyphCursor += 1; // the discarded space
      } else {
        this.increment();
        if (sound) this.playTalkBoop();
      }
    } else if (PUNCTUATION.has(command)) {
      this.increment();
      this.pause();
    } else {
      this.increment();
      if (sound) this.playTalkBoop();
    }
    this.textIndex += 1;
  }

  /** Python Dialog.hurry_up (SELECT/RIGHT/DOWN while a dialog is active). */
  private hurryUp(): void {
    if (this.state === 'transition_in') {
      this.transitionProgress = 1;
      this.state = 'process';
      this.nextLine();
    }
    if (this.state === 'process' || this.state === 'pause') {
      this.state = 'process';
      while (this.state === 'process') {
        this.nextChar();
        // Skip pauses because we want maximum velocity of speech
        if (this.currentState() === 'pause') this.state = 'process';
      }
    } else if (this.state === 'wait') {
      this.state = this.doneProcessing() ? 'done' : 'process';
    }
  }

  /** Process input. Returns true when dialog is complete. */
  handleInput(event: InputEvent): boolean {
    if (event === 'SELECT' || event === 'RIGHT' || event === 'DOWN') {
      if (this.state === 'command_pause') return false;
      this.hurryUp();
      return this.state === 'done';
    }
    if (event === 'BACK') {
      this.state = 'done';
      return true;
    }
    return false;
  }

  /** Update typewriter effect. `deltaMs` is elapsed time since last frame. */
  update(deltaMs: number = FRAME_MS): void {
    this.elapsed += deltaMs;
    this.cursorOffsetIndex = (this.cursorOffsetIndex + 1) % CURSOR_OFFSET.length;
    switch (this.state) {
      case 'transition_in':
        this.transitionProgress = Math.min(1, this.transitionProgress + deltaMs / TRANSITION_MS);
        if (this.transitionProgress >= 1) this.nextLine();
        break;
      case 'process': {
        const msPerChar = this.textSpeedMs * this.speed;
        if (msPerChar > 0) {
          this.totalUpdates += deltaMs / msPerChar;
          while (this.totalUpdates >= 1 && this.state === 'process') {
            this.totalUpdates -= 1;
            this.nextChar(this.totalUpdates < 2);
            if (this.state !== 'process') this.totalUpdates = 0;
          }
        } else {
          // Python stops the burst once {starting_speed} restores a speed.
          while (this.state === 'process' && this.textSpeedMs * this.speed === 0) {
            this.nextChar();
            if (this.currentState() === 'pause') this.state = 'process';
          }
          this.playTalkBoop();
        }
        break;
      }
      case 'pause_before_wait':
        if (this.elapsed - this.lastUpdate > PAUSE_BEFORE_WAIT_MS) {
          this.state = this.noWait || this.autoClose ? 'done' : 'wait';
        }
        break;
      case 'pause':
        if (this.elapsed - this.lastUpdate > PAUSE_MS) this.state = 'process';
        break;
      case 'new_line':
        this.yOffset = Math.max(0, this.yOffset - 2);
        if (this.yOffset === 0) this.state = 'process';
        break;
      case 'command_pause':
        if (this.commandWaitMs > 0) {
          this.commandWaitMs -= deltaMs;
          if (this.commandWaitMs <= 0) {
            this.commandWaitMs = 0;
            if (!this.pendingCommands.length) this.state = 'process';
          }
        }
        break;
      default:
        break;
    }
  }

  /** Inline `{c:...}` commands waiting for the event to run (Python queue_command). */
  takePendingCommands(): string[] {
    const commands = this.pendingCommands;
    this.pendingCommands = [];
    return commands;
  }

  /** Pause the text for `ms` (an inline `{c:wait;ms}`), then resume. */
  holdFor(ms: number): void {
    this.commandWaitMs = Math.max(this.commandWaitMs, ms);
  }

  /** Python Dialog.command_unpause. */
  commandUnpause(): void {
    if (this.state === 'command_pause' && this.commandWaitMs <= 0 && !this.pendingCommands.length) {
      this.state = 'process';
    }
  }

  isCommandPaused(): boolean {
    return this.state === 'command_pause';
  }

  /** Check if done */
  isDone(): boolean {
    return this.state === 'done';
  }

  /** True while the typewriter is actively advancing characters. */
  isTyping(): boolean {
    return this.state === 'process' || this.state === 'pause' || this.state === 'new_line';
  }

  /** True while the dialog is waiting for input. */
  isWaiting(): boolean {
    return this.state === 'wait';
  }

  isHeld(): boolean {
    return this.hold;
  }

  // -------------------------------------------------------------------------
  // Drawing
  // -------------------------------------------------------------------------

  private drawGlyphRange(surf: Surface, start: number, stop: number, x: number, y: number,
    clip: [number, number, number, number]): number {
    let cursorX = x;
    let run = '';
    let runColor = '';
    let runFont = this.fontType;
    const flush = (): void => {
      if (!run) return;
      if (y >= clip[1] - 8 && y < clip[1] + clip[3]) {
        surf.drawText(run, cursorX, y, runColor, runFont);
      }
      cursorX += measure(runFont, run);
      run = '';
    };
    for (let g = start; g < stop && g < this.glyphs.length; g++) {
      const glyph = this.glyphs[g];
      if (glyph.icon) {
        flush();
        drawIconByAlias(surf, glyph.icon, cursorX, y);
        cursorX += 16;
        continue;
      }
      if (glyph.color !== runColor || glyph.font !== runFont) {
        flush();
        runColor = glyph.color;
        runFont = glyph.font;
      }
      run += glyph.ch;
    }
    flush();
    return cursorX;
  }

  private drawText(surf: Surface): [number, number] {
    const [px, py] = this.position;
    const left = px + 8;
    const top = py + 8;
    const clip: [number, number, number, number] = [left, top, this.textWidth, this.textHeight];
    let endX = left;
    let endY = top;
    const total = this.textIndices.length;
    if (this.yOffset && total > this.numLines) {
      const { start, stop } = this.textIndices[total - this.numLines - 1];
      const y = top - 16 + this.yOffset;
      if (y >= top) this.drawGlyphRange(surf, start, stop, left, y, clip);
    }
    const shown = this.textIndices.slice(-this.numLines);
    shown.forEach(({ start, stop }, idx) => {
      const baseY = top + 16 * idx;
      const y = total > this.numLines ? baseY + this.yOffset : baseY;
      const x = this.drawGlyphRange(surf, start, stop, left, y, clip);
      endX = x;
      endY = baseY;
    });
    return [endX, endY];
  }

  private drawTail(surf: Surface, portrait: EventPortrait): void {
    if (!this.messageTail) return;
    const tail = getSprite(this.messageTail);
    if (!tail) return;
    const pos = portrait.position;
    const portraitX = pos[0] + 48;
    const portraitY = pos[1] + 40;
    const mirrorX = portraitX < Math.floor(viewport.width / 2);
    const mirrorY = this.position[1] > portraitY;
    const y = mirrorY ? this.position[1] - tail.height + 2 : this.position[1] + this.height - 2;
    let x = mirrorX ? portraitX + 20 : portraitX - 36;
    if (x > this.width + this.position[0] - 24) x = this.position[0] + this.width - 24;
    else if (x < this.position[0] + 8) x = this.position[0] + 8;
    const s = surf.scale;
    const ctx = surf.ctx;
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    ctx.globalAlpha = 1 - this.transparency;
    ctx.translate(Math.round((x + (mirrorX ? tail.width : 0)) * s), Math.round((y + (mirrorY ? tail.height : 0)) * s));
    ctx.scale(mirrorX ? -1 : 1, mirrorY ? -1 : 1);
    ctx.drawImage(tail, 0, 0, tail.width, tail.height, 0, 0, tail.width * s, tail.height * s);
    ctx.restore();
  }

  private drawNameTag(surf: Surface): void {
    const y = this.position[1] < 10 ? this.position[1] + this.height - 6 : this.position[1] - 10;
    let x = this.position[0] - 4;
    if (x < 0) x = this.position[0] + 16;
    surf.blit(getMenuBackgroundSync(64, 16, this.nameTagBg), x, y);
    const w = measure(this.fontType, this.speaker);
    surf.drawText(this.speaker, x + 32 - Math.floor(w / 2), y, this.fontColor, this.fontType);
  }

  /** Draw the dialog box. Completed ending cards may retain their final text. */
  draw(surf: Surface, showCompleted: boolean = false): void {
    if (this.state === 'done' && !showCompleted && !this.hold) return;
    const [x, y] = this.position;
    if (this.backgroundName) {
      const bg = getMenuBackgroundSync(this.width, this.height, this.backgroundName);
      const ctx = surf.ctx;
      ctx.save();
      if (this.state === 'transition_in') {
        const w = Math.max(1, this.width - 10 + Math.floor(10 * this.transitionProgress));
        const h = Math.max(1, this.height - 10 + Math.floor(10 * this.transitionProgress));
        ctx.globalAlpha = 1 - (this.transparency + (0.75 - this.transparency) * (1 - this.transitionProgress));
        const s = surf.scale;
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(bg.canvas, 0, 0, bg.canvas.width, bg.canvas.height,
          Math.round(x * s), Math.round((y + this.height - h) * s), Math.round(w * s), Math.round(h * s));
      } else {
        ctx.globalAlpha = 1 - this.transparency;
        surf.blit(bg, x, y);
      }
      ctx.restore();
    }
    if (this.state === 'transition_in') return;
    if (this.portrait) this.drawTail(surf, this.portrait);
    if (!this.portrait && this.speaker && this.speaker !== 'Narrator') this.drawNameTag(surf);
    const [endX, endY] = this.drawText(surf);
    if (this.state === 'wait' && this.drawCursorFlag) {
      const cursor = getRootSprite('waiting_cursor');
      if (cursor) {
        surf.blitImage(cursor, 0, 0, cursor.width, cursor.height,
          4 + endX, 6 + endY + CURSOR_OFFSET[this.cursorOffsetIndex]);
      } else {
        surf.fillRect(4 + endX, 8 + endY + CURSOR_OFFSET[this.cursorOffsetIndex], 4, 4, 'black');
      }
    }
  }

  /** Visible text so far (for logs/tests). */
  get displayedText(): string {
    return this.glyphs.slice(0, this.glyphCursor).map((g) => (g.icon ? '' : g.ch)).join('');
  }
}

const rootSprites: Map<string, HTMLImageElement | null> = new Map();
/** Engine sprite directly under /game-data/sprites/ (Python SPRITES). */
function getRootSprite(nid: string): HTMLImageElement | null {
  if (!rootSprites.has(nid)) {
    rootSprites.set(nid, null);
    const img = new Image();
    img.onload = () => rootSprites.set(nid, img);
    img.src = engineSpriteUrl(nid, `/game-data/sprites/${nid}.png`);
  }
  return rootSprites.get(nid) ?? null;
}

const sprites: Map<string, HTMLImageElement | null> = new Map();
function getSprite(nid: string): HTMLImageElement | null {
  if (!sprites.has(nid)) {
    sprites.set(nid, null);
    void loadMenuBgSprite(nid).then((img) => sprites.set(nid, img));
  }
  return sprites.get(nid) ?? null;
}
