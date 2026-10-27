#!/usr/bin/env node
/**
 * AI-phase differential fuzz: generate randomized EOtF AI-phase scenarios and
 * (optionally) bucket the AI-trace differences of finished oracle runs.
 *
 *   node tools/oracle/fuzz-ai.mjs gen --count 40 --seed 1 --dir <scenario dir>
 *   npm run oracle -- <scenario dir>              # runs both engines, writes $LT_ORACLE_OUT/<name>/
 *   node tools/oracle/fuzz-ai.mjs report --dir <scenario dir> [--out <runs dir>]
 *
 * Each scenario takes a real battle level with its own enemy units and AI
 * presets (level events off), loads 3-5 random playable units through
 * load_unit/add_unit next to the enemies or on the formation tiles, and ends
 * the player turn twice. Every snapshot carries `ai_trace` (one entry per AI
 * decision, canto retreat and group ping, see py_driver.install_ai_trace).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const PROJECT = path.join(ROOT, 'lt-maker', 'eotf.ltproj');
const HOME = process.env.LT_ORACLE_HOME ?? 'E:/BigData/lt-oracle';
const OUT = process.env.LT_ORACLE_OUT ?? path.join(HOME, 'out');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

/** Small deterministic PRNG (mulberry32). */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
/** JSON with sorted keys, so Python's and the web's key order compare equal. */
const canon = (v) => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x)
  ? Object.fromEntries(Object.keys(x).sort().map((key) => [key, x[key]])) : x));

function walkableTiles(tilemapNid, terrain) {
  const file = path.join(PROJECT, 'resources', 'tilemaps', 'tilemap_data', `${tilemapNid}.json`);
  if (!fs.existsSync(file)) return null;
  const raw = readJson(file);
  const tm = Array.isArray(raw) ? raw[0] : raw;
  if (!tm?.layers) return null;
  const grid = new Map();
  for (const layer of tm.layers) {
    if (layer.visible === false) continue;
    for (const [key, nid] of Object.entries(layer.terrain_grid)) grid.set(key, nid);
  }
  const [w, h] = tm.size;
  const tiles = [];
  for (const [key, nid] of grid) {
    const [x, y] = key.split(',').map(Number);
    if (x < 0 || y < 0 || x >= w || y >= h) continue;
    if (terrain.get(nid)?.mtype === 'Normal') tiles.push([x, y]);
  }
  return tiles;
}

function generate() {
  const count = Number(arg('count', 40));
  const seed = Number(arg('seed', 1));
  const dir = arg('dir');
  if (!dir) throw new Error('--dir required');
  fs.mkdirSync(dir, { recursive: true });
  const data = path.join(PROJECT, 'game_data');
  const levels = readJson(path.join(data, 'levels.json'));
  const units = readJson(path.join(data, 'units.json'));
  const terrain = new Map(readJson(path.join(data, 'terrain.json')).map((t) => [t.nid, t]));
  const playable = units.filter((u) => u.tags.includes('Playable') && u.starting_items.length && u.nid !== 'Player');
  const candidates = levels.filter((l) => !l.roam && l.nid !== 'DEBUG' &&
    l.units.some((u) => u.team === 'enemy' && u.starting_position && u.ai && u.ai !== 'None'));
  const r = rng(seed);
  const pick = (list) => list[Math.floor(r() * list.length)];
  for (let n = 0; n < count; n++) {
    const level = pick(candidates);
    const walkable = walkableTiles(level.tilemap, terrain) ?? [];
    const occupied = new Set(level.units.filter((u) => u.starting_position).map((u) => u.starting_position.join(',')));
    const enemies = level.units.filter((u) => u.team === 'enemy' && u.starting_position);
    const formation = level.regions.filter((g) => g.region_type === 'formation').flatMap((g) => {
      const out = [];
      for (let x = g.position[0]; x < g.position[0] + (g.size?.[0] ?? 1); x++) {
        for (let y = g.position[1]; y < g.position[1] + (g.size?.[1] ?? 1); y++) out.push([x, y]);
      }
      return out;
    });
    // Half the party near a random enemy (2-5 tiles away), the rest on formation tiles.
    const size = 3 + Math.floor(r() * 3);
    const party = [];
    const used = new Set();
    while (party.length < size) {
      const u = pick(playable);
      if (!used.has(u.nid)) { used.add(u.nid); party.push(u.nid); }
    }
    const taken = new Set(occupied);
    const spots = [];
    for (let i = 0; i < party.length; i++) {
      let spot = null;
      if (i % 2 === 0 && enemies.length && walkable.length) {
        const anchor = pick(enemies).starting_position;
        const near = walkable.filter(([x, y]) => {
          const d = Math.abs(x - anchor[0]) + Math.abs(y - anchor[1]);
          return d >= 2 && d <= 5 && !taken.has(`${x},${y}`);
        });
        if (near.length) spot = pick(near);
      }
      if (!spot) {
        const free = formation.filter(([x, y]) => !taken.has(`${x},${y}`));
        if (free.length) spot = pick(free);
      }
      if (!spot) continue;
      taken.add(spot.join(','));
      spots.push([party[i], spot]);
    }
    const script = [];
    for (const [nid, [x, y]] of spots) {
      script.push(`load_unit;${nid}`);
      script.push(`add_unit;${nid};${x},${y};immediate;closest`);
    }
    const name = `fuzz-ai-${seed}-${String(n).padStart(3, '0')}`;
    const scenario = {
      name,
      description: `AI-phase fuzz: level ${level.nid} (${level.name}), party ${spots.map(([u]) => u).join(', ')}`,
      project: 'eotf.ltproj',
      level: level.nid,
      events: false,
      seed: Math.floor(r() * 1000),
      actions: [
        { do: 'event', script },
        { do: 'end_turn' },
        { do: 'end_turn' },
      ],
    };
    fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(scenario, null, 1));
  }
  console.log(`wrote ${count} scenarios to ${dir}`);
}

