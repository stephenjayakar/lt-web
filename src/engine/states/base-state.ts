/**
 * base-state.ts — Base screen states for the Lex Talionis web engine.
 *
 * The base screen is a between-chapter hub menu entered via the `base`
 * event command. It shows a panorama background and a vertical menu
 * with options for managing units, viewing conversations, shopping,
 * and continuing the story.
 *
 * BaseMainState: Main base hub menu (Manage, Convos, Market, Options, Save, Continue)
 * BaseConvosState: Sub-menu listing available base conversations
 *
 * Port of lt-maker/app/engine/base.py
 */

import { State, type StateResult } from '../state';
import type { Surface } from '../surface';
import type { InputEvent } from '../input';
import { viewport } from '../viewport';

import { ChoiceMenu, type MenuOption } from '../../ui/menu';
import { ACHIEVEMENTS, type AchievementEntry } from '../records';

// ---------------------------------------------------------------------------
// Lazy game reference (same pattern as game-states.ts / prep-state.ts)
// ---------------------------------------------------------------------------

let _game: any = null;
export function setBaseGameRef(g: any): void {
  _game = g;
}
function getGame(): any {
  if (!_game) throw new Error('Game reference not set for base states');
  return _game;
}

// ============================================================================
// BaseMainState — Between-chapter hub menu
// ============================================================================

export class BaseMainState extends State {
  readonly name = 'base_main';
  override readonly showMap = false;
  override readonly inLevel = false;

  private bgImage: HTMLImageElement | null = null;
  private bgName: string = '';
  private menu: ChoiceMenu | null = null;
  private isTransparent: boolean = false;
  private pulseTimer: number = 0;

  override start(): StateResult {
    const game = getGame();

    // Read game vars for base configuration
    this.bgName = game.gameVars.get('_base_bg_name') || 'default_background';
    const musicNid = game.gameVars.get('_base_music') as string | undefined;
    this.isTransparent = !!game.gameVars.get('_base_transparent');
    const hasMarket = !!game.gameVars.get('_base_market');

    // Load background panorama asynchronously
    if (!this.isTransparent) {
      game.resources.tryLoadImage(`resources/panoramas/${this.bgName}.png`)
        .then((img: HTMLImageElement | null) => {
          this.bgImage = img;
        });
    }

    // Start base music if configured
    if (musicNid) {
      void game.audioManager.playMusic(musicNid);
    }

    // Build menu options dynamically
    this.buildMenu(hasMarket);

    this.pulseTimer = 0;

    // on_base_start fires each time the player enters base
    // (matches Python engine/base.py BaseMainState.start).
    if (game.eventManager) {
      const levelNid = game.currentLevel?.nid ?? '';
      const ctx = { game, gameVars: game.gameVars, levelVars: game.levelVars };
      // Push an event state only when this trigger queued a NEW event —
      // hasActiveEvents() also sees a parent event that opened base via the
      // `base` command, and double-pushing EventState corrupts the stack.
      const triggered = game.eventManager.trigger({ type: 'on_base_start', levelNid }, ctx);
      if (triggered) {
        game.state.change('event');
      }
    }
  }

  override begin(): StateResult {
    // Rebuild menu each time we return to this state (convos may have changed)
    const game = getGame();
    const hasMarket = !!game.gameVars.get('_base_market');
    this.buildMenu(hasMarket);
  }

