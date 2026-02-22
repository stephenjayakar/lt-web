import type { UnitObject } from '../objects/unit';

/**
 * PhaseController - Manages turn phases (player, enemy, other, etc.)
 * Matches LT's PhaseController from app/engine/phase.py
 *
 * Each "phase" corresponds to one team's turn. The controller cycles through
 * teams in order, skipping any team that has no units on the board — with the
 * exception of 'player', which is never skipped so the human always gets a
 * turn even when fielding zero units (allows event-only turns).
 */
export class PhaseController {
  private teams: string[] = [];
  private currentIndex: number = 0;
  turnCount: number = 0;

  constructor(teams: string[]) {
    this.teams = [...teams];
    this.currentIndex = 0;
    this.turnCount = 1;
  }

  /** Get current team NID. */
  getCurrent(): string {
    return this.teams[this.currentIndex];
  }

  /**
   * Advance to the next phase.
   *
   * Skips teams that have no units on the board, but never skips 'player'.
   * When the cycle wraps past the last team, the turn counter increments.
   *
   * @param getTeamUnits - callback that returns the list of living units for a
   *   given team NID. Used to decide whether a team should be skipped.
   */
  next(getTeamUnits: (team: string) => UnitObject[]): void {
    if (this.teams.length === 0) return;

    const startIndex = this.currentIndex;
    let looped = false;

    do {
      this.currentIndex++;

      // Wrap around
      if (this.currentIndex >= this.teams.length) {
        this.currentIndex = 0;
        this.turnCount++;
        looped = true;
      }

      const team = this.teams[this.currentIndex];

      // Never skip the player phase
      if (team === 'player') break;

      // Skip teams with no living units
      const units = getTeamUnits(team);
      if (units.length > 0) break;

      // Safety: if we've gone all the way around, stop to prevent infinite loop
      if (looped && this.currentIndex === startIndex) break;
    } while (true);
  }

  /** Check if it's the player's turn. */
  isPlayerPhase(): boolean {
    return this.getCurrent() === 'player';
  }

  /**
   * Set the current team directly by NID.
   * Used by the initiative system to switch phases to match the
   * current initiative unit's team without advancing the turn counter.
   */
  setCurrentTeam(team: string): void {
    const idx = this.teams.indexOf(team);
    if (idx !== -1) {
      this.currentIndex = idx;
    }
  }

  /** Reset to start (turn 1, first team). */
  reset(): void {
    this.currentIndex = 0;
    this.turnCount = 1;
  }
}
