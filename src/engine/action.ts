import type { UnitObject } from '../objects/unit';
import type { ItemObject } from '../objects/item';
import type { GameBoard } from '../objects/game-board';

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
