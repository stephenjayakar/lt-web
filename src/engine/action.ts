import type { UnitObject } from '../objects/unit';
import type { ItemObject } from '../objects/item';
import { SkillObject } from '../objects/skill';
import type { GameBoard } from '../objects/game-board';
import type { Database } from '../data/database';
import { evaluateEquation } from '../combat/combat-calcs';
import { onPairup, onRemoveRescue, onRescue, onSeparate } from '../combat/skill-system';
import { autoLevelUnit } from './leveling';
import type { InitiativeTracker } from './initiative';

// Forward declare — we need a getter function since game-state has circular deps
let _getGame: (() => any) | null = null;
export function setActionGameRef(getter: () => any): void { _getGame = getter; }

/**
 * Action - Base class for all undoable game actions.
 * Implements the Command pattern for turnwheel support.
 *
 * Every concrete action must implement execute() to apply the action and
 * reverse() to undo it. The ActionLog records executed actions so the
 * turnwheel can step backwards through them.
 *
 * In the Python engine, actions have both do() and execute():
 *   - do() is called during normal gameplay
 *   - execute() is called when the turnwheel replays forward
 *   - reverse() is called when the turnwheel rewinds backward
 * For this port, execute() serves both purposes since do() and execute()
 * are identical for nearly all actions.
 */
export abstract class Action {
  /**
   * If true, this action persists through menu cancel (BACK in MenuState).
   * Used for equip changes that should not be undone on move cancel.
   */
  persistThroughMenuCancel: boolean = false;

  abstract execute(): void;
  abstract reverse(): void;
}

// ------------------------------------------------------------------
// Turnwheel marker actions
// ------------------------------------------------------------------

/**
 * MarkActionGroupStart - Marks the start of a unit's turn action group.
 * Recorded when a unit is selected in FreeState.
 */
export class MarkActionGroupStart extends Action {
  unit: UnitObject;
  stateName: string;

  constructor(unit: UnitObject, stateName: string) {
    super();
    this.unit = unit;
    this.stateName = stateName;
  }

  execute(): void { /* Marker only — no game state change */ }
  reverse(): void { /* Marker only — no game state change */ }
}

/**
 * MarkActionGroupEnd - Marks the end of a unit's turn action group.
 * Recorded when a unit waits or FreeState begins (ending previous group).
 */
export class MarkActionGroupEnd extends Action {
  stateName: string;

  constructor(stateName: string) {
    super();
    this.stateName = stateName;
  }

  execute(): void { /* Marker only */ }
  reverse(): void { /* Marker only */ }
}

/**
 * MarkPhase - Marks a phase change in the action log.
 * Used by the turnwheel to show "Start of X phase" messages.
 */
export class MarkPhase extends Action {
  phaseName: string;

  constructor(phaseName: string) {
    super();
    this.phaseName = phaseName;
  }

  execute(): void { /* Marker only */ }
  reverse(): void { /* Marker only */ }
}

/**
 * LockTurnwheel - Marks a turnwheel lock/unlock point.
 * When locked, the turnwheel cannot be activated at this point.
 * Non-player phases lock the turnwheel.
 */
export class LockTurnwheel extends Action {
  lock: boolean;

  constructor(lock: boolean) {
    super();
    this.lock = lock;
  }

  execute(): void { /* Marker only — lock state handled by ActionLog navigation */ }
  reverse(): void { /* Marker only */ }
}

/**
 * MessageAction - Stores a text description in the action log.
 * Used by the turnwheel display to show what happened during a unit's turn
 * (e.g., "Eirika attacked Fighter").
 */
export class MessageAction extends Action {
  message: string;

  constructor(message: string) {
    super();
    this.message = message;
  }

  execute(): void { /* Marker only */ }
  reverse(): void { /* Marker only */ }
}

/** Reversible persistent game-variable assignment, matching LT SetGameVar. */
export class SetGameVarAction extends Action {
  private gameVars: Map<string, any>;
  private nid: string;
  private value: any;
  private alreadyExists: boolean;
  private oldValue: any;

  constructor(gameVars: Map<string, any>, nid: string, value: any) {
    super();
    this.gameVars = gameVars;
    this.nid = nid;
    this.value = value;
    this.alreadyExists = gameVars.has(nid);
    this.oldValue = gameVars.get(nid);
  }

  execute(): void {
    this.gameVars.set(this.nid, this.value);
  }

  reverse(): void {
    if (this.alreadyExists) {
      this.gameVars.set(this.nid, this.oldValue);
    } else {
      this.gameVars.delete(this.nid);
    }
  }
}

// ------------------------------------------------------------------
// Action group types for turnwheel navigation
// ------------------------------------------------------------------

/** A unit's complete turn (from selection to wait/death). */
interface MoveGroup {
  type: 'move';
  unit: UnitObject;
  begin: number; // action index of MarkActionGroupStart
  end: number;   // action index of MarkActionGroupEnd (or begin if no end)
}

/** A phase transition marker. */
interface PhaseGroup {
  type: 'phase';
  phaseName: string;
  actionIndex: number;
}

/** Extra trailing actions not part of a unit move (equip changes, etc.). */
interface ExtraGroup {
  type: 'extra';
  lastMoveIndex: number;
  actionIndex: number;
}

type ActionGroup = MoveGroup | PhaseGroup | ExtraGroup;

/**
 * ActionLog - Ordered log of executed actions supporting sequential undo
 * and turnwheel (Divine Pulse) navigation.
 *
 * Faithful port of Python's ActionLog from app/engine/turnwheel.py.
 */
export class ActionLog {
  /** All recorded actions in chronological order. */
  private actions: Action[] = [];

  /**
   * Current position in the action log.
   * -1 means no actions. Points to the last executed action.
   */
  actionIndex: number = -1;

  /**
   * How far back the turnwheel can go. Actions at or before this index
   * cannot be undone. Set at the start of the first player phase.
   */
  private _firstFreeAction: number = -1;

  /** Whether the turnwheel is currently locked (can't confirm at this point). */
  locked: boolean = false;

  /**
   * Recording counter. 0 means currently recording.
   * Incremented by stopRecording(), decremented by startRecording().
   * Multiple systems can pause recording (saving, events, turnwheel itself).
   */
  private _record: number = 0;

  /**
   * Depth of nested action.do() calls. Only the outermost (depth 0)
   * action gets appended to the log. Inner actions called by outer
   * actions are NOT separately recorded.
   */
  actionDepth: number = 0;

  // -- Turnwheel navigation state --
  /** Unit currently being hovered by the turnwheel. */
  hoveredUnit: UnitObject | null = null;
  /** Unit whose action group is currently being navigated. */
  currentUnit: UnitObject | null = null;
  /** Pre-computed action groups for turnwheel navigation. */
  private actionGroups: ActionGroup[] = [];
  /** Current position in the action groups array. */
  private currentMoveIndex: number = 0;

  // -----------------------------------------------------------------
  // Recording control
  // -----------------------------------------------------------------

  isRecording(): boolean {
    return this._record <= 0;
  }

  stopRecording(): void {
    this._record += 1;
  }

  startRecording(): void {
    this._record -= 1;
  }

  // -----------------------------------------------------------------
  // Core action management
  // -----------------------------------------------------------------

  /**
   * Execute an action and record it in the log.
   * This is the primary way to record actions during gameplay.
   * Matches Python's `action.do()` module-level function.
   */
  doAction(action: Action): void {
    this.actionDepth += 1;
    action.execute();
    this.actionDepth -= 1;
    if (this.isRecording() && this.actionDepth <= 0) {
      this.append(action);
    }
  }

  /** Append an action to the log (already executed). */
  private append(action: Action): void {
    this.actions.push(action);
    this.actionIndex += 1;
  }

  /** Remove a specific action from the log (used internally). */
  private removeAction(action: Action): void {
    const idx = this.actions.indexOf(action);
    if (idx !== -1) {
      this.actions.splice(idx, 1);
      this.actionIndex -= 1;
    }
  }

  /**
   * Reverse and remove an action and all actions after it,
   * except those with persistThroughMenuCancel.
   * Used when the player cancels a move in MenuState.
   */
  hardRemove(action: Action): void {
    const idx = this.actions.indexOf(action);
    if (idx === -1) return;
    const toProcess = this.actions.slice(idx).reverse();
    for (const act of toProcess) {
      if (act.persistThroughMenuCancel) {
        continue;
      }
      act.reverse();
      this.removeAction(act);
    }
  }

  /**
   * When the player cancels a move (BACK in MenuState), also remove
   * the hanging MarkActionGroupStart marker that preceded the move.
   */
  reverseMoveToActionGroupStart(moveAction: Action): void {
    this.hardRemove(moveAction);
    // Walk backwards from the end to find the MarkActionGroupStart
    let counter = this.actions.length - 1;
    while (counter >= 0) {
      const topAction = this.actions[counter];
      if (topAction instanceof MarkActionGroupStart) {
        topAction.reverse();
        this.removeAction(topAction);
        break;
      } else if (topAction.persistThroughMenuCancel) {
        counter--;
      } else {
        break;
      }
    }
  }

  /** Legacy record() method — execute + append. */
  record(action: Action): void {
    action.execute();
    this.actions.push(action);
    this.actionIndex += 1;
  }

  /** Undo the most recent action and remove it from the log. */
  undo(): Action | null {
    if (this.actions.length === 0) return null;
    const action = this.actions.pop()!;
    this.actionIndex -= 1;
    action.reverse();
    return action;
  }

  /** Clear all recorded actions. */
  clear(): void {
    this.actions.length = 0;
    this.actionIndex = -1;
    this._firstFreeAction = -1;
    this.locked = false;
    this._record = 0;
    this.actionDepth = 0;
    this.hoveredUnit = null;
    this.currentUnit = null;
    this.actionGroups = [];
    this.currentMoveIndex = 0;
  }

  /** Get the number of recorded actions. */
  getLength(): number {
    return this.actions.length;
  }

  // -----------------------------------------------------------------
  // Turnwheel navigation
  // -----------------------------------------------------------------

  /**
   * Build action groups and initialize turnwheel navigation.
   * Called when the turnwheel state begins.
   * Returns the description text for the current position.
   */
  setUp(): string[] {
    this.actionGroups = ActionLog.getActionGroups(this.actions, this._firstFreeAction);
    this.currentMoveIndex = this.actionGroups.length;

    // Determine starting lock state
    this.locked = this.getLastLock();

    // Get the text message for the current position
    for (let i = this.actionGroups.length - 1; i >= 0; i--) {
      const move = this.actionGroups[i];
      if (move.type === 'move') {
        if (move.end >= 0) {
          return this.getUnitTurn(move.unit, move.end);
        }
        return [];
      } else if (move.type === 'phase') {
        return [`Start of ${capitalize(move.phaseName)} phase`];
      }
    }
    return [];
  }

