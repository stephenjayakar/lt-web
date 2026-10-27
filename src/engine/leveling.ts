import type { UnitObject } from '../objects/unit';
import { growthChange, unitHasTag } from '../combat/skill-system';
import { Lcg } from './static-random';
import { isForkEngine } from './engine-flavor';

export type GrowthMethod = 'Fixed' | 'Random' | 'Dynamic' | 'Lucky' | 'Bexp';

export interface AutoLevelResult {
  statChanges: Record<string, number>;
  growthPoints: Record<string, number>;
}

type LevelCapGame = {
  db: {
    classes: Map<string, { max_level?: number; turns_into?: string[] }>;
    getConstant?: (nid: string, fallback?: any) => unknown;
  };
  gameVars: Map<string, unknown>;
};

/**
 * Fork unit_funcs.get_level_cap: class max_level + game.level_cap_modifier +
 * unit.level_cap_modifier, with no other ceiling. Upstream lt-maker reads
 * max_level only; the modifiers are only changed by the fork's
 * change_global_level_cap / change_unit_level_cap commands, so other
 * projects still cap at max_level.
 */
export function getEffectiveLevelCap(unit: UnitObject, game: LevelCapGame): number {
  const classCap = Number(game.db.classes.get(unit.klass)?.max_level ?? 20);
  const globalBonus = Number(game.gameVars.get('_global_level_cap_bonus') ?? 0);
  const unitBonus = Number(unit.fields.get('_level_cap_bonus') ?? 0);
  return classCap +
    (Number.isFinite(globalBonus) ? globalBonus : 0) +
    (Number.isFinite(unitBonus) ? unitBonus : 0);
}

/** Python ExpState.has_autopromote / exp_funcs.has_autopromote. */
export function hasAutoPromote(unit: UnitObject, game: LevelCapGame): boolean {
  const klass = game.db.classes.get(unit.klass);
  return Boolean(game.db.getConstant?.('auto_promote', false) || unitHasTag(unit, 'AutoPromote', game)) &&
    (klass?.turns_into?.length ?? 0) > 0 && !unitHasTag(unit, 'NoAutoPromote', game);
}

/** Python ExpState.can_give_exp (with the fork's get_level_cap). */
export function canGiveExp(unit: UnitObject, exp: number, game: LevelCapGame): boolean {
  return unit.level < getEffectiveLevelCap(unit, game) || exp < 0 || hasAutoPromote(unit, game);
}

/**
 * The exp an ExpState actually grants. Python clamps the gain to
 * `100 * (level_cap - level) - exp` unless the unit auto-promotes, and the
 * state backs out without granting anything when can_give_exp fails.
 */
export function cappedExpGain(unit: UnitObject, exp: number, game: LevelCapGame): number {
  let gain = exp;
  if (!hasAutoPromote(unit, game)) {
    gain = Math.min(gain, 100 * (getEffectiveLevelCap(unit, game) - unit.level) - unit.exp);
  }
  return canGiveExp(unit, gain, game) ? gain : 0;
}

/**
 * Grant exp in place the way ExpState + GainExp do: clamp at the level cap,
 * then level up (one growth roll per level, with the unit's leveling method
 * unless `customMethod` is given) until the exp is below 100 or the cap is
 * reached. Returns the exp actually granted and each level's stat changes.
 */
export function applyExpGain(
  unit: UnitObject,
  amount: number,
  customMethod: string | undefined,
  game: any,
): { applied: number; levelUps: Record<string, number>[] } {
  const applied = game ? cappedExpGain(unit, amount, game) : amount;
  const levelUps: Record<string, number>[] = [];
  unit.exp += applied;
  const levelCap = game ? getEffectiveLevelCap(unit, game) : Number.POSITIVE_INFINITY;
  while (unit.exp >= 100 && unit.level < levelCap) {
    unit.exp -= 100;
    levelUps.push(game
      ? levelUpUnit(unit, customMethod, game)
      : unit.levelUp(customMethod ?? 'random'));
  }
  if (unit.level >= levelCap && unit.exp >= 100) unit.exp = 0;
  return { applied, levelUps };
}

const MD5_SHIFTS = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];
const MD5_CONSTANTS = Array.from(
  { length: 64 },
  (_, index) => Math.floor(Math.abs(Math.sin(index + 1)) * 0x100000000) >>> 0,
);

function rotateLeft(value: number, amount: number): number {
  return ((value << amount) | (value >>> (32 - amount))) >>> 0;
}

