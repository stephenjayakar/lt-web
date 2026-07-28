import { expect, test, type Page } from '@playwright/test';

async function bootEotf(page: Page): Promise<void> {
  await page.goto('/?harness=true&project=eotf.ltproj&level=X&clean=true&bundle=false');
  await page.waitForFunction(() => (window as any).__harness?.ready === true, undefined, {
    timeout: 60_000,
  });
}

test.describe('Embrace of the Fog forced-movement item hooks', () => {
  test('count-locks every authored component value shape', async ({ page }) => {
    await bootEotf(page);
    const authored = await page.evaluate(() => {
      const game = (window as any).__gameRef;
      const wanted = new Set([
        'shove_on_end_combat_initiate',
        'shove_flexible_on_end_combat_initiate',
        'shove_flex_stops',
        'pivot_on_end_combat_initiate',
        'draw_back_on_end_combat_initiate',
        'pivot_always_on_end_combat_initiate',
        'self_shove_flex_stops',
        'shove_flex_stops_event',
      ]);
      const values: Record<string, unknown[]> = {};
      for (const item of game.db.items.values()) {
        for (const [nid, value] of item.components) {
          if (wanted.has(nid)) (values[nid] ??= []).push(value);
        }
      }
      return values;
    });

    expect(authored).toEqual({
      shove_flexible_on_end_combat_initiate: [3, 1, 1, 99, -4, 2, 4, 99, 99],
      shove_on_end_combat_initiate: [-1, -1, -1, 1, -2, -2, 1, 3],
      shove_flex_stops: [-3, 99],
      pivot_on_end_combat_initiate: [1, 1, 1, 1],
      self_shove_flex_stops: ["unit.get_stat('MOV')"],
      shove_flex_stops_event: [{ magnitude: 2, impact_event: 'Global Ability_Throw_2' }],
      draw_back_on_end_combat_initiate: [1],
      pivot_always_on_end_combat_initiate: [1],
    });
  });

  test('preserves strict, flexible, signed, and initiation-only shove rules', async ({ page }) => {
    await bootEotf(page);
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { UnitObject } = await import('/src/objects/unit.ts');
      const { ItemObject } = await import('/src/objects/item.ts');
      const { ActionLog } = await import('/src/engine/action.ts');
      const { applyCombatItemEndHooks } =
        await import('/src/combat/combat-lifecycle.ts');
      const template = game.units.get('Player');
      const klass = game.db.classes.get(template.klass);

      let origin: [number, number] | null = null;
      for (let y = 0; y < game.board.height && !origin; y++) {
        for (let x = 2; x < game.board.width - 7; x++) {
          const open = Array.from({ length: 10 }, (_, index) => x - 2 + index);
          if (open.every((cellX) =>
            !game.board.getUnit(cellX, y) &&
            game.board.getMovementCost(
              cellX, y, klass.movement_group ?? 'Infantry', game.db,
            ) < 99)) {
            origin = [x, y];
            break;
          }
        }
      }
      if (!origin) return null;

      const makeUnit = (nid: string) => {
        const unit = new UnitObject({
          nid, name: nid, desc: '', variant: null, level: 1, klass: template.klass,
          tags: [], bases: { ...klass.bases }, growths: {}, stat_cap_modifiers: {},
          starting_items: [], learned_skills: [], unit_notes: [], fields: [],
          wexp_gain: {}, portrait_nid: '', affinity: '',
        }, klass);
        unit.team = 'player';
        return unit;
      };
      const attacker = makeUnit('_EotfShoveUser');
      const target = makeUnit('_EotfShoveTarget');
      const blocker = makeUnit('_EotfShoveBlocker');
      const [x, y] = origin;
      const clear = () => {
        game.board.removeUnit(attacker);
        game.board.removeUnit(target);
        game.board.removeUnit(blocker);
        attacker.skills = [];
        target.skills = [];
      };
      const place = (blockerX: number | null = null) => {
        clear();
        game.board.setUnit(x, y, attacker);
        game.board.setUnit(x + 2, y, target);
        if (blockerX !== null) game.board.setUnit(blockerX, y, blocker);
      };
      const run = (
        component: string,
        value: number,
        mode: 'attack' | 'defense',
        hit: boolean,
        blockerX: number | null,
      ) => {
        place(blockerX);
        const actionLog = new ActionLog();
        const item = new ItemObject({
          nid: `_${component}`, name: '', desc: '', icon_nid: '', icon_index: [0, 0],
          components: [[component, value]],
        });
        const applied = applyCombatItemEndHooks(
          { ...game, actionLog, db: game.db, board: game.board },
          [{
            attacker, defender: target, item, hit, crit: false, damage: 0,
            isCounter: mode === 'defense', mode, attackInfo: [0, 0],
          }] as any,
        );
        const moved = target.position ? [...target.position] : null;
        while (actionLog.actionIndex >= 0) actionLog.runActionBackward();
        const rewound = target.position ? [...target.position] : null;
        return { applied, moved, rewound };
      };

      const strictBypassesIntermediate = run(
        'shove_on_end_combat_initiate', 3, 'attack', false, x + 4,
      );
      const flexibleStopsShort = run(
        'shove_flexible_on_end_combat_initiate', 3, 'attack', true, x + 4,
      );
      const standardStopsShort = run('shove', 3, 'attack', true, x + 4);
      const signedPull = run(
        'shove_on_end_combat_initiate', -1, 'attack', false, null,
      );
      const defenseSuppressed = run(
        'shove_flexible_on_end_combat_initiate', 2, 'defense', true, null,
      );

      place(null);
      const { SkillObject } = await import('/src/objects/skill.ts');
      target.skills = [new SkillObject({
        nid: '_Anchored', name: '', desc: '',
        components: [['ignore_forced_movement', null]],
      })];
      const actionLog = new ActionLog();
      const anchoredItem = new ItemObject({
        nid: '_AnchoredShove', name: '', desc: '', icon_nid: '', icon_index: [0, 0],
        components: [['shove_on_end_combat_initiate', 1]],
      });
      const anchored = applyCombatItemEndHooks(
        { ...game, actionLog, db: game.db, board: game.board },
        [{
          attacker, defender: target, item: anchoredItem, hit: true, crit: false,
          damage: 0, isCounter: false, mode: 'attack', attackInfo: [0, 0],
        }] as any,
      );
      const anchoredPosition = target.position ? [...target.position] : null;
      clear();
      return {
        origin, strictBypassesIntermediate, flexibleStopsShort, standardStopsShort, signedPull,
        defenseSuppressed, anchored, anchoredPosition,
      };
    });

    expect(result).not.toBeNull();
    const [x, y] = result!.origin;
    expect(result!.strictBypassesIntermediate).toEqual({
      applied: 1, moved: [x + 5, y], rewound: [x + 2, y],
    });
    expect(result!.flexibleStopsShort).toEqual({
      applied: 1, moved: [x + 3, y], rewound: [x + 2, y],
    });
    expect(result!.standardStopsShort).toEqual(result!.flexibleStopsShort);
    expect(result!.signedPull).toEqual({
      applied: 1, moved: [x + 1, y], rewound: [x + 2, y],
    });
    expect(result!.defenseSuppressed).toEqual({
      applied: 0, moved: [x + 2, y], rewound: [x + 2, y],
    });
    expect(result!.anchored).toBe(0);
    expect(result!.anchoredPosition).toEqual([x + 2, y]);
  });

  test('applies pivot, draw-back, self-shove, and impact events reversibly', async ({ page }) => {
    await bootEotf(page);
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { UnitObject } = await import('/src/objects/unit.ts');
      const { ItemObject } = await import('/src/objects/item.ts');
      const { ActionLog } = await import('/src/engine/action.ts');
      const { applyCombatItemEndHooks } =
        await import('/src/combat/combat-lifecycle.ts');
      const template = game.units.get('Player');
      const klass = game.db.classes.get(template.klass);

      let origin: [number, number] | null = null;
      for (let y = 0; y < game.board.height && !origin; y++) {
        for (let x = 2; x < game.board.width - 6; x++) {
          if (Array.from({ length: 9 }, (_, index) => x - 2 + index).every((cellX) =>
            !game.board.getUnit(cellX, y) &&
            game.board.getMovementCost(
              cellX, y, klass.movement_group ?? 'Infantry', game.db,
            ) < 99)) {
            origin = [x, y];
            break;
          }
        }
      }
      if (!origin) return null;
      const makeUnit = (nid: string) => {
        const unit = new UnitObject({
          nid, name: nid, desc: '', variant: null, level: 1, klass: template.klass,
          tags: [], bases: { ...klass.bases }, growths: {}, stat_cap_modifiers: {},
          starting_items: [], learned_skills: [], unit_notes: [], fields: [],
          wexp_gain: {}, portrait_nid: '', affinity: '',
        }, klass);
        unit.team = 'player';
        return unit;
      };
      const attacker = makeUnit('_EotfMoveUser');
      const target = makeUnit('_EotfMoveTarget');
      const blocker = makeUnit('_EotfMoveBlocker');
      const [x, y] = origin;
      const clear = () => {
        game.board.removeUnit(attacker);
        game.board.removeUnit(target);
        game.board.removeUnit(blocker);
      };
      const run = (
        component: string,
        value: unknown,
        attackerX: number,
        targetX: number,
        blockerX: number | null = null,
      ) => {
        clear();
        game.board.setUnit(attackerX, y, attacker);
        game.board.setUnit(targetX, y, target);
        if (blockerX !== null) game.board.setUnit(blockerX, y, blocker);
        const actionLog = new ActionLog();
        const events: any[] = [];
        const eventManager = {
          triggerSpecific(nid: string, trigger: any) {
            events.push({
              nid,
              unit1: trigger.unit1.nid,
              unit2: trigger.unit2.nid,
              position: trigger.position,
            });
            return true;
          },
        };
        const item = new ItemObject({
          nid: `_${component}`, name: '', desc: '', icon_nid: '', icon_index: [0, 0],
          components: [[component, value]],
        });
        const applied = applyCombatItemEndHooks(
          { ...game, actionLog, eventManager, db: game.db, board: game.board },
          [{
            attacker, defender: target, item, hit: true, crit: false, damage: 0,
            isCounter: false, mode: 'attack', attackInfo: [0, 0],
          }] as any,
        );
        const moved = {
          attacker: attacker.position ? [...attacker.position] : null,
          target: target.position ? [...target.position] : null,
        };
        while (actionLog.actionIndex >= 0) actionLog.runActionBackward();
        const rewound = {
          attacker: attacker.position ? [...attacker.position] : null,
          target: target.position ? [...target.position] : null,
        };
        return { applied, moved, rewound, events };
      };

      const pivot = run('pivot_on_end_combat_initiate', 1, x, x + 1);
      const pivotAlways = run('pivot_always_on_end_combat_initiate', 1, x, x + 1);
      const drawBack = run('draw_back_on_end_combat_initiate', 1, x, x + 1);
      attacker.stats.MOV = 4;
      const selfShove = run(
        'self_shove_flex_stops', "unit.get_stat('MOV')", x, x + 4,
      );
      const impact = run(
        'shove_flex_stops_event',
        { magnitude: 2, impact_event: 'Global Ability_Throw_2' },
        x,
        x + 1,
        x + 3,
      );
      clear();
      return { origin, pivot, pivotAlways, drawBack, selfShove, impact };
    });

    expect(result).not.toBeNull();
    const [x, y] = result!.origin;
    expect(result!.pivot).toMatchObject({
      applied: 1,
      moved: { attacker: [x + 2, y], target: [x + 1, y] },
      rewound: { attacker: [x, y], target: [x + 1, y] },
    });
    expect(result!.pivotAlways).toMatchObject(result!.pivot);
    expect(result!.drawBack).toMatchObject({
      applied: 2,
      moved: { attacker: [x - 1, y], target: [x, y] },
      rewound: { attacker: [x, y], target: [x + 1, y] },
    });
    expect(result!.selfShove).toMatchObject({
      applied: 1,
      moved: { attacker: [x + 3, y], target: [x + 4, y] },
      rewound: { attacker: [x, y], target: [x + 4, y] },
    });
    expect(result!.impact).toEqual({
      applied: 1,
      moved: { attacker: [x, y], target: [x + 2, y] },
      rewound: { attacker: [x, y], target: [x + 1, y] },
      events: [{
        nid: 'Global Ability_Throw_2',
        unit1: '_EotfMoveTarget',
        unit2: '_EotfMoveBlocker',
        position: [x + 1, y],
      }],
    });
  });
});