  private buildMenu(hasMarket: boolean): void {
    const game = getGame();
    const options: MenuOption[] = [];

    // Always: Manage
    options.push({
      label: 'Manage',
      value: 'manage',
      enabled: true,
      description: 'Manage your units and equipment.',
    });

    // Supply (convoy) — available in base whenever _convoy is enabled
    // (Python base exposes convoy management with no adjacency requirement).
    if (game.gameVars?.get('_convoy')) {
      options.push({
        label: 'Supply',
        value: 'supply',
        enabled: true,
        description: 'Store and retrieve items.',
      });
    }

    // Market: insert after Manage if enabled
    if (hasMarket) {
      const hasItems = game.marketItems && game.marketItems.size > 0;
      options.push({
        label: 'Market',
        value: 'market',
        enabled: !!hasItems,
        description: 'Buy and sell items.',
      });
    }

    // Convos: enabled only if there are unviewed conversations
    const hasConvos = game.baseConvos && game.baseConvos.size > 0;
    options.push({
      label: 'Convos',
      value: 'convos',
      enabled: !!hasConvos,
      description: 'View available conversations.',
    });

    // Python routes achievements through the base Codex child menu.
    options.push({
      label: 'Codex',
      value: 'codex',
      enabled: true,
      description: 'Review records and achievements.',
    });

    // Options (settings)
    options.push({
      label: 'Options',
      value: 'options',
      enabled: true,
      description: 'Adjust game settings.',
    });

    // Save (disabled stub)
    options.push({
      label: 'Save',
      value: 'save',
      enabled: false,
      description: 'Save your progress.',
    });

    // Continue — exits the base
    options.push({
      label: 'Continue',
      value: 'continue',
      enabled: true,
      description: 'Continue the story.',
    });

    // Position menu on the left side of the screen
    const menuX = 8;
    const menuY = 24;
    this.menu = new ChoiceMenu(options, menuX, menuY);
  }

  override update(): StateResult {
    const game = getGame();
    this.pulseTimer += game.frameDeltaMs ?? 16;
  }

  override draw(surf: Surface): Surface {
    const vw = viewport.width;
    const vh = viewport.height;

    if (this.isTransparent) {
      // Transparent mode: draw the game map beneath (handled by state stack
      // transparency). Just draw a semi-transparent overlay so the menu
      // is readable on top of the map.
      surf.fillRect(0, 0, vw, vh, 'rgba(0,0,0,0.35)');
    } else if (this.bgImage) {
      // Draw panorama scaled to fill viewport
      const s = surf.scale;
      const imgW = this.bgImage.naturalWidth || vw;
      const imgH = this.bgImage.naturalHeight || vh;
      surf.ctx.imageSmoothingEnabled = false;
      surf.ctx.drawImage(
        this.bgImage,
        0, 0, imgW, imgH,
        0, 0, Math.round(vw * s), Math.round(vh * s),
      );
    } else {
      // Fallback: dark background
      surf.fill(16, 16, 32);
    }

    // Title bar
    surf.fillRect(0, 0, vw, 18, 'rgba(16,16,48,0.9)');
    surf.drawText('Base', 4, 4, 'rgba(220,200,128,1)', '10px monospace');

    // Chapter name (top right)
    const game = getGame();
    const level = game.currentLevel;
    if (level) {
      const name = level.name || level.nid || '';
      const nameW = name.length * 5;
      surf.drawText(name, vw - nameW - 4, 5, 'rgba(180,180,220,1)', '7px monospace');
    }

    // Draw menu
    if (this.menu) {
      this.menu.draw(surf);
    }

    // Description box below menu
    if (this.menu) {
      const currentOpt = this.menu.getCurrentOption();
      if (currentOpt.description) {
        const descX = 8;
        const descY = 24 + this.menu.options.length * 16 + 12;
        surf.fillRect(descX - 2, descY - 2, 110, 16, 'rgba(16,16,48,0.8)');
        surf.drawText(
          currentOpt.description,
          descX + 2,
          descY + 2,
          'rgba(180,180,220,1)',
          '6px monospace',
        );
      }
    }

    // Bottom button hints
    surf.fillRect(0, vh - 16, vw, 16, 'rgba(16,16,48,0.8)');
    surf.drawText(
      'SELECT: Choose  |  B: Continue',
      4, vh - 12,
      'rgba(140,140,180,0.8)',
      '6px monospace',
    );

    return surf;
  }

