/**
 * Recursive-descent parser for Python expressions, following the grammar of
 * CPython's `eval` input (Grammar/python.gram, `expressions` rule) with the
 * full precedence table:
 *
 *   lambda < if-else < or < and < not < comparisons (in, not in, is, is not,
 *   <, <=, >, >=, !=, ==; chained) < | < ^ < & < <<,>> < +,- < *,/,//,%,@
 *   < unary +,-,~ < ** (right-assoc, binds tighter than a unary on its left)
 *   < await/primary (attribute, call, subscript) < atoms
 */
import { PySyntaxError, tokenize, type FStringPart, type Token } from './tokenizer';
import { PyFloat, makeTuple } from './values';

export type CompareOp = '==' | '!=' | '<' | '<=' | '>' | '>=' | 'in' | 'not in' | 'is' | 'is not';
export type BinaryOp = '+' | '-' | '*' | '/' | '//' | '%' | '**' | '@' | '<<' | '>>' | '&' | '|' | '^';

export interface Comprehension {
  target: Node;
  iter: Node;
  ifs: Node[];
}

export interface LambdaParam {
  name: string;
  kind: 'positional' | 'vararg' | 'kwonly' | 'kwarg';
  default?: Node;
}

export interface CompiledFStringPart {
  literal?: string;
  expr?: Node;
  conversion?: string;
  spec?: CompiledFStringPart[];
  selfDoc?: string;
}

export interface Keyword {
  /** null for `**mapping`. */
  arg: string | null;
  value: Node;
}

export type Node =
  | { k: 'const'; value: unknown }
  | { k: 'fstring'; parts: CompiledFStringPart[] }
  | { k: 'name'; id: string }
  | { k: 'tuple'; elts: Node[] }
  | { k: 'list'; elts: Node[] }
  | { k: 'set'; elts: Node[] }
  | { k: 'dict'; keys: (Node | null)[]; values: Node[] }
  | { k: 'listcomp' | 'setcomp' | 'genexp'; elt: Node; generators: Comprehension[] }
  | { k: 'dictcomp'; key: Node; value: Node; generators: Comprehension[] }
  | { k: 'boolop'; op: 'and' | 'or'; values: Node[] }
  | { k: 'not'; operand: Node }
  | { k: 'unary'; op: '-' | '+' | '~'; operand: Node }
  | { k: 'binop'; op: BinaryOp; left: Node; right: Node }
  | { k: 'compare'; left: Node; ops: CompareOp[]; comparators: Node[] }
  | { k: 'ifexp'; test: Node; body: Node; orelse: Node }
  | { k: 'lambda'; params: LambdaParam[]; body: Node }
  | { k: 'attribute'; value: Node; attr: string }
  | { k: 'subscript'; value: Node; index: Node }
  | { k: 'slice'; lower: Node | null; upper: Node | null; step: Node | null }
  | { k: 'call'; func: Node; args: Node[]; keywords: Keyword[] }
  | { k: 'starred'; value: Node }
  | { k: 'namedexpr'; target: string; value: Node };

const KEYWORDS = new Set([
  'False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break', 'class',
  'continue', 'def', 'del', 'elif', 'else', 'except', 'finally', 'for', 'from', 'global',
  'if', 'import', 'in', 'is', 'lambda', 'nonlocal', 'not', 'or', 'pass', 'raise',
  'return', 'try', 'while', 'with', 'yield',
]);

function parseNumber(text: string, offset: number): number | PyFloat {
  const clean = text.replace(/_/g, '');
  if (/^0[xX]/.test(clean)) return parseInt(clean.slice(2), 16);
  if (/^0[oO]/.test(clean)) return parseInt(clean.slice(2), 8);
  if (/^0[bB]/.test(clean)) return parseInt(clean.slice(2), 2);
  const value = Number(clean);
  if (Number.isNaN(value)) throw new PySyntaxError('invalid number literal', offset);
  if (/[.eE]/.test(clean)) return Number.isInteger(value) ? new PyFloat(value) : value;
  return value;
}

