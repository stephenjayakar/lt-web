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
  loadRestart,
  loadSuspend,
  loadSaveSlots,
  getLastLoadError,
  hasSuspend,
  deleteSuspend,
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

    if (this.messageTimer > 0) return undefined;

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

  override update(): StateResult {
    if (this.messageTimer <= 0) return undefined;

    this.messageTimer -= getGame().frameDeltaMs ?? 16;
    if (this.messageTimer <= 0) {
      getGame().state.back();
    }
    return undefined;
  }

  override draw(surf: Surface): Surface {
    const w = viewport.width;
    const h = viewport.height;

    // Dark overlay. Draw through the Surface helpers: the raw canvas context
    // is in physical pixels, so ctx.fillRect(0, 0, w, h) only darkened the
    // top-left corner and the title text rendered at 1/scale size.
    surf.fillRect(0, 0, w, h, 'rgba(0, 0, 0, 0.7)');
    surf.drawText('-- Save Game --', 16, 0, 'white', 'text');

    if (this.loading) {
      surf.drawText('Loading...', 16, 24, 'white', 'text');
    } else if (this.message) {
      surf.drawText(this.message, 16, 60, 'green', 'text');
    } else if (this.saving) {
      surf.drawText('Saving...', 16, 24, 'white', 'text');
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
  private mode: 'load' | 'restart' | null = null;
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
    // Title 'Load Game'/'Restart Level' (Python title_load / title_restart)
    // list only the save slots; the suspend is reached through 'Continue'.
    this.mode = (game.memory?.get?.('load_menu_mode') as 'load' | 'restart' | undefined) ?? null;
    game.memory?.delete?.('load_menu_mode');

    Promise.all([
      loadSaveSlots(gameNid, numSlots),
      hasSuspend(gameNid),
    ]).then(([slots, hasSusp]) => {
      this.slots = slots;
      this.hasSuspendSave = hasSusp && this.mode === null;
      this.buildMenu(slots, this.hasSuspendSave);
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

    if (this.messageTimer > 0) return undefined;

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
            this.message = `Load failed: ${getLastLoadError() ?? 'unknown save error'}`;
            this.messageTimer = 1500;
          }
        }).catch((err: any) => {
          console.error('LoadMenuState: load suspend failed', err);
          this.restoring = false;
          this.message = `Load failed: ${getLastLoadError() ?? 'unknown save error'}`;
          this.messageTimer = 1500;
        });
      } else {
        const slotIdx = parseInt(result.selected, 10);
        const restart = this.mode === 'restart';
        const slotKind = restart ? 'start' : (this.slots.find((slot) => slot.idx === slotIdx)?.kind ?? null);
        (restart ? loadRestart(game, slotIdx) : loadGame(game, slotIdx)).then(async (success: boolean) => {
          if (success) {
            game.currentSaveSlot = slotIdx;
            // Python removes the suspend whenever a slot is loaded.
            await deleteSuspend(game.db.getConstant('game_nid', 'default') as string);
            await resumeLoadedGame(game, slotKind);
            this.restoring = false;
          } else {
            this.restoring = false;
            this.message = `Load failed: ${getLastLoadError() ?? 'unknown save error'}`;
            this.messageTimer = 1500;
          }
        }).catch((err: any) => {
          console.error('LoadMenuState: load failed', err);
          this.restoring = false;
          this.message = `Load failed: ${getLastLoadError() ?? 'unknown save error'}`;
          this.messageTimer = 1500;
        });
      }
    }

    return undefined;
  }

  override update(): StateResult {
    if (this.messageTimer <= 0) return undefined;

    this.messageTimer -= getGame().frameDeltaMs ?? 16;
    if (this.messageTimer <= 0 && this.message.startsWith('Load failed')) {
      this.message = '';
    }
    return undefined;
  }

  override draw(surf: Surface): Surface {
    const w = viewport.width;
    const h = viewport.height;

    surf.fillRect(0, 0, w, h, 'rgba(0, 0, 0, 0.7)');
    surf.drawText('-- Load Game --', 16, 0, 'white', 'text');

    if (this.loading) {
      surf.drawText('Loading...', 16, 24, 'white', 'text');
    } else if (this.message) {
      surf.drawText(this.message, 16, 60, this.message.startsWith('Load failed') ? 'red' : 'green', 'text');
    } else if (this.restoring) {
      surf.drawText('Loading...', 16, 24, 'white', 'text');
    } else if (this.menu) {
      this.menu.draw(surf);
    }

    return surf;
  }
}


// ---------------------------------------------------------------------------
// Shared post-load resume (Python TitleLoadState.take_input)
// ---------------------------------------------------------------------------

/**
 * After a save has been restored, enter gameplay the way Python does:
 * a 'start' save (written at new game / between chapters) restarts
 * `_next_level_nid` from the beginning; any other kind resumes play.
 */
