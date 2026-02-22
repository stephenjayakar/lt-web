/**
 * OverworldMovementManager - Handles animated movement of entities
 * along roads on the overworld map.
 *
 * Port of: lt-maker/app/engine/overworld/overworld_movement_manager.py
 */

import type { OverworldEntityObject } from './overworld-objects';

interface OverworldMovementData {
  entityNid: string;
  entity: OverworldEntityObject;
  path: [number, number][];
  pathIndex: number;
  progress: number;  // 0..1 between current and next waypoint
  speed: number;     // tiles per second
  callback: (() => void) | null;
}

/** Default movement speed in tiles per second. */
const DEFAULT_SPEED = 6;

export class OverworldMovementManager {
  private movements: Map<string, OverworldMovementData> = new Map();
  /** Entity NID whose position the camera should follow. */
  cameraFollow: string | null = null;

  /**
   * Begin moving an entity along a path of waypoints.
   */
  beginMove(
    entity: OverworldEntityObject,
    path: [number, number][],
    options?: {
      follow?: boolean;
      speed?: number;
      callback?: () => void;
    },
  ): void {
    if (path.length < 2) {
      // Already at destination or invalid path
      if (path.length === 1) {
        entity.displayPosition = [path[0][0], path[0][1]];
      }
      options?.callback?.();
      return;
    }

    const data: OverworldMovementData = {
      entityNid: entity.nid,
      entity,
      path,
      pathIndex: 0,
      progress: 0,
      speed: options?.speed ?? DEFAULT_SPEED,
      callback: options?.callback ?? null,
    };

    this.movements.set(entity.nid, data);

    if (options?.follow) {
      this.cameraFollow = entity.nid;
    }

    // Set initial position
    entity.displayPosition = [path[0][0], path[0][1]];
  }

  /**
   * Update all active movements. Call once per frame.
   * @param deltaMs Frame delta in milliseconds.
   */
  update(deltaMs: number): void {
    const toRemove: string[] = [];

    for (const [nid, data] of this.movements) {
      const dt = deltaMs / 1000; // seconds
      const tilesMoved = data.speed * dt;

      // Compute distance between current and next waypoint
      const from = data.path[data.pathIndex];
      const to = data.path[data.pathIndex + 1];
      const dx = to[0] - from[0];
      const dy = to[1] - from[1];
      const segmentLength = Math.sqrt(dx * dx + dy * dy);

      if (segmentLength < 0.001) {
        // Zero-length segment, skip
        data.pathIndex++;
        data.progress = 0;
        if (data.pathIndex >= data.path.length - 1) {
          this.finishMovement(data);
          toRemove.push(nid);
        }
        continue;
      }

      // Advance progress
      data.progress += tilesMoved / segmentLength;

      while (data.progress >= 1) {
        data.pathIndex++;
        data.progress -= 1;

        if (data.pathIndex >= data.path.length - 1) {
          // Reached the end
          this.finishMovement(data);
          toRemove.push(nid);
          break;
        }

        // Recompute for next segment
        const newFrom = data.path[data.pathIndex];
        const newTo = data.path[data.pathIndex + 1];
        const newDx = newTo[0] - newFrom[0];
        const newDy = newTo[1] - newFrom[1];
        const newLen = Math.sqrt(newDx * newDx + newDy * newDy);
        if (newLen < 0.001) {
          data.progress = 1; // will skip on next iteration
        } else {
          // Convert leftover progress from old segment to new segment
          data.progress *= segmentLength / newLen;
        }
      }

      // Interpolate display position
      if (!toRemove.includes(nid) && data.pathIndex < data.path.length - 1) {
        const a = data.path[data.pathIndex];
        const b = data.path[data.pathIndex + 1];
        const t = Math.max(0, Math.min(1, data.progress));
        data.entity.displayPosition = [
          a[0] + (b[0] - a[0]) * t,
          a[1] + (b[1] - a[1]) * t,
        ];
      }
    }

    for (const nid of toRemove) {
      this.movements.delete(nid);
    }
  }

  /**
   * Finish a movement: snap to final position and call callback.
   */
  private finishMovement(data: OverworldMovementData): void {
    const finalPos = data.path[data.path.length - 1];
    data.entity.displayPosition = [finalPos[0], finalPos[1]];

    if (this.cameraFollow === data.entityNid) {
      this.cameraFollow = null;
    }

    data.callback?.();
  }

  /**
   * Interrupt a specific entity's movement (snap to current interpolated pos).
   */
  interruptMovement(entityNid: string): void {
    const data = this.movements.get(entityNid);
    if (!data) return;

    // Already has interpolated displayPosition set in update
    this.movements.delete(entityNid);

    if (this.cameraFollow === entityNid) {
      this.cameraFollow = null;
    }
  }

  /**
   * Finish all active movements instantly (snap to final positions).
   */
  finishAllMovement(): void {
    for (const data of this.movements.values()) {
      this.finishMovement(data);
    }
    this.movements.clear();
    this.cameraFollow = null;
  }

  /**
   * Check if any entity is currently moving.
   */
  isMoving(): boolean {
    return this.movements.size > 0;
  }

  /**
   * Get the position of the entity the camera should follow, or null.
   */
  getFollowingEntityPosition(): [number, number] | null {
    if (!this.cameraFollow) return null;
    const data = this.movements.get(this.cameraFollow);
    if (!data) return null;
    return data.entity.displayPosition;
  }
}
