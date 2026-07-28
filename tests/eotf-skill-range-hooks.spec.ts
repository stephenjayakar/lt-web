import { expect, test, type Page } from '@playwright/test';

async function bootEotf(page: Page): Promise<void> {
  await page.goto('/?harness=true&project=eotf.ltproj&level=X&clean=true&bundle=false');
  await page.waitForFunction(() => (window as any).__harness?.ready === true, undefined, {
    timeout: 60_000,
  });
}

test.describe('Embrace of the Fog skill range hooks', () => {
  test('count-locks all 55 authored range modifiers and caps', async ({ page }) => {
    await bootEotf(page);
    const result = await page.evaluate(() => {
      const game = (window as any).__gameRef;
      const selected = new Set([
        'eval_range', 'eval_min_range', 'eval_max_range',
        'modify_minimum_range', 'modify_maximum_range', 'limit_maximum_range',
      ]);
      const counts: Record<string, number> = {};
      const invalid: string[] = [];
      for (const skill of game.db.skills.values()) {
        for (const [nid, value] of skill.components) {
          if (!selected.has(nid)) continue;
          counts[nid] = (counts[nid] ?? 0) + 1;
          const evaluated = nid.startsWith('eval_');
          if (evaluated ? typeof value !== 'string' : typeof value !== 'number') {
            invalid.push(`${skill.nid}:${nid}:${evaluated ? 'expression' : 'number'}`);
          }
        }
      }
      return { counts, invalid };
    });

    expect(result).toEqual({
      counts: {
        eval_max_range: 7,
        eval_min_range: 1,
        eval_range: 3,
        limit_maximum_range: 8,
        modify_maximum_range: 32,
        modify_minimum_range: 4,
      },
      invalid: [],
    });
  });

  test('accumulates active min/max expressions and applies the last active cap', async ({ page }) => {
    await bootEotf(page);
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { SkillObject } = await import('/src/objects/skill.ts');
      const { ItemObject } = await import('/src/objects/item.ts');
      const {
        modifiedMaximumRange,
        modifiedMinimumRange,
      } = await import('/src/combat/skill-system.ts');
      const unit = game.units.get('Player');
      const oldSkills = unit.skills;
      const make = (nid: string, components: [string, unknown][]) =>
        new SkillObject({
          nid, name: nid, desc: '', icon_nid: '', icon_index: [0, 0], components,
        });
      const item = new ItemObject({
        nid: '_SkillRangeItem', name: 'Skill Range Item', desc: '',
        components: [
          ['weapon', null], ['min_range', 2], ['max_range', 3],
          ['damage', 1], ['hit', 100],
        ],
      });
      try {
        unit.skills = [
          make('_InactiveRange', [
            ['modify_maximum_range', 99],
            ['limit_maximum_range', 1],
            ['condition', 'False'],
          ]),
          make('_FlatRange', [
            ['modify_maximum_range', 1],
            ['modify_minimum_range', -1],
          ]),
          make('_EvaluatedRange', [
            ['eval_range', '2'],
            ['eval_max_range', '3'],
            ['eval_min_range', '-1'],
          ]),
          make('_RangeCap', [['limit_maximum_range', 5]]),
        ];
        return {
          minimum: modifiedMinimumRange(unit, item, game),
          maximum: modifiedMaximumRange(unit, item, game),
        };
      } finally {
        unit.skills = oldSkills;
      }
    });

    expect(result).toEqual({ minimum: 0, maximum: 5 });
  });
});
