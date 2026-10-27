/**
 * settings-state.ts — Settings menu state for the Lex Talionis web engine.
 *
 * Ported from LT's app/engine/settings.py and settings_menu.py: a scrolling
 * default_background, two menu_bg_clear header tabs (Config / Controls), a
 * translucent menu_bg_base list of icon rows (settings_icons / buttons), and
 * a menu_bg_clear info banner with the translated `<option>_desc` text.
 */

import { State, type StateResult } from '../state';
import type { Surface } from '../surface';
import type { GameButton, InputEvent } from '../input';
import {
  KEY_BUTTONS,
  bindingLabel,
  buildKeyMap,
  keySettingName,
  resolveKeyBindings,
} from '../key-bindings';
import { Banner } from '../../ui/banner';
import { WINHEIGHT, WINWIDTH } from '../constants';
import { getSyncStore, type SyncKV } from '../../storage/storage';
import { isForkEngine } from '../engine-flavor';
import { setWindowDisplayProvider, skinnedSpriteName } from '../../ui/sprites';
import {
  MenuBackground,
  MenuCursor,
  MenuScene,
  ScrollArrow,
  ScrollBar,
  baseSurf,
  blitSprite,
  blitSub,
  blitText,
  blitTextCenter,
  getSprite,
  preloadSprites,
  textWidth,
} from '../../ui/menu-chrome';

// ============================================================================
// Lazy game reference (same pattern as prep-state.ts)
// ============================================================================

let _game: any = null;
export function setSettingsGameRef(g: any): void {
  _game = g;
}
function getGame(): any {
  if (!_game) throw new Error('Game reference not set for settings state');
  return _game;
}

declare const __LT_QA__: boolean;

/**
 * Settings pinned by the QA tools' fast mode (src/qa/), consulted before the
 * stored value. Null in player builds, where the check compiles away.
 */
export const qaSettingOverrides: Record<string, unknown> | null = __LT_QA__ ? {} : null;

// ============================================================================
// Setting definitions (Python settings.config)
// ============================================================================

type SettingKind = 'bool' | 'slider' | 'choice' | 'simple';

interface SettingDef {
  /** cf.SETTINGS key. */
  name: string;
  kind: SettingKind;
  /** Python option values, in Python order. */
  values: (string | number)[];
  /** Python config.base_config default. */
  defaultValue: string | number;
  /** Row of settings_icons.png (each icon is 16x16). */
  icon: number;
}

/** Bools are stored as Python's 0/1 (older web saves used 'OFF'/'ON'). */
const BOOL_VALUES = [0, 1];
const VOLUMES = [0, 0.01, 0.02, 0.03, 0.0625, 0.125, 0.25, 0.5, 1];
/**
 * EOtF's engine branched before upstream's non-linear volume curve and keeps
 * eleven linear steps, 0.0 to 1.0 by tenths.
 */
const FORK_VOLUMES = Array.from({ length: 11 }, (_, i) => i / 10);

/**
 * Python settings.config in order. `screen_size` is omitted: the browser
 * canvas always scales to the window.
 */
