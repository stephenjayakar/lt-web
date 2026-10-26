/**
 * python-events.ts -- PYEV1 Python-syntax event script processor.
 *
 * PYEV1 is an alternative event format used in Lex Talionis that looks like
 * Python code. Lines prefixed with `$` are event commands; everything else is
 * Python-like flow control (if/elif/else, for, while) and variable assignment.
 *
 * Since we can't run Python in the browser, this module implements a
 * line-by-line interpreter that:
 *   1. Parses indentation-based block structure
 *   2. Handles if/elif/else/for/while natively
 *   3. Extracts `$command` lines into EventCommand objects
 *   4. Evaluates Python-like expressions via Function() with a game context
 *
 * Exports: isPyev1, PythonEventProcessor, tokenizePyevLine
 */

import type { EventCommand, EventCommandType } from './event-manager';
import { evaluatePython, pyBinary, pyBool, pyRepr, scopeFromRecord, toArray, toHostValue } from './py-expr';

// ============================================================
// Detection
// ============================================================

/**
 * Check if an event source is PYEV1 format.
 * PYEV1 scripts start with '#pyev1' on the first line.
 */
export function isPyev1(source: string[]): boolean {
  return source.length > 0 && source[0].trim() === '#pyev1';
}

// ============================================================
// Parsed line types
// ============================================================

type PyLineType =
  | 'command'
  | 'if'
  | 'elif'
  | 'else'
  | 'for'
  | 'while'
  | 'assign'
  | 'augassign'
  | 'return'
  | 'comment'
  | 'blank'
  | 'expr';

interface PyLine {
  indent: number;        // Indentation level (leading spaces / 4, floored)
  raw: string;           // Original line text (trimmed)
  type: PyLineType;
  // For 'command': the parsed EventCommand
  command?: EventCommand;
  // For 'if'/'elif'/'while': the condition expression
  condition?: string;
  // For 'for': loop variable name and iterable expression
  forVar?: string;
  forIterable?: string;
  // For 'assign': target variable name and value expression
  assignTarget?: string;
  assignValue?: string;
  assignOperator?: '+=' | '-=';
}

type PyevExpressionEvaluator = (
  expression: string,
  game: any,
  localVars: Map<string, any>,
) => any;

let pyevExpressionEvaluator: PyevExpressionEvaluator | null = null;

/** Registered by event-manager so PYEV1 shares the full event expression surface. */
export function setPyevExpressionEvaluator(evaluator: PyevExpressionEvaluator): void {
  pyevExpressionEvaluator = evaluator;
}

function splitPyevArguments(source: string): string[] {
  const result: string[] = [];
  let start = 0;
  let quote: string | null = null;
  let depth = 0;
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (quote) {
      if (char === quote && source[index - 1] !== '\\') quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
    } else if ('([{'.includes(char)) {
      depth++;
    } else if (')]}'.includes(char)) {
      depth--;
    } else if (char === ',' && depth === 0) {
      result.push(source.slice(start, index).trim());
      start = index + 1;
    }
  }
  const tail = source.slice(start).trim();
  if (tail) result.push(tail);
  return result;
}

function matchingParen(source: string, opening: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let index = opening; index < source.length; index++) {
    const char = source[index];
    if (quote) {
      if (char === quote && source[index - 1] !== '\\') quote = null;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === '(') depth++;
    else if (char === ')' && --depth === 0) return index;
  }
  return -1;
}

