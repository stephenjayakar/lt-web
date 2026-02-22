import type { UnitObject } from './unit';
import type { NID, FogOfWarConfig } from '../data/types';
import type { Database } from '../data/database';
import { simpleCheck } from '../engine/line-of-sight';
import { sightRange } from '../combat/skill-system';

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

  // ------------------------------------------------------------------
  // Fog of war
  // ------------------------------------------------------------------

  /** Fog of war grids: team NID -> 2D grid of Sets of unit NIDs that can see each tile. [y][x] */
  fogOfWarGrids: Map<string, Set<string>[][]>;
  /** Vantage points: unit NID -> position where the unit is looking from (or null). */
  fowVantagePoint: Map<string, [number, number] | null>;
  /** Previously visited tiles (for Hybrid mode). "x,y" string keys. */
  previouslyVisitedTiles: Set<string>;
  /** Fog regions: [y][x] -> set of fog region NIDs. */
  fogRegions: Set<string>[][];
  /** All active fog region NIDs so we can tell how many fog regions exist. */
  fogRegionSet: Set<string>;
  /** Vision regions: [y][x] -> set of vision region NIDs. */
  visionRegions: Set<string>[][];
  /** Opacity grid for LOS: [y][x] -> true if opaque. */
  opacityGrid: boolean[][];

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

    // Initialize fog of war data structures
    this.fogOfWarGrids = new Map();
    this.fowVantagePoint = new Map();
    this.previouslyVisitedTiles = new Set();
    this.fogRegions = this.createSetGrid();
    this.fogRegionSet = new Set();
    this.visionRegions = this.createSetGrid();
    this.opacityGrid = this.createBoolGrid();
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
   * getTerrain returns '0' for unmapped tiles (never null), matching Python.
   */
  initFromTilemap(tilemap: { width: number; height: number; getTerrain(x: number, y: number): NID }): void {
    for (let y = 0; y < Math.min(this.height, tilemap.height); y++) {
      for (let x = 0; x < Math.min(this.width, tilemap.width); x++) {
        const terrain = tilemap.getTerrain(x, y);
        this.terrainGrid[y][x] = terrain;
      }
    }
  }

  // ------------------------------------------------------------------
  // Grid helpers
  // ------------------------------------------------------------------

  /** Create a width x height grid of empty Sets. */
  private createSetGrid(): Set<string>[][] {
    const grid: Set<string>[][] = [];
    for (let y = 0; y < this.height; y++) {
      const row: Set<string>[] = [];
      for (let x = 0; x < this.width; x++) {
        row.push(new Set());
      }
      grid.push(row);
    }
    return grid;
  }

  /** Create a width x height grid of booleans (default false). */
  private createBoolGrid(): boolean[][] {
    const grid: boolean[][] = [];
    for (let y = 0; y < this.height; y++) {
      grid.push(new Array<boolean>(this.width).fill(false));
    }
    return grid;
  }

  // ------------------------------------------------------------------
  // Fog of War
  // ------------------------------------------------------------------

  /**
   * Initialize fog of war grids for each team.
   * Called during level load after the board is created.
   */
  initFogGrids(teams: string[]): void {
    this.fogOfWarGrids.clear();
    for (const team of teams) {
      this.fogOfWarGrids.set(team, this.createSetGrid());
    }
    this.fowVantagePoint.clear();
    this.previouslyVisitedTiles.clear();
    this.fogRegions = this.createSetGrid();
    this.fogRegionSet.clear();
    this.visionRegions = this.createSetGrid();
  }

  /**
   * Initialize the opacity grid from terrain data.
   * Reads each tile's terrain definition to determine if it is opaque.
   */
  initOpacityGrid(db: Database): void {
    this.opacityGrid = this.createBoolGrid();
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        const terrainNid = this.terrainGrid[y][x];
        if (terrainNid) {
          const terrainDef = db.terrain.get(terrainNid);
          if (terrainDef) {
            this.opacityGrid[y][x] = terrainDef.opaque ?? false;
          }
        }
      }
    }
  }

  /**
   * Get whether a tile is opaque (blocks line of sight).
   */
  getOpacity(pos: [number, number]): boolean {
    if (!pos) return false;
    const [x, y] = pos;
    if (!this.inBounds(x, y)) return false;
    return this.opacityGrid[y][x];
  }

  /**
   * Compute all positions within Manhattan distance of a center point.
   * Returns positions that are also within map bounds.
   */
  private getManhattanSphere(cx: number, cy: number, radius: number): [number, number][] {
    const positions: [number, number][] = [];
    for (let r = 0; r <= radius; r++) {
      for (let i = -r; i <= r; i++) {
        const dx = i;
        const dy1 = r - Math.abs(i);
        const dy2 = -(r - Math.abs(i));
        const x1 = cx + dx;
        const y1a = cy + dy1;
        const y1b = cy + dy2;
        if (this.inBounds(x1, y1a)) {
          positions.push([x1, y1a]);
        }
        if (dy1 !== 0 && dy2 !== 0 && this.inBounds(x1, y1b)) {
          positions.push([x1, y1b]);
        }
      }
    }
    // Deduplicate (the center is added multiple times from r=0 and r>0)
    const seen = new Set<string>();
    const result: [number, number][] = [];
    for (const p of positions) {
      const key = `${p[0]},${p[1]}`;
      if (!seen.has(key)) {
        seen.add(key);
        result.push(p);
      }
    }
    return result;
  }

  /**
   * Update a unit's fog of war vision.
   *
   * Removes the unit's old vision contribution, then adds new vision
   * at the given position with the specified sight range.
   *
   * @param unit       The unit whose vision to update
   * @param pos        Position the unit is seeing from (null to remove vision)
   * @param sightRadius The total sight radius for this unit
   */
  updateFow(unit: UnitObject, pos: [number, number] | null, sightRadius: number): void {
    const grid = this.fogOfWarGrids.get(unit.team);
    if (!grid) return;

    // Remove old vision
    this.fowVantagePoint.set(unit.nid, null);
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        grid[y][x].delete(unit.nid);
      }
    }

    // Add new vision
    if (pos) {
      this.fowVantagePoint.set(unit.nid, pos);
      const positions = this.getManhattanSphere(pos[0], pos[1], sightRadius);
      for (const p of positions) {
        grid[p[1]][p[0]].add(unit.nid);
      }
      // Update previously visited tiles for Hybrid mode
      this._updatePreviouslyVisited(positions, unit.team);
    }
  }

  /**
   * Remove a unit's vision contribution entirely.
   */
  clearUnitFow(unit: UnitObject): void {
    const grid = this.fogOfWarGrids.get(unit.team);
    if (!grid) return;

    this.fowVantagePoint.set(unit.nid, null);
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        grid[y][x].delete(unit.nid);
      }
    }
  }

  /**
   * Update the previously visited tiles set (for Hybrid fog mode).
   * Only tracks tiles visited by the player team.
   *
   * @param positions Positions that the unit can currently see
   * @param team      The team of the unit
   */
  private _updatePreviouslyVisited(positions: [number, number][], team: string): void {
    if (team !== 'player') return;
    for (const pos of positions) {
      this.previouslyVisitedTiles.add(`${pos[0]},${pos[1]}`);
    }
  }

  /**
   * Check if a position is in vision for a given team.
   *
   * Logic:
   * 1. If position is in a vision region -> always visible
   * 2. If fog is NOT active AND no fog regions cover this tile -> always visible
   * 3. If fog IS active or fog regions cover this tile:
   *    - For player team: check all allied fog grids
   *    - For other teams: check only that team's grid
   *    - If fog_los constant is true, also verify Bresenham LOS
   *
   * @param pos      Position to check [x, y]
   * @param team     Team to check vision for (default 'player')
   * @param fogInfo  Current fog of war configuration
   * @param db       Database (for alliance checks and fog_los constant)
   * @param allUnits All units in the game (for LOS calculation)
   */
  inVision(
    pos: [number, number],
    team: string = 'player',
    fogInfo?: FogOfWarConfig,
    db?: Database,
    allUnits?: UnitObject[],
  ): boolean {
    const [x, y] = pos;
    if (!this.inBounds(x, y)) return false;

    // Vision regions always grant visibility
    if (this.visionRegions[y][x].size > 0) {
      return true;
    }

    // Check if fog is active or if there are fog regions on this tile
    const fogActive = fogInfo?.isActive ?? false;
    const hasFogRegion = this.fogRegions[y][x].size > 0;

    if (!fogActive && !hasFogRegion) {
      return true;
    }

    // Fog is active — check the fog of war grids
    const useFogLos = db ? (db.getConstant('fog_los', false) as boolean) : false;

    if (team === 'player') {
      // Check LOS first if enabled
      if (useFogLos && fogInfo && db && allUnits) {
        const fogRadius = fogInfo.defaultRadius;
        const unitInfos = allUnits
          .filter(u => u.position)
          .map(u => ({ nid: u.nid, team: u.team, sightBonus: sightRange(u) }));

        // Check all allied teams
        const alliedTeams = this._getAlliedTeams(team, db);
        let losValid = false;
        for (const allyTeam of alliedTeams) {
          if (simpleCheck(
            pos, allyTeam, fogRadius, this.fowVantagePoint,
            unitInfos, (p) => this.getOpacity(p),
          )) {
            losValid = true;
            break;
          }
        }
        if (!losValid) return false;
      }

      // Check all allied fog grids for unit contributions
      const alliedTeams = db ? this._getAlliedTeams(team, db) : [team];
      for (const allyTeam of alliedTeams) {
        const teamGrid = this.fogOfWarGrids.get(allyTeam);
        if (teamGrid && teamGrid[y][x].size > 0) {
          return true;
        }
      }
    } else {
      // Non-player team: check LOS if enabled
      if (useFogLos && fogInfo && allUnits) {
        const fogRadius = this._getFogRadiusForTeam(team, fogInfo, db);
        const unitInfos = allUnits
          .filter(u => u.position)
          .map(u => ({ nid: u.nid, team: u.team, sightBonus: sightRange(u) }));
        if (!simpleCheck(
          pos, team, fogRadius, this.fowVantagePoint,
          unitInfos, (p) => this.getOpacity(p),
        )) {
          return false;
        }
      }

      // Check this team's fog grid
      const grid = this.fogOfWarGrids.get(team);
      if (grid && grid[y][x].size > 0) {
        return true;
      }
    }

    return false;
  }

  /**
   * Check if terrain is known at a position (mode-dependent).
   *
   * - GBA mode (0, 1): always returns true (terrain always visible)
   * - THRACIA mode (2): returns true only if inVision(pos) is true
   * - HYBRID mode (3): returns true if inVision(pos) OR pos was previously visited
   */
  terrainKnown(
    pos: [number, number],
    isInVision: boolean,
    fogInfo?: FogOfWarConfig,
  ): boolean {
    const mode = fogInfo?.mode ?? 1;
    if (mode === 3) {
      // HYBRID: visible or previously visited
      return isInVision || this.previouslyVisitedTiles.has(`${pos[0]},${pos[1]}`);
    } else if (mode === 2) {
      // THRACIA: only if currently in vision
      return isInVision;
    } else {
      // GBA / GBA_DEPRECATED: terrain always known
      return true;
    }
  }

  /**
   * Get the fog of war vision radius for a specific team.
   */
  private _getFogRadiusForTeam(team: string, fogInfo: FogOfWarConfig, db?: Database): number {
    if (team === 'player') {
      return fogInfo.defaultRadius;
    }
    // Check if this team is allied with the player
    if (db && db.areAllied('player', team) && team !== 'player') {
      return fogInfo.otherRadius;
    }
    return fogInfo.aiRadius;
  }

  /**
   * Get all teams allied with the given team (including the team itself).
   */
  private _getAlliedTeams(team: string, db: Database): string[] {
    const allied: string[] = [team];
    for (const [a, b] of db.teams.alliances) {
      if (a === team && !allied.includes(b)) allied.push(b);
      if (b === team && !allied.includes(a)) allied.push(a);
    }
    return allied;
  }

  /**
   * Get the total sight range for a unit (base radius + skill bonuses).
   */
  getFogOfWarRadius(unit: UnitObject, fogInfo: FogOfWarConfig, db?: Database): number {
    const baseRadius = this._getFogRadiusForTeam(unit.team, fogInfo, db);
    return baseRadius + sightRange(unit);
  }

  // ------------------------------------------------------------------
  // Fog / Vision Regions
  // ------------------------------------------------------------------

  /**
   * Add a fog region (reduces visibility). Fog regions block vision at
   * specified positions.
   */
  addFogRegion(regionNid: string, positions: [number, number][]): void {
    this.fogRegionSet.add(regionNid);
    for (const pos of positions) {
      if (this.inBounds(pos[0], pos[1])) {
        this.fogRegions[pos[1]][pos[0]].add(regionNid);
      }
    }
  }

  /**
   * Remove a fog region.
   */
  removeFogRegion(regionNid: string): void {
    this.fogRegionSet.delete(regionNid);
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        this.fogRegions[y][x].delete(regionNid);
      }
    }
  }

  /**
   * Add a vision region (grants visibility). Vision regions override fog.
   */
  addVisionRegion(regionNid: string, positions: [number, number][]): void {
    for (const pos of positions) {
      if (this.inBounds(pos[0], pos[1])) {
        this.visionRegions[pos[1]][pos[0]].add(regionNid);
        // Vision regions also mark tiles as previously visited
        this.previouslyVisitedTiles.add(`${pos[0]},${pos[1]}`);
      }
    }
  }

  /**
   * Remove a vision region.
   */
  removeVisionRegion(regionNid: string): void {
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        this.visionRegions[y][x].delete(regionNid);
      }
    }
  }
}
