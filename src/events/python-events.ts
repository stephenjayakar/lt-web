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
 * Exports: isPyev1, PythonEventProcessor, tokenizePyevLine, translatePythonToJs
 */

import type { EventCommand, EventCommandType } from './event-manager';

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
          return line.command!;

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

    for (let i = 0; i < source.length; i++) {
      const raw = source[i];

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

      // Calculate indentation level (spaces / 4)
      const leadingSpaces = raw.length - raw.trimStart().length;
      const indent = Math.floor(leadingSpaces / 4);

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
      const assignMatch = content.match(/^(\w+)\s*=(?!=)\s*(.+)$/);
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
    // Tokenize respecting quotes and parentheses
    const tokens = tokenizePyevLine(line);
    const name = tokens[0]?.toLowerCase() ?? '';

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

    if (iterable == null || typeof iterable[Symbol.iterator] !== 'function') {
      // Not iterable -- skip block
      this.pointer = bodyStart;
      this.skipBlock(startIndent);
      return;
    }

    for (const value of iterable) {
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
      this.localVars.set(line.assignTarget!, value);
    } catch (e) {
      console.warn(`PYEV1: assignment failed for "${line.raw}"`, e);
    }
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
        this._pendingCommands.push(line.command!);
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

  private buildEvalContext(): Record<string, any> {
    const game = this.gameGetter ? this.gameGetter() : null;
    const ctx: Record<string, any> = {};

    // Inject local variables
    for (const [k, v] of this.localVars) {
      ctx[k] = v;
    }

    // Python boolean/None constants
    ctx.True = true;
    ctx.False = false;
    ctx.None = null;

    // Python builtins
    ctx.len = (x: any) => {
      if (x == null) return 0;
      if (typeof x === 'object' && 'size' in x) return x.size;
      return x.length ?? 0;
    };
    ctx.range = (...args: number[]) => {
      const start = args.length >= 2 ? args[0] : 0;
      const end = args.length >= 2 ? args[1] : args[0];
      const step = args[2] ?? 1;
      const result: number[] = [];
      if (step > 0) {
        for (let i = start; i < end; i += step) result.push(i);
      } else if (step < 0) {
        for (let i = start; i > end; i += step) result.push(i);
      }
      return result;
    };
    ctx.str = String;
    ctx.int = (x: any) => {
      const n = parseInt(x, 10);
      return isNaN(n) ? 0 : n;
    };
    ctx.float = (x: any) => {
      const n = parseFloat(x);
      return isNaN(n) ? 0.0 : n;
    };
    ctx.abs = Math.abs;
    ctx.max = Math.max;
    ctx.min = Math.min;
    ctx.round = Math.round;
    ctx.any = (iter: any) => {
      if (!iter) return false;
      for (const x of iter) { if (x) return true; }
      return false;
    };
    ctx.all = (iter: any) => {
      if (!iter) return true;
      for (const x of iter) { if (!x) return false; }
      return true;
    };
    ctx.sum = (iter: any, start?: number) => {
      let s = start ?? 0;
      if (iter) {
        for (const x of iter) s += x;
      }
      return s;
    };
    ctx.sorted = (iter: any, opts?: any) => {
      const arr = Array.from(iter ?? []);
      if (opts && typeof opts === 'function') {
        // sorted(iterable, key=fn) -- Python kwarg, but JS callers pass fn directly
        arr.sort((a: any, b: any) => opts(a) - opts(b));
      } else if (opts && opts.key) {
        arr.sort((a: any, b: any) => opts.key(a) - opts.key(b));
      } else {
        arr.sort();
      }
      if (opts && opts.reverse) arr.reverse();
      return arr;
    };
    ctx.list = (iter: any) => Array.from(iter ?? []);
    ctx.tuple = (iter: any) => Array.from(iter ?? []);
    ctx.set = (iter: any) => new Set(iter ?? []);
    ctx.dict = (iter: any) => {
      if (!iter) return new Map();
      return new Map(iter);
    };
    ctx.enumerate = (iter: any, start?: number) => {
      const s = start ?? 0;
      const arr = Array.from(iter ?? []);
      return arr.map((v: any, i: number) => [i + s, v]);
    };
    ctx.zip = (...iters: any[]) => {
      const arrays = iters.map((it: any) => Array.from(it ?? []));
      const minLen = Math.min(...arrays.map((a: any[]) => a.length));
      const result: any[][] = [];
      for (let i = 0; i < minLen; i++) {
        result.push(arrays.map((a: any[]) => a[i]));
      }
      return result;
    };
    ctx.isinstance = (obj: any, cls: any) => {
      if (cls === ctx.int || cls === Number) return typeof obj === 'number';
      if (cls === ctx.str || cls === String) return typeof obj === 'string';
      if (cls === ctx.list || cls === Array) return Array.isArray(obj);
      return false;
    };
    ctx.print = (...args: any[]) => {
      console.log('PYEV1 print:', ...args);
    };
    ctx.Math = Math;
    ctx.math = Math;

    // Inject game state if available
    if (game) {
      ctx.game = game;
      ctx.DB = game.db ?? null;

      // Unit context (set by event trigger, may be overridden)
      ctx.unit = ctx.unit ?? null;
      ctx.unit1 = ctx.unit1 ?? null;
      ctx.unit2 = ctx.unit2 ?? null;
      ctx.target = ctx.target ?? null;

      // Query engine functions
      ctx.u = (nid: string) => {
        return game.getUnit?.(nid) ?? game.allUnits?.get(nid) ?? game.units?.get(nid) ?? null;
      };
      ctx.v = (varname: string, fallback?: any) => {
        const lv = game.levelVars?.get(varname);
        if (lv !== undefined) return lv;
        const gv = game.gameVars?.get(varname);
        if (gv !== undefined) return gv;
        return fallback ?? null;
      };
    }

    return ctx;
  }

  /**
   * Evaluate a Python-like expression and return its value.
   */
  private evalExpr(expr: string): any {
    try {
      // Translate Python syntax to JS
      const jsExpr = translatePythonToJs(expr);

      const ctx = this.buildEvalContext();
      const keys = Object.keys(ctx);
      const values = Object.values(ctx);

      // eslint-disable-next-line no-new-func
      const fn = new Function(...keys, `"use strict"; return (${jsExpr});`);
      return fn(...values);
    } catch (e) {
      console.warn(`PYEV1 eval error for expression: "${expr}"`, e);
      return undefined;
    }
  }

  /**
   * Evaluate an expression as a boolean condition.
   */
  private evalCondition(expr: string): boolean {
    const result = this.evalExpr(expr);
    return !!result;
  }
}

