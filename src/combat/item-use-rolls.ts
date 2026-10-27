/**
 * item-use-rolls.ts — the combat-stream draws of an item use that the web
 * resolves outside its combat solver (Vulnerary, Heal and the other "core"
 * uses in game-states.ts).
 *
 * Python runs every item use through interaction.start_combat, so the use
 * reaches CombatPhaseSolver.process once per unit it targets (the unit on the
 * main target tile, then each splash unit; an empty tile goes through
 * simple_process and draws nothing). process always calls generate_roll()
 * for the RNG mode (two draws on True Hit), and on a hit draws a crit roll
 * when crits are on (the `crit` constant or crit_anyway) and the item has a
 * crit value. An item without a hit value has to_hit 10000, so it always
 * hits. The draws are recorded with RecordRandomState so the turnwheel
 * restores the stream.
 */

import type { UnitObject } from '../objects/unit';
import type { ItemObject } from '../objects/item';
import { computeHit } from './combat-calcs';
import { critAnyway } from './skill-system';
import * as itemSystem from './item-system';
import { getCombatRandom, getCombatRandomState } from '../engine/static-random';
import { RecordCombatRandomStateAction } from '../engine/action';

/** The units Python's solver processes for one target position. */
export function itemUseStrikeTargets(
  game: any,
  unit: UnitObject,
  item: ItemObject,
  position: [number, number],
): UnitObject[] {
  const resolved = game.targetSystem?.getTargetFromPosition?.(unit, item, position);
  if (!resolved || !game.board) return [];
  const targets: UnitObject[] = [];
  const main = resolved.mainTarget ? game.board.getUnit(resolved.mainTarget[0], resolved.mainTarget[1]) : null;
  if (main) targets.push(main);
  for (const splashPosition of resolved.splash ?? []) {
    const splashUnit = splashPosition ? game.board.getUnit(splashPosition[0], splashPosition[1]) : null;
    if (splashUnit) targets.push(splashUnit);
  }
  return targets;
}

function fatesHit(hit: number): number {
  return Math.round(hit + (40 / 3) * (hit / 100) * Math.sin((0.02 * hit - 1) * Math.PI));
}

/** Python solver.generate_roll for the game's RNG mode. */
function generateRoll(game: any): number {
  const draw = () => getCombatRandom(game);
  switch (game.rngMode) {
    case 'grandmaster':
      return 0;
    case 'classic':
    case 'fates_hit':
      return draw();
    case 'true_hit_plus':
      return Math.floor((draw() + draw() + draw()) / 3);
    case 'true_hit':
    default:
      return Math.floor((draw() + draw()) / 2);
  }
}

/** Draw the hit (and crit) rolls of one solver strike of `item` against `target`. */
function drawStrikeRolls(game: any, unit: UnitObject, item: ItemObject, target: UnitObject): void {
  // computeHit is 100 for an item without a hit value (Python's 10000).
  let toHit = Math.max(0, Math.min(100, computeHit(unit, item, target, game.db, game.board, game, 'attack', [0, 0])));
  if (game.rngMode === 'fates_hit') toHit = fatesHit(toHit);
  const roll = generateRoll(game);
  if (roll >= toHit) return;
  const critsOn = game.db?.getConstant?.('crit', true) !== false || critAnyway(unit);
  if (critsOn && itemSystem.crit(unit, item) !== null) getCombatRandom(game);
}

/**
 * Draw every roll an item use's targets cost in Python, as one recorded
 * action. `strikes` pairs each processed item (a sequence child, or the item
 * itself) with the positions it was used on.
 */
export function drawItemUseRolls(
  game: any,
  unit: UnitObject,
  strikes: Array<{ item: ItemObject; positions: [number, number][] }>,
): void {
  if (!game?.gameVars) return;
  const before = getCombatRandomState(game);
  for (const { item, positions } of strikes) {
    for (const position of positions) {
      for (const target of itemUseStrikeTargets(game, unit, item, position)) {
        drawStrikeRolls(game, unit, item, target);
      }
    }
  }
  const after = getCombatRandomState(game);
  if (after !== before) {
    game.actionLog.doAction(new RecordCombatRandomStateAction(game, before, after));
  }
}
