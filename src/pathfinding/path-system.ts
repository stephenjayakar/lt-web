// ---------------------------------------------------------------------------
// PathSystem — High-level interface for movement and pathfinding.
// Bridges the raw Dijkstra/AStar algorithms with the game's unit and board
// objects, handling movement costs, unit collision, and attack ranges.
// ---------------------------------------------------------------------------

import type { GameBoard } from '../objects/game-board';
import type { UnitObject } from '../objects/unit';
import type { Database } from '../data/database';
import { Dijkstra, AStar } from './pathfinding';
import {
  modifiedMaximumRange,
  modifiedMinimumRange,
  movementType,
  passThrough,
  witchWarpPositions,
} from '../combat/skill-system';

/**
 * High-level pathfinding interface.
 *
 * All methods build throwaway Dijkstra / A* instances from the current board
 * state so that terrain costs and unit positions are always up-to-date.
 */
export class PathSystem {
  private db: Database;
  private game: any;

  constructor(db: Database, game?: any) {
    this.db = db;
    this.game = game;
  }

  // ------------------------------------------------------------------
  // Public API
  // ------------------------------------------------------------------

  /**
   * Get all valid positions a unit can move to this turn.
   * Includes the unit's current position (staying in place is valid).
   */
  getValidMoves(unit: UnitObject, board: GameBoard): [number, number][] {
    const pos = unit.position;
    if (!pos) return [];

    // Python: `game_state`/`ai_controller` build movement range from
    // `unit.movement_left` (engine/objects/unit.py), not the raw MOV stat --
    // this is what makes a Canto re-move use only the MOV left over from the
    // unit's first move this turn (movement_components.py Canto.canto_movement).
    // `unit.movementLeft` mirrors that: it equals full MOV until the unit
    // moves, then holds the post-move remainder until the turn resets.
    const movement = unit.movementLeft;
    const movementGroup = this.getMovementGroup(unit);

    const dijkstra = this.buildDijkstra(movementGroup, board);
    const canMoveThrough = this.buildCanMoveThrough(unit, board);

    const results = dijkstra.process(pos[0], pos[1], movement, canMoveThrough);

    // Filter out tiles occupied by other units. A unit can move *through*
    // allied tiles but cannot stop on any occupied tile except its own.
    const validMoves: [number, number][] = [];
    for (const [x, y] of results) {
      // Python applies game_board.bounds to the mcost grid; tiles outside the
      // configured movement bounds are unreachable (set_game_board_bounds).
      if (!board.checkBounds(x, y)) continue;
      const occupant = board.getUnit(x, y);
      if (!occupant || occupant === unit) {
        validMoves.push([x, y]);
      }
    }
    for (const position of witchWarpPositions(unit, board, this.db, this.game)) {
      if (!validMoves.some(([x, y]) => x === position[0] && y === position[1])) {
        validMoves.push(position);
      }
    }

    return validMoves;
  }

  /**
   * Get all positions that can be attacked from the given set of valid moves.
   * This is the union of attack ranges from every valid move position,
   * excluding tiles that are already in validMoves (you attack *from* a
   * move position, not *at* one).
   */
  getAttackPositions(
    unit: UnitObject,
    board: GameBoard,
    validMoves: [number, number][],
  ): [number, number][] {
    const [minRange, maxRange] = this.getAttackRange(unit);
    if (maxRange <= 0) return [];

    const { width, height } = board;
    const moveSet = new Set<string>(validMoves.map(([x, y]) => `${x},${y}`));
    const attackSet = new Set<string>();

    for (const [mx, my] of validMoves) {
      // For each move position, add all tiles within attack range
      for (let dx = -maxRange; dx <= maxRange; dx++) {
        for (let dy = -maxRange; dy <= maxRange; dy++) {
          const dist = Math.abs(dx) + Math.abs(dy);
          if (dist < minRange || dist > maxRange) continue;

          const ax = mx + dx;
          const ay = my + dy;
          if (ax < 0 || ax >= width || ay < 0 || ay >= height) continue;

          const key = `${ax},${ay}`;
          if (!moveSet.has(key)) {
            attackSet.add(key);
          }
        }
      }
    }

    return Array.from(attackSet).map((key) => {
      const [x, y] = key.split(',').map(Number);
      return [x, y] as [number, number];
    });
  }

