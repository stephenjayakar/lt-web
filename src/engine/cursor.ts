/**
 * Cursor - Tile-based cursor with smooth visual transitions.
 *
 * Position is tracked in tile coordinates. A visual offset smoothly
 * interpolates over ~4 frames when the cursor moves between tiles.
 * The cursor renders as an animated pulsing rectangle (placeholder
 * until sprite assets are loaded).
 */

import type { Surface } from './surface';
import { TILEWIDTH, TILEHEIGHT, ANIMATION_COUNTERS } from './constants';

/** Number of frames for the visual lerp between tiles. */
const LERP_FRAMES = 4;

export class Cursor {
  /** Logical tile position. */
  private tileX: number = 0;
  private tileY: number = 0;

  /** Map bounds (in tiles). */
  private mapW: number = 15;
  private mapH: number = 10;

  /** Visual interpolation state (pixel offsets from logical pos). */
  private visualX: number = 0;
  private visualY: number = 0;
  private lerpProgress: number = 1; // 0..1, 1 = arrived
  private lerpStartX: number = 0;
  private lerpStartY: number = 0;

  /** Whether the cursor is drawn. */
  visible: boolean = true;

  /** Set map bounds for move clamping. */
  setMapSize(widthTiles: number, heightTiles: number): void {
    this.mapW = widthTiles;
    this.mapH = heightTiles;
  }

  /** Instantly move the cursor to a tile. Resets interpolation. */
  setPos(x: number, y: number): void {
    this.tileX = this.clampX(x);
    this.tileY = this.clampY(y);
    this.visualX = this.tileX * TILEWIDTH;
    this.visualY = this.tileY * TILEHEIGHT;
    this.lerpProgress = 1;
  }

  /**
   * Move by a tile delta. Clamps to map bounds and starts a smooth
   * visual transition from the old position.
   */
  move(dx: number, dy: number): void {
    const newX = this.clampX(this.tileX + dx);
    const newY = this.clampY(this.tileY + dy);

    if (newX === this.tileX && newY === this.tileY) {
      return; // hit boundary, no movement
    }

    // Capture current visual position as the lerp origin.
    this.lerpStartX = this.visualX;
    this.lerpStartY = this.visualY;
    this.lerpProgress = 0;

    this.tileX = newX;
    this.tileY = newY;
  }

  /** Per-frame update: advance visual interpolation. */
  update(): void {
    if (this.lerpProgress >= 1) return;

    this.lerpProgress = Math.min(1, this.lerpProgress + 1 / LERP_FRAMES);

    const targetX = this.tileX * TILEWIDTH;
    const targetY = this.tileY * TILEHEIGHT;

    // Ease-out interpolation for a snappier feel.
    const t = 1 - (1 - this.lerpProgress) * (1 - this.lerpProgress);
    this.visualX = this.lerpStartX + (targetX - this.lerpStartX) * t;
    this.visualY = this.lerpStartY + (targetY - this.lerpStartY) * t;
  }

  /**
   * Draw the cursor onto the surface.
   * @param surf   The target surface.
   * @param cameraOffset  [offsetX, offsetY] from Camera.getOffset().
   */
  draw(surf: Surface, cameraOffset: [number, number]): void {
    if (!this.visible) return;

    const drawX = Math.round(this.visualX) - cameraOffset[0];
    const drawY = Math.round(this.visualY) - cameraOffset[1];

    // Animated pulsing rectangle placeholder.
    // Uses the passive animation counter (cycles 0-3) for a subtle
    // size pulse: +-1 px on each side every ~0.5s.
    const pulse = ANIMATION_COUNTERS.passive; // 0..3
    const expand = pulse < 2 ? pulse : 4 - pulse; // 0, 1, 1, 0

    const x = drawX - expand;
    const y = drawY - expand;
    const w = TILEWIDTH + expand * 2;
    const h = TILEHEIGHT + expand * 2;

    // Outer bright border
    surf.drawRect(x, y, w, h, 'rgba(255, 255, 255, 0.9)', 2);
    // Inner coloured border
    surf.drawRect(x + 1, y + 1, w - 2, h - 2, 'rgba(64, 160, 255, 0.7)', 1);
  }

  /** Get the current logical tile position. */
  getHover(): { x: number; y: number } {
    return { x: this.tileX, y: this.tileY };
  }

  /** Get position as a tuple. */
  getPosition(): [number, number] {
    return [this.tileX, this.tileY];
  }

  // ------------------------------------------------------------------
  // Internal
  // ------------------------------------------------------------------

  private clampX(x: number): number {
    return Math.max(0, Math.min(x, this.mapW - 1));
  }

  private clampY(y: number): number {
    return Math.max(0, Math.min(y, this.mapH - 1));
  }
}
