// ---------------------------------------------------------------------------
// MovementSystem — Manages unit movement animations along grid paths.
// Interpolates smoothly between tiles and updates unit positions as each
// tile is reached, matching the feel of LT's ~6 tiles/second default speed.
// ---------------------------------------------------------------------------

import type { UnitObject } from '../objects/unit';

/** Default movement speed in tiles per second (matches LT's feel). */
const DEFAULT_SPEED = 6;

interface MovementComponent {
  unit: UnitObject;
  path: [number, number][];
  currentIndex: number;
  progress: number;   // 0..1 interpolation between current and next tile
  speed: number;       // tiles per second
  done: boolean;
  onComplete?: () => void;
}

/**
 * Manages all active unit movement animations.
 *
 * Usage:
 *   1. Call `beginMove()` to start a unit along a path.
 *   2. Call `update(deltaMs)` every frame.
 *   3. Use `getVisualOffset()` during rendering to smoothly position sprites
 *      between grid tiles while the movement is in progress.
 */
export class MovementSystem {
  private components: MovementComponent[] = [];

  /**
   * Start moving a unit along a path.
   *
   * @param unit       The unit to move.
   * @param path       Ordered list of [x, y] tiles. The first entry should be
   *                   the unit's current position.
   * @param speed      Movement speed in tiles/second (default ~6).
   * @param onComplete Callback fired when the unit reaches the end of the path.
   */
  beginMove(
    unit: UnitObject,
    path: [number, number][],
    speed: number = DEFAULT_SPEED,
    onComplete?: () => void,
  ): void {
    // If the path has 0 or 1 entries there is nothing to animate.
    if (path.length <= 1) {
      if (path.length === 1) {
        unit.position = [path[0][0], path[0][1]];
      }
      unit.hasMoved = true;
      onComplete?.();
      return;
    }

    // Place the unit at the start of the path immediately.
    unit.position = [path[0][0], path[0][1]];

    this.components.push({
      unit,
      path,
      currentIndex: 0,
      progress: 0,
      speed,
      done: false,
      onComplete,
    });
  }

  /**
   * Advance all active movements by `deltaMs` milliseconds.
   * @returns `true` if at least one movement is still active after the update.
   */
  update(deltaMs: number): boolean {
    const dt = deltaMs / 1000; // convert to seconds

    for (const comp of this.components) {
      if (comp.done) continue;

      // How many tiles worth of distance we travel this frame
      const tileStep = comp.speed * dt;
      comp.progress += tileStep;

      // Consume full tile steps
      while (comp.progress >= 1 && comp.currentIndex < comp.path.length - 1) {
        comp.progress -= 1;
        comp.currentIndex++;

        // Snap the unit to the tile we just arrived at
        const [tx, ty] = comp.path[comp.currentIndex];
        comp.unit.position = [tx, ty];

        // Check if we've reached the end
        if (comp.currentIndex >= comp.path.length - 1) {
          comp.progress = 0;
          comp.done = true;
          comp.unit.hasMoved = true;
          comp.onComplete?.();
          break;
        }
      }
    }

    // Purge completed components
    this.components = this.components.filter((c) => !c.done);

    return this.components.length > 0;
  }

  /** Returns `true` if any unit movement animation is still in progress. */
  isMoving(): boolean {
    return this.components.length > 0;
  }

  /**
   * Get the sub-tile visual offset for a unit that is currently being moved.
   *
   * During animation the unit's `position` is snapped to the last reached
   * tile. The returned offset (in tile units, not pixels) represents how far
   * between the current tile and the next tile the sprite should be drawn.
   *
   * @returns `[offsetX, offsetY]` in tile units, or `null` if the unit is
   *          not currently being moved.
   */
  getVisualOffset(unit: UnitObject): [number, number] | null {
    const comp = this.components.find((c) => c.unit === unit);
    if (!comp || comp.done) return null;

    const idx = comp.currentIndex;
    if (idx >= comp.path.length - 1) return null;

    const [cx, cy] = comp.path[idx];
    const [nx, ny] = comp.path[idx + 1];
    const t = comp.progress; // 0..1

    const offsetX = (nx - cx) * t;
    const offsetY = (ny - cy) * t;
    return [offsetX, offsetY];
  }
}
