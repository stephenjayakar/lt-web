/**
 * settings-state.ts — Settings menu state for the Lex Talionis web engine.
 *
 * Ported from LT's app/engine/settings.py and settings_menu.py.
 * Provides Config and Controls tabs with various game options
 * (animation speed, volume, display preferences, key bindings).
 */

import { State, type StateResult } from '../state';
import type { Surface } from '../surface';
import type { InputEvent } from '../input';
import { viewport } from '../viewport';

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

// ============================================================================
// Setting definitions
// ============================================================================

interface SettingDef {
  name: string;          // Setting key (stored as `_setting_{name}` in gameVars)
  label: string;         // Display label
  type: 'bool' | 'slider' | 'choice';
  values: (string | number)[];  // Possible values
  defaultIndex: number;  // Default index into values
  description: string;   // Bottom info bar text
}

const CONFIG_SETTINGS: SettingDef[] = [
  {
    name: 'animation',
    label: 'Animation',
    type: 'choice',
    values: ['Always', 'Your Turn', 'Combat Only', 'Never'],
    defaultIndex: 0,
    description: 'When to play battle animations.',
  },
  {
    name: 'unit_speed',
    label: 'Unit Speed',
    type: 'slider',
    values: [15, 30, 45, 60, 75, 90, 105, 120, 135, 150, 165],
    defaultIndex: 7, // 120
    description: 'Movement speed for units on the map.',
  },
  {
    name: 'text_speed',
    label: 'Text Speed',
    type: 'slider',
    values: [0, 3, 8, 15, 32, 50, 64, 80, 112, 150],
    defaultIndex: 4, // 32
    description: 'Speed of dialog text display.',
  },
  {
    name: 'music_volume',
    label: 'Music Vol',
    type: 'slider',
    values: [0, 0.01, 0.02, 0.03, 0.0625, 0.125, 0.25, 0.5, 1],
    defaultIndex: 6, // 0.25 (~0.3)
    description: 'Background music volume.',
  },
  {
    name: 'sound_volume',
    label: 'Sound Vol',
    type: 'slider',
    values: [0, 0.01, 0.02, 0.03, 0.0625, 0.125, 0.25, 0.5, 1],
    defaultIndex: 6, // 0.25 (~0.3)
    description: 'Sound effects volume.',
  },
  {
    name: 'show_terrain',
    label: 'Show Terrain',
    type: 'bool',
    values: ['OFF', 'ON'],
    defaultIndex: 1, // on
    description: 'Display terrain info window.',
  },
  {
    name: 'show_objective',
    label: 'Show Objective',
    type: 'bool',
    values: ['OFF', 'ON'],
    defaultIndex: 1, // on
    description: 'Display objective info window.',
  },
  {
    name: 'autocursor',
    label: 'Autocursor',
    type: 'bool',
    values: ['OFF', 'ON'],
    defaultIndex: 1, // on
    description: 'Snap cursor to active unit at turn start.',
  },
  {
    name: 'autoend_turn',
    label: 'Autoend Turn',
    type: 'bool',
    values: ['OFF', 'ON'],
    defaultIndex: 1, // on
    description: 'Automatically end turn when all units have acted.',
  },
  {
    name: 'confirm_end',
    label: 'Confirm End',
    type: 'bool',
    values: ['OFF', 'ON'],
    defaultIndex: 1, // on
    description: 'Ask for confirmation before ending your turn.',
  },
  {
    name: 'grid_opacity',
    label: 'Grid Opacity',
    type: 'slider',
    values: [0, 25, 51, 76, 102, 127, 153, 178, 204, 229, 255],
    defaultIndex: 0, // 0 (off)
    description: 'Opacity of the tile grid overlay.',
  },
  {
    name: 'hp_map_team',
    label: 'HP Map Team',
    type: 'choice',
    values: ['All', 'Ally', 'Enemy'],
    defaultIndex: 0, // All
    description: 'Which teams show HP bars on the map.',
  },
  {
    name: 'hp_map_cull',
    label: 'HP Map Cull',
    type: 'choice',
    values: ['None', 'Wounded', 'All'],
    defaultIndex: 0, // None
    description: 'When to hide map HP bars.',
  },
  {
    name: 'display_fps',
    label: 'Display FPS',
    type: 'bool',
    values: ['OFF', 'ON'],
    defaultIndex: 0, // off
    description: 'Show frames per second counter.',
  },
];

