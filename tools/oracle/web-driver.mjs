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

const STARTUP_MS = Number(process.env.ORACLE_VITE_TIMEOUT_MS ?? 300_000);

/** One GET with its own timeout; false on any network error or non-2xx. */
async function ok(url, timeoutMs) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    await res.arrayBuffer();
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Ready means Vite answers the page *and* can transform the engine and the
 * oracle's page driver; a busy machine can take minutes for the first
 * transform, so each probe gets a generous timeout of its own.
 */
async function ready(timeoutMs = 15_000) {
  return await ok(`${BASE}/`, timeoutMs) &&
    await ok(`${BASE}/src/main.ts`, timeoutMs * 4) &&
    await ok(`${BASE}/tools/oracle/web/page-driver.ts`, timeoutMs * 4);
}

/**
 * Reuse whatever already serves ORACLE_PORT (it must serve this worktree:
 * pick a free port per worktree), else start Vite and poll until ready
 * (ORACLE_VITE_TIMEOUT_MS, default 5 minutes). Returns a stopper that kills
 * only a server this call started, by PID.
 */
export async function ensureServer() {
  if (await ok(`${BASE}/`, 5_000)) {
    const deadline = Date.now() + STARTUP_MS;
    while (!(await ready())) {
      if (Date.now() > deadline) throw new Error(`server on ${PORT} answers but never became ready`);
      await new Promise((r) => setTimeout(r, 1000));
    }
    return async () => {};
  }
  const vite = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
  const child = spawn(process.execPath, [vite, '--port', String(PORT), '--strictPort'], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  const stop = async () => {
    if (child.exitCode === null) {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      } else {
        child.kill('SIGTERM');
      }
    }
  };
  const deadline = Date.now() + STARTUP_MS;
  for (let delay = 500; ; delay = Math.min(delay * 2, 5000)) {
    if (child.exitCode !== null) {
      // Lost a race for the port to another server: reuse it if it is ready.
      if (/already in use|EADDRINUSE/i.test(log) && await ready()) return async () => {};
      throw new Error(`vite exited (${child.exitCode}) on ${PORT}:
${log.slice(-2000)}`);
    }
    if (await ready()) return stop;
    if (Date.now() > deadline) {
      await stop();
      throw new Error(`vite not ready on ${PORT} after ${STARTUP_MS} ms:
${log.slice(-2000)}`);
    }
    await new Promise((r) => setTimeout(r, delay));
  }
}

/**
 * Read a scenario; `"include": "<name>"` starts from that scenario (same
 * folder): its fields are inherited, its setup and actions come first.
 * Keep in sync with load_scenario in py_driver.py.
 */
export function loadScenario(file) {
  const scn = JSON.parse(fs.readFileSync(file, 'utf8'));
  const inc = scn.include;
  delete scn.include;
  if (!inc) return scn;
  const base = loadScenario(path.join(path.dirname(file), inc.endsWith('.json') ? inc : `${inc}.json`));
  return {
    ...base, ...scn,
    setup: [...(base.setup ?? []), ...(scn.setup ?? [])],
    actions: [...(base.actions ?? []), ...(scn.actions ?? [])],
  };
}

export async function runWebScenario(scenario, { browser, verbose = false } = {}) {
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
      harness: 'true', project, level: String(scenario.level), clean: 'true', bundle: 'false',
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
  const scenario = loadScenario(file);
  const stop = await ensureServer();
  let result;
  try {
    result = await runWebScenario(scenario, { verbose });
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
