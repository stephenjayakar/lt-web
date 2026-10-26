/**
 * Enumerate every Python expression Embrace of the Fog hands to Python's
 * eval(): event conditions, if/elif/for bodies, {e:} text evals, expression
 * arguments of event commands, #pyev1 statements, item/skill component
 * expressions, AI behaviour and region conditions, objective text evals and
 * equations.
 *
 * Usage: node scripts/py-expr-corpus.mjs [--json] [--project <dir>]
 * The module also exports `collectCorpus(projectDir)` for tests.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Item/skill components whose whole (string) value is evaluated. */
export const STRING_EXPRESSION_COMPONENTS = new Set([
  // skill (engine)
  'condition', 'combat_condition', 'allowed_weapons',
  'dynamic_damage', 'dynamic_resist', 'dynamic_accuracy', 'dynamic_avoid',
  'dynamic_crit_accuracy', 'dynamic_crit_avoid', 'dynamic_attack_speed',
  'dynamic_defense_speed', 'dynamic_attacks', 'dynamic_multiattacks',
  'dynamic_damage_multiplier', 'eval_damage', 'eval_hit', 'eval_avoid', 'eval_crit',
  'eval_max_range', 'eval_min_range', 'eval_range', 'witch_warp_expression',
  'empower_heal', 'empower_heal_received',
  // skill (EOtF custom)
  'eval_galeforce', 'eval_heal_on_kill', 'eval_regeneration', 'eval_upkeep_damage',
  'eval_proc_rate', 'eval_lifelink', 'eval_post_combat_damage',
  'dynamic_resist_multiplier', 'eval_crit_additional', 'dynamic_crit_additional',
  'eval_post_combat_healing', 'eval_post_combat_damage_all', 'eval_canter',
  'dynamic_blitzes', 'eval_extra_damage', 'eval_pre_combat_damage', 'gain_mana',
  // item (engine)
  'eval_available', 'eval_target_restrict_2', 'eval_target_restrict',
  'target_specific_tile', 'can_unlock', 'item_icon_flash', 'eval_mana_cost',
  'gain_mana_after_combat',
  // item (EOtF custom)
  'eval_hp_cost', 'eval_smartblast_aoe', 'eval_ally_blast_aoe', 'eval_magic',
  'eval_dragon', 'eval_dragon_magic', 'eval_weight', 'self_shove_flex_stops',
  'eval_damage_any', 'eval_heal',
]);

/** Components holding a list of [stat, expression] pairs. */
export const PAIR_EXPRESSION_COMPONENTS = new Set([
  'stat_change_expression', 'growth_change_expression',
  'stat_change_at_apply_expression', 'dynamic_stat_change',
]);

/** Components holding a dict with one evaluated key. */
export const DICT_EXPRESSION_COMPONENTS = new Map([
  ['eval_warning', 'condition'],
  ['eval_stack_cost', 'amount'],
]);

/** Event commands and the 0-based argument index holding an expression. */
export const EXPRESSION_COMMAND_ARGS = new Map([
  ['game_var', 1], ['gvar', 1], ['inc_game_var', 1], ['ginc', 1],
  ['level_var', 1], ['lvar', 1], ['inc_level_var', 1], ['linc', 1],
  ['set_unit_field', 2], ['set_item_data', 3], ['add_item_component', 3],
  ['modify_item_component', 3], ['add_skill_component', 3],
  ['modify_skill_component', 3], ['set_skill_data', 3], ['loop_units', 0],
  ['create_record', 1], ['update_record', 1], ['replace_record', 1],
]);

/** Commands whose argument is evaluated only under the `expression` flag. */
export const FLAGGED_EXPRESSION_COMMAND_ARGS = new Map([
  ['choice', 2], ['textbox', 1], ['table', 1],
]);

/**
 * Python's text_evaluator substitutes `{...}` tags innermost-first before
 * eval. For parsing purposes each remaining tag becomes an identifier.
 */
export function substituteTags(text) {
  let previous;
  let current = text;
  do {
    previous = current;
    current = current.replace(/\{[^{}]*\}/g, '_tag_');
  } while (current !== previous);
  return current;
}

