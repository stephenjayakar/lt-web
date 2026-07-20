/**
 * text-entry-state.ts — Player text input (Python app/engine/text_entry.py).
 *
 * Entered via the `text_entry` event command: game.memory['text_entry'] holds
 * [nid, header, characterLimit, illegalChars, forceEntry, defaultString,
 * minimumCharacterLimit]. On confirm the text is stored reversibly as a game
 * var (Python action.SetGameVar(constant_id, text)); AUX/Escape cancels
 * without saving unless forceEntry. Uses real keyboard characters via a
 * window keydown listener (Python's grid keyboard/letter menu is replaced by
 * direct typing — documented presentation deviation).
 */

import { State, type StateResult } from '../state';
import type { Surface } from '../surface';
import type { InputEvent } from '../input';
import { viewport } from '../viewport';
import { SetGameVarAction } from '../action';

let _game: any = null;
export function setTextEntryGameRef(g: any): void {
  _game = g;
}
function getGame(): any {
  if (!_game) throw new Error('Game reference not set for text entry state');
  return _game;
}

export class TextEntryState extends State {
  readonly name = 'text_entry';
  override readonly showMap = false;
  override readonly inLevel = false;

  private varNid = '';
  private header = '';
  private characterLimit = 16;
  private illegalChars: Set<string> = new Set();
  private forceEntry = false;
  private minimumCharacterLimit = 0;
  /** Current entered text (exposed for harness-driven tests). */
  currentText = '';
  /** Set when confirm is rejected for being too short (drawn as an error). */
  private tooShort = false;

  private keyListener: ((e: KeyboardEvent) => void) | null = null;

  override start(): StateResult {
    const game = getGame();
    const params = game.memory.get('text_entry') ?? [];
    const [nid, header, charLimit, illegal, force, defaultString, minChars] = params;
    this.varNid = nid ?? '';
    this.header = header ?? '';
    this.characterLimit = charLimit ?? 16;
    this.illegalChars = new Set<string>(illegal ?? []);
    this.forceEntry = !!force;
    this.currentText = defaultString ?? '';
    this.minimumCharacterLimit = minChars ?? 0;
    this.tooShort = false;

    this.keyListener = (e: KeyboardEvent) => {
      if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
        this.appendChar(e.key);
      } else if (e.key === 'Backspace') {
        this.backspace();
      }
    };
    window.addEventListener('keydown', this.keyListener);
  }

  override end(): StateResult {
    if (this.keyListener) {
      window.removeEventListener('keydown', this.keyListener);
      this.keyListener = null;
    }
  }

  /** Append a character honoring limit + illegal set (harness-callable). */
  appendChar(ch: string): void {
    this.tooShort = false;
    if (this.currentText.length >= this.characterLimit) return;
    if (this.illegalChars.has(ch)) return;
    this.currentText += ch;
  }

  /** Remove the last character (harness-callable). */
  backspace(): void {
    this.tooShort = false;
    this.currentText = this.currentText.slice(0, -1);
  }

  /** Confirm entry; returns false when below the minimum length (harness-callable). */
  confirm(): boolean {
    const game = getGame();
    if (this.currentText.length < this.minimumCharacterLimit) {
      this.tooShort = true;
      return false;
    }
    game.actionLog.doAction(new SetGameVarAction(game.gameVars, this.varNid, this.currentText));
    game.state.back();
    return true;
  }

  override takeInput(event: InputEvent): StateResult {
    if (event === 'START' || event === 'SELECT') {
      this.confirm();
    } else if (event === 'AUX' && !this.forceEntry) {
      getGame().state.back();
    }
  }

  override draw(surf: Surface): Surface {
    const vw = viewport.width;
    const vh = viewport.height;
    surf.fillRect(0, 0, vw, vh, 'rgba(8,8,24,0.92)');
    surf.drawText(this.header, 12, Math.floor(vh / 2) - 28, 'rgba(220,200,128,1)', '8px monospace');
    surf.fillRect(10, Math.floor(vh / 2) - 10, vw - 20, 20, 'rgba(24,24,64,0.9)');
    surf.drawText(`${this.currentText}_`, 14, Math.floor(vh / 2) - 4, 'white', '8px monospace');
    const hint = this.tooShort
      ? `Enter at least ${this.minimumCharacterLimit} characters!`
      : `${this.currentText.length}/${this.characterLimit}  (Enter: confirm${this.forceEntry ? '' : ', Aux: cancel'})`;
    surf.drawText(hint, 12, Math.floor(vh / 2) + 16, this.tooShort ? 'rgba(255,120,120,1)' : 'rgba(160,160,200,1)', '6px monospace');
    return surf;
  }
}
