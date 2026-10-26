// ---------------------------------------------------------------------------
// Region interrupts (Python movement_funcs.check_region_interrupt and the
// callers in UnitPathMovementComponent, AIController.act and action.Wait).
// EOtF places interrupt_move event regions for Mines, Slip Traps,
// Suppressive Fire and Snuff Out the Light.
// ---------------------------------------------------------------------------

import type { UnitObject } from '../objects/unit';
import type { RegionData } from '../data/types';
import { evaluateCondition } from '../events/event-manager';

function regionContains(region: RegionData, position: [number, number]): boolean {
  if (!region.position) return false;
  const [rx, ry] = region.position;
  const [rw, rh] = region.size ?? [1, 1];
  return position[0] >= rx && position[0] < rx + rw &&
    position[1] >= ry && position[1] < ry + rh;
}

/**
 * Python movement_funcs.check_region_interrupt: the interrupt_move regions
 * containing the unit's position whose condition passes for the unit.
 * `position` evaluates the check as if the unit stood there.
 */
export function checkRegionInterrupt(
  unit: UnitObject,
  game: any,
  position: [number, number] | null = unit.position,
): RegionData[] {
  const regions: RegionData[] = game?.currentLevel?.regions ?? [];
  if (!position || regions.length === 0) return [];
  const candidates = regions.filter((region) =>
    region.interrupt_move && regionContains(region, position));
  if (candidates.length === 0) return [];
  const original = unit.position;
  unit.position = [position[0], position[1]];
  try {
    return candidates.filter((region) => evaluateCondition(region.condition || 'True', {
      game,
      unit1: unit,
      region,
      position,
      gameVars: game.gameVars,
      levelVars: game.levelVars,
      localArgs: new Map<string, unknown>([['region', region]]),
    }));
  } finally {
    unit.position = original;
  }
}

/**
 * Where a unit walking `path` (path[0] is its start) actually stops. Python
 * UnitPathMovementComponent checks the tile the unit currently stands on
 * before every step (check_position: unless another unit shares it), so the
 * walk ends on the first interrupting tile; arriving on an interrupting final
 * tile is also a surprise.
 */
export function interruptMovePath(
  unit: UnitObject,
  path: [number, number][],
  game: any,
): { path: [number, number][]; surprise: boolean } {
  if (path.length <= 1) return { path, surprise: false };
  const last = path.length - 1;
  for (let index = 0; index < last; index++) {
    const [x, y] = path[index];
    const occupant = game?.board?.getUnit?.(x, y);
    if (occupant && occupant !== unit) continue;
    if (checkRegionInterrupt(unit, game, path[index]).length > 0) {
      return { path: path.slice(0, index + 1), surprise: true };
    }
  }
  return { path, surprise: checkRegionInterrupt(unit, game, path[last]).length > 0 };
}

/**
 * Python action.Wait.remove_interrupt_regions: fire each interrupting event
 * region's RegionTrigger(sub_nid), falling back to on_region_interact, and
 * return the only_once regions that should be removed (non-event regions
 * always, event regions only when something triggered).
 */
export function triggerInterruptRegions(unit: UnitObject, game: any): RegionData[] {
  const toRemove: RegionData[] = [];
  if (!unit.position) return toRemove;
  const position: [number, number] = [unit.position[0], unit.position[1]];
  for (const region of checkRegionInterrupt(unit, game)) {
    let triggered = false;
    const isEvent = String(region.region_type).toLowerCase() === 'event';
    if (isEvent && game.eventManager) {
      const levelNid = game.currentLevel?.nid ?? '';
      const ctx = {
        game, unit1: unit, position, region,
        gameVars: game.gameVars, levelVars: game.levelVars,
      };
      triggered = game.eventManager.trigger(
        { type: region.sub_nid, levelNid, regionNid: region.nid, unitNid: unit.nid, unit1: unit, position, region },
        ctx,
      );
      if (!triggered) {
        triggered = game.eventManager.trigger(
          { type: 'on_region_interact', levelNid, regionNid: region.nid, unitNid: unit.nid, unit1: unit, position, region },
          ctx,
        );
      }
    }
    if ((!isEvent || triggered) && region.only_once) toRemove.push(region);
  }
  return toRemove;
}
