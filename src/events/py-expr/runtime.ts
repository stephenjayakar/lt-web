/**
 * Python semantics for the expression evaluator: truthiness, equality,
 * ordering, arithmetic, containment, iteration, str()/repr(), attribute and
 * subscript access, calls, builtins and the methods of str/list/dict/set.
 *
 * Engine ("host") objects are read through their JS properties, exactly as
 * the previous translated-JavaScript evaluator read them.
 */
import {
  PyFloat,
  formatFloat,
  isCounter,
  isFloatValue,
  isTuple,
  makeFloat,
  makeNumber,
  makeTuple,
  numericValue,
} from './values';

// ---------------------------------------------------------------------------
// Exceptions
// ---------------------------------------------------------------------------

export class PyException extends Error {
  readonly pyType: string;
  constructor(pyType: string, message: string) {
    super(`${pyType}: ${message}`);
    this.name = 'PyException';
    this.pyType = pyType;
  }
}

export function raise(pyType: string, message: string): never {
  throw new PyException(pyType, message);
}

// ---------------------------------------------------------------------------
// Callables
// ---------------------------------------------------------------------------

/** Python-convention entry point attached to builtins, lambdas and methods. */
export const PY_CALL = Symbol('pyCall');
export type Kwargs = Record<string, any> | null;
export type PyCallImpl = (args: any[], kwargs: Kwargs) => any;

export interface PyCallable {
  (...args: any[]): any;
  [PY_CALL]: PyCallImpl;
  pyName?: string;
}

/** Make a JS function that also accepts Python keyword arguments. */
export function pyFunction(name: string, impl: PyCallImpl): PyCallable {
  const fn = ((...args: any[]) => impl(args, null)) as PyCallable;
  fn[PY_CALL] = impl;
  fn.pyName = name;
  return fn;
}

/** Builtin type objects (int, str, ...) for isinstance()/type(). */
export interface PyType extends PyCallable {
  pyTypeName: string;
  __name__: string;
}

function pyTypeObject(name: string, impl: PyCallImpl): PyType {
  const fn = pyFunction(name, impl) as PyType;
  fn.pyTypeName = name;
  fn.__name__ = name;
  return fn;
}

// ---------------------------------------------------------------------------
// Type inspection
// ---------------------------------------------------------------------------

export function isNone(value: unknown): value is null | undefined {
  return value === null || value === undefined;
}

export function isIntLike(value: unknown): boolean {
  return typeof value === 'boolean' || (typeof value === 'number' && Number.isInteger(value));
}

export function isNumberLike(value: unknown): boolean {
  return typeof value === 'number' || typeof value === 'boolean' || value instanceof PyFloat;
}

function isPlainObject(value: unknown): value is Record<string, any> {
  if (!value || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** A Python dict: Map, or a plain JSON-like object that is not a host wrapper. */
export function isDictLike(value: unknown): boolean {
  if (value instanceof Map) return true;
  return isPlainObject(value) && !('_raw' in value);
}

export function typeName(value: unknown): string {
  if (isNone(value)) return 'NoneType';
  if (typeof value === 'boolean') return 'bool';
  if (typeof value === 'number') return Number.isInteger(value) ? 'int' : 'float';
  if (value instanceof PyFloat) return 'float';
  if (typeof value === 'string') return 'str';
  if (Array.isArray(value)) return isTuple(value) ? 'tuple' : 'list';
  if (value instanceof Map) return 'dict';
  if (value instanceof Set) return 'set';
  if (typeof value === 'function') {
    if ((value as PyType).pyTypeName) return 'type';
    return 'function';
  }
  if (isGenerator(value)) return 'generator';
  if (isPlainObject(value) && !('_raw' in value)) return 'dict';
  const ctor = (value as any)?.constructor?.name;
  return typeof ctor === 'string' && ctor !== 'Object' ? ctor : 'object';
}

function isGenerator(value: unknown): boolean {
  return !!value && typeof value === 'object' &&
    typeof (value as any).next === 'function' &&
    typeof (value as any)[Symbol.iterator] === 'function';
}

// ---------------------------------------------------------------------------
// Truthiness
// ---------------------------------------------------------------------------

export function pyBool(value: unknown): boolean {
  if (value === null || value === undefined || value === false) return false;
  if (value === true) return true;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') return value.length > 0;
  if (value instanceof PyFloat) return value.value !== 0;
  if (Array.isArray(value)) return value.length > 0;
  if (value instanceof Map || value instanceof Set) return value.size > 0;
  // A plain JSON-like object is a Python dict; other host objects (engine
  // wrappers, component objects) are ordinary Python objects: truthy.
  if (isPlainObject(value) && !('_raw' in value)) return Object.keys(value).length > 0;
  return true;
}

// ---------------------------------------------------------------------------
// Equality and ordering
// ---------------------------------------------------------------------------

function unwrapHost(value: any): any {
  return value && typeof value === 'object' && '_raw' in value ? value._raw : value;
}

export function pyEq(a: any, b: any): boolean {
  if (a === b) return true;
  if (isNone(a) || isNone(b)) return isNone(a) && isNone(b);
  const na = numericValue(a);
  if (na !== null) {
    const nb = numericValue(b);
    return nb !== null && na === nb;
  }
  if (typeof a === 'string' || typeof b === 'string') return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!pyEq(a[i], b[i])) return false;
    return true;
  }
  if (a instanceof Set || b instanceof Set) {
    if (!(a instanceof Set) || !(b instanceof Set) || a.size !== b.size) return false;
    for (const entry of a) if (!setHas(b, entry)) return false;
    return true;
  }
  if (isDictLike(a) && isDictLike(b)) {
    const ka = dictKeys(a);
    const kb = dictKeys(b);
    if (ka.length !== kb.length) return false;
    for (const key of ka) {
      if (!dictHas(b, key)) return false;
      if (!pyEq(dictGet(a, key), dictGet(b, key))) return false;
    }
    return true;
  }
  const ra = unwrapHost(a);
  const rb = unwrapHost(b);
  return ra === rb;
}

/** Python `is`: identity, seeing through host wrappers. */
export function pyIs(a: any, b: any): boolean {
  if (isNone(a) || isNone(b)) return isNone(a) && isNone(b);
  if (a === b) return true;
  if (typeof a === 'object' && typeof b === 'object') return unwrapHost(a) === unwrapHost(b);
  return false;
}

/** Three-way comparison for ordering; raises TypeError like Python. */
function orderingCompare(a: any, b: any, op: string): number {
  const na = numericValue(a);
  const nb = numericValue(b);
  if (na !== null && nb !== null) {
    if (Number.isNaN(na) || Number.isNaN(nb)) return Number.NaN;
    return na < nb ? -1 : na > nb ? 1 : 0;
  }
  if (typeof a === 'string' && typeof b === 'string') {
    return a < b ? -1 : a > b ? 1 : 0;
  }
  if (Array.isArray(a) && Array.isArray(b) && isTuple(a) === isTuple(b)) {
    const length = Math.min(a.length, b.length);
    for (let i = 0; i < length; i++) {
      if (!pyEq(a[i], b[i])) return orderingCompare(a[i], b[i], op);
    }
    return a.length - b.length;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    // An engine position (plain array) against a tuple literal: Python sees
    // two tuples. Compare structurally.
    if (!isTuple(a) || !isTuple(b)) {
      const length = Math.min(a.length, b.length);
      for (let i = 0; i < length; i++) {
        if (!pyEq(a[i], b[i])) return orderingCompare(a[i], b[i], op);
      }
      return a.length - b.length;
    }
  }
  if (a instanceof Set && b instanceof Set) {
    const aSubB = [...a].every((entry) => setHas(b, entry));
    const bSubA = [...b].every((entry) => setHas(a, entry));
    if (aSubB && bSubA) return 0;
    if (aSubB) return -1;
    if (bSubA) return 1;
    return Number.NaN;
  }
  return raise('TypeError',
    `'${op}' not supported between instances of '${typeName(a)}' and '${typeName(b)}'`);
}

export function pyCompare(op: string, a: any, b: any): boolean {
  switch (op) {
    case '==': return pyEq(a, b);
    case '!=': return !pyEq(a, b);
    case 'in': return pyContains(b, a);
    case 'not in': return !pyContains(b, a);
    case 'is': return pyIs(a, b);
    case 'is not': return !pyIs(a, b);
    default: {
      const c = orderingCompare(a, b, op);
      if (Number.isNaN(c)) return false;
      switch (op) {
        case '<': return c < 0;
        case '<=': return c <= 0;
        case '>': return c > 0;
        case '>=': return c >= 0;
      }
      return raise('SyntaxError', `unknown comparison ${op}`);
    }
  }
}

export function pyLess(a: any, b: any): boolean {
  return pyCompare('<', a, b);
}

// ---------------------------------------------------------------------------
// Containers
// ---------------------------------------------------------------------------

function hashKey(value: any): any {
  if (value instanceof PyFloat) return value.value;
  return value;
}

function isHashable(value: any): boolean {
  if (Array.isArray(value)) return isTuple(value) || (value as any[]).every(isHashable);
  return !(value instanceof Map || value instanceof Set || isDictLike(value));
}

export function setHas(set: Set<any>, value: any): boolean {
  const key = hashKey(value);
  if (set.has(key)) return true;
  if (typeof key === 'boolean' && set.has(key ? 1 : 0)) return true;
  if (typeof key === 'number' && (key === 0 || key === 1) && set.has(key === 1)) return true;
  if (key && typeof key === 'object') {
    for (const entry of set) if (pyEq(entry, key)) return true;
  }
  return false;
}

export function setAdd(set: Set<any>, value: any): void {
  if (!isHashable(value)) raise('TypeError', `unhashable type: '${typeName(value)}'`);
  if (!setHas(set, value)) set.add(hashKey(value));
}

export function makeSet(values: Iterable<any>): Set<any> {
  const set = new Set<any>();
  for (const value of values) setAdd(set, value);
  return set;
}

export function dictKeys(dict: any): any[] {
  if (dict instanceof Map) return [...dict.keys()];
  return Object.keys(dict);
}

function mapFindKey(map: Map<any, any>, key: any): { found: boolean; key: any } {
  const k = hashKey(key);
  if (map.has(k)) return { found: true, key: k };
  if (k && typeof k === 'object') {
    for (const existing of map.keys()) if (pyEq(existing, k)) return { found: true, key: existing };
  }
  return { found: false, key: k };
}

export function dictHas(dict: any, key: any): boolean {
  if (dict instanceof Map) return mapFindKey(dict, key).found;
  if (typeof key !== 'string' && typeof key !== 'number') return false;
  return Object.prototype.hasOwnProperty.call(dict, String(key));
}