  /**
   * Build the action groups list from a sequence of actions.
   * Static so it can be tested independently.
   */
  static getActionGroups(actions: Action[], firstFreeAction: number): ActionGroup[] {
    const groups: ActionGroup[] = [];

    function finalizeGroup(group: ActionGroup): void {
      if (group.type === 'move' && group.end < 0) {
        group.end = group.begin;
      }
      groups.push(group);
    }

    let currentMove: MoveGroup | null = null;

    for (let i = Math.max(0, firstFreeAction); i < actions.length; i++) {
      const action = actions[i];
      if (action instanceof MarkActionGroupStart) {
        if (currentMove) {
          finalizeGroup(currentMove);
        }
        currentMove = { type: 'move', unit: action.unit, begin: i, end: -1 };
      } else if (action instanceof MarkActionGroupEnd) {
        if (currentMove) {
          currentMove.end = i;
          finalizeGroup(currentMove);
          currentMove = null;
        }
      } else if (action instanceof MarkPhase) {
        if (currentMove) {
          finalizeGroup(currentMove);
          currentMove = null;
        }
        groups.push({ type: 'phase', phaseName: action.phaseName, actionIndex: i });
      }
    }

    // Finalize any hanging move
    if (currentMove) {
      finalizeGroup(currentMove);
      currentMove = null;
    }

    // Handle extra trailing actions not part of a move
    if (groups.length > 0) {
      const lastGroup = groups[groups.length - 1];
      const lastActionIndex = actions.length - 1;
      if (lastGroup.type === 'move') {
        if (lastGroup.end < lastActionIndex) {
          groups.push({ type: 'extra', lastMoveIndex: lastGroup.end + 1, actionIndex: lastActionIndex });
        }
      } else if (lastGroup.type === 'phase') {
        if (lastGroup.actionIndex < lastActionIndex) {
          groups.push({ type: 'extra', lastMoveIndex: lastGroup.actionIndex + 1, actionIndex: lastActionIndex });
        }
      }
    }

    return groups;
  }

  /**
   * Navigate backward through action groups.
   * Returns description text, or null if at the far past.
   */
  backward(cursorSetPos: (pos: [number, number]) => void): string[] | null {
    if (this.currentMoveIndex < 1) {
      return null;
    }

    const currentMove = this.actionGroups[this.currentMoveIndex - 1];
    this.currentMoveIndex -= 1;

    if (currentMove.type === 'move') {
      if (this.currentUnit) {
        // Second step: undo remaining actions back to the start of this group
        while (this.actionIndex >= currentMove.begin) {
          this.runActionBackward();
        }
        if (this.currentUnit.position) {
          cursorSetPos(this.currentUnit.position);
        }
        this.currentUnit = null;
        return [];
      } else {
        // First step: undo to the end of this group and show the unit
        this.hoverOff();
        this.currentUnit = currentMove.unit;
        if (currentMove.end >= 0) {
          while (this.actionIndex > currentMove.end) {
            this.runActionBackward();
          }
          let prevAction: Action | null = null;
          if (this.actionIndex >= 0) {
            prevAction = this.actions[this.actionIndex];
          }
          if (this.currentUnit.position) {
            cursorSetPos(this.currentUnit.position);
          } else if (prevAction instanceof DeathAction && (prevAction as any).position) {
            cursorSetPos((prevAction as any).position);
          }
          this.hoverOn(this.currentUnit);
          const textList = this.getUnitTurn(this.currentUnit, this.actionIndex);
          this.currentMoveIndex += 1; // Don't skip second half
          return textList;
        } else {
          while (this.actionIndex >= currentMove.begin) {
            this.runActionBackward();
          }
          if (this.currentUnit.position) {
            cursorSetPos(this.currentUnit.position);
          }
          this.hoverOn(this.currentUnit);
          return [];
        }
      }
    } else if (currentMove.type === 'phase') {
      while (this.actionIndex > currentMove.actionIndex) {
        this.runActionBackward();
      }
      this.hoverOff();
      return [`Start of ${capitalize(currentMove.phaseName)} phase`];
    } else if (currentMove.type === 'extra') {
      while (this.actionIndex >= currentMove.lastMoveIndex) {
        this.runActionBackward();
      }
      return this.backward(cursorSetPos); // Skip through extras
    }

    return null;
  }

  /**
   * Navigate forward through action groups.
   * Returns description text, or null if at the far future.
   */
  forward(cursorSetPos: (pos: [number, number]) => void): string[] | null {
    if (this.currentMoveIndex >= this.actionGroups.length) {
      return null;
    }

    const currentMove = this.actionGroups[this.currentMoveIndex];
    this.currentMoveIndex += 1;

    if (currentMove.type === 'move') {
      if (this.currentUnit) {
        // Second step: execute forward to the end of this group
        while (this.actionIndex < currentMove.end) {
          this.runActionForward();
        }
        if (this.currentUnit.position) {
          cursorSetPos(this.currentUnit.position);
        }
        const textList = this.getUnitTurn(this.currentUnit, this.actionIndex);
        this.currentUnit = null;
        // Skip extra groups that follow
        if (this.currentMoveIndex < this.actionGroups.length) {
          const nextMove = this.actionGroups[this.currentMoveIndex];
          if (nextMove.type === 'extra') {
            this.currentMoveIndex += 1;
            while (this.actionIndex < nextMove.lastMoveIndex) {
              this.runActionForward();
            }
          }
        }
        return textList;
      } else {
        // First step: show the unit at start position
        this.hoverOff();
        this.currentUnit = currentMove.unit;
        while (this.actionIndex < currentMove.begin - 1) {
          this.runActionForward();
        }
        if (this.currentUnit.position) {
          cursorSetPos(this.currentUnit.position);
        }
        this.hoverOn(this.currentUnit);
        this.currentMoveIndex -= 1; // Don't skip second half
        return [];
      }
    } else if (currentMove.type === 'phase') {
      while (this.actionIndex < currentMove.actionIndex) {
        this.runActionForward();
      }
      this.hoverOff();
      return [`Start of ${capitalize(currentMove.phaseName)} phase`];
    } else if (currentMove.type === 'extra') {
      while (this.actionIndex < currentMove.lastMoveIndex) {
        this.runActionForward();
      }
      return [];
    }

    return null;
  }

  /**
   * Finalize: remove all actions after the current position.
   * Called when the player confirms the turnwheel rewind.
   */
  finalize(): void {
    this.currentUnit = null;
    this.hoverOff();
    this.actions = this.actions.slice(0, this.actionIndex + 1);
  }

  /**
   * Reset: replay all undone actions forward to restore original state.
   * Called when the player cancels the turnwheel.
   */
  reset(): void {
    this.currentUnit = null;
    this.hoverOff();
    while (!this.atFarFuture()) {
      this.runActionForward();
    }
  }

  // -----------------------------------------------------------------
  // Turnwheel query methods
  // -----------------------------------------------------------------

  /** True if actions have been undone (we're not at the latest point). */
  isTurnedBack(): boolean {
    return this.actionIndex + 1 < this.actions.length;
  }

  /** True if the turnwheel can be confirmed at the current position. */
  canUse(): boolean {
    return this.isTurnedBack() && !this.locked;
  }

  /** True if we're at the earliest rewindable point. */
  atFarPast(): boolean {
    return this.actions.length === 0 || this.actionIndex <= this._firstFreeAction;
  }

  /** True if we're at the latest point (no undone actions). */
  atFarFuture(): boolean {
    return this.actions.length === 0 || this.actionIndex + 1 >= this.actions.length;
  }

  /** Set the first free action to the current index. */
  setFirstFreeAction(): void {
    this._firstFreeAction = this.actionIndex;
  }

  /** Get the current phase name by scanning backward through the log. */
  getCurrentPhase(): string {
    let idx = this.actionIndex;
    while (idx > 0) {
      idx -= 1;
      const action = this.actions[idx];
      if (action instanceof MarkPhase) {
        return action.phaseName;
      }
    }
    return 'player';
  }

  /**
   * Get description text for a unit's turn by scanning backward from
   * waitIndex looking for MessageAction entries until a MoveAction is found.
   */
  getUnitTurn(unit: UnitObject, waitIndex: number): string[] {
    const text: string[] = [];
    let idx = waitIndex;
    while (idx > this._firstFreeAction) {
      idx -= 1;
      if (idx < 0) break;
      const action = this.actions[idx];
      if (action instanceof MessageAction) {
        text.unshift(action.message);
      } else if (action instanceof MoveAction) {
        return text;
      }
    }
    return text;
  }

  /**
   * Get the current turn number by looking at the last MarkPhase
   * and counting how many player phases have occurred.
   */
  getCurrentTurnNumber(turnCount: number): number {
    // Simple approach: return the game's turn count
    // The Python engine uses game.turncount which is synced elsewhere
    return turnCount;
  }

  // -----------------------------------------------------------------
  // Private turnwheel helpers
  // -----------------------------------------------------------------

  /** Run one action backward (undo). */
  private runActionBackward(): Action {
    const action = this.actions[this.actionIndex];
    action.reverse();
    if (action instanceof LockTurnwheel) {
      this.locked = this.getLastLock();
    }
    this.actionIndex -= 1;
    return action;
  }

  /** Run one action forward (redo). */
  private runActionForward(): Action {
    this.actionIndex += 1;
    const action = this.actions[this.actionIndex];
    if (action instanceof LockTurnwheel) {
      this.locked = action.lock;
    }
    action.execute();
    return action;
  }

  /** Scan backward through the log to find the current lock state. */
  private getLastLock(): boolean {
    let idx = this.actionIndex;
    while (idx > 0) {
      idx -= 1;
      const action = this.actions[idx];
      if (action instanceof LockTurnwheel) {
        return action.lock;
      }
    }
    return false; // Assume not locked
  }

  private hoverOn(unit: UnitObject): void {
    this.hoveredUnit = unit;
  }

  private hoverOff(): void {
    this.hoveredUnit = null;
  }
}

/** Capitalize first letter of a string. */
function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
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

/** Script/item-directed warp that preserves the moved unit's turn flags. */
export class WarpUnitAction extends Action {
  private unit: UnitObject;
  private oldPos: [number, number];
  private newPos: [number, number];
  private board: GameBoard;

  constructor(unit: UnitObject, newPos: [number, number], board: GameBoard) {
    super();
    if (!unit.position) throw new Error(`Cannot warp off-map unit ${unit.nid}`);
    this.unit = unit;
    this.oldPos = [unit.position[0], unit.position[1]];
    this.newPos = [newPos[0], newPos[1]];
    this.board = board;
  }

  execute(): void {
    this.board.moveUnit(this.unit, this.newPos[0], this.newPos[1]);
  }

  reverse(): void {
    this.board.moveUnit(this.unit, this.oldPos[0], this.oldPos[1]);
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
  private previous: boolean = false;

  constructor(unit: UnitObject) {
    super();
    this.unit = unit;
  }

  execute(): void {
    this.previous = this.unit.hasAttacked;
    this.unit.hasAttacked = true;
  }

  reverse(): void {
    this.unit.hasAttacked = this.previous;
  }
}

/** Mark a unit as having traded/given this turn. */
export class HasTradedAction extends Action {
  private unit: UnitObject;
  private previous: boolean = false;

