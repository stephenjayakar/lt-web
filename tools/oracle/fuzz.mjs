#!/usr/bin/env node
/**
 * Randomized differential fuzz of the EOtF turn lifecycle (fork oracle vs web).
 *
 *   node tools/oracle/fuzz.mjs gen <dir> [--count=N] [--seed=S] [--turns=T]
 *   npm run oracle -- <dir>                 # runs every generated scenario
 *   node tools/oracle/fuzz.mjs report <dir> [--json]
 *
 * `gen` writes scenarios into <dir> (keep it outside the repo, e.g. under
 * $LT_ORACLE_HOME). Each one picks a real EOtF room map (events off), loads
 * random unique units from the unit DB for both teams onto the level's own
 * unit tiles, keeps some of the level's placeholder units, gives every unit
 * explicit stats, random HP and random statuses/skills drawn from the EOtF
 * skills that own turn-lifecycle components (regeneration, poison and
 * stacks, time/end_time, upkeep/endstep events and skill gains, charges,
 * auras...), then runs T full turn cycles (end turn -> AI phases ->
 * player upkeep), one snapshot per cycle.
 *
 * `report` re-diffs the raw runs in $LT_ORACLE_OUT/<scenario>/ and buckets
 * every diff at the step where it first appears or changes: by field and by
 * the turn-lifecycle components of the skills on the affected unit. Step 0
 * (setup) and step 1 (unit loading) diffs are kept in separate buckets so
 * turn-cycle diffs stand out.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { diffRuns } from './diff.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const DATA = path.join(ROOT, 'lt-maker', 'eotf.ltproj', 'game_data');
const HOME = process.env.LT_ORACLE_HOME ?? 'E:/BigData/lt-oracle';
const OUT = process.env.LT_ORACLE_OUT ?? path.join(HOME, 'out');

/** Components whose hooks run at turn change, upkeep or endstep. */
export const TURN_COMPONENTS = new Set([
  'time', 'end_time', 'combined_time', 'lost_on_upkeep', 'lost_on_endstep',
  'regeneration', 'eval_regeneration', 'mana_regeneration',
  'upkeep_damage', 'endstep_damage', 'eval_upkeep_damage', 'gba_poison',
  'upkeep_stat_change', 'upkeep_skill_gain', 'upkeep_aoe_skill_gain',
  'upkeep_event', 'endstep_event', 'upkeep_charge_increase', 'charges_per_turn',
  'build_charge', 'drain_charge', 'purge_ailments', 'null_refresh', 'aura', 'stack',
]);
/** Skills that would end the run or move it off the map. */
const SKIP_SKILL = /^(Debug|Test|_)/i;

function readJson(name) {
  return JSON.parse(fs.readFileSync(path.join(DATA, name), 'utf8'));
}

function rng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    pick: (list) => list[Math.floor(next() * list.length)],
    chance: (p) => next() < p,
    shuffle: (list) => {
      const out = [...list];
      for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
      }
      return out;
    },
  };
}

function turnComponents(skill) {
  return skill.components.map(([nid]) => nid).filter((nid) => TURN_COMPONENTS.has(nid));
}

function skillPools() {
  const skills = readJson('skills.json');
  const byComponent = new Map();
  for (const skill of skills) {
    if (SKIP_SKILL.test(skill.nid)) continue;
    for (const component of turnComponents(skill)) {
      if (!byComponent.has(component)) byComponent.set(component, []);
      byComponent.get(component).push(skill.nid);
    }
  }
  return { byComponent, skills: new Map(skills.map((s) => [s.nid, s])) };
}

/** Sample a skill: first a component (uniformly), then a skill owning it. */
function sampleSkill(r, pools) {
  const components = [...pools.byComponent.keys()];
  return r.pick(pools.byComponent.get(r.pick(components)));
}