const CONFIG_SETTINGS: SettingDef[] = [
  { name: 'animation', kind: 'choice', values: ['Always', 'Your Turn', 'Combat Only', 'Never'], defaultValue: 'Always', icon: 0 },
  { name: 'display_fps', kind: 'bool', values: BOOL_VALUES, defaultValue: 0, icon: 2 },
  { name: 'battle_bg', kind: 'bool', values: BOOL_VALUES, defaultValue: 0, icon: 17 },
  { name: 'unit_speed', kind: 'slider', values: [165, 150, 135, 120, 105, 90, 75, 60, 45, 30, 15], defaultValue: 120, icon: 1 },
  { name: 'text_speed', kind: 'slider', values: [150, 112, 80, 64, 50, 32, 15, 8, 3, 0], defaultValue: 32, icon: 2 },
  { name: 'mouse', kind: 'bool', values: BOOL_VALUES, defaultValue: 1, icon: 19 },
  { name: 'show_terrain', kind: 'bool', values: BOOL_VALUES, defaultValue: 1, icon: 7 },
  { name: 'show_objective', kind: 'bool', values: BOOL_VALUES, defaultValue: 1, icon: 6 },
  { name: 'autocursor', kind: 'bool', values: BOOL_VALUES, defaultValue: 1, icon: 13 },
  { name: 'hp_map_team', kind: 'simple', values: ['All', 'Ally', 'Enemy'], defaultValue: 'All', icon: 10 },
  { name: 'hp_map_cull', kind: 'simple', values: ['None', 'Wounded', 'All'], defaultValue: 'All', icon: 10 },
  { name: 'music_volume', kind: 'slider', values: VOLUMES, defaultValue: 0.3, icon: 15 },
  { name: 'sound_volume', kind: 'slider', values: VOLUMES, defaultValue: 0.3, icon: 16 },
  { name: 'talk_boop', kind: 'bool', values: BOOL_VALUES, defaultValue: 1, icon: 16 },
  { name: 'show_bounds', kind: 'bool', values: BOOL_VALUES, defaultValue: 0, icon: 7 },
  { name: 'grid_opacity', kind: 'slider', values: [0, 25, 51, 76, 102, 127, 153, 178, 204, 229, 255], defaultValue: 0, icon: 7 },
  // EOtF fork only: the menu window skin (menu_bg_base1..4 etc.).
  { name: 'window_display', kind: 'slider', values: [1, 2, 3, 4], defaultValue: 1, icon: 17 },
  { name: 'autoend_turn', kind: 'bool', values: BOOL_VALUES, defaultValue: 1, icon: 14 },
  { name: 'confirm_end', kind: 'bool', values: BOOL_VALUES, defaultValue: 1, icon: 14 },
  { name: 'display_hints', kind: 'bool', values: BOOL_VALUES, defaultValue: 0, icon: 3 },
];

/** Settings the EOtF fork's menu leaves out (fixed at their config.py defaults). */
const FORK_HIDDEN_SETTINGS: Record<string, string | number> = {
  animation: 'Always',
  battle_bg: 0,
  display_hints: 0,
};

/**
 * The settings listed in the menu: the EOtF fork drops animation, battle_bg
 * and display_hints, adds window_display, and keeps linear volume steps;
 * upstream has no window_display.
 */
function menuSettings(): SettingDef[] {
  if (isForkEngine()) {
    return CONFIG_SETTINGS
      .filter((d) => !(d.name in FORK_HIDDEN_SETTINGS))
      .map((d) => (d.values === VOLUMES ? { ...d, values: FORK_VOLUMES } : d));
  }
  return CONFIG_SETTINGS.filter((d) => d.name !== 'window_display');
}

/** Python settings.controls: buttons.png sub-rects for each control icon. */
const CONTROL_ENTRIES: { name: string; button: GameButton; rect: [number, number, number, number] }[] = [
  { name: 'key_SELECT', button: 'SELECT', rect: [0, 66, 14, 13] },
  { name: 'key_BACK', button: 'BACK', rect: [0, 82, 14, 13] },
  { name: 'key_INFO', button: 'INFO', rect: [1, 149, 16, 9] },
  { name: 'key_AUX', button: 'AUX', rect: [1, 133, 16, 9] },
  { name: 'key_LEFT', button: 'LEFT', rect: [1, 4, 13, 12] },
  { name: 'key_RIGHT', button: 'RIGHT', rect: [1, 19, 13, 12] },
  { name: 'key_UP', button: 'UP', rect: [1, 50, 12, 13] },
  { name: 'key_DOWN', button: 'DOWN', rect: [1, 34, 12, 13] },
  { name: 'key_START', button: 'START', rect: [0, 165, 33, 9] },
];

/**
 * Web-only last Controls row: Python restores default keys only when
 * saves/config.ini is deleted, which a browser player cannot do.
 */
const RESTORE_DEFAULTS_ROW = 'Restore Defaults';

// ============================================================================
// Global settings store (Python cf.SETTINGS / saves/config.ini)
// ============================================================================

const SETTINGS_STORAGE_KEY = 'lt-web-settings';
let settingsCache: Record<string, unknown> | null = null;
let keyMapCache: Record<string, GameButton> | null = null;
let settingsCacheStore: SyncKV | null = null;

