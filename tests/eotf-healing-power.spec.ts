import { expect, test, type Page } from '@playwright/test';

async function bootEotf(page: Page): Promise<void> {
  await page.goto('/?harness=true&project=eotf.ltproj&level=X&clean=true&bundle=false');
  await page.waitForFunction(() => (window as any).__harness?.ready === true, undefined, {
    timeout: 60_000,
  });
}

test.describe('Embrace of the Fog healing-power skills', () => {
  test('count-locks all 13 authored outgoing, received, and live-to-serve uses', async ({ page }) => {
    await bootEotf(page);
    const result = await page.evaluate(() => {
      const game = (window as any).__gameRef;
      const selected = new Set([
        'empower_heal', 'empower_heal_received', 'live_to_serve',
      ]);
      const counts: Record<string, number> = {};
      const invalid: string[] = [];
      for (const skill of game.db.skills.values()) {
        for (const [nid, value] of skill.components) {
          if (!selected.has(nid)) continue;
          counts[nid] = (counts[nid] ?? 0) + 1;
          if (nid === 'live_to_serve') {
            if (typeof value !== 'number') invalid.push(`${skill.nid}:${nid}:number`);
          } else if (typeof value !== 'string') {
            invalid.push(`${skill.nid}:${nid}:expression`);
          }
        }
      }
      return { counts, invalid };
    });

    expect(result).toEqual({
      counts: {
        empower_heal: 10,
        empower_heal_received: 2,
        live_to_serve: 1,
      },
      invalid: [],
    });
  });

  test('normal and equation healing include only active outgoing and received bonuses', async ({ page }) => {
    await bootEotf(page);
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { SkillObject } = await import('/src/objects/skill.ts');
      const { ItemObject } = await import('/src/objects/item.ts');
      const { healAmount } = await import('/src/combat/item-system.ts');
      const healer = game.units.get('Player');
      const target = game.units.get('Keeper');
      const oldHealerSkills = healer.skills;
      const oldTargetSkills = target.skills;
      const oldEquation = game.db.equations.get('_EOTF_HEAL_TEST');
      const make = (nid: string, components: [string, unknown][]) =>
        new SkillObject({
          nid, name: nid, desc: '', icon_nid: '', icon_index: [0, 0], components,
        });
      const normal = new ItemObject({
        nid: '_NormalHeal', name: 'Normal Heal', desc: '',
        components: [['heal', 10]],
      });
      const equation = new ItemObject({
        nid: '_EquationHeal', name: 'Equation Heal', desc: '',
        components: [['equation_heal', '_EOTF_HEAL_TEST']],
      });
      try {
        game.db.equations.set('_EOTF_HEAL_TEST', '10');
        healer.skills = [
          make('_InactiveOutgoing', [
            ['empower_heal', '99'], ['condition', 'False'],
          ]),
          make('_ActiveOutgoing', [
            ['empower_heal', '2'], ['condition', 'True'],
          ]),
        ];
        target.skills = [
          make('_InactiveReceived', [
            ['empower_heal_received', '99'], ['condition', 'False'],
          ]),
          make('_ActiveReceived', [
            ['empower_heal_received', '3'], ['condition', 'True'],
          ]),
        ];
        return {
          normal: healAmount(healer, normal, target, game),
          equation: healAmount(healer, equation, target, game),
        };
      } finally {
        healer.skills = oldHealerSkills;
        target.skills = oldTargetSkills;
        if (oldEquation === undefined) game.db.equations.delete('_EOTF_HEAL_TEST');
        else game.db.equations.set('_EOTF_HEAL_TEST', oldEquation);
      }
    });

    expect(result).toEqual({ normal: 15, equation: 15 });
  });
});
