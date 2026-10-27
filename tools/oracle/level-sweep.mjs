#!/usr/bin/env node
/**
 * Level-start differential: start every level of a project from one captured
 * run state on both engines, settle to the first player phase, and diff the
 * snapshots level by level.
 *
 *   node tools/oracle/level-sweep.mjs [scenario.json] [--levels=0,1,Act_1]
 *        [--chunk=10] [--workers=3] [--report=FILE] [-v]
 *
 * The scenario (default scenarios/eotf-level-sweep.json) holds the project,
 * the run state (capture_run_state.py output, see README "Run states"),
 * seed, mode and known diffs; its "levels" may be "all" (every level in the
 * project except DEBUG). Levels run in chunks: one Python process and one
 * page per chunk, `workers` chunks at a time. Raw runs go to
 * $LT_ORACLE_OUT/<name>/chunk-N.{py,web}.json; the per-level table is printed
 * and written to the report file (default $LT_ORACLE_OUT/<name>/report.md).
 * Exit code: 0 every level matches, 1 differences, 2 harness failures.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { ensureServer, runWebScenario } from './web-driver.mjs';
import { diffRuns } from './diff.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const HOME = process.env.LT_ORACLE_HOME ?? 'E:/BigData/lt-oracle';
const OUT = process.env.LT_ORACLE_OUT ?? path.join(HOME, 'out');

function oracleConfig() {
  const file = path.join(HOME, 'config.json');
  const cfg = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  if (process.env.LT_FORK_ENGINE) cfg.fork_engine = process.env.LT_FORK_ENGINE;
  if (process.env.LT_FORK_PYTHON) cfg.fork_python = process.env.LT_FORK_PYTHON;
  return cfg;
}

function projectLevels(project) {
  const dir = path.join(ROOT, 'lt-maker', project, 'game_data');
  const file = path.join(dir, 'levels.json');
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8')).map((l) => l.nid);
  const order = path.join(dir, 'levels', '.orderkeys');
  return JSON.parse(fs.readFileSync(order, 'utf8'));
}

function runPython(scenarioFile, outFile, backend, verbose) {
  const python = backend === 'fork'
    ? oracleConfig().fork_python
    : process.env.LT_ORACLE_PYTHON ?? path.join(HOME, 'venv', 'Scripts', 'python.exe');
  return new Promise((resolve) => {
    const child = spawn(python, ['-I', path.join(HERE, 'py_driver.py'), scenarioFile, '-o', outFile,
      '--backend', backend], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d) => {
      err += d;
      if (verbose) process.stderr.write(d);
    });
    child.on('error', (e) => resolve({ engine: 'python', steps: [], error: `spawn ${python}: ${e.message}` }));
    child.on('close', () => {
      try {
        resolve(JSON.parse(fs.readFileSync(outFile, 'utf8')));
      } catch {
        resolve({ engine: 'python', steps: [], error: `no output; stderr tail:\n${err.split('\n').slice(-15).join('\n')}` });
      }
    });
  });
}

/**
 * Diffs on generic units' construction (stats, HP, weapon experience and the
 * weapon it equips, growth points, party, class skills): reported in their
 * own column, since generic unit setup is tracked separately from the level
 * flow this sweep checks.
 */
const UNIT_SETUP_FIELDS = new Set(['stats', 'hp', 'max_hp', 'wexp', 'equipped_weapon', 'growth_points',
  'party', 'skills', 'level', 'skill_data']);
function isUnitSetup(d, pySnap, webSnap) {
  const parts = d.path.split('.');
  if (parts[0] !== 'units' || parts.length < 3 || !UNIT_SETUP_FIELDS.has(parts[2])) return false;
  const unit = pySnap?.units?.[parts[1]] ?? webSnap?.units?.[parts[1]];
  return !!unit?.generic;
}

/** Group a level's diff paths into short categories for the table. */
function categories(diffs) {
  const count = new Map();
  for (const d of diffs) {
    const parts = d.path.split('.');
    let key = parts[0];
    if (parts[0] === 'units') key = parts.length > 2 ? `units.*.${parts[2]}` : 'units (roster)';
    else if (['game_vars', 'level_vars'].includes(parts[0])) key = `${parts[0]}.${parts[1]}`;
    count.set(key, (count.get(key) ?? 0) + 1);
  }
  return [...count.entries()].sort((a, b) => b[1] - a[1]);
}

