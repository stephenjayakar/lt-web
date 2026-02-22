/**
 * InitiativeTracker — Manages the initiative-based turn system.
 *
 * Port of LT's app/engine/initiative.py.
 *
 * When initiative mode is enabled (via the 'initiative' constant),
 * units take turns individually based on their initiative value rather
 * than the standard team-phase system. Units are sorted by initiative
 * (descending) and each gets one turn in order. When all units have
 * acted, the cycle repeats and the turn counter increments.
 */

import type { UnitObject } from '../objects/unit';
import type { Database } from '../data/database';
import { evaluateEquation } from '../combat/combat-calcs';

/**
 * Compute the initiative value for a unit using the DB equation.
 * Falls back to 0 if no 'initiative' equation is defined.
 */
function getInitiative(unit: UnitObject, db: Database): number {
  const expr = db.getEquation('initiative');
  if (expr) return evaluateEquation(expr, unit);
  return 0;
}

export class InitiativeTracker {
  /** Unit NIDs in initiative order (highest initiative first). */
  unitLine: string[] = [];

  /** Parallel array of initiative values (same indices as unitLine). */
  initiativeLine: number[] = [];

  /** Index of the unit whose turn it currently is. -1 means not started. */
  currentIdx: number = -1;

  /** Whether to draw the initiative bar UI. */
  drawMe: boolean = true;

  /** Clear all data. */
  clear(): void {
    this.unitLine = [];
    this.initiativeLine = [];
    this.currentIdx = -1;
  }

  /** Check if we're at the start of the initiative cycle. */
  atStart(): boolean {
    return this.currentIdx === 0 || this.currentIdx === -1;
  }

  /** Advance to the next unit in initiative order. Wraps around. */
  next(): void {
    this.currentIdx++;
    if (this.currentIdx >= this.unitLine.length) {
      this.currentIdx = 0;
    }
  }

  /** Go back to the previous unit in initiative order. Wraps around. */
  back(): void {
    this.currentIdx--;
    if (this.currentIdx < 0) {
      this.currentIdx = this.unitLine.length - 1;
    }
  }

  /**
   * Sort all units by initiative (descending) and build the initiative line.
   * Called when the initiative system is first initialized for a level.
   */
  start(units: UnitObject[], db: Database): void {
    const sorted = [...units].sort((a, b) => {
      return getInitiative(b, db) - getInitiative(a, db);
    });
    this.unitLine = sorted.map(u => u.nid);
    this.initiativeLine = sorted.map(u => getInitiative(u, db));
    this.currentIdx = -1;
  }

  /** Get the NID of the unit whose turn it currently is, or null. */
  getCurrentUnitNid(): string | null {
    if (this.currentIdx < 0 || this.currentIdx >= this.unitLine.length) {
      return null;
    }
    return this.unitLine[this.currentIdx] ?? null;
  }

  /** Get the NID of the next unit in initiative order, or null. */
  getNextUnitNid(): string | null {
    if (this.unitLine.length === 0) return null;
    let nextIdx = this.currentIdx + 1;
    if (nextIdx >= this.unitLine.length) nextIdx = 0;
    return this.unitLine[nextIdx] ?? null;
  }

  /** Get the NID of the previous unit in initiative order, or null. */
  getPreviousUnitNid(): string | null {
    if (this.unitLine.length === 0) return null;
    let prevIdx = this.currentIdx - 1;
    if (prevIdx < 0) prevIdx = this.unitLine.length - 1;
    return this.unitLine[prevIdx] ?? null;
  }

  /** Get the initiative value for a given unit NID, or undefined. */
  getInitiativeForUnit(unitNid: string): number | undefined {
    const idx = this.unitLine.indexOf(unitNid);
    if (idx === -1) return undefined;
    return this.initiativeLine[idx];
  }

  /** Get the index of a unit in the initiative line, or undefined. */
  getIndex(unitNid: string): number | undefined {
    const idx = this.unitLine.indexOf(unitNid);
    return idx === -1 ? undefined : idx;
  }

  /**
   * Insert a unit into the initiative line at the correct position
   * based on their initiative value (binary insert, descending order).
   */
  insertUnit(unit: UnitObject, db: Database): void {
    const initiative = getInitiative(unit, db);
    // Binary search for insertion point (descending order)
    let lo = 0;
    let hi = this.initiativeLine.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.initiativeLine[mid] >= initiative) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    this.unitLine.splice(lo, 0, unit.nid);
    this.initiativeLine.splice(lo, 0, initiative);

    // If inserted before or at the current index, shift currentIdx
    if (lo <= this.currentIdx && this.currentIdx >= 0) {
      this.currentIdx++;
    }
  }

  /** Remove a unit from the initiative line. */
  removeUnit(unit: UnitObject): void {
    const idx = this.unitLine.indexOf(unit.nid);
    if (idx === -1) return;

    this.unitLine.splice(idx, 1);
    this.initiativeLine.splice(idx, 1);

    // Adjust currentIdx
    if (idx < this.currentIdx) {
      this.currentIdx--;
    } else if (idx === this.currentIdx) {
      // Current unit was removed; keep index the same (points to next unit)
      // but clamp to valid range
      if (this.currentIdx >= this.unitLine.length) {
        this.currentIdx = 0;
      }
    }
  }

  /** Replace a unit NID in the initiative line (e.g., after transformation). */
  replaceUnitNid(oldNid: string, newNid: string): void {
    const idx = this.unitLine.indexOf(oldNid);
    if (idx !== -1) {
      this.unitLine[idx] = newNid;
    }
  }

  /**
   * Insert a unit at a specific index with an optional initiative value.
   * Returns the actual index where the unit was inserted.
   */
  insertAt(unitNid: string, idx: number, initiative?: number): number {
    const clampedIdx = Math.max(0, Math.min(idx, this.unitLine.length));
    this.unitLine.splice(clampedIdx, 0, unitNid);
    this.initiativeLine.splice(clampedIdx, 0, initiative ?? 0);

    // Adjust currentIdx
    if (clampedIdx <= this.currentIdx && this.currentIdx >= 0) {
      this.currentIdx++;
    }

    return clampedIdx;
  }

  /** Append a unit to the end of the initiative line. */
  appendUnit(unitNid: string, initiative: number): void {
    this.unitLine.push(unitNid);
    this.initiativeLine.push(initiative);
  }

  /** Remove the last unit from the initiative line. */
  popUnit(): void {
    if (this.unitLine.length === 0) return;
    this.unitLine.pop();
    this.initiativeLine.pop();
    // Clamp currentIdx
    if (this.currentIdx >= this.unitLine.length) {
      this.currentIdx = Math.max(0, this.unitLine.length - 1);
    }
  }

  /** Toggle the draw flag for the initiative bar UI. */
  toggleDraw(): void {
    this.drawMe = !this.drawMe;
  }
}
