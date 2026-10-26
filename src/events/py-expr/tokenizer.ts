/**
 * Tokenizer for Python expressions (the subset of Python's lexical grammar
 * that can appear inside `eval()` input).
 *
 * Produces NAME / NUMBER / STRING / OP tokens. Newlines and backslash
 * continuations are treated as whitespace (Python's eval of an expression
 * spanning lines only works inside brackets, and EOtF expressions are
 * single-line). Comments run to end of line.
 */

export class PySyntaxError extends Error {
  readonly pyType = 'SyntaxError';
  readonly offset: number;
  constructor(message: string, offset: number) {
    super(message);
    this.name = 'PySyntaxError';
    this.offset = offset;
  }
}

export type TokenType = 'name' | 'number' | 'string' | 'op' | 'end';

export interface FStringPart {
  /** Literal text (already unescaped) when `expr` is undefined. */
  literal?: string;
  /** Embedded expression source. */
  expr?: string;
  /** `!r` / `!s` / `!a` conversion. */
  conversion?: string;
  /** Format spec text after `:` (may itself contain {} fields). */
  spec?: FStringPart[];
  /** `{x=}` debugging form: the literal text echoed before the value. */
  selfDoc?: string;
  /** Offset of `expr` inside the original source, for errors. */
  offset?: number;
}

export interface Token {
  type: TokenType;
  /** Name text, operator text, or raw number text. */
  value: string;
  /** Decoded string literal value (type === 'string'). */
  str?: string;
  /** Parsed f-string parts (type === 'string' with an f prefix). */
  fstring?: FStringPart[];
  /** Bytes literal (b'') — kept as a str, Python would make bytes. */
  bytes?: boolean;
  offset: number;
}

const OPERATORS = [
  '**=', '//=', '>>=', '<<=', '...',
  '**', '//', '<<', '>>', '<=', '>=', '==', '!=', '->', ':=', '+=', '-=', '*=', '/=',
  '%=', '&=', '|=', '^=', '@=',
  '+', '-', '*', '/', '%', '@', '&', '|', '^', '~', '<', '>', '(', ')', '[', ']',
  '{', '}', ',', ':', '.', ';', '=',
];

const NAME_START = /[A-Za-z_À-￿]/;
const NAME_CHAR = /[A-Za-z0-9_À-￿]/;

function decodeEscapes(body: string, raw: boolean, offset: number): string {
  if (raw) return body;
  let out = '';
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    const next = body[i + 1];
    if (next === undefined) {
      out += '\\';
      break;
    }
    i++;
    switch (next) {
      case '\n': break; // line continuation inside a string
      case '\\': out += '\\'; break;
      case '\'': out += '\''; break;
      case '"': out += '"'; break;
      case 'a': out += '\x07'; break;
      case 'b': out += '\b'; break;
      case 'f': out += '\f'; break;
      case 'n': out += '\n'; break;
      case 'r': out += '\r'; break;
      case 't': out += '\t'; break;
      case 'v': out += '\v'; break;
      case 'x': {
        const hex = body.slice(i + 1, i + 3);
        if (!/^[0-9A-Fa-f]{2}$/.test(hex)) {
          throw new PySyntaxError('truncated \\xXX escape', offset + i);
        }
        out += String.fromCharCode(parseInt(hex, 16));
        i += 2;
        break;
      }
      case 'u':
      case 'U': {
        const length = next === 'u' ? 4 : 8;
        const hex = body.slice(i + 1, i + 1 + length);
        if (!new RegExp(`^[0-9A-Fa-f]{${length}}$`).test(hex)) {
          throw new PySyntaxError(`truncated \\${next} escape`, offset + i);
        }
        out += String.fromCodePoint(parseInt(hex, 16));
        i += length;
        break;
      }
      case 'N':
        throw new PySyntaxError('\\N{...} escapes are not supported', offset + i);
      default:
        if (/[0-7]/.test(next)) {
          let digits = next;
          while (digits.length < 3 && /[0-7]/.test(body[i + 1] ?? '')) {
            digits += body[i + 1];
            i++;
          }
          out += String.fromCharCode(parseInt(digits, 8));
        } else {
          // Unknown escapes are kept verbatim (a DeprecationWarning in Python).
          out += '\\' + next;
        }
    }
  }
  return out;
}

