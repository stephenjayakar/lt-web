#!/usr/bin/env node
/**
 * perf-frames.mjs — frame-time profile of real-speed EOtF play.
 *
 *   npm run perf:frames -- [--level Loreia] [--seconds 10] [--dist DIR] [--profile]
 *
 * Jumps to a battle level with the QA tools (docs/qa-tools.md), then plays at
 * normal speed (one update+draw per 1/60 s, every frame drawn) and records
 * the work time of every frame:
 *
 * 1. player phase, idle: the cursor rests on a unit and moves to the next
 *    every 30 frames (unit window, HP bars) for --seconds;
 * 2. one full turn: the player phase auto-played by the QA AI, then the
 *    enemy AI phase, until the next player phase (or --turn-seconds).
 *
 * Per-frame times are grouped by phase and top state (avg, p50, p95, p99,
 * max, frames over 16.7 ms). --profile also records a CPU profile of each
 * part and prints the top self/inclusive functions.
 *
 * --dist serves a built dist (`LT_QA=1 vite build --outDir DIR`: production
 * code plus the QA chunk) with /game-data mapped to lt-maker/, like the dev
 * server; otherwise the dev server on --port is used (started if needed).
 * Results go to E:/BigData/lt-web-playtest/perf/<label>.json.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};
const flag = (name) => argv.includes(`--${name}`);

const level = opt('level', 'Loreia');
const seconds = Number(opt('seconds', 10));
const turnSeconds = Number(opt('turn-seconds', 90));
const seed = Number(opt('seed', 5));
const boost = Number(opt('boost', 10));
const port = Number(opt('port', process.env.PLAYWRIGHT_PORT ?? 5191));
const dist = opt('dist', null);
const label = opt('label', `${level}-${dist ? 'dist' : 'dev'}`);
const outDir = opt('out', 'E:/BigData/lt-web-playtest/perf');
const party = opt('party', 'Player,Gorbat,Pilus,Viran,Taag').split(',');

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.png': 'image/png', '.ogg': 'audio/ogg', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.svg': 'image/svg+xml',
};

function serveDist(dir) {
  const ltMaker = path.join(root, 'lt-maker');
  const forkSprites = path.join(root, 'public', 'fork-sprites');
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent((req.url ?? '/').split('?')[0]);
    let file;
    if (url.startsWith('/game-data/fork-sprites/')) file = path.join(forkSprites, url.slice('/game-data/fork-sprites/'.length));
    else if (url.startsWith('/game-data/')) file = path.join(ltMaker, url.slice('/game-data/'.length));
    else file = path.join(dir, url === '/' ? 'index.html' : url);
    fs.stat(file, (err, stat) => {
      if (err || !stat.isFile()) {
        res.statusCode = 404;
        res.end();
        return;
      }
      res.setHeader('Content-Type', MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream');
      fs.createReadStream(file).pipe(res);
    });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

async function up(url) {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(2000) })).ok;
  } catch {
    return false;
  }
}

async function devServer() {
  const url = `http://127.0.0.1:${port}`;
  if (await up(url)) return null;
  const child = spawn(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'), '--port', String(port), '--strictPort', '--host', '127.0.0.1'], { cwd: root, stdio: 'ignore' });
  for (let i = 0; i < 200 && !(await up(url)); i += 1) await new Promise((r) => setTimeout(r, 300));
  return child;
}

function summarise(profile, top = 25) {
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const parent = new Map();
  for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
  const time = new Map();
  profile.samples.forEach((id, i) => time.set(id, (time.get(id) ?? 0) + (profile.timeDeltas[i] ?? 0)));
  const key = (n) => `${n.callFrame.functionName || '(anon)'} ${n.callFrame.url.split('/').pop().split('?')[0]}:${n.callFrame.lineNumber + 1}`;
  const self = new Map();
  const incl = new Map();
  let total = 0;
  for (const [id, t] of time) {
    total += t;
    self.set(key(byId.get(id)), (self.get(key(byId.get(id))) ?? 0) + t);
    const seen = new Set();
    for (let cur = id; cur !== undefined; cur = parent.get(cur)) {
      const k = key(byId.get(cur));
      if (seen.has(k)) continue;
      seen.add(k);
      incl.set(k, (incl.get(k) ?? 0) + t);
    }
  }
  const fmt = (m) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, top)
    .map(([k, t]) => `${(100 * t / total).toFixed(1).padStart(5)}% ${k}`);
  return { self: fmt(self), inclusive: fmt(incl) };
}

const server = dist ? await serveDist(path.resolve(dist)) : await devServer();
const browser = await chromium.launch({ headless: !flag('headed'), args: ['--mute-audio'] });
const context = await browser.newContext({ viewport: { width: 960, height: 640 } });
const page = await context.newPage();
const cdp = flag('profile') ? await context.newCDPSession(page) : null;
const result = { label, level, seed, dist: !!dist, seconds };
const fmt = (s) => s ? `${s.frames} frames  avg ${s.avg.toFixed(2)}  p50 ${s.p50.toFixed(2)}  p95 ${s.p95.toFixed(2)}  p99 ${s.p99.toFixed(2)}  max ${s.max.toFixed(1)} ms  >16.7ms: ${s.over16}` : '-';
try {
  await page.goto(`http://127.0.0.1:${port}/?qa&project=eotf.ltproj&bundle=false&seed=${seed}`, { timeout: 180_000 });
  await page.waitForFunction(() => window.__qa?.ready === true, undefined, { timeout: 120_000 });
  await page.evaluate(() => window.__qa.setFast({ speed: 0, skipEvents: true, drawEvery: 16, quietLog: true }));
  const jump = await page.evaluate((spec) => window.__qa.jump(spec), { level, party, boost, seed });
  result.jump = { level: jump.level, floor: jump.floor, state: jump.state };
  // Through preparations and the intro to the first idle player phase.
  await page.evaluate(() => window.__qa.play({ oneLevel: true, autoplay: false, hover: true, policy: { seed: 5 } }));
  await page.waitForFunction(() => {
    const qa = window.__qa;
    const g = qa.game;
    return g.state.getCurrentState()?.name === 'free' && g.phase?.getCurrent?.() === 'player' && !g.eventManager?.hasActiveEvents();
  }, undefined, { timeout: 120_000 });
  result.units = await page.evaluate(() => [...window.__qa.game.units.values()].filter((u) => u.position && !u.isDead()).length);
  await page.evaluate(() => window.__qa.setFast({ speed: 1, skipEvents: true, drawEvery: 1, quietLog: true }));
  await new Promise((r) => setTimeout(r, 1000));

  // 1. Idle player phase.
  if (cdp) { await cdp.send('Profiler.enable'); await cdp.send('Profiler.setSamplingInterval', { interval: 250 }); await cdp.send('Profiler.start'); }
  await page.evaluate(() => window.__qa.perfStart());
  await new Promise((r) => setTimeout(r, seconds * 1000));
  result.idle = await page.evaluate(() => window.__qa.perfStop());
  if (cdp) result.idleProfile = summarise((await cdp.send('Profiler.stop')).profile);

  // 2. One full turn: auto-played player phase, then the enemy phase.
  const turn0 = await page.evaluate(() => window.__qa.game.turnCount);
  await page.evaluate(() => window.__qa.play({ oneLevel: true, autoplay: true, policy: { seed: 5 } }));
  if (cdp) await cdp.send('Profiler.start');
  await page.evaluate(() => window.__qa.perfStart());
  const t0 = Date.now();
  while (Date.now() - t0 < turnSeconds * 1000) {
    await new Promise((r) => setTimeout(r, 500));
    const s = await page.evaluate(() => ({ turn: window.__qa.game.turnCount, phase: window.__qa.game.phase?.getCurrent?.(), done: window.__qa.status().phase === 'done' }));
    if (s.done || (s.turn > turn0 && s.phase === 'player')) break;
  }
  result.turn = await page.evaluate(() => window.__qa.perfStop());
  result.turnRealMs = Date.now() - t0;
  if (cdp) result.turnProfile = summarise((await cdp.send('Profiler.stop')).profile);
} finally {
  await browser.close();
  if (server && 'close' in server) server.close();
  else if (server) server.kill();
}

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, `${label}.json`), JSON.stringify(result, null, 2));
console.log(`${label}: ${result.jump?.level} floor ${result.jump?.floor}, ${result.units} units on the map`);
console.log(`  idle player phase  ${fmt(result.idle?.all)}`);
console.log(`  turn (all)         ${fmt(result.turn?.all)}  (${Math.round(result.turnRealMs / 1000)} s)`);
for (const key of ['phase:player', 'phase:enemy', 'state:ai', 'state:combat', 'state:free', 'state:movement']) {
  if (result.turn?.[key]) console.log(`  ${key.padEnd(18)} ${fmt(result.turn[key])}`);
}
if (result.idleProfile) {
  console.log('  idle: top inclusive\n    ' + result.idleProfile.inclusive.slice(0, 20).join('\n    '));
  console.log('  turn: top inclusive\n    ' + result.turnProfile.inclusive.slice(0, 20).join('\n    '));
}
