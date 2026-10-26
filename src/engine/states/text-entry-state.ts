/**
 * text-entry-state.ts — port of lt-maker/app/engine/text_entry.py.
 *
 * Entered via the `text_entry` event command: game.memory['text_entry'] holds
 * [nid, header, characterLimit, illegalGroups, forceEntry, defaultString,
 * minimumCharacterLimit]. Draws Python's menus.KeyboardMenu: the NamingScreen
 * sprite (project custom_sprites override first), the header in text-blue,
 * the entered name with the Underscore caret, and a 26-column character
 * table with the menu hand. START opens the TextConfirmState "Finish text
 * entry?" Yes/No box; Yes stores the text reversibly as a game var.
 *
 * Keyboard typing works like Python's keyboard mode: Enter toggles it (with
 * the focus_fade overlay), printable keys append and Backspace deletes.
 */

import { State, type StateResult } from '../state';
import { Surface } from '../surface';
import type { InputEvent } from '../input';
import { SetGameVarAction } from '../action';
import { Banner } from '../../ui/banner';
import { WINHEIGHT, WINWIDTH } from '../constants';
import {
  MenuCursor,
  MenuScene,
  ScrollBar,
  baseSurf,
  blitSprite,
  blitText,
  getSprite,
  preloadSprites,
  textWidth,
} from '../../ui/menu-chrome';

let _game: any = null;
export function setTextEntryGameRef(g: any): void {
  _game = g;
}
function getGame(): any {
  if (!_game) throw new Error('Game reference not set for text entry state');
  return _game;
}

/** app.utilities.enums.CharacterSet */
const CHARACTER_SETS: Record<string, string[]> = {
  uppercase: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split(''),
  lowercase: 'abcdefghijklmnopqrstuvwxyz'.split(''),
  uppercase_UTF8: ['Á', 'À', 'Â', 'Ä', 'Å', 'Ç', 'Ð', 'É', 'È', 'Ê', 'Ë', 'Í', 'Ì', 'Î', 'Ï',
    'Ñ', 'Ó', 'Ò', 'Ô', 'Ö', 'Ø', 'Þ', 'Ú', 'Ù', 'Û', 'Ü', 'Ý', 'Ÿ', 'Ƿ', 'Æ', 'Œ'],
  lowercase_UTF8: ['á', 'à', 'â', 'ä', 'å', 'ç', 'ð', 'é', 'è', 'ê', 'ë', 'í', 'ì', 'î', 'ï',
    'ñ', 'ó', 'ò', 'ô', 'ö', 'ø', 'þ', 'ú', 'ù', 'û', 'ü', 'ý', 'ÿ', 'ƿ', 'æ', 'œ'],
  numbers_and_punctuation: [
    '0', '1', '2', '3', '4', '5', '6', '7', '8', '9',
    '!', '¡', '?', '¿', '&', '-', '+', ';', ':', "'", ',', '.', '"',
    ...new Array(26 - 7).fill(' '),
  ],
};

const ROWS = 7;
const COLUMNS = 26;
const TABLE_LEFT = 9;
const TABLE_TOP = 42;

export class TextEntryState extends State {
  readonly name = 'text_entry';
  override readonly transparent = true;

  private varNid = '';
  private header = '';
  private characterLimit = 16;
  private forceEntry = false;
  private minimumCharacterLimit = 0;
  /** Characters on the keyboard table (KeyboardMenu.options). */
  private options: string[] = [];
  /** Single characters an event listed in place of a CharacterSet group. */
  private extraIllegal: Set<string> = new Set();
  private currentIndex = 0;
  private scroll = 0;
  private cursor = new MenuCursor();
  private scrollBar = new ScrollBar();
  private scene = new MenuScene();
  private keyboardMode = false;
  private swallowSelect = false;
  private banner: Banner | null = null;
  /** TextConfirmState: null when not confirming, else the Yes/No index. */
  private confirmIndex: number | null = null;
  private confirmCursor = new MenuCursor();
  /** Current entered text (KeyboardMenu.name; exposed for harness tests). */
  currentText = '';