  constructor(unit: UnitObject) {
    super();
    this.unit = unit;
  }

  execute(): void {
    this.previous = this.unit.hasTraded;
    this.unit.hasTraded = true;
  }

  reverse(): void {
    this.unit.hasTraded = this.previous;
  }
}

/**
 * WaitAction - Mark a unit as finished for the turn.
 */
export class WaitAction extends Action {
  private unit: UnitObject;
  private previous: boolean = false;

  constructor(unit: UnitObject) {
    super();
    this.unit = unit;
  }

  execute(): void {
    this.previous = this.unit.finished;
    this.unit.finished = true;
  }

  reverse(): void {
    this.unit.finished = this.previous;
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

    this.item.setUses(this.usesBefore);
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
  private oldTraveler: string | null;
  private oldHasRescued: boolean;
  private penaltySkills: SkillObject[] = [];
  private initialized = false;

  constructor(rescuer: UnitObject, target: UnitObject, board: GameBoard) {
    super();
    this.rescuer = rescuer;
    this.target = target;
    this.board = board;
    this.oldTraveler = rescuer.traveler;
    this.oldHasRescued = rescuer.hasRescued;
  }
  execute(): void {
    this.targetPos = this.target.position ? [...this.target.position] as [number, number] : null;
    this.board.removeUnit(this.target);
    this.rescuer.rescuing = this.target;
    this.target.rescuedBy = this.rescuer;
    this.rescuer.traveler = this.target.nid;
    this.rescuer.hasRescued = true;
    if (!this.initialized) {
      this.penaltySkills = onRescue(this.rescuer, this.target, makeSkillForAction);
      this.initialized = true;
    } else {
      for (const skill of this.penaltySkills) {
        if (!this.rescuer.skills.includes(skill)) this.rescuer.skills.push(skill);
      }
    }
  }
  reverse(): void {
    for (const skill of this.penaltySkills) {
      const index = this.rescuer.skills.indexOf(skill);
      if (index >= 0) this.rescuer.skills.splice(index, 1);
    }
    this.rescuer.rescuing = null;
    this.target.rescuedBy = null;
    this.rescuer.traveler = this.oldTraveler;
    this.rescuer.hasRescued = this.oldHasRescued;
    if (this.targetPos) this.board.setUnit(this.targetPos[0], this.targetPos[1], this.target);
  }

}
function makeSkillForAction(nid: string): SkillObject | null {
  const game = _getGame?.();
  const prefab = game?.db?.skills?.get?.(nid);
  return prefab ? new SkillObject(prefab) : null;
}

type PairState = {
  traveler: string | null;
  rescuing: UnitObject | null;
  rescuedBy: UnitObject | null;
  leadUnit: boolean;
  gauge: number;
  hasRescued: boolean;
  hasDropped: boolean;
  hasTaken: boolean;
  hasGiven: boolean;
  builtGuard: boolean;
  strikePartner: UnitObject | null;
  hasAttacked: boolean;
  hasMoved: boolean;
  hasTraded: boolean;
  finished: boolean;
};

function pairState(unit: UnitObject): PairState {
  return {
    traveler: unit.traveler,
    rescuing: unit.rescuing,
    rescuedBy: unit.rescuedBy,
    leadUnit: unit.leadUnit,
    gauge: unit.getGuardGauge(),
    hasRescued: unit.hasRescued,
    hasDropped: unit.hasDropped,
    hasTaken: unit.hasTaken,
    hasGiven: unit.hasGiven,
    builtGuard: unit.builtGuard,
    strikePartner: unit.strikePartner,
    hasAttacked: unit.hasAttacked,
    hasMoved: unit.hasMoved,
    hasTraded: unit.hasTraded,
    finished: unit.finished,
  };
}

function restorePairState(unit: UnitObject, state: PairState): void {
  unit.traveler = state.traveler;
  unit.rescuing = state.rescuing;
  unit.rescuedBy = state.rescuedBy;
  unit.leadUnit = state.leadUnit;
  unit.currentGuardGauge = state.gauge;
  unit.hasRescued = state.hasRescued;
  unit.hasDropped = state.hasDropped;
  unit.hasTaken = state.hasTaken;
  unit.hasGiven = state.hasGiven;
  unit.builtGuard = state.builtGuard;
  unit.strikePartner = state.strikePartner;
  unit.hasAttacked = state.hasAttacked;
  unit.hasMoved = state.hasMoved;
  unit.hasTraded = state.hasTraded;
  unit.finished = state.finished;
}

type IndexedSkill = { skill: SkillObject; index: number };

function restoreIndexedSkills(unit: UnitObject, skills: IndexedSkill[]): void {
  for (const { skill, index } of [...skills].sort((a, b) => a.index - b.index)) {
    if (!unit.skills.includes(skill)) unit.skills.splice(Math.min(index, unit.skills.length), 0, skill);
  }
}

function getMaxGuardGauge(unit: UnitObject, db?: Database): number {
  const expression = db?.getEquation('MAX_GUARD');
  if (!expression) return 10;
  const value = evaluateEquation(expression, unit, { db });
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 10;
}

/** Pair a follower into a leader's guard stance. */
export class PairUpAction extends Action {
  private unit: UnitObject;
  private leader: UnitObject;
  private board: GameBoard;
  private oldPos: [number, number] | null;
  private oldUnit: PairState;
  private oldLeader: PairState;
  private db?: Database;
  private addedSkills: SkillObject[] = [];
  private initialized = false;

  constructor(unit: UnitObject, leader: UnitObject, board: GameBoard, db?: Database) {
    super();
    this.unit = unit;
    this.leader = leader;
    this.board = board;
    this.db = db;
    this.oldPos = unit.position ? [...unit.position] as [number, number] : null;
    this.oldUnit = pairState(unit);
    this.oldLeader = pairState(leader);
  }

  execute(): void {
    this.leader.traveler = this.unit.nid;
    this.leader.rescuing = this.unit;
    this.unit.rescuedBy = this.leader;
    if (this.unit.position) this.board.removeUnit(this.unit);
    // Python PairUp runs Reset on the follower while preserving its movement-left value.
    this.unit.resetTurnState();
    if (!this.initialized) {
      this.addedSkills = onPairup(this.unit, this.leader, makeSkillForAction);
      this.initialized = true;
    } else {
      for (const skill of this.addedSkills) if (!this.leader.skills.includes(skill)) this.leader.skills.push(skill);
    }
    this.unit.leadUnit = false;
    this.leader.leadUnit = true;
    this.leader.setGuardGauge(
      this.oldUnit.gauge + this.oldLeader.gauge,
      getMaxGuardGauge(this.leader, this.db),
    );
    this.unit.setGuardGauge(0, getMaxGuardGauge(this.unit, this.db));
  }

  reverse(): void {
    for (const skill of this.addedSkills) {
      const index = this.leader.skills.indexOf(skill);
      if (index >= 0) this.leader.skills.splice(index, 1);
    }
    if (this.oldPos) this.board.setUnit(this.oldPos[0], this.oldPos[1], this.unit);
    restorePairState(this.unit, this.oldUnit);
    restorePairState(this.leader, this.oldLeader);
  }
}

/** Swap the visible leader and off-board follower of a guard-stance pair. */
export class SwitchPairUpAction extends Action {
  private leader: UnitObject;
  private follower: UnitObject;
  private board: GameBoard;
  private db?: Database;
  private oldLeader: PairState;
  private oldFollower: PairState;
  private leaderPos: [number, number] | null;
  private followerPos: [number, number] | null;
  private removedLeaderSkills: IndexedSkill[] = [];
  private addedFollowerSkills: SkillObject[] = [];
  private initialized = false;

  constructor(leader: UnitObject, follower: UnitObject, board: GameBoard, db?: Database) {
    super();
    this.leader = leader;
    this.follower = follower;
    this.board = board;
    this.db = db;
    this.oldLeader = pairState(leader);
    this.oldFollower = pairState(follower);
    this.leaderPos = leader.position ? [...leader.position] as [number, number] : null;
    this.followerPos = follower.position ? [...follower.position] as [number, number] : null;
  }

  execute(): void {
    if (!this.initialized) {
      const indices = new Map(this.leader.skills.map((skill, index) => [skill, index]));
      this.removedLeaderSkills = onSeparate(this.follower, this.leader)
        .map((skill) => ({ skill, index: indices.get(skill) ?? this.leader.skills.length }));
      this.addedFollowerSkills = onPairup(this.leader, this.follower, makeSkillForAction);
      this.initialized = true;
    } else {
      for (const { skill } of this.removedLeaderSkills) {
        const index = this.leader.skills.indexOf(skill);
        if (index >= 0) this.leader.skills.splice(index, 1);
      }
      for (const skill of this.addedFollowerSkills) {
        if (!this.follower.skills.includes(skill)) this.follower.skills.push(skill);
      }
    }

    this.leader.traveler = null;
    this.leader.rescuing = null;
    this.leader.rescuedBy = this.follower;
    this.leader.leadUnit = false;
    this.follower.traveler = this.leader.nid;
    this.follower.rescuing = this.leader;
    this.follower.rescuedBy = null;
    this.follower.leadUnit = true;
    this.follower.setGuardGauge(this.oldLeader.gauge, getMaxGuardGauge(this.follower, this.db));
    this.leader.setGuardGauge(0, getMaxGuardGauge(this.leader, this.db));

    if (this.leader.position) this.board.removeUnit(this.leader);
    if (this.leaderPos) this.board.setUnit(this.leaderPos[0], this.leaderPos[1], this.follower);
    if (!this.oldFollower.leadUnit) this.follower.hasMoved = true;
  }

  reverse(): void {
    for (const skill of this.addedFollowerSkills) {
      const index = this.follower.skills.indexOf(skill);
      if (index >= 0) this.follower.skills.splice(index, 1);
    }
    restoreIndexedSkills(this.leader, this.removedLeaderSkills);
    if (this.follower.position) this.board.removeUnit(this.follower);
    restorePairState(this.leader, this.oldLeader);
    restorePairState(this.follower, this.oldFollower);
    if (this.leaderPos) this.board.setUnit(this.leaderPos[0], this.leaderPos[1], this.leader);
    if (this.followerPos) this.board.setUnit(this.followerPos[0], this.followerPos[1], this.follower);
  }
}

/** Exchange one or two travelers between adjacent visible leaders. */
export class TransferPairUpAction extends Action {
  private unit: UnitObject;
  private other: UnitObject;
  private db?: Database;
  private unitFollower: UnitObject | null;
  private otherFollower: UnitObject | null;
  private oldUnit: PairState;
  private oldOther: PairState;
  private oldUnitFollower: PairState | null;
  private oldOtherFollower: PairState | null;
  private removedUnitSkills: IndexedSkill[] = [];
  private removedOtherSkills: IndexedSkill[] = [];
  private addedUnitSkills: SkillObject[] = [];
  private addedOtherSkills: SkillObject[] = [];
  private initialized = false;

