import { Surface, surfaceFromImage } from '../engine/surface';
import { TILEWIDTH, TILEHEIGHT, ANIMATION_COUNTERS } from '../engine/constants';

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
 * Stand image layout: 192x96 PNG, 3 columns x 2 rows of 64x48 frames.
 *   Row 0: active animation frames (0, 1, 2)
 *   Row 1: grayed/inactive frames for exhausted units
 *
 * Move image layout: 192x160 PNG, 4 columns x 4 rows of 48x40 frames.
 *   Row 0: down, Row 1: left, Row 2: right, Row 3: up
 *   4 frames per direction.
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

  /** Load from stand and move images */
  static fromImages(standImg: HTMLImageElement, moveImg: HTMLImageElement): MapSprite {
    const sprite = new MapSprite();
    const standSurf = surfaceFromImage(standImg);
    const moveSurf = surfaceFromImage(moveImg);

    // Extract 3 active stand frames (row 0) and 3 gray frames (row 1)
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

    // Extract 4 frames per direction from move image
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
   * The sprite is centered on the tile:
   * - Stand (64x48): dx = -(64-16)/2 = -24, dy = -(48-16) = -32
   * - Move  (48x40): dx = -(48-16)/2 = -16, dy = -(40-16) = -24
   */
  draw(surf: Surface, worldX: number, worldY: number, offsetX: number, offsetY: number): void {
    const frame = this.getCurrentFrame();

    let anchorDx: number;
    let anchorDy: number;

    if (this.state === 'moving') {
      anchorDx = -(this.moveFrameWidth - TILEWIDTH) / 2;
      anchorDy = -(this.moveFrameHeight - TILEHEIGHT);
    } else {
      anchorDx = -(this.standFrameWidth - TILEWIDTH) / 2;
      anchorDy = -(this.standFrameHeight - TILEHEIGHT);
    }

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
