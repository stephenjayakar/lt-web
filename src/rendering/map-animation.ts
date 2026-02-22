/**
 * map-animation.ts — Sprite-sheet-based map animations.
 *
 * Ported from LT's app/engine/animations.py.
 * Used for combat hit/miss effects, level-up sparkle, status overlays,
 * and event-triggered map_anim commands.
 */

import { Surface } from '../engine/surface';
import { TILEWIDTH, TILEHEIGHT } from '../engine/constants';

// ============================================================
// Animation prefab (loaded from animations.json)
// ============================================================

export interface MapAnimPrefab {
  nid: string;
  frame_x: number; // columns in sprite sheet
  frame_y: number; // rows in sprite sheet
  num_frames: number;
  speed: number; // ms per frame (when use_frame_time = false)
  frame_times: string; // comma-separated per-frame durations in engine frames
  use_frame_time: boolean;
}

// ============================================================
// Runtime animation instance
// ============================================================

export class MapAnimation {
  readonly nid: string;
  /** Position in pixel coords. */
  x: number;
  y: number;

  private image: HTMLImageElement | null = null;
  private frameX: number;
  private frameY: number;
  private numFrames: number;
  private speed: number;
  private frameTimes: number[];
  private useFrameTime: boolean;
  private speedAdj: number;

  private frameWidth: number = 0;
  private frameHeight: number = 0;

  /** Current frame index. */
  private counter: number = 0;
  /** Frames held on current frame (for use_frame_time mode). */
  private framesHeld: number = 0;
  /** Timestamp of first update (for constant-speed mode). */
  private startTime: number = 0;

  /** Animation state. */
  done: boolean = false;
  loop: boolean;
  hold: boolean;

  constructor(
    prefab: MapAnimPrefab,
    tileX: number,
    tileY: number,
    options?: {
      loop?: boolean;
      hold?: boolean;
      speedAdj?: number;
    },
  ) {
    this.nid = prefab.nid;
    this.frameX = prefab.frame_x;
    this.frameY = prefab.frame_y;
    this.numFrames = prefab.num_frames;
    this.speed = prefab.speed;
    this.useFrameTime = prefab.use_frame_time;
    this.frameTimes = prefab.frame_times
      ? prefab.frame_times.split(',').map(s => parseInt(s.trim(), 10))
      : [];
    this.speedAdj = options?.speedAdj ?? 1;
    this.loop = options?.loop ?? false;
    this.hold = options?.hold ?? false;

    // Convert tile coords to pixel coords, centered on tile
    this.x = tileX * TILEWIDTH;
    this.y = tileY * TILEHEIGHT;
  }

  /** Set the loaded sprite sheet image. Call after async load. */
  setImage(img: HTMLImageElement): void {
    this.image = img;
    this.frameWidth = Math.floor(img.width / this.frameX);
    this.frameHeight = Math.floor(img.height / this.frameY);
    // Center on tile
    this.x += Math.floor((TILEWIDTH - this.frameWidth) / 2);
    this.y += Math.floor((TILEHEIGHT - this.frameHeight) / 2);
  }

  /** Get total duration in ms (approximate). */
  getDuration(): number {
    if (this.useFrameTime) {
      let total = 0;
      for (let i = 0; i < this.numFrames; i++) {
        total += (this.frameTimes[i] ?? 1) * this.speedAdj;
      }
      return total * (1000 / 60); // convert engine frames to ms at 60fps
    }
    return this.numFrames * this.speed * this.speedAdj;
  }

  /**
   * Advance animation by one engine frame.
   * Returns true when the animation is finished (and should be removed).
   */
  update(): boolean {
    if (this.done) return true;
    if (!this.image) return false; // Not loaded yet

    if (this.useFrameTime) {
      // Per-frame timing mode
      this.framesHeld++;
      const hold = Math.ceil((this.frameTimes[this.counter] ?? 1) * this.speedAdj);
      if (this.framesHeld >= hold) {
        this.framesHeld = 0;
        this.counter++;
      }
    } else {
      // Constant speed mode
      if (this.startTime === 0) this.startTime = Date.now();
      const elapsed = Date.now() - this.startTime;
      this.counter = Math.floor(elapsed / (this.speed * this.speedAdj));
    }

    if (this.counter >= this.numFrames) {
      if (this.loop) {
        this.counter = 0;
        this.framesHeld = 0;
        this.startTime = Date.now();
      } else if (this.hold) {
        this.counter = this.numFrames - 1;
      } else {
        this.done = true;
        return true;
      }
    }

    return false;
  }

  /**
   * Draw the current frame onto the surface.
   * @param surf  Target surface (in game-pixel space).
   * @param cameraX  Camera offset X in pixels.
   * @param cameraY  Camera offset Y in pixels.
   */
  draw(surf: Surface, cameraX: number, cameraY: number): void {
    if (!this.image || this.done) return;

    const frame = Math.min(this.counter, this.numFrames - 1);
    const col = frame % this.frameX;
    const row = Math.floor(frame / this.frameX);

    const sx = col * this.frameWidth;
    const sy = row * this.frameHeight;
    const dx = Math.floor(this.x - cameraX);
    const dy = Math.floor(this.y - cameraY);

    surf.blitImage(this.image, sx, sy, this.frameWidth, this.frameHeight, dx, dy);
  }
}
