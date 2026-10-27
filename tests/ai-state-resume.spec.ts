/**
 * AIState across the states it pushes (combat, wait, event).
 *
 * Python AIState.start resets cur_unit/cur_group once per activation and
 * has_run_ai lives until AIState.finish at the end of the phase; begin(),
 * which runs again whenever a pushed state pops back, only fades the phase
 * music in. AIController.attack hands goal_item straight to start_combat,
 * so an AI may fight with a skill's no_equip ability weapon.
 *
 * Found by the QA sweep (EOtF Act 1, Fistfighting stratagem): a Cleric's
 * only weapon was the skill-granted Haymaker; the combat found no equipped
 * weapon and ended at once, and AIState.begin cleared has_run_ai, so the
 * same unit attacked again forever (34k combats on one turn).
 */

import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';

async function stepFrames(page: Page, count: number): Promise<void> {
  await page.evaluate((frames) => (window as any).__harness.stepFrames(frames, null), count);
}

/** One enemy next to Eirika, the other enemies removed, combats counted. */
async function setup(page: Page, opts: { ability: boolean; canto: boolean }) {
  return page.evaluate(async ({ ability, canto }) => {
    const g = (window as any).__gameRef;
    const h = (window as any).__harness;
    const { SkillObject } = await import('/src/objects/skill.ts');
    const { ItemObject } = await import('/src/objects/item.ts');
    const eirika = g.units.get('Eirika');
    const enemies = [...g.units.values()].filter((u: any) => u.position && u.team !== 'player' && !u.isDead());
    const unit = enemies[0];
    for (const other of enemies.slice(1)) g.board.removeUnit(other);
    const spot = [[1, 0], [-1, 0], [0, 1], [0, -1]]
      .map(([dx, dy]) => [eirika.position[0] + dx, eirika.position[1] + dy])
      .find(([x, y]) => g.board.inBounds(x, y) && !g.board.getUnit(x, y));
    h.warpUnit(unit.nid, spot[0], spot[1]);
    unit.resetTurnState();
    unit.level = 20;
    eirika.level = 20;

    const components: [string, unknown][] = [
      ['weapon', null], ['target_enemy', null], ['damage', 3], ['hit', 255],
      ['min_range', 1], ['max_range', 1], ['cannot_counter', null],
    ];
    if (ability) components.push(['no_equip', null]);
    g.db.items.set('_ResumeFist', {
      nid: '_ResumeFist', name: '_ResumeFist', desc: '', icon_nid: '', icon_index: [0, 0], components,
    });
    let item: any;
    if (ability) {
      // A skill's extra ability: not in the inventory and never equipped.
      unit.items = [];
      unit.equippedWeapon = null;
      item = new ItemObject(g.db.items.get('_ResumeFist'));
      item.owner = unit;
    } else {
      h.giveItem(unit.nid, '_ResumeFist');
      item = unit.items[0];
    }
    unit.skills = canto
      ? [new SkillObject({ nid: '_ResumeCanto', name: '_ResumeCanto', desc: '', icon_nid: '', icon_index: [0, 0], components: [['canto_plus', null]] } as any)]
      : [];

    const start = [...unit.position];
    const dest = [[1, 0], [-1, 0], [0, 1], [0, -1]]
      .map(([dx, dy]) => [start[0] + dx, start[1] + dy])
      .find(([x, y]) => g.board.inBounds(x, y) && !g.board.getUnit(x, y));
    let asked = 0;
    g.aiController.getAction = (u: any) => {
      asked++;
      return u === unit
        ? { type: 'attack', unit: u, targetUnit: eirika, targetPosition: [...u.position], movePath: [[...u.position]], item }
        : { type: 'wait', unit: u };
    };
    g.aiController.getCantoRetreatAction = (u: any) =>
      (u === unit && dest ? { type: 'move', unit: u, targetPosition: dest, movePath: [start, dest] } : null);

    let combats = 0;
    const change = g.state.change.bind(g.state);
    g.state.change = (name: string) => {
      if (name === 'combat') combats++;
      return change(name);
    };
    (window as any).__resume = { unit, eirika, start, dest, hp: eirika.currentHp, combats: () => combats, asked: () => asked };
    g.phase.setCurrentTeam(unit.team);
    g.state.clear();
    g.state.change('ai');
    return !!dest;
  }, opts);
}

async function runPhase(page: Page) {
  for (let i = 0; i < 200; i++) {
    await stepFrames(page, 3);
    const done = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      return !g.state.getStackNames().includes('ai') || (window as any).__resume.combats() > 3;
    });
    if (done) break;
  }
  return page.evaluate(() => {
    const r = (window as any).__resume;
    const at = r.unit.position;
    return {
      combats: r.combats(),
      asked: r.asked(),
      damaged: r.eirika.currentHp < r.hp,
      moved: !!at && at[0] === r.dest[0] && at[1] === r.dest[1],
    };
  });
}

test.describe('AIState resume', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/?harness=true&level=DEBUG&bundle=false');
    await page.waitForFunction(() => !!(window as any).__harness?.ready, { timeout: 15000 });
  });

  test('AI fights with a no_equip skill ability weapon once', async ({ page }) => {
    expect(await setup(page, { ability: true, canto: false })).toBe(true);
    const result = await runPhase(page);
    expect(result).toMatchObject({ combats: 1, asked: 1, damaged: true });
  });

  test('AI canto step runs after a real combat pops back to the AI', async ({ page }) => {
    expect(await setup(page, { ability: false, canto: true })).toBe(true);
    const result = await runPhase(page);
    expect(result).toMatchObject({ combats: 1, asked: 1, damaged: true, moved: true });
  });
});
