/**
 * selection-helper.ts — Python app/engine/selection_helper.SelectionHelper.
 *
 * The map-cursor navigation every target-selection state uses: a direction
 * key jumps to the nearest valid position strictly in that direction
 * (Manhattan distance, ties to the earliest position), falling back to the
 * nearest position overall; AUX steps through the list in order.
 */

export type GridPos = [number, number];

// ---------------------------------------------------------------------------
// CPython 3.11 set iteration order for (x, y) tuples
// ---------------------------------------------------------------------------
// Python builds target positions as sets and SelectionHelper keeps
// list(set): the order decides which of two equally close targets the cursor
// starts on and the AUX cycle. EOtF runs on CPython 3.11, whose tuple hash
// (xxHash-based) and open-addressing set table are deterministic for ints,
// so the order is reproduced exactly here.

const MASK64 = (1n << 64n) - 1n;
const XXPRIME_1 = 11400714785074694791n;
const XXPRIME_2 = 14029467366897019727n;
const XXPRIME_5 = 2870177450012600261n;
const LINEAR_PROBES = 9;
const PERTURB_SHIFT = 5n;

/** CPython tuplehash of a tuple of small ints, as an unsigned 64-bit value. */
function tupleHash(items: number[]): bigint {
  let acc = XXPRIME_5;
  for (const item of items) {
    const lane = BigInt.asUintN(64, BigInt(item === -1 ? -2 : item));
    acc = (acc + lane * XXPRIME_2) & MASK64;
    acc = ((acc << 31n) | (acc >> 33n)) & MASK64;
    acc = (acc * XXPRIME_1) & MASK64;
  }
  acc = (acc + (BigInt(items.length) ^ (XXPRIME_5 ^ 3527539n))) & MASK64;
  return acc === MASK64 ? 1546275796n : acc;
}

interface SetSlot { pos: GridPos; hash: bigint }

function insertClean(table: (SetSlot | null)[], slot: SetSlot): void {
  const mask = BigInt(table.length - 1);
  let perturb = slot.hash;
  let i = slot.hash & mask;
  for (;;) {
    if (!table[Number(i)]) { table[Number(i)] = slot; return; }
    if (i + BigInt(LINEAR_PROBES) <= mask) {
      for (let j = 1; j <= LINEAR_PROBES; j++) {
        if (!table[Number(i) + j]) { table[Number(i) + j] = slot; return; }
      }
    }
    perturb >>= PERTURB_SHIFT;
    i = (i * 5n + 1n + perturb) & mask;
  }
}

/**
 * The order CPython 3.11 iterates a set of (x, y) tuples added in this order
 * (`set(list)`, a set comprehension or repeated `add`).
 */
export function pythonSetOrder(positions: Iterable<GridPos>): GridPos[] {
  let table: (SetSlot | null)[] = new Array(8).fill(null);
  let fill = 0;
  for (const pos of positions) {
    const hash = tupleHash(pos);
    const mask = BigInt(table.length - 1);
    let perturb = hash;
    let i = hash & mask;
    let placed = false;
    let duplicate = false;
    while (!placed && !duplicate) {
      const probes = i + BigInt(LINEAR_PROBES) <= mask ? LINEAR_PROBES : 0;
      for (let j = 0; j <= probes; j++) {
        const idx = Number(i) + j;
        const entry = table[idx];
        if (!entry) {
          table[idx] = { pos: [pos[0], pos[1]], hash };
          placed = true;
          break;
        }
        if (entry.hash === hash && entry.pos[0] === pos[0] && entry.pos[1] === pos[1]) {
          duplicate = true;
          break;
        }
      }
      if (!placed && !duplicate) {
        perturb >>= PERTURB_SHIFT;
        i = (i * 5n + 1n + perturb) & mask;
      }
    }
    if (duplicate) continue;
    fill += 1;
    if (fill * 5 >= (table.length - 1) * 3) {
      const used = table.filter(Boolean) as SetSlot[];
      const minUsed = used.length > 50000 ? used.length * 2 : used.length * 4;
      let size = 8;
      while (size <= minUsed) size <<= 1;
      const next: (SetSlot | null)[] = new Array(size).fill(null);
      for (const slot of used) insertClean(next, slot);
      table = next;
      fill = used.length;
    }
  }
  return (table.filter(Boolean) as SetSlot[]).map((slot) => slot.pos);
}

const distance = (a: GridPos, b: GridPos): number => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]);
const samePos = (a: GridPos, b: GridPos): boolean => a[0] === b[0] && a[1] === b[1];

export class SelectionHelper {
  posList: GridPos[];

  /** `positions` in the order Python adds them to its target set. */
  constructor(positions: Iterable<GridPos>) {
    this.posList = pythonSetOrder(positions);
  }

  count(): number {
    return this.posList.length;
  }

  has(pos: GridPos): boolean {
    return this.posList.some((other) => samePos(other, pos));
  }

  removeTarget(pos: GridPos): void {
    const idx = this.posList.findIndex((other) => samePos(other, pos));
    if (idx >= 0) this.posList.splice(idx, 1);
  }

  /** handle_mouse: the hovered tile when it is a valid position. */
  handleMouse(tile: GridPos | null): GridPos | null {
    return tile && this.has(tile) ? [tile[0], tile[1]] : null;
  }

  getClosest(position: GridPos): GridPos | null {
    let best: GridPos | null = null;
    let bestDist = Infinity;
    for (const pos of this.posList) {
      const dist = distance(pos, position);
      if (dist < bestDist) {
        best = pos;
        bestDist = dist;
      }
    }
    return best;
  }

  getNext(position: GridPos): GridPos | null {
    const idx = this.posList.findIndex((other) => samePos(other, position));
    if (idx >= 0) return this.posList[(idx + 1) % this.posList.length];
    return this.posList[0] ?? null;
  }

  private getDirectional(position: GridPos, ahead: (pos: GridPos) => boolean): GridPos | null {
    let minDistance = 100;
    let closest: GridPos | null = null;
    for (const pos of this.posList) {
      if (!ahead(pos)) continue;
      const dist = distance(pos, position);
      if (dist < minDistance) {
        closest = pos;
        minDistance = dist;
      }
    }
    return closest ?? this.getClosest(position);
  }

  getDown(position: GridPos): GridPos | null {
    return this.getDirectional(position, (pos) => pos[1] > position[1]);
  }

  getUp(position: GridPos): GridPos | null {
    return this.getDirectional(position, (pos) => pos[1] < position[1]);
  }

  getRight(position: GridPos): GridPos | null {
    return this.getDirectional(position, (pos) => pos[0] > position[0]);
  }

  getLeft(position: GridPos): GridPos | null {
    return this.getDirectional(position, (pos) => pos[0] < position[0]);
  }

  /** The move for a direction key (Python take_input's get_up/down/left/right). */
  step(direction: string, position: GridPos): GridPos | null {
    switch (direction) {
      case 'UP': return this.getUp(position);
      case 'DOWN': return this.getDown(position);
      case 'LEFT': return this.getLeft(position);
      case 'RIGHT': return this.getRight(position);
      default: return null;
    }
  }
}
