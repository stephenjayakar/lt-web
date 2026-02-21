import { Surface } from '../engine/surface';
import { WINWIDTH, WINHEIGHT } from '../engine/constants';
import type { UnitObject } from '../objects/unit';
import type { Database } from '../data/database';

const FONT = '8px monospace';
const FONT_SMALL = '7px monospace';

/** Panel dimensions */
const UNIT_PANEL_W = 80;
const UNIT_PANEL_H = 48;
const TERRAIN_PANEL_W = 64;
const TERRAIN_PANEL_H = 28;
const PANEL_MARGIN = 2;
const INNER_PAD = 4;

const BG_COLOR = 'rgba(16, 16, 32, 0.82)';
const BORDER_COLOR = 'rgba(160, 160, 200, 0.5)';

/**
 * HUD - Heads-up display showing unit/terrain info.
 */
export class HUD {
  private hoveredUnit: UnitObject | null;
  private terrainName: string;
  private terrainDefense: number;

  constructor() {
    this.hoveredUnit = null;
    this.terrainName = '';
    this.terrainDefense = 0;
  }

  /** Set the currently hovered unit/terrain info */
  setHover(unit: UnitObject | null, terrainName: string, terrainDef: number): void {
    this.hoveredUnit = unit;
    this.terrainName = terrainName;
    this.terrainDefense = terrainDef;
  }

  /** Draw the HUD overlay */
  draw(surf: Surface, _db: Database): void {
    if (this.hoveredUnit) {
      this.drawUnitInfo(surf, this.hoveredUnit);
    }
    if (this.terrainName) {
      this.drawTerrainInfo(surf);
    }
  }

  /** Draw unit info panel (name, HP bar, level, class) */
  private drawUnitInfo(surf: Surface, unit: UnitObject): void {
    const px = PANEL_MARGIN;
    const py = WINHEIGHT - UNIT_PANEL_H - PANEL_MARGIN;

    // Background
    surf.fillRect(px, py, UNIT_PANEL_W, UNIT_PANEL_H, BG_COLOR);

    // Pixel-art style double-border
    surf.drawRect(px, py, UNIT_PANEL_W, UNIT_PANEL_H, BORDER_COLOR);
    surf.drawRect(px + 1, py + 1, UNIT_PANEL_W - 2, UNIT_PANEL_H - 2, 'rgba(80, 80, 120, 0.4)');

    const textX = px + INNER_PAD;
    let textY = py + INNER_PAD;

    // Unit name
    surf.drawText(unit.name, textX, textY, 'white', FONT);
    textY += 10;

    // Class name + Level
    const klassName = unit.klass;
    surf.drawText(`Lv ${unit.level} ${klassName}`, textX, textY, 'rgba(200, 200, 220, 1)', FONT_SMALL);
    textY += 10;

    // HP bar
    const hpBarWidth = UNIT_PANEL_W - INNER_PAD * 2;
    surf.drawText('HP', textX, textY, 'rgba(200, 200, 220, 1)', FONT_SMALL);
    this.drawHpBar(surf, textX + 14, textY + 1, unit.currentHp, unit.maxHp, hpBarWidth - 14);
    textY += 10;

    // HP text (numbers)
    const hpText = `${unit.currentHp}/${unit.maxHp}`;
    surf.drawText(hpText, textX, textY, 'rgba(200, 200, 220, 1)', FONT_SMALL);
  }

  /** Draw terrain info panel */
  private drawTerrainInfo(surf: Surface): void {
    const px = WINWIDTH - TERRAIN_PANEL_W - PANEL_MARGIN;
    const py = WINHEIGHT - TERRAIN_PANEL_H - PANEL_MARGIN;

    // Background
    surf.fillRect(px, py, TERRAIN_PANEL_W, TERRAIN_PANEL_H, BG_COLOR);

    // Pixel-art style double-border
    surf.drawRect(px, py, TERRAIN_PANEL_W, TERRAIN_PANEL_H, BORDER_COLOR);
    surf.drawRect(px + 1, py + 1, TERRAIN_PANEL_W - 2, TERRAIN_PANEL_H - 2, 'rgba(80, 80, 120, 0.4)');

    const textX = px + INNER_PAD;
    let textY = py + INNER_PAD;

    // Terrain name
    surf.drawText(this.terrainName, textX, textY, 'white', FONT);
    textY += 10;

    // Defense bonus
    const defText = `Def ${this.terrainDefense >= 0 ? '+' : ''}${this.terrainDefense}`;
    surf.drawText(defText, textX, textY, 'rgba(160, 220, 160, 1)', FONT_SMALL);
  }

  /** Draw an HP bar */
  private drawHpBar(
    surf: Surface,
    x: number,
    y: number,
    current: number,
    max: number,
    width: number,
  ): void {
    const height = 6;
    const ratio = max > 0 ? Math.max(0, Math.min(1, current / max)) : 0;

    // Background (dark)
    surf.fillRect(x, y, width, height, 'rgba(32, 32, 32, 1)');

    // Filled portion — color depends on ratio
    let barColor: string;
    if (ratio > 0.5) {
      barColor = 'rgba(64, 200, 64, 1)'; // green
    } else if (ratio > 0.25) {
      barColor = 'rgba(220, 200, 32, 1)'; // yellow
    } else {
      barColor = 'rgba(220, 48, 48, 1)'; // red
    }

    const filledWidth = Math.round(width * ratio);
    if (filledWidth > 0) {
      surf.fillRect(x, y, filledWidth, height, barColor);
    }

    // 1px border around the bar
    surf.drawRect(x, y, width, height, 'rgba(120, 120, 120, 1)');
  }
}
