/**
 * expression-scope.spec.ts — the per-evaluation expression scope
 * (event-manager.ts buildEvalScope / PyUnitView): unit views snapshot their
 * plain fields at wrap time, expose memoized accessors and detached-callable
 * methods, fall back to prefab data, read as plain 'object' in errors, and
 * the lazily built game proxy behaves like the eager one did.
 */

import { expect, test } from '@playwright/test';

test.describe('expression scope', () => {
  test('unit views, lazy game proxy and RECORDS evaluate like Python', async ({ page }) => {
    await page.goto('/?harness=true&project=default.ltproj&level=0&clean=true&bundle=false');
    await page.waitForFunction(() => (window as any).__harness?.ready === true, undefined, { timeout: 60_000 });
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const em = await import('/src/events/event-manager.ts');
      const unit = [...game.units.values()].find((u: any) => u.position && u.team === 'player');
      const ctx = { game, unit1: unit, gameVars: game.gameVars, levelVars: game.levelVars };
      const ev = (expression: string) => {
        const outcome = em.evaluatePythonInContext(expression, ctx);
        return outcome.ok ? outcome.value : `ERR ${String((outcome.error as any)?.message ?? outcome.error)}`;
      };
      game.gameVars.set('qa_scope_var', 7);
      return {
        nid: ev('unit.nid'),
        team: ev('unit.team'),
        hp: ev('unit.get_hp() == unit.current_hp'),
        maxHp: ev('unit.get_max_hp() == unit.max_hp'),
        stat: ev("unit.get_stat('STR') >= 0"),
        // A method read once and called later still works (detached call).
        detached: ev('[f() for f in [unit.get_hp]][0] == unit.current_hp'),
        sameView: ev("u('" + unit.nid + "') is unit"),
        skillsLen: ev('len(unit.skills)') === unit.skills.length,
        tagsList: Array.isArray(ev('unit.tags')),
        // Python UnitObject.__getattr__ prefab fallback (portrait_nid is a getter,
        // 'desc' a snapshot field, prefab-only fields resolve too).
        prefabField: ev('unit.portrait_nid') === (unit.generic ? null : (unit.portraitNid ?? null)),
        missing: ev('unit.qa_no_such_attribute_xyz'),
        gameVar: ev("game.game_vars.get('qa_scope_var')"),
        turn: ev('game.turncount') === game.turnCount,
        regionsStable: ev('game.level.regions is game.level.regions'),
        levelNid: ev('game.level.nid') === game.currentLevel.nid,
        records: ev("RECORDS.get('qa_missing_record', 3)"),
        targetSystem: ev('game.target_system is target_system'),
        condition: em.evaluateCondition("unit.team == 'player' and v('qa_scope_var') == 7", ctx),
      };
    });
    expect(result).toMatchObject({
      team: 'player',
      hp: true,
      maxHp: true,
      stat: true,
      detached: true,
      sameView: true,
      skillsLen: true,
      tagsList: true,
      prefabField: true,
      gameVar: 7,
      turn: true,
      regionsStable: true,
      levelNid: true,
      records: 3,
      targetSystem: true,
      condition: true,
    });
    expect(typeof result.nid).toBe('string');
    // Missing host attributes read as None-like (prefab fallback returns undefined),
    // never as a crash.
    expect(String(result.missing)).not.toMatch(/TypeError|Cannot read/);
  });
});