function parsePyevCommandCall(
  source: string,
): { name: string; args: string[]; flags: string[] } | null {
  const match = source.match(/^([A-Za-z_]\w*)\s*\(/);
  if (!match) return null;
  const opening = source.indexOf('(', match[1].length);
  const closing = matchingParen(source, opening);
  if (closing < 0) return null;
  const remainder = source.slice(closing + 1).trim();
  let flags: string[] = [];
  if (remainder) {
    const flagMatch = remainder.match(/^\.FLAGS\s*\(/);
    if (!flagMatch) return null;
    const flagOpening = remainder.indexOf('(');
    const flagClosing = matchingParen(remainder, flagOpening);
    if (flagClosing < 0 || remainder.slice(flagClosing + 1).trim()) return null;
    flags = splitPyevArguments(remainder.slice(flagOpening + 1, flagClosing));
  }
  return {
    name: match[1],
    args: splitPyevArguments(source.slice(opening + 1, closing)),
    flags,
  };
}

function delimiterBalance(source: string): number {
  let balance = 0;
  let quote: string | null = null;
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (quote) {
      if (char === quote && source[index - 1] !== '\\') quote = null;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if ('([{'.includes(char)) balance++;
    else if (')]}'.includes(char)) balance--;
  }
  return balance;
}

function joinPyevContinuations(source: string[]): string[] {
  const result: string[] = [];
  for (let index = 0; index < source.length; index++) {
    let logical = source[index];
    let balance = delimiterBalance(logical);
    while (balance > 0 && index + 1 < source.length) {
      const continuation = source[++index].trim();
      logical += ` ${continuation}`;
      balance += delimiterBalance(continuation);
    }
    result.push(logical);
  }
  return result;
}

// ============================================================
// PythonEventProcessor
// ============================================================

/**
 * PythonEventProcessor -- Processes PYEV1 event scripts.
 *
 * Compatible with the existing EventState which calls fetchNextCommand()
 * in a loop until it returns null (finished). Flow control blocks (if/for/
 * while) may produce multiple commands, so we buffer them in a pending queue.
 */
export class PythonEventProcessor {
  private lines: PyLine[];
  private pointer: number;
  private _finished: boolean;
  private localVars: Map<string, any>;
  private gameGetter: (() => any) | null;
  private _pendingCommands: EventCommand[];

  constructor(source: string[], gameGetter?: () => any) {
    this.lines = this.parseScript(source);
    this.pointer = 0;
    this._finished = false;
    this.localVars = new Map();
    this.gameGetter = gameGetter ?? null;
    this._pendingCommands = [];
  }

  get finished(): boolean {
    return this._finished;
  }

  saveState(): {
    pointer: number;
    finished: boolean;
    localVars: [string, any][];
    pendingCommands: EventCommand[];
  } {
    return {
      pointer: this.pointer,
      finished: this._finished,
      localVars: structuredClone([...this.localVars.entries()]),
      pendingCommands: structuredClone(this._pendingCommands),
    };
  }

  restoreState(state: {
    pointer: number;
    finished: boolean;
    localVars: [string, any][];
    pendingCommands: EventCommand[];
  }): void {
    this.pointer = state.pointer;
    this._finished = state.finished;
    this.localVars = new Map(structuredClone(state.localVars));
    this._pendingCommands = structuredClone(state.pendingCommands);
  }

  /**
   * Fetch the next event command to execute.
   * Returns null when there are no more commands (script finished).
   */
  fetchNextCommand(): EventCommand | null {
    // Drain the pending queue first
    if (this._pendingCommands.length > 0) {
      return this._pendingCommands.shift()!;
    }

    // Process lines until we find a command or reach the end
    while (this.pointer < this.lines.length) {
      const line = this.lines[this.pointer];

      switch (line.type) {
        case 'blank':
        case 'comment':
          this.pointer++;
          continue;

        case 'command':
          this.pointer++;
          return this.materializeCommand(line.command!);

        case 'if':
          this.handleIf();
          // handleIf may have queued commands; drain them
          if (this._pendingCommands.length > 0) {
            return this._pendingCommands.shift()!;
          }
          continue;

        case 'for':
          this.handleFor();
          if (this._pendingCommands.length > 0) {
            return this._pendingCommands.shift()!;
          }
          continue;

        case 'while':
          this.handleWhile();
          if (this._pendingCommands.length > 0) {
            return this._pendingCommands.shift()!;
          }
          continue;

        case 'assign':
          this.handleAssign(line);
          this.pointer++;
          continue;

        case 'augassign':
          this.handleAugAssign(line);
          this.pointer++;
          continue;

        case 'return':
          this.pointer = this.lines.length;
          this._finished = true;
          return null;

        case 'expr':
          // Evaluate expression for side effects
          this.evalExpr(line.raw);
          this.pointer++;
          continue;

        // elif/else outside of an if-chain context -- skip them
        case 'elif':
        case 'else':
          this.pointer++;
          continue;

        default:
          this.pointer++;
          continue;
      }
    }

    this._finished = true;
    return null;
  }

  // ------------------------------------------------------------------
  // Save / restore for resume support
  // ------------------------------------------------------------------

  save(): { pointer: number; localVars: [string, any][] } {
    return {
      pointer: this.pointer,
      localVars: Array.from(this.localVars.entries()),
    };
  }

  static restore(
    data: { pointer: number; localVars: [string, any][] },
    source: string[],
    gameGetter?: () => any,
  ): PythonEventProcessor {
    const proc = new PythonEventProcessor(source, gameGetter);
    proc.pointer = data.pointer;
    proc.localVars = new Map(data.localVars);
    return proc;
  }

  // ------------------------------------------------------------------
  // Script parsing
  // ------------------------------------------------------------------

  private parseScript(source: string[]): PyLine[] {
    const lines: PyLine[] = [];
    const logicalSource = joinPyevContinuations(source);

    for (let i = 0; i < logicalSource.length; i++) {
      const raw = logicalSource[i];

      // Skip the #pyev1 header
      if (i === 0 && raw.trim() === '#pyev1') continue;

      const trimmed = raw.trimEnd();
      const content = trimmed.trim();

      // Blank lines
      if (!content) {
        lines.push({ indent: 0, raw: '', type: 'blank' });
        continue;
      }

      // Comments
      if (content.startsWith('#')) {
        lines.push({ indent: 0, raw: content, type: 'comment' });
        continue;
      }

      // Preserve the exact indentation width. Python permits a block to use
      // any consistent increase, and authored projects can contain non-four-
      // space blocks (EOtF has an eleven-space `return` beneath an eight-space
      // `if`). Collapsing widths into four-space levels changes that control
      // flow.
      const leadingWhitespace = raw.match(/^[\t ]*/)?.[0] ?? '';
      const indent = leadingWhitespace.replace(/\t/g, '    ').length;

      // $command lines
      if (content.startsWith('$')) {
        const cmdText = content.slice(1).trim();
        const cmd = this.parseCommandLine(cmdText);
        lines.push({ indent, raw: content, type: 'command', command: cmd });
        continue;
      }

      // if ... :
      if (content.startsWith('if ') && content.endsWith(':')) {
        lines.push({
          indent,
          raw: content,
          type: 'if',
          condition: content.slice(3, -1).trim(),
        });
        continue;
      }

      // elif ... :
      if (content.startsWith('elif ') && content.endsWith(':')) {
        lines.push({
          indent,
          raw: content,
          type: 'elif',
          condition: content.slice(5, -1).trim(),
        });
        continue;
      }

      // else:
      if (content === 'else:') {
        lines.push({ indent, raw: content, type: 'else' });
        continue;
      }

      if (content === 'return') {
        lines.push({ indent, raw: content, type: 'return' });
        continue;
      }

      // for VAR in ITERABLE:
      if (content.startsWith('for ') && content.includes(' in ') && content.endsWith(':')) {
        const match = content.match(/^for\s+(\w+)\s+in\s+(.+):$/);
        if (match) {
          lines.push({
            indent,
            raw: content,
            type: 'for',
            forVar: match[1],
            forIterable: match[2],
          });
          continue;
        }
      }

      // while CONDITION:
      if (content.startsWith('while ') && content.endsWith(':')) {
        lines.push({
          indent,
          raw: content,
          type: 'while',
          condition: content.slice(6, -1).trim(),
        });
        continue;
      }

      // Assignment: x = expr  (but not ==, !=, <=, >=)
      // Match "identifier = expression" where = is not part of ==, !=, <=, >=
      // The lookahead (?!=) ensures we don't match == or ===.
      // Since we already matched ^\w+\s* before the =, the char before = is
      // always whitespace or a word char, so we only need the lookahead.
      const augAssignMatch = content.match(/^([A-Za-z_]\w*(?:\.\w+)*)\s*(\+=|-=)\s*(.+)$/);
      if (augAssignMatch) {
        lines.push({
          indent,
          raw: content,
          type: 'augassign',
          assignTarget: augAssignMatch[1],
          assignOperator: augAssignMatch[2] as '+=' | '-=',
          assignValue: augAssignMatch[3],
        });
        continue;
      }
      const assignMatch = content.match(/^([A-Za-z_]\w*(?:\.\w+)*)\s*=(?!=)\s*(.+)$/);
      if (assignMatch) {
        lines.push({
          indent,
          raw: content,
          type: 'assign',
          assignTarget: assignMatch[1],
          assignValue: assignMatch[2],
        });
        continue;
      }

      // Fallback: expression (function call, etc.)
      lines.push({ indent, raw: content, type: 'expr' });
    }

    return lines;
  }

  // ------------------------------------------------------------------
  // Command line parsing
  // ------------------------------------------------------------------

  private parseCommandLine(line: string): EventCommand {
    const functionCall = parsePyevCommandCall(line);
    if (functionCall) {
      return {
        type: resolveAlias(functionCall.name.toLowerCase()) as EventCommandType,
        args: [],
        _pyevArgExprs: functionCall.args,
        _pyevFlagExprs: functionCall.flags,
      } as EventCommand & {
        _pyevArgExprs: string[];
        _pyevFlagExprs: string[];
      };
    }
    // Tokenize respecting quotes and parentheses
    const rawTokens = tokenizePyevLine(line, true);
    const name = (rawTokens[0] ? stripQuotes(rawTokens[0]) : '').toLowerCase();
    // Python passes #pyev1 values with from_python, so a quoted value for an
    // expression argument stays a string: re-quote it as a Python literal for
    // the command handler, which evaluates that argument.
    const expressionArg = PYEV_EXPRESSION_ARGS[resolveAlias(name)];
    const tokens = rawTokens.map((token, index) => {
      const value = stripQuotes(token);
      return index - 1 === expressionArg && value !== token ? pyRepr(value) : value;
    });

    // Find flag separator (comma token)
    let flagStart = tokens.length;
    for (let i = 1; i < tokens.length; i++) {
      if (tokens[i] === ',') {
        flagStart = i;
        break;
      }
    }

    // Command arguments before the comma, flags after
    const args = tokens.slice(1, flagStart);
    const flags = tokens.slice(flagStart + 1); // skip the comma token

    // Resolve command name aliases
    const resolvedName = resolveAlias(name);

    return {
      type: resolvedName as EventCommandType,
      args: [...args, ...flags],
    };
  }

  // ------------------------------------------------------------------
  // Flow control: if / elif / else
  // ------------------------------------------------------------------

  private handleIf(): void {
    const startLine = this.lines[this.pointer];
    const startIndent = startLine.indent;

    // Evaluate the 'if' condition
    let condResult = this.evalCondition(startLine.condition!);
    this.pointer++;

    if (condResult) {
      // Execute the if-block body
      this.executeBlock(startIndent);
      // Skip remaining elif/else branches at the same indent
      this.skipRemainingBranches(startIndent);
      return;
    }

    // Condition was false -- skip the if-block body
    this.skipBlock(startIndent);

    // Check for elif/else at the same indent
    while (this.pointer < this.lines.length) {
      const line = this.lines[this.pointer];

      // Only consider elif/else at the same indent as the original if
      if (line.type !== 'elif' && line.type !== 'else') break;
      if (line.indent !== startIndent) break;

      if (line.type === 'elif') {
        condResult = this.evalCondition(line.condition!);
        this.pointer++;
        if (condResult) {
          this.executeBlock(startIndent);
          this.skipRemainingBranches(startIndent);
          return;
        }
        this.skipBlock(startIndent);
        continue;
      }

      if (line.type === 'else') {
        this.pointer++;
        this.executeBlock(startIndent);
        return;
      }

      break;
    }
  }

  // ------------------------------------------------------------------
  // Flow control: for
  // ------------------------------------------------------------------

  private handleFor(): void {
    const startLine = this.lines[this.pointer];
    const startIndent = startLine.indent;
    const varName = startLine.forVar!;
    const iterExpr = startLine.forIterable!;
    const bodyStart = this.pointer + 1;

    // Evaluate the iterable
    let iterable: any;
    try {
      iterable = this.evalExpr(iterExpr);
    } catch {
      // If evaluation fails, skip the block
      this.pointer++;
      this.skipBlock(startIndent);
      return;
    }

    // Python iteration: lists, tuples, dict keys, str characters, ...
    let values: unknown[];
    try {
      if (iterable == null) throw new Error('not iterable');
      values = toArray(iterable).map(toHostValue);
    } catch {
      // Not iterable -- skip block
      this.pointer = bodyStart;
      this.skipBlock(startIndent);
      return;
    }

    for (const value of values) {
      this.localVars.set(varName, value);
      this.pointer = bodyStart;
      this.executeBlock(startIndent);
    }

    // After the loop, ensure pointer is past the block
    // (executeBlock leaves pointer at the first line after the block, but
    //  if the loop ran 0 iterations we need to skip manually)
    if (this.pointer <= bodyStart) {
      this.pointer = bodyStart;
      this.skipBlock(startIndent);
    }
  }

  // ------------------------------------------------------------------
  // Flow control: while
  // ------------------------------------------------------------------

  private handleWhile(): void {
    const startLine = this.lines[this.pointer];
    const startIndent = startLine.indent;
    const bodyStart = this.pointer + 1;
    const MAX_ITERATIONS = 10000;
    let iterations = 0;

    while (this.evalCondition(startLine.condition!) && iterations < MAX_ITERATIONS) {
      this.pointer = bodyStart;
      this.executeBlock(startIndent);
      iterations++;
    }

    if (iterations >= MAX_ITERATIONS) {
      console.warn('PYEV1: while loop exceeded max iterations (10000), aborting loop');
    }

    // Ensure pointer is past the block
    this.pointer = bodyStart;
    this.skipBlock(startIndent);
  }

  // ------------------------------------------------------------------
  // Assignment
  // ------------------------------------------------------------------

  private handleAssign(line: PyLine): void {
    try {
      const value = this.evalExpr(line.assignValue!);
      this.setAssignmentTarget(line.assignTarget!, value);
    } catch (e) {
      console.warn(`PYEV1: assignment failed for "${line.raw}"`, e);
    }
  }

  private handleAugAssign(line: PyLine): void {
    const current = this.getAssignmentTarget(line.assignTarget!);
    const value = this.evalExpr(line.assignValue!);
    // Python augmented assignment: `list += iterable` extends; otherwise the
    // binary operator's semantics (`+` concatenates sequences, adds numbers).
    const next = line.assignOperator === '+=' && Array.isArray(current)
      ? [...current, ...toArray(value)]
      : toHostValue(pyBinary(line.assignOperator === '-=' ? '-' : '+', current, value));
    this.setAssignmentTarget(line.assignTarget!, next);
  }

  private getAssignmentTarget(target: string): any {
    const [root, ...properties] = target.split('.');
    let value = this.localVars.get(root);
    if (value === undefined && root === 'game') value = this.gameGetter?.();
    for (const property of properties) value = (value?._raw ?? value)?.[property];
    return value;
  }

  private setAssignmentTarget(target: string, value: any): void {
    const [root, ...properties] = target.split('.');
    if (properties.length === 0) {
      this.localVars.set(root, value);
      return;
    }
    let owner = this.localVars.get(root);
    if (owner === undefined && root === 'game') owner = this.gameGetter?.();
    owner = owner?._raw ?? owner;
    for (const property of properties.slice(0, -1)) {
      owner = owner?.[property]?._raw ?? owner?.[property];
    }
    if (owner) owner[properties.at(-1)!] = value?._raw ?? value;
  }

  // ------------------------------------------------------------------
  // Block execution & skipping
  // ------------------------------------------------------------------

  /**
   * Execute all lines in a block (indent > parentIndent).
   * Commands are pushed to _pendingCommands for later retrieval.
   */
  private executeBlock(parentIndent: number): void {
    while (this.pointer < this.lines.length) {
      const line = this.lines[this.pointer];

      // End of block: we've reached a line at or below the parent indent
      // (blank lines and comments are always part of the block)
      if (line.type !== 'blank' && line.type !== 'comment' && line.indent <= parentIndent) {
        break;
      }

      this.processLine();
    }
  }

  /**
   * Process a single line at the current pointer, advancing the pointer.
   * If the line produces a command, it's pushed to _pendingCommands.
   */
  private processLine(): void {
    if (this.pointer >= this.lines.length) return;
    const line = this.lines[this.pointer];

    switch (line.type) {
      case 'blank':
      case 'comment':
        this.pointer++;
        break;

      case 'command':
        this._pendingCommands.push(this.materializeCommand(line.command!));
        this.pointer++;
        break;

      case 'if':
        this.handleIf();
        break;

      case 'for':
        this.handleFor();
        break;

      case 'while':
        this.handleWhile();
        break;

      case 'assign':
        this.handleAssign(line);
        this.pointer++;
        break;

      case 'augassign':
        this.handleAugAssign(line);
        this.pointer++;
        break;

      case 'return':
        this.pointer = this.lines.length;
        this._finished = true;
        break;

      case 'expr':
        this.evalExpr(line.raw);
        this.pointer++;
        break;

      // Stray elif/else (shouldn't happen in well-formed scripts)
      case 'elif':
      case 'else':
        this.pointer++;
        break;

      default:
        this.pointer++;
        break;
    }
  }

  /**
   * Skip all lines in a block (indent > parentIndent) without executing.
   */
  private skipBlock(parentIndent: number): void {
    while (this.pointer < this.lines.length) {
      const line = this.lines[this.pointer];
      if (line.type !== 'blank' && line.type !== 'comment' && line.indent <= parentIndent) {
        break;
      }
      this.pointer++;
    }
  }

  /**
   * Skip remaining elif/else branches at the same indent level.
   * Called after a truthy branch has been executed.
   */
  private skipRemainingBranches(branchIndent: number): void {
    while (this.pointer < this.lines.length) {
      const line = this.lines[this.pointer];
      if (line.indent !== branchIndent) break;
      if (line.type !== 'elif' && line.type !== 'else') break;

      // Skip the branch header
      this.pointer++;
      // Skip its body
      this.skipBlock(branchIndent);
    }
  }

  // ------------------------------------------------------------------
  // Expression evaluation
  // ------------------------------------------------------------------

  /**
   * Globals for evaluating without the engine's evaluator (no game wired):
   * the event's locals plus game/DB/u/v. Python builtins come from py-expr.
   */
  private buildEvalContext(): Record<string, any> {
    const game = this.gameGetter ? this.gameGetter() : null;
    const ctx: Record<string, any> = {};
    for (const [k, v] of this.localVars) ctx[k] = v;
    if (game) {
      ctx.game = game;
      ctx.DB = game.db ?? null;
      ctx.unit = ctx.unit ?? null;
      ctx.unit1 = ctx.unit1 ?? null;
      ctx.unit2 = ctx.unit2 ?? null;
      ctx.target = ctx.target ?? null;
      ctx.u = (nid: string) =>
        game.getUnit?.(nid) ?? game.allUnits?.get(nid) ?? game.units?.get(nid) ?? null;
      ctx.v = (varname: string, fallback: any = null) => {
        const lv = game.levelVars?.get(varname);
        if (lv !== undefined && lv !== null) return lv;
        if (game.gameVars?.has(varname)) return game.gameVars.get(varname);
        return fallback;
      };
    }
    return ctx;
  }

  /**
   * Evaluate a Python-like expression and return its value.
   */
  private evalExpr(expr: string): any {
    try {
      const game = this.gameGetter ? this.gameGetter() : null;
      if (pyevExpressionEvaluator && game) {
        return pyevExpressionEvaluator(expr, game, this.localVars);
      }
      return evaluatePython(expr, scopeFromRecord(this.buildEvalContext()));
    } catch (e) {
      console.warn(`PYEV1 eval error for expression: "${expr}"`, e);
      return undefined;
    }
  }

  private materializeCommand(command: EventCommand): EventCommand {
    const deferred = command as EventCommand & {
      _pyevArgExprs?: string[];
      _pyevFlagExprs?: string[];
    };
    if (!deferred._pyevArgExprs) return command;
    const stringify = (value: any): string => {
      const raw = value?._raw ?? value;
      if (raw === null || raw === undefined) return '';
      if (typeof raw === 'string') return raw;
      if (typeof raw === 'object') return JSON.stringify(raw);
      return String(raw);
    };
    const evaluated = deferred._pyevArgExprs.map((expression) => this.evalExpr(expression));
    const componentMutation = [
      'add_item_component',
      'modify_item_component',
    ].includes(command.type);
    // Python passes #pyev1 values with the from_python flag, so commands that
    // evaluate an expression argument store the value itself. The command
    // handlers re-evaluate that argument, so hand them a Python literal that
    // evaluates back to the same value ('123' stays the string '123').
    const expressionArg = PYEV_EXPRESSION_ARGS[command.type];
    const args = evaluated.map((value, index) => {
      if (componentMutation && index === 3) {
        const raw = value?._raw ?? value;
        return JSON.stringify(raw);
      }
      if (index === expressionArg) return pythonValueLiteral(value);
      return stringify(value);
    });
    return {
      type: command.type,
      args: [
        ...args,
        ...(deferred._pyevFlagExprs ?? []).map((expression) =>
          stringify(this.evalExpr(expression))),
        ...(componentMutation ? ['from_python'] : []),
      ],
    };
  }

  /**
   * Evaluate an expression as a boolean condition.
   */
  private evalCondition(expr: string): boolean {
    const result = this.evalExpr(expr);
    return pyBool(result);
  }
}

/** Event commands whose argument at this index is a Python expression. */
const PYEV_EXPRESSION_ARGS: Record<string, number> = {
  game_var: 1, inc_game_var: 1, level_var: 1, inc_level_var: 1,
  set_unit_field: 2, set_item_data: 3, set_skill_data: 3,
  add_skill_component: 3, modify_skill_component: 3,
  create_record: 1, update_record: 1, replace_record: 1,
};

/** A Python literal for an evaluated #pyev1 value (objects become their nid). */
function pythonValueLiteral(value: any): string {
  const raw = value?._raw ?? value;
  if (raw && typeof raw === 'object' && !Array.isArray(raw) && !(raw instanceof Map) &&
      !(raw instanceof Set) && (raw.uid !== undefined || raw.nid !== undefined)) {
    return pyRepr(String(raw.uid ?? raw.nid));
  }
  return pyRepr(toHostValue(raw));
}

// ============================================================
// Tokenizer for PYEV1 $command lines
// ============================================================

/**
 * Tokenize a PYEV1 command line into space-separated tokens,
 * respecting quoted strings and parenthesized/bracketed groups.
 * Commas are returned as separate tokens to serve as flag separators.
 */
export function tokenizePyevLine(line: string, keepQuotes = false): string[] {
  const finish = (token: string) => (keepQuotes ? token : stripQuotes(token));
  const tokens: string[] = [];
  let current = '';
  let inQuote: string | null = null;
  let parenDepth = 0;
  let bracketDepth = 0;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];

    // Inside a quoted string
    if (inQuote) {
      current += ch;
      if (ch === inQuote && (i === 0 || line[i - 1] !== '\\')) {
        inQuote = null;
      }
      continue;
    }

    // Start of a quoted string
    if (ch === '"' || ch === "'") {
      inQuote = ch;
      current += ch;
      continue;
    }

    // Parentheses / brackets (group into single tokens)
    if (ch === '(') { parenDepth++; current += ch; continue; }
    if (ch === ')') { parenDepth--; current += ch; continue; }
    if (ch === '[') { bracketDepth++; current += ch; continue; }
    if (ch === ']') { bracketDepth--; current += ch; continue; }

    // Space separator (only at top level)
    if (ch === ' ' && parenDepth === 0 && bracketDepth === 0) {
      if (current.length > 0) {
        tokens.push(finish(current));
        current = '';
      }
      continue;
    }

    // Comma as flag separator (only at top level)
    if (ch === ',' && parenDepth === 0 && bracketDepth === 0) {
      if (current.length > 0) {
        tokens.push(finish(current));
        current = '';
      }
      tokens.push(',');
      continue;
    }

    current += ch;
  }

  if (current.length > 0) {
    tokens.push(finish(current));
  }

  return tokens;
}

