/**
 * save-load-state.ts -- SaveMenuState and LoadMenuState for the save/load UI.
 *
 * SaveMenuState: Shows a list of save slots, lets the player pick one to save to.
 * LoadMenuState: Shows a list of save slots (+ suspend), lets the player pick one to load.
 *
 * Both are transparent states that overlay on top of the current game screen.
 */

import { State, type StateResult } from '../state';
import type { Surface } from '../surface';
import type { InputEvent } from '../input';
import { viewport } from '../viewport';
import { ChoiceMenu, type MenuOption } from '../../ui/menu';
import {
  saveGame,
  loadGame,
  loadSuspend,
  loadSaveSlots,
  hasSuspend,
  formatPlaytime,
  type SaveSlot,
} from '../save';

// ---------------------------------------------------------------------------
// Lazy game reference
// ---------------------------------------------------------------------------

let _game: any = null;
export function setSaveLoadGameRef(g: any): void {
  _game = g;
}
function getGame(): any {
  if (!_game) throw new Error('Game reference not set for save-load states.');
  return _game;
}

// ---------------------------------------------------------------------------
// SaveMenuState
// ---------------------------------------------------------------------------

export class SaveMenuState extends State {
  name = 'save_menu';
  transparent = true;

  private menu: ChoiceMenu | null = null;
  private slots: SaveSlot[] = [];
  private loading: boolean = true;
  private saving: boolean = false;
  private message: string = '';
  private messageTimer: number = 0;

  override start(): StateResult {
    this.loading = true;
    this.saving = false;
    this.message = '';
    this.messageTimer = 0;

    const game = getGame();
    const gameNid = game.db.getConstant('game_nid', 'default') as string;
    const numSlots = game.db.getConstant('num_save_slots', 3) as number;

    loadSaveSlots(gameNid, numSlots).then((slots) => {
      this.slots = slots;
      this.buildMenu(slots);
      this.loading = false;
    }).catch((err) => {
      console.error('SaveMenuState: failed to load slots', err);
      this.loading = false;
    });

    return undefined;
  }

  private buildMenu(slots: SaveSlot[]): void {
    const options: MenuOption[] = [];

    for (const slot of slots) {
      const hasData = slot.name !== '--NO DATA--';
      const label = hasData
        ? `Slot ${slot.idx + 1}: ${slot.name} (${formatPlaytime(slot.playtime)})`
        : `Slot ${slot.idx + 1}: --Empty--`;
      options.push({
        label,
        value: String(slot.idx),
        enabled: true,
        description: hasData ? `Overwrite save in slot ${slot.idx + 1}` : `Save to slot ${slot.idx + 1}`,
      });
    }

    options.push({
      label: 'Cancel',
      value: 'cancel',
      enabled: true,
      description: 'Go back.',
    });

    this.menu = new ChoiceMenu(options, 16, 16);
  }

  override takeInput(event: InputEvent | null): StateResult {
    if (!event || !this.menu || this.loading || this.saving) return undefined;

    const game = getGame();

    if (this.messageTimer > 0) {
      this.messageTimer -= game.frameDeltaMs ?? 16;
      if (this.messageTimer <= 0) {
        game.state.back();
      }
      return undefined;
    }

    const result = this.menu.handleInput(event);
    if (result && 'back' in result) {
      game.state.back();
    } else if (result && 'selected' in result) {
      if (result.selected === 'cancel') {
        game.state.back();
      } else {
        const slotIdx = parseInt(result.selected, 10);
        this.saving = true;
        saveGame(game, slotIdx, 'battle').then(() => {
          game.currentSaveSlot = slotIdx;
          this.message = 'Game saved!';
          this.messageTimer = 1500;
          this.saving = false;
        }).catch((err: any) => {
          console.error('SaveMenuState: save failed', err);
          this.message = 'Save failed!';
          this.messageTimer = 1500;
          this.saving = false;
        });
      }
    }

    return undefined;
  }

  override draw(surf: Surface): Surface {
    const ctx = surf.ctx;
    const w = viewport.width;
    const h = viewport.height;

    // Dark overlay
    ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
    ctx.fillRect(0, 0, w, h);

    // Title
    ctx.fillStyle = '#ddddff';
    ctx.font = '10px monospace';
    ctx.textBaseline = 'top';
    ctx.fillText('-- Save Game --', 16, 4);

    if (this.loading) {
      ctx.fillText('Loading...', 16, 24);
    } else if (this.message) {
      ctx.fillStyle = '#88ff88';
      ctx.fillText(this.message, 16, 60);
    } else if (this.saving) {
      ctx.fillText('Saving...', 16, 24);
    } else if (this.menu) {
      this.menu.draw(surf);
    }

    return surf;
  }
}