class Parser {
  private readonly tokens: Token[];
  private pos = 0;
  private readonly source: string;

  constructor(source: string) {
    this.source = source;
    this.tokens = tokenize(source);
  }

  private peek(offset = 0): Token {
    return this.tokens[Math.min(this.pos + offset, this.tokens.length - 1)];
  }

  private next(): Token {
    const token = this.tokens[this.pos];
    if (this.pos < this.tokens.length - 1) this.pos++;
    return token;
  }

  private isOp(value: string, offset = 0): boolean {
    const token = this.peek(offset);
    return token.type === 'op' && token.value === value;
  }

  private isKeyword(value: string, offset = 0): boolean {
    const token = this.peek(offset);
    return token.type === 'name' && token.value === value;
  }

  private acceptOp(value: string): boolean {
    if (this.isOp(value)) {
      this.next();
      return true;
    }
    return false;
  }

  private acceptKeyword(value: string): boolean {
    if (this.isKeyword(value)) {
      this.next();
      return true;
    }
    return false;
  }

  private expectOp(value: string): void {
    if (!this.acceptOp(value)) this.fail(`expected '${value}'`);
  }

  private fail(message: string, token: Token = this.peek()): never {
    const near = token.type === 'end' ? 'end of input' : `'${token.value}'`;
    throw new PySyntaxError(`invalid syntax: ${message} near ${near}`, token.offset);
  }

  /** Whether the next token can start an expression. */
  private startsExpression(): boolean {
    const token = this.peek();
    if (token.type === 'end') return false;
    if (token.type === 'number' || token.type === 'string') return true;
    if (token.type === 'name') {
      return !KEYWORDS.has(token.value) ||
        ['True', 'False', 'None', 'not', 'lambda', 'await'].includes(token.value);
    }
    return ['(', '[', '{', '-', '+', '~', '...', '*'].includes(token.value);
  }

  parseEvalInput(): Node {
    const node = this.starExpressions();
    if (this.peek().type !== 'end') this.fail('unexpected token');
    return node;
  }

  /** star_expressions: a bare tuple at top level (`1, 2`). */
  private starExpressions(): Node {
    const first = this.starExpression();
    if (!this.isOp(',')) {
      if (first.k === 'starred') this.fail("can't use starred expression here");
      return first;
    }
    const elts = [first];
    while (this.acceptOp(',')) {
      if (!this.startsExpression()) break;
      elts.push(this.starExpression());
    }
    return { k: 'tuple', elts };
  }

  private starExpression(): Node {
    if (this.acceptOp('*')) return { k: 'starred', value: this.bitOr() };
    return this.expression();
  }

  /** named_expression: NAME ':=' expression | expression */
  private namedExpression(): Node {
    const token = this.peek();
    if (token.type === 'name' && !KEYWORDS.has(token.value) && this.isOp(':=', 1)) {
      this.next();
      this.next();
      return { k: 'namedexpr', target: token.value, value: this.expression() };
    }
    return this.expression();
  }

  /** expression: lambda | disjunction ['if' disjunction 'else' expression] */
  expression(): Node {
    if (this.isKeyword('lambda')) return this.lambda();
    const body = this.disjunction();
    if (this.isKeyword('if')) {
      this.next();
      const test = this.disjunction();
      if (!this.acceptKeyword('else')) this.fail("expected 'else' after 'if' expression");
      const orelse = this.expression();
      return { k: 'ifexp', test, body, orelse };
    }
    return body;
  }

