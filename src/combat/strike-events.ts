import type { UnitObject } from '../objects/unit';
import type { CombatStrike } from './combat-solver';
import { CombatResultAction } from './combat-result-action';

/**
 * Python's solver fires a phase's item/skill events (event_on_hit,
 * event_on_strike, after_strike skill events...) while it resolves the phase,
 * and the EventStates they push run before that phase's hit is shown or its
 * actions applied. Later phases are solved against whatever the events left.
 *
 * The hook triggers one resolved phase's events and returns them, taken out
 * of the event queue; an empty list means the phase has none.
 */
export type StrikeEventHook = (phase: CombatStrike[]) => unknown[];

/** What CombatState drives on a map or animation combat with strike events. */
export interface StrikeEventCombat {
  strikeEventHook: StrikeEventHook | null;
  /** The presented phase's events, waiting to run before its hit. */
  pendingStrikeEvents: unknown[] | null;
  /** The pending events ran: pick up the HP they changed and continue. */
  resumeAfterStrikeEvents(): void;
}

/**
 * Write the HP of the strikes presented so far onto the units (Python's
 * actions applied at each phase's 'anim'), as one reversible action, and
 * return each participant's HP afterwards as the events' baseline.
 */
export function applyPresentedStrikeHp(
  game: any,
  participants: UnitObject[],
  apply: () => void,
): Map<UnitObject, number> {
  const log = game?.actionLog;
  if (log?.doAction) log.doAction(new CombatResultAction(participants, [], apply));
  else apply();
  return new Map(participants.map((unit) => [unit, unit.currentHp]));
}

/** HP the strike events changed, per unit, against the baseline. */
export function strikeEventHpDeltas(baseline: Map<UnitObject, number>): Map<UnitObject, number> {
  const deltas = new Map<UnitObject, number>();
  for (const [unit, hp] of baseline) {
    const delta = unit.currentHp - hp;
    if (delta !== 0) deltas.set(unit, delta);
  }
  return deltas;
}
