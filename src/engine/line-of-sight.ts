/**
 * line-of-sight.ts — Bresenham line-of-sight algorithm for Fog of War.
 *
 * Port of LT's bresenham_line_algorithm.py and line_of_sight.py.
 * Uses the Bresenham line algorithm to determine if there is a clear
 * line of sight between two positions on the grid.
 */

/**
 * Determine if there is a clear line of sight from `start` to `end`.
 *
 * Uses the Bresenham line algorithm, checking each tile along the line
 * for opacity. If any opaque tile is encountered (other than the end
 * position), the line of sight is blocked.
 *
 * @param start      Starting position [x, y]
 * @param end        Ending position [x, y]
 * @param getOpacity Function returning true if a tile at [x, y] is opaque
 * @returns          True if there is a clear line of sight
 */
export function getLine(
  start: [number, number],
  end: [number, number],
  getOpacity: (pos: [number, number]) => boolean,
): boolean {
  if (start[0] === end[0] && start[1] === end[1]) {
    return true;
  }

  const x1 = start[0];
  const y1 = start[1];
  const x2 = end[0];
  const y2 = end[1];
  let dx = x2 - x1;
  let dy = y2 - y1;
  let x = x1;
  let y = y1;

  let xstep = 1;
  let ystep = 1;
  if (dy < 0) {
    ystep = -1;
    dy = -dy;
  }
  if (dx < 0) {
    xstep = -1;
    dx = -dx;
  }
  const ddy = 2 * dy;
  const ddx = 2 * dx;

  if (ddx >= ddy) {
    let errorprev = dx;
    let error = dx;
    for (let i = 0; i < dx; i++) {
      x += xstep;
      error += ddy;
      if (error > ddx) {
        y += ystep;
        error -= ddx;
        if (error + errorprev < ddx) {
          // Bottom square
          const pos: [number, number] = [x, y - ystep];
          if ((pos[0] !== end[0] || pos[1] !== end[1]) && getOpacity(pos)) {
            return false;
          }
        } else if (error + errorprev > ddx) {
          // Left square
          const pos: [number, number] = [x - xstep, y];
          if ((pos[0] !== end[0] || pos[1] !== end[1]) && getOpacity(pos)) {
            return false;
          }
        } else {
          // Through the middle — both adjacent tiles must be clear
          const pos1: [number, number] = [x, y - ystep];
          const pos2: [number, number] = [x - xstep, y];
          if (getOpacity(pos1) && getOpacity(pos2)) {
            return false;
          }
        }
      }
      const pos: [number, number] = [x, y];
      if ((pos[0] !== end[0] || pos[1] !== end[1]) && getOpacity(pos)) {
        return false;
      }
      errorprev = error;
    }
  } else {
    let errorprev = dy;
    let error = dy;
    for (let i = 0; i < dy; i++) {
      y += ystep;
      error += ddx;
      if (error > ddy) {
        x += xstep;
        error -= ddy;
        if (error + errorprev < ddy) {
          // Bottom square
          const pos: [number, number] = [x - xstep, y];
          if ((pos[0] !== end[0] || pos[1] !== end[1]) && getOpacity(pos)) {
            return false;
          }
        } else if (error + errorprev > ddy) {
          // Left square
          const pos: [number, number] = [x, y - ystep];
          if ((pos[0] !== end[0] || pos[1] !== end[1]) && getOpacity(pos)) {
            return false;
          }
        } else {
          // Through the middle
          const pos1: [number, number] = [x, y - ystep];
          const pos2: [number, number] = [x - xstep, y];
          if (getOpacity(pos1) && getOpacity(pos2)) {
            return false;
          }
        }
      }
      const pos: [number, number] = [x, y];
      if ((pos[0] !== end[0] || pos[1] !== end[1]) && getOpacity(pos)) {
        return false;
      }
      errorprev = error;
    }
  }

  return true;
}

/**
 * Calculate Manhattan distance between two positions.
 */
export function manhattanDistance(a: [number, number], b: [number, number]): number {
  return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]);
}

/**
 * Simple line-of-sight check for a team.
 *
 * Returns true if any unit on the given team can see the destination
 * position using Bresenham LOS within (defaultRange + sightBonus) tiles.
 *
 * Port of LT's line_of_sight.simple_check().
 *
 * @param destPos       Position to check visibility of
 * @param team          Team NID to check from
 * @param defaultRange  Base fog of war radius
 * @param fowVantagePoint Map of unit NID -> vantage point position
 * @param unitInfos     Array of {nid, team, sightBonus} for all game units
 * @param getOpacity    Function returning true if tile blocks LOS
 */
export function simpleCheck(
  destPos: [number, number],
  team: string,
  defaultRange: number,
  fowVantagePoint: Map<string, [number, number] | null>,
  unitInfos: { nid: string; team: string; sightBonus: number }[],
  getOpacity: (pos: [number, number]) => boolean,
): boolean {
  for (const info of unitInfos) {
    if (info.team !== team) continue;
    const sPos = fowVantagePoint.get(info.nid);
    if (!sPos) continue;

    if (sPos[0] === destPos[0] && sPos[1] === destPos[1]) {
      return true;
    }

    const range = defaultRange + info.sightBonus;
    if (manhattanDistance(destPos, sPos) <= range && getLine(sPos, destPos, getOpacity)) {
      return true;
    }
  }
  return false;
}
