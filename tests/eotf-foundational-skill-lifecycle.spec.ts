import { expect, test, type Page } from '@playwright/test';

async function bootEotf(page: Page): Promise<void> {
  await page.goto('/?harness=true&project=eotf.ltproj&level=X&clean=true&bundle=false');
  await page.waitForFunction(() => (window as any).__harness?.ready === true, undefined, {
    timeout: 30_000,
  });
}

test.describe('Embrace of the Fog foundational skill lifecycle', () => {
  test('count-locks all 3,421 authored metadata and chapter-charge uses', async ({ page }) => {
    await bootEotf(page);
    const counts = await page.evaluate(() => {
      const game = (window as any).__gameRef;
      const selected = new Set([
        'build_charge',
        'charges_per_turn',
        'class_skill',
        'drain_charge',
        'hidden',
        'lost_on_end_chapter',
      ]);
      const result: Record<string, number> = {};
      for (const skill of game.db.skills.values()) {
        for (const [nid] of skill.components) {
          if (selected.has(nid)) result[nid] = (result[nid] ?? 0) + 1;
        }
      }
      return result;
    });

    expect(counts).toEqual({
      build_charge: 7,
      charges_per_turn: 21,
      class_skill: 1651,
      drain_charge: 540,
      hidden: 678,
      lost_on_end_chapter: 524,
    });
  });

  test('orders visible class skills and reversibly resets chapter charges', async ({ page }) => {
    await bootEotf(page);
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { SkillObject } = await import('/src/objects/skill.ts');
      const { triggerSkillCharge } = await import('/src/combat/combat-lifecycle.ts');
      const {
        skillInfoPresentation,
        visibleSkillsForInfoMenu,
      } = await import('/src/engine/states/info-menu-state.ts');
      const unit = game.units.get('Player');
      if (!unit) return null;
      const make = (nid: string, components: [string, unknown][]) => new SkillObject({
        nid,
        name: nid,
        desc: '',
        icon_nid: '',
        icon_index: [0, 0],
        components,
      });
      const ordinary = make('_Ordinary', []);
      const hidden = make('_Hidden', [['hidden', null]]);
      const drain = make('_Drain', [['drain_charge', 3]]);
      const classSkill = make('_Class', [['class_skill', null]]);
      const perTurn = make('_PerTurn', [['charges_per_turn', 2]]);
      const build = make('_Build', [['build_charge', 4]]);
      const temporary = make('_Temporary', [['lost_on_end_chapter', null]]);
      const oldSkills = unit.skills;
      const oldUnits = game.units;
      unit.skills = [ordinary, hidden, drain, classSkill, perTurn, build, temporary];
      game.units = new Map([[unit.nid, unit]]);
      for (const skill of unit.skills) skill.ownerNid = unit.nid;

      triggerSkillCharge(game, drain, unit);
      triggerSkillCharge(game, build, unit);
      perTurn.data.set('charge', 0);
      const beforeChapter = game.actionLog.actionIndex;
      const effects = game.applySkillEndChapterHooks();
      const snapshot = () => ({
        drain: drain.data.get('charge'),
        perTurn: perTurn.data.get('charge'),
        build: build.data.get('charge'),
        temporary: unit.skills.includes(temporary),
      });
      const applied = snapshot();
      const finalIndex = game.actionLog.actionIndex;
      while (game.actionLog.actionIndex > beforeChapter) {
        game.actionLog.runActionBackward();
      }
      const reversed = snapshot();
      while (game.actionLog.actionIndex < finalIndex) {
        game.actionLog.runActionForward();
      }
      const redone = snapshot();
      const presentation = skillInfoPresentation(hidden, unit, game);
      const visible = visibleSkillsForInfoMenu(unit, game).map((skill: any) => skill.nid);
      unit.skills = oldSkills;
      game.units = oldUnits;
      return { effects, applied, reversed, redone, presentation, visible };
    });

    expect(result).not.toBeNull();
    expect(result!.effects).toEqual({ reset: 3, removed: 1 });
    expect(result!.applied).toEqual({
      drain: 3,
      perTurn: 2,
      build: 0,
      temporary: false,
    });
    expect(result!.reversed).toEqual({
      drain: 2,
      perTurn: 0,
      build: 0,
      temporary: true,
    });
    expect(result!.redone).toEqual(result!.applied);
    expect(result!.presentation).toBe('hidden');
    expect(result!.visible).toEqual([
      '_Class',
      '_Ordinary',
      '_Drain',
      '_PerTurn',
      '_Build',
    ]);
  });
});
