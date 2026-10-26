/**
 * save-load-state.ts -- Python title_load / title_restart / title_save /
 * in_chapter_save screens (lt-maker/app/engine/title_screen.py).
 *
 * All of them show menus.ChapterSelect: one chapter_select_<mode colour>
 * plate per save slot with the slot's chapter name in the 'chapter' font,
 * cursor_dragon hands, and the title_background panorama behind. Load
 * screens slide in from the right; saving renames the chosen plate to the
 * level name, flickers it and writes the save after Python's 1250 ms pause.
 */

import { State, type StateResult } from '../state';
import type { Surface } from '../surface';
import type { InputEvent } from '../input';
import { WINHEIGHT, WINWIDTH } from '../constants';
import { Banner } from '../../ui/banner';
import { MenuBackground, MenuScene } from '../../ui/menu-chrome';
import { ChapterSelectMenu, chapterSelectFromSlots, preloadTitleMenuSprites, titleBackgroundNid } from '../../ui/title-menu';
import { autocursorImmediate } from './game-states';
import {
  saveGame,
  loadGame,
  loadRestart,
  loadSuspend,
  loadSaveSlots,
  getLastLoadError,
  hasSuspend,
  deleteSuspend,
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

const SLIDE_FROM = Math.floor(WINWIDTH * 1.5);

/** Index of the most recently written slot (Python max(realtime)). */
function mostRecent(slots: SaveSlot[]): number {
  return slots.reduce((best, slot, i) => (slot.realtime > (slots[best]?.realtime ?? -1) ? i : best), 0);
}

/**
 * Shared ChapterSelect save screen (TitleSaveState / in_chapter_save).
 * SELECT renames the slot to the level being saved and, after 1250 ms,
 * writes the save; BACK leaves without saving.
 */
abstract class ChapterSaveScreen extends State {
  override readonly showMap = false;
  override readonly inLevel = false;

  protected menu: ChapterSelectMenu | null = null;
  protected slots: SaveSlot[] = [];
  protected bg: MenuBackground | null = null;
  protected scene = new MenuScene();
  /** Slot metadata still loading (harness/test hook). */
  loading = true;
  protected waitTime = 0;
  protected elapsed = 0;
  protected leaveFlag = false;
  protected banner: Banner | null = null;

  protected abstract saveKind(): string;
  protected abstract saveName(): string;
  protected abstract leave(saved: boolean): void;

  override start(): StateResult {
    const game = getGame();
    this.loading = true;
    this.waitTime = 0;
    this.elapsed = 0;
    this.leaveFlag = false;
    this.banner = null;
    this.bg = new MenuBackground('title_background', game.resources, false);
    preloadTitleMenuSprites();
    const gameNid = game.db.getConstant('game_nid', 'default') as string;
    const numSlots = Number(game.db.getConstant('num_save_slots', 3)) || 1;
    loadSaveSlots(gameNid, numSlots).then((slots) => {
      this.slots = slots;
      this.menu = chapterSelectFromSlots(slots, game.db);
      this.menu.moveTo(mostRecent(slots));
      this.loading = false;
    }).catch(() => {
      this.slots = [];
      this.menu = new ChapterSelectMenu(['--NO DATA--'], ['green']);
      this.loading = false;
    });
    return undefined;
  }

  override takeInput(event: InputEvent | null): StateResult {
    if (!event || this.loading || this.waitTime > 0 || !this.menu) return undefined;
    const game = getGame();
    if (event === 'DOWN') {
      if (this.menu.moveDown()) game.audioManager?.playSfx?.('Select 6');
    } else if (event === 'UP') {
      if (this.menu.moveUp()) game.audioManager?.playSfx?.('Select 6');
    } else if (event === 'BACK') {
      game.audioManager?.playSfx?.('Select 4');
      this.leave(false);
    } else if (event === 'SELECT') {
      game.audioManager?.playSfx?.('Save');
      this.waitTime = this.elapsed || 1;
      this.menu.setText(this.menu.currentIndex, this.saveName());
      this.menu.setColor(this.menu.currentIndex, game.currentMode?.color ?? 'green');
    }
    return undefined;
  }

  override update(): StateResult {
    const game = getGame();
    const dt = game.frameDeltaMs ?? 16;
    this.elapsed += dt;
    this.menu?.update();
    this.bg?.update();
    if (this.banner && this.banner.update(dt)) {
      this.banner = null;
      this.leave(false);
    }
    if (this.waitTime && this.elapsed - this.waitTime > 1250 && !this.leaveFlag) {
      this.leaveFlag = true;
      const index = this.menu?.currentIndex ?? 0;
      const slot = this.slots[index]?.idx ?? index;
      // Python in_chapter_save saves every state except itself (the save
      // dict is built synchronously before the first await).
      const ownIndex = game.state.stack.lastIndexOf(this);
      if (ownIndex >= 0) game.state.stack.splice(ownIndex, 1);
      const saving = saveGame(game, slot, this.saveKind());
      if (ownIndex >= 0) game.state.stack.splice(ownIndex, 0, this);
      saving.then(() => {
        game.currentSaveSlot = slot;
        this.leave(true);
      }).catch((err: unknown) => {
        console.error(`${this.name}: save failed`, err);
        this.banner = new Banner('Save failed!', undefined, 1500);
      });
    }
    return undefined;
  }

  override draw(surf: Surface): Surface {
    if (this.bg) this.bg.draw(surf);
    else surf.fill(0, 0, 0);
    if (this.menu) {
      const s = this.scene.begin();
      const since = this.elapsed - this.waitTime;
      this.menu.draw(s, WINWIDTH / 2, WINHEIGHT / 2, { flicker: !!this.waitTime && since > 100 && since < 200 });
      this.scene.present(surf);
    }
    if (this.banner) this.banner.draw(surf);
    return surf;
  }
}

// ---------------------------------------------------------------------------
// SaveMenuState (Python in_chapter_save)
// ---------------------------------------------------------------------------

export class SaveMenuState extends ChapterSaveScreen {
  name = 'save_menu';

  protected saveKind(): string {
    return 'battle';
  }

  protected saveName(): string {
    const game = getGame();
    return game.gameVars?.get?.('_save_name') || game.currentLevel?.name || '';
  }

  protected leave(): void {
    getGame().state.back();
  }
}

// ---------------------------------------------------------------------------
// LoadMenuState (Python title_load / title_restart)
// ---------------------------------------------------------------------------

type LoadEntry = { kind: 'slot'; slot: SaveSlot } | { kind: 'suspend' };

export class LoadMenuState extends State {
  name = 'load_menu';
  override readonly showMap = false;
  override readonly inLevel = false;

  /** ChapterSelect over the save slots (plus the suspend outside the title). */
  menu: ChapterSelectMenu | null = null;
  private entries: LoadEntry[] = [];
  private bg: MenuBackground | null = null;
  private scene = new MenuScene();
  /** Slot metadata still loading (harness/test hook). */
  loading: boolean = true;
  restoring: boolean = false;
  private mode: 'load' | 'restart' | null = null;
  message: string = '';
  private banner: Banner | null = null;
  private phase: 'transition_in' | 'normal' | 'transition_out' = 'transition_in';
  private positionX = SLIDE_FROM;

  override start(): StateResult {
    this.loading = true;
    this.restoring = false;
    this.message = '';
    this.banner = null;
    this.phase = 'transition_in';
    this.positionX = SLIDE_FROM;

    const game = getGame();
    this.bg = new MenuBackground(titleBackgroundNid(), game.resources, false);
    preloadTitleMenuSprites();
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
      this.entries = slots.map((slot): LoadEntry => ({ kind: 'slot', slot }));
      const named = slots.map((slot) => ({ name: slot.name, displayName: slot.displayName, mode: slot.mode }));
      if (hasSusp && this.mode === null) {
        this.entries.unshift({ kind: 'suspend' });
        named.unshift({ name: 'Suspend', displayName: null, mode: null });
      }
      this.menu = chapterSelectFromSlots(named, game.db);
      this.menu.moveTo(mostRecent(slots) + (this.entries[0]?.kind === 'suspend' ? 1 : 0));
      this.loading = false;
    }).catch((err) => {
      console.error('LoadMenuState: failed to load slots', err);
      this.loading = false;
    });

    return undefined;
  }

  /** Select the entry for save slot `idx` (tests/harness). */
  selectSlot(idx: number): void {
    const at = this.entries.findIndex((entry) => entry.kind === 'slot' && entry.slot.idx === idx);
    if (at >= 0) this.menu?.moveTo(at);
  }

  private fail(): void {
    this.restoring = false;
    this.message = `Load failed: ${getLastLoadError() ?? 'unknown save error'}`;
    this.banner = new Banner(this.message, undefined, 1500);
  }

  override takeInput(event: InputEvent | null): StateResult {
    if (!event || !this.menu || this.loading || this.restoring) return undefined;
    if (this.phase !== 'normal') return undefined;
    const game = getGame();
    if (this.banner) {
      this.banner = null;
      return undefined;
    }

    if (event === 'DOWN') {
      if (this.menu.moveDown()) game.audioManager?.playSfx?.('Select 6');
    } else if (event === 'UP') {
      if (this.menu.moveUp()) game.audioManager?.playSfx?.('Select 6');
    } else if (event === 'BACK') {
      game.audioManager?.playSfx?.('Select 4');
      this.phase = 'transition_out';
    } else if (event === 'SELECT') {
      const entry = this.entries[this.menu.currentIndex];
      if (!entry) return undefined;
      if (entry.kind === 'suspend') {
        this.restoring = true;
        loadSuspend(game).then((success: boolean) => {
          this.restoring = false;
          if (success) {
            // Python GameState.load restores the saved state stack.
            if (game.state.getStackNames().length === 0) game.state.change('free');
            autocursorImmediate(game);
          } else {
            this.fail();
          }
        }).catch((err: any) => {
          console.error('LoadMenuState: load suspend failed', err);
          this.fail();
        });
        return undefined;
      }
      const slot = entry.slot;
      if (slot.name === '--NO DATA--') {
        game.audioManager?.playSfx?.('Error');
        return undefined;
      }
      game.audioManager?.playSfx?.('Save');
      this.restoring = true;
      const slotIdx = slot.idx;
      const restart = this.mode === 'restart';
      const slotKind = restart ? 'start' : (slot.kind ?? null);
      (restart ? loadRestart(game, slotIdx) : loadGame(game, slotIdx)).then(async (success: boolean) => {
        if (success) {
          game.currentSaveSlot = slotIdx;
          // Python removes the suspend whenever a slot is loaded.
          await deleteSuspend(game.db.getConstant('game_nid', 'default') as string);
          await resumeLoadedGame(game, slotKind);
          this.restoring = false;
        } else {
          this.fail();
        }
      }).catch((err: any) => {
        console.error('LoadMenuState: load failed', err);
        this.fail();
      });
    }

    return undefined;
  }

  override update(): StateResult {
    const game = getGame();
    this.menu?.update();
    this.bg?.update();
    if (this.banner && this.banner.update(game.frameDeltaMs ?? 16)) this.banner = null;
    if (this.phase === 'transition_in') {
      this.positionX -= 20;
      if (this.positionX <= WINWIDTH / 2) {
        this.positionX = WINWIDTH / 2;
        this.phase = 'normal';
      }
    } else if (this.phase === 'transition_out') {
      this.positionX += 20;
      if (this.positionX >= SLIDE_FROM) {
        this.positionX = SLIDE_FROM;
        this.phase = 'transition_in';
        game.state.back();
        return 'repeat';
      }
    }
    return undefined;
  }

  override draw(surf: Surface): Surface {
    if (this.bg) this.bg.draw(surf);
    else surf.fill(0, 0, 0);
    if (this.menu) {
      const s = this.scene.begin();
      this.menu.draw(s, this.positionX, WINHEIGHT / 2);
      this.scene.present(surf);
    }
    if (this.banner) this.banner.draw(surf);
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
      // Python start_level -> turn_change: free, player phase_change, events.
      game.state.clear();
      game.state.change('free');
      game.state.change('phase_change');
      if (game.eventManager?.hasActiveEvents()) game.state.change('event');
      return;
    }
  }
  // Python GameState.load restores the saved state stack (battle saves and
  // suspends resume where they were) and autocursors immediately.
  if (game.state.getStackNames().length === 0) game.state.change('free');
  autocursorImmediate(game);
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
export class TitleSaveState extends ChapterSaveScreen {
  name = 'title_save';
  private continuation: (() => void) | null = null;

  override start(): StateResult {
    const game = getGame();
    // Take the continuation out of game.memory before anything is saved:
    // memory is serialized with the save and a function cannot be cloned
    // into IndexedDB (the save used to fail with DataCloneError).
    this.continuation = (game.memory?.get?.('title_save_continue') as (() => void) | undefined) ?? null;
    game.memory?.delete?.('title_save_continue');
    return super.start();
  }

  protected saveKind(): string {
    return 'start';
  }

  protected saveName(): string {
    const game = getGame();
    const next = game.gameVars?.get?.('_next_level_nid');
    const level = next ? game.db.levels.get(next) : null;
    return game.gameVars?.get?.('_save_name') || level?.name || game.currentLevel?.name || '';
  }

  protected leave(): void {
    const game = getGame();
    const next = this.continuation;
    this.continuation = null;
    if (next) next();
    else game.state.back();
  }
}
