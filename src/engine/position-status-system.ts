import { evaluateCondition } from '../events/event-manager';
import { initializeSkillData, ignoreRegionStatus, isCantoSkill } from '../combat/skill-system';
import type { Database } from '../data/database';
import type { RegionData } from '../data/types';
import type { GameBoard } from '../objects/game-board';
import { SkillObject } from '../objects/skill';
import type { UnitObject } from '../objects/unit';

const REGION_SOURCE_TYPE_KEY = 'positionStatusSourceType';
const REGION_SOURCE_NID_KEY = 'positionStatusRegionNid';
const REGION_SOURCE_TYPE = 'region';

const regionSkillCaches = new WeakMap<object, Map<string, SkillObject>>();

function contains(region: RegionData, position: [number, number]): boolean {
  const width = region.size?.[0] ?? 1;
  const height = region.size?.[1] ?? 1;
  return position[0] >= region.position[0] &&
    position[0] < region.position[0] + width &&
    position[1] >= region.position[1] &&
    position[1] < region.position[1] + height;
}

function sourcedFromRegion(skill: SkillObject, regionNid?: string): boolean {
  return skill.data.get(REGION_SOURCE_TYPE_KEY) === REGION_SOURCE_TYPE &&
    (regionNid === undefined ||
      skill.data.get(REGION_SOURCE_NID_KEY) === regionNid);
}

/**
 * Re-derive Python status-region skills from current board positions.
 *
 * Region instances are cached and reused across leave/arrive reversal, matching
 * Python's one registered terrain-status SkillObject per region key.
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
      if (!sourcedFromRegion(skill)) continue;
      const regionNid = skill.data.get(REGION_SOURCE_NID_KEY);
      if (typeof regionNid === 'string' && !cache.has(regionNid)) {
        cache.set(regionNid, skill);
      }
    }
  }

  for (const unit of allUnits) {
    const desired = new Set<string>();
    if (unit.position && board.getUnit(unit.position[0], unit.position[1]) === unit &&
        !ignoreRegionStatus(unit, game)) {
      for (const region of regions) {
        if (!contains(region, unit.position)) continue;
        if (region.condition && !evaluateCondition(region.condition, {
          game,
          unit1: unit,
          region,
          position: unit.position,
          gameVars: game.gameVars,
          levelVars: game.levelVars,
          localArgs: new Map([['region', region]]),
        })) continue;
        desired.add(region.nid);
      }
    }

    for (let index = unit.skills.length - 1; index >= 0; index--) {
      const skill = unit.skills[index];
      if (!sourcedFromRegion(skill)) continue;
      const regionNid = skill.data.get(REGION_SOURCE_NID_KEY);
      if (typeof regionNid !== 'string' || !desired.has(regionNid)) {
        unit.skills.splice(index, 1);
        if (skill.ownerNid === unit.nid) skill.ownerNid = null;
      }
    }

    for (const regionNid of desired) {
      const region = regions.find((candidate) => candidate.nid === regionNid);
      const prefab = region ? db.skills.get(region.sub_nid) : undefined;
      if (!region || !prefab) continue;
      let status = cache.get(regionNid);
      if (!status || status.nid !== region.sub_nid) {
        status = new SkillObject(prefab);
        status.data.set(REGION_SOURCE_TYPE_KEY, REGION_SOURCE_TYPE);
        status.data.set(REGION_SOURCE_NID_KEY, regionNid);
        cache.set(regionNid, status);
      }
      const existingIndex = unit.skills.findIndex(
        (skill) => sourcedFromRegion(skill, regionNid),
      );
      if (existingIndex >= 0) {
        // Save restoration constructs per-owner instances. Python registers
        // one shared status object per region key, so converge on the cached
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
  return sourcedFromRegion(skill);
}