export function dictGet(dict: any, key: any): any {
  if (dict instanceof Map) {
    const found = mapFindKey(dict, key);
    return found.found ? dict.get(found.key) : undefined;
  }
  return dict[String(key)];
}

export function dictSet(dict: any, key: any, value: any): void {
  if (dict instanceof Map) {
    if (!isHashable(key)) raise('TypeError', `unhashable type: '${typeName(key)}'`);
    dict.set(mapFindKey(dict, key).key, value);
  } else {
    dict[String(key)] = value;
  }
}

/** Build a dict value: plain object when every key is a string. */
export function makeDict(entries: [any, any][]): any {
  if (entries.every(([key]) => typeof key === 'string')) {
    const object: Record<string, any> = {};
    for (const [key, value] of entries) object[key] = value;
    return object;
  }
  const map = new Map<any, any>();
  for (const [key, value] of entries) dictSet(map, key, value);
  return map;
}

export function pyIter(value: any): Iterable<any> {
  if (typeof value === 'string') return Array.from(value);
  if (Array.isArray(value)) return value;
  if (value instanceof Map) return value.keys();
  if (value instanceof Set) return value;
  if (value && typeof value === 'object') {
    if (typeof value[Symbol.iterator] === 'function') return value as Iterable<any>;
    if (isPlainObject(value) && !('_raw' in value)) return Object.keys(value);
  }
  return raise('TypeError', `'${typeName(value)}' object is not iterable`);
}

export function toArray(value: any): any[] {
  const iterable = pyIter(value);
  return Array.isArray(iterable) ? iterable.slice() : Array.from(iterable);
}

export function pyContains(container: any, item: any): boolean {
  if (typeof container === 'string') {
    if (typeof item !== 'string') {
      raise('TypeError', `'in <string>' requires string as left operand, not ${typeName(item)}`);
    }
    return container.includes(item);
  }
  if (Array.isArray(container)) {
    for (const entry of container) if (pyEq(entry, item)) return true;
    return false;
  }
  if (container instanceof Set) return setHas(container, item);
  if (container instanceof Map) return mapFindKey(container, item).found;
  if (isNone(container)) raise('TypeError', "argument of type 'NoneType' is not iterable");
  if (container && typeof container === 'object') {
    if (isPlainObject(container) && !('_raw' in container) && typeof container.has !== 'function' &&
        typeof container.includes !== 'function' && typeof (container as any)[Symbol.iterator] !== 'function') {
      return dictHas(container, item);
    }
    if (typeof container.has === 'function') return !!container.has(item);
    if (typeof container.includes === 'function') return !!container.includes(item);
    if (typeof container[Symbol.iterator] === 'function') {
      for (const entry of container as Iterable<any>) if (pyEq(entry, item)) return true;
      return false;
    }
  }
  return raise('TypeError', `argument of type '${typeName(container)}' is not iterable`);
}

export function pyLen(value: any): number {
  if (typeof value === 'string') return Array.from(value).length;
  if (Array.isArray(value)) return value.length;
  if (value instanceof Map || value instanceof Set) return value.size;
  if (value && typeof value === 'object') {
    if (typeof value.length === 'number') return value.length;
    if (typeof value.size === 'number') return value.size;
    if (isPlainObject(value) && !('_raw' in value) && typeof (value as any)[Symbol.iterator] !== 'function') {
      return Object.keys(value).length;
    }
    if (typeof value[Symbol.iterator] === 'function' && !isGenerator(value)) {
      return Array.from(value as Iterable<any>).length;
    }
  }
  return raise('TypeError', `object of type '${typeName(value)}' has no len()`);
}

// ---------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------

function requireNumber(value: any, op: string, other: any, left: boolean): number {
  const n = numericValue(value);
  if (n === null) {
    const [a, b] = left ? [value, other] : [other, value];
    raise('TypeError', `unsupported operand type(s) for ${op}: '${typeName(a)}' and '${typeName(b)}'`);
  }
  return n;
}

function requireInt(value: any, what: string): number {
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  return raise('TypeError', `'${typeName(value)}' object cannot be interpreted as an integer${what ? ` (${what})` : ''}`);
}

function floorDiv(a: number, b: number): number {
  return Math.floor(a / b);
}

function pyMod(a: number, b: number): number {
  const r = a % b;
  return r !== 0 && (r < 0) !== (b < 0) ? r + b : r;
}

function repeatSequence(seq: any, count: any): any {
  const n = Math.max(0, requireInt(count, ''));
  if (typeof seq === 'string') return seq.repeat(n);
  const out: any[] = [];
  for (let i = 0; i < n; i++) out.push(...seq);
  return isTuple(seq) ? makeTuple(out) : out;
}

function setBinary(op: string, a: Set<any>, b: Set<any>): Set<any> {
  switch (op) {
    case '|': return makeSet([...a, ...b]);
    case '&': return makeSet([...a].filter((entry) => setHas(b, entry)));
    case '-': return makeSet([...a].filter((entry) => !setHas(b, entry)));
    case '^': return makeSet([
      ...[...a].filter((entry) => !setHas(b, entry)),
      ...[...b].filter((entry) => !setHas(a, entry)),
    ]);
  }
  return raise('TypeError', `unsupported operand type(s) for ${op}: 'set' and 'set'`);
}

export function pyBinary(op: string, a: any, b: any): any {
  switch (op) {
    case '+': {
      if (typeof a === 'string' && typeof b === 'string') return a + b;
      if (Array.isArray(a) && Array.isArray(b)) {
        const out = [...a, ...b];
        return isTuple(a) && isTuple(b) ? makeTuple(out) : out;
      }
      const x = requireNumber(a, '+', b, true);
      const y = requireNumber(b, '+', a, false);
      return makeNumber(x + y, isFloatValue(a) || isFloatValue(b));
    }
    case '-': {
      if (a instanceof Set && b instanceof Set) return setBinary('-', a, b);
      const x = requireNumber(a, '-', b, true);
      const y = requireNumber(b, '-', a, false);
      return makeNumber(x - y, isFloatValue(a) || isFloatValue(b));
    }
    case '*': {
      if ((typeof a === 'string' || Array.isArray(a)) && isIntLike(b)) return repeatSequence(a, b);
      if ((typeof b === 'string' || Array.isArray(b)) && isIntLike(a)) return repeatSequence(b, a);
      const x = requireNumber(a, '*', b, true);
      const y = requireNumber(b, '*', a, false);
      return makeNumber(x * y, isFloatValue(a) || isFloatValue(b));
    }
    case '/': {
      const x = requireNumber(a, '/', b, true);
      const y = requireNumber(b, '/', a, false);
      if (y === 0) raise('ZeroDivisionError', 'division by zero');
      return makeFloat(x / y);
    }
    case '//': {
      const x = requireNumber(a, '//', b, true);
      const y = requireNumber(b, '//', a, false);
      if (y === 0) raise('ZeroDivisionError', 'integer division or modulo by zero');
      return makeNumber(floorDiv(x, y), isFloatValue(a) || isFloatValue(b));
    }
    case '%': {
      if (typeof a === 'string') return percentFormat(a, b);
      const x = requireNumber(a, '%', b, true);
      const y = requireNumber(b, '%', a, false);
      if (y === 0) raise('ZeroDivisionError', 'integer division or modulo by zero');
      return makeNumber(pyMod(x, y), isFloatValue(a) || isFloatValue(b));
    }
    case '**': {
      const x = requireNumber(a, '**', b, true);
      const y = requireNumber(b, '**', a, false);
      const float = isFloatValue(a) || isFloatValue(b) || (y < 0);
      if (x === 0 && y < 0) raise('ZeroDivisionError', '0.0 cannot be raised to a negative power');
      if (x < 0 && !Number.isInteger(y)) raise('ValueError', 'complex results are not supported');
      return makeNumber(x ** y, float);
    }
    case '<<':
    case '>>': {
      const x = requireInt(a, '');
      const y = requireInt(b, '');
      if (y < 0) raise('ValueError', 'negative shift count');
      return op === '<<' ? x * 2 ** y : Math.floor(x / 2 ** y);
    }
    case '&':
    case '|':
    case '^': {
      if (a instanceof Set && b instanceof Set) return setBinary(op, a, b);
      if (op === '|' && isDictLike(a) && isDictLike(b)) {
        return makeDict([
          ...dictKeys(a).map((key): [any, any] => [key, dictGet(a, key)]),
          ...dictKeys(b).map((key): [any, any] => [key, dictGet(b, key)]),
        ]);
      }
      if (typeof a === 'boolean' && typeof b === 'boolean') {
        return op === '&' ? a && b : op === '|' ? a || b : a !== b;
      }
      if (!isIntLike(a) || !isIntLike(b)) {
        raise('TypeError', `unsupported operand type(s) for ${op}: '${typeName(a)}' and '${typeName(b)}'`);
      }
      const x = BigInt(numericValue(a) ?? 0);
      const y = BigInt(numericValue(b) ?? 0);
      return Number(op === '&' ? x & y : op === '|' ? x | y : x ^ y);
    }
    case '@':
      return raise('TypeError', `unsupported operand type(s) for @: '${typeName(a)}' and '${typeName(b)}'`);
  }
  return raise('TypeError', `unsupported operand type(s) for ${op}: '${typeName(a)}' and '${typeName(b)}'`);
}

export function pyUnary(op: string, value: any): any {
  if (op === '~') {
    if (!isIntLike(value)) raise('TypeError', `bad operand type for unary ~: '${typeName(value)}'`);
    return -(numericValue(value)! + 1);
  }
  const n = numericValue(value);
  if (n === null) raise('TypeError', `bad operand type for unary ${op}: '${typeName(value)}'`);
  return makeNumber(op === '-' ? -n : n, isFloatValue(value));
}

/** Python's round(): banker's rounding on the exact binary value. */
export function pyRound(value: any, ndigits?: any): any {
  const x = numericValue(value);
  if (x === null) raise('TypeError', `type ${typeName(value)} doesn't define __round__ method`);
  if (isNone(ndigits)) {
    if (!Number.isFinite(x)) {
      raise(Number.isNaN(x) ? 'ValueError' : 'OverflowError', 'cannot convert float to integer');
    }
    const floor = Math.floor(x);
    const diff = x - floor;
    if (diff > 0.5) return floor + 1;
    if (diff < 0.5) return floor;
    return floor % 2 === 0 ? floor : floor + 1;
  }
  const digits = requireInt(ndigits, '');
  if (isIntLike(value)) {
    if (digits >= 0) return x;
    const factor = 10 ** -digits;
    return pyRound(x / factor) * factor;
  }
  if (!Number.isFinite(x) || Math.abs(x) >= 1e21) return makeFloat(x);
  if (digits > 100) return makeFloat(x);
  // Exact decimal expansion of the double, then round half to even (this is
  // what CPython's correctly-rounded float round() computes).
  const exact = Math.abs(x).toFixed(100);
  const [intPart, fracPart] = exact.split('.');
  const all = intPart + fracPart;
  const keep = intPart.length + digits;
  if (keep < 0) return makeFloat(x < 0 ? -0 : 0);
  const kept = all.slice(0, keep);
  const rest = all.slice(keep);
  let roundUp = false;
  if (rest[0] > '5') roundUp = true;
  else if (rest[0] === '5') {
    roundUp = /[1-9]/.test(rest.slice(1)) || Number(kept[kept.length - 1] ?? '0') % 2 === 1;
  }
  let text = (BigInt(kept || '0') + (roundUp ? 1n : 0n)).toString();
  if (digits > 0) {
    text = text.padStart(digits + 1, '0');
    text = `${text.slice(0, -digits)}.${text.slice(-digits)}`;
  } else if (digits < 0) {
    text += '0'.repeat(-digits);
  }
  return makeFloat(Number.parseFloat((x < 0 ? '-' : '') + text));
}

