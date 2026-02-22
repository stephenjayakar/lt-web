import type { NID, EventPrefab } from '../data/types';

// ============================================================
// Event Scripting System
// ============================================================

/**
 * EventTrigger describes what kind of event to match.
 * Fields beyond `type` are optional and used for context-sensitive matching.
 */
export interface EventTrigger {
  type: string; // 'level_start', 'turn_change', 'combat_end', 'combat_death', 'on_talk', etc.
  levelNid?: NID;
  unitNid?: NID;        // primary unit (unit1)
  unitA?: NID;           // alias for unit1 in talk triggers
  unitB?: NID;           // unit2 in talk triggers
  regionNid?: NID;
  turnCount?: number;
  team?: string;
  // Context objects for condition evaluation
  unit1?: any;           // UnitObject reference
  unit2?: any;           // UnitObject reference
  position?: [number, number];
  region?: any;          // RegionData reference
  item?: any;            // ItemObject reference
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
  commandPointer: number;
  state: 'running' | 'waiting' | 'done';
  trigger: EventTrigger;

  // For speak commands
  currentDialog: { speaker: string; text: string } | null;
  waitingForInput: boolean;

  constructor(prefab: EventPrefab, trigger: EventTrigger) {
    this.nid = prefab.nid;
    this.commands = [];
    this.commandPointer = 0;
    this.state = 'running';
    this.trigger = trigger;
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

  /** Check if event is complete */
  isDone(): boolean {
    return this.state === 'done';
  }

  /** Mark event as done */
  finish(): void {
    this.state = 'done';
  }
}

// ============================================================
// Condition Evaluator
// ============================================================

/**
 * Evaluate a condition string from event data.
 * 
 * Supports a subset of the Python conditions used in LT:
 * - "True" / "False" / "1" / "0" / ""
 * - "game.turncount == N" / "game.turncount >= N" etc.
 * - "unit.nid == 'Name'" / "unit1.nid == 'Name'"
 * - "unit2.nid == 'Name'" / "unit.team == 'player'"
 * - "game.check_dead('Name')" / "check_dead('Name')"
 * - "not <condition>"
 * - "A and B" / "A or B"
 * - "region.nid == 'Name'"
 * - "check_pair('A', 'B')" — checks if unit1/unit2 match A/B in either order
 * - Simple variable lookups in gameVars/levelVars
 */
export function evaluateCondition(
  condition: string,
  context: ConditionContext,
): boolean {
  const trimmed = condition.trim();

  // Empty condition or literal True
  if (trimmed === '' || trimmed === 'True' || trimmed === 'true' || trimmed === '1') {
    return true;
  }

  // Literal False
  if (trimmed === 'False' || trimmed === 'false' || trimmed === '0') {
    return false;
  }

  // Handle 'and' / 'or' (split at top level, respecting parens)
  const andParts = splitAtTopLevel(trimmed, ' and ');
  if (andParts.length > 1) {
    return andParts.every(part => evaluateCondition(part, context));
  }

  const orParts = splitAtTopLevel(trimmed, ' or ');
  if (orParts.length > 1) {
    return orParts.some(part => evaluateCondition(part, context));
  }

  // Negation: "not <expr>"
  if (trimmed.toLowerCase().startsWith('not ')) {
    return !evaluateCondition(trimmed.slice(4), context);
  }

  // Strip outer parentheses
  if (trimmed.startsWith('(') && trimmed.endsWith(')')) {
    const inner = trimmed.slice(1, -1);
    // Only strip if the parens are balanced
    if (findMatchingParen(trimmed, 0) === trimmed.length - 1) {
      return evaluateCondition(inner, context);
    }
  }

  // Function calls: game.check_dead('Name'), check_dead('Name'), check_pair('A','B')
  const funcMatch = trimmed.match(/^(?:game\.)?check_dead\s*\(\s*['"](.+?)['"]\s*\)/);
  if (funcMatch) {
    const unitNid = funcMatch[1];
    return isUnitDead(unitNid, context);
  }

  const checkPairMatch = trimmed.match(/^check_pair\s*\(\s*['"](.+?)['"]\s*,\s*['"](.+?)['"]\s*\)/);
  if (checkPairMatch) {
    const a = checkPairMatch[1];
    const b = checkPairMatch[2];
    const u1 = context.unit1?.nid;
    const u2 = context.unit2?.nid;
    return (u1 === a && u2 === b) || (u1 === b && u2 === a);
  }

  const checkDefaultMatch = trimmed.match(/^check_default\s*\(\s*['"](.+?)['"]\s*,\s*\[(.+?)\]\s*\)/);
  if (checkDefaultMatch) {
    // check_default("target_nid", ['unit1_nid', 'unit2_nid'])
    // Returns true if unit2 matches target_nid AND unit1 is NOT in the exception list
    const targetNid = checkDefaultMatch[1];
    const exceptionList = checkDefaultMatch[2].split(',').map(s => s.trim().replace(/['"]/g, ''));
    const u1 = context.unit1?.nid;
    const u2 = context.unit2?.nid;
    if (u2 !== targetNid) return false;
    return !exceptionList.includes(u1 ?? '');
  }

  // len(game.get_enemy_units()) == N
  const lenEnemyMatch = trimmed.match(/^len\s*\(\s*game\.get_enemy_units\s*\(\s*\)\s*\)\s*(==|!=|>=|<=|>|<)\s*(\d+)/);
  if (lenEnemyMatch) {
    const op = lenEnemyMatch[1];
    const n = parseInt(lenEnemyMatch[2], 10);
    const enemies = context.game?.board?.getTeamUnits('enemy') ?? [];
    const count = enemies.filter((u: any) => !u.isDead()).length;
    return compareNumbers(count, op, n);
  }

  // Comparison operators: resolve dotted paths
  const comparisonOps = ['==', '!=', '>=', '<=', '>', '<'] as const;
  for (const op of comparisonOps) {
    const idx = findTopLevelOperator(trimmed, op);
    if (idx !== -1) {
      const lhs = trimmed.slice(0, idx).trim();
      const rhs = trimmed.slice(idx + op.length).trim();
      return evaluateComparison(lhs, op, rhs, context);
    }
  }

  // Bare variable/path: truthy check
  const value = resolvePath(trimmed, context);
  if (value !== undefined) {
    return !!value;
  }

  // Unknown condition — warn and default to true (safer than blocking events)
  console.warn(`EventCondition: cannot evaluate "${trimmed}", defaulting to true`);
  return true;
}

/** Context object for condition evaluation. */
export interface ConditionContext {
  game?: any;            // GameState reference
  unit1?: any;           // Primary unit (from trigger)
  unit2?: any;           // Secondary unit (from trigger)
  position?: [number, number];
  region?: any;          // RegionData
  item?: any;            // ItemObject
  gameVars?: Map<string, any>;
  levelVars?: Map<string, any>;
  localArgs?: Map<string, any>;  // Trigger-specific extra args
}

/** Resolve a dotted path like "game.turncount", "unit.nid", "region.nid" to a value. */
function resolvePath(path: string, ctx: ConditionContext): any {
  const trimmed = path.trim();

  // String literals
  if ((trimmed.startsWith("'") && trimmed.endsWith("'")) ||
      (trimmed.startsWith('"') && trimmed.endsWith('"'))) {
    return trimmed.slice(1, -1);
  }

  // Numeric literals
  const num = Number(trimmed);
  if (!isNaN(num) && trimmed !== '') {
    return num;
  }

  // Boolean literals
  if (trimmed === 'True' || trimmed === 'true') return true;
  if (trimmed === 'False' || trimmed === 'false') return false;

  // Dotted path resolution
  const parts = trimmed.split('.');

  // game.turncount, game.game_vars, game.level_vars, etc.
  if (parts[0] === 'game' && ctx.game) {
    return resolveObject(ctx.game, parts.slice(1));
  }

  // unit.nid, unit.team, unit.level, etc. (alias for unit1)
  if ((parts[0] === 'unit' || parts[0] === 'unit1') && ctx.unit1) {
    return resolveObject(ctx.unit1, parts.slice(1));
  }

  // unit2.nid, unit2.team, etc.
  if (parts[0] === 'unit2' && ctx.unit2) {
    return resolveObject(ctx.unit2, parts.slice(1));
  }

  // region.nid, region.region_type, etc.
  if (parts[0] === 'region' && ctx.region) {
    return resolveObject(ctx.region, parts.slice(1));
  }

  // item.nid, etc.
  if (parts[0] === 'item' && ctx.item) {
    return resolveObject(ctx.item, parts.slice(1));
  }

  // position
  if (trimmed === 'position') return ctx.position;

  // support_rank_nid (from trigger local args)
  if (ctx.localArgs?.has(trimmed)) {
    return ctx.localArgs.get(trimmed);
  }

  // Game vars lookup
  if (ctx.gameVars?.has(trimmed)) {
    return ctx.gameVars.get(trimmed);
  }

  // Level vars lookup
  if (ctx.levelVars?.has(trimmed)) {
    return ctx.levelVars.get(trimmed);
  }

  return undefined;
}

/** Walk an object by property names. */
function resolveObject(obj: any, parts: string[]): any {
  let current = obj;
  for (const part of parts) {
    if (current == null) return undefined;
    // Handle snake_case -> camelCase mapping for common fields
    const camelPart = snakeToCamel(part);
    if (part in current) {
      current = current[part];
    } else if (camelPart in current) {
      current = current[camelPart];
    } else {
      // Special cases for GameState
      if (part === 'turncount' || part === 'turn_count') return current.turnCount ?? current.turncount;
      if (part === 'game_vars') return current.gameVars ?? current.game_vars;
      if (part === 'level_vars') return current.levelVars ?? current.level_vars;
      if (part === 'current_hp') return current.currentHp ?? current.current_hp;
      if (part === 'max_hp') return current.maxHp ?? current.max_hp;
      return undefined;
    }
  }
  return current;
}

function snakeToCamel(s: string): string {
  return s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

function isUnitDead(nid: string, ctx: ConditionContext): boolean {
  if (!ctx.game) return false;
  const unit = ctx.game.units?.get(nid) ?? ctx.game.getUnit?.(nid);
  if (!unit) return true; // Unit not found = treated as dead
  return unit.isDead?.() ?? unit.dead ?? false;
}

function compareNumbers(lhs: number, op: string, rhs: number): boolean {
  switch (op) {
    case '==': return lhs === rhs;
    case '!=': return lhs !== rhs;
    case '>': return lhs > rhs;
    case '<': return lhs < rhs;
    case '>=': return lhs >= rhs;
    case '<=': return lhs <= rhs;
    default: return false;
  }
}

function evaluateComparison(
  lhsStr: string,
  op: string,
  rhsStr: string,
  ctx: ConditionContext,
): boolean {
  const lhsValue = resolvePath(lhsStr, ctx);
  const rhsValue = resolvePath(rhsStr, ctx);

  // If both resolve to numbers, compare numerically
  const lhsNum = typeof lhsValue === 'number' ? lhsValue : Number(lhsValue);
  const rhsNum = typeof rhsValue === 'number' ? rhsValue : Number(rhsValue);
  const bothNumeric = !isNaN(lhsNum) && !isNaN(rhsNum) &&
    lhsValue !== undefined && rhsValue !== undefined &&
    lhsStr !== '' && rhsStr !== '';

  if (bothNumeric) {
    return compareNumbers(lhsNum, op, rhsNum);
  }

  // String comparison
  const lhsFinal = lhsValue !== undefined ? String(lhsValue) : lhsStr;
  const rhsFinal = rhsValue !== undefined ? String(rhsValue) : rhsStr;

  switch (op) {
    case '==': return lhsFinal === rhsFinal;
    case '!=': return lhsFinal !== rhsFinal;
    case '>': return lhsFinal > rhsFinal;
    case '<': return lhsFinal < rhsFinal;
    case '>=': return lhsFinal >= rhsFinal;
    case '<=': return lhsFinal <= rhsFinal;
    default: return false;
  }
}

/** Find the index of a comparison operator, skipping operators inside strings/parens. */
function findTopLevelOperator(str: string, op: string): number {
  let depth = 0;
  let inString: string | null = null;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (inString) {
      if (ch === inString && str[i - 1] !== '\\') inString = null;
      continue;
    }
    if (ch === '"' || ch === "'") { inString = ch; continue; }
    if (ch === '(') { depth++; continue; }
    if (ch === ')') { depth--; continue; }
    if (depth === 0 && str.slice(i, i + op.length) === op) {
      // Make sure we're not matching a longer operator (e.g., '=' inside '==')
      if (op === '>' && str[i + 1] === '=') continue;
      if (op === '<' && str[i + 1] === '=') continue;
      if (op === '=' && str[i + 1] === '=') continue;
      if (op === '!' && str[i + 1] === '=') continue;
      return i;
    }
  }
  return -1;
}

/** Split a string at a delimiter, but only at the top level (not inside parens/strings). */
function splitAtTopLevel(str: string, delimiter: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let inString: string | null = null;
  let start = 0;

  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (inString) {
      if (ch === inString && str[i - 1] !== '\\') inString = null;
      continue;
    }
    if (ch === '"' || ch === "'") { inString = ch; continue; }
    if (ch === '(') { depth++; continue; }
    if (ch === ')') { depth--; continue; }
    if (depth === 0 && str.slice(i, i + delimiter.length) === delimiter) {
      parts.push(str.slice(start, i));
      start = i + delimiter.length;
      i += delimiter.length - 1;
    }
  }
  parts.push(str.slice(start));
  return parts;
}

/** Find the matching closing paren for the paren at index `start`. */
function findMatchingParen(str: string, start: number): number {
  let depth = 0;
  for (let i = start; i < str.length; i++) {
    if (str[i] === '(') depth++;
    if (str[i] === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// ============================================================
// EventManager
// ============================================================

/**
 * EventManager - Queues and dispatches events based on triggers.
 * Events are matched by trigger type & level, sorted by priority,
 * and filtered by condition and only_once flags.
 *
 * CRITICAL CHANGE: trigger() now returns the GameEvent objects and
 * the caller is responsible for pushing them to the EventState.
 * The EventState reads from the eventQueue and processes events
 * sequentially.
 */
export class EventManager {
  private allEvents: Map<NID, EventPrefab>;
  /** Queue of events waiting to be processed. First in = first out. */
  eventQueue: GameEvent[];
  private onceTriggered: Set<NID>;

  constructor(events: Map<NID, EventPrefab>) {
    this.allEvents = events;
    this.eventQueue = [];
    this.onceTriggered = new Set();
  }

  /**
   * Check for matching events and queue them.
   * Returns true if at least one event was triggered.
   *
   * The caller MUST check hasActiveEvents() after this and push
   * EventState onto the state machine if events are queued.
   */
  trigger(trigger: EventTrigger, context: ConditionContext): boolean {
    const matches = this.findMatchingEvents(trigger);
    let triggered = false;

    for (const prefab of matches) {
      // Skip events that have already been triggered (only_once)
      if (prefab.only_once && this.onceTriggered.has(prefab.nid)) {
        continue;
      }

      // Build full condition context
      const fullContext: ConditionContext = {
        ...context,
        unit1: trigger.unit1 ?? context.unit1,
        unit2: trigger.unit2 ?? context.unit2,
        position: trigger.position ?? context.position,
        region: trigger.region ?? context.region,
        item: trigger.item ?? context.item,
      };

      // Evaluate the condition
      if (!evaluateCondition(prefab.condition, fullContext)) {
        continue;
      }

      // Mark as triggered if only_once
      if (prefab.only_once) {
        this.onceTriggered.add(prefab.nid);
      }

      // Create and enqueue the event
      const event = new GameEvent(prefab, trigger);
      if (!event.isDone()) {
        this.eventQueue.push(event);
        triggered = true;
        console.log(`EventManager: triggered "${prefab.nid}" (${prefab.trigger})`);
      }
    }

    return triggered;
  }

  /** Get the current event being processed (front of queue). */
  getCurrentEvent(): GameEvent | null {
    if (this.eventQueue.length === 0) return null;
    return this.eventQueue[0];
  }

  /** Remove the front event from the queue (called when event finishes). */
  dequeueCurrentEvent(): void {
    if (this.eventQueue.length > 0) {
      this.eventQueue.shift();
    }
  }

  /** Check if any events are queued. */
  hasActiveEvents(): boolean {
    return this.eventQueue.length > 0;
  }

  /**
   * Get all event prefabs that match a trigger, without actually triggering them.
   * Used for checking if a Talk, Visit, etc. option should be shown.
   */
  getEventsForTrigger(trigger: EventTrigger, context?: ConditionContext): EventPrefab[] {
    return this.findMatchingEvents(trigger).filter((prefab) => {
      if (prefab.only_once && this.onceTriggered.has(prefab.nid)) return false;
      // If context provided, also check condition
      if (context) {
        return evaluateCondition(prefab.condition, context);
      }
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
      if (prefab.level_nid !== null && prefab.level_nid !== '' && trigger.levelNid !== undefined) {
        if (prefab.level_nid !== trigger.levelNid) {
          continue;
        }
      }

      // If the event is scoped to a level but the trigger has no level, skip
      if (prefab.level_nid !== null && prefab.level_nid !== '' && trigger.levelNid === undefined) {
        continue;
      }

      matches.push(prefab);
    }

    // Sort by priority descending (higher priority first)
    matches.sort((a, b) => b.priority - a.priority);

    return matches;
  }
}
