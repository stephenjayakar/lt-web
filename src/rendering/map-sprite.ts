import { Surface, surfaceFromImage } from '../engine/surface';
import { TILEWIDTH, TILEHEIGHT, ANIMATION_COUNTERS, COLORKEY } from '../engine/constants';

export type SpriteState = 'standing' | 'moving' | 'gray';
export type Direction = 'down' | 'left' | 'right' | 'up';

const DIRECTION_ROW: Record<Direction, number> = {
  down: 0,
  left: 1,
  right: 2,
  up: 3,
};

/**
 * MapSprite - Handles map unit sprite animation and rendering.
 *
 * Stand image layout: 192x144 PNG, 3 columns x 3 rows of 64x48 frames.
 *   Row 0 (y=0):  passive/standing animation frames (0, 1, 2)
 *   Row 1 (y=48): grayed/inactive frames for exhausted units
 *   Row 2 (y=96): active/selected animation frames
 *
 * Move image layout: 192x160 PNG, 4 columns x 4 rows of 48x40 frames.
 *   Row 0: down, Row 1: left, Row 2: right, Row 3: up
 *   4 frames per direction.
 *
 * All sprite PNGs use RGB mode with colorkey (128, 160, 128) as the
 * transparent background color.
 */
export class MapSprite {
  private standFrames: Surface[];
  private grayFrames: Surface[];
  private moveFrames: Map<Direction, Surface[]>;

  state: SpriteState;
  direction: Direction;

  standFrameWidth: number;
  standFrameHeight: number;
  moveFrameWidth: number;
  moveFrameHeight: number;

  constructor() {
    this.standFrames = [];
    this.grayFrames = [];
    this.moveFrames = new Map();
    this.state = 'standing';
    this.direction = 'down';
    this.standFrameWidth = 64;
    this.standFrameHeight = 48;
    this.moveFrameWidth = 48;
    this.moveFrameHeight = 40;
  }

  /**
   * Load from stand and move images.
   * Stand image is required; move image is optional (null if not found).
   * When move image is missing, the standing frame is used for all directions.
   */
  static fromImages(
    standImg: HTMLImageElement | null,
    moveImg: HTMLImageElement | null,
  ): MapSprite | null {
    if (!standImg) return null;

    const sprite = new MapSprite();
    const standSurf = surfaceFromImage(standImg);
    applyColorkey(standSurf);

    // Extract 3 passive stand frames (row 0) and 3 gray frames (row 1)
    for (let col = 0; col < 3; col++) {
      sprite.standFrames.push(
        standSurf.subsurface(
          col * sprite.standFrameWidth,
          0,
          sprite.standFrameWidth,
          sprite.standFrameHeight,
        ),
      );
      sprite.grayFrames.push(
        standSurf.subsurface(
          col * sprite.standFrameWidth,
          sprite.standFrameHeight,
          sprite.standFrameWidth,
          sprite.standFrameHeight,
        ),
      );
    }

    // Extract 4 frames per direction from move image (if available)
    if (moveImg) {
      const moveSurf = surfaceFromImage(moveImg);
      applyColorkey(moveSurf);
      const directions: Direction[] = ['down', 'left', 'right', 'up'];
      for (let row = 0; row < 4; row++) {
        const frames: Surface[] = [];
        for (let col = 0; col < 4; col++) {
          frames.push(
            moveSurf.subsurface(
              col * sprite.moveFrameWidth,
              row * sprite.moveFrameHeight,
              sprite.moveFrameWidth,
              sprite.moveFrameHeight,
            ),
          );
        }
        sprite.moveFrames.set(directions[row], frames);
      }
    }

    return sprite;
  }

  /**
   * Get the current frame to display based on animation state.
   *
   * Standing/gray: passive counter cycles 0-3, mapped to frame index
   * via 0,1,2,1 bobbing pattern (passive < 3 ? passive : 1).
   *
   * Moving: active counter mod 4 picks from the current direction's frames.
   */
  getCurrentFrame(): Surface {
    if (this.state === 'moving') {
      const frameIdx = ANIMATION_COUNTERS.active % 4;
      const dirFrames = this.moveFrames.get(this.direction);
      if (dirFrames && dirFrames.length > 0) {
        return dirFrames[frameIdx % dirFrames.length];
      }
      // Fallback to first stand frame if move frames missing
      return this.standFrames[0];
    }

    // Standing or gray: use passive counter with 0,1,2,1 bobbing
    const passive = ANIMATION_COUNTERS.passive;
    const frameIdx = passive < 3 ? passive : 1;
    const frames = this.state === 'gray' ? this.grayFrames : this.standFrames;

    if (frames.length > 0) {
      return frames[frameIdx % frames.length];
    }

    // Absolute fallback
    return this.standFrames[0];
  }

  /**
   * Draw this sprite at a world position, applying camera offset.
   *
   * Matches LT's unit_sprite.py positioning:
   *   x: left - max(0, (image.width - 16) // 2)
   *   y: top - 24
   *
   * The y offset is a fixed -24 for all sprite states. This positions
   * the tile roughly vertically centered in the sprite frame.
   *
   * - Stand (64x48): dx = -(64-16)/2 = -24, dy = -24
   * - Move  (48x40): dx = -(48-16)/2 = -16, dy = -24
   */
  draw(surf: Surface, worldX: number, worldY: number, offsetX: number, offsetY: number): void {
    const frame = this.getCurrentFrame();

    const anchorDx = -Math.max(0, Math.floor((frame.width - TILEWIDTH) / 2));
    const anchorDy = -24;

    const px = worldX - offsetX + anchorDx;
    const py = worldY - offsetY + anchorDy;

    surf.blit(frame, px, py);
  }

  /** Set the movement direction based on dx, dy velocity */
  setDirection(dx: number, dy: number): void {
    if (Math.abs(dx) >= Math.abs(dy)) {
      this.direction = dx > 0 ? 'right' : 'left';
    } else {
      this.direction = dy > 0 ? 'down' : 'up';
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Replace the LT colorkey background (128, 160, 128) with full transparency.
 *
 * LT sprite PNGs are RGB (no alpha channel) and use the colorkey as a
 * chroma-key background. The browser's canvas renders them as opaque, so
 * we need to convert matching pixels to alpha = 0.
 *
 * Uses a small tolerance (±2) to handle any JPEG-like compression artefacts,
 * though in practice the PNGs are lossless.
 */
function applyColorkey(surf: Surface): void {
  const imageData = surf.getImageData();
  const data = imageData.data;
  const [kr, kg, kb] = COLORKEY;
  const tolerance = 2;

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    if (
      Math.abs(r - kr) <= tolerance &&
      Math.abs(g - kg) <= tolerance &&
      Math.abs(b - kb) <= tolerance
    ) {
      data[i + 3] = 0; // Set alpha to 0 (transparent)
    }
  }

  surf.putImageData(imageData);
}
