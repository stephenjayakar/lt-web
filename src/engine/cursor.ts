/**
 * Cursor - Tile-based cursor with smooth visual transitions.
 *
 * Position is tracked in tile coordinates. A visual offset smoothly
 * interpolates over ~4 frames when the cursor moves between tiles.
 *
 * Uses the actual cursor sprite sheet (128x128, 4 rows × 4 cols of
 * 32×32 frames):
 *   Row 0: passive cursor (normal) — 3-frame bounce animation
 *   Row 1: red/combat cursor — 3-frame bounce animation
 *   Row 2: active cursor (col 0), formation (cols 2-3)
 *   Row 3: green/turnwheel cursor — 3-frame bounce animation
 *
 * Animation: back-and-forth bounce [0,1,2,1] with timing [20,2,8,2]
 * frames per step (~533ms total cycle).
 *
 * Ported from: app/engine/level_cursor.py, app/engine/cursor.py
 */

import type { Surface } from './surface';
import { TILEWIDTH, TILEHEIGHT } from './constants';

/** Number of frames for the visual lerp between tiles. */
const LERP_FRAMES = 4;

/** Sprite frame size (each cursor frame is 32x32). */
const FRAME_SIZE = 32;

/** Centering offset: cursor is 32x32 centered on a 16x16 tile. */
const CENTER_OFFSET = Math.floor((FRAME_SIZE - TILEWIDTH) / 2); // 8

/**
 * Back-and-forth animation counter.
 * Sequence: 0(×20), 1(×2), 2(×8), 1(×2) = 32 frames total.
 * Produces frame indices: 0, 1, 2, 1, 0, 1, 2, 1, ...
 */
const ANIM_SEQUENCE: number[] = [];
{
  // Forward: [0]×20, [1]×2, [2]×8
  for (let i = 0; i < 20; i++) ANIM_SEQUENCE.push(0);
  for (let i = 0; i < 2; i++) ANIM_SEQUENCE.push(1);
  for (let i = 0; i < 8; i++) ANIM_SEQUENCE.push(2);
  // Reverse (exclude first and last): [1]×2
  for (let i = 0; i < 2; i++) ANIM_SEQUENCE.push(1);
}

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

  /** Loaded sprite sheet image (null until loaded). */
  private spriteSheet: HTMLImageElement | null = null;

  /** Animation frame counter. */
  private animCounter: number = 0;

  /** Set map bounds for move clamping. */
  setMapSize(widthTiles: number, heightTiles: number): void {
    this.mapW = widthTiles;
    this.mapH = heightTiles;
  }

  /** Load the cursor sprite sheet from a URL. */
  async loadSprite(url: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        this.spriteSheet = img;
        resolve();
      };
      img.onerror = () => {
        console.warn('Cursor: failed to load sprite sheet');
        reject(new Error('Failed to load cursor sprite'));
      };
      img.src = url;
    });
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

  /** Per-frame update: advance visual interpolation and animation. */
  update(): void {
    // Advance animation counter
    this.animCounter = (this.animCounter + 1) % ANIM_SEQUENCE.length;

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

    const drawX = Math.round(this.visualX) - cameraOffset[0] - CENTER_OFFSET;
    const drawY = Math.round(this.visualY) - cameraOffset[1] - CENTER_OFFSET;

    if (this.spriteSheet) {
      // Use the actual cursor sprite sheet
      const frameIdx = ANIM_SEQUENCE[this.animCounter]; // 0, 1, or 2
      const srcX = frameIdx * FRAME_SIZE;
      const srcY = 0; // Row 0 = passive cursor (default)

      surf.blitImage(
        this.spriteSheet,
        srcX, srcY, FRAME_SIZE, FRAME_SIZE,
        drawX, drawY,
      );
    } else {
      // Fallback: animated rectangle when sprite not loaded
      const fbX = drawX + CENTER_OFFSET;
      const fbY = drawY + CENTER_OFFSET;
      surf.drawRect(fbX, fbY, TILEWIDTH, TILEHEIGHT, 'rgba(255, 255, 255, 0.9)', 2);
      surf.drawRect(fbX + 1, fbY + 1, TILEWIDTH - 2, TILEHEIGHT - 2, 'rgba(64, 160, 255, 0.7)', 1);
    }
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
