import type { UnitObject } from '../objects/unit';
import type { Database } from '../data/database';
import type { ResourceManager } from '../data/resource-manager';

/**
 * Base dimensions at the "mobile" reference size (CSS pixels).
 * These get multiplied by hudScale() on larger screens.
 */
const BASE_UNIT_PANEL_W = 160;
const BASE_UNIT_PANEL_H = 96;
const BASE_TERRAIN_PANEL_W = 128;
const BASE_TERRAIN_PANEL_H = 74;
const BASE_PANEL_MARGIN = 8;
const BASE_INNER_PAD = 8;
const BASE_LINE_HEIGHT = 20;
const BASE_FONT_MAIN = 14;
const BASE_FONT_SUB = 12;
const BASE_HP_LABEL_OFFSET = 24;
const BASE_HP_BAR_HEIGHT = 10;

const BG_COLOR = 'rgba(16, 16, 32, 0.82)';
const BORDER_COLOR = 'rgba(160, 160, 200, 0.5)';
const INNER_BORDER = 'rgba(80, 80, 120, 0.4)';

/**
 * Compute a scale factor for the HUD based on screen size.
 * Returns 1.0 at 375px narrow axis (iPhone), scales up linearly
 * for larger screens (e.g. ~2.0 at 1440px wide desktop).
 */
function hudScale(screenW: number, screenH: number): number {
  const narrow = Math.min(screenW, screenH);
  // 375px -> 1.0, 1440px -> 2.5, clamped to [1.0, 3.0]
  const scale = narrow / 375;
  return Math.max(1.0, Math.min(3.0, scale));
}

/**
 * HUD - Heads-up display showing unit/terrain info.
 *
 * Draws directly to the display canvas at fixed screen-pixel sizes,
 * so it doesn't scale with map zoom.
 */
export class HUD {
  /** Whether the HUD is visible. Set to false during combat, events, etc. */
  visible: boolean;

  private hoveredUnit: UnitObject | null;
  private terrainName: string;
  private terrainDefense: number;
  private terrainAvoid: number;

  /** Cached chibi portrait images, keyed by portrait NID. */
  private chibiCache: Map<string, HTMLImageElement> = new Map();
  /** Portrait NIDs currently being loaded (to avoid duplicate fetches). */
  private loadingPortraits: Set<string> = new Set();
  /** Optional reference to the resource manager for loading portraits. */
  private resourceManager: ResourceManager | null = null;

  constructor() {
    this.visible = true;
    this.hoveredUnit = null;
    this.terrainName = '';
    this.terrainDefense = 0;
    this.terrainAvoid = 0;
  }

  /** Set the resource manager reference (call once after construction). */
  setResourceManager(rm: ResourceManager): void {
    this.resourceManager = rm;
  }

  /** Set the currently hovered unit/terrain info */
  setHover(unit: UnitObject | null, terrainName: string, terrainDef: number, terrainAvo: number): void {
    this.hoveredUnit = unit;
    this.terrainName = terrainName;
    this.terrainDefense = terrainDef;
    this.terrainAvoid = terrainAvo;

    // Kick off portrait loading if needed
    if (unit && unit.portraitNid && this.resourceManager &&
        !this.chibiCache.has(unit.portraitNid) && !this.loadingPortraits.has(unit.portraitNid)) {
      const nid = unit.portraitNid;
      this.loadingPortraits.add(nid);
      this.resourceManager.loadPortrait(nid).then((img) => {
        this.chibiCache.set(nid, img);
        this.loadingPortraits.delete(nid);
      }).catch(() => {
        this.loadingPortraits.delete(nid);
      });
    }
  }

  /**
   * Draw the HUD overlay onto the display canvas context.
   * All sizes are in CSS pixels scaled by DPR and hudScale.
   */
  drawScreen(ctx: CanvasRenderingContext2D, screenW: number, screenH: number, _db: Database): void {
    if (!this.visible) return;

    const dpr = window.devicePixelRatio || 1;
    const hs = hudScale(screenW, screenH);

    if (this.hoveredUnit) {
      this.drawUnitInfo(ctx, this.hoveredUnit, dpr, hs, screenW, screenH);
    }
    if (this.terrainName) {
      this.drawTerrainInfo(ctx, dpr, hs, screenW, screenH);
    }
  }