// ---------------------------------------------------------------------------
// str() / repr() / formatting
// ---------------------------------------------------------------------------

export function pyStrRepr(value: string): string {
  const quote = value.includes('\'') && !value.includes('"') ? '"' : '\'';
  let out = quote;
  for (const ch of value) {
    if (ch === quote || ch === '\\') out += '\\' + ch;
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (ch < ' ' || ch === '\x7f') out += '\\x' + ch.charCodeAt(0).toString(16).padStart(2, '0');
    else out += ch;
  }
  return out + quote;
}

export function pyRepr(value: any, seen: Set<any> = new Set()): string {
  if (isNone(value)) return 'None';
  if (value === true) return 'True';
  if (value === false) return 'False';
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : formatFloat(value);
  if (value instanceof PyFloat) return formatFloat(value.value);
  if (typeof value === 'string') return pyStrRepr(value);
  if (typeof value === 'object' && seen.has(value)) {
    return Array.isArray(value) ? '[...]' : '{...}';
  }
  if (Array.isArray(value)) {
    seen.add(value);
    const body = value.map((entry) => pyRepr(entry, seen)).join(', ');
    seen.delete(value);
    if (isTuple(value)) return value.length === 1 ? `(${body},)` : `(${body})`;
    return `[${body}]`;
  }
  if (value instanceof Set) {
    if (value.size === 0) return 'set()';
    seen.add(value);
    const body = [...value].map((entry) => pyRepr(entry, seen)).join(', ');
    seen.delete(value);
    return `{${body}}`;
  }
  if (isDictLike(value)) {
    seen.add(value);
    const body = dictKeys(value)
      .map((key) => `${pyRepr(key, seen)}: ${pyRepr(dictGet(value, key), seen)}`)
      .join(', ');
    seen.delete(value);
    return `{${body}}`;
  }
  if (typeof value === 'function') {
    if ((value as PyType).pyTypeName) return `<class '${(value as PyType).pyTypeName}'>`;
    return `<function ${(value as PyCallable).pyName ?? (value.name || '<lambda>')}>`;
  }
  const raw = unwrapHost(value);
  if (raw && typeof raw === 'object' && typeof raw.nid === 'string') {
    return `<${typeName(raw)} ${raw.nid}>`;
  }
  return `<${typeName(value)} object>`;
}

export function pyStr(value: any): string {
  if (typeof value === 'string') return value;
  return pyRepr(value);
}

/** `abs.toFixed(digits)` with Python's round-half-even on the exact value. */
function toFixedHalfEven(abs: number, digits: number): string {
  if (!Number.isFinite(abs) || abs >= 1e21 || digits > 100) return abs.toFixed(Math.min(digits, 100));
  const exact = abs.toFixed(100);
  const [intPart, fracPart] = exact.split('.');
  const all = intPart + fracPart;
  const keep = intPart.length + digits;
  const kept = all.slice(0, keep);
  const rest = all.slice(keep);
  let roundUp = false;
  if (rest[0] > '5') roundUp = true;
  else if (rest[0] === '5') {
    roundUp = /[1-9]/.test(rest.slice(1)) || Number(kept[kept.length - 1] ?? '0') % 2 === 1;
  }
  let text = (BigInt(kept || '0') + (roundUp ? 1n : 0n)).toString();
  if (digits > 0) {
    text = text.padStart(digits + 1, '0');
    text = `${text.slice(0, -digits)}.${text.slice(-digits)}`;
  }
  return text;
}

function formatWithSpec(value: any, spec: string): string {
  if (spec === '') return pyStr(value);
  const match = /^(?:(.)?([<>=^]))?([+\- ])?(#)?(0)?(\d+)?([,_])?(?:\.(\d+))?([bcdeEfFgGnosxX%])?$/s.exec(spec);
  if (!match) raise('ValueError', `Invalid format specifier '${spec}'`);
  let [, fill, align, sign, alt, zero, widthText, grouping, precisionText, type] = match;
  const width = widthText ? Number(widthText) : 0;
  const precision = precisionText !== undefined ? Number(precisionText) : undefined;
  if (zero && !align) {
    fill = '0';
    align = '=';
  }
  fill = fill ?? ' ';
  let body: string;
  let signText = '';
  const numeric = isNumberLike(value);
  if (typeof value === 'string') {
    if (type && type !== 's') raise('ValueError', `Unknown format code '${type}' for object of type 'str'`);
    body = precision !== undefined ? value.slice(0, precision) : value;
    align = align ?? '<';
  } else if (numeric) {
    const n = numericValue(value)!;
    const isInt = isIntLike(value) && typeof value !== 'boolean';
    let t = type;
    if (!t) t = isInt || typeof value === 'boolean' ? 'd' : (precision !== undefined ? 'g' : '');
    if (typeof value === 'boolean' && !type) {
      body = value ? 'True' : 'False';
    } else {
      const abs = Math.abs(n);
      if (n < 0 || Object.is(n, -0)) signText = '-';
      else if (sign === '+') signText = '+';
      else if (sign === ' ') signText = ' ';
      switch (t) {
        case 'd':
        case 'n':
          if (!isIntLike(value)) raise('ValueError', `Unknown format code 'd' for object of type 'float'`);
          body = String(abs);
          break;
        case 'b': body = (alt ? '0b' : '') + abs.toString(2); break;
        case 'o': body = (alt ? '0o' : '') + abs.toString(8); break;
        case 'x': body = (alt ? '0x' : '') + abs.toString(16); break;
        case 'X': body = (alt ? '0X' : '') + abs.toString(16).toUpperCase(); break;
        case 'c': body = String.fromCodePoint(n); signText = ''; break;
        case 'f':
        case 'F':
          body = Number.isFinite(abs) ? toFixedHalfEven(abs, precision ?? 6) : (Number.isNaN(abs) ? 'nan' : 'inf');
          if (t === 'F') body = body.toUpperCase();
          break;
        case 'e':
        case 'E': {
          const [m, e] = abs.toExponential(precision ?? 6).split('e');
          body = `${m}e${e[0] === '-' ? '-' : '+'}${e.replace(/^[+-]/, '').padStart(2, '0')}`;
          if (t === 'E') body = body.toUpperCase();
          break;
        }
        case '%':
          body = `${toFixedHalfEven(abs * 100, precision ?? 6)}%`;
          break;
        case 'g':
        case 'G': {
          const p = precision === 0 ? 1 : (precision ?? 6);
          if (abs === 0) body = '0';
          else {
            const exp = Math.floor(Math.log10(abs));
            if (exp < -4 || exp >= p) {
              const [m, e] = abs.toExponential(p - 1).split('e');
              const mantissa = alt ? m : m.replace(/\.?0+$/, '');
              body = `${mantissa}e${e[0] === '-' ? '-' : '+'}${e.replace(/^[+-]/, '').padStart(2, '0')}`;
            } else {
              body = toFixedHalfEven(abs, Math.max(0, p - 1 - exp));
              if (!alt && body.includes('.')) body = body.replace(/\.?0+$/, '');
            }
          }
          if (t === 'G') body = body.toUpperCase();
          break;
        }
        default:
          body = isFloatValue(value) ? formatFloat(abs) : String(abs);
      }
      if (grouping && /^[0-9]/.test(body)) {
        const [intPart, frac] = body.split('.');
        body = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, grouping) + (frac !== undefined ? `.${frac}` : '');
      }
    }
    align = align ?? '>';
  } else {
    body = pyStr(value);
    align = align ?? '<';
  }
  const total = signText + body;
  if (total.length >= width) return total;
  const pad = width - total.length;
  switch (align) {
    case '<': return total + fill.repeat(pad);
    case '>': return fill.repeat(pad) + total;
    case '^': return fill.repeat(Math.floor(pad / 2)) + total + fill.repeat(Math.ceil(pad / 2));
    case '=': return signText + fill.repeat(pad) + body;
  }
  return total;
}

export function pyFormat(value: any, spec = ''): string {
  return formatWithSpec(value, spec);
}

/** Python `str.format`. */
export function strFormat(template: string, args: any[], kwargs: Kwargs): string {
  let auto = 0;
  const resolveField = (field: string): any => {
    const head = /^[^.[]*/.exec(field)![0];
    let value: any;
    if (head === '') value = args[auto++];
    else if (/^\d+$/.test(head)) value = args[Number(head)];
    else {
      if (!kwargs || !(head in kwargs)) raise('KeyError', pyRepr(head));
      value = kwargs[head];
    }
    if (head === '' && auto - 1 >= args.length) raise('IndexError', 'Replacement index out of range for positional args tuple');
    if (/^\d+$/.test(head) && Number(head) >= args.length) raise('IndexError', 'Replacement index out of range for positional args tuple');
    let rest = field.slice(head.length);
    while (rest) {
      const attr = /^\.([A-Za-z_]\w*)/.exec(rest);
      if (attr) {
        value = pyGetAttr(value, attr[1]);
        rest = rest.slice(attr[0].length);
        continue;
      }
      const index = /^\[([^\]]*)\]/.exec(rest);
      if (index) {
        const key = /^\d+$/.test(index[1]) ? Number(index[1]) : index[1];
        value = pyGetItem(value, key);
        rest = rest.slice(index[0].length);
        continue;
      }
      raise('ValueError', 'Only \'.\' or \'[\' may follow \']\' in format field specifier');
    }
    return value;
  };
  let out = '';
  for (let i = 0; i < template.length; i++) {
    const ch = template[i];
    if (ch === '{') {
      if (template[i + 1] === '{') {
        out += '{';
        i++;
        continue;
      }
      let depth = 1;
      let j = i + 1;
      for (; j < template.length; j++) {
        if (template[j] === '{') depth++;
        else if (template[j] === '}' && --depth === 0) break;
      }
      if (j >= template.length) raise('ValueError', "Single '{' encountered in format string");
      const inner = template.slice(i + 1, j);
      const m = /^([^!:]*)(?:!([rsa]))?(?::([\s\S]*))?$/.exec(inner);
      if (!m) raise('ValueError', 'invalid format field');
      let value = resolveField(m[1]);
      if (m[2] === 'r' || m[2] === 'a') value = pyRepr(value);
      else if (m[2] === 's') value = pyStr(value);
      const spec = m[3] ? strFormat(m[3], args, kwargs) : '';
      out += formatWithSpec(value, spec);
      i = j;
    } else if (ch === '}') {
      if (template[i + 1] === '}') {
        out += '}';
        i++;
        continue;
      }
      raise('ValueError', "Single '}' encountered in format string");
    } else {
      out += ch;
    }
  }
  return out;
}