/** Innermost-first `{e:...}` bodies, with nested tags already substituted. */
export function extractEvalTags(text) {
  const bodies = [];
  let current = text;
  for (let guard = 0; guard < 50; guard += 1) {
    let changed = false;
    current = current.replace(/\{([^{}]*)\}/g, (_whole, inner) => {
      changed = true;
      const match = inner.match(/^(?:e|eval):([\s\S]*)$/);
      if (match) bodies.push(match[1]);
      return '_tag_';
    });
    if (!changed) break;
  }
  return bodies;
}

function splitCommand(line) {
  return line.split(';');
}

/** Split the arguments of a #pyev1 `$command(...)` call at top-level commas. */
function splitTopLevel(source) {
  const parts = [];
  let depth = 0;
  let quote = null;
  let start = 0;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (char === '\\') index += 1;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if ('([{'.includes(char)) depth += 1;
    else if (')]}'.includes(char)) depth -= 1;
    else if (char === ',' && depth === 0) {
      parts.push(source.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(source.slice(start));
  return parts.map((part) => part.trim()).filter(Boolean);
}

function delimiterBalance(source) {
  let depth = 0;
  let quote = null;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (char === '\\') index += 1;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '#') break;
    if (char === '"' || char === "'") quote = char;
    else if ('([{'.includes(char)) depth += 1;
    else if (')]}'.includes(char)) depth -= 1;
  }
  return depth;
}

function stripComment(line) {
  let quote = null;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quote) {
      if (char === '\\') index += 1;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === '#') return line.slice(0, index);
  }
  return line;
}

