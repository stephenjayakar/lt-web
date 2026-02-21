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
  // Flow control
  | 'comment' | 'if' | 'elif' | 'else' | 'end' | 'for' | 'endf' | 'finish' | 'wait' | 'end_skip'
  // Music/sound
  | 'music' | 'music_fade_back' | 'music_clear' | 'sound' | 'stop_sound' | 'change_music' | 'change_special_music'
  // Portraits
  | 'add_portrait' | 'multi_add_portrait' | 'remove_portrait' | 'multi_remove_portrait'
  | 'remove_all_portraits' | 'move_portrait' | 'bop_portrait' | 'mirror_portrait' | 'expression'
  // Dialogue
  | 'speak_style' | 'speak' | 'say' | 'unhold' | 'unpause' | 'narrate' | 'alert' | 'location_card'
  | 'credits' | 'ending' | 'paired_ending' | 'pop_dialog' | 'toggle_narration_mode'
  | 'hide_combat_ui' | 'show_combat_ui'
  // Background/foreground
  | 'transition' | 'change_background' | 'pause_background' | 'unpause_background'
  // Cursor/camera
  | 'disp_cursor' | 'move_cursor' | 'center_cursor' | 'flicker_cursor' | 'screen_shake' | 'screen_shake_end'
  // Game-wide variables
  | 'game_var' | 'inc_game_var' | 'modify_game_var' | 'set_next_chapter'
  | 'enable_convoy' | 'enable_supports' | 'enable_turnwheel'
  | 'give_money' | 'give_bexp' | 'add_market_item' | 'remove_market_item'
  // Level-wide variables
  | 'level_var' | 'inc_level_var' | 'modify_level_var'
  | 'end_turn' | 'win_game' | 'lose_game' | 'main_menu' | 'skip_save'
  | 'add_talk' | 'remove_talk' | 'hide_talk' | 'unhide_talk'
  | 'change_objective_simple' | 'change_objective_win' | 'change_objective_loss'
  // Tilemap
  | 'change_tilemap' | 'show_layer' | 'hide_layer'
  | 'add_weather' | 'remove_weather' | 'map_anim' | 'remove_map_anim'
  // Regions
  | 'add_region' | 'region_condition' | 'remove_region'
  // Add/remove/interact units
  | 'load_unit' | 'make_generic' | 'create_unit'
  | 'add_unit' | 'move_unit' | 'remove_unit' | 'kill_unit' | 'remove_all_units' | 'remove_all_enemies'
  | 'interact_unit' | 'resurrect'
  // Modify unit properties
  | 'set_name' | 'set_current_hp' | 'set_current_mana'
  | 'reset' | 'has_attacked' | 'has_traded' | 'has_finished'
  | 'give_item' | 'equip_item' | 'remove_item' | 'move_item'
  | 'give_exp' | 'set_exp' | 'give_wexp' | 'set_wexp'
  | 'give_skill' | 'remove_skill'
  | 'change_ai' | 'change_party' | 'change_faction' | 'change_team'
  | 'change_portrait' | 'change_stats' | 'set_stats' | 'change_growths' | 'set_growths'
  | 'set_unit_level' | 'autolevel_to' | 'promote' | 'change_class'
  | 'add_tag' | 'remove_tag'
  // Unit groups
  | 'add_group' | 'spawn_group' | 'move_group' | 'remove_group'
  // Misc
  | 'battle_save' | 'prep' | 'base' | 'shop' | 'choice' | 'unchoice'
  | 'chapter_title' | 'set_tile'
  // Legacy aliases (resolved to canonical form)
  | 'set_game_var' | 'change_objective';

export interface EventCommand {
  type: EventCommandType;
  args: string[];
}

