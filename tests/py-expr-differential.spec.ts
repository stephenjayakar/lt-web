/**
 * TEMPORARY differential run: every EOtF expression through the old regex
 * translator (src/events/legacy-expression.ts) and the new Python evaluator
 * (src/events/py-expr) in representative game states. Writes the list of
 * expressions whose results differ to test-results/py-expr-differential.json.
 *
 * Run: PLAYWRIGHT_PORT=<port> npx playwright test tests/py-expr-differential.spec.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { test, type Page } from '@playwright/test';
// @ts-expect-error - plain ESM helper script
import { collectCorpus, uniqueCorpus } from '../scripts/py-expr-corpus.mjs';
import { parsePythonExpression, type Node } from '../src/events/py-expr/parser';

/**
 * Infer a plausible value for every variable/record the corpus reads, from
 * how expressions use it (`v('x') + ['a']` -> list, `v('x') % 3` -> int...),
 * so the differential runs against populated state rather than None.
 */
function inferState(expressions: string[]): { vars: Record<string, unknown>; records: Record<string, unknown> } {
  const vars: Record<string, unknown> = {};
  const records: Record<string, unknown> = {};
  const keyOf = (node: Node): { table: Record<string, unknown>; key: string } | null => {
    if (node.k !== 'call' || node.args.length < 1 || node.args[0].k !== 'const' || typeof node.args[0].value !== 'string') return null;
    const key = node.args[0].value as string;
    if (key.includes('_tag_')) return null;
    if (node.func.k === 'name' && node.func.id === 'v') return { table: vars, key };
    if (node.func.k === 'attribute' && node.func.attr === 'get') {
      const owner = node.func.value;
      if (owner.k === 'name' && owner.id === 'RECORDS') return { table: records, key };
      if (owner.k === 'attribute' && (owner.attr === 'game_vars' || owner.attr === 'level_vars')) return { table: vars, key };
    }
    return null;
  };
  const sample = (other: Node | undefined, op: string): unknown => {
    if (other?.k === 'list') return ['alpha', 'beta'];
    if (other?.k === 'const' && typeof other.value === 'string') return 'text';
    if (op === 'in') return ['alpha', 'beta'];
    return 3;
  };
  const visit = (node: any, parent: any): void => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach((child) => visit(child, parent));
      return;
    }
    if (typeof node.k === 'string') {
      const target = keyOf(node);
      if (target && !(target.key in target.table)) {
        let value: unknown;
        if (parent?.k === 'binop') value = sample(parent.left === node ? parent.right : parent.left, parent.op);
        else if (parent?.k === 'compare') {
          const index = parent.left === node ? 0 : parent.comparators.indexOf(node) + 1;
          const op = parent.ops[Math.max(0, index - 1)] ?? parent.ops[0];
          const other = index === 0 ? parent.comparators[0] : (index === 1 ? parent.left : parent.comparators[index - 2]);
          value = (op === 'in' || op === 'not in') && index > 0 ? ['alpha', 'beta'] : sample(other, op);
        } else if (parent?.k === 'call' && parent.func.k === 'name' && ['len', 'sorted', 'sum', 'any', 'all', 'set', 'list'].includes(parent.func.id)) {
          value = ['alpha', 'beta'];
        } else if (parent?.k === 'call' && parent.func.k === 'name' && ['range', 'int', 'min', 'max', 'abs'].includes(parent.func.id)) {
          value = 3;
        } else if (parent?.k === 'subscript' && parent.value === node) value = ['alpha', 'beta', 'gamma'];
        if (value !== undefined) target.table[target.key] = value;
      }
    }
    for (const [key, child] of Object.entries(node)) {
      if (key !== 'k' && child && typeof child === 'object') visit(child, node);
    }
  };
  for (const expression of expressions) {
    try {
      visit(parsePythonExpression(expression), null);
    } catch {
      // syntax errors are reported by the corpus spec
    }
  }
  return { vars, records };
}