/** Expressions inside #pyev1 statements. */
function pyevExpressions(source) {
  const statements = [];
  let buffer = '';
  for (const raw of source.slice(1)) {
    const line = stripComment(raw);
    buffer = buffer ? `${buffer} ${line.trim()}` : line;
    if (delimiterBalance(buffer) > 0) continue;
    if (buffer.trim()) statements.push(buffer.trim());
    buffer = '';
  }
  const expressions = [];
  for (const statement of statements) {
    let match;
    if ((match = statement.match(/^(?:if|elif|while)\s+([\s\S]+):$/))) {
      expressions.push(match[1]);
    } else if ((match = statement.match(/^for\s+([\s\S]+?)\s+in\s+([\s\S]+):$/))) {
      expressions.push(match[2]);
    } else if (/^(?:else|try|finally|pass|break|continue|return)\s*:?$/.test(statement) ||
               /^except\b/.test(statement)) {
      continue;
    } else if ((match = statement.replace(/\)\.FLAGS\([^()]*\)$/, ')').match(/^\$(\w+)\(([\s\S]*)\)$/))) {
      expressions.push(...splitTopLevel(match[2]));
    } else if ((match = statement.match(/^[A-Za-z_][\w.\[\]'"]*\s*(?:[+\-*\/%]|\/\/)?=(?!=)\s*([\s\S]+)$/))) {
      expressions.push(match[1]);
    } else {
      expressions.push(statement);
    }
  }
  return expressions;
}

/**
 * Collect the corpus. Each entry: { kind, where, raw, expr } where `expr` is
 * the parse-ready text (tags substituted) and `raw` the authored text.
 */
export function collectCorpus(projectDir) {
  const readJson = (name) =>
    JSON.parse(fs.readFileSync(path.join(projectDir, 'game_data', name), 'utf8'));
  const entries = [];
  const add = (kind, where, raw) => {
    if (typeof raw !== 'string' || !raw.trim()) return;
    entries.push({ kind, where, raw, expr: substituteTags(raw).trim() });
  };
  const addEvals = (where, text) => {
    for (const body of extractEvalTags(text)) add('eval_tag', where, body);
  };

  for (const event of readJson('events.json')) {
    const where = `event:${event.level_nid ?? ''}:${event.name}`;
    add('event_condition', where, event.condition);
    const source = event._source ?? [];
    if (source[0]?.trim().startsWith('#pyev1')) {
      for (const expression of pyevExpressions(source)) add('pyev1', where, expression);
      continue;
    }
    for (const line of source) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      addEvals(where, trimmed);
      const args = splitCommand(trimmed);
      const command = args[0].trim().replace(/:$/, '');
      if (command === 'if' || command === 'elif') add('if', where, args[1]);
      else if (command === 'for') add('for', where, args[2]);
      else if (EXPRESSION_COMMAND_ARGS.has(command)) {
        const arg = args[EXPRESSION_COMMAND_ARGS.get(command) + 1];
        // Python treats an argument that is a whole {e:} tag as text first;
        // the tag body is already collected, the substituted text is what
        // eval sees.
        if (arg !== undefined && !/^(?:FLAG\(|[A-Za-z_]\w*=)/.test(arg)) add(`command:${command}`, where, arg);
      } else if (FLAGGED_EXPRESSION_COMMAND_ARGS.has(command) &&
                 args.slice(1).some((arg) => arg.trim() === 'expression' || arg.trim() === 'FLAG(expression)')) {
        add(`command:${command}`, where, args[FLAGGED_EXPRESSION_COMMAND_ARGS.get(command) + 1]);
      }
    }
  }

  for (const [file, label] of [['skills.json', 'skill'], ['items.json', 'item']]) {
    for (const record of readJson(file)) {
      for (const [nid, value] of record.components ?? []) {
        const where = `${label}:${record.nid}:${nid}`;
        if (STRING_EXPRESSION_COMPONENTS.has(nid)) {
          if (typeof value === 'string') add(`component:${nid}`, where, value);
        } else if (PAIR_EXPRESSION_COMPONENTS.has(nid) && Array.isArray(value)) {
          for (const pair of value) {
            if (Array.isArray(pair)) add(`component:${nid}`, `${where}:${pair[0]}`, String(pair[1] ?? ''));
          }
        } else if (DICT_EXPRESSION_COMPONENTS.has(nid) && value && typeof value === 'object') {
          add(`component:${nid}`, where, value[DICT_EXPRESSION_COMPONENTS.get(nid)]);
        } else if (nid === 'eval_special_range' && typeof value === 'string') {
          add('component:eval_special_range', where, value);
        }
      }
    }
  }

  for (const ai of readJson('ai.json')) {
    (ai.behaviours ?? []).forEach((behaviour, index) =>
      add('ai_condition', `ai:${ai.nid}:${index}`, behaviour.condition));
  }

  for (const level of readJson('levels.json')) {
    for (const region of level.regions ?? []) {
      if (region.region_type === 'event' || region.interrupt_move) {
        add('region_condition', `level:${level.nid}:region:${region.nid}`, region.condition);
      }
    }
    for (const key of ['simple', 'win', 'loss']) {
      addEvals(`level:${level.nid}:objective:${key}`, level.objective?.[key] ?? '');
    }
  }

  for (const equation of readJson('equations.json')) {
    add('equation', `equation:${equation.nid}`, equation.expression);
  }
  return entries;
}

/** Unique parse-ready expressions with every place they occur. */
export function uniqueCorpus(entries) {
  const byExpr = new Map();
  for (const entry of entries) {
    const existing = byExpr.get(entry.expr);
    if (existing) {
      existing.kinds.add(entry.kind);
      existing.count += 1;
    } else {
      byExpr.set(entry.expr, { expr: entry.expr, kinds: new Set([entry.kind]), where: entry.where, count: 1 });
    }
  }
  return [...byExpr.values()].map((entry) => ({ ...entry, kinds: [...entry.kinds].sort() }));
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const projectIndex = process.argv.indexOf('--project');
  const projectDir = projectIndex >= 0
    ? process.argv[projectIndex + 1]
    : path.join(process.cwd(), 'lt-maker/eotf.ltproj');
  const entries = collectCorpus(projectDir);
  const unique = uniqueCorpus(entries);
  if (process.argv.includes('--json')) {
    process.stdout.write(JSON.stringify(unique, null, 1));
  } else {
    const kinds = new Map();
    for (const entry of entries) kinds.set(entry.kind, (kinds.get(entry.kind) ?? 0) + 1);
    console.log(`EOtF Python expression corpus: ${entries.length} occurrences, ${unique.length} unique`);
    for (const [kind, count] of [...kinds].sort((a, b) => b[1] - a[1])) console.log(`  ${kind}: ${count}`);
  }
}