  /**
   * Find the shortest path from a unit's current position to a target tile.
   * Uses A* with the board's terrain costs.
   */
  getPath(
    unit: UnitObject,
    goalX: number,
    goalY: number,
    board: GameBoard,
    options?: {
      canMoveThrough?: (x: number, y: number) => boolean;
      adjGoodEnough?: boolean;
      limit?: number;
      maxMovementLimit?: number;
    },
  ): [number, number][] | null {
    const pos = unit.position;
    if (!pos) return null;

    const { width, height } = board;
    const movementGroup = this.getMovementGroup(unit);
    const astar = new AStar(width, height);

    // Populate terrain costs
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        astar.setCost(x, y, board.getMovementCost(x, y, movementGroup, this.db));
      }
    }

    const canMoveThrough = options?.canMoveThrough ?? this.buildCanMoveThrough(unit, board);

    const path = astar.process(
      pos[0],
      pos[1],
      goalX,
      goalY,
      canMoveThrough,
      options?.adjGoodEnough ?? false,
      options?.limit ?? 0,
      options?.maxMovementLimit ?? 999,
    );
    const isWarp = witchWarpPositions(unit, board, this.db, this.game)
      .some(([x, y]) => x === goalX && y === goalY);
    if (isWarp && (!path || this.getPathCost(unit, path, board) > unit.movementLeft)) {
      return [[goalX, goalY]];
    }
    return path;
  }

  /**
   * AI helper: given a full path (possibly longer than the unit's movement
   * range), find the furthest tile the unit can actually reach this turn.
   * Returns the position the unit should move to.
   */
  travelAlgorithm(
    path: [number, number][],
    unit: UnitObject,
    board: GameBoard,
  ): [number, number] {
    const pos = unit.position;
    if (!pos || path.length === 0) return path[0] ?? [0, 0];

    const movement = unit.movementLeft;
    const movementGroup = this.getMovementGroup(unit);
    let spent = 0;
    let bestIndex = 0; // default: stay at start of path

    for (let i = 1; i < path.length; i++) {
      const [px, py] = path[i];
      const tileCost = board.getMovementCost(px, py, movementGroup, this.db);

      spent += tileCost;
      if (spent > movement) break;

      // Must not end on a tile occupied by another unit
      const occupant = board.getUnit(px, py);
      if (occupant && occupant !== unit) {
        // Can pass through allies but can't stop here
        if (this.db.areAllied(unit.team, occupant.team)) {
          continue; // keep walking but don't record as valid stop
        } else {
          break; // enemy blocks further movement
        }
      }

      bestIndex = i;
    }

    return path[bestIndex];
  }

  /**
   * Sum of terrain movement costs for a path, excluding the starting tile.
   * Used to update `unit.movementLeft` after a move completes, mirroring
   * Python's per-tile `unit.consume_movement(mcost)` in
   * unit_path_movement_component.py.
   */
  getPathCost(unit: UnitObject, path: [number, number][], board: GameBoard): number {
    const movementGroup = this.getMovementGroup(unit);
    let cost = 0;
    for (let i = 1; i < path.length; i++) {
      const [x, y] = path[i];
      cost += board.getMovementCost(x, y, movementGroup, this.db);
    }
    return cost;
  }

  // ------------------------------------------------------------------
  // Internal helpers
  // ------------------------------------------------------------------

  /**
   * Resolve the movement group for a unit from its class definition.
   */
  private getMovementGroup(unit: UnitObject): string {
    const klassDef = this.db.classes.get(unit.klass);
    return movementType(unit, klassDef?.movement_group ?? 'Infantry');
  }

  /**
   * Build a Dijkstra instance with terrain costs populated from the board.
   */
  private buildDijkstra(movementGroup: string, board: GameBoard): Dijkstra {
    const { width, height } = board;
    const dijkstra = new Dijkstra(width, height);

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        dijkstra.setCost(x, y, board.getMovementCost(x, y, movementGroup, this.db));
      }
    }

    return dijkstra;
  }

  /**
   * Build the canMoveThrough callback for a given unit.
   * A unit can move through tiles occupied by allies but not enemies.
   */
  private buildCanMoveThrough(
    unit: UnitObject,
    board: GameBoard,
  ): (x: number, y: number) => boolean {
    // Python: `skill_system.pass_through(self.unit)` makes can_move_through
    // always true, ignoring occupants entirely (game_state.py / ai_controller.py).
    if (passThrough(unit)) {
      return () => true;
    }
    return (x: number, y: number): boolean => {
      const occupant = board.getUnit(x, y);
      if (!occupant) return true;
      if (occupant === unit) return true;
      // Can pass through allied units
      return this.db.areAllied(unit.team, occupant.team);
    };
  }

  /**
   * Get the [minRange, maxRange] for a unit's equipped weapon.
   * Falls back to [0, 0] if the unit has no usable weapon.
   */
  private getAttackRange(unit: UnitObject): [number, number] {
    for (const item of unit.items) {
      if (item.isWeapon()) {
        return [
          modifiedMinimumRange(unit, item, this.game),
          modifiedMaximumRange(unit, item, this.game),
        ];
      }
    }
    return [0, 0];
  }
}
