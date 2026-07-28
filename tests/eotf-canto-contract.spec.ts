import { expect, test, type Page } from '@playwright/test';

async function bootEotf(page: Page): Promise<void> {
  await page.goto('/?harness=true&project=eotf.ltproj&level=X&clean=true&bundle=false');
  await page.waitForFunction(() => (window as any).__harness?.ready === true, undefined, {
    timeout: 60_000,
  });
}

async function settle(page: Page, maxFrames: number = 1200): Promise<void> {
  await page.evaluate(
    (frames) => (window as any).__harness.settle(frames),
    maxFrames,
  );
}

test.describe('Embrace of the Fog Canto and Canter contract', () => {
  test('count-locks all 50 authored Canto-family uses and value shapes', async ({ page }) => {
    await bootEotf(page);
    const inventory = await page.evaluate(() => {
      const game = (window as any).__gameRef;
      const selected = new Set([
        'canto',
        'canto_plus',
        'canto_sharp',
        'canter',
        'eval_canter',
      ]);
      const counts: Record<string, number> = {};
      const invalid: string[] = [];
      for (const skill of game.db.skills.values()) {
        for (const [component, value] of skill.components) {
          if (!selected.has(component)) continue;
          counts[component] = (counts[component] ?? 0) + 1;
          if (['canto', 'canto_plus', 'canto_sharp'].includes(component) &&
              value !== null) {
            invalid.push(`${skill.nid}:${component}`);
          } else if (component === 'canter' &&
              (!Number.isInteger(value) || value < 0)) {
            invalid.push(`${skill.nid}:${component}`);
          } else if (component === 'eval_canter' &&
              (typeof value !== 'string' || value.length === 0)) {
            invalid.push(`${skill.nid}:${component}`);
          }
        }
      }
      return { counts, invalid };
    });

    expect(inventory).toEqual({
      counts: {
        canter: 29,
        canto: 5,
        canto_plus: 12,
        canto_sharp: 1,
        eval_canter: 3,
      },
      invalid: [],
    });
  });

  test('preserves variant gates, evaluated budgets, Canto Control, and replay', async ({
    page,
  }) => {
    await bootEotf(page);
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { SkillObject } = await import('/src/objects/skill.ts');
      const {
        ActionLog,
        SetMovementLeftAction,
      } = await import('/src/engine/action.ts');
      const {
        cantoMovement,
        hasCanto,
      } = await import('/src/combat/skill-system.ts');
      const { AIController } = await import('/src/ai/ai-controller.ts');
      const unit = game.units.get('Player');
      const target = game.units.get('Keeper');
      const old = {
        skills: unit.skills,
        attacked: unit.hasAttacked,
        movementLeft: unit.movementLeft,
        stats: { ...unit.stats },
      };
      const real = (nid: string) => new SkillObject(game.db.skills.get(nid));

      unit.skills = [real('Canto')];
      unit.hasAttacked = true;
      unit.movementLeft = 2;
      const canto = {
        enemy: hasCanto(unit, target, game),
        self: hasCanto(unit, unit, game),
        movement: cantoMovement(unit, target, game),
      };

      unit.skills = [real('Canto_Plus')];
      const cantoPlus = hasCanto(unit, target, game);

      unit.skills = [real('Canto_Sharp')];
      unit.movementLeft = unit.getStatValue('MOV');
      const sharpFull = hasCanto(unit, target, game);
      unit.movementLeft -= 1;
      const sharpSpent = hasCanto(unit, target, game);

      unit.skills = [real('Canter3')];
      const canter = {
        active: hasCanto(unit, target, game),
        movement: cantoMovement(unit, target, game),
      };

      const stars = [1, 2, 3, 4].map((index) => new SkillObject({
        nid: 'Stars',
        name: `Star ${index}`,
        desc: '',
        icon_nid: '',
        icon_index: [0, 0],
        components: [['stack', 10]],
      }));
      unit.skills = [real('Star_Canter'), ...stars];
      const evaluatedStars = cantoMovement(unit, target, game);

      unit.skills = [real('Worker_Bee_Player'), real('Canto_Control')];
      const controlled = cantoMovement(unit, target, game);

      unit.skills = [
        real('Canter2'),
        real('Worker_Bee_Player'),
      ];
      const maximum = cantoMovement(unit, target, game);

      const inactive = new SkillObject({
        nid: '_InactiveCanter',
        name: '',
        desc: '',
        icon_nid: '',
        icon_index: [0, 0],
        components: [
          ['condition', 'False'],
          ['eval_canter', '99'],
        ],
      });
      const depleted = new SkillObject({
        nid: '_DepletedCanter',
        name: '',
        desc: '',
        icon_nid: '',
        icon_index: [0, 0],
        components: [
          ['canter', 9],
          ['drain_charge', 1],
        ],
      });
      depleted.data.set('charge', 0);
      unit.skills = [inactive, depleted];
      const gated = {
        active: hasCanto(unit, target, game),
        movement: cantoMovement(unit, target, game),
      };

      unit.movementLeft = 5;
      const actionLog = new ActionLog();
      const before = actionLog.actionIndex;
      actionLog.doAction(new SetMovementLeftAction(unit, 3));
      const after = actionLog.actionIndex;
      const applied = unit.movementLeft;
      while (actionLog.actionIndex > before) actionLog.runActionBackward();
      const reversed = unit.movementLeft;
      while (actionLog.actionIndex < after) actionLog.runActionForward();
      const redone = unit.movementLeft;

      const aiUnit = {
        team: 'enemy',
        position: [5, 5],
        skills: [],
        isDead: () => false,
      };
      const aiEnemy = {
        team: 'player',
        position: [8, 6],
        skills: [],
        isDead: () => false,
      };
      const validMoves = [[5, 5], [4, 5], [5, 4], [4, 4]];
      const aiController = new AIController(
        game.db,
        {
          getAllUnits: () => [aiUnit, aiEnemy],
        } as any,
        {
          getValidMoves: () => validMoves,
          getPath: (_unit: unknown, x: number, y: number) => [[5, 5], [x, y]],
        } as any,
      );
      const aiRetreat = aiController.getCantoRetreatAction(aiUnit as any);

      unit.skills = old.skills;
      unit.hasAttacked = old.attacked;
      unit.movementLeft = old.movementLeft;
      unit.stats = old.stats;
      return {
        canto,
        cantoPlus,
        sharpFull,
        sharpSpent,
        canter,
        evaluatedStars,
        controlled,
        maximum,
        gated,
        aiRetreat: aiRetreat && {
          type: aiRetreat.type,
          targetPosition: aiRetreat.targetPosition,
          movePath: aiRetreat.movePath,
        },
        replay: { applied, reversed, redone },
      };
    });

    expect(result).toEqual({
      canto: { enemy: false, self: true, movement: 2 },
      cantoPlus: true,
      sharpFull: true,
      sharpSpent: false,
      canter: { active: true, movement: 3 },
      evaluatedStars: 4,
      controlled: 1,
      maximum: 3,
      gated: { active: false, movement: 0 },
      aiRetreat: {
        type: 'move',
        targetPosition: [4, 4],
        movePath: [[5, 5], [4, 4]],
      },
      replay: { applied: 3, reversed: 5, redone: 3 },
    });
  });

  test('routes actual combat through Canter movement and EvalGaleforce reset', async ({
    page,
  }) => {
    await bootEotf(page);
    const setup = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { SkillObject } = await import('/src/objects/skill.ts');
      const { ItemObject } = await import('/src/objects/item.ts');
      const attacker = game.units.get('Player');
      const defender = game.units.get('Keeper');
      const adjacent = [
        [attacker.position[0] + 1, attacker.position[1]],
        [attacker.position[0] - 1, attacker.position[1]],
        [attacker.position[0], attacker.position[1] + 1],
        [attacker.position[0], attacker.position[1] - 1],
      ].find(([x, y]) => game.board.inBounds(x, y) &&
        (!game.board.getUnit(x, y) || game.board.getUnit(x, y) === defender));
      if (!adjacent) return null;
      const old = {
        attackerSkills: attacker.skills,
        attackerItems: attacker.items,
        attackerFlags: {
          hasAttacked: attacker.hasAttacked,
          hasMoved: attacker.hasMoved,
          hasTraded: attacker.hasTraded,
          finished: attacker.finished,
          movementLeft: attacker.movementLeft,
        },
        defenderPosition: defender.position ? [...defender.position] : null,
        defenderHp: defender.currentHp,
      };
      const item = new ItemObject({
        nid: '_CantoCombatWeapon',
        name: '',
        desc: '',
        icon_nid: '',
        icon_index: [0, 0],
        components: [
          ['weapon', null],
          ['damage', 0],
          ['hit', 100],
          ['uses', 10],
          ['min_range', 1],
          ['max_range', 1],
        ],
      });
      attacker.skills = [new SkillObject(game.db.skills.get('Canter3'))];
      attacker.items = [item];
      attacker.equippedWeapon = item;
      attacker.hasAttacked = false;
      attacker.hasMoved = true;
      attacker.hasTraded = false;
      attacker.finished = false;
      attacker.movementLeft = 1;
      defender.currentHp = Math.max(10, defender.currentHp);
      game.board.moveUnit(defender, adjacent[0], adjacent[1]);
      const actionStart = game.actionLog.actionIndex;
      game.selectedUnit = attacker;
      game.combatTarget = defender;
      game.combatScript = ['hit1'];
      game.memory.set('combat_item', item);
      (window as any).__cantoCombatTest = {
        attacker,
        defender,
        item,
        old,
        actionStart,
      };
      game.state.change('combat');
      return true;
    });
    expect(setup).toBe(true);
    await settle(page);

    const canter = await page.evaluate(() => {
      const game = (window as any).__gameRef;
      const test = (window as any).__cantoCombatTest;
      return {
        state: game.state.getCurrentState()?.name,
        attacked: test.attacker.hasAttacked,
        finished: test.attacker.finished,
        movementLeft: test.attacker.movementLeft,
        actionEnd: game.actionLog.actionIndex,
      };
    });
    expect(canter).toMatchObject({
      state: 'free_roam',
      attacked: true,
      finished: false,
      movementLeft: 3,
    });

    const galeforceSetup = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { SkillObject } = await import('/src/objects/skill.ts');
      const test = (window as any).__cantoCombatTest;
      game.state.clear();
      game.state.change('free');
      test.attacker.skills = [new SkillObject({
        nid: '_EvalGaleforce',
        name: '',
        desc: '',
        icon_nid: '',
        icon_index: [0, 0],
        components: [['eval_galeforce', 'True']],
      })];
      test.attacker.hasAttacked = false;
      test.attacker.hasMoved = true;
      test.attacker.finished = false;
      test.attacker.movementLeft = 1;
      game.selectedUnit = test.attacker;
      game.combatTarget = test.defender;
      game.combatScript = ['hit1'];
      game.memory.set('combat_item', test.item);
      game.state.change('combat');
      return true;
    });
    expect(galeforceSetup).toBe(true);
    await settle(page);

    const result = await page.evaluate(() => {
      const game = (window as any).__gameRef;
      const test = (window as any).__cantoCombatTest;
      const galeforce = {
        state: game.state.getCurrentState()?.name,
        attacked: test.attacker.hasAttacked,
        moved: test.attacker.hasMoved,
        finished: test.attacker.finished,
        movementLeft: test.attacker.movementLeft,
      };
      game.state.clear();
      game.state.change('free');
      test.attacker.skills = test.old.attackerSkills;
      test.attacker.items = test.old.attackerItems;
      Object.assign(test.attacker, test.old.attackerFlags);
      test.defender.currentHp = test.old.defenderHp;
      if (test.old.defenderPosition) {
        game.board.moveUnit(
          test.defender,
          test.old.defenderPosition[0],
          test.old.defenderPosition[1],
        );
      }
      delete (window as any).__cantoCombatTest;
      return galeforce;
    });

    expect(result).toEqual({
      state: 'menu',
      attacked: false,
      moved: false,
      finished: false,
      movementLeft: expect.any(Number),
    });
  });
});
