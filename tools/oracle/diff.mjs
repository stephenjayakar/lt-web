/**
 * Field-level comparison of two oracle runs (py_driver.py vs web-driver.mjs).
 *
 *   node tools/oracle/diff.mjs py.json web.json [--all]
 *
 * Paths are dotted (`units.Eirika.items.0.uses`). Fields listed in
 * noncomparable.json (and a scenario's own "ignore" list) are skipped; a
 * scenario's "known_diffs" are reported separately instead of failing.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export function loadNoncomparable() {
  const raw = JSON.parse(fs.readFileSync(path.join(HERE, 'noncomparable.json'), 'utf8'));
  return {
    ignore: Object.keys(raw.ignore ?? {}),
    zeroMissing: Object.keys(raw.zero_equals_missing ?? {}),
    nullEmpty: Object.keys(raw.null_equals_empty ?? {}),
    unordered: Object.keys(raw.unordered ?? {}),
    stateAliases: raw.state_aliases ?? {},
  };
}

/** Glob over dotted paths: `*` = one segment, `**` = any depth suffix. */
function globToRegex(glob) {
  const esc = glob.split('.').map((seg) => {
    if (seg === '**') return '.*';
    return seg.replace(/[|\\{}()[\]^$+?.]/g, '\\$&').replace(/\*/g, '[^.]*');
  }).join('\\.');
  return new RegExp(`^${esc}(\\..*)?$`);
}

function makeMatcher(globs) {
  const res = globs.map(globToRegex);
  return (p) => res.some((re) => re.test(p));
}

function isObj(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function walk(a, b, p, out, eq = () => false) {
  // An object present on one side only is walked field by field, so ignore
  // rules on its sub-paths still apply.
  if ((isObj(a) && b === undefined) || (a === undefined && isObj(b))) {
    if (a === undefined) a = {};
    else b = {};
  }
  if (isObj(a) && isObj(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of [...keys].sort()) {
      walk(k in a ? a[k] : undefined, k in b ? b[k] : undefined, p ? `${p}.${k}` : k, out, eq);
    }
    return;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    const n = Math.max(a.length, b.length);
    for (let i = 0; i < n; i++) walk(a[i], b[i], `${p}.${i}`, out, eq);
    return;
  }
  const same = JSON.stringify(a ?? null) === JSON.stringify(b ?? null) || eq(p, a, b);
  if (!same) out.push({ path: p, py: a, web: b });
}

/** Sort every array whose dotted path matches (multiset comparison). */
function sortMatching(v, p, match) {
  if (Array.isArray(v)) {
    const arr = v.map((x, i) => sortMatching(x, `${p}.${i}`, match));
    return match(p) ? arr.sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y))) : arr;
  }
  if (isObj(v)) {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, sortMatching(x, p ? `${p}.${k}` : k, match)]));
  }
  return v;
}

/** Compare two run results. Returns { steps: [...], errors: [...], ok }. */
export function diffRuns(py, web, scenario = {}) {
  const nc = loadNoncomparable();
  const ignored = makeMatcher([...nc.ignore, ...(scenario.ignore ?? [])]);
  const known = makeMatcher(scenario.known_diffs ?? []);
  const alias = (s) => nc.stateAliases[s] ?? s;
  const zeroMissing = makeMatcher(nc.zeroMissing);
  const nullEmpty = makeMatcher(nc.nullEmpty);
  const unordered = makeMatcher(nc.unordered);
  const eq = (p, a, b) =>
    (zeroMissing(p) && (a ?? 0) === 0 && (b ?? 0) === 0) ||
    (nullEmpty(p) && (a ?? '') === '' && (b ?? '') === '');
  const report = { steps: [], errors: [], ok: true };
  if (py.error) report.errors.push(`python: ${py.error}`);
  if (web.error) report.errors.push(`web: ${web.error}`);
  const n = Math.max(py.steps?.length ?? 0, web.steps?.length ?? 0);
  for (let i = 0; i < n; i++) {
    const ps = py.steps?.[i];
    const ws = web.steps?.[i];
    const action = (ps ?? ws).action;
    const entry = { index: i, action, diffs: [], known: [], errors: [] };
    if (ps?.error) entry.errors.push(`python: ${ps.error}`);
    if (ws?.error) entry.errors.push(`web: ${ws.error}`);
    if (!ps || !ws) {
      entry.errors.push(`${ps ? 'web' : 'python'} has no step ${i}`);
    } else {
      const a = sortMatching(ps.snapshot, '', unordered);
      const b = sortMatching(ws.snapshot, '', unordered);
      a.state = alias(a.state);
      b.state = alias(b.state);
      const raw = [];
      walk(a, b, '', raw, eq);
      for (const d of raw) {
        if (ignored(d.path)) continue;
        (known(d.path) ? entry.known : entry.diffs).push(d);
      }
    }
    if (entry.diffs.length || entry.errors.length) report.ok = false;
    report.steps.push(entry);
  }
  if (report.errors.length) report.ok = false;
  return report;
}

const fmt = (v) => (v === undefined ? '∅' : JSON.stringify(v));

export function formatReport(name, report, { all = false } = {}) {
  const lines = [];
  const nd = report.steps.reduce((s, x) => s + x.diffs.length, 0);
  const nk = report.steps.reduce((s, x) => s + x.known.length, 0);
  lines.push(`== ${name}: ${report.ok ? 'MATCH' : 'DIFF'} (${report.steps.length} steps, ${nd} diffs${nk ? `, ${nk} known` : ''})`);
  for (const e of report.errors) lines.push(`  ! ${e}`);
  for (const s of report.steps) {
    if (!all && !s.diffs.length && !s.errors.length && !s.known.length) continue;
    const act = { ...s.action };
    const label = act.do + (act.unit ? ` ${act.unit}` : '') + (act.target ? ` -> ${act.target}` : '');
    lines.push(`  [${s.index}] ${label}`);
    for (const e of s.errors) lines.push(`      ! ${e}`);
    for (const d of s.diffs) lines.push(`      ${d.path}: py=${fmt(d.py)} web=${fmt(d.web)}`);
    for (const d of s.known) lines.push(`      (known) ${d.path}: py=${fmt(d.py)} web=${fmt(d.web)}`);
  }
  return lines.join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [pyFile, webFile] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const all = process.argv.includes('--all');
  const py = JSON.parse(fs.readFileSync(pyFile, 'utf8'));
  const web = JSON.parse(fs.readFileSync(webFile, 'utf8'));
  const report = diffRuns(py, web);
  console.log(formatReport(py.scenario ?? path.basename(pyFile), report, { all }));
  process.exit(report.ok ? 0 : 1);
}