function generate(dir, { count, seed, turns }) {
  const r = rng(seed);
  const pools = skillPools();
  const units = readJson('units.json').filter((u) => u.klass && !SKIP_SKILL.test(u.nid));
  const stats = readJson('stats.json').map((s) => s.nid);
  const levels = readJson('levels.json').filter((l) => /^\d+$/.test(l.nid) && Number(l.nid) <= 30 &&
    l.units.filter((u) => u.starting_position).length >= 5);
  fs.mkdirSync(dir, { recursive: true });
  for (let n = 0; n < count; n++) {
    const level = r.pick(levels);
    const tiles = r.shuffle(level.units.filter((u) => u.starting_position));
    const loaded = r.shuffle(units).slice(0, r.int(2, Math.min(5, tiles.length - 1)));
    const setup = [];
    const script = [];
    const passive = r.chance(0.7);
    const explicitStats = () => Object.fromEntries(stats.map((s) =>
      [s, s === 'HP' ? r.int(15, 45) : s === 'MOV' ? r.int(4, 7) : s === 'CON' ? r.int(4, 12) : r.int(0, 20)]));
    const giveSkills = (unitNid, viaEvent) => {
      const added = [];
      for (let k = r.int(1, 4); k > 0; k--) {
        const skill = sampleSkill(r, pools);
        const copies = pools.skills.get(skill)?.components.some(([c]) => c === 'stack') ? r.int(1, 3) : 1;
        for (let c = 0; c < copies; c++) added.push(skill);
      }
      if (viaEvent) for (const skill of added) script.push(`give_skill;${unitNid};${skill};no_banner`);
      return added;
    };
    loaded.forEach((unit, index) => {
      const tile = tiles[index];
      // The placeholder on that tile leaves; the loaded unit takes its tile.
      setup.push({ unit: tile.nid, position: null });
      const team = index === 0 || r.chance(0.5) ? 'player' : 'enemy';
      script.push(`load_unit;${unit.nid};${team}`);
      script.push(`add_unit;${unit.nid};${tile.starting_position[0]},${tile.starting_position[1]};immediate`);
      if (team !== 'player' && passive) script.push(`change_ai;${unit.nid};None`);
      giveSkills(unit.nid, true);
      const hpBase = Math.max(1, Number(unit.bases?.HP ?? 20));
      script.push(`set_current_hp;${unit.nid};${r.int(1, hpBase)}`);
    });
    for (const tile of tiles.slice(loaded.length, loaded.length + r.int(1, 4))) {
      const hp = r.int(15, 45);
      const op = { unit: tile.nid, stats: { ...explicitStats(), HP: hp }, hp: r.int(1, hp), add_skills: [] };
      op.add_skills = giveSkills(tile.nid, false);
      setup.push(op);
    }
    const name = `fuzz-${seed}-${String(n).padStart(3, '0')}`;
    const scenario = {
      name,
      description: `Turn-lifecycle fuzz (seed ${seed} #${n}) on room ${level.nid}${passive ? ', passive enemies' : ''}.`,
      project: 'eotf.ltproj',
      level: level.nid,
      events: false,
      seed: r.int(0, 1023),
      setup,
      actions: [
        { do: 'event', script },
        ...Array.from({ length: turns }, () => ({ do: 'end_turn', max_frames: 40000 })),
      ],
      // Unit-setup differences owned elsewhere (party, Fixed-growth points).
      ignore: ['units.*.party', 'units.*.growth_points'],
    };
    fs.writeFileSync(path.join(dir, `${name}.json`), `${JSON.stringify(scenario, null, 1)}\n`);
  }
  console.log(`wrote ${count} scenarios to ${dir}`);
}

/** Field bucket of a diff path (`units.<nid>.<field>...`). */
function fieldOf(diffPath) {
  const parts = diffPath.split('.');
  if (parts[0] !== 'units') return parts[0];
  const field = parts[2];
  if (field === 'skill_data') return `skill_data.${parts[3]}.${parts[4] ?? ''}`;
  if (field === 'stats' || field === 'wexp') return `${field}.${parts[3]}`;
  if (field === 'items') return `items.${parts[4] ?? ''}`;
  return field ?? 'unit';
}

