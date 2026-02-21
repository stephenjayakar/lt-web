import type { UnitObject } from '../objects/unit';
import type { ItemObject } from '../objects/item';
import type { GameBoard } from '../objects/game-board';

/**
 * Action - Base class for all undoable game actions.
 * Implements the Command pattern for turnwheel support.
 *
 * Every concrete action must implement execute() to apply the action and
 * reverse() to undo it. The ActionLog records executed actions so the
 * turnwheel can step backwards through them.
 */
export abstract class Action {
  abstract execute(): void;
  abstract reverse(): void;
}

/**
 * ActionLog - Ordered log of executed actions supporting sequential undo.
 */
export class ActionLog {
  private log: Action[] = [];

  /** Execute an action and record it in the log. */
  record(action: Action): void {
    action.execute();
    this.log.push(action);
  }

  /** Undo the most recent action and remove it from the log. */
  undo(): Action | null {
    const action = this.log.pop();
    if (!action) return null;
    action.reverse();
    return action;
  }

  /** Clear all recorded actions. */
  clear(): void {
    this.log.length = 0;
  }

  /** Get the number of recorded actions. */
  getLength(): number {
    return this.log.length;
  }
}

// ------------------------------------------------------------------
// Concrete actions
// ------------------------------------------------------------------

/**
 * MoveAction - Move a unit from one position to another on the board.
 */
export class MoveAction extends Action {
  private unit: UnitObject;
  private oldPos: [number, number];
  private newPos: [number, number];
  private board: GameBoard;

  constructor(
    unit: UnitObject,
    oldPos: [number, number],
    newPos: [number, number],
    board: GameBoard,
  ) {
    super();
    this.unit = unit;
    this.oldPos = oldPos;
    this.newPos = newPos;
    this.board = board;
  }

  execute(): void {
    this.board.moveUnit(this.unit, this.newPos[0], this.newPos[1]);
    this.unit.hasMoved = true;
  }

  reverse(): void {
    this.board.moveUnit(this.unit, this.oldPos[0], this.oldPos[1]);
    this.unit.hasMoved = false;
  }
}

/**
 * DamageAction - Apply damage to a unit (reduce currentHp).
 * Clamps HP to a minimum of 0.
 */
export class DamageAction extends Action {
  private unit: UnitObject;
  private amount: number;

  constructor(unit: UnitObject, amount: number) {
    super();
    this.unit = unit;
    this.amount = amount;
  }

  execute(): void {
    this.unit.currentHp = Math.max(0, this.unit.currentHp - this.amount);
    if (this.unit.currentHp <= 0) {
      this.unit.dead = true;
    }
  }

  reverse(): void {
    if (this.unit.currentHp <= 0 && this.amount > 0) {
      this.unit.dead = false;
    }
    this.unit.currentHp = Math.min(this.unit.maxHp, this.unit.currentHp + this.amount);
  }
}

/**
 * HealAction - Heal a unit (increase currentHp, capped at maxHp).
 */
export class HealAction extends Action {
  private unit: UnitObject;
  private amount: number;

  constructor(unit: UnitObject, amount: number) {
    super();
    this.unit = unit;
    this.amount = amount;
  }

  execute(): void {
    this.unit.currentHp = Math.min(this.unit.maxHp, this.unit.currentHp + this.amount);
  }

  reverse(): void {
    this.unit.currentHp = Math.max(0, this.unit.currentHp - this.amount);
  }
}

/**
 * HasAttackedAction - Mark a unit as having attacked this turn.
 */
export class HasAttackedAction extends Action {
  private unit: UnitObject;

  constructor(unit: UnitObject) {
    super();
    this.unit = unit;
  }

  execute(): void {
    this.unit.hasAttacked = true;
  }

  reverse(): void {
    this.unit.hasAttacked = false;
  }
}

/**
 * WaitAction - Mark a unit as finished for the turn.
 */
export class WaitAction extends Action {
  private unit: UnitObject;

  constructor(unit: UnitObject) {
    super();
    this.unit = unit;
  }

  execute(): void {
    this.unit.finished = true;
  }

  reverse(): void {
    this.unit.finished = false;
  }
}

/**
 * ResetAllAction - Reset turn state for all provided units.
 * Used at the start of a new phase to clear hasAttacked/hasMoved/finished flags.
 *
 * Saves per-unit state before resetting so reverse() can restore it.
 */
export class ResetAllAction extends Action {
  private units: UnitObject[];
  private savedStates: {
    hasAttacked: boolean;
    hasMoved: boolean;
    hasTraded: boolean;
    finished: boolean;
  }[] = [];

  constructor(units: UnitObject[]) {
    super();
    this.units = units;
  }