/** Python printf-style `str % values`. */
export function percentFormat(template: string, values: any): string {
  const isMapping = isDictLike(values);
  const list = isTuple(values) ? values : [values];
  let index = 0;
  let usedMapping = false;
  const out = template.replace(
    /%(?:\(([^)]*)\))?([#0\- +]*)(\*|\d+)?(?:\.(\*|\d+))?[hlL]?([diouxXeEfFgGcrsa%])/g,
    (_whole, key: string | undefined, flags: string, widthText: string | undefined,
      precisionText: string | undefined, conversion: string) => {
      if (conversion === '%') return '%';
      let value: any;
      if (key !== undefined) {
        if (!isMapping) raise('TypeError', 'format requires a mapping');
        usedMapping = true;
        if (!dictHas(values, key)) raise('KeyError', pyRepr(key));
        value = dictGet(values, key);
      } else {
        if (index >= list.length) raise('TypeError', 'not enough arguments for format string');
        value = list[index++];
      }
      const width = widthText === '*' ? Number(list[index++]) : widthText ? Number(widthText) : 0;
      const precision = precisionText === '*' ? Number(list[index++]) : precisionText !== undefined ? Number(precisionText) : undefined;
      let body: string;
      switch (conversion) {
        case 's': body = pyStr(value); if (precision !== undefined) body = body.slice(0, precision); break;
        case 'r':
        case 'a': body = pyRepr(value); if (precision !== undefined) body = body.slice(0, precision); break;
        case 'c': body = typeof value === 'string' ? value : String.fromCodePoint(requireInt(value, '')); break;
        default: {
          const n = numericValue(value);
          if (n === null) {
            raise('TypeError', `%${conversion} format: a real number is required, not ${typeName(value)}`);
          }
          const specType = conversion === 'i' || conversion === 'u' ? 'd' : conversion;
          const truncated = 'doxX'.includes(specType) ? Math.trunc(n) : n;
          let spec = '';
          if (flags.includes('+')) spec += '+';
          else if (flags.includes(' ')) spec += ' ';
          if (flags.includes('#')) spec += '#';
          if (precision !== undefined && !'doxX'.includes(specType)) spec += `.${precision}`;
          spec += specType;
          body = formatWithSpec('doxX'.includes(specType) ? truncated : makeFloat(truncated), spec);
          if (flags.includes('0') && !flags.includes('-') && body.length < width) {
            const signMatch = /^[+\- ]/.exec(body);
            const signPart = signMatch ? signMatch[0] : '';
            body = signPart + body.slice(signPart.length).padStart(width - signPart.length, '0');
          }
        }
      }
      if (body.length < width) body = flags.includes('-') ? body.padEnd(width) : body.padStart(width);
      return body;
    },
  );
  if (!usedMapping && !isMapping && index < list.length) {
    raise('TypeError', 'not all arguments converted during string formatting');
  }
  return out;
}

// ---------------------------------------------------------------------------
// Attribute access, subscripts and calls
// ---------------------------------------------------------------------------

const LIST_METHOD_NAMES = new Set([
  'append', 'extend', 'insert', 'remove', 'pop', 'clear', 'index', 'count', 'sort',
  'reverse', 'copy',
]);

const camelCache = new Map<string, string>();
function snakeToCamel(name: string): string {
  let camel = camelCache.get(name);
  if (camel === undefined) {
    camel = name.replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase());
    camelCache.set(name, camel);
  }
  return camel;
}

function normalizeIndex(length: number, index: any, kind: string): number {
  if (!isIntLike(index)) {
    raise('TypeError', `${kind} indices must be integers or slices, not ${typeName(index)}`);
  }
  let i = numericValue(index)!;
  if (i < 0) i += length;
  if (i < 0 || i >= length) raise('IndexError', `${kind} index out of range`);
  return i;
}

export interface PySlice {
  __pySlice: true;
  start: any;
  stop: any;
  step: any;
}

export function makeSlice(start: any, stop: any, step: any): PySlice {
  return { __pySlice: true, start, stop, step };
}

function isSlice(value: any): value is PySlice {
  return !!value && typeof value === 'object' && value.__pySlice === true;
}

function sliceIndices(length: number, slice: PySlice): number[] {
  const step = isNone(slice.step) ? 1 : requireInt(slice.step, 'slice step');
  if (step === 0) raise('ValueError', 'slice step cannot be zero');
  const clamp = (value: any, fallback: number, lower: number, upper: number): number => {
    if (isNone(value)) return fallback;
    let i = requireInt(value, 'slice index');
    if (i < 0) i += length;
    return Math.min(Math.max(i, lower), upper);
  };
  const indices: number[] = [];
  if (step > 0) {
    const start = clamp(slice.start, 0, 0, length);
    const stop = clamp(slice.stop, length, 0, length);
    for (let i = start; i < stop; i += step) indices.push(i);
  } else {
    const start = clamp(slice.start, length - 1, -1, length - 1);
    const stop = clamp(slice.stop, -1, -1, length - 1);
    for (let i = start; i > stop; i += step) indices.push(i);
  }
  return indices;
}

export function pyGetItem(container: any, key: any): any {
  if (typeof container === 'string') {
    const chars = Array.from(container);
    if (isSlice(key)) return sliceIndices(chars.length, key).map((i) => chars[i]).join('');
    return chars[normalizeIndex(chars.length, key, 'string')];
  }
  if (Array.isArray(container)) {
    if (isSlice(key)) {
      const out = sliceIndices(container.length, key).map((i) => container[i]);
      return isTuple(container) ? makeTuple(out) : out;
    }
    return container[normalizeIndex(container.length, key, isTuple(container) ? 'tuple' : 'list')];
  }
  if (isNone(container)) raise('TypeError', "'NoneType' object is not subscriptable");
  if (container instanceof Map) {
    if (typeof (container as any).get === 'function' && typeof (container as any).has === 'function') {
      // Works for both a Map and a Proxy around one.
      const found = (container as any).has(hashKey(key));
      if (found) return (container as any).get(hashKey(key));
      if (key && typeof key === 'object') {
        for (const existing of (container as any).keys()) {
          if (pyEq(existing, key)) return (container as any).get(existing);
        }
      }
    }
    if (isCounter(container)) return 0;
    return raise('KeyError', pyRepr(key));
  }
  if (container instanceof Set) raise('TypeError', "'set' object is not subscriptable");
  if (typeof container === 'object' || typeof container === 'function') {
    if (isSlice(key)) raise('TypeError', `'${typeName(container)}' object is not subscriptable`);
    if (typeof key === 'string' || typeof key === 'number' || typeof key === 'boolean') {
      const value = (container as any)[String(key)];
      if (value !== undefined) return value;
    }
    if (typeof (container as any).get === 'function' && !isDictLike(container)) {
      const value = (container as any).get(key);
      if (value !== undefined && value !== null) return value;
    }
    return raise('KeyError', pyRepr(key));
  }
  return raise('TypeError', `'${typeName(container)}' object is not subscriptable`);
}

/** A method resolved against its receiver (avoids allocating bound functions). */
export interface ResolvedMethod {
  fn: any;
  self: any;
  native: boolean;
}

const NATIVE_METHOD = Symbol('nativeMethod');

type NativeMethod = (self: any, args: any[], kwargs: Kwargs) => any;

function nativeMethod(impl: NativeMethod): NativeMethod {
  (impl as any)[NATIVE_METHOD] = true;
  return impl;
}

function argAt(args: any[], kwargs: Kwargs, index: number, name: string, fallback?: any): any {
  if (index < args.length) return args[index];
  if (kwargs && name in kwargs) return kwargs[name];
  return fallback;
}

function noKwargs(name: string, kwargs: Kwargs): void {
  if (kwargs && Object.keys(kwargs).length > 0) {
    raise('TypeError', `${name}() takes no keyword arguments`);
  }
}

function requireStr(value: any, what: string): string {
  if (typeof value !== 'string') raise('TypeError', `${what} must be str, not ${typeName(value)}`);
  return value;
}

function stripChars(chars: any): string | null {
  if (isNone(chars)) return null;
  return requireStr(chars, 'strip arg');
}

function stripString(s: string, chars: string | null, left: boolean, right: boolean): string {
  const set = chars === null ? null : new Set(Array.from(chars));
  const isStrip = (ch: string) => set ? set.has(ch) : /\s/.test(ch);
  const arr = Array.from(s);
  let start = 0;
  let end = arr.length;
  if (left) while (start < end && isStrip(arr[start])) start++;
  if (right) while (end > start && isStrip(arr[end - 1])) end--;
  return arr.slice(start, end).join('');
}

function pySplit(s: string, sep: any, maxsplit: any, fromRight: boolean): string[] {
  const max = isNone(maxsplit) ? -1 : requireInt(maxsplit, '');
  if (isNone(sep)) {
    const words: string[] = [];
    if (!fromRight) {
      let rest = s.replace(/^\s+/, '');
      while (rest) {
        if (max >= 0 && words.length >= max) {
          words.push(rest);
          return words;
        }
        const m = /\s+/.exec(rest);
        if (!m) {
          words.push(rest);
          break;
        }
        words.push(rest.slice(0, m.index));
        rest = rest.slice(m.index + m[0].length);
      }
      return words;
    }
    let rest = s.replace(/\s+$/, '');
    while (rest) {
      if (max >= 0 && words.length >= max) {
        words.unshift(rest);
        return words;
      }
      const m = /\s+(?=\S*$)/.exec(rest);
      if (!m) {
        words.unshift(rest);
        break;
      }
      words.unshift(rest.slice(m.index + m[0].length));
      rest = rest.slice(0, m.index);
    }
    return words;
  }
  const separator = requireStr(sep, 'separator');
  if (separator === '') raise('ValueError', 'empty separator');
  const parts = s.split(separator);
  if (max < 0 || parts.length - 1 <= max) return parts;
  if (!fromRight) return [...parts.slice(0, max), parts.slice(max).join(separator)];
  return [parts.slice(0, parts.length - max).join(separator), ...parts.slice(parts.length - max)];
}

