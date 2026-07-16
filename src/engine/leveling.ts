import type { UnitObject } from '../objects/unit';
import { growthChange } from '../combat/skill-system';

export type GrowthMethod = 'Fixed' | 'Random' | 'Dynamic' | 'Lucky' | 'Bexp';

export interface AutoLevelResult {
  statChanges: Record<string, number>;
  growthPoints: Record<string, number>;
}

/** LT's deterministic linear-congruential generator. */
class Lcg {
  private state: number;

  constructor(seed: number) {
    this.state = seed & 0x7fffffff;
  }

  randint(min: number, max: number): number {
    this.state = (Math.imul(this.state, 1103515245) + 12345) & 0x7fffffff;
    const random = this.state >>> 16;
    return (random % (max - min + 1)) + min;
  }
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

function getGrowthMethod(unit: UnitObject, customMethod: string | undefined, game: any): GrowthMethod {
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
    growthChange(unit, nid)
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
export function autoLevelUnit(
  unit: UnitObject,
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
      const changes = calculateLevel(unit, unit.level + offset, method, growthPoints, game);
      for (const nid of Object.keys(statChanges)) statChanges[nid] += changes[nid] ?? 0;
    }
  } else if (levelDifference < 0) {
    const endingLevel = unit.level + levelDifference;
    for (let level = unit.level - 1; level >= endingLevel; level--) {
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