  execute(): void {
    // Save current state before resetting so reverse can restore it
    this.savedStates = this.units.map((u) => ({
      hasAttacked: u.hasAttacked,
      hasMoved: u.hasMoved,
      hasTraded: u.hasTraded,
      finished: u.finished,
    }));

    for (const unit of this.units) {
      unit.resetTurnState();
    }
  }

  reverse(): void {
    // Restore saved state
    for (let i = 0; i < this.units.length; i++) {
      const saved = this.savedStates[i];
      if (saved) {
        this.units[i].hasAttacked = saved.hasAttacked;
        this.units[i].hasMoved = saved.hasMoved;
        this.units[i].hasTraded = saved.hasTraded;
        this.units[i].finished = saved.finished;
      }
    }
  }
}

// ------------------------------------------------------------------
// Phase 1.2 actions
// ------------------------------------------------------------------

/**
 * GainExpAction - Grant EXP to a unit, with possible level-up.
 * On execute, adds EXP and performs level-ups.
 * On reverse, removes EXP and undoes stat gains.
 */
export class GainExpAction extends Action {
  private unit: UnitObject;
  private amount: number;
  private growthMode: string;

  /** Level-ups that occurred (for reversal). */
  private levelUps: Record<string, number>[] = [];
  private startExp: number = 0;
  private startLevel: number = 0;

  constructor(unit: UnitObject, amount: number, growthMode: string = 'random') {
    super();
    this.unit = unit;
    this.amount = amount;
    this.growthMode = growthMode;
  }

  execute(): void {
    this.startExp = this.unit.exp;
    this.startLevel = this.unit.level;
    this.levelUps = [];

    this.unit.exp += this.amount;
    while (this.unit.exp >= 100) {
      this.unit.exp -= 100;
      const gains = this.unit.levelUp(this.growthMode);
      this.levelUps.push(gains);
    }
  }

  reverse(): void {
    // Undo level-ups in reverse order
    for (let i = this.levelUps.length - 1; i >= 0; i--) {
      const gains = this.levelUps[i];
      for (const [stat, amount] of Object.entries(gains)) {
        if (amount > 0 && this.unit.stats[stat] !== undefined) {
          this.unit.stats[stat] -= amount;
          if (stat === 'HP') {
            this.unit.currentHp = Math.min(this.unit.currentHp, this.unit.maxHp);
          }
        }
      }
    }
    this.unit.exp = this.startExp;
    this.unit.level = this.startLevel;
  }

  /** Get the stat gains from level-ups (for display). */
  getLevelUps(): Record<string, number>[] {
    return this.levelUps;
  }

  getExpGained(): number {
    return this.amount;
  }
}

/**
 * UseItemAction - Use a consumable item (healing, stat booster, etc.).
 */
export class UseItemAction extends Action {
  private unit: UnitObject;
  private item: ItemObject;
  private hpBefore: number = 0;
  private statsBefore: Record<string, number> = {};
  private usesBefore: number = 0;
  private broken: boolean = false;

  constructor(unit: UnitObject, item: ItemObject) {
    super();
    this.unit = unit;
    this.item = item;
  }

  execute(): void {
    this.hpBefore = this.unit.currentHp;
    this.usesBefore = this.item.uses;
    this.statsBefore = { ...this.unit.stats };

    if (this.item.isHealing()) {
      const heal = this.item.getHealAmount();
      this.unit.currentHp = Math.min(this.unit.maxHp, this.unit.currentHp + heal);
    }

    if (this.item.isStatBooster()) {
      const changes = this.item.getStatChanges();
      for (const [stat, amount] of Object.entries(changes)) {
        if (this.unit.stats[stat] !== undefined) {
          this.unit.stats[stat] += amount;
        }
      }
    }

    this.broken = this.item.decrementUses();

    // Remove broken items from inventory
    if (this.broken) {
      const idx = this.unit.items.indexOf(this.item);
      if (idx !== -1) {
        this.unit.items.splice(idx, 1);
      }
    }
  }

  reverse(): void {
    // Re-add broken item
    if (this.broken) {
      this.unit.items.push(this.item);
    }

    this.item.uses = this.usesBefore;
    this.unit.currentHp = this.hpBefore;
    this.unit.stats = this.statsBefore;
  }
}

/**
 * TradeAction - Swap items between two units.
 */
export class TradeAction extends Action {
  private unitA: UnitObject;
  private unitB: UnitObject;
  private indexA: number;
  private indexB: number;

  constructor(
    unitA: UnitObject,
    indexA: number,
    unitB: UnitObject,
    indexB: number,
  ) {
    super();
    this.unitA = unitA;
    this.indexA = indexA;
    this.unitB = unitB;
    this.indexB = indexB;
  }