/** First AI-trace divergence per step, bucketed by the acting unit's AI preset. */
function report() {
  const dir = arg('dir');
  const runs = arg('out', OUT);
  const buckets = new Map();
  const stats = { scenarios: 0, errors: 0, decisions: 0, matchedScenarios: 0, diverged: 0, stateOnly: 0 };
  const lines = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json')).sort()) {
    const scn = readJson(path.join(dir, f));
    const pyFile = path.join(runs, scn.name, 'py.json');
    const webFile = path.join(runs, scn.name, 'web.json');
    if (!fs.existsSync(pyFile) || !fs.existsSync(webFile)) continue;
    stats.scenarios++;
    const py = readJson(pyFile);
    const web = readJson(webFile);
    if (py.error || web.error) {
      stats.errors++;
      lines.push(`ERROR ${scn.name}: py=${py.error ?? '-'} web=${web.error ?? '-'}`);
      continue;
    }
    let diverged = false;
    let stateDiff = false;
    for (let s = 0; s < Math.min(py.steps.length, web.steps.length); s++) {
      const a = py.steps[s].snapshot?.ai_trace ?? [];
      const b = web.steps[s].snapshot?.ai_trace ?? [];
      stats.decisions += a.filter((x) => 'did' in x).length;
      const n = Math.max(a.length, b.length);
      for (let i = 0; i < n; i++) {
        const strip = (x) => (x && 'hp' in x ? { ...x, hp: undefined } : x);
        if (canon(strip(a[i]) ?? null) === canon(strip(b[i]) ?? null)) continue;
        // A decision taken on a board whose HP already differs follows a
        // combat-number difference (the combat agent's area), not the AI.
        const hpDiff = a[i]?.hp && b[i]?.hp && canon(a[i].hp) !== canon(b[i].hp);
        const unitNid = a[i]?.unit ?? b[i]?.unit ?? a[i]?.by ?? b[i]?.by;
        const ai = py.steps[s].snapshot.units?.[unitNid]?.ai ?? '?';
        const kind = !a[i] || !b[i] ? 'length' : a[i].unit !== b[i].unit ? 'order'
          : 'canto' in a[i] ? 'canto' : 'group' in a[i] ? 'group'
            : ['did', 'move', 'target', 'item'].filter((k) => JSON.stringify(a[i][k]) !== JSON.stringify(b[i][k])).join('+') || 'from';
        const key = hpDiff ? `combat-downstream (${ai} / ${kind})` : `${ai} / ${kind}`;
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push(`${scn.name} step ${s} #${i}: py=${canon(strip(a[i]) ?? null)} web=${canon(strip(b[i]) ?? null)}`);
        diverged = true;
        break;
      }
      if (diverged) break;
      // Same decisions: compare the resulting positions and HP.
      const pu = py.steps[s].snapshot.units ?? {};
      const wu = web.steps[s].snapshot.units ?? {};
      for (const nid of Object.keys(pu)) {
        const p = pu[nid];
        const w = wu[nid];
        if (!w) continue;
        if (JSON.stringify(p.position) !== JSON.stringify(w.position) || p.hp !== w.hp || p.dead !== w.dead) {
          const key = `${p.ai ?? '?'} / state:${JSON.stringify(p.position) !== JSON.stringify(w.position) ? 'position' : 'hp'}`;
          if (!buckets.has(key)) buckets.set(key, []);
          buckets.get(key).push(`${scn.name} step ${s} ${nid}: py=${JSON.stringify([p.position, p.hp, p.dead])} web=${JSON.stringify([w.position, w.hp, w.dead])}`);
          stateDiff = true;
          break;
        }
      }
      if (stateDiff) break;
    }
    if (diverged) stats.diverged++;
    else if (stateDiff) stats.stateOnly++;
    else stats.matchedScenarios++;
  }
  console.log(JSON.stringify(stats));
  for (const [key, list] of [...buckets.entries()].sort((x, y) => y[1].length - x[1].length)) {
    console.log(`\n== ${key} (${list.length})`);
    for (const line of list.slice(0, 6)) console.log(`  ${line}`);
  }
  for (const line of lines) console.log(line);
}

const mode = process.argv[2];
if (mode === 'gen') generate();
else if (mode === 'report') report();
else {
  console.error('usage: fuzz-ai.mjs gen|report --dir <dir> [--count N --seed S] [--out <runs>]');
  process.exit(2);
}