  constructor(unit: UnitObject, other: UnitObject, db?: Database) {
    super();
    this.unit = unit;
    this.other = other;
    this.db = db;
    const game = _getGame?.();
    this.unitFollower = unit.rescuing ?? (unit.traveler ? game?.getUnit?.(unit.traveler) ?? null : null);
    this.otherFollower = other.rescuing ?? (other.traveler ? game?.getUnit?.(other.traveler) ?? null : null);
    this.oldUnit = pairState(unit);
    this.oldOther = pairState(other);
    this.oldUnitFollower = this.unitFollower ? pairState(this.unitFollower) : null;
    this.oldOtherFollower = this.otherFollower ? pairState(this.otherFollower) : null;
  }

  execute(): void {
    if (!this.initialized) {
      if (this.unitFollower) {
        const indices = new Map(this.unit.skills.map((skill, index) => [skill, index]));
        this.removedUnitSkills = onSeparate(this.unitFollower, this.unit)
          .map((skill) => ({ skill, index: indices.get(skill) ?? this.unit.skills.length }));
      }
      if (this.otherFollower) {
        const indices = new Map(this.other.skills.map((skill, index) => [skill, index]));
        this.removedOtherSkills = onSeparate(this.otherFollower, this.other)
          .map((skill) => ({ skill, index: indices.get(skill) ?? this.other.skills.length }));
      }
      if (this.otherFollower) {
        this.addedUnitSkills = onPairup(this.otherFollower, this.unit, makeSkillForAction);
      }
      if (this.unitFollower) {
        this.addedOtherSkills = onPairup(this.unitFollower, this.other, makeSkillForAction);
      }
      this.initialized = true;
    } else {
      for (const { skill } of [...this.removedUnitSkills, ...this.removedOtherSkills]) {
        const owner = this.removedUnitSkills.some((entry) => entry.skill === skill) ? this.unit : this.other;
        const index = owner.skills.indexOf(skill);
        if (index >= 0) owner.skills.splice(index, 1);
      }
      for (const skill of this.addedUnitSkills) if (!this.unit.skills.includes(skill)) this.unit.skills.push(skill);
      for (const skill of this.addedOtherSkills) if (!this.other.skills.includes(skill)) this.other.skills.push(skill);
    }

    if (this.oldUnit.traveler && this.oldOther.traveler) {
      const merged = Math.floor(this.oldUnit.gauge / 2) + Math.floor(this.oldOther.gauge / 2);
      this.unit.setGuardGauge(merged, getMaxGuardGauge(this.unit, this.db));
      this.other.setGuardGauge(merged, getMaxGuardGauge(this.other, this.db));
    } else if (this.oldUnit.traveler) {
      const value = Math.floor(this.oldUnit.gauge / 2);
      this.unit.setGuardGauge(value, getMaxGuardGauge(this.unit, this.db));
      this.other.setGuardGauge(this.oldOther.gauge + value, getMaxGuardGauge(this.other, this.db));
    } else if (this.oldOther.traveler) {
      const value = Math.floor(this.oldOther.gauge / 2);
      this.other.setGuardGauge(value, getMaxGuardGauge(this.other, this.db));
      this.unit.setGuardGauge(this.oldUnit.gauge + value, getMaxGuardGauge(this.unit, this.db));
    }

    this.unit.traveler = this.oldOther.traveler;
    this.unit.rescuing = this.otherFollower;
    this.unit.leadUnit = !!this.otherFollower;
    this.other.traveler = this.oldUnit.traveler;
    this.other.rescuing = this.unitFollower;
    this.other.leadUnit = !!this.unitFollower;
    if (this.unitFollower) {
      this.unitFollower.rescuedBy = this.other;
      this.unitFollower.leadUnit = false;
    }
    if (this.otherFollower) {
      this.otherFollower.rescuedBy = this.unit;
      this.otherFollower.leadUnit = false;
    }
    this.unit.hasGiven = true;
  }

  reverse(): void {
    for (const skill of this.addedUnitSkills) {
      const index = this.unit.skills.indexOf(skill);
      if (index >= 0) this.unit.skills.splice(index, 1);
    }
    for (const skill of this.addedOtherSkills) {
      const index = this.other.skills.indexOf(skill);
      if (index >= 0) this.other.skills.splice(index, 1);
    }
    restoreIndexedSkills(this.unit, this.removedUnitSkills);
    restoreIndexedSkills(this.other, this.removedOtherSkills);
    restorePairState(this.unit, this.oldUnit);
    restorePairState(this.other, this.oldOther);
    if (this.unitFollower && this.oldUnitFollower) restorePairState(this.unitFollower, this.oldUnitFollower);
    if (this.otherFollower && this.oldOtherFollower) restorePairState(this.otherFollower, this.oldOtherFollower);
  }
}

/** Player-turn guard-pair normalization and idle gauge decay. */
export class GuardPairUpkeepAction extends Action {
  private leader: UnitObject;
  private follower: UnitObject;
  private db?: Database;
  private oldLeader: PairState;
  private oldFollower: PairState;

  constructor(leader: UnitObject, follower: UnitObject, db?: Database) {
    super();
    this.leader = leader;
    this.follower = follower;
    this.db = db;
    this.oldLeader = pairState(leader);
    this.oldFollower = pairState(follower);
  }

  execute(): void {
    this.leader.leadUnit = true;
    this.follower.leadUnit = false;
    if (!this.leader.builtGuard) {
      const expression = this.db?.getEquation('GAUGE_INCREASE');
      const amount = expression
        ? Math.trunc(evaluateEquation(expression, this.leader, { db: this.db }))
        : 2;
      this.leader.setGuardGauge(
        this.leader.getGuardGauge() - amount,
        getMaxGuardGauge(this.leader, this.db),
      );
    }
    this.leader.builtGuard = false;
  }

  reverse(): void {
    restorePairState(this.leader, this.oldLeader);
    restorePairState(this.follower, this.oldFollower);
  }
}

/** Separate a leader/follower pair, optionally placing and waiting the follower. */
export class SeparatePairUpAction extends Action {
  private leader: UnitObject;
  private follower: UnitObject;
  private board: GameBoard;
  private position: [number, number] | null;
  private withWait: boolean;
  private oldLeader: PairState;
  private oldFollower: PairState;
  private oldFollowerPos: [number, number] | null;
  private db?: Database;
  private removedSkills: IndexedSkill[] = [];
  private initialized = false;

  constructor(
    leader: UnitObject,
    follower: UnitObject,
    board: GameBoard,
    positionOrDb: Database | [number, number] | null = null,
    positionOrWait: [number, number] | null | boolean = null,
    wait = true,
  ) {
    super();
    this.leader = leader;
    this.follower = follower;
    this.board = board;
    this.db = positionOrDb && !Array.isArray(positionOrDb) ? positionOrDb : undefined;
    this.position = Array.isArray(positionOrDb)
      ? positionOrDb
      : Array.isArray(positionOrWait) ? positionOrWait : null;
    this.withWait = typeof positionOrWait === 'boolean' ? positionOrWait : wait;
    this.oldLeader = pairState(leader);
    this.oldFollower = pairState(follower);
    this.oldFollowerPos = follower.position ? [...follower.position] as [number, number] : null;
  }

  execute(): void {
    if (this.position) this.board.setUnit(this.position[0], this.position[1], this.follower);
    if (this.withWait) this.follower.finished = true;
    this.leader.traveler = null;
    this.leader.rescuing = null;
    this.follower.rescuedBy = null;
    this.leader.hasDropped = true;
    const split = Math.floor(this.oldLeader.gauge / 2);
    this.leader.setGuardGauge(split, getMaxGuardGauge(this.leader, this.db));
    this.follower.setGuardGauge(split, getMaxGuardGauge(this.follower, this.db));
    this.leader.leadUnit = false;
    this.follower.leadUnit = false;
    if (!this.initialized) {
      const indices = new Map(this.leader.skills.map((skill, index) => [skill, index]));
      this.removedSkills = onSeparate(this.follower, this.leader)
        .map(skill => ({ skill, index: indices.get(skill) ?? this.leader.skills.length }));
      this.initialized = true;
    } else {
      for (const { skill } of this.removedSkills) {
        const index = this.leader.skills.indexOf(skill);
        if (index >= 0) this.leader.skills.splice(index, 1);
      }
    }
  }

  reverse(): void {
    if (this.position && this.follower.position) this.board.removeUnit(this.follower);
    restoreIndexedSkills(this.leader, this.removedSkills);
    restorePairState(this.leader, this.oldLeader);
    restorePairState(this.follower, this.oldFollower);
    if (this.oldFollowerPos) this.board.setUnit(this.oldFollowerPos[0], this.oldFollowerPos[1], this.follower);
  }
}

/** Remove a carried partner without changing the board position. */
export class RemovePartnerAction extends Action {
  private unit: UnitObject;
  private partner: UnitObject | null;
  private oldUnit: PairState;
  private oldPartnerRescuedBy: UnitObject | null;
  private removedPenalty: IndexedSkill[] = [];
  private initialized = false;

  constructor(unit: UnitObject, partner?: UnitObject) {
    super();
    this.unit = unit;
    this.partner = unit.rescuing ?? partner ?? null;
    this.oldUnit = pairState(unit);
    this.oldPartnerRescuedBy = this.partner?.rescuedBy ?? null;
  }

  execute(): void {
    if (this.partner) {
      if (!this.initialized) {
        const indices = new Map(this.unit.skills.map((skill, index) => [skill, index]));
        this.removedPenalty = onRemoveRescue(this.unit, this.partner)
          .map(skill => ({ skill, index: indices.get(skill) ?? this.unit.skills.length }));
        this.initialized = true;
      } else {
        for (const { skill } of this.removedPenalty) {
          const index = this.unit.skills.indexOf(skill);
          if (index >= 0) this.unit.skills.splice(index, 1);
        }
      }
    }
    this.unit.traveler = null;
    this.unit.rescuing = null;
    if (this.partner) this.partner.rescuedBy = null;
  }

