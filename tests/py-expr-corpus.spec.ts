/**
 * Every Python expression Embrace of the Fog hands to eval() (event
 * conditions, if/elif/for, {e:} tags, game_var/level_var and other command
 * values, #pyev1 statements, item/skill component expressions, AI and region
 * conditions, equations; see scripts/py-expr-corpus.mjs) must parse with the
 * web's Python parser exactly as CPython parses it.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
// @ts-expect-error - plain ESM helper script
import { collectCorpus, uniqueCorpus } from '../scripts/py-expr-corpus.mjs';
import { parsePythonExpression } from '../src/events/py-expr/parser';
import { canonical } from './helpers/py-expr-canonical';

const projectDir = path.join(process.cwd(), 'lt-maker/eotf.ltproj');
const projectAvailable = fs.existsSync(path.join(projectDir, 'game_data', 'events.json'));

/**
 * Authored expressions that are not valid Python; CPython's eval() raises
 * SyntaxError on them too, and the engine's except-clause applies.
 */
const AUTHORED_SYNTAX_ERRORS = [
  "if v('heisen_tome') and not v('heisen_owner')",
  "item.nid in ['Bewildering', 'Bewildering_Plus]",
  "-2 * item2.damage.value if any([tag == 'Dragon' for tag in item2.effective_damage.tags])",
  "-2 * item2.damage.value if item_system.weapon_type(target, item2) == 'Dark'",
];

function pythonAvailable(): boolean {
  try {
    execFileSync('python3', ['-c', 'import ast'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

test.describe('EOtF Python expression corpus', () => {
  test.skip(!projectAvailable, 'lt-maker/eotf.ltproj is not linked');

  test('parses every EOtF expression; only CPython-invalid ones fail', () => {
    const corpus = uniqueCorpus(collectCorpus(projectDir)) as { expr: string; kinds: string[] }[];
    expect(corpus.length).toBeGreaterThan(7_500);
    const failures: string[] = [];
    for (const entry of corpus) {
      try {
        parsePythonExpression(entry.expr);
      } catch (error) {
        if ((error as Error).name !== 'PySyntaxError') throw error;
        failures.push(entry.expr);
      }
    }
    // Two more authored strings are cut short by an unterminated quote.
    expect(failures.filter((expr) => !AUTHORED_SYNTAX_ERRORS.includes(expr) &&
      !expr.includes("== '0))") && !expr.includes("['Sword', 'Lance, 'Axe', 'Bow']"))).toEqual([]);
    expect(failures).toHaveLength(6);
  });

  test('every parse tree matches CPython ast, precedence included', () => {
    test.skip(!pythonAvailable(), 'python3 is not installed');
    const corpus = uniqueCorpus(collectCorpus(projectDir)) as { expr: string }[];
    const fixture = JSON.parse(fs.readFileSync(
      path.join(process.cwd(), 'tests', 'fixtures', 'py-expr-semantics.json'),
      'utf8',
    )) as { cases: { expr: string }[] };
    const expressions = [...corpus.map((entry) => entry.expr), ...fixture.cases.map((entry) => entry.expr)];
    const python = JSON.parse(execFileSync(
      'python3',
      ['-I', path.join(process.cwd(), 'scripts', 'py-expr-canonical-ast.py')],
      { input: JSON.stringify(expressions), maxBuffer: 1 << 28 },
    ).toString()) as string[];
    const mismatches: string[] = [];
    expressions.forEach((expr, index) => {
      let ours: string;
      try {
        ours = canonical(parsePythonExpression(expr.trim()));
      } catch (error) {
        if ((error as Error).name !== 'PySyntaxError') throw error;
        ours = 'SyntaxError';
      }
      if (ours !== python[index]) mismatches.push(`${expr}\n  python: ${python[index]}\n  ours:   ${ours}`);
    });
    expect(mismatches.slice(0, 20)).toEqual([]);
  });
});
