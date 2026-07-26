import { expect, test, type Page } from '@playwright/test';

async function bootEotf(page: Page): Promise<void> {
  await page.goto('/?harness=true&project=eotf.ltproj&level=X&clean=true&bundle=false');
  await page.waitForFunction(() => (window as any).__harness?.ready === true, undefined, {
    timeout: 30_000,
  });
}

test.describe('Embrace of the Fog secondary numeric skills', () => {
  test('count-locks all 30 growth, subtle-stat, sight, and pursuit uses', async ({ page }) => {
    await bootEotf(page);
    const result = await page.evaluate(() => {
      const game = (window as any).__gameRef;
      const selected = new Set([
        'growth_change',
        'pcc_static',
        'sight_range_bonus',
        'subtle_stat_change',
      ]);
      const counts: Record<string, number> = {};
      const invalid: string[] = [];
      for (const skill of game.db.skills.values()) {
        for (const [nid, value] of skill.components) {
          if (!selected.has(nid)) continue;
          counts[nid] = (counts[nid] ?? 0) + 1;
          if (nid === 'pcc_static' || nid === 'sight_range_bonus') {
            if (typeof value !== 'number') invalid.push(`${skill.nid}:${nid}:number`);
          } else if (!Array.isArray(value) ||
              value.some((entry: unknown) =>
                !Array.isArray(entry) ||
                typeof entry[0] !== 'string' ||
                typeof entry[1] !== 'number')) {
            invalid.push(`${skill.nid}:${nid}:stat-list`);
          }
        }
      }
      return { counts, invalid };
    });

    expect(result).toEqual({
      counts: {
        growth_change: 22,
        pcc_static: 3,
        sight_range_bonus: 2,
        subtle_stat_change: 3,
      },
      invalid: [],
    });
  });

  test('active modifiers affect movement, growth, vision, and follow-up crit', async ({ page }) => {
    await bootEotf(page);
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { SkillObject } = await import('/src/objects/skill.ts');
      const { ItemObject } = await import('/src/objects/item.ts');
      const { computeCrit } = await import('/src/combat/combat-calcs.ts');
      const {
        critMultiplier,
        growthChange,
        sightRange,
        statChange,
      } = await import('/src/combat/skill-system.ts');
      const unit = game.units.get('Player');
      const target = game.units.get('Keeper');
      const oldUnitSkills = unit.skills;
      const oldTargetSkills = target.skills;
      const make = (nid: string, components: [string, unknown][]) =>
        new SkillObject({
          nid, name: nid, desc: '', icon_nid: '', icon_index: [0, 0], components,
        });
      const item = new ItemObject({
        nid: '_PccWeapon',
        name: 'PCC Weapon',
        desc: '',
        components: [
          ['weapon', null],
          ['weapon_type', 'Sword'],
          ['damage', 0],
          ['hit', 100],
          ['crit', 20],
        ],
      });
      try {
        target.skills = [];
        const baseMovement = unit.stats.MOV ?? unit.stats.movement ?? 5;
        unit.skills = [
          make('_InactiveSubtle', [
            ['subtle_stat_change', [['MOV', 99]]],
            ['condition', 'False'],
          ]),
          make('_ActiveSubtle', [
            ['subtle_stat_change', [['MOV', 2]]],
            ['condition', 'True'],
          ]),
        ];
        const movement = {
          hook: statChange(unit, 'MOV', game),
          stat: unit.getStatValue('MOV'),
          movement: unit.getMovement(),
          expected: baseMovement + 2,
        };

        unit.skills = [
          make('_InactiveGrowth', [
            ['growth_change', [['HP', 99]]],
            ['condition', 'False'],
          ]),
          make('_ActiveGrowth', [
            ['growth_change', [['HP', 4]]],
            ['condition', 'True'],
          ]),
        ];
        const growth = growthChange(unit, 'HP', game);

        const chargedSight = make('_ChargedSight', [
          ['sight_range_bonus', 5],
          ['drain_charge', 1],
        ]);
        chargedSight.data.set('charge', 0);
        unit.skills = [
          make('_InactiveSight', [
            ['sight_range_bonus', 99],
            ['condition', 'False'],
          ]),
          chargedSight,
        ];
        const sightDepleted = sightRange(unit, game);
        chargedSight.data.set('charge', 1);
        const sightActive = sightRange(unit, game);

        const pursuit = make('_Pursuit', [
          ['pcc_static', 2],
          ['condition', 'True'],
        ]);
        unit.skills = [];
        const baseCrit = computeCrit(
          unit, item, target, game.db, game, 'attack', [0, 0],
        );
        unit.skills = [pursuit];
        const firstCrit = computeCrit(
          unit, item, target, game.db, game, 'attack', [0, 0],
        );
        const followCrit = computeCrit(
          unit, item, target, game.db, game, 'attack', [1, 0],
        );
        const multipliers = {
          first: critMultiplier(
            unit, item, target, null, 'attack', [0, 0], baseCrit, game,
          ),
          follow: critMultiplier(
            unit, item, target, null, 'attack', [1, 0], baseCrit, game,
          ),
        };
        pursuit.components.set('condition', 'False');
        const inactiveFollow = computeCrit(
          unit, item, target, game.db, game, 'attack', [1, 0],
        );

        return {
          movement,
          growth,
          sightDepleted,
          sightActive,
          baseCrit,
          firstCrit,
          followCrit,
          inactiveFollow,
          multipliers,
        };
      } finally {
        unit.skills = oldUnitSkills;
        target.skills = oldTargetSkills;
      }
    });

    expect(result.movement).toEqual({
      hook: 2,
      stat: result.movement.expected,
      movement: result.movement.expected,
      expected: result.movement.expected,
    });
    expect(result.growth).toBe(4);
    expect(result.sightDepleted).toBe(0);
    expect(result.sightActive).toBe(5);
    expect(result.firstCrit).toBe(result.baseCrit);
    expect(result.followCrit).toBe(Math.min(100, Math.trunc(result.baseCrit * 2)));
    expect(result.inactiveFollow).toBe(result.baseCrit);
    expect(result.multipliers).toEqual({ first: 1, follow: 2 });
  });
});
