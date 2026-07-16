/** Minimal game surface needed by LT's persistent random streams. */
export interface RandomGameState {
  gameVars: Map<string, any>;
}

/** LT's 31-bit linear-congruential generator. */
export class Lcg {
  private state: number;

  constructor(seed: number) {
    this.state = seed & 0x7fffffff;
  }

  randint(minimum: number, maximum: number): number {
    if (!Number.isInteger(minimum) || !Number.isInteger(maximum) || maximum < minimum) {
      throw new RangeError(`Invalid LCG range ${minimum}..${maximum}`);
    }
    this.state = (Math.imul(this.state, 1103515245) + 12345) & 0x7fffffff;
    const random = this.state >>> 16;
    return (random % (maximum - minimum + 1)) + minimum;
  }

  getState(): number {
    return this.state;
  }
}

const GROWTH_RANDOM_SEED = '_growth_random_seed';
const GROWTH_RANDOM_STATE = '_growth_random_state';
const COMBAT_RANDOM_SEED = '_combat_random_seed';
const COMBAT_RANDOM_STATE = '_combat_random_state';

function normalizedSeed(game: RandomGameState): number {
  const raw = Number(game.gameVars.get('_random_seed') ?? 0);
  return Number.isFinite(raw) ? Math.trunc(raw) : 0;
}

/**
 * Draw from LT's shared growth stream and persist its new state in game vars.
 *
 * Python initializes this stream with `_random_seed + 1`. Keeping the current
 * state in game vars makes sequential Feat choices deterministic across level
 * loads and save/restore while remaining backward-compatible with older saves.
 */
export function getGrowthRandom(
  game: RandomGameState,
  minimum: number = 0,
  maximum: number = 99,
): number {
  const seed = normalizedSeed(game);
  const storedSeed = Number(game.gameVars.get(GROWTH_RANDOM_SEED));
  const storedState = Number(game.gameVars.get(GROWTH_RANDOM_STATE));
  const state = storedSeed === seed && Number.isInteger(storedState)
    ? storedState
    : seed + 1;
  const rng = new Lcg(state);
  const value = rng.randint(minimum, maximum);
  game.gameVars.set(GROWTH_RANDOM_SEED, seed);
  game.gameVars.set(GROWTH_RANDOM_STATE, rng.getState());
  return value;
}

export function getGrowthRandomState(game: RandomGameState): number | null {
  const state = Number(game.gameVars.get(GROWTH_RANDOM_STATE));
  return Number.isInteger(state) ? state : null;
}

/** Draw from LT's persistent combat stream (seeded directly by `_random_seed`). */
export function getCombatRandom(
  game: RandomGameState,
  minimum: number = 0,
  maximum: number = 99,
): number {
  const seed = normalizedSeed(game);
  const storedSeed = Number(game.gameVars.get(COMBAT_RANDOM_SEED));
  const storedState = Number(game.gameVars.get(COMBAT_RANDOM_STATE));
  const state = storedSeed === seed && Number.isInteger(storedState)
    ? storedState
    : seed;
  const rng = new Lcg(state);
  const value = rng.randint(minimum, maximum);
  game.gameVars.set(COMBAT_RANDOM_SEED, seed);
  game.gameVars.set(COMBAT_RANDOM_STATE, rng.getState());
  return value;
}

/** Current effective combat-stream state, including the uninitialized seed state. */
export function getCombatRandomState(game: RandomGameState): number {
  const seed = normalizedSeed(game);
  const storedSeed = Number(game.gameVars.get(COMBAT_RANDOM_SEED));
  const storedState = Number(game.gameVars.get(COMBAT_RANDOM_STATE));
  return storedSeed === seed && Number.isInteger(storedState) ? storedState : seed;
}

/** Restore the combat stream exactly for turnwheel replay. */
export function setCombatRandomState(game: RandomGameState, state: number): void {
  game.gameVars.set(COMBAT_RANDOM_SEED, normalizedSeed(game));
  game.gameVars.set(COMBAT_RANDOM_STATE, Math.trunc(state) & 0x7fffffff);
}