  private drawUnitInfo(
    ctx: CanvasRenderingContext2D, unit: UnitObject,
    dpr: number, hs: number, _screenW: number, screenH: number,
  ): void {
    const s = dpr * hs;
    const margin = BASE_PANEL_MARGIN * s;
    const pad = BASE_INNER_PAD * s;
    const pw = BASE_UNIT_PANEL_W * s;
    const ph = BASE_UNIT_PANEL_H * s;
    const lh = BASE_LINE_HEIGHT * s;

    const px = margin;
    const py = margin;

    // Background
    ctx.fillStyle = BG_COLOR;
    ctx.fillRect(px, py, pw, ph);

    // Double border
    const bw = dpr * hs;
    ctx.strokeStyle = BORDER_COLOR;
    ctx.lineWidth = bw;
    ctx.strokeRect(px + 0.5, py + 0.5, pw - 1, ph - 1);
    ctx.strokeStyle = INNER_BORDER;
    ctx.strokeRect(px + bw + 0.5, py + bw + 0.5, pw - 2 * bw - 1, ph - 2 * bw - 1);

    let textX = px + pad;
    let textY = py + pad;
    ctx.textBaseline = 'top';

    // Chibi portrait (32x32 from sprite sheet at position 96,16)
    const chibiDisplaySize = 36 * s; // slightly larger than native 32 for readability
    const chibiImg = unit.portraitNid ? this.chibiCache.get(unit.portraitNid) : undefined;
    if (chibiImg) {
      const chibiX = px + pad * 0.5;
      const chibiY = py + pad * 0.5;
      // Draw chibi: source rect (96, 16, 32, 32) from the 128x112 sprite sheet
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(chibiImg, 96, 16, 32, 32, chibiX, chibiY, chibiDisplaySize, chibiDisplaySize);
      // Shift text to the right of the chibi
      textX = px + pad * 0.5 + chibiDisplaySize + pad * 0.5;
    }

    // Unit name
    ctx.font = `bold ${BASE_FONT_MAIN * s}px monospace`;
    ctx.fillStyle = 'white';
    ctx.fillText(unit.name, textX, textY);
    textY += lh;

    // Class + Level
    ctx.font = `${BASE_FONT_SUB * s}px monospace`;
    ctx.fillStyle = 'rgba(200, 200, 220, 1)';
    ctx.fillText(`Lv ${unit.level} ${unit.klass}`, textX, textY);
    textY += lh;

    // HP bar
    ctx.font = `${BASE_FONT_SUB * s}px monospace`;
    ctx.fillStyle = 'rgba(200, 200, 220, 1)';
    ctx.fillText('HP', textX, textY);
    const barX = textX + BASE_HP_LABEL_OFFSET * s;
    const barW = pw - (textX - px) - pad - BASE_HP_LABEL_OFFSET * s;
    this.drawHpBar(ctx, barX, textY + 2 * dpr * hs, unit.currentHp, unit.maxHp, barW, BASE_HP_BAR_HEIGHT * s);
    textY += lh;

    // HP numbers
    ctx.font = `${BASE_FONT_SUB * s}px monospace`;
    ctx.fillStyle = 'rgba(200, 200, 220, 1)';
    ctx.fillText(`${unit.currentHp}/${unit.maxHp}`, textX, textY);
  }

  private drawTerrainInfo(
    ctx: CanvasRenderingContext2D,
    dpr: number, hs: number, screenW: number, screenH: number,
  ): void {
    const s = dpr * hs;
    const margin = BASE_PANEL_MARGIN * s;
    const pad = BASE_INNER_PAD * s;
    const pw = BASE_TERRAIN_PANEL_W * s;
    const ph = BASE_TERRAIN_PANEL_H * s;
    const lh = BASE_LINE_HEIGHT * s;

    const px = screenW * dpr - pw - margin;
    const py = margin;

    // Background
    ctx.fillStyle = BG_COLOR;
    ctx.fillRect(px, py, pw, ph);

    // Double border
    const bw = dpr * hs;
    ctx.strokeStyle = BORDER_COLOR;
    ctx.lineWidth = bw;
    ctx.strokeRect(px + 0.5, py + 0.5, pw - 1, ph - 1);
    ctx.strokeStyle = INNER_BORDER;
    ctx.strokeRect(px + bw + 0.5, py + bw + 0.5, pw - 2 * bw - 1, ph - 2 * bw - 1);

    const textX = px + pad;
    let textY = py + pad;
    ctx.textBaseline = 'top';

    // Terrain name
    ctx.font = `bold ${BASE_FONT_MAIN * s}px monospace`;
    ctx.fillStyle = 'white';
    ctx.fillText(this.terrainName, textX, textY);
    textY += lh;

    // Defense bonus
    ctx.font = `${BASE_FONT_SUB * s}px monospace`;
    ctx.fillStyle = 'rgba(160, 220, 160, 1)';
    const defText = `Def ${this.terrainDefense >= 0 ? '+' : ''}${this.terrainDefense}`;
    ctx.fillText(defText, textX, textY);
    textY += lh;

    // Avoid bonus
    ctx.fillStyle = 'rgba(160, 200, 240, 1)';
    const avoText = `Avo ${this.terrainAvoid >= 0 ? '+' : ''}${this.terrainAvoid}`;
    ctx.fillText(avoText, textX, textY);
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