/** Settings live in the sync store (local, or Convex once signed in). */
function loadSettingsCache(): Record<string, unknown> {
  const store = getSyncStore();
  if (settingsCache && settingsCacheStore === store) return settingsCache;
  settingsCache = {};
  settingsCacheStore = store;
  keyMapCache = null;
  try {
    const raw = store.getItem(SETTINGS_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') settingsCache = parsed as Record<string, unknown>;
    }
  } catch {
    // Unavailable or corrupt storage falls back to the defaults.
  }
  return settingsCache;
}

/**
 * Current value of a config setting. Python keeps these in a global config
 * (not in the save), so they persist across reloads and new games; the web
 * used to keep them in gameVars, where most were never read and all reset.
 */
export function getSetting(name: string): any {
  // QA fast mode (dev/LT_QA builds only) pins presentation settings.
  if (__LT_QA__ && qaSettingOverrides && name in qaSettingOverrides) return qaSettingOverrides[name];
  // The EOtF fork has no menu entry for these, so a value chosen while
  // playing another project must not leak in (settings are shared).
  if (isForkEngine() && name in FORK_HIDDEN_SETTINGS) return FORK_HIDDEN_SETTINGS[name];
  const cache = loadSettingsCache();
  const def = CONFIG_SETTINGS.find((d) => d.name === name);
  if (name in cache) return def?.kind === 'bool' ? normalizeBool(cache[name]) : cache[name];
  return def ? def.defaultValue : undefined;
}

// The EOtF fork's window skin follows the live window_display setting.
setWindowDisplayProvider(() => getSetting('window_display'));

/** Python cf.SETTINGS bools are 0/1; accept the legacy 'ON'/'OFF' strings. */
function normalizeBool(value: unknown): number {
  if (value === 'OFF' || value === 'off' || value === false || value === 0 || value === '0') return 0;
  return value ? 1 : 0;
}

export function setSetting(name: string, value: unknown): void {
  const cache = loadSettingsCache();
  cache[name] = value;
  saveSettingsCache(cache);
}

/** Forget a stored setting so its default applies again. */
export function clearSetting(name: string): void {
  const cache = loadSettingsCache();
  if (!(name in cache)) return;
  delete cache[name];
  saveSettingsCache(cache);
}

function saveSettingsCache(cache: Record<string, unknown>): void {
  keyMapCache = null;
  try {
    getSyncStore().setItem(SETTINGS_STORAGE_KEY, JSON.stringify(cache));
  } catch {
    // Storage may be full or unavailable; keep the in-memory value.
  }
}

// ============================================================================
// Keyboard bindings (Python cf.SETTINGS['key_*'], InputManager.update_key_map)
// ============================================================================

/** The player's rebound keys (KeyboardEvent.code per button). */
function keyOverrides(): Partial<Record<GameButton, string>> {
  const cache = loadSettingsCache();
  const out: Partial<Record<GameButton, string>> = {};
  for (const button of KEY_BUTTONS) {
    const code = cache[keySettingName(button)];
    if (typeof code === 'string' && code) out[button] = code;
  }
  return out;
}

/** The live keyboard map the input layer reads (code -> button). */
export function currentKeyMap(): Record<string, GameButton> {
  loadSettingsCache();
  if (!keyMapCache) keyMapCache = buildKeyMap(keyOverrides());
  return keyMapCache;
}

/** Keys currently bound to `button`. */
export function keyBindingsFor(button: GameButton): string[] {
  return resolveKeyBindings(keyOverrides())[button];
}

/** Python `cf.SETTINGS[key_X] = key; update_key_map()`. */
export function setKeyBinding(button: GameButton, code: string): void {
  setSetting(keySettingName(button), code);
}

/** Back to the default keyboard map. */
export function restoreDefaultKeyBindings(): void {
  const cache = loadSettingsCache();
  for (const button of KEY_BUTTONS) delete cache[keySettingName(button)];
  saveSettingsCache(cache);
}

/**
 * Apply stored settings with engine-wide side effects (volumes) at boot.
 * Only values the player chose are applied; untouched volumes keep the web
 * shell's defaults.
 */
