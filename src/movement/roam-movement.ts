/**
 * roam-movement.ts — Free-roam movement components (Python
 * `movement/roam_player_movement_component.py`,
 * `roam_ai_movement_component.py` and `rationalize_movement_component.py`,
 * as of EOtF's engine fork; upstream later added the roam_dir_pose idle
 * poses and the roam AI speed multiplier, which the fork does not have).
 *
 * Python keeps a roaming unit's float position on its sprite
 * (`sprite.set_roam_position`) while `unit.position` is the rounded tile.
 * Here that float position lives in a per-unit registry
 * (`getRoamPosition` / `setRoamPosition`), which the map renderer reads
 * for every unit, so NPC roamers and rationalizing units draw between tiles
 * too.
 *
 * Python's board allows several units per tile: the roam unit walks
 * through allied units, and an NPC may walk onto the player's tile. The web
 * board keeps one unit per tile, so `quickArrive` leaves the existing
 * occupant in the grid and only sets the arriving unit's position, and
 * `quickLeave` puts a stacked unit back into the grid when the tile frees.
 */

import type { UnitObject } from '../objects/unit';
import { movementType } from '../combat/skill-system';
import { playUnitSound, stopUnitSound } from '../audio/unit-sound';

/** Pixel-precision position for sub-tile rendering during roam. */
export interface RoamPosition {
  x: number; // float, in tile units
  y: number; // float, in tile units
}

// ---------------------------------------------------------------------------
// Sprite roam-position registry (Python UnitSprite._roam_position)
// ---------------------------------------------------------------------------

const roamPositions = new WeakMap<UnitObject, RoamPosition>();

export function getRoamPosition(unit: UnitObject): RoamPosition | null {
  return roamPositions.get(unit) ?? null;
}

export function setRoamPosition(unit: UnitObject, pos: RoamPosition | null): void {
  if (pos) roamPositions.set(unit, pos);
  else roamPositions.delete(unit);
}

