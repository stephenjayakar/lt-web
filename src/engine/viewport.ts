/**
 * Viewport — Dynamic viewport that replaces the fixed 240x160 WINWIDTH/WINHEIGHT.
 *
 * The viewport dimensions (in game pixels) change based on:
 *  - Screen aspect ratio (e.g. iPhone portrait is ~9:19.5)
 *  - Zoom level (pinch to zoom in/out)
 *
 * The "base tile size" is the number of CSS pixels per game tile at zoom=1.
 * This is chosen so that ~8 tiles fit across the screen width on a phone,
 * giving a reasonable default view. Zooming in means fewer tiles visible
 * (each tile bigger on screen), zooming out means more tiles visible.
 *
 * Usage: import { viewport } from './viewport'; then use viewport.width / viewport.height
 * wherever WINWIDTH / WINHEIGHT was used before.
 */

import { TILEWIDTH, TILEHEIGHT } from './constants';

/** Default number of tiles visible across the narrower screen dimension at zoom=1. */
const DEFAULT_TILES_ACROSS = 8;

/** Zoom limits (in terms of tiles visible across the narrow axis). */
const MIN_TILES_ACROSS = 4;   // zoomed all the way in
const MAX_TILES_ACROSS = 20;  // zoomed all the way out

export class Viewport {
  /** Current viewport width in game pixels. */
  width: number = 240;
  /** Current viewport height in game pixels. */
  height: number = 160;

  /** How many tiles fit across the narrower screen axis at the current zoom. */
  tilesAcross: number = DEFAULT_TILES_ACROSS;

  /** CSS pixels per game pixel — derived from tilesAcross + screen size. */
  cssScale: number = 1;

  /** Device pixel ratio. */
  private dpr: number = 1;

  /** Physical screen dimensions in CSS pixels. */
  private screenW: number = 240;
  private screenH: number = 160;

  /**
   * Recalculate viewport dimensions based on current screen size and zoom.
   * Call on init, on resize, and after zoom changes.
   */
  recalculate(screenW: number, screenH: number): void {
    this.dpr = window.devicePixelRatio || 1;
    this.screenW = screenW;
    this.screenH = screenH;

    // The narrow axis determines cssScale: tilesAcross tiles * TILEWIDTH game-px = narrowAxis CSS-px
    const narrowAxis = Math.min(screenW, screenH);
    this.cssScale = narrowAxis / (this.tilesAcross * TILEWIDTH);

    // Viewport in game pixels = screen CSS pixels / cssScale
    this.width = Math.ceil(screenW / this.cssScale);
    this.height = Math.ceil(screenH / this.cssScale);
  }

  /** The render scale: CSS scale * DPR for crisp physical pixels. */
  get renderScale(): number {
    return this.cssScale * this.dpr;
  }

  /**
   * Apply a zoom delta (from pinch gesture).
   * Positive delta = zoom in (fewer tiles visible), negative = zoom out.
   * The delta is in "tiles" units — a pinch that spreads fingers apart by
   * one tile-width reduces tilesAcross by ~1.
   */
  zoom(delta: number): void {
    this.tilesAcross = Math.max(
      MIN_TILES_ACROSS,
      Math.min(MAX_TILES_ACROSS, this.tilesAcross - delta),
    );
    this.recalculate(this.screenW, this.screenH);
  }

  /** Set zoom to a specific tilesAcross value. */
  setZoom(tilesAcross: number): void {
    this.tilesAcross = Math.max(MIN_TILES_ACROSS, Math.min(MAX_TILES_ACROSS, tilesAcross));
    this.recalculate(this.screenW, this.screenH);
  }
}

/** Global viewport singleton. */
export const viewport = new Viewport();

/** Threshold in CSS pixels: screens narrower than this are "small" (mobile). */
const SMALL_SCREEN_THRESHOLD = 600;

/** True if the narrower screen dimension is below the mobile threshold. */
export function isSmallScreen(): boolean {
  return Math.min(window.innerWidth, window.innerHeight) < SMALL_SCREEN_THRESHOLD;
}
