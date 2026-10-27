#!/usr/bin/env node
/**
 * Oracle web driver: replay a scenario JSON through the web engine in a
 * headless, muted Chromium and print the canonical snapshot JSON (same schema
 * as tools/oracle/py_driver.py).
 *
 *   node tools/oracle/web-driver.mjs <scenario.json> [-o out.json]
 *
 * Uses the Vite dev server on ORACLE_PORT (default PLAYWRIGHT_PORT or 5190);
 * an already running server on that port is reused, otherwise one is started
 * for the run and stopped by PID afterwards.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = Number(process.env.ORACLE_PORT ?? process.env.PLAYWRIGHT_PORT ?? 5190);
const BASE = `http://localhost:${PORT}`;

async function reachable() {
  try {
    const res = await fetch(BASE + '/', { signal: AbortSignal.timeout(15000) });
    return res.ok;
  } catch {
    return false;
  }
}

/** Start Vite unless something already serves the port. Returns a stopper. */
export async function ensureServer() {
  if (await reachable()) return async () => {};
  const vite = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
  const child = spawn(process.execPath, [vite, '--port', String(PORT), '--strictPort'], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  const deadline = Date.now() + 60_000;
  while (!(await reachable())) {
    if (child.exitCode !== null || Date.now() > deadline) {
      throw new Error(`vite did not start on ${PORT}:\n${log}`);
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return async () => {
    if (child.exitCode === null) {
      // Stop exactly the server we started (and its children) by PID.
      if (process.platform === 'win32') {
        spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      } else {
        child.kill('SIGTERM');
      }
    }
  };
}

const HOME = process.env.LT_ORACLE_HOME ?? 'E:/BigData/lt-oracle';

/**
 * A scenario's run state as an object: inline, or a path that is absolute,
 * relative to the scenario file (`base`), or relative to $LT_ORACLE_HOME.
 */
export function loadRunState(scenario, base) {
  const rs = scenario.run_state;
  if (rs === undefined || rs === null || typeof rs === 'object') return rs;
  for (const cand of [rs, base ? path.join(base, rs) : null, path.join(HOME, rs)]) {
    if (cand && fs.existsSync(cand)) return JSON.parse(fs.readFileSync(cand, 'utf8'));
  }
  throw new Error(`run state not found: ${rs}`);
}

export async function runWebScenario(scenario, { browser, verbose = false, base = null } = {}) {
  scenario = { ...scenario, run_state: loadRunState(scenario, base) };
  const ownBrowser = !browser;
  browser ??= await chromium.launch({ args: ['--mute-audio'] });
  const page = await browser.newPage({ viewport: { width: 480, height: 320 } });
  const consoleErrors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
    if (verbose) process.stderr.write(`[page] ${msg.text()}\n`);
  });
  page.on('pageerror', (err) => consoleErrors.push(String(err)));
  try {
    const project = scenario.project ?? 'default.ltproj';
    const q = new URLSearchParams({
      harness: 'true', project, level: String(scenario.level ?? scenario.levels?.[0]), clean: 'true', bundle: 'false',
      seed: String(scenario.seed ?? 0),
    });
    // A cold Vite server transforms the whole engine on first load.
    await page.goto(`${BASE}/?${q}`, { timeout: 180_000, waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!window.__harness?.ready, null, { timeout: 120_000 });
    const result = await page.evaluate(async (scn) => {
      const mod = await import('/tools/oracle/web/page-driver.ts');
      return mod.runScenario(scn);
    }, scenario);
    if (result.error && consoleErrors.length) result.console_errors = consoleErrors.slice(-20);
    return result;
  } finally {
    await page.close();
    if (ownBrowser) await browser.close();
  }
}

async function main() {
  const args = process.argv.slice(2);
  const outIdx = args.findIndex((a) => a === '-o' || a === '--out');
  const out = outIdx >= 0 ? args[outIdx + 1] : null;
  const verbose = args.includes('-v');
  const file = args.find((a, i) => !a.startsWith('-') && (outIdx < 0 || i !== outIdx + 1));
  if (!file) {
    console.error('usage: node tools/oracle/web-driver.mjs <scenario.json> [-o out.json] [-v]');
    process.exit(2);
  }
  const scenario = JSON.parse(fs.readFileSync(file, 'utf8'));
  const stop = await ensureServer();
  let result;
  try {
    result = await runWebScenario(scenario, { verbose, base: path.dirname(path.resolve(file)) });
  } finally {
    await stop();
  }
  const text = JSON.stringify(result, null, 1);
  if (out) {
    fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    fs.writeFileSync(out, text);
  } else {
    process.stdout.write(text + '\n');
  }
  process.exit(result.error ? 1 : 0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => { console.error(err); process.exit(2); });
}