  reverse(): void {
    restoreIndexedSkills(this.unit, this.removedPenalty);
    restorePairState(this.unit, this.oldUnit);
    if (this.partner) this.partner.rescuedBy = this.oldPartnerRescuedBy;
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
  private oldTraveler: string | null;
  private oldHasDropped: boolean;
  private removedPenalty: IndexedSkill[] = [];
  private initialized = false;

  constructor(rescuer: UnitObject, target: UnitObject, board: GameBoard, dropPos: [number, number]) {
    super();
    this.rescuer = rescuer;
    this.target = target;
    this.board = board;
    this.dropPos = dropPos;
    this.oldTraveler = rescuer.traveler;
    this.oldHasDropped = rescuer.hasDropped;
  }

  execute(): void {
    if (!this.initialized) {
      const indices = new Map(this.rescuer.skills.map((skill, index) => [skill, index]));
      this.removedPenalty = onRemoveRescue(this.rescuer, this.target)
        .map(skill => ({ skill, index: indices.get(skill) ?? this.rescuer.skills.length }));
      this.initialized = true;
    } else {
      for (const { skill } of this.removedPenalty) {
        const index = this.rescuer.skills.indexOf(skill);
        if (index >= 0) this.rescuer.skills.splice(index, 1);
      }
    }
    this.rescuer.rescuing = null;
    this.target.rescuedBy = null;
    this.rescuer.traveler = null;
    this.rescuer.hasDropped = true;
    this.board.setUnit(this.dropPos[0], this.dropPos[1], this.target);
  }

  reverse(): void {
    this.board.removeUnit(this.target);
    restoreIndexedSkills(this.rescuer, this.removedPenalty);
    this.rescuer.rescuing = this.target;
    this.target.rescuedBy = this.rescuer;
    this.rescuer.traveler = this.oldTraveler;
    this.rescuer.hasDropped = this.oldHasDropped;
  }
}

/** DeathAction - Handle unit death and preserve placement for rewind. */
export class DeathAction extends Action {
  private unit: UnitObject;
  private board: GameBoard;
  private initiative: InitiativeTracker | null;
  private position: [number, number] | null = null;
  private wasDead = false;
  private initiativeLine: string[] | null = null;
  private initiativeValues: number[] | null = null;
  private initiativeIndex = -1;

  constructor(unit: UnitObject, board: GameBoard, initiative: InitiativeTracker | null = null) {
    super();
    this.unit = unit;
    this.board = board;
    this.initiative = initiative;
  }

  execute(): void {
    this.wasDead = this.unit.dead;
    this.position = this.unit.position ? [...this.unit.position] as [number, number] : null;
    if (this.initiative) {
      this.initiativeLine = [...this.initiative.unitLine];
      this.initiativeValues = [...this.initiative.initiativeLine];
      this.initiativeIndex = this.initiative.currentIdx;
      this.initiative.removeUnit(this.unit);
    }
    this.unit.dead = true;
    this.board.removeUnit(this.unit);
  }

  reverse(): void {
    this.unit.dead = this.wasDead;
    if (this.position) this.board.setUnit(this.position[0], this.position[1], this.unit);
    if (this.initiative && this.initiativeLine && this.initiativeValues) {
      this.initiative.unitLine = [...this.initiativeLine];
      this.initiative.initiativeLine = [...this.initiativeValues];
      this.initiative.currentIdx = this.initiativeIndex;
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
    this.item.setUses(this.usesBefore);
  }
}

// ------------------------------------------------------------------
// Convoy / Party actions
// ------------------------------------------------------------------

/**
 * PutItemInConvoy - Move an item into a party's convoy.
 * Removes owner reference and appends to convoy.
 */
export class PutItemInConvoy extends Action {
  item: ItemObject;
  partyNid: string | null;
  oldOwnerNid: string | null = null;

  constructor(item: ItemObject, partyNid?: string) {
    super();
    this.item = item;
    this.partyNid = partyNid ?? null;
  }

  execute(): void {
    const game = _getGame?.();
    if (!game) return;
    this.oldOwnerNid = this.item.owner?.nid ?? null;
    this.item.owner = null;
    const party = game.getParty(this.partyNid);
    if (party) party.convoy.push(this.item);
  }

  reverse(): void {
    const game = _getGame?.();
    if (!game) return;
    const party = game.getParty(this.partyNid);
    if (party) {
      const idx = party.convoy.indexOf(this.item);
      if (idx !== -1) party.convoy.splice(idx, 1);
    }
    if (this.oldOwnerNid) {
      const unit = game.getUnit(this.oldOwnerNid);
      if (unit) this.item.owner = unit;
    }
  }
}

/**
 * TakeItemFromConvoy - Move an item from a party's convoy to a unit's inventory.
 */
export class TakeItemFromConvoy extends Action {
  unit: UnitObject;
  item: ItemObject;
  partyNid: string | null;

  constructor(unit: UnitObject, item: ItemObject, partyNid?: string) {
    super();
    this.unit = unit;
    this.item = item;
    this.partyNid = partyNid ?? null;
  }

  execute(): void {
    const game = _getGame?.();
    if (!game) return;
    const party = game.getParty(this.partyNid);
    if (party) {
      const idx = party.convoy.indexOf(this.item);
      if (idx !== -1) party.convoy.splice(idx, 1);
    }
    this.unit.items.push(this.item);
    this.item.owner = this.unit;
  }

  reverse(): void {
    const game = _getGame?.();
    if (!game) return;
    const idx = this.unit.items.indexOf(this.item);
    if (idx !== -1) this.unit.items.splice(idx, 1);
    this.item.owner = null;
    const party = game.getParty(this.partyNid);
    if (party) party.convoy.push(this.item);
  }
}

/**
 * RemoveItemFromConvoy - Remove an item from a party's convoy entirely.
 */
export class RemoveItemFromConvoy extends Action {
  item: ItemObject;
  partyNid: string | null;

  constructor(item: ItemObject, partyNid?: string) {
    super();
    this.item = item;
    this.partyNid = partyNid ?? null;
  }

  execute(): void {
    const game = _getGame?.();
    if (!game) return;
    const party = game.getParty(this.partyNid);
    if (party) {
      const idx = party.convoy.indexOf(this.item);
      if (idx !== -1) party.convoy.splice(idx, 1);
    }
  }

  reverse(): void {
    const game = _getGame?.();
    if (!game) return;
    const party = game.getParty(this.partyNid);
    if (party) party.convoy.push(this.item);
  }
}

/** Remove an item from a unit inventory without destroying its registered instance. */
export class RemoveItemFromUnitAction extends Action {
  private unit: UnitObject;
  private item: ItemObject;
  private itemIndex: number;

  constructor(unit: UnitObject, item: ItemObject) {
    super();
    this.unit = unit;
    this.item = item;
    this.itemIndex = unit.items.indexOf(item);
  }

  execute(): void {
    const index = this.unit.items.indexOf(this.item);
    if (index >= 0) this.unit.items.splice(index, 1);
    this.item.owner = null;
  }

  reverse(): void {
    this.unit.items.splice(this.itemIndex, 0, this.item);
    this.item.owner = this.unit;
  }
}

/** Move one item between unit inventories while preserving its source slot on rewind. */
export class MoveItemBetweenUnitsAction extends Action {
  private source: UnitObject;
  private target: UnitObject;
  private item: ItemObject;
  private sourceIndex: number;

  constructor(source: UnitObject, target: UnitObject, item: ItemObject) {
    super();
    this.source = source;
    this.target = target;
    this.item = item;
    this.sourceIndex = source.items.indexOf(item);
  }

  execute(): void {
    const index = this.source.items.indexOf(this.item);
    if (index >= 0) this.source.items.splice(index, 1);
    this.target.items.push(this.item);
    this.item.owner = this.target;
  }

  reverse(): void {
    const index = this.target.items.indexOf(this.item);
    if (index >= 0) this.target.items.splice(index, 1);
    this.source.items.splice(this.sourceIndex, 0, this.item);
    this.item.owner = this.source;
  }
}

/** Move an item between named party convoys reversibly. */
export class MoveItemBetweenConvoysAction extends Action {
  private item: ItemObject;
  private sourcePartyNid: string;
  private targetPartyNid: string;
  private sourceIndex: number = -1;

  constructor(item: ItemObject, sourcePartyNid: string, targetPartyNid: string) {
    super();
    this.item = item;
    this.sourcePartyNid = sourcePartyNid;
    this.targetPartyNid = targetPartyNid;
  }

  execute(): void {
    const game = _getGame?.();
    const source = game?.getParty(this.sourcePartyNid);
    const target = game?.getParty(this.targetPartyNid);
    if (!source || !target) return;
    this.sourceIndex = source.convoy.indexOf(this.item);
    if (this.sourceIndex >= 0) source.convoy.splice(this.sourceIndex, 1);
    target.convoy.push(this.item);
    this.item.owner = null;
  }

  reverse(): void {
    const game = _getGame?.();
    const source = game?.getParty(this.sourcePartyNid);
    const target = game?.getParty(this.targetPartyNid);
    if (!source || !target) return;
    const index = target.convoy.indexOf(this.item);
    if (index >= 0) target.convoy.splice(index, 1);
    source.convoy.splice(Math.max(0, this.sourceIndex), 0, this.item);
    this.item.owner = null;
  }
}

/**
 * StoreItemAction - Store an item from a unit's inventory into the current party's convoy.
 * Used by the convoy UI when a player stores an item.
 */
export class StoreItemAction extends Action {
  persistThroughMenuCancel = true;
  unit: UnitObject;
  item: ItemObject;
  itemIndex: number;

  constructor(unit: UnitObject, item: ItemObject) {
    super();
    this.unit = unit;
    this.item = item;
    this.itemIndex = unit.items.indexOf(item);
  }

  execute(): void {
    const game = _getGame?.();
    if (!game) return;
    const idx = this.unit.items.indexOf(this.item);
    if (idx !== -1) this.unit.items.splice(idx, 1);
    this.item.owner = null;
    const party = game.getParty();
    if (party) party.convoy.push(this.item);
  }

  reverse(): void {
    const game = _getGame?.();
    if (!game) return;
    const party = game.getParty();
    if (party) {
      const idx = party.convoy.indexOf(this.item);
      if (idx !== -1) party.convoy.splice(idx, 1);
    }
    this.unit.items.splice(this.itemIndex, 0, this.item);
    this.item.owner = this.unit;
  }
}

/**
 * TradeItemWithConvoy - Swap an item between a unit and the convoy.
 * The unit gives one item and receives another from the convoy.
 */
export class TradeItemWithConvoy extends Action {
  unit: UnitObject;
  convoyItem: ItemObject;
  unitItem: ItemObject;
  unitItemIndex: number;

  constructor(unit: UnitObject, convoyItem: ItemObject, unitItem: ItemObject) {
    super();
    this.unit = unit;
    this.convoyItem = convoyItem;
    this.unitItem = unitItem;
    this.unitItemIndex = unit.items.indexOf(unitItem);
  }

  execute(): void {
    const game = _getGame?.();
    if (!game) return;
    const party = game.getParty();
    if (!party) return;
    // Remove unit item from unit
    const uIdx = this.unit.items.indexOf(this.unitItem);
    if (uIdx !== -1) this.unit.items.splice(uIdx, 1);
    // Remove convoy item from convoy
    const cIdx = party.convoy.indexOf(this.convoyItem);
    if (cIdx !== -1) party.convoy.splice(cIdx, 1);
    // Add unit item to convoy
    party.convoy.push(this.unitItem);
    this.unitItem.owner = null;
    // Add convoy item to unit at original index
    this.unit.items.splice(this.unitItemIndex, 0, this.convoyItem);
    this.convoyItem.owner = this.unit;
  }

