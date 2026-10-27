import type { NID, EventPrefab } from '../data/types';
import {
  isPyev1 as _isPyev1,
  PythonEventProcessor as _PythonEventProcessor,
  setPyevExpressionEvaluator,
} from './python-events';
import { GameQueryEngine } from '../engine/query-engine';
import { getInternalLevel } from '../engine/leveling';
import { createItemTree } from '../objects/item';
import type { ActionLog } from '../engine/action';
import {
  OnlyOnceEventAction,
  RemoveSkillAction,
  RegisterItemTreeAction,
  SetGameVarAction,
} from '../engine/action';
import { reportUnimplemented } from '../engine/strict-mode';
import { Lcg } from '../engine/static-random';
import { RECORDS, isFavorited, setFavorited } from '../engine/records';
import { itemIsMagic, pythonCombatCalcsModule } from '../combat/combat-calcs';
import { inventoryCapacityOffsets, isSkillActive, movementType, unitHasTag, unitTags } from '../combat/skill-system';
import { inventoryFull } from '../combat/item-system';
import { isForkEngine } from '../engine/engine-flavor';
import {
  BUILTINS,
  MATH_MODULE,
  NOT_FOUND,
  PyException,
  pyFunction,
  typeName,
  describePythonError,
  evaluatePythonRaw,
  isPythonError,
  makeTuple,
  markCounter,
  pyBool,
  pyRepr,
  pyStr,
  scopeFromRecord,
  toArray,
  toHostValue,
  type RootScope,
} from './py-expr';

type ItemAvailabilityEvaluator = (
  unit: any,
  item: any,
  db: any,
  game?: any,
) => boolean;
type ItemComponentEntriesEvaluator = (
  unit: any,
  item: any,
  db: any,
  game?: any,
) => [string, any][];

// `var` is intentional: item-system registers through this setter while an
// event-manager/python-events cycle is still being initialized in Node-side
// audit tests. A lexical binding would be in its TDZ at that point.
var itemAvailabilityEvaluator: ItemAvailabilityEvaluator | null | undefined;
var itemComponentEntriesEvaluator: ItemComponentEntriesEvaluator | null | undefined;
var skillConditionEvaluator: SkillConditionEvaluator | null | undefined;

type SkillConditionEvaluator = (skill: any, unit: any, item: any, game?: any) => boolean;

/** Register Python skill_system.condition (see skill-system.ts). */
export function setSkillConditionEvaluator(evaluator: SkillConditionEvaluator): void {
  skillConditionEvaluator = evaluator;
}

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

/** Register Python item_system.get_all_components for expression evaluation. */
export function setItemComponentEntriesEvaluator(
  evaluator: ItemComponentEntriesEvaluator,
): void {
  itemComponentEntriesEvaluator = evaluator;
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
  | 'load_unit' | 'make_generic' | 'create_unit' | 'unload_unit'
  | 'add_unit' | 'move_unit' | 'remove_unit' | 'kill_unit' | 'remove_all_units' | 'remove_all_enemies'
  | 'interact_unit' | 'resurrect' | 'set_position'
  | 'set_skill_data' | 'set_mode_rng' | 'set_mode_autolevels' | 'show_minimap'
  | 'records_screen' | 'open_library' | 'open_guide' | 'open_credits' | 'soundroom' | 'open_trade' | 'show_pokedex'
  | 'change_roaming' | 'change_roaming_unit' | 'clean_up_roaming' | 'trigger_script' | 'trigger_script_with_args'
  | 'recruit_generic' | 'merge_parties' | 'loop_units' | 'add_fatigue' | 'remove_generics_from_region' | 'add_unit_map_anim' | 'remove_unit_map_anim' | 'enable_repair_shop' | 'force_chapter_clean_up' | 'arrange_formation' | 'text_entry' | 'change_bg_tilemap' | 'change_team_palette' | 'set_custom_options' | 'pose_unit' | 'open_bexp_menu' | 'party_transfer' | 'open_unit_management' | 'change_roam_ai'
  | 'add_item_component' | 'modify_item_component' | 'remove_item_component'
  | 'add_skill_component' | 'modify_skill_component' | 'remove_skill_component'
  | 'set_game_board_bounds' | 'remove_game_board_bounds' | 'dump_vars' | 'delete_save'
  // Modify unit properties
  | 'set_name' | 'set_current_hp' | 'heal' | 'set_current_mana'
  | 'set_variant' | 'set_unit_field' | 'set_unit_note' | 'remove_unit_note'
  | 'change_global_level_cap' | 'change_unit_level_cap'
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
  'load_unit', 'make_generic', 'create_unit', 'unload_unit',
  'add_unit', 'move_unit', 'remove_unit', 'kill_unit', 'remove_all_units', 'remove_all_enemies',
  'interact_unit', 'resurrect', 'set_position',
  'set_skill_data', 'set_mode_rng', 'set_mode_autolevels', 'show_minimap',
  'records_screen', 'open_library', 'open_guide', 'open_credits', 'soundroom', 'open_trade', 'show_pokedex',
  'change_roaming', 'change_roaming_unit', 'clean_up_roaming', 'trigger_script', 'trigger_script_with_args',
  'recruit_generic', 'merge_parties', 'loop_units', 'add_fatigue', 'remove_generics_from_region', 'add_unit_map_anim', 'remove_unit_map_anim', 'enable_repair_shop', 'force_chapter_clean_up', 'arrange_formation', 'text_entry', 'change_bg_tilemap', 'change_team_palette', 'set_custom_options', 'pose_unit', 'open_bexp_menu', 'party_transfer', 'open_unit_management', 'change_roam_ai',
  'add_item_component', 'modify_item_component', 'remove_item_component',
  'add_skill_component', 'modify_skill_component', 'remove_skill_component',
  'set_game_board_bounds', 'remove_game_board_bounds', 'dump_vars', 'delete_save',
  // Modify unit properties
  'set_name', 'set_variant', 'set_current_hp', 'heal', 'set_current_mana',
  'set_unit_field', 'set_unit_note', 'remove_unit_note',
  'change_global_level_cap', 'change_unit_level_cap',
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

  /** Python Event.transition_state: each event toggles its own transition. */
  transitionState: 'open' | 'close' | null = null;

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

    // Python event_commands.get_command_arguments: split on ';' but ignore
    // semicolons nested inside {...} (e.g. `{c:e;Grigol;CloseEyes}` or
    // `{e:...}` expressions inside a speak text).
    const parts: string[] = [];
    let current = '';
    let depth = 0;
    for (const ch of trimmed) {
      if (ch === ';' && depth === 0) {
        parts.push(current);
        current = '';
        continue;
      }
      if (ch === '{') depth += 1;
      else if (ch === '}') depth -= 1;
      current += ch;
    }
    parts.push(current);
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
// Python expression evaluation
// ============================================================
//
// Every Python expression LT hands to eval() (event conditions, if/elif/for,
// {e:} text tags, game_var/level_var values, item/skill component
// expressions, AI and region conditions, #pyev1 expressions, and equations
// via combat-calcs) is evaluated by src/events/py-expr:
// a Python tokenizer, a parser with Python's precedence table, and a tree
// evaluator with Python semantics. This section builds the eval() globals —
// the equivalent of Python's evaluate.get_context — from the web engine's
// objects and wrappers.

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

/** Lazily-built, reused query-function dictionary. */
let queryFuncsCache: Record<string, Function> | null = null;
function sharedQueryFuncs(): Record<string, Function> {
  return (queryFuncsCache ??= new GameQueryEngine().getFuncDict());
}

/** Python's game_vars / level_vars are Counters: `vars['missing']` is 0. */
function counterVars(variables: Map<string, any> | undefined): Map<string, any> {
  const map = variables ?? new Map<string, any>();
  markCounter(map);
  return map;
}

/*
 * Stateless pieces of the expression scope (Python evaluate.get_context),
 * shared by every evaluation; buildEvalScope keeps only what depends on the
 * game, the context or a per-evaluation wrapper cache.
 */
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
  const wrapped: any = regions.map(wrapRegion);
  wrapped.get = (nid: string) =>
    wrapped.find((region: any) => region.nid === nid) ?? wrapRegion(null);
  wrapped.values = () => wrapped;
  return wrapped;
}

/**
 * A Python dict view of an engine mapping. Engine Maps are exposed as-is;
 * plain-object mappings become a Map so dict methods (get with a default,
 * keys/values/items, `in`, iteration over keys) behave like Python's.
 */
function wrapMapping(value: any): Map<any, any> {
  if (value instanceof Map) return value;
  return new Map(Object.entries(value ?? {}));
}

function wrapRecordValue(value: any): any {
  if (Array.isArray(value)) {
    return new Proxy(value, {
      get(target, property: string | symbol) {
        if (property === 'remove') {
          return (candidate: any) => {
            const index = target.indexOf(candidate);
            if (index >= 0) target.splice(index, 1);
            RECORDS?.persist();
            return target;
          };
        }
        const result = target[property as keyof typeof target];
        return typeof result === 'function' ? result.bind(target) : result;
      },
    });
  }
  if (value && typeof value === 'object') {
    return new Proxy(value, {
      get(target, property: string | symbol) {
        if (property === 'get') {
          return (key: string, fallback?: any) =>
            key in target ? wrapRecordValue(target[key]) : fallback;
        }
        if (property === 'update') {
          return (entries: Record<string, any>) => {
            Object.assign(target, entries);
            RECORDS?.persist();
            return target;
          };
        }
        if (property === 'map') {
          return (mapper: (key: string, index: number) => unknown) =>
            Object.keys(target).map(mapper);
        }
        if (property === 'filter') {
          return (predicate: (key: string, index: number) => boolean) =>
            Object.keys(target).filter(predicate);
        }
        if (property === 'some') {
          return (predicate: (key: string, index: number) => boolean) =>
            Object.keys(target).some(predicate);
        }
        if (property === 'every') {
          return (predicate: (key: string, index: number) => boolean) =>
            Object.keys(target).every(predicate);
        }
        if (property === 'includes') {
          return (key: string) => key in target;
        }
        if (property === 'length') return Object.keys(target).length;
        if (property === Symbol.iterator) {
          return function* iterateKeys() {
            yield* Object.keys(target);
          };
        }
        const result = target[property as keyof typeof target];
        return wrapRecordValue(result);
      },
    });
  }
  return value;
}