/** Draw offset (tiles) of a unit's roam position from its grid tile. */
export function roamVisualOffset(unit: UnitObject): [number, number] | null {
  const pos = roamPositions.get(unit);
  if (!pos || !unit.position) return null;
  const ox = pos.x - unit.position[0];
  const oy = pos.y - unit.position[1];
  if (Math.abs(ox) < 0.001 && Math.abs(oy) < 0.001) return null;
  return [ox, oy];
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Python round(): halves go to the even neighbour. */
export function pyRound(value: number): number {
  const floor = Math.floor(value);
  const diff = value - floor;
  if (diff > 0.5) return floor + 1;
  if (diff < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

function roundPos(x: number, y: number): [number, number] {
  return [pyRound(x), pyRound(y)];
}

/** Environment the roam components read: board, database and game state. */
export interface RoamEnv {
  board: any;
  db: any;
  game?: any;
}

function unitsOf(env: RoamEnv): Iterable<UnitObject> {
  return env.game?.units?.values?.() ?? [];
}

/** Python action.QuickLeave: off the board, restoring a unit stacked beneath. */
export function quickLeave(env: RoamEnv, unit: UnitObject): void {
  const pos = unit.position;
  if (!pos) return;
  if (!env.board) {
    unit.position = null;
    return;
  }
  env.board.removeUnit(unit);
  if (!env.board.getUnit(pos[0], pos[1])) {
    for (const other of unitsOf(env)) {
      if (other === unit || !other.position || other.isDead?.()) continue;
      if (other.position[0] === pos[0] && other.position[1] === pos[1]) {
        env.board.setUnit(pos[0], pos[1], other);
        break;
      }
    }
  }
}

/** Python action.QuickArrive: onto the board, stacking over an occupant. */
export function quickArrive(env: RoamEnv, unit: UnitObject, pos: [number, number]): void {
  if (!env.board) {
    unit.position = [pos[0], pos[1]];
    return;
  }
  const occupant = env.board.getUnit(pos[0], pos[1]);
  if (occupant && occupant !== unit) {
    unit.position = [pos[0], pos[1]];
  } else {
    env.board.setUnit(pos[0], pos[1], unit);
  }
}

function movementGroupOf(env: RoamEnv, unit: UnitObject): string {
  const klassDef = env.db?.classes?.get(unit.klass);
  return movementType(unit, klassDef?.movement_group || 'Infantry');
}

/** Python movement_funcs.get_mcost. */
function mcost(env: RoamEnv, unit: UnitObject, pos: [number, number]): number {
  if (!env.board?.getMovementCost) return 1;
  return env.board.getMovementCost(pos[0], pos[1], movementGroupOf(env, unit), env.db) ?? 1;
}

/** Python movement_funcs.check_traversable: in bounds and mcost <= MOVEMENT. */
function checkTraversable(env: RoamEnv, unit: UnitObject, pos: [number, number]): boolean {
  if (!env.board) return true;
  if (!env.board.checkBounds(pos[0], pos[1])) return false;
  return mcost(env, unit, pos) <= unit.getMovement();
}

/** Python DB.teams.get_allies(team) contains `other`. */
function alliedTeams(env: RoamEnv, team: string, other: string): boolean {
  if (team === other) return true;
  const alliances: [string, string][] = env.db?.teams?.alliances ?? [];
  return alliances.some(([a, b]) => (a === team && b === other) || (a === other && b === team));
}

function setSpriteMoving(unit: UnitObject, moving: boolean, vx = 0, vy = 0): void {
  const spr = unit.sprite as any;
  if (!spr || typeof spr !== 'object' || !('state' in spr)) return;
  spr.state = moving ? 'moving' : 'standing';
  if (moving && typeof spr.setDirection === 'function') {
    spr.setDirection(
      Math.abs(vx) > Math.abs(vy) ? Math.sign(vx) : 0,
      Math.abs(vy) >= Math.abs(vx) ? Math.sign(vy) : 0,
    );
  }
}

// ---------------------------------------------------------------------------
// RoamPlayerMovementComponent
// ---------------------------------------------------------------------------

/**
 * Python RoamPlayerMovementComponent: the player's roam unit, driven by the
 * input vector, with acceleration, deceleration and sprinting.
 */
export class RoamPlayerMovementComponent {
  unit: UnitObject;
  active: boolean = true;
  protected muted: boolean;

  protected readonly minSpeed = 0.48;
  protected readonly baseMaxSpeed = 6.0;
  protected readonly baseAccel = 30.0;
  protected readonly runningAccel = 36.0;
  protected readonly deceleration = 72.0;

  protected velocityX = 0;
  protected velocityY = 0;
  protected sprinting = false;
  /** Python x_mag / y_mag: the requested direction. */
  protected magX = 0;
  protected magY = 0;

  protected env: RoamEnv;

  constructor(unit: UnitObject, board: any, db: any, game?: any, muted = false) {
    this.unit = unit;
    this.env = { board, db, game };
    this.muted = muted;
    if (unit.position) setRoamPosition(unit, { x: unit.position[0], y: unit.position[1] });
  }

  /** The unit's float position (Python self.position / sprite roam position). */
  get roamPosition(): RoamPosition | null {
    return getRoamPosition(this.unit);
  }

  set roamPosition(pos: RoamPosition | null) {
    setRoamPosition(this.unit, pos ? { x: pos.x, y: pos.y } : null);
  }

  /** Python reset_position. */
  resetPosition(): void {
    if (this.unit.position) this.roamPosition = { x: this.unit.position[0], y: this.unit.position[1] };
  }

  setSprinting(sprint: boolean): void {
    this.sprinting = sprint;
  }

  setAcceleration(dx: number, dy: number): void {
    this.magX = dx;
    this.magY = dy;
  }

  protected getAcceleration(): number {
    return this.sprinting ? this.runningAccel : this.baseAccel;
  }

  /** Python get_max_speed: sprint x1.5, `_roam_speed` game var, slowed by the tile's mcost. */
  protected getMaxSpeed(): number {
    const roamSpeed = Number(this.env.game?.gameVars?.get?.('_roam_speed') ?? 1);
    let speed = (this.sprinting ? 1.5 : 1) * (Number.isFinite(roamSpeed) ? roamSpeed : 1) * this.baseMaxSpeed;
    if (this.unit.position) {
      const cost = mcost(this.env, this.unit, this.unit.position);
      if (cost > 0) speed /= cost;
    }
    return speed;
  }

  /** Update physics for one frame (dt in seconds). */
  update(dt: number): void {
    if (!this.active || !this.roamPosition || !this.unit.position) return;
    // Python: never let delta time exceed four frames.
    dt = Math.min(dt, 4 / 60);
    this.kinematics(dt);
    if (Math.hypot(this.velocityX, this.velocityY) > this.minSpeed) {
      this.move(dt);
      setSpriteMoving(this.unit, true, this.velocityX, this.velocityY);
      if (!this.muted) playUnitSound(this.unit);
    } else {
      setSpriteMoving(this.unit, false);
      stopUnitSound(this.unit);
    }
  }

  protected kinematics(dt: number): void {
    this.accelerate(dt, this.magX, this.magY);
  }

  /** Python _accelerate. */
  protected accelerate(dt: number, magX: number, magY: number): void {
    const maxSpeed = this.getMaxSpeed();
    const accel = this.getAcceleration();
    if (magX > 0) this.velocityX += accel * dt;
    else if (magX < 0) this.velocityX -= accel * dt;
    else if (this.velocityX > 0) this.velocityX = Math.max(0, this.velocityX - this.deceleration * dt);
    else if (this.velocityX < 0) this.velocityX = Math.min(0, this.velocityX + this.deceleration * dt);
    this.velocityX = Math.max(-maxSpeed, Math.min(maxSpeed, this.velocityX));

    if (magY > 0) this.velocityY += accel * dt;
    else if (magY < 0) this.velocityY -= accel * dt;
    else if (this.velocityY > 0) this.velocityY = Math.max(0, this.velocityY - this.deceleration * dt);
    else if (this.velocityY < 0) this.velocityY = Math.min(0, this.velocityY + this.deceleration * dt);
    this.velocityY = Math.max(-maxSpeed, Math.min(maxSpeed, this.velocityY));

    // Diagonal movement shouldn't be faster than single-axis.
    const full = Math.hypot(this.velocityX, this.velocityY);
    if (full > maxSpeed) {
      this.velocityX *= maxSpeed / full;
      this.velocityY *= maxSpeed / full;
    }
  }

  /** Python _can_move. */
  protected canMove(pos: [number, number]): boolean {
    if (!checkTraversable(this.env, this.unit, pos)) return false;
    const occupant = this.env.board?.getUnit(pos[0], pos[1]);
    if (occupant) {
      // Allies are fine; enemies block.
      return alliedTeams(this.env, occupant.team, this.unit.team);
    }
    // Diagonal: the two orthogonal neighbours must not both be impassable.
    const here = this.unit.position;
    if (here && pos[0] !== here[0] && pos[1] !== here[1]) {
      if (!this.canMove([pos[0], here[1]]) && !this.canMove([here[0], pos[1]])) return false;
    }
    return true;
  }

  /**
   * Python correct_horizontal_movement: stop the sprite from visibly
   * sliding more than 0.15 tiles into an impassable tile to either side.
   */
  protected correctHorizontalMovement(rounded: [number, number], next: [number, number]): boolean {
    const threshold = 0.15;
    const half = 0.5;
    const east: [number, number] = [rounded[0] + 1, rounded[1]];
    const west: [number, number] = [rounded[0] - 1, rounded[1]];
    const southeast: [number, number] = [rounded[0] + 1, rounded[1] + 1];
    const southwest: [number, number] = [rounded[0] - 1, rounded[1] + 1];
    const toFloor = (d: number) => d - Math.floor(d);
    const toCeil = (d: number) => Math.abs(d - Math.ceil(d));
    if (this.velocityX > 0 && !this.canMove(east) && threshold < toFloor(next[0]) && toFloor(next[0]) < half) {
      this.velocityX = this.minSpeed + 0.001;
      return false;
    } else if (this.velocityX > 0 && !this.canMove(southeast) &&
        threshold < toFloor(next[0]) && toFloor(next[0]) < half &&
        toFloor(next[1]) > 0 && toFloor(next[1]) < half) {
      this.velocityX = this.minSpeed + 0.001;
      return false;
    } else if (this.velocityX < 0 && !this.canMove(west) && threshold < toCeil(next[0]) && toCeil(next[0]) < half) {
      this.velocityX = -(this.minSpeed + 0.001);
      return false;
    } else if (this.velocityX < 0 && !this.canMove(southwest) &&
        threshold < toCeil(next[0]) && toCeil(next[0]) < half &&
        toFloor(next[1]) > 0 && toFloor(next[1]) < half) {
      this.velocityX = -(this.minSpeed + 0.001);
      return false;
    }
    return true;
  }

  /** Python correct_vertical_movement: never visibly enter an impassable tile below. */
  protected correctVerticalMovement(rounded: [number, number], next: [number, number]): boolean {
    const south: [number, number] = [rounded[0], rounded[1] + 1];
    const toFloor = next[1] - Math.floor(next[1]);
    if (this.velocityY > 0 && !this.canMove(south) && toFloor > 0 && toFloor < 0.5) {
      this.velocityY = this.minSpeed + 0.001;
      return false;
    }
    return true;
  }

  /** Python move. */
  protected move(dt: number): void {
    const pos = this.roamPosition;
    const here = this.unit.position;
    if (!pos || !here) return;
    const dx = this.velocityX * dt;
    const dy = this.velocityY * dt;
    const next: [number, number] = [pos.x + dx, pos.y + dy];
    const altH: [number, number] = [pos.x + dx, pos.y];
    const altV: [number, number] = [pos.x, pos.y + dy];
    let rounded = roundPos(next[0], next[1]);
    const roundedH = roundPos(altH[0], altH[1]);
    const roundedV = roundPos(altV[0], altV[1]);

    const horizontalClear = this.correctHorizontalMovement(rounded, next);
    const verticalClear = this.correctVerticalMovement(rounded, next);

    let target: [number, number];
    const sameTile = rounded[0] === here[0] && rounded[1] === here[1];
    if ((sameTile || this.canMove(rounded)) && horizontalClear && verticalClear) {
      target = next;
    } else if (this.canMove(roundedH) && horizontalClear) {
      target = altH;
      rounded = roundedH;
    } else if (this.canMove(roundedV) && verticalClear) {
      target = altV;
      rounded = roundedV;
    } else {
      return;
    }
    this.roamPosition = { x: target[0], y: target[1] };

    if (rounded[0] !== here[0] || rounded[1] !== here[1]) {
      quickLeave(this.env, this.unit);
      quickArrive(this.env, this.unit, rounded);
    }
  }

  /** Python finish: stop moving (the roam position stays until rationalized). */
  finish(): RoamPosition | null {
    this.velocityX = 0;
    this.velocityY = 0;
    this.active = false;
    setSpriteMoving(this.unit, false);
    stopUnitSound(this.unit);
    return this.roamPosition;
  }

  /** Get the sub-tile visual offset for rendering. */
  getVisualOffset(): [number, number] | null {
    return roamVisualOffset(this.unit);
  }
}

// ---------------------------------------------------------------------------
// RoamAIMovementComponent
// ---------------------------------------------------------------------------

/**
 * Python RoamAIMovementComponent: steers an NPC roamer along the path its
 * RoamAI hands it (goal first, next waypoint last, like Python).
 */
export class RoamAIMovementComponent extends RoamPlayerMovementComponent {
  private path: [number, number][] = [];
  /** Upstream scales by the behaviour's roam_speed; the fork never sets it. */
  private speedModifier = 1;

  constructor(unit: UnitObject, board: any, db: any, game?: any) {
    super(unit, board, db, game, false);
  }

  setSpeed(mult: number): void {
    this.speedModifier = mult;
  }

  /** Python set_path: drop the current tile from the end. */
  setPath(path: [number, number][]): void {
    const here = this.unit.position;
    if (path.length && here && path[path.length - 1][0] === here[0] && path[path.length - 1][1] === here[1]) {
      path.pop();
    }
    this.path = path;
  }

  /** Python start: zero velocity and resume. */
  start(): void {
    this.velocityX = 0;
    this.velocityY = 0;
    this.magX = 0;
    this.magY = 0;
    this.active = true;
  }

  protected override getAcceleration(): number {
    return this.baseAccel;
  }

  protected override kinematics(dt: number): void {
    const pos = this.roamPosition;
    if (this.path.length && pos) {
      const [tx, ty] = this.path[this.path.length - 1];
      const vx = tx - pos.x;
      const vy = ty - pos.y;
      const mag = Math.hypot(vx, vy);
      this.magX = mag ? vx / mag : vx;
      this.magY = mag ? vy / mag : vy;
    } else {
      this.magX = 0;
      this.magY = 0;
    }
    this.accelerate(dt, this.magX, this.magY);
  }

  /** Python RoamAIMovementComponent.move (no wall-hugging corrections). */
  protected override move(dt: number): void {
    const pos = this.roamPosition;
    const here = this.unit.position;
    if (!pos || !here) return;
    const dx = this.velocityX * dt * this.speedModifier;
    const dy = this.velocityY * dt * this.speedModifier;
    const next: [number, number] = [pos.x + dx, pos.y + dy];
    const altH: [number, number] = [pos.x + dx, pos.y];
    const altV: [number, number] = [pos.x, pos.y + dy];
    let rounded = roundPos(next[0], next[1]);
    const roundedH = roundPos(altH[0], altH[1]);
    const roundedV = roundPos(altV[0], altV[1]);

    let target: [number, number];
    if ((rounded[0] === here[0] && rounded[1] === here[1]) || this.canMove(rounded)) {
      target = next;
    } else if (this.canMove(roundedH)) {
      target = altH;
      rounded = roundedH;
    } else if (this.canMove(roundedV)) {
      target = altV;
      rounded = roundedV;
    } else {
      this.path.length = 0;
      return;
    }
    this.roamPosition = { x: target[0], y: target[1] };

    if (rounded[0] !== here[0] || rounded[1] !== here[1]) {
      quickLeave(this.env, this.unit);
      quickArrive(this.env, this.unit, rounded);
    }
    const now = this.unit.position;
    const last = this.path[this.path.length - 1];
    if (last && now && now[0] === last[0] && now[1] === last[1]) this.path.pop();
  }
}

// ---------------------------------------------------------------------------
// RationalizeMovementComponent
// ---------------------------------------------------------------------------

/**
 * Python RationalizeMovementComponent: slides a unit from its roam position
 * back onto its tile (or the nearest open tile when another unit holds it)
 * at 6 tiles per second, then clears the roam position.
 */
export class RationalizeMovementComponent {
  unit: UnitObject;
  goal: [number, number];
  done: boolean = false;
  private readonly speed = 6;
  private readonly epsilon = 0.01;
  private velocityX = 0;
  private velocityY = 0;
  private env: RoamEnv;

  constructor(
    unit: UnitObject,
    env: RoamEnv,
    nearestOpenTile: (unit: UnitObject, pos: [number, number]) => [number, number] | null,
  ) {
    this.unit = unit;
    this.env = env;
    const here = unit.position!;
    // Python: keep the tile if this unit is its only occupant.
    let alone = true;
    for (const other of unitsOf(env)) {
      if (other !== unit && other.position && !other.isDead?.() &&
          other.position[0] === here[0] && other.position[1] === here[1]) {
        alone = false;
        break;
      }
    }
    this.goal = alone ? [here[0], here[1]] : (nearestOpenTile(unit, here) ?? nearestOpenTile(unit, [0, 0]) ?? [0, 0]);
    const pos = getRoamPosition(unit) ?? { x: here[0], y: here[1] };
    const vx = this.goal[0] - pos.x;
    const vy = this.goal[1] - pos.y;
    const mag = Math.hypot(vx, vy);
    this.velocityX = this.speed * (mag ? vx / mag : vx);
    this.velocityY = this.speed * (mag ? vy / mag : vy);
    setSpriteMoving(unit, true, this.velocityX, this.velocityY);
    // Python QuickLeave(keep_position=True): off the grid, position kept.
    quickLeave(env, unit);
    unit.position = [here[0], here[1]];
  }

  /** Advance one frame; returns true once settled. */
  update(dt: number): boolean {
    if (this.done) return true;
    dt = Math.min(dt, 4 / 60);
    const pos = getRoamPosition(this.unit) ?? { x: this.goal[0], y: this.goal[1] };
    const [gx, gy] = this.goal;
    let nx = pos.x + this.velocityX * dt;
    let ny = pos.y + this.velocityY * dt;
    if (this.velocityX > 0 && nx > gx) nx = gx;
    else if (this.velocityX < 0 && nx < gx) nx = gx;
    if (this.velocityY > 0 && ny > gy) ny = gy;
    else if (this.velocityY < 0 && ny < gy) ny = gy;
    setRoamPosition(this.unit, { x: nx, y: ny });
    if (Math.abs(nx - gx) < this.epsilon && Math.abs(ny - gy) < this.epsilon) this.finish();
    return this.done;
  }

  finish(): void {
    if (this.done) return;
    this.done = true;
    setSpriteMoving(this.unit, false);
    setRoamPosition(this.unit, null);
    this.unit.position = null;
    quickArrive(this.env, this.unit, this.goal);
  }

  getVisualOffset(): [number, number] | null {
    return roamVisualOffset(this.unit);
  }
}