const CONDITION_KINDS = new Set([
  'event_condition', 'if', 'ai_condition', 'region_condition', 'component:condition',
  'component:combat_condition', 'component:allowed_weapons', 'component:eval_available',
  'component:eval_target_restrict_2', 'component:eval_target_restrict', 'component:can_unlock',
  'component:eval_galeforce', 'component:eval_magic', 'component:eval_dragon',
  'component:eval_dragon_magic', 'component:item_icon_flash', 'component:witch_warp_expression',
  'component:eval_warning',
]);

/** Expressions that mutate persistent state; not run twice. */
const SIDE_EFFECTS = /\.(?:update|remove|append|discard|reset_surf|set_favorited|pop|insert|extend|clear|register_item)\s*\(|action\.do\(/;

async function boot(page: Page, level: string): Promise<void> {
  await page.goto(`/?harness=true&project=eotf.ltproj&level=${level}&clean=true&bundle=false`);
  await page.waitForFunction(() => (window as any).__harness?.ready === true, undefined, { timeout: 90_000 });
}

test.describe.configure({ mode: 'serial' });

function equationRows(rows: any[]): any[] {
  return rows;
}

test('differential: legacy translator vs Python evaluator over the EOtF corpus', async ({ page }) => {
  test.setTimeout(1_800_000);
  const corpus = uniqueCorpus(collectCorpus(path.join(process.cwd(), 'lt-maker/eotf.ltproj')))
    .filter((entry: any) => !entry.kinds.every((kind: string) => kind === 'equation' || kind === 'component:eval_special_range'));
  const jobs: { expr: string; mode: 'condition' | 'expression'; kinds: string[] }[] = [];
  const skipped: string[] = [];
  for (const entry of corpus) {
    if (SIDE_EFFECTS.test(entry.expr)) {
      skipped.push(entry.expr);
      continue;
    }
    const kinds: string[] = entry.kinds;
    if (kinds.some((kind) => CONDITION_KINDS.has(kind))) jobs.push({ expr: entry.expr, mode: 'condition', kinds });
    if (kinds.some((kind) => !CONDITION_KINDS.has(kind) && kind !== 'equation')) jobs.push({ expr: entry.expr, mode: 'expression', kinds });
  }

  const populated = inferState(corpus.map((entry: any) => entry.expr));
  const states = [
    { level: 'X', name: 'hub', setup: 'hub' },
    { level: 'X', name: 'combat-player-vs-enemy', setup: 'combat' },
    { level: 'X', name: 'enemy-perspective-empty-vars', setup: 'enemy' },
  ];
  const differences: any[] = [];
  const summary: any[] = [];
  const snapshots: Record<string, unknown> = {};
  const everything: any[] = [];
  const equationResults: any[] = [];
  for (const state of states) {
    await boot(page, state.level);
    const result = await page.evaluate(async ({ jobs: jobList, setup, populated: state }) => {
      const game = (window as any).__gameRef;
      const records = await import('/src/engine/records.ts');
      // The enemy-perspective state uses falsy samples (0, []) to take the
      // other branch of authored checks.
      const variant = (value: unknown) => setup === 'enemy'
        ? (Array.isArray(value) ? [] : typeof value === 'number' ? 0 : value)
        : structuredClone(value);
      for (const [key, value] of Object.entries(state.vars)) {
        if (!game.gameVars.has(key)) game.gameVars.set(key, variant(value));
      }
      for (const [key, value] of Object.entries(state.records)) {
        if (!records.RECORDS.has(key)) records.RECORDS.create(key, variant(value));
      }
      const legacy = await import('/src/events/legacy-expression.ts');
      const modern = await import('/src/events/event-manager.ts');
      const units = [...game.units.values()] as any[];
      let unit1: any;
      let unit2: any;
      const player = game.units.get('Player');
      const keeper = game.units.get('Keeper');
      if (setup === 'hub') {
        unit1 = player;
        unit2 = keeper;
      } else if (setup === 'combat') {
        unit1 = player;
        unit2 = keeper;
        keeper.team = 'enemy';
        keeper.position = [player.position[0] + 1, player.position[1]];
        game.turnCount = 3;
        player.currentHp = Math.max(1, Math.floor(player.currentHp / 2));
      } else {
        unit1 = keeper;
        unit2 = player;
        keeper.team = 'enemy';
        game.turnCount = 1;
      }
      const item = unit1?.equippedWeapon ?? unit1?.getWeapon?.() ?? unit1?.items?.[0] ?? null;
      const item2 = unit2?.equippedWeapon ?? unit2?.getWeapon?.() ?? unit2?.items?.[0] ?? null;
      const skill = unit1?.skills?.[0] ?? null;
      const region = game.currentLevel?.regions?.[0] ?? null;
      const localArgs = new Map<string, any>([
        ['item2', item2], ['mode', 'attack'], ['skill', skill],
        ['target_pos', unit2?.position ?? null],
      ]);
      const context = {
        game, unit1, unit2, item, region,
        position: unit1?.position ?? undefined,
        gameVars: game.gameVars, levelVars: game.levelVars, localArgs,
      };

      const describe = (value: any, depth = 0): string => {
        if (depth > 4) return '...';
        if (value === undefined) return 'FAIL';
        if (value === null) return 'None';
        if (typeof value === 'boolean') return value ? 'True' : 'False';
        if (typeof value === 'number') return Number.isNaN(value) ? 'nan' : String(value);
        if (typeof value === 'string') return JSON.stringify(value);
        if (typeof value === 'function') return 'fn';
        if (Array.isArray(value)) return `[${value.map((entry) => describe(entry, depth + 1)).join(', ')}]`;
        if (value instanceof Set) return `set(${[...value].map((entry) => describe(entry, depth + 1)).sort().join(', ')})`;
        if (value instanceof Map) {
          return `dict(${[...value.entries()].map(([k, v]) => `${describe(k, depth + 1)}: ${describe(v, depth + 1)}`).sort().join(', ')})`;
        }
        if (typeof value === 'object') {
          const raw = '_raw' in value ? value._raw : value;
          if (raw && typeof raw === 'object' && ('uid' in raw || 'nid' in raw) && (raw.uid !== undefined || raw.nid !== undefined)) {
            return `<${raw.uid ?? ''}:${raw.nid ?? ''}>`;
          }
          if (typeof value.next === 'function') return 'iterator';
          const entries = Object.entries(value).filter(([, v]) => typeof v !== 'function');
          return `dict(${entries.map(([k, v]) => `${JSON.stringify(k)}: ${describe(v, depth + 1)}`).sort().join(', ')})`;
        }
        return String(value);
      };

      // Keep the two runs independent: no action-log mutations (random
      // state, registrations) and quiet consoles.
      const originalDo = game.actionLog?.doAction;
      if (game.actionLog) game.actionLog.doAction = () => undefined;
      const originalWarn = console.warn;
      const originalLog = console.log;
      const originalError = console.error;
      console.warn = () => undefined;
      console.log = () => undefined;
      console.error = () => undefined;
      const out: any[] = [];
      const all: any[] = [];
      let compared = 0;
      try {
        for (const job of jobList) {
          const run = (fn: () => any): string => {
            try {
              return describe(fn());
            } catch (error) {
              return `THROW ${String((error as Error)?.message ?? error).slice(0, 80)}`;
            }
          };
          const oldResult = run(() => job.mode === 'condition'
            ? legacy.legacyEvaluateCondition(job.expr, context)
            : legacy.legacyEvaluateExpression(job.expr, context));
          const newOutcome = modern.evaluatePythonInContext(job.expr, context);
          const newShown = job.mode === 'condition'
            ? run(() => modern.evaluateCondition(job.expr, context))
            : run(() => modern.evaluateExpression(job.expr, context));
          compared += 1;
          all.push({ expr: job.expr, mode: job.mode, old: oldResult, new: newShown });
          if (oldResult !== newShown) {
            out.push({
              expr: job.expr,
              mode: job.mode,
              kinds: job.kinds,
              old: oldResult,
              new: newShown,
              error: newOutcome.ok ? null : String((newOutcome.error as any)?.message ?? newOutcome.error).slice(0, 160),
            });
          }
        }
      } finally {
        console.warn = originalWarn;
        console.log = originalLog;
        console.error = originalError;
        if (game.actionLog) game.actionLog.doAction = originalDo;
      }
      // Snapshot of everything the differing expressions read, for the
      // python3 ground-truth replay (scripts/py-expr-differential-truth.py).
      const { unitTags } = await import('/src/combat/skill-system.ts');
      const plain = (value: any): any => {
        if (value instanceof Map) return Object.fromEntries([...value].map(([k, v]) => [k, plain(v)]));
        if (value instanceof Set) return [...value].map(plain);
        if (Array.isArray(value)) return value.map(plain);
        if (value && typeof value === 'object') {
          if (value.uid !== undefined && value.components) return { __item_uid: value.uid };
          if (value.team !== undefined && value.skills) return { __unit: value.nid };
          return Object.fromEntries(Object.entries(value).filter(([, v]) => typeof v !== 'function').map(([k, v]) => [k, plain(v)]));
        }
        return value;
      };
      const entries = (candidate: any) => candidate.components instanceof Map
        ? [...candidate.components.entries()] : (candidate.components ?? []);
      const snapSkill = (skill: any) => ({
        nid: skill.nid, uid: skill.uid, name: skill.name,
        owner_nid: skill.ownerNid ?? null,
        data: plain(skill.data ?? new Map()),
        components: entries(skill).map(([nid, value]: [string, any]) => [nid, plain(value)]),
      });
      const snapItem = (candidate: any) => candidate && ({
        nid: candidate.nid, uid: candidate.uid, name: candidate.name,
        owner_nid: candidate.owner?.nid ?? candidate.ownerNid ?? null,
        data: plain(candidate.data ?? new Map()),
        components: entries(candidate).map(([nid, value]: [string, any]) => [nid, plain(value)]),
        parent_uid: candidate.parentItem?.uid ?? null,
      });
      const statNids = (game.db.stats ?? []).map((stat: any) => stat.nid);
      const snapshot = {
        units: units.map((candidate: any) => ({
          nid: candidate.nid, name: candidate.name, team: candidate.team, klass: candidate.klass,
          position: candidate.position, party: candidate.party ?? null, generic: !!candidate.generic,
          _finished: !!candidate._finished, dead: !!(candidate.isDead?.() ?? candidate.dead),
          is_dying: !!candidate.isDying, level: candidate.level, persistent: !!candidate.persistent,
          tags: [...unitTags(candidate, game)], _tags: [...(candidate.tags ?? [])],
          hp: candidate.currentHp, max_hp: candidate.getMaxHp?.() ?? candidate.maxHp,
          stat_values: Object.fromEntries(statNids.map((nid: string) => [nid,
            candidate.getStat?.(nid) ?? candidate.getStatValue?.(nid) ?? candidate.stats?.[nid] ?? 0])),
          stats: plain(candidate.stats), wexp: plain(candidate.wexp), growths: plain(candidate.growths),
          fields: plain(candidate.fields ?? new Map()),
          skills: (candidate.skills ?? []).map(snapSkill),
          items: (candidate.items ?? []).map(snapItem),
          weapon_uid: (candidate.getWeapon?.() ?? candidate.equippedWeapon)?.uid ?? null,
          traveler: candidate.traveler ?? null, affinity: candidate.affinity ?? null,
          previous_position: candidate.previousPosition ?? null, ai: candidate.ai ?? null,
          faction: candidate.faction ?? null, ai_group: candidate.aiGroup ?? null,
          mana: candidate.currentMana ?? 0,
          accessory_uids: (candidate.items ?? []).filter((entry: any) =>
            entry.hasComponent?.('accessory') || entry.hasComponent?.('equippable_accessory')).map((entry: any) => entry.uid),
        })),
        current_party: game.currentParty ?? null,
        party_orders: Object.fromEntries([...(game.parties?.entries?.() ?? [])].map(([nid, party]: [string, any]) =>
          [nid, party.partyPrepManageSortOrder ?? []])),
        phase: game.phase?.getCurrent?.() ?? 'player',
        money: game.getMoney?.() ?? 0,
        alliances: Object.fromEntries(['player', 'enemy', 'enemy2', 'other'].flatMap((a) =>
          ['player', 'enemy', 'enemy2', 'other'].map((b) => [`${a}|${b}`, !!(game.db?.areAllied?.(a, b) ?? a === b)]))),
        game_vars: plain(game.gameVars), level_vars: plain(game.levelVars),
        records: Object.fromEntries([...new Set([...Object.keys(state.records),
          ...jobList.flatMap((job: any) => [...job.expr.matchAll(/RECORDS\.get\('([^']+)'/g)].map((m: any) => m[1]))])]
          .filter((key) => records.RECORDS.has(key)).map((key) => [key, plain(records.RECORDS.get(key))])),
        level: { nid: game.currentLevel?.nid, name: game.currentLevel?.name,
          regions: (game.currentLevel?.regions ?? []).map((r: any) => ({ nid: r.nid, region_type: r.region_type, position: r.position, size: r.size, sub_nid: r.sub_nid })) },
        turncount: game.turnCount,
        db: {
          skills: [...game.db.skills.values()].map((skill: any) => ({ nid: skill.nid, name: skill.name, components: skill.components })),
          items: [...game.db.items.values()].map((candidate: any) => ({ nid: candidate.nid, name: candidate.name, components: candidate.components })),
          units: [...game.db.units.values()].map((candidate: any) => ({ nid: candidate.nid, name: candidate.name })),
          stats: statNids,
        },
        context: {
          unit1: unit1?.nid ?? null, unit2: unit2?.nid ?? null, item_uid: item?.uid ?? null,
          item2_uid: item2?.uid ?? null, skill_uid: skill?.uid ?? null, region: region?.nid ?? null,
          position: unit1?.position ?? null, target_pos: unit2?.position ?? null, mode: 'attack',
        },
      };
      // Equations: every EOtF equation for every unit, old vs new.
      const { evaluateEquation } = await import('/src/combat/combat-calcs.ts');
      const equationRows: any[] = [];
      console.warn = () => undefined;
      try {
        for (const nid of game.db.getEquationNames()) {
          const expression = game.db.getEquation(nid);
          if (!expression) continue;
          for (const candidate of units) {
            const oldValue = (() => { try { return legacy.legacyEvaluateEquation(expression, candidate, { db: game.db }); } catch (e) { return 'THROW'; } })();
            const newValue = evaluateEquation(expression, candidate, { db: game.db });
            equationRows.push({ nid, expression, unit: candidate.nid, old: oldValue, new: newValue });
          }
        }
      } finally {
        console.warn = originalWarn;
      }
      return {
        equations: equationRows,
        compared,
        context: { unit1: unit1?.nid, unit2: unit2?.nid, item: item?.nid, item2: item2?.nid, skill: skill?.nid, region: region?.nid },
        differences: out,
        all,
        snapshot,
      };
    }, { jobs, setup: state.setup, populated });
    summary.push({ state: state.name, compared: result.compared, context: result.context, differences: result.differences.length });
    snapshots[state.name] = result.snapshot;
    for (const row of result.all) everything.push({ state: state.name, ...row });
    if (state.name === 'hub') equationResults.push(...result.equations);
    for (const difference of result.differences) differences.push({ state: state.name, ...difference });
  }
  const outFile = path.join(process.cwd(), 'test-results', 'py-expr-differential.json');
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify({ summary, skipped, differences }, null, 1));
  fs.writeFileSync(path.join(process.cwd(), 'test-results', 'py-expr-differential-states.json'), JSON.stringify(snapshots));
  fs.writeFileSync(path.join(process.cwd(), 'test-results', 'py-expr-differential-all.json'), JSON.stringify({ differences: everything }));
  fs.writeFileSync(path.join(process.cwd(), 'test-results', 'py-expr-differential-equations.json'), JSON.stringify(equationRows(equationResults)));
  console.log(JSON.stringify(summary, null, 1));
});