export function applyStoredSettings(game: any): void {
  const cache = loadSettingsCache();
  const music = cache.music_volume;
  const sound = cache.sound_volume;
  if (typeof music === 'number') game.audioManager?.setMusicVolume?.(music);
  if (typeof sound === 'number') game.audioManager?.setSfxVolume?.(sound);
}

/** Effective value shown in the menu: stored, else the live engine value. */
function currentValue(def: SettingDef): string | number {
  const cache = loadSettingsCache();
  if (def.name in cache) return def.kind === 'bool' ? normalizeBool(cache[def.name]) : cache[def.name] as string | number;
  const audio = _game?.audioManager;
  if (def.name === 'music_volume' && typeof audio?.getMusicVolume === 'function') return audio.getMusicVolume();
  if (def.name === 'sound_volume' && typeof audio?.getSfxVolume === 'function') return audio.getSfxVolume();
  return def.defaultValue;
}

function translate(text: string): string {
  return _game?.db?.translate?.(text) ?? text;
}

/** Python ConfigOption.display_name: translate(name).replace('_', ' ').capitalize(). */
function displayName(name: string): string {
  const text = translate(name).replace(/_/g, ' ');
  return text.charAt(0).toUpperCase() + text.slice(1).toLowerCase();
}

// ============================================================================
// Python menus.Simple scrolling (limit = (WINHEIGHT - 64) // 16)
// ============================================================================

const MENU_LIMIT = Math.max(2, Math.floor((WINHEIGHT - 64) / 16));
const OPTION_WIDTH = 224;
const OPTION_HEIGHT = 16;
const HEADER_WIDTH = 112;
const SLIDER_ANIM = [0, 0, 0, 0, 0, 0, 0, 1, 1, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 4, 4, 4, 3, 3, 2, 2, 2, 1, 1, 1, 1];

class SimpleList {
  currentIndex = 0;
  scroll = 0;
  takesInput = false;
  readonly cursor = new MenuCursor();
  readonly scrollBar = new ScrollBar();
  readonly count: number;

  constructor(count: number) {
    this.count = count;
  }

  /** Python Simple.move_down(first_push=True). */
  moveDown(): boolean {
    this.currentIndex += 1;
    if (this.currentIndex > this.count - 1) {
      this.currentIndex = 0;
      this.scroll = 0;
    } else if (this.currentIndex > this.scroll + MENU_LIMIT - 2 && this.scroll + MENU_LIMIT < this.count) {
      this.scroll += 1;
    } else {
      this.cursor.yOffsetDown();
    }
    if (MENU_LIMIT < this.count) this.scroll = Math.min(this.count - MENU_LIMIT, this.scroll);
    return true;
  }

  /** Python Simple.move_up(first_push=True). */
  moveUp(): boolean {
    this.currentIndex -= 1;
    if (this.currentIndex < 0) {
      this.currentIndex = this.count - 1;
      this.scroll = this.currentIndex - MENU_LIMIT + 1;
    } else if (this.currentIndex < this.scroll + 1) {
      this.scroll -= 1;
    } else {
      this.cursor.yOffsetUp();
    }
    this.scroll = Math.max(0, this.scroll);
    return true;
  }

  get menuHeight(): number {
    return Math.min(this.count, MENU_LIMIT) * OPTION_HEIGHT + 8;
  }

  /** Python Controls.draw topleft. */
  topleft(): [number, number] {
    return [Math.floor((WINWIDTH - OPTION_WIDTH) / 2), Math.floor((WINHEIGHT - this.menuHeight) / 2) + 8];
  }
}

// ============================================================================
// SettingsMenuState
// ============================================================================

type SettingsPhase = 'top_menu_left' | 'top_menu_right' | 'config' | 'controls' | 'get_input';

export class SettingsMenuState extends State {
  readonly name = 'settings_menu';
  override readonly inLevel = false;
  override readonly showMap = false;
  override readonly transparent = false;

