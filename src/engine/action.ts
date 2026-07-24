import type { UnitObject } from '../objects/unit';
import type { ItemObject } from '../objects/item';
import { SkillObject } from '../objects/skill';
import type { GameBoard } from '../objects/game-board';
import type { Database } from '../data/database';
import { evaluateEquation } from '../combat/combat-calcs';
import { onPairup, onRemoveRescue, onRescue, onSeparate, isCantoSkill } from '../combat/skill-system';
import { skillCondition } from '../combat/item-system';
import { autoLevelUnit, levelUpUnit } from './leveling';
import type { InitiativeTracker } from './initiative';
import type { RegionData } from '../data/types';
import type { SupportPair } from './support-system';

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

  /**
   * Apply an action during normal gameplay. Turnwheel replay calls execute()
   * directly, so actions may override this seam for first-do-only effects.
   */
  do(): void {
    this.execute();
  }
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

export class DeleteMapValueAction extends Action {
  private values: Map<string, any>;
  private nid: string;
  private existed: boolean;
  private oldValue: any;

  constructor(values: Map<string, any>, nid: string) {
    super();
    this.values = values;
    this.nid = nid;
    this.existed = values.has(nid);
    this.oldValue = values.get(nid);
  }

  execute(): void {
    this.values.delete(this.nid);
  }

  reverse(): void {
    if (this.existed) this.values.set(this.nid, this.oldValue);
  }
}

export class ClearMapAction extends Action {
  private values: Map<string, any>;
  private oldEntries: Array<[string, any]>;

  constructor(values: Map<string, any>) {
    super();
    this.values = values;
    this.oldEntries = [...values.entries()];
  }

  execute(): void {
    this.values.clear();
  }

  reverse(): void {
    this.values.clear();
    for (const [key, value] of this.oldEntries) this.values.set(key, value);
  }
}

interface PersistentStore<T> {
  save(): T[];
  restore(entries: T[]): void;
  persist(): void;
}

/** Reversible mutation of a localStorage-backed records or achievement store. */
export class UpdatePersistentStoreAction<T, R = void> extends Action {
  private store: PersistentStore<T>;
  private mutate: () => R;
  private before: T[];
  private after: T[] | null = null;
  private mutationResult: R | undefined;

  constructor(store: PersistentStore<T>, mutate: () => R) {
    super();
    this.store = store;
    this.mutate = mutate;
    this.before = structuredClone(store.save());
  }

  execute(): void {
    if (this.after) {
      this.store.restore(structuredClone(this.after));
      this.store.persist();
      return;
    }
    this.mutationResult = this.mutate();
    this.after = structuredClone(this.store.save());
  }

  get result(): R | undefined {
    return this.mutationResult;
  }

