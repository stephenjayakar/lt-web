// ---------------------------------------------------------------------------
// Pathfinding algorithms for the Lex Talionis web engine.
// Dijkstra: flood-fill to find all reachable tiles within a movement budget.
// AStar: shortest path between two specific positions.
// Both operate on a grid of PathNodes with cardinal-direction movement only.
// ---------------------------------------------------------------------------

export interface PathNode {
  x: number;
  y: number;
  cost: number;   // terrain movement cost at this position
  g: number;       // actual distance from start
  h: number;       // heuristic distance to goal (A* only)
  f: number;       // g + h
  parent: PathNode | null;
  reachable: boolean; // false if cost >= 99
}

// ---------------------------------------------------------------------------
// MinHeap — used as the open set for both algorithms.
// Compares by `f`, breaking ties by lower `h` (prefer nodes closer to goal).
// ---------------------------------------------------------------------------

class MinHeap {
  private data: PathNode[] = [];

  get size(): number {
    return this.data.length;
  }

  push(node: PathNode): void {
    this.data.push(node);
    this.bubbleUp(this.data.length - 1);
  }

  pop(): PathNode | undefined {
    const top = this.data[0];
    const last = this.data.pop();
    if (this.data.length > 0 && last !== undefined) {
      this.data[0] = last;
      this.sinkDown(0);
    }
    return top;
  }

  private bubbleUp(i: number): void {
    const data = this.data;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.less(i, parent)) {
        [data[i], data[parent]] = [data[parent], data[i]];
        i = parent;
      } else {
        break;
      }
    }
  }

  private sinkDown(i: number): void {
    const data = this.data;
    const n = data.length;
    while (true) {
      let smallest = i;
      const left = 2 * i + 1;
      const right = 2 * i + 2;
      if (left < n && this.less(left, smallest)) smallest = left;
      if (right < n && this.less(right, smallest)) smallest = right;
      if (smallest === i) break;
      [data[i], data[smallest]] = [data[smallest], data[i]];
      i = smallest;
    }
  }

  private less(a: number, b: number): boolean {
    const na = this.data[a];
    const nb = this.data[b];
    if (na.f !== nb.f) return na.f < nb.f;
    return na.h < nb.h; // tie-break: prefer lower heuristic
  }
}

// ---------------------------------------------------------------------------
// Cardinal direction offsets
// ---------------------------------------------------------------------------

const DIRS: [number, number][] = [
  [0, -1], // up
  [1, 0],  // right
  [0, 1],  // down
  [-1, 0], // left
];

// ---------------------------------------------------------------------------
// Helper: create a fresh grid of PathNodes
// ---------------------------------------------------------------------------

function createGrid(width: number, height: number): PathNode[][] {
  const grid: PathNode[][] = [];
  for (let y = 0; y < height; y++) {
    const row: PathNode[] = [];
    for (let x = 0; x < width; x++) {
      row.push({
        x,
        y,
        cost: 1,
        g: Infinity,
        h: 0,
        f: Infinity,
        parent: null,
        reachable: true,
      });
    }
    grid.push(row);
  }
  return grid;
}

// ---------------------------------------------------------------------------
// Dijkstra — flood-fill for movement range
// ---------------------------------------------------------------------------

/**
 * Finds all reachable tiles within a movement budget from a starting position.
 * Used for showing movement range and finding valid move positions.
 */
export class Dijkstra {
  private grid: PathNode[][];
  private width: number;
  private height: number;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.grid = createGrid(width, height);
  }

  /** Set the terrain movement cost at a position. */
  setCost(x: number, y: number, cost: number): void {
    if (x < 0 || x >= this.width || y < 0 || y >= this.height) return;
    const node = this.grid[y][x];
    node.cost = cost;
    node.reachable = cost < 99;
  }

  /**
   * Find all reachable positions from start within movementLeft.
   * @param startX        Starting X coordinate
   * @param startY        Starting Y coordinate
   * @param movementLeft  Total movement budget
   * @param canMoveThrough Callback: can the unit pass through tile (x, y)?
   *                       Typically returns false for tiles occupied by enemies.
   * @returns Array of [x, y, remainingMovement] for every reachable tile.
   */
  process(
    startX: number,
    startY: number,
    movementLeft: number,
    canMoveThrough: (x: number, y: number) => boolean,
  ): [number, number, number][] {
    // Reset all nodes
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        const node = this.grid[y][x];
        node.g = Infinity;
        node.f = Infinity;
        node.h = 0;
        node.parent = null;
      }
    }

    const startNode = this.grid[startY]?.[startX];
    if (!startNode) return [];

    startNode.g = 0;
    startNode.f = 0;

    const open = new MinHeap();
    open.push(startNode);

    const results: [number, number, number][] = [];

    while (open.size > 0) {
      const current = open.pop()!;
      const remaining = movementLeft - current.g;

      // If we've already found a cheaper path to this node, skip
      if (current.g > movementLeft) continue;

      results.push([current.x, current.y, remaining]);

      for (const [dx, dy] of DIRS) {
        const nx = current.x + dx;
        const ny = current.y + dy;

        if (nx < 0 || nx >= this.width || ny < 0 || ny >= this.height) continue;

        const neighbor = this.grid[ny][nx];
        if (!neighbor.reachable) continue;
        if (!canMoveThrough(nx, ny)) continue;

        const newG = current.g + neighbor.cost;
        if (newG > movementLeft) continue;

        if (newG < neighbor.g) {
          neighbor.g = newG;
          neighbor.f = newG; // no heuristic for Dijkstra
          neighbor.parent = current;
          open.push(neighbor);
        }
      }
    }

    return results;
  }

  /**
   * Get the path from the start (used in the last `process` call) to a
   * specific reachable position. Returns the path as an array of [x, y].
   * The path includes both the start and the destination.
   */
  getPath(x: number, y: number): [number, number][] {
    if (x < 0 || x >= this.width || y < 0 || y >= this.height) return [];

    const node = this.grid[y][x];
    if (node.g === Infinity) return []; // not reachable

    const path: [number, number][] = [];
    let current: PathNode | null = node;
    while (current !== null) {
      path.push([current.x, current.y]);
      current = current.parent;
    }
    path.reverse();
    return path;
  }
}