function clampIndex(value: any, length: number, fallback: number): number {
  if (isNone(value)) return fallback;
  const n = requireInt(value, 'slice index');
  return n < 0 ? Math.max(0, n + length) : Math.min(n, length);
}

function strFind(s: string, sub: any, start: any, end: any, fromRight: boolean): number {
  const needle = requireStr(sub, 'must be str');
  if (!isNone(start) && requireInt(start, '') > s.length) return -1;
  const begin = clampIndex(start, s.length, 0);
  const stop = clampIndex(end, s.length, s.length);
  if (stop < begin) return -1;
  const hay = s.slice(begin, stop);
  const index = fromRight ? hay.lastIndexOf(needle) : hay.indexOf(needle);
  return index < 0 ? -1 : index + begin;
}

function prefixMatch(s: string, prefix: any, start: any, end: any, suffix: boolean, name: string): boolean {
  const options = isTuple(prefix) || Array.isArray(prefix) ? prefix : [prefix];
  const begin = clampIndex(start, s.length, 0);
  const stop = clampIndex(end, s.length, s.length);
  const hay = s.slice(begin, stop);
  return options.some((option: any) => {
    if (typeof option !== 'string') {
      raise('TypeError', `${name} first arg must be str or a tuple of str, not ${typeName(option)}`);
    }
    return suffix ? hay.endsWith(option) : hay.startsWith(option);
  });
}

const STR_METHODS: Record<string, NativeMethod> = {
  upper: nativeMethod((s) => s.toUpperCase()),
  lower: nativeMethod((s) => s.toLowerCase()),
  casefold: nativeMethod((s) => s.toLowerCase()),
  capitalize: nativeMethod((s: string) => s ? s[0].toUpperCase() + s.slice(1).toLowerCase() : s),
  title: nativeMethod((s: string) => s.toLowerCase().replace(/(^|[^A-Za-z])([a-z])/g, (_m, p: string, c: string) => p + c.toUpperCase())),
  swapcase: nativeMethod((s: string) => Array.from(s).map((c) => c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase()).join('')),
  strip: nativeMethod((s, args, kw) => stripString(s, stripChars(argAt(args, kw, 0, 'chars')), true, true)),
  lstrip: nativeMethod((s, args, kw) => stripString(s, stripChars(argAt(args, kw, 0, 'chars')), true, false)),
  rstrip: nativeMethod((s, args, kw) => stripString(s, stripChars(argAt(args, kw, 0, 'chars')), false, true)),
  split: nativeMethod((s, args, kw) => pySplit(s, argAt(args, kw, 0, 'sep', null), argAt(args, kw, 1, 'maxsplit', -1), false)),
  rsplit: nativeMethod((s, args, kw) => pySplit(s, argAt(args, kw, 0, 'sep', null), argAt(args, kw, 1, 'maxsplit', -1), true)),
  splitlines: nativeMethod((s: string, args, kw) => {
    const keep = pyBool(argAt(args, kw, 0, 'keepends', false));
    const lines = s.match(/[^\r\n]*(?:\r\n|\r|\n)|[^\r\n]+$/g) ?? [];
    return lines.map((line) => keep ? line : line.replace(/(?:\r\n|\r|\n)$/, ''));
  }),
  join: nativeMethod((s, args) => toArray(args[0]).map((part, index) => {
    if (typeof part !== 'string') raise('TypeError', `sequence item ${index}: expected str instance, ${typeName(part)} found`);
    return part;
  }).join(s)),
  replace: nativeMethod((s: string, args) => {
    const old = requireStr(args[0], 'replace() argument 1');
    const replacement = requireStr(args[1], 'replace() argument 2');
    const count = isNone(args[2]) ? -1 : requireInt(args[2], '');
    if (count < 0) return s.split(old).join(replacement);
    let out = s;
    let result = '';
    for (let n = 0; n < count; n++) {
      const index = out.indexOf(old);
      if (index < 0) break;
      result += out.slice(0, index) + replacement;
      out = out.slice(index + old.length);
      if (old === '') {
        result += out.slice(0, 1);
        out = out.slice(1);
      }
    }
    return result + out;
  }),
  startswith: nativeMethod((s, args) => prefixMatch(s, args[0], args[1], args[2], false, 'startswith')),
  endswith: nativeMethod((s, args) => prefixMatch(s, args[0], args[1], args[2], true, 'endswith')),
  find: nativeMethod((s, args) => strFind(s, args[0], args[1], args[2], false)),
  rfind: nativeMethod((s, args) => strFind(s, args[0], args[1], args[2], true)),
  index: nativeMethod((s, args) => {
    const index = strFind(s, args[0], args[1], args[2], false);
    if (index < 0) raise('ValueError', 'substring not found');
    return index;
  }),
  rindex: nativeMethod((s, args) => {
    const index = strFind(s, args[0], args[1], args[2], true);
    if (index < 0) raise('ValueError', 'substring not found');
    return index;
  }),
  count: nativeMethod((s: string, args) => {
    const needle = requireStr(args[0], 'must be str');
    const hay = pyGetItem(s, makeSlice(args[1], args[2], null)) as string;
    if (needle === '') return Array.from(hay).length + 1;
    return hay.split(needle).length - 1;
  }),
  format: nativeMethod((s, args, kw) => strFormat(s, args, kw)),
  format_map: nativeMethod((s, args) => strFormat(s, [], Object.fromEntries(dictKeys(args[0]).map((k) => [k, dictGet(args[0], k)])))),
  isdigit: nativeMethod((s: string) => s.length > 0 && /^[0-9]+$/.test(s)),
  isdecimal: nativeMethod((s: string) => s.length > 0 && /^[0-9]+$/.test(s)),
  isnumeric: nativeMethod((s: string) => s.length > 0 && /^\p{N}+$/u.test(s)),
  isalpha: nativeMethod((s: string) => s.length > 0 && /^\p{L}+$/u.test(s)),
  isalnum: nativeMethod((s: string) => s.length > 0 && /^[\p{L}\p{N}]+$/u.test(s)),
  isspace: nativeMethod((s: string) => s.length > 0 && /^\s+$/.test(s)),
  islower: nativeMethod((s: string) => /\p{Ll}/u.test(s) && !/\p{Lu}/u.test(s)),
  isupper: nativeMethod((s: string) => /\p{Lu}/u.test(s) && !/\p{Ll}/u.test(s)),
  isidentifier: nativeMethod((s: string) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(s)),
  istitle: nativeMethod((s: string) => s.length > 0 && s === STR_METHODS.title(s, [], null) && /\p{L}/u.test(s)),
  zfill: nativeMethod((s: string, args) => {
    const width = requireInt(args[0], '');
    const sign = /^[+-]/.test(s) ? s[0] : '';
    const body = sign ? s.slice(1) : s;
    return s.length >= width ? s : sign + body.padStart(width - sign.length, '0');
  }),
  center: nativeMethod((s: string, args) => {
    const width = requireInt(args[0], '');
    const fill = isNone(args[1]) ? ' ' : args[1];
    if (s.length >= width) return s;
    const total = width - s.length;
    const left = Math.floor(total / 2) + (total % 2 && width % 2 ? 1 : 0);
    return fill.repeat(left) + s + fill.repeat(total - left);
  }),
  ljust: nativeMethod((s: string, args) => s.padEnd(requireInt(args[0], ''), isNone(args[1]) ? ' ' : args[1])),
  rjust: nativeMethod((s: string, args) => s.padStart(requireInt(args[0], ''), isNone(args[1]) ? ' ' : args[1])),
  partition: nativeMethod((s: string, args) => {
    const sep = requireStr(args[0], 'sep');
    const index = s.indexOf(sep);
    return makeTuple(index < 0 ? [s, '', ''] : [s.slice(0, index), sep, s.slice(index + sep.length)]);
  }),
  rpartition: nativeMethod((s: string, args) => {
    const sep = requireStr(args[0], 'sep');
    const index = s.lastIndexOf(sep);
    return makeTuple(index < 0 ? ['', '', s] : [s.slice(0, index), sep, s.slice(index + sep.length)]);
  }),
  removeprefix: nativeMethod((s: string, args) => s.startsWith(args[0]) ? s.slice(args[0].length) : s),
  removesuffix: nativeMethod((s: string, args) => args[0] && s.endsWith(args[0]) ? s.slice(0, -args[0].length) : s),
  encode: nativeMethod((s) => s),
};

function listRemoveAt(list: any[], index: number): any {
  return list.splice(index, 1)[0];
}

const LIST_METHODS: Record<string, NativeMethod> = {
  append: nativeMethod((list, args) => { list.push(args[0]); return null; }),
  extend: nativeMethod((list, args) => { list.push(...toArray(args[0])); return null; }),
  insert: nativeMethod((list, args) => {
    let index = requireInt(args[0], '');
    if (index < 0) index = Math.max(0, index + list.length);
    list.splice(Math.min(index, list.length), 0, args[1]);
    return null;
  }),
  remove: nativeMethod((list, args) => {
    const index = list.findIndex((entry: any) => pyEq(entry, args[0]));
    if (index < 0) raise('ValueError', 'list.remove(x): x not in list');
    listRemoveAt(list, index);
    return null;
  }),
  pop: nativeMethod((list, args) => {
    if (list.length === 0) raise('IndexError', 'pop from empty list');
    const index = args.length ? normalizeIndex(list.length, args[0], 'pop') : list.length - 1;
    return listRemoveAt(list, index);
  }),
  clear: nativeMethod((list) => { list.length = 0; return null; }),
  index: nativeMethod((list, args) => {
    const slice = sliceIndices(list.length, makeSlice(args[1], args[2], null));
    for (const i of slice) if (pyEq(list[i], args[0])) return i;
    return raise('ValueError', `${pyRepr(args[0])} is not in list`);
  }),
  count: nativeMethod((list, args) => list.filter((entry: any) => pyEq(entry, args[0])).length),
  sort: nativeMethod((list, args, kw) => {
    if (args.length) raise('TypeError', 'sort() takes no positional arguments');
    const sorted = pySorted(list, kw?.key ?? null, pyBool(kw?.reverse ?? false));
    for (let i = 0; i < sorted.length; i++) list[i] = sorted[i];
    return null;
  }),
  reverse: nativeMethod((list) => { list.reverse(); return null; }),
  copy: nativeMethod((list) => list.slice()),
};

const TUPLE_METHODS: Record<string, NativeMethod> = {
  index: LIST_METHODS.index,
  count: LIST_METHODS.count,
};

