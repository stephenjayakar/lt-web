import { expect, test, type Page } from '@playwright/test';

async function bootEotf(page: Page): Promise<void> {
  await page.goto('/?harness=true&project=eotf.ltproj&level=X&clean=true&bundle=false');
  await page.waitForFunction(() => (window as any).__harness?.ready === true, undefined, {
    timeout: 30_000,
  });
}

test.describe('Embrace of the Fog movement and traversal skills', () => {
  test('count-locks all 65 authored movement-control uses', async ({ page }) => {
    await bootEotf(page);
    const result = await page.evaluate(() => {
      const game = (window as any).__gameRef;
      const selected = new Set([
        'movement_type', 'pass', 'ignore_terrain', 'grounded',
        'no_attack_after_move',
      ]);
      const counts: Record<string, number> = {};
      const invalid: string[] = [];
      for (const skill of game.db.skills.values()) {
        for (const [nid, value] of skill.components) {
          if (!selected.has(nid)) continue;
          counts[nid] = (counts[nid] ?? 0) + 1;
          if (nid === 'movement_type') {
            if (typeof value !== 'string' || !value) {
              invalid.push(`${skill.nid}:${nid}:movement-type`);
            }
          } else if (value !== null) {
            invalid.push(`${skill.nid}:${nid}:marker`);
          }
        }
      }
      return { counts, invalid };
    });

    expect(result).toEqual({
      counts: {
        grounded: 10,
        ignore_terrain: 7,
        movement_type: 38,
        no_attack_after_move: 3,
        pass: 7,
      },
      invalid: [],
    });
  });

  test('conditions gate traversal, grounding, movement type, and post-move attacks', async ({ page }) => {
    await bootEotf(page);
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { SkillObject } = await import('/src/objects/skill.ts');
      const { ItemObject } = await import('/src/objects/item.ts');
      const skillSystem = await import('/src/combat/skill-system.ts');
      const itemSystem = await import('/src/combat/item-system.ts');
      const unit = game.units.get('Player');
      const oldSkills = unit.skills;
      const oldMoved = unit.hasMoved;
      const make = (nid: string, components: [string, unknown][]) =>
        new SkillObject({
          nid, name: nid, desc: '', icon_nid: '', icon_index: [0, 0], components,
        });
      const item = new ItemObject({
        nid: '_MovementRestrictionItem', name: 'Movement Restriction Item', desc: '',
        components: [],
      });
      try {
        const falseMarkers = make('_FalseMovementMarkers', [
          ['pass', null],
          ['grounded', null],
          ['ignore_terrain', null],
          ['no_attack_after_move', null],
          ['movement_type', 'Cheater'],
          ['condition', 'False'],
        ]);
        unit.skills = [falseMarkers];
        unit.hasMoved = true;
        const inactive = {
          pass: skillSystem.passThrough(unit, { game }),
          grounded: skillSystem.ignoreForcedMovement(unit, game),
          terrain: skillSystem.ignoreTerrain(unit, game),
          movement: skillSystem.movementType(unit, 'Infantry', game),
          available: itemSystem.available(unit, item, game.db, game),
        };

        const trueMarkers = make('_TrueMovementMarkers', [
          ['pass', null],
          ['grounded', null],
          ['ignore_terrain', null],
          ['no_attack_after_move', null],
          ['movement_type', 'Cheater'],
          ['condition', 'True'],
        ]);
        unit.skills = [trueMarkers];
        const active = {
          pass: skillSystem.passThrough(unit, { game }),
          grounded: skillSystem.ignoreForcedMovement(unit, game),
          terrain: skillSystem.ignoreTerrain(unit, game),
          movement: skillSystem.movementType(unit, 'Infantry', game),
          available: itemSystem.available(unit, item, game.db, game),
        };
        unit.hasMoved = false;
        const beforeMove = itemSystem.available(unit, item, game.db, game);
        return { inactive, active, beforeMove };
      } finally {
        unit.skills = oldSkills;
        unit.hasMoved = oldMoved;
      }
    });

    expect(result).toEqual({
      inactive: {
        pass: false,
        grounded: false,
        terrain: false,
        movement: 'Infantry',
        available: true,
      },
      active: {
        pass: true,
        grounded: true,
        terrain: true,
        movement: 'Cheater',
        available: false,
      },
      beforeMove: true,
    });
  });
});
