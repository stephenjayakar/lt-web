/**
 * Python-semantics unit tests for src/events/py-expr (the evaluator behind
 * every event condition, {e:} tag, game_var/level_var value, item/skill
 * component expression and equation).
 *
 * tests/fixtures/py-expr-semantics.json holds CPython's answers for ~450
 * expressions (scripts/py-expr-ground-truth.py); each is replayed here and
 * must match exactly, apart from the documented list/tuple deviation.
 */
import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import {
  MATH_MODULE,
  PyException,
  PySyntaxError,
  evaluatePython,
  evaluatePythonRaw,
  makeTuple,
  pyRepr,
  scopeFromRecord,
} from '../src/events/py-expr/index';

interface FixtureCase {
  expr: string;
  repr?: string;
  error?: string;
}

const fixture = JSON.parse(fs.readFileSync(
  path.join(process.cwd(), 'tests', 'fixtures', 'py-expr-semantics.json'),
  'utf8',
)) as { python: string; cases: FixtureCase[] };

/**
 * Engine positions are plain arrays that Python sees as tuples, so arrays
 * without a tuple tag compare structurally with tuples. The only visible
 * cost is that a list literal also equals/concatenates with a tuple.
 */
const KNOWN_DEVIATIONS = new Map<string, string>([
  ['[1] + (2,)', '[1, 2]'],
  ['[1, 2] == (1, 2)', 'True'],
  ['[1] < (1,)', 'False'],
  ['[3, 4] in [pos]', 'True'],
]);

class EngineObject {
  constructor(fields: Record<string, unknown>) {
    Object.assign(this, fields);
  }
}

function fixtureScope() {
  return scopeFromRecord({
    a: [1, 2],
    b: [3],
    x: 5,
    y: 2.5,
    z: 0,
    n: null,
    s: 'hello',
    e: '',
    t: makeTuple([1, 2]),
    st: new Set([1, 2]),
    d: { k: 1, j: [2] },
    pos: makeTuple([3, 4]),
    tags: ['Mounted', 'Flier'],
    unit: new EngineObject({ nid: 'Eirika', team: 'player', tags: ['Lord'], level: 3 }),
    math: MATH_MODULE,
  });
}

function outcome(expr: string, scope = fixtureScope()): { repr?: string; error?: string } {
  try {
    let value = evaluatePythonRaw(expr, scope);
    if (value && typeof value === 'object' && typeof value.next === 'function' && !Array.isArray(value)) {
      value = Array.from(value as Iterable<unknown>);
    }
    return { repr: pyRepr(value) };
  } catch (error) {
    if (error instanceof PyException) return { error: error.pyType };
    if (error instanceof PySyntaxError) return { error: 'SyntaxError' };
    throw error;
  }
}

test.describe('Python expression semantics', () => {
  test(`matches CPython ${fixture.python} on every fixture expression`, () => {
    const mismatches: string[] = [];
    for (const entry of fixture.cases) {
      const expected = KNOWN_DEVIATIONS.has(entry.expr)
        ? { repr: KNOWN_DEVIATIONS.get(entry.expr) }
        : entry.error ? { error: entry.error } : { repr: entry.repr };
      const actual = outcome(entry.expr);
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        mismatches.push(`${entry.expr}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
      }
    }
    expect(fixture.cases.length).toBeGreaterThan(400);
    expect(mismatches).toEqual([]);
  });

  test('the playtest precedence bugs evaluate like Python', () => {
    const scope = scopeFromRecord({ a: 'x', b: 'y', x: ['x|y'] });
    expect(evaluatePython('1 + 2 == 3', scope)).toBe(true);
    expect(evaluatePython('max(1 + 1, 3)', scope)).toBe(3);
    expect(evaluatePython("a + '|' + b not in x", scope)).toBe(false);
    expect(evaluatePython("a + '|' + b in x", scope)).toBe(true);
    expect(evaluatePython('[1] + [2] == [1, 2]', scope)).toBe(true);
  });

  test('generator expressions are lazy, so any() stops at the first match', () => {
    let calls = 0;
    const scope = scopeFromRecord({
      probe: (value: number) => {
        calls++;
        if (value > 2) throw new Error('evaluated past the first match');
        return value === 2;
      },
    });
    expect(evaluatePython('any(probe(i) for i in [1, 2, 3])', scope)).toBe(true);
    expect(calls).toBe(2);
    // A list comprehension is eager, as in Python.
    expect(() => evaluatePython('any([probe(i) for i in [1, 2, 3]])', scope)).toThrow();
  });

  test('integral floats stay floats until they reach engine code', () => {
    const scope = fixtureScope();
    expect(pyRepr(evaluatePythonRaw('4 / 2', scope))).toBe('2.0');
    expect(pyRepr(evaluatePythonRaw('str(4 / 2)', scope))).toBe("'2.0'");
    expect(evaluatePython('4 / 2', scope)).toBe(2);
    expect(() => evaluatePython('range(4 / 2)', scope)).toThrow(PyException);
  });

  test('engine objects are read through their properties and methods', () => {
    class Unit {
      nid = 'Seth';
      currentHp = 30;
      stats = new Map([['STR', 14]]);
      getStat(nid: string) { return this.stats.get(nid) ?? 0; }
      get_hp() { return this.currentHp; }
    }
    const scope = scopeFromRecord({
      unit: new Unit(),
      query: (...args: unknown[]) => args,
    });
    expect(evaluatePython('unit.get_hp() > 20 and unit.nid == "Seth"', scope)).toBe(true);
    expect(evaluatePython("unit.stats.get('STR', 0) + unit.stats.get('MAG', 1)", scope)).toBe(15);
    expect(evaluatePython("'STR' in unit.stats", scope)).toBe(true);
    // camelCase fallback for snake_case reads of engine fields
    expect(evaluatePython('unit.current_hp', scope)).toBe(30);
    // keyword arguments reach query helpers as a trailing __kw__ object
    expect(evaluatePython("query(1, dist=2)", scope)).toEqual([1, { __kw__: true, dist: 2 }]);
    expect(() => evaluatePython('unit.missing_attribute', scope)).toThrow(PyException);
  });
});