// Canonical command set — all commands we recognize
const VALID_COMMANDS: Set<string> = new Set<string>([
  // Flow control
  'comment', 'if', 'elif', 'else', 'end', 'for', 'endf', 'finish', 'wait', 'end_skip',
  // Music/sound
  'music', 'music_fade_back', 'music_clear', 'sound', 'stop_sound', 'change_music', 'change_special_music',
  // Portraits
  'add_portrait', 'multi_add_portrait', 'remove_portrait', 'multi_remove_portrait',
  'remove_all_portraits', 'move_portrait', 'bop_portrait', 'mirror_portrait', 'expression',
  // Dialogue
  'speak_style', 'speak', 'say', 'unhold', 'unpause', 'narrate', 'alert', 'location_card',
  'credits', 'ending', 'paired_ending', 'pop_dialog', 'toggle_narration_mode',
  'hide_combat_ui', 'show_combat_ui',
  // Background/foreground
  'transition', 'change_background', 'pause_background', 'unpause_background',
  // Cursor/camera
  'disp_cursor', 'move_cursor', 'center_cursor', 'flicker_cursor', 'screen_shake', 'screen_shake_end',
  // Game-wide variables
  'game_var', 'inc_game_var', 'modify_game_var', 'set_next_chapter',
  'enable_convoy', 'enable_supports', 'enable_turnwheel',
  'give_money', 'give_bexp', 'add_market_item', 'remove_market_item',
  // Level-wide variables
  'level_var', 'inc_level_var', 'modify_level_var',
  'end_turn', 'win_game', 'lose_game', 'main_menu', 'skip_save',
  'add_talk', 'remove_talk', 'hide_talk', 'unhide_talk',
  'change_objective_simple', 'change_objective_win', 'change_objective_loss',
  // Tilemap
  'change_tilemap', 'show_layer', 'hide_layer',
  'add_weather', 'remove_weather', 'map_anim', 'remove_map_anim',
  // Regions
  'add_region', 'region_condition', 'remove_region',
  // Add/remove/interact units
  'load_unit', 'make_generic', 'create_unit',
  'add_unit', 'move_unit', 'remove_unit', 'kill_unit', 'remove_all_units', 'remove_all_enemies',
  'interact_unit', 'resurrect',
  // Modify unit properties
  'set_name', 'set_current_hp', 'set_current_mana',
  'reset', 'has_attacked', 'has_traded', 'has_finished',
  'give_item', 'equip_item', 'remove_item', 'move_item',
  'give_exp', 'set_exp', 'give_wexp', 'set_wexp',
  'give_skill', 'remove_skill',
  'change_ai', 'change_party', 'change_faction', 'change_team',
  'change_portrait', 'change_stats', 'set_stats', 'change_growths', 'set_growths',
  'set_unit_level', 'autolevel_to', 'promote', 'change_class',
  'add_tag', 'remove_tag',
  // Unit groups
  'add_group', 'spawn_group', 'move_group', 'remove_group',
  // Misc
  'battle_save', 'prep', 'base', 'shop', 'choice', 'unchoice',
  'chapter_title', 'set_tile',
  // Legacy/aliases from our old code
  'set_game_var', 'change_objective',
]);

/** Map of command aliases to their canonical names. */
const COMMAND_ALIASES: Record<string, string> = {
  // Common aliases from LT
  's': 'speak',
  'u': 'add_portrait',
  'uu': 'multi_add_portrait',
  'r': 'remove_portrait',
  'rr': 'multi_remove_portrait',
  'rrr': 'remove_all_portraits',
  'e': 'expression',
  'bop': 'bop_portrait',
  'mirror': 'mirror_portrait',
  't': 'transition',
  'b': 'change_background',
  'm': 'music',
  'mf': 'music_fade_back',
  'highlight': 'flicker_cursor',
  'set_cursor': 'move_cursor',
  'gvar': 'game_var',
  'ginc': 'inc_game_var',
  'mgvar': 'modify_game_var',
  'lvar': 'level_var',
  'linc': 'inc_level_var',
  'mlvar': 'modify_level_var',
  'add': 'add_unit',
  'move': 'move_unit',
  'remove': 'remove_unit',
  'kill': 'kill_unit',
  'interact': 'interact_unit',
  'reset_unit': 'reset',
  'add_skill': 'give_skill',
  'set_ai': 'change_ai',
  'set_roam_ai': 'change_roam_ai',
  'set_ai_group': 'change_ai_group',
  'morph_group': 'move_group',
  'break': 'finish',
  'resurrect_unit': 'resurrect',
  'unlock_lore': 'add_lore',
  // Legacy names from our old code
  'set_game_var': 'game_var',
  'change_objective': 'change_objective_simple',
};

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
    let rawType = parts[0].trim().toLowerCase();

    // Resolve aliases to canonical command names
    if (COMMAND_ALIASES[rawType]) {
      rawType = COMMAND_ALIASES[rawType];
    }

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