  private lambda(): Node {
    this.next(); // lambda
    const params: LambdaParam[] = [];
    let seenStar = false;
    const names = new Set<string>();
    const paramName = (): string => {
      const token = this.next();
      if (token.type !== 'name' || KEYWORDS.has(token.value)) this.fail('expected parameter name', token);
      if (names.has(token.value)) this.fail(`duplicate argument '${token.value}'`, token);
      names.add(token.value);
      return token.value;
    };
    let seenDefault = false;
    while (!this.isOp(':')) {
      if (this.acceptOp('**')) {
        params.push({ name: paramName(), kind: 'kwarg' });
      } else if (this.acceptOp('*')) {
        if (seenStar) this.fail('* argument may appear only once');
        seenStar = true;
        if (this.peek().type === 'name') params.push({ name: paramName(), kind: 'vararg' });
      } else if (this.acceptOp('/')) {
        // positional-only marker: no effect on evaluation here
      } else {
        const name = paramName();
        const param: LambdaParam = { name, kind: seenStar ? 'kwonly' : 'positional' };
        if (this.acceptOp('=')) {
          param.default = this.expression();
          if (!seenStar) seenDefault = true;
        } else if (seenDefault && !seenStar) {
          this.fail('non-default argument follows default argument');
        }
        params.push(param);
      }
      if (!this.acceptOp(',')) break;
    }
    this.expectOp(':');
    return { k: 'lambda', params, body: this.expression() };
  }

  private disjunction(): Node {
    const first = this.conjunction();
    if (!this.isKeyword('or')) return first;
    const values = [first];
    while (this.acceptKeyword('or')) values.push(this.conjunction());
    return { k: 'boolop', op: 'or', values };
  }

  private conjunction(): Node {
    const first = this.inversion();
    if (!this.isKeyword('and')) return first;
    const values = [first];
    while (this.acceptKeyword('and')) values.push(this.inversion());
    return { k: 'boolop', op: 'and', values };
  }

  private inversion(): Node {
    if (this.acceptKeyword('not')) return { k: 'not', operand: this.inversion() };
    return this.comparison();
  }

  private compareOp(): CompareOp | null {
    const token = this.peek();
    if (token.type === 'op') {
      if (['==', '!=', '<', '<=', '>', '>='].includes(token.value)) {
        this.next();
        return token.value as CompareOp;
      }
      return null;
    }
    if (token.type === 'name') {
      if (token.value === 'in') {
        this.next();
        return 'in';
      }
      if (token.value === 'not' && this.isKeyword('in', 1)) {
        this.next();
        this.next();
        return 'not in';
      }
      if (token.value === 'is') {
        this.next();
        if (this.acceptKeyword('not')) return 'is not';
        return 'is';
      }
    }
    return null;
  }

  private comparison(): Node {
    const left = this.bitOr();
    const ops: CompareOp[] = [];
    const comparators: Node[] = [];
    for (;;) {
      const op = this.compareOp();
      if (!op) break;
      ops.push(op);
      comparators.push(this.bitOr());
    }
    if (ops.length === 0) return left;
    return { k: 'compare', left, ops, comparators };
  }

  private binaryLevel(operators: string[], operand: () => Node): Node {
    let left = operand();
    for (;;) {
      const token = this.peek();
      if (token.type !== 'op' || !operators.includes(token.value)) return left;
      this.next();
      const right = operand();
      left = { k: 'binop', op: token.value as BinaryOp, left, right };
    }
  }

  private bitOr(): Node {
    return this.binaryLevel(['|'], () => this.bitXor());
  }

  private bitXor(): Node {
    return this.binaryLevel(['^'], () => this.bitAnd());
  }

  private bitAnd(): Node {
    return this.binaryLevel(['&'], () => this.shift());
  }

  private shift(): Node {
    return this.binaryLevel(['<<', '>>'], () => this.sum());
  }

  private sum(): Node {
    return this.binaryLevel(['+', '-'], () => this.term());
  }

  private term(): Node {
    return this.binaryLevel(['*', '/', '//', '%', '@'], () => this.factor());
  }

  private factor(): Node {
    const token = this.peek();
    if (token.type === 'op' && (token.value === '-' || token.value === '+' || token.value === '~')) {
      this.next();
      return { k: 'unary', op: token.value, operand: this.factor() };
    }
    return this.power();
  }