  reverse(): void {
    const game = _getGame?.();
    if (!game) return;
    const party = game.getParty();
    if (!party) return;
    // Remove convoy item from unit
    const uIdx = this.unit.items.indexOf(this.convoyItem);
    if (uIdx !== -1) this.unit.items.splice(uIdx, 1);
    this.convoyItem.owner = null;
    // Remove unit item from convoy
    const cIdx = party.convoy.indexOf(this.unitItem);
    if (cIdx !== -1) party.convoy.splice(cIdx, 1);
    // Restore
    party.convoy.push(this.convoyItem);
    this.unit.items.splice(this.unitItemIndex, 0, this.unitItem);
    this.unitItem.owner = this.unit;
  }
}

/**
 * GainMoneyAction - Add or remove money from a party.
 * Negative amounts are clamped so money never goes below 0.
 */
export class GainMoneyAction extends Action {
  partyNid: string | null;
  amount: number;
  oldMoney: number = 0;

  constructor(amount: number, partyNid?: string) {
    super();
    this.amount = amount;
    this.partyNid = partyNid ?? null;
  }

  execute(): void {
    const game = _getGame?.();
    if (!game) return;
    const party = game.getParty(this.partyNid);
    if (!party) return;
    this.oldMoney = party.money;
    if (party.money + this.amount < 0) {
      this.amount = -party.money;
    }
    party.money += this.amount;
  }

  reverse(): void {
    const game = _getGame?.();
    if (!game) return;
    const party = game.getParty(this.partyNid);
    if (party) party.money = this.oldMoney;
  }
}

/**
 * GiveBexpAction - Add or remove bonus experience from a party.
 * BEXP is clamped to a minimum of 0.
 */
export class GiveBexpAction extends Action {
  partyNid: string | null;
  amount: number;
  oldBexp: number = 0;

  constructor(amount: number, partyNid?: string) {
    super();
    this.amount = amount;
    this.partyNid = partyNid ?? null;
  }

  execute(): void {
    const game = _getGame?.();
    if (!game) return;
    const party = game.getParty(this.partyNid);
    if (!party) return;
    this.oldBexp = party.bexp;
    party.bexp = Math.max(0, party.bexp + this.amount);
  }

  reverse(): void {
    const game = _getGame?.();
    if (!game) return;
    const party = game.getParty(this.partyNid);
    if (party) party.bexp = this.oldBexp;
  }
}

// ------------------------------------------------------------------
// Event-driven unit and campaign mutations
// ------------------------------------------------------------------

/** Return the class-defined WEXP cap for a unit/weapon pair. */
function getWeaponExpCap(unit: UnitObject, weaponType: string): number {
  const game = _getGame?.();
  const klass = game?.db?.classes?.get?.(unit.klass);
  const entry = klass?.wexp_gain?.[weaponType];
  if (Array.isArray(entry) && Number.isFinite(entry[2])) {
    return Math.max(0, Number(entry[2]));
  }
  return Number.MAX_SAFE_INTEGER;
}

/** Add WEXP, clamped to the class cap, with full turnwheel reversal. */
export class GainWexpAction extends Action {
  private unit: UnitObject;
  private weaponType: string;
  private amount: number;
  private oldWexp: number = 0;
  private currentWexp: number = 0;

  constructor(unit: UnitObject, weaponType: string, amount: number) {
    super();
    this.unit = unit;
    this.weaponType = weaponType;
    this.amount = amount;
  }

  execute(): void {
    this.oldWexp = this.unit.wexp[this.weaponType] ?? 0;
    const cap = getWeaponExpCap(this.unit, this.weaponType);
    this.unit.wexp[this.weaponType] = Math.max(
      0,
      Math.min(cap, this.oldWexp + this.amount),
    );
    this.currentWexp = this.unit.wexp[this.weaponType];
  }

  reverse(): void {
    this.unit.wexp[this.weaponType] = this.oldWexp;
  }

  getRankUp(): { rank: string; requirement: number } | null {
    const game = _getGame?.();
    const ranks = [...(game?.db?.weaponRanks ?? [])].reverse();
    return ranks.find((rank: { requirement: number }) =>
      this.oldWexp < rank.requirement && this.currentWexp >= rank.requirement
    ) ?? null;
  }

  getOldWexp(): number { return this.oldWexp; }
}

/** Set WEXP, clamped to the class cap, with full turnwheel reversal. */
export class SetWexpAction extends Action {
  private unit: UnitObject;
  private weaponType: string;
  private value: number;
  private oldWexp: number = 0;
  private currentWexp: number = 0;

  constructor(unit: UnitObject, weaponType: string, value: number) {
    super();
    this.unit = unit;
    this.weaponType = weaponType;
    this.value = value;
  }

  execute(): void {
    this.oldWexp = this.unit.wexp[this.weaponType] ?? 0;
    const cap = getWeaponExpCap(this.unit, this.weaponType);
    this.unit.wexp[this.weaponType] = Math.max(0, Math.min(cap, this.value));
    this.currentWexp = this.unit.wexp[this.weaponType];
  }

  reverse(): void {
    this.unit.wexp[this.weaponType] = this.oldWexp;
  }

  getRankUp(): { rank: string; requirement: number } | null {
    const game = _getGame?.();
    const ranks = [...(game?.db?.weaponRanks ?? [])].reverse();
    return ranks.find((rank: { requirement: number }) =>
      this.oldWexp < rank.requirement && this.currentWexp >= rank.requirement
    ) ?? null;
  }

  getOldWexp(): number { return this.oldWexp; }
}

/** Set displayed unit level without applying stat growths. */
export class SetUnitLevelAction extends Action {
  private unit: UnitObject;
  private level: number;
  private oldLevel: number = 1;

  constructor(unit: UnitObject, level: number) {
    super();
    this.unit = unit;
    this.level = Math.max(1, level);
  }

  execute(): void {
    this.oldLevel = this.unit.level;
    this.unit.level = this.level;
  }

  reverse(): void {
    this.unit.level = this.oldLevel;
  }
}

/** Apply LT autolevel stat changes without changing displayed level. */
export class AutoLevelAction extends Action {
  private unit: UnitObject;
  private levelDifference: number;
  private growthMethod: string | undefined;
  private oldStats: Record<string, number>;
  private oldGrowthPoints: Record<string, number>;
  private oldHp: number;
  statChanges: Record<string, number> = {};

  constructor(unit: UnitObject, levelDifference: number, growthMethod?: string) {
    super();
    this.unit = unit;
    this.levelDifference = levelDifference;
    this.growthMethod = growthMethod;
    this.oldStats = { ...unit.stats };
    this.oldGrowthPoints = { ...unit.growthPoints };
    this.oldHp = unit.currentHp;
  }

  execute(): void {
    const game = _getGame?.();
    if (!game) return;
    this.unit.stats = { ...this.oldStats };
    this.unit.growthPoints = { ...this.oldGrowthPoints };
    const result = autoLevelUnit(this.unit, this.levelDifference, this.growthMethod, game);
    this.statChanges = result.statChanges;
    for (const [stat, change] of Object.entries(this.statChanges)) {
      if (this.unit.stats[stat] !== undefined) this.unit.stats[stat] += change;
    }
    this.unit.growthPoints = result.growthPoints;
    this.unit.currentHp = this.unit.maxHp;
  }

  reverse(): void {
    this.unit.stats = { ...this.oldStats };
    this.unit.growthPoints = { ...this.oldGrowthPoints };
    this.unit.currentHp = this.oldHp;
  }
}

/** Add an already-created skill object, avoiding duplicates, reversibly. */
export class AddSkillAction extends Action {
  private unit: UnitObject;
  private skill: SkillObject;
  private added: boolean = false;

  constructor(unit: UnitObject, skill: SkillObject) {
    super();
    this.unit = unit;
    this.skill = skill;
  }

  execute(): void {
    this.added = !this.unit.skills.some((skill) => skill.nid === this.skill.nid);
    if (this.added) this.unit.skills.push(this.skill);
    if (this.skill.hasComponent('canto')) this.unit.hasCanto = true;
  }

  reverse(): void {
    if (this.added) {
      const index = this.unit.skills.indexOf(this.skill);
      if (index >= 0) this.unit.skills.splice(index, 1);
    }
    this.unit.hasCanto = this.unit.skills.some((skill) => skill.hasComponent('canto'));
  }
}

/** Remove one runtime skill instance and restore its original slot on rewind. */
export class RemoveSkillAction extends Action {
  private unit: UnitObject;
  private skill: SkillObject;
  private index: number = -1;

  constructor(unit: UnitObject, skill: SkillObject) {
    super();
    this.unit = unit;
    this.skill = skill;
  }

  execute(): void {
    this.index = this.unit.skills.indexOf(this.skill);
    if (this.index >= 0) this.unit.skills.splice(this.index, 1);
    this.unit.hasCanto = this.unit.skills.some((candidate) => candidate.hasComponent('canto'));
  }

  reverse(): void {
    if (this.index >= 0 && !this.unit.skills.includes(this.skill)) {
      this.unit.skills.splice(this.index, 0, this.skill);
    }
    if (this.skill.hasComponent('canto')) this.unit.hasCanto = true;
  }
}

/** Refresh a unit's action flags, restoring the exact prior state on rewind. */
export class RefreshUnitAction extends Action {
  private unit: UnitObject;
  private oldHasAttacked: boolean = false;
  private oldHasMoved: boolean = false;
  private oldHasTraded: boolean = false;
  private oldFinished: boolean = false;

  constructor(unit: UnitObject) {
    super();
    this.unit = unit;
  }

  execute(): void {
    this.oldHasAttacked = this.unit.hasAttacked;
    this.oldHasMoved = this.unit.hasMoved;
    this.oldHasTraded = this.unit.hasTraded;
    this.oldFinished = this.unit.finished;
    this.unit.resetTurnState();
  }

  reverse(): void {
    this.unit.hasAttacked = this.oldHasAttacked;
    this.unit.hasMoved = this.oldHasMoved;
    this.unit.hasTraded = this.oldHasTraded;
    this.unit.finished = this.oldFinished;
  }
}

type MutableUnitAttribute =
  | 'name' | 'desc' | 'variant' | 'aiGroup' | 'portraitNid' | 'affinity';

/** Reversibly set a scalar UnitObject property used by event commands. */
export class SetUnitAttributeAction extends Action {
  private unit: UnitObject;
  private attribute: MutableUnitAttribute;
  private value: string | null;
  private oldValue: string | null;

  constructor(unit: UnitObject, attribute: MutableUnitAttribute, value: string | null) {
    super();
    this.unit = unit;
    this.attribute = attribute;
    this.value = value;
    this.oldValue = unit[attribute] as string | null;
  }

  execute(): void {
    (this.unit as any)[this.attribute] = this.value;
  }

