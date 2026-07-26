import { expect, test, type Page } from '@playwright/test';

async function bootEotf(page: Page): Promise<void> {
  await page.goto('/?harness=true&project=eotf.ltproj&level=X&clean=true&bundle=false');
  await page.waitForFunction(() => (window as any).__harness?.ready === true, undefined, {
    timeout: 30_000,
  });
}

test.describe('Embrace of the Fog combat order and counter skills', () => {
  test('count-locks every authored ordering, counter, and follow-up use', async ({ page }) => {
    await bootEotf(page);
    const result = await page.evaluate(() => {
      const game = (window as any).__gameRef;
      const selected = new Set([
        'vantage', 'desperation', 'close_counter', 'distant_counter',
        'resist_follow_up',
      ]);
      const counts: Record<string, number> = {};
      const invalid: string[] = [];
      for (const skill of game.db.skills.values()) {
        for (const [nid, value] of skill.components) {
          if (!selected.has(nid)) continue;
          counts[nid] = (counts[nid] ?? 0) + 1;
          if (nid === 'resist_follow_up') {
            if (typeof value !== 'number') invalid.push(`${skill.nid}:${nid}:number`);
          } else if (value !== null) {
            invalid.push(`${skill.nid}:${nid}:marker`);
          }
        }
      }
      return { counts, invalid };
    });

    expect(result).toEqual({
      counts: {
        close_counter: 8,
        desperation: 16,
        distant_counter: 19,
        resist_follow_up: 1,
        vantage: 10,
      },
      invalid: [],
    });
  });

  test('conditions gate ordering/counters and Tower Shield reduces only follow-ups', async ({ page }) => {
    await bootEotf(page);
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { SkillObject } = await import('/src/objects/skill.ts');
      const skillSystem = await import('/src/combat/skill-system.ts');
      const unit = game.units.get('Player');
      const target = game.units.get('Keeper');
      const oldSkills = unit.skills;
      const make = (nid: string, components: [string, unknown][]) =>
        new SkillObject({
          nid, name: nid, desc: '', icon_nid: '', icon_index: [0, 0], components,
        });
      try {
        const falseVantage = make('_FalseVantage', [
          ['vantage', null], ['condition', 'False'],
        ]);
        const trueVantage = make('_TrueVantage', [
          ['vantage', null], ['condition', 'True'],
        ]);
        unit.skills = [falseVantage];
        const vantageFalse = skillSystem.vantage(unit, { game, target });
        unit.skills = [trueVantage];
        const vantageTrue = skillSystem.vantage(unit, { game, target });

        const conditional = make('_ConditionalCombatMarkers', [
          ['desperation', null],
          ['close_counter', null],
          ['distant_counter', null],
          ['combat_condition', 'True'],
        ]);
        unit.skills = [conditional];
        conditional.data.set('_combat_condition', false);
        const combatFalse = {
          desperation: skillSystem.desperation(unit, { game, target }),
          close: skillSystem.closeCounter(unit, { game, target }),
          distant: skillSystem.distantCounter(unit, { game, target }),
        };
        conditional.data.set('_combat_condition', true);
        const combatTrue = {
          desperation: skillSystem.desperation(unit, { game, target }),
          close: skillSystem.closeCounter(unit, { game, target }),
          distant: skillSystem.distantCounter(unit, { game, target }),
        };

        const towerShield = new SkillObject(game.db.skills.get('Tower_Shield_Buff'));
        unit.skills = [towerShield];
        const context = [unit, null, target, null, 'defense'] as const;
        const first = skillSystem.resistMultiplier(
          context[0], context[1], context[2], context[3], context[4],
          [0, 0], 20, game,
        );
        const followUp = skillSystem.resistMultiplier(
          context[0], context[1], context[2], context[3], context[4],
          [1, 0], 20, game,
        );
        return { vantageFalse, vantageTrue, combatFalse, combatTrue, first, followUp };
      } finally {
        unit.skills = oldSkills;
      }
    });

    expect(result).toEqual({
      vantageFalse: false,
      vantageTrue: true,
      combatFalse: { desperation: false, close: false, distant: false },
      combatTrue: { desperation: true, close: true, distant: true },
      first: 1,
      followUp: 0.5,
    });
  });
});
