import type { UnitObject } from './unit';
import type { NID } from '../data/types';
import type { Database } from '../data/database';

/**
 * GameBoard - Grid-based game board tracking unit positions, movement costs, and visibility.
 * Equivalent to LT's GameBoard from app/engine/game_board.py
 *
 * Coordinates use [x, y] with (0,0) at top-left. The internal 2D arrays are
 * indexed as [y][x] to match row-major screen layout.
 */
export class GameBoard {
  width: number;
  height: number;

  // Unit tracking
  private unitGrid: (UnitObject | null)[][]; // [y][x] -> unit at position
  private teamGrid: (string | null)[][]; // [y][x] -> team at position

  // Terrain/movement data
  private terrainGrid: (NID | null)[][]; // [y][x] -> terrain NID

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;

    this.unitGrid = [];
    this.teamGrid = [];
    this.terrainGrid = [];

    for (let y = 0; y < height; y++) {
      this.unitGrid.push(new Array<UnitObject | null>(width).fill(null));
      this.teamGrid.push(new Array<string | null>(width).fill(null));
      this.terrainGrid.push(new Array<NID | null>(width).fill(null));
    }
  }

  // ------------------------------------------------------------------
  // Terrain
  // ------------------------------------------------------------------

  /** Set terrain at a position (called during level load from tilemap). */
  setTerrain(x: number, y: number, terrainNid: NID): void {
    if (!this.inBounds(x, y)) return;
    this.terrainGrid[y][x] = terrainNid;
  }

  /** Get terrain NID at position. */
  getTerrain(x: number, y: number): NID | null {
    if (!this.inBounds(x, y)) return null;
    return this.terrainGrid[y][x];
  }

  // ------------------------------------------------------------------
  // Unit placement
  // ------------------------------------------------------------------

  /** Place a unit on the board. */
  setUnit(x: number, y: number, unit: UnitObject): void {
    if (!this.inBounds(x, y)) return;
    this.unitGrid[y][x] = unit;
    this.teamGrid[y][x] = unit.team;
    unit.position = [x, y];
  }

  /** Remove a unit from the board. */
  removeUnit(unit: UnitObject): void {
    if (!unit.position) return;
    const [x, y] = unit.position;
    if (this.inBounds(x, y)) {
      this.unitGrid[y][x] = null;
      this.teamGrid[y][x] = null;
    }
    unit.position = null;
  }

  /** Get unit at position. */
  getUnit(x: number, y: number): UnitObject | null {
    if (!this.inBounds(x, y)) return null;
    return this.unitGrid[y][x];
  }

  /** Move a unit from its current position to a new position. */
  moveUnit(unit: UnitObject, newX: number, newY: number): void {
    if (!this.inBounds(newX, newY)) return;

    // Clear old position
    if (unit.position) {
      const [oldX, oldY] = unit.position;
      if (this.inBounds(oldX, oldY)) {
        this.unitGrid[oldY][oldX] = null;
        this.teamGrid[oldY][oldX] = null;
      }
    }

    // Set new position
    this.unitGrid[newY][newX] = unit;
    this.teamGrid[newY][newX] = unit.team;
    unit.position = [newX, newY];
  }

  // ------------------------------------------------------------------
  // Queries
  // ------------------------------------------------------------------

  /** Check if position is within bounds. */
  inBounds(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.width && y < this.height;
  }

  /**
   * Get movement cost at position for a given movement group.
   *
   * Looks up the terrain NID at (x, y), resolves its movement type (`mtype`)
   * from the database's terrain definitions, then queries the mcost table for
   * the cost of that terrain type for the given movement group.
   *
   * Returns 99 (impassable) when the position is out of bounds, has no
   * terrain, or the terrain/movement-group combination is not in the table.
   */
  getMovementCost(x: number, y: number, movementGroup: string, db: Database): number {
    if (!this.inBounds(x, y)) return 99;

    const terrainNid = this.terrainGrid[y][x];
    if (!terrainNid) return 99;

    // Resolve the terrain's movement type through the database
    const terrainDef = db.terrain.get(terrainNid);
    if (!terrainDef) return 99;

    return db.getMovementCost(terrainDef.mtype, movementGroup);
  }

  /**
   * Check if a team can move through a position.
   *
   * A team can pass through a tile if it is unoccupied, or if the tile
   * is occupied by an allied unit (same team or allied via the alliance table).
   */
  canMoveThrough(x: number, y: number, team: string, db: Database): boolean {
    if (!this.inBounds(x, y)) return false;

    const occupant = this.unitGrid[y][x];
    if (!occupant) return true;

    // Can pass through allies
    return db.areAllied(team, occupant.team);
  }

  /** Get all units of a specific team. */
  getTeamUnits(team: string): UnitObject[] {
    const units: UnitObject[] = [];
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        const unit = this.unitGrid[y][x];
        if (unit && unit.team === team) {
          units.push(unit);
        }
      }
    }
    return units;
  }

  /** Get all units on the board. */
  getAllUnits(): UnitObject[] {
    const units: UnitObject[] = [];
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        const unit = this.unitGrid[y][x];
        if (unit) {
          units.push(unit);
        }
      }
    }
    return units;
  }

  /** Check if position is occupied. */
  isOccupied(x: number, y: number): boolean {
    if (!this.inBounds(x, y)) return false;
    return this.unitGrid[y][x] !== null;
  }

  /**
   * Initialize terrain from a tilemap.
   *
   * Walks every tile in the tilemap and copies the terrain NID into this
   * board's terrain grid. The tilemap is expected to implement getTerrain(x, y)
   * which walks its layers top-to-bottom (e.g. TileMapObject).
   */
  initFromTilemap(tilemap: { width: number; height: number; getTerrain(x: number, y: number): NID | null }): void {
    for (let y = 0; y < Math.min(this.height, tilemap.height); y++) {
      for (let x = 0; x < Math.min(this.width, tilemap.width); x++) {
        const terrain = tilemap.getTerrain(x, y);
        if (terrain !== null) {
          this.terrainGrid[y][x] = terrain;
        }
      }
    }
  }
}
