#!/usr/bin/env node
/**
 * Level differential: start every level of a project from one captured
 * run state on both engines, settle to the first player phase, run the
 * scenario's "level_actions" (e.g. end the turn) on every turn-based level,
 * and diff the snapshots level by level and step by step.
 *
 *   node tools/oracle/level-sweep.mjs [scenario.json] [--levels=0,1,Act_1]
 *        [--chunk=10] [--workers=3] [--report=FILE] [-v]
 *
 * The scenario (default sweeps/eotf-level-sweep.json) holds the project,
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
      // Group each side's steps by level (a level contributes its start
      // snapshot plus one per level action that ran).
      const byLevel = (run) => {
        const m = new Map();
        for (const st of run.steps ?? []) {
          const l = st.action?.level;
          if (!m.has(l)) m.set(l, []);
          m.get(l).push(st);
        }
        return m;
      };
      const pySteps = byLevel(py);
      const webSteps = byLevel(web);
      for (const level of chunks[idx]) {
        const ps = pySteps.get(level) ?? [];
        const ws = webSteps.get(level) ?? [];
        const report = diffRuns({ ...py, steps: ps }, { ...web, steps: ws }, base);
        report.snaps = report.steps.map((_, i) => [ps[i]?.snapshot, ws[i]?.snapshot]);
        results.set(level, report);
      }
      process.stderr.write(`chunk ${idx + 1}/${chunks.length} done (${Math.round((Date.now() - started) / 1000)}s)\n`);
    }
  }
  try {
    await Promise.all(Array.from({ length: Math.min(workers, chunks.length) }, worker));
  } finally {
    await browser.close();
    await stop();
  }

  const actions = (base.level_actions ?? []).map((a) => a.do);
  const lines = [`# Level differential: ${name}`, '',
    `Project ${project}, python:${backend} vs web, seed ${base.seed ?? 0}, run state ${typeof base.run_state === 'string' ? base.run_state : 'inline'}, ` +
    `steps per turn-based level: start${actions.map((a) => `, ${a}`).join('')}.`, '',
    'Per step: MATCH, SETUP (only generic unit setup differs) or DIFF n (+k new since the previous step). ' +
    'Main differences list the new diff categories of the last step that has any.', '',
    `| Level | start | ${actions.join(' | ')}${actions.length ? ' | ' : ''}Main differences |`,
    `|---|---|${actions.map(() => '---|').join('')}---|`];
  let worst = 0;
  const tally = new Map();
  const allCats = new Map();
  if (base.roam_tour) {
    // Free roam tour: one row per interaction; each starts from a fresh level,
    // so "new" diffs are those the level start did not already have.
    lines.splice(lines.length - 2, 2, '| Level | Interaction | Result | Main differences |', '|---|---|---|---|');
  }
  for (const level of levels) {
    const r = results.get(level);
    if (base.roam_tour) {
      const steps = r?.steps ?? [];
      const startPaths = new Set((steps[0]?.diffs ?? []).map((d) => d.path));
      steps.forEach((step, i) => {
        const errs = [...(i === 0 ? r?.errors ?? [] : []), ...(step.errors ?? [])];
        const setup = step.diffs.filter((d) => isUnitSetup(d, ...(r.snaps[i] ?? [])));
        const diffs = step.diffs.filter((d) => !setup.includes(d) && (i === 0 || !startPaths.has(d.path)));
        const result = errs.length ? 'ERROR' : diffs.length ? `DIFF ${diffs.length}` : setup.length ? 'SETUP' : 'MATCH';
        const key = `${i === 0 ? 'start' : 'interaction'}:${result.split(' ')[0]}`;
        tally.set(key, (tally.get(key) ?? 0) + 1);
        worst = Math.max(worst, errs.length ? 2 : diffs.length ? 1 : 0);
        const cats = categories(diffs);
        for (const [k, c] of cats) allCats.set(k, (allCats.get(k) ?? 0) + c);
        const main = errs.length ? errs.map((x) => x.split(String.fromCharCode(10))[0].slice(0, 120)).join('; ')
          : cats.slice(0, 4).map(([k, c]) => `${k} (${c})`).join(', ');
        lines.push(`| ${level} | ${i === 0 ? 'start' : `${step.action.kind ?? ''} ${step.action.target ?? ''}`} | ${result} | ${main.replace(/\|/g, '/')} |`);
      });
      if (!steps.length) lines.push(`| ${level} | start | ERROR | ${(r?.errors ?? []).join('; ').slice(0, 120)} |`);
      continue;
    }
    const cells = [];
    let main = '';
    let prevPaths = new Set();
    const n = Math.max(1, 1 + actions.length);
    for (let i = 0; i < n; i++) {
      const step = r?.steps?.[i];
      if (!step) {
        cells.push(i === 0 ? 'ERROR' : '-');
        continue;
      }
      const errs = [...(i === 0 ? r?.errors ?? [] : []), ...(step.errors ?? [])];
      const setup = step.diffs.filter((d) => isUnitSetup(d, ...(r.snaps[i] ?? [])));
      const diffs = step.diffs.filter((d) => !setup.includes(d));
      const fresh = diffs.filter((d) => !prevPaths.has(d.path));
      prevPaths = new Set(step.diffs.map((d) => d.path));
      const result = errs.length ? 'ERROR' : diffs.length ? 'DIFF' : setup.length ? 'SETUP' : 'MATCH';
      const key = `${i === 0 ? 'start' : actions[i - 1]}:${result}`;
      tally.set(key, (tally.get(key) ?? 0) + 1);
      worst = Math.max(worst, result === 'ERROR' ? 2 : result === 'MATCH' ? 0 : 1);
      cells.push(result === 'DIFF' ? `DIFF ${diffs.length}${i ? ` (+${fresh.length})` : ''}` : result);
      if (errs.length) main = errs.map((e) => e.split('\n')[0].slice(0, 120)).join('; ');
      else if (fresh.length) {
        const cats = categories(fresh);
        for (const [k, c] of cats) allCats.set(k, (allCats.get(k) ?? 0) + c);
        main = cats.slice(0, 4).map(([k, c]) => `${k} (${c})`).join(', ');
      }
    }
    lines.push(`| ${level} | ${cells.join(' | ')} | ${main.replace(/\|/g, '/')} |`);
  }
  lines.push('', `Totals (${levels.length} levels): ${[...tally.entries()].map(([k, v]) => `${k} ${v}`).join(', ')}.`, '');
  lines.push('New diff categories over all levels and steps (generic unit setup excluded):', '');
  for (const [k, c] of [...allCats.entries()].sort((a, b) => b[1] - a[1])) lines.push(`- ${k}: ${c}`);
  const reportFile = opt('report', path.join(dir, 'report.md'));
  fs.writeFileSync(reportFile, lines.join('\n') + '\n');
  // Full per-level diffs (every step, unit setup included) for follow-up work.
  fs.writeFileSync(path.join(dir, 'diffs.json'), JSON.stringify(Object.fromEntries(
    levels.map((l) => [l, results.get(l) ? { errors: results.get(l).errors, steps: results.get(l).steps } : null])), null, 1));
  console.log(lines.join('\n'));
  console.log(`(report ${reportFile}; raw runs and diffs.json in ${dir})`);
  process.exit(worst);
}

main().catch((err) => { console.error(err); process.exit(2); });