/** Split an f-string body into literal and `{expr}` parts. */
function parseFString(body: string, raw: boolean, offset: number): FStringPart[] {
  const parts: FStringPart[] = [];
  let literal = '';
  let i = 0;
  const flush = () => {
    if (literal) parts.push({ literal: decodeEscapes(literal, raw, offset) });
    literal = '';
  };
  while (i < body.length) {
    const ch = body[i];
    if (ch === '{') {
      if (body[i + 1] === '{') {
        literal += '{';
        i += 2;
        continue;
      }
      flush();
      // Find the end of the expression: matching `}` at depth 0, honouring
      // nested brackets and string literals; split off !conv and :spec.
      let depth = 0;
      let j = i + 1;
      let quote: string | null = null;
      let exprEnd = -1;
      let conversion: string | undefined;
      let specStart = -1;
      for (; j < body.length; j++) {
        const c = body[j];
        if (quote) {
          if (c === '\\') j++;
          else if (body.startsWith(quote, j)) {
            j += quote.length - 1;
            quote = null;
          }
          continue;
        }
        if (c === '\'' || c === '"') {
          quote = body.startsWith(c.repeat(3), j) ? c.repeat(3) : c;
          j += quote.length - 1;
          continue;
        }
        if (c === '(' || c === '[' || c === '{') depth++;
        else if (c === ')' || c === ']' || (c === '}' && depth > 0)) depth--;
        else if (depth === 0) {
          if (c === '}') {
            if (exprEnd < 0) exprEnd = j;
            break;
          }
          if (c === '!' && body[j + 1] !== '=' && exprEnd < 0) {
            exprEnd = j;
            conversion = body[j + 1];
            j++;
            continue;
          }
          if (c === ':' && specStart < 0) {
            if (exprEnd < 0) exprEnd = j;
            specStart = j + 1;
            // The spec runs to the matching `}`; nested {} fields allowed.
            let specDepth = 0;
            let k = specStart;
            for (; k < body.length; k++) {
              if (body[k] === '{') specDepth++;
              else if (body[k] === '}') {
                if (specDepth === 0) break;
                specDepth--;
              }
            }
            j = k;
            break;
          }
        }
      }
      if (j >= body.length) throw new PySyntaxError("f-string: expecting '}'", offset + i);
      let exprSource = body.slice(i + 1, exprEnd);
      let selfDoc: string | undefined;
      const selfDocMatch = exprSource.match(/^([\s\S]*?)(\s*=\s*)$/);
      if (selfDocMatch && !/[=!<>]$/.test(selfDocMatch[1].trimEnd())) {
        selfDoc = exprSource;
        exprSource = selfDocMatch[1];
      }
      if (!exprSource.trim()) throw new PySyntaxError('f-string: empty expression not allowed', offset + i);
      if (conversion !== undefined && !['r', 's', 'a'].includes(conversion)) {
        throw new PySyntaxError("f-string: invalid conversion character: expected 's', 'r', or 'a'", offset + i);
      }
      const part: FStringPart = { expr: exprSource, offset: offset + i + 1 };
      if (conversion) part.conversion = conversion;
      if (selfDoc !== undefined) part.selfDoc = selfDoc;
      if (specStart >= 0) part.spec = parseFString(body.slice(specStart, j), raw, offset + specStart);
      parts.push(part);
      i = j + 1;
      continue;
    }
    if (ch === '}') {
      if (body[i + 1] === '}') {
        literal += '}';
        i += 2;
        continue;
      }
      throw new PySyntaxError("f-string: single '}' is not allowed", offset + i);
    }
    if (ch === '\\' && !raw) {
      literal += ch + (body[i + 1] ?? '');
      i += 2;
      continue;
    }
    literal += ch;
    i++;
  }
  flush();
  return parts;
}

