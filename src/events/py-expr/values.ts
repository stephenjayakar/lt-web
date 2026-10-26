/**
 * Python value representation used by the expression evaluator.
 *
 *  - None            -> null (undefined from JS is also read as None)
 *  - bool            -> boolean
 *  - int             -> integral JS number
 *  - float           -> non-integral JS number, or a PyFloat box when the
 *                       float has an integral value (so `4 / 2` stays `2.0`)
 *  - str             -> string
 *  - list            -> Array
 *  - tuple           -> Array registered in TUPLES (positions coming from the
 *                       engine are plain arrays and compare equal to tuples)
 *  - dict            -> Map, or a plain object for string-keyed data
 *  - set / frozenset -> Set
 *
 * Everything else is a host (engine) object accessed through its properties.
 */

export class PyFloat {
  readonly value: number;
  constructor(value: number) {
    this.value = value;
  }
  valueOf(): number {
    return this.value;
  }
  toString(): string {
    return formatFloat(this.value);
  }
  toJSON(): number {
    return this.value;
  }
}

/** Tuples are arrays tagged here so repr() and type() can tell them apart. */
export const TUPLES = new WeakSet<object>();

export function makeTuple<T>(values: T[]): T[] {
  TUPLES.add(values);
  return values;
}

export function isTuple(value: unknown): value is any[] {
  return Array.isArray(value) && TUPLES.has(value);
}

/** Canonical numeric constructor: floats with integral values get boxed. */
export function makeNumber(value: number, isFloat: boolean): number | PyFloat {
  if (isFloat && Number.isInteger(value)) return new PyFloat(value);
  return value;
}

export function makeFloat(value: number): number | PyFloat {
  return Number.isInteger(value) ? new PyFloat(value) : value;
}

/** Python repr() of a float. */
export function formatFloat(value: number): string {
  if (Number.isNaN(value)) return 'nan';
  if (value === Infinity) return 'inf';
  if (value === -Infinity) return '-inf';
  if (Object.is(value, -0)) return '-0.0';
  const abs = Math.abs(value);
  if (abs !== 0 && (abs >= 1e16 || abs < 1e-4)) {
    const [mantissa, exponent] = value.toExponential().split('e');
    const sign = exponent.startsWith('-') ? '-' : '+';
    const digits = exponent.replace(/^[+-]/, '').padStart(2, '0');
    return `${mantissa}e${sign}${digits}`;
  }
  const text = String(value);
  return Number.isInteger(value) ? `${text}.0` : text;
}

export function isFloatValue(value: unknown): boolean {
  return value instanceof PyFloat || (typeof value === 'number' && !Number.isInteger(value));
}

/** Python `int`/`bool`/`float` -> JS number (null for non-numbers). */
export function numericValue(value: unknown): number | null {
  if (typeof value === 'number') return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value instanceof PyFloat) return value.value;
  return null;
}

/** Convert evaluator results into plain JS values for engine callers. */
export function toHostValue(value: unknown): any {
  if (value instanceof PyFloat) return value.value;
  if (Array.isArray(value) && value.some((entry) => entry instanceof PyFloat || Array.isArray(entry))) {
    const converted = value.map(toHostValue);
    return isTuple(value) ? makeTuple(converted) : converted;
  }
  return value;
}

/** Maps that behave like Python's collections.Counter (missing key -> 0). */
const COUNTERS = new WeakSet<object>();

export function markCounter(map: Map<any, any>): void {
  COUNTERS.add(map);
}

export function isCounter(value: unknown): boolean {
  return !!value && typeof value === 'object' && COUNTERS.has(value);
}