// ============================================================
// Tokenizer for PYEV1 $command lines
// ============================================================

/**
 * Tokenize a PYEV1 command line into space-separated tokens,
 * respecting quoted strings and parenthesized/bracketed groups.
 * Commas are returned as separate tokens to serve as flag separators.
 */
export function tokenizePyevLine(line: string): string[] {
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
        tokens.push(stripQuotes(current));
        current = '';
      }
      continue;
    }

    // Comma as flag separator (only at top level)
    if (ch === ',' && parenDepth === 0 && bracketDepth === 0) {
      if (current.length > 0) {
        tokens.push(stripQuotes(current));
        current = '';
      }
      tokens.push(',');
      continue;
    }

    current += ch;
  }

  if (current.length > 0) {
    tokens.push(stripQuotes(current));
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

// ============================================================
// Python -> JavaScript expression translation
// ============================================================

/**
 * Translate common Python syntax idioms to JavaScript equivalents.
 * This is a best-effort translation for simple expressions.
 */
export function translatePythonToJs(expr: string): string {
  let s = expr;

  // 1. Python boolean / None constants
  s = s.replace(/\bTrue\b/g, 'true');
  s = s.replace(/\bFalse\b/g, 'false');
  s = s.replace(/\bNone\b/g, 'null');

  // 2. Integer division: // -> Math.floor(x / y)
  //    Must happen before logical operators so '//' isn't confused
  s = replaceIntegerDivision(s);

  // 3. Python power: ** -> Math.pow(x, y)
  s = replacePowerOperator(s);

  // 4. Logical operators
  s = s.replace(/\band\b/g, '&&');
  s = s.replace(/\bor\b/g, '||');

  // 5. 'not in' and 'in' operators (must run before standalone 'not')
  s = replacePythonInOperator(s);

  // 6. Standalone 'not' -> '!'
  s = s.replace(/\bnot\s+/g, '!');

  // 7. Python f-strings: f"text {expr}" -> `text ${expr}`
  s = s.replace(/f"([^"]*?)"/g, (_match, content) => {
    const converted = content.replace(/\{/g, '${');
    return '`' + converted + '`';
  });
  s = s.replace(/f'([^']*?)'/g, (_match, content) => {
    const converted = content.replace(/\{/g, '${');
    return '`' + converted + '`';
  });

  return s;
}

/**
 * Replace Python 'in' and 'not in' operators with JS .includes() calls.
 * Handles simple cases like: 'x' in y, x not in y, 'x' in ['a', 'b']
 */
function replacePythonInOperator(s: string): string {
  // 'X' not in Y -> !(Y).includes('X')
  s = s.replace(/(\S+)\s+not\s+in\s+(\S+)/g, '!($2).includes($1)');
  // 'X' in Y -> (Y).includes('X')
  // Be careful not to match 'for X in Y' -- but those shouldn't appear
  // inside expressions (they appear at statement level)
  s = s.replace(/(\S+)\s+in\s+(\S+)/g, '($2).includes($1)');
  return s;
}

/**
 * Replace Python // integer division with Math.floor(x / y).
 */
function replaceIntegerDivision(s: string): string {
  // Match patterns like: expr // expr
  // Simple approach: replace all occurrences of '//' with a marker,
  // then wrap in Math.floor. This is imperfect for complex expressions
  // but handles common cases.
  const parts = s.split('//');
  if (parts.length <= 1) return s;

  // For simple "a // b" cases
  let result = parts[0];
  for (let i = 1; i < parts.length; i++) {
    // Find the rightmost operand of the left side and leftmost of the right
    const leftTrimmed = result.trimEnd();
    const rightTrimmed = parts[i].trimStart();

    // Extract the last token from left side
    const leftMatch = leftTrimmed.match(/(\S+)$/);
    const rightMatch = rightTrimmed.match(/^(\S+)/);

    if (leftMatch && rightMatch) {
      const leftOperand = leftMatch[1];
      const rightOperand = rightMatch[1];
      const prefix = leftTrimmed.slice(0, leftTrimmed.length - leftOperand.length);
      const suffix = rightTrimmed.slice(rightOperand.length);
      result = prefix + `Math.floor(${leftOperand} / ${rightOperand})` + suffix;
    } else {
      // Fallback: just replace with regular division
      result = result + ' / ' + parts[i];
    }
  }

  return result;
}

/**
 * Replace Python ** power operator with Math.pow(x, y).
 */
function replacePowerOperator(s: string): string {
  // Match patterns like: x ** y
  // Simple regex approach for common cases
  return s.replace(/(\w+(?:\.\w+)*)\s*\*\*\s*(\w+(?:\.\w+)*)/g, 'Math.pow($1, $2)');
}

// ============================================================
// Command name alias resolution
// ============================================================

/** Map of PYEV1 short aliases to canonical command names. */
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
