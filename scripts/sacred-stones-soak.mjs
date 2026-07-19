#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, rmSync, cpSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const seedFilePath = path.join(repoRoot, 'public', 'soak-seed.json');
const testResultsDir = path.join(repoRoot, 'test-results');
const artifactsRoot = path.join(repoRoot, 'soak-artifacts');

const iterationsRaw = process.env.SOAK_ITERATIONS ?? '5';
const iterations = Number.parseInt(iterationsRaw, 10);
if (!Number.isFinite(iterations) || iterations <= 0) {
  console.error(`[soak] Invalid SOAK_ITERATIONS value: ${iterationsRaw}`);
  process.exit(1);
}

const grepPattern =
  process.env.SOAK_GREP ??
  'Sacred Stones Later Chapters|Sacred Stones Chapter Mechanics|Level Progression';
const workers = process.env.SOAK_WORKERS ?? '1';

// Optional deterministic seed sweep: SOAK_SEED_BASE=100 sweeps seeds
// 100, 101, 102, ... across iterations (each iteration gets a distinct,
// but fully reproducible, combat/growth RNG seed). Threaded to the page
// via public/soak-seed.json, read by src/main.ts's harness bootstrap (a
// `/soak-seed.json` fetch, checked whenever no explicit `?seed=` is on the
// URL) -- this lets unmodified spec files (whose page.goto() calls don't
// carry a seed param) still pick up a distinct seed per iteration without
// editing every spec. Leave SOAK_SEED_BASE unset to run with the engine's
// normal default seed (0) every iteration, matching prior soak behavior.
const seedBaseRaw = process.env.SOAK_SEED_BASE;
const seedBase = seedBaseRaw !== undefined ? Number.parseInt(seedBaseRaw, 10) : null;
if (seedBaseRaw !== undefined && !Number.isFinite(seedBase)) {
  console.error(`[soak] Invalid SOAK_SEED_BASE value: ${seedBaseRaw}`);
  process.exit(1);
}

function writeSeedFile(seed) {
  mkdirSync(path.dirname(seedFilePath), { recursive: true });
  writeFileSync(seedFilePath, JSON.stringify({ seed }), 'utf8');
}

function clearSeedFile() {
  if (existsSync(seedFilePath)) {
    rmSync(seedFilePath);
  }
}

/** Run `npx playwright test ...`, streaming output live while also buffering it for archiving. */
function runPlaywright() {
  return new Promise((resolve) => {
    const child = spawn(
      'npx',
      ['playwright', 'test', 'tests/harness.spec.ts', '--grep', grepPattern, '--workers', workers],
      { env: process.env },
    );
    let buffer = '';
    child.stdout.on('data', (chunk) => {
      process.stdout.write(chunk);
      buffer += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      process.stderr.write(chunk);
      buffer += chunk.toString();
    });
    child.on('close', (code) => resolve({ status: code, output: buffer }));
  });
}

/** Archive the first-failure state: playwright output, test-results/, and a repro line. */
function archiveFailure({ iteration, seed, playwrightOutput }) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(artifactsRoot, timestamp);
  mkdirSync(dir, { recursive: true });

  writeFileSync(path.join(dir, 'playwright-output.log'), playwrightOutput, 'utf8');

  if (existsSync(testResultsDir)) {
    cpSync(testResultsDir, path.join(dir, 'test-results'), { recursive: true });
  }
  if (seed !== null) {
    writeFileSync(path.join(dir, 'soak-seed.json'), JSON.stringify({ seed }), 'utf8');
  }

  const reproCmd =
    seed !== null
      ? `node -e "require('fs').mkdirSync('public',{recursive:true});require('fs').writeFileSync('public/soak-seed.json', JSON.stringify({seed:${seed}}))" && npx playwright test tests/harness.spec.ts --grep ${JSON.stringify(grepPattern)} --workers ${workers}`
      : `npx playwright test tests/harness.spec.ts --grep ${JSON.stringify(grepPattern)} --workers ${workers}`;

  const summary = [
    `Soak first-failure archive`,
    `timestamp: ${timestamp}`,
    `iteration: ${iteration}/${iterations}`,
    `grep: ${grepPattern}`,
    `workers: ${workers}`,
    `seed: ${seed === null ? '(default, unseeded sweep)' : seed}`,
    `SOAK_SEED_BASE: ${seedBaseRaw ?? '(unset)'}`,
    ``,
    `Repro command (re-run just the failing iteration's seed/grep directly, no soak loop):`,
    `  ${reproCmd}`,
    ``,
    `Full env used for this run is in env.json. Playwright's own trace/screenshot`,
    `output (if enabled in playwright.config.ts) is under test-results/.`,
  ].join('\n');
  writeFileSync(path.join(dir, 'SUMMARY.txt'), summary, 'utf8');

  writeFileSync(
    path.join(dir, 'env.json'),
    JSON.stringify(
      {
        iteration,
        iterations,
        grepPattern,
        workers,
        seed,
        SOAK_ITERATIONS: iterationsRaw,
        SOAK_GREP: process.env.SOAK_GREP ?? null,
        SOAK_WORKERS: process.env.SOAK_WORKERS ?? null,
        SOAK_SEED_BASE: seedBaseRaw ?? null,
      },
      null,
      2,
    ),
    'utf8',
  );

  console.error(`[soak] Archived first-failure state to ${dir}`);
  return dir;
}

console.log(`[soak] Starting Sacred Stones reliability soak (${iterations} iterations)`);
console.log(`[soak] grep: ${grepPattern}`);
console.log(`[soak] workers: ${workers}`);
if (seedBase !== null) {
  console.log(
    `[soak] seed sweep: SOAK_SEED_BASE=${seedBase} (seeds ${seedBase}..${seedBase + iterations - 1})`,
  );
} else {
  console.log(`[soak] seed sweep: disabled (default seed 0 every iteration; set SOAK_SEED_BASE to sweep)`);
}

let exitCode = 0;

for (let i = 1; i <= iterations; i++) {
  const seed = seedBase !== null ? seedBase + (i - 1) : null;
  if (seed !== null) {
    writeSeedFile(seed);
  } else {
    clearSeedFile();
  }

  console.log(`\n[soak] Iteration ${i}/${iterations}${seed !== null ? ` (seed=${seed})` : ''}`);

  // Clear stale test-results/ from a prior iteration so the archive (if this
  // iteration fails) only contains this iteration's traces/screenshots.
  if (existsSync(testResultsDir)) {
    rmSync(testResultsDir, { recursive: true, force: true });
  }

  const { status, output } = await runPlaywright();

  if (status !== 0) {
    console.error(`[soak] FAILED at iteration ${i}/${iterations}`);
    archiveFailure({ iteration: i, seed, playwrightOutput: output });
    exitCode = status ?? 1;
    break;
  }
}

clearSeedFile();

if (exitCode === 0) {
  console.log(`\n[soak] PASS: ${iterations}/${iterations} iterations succeeded`);
}

process.exit(exitCode);