  override takeInput(event: InputEvent): StateResult {
    if (!this.menu) return;
    const game = getGame();

    // Handle mouse click on menu options
    let result: { selected: string } | { back: true } | null = null;
    if (game.input?.mouseClick) {
      const [gx, gy] = game.input.getGameMousePos();
      result = this.menu.handleClick(gx, gy, game.input.mouseClick as 'SELECT' | 'BACK');
    }
    // Handle mouse hover to highlight menu options
    if (game.input?.mouseMoved) {
      const [gx, gy] = game.input.getGameMousePos();
      this.menu.handleMouseHover(gx, gy);
    }
    // Fall through to keyboard input if mouse didn't produce a result
    if (!result && event !== null) {
      result = this.menu.handleInput(event);
    }
    if (!result) return;

    if ('back' in result) {
      // Back exits the base (same as continue)
      game.state.back();
      return;
    }

    if ('selected' in result) {
      switch (result.selected) {
        case 'manage':
          // Reuse prep screen for unit management
          game.state.change('prep_main');
          break;

        case 'supply': {
          // Simplification of Python's per-unit base Manage->Items flow:
          // open the supply screen for the first living party unit.
          let supplyUnit = null;
          for (const unit of game.units.values()) {
            if (unit.team === 'player' && !unit.dead) { supplyUnit = unit; break; }
          }
          if (supplyUnit) {
            game.memory.set('supply_unit', supplyUnit);
            game.state.change('supply_items');
          }
          break;
        }

        case 'convos':
          game.state.change('base_convos');
          break;

        case 'codex':
          game.state.change('base_codex');
          break;

        case 'market': {
          // Set up shop data from marketItems and push shop state
          if (game.marketItems && game.marketItems.size > 0) {
            const itemNids: string[] = [];
            const stocks: number[] = [];
            for (const [nid, stock] of game.marketItems) {
              itemNids.push(nid);
              stocks.push(stock);
            }
            game.shopItems = itemNids;
            game.shopStock = stocks;
            // Select first available player unit as the shopper
            game.shopUnit = null;
            for (const unit of game.units.values()) {
              if (unit.team === 'player' && !unit.dead) {
                game.shopUnit = unit;
                break;
              }
            }
            game.state.change('shop');
          }
          break;
        }

        case 'options':
          // Settings menu (if registered; otherwise no-op)
          try {
            game.state.change('settings_menu');
          } catch {
            console.warn('BaseMainState: settings_menu state not registered');
          }
          break;

        case 'save':
          game.state.change('save_menu');
          break;

        case 'continue':
          // Exit the base — return to event system
          game.state.back();
          break;
      }
    }
  }
}

// ============================================================================
// BaseConvosState — Conversation selection sub-menu
// ============================================================================

export class BaseConvosState extends State {
  readonly name = 'base_convos';
  override readonly transparent = true;
  override readonly showMap = false;
  override readonly inLevel = false;

  private menu: ChoiceMenu | null = null;

  override start(): StateResult {
    this.buildConvoMenu();
  }

  override begin(): StateResult {
    this.buildConvoMenu();
  }

  private buildConvoMenu(): void {
    const game = getGame();
    const convos: Map<string, boolean> = game.baseConvos;

    if (!convos || convos.size === 0) {
      // No conversations available — pop back immediately
      game.state.back();
      return;
    }

    const options: MenuOption[] = [];
    for (const [nid, viewed] of convos) {
      options.push({
        label: nid,
        value: nid,
        // Viewed/ignored conversations are greyed out but still selectable
        enabled: !viewed,
        description: viewed ? '(Already viewed)' : undefined,
      });
    }

    // Position to the right of the parent menu
    const menuX = 80;
    const menuY = 28;
    this.menu = new ChoiceMenu(options, menuX, menuY);
  }

  override draw(surf: Surface): Surface {
    // Transparent state — parent draws background beneath

    // Semi-transparent scrim for readability
    const vw = viewport.width;
    const vh = viewport.height;
    surf.fillRect(0, 0, vw, vh, 'rgba(0,0,0,0.2)');

    // Title
    surf.fillRect(76, 18, 90, 14, 'rgba(16,16,48,0.9)');
    surf.drawText('Conversations', 80, 21, 'rgba(220,200,128,1)', '7px monospace');

    // Draw menu
    if (this.menu) {
      this.menu.draw(surf);
    }

    return surf;
  }