  private phase: SettingsPhase = 'top_menu_left';
  private settings: SettingDef[] = menuSettings();
  private configMenu = new SimpleList(this.settings.length);
  private controlsMenu = new SimpleList(CONTROL_ENTRIES.length + 1);
  /** Python AlertState over the menu ('Invalid Choice!'). */
  private alert: Banner | null = null;
  private topCursor = new MenuCursor();
  private bg: MenuBackground | null = null;
  private scene = new MenuScene();
  /** SliderOption.counter, per row. */
  private sliderCounters: number[] = this.settings.map(() => 0);
  /** ChoiceOption side arrows (right arrow counter offset 0.5). */
  private choiceArrows: Map<string, [ScrollArrow, ScrollArrow]> = new Map();
  /**
   * Controls list window. EOtF's engine builds it with the skin current
   * when Settings opens and, unlike the Config list, never refreshes it.
   */
  private controlsBg = 'menu_bg_base';

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  override start(): StateResult {
    const game = getGame();
    this.phase = 'top_menu_left';
    this.settings = menuSettings();
    this.sliderCounters = this.settings.map(() => 0);
    this.configMenu = new SimpleList(this.settings.length);
    this.controlsMenu = new SimpleList(CONTROL_ENTRIES.length + 1);
    this.controlsBg = skinnedSpriteName('menu_bg_base');
    this.alert = null;
    this.topCursor = new MenuCursor();
    this.bg = new MenuBackground('settings_background', game.resources);
    preloadSprites(['settings_icons', 'buttons', 'scroll_bar', 'page_arrows', 'waiting_cursor', 'menus/health_bar_bg', 'menus/menu_hand']);
    baseSurf(HEADER_WIDTH, 24, 'menu_bg_clear');
    baseSurf(WINWIDTH + 16, 16, 'menu_bg_clear');
    for (const def of this.settings) {
      if (def.kind === 'choice') {
        this.choiceArrows.set(def.name, [new ScrollArrow('left', 0, 0, 0), new ScrollArrow('right', 0, 0, 0.5)]);
      }
    }
  }

  private get currentMenu(): SimpleList {
    return this.phase === 'top_menu_left' || this.phase === 'config' ? this.configMenu : this.controlsMenu;
  }

  // -----------------------------------------------------------------------
  // Option value changes (Python ConfigOption subclasses)
  // -----------------------------------------------------------------------

  private setValue(def: SettingDef, value: string | number): void {
    setSetting(def.name, value);
    if (def.name === 'music_volume' || def.name === 'sound_volume') this.updateSound();
  }

  private moveLeft(def: SettingDef): void {
    const value = currentValue(def);
    const idx = def.values.indexOf(value);
    if (def.kind === 'bool') {
      // BoolOption.move_left: turn on.
      if (!value) this.setValue(def, 1);
    } else if (def.kind === 'choice') {
      this.setValue(def, idx >= 0 ? def.values[(idx - 1 + def.values.length) % def.values.length] : def.values[0]);
      this.choiceArrows.get(def.name)?.[0].pulse();
    } else {
      this.setValue(def, idx >= 0 ? def.values[Math.max(0, idx - 1)] : def.values[0]);
    }
  }

  private moveRight(def: SettingDef): void {
    const value = currentValue(def);
    const idx = def.values.indexOf(value);
    if (def.kind === 'bool') {
      // BoolOption.move_right: turn off.
      if (value) this.setValue(def, 0);
    } else if (def.kind === 'choice') {
      this.setValue(def, idx >= 0 ? def.values[(idx + 1) % def.values.length] : def.values[def.values.length - 1]);
      this.choiceArrows.get(def.name)?.[1].pulse();
    } else {
      this.setValue(def, idx >= 0 ? def.values[Math.min(def.values.length - 1, idx + 1)] : def.values[def.values.length - 1]);
    }
  }

  private moveNext(def: SettingDef): void {
    const value = currentValue(def);
    if (def.kind === 'bool') {
      this.setValue(def, value ? 0 : 1);
      return;
    }
    const idx = def.values.indexOf(value);
    this.setValue(def, idx >= 0 ? def.values[(idx + 1) % def.values.length] : def.values[def.values.length - 1]);
  }

  private updateSound(): void {
    const game = getGame();
    const music = Number(getSetting('music_volume'));
    const sound = Number(getSetting('sound_volume'));
    game.audioManager?.setMusicVolume?.(music);
    game.audioManager?.setSfxVolume?.(sound);
  }