  reverse(): void {
    (this.unit as any)[this.attribute] = this.oldValue;
  }
}

/** Change faction and update generic display text like the Python action. */
export class ChangeFactionAction extends Action {
  private unit: UnitObject;
  private factionNid: string;
  private oldFaction: string | null;
  private oldName: string;
  private oldDesc: string;

  constructor(unit: UnitObject, factionNid: string) {
    super();
    this.unit = unit;
    this.factionNid = factionNid;
    this.oldFaction = unit.faction;
    this.oldName = unit.name;
    this.oldDesc = unit.desc;
  }

  execute(): void {
    this.unit.faction = this.factionNid;
    const faction = _getGame?.()?.db?.factions?.get?.(this.factionNid);
    if (this.unit.generic && faction) {
      this.unit.name = faction.name;
      this.unit.desc = faction.desc;
    }
  }

  reverse(): void {
    this.unit.faction = this.oldFaction;
    this.unit.name = this.oldName;
    this.unit.desc = this.oldDesc;
  }
}

/** Add to or set a unit numeric record such as growths or cap modifiers. */
export class ChangeUnitRecordAction extends Action {
  private unit: UnitObject;
  private recordName: 'growths' | 'statCapModifiers';
  private values: Record<string, number>;
  private mode: 'add' | 'set';
  private oldRecord: Record<string, number>;

  constructor(
    unit: UnitObject,
    recordName: 'growths' | 'statCapModifiers',
    values: Record<string, number>,
    mode: 'add' | 'set',
  ) {
    super();
    this.unit = unit;
    this.recordName = recordName;
    this.values = { ...values };
    this.mode = mode;
    this.oldRecord = { ...unit[recordName] };
  }

  execute(): void {
    const record = { ...this.oldRecord };
    for (const [key, value] of Object.entries(this.values)) {
      record[key] = this.mode === 'add' ? (record[key] ?? 0) + value : value;
    }
    this.unit[this.recordName] = record;
  }

  reverse(): void {
    this.unit[this.recordName] = { ...this.oldRecord };
  }
}

/** Set or increment a persistent custom unit field. */
export class SetUnitFieldAction extends Action {
  private unit: UnitObject;
  private key: string;
  private value: any;
  private increment: boolean;
  private oldValue: any;

  constructor(unit: UnitObject, key: string, value: any, increment: boolean = false) {
    super();
    this.unit = unit;
    this.key = key;
    this.value = value;
    this.increment = increment;
    this.oldValue = unit.fields.get(key) ?? '';
  }

  execute(): void {
    if (this.increment && typeof this.value === 'number' && typeof this.oldValue === 'number') {
      this.unit.fields.set(this.key, this.oldValue + this.value);
    } else {
      this.unit.fields.set(this.key, this.value);
    }
  }

  reverse(): void {
    this.unit.fields.set(this.key, this.oldValue);
  }
}

/** Add, replace, or remove a categorized unit note reversibly. */
export class ChangeUnitNoteAction extends Action {
  private unit: UnitObject;
  private key: string;
  private value: string | null;
  private oldNotes: [string, string][];

  constructor(unit: UnitObject, key: string, value: string | null) {
    super();
    this.unit = unit;
    this.key = key;
    this.value = value;
    this.oldNotes = unit.notes.map(([category, note]) => [category, note]);
  }

  execute(): void {
    this.unit.notes = this.oldNotes.map(([category, note]) => [category, note]);
    const index = this.unit.notes.findIndex(([category]) => category === this.key);
    if (this.value === null) {
      if (index >= 0) this.unit.notes.splice(index, 1);
    } else if (index >= 0) {
      this.unit.notes[index] = [this.key, this.value];
    } else {
      this.unit.notes.push([this.key, this.value]);
    }
  }

  reverse(): void {
    this.unit.notes = this.oldNotes.map(([category, note]) => [category, note]);
  }
}

/** Reversibly change an item instance's display name or description. */
export class ChangeItemTextAction extends Action {
  private item: ItemObject;
  private attribute: 'name' | 'desc';
  private value: string;
  private oldValue: string;

  constructor(item: ItemObject, attribute: 'name' | 'desc', value: string) {
    super();
    this.item = item;
    this.attribute = attribute;
    this.value = value;
    this.oldValue = item[attribute];
  }

  execute(): void { this.item[this.attribute] = this.value; }
  reverse(): void { this.item[this.attribute] = this.oldValue; }
}

/** Reversibly set whether an inventory item drops on unit death. */
export class SetItemDroppableAction extends Action {
  private item: ItemObject;
  private value: boolean;
  private oldValue: boolean;

  constructor(item: ItemObject, value: boolean) {
    super();
    this.item = item;
    this.value = value;
    this.oldValue = item.droppable;
  }

  execute(): void { this.item.droppable = this.value; }
  reverse(): void { this.item.droppable = this.oldValue; }
}

/** Append a per-save gameplay record and remove it again on turnwheel rewind. */
export class UpdateRecordsAction extends Action {
  private recordType: string;
  private args: unknown[];
  private appended: boolean = false;

  constructor(recordType: string, ...args: unknown[]) {
    super();
    this.recordType = recordType;
    this.args = args;
  }

  execute(): void {
    const game = _getGame?.();
    if (!game?.records) return;
    game.records.append(
      this.recordType,
      game.turnCount ?? game.phase?.turnCount ?? 1,
      game.currentLevel?.nid ?? null,
      ...this.args,
    );
    this.appended = true;
  }

  reverse(): void {
    if (this.appended) _getGame?.()?.records?.pop?.(this.recordType);
  }
}

/** Mirror LT's SetObjData: only an existing runtime-data key can be changed. */
export class SetItemDataAction extends Action {
  private item: ItemObject;
  private key: string;
  private value: any;
  private oldValue: any;
  private exists: boolean;

  constructor(item: ItemObject, key: string, value: any) {
    super();
    this.item = item;
    this.key = key;
    this.value = value;
    this.exists = item.data.has(key);
    this.oldValue = item.data.get(key);
  }

  execute(): void {
    if (this.exists) this.item.setData(this.key, this.value);
  }

  reverse(): void {
    if (this.exists) this.item.setData(this.key, this.oldValue);
  }
}

/** Set normal or chapter uses while keeping the ItemObject data mirror synchronized. */
export class SetItemUsesAction extends Action {
  private item: ItemObject;
  private value: number;
  private oldValue: number;

  constructor(item: ItemObject, value: number) {
    super();
    this.item = item;
    this.value = Math.max(0, Math.min(item.maxUses, value));
    this.oldValue = item.uses;
  }

  execute(): void { this.item.setUses(this.value); }
  reverse(): void { this.item.setUses(this.oldValue); }
}

/** Attach a child item tree to a multi/sequence parent. */
export class AddSubItemAction extends Action {
  private parent: ItemObject;
  private child: ItemObject;

  constructor(parent: ItemObject, child: ItemObject) {
    super();
    this.parent = parent;
    this.child = child;
  }

  execute(): void {
    if (!this.parent.subitems.includes(this.child)) this.parent.subitems.push(this.child);
    this.child.parentItem = this.parent;
    this.child.owner = this.parent.owner;
  }

  reverse(): void {
    const index = this.parent.subitems.indexOf(this.child);
    if (index >= 0) this.parent.subitems.splice(index, 1);
    this.child.parentItem = null;
    this.child.owner = null;
  }
}

/** Detach a child item while preserving its original position for turnwheel reversal. */
export class RemoveSubItemAction extends Action {
  private parent: ItemObject;
  private child: ItemObject;
  private index: number;

  constructor(parent: ItemObject, child: ItemObject) {
    super();
    this.parent = parent;
    this.child = child;
    this.index = parent.subitems.indexOf(child);
  }

  execute(): void {
    const index = this.parent.subitems.indexOf(this.child);
    if (index >= 0) this.parent.subitems.splice(index, 1);
    this.child.parentItem = null;
    this.child.owner = null;
  }

  reverse(): void {
    this.parent.subitems.splice(Math.max(0, this.index), 0, this.child);
    this.child.parentItem = this.parent;
    this.child.owner = this.parent.owner;
  }
}

/** Mark a dead unit alive again. Placement is intentionally unchanged. */
export class ResurrectAction extends Action {
  private unit: UnitObject;
  private oldDead: boolean = false;
  private oldHp: number = 0;
  private oldHasAttacked: boolean = false;
  private oldHasMoved: boolean = false;
  private oldHasTraded: boolean = false;
  private oldFinished: boolean = false;

  constructor(unit: UnitObject) {
    super();
    this.unit = unit;
  }

  execute(): void {
    this.oldDead = this.unit.dead;
    this.oldHp = this.unit.currentHp;
    this.oldHasAttacked = this.unit.hasAttacked;
    this.oldHasMoved = this.unit.hasMoved;
    this.oldHasTraded = this.unit.hasTraded;
    this.oldFinished = this.unit.finished;
    this.unit.dead = false;
    this.unit.currentHp = this.unit.maxHp;
    this.unit.resetTurnState();
  }

  reverse(): void {
    this.unit.dead = this.oldDead;
    this.unit.currentHp = this.oldHp;
    this.unit.hasAttacked = this.oldHasAttacked;
    this.unit.hasMoved = this.oldHasMoved;
    this.unit.hasTraded = this.oldHasTraded;
    this.unit.finished = this.oldFinished;
  }
}

/** Unlock a lore entry for the current playthrough. */
export class AddLoreAction extends Action {
  private loreNid: string;
  private added: boolean = false;

  constructor(loreNid: string) {
    super();
    this.loreNid = loreNid;
  }

  execute(): void {
    const game = _getGame?.();
    if (!game?.unlockedLore) return;
    this.added = !game.unlockedLore.includes(this.loreNid);
    if (this.added) game.unlockedLore.push(this.loreNid);
  }

  reverse(): void {
    if (!this.added) return;
    const game = _getGame?.();
    const index = game?.unlockedLore?.indexOf?.(this.loreNid) ?? -1;
    if (index >= 0) game.unlockedLore.splice(index, 1);
  }
}

/** Lock a previously unlocked lore entry. */
export class RemoveLoreAction extends Action {
  private loreNid: string;
  private oldIndex: number = -1;

  constructor(loreNid: string) {
    super();
    this.loreNid = loreNid;
  }

  execute(): void {
    const game = _getGame?.();
    this.oldIndex = game?.unlockedLore?.indexOf?.(this.loreNid) ?? -1;
    if (this.oldIndex >= 0) game.unlockedLore.splice(this.oldIndex, 1);
  }

