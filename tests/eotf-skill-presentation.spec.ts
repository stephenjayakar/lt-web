import { expect, test, type Page } from '@playwright/test';

async function bootEotf(page: Page): Promise<void> {
  await page.goto('/?harness=true&project=eotf.ltproj&level=X&clean=true&bundle=false');
  await page.waitForFunction(() => (window as any).__harness?.ready === true, undefined, {
    timeout: 30_000,
  });
}

test.describe('Embrace of the Fog skill presentation', () => {
  test('count-locks all 124 authored map and combat presentation uses', async ({ page }) => {
    await bootEotf(page);
    const result = await page.evaluate(() => {
      const game = (window as any).__gameRef;
      const selected = new Set([
        'display_skill_icon_in_combat',
        'hide_skill_icon_in_combat',
        'unit_anim',
        'unit_flickering_tint',
      ]);
      const counts: Record<string, number> = {};
      const invalid: string[] = [];
      for (const skill of game.db.skills.values()) {
        for (const [nid, value] of skill.components) {
          if (!selected.has(nid)) continue;
          counts[nid] = (counts[nid] ?? 0) + 1;
          if (nid === 'unit_anim') {
            if (typeof value !== 'string') invalid.push(`${skill.nid}:${nid}:animation`);
          } else if (nid === 'unit_flickering_tint') {
            if (!Array.isArray(value) || value.length !== 3 ||
                value.some((channel: unknown) => typeof channel !== 'number')) {
              invalid.push(`${skill.nid}:${nid}:color`);
            }
          } else if (value !== null) {
            invalid.push(`${skill.nid}:${nid}:null`);
          }
        }
      }
      return { counts, invalid };
    });

    expect(result).toEqual({
      counts: {
        display_skill_icon_in_combat: 12,
        hide_skill_icon_in_combat: 4,
        unit_anim: 54,
        unit_flickering_tint: 54,
      },
      invalid: [],
    });
  });

  test('active overlays, tints, and combat cues obey conditions and charges', async ({
    page,
  }, testInfo) => {
    await bootEotf(page);
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { SkillObject } = await import('/src/objects/skill.ts');
      const { unitSpriteTint } = await import('/src/combat/skill-system.ts');
      const { displaySkillCues } = await import('/src/combat/proc-presentation.ts');
      const unit = game.units.get('Player');
      const oldSkills = unit.skills;
      (window as any).__presentationOldSkills = oldSkills;
      const make = (nid: string, components: [string, unknown][]) =>
        new SkillObject({
          nid, name: nid, desc: '', icon_nid: '', icon_index: [0, 0], components,
        });

      const inactiveAnim = make('_InactiveAnim', [
        ['unit_anim', 'MapBerserk'],
        ['condition', 'False'],
      ]);
      unit.skills = [inactiveAnim];
      game.syncSkillMapAnimations();
      const inactiveOverlays = game.tilemap.highAnimations.filter(
        (animation: any) => animation.skillAnimationKey,
      ).length;

      const chargedAnim = make('_ChargedAnim', [
        ['unit_anim', 'MapBerserk'],
        ['drain_charge', 1],
      ]);
      chargedAnim.data.set('charge', 0);
      unit.skills = [chargedAnim];
      game.syncSkillMapAnimations();
      const depletedOverlays = game.tilemap.highAnimations.filter(
        (animation: any) => animation.skillAnimationKey,
      ).length;
      chargedAnim.data.set('charge', 1);
      game.syncSkillMapAnimations();
      game.syncSkillMapAnimations();
      const activeOverlays = game.tilemap.highAnimations
        .filter((animation: any) => animation.skillAnimationKey)
        .map((animation: any) => ({
          nid: animation.nid,
          follows: animation.followUnit?.nid,
        }));

      const inactiveTint = make('_InactiveTint', [
        ['unit_flickering_tint', [10, 20, 30]],
        ['condition', 'False'],
      ]);
      const chargedTint = make('_ChargedTint', [
        ['unit_flickering_tint', [40, 50, 60]],
        ['drain_charge', 1],
      ]);
      chargedTint.data.set('charge', 0);
      unit.skills = [inactiveTint, chargedTint];
      const tintDepleted = unitSpriteTint(unit, game, 100);
      chargedTint.data.set('charge', 1);
      const tintOn = unitSpriteTint(unit, game, 100);
      const tintOff = unitSpriteTint(unit, game, 500);

      const inactiveCue = make('_InactiveCue', [
        ['display_skill_icon_in_combat', null],
        ['condition', 'False'],
      ]);
      const activeCue = make('_ActiveCue', [
        ['display_skill_icon_in_combat', null],
        ['condition', 'True'],
      ]);
      const hiddenCue = make('_HiddenCue', [
        ['display_skill_icon_in_combat', null],
        ['hide_skill_icon_in_combat', null],
        ['condition', 'True'],
      ]);
      unit.skills = [inactiveCue, activeCue, hiddenCue];
      const cues = displaySkillCues([unit], game).map((cue: any) => cue.skill.nid);

      // Leave one live overlay for the visual assertion below.
      unit.skills = [chargedAnim];
      game.syncSkillMapAnimations();
      return {
        inactiveOverlays,
        depletedOverlays,
        activeOverlays,
        tintDepleted,
        tintOn,
        tintOff,
        cues,
      };
    });

    expect(result).toEqual({
      inactiveOverlays: 0,
      depletedOverlays: 0,
      activeOverlays: [{ nid: 'MapBerserk', follows: 'Player' }],
      tintDepleted: null,
      tintOn: { color: [40, 50, 60], alpha: 1 },
      tintOff: { color: [40, 50, 60], alpha: 0 },
      cues: ['_ActiveCue'],
    });

    await page.waitForTimeout(150);
    await page.locator('canvas').first().screenshot({
      path: testInfo.outputPath('unit-anim-overlay.png'),
    });

    await page.evaluate(() => {
      const game = (window as any).__gameRef;
      const unit = game.units.get('Player');
      unit.skills = (window as any).__presentationOldSkills;
      delete (window as any).__presentationOldSkills;
      game.syncSkillMapAnimations();
    });
  });
});
