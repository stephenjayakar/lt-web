import type { NID, EventPrefab } from '../data/types';
import { isPyev1 as _isPyev1, PythonEventProcessor as _PythonEventProcessor } from './python-events';
import { GameQueryEngine } from '../engine/query-engine';
import type { ActionLog } from '../engine/action';
import { OnlyOnceEventAction, SetGameVarAction } from '../engine/action';
import { reportUnimplemented } from '../engine/strict-mode';
import { Lcg } from '../engine/static-random';
import { RECORDS } from '../engine/records';

type ItemAvailabilityEvaluator = (
  unit: any,
  item: any,
  db: any,
  game?: any,
) => boolean;

// `var` is intentional: item-system registers through this setter while an
// event-manager/python-events cycle is still being initialized in Node-side
// audit tests. A lexical binding would be in its TDZ at that point.
var itemAvailabilityEvaluator: ItemAvailabilityEvaluator | null | undefined;

/**
 * Register item_system.available without importing the item dispatcher here.
 * item-system already depends on the expression evaluator, so registration
 * preserves that one-way module dependency while exposing Python's eval API.
 */
export function setItemAvailabilityEvaluator(
  evaluator: ItemAvailabilityEvaluator,
): void {
  itemAvailabilityEvaluator = evaluator;
}

// Lazy accessor to avoid circular-import issues at module evaluation time.
function _getPythonEvents() {
  return { isPyev1: _isPyev1, PythonEventProcessor: _PythonEventProcessor };
}

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
  baseConvo?: NID;       // base conversation nid (on_base_convo)
  unit?: NID;            // deprecated field (on_base_convo)
  // Context objects for condition evaluation
  unit1?: any;           // UnitObject reference
  unit2?: any;           // UnitObject reference
  position?: [number, number];
  region?: any;          // RegionData reference
  item?: any;            // ItemObject reference
  statChanges?: Record<string, number>;
  source?: string;
  weaponType?: NID;
  oldWexp?: number;
  rank?: string;
  isAnimationCombat?: boolean;
  playback?: any[];
  /** Extra component/trigger arguments exposed to event expressions. */
  localArgs?: Map<string, any>;
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
  | 'enable_convoy' | 'disable_convoy' | 'open_convoy' | 'enable_supports' | 'enable_turnwheel'
  | 'activate_turnwheel' | 'clear_turnwheel'
  | 'stop_turnwheel_recording' | 'start_turnwheel_recording'
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
  | 'interact_unit' | 'resurrect' | 'set_position'
  | 'set_skill_data' | 'set_mode_rng' | 'set_mode_autolevels' | 'show_minimap'
  | 'records_screen' | 'open_library' | 'open_guide' | 'open_credits' | 'soundroom' | 'open_trade'
  | 'change_roaming' | 'change_roaming_unit' | 'clean_up_roaming' | 'trigger_script' | 'trigger_script_with_args'
  | 'recruit_generic' | 'merge_parties' | 'loop_units' | 'add_fatigue' | 'remove_generics_from_region' | 'add_unit_map_anim' | 'remove_unit_map_anim' | 'enable_repair_shop' | 'force_chapter_clean_up' | 'arrange_formation' | 'text_entry' | 'change_bg_tilemap' | 'change_team_palette' | 'set_custom_options' | 'pose_unit' | 'open_bexp_menu' | 'party_transfer' | 'open_unit_management' | 'change_roam_ai'
  | 'add_item_component' | 'modify_item_component' | 'remove_item_component'
  | 'add_skill_component' | 'modify_skill_component' | 'remove_skill_component'
  | 'set_game_board_bounds' | 'remove_game_board_bounds' | 'dump_vars' | 'delete_save'
  // Modify unit properties
  | 'set_name' | 'set_current_hp' | 'set_current_mana'
  | 'set_variant' | 'set_unit_field' | 'set_unit_note' | 'remove_unit_note'
  | 'reset' | 'has_attacked' | 'has_traded' | 'has_finished'
  | 'give_item' | 'equip_item' | 'remove_item' | 'move_item' | 'move_item_between_convoys'
  | 'set_item_uses' | 'set_item_data' | 'set_item_droppable' | 'break_item'
  | 'change_item_name' | 'change_item_desc'
  | 'add_item_to_multiitem' | 'remove_item_from_multiitem'
  | 'give_exp' | 'set_exp' | 'give_wexp' | 'set_wexp'
  | 'give_skill' | 'remove_skill'
  | 'change_ai' | 'change_party' | 'change_faction' | 'change_team'
  | 'change_ai_group' | 'change_portrait' | 'change_unit_desc' | 'change_affinity'
  | 'change_stats' | 'set_stats' | 'change_growths' | 'set_growths'
  | 'change_stat_cap_modifiers' | 'set_stat_cap_modifiers'
  | 'set_unit_level' | 'autolevel_to' | 'promote' | 'change_class'
  | 'add_tag' | 'remove_tag'
  // Unit groups
  | 'add_group' | 'spawn_group' | 'move_group' | 'remove_group'
  // Misc
  | 'battle_save' | 'prep' | 'base' | 'shop' | 'choice' | 'unchoice'
  | 'chapter_title' | 'set_tile'
  | 'has_visited' | 'unlock' | 'find_unlock' | 'spend_unlock'
  | 'pair_up' | 'separate'
  // Overworld
  | 'toggle_narration_mode' | 'overworld_cinematic' | 'reveal_overworld_node'
  | 'reveal_overworld_road' | 'overworld_move_unit' | 'set_overworld_position'
  | 'create_overworld_entity' | 'disable_overworld_entity'
  | 'set_overworld_menu_option_enabled' | 'set_overworld_menu_option_visible'
  | 'enter_level_from_overworld'
  // Arena / overlay
  | 'draw_overlay_sprite' | 'remove_overlay_sprite' | 'table' | 'remove_table' | 'textbox'
  // Fog of war
  | 'enable_fog_of_war' | 'set_fog_of_war'
  // Misc advanced
  | 'add_lore' | 'remove_lore' | 'add_base_convo' | 'ignore_base_convo' | 'remove_base_convo'
  | 'clear_market_items'
  // Victory / credits
  | 'victory_screen' | 'credit'
  // Support system
  | 'increment_support_points' | 'unlock_support_rank' | 'disable_support_rank'
  // Initiative
  | 'add_to_initiative' | 'move_in_initiative'
  // Roam mode
  | 'set_roam' | 'set_roam_unit'
  // Persistent records & achievements
  | 'create_record' | 'update_record' | 'replace_record' | 'delete_record'
  | 'unlock_difficulty' | 'unlock_song'
  | 'create_achievement' | 'update_achievement' | 'complete_achievement' | 'clear_achievements'
  | 'open_achievements'
  // Save/load
  | 'battle_save_prompt' | 'suspend'
  // Short aliases
  | 's' | 'bop'
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
  'enable_convoy', 'disable_convoy', 'open_convoy', 'enable_supports', 'enable_turnwheel',
  'activate_turnwheel', 'clear_turnwheel',
  'stop_turnwheel_recording', 'start_turnwheel_recording',
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
  'interact_unit', 'resurrect', 'set_position',
  'set_skill_data', 'set_mode_rng', 'set_mode_autolevels', 'show_minimap',
  'records_screen', 'open_library', 'open_guide', 'open_credits', 'soundroom', 'open_trade',
  'change_roaming', 'change_roaming_unit', 'clean_up_roaming', 'trigger_script', 'trigger_script_with_args',
  'recruit_generic', 'merge_parties', 'loop_units', 'add_fatigue', 'remove_generics_from_region', 'add_unit_map_anim', 'remove_unit_map_anim', 'enable_repair_shop', 'force_chapter_clean_up', 'arrange_formation', 'text_entry', 'change_bg_tilemap', 'change_team_palette', 'set_custom_options', 'pose_unit', 'open_bexp_menu', 'party_transfer', 'open_unit_management', 'change_roam_ai',
  'add_item_component', 'modify_item_component', 'remove_item_component',
  'add_skill_component', 'modify_skill_component', 'remove_skill_component',
  'set_game_board_bounds', 'remove_game_board_bounds', 'dump_vars', 'delete_save',
  // Modify unit properties
  'set_name', 'set_variant', 'set_current_hp', 'set_current_mana',
  'set_unit_field', 'set_unit_note', 'remove_unit_note',
  'reset', 'has_attacked', 'has_traded', 'has_finished',
  'give_item', 'equip_item', 'remove_item', 'move_item', 'move_item_between_convoys',
  'set_item_uses', 'set_item_data', 'set_item_droppable', 'break_item',
  'change_item_name', 'change_item_desc',
  'add_item_to_multiitem', 'remove_item_from_multiitem',
  'give_exp', 'set_exp', 'give_wexp', 'set_wexp',
  'give_skill', 'remove_skill',
  'change_ai', 'change_ai_group', 'change_party', 'change_faction', 'change_team',
  'change_portrait', 'change_unit_desc', 'change_affinity',
  'change_stats', 'set_stats', 'change_growths', 'set_growths',
  'change_stat_cap_modifiers', 'set_stat_cap_modifiers',
  'set_unit_level', 'autolevel_to', 'promote', 'change_class',
  'add_tag', 'remove_tag',
  // Unit groups
  'add_group', 'spawn_group', 'move_group', 'remove_group',
  // Misc
  'battle_save', 'prep', 'base', 'shop', 'choice', 'unchoice',
  'chapter_title', 'set_tile',
  'has_visited', 'unlock', 'find_unlock', 'spend_unlock',
  'pair_up', 'separate',
  // Base screen
  'add_base_convo', 'ignore_base_convo', 'remove_base_convo',
  'clear_market_items', 'add_lore', 'remove_lore',
  // Support system
  'increment_support_points', 'unlock_support_rank', 'disable_support_rank',
  // Fog of war
  'enable_fog_of_war', 'set_fog_of_war',
  // Initiative
  'add_to_initiative', 'move_in_initiative',
  // Victory / credits
  'victory_screen', 'credit',
  // Overworld
  'create_overworld_entity', 'disable_overworld_entity',
  'overworld_cinematic', 'reveal_overworld_node', 'reveal_overworld_road',
  'overworld_move_unit', 'set_overworld_position',
  'set_overworld_menu_option_enabled', 'set_overworld_menu_option_visible',
  'enter_level_from_overworld',
  // Persistent records & achievements
  'create_record', 'update_record', 'replace_record', 'delete_record',
  'unlock_difficulty', 'unlock_song',
  'create_achievement', 'update_achievement', 'complete_achievement', 'clear_achievements',
  'open_achievements',
  // Save/load
  'battle_save', 'battle_save_prompt', 'skip_save', 'suspend',
  // Roam mode
  'set_roam', 'set_roam_unit',
  // Overlay commands are recognized even while their visual implementations remain pending
  'draw_overlay_sprite', 'remove_overlay_sprite', 'table', 'remove_table', 'textbox',
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
  'omove': 'overworld_move_unit',
  'set_ai_group': 'change_ai_group',
  'morph_group': 'move_group',
  'break': 'finish',
  'resurrect_unit': 'resurrect',
  'unlock_lore': 'add_lore',
  'rescue': 'pair_up',
  'drop': 'separate',
  // Pre-parity web builds exposed this non-Python name.
  'add_achievement': 'create_achievement',
  // Legacy names from our old code
  'set_game_var': 'game_var',
  'change_objective': 'change_objective_simple',
};

