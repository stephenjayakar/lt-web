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
import { ACHIEVEMENTS, RECORDS, type AchievementEntry } from '../records';
import type { LoreEntry } from '../../data/types';
import { canTradeWith } from '../../combat/skill-system';
import { getEffectiveLevelCap } from '../leveling';

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

    // Supports: enabled only if there are support conversations
    const hasSupportConvos = this.hasSupportConversations();
    options.push({
      label: 'Supports',
      value: 'supports',
      enabled: !!hasSupportConvos,
      description: 'View support conversations.',
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

    // Save
    options.push({
      label: 'Save',
      value: 'save',
      enabled: true,
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

  private hasSupportConversations(): boolean {
    const game = getGame();
    const supportController = game.supports;
    if (!supportController || !supportController.pairs) return false;

    // Check if there are any support pairs with locked or unlocked ranks
    for (const pair of supportController.pairs.values()) {
      if (pair.lockedRanks.length > 0 || pair.unlockedRanks.length > 0) {
        return true;
      }
    }
    return false;
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
          game.state.change('base_manage');
          break;

        case 'convos':
          game.state.change('base_convos');
          break;

        case 'supports':
          game.state.change('base_supports');
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
            game.shopFlavor = 'market';
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

      // Fire on_base_convo trigger (matches Python engine/base.py:
      // BaseConvosState.take_input -> trigger('on_base_convo') with base_convo + unit)
      if (game.eventManager) {
        const levelNid = game.currentLevel?.nid ?? '';
        const ctx = { game, gameVars: game.gameVars, levelVars: game.levelVars };
        const triggered = game.eventManager.trigger(
          {
            type: 'on_base_convo',
            levelNid,
            baseConvo: convoNid,
            unit: convoNid, // deprecated, but matches Python's unit field
            localArgs: new Map([['base_convo', convoNid]]),
          },
          ctx,
        );
        if (triggered) {
          game.state.change('event');
        }
      }

      // Pop back to base main (event will play on top if triggered above)
      if (!game.eventManager || !game.eventManager.hasActiveEvents()) {
        game.state.back();
      }
    }
  }
}

// ============================================================================
// BaseSupportState — Base support-conversation submenu
// ============================================================================

export class BaseSupportState extends State {
  readonly name = 'base_supports';
  override readonly transparent = true;
  override readonly showMap = false;
  override readonly inLevel = false;

  private menu: ChoiceMenu | null = null;

  override start(): StateResult {
    this.buildSupportMenu();
  }

  override begin(): StateResult {
    this.buildSupportMenu();
  }

  private buildSupportMenu(): void {
    const game = getGame();
    const supportController = game.supports;
    if (!supportController) {
      game.state.back();
      return;
    }

    // Build list of all available support conversations (unlocked ranks)
    // mapped by pair and rank. Each can be replayed.
    const options: MenuOption[] = [];

    for (const [pairNid, pair] of supportController.pairs ?? new Map()) {
      // Get both units in the pair
      const unit1 = game.units.get(pair.unit1Nid);
      const unit2 = game.units.get(pair.unit2Nid);
      if (!unit1 || !unit2) continue;

      // Add each unlocked rank as a menu option
      for (const rank of pair.unlockedRanks) {
        const label = `${unit1.name} & ${unit2.name} — Rank ${rank}`;
        options.push({
          label,
          value: `${pairNid}|${rank}`,
          enabled: true,
          description: '(Replay)',
        });
      }

      // Also show locked ranks that haven't been viewed yet
      for (const rank of pair.lockedRanks) {
        const label = `${unit1.name} & ${unit2.name} — Rank ${rank}`;
        options.push({
          label,
          value: `${pairNid}|${rank}|new`,
          enabled: true,
          description: undefined,
        });
      }
    }

    if (options.length === 0) {
      // No conversations available — pop back immediately
      game.state.back();
      return;
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
    surf.drawText('Supports', 80, 21, 'rgba(220,200,128,1)', '7px monospace');

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
      const parts = result.selected.split('|');
      const pairNid = parts[0];
      const rank = parts[1];
      const isNew = parts[2] === 'new';

      // Trigger support event
      if (game.eventManager && game.supports) {
        const pair = game.supports.pairs?.get(pairNid);
        if (pair) {
          const unit1 = game.units.get(pair.unit1Nid);
          const unit2 = game.units.get(pair.unit2Nid);
          if (unit1 && unit2) {
            const ctx = { game, unit1, unit2, gameVars: game.gameVars, levelVars: game.levelVars };
            game.eventManager.trigger(
              {
                type: 'on_support',
                unit1,
                unit2,
                position: null, // Base has no position
                support_rank_nid: rank,
                is_replay: !isNew, // Replay if already viewed, not replay if new
              },
              ctx,
            );
            // If it's a new rank (locked), unlock it
            if (isNew) {
              game.supports.unlockRank(pairNid, rank);
            }
          }
        }
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

  /**
   * Mirrors Python's BaseCodexChildState.get_options: each child menu only
   * appears when its backing data has something to show.
   */
  private buildMenu(): void {
    const game = getGame();
    const unlockedLore: LoreEntry[] = (game.unlockedLore ?? [])
      .map((nid: string) => game.db.lore.get(nid))
      .filter((entry: LoreEntry | undefined): entry is LoreEntry => !!entry);
    const hasLibrary = unlockedLore.some((entry) => entry.category !== 'Guide');
    const hasGuide = unlockedLore.some((entry) => entry.category === 'Guide');
    // Python: len(game.records.get_levels()) > 1 (ignores the current level)
    const hasRecords = (game.records?.getLevels?.(game.db.levels)?.length ?? 0) > 1;
    const hasSoundRoom = !!game.db.getConstant?.('sound_room_in_codex', false);
    const hasAchievements = (ACHIEVEMENTS?.getAll().length ?? 0) > 0;

    const options: MenuOption[] = [];
    if (hasLibrary) {
      options.push({ label: 'Library', value: 'library', enabled: true, description: 'Browse unlocked lore entries.' });
    }
    if (hasRecords) {
      options.push({ label: 'Records', value: 'records', enabled: true, description: 'Review chapter and unit statistics.' });
    }
    if (hasSoundRoom) {
      options.push({ label: 'Sound Room', value: 'sound_room', enabled: true, description: 'Listen to unlocked music tracks.' });
    }
    if (hasAchievements) {
      options.push({ label: 'Achievements', value: 'achievements', enabled: true, description: 'Review persistent achievement progress.' });
    }
    if (hasGuide) {
      options.push({ label: 'Guide', value: 'guide', enabled: true, description: 'Browse strategy guide entries.' });
    }
    if (options.length === 0) {
      options.push({ label: 'No Entries', value: 'empty', enabled: false, description: 'Nothing has been unlocked yet.' });
    }
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
    } else if (result.selected === 'library') {
      game.state.change('base_library');
    } else if (result.selected === 'guide') {
      game.state.change('base_guide');
    } else if (result.selected === 'records') {
      game.state.change('base_records');
    } else if (result.selected === 'sound_room') {
      game.state.change('base_sound_room');
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
// BaseLoreState — Library/Guide browser (shared implementation)
// Port of lt-maker/app/engine/base.py BaseLibraryState / BaseGuideState.
// Library shows every unlocked lore entry except category=='Guide'; Guide
// shows only the category=='Guide' entries. Both share layout/behavior.
// ============================================================================

const LORE_HEADER_H = 22;
const LORE_LIST_Y = 27;
const LORE_ROW_H = 18;
const LORE_VISIBLE_ROWS = 5;

export class BaseLoreState extends State {
  readonly name: string;
  override readonly showMap = false;
  override readonly inLevel = false;

  private guideMode: boolean;
  private bgImage: HTMLImageElement | null = null;
  private entries: LoreEntry[] = [];
  private selectedIndex: number = 0;
  private scrollOffset: number = 0;
  private backgroundLoadToken: number = 0;

  constructor(guideMode: boolean = false) {
    super();
    this.guideMode = guideMode;
    this.name = guideMode ? 'base_guide' : 'base_library';
  }

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
    const game = getGame();
    const unlocked: LoreEntry[] = (game.unlockedLore ?? [])
      .map((nid: string) => game.db.lore.get(nid))
      .filter((entry: LoreEntry | undefined): entry is LoreEntry => !!entry);
    this.entries = unlocked
      .filter((entry) => (this.guideMode ? entry.category === 'Guide' : entry.category !== 'Guide'))
      .sort((a, b) => a.category.localeCompare(b.category));
    if (this.entries.length === 0) {
      this.selectedIndex = 0;
      this.scrollOffset = 0;
      return;
    }
    this.selectedIndex = Math.min(this.selectedIndex, this.entries.length - 1);
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
    const available = footerTop - LORE_LIST_Y - detailSpace;
    return Math.max(1, Math.min(LORE_VISIBLE_ROWS, Math.floor(available / LORE_ROW_H)));
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
    if (this.entries.length === 0) return;
    this.selectedIndex = (this.selectedIndex + delta + this.entries.length) % this.entries.length;
    this.keepSelectionVisible();
  }

  private wrapText(text: string, maxChars: number, maxLines: number): string[] {
    const words = text.replace(/\{br\}/g, ' ').split(/\s+/).filter(Boolean);
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
      const row = Math.floor((my - LORE_LIST_Y) / LORE_ROW_H);
      const index = this.scrollOffset + row;
      if (mx >= 7 && mx <= viewport.width - 7 && row >= 0 && row < this.getVisibleRowCount() && index < this.entries.length) {
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
    }

    const title = this.guideMode ? 'GUIDE' : 'LIBRARY';
    surf.fillRect(0, 0, vw, LORE_HEADER_H, 'rgba(10,15,42,0.94)');
    surf.fillRect(0, LORE_HEADER_H - 2, vw, 2, 'rgba(218,177,75,0.85)');
    surf.drawText(title, 7, 5, 'rgba(245,222,148,1)', '10px monospace');
    const countText = `${this.entries.length}`;
    surf.drawText(countText, vw - countText.length * 6 - 8, 6, 'rgba(176,205,255,1)', '8px monospace');

    if (this.entries.length === 0) {
      surf.fillRect(22, 54, vw - 44, 34, 'rgba(12,18,48,0.88)');
      surf.drawRect(22, 54, vw - 44, 34, 'rgba(112,130,190,0.55)');
      surf.drawText('No entries unlocked yet.', 30, 68, 'rgba(181,191,220,1)', '8px monospace');
    } else {
      const visibleRows = this.getVisibleRowCount();
      const end = Math.min(this.entries.length, this.scrollOffset + visibleRows);
      let lastCategory: string | null = null;
      for (let index = this.scrollOffset; index < end; index++) {
        const entry = this.entries[index];
        const y = LORE_LIST_Y + (index - this.scrollOffset) * LORE_ROW_H;
        const selected = index === this.selectedIndex;
        surf.fillRect(7, y, vw - 14, LORE_ROW_H - 2,
          selected ? 'rgba(55,73,131,0.94)' : 'rgba(12,18,48,0.82)');
        surf.drawRect(7, y, vw - 14, LORE_ROW_H - 2,
          selected ? 'rgba(229,184,68,0.95)' : 'rgba(86,101,153,0.45)');
        surf.drawText((entry.title || entry.name).slice(0, 42), 12, y + 4,
          'rgba(255,238,181,1)', '8px monospace');
        if (entry.category !== lastCategory) {
          surf.drawText(entry.category.slice(0, 12), vw - 62, y + 4, 'rgba(155,174,219,1)', '6px monospace');
          lastCategory = entry.category;
        }
      }

      const selected = this.entries[this.selectedIndex];
      const detailY = LORE_LIST_Y + visibleRows * LORE_ROW_H + 1;
      if (detailY + 25 <= vh - 18) {
        surf.fillRect(7, detailY, vw - 14, 25, 'rgba(8,12,34,0.92)');
        surf.drawRect(7, detailY, vw - 14, 25, 'rgba(86,101,153,0.55)');
        const lines = this.wrapText(selected.text, Math.max(12, Math.floor((vw - 24) / 4)), 3);
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
// BaseRecordsState — Chapter turncount + MVP unit-statistic browser
// Port of lt-maker/app/engine/base.py BaseRecordsState (record_book.py display).
// Simplification: Python renders two paged Table displays (Records/MVP) with
// per-chapter and per-unit drill-down sub-screens; the web collapses this to
// a single scrollable list per tab (LEFT/RIGHT switches Chapters <-> MVP)
// with the same underlying Recordkeeper statistics.
// ============================================================================

const RECORDS_HEADER_H = 22;
const RECORDS_LIST_Y = 27;
const RECORDS_ROW_H = 14;
const RECORDS_VISIBLE_ROWS = 6;

interface ChapterRow {
  levelNid: string;
  levelName: string;
  turncount: number;
}

interface MvpRow {
  unitNid: string;
  unitName: string;
  kills: number;
  damage: number;
  heal: number;
  score: number;
}

export class BaseRecordsState extends State {
  readonly name = 'base_records';
  override readonly showMap = false;
  override readonly inLevel = false;

  private bgImage: HTMLImageElement | null = null;
  private tab: 'chapters' | 'mvp' = 'chapters';
  private chapters: ChapterRow[] = [];
  private mvps: MvpRow[] = [];
  private selectedIndex: number = 0;
  private scrollOffset: number = 0;
  private backgroundLoadToken: number = 0;

  override start(): StateResult {
    this.bgImage = null;
    this.tab = 'chapters';
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
    const game = getGame();
    const rk = game.records;
    const allLevels: string[] = rk?.getLevels?.(game.db.levels) ?? [];
    // Match Python's record_book.py behavior: records screens omit the current
    // chapter (last played) in chapter-history lists by slicing it out.
    const levels: string[] = allLevels.slice(0, -1);
    const turncounts: number[] = rk?.getTurncounts?.(levels) ?? [];
    this.chapters = levels.map((levelNid: string, i: number) => ({
      levelNid,
      levelName: game.db.levels.get(levelNid)?.name ?? levelNid,
      turncount: turncounts[i] ?? 0,
    }));

    const unitNids = new Set<string>();
    for (const unit of game.units.values()) unitNids.add(unit.nid);
    const playerUnitNids = Array.from(unitNids).filter((unitNid) => {
      const unit = game.units.get(unitNid);
      return unit?.team === 'player' && !!unit?.persistent;
    });
    this.mvps = playerUnitNids.map((unitNid) => ({
      unitNid,
      unitName: game.units.get(unitNid)?.name ?? unitNid,
      kills: rk?.getKills?.(unitNid) ?? 0,
      damage: rk?.getDamage?.(unitNid) ?? 0,
      heal: rk?.getHeal?.(unitNid) ?? 0,
      score: rk?.determineScore?.(unitNid) ?? 0,
    })).sort((a, b) => b.score - a.score);

    this.selectedIndex = 0;
    this.scrollOffset = 0;
  }

  private currentRows(): ChapterRow[] | MvpRow[] {
    return this.tab === 'chapters' ? this.chapters : this.mvps;
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
    const available = footerTop - RECORDS_LIST_Y;
    return Math.max(1, Math.min(RECORDS_VISIBLE_ROWS, Math.floor(available / RECORDS_ROW_H)));
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
    const rows = this.currentRows();
    if (rows.length === 0) return;
    this.selectedIndex = (this.selectedIndex + delta + rows.length) % rows.length;
    this.keepSelectionVisible();
  }

  private switchTab(): void {
    this.tab = this.tab === 'chapters' ? 'mvp' : 'chapters';
    this.selectedIndex = 0;
    this.scrollOffset = 0;
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
      const row = Math.floor((my - RECORDS_LIST_Y) / RECORDS_ROW_H);
      const index = this.scrollOffset + row;
      const rows = this.currentRows();
      if (mx >= 7 && mx <= viewport.width - 7 && row >= 0 && row < this.getVisibleRowCount() && index < rows.length) {
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
    } else if (event === 'LEFT' || event === 'RIGHT') {
      this.switchTab();
      game.audioManager?.playSfx?.('Status_Page_Change');
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
    }

    surf.fillRect(0, 0, vw, RECORDS_HEADER_H, 'rgba(10,15,42,0.94)');
    surf.fillRect(0, RECORDS_HEADER_H - 2, vw, 2, 'rgba(218,177,75,0.85)');
    surf.drawText('RECORDS', 7, 5, 'rgba(245,222,148,1)', '10px monospace');
    const tabLabel = this.tab === 'chapters' ? '< Chapters >' : '< MVP >';
    surf.drawText(tabLabel, vw - tabLabel.length * 6 - 8, 6, 'rgba(176,205,255,1)', '7px monospace');

    const rows = this.currentRows();
    if (rows.length === 0) {
      surf.fillRect(22, 54, vw - 44, 34, 'rgba(12,18,48,0.88)');
      surf.drawRect(22, 54, vw - 44, 34, 'rgba(112,130,190,0.55)');
      surf.drawText('No data recorded yet.', 30, 68, 'rgba(181,191,220,1)', '8px monospace');
    } else {
      const visibleRows = this.getVisibleRowCount();
      const end = Math.min(rows.length, this.scrollOffset + visibleRows);
      for (let index = this.scrollOffset; index < end; index++) {
        const y = RECORDS_LIST_Y + (index - this.scrollOffset) * RECORDS_ROW_H;
        const selected = index === this.selectedIndex;
        surf.fillRect(7, y, vw - 14, RECORDS_ROW_H - 2,
          selected ? 'rgba(55,73,131,0.94)' : 'rgba(12,18,48,0.82)');
        if (this.tab === 'chapters') {
          const row = rows[index] as ChapterRow;
          surf.drawText(row.levelName.slice(0, 28), 12, y + 3, 'rgba(255,238,181,1)', '7px monospace');
          const tc = `${row.turncount} turns`;
          surf.drawText(tc, vw - tc.length * 5 - 10, y + 3, 'rgba(218,224,241,1)', '7px monospace');
        } else {
          const row = rows[index] as MvpRow;
          surf.drawText(row.unitName.slice(0, 20), 12, y + 3, 'rgba(255,238,181,1)', '7px monospace');
          const stats = `K${row.kills} D${row.damage} H${row.heal}`;
          surf.drawText(stats, vw - stats.length * 5 - 10, y + 3, 'rgba(218,224,241,1)', '7px monospace');
        }
      }
    }

    surf.fillRect(0, vh - 18, vw, 18, 'rgba(8,12,34,0.96)');
    surf.drawText('LEFT/RIGHT: Tab', 7, vh - 14, 'rgba(137,153,198,1)', '6px monospace');
    surf.drawText('B: Back', vw - 48, vh - 14, 'rgba(245,222,148,1)', '6px monospace');
    return surf;
  }
}

// ============================================================================
// BaseSoundRoomState — Music player over the project's music resources
// Port of lt-maker/app/engine/base.py BaseSoundRoomState.
// Simplification: Python renders a numbered grid Table with volume-meter
// sprites and battle-variant fade-ins (AUX); the web renders a single
// scrollable list, SELECT plays the highlighted track (fading in via
// AudioManager) and re-selecting/START stops it. Locked tracks (when the
// `locked_soundroom` constant is set) are redacted like achievements/lore.
// ============================================================================

const SOUND_HEADER_H = 22;
const SOUND_LIST_Y = 27;
const SOUND_ROW_H = 14;
const SOUND_VISIBLE_ROWS = 6;

interface MusicJsonEntry {
  0: string; // nid
  1: boolean; // unknown flag (unused by web)
  2: boolean; // has battle variant
}

export class BaseSoundRoomState extends State {
  readonly name = 'base_sound_room';
  override readonly showMap = false;
  override readonly inLevel = false;

  private trackNids: string[] = [];
  private lockedFlags: boolean[] = [];
  private selectedIndex: number = 0;
  private scrollOffset: number = 0;
  private playing: boolean = false;
  private previousMusic: string | null = null;
  private loaded: boolean = false;

  override start(): StateResult {
    this.selectedIndex = 0;
    this.scrollOffset = 0;
    this.playing = false;
    this.loaded = false;
    this.previousMusic = null;
    void this.loadTrackList();
  }

  override begin(): StateResult {
    const game = getGame();
    const currentMusic = (game.audioManager as any)?.currentMusicNid;
    this.previousMusic = (typeof currentMusic === 'string' && currentMusic.length > 0)
      ? currentMusic
      : (game.gameVars.get('_base_music') as string | undefined) ?? null;
    this.playing = false;
  }

  override finish(): void {
    // Restore whatever base music was playing before entering the sound room
    // (matches Python: fade back in to _base_music on BACK).
    const game = getGame();
    const musicNid = this.previousMusic ?? (game.gameVars.get('_base_music') as string | undefined);
    if (musicNid) {
      void game.audioManager?.playMusic?.(musicNid);
    } else {
      game.audioManager?.stopMusic?.();
    }
  }

  private async loadTrackList(): Promise<void> {
    const game = getGame();
    const data: MusicJsonEntry[] | null = await game.resources.tryLoadJson('resources/music/music.json');
    const entries = data ?? [];
    this.trackNids = entries.map((e: MusicJsonEntry) => e[0]);
    const lockedConstant = !!game.db.getConstant?.('locked_soundroom', false);
    this.lockedFlags = this.trackNids.map((nid) => lockedConstant && !RECORDS?.checkSongUnlocked?.(nid));
    this.loaded = true;
  }

  private getVisibleRowCount(): number {
    const footerTop = viewport.height - 18;
    const available = footerTop - SOUND_LIST_Y;
    return Math.max(1, Math.min(SOUND_VISIBLE_ROWS, Math.floor(available / SOUND_ROW_H)));
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
    if (this.trackNids.length === 0) return;
    this.selectedIndex = (this.selectedIndex + delta + this.trackNids.length) % this.trackNids.length;
    this.keepSelectionVisible();
  }

  private playSelected(): void {
    const game = getGame();
    if (this.trackNids.length === 0) return;
    if (this.lockedFlags[this.selectedIndex]) return;
    const nid = this.trackNids[this.selectedIndex];
    void game.audioManager?.playMusic?.(nid);
    this.playing = true;
  }

  private stopPlaying(): void {
    const game = getGame();
    game.audioManager?.stopMusic?.();
    this.playing = false;
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
      const row = Math.floor((my - SOUND_LIST_Y) / SOUND_ROW_H);
      const index = this.scrollOffset + row;
      if (mx >= 7 && mx <= viewport.width - 7 && row >= 0 && row < this.getVisibleRowCount() && index < this.trackNids.length) {
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
    } else if (event === 'SELECT') {
      if (this.playing) {
        this.stopPlaying();
      } else {
        this.playSelected();
      }
    } else if (event === 'START') {
      this.stopPlaying();
    }
  }

  override draw(surf: Surface): Surface {
    const vw = viewport.width;
    const vh = viewport.height;
    surf.fill(9, 13, 30);

    surf.fillRect(0, 0, vw, SOUND_HEADER_H, 'rgba(10,15,42,0.94)');
    surf.fillRect(0, SOUND_HEADER_H - 2, vw, 2, 'rgba(218,177,75,0.85)');
    surf.drawText('SOUND ROOM', 7, 5, 'rgba(245,222,148,1)', '10px monospace');
    if (this.playing) {
      surf.drawText('(playing)', vw - 62, 6, 'rgba(140,220,150,1)', '7px monospace');
    }

    if (!this.loaded) {
      surf.drawText('Loading...', 30, 40, 'rgba(181,191,220,1)', '8px monospace');
    } else if (this.trackNids.length === 0) {
      surf.fillRect(22, 54, vw - 44, 34, 'rgba(12,18,48,0.88)');
      surf.drawRect(22, 54, vw - 44, 34, 'rgba(112,130,190,0.55)');
      surf.drawText('No music tracks available.', 30, 68, 'rgba(181,191,220,1)', '8px monospace');
    } else {
      const visibleRows = this.getVisibleRowCount();
      const end = Math.min(this.trackNids.length, this.scrollOffset + visibleRows);
      for (let index = this.scrollOffset; index < end; index++) {
        const nid = this.trackNids[index];
        const locked = this.lockedFlags[index];
        const y = SOUND_LIST_Y + (index - this.scrollOffset) * SOUND_ROW_H;
        const selected = index === this.selectedIndex;
        surf.fillRect(7, y, vw - 14, SOUND_ROW_H - 2,
          selected ? 'rgba(55,73,131,0.94)' : 'rgba(12,18,48,0.82)');
        const label = locked ? '??? (locked)' : nid;
        surf.drawText(label.slice(0, 42), 12, y + 3,
          locked ? 'rgba(118,125,151,1)' : 'rgba(218,224,241,1)', '7px monospace');
      }
    }

    surf.fillRect(0, vh - 18, vw, 18, 'rgba(8,12,34,0.96)');
    surf.drawText('SELECT: Play/Stop', 7, vh - 14, 'rgba(137,153,198,1)', '6px monospace');
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
        game.actionLog.doAction(new SetGameVarAction(game.baseConvos, nid, false));
      }
      return true;
    }

    case 'ignore_base_convo': {
      if (args.length < 1) {
        console.warn('ignore_base_convo: missing convo NID argument');
        return true;
      }
      const nid = args[0].trim();
      game.actionLog.doAction(new SetGameVarAction(game.baseConvos, nid, true));
      return true;
    }

    case 'remove_base_convo': {
      if (args.length < 1) {
        console.warn('remove_base_convo: missing convo NID argument');
        return true;
      }
      const nid = args[0].trim();
      game.actionLog.doAction(new DeleteMapValueAction(game.baseConvos, nid));
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
      game.actionLog.doAction(
        new SetGameVarAction(game.marketItems, itemNid, isNaN(stock) ? -1 : stock),
      );
      return true;
    }

    case 'remove_market_item': {
      if (args.length < 1) {
        console.warn('remove_market_item: missing item NID argument');
        return true;
      }
      const itemNid = args[0].trim();
      game.actionLog.doAction(new DeleteMapValueAction(game.marketItems, itemNid));
      return true;
    }

    case 'clear_market_items': {
      game.actionLog.doAction(new ClearMapAction(game.marketItems));
      return true;
    }

    default:
      return false;
  }
}

// ============================================================================
// BEXP states — Python base.py BaseBEXPSelectState / BaseBEXPAllocateState
// ============================================================================

import {
  ClearMapAction,
  DeleteMapValueAction,
  GainExpAction,
  SetGameVarAction,
  SetUnitPartyAction,
  SpendBexpAction,
} from '../action';
import { evaluateEquation } from '../../combat/combat-calcs';

/** Bexp needed for this unit's next full level (Python determine_needed_bexp). */
export function bexpNeededForNextLevel(game: any, unit: any): number {
  const eq = game.db.getEquation('BONUS_EXP');
  if (eq) {
    const v = evaluateEquation(eq, unit);
    if (v > 0) return Math.max(1, Math.trunc(v));
  }
  const internal = unit.getInternalLevel?.() ?? unit.level;
  return Math.max(1, 50 * Math.trunc(internal) + 50);
}

export class BaseBexpSelectState extends State {
  readonly name = 'base_bexp_select';
  override readonly showMap = false;
  override readonly inLevel = false;

  private menu: ChoiceMenu | null = null;

  override begin(): StateResult {
    const game = getGame();
    const partyNid = game.currentParty;
    const options: MenuOption[] = [];
    for (const unit of game.units.values()) {
      if (unit.team !== 'player' || unit.dead) continue;
      if (partyNid && unit.party && unit.party !== partyNid) continue;
      const klass = game.db.classes.get(unit.klass);
      const maxLevel = getEffectiveLevelCap(unit, game);
      const autoPromote = (game.db.getConstant('auto_promote', false) || unit.tags?.includes('AutoPromote'))
        && (klass?.turns_into?.length ?? 0) > 0 && !unit.tags?.includes('NoAutoPromote');
      const maxed = unit.level >= maxLevel && !autoPromote;
      options.push({
        label: `${unit.name} Lv${unit.level} (${unit.exp} exp)`,
        value: unit.nid,
        enabled: !maxed,
        description: maxed ? 'At max level.' : 'Allocate bonus experience.',
      });
    }
    options.push({ label: 'Back', value: 'back', enabled: true, description: 'Return.' });
    this.menu = new ChoiceMenu(options, 8, 24);
  }

  override takeInput(event: InputEvent): StateResult {
    const game = getGame();
    if (!this.menu) return;
    const result = this.menu.handleInput(event);
    if (result && 'back' in result) { game.state.back(); return; }
    if (result && 'selected' in result) {
      if (result.selected === 'back') { game.state.back(); return; }
      const unit = game.units.get(result.selected);
      if (unit) {
        game.memory.set('current_unit', unit);
        game.state.change('base_bexp_allocate');
      }
    }
  }

  override draw(surf: Surface): Surface {
    const game = getGame();
    surf.fillRect(0, 0, viewport.width, viewport.height, 'rgba(8,8,24,0.94)');
    surf.drawText('Bonus EXP', 8, 6, 'rgba(220,200,128,1)', '10px monospace');
    surf.drawText(`BEXP: ${game.parties.get(game.currentParty)?.bexp ?? 0}`, viewport.width - 90, 6, 'white', '8px monospace');
    this.menu?.draw(surf);
    return surf;
  }
}

export class BaseBexpAllocateState extends State {
  readonly name = 'base_bexp_allocate';
  override readonly showMap = false;
  override readonly inLevel = false;

  /** Exp points staged for purchase (harness-visible). */
  expToGain = 0;
  private unit: any = null;

  override begin(): StateResult {
    const game = getGame();
    this.unit = game.memory.get('current_unit') ?? null;
    this.expToGain = 0;
    if (!this.unit) game.state.back();
  }

  /** Cost in bexp for the currently staged exp (proportional-with-ceil; the
   * boundary rounding of Python's stepped table is approximated — total for a
   * full 100 exp is identical). */
  stagedCost(): number {
    const game = getGame();
    const needed = bexpNeededForNextLevel(game, this.unit);
    return Math.ceil((this.expToGain * needed) / 100);
  }

  private maxAffordableExp(): number {
    const game = getGame();
    const bexp = game.parties.get(game.currentParty)?.bexp ?? 0;
    const needed = bexpNeededForNextLevel(game, this.unit);
    const toLevel = 100 - (this.unit?.exp ?? 0);
    const affordable = Math.floor((bexp * 100) / needed);
    return Math.max(0, Math.min(toLevel, affordable));
  }

  override takeInput(event: InputEvent): StateResult {
    const game = getGame();
    if (!this.unit) { game.state.back(); return; }
    if (event === 'RIGHT') {
      if (this.expToGain < this.maxAffordableExp()) this.expToGain++;
    } else if (event === 'LEFT') {
      if (this.expToGain > 0) this.expToGain--;
    } else if (event === 'UP') {
      this.expToGain = this.maxAffordableExp();
    } else if (event === 'DOWN') {
      this.expToGain = 0;
    } else if (event === 'SELECT') {
      if (this.expToGain > 0) {
        const party = game.parties.get(game.currentParty);
        game.actionLog.doAction(new SpendBexpAction(party, this.stagedCost()));
        game.actionLog.doAction(new GainExpAction(this.unit, this.expToGain,
          game.currentMode?.growths ?? 'random'));
        game.state.back();
      }
    } else if (event === 'BACK') {
      game.state.back();
    }
  }

  override draw(surf: Surface): Surface {
    const game = getGame();
    surf.fillRect(0, 0, viewport.width, viewport.height, 'rgba(8,8,24,0.94)');
    if (this.unit) {
      surf.drawText(`${this.unit.name}  Lv${this.unit.level}  ${this.unit.exp}exp`, 10, 8, 'white', '8px monospace');
      surf.drawText(`+${this.expToGain} EXP  (cost ${this.stagedCost()} BEXP)`, 10, 24, 'rgba(220,200,128,1)', '8px monospace');
      surf.drawText(`BEXP: ${game.parties.get(game.currentParty)?.bexp ?? 0}`, 10, 40, 'white', '8px monospace');
      surf.drawText('Right +1 / Left -1 / Up max / Down reset / Select confirm', 10, viewport.height - 16, 'rgba(160,160,200,1)', '6px monospace');
    }
    return surf;
  }
}

// ============================================================================
// PartyTransferState — Python party_transfer dual-roster reassignment
// ============================================================================


export class PartyTransferState extends State {
  readonly name = 'party_transfer';
  override readonly showMap = false;
  override readonly inLevel = false;

  private topParty = '';
  private bottomParty = '';
  private fixedNids: Set<string> = new Set();
  private topName = '';
  private bottomName = '';
  private topLimit = 0;
  private bottomLimit = 0;
  /** Staged assignment: unitNid -> party nid (harness-visible). */
  staged: Map<string, string> = new Map();
  private cursorList: 'top' | 'bottom' = 'top';
  private cursorIdx = 0;

  override start(): StateResult {
    const game = getGame();
    const params = game.memory.get('party_transfer') ?? [];
    const [top, bottom, fixed, topName, bottomName, topLimit, bottomLimit] = params;
    this.topParty = top ?? '';
    this.bottomParty = bottom ?? '';
    this.fixedNids = new Set<string>(fixed ?? []);
    this.topName = topName || this.topParty;
    this.bottomName = bottomName || this.bottomParty;
    this.topLimit = topLimit ?? 0;
    this.bottomLimit = bottomLimit ?? 0;
    this.staged = new Map();
    for (const unit of game.units.values()) {
      if (unit.party === this.topParty || unit.party === this.bottomParty) {
        this.staged.set(unit.nid, unit.party);
      }
    }
  }

  /** Units currently staged for a side, in registry order. */
  listFor(party: string): string[] {
    return [...this.staged.entries()].filter(([, p]) => p === party).map(([nid]) => nid);
  }

  /** Toggle a unit's staged party; enforces fixed units and side limits.
   * Returns whether the move applied (harness-callable). */
  moveUnit(nid: string): boolean {
    if (this.fixedNids.has(nid) || !this.staged.has(nid)) return false;
    const from = this.staged.get(nid)!;
    const to = from === this.topParty ? this.bottomParty : this.topParty;
    const limit = to === this.topParty ? this.topLimit : this.bottomLimit;
    if (limit > 0 && this.listFor(to).length >= limit) return false;
    this.staged.set(nid, to);
    return true;
  }

  /** Apply all staged reassignments reversibly and exit (harness-callable). */
  confirm(): void {
    const game = getGame();
    for (const [nid, party] of this.staged) {
      const unit = game.units.get(nid);
      if (unit && unit.party !== party) {
        game.actionLog.doAction(new SetUnitPartyAction(unit, party));
      }
    }
    game.state.back();
  }

  override takeInput(event: InputEvent): StateResult {
    const game = getGame();
    const list = this.listFor(this.cursorList === 'top' ? this.topParty : this.bottomParty);
    if (event === 'UP') {
      this.cursorIdx = Math.max(0, this.cursorIdx - 1);
    } else if (event === 'DOWN') {
      this.cursorIdx = Math.min(Math.max(0, list.length - 1), this.cursorIdx + 1);
    } else if (event === 'LEFT' || event === 'RIGHT') {
      this.cursorList = this.cursorList === 'top' ? 'bottom' : 'top';
      this.cursorIdx = 0;
    } else if (event === 'SELECT') {
      const nid = list[this.cursorIdx];
      if (nid) this.moveUnit(nid);
    } else if (event === 'START') {
      this.confirm();
    } else if (event === 'BACK') {
      game.state.back(); // cancel: staged changes discarded
    }
  }

  override draw(surf: Surface): Surface {
    surf.fillRect(0, 0, viewport.width, viewport.height, 'rgba(8,8,24,0.94)');
    const half = Math.floor(viewport.height / 2);
    const drawList = (party: string, label: string, y0: number, active: boolean) => {
      surf.drawText(`${label} (${this.listFor(party).length})`, 8, y0, active ? 'rgba(220,200,128,1)' : 'white', '8px monospace');
      this.listFor(party).slice(0, 6).forEach((nid, i) => {
        const marker = active && i === this.cursorIdx ? '>' : ' ';
        const fixed = this.fixedNids.has(nid) ? ' *' : '';
        surf.drawText(`${marker}${nid}${fixed}`, 12, y0 + 12 + i * 10, 'white', '7px monospace');
      });
    };
    drawList(this.topParty, this.topName, 6, this.cursorList === 'top');
    drawList(this.bottomParty, this.bottomName, half + 2, this.cursorList === 'bottom');
    surf.drawText('Select: move / Start: confirm / Back: cancel', 8, viewport.height - 12, 'rgba(160,160,200,1)', '6px monospace');
    return surf;
  }
}

// ============================================================================
// BaseManageState — Python prep.PrepManageState/base unit management (subset)
// ============================================================================

export class BaseManageState extends State {
  readonly name = 'base_manage';
  override readonly showMap = false;
  override readonly inLevel = false;

  /** 'units' -> pick a unit; 'options' -> pick an action; 'partner' -> trade partner. */
  phase: 'units' | 'options' | 'partner' = 'units';
  private unitMenu: ChoiceMenu | null = null;
  private optionMenu: ChoiceMenu | null = null;
  private partnerMenu: ChoiceMenu | null = null;
  private selectedNid: string | null = null;

  private partyUnits(): any[] {
    const game = getGame();
    const partyNid = game.currentParty;
    return [...game.units.values()].filter((u: any) =>
      u.team === 'player' && !u.dead && (!partyNid || !u.party || u.party === partyNid));
  }

  override begin(): StateResult {
    if (this.phase === 'units') this.buildUnitMenu();
    else if (this.phase === 'options') this.buildOptionMenu();
  }

  private buildUnitMenu(): void {
    const options: MenuOption[] = this.partyUnits().map((u: any) => ({
      label: `${u.name} Lv${u.level}`, value: u.nid, enabled: true,
      description: 'Manage this unit.',
    }));
    options.push({ label: 'Back', value: 'back', enabled: true, description: 'Return.' });
    this.unitMenu = new ChoiceMenu(options, 8, 20);
    this.phase = 'units';
  }

  private buildOptionMenu(): void {
    const game = getGame();
    const unit = game.units.get(this.selectedNid ?? '');
    const tradePartners = unit
      ? this.partyUnits().filter((candidate: any) =>
          candidate !== unit && canTradeWith(unit, candidate, game.db, game))
      : [];
    const hasBaseUseItem = !!unit?.items.some((item: any) => item.hasComponent('usable_in_base'));
    const options: MenuOption[] = [
      { label: 'Trade', value: 'trade', enabled: tradePartners.length > 0, description: 'Trade items with an ally.' },
      { label: 'Supply', value: 'supply', enabled: !!game.gameVars.get('_convoy'), description: 'Store and retrieve items.' },
      { label: 'Use', value: 'use', enabled: hasBaseUseItem, description: 'Use a base-compatible item.' },
      { label: 'Back', value: 'back', enabled: true, description: 'Return.' },
    ];
    this.optionMenu = new ChoiceMenu(options, 60, 40);
    this.phase = 'options';
  }

  private buildPartnerMenu(): void {
    const game = getGame();
    const unit = game.units.get(this.selectedNid ?? '');
    const options: MenuOption[] = this.partyUnits()
      .filter((candidate: any) =>
        !!unit && candidate !== unit && canTradeWith(unit, candidate, game.db, game))
      .map((u: any) => ({ label: u.name, value: u.nid, enabled: true, description: 'Trade with this unit.' }));
    options.push({ label: 'Back', value: 'back', enabled: true, description: 'Return.' });
    this.partnerMenu = new ChoiceMenu(options, 100, 40);
    this.phase = 'partner';
  }

  override takeInput(event: InputEvent): StateResult {
    const game = getGame();
    const menu = this.phase === 'units' ? this.unitMenu
      : this.phase === 'options' ? this.optionMenu : this.partnerMenu;
    if (!menu) return;
    const result = menu.handleInput(event);
    if (!result) return;
    if ('back' in result) {
      if (this.phase === 'units') game.state.back();
      else if (this.phase === 'options') this.buildUnitMenu();
      else this.buildOptionMenu();
      return;
    }
    if (result.selected === 'back') {
      if (this.phase === 'units') game.state.back();
      else if (this.phase === 'options') this.buildUnitMenu();
      else this.buildOptionMenu();
      return;
    }
    if (this.phase === 'units') {
      this.selectedNid = result.selected;
      this.buildOptionMenu();
    } else if (this.phase === 'options') {
      const unit = game.units.get(this.selectedNid ?? '');
      if (!unit) { this.buildUnitMenu(); return; }
      if (result.selected === 'trade') {
        this.buildPartnerMenu();
      } else if (result.selected === 'supply') {
        game.memory.set('supply_unit', unit);
        game.state.change('supply_items');
      } else if (result.selected === 'use') {
        game.selectedUnit = unit;
        game.memory.set('base_use_unit', unit);
        game.state.change('base_use');
      }
    } else {
      const partner = game.units.get(result.selected);
      const unit = game.units.get(this.selectedNid ?? '');
      if (unit && partner) {
        game.selectedUnit = unit;
        game.memory.set('trade_partner', partner);
        game.state.change('trade');
      }
    }
  }

  override draw(surf: Surface): Surface {
    surf.fillRect(0, 0, viewport.width, viewport.height, 'rgba(8,8,24,0.94)');
    surf.drawText('Unit Management', 8, 5, 'rgba(220,200,128,1)', '9px monospace');
    this.unitMenu?.draw(surf);
    if (this.phase !== 'units') this.optionMenu?.draw(surf);
    if (this.phase === 'partner') this.partnerMenu?.draw(surf);
    return surf;
  }
}
