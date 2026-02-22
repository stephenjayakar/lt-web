/**
 * roam-movement.ts — Physics-based movement components for free roam mode.
 *
 * Contains:
 *   RoamPlayerMovementComponent — Player-controlled pixel movement with
 *     acceleration, deceleration, sprinting, and collision detection.
 *   RationalizeMovementComponent — Slides a unit from a sub-tile roam
 *     position back to the nearest valid grid tile.
 */

import type { UnitObject } from '../objects/unit';

/** Pixel-precision position for sub-tile rendering during roam. */
export interface RoamPosition {
  x: number; // float, in tile units
  y: number; // float, in tile units
}

/**
 * RoamPlayerMovementComponent — Physics-based pixel movement for the
 * player's roam unit. Handles acceleration, deceleration, sprinting,
 * and collision detection against terrain and enemy units.
 */
export class RoamPlayerMovementComponent {
  unit: UnitObject;
  active: boolean = true;

  // Physics constants (in tiles/second)
  private minSpeed = 0.48;
  private baseMaxSpeed = 6.0;
  private baseAccel = 30.0;
  private runningAccel = 36.0;
  private deceleration = 72.0;

  // State
  private velocityX = 0;
  private velocityY = 0;
  private sprinting = false;
  private accelerationDir: [number, number] = [0, 0]; // -1, 0, or 1 per axis

  // Sub-tile position
  roamPosition: RoamPosition | null = null;

  // Board reference for collision checks
  private boardRef: any; // GameBoard
  private dbRef: any; // Database

  constructor(unit: UnitObject, board: any, db: any) {
    this.unit = unit;
    this.boardRef = board;
    this.dbRef = db;
    // Initialize roam position from current grid position
    if (unit.position) {
      this.roamPosition = { x: unit.position[0], y: unit.position[1] };
    }
  }

  setSprinting(sprint: boolean): void {
    this.sprinting = sprint;
  }

  setAcceleration(dx: number, dy: number): void {
    this.accelerationDir = [dx, dy];
  }

  private getMaxSpeed(): number {
    let speed = this.baseMaxSpeed;
    if (this.sprinting) speed *= 1.5;
    return speed;
  }

  private getAcceleration(): number {
    return this.sprinting ? this.runningAccel : this.baseAccel;
  }

  /** Update physics for one frame. */
  update(dt: number): void {
    if (!this.active || !this.roamPosition) return;

    // Cap dt to prevent tunneling
    dt = Math.min(dt, 4 / 60);

    this.accelerate(dt);

    const speed = Math.sqrt(
      this.velocityX * this.velocityX + this.velocityY * this.velocityY,
    );
    if (speed > this.minSpeed) {
      this.move(dt);
      // Update sprite to moving state
      this.updateSprite(true);
    } else {
      this.velocityX = 0;
      this.velocityY = 0;
      this.updateSprite(false);
    }
  }

  private accelerate(dt: number): void {
    const [dx, dy] = this.accelerationDir;
    const maxSpeed = this.getMaxSpeed();
    const accel = this.getAcceleration();
    const decel = this.deceleration;

    // X axis
    if (dx !== 0) {
      this.velocityX += dx * accel * dt;
    } else {
      if (Math.abs(this.velocityX) < decel * dt) {
        this.velocityX = 0;
      } else {
        this.velocityX -= Math.sign(this.velocityX) * decel * dt;
      }
    }

    // Y axis
    if (dy !== 0) {
      this.velocityY += dy * accel * dt;
    } else {
      if (Math.abs(this.velocityY) < decel * dt) {
        this.velocityY = 0;
      } else {
        this.velocityY -= Math.sign(this.velocityY) * decel * dt;
      }
    }

    // Clamp to max speed
    this.velocityX = Math.max(-maxSpeed, Math.min(maxSpeed, this.velocityX));
    this.velocityY = Math.max(-maxSpeed, Math.min(maxSpeed, this.velocityY));

    // Diagonal normalization
    const mag = Math.sqrt(
      this.velocityX * this.velocityX + this.velocityY * this.velocityY,
    );
    if (mag > maxSpeed) {
      const scale = maxSpeed / mag;
      this.velocityX *= scale;
      this.velocityY *= scale;
    }
  }

  private move(dt: number): void {
    if (!this.roamPosition) return;

    const newX = this.roamPosition.x + this.velocityX * dt;
    const newY = this.roamPosition.y + this.velocityY * dt;

    // Try full move first
    if (this.canMoveTo(newX, newY)) {
      this.roamPosition.x = newX;
      this.roamPosition.y = newY;
    } else {
      // Try horizontal only
      if (this.canMoveTo(newX, this.roamPosition.y)) {
        this.roamPosition.x = newX;
        this.velocityY = 0;
      }
      // Try vertical only
      else if (this.canMoveTo(this.roamPosition.x, newY)) {
        this.roamPosition.y = newY;
        this.velocityX = 0;
      }
      // Blocked both ways
      else {
        this.velocityX = 0;
        this.velocityY = 0;
      }
    }

    // Sync grid position when crossing tile boundaries
    this.syncGridPosition();
  }