const recordsProxy = {
  get(nid: string, fallback?: any) {
    if (!RECORDS?.has(nid)) return fallback ?? null;
    return wrapRecordValue(RECORDS.get(nid));
  },
  has(nid: string) {
    return RECORDS?.has(nid) ?? false;
  },
};

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

/**
 * Python @property accessors on component classes, by component nid:
 * property name -> [key of the component's value dict, its __init__
 * default] (item_components/extra_components.py EffectiveDamage, whose
 * value starts from those defaults). Expressions read them on the
 * component, e.g. `item.effective_damage.tags`.
 */
const COMPONENT_PROPERTIES: Record<string, Record<string, [string, unknown]>> = {
  effective_damage: {
    tags: ['effective_tags', []],
    multiplier: ['effective_multiplier', 3],
    bonus_damage: ['effective_bonus_damage', 0],
    show_flash: ['show_effectiveness_flash', true],
  },
};

function wrapComponent(nid: string, value: any) {
  const aliases = COMPONENT_PROPERTIES[nid];
  return new Proxy({
    nid,
    value: value && typeof value === 'object' && !Array.isArray(value)
      ? wrapMapping(value)
      : value,
  }, {
    get(target, property: string | symbol) {
      if (property in target) return target[property as keyof typeof target];
      if (aliases && typeof property === 'string' && property in aliases) {
        const [key, init] = aliases[property];
        const fallback = Array.isArray(init) ? [...init] : init;
        if (value instanceof Map) return value.has(key) ? value.get(key) : fallback;
        return value && typeof value === 'object' && key in value ? value[key] : fallback;
      }
      if (value && typeof value === 'object' && typeof property === 'string') {
        return value[property];
      }
      return null;
    },
  });
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

function wrapWexpGain(value: unknown): object {
  const source = value && typeof value === 'object' ? value : {};
  return {
    get(nid: string, fallback?: unknown) {
      const entry = nid in source ? Reflect.get(source, nid) : fallback;
      return Array.isArray(entry)
        ? {
          usable: Boolean(entry[0]),
          wexp_gain: Number(entry[1] ?? 0),
          cap: Number(entry[2] ?? 0),
        }
        : entry;
    },
    map(mapper: (nid: string, index: number) => unknown) {
      return Object.keys(source).map(mapper);
    },
    filter(predicate: (nid: string, index: number) => boolean) {
      return Object.keys(source).filter(predicate);
    },
    some(predicate: (nid: string, index: number) => boolean) {
      return Object.keys(source).some(predicate);
    },
    every(predicate: (nid: string, index: number) => boolean) {
      return Object.keys(source).every(predicate);
    },
    *[Symbol.iterator]() {
      yield* Object.keys(source);
    },
  };
}

function isDeadOrDying(unit: any): boolean {
  return !!(unit?.isDead?.() ?? unit?.dead) || !!(unit?.isDying ?? unit?.is_dying);
}

/** What a PyUnitView needs from its evaluation scope (buildEvalScope). */
interface UnitViewScope {
  game: any;
  wrapUnit(candidate: any): any;
  wrapSkill(candidate: any): any;
  wrapItem(candidate: any): any;
  wrapMapping(value: any): Map<any, any>;
  unitCanUnlock(unit: any, region: any): boolean;
}

const VIEW_SCOPE = Symbol('scope');
const VIEW_MEMO = Symbol('memo');

/**
 * Python UnitObject for expressions. The plain fields are snapshots taken
 * when the unit is wrapped (once per evaluation scope); expensive fields and
 * the methods are materialized on first read and memoized for the life of
 * the view, so wrapping costs one small object instead of rebuilding every
 * accessor closure. Accessed through UNIT_VIEW_HANDLER (prefab fallback).
 */
class PyUnitView {
  _raw: any;
  nid: any;
  name: any;
  team: any;
  position: any;
  previous_position: any;
  klass: any;
  affinity: any;
  traveler: any;
  dead: boolean;
  _finished: boolean;
  is_dying: boolean;
  level: any;
  generic: boolean;
  current_hp: any;
  variant: any;
  desc: any;
  [VIEW_SCOPE]: UnitViewScope;
  [VIEW_MEMO]: Map<string, unknown> | null;

  constructor(u: any, scope: UnitViewScope) {
    this._raw = u;
    this.nid = u.nid;
    this.name = u.name;
    this.team = u.team;
    this.position = u.position;
    this.previous_position = u.previousPosition ?? u.previous_position ?? null;
    this.klass = u.klass;
    this.affinity = u.affinity ?? null;
    this.traveler = u.traveler ?? u.rescuing ?? null;
    // Python's plain `dead` attribute: a unit at 0 HP reads False until Die
    // (is_dying while its UnitDeath events run).
    this.dead = !!u.dead;
    this._finished = u._finished ?? false;
    this.is_dying = u.isDying ?? u.is_dying ?? false;
    this.level = u.level;
    this.generic = u.generic ?? false;
    this.current_hp = u.currentHp ?? u.current_hp;
    this.variant = u.variant ?? null;
    this.desc = u.desc ?? null;
    this[VIEW_SCOPE] = scope;
    this[VIEW_MEMO] = null;
  }

  private memo<T>(key: string, compute: () => T): T {
    let values = this[VIEW_MEMO];
    if (!values) values = this[VIEW_MEMO] = new Map();
    if (!values.has(key)) values.set(key, compute());
    return values.get(key) as T;
  }

  // Python UnitObject.tags: own tags | class tags | skill additional_tags.
  get tags() {
    const u = this._raw;
    return this.memo('tags', () => (Array.isArray(u.skills) ? [...unitTags(u, this[VIEW_SCOPE].game)] : (u.tags ?? [])));
  }
  // Python UnitObject._tags: the unit's own tags (tags adds class/skill tags).
  get _tags() { return [...(this._raw.tags ?? [])]; }
  get stat_cap_modifiers() {
    const u = this._raw;
    return this.memo('stat_cap_modifiers', () => this[VIEW_SCOPE].wrapMapping(u.statCapModifiers ?? u.stat_cap_modifiers));
  }
  get strike_partner() {
    const u = this._raw;
    return this[VIEW_SCOPE].wrapUnit(u.strikePartner ?? u.strike_partner ?? null);
  }
  get stats() { return this.memo('stats', () => this[VIEW_SCOPE].wrapMapping(this._raw.stats)); }
  get wexp() { return this.memo('wexp', () => this[VIEW_SCOPE].wrapMapping(this._raw.wexp)); }
  get growths() { return this.memo('growths', () => this[VIEW_SCOPE].wrapMapping(this._raw.growths)); }
  get skills() { return this.memo('skills', () => (this._raw.skills ?? []).map(this[VIEW_SCOPE].wrapSkill)); }
  get items() { return this.memo('items', () => (this._raw.items ?? []).map(this[VIEW_SCOPE].wrapItem)); }
  // UnitObject.accessories is a property in Python, so do not resolve
  // every item's skill overrides merely to wrap a unit. Besides wasting
  // work for expressions that never read accessories, eager resolution
  // can recursively rebuild the entire game.units expression scope.
  get accessories() {
    return (this._raw.items ?? []).filter((candidate: any) =>
      candidate.hasComponent?.('accessory') ||
      candidate.hasComponent?.('equippable_accessory')).map(this[VIEW_SCOPE].wrapItem);
  }
  // Max HP runs every stat skill's condition; most expressions never
  // read it, so resolve it (once) on first access.
  get max_hp() { return this.memo('max_hp', () => this._raw.maxHp ?? this._raw.max_hp); }
  // Python UnitObject attributes EOtF reads in event expressions
  // (e.g. `table;portrait;u('Ophie').portrait_nid;...;expression`).
  get portrait_nid() {
    const u = this._raw;
    return u.generic ? null : (u.portraitNid ?? u.portrait_nid ?? null);
  }
  get party() { return this._raw.party ?? null; }
  get ai() { return this._raw.ai ?? null; }
  get faction() { return this._raw.faction ?? null; }
  get persistent() { return !!this._raw.persistent; }
  get exp() { return this._raw.exp ?? 0; }
  get _has_attacked() { return !!(this._raw.hasAttacked ?? this._raw._has_attacked); }
  get _has_traded() { return !!(this._raw.hasTraded ?? this._raw._has_traded); }
  get _has_moved() { return !!(this._raw.hasMoved ?? this._raw._has_moved); }

  // Methods: plain closures (callable detached, like the engine's other
  // wrapper methods), created on first read.
  get get_hp() {
    const u = this._raw;
    return this.memo('get_hp', () => () => u.currentHp ?? u.current_hp ?? 0);
  }
  get get_max_hp() {
    const u = this._raw;
    return this.memo('get_max_hp', () => () => u.getMaxHp?.() ?? u.maxHp ?? u.max_hp ?? u.stats?.HP ?? 0);
  }
  get get_stat() {
    const u = this._raw;
    return this.memo('get_stat', () => (nid: string) =>
      u.getStat?.(nid) ?? u.getStatValue?.(nid) ?? u.stats?.[nid] ?? 0);
  }
  get get_internal_level() {
    const u = this._raw;
    const game = this[VIEW_SCOPE].game;
    return this.memo('get_internal_level', () => () => getInternalLevel(u, game.db));
  }
  get get_field() {
    const u = this._raw;
    return this.memo('get_field', () => (nid: string, fallback?: any) =>
      u.fields?.has?.(nid) ? u.fields.get(nid) : (fallback ?? null));
  }
  get get_mana() {
    const u = this._raw;
    return this.memo('get_mana', () => () => u.currentMana ?? u.current_mana ?? 0);
  }
  // Python get_skill: the most recently added skill matching nid or uid.
  get get_skill() {
    const u = this._raw;
    const scope = this[VIEW_SCOPE];
    return this.memo('get_skill', () => (nid: any) => {
      const skills = [...(u.skills ?? [])].reverse();
      return scope.wrapSkill(skills.find((skill: any) =>
        skill.nid === nid || String(skill.uid) === String(nid)) ?? null);
    });
  }
  get get_weapon() {
    const u = this._raw;
    const scope = this[VIEW_SCOPE];
    return this.memo('get_weapon', () => () => scope.wrapItem(u.getWeapon?.() ?? u.equippedWeapon ?? null));
  }
  get get_accessory() {
    const u = this._raw;
    const scope = this[VIEW_SCOPE];
    return this.memo('get_accessory', () => () => scope.wrapItem(u.getAccessory?.() ?? u.equippedAccessory ?? null));
  }
  get check_flanking() {
    const u = this._raw;
    const game = this[VIEW_SCOPE].game;
    return this.memo('check_flanking', () => (): boolean => {
      if (!u.position || !game.board) return false;
      const [x, y] = u.position;
      const up = game.board.getUnit(x, y - 1);
      const down = game.board.getUnit(x, y + 1);
      const left = game.board.getUnit(x - 1, y);
      const right = game.board.getUnit(x + 1, y);
      const enemy = (other: any) =>
        !!other && !(game.db?.areAllied?.(u.team, other.team) ?? u.team === other.team);
      return (enemy(up) && enemy(down)) || (enemy(left) && enemy(right));
    });
  }
  get can_unlock() {
    const u = this._raw;
    const scope = this[VIEW_SCOPE];
    return this.memo('can_unlock', () => (region: any) => scope.unitCanUnlock(u, region?._raw ?? region));
  }
}
// The expression runtime names host objects by constructor (typeName);
// unit views read as plain 'object', as the earlier object literals did.
Object.defineProperty(PyUnitView, 'name', { value: 'Object' });

/**
 * Python UnitObject.__getattr__ falls back to the unit prefab, so authored
 * expressions read arbitrary data fields. Mirror that for plain values:
 * snake_case -> camelCase runtime field, then the DB prefab.
 */
const UNIT_VIEW_HANDLER: ProxyHandler<PyUnitView> = {
  get(target, property: string | symbol) {
    if (typeof property !== 'string' || property in target) return (target as any)[property];
    const u = target._raw;
    const camel = property.replace(/_([a-z0-9])/g, (_m: string, c: string) => c.toUpperCase());
    for (const key of [camel, property]) {
      const value = u[key];
      if (value !== undefined && typeof value !== 'function') return value;
    }
    const prefab = target[VIEW_SCOPE].game.db?.units?.get?.(u.nid);
    const fromPrefab = prefab?.[property];
    return typeof fromPrefab === 'function' ? undefined : fromPrefab;
  },
};

/**
 * The typed trigger fields a Python trigger's to_args() carries (stat
 * changes, playback, ...), as event local args. Only the fields this
 * trigger sets: a trigger_specific_event passes its args in localArgs
 * (event_after_combat's playback), and an unset field must not shadow it.
 */
export function triggerFieldArgs(trigger: Partial<EventTrigger> | null | undefined): [string, unknown][] {
  if (!trigger) return [];
  const fields: [string, unknown][] = [
    ['stat_changes', trigger.statChanges],
    ['source', trigger.source],
    ['weapon_type', trigger.weaponType],
    ['old_wexp', trigger.oldWexp],
    ['rank', trigger.rank],
    ['is_animation_combat', trigger.isAnimationCombat],
    ['playback', trigger.playback],
  ];
  return fields.filter(([, value]) => value !== undefined);
}

function buildEvalScope(ctx: ConditionContext): Record<string, any> {
  const game = ctx.game;
  if (!game) return {};

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
      // Python ItemObject.tags reads the instance's own component bag
      // directly. Going through getComponent()/hasComponent() here would
      // re-enter skill item_override resolution while evaluating an
      // item_override condition such as Gift_of_Magic_Child.
      tags: item.components instanceof Map
        ? (item.components.get('item_tags') ?? item.tags ?? [])
        : (componentEntries(item).find(([nid]) => nid === 'item_tags')?.[1] ??
          item.tags ?? []),
      components,
      data: wrapMapping(item.data),
      // Python ItemObject.uses is the `uses` component (truthy when the item
      // has one, `.value` its maximum); remaining uses live in data['uses'].
      get uses() {
        return components.get('uses');
      },
      max_uses: item.maxUses,
      get owner_nid() {
        return item.owner?.nid ?? item.ownerNid ?? item.owner_nid ?? null;
      },
      get subitems() {
        return (item.subitems ?? []).map(wrapItem);
      },
      get parent_item() {
        return wrapItem(item.parentItem ?? item.parent_item ?? null);
      },
    };
    const wrapped = new Proxy(target as Record<string, any>, {
      get(proxyTarget, property: string | symbol) {
        if (property in proxyTarget) return proxyTarget[property as string];
        if (typeof property === 'string' && components.has(property)) {
          return components.get(property);
        }
        return item[property as keyof typeof item] ?? null;
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
    // Wrapping every component up front dominated frame time: skill
    // conditions are evaluated many times per frame, and most expressions
    // only read plain fields like `s.nid`. Materialize the component map on
    // first use instead, memoized for the life of this wrapper.
    let components: ReturnType<typeof wrapComponents> | null = null;
    const getComponents = () => (components ??= wrapComponents(skill));
    const target = {
      _raw: skill,
      uid: skill.uid,
      nid: skill.nid,
      name: skill.name,
      desc: skill.desc,
      owner_nid: skill.ownerNid ?? null,
      initiator_nid: skill.initiatorNid ?? null,
      data: wrapMapping(skill.data),
    };
    const wrapped = new Proxy(target as Record<string, any>, {
      get(proxyTarget, property: string | symbol) {
        if (property in proxyTarget) return proxyTarget[property as string];
        if (property === 'components') return getComponents();
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
        if (typeof property === 'string' && getComponents().has(property)) {
          return getComponents().get(property);
        }
        return skill[property as keyof typeof skill] ?? null;
      },
    });
    wrappedSkills.set(skill, wrapped);
    return wrapped;
  }

  const wrappedClasses = new WeakMap<object, object>();
  function wrapClass(klass: unknown): unknown {
    if (!klass || typeof klass !== 'object') return klass;
    const existing = wrappedClasses.get(klass);
    if (existing) return existing;
    const wrapped = new Proxy(klass, {
      get(target, property: string | symbol) {
        if (property === 'wexp_gain') {
          return wrapWexpGain(Reflect.get(target, property));
        }
        if ([
          'bases', 'growths', 'growth_bonus', 'promotion', 'max_stats', 'fields',
        ].includes(String(property))) {
          return wrapMapping(Reflect.get(target, property));
        }
        // Python Klass.get_skills: the learned skill NIDs.
        if (property === 'get_skills') {
          return () => ((Reflect.get(target, 'learned_skills') ?? []) as [number, string][])
            .map((entry) => entry[1]);
        }
        return Reflect.get(target, property);
      },
    });
    wrappedClasses.set(klass, wrapped);
    return wrapped;
  }


  /**
   * Python UnitObject.can_unlock -> unit_funcs.can_unlock: a skill or an
   * available item whose can_unlock component accepts the region.
   */
  function unitCanUnlock(unit: any, region: any): boolean {
    if (!unit) return false;
    if (typeof unit.canUnlock === 'function') return unit.canUnlock(region);
    const canUnlockByExpr = (expr: unknown, item: any): boolean => {
      if (typeof expr !== 'string') return !!expr;
      if (!region?.nid) return false;
      return evaluateConditionOr(expr, {
        ...ctx,
        unit1: unit,
        item,
        region,
        localArgs: new Map([...(ctx.localArgs ?? []), ['region', region]]),
      }, false);
    };
    return (unit.items ?? []).some((item: any) => {
      const comps = item.components;
      if (comps instanceof Map) {
        if (comps.has('can_unlock')) return canUnlockByExpr(comps.get('can_unlock'), item);
        return comps.has('unlock') || comps.has('lockpick') || comps.has('key') ||
          comps.has('keys') || comps.has('Key') || comps.has('Keys');
      }
      const entries = componentEntries(item);
      const canUnlock = entries.find(([nid]) => nid === 'can_unlock');
      if (canUnlock) return canUnlockByExpr(canUnlock[1], item);
      return entries.some(([nid]) => ['unlock', 'lockpick', 'key', 'keys', 'Key', 'Keys'].includes(nid));
    });
  }

  const wrappedUnits = new WeakMap<object, any>();
  // Python UnitObject as expressions see it: a PyUnitView (one small object
  // per unit per evaluation scope; the class is defined above buildEvalScope).
  const unitViewScope: UnitViewScope = {
    game,
    wrapUnit: (candidate: any) => wrapUnit(candidate),
    wrapSkill: (candidate: any) => wrapSkill(candidate),
    wrapItem: (candidate: any) => wrapItem(candidate),
    wrapMapping: (value: any) => wrapMapping(value),
    unitCanUnlock: (unit: any, region: any) => unitCanUnlock(unit, region),
  };
  function wrapUnit(u: any): any {
    if (!u) return null;
    if (typeof u !== 'object') return u;
    const existing = wrappedUnits.get(u);
    if (existing) return existing;
    const proxied = new Proxy(new PyUnitView(u, unitViewScope), UNIT_VIEW_HANDLER);
    wrappedUnits.set(u, proxied);
    return proxied;
  }

  function getAllUnits(onlyOnField: boolean = true): any[] {
    const units = Array.from(game.units?.values?.() ?? []) as any[];
    // Python game.get_all_units(): 'Tile' is usually a class tag (walls,
    // doors, snags, pylons), and UnitObject.tags includes class tags.
    return units
      .filter((unit) => !onlyOnField || (
        !!unit.position &&
        !isDeadOrDying(unit) &&
        !unitHasTag(unit, 'Tile', game)
      ))
      .map(wrapUnit);
  }

  function getTeamUnits(team: string, onlyOnField: boolean = true): any[] {
    return getAllUnits(onlyOnField).filter((unit) => unit.team === team);
  }

  function resolvePartyNid(party?: any): string {
    return String(party?._raw?.nid ?? party?.nid ?? party ?? game.currentParty ?? '');
  }

  function getParty(party?: any): any {
    const raw = game.getParty?.(resolvePartyNid(party));
    if (!raw) return null;
    return {
      _raw: raw,
      nid: raw.nid,
      name: raw.name,
      leader_nid: raw.leaderNid,
      money: raw.money,
      bexp: raw.bexp,
      get items() {
        return (raw.items ?? raw.convoy ?? []).map(wrapItem);
      },
      get party_prep_manage_sort_order() {
        return raw.partyPrepManageSortOrder ?? [];
      },
    };
  }

  function getAllUnitsInParty(party?: any): any[] {
    const partyNid = resolvePartyNid(party);
    return Array.from(game.units?.values?.() ?? [])
      .filter((unit: any) =>
        unit.team === 'player' &&
        !!unit.persistent &&
        unit.party === partyNid)
      .map(wrapUnit);
  }

  function getUnitsInParty(party?: any): any[] {
    const partyNid = resolvePartyNid(party);
    const order: string[] = game.parties?.get?.(partyNid)?.partyPrepManageSortOrder ?? [];
    const orderByNid = new Map<string, number>(
      order.map((nid: string, index: number) => [nid, index]),
    );
    return getAllUnitsInParty(partyNid)
      .filter((unit) => !isDeadOrDying(unit._raw))
      .map((unit, index) => ({
        unit,
        index,
        order: orderByNid.get(unit.nid) ?? Number.MAX_SAFE_INTEGER,
      }))
      .sort((left, right) => left.order - right.order || left.index - right.index)
      .map(({ unit }) => unit);
  }

  // The game proxy and the engine-module stand-ins below are large object
  // literals (hundreds of closures). Most expressions only touch the unit
  // wrappers, RECORDS and maybe `game`, so each group is built on first use
  // within this evaluation scope rather than for every evaluation.
  let gameProxyCache: any = null;
  let modulesCache: Record<string, any> | null = null;
  const getModules = (): Record<string, any> => (modulesCache ??= buildModules());
  const getGameProxy = (): any => (gameProxyCache ??= buildGameProxy());
  const buildGameProxy = (): any => {
  // Build the game proxy object
  const regions = game.currentLevel?.regions ?? [];
  let levelRegions: any = null;
  const level = {
    // Wrapped on first read (once per scope), not with every game proxy.
    get regions() { return (levelRegions ??= wrapRegions(regions)); },
    nid: game.currentLevel?.nid ?? '',
    objective: {
      ...(game.currentLevel?.objective ?? {}),
      get(key: string, fallback: unknown = null) {
        const objective = game.currentLevel?.objective ?? {};
        return Object.prototype.hasOwnProperty.call(objective, key)
          ? Reflect.get(objective, key)
          : fallback;
      },
    },
    get units() {
      return Array.from(game.units?.values?.() ?? []).map(wrapUnit);
    },
    name: game.currentLevel?.name ?? '',
  };
  // One literal with every member (no properties added afterwards): the
  // proxy keeps a fast object shape instead of turning into a dictionary.
  const gameProxy: any = {
    turncount: game.turnCount ?? game.turncount ?? 0,
    turn_count: game.turnCount ?? game.turncount ?? 0,
    get units() {
      return Array.from(game.units?.values?.() ?? []).map(wrapUnit);
    },
    get regions() {
      return regions.map(wrapRegion);
    },
    // Python game.game_vars / level_vars are Counters over the live state.
    game_vars: counterVars(game.gameVars),
    level_vars: counterVars(game.levelVars),
    board: {
      bounds: game.board?.bounds ?? [0, 0, 0, 0],
      get_unit(position: [number, number] | null) {
        return position
          ? wrapUnit(game.board?.getUnit?.(position[0], position[1]) ?? null)
          : null;
      },
    },
    boundary: {
      displaying_units: {
        discard(nid: string) {
          game.boundaryDisplayingUnits ??= new Set<string>();
          game.boundaryDisplayingUnits.delete(nid);
        },
        has(nid: string) {
          return game.boundaryDisplayingUnits?.has?.(nid) ?? false;
        },
      },
      reset_surf() {
        game.boundaryResetVersion = Number(game.boundaryResetVersion ?? 0) + 1;
      },
    },
    path_system: {
      get_valid_moves(candidate: any) {
        const raw = candidate?._raw ?? candidate;
        const position = raw?.position;
        if (!position) return [];
        const [x, y] = position;
        return [[x, y], [x, y - 1], [x - 1, y], [x + 1, y], [x, y + 1]];
      },
    },
    tilemap: {
      get_terrain(pos: [number, number] | null) {
        if (!pos) return null;
        return game.board?.getTerrain(pos[0], pos[1]) ??
          game.tilemap?.getTerrain?.(pos[0], pos[1]) ?? null;
      },
    },
    level,
    phase: {
      get_current() {
        return game.phase?.getCurrent?.() ?? game.phase?.get_current?.() ?? 'player';
      },
    },
    get_unit(nid: string) {
      const u = game.units?.get(nid) ?? game.getUnit?.(nid);
      return wrapUnit(u);
    },
    is_favorited(candidate: string | { nid?: string; _raw?: { nid?: string; fields?: Map<string, unknown> } }) {
      const rawCandidate = typeof candidate === 'string'
        ? game.units?.get(candidate) ?? game.getUnit?.(candidate)
        : candidate?._raw ?? candidate;
      const nid = rawCandidate?.nid ?? (typeof candidate === 'string' ? candidate : '');
      // Engine-fork API (EOtF sorts its run-start roster by it): favourites
      // are the persistent records the unit dex toggles.
      return isFavorited(String(nid));
    },
    set_favorited(candidate: string | { nid?: string; _raw?: { nid?: string } }, value: unknown) {
      const nid = typeof candidate === 'string' ? candidate : candidate?._raw?.nid ?? candidate?.nid ?? '';
      setFavorited(String(nid), !!value);
    },
    get_item(uid: number | string | unknown[]) {
      const requested = Array.isArray(uid) ? uid[0] : uid;
      const item = game.getItem?.(requested as number | string) ??
        Array.from(new Set(game.items?.values?.() ?? []))
          .find((candidate: any) =>
            candidate.uid === Number(requested) || candidate.nid === requested);
      return wrapItem(item);
    },
    item_registry: {
      get(uid: number | string) {
        return gameProxy.get_item(uid);
      },
      values() {
        return Array.from(new Set(game.items?.values?.() ?? [])).map(wrapItem);
      },
      [Symbol.iterator]() {
        return this.values()[Symbol.iterator]();
      },
    },
    register_item(candidate: any) {
      const item = candidate?._raw ?? candidate;
      if (!item || Array.from(game.items?.values?.() ?? []).includes(item)) return;
      const key = `item_${item.uid}_${item.nid}`;
      if (game.actionLog?.doAction) {
        game.actionLog.doAction(new RegisterItemTreeAction(game.items, item, key));
      } else {
        game.registerItem?.(item);
      }
    },
    get_enemy_units(onlyOnField: boolean = true) {
      return getAllUnits(onlyOnField).filter((unit) =>
        !(game.db?.areAllied?.('player', unit.team) ?? unit.team === 'player'));
    },
    get_enemy1_units(onlyOnField: boolean = true) {
      return getTeamUnits('enemy', onlyOnField);
    },
    get_enemy2_units(onlyOnField: boolean = true) {
      return getTeamUnits('enemy2', onlyOnField);
    },
    get_other_units(onlyOnField: boolean = true) {
      return getTeamUnits('other', onlyOnField);
    },
    get_team_units(team: string, onlyOnField: boolean = true) {
      return getTeamUnits(team, onlyOnField);
    },
    get_player_units(onlyOnField: boolean = true) {
      return getTeamUnits('player', onlyOnField);
    },
    get_ally_units(onlyOnField: boolean = true) {
      const team = ctx.unit1?.team ?? 'player';
      return getAllUnits(onlyOnField).filter((candidate) =>
        game.db?.areAllied?.(team, candidate.team) ?? team === candidate.team);
    },
    get_travelers() {
      return getAllUnits().flatMap((unit) => {
        const travelerNid = unit._raw?.traveler;
        const traveler = travelerNid
          ? game.units?.get?.(travelerNid) ?? game.getUnit?.(travelerNid)
          : null;
        return traveler ? [wrapUnit(traveler)] : [];
      });
    },
    get_player_units_and_travelers() {
      return [
        ...getTeamUnits('player'),
        ...gameProxy.get_travelers().filter((unit: any) => unit.team === 'player'),
      ];
    },
    get_party(partyNid?: string) {
      return getParty(partyNid);
    },
    get_convoy_inventory(party?: any) {
      return getParty(party)?.items ?? [];
    },
    get_units_in_party(party?: any) {
      return getUnitsInParty(party);
    },
    get_all_units_in_party(party?: any) {
      return getAllUnitsInParty(party);
    },
    get_all_units(onlyOnField: boolean = true) {
      return getAllUnits(onlyOnField);
    },
    get_tile_units() {
      // EOtF's engine: the on-map, living units that DO carry the Tile tag
      // (own, class or skill tags), the complement of get_all_units().
      return (Array.from(game.units?.values?.() ?? []) as any[])
        .filter((unit) =>
          !!unit.position && !isDeadOrDying(unit) && unitHasTag(unit, 'Tile', game))
        .map(wrapUnit);
    },
    get_money() { return game.getMoney?.() ?? 0; },
    get_data(nid: string) {
      return game.db?.rawData?.get?.(String(nid)) ?? null;
    },
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
    // Python get_all_formation_spots / get_open_formation_spots.
    get_all_formation_spots(): [number, number][] {
      const spots = new Map<string, [number, number]>();
      for (const region of regions) {
        if (String(region.region_type).toLowerCase() !== 'formation' || !region.position) continue;
        const [width, height] = region.size ?? [1, 1];
        for (let x = 0; x < width; x += 1) {
          for (let y = 0; y < height; y += 1) {
            const spot: [number, number] = [region.position[0] + x, region.position[1] + y];
            spots.set(spot.join(','), spot);
          }
        }
      }
      return [...spots.values()];
    },
    get_open_formation_spots() {
      const all: [number, number][] = [];
      for (const region of regions) {
        if (String(region.region_type).toLowerCase() !== 'formation' || !region.position) continue;
        const [width, height] = region.size ?? [1, 1];
        for (let x = 0; x < width; x += 1) {
          for (let y = 0; y < height; y += 1) all.push([region.position[0] + x, region.position[1] + y]);
        }
      }
      return [...new Map(all.map((spot) => [spot.join(','), spot] as const)).values()]
        .filter(([x, y]: [number, number]) => !game.board?.getUnit(x, y))
        .sort((a: [number, number], b: [number, number]) => a[0] - b[0] || a[1] - b[1]);
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
      return !!u && isDeadOrDying(u);
    },
    check_alive(nid: string) {
      const u = game.units?.get(nid) ?? game.getUnit?.(nid);
      return !!u && !isDeadOrDying(u);
    },
    _current_level: level,
    // Python Game.target_system is the same module evaluate.py exposes.
    get target_system() { return getModules().target_system; },
  };
  return gameProxy;
  };
  const buildModules = (): Record<string, any> => {
  const gameProxy = getGameProxy();
  const unwrapUnit = (candidate: any) => {
    if (typeof candidate === 'string') return game.units?.get(candidate) ?? null;
    return candidate?._raw ?? game.units?.get(candidate?.nid) ?? candidate;
  };
  const unwrapItem = (candidate: any) => candidate?._raw ?? candidate;
  /** Python movement_funcs.get_mcost with get_movement_group. */
  const movementCostFor = (raw: any, pos: [number, number]): number => {
    const group = movementType(raw, game.db?.classes?.get?.(raw.klass)?.movement_group ?? 'Foot', game);
    return game.board.getMovementCost(pos[0], pos[1], group, game.db);
  };
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
    weapon_rank(_unit: any, candidate: any) {
      const raw = unwrapItem(candidate);
      return componentValue(raw, 'weapon_rank') ??
        componentValue(raw, 'magic_weapon_rank') ?? null;
    },
    get_all_components(candidateUnit: any, candidateItem: any) {
      const rawUnit = unwrapUnit(candidateUnit);
      const rawItem = unwrapItem(candidateItem);
      // Python get_all_components(unit, None) returns only the skills'
      // item_override components, which never apply without an item here.
      if (!rawItem) return [];
      const entries = itemComponentEntriesEvaluator
        ? itemComponentEntriesEvaluator(rawUnit, rawItem, game.db, game)
        : componentEntries(rawItem);
      return entries.map(([nid, value]) => wrapComponent(nid, value));
    },
    is_weapon(_unit: any, candidate: any) {
      return !!unwrapItem(candidate)?.hasComponent?.('weapon');
    },
    is_spell(_unit: any, candidate: any) {
      const raw = unwrapItem(candidate);
      return !!raw?.hasComponent?.('spell') || !!raw?.hasComponent?.('magic');
    },
    is_accessory(_unit: any, candidate: any) {
      return !!unwrapItem(candidate)?.isAccessory?.();
    },
  };
  const itemFuncs = {
    create_item(_unit: any, itemNid: string) {
      const prefab = game.db?.items?.get?.(itemNid);
      if (!prefab) return null;
      return wrapItem(createItemTree(prefab, (nid) => game.db.items.get(nid)));
    },
    num_stacks(candidate: any, skillNid: string) {
      const raw = unwrapUnit(candidate);
      return raw?.skills?.filter((skill: any) => skill.nid === skillNid).length ?? 0;
    },
    is_magic(candidate: any, item: any, distance = 0) {
      return itemIsMagic(unwrapUnit(candidate), unwrapItem(item), distance, game.db);
    },
    /** Python item_funcs.get_num_items: num_items + skill num_items_offset. */
    get_num_items(candidate: any) {
      const raw = unwrapUnit(candidate);
      return Number(game.db.getConstant('num_items', 5)) + inventoryCapacityOffsets(raw, game).items;
    },
    get_num_accessories(candidate: any) {
      const raw = unwrapUnit(candidate);
      return Number(game.db.getConstant('num_accessories', 0)) + inventoryCapacityOffsets(raw, game).accessories;
    },
    inventory_full(candidate: any, item: any) {
      return inventoryFull(unwrapUnit(candidate), unwrapItem(item), game.db);
    },
    // EOtF's engine adds item_funcs.has_damage: whether the item itself has
    // a damage, damage_any, eval_damage or eval_damage_any component (a 0
    // value counts). Upstream lacks it, so the expression raises there.
    ...(isForkEngine() ? {
      has_damage(_unit: any, item: any) {
        const components = unwrapItem(item)?.components;
        return !!components?.has && ['damage', 'damage_any', 'eval_damage', 'eval_damage_any']
          .some((nid) => components.has(nid));
      },
    } : {}),
  };
  const skillSystem = {
    has_skill(candidate: any, skillNid: string) {
      const raw = unwrapUnit(candidate);
      return raw?.skills?.some((skill: any) => skill.nid === skillNid) ?? false;
    },
    check_ally(left: any, right: any) {
      const rawLeft = unwrapUnit(left);
      const rawRight = unwrapUnit(right);
      // EOtF reads unit.team without a None check, so a missing unit (e.g.
      // the absent main target of an area attack) makes the expression fail.
      if (isForkEngine() && (!rawLeft || !rawRight)) {
        throw new PyException('AttributeError', "'NoneType' object has no attribute 'team'");
      }
      return !!rawLeft && !!rawRight &&
        (game.db?.areAllied?.(rawLeft.team, rawRight.team) ??
          rawLeft.team === rawRight.team);
    },
    check_enemy(left: any, right: any) {
      return !skillSystem.check_ally(left, right);
    },
    hidden(candidate: any, owner?: any) {
      const raw = candidate?._raw ?? candidate;
      if (componentValue(raw, 'hidden') !== undefined) return true;
      if (!isForkEngine()) return false;
      // EOtF's engine: skill.hidden or skill.is_terrain or
      // (skill.hidden_if_inactive and not condition(skill, unit)).
      if (componentValue(raw, 'is_terrain') !== undefined) return true;
      if (componentValue(raw, 'hidden_if_inactive') === undefined) return false;
      const unit = unwrapUnit(owner) ?? (raw?.ownerNid ? game.units?.get?.(raw.ownerNid) : null);
      return !!unit && !isSkillActive(raw, unit, game);
    },
    empower_heal(candidate: any) {
      const raw = unwrapUnit(candidate);
      return (raw?.skills ?? []).reduce((total: number, entry: any) => {
        const value = Number(componentValue(entry, 'empower_heal') ?? 0);
        return total + (Number.isFinite(value) ? value : 0);
      }, 0);
    },
    has_canto(candidate: any) {
      const raw = unwrapUnit(candidate);
      return raw?.hasCanto ?? false;
    },
    /** Python skill_system.condition(skill, unit, item=None). */
    condition(candidateSkill: any, candidate: any, candidateItem?: any) {
      const rawSkill = candidateSkill?._raw ?? candidateSkill;
      const rawUnit = unwrapUnit(candidate);
      if (!rawSkill || !rawUnit) {
        throw new TypeError('skill_system.condition requires a skill and a unit');
      }
      if (!skillConditionEvaluator) return true;
      return skillConditionEvaluator(rawSkill, rawUnit, unwrapItem(candidateItem) ?? null, game);
    },
  };
  const unitFuncs = {
    /**
     * Python unit_funcs.usable_wtypes: the class's usable weapon types plus
     * wexp_usable_skill grants, minus wexp_unusable_skill bans.
     */
    usable_wtypes(candidate: any): string[] {
      const raw = unwrapUnit(candidate);
      if (!raw) return [];
      const klass = game.db?.classes?.get?.(raw.klass);
      const usable = new Set<string>(Object.entries(klass?.wexp_gain ?? {})
        .filter(([, entry]: [string, any]) => Array.isArray(entry) ? !!entry[0] : !!entry?.usable)
        .map(([nid]) => nid));
      const listOf = (value: unknown): string[] => Array.isArray(value)
        ? value.map(String)
        : typeof value === 'string' ? value.split(',').map((part) => part.trim()).filter(Boolean) : [];
      for (const skill of raw.skills ?? []) {
        for (const nid of listOf(skill.getComponent?.('wexp_usable_skill'))) usable.add(nid);
      }
      for (const skill of raw.skills ?? []) {
        for (const nid of listOf(skill.getComponent?.('wexp_unusable_skill'))) usable.delete(nid);
      }
      return [...usable];
    },
    /** Python unit_funcs.check_flanked: enemies on both opposite sides. */
    check_flanked(candidate: any) {
      const raw = unwrapUnit(candidate);
      if (!raw?.position || !game.board) return false;
      const [x, y] = raw.position;
      const at = (px: number, py: number) => game.board.getUnit(px, py);
      const up = at(x, y - 1);
      const down = at(x, y + 1);
      const left = at(x - 1, y);
      const right = at(x + 1, y);
      if (up && down && skillSystem.check_enemy(raw, up) && skillSystem.check_enemy(raw, down)) return true;
      return !!(left && right && skillSystem.check_enemy(raw, left) && skillSystem.check_enemy(raw, right));
    },
    check_focus(candidate: any, limit = 3) {
      const raw = unwrapUnit(candidate);
      if (!raw?.position) return 0;
      return Array.from(game.units?.values?.() ?? []).filter((other: any) =>
        other !== raw &&
        !!other.position &&
        skillSystem.check_ally(raw, other) &&
        Math.abs(raw.position[0] - other.position[0]) +
          Math.abs(raw.position[1] - other.position[1]) <= limit).length;
    },
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
      // Python Data.keys(); Data has no __contains__, so `in` iterates values.
      keys() {
        return rawValues.map((value: any) => value?.nid);
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
      if (property === 'classes') return wrapCatalog(target.classes, wrapClass);
      if (property === 'units') return wrapCatalog(target.units, wrapUnit);
      // Python DB.stats: StatPrefab objects keyed by nid.
      if (property === 'stats') return wrapCatalog(target.stats, (value: unknown) => value);
      if (property === 'levels') return wrapCatalog(
        target.levels,
        (value: unknown) => value,
      );
      // Python DB.weapon_ranks: WeaponRank objects keyed by rank nid.
      if (property === 'weapon_ranks') {
        const ranks: any[] = (target.weaponRanks ?? []).map((rank: any) => ({ ...rank, nid: rank.rank }));
        return {
          get: (nid: string) => ranks.find((rank) => rank.nid === nid),
          values: () => ranks,
          keys: () => ranks.map((rank) => rank.nid),
          [Symbol.iterator]: () => ranks[Symbol.iterator](),
        };
      }
      return target[property as keyof typeof target];
    },
  });
  const scope: Record<string, any> = {
    game: gameProxy,
    wrapUnit,
    wrapItem,
    wrapSkill,
    wrapClass,
    DB: databaseProxy,
    RECORDS: recordsProxy,
    utils: {
      // Python utils.clamp(i, bound_a, bound_b): the bounds may come in
      // either order (EOtF writes utils.clamp(0, 10, x)).
      clamp(value: number, boundA: number, boundB: number) {
        const high = Math.max(boundA, boundB);
        const low = Math.min(boundA, boundB);
        return Math.min(high, Math.max(low, value));
      },
      calculate_distance(left: [number, number] | null, right: [number, number] | null) {
        if (!left || !right) return 0;
        return Math.abs(left[0] - right[0]) + Math.abs(left[1] - right[1]);
      },
    },
    item_funcs: itemFuncs,
    item_system: itemSystem,
    skill_system: skillSystem,
    unit_funcs: unitFuncs,
    combat_calcs: pythonCombatCalcsModule(game),
    movement_funcs: {
      check_traversable(candidate: any, pos: [number, number] | null) {
        const raw = unwrapUnit(candidate);
        if (!raw || !pos || !game.board?.inBounds?.(pos[0], pos[1])) return false;
        return movementCostFor(raw, pos) < 99;
      },
      /** Python check_weakly_traversable: mcost <= 5 or within the unit's movement. */
      check_weakly_traversable(candidate: any, pos: [number, number] | null) {
        const raw = unwrapUnit(candidate);
        if (!raw || !pos || !game.board?.inBounds?.(pos[0], pos[1])) return false;
        const mcost = movementCostFor(raw, pos);
        return mcost <= 5 || mcost <= raw.getMovement();
      },
    },
    target_system: {
      get_adjacent_positions(pos: [number, number] | null) {
        if (!pos) return [];
        const [x, y] = pos;
        return [[x, y - 1], [x - 1, y], [x + 1, y], [x, y + 1]]
          .filter(([adjX, adjY]) => game.board?.inBounds?.(adjX, adjY) ?? true);
      },
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
    path_system: {
      get_valid_moves(candidate: any) {
        const raw = unwrapUnit(candidate);
        const position = raw?.position;
        if (!position) return [];
        const [x, y] = position;
        return [[x, y], [x, y - 1], [x - 1, y], [x + 1, y], [x, y + 1]];
      },
    },
  };
  return scope;
  };
  return new EvalScope(wrapUnit, wrapItem, wrapSkill, wrapClass, getGameProxy, getModules);
}

/**
 * buildEvalScope's result: the per-evaluation wrappers, RECORDS, and the
 * game proxy / engine modules, which are built on first read.
 */
class EvalScope {
  readonly wrapUnit: (candidate: any) => any;
  readonly wrapItem: (candidate: any) => any;
  readonly wrapSkill: (candidate: any) => any;
  readonly wrapClass: (candidate: any) => any;
  readonly RECORDS = recordsProxy;
  private readonly getGame: () => any;
  private readonly getModules: () => Record<string, any>;
  [name: string]: any;

  constructor(
    wrapUnit: (candidate: any) => any,
    wrapItem: (candidate: any) => any,
    wrapSkill: (candidate: any) => any,
    wrapClass: (candidate: any) => any,
    getGame: () => any,
    getModules: () => Record<string, any>,
  ) {
    this.wrapUnit = wrapUnit;
    this.wrapItem = wrapItem;
    this.wrapSkill = wrapSkill;
    this.wrapClass = wrapClass;
    this.getGame = getGame;
    this.getModules = getModules;
  }

  get game() { return this.getGame(); }
  get DB() { return this.getModules().DB; }
  get utils() { return this.getModules().utils; }
  get item_funcs() { return this.getModules().item_funcs; }
  get item_system() { return this.getModules().item_system; }
  get skill_system() { return this.getModules().skill_system; }
  get unit_funcs() { return this.getModules().unit_funcs; }
  get combat_calcs() { return this.getModules().combat_calcs; }
  get movement_funcs() { return this.getModules().movement_funcs; }
  get target_system() { return this.getModules().target_system; }
  get path_system() { return this.getModules().path_system; }
}

/** Names whose value comes from the context even when a local shadows them. */
const CONTEXT_NAMES = new Set([
  'game', 'unit', 'unit1', 'unit2', 'target', 'region', 'position',
  'target_pos', 'item', 'mode', 'stat_changes', 'support_rank_nid',
]);

function regionWrapper(region: any): any {
  if (!region) return null;
  return {
    nid: region.nid,
    position: region.position,
    size: region.size,
    region_type: region.region_type,
    sub_nid: region.sub_nid,
    condition: region.condition,
    contains(pos: [number, number] | null) {
      if (!pos || !region.position) return false;
      const [px, py] = pos;
      const [rx, ry] = region.position;
      const [rw, rh] = region.size ?? [1, 1];
      return px >= rx && px < rx + rw && py >= ry && py < ry + rh;
    },
  };
}

/**
 * Python's evaluate.get_context for one evaluation: the context names,
 * the query-engine functions, the engine modules evaluate.py imports, and
 * the trigger's local args. Names are resolved on first use and memoized,
 * so an expression only pays for the wrappers it reads. One object per
 * evaluation (the helpers are methods, not per-evaluation closures).
 */
class PythonGlobals implements RootScope {
  private readonly ctx: ConditionContext;
  private readonly game: any;
  private scope: Record<string, any> | null = null;
  private resolved: Map<string, any> | null = null;

  constructor(ctx: ConditionContext) {
    this.ctx = ctx;
    this.game = ctx.game;
  }

  lookup(name: string): any {
    const resolved = (this.resolved ??= new Map<string, any>());
    if (resolved.has(name)) return resolved.get(name);
    const value = this.resolve(name);
    resolved.set(name, value);
    return value;
  }

  private evalScope(): Record<string, any> {
    return (this.scope ??= buildEvalScope(this.ctx));
  }

  private wrapUnit(value: any): any {
    if (!this.game) return value ?? null;
    return this.evalScope().wrapUnit(value?._raw ?? value) ?? null;
  }

  private wrapItem(value: any): any {
    return this.game ? this.evalScope().wrapItem(value?._raw ?? value) : value ?? null;
  }

  private wrapSkill(value: any): any {
    return this.game ? this.evalScope().wrapSkill(value?._raw ?? value) : value ?? null;
  }

  private wrapClass(value: any): any {
    return this.game ? this.evalScope().wrapClass(value) : value ?? null;
  }

  private units(values: any): any[] {
    return Array.from(values ?? []).map((entry: any) => this.wrapUnit(entry));
  }

  private closest(values: any): any[] {
    return Array.from(values ?? [])
      .map((pair: any) => makeTuple([this.wrapUnit(pair[0]), pair[1]]));
  }

  private wrapLocal(value: any): any {
    const game = this.game;
    if (!game || !value || typeof value !== 'object' || value._raw) return value;
    if (Array.isArray(value)) return value.map((entry: any) => this.wrapLocal(entry));
    if (value.components instanceof Map && value.data instanceof Map) {
      if ('uses' in value && 'subitems' in value) return this.wrapItem(value);
      if ('uid' in value && 'ownerNid' in value) return this.wrapSkill(value);
    }
    if ('team' in value && 'items' in value && 'stats' in value) return this.wrapUnit(value);
    return value;
  }

  private localValue(name: string, value: any): any {
    if (name === 'skill') return this.wrapSkill(value);
    if (name === 'item2') return this.wrapItem(value);
    if (name === 'playback' && Array.isArray(value)) {
      return value.map((mark: any) => {
        if (!mark || typeof mark !== 'object') return mark;
        // Python playback brushes are dataclass instances (p.nid,
        // p.attacker, ...), not dicts: `_raw` makes the evaluator read
        // attributes instead of treating the mark as a dict.
        return {
          _raw: mark,
          ...mark,
          ...('item' in mark ? { item: this.wrapItem(mark.item) ?? mark.item } : {}),
          attacker: this.wrapUnit(mark.attacker) ?? mark.attacker,
          defender: this.wrapUnit(mark.defender) ?? mark.defender,
          main_attacker: this.wrapUnit(mark.main_attacker ?? mark.mainAttacker) ??
            mark.main_attacker ?? mark.mainAttacker,
        };
      });
    }
    return this.wrapLocal(value);
  }

  private queryFunction(name: string): any {
    const qf = sharedQueryFuncs();
    switch (name) {
      case 'u': return (...args: any[]) => this.wrapUnit(qf.u(...args));
      case 'get_item': return (...args: any[]) => this.wrapItem(qf.get_item(...args));
      case 'find_item': return (...args: any[]) => this.wrapItem(qf.find_item(...args));
      case 'get_subitem': return (...args: any[]) => this.wrapItem(qf.get_subitem(...args));
      case 'get_skill': return (...args: any[]) => this.wrapSkill(qf.get_skill(...args));
      case 'get_klass': return (...args: any[]) => this.wrapClass(qf.get_klass(...args));
      case 'get_class': return (...args: any[]) => this.wrapClass(qf.get_class(...args));
      case 'get_roam_unit': return (...args: any[]) => this.wrapUnit(qf.get_roam_unit(...args));
      case 'get_closest_allies':
      case 'get_closest_units':
      case 'get_closest_enemies':
        return (...args: any[]) => this.closest(qf[name](...args));
      case 'get_units_within_distance':
      case 'get_allies_within_distance':
      case 'get_units_in_area':
      case 'get_units_in_region':
      case 'get_team_units':
      case 'get_player_units':
      case 'get_enemy_units':
      case 'get_all_units':
        return (...args: any[]) => this.units(qf[name](...args));
      case 'get_convoy_inventory':
        return (...args: any[]) => Array.from(qf.get_convoy_inventory(...args) || []).map((entry: any) => this.wrapItem(entry));
      case 'has_item': case 'has_skill': case 'get_debuff_count': case 'get_total_charge':
      case 'check_pivot': case 'any_unit_in_region': case 'is_dead': case 'check_alive':
      case 'get_internal_level': case 'get_support_rank': case 'get_terrain':
      case 'has_achievement': case 'check_shove': case 'get_money': case 'get_bexp':
      case 'is_roam': case 'ai_group_active':
        return qf[name];
    }
    return NOT_FOUND;
  }

  private resolve(name: string): any {
    const ctx = this.ctx;
    const game = this.game;
    if (!CONTEXT_NAMES.has(name) && ctx.localArgs?.has(name)) {
      return this.localValue(name, ctx.localArgs.get(name));
    }
    switch (name) {
      case 'game': return game ? this.evalScope().game : NOT_FOUND;
      case 'unit':
      case 'unit1':
        return this.wrapUnit(ctx.localArgs?.has('unit') ? ctx.localArgs.get('unit') : ctx.unit1);
      case 'unit2':
      case 'target':
        return this.wrapUnit(ctx.unit2);
      case 'region': return regionWrapper(ctx.region);
      case 'position': return ctx.position ?? null;
      case 'target_pos':
        return ctx.localArgs?.get('target_pos') ?? this.wrapUnit(ctx.unit2)?.position ?? null;
      case 'item': return this.wrapItem(ctx.item) ?? ctx.item ?? null;
      case 'mode': return ctx.localArgs?.get('mode') ?? null;
      case 'stat_changes': return ctx.localArgs?.get('stat_changes') ?? null;
      case 'support_rank_nid': return ctx.localArgs?.get('support_rank_nid') ?? null;
      case 'check_pair':
        // Python evaluate.check_pair
        return (s1: string, s2: string) => {
          const u1 = ctx.unit1;
          const u2 = ctx.unit2;
          if (!u1 || !u2) return false;
          return (u1.nid === s1 && u2.nid === s2) || (u1.nid === s2 && u2.nid === s1);
        };
      case 'check_default':
        // Python evaluate.check_default
        return (s1: string, t1: any = []) => {
          const u1 = ctx.unit1;
          const u2 = ctx.unit2;
          if (!u1 || !u2) return false;
          const exceptions = Array.from(t1 ?? []);
          if (u1.nid === s1 && u2.team === 'player') return !exceptions.includes(u2.nid);
          if (u2.nid === s1 && u1.team === 'player') return !exceptions.includes(u1.nid);
          return false;
        };
      case 'v':
        // Python QueryEngine.v: a level var holding None falls through to
        // game_vars.get(name, fallback).
        return (varName: string, fallback: any = null) => {
          const levelValue = ctx.levelVars?.get(varName);
          if (levelValue !== undefined && levelValue !== null) return levelValue;
          if (ctx.gameVars?.has(varName)) return ctx.gameVars.get(varName);
          return fallback ?? null;
        };
      case 'cf': return { SETTINGS: { debug: false } };
      case 'math': return MATH_MODULE;
      // RECORDS needs no per-evaluation scope (the same recordsProxy).
      case 'RECORDS': return game ? recordsProxy : NOT_FOUND;
      case 'DB': case 'utils': case 'item_funcs': case 'item_system':
      case 'skill_system': case 'unit_funcs': case 'combat_calcs': case 'movement_funcs':
      case 'target_system':
        return game ? this.evalScope()[name] : NOT_FOUND;
      case 'static_random':
        return game ? { get_random_choice: this.evalScope().game.get_random_choice } : NOT_FOUND;
      case 'get_stacks':
        return (candidate: any, skillNid: string) => {
          const raw = typeof candidate === 'string'
            ? game?.units?.get?.(candidate)
            : candidate?._raw ?? candidate;
          return raw?.skills?.filter((skill: any) => skill.nid === skillNid).length ?? 0;
        };
      case 'get_charge':
        // EOtF fork get_charge: the last instance with a truthy charge.
        return (candidate: any, skillNid: string) => sharedQueryFuncs().get_charge(candidate, skillNid);
      case 'evaluate':
        // Python evaluate.evaluate(string, unit1=None, unit2=None,
        // position=None, local_args=None): a fresh context from exactly these
        // arguments; an exception propagates into the calling expression.
        return pyFunction('evaluate', (args, kwargs) => {
          const arg = (index: number, name: string) =>
            index < args.length ? args[index] : kwargs && name in kwargs ? kwargs[name] : null;
          const expression = arg(0, 'string');
          if (typeof expression !== 'string') {
            throw new PyException('AttributeError', `'${typeName(expression)}' object has no attribute 'strip'`);
          }
          const localArgsValue = arg(4, 'local_args');
          const localArgs = new Map<string, any>();
          if (localArgsValue instanceof Map) for (const [key, value] of localArgsValue) localArgs.set(key, value);
          else if (localArgsValue && typeof localArgsValue === 'object' && !Array.isArray(localArgsValue)) {
            for (const [key, value] of Object.entries(localArgsValue)) localArgs.set(key, value);
          }
          const candidate = arg(1, 'unit1');
          const candidateTarget = arg(2, 'unit2');
          const position = arg(3, 'position');
          const outcome = evaluatePythonInContext(expression, {
            game,
            unit1: candidate?._raw ?? candidate ?? undefined,
            unit2: candidateTarget?._raw ?? candidateTarget ?? undefined,
            position: position ?? undefined,
            gameVars: ctx.gameVars,
            levelVars: ctx.levelVars,
            localArgs,
          });
          if (!outcome.ok) throw outcome.error;
          return outcome.value;
        });
      case 'action':
        return {
          RemoveSkill(candidate: any, skillNid: string, source?: any, sourceType?: string) {
            const rawUnit = candidate?._raw ?? candidate;
            const skill = rawUnit?.skills?.find?.((entry: any) => {
              if (entry.nid !== skillNid) return false;
              if (source !== undefined && source !== null &&
                  entry.data?.get?.('sourceNid') !== source) return false;
              if (sourceType && entry.data?.get?.('sourceType') !== sourceType) return false;
              return true;
            });
            return rawUnit && skill ? new RemoveSkillAction(rawUnit, skill) : null;
          },
          do(candidate: RemoveSkillAction | null) {
            if (candidate) game?.actionLog?.doAction?.(candidate);
            return null;
          },
        };
      case 'SourceType': return { TRAVELER: 'traveler' };
    }
    return game ? this.queryFunction(name) : NOT_FOUND;
  }
}

function buildPythonGlobals(ctx: ConditionContext): RootScope {
  return new PythonGlobals(ctx);
}

type PythonOutcome = { ok: true; value: any } | { ok: false; error: unknown };

/**
 * Evaluate one Python expression the way Python's evaluate.evaluate does,
 * reporting success or the raised exception. The value is the raw Python
 * value (integral floats are PyFloat boxes; see py-expr/values.ts).
 */
export function evaluatePythonInContext(expression: string, ctx: ConditionContext): PythonOutcome {
  try {
    return { ok: true, value: evaluatePythonRaw(expression, buildPythonGlobals(ctx)) };
  } catch (error) {
    return { ok: false, error };
  }
}

/** How often each Python-equivalent evaluation warning has been raised. */
const repeatedWarnings = new Map<string, number>();

/**
 * console.warn a message the first time, then only at the 10th, 100th,
 * 1000th... repeat (with the count). Python logs each one, but a condition
 * that raises inside a stat lookup or the AI fails hundreds of times a turn,
 * and a browser console.warn (it records a stack trace) costs far more than
 * Python's logging call. Logging only: the evaluation result is unchanged.
 */
function warnRepeatable(message: string): void {
  const count = (repeatedWarnings.get(message) ?? 0) + 1;
  if (repeatedWarnings.size > 10_000) repeatedWarnings.clear();
  repeatedWarnings.set(message, count);
  if (count === 1) console.warn(message);
  else if (Number.isInteger(Math.log10(count))) console.warn(`${message} (x${count})`);
}

/**
 * Log a failed evaluation the way the Python engine's except-clauses log
 * (logging.error / print). Tests key off the `EventCondition JS eval failed`
 * marker, so it is kept even though no JavaScript is generated any more.
 * Under ?strict=true this throws via reportUnimplemented.
 */
function reportEvaluationFailure(
  expression: string,
  error: unknown,
  where: string,
  warn: boolean,
): void {
  // Exceptions CPython raises for the same expression and values (TypeError
  // on None, AttributeError on a missing unit, authored SyntaxErrors, ...)
  // are what Python's except-clauses log: not a gap in the port. A missing
  // name, or a missing attribute on an engine wrapper or module, may be
  // unported support instead.
  const pyError = error as { pyType?: string; hostAttribute?: boolean };
  if (isPythonError(error) && pyError.pyType !== 'NameError' && !pyError.hostAttribute) {
    if (warn) {
      warnRepeatable(`Python evaluation error (Python-equivalent) in "${expression}": ${describePythonError(error)}`);
    }
    return;
  }
  // A missing name/engine attribute or a JavaScript error from engine code
  // may be unported support: keep the marker tests watch for and report it
  // (throws under ?strict=true).
  if (warn) {
    console.warn(`EventCondition JS eval failed for "${expression}": ${describePythonError(error)}`);
  }
  reportUnimplemented('expression', expression, where);
}

/** A condition with an anyLivingClass shape (see evaluateCondition). */
const ANY_LIVING_CLASS = /^any\(\[\s*\w+\.position\s+for\s+(\w+)\s+in\s+game\.units\s+if\s+\1\.klass\s*==\s*['"]([^'"\\]+)['"]\s+and\s+not\s+is_dead\(\1\.nid\)\s*\]\)$/;

/**
 * Evaluate a condition (Python `bool(eval(condition))`).
 *
 * An empty condition is True (callers use '' for "no condition"). A
 * condition that raises is False, matching Python's except-clauses at the
 * event, if/elif and component sites; sites with a different except
 * behaviour use evaluatePythonInContext directly.
 */
export function evaluateCondition(
  condition: string,
  context: ConditionContext,
): boolean {
  const trimmed = condition.trim();
  if (trimmed === '' || trimmed === 'True' || trimmed === '1') return true;
  if (trimmed === 'False' || trimmed === '0') return false;

  // Hot path, semantically identical to the generic evaluation: EOtF's Gift
  // of Magic evaluates this item_override condition while drawing every
  // affected weapon, and wrapping all of game.units each time dominated the
  // renderer.
  const anyLivingClass = ANY_LIVING_CLASS.exec(trimmed);
  if (anyLivingClass && context.game) {
    const klass = anyLivingClass[2];
    for (const unit of context.game.units?.values?.() ?? []) {
      if ((unit as any).klass !== klass) continue;
      if ((unit as any).isDead?.() ?? (unit as any).dead ?? false) continue;
      if ((unit as any).position) return true;
    }
    return false;
  }

  const outcome = evaluatePythonInContext(trimmed, context);
  if (outcome.ok) return pyBool(outcome.value);
  reportEvaluationFailure(trimmed, outcome.error, 'event condition', true);
  return false;
}

/** A host-value evaluation outcome; failures have already been logged. */
export type ExpressionOutcome = { ok: true; value: any } | { ok: false; error: unknown };

/**
 * Evaluate an expression to a plain JS value (Python None is `null`),
 * reporting whether it raised. A raise is logged the way Python's
 * except-clauses log it; the caller decides what its except-clause does
 * (skip the write, fall back, use '' ...).
 */
export function evaluateExpressionOutcome(expression: string, context: ConditionContext): ExpressionOutcome {
  const outcome = evaluatePythonInContext(expression, context);
  if (outcome.ok) return { ok: true, value: toHostValue(outcome.value) ?? null };
  reportEvaluationFailure(expression.trim(), outcome.error, 'event expression', true);
  return outcome;
}

/**
 * Evaluate an expression to a plain JS value (Python None is `null`). Like
 * Python's eval it raises when the expression raises (after logging), so a
 * failure can never pass for a None result; catch it where Python catches.
 */
export function evaluateExpression(expression: string, context: ConditionContext): any {
  const outcome = evaluateExpressionOutcome(expression, context);
  if (outcome.ok) return outcome.value;
  throw outcome.error;
}

/**
 * `int(evaluate(expression))` inside the call site's try-block: Python int()
 * semantics (floats truncate toward zero; None, non-numeric strings and
 * other objects raise) and `fallback` when evaluation or conversion raises.
 */
export function evaluateInt(expression: string, context: ConditionContext, fallback = 0): number {
  return convertEvaluated(expression, context, BUILTINS.int, fallback);
}

/** `float(evaluate(expression))` with the call site's except fallback. */
export function evaluateFloat(expression: string, context: ConditionContext, fallback: number): number {
  return convertEvaluated(expression, context, BUILTINS.float, fallback);
}

/**
 * `{stat[0]: int(evaluate(stat[1])) for stat in value}` inside one try-block,
 * as Python's stat_change_expression family does: if any entry raises,
 * every stat is 0.
 */
export function evaluateIntPairs(pairs: unknown, context: ConditionContext): Record<string, number> {
  const entries = Array.isArray(pairs)
    ? pairs.filter((entry): entry is [string, unknown] => Array.isArray(entry) && typeof entry[0] === 'string')
    : [];
  const result: Record<string, number> = {};
  for (const [stat, expression] of entries) {
    const trimmed = typeof expression === 'string' ? expression.trim() : '';
    const outcome = typeof expression === 'string'
      ? evaluatePythonInContext(trimmed, context)
      : { ok: false as const, error: new PyException('AttributeError', `'${typeName(expression)}' object has no attribute 'strip'`) };
    let failure: unknown = outcome.ok ? null : outcome.error;
    if (outcome.ok) {
      try {
        result[stat] = Number(toHostValue(BUILTINS.int(outcome.value)));
      } catch (error) {
        failure = error;
      }
    }
    if (failure) {
      reportEvaluationFailure(trimmed, failure, 'event expression', true);
      return Object.fromEntries(entries.map(([name]) => [name, 0]));
    }
  }
  return result;
}

function convertEvaluated(
  expression: string,
  context: ConditionContext,
  convert: (value: unknown) => unknown,
  fallback: number,
): number {
  const trimmed = String(expression ?? '').trim();
  const outcome = evaluatePythonInContext(trimmed, context);
  if (!outcome.ok) {
    reportEvaluationFailure(trimmed, outcome.error, 'event expression', true);
    return fallback;
  }
  try {
    return Number(toHostValue(convert(outcome.value)));
  } catch (error) {
    reportEvaluationFailure(trimmed, error, 'event expression', true);
    return fallback;
  }
}

/** Evaluate a condition; on failure log like Python and return `fallback`. */
export function evaluateConditionOr(condition: string, context: ConditionContext, fallback: boolean): boolean {
  const trimmed = condition.trim();
  if (trimmed === '') return true;
  const outcome = evaluatePythonInContext(trimmed, context);
  if (outcome.ok) return pyBool(outcome.value);
  reportEvaluationFailure(trimmed, outcome.error, 'event condition', true);
  return fallback;
}

/**
 * Evaluate a Python lambda (e.g. `lambda x, y: ...`) against plain module
 * globals and return it as a JS function. Throws on syntax errors.
 */
export function evaluatePythonLambda(
  source: string,
  globals: Record<string, unknown>,
): (...args: unknown[]) => unknown {
  const fn = evaluatePythonRaw(source, scopeFromRecord(globals));
  if (typeof fn !== 'function') {
    throw new PyException('TypeError', `'${typeName(fn)}' object is not callable`);
  }
  return (...args: unknown[]) => fn(...args);
}

/**
 * Evaluate equation source (already token-substituted by combat-calcs) in
 * Python's equation namespace: builtins, `unit` and the given helpers only.
 * Throws when the expression raises.
 */
export function evaluateEquationSource(
  source: string,
  unit: any,
  game: any,
  globals: Record<string, unknown>,
): any {
  let unitWrapper: any;
  let unitResolved = false;
  return evaluatePythonRaw(source, {
    lookup(name: string) {
      if (Object.prototype.hasOwnProperty.call(globals, name)) return globals[name];
      if (name === 'unit') {
        if (!unitResolved) {
          unitResolved = true;
          unitWrapper = game
            ? buildEvalScope({ game, unit1: unit, gameVars: game.gameVars, levelVars: game.levelVars }).wrapUnit(unit)
            : unit;
        }
        return unitWrapper;
      }
      return NOT_FOUND;
    },
  });
}

/** Python truthiness of an evaluated value. */
export function pythonTruthy(value: unknown): boolean {
  return pyBool(value);
}

/** Python iteration over an evaluated value (dict keys, str chars, ...). */
export function pythonIterationValues(value: unknown): unknown[] {
  return toArray(value).map(toHostValue);
}

/**
 * TextEvaluator._object_to_str: an object's uid, else its nid, else str().
 */
export function pythonStr(value: unknown): string {
  const raw: any = value && typeof value === 'object' && '_raw' in value ? (value as any)._raw : value;
  if (raw && typeof raw === 'object' && !Array.isArray(raw) && !(raw instanceof Map) && !(raw instanceof Set)) {
    if (raw.uid !== undefined && raw.uid !== null) return String(raw.uid);
    if (raw.nid !== undefined && raw.nid !== null) return String(raw.nid);
  }
  return pyStr(value);
}

/**
 * TextEvaluator._evaluate_evals for one `{e:...}` tag: `_object_to_str` of
 * the value, or '??' (logged) when the expression raises.
 */
export function evaluateTextTag(expression: string, context: ConditionContext): string {
  const trimmed = expression.trim();
  const outcome = evaluatePythonInContext(trimmed, context);
  if (outcome.ok) return pythonStr(outcome.value);
  reportEvaluationFailure(trimmed, outcome.error, 'text eval', true);
  return '??';
}

/**
 * A Python literal for a JS value, for substituting a variable's value into
 * expression source. Engine objects become their uid/nid string, as the
 * text evaluator's _object_to_str renders them.
 */
export function pythonLiteral(value: unknown): string {
  const raw: any = value && typeof value === 'object' && '_raw' in value ? (value as any)._raw : value;
  if (raw && typeof raw === 'object' && !Array.isArray(raw) && !(raw instanceof Map) &&
      !(raw instanceof Set) && (raw.uid !== undefined || raw.nid !== undefined)) {
    return pyRepr(String(raw.uid ?? raw.nid));
  }
  return pyRepr(toHostValue(value));
}

setPyevExpressionEvaluator((expression, game, localVars) =>
  evaluateExpression(expression, {
    game,
    gameVars: game.gameVars,
    levelVars: game.levelVars,
    localArgs: localVars,
  }));

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
  /** Python game.talk_options: an ordered list that may repeat a pair. */
  private talkPairs: [string, string][];
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
    this.talkPairs = [];
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
          ...triggerFieldArgs(trigger),
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

  /**
   * Python AddTalk: append the pair, even when it is already listed (EOtF's
   * talk events re-add their own pair after each talk, so pairs repeat).
   */
  addTalkPair(unit1Nid: string, unit2Nid: string): void {
    this.talkPairs.push([unit1Nid, unit2Nid]);
  }

  /** Python RemoveTalk: remove one listed instance; true if one was there. */
  removeTalkPair(unit1Nid: string, unit2Nid: string): boolean {
    const index = this.talkPairs.findIndex(([a, b]) => a === unit1Nid && b === unit2Nid);
    if (index < 0) return false;
    this.talkPairs.splice(index, 1);
    return true;
  }

  /** Check if a talk pair exists in either direction. */
  hasTalkPair(unit1Nid: string, unit2Nid: string): boolean {
    return this.hasDirectedTalk(unit1Nid, unit2Nid) || this.hasDirectedTalk(unit2Nid, unit1Nid);
  }

  /** Python `(unit1, unit2) in game.talk_options`: this direction only. */
  hasDirectedTalk(unit1Nid: string, unit2Nid: string): boolean {
    return this.talkPairs.some(([a, b]) => a === unit1Nid && b === unit2Nid);
  }

  /** Get dynamic talk pairs in the save format used by Python game state. */
  getTalkPairs(): [string, string][] {
    return this.talkPairs.map(([a, b]): [string, string] => [a, b]);
  }

  /** Restore dynamic talk pairs added by add_talk event commands. */
  restoreTalkPairs(pairs: [string, string][] | undefined): void {
    this.talkPairs = (pairs ?? []).map(([unit1Nid, unit2Nid]): [string, string] => [unit1Nid, unit2Nid]);
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
   *
   * Results are returned in Python execution order. Python's
   * EventManager.trigger sorts matches ascending by priority (stable, so ties
   * keep database order) and pushes each onto a stack that EventState pops
   * from the end. The highest priority therefore runs first and, among equal
   * priorities, the event defined LAST in the database runs first.
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

    // Higher priority first; equal priorities in reverse database order.
    matches.reverse();
    matches.sort((a, b) => b.priority - a.priority);

    return matches;
  }
}
