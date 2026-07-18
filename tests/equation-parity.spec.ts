/**
 * Equation-evaluator parity tests.
 *
 * Covers the three P4 equation-evaluator defects documented in
 * docs/parity/runtime-inventory.md section 3:
 *
 *  Fix 1 — floor division with compound operands:
 *    The old regex `/(\b[\d.]+)\s*\/\/\s*([\d.]+\b)/g` only matched numeric
 *    literals on both sides, so `(HP - 10)//2` survived and the trailing
 *    `//...` parsed as a JS line comment, silently truncating the expression.
 *    Cases: `LCK//2`, `(HP - 10)//2 + DEF`, `SKL // 4`, nested
 *    `max(5, MAG//2)`, and the full default RATING equation matched against
 *    Python-computed expected values.
 *
 *  Fix 2 — INITIATIVE case mismatch:
 *    `initiative.ts` looks up `'initiative'`; the DB key is `'INITIATIVE'`.
 *    `Database.getEquation` is now case-insensitive (exact, then uppercased).
 *    Regression: an InitiativeTracker sorts a faster unit before a slower one
 *    using the default INITIATIVE=SPD equation, instead of the all-zero
 *    fallback that left insertion order unchanged.
 *
 *  Fix 3 — logical operators in conditions:
 *    `evaluateEquationCondition` now rewrites Python `and`/`or`/`not` to
 *    `&&`/`||`/`!` (word-boundary, so identifiers containing these substrings
 *    are untouched) and uses Python truthiness for the ternary path.
 *    Cases: `'Mounted' in unit.tags and LCK > 3`, `not (HP < 10)`, and the
 *    default RESCUE_AID equation end-to-end with a Mounted and a non-Mounted
 *    unit matching Python-computed values.
 *
 * Equations are imported via `page.evaluate` dynamic import like other specs;
 * the default DEBUG level supplies a real DB with the default equations.json
 * loaded, and Eirika supplies a real UnitObject.
 */

import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';

async function waitForHarness(page: Page): Promise<void> {
  await page.waitForFunction(() => !!(window as any).__harness?.ready, { timeout: 15000 });
}

interface EquationCase {
  expr: string;
  stats: Record<string, number>;
  expected: number;
}

const FLOOR_DIV_CASES: EquationCase[] = [
  // LCK//2 — the original regex handled this (numeric after stat sub), but
  // pin it so a regression to a numeric-only rewrite is caught.
  { expr: 'LCK//2', stats: { LCK: 7 }, expected: 3 },
  { expr: 'LCK//2', stats: { LCK: 8 }, expected: 4 },
  // Compound left operand: the old regex missed this entirely.
  { expr: '(HP - 10)//2 + DEF', stats: { HP: 31, DEF: 8 }, expected: 18 }, // (21//2)+8 = 10+8
  { expr: '(HP - 10)//2 + DEF', stats: { HP: 30, DEF: 8 }, expected: 18 }, // (20//2)+8 = 10+8
  // Whitespace tolerance.
  { expr: 'SKL // 4', stats: { SKL: 10 }, expected: 2 },
  { expr: 'SKL // 4', stats: { SKL: 11 }, expected: 2 },
  // Nested inside a function call.
  { expr: 'max(5, MAG//2)', stats: { MAG: 5 }, expected: 5 }, // max(5, 2)
  { expr: 'max(5, MAG//2)', stats: { MAG: 12 }, expected: 6 }, // max(5, 6)
];

// RATING = (HP - 10)//2 + max(STR, MAG) + SKL + SPD + LCK//2 + DEF + RES
// Python: int((HP-10)//2 + max(STR,MAG) + SKL + SPD + LCK//2 + DEF + RES)
const RATING_STATS = { HP: 31, STR: 12, MAG: 5, SKL: 10, SPD: 11, LCK: 7, DEF: 8, RES: 4 };
// (31-10)//2 = 10; max(12,5)=12; SKL=10; SPD=11; LCK//2=3; DEF=8; RES=4 → 58
const RATING_EXPECTED = 58;

// RESCUE_AID = max(0, 25 - CON) if 'Mounted' in unit.tags else max(0, CON - 1)
const RESCUE_AID_CON = 15;
// Mounted: max(0, 25-15) = 10
const RESCUE_AID_MOUNTED_EXPECTED = 10;
// Non-Mounted: max(0, 15-1) = 14
const RESCUE_AID_DISMOUNTED_EXPECTED = 14;

interface EvalResult {
  ok: boolean;
  value: number | null;
  expected: number;
  expr: string;
}