  // -----------------------------------------------------------------------
  // Input (Python SettingsMenuState.take_input)
  // -----------------------------------------------------------------------

  override takeInput(event: InputEvent): StateResult {
    const game = getGame();
    const sfx = (name: string): void => game.audioManager?.playSfx?.(name);
    if (this.alert) {
      // AlertState.take_input: any input once time_to_pause has passed.
      if (event && this.alert.canDismiss()) this.alert = null;
      return;
    }
    if (this.phase === 'get_input') {
      // Python change_keymap mode: a key already bound to a button arrives
      // as that button (BACK cancels, anything else is refused); an unbound
      // key arrives as 'NEW' and becomes the selected control's key.
      const captured: string | null = game.input?.takeCapturedKey?.() ?? null;
      if (event === 'BACK') {
        sfx('Select 4');
        this.endGetInput();
      } else if (captured) {
        sfx('Select 1');
        setKeyBinding(CONTROL_ENTRIES[this.controlsMenu.currentIndex].button, captured);
        this.endGetInput();
      } else if (event) {
        sfx('Select 4');
        this.endGetInput();
        this.alert = new Banner(translate('Invalid Choice!'));
      }
      return;
    }
    let effective = event;
    if (game.input?.mouseClick === 'SELECT' && !effective) effective = 'SELECT';
    if (!effective) return;

    if (this.phase === 'top_menu_left' || this.phase === 'top_menu_right') {
      if (effective === 'DOWN' || effective === 'SELECT') {
        sfx('Select 6');
        this.phase = this.phase === 'top_menu_left' ? 'config' : 'controls';
        this.currentMenu.takesInput = true;
      } else if (effective === 'LEFT') {
        if (this.phase === 'top_menu_right') {
          sfx('Select 6');
          this.phase = 'top_menu_left';
        }
      } else if (effective === 'RIGHT') {
        if (this.phase === 'top_menu_left') {
          sfx('Select 6');
          this.phase = 'top_menu_right';
        }
      } else if (effective === 'BACK') {
        this.back();
      }
      return;
    }

    const menu = this.currentMenu;
    if (effective === 'DOWN') {
      if (menu.moveDown()) sfx('Select 6');
    } else if (effective === 'UP') {
      if (menu.currentIndex <= 0) {
        menu.takesInput = false;
        this.phase = this.phase === 'config' ? 'top_menu_left' : 'top_menu_right';
        sfx('Select 6');
      } else if (menu.moveUp()) {
        sfx('Select 6');
      }
    } else if (effective === 'LEFT' || effective === 'RIGHT') {
      if (this.phase === 'config') {
        const def = this.settings[menu.currentIndex];
        if (effective === 'LEFT') this.moveLeft(def);
        else this.moveRight(def);
        sfx('Select 6');
      }
    } else if (effective === 'BACK') {
      this.back();
    } else if (effective === 'SELECT') {
      if (this.phase === 'config') {
        sfx('Select 6');
        this.moveNext(this.settings[menu.currentIndex]);
      } else if (menu.currentIndex >= CONTROL_ENTRIES.length) {
        sfx('Select 1');
        restoreDefaultKeyBindings();
      } else {
        sfx('Select 1');
        this.phase = 'get_input';
        game.input?.beginKeyCapture?.();
      }
    }
  }

  private endGetInput(): void {
    this.phase = 'controls';
    getGame().input?.endKeyCapture?.();
  }

  override finish(): void {
    // Just to make sure (Python SettingsMenuState.finish).
    _game?.input?.endKeyCapture?.();
  }

  private back(): void {
    const game = getGame();
    game.audioManager?.playSfx?.('Select 4');
    game.state.back();
  }

  override update(): StateResult {
    const menu = this.currentMenu;
    menu.cursor.update();
    this.topCursor.update();
    this.bg?.update();
    if (this.alert?.update(getGame().frameDeltaMs ?? 16)) this.alert = null;
  }

  // -----------------------------------------------------------------------
  // Rendering (Python SettingsMenuState.draw)
  // -----------------------------------------------------------------------

