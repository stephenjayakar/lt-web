/**
 * Camera - Viewport camera system matching LT's camera behaviour.
 *
 * Tracks a position in pixel coordinates and smoothly interpolates
 * toward a target. The offset represents the top-left corner of the
 * viewport in world pixel space.
 *
 * GBA resolution: 240x160, 16x16 tiles.
 */

import { WINWIDTH, WINHEIGHT, TILEWIDTH, TILEHEIGHT } from './constants';

/** Number of frames for the lerp to (roughly) converge. */
const SMOOTH_FACTOR = 0.15; // ~6-8 frame convergence (1 - 0.15^7 ≈ 0.98)

/** Snap threshold: stop interpolating below this pixel distance. */
const SNAP_THRESHOLD = 0.5;

export class Camera {
  /** Current viewport top-left in world pixels. */
  private x: number = 0;
  private y: number = 0;

  /** Target viewport top-left in world pixels. */
  private targetX: number = 0;
  private targetY: number = 0;

  /** Map dimensions in pixels (derived from tile counts). */
  private mapPixelW: number = WINWIDTH;
  private mapPixelH: number = WINHEIGHT;

  /**
   * Set the map size in tiles. Used for clamping the camera so it
   * never shows space outside the map.
   */
  setMapSize(widthTiles: number, heightTiles: number): void {
    this.mapPixelW = widthTiles * TILEWIDTH;
    this.mapPixelH = heightTiles * TILEHEIGHT;
  }

  /**
   * Set a target position (top-left of viewport in world pixels).
   * The camera will smoothly interpolate toward it.
   */
  setTarget(x: number, y: number): void {
    this.targetX = x;
    this.targetY = y;
    this.clampTarget();
  }

  /**
   * Instantly move the camera – no interpolation.
   */
  forcePosition(x: number, y: number): void {
    this.targetX = x;
    this.targetY = y;
    this.clampTarget();
    this.x = this.targetX;
    this.y = this.targetY;
  }

  /**
   * Centre the viewport on a specific tile coordinate.
   */
  focusTile(tileX: number, tileY: number): void {
    const px = tileX * TILEWIDTH + TILEWIDTH / 2 - WINWIDTH / 2;
    const py = tileY * TILEHEIGHT + TILEHEIGHT / 2 - WINHEIGHT / 2;
    this.setTarget(px, py);
  }

  /**
   * Instantly centre the viewport on a tile (no smoothing).
   */
  forceTile(tileX: number, tileY: number): void {
    const px = tileX * TILEWIDTH + TILEWIDTH / 2 - WINWIDTH / 2;
    const py = tileY * TILEHEIGHT + TILEHEIGHT / 2 - WINHEIGHT / 2;
    this.forcePosition(px, py);
  }

  /**
   * Per-frame interpolation toward the target.
   * Call once per frame before drawing.
   */
  update(): void {
    const dx = this.targetX - this.x;
    const dy = this.targetY - this.y;

    if (Math.abs(dx) < SNAP_THRESHOLD && Math.abs(dy) < SNAP_THRESHOLD) {
      this.x = this.targetX;
      this.y = this.targetY;
      return;
    }

    this.x += dx * SMOOTH_FACTOR;
    this.y += dy * SMOOTH_FACTOR;
  }

  /**
   * Get the current camera offset (top-left of viewport in world pixels).
   * Values are rounded to integers to avoid sub-pixel rendering artefacts.
   */
  getOffset(): [number, number] {
    return [Math.round(this.x), Math.round(this.y)];
  }

  /**
   * Get a culling rectangle in world pixel space that covers the
   * current viewport plus a 1-tile margin on each side.
   */
  getCullRect(): { x: number; y: number; w: number; h: number } {
    const ox = Math.round(this.x);
    const oy = Math.round(this.y);
    return {
      x: ox - TILEWIDTH,
      y: oy - TILEHEIGHT,
      w: WINWIDTH + TILEWIDTH * 2,
      h: WINHEIGHT + TILEHEIGHT * 2,
    };
  }

  /**
   * Nudge the camera target by a pixel delta.
   * Used for touch-drag panning — the delta is in game pixels.
   */
  pan(dx: number, dy: number): void {
    this.targetX += dx;
    this.targetY += dy;
    this.clampTarget();
    // Snap immediately so panning feels direct rather than springy.
    this.x = this.targetX;
    this.y = this.targetY;
  }

  // ------------------------------------------------------------------
  // Internal
  // ------------------------------------------------------------------

  /** Clamp the target so the viewport stays within the map. */
  private clampTarget(): void {
    const maxX = Math.max(0, this.mapPixelW - WINWIDTH);
    const maxY = Math.max(0, this.mapPixelH - WINHEIGHT);

    this.targetX = Math.max(0, Math.min(this.targetX, maxX));
    this.targetY = Math.max(0, Math.min(this.targetY, maxY));
  }
}
