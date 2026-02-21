import type { NID, EventPrefab } from '../data/types';

// ============================================================
// Event Scripting System
// ============================================================

export interface EventTrigger {
  type: string; // 'level_start', 'turn_change', 'combat_death', 'phase_change', 'unit_talk', 'region_event', etc.
  levelNid?: NID;
  unitNid?: NID;
  unitA?: NID;
  unitB?: NID;
  regionNid?: NID;
  turnCount?: number;
  team?: string;
}

export type EventCommandType =
  | 'speak' | 'add_portrait' | 'remove_portrait'
  | 'transition' | 'set_current_hp' | 'add_unit' | 'remove_unit'
  | 'move_unit' | 'give_item' | 'give_money' | 'change_team'
  | 'set_game_var' | 'music' | 'sound' | 'wait' | 'end_skip'
  | 'win_game' | 'lose_game' | 'map_anim' | 'set_tile'
  | 'change_objective' | 'add_region' | 'remove_region';

export interface EventCommand {
  type: EventCommandType;
  args: string[];
}

// Set of all valid command types for parsing validation
const VALID_COMMANDS: Set<string> = new Set<string>([
  'speak', 'add_portrait', 'remove_portrait',
  'transition', 'set_current_hp', 'add_unit', 'remove_unit',
  'move_unit', 'give_item', 'give_money', 'change_team',
  'set_game_var', 'music', 'sound', 'wait', 'end_skip',
  'win_game', 'lose_game', 'map_anim', 'set_tile',
  'change_objective', 'add_region', 'remove_region',
]);

/**
 * GameEvent - A single event instance being executed.
 * Commands are parsed from semicolon-delimited source lines.
 */
export class GameEvent {
  nid: NID;
  commands: EventCommand[];
  currentIndex: number;
  state: 'running' | 'waiting' | 'done';

  // For speak commands
  currentDialog: { speaker: string; text: string } | null;
  waitingForInput: boolean;

  constructor(prefab: EventPrefab) {
    this.nid = prefab.nid;
    this.commands = [];
    this.currentIndex = 0;
    this.state = 'running';
    this.currentDialog = null;
    this.waitingForInput = false;

    // Parse each source line into a command
    for (const line of prefab._source) {
      const cmd = GameEvent.parseCommand(line);
      if (cmd) {
        this.commands.push(cmd);
      }
    }

    // If the event has no commands, mark as done immediately
    if (this.commands.length === 0) {
      this.state = 'done';
    }
  }

  /**
   * Parse a source line into a command.
   * Format: "command_type;arg1;arg2;..."
   * Lines that are empty, whitespace-only, or start with '#' are comments.
   */
  static parseCommand(line: string): EventCommand | null {
    const trimmed = line.trim();

    // Skip empty lines and comments
    if (trimmed === '' || trimmed.startsWith('#')) {
      return null;
    }

    const parts = trimmed.split(';');
    const rawType = parts[0].trim().toLowerCase();

    if (!VALID_COMMANDS.has(rawType)) {
      return null;
    }

    const type = rawType as EventCommandType;
    const args = parts.slice(1).map((a) => a.trim());

    return { type, args };
  }

  /**
   * Advance to next command.
   * Returns the command to execute, or null if waiting/done.
   */
  advance(): EventCommand | null {
    // Cannot advance if waiting for input or already done
    if (this.state === 'waiting' || this.state === 'done') {
      return null;
    }

    // Check bounds
    if (this.currentIndex >= this.commands.length) {
      this.state = 'done';
      return null;
    }

    const cmd = this.commands[this.currentIndex];
    this.currentIndex++;

    // Speak commands pause the event until the player advances the dialog
    if (cmd.type === 'speak') {
      this.state = 'waiting';
      this.waitingForInput = true;
      this.currentDialog = {
        speaker: cmd.args[0] ?? '',
        text: cmd.args[1] ?? '',
      };
    }

    // Wait command pauses for a timed duration (resolved externally)
    if (cmd.type === 'wait') {
      this.state = 'waiting';
      this.waitingForInput = false;
    }

    // Transition command pauses while the visual transition plays
    if (cmd.type === 'transition') {
      this.state = 'waiting';
      this.waitingForInput = false;
    }

    // Check if we've reached the end after consuming this command
    if (this.currentIndex >= this.commands.length && this.state === 'running') {
      this.state = 'done';
    }

    return cmd;
  }

  /** Mark current wait as resolved, resume execution */
  resolveWait(): void {
    if (this.state !== 'waiting') {
      return;
    }

    this.waitingForInput = false;
    this.currentDialog = null;

    // If there are more commands, go back to running; otherwise done
    if (this.currentIndex >= this.commands.length) {
      this.state = 'done';
    } else {
      this.state = 'running';
    }
  }

  /** Check if event is complete */
  isDone(): boolean {
    return this.state === 'done';
  }
}

/**
 * EventManager - Queues and dispatches events based on triggers.
 * Events are matched by trigger type & level, sorted by priority,
 * and filtered by condition and only_once flags.
 */
export class EventManager {
  private allEvents: Map<NID, EventPrefab>;
  private eventStack: GameEvent[];
  private onceTriggered: Set<NID>;

  constructor(events: Map<NID, EventPrefab>) {
    this.allEvents = events;
    this.eventStack = [];
    this.onceTriggered = new Set();
  }

