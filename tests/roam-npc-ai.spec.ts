/**
 * Free-roam NPC AI (Python roam/free_roam_ai.py RoamAI) behaviours beyond
 * EOtF's Follow_Player Move_to, which roam-movement.spec.ts covers:
 *  - Move_away_from walks to the farthest valid move from its targets;
 *  - Interact walks into an event region and fires it (only_once regions
 *    are removed).
 */
import { expect, test, type Page } from '@playwright/test';

test.describe.configure({ mode: 'parallel' });

async function boot(page: Page): Promise<void> {
  await page.goto('/?harness=true&level=DEBUG&clean=true&bundle=false');
  await page.waitForFunction(() => (window as any).__harness?.ready === true, undefined, {
    timeout: 60_000,
  });
  await page.evaluate(() => (window as any).__harness.stepFrames(5, null));
}

/** Places Eirika (the roamer) and one other unit, gives that unit `ai`, enters free_roam. */
async function setup(page: Page, opts: {
  roamer: [number, number];
  npc: [number, number];
  behaviour: Record<string, unknown>;
  region?: Record<string, unknown>;
  event?: Record<string, unknown>;
}): Promise<string> {
  return page.evaluate((opts) => {
    const game = (window as any).__gameRef;
    const eirika = game.units.get('Eirika');
    const npc = [...game.units.values()].find((u: any) => u !== eirika && u.position && !u.isDead());
    const place = (unit: any, [x, y]: [number, number]) => {
      game.board.removeUnit(unit);
      unit.position = [x, y];
      game.board.setUnit(x, y, unit);
    };
    // Clear the destination tiles first so the moves never collide.
    for (const pos of [opts.roamer, opts.npc]) {
      const other = game.board.getUnit(pos[0], pos[1]);
      if (other && other !== eirika && other !== npc) place(other, [0, 0]);
    }
    place(eirika, opts.roamer);
    place(npc, opts.npc);
    if (opts.region) game.currentLevel.regions.push(opts.region);
    if (opts.event) game.db.events.set(opts.event.nid, opts.event);
    game.db.ai.set('_Roam_Test', {
      nid: '_Roam_Test',
      behaviours: [{
        view_range: -4, invert_targeting: false, roam_speed: 200, condition: '', ...opts.behaviour,
      }],
      priority: 20,
      offense_bias: 0,
      roam_ai: true,
    });
    npc.roamAi = '_Roam_Test';
    game.roamInfo.roam = true;
    game.roamInfo.roamUnitNid = 'Eirika';
    game.state.change('free_roam');
    return npc.nid;
  }, opts);
}

test('Move_away_from retreats from its target', async ({ page }) => {
  await boot(page);
  const nid = await setup(page, {
    roamer: [4, 5],
    npc: [5, 5],
    behaviour: { action: 'Move_away_from', target: 'Unit', target_spec: ['ID', 'Eirika'], desired_proximity: 0 },
  });
  const result = await page.evaluate((nid) => {
    const game = (window as any).__gameRef;
    (window as any).__harness.stepFrames(120, null);
    const unit = game.units.get(nid);
    const eirika = game.units.get('Eirika');
    return {
      state: game.state.getCurrentState()?.name,
      ai: game.state.getCurrentState()?.aiHandler?.containsUnit(unit),
      dist: Math.abs(unit.position[0] - eirika.position[0]) + Math.abs(unit.position[1] - eirika.position[1]),
    };
  }, nid);
  expect(result.state).toBe('free_roam');
  expect(result.ai).toBe(true);
  expect(result.dist).toBeGreaterThan(1);
});

test('Interact walks into an event region and fires it', async ({ page }) => {
  await boot(page);
  const nid = await setup(page, {
    roamer: [1, 1],
    npc: [4, 5],
    behaviour: { action: 'Interact', target: 'Event', target_spec: 'RoamSwitch', desired_proximity: 0 },
    region: {
      nid: '_roam_ai_test_region', region_type: 'event', position: [6, 5], size: [1, 1],
      sub_nid: 'RoamSwitch', condition: '', only_once: true, interrupt_move: false,
    },
    event: {
      nid: '_test_roam_switch', name: '_test_roam_switch', trigger: 'RoamSwitch', level_nid: null,
      condition: 'True', only_once: false, priority: 0,
      _source: ['game_var;_roam_switch_fired;1'],
    },
  });
  const result = await page.evaluate((nid) => {
    const game = (window as any).__gameRef;
    const h = (window as any).__harness;
    let fired = false;
    for (let i = 0; i < 300 && !fired; i++) {
      h.stepFrames(1, null);
      fired = game.gameVars.get('_roam_switch_fired') != null;
    }
    h.stepFrames(10, null);
    return {
      fired: game.gameVars.get('_roam_switch_fired') ?? null,
      regionLeft: game.currentLevel.regions.some((r: any) => r.nid === '_roam_ai_test_region'),
      npc: game.units.get(nid).position,
    };
  }, nid);
  expect(result.fired).toBe(1);
  expect(result.regionLeft).toBe(false);
});
