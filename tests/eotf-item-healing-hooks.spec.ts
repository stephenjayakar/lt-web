import { expect, test, type Page } from '@playwright/test';

async function bootEotf(page: Page): Promise<void> {
  await page.goto('/?harness=true&project=eotf.ltproj&level=X&clean=true&bundle=false');
  await page.waitForFunction(() => (window as any).__harness?.ready === true, undefined, {
    timeout: 30_000,
  });
}

test.describe('Embrace of the Fog item healing and restore hooks', () => {
  test('executes every authored healing value shape with exact modifiers', async ({ page }) => {
    await bootEotf(page);
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { ItemObject } = await import('/src/objects/item.ts');
      const { SkillObject } = await import('/src/objects/skill.ts');
      const { healAmount } = await import('/src/combat/item-system.ts');
      const healer = game.units.get('Player');
      const target = game.units.get('Keeper');
      const old = {
        healerSkills: healer.skills,
        targetSkills: target.skills,
        healerStats: { ...healer.stats },
        traveler: healer.traveler,
        targetTeam: target.team,
      };
      const makeItem = (nid: string) => new ItemObject(game.db.items.get(nid));
      const makeSkill = (nid: string) => new SkillObject(game.db.skills.get(nid));
      healer.skills = [];
      target.skills = [];
      healer.stats.HP = 40;

      const bubble = healAmount(healer, makeItem('Bubble_Heal'), target, game);
      target.stats.HP = 37;
      const elixir = healAmount(healer, makeItem('Elixir'), target, game);
      target.skills = Array.from({ length: 5 }, () => makeSkill('Vows'));
      const promised = healAmount(healer, makeItem('Promised_Heal'), target, game);

      healer.traveler = null;
      const riteUnpaired = healAmount(healer, makeItem('Rite_of_Starlight'), target, game);
      target.team = 'enemy';
      healer.traveler = target.nid;
      const riteEnemyPair = healAmount(healer, makeItem('Rite_of_Starlight'), target, game);

      healer.skills = [new SkillObject({
        nid: '_HealAddMult',
        name: '',
        desc: '',
        components: [['empower_heal', 2], ['empower_heal_multiplier', 2]],
      })];
      target.skills = [new SkillObject({
        nid: '_HealReceivedMult',
        name: '',
        desc: '',
        components: [
          ['empower_heal_received', 3],
          ['empower_heal_received_multiplier', 0.5],
        ],
      })];
      const evaluatedWithModifiers = healAmount(
        healer,
        makeItem('Bubble_Heal'),
        target,
        game,
      );
      const flatWithoutMultipliers = healAmount(
        healer,
        makeItem('Make_Friends'),
        target,
        game,
      );

      const wanted = new Set([
        'eval_heal', 'heal_no_target_restrict', 'refresh_no_target_restrict',
        'restore_no_target_restrict', 'restore_after_combat',
      ]);
      const authored: Record<string, unknown[]> = {};
      for (const prefab of game.db.items.values()) {
        for (const [component, value] of prefab.components) {
          if (wanted.has(component)) (authored[component] ??= []).push(value);
        }
      }

      healer.skills = old.healerSkills;
      target.skills = old.targetSkills;
      healer.stats = old.healerStats;
      healer.traveler = old.traveler;
      target.team = old.targetTeam;
      return {
        bubble, elixir, promised, riteUnpaired, riteEnemyPair,
        evaluatedWithModifiers, flatWithoutMultipliers, authored,
      };
    });

    expect(result).toMatchObject({
      bubble: 4,
      elixir: 37,
      promised: 2,
      riteUnpaired: 5,
      riteEnemyPair: 10,
      evaluatedWithModifiers: 9,
      flatWithoutMultipliers: 10,
    });
    expect(result.authored).toEqual({
      eval_heal: [
        "10 if unit.traveler and skill_system.check_enemy(unit, game.get_unit(unit.traveler)) else 5",
        'target.get_max_hp()',
        "len([s for s in target.skills if s.nid == 'Vows']) // 2",
        'unit.get_max_hp() // 10',
      ],
      restore_after_combat: [null, null],
      restore_no_target_restrict: [null, null],
      refresh_no_target_restrict: [null],
      heal_no_target_restrict: [5, 7, 2, 999],
    });
  });

  test('applies hit healing, unrestricted restore, and refresh reversibly', async ({ page }) => {
    await bootEotf(page);
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { ItemObject } = await import('/src/objects/item.ts');
      const { SkillObject } = await import('/src/objects/skill.ts');
      const { ActionLog } = await import('/src/engine/action.ts');
      const { applyCombatItemEndHooks } =
        await import('/src/combat/combat-lifecycle.ts');
      const healer = game.units.get('Player');
      const target = game.units.get('Keeper');
      const old = {
        hp: target.currentHp,
        skills: target.skills,
        healerSkills: healer.skills,
        finished: target.finished,
        hasMoved: target.hasMoved,
      };
      const makeLifecycleGame = () => ({
        ...game,
        actionLog: new ActionLog(),
        db: game.db,
        board: game.board,
        gameVars: game.gameVars,
        levelVars: game.levelVars,
      });
      const mark = (item: any) => ({
        attacker: healer,
        defender: target,
        item,
        hit: true,
        crit: false,
        damage: 0,
        isCounter: false,
        attackInfo: [0, 0] as [number, number],
        mode: 'attack',
      });
      const rewind = (hookGame: any, before: number) => {
        while (hookGame.actionLog.actionIndex > before) {
          hookGame.actionLog.runActionBackward();
        }
      };

      target.currentHp = Math.max(1, target.maxHp - 10);
      const healGame = makeLifecycleGame();
      const healBefore = healGame.actionLog.actionIndex;
      const healActions = applyCombatItemEndHooks(
        healGame,
        [mark(new ItemObject(game.db.items.get('Make_Friends')))] as any,
      );
      const healed = target.currentHp;
      rewind(healGame, healBefore);
      const healRewound = target.currentHp;

      const negative = new SkillObject(game.db.skills.get('Burning'));
      const secondNegative = new SkillObject(game.db.skills.get('Toxin'));
      target.skills = [negative];
      healer.skills = [secondNegative];
      const restoreGame = makeLifecycleGame();
      const restoreBefore = restoreGame.actionLog.actionIndex;
      const restoreActions = applyCombatItemEndHooks(
        restoreGame,
        (() => {
          const restoreItem = new ItemObject(game.db.items.get('Rainfall'));
          return [
            mark(restoreItem),
            { ...mark(restoreItem), item: restoreItem, defender: healer },
          ];
        })() as any,
      );
      const restored = [target.skills.length, healer.skills.length];
      rewind(restoreGame, restoreBefore);
      const restoreIdentity = target.skills[0] === negative &&
        healer.skills[0] === secondNegative;

      target.finished = false;
      target.hasMoved = true;
      const refreshGame = makeLifecycleGame();
      const refreshBefore = refreshGame.actionLog.actionIndex;
      const refreshActions = applyCombatItemEndHooks(
        refreshGame,
        [mark(new ItemObject({
          nid: '_RefreshNoRestrict',
          name: '',
          desc: '',
          icon_nid: '',
          icon_index: [0, 0],
          components: [['spell', null], ['refresh_no_target_restrict', null]],
        }))] as any,
      );
      const refreshed = { finished: target.finished, moved: target.hasMoved };
      rewind(refreshGame, refreshBefore);
      const refreshRewound = { finished: target.finished, moved: target.hasMoved };

      target.skills = [negative];
      const afterCombatGame = makeLifecycleGame();
      const afterCombatActions = applyCombatItemEndHooks(
        afterCombatGame,
        [mark(new ItemObject(game.db.items.get('CLEANING_MOP_MK2')))] as any,
      );
      const pythonBugPreserved = target.skills[0] === negative;

      target.currentHp = old.hp;
      target.skills = old.skills;
      healer.skills = old.healerSkills;
      target.finished = old.finished;
      target.hasMoved = old.hasMoved;
      return {
        healActions, healed, healRewound,
        restoreActions, restored, restoreIdentity,
        refreshActions, refreshed, refreshRewound,
        afterCombatActions, pythonBugPreserved,
      };
    });

    expect(result).toEqual({
      healActions: 1,
      healed: result.healRewound + 5,
      healRewound: result.healRewound,
      restoreActions: 2,
      restored: [0, 0],
      restoreIdentity: true,
      refreshActions: 1,
      refreshed: { finished: false, moved: false },
      refreshRewound: { finished: false, moved: true },
      afterCombatActions: 0,
      pythonBugPreserved: true,
    });
  });

  test('routes evaluated consumable healing directly and permits unrestricted targets', async ({ page }) => {
    await bootEotf(page);
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { ItemObject } = await import('/src/objects/item.ts');
      const {
        targetRestrict,
      } = await import('/src/combat/item-system.ts');
      const { applyCoreTargetedItem, resolveCombatTargetGroup } =
        await import('/src/engine/states/game-states.ts');
      const unit = game.units.get('Player');
      const oldHp = unit.currentHp;
      const item = new ItemObject({
        nid: '_EvalHealConsumable',
        name: '',
        desc: '',
        icon_nid: '',
        icon_index: [0, 0],
        components: [
          ['usable', null],
          ['target_self', null],
          ['eval_heal', 'target.get_max_hp()'],
          ['uses', 2],
        ],
      });
      unit.currentHp = unit.maxHp;
      const unrestricted = targetRestrict(
        unit,
        new ItemObject({
          nid: '_UnrestrictedUtilities',
          name: '',
          desc: '',
          icon_nid: '',
          icon_index: [0, 0],
          components: [
            ['target_ally', null],
            ['heal_no_target_restrict', 5],
            ['restore_no_target_restrict', null],
            ['refresh_no_target_restrict', null],
          ],
        }),
        [...unit.position],
        [],
        { board: game.board, db: game.db, game },
      );
      const adjacentEmpty = [
        [unit.position[0] + 1, unit.position[1]],
        [unit.position[0] - 1, unit.position[1]],
        [unit.position[0], unit.position[1] + 1],
        [unit.position[0], unit.position[1] - 1],
      ].find((position) =>
        game.board.checkBounds(position[0], position[1]) &&
        !game.board.getUnit(position[0], position[1]));
      const aoeItem = new ItemObject({
        nid: '_EmptyTileUtilityAoe',
        name: '',
        desc: '',
        icon_nid: '',
        icon_index: [0, 0],
        components: [
          ['spell', null],
          ['target_tile', null],
          ['ally_blast_aoe', 1],
          ['restore_no_target_restrict', null],
        ],
      });
      const emptyTileGroup = resolveCombatTargetGroup(
        game,
        unit,
        aoeItem,
        unit,
        adjacentEmpty,
      );

      const before = game.actionLog.actionIndex;
      const applied = applyCoreTargetedItem(unit, item, [...unit.position]);
      const after = game.actionLog.actionIndex;
      const used = { hp: unit.currentHp, uses: item.uses };
      while (game.actionLog.actionIndex > before) game.actionLog.runActionBackward();
      const rewound = { hp: unit.currentHp, uses: item.uses };
      while (game.actionLog.actionIndex < after) game.actionLog.runActionForward();
      const replayed = { hp: unit.currentHp, uses: item.uses };
      while (game.actionLog.actionIndex > before) game.actionLog.runActionBackward();
      unit.currentHp = oldHp;
      return {
        unrestricted,
        emptyTileGroup: {
          main: emptyTileGroup.mainDefender?.nid ?? null,
          splash: emptyTileGroup.splashDefenders.map((candidate: any) => candidate.nid),
          representative: emptyTileGroup.representative.nid,
        },
        applied, used, rewound, replayed,
      };
    });

    expect(result).toMatchObject({
      unrestricted: true,
      emptyTileGroup: {
        main: null,
        splash: expect.arrayContaining([result.emptyTileGroup.representative]),
      },
      applied: true,
      used: { uses: 1 },
      rewound: { uses: 2 },
      replayed: { uses: 1 },
    });
    expect(result.used.hp).toBe(result.rewound.hp);
    expect(result.replayed.hp).toBe(result.rewound.hp);
  });
});