  override draw(surf: Surface): Surface {
    if (this.bg) this.bg.draw(surf);
    else surf.fill(0, 0, 0);

    const scene = this.scene.begin();
    this.drawTopMenu(scene);
    if (this.currentMenu === this.configMenu) this.drawConfig(scene);
    else this.drawControls(scene);
    this.drawInfoBanner(scene);
    this.alert?.draw(scene);
    this.scene.present(surf);
    return surf;
  }

  private drawTopMenu(surf: Surface): void {
    const bg = baseSurf(HEADER_WIDTH, 24, 'menu_bg_clear');
    const offset = Math.floor((WINWIDTH / 2 - HEADER_WIDTH) / 2);
    surf.blit(bg, offset, 4);
    surf.blit(bg, WINWIDTH / 2 + offset, 4);
    const onConfig = this.currentMenu === this.configMenu;
    const top = this.phase === 'top_menu_left' || this.phase === 'top_menu_right';
    blitTextCenter(surf, onConfig ? 'text-yellow' : 'text-grey', 'Config', offset + HEADER_WIDTH / 2, 8);
    blitTextCenter(surf, onConfig ? 'text-grey' : 'text-yellow', 'Controls', WINWIDTH / 2 + offset + HEADER_WIDTH / 2, 8);
    if (top) {
      if (onConfig) this.topCursor.draw(surf, HEADER_WIDTH / 2 - 16, 8);
      else this.topCursor.draw(surf, WINWIDTH / 2 + 2 + HEADER_WIDTH / 2 - 16, 8);
    }
  }

  /** Controls.draw / Config.draw background, scroll bar, and rows. */
  private drawMenuFrame(surf: Surface, menu: SimpleList, bgName = 'menu_bg_base'): [number, number] {
    const [tx, ty] = menu.topleft();
    const bg = baseSurf(OPTION_WIDTH - (OPTION_WIDTH % 8), menu.menuHeight, bgName);
    const alpha = bg.getAlpha();
    bg.setAlpha(0.9); // image_mods.make_translucent(bg, .1)
    surf.blit(bg, tx, ty);
    bg.setAlpha(alpha);
    if (menu.count > MENU_LIMIT) {
      menu.scrollBar.draw(surf, tx + OPTION_WIDTH - (OPTION_WIDTH % 8), ty, menu.scroll, MENU_LIMIT, menu.count);
    }
    return [tx, ty];
  }

  private drawConfig(surf: Surface): void {
    const menu = this.configMenu;
    const [tx, ty] = this.drawMenuFrame(surf, menu);
    const icons = getSprite('settings_icons');
    const end = Math.min(menu.count, menu.scroll + MENU_LIMIT);
    for (let i = menu.scroll; i < end; i++) {
      const def = this.settings[i];
      const top = ty + 4 + (i - menu.scroll) * OPTION_HEIGHT;
      const left = tx - 4;
      const active = i === menu.currentIndex && menu.takesInput;
      blitSub(surf, icons, 0, def.icon * 16, 16, 16, left + 16, top);
      blitText(surf, 'text', displayName(def.name), left + 32, top);
      const value = currentValue(def);
      switch (def.kind) {
        case 'bool': this.drawBool(surf, left, top, !!value); break;
        case 'slider': this.drawSlider(surf, i, def, left, top, value, active); break;
        case 'choice': this.drawChoice(surf, def, left, top, value); break;
        case 'simple': this.drawSimple(surf, def, left, top, value); break;
      }
      if (active) menu.cursor.draw(surf, left + 8, top);
    }
  }

  /** BoolOption.draw */
  private drawBool(surf: Surface, x: number, y: number, on: boolean): void {
    const onFont = on ? 'text-blue' : 'text-grey';
    const offFont = on ? 'text-grey' : 'text-blue';
    const onStr = `${translate('ON')}    `;
    blitText(surf, onFont, onStr, x + 112, y);
    blitText(surf, offFont, translate('OFF'), x + 112 + textWidth(onFont, onStr), y);
  }