  execute(): void {
    const itemA = this.unitA.items[this.indexA];
    const itemB = this.unitB.items[this.indexB];

    if (itemA && itemB) {
      // Swap
      this.unitA.items[this.indexA] = itemB;
      this.unitB.items[this.indexB] = itemA;
      itemA.owner = this.unitB;
      itemB.owner = this.unitA;
    } else if (itemA && !itemB) {
      // Move A to B
      this.unitA.items.splice(this.indexA, 1);
      this.unitB.items.push(itemA);
      itemA.owner = this.unitB;
    } else if (!itemA && itemB) {
      // Move B to A
      this.unitB.items.splice(this.indexB, 1);
      this.unitA.items.push(itemB);
      itemB.owner = this.unitA;
    }

    this.unitA.hasTraded = true;
    this.unitB.hasTraded = true;
  }

  reverse(): void {
    // This is complex to reverse perfectly; for now, swap back
    const itemA = this.unitA.items[this.indexA];
    const itemB = this.unitB.items[this.indexB];

    if (itemA && itemB) {
      this.unitA.items[this.indexA] = itemB;
      this.unitB.items[this.indexB] = itemA;
      itemA.owner = this.unitB;
      itemB.owner = this.unitA;
    }

    this.unitA.hasTraded = false;
    this.unitB.hasTraded = false;
  }
}

/**
 * RescueAction - One unit rescues another.
 * The rescued unit is removed from the board and carried by the rescuer.
 */
export class RescueAction extends Action {
  private rescuer: UnitObject;
  private target: UnitObject;
  private board: GameBoard;
  private targetPos: [number, number] | null = null;

  constructor(rescuer: UnitObject, target: UnitObject, board: GameBoard) {
    super();
    this.rescuer = rescuer;
    this.target = target;
    this.board = board;
  }

  execute(): void {
    this.targetPos = this.target.position ? [...this.target.position] as [number, number] : null;

    // Remove target from board
    this.board.removeUnit(this.target);

    // Set rescue references
    this.rescuer.rescuing = this.target;
    this.target.rescuedBy = this.rescuer;
  }

  reverse(): void {
    this.rescuer.rescuing = null;
    this.target.rescuedBy = null;

    // Place target back on board
    if (this.targetPos) {
      this.board.setUnit(this.targetPos[0], this.targetPos[1], this.target);
    }
  }
}

/**
 * DropAction - Drop a rescued unit onto an adjacent tile.
 */
export class DropAction extends Action {
  private rescuer: UnitObject;
  private target: UnitObject;
  private board: GameBoard;
  private dropPos: [number, number];

  constructor(
    rescuer: UnitObject,
    target: UnitObject,
    board: GameBoard,
    dropPos: [number, number],
  ) {
    super();
    this.rescuer = rescuer;
    this.target = target;
    this.board = board;
    this.dropPos = dropPos;
  }

  execute(): void {
    this.rescuer.rescuing = null;
    this.target.rescuedBy = null;

    // Place target on the board at drop position
    this.board.setUnit(this.dropPos[0], this.dropPos[1], this.target);
  }

  reverse(): void {
    this.board.removeUnit(this.target);
    this.rescuer.rescuing = this.target;
    this.target.rescuedBy = this.rescuer;
  }
}

/**
 * DeathAction - Handle unit death (remove from board, mark as dead).
 * Preserves position for turnwheel reversal.
 */
export class DeathAction extends Action {
  private unit: UnitObject;
  private board: GameBoard;
  private position: [number, number] | null = null;
  private wasDead: boolean = false;

  constructor(unit: UnitObject, board: GameBoard) {
    super();
    this.unit = unit;
    this.board = board;
  }

  execute(): void {
    this.wasDead = this.unit.dead;
    this.position = this.unit.position ? [...this.unit.position] as [number, number] : null;

    this.unit.dead = true;
    this.board.removeUnit(this.unit);
  }

  reverse(): void {
    this.unit.dead = this.wasDead;
    if (this.position) {
      this.board.setUnit(this.position[0], this.position[1], this.unit);
    }
  }
}

/**
 * WeaponUsesAction - Decrement weapon uses after combat.
 */
export class WeaponUsesAction extends Action {
  private item: ItemObject;
  private unit: UnitObject;
  private usesBefore: number = 0;
  private broken: boolean = false;

  constructor(item: ItemObject, unit: UnitObject) {
    super();
    this.item = item;
    this.unit = unit;
  }

  execute(): void {
    this.usesBefore = this.item.uses;
    this.broken = this.item.decrementUses();

    // Remove broken weapons from inventory
    if (this.broken) {
      const idx = this.unit.items.indexOf(this.item);
      if (idx !== -1) {
        this.unit.items.splice(idx, 1);
      }
    }
  }

  reverse(): void {
    if (this.broken) {
      this.unit.items.push(this.item);
    }
    this.item.uses = this.usesBefore;
  }
}
