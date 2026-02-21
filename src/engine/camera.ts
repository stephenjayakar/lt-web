/**
 * Camera - Viewport camera system matching LT's camera behaviour.
 *
 * Tracks a position in pixel coordinates and smoothly interpolates
 * toward a target. The offset represents the top-left corner of the
 * viewport in world pixel space.
 *
 * Uses dynamic viewport dimensions from the viewport singleton.
 */

import { TILEWIDTH, TILEHEIGHT } from './constants';
import { viewport } from './viewport';

/** Number of frames for the lerp to (roughly) converge. */
const SMOOTH_FACTOR = 0.15;

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
  private mapPixelW: number = 240;
  private mapPixelH: number = 160;

  setMapSize(widthTiles: number, heightTiles: number): void {
    this.mapPixelW = widthTiles * TILEWIDTH;
    this.mapPixelH = heightTiles * TILEHEIGHT;
  }

  setTarget(x: number, y: number): void {
    this.targetX = x;
    this.targetY = y;
    this.clampTarget();
  }

  forcePosition(x: number, y: number): void {
    this.targetX = x;
    this.targetY = y;
    this.clampTarget();
    this.x = this.targetX;
    this.y = this.targetY;
  }

  focusTile(tileX: number, tileY: number): void {
    const px = tileX * TILEWIDTH + TILEWIDTH / 2 - viewport.width / 2;
    const py = tileY * TILEHEIGHT + TILEHEIGHT / 2 - viewport.height / 2;
    this.setTarget(px, py);
  }

  forceTile(tileX: number, tileY: number): void {
    const px = tileX * TILEWIDTH + TILEWIDTH / 2 - viewport.width / 2;
    const py = tileY * TILEHEIGHT + TILEHEIGHT / 2 - viewport.height / 2;
    this.forcePosition(px, py);
  }

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

  getOffset(): [number, number] {
    return [Math.round(this.x), Math.round(this.y)];
  }

  getCullRect(): { x: number; y: number; w: number; h: number } {
    const ox = Math.round(this.x);
    const oy = Math.round(this.y);
    return {
      x: ox - TILEWIDTH,
      y: oy - TILEHEIGHT,
      w: viewport.width + TILEWIDTH * 2,
      h: viewport.height + TILEHEIGHT * 2,
    };
  }

  /**
   * Nudge the camera by a pixel delta. Used for touch-drag panning.
   */
  pan(dx: number, dy: number): void {
    this.targetX += dx;
    this.targetY += dy;
    this.clampTarget();
    this.x = this.targetX;
    this.y = this.targetY;
  }

  private clampTarget(): void {
    const maxX = Math.max(0, this.mapPixelW - viewport.width);
    const maxY = Math.max(0, this.mapPixelH - viewport.height);

    this.targetX = Math.max(0, Math.min(this.targetX, maxX));
    this.targetY = Math.max(0, Math.min(this.targetY, maxY));
  }
}