/** Return the low 31 bits of Python's int(md5(text).hexdigest(), 16). */
function md5Low31(text: string): number {
  const source = new TextEncoder().encode(text);
  const paddedLength = Math.ceil((source.length + 9) / 64) * 64;
  const bytes = new Uint8Array(paddedLength);
  bytes.set(source);
  bytes[source.length] = 0x80;
  const bitLength = BigInt(source.length) * 8n;
  for (let i = 0; i < 8; i++) {
    bytes[paddedLength - 8 + i] = Number((bitLength >> BigInt(i * 8)) & 0xffn);
  }

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;

  for (let offset = 0; offset < bytes.length; offset += 64) {
    const words = new Uint32Array(16);
    for (let i = 0; i < 16; i++) {
      const j = offset + i * 4;
      words[i] = (
        bytes[j] |
        (bytes[j + 1] << 8) |
        (bytes[j + 2] << 16) |
        (bytes[j + 3] << 24)
      ) >>> 0;
    }

    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;

    for (let i = 0; i < 64; i++) {
      let f: number;
      let g: number;
      if (i < 16) {
        f = (b & c) | (~b & d);
        g = i;
      } else if (i < 32) {
        f = (d & b) | (~d & c);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        f = b ^ c ^ d;
        g = (3 * i + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = (7 * i) % 16;
      }
      const nextD = d;
      d = c;
      c = b;
      const sum = (a + f + MD5_CONSTANTS[i] + words[g]) >>> 0;
      b = (b + rotateLeft(sum, MD5_SHIFTS[i])) >>> 0;
      a = nextD;
    }

    a0 = (a0 + a) >>> 0;
    b0 = (b0 + b) >>> 0;
    c0 = (c0 + c) >>> 0;
    d0 = (d0 + d) >>> 0;
  }

  // MD5 serializes each state word little-endian. Python interprets the
  // resulting hexadecimal digest big-endian, so its low word is the byte-
  // reversed serialization of d0.
  const lowWord = (
    ((d0 & 0xff) << 24) |
    ((d0 & 0xff00) << 8) |
    ((d0 >>> 8) & 0xff00) |
    ((d0 >>> 24) & 0xff)
  ) >>> 0;
  return lowWord & 0x7fffffff;
}

function levelRng(unitNid: string, level: number, seed: number): Lcg {
  return new Lcg((md5Low31(unitNid) + level * 1024 + seed) & 0x7fffffff);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function pythonModulo(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor;
}

/**
 * Python unit_funcs.get_leveling_method: a custom method wins; player units
 * use the difficulty's growths; everyone else the `enemy_leveling` constant
 * ('Match' = the difficulty's growths).
 */
export function getGrowthMethod(unit: UnitObject, customMethod: string | undefined, game: any): GrowthMethod {
  let raw = customMethod?.trim();
  if (!raw) {
    if (unit.team === 'player') {
      raw = game.currentMode?.growths ?? 'Random';
    } else {
      raw = String(game.db.getConstant?.('enemy_leveling', 'Random') ?? 'Random');
      if (raw.toLowerCase() === 'match') raw = game.currentMode?.growths ?? 'Random';
    }
  }
  const normalized = (raw ?? 'Random').toLowerCase();
  if (normalized === 'fixed') return 'Fixed';
  if (normalized === 'dynamic') return 'Dynamic';
  if (normalized === 'lucky') return 'Lucky';
  if (normalized === 'bexp') return 'Bexp';
  return 'Random';
}

function getDifficultyGrowthBonus(unit: UnitObject, game: any): Record<string, number> {
  const mode = game.currentMode;
  const prefab = game.mode;
  if (!mode || !prefab) return {};
  return mode.getGrowthBonus(unit, game.getAlliedTeams(), prefab) ?? {};
}

function weightedChoice(weights: number[], rng: Lcg): number {
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  let roll = rng.randint(0, total - 1);
  for (let index = 0; index < weights.length; index++) {
    if (roll < weights[index]) return index;
    roll -= weights[index];
  }
  return weights.length - 1;
}

function calculateLevel(
  unit: UnitObject,
  level: number,
  method: GrowthMethod,
  growthPoints: Record<string, number>,
  game: any,
): Record<string, number> {
  const klass = game.db.classes.get(unit.klass);
  const difficultyBonus = getDifficultyGrowthBonus(unit, game);
  const negativeGrowths = Boolean(game.db.getConstant?.('negative_growths', false));
  const seed = Number(game.gameVars?.get?.('_random_seed') ?? 0);
  const rng = levelRng(unit.nid, level, seed);
  const statNids = game.db.stats.map((stat: { nid: string }) => stat.nid);
  const changes: Record<string, number> = Object.fromEntries(statNids.map((nid: string) => [nid, 0]));

  const growthRate = (nid: string): number => (
    (unit.growths[nid] ?? 0) +
    (klass?.growth_bonus?.[nid] ?? 0) +
    (difficultyBonus[nid] ?? 0) +
    growthChange(unit, nid, game)
  );

  if (method === 'Bexp') {
    const weights = statNids.map((nid: string) => {
      const cap = unit.getStatCap(nid);
      return (unit.stats[nid] ?? 0) < cap && (unit.growths[nid] ?? 0) !== 0
        ? Math.max(growthRate(nid), 0)
        : 0;
    });
    for (let choice = 0; choice < 3 && weights.some((weight: number) => weight > 0); choice++) {
      const index = weightedChoice(weights, rng);
      const nid = statNids[index];
      changes[nid] += 1;
      weights[index] = Math.max(0, weights[index] - 100);
      if ((unit.stats[nid] ?? 0) + changes[nid] >= unit.getStatCap(nid)) {
        weights[index] = 0;
      }
    }
  } else {
    for (const nid of statNids) {
      let growth = growthRate(nid);
      let change = 0;
      if (method === 'Fixed') {
        if (growth > 0) {
          change += Math.floor(growth / 100);
          growth %= 100;
          if ((50 + growth * level) % 100 < growth) change += 1;
        } else if (growth < 0 && negativeGrowths) {
          change -= Math.floor(Math.abs(growth) / 100);
          growth = -(Math.abs(growth) % 100);
          const increment = pythonModulo(50 + growth * level, 100);
          if (increment > 100 - growth || increment === 0) change -= 1;
        }
      } else if (method === 'Lucky') {
        if (growth > 0) {
          while (growth > 0) {
            change += 1;
            growth -= 100;
          }
        } else if (growth < 0 && negativeGrowths) {
          growth = Math.abs(growth);
          while (growth > 0) {
            if (growth >= 100) change -= 1;
            growth -= 100;
          }
        }
      } else if (method === 'Dynamic') {
        if (growth !== 0 && (growth > 0 || negativeGrowths)) {
          const direction = growth < 0 ? -1 : 1;
          growth = Math.abs(growth);
          // The EOtF fork banks growth/5 (no roll) while the growth plus the
          // unit's growth points is not positive.
          if (isForkEngine() && growth + (growthPoints[nid] ?? 0) <= 0) {
            growthPoints[nid] = (growthPoints[nid] ?? 0) + growth / 5;
            changes[nid] = 0;
            continue;
          }
          change += direction * Math.floor(growth / 100);
          const remainder = growth % 100;
          const adjusted = remainder + (growthPoints[nid] ?? 0);
          if (rng.randint(0, 99) < Math.trunc(adjusted)) {
            change += direction;
            growthPoints[nid] = (growthPoints[nid] ?? 0) - (100 - remainder) / 10;
          } else {
            growthPoints[nid] = (growthPoints[nid] ?? 0) + remainder / 10;
          }
        }
      } else {
        if (growth > 0) {
          while (growth > 0) {
            if (rng.randint(0, 99) < growth) change += 1;
            growth -= 100;
          }
        } else if (growth < 0 && negativeGrowths) {
          growth = Math.abs(growth);
          while (growth > 0) {
            if (rng.randint(0, 99) < growth) change -= 1;
            growth -= 100;
          }
        }
      }
      changes[nid] = clamp(
        change,
        -(unit.stats[nid] ?? 0),
        unit.getStatCap(nid) - (unit.stats[nid] ?? 0),
      );
    }
  }
  return changes;
}

/** Faithful port of unit_funcs.auto_level, including level-down behavior. */
/**
 * Python UnitObject.get_internal_level: tier 0 counts below 1 by its max
 * level, tier 1 is the plain level, and higher tiers add the max level of
 * every class they promote from (stopping after a tier <= 0 class).
 */
export function getInternalLevel(unit: UnitObject, db: any): number {
  let klass = db?.classes?.get?.(unit.klass);
  if (!klass) return unit.level;
  const tier = Number(klass.tier ?? 1);
  if (tier === 0) return unit.level - Number(klass.max_level ?? 0);
  if (tier === 1) return unit.level;
  let runningTotal = unit.level;
  for (let counter = 5; counter > 0; counter -= 1) {
    const promotesFrom = klass.promotes_from;
    if (!promotesFrom) return runningTotal;
    klass = db.classes.get(promotesFrom);
    if (!klass) return runningTotal;
    runningTotal += Number(klass.max_level ?? 0);
    if (Number(klass.tier ?? 1) <= 0) return runningTotal;
  }
  return runningTotal;
}

export function autoLevelUnit(
  unit: UnitObject,
  levelDifference: number,
  customMethod: string | undefined,
  game: any,
): AutoLevelResult {
  // Python AutoLevel/ExpState feed the growth formulas (and the random
  // seed) the internal level, not the displayed one.
  return autoLevelFrom(unit, getInternalLevel(unit, game.db), levelDifference, customMethod, game);
}

/**
 * Python unit_funcs.auto_level(unit, base_level, num_levels, custom_method):
 * the stat changes (clamped to the caps) and resulting growth points of
 * `levelDifference` level-ups starting at `baseLevel`. Nothing is applied.
 */
export function autoLevelFrom(
  unit: UnitObject,
  baseLevel: number,
  levelDifference: number,
  customMethod: string | undefined,
  game: any,
): AutoLevelResult {
  const method = getGrowthMethod(unit, customMethod, game);
  const growthPoints = { ...unit.growthPoints };
  const statChanges: Record<string, number> = Object.fromEntries(
    game.db.stats.map((stat: { nid: string }) => [stat.nid, 0]),
  );

  if (levelDifference > 0) {
    for (let offset = 0; offset < levelDifference; offset++) {
      const changes = calculateLevel(unit, baseLevel + offset, method, growthPoints, game);
      for (const nid of Object.keys(statChanges)) statChanges[nid] += changes[nid] ?? 0;
    }
  } else if (levelDifference < 0) {
    const endingLevel = baseLevel + levelDifference;
    for (let level = baseLevel - 1; level >= endingLevel; level--) {
      const changes = calculateLevel(unit, level, method, growthPoints, game);
      for (const nid of Object.keys(statChanges)) statChanges[nid] -= changes[nid] ?? 0;
    }
  }

  for (const nid of Object.keys(statChanges)) {
    statChanges[nid] = clamp(
      statChanges[nid],
      -(unit.stats[nid] ?? 0),
      unit.getStatCap(nid) - (unit.stats[nid] ?? 0),
    );
  }
  return { statChanges, growthPoints };
}

/**
 * Python unit_funcs.difficulty_auto_level: Fixed level-ups driven only by the
 * difficulty's growth bonus (backpropagate_difficulty_growths for units built
 * above level 1). Returns the clamped stat changes.
 */
export function difficultyAutoLevel(
  unit: UnitObject,
  baseLevel: number,
  numLevels: number,
  game: any,
): Record<string, number> {
  const bonus = getDifficultyGrowthBonus(unit, game);
  const statNids: string[] = game.db.stats.map((stat: { nid: string }) => stat.nid);
  const negativeGrowths = Boolean(game.db.getConstant?.('negative_growths', false));
  const totals: Record<string, number> = Object.fromEntries(statNids.map((nid) => [nid, 0]));
  for (let offset = 0; offset < numLevels; offset++) {
    const level = baseLevel + offset;
    for (const nid of statNids) {
      let growth = Number(bonus[nid] ?? 0);
      if (growth > 0) {
        totals[nid] += Math.floor(growth / 100);
        growth %= 100;
        if ((50 + growth * level) % 100 < growth) totals[nid] += 1;
      } else if (growth < 0 && negativeGrowths) {
        totals[nid] -= Math.floor(Math.abs(growth) / 100);
        growth = -(Math.abs(growth) % 100);
        const increment = pythonModulo(50 + growth * level, 100);
        if (increment > 100 - growth || increment === 0) totals[nid] -= 1;
      }
    }
  }
  for (const nid of statNids) {
    totals[nid] = clamp(totals[nid], -(unit.stats[nid] ?? 0), unit.getStatCap(nid) - (unit.stats[nid] ?? 0));
  }
  return totals;
}

/** Apply one displayed level-up through the same deterministic engine as autolevel. */
export function levelUpUnit(
  unit: UnitObject,
  customMethod: string | undefined,
  game: any,
): Record<string, number> {
  const result = autoLevelUnit(unit, 1, customMethod, game);
  const oldHp = unit.currentHp;
  for (const [nid, change] of Object.entries(result.statChanges)) {
    if (unit.stats[nid] !== undefined) unit.stats[nid] += change;
  }
  unit.growthPoints = result.growthPoints;
  unit.level += 1;
  unit.currentHp = Math.max(0, Math.min(unit.maxHp, oldHp + (result.statChanges.HP ?? 0)));
  return result.statChanges;
}