async function runEquations(page: Page): Promise<{
  floorDiv: EvalResult[];
  rating: EvalResult;
  initiativeLookup: { lower: string | undefined; upper: string | undefined };
  initiativeOrder: { unitLine: string[]; initiativeLine: number[] } | null;
  logical: {
    mountedAndHighLck: boolean;
    mountedAndLowLck: boolean;
    notMountedAndHighLck: boolean;
    notLowHp: boolean;
    notHighHp: boolean;
  };
  rescueAid: { mounted: number | null; dismounted: number | null };
  dbHasEquations: boolean;
}> {
  return page.evaluate(async (cfg: {
    floorDivCases: EquationCase[];
    ratingStats: Record<string, number>;
    ratingExpected: number;
    rescueAidCon: number;
  }) => {
    const g = (window as any).__gameRef;
    const eirika = g?.units?.get?.('Eirika');
    const bone = g?.units?.get?.('Bone');
    if (!g?.db || !eirika || !bone) {
      return {
        floorDiv: [],
        rating: { ok: false, value: null, expected: cfg.ratingExpected, expr: '' },
        initiativeLookup: { lower: undefined, upper: undefined },
        initiativeOrder: null,
        logical: {
          mountedAndHighLck: false,
          mountedAndLowLck: false,
          notMountedAndHighLck: false,
          notLowHp: false,
          notHighHp: false,
        },
        rescueAid: { mounted: null, dismounted: null },
        dbHasEquations: false,
      };
    }

    const { evaluateEquation, evaluateEquationCondition } = await import(
      '/src/combat/combat-calcs.ts'
    );
    const { InitiativeTracker } = await import('/src/engine/initiative.ts');
    const db = g.db;
    const ctx = { db };

    // Save and restore Eirika's stats so tests are isolated.
    const savedStats = { ...eirika.stats };
    const savedTags = [...eirika.tags];
    function setStats(stats: Record<string, number>): void {
      for (const k of Object.keys(eirika.stats)) delete eirika.stats[k];
      for (const [k, v] of Object.entries(stats)) eirika.stats[k] = v;
    }
    function restore(): void {
      for (const k of Object.keys(eirika.stats)) delete eirika.stats[k];
      Object.assign(eirika.stats, savedStats);
      eirika.tags = [...savedTags];
    }

    // --- Fix 1: floor division with compound operands ---
    const floorDiv: EvalResult[] = cfg.floorDivCases.map((c) => {
      setStats(c.stats);
      const value = evaluateEquation(c.expr, eirika, ctx);
      return { ok: value === c.expected, value, expected: c.expected, expr: c.expr };
    });

    // --- Fix 1: full RATING default equation ---
    setStats(cfg.ratingStats);
    const ratingExpr = db.getEquation('RATING');
    const ratingValue = ratingExpr ? evaluateEquation(ratingExpr, eirika, ctx) : null;
    const rating: EvalResult = {
      ok: ratingValue === cfg.ratingExpected,
      value: ratingValue,
      expected: cfg.ratingExpected,
      expr: ratingExpr ?? '',
    };

    // --- Fix 2: INITIATIVE case-insensitive lookup ---
    const initiativeLookup = {
      lower: db.getEquation('initiative'),
      upper: db.getEquation('INITIATIVE'),
    };

    // Initiative ordering: Eirika SPD=15 should precede Bone SPD=8.
    const savedESpd = eirika.stats.SPD;
    const savedBSpd = bone.stats.SPD;
    eirika.stats.SPD = 15;
    bone.stats.SPD = 8;
    const tracker = new InitiativeTracker();
    tracker.start([eirika, bone], db);
    const initiativeOrder = {
      unitLine: [...tracker.unitLine],
      initiativeLine: [...tracker.initiativeLine],
    };
    eirika.stats.SPD = savedESpd;
    bone.stats.SPD = savedBSpd;

    // --- Fix 3: logical operators ---
    setStats({ LCK: 7, HP: 31 });
    eirika.tags = ['Mounted'];
    const mountedAndHighLck = evaluateEquationCondition(
      "'Mounted' in unit.tags and LCK > 3",
      eirika,
      ctx,
    );
    setStats({ LCK: 2, HP: 31 });
    const mountedAndLowLck = evaluateEquationCondition(
      "'Mounted' in unit.tags and LCK > 3",
      eirika,
      ctx,
    );
    eirika.tags = [];
    setStats({ LCK: 7, HP: 31 });
    const notMountedAndHighLck = evaluateEquationCondition(
      "'Mounted' in unit.tags and LCK > 3",
      eirika,
      ctx,
    );
    setStats({ HP: 31 });
    const notLowHp = evaluateEquationCondition('not (HP < 10)', eirika, ctx);
    setStats({ HP: 5 });
    const notHighHp = evaluateEquationCondition('not (HP < 10)', eirika, ctx);

    // --- Fix 3: RESCUE_AID default equation end-to-end ---
    const rescueAidExpr = db.getEquation('RESCUE_AID');
    setStats({ CON: cfg.rescueAidCon });
    eirika.tags = ['Mounted'];
    const rescueMounted = rescueAidExpr
      ? evaluateEquation(rescueAidExpr, eirika, ctx)
      : null;
    eirika.tags = [];
    const rescueDismounted = rescueAidExpr
      ? evaluateEquation(rescueAidExpr, eirika, ctx)
      : null;

    restore();

    return {
      floorDiv,
      rating,
      initiativeLookup,
      initiativeOrder,
      logical: {
        mountedAndHighLck,
        mountedAndLowLck,
        notMountedAndHighLck,
        notLowHp,
        notHighHp,
      },
      rescueAid: { mounted: rescueMounted, dismounted: rescueDismounted },
      dbHasEquations: db.getEquationNames().length > 0,
    };
  }, {
    floorDivCases: FLOOR_DIV_CASES,
    ratingStats: RATING_STATS,
    ratingExpected: RATING_EXPECTED,
    rescueAidCon: RESCUE_AID_CON,
  });
}

