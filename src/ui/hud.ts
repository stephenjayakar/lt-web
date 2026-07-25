import type { UnitObject } from '../objects/unit';
import type { Database } from '../data/database';
import type { ResourceManager } from '../data/resource-manager';
import type { InitiativeTracker } from '../engine/initiative';

/**
 * Base dimensions at the "mobile" reference size (CSS pixels).
 * These get multiplied by hudScale() on larger screens.
 */
const BASE_UNIT_PANEL_W = 124;
const BASE_UNIT_PANEL_H = 58;
const BASE_TERRAIN_PANEL_W = 78;
const BASE_TERRAIN_PANEL_H = 44;
const BASE_PANEL_MARGIN = 5;
const BASE_INNER_PAD = 5;

const BG_COLOR = 'rgba(12, 18, 35, 0.92)';
const BORDER_LIGHT = 'rgba(224, 232, 255, 0.88)';
const BORDER_MID = 'rgba(86, 108, 154, 0.95)';
const BORDER_DARK = 'rgba(18, 25, 52, 0.98)';
const INNER_BORDER = 'rgba(55, 72, 112, 0.72)';

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

/** Team-based chip fill color for the initiative bar (fallback team coloring). */
function teamChipColor(team: string): string {
  switch (team) {
    case 'player': return 'rgba(64, 128, 220, 0.85)';
    case 'enemy': return 'rgba(220, 64, 64, 0.85)';
    case 'enemy2': return 'rgba(160, 64, 200, 0.85)';
    case 'other': return 'rgba(64, 200, 96, 0.85)';
    default: return 'rgba(120, 120, 120, 0.85)';
  }
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
  drawScreen(
    ctx: CanvasRenderingContext2D, screenW: number, screenH: number, db: Database,
    initiative?: InitiativeTracker | null,
    units?: Map<string, UnitObject> | null,
  ): void {
    if (!this.visible) return;

    const dpr = window.devicePixelRatio || 1;
    const hs = hudScale(screenW, screenH);

    if (this.hoveredUnit) {
      this.drawUnitInfo(ctx, this.hoveredUnit, db, dpr, hs);
    }
    if (this.terrainName) {
      this.drawTerrainInfo(ctx, dpr, hs, screenW, screenH);
    }
    if (initiative && units && initiative.drawMe && initiative.unitLine.length > 0) {
      this.drawInitiativeBar(ctx, initiative, units, dpr, hs, screenW, screenH);
    }
  }

  /**
   * Initiative order bar -- shown when the 'initiative' constant is on.
   * Ported from app/engine/initiative_ui.py's drawing of the turn order as
   * a horizontal row of unit chips, current-turn unit highlighted.
   * (Web simplification: colored/labelled chips rather than full chibi
   * portrait strip, since chibi assets aren't guaranteed for all units.)
   */
  private drawInitiativeBar(
    ctx: CanvasRenderingContext2D,
    initiative: InitiativeTracker,
    units: Map<string, UnitObject>,
    dpr: number, hs: number, screenW: number, screenH: number,
  ): void {
    const s = dpr * hs;
    const chipW = 28 * s;
    const chipH = 28 * s;
    const gap = 3 * s;
    const margin = BASE_PANEL_MARGIN * s;

    const total = initiative.unitLine.length;
    const barW = total * chipW + Math.max(0, total - 1) * gap + 2 * (BASE_INNER_PAD * s);
    const barX = (screenW * dpr - barW) / 2;
    const barY = margin;
    const barH = chipH + 2 * (BASE_INNER_PAD * s);

    ctx.fillStyle = BG_COLOR;
    ctx.fillRect(barX, barY, barW, barH);
    ctx.strokeStyle = BORDER_MID;
    ctx.lineWidth = dpr * hs;
    ctx.strokeRect(barX + 0.5, barY + 0.5, barW - 1, barH - 1);

    let x = barX + BASE_INNER_PAD * s;
    const y = barY + BASE_INNER_PAD * s;

    for (let i = 0; i < total; i++) {
      const nid = initiative.unitLine[i];
      const unit = units.get(nid);
      const isCurrent = i === initiative.currentIdx;

      ctx.fillStyle = isCurrent
        ? 'rgba(255, 220, 80, 0.9)'
        : unit
          ? teamChipColor(unit.team)
          : 'rgba(100, 100, 100, 0.6)';
      ctx.fillRect(x, y, chipW, chipH);

      ctx.strokeStyle = isCurrent ? 'rgba(255, 255, 255, 0.95)' : INNER_BORDER;
      ctx.lineWidth = (isCurrent ? 2 : 1) * dpr * hs;
      ctx.strokeRect(x + 0.5, y + 0.5, chipW - 1, chipH - 1);

      const label = unit ? unit.name.slice(0, 2) : '??';
      ctx.font = `bold ${11 * s}px monospace`;
      ctx.fillStyle = isCurrent ? 'black' : 'white';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, x + chipW / 2, y + chipH / 2);
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';

      x += chipW + gap;
    }
  }

  private drawUnitInfo(
    ctx: CanvasRenderingContext2D,
    unit: UnitObject,
    db: Database,
    dpr: number,
    hs: number,
  ): void {
    const s = dpr * hs;
    const margin = BASE_PANEL_MARGIN * s;
    const pad = BASE_INNER_PAD * s;
    const pw = BASE_UNIT_PANEL_W * s;
    const ph = BASE_UNIT_PANEL_H * s;
    const px = margin;
    const py = margin;
    const accent = teamChipColor(unit.team);
    this.drawPanelFrame(ctx, px, py, pw, ph, s, accent);

    const portraitSize = 34 * s;
    const portraitX = px + pad;
    const portraitY = py + pad;
    ctx.fillStyle = 'rgba(5, 9, 20, 0.86)';
    ctx.fillRect(portraitX, portraitY, portraitSize, portraitSize);
    ctx.strokeStyle = INNER_BORDER;
    ctx.lineWidth = Math.max(1, s);
    ctx.strokeRect(
      portraitX + 0.5 * s,
      portraitY + 0.5 * s,
      portraitSize - s,
      portraitSize - s,
    );

    const textX = portraitX + portraitSize + 6 * s;
    const textRight = px + pw - pad;
    ctx.textBaseline = 'top';

    // Chibi portrait: the same 32×32 source used by the Python unit-info card.
    const chibiImg = unit.portraitNid ? this.chibiCache.get(unit.portraitNid) : undefined;
    if (chibiImg) {
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(
        chibiImg,
        96, 16, 32, 32,
        portraitX + s, portraitY + s,
        portraitSize - 2 * s, portraitSize - 2 * s,
      );
    }

    ctx.font = `bold ${10 * s}px monospace`;
    ctx.fillStyle = '#ffffff';
    ctx.fillText(this.fitLabel(ctx, unit.name, textRight - textX), textX, py + 6 * s);

    const className = db.classes.get(unit.klass)?.name ?? unit.klass.replaceAll('_', ' ');
    ctx.font = `${7 * s}px monospace`;
    ctx.fillStyle = 'rgba(194, 205, 232, 1)';
    ctx.fillText(
      this.fitLabel(ctx, `Lv ${unit.level}  ${className}`, textRight - textX),
      textX,
      py + 19 * s,
    );

    const hpY = py + 34 * s;
    ctx.font = `bold ${7 * s}px monospace`;
    ctx.fillStyle = 'rgba(170, 202, 255, 1)';
    ctx.fillText('HP', textX, hpY);
    const hpText = `${unit.currentHp} / ${unit.maxHp}`;
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'right';
    ctx.fillText(hpText, textRight, hpY);
    ctx.textAlign = 'left';
    this.drawHpBar(
      ctx,
      textX,
      py + 45 * s,
      unit.currentHp,
      unit.maxHp,
      textRight - textX,
      5 * s,
    );
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

    const px = screenW * dpr - pw - margin;
    const py = margin;
    this.drawPanelFrame(ctx, px, py, pw, ph, s, 'rgba(206, 174, 78, 0.9)');

    const centerX = px + pw / 2;
    ctx.textBaseline = 'top';
    ctx.textAlign = 'center';
    ctx.font = `bold ${9 * s}px monospace`;
    ctx.fillStyle = '#ffffff';
    ctx.fillText(this.fitLabel(ctx, this.terrainName, pw - 2 * pad), centerX, py + 6 * s);

    const statY = py + 23 * s;
    ctx.font = `bold ${7 * s}px monospace`;
    ctx.fillStyle = 'rgba(170, 221, 181, 1)';
    ctx.fillText(`DEF ${this.terrainDefense}`, px + pw * 0.28, statY);
    ctx.fillStyle = 'rgba(170, 205, 246, 1)';
    ctx.fillText(`AVO ${this.terrainAvoid}`, px + pw * 0.73, statY);
    ctx.textAlign = 'left';
  }

  private drawPanelFrame(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    width: number,
    height: number,
    scale: number,
    accent: string,
  ): void {
    const notch = 2 * scale;
    ctx.fillStyle = BORDER_DARK;
    ctx.fillRect(x + notch, y, width - 2 * notch, height);
    ctx.fillRect(x, y + notch, width, height - 2 * notch);
    ctx.fillStyle = BG_COLOR;
    ctx.fillRect(x + notch, y + notch, width - 2 * notch, height - 2 * notch);

    ctx.lineWidth = Math.max(1, scale);
    ctx.strokeStyle = BORDER_LIGHT;
    ctx.beginPath();
    ctx.moveTo(x + notch, y + 0.5 * scale);
    ctx.lineTo(x + width - notch, y + 0.5 * scale);
    ctx.moveTo(x + 0.5 * scale, y + notch);
    ctx.lineTo(x + 0.5 * scale, y + height - notch);
    ctx.stroke();

    ctx.strokeStyle = BORDER_MID;
    ctx.beginPath();
    ctx.moveTo(x + width - 0.5 * scale, y + notch);
    ctx.lineTo(x + width - 0.5 * scale, y + height - notch);
    ctx.moveTo(x + notch, y + height - 0.5 * scale);
    ctx.lineTo(x + width - notch, y + height - 0.5 * scale);
    ctx.stroke();

    ctx.fillStyle = accent;
    ctx.fillRect(x + 4 * scale, y + 3 * scale, width - 8 * scale, scale);
  }

  private fitLabel(
    ctx: CanvasRenderingContext2D,
    label: string,
    maxWidth: number,
  ): string {
    if (ctx.measureText(label).width <= maxWidth) return label;
    let fitted = label;
    while (fitted.length > 1 && ctx.measureText(`${fitted}…`).width > maxWidth) {
      fitted = fitted.slice(0, -1);
    }
    return `${fitted}…`;
  }

  private drawHpBar(
    ctx: CanvasRenderingContext2D,
    x: number, y: number,
    current: number, max: number,
    width: number, height: number,
  ): void {
    const ratio = max > 0 ? Math.max(0, Math.min(1, current / max)) : 0;

    ctx.fillStyle = 'rgba(4, 7, 14, 1)';
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

    ctx.strokeStyle = 'rgba(200, 218, 242, 0.8)';
    ctx.lineWidth = Math.max(1, height / 5);
    ctx.strokeRect(x + 0.5, y + 0.5, width - 1, height - 1);

    // Small separators echo the original engine's segmented HP strip.
    ctx.strokeStyle = 'rgba(8, 18, 28, 0.62)';
    ctx.lineWidth = Math.max(1, height / 6);
    const segment = Math.max(6, width / 8);
    for (let marker = x + segment; marker < x + width; marker += segment) {
      ctx.beginPath();
      ctx.moveTo(Math.round(marker) + 0.5, y + 1);
      ctx.lineTo(Math.round(marker) + 0.5, y + height - 1);
      ctx.stroke();
    }
  }
}