  /**
   * Check for matching events and queue them.
   * Returns true if at least one event was triggered.
   */
  trigger(trigger: EventTrigger, gameVars?: Map<string, any>): boolean {
    const matches = this.findMatchingEvents(trigger);
    let triggered = false;

    for (const prefab of matches) {
      // Skip events that have already been triggered (only_once)
      if (prefab.only_once && this.onceTriggered.has(prefab.nid)) {
        continue;
      }

      // Evaluate the condition
      if (!this.evaluateCondition(prefab.condition, gameVars)) {
        continue;
      }

      // Mark as triggered if only_once
      if (prefab.only_once) {
        this.onceTriggered.add(prefab.nid);
      }

      // Create and push the event onto the stack
      const event = new GameEvent(prefab);
      if (!event.isDone()) {
        this.eventStack.push(event);
        triggered = true;
      }
    }

    return triggered;
  }

  /** Get the current active event (top of stack) */
  getCurrentEvent(): GameEvent | null {
    if (this.eventStack.length === 0) {
      return null;
    }
    return this.eventStack[this.eventStack.length - 1];
  }

  /** Check if any events are active */
  hasActiveEvents(): boolean {
    return this.eventStack.length > 0;
  }

  /** Pop completed events from the top of the stack */
  update(): void {
    while (this.eventStack.length > 0) {
      const top = this.eventStack[this.eventStack.length - 1];
      if (top.isDone()) {
        this.eventStack.pop();
      } else {
        break;
      }
    }
  }

  /**
   * Evaluate a condition string.
   * Supports:
   *   - "True" / "true" / "1"  -> true
   *   - "False" / "false" / "0" / "" -> false
   *   - "game_var_name" -> truthy check on gameVars
   *   - "var == value", "var != value" -> equality comparisons
   *   - "var > value", "var < value", "var >= value", "var <= value" -> numeric comparisons
   *   - "not condition" -> negation
   */
  private evaluateCondition(condition: string, gameVars?: Map<string, any>): boolean {
    const trimmed = condition.trim();

    // Empty condition or literal True
    if (trimmed === '' || trimmed === 'True' || trimmed === 'true' || trimmed === '1') {
      return true;
    }

    // Literal False
    if (trimmed === 'False' || trimmed === 'false' || trimmed === '0') {
      return false;
    }

    // Negation: "not <expr>"
    if (trimmed.toLowerCase().startsWith('not ')) {
      return !this.evaluateCondition(trimmed.slice(4), gameVars);
    }

    // Comparison operators (check multi-char operators first)
    const comparisonOps = ['==', '!=', '>=', '<=', '>', '<'] as const;
    for (const op of comparisonOps) {
      const idx = trimmed.indexOf(op);
      if (idx !== -1) {
        const lhs = trimmed.slice(0, idx).trim();
        const rhs = trimmed.slice(idx + op.length).trim();
        return this.evaluateComparison(lhs, op, rhs, gameVars);
      }
    }

    // Bare variable name: truthy check
    if (gameVars && gameVars.has(trimmed)) {
      return !!gameVars.get(trimmed);
    }

    // Unknown condition defaults to false
    return false;
  }

  /**
   * Evaluate a comparison expression.
   * Resolves lhs from gameVars if possible, then compares to rhs.
   */
  private evaluateComparison(
    lhs: string,
    op: '==' | '!=' | '>=' | '<=' | '>' | '<',
    rhs: string,
    gameVars?: Map<string, any>,
  ): boolean {
    // Resolve the left-hand side from game vars
    let lhsValue: any = lhs;
    if (gameVars && gameVars.has(lhs)) {
      lhsValue = gameVars.get(lhs);
    }

    // Try to parse both sides as numbers for numeric comparison
    const lhsNum = Number(lhsValue);
    const rhsNum = Number(rhs);
    const bothNumeric = !isNaN(lhsNum) && !isNaN(rhsNum) && rhs !== '';

    switch (op) {
      case '==':
        if (bothNumeric) return lhsNum === rhsNum;
        return String(lhsValue) === rhs;
      case '!=':
        if (bothNumeric) return lhsNum !== rhsNum;
        return String(lhsValue) !== rhs;
      case '>':
        return bothNumeric ? lhsNum > rhsNum : String(lhsValue) > rhs;
      case '<':
        return bothNumeric ? lhsNum < rhsNum : String(lhsValue) < rhs;
      case '>=':
        return bothNumeric ? lhsNum >= rhsNum : String(lhsValue) >= rhs;
      case '<=':
        return bothNumeric ? lhsNum <= rhsNum : String(lhsValue) <= rhs;
    }
  }

  /**
   * Get all event prefabs that match a trigger, without actually triggering them.
   * Used for checking if a Talk, Visit, etc. option should be shown.
   */
  getEventsForTrigger(trigger: EventTrigger): EventPrefab[] {
    return this.findMatchingEvents(trigger).filter((prefab) => {
      if (prefab.only_once && this.onceTriggered.has(prefab.nid)) return false;
      return true;
    });
  }

  /**
   * Find events matching a trigger.
   * Matches on trigger type and optionally level_nid.
   * Results are sorted by priority (higher first).
   */
  private findMatchingEvents(trigger: EventTrigger): EventPrefab[] {
    const matches: EventPrefab[] = [];

    for (const prefab of this.allEvents.values()) {
      // Trigger type must match
      if (prefab.trigger !== trigger.type) {
        continue;
      }

      // If the event is scoped to a level, it must match the trigger's level
      if (prefab.level_nid !== null && trigger.levelNid !== undefined) {
        if (prefab.level_nid !== trigger.levelNid) {
          continue;
        }
      }

      // If the event is scoped to a level but the trigger has no level, skip
      if (prefab.level_nid !== null && trigger.levelNid === undefined) {
        continue;
      }

      matches.push(prefab);
    }

    // Sort by priority descending (higher priority first)
    matches.sort((a, b) => b.priority - a.priority);

    return matches;
  }
}
