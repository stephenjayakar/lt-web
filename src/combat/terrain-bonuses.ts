/**
 * Terrain bonus extraction — shared between HUD display and combat calculations.
 *
 * In LT, terrain bonuses come from the terrain's `status` field, which references
 * a skill. That skill's components (e.g., `avoid`, `stat_change`) provide the
 * defense and avoid bonuses.
 */

import type { Database } from '../data/database';
import type { GameBoard } from '../objects/game-board';
import type { UnitObject } from '../objects/unit';

/**
 * Extract terrain defense and avoid bonuses from a terrain definition.
 * @returns [defense, avoid] bonus values
 */
export function getTerrainBonuses(terrainDef: any, db: Database): [number, number] {
  if (!terrainDef?.status) return [0, 0];
  const skill = (db as any).skills?.get(terrainDef.status);
  if (!skill?.components) return [0, 0];

  let def = 0;
  let avo = 0;
  for (const [name, value] of skill.components) {
    if (name === 'avoid' && typeof value === 'number') {
      avo += value;
    } else if (name === 'stat_change' && Array.isArray(value)) {
      // value is [[statNid, amount], ...]
      for (const entry of value) {
        if (Array.isArray(entry) && entry[0] === 'DEF' && typeof entry[1] === 'number') {
          def += entry[1];
        }
      }
    }
  }
  return [def, avo];
}

/**
 * Get terrain defense and avoid bonuses for a unit based on their current position.
 * @returns [defense, avoid] bonus values, or [0, 0] if the unit has no position.
 */
export function getTerrainBonusesForUnit(
  unit: UnitObject,
  board: GameBoard,
  db: Database,
): [number, number] {
  if (!unit.position) return [0, 0];
  const terrainNid = board.getTerrain(unit.position[0], unit.position[1]);
  if (!terrainNid) return [0, 0];
  const terrainDef = (db as any).terrain?.get(terrainNid);
  return getTerrainBonuses(terrainDef, db);
}