  private power(): Node {
    const base = this.awaitPrimary();
    if (this.acceptOp('**')) {
      return { k: 'binop', op: '**', left: base, right: this.factor() };
    }
    return base;
  }

  private awaitPrimary(): Node {
    if (this.isKeyword('await')) this.fail("'await' outside function");
    return this.primary();
  }

  private primary(): Node {
    let node = this.atom();
    for (;;) {
      if (this.acceptOp('.')) {
        const token = this.next();
        if (token.type !== 'name' || KEYWORDS.has(token.value)) this.fail('expected attribute name', token);
        node = { k: 'attribute', value: node, attr: token.value };
      } else if (this.isOp('(')) {
        this.next();
        node = this.callArguments(node);
      } else if (this.isOp('[')) {
        this.next();
        node = { k: 'subscript', value: node, index: this.slices() };
        this.expectOp(']');
      } else {
        return node;
      }
    }
  }

  private callArguments(func: Node): Node {
    const args: Node[] = [];
    const keywords: Keyword[] = [];
    while (!this.isOp(')')) {
      if (this.acceptOp('*')) {
        args.push({ k: 'starred', value: this.expression() });
      } else if (this.acceptOp('**')) {
        keywords.push({ arg: null, value: this.expression() });
      } else {
        const token = this.peek();
        if (token.type === 'name' && !KEYWORDS.has(token.value) && this.isOp('=', 1)) {
          this.next();
          this.next();
          if (keywords.some((keyword) => keyword.arg === token.value)) {
            this.fail(`keyword argument repeated: ${token.value}`, token);
          }
          keywords.push({ arg: token.value, value: this.expression() });
        } else {
          if (keywords.length > 0 && keywords.some((keyword) => keyword.arg !== null)) {
            this.fail('positional argument follows keyword argument');
          }
          const value = this.namedExpression();
          if (this.isKeyword('for') || this.isKeyword('async')) {
            const generators = this.comprehensionClauses();
            const genexp: Node = { k: 'genexp', elt: value, generators };
            // A bare generator must be the sole argument.
            if (args.length > 0 || keywords.length > 0 || !this.isOp(')')) {
              if (!(this.isOp(',') && this.isOp(')', 1) && args.length === 0 && keywords.length === 0)) {
                this.fail('Generator expression must be parenthesized');
              }
            }
            args.push(genexp);
          } else {
            args.push(value);
          }
        }
      }
      if (!this.acceptOp(',')) break;
    }
    this.expectOp(')');
    return { k: 'call', func, args, keywords };
  }

  /** slices: slice | slice (',' slice)* [','] */
  private slices(): Node {
    const first = this.slice();
    if (!this.isOp(',')) return first;
    const elts = [first];
    while (this.acceptOp(',')) {
      if (this.isOp(']')) break;
      elts.push(this.slice());
    }
    return { k: 'tuple', elts };
  }

  private slice(): Node {
    let lower: Node | null = null;
    if (!this.isOp(':')) {
      if (this.isOp('*')) return this.starExpression();
      lower = this.namedExpression();
      if (!this.isOp(':')) return lower;
    }
    this.expectOp(':');
    let upper: Node | null = null;
    let step: Node | null = null;
    if (!this.isOp(':') && !this.isOp(']') && !this.isOp(',')) upper = this.expression();
    if (this.acceptOp(':')) {
      if (!this.isOp(']') && !this.isOp(',')) step = this.expression();
    }
    return { k: 'slice', lower, upper, step };
  }

  /** for_if_clauses */
  private comprehensionClauses(): Comprehension[] {
    const generators: Comprehension[] = [];
    while (this.isKeyword('for') || this.isKeyword('async')) {
      if (this.acceptKeyword('async')) this.fail('asynchronous comprehension outside of an asynchronous function');
      this.next(); // for
      const target = this.targetList();
      if (!this.acceptKeyword('in')) this.fail("expected 'in'");
      const iter = this.disjunction();
      const ifs: Node[] = [];
      while (this.acceptKeyword('if')) ifs.push(this.disjunction());
      generators.push({ target, iter, ifs });
    }
    return generators;
  }

