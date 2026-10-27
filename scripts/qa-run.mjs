#!/usr/bin/env node
/**
 * qa-run.mjs — jump into Embrace of the Fog and auto-play it fast in a
 * headless (muted) Chromium, then write a report. See docs/qa-tools.md.
 *
 *   npm run qa:run -- --act 2 --floor 16 --floors 5 --party Player,Gorbat,Pilus,Viran,Taag --promoted
 *   npm run qa:run -- --floor 1 --floors 5
 *   npm run qa:run -- --act 1 --level Bootes --one-level --party-level 15
 *   npm run qa:run -- --floor 1 --floors 3 --parallel 3      (3 seeds, one server)
 *
 * Uses the Vite dev server (QA tools are compiled into dev builds only). An
 * existing server on --port is reused; otherwise one is started and stopped
 * again (by PID) at the end. Reports go to E:/BigData/lt-web-playtest by
 * default (--out).
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);

function usage() {
  console.log(`Usage: npm run qa:run -- [options]

Where to start (jump):
  --act N              Act 1-4 (default: from --floor, else 1)
  --floor N            absolute floor (default: first floor of the Act)
  --alter              alternate Act variant (Act_NA)
  --level NID          enter this battle level from the Act map (e.g. 16, Adrius, Bootes)
  --reward NAME        next_reward for --level
  --party LIST         units, comma separated: Nid[:level][:P][:Class][:+Item+Item]
                       (P = promote). Default Player,Gorbat,Pilus,Viran
  --party-level N      level for units without one (default 1 + 0.8 * floor)
  --promoted / --no-promote   promote the party (default: Act 2+)
  --money N  --game-speed 1|2  --density N  --seed N (game RNG)
  --records k=v,k=v    persistent records (values parsed as JSON when possible)
  --vars k=v,k=v       game vars
  --tutorials          keep EOtF tutorial popups
  --boost N            QA stat boost: +N to every stat (+2N HP) for the party

What to play:
  --floors N           play N floors (default 1); --to-floor N; --one-level
  --no-play            only jump, then report
  --max-turns N        per battle map (default 40); --force-win at the limit
  --rooms LIST         random (default) or preference: combat,event,shop,respite,elite
  --choices random|first   unknown event choices (default random)
  --services all|none|a,b  sub-room NPCs to visit (default all)
  --shop buy|leave     in shop screens buy one random item (default) or leave
  --policy-seed N      seed for the policy's own RNG (default = --seed or 1)
  --no-autoplay        do not play the player phase (inspect only)

Speed:
  --fast N             frames per real frame; 0 = unlimited (default 0); 1 = normal
  --draw-every N       render every Nth frame only (default 16; 1 = every frame)
  --map-combat         map combat instead of battle animations (presentation only)
  --no-skip            do not skip event dialogue/cutscenes
  --verbose            keep engine console.log output

Infrastructure:
  --port N             dev server port (default $PLAYWRIGHT_PORT or 5191)
  --url URL            use this server instead (no server is started)
  --parallel N         run N browsers at once (seeds seed..seed+N-1)
  --timeout SEC        real-time budget per run (default 1800)
  --out DIR            report root (default E:/BigData/lt-web-playtest)
  --label NAME         report folder label
  --headed             show the browser
  --shots              screenshot at every floor change
`);
}

function parseArgs(list) {
  const out = {};
  for (let i = 0; i < list.length; i += 1) {
    const raw = list[i];
    if (!raw.startsWith('--')) continue;
    const eq = raw.indexOf('=');
    const key = (eq > 0 ? raw.slice(2, eq) : raw.slice(2)).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (eq > 0) out[key] = raw.slice(eq + 1);
    else if (list[i + 1] !== undefined && !list[i + 1].startsWith('--')) out[key] = list[++i];
    else out[key] = true;
  }
  return out;
}

const args = parseArgs(argv);
if (args.help || args.h) {
  usage();
  process.exit(0);
}

const num = (value, fallback) => (value === undefined || value === true ? fallback : Number(value));
const parseValue = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};
const parseMap = (text) => {
  if (!text || text === true) return undefined;
  const map = {};
  for (const part of String(text).split(',')) {
    const eq = part.indexOf('=');
    if (eq > 0) map[part.slice(0, eq).trim()] = parseValue(part.slice(eq + 1).trim());
  }
  return map;
};
const parseParty = (text) => {
  if (!text || text === true) return undefined;
  return String(text).split(',').filter(Boolean).map((token) => {
    const [nid, ...rest] = token.trim().split(':');
    const unit = { nid };
    for (const part of rest) {
      if (/^\d+$/.test(part)) {
        if (unit.promote || unit.klass) unit.promotedLevel = Number(part);
        else unit.level = Number(part);
      } else if (part === 'P' || part === 'promote') unit.promote = true;
      else if (part.startsWith('+')) unit.items = part.slice(1).split('+').filter(Boolean);
      else if (part) unit.klass = part;
    }
    return unit;
  });
};

const port = num(args.port, Number(process.env.PLAYWRIGHT_PORT ?? 5191));
const baseUrl = typeof args.url === 'string' ? args.url.replace(/\/$/, '') : `http://127.0.0.1:${port}`;
const outRoot = typeof args.out === 'string' ? args.out : 'E:/BigData/lt-web-playtest';
const parallel = Math.max(1, num(args.parallel, 1));
const seed = args.seed !== undefined ? num(args.seed, 1) : undefined;
const timeoutMs = num(args.timeout, 1800) * 1000;

const jumpSpec = {
  act: args.act !== undefined ? num(args.act) : undefined,
  floor: args.floor !== undefined ? num(args.floor) : undefined,
  alter: args.alter ? true : undefined,
  level: typeof args.level === 'string' ? args.level : undefined,
  reward: typeof args.reward === 'string' ? args.reward : undefined,
  party: parseParty(args.party),
  partyLevel: args.partyLevel !== undefined ? num(args.partyLevel) : undefined,
  promoted: args.promoted ? true : args.noPromote ? false : undefined,
  money: args.money !== undefined ? num(args.money) : undefined,
  gameSpeed: args.gameSpeed !== undefined ? num(args.gameSpeed) : undefined,
  density: args.density !== undefined ? num(args.density) : undefined,
  records: parseMap(args.records),
  gameVars: parseMap(args.vars),
  tutorials: !!args.tutorials,
  boost: args.boost !== undefined ? num(args.boost) : undefined,
};

const listOrMode = (value, modes) => {
  if (value === undefined || value === true) return undefined;
  const text = String(value);
  if (modes.includes(text)) return text;
  return text.split(',').map((s) => s.trim()).filter(Boolean);
};

const playOptions = {
  floors: args.toFloor !== undefined || args.oneLevel ? undefined : num(args.floors, 1),
  toFloor: args.toFloor !== undefined ? num(args.toFloor) : undefined,
  oneLevel: !!args.oneLevel,
  maxTurns: num(args.maxTurns, 40),
  forceWin: !!args.forceWin,
  maxRealMs: timeoutMs,
  autoplay: !args.noAutoplay,
  policy: {
    rooms: listOrMode(args.rooms, ['random']) ?? 'random',
    choices: args.choices === 'first' ? 'first' : 'random',
    services: listOrMode(args.services, ['all', 'none']) ?? 'all',
    shop: args.shop === 'leave' ? 'leave' : 'buy',
  },
};
const fast = {
  speed: num(args.fast, 0),
  skipEvents: !args.noSkip,
  combat: args.mapCombat ? 'map' : 'animation',
  quietLog: !args.verbose,
  drawEvery: num(args.drawEvery, 16),
};

// ---------------------------------------------------------------------------
// Dev server
// ---------------------------------------------------------------------------

async function serverUp(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function ensureServer() {
  if (await serverUp(baseUrl)) return null;
  if (typeof args.url === 'string') throw new Error(`no server at ${baseUrl}`);
  const vite = path.join(root, 'node_modules', 'vite', 'bin', 'vite.js');
  const child = spawn(process.execPath, [vite, '--port', String(port), '--strictPort', '--host', '127.0.0.1'], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env },
  });
  let output = '';
  child.stdout.on('data', (d) => { output += d; });
  child.stderr.on('data', (d) => { output += d; });
  const t0 = Date.now();
  while (Date.now() - t0 < 60_000) {
    if (child.exitCode !== null) throw new Error(`vite exited: ${output}`);
    if (await serverUp(baseUrl)) {
      console.log(`[qa-run] started vite on ${baseUrl} (pid ${child.pid})`);
      return child;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  child.kill();
  throw new Error(`vite did not start on ${baseUrl}: ${output}`);
}

// ---------------------------------------------------------------------------
// One run
// ---------------------------------------------------------------------------

const stamp = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

const fmtMs = (ms) => {
  const s = Math.round(ms / 100) / 10;
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m${String(Math.round(s % 60)).padStart(2, '0')}s`;
};

async function screenshot(page, file) {
  try {
    const data = await page.evaluate(() => document.querySelector('canvas')?.toDataURL('image/png') ?? null);
    if (data) fs.writeFileSync(file, Buffer.from(data.split(',')[1], 'base64'));
  } catch {
    // The page may have crashed; the report says so.
  }
}

async function runOne(browser, index) {
  const runSeed = seed !== undefined ? seed + index : undefined;
  const label = typeof args.label === 'string' ? args.label
    : `${jumpSpec.level ? `L${jumpSpec.level}` : ''}a${jumpSpec.act ?? ''}f${jumpSpec.floor ?? ''}`;
  const dir = path.join(outRoot, `${stamp()}-${label}-p${port}${parallel > 1 ? `-r${index}` : ''}`);
  fs.mkdirSync(dir, { recursive: true });
  const tag = parallel > 1 ? `[run ${index}]` : '[qa-run]';
  const context = await browser.newContext({ viewport: { width: 480, height: 320 } });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(String(err.stack || err)));
  page.on('crash', () => pageErrors.push('PAGE CRASHED'));
  const t0 = Date.now();
  const timings = {};
  let jump = null;
  let status = null;
  let report = null;
  let failure = null;
  try {
    const query = `?qa&project=eotf.ltproj&bundle=false${runSeed !== undefined ? `&seed=${runSeed}` : ''}`;
    await page.goto(`${baseUrl}/${query}`);
    await page.waitForFunction(() => window.__qa?.ready === true, undefined, { timeout: 120_000 });
    timings.bootMs = Date.now() - t0;
    console.log(`${tag} booted in ${fmtMs(timings.bootMs)}`);
    await page.evaluate((f) => window.__qa.setFast(f), fast);
    const t1 = Date.now();
    jump = await page.evaluate((spec) => window.__qa.jump(spec), { ...jumpSpec, seed: runSeed });
    timings.jumpMs = Date.now() - t1;
    console.log(`${tag} jumped to ${jump.level} floor ${jump.floor} (${jump.state}) in ${fmtMs(timings.jumpMs)}: ${jump.party.map((u) => `${u.nid} ${u.klass} L${u.level}`).join(', ')}`);
    await screenshot(page, path.join(dir, 'jump.png'));
    if (!args.noPlay) {
      const t2 = Date.now();
      const policySeed = num(args.policySeed, runSeed ?? 1);
      await page.evaluate((opts) => window.__qa.play(opts), { ...playOptions, policy: { ...playOptions.policy, seed: policySeed } });
      let lastFloor = null;
      let lastPrint = 0;
      for (;;) {
        await new Promise((r) => setTimeout(r, 500));
        status = await page.evaluate(() => window.__qa.status());
        if (status.floor !== lastFloor) {
          if (args.shots) await screenshot(page, path.join(dir, `floor-${status.floor}.png`));
          lastFloor = status.floor;
        }
        if (Date.now() - lastPrint > 5000) {
          lastPrint = Date.now();
          console.log(`${tag} ${fmtMs(Date.now() - t2)} floor ${status.floor} ${status.level} T${status.turn} ${status.state} ${status.fps} fps, ${status.warnings} warn ${status.errors} err`);
        }
        if (status.phase === 'done') break;
        if (Date.now() - t2 > timeoutMs + 30_000) {
          status = await page.evaluate(() => window.__qa.stop('runner timeout'));
          break;
        }
      }
      timings.playMs = Date.now() - t2;
    }
    report = await page.evaluate(() => window.__qa.report());
  } catch (err) {
    failure = String(err && err.stack || err);
    console.log(`${tag} FAILED: ${failure.split('\n')[0]}`);
    try {
      report = await page.evaluate(() => window.__qa?.report());
    } catch {
      report = null;
    }
  }
  await screenshot(page, path.join(dir, 'final.png'));
  await context.close();
  timings.totalMs = Date.now() - t0;
  const summary = { label, seed: runSeed, url: baseUrl, jumpSpec, playOptions, fast, timings, failure, pageErrors, report };
  fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify(summary, null, 2));
  fs.writeFileSync(path.join(dir, 'report.md'), renderMarkdown(summary));
  const result = failure ? 'failed' : args.noPlay ? 'ok' : (report?.status?.result ?? 'unknown');
  console.log(`${tag} ${result}: ${report?.status?.reason ?? failure?.split('\n')[0] ?? ''} — boot ${fmtMs(timings.bootMs ?? 0)}, jump ${fmtMs(timings.jumpMs ?? 0)}, play ${fmtMs(timings.playMs ?? 0)}`);
  console.log(`${tag} report: ${path.join(dir, 'report.md')}`);
  return { dir, result, failure };
}

function renderMarkdown(summary) {
  const { report, timings, failure } = summary;
  const lines = [];
  lines.push(`# QA run ${summary.label}`);
  lines.push('');
  lines.push(`- server ${summary.url}, seed ${summary.seed ?? 'random'}, fast ${JSON.stringify(summary.fast)}`);
  lines.push(`- boot ${fmtMs(timings.bootMs ?? 0)}, jump ${fmtMs(timings.jumpMs ?? 0)}, play ${fmtMs(timings.playMs ?? 0)}, total ${fmtMs(timings.totalMs ?? 0)}`);
  if (failure) lines.push(`- FAILURE: ${failure.split('\n')[0]}`);
  if (report?.jump) {
    const j = report.jump;
    lines.push(`- jump: ${j.level} floor ${j.floor} (${j.state}); party ${j.party.map((u) => `${u.nid} ${u.klass} L${u.level} ${u.hp}HP`).join(', ')}`);
  }
  if (report?.status) {
    const s = report.status;
    lines.push(`- result: **${s.result ?? s.phase}** (${s.reason ?? ''}); ${s.frames} frames, ${s.warnings} warnings, ${s.errors} errors`);
  }
  if (report?.party?.length) {
    lines.push(`- party at end: ${report.party.map((u) => `${u.nid} ${u.klass} L${u.level} ${u.hp}/${u.maxHp}${u.dead ? ' DEAD' : ''}`).join(', ')}`);
  }
  lines.push('');
  if (report?.floors?.length) {
    lines.push('| Floor | Act | Offered | Chosen | Levels | Events | W/E | Time |');
    lines.push('|---|---|---|---|---|---|---|---|');
    for (const f of report.floors) {
      const levels = f.levels.filter((l) => l.kind === 'battle').map((l) =>
        `${l.nid} "${l.objective || l.name}" ${l.result || '?'} T${l.turns} c${l.combats}${l.playerDeaths.length ? ` died:${l.playerDeaths.join('/')}` : ''} k${l.enemyDeaths}`);
      const events = Object.keys(f.events).filter((n) => !/^(Global|Ability|Item|Death|Skill)/.test(n) && !/^QA_/.test(n));
      lines.push(`| ${f.floor} | ${f.act ?? ''} | ${f.roomsOffered.join(', ')} | ${f.chosen.join(', ')} | ${levels.join('; ')} | ${events.slice(0, 8).join(', ')}${events.length > 8 ? ` +${events.length - 8}` : ''} | ${f.warnings}/${f.errors} | ${fmtMs(f.realMs)} |`);
    }
    lines.push('');
    lines.push('## Floor notes');
    for (const f of report.floors) {
      if (f.notes.length) lines.push(`- floor ${f.floor}: ${f.notes.join('; ')}`);
    }
    lines.push('');
  }
  const log = report?.log ?? [];
  if (log.length || summary.pageErrors.length) {
    lines.push('## Warnings and errors');
    for (const e of summary.pageErrors) lines.push(`- [pageerror] ${e.split('\n')[0]}`);
    const order = { error: 0, pageerror: 0, rejection: 0, qa: 1, warn: 2 };
    // Python logs these too (the port marks them): listed last, apart.
    const pythonEquivalent = (e) => e.kind === 'warn' && e.message.includes('(Python-equivalent)');
    const line = (e) => {
      const c = e.first;
      return `- [${e.kind} x${e.count}] ${e.message.split(/\r?\n/)[0].slice(0, 300)} — floor ${c.floor} level ${c.level} T${c.turn} ${c.phase} ${c.stack}${c.event ? ` event ${c.event}` : ''}`;
    };
    const sorted = [...log].sort((a, b) => (order[a.kind] - order[b.kind]) || (b.count - a.count));
    for (const e of sorted.filter((x) => !pythonEquivalent(x))) lines.push(line(e));
    const expected = sorted.filter(pythonEquivalent);
    if (expected.length) {
      lines.push('');
      lines.push(`### Python-equivalent evaluation warnings (${expected.length}; Python logs these too)`);
      for (const e of expected) lines.push(line(e));
    }
  }
  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const server = await ensureServer();
const browser = await chromium.launch({
  headless: !args.headed,
  args: ['--mute-audio', '--autoplay-policy=user-gesture-required'],
});
let exitCode = 0;
try {
  const results = await Promise.all(Array.from({ length: parallel }, (_, i) => runOne(browser, i)));
  if (results.some((r) => r.failure || r.result !== 'ok')) exitCode = 1;
  if (parallel > 1) {
    console.log('[qa-run] summary:');
    for (const r of results) console.log(`  ${r.result}  ${r.dir}`);
  }
} finally {
  await browser.close();
  if (server) {
    server.kill();
    console.log(`[qa-run] stopped vite (pid ${server.pid})`);
  }
}
process.exit(exitCode);
