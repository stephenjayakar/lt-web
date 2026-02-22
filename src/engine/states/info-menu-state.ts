/**
 * InfoMenuState — Detailed unit information screen with three pages:
 *   1. Personal Data (stats, class, level)
 *   2. Equipment (items, battle stats)
 *   3. Skills (weapon experience, skill list)
 *
 * Invoked from FreeState when INFO is pressed on a unit.
 * Uses game.infoMenuUnit to know which unit to display.
 */

import { State } from '../state';
import type { StateResult } from '../state';
import { Surface } from '../surface';
import type { InputEvent } from '../input';
import { viewport } from '../viewport';
import { ANIMATION_COUNTERS } from '../constants';
import type { UnitObject } from '../../objects/unit';
import { drawItemIcon, drawIcon16 } from '../../ui/icons';
import {
  accuracy,
  damage,
  avoid,
  attackSpeed,
  computeCrit,
  getEquippedWeapon,
} from '../../combat/combat-calcs';
import { FONT } from '../../rendering/bmp-font';

// ---------------------------------------------------------------------------
// Lazy game reference — matches the pattern from game-states.ts
// ---------------------------------------------------------------------------

let _game: any = null;

export function setInfoMenuGameRef(g: any): void {
  _game = g;
}

function getGame(): any {
  if (!_game) throw new Error('InfoMenuState: game reference not set.');
  return _game;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PAGE_COUNT = 3;
const PAGE_NAMES = ['Personal Data', 'Equipment', 'Skills'];

/** Left panel width in game pixels. */
const LEFT_PANEL_W = 96;

/** Background colors. */
const BG_COLOR = 'rgba(16, 20, 48, 1)';
const PANEL_BG = 'rgba(24, 28, 64, 1)';
const DIVIDER_COLOR = 'rgba(56, 60, 100, 1)';
const HEADER_BG = 'rgba(32, 40, 80, 1)';

/** Text colors (mapped to BMP font palette names where possible). */
const COLOR_WHITE = 'white';
const COLOR_YELLOW = 'rgba(248,240,136,1)';
const COLOR_BLUE = 'rgba(200,200,255,1)';
const COLOR_GREY = 'rgba(160,160,200,1)';
const COLOR_GREEN = 'rgba(128,220,128,1)';
const COLOR_BAR_BG = 'rgba(40, 44, 72, 1)';
const COLOR_BAR_FILL = 'rgba(80, 160, 220, 1)';
const COLOR_HP_BAR = 'rgba(80, 200, 100, 1)';

// Stat display order
const STATS_LEFT = ['HP', 'STR', 'MAG', 'SKL', 'SPD'];
const STATS_RIGHT = ['LCK', 'DEF', 'RES', 'CON', 'MOV'];

// ---------------------------------------------------------------------------
// InfoMenuState
// ---------------------------------------------------------------------------

export class InfoMenuState extends State {
  readonly name = 'info_menu';
  override readonly transparent = false;
  override readonly showMap = false;

  private currentPage: number = 0;
  private unit: UnitObject | null = null;
  private unitList: UnitObject[] = [];
  private unitIndex: number = 0;

  /** Portrait image cache (keyed by portrait NID). */
  private portraitCache: Map<string, HTMLImageElement> = new Map();
  private loadingPortraits: Set<string> = new Set();

  override start(): StateResult {
    // Nothing to do on first push
  }

  override begin(): StateResult {
    const game = getGame();
    this.unit = game.infoMenuUnit ?? null;
    if (!this.unit) {
      game.state.back();
      return;
    }

    // Build list of same-team units for UP/DOWN cycling
    this.unitList = [];
    if (game.board) {
      const allUnits: UnitObject[] = game.board.getAllUnits();
      for (const u of allUnits) {
        if (u.team === this.unit.team && !u.isDead() && u.position) {
          this.unitList.push(u);
        }
      }
    }
    // Fallback: just the single unit
    if (this.unitList.length === 0) {
      this.unitList = [this.unit];
    }

    this.unitIndex = this.unitList.indexOf(this.unit);
    if (this.unitIndex < 0) this.unitIndex = 0;
  }

  override takeInput(event: InputEvent): StateResult {
    if (event === null) return;
    const game = getGame();

    switch (event) {
      case 'LEFT':
        this.currentPage = (this.currentPage - 1 + PAGE_COUNT) % PAGE_COUNT;
        break;
      case 'RIGHT':
        this.currentPage = (this.currentPage + 1) % PAGE_COUNT;
        break;
      case 'UP':
        if (this.unitList.length > 1) {
          this.unitIndex = (this.unitIndex - 1 + this.unitList.length) % this.unitList.length;
          this.unit = this.unitList[this.unitIndex];
          game.infoMenuUnit = this.unit;
        }
        break;
      case 'DOWN':
        if (this.unitList.length > 1) {
          this.unitIndex = (this.unitIndex + 1) % this.unitList.length;
          this.unit = this.unitList[this.unitIndex];
          game.infoMenuUnit = this.unit;
        }
        break;
      case 'BACK':
        game.state.back();
        break;
      case 'SELECT':
        // Could toggle extra details; for now do nothing
        break;
    }
  }

  override draw(surf: Surface): Surface {
    if (!this.unit) return surf;

    const vw = viewport.width;
    const vh = viewport.height;

    // Dark background
    surf.fillRect(0, 0, vw, vh, BG_COLOR);

    // Draw left panel
    this.drawLeftPanel(surf, vw, vh);

    // Draw divider line
    surf.fillRect(LEFT_PANEL_W, 0, 1, vh, DIVIDER_COLOR);

    // Draw page header
    this.drawPageHeader(surf, vw);

    // Draw right panel content based on current page
    switch (this.currentPage) {
      case 0:
        this.drawPersonalData(surf, vw, vh);
        break;
      case 1:
        this.drawEquipment(surf, vw, vh);
        break;
      case 2:
        this.drawSkills(surf, vw, vh);
        break;
    }

    // Draw page indicator dots at the bottom
    this.drawPageIndicator(surf, vw, vh);

    return surf;
  }

  // =======================================================================
  // Left Panel — Portrait, name, class, level, HP, map sprite
  // =======================================================================

  private drawLeftPanel(surf: Surface, _vw: number, vh: number): void {
    const unit = this.unit!;
    const game = getGame();

    // Panel background
    surf.fillRect(0, 0, LEFT_PANEL_W, vh, PANEL_BG);

    // Portrait area (placeholder — filled rectangle with initials)
    const portraitX = 8;
    const portraitY = 8;
    const portraitW = 80;
    const portraitH = 72;

    // Try to draw the actual portrait
    let drewPortrait = false;
    if (unit.portraitNid) {
      const cached = this.portraitCache.get(unit.portraitNid);
      if (cached) {
        // Portrait sprite sheets are 128x112; draw the main face (top-left 96x80)
        surf.blitImage(
          cached,
          0, 0, 96, 80,
          portraitX, portraitY,
        );
        drewPortrait = true;
      } else if (!this.loadingPortraits.has(unit.portraitNid)) {
        // Kick off async load
        const nid = unit.portraitNid;
        this.loadingPortraits.add(nid);
        game.resources.tryLoadImage(`resources/portraits/${nid}.png`).then((img: HTMLImageElement | null) => {
          if (img) this.portraitCache.set(nid, img);
          this.loadingPortraits.delete(nid);
        });
      }
    }

    if (!drewPortrait) {
      // Placeholder with unit initials
      surf.fillRect(portraitX, portraitY, portraitW, portraitH, 'rgba(40,44,80,1)');
      surf.drawRect(portraitX, portraitY, portraitW, portraitH, DIVIDER_COLOR);
      const initials = unit.name.substring(0, 2).toUpperCase();
      this.drawTextCentered(surf, initials, portraitX + portraitW / 2, portraitY + portraitH / 2 - 6, COLOR_WHITE, 'text');
    }

    // Unit name (centered)
    this.drawTextCentered(surf, unit.name, LEFT_PANEL_W / 2, 90, COLOR_WHITE, 'text');

    // Class name
    const klassDef = game.db.classes.get(unit.klass);
    const klassName = klassDef?.name ?? unit.klass;
    this.drawSmallText(surf, klassName, 8, 104, COLOR_GREY);

    // Level / Exp
    this.drawSmallText(surf, 'Lv', 8, 118, COLOR_YELLOW);
    this.drawSmallTextRight(surf, String(unit.level), 40, 118, COLOR_BLUE);
    this.drawSmallText(surf, 'Exp', 48, 118, COLOR_YELLOW);
    this.drawSmallTextRight(surf, String(unit.exp), 88, 118, COLOR_BLUE);

    // HP bar
    this.drawSmallText(surf, 'HP', 8, 132, COLOR_YELLOW);
    const hpText = `${unit.currentHp}/${unit.maxHp}`;
    this.drawSmallTextRight(surf, hpText, 88, 132, COLOR_BLUE);

    // HP bar visual
    const barX = 8;
    const barY = 144;
    const barW = 80;
    const barH = 3;
    surf.fillRect(barX, barY, barW, barH, COLOR_BAR_BG);
    const hpFrac = unit.maxHp > 0 ? unit.currentHp / unit.maxHp : 0;
    const hpColor = hpFrac > 0.5 ? COLOR_HP_BAR : hpFrac > 0.25 ? 'rgba(220,200,60,1)' : 'rgba(220,60,60,1)';
    surf.fillRect(barX, barY, Math.floor(barW * hpFrac), barH, hpColor);

    // Animated map sprite at bottom of left panel
    if (unit.sprite && typeof unit.sprite === 'object' && 'getFrame' in unit.sprite) {
      const spr = unit.sprite as any;
      const frame = spr.getFrame('standing', ANIMATION_COUNTERS.passive);
      if (frame) {
        const spriteX = LEFT_PANEL_W / 2 - 16;
        const spriteY = vh - 28;
        if (frame instanceof Surface) {
          surf.blit(frame, spriteX, spriteY);
        } else if (frame.canvas) {
          surf.blit(frame, spriteX, spriteY);
        }
      }
    }
  }

  // =======================================================================
  // Page Header
  // =======================================================================

  private drawPageHeader(surf: Surface, vw: number): void {
    const headerY = 0;
    const headerH = 18;
    const rightX = LEFT_PANEL_W + 1;
    const rightW = vw - rightX;

    surf.fillRect(rightX, headerY, rightW, headerH, HEADER_BG);

    // Page title
    const title = PAGE_NAMES[this.currentPage];
    this.drawTextCentered(surf, title, rightX + rightW / 2, 3, COLOR_WHITE, 'text');

    // Arrow indicators
    this.drawSmallText(surf, '<', rightX + 4, 4, COLOR_GREY);
    this.drawSmallTextRight(surf, '>', rightX + rightW - 4, 4, COLOR_GREY);
  }

  // =======================================================================
  // Page 0: Personal Data — Stats in two columns with bars
  // =======================================================================

  private drawPersonalData(surf: Surface, vw: number, _vh: number): void {
    const unit = this.unit!;
    const game = getGame();
    const klassDef = game.db.classes.get(unit.klass);

    const rightX = LEFT_PANEL_W + 6;
    const rightW = vw - LEFT_PANEL_W - 12;
    const colW = Math.floor(rightW / 2);
    const startY = 24;
    const rowH = 14;

    // Left column
    for (let i = 0; i < STATS_LEFT.length; i++) {
      const stat = STATS_LEFT[i];
      const y = startY + i * rowH;
      this.drawStatRow(surf, stat, unit, klassDef, rightX, y, colW);
    }

    // Right column
    for (let i = 0; i < STATS_RIGHT.length; i++) {
      const stat = STATS_RIGHT[i];
      const y = startY + i * rowH;
      this.drawStatRow(surf, stat, unit, klassDef, rightX + colW, y, colW);
    }

    // Aid / Traveler below stats (if rescuing)
    const bottomY = startY + Math.max(STATS_LEFT.length, STATS_RIGHT.length) * rowH + 4;
    if (unit.isRescuing() && unit.rescuing) {
      this.drawSmallText(surf, 'Trv', rightX, bottomY, COLOR_YELLOW);
      this.drawSmallText(surf, unit.rescuing.name, rightX + 28, bottomY, COLOR_BLUE);
    }

    // Affinity (if available)
    const unitPrefab = game.db.units.get(unit.nid);
    if (unitPrefab?.affinity) {
      this.drawSmallText(surf, 'Affin', rightX + colW, bottomY, COLOR_YELLOW);
      this.drawSmallText(surf, unitPrefab.affinity, rightX + colW + 36, bottomY, COLOR_BLUE);
    }
  }

  private drawStatRow(
    surf: Surface,
    statName: string,
    unit: UnitObject,
    klassDef: any,
    x: number,
    y: number,
    colW: number,
  ): void {
    const value = unit.getStatValue(statName);
    const maxStat = klassDef?.max_stats?.[statName] ?? 40;

    // Stat label
    this.drawSmallText(surf, statName, x, y, COLOR_YELLOW);

    // Stat value (right-aligned within column)
    const valueStr = String(value);
    this.drawSmallTextRight(surf, valueStr, x + colW - 4, y, COLOR_BLUE);

    // Stat bar (shows fraction of max)
    const barX = x + 28;
    const barW = colW - 40;
    const barY = y + 9;
    const barH = 2;

    if (barW > 0) {
      surf.fillRect(barX, barY, barW, barH, COLOR_BAR_BG);
      const frac = maxStat > 0 ? Math.min(1, value / maxStat) : 0;
      const fillColor = frac >= 1.0 ? COLOR_GREEN : COLOR_BAR_FILL;
      surf.fillRect(barX, barY, Math.floor(barW * frac), barH, fillColor);
    }
  }

  // =======================================================================
  // Page 1: Equipment — Items list + battle stats
  // =======================================================================

  private drawEquipment(surf: Surface, vw: number, vh: number): void {
    const unit = this.unit!;
    const game = getGame();

    const rightX = LEFT_PANEL_W + 6;
    const rightW = vw - LEFT_PANEL_W - 12;
    const startY = 24;

    // --- Items list ---
    this.drawSmallText(surf, 'Items', rightX, startY, COLOR_YELLOW);

    const itemStartY = startY + 14;
    if (unit.items.length === 0) {
      this.drawSmallText(surf, '(none)', rightX + 4, itemStartY, COLOR_GREY);
    } else {
      for (let i = 0; i < unit.items.length; i++) {
        const item = unit.items[i];
        const y = itemStartY + i * 16;

        // Item icon (16x16)
        drawItemIcon(surf, item, rightX, y);

        // Item name
        const nameColor = item.isWeapon() ? COLOR_WHITE : COLOR_BLUE;
        this.drawSmallText(surf, item.name, rightX + 18, y + 2, nameColor);

        // Uses (right-aligned)
        if (item.maxUses > 0) {
          const usesStr = `${item.uses}/${item.maxUses}`;
          this.drawSmallTextRight(surf, usesStr, rightX + rightW, y + 2, COLOR_GREY);
        }
      }
    }

    // --- Battle stats panel ---
    const battleY = itemStartY + Math.max(unit.items.length, 1) * 16 + 8;

    // Separator line
    surf.fillRect(rightX, battleY - 2, rightW, 1, DIVIDER_COLOR);

    this.drawSmallText(surf, 'Battle Stats', rightX, battleY, COLOR_YELLOW);

    const weapon = getEquippedWeapon(unit);
    const bsY = battleY + 14;
    const halfW = Math.floor(rightW / 2);

    if (weapon) {
      // Compute battle stats
      const atk = damage(unit, weapon, game.db);
      const hit = accuracy(unit, weapon, game.db);
      const crt = computeCrit(unit, weapon, unit, game.db); // self as dummy defender for display
      const as = attackSpeed(unit, weapon, game.db);
      const avo = avoid(unit, game.db);

      // Left column
      this.drawBattleStat(surf, 'Atk', String(atk), rightX, bsY);
      this.drawBattleStat(surf, 'Hit', String(hit), rightX, bsY + 12);
      this.drawBattleStat(surf, 'Crit', String(crt), rightX, bsY + 24);

      // Right column
      this.drawBattleStat(surf, 'AS', String(as), rightX + halfW, bsY);
      this.drawBattleStat(surf, 'Avoid', String(avo), rightX + halfW, bsY + 12);

      // Range
      const minR = weapon.getMinRange();
      const maxR = weapon.getMaxRange();
      const rangeStr = minR === maxR ? String(minR) : `${minR}-${maxR}`;
      this.drawBattleStat(surf, 'Rng', rangeStr, rightX + halfW, bsY + 24);
    } else {
      this.drawSmallText(surf, 'No weapon equipped', rightX + 4, bsY, COLOR_GREY);
    }
  }

  private drawBattleStat(surf: Surface, label: string, value: string, x: number, y: number): void {
    this.drawSmallText(surf, label, x, y, COLOR_YELLOW);
    this.drawSmallTextRight(surf, value, x + 50, y, COLOR_WHITE);
  }

  // =======================================================================
  // Page 2: Skills — Weapon experience + skill list
  // =======================================================================

  private drawSkills(surf: Surface, vw: number, _vh: number): void {
    const unit = this.unit!;
    const game = getGame();

    const rightX = LEFT_PANEL_W + 6;
    const rightW = vw - LEFT_PANEL_W - 12;
    const startY = 24;

    // --- Weapon experience ---
    this.drawSmallText(surf, 'Weapon Rank', rightX, startY, COLOR_YELLOW);

    const wexpY = startY + 14;
    const wexpEntries = Object.entries(unit.wexp);
    if (wexpEntries.length === 0) {
      this.drawSmallText(surf, '(none)', rightX + 4, wexpY, COLOR_GREY);
    } else {
      const colW = Math.floor(rightW / 2);
      for (let i = 0; i < wexpEntries.length; i++) {
        const [wtype, wexpValue] = wexpEntries[i];
        const col = i % 2;
        const row = Math.floor(i / 2);
        const x = rightX + col * colW;
        const y = wexpY + row * 12;

        // Weapon type name
        this.drawSmallText(surf, wtype, x, y, COLOR_GREY);

        // Rank letter
        const rank = this.getWexpRank(wexpValue, game);
        this.drawSmallTextRight(surf, rank, x + colW - 4, y, COLOR_WHITE);
      }
    }

    // --- Skills list ---
    const wexpRows = Math.ceil(wexpEntries.length / 2);
    const skillHeaderY = wexpY + Math.max(wexpRows, 1) * 12 + 8;

    // Separator
    surf.fillRect(rightX, skillHeaderY - 2, rightW, 1, DIVIDER_COLOR);

    this.drawSmallText(surf, 'Skills', rightX, skillHeaderY, COLOR_YELLOW);

    const skillStartY = skillHeaderY + 14;
    if (unit.skills.length === 0) {
      this.drawSmallText(surf, '(none)', rightX + 4, skillStartY, COLOR_GREY);
    } else {
      for (let i = 0; i < unit.skills.length; i++) {
        const skill = unit.skills[i];
        const y = skillStartY + i * 16;

        // Skill icon
        if (skill.iconNid) {
          drawIcon16(surf, skill.iconNid, skill.iconIndex, rightX, y);
        }

        // Skill name
        this.drawSmallText(surf, skill.name, rightX + 18, y + 2, COLOR_WHITE);
      }
    }
  }

  /**
   * Convert a weapon experience value to a rank letter using the DB's
   * weapon rank thresholds.
   */
  private getWexpRank(wexp: number, game: any): string {
    const ranks = game.db.weaponRanks;
    if (!ranks || ranks.length === 0) return '-';

    let bestRank = '-';
    for (const wr of ranks) {
      if (wexp >= wr.requirement) {
        bestRank = wr.rank;
      }
    }
    return bestRank;
  }

  // =======================================================================
  // Page indicator (dots at bottom)
  // =======================================================================

  private drawPageIndicator(surf: Surface, vw: number, vh: number): void {
    const dotSpacing = 10;
    const totalW = PAGE_COUNT * dotSpacing;
    const startX = Math.floor(vw / 2) - Math.floor(totalW / 2) + Math.floor(dotSpacing / 2);
    const y = vh - 8;

    for (let i = 0; i < PAGE_COUNT; i++) {
      const x = startX + i * dotSpacing;
      const color = i === this.currentPage ? COLOR_WHITE : COLOR_GREY;
      const size = i === this.currentPage ? 3 : 2;
      surf.fillRect(x - Math.floor(size / 2), y - Math.floor(size / 2), size, size, color);
    }
  }

  // =======================================================================
  // Text drawing helpers
  // =======================================================================

  /**
   * Draw text centered at (cx, y) using BMP font if available.
   */
  private drawTextCentered(surf: Surface, text: string, cx: number, y: number, color: string, fontNid: string = 'text'): void {
    const font = FONT[fontNid];
    if (font) {
      font.blitCenter(surf, text, cx, y, this.mapCssColorToFontColor(color));
    } else {
      // Fallback: estimate width
      const estW = text.length * 6;
      surf.drawText(text, cx - Math.floor(estW / 2), y, color, '8px monospace');
    }
  }

  /**
   * Draw small text left-aligned using BMP font.
   */
  private drawSmallText(surf: Surface, text: string, x: number, y: number, color: string): void {
    const font = FONT['text'] ?? FONT['small'];
    if (font) {
      font.blit(surf, text, x, y, this.mapCssColorToFontColor(color));
    } else {
      surf.drawText(text, x, y, color, '7px monospace');
    }
  }

  /**
   * Draw small text right-aligned (text ends at x).
   */
  private drawSmallTextRight(surf: Surface, text: string, x: number, y: number, color: string): void {
    const font = FONT['text'] ?? FONT['small'];
    if (font) {
      font.blitRight(surf, text, x, y, this.mapCssColorToFontColor(color));
    } else {
      const estW = text.length * 5;
      surf.drawText(text, x - estW, y, color, '7px monospace');
    }
  }

  /**
   * Map CSS color strings to BMP font palette names.
   */
  private mapCssColorToFontColor(cssColor: string): string {
    if (cssColor === 'white' || cssColor === COLOR_WHITE) return 'white';
    if (cssColor === COLOR_YELLOW || cssColor.includes('248,240,136') || cssColor.includes('255,240,200')) return 'yellow';
    if (cssColor === COLOR_BLUE || cssColor.includes('200,200,255')) return 'blue';
    if (cssColor === COLOR_GREY || cssColor.includes('160,160,200') || cssColor.includes('160,160,160')) return 'grey';
    if (cssColor === COLOR_GREEN || cssColor.includes('128,220,128')) return 'white';
    return 'white';
  }
}
