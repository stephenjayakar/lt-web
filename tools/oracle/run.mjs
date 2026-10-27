#!/usr/bin/env node
/**
 * Differential oracle: run scenarios through the Python engine and the web
 * engine and print field-level differences.
 *
 *   npm run oracle -- [scenario.json | name | dir ...] [--full] [--all]
 *                     [--backend=upstream|fork] [--web-only|--py-only] [-v]
 *
 * With no scenario arguments every tools/oracle/scenarios/*.json runs.
 * The Python side runs upstream lt-maker, or a project's engine fork for
 * fork projects (EOtF): see py_driver.py and README.md. Fork paths come from
 * LT_FORK_ENGINE / LT_FORK_PYTHON or $LT_ORACLE_HOME/config.json.
 * Raw run outputs go to $LT_ORACLE_OUT (default E:/BigData/lt-oracle/out).
 * Exit code: 0 all match, 1 differences, 2 harness failure.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { ensureServer, runWebScenario } from './web-driver.mjs';
import { diffRuns, formatReport } from './diff.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCENARIOS = path.join(HERE, 'scenarios');
const HOME = process.env.LT_ORACLE_HOME ?? 'E:/BigData/lt-oracle';
const OUT = process.env.LT_ORACLE_OUT ?? path.join(HOME, 'out');
const PYTHON = process.env.LT_ORACLE_PYTHON ?? path.join(HOME, 'venv', 'Scripts', 'python.exe');
// Keep in sync with FORK_PROJECTS in py_driver.py.
const FORK_PROJECTS = new Set(['eotf.ltproj']);

function oracleConfig() {
  const file = path.join(HOME, 'config.json');
  const cfg = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  if (process.env.LT_FORK_ENGINE) cfg.fork_engine = process.env.LT_FORK_ENGINE;
  if (process.env.LT_FORK_PYTHON) cfg.fork_python = process.env.LT_FORK_PYTHON;
  return cfg;
}

function pickBackend(scenario, override) {
  if (override) return override;
  if (scenario.engine) return scenario.engine;
  return FORK_PROJECTS.has(scenario.project ?? 'default.ltproj') ? 'fork' : 'upstream';
}

function resolveScenarios(args) {
  if (!args.length) args = [SCENARIOS];
  const files = [];
  for (const a of args) {
    let p = a;
    if (!fs.existsSync(p)) p = path.join(SCENARIOS, a.endsWith('.json') ? a : `${a}.json`);
    if (!fs.existsSync(p)) throw new Error(`no scenario ${a}`);
    if (fs.statSync(p).isDirectory()) {
      for (const f of fs.readdirSync(p).sort()) if (f.endsWith('.json')) files.push(path.join(p, f));
    } else {
      files.push(p);
    }
  }
  return files;
}

function runPython(file, outFile, backend, verbose) {
  const python = backend === 'fork' ? oracleConfig().fork_python : PYTHON;
  if (!python) {
    return Promise.resolve({
      engine: 'python', backend, steps: [],
      error: 'fork backend needs LT_FORK_PYTHON (or fork_python in $LT_ORACLE_HOME/config.json)',
    });
  }
  return new Promise((resolve) => {
    const args = ['-I', path.join(HERE, 'py_driver.py'), file, '-o', outFile, '--backend', backend];
    const child = spawn(python, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d) => {
      err += d;
      if (verbose) process.stderr.write(d);
    });
    child.on('error', (e) => resolve({ engine: 'python', backend, steps: [], error: `spawn ${python}: ${e.message}` }));
    child.on('close', () => {
      try {
        resolve(JSON.parse(fs.readFileSync(outFile, 'utf8')));
      } catch {
        resolve({ engine: 'python', steps: [], error: `no output; stderr tail:\n${err.split('\n').slice(-15).join('\n')}` });
      }
    });
  });
}

async function main() {
  const argv = process.argv.slice(2);
  const flags = new Set(argv.filter((a) => a.startsWith('-')));
  const backendFlag = argv.find((a) => a.startsWith('--backend='))?.split('=')[1];
  const files = resolveScenarios(argv.filter((a) => !a.startsWith('-')));
  const verbose = flags.has('-v');
  const stop = flags.has('--py-only') ? async () => {} : await ensureServer();
  const browser = flags.has('--py-only') ? null : await chromium.launch({ args: ['--mute-audio'] });
  let worst = 0;
  const summary = [];
  try {
    for (const file of files) {
      const scenario = JSON.parse(fs.readFileSync(file, 'utf8'));
      const backend = pickBackend(scenario, backendFlag);
      const name = (scenario.name ?? path.basename(file, '.json')) + (backendFlag ? `@${backend}` : '');
      const dir = path.join(OUT, name);
      fs.mkdirSync(dir, { recursive: true });
      for (const f of ['py.json', 'web.json']) fs.rmSync(path.join(dir, f), { force: true });
      const pyP = flags.has('--web-only')
        ? Promise.resolve({ engine: 'python', steps: [], error: 'skipped' })
        : runPython(path.resolve(file), path.join(dir, 'py.json'), backend, verbose);
      const webP = flags.has('--py-only')
        ? Promise.resolve({ engine: 'web', steps: [], error: 'skipped' })
        : runWebScenario(scenario, { browser, verbose }).catch((e) => ({ engine: 'web', steps: [], error: String(e?.stack ?? e) }));
      const [py, web] = await Promise.all([pyP, webP]);
      fs.writeFileSync(path.join(dir, 'web.json'), JSON.stringify(web, null, 1));
      if (!fs.existsSync(path.join(dir, 'py.json'))) fs.writeFileSync(path.join(dir, 'py.json'), JSON.stringify(py, null, 1));
      const report = diffRuns(py, web, scenario);
      console.log(formatReport(`${name} [python:${backend} vs web]`, report, { all: flags.has('--all'), full: flags.has('--full') }));
      const harnessFail = report.errors.length > 0;
      worst = Math.max(worst, report.ok ? 0 : harnessFail ? 2 : 1);
      summary.push(`${report.ok ? 'MATCH' : harnessFail ? 'ERROR' : 'DIFF '}  ${name}`);
    }
  } finally {
    if (browser) await browser.close();
    await stop();
  }
  if (files.length > 1) console.log(`\n${summary.join('\n')}`);
  console.log(`(raw runs in ${OUT})`);
  process.exit(worst);
}

main().catch((err) => { console.error(err); process.exit(2); });