  private keyListener: ((e: KeyboardEvent) => void) | null = null;

  override start(): StateResult {
    const game = getGame();
    const params = game.memory.get('text_entry') ?? [];
    const [nid, header, charLimit, illegal, force, defaultString, minChars] = params;
    this.varNid = nid ?? '';
    this.header = header ?? '';
    this.characterLimit = charLimit ?? 16;
    this.forceEntry = !!force;
    this.minimumCharacterLimit = minChars ?? 0;
    const groups = { ...CHARACTER_SETS };
    this.extraIllegal = new Set();
    for (const entry of (illegal ?? []) as string[]) {
      const key = Object.keys(groups).find((name) => name.toLowerCase() === String(entry).toLowerCase());
      if (key) delete groups[key];
      else this.extraIllegal.add(String(entry));
    }
    this.options = Object.values(groups).flat();
    this.currentIndex = 0;
    this.scroll = 0;
    this.keyboardMode = false;
    this.confirmIndex = null;
    this.banner = null;
    this.currentText = '';
    for (const ch of String(defaultString ?? '')) this.currentText += ch;
    // NamingScreen is commonly overridden by the project (EOtF ships one).
    preloadSprites(['NamingScreen'], game.resources);
    preloadSprites(['Underscore', 'focus_fade', 'menus/menu_hand', 'menus/menu_highlight']);

    this.removeKeyListener();
    this.keyListener = (e: KeyboardEvent) => {
      if (this.confirmIndex !== null) return;
      if (e.key === 'Enter') {
        this.keyboardMode = !this.keyboardMode;
        this.swallowSelect = true;
        return;
      }
      if (!this.keyboardMode) return;
      if (e.key === 'Backspace') this.back();
      else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) this.add(e.key);
    };
    window.addEventListener('keydown', this.keyListener);
  }

  override end(): StateResult {
    this.removeKeyListener();
  }

  // Python's state machine runs end() on pop as well; this one calls only
  // finish(), so a popped entry kept its listener and every reopen added
  // another (each typed key then landed once per stale listener).
  override finish(): void {
    this.removeKeyListener();
  }

  private removeKeyListener(): void {
    if (this.keyListener) {
      window.removeEventListener('keydown', this.keyListener);
      this.keyListener = null;
    }
  }

  private legal(ch: string): boolean {
    return this.options.includes(ch) && !this.extraIllegal.has(ch);
  }

  /** TextEntryState._add */
  private add(ch: string): boolean {
    const game = getGame();
    if (this.currentText.length < this.characterLimit && ch && this.legal(ch)) {
      this.currentText += ch;
      game.audioManager?.playSfx?.('Select 1');
      return true;
    }
    game.audioManager?.playSfx?.('Error');
    return false;
  }

  /** TextEntryState._back */
  private back(): void {
    const game = getGame();
    if (this.currentText.length > 0) {
      this.currentText = this.currentText.slice(0, -1);
      game.audioManager?.playSfx?.('Select 4');
    } else {
      game.audioManager?.playSfx?.('Error');
    }
  }

  /** Append a character honoring limit + illegal sets (harness-callable). */
  appendChar(ch: string): void {
    this.add(ch);
  }

  /** Remove the last character (harness-callable). */
  backspace(): void {
    this.back();
  }

  /** TextConfirmState 'Yes'; returns false below the minimum length (harness-callable). */
  confirm(): boolean {
    const game = getGame();
    if (this.currentText.length < this.minimumCharacterLimit) {
      this.showTooShort();
      return false;
    }
    game.actionLog.doAction(new SetGameVarAction(game.gameVars, this.varNid, this.currentText));
    game.actionLog.doAction(new SetGameVarAction(game.gameVars, 'last_response_entered', this.currentText));
    game.state.back();
    return true;
  }

  private showTooShort(): void {
    getGame().audioManager?.playSfx?.('Error');
    this.banner = new Banner(`Enter at least ${this.minimumCharacterLimit} characters!`, undefined, 3000);
  }

  // -- menus.Table movement (first_push wrapping, columns = 26) --

  private exists(row: number, col: number): boolean {
    return col >= 0 && col < COLUMNS && row >= 0 && row * COLUMNS + col < this.options.length;
  }

  private numRows(): number {
    return Math.ceil(this.options.length / COLUMNS);
  }

  private clampScroll(): void {
    this.scroll = Math.max(0, Math.min(this.scroll, Math.max(0, this.numRows() - ROWS)));
  }

  private moveDown(): boolean {
    const old = this.currentIndex;
    let row = Math.floor(old / COLUMNS) + 1;
    const col = old % COLUMNS;
    if (!this.exists(row, col)) {
      row = 0;
      this.scroll = 0;
    } else if (row > this.scroll + ROWS - 2) {
      this.scroll += 1;
    } else {
      this.cursor.yOffsetDown();
    }
    this.currentIndex = row * COLUMNS + col;
    this.clampScroll();
    return old !== this.currentIndex;
  }

  private moveUp(): boolean {
    const old = this.currentIndex;
    let row = Math.floor(old / COLUMNS) - 1;
    const col = old % COLUMNS;
    if (!this.exists(row, col)) {
      // Table._get_bottom(col)
      const n = this.options.length;
      row = col >= n % COLUMNS ? Math.floor(n / COLUMNS) - 1 : Math.floor(n / COLUMNS);
      this.scroll = this.numRows() - ROWS;
    } else if (row < this.scroll + 1) {
      this.scroll -= 1;
    } else {
      this.cursor.yOffsetUp();
    }
    this.currentIndex = row * COLUMNS + col;
    this.scroll = Math.max(0, this.scroll);
    return old !== this.currentIndex;
  }

  private moveRight(): boolean {
    const old = this.currentIndex;
    if (old >= this.options.length - 1) return false;
    let row = Math.floor(old / COLUMNS);
    let col = old % COLUMNS + 1;
    if (!this.exists(row, col)) {
      row += 1;
      col = 0;
      if (row > this.scroll + ROWS - 2) {
        this.scroll += 1;
        this.clampScroll();
      }
    }
    this.currentIndex = row * COLUMNS + col;
    return true;
  }

  private moveLeft(): boolean {
    const old = this.currentIndex;
    let row = Math.floor(old / COLUMNS);
    let col = old % COLUMNS - 1;
    if (col < 0) {
      if (row <= 0) return false;
      row -= 1;
      col = COLUMNS - 1;
      if (row < this.scroll + 1) this.scroll = Math.max(0, this.scroll - 1);
    }
    this.currentIndex = row * COLUMNS + col;
    return old !== this.currentIndex;
  }

  override takeInput(event: InputEvent): StateResult {
    const game = getGame();
    const sfx = (name: string): void => game.audioManager?.playSfx?.(name);
    if (event === 'SELECT' && this.swallowSelect) {
      this.swallowSelect = false;
      return;
    }
    if (this.banner) {
      if (event) this.banner = null;
      return;
    }
    if (this.confirmIndex !== null) {
      // TextConfirmState.take_input (vertical Yes/No).
      if (event === 'DOWN' || event === 'UP') {
        this.confirmIndex = this.confirmIndex === 0 ? 1 : 0;
        sfx('Select 6');
      } else if (event === 'BACK') {
        sfx('Error');
      } else if (event === 'SELECT') {
        sfx('Select 1');
        if (this.confirmIndex === 0) this.confirm();
        else this.confirmIndex = null;
      }
      return;
    }
    if (this.keyboardMode) return;

    if (event === 'RIGHT') {
      if (this.moveRight()) sfx('Select 6');
    } else if (event === 'LEFT') {
      if (this.moveLeft()) sfx('Select 6');
    } else if (event === 'DOWN') {
      if (this.moveDown()) sfx('Select 6');
    } else if (event === 'UP') {
      if (this.moveUp()) sfx('Select 6');
    } else if (event === 'BACK') {
      this.back();
    } else if (event === 'SELECT') {
      const selection = this.options[this.currentIndex];
      if (selection) this.add(selection);
    } else if (event === 'START') {
      if (this.currentText.length < this.minimumCharacterLimit) {
        this.showTooShort();
      } else {
        sfx('Select 2');
        this.confirmIndex = 0;
      }
    } else if (event === 'AUX' && !this.forceEntry) {
      game.state.back();
    }
  }

  override update(): StateResult {
    this.cursor.update();
    this.confirmCursor.update();
    if (this.banner && this.banner.update(getGame().frameDeltaMs ?? 16)) this.banner = null;
  }

  override draw(surf: Surface): Surface {
    const s = this.scene.begin();
    this.drawKeyboard(s);
    if (this.keyboardMode) blitSprite(s, getSprite('focus_fade'), 0, 0);
    if (this.confirmIndex !== null) this.drawConfirm(s);
    this.scene.present(surf);
    if (this.banner) this.banner.draw(surf);
    return surf;
  }

  /** KeyboardMenu.draw */
  private drawKeyboard(s: Surface): void {
    blitSprite(s, getSprite('NamingScreen'), 0, 0);
    if (this.header) blitText(s, 'text-blue', this.header, 3, 2);
    if (this.options.length > ROWS * COLUMNS) {
      this.scrollBar.draw(s, TABLE_LEFT + COLUMNS * 8, TABLE_TOP, this.scroll, ROWS, this.numRows());
    }
    const start = this.scroll * COLUMNS;
    const visible = this.options.slice(start, start + ROWS * COLUMNS);
    visible.forEach((ch, idx) => {
      const top = TABLE_TOP + 4 + Math.floor(idx / COLUMNS) * 16;
      const left = TABLE_LEFT + (idx % COLUMNS) * 8;
      blitText(s, this.extraIllegal.has(ch) ? 'text-grey' : 'text', ch, left + 5, top);
      if (idx + start === this.currentIndex && !this.keyboardMode && this.confirmIndex === null) {
        this.cursor.draw(s, left, top);
      }
    });
    blitText(s, 'text', this.currentText, 6, 20);
    if (this.currentText.length < this.characterLimit) {
      blitSprite(s, getSprite('Underscore'), 6 + textWidth('text', this.currentText), 17 + 16);
    }
  }

  /** TextConfirmState.draw */
  private drawConfirm(s: Surface): void {
    const header = 'Finish text entry?';
    const options = ['Yes', 'No'];
    const optionWidth = Math.max(...options.map((o) => textWidth('text', o) + 24));
    const menuWidth = optionWidth - (optionWidth % 8);
    const width = Math.max(textWidth('text', header) + 16, menuWidth);
    const height = options.length * 16 + 8 + 16;
    const x = Math.floor(WINWIDTH / 2 - width / 2);
    const y = Math.floor(WINHEIGHT / 2 - height / 2);
    s.blit(baseSurf(width, height, 'menu_bg_base'), x, y);
    blitText(s, 'text', header, x + 4, y + 4);
    const highlight = getSprite('menus/menu_highlight');
    options.forEach((option, idx) => {
      const top = y + 16 + 4 + idx * 16;
      if (idx === this.confirmIndex && highlight) {
        for (let slot = 0; slot < Math.floor((menuWidth - 10) / highlight.width); slot++) {
          blitSprite(s, highlight, x + 5 + slot * highlight.width, top + 9);
        }
      }
      blitText(s, 'text', option, x + 5, top);
      if (idx === this.confirmIndex) this.confirmCursor.draw(s, x, top);
    });
  }
}