  override takeInput(event: InputEvent): StateResult {
    if (!this.menu) return;
    const game = getGame();

    // Handle mouse click on menu options
    let result: { selected: string } | { back: true } | null = null;
    if (game.input?.mouseClick) {
      const [gx, gy] = game.input.getGameMousePos();
      result = this.menu.handleClick(gx, gy, game.input.mouseClick as 'SELECT' | 'BACK');
    }
    // Handle mouse hover
    if (game.input?.mouseMoved) {
      const [gx, gy] = game.input.getGameMousePos();
      this.menu.handleMouseHover(gx, gy);
    }
    // Keyboard fallback
    if (!result && event !== null) {
      result = this.menu.handleInput(event);
    }
    if (!result) return;

    if ('back' in result) {
      game.state.back();
      return;
    }

    if ('selected' in result) {
      const convoNid = result.selected;

      // Mark conversation as viewed
      if (game.baseConvos) {
        game.baseConvos.set(convoNid, true);
      }

      // Trigger base conversation event if event manager exists
      if (game.eventManager) {
        game.eventManager.triggerBaseConvo(convoNid);
      }

      // Pop back to base main (event will play on top)
      game.state.back();
    }
  }
}

// ============================================================================
// BaseCodexState — Base reference-data submenu
// ============================================================================

export class BaseCodexState extends State {
  readonly name = 'base_codex';
  override readonly transparent = true;
  override readonly showMap = false;
  override readonly inLevel = false;

  private menu: ChoiceMenu | null = null;

  override start(): StateResult {
    this.buildMenu();
  }

  override begin(): StateResult {
    this.buildMenu();
  }

  private buildMenu(): void {
    const hasAchievements = (ACHIEVEMENTS?.getAll().length ?? 0) > 0;
    const options: MenuOption[] = hasAchievements
      ? [{
          label: 'Achievements',
          value: 'achievements',
          enabled: true,
          description: 'Review persistent achievement progress.',
        }]
      : [{
          label: 'No Entries',
          value: 'empty',
          enabled: false,
          description: 'Nothing has been unlocked yet.',
        }];
    this.menu = new ChoiceMenu(options, 80, 36);
  }

  override takeInput(event: InputEvent): StateResult {
    if (!this.menu) return;
    const game = getGame();
    let result: { selected: string } | { back: true } | null = null;
    if (game.input?.mouseClick) {
      const [gx, gy] = game.input.getGameMousePos();
      result = this.menu.handleClick(gx, gy, game.input.mouseClick as 'SELECT' | 'BACK');
    }
    if (game.input?.mouseMoved) {
      const [gx, gy] = game.input.getGameMousePos();
      this.menu.handleMouseHover(gx, gy);
    }
    if (!result && event !== null) result = this.menu.handleInput(event);
    if (!result) return;
    if ('back' in result) {
      game.state.back();
    } else if (result.selected === 'achievements') {
      game.state.change('base_achievement');
    }
  }

  override draw(surf: Surface): Surface {
    const vw = viewport.width;
    const vh = viewport.height;
    surf.fillRect(0, 0, vw, vh, 'rgba(0,0,0,0.28)');
    surf.fillRect(76, 20, Math.min(150, vw - 82), 14, 'rgba(16,16,48,0.94)');
    surf.drawText('Codex', 82, 23, 'rgba(220,200,128,1)', '8px monospace');
    this.menu?.draw(surf);
    return surf;
  }
}

// ============================================================================
// BaseAchievementState — Project-global achievement browser
// ============================================================================

const ACHIEVEMENT_HEADER_H = 22;
const ACHIEVEMENT_LIST_Y = 27;
const ACHIEVEMENT_ROW_H = 18;
const ACHIEVEMENT_VISIBLE_ROWS = 5;