test.describe('Equation evaluator parity', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/?harness=true&level=DEBUG&bundle=false');
    await waitForHarness(page);
    await page.evaluate((n) => (window as any).__harness.stepFrames(n, null), 5);
  });

  // ------------------------------------------------------------------
  // Fix 1 — floor division with compound operands
  // ------------------------------------------------------------------

  test('floor division handles compound and nested operands', async ({ page }) => {
    const res = await runEquations(page);
    expect(res.dbHasEquations, 'DB equations loaded').toBe(true);
    const failures = res.floorDiv.filter((r) => !r.ok);
    expect(failures, JSON.stringify(failures, null, 2)).toEqual([]);
  });

  test('default RATING equation matches Python-computed value', async ({ page }) => {
    const res = await runEquations(page);
    expect(res.rating.value, `RATING "${res.rating.expr}"`).toBe(RATING_EXPECTED);
    expect(res.rating.ok).toBe(true);
  });

  // ------------------------------------------------------------------
  // Fix 2 — INITIATIVE case-insensitive lookup + ordering
  // ------------------------------------------------------------------

  test('getEquation resolves lowercase initiative to the INITIATIVE equation', async ({ page }) => {
    const res = await runEquations(page);
    expect(res.initiativeLookup.lower).toBe('SPD');
    expect(res.initiativeLookup.upper).toBe('SPD');
  });

  test('InitiativeTracker orders faster unit first via INITIATIVE=SPD', async ({ page }) => {
    const res = await runEquations(page);
    expect(res.initiativeOrder, 'tracker produced an order').not.toBeNull();
    const order = res.initiativeOrder!;
    // Eirika (SPD=15) must precede Bone (SPD=8). The pre-fix bug left both
    // initiatives at 0 (fallback), so the sort was a no-op and Bone (second
    // in the input array) stayed second only by accident — but more
    // importantly the initiativeLine was [0, 0] instead of [15, 8].
    expect(order.initiativeLine).toEqual([15, 8]);
    expect(order.unitLine[0]).toBe('Eirika');
    expect(order.unitLine[1]).toBe('Bone');
  });

  // ------------------------------------------------------------------
  // Fix 3 — logical operators in conditions
  // ------------------------------------------------------------------

  test("evaluateEquationCondition handles 'and' with tag membership", async ({ page }) => {
    const res = await runEquations(page);
    const L = res.logical;
    expect(L.mountedAndHighLck, 'Mounted + LCK 7 > 3').toBe(true);
    expect(L.mountedAndLowLck, 'Mounted + LCK 2 > 3').toBe(false);
    expect(L.notMountedAndHighLck, 'no Mounted tag').toBe(false);
  });

  test("evaluateEquationCondition handles 'not' with parenthesised condition", async ({ page }) => {
    const res = await runEquations(page);
    const L = res.logical;
    expect(L.notLowHp, 'not (HP 31 < 10) -> true').toBe(true);
    expect(L.notHighHp, 'not (HP 5 < 10) -> false').toBe(false);
  });

  test('default RESCUE_AID equation matches Python for Mounted and dismounted', async ({ page }) => {
    const res = await runEquations(page);
    expect(res.rescueAid.mounted, 'Mounted CON 15').toBe(RESCUE_AID_MOUNTED_EXPECTED);
    expect(res.rescueAid.dismounted, 'dismounted CON 15').toBe(RESCUE_AID_DISMOUNTED_EXPECTED);
  });
});