// ---------------------------------------------------------------------------
// AStar — shortest path between two specific positions
// ---------------------------------------------------------------------------

/**
 * Finds the shortest path between two positions using A*.
 * The heuristic is Manhattan distance with a small cross-product tie-breaking
 * nudge to prefer straighter paths.
 */
export class AStar {
  private grid: PathNode[][];
  private width: number;
  private height: number;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.grid = createGrid(width, height);
  }

  /** Set the terrain movement cost at a position. */
  setCost(x: number, y: number, cost: number): void {
    if (x < 0 || x >= this.width || y < 0 || y >= this.height) return;
    const node = this.grid[y][x];
    node.cost = cost;
    node.reachable = cost < 99;
  }

  /**
   * Manhattan distance with a small cross-product nudge for tie-breaking.
   * The nudge biases towards paths that lie along the direct line from
   * start to goal, producing more natural-looking movement.
   */
  private heuristic(
    x1: number, y1: number,
    x2: number, y2: number,
    startX: number, startY: number,
  ): number {
    const dx = Math.abs(x1 - x2);
    const dy = Math.abs(y1 - y2);
    const manhattan = dx + dy;

    // Cross-product tie-breaker: measures how far (x1,y1) deviates from
    // the straight line between start and goal.
    const dx1 = x1 - x2;
    const dy1 = y1 - y2;
    const dx2 = startX - x2;
    const dy2 = startY - y2;
    const cross = Math.abs(dx1 * dy2 - dx2 * dy1);

    return manhattan + cross * 0.001;
  }

  /**
   * Find the shortest path from start to goal.
   * @param startX         Starting X coordinate
   * @param startY         Starting Y coordinate
   * @param goalX          Goal X coordinate
   * @param goalY          Goal Y coordinate
   * @param canMoveThrough Callback: can the unit pass through tile (x, y)?
   * @param adjGoodEnough  If true, being adjacent to the goal counts as reaching it
   * @param limit          Maximum g-cost before giving up (0 = unlimited)
   * @returns Path as array of [x, y] from start to goal, or null if unreachable.
   */
  process(
    startX: number,
    startY: number,
    goalX: number,
    goalY: number,
    canMoveThrough: (x: number, y: number) => boolean,
    adjGoodEnough: boolean = false,
    limit: number = 0,
  ): [number, number][] | null {
    // Reset all nodes
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        const node = this.grid[y][x];
        node.g = Infinity;
        node.h = 0;
        node.f = Infinity;
        node.parent = null;
      }
    }

    const startNode = this.grid[startY]?.[startX];
    const goalNode = this.grid[goalY]?.[goalX];
    if (!startNode || !goalNode) return null;

    startNode.g = 0;
    startNode.h = this.heuristic(startX, startY, goalX, goalY, startX, startY);
    startNode.f = startNode.h;

    const open = new MinHeap();
    open.push(startNode);

    // Track which nodes have been finalized (closed set)
    const closed = new Set<PathNode>();

    while (open.size > 0) {
      const current = open.pop()!;

      // Skip if already processed with a better cost
      if (closed.has(current)) continue;
      closed.add(current);

      // Check for goal
      if (current.x === goalX && current.y === goalY) {
        return this.reconstructPath(current);
      }

      // Check adjacency goal condition
      if (adjGoodEnough) {
        const dx = Math.abs(current.x - goalX);
        const dy = Math.abs(current.y - goalY);
        if (dx + dy === 1) {
          return this.reconstructPath(current);
        }
      }

      // Check cost limit
      if (limit > 0 && current.g > limit) continue;

      for (const [dx, dy] of DIRS) {
        const nx = current.x + dx;
        const ny = current.y + dy;

        if (nx < 0 || nx >= this.width || ny < 0 || ny >= this.height) continue;

        const neighbor = this.grid[ny][nx];

        // The goal tile itself is always passable for the purpose of
        // reaching it (the unit may need to move *to* an occupied tile
        // to attack), but intermediate tiles must pass canMoveThrough.
        if (nx === goalX && ny === goalY) {
          // Allow moving to the goal even if occupied
          if (!neighbor.reachable) continue;
        } else {
          if (!neighbor.reachable) continue;
          if (!canMoveThrough(nx, ny)) continue;
        }

        if (closed.has(neighbor)) continue;

        const newG = current.g + neighbor.cost;
        if (limit > 0 && newG > limit) continue;

        if (newG < neighbor.g) {
          neighbor.g = newG;
          neighbor.h = this.heuristic(nx, ny, goalX, goalY, startX, startY);
          neighbor.f = neighbor.g + neighbor.h;
          neighbor.parent = current;
          open.push(neighbor);
        }
      }
    }

    return null; // no path found
  }

  /** Reconstruct the path from goal node back to start via parent links. */
  private reconstructPath(node: PathNode): [number, number][] {
    const path: [number, number][] = [];
    let current: PathNode | null = node;
    while (current !== null) {
      path.push([current.x, current.y]);
      current = current.parent;
    }
    path.reverse();
    return path;
  }
}
