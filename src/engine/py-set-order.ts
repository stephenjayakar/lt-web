/**
 * Iteration order of a CPython 3.11 (64-bit) set of integer pairs.
 *
 * EOtF's engine builds several AOE splash lists by iterating Python sets of
 * board positions, so the order targets are struck in (which RNG roll each
 * gets, how lifelink totals build up within a phase) follows CPython's hash
 * table layout rather than any geometric order. This reproduces it: the
 * xxHash-based tuple hash, open addressing with 9 linear probes then
 * perturbed probing, and the table growth rule.
 */

const MASK64 = (1n << 64n) - 1n;
const XXPRIME_1 = 11400714785074694791n;
const XXPRIME_2 = 14029467366897019727n;
const XXPRIME_5 = 2870177450012600261n;
const LINEAR_PROBES = 9;
const PERTURB_SHIFT = 5n;
const MIN_SIZE = 8;

/** CPython hash() of a small int, as an unsigned 64-bit value. */
function intHash(value: number): bigint {
  const hash = value === -1 ? -2 : value;
  return BigInt.asUintN(64, BigInt(hash));
}

/** CPython hash() of a tuple of small ints, as an unsigned 64-bit value. */
export function pyTupleHash(values: readonly number[]): bigint {
  let acc = XXPRIME_5;
  for (const value of values) {
    acc = (acc + intHash(value) * XXPRIME_2) & MASK64;
    acc = ((acc << 31n) | (acc >> 33n)) & MASK64;
    acc = (acc * XXPRIME_1) & MASK64;
  }
  acc = (acc + (BigInt(values.length) ^ (XXPRIME_5 ^ 3527539n))) & MASK64;
  if (acc === MASK64) return 1546275796n;
  return acc;
}

interface Slot {
  key: string;
  value: [number, number];
  hash: bigint;
}

/** A CPython set of int pairs, tracking its table layout. */
export class PyPairSet {
  private table: Array<Slot | null> = new Array(MIN_SIZE).fill(null);
  private fill = 0;
  private used = 0;

  add(value: readonly [number, number]): void {
    const key = `${value[0]},${value[1]}`;
    const hash = pyTupleHash(value);
    const mask = this.table.length - 1;
    let i = Number(hash & BigInt(mask));
    let perturb = hash;
    for (;;) {
      let probes = i + LINEAR_PROBES <= mask ? LINEAR_PROBES : 0;
      let index = i;
      do {
        const slot = this.table[index];
        if (slot === null) {
          this.table[index] = { key, value: [value[0], value[1]], hash };
          this.fill++;
          this.used++;
          if (this.fill * 5 >= mask * 3) this.resize(this.used > 50000 ? this.used * 2 : this.used * 4);
          return;
        }
        if (slot.hash === hash && slot.key === key) return;
        index++;
      } while (probes-- > 0);
      perturb >>= PERTURB_SHIFT;
      i = Number((BigInt(i) * 5n + 1n + perturb) & BigInt(mask));
    }
  }

  private resize(minUsed: number): void {
    let size = MIN_SIZE;
    while (size <= minUsed) size <<= 1;
    const old = this.table;
    this.table = new Array(size).fill(null);
    const mask = size - 1;
    for (const slot of old) {
      if (!slot) continue;
      let i = Number(slot.hash & BigInt(mask));
      let perturb = slot.hash;
      for (;;) {
        if (this.table[i] === null) break;
        let placed = false;
        if (i + LINEAR_PROBES <= mask) {
          for (let j = 1; j <= LINEAR_PROBES; j++) {
            if (this.table[i + j] === null) {
              i += j;
              placed = true;
              break;
            }
          }
        }
        if (placed) break;
        perturb >>= PERTURB_SHIFT;
        i = Number((BigInt(i) * 5n + 1n + perturb) & BigInt(mask));
      }
      this.table[i] = slot;
    }
    this.fill = this.used;
  }

  /** The set's iteration order. */
  values(): [number, number][] {
    return this.table.filter((slot): slot is Slot => slot !== null).map((slot) => [slot.value[0], slot.value[1]]);
  }
}

/** list(set(values)) in CPython: the iteration order after inserting in sequence. */
export function pySetOrder(values: Iterable<readonly [number, number]>): [number, number][] {
  const set = new PyPairSet();
  for (const value of values) set.add(value);
  return set.values();
}