const DICT_METHODS: Record<string, NativeMethod> = {
  get: nativeMethod((dict, args, kw) => {
    const key = argAt(args, kw, 0, 'key');
    const fallback = argAt(args, kw, 1, 'default', null);
    if (dict instanceof Map) {
      // A Proxy around a Map exposes bound has/get.
      if ((dict as any).has(hashKey(key))) return (dict as any).get(hashKey(key));
      if (key && typeof key === 'object') {
        for (const existing of (dict as any).keys()) if (pyEq(existing, key)) return (dict as any).get(existing);
      }
      return fallback;
    }
    return dictHas(dict, key) ? dictGet(dict, key) : fallback;
  }),
  keys: nativeMethod((dict) => dict instanceof Map ? [...(dict as any).keys()] : Object.keys(dict)),
  values: nativeMethod((dict) => dict instanceof Map ? [...(dict as any).values()] : Object.values(dict)),
  items: nativeMethod((dict) => dict instanceof Map
    ? [...(dict as any).entries()].map((entry: any[]) => makeTuple([entry[0], entry[1]]))
    : Object.entries(dict).map((entry) => makeTuple([entry[0], entry[1]]))),
  pop: nativeMethod((dict, args) => {
    if (dictHas(dict, args[0])) {
      const value = dictGet(dict, args[0]);
      if (dict instanceof Map) (dict as any).delete(mapFindKey(dict, args[0]).key);
      else delete dict[String(args[0])];
      return value;
    }
    if (args.length > 1) return args[1];
    return raise('KeyError', pyRepr(args[0]));
  }),
  setdefault: nativeMethod((dict, args) => {
    if (!dictHas(dict, args[0])) dictSet(dict, args[0], args.length > 1 ? args[1] : null);
    return dictGet(dict, args[0]);
  }),
  update: nativeMethod((dict, args, kw) => {
    if (args.length) {
      const source = args[0];
      if (isDictLike(source)) for (const key of dictKeys(source)) dictSet(dict, key, dictGet(source, key));
      else for (const pair of toArray(source)) {
        const [k, v] = toArray(pair);
        dictSet(dict, k, v);
      }
    }
    if (kw) for (const [key, value] of Object.entries(kw)) dictSet(dict, key, value);
    return null;
  }),
  copy: nativeMethod((dict) => dict instanceof Map ? new Map((dict as any).entries()) : { ...dict }),
  clear: nativeMethod((dict) => {
    if (dict instanceof Map) (dict as any).clear();
    else for (const key of Object.keys(dict)) delete dict[key];
    return null;
  }),
};

const SET_METHODS: Record<string, NativeMethod> = {
  add: nativeMethod((set, args) => { setAdd(set, args[0]); return null; }),
  discard: nativeMethod((set, args) => {
    const key = hashKey(args[0]);
    if (set.has(key)) set.delete(key);
    else for (const entry of set) if (pyEq(entry, key)) { set.delete(entry); break; }
    return null;
  }),
  remove: nativeMethod((set, args) => {
    if (!setHas(set, args[0])) raise('KeyError', pyRepr(args[0]));
    return SET_METHODS.discard(set, args, null);
  }),
  pop: nativeMethod((set) => {
    if (set.size === 0) raise('KeyError', "'pop from an empty set'");
    const first = set.values().next().value;
    set.delete(first);
    return first;
  }),
  clear: nativeMethod((set) => { set.clear(); return null; }),
  copy: nativeMethod((set) => new Set(set)),
  union: nativeMethod((set, args) => makeSet([...set, ...args.flatMap((arg) => toArray(arg))])),
  update: nativeMethod((set, args) => { for (const arg of args) for (const v of toArray(arg)) setAdd(set, v); return null; }),
  intersection: nativeMethod((set, args) => args.reduce((acc: Set<any>, arg) => setBinary('&', acc, makeSet(toArray(arg))), new Set(set))),
  difference: nativeMethod((set, args) => args.reduce((acc: Set<any>, arg) => setBinary('-', acc, makeSet(toArray(arg))), new Set(set))),
  symmetric_difference: nativeMethod((set, args) => setBinary('^', set, makeSet(toArray(args[0])))),
  issubset: nativeMethod((set, args) => { const other = makeSet(toArray(args[0])); return [...set].every((v) => setHas(other, v)); }),
  issuperset: nativeMethod((set, args) => toArray(args[0]).every((v) => setHas(set, v))),
  isdisjoint: nativeMethod((set, args) => !toArray(args[0]).some((v) => setHas(set, v))),
};

const NUMBER_METHODS: Record<string, NativeMethod> = {
  is_integer: nativeMethod((n) => Number.isInteger(numericValue(n))),
  bit_length: nativeMethod((n) => {
    const value = Math.abs(numericValue(n)!);
    return value === 0 ? 0 : Math.floor(Math.log2(value)) + 1;
  }),
  conjugate: nativeMethod((n) => n),
};

/** Fallbacks the old resolver applied when a host property was missing. */
const HOST_ATTRIBUTE_ALIASES: Record<string, string[]> = {
  turncount: ['turnCount', 'turncount'],
  turn_count: ['turnCount', 'turncount'],
  game_vars: ['gameVars'],
  level_vars: ['levelVars'],
  current_hp: ['currentHp'],
  max_hp: ['maxHp'],
};

function nativeMethodsFor(value: any): Record<string, NativeMethod> | null {
  if (typeof value === 'string') return STR_METHODS;
  if (Array.isArray(value)) return isTuple(value) ? TUPLE_METHODS : LIST_METHODS;
  if (value instanceof Set) return SET_METHODS;
  if (value instanceof Map) return DICT_METHODS;
  if (isNumberLike(value)) return NUMBER_METHODS;
  return null;
}

/** Resolve `value.name` for a call (method lookup). */
function resolveMethod(value: any, name: string): ResolvedMethod {
  if (isNone(value)) raise('AttributeError', `'NoneType' object has no attribute '${name}'`);
  if (typeof value === 'string' || isNumberLike(value)) {
    const methods = nativeMethodsFor(value)!;
    const method = Object.prototype.hasOwnProperty.call(methods, name) ? methods[name] : undefined;
    if (method) return { fn: method, self: value, native: true };
    if (isNumberLike(value) && (name === 'real' || name === 'numerator')) {
      return { fn: value, self: undefined, native: false };
    }
    return raise('AttributeError', `'${typeName(value)}' object has no attribute '${name}'`);
  }
  if (Array.isArray(value)) {
    const own = (value as any)[name];
    // Engine proxies may override list methods (persistent record lists).
    if (typeof own === 'function' && own !== (Array.prototype as any)[name]) {
      return { fn: own, self: value, native: false };
    }
    const methods = isTuple(value) ? TUPLE_METHODS : LIST_METHODS;
    if (Object.prototype.hasOwnProperty.call(methods, name)) return { fn: methods[name], self: value, native: true };
    if (own !== undefined && own !== (Array.prototype as any)[name] && name !== 'length') {
      return { fn: own, self: value, native: false };
    }
    return raise('AttributeError', `'${typeName(value)}' object has no attribute '${name}'`);
  }
  if (value instanceof Set) {
    if (Object.prototype.hasOwnProperty.call(SET_METHODS, name)) return { fn: SET_METHODS[name], self: value, native: true };
    return raise('AttributeError', `'set' object has no attribute '${name}'`);
  }
  if (value instanceof Map) {
    if (Object.prototype.hasOwnProperty.call(DICT_METHODS, name)) return { fn: DICT_METHODS[name], self: value, native: true };
    const own = (value as any)[name];
    if (own !== undefined && own !== (Map.prototype as any)[name]) return { fn: own, self: value, native: false };
    return raise('AttributeError', `'dict' object has no attribute '${name}'`);
  }
  if (typeof value === 'object' || typeof value === 'function') {
    const direct = (value as any)[name];
    if (direct !== undefined) return { fn: direct, self: value, native: false };
    if (isDictLike(value) && Object.prototype.hasOwnProperty.call(DICT_METHODS, name)) {
      return { fn: DICT_METHODS[name], self: value, native: true };
    }
    const camel = snakeToCamel(name);
    if (camel !== name) {
      const camelValue = (value as any)[camel];
      if (camelValue !== undefined) return { fn: camelValue, self: value, native: false };
    }
    for (const alias of HOST_ATTRIBUTE_ALIASES[name] ?? []) {
      const aliasValue = (value as any)[alias];
      if (aliasValue !== undefined) return { fn: aliasValue, self: value, native: false };
    }
    if (typeof value === 'function' && name === '__name__') {
      return { fn: (value as PyCallable).pyName ?? value.name, self: undefined, native: false };
    }
  }
  return raise('AttributeError', `'${typeName(value)}' object has no attribute '${name}'`);
}

export function pyGetAttr(value: any, name: string): any {
  const resolved = resolveMethod(value, name);
  if (resolved.native) {
    const method = resolved.fn as NativeMethod;
    const self = resolved.self;
    return pyFunction(name, (args, kwargs) => method(self, args, kwargs));
  }
  const attr = resolved.fn;
  if (typeof attr === 'function' && !(attr as PyCallable)[PY_CALL] && !(attr as PyType).pyTypeName) {
    const self = resolved.self;
    return pyFunction(name, (args, kwargs) => callHost(attr, self, args, kwargs));
  }
  return attr;
}

export function pyHasAttr(value: any, name: string): boolean {
  try {
    resolveMethod(value, name);
    return true;
  } catch (error) {
    if (error instanceof PyException && error.pyType === 'AttributeError') return false;
    throw error;
  }
}

// --- host calls -----------------------------------------------------------

const paramNameCache = new WeakMap<Function, string[] | null>();

/** Parameter names of a JS function, or null when they cannot be read. */
function hostParamNames(fn: Function): string[] | null {
  if (paramNameCache.has(fn)) return paramNameCache.get(fn)!;
  let names: string[] | null = null;
  try {
    const source = Function.prototype.toString.call(fn);
    if (!source.includes('[native code]')) {
      const m = /^(?:async\s+)?(?:function\b[^(]*|[A-Za-z_$][\w$]*\s*)?\(([^)]*)\)/.exec(source) ??
        /^(?:async\s+)?([A-Za-z_$][\w$]*)\s*=>/.exec(source);
      if (m) {
        const params = m[1].split(',').map((part) => part.trim()).filter(Boolean);
        if (!params.some((param) => param.startsWith('...') || param.startsWith('{') || param.startsWith('['))) {
          names = params.map((param) => param.replace(/\s*[=:].*$/s, '').trim());
        }
      }
    }
  } catch {
    names = null;
  }
  paramNameCache.set(fn, names);
  return names;
}

