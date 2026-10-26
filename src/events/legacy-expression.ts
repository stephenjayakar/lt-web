/**
 * TEMPORARY: the regex Python-to-JavaScript expression translator that
 * src/events/py-expr replaced, kept verbatim only so the differential test
 * (tests/py-expr-differential.spec.ts) can run old and new evaluators side by
 * side. Not used by the engine. Delete together with that spec.
 */
/* eslint-disable */
// @ts-nocheck
import { GameQueryEngine } from '../engine/query-engine';
import { getInternalLevel } from '../engine/leveling';
import { createItemTree } from '../objects/item';
import { RemoveSkillAction, RegisterItemTreeAction, SetGameVarAction } from '../engine/action';
import { reportUnimplemented } from '../engine/strict-mode';
import { Lcg } from '../engine/static-random';
import { RECORDS, isFavorited, setFavorited } from '../engine/records';
import { canCounterattack, itemIsMagic } from '../combat/combat-calcs';
import { unitHasTag, unitTags } from '../combat/skill-system';
import * as skillSystem from '../combat/skill-system';
import { registeredItemEvaluators, type ConditionContext } from './event-manager';

// ============================================================
// Condition Evaluator
// ============================================================

function pythonTruthy(value: any): boolean {
  if (value === null || value === undefined || value === false) return false;
  if (typeof value === 'number') return value !== 0 && !Number.isNaN(value);
  if (typeof value === 'string' || Array.isArray(value)) return value.length > 0;
  if (value instanceof Map || value instanceof Set) return value.size > 0;
  return true;
}

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
export function legacyEvaluateCondition(
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
    return andParts.every(part => legacyEvaluateCondition(part, context));
  }

  const orParts = splitAtTopLevel(trimmed, ' or ');
  if (orParts.length > 1) {
    return orParts.some(part => legacyEvaluateCondition(part, context));
  }

  // Negation: "not <expr>"
  if (trimmed.toLowerCase().startsWith('not ')) {
    return !legacyEvaluateCondition(trimmed.slice(4), context);
  }

  // Strip outer parentheses
  if (trimmed.startsWith('(') && trimmed.endsWith(')')) {
    const inner = trimmed.slice(1, -1);
    // Only strip if the parens are balanced
    if (findMatchingParen(trimmed, 0) === trimmed.length - 1) {
      return legacyEvaluateCondition(inner, context);
    }
  }

  // 'X' in unit.tags / 'X' in unit1.tags / 'X' in unit2.tags (Python `in` for lists)
  const inMatch = trimmed.match(/^['"](.+?)['"]\s+in\s+(.+)$/);
  if (inMatch) {
    const needle = inMatch[1];
    const haystack = resolvePath(inMatch[2], context);
    if (Array.isArray(haystack)) return haystack.includes(needle);
    if (typeof haystack === 'string') return haystack.includes(needle);
    if (haystack instanceof Set || haystack instanceof Map) {
      return haystack.has(needle);
    }
    // Method-call haystacks such as game.game_vars.get('Active_Stratagems')
    // are outside resolvePath's dotted-property subset. Let the full Python
    // expression fallback translate their membership instead of silently
    // treating them as absent.
    const fallback = evaluateWithJsFallback(trimmed, context, false);
    if (fallback !== undefined) return !!fallback;
    return false;
  }

  // 'X' not in unit.tags
  const notInMatch = trimmed.match(/^['"](.+?)['"]\s+not\s+in\s+(.+)$/);
  if (notInMatch) {
    const needle = notInMatch[1];
    const haystack = resolvePath(notInMatch[2], context);
    if (Array.isArray(haystack)) return !haystack.includes(needle);
    if (typeof haystack === 'string') return !haystack.includes(needle);
    if (haystack instanceof Set || haystack instanceof Map) {
      return !haystack.has(needle);
    }
    const fallback = evaluateWithJsFallback(trimmed, context, false);
    if (fallback !== undefined) return !!fallback;
    return true;
  }

  // Function calls: game.check_dead('Name'), check_dead('Name'), check_pair('A','B')
  const funcMatch = trimmed.match(/^(?:game\.)?check_dead\s*\(\s*['"]([^'"]+)['"]\s*\)$/);
  if (funcMatch) {
    const unitNid = funcMatch[1];
    return isUnitDead(unitNid, context);
  }

  // game.check_alive('Name') / check_alive('Name'): Python returns False for
  // a unit missing from the registry, like check_dead.
  const aliveMatch = trimmed.match(/^(?:game\.)?check_alive\s*\(\s*['"]([^'"]+)['"]\s*\)$/);
  if (aliveMatch) {
    return isUnitAlive(aliveMatch[1], context);
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

  // has_item(...) has no fast path: Python has_item(item, nid, team, tag,
  // party) also searches convoys, so it goes through the query engine.

  // has_skill(unit, 'SkillNid') — Python QueryEngine.has_skill(unit, skill).
  // Only the simple forms are handled here; anything else (u(...), kwargs,
  // expressions) falls through to the full evaluator.
  const hasSkillFuncMatch = trimmed.match(
    /^has_skill\s*\(\s*(unit1|unit2|unit|target|'[^'"]+'|"[^'"]+")\s*,\s*(?:['"]([^'"]+)['"]|([A-Za-z_]\w*))\s*\)$/,
  );
  if (hasSkillFuncMatch) {
    const unitArg = hasSkillFuncMatch[1];
    // A bare skill name is a Python variable: an undefined one raises
    // NameError and the condition is false (EOtF authors
    // `has_skill({unit},BloodlineCursePlus)` once).
    const skillArg = hasSkillFuncMatch[2] ?? resolvePath(hasSkillFuncMatch[3], context);
    const skillNid = typeof skillArg === 'string' ? skillArg : (skillArg as any)?.nid;
    if (typeof skillNid !== 'string') return false;
    let targetUnit: any;
    if (unitArg.startsWith('\'') || unitArg.startsWith('"')) {
      const nid = unitArg.slice(1, -1);
      targetUnit = context.game?.units?.get?.(nid) ?? context.game?.getUnit?.(nid);
    } else {
      targetUnit = unitArg === 'unit2' || unitArg === 'target' ? context.unit2 : context.unit1;
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
    // Python QueryEngine.v: a level var holding None falls through to the
    // game vars.
    const levelValue = context.levelVars?.get(varName);
    if (levelValue !== undefined && levelValue !== null) {
      return pythonTruthy(levelValue);
    }
    if (context.gameVars?.has(varName)) {
      return pythonTruthy(context.gameVars.get(varName));
    }
    return pythonTruthy(fallback ?? 0);
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
      return legacyEvaluateCondition(trimmedExpr, context);
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
  const isDeadMatch = trimmed.match(/^(?:game\.)?is_dead\s*\(\s*['"]([^'"]+)['"]\s*\)$/);
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

  // any_unit_in_region(...) has no fast path: Python filters through
  // game.get_all_units() (no dying or 'Tile' units) and takes nid/team/tag
  // keywords, all handled by the query engine.

  // Common authored existence query. Handle it against raw runtime units
  // instead of constructing the complete Python-compatible eval scope for
  // every item_override lookup. EOtF's Gift of Magic evaluates this while
  // drawing each affected weapon, so the generic wrapper path can otherwise
  // dominate the renderer.
  const anyLivingClassMatch = trimmed.match(
    /^any\(\[\s*\w+\.position\s+for\s+(\w+)\s+in\s+game\.units\s+if\s+\1\.klass\s*==\s*['"]([^'"]+)['"]\s+and\s+not\s+is_dead\(\1\.nid\)\s*\]\)$/,
  );
  if (anyLivingClassMatch) {
    const klass = anyLivingClassMatch[2];
    const units = context.game?.units?.values?.() ?? [];
    for (const unit of units) {
      if ((unit as any).klass !== klass) continue;
      if ((unit as any).isDead?.() ?? (unit as any).dead ?? false) continue;
      if ((unit as any).position) return true;
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
    return pythonTruthy(value);
  }

  // Fallback: try JavaScript-based evaluation with Python-compatible scope.
  // This handles complex expressions like:
  //   game.level.regions.get('EnemyRein').contains(game.get_unit('Eirika').position)
  //   any(game.level.regions.get('X').contains(u.position) for u in game.get_units_in_party())
  //   len(game.get_enemy_units()) == 0
  try {
    const result = evaluateWithJsFallback(trimmed, context);
    if (result !== undefined) {
      return pythonTruthy(result);
    }
  } catch (e) {
    // Fall through to default
  }

  // Unknown condition — warn and default to false (skip events with un-evaluable conditions;
  // firing them would cause reinforcements/etc. to trigger at wrong times)
  reportUnimplemented('expression', trimmed, 'event condition');
  return false;
}


/** Evaluate a non-boolean event expression for {e:...}/{eval:...} arguments. */
export function legacyEvaluateExpression(expression: string, context: ConditionContext): any {
  const direct = resolvePath(expression, context);
  if (direct !== undefined) {
    if (/^(?:unit|unit1|unit2)\.(?:wexp|stats|growths)$/.test(expression.trim()) &&
        direct && typeof direct === 'object' &&
        typeof direct[Symbol.iterator] !== 'function') {
      return Object.keys(direct);
    }
    return direct;
  }
  const value = evaluateWithJsFallback(expression, context);
  // A Python call that returns None (game.register_item(...),
  // set.discard(...)) legitimately yields undefined; only a failed
  // evaluation is unimplemented.
  if (value === undefined && lastJsEvaluationFailed) {
    reportUnimplemented('expression', expression, 'event expression');
  }
  return value;
}

/** Whether the most recent evaluateWithJsFallback call failed to evaluate. */
let lastJsEvaluationFailed = false;

/** Resolve a dotted path like "game.turncount", "unit.nid", "region.nid" to a value. */
function resolvePath(path: string, ctx: ConditionContext): any {
  const trimmed = path.trim();

  // String literals. The closing quote must be the one that matches the
  // opening quote, not merely the last character: `'a' + 'b'` also starts and
  // ends with a quote, and treating it as one literal yielded the raw text
  // `a' + 'b` instead of concatenating. EotF builds record NIDs this way
  // (`{e:'Player' + '_skill_slots'}`), so the difference is load-bearing.
  const quote = trimmed[0];
  if (quote === "'" || quote === '"') {
    let closing = -1;
    for (let index = 1; index < trimmed.length; index += 1) {
      if (trimmed[index] === '\\') {
        index += 1;
        continue;
      }
      if (trimmed[index] === quote) {
        closing = index;
        break;
      }
    }
    if (closing === trimmed.length - 1) return trimmed.slice(1, -1);
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

  // Event expressions use both Python's position and target_pos aliases.
  if (trimmed === 'position' || trimmed === 'target_pos') return ctx.position;

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
    // Python UnitObject.tags is the own/class/skill tag union.
    if (part === 'tags' && Array.isArray(current.tags) && Array.isArray(current.skills) &&
        typeof current.klass === 'string') {
      current = [...unitTags(current)];
      continue;
    }
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
  // Python game.check_dead / QueryEngine.is_dead: a unit missing from the
  // registry (never added, or removed by unload_unit) is not dead.
  if (!unit) return false;
  return unit.isDead?.() ?? unit.dead ?? false;
}

function isUnitAlive(nid: string, ctx: ConditionContext): boolean {
  if (!ctx.game) return false;
  const unit = ctx.game.units?.get(nid) ?? ctx.game.getUnit?.(nid);
  if (!unit) return false;
  return !(unit.isDead?.() ?? unit.dead ?? false);
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
  // Python evaluates the whole expression; an operand that cannot be
  // evaluated raises, and a failing `if` condition is False. Comparing the
  // raw operand text instead made e.g. `len(??) > 0` (a missing {v:}) true.
  if (lhsValue === undefined || rhsValue === undefined) {
    const whole = evaluateWithJsFallback(`${lhsStr} ${op} ${rhsStr}`, ctx, false);
    return whole === undefined ? false : !!whole;
  }

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
/**
 * Query helpers whose Python keyword arguments are passed as one trailing
 * plain object (see query-engine `bindPyArgs`).
 */
const KWARG_QUERY_FUNCTIONS = new Set([
  'has_item', 'get_units_within_distance', 'get_allies_within_distance',
  'get_units_in_region', 'any_unit_in_region', 'get_closest_allies',
  'get_closest_units', 'get_closest_enemies',
]);

/** Split call arguments at top-level commas, tracking brackets and strings. */
function splitCallArguments(str: string): string[] {
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
    if (ch === '"' || ch === "'") inString = ch;
    else if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    else if (ch === ',' && depth === 0) {
      parts.push(str.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(str.slice(start));
  return parts;
}

/**
 * Rewrite Python keyword arguments of the query helpers into one trailing
 * object: `get_units_within_distance(p, dist=2, nid='Isaac')` becomes
 * `get_units_within_distance(p, { __kw__: true, dist: 2, nid: 'Isaac' })`.
 */
function translateQueryKwargs(expr: string): string {
  const pattern = /(?<![\w.])([A-Za-z_]\w*)\s*\(/g;
  let out = '';
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(expr)) !== null) {
    if (!KWARG_QUERY_FUNCTIONS.has(match[1])) continue;
    const open = match.index + match[0].length - 1;
    const close = findMatchingParen(expr, open);
    if (close < 0) break;
    const args = splitCallArguments(expr.slice(open + 1, close));
    const positional: string[] = [];
    const keywords: string[] = [];
    for (const arg of args) {
      const keyword = arg.match(/^\s*([A-Za-z_]\w*)\s*=(?!=)\s*([\s\S]+?)\s*$/);
      if (keyword) keywords.push(`${keyword[1]}: ${translateQueryKwargs(keyword[2])}`);
      else positional.push(translateQueryKwargs(arg.trim()));
    }
    if (keywords.length === 0) continue;
    const rebuilt = [...positional.filter(Boolean), `{ __kw__: true, ${keywords.join(', ')} }`];
    out += `${expr.slice(cursor, open + 1)}${rebuilt.join(', ')})`;
    cursor = close + 1;
    pattern.lastIndex = close + 1;
  }
  return out + expr.slice(cursor);
}

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

/** Start index of the primary expression (receiver) that ends just before `end`. */
function receiverStart(str: string, end: number): number {
  let i = end - 1;
  for (;;) {
    if (i < 0) return 0;
    const ch = str[i];
    let group = false;
    if (ch === ')' || ch === ']') {
      const open = ch === ')' ? '(' : '[';
      let depth = 0;
      for (; i >= 0; i--) {
        if (str[i] === ch) depth++;
        else if (str[i] === open && --depth === 0) break;
      }
      if (i < 0) return -1;
      i -= 1;
      group = true;
    } else if (ch === "'" || ch === '"') {
      i -= 1;
      while (i >= 0 && str[i] !== ch) i -= 1;
      if (i < 0) return -1;
      i -= 1;
    } else if (/[\w$]/.test(ch)) {
      while (i >= 0 && /[\w$]/.test(str[i])) i -= 1;
    } else {
      return i + 1;
    }
    if (i < 0) return 0;
    // Member chains: `a.b`, and calls/subscripts `f(x)`, `a[0]`.
    if (str[i] === '.') { i -= 1; continue; }
    if (group && /[\w$\])]/.test(str[i])) continue;
    return i + 1;
  }
}

/**
 * Python `seq.index(x)` (lists and strings): JavaScript arrays have no
 * `index`, so rewrite to `__pyIndex(seq, x)`, which raises like Python when
 * the value is missing.
 */
function translatePyIndexCalls(expression: string): string {
  let translated = expression;
  for (let pass = 0; pass < 20; pass++) {
    const match = /\.index\s*\(/.exec(translated);
    if (!match) break;
    const start = receiverStart(translated, match.index);
    const open = translated.indexOf('(', match.index);
    const close = findMatchingParen(translated, open);
    if (start < 0 || close < 0 || start >= match.index) break;
    const receiver = translated.slice(start, match.index);
    const arg = translated.slice(open + 1, close);
    translated = `${translated.slice(0, start)}__pyIndex(${receiver}, ${arg})${translated.slice(close + 1)}`;
  }
  return translated;
}

/** End index (exclusive) of the primary expression starting at `start`. */
function primaryEnd(str: string, start: number): number {
  let i = start;
  while (i < str.length && str[i] === ' ') i += 1;
  const matchGroup = (open: string, close: string): number => {
    let depth = 0;
    for (let j = i; j < str.length; j++) {
      const ch = str[j];
      if (ch === "'" || ch === '"') {
        j += 1;
        while (j < str.length && str[j] !== ch) j += 1;
        continue;
      }
      if (ch === open) depth += 1;
      else if (ch === close && --depth === 0) return j + 1;
    }
    return -1;
  };
  const ch = str[i];
  if (ch === "'" || ch === '"') {
    let j = i + 1;
    while (j < str.length && str[j] !== ch) j += 1;
    i = j + 1;
  } else if (ch === '(' || ch === '[') {
    const end = matchGroup(ch, ch === '(' ? ')' : ']');
    if (end < 0) return -1;
    i = end;
  } else if (/[\w$]/.test(ch ?? '')) {
    while (i < str.length && /[\w$]/.test(str[i])) i += 1;
  } else {
    return -1;
  }
  for (;;) {
    if (str[i] === '.' && /[A-Za-z_$]/.test(str[i + 1] ?? '')) {
      i += 1;
      while (i < str.length && /[\w$]/.test(str[i])) i += 1;
    } else if (str[i] === '(' || str[i] === '[') {
      const end = matchGroup(str[i], str[i] === '(' ? ')' : ']');
      if (end < 0) return -1;
      i = end;
    } else {
      return i;
    }
  }
}

/**
 * Python membership `x in y` / `x not in y` (already `x ! in y` here) for
 * arbitrary operands, including calls with nested parentheses:
 * rewritten to __pyIn(x, y). A parenthesised tuple haystack becomes a list.
 */
const ARITHMETIC_OPERATOR = /^(\*\*|\/\/|[+\-*\/%])/;

/** Extend an operand start leftward over binary arithmetic (`a + b`). */
function extendOperandLeft(str: string, start: number): number {
  let operandStart = start;
  while (operandStart > 0) {
    let j = operandStart - 1;
    while (j >= 0 && str[j] === ' ') j -= 1;
    if (j < 0 || !'+-*/%'.includes(str[j])) break;
    let opStart = j;
    if ((str[j] === '*' || str[j] === '/') && str[j - 1] === str[j]) opStart = j - 1;
    let p = opStart - 1;
    while (p >= 0 && str[p] === ' ') p -= 1;
    // A preceding operator/opener means this one is unary or a comparison.
    if (p < 0 || '=<>!&|,([{?:+-*/%'.includes(str[p])) break;
    const previous = receiverStart(str, p + 1);
    if (previous < 0 || previous > p) break;
    operandStart = previous;
  }
  return operandStart;
}

/** Extend an operand end rightward over binary arithmetic (`a + b`). */
function extendOperandRight(str: string, end: number): number {
  if (end < 0) return end;
  let operandEnd = end;
  for (;;) {
    let j = operandEnd;
    while (j < str.length && str[j] === ' ') j += 1;
    const op = ARITHMETIC_OPERATOR.exec(str.slice(j));
    if (!op) break;
    const next = primaryEnd(str, j + op[0].length);
    if (next < 0) break;
    operandEnd = next;
  }
  return operandEnd;
}

function translatePyMembership(expression: string): string {
  let translated = expression;
  const inString = (str: string, index: number): boolean => {
    let quote: string | null = null;
    for (let i = 0; i < index; i++) {
      const ch = str[i];
      if (quote) {
        if (ch === '\\') i += 1;
        else if (ch === quote) quote = null;
      } else if (ch === "'" || ch === '"' || ch === '`') {
        quote = ch;
      }
    }
    return quote !== null;
  };
  let searchFrom = 0;
  for (let pass = 0; pass < 40; pass++) {
    const pattern = /\s+(!\s*)?in\s+/g;
    pattern.lastIndex = searchFrom;
    let match = pattern.exec(translated);
    while (match && inString(translated, match.index)) match = pattern.exec(translated);
    if (!match) break;
    // Python binds arithmetic tighter than `in`: the operands are whole
    // `a + b` chains, not just the nearest primary.
    const needleStart = extendOperandLeft(translated, receiverStart(translated, match.index));
    const hayStart = match.index + match[0].length;
    const hayEnd = extendOperandRight(translated, primaryEnd(translated, hayStart));
    if (needleStart < 0 || needleStart >= match.index || hayEnd < 0) {
      searchFrom = match.index + match[0].length;
      continue;
    }
    const needle = translated.slice(needleStart, match.index);
    let haystack = translated.slice(hayStart, hayEnd);
    if (haystack.startsWith('(') && haystack.endsWith(')') &&
        findMatchingParen(haystack, 0) === haystack.length - 1 &&
        splitAtTopLevel(haystack.slice(1, -1), ',').length > 1) {
      haystack = `[${haystack.slice(1, -1)}]`;
    }
    const call = `__pyIn(${needle}, ${haystack})`;
    translated = translated.slice(0, needleStart) + (match[1] ? `!${call}` : call) + translated.slice(hayEnd);
    searchFrom = needleStart;
  }
  return translated;
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
      let projection = forParts[0].trim();
      if (projection.startsWith('(') && projection.endsWith(')')) {
        const tupleParts = splitAtTopLevel(projection.slice(1, -1), ',')
          .map((part) => part.trim())
          .filter(Boolean);
        if (tupleParts.length > 1) projection = `[${tupleParts.join(', ')}]`;
      }
      const mapped = filter
        ? `(${collection}).filter((${variable}) => (${filter})).map((${variable}) => (${projection}))`
        : `(${collection}).map((${variable}) => (${projection}))`;
      const prefix = translated.slice(0, open);
      const membership = /((?:'[^']*'|"[^"]*"|\d+(?:\.\d+)?|[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*))\s+(not\s+)?in\s*$/
        .exec(prefix);
      if (membership?.index !== undefined &&
          !/\bfor\s+$/.test(prefix.slice(0, membership.index))) {
        const contains = `(${mapped}).includes(${membership[1]})`;
        translated = prefix.slice(0, membership.index) +
          (membership[2] ? `!${contains}` : contains) +
          translated.slice(close + 1);
      } else {
        translated = prefix + mapped + translated.slice(close + 1);
      }
      changed = true;
      break;
    }
    if (!changed) break;
  }
  return translated;
}

function replacePythonWords(
  expression: string,
  replacements: Record<string, string>,
): string {
  let translated = '';
  let quote: string | null = null;
  for (let index = 0; index < expression.length;) {
    const char = expression[index];
    if (quote) {
      translated += char;
      if (char === quote && expression[index - 1] !== '\\') quote = null;
      index++;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      translated += char;
      index++;
      continue;
    }
    const word = /^[A-Za-z_]\w*/.exec(expression.slice(index))?.[0];
    if (word) {
      translated += replacements[word] ?? word;
      index += word.length;
      continue;
    }
    translated += char;
    index++;
  }
  return translated;
}

const ADDITION_BOUNDARIES = ['===', '!==', '=>', '==', '!=', '<=', '>=', '&&', '||', '<', '>', '?', ':', ','];

/** Python `a + b` -> `__pyAdd(a, b)` inside one operand segment. */
function translateAdditionSegment(segment: string): string {
  const leading = /^\s*/.exec(segment)?.[0] ?? '';
  const trailing = /\s*$/.exec(segment)?.[0] ?? '';
  const body = segment.slice(leading.length, segment.length - trailing.length);
  const parts = splitAtTopLevel(body, ' + ').map((part) => part.trim());
  if (parts.length < 2) return segment;
  return leading + parts.slice(1).reduce(
    (left, right) => `__pyAdd(${left}, ${right})`,
    parts[0],
  ) + trailing;
}

/**
 * Python list/string `+` -> `__pyAdd`. `+` binds tighter than comparisons,
 * boolean operators, ternaries and argument commas, so additions are
 * translated within each operand between those boundaries (and recursively
 * inside brackets), never across them.
 */
function translateTopLevelAdditions(expression: string): string {
  let translated = '';
  let segment = '';
  const flush = () => {
    translated += translateAdditionSegment(segment);
    segment = '';
  };
  for (let index = 0; index < expression.length; index++) {
    const char = expression[index];
    if (char === "'" || char === '"' || char === '`') {
      let close = index + 1;
      while (close < expression.length && !(expression[close] === char && expression[close - 1] !== '\\')) close++;
      segment += expression.slice(index, close + 1);
      index = close;
      continue;
    }
    if (char === '(' || char === '[' || char === '{') {
      const closer = char === '(' ? ')' : char === '[' ? ']' : '}';
      let depth = 0;
      let close = -1;
      let quote: string | null = null;
      for (let j = index; j < expression.length; j++) {
        const c = expression[j];
        if (quote) {
          if (c === quote && expression[j - 1] !== '\\') quote = null;
          continue;
        }
        if (c === "'" || c === '"' || c === '`') { quote = c; continue; }
        if (c === char) depth++;
        else if (c === closer && --depth === 0) { close = j; break; }
      }
      if (close > index) {
        segment += `${char}${translateTopLevelAdditions(expression.slice(index + 1, close))}${closer}`;
        index = close;
        continue;
      }
    }
    const boundary = ADDITION_BOUNDARIES.find((op) => expression.startsWith(op, index));
    if (boundary) {
      flush();
      translated += boundary;
      index += boundary.length - 1;
      continue;
    }
    segment += char;
  }
  flush();
  return translated;
}

/** Translate Python sorted(values, key=lambda x: ..., reverse=True). */
function translateSortedCalls(expression: string): string {
  let translated = expression;
  for (let pass = 0; pass < 20; pass++) {
    const match = /\bsorted\s*\(/g.exec(translated);
    if (!match || match.index === undefined) break;
    const open = translated.indexOf('(', match.index);
    const close = findMatchingParen(translated, open);
    if (close < 0) break;
    const args = splitAtTopLevel(translated.slice(open + 1, close), ',')
      .map((part) => part.trim());
    const values = args[0];
    const keyArg = args.find((part) => part.startsWith('key='));
    const reverseArg = args.find((part) => part.startsWith('reverse='));
    let key = '(value) => value';
    if (keyArg) {
      const lambda = keyArg.slice('key='.length).trim();
      const lambdaMatch = /^lambda\s+([A-Za-z_]\w*)\s*:\s*([\s\S]+)$/.exec(lambda);
      if (!lambdaMatch) break;
      let body = lambdaMatch[2].trim();
      if (body.startsWith('(') && body.endsWith(')')) {
        const tupleParts = splitAtTopLevel(body.slice(1, -1), ',')
          .map((part) => part.trim())
          .filter(Boolean);
        if (tupleParts.length > 1) body = `[${tupleParts.join(', ')}]`;
      }
      key = `(${lambdaMatch[1]}) => (${body})`;
    }
    const reverse = reverseArg
      ? reverseArg.slice('reverse='.length).trim()
      : 'false';
    const replacement = `__sorted__(${values}, ${key}, ${reverse})`;
    translated =
      translated.slice(0, match.index) +
      replacement +
      translated.slice(close + 1);
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
  if (elseIndex < 0) {
    const whenTrue = grouped.slice(0, ifIndex).trim();
    const condition = grouped.slice(ifIndex + 4).trim();
    return `((${translateConditionalExpressions(condition)}) ? ` +
      `(${translateConditionalExpressions(whenTrue)}) : (0))`;
  }
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
    const wrapped: any = regions.map(wrapRegion);
    wrapped.get = (nid: string) =>
      wrapped.find((region: any) => region.nid === nid) ?? wrapRegion(null);
    wrapped.values = () => wrapped;
    return wrapped;
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
    const entries = Object.entries(value ?? {});
    return {
      ...(value ?? {}),
      get(key: string, fallback?: any) {
        const result = value?.[key];
        return result === undefined ? fallback : result;
      },
      keys() {
        return entries.map(([key]) => key);
      },
      filter(predicate: (key: string, index: number) => boolean) {
        return entries.map(([key]) => key).filter(predicate);
      },
      map(mapper: (key: string, index: number) => any) {
        return entries.map(([key]) => key).map(mapper);
      },
      *[Symbol.iterator]() {
        for (const [key] of entries) yield key;
      },
    };
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

  function wrapComponent(nid: string, value: any) {
    return new Proxy({
      nid,
      value: value && typeof value === 'object' && !Array.isArray(value)
        ? wrapMapping(value)
        : value,
    }, {
      get(target, property: string | symbol) {
        if (property in target) return target[property as keyof typeof target];
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
        return Reflect.get(target, property);
      },
    });
    wrappedClasses.set(klass, wrapped);
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
    // Expensive fields are materialized on first read and memoized for the
    // life of this wrapper (one expression scope), like wrapSkill's
    // components. Expressions read only a few fields, while units are wrapped
    // wholesale (game.units, unit lists, the evaluated unit itself).
    const memoValues = new Map<string, unknown>();
    const memo = <T>(key: string, compute: () => T): T => {
      if (!memoValues.has(key)) memoValues.set(key, compute());
      return memoValues.get(key) as T;
    };
    const wrapped = {
      _raw: u,
      nid: u.nid,
      name: u.name,
      team: u.team,
      position: u.position,
      previous_position: u.previousPosition ?? u.previous_position ?? null,
      // Python UnitObject.tags: own tags | class tags | skill additional_tags.
      get tags() {
        return memo('tags', () => (Array.isArray(u.skills) ? [...unitTags(u, game)] : (u.tags ?? [])));
      },
      klass: u.klass,
      affinity: u.affinity ?? null,
      traveler: u.traveler ?? u.rescuing ?? null,
      get stat_cap_modifiers() {
        return memo('stat_cap_modifiers', () => wrapMapping(u.statCapModifiers ?? u.stat_cap_modifiers));
      },
      get strike_partner() {
        return wrapUnit(u.strikePartner ?? u.strike_partner ?? null);
      },
      dead: u.isDead?.() ?? u.dead ?? false,
      _finished: u._finished ?? false,
      is_dying: u.isDying ?? u.is_dying ?? false,
      level: u.level,
      get stats() { return memo('stats', () => wrapMapping(u.stats)); },
      get wexp() { return memo('wexp', () => wrapMapping(u.wexp)); },
      get growths() { return memo('growths', () => wrapMapping(u.growths)); },
      generic: u.generic ?? false,
      get skills() { return memo('skills', () => (u.skills ?? []).map(wrapSkill)); },
      get items() { return memo('items', () => (u.items ?? []).map(wrapItem)); },
      // UnitObject.accessories is a property in Python, so do not resolve
      // every item's skill overrides merely to wrap a unit. Besides wasting
      // work for expressions that never read accessories, eager resolution
      // can recursively rebuild the entire game.units expression scope.
      get accessories() {
        return (u.items ?? []).filter((candidate: any) =>
          candidate.hasComponent?.('accessory') ||
          candidate.hasComponent?.('equippable_accessory')).map(wrapItem);
      },
      current_hp: u.currentHp ?? u.current_hp,
      // Max HP runs every stat skill's condition; most expressions never
      // read it, so resolve it (once) on first access.
      get max_hp() { return memo('max_hp', () => u.maxHp ?? u.max_hp); },
      get_hp: () => u.currentHp ?? u.current_hp ?? 0,
      get_max_hp: () => u.getMaxHp?.() ?? u.maxHp ?? u.max_hp ?? u.stats?.HP ?? 0,
      get_stat: (nid: string) =>
        u.getStat?.(nid) ?? u.getStatValue?.(nid) ?? u.stats?.[nid] ?? 0,
      get_internal_level: () => getInternalLevel(u, game.db),
      get_field: (nid: string, fallback?: any) =>
        u.fields?.has?.(nid) ? u.fields.get(nid) : (fallback ?? null),
      // Python UnitObject attributes EOtF reads in event expressions
      // (e.g. `table;portrait;u('Ophie').portrait_nid;...;expression`).
      get portrait_nid() {
        return u.generic ? null : (u.portraitNid ?? u.portrait_nid ?? null);
      },
      get party() { return u.party ?? null; },
      get ai() { return u.ai ?? null; },
      get faction() { return u.faction ?? null; },
      get persistent() { return !!u.persistent; },
      get exp() { return u.exp ?? 0; },
      get _has_attacked() { return !!(u.hasAttacked ?? u._has_attacked); },
      get _has_traded() { return !!(u.hasTraded ?? u._has_traded); },
      get _has_moved() { return !!(u.hasMoved ?? u._has_moved); },
      get_mana: () => u.currentMana ?? u.current_mana ?? 0,
      // Python get_skill: the most recently added skill matching nid or uid.
      get_skill: (nid: any) => {
        const skills = [...(u.skills ?? [])].reverse();
        return wrapSkill(skills.find((skill: any) =>
          skill.nid === nid || String(skill.uid) === String(nid)) ?? null);
      },
      get_weapon: () => wrapItem(u.getWeapon?.() ?? u.equippedWeapon ?? null),
      get_accessory: () => wrapItem(u.getAccessory?.() ?? u.equippedAccessory ?? null),
      check_flanking: checkFlanking,
      variant: u.variant ?? null,
      desc: u.desc ?? null,
    };
    // Python UnitObject.__getattr__ falls back to the unit prefab, so authored
    // expressions read arbitrary data fields. Mirror that for plain values:
    // snake_case -> camelCase runtime field, then the DB prefab.
    const proxied = new Proxy(wrapped as Record<string, any>, {
      get(target, property: string | symbol) {
        if (typeof property !== 'string' || property in target) return target[property as string];
        const camel = property.replace(/_([a-z0-9])/g, (_m: string, c: string) => c.toUpperCase());
        for (const key of [camel, property]) {
          const value = u[key];
          if (value !== undefined && typeof value !== 'function') return value;
        }
        const prefab = game.db?.units?.get?.(u.nid);
        const fromPrefab = prefab?.[property];
        return typeof fromPrefab === 'function' ? undefined : fromPrefab;
      },
    });
    wrappedUnits.set(u, proxied);
    return proxied;
  }

  function isDeadOrDying(unit: any): boolean {
    return !!(unit?.isDead?.() ?? unit?.dead) || !!(unit?.isDying ?? unit?.is_dying);
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

  // Build the game proxy object
  const regions = game.currentLevel?.regions ?? [];
  const wrapVars = (variables: Map<string, any> | undefined) => new Proxy(
    {
      get(key: string, fallback?: any) {
        return variables?.has(key) ? variables.get(key) : (fallback ?? null);
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
    get regions() {
      return regions.map(wrapRegion);
    },
    game_vars: wrapVars(game.gameVars),
    level_vars: wrapVars(game.levelVars),
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
    level: {
      regions: wrapRegions(regions),
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
      return getAllUnits(true);
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
  };

  gameProxy._current_level = gameProxy.level;
  const unwrapUnit = (candidate: any) => {
    if (typeof candidate === 'string') return game.units?.get(candidate) ?? null;
    return candidate?._raw ?? game.units?.get(candidate?.nid) ?? candidate;
  };
  const unwrapItem = (candidate: any) => candidate?._raw ?? candidate;
  const itemSystem = {
    available(candidate: any, candidateItem: any) {
      const rawUnit = unwrapUnit(candidate);
      const rawItem = unwrapItem(candidateItem);
      if (!rawUnit || !rawItem || !registeredItemEvaluators().available) return false;
      return registeredItemEvaluators().available(rawUnit, rawItem, game.db, game);
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
      const entries = registeredItemEvaluators().componentEntries
        ? registeredItemEvaluators().componentEntries(rawUnit, rawItem, game.db, game)
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
    hidden(candidate: any) {
      const raw = candidate?._raw ?? candidate;
      return componentValue(raw, 'hidden') !== undefined;
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
      if (property === 'classes') return wrapCatalog(target.classes, wrapClass);
      if (property === 'units') return wrapCatalog(target.units, wrapUnit);
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
  return {
    game: gameProxy,
    wrapUnit,
    wrapItem,
    wrapSkill,
    wrapClass,
    DB: databaseProxy,
    RECORDS: recordsProxy,
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
    unit_funcs: unitFuncs,
    combat_calcs: {
      compute_advantage: computeAdvantage,
      can_counterattack(
        attacker: any,
        attackItem: any,
        defender: any,
        _defenseItem?: any,
      ) {
        const rawAttacker = unwrapUnit(attacker);
        const rawDefender = unwrapUnit(defender);
        const rawAttackItem = unwrapItem(attackItem);
        return !!rawAttacker && !!rawDefender && !!rawAttackItem &&
          canCounterattack(rawAttacker, rawAttackItem, rawDefender, game.db, game);
      },
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
}

/**
 * Attempt to evaluate a Python condition using JavaScript Function().
 * Translates common Python idioms to JS before eval.
 * Returns the evaluation result, or undefined if it fails.
 */
/**
 * Compiled expression cache.
 *
 * The generated function body depends only on the translated source and the
 * declared local names — every piece of game state arrives as an argument. So
 * a given expression compiles once and is reused for the life of the page.
 * Without this, EotF recompiles the same skill conditions many times per
 * frame, which measured as the single largest cost in the game loop.
 */
const compiledExpressions = new Map<string, Function>();

/** Cache of the Python-to-JavaScript translation, keyed by source text. */
const translatedExpressions = new Map<string, string>();

/** Lazily-built, reused query-function dictionary (see call site). */
let queryFuncsCache: Record<string, Function> | null = null;
function sharedQueryFuncs(): Record<string, Function> {
  return (queryFuncsCache ??= new GameQueryEngine().getFuncDict());
}

/**
 * Translate one Python expression into JavaScript source.
 *
 * Pure string rewriting: the result depends only on `condition`, which is
 * what makes both this and the compiled function safe to cache.
 */
function translateExpression(condition: string): string {
  // Translate Python idioms to JavaScript
  let jsExpr = condition.trim().replace(/^if\s+/, '');
  const tupleSource = jsExpr.trim();
  if (tupleSource.startsWith('(') &&
      findMatchingParen(tupleSource, 0) === tupleSource.length - 1) {
    const tupleParts = splitAtTopLevel(tupleSource.slice(1, -1), ',')
      .map((part) => part.trim())
      .filter(Boolean);
    if (tupleParts.length > 1) jsExpr = `[${tupleParts.join(', ')}]`;
    else if (tupleParts.length === 1) jsExpr = tupleParts[0];
  }
  const joinMatch = jsExpr.match(/^('[^']*'|"[^"]*")\.join\(([\s\S]*)\)$/);
  if (joinMatch) jsExpr = `(${joinMatch[2]}).join(${joinMatch[1]})`;
  jsExpr = jsExpr.replace(/\bf"([^"]*)"/g, (_whole, content) =>
    `\`${content.replace(/\{/g, '${')}\``);
  jsExpr = jsExpr.replace(/\bf'([^']*)'/g, (_whole, content) =>
    `\`${content.replace(/\{/g, '${')}\``);
  jsExpr = translateListComprehensions(jsExpr);
  jsExpr = translateSortedCalls(jsExpr);
  jsExpr = translateFloorDivision(translateGeneratorExpressions(jsExpr));
  jsExpr = translatePyIndexCalls(jsExpr);
  jsExpr = jsExpr.replace(
    /(\b[A-Za-z_]\w*(?:\([^)]*\)|(?:\.[A-Za-z_]\w*)|\[[^\]]+\])*)\[-(\d+)\]/g,
    '$1.at(-$2)',
  );

  // Python `len(x)` -> `x.length`
  jsExpr = jsExpr.replace(/\blen\s*\(/g, '__len__(');
  jsExpr = jsExpr.replace(/\.startswith\s*\(/g, '.startsWith(');
  jsExpr = jsExpr.replace(/\.endswith\s*\(/g, '.endsWith(');

  // Python `True`/`False` -> `true`/`false`
  jsExpr = replacePythonWords(jsExpr, {
    True: 'true',
    False: 'false',
    None: 'null',
  });
  jsExpr = jsExpr.replace(/\bis\s+not\b/g, '!==');
  jsExpr = jsExpr.replace(/\bis\b/g, '===');
  // Python gives comparisons higher precedence than `not`; JavaScript gives
  // unary `!` higher precedence. Preserve `not value == other` as
  // `!(value == other)` before translating remaining boolean operators.
  jsExpr = jsExpr.replace(
    /\bnot\s+([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\s*(===|==|!==|!=)\s*('[^']*'|"[^"]*"|[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*|\d+(?:\.\d+)?)/g,
    '!($1 $2 $3)',
  );
  // Python keyword arguments used by EotF query helpers.
  jsExpr = translateQueryKwargs(jsExpr);
  jsExpr = jsExpr.replace(
    /\bteam\s*=\s*(['"][^'"]+['"])/g,
    '{ team: $1 }',
  );
  jsExpr = jsExpr.replace(
    /\btag\s*=\s*(['"][^'"]+['"])/g,
    '{ tag: $1 }',
  );
  jsExpr = jsExpr.replace(/\bdist\s*=\s*(\d+)/g, '$1');
  jsExpr = jsExpr.replace(/\bsource_type\s*=/g, '');
  jsExpr = jsExpr.replace(/\bsource\s*=/g, '');
  jsExpr = jsExpr.replace(
    /v\('unit\.nid \+ '([^']+)''\)/g,
    "v(unit.nid + '$1')",
  );
  jsExpr = jsExpr.replace(/\bforce\s*=\s*(true|false)/g, '$1');
  jsExpr = jsExpr.replace(/\.stats\s*\(\s*([^)]*)\)/g, '.stats.get($1)');

  // Python `and`/`or`/`not` -> `&&`/`||`/`!`
  jsExpr = replacePythonWords(jsExpr, {
    and: '&&',
    or: '||',
    not: '!',
  });

  // Python membership inside translated comprehensions/generators. Direct
  // top-level membership is handled by evaluateCondition before this fallback.
  jsExpr = jsExpr.replace(
    /((?:'[^']*'|"[^"]*"|\d+(?:\.\d+)?|[A-Za-z_]\w*))\s+(!\s*)?in\s+(u\(v\([^)]*\)\)\.[A-Za-z_]\w*)/g,
    (_whole, needle, negated, haystack) =>
      `${negated ? '!' : ''}(${haystack}).includes(${needle})`,
  );
  jsExpr = translatePyMembership(jsExpr);
  jsExpr = translateConditionalExpressions(jsExpr);
  jsExpr = jsExpr.replace(
    /((?:'[^']*'|"[^"]*"))\.join\s*\((.+)\)$/,
    '($2).join($1)',
  );
  jsExpr = jsExpr.replace(
    /((?:'[^']*'|"[^"]*"))\s*%\s*([A-Za-z_]\w*(?:\.\w+)*)/g,
    '__pyFormat($1, $2)',
  );
  // Python concatenates lists with `+`; JavaScript coerces them to strings.
  // EOtF uses this form heavily when extending persistent record lists.
  jsExpr = jsExpr.replace(
    /(RECORDS\.get\([^)]*\))\s*\+\s*(\[[^\]]*\])/g,
    '__pyAdd($1, $2)',
  );
  jsExpr = translateTopLevelAdditions(jsExpr);
  return jsExpr;
}

function evaluateWithJsFallback(
  condition: string,
  ctx: ConditionContext,
  warnOnFailure = true,
): any {
  const game = ctx.game;
  lastJsEvaluationFailed = true;
  if (!game) return undefined;

  const cachedTranslation = translatedExpressions.get(condition);
  let jsExpr: string;
  if (cachedTranslation === undefined) {
    jsExpr = translateExpression(condition);
    translatedExpressions.set(condition, jsExpr);
  } else {
    jsExpr = cachedTranslation;
  }

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
  const compareSortKeys = (left: any, right: any): number => {
    if (Array.isArray(left) && Array.isArray(right)) {
      const length = Math.max(left.length, right.length);
      for (let index = 0; index < length; index++) {
        const compared = compareSortKeys(left[index], right[index]);
        if (compared !== 0) return compared;
      }
      return 0;
    }
    if (left === right) return 0;
    if (left === undefined || left === null) return -1;
    if (right === undefined || right === null) return 1;
    return left < right ? -1 : 1;
  };
  const __sorted__ = (
    values: Iterable<any> | undefined,
    key: (value: any) => any = (value) => value,
    reverse = false,
  ) => Array.from(values ?? [])
    .map((value, index) => ({ value, index, key: key(value) }))
    .sort((left, right) => {
      const compared = compareSortKeys(left.key, right.key);
      return compared === 0
        ? left.index - right.index
        : (reverse ? -compared : compared);
    })
    .map((entry) => entry.value);

  // v() helper: level vars take priority over game vars
  const v = (varName: string, fallback?: any) => {
    // Python QueryEngine.v: a level var holding None falls through.
    const levelValue = ctx.levelVars?.get(varName);
    if (levelValue !== undefined && levelValue !== null) return levelValue;
    if (ctx.gameVars?.has(varName)) return ctx.gameVars.get(varName);
    return fallback ?? 0;
  };

  // cf proxy (just for cf.SETTINGS['debug'])
  const cf = { SETTINGS: { debug: false } };

  // Wrap unit/region from context
  const expressionUnit = ctx.localArgs?.has('unit')
    ? ctx.localArgs.get('unit')
    : unit1;
  const unit = evalScope.wrapUnit?.(expressionUnit?._raw ?? expressionUnit) ?? null;
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
  const extremum = (
    fn: (...values: number[]) => number,
    values: any[],
  ): number => {
    const source = values.length === 1 &&
      values[0] != null &&
      typeof values[0] !== 'number' &&
      typeof values[0][Symbol.iterator] === 'function'
      ? Array.from(values[0])
      : values;
    return fn(...source.map(Number));
  };
  const max = (...values: any[]) => extremum(Math.max, values);
  const min = (...values: any[]) => extremum(Math.min, values);
  const sum = (values: Iterable<any> | undefined) =>
    Array.from(values ?? []).reduce((total, value) => total + Number(value), 0);
  const math = {
    floor: Math.floor,
    ceil: Math.ceil,
    sqrt: Math.sqrt,
  };
  const int = (value: any) => Math.trunc(Number(value));
  const set = (values: Iterable<any> | undefined) => new Set(values ?? []);
  const str = (value: any) => String(value);
  const pyFormat = (template: string, value: any) => {
    const values = Array.isArray(value) ? [...value] : [value];
    let index = 0;
    return String(template).replace(/%[sdr]/g, (token) => {
      const candidate = values[index++];
      if (token === '%d') return String(Math.trunc(Number(candidate)));
      if (token === '%r') return JSON.stringify(candidate?._raw ?? candidate);
      return String(candidate?._raw ?? candidate);
    });
  };
  const pyAdd = (left: any, right: any) =>
    Array.isArray(left) && Array.isArray(right)
      ? [...left, ...right]
      : left + right;
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
  // EOtF fork get_charge: the last instance with a truthy charge.
  const get_charge = (candidate: any, skillNid: string) =>
    sharedQueryFuncs().get_charge(candidate, skillNid);
  const evaluate = (
    expression: unknown,
    candidate?: any,
    candidateTarget?: any,
    candidatePosition?: [number, number] | null,
  ) => legacyEvaluateExpression(String(expression ?? '0'), {
    game,
    unit1: candidate?._raw ?? candidate ?? unit1,
    unit2: candidateTarget?._raw ?? candidateTarget ?? unit2,
    item: ctx.item,
    position: candidatePosition ?? ctx.position,
    gameVars: ctx.gameVars,
    levelVars: ctx.levelVars,
    localArgs: ctx.localArgs,
  });
  const action = {
    RemoveSkill(
      candidate: any,
      skillNid: string,
      source?: any,
      sourceType?: string,
    ) {
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
      if (candidate) game.actionLog?.doAction?.(candidate);
      return null;
    },
  };
  const SourceType = { TRAVELER: 'traveler' };

  // Also inject support_rank_nid from localArgs
  const support_rank_nid = ctx.localArgs?.get('support_rank_nid') ?? null;
  const expressionLocals = new Map(ctx.localArgs ?? []);
  const wrapExpressionLocal = (value: any): any => {
    if (!value || typeof value !== 'object' || value._raw) return value;
    if (Array.isArray(value)) return value.map(wrapExpressionLocal);
    if (value.components instanceof Map && value.data instanceof Map) {
      if ('uses' in value && 'subitems' in value) return evalScope.wrapItem(value);
      if ('uid' in value && 'ownerNid' in value) return evalScope.wrapSkill(value);
    }
    if ('team' in value && 'items' in value && 'stats' in value) {
      return evalScope.wrapUnit(value);
    }
    return value;
  };
  for (const [name, value] of expressionLocals) {
    expressionLocals.set(name, wrapExpressionLocal(value));
  }
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

  // Inject query engine functions (u, v, get_item, has_item, is_dead, etc.).
  // The engine holds no state — every method resolves the live game when it
  // runs — so the instance and its function dictionary are built once instead
  // of on every expression evaluation.
  const _queryFuncs = sharedQueryFuncs();

  const compileKey = `${localDeclarations}\u0000${jsExpr}`;
  const alreadyCompiled = compiledExpressions.get(compileKey);

  try {
    // eslint-disable-next-line no-new-func
    const fn = alreadyCompiled ?? new Function(
      'game', 'unit', 'unit1', 'unit2', 'target', 'region', 'position', 'target_pos', 'item',
      'check_pair', 'check_default', '__len__', '__any__', '__all__', '__sorted__', 'v', 'cf',
      'support_rank_nid', 'mode', 'stat_changes', 'DB', 'RECORDS', 'utils', 'item_funcs',
      'item_system', 'skill_system', 'unit_funcs', 'combat_calcs', 'movement_funcs', 'target_system',
      'max', 'min', 'sum', 'math', 'int', 'set', 'str', 'range', 'get_stacks', 'get_charge',
      '__pyFormat', '__pyAdd', 'static_random', 'evaluate', '_qf', '_locals',
      '_wrapUnit', '_wrapItem', '_wrapSkill', '_wrapClass', 'action', 'SourceType',
      `"use strict";
       ${localDeclarations}
       var __pyIn = (x, seq) => {
         if (seq == null) return false;
         if (typeof seq === 'string') return seq.includes(x);
         if (Array.isArray(seq)) return seq.includes(x);
         if (seq instanceof Set || seq instanceof Map) return seq.has(x);
         if (typeof seq[Symbol.iterator] === 'function') return Array.from(seq).includes(x);
         if (typeof seq.has === 'function') return !!seq.has(x);
         return Object.prototype.hasOwnProperty.call(seq, x);
       };
       var __pyIndex = (seq, x) => {
         const i = seq == null ? -1 : seq.indexOf(x);
         if (i < 0) throw new Error('ValueError: ' + String(x) + ' is not in list');
         return i;
       };
       // Spread query engine functions into local scope
       var _units = values => Array.from(values || []).map(_wrapUnit),
           u = (...args) => _wrapUnit(_qf.u(...args)),
           get_item = (...args) => _wrapItem(_qf.get_item(...args)),
           find_item = (...args) => _wrapItem(_qf.find_item(...args)),
           has_item = _qf.has_item,
           get_subitem = (...args) => _wrapItem(_qf.get_subitem(...args)),
           get_skill = (...args) => _wrapSkill(_qf.get_skill(...args)),
           has_skill = _qf.has_skill,
           get_klass = (...args) => _wrapClass(_qf.get_klass(...args)),
           get_class = (...args) => _wrapClass(_qf.get_class(...args)),
           get_closest_allies = (...args) => Array.from(_qf.get_closest_allies(...args) || [])
             .map(pair => [_wrapUnit(pair[0]), pair[1]]),
           get_closest_units = (...args) => Array.from(_qf.get_closest_units(...args) || [])
             .map(pair => [_wrapUnit(pair[0]), pair[1]]),
           get_closest_enemies = (...args) => Array.from(_qf.get_closest_enemies(...args) || [])
             .map(pair => [_wrapUnit(pair[0]), pair[1]]),
           get_units_within_distance = (...args) => _units(_qf.get_units_within_distance(...args)),
           get_allies_within_distance = (...args) => _units(_qf.get_allies_within_distance(...args)),
           get_units_in_area = (...args) => _units(_qf.get_units_in_area(...args)),
           get_debuff_count = _qf.get_debuff_count,
           get_total_charge = _qf.get_total_charge, check_pivot = _qf.check_pivot,
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
    if (!alreadyCompiled) compiledExpressions.set(compileKey, fn);
    const result = fn(
      gameProxy, unit, unit, target, target, region, position, target_pos, item,
      check_pair, check_default, __len__, __any__, __all__, __sorted__, v, cf,
      support_rank_nid, mode, stat_changes, evalScope.DB, evalScope.RECORDS, evalScope.utils,
      evalScope.item_funcs, evalScope.item_system, evalScope.skill_system, evalScope.unit_funcs,
      evalScope.combat_calcs, evalScope.movement_funcs, evalScope.target_system,
      max, min, sum, math, int, set, str, range, get_stacks, get_charge,
      pyFormat, pyAdd, { get_random_choice: gameProxy.get_random_choice }, evaluate,
      _queryFuncs, expressionLocals,
      evalScope.wrapUnit, evalScope.wrapItem, evalScope.wrapSkill, evalScope.wrapClass,
      action, SourceType,
    );
    lastJsEvaluationFailed = false;
    return result;
  } catch (e) {
    // Expression evaluation failed — log the error for debugging
    if (warnOnFailure) {
      console.warn(
        `EventCondition JS eval failed for "${condition}" as "${jsExpr}":`,
        e,
      );
    }
    return undefined;
  }
}


// ============================================================
// TEMPORARY: the regex equation translator from combat-calcs.ts
// ============================================================
const STAT_NAMES = ['HP', 'STR', 'MAG', 'SKL', 'SPD', 'LCK', 'DEF', 'RES', 'CON', 'MOV'];
type EquationContext = { unit2?: any; item?: any; db?: any };
type Database = any;
type UnitObject = any;
/**
 * Rewrite every Python floor-division `//` into `Math.floor((L)/(R))`.
 *
 * Operates on the post-substitution expression where stat tokens and
 * equation nids have already been replaced by numeric literals. For each
 * `//` occurrence the left operand is found by walking back over a balanced
 * parenthesised group, identifier, or numeric literal; the right operand
 * symmetrically walks forward. Repeats until no `//` remains.
 *
 * The previous regex `/(\b[\d.]+)\s*\/\/\s*([\d.]+\b)/g` only matched numeric
 * literals on both sides, so any compound left operand such as `(HP - 10)//2`
 * survived untouched and the trailing `//...` parsed as a JS line comment,
 * silently truncating the expression (broke `RATING`, `MAGIC_RANGE`, etc.).
 */
function rewriteFloorDiv(expr: string): string {
  let out = expr;
  for (let iter = 0; iter < 1024; iter++) {
    const idx = out.indexOf('//');
    if (idx === -1) break;

    // --- Walk back over the left operand ---
    let i = idx - 1;
    while (i >= 0 && (out[i] === ' ' || out[i] === '\t' || out[i] === '\n')) i--;
    let leftStart: number;
    if (i >= 0 && out[i] === ')') {
      let depth = 1;
      i--;
      while (i >= 0 && depth > 0) {
        if (out[i] === ')') depth++;
        else if (out[i] === '(') depth--;
        if (depth === 0) break;
        i--;
      }
      leftStart = i;
    } else {
      while (i >= 0 && /[A-Za-z0-9_.]/.test(out[i])) i--;
      leftStart = i + 1;
    }

    // --- Walk forward over the right operand ---
    let j = idx + 2;
    while (j < out.length && (out[j] === ' ' || out[j] === '\t' || out[j] === '\n')) j++;
    let rightEnd: number;
    if (j < out.length && out[j] === '(') {
      let depth = 1;
      j++;
      while (j < out.length && depth > 0) {
        if (out[j] === '(') depth++;
        else if (out[j] === ')') depth--;
        if (depth === 0) break;
        j++;
      }
      rightEnd = j + 1;
    } else {
      while (j < out.length && /[A-Za-z0-9_.]/.test(out[j])) j++;
      rightEnd = j;
    }

    if (leftStart >= idx || rightEnd <= idx + 2) {
      // Malformed — bail to avoid an infinite loop.
      return out;
    }
    const left = out.slice(leftStart, idx).trim();
    const right = out.slice(idx + 2, rightEnd).trim();
    const replacement = `Math.floor((${left})/(${right}))`;
    out = out.slice(0, leftStart) + replacement + out.slice(rightEnd);
  }
  return out;
}

/** Python truthiness for the condition-eval path. */
function _pythonTruthy(val: unknown): boolean {
  if (typeof val === 'boolean') return val;
  if (typeof val === 'number') return val !== 0 && Number.isFinite(val);
  if (typeof val === 'string') return val.length > 0;
  if (val === null || val === undefined) return false;
  if (Array.isArray(val)) return val.length > 0;
  return true;
}

/** Replace named equation references with their recursively-evaluated values. */
function _substituteEquationNids(
  processed: string,
  unit: UnitObject,
  ctx: EquationContext | undefined,
  db: Database | null,
  originalExpr: string,
): string {
  if (!db) return processed;
  const eqNames = db.getEquationNames?.() ?? [];
  // Sort longest-first to avoid partial matches
  const sortedEqs = [...eqNames].sort((a, b) => b.length - a.length);
  for (const eqName of sortedEqs) {
    // Don't replace stat names — those are handled by stat substitution
    if (STAT_NAMES.includes(eqName)) continue;
    const re = new RegExp(`\\b${eqName}\\b`, 'g');
    if (re.test(processed)) {
      // Avoid infinite recursion: only resolve if the equation differs
      const eqExpr = db.getEquation(eqName);
      if (eqExpr && eqExpr !== originalExpr) {
        const eqValue = legacyEvaluateEquation(eqExpr, unit, ctx);
        processed = processed.replace(re, String(eqValue));
      }
    }
  }
  return processed;
}

/** Replace stat tokens, unit.X accessors, and DB.constants.value(...) calls. */
function _substituteStatsAndUnit(
  processed: string,
  unit: UnitObject,
  db: Database | null,
): string {
  const sortedStats = [...STAT_NAMES].sort((a, b) => b.length - a.length);
  for (const stat of sortedStats) {
    const re = new RegExp(`\\b${stat}\\b`, 'g');
    processed = processed.replace(re, String(unit.getStatValue(stat)));
  }

  processed = processed.replace(/\bunit\.level\b/g, String(unit.level));
  processed = processed.replace(/\bunit\.klass\b/g, `"${unit.klass}"`);
  processed = processed.replace(
    /\bunit\.get_internal_level\s*\(\s*\)/g,
    String(_getInternalLevel(unit, db)),
  );

  if (db) {
    processed = processed.replace(
      /\bDB\.constants\.value\s*\(\s*['"](.+?)['"]\s*\)/g,
      (_m, constName) => {
        const val = db.getConstant(constName, 0);
        return typeof val === 'number' ? String(val) : `"${val}"`;
      },
    );
  }
  return processed;
}

/** Wrap bare Python builtins (max/min/abs/int/float) with JS equivalents. */
function _wrapBuiltins(processed: string): string {
  processed = processed.replace(/(?<!Math\.)(?<![\w.])\bmax\b/g, 'Math.max');
  processed = processed.replace(/(?<!Math\.)(?<![\w.])\bmin\b/g, 'Math.min');
  processed = processed.replace(/(?<!Math\.)(?<![\w.])\babs\b/g, 'Math.abs');
  // Python int() -> Math.floor()
  processed = processed.replace(/(?<![\w.])\bint\s*\(/g, 'Math.floor(');
  // Python float() -> Number()
  processed = processed.replace(/(?<![\w.])\bfloat\s*\(/g, 'Number(');
  return processed;
}

/**
 * Evaluate an equation string with stat substitution and extended context.
 *
 * Supports:
 *   - Stat token substitution: HP, STR, MAG, ... → unit stat values
 *   - Python ternary: `X if COND else Y`
 *   - Python integer division: `a // b` → `Math.floor(a/b)`
 *   - Named equation references: equation names → recursive evaluation
 *   - `max()`, `min()`, `abs()`, `int()`, `float()` builtins
 *   - `unit.level`, `unit.klass`, `unit.get_internal_level()` access
 *   - `clamp(value, lo, hi)` utility
 *   - Game constants via `DB.constants.value('name')` pattern
 */
export function legacyEvaluateEquation(
  expr: string,
  unit: UnitObject,
  ctx?: EquationContext,
): number {
  let processed = expr;

  // Handle Python ternary: "X if COND else Y" -> JS ternary
  const ternaryRe = /^(.+?)\s+if\s+(.+?)\s+else\s+(.+)$/;
  const ternaryMatch = processed.match(ternaryRe);
  if (ternaryMatch) {
    const valueExpr = ternaryMatch[1].trim();
    const condExpr = ternaryMatch[2].trim();
    const elseExpr = ternaryMatch[3].trim();

    const condResult = legacyEvaluateEquationCondition(condExpr, unit, ctx);
    return condResult
      ? legacyEvaluateEquation(valueExpr, unit, ctx)
      : legacyEvaluateEquation(elseExpr, unit, ctx);
  }

  // Resolve the database for equation lookups
  const db = ctx?.db ?? ((null as any)?.db as Database | undefined) ?? null;

  // Replace named equation references FIRST (before stat substitution)
  // so that e.g. HIT (equation) doesn't collide with HIT (stat if it existed).
  processed = _substituteEquationNids(processed, unit, ctx, db, expr);

  // Replace stat tokens, unit.X accessors, and DB.constants.value(...) calls
  processed = _substituteStatsAndUnit(processed, unit, db);

  // Convert Python-style integer division `//` to Math.floor.
  // Operand-aware: any `//` whose operands are parenthesised groups,
  // identifiers, or numeric literals is rewritten. The previous regex
  // `/(\b[\d.]+)\s*\/\/\s*([\d.]+\b)/g` only matched numeric literals on
  // both sides, so `(HP - 10)//2` survived and the rest of the expression
  // became a JS line comment, silently truncating it.
  processed = rewriteFloorDiv(processed);

  // Wrap bare max/min/abs/int/float with Math/JS equivalents
  processed = _wrapBuiltins(processed);

  try {
    // Build evaluation context with clamp utility and math
    const clamp = (val: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, val));
    const fn = new Function(
      'Math', 'clamp',
      `"use strict"; return (${processed});`,
    );
    const result = fn(Math, clamp);
    return typeof result === 'number' && Number.isFinite(result)
      ? Math.floor(result)
      : 0;
  } catch {
    console.warn(`CombatCalcs: failed to evaluate equation "${expr}" -> "${processed}"`);
    return 0;
  }
}

/** Helper: compute a unit's internal level (accounting for promotion tiers). */
function _getInternalLevel(unit: UnitObject, db: Database | null): number {
  if (!db) return unit.level;
  const klassDef = db.classes?.get(unit.klass);
  if (!klassDef) return unit.level;
  const tier = klassDef.tier ?? 0;
  if (tier > 0) {
    // For promoted classes, add the max level of the base (unpromoted) tier
    const maxLevel = db.getConstant('max_level', 20) as number;
    return unit.level + maxLevel * tier;
  }
  return unit.level;
}

/**
 * Evaluate a condition within an equation expression.
 *
 * Handles Python condition forms used in default-project equation ternaries:
 *   - Boolean literals (`True` / `False`)
 *   - `'Tag' in unit.tags` / `'Tag' not in unit.tags` (also inside compounds)
 *   - `unit.klass == 'ClassName'` and any `==`/`!=`/`>=`/`<=`/`>`/`<` comparison
 *   - Python logical operators `and` / `or` / `not` (word-boundary rewrite to
 *     `&&` / `||` / `!`; identifiers containing these substrings are untouched)
 *   - Python truthiness for the ternary path (0/'' /empty array → false)
 *
 * The expression is rewritten to JS with the same substitutions as
 * `evaluateEquation` (equation nids, stat tokens, unit.X, DB.constants,
 * floor-div, builtins) and evaluated via `new Function`. Unknown conditions
 * fall back to `true` to preserve prior behaviour.
 */
export function legacyEvaluateEquationCondition(
  cond: string,
  unit: UnitObject,
  ctx?: EquationContext,
): boolean {
  const trimmed = cond.trim();

  // Boolean literals
  if (trimmed === 'True' || trimmed === 'true') return true;
  if (trimmed === 'False' || trimmed === 'false') return false;

  const db = ctx?.db ?? ((null as any)?.db as Database | undefined) ?? null;

  let processed = trimmed;

  // Replace tag-membership forms with boolean literals. Handle `not in`
  // before `in` so the `not in` form isn't partially consumed. Non-anchored
  // so compound conditions like `'Mounted' in unit.tags and LCK > 3` work.
  processed = processed.replace(
    /['"]([^'"]+)['"]\s+not\s+in\s+unit\.tags/g,
    (_m, tag) => `(${!skillSystem.unitHasTag(unit, tag)})`,
  );
  processed = processed.replace(
    /['"]([^'"]+)['"]\s+in\s+unit\.tags/g,
    (_m, tag) => `(${skillSystem.unitHasTag(unit, tag)})`,
  );

  // Shared substitutions: equation nids, stat tokens, unit.X, DB.constants.
  processed = _substituteEquationNids(processed, unit, ctx, db, trimmed);
  processed = _substituteStatsAndUnit(processed, unit, db);
  processed = rewriteFloorDiv(processed);
  processed = _wrapBuiltins(processed);

  // Python logical operators → JS. `\b` ensures we never touch identifiers
  // that merely contain these substrings (e.g. `bandana`, `format`, `door`).
  // Apply after builtin wrapping so `Math.floor` (contains `or`) is already
  // in place — though `\bor\b` would not match inside it anyway because `_`
  // and letters are word chars with no boundary between them.
  processed = processed.replace(/\bTrue\b/g, 'true');
  processed = processed.replace(/\bFalse\b/g, 'false');
  processed = processed.replace(/\band\b/g, '&&');
  processed = processed.replace(/\bor\b/g, '||');
  processed = processed.replace(/\bnot\b/g, '!');

  try {
    const clamp = (val: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, val));
    const fn = new Function(
      'Math', 'clamp',
      `"use strict"; return (${processed});`,
    );
    const result = fn(Math, clamp);
    return _pythonTruthy(result);
  } catch {
    console.warn(`CombatCalcs: unknown equation condition "${cond}" -> "${processed}"`);
    return true;
  }
}