export class BaseAchievementState extends State {
  readonly name = 'base_achievement';
  override readonly showMap = false;
  override readonly inLevel = false;

  private bgImage: HTMLImageElement | null = null;
  private achievements: AchievementEntry[] = [];
  private selectedIndex: number = 0;
  private scrollOffset: number = 0;
  private backgroundLoadToken: number = 0;

  override start(): StateResult {
    this.bgImage = null;
    this.selectedIndex = 0;
    this.scrollOffset = 0;
    this.reloadEntries();
    this.loadBackground();
  }

  override begin(): StateResult {
    this.reloadEntries();
  }

  override finish(): void {
    this.backgroundLoadToken++;
    this.bgImage = null;
  }

  private reloadEntries(): void {
    this.achievements = ACHIEVEMENTS?.getAll() ?? [];
    if (this.achievements.length === 0) {
      this.selectedIndex = 0;
      this.scrollOffset = 0;
      return;
    }
    this.selectedIndex = Math.min(this.selectedIndex, this.achievements.length - 1);
    this.keepSelectionVisible();
  }

  private loadBackground(): void {
    const game = getGame();
    const bgName = String(game.gameVars.get('_base_bg_name') || 'default_background');
    const token = ++this.backgroundLoadToken;
    void game.resources.tryLoadImage(`resources/panoramas/${bgName}.png`)
      .then((img: HTMLImageElement | null) => {
        if (token === this.backgroundLoadToken) this.bgImage = img;
      });
  }

  private getVisibleRowCount(): number {
    const footerTop = viewport.height - 18;
    const hasDetailSpace = viewport.height >= 104;
    const detailSpace = hasDetailSpace ? 26 : 0;
    const available = footerTop - ACHIEVEMENT_LIST_Y - detailSpace;
    return Math.max(1, Math.min(ACHIEVEMENT_VISIBLE_ROWS, Math.floor(available / ACHIEVEMENT_ROW_H)));
  }

  private keepSelectionVisible(): void {
    const visibleRows = this.getVisibleRowCount();
    if (this.selectedIndex < this.scrollOffset) {
      this.scrollOffset = this.selectedIndex;
    } else if (this.selectedIndex >= this.scrollOffset + visibleRows) {
      this.scrollOffset = this.selectedIndex - visibleRows + 1;
    }
  }

  private moveSelection(delta: number): void {
    if (this.achievements.length === 0) return;
    this.selectedIndex = (this.selectedIndex + delta + this.achievements.length) % this.achievements.length;
    this.keepSelectionVisible();
  }

