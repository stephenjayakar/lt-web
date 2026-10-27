#!/usr/bin/env node
/**
 * qa-summary.mjs — aggregate qa-run reports (docs/qa-tools.md).
 *
 *   npm run qa:summary -- [DIR] [--since YYYYMMDD-HHMMSS] [--all]
 *
 * Reads every DIR/<run>/report.json (default E:/BigData/lt-web-playtest),
 * prints one line per run (result, floors, time) and the warnings/errors
 * deduplicated across runs with the number of runs that hit each one and its
 * first context. Python-equivalent evaluation warnings are left out unless
 * --all is given.
 */

import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const dir = argv.find((a, i) => !a.startsWith('--') && argv[i - 1] !== '--since') ?? 'E:/BigData/lt-web-playtest';
const since = opt('--since');
const all = flag('--all');

const runs = [];
for (const name of fs.readdirSync(dir).sort()) {
  if (since && name < since) continue;
  const file = path.join(dir, name, 'report.json');
  if (!fs.existsSync(file)) continue;
  try {
    runs.push({ name, data: JSON.parse(fs.readFileSync(file, 'utf8')) });
  } catch {
    // A run that is still writing its report.
  }
}

const fmt = (ms) => `${Math.round((ms ?? 0) / 100) / 10}s`;
const results = {};
console.log(`${runs.length} run(s) in ${dir}${since ? ` since ${since}` : ''}\n`);
for (const { name, data } of runs) {
  const status = data.report?.status ?? {};
  const result = data.failure ? 'failed' : status.result ?? 'unknown';
  results[result] = (results[result] ?? 0) + 1;
  const floors = (data.report?.floors ?? []).map((f) => f.floor).filter((f) => f !== null);
  const span = floors.length ? `floors ${floors[0]}-${floors[floors.length - 1]}` : 'no floors';
  console.log(`${result.padEnd(8)} ${name}  ${span}  play ${fmt(data.timings?.playMs)}  ${status.reason ?? data.failure?.split('\n')[0] ?? ''}`);
}
console.log(`\n${Object.entries(results).map(([k, v]) => `${k}: ${v}`).join(', ')}\n`);

const agg = new Map();
for (const { name, data } of runs) {
  for (const e of data.report?.log ?? []) {
    if (!all && e.kind === 'warn' && e.message.includes('(Python-equivalent)')) continue;
    if (e.kind === 'qa') continue;
    const key = `${e.kind} ${e.message.split(/\r?\n/)[0].slice(0, 240)}`;
    const entry = agg.get(key) ?? { runs: new Set(), count: 0, first: e.first, run: name };
    entry.runs.add(name);
    entry.count += e.count;
    agg.set(key, entry);
  }
  for (const err of data.pageErrors ?? []) {
    const key = `pageerror ${String(err).split(/\r?\n/)[0].slice(0, 240)}`;
    const entry = agg.get(key) ?? { runs: new Set(), count: 0, first: null, run: name };
    entry.runs.add(name);
    entry.count += 1;
    agg.set(key, entry);
  }
}
const sorted = [...agg.entries()].sort((a, b) => (a[0].startsWith('warn') - b[0].startsWith('warn')) || b[1].runs.size - a[1].runs.size);
console.log(`${sorted.length} distinct warning/error message(s)${all ? '' : ' (Python-equivalent ones hidden; --all shows them)'}:`);
for (const [key, e] of sorted) {
  const c = e.first;
  const where = c ? `floor ${c.floor} level ${c.level} T${c.turn} ${c.stack}${c.event ? ` event ${c.event}` : ''}` : '';
  console.log(`- [${e.runs.size} run(s), x${e.count}] ${key}\n    first: ${e.run} ${where}`);
}