  reverse(): void {
    if (this.oldIndex < 0) return;
    const game = _getGame?.();
    if (!game?.unlockedLore?.includes?.(this.loreNid)) {
      game.unlockedLore.splice(this.oldIndex, 0, this.loreNid);
    }
  }
}

// ------------------------------------------------------------------
// Promotion / Class Change actions
// ------------------------------------------------------------------

/**
 * PromoteAction — Promote a unit to a higher-tier class.
 * Uses the target class's promotion dict for stat gains.
 *
 * Sentinel values in promotion dict:
 *   -99 = use new class base as the stat value
 *   -98 = max(0, new base - current stat) — only increase
 *   -97 = clamp(new base - old base, -current, max - current)
 *
 * Port of Python's action.Promote from app/engine/action.py.
 */
export class PromoteAction extends Action {
  unit: UnitObject;
  newKlass: string;
  oldKlass: string;
  oldExp: number;
  oldLevel: number;
  oldStats: Record<string, number>;
  oldMaxStats: Record<string, number>;
  oldGrowths: Record<string, number>;
  oldHp: number;
  oldWexp: Record<string, number>;
  statChanges: Record<string, number>;
  growthChanges: Record<string, number>;
  newWexp: Record<string, number>;
  private shouldAddGrowths: boolean = false;

  constructor(unit: UnitObject, newKlassNid: string) {
    super();
    this.unit = unit;
    this.newKlass = newKlassNid;
    this.oldKlass = unit.klass;
    this.oldExp = unit.exp;
    this.oldLevel = unit.level;
    this.oldStats = { ...unit.stats };
    this.oldMaxStats = { ...unit.maxStats };
    this.oldGrowths = { ...unit.growths };
    this.oldHp = unit.currentHp;
    this.oldWexp = { ...unit.wexp };
    this.statChanges = {};
    this.growthChanges = {};
    this.newWexp = {};

    // Compute stat changes immediately using game reference
    const game = _getGame?.();
    if (game) {
      this.computeChanges(game.db);
    }
  }

  /**
   * Compute stat changes, growth changes, and new wexp.
   * Called from constructor when game reference is available.
   */
  private computeChanges(db: any): void {
    const newKlassDef = db.classes.get(this.newKlass);
    const oldKlassDef = db.classes.get(this.oldKlass);
    if (!newKlassDef || !oldKlassDef) return;

    const promotion = newKlassDef.promotion ?? {};
    const currentStats = this.unit.stats;
    const newMaxes = newKlassDef.max_stats ?? {};
    const newBases = newKlassDef.bases ?? {};
    const oldBases = oldKlassDef.bases ?? {};

    for (const stat of Object.keys(currentStats)) {
      const promoValue = promotion[stat] ?? 0;
      const currentStat = currentStats[stat] ?? 0;
      const newMax = newMaxes[stat] ?? 99;
      const newBase = newBases[stat] ?? 0;
      const oldBase = oldBases[stat] ?? 0;
      let change = 0;

      if (promoValue === -99) {
        // Use new class base directly
        change = newBase - currentStat;
      } else if (promoValue === -98) {
        // Use new class base only if bigger
        change = Math.max(0, newBase - currentStat);
      } else if (promoValue === -97) {
        // Base difference, clamped
        const diff = newBase - oldBase;
        change = Math.max(-currentStat, Math.min(diff, newMax - currentStat));
      } else {
        // Normal promotion bonus, capped by new max
        const maxGainPossible = newMax - currentStat;
        change = Math.min(promoValue, maxGainPossible);
      }
      this.statChanges[stat] = change;
    }

    // Growth changes (when unit_stats_as_bonus constant is true)
    this.shouldAddGrowths = db.getConstant('unit_stats_as_bonus', false);
    if (this.shouldAddGrowths) {
      const oldKlassGrowths = oldKlassDef.growths ?? {};
      const newKlassGrowths = newKlassDef.growths ?? {};
      for (const stat of Object.keys(this.unit.growths)) {
        const newGrowth = newKlassGrowths[stat] ?? 0;
        const oldGrowth = oldKlassGrowths[stat] ?? 0;
        this.growthChanges[stat] = newGrowth - oldGrowth;
      }
    }

    // New weapon experience from class
    const wexpGain = newKlassDef.wexp_gain ?? {};
    for (const [wtype, entry] of Object.entries(wexpGain)) {
      const [usable, startWexp] = entry as [boolean, number, number];
      if (usable && startWexp > 0) {
        this.newWexp[wtype] = startWexp;
      }
    }
  }

  /** Get stat changes and new wexp for display/use by event commands. */
  getData(): { statChanges: Record<string, number>; newWexp: Record<string, number> } {
    return { statChanges: this.statChanges, newWexp: this.newWexp };
  }

  execute(): void {
    const game = _getGame?.();
    this.unit.klass = this.newKlass;

    // Level reset on promotion (default: true)
    if (game && game.db.getConstant('promote_level_reset', true)) {
      this.unit.exp = 0;
      this.unit.level = 1;
    }

    // Apply stat changes
    for (const [stat, change] of Object.entries(this.statChanges)) {
      if (this.unit.stats[stat] !== undefined) {
        this.unit.stats[stat] += change;
      }
    }

    // Apply growth changes
    if (this.shouldAddGrowths) {
      for (const [stat, change] of Object.entries(this.growthChanges)) {
        if (this.unit.growths[stat] !== undefined) {
          this.unit.growths[stat] += change;
        }
      }
    }

    // Update max stats to new class
    if (game) {
      const newKlassDef = game.db.classes.get(this.newKlass);
      if (newKlassDef) {
        this.unit.maxStats = { ...newKlassDef.max_stats };
      }
    }

    // Adjust current HP by the HP stat change
    const hpChange = this.statChanges['HP'] ?? 0;
    if (hpChange > 0) {
      this.unit.currentHp += hpChange;
    }
    // Clamp to new max
    this.unit.currentHp = Math.min(this.unit.currentHp, this.unit.maxHp);
  }

  reverse(): void {
    this.unit.klass = this.oldKlass;
    this.unit.level = this.oldLevel;
    this.unit.exp = this.oldExp;
    this.unit.stats = { ...this.oldStats };
    this.unit.maxStats = { ...this.oldMaxStats };
    this.unit.growths = { ...this.oldGrowths };
    this.unit.currentHp = this.oldHp;
    this.unit.wexp = { ...this.oldWexp };
  }
}

/**
 * ClassChangeAction — Lateral class change using base stat differences.
 * Unlike promotion which uses the promotion dict, class change always
 * uses (new base - old base) clamped to [−current, max − current].
 *
 * Port of Python's action.ClassChange from app/engine/action.py.
 */
export class ClassChangeAction extends Action {
  unit: UnitObject;
  newKlass: string;
  oldKlass: string;
  oldExp: number;
  oldLevel: number;
  oldStats: Record<string, number>;
  oldMaxStats: Record<string, number>;
  oldGrowths: Record<string, number>;
  oldHp: number;
  oldWexp: Record<string, number>;
  statChanges: Record<string, number>;
  growthChanges: Record<string, number>;
  newWexp: Record<string, number>;
  private shouldAddGrowths: boolean = false;

  constructor(unit: UnitObject, newKlassNid: string) {
    super();
    this.unit = unit;
    this.newKlass = newKlassNid;
    this.oldKlass = unit.klass;
    this.oldExp = unit.exp;
    this.oldLevel = unit.level;
    this.oldStats = { ...unit.stats };
    this.oldMaxStats = { ...unit.maxStats };
    this.oldGrowths = { ...unit.growths };
    this.oldHp = unit.currentHp;
    this.oldWexp = { ...unit.wexp };
    this.statChanges = {};
    this.growthChanges = {};
    this.newWexp = {};

    // Compute stat changes immediately using game reference
    const game = _getGame?.();
    if (game) {
      this.computeChanges(game.db);
    }
  }

  private computeChanges(db: any): void {
    const newKlassDef = db.classes.get(this.newKlass);
    const oldKlassDef = db.classes.get(this.oldKlass);
    if (!newKlassDef || !oldKlassDef) return;

    const currentStats = this.unit.stats;
    const newBases = newKlassDef.bases ?? {};
    const oldBases = oldKlassDef.bases ?? {};
    const newMaxes = newKlassDef.max_stats ?? {};

    for (const stat of Object.keys(currentStats)) {
      const newBase = newBases[stat] ?? 0;
      const oldBase = oldBases[stat] ?? 0;
      const currentStat = currentStats[stat] ?? 0;
      const newMax = newMaxes[stat] ?? 99;
      const diff = newBase - oldBase;
      const change = Math.max(-currentStat, Math.min(diff, newMax - currentStat));
      this.statChanges[stat] = change;
    }

    this.shouldAddGrowths = db.getConstant('unit_stats_as_bonus', false);
    if (this.shouldAddGrowths) {
      const oldKlassGrowths = oldKlassDef.growths ?? {};
      const newKlassGrowths = newKlassDef.growths ?? {};
      for (const stat of Object.keys(this.unit.growths)) {
        const newGrowth = newKlassGrowths[stat] ?? 0;
        const oldGrowth = oldKlassGrowths[stat] ?? 0;
        this.growthChanges[stat] = newGrowth - oldGrowth;
      }
    }

    const wexpGain = newKlassDef.wexp_gain ?? {};
    for (const [wtype, entry] of Object.entries(wexpGain)) {
      const [usable, startWexp] = entry as [boolean, number, number];
      if (usable && startWexp > 0) {
        this.newWexp[wtype] = startWexp;
      }
    }
  }

  getData(): { statChanges: Record<string, number>; newWexp: Record<string, number> } {
    return { statChanges: this.statChanges, newWexp: this.newWexp };
  }

  execute(): void {
    const game = _getGame?.();
    this.unit.klass = this.newKlass;

    // Level reset on class change (default: false)
    if (game && game.db.getConstant('class_change_level_reset', false)) {
      this.unit.exp = 0;
      this.unit.level = 1;
    }

    // Apply stat changes
    for (const [stat, change] of Object.entries(this.statChanges)) {
      if (this.unit.stats[stat] !== undefined) {
        this.unit.stats[stat] += change;
      }
    }

    // Apply growth changes
    if (this.shouldAddGrowths) {
      for (const [stat, change] of Object.entries(this.growthChanges)) {
        if (this.unit.growths[stat] !== undefined) {
          this.unit.growths[stat] += change;
        }
      }
    }

    // Update max stats to new class
    if (game) {
      const newKlassDef = game.db.classes.get(this.newKlass);
      if (newKlassDef) {
        this.unit.maxStats = { ...newKlassDef.max_stats };
      }
    }

    // Adjust current HP by the HP stat change
    const hpChange = this.statChanges['HP'] ?? 0;
    if (hpChange > 0) {
      this.unit.currentHp += hpChange;
    }
    // Clamp to new max
    this.unit.currentHp = Math.min(this.unit.currentHp, this.unit.maxHp);
  }

  reverse(): void {
    this.unit.klass = this.oldKlass;
    this.unit.level = this.oldLevel;
    this.unit.exp = this.oldExp;
    this.unit.stats = { ...this.oldStats };
    this.unit.maxStats = { ...this.oldMaxStats };
    this.unit.growths = { ...this.oldGrowths };
    this.unit.currentHp = this.oldHp;
    this.unit.wexp = { ...this.oldWexp };
  }
}
