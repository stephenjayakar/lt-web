import type { UnitObject } from '../objects/unit';
import type { Database } from '../data/database';

/**
 * Fixed screen-space dimensions (in CSS pixels).
 * Scaled by DPR when drawing to the canvas.
 */
const UNIT_PANEL_W = 160;
const UNIT_PANEL_H = 96;
const TERRAIN_PANEL_W = 128;
const TERRAIN_PANEL_H = 56;
const PANEL_MARGIN = 8;
const INNER_PAD = 8;
const LINE_HEIGHT = 20;

const BG_COLOR = 'rgba(16, 16, 32, 0.82)';
const BORDER_COLOR = 'rgba(160, 160, 200, 0.5)';
const INNER_BORDER = 'rgba(80, 80, 120, 0.4)';

/**
 * HUD - Heads-up display showing unit/terrain info.
 *
 * Draws directly to the display canvas at fixed screen-pixel sizes,
 * so it doesn't scale with map zoom.
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

  setHover(unit: UnitObject | null, terrainName: string, terrainDef: number): void {
    this.hoveredUnit = unit;
    this.terrainName = terrainName;
    this.terrainDefense = terrainDef;
  }

  /**
   * Draw the HUD overlay onto the display canvas context.
   * Coordinates are in physical pixels (pre-scaled by DPR).
   */
  drawScreen(ctx: CanvasRenderingContext2D, screenW: number, screenH: number, _db: Database): void {
    const dpr = window.devicePixelRatio || 1;

    if (this.hoveredUnit) {
      this.drawUnitInfo(ctx, this.hoveredUnit, dpr, screenH);
    }
    if (this.terrainName) {
      this.drawTerrainInfo(ctx, dpr, screenW, screenH);
    }
  }

  private drawUnitInfo(ctx: CanvasRenderingContext2D, unit: UnitObject, dpr: number, screenH: number): void {
    const s = dpr;
    const px = PANEL_MARGIN * s;
    const py = screenH * s - (UNIT_PANEL_H + PANEL_MARGIN) * s;
    const pw = UNIT_PANEL_W * s;
    const ph = UNIT_PANEL_H * s;

    // Background
    ctx.fillStyle = BG_COLOR;
    ctx.fillRect(px, py, pw, ph);

    // Double border
    ctx.strokeStyle = BORDER_COLOR;
    ctx.lineWidth = s;
    ctx.strokeRect(px + 0.5, py + 0.5, pw - 1, ph - 1);
    ctx.strokeStyle = INNER_BORDER;
    ctx.strokeRect(px + s + 0.5, py + s + 0.5, pw - 2 * s - 1, ph - 2 * s - 1);

    const textX = px + INNER_PAD * s;
    let textY = py + INNER_PAD * s;

    ctx.textBaseline = 'top';

    // Unit name
    ctx.font = `bold ${14 * s}px monospace`;
    ctx.fillStyle = 'white';
    ctx.fillText(unit.name, textX, textY);
    textY += LINE_HEIGHT * s;

    // Class + Level
    ctx.font = `${12 * s}px monospace`;
    ctx.fillStyle = 'rgba(200, 200, 220, 1)';
    ctx.fillText(`Lv ${unit.level} ${unit.klass}`, textX, textY);
    textY += LINE_HEIGHT * s;

    // HP bar
    ctx.font = `${12 * s}px monospace`;
    ctx.fillStyle = 'rgba(200, 200, 220, 1)';
    ctx.fillText('HP', textX, textY);
    const barX = textX + 24 * s;
    const barW = pw - INNER_PAD * 2 * s - 24 * s;
    this.drawHpBar(ctx, barX, textY + 2 * s, unit.currentHp, unit.maxHp, barW, 10 * s);
    textY += LINE_HEIGHT * s;

    // HP numbers
    ctx.font = `${12 * s}px monospace`;
    ctx.fillStyle = 'rgba(200, 200, 220, 1)';
    ctx.fillText(`${unit.currentHp}/${unit.maxHp}`, textX, textY);
  }

  private drawTerrainInfo(ctx: CanvasRenderingContext2D, dpr: number, screenW: number, screenH: number): void {
    const s = dpr;
    const px = (screenW - TERRAIN_PANEL_W - PANEL_MARGIN) * s;
    const py = screenH * s - (TERRAIN_PANEL_H + PANEL_MARGIN) * s;
    const pw = TERRAIN_PANEL_W * s;
    const ph = TERRAIN_PANEL_H * s;

    // Background
    ctx.fillStyle = BG_COLOR;
    ctx.fillRect(px, py, pw, ph);

    // Double border
    ctx.strokeStyle = BORDER_COLOR;
    ctx.lineWidth = s;
    ctx.strokeRect(px + 0.5, py + 0.5, pw - 1, ph - 1);
    ctx.strokeStyle = INNER_BORDER;
    ctx.strokeRect(px + s + 0.5, py + s + 0.5, pw - 2 * s - 1, ph - 2 * s - 1);

    const textX = px + INNER_PAD * s;
    let textY = py + INNER_PAD * s;

    ctx.textBaseline = 'top';

    // Terrain name
    ctx.font = `bold ${14 * s}px monospace`;
    ctx.fillStyle = 'white';
    ctx.fillText(this.terrainName, textX, textY);
    textY += LINE_HEIGHT * s;

    // Defense bonus
    ctx.font = `${12 * s}px monospace`;
    ctx.fillStyle = 'rgba(160, 220, 160, 1)';
    const defText = `Def ${this.terrainDefense >= 0 ? '+' : ''}${this.terrainDefense}`;
    ctx.fillText(defText, textX, textY);
  }

  private drawHpBar(
    ctx: CanvasRenderingContext2D,
    x: number, y: number,
    current: number, max: number,
    width: number, height: number,
  ): void {
    const ratio = max > 0 ? Math.max(0, Math.min(1, current / max)) : 0;

    // Background
    ctx.fillStyle = 'rgba(32, 32, 32, 1)';
    ctx.fillRect(x, y, width, height);

    // Fill
    let barColor: string;
    if (ratio > 0.5) barColor = 'rgba(64, 200, 64, 1)';
    else if (ratio > 0.25) barColor = 'rgba(220, 200, 32, 1)';
    else barColor = 'rgba(220, 48, 48, 1)';

    const filledWidth = Math.round(width * ratio);
    if (filledWidth > 0) {
      ctx.fillStyle = barColor;
      ctx.fillRect(x, y, filledWidth, height);
    }

    // Border
    ctx.strokeStyle = 'rgba(120, 120, 120, 1)';
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, width - 1, height - 1);
  }
}