  private wrapText(text: string, maxChars: number, maxLines: number): string[] {
    const words = text.split(/\s+/).filter(Boolean);
    const lines: string[] = [];
    let line = '';
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (candidate.length <= maxChars) {
        line = candidate;
      } else {
        if (line) lines.push(line);
        line = word.slice(0, maxChars);
        if (lines.length >= maxLines) break;
      }
    }
    if (line && lines.length < maxLines) lines.push(line);
    if (words.length && lines.length === maxLines && lines.join(' ').length < text.length - 1) {
      lines[maxLines - 1] = `${lines[maxLines - 1].slice(0, Math.max(0, maxChars - 3))}...`;
    }
    return lines;
  }

  override takeInput(event: InputEvent): StateResult {
    const game = getGame();
    if (game.input?.mouseClick === 'BACK' || event === 'BACK') {
      game.audioManager?.playSfx?.('Select 4');
      game.state.back();
      return;
    }

    if (game.input?.mouseMoved || game.input?.mouseClick === 'SELECT') {
      const [mx, my] = game.input.getGameMousePos();
      const row = Math.floor((my - ACHIEVEMENT_LIST_Y) / ACHIEVEMENT_ROW_H);
      const index = this.scrollOffset + row;
      if (mx >= 7 && mx <= viewport.width - 7 && row >= 0 && row < this.getVisibleRowCount() && index < this.achievements.length) {
        if (index !== this.selectedIndex) game.audioManager?.playSfx?.('Select 6');
        this.selectedIndex = index;
      }
    }

    if (event === 'UP') {
      this.moveSelection(-1);
      game.audioManager?.playSfx?.('Select 6');
    } else if (event === 'DOWN') {
      this.moveSelection(1);
      game.audioManager?.playSfx?.('Select 6');
    }
  }

  override draw(surf: Surface): Surface {
    const vw = viewport.width;
    const vh = viewport.height;
    if (this.bgImage) {
      const scale = surf.scale;
      surf.ctx.imageSmoothingEnabled = false;
      surf.ctx.drawImage(
        this.bgImage,
        0, 0, this.bgImage.naturalWidth || vw, this.bgImage.naturalHeight || vh,
        0, 0, Math.round(vw * scale), Math.round(vh * scale),
      );
      surf.fillRect(0, 0, vw, vh, 'rgba(5,9,24,0.64)');
    } else {
      surf.fill(9, 13, 30);
      for (let x = -vh; x < vw; x += 16) {
        surf.fillRect(x, 0, 1, vh, 'rgba(95,112,164,0.08)');
      }
    }

    const completeCount = this.achievements.filter((entry) => entry.complete).length;
    const total = this.achievements.length;
    surf.fillRect(0, 0, vw, ACHIEVEMENT_HEADER_H, 'rgba(10,15,42,0.94)');
    surf.fillRect(0, ACHIEVEMENT_HEADER_H - 2, vw, 2, 'rgba(218,177,75,0.85)');
    surf.drawText('ACHIEVEMENTS', 7, 5, 'rgba(245,222,148,1)', '10px monospace');
    const countText = `${completeCount} / ${total}`;
    surf.drawText(countText, vw - countText.length * 6 - 8, 6, 'rgba(176,205,255,1)', '8px monospace');
    const progressW = Math.max(1, vw - 14);
    surf.fillRect(7, 18, progressW, 2, 'rgba(54,64,104,0.9)');
    if (total > 0) {
      surf.fillRect(7, 18, Math.floor(progressW * completeCount / total), 2, 'rgba(229,184,68,1)');
    }

    if (total === 0) {
      surf.fillRect(22, 54, vw - 44, 34, 'rgba(12,18,48,0.88)');
      surf.drawRect(22, 54, vw - 44, 34, 'rgba(112,130,190,0.55)');
      surf.drawText('No achievements yet.', 60, 68, 'rgba(181,191,220,1)', '8px monospace');
    } else {
      const visibleRows = this.getVisibleRowCount();
      const end = Math.min(total, this.scrollOffset + visibleRows);
      for (let index = this.scrollOffset; index < end; index++) {
        const entry = this.achievements[index];
        const hidden = entry.hidden && !entry.complete;
        const y = ACHIEVEMENT_LIST_Y + (index - this.scrollOffset) * ACHIEVEMENT_ROW_H;
        const selected = index === this.selectedIndex;
        surf.fillRect(7, y, vw - 14, ACHIEVEMENT_ROW_H - 2,
          selected ? 'rgba(55,73,131,0.94)' : 'rgba(12,18,48,0.82)');
        surf.drawRect(7, y, vw - 14, ACHIEVEMENT_ROW_H - 2,
          selected ? 'rgba(229,184,68,0.95)' : 'rgba(86,101,153,0.45)');
        const marker = entry.complete ? '*' : hidden ? '?' : '-';
        const markerColor = entry.complete
          ? 'rgba(245,205,91,1)'
          : hidden ? 'rgba(118,125,151,1)' : 'rgba(155,174,219,1)';
        surf.drawText(marker, 12, y + 4, markerColor, '8px monospace');
        const displayName = hidden ? 'Hidden' : entry.name;
        const status = entry.complete ? 'Complete' : 'Locked';
        surf.drawText(`${displayName} - ${status}`.slice(0, 42), 25, y + 4,
          entry.complete ? 'rgba(255,238,181,1)' : 'rgba(218,224,241,1)', '8px monospace');
      }

      const selected = this.achievements[this.selectedIndex];
      const hidden = selected.hidden && !selected.complete;
      const detailY = ACHIEVEMENT_LIST_Y + visibleRows * ACHIEVEMENT_ROW_H + 1;
      if (detailY + 25 <= vh - 18) {
        surf.fillRect(7, detailY, vw - 14, 25, 'rgba(8,12,34,0.92)');
        surf.drawRect(7, detailY, vw - 14, 25, 'rgba(86,101,153,0.55)');
        const desc = hidden ? '???' : selected.desc;
        const lines = this.wrapText(desc, Math.max(12, Math.floor((vw - 24) / 4)), 2);
        lines.forEach((line, index) => {
          surf.drawText(line, 12, detailY + 4 + index * 8, 'rgba(177,190,222,1)', '6px monospace');
        });
      }
    }

    surf.fillRect(0, vh - 18, vw, 18, 'rgba(8,12,34,0.96)');
    surf.drawText('UP/DOWN: Browse', 7, vh - 14, 'rgba(137,153,198,1)', '6px monospace');
    surf.drawText('B: Back', vw - 48, vh - 14, 'rgba(245,222,148,1)', '6px monospace');
    return surf;
  }
}