/** Call an engine function with Python-style arguments. */
export function callHost(fn: any, self: any, args: any[], kwargs: Kwargs): any {
  if (kwargs && Object.keys(kwargs).length > 0) {
    const names = hostParamNames(fn);
    if (names) {
      const positional = args.slice();
      for (const [key, value] of Object.entries(kwargs)) {
        const index = names.findIndex((name) => name === key || name === snakeToCamel(key));
        if (index < 0) continue; // the engine port does not model this option
        while (positional.length < index) positional.push(undefined);
        positional[index] = value;
      }
      return fn.apply(self, positional);
    }
    // Query-engine convention: Python keywords travel as one trailing object.
    return fn.apply(self, [...args, { __kw__: true, ...kwargs }]);
  }
  return fn.apply(self, args);
}

export function pyCall(fn: any, self: any, args: any[], kwargs: Kwargs): any {
  if (typeof fn !== 'function') {
    raise('TypeError', `'${typeName(fn)}' object is not callable`);
  }
  const py = (fn as PyCallable)[PY_CALL];
  if (py) return py(args, kwargs);
  return callHost(fn, self, args, kwargs);
}

/** Look up `receiver.name` for a call (before its arguments are evaluated). */
export function pyResolveMethod(receiver: any, name: string): ResolvedMethod {
  return resolveMethod(receiver, name);
}

export function pyInvokeMethod(resolved: ResolvedMethod, args: any[], kwargs: Kwargs): any {
  if (resolved.native) return (resolved.fn as NativeMethod)(resolved.self, args, kwargs);
  return pyCall(resolved.fn, resolved.self, args, kwargs);
}

/** Call `receiver.name(...)`. */
export function pyCallMethod(receiver: any, name: string, args: any[], kwargs: Kwargs): any {
  return pyInvokeMethod(resolveMethod(receiver, name), args, kwargs);
}

// ---------------------------------------------------------------------------
// Builtins
// ---------------------------------------------------------------------------

export function pySorted(iterable: any, key: any, reverse: boolean): any[] {
  const values = toArray(iterable);
  const keyed = values.map((value, index) => ({
    value,
    index,
    key: isNone(key) ? value : pyCall(key, undefined, [value], null),
  }));
  keyed.sort((left, right) => {
    const [a, b] = reverse ? [right, left] : [left, right];
    if (pyLess(a.key, b.key)) return -1;
    if (pyLess(b.key, a.key)) return 1;
    return 0;
  });
  return keyed.map((entry) => entry.value);
}

function extremum(name: 'max' | 'min', args: any[], kwargs: Kwargs): any {
  const key = kwargs?.key ?? null;
  const hasDefault = !!kwargs && 'default' in kwargs;
  let values: any[];
  if (args.length === 0) raise('TypeError', `${name} expected at least 1 argument, got 0`);
  if (args.length === 1) values = toArray(args[0]);
  else {
    if (hasDefault) raise('TypeError', `Cannot specify a default for ${name}() with multiple positional arguments`);
    values = args;
  }
  if (values.length === 0) {
    if (hasDefault) return kwargs!.default;
    raise('ValueError', `${name}() iterable argument is empty`);
  }
  let best = values[0];
  let bestKey = isNone(key) ? best : pyCall(key, undefined, [best], null);
  for (let i = 1; i < values.length; i++) {
    const candidateKey = isNone(key) ? values[i] : pyCall(key, undefined, [values[i]], null);
    const better = name === 'max' ? pyLess(bestKey, candidateKey) : pyLess(candidateKey, bestKey);
    if (better) {
      best = values[i];
      bestKey = candidateKey;
    }
  }
  return best;
}

function pyIntFromString(text: string, base: number): number {
  let s = text.trim().replace(/_/g, (m, offset: number, whole: string) =>
    /[0-9a-zA-Z]/.test(whole[offset - 1] ?? '') && /[0-9a-zA-Z]/.test(whole[offset + 1] ?? '') ? '' : '!');
  let sign = 1;
  if (s.startsWith('-')) { sign = -1; s = s.slice(1); } else if (s.startsWith('+')) s = s.slice(1);
  let radix = base;
  if (radix === 0) {
    if (/^0[xX]/.test(s)) { radix = 16; s = s.slice(2); } else if (/^0[oO]/.test(s)) { radix = 8; s = s.slice(2); } else if (/^0[bB]/.test(s)) { radix = 2; s = s.slice(2); } else {
      radix = 10;
      if (/^0+[1-9]/.test(s)) s = '!';
    }
  } else if (radix === 16) s = s.replace(/^0[xX]/, '');
  else if (radix === 8) s = s.replace(/^0[oO]/, '');
  else if (radix === 2) s = s.replace(/^0[bB]/, '');
  const digits = '0123456789abcdefghijklmnopqrstuvwxyz'.slice(0, radix);
  if (!s || ![...s.toLowerCase()].every((c) => digits.includes(c))) {
    raise('ValueError', `invalid literal for int() with base ${base}: ${pyRepr(text)}`);
  }
  return sign * parseInt(s, radix);
}

function pyFloatFromString(text: string): number {
  const s = text.trim().replace(/_/g, '').toLowerCase();
  if (/^[+-]?(inf|infinity)$/.test(s)) return s.startsWith('-') ? -Infinity : Infinity;
  if (/^[+-]?nan$/.test(s)) return Number.NaN;
  if (!/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/.test(s)) {
    raise('ValueError', `could not convert string to float: ${pyRepr(text)}`);
  }
  return Number(s);
}

function rangeValues(args: any[]): number[] {
  const ints = args.map((arg) => requireInt(arg, ''));
  let start = 0;
  let stop: number;
  let step = 1;
  if (ints.length === 1) [stop] = ints;
  else if (ints.length === 2) [start, stop] = ints;
  else if (ints.length === 3) [start, stop, step] = ints;
  else return raise('TypeError', `range expected at most 3 arguments, got ${ints.length}`);
  if (step === 0) raise('ValueError', 'range() arg 3 must not be zero');
  const count = Math.max(0, Math.ceil((stop - start) / step));
  if (count > 10_000_000) raise('MemoryError', 'range too large for the expression evaluator');
  const out = new Array<number>(count);
  for (let i = 0; i < count; i++) out[i] = start + i * step;
  return out;
}

function lazyMap(fn: any, iterables: any[]): Iterable<any> {
  const iterators = iterables.map((it) => pyIter(it)[Symbol.iterator]());
  return (function* generate() {
    for (;;) {
      const values: any[] = [];
      for (const iterator of iterators) {
        const step = iterator.next();
        if (step.done) return;
        values.push(step.value);
      }
      yield pyCall(fn, undefined, values, null);
    }
  })();
}

const INT_TYPE = pyTypeObject('int', (args, kwargs) => {
  const value = args.length ? args[0] : 0;
  const base = argAt(args, kwargs, 1, 'base', undefined);
  if (base !== undefined) {
    if (typeof value !== 'string') raise('TypeError', "int() can't convert non-string with explicit base");
    return pyIntFromString(value, requireInt(base, ''));
  }
  if (typeof value === 'string') return pyIntFromString(value, 10);
  const n = numericValue(value);
  if (n === null) {
    if (isNone(value)) raise('TypeError', "int() argument must be a string, a bytes-like object or a real number, not 'NoneType'");
    raise('TypeError', `int() argument must be a string, a bytes-like object or a real number, not '${typeName(value)}'`);
  }
  if (!Number.isFinite(n)) raise(Number.isNaN(n) ? 'ValueError' : 'OverflowError', 'cannot convert float to integer');
  return Math.trunc(n) + 0;
});

const FLOAT_TYPE = pyTypeObject('float', (args) => {
  const value = args.length ? args[0] : 0;
  if (typeof value === 'string') return makeFloat(pyFloatFromString(value));
  const n = numericValue(value);
  if (n === null) raise('TypeError', `float() argument must be a string or a real number, not '${typeName(value)}'`);
  return makeFloat(n);
});

const STR_TYPE = pyTypeObject('str', (args) => (args.length ? pyStr(args[0]) : ''));
const BOOL_TYPE = pyTypeObject('bool', (args) => (args.length ? pyBool(args[0]) : false));
const LIST_TYPE = pyTypeObject('list', (args) => (args.length ? toArray(args[0]) : []));
const TUPLE_TYPE = pyTypeObject('tuple', (args) => makeTuple(args.length ? toArray(args[0]) : []));
const SET_TYPE = pyTypeObject('set', (args) => makeSet(args.length ? toArray(args[0]) : []));
const FROZENSET_TYPE = pyTypeObject('frozenset', (args) => makeSet(args.length ? toArray(args[0]) : []));
const DICT_TYPE = pyTypeObject('dict', (args, kwargs) => {
  const entries: [any, any][] = [];
  if (args.length) {
    const source = args[0];
    if (isDictLike(source)) for (const key of dictKeys(source)) entries.push([key, dictGet(source, key)]);
    else for (const pair of toArray(source)) {
      const items = toArray(pair);
      if (items.length !== 2) raise('ValueError', `dictionary update sequence element has length ${items.length}; 2 is required`);
      entries.push([items[0], items[1]]);
    }
  }
  if (kwargs) for (const [key, value] of Object.entries(kwargs)) entries.push([key, value]);
  return makeDict(entries);
});
const NONE_TYPE = pyTypeObject('NoneType', () => null);
const OBJECT_TYPE = pyTypeObject('object', () => ({}));

const TYPE_BY_NAME: Record<string, PyType> = {
  int: INT_TYPE, float: FLOAT_TYPE, str: STR_TYPE, bool: BOOL_TYPE, list: LIST_TYPE,
  tuple: TUPLE_TYPE, set: SET_TYPE, frozenset: FROZENSET_TYPE, dict: DICT_TYPE,
  NoneType: NONE_TYPE,
};

function isInstance(value: any, type: any): boolean {
  if (Array.isArray(type)) return type.some((entry) => isInstance(value, entry));
  if (typeof type !== 'function') raise('TypeError', 'isinstance() arg 2 must be a type, a tuple of types, or a union');
  const name = (type as PyType).pyTypeName;
  if (name === 'object') return true;
  if (!name) return value instanceof (type as any);
  const actual = typeName(value);
  if (name === 'int') return actual === 'int' || actual === 'bool';
  return actual === name;
}

const TYPE_TYPE = pyTypeObject('type', (args) => {
  const name = typeName(args[0]);
  return TYPE_BY_NAME[name] ?? Object.assign(pyTypeObject(name, () => raise('TypeError', `cannot create '${name}' instances`)), {});
});

function genericIterator(value: any): Iterator<any> {
  return pyIter(value)[Symbol.iterator]();
}

