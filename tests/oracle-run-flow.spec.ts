/**
 * Behaviour found by the differential oracle's EOtF run-start scenario
 * (tools/oracle/scenarios/eotf-run-start.json), checked against upstream
 * lt-maker and the EOtF engine fork, which agree here:
 *
 * - GameState.arrive decides ignore_terrain / ignore_region_status when a
 *   unit arrives. A unit that gains a terrain-ignoring skill in place (a
 *   generated enemy class-changed into a flier) keeps its tile status until
 *   it arrives again; PrimaryAI.run's closing quick_move(orig_pos) is such an
 *   arrival, so the status goes once the AI has evaluated the unit.
 * - EventState.level_end keeps _prev_level_nid in game.memory and records
 *   _should_go_to_overworld in the game vars.
 * - The fork's prep command sets no _prep_options_info_descs (upstream does).
 * - GameState.load re-seeds static_random and restores only the combat
 *   stream, so growth and "other" streams restart after every load.
 * - cf.SETTINGS['random_seed'] fixes the seed of every New Game.
 */

import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { projectInstalled } from './helpers/project-data';

async function boot(page: Page, query: string): Promise<void> {
  await page.goto(`/?harness=true&clean=true&bundle=false&${query}`);
  await page.waitForFunction(() => !!(window as any).__harness?.ready, null, { timeout: 120_000 });
}

async function runScript(page: Page, lines: string[], frames = 600): Promise<void> {
  await page.evaluate((source) => {
    const g = (window as any).__gameRef;
    const nid = `OracleRunFlow${Math.random()}`;
    g.db.events.set(nid, {
      name: nid, nid, trigger: nid, level_nid: g.currentLevel?.nid ?? null,
      condition: 'True', only_once: false, priority: 0, _source: source,
    });
    g.eventManager.triggerSpecific(nid, { type: nid }, true);
    g.state.change('event');
  }, lines);
  await page.evaluate((n) => (window as any).__harness.settle(n, ['free', 'free_roam', 'prep_main']), frames);
}

test.describe('Oracle run-start findings', () => {
  test('terrain statuses are decided on arrival, and AI evaluation re-arrives the unit', async ({ page }) => {
    await boot(page, 'project=default.ltproj&level=DEBUG');
    const result = await page.evaluate(async () => {
      const g = (window as any).__gameRef;
      const { SkillObject } = await import('/src/objects/skill.ts');
      const ignore = () => new SkillObject({ nid: '_IgnoreTerrain', name: 'Ignore terrain', desc: '', components: [['ignore_terrain', null]] });
      const has = (u: any) => u.skills.some((s: any) => s.nid === 'Forest');
      const seth = g.units.get('Seth');
      const bone = g.units.get('Bone');
      const out: Record<string, boolean> = { sethStart: has(seth), boneStart: has(bone) };
      seth.skills.push(ignore());
      bone.skills.push(ignore());
      g.refreshPositionSkills();
      out.sethAfterGain = has(seth);
      out.boneAfterGain = has(bone);
      g.board.reArrive(seth);
      out.sethAfterArrive = has(seth);
      bone.ai = 'Attack';
      (window as any).__harness.aiGetAction('Bone');
      out.boneAfterAi = has(bone);
      return out;
    });
    expect(result).toEqual({
      sethStart: true, boneStart: true,
      sethAfterGain: true, boneAfterGain: true,
      sethAfterArrive: false, boneAfterAi: false,
    });
  });

  test('level_end keeps _prev_level_nid in memory and records _should_go_to_overworld', async ({ page }) => {
    await boot(page, 'project=default.ltproj&level=0');
    await runScript(page, ['win_game'], 4000);
    const result = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      return {
        level: g.currentLevel?.nid,
        memory: g.memory.get('_prev_level_nid'),
        gameVar: g.gameVars.has('_prev_level_nid'),
        overworld: g.gameVars.get('_should_go_to_overworld'),
      };
    });
    expect(result).toEqual({ level: '1', memory: '0', gameVar: false, overworld: false });
  });

  test('prep option descriptions: upstream sets them, the EOtF fork does not', async ({ page }) => {
    test.skip(!projectInstalled('eotf.ltproj'), 'EOtF project not installed');
    await boot(page, 'project=default.ltproj&level=DEBUG');
    await runScript(page, ['prep'], 300);
    expect(await page.evaluate(() => (window as any).__gameRef.gameVars.get('_prep_options_info_descs'))).toEqual([]);
    await boot(page, 'project=eotf.ltproj&level=1');
    await runScript(page, ['prep'], 300);
    expect(await page.evaluate(() => (window as any).__gameRef.gameVars.has('_prep_options_info_descs'))).toBe(false);
  });

  test('a load restarts the growth and other streams but keeps the combat stream', async ({ page }) => {
    await boot(page, 'project=default.ltproj&level=DEBUG&seed=4');
    const result = await page.evaluate(async () => {
      const g = (window as any).__gameRef;
      const rng = await import('/src/engine/static-random.ts');
      const save = await import('/src/engine/save.ts');
      rng.getCombatRandom(g);
      rng.getGrowthRandom(g);
      g.gameVars.set('_other_random_seed', 4);
      g.gameVars.set('_other_random_state', 12345);
      const combat = rng.getCombatRandomState(g);
      await save.suspendGame(g);
      const loaded = await save.loadSuspend(g);
      return {
        loaded,
        combatKept: rng.getCombatRandomState(g) === combat && combat !== 4,
        growth: rng.getGrowthRandomState(g),
        other: g.gameVars.has('_other_random_state'),
      };
    });
    expect(result).toEqual({ loaded: true, combatKept: true, growth: null, other: false });
  });

  test('a fixed random seed applies to every New Game', async ({ page }) => {
    await boot(page, 'project=default.ltproj&level=DEBUG&seed=9');
    const seeds = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      g.buildNew();
      const first = g.gameVars.get('_random_seed');
      g.buildNew();
      return [first, g.gameVars.get('_random_seed')];
    });
    expect(seeds).toEqual([9, 9]);
  });
});