  /** SliderOption.draw */
  private drawSlider(
    surf: Surface, idx: number, def: SettingDef, x: number, y: number, value: string | number, active: boolean,
  ): void {
    this.sliderCounters[idx] = (this.sliderCounters[idx] + 1) % SLIDER_ANIM.length;
    const bar = getSprite('menus/health_bar_bg');
    if (!bar) return;
    blitSprite(surf, bar, x + 112, y + 4);
    const cursor = getSprite('waiting_cursor');
    if (!cursor) return;
    const values = def.values as number[];
    const vidx = values.indexOf(value as number);
    // Python's fallback for an off-list value keeps its operator precedence:
    // value - values[0] / (values[-1] - values[0]).
    const fraction = vidx >= 0
      ? vidx / (values.length - 1)
      : Number(value) - values[0] / (values[values.length - 1] - values[0]);
    const offset = fraction * (bar.width - 6);
    const bop = active ? Math.floor(SLIDER_ANIM[this.sliderCounters[idx]] / 2) - 1 : 0;
    blitSprite(surf, cursor, Math.floor(x + 112 + offset), y + 4 + bop);
  }

  /** ChoiceOption.draw */
  private drawChoice(surf: Surface, def: SettingDef, x: number, y: number, value: string | number): void {
    blitTextCenter(surf, 'text-blue', translate(String(value)), x + 164, y);
    const arrows = this.choiceArrows.get(def.name);
    if (!arrows) return;
    const [leftArrow, rightArrow] = arrows;
    leftArrow.x = x + 112;
    rightArrow.x = x + 216 - 8;
    leftArrow.y = rightArrow.y = y;
    leftArrow.draw(surf);
    rightArrow.draw(surf);
  }

  /** SimpleOption.draw */
  private drawSimple(surf: Surface, def: SettingDef, x: number, y: number, value: string | number): void {
    let running = 0;
    for (const choice of def.values) {
      const font = String(choice) === String(value) ? 'text-blue' : 'text-grey';
      const text = `${translate(String(choice))}    `;
      blitText(surf, font, text, x + 112 + running, y);
      running += textWidth(font, text);
    }
  }

  /** Controls.draw + ControlOption.draw */
  private drawControls(surf: Surface): void {
    const menu = this.controlsMenu;
    const [tx, ty] = this.drawMenuFrame(surf, menu, this.controlsBg);
    const buttons = getSprite('buttons');
    const end = Math.min(menu.count, menu.scroll + MENU_LIMIT);
    for (let i = menu.scroll; i < end; i++) {
      const entry = CONTROL_ENTRIES[i];
      const top = ty + 4 + (i - menu.scroll) * OPTION_HEIGHT;
      const left = tx - 4;
      const active = i === menu.currentIndex && menu.takesInput;
      if (!entry) {
        blitText(surf, 'text', translate(RESTORE_DEFAULTS_ROW), left + 56, top);
      } else {
        // ControlOption.draw: the row being rebound turns yellow.
        const listening = active && this.phase === 'get_input';
        const [sx, sy, sw, sh] = entry.rect;
        blitSub(surf, buttons, sx, sy, sw, sh, left + 32 - Math.floor(sw / 2), top + 8 - Math.floor(sh / 2));
        blitText(surf, listening ? 'text-yellow' : 'text', translate(entry.name), left + 56, top);
        blitText(surf, listening ? 'text-yellow' : 'text-blue', bindingLabel(keyBindingsFor(entry.button)), left + 128, top);
      }
      if (active) menu.cursor.draw(surf, left + 8, top);
    }
  }

  /** SettingsMenuState.draw_info_banner */
  private drawInfoBanner(surf: Surface): void {
    const height = 16;
    surf.blit(baseSurf(WINWIDTH + 16, height, 'menu_bg_clear'), -8, WINHEIGHT - height);
    let text: string;
    if (this.phase === 'top_menu_left') text = 'config_desc';
    else if (this.phase === 'config') text = `${this.settings[this.configMenu.currentIndex].name}_desc`;
    else if (this.phase === 'get_input') text = 'get_input_desc';
    else text = 'keymap_desc'; // Python's top_menu_right branch is unreachable
    blitTextCenter(surf, 'text', translate(text), WINWIDTH / 2, WINHEIGHT - height);
  }
}
