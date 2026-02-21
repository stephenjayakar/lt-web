import type { UnitObject } from '../objects/unit';
import type { MapSprite } from './map-sprite';
import { Surface } from '../engine/surface';
import { TILEWIDTH, TILEHEIGHT } from '../engine/constants';

/**
 * UnitRenderer - Manages map sprites for all units and handles rendering.
 * Associates units with their MapSprite instances and draws them depth-sorted.
 */
export class UnitRenderer {
  private sprites: Map<string, MapSprite>;

  constructor() {
    this.sprites = new Map();
  }

  /** Register a sprite for a unit */
  setSprite(unitNid: string, sprite: MapSprite): void {
    this.sprites.set(unitNid, sprite);
  }

  /** Get sprite for a unit */
  getSprite(unitNid: string): MapSprite | null {
    return this.sprites.get(unitNid) ?? null;
  }

  /**
   * Draw all visible units sorted by Y position (depth ordering).
   *
   * For each unit:
   * 1. Skip if position is null or unit is dead
   * 2. Resolve the sprite, or fall back to a placeholder
   * 3. Apply movement animation offset if present
   * 4. Mark sprite as 'gray' if unit is finished, else set appropriate state
   * 5. Draw
   */
  drawUnits(
    surf: Surface,
    units: UnitObject[],
    cameraOffsetX: number,
    cameraOffsetY: number,
    movementOffsets: Map<string, [number, number]>,
  ): void {
    // Filter to alive, positioned units
    const visible = units.filter(
      (u) => u.position !== null && !u.isDead(),
    );

    // Sort by Y ascending for painter's-algorithm depth
    visible.sort((a, b) => a.position![1] - b.position![1]);

    for (const unit of visible) {
      const [tileX, tileY] = unit.position!;
      let worldX = tileX * TILEWIDTH;
      let worldY = tileY * TILEHEIGHT;

      // Apply movement animation offset (pixel-level interpolation)
      const moveOffset = movementOffsets.get(unit.nid);
      if (moveOffset) {
        worldX += moveOffset[0];
        worldY += moveOffset[1];
      }

      const sprite = this.sprites.get(unit.nid);

      if (sprite) {
        // Update sprite state
        if (unit.finished) {
          sprite.state = 'gray';
        } else if (moveOffset && (moveOffset[0] !== 0 || moveOffset[1] !== 0)) {
          sprite.state = 'moving';
          sprite.setDirection(moveOffset[0], moveOffset[1]);
        } else {
          sprite.state = 'standing';
        }

        sprite.draw(surf, worldX, worldY, cameraOffsetX, cameraOffsetY);
      } else {
        this.drawPlaceholder(surf, unit, worldX, worldY, cameraOffsetX, cameraOffsetY);
      }
    }
  }

  /**
   * Update sprite states based on unit state.
   * Called independently of drawing when you need to sync states without rendering.
   */
  updateSpriteStates(units: UnitObject[]): void {
    for (const unit of units) {
      const sprite = this.sprites.get(unit.nid);
      if (!sprite) continue;

      if (unit.isDead()) {
        // Dead units won't be drawn, but keep state consistent
        sprite.state = 'gray';
      } else if (unit.finished) {
        sprite.state = 'gray';
      } else if (sprite.state === 'gray') {
        // Unit is no longer finished; restore to standing
        sprite.state = 'standing';
      }
    }
  }

  /**
   * Draw a simple colored rectangle placeholder for units without sprites.
   * Color is determined by team affiliation.
   */
  drawPlaceholder(
    surf: Surface,
    unit: UnitObject,
    worldX: number,
    worldY: number,
    offsetX: number,
    offsetY: number,
  ): void {
    const px = worldX - offsetX;
    const py = worldY - offsetY;

    const color = placeholderColor(unit.team);
    const inset = 2;
    surf.fillRect(px + inset, py + inset, TILEWIDTH - inset * 2, TILEHEIGHT - inset * 2, color);

    // Dim overlay for finished units
    if (unit.finished) {
      surf.fillRect(px, py, TILEWIDTH, TILEHEIGHT, 'rgba(0,0,0,0.35)');
    }
  }
}

/** Map team string to a placeholder rectangle color. */
function placeholderColor(team: string): string {
  switch (team) {
    case 'player':
      return '#3060ff';
    case 'enemy':
      return '#ff3030';
    case 'other':
      return '#30ff30';
    default:
      return '#a0a0a0';
  }
}