function report(dir, { json }) {
  const pools = skillPools();
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  const buckets = new Map();
  // turnClean: no diff appears or changes during the turn cycles (setup and
  // unit-loading diffs may persist). pyCrash: the fork itself raised.
  const stats = { scenarios: 0, matched: 0, diffed: 0, errored: 0, missing: 0, turnClean: 0, pyCrash: 0 };
  const add = (key, entry) => {
    if (!buckets.has(key)) buckets.set(key, { count: 0, scenarios: new Set(), examples: [] });
    const b = buckets.get(key);
    b.count++;
    b.scenarios.add(entry.scenario);
    if (b.examples.length < 4) b.examples.push(entry);
  };
  for (const file of files) {
    const scenario = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    const runDir = path.join(OUT, scenario.name);
    if (!fs.existsSync(path.join(runDir, 'py.json')) || !fs.existsSync(path.join(runDir, 'web.json'))) {
      stats.missing++;
      continue;
    }
    stats.scenarios++;
    const py = JSON.parse(fs.readFileSync(path.join(runDir, 'py.json'), 'utf8'));
    const web = JSON.parse(fs.readFileSync(path.join(runDir, 'web.json'), 'utf8'));
    const result = diffRuns(py, web, scenario);
    const errors = [...result.errors, ...result.steps.flatMap((s) => s.errors)];
    const pyCrash = (py.steps ?? []).some((s) => s.error) && !(web.steps ?? []).some((s) => s.error);
    if (pyCrash) stats.pyCrash++;
    if (errors.length) {
      stats.errored++;
      add(`ERROR ${errors[0].split('\n')[0].slice(0, 90)}`, { scenario: scenario.name, detail: errors[0].slice(0, 300) });
    }
    if (result.ok) { stats.matched++; stats.turnClean++; continue; }
    if (!errors.length) stats.diffed++;
    const seen = new Map();
    let turnDiff = false;
    for (const step of result.steps) {
      const phase = step.index === 0 ? 'setup' : step.action?.do === 'event' ? 'load' : 'turn';
      const pySnap = py.steps?.[step.index]?.snapshot;
      for (const d of step.diffs) {
        const sig = JSON.stringify([d.py, d.web]);
        if (seen.get(d.path) === sig) continue;
        seen.set(d.path, sig);
        const unitNid = d.path.startsWith('units.') ? d.path.split('.')[1] : null;
        const unitSkills = unitNid ? (pySnap?.units?.[unitNid]?.skills ?? []) : [];
        const components = [...new Set(unitSkills.flatMap((s) => {
          const skill = pools.skills.get(s);
          return skill ? turnComponents(skill) : [];
        }))].sort();
        if (phase === 'turn') turnDiff = true;
        add(`${phase} ${fieldOf(d.path)}`, {
          scenario: scenario.name, step: step.index, path: d.path, py: d.py, web: d.web,
          skills: unitSkills, components,
        });
      }
    }
    if (!turnDiff && !errors.length) stats.turnClean++;
  }
  const sorted = [...buckets.entries()].sort((a, b) => b[1].scenarios.size - a[1].scenarios.size);
  if (json) {
    console.log(JSON.stringify({ stats, buckets: sorted.map(([k, v]) => ({ key: k, count: v.count, scenarios: [...v.scenarios], examples: v.examples })) }, null, 1));
    return;
  }
  console.log(`scenarios ${stats.scenarios} (missing ${stats.missing}): matched ${stats.matched}, ` +
    `turn-clean ${stats.turnClean}, diffs ${stats.diffed}, errors ${stats.errored} (fork crashed: ${stats.pyCrash})`);
  for (const [key, b] of sorted) {
    console.log(`\n[${b.scenarios.size} scen, ${b.count}x] ${key}`);
    for (const e of b.examples) {
      console.log(`   ${e.scenario}@${e.step ?? '-'} ${e.path ?? ''} py=${JSON.stringify(e.py)} web=${JSON.stringify(e.web)}` +
        (e.components?.length ? `  {${e.components.join(',')}}` : '') + (e.detail ? `  ${e.detail}` : ''));
    }
  }
}

const [cmd, dir, ...rest] = process.argv.slice(2);
const opt = (name, fallback) => {
  const hit = rest.find((a) => a.startsWith(`--${name}=`));
  return hit ? Number(hit.split('=')[1]) : fallback;
};
if (cmd === 'gen' && dir) {
  generate(path.resolve(dir), { count: opt('count', 20), seed: opt('seed', 1), turns: opt('turns', 3) });
} else if (cmd === 'report' && dir) {
  report(path.resolve(dir), { json: rest.includes('--json') });
} else {
  console.error('usage: fuzz.mjs gen <dir> [--count=N] [--seed=S] [--turns=T] | report <dir> [--json]');
  process.exit(2);
}