// ============================================================================
// Event Command Handler — base-related event commands
// ============================================================================

/**
 * Execute base-related event commands.
 * Returns true if the command was handled, false otherwise.
 *
 * Supported commands:
 *   add_base_convo <nid>          — Add a conversation to the base menu
 *   ignore_base_convo <nid>       — Mark a conversation as viewed/ignored
 *   remove_base_convo <nid>       — Remove a conversation entirely
 *   add_market_item <nid> [stock] — Add an item to the market (stock defaults to -1 = infinite)
 *   remove_market_item <nid>      — Remove an item from the market
 *   clear_market_items            — Clear all market items
 */
export function handleBaseEventCommand(cmd: string, args: string[], game: any): boolean {
  // Ensure the Maps exist on the game object
  if (!game.baseConvos) {
    game.baseConvos = new Map<string, boolean>();
  }
  if (!game.marketItems) {
    game.marketItems = new Map<string, number>();
  }

  switch (cmd) {
    case 'add_base_convo': {
      if (args.length < 1) {
        console.warn('add_base_convo: missing convo NID argument');
        return true;
      }
      const nid = args[0].trim();
      // Only add if not already present (don't reset viewed status)
      if (!game.baseConvos.has(nid)) {
        game.baseConvos.set(nid, false);
      }
      return true;
    }

    case 'ignore_base_convo': {
      if (args.length < 1) {
        console.warn('ignore_base_convo: missing convo NID argument');
        return true;
      }
      const nid = args[0].trim();
      game.baseConvos.set(nid, true);
      return true;
    }

    case 'remove_base_convo': {
      if (args.length < 1) {
        console.warn('remove_base_convo: missing convo NID argument');
        return true;
      }
      const nid = args[0].trim();
      game.baseConvos.delete(nid);
      return true;
    }

    case 'add_market_item': {
      if (args.length < 1) {
        console.warn('add_market_item: missing item NID argument');
        return true;
      }
      const itemNid = args[0].trim();
      // Stock defaults to -1 (infinite) if not provided
      const stock = args.length >= 2 ? parseInt(args[1], 10) : -1;
      game.marketItems.set(itemNid, isNaN(stock) ? -1 : stock);
      return true;
    }

    case 'remove_market_item': {
      if (args.length < 1) {
        console.warn('remove_market_item: missing item NID argument');
        return true;
      }
      const itemNid = args[0].trim();
      game.marketItems.delete(itemNid);
      return true;
    }

    case 'clear_market_items': {
      game.marketItems.clear();
      return true;
    }

    default:
      return false;
  }
}
