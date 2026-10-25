/**
 * Draw-pass memoisation scope.
 *
 * Python recomputes every component query (for example skill item_override
 * resolution) on each call. Drawing a unit-dense map repeats the same query
 * many times per frame, so read-only render passes may share results — but
 * only while nothing can mutate game state. Update/input/event code runs
 * outside this scope and must always see fresh answers: a combat art,
 * condition, or skill change applied earlier in the same frame has to take
 * effect immediately.
 */

let generation = 0;
let depth = 0;

/** Run `fn` as a read-only draw pass whose query results may be cached. */
export function withDrawCache<T>(fn: () => T): T {
  if (depth === 0) generation += 1;
  depth += 1;
  try {
    return fn();
  } finally {
    depth -= 1;
  }
}

/** Current draw-pass id, or null when caching is not permitted. */
export function drawCacheGeneration(): number | null {
  return depth > 0 ? generation : null;
}
