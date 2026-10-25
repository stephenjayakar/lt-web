import { test, expect, type Page } from '@playwright/test';

/** Python prep command + PrepMainState.populate_options parity. */

async function boot(page: Page): Promise<void> {
  await page.goto('/?harness=true&level=0&clean=true&bundle=false');
  await page.waitForFunction(() => (window as any).__harness?.ready === true, undefined, {
    timeout: 60_000,
  });
  await page.evaluate(() => (window as any).__harness.stepFrames(3, null));
}

test.describe('Prep main menu options', () => {
  test('prep inserts authored options before Options and runs their events', async ({ page }) => {
    await boot(page);
    await page.evaluate(() => {
      const g = (window as any).__gameRef;
      g.db.events.set('QaSealCheck', {
        name: 'QaSealCheck', nid: 'QaSealCheck', trigger: '', level_nid: null,
        condition: 'True', only_once: false, priority: 20,
        _source: ['game_var;qa_seals_checked;1'],
      });
      // EOtF's form: pick units on, no music, one extra option and its event.
      g.db.events.set('QaPrep', {
        name: 'QaPrep', nid: 'QaPrep', trigger: 'QaPrep', level_nid: null,
        condition: 'True', only_once: false, priority: 0,
        _source: ['prep;t;;Check Seals,Locked;true,false;QaSealCheck'],
      });
      g.eventManager.triggerSpecific('QaPrep', { type: 'QaPrep' }, true);
      g.state.change('event');
      (window as any).__harness.stepFrames(6, null);
    });
    const menu = await page.evaluate(() => {
      const state = (window as any).__gameRef.state.getCurrentState() as any;
      return { name: state?.name, options: state?.options, disabled: state?.disabled };
    });
    expect(menu.name).toBe('prep_main');
    expect(menu.options).toEqual([
      'Pick Units', 'Manage', 'Formation', 'Check Seals', 'Locked', 'Options', 'Save', 'Fight',
    ]);
    expect(menu.disabled).toEqual([false, false, false, false, true, false, false, false]);

    const result = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const state = g.state.getCurrentState() as any;
      // A disabled option does nothing.
      state.cursor = state.options.indexOf('Locked');
      (window as any).__harness.stepFrames(1, 'SELECT');
      const afterLocked = g.state.getCurrentState()?.name;
      state.cursor = state.options.indexOf('Check Seals');
      (window as any).__harness.stepFrames(1, 'SELECT');
      for (let frame = 0; frame < 30 && !g.gameVars.get('qa_seals_checked'); frame += 1) {
        (window as any).__harness.stepFrames(1, null);
      }
      return { afterLocked, checked: g.gameVars.get('qa_seals_checked') };
    });
    expect(result.afterLocked).toBe('prep_main');
    expect(result.checked).toBe(1);
  });

  test('Pick Units requires the prep flag and party queries exclude non-persistent units', async ({ page }) => {
    await boot(page);
    const result = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      g.levelVars.delete('_prep_pick');
      g.state.change('prep_main');
      (window as any).__harness.stepFrames(2, null);
      const options = [...(g.state.getCurrentState() as any).options];
      const seth = g.units.get('Seth');
      const before = g.getUnitsInParty().map((unit: any) => unit.nid);
      seth.persistent = false;
      const after = g.getUnitsInParty().map((unit: any) => unit.nid);
      seth.persistent = true;
      return { options, before, after };
    });
    expect(result.options[0]).toBe('Manage');
    expect(result.options).not.toContain('Pick Units');
    expect(result.before).toContain('Seth');
    expect(result.after).not.toContain('Seth');
  });
});