  /** star_targets for comprehension variables. */
  private targetList(): Node {
    const first = this.target();
    if (!this.isOp(',')) return first;
    const elts = [first];
    while (this.acceptOp(',')) {
      if (this.isKeyword('in')) break;
      elts.push(this.target());
    }
    return { k: 'tuple', elts };
  }

  private target(): Node {
    if (this.acceptOp('*')) return { k: 'starred', value: this.target() };
    if (this.acceptOp('(')) {
      if (this.acceptOp(')')) return { k: 'tuple', elts: [] };
      const inner = this.targetList();
      this.expectOp(')');
      return inner.k === 'tuple' ? inner : inner;
    }
    if (this.acceptOp('[')) {
      const elts: Node[] = [];
      while (!this.isOp(']')) {
        elts.push(this.target());
        if (!this.acceptOp(',')) break;
      }
      this.expectOp(']');
      return { k: 'list', elts };
    }
    // Attribute/subscript targets are legal Python but have no use in
    // expressions; parse a primary and validate its shape.
    const node = this.primary();
    if (node.k !== 'name' && node.k !== 'attribute' && node.k !== 'subscript') {
      this.fail('cannot assign to expression');
    }
    if (node.k === 'name' && KEYWORDS.has(node.id)) this.fail('cannot assign to keyword');
    return node;
  }

  private stringConcat(): Node {
    const parts: CompiledFStringPart[] = [];
    let hasF = false;
    let plain = '';
    let sawBytes = false;
    let sawText = false;
    while (this.peek().type === 'string') {
      const token = this.next();
      if (token.bytes) sawBytes = true;
      else sawText = true;
      if (token.fstring) {
        hasF = true;
        if (plain) parts.push({ literal: plain });
        plain = '';
        for (const part of token.fstring) parts.push(this.compileFStringPart(part));
      } else {
        plain += token.str ?? '';
      }
    }
    if (sawBytes && sawText) this.fail('cannot mix bytes and nonbytes literals');
    if (!hasF) return { k: 'const', value: plain };
    if (plain) parts.push({ literal: plain });
    return { k: 'fstring', parts };
  }

  private compileFStringPart(part: FStringPart): CompiledFStringPart {
    if (part.expr === undefined) return { literal: part.literal ?? '' };
    let expr: Node;
    try {
      expr = new Parser(`(${part.expr})`).parseEvalInput();
    } catch (error) {
      if (error instanceof PySyntaxError) {
        throw new PySyntaxError(`f-string: ${error.message}`, (part.offset ?? 0) + error.offset);
      }
      throw error;
    }
    const compiled: CompiledFStringPart = { expr };
    if (part.conversion) compiled.conversion = part.conversion;
    if (part.selfDoc !== undefined) compiled.selfDoc = part.selfDoc;
    if (part.spec) compiled.spec = part.spec.map((entry) => this.compileFStringPart(entry));
    return compiled;
  }