/**
 * Strip matching outer quotes from a token.
 */
function stripQuotes(s: string): string {
  if (s.length >= 2) {
    if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
      return s.slice(1, -1);
    }
  }
  return s;
}

const PYEV1_ALIASES: Record<string, string> = {
  // Portrait shortcuts
  'u': 'add_portrait',
  'r': 'remove_portrait',
  'uu': 'multi_add_portrait',
  'rr': 'multi_remove_portrait',
  'rrr': 'remove_all_portraits',
  'bop': 'bop_portrait',
  'mirror': 'mirror_portrait',
  'e': 'expression',
  // Dialogue
  's': 'speak',
  // Music
  'm': 'music',
  'mf': 'music_fade_back',
  // Background
  't': 'transition',
  'b': 'change_background',
  // Flow control
  'break': 'finish',
  // Overworld
  'omove': 'overworld_move_unit',
  // Variables
  'gvar': 'game_var',
  'ginc': 'inc_game_var',
  'mgvar': 'modify_game_var',
  'lvar': 'level_var',
  'linc': 'inc_level_var',
  'mlvar': 'modify_level_var',
  // Unit management
  'add': 'add_unit',
  'move': 'move_unit',
  'remove': 'remove_unit',
  'kill': 'kill_unit',
  'interact': 'interact_unit',
  'reset_unit': 'reset',
  'add_skill': 'give_skill',
  'set_ai': 'change_ai',
  'set_ai_group': 'change_ai_group',
  // Cursor
  'highlight': 'flicker_cursor',
  'set_cursor': 'move_cursor',
  // Legacy
  'set_game_var': 'game_var',
  'change_objective': 'change_objective_simple',
  'resurrect_unit': 'resurrect',
  'unlock_lore': 'add_lore',
  'morph_group': 'move_group',
};

function resolveAlias(name: string): string {
  return PYEV1_ALIASES[name] ?? name;
}