// ---------------------------------------------------------------------------
// LoadMenuState
// ---------------------------------------------------------------------------

export class LoadMenuState extends State {
  name = 'load_menu';
  transparent = true;

  private menu: ChoiceMenu | null = null;
  private slots: SaveSlot[] = [];
  private loading: boolean = true;
  private restoring: boolean = false;
  private hasSuspendSave: boolean = false;
  private message: string = '';
  private messageTimer: number = 0;

  override start(): StateResult {
    this.loading = true;
    this.restoring = false;
    this.hasSuspendSave = false;
    this.message = '';
    this.messageTimer = 0;

    const game = getGame();
    const gameNid = game.db.getConstant('game_nid', 'default') as string;
    const numSlots = game.db.getConstant('num_save_slots', 3) as number;

    Promise.all([
      loadSaveSlots(gameNid, numSlots),
      hasSuspend(gameNid),
    ]).then(([slots, hasSusp]) => {
      this.slots = slots;
      this.hasSuspendSave = hasSusp;
      this.buildMenu(slots, hasSusp);
      this.loading = false;
    }).catch((err) => {
      console.error('LoadMenuState: failed to load slots', err);
      this.loading = false;
    });

    return undefined;
  }

  private buildMenu(slots: SaveSlot[], hasSusp: boolean): void {
    const options: MenuOption[] = [];

    // Suspend save (if exists)
    if (hasSusp) {
      options.push({
        label: 'Resume Suspend',
        value: 'suspend',
        enabled: true,
        description: 'Resume from suspend save.',
      });
    }

    for (const slot of slots) {
      const hasData = slot.name !== '--NO DATA--';
      const label = hasData
        ? `Slot ${slot.idx + 1}: ${slot.name} (${formatPlaytime(slot.playtime)})`
        : `Slot ${slot.idx + 1}: --Empty--`;
      options.push({
        label,
        value: String(slot.idx),
        enabled: hasData,
        description: hasData ? `Load from slot ${slot.idx + 1}` : 'No save data.',
      });
    }

    options.push({
      label: 'Cancel',
      value: 'cancel',
      enabled: true,
      description: 'Go back.',
    });

    this.menu = new ChoiceMenu(options, 16, 16);
  }

  override takeInput(event: InputEvent | null): StateResult {
    if (!event || !this.menu || this.loading || this.restoring) return undefined;

    const game = getGame();

    if (this.messageTimer > 0) {
      this.messageTimer -= game.frameDeltaMs ?? 16;
      if (this.messageTimer <= 0) {
        if (this.message.startsWith('Load failed')) {
          // Stay on load menu
          this.message = '';
        }
      }
      return undefined;
    }

    const result = this.menu.handleInput(event);
    if (result && 'back' in result) {
      game.state.back();
    } else if (result && 'selected' in result) {
      if (result.selected === 'cancel') {
        game.state.back();
        return undefined;
      }

      this.restoring = true;

      if (result.selected === 'suspend') {
        loadSuspend(game).then((success: boolean) => {
          this.restoring = false;
          if (success) {
            game.state.clear();
            game.state.change('free');
          } else {
            this.message = 'Load failed!';
            this.messageTimer = 1500;
          }
        }).catch((err: any) => {
          console.error('LoadMenuState: load suspend failed', err);
          this.restoring = false;
          this.message = 'Load failed!';
          this.messageTimer = 1500;
        });
      } else {
        const slotIdx = parseInt(result.selected, 10);
        loadGame(game, slotIdx).then((success: boolean) => {
          this.restoring = false;
          if (success) {
            game.currentSaveSlot = slotIdx;
            game.state.clear();
            game.state.change('free');
          } else {
            this.message = 'Load failed!';
            this.messageTimer = 1500;
          }
        }).catch((err: any) => {
          console.error('LoadMenuState: load failed', err);
          this.restoring = false;
          this.message = 'Load failed!';
          this.messageTimer = 1500;
        });
      }
    }

    return undefined;
  }

  override draw(surf: Surface): Surface {
    const ctx = surf.ctx;
    const w = viewport.width;
    const h = viewport.height;

    // Dark overlay
    ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
    ctx.fillRect(0, 0, w, h);

    // Title
    ctx.fillStyle = '#ddddff';
    ctx.font = '10px monospace';
    ctx.textBaseline = 'top';
    ctx.fillText('-- Load Game --', 16, 4);

    if (this.loading) {
      ctx.fillText('Loading...', 16, 24);
    } else if (this.message) {
      ctx.fillStyle = this.message.startsWith('Load failed') ? '#ff8888' : '#88ff88';
      ctx.fillText(this.message, 16, 60);
    } else if (this.restoring) {
      ctx.fillText('Loading...', 16, 24);
    } else if (this.menu) {
      this.menu.draw(surf);
    }

    return surf;
  }
}
