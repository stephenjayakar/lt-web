import { expect, test, type Page } from '@playwright/test';

async function bootEotf(page: Page): Promise<void> {
  await page.goto('/?harness=true&project=eotf.ltproj&level=X&clean=true&bundle=false');
  await page.waitForFunction(() => (window as any).__harness?.ready === true, undefined, {
    timeout: 30_000,
  });
}

test.describe('Embrace of the Fog Witch Warp skills', () => {
  test('count-locks all 10 generic, specific, and expression warp uses', async ({ page }) => {
    await bootEotf(page);
    const result = await page.evaluate(() => {
      const game = (window as any).__gameRef;
      const selected = new Set([
        'witch_warp',
        'specific_witch_warp',
        'witch_warp_expression',
      ]);
      const counts: Record<string, number> = {};
      const invalid: string[] = [];
      for (const skill of game.db.skills.values()) {
        for (const [nid, value] of skill.components) {
          if (!selected.has(nid)) continue;
          counts[nid] = (counts[nid] ?? 0) + 1;
          if (nid === 'witch_warp' && value !== null) {
            invalid.push(`${skill.nid}:${nid}:null`);
          } else if (nid === 'specific_witch_warp' &&
              (!Array.isArray(value) ||
               value.some((entry: unknown) => typeof entry !== 'string'))) {
            invalid.push(`${skill.nid}:${nid}:unit-list`);
          } else if (nid === 'witch_warp_expression' &&
              typeof value !== 'string') {
            invalid.push(`${skill.nid}:${nid}:expression`);
          }
        }
      }
      return { counts, invalid };
    });

    expect(result).toEqual({
      counts: {
        specific_witch_warp: 2,
        witch_warp: 2,
        witch_warp_expression: 6,
      },
      invalid: [],
    });
  });

  test('last active form selects the correct weakly traversable destinations', async ({ page }) => {
    await bootEotf(page);
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { SkillObject } = await import('/src/objects/skill.ts');
      const { witchWarpPositions } = await import('/src/combat/skill-system.ts');
      const unit = game.units.get('Player');
      const oldSkills = unit.skills;
      const ally = { nid: '_WarpAlly', team: unit.team, position: [4, 4] };
      const enemy = { nid: '_WarpEnemy', team: 'enemy', position: [7, 7] };
      const occupied = new Map([
        ['4,4', ally],
        ['7,7', enemy],
      ]);
      const board = {
        getAllUnits: () => [ally, enemy],
        checkBounds: (x: number, y: number) =>
          x >= 0 && y >= 0 && x < 12 && y < 12,
        getUnit: (x: number, y: number) => occupied.get(`${x},${y}`) ?? null,
        getMovementCost: () => 1,
      };
      const make = (nid: string, components: [string, unknown][]) =>
        new SkillObject({
          nid, name: nid, desc: '', icon_nid: '', icon_index: [0, 0], components,
        });
      const generic = make('_GenericWarp', [['witch_warp', null]]);
      const specific = make('_SpecificWarp', [
        ['specific_witch_warp', ['_WarpEnemy']],
      ]);
      const expression = make('_ExpressionWarp', [
        ['witch_warp_expression', "unit.nid == '_WarpEnemy'"],
      ]);
      try {
        unit.skills = [generic];
        const genericPositions = witchWarpPositions(unit, board, game.db, game);
        unit.skills = [specific];
        const specificPositions = witchWarpPositions(unit, board, game.db, game);
        unit.skills = [expression];
        const expressionPositions = witchWarpPositions(unit, board, game.db, game);

        unit.skills = [generic, specific];
        const specificWins = witchWarpPositions(unit, board, game.db, game);
        unit.skills = [
          specific,
          make('_InactiveExpression', [
            ['witch_warp_expression', 'False'],
            ['condition', 'False'],
          ]),
        ];
        const inactiveIgnored = witchWarpPositions(unit, board, game.db, game);
        unit.skills = [
          specific,
          make('_ActiveEmptyExpression', [
            ['witch_warp_expression', 'False'],
            ['condition', 'True'],
          ]),
        ];
        const activeEmptyWins = witchWarpPositions(unit, board, game.db, game);

        const charged = make('_ChargedWarp', [
          ['witch_warp', null],
          ['drain_charge', 1],
        ]);
        charged.data.set('charge', 0);
        unit.skills = [charged];
        const depleted = witchWarpPositions(unit, board, game.db, game);
        charged.data.set('charge', 1);
        const chargedPositions = witchWarpPositions(unit, board, game.db, game);

        return {
          genericPositions,
          specificPositions,
          expressionPositions,
          specificWins,
          inactiveIgnored,
          activeEmptyWins,
          depleted,
          chargedPositions,
        };
      } finally {
        unit.skills = oldSkills;
      }
    });

    const allyPositions = [[4, 3], [4, 5], [3, 4], [5, 4]];
    const enemyPositions = [[7, 6], [6, 7], [8, 7], [7, 8]];
    expect(result.genericPositions).toEqual(allyPositions);
    expect(result.specificPositions).toEqual(enemyPositions);
    expect(result.expressionPositions).toEqual(enemyPositions);
    expect(result.specificWins).toEqual(enemyPositions);
    expect(result.inactiveIgnored).toEqual(enemyPositions);
    expect(result.activeEmptyWins).toEqual([]);
    expect(result.depleted).toEqual([]);
    expect(result.chargedPositions).toEqual(allyPositions);
  });
});
