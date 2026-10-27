/**
 * Field-level comparison of two oracle runs (py_driver.py vs web-driver.mjs).
 *
 *   node tools/oracle/diff.mjs py.json web.json [--all] [--full]
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
    falseMissing: Object.keys(raw.false_equals_missing ?? {}),
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

function walk(a, b, p, out, opts) {
  const { eq, unordered } = opts;
  // An object present on one side only is walked field by field, so ignore
  // rules on its sub-paths still apply.
  if ((isObj(a) && b === undefined) || (a === undefined && isObj(b))) {
    if (a === undefined) a = {};
    else b = {};
  }
  if (isObj(a) && isObj(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of [...keys].sort()) {
      walk(k in a ? a[k] : undefined, k in b ? b[k] : undefined, p ? `${p}.${k}` : k, out, opts);
    }
    return;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (unordered(p)) {
      // Multiset comparison: report only the elements each side lacks.
      const rest = b.map((x) => JSON.stringify(x));
      const onlyA = [];
      for (const x of a) {
        const i = rest.indexOf(JSON.stringify(x));
        if (i >= 0) rest.splice(i, 1);
        else onlyA.push(x);
      }
      const onlyB = rest.map((x) => JSON.parse(x));
      if (onlyA.length || onlyB.length) out.push({ path: p, py: onlyA, web: onlyB, multiset: true });
      return;
    }
    const n = Math.max(a.length, b.length);
    for (let i = 0; i < n; i++) walk(a[i], b[i], `${p}.${i}`, out, opts);
    return;
  }
  const same = JSON.stringify(a ?? null) === JSON.stringify(b ?? null) || eq(p, a, b);
  if (!same) out.push({ path: p, py: a, web: b });
}

/** Compare two run results. Returns { steps: [...], errors: [...], ok }. */
export function diffRuns(py, web, scenario = {}) {
  const nc = loadNoncomparable();
  const ignored = makeMatcher([...nc.ignore, ...(scenario.ignore ?? [])]);
  const known = makeMatcher(scenario.known_diffs ?? []);
  const alias = (s) => nc.stateAliases[s] ?? s;
  const zeroMissing = makeMatcher(nc.zeroMissing);
  const nullEmpty = makeMatcher(nc.nullEmpty);
  const falseMissing = makeMatcher(nc.falseMissing);
  const unordered = makeMatcher(nc.unordered);
  const eq = (p, a, b) =>
    (zeroMissing(p) && (a ?? 0) === 0 && (b ?? 0) === 0) ||
    (nullEmpty(p) && (a ?? '') === '' && (b ?? '') === '') ||
    (falseMissing(p) && (a ?? false) === false && (b ?? false) === false);
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
      const a = structuredClone(ps.snapshot);
      const b = structuredClone(ws.snapshot);
      a.state = alias(a.state);
      b.state = alias(b.state);
      const raw = [];
      walk(a, b, '', raw, { eq, unordered });
      for (const d of raw) {
        if (ignored(d.path)) continue;
        (known(d.path) ? entry.known : entry.diffs).push(d);
      }
    }
    // save_load steps: what each engine's own suspend/reload changed.
    for (const [side, st] of [['python', ps], ['web', ws]]) {
      if (!st?.pre_snapshot) continue;
      const raw = [];
      walk(structuredClone(st.pre_snapshot), structuredClone(st.snapshot), '', raw, { eq, unordered });
      const changed = raw.filter((d) => !ignored(d.path));
      if (changed.length) (entry.roundtrip ??= {})[side] = changed;
    }
    if (entry.diffs.length || entry.errors.length) report.ok = false;
    report.steps.push(entry);
  }
  if (report.errors.length) report.ok = false;
  return report;
}

const fmt = (v) => (v === undefined ? '∅' : JSON.stringify(v));
const fmtDiff = (d) => (d.multiset
  ? `${d.path}: py-only=${fmt(d.py)} web-only=${fmt(d.web)}`
  : `${d.path}: py=${fmt(d.py)} web=${fmt(d.web)}`);

/**
 * Human-readable report. By default a diff is printed at the first step where
 * it appears (or changes value); later steps only count it as persisting.
 * `full` prints every diff at every step, `all` also lists matching steps.
 */
export function formatReport(name, report, { all = false, full = false } = {}) {
  const lines = [];
  const nd = report.steps.reduce((s, x) => s + x.diffs.length, 0);
  const nk = report.steps.reduce((s, x) => s + x.known.length, 0);
  lines.push(`== ${name}: ${report.ok ? 'MATCH' : 'DIFF'} (${report.steps.length} steps, ${nd} diffs${nk ? `, ${nk} known` : ''})`);
  for (const e of report.errors) lines.push(`  ! ${e}`);
  let prev = new Map();
  for (const s of report.steps) {
    const cur = new Map(s.diffs.map((d) => [d.path, JSON.stringify([d.py, d.web])]));
    const shown = full ? s.diffs : s.diffs.filter((d) => prev.get(d.path) !== cur.get(d.path));
    const persisting = s.diffs.length - shown.length;
    const resolved = full ? [] : [...prev.keys()].filter((p) => !cur.has(p));
    prev = cur;
    if (!all && !shown.length && !s.errors.length && !s.known.length && !resolved.length && !s.roundtrip) continue;
    const act = { ...s.action };
    const label = act.do + (act.unit ? ` ${act.unit}` : '') + (act.target ? ` -> ${act.target}` : '');
    lines.push(`  [${s.index}] ${label}${persisting ? `  (+${persisting} persisting)` : ''}`);
    for (const e of s.errors) lines.push(`      ! ${e}`);
    for (const d of shown) lines.push(`      ${fmtDiff(d)}`);
    for (const p of resolved) lines.push(`      (now equal) ${p}`);
    for (const d of s.known) lines.push(`      (known) ${fmtDiff(d)}`);
    for (const [side, changed] of Object.entries(s.roundtrip ?? {})) {
      for (const d of changed) {
        lines.push(`      (${side} reload changed) ${d.path}: ${fmt(d.py)} -> ${fmt(d.web)}`);
      }
    }
  }
  return lines.join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [pyFile, webFile] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const all = process.argv.includes('--all');
  const full = process.argv.includes('--full');
  const py = JSON.parse(fs.readFileSync(pyFile, 'utf8'));
  const web = JSON.parse(fs.readFileSync(webFile, 'utf8'));
  const report = diffRuns(py, web);
  console.log(formatReport(py.scenario ?? path.basename(pyFile), report, { all, full }));
  process.exit(report.ok ? 0 : 1);
}