  private atom(): Node {
    const token = this.peek();
    switch (token.type) {
      case 'number':
        this.next();
        return { k: 'const', value: parseNumber(token.value, token.offset) };
      case 'string':
        return this.stringConcat();
      case 'name': {
        if (token.value === 'True') { this.next(); return { k: 'const', value: true }; }
        if (token.value === 'False') { this.next(); return { k: 'const', value: false }; }
        if (token.value === 'None') { this.next(); return { k: 'const', value: null }; }
        if (KEYWORDS.has(token.value)) this.fail('unexpected keyword');
        this.next();
        return { k: 'name', id: token.value };
      }
      case 'op':
        break;
      default:
        this.fail('unexpected end of input');
    }
    if (token.value === '...') {
      this.next();
      return { k: 'const', value: ELLIPSIS };
    }
    if (token.value === '(') {
      this.next();
      if (this.acceptOp(')')) return { k: 'tuple', elts: [] };
      const first = this.isOp('*') ? this.starExpression() : this.namedExpression();
      if (this.isKeyword('for') || this.isKeyword('async')) {
        if (first.k === 'starred') this.fail('iterable unpacking cannot be used in comprehension');
        const generators = this.comprehensionClauses();
        this.expectOp(')');
        return { k: 'genexp', elt: first, generators };
      }
      if (this.acceptOp(')')) {
        if (first.k === 'starred') this.fail("can't use starred expression here");
        return first;
      }
      const elts = [first];
      while (this.acceptOp(',')) {
        if (this.isOp(')')) break;
        elts.push(this.isOp('*') ? this.starExpression() : this.namedExpression());
      }
      this.expectOp(')');
      return { k: 'tuple', elts };
    }
    if (token.value === '[') {
      this.next();
      if (this.acceptOp(']')) return { k: 'list', elts: [] };
      const first = this.isOp('*') ? this.starExpression() : this.namedExpression();
      if (this.isKeyword('for') || this.isKeyword('async')) {
        if (first.k === 'starred') this.fail('iterable unpacking cannot be used in comprehension');
        const generators = this.comprehensionClauses();
        this.expectOp(']');
        return { k: 'listcomp', elt: first, generators };
      }
      const elts = [first];
      while (this.acceptOp(',')) {
        if (this.isOp(']')) break;
        elts.push(this.isOp('*') ? this.starExpression() : this.namedExpression());
      }
      this.expectOp(']');
      return { k: 'list', elts };
    }
    if (token.value === '{') {
      this.next();
      if (this.acceptOp('}')) return { k: 'dict', keys: [], values: [] };
      // dict: ('**' bitor | expression ':' expression) ...
      if (this.acceptOp('**')) {
        const keys: (Node | null)[] = [null];
        const values: Node[] = [this.bitOr()];
        return this.dictRest(keys, values);
      }
      const first = this.isOp('*') ? this.starExpression() : this.namedExpression();
      if (this.acceptOp(':')) {
        if (first.k === 'starred') this.fail('cannot use a starred expression in a dictionary value');
        const value = this.expression();
        if (this.isKeyword('for') || this.isKeyword('async')) {
          const generators = this.comprehensionClauses();
          this.expectOp('}');
          return { k: 'dictcomp', key: first, value, generators };
        }
        return this.dictRest([first], [value]);
      }
      if (this.isKeyword('for') || this.isKeyword('async')) {
        if (first.k === 'starred') this.fail('iterable unpacking cannot be used in comprehension');
        const generators = this.comprehensionClauses();
        this.expectOp('}');
        return { k: 'setcomp', elt: first, generators };
      }
      const elts = [first];
      while (this.acceptOp(',')) {
        if (this.isOp('}')) break;
        elts.push(this.isOp('*') ? this.starExpression() : this.namedExpression());
      }
      this.expectOp('}');
      return { k: 'set', elts };
    }
    return this.fail('unexpected token');
  }

  private dictRest(keys: (Node | null)[], values: Node[]): Node {
    while (this.acceptOp(',')) {
      if (this.isOp('}')) break;
      if (this.acceptOp('**')) {
        keys.push(null);
        values.push(this.bitOr());
        continue;
      }
      keys.push(this.expression());
      this.expectOp(':');
      values.push(this.expression());
    }
    this.expectOp('}');
    return { k: 'dict', keys, values };
  }
}

/** Python's Ellipsis singleton. */
export const ELLIPSIS = Object.freeze({ __pyEllipsis: true });

/** Parse one Python expression (eval mode). Throws PySyntaxError. */
export function parsePythonExpression(source: string): Node {
  return new Parser(source).parseEvalInput();
}

export { PySyntaxError, makeTuple };
