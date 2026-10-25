import { test, expect, type Page } from '@playwright/test';

/** Python progression semantics for autolevel_to, promote, and internal levels. */

test.describe.configure({ mode: 'parallel' });

async function boot(page: Page): Promise<void> {
  await page.goto('/?harness=true&level=DEBUG&bundle=false');
  await page.waitForFunction(() => (window as any).__harness?.ready === true, undefined, {
    timeout: 60_000,
  });
  await page.evaluate(() => (window as any).__harness.stepFrames(5, null));
}

async function runEvent(page: Page, nid: string, source: string[]): Promise<void> {
  await page.evaluate(({ nid, source }) => {
    const g = (window as any).__gameRef;
    g.db.events.set(nid, {
      name: nid, nid, trigger: nid, level_nid: g.currentLevel?.nid ?? null,
      condition: 'True', only_once: false, priority: 0, _source: source,
    });
    g.eventManager.triggerSpecific(nid, { type: nid }, true);
    g.state.change('event');
  }, { nid, source });
  for (let i = 0; i < 20; i += 1) {
    await page.evaluate(() => (window as any).__harness.stepFrames(10, 'SELECT'));
  }
}

test.describe('Progression parity', () => {
  test('autolevel_to runs triggered unit_level_up events before resuming', async ({ page }) => {
    await boot(page);
    const level = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      g.db.events.set('QaLevelUp', {
        name: 'QaLevelUp', nid: 'QaLevelUp', trigger: 'unit_level_up', level_nid: null,
        condition: "unit.nid == 'Eirika'", only_once: false, priority: 20,
        _source: ['game_var;qa_level_up_ran;1'],
      });
      return g.units.get('Eirika').level;
    });
    await runEvent(page, 'QaAutolevel', [
      `autolevel_to;Eirika;${level + 1};fixed`,
      "game_var;qa_after;{e:game.game_vars.get('qa_level_up_ran', 0)}",
    ]);
    const after = await page.evaluate(() => (window as any).__gameRef.gameVars.get('qa_after'));
    expect(String(after)).toBe('1');
  });

  test('silent promotion learns only class skills at the exact level', async ({ page }) => {
    await boot(page);
    await page.evaluate(() => {
      // EOtF keeps the level on promotion (promote_level_reset False).
      (window as any).__harness.setConstant('promote_level_reset', false);
      const eirika = (window as any).__gameRef.units.get('Eirika');
      eirika.level = 5;
      eirika.skills = eirika.skills.filter((skill: any) => skill.nid !== 'Canto');
    });
    await runEvent(page, 'QaSilentPromote', ['promote;Eirika;Eirika_Great_Lord;silent']);
    const silent = await page.evaluate(() => {
      const eirika = (window as any).__gameRef.units.get('Eirika');
      return { klass: eirika.klass, canto: eirika.skills.some((skill: any) => skill.nid === 'Canto') };
    });
    // Eirika_Great_Lord learns Canto at level 1; a level-5 silent promote
    // does not pick it up (Python event_functions.promote).
    expect(silent).toEqual({ klass: 'Eirika_Great_Lord', canto: false });
  });

  test('internal level adds every promoted-from class max level', async ({ page }) => {
    await boot(page);
    const result = await page.evaluate(async () => {
      const g = (window as any).__gameRef;
      const { getInternalLevel } = await import('/src/engine/leveling.ts');
      const seth = g.units.get('Seth');
      const klass = g.db.classes.get(seth.klass);
      const base = g.db.classes.get(klass.promotes_from);
      return {
        tier: klass.tier,
        internal: getInternalLevel(seth, g.db),
        expected: seth.level + (base?.max_level ?? 0),
      };
    });
    expect(result.tier).toBe(2);
    expect(result.internal).toBe(result.expected);
  });
});