  /** Check if a position is traversable. */
  private canMoveTo(x: number, y: number): boolean {
    if (!this.boardRef) return true;
    const tileX = Math.round(x);
    const tileY = Math.round(y);

    // Bounds check
    if (
      tileX < 0 ||
      tileY < 0 ||
      tileX >= this.boardRef.width ||
      tileY >= this.boardRef.height
    ) {
      return false;
    }

    // Check terrain traversability
    const terrain = this.boardRef.getTerrain(tileX, tileY);
    if (terrain) {
      const klassNid = this.unit.klass;
      const klassDef = this.dbRef?.classes?.get(klassNid);
      const moveGroup = klassDef?.movement_group || 'Infantry';
      const cost = this.dbRef?.getMovementCost?.(terrain, moveGroup) ?? 1;
      if (cost >= 99) return false;
    }

    // Check for enemy units blocking
    const blockingUnit = this.boardRef.getUnit(tileX, tileY);
    if (
      blockingUnit &&
      blockingUnit !== this.unit &&
      blockingUnit.team !== this.unit.team
    ) {
      return false;
    }

    return true;
  }

  /** Sync the unit's grid position when the rounded roam position changes. */
  private syncGridPosition(): void {
    if (!this.roamPosition || !this.unit.position) return;
    const roundedX = Math.round(this.roamPosition.x);
    const roundedY = Math.round(this.roamPosition.y);
    if (
      roundedX !== this.unit.position[0] ||
      roundedY !== this.unit.position[1]
    ) {
      // Quick leave/arrive: update board grid
      if (this.boardRef) {
        this.boardRef.removeUnit(this.unit);
        this.boardRef.setUnit(roundedX, roundedY, this.unit);
      } else {
        this.unit.position = [roundedX, roundedY];
      }
    }
  }

  private updateSprite(moving: boolean): void {
    const spr = this.unit.sprite;
    if (spr && typeof spr === 'object' && 'state' in spr) {
      (spr as any).state = moving ? 'moving' : 'standing';
      if (moving && 'setDirection' in (spr as any)) {
        (spr as any).setDirection(
          Math.abs(this.velocityX) > Math.abs(this.velocityY)
            ? Math.sign(this.velocityX)
            : 0,
          Math.abs(this.velocityY) >= Math.abs(this.velocityX)
            ? Math.sign(this.velocityY)
            : 0,
        );
      }
    }
  }

  /** Stop all movement and return the final roam position. */
  finish(): RoamPosition | null {
    this.velocityX = 0;
    this.velocityY = 0;
    this.active = false;
    this.updateSprite(false);
    return this.roamPosition;
  }

  /** Get the sub-tile visual offset for rendering. */
  getVisualOffset(): [number, number] | null {
    if (!this.roamPosition || !this.unit.position) return null;
    const ox = this.roamPosition.x - this.unit.position[0];
    const oy = this.roamPosition.y - this.unit.position[1];
    if (Math.abs(ox) < 0.01 && Math.abs(oy) < 0.01) return null;
    return [ox, oy];
  }
}

/**
 * RationalizeMovementComponent — Slides a unit from a sub-tile roam
 * position back to the nearest valid grid tile. Used when transitioning
 * out of roam mode (e.g., when an event triggers).
 */
export class RationalizeMovementComponent {
  unit: UnitObject;
  startPos: RoamPosition;
  targetPos: [number, number];
  done: boolean = false;
  private speed: number = 6; // tiles per second
  private currentPos: RoamPosition;

  constructor(unit: UnitObject, roamPos: RoamPosition, board?: any) {
    this.unit = unit;
    this.startPos = { ...roamPos };
    this.currentPos = { ...roamPos };

    // Target is the nearest valid grid tile
    let targetX = Math.round(roamPos.x);
    let targetY = Math.round(roamPos.y);

    // Check if target tile is occupied by another unit
    if (board) {
      const existing = board.getUnit(targetX, targetY);
      if (existing && existing !== unit) {
        // Try adjacent tiles
        const dirs: [number, number][] = [
          [0, -1],
          [0, 1],
          [-1, 0],
          [1, 0],
        ];
        for (const [dx, dy] of dirs) {
          const tx = targetX + dx;
          const ty = targetY + dy;
          if (tx >= 0 && ty >= 0 && tx < board.width && ty < board.height) {
            if (!board.getUnit(tx, ty)) {
              targetX = tx;
              targetY = ty;
              break;
            }
          }
        }
      }
    }
    this.targetPos = [targetX, targetY];
  }

  update(dt: number): boolean {
    if (this.done) return true;

    const dx = this.targetPos[0] - this.currentPos.x;
    const dy = this.targetPos[1] - this.currentPos.y;
    const dist = Math.sqrt(dx * dx + dy * dy);

    if (dist < 0.01) {
      this.finish();
      return true;
    }

    const step = this.speed * dt;
    if (step >= dist) {
      this.finish();
      return true;
    }

    // Move toward target
    this.currentPos.x += (dx / dist) * step;
    this.currentPos.y += (dy / dist) * step;
    return false;
  }

  private finish(): void {
    this.done = true;
    this.currentPos.x = this.targetPos[0];
    this.currentPos.y = this.targetPos[1];

    // Update sprite
    const spr = this.unit.sprite;
    if (spr && typeof spr === 'object' && 'state' in spr) {
      (spr as any).state = 'standing';
    }
  }

  getVisualOffset(): [number, number] | null {
    if (this.done || !this.unit.position) return null;
    const ox = this.currentPos.x - this.unit.position[0];
    const oy = this.currentPos.y - this.unit.position[1];
    if (Math.abs(ox) < 0.01 && Math.abs(oy) < 0.01) return null;
    return [ox, oy];
  }
}