async function main() {
  const argv = process.argv.slice(2);
  const opt = (name, dflt) => argv.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=') ?? dflt;
  const verbose = argv.includes('-v');
  const scnFile = path.resolve(argv.find((a) => !a.startsWith('-')) ?? path.join(HERE, "sweeps", "eotf-level-sweep.json"));
  const base = JSON.parse(fs.readFileSync(scnFile, 'utf8'));
  const project = base.project ?? 'eotf.ltproj';
  let levels = opt('levels') ? opt('levels').split(',') : base.levels;
  if (!levels || levels === 'all') levels = projectLevels(project).filter((l) => l !== 'DEBUG');
  const chunkSize = Number(opt('chunk', 10));
  const workers = Number(opt('workers', 3));
  const backend = base.engine ?? (project === 'eotf.ltproj' ? 'fork' : 'upstream');
  const name = base.name ?? path.basename(scnFile, '.json');
  const dir = path.join(OUT, name);
  fs.mkdirSync(dir, { recursive: true });

  const chunks = [];
  for (let i = 0; i < levels.length; i += chunkSize) chunks.push(levels.slice(i, i + chunkSize));
  const stop = await ensureServer();
  const browser = await chromium.launch({ args: ['--mute-audio'] });
  const results = new Map();
  let next = 0;
  const started = Date.now();
  async function worker() {
    while (next < chunks.length) {
      const idx = next++;
      const scenario = { ...base, name: `${name}-chunk-${idx}`, levels: chunks[idx] };
      const file = path.join(dir, `chunk-${idx}.json`);
      fs.writeFileSync(file, JSON.stringify({ ...scenario, run_state: base.run_state }, null, 1));
      const [py, web] = await Promise.all([
        runPython(file, path.join(dir, `chunk-${idx}.py.json`), backend, verbose),
        runWebScenario(scenario, { browser, verbose, base: path.dirname(scnFile) })
          .catch((e) => ({ engine: 'web', steps: [], error: String(e?.stack ?? e) })),
      ]);
      fs.writeFileSync(path.join(dir, `chunk-${idx}.web.json`), JSON.stringify(web, null, 1));
      chunks[idx].forEach((level, i) => {
        const report = diffRuns(
          { ...py, error: py.error, steps: py.steps?.[i] ? [py.steps[i]] : [] },
          { ...web, error: web.error, steps: web.steps?.[i] ? [web.steps[i]] : [] },
          base,
        );
        report.snaps = [py.steps?.[i]?.snapshot, web.steps?.[i]?.snapshot];
        results.set(level, report);
      });
      process.stderr.write(`chunk ${idx + 1}/${chunks.length} done (${Math.round((Date.now() - started) / 1000)}s)\n`);
    }
  }
  try {
    await Promise.all(Array.from({ length: Math.min(workers, chunks.length) }, worker));
  } finally {
    await browser.close();
    await stop();
  }

  const lines = [`# Level-start differential: ${name}`, '',
    `Project ${project}, python:${backend} vs web, seed ${base.seed ?? 0}, run state ${typeof base.run_state === 'string' ? base.run_state : 'inline'}.`, '',
    '| Level | Result | Diffs | Unit setup | Known | Main differences |', '|---|---|---|---|---|---|'];
  let worst = 0;
  const tally = { MATCH: 0, SETUP: 0, DIFF: 0, ERROR: 0 };
  const allCats = new Map();
  for (const level of levels) {
    const r = results.get(level);
    const step = r?.steps?.[0];
    const errs = [...(r?.errors ?? []), ...(step?.errors ?? [])];
    const all = step?.diffs ?? [];
    const setup = all.filter((d) => isUnitSetup(d, ...(r?.snaps ?? [])));
    const diffs = all.filter((d) => !setup.includes(d));
    const result = errs.length ? 'ERROR' : diffs.length ? 'DIFF' : setup.length ? 'SETUP' : 'MATCH';
    tally[result]++;
    worst = Math.max(worst, result === 'ERROR' ? 2 : result === 'MATCH' ? 0 : 1);
    const cats = categories(diffs);
    for (const [k, n] of cats) allCats.set(k, (allCats.get(k) ?? 0) + n);
    const main = errs.length
      ? errs.map((e) => e.split('\n')[0].slice(0, 120)).join('; ')
      : cats.slice(0, 4).map(([k, n]) => `${k} (${n})`).join(', ');
    lines.push(`| ${level} | ${result} | ${diffs.length} | ${setup.length} | ${step?.known?.length ?? 0} | ${main.replace(/\|/g, '/')} |`);
  }
  lines.push('', `Totals: ${tally.MATCH} match, ${tally.SETUP} differ only in generic unit setup, ${tally.DIFF} differ, ${tally.ERROR} error (${levels.length} levels).`, '');
  lines.push('Diff categories over all levels (generic unit setup excluded):', '');
  for (const [k, n] of [...allCats.entries()].sort((a, b) => b[1] - a[1])) lines.push(`- ${k}: ${n}`);
  const reportFile = opt('report', path.join(dir, 'report.md'));
  fs.writeFileSync(reportFile, lines.join('\n') + '\n');
  // Full per-level diffs for follow-up work.
  fs.writeFileSync(path.join(dir, 'diffs.json'), JSON.stringify(Object.fromEntries(
    levels.map((l) => [l, results.get(l)?.steps?.[0] ?? { errors: results.get(l)?.errors }])), null, 1));
  // (diffs.json keeps every diff, unit setup included.)
  console.log(lines.join('\n'));
  console.log(`(report ${reportFile}; raw runs and diffs.json in ${dir})`);
  process.exit(worst);
}

main().catch((err) => { console.error(err); process.exit(2); });
