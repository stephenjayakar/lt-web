import { evaluateCondition } from '../events/event-manager';
import {
  initializeSkillData,
  ignoreRegionStatus,
  ignoreTerrain,
  isCantoSkill,
} from '../combat/skill-system';
import type { Database } from '../data/database';
import type { RegionData } from '../data/types';
import type { GameBoard } from '../objects/game-board';
import { SkillObject } from '../objects/skill';
import type { UnitObject } from '../objects/unit';

const REGION_SOURCE_TYPE_KEY = 'positionStatusSourceType';
const REGION_SOURCE_NID_KEY = 'positionStatusRegionNid';
const REGION_SOURCE_TYPE = 'region';
const TERRAIN_SOURCE_TYPE = 'terrain';

const regionSkillCaches = new WeakMap<object, Map<string, SkillObject>>();

function contains(region: RegionData, position: [number, number]): boolean {
  if (!region.position) return false;
  const width = region.size?.[0] ?? 1;
  const height = region.size?.[1] ?? 1;
  return position[0] >= region.position[0] &&
    position[0] < region.position[0] + width &&
    position[1] >= region.position[1] &&
    position[1] < region.position[1] + height;
}

function positionSourced(skill: SkillObject): boolean {
  const type = skill.data.get(REGION_SOURCE_TYPE_KEY);
  return type === REGION_SOURCE_TYPE || type === TERRAIN_SOURCE_TYPE;
}

/** Cache key: region NID, or `terrain:` plus Python's (x, y, status) key. */
function sourceKey(skill: SkillObject): string | null {
  const key = skill.data.get(REGION_SOURCE_NID_KEY);
  if (typeof key !== 'string') return null;
  return skill.data.get(REGION_SOURCE_TYPE_KEY) === TERRAIN_SOURCE_TYPE
    ? `terrain:${key}`
    : key;
}

interface DesiredStatus {
  type: typeof REGION_SOURCE_TYPE | typeof TERRAIN_SOURCE_TYPE;
  /** Region NID, or `x,y,status` for terrain. */
  key: string;
  skillNid: string;
}

function cacheKeyFor(entry: DesiredStatus): string {
  return entry.type === TERRAIN_SOURCE_TYPE ? `terrain:${entry.key}` : entry.key;
}

/**
 * Re-derive Python position-sourced skills from current board positions:
 * terrain statuses (GameState.add_terrain_status, keyed per tile and status)
 * and status-region skills (add_region_status, keyed per region).
 *
 * Instances are cached and reused across leave/arrive reversal, matching
 * Python's one registered SkillObject per terrain/region key.
 */
export function refreshPositionStatuses(
  units: Iterable<UnitObject>,
  board: GameBoard,
  db: Database,
  game: any,
): void {
  const allUnits = Array.from(units);
  const regions = (game.currentLevel?.regions ?? []).filter(
    (region: RegionData) => region.region_type?.toLowerCase() === 'status' &&
      typeof region.sub_nid === 'string' && region.sub_nid.length > 0,
  ) as RegionData[];
  const cache = regionSkillCaches.get(game) ?? new Map<string, SkillObject>();
  regionSkillCaches.set(game, cache);

  // Recover restored instances before deriving desired coverage.
  for (const unit of allUnits) {
    for (const skill of unit.skills) {
      if (!positionSourced(skill)) continue;
      const key = sourceKey(skill);
      if (key && !cache.has(key)) cache.set(key, skill);
    }
  }

  for (const unit of allUnits) {
    const desired: DesiredStatus[] = [];
    const position = unit.position;
    if (position && board.getUnit(position[0], position[1]) === unit) {
      // Tiles and terrain regions come first, as in Python arrive().
      if (!ignoreTerrain(unit, game)) {
        const terrainNid = board.getTerrain(position[0], position[1]);
        const status = terrainNid ? (db.terrain.get(terrainNid) as any)?.status : null;
        if (typeof status === 'string' && status.length > 0) {
          desired.push({
            type: TERRAIN_SOURCE_TYPE,
            key: `${position[0]},${position[1]},${status}`,
            skillNid: status,
          });
        }
      }
      if (!ignoreRegionStatus(unit, game)) {
        for (const region of regions) {
          if (!contains(region, position)) continue;
          if (region.condition && !evaluateCondition(region.condition, {
            game,
            unit1: unit,
            region,
            position,
            gameVars: game.gameVars,
            levelVars: game.levelVars,
            localArgs: new Map([['region', region]]),
          })) continue;
          desired.push({ type: REGION_SOURCE_TYPE, key: region.nid, skillNid: region.sub_nid });
        }
      }
    }
    const desiredKeys = new Set(desired.map(cacheKeyFor));

    for (let index = unit.skills.length - 1; index >= 0; index--) {
      const skill = unit.skills[index];
      if (!positionSourced(skill)) continue;
      const key = sourceKey(skill);
      if (!key || !desiredKeys.has(key)) {
        unit.skills.splice(index, 1);
        if (skill.ownerNid === unit.nid) skill.ownerNid = null;
      }
    }

    for (const entry of desired) {
      const prefab = db.skills.get(entry.skillNid);
      if (!prefab) continue;
      const cacheKey = cacheKeyFor(entry);
      let status = cache.get(cacheKey);
      if (!status || status.nid !== entry.skillNid) {
        status = new SkillObject(prefab);
        status.data.set(REGION_SOURCE_TYPE_KEY, entry.type);
        status.data.set(REGION_SOURCE_NID_KEY, entry.key);
        cache.set(cacheKey, status);
      }
      const existingIndex = unit.skills.findIndex((skill) =>
        positionSourced(skill) && sourceKey(skill) === cacheKey);
      if (existingIndex >= 0) {
        // Save restoration constructs per-owner instances. Python registers
        // one shared status object per key, so converge on the cached
        // object once every owner has been restored.
        if (unit.skills[existingIndex] !== status) {
          unit.skills[existingIndex] = status;
        }
        continue;
      }
      initializeSkillData(status, unit, game);
      unit.skills.push(status);
    }
    unit.hasCanto = unit.skills.some(isCantoSkill);
  }
}

export function isPositionStatusSkill(skill: SkillObject): boolean {
  return positionSourced(skill);
}