export async function resumeLoadedGame(game: any, kind: string | null | undefined): Promise<void> {
  if (kind === 'start') {
    const nextLevel: string | undefined = game.gameVars.get('_next_level_nid') ?? game.currentLevel?.nid;
    if (nextLevel && game.db.levels.has(nextLevel)) {
      game.cleanUpLevel();
      await game.loadLevel(nextLevel);
      game.state.clear();
      game.state.change('free');
      if (game.eventManager?.hasActiveEvents()) game.state.change('event');
      return;
    }
  }
  game.state.clear();
  game.state.change('free');
}

// ---------------------------------------------------------------------------
// TitleSaveState — between-chapter save prompt (Python title_save)
// ---------------------------------------------------------------------------

/**
 * Shown after a chapter ends unless the ending level set `_skip_save`.
 * SELECT on a slot writes a 'start' save for the upcoming chapter; BACK
 * proceeds without saving. The continuation that enters the next chapter
 * is handed over through game.memory['title_save_continue'].
 */
export class TitleSaveState extends State {
  name = 'title_save';
  override readonly showMap = false;
  override readonly inLevel = false;

  private menu: ChoiceMenu | null = null;
  private loading = true;
  private busy = false;
  private message = '';
  private messageTimer = 0;
  private bgImage: HTMLImageElement | null = null;

  override start(): StateResult {
    const game = getGame();
    this.loading = true;
    this.busy = false;
    this.message = '';
    this.messageTimer = 0;
    game.resources?.tryLoadImage?.('resources/panoramas/title_background.png')
      .then((img: HTMLImageElement | null) => { this.bgImage = img; })
      .catch(() => {});
    const gameNid = game.db.getConstant('game_nid', 'default') as string;
    const numSlots = Number(game.db.getConstant('num_save_slots', 3)) || 1;
    loadSaveSlots(gameNid, numSlots).then((slots) => {
      const options: MenuOption[] = slots.map((slot) => {
        const hasData = slot.name !== '--NO DATA--';
        return {
          label: hasData ? `${slot.name} - ${formatPlaytime(slot.playtime)}` : '--NO DATA--',
          value: String(slot.idx),
          enabled: true,
        };
      });
      this.menu = new ChoiceMenu(options, 16, 24);
      const recent = slots.reduce((best, slot) => (slot.realtime > (slots[best]?.realtime ?? -1) ? slot.idx : best), 0);
      this.menu.selectedIndex = Math.max(0, Math.min(recent, options.length - 1));
      this.loading = false;
    }).catch(() => {
      this.menu = new ChoiceMenu([{ label: '--NO DATA--', value: '0', enabled: true }], 16, 24);
      this.loading = false;
    });
    return undefined;
  }

  private proceed(): void {
    const game = getGame();
    const next = game.memory?.get?.('title_save_continue') as (() => void) | undefined;
    game.memory?.delete?.('title_save_continue');
    if (next) next();
    else game.state.back();
  }

  override takeInput(event: InputEvent | null): StateResult {
    if (!event || this.loading || this.busy || this.messageTimer > 0 || !this.menu) return undefined;
    const game = getGame();
    const result = this.menu.handleInput(event);
    if (result && 'back' in result) {
      // Python: BACK proceeds to the next level without saving.
      this.proceed();
    } else if (result && 'selected' in result) {
      const slot = parseInt(result.selected, 10);
      this.busy = true;
      saveGame(game, slot, 'start').then(() => {
        game.currentSaveSlot = slot;
        this.message = 'Saved.';
      }).catch((err: unknown) => {
        console.error('TitleSaveState: save failed', err);
        this.message = 'Save failed!';
      }).finally(() => {
        this.messageTimer = 900;
        this.busy = false;
      });
    }
    return undefined;
  }

  override update(): StateResult {
    if (this.messageTimer > 0) {
      this.messageTimer -= getGame().frameDeltaMs ?? 16;
      if (this.messageTimer <= 0) this.proceed();
    }
    return undefined;
  }

  override draw(surf: Surface): Surface {
    const w = viewport.width;
    const h = viewport.height;
    surf.fillRect(0, 0, w, h, 'rgb(9, 12, 24)');
    if (this.bgImage) {
      const bw = this.bgImage.naturalWidth || this.bgImage.width;
      const bh = this.bgImage.naturalHeight || this.bgImage.height;
      const scale = Math.max(w / Math.max(1, bw), h / Math.max(1, bh));
      const dw = bw * scale;
      const dh = bh * scale;
      const ps = surf.scale;
      surf.ctx.imageSmoothingEnabled = false;
      surf.ctx.drawImage(this.bgImage, 0, 0, bw, bh,
        Math.round(((w - dw) / 2) * ps), Math.round(((h - dh) / 2) * ps), Math.round(dw * ps), Math.round(dh * ps));
    }
    surf.drawText('Save your progress?', 16, 4, 'white', 'text');
    if (this.message) {
      surf.drawText(this.message, 16, 60, 'white', 'text');
    } else if (this.menu) {
      this.menu.draw(surf);
    }
    return surf;
  }
}
