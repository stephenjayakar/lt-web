import { expect, test, type Page } from '@playwright/test';

async function bootEotf(page: Page): Promise<void> {
  await page.goto('/?harness=true&project=eotf.ltproj&level=X&clean=true&bundle=false');
  await page.waitForFunction(() => (window as any).__harness?.ready === true, undefined, {
    timeout: 60_000,
  });
}

test.describe('Embrace of the Fog AI, economy, and progression skills', () => {
  test('count-locks all 63 authored modifier uses and referenced AI profiles', async ({ page }) => {
    await bootEotf(page);
    const result = await page.evaluate(() => {
      const game = (window as any).__gameRef;
      const selected = new Set([
        'change_ai', 'modify_ai_priority', 'change_buy_price',
        'exp_multiplier', 'enemy_exp_multiplier', 'wexp_multiplier',
      ]);
      const counts: Record<string, number> = {};
      const invalid: string[] = [];
      for (const skill of game.db.skills.values()) {
        for (const [nid, value] of skill.components) {
          if (!selected.has(nid)) continue;
          counts[nid] = (counts[nid] ?? 0) + 1;
          if (nid === 'change_ai') {
            if (typeof value !== 'string' || !game.db.ai.has(value)) {
              invalid.push(`${skill.nid}:${nid}:${String(value)}`);
            }
          } else if (typeof value !== 'number') {
            invalid.push(`${skill.nid}:${nid}:number`);
          }
        }
      }
      return { counts, invalid };
    });

    expect(result).toEqual({
      counts: {
        change_ai: 15,
        change_buy_price: 1,
        enemy_exp_multiplier: 1,
        exp_multiplier: 1,
        modify_ai_priority: 44,
        wexp_multiplier: 1,
      },
      invalid: [],
    });
  });

  test('only active skills override AI, priority, prices, EXP, and WEXP', async ({ page }) => {
    await bootEotf(page);
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { SkillObject } = await import('/src/objects/skill.ts');
      const { ItemObject } = await import('/src/objects/item.ts');
      const skills = await import('/src/combat/skill-system.ts');
      const unit = game.units.get('Player');
      const target = game.units.get('Keeper');
      const oldSkills = unit.skills;
      const make = (nid: string, components: [string, unknown][]) =>
        new SkillObject({
          nid, name: nid, desc: '', icon_nid: '', icon_index: [0, 0], components,
        });
      const item = new ItemObject({
        nid: '_EconomyItem', name: 'Economy Item', desc: '', components: [],
      });
      try {
        const inactive = make('_InactiveCampaignModifiers', [
          ['change_ai', 'FearStatus'],
          ['modify_ai_priority', 99],
          ['change_buy_price', 0.1],
          ['exp_multiplier', 0],
          ['enemy_exp_multiplier', 0],
          ['wexp_multiplier', 0],
          ['condition', 'False'],
        ]);
        const active = make('_ActiveCampaignModifiers', [
          ['change_ai', 'Pursue'],
          ['modify_ai_priority', 2],
          ['change_buy_price', 0.5],
          ['exp_multiplier', 3],
          ['enemy_exp_multiplier', 4],
          ['wexp_multiplier', 5],
          ['condition', 'True'],
        ]);
        unit.skills = [inactive, active];
        return {
          ai: skills.changeAi(unit, 'None', game),
          priority: skills.aiPriorityMultiplier(unit, game),
          buy: skills.priceSkillMultiplier(unit, item, 'change_buy_price', game),
          exp: skills.expMultiplier(unit, target),
          enemyExp: skills.enemyExpMultiplier(unit, target),
          wexp: skills.wexpMultiplier(unit, target),
        };
      } finally {
        unit.skills = oldSkills;
      }
    });

    expect(result).toEqual({
      ai: 'Pursue',
      priority: 2,
      buy: 0.5,
      exp: 3,
      enemyExp: 4,
      wexp: 5,
    });
  });
});