/**
 * GameEvent - A single event instance being executed.
 * Commands are parsed from semicolon-delimited source lines,
 * or processed through the PYEV1 Python-syntax event system.
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

  /** PYEV1 processor for Python-syntax events (null for standard events). */
  pyev1Processor: any | null;

  constructor(prefab: EventPrefab, trigger: EventTrigger, gameGetter?: () => any) {
    this.nid = prefab.nid;
    this.commands = [];
    this.commandPointer = 0;
    this.state = 'running';
    this.trigger = trigger;
    this.currentDialog = null;
    this.waitingForInput = false;
    this.pyev1Processor = null;

    // Check for PYEV1 format
    const { isPyev1, PythonEventProcessor } = _getPythonEvents();
    if (isPyev1(prefab._source)) {
      // Use PYEV1 processor
      this.pyev1Processor = new PythonEventProcessor(prefab._source, gameGetter);
      // Pre-fetch initial commands won't be used — getNextCommand will use pyev1
    } else {
      // Standard semicolon-delimited format
      for (const line of prefab._source) {
        const cmd = GameEvent.parseCommand(line);
        if (cmd) {
          this.commands.push(cmd);
        }
      }
    }

    // If the event has no commands and no pyev1 processor, mark as done immediately
    if (this.commands.length === 0 && !this.pyev1Processor) {
      this.state = 'done';
    }
  }

  /**
   * Get the next command for this event.
   * For PYEV1 events, fetches from the Python processor.
   * For standard events, returns the command at the current pointer.
   */
  getNextCommand(): EventCommand | null {
    if (this.pyev1Processor) {
      const cmd = this.pyev1Processor.fetchNextCommand();
      if (!cmd) {
        if (this.pyev1Processor.finished) {
          this.state = 'done';
        }
        return null;
      }
      return cmd;
    }
    // Standard path
    if (this.commandPointer >= this.commands.length) return null;
    return this.commands[this.commandPointer];
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
      reportUnimplemented('command', rawType, `line: "${line}"`);
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

  // 'X' in unit.tags / 'X' in unit1.tags / 'X' in unit2.tags (Python `in` for lists)
  const inMatch = trimmed.match(/^['"](.+?)['"]\s+in\s+(.+)$/);
  if (inMatch) {
    const needle = inMatch[1];
    const haystack = resolvePath(inMatch[2], context);
    if (Array.isArray(haystack)) return haystack.includes(needle);
    if (typeof haystack === 'string') return haystack.includes(needle);
    return false;
  }

  // 'X' not in unit.tags
  const notInMatch = trimmed.match(/^['"](.+?)['"]\s+not\s+in\s+(.+)$/);
  if (notInMatch) {
    const needle = notInMatch[1];
    const haystack = resolvePath(notInMatch[2], context);
    if (Array.isArray(haystack)) return !haystack.includes(needle);
    if (typeof haystack === 'string') return !haystack.includes(needle);
    return true;
  }

  // Function calls: game.check_dead('Name'), check_dead('Name'), check_pair('A','B')
  const funcMatch = trimmed.match(/^(?:game\.)?check_dead\s*\(\s*['"](.+?)['"]\s*\)/);
  if (funcMatch) {
    const unitNid = funcMatch[1];
    return isUnitDead(unitNid, context);
  }

  // game.check_alive('Name') / check_alive('Name') — opposite of check_dead
  const aliveMatch = trimmed.match(/^(?:game\.)?check_alive\s*\(\s*['"](.+?)['"]\s*\)/);
  if (aliveMatch) {
    return !isUnitDead(aliveMatch[1], context);
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

  // has_item('ItemNid', unit_nid_or_specifier) — check if a unit has an item
  const hasItemMatch = trimmed.match(/^has_item\s*\(\s*['"](.+?)['"]\s*(?:,\s*(.+?))?\s*\)/);
  if (hasItemMatch) {
    const itemNid = hasItemMatch[1];
    const specifier = hasItemMatch[2]?.trim();
    // If specifier is a path like unit.nid, resolve it
    let targetNid: string | undefined;
    if (specifier) {
      const resolved = resolvePath(specifier, context);
      targetNid = typeof resolved === 'string' ? resolved : undefined;
    }
    // Search units for the item
    if (context.game?.units) {
      for (const [_, u] of context.game.units) {
        if (targetNid && (u as any).nid !== targetNid) continue;
        const items = (u as any).items ?? [];
        if (items.some((item: any) => item.nid === itemNid)) return true;
      }
    }
    return false;
  }

  // has_skill('SkillNid', unit_nid_or_specifier) — check if a unit has a skill
  const hasSkillFuncMatch = trimmed.match(/^has_skill\s*\(\s*['"](.+?)['"]\s*(?:,\s*(.+?))?\s*\)/);
  if (hasSkillFuncMatch) {
    const skillNid = hasSkillFuncMatch[1];
    const specifier = hasSkillFuncMatch[2]?.trim();
    let targetUnit = context.unit1;
    if (specifier) {
      const resolved = resolvePath(specifier, context);
      if (typeof resolved === 'string' && context.game?.units) {
        targetUnit = context.game.units.get(resolved);
      } else if (resolved && typeof resolved === 'object') {
        targetUnit = resolved;
      }
    }
    if (!targetUnit) return false;
    const skills = targetUnit.skills ?? [];
    return skills.some((s: any) => s.nid === skillNid);
  }

  // v('varname') / v('varname', default) — variable lookup (level vars then game vars)
  const vMatch = trimmed.match(/^v\s*\(\s*['"]([^'"]+)['"]\s*(?:,\s*(.+?))?\s*\)$/);
  if (vMatch) {
    const varName = vMatch[1];
    const fallback = vMatch[2] !== undefined ? resolvePath(vMatch[2], context) : undefined;
    if (context.levelVars?.has(varName)) return context.levelVars.get(varName);
    if (context.gameVars?.has(varName)) return context.gameVars.get(varName);
    return fallback ?? 0;
  }

  // unit.can_unlock(region) — check if unit has a key/lockpick item
  const canUnlockMatch = trimmed.match(/^(?:unit\d?\.)?can_unlock\s*\(\s*(\w+)\s*\)/);
  if (canUnlockMatch) {
    const unit = context.unit1;
    const region = context.region;
    if (!unit) return false;
    if (typeof unit.canUnlock === 'function') return unit.canUnlock(region);
    const items = unit.items ?? [];

    const canUnlockByExpr = (expr: unknown): boolean => {
      if (typeof expr !== 'string') return !!expr;
      const trimmedExpr = expr.trim();
      if (!region?.nid) return false;

      // Common LT patterns for key restrictions.
      const chestMatch = trimmedExpr.match(/^region\.nid\.startswith\(\s*['"]Chest['"]\s*\)$/);
      if (chestMatch) return String(region.nid).startsWith('Chest');
      const doorMatch = trimmedExpr.match(/^region\.nid\.startswith\(\s*['"]Door['"]\s*\)$/);
      if (doorMatch) return String(region.nid).startsWith('Door');

      // Fallback: try generic condition evaluation with current context.
      return evaluateCondition(trimmedExpr, context);
    };

    return items.some((item: any) => {
      const comps = item.components;

      // Runtime ItemObject stores components as Map<string, any>.
      if (comps instanceof Map) {
        if (comps.has('can_unlock')) {
          return canUnlockByExpr(comps.get('can_unlock'));
        }
        return comps.has('unlock') || comps.has('lockpick') || comps.has('key') ||
               comps.has('keys') || comps.has('Key') || comps.has('Keys');
      }

      // Fallbacks for prefab-like shapes used by tools/tests.
      if (Array.isArray(comps)) {
        const canUnlockComp = comps.find((c: any) => (Array.isArray(c) ? c[0] : c?.nid ?? c?.name) === 'can_unlock');
        if (canUnlockComp) {
          const expr = Array.isArray(canUnlockComp) ? canUnlockComp[1] : canUnlockComp?.value;
          return canUnlockByExpr(expr);
        }
        return comps.some((c: any) => {
          const name = Array.isArray(c) ? c[0] : c?.nid ?? c?.name ?? '';
          return name === 'unlock' || name === 'lockpick' || name === 'key' ||
                 name === 'keys' || name === 'Key' || name === 'Keys';
        });
      }

      if (comps && typeof comps === 'object') {
        if ('can_unlock' in comps) {
          return canUnlockByExpr((comps as any).can_unlock);
        }
        return 'unlock' in comps || 'lockpick' in comps || 'key' in comps ||
               'keys' in comps || 'Key' in comps || 'Keys' in comps;
      }

      return false;
    });
  }

  // is_dead('UnitNid') — shorthand for check_dead
  const isDeadMatch = trimmed.match(/^(?:game\.)?is_dead\s*\(\s*['"](.+?)['"]\s*\)/);
  if (isDeadMatch) {
    return isUnitDead(isDeadMatch[1], context);
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

  // any_unit_in_region('RegionNid', team='enemy') and similar patterns
  const anyUnitInRegionMatch = trimmed.match(/^any_unit_in_region\s*\(\s*['"](.+?)['"]\s*(?:,\s*(?:team\s*=\s*)?['"](.+?)['"]\s*)?\)/);
  if (anyUnitInRegionMatch) {
    const regionNid = anyUnitInRegionMatch[1];
    const teamFilter = anyUnitInRegionMatch[2];
    const regions = context.game?.currentLevel?.regions ?? [];
    const region = regions.find((r: any) => r.nid === regionNid);
    if (!region) return false;
    const [rx, ry] = region.position;
    const [rw, rh] = region.size;
    if (context.game?.units) {
      for (const [_, u] of context.game.units) {
        if (teamFilter && (u as any).team !== teamFilter) continue;
        const pos = (u as any).position;
        if (!pos) continue;
        if (pos[0] >= rx && pos[0] < rx + rw && pos[1] >= ry && pos[1] < ry + rh) {
          return true;
        }
      }
    }
    return false;
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

  // Fallback: try JavaScript-based evaluation with Python-compatible scope.
  // This handles complex expressions like:
  //   game.level.regions.get('EnemyRein').contains(game.get_unit('Eirika').position)
  //   any(game.level.regions.get('X').contains(u.position) for u in game.get_units_in_party())
  //   len(game.get_enemy_units()) == 0
  try {
    const result = evaluateWithJsFallback(trimmed, context);
    if (result !== undefined) {
      return !!result;
    }
  } catch (e) {
    // Fall through to default
  }

  // Unknown condition — warn and default to false (skip events with un-evaluable conditions;
  // firing them would cause reinforcements/etc. to trigger at wrong times)
  reportUnimplemented('expression', trimmed, 'event condition');
  return false;
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

/** Evaluate a non-boolean event expression for {e:...}/{eval:...} arguments. */
export function evaluateExpression(expression: string, context: ConditionContext): any {
  const direct = resolvePath(expression, context);
  if (direct !== undefined) return direct;
  const value = evaluateWithJsFallback(expression, context);
  if (value === undefined) {
    reportUnimplemented('expression', expression, 'event expression');
  }
  return value;
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

  // target is the item-component alias for unit2.
  if (parts[0] === 'target' && ctx.unit2) {
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
  const resolveOperand = (operand: string): any => {
    const direct = resolvePath(operand, ctx);
    if (direct !== undefined) return direct;
    return evaluateWithJsFallback(operand, ctx, false);
  };
  const lhsValue = resolveOperand(lhsStr);
  const rhsValue = resolveOperand(rhsStr);

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

/** Translate Python any/all generator expressions without losing nested calls. */
function translateGeneratorExpressions(expression: string): string {
  let translated = expression;
  for (let pass = 0; pass < 20; pass++) {
    const match = /\b(any|all)\s*\(/g.exec(translated);
    if (!match || match.index === undefined) break;
    const open = translated.indexOf('(', match.index);
    const close = findMatchingParen(translated, open);
    if (close < 0) break;
    const inner = translated.slice(open + 1, close);
    const forParts = splitAtTopLevel(inner, ' for ');
    if (forParts.length !== 2) {
      // This any/all call is not a generator. Move it out of consideration.
      const prefix = translated.slice(0, close + 1).replace(
        new RegExp(`\\b${match[1]}\\s*\\(`),
        match[1] === 'any' ? '__any__(' : '__all__(',
      );
      translated = prefix + translated.slice(close + 1);
      continue;
    }
    const inParts = splitAtTopLevel(forParts[1], ' in ');
    if (inParts.length < 2) break;
    const variable = inParts[0].trim();
    const ifParts = splitAtTopLevel(inParts.slice(1).join(' in '), ' if ');
    const collection = ifParts[0].trim();
    const predicate = (ifParts[1] ?? forParts[0]).trim();
    const method = match[1] === 'any' ? 'some' : 'every';
    const replacement = `(${collection}).${method}((${variable}) => (${predicate}))`;
    translated = translated.slice(0, match.index) + replacement + translated.slice(close + 1);
  }
  return translated;
}

function findMatchingBracket(expression: string, start: number): number {
  let depth = 0;
  let inString: string | null = null;
  for (let index = start; index < expression.length; index++) {
    const char = expression[index];
    if (inString) {
      if (char === inString && expression[index - 1] !== '\\') inString = null;
      continue;
    }
    if (char === "'" || char === '"') {
      inString = char;
      continue;
    }
    if (char === '[') depth += 1;
    if (char === ']') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function translateListComprehensions(expression: string): string {
  let translated = expression;
  for (let pass = 0; pass < 20; pass++) {
    let changed = false;
    for (let open = translated.lastIndexOf('['); open >= 0;) {
      const close = findMatchingBracket(translated, open);
      if (close < 0) {
        if (open === 0) break;
        open = translated.lastIndexOf('[', open - 1);
        continue;
      }
      const inner = translated.slice(open + 1, close);
      const forParts = splitAtTopLevel(inner, ' for ');
      if (forParts.length !== 2) {
        if (open === 0) break;
        open = translated.lastIndexOf('[', open - 1);
        continue;
      }
      const inParts = splitAtTopLevel(forParts[1], ' in ');
      if (inParts.length < 2) {
        if (open === 0) break;
        open = translated.lastIndexOf('[', open - 1);
        continue;
      }
      const variable = inParts[0].trim();
      const ifParts = splitAtTopLevel(inParts.slice(1).join(' in '), ' if ');
      const collection = ifParts[0].trim();
      const filter = ifParts[1]?.trim();
      const mapped = filter
        ? `(${collection}).filter((${variable}) => (${filter})).map((${variable}) => (${forParts[0].trim()}))`
        : `(${collection}).map((${variable}) => (${forParts[0].trim()}))`;
      translated = translated.slice(0, open) + mapped + translated.slice(close + 1);
      changed = true;
      break;
    }
    if (!changed) break;
  }
  return translated;
}

function translateFloorDivision(expression: string): string {
  let translated = expression;
  for (let pass = 0; pass < 20; pass++) {
    const operator = translated.indexOf('//');
    if (operator < 0) break;

    // Find the operands at the operator's current parenthesis depth. This
    // avoids a regex greedily consuming an enclosing call such as
    // min(game.get_unit(...).get_stat('MAG') // 2, 20).
    let leftStart = 0;
    let depth = 0;
    for (let index = operator - 1; index >= 0; index--) {
      const char = translated[index];
      if (
        depth === 0 &&
        (translated.slice(Math.max(0, index - 5), index + 1) === ' else ' ||
          translated.slice(Math.max(0, index - 3), index + 1) === ' if ' ||
          translated.slice(Math.max(0, index - 4), index + 1) === ' and ' ||
          translated.slice(Math.max(0, index - 3), index + 1) === ' or ')
      ) {
        leftStart = index + 1;
        break;
      }
      if (char === ')' || char === ']' || char === '}') {
        depth++;
      } else if (char === '(' || char === '[' || char === '{') {
        if (depth > 0) depth--;
        else {
          leftStart = index + 1;
          break;
        }
      } else if (
        depth === 0 &&
        (char === ',' || char === '?' || char === ':' ||
          /[+*%<>=&|]/.test(char))
      ) {
        leftStart = index + 1;
        break;
      }
    }

    let rightEnd = translated.length;
    depth = 0;
    for (let index = operator + 2; index < translated.length; index++) {
      const char = translated[index];
      if (char === '(' || char === '[' || char === '{') {
        depth++;
      } else if (char === ')' || char === ']' || char === '}') {
        if (depth > 0) depth--;
        else {
          rightEnd = index;
          break;
        }
      } else if (
        depth === 0 &&
        (char === ',' || char === '?' || char === ':' ||
          /[+*%<>=&|]/.test(char))
      ) {
        rightEnd = index;
        break;
      } else if (
        depth === 0 &&
        (translated.startsWith(' if ', index) ||
          translated.startsWith(' else ', index) ||
          translated.startsWith(' and ', index) ||
          translated.startsWith(' or ', index))
      ) {
        rightEnd = index;
        break;
      }
    }

    const left = translated.slice(leftStart, operator).trim();
    const right = translated.slice(operator + 2, rightEnd).trim();
    if (!left || !right) break;
    translated =
      translated.slice(0, leftStart) +
      `Math.floor((${left}) / (${right}))` +
      translated.slice(rightEnd);
  }
  return translated;
}

/**
 * Translate Python conditional expressions at any parenthesis depth.
 *
 * A single regex only handles one top-level `value if condition else other`
 * form. EotF uses both nested conditionals and conditionals embedded inside
 * larger arithmetic expressions, so recursively translate balanced groups
 * before resolving the conditional at the current depth.
 */
function translateConditionalExpressions(expression: string): string {
  let grouped = '';
  let inString: string | null = null;
  for (let index = 0; index < expression.length; index++) {
    const char = expression[index];
    if (inString) {
      grouped += char;
      if (char === inString && expression[index - 1] !== '\\') inString = null;
      continue;
    }
    if (char === "'" || char === '"') {
      inString = char;
      grouped += char;
      continue;
    }
    if (char === '(' || char === '[') {
      const closeChar = char === '(' ? ')' : ']';
      let depth = 1;
      let nestedString: string | null = null;
      let close = index + 1;
      for (; close < expression.length; close++) {
        const nestedChar = expression[close];
        if (nestedString) {
          if (nestedChar === nestedString && expression[close - 1] !== '\\') {
            nestedString = null;
          }
          continue;
        }
        if (nestedChar === "'" || nestedChar === '"') {
          nestedString = nestedChar;
          continue;
        }
        if (nestedChar === char) depth += 1;
        if (nestedChar === closeChar) {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      if (depth === 0) {
        grouped += char +
          translateConditionalExpressions(expression.slice(index + 1, close)) +
          closeChar;
        index = close;
        continue;
      }
    }
    grouped += char;
  }

  const findToken = (source: string, token: string, start = 0): number => {
    let quoted: string | null = null;
    let depth = 0;
    for (let index = start; index <= source.length - token.length; index++) {
      const char = source[index];
      if (quoted) {
        if (char === quoted && source[index - 1] !== '\\') quoted = null;
        continue;
      }
      if (char === "'" || char === '"') {
        quoted = char;
        continue;
      }
      if (char === '(' || char === '[') depth += 1;
      if (char === ')' || char === ']') depth -= 1;
      if (depth === 0 && source.slice(index, index + token.length) === token) {
        return index;
      }
    }
    return -1;
  };

  const ifIndex = findToken(grouped, ' if ');
  if (ifIndex < 0) return grouped;
  const elseIndex = findToken(grouped, ' else ', ifIndex + 4);
  if (elseIndex < 0) return grouped;
  const whenTrue = grouped.slice(0, ifIndex).trim();
  const condition = grouped.slice(ifIndex + 4, elseIndex).trim();
  const whenFalse = grouped.slice(elseIndex + 6).trim();
  return `((${translateConditionalExpressions(condition)}) ? ` +
    `(${translateConditionalExpressions(whenTrue)}) : ` +
    `(${translateConditionalExpressions(whenFalse)}))`;
}

// ============================================================
// JavaScript-based fallback evaluator for complex Python conditions
// ============================================================

/**
 * Build a Python-compatible game object proxy for use in eval.
 * This creates wrapper objects that mirror the Python API so expressions
 * like `game.level.regions.get('X').contains(pos)` work in JavaScript.
 */
function buildEvalScope(ctx: ConditionContext): Record<string, any> {
  const game = ctx.game;
  if (!game) return {};

  // Region wrapper: adds .contains() method and makes regions accessible via .get()
  function wrapRegion(r: any) {
    if (!r) return null;
    return {
      nid: r.nid,
      region_type: r.region_type,
      position: r.position,
      size: r.size,
      sub_nid: r.sub_nid,
      condition: r.condition,
      contains(pos: [number, number] | null): boolean {
        if (!pos || !r.position) return false;
        const [px, py] = pos;
        const [rx, ry] = r.position;
        const [rw, rh] = r.size ?? [1, 1];
        return px >= rx && px < rx + rw && py >= ry && py < ry + rh;
      },
    };
  }

  // Regions collection wrapper: adds .get(nid) method
  function wrapRegions(regions: any[]) {
    return {
      get(nid: string) {
        const r = regions.find((reg: any) => reg.nid === nid);
        return wrapRegion(r);
      },
      values() { return regions.map(wrapRegion); },
    };
  }

  function wrapMapping(value: any) {
    if (value instanceof Map) {
      return new Proxy(value, {
        get(target, property: string | symbol) {
          if (property === 'get') return target.get.bind(target);
          if (property === 'has') return target.has.bind(target);
          if (typeof property === 'string' && target.has(property)) {
            return target.get(property);
          }
          const result = target[property as keyof Map<any, any>];
          return typeof result === 'function' ? result.bind(target) : result;
        },
      });
    }
    return {
      ...(value ?? {}),
      get(key: string, fallback?: any) {
        const result = value?.[key];
        return result === undefined ? fallback : result;
      },
    };
  }

  function componentEntries(candidate: any): [string, any][] {
    const components = candidate?.components;
    if (components instanceof Map) return [...components.entries()];
    if (Array.isArray(components)) {
      return components.filter((entry): entry is [string, any] =>
        Array.isArray(entry) && typeof entry[0] === 'string');
    }
    return components && typeof components === 'object'
      ? Object.entries(components)
      : [];
  }

  function componentValue(candidate: any, nid: string): any {
    if (typeof candidate?.getComponent === 'function') {
      return candidate.hasComponent?.(nid) ? candidate.getComponent(nid) : undefined;
    }
    return componentEntries(candidate).find(([component]) => component === nid)?.[1];
  }

  function wrapComponent(nid: string, value: any) {
    return {
      nid,
      value: value && typeof value === 'object' && !Array.isArray(value)
        ? wrapMapping(value)
        : value,
    };
  }

  function wrapComponents(candidate: any) {
    const values = new Map(componentEntries(candidate).map(([nid, value]) =>
      [nid, wrapComponent(nid, value)]));
    return {
      get(nid: string) {
        return values.get(nid) ?? null;
      },
      has(nid: string) {
        return values.has(nid);
      },
      values() {
        return [...values.values()];
      },
      [Symbol.iterator]() {
        return values.values();
      },
    };
  }

  const wrappedItems = new WeakMap<object, any>();
  function wrapItem(item: any): any {
    if (!item) return null;
    if (typeof item !== 'object') return item;
    const existing = wrappedItems.get(item);
    if (existing) return existing;
    const components = wrapComponents(item);
    const target = {
      _raw: item,
      uid: item.uid,
      nid: item.nid,
      name: item.name,
      desc: item.desc,
      tags: componentValue(item, 'item_tags') ?? item.tags ?? [],
      components,
    };
    const wrapped = new Proxy(target as Record<string, any>, {
      get(proxyTarget, property: string | symbol) {
        if (property in proxyTarget) return proxyTarget[property as string];
        if (typeof property === 'string' && components.has(property)) {
          return components.get(property);
        }
        return item[property as keyof typeof item];
      },
    });
    wrappedItems.set(item, wrapped);
    return wrapped;
  }

  const wrappedSkills = new WeakMap<object, any>();
  function wrapSkill(skill: any): any {
    if (!skill) return null;
    if (typeof skill !== 'object') return skill;
    const existing = wrappedSkills.get(skill);
    if (existing) return existing;
    const components = wrapComponents(skill);
    const target = {
      _raw: skill,
      uid: skill.uid,
      nid: skill.nid,
      name: skill.name,
      desc: skill.desc,
      owner_nid: skill.ownerNid ?? null,
      initiator_nid: skill.initiatorNid ?? null,
      data: wrapMapping(skill.data),
      components,
    };
    const wrapped = new Proxy(target as Record<string, any>, {
      get(proxyTarget, property: string | symbol) {
        if (property in proxyTarget) return proxyTarget[property as string];
        if (property === 'parent_skill') {
          const directParent = skill.data?.get?.('multiSkillSource');
          if (directParent) return wrapSkill(directParent);
          const ownerNid = skill.data?.get?.('auraOwnerNid');
          const parentUid = skill.data?.get?.('auraParentSkillUid');
          const owner = ownerNid ? game.units?.get?.(ownerNid) : null;
          const auraParent = owner?.skills?.find?.(
            (candidate: any) => candidate.uid === parentUid,
          );
          return wrapSkill(auraParent);
        }
        if (typeof property === 'string' && components.has(property)) {
          return components.get(property);
        }
        return skill[property as keyof typeof skill];
      },
    });
    wrappedSkills.set(skill, wrapped);
    return wrapped;
  }

  const wrappedUnits = new WeakMap<object, any>();
  function wrapUnit(u: any): any {
    if (!u) return null;
    if (typeof u !== 'object') return u;
    const existing = wrappedUnits.get(u);
    if (existing) return existing;
    const checkFlanking = (): boolean => {
      if (!u.position || !game.board) return false;
      const [x, y] = u.position;
      const up = game.board.getUnit(x, y - 1);
      const down = game.board.getUnit(x, y + 1);
      const left = game.board.getUnit(x - 1, y);
      const right = game.board.getUnit(x + 1, y);
      const enemy = (other: any) =>
        !!other && !(game.db?.areAllied?.(u.team, other.team) ?? u.team === other.team);
      return (enemy(up) && enemy(down)) || (enemy(left) && enemy(right));
    };
    const wrapped = {
      _raw: u,
      nid: u.nid,
      name: u.name,
      team: u.team,
      position: u.position,
      previous_position: u.previousPosition ?? u.previous_position ?? null,
      tags: u.tags ?? [],
      klass: u.klass,
      affinity: u.affinity ?? null,
      traveler: u.traveler ?? u.rescuing ?? null,
      get strike_partner() {
        return wrapUnit(u.strikePartner ?? u.strike_partner ?? null);
      },
      dead: u.isDead?.() ?? u.dead ?? false,
      is_dying: u.isDying ?? u.is_dying ?? false,
      level: u.level,
      stats: wrapMapping(u.stats),
      growths: u.growths ?? {},
      skills: (u.skills ?? []).map(wrapSkill),
      items: (u.items ?? []).map(wrapItem),
      accessories: u.items?.filter((candidate: any) =>
        candidate.hasComponent?.('accessory') ||
        candidate.hasComponent?.('equippable_accessory')) ?? [],
      current_hp: u.currentHp ?? u.current_hp,
      max_hp: u.maxHp ?? u.max_hp,
      get_hp: () => u.currentHp ?? u.current_hp ?? 0,
      get_max_hp: () => u.getMaxHp?.() ?? u.maxHp ?? u.max_hp ?? u.stats?.HP ?? 0,
      get_stat: (nid: string) =>
        u.getStat?.(nid) ?? u.getStatValue?.(nid) ?? u.stats?.[nid] ?? 0,
      get_internal_level: () => u.getInternalLevel?.() ?? u.level ?? 1,
      get_field: (nid: string, fallback?: any) =>
        u.fields?.has?.(nid) ? u.fields.get(nid) : fallback,
      get_weapon: () => wrapItem(u.getWeapon?.() ?? u.equippedWeapon ?? null),
      get_accessory: () => wrapItem(u.getAccessory?.() ?? u.equippedAccessory ?? null),
      check_flanking: checkFlanking,
    };
    wrappedUnits.set(u, wrapped);
    return wrapped;
  }

  // Helper: get all alive units of a team
  function getTeamUnits(team: string) {
    const units: any[] = [];
    if (game.units) {
      for (const [_, u] of game.units) {
        if ((u as any).team === team && !(u as any).isDead?.()) {
          units.push(wrapUnit(u));
        }
      }
    }
    return units;
  }

  // Build the game proxy object
  const regions = game.currentLevel?.regions ?? [];
  const wrapVars = (variables: Map<string, any> | undefined) => new Proxy(
    {
      get(key: string, fallback?: any) {
        return variables?.has(key) ? variables.get(key) : fallback;
      },
    } as Record<string, any>,
    {
      get(target, property: string | symbol) {
        if (property in target) return target[property as string];
        return typeof property === 'string' ? variables?.get(property) : undefined;
      },
    },
  );
  const gameProxy: any = {
    turncount: game.turnCount ?? game.turncount ?? 0,
    turn_count: game.turnCount ?? game.turncount ?? 0,
    get units() {
      return Array.from(game.units?.values?.() ?? []).map(wrapUnit);
    },
    game_vars: wrapVars(game.gameVars),
    level_vars: wrapVars(game.levelVars),
    board: { bounds: game.board?.bounds ?? [0, 0, 0, 0] },
    tilemap: {
      get_terrain(pos: [number, number] | null) {
        if (!pos) return null;
        return game.board?.getTerrain(pos[0], pos[1]) ??
          game.tilemap?.getTerrain?.(pos[0], pos[1]) ?? null;
      },
    },
    level: {
      regions: wrapRegions(regions),
      nid: game.currentLevel?.nid ?? '',
    },
    phase: {
      get_current() {
        return game.phase?.getCurrent?.() ?? game.phase?.get_current?.() ?? 'player';
      },
    },
    get_unit(nid: string) {
      const u = game.units?.get(nid) ?? game.getUnit?.(nid);
      return wrapUnit(u);
    },
    get_enemy_units() { return getTeamUnits('enemy'); },
    get_player_units() { return getTeamUnits('player'); },
    get_units_in_party() { return getTeamUnits('player'); },
    get_all_units_in_party() { return getTeamUnits('player'); },
    get_all_units() {
      const units: any[] = [];
      if (game.units) {
        for (const [_, u] of game.units) {
          units.push(wrapUnit(u));
        }
      }
      return units;
    },
    get_money() { return game.getMoney?.() ?? 0; },
    get_random(minimum: number, maximum: number) {
      const seed = Number(game.gameVars?.get?.('_random_seed') ?? 0);
      const storedSeed = Number(game.gameVars?.get?.('_other_random_seed'));
      const storedState = Number(game.gameVars?.get?.('_other_random_state'));
      const state = storedSeed === seed && Number.isInteger(storedState)
        ? storedState
        : seed + 2;
      const rng = new Lcg(state);
      const value = rng.randint(Math.trunc(minimum), Math.trunc(maximum));
      const apply = (nid: string, next: number) => {
        if (game.actionLog?.doAction) {
          game.actionLog.doAction(new SetGameVarAction(game.gameVars, nid, next));
        } else {
          game.gameVars?.set?.(nid, next);
        }
      };
      apply('_other_random_seed', seed);
      apply('_other_random_state', rng.getState());
      return value;
    },
    get_random_choice(choices: Iterable<any>, explicitSeed?: number) {
      const values = Array.from(choices ?? []);
      if (values.length === 0) return null;
      if (explicitSeed !== undefined && explicitSeed !== null) {
        const seed = Number(game.gameVars?.get?.('_random_seed') ?? 0);
        const rng = new Lcg(Math.trunc(explicitSeed) * 1024 + seed);
        return values[rng.randint(0, values.length - 1)];
      }
      return values[gameProxy.get_random(0, values.length - 1)];
    },
    get_region(nid: string) {
      return wrapRegion(regions.find((candidate: any) => candidate.nid === nid));
    },
    get_region_under_pos(pos: [number, number] | null, regionType?: string) {
      if (!pos) return null;
      const region = regions.find((candidate: any) => {
        if (regionType && candidate.region_type !== regionType) return false;
        return wrapRegion(candidate)?.contains(pos) ?? false;
      });
      return wrapRegion(region);
    },
    check_dead(nid: string) {
      const u = game.units?.get(nid) ?? game.getUnit?.(nid);
      if (!u) return true;
      return u.isDead?.() ?? u.dead ?? false;
    },
    check_alive(nid: string) {
      return !gameProxy.check_dead(nid);
    },
  };

  gameProxy._current_level = gameProxy.level;
  const unwrapUnit = (candidate: any) =>
    candidate?._raw ?? game.units?.get(candidate?.nid) ?? candidate;
  const unwrapItem = (candidate: any) => candidate?._raw ?? candidate;
  const itemSystem = {
    available(candidate: any, candidateItem: any) {
      const rawUnit = unwrapUnit(candidate);
      const rawItem = unwrapItem(candidateItem);
      if (!rawUnit || !rawItem || !itemAvailabilityEvaluator) return false;
      return itemAvailabilityEvaluator(rawUnit, rawItem, game.db, game);
    },
    weapon_type(_unit: any, candidate: any) {
      return componentValue(unwrapItem(candidate), 'weapon_type');
    },
    damage(_unit: any, candidate: any) {
      return componentValue(unwrapItem(candidate), 'damage') ?? null;
    },
    is_weapon(_unit: any, candidate: any) {
      return !!unwrapItem(candidate)?.hasComponent?.('weapon');
    },
    is_spell(_unit: any, candidate: any) {
      const raw = unwrapItem(candidate);
      return !!raw?.hasComponent?.('spell') || !!raw?.hasComponent?.('magic');
    },
  };
  const itemFuncs = {
    num_stacks(candidate: any, skillNid: string) {
      const raw = unwrapUnit(candidate);
      return raw?.skills?.filter((skill: any) => skill.nid === skillNid).length ?? 0;
    },
    is_magic(_unit: any, candidate: any, distance = 0) {
      const raw = unwrapItem(candidate);
      return !!raw?.hasComponent?.('magic') ||
        (!!raw?.hasComponent?.('magic_at_range') && distance > 1);
    },
  };
  const skillSystem = {
    has_skill(candidate: any, skillNid: string) {
      const raw = unwrapUnit(candidate);
      return raw?.skills?.some((skill: any) => skill.nid === skillNid) ?? false;
    },
    check_ally(left: any, right: any) {
      const rawLeft = unwrapUnit(left);
      const rawRight = unwrapUnit(right);
      return !!rawLeft && !!rawRight &&
        (game.db?.areAllied?.(rawLeft.team, rawRight.team) ??
          rawLeft.team === rawRight.team);
    },
    check_enemy(left: any, right: any) {
      return !skillSystem.check_ally(left, right);
    },
  };
  const computeAdvantage = (
    attacker: any,
    defender: any,
    attackItem: any,
    defenseItem: any,
    advantage = true,
  ) => {
    const rawAttacker = unwrapUnit(attacker);
    const rawAttackItem = unwrapItem(attackItem);
    const rawDefenseItem = unwrapItem(defenseItem);
    if (!rawAttackItem || !rawDefenseItem) return null;
    const attackType = componentValue(rawAttackItem, 'weapon_triangle_override') ??
      componentValue(rawAttackItem, 'weapon_type');
    const defenseType = componentValue(rawDefenseItem, 'weapon_triangle_override') ??
      componentValue(rawDefenseItem, 'weapon_type');
    if (!attackType || !defenseType) return null;
    const weapon = game.db?.weapons?.find?.((candidate: any) => candidate.nid === attackType) ??
      game.db?.weapons?.get?.(attackType);
    const bonuses = advantage ? weapon?.advantage : weapon?.disadvantage;
    if (!Array.isArray(bonuses)) return null;
    const wexp = Number(rawAttacker?.wexp?.[attackType] ?? 0);
    let selected: any = null;
    let selectedRequirement = -1;
    for (const bonus of bonuses) {
      if (bonus.weapon_type !== 'All' && bonus.weapon_type !== defenseType) continue;
      const requirement = bonus.weapon_rank === 'All'
        ? -1
        : game.db?.weaponRanks?.find?.((rank: any) => rank.rank === bonus.weapon_rank)?.requirement ??
          game.db?.weaponRanks?.get?.(bonus.weapon_rank)?.requirement ?? Infinity;
      if (requirement === -1) {
        selected = bonus;
        break;
      }
      if (wexp >= requirement && requirement > selectedRequirement) {
        selected = bonus;
        selectedRequirement = requirement;
      }
    }
    return selected;
  };
  function wrapCatalog(catalog: any, wrapper: (value: any) => any) {
    const rawValues = catalog?.values
      ? Array.from(catalog.values())
      : Array.isArray(catalog) ? catalog : [];
    return {
      get(nid: string) {
        const raw = catalog?.get?.(nid) ??
          rawValues.find((candidate: any) => candidate?.nid === nid);
        return wrapper(raw);
      },
      values() {
        return rawValues.map(wrapper);
      },
      filter(predicate: (value: any, index: number) => boolean) {
        return rawValues.map(wrapper).filter(predicate);
      },
      map(mapper: (value: any, index: number) => any) {
        return rawValues.map(wrapper).map(mapper);
      },
      some(predicate: (value: any, index: number) => boolean) {
        return rawValues.map(wrapper).some(predicate);
      },
      every(predicate: (value: any, index: number) => boolean) {
        return rawValues.map(wrapper).every(predicate);
      },
      get length() {
        return rawValues.length;
      },
      *[Symbol.iterator]() {
        for (const value of rawValues) yield wrapper(value);
      },
    };
  }

  const databaseProxy = new Proxy(game.db ?? {}, {
    get(target, property: string | symbol) {
      if (property === 'skills') return wrapCatalog(target.skills, wrapSkill);
      if (property === 'items') return wrapCatalog(target.items, wrapItem);
      return target[property as keyof typeof target];
    },
  });
  return {
    game: gameProxy,
    wrapUnit,
    wrapItem,
    wrapSkill,
    DB: databaseProxy,
    utils: {
      clamp(value: number, minimum: number, maximum: number) {
        return Math.max(minimum, Math.min(maximum, value));
      },
      calculate_distance(left: [number, number] | null, right: [number, number] | null) {
        if (!left || !right) return 0;
        return Math.abs(left[0] - right[0]) + Math.abs(left[1] - right[1]);
      },
    },
    item_funcs: itemFuncs,
    item_system: itemSystem,
    skill_system: skillSystem,
    combat_calcs: {
      compute_advantage: computeAdvantage,
      ...(ctx.localArgs?.get('combat_calcs') as Record<string, unknown> ?? {}),
    },
    movement_funcs: {
      check_traversable(candidate: any, pos: [number, number] | null) {
        const raw = unwrapUnit(candidate);
        if (!raw || !pos || !game.board?.inBounds?.(pos[0], pos[1])) return false;
        let movementGroup = game.db?.classes?.get?.(raw.klass)?.movement_group ?? 'Foot';
        for (const skill of raw.skills ?? []) {
          const override = componentValue(skill, 'movement_type');
          if (typeof override === 'string' && override) movementGroup = override;
        }
        return game.board.getMovementCost(pos[0], pos[1], movementGroup, game.db) < 99;
      },
    },
    target_system: {
      get_adj_units(candidate: any) {
        const raw = candidate?._raw ?? game.units?.get(candidate?.nid) ?? candidate;
        if (!raw?.position || !game.board) return [];
        const [x, y] = raw.position;
        return [[x, y - 1], [x - 1, y], [x + 1, y], [x, y + 1]]
          .map(([adjX, adjY]) => game.board.getUnit(adjX, adjY))
          .filter(Boolean)
          .map(wrapUnit);
      },
    },
  };
}

/**
 * Attempt to evaluate a Python condition using JavaScript Function().
 * Translates common Python idioms to JS before eval.
 * Returns the evaluation result, or undefined if it fails.
 */
function evaluateWithJsFallback(
  condition: string,
  ctx: ConditionContext,
  warnOnFailure = true,
): any {
  const game = ctx.game;
  if (!game) return undefined;

  // Translate Python idioms to JavaScript
  let jsExpr = translateListComprehensions(condition);
  jsExpr = translateFloorDivision(translateGeneratorExpressions(jsExpr));

  // Python `len(x)` -> `x.length`
  jsExpr = jsExpr.replace(/\blen\s*\(/g, '__len__(');

  // Python `True`/`False` -> `true`/`false`
  jsExpr = jsExpr.replace(/\bTrue\b/g, 'true');
  jsExpr = jsExpr.replace(/\bFalse\b/g, 'false');
  jsExpr = jsExpr.replace(/\bNone\b/g, 'null');
  jsExpr = jsExpr.replace(/\bis\s+not\b/g, '!==');
  jsExpr = jsExpr.replace(/\bis\b/g, '===');
  // Python keyword arguments used by EotF query helpers.
  jsExpr = jsExpr.replace(
    /\bteam\s*=\s*(['"][^'"]+['"])/g,
    '{ team: $1 }',
  );
  jsExpr = jsExpr.replace(
    /\btag\s*=\s*(['"][^'"]+['"])/g,
    '{ tag: $1 }',
  );

  // Python `and`/`or`/`not` -> `&&`/`||`/`!`
  jsExpr = jsExpr.replace(/\band\b/g, '&&');
  jsExpr = jsExpr.replace(/\bor\b/g, '||');
  jsExpr = jsExpr.replace(/\bnot\b/g, '!');

  // Python membership inside translated comprehensions/generators. Direct
  // top-level membership is handled by evaluateCondition before this fallback.
  jsExpr = jsExpr.replace(
    /((?:'[^']*'|"[^"]*"|[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*))\s+(!\s*)?in\s+(\[[^\]]*\]|[A-Za-z_]\w*(?:(?:\.[A-Za-z_]\w*)|(?:\([^()]*\)))*)/g,
    (_whole, needle, negated, haystack) =>
      `${negated ? '!' : ''}(${haystack}).includes(${needle})`,
  );
  jsExpr = jsExpr.replace(
    /((?:'[^']*'|"[^"]*"|[\w.()[\]'"]+))\s+(!\s*)?in\s+\(([^()]*)\)/g,
    (_whole, needle, negated, values) =>
      `${negated ? '!' : ''}[${values}].includes(${needle})`,
  );
  jsExpr = translateConditionalExpressions(jsExpr);
  jsExpr = jsExpr.replace(
    /((?:'[^']*'|"[^"]*"))\.join\s*\((.+)\)$/,
    '($2).join($1)',
  );

  // Build scope
  const evalScope = buildEvalScope(ctx);
  const gameProxy = evalScope.game;

  // Build check_pair / check_default helpers
  const unit1 = ctx.unit1;
  const unit2 = ctx.unit2;
  const check_pair = (a: string, b: string) => {
    const u1 = unit1?.nid;
    const u2 = unit2?.nid;
    return (u1 === a && u2 === b) || (u1 === b && u2 === a);
  };
  const check_default = (targetNid: string, exceptions: string[]) => {
    if (!unit1 || !unit2) return false;
    if (unit1.nid === targetNid && unit2.team === 'player') {
      return !exceptions.includes(unit2.nid);
    }
    if (unit2.nid === targetNid && unit1.team === 'player') {
      return !exceptions.includes(unit1.nid);
    }
    return false;
  };

  // len() helper
  const __len__ = (x: any) => {
    if (Array.isArray(x)) return x.length;
    if (x && typeof x === 'object' && 'size' in x) return x.size;
    return 0;
  };
  const __any__ = (values: any) => Array.from(values ?? []).some(Boolean);
  const __all__ = (values: any) => Array.from(values ?? []).every(Boolean);

  // v() helper: level vars take priority over game vars
  const v = (varName: string, fallback?: any) => {
    if (ctx.levelVars?.has(varName)) return ctx.levelVars.get(varName);
    if (ctx.gameVars?.has(varName)) return ctx.gameVars.get(varName);
    return fallback ?? 0;
  };

  // cf proxy (just for cf.SETTINGS['debug'])
  const cf = { SETTINGS: { debug: false } };

  // Wrap unit/region from context
  const unit = evalScope.wrapUnit?.(unit1) ?? null;
  const target = evalScope.wrapUnit?.(unit2) ?? null;
  const region = ctx.region ? {
    nid: ctx.region.nid, position: ctx.region.position,
    size: ctx.region.size, region_type: ctx.region.region_type,
    sub_nid: ctx.region.sub_nid,
    contains(pos: [number, number] | null) {
      if (!pos || !ctx.region.position) return false;
      const [px, py] = pos;
      const [rx, ry] = ctx.region.position;
      const [rw, rh] = ctx.region.size ?? [1, 1];
      return px >= rx && px < rx + rw && py >= ry && py < ry + rh;
    },
  } : null;
  const position = ctx.position;
  const target_pos = ctx.localArgs?.get('target_pos') ?? target?.position ?? null;
  const item = evalScope.wrapItem?.(ctx.item) ?? ctx.item ?? null;
  const mode = ctx.localArgs?.get('mode') ?? null;
  const stat_changes = ctx.localArgs?.get('stat_changes') ?? null;
  const max = Math.max;
  const min = Math.min;
  const int = (value: any) => Math.trunc(Number(value));
  const set = (values: Iterable<any> | undefined) => new Set(values ?? []);
  const str = (value: any) => String(value);
  const range = (start: number, end?: number) => {
    const from = end === undefined ? 0 : start;
    const to = end === undefined ? start : end;
    return Array.from({ length: Math.max(0, to - from) }, (_, index) => from + index);
  };
  const get_stacks = (candidate: any, skillNid: string) => {
    const raw = typeof candidate === 'string'
      ? game.units?.get?.(candidate)
      : candidate?._raw ?? candidate;
    return raw?.skills?.filter((skill: any) => skill.nid === skillNid).length ?? 0;
  };
  const get_charge = (candidate: any, skillNid: string) => {
    const raw = typeof candidate === 'string'
      ? game.units?.get?.(candidate)
      : candidate?._raw ?? candidate;
    const skill = raw?.skills?.find?.((entry: any) => entry.nid === skillNid);
    return Number(skill?.data?.get?.('charge') ?? skill?.data?.charge ?? 0);
  };

  // Also inject support_rank_nid from localArgs
  const support_rank_nid = ctx.localArgs?.get('support_rank_nid') ?? null;
  const expressionLocals = new Map(ctx.localArgs ?? []);
  if (expressionLocals.has('skill')) {
    expressionLocals.set(
      'skill',
      evalScope.wrapSkill?.(expressionLocals.get('skill')) ??
        expressionLocals.get('skill'),
    );
  }
  if (expressionLocals.has('item2')) {
    expressionLocals.set(
      'item2',
      evalScope.wrapItem?.(expressionLocals.get('item2')) ??
        expressionLocals.get('item2'),
    );
  }
  const playback = expressionLocals.get('playback');
  if (Array.isArray(playback)) {
    expressionLocals.set('playback', playback.map((mark: any) => {
      if (!mark || typeof mark !== 'object') return mark;
      return {
        ...mark,
        attacker: evalScope.wrapUnit?.(mark.attacker) ?? mark.attacker,
        defender: evalScope.wrapUnit?.(mark.defender) ?? mark.defender,
        main_attacker: evalScope.wrapUnit?.(
          mark.main_attacker ?? mark.mainAttacker,
        ) ?? mark.main_attacker ?? mark.mainAttacker,
      };
    }));
  }
  const reservedLocals = new Set([
    'game', 'unit', 'unit1', 'unit2', 'target', 'region', 'position',
    'target_pos', 'item', 'mode', 'stat_changes', 'support_rank_nid',
  ]);
  const localDeclarations = [...(ctx.localArgs?.keys() ?? [])]
    .filter((name) => /^[A-Za-z_]\w*$/.test(name) && !reservedLocals.has(name))
    .map((name) => `var ${name} = _locals.get(${JSON.stringify(name)});`)
    .join('\n');

  // Inject query engine functions (u, v, get_item, has_item, is_dead, etc.)
  const _queryEngine = new GameQueryEngine();
  const _queryFuncs = _queryEngine.getFuncDict();

  try {
    // eslint-disable-next-line no-new-func
    const fn = new Function(
      'game', 'unit', 'unit1', 'unit2', 'target', 'region', 'position', 'target_pos', 'item',
      'check_pair', 'check_default', '__len__', '__any__', '__all__', 'v', 'cf',
      'support_rank_nid', 'mode', 'stat_changes', 'DB', 'RECORDS', 'utils', 'item_funcs',
      'item_system', 'skill_system', 'combat_calcs', 'movement_funcs', 'target_system',
      'max', 'min', 'int', 'set', 'str', 'range', 'get_stacks', 'get_charge', '_qf', '_locals',
      '_wrapUnit', '_wrapItem', '_wrapSkill',
      `"use strict";
       ${localDeclarations}
       // Spread query engine functions into local scope
       var _units = values => Array.from(values || []).map(_wrapUnit),
           u = (...args) => _wrapUnit(_qf.u(...args)),
           get_item = (...args) => _wrapItem(_qf.get_item(...args)),
           has_item = _qf.has_item,
           get_subitem = (...args) => _wrapItem(_qf.get_subitem(...args)),
           get_skill = (...args) => _wrapSkill(_qf.get_skill(...args)),
           has_skill = _qf.has_skill, get_klass = _qf.get_klass,
           get_class = _qf.get_class,
           get_closest_allies = (...args) => Array.from(_qf.get_closest_allies(...args) || [])
             .map(pair => [_wrapUnit(pair[0]), pair[1]]),
           get_units_within_distance = (...args) => _units(_qf.get_units_within_distance(...args)),
           get_allies_within_distance = (...args) => _units(_qf.get_allies_within_distance(...args)),
           get_units_in_area = (...args) => _units(_qf.get_units_in_area(...args)),
           get_debuff_count = _qf.get_debuff_count,
           get_units_in_region = (...args) => _units(_qf.get_units_in_region(...args)),
           any_unit_in_region = _qf.any_unit_in_region,
           is_dead = _qf.is_dead, check_alive = _qf.check_alive,
           get_internal_level = _qf.get_internal_level,
           get_support_rank = _qf.get_support_rank, get_terrain = _qf.get_terrain,
           has_achievement = _qf.has_achievement, check_shove = _qf.check_shove,
           get_money = _qf.get_money, get_bexp = _qf.get_bexp,
           is_roam = _qf.is_roam,
           get_roam_unit = (...args) => _wrapUnit(_qf.get_roam_unit(...args)),
           ai_group_active = _qf.ai_group_active,
           get_team_units = (...args) => _units(_qf.get_team_units(...args)),
           get_player_units = (...args) => _units(_qf.get_player_units(...args)),
           get_enemy_units = (...args) => _units(_qf.get_enemy_units(...args)),
           get_all_units = (...args) => _units(_qf.get_all_units(...args)),
           get_convoy_inventory = (...args) =>
             Array.from(_qf.get_convoy_inventory(...args) || []).map(_wrapItem);
       return (${jsExpr});`,
    );
    return fn(
      gameProxy, unit, unit, target, target, region, position, target_pos, item,
      check_pair, check_default, __len__, __any__, __all__, v, cf,
      support_rank_nid, mode, stat_changes, evalScope.DB, RECORDS, evalScope.utils,
      evalScope.item_funcs, evalScope.item_system, evalScope.skill_system, evalScope.combat_calcs,
      evalScope.movement_funcs, evalScope.target_system, max, min, int, set, str, range,
      get_stacks, get_charge,
      _queryFuncs, expressionLocals,
      evalScope.wrapUnit, evalScope.wrapItem, evalScope.wrapSkill,
    );
  } catch (e) {
    // Expression evaluation failed — log the error for debugging
    if (warnOnFailure) {
      console.warn(`EventCondition JS eval failed for "${condition}":`, e);
    }
    return undefined;
  }
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
  /** Dynamic talk pairs added via event commands: Set of "unitA|unitB" keys. */
  private talkPairs: Set<string>;
  /**
   * Talk options hidden via hide_talk/unhide_talk event commands: Set of
   * "unitA|unitB" keys. Mirrors Python's `game_state.talk_hidden`
   * (game_state.py:131) — hidden talks are suppressed from the map/menu
   * display but the underlying on_talk event is not removed.
   */
  private talkHidden: Set<string>;
  /**
   * Optional reference to the game's action log, used to record only_once
   * marking as a reversible action (mirrors Python's action.OnlyOnceEvent)
   * so turnwheel undo restores re-triggerability. May be unset in contexts
   * without an action log (e.g. harness/test setups) — callers fall back
   * to marking onceTriggered directly in that case.
   */
  actionLog: ActionLog | null = null;

  /**
   * Accessor for the live GameState, threaded into PYEV1 GameEvent instances
   * so python-syntax event scripts can reference `game`, `u(...)`, `v(...)`,
   * etc. Without this, PYEV1's PythonEventProcessor.buildEvalContext() has no
   * `game` reference and every game-touching expression silently evaluates
   * against a null game. Set once via setGameGetter() during game-state init.
   */
  private gameGetter: (() => any) | null = null;

  constructor(events: Map<NID, EventPrefab>) {
    this.allEvents = events;
    this.eventQueue = [];
    this.onceTriggered = new Set();
    this.talkPairs = new Set();
    this.talkHidden = new Set();
  }

  /** Register the GameState accessor used to build PYEV1 eval context (see `gameGetter` field doc). */
  setGameGetter(getter: () => any): void {
    this.gameGetter = getter;
  }

  /** Get the set of already-triggered only_once event NIDs (for save serialization). */
  getOnceTriggered(): Set<NID> {
    return this.onceTriggered;
  }

  /** Restore the set of already-triggered only_once event NIDs (for save loading). */
  restoreOnceTriggered(nids: NID[] | undefined): void {
    this.onceTriggered = new Set(nids ?? []);
  }

  /** Mark an event as triggered, routing through the action log when available. */
  private markOnceTriggered(eventNid: NID): void {
    if (this.actionLog) {
      try {
        this.actionLog.doAction(new OnlyOnceEventAction(eventNid, this.onceTriggered));
        return;
      } catch (err) {
        console.warn(`EventManager: failed to record OnlyOnceEventAction for "${eventNid}", falling back to direct mark:`, err);
      }
    }
    this.onceTriggered.add(eventNid);
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
        localArgs: new Map<string, any>([
          ...(context.localArgs?.entries() ?? []),
          ...(trigger.localArgs?.entries() ?? []),
          ['stat_changes', trigger.statChanges],
          ['source', trigger.source],
          ['weapon_type', trigger.weaponType],
          ['old_wexp', trigger.oldWexp],
          ['rank', trigger.rank],
          ['is_animation_combat', trigger.isAnimationCombat],
          ['playback', trigger.playback],
        ]),
      };

      // Evaluate the condition
      if (!evaluateCondition(prefab.condition, fullContext)) {
        continue;
      }

      // Mark as triggered if only_once
      if (prefab.only_once) {
        this.markOnceTriggered(prefab.nid);
      }

      // Create and enqueue the event
      const event = new GameEvent(prefab, trigger, this.gameGetter ?? undefined);
      if (!event.isDone()) {
        this.eventQueue.push(event);
        triggered = true;
        console.log(`EventManager: triggered "${prefab.nid}" (${prefab.trigger})`);
      }
    }

    return triggered;
  }

  /** Queue one event by NID, matching Python's trigger_specific_event. */
  triggerSpecific(
    eventNid: NID,
    trigger: EventTrigger,
    force: boolean = false,
  ): boolean {
    const prefab = this.allEvents.get(eventNid);
    if (!prefab) return false;
    if (!force && prefab.only_once && this.onceTriggered.has(prefab.nid)) return false;
    if (prefab.only_once) this.markOnceTriggered(prefab.nid);
    const event = new GameEvent(prefab, trigger, this.gameGetter ?? undefined);
    if (event.isDone()) return false;
    this.eventQueue.push(event);
    console.log(`EventManager: specifically triggered "${prefab.nid}"`);
    return true;
  }

  getPrefab(eventNid: NID): EventPrefab | undefined {
    return this.allEvents.get(eventNid);
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

  /** Add a dynamic talk pair (used by add_talk event command). */
  addTalkPair(unit1Nid: string, unit2Nid: string): void {
    this.talkPairs.add(`${unit1Nid}|${unit2Nid}`);
  }

  /** Remove a dynamic talk pair (used by remove_talk event command). */
  removeTalkPair(unit1Nid: string, unit2Nid: string): void {
    this.talkPairs.delete(`${unit1Nid}|${unit2Nid}`);
  }

  /** Check if a talk pair exists. */
  hasTalkPair(unit1Nid: string, unit2Nid: string): boolean {
    return this.talkPairs.has(`${unit1Nid}|${unit2Nid}`) ||
           this.talkPairs.has(`${unit2Nid}|${unit1Nid}`);
  }

  /** Hide a talk option from map/menu display (hide_talk event command). */
  hideTalk(unit1Nid: string, unit2Nid: string): void {
    this.talkHidden.add(`${unit1Nid}|${unit2Nid}`);
  }

  /** Unhide a previously-hidden talk option (unhide_talk event command). */
  unhideTalk(unit1Nid: string, unit2Nid: string): void {
    this.talkHidden.delete(`${unit1Nid}|${unit2Nid}`);
    this.talkHidden.delete(`${unit2Nid}|${unit1Nid}`);
  }

  /** Check if a talk option is hidden from map/menu display. */
  isTalkHidden(unit1Nid: string, unit2Nid: string): boolean {
    return this.talkHidden.has(`${unit1Nid}|${unit2Nid}`) ||
           this.talkHidden.has(`${unit2Nid}|${unit1Nid}`);
  }

  /** Get the set of hidden talk pair keys (for save serialization). */
  getTalkHidden(): string[] {
    return Array.from(this.talkHidden);
  }

  /** Restore the set of hidden talk pair keys (for save loading). */
  restoreTalkHidden(pairs: string[] | undefined): void {
    this.talkHidden = new Set(pairs ?? []);
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