const MATH = Object.freeze({
  floor: pyFunction('floor', (args) => {
    const n = numericValue(args[0]);
    if (n === null) raise('TypeError', `must be real number, not ${typeName(args[0])}`);
    if (!Number.isFinite(n)) raise('OverflowError', 'cannot convert float infinity to integer');
    return Math.floor(n);
  }),
  ceil: pyFunction('ceil', (args) => {
    const n = numericValue(args[0]);
    if (n === null) raise('TypeError', `must be real number, not ${typeName(args[0])}`);
    if (!Number.isFinite(n)) raise('OverflowError', 'cannot convert float infinity to integer');
    return Math.ceil(n);
  }),
  trunc: pyFunction('trunc', (args) => Math.trunc(numericValue(args[0]) ?? raise('TypeError', 'must be real number'))),
  sqrt: pyFunction('sqrt', (args) => {
    const n = numericValue(args[0]);
    if (n === null) raise('TypeError', `must be real number, not ${typeName(args[0])}`);
    if (n < 0) raise('ValueError', 'math domain error');
    return makeFloat(Math.sqrt(n));
  }),
  pow: pyFunction('pow', (args) => makeFloat((numericValue(args[0]) ?? 0) ** (numericValue(args[1]) ?? 0))),
  fabs: pyFunction('fabs', (args) => makeFloat(Math.abs(numericValue(args[0]) ?? 0))),
  log: pyFunction('log', (args) => {
    const n = numericValue(args[0]) ?? 0;
    if (n <= 0) raise('ValueError', 'math domain error');
    return makeFloat(args.length > 1 ? Math.log(n) / Math.log(numericValue(args[1]) ?? Math.E) : Math.log(n));
  }),
  log2: pyFunction('log2', (args) => makeFloat(Math.log2(numericValue(args[0]) ?? 0))),
  log10: pyFunction('log10', (args) => makeFloat(Math.log10(numericValue(args[0]) ?? 0))),
  exp: pyFunction('exp', (args) => makeFloat(Math.exp(numericValue(args[0]) ?? 0))),
  sin: pyFunction('sin', (args) => makeFloat(Math.sin(numericValue(args[0]) ?? 0))),
  cos: pyFunction('cos', (args) => makeFloat(Math.cos(numericValue(args[0]) ?? 0))),
  tan: pyFunction('tan', (args) => makeFloat(Math.tan(numericValue(args[0]) ?? 0))),
  atan2: pyFunction('atan2', (args) => makeFloat(Math.atan2(numericValue(args[0]) ?? 0, numericValue(args[1]) ?? 0))),
  hypot: pyFunction('hypot', (args) => makeFloat(Math.hypot(...args.map((a) => numericValue(a) ?? 0)))),
  isclose: pyFunction('isclose', (args, kw) => {
    const a = numericValue(args[0]) ?? 0;
    const b = numericValue(args[1]) ?? 0;
    const rel = numericValue(kw?.rel_tol ?? 1e-9) ?? 1e-9;
    const abs = numericValue(kw?.abs_tol ?? 0) ?? 0;
    return Math.abs(a - b) <= Math.max(rel * Math.max(Math.abs(a), Math.abs(b)), abs);
  }),
  copysign: pyFunction('copysign', (args) => makeFloat(Math.sign(numericValue(args[1]) ?? 1) * Math.abs(numericValue(args[0]) ?? 0))),
  gcd: pyFunction('gcd', (args) => {
    let [a, b] = args.map((arg) => Math.abs(requireInt(arg, '')));
    while (b) [a, b] = [b, a % b];
    return a ?? 0;
  }),
  isnan: pyFunction('isnan', (args) => Number.isNaN(numericValue(args[0]))),
  isinf: pyFunction('isinf', (args) => Math.abs(numericValue(args[0]) ?? 0) === Infinity),
  pi: Math.PI,
  e: Math.E,
  tau: Math.PI * 2,
  inf: Infinity,
  nan: Number.NaN,
});

/** Python builtins available to every expression. */
export const BUILTINS: Record<string, any> = {
  int: INT_TYPE,
  float: FLOAT_TYPE,
  str: STR_TYPE,
  bool: BOOL_TYPE,
  list: LIST_TYPE,
  tuple: TUPLE_TYPE,
  set: SET_TYPE,
  frozenset: FROZENSET_TYPE,
  dict: DICT_TYPE,
  object: OBJECT_TYPE,
  type: TYPE_TYPE,
  len: pyFunction('len', (args) => pyLen(args[0])),
  abs: pyFunction('abs', (args) => {
    const n = numericValue(args[0]);
    if (n === null) raise('TypeError', `bad operand type for abs(): '${typeName(args[0])}'`);
    return makeNumber(Math.abs(n), isFloatValue(args[0]));
  }),
  min: pyFunction('min', (args, kwargs) => extremum('min', args, kwargs)),
  max: pyFunction('max', (args, kwargs) => extremum('max', args, kwargs)),
  sum: pyFunction('sum', (args, kwargs) => {
    let total = argAt(args, kwargs, 1, 'start', 0);
    if (typeof total === 'string') raise('TypeError', "sum() can't sum strings [use ''.join(seq) instead]");
    for (const value of pyIter(args[0])) total = pyBinary('+', total, value);
    return total;
  }),
  any: pyFunction('any', (args) => {
    for (const value of pyIter(args[0])) if (pyBool(value)) return true;
    return false;
  }),
  all: pyFunction('all', (args) => {
    for (const value of pyIter(args[0])) if (!pyBool(value)) return false;
    return true;
  }),
  sorted: pyFunction('sorted', (args, kwargs) => {
    if (args.length !== 1) raise('TypeError', `sorted expected 1 argument, got ${args.length}`);
    return pySorted(args[0], kwargs?.key ?? null, pyBool(kwargs?.reverse ?? false));
  }),
  reversed: pyFunction('reversed', (args) => {
    const value = args[0];
    if (value instanceof Set || isGenerator(value)) raise('TypeError', `'${typeName(value)}' object is not reversible`);
    return toArray(value).reverse();
  }),
  enumerate: pyFunction('enumerate', (args, kwargs) => {
    let index = requireInt(argAt(args, kwargs, 1, 'start', 0), '');
    const source = pyIter(args[0]);
    return (function* generate() {
      for (const value of source) yield makeTuple([index++, value]);
    })();
  }),
  zip: pyFunction('zip', (args) => {
    const iterators = args.map((arg) => pyIter(arg)[Symbol.iterator]());
    return (function* generate() {
      if (iterators.length === 0) return;
      for (;;) {
        const values: any[] = [];
        for (const iterator of iterators) {
          const step = iterator.next();
          if (step.done) return;
          values.push(step.value);
        }
        yield makeTuple(values);
      }
    })();
  }),
  range: pyFunction('range', (args) => rangeValues(args)),
  map: pyFunction('map', (args) => lazyMap(args[0], args.slice(1))),
  filter: pyFunction('filter', (args) => {
    const fn = args[0];
    const source = pyIter(args[1]);
    return (function* generate() {
      for (const value of source) {
        if (isNone(fn) ? pyBool(value) : pyBool(pyCall(fn, undefined, [value], null))) yield value;
      }
    })();
  }),
  iter: pyFunction('iter', (args) => genericIterator(args[0])),
  next: pyFunction('next', (args) => {
    const iterator = args[0];
    if (!iterator || typeof iterator.next !== 'function') raise('TypeError', `'${typeName(iterator)}' object is not an iterator`);
    const step = iterator.next();
    if (step.done) {
      if (args.length > 1) return args[1];
      raise('StopIteration', '');
    }
    return step.value;
  }),
  round: pyFunction('round', (args, kwargs) => pyRound(args[0], argAt(args, kwargs, 1, 'ndigits', null))),
  divmod: pyFunction('divmod', (args) => makeTuple([pyBinary('//', args[0], args[1]), pyBinary('%', args[0], args[1])])),
  pow: pyFunction('pow', (args) => {
    if (args.length === 3) {
      const base = requireInt(args[0], '');
      const exp = requireInt(args[1], '');
      const mod = requireInt(args[2], '');
      return Number((BigInt(base) ** BigInt(exp)) % BigInt(mod));
    }
    return pyBinary('**', args[0], args[1]);
  }),
  chr: pyFunction('chr', (args) => String.fromCodePoint(requireInt(args[0], ''))),
  ord: pyFunction('ord', (args) => {
    const s = requireStr(args[0], 'ord() argument');
    if (Array.from(s).length !== 1) raise('TypeError', `ord() expected a character, but string of length ${s.length} found`);
    return s.codePointAt(0);
  }),
  hex: pyFunction('hex', (args) => { const n = requireInt(args[0], ''); return (n < 0 ? '-0x' : '0x') + Math.abs(n).toString(16); }),
  oct: pyFunction('oct', (args) => { const n = requireInt(args[0], ''); return (n < 0 ? '-0o' : '0o') + Math.abs(n).toString(8); }),
  bin: pyFunction('bin', (args) => { const n = requireInt(args[0], ''); return (n < 0 ? '-0b' : '0b') + Math.abs(n).toString(2); }),
  repr: pyFunction('repr', (args) => pyRepr(args[0])),
  ascii: pyFunction('ascii', (args) => pyRepr(args[0])),
  format: pyFunction('format', (args) => pyFormat(args[0], args.length > 1 ? requireStr(args[1], 'format spec') : '')),
  isinstance: pyFunction('isinstance', (args) => isInstance(args[0], args[1])),
  callable: pyFunction('callable', (args) => typeof args[0] === 'function'),
  getattr: pyFunction('getattr', (args) => {
    const name = requireStr(args[1], 'attribute name');
    if (args.length > 2) {
      try {
        return pyGetAttr(args[0], name);
      } catch (error) {
        if (error instanceof PyException && error.pyType === 'AttributeError') return args[2];
        throw error;
      }
    }
    return pyGetAttr(args[0], name);
  }),
  hasattr: pyFunction('hasattr', (args) => pyHasAttr(args[0], requireStr(args[1], 'attribute name'))),
  hash: pyFunction('hash', (args) => {
    if (!isHashable(args[0])) raise('TypeError', `unhashable type: '${typeName(args[0])}'`);
    return 0;
  }),
  id: pyFunction('id', () => 0),
  print: pyFunction('print', (args) => {
    console.log(...args.map(pyStr));
    return null;
  }),
  slice: pyFunction('slice', (args) => args.length === 1 ? makeSlice(null, args[0], null) : makeSlice(args[0], args[1], args[2] ?? null)),
  Ellipsis: Object.freeze({ __pyEllipsis: true }),
  NotImplemented: Object.freeze({ __pyNotImplemented: true }),
};

/** Python's `math` module (imported into every LT eval context). */
export const MATH_MODULE = MATH;

/** Exception type names exposed as builtins (for isinstance checks/repr). */
for (const name of ['Exception', 'ValueError', 'TypeError', 'KeyError', 'IndexError', 'AttributeError',
  'NameError', 'ZeroDivisionError', 'StopIteration']) {
  BUILTINS[name] = pyTypeObject(name, (args) => new PyException(name, args.map(pyStr).join(', ')));
}