  reverse(): void {
    this.store.restore(structuredClone(this.before));
    this.store.persist();
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
    action.do();
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
  private previousMovementLeft: number;
  private newMovementLeft: number;
  private previousHasMoved: boolean;

  constructor(
    unit: UnitObject,
    oldPos: [number, number],
    newPos: [number, number],
    board: GameBoard,
    movementCost: number = 0,
  ) {
    super();
    this.unit = unit;
    this.oldPos = oldPos;
    this.newPos = newPos;
    this.board = board;
    this.previousMovementLeft = unit.movementLeft;
    this.newMovementLeft = Math.max(0, unit.movementLeft - movementCost);
    this.previousHasMoved = unit.hasMoved;
  }

  execute(): void {
    this.board.moveUnit(this.unit, this.newPos[0], this.newPos[1]);
    this.unit.movementLeft = this.newMovementLeft;
    this.unit.hasMoved = true;
  }

  reverse(): void {
    this.board.moveUnit(this.unit, this.oldPos[0], this.oldPos[1]);
    this.unit.movementLeft = this.previousMovementLeft;
    this.unit.hasMoved = this.previousHasMoved;
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

/** Atomically exchange two on-map units without changing their turn flags. */
export class SwapUnitsAction extends Action {
  private first: UnitObject;
  private second: UnitObject;
  private board: GameBoard;
  private firstPosition: [number, number];
  private secondPosition: [number, number];

  constructor(first: UnitObject, second: UnitObject, board: GameBoard) {
    super();
    if (!first.position || !second.position) {
      throw new Error('Cannot swap an off-map unit');
    }
    this.first = first;
    this.second = second;
    this.board = board;
    this.firstPosition = [first.position[0], first.position[1]];
    this.secondPosition = [second.position[0], second.position[1]];
  }

  execute(): void {
    this.board.removeUnit(this.first);
    this.board.removeUnit(this.second);
    this.board.setUnit(this.secondPosition[0], this.secondPosition[1], this.first);
    this.board.setUnit(this.firstPosition[0], this.firstPosition[1], this.second);
  }

  reverse(): void {
    this.board.removeUnit(this.first);
    this.board.removeUnit(this.second);
    this.board.setUnit(this.firstPosition[0], this.firstPosition[1], this.first);
    this.board.setUnit(this.secondPosition[0], this.secondPosition[1], this.second);
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

/** Set current HP to an exact clamped value and restore the prior value. */
export class SetCurrentHpAction extends Action {
  private unit: UnitObject;
  private oldHp: number;
  private newHp: number;

  constructor(unit: UnitObject, hp: number) {
    super();
    this.unit = unit;
    this.oldHp = unit.currentHp;
    this.newHp = Math.max(0, Math.min(hp, unit.maxHp));
  }

  execute(): void {
    this.unit.currentHp = this.newHp;
  }

  reverse(): void {
    this.unit.currentHp = this.oldHp;
  }
}

/** Change current mana by a bounded amount and restore the exact prior state. */
export class ChangeManaAction extends Action {
  private unit: UnitObject;
  private oldMana: number | undefined;
  private newMana: number;

  constructor(unit: UnitObject, amount: number, maximum: number) {
    super();
    this.unit = unit;
    this.oldMana = unit.currentMana;
    const current = unit.currentMana ?? maximum;
    this.newMana = Math.trunc(Math.max(0, Math.min(maximum, current + amount)));
  }

  execute(): void {
    this.unit.currentMana = this.newMana;
  }

  reverse(): void {
    if (this.oldMana === undefined) delete this.unit.currentMana;
    else this.unit.currentMana = this.oldMana;
  }
}

/** Set current mana to an exact bounded value and restore the exact prior state. */
export class SetCurrentManaAction extends Action {
  private unit: UnitObject;
  private oldMana: number | undefined;
  private newMana: number;

  constructor(unit: UnitObject, mana: number, maximum: number) {
    super();
    this.unit = unit;
    this.oldMana = unit.currentMana;
    this.newMana = Math.trunc(Math.max(0, Math.min(maximum, mana)));
  }

  execute(): void {
    this.unit.currentMana = this.newMana;
  }

  reverse(): void {
    if (this.oldMana === undefined) delete this.unit.currentMana;
    else this.unit.currentMana = this.oldMana;
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

/** Python HasNotAttacked: restore attack access while preserving turn history. */
export class HasNotAttackedAction extends Action {
  private unit: UnitObject;
  private previous: boolean = false;

  constructor(unit: UnitObject) {
    super();
    this.unit = unit;
  }

  execute(): void {
    this.previous = this.unit.hasAttacked;
    this.unit.hasAttacked = false;
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
 * OnlyOnceEventAction - Mark an only_once event as triggered.
 * Mirrors Python's action.OnlyOnceEvent (game.already_triggered_events
 * append/remove), so turnwheel undo restores re-triggerability.
 */
/**
 * SetGameBoardBoundsAction - Python action.SetGameBoardBounds. Stores the
 * previous bounds tuple; do applies the new bounds, reverse restores.
 */
export class SetGameBoardBoundsAction extends Action {
  private board: any;
  private newBounds: [number, number, number, number];
  private oldBounds: [number, number, number, number] | null = null;

  constructor(board: any, bounds: [number, number, number, number]) {
    super();
    this.board = board;
    this.newBounds = bounds;
  }

  execute(): void {
    this.oldBounds = [...this.board.bounds] as [number, number, number, number];
    this.board.setBounds(...this.newBounds);
  }

  reverse(): void {
    if (this.oldBounds) this.board.setBounds(...this.oldBounds);
  }
}

/**
 * SetSkillDataAction - Python action.SetObjData applied to a skill's data map.
 * Reversible: restores the previous value (or deletes a key that was absent).
 */
export class SetSkillDataAction extends Action {
  private skill: any;
  private key: string;
  private value: any;
  private hadKey = false;
  private oldValue: any;

  constructor(skill: any, key: string, value: any) {
    super();
    this.skill = skill;
    this.key = key;
    this.value = value;
  }

  execute(): void {
    this.hadKey = this.skill.data.has(this.key);
    this.oldValue = this.skill.data.get(this.key);
    this.skill.data.set(this.key, this.value);
  }

  reverse(): void {
    if (this.hadKey) this.skill.data.set(this.key, this.oldValue);
    else this.skill.data.delete(this.key);
  }
}

/**
 * Component-modification actions (Python action.py AddItemComponent /
 * ModifyItemComponent / RemoveItemComponent and their skill twins). Web items
 * and skills both store components as Map<string, any>, so one trio serves
 * both. Values are raw component values (Python wraps them in component
 * instances; the web reads values directly).
 */
export class AddObjComponentAction extends Action {
  private hadKey = false;
  private oldValue: any;
  private obj: { components: Map<string, any> };
  private nid: string;
  private value: any;
  constructor(obj: { components: Map<string, any> }, nid: string, value: any) {
    super();
    this.obj = obj;
    this.nid = nid;
    this.value = value;
  }
  execute(): void {
    this.hadKey = this.obj.components.has(this.nid);
    this.oldValue = this.obj.components.get(this.nid);
    this.obj.components.set(this.nid, this.value ?? true);
  }
  reverse(): void {
    if (this.hadKey) this.obj.components.set(this.nid, this.oldValue);
    else this.obj.components.delete(this.nid);
  }
}

export class ModifyObjComponentAction extends Action {
  private prev: any;
  private hadKey = false;
  private obj: { components: Map<string, any> };
  private nid: string;
  private value: any;
  private property: string | null;
  private additive: boolean;
  constructor(
    obj: { components: Map<string, any> },
    nid: string,
    value: any,
    property: string | null = null,
    additive: boolean = false,
  ) {
    super();
    this.obj = obj;
    this.nid = nid;
    this.value = value;
    this.property = property;
    this.additive = additive;
  }
  execute(): void {
    this.hadKey = this.obj.components.has(this.nid);
    if (!this.hadKey) return; // Python errors upstream; no-op like a guarded call
    const current = this.obj.components.get(this.nid);
    if (this.property && current && typeof current === 'object' && !Array.isArray(current)) {
      this.prev = current[this.property];
      current[this.property] = this.additive && typeof this.prev === 'number'
        ? this.prev + this.value : this.value;
    } else {
      this.prev = current;
      this.obj.components.set(
        this.nid,
        this.additive && typeof current === 'number' ? current + this.value : this.value,
      );
    }
  }
  reverse(): void {
    if (!this.hadKey) return;
    const current = this.obj.components.get(this.nid);
    if (this.property && current && typeof current === 'object' && !Array.isArray(current)) {
      current[this.property] = this.prev;
    } else {
      this.obj.components.set(this.nid, this.prev);
    }
  }
}

export class RemoveObjComponentAction extends Action {
  private hadKey = false;
  private oldValue: any;
  private obj: { components: Map<string, any> };
  private nid: string;
  constructor(obj: { components: Map<string, any> }, nid: string) {
    super();
    this.obj = obj;
    this.nid = nid;
  }
  execute(): void {
    this.hadKey = this.obj.components.has(this.nid);
    this.oldValue = this.obj.components.get(this.nid);
    this.obj.components.delete(this.nid);
  }
  reverse(): void {
    if (this.hadKey) this.obj.components.set(this.nid, this.oldValue);
  }
}

/**
 * RecruitGenericAction - Python recruit_generic's composite (SetPersistent +
 * SetNid + SetName + owner re-keys). The web registry keys units by nid, so
 * the nid change re-keys game.units; item owner references are live object
 * refs and need no re-keying.
 */
export class RecruitGenericAction extends Action {
  private game: any;
  private unit: any;
  private newNid: string;
  private newName: string | null;
  private oldNid = '';
  private oldName = '';
  private oldPersistent = false;

  constructor(game: any, unit: any, newNid: string, newName: string | null) {
    super();
    this.game = game;
    this.unit = unit;
    this.newNid = newNid;
    this.newName = newName;
  }

  execute(): void {
    this.oldNid = this.unit.nid;
    this.oldName = this.unit.name;
    this.oldPersistent = this.unit.persistent;
    this.unit.persistent = true;
    (this.unit as any).nid = this.newNid;
    if (this.newName) (this.unit as any).name = this.newName;
    this.game.units.delete(this.oldNid);
    this.game.units.set(this.newNid, this.unit);
  }

  reverse(): void {
    this.game.units.delete(this.newNid);
    (this.unit as any).nid = this.oldNid;
    (this.unit as any).name = this.oldName;
    this.unit.persistent = this.oldPersistent;
    this.game.units.set(this.oldNid, this.unit);
  }
}

/** Reassign one unit to a party and restore its prior party exactly. */
export class SetUnitPartyAction extends Action {
  private unit: UnitObject;
  private nextParty: string;
  private oldParty: string;

  constructor(unit: UnitObject, nextParty: string) {
    super();
    this.unit = unit;
    this.nextParty = nextParty;
    this.oldParty = unit.party;
  }

  execute(): void {
    this.unit.party = this.nextParty;
  }

  reverse(): void {
    this.unit.party = this.oldParty;
  }
}

/**
 * MergePartiesAction - Python merge_parties composite: guest units move to the
 * host party; guest convoy/money/bexp transfer to host. Exact reverse.
 */
export class MergePartiesAction extends Action {
  private game: any;
  private hostNid: string;
  private guestNid: string;
  private movedUnitNids: string[] = [];
  private movedItems: any[] = [];
  private movedMoney = 0;
  private movedBexp = 0;

  constructor(game: any, hostNid: string, guestNid: string) {
    super();
    this.game = game;
    this.hostNid = hostNid;
    this.guestNid = guestNid;
  }

  execute(): void {
    const host = this.game.parties.get(this.hostNid);
    const guest = this.game.parties.get(this.guestNid);
    if (!host || !guest) return;
    this.movedUnitNids = [];
    for (const unit of this.game.units.values()) {
      if (unit.party === this.guestNid) {
        unit.party = this.hostNid;
        this.movedUnitNids.push(unit.nid);
      }
    }
    this.movedItems = [...guest.convoy];
    for (const item of this.movedItems) host.convoy.push(item);
    guest.convoy.length = 0;
    this.movedMoney = guest.money;
    this.movedBexp = guest.bexp;
    host.money += this.movedMoney;
    guest.money = 0;
    host.bexp += this.movedBexp;
    guest.bexp = 0;
  }

  reverse(): void {
    const host = this.game.parties.get(this.hostNid);
    const guest = this.game.parties.get(this.guestNid);
    if (!host || !guest) return;
    for (const nid of this.movedUnitNids) {
      const unit = this.game.units.get(nid);
      if (unit) unit.party = this.guestNid;
    }
    for (const item of this.movedItems) {
      const idx = host.convoy.indexOf(item);
      if (idx !== -1) host.convoy.splice(idx, 1);
      guest.convoy.push(item);
    }
    host.money -= this.movedMoney;
    guest.money += this.movedMoney;
    host.bexp -= this.movedBexp;
    guest.bexp += this.movedBexp;
  }
}

/** ChangeFatigueAction - Python action.ChangeFatigue (clamped at >= 0). */
export class ChangeFatigueAction extends Action {
  private unit: any;
  private amount: number;
  private old = 0;
  constructor(unit: any, amount: number) {
    super();
    this.unit = unit;
    this.amount = amount;
  }
  execute(): void {
    this.old = this.unit.currentFatigue ?? 0;
    this.unit.currentFatigue = Math.max(0, this.old + this.amount);
  }
  reverse(): void {
    this.unit.currentFatigue = this.old;
  }
}

/** LeaveMapAction - Python action.LeaveMap: clears position, restores exactly. */
export class LeaveMapAction extends Action {
  private game: any;
  private unit: any;
  private oldPos: [number, number] | null = null;
  private initiativeLine: string[] | null = null;
  private initiativeValues: number[] | null = null;
  private initiativeIndex = -1;
  constructor(game: any, unit: any) {
    super();
    this.game = game;
    this.unit = unit;
  }
  execute(): void {
    this.oldPos = this.unit.position ? [...this.unit.position] as [number, number] : null;
    if (this.game.initiative) {
      this.initiativeLine = [...this.game.initiative.unitLine];
      this.initiativeValues = [...this.game.initiative.initiativeLine];
      this.initiativeIndex = this.game.initiative.currentIdx;
      this.game.initiative.removeUnit(this.unit);
    }
    if (this.oldPos && this.game.board) this.game.board.removeUnit(this.unit);
    this.unit.position = null;
  }
  reverse(): void {
    if (this.oldPos) {
      this.unit.position = this.oldPos;
      if (this.game.board) this.game.board.setUnit(this.oldPos[0], this.oldPos[1], this.unit);
    }
    if (this.game.initiative && this.initiativeLine && this.initiativeValues) {
      this.game.initiative.unitLine = [...this.initiativeLine];
      this.game.initiative.initiativeLine = [...this.initiativeValues];
      this.game.initiative.currentIdx = this.initiativeIndex;
    }
  }
}

/** Place a unit on the map and restore its prior board position on rewind. */
export class ArriveOnMapAction extends Action {
  private game: any;
  private unit: UnitObject;
  private position: [number, number];
  private oldPosition: [number, number] | null;
  private addToInitiative: boolean;
  private addedToInitiative = false;

  constructor(
    game: any,
    unit: UnitObject,
    position: [number, number],
    addToInitiative: boolean = false,
  ) {
    super();
    this.game = game;
    this.unit = unit;
    this.position = position;
    this.oldPosition = unit.position ? [...unit.position] as [number, number] : null;
    this.addToInitiative = addToInitiative;
  }

  execute(): void {
    if (this.unit.position && this.game.board) this.game.board.removeUnit(this.unit);
    this.unit.position = [...this.position];
    this.game.board?.setUnit(this.position[0], this.position[1], this.unit);
    if (this.addToInitiative && this.game.initiative &&
        !this.game.initiative.unitLine.includes(this.unit.nid)) {
      this.game.initiative.insertUnit(this.unit, this.game.db);
      this.addedToInitiative = true;
    }
  }

  reverse(): void {
    if (this.unit.position && this.game.board) this.game.board.removeUnit(this.unit);
    if (this.addedToInitiative && this.game.initiative) {
      this.game.initiative.removeUnit(this.unit);
      this.addedToInitiative = false;
    }
    this.unit.position = this.oldPosition ? [...this.oldPosition] : null;
    if (this.oldPosition) {
      this.game.board?.setUnit(this.oldPosition[0], this.oldPosition[1], this.unit);
    }
  }
}

/** Add one permanent unit-following map animation, reversibly. */
export class AddAnimToUnitAction extends Action {
  private game: any;
  private anim: any;
  constructor(game: any, anim: any) {
    super();
    this.game = game;
    this.anim = anim;
  }
  execute(): void {
    if (this.game.tilemap && !this.game.tilemap.animations.includes(this.anim)) {
      this.anim.done = false;
      this.game.tilemap.animations.push(this.anim);
    }
  }
  reverse(): void {
    if (this.game.tilemap) {
      const idx = this.game.tilemap.animations.indexOf(this.anim);
      if (idx !== -1) this.game.tilemap.animations.splice(idx, 1);
    }
  }
}

export class RemoveAnimFromUnitAction extends Action {
  private game: any;
  private animNid: string;
  private unit: any;
  private removed: any[] = [];
  constructor(game: any, animNid: string, unit: any) {
    super();
    this.game = game;
    this.animNid = animNid;
    this.unit = unit;
  }
  execute(): void {
    if (!this.game.tilemap) return;
    this.removed = this.game.tilemap.animations.filter(
      (a: any) => a.nid === this.animNid && a.followUnit === this.unit,
    );
    this.game.tilemap.animations = this.game.tilemap.animations.filter(
      (a: any) => !this.removed.includes(a),
    );
  }
  reverse(): void {
    if (this.game.tilemap) this.game.tilemap.animations.push(...this.removed);
  }
}

/** ChangeBgTilemapAction - Python action.ChangeBGTileMap: swaps the level's
 * background tilemap object; reverse restores the previous one (or none). */
export class ChangeBgTilemapAction extends Action {
  private game: any;
  private newTilemap: any | null;
  private oldTilemap: any | null = null;
  constructor(game: any, newTilemap: any | null) {
    super();
    this.game = game;
    this.newTilemap = newTilemap;
  }
  execute(): void {
    this.oldTilemap = this.game.bgTilemap;
    this.game.setBgTilemap(this.newTilemap);
  }
  reverse(): void {
    this.game.setBgTilemap(this.oldTilemap);
  }
}

/** ChangeTeamPaletteAction - Python action.ChangeTeamPalette: overrides a
 * team's map-sprite palette / combat color at runtime, reversibly, and
 * rebuilds affected map sprites (cache-keyed by palette, so a lazy reload
 * picks up the new colors). Combat-variant battle-anim palettes are not yet
 * routed (documented deferral). */
export class ChangeTeamPaletteAction extends Action {
  private game: any;
  private teamNid: string;
  private next: { palette?: string; combatColor?: string };
  private hadPrev = false;
  private prev: { palette?: string; combatColor?: string } | undefined;

  constructor(game: any, teamNid: string, next: { palette?: string; combatColor?: string }) {
    super();
    this.game = game;
    this.teamNid = teamNid;
    this.next = next;
  }

  private apply(value: { palette?: string; combatColor?: string } | undefined): void {
    if (value === undefined) this.game.teamPaletteOverrides.delete(this.teamNid);
    else this.game.teamPaletteOverrides.set(this.teamNid, value);
    void this.game.loadAllMapSprites?.();
  }

  execute(): void {
    this.hadPrev = this.game.teamPaletteOverrides.has(this.teamNid);
    this.prev = this.game.teamPaletteOverrides.get(this.teamNid);
    this.apply(this.next);
  }

  reverse(): void {
    this.apply(this.hadPrev ? this.prev : undefined);
  }
}

/** SpendBexpAction - reversible party bonus-EXP spend (Python GiveBexp -N). */
export class SpendBexpAction extends Action {
  private party: any;
  private amount: number;
  constructor(party: any, amount: number) {
    super();
    this.party = party;
    this.amount = amount;
  }
  execute(): void { this.party.bexp -= this.amount; }
  reverse(): void { this.party.bexp += this.amount; }
}

/** ChangeRoamAiAction - Python action.ChangeRoamAI, reversible. */
export class ChangeRoamAiAction extends Action {
  private unit: any;
  private next: string | null;
  private prev: string | null = null;
  constructor(unit: any, next: string | null) {
    super();
    this.unit = unit;
    this.next = next;
  }
  execute(): void { this.prev = this.unit.roamAi ?? null; this.unit.roamAi = this.next; }
  reverse(): void { this.unit.roamAi = this.prev; }
}

export class OnlyOnceEventAction extends Action {
  private eventNid: string;
  private onceTriggered: Set<string>;

  constructor(eventNid: string, onceTriggered: Set<string>) {
    super();
    this.eventNid = eventNid;
    this.onceTriggered = onceTriggered;
  }

  execute(): void {
    this.onceTriggered.add(this.eventNid);
  }

  reverse(): void {
    this.onceTriggered.delete(this.eventNid);
  }
}

/**
 * CreateUnitAction - Registers a freshly-constructed UnitObject into
 * `game.units` and (optionally) places it on the board. Mirrors Python's
 * `action.do(action.RegisterUnit(new_unit))` inside event_functions.create_unit —
 * the unit itself is built eagerly (GameState.buildUnit), but registration/
 * placement is deferred into this action so turnwheel rewind can fully
 * un-create the unit.
 */
export class CreateUnitAction extends Action {
  private game: any;
  private unit: UnitObject;
  private position: [number, number] | null;
  private addToInitiative: boolean;

  constructor(
    game: any,
    unit: UnitObject,
    position: [number, number] | null,
    addToInitiative: boolean = false,
  ) {
    super();
    this.game = game;
    this.unit = unit;
    this.position = position;
    this.addToInitiative = addToInitiative;
  }

  execute(): void {
    this.game.registerUnit(this.unit, this.position);
    if (this.addToInitiative && this.game.initiative &&
        !this.game.initiative.unitLine.includes(this.unit.nid)) {
      this.game.initiative.insertUnit(this.unit, this.game.db);
    }
  }

  reverse(): void {
    if (this.unit.position && this.game.board) {
      this.game.board.removeUnit(this.unit);
    }
    if (this.addToInitiative && this.game.initiative) {
      this.game.initiative.removeUnit(this.unit);
    }
    this.game.units.delete(this.unit.nid);
  }
}

/**
 * AddRegionAction - Add a region to the current level's region list.
 * Mirrors Python's action.AddRegion.
 */
export class AddRegionAction extends Action {
  private region: RegionData;
  private regions: RegionData[];
  private didAdd: boolean = false;

  constructor(region: RegionData, regions: RegionData[]) {
    super();
    this.region = region;
    this.regions = regions;
  }

  execute(): void {
    if (this.regions.some((r) => r.nid === this.region.nid)) {
      this.didAdd = false;
      return;
    }
    this.regions.push(this.region);
    this.didAdd = true;
  }

  reverse(): void {
    if (!this.didAdd) return;
    const idx = this.regions.indexOf(this.region);
    if (idx !== -1) this.regions.splice(idx, 1);
  }
}

/**
 * RemoveRegionAction - Remove a region from the current level's region list.
 * Mirrors Python's action.RemoveRegion.
 */
export class RemoveRegionAction extends Action {
  private regionNid: string;
  private regions: RegionData[];
  private removed: RegionData | null = null;
  private removedIndex: number = -1;

  constructor(regionNid: string, regions: RegionData[]) {
    super();
    this.regionNid = regionNid;
    this.regions = regions;
  }

  execute(): void {
    const idx = this.regions.findIndex((r) => r.nid === this.regionNid);
    if (idx === -1) {
      this.removed = null;
      this.removedIndex = -1;
      return;
    }
    this.removed = this.regions[idx];
    this.removedIndex = idx;
    this.regions.splice(idx, 1);
  }

  reverse(): void {
    if (!this.removed) return;
    const idx = Math.min(this.removedIndex, this.regions.length);
    this.regions.splice(idx, 0, this.removed);
  }
}

/** Advance one unit's timed status effects and restore HP/durations exactly. */
export class ProcessStatusEffectsAction extends Action {
  private unit: UnitObject;
  private oldHp: number;
  private oldEffects: UnitObject['statusEffects'];
  damage = 0;

  constructor(unit: UnitObject) {
    super();
    this.unit = unit;
    this.oldHp = unit.currentHp;
    this.oldEffects = unit.statusEffects.map((effect) => ({
      ...effect,
      statMods: { ...effect.statMods },
    }));
  }

  execute(): void {
    this.unit.currentHp = this.oldHp;
    this.unit.statusEffects = this.oldEffects.map((effect) => ({
      ...effect,
      statMods: { ...effect.statMods },
    }));
    this.damage = this.unit.processStatusEffects();
  }

  reverse(): void {
    this.unit.currentHp = this.oldHp;
    this.unit.statusEffects = this.oldEffects.map((effect) => ({
      ...effect,
      statMods: { ...effect.statMods },
    }));
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
 * ResetAction - Restore one unit's full action state and movement budget.
 * Mirrors Python action.Reset, including every rescue/trade flag and
 * turnwheel restoration of the exact prior state.
 */
export class ResetAction extends Action {
  private unit: UnitObject;
  private savedState: {
    hasAttacked: boolean;
    hasMoved: boolean;
    hasTraded: boolean;
    finished: boolean;
    hasRescued: boolean;
    hasDropped: boolean;
    hasTaken: boolean;
    hasGiven: boolean;
    movementLeft: number;
  } | null = null;

  constructor(unit: UnitObject) {
    super();
    this.unit = unit;
  }

  execute(): void {
    this.savedState = {
      hasAttacked: this.unit.hasAttacked,
      hasMoved: this.unit.hasMoved,
      hasTraded: this.unit.hasTraded,
      finished: this.unit.finished,
      hasRescued: this.unit.hasRescued,
      hasDropped: this.unit.hasDropped,
      hasTaken: this.unit.hasTaken,
      hasGiven: this.unit.hasGiven,
      movementLeft: this.unit.movementLeft,
    };
    this.unit.resetTurnState();
    this.unit.movementLeft = this.unit.getMovement();
  }

  reverse(): void {
    if (!this.savedState) return;
    Object.assign(this.unit, this.savedState);
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
  private startStats: Record<string, number> = {};
  private startGrowthPoints: Record<string, number> = {};
  private startHp: number = 0;

  constructor(unit: UnitObject, amount: number, growthMode: string = 'random') {
    super();
    this.unit = unit;
    this.amount = amount;
    this.growthMode = growthMode;
  }

  execute(): void {
    this.startExp = this.unit.exp;
    this.startLevel = this.unit.level;
    this.startStats = { ...this.unit.stats };
    this.startGrowthPoints = { ...this.unit.growthPoints };
    this.startHp = this.unit.currentHp;
    this.levelUps = [];

    this.unit.exp += this.amount;
    while (this.unit.exp >= 100) {
      this.unit.exp -= 100;
      const game = _getGame?.();
      const gains = game
        ? levelUpUnit(this.unit, this.growthMode, game)
        : this.unit.levelUp(this.growthMode);
      this.levelUps.push(gains);
    }
  }

  reverse(): void {
    this.unit.stats = { ...this.startStats };
    this.unit.growthPoints = { ...this.startGrowthPoints };
    this.unit.currentHp = this.startHp;
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

/** Apply cap-clamped permanent stat changes with exact HP and turnwheel restoration. */
export class ApplyStatChangesAction extends Action {
  private unit: UnitObject;
  private requested: Record<string, number>;
  private beforeStats: Record<string, number>;
  private beforeHp: number;
  private afterStats: Record<string, number> | null = null;
  private afterHp: number = 0;
  private applied: Record<string, number> = {};

  constructor(unit: UnitObject, requested: Record<string, number>) {
    super();
    this.unit = unit;
    this.requested = { ...requested };
    this.beforeStats = { ...unit.stats };
    this.beforeHp = unit.currentHp;
  }

  execute(): void {
    if (this.afterStats) {
      this.unit.stats = { ...this.afterStats };
      this.unit.currentHp = this.afterHp;
      return;
    }
    const oldMaxHp = this.unit.maxHp;
    for (const [stat, requested] of Object.entries(this.requested)) {
      if (this.unit.stats[stat] === undefined || !Number.isFinite(requested)) continue;
      const current = this.unit.stats[stat];
      const amount = Math.max(-current, Math.min(requested, this.unit.getStatCap(stat) - current));
      this.unit.stats[stat] = current + amount;
      this.applied[stat] = amount;
    }
    const maxHpIncrease = Math.max(0, this.unit.maxHp - oldMaxHp);
    this.unit.currentHp = Math.max(0, Math.min(this.unit.maxHp, this.unit.currentHp + maxHpIncrease));
    this.afterStats = { ...this.unit.stats };
    this.afterHp = this.unit.currentHp;
  }

  reverse(): void {
    this.unit.stats = { ...this.beforeStats };
    this.unit.currentHp = this.beforeHp;
  }

  getAppliedChanges(): Record<string, number> {
    return { ...this.applied };
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
  private movedItem: ItemObject | null = null;
  private direction: 'swap' | 'a_to_b' | 'b_to_a' | 'none' = 'none';

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
      this.direction = 'swap';
      this.unitA.items[this.indexA] = itemB;
      this.unitB.items[this.indexB] = itemA;
      itemA.owner = this.unitB;
      itemB.owner = this.unitA;
      this.unitA.onRemoveItem(itemA);
      this.unitA.onAddItem(itemB);
      this.unitB.onRemoveItem(itemB);
      this.unitB.onAddItem(itemA);
    } else if (itemA && !itemB) {
      // Move A to B
      this.direction = 'a_to_b';
      this.movedItem = itemA;
      this.unitA.items.splice(this.indexA, 1);
      this.unitB.items.push(itemA);
      itemA.owner = this.unitB;
      this.unitA.onRemoveItem(itemA);
      this.unitB.onAddItem(itemA);
    } else if (!itemA && itemB) {
      // Move B to A
      this.direction = 'b_to_a';
      this.movedItem = itemB;
      this.unitB.items.splice(this.indexB, 1);
      this.unitA.items.push(itemB);
      itemB.owner = this.unitA;
      this.unitB.onRemoveItem(itemB);
      this.unitA.onAddItem(itemB);
    }

    this.unitA.autoequip();
    this.unitB.autoequip();
  }

  reverse(): void {
    if (this.direction === 'swap') {
      const itemA = this.unitA.items[this.indexA];
      const itemB = this.unitB.items[this.indexB];
      if (itemA && itemB) {
        this.unitA.items[this.indexA] = itemB;
        this.unitB.items[this.indexB] = itemA;
        itemA.owner = this.unitB;
        itemB.owner = this.unitA;
        this.unitA.onRemoveItem(itemB);
        this.unitA.onAddItem(itemA);
        this.unitB.onRemoveItem(itemA);
        this.unitB.onAddItem(itemB);
      }
    } else if (this.direction === 'a_to_b' && this.movedItem) {
      const idx = this.unitB.items.indexOf(this.movedItem);
      if (idx >= 0) this.unitB.items.splice(idx, 1);
      this.unitA.items.splice(this.indexA, 0, this.movedItem);
      this.movedItem.owner = this.unitA;
      this.unitB.onRemoveItem(this.movedItem);
      this.unitA.onAddItem(this.movedItem);
    } else if (this.direction === 'b_to_a' && this.movedItem) {
      const idx = this.unitA.items.indexOf(this.movedItem);
      if (idx >= 0) this.unitA.items.splice(idx, 1);
      this.unitB.items.splice(this.indexB, 0, this.movedItem);
      this.movedItem.owner = this.unitB;
      this.unitA.onRemoveItem(this.movedItem);
      this.unitB.onAddItem(this.movedItem);
    }

    this.unitA.autoequip();
    this.unitB.autoequip();
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
  private tetherActions: RemoveSkillAction[] = [];
  private initializedTether = false;

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
    if (!this.initializedTether) {
      this.initializedTether = true;
      const game = _getGame?.();
      if (game && this.unit.skills.some((skill) =>
        skill.hasComponent('death_tether') && skillCondition(skill, this.unit, game))) {
        this.tetherActions = [...game.units.values()].flatMap((other: UnitObject) =>
          other.skills
            .filter((skill) => skill.initiatorNid === this.unit.nid)
            .map((skill) => new RemoveSkillAction(other, skill)));
      }
    }
    for (const action of this.tetherActions) action.execute();
  }

  reverse(): void {
    for (const action of [...this.tetherActions].reverse()) action.reverse();
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

      if (this.unit.equippedWeapon === this.item || this.unit.equippedAccessory === this.item) {
        this.unit.unequip(this.item);
      }
      this.unit.autoequip();
      this.unit.onRemoveItem(this.item);
    }
  }

  reverse(): void {
    if (this.broken) {
      this.unit.items.push(this.item);
      this.unit.onAddItem(this.item);
    }
    this.item.setUses(this.usesBefore);
    this.unit.autoequip();
  }
}

/** Give a newly-created item to a unit and remove it exactly on rewind. */
export class GiveItemAction extends Action {
  private unit: UnitObject;
  private item: ItemObject;
  private index: number;

  constructor(unit: UnitObject, item: ItemObject) {
    super();
    this.unit = unit;
    this.item = item;
    this.index = unit.items.length;
  }

  execute(): void {
    if (!this.unit.items.includes(this.item)) {
      this.unit.items.splice(Math.min(this.index, this.unit.items.length), 0, this.item);
    }
    this.item.owner = this.unit;
    this.unit.onAddItem(this.item);
    this.unit.autoequip();
  }

  reverse(): void {
    const index = this.unit.items.indexOf(this.item);
    if (index >= 0) this.unit.items.splice(index, 1);
    if (this.unit.equippedWeapon === this.item || this.unit.equippedAccessory === this.item) {
      this.unit.unequip(this.item);
    }
    this.item.owner = null;
    this.unit.onRemoveItem(this.item);
    this.unit.autoequip();
  }
}

/** Register a newly-created item tree in the global item identity map. */
export class RegisterItemTreeAction extends Action {
  private items: Map<string, ItemObject>;
  private entries: Array<[string, ItemObject]>;

  constructor(items: Map<string, ItemObject>, root: ItemObject, key: string) {
    super();
    this.items = items;
    this.entries = [];
    const collect = (item: ItemObject, itemKey: string) => {
      this.entries.push([itemKey, item]);
      item.subitems.forEach((child, index) =>
        collect(child, `${itemKey}_sub_${index}_${child.nid}`));
    };
    collect(root, key);
  }

  execute(): void {
    for (const [key, item] of this.entries) this.items.set(key, item);
  }

  reverse(): void {
    for (const [key, item] of [...this.entries].reverse()) {
      if (this.items.get(key) === item) this.items.delete(key);
    }
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
    this.unit.onAddItem(this.item);
    this.unit.autoequip();
  }

  reverse(): void {
    const game = _getGame?.();
    if (!game) return;
    const idx = this.unit.items.indexOf(this.item);
    if (idx !== -1) this.unit.items.splice(idx, 1);
    this.item.owner = null;
    this.unit.onRemoveItem(this.item);
    const party = game.getParty(this.partyNid);
    if (party) party.convoy.push(this.item);
    this.unit.autoequip();
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
    // If the removed item was equipped, autoequip a replacement (Python remove_item).
    if (this.unit.equippedWeapon === this.item || this.unit.equippedAccessory === this.item) {
      this.unit.unequip(this.item);
      this.unit.autoequip();
    }
    this.unit.onRemoveItem(this.item);
  }

  reverse(): void {
    this.unit.items.splice(this.itemIndex, 0, this.item);
    this.item.owner = this.unit;
    this.unit.onAddItem(this.item);
    this.unit.autoequip();
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
    this.source.onRemoveItem(this.item);
    this.target.onAddItem(this.item);
    this.source.autoequip();
    this.target.autoequip();
  }

  reverse(): void {
    const index = this.target.items.indexOf(this.item);
    if (index >= 0) this.target.items.splice(index, 1);
    this.source.items.splice(this.sourceIndex, 0, this.item);
    this.item.owner = this.source;
    this.target.onRemoveItem(this.item);
    this.source.onAddItem(this.item);
    this.source.autoequip();
    this.target.autoequip();
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
    this.unit.autoequip();
    this.unit.onRemoveItem(this.item);
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
    this.unit.onAddItem(this.item);
    this.unit.autoequip();
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
    this.unit.onRemoveItem(this.unitItem);
    this.unit.onAddItem(this.convoyItem);
    this.unit.autoequip();
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
    this.unit.onRemoveItem(this.convoyItem);
    this.unit.onAddItem(this.unitItem);
    this.unit.autoequip();
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

/** Set EXP without applying a level-up, matching Python SetExp. */
export class SetUnitExpAction extends Action {
  private unit: UnitObject;
  private oldExp: number;
  private newExp: number;

  constructor(unit: UnitObject, exp: number) {
    super();
    this.unit = unit;
    this.oldExp = unit.exp;
    this.newExp = Math.max(0, Math.min(99, exp));
  }

  execute(): void {
    this.unit.exp = this.newExp;
  }

  reverse(): void {
    this.unit.exp = this.oldExp;
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
  private multiSkillActions: AddSkillAction[] = [];
  private initializedMultiSkill = false;
  private statusReactionActions: Action[] = [];
  private initializedStatusReactions = false;

  constructor(unit: UnitObject, skill: SkillObject) {
    super();
    this.unit = unit;
    this.skill = skill;
  }

  execute(): void {
    this.added = !this.unit.skills.some((skill) => skill.nid === this.skill.nid);
    if (this.added) this.unit.skills.push(this.skill);
    if (isCantoSkill(this.skill)) this.unit.hasCanto = true;
    if (!this.added) return;
    if (!this.initializedMultiSkill) {
      this.initializedMultiSkill = true;
      const childNids = this.skill.getComponent<unknown>('multi_skill');
      const game = _getGame?.();
      if (Array.isArray(childNids) && game?.db) {
        for (const childNid of childNids) {
          if (typeof childNid !== 'string' || childNid === this.skill.nid) continue;
          const prefab = game.db.skills.get(childNid);
          if (!prefab) continue;
          const child = new SkillObject(prefab);
          child.data.set('multiSkillSource', this.skill);
          child.data.set('multiSkillSourceType', 'multi_skill');
          this.multiSkillActions.push(new AddSkillAction(this.unit, child));
        }
      }
    }
    for (const action of this.multiSkillActions) action.execute();
    if (!this.initializedStatusReactions) {
      this.initializedStatusReactions = true;
      const game = _getGame?.();
      if (game) {
        for (const protector of [...this.unit.skills]) {
          if (protector === this.skill) continue;
          if (!skillCondition(protector, this.unit, game)) continue;
          if (protector.hasComponent('reflect_status') && this.skill.initiatorNid) {
            const initiator = game.units.get(this.skill.initiatorNid);
            const prefab = game.db.skills.get(this.skill.nid);
            if (initiator && prefab) {
              this.statusReactionActions.push(
                new AddSkillAction(initiator, new SkillObject(prefab)),
              );
            }
          }
          if (protector.hasComponent('immune_status') && this.skill.hasComponent('negative')) {
            this.statusReactionActions.push(new RemoveSkillAction(this.unit, this.skill));
          }
        }
      }
    }
    for (const action of this.statusReactionActions) action.execute();
  }

  reverse(): void {
    if (this.added) {
      for (const action of [...this.statusReactionActions].reverse()) action.reverse();
      const index = this.unit.skills.indexOf(this.skill);
      if (index >= 0) this.unit.skills.splice(index, 1);
      for (const action of [...this.multiSkillActions].reverse()) action.reverse();
    }
    this.unit.hasCanto = this.unit.skills.some(isCantoSkill);
  }
}

/** Remove one runtime skill instance and restore its original slot on rewind. */
export class RemoveSkillAction extends Action {
  private unit: UnitObject;
  private skill: SkillObject;
  private index: number = -1;
  private multiSkillActions: RemoveSkillAction[] = [];
  private initializedMultiSkill = false;

  constructor(unit: UnitObject, skill: SkillObject) {
    super();
    this.unit = unit;
    this.skill = skill;
  }

  private didRunOnRemoveHook: boolean = false;

  override do(): void {
    this.execute();
    if (this.didRunOnRemoveHook || this.index < 0) return;
    this.didRunOnRemoveHook = true;

    const eventNid = this.skill.getComponent<unknown>('event_on_remove');
    if (typeof eventNid !== 'string' || eventNid.length === 0) return;

    const game = _getGame?.();
    if (!game?.db?.events?.has?.(eventNid)) return;
    game.eventManager?.triggerSpecific(eventNid, {
      type: 'event_on_remove',
      unit1: this.unit,
    });
  }
  execute(): void {
    this.index = this.unit.skills.indexOf(this.skill);
    if (this.index >= 0) this.unit.skills.splice(this.index, 1);
    if (this.index >= 0) {
      if (!this.initializedMultiSkill) {
        this.initializedMultiSkill = true;
        this.multiSkillActions = this.unit.skills
          .filter((candidate) => candidate.data.get('multiSkillSource') === this.skill)
          .map((candidate) => new RemoveSkillAction(this.unit, candidate));
      }
      for (const action of this.multiSkillActions) action.execute();
    }
    this.unit.hasCanto = this.unit.skills.some(isCantoSkill);
  }

  reverse(): void {
    if (this.index >= 0 && !this.unit.skills.includes(this.skill)) {
      this.unit.skills.splice(this.index, 0, this.skill);
    }
    for (const action of [...this.multiSkillActions].reverse()) action.reverse();
    if (isCantoSkill(this.skill)) this.unit.hasCanto = true;
  }
}

// ------------------------------------------------------------------
// Equipped-item lifecycle (Python EquipItem / UnequipItem / BringToTopItem)
// ------------------------------------------------------------------

/**
 * Reversibly equip an item, mirroring Python `action.EquipItem`.
 * Captures the previously-equipped item in the same slot so the turnwheel
 * can restore it. `persistThroughMenuCancel` keeps the choice when the
 * player backs out of the subsequent targeting menu.
 */
export class EquipItemAction extends Action {
  persistThroughMenuCancel = true;
  private unit: UnitObject;
  private item: ItemObject;
  private previousEquipped: ItemObject | null;

  constructor(unit: UnitObject, item: ItemObject) {
    super();
    this.unit = unit;
    this.item = item;
    this.previousEquipped = item.isAccessory()
      ? unit.equippedAccessory
      : unit.equippedWeapon;
  }

  execute(): void {
    this.unit.equip(this.item);
  }

  reverse(): void {
    this.unit.unequip(this.item);
    if (this.previousEquipped) this.unit.equip(this.previousEquipped);
  }
}

/**
 * Reversibly unequip an item, mirroring Python `action.UnequipItem`.
 * Unequipping auto-equips the next valid item in the same slot, so the
 * reverse restores the original item.
 */
export class UnequipItemAction extends Action {
  private unit: UnitObject;
  private item: ItemObject;
  private isEquippedWeapon: boolean;
  private isEquippedAccessory: boolean;

  constructor(unit: UnitObject, item: ItemObject) {
    super();
    this.unit = unit;
    this.item = item;
    this.isEquippedWeapon = item === unit.equippedWeapon;
    this.isEquippedAccessory = item === unit.equippedAccessory;
  }

  execute(): void {
    if (!this.isEquippedWeapon && !this.isEquippedAccessory) return;
    this.unit.unequip(this.item);
    // Unequip auto-equips the next valid item in the same slot (Python behavior).
    const lookingForAccessory = this.isEquippedAccessory;
    for (const candidate of this.unit.items) {
      if (candidate === this.item) continue;
      if (candidate.isAccessory() !== lookingForAccessory) continue;
      if (this.unit.canEquip(candidate)) {
        this.unit.equip(candidate);
        break;
      }
    }
  }

  reverse(): void {
    if (this.isEquippedWeapon || this.isEquippedAccessory) {
      this.unit.equip(this.item);
    }
  }
}

/**
 * Move an item to the front of inventory, mirroring Python `BringToTopItem`.
 * Accessories move to just after the last non-accessory; weapons move to
 * index 0. Reverses by restoring the original index.
 */
export class BringToTopItemAction extends Action {
  persistThroughMenuCancel = true;
  private unit: UnitObject;
  private item: ItemObject;
  private oldIndex: number;

  constructor(unit: UnitObject, item: ItemObject) {
    super();
    this.unit = unit;
    this.item = item;
    this.oldIndex = unit.items.indexOf(item);
  }

  execute(): void {
    const idx = this.unit.items.indexOf(this.item);
    if (idx === -1) return;
    this.unit.items.splice(idx, 1);
    if (this.item.isAccessory()) {
      const nonaccessoryCount = this.unit.items.filter((i) => !i.isAccessory()).length;
      this.unit.items.splice(nonaccessoryCount, 0, this.item);
    } else {
      this.unit.items.unshift(this.item);
    }
  }

  reverse(): void {
    const idx = this.unit.items.indexOf(this.item);
    if (idx !== -1) this.unit.items.splice(idx, 1);
    this.unit.items.splice(Math.max(0, this.oldIndex), 0, this.item);
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
  | 'name' | 'desc' | 'variant' | 'ai' | 'aiGroup' | 'portraitNid' | 'affinity';

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

/**
 * SetLevelVarAction - Faithful port of Python's SetLevelVar (action.py).
 * Sets a level-scoped variable and, if it's one of the fog-of-war
 * variables, recalculates fog of war on both do and reverse (mirrors
 * SetLevelVar._update_fog_of_war being called from both do() and reverse()).
 */
const FOG_LEVEL_VAR_NIDS = new Set([
  '_fog_of_war', '_fog_of_war_radius', '_ai_fog_of_war_radius',
  '_other_fog_of_war_radius', '_fog_of_war_type',
]);

export class SetLevelVarAction extends Action {
  private levelVars: Map<string, any>;
  private nid: string;
  private value: any;
  private alreadyExists: boolean;
  private oldValue: any;

  constructor(levelVars: Map<string, any>, nid: string, value: any) {
    super();
    this.levelVars = levelVars;
    this.nid = nid;
    this.value = value;
    this.alreadyExists = levelVars.has(nid);
    this.oldValue = levelVars.get(nid);
  }

  private updateFow(): void {
    if (FOG_LEVEL_VAR_NIDS.has(this.nid)) {
      const game = _getGame?.();
      if (game && typeof game.recalculateAllFow === 'function') {
        game.recalculateAllFow();
      }
    }
  }

  execute(): void {
    this.levelVars.set(this.nid, this.value);
    this.updateFow();
  }

  reverse(): void {
    if (this.alreadyExists) {
      this.levelVars.set(this.nid, this.oldValue);
    } else {
      this.levelVars.delete(this.nid);
    }
    this.updateFow();
  }
}

/**
 * ChangeTeamAction - Faithful port of Python's ChangeTeam (action.py).
 * Changes a unit's team, resetting its AI to 'None' when moving to the
 * player team (matching Python: `if self.team == 'player': ChangeAI(...)`),
 * and refreshes fog of war for both the old and new team's vision.
 */
export class ChangeTeamAction extends Action {
  private unit: UnitObject;
  private team: string;
  private oldTeam: string;
  private oldAi: string | null = null;

  constructor(unit: UnitObject, team: string) {
    super();
    this.unit = unit;
    this.team = team;
    this.oldTeam = unit.team;
  }

  private recalcFow(): void {
    const game = _getGame?.();
    if (game && typeof game.recalculateAllFow === 'function') {
      game.recalculateAllFow();
    }
  }

  execute(): void {
    this.unit.team = this.team;
    if (this.team === 'player') {
      this.oldAi = (this.unit as any).ai ?? null;
      (this.unit as any).ai = 'None';
    }
    this.recalcFow();
  }

  reverse(): void {
    this.unit.team = this.oldTeam;
    if (this.team === 'player' && this.oldAi !== null) {
      (this.unit as any).ai = this.oldAi;
    }
    this.recalcFow();
  }
}

/**
 * IncrementSupportPointsAction - Faithful port of Python's
 * IncrementSupportPoints (action.py). Snapshots the full pair state before
 * incrementing so reverse restores points/locked+unlocked ranks/chapter
 * counters exactly, matching the Python action's save()/restore approach.
 */
export class IncrementSupportPointsAction extends Action {
  private pair: SupportPair;
  private amount: number;
  private saved: { points: number; lockedRanks: string[]; unlockedRanks: string[]; pointsGainedThisChapter: number; ranksGainedThisChapter: number };

  constructor(pair: SupportPair, amount: number) {
    super();
    this.pair = pair;
    this.amount = amount;
    this.saved = {
      points: pair.points,
      lockedRanks: [...pair.lockedRanks],
      unlockedRanks: [...pair.unlockedRanks],
      pointsGainedThisChapter: pair.pointsGainedThisChapter,
      ranksGainedThisChapter: pair.ranksGainedThisChapter,
    };
  }

  execute(): void {
    const game = _getGame?.();
    game?.supports?.incrementPoints?.(this.pair, this.amount);
  }

  reverse(): void {
    this.pair.points = this.saved.points;
    this.pair.lockedRanks = [...this.saved.lockedRanks];
    this.pair.unlockedRanks = [...this.saved.unlockedRanks];
    this.pair.pointsGainedThisChapter = this.saved.pointsGainedThisChapter;
    this.pair.ranksGainedThisChapter = this.saved.ranksGainedThisChapter;
  }
}

/**
 * UnlockSupportRankAction - Faithful port of Python's UnlockSupportRank
 * (action.py). Moves a rank from locked to unlocked; reverse removes it
 * from unlocked and restores it to locked only if it was locked before.
 */
export class UnlockSupportRankAction extends Action {
  private pair: SupportPair;
  private rank: string;
  private wasLocked = false;

  constructor(pair: SupportPair, rank: string) {
    super();
    this.pair = pair;
    this.rank = rank;
  }

  execute(): void {
    this.wasLocked = this.pair.lockedRanks.includes(this.rank);
    if (this.wasLocked) {
      this.pair.lockedRanks = this.pair.lockedRanks.filter(r => r !== this.rank);
    }
    if (!this.pair.unlockedRanks.includes(this.rank)) {
      this.pair.unlockedRanks.push(this.rank);
    }
    this.pair.ranksGainedThisChapter++;
  }

  reverse(): void {
    this.pair.unlockedRanks = this.pair.unlockedRanks.filter(r => r !== this.rank);
    if (this.wasLocked && !this.pair.lockedRanks.includes(this.rank)) {
      this.pair.lockedRanks.push(this.rank);
    }
    this.pair.ranksGainedThisChapter--;
  }
}

/**
 * DisableSupportRankAction - Faithful port of Python's DisableSupportRank
 * (action.py). Removes a rank from both locked and unlocked lists;
 * reverse restores it to whichever list(s) it was previously in.
 */
export class DisableSupportRankAction extends Action {
  private pair: SupportPair;
  private rank: string;
  private wasLocked = false;
  private wasUnlocked = false;

  constructor(pair: SupportPair, rank: string) {
    super();
    this.pair = pair;
    this.rank = rank;
  }

  execute(): void {
    this.wasLocked = this.pair.lockedRanks.includes(this.rank);
    this.wasUnlocked = this.pair.unlockedRanks.includes(this.rank);
    this.pair.lockedRanks = this.pair.lockedRanks.filter(r => r !== this.rank);
    this.pair.unlockedRanks = this.pair.unlockedRanks.filter(r => r !== this.rank);
  }

  reverse(): void {
    if (this.wasLocked && !this.pair.lockedRanks.includes(this.rank)) {
      this.pair.lockedRanks.push(this.rank);
    }
    if (this.wasUnlocked && !this.pair.unlockedRanks.includes(this.rank)) {
      this.pair.unlockedRanks.push(this.rank);
    }
  }
}

/**
 * MoveInInitiativeAction - Faithful port of Python's MoveInInitiative
 * (action.py). Removes the unit from the initiative line and reinserts
 * it at a new index computed from an offset; reverse removes and
 * reinserts at the original index.
 */
export class MoveInInitiativeAction extends Action {
  private unitNid: string;
  private offset: number;
  private oldIdx: number;
  private initiativeValue: number | undefined;
  private initiative: InitiativeTracker;

  constructor(unitNid: string, offset: number, initiative: InitiativeTracker) {
    super();
    this.unitNid = unitNid;
    this.offset = offset;
    this.initiative = initiative;
    this.oldIdx = initiative.getIndex(unitNid) ?? -1;
    this.initiativeValue = initiative.getInitiativeForUnit(unitNid);
  }

  execute(): void {
    if (this.oldIdx < 0) return;
    const idx = this.initiative.unitLine.indexOf(this.unitNid);
    if (idx < 0) return;
    this.initiative.unitLine.splice(idx, 1);
    this.initiative.initiativeLine.splice(idx, 1);
    const newIdx = Math.max(0, Math.min(this.oldIdx + this.offset, this.initiative.unitLine.length));
    this.initiative.insertAt(this.unitNid, newIdx, this.initiativeValue);
  }

  reverse(): void {
    if (this.oldIdx < 0) return;
    const idx = this.initiative.unitLine.indexOf(this.unitNid);
    if (idx < 0) return;
    this.initiative.unitLine.splice(idx, 1);
    this.initiative.initiativeLine.splice(idx, 1);
    this.initiative.insertAt(this.unitNid, this.oldIdx, this.initiativeValue);
  }
}

/**
 * AddToInitiativeAction - Faithful port of the `add_to_initiative` event
 * command's reversible semantics (repositions a unit already on the
 * initiative line relative to the current index; mirrors
 * MoveInInitiativeAction's structure since the underlying Python event
 * command reuses insert/remove-at-index primitives).
 */
export class AddToInitiativeAction extends Action {
  private unitNid: string;
  private relativePos: number;
  private oldIdx: number;
  private initiativeValue: number | undefined;
  private initiative: InitiativeTracker;

  constructor(unitNid: string, relativePos: number, initiative: InitiativeTracker) {
    super();
    this.unitNid = unitNid;
    this.relativePos = relativePos;
    this.initiative = initiative;
    this.oldIdx = initiative.getIndex(unitNid) ?? -1;
    this.initiativeValue = initiative.getInitiativeForUnit(unitNid);
  }

  execute(): void {

    if (this.oldIdx < 0) return;
    const idx = this.initiative.unitLine.indexOf(this.unitNid);
    if (idx >= 0) {
      this.initiative.unitLine.splice(idx, 1);
      this.initiative.initiativeLine.splice(idx, 1);
    }
    this.initiative.insertAt(this.unitNid, this.initiative.currentIdx + this.relativePos, this.initiativeValue);
  }

  reverse(): void {
    if (this.oldIdx < 0) return;
    const idx = this.initiative.unitLine.indexOf(this.unitNid);
    if (idx >= 0) {
      this.initiative.unitLine.splice(idx, 1);
      this.initiative.initiativeLine.splice(idx, 1);
    }
    this.initiative.insertAt(this.unitNid, this.oldIdx, this.initiativeValue);
  }
}

export class SetRoamInfoAction extends Action {
  private roamInfo: { roam: boolean; roamUnitNid: string | null };
  private key: 'roam' | 'roamUnitNid';
  private value: boolean | string | null;
  private oldValue: boolean | string | null;

  constructor(
    roamInfo: { roam: boolean; roamUnitNid: string | null },
    key: 'roam' | 'roamUnitNid',
    value: boolean | string | null,
  ) {
    super();
    this.roamInfo = roamInfo;
    this.key = key;
    this.value = value;
    this.oldValue = roamInfo[key];
  }

  execute(): void {
    if (this.key === 'roam') this.roamInfo.roam = this.value as boolean;
    else this.roamInfo.roamUnitNid = this.value as string | null;
  }

  reverse(): void {
    if (this.key === 'roam') this.roamInfo.roam = this.oldValue as boolean;
    else this.roamInfo.roamUnitNid = this.oldValue as string | null;
  }
}

export class EnableOverworldElementAction extends Action {
  private collection: Set<string>;
  private nid: string;
  private existed: boolean;

  constructor(collection: Set<string>, nid: string) {
    super();
    this.collection = collection;
    this.nid = nid;
    this.existed = collection.has(nid);
  }

  execute(): void {
    this.collection.add(this.nid);
  }

  reverse(): void {
    if (!this.existed) this.collection.delete(this.nid);
  }
}

export class MoveOverworldEntityAction extends Action {
  private manager: any;
  private entityNid: string;
  private nodeNid: string | null;
  private position: [number, number] | null;
  private oldNode: string | null;
  private oldPosition: [number, number] | null;

  constructor(
    manager: any,
    entityNid: string,
    destination: string | [number, number],
  ) {
    super();
    this.manager = manager;
    this.entityNid = entityNid;
    this.nodeNid = typeof destination === 'string' ? destination : null;
    this.position = typeof destination === 'string' ? null : [...destination];
    const entity = manager.entities.get(entityNid);
    this.oldNode = entity?.onNode ?? null;
    this.oldPosition = entity?.displayPosition
      ? [entity.displayPosition[0], entity.displayPosition[1]]
      : null;
  }

  execute(): void {
    if (this.nodeNid) {
      this.manager.movePartyToNode(this.entityNid, this.nodeNid);
    } else {
      const entity = this.manager.entities.get(this.entityNid);
      if (entity && this.position) entity.displayPosition = [...this.position];
    }
  }

  reverse(): void {
    const entity = this.manager.entities.get(this.entityNid);
    if (!entity) return;
    entity.onNode = this.oldNode;
    entity.displayPosition = this.oldPosition ? [...this.oldPosition] : null;
  }
}

export class CreateOverworldEntityAction extends Action {
  private manager: any;
  private args: [string, string, string, string, string | null];
  private previous: any;
  private created: any = null;

  constructor(
    manager: any,
    nid: string,
    dtype: string,
    dnid: string,
    team: string,
    nodeNid: string | null,
  ) {
    super();
    this.manager = manager;
    this.args = [nid, dtype, dnid, team, nodeNid];
    this.previous = manager.entities.get(nid) ?? null;
  }

  execute(): void {
    if (!this.created) this.created = this.manager.createEntity(...this.args);
    else this.manager.entities.set(this.args[0], this.created);
  }

  reverse(): void {
    this.manager.removeEntity(this.args[0]);
    if (this.previous) this.manager.entities.set(this.args[0], this.previous);
  }
}

export class RemoveOverworldEntityAction extends Action {
  private manager: any;
  private nid: string;
  private removed: any;
  private oldSelected: string | null;

  constructor(manager: any, nid: string) {
    super();
    this.manager = manager;
    this.nid = nid;
    this.removed = manager.entities.get(nid) ?? null;
    this.oldSelected = manager.selectedPartyNid;
  }

  execute(): void {
    this.manager.removeEntity(this.nid);
  }

  reverse(): void {
    if (this.removed) this.manager.entities.set(this.nid, this.removed);
    this.manager.selectedPartyNid = this.oldSelected;
  }
}

export class DisableOverworldEntityAction extends Action {
  private entity: any;
  private oldNode: string | null;
  private oldPosition: [number, number] | null;

  constructor(entity: any) {
    super();
    this.entity = entity;
    this.oldNode = entity.onNode ?? null;
    this.oldPosition = entity.displayPosition
      ? [entity.displayPosition[0], entity.displayPosition[1]]
      : null;
  }

  execute(): void {
    this.entity.onNode = null;
    this.entity.displayPosition = null;
  }

  reverse(): void {
    this.entity.onNode = this.oldNode;
    this.entity.displayPosition = this.oldPosition ? [...this.oldPosition] : null;
  }
}

export class SetOverworldMenuOptionAction extends Action {
  private options: Map<string, boolean>;
  private optionNid: string;
  private value: boolean;
  private existed: boolean;
  private oldValue: boolean | undefined;

  constructor(options: Map<string, boolean>, optionNid: string, value: boolean) {
    super();
    this.options = options;
    this.optionNid = optionNid;
    this.value = value;
    this.existed = options.has(optionNid);
    this.oldValue = options.get(optionNid);
  }

  execute(): void {
    this.options.set(this.optionNid, this.value);
  }

  reverse(): void {
    if (this.existed) this.options.set(this.optionNid, this.oldValue!);
    else this.options.delete(this.optionNid);
  }
}