/** Remappable control names and their default key labels. */
const CONTROL_ENTRIES: { name: string; label: string; defaultKey: string }[] = [
  { name: 'SELECT',  label: 'Select',  defaultKey: 'Z / Enter' },
  { name: 'BACK',    label: 'Back',    defaultKey: 'X / Esc' },
  { name: 'INFO',    label: 'Info',    defaultKey: 'C / Shift' },
  { name: 'AUX',     label: 'Aux',     defaultKey: 'V / Tab' },
  { name: 'LEFT',    label: 'Left',    defaultKey: 'Arrow Left / A' },
  { name: 'RIGHT',   label: 'Right',   defaultKey: 'Arrow Right / D' },
  { name: 'UP',      label: 'Up',      defaultKey: 'Arrow Up / W' },
  { name: 'DOWN',    label: 'Down',    defaultKey: 'Arrow Down / S' },
  { name: 'START',   label: 'Start',   defaultKey: 'Space' },
];

// ============================================================================
// Rendering constants
// ============================================================================

const TAB_HEIGHT = 16;
const ROW_HEIGHT = 16;
const VISIBLE_ROWS = 6;
const LIST_Y = TAB_HEIGHT + 4;
const INFO_BAR_HEIGHT = 16;
const LABEL_X = 8;
const VALUE_X_RIGHT_MARGIN = 8; // from right edge
const SLIDER_WIDTH = 48;
const SLIDER_HEIGHT = 4;

// Colors
const COLOR_BG = 'rgba(20,20,40,1)';
const COLOR_TAB_ACTIVE = 'rgba(255,220,100,1)';
const COLOR_TAB_INACTIVE = 'rgba(120,120,140,1)';
const COLOR_TAB_BG_ACTIVE = 'rgba(40,40,80,1)';
const COLOR_TAB_BG_INACTIVE = 'rgba(24,24,48,1)';
const COLOR_ROW_HIGHLIGHT = 'rgba(48,48,128,0.6)';
const COLOR_LABEL = 'rgba(220,220,240,1)';
const COLOR_VALUE_ON = 'rgba(100,160,255,1)';
const COLOR_VALUE_OFF = 'rgba(120,120,140,1)';
const COLOR_VALUE_TEXT = 'rgba(255,255,255,1)';
const COLOR_ARROW = 'rgba(180,180,220,0.8)';
const COLOR_SLIDER_BG = 'rgba(60,60,100,1)';
const COLOR_SLIDER_FILL = 'rgba(100,160,255,1)';
const COLOR_SLIDER_CURSOR = 'rgba(255,255,255,1)';
const COLOR_INFO_BG = 'rgba(16,16,48,0.9)';
const COLOR_INFO_TEXT = 'rgba(180,180,220,1)';
const COLOR_SCROLL_IND = 'rgba(180,180,220,0.5)';
const COLOR_CONTROLS_KEY = 'rgba(180,200,255,1)';

// ============================================================================
// SettingsMenuState
// ============================================================================

type SettingsTab = 'config' | 'controls';
type SettingsPhase = 'top_config' | 'top_controls' | 'config' | 'controls';

export class SettingsMenuState extends State {
  readonly name = 'settings_menu';
  override readonly inLevel = false;
  override readonly showMap = false;
  override readonly transparent = false;

  private phase: SettingsPhase = 'top_config';
  private configCursor: number = 0;
  private configScroll: number = 0;
  private controlsCursor: number = 0;
  private controlsScroll: number = 0;
  /** Current value index for each config setting. */
  private configValues: number[] = [];

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  override start(): StateResult {
    this.phase = 'top_config';
    this.configCursor = 0;
    this.configScroll = 0;
    this.controlsCursor = 0;
    this.controlsScroll = 0;
    this.loadSettings();
  }

  override begin(): StateResult {
    this.loadSettings();
  }

  // -----------------------------------------------------------------------
  // Settings persistence
  // -----------------------------------------------------------------------

  /** Load current values from game.gameVars or use defaults. */
  private loadSettings(): void {
    const game = getGame();
    this.configValues = CONFIG_SETTINGS.map((def) => {
      const key = `_setting_${def.name}`;
      const stored = game.gameVars.get(key);
      if (stored !== undefined) {
        // Find the index of the stored value
        const idx = def.values.indexOf(stored);
        if (idx >= 0) return idx;
        // For numeric sliders, find closest
        if (def.type === 'slider' && typeof stored === 'number') {
          let bestIdx = 0;
          let bestDist = Math.abs((def.values[0] as number) - stored);
          for (let i = 1; i < def.values.length; i++) {
            const dist = Math.abs((def.values[i] as number) - stored);
            if (dist < bestDist) {
              bestDist = dist;
              bestIdx = i;
            }
          }
          return bestIdx;
        }
      }
      return def.defaultIndex;
    });
  }

