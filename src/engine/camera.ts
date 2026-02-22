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

/** Predefined shake offset patterns (in pixels). */
const SHAKE_PATTERNS: Record<string, [number, number][]> = {
  default: [[0, -2], [0, -2], [0, 0], [0, 0]],
  combat:  [[-3, -3], [0, 0], [3, 3], [0, 0]],
  kill:    [[3, 3], [0, 0], [0, 0], [3, 3], [-3, -3], [3, 3], [-3, -3], [0, 0]],
};

/** Generate a random shake pattern. */
function randomShake(count: number, amplitude: number): [number, number][] {
  const offsets: [number, number][] = [];
  for (let i = 0; i < count; i++) {
    offsets.push([
      Math.floor(Math.random() * (amplitude * 2 + 1)) - amplitude,
      Math.floor(Math.random() * (amplitude * 2 + 1)) - amplitude,
    ]);
  }
  return offsets;
}

/** Generate a celeste-style shake (subtle ±1). */
function celesteShake(count: number): [number, number][] {
  const offsets: [number, number][] = [];
  for (let i = 0; i < count; i++) {
    offsets.push([
      Math.random() < 0.5 ? -1 : 1,
      Math.random() < 0.5 ? -1 : 1,
    ]);
  }
  return offsets;
}

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

  /** Shake state. */
  private shakeOffsets: [number, number][] = [[0, 0]];
  private shakeIdx: number = 0;
  private shakeEndTime: number = 0; // 0 = permanent until resetShake()

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
    } else {
      this.x += dx * SMOOTH_FACTOR;
      this.y += dy * SMOOTH_FACTOR;
    }

    // Advance shake frame
    this.shakeIdx = (this.shakeIdx + 1) % this.shakeOffsets.length;
    if (this.shakeEndTime > 0 && Date.now() > this.shakeEndTime) {
      this.resetShake();
    }
  }

  getOffset(): [number, number] {
    const shake = this.shakeOffsets[this.shakeIdx];
    return [Math.round(this.x) + shake[0], Math.round(this.y) + shake[1]];
  }

  /** Start a screen shake with a named pattern or custom offsets. */
  setShake(shakeType: string, durationMs: number = 0): void {
    let offsets: [number, number][];
    if (shakeType === 'random') {
      offsets = randomShake(16, 4);
    } else if (shakeType === 'celeste') {
      offsets = celesteShake(16);
    } else {
      offsets = SHAKE_PATTERNS[shakeType] ?? SHAKE_PATTERNS['default'];
    }
    this.shakeOffsets = offsets;
    this.shakeIdx = 0;
    this.shakeEndTime = durationMs > 0 ? Date.now() + durationMs : 0;
  }

  /** Stop any active shake. */
  resetShake(): void {
    this.shakeOffsets = [[0, 0]];
    this.shakeIdx = 0;
    this.shakeEndTime = 0;
  }

  /** Get the current shake offset (for applying to non-camera elements like backgrounds). */
  getShake(): [number, number] {
    return this.shakeOffsets[this.shakeIdx];
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