export function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = source.length;
  while (i < n) {
    const ch = source[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f') {
      i++;
      continue;
    }
    if (ch === '\\' && (source[i + 1] === '\n' || source[i + 1] === '\r')) {
      i += 2;
      continue;
    }
    if (ch === '#') {
      while (i < n && source[i] !== '\n') i++;
      continue;
    }
    const start = i;

    // String literal, possibly prefixed.
    const prefixMatch = /^([rRbBuUfF]{0,2})(['"])/.exec(source.slice(i, i + 3));
    if (prefixMatch && (prefixMatch[1].length === 0 || NAME_START.test(ch))) {
      const prefix = prefixMatch[1].toLowerCase();
      const validPrefix = ['', 'r', 'u', 'b', 'br', 'rb', 'f', 'fr', 'rf'].includes(prefix);
      if (validPrefix) {
        const quoteChar = prefixMatch[2];
        let j = i + prefix.length;
        const triple = source.startsWith(quoteChar.repeat(3), j);
        const quote = triple ? quoteChar.repeat(3) : quoteChar;
        j += quote.length;
        const bodyStart = j;
        let closed = false;
        while (j < n) {
          const c = source[j];
          if (c === '\\') {
            j += 2;
            continue;
          }
          if (!triple && (c === '\n')) break;
          if (source.startsWith(quote, j)) {
            closed = true;
            break;
          }
          j++;
        }
        if (!closed) {
          throw new PySyntaxError(
            triple ? 'unterminated triple-quoted string literal' : 'unterminated string literal',
            start,
          );
        }
        const body = source.slice(bodyStart, j);
        const raw = prefix.includes('r');
        const token: Token = { type: 'string', value: source.slice(start, j + quote.length), offset: start };
        if (prefix.includes('f')) {
          token.fstring = parseFString(body, raw, bodyStart);
          token.str = '';
        } else {
          token.str = decodeEscapes(body, raw, bodyStart);
          if (prefix.includes('b')) token.bytes = true;
        }
        tokens.push(token);
        i = j + quote.length;
        continue;
      }
    }

    if (NAME_START.test(ch)) {
      let j = i + 1;
      while (j < n && NAME_CHAR.test(source[j])) j++;
      tokens.push({ type: 'name', value: source.slice(i, j), offset: start });
      i = j;
      continue;
    }

    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(source[i + 1] ?? ''))) {
      const rest = source.slice(i);
      const match =
        /^0[xX](?:_?[0-9a-fA-F])+/.exec(rest) ??
        /^0[oO](?:_?[0-7])+/.exec(rest) ??
        /^0[bB](?:_?[01])+/.exec(rest) ??
        /^(?:(?:[0-9](?:_?[0-9])*)?\.[0-9](?:_?[0-9])*|[0-9](?:_?[0-9])*\.?)(?:[eE][+-]?[0-9](?:_?[0-9])*)?[jJ]?/.exec(rest);
      if (!match) throw new PySyntaxError('invalid number literal', start);
      let text = match[0];
      const after = source[i + text.length];
      if (after !== undefined && NAME_CHAR.test(after)) {
        throw new PySyntaxError('invalid decimal literal', start);
      }
      if (/[jJ]$/.test(text)) throw new PySyntaxError('complex literals are not supported', start);
      // `1.` followed by a name (e.g. `1.real`) is a number then attribute in
      // Python only for floats; keep Python's greedy behaviour.
      if (/^0[0-9]+$/.test(text.replace(/_/g, '')) && /[1-9]/.test(text)) {
        throw new PySyntaxError('leading zeros in decimal integer literals are not permitted', start);
      }
      tokens.push({ type: 'number', value: text, offset: start });
      i += text.length;
      continue;
    }

    let matched: string | null = null;
    for (const op of OPERATORS) {
      if (source.startsWith(op, i)) {
        matched = op;
        break;
      }
    }
    if (matched === null) {
      if (ch === '!') throw new PySyntaxError("invalid syntax: '!'", start);
      throw new PySyntaxError(`invalid character '${ch}'`, start);
    }
    tokens.push({ type: 'op', value: matched, offset: start });
    i += matched.length;
  }
  tokens.push({ type: 'end', value: '', offset: n });
  return tokens;
}