  /** Save all settings to game.gameVars. */
  private saveSettings(): void {
    const game = getGame();
    for (let i = 0; i < CONFIG_SETTINGS.length; i++) {
      const def = CONFIG_SETTINGS[i];
      const val = def.values[this.configValues[i]];
      game.gameVars.set(`_setting_${def.name}`, val);
    }
  }

  /** Apply immediate side effects for a setting change. */
  private applyImmediate(settingIndex: number): void {
    const game = getGame();
    const def = CONFIG_SETTINGS[settingIndex];
    const val = def.values[this.configValues[settingIndex]];

    if (def.name === 'music_volume' && typeof val === 'number') {
      if (game.audioManager && typeof game.audioManager.setMusicVolume === 'function') {
        game.audioManager.setMusicVolume(val);
      }
      game.gameVars.set('_setting_music_volume', val);
    } else if (def.name === 'sound_volume' && typeof val === 'number') {
      if (game.audioManager && typeof game.audioManager.setSfxVolume === 'function') {
        game.audioManager.setSfxVolume(val);
      }
      game.gameVars.set('_setting_sound_volume', val);
    }
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  private get activeTab(): SettingsTab {
    if (this.phase === 'top_controls' || this.phase === 'controls') return 'controls';
    return 'config';
  }

  private cycleValue(settingIndex: number, delta: number): void {
    const def = CONFIG_SETTINGS[settingIndex];
    const len = def.values.length;
    this.configValues[settingIndex] = (this.configValues[settingIndex] + delta + len) % len;
    this.applyImmediate(settingIndex);
  }

  // -----------------------------------------------------------------------
  // Input
  // -----------------------------------------------------------------------

  override takeInput(event: InputEvent): StateResult {
    const game = getGame();

    // Accept mouse click as SELECT
    let effective = event;
    if (game.input?.mouseClick === 'SELECT' && !effective) {
      effective = 'SELECT';
    }

    if (!effective) return;

    switch (this.phase) {
      case 'top_config':
      case 'top_controls':
        this.handleTopInput(effective);
        break;
      case 'config':
        this.handleConfigInput(effective);
        break;
      case 'controls':
        this.handleControlsInput(effective);
        break;
    }
  }

  private handleTopInput(event: InputEvent): void {
    const game = getGame();

    if (event === 'LEFT' || event === 'RIGHT') {
      // Switch between tabs
      this.phase = this.phase === 'top_config' ? 'top_controls' : 'top_config';
    } else if (event === 'DOWN' || event === 'SELECT') {
      // Enter the active tab's list
      if (this.activeTab === 'config') {
        this.phase = 'config';
      } else {
        this.phase = 'controls';
      }
    } else if (event === 'BACK') {
      this.saveSettings();
      game.state.back();
    }
  }

  private handleConfigInput(event: InputEvent): void {
    const game = getGame();

    if (event === 'UP') {
      if (this.configCursor === 0) {
        // Return to top tab bar
        this.phase = 'top_config';
      } else {
        this.configCursor--;
        if (this.configCursor < this.configScroll) {
          this.configScroll = this.configCursor;
        }
      }
    } else if (event === 'DOWN') {
      if (this.configCursor < CONFIG_SETTINGS.length - 1) {
        this.configCursor++;
        if (this.configCursor >= this.configScroll + VISIBLE_ROWS) {
          this.configScroll = this.configCursor - VISIBLE_ROWS + 1;
        }
      }
    } else if (event === 'LEFT') {
      this.cycleValue(this.configCursor, -1);
    } else if (event === 'RIGHT') {
      this.cycleValue(this.configCursor, 1);
    } else if (event === 'SELECT') {
      // Cycle to next value
      this.cycleValue(this.configCursor, 1);
    } else if (event === 'BACK') {
      this.saveSettings();
      game.state.back();
    }
  }

  private handleControlsInput(event: InputEvent): void {
    const game = getGame();

    if (event === 'UP') {
      if (this.controlsCursor === 0) {
        this.phase = 'top_controls';
      } else {
        this.controlsCursor--;
        if (this.controlsCursor < this.controlsScroll) {
          this.controlsScroll = this.controlsCursor;
        }
      }
    } else if (event === 'DOWN') {
      if (this.controlsCursor < CONTROL_ENTRIES.length - 1) {
        this.controlsCursor++;
        if (this.controlsCursor >= this.controlsScroll + VISIBLE_ROWS) {
          this.controlsScroll = this.controlsCursor - VISIBLE_ROWS + 1;
        }
      }
    } else if (event === 'BACK') {
      this.saveSettings();
      game.state.back();
    }
  }

  // -----------------------------------------------------------------------
  // Rendering
  // -----------------------------------------------------------------------

  override draw(surf: Surface): Surface {
    const vw = viewport.width;
    const vh = viewport.height;

    // 1. Background
    surf.fill(20, 20, 40);

    // 2. Tab headers
    this.drawTabs(surf, vw);

    // 3. Option list for active tab
    if (this.activeTab === 'config') {
      this.drawConfigList(surf, vw, vh);
    } else {
      this.drawControlsList(surf, vw, vh);
    }

    // 4. Info bar at bottom
    this.drawInfoBar(surf, vw, vh);

    return surf;
  }

  private drawTabs(surf: Surface, vw: number): void {
    const halfW = Math.floor(vw / 2);
    const isTopPhase = this.phase === 'top_config' || this.phase === 'top_controls';

    // Config tab
    const configActive = this.activeTab === 'config';
    const configBg = configActive ? COLOR_TAB_BG_ACTIVE : COLOR_TAB_BG_INACTIVE;
    surf.fillRect(0, 0, halfW, TAB_HEIGHT, configBg);
    if (isTopPhase && configActive) {
      // Draw selection border
      surf.drawRect(0, 0, halfW, TAB_HEIGHT, COLOR_TAB_ACTIVE);
    }
    const configColor = configActive ? COLOR_TAB_ACTIVE : COLOR_TAB_INACTIVE;
    surf.drawText('Config', halfW / 2 - 15, 4, configColor, '8px monospace');

    // Controls tab
    const controlsActive = this.activeTab === 'controls';
    const controlsBg = controlsActive ? COLOR_TAB_BG_ACTIVE : COLOR_TAB_BG_INACTIVE;
    surf.fillRect(halfW, 0, vw - halfW, TAB_HEIGHT, controlsBg);
    if (isTopPhase && controlsActive) {
      surf.drawRect(halfW, 0, vw - halfW, TAB_HEIGHT, COLOR_TAB_ACTIVE);
    }
    const controlsColor = controlsActive ? COLOR_TAB_ACTIVE : COLOR_TAB_INACTIVE;
    surf.drawText('Controls', halfW + (vw - halfW) / 2 - 20, 4, controlsColor, '8px monospace');

    // Divider line under tabs
    surf.fillRect(0, TAB_HEIGHT, vw, 1, 'rgba(80,80,140,0.5)');
  }

  private drawConfigList(surf: Surface, vw: number, vh: number): void {
    const inList = this.phase === 'config';
    const visibleEnd = Math.min(CONFIG_SETTINGS.length, this.configScroll + VISIBLE_ROWS);

    for (let i = this.configScroll; i < visibleEnd; i++) {
      const def = CONFIG_SETTINGS[i];
      const rowIdx = i - this.configScroll;
      const y = LIST_Y + rowIdx * ROW_HEIGHT;

      // Highlight bar on selected row
      if (inList && i === this.configCursor) {
        surf.fillRect(2, y, vw - 4, ROW_HEIGHT - 1, COLOR_ROW_HIGHLIGHT);
      }

      // Label
      surf.drawText(def.label, LABEL_X, y + 3, COLOR_LABEL, '7px monospace');

      // Value display on the right side
      const valueIdx = this.configValues[i];
      const val = def.values[valueIdx];
      const rightX = vw - VALUE_X_RIGHT_MARGIN;

      switch (def.type) {
        case 'bool':
          this.drawBoolValue(surf, rightX, y + 3, valueIdx === 1);
          break;
        case 'slider':
          this.drawSliderValue(surf, rightX, y + 3, valueIdx, def.values.length);
          break;
        case 'choice':
          this.drawChoiceValue(surf, rightX, y + 3, String(val));
          break;
      }
    }

    // Scroll indicators
    if (this.configScroll > 0) {
      surf.drawText('^', Math.floor(vw / 2), LIST_Y - 4, COLOR_SCROLL_IND, '6px monospace');
    }
    if (visibleEnd < CONFIG_SETTINGS.length) {
      const bottomY = LIST_Y + VISIBLE_ROWS * ROW_HEIGHT;
      surf.drawText('v', Math.floor(vw / 2), bottomY, COLOR_SCROLL_IND, '6px monospace');
    }
  }

  private drawBoolValue(surf: Surface, rightX: number, y: number, isOn: boolean): void {
    if (isOn) {
      surf.drawText('ON', rightX - 14, y, COLOR_VALUE_ON, '7px monospace');
    } else {
      surf.drawText('OFF', rightX - 18, y, COLOR_VALUE_OFF, '7px monospace');
    }
  }

  private drawSliderValue(surf: Surface, rightX: number, y: number, index: number, total: number): void {
    const sliderX = rightX - SLIDER_WIDTH;
    const sliderY = y + 3;
    const fraction = total > 1 ? index / (total - 1) : 0;
    const fillW = Math.round(SLIDER_WIDTH * fraction);

    // Background track
    surf.fillRect(sliderX, sliderY, SLIDER_WIDTH, SLIDER_HEIGHT, COLOR_SLIDER_BG);
    // Filled portion
    if (fillW > 0) {
      surf.fillRect(sliderX, sliderY, fillW, SLIDER_HEIGHT, COLOR_SLIDER_FILL);
    }
    // Cursor pip
    const pipX = sliderX + fillW - 1;
    surf.fillRect(Math.max(sliderX, pipX), sliderY - 1, 3, SLIDER_HEIGHT + 2, COLOR_SLIDER_CURSOR);
  }

  private drawChoiceValue(surf: Surface, rightX: number, y: number, text: string): void {
    const textW = text.length * 5; // approximate width for 7px monospace
    const textX = rightX - textW - 12;

    // Left/right arrows
    surf.drawText('<', textX - 6, y, COLOR_ARROW, '7px monospace');
    surf.drawText(text, textX + 2, y, COLOR_VALUE_TEXT, '7px monospace');
    surf.drawText('>', rightX - 6, y, COLOR_ARROW, '7px monospace');
  }

  private drawControlsList(surf: Surface, vw: number, vh: number): void {
    const inList = this.phase === 'controls';
    const visibleEnd = Math.min(CONTROL_ENTRIES.length, this.controlsScroll + VISIBLE_ROWS);

    for (let i = this.controlsScroll; i < visibleEnd; i++) {
      const entry = CONTROL_ENTRIES[i];
      const rowIdx = i - this.controlsScroll;
      const y = LIST_Y + rowIdx * ROW_HEIGHT;

      // Highlight bar
      if (inList && i === this.controlsCursor) {
        surf.fillRect(2, y, vw - 4, ROW_HEIGHT - 1, COLOR_ROW_HIGHLIGHT);
      }

      // Action label
      surf.drawText(entry.label, LABEL_X, y + 3, COLOR_LABEL, '7px monospace');

      // Key binding (read-only)
      const keyText = entry.defaultKey;
      const keyW = keyText.length * 4;
      surf.drawText(keyText, vw - VALUE_X_RIGHT_MARGIN - keyW, y + 3, COLOR_CONTROLS_KEY, '6px monospace');
    }

    // Scroll indicators
    if (this.controlsScroll > 0) {
      surf.drawText('^', Math.floor(vw / 2), LIST_Y - 4, COLOR_SCROLL_IND, '6px monospace');
    }
    if (visibleEnd < CONTROL_ENTRIES.length) {
      const bottomY = LIST_Y + VISIBLE_ROWS * ROW_HEIGHT;
      surf.drawText('v', Math.floor(vw / 2), bottomY, COLOR_SCROLL_IND, '6px monospace');
    }
  }

  private drawInfoBar(surf: Surface, vw: number, vh: number): void {
    const barY = vh - INFO_BAR_HEIGHT;
    surf.fillRect(0, barY, vw, INFO_BAR_HEIGHT, COLOR_INFO_BG);

    let description = '';

    if (this.phase === 'config') {
      if (this.configCursor >= 0 && this.configCursor < CONFIG_SETTINGS.length) {
        description = CONFIG_SETTINGS[this.configCursor].description;
      }
    } else if (this.phase === 'controls') {
      if (this.controlsCursor >= 0 && this.controlsCursor < CONTROL_ENTRIES.length) {
        description = `${CONTROL_ENTRIES[this.controlsCursor].label}: ${CONTROL_ENTRIES[this.controlsCursor].defaultKey}`;
      }
    } else if (this.phase === 'top_config') {
      description = 'Game configuration options.';
    } else if (this.phase === 'top_controls') {
      description = 'View key bindings.';
    }

    surf.drawText(description, 4, barY + 4, COLOR_INFO_TEXT, '6px monospace');

    // Button hints on the right
    const hintText = this.phase === 'top_config' || this.phase === 'top_controls'
      ? 'L/R: Tab  DOWN: Enter  B: Exit'
      : 'L/R: Change  B: Exit';
    const hintW = hintText.length * 4;
    surf.drawText(hintText, vw - hintW - 4, barY + 4, 'rgba(120,120,160,0.8)', '6px monospace');
  }
}
