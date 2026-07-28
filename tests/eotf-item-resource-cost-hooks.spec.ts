import { expect, test, type Page } from '@playwright/test';

async function bootEotf(page: Page): Promise<void> {
  await page.goto('/?harness=true&project=eotf.ltproj&level=X&clean=true&bundle=false');
  await page.waitForFunction(() => (window as any).__harness?.ready === true, undefined, {
    timeout: 60_000,
  });
}

test.describe('Embrace of the Fog item resource hooks', () => {
  test('enforces every authored stack and evaluated HP resource requirement', async ({ page }) => {
    await bootEotf(page);
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { ItemObject } = await import('/src/objects/item.ts');
      const { SkillObject } = await import('/src/objects/skill.ts');
      const { itemResourcesAvailable } =
        await import('/src/combat/item-resource-lifecycle.ts');
      const unit = game.units.get('Player');
      const oldSkills = unit.skills;
      const oldHp = unit.currentHp;
      const makeItem = (nid: string) => new ItemObject(game.db.items.get(nid));
      const makeSkill = (nid: string) => new SkillObject(game.db.skills.get(nid));

      const thunder = makeItem('Thunderstruck');
      unit.skills = [makeSkill('Thundersparks'), makeSkill('Thundersparks')];
      const thunderTwo = itemResourcesAvailable(unit, thunder, thunder.components, game);
      unit.skills.push(makeSkill('Thundersparks'));
      const thunderThree = itemResourcesAvailable(unit, thunder, thunder.components, game);

      const legion = makeItem('Eternal_Legion');
      game.gameVars.set(`${unit.nid}_eternal_legion_cost`, 2);
      unit.skills = [makeSkill('Sorrow'), makeSkill('Sorrow')];
      const legionTwo = itemResourcesAvailable(unit, legion, legion.components, game);
      unit.skills.push(makeSkill('Sorrow'));
      const legionThree = itemResourcesAvailable(unit, legion, legion.components, game);

      const aqua = makeItem('Aqua_Knife');
      unit.stats.HP = 30;
      unit.currentHp = 3;
      const aquaAtCost = itemResourcesAvailable(unit, aqua, aqua.components, game);
      unit.currentHp = 4;
      const aquaAboveCost = itemResourcesAvailable(unit, aqua, aqua.components, game);

      const counts = new Map<string, number>();
      const authored: Record<string, unknown[]> = {};
      const resourceComponents = new Set([
        'stack_cost', 'stack_cost_multi', 'eval_stack_cost',
        'eval_hp_cost', 'cooldown', 'start_cooldown',
      ]);
      for (const prefab of game.db.items.values()) {
        for (const [component, value] of prefab.components) {
          if (!resourceComponents.has(component)) continue;
          counts.set(component, (counts.get(component) ?? 0) + 1);
          (authored[component] ??= []).push(value);
        }
      }

      unit.skills = oldSkills;
      unit.currentHp = oldHp;
      game.gameVars.delete(`${unit.nid}_eternal_legion_cost`);
      return {
        thunderTwo, thunderThree, legionTwo, legionThree,
        aquaAtCost, aquaAboveCost,
        counts: Object.fromEntries(counts),
        stackSkills: authored.stack_cost,
        multiCosts: authored.stack_cost_multi,
        evalCosts: authored.eval_stack_cost,
        hpExpressions: authored.eval_hp_cost,
        cooldownValues: [...new Set(authored.cooldown as number[])].sort(),
      };
    });

    expect(result).toMatchObject({
      thunderTwo: false,
      thunderThree: true,
      legionTwo: false,
      legionThree: true,
      aquaAtCost: false,
      aquaAboveCost: true,
      counts: {
        stack_cost: 9,
        stack_cost_multi: 5,
        eval_stack_cost: 1,
        eval_hp_cost: 4,
        cooldown: 86,
        start_cooldown: 2,
      },
    });
    expect(result.stackSkills).toEqual([
      'Solar_Energy', 'HELPFUL_FRIENDS_STACK', 'Charged',
      'Convergeance', 'Convergeance', 'Lady_Crown', 'Lord_Crown',
      'Arcane_Manipulation', 'Final_Word',
    ]);
    expect(result.multiCosts).toEqual([
      { skill: 'Thundersparks', amount: 3 },
      { skill: 'Monarch_Rule', amount: 3 },
      { skill: 'Iron_Components', amount: 2 },
      { skill: 'Drive_Energy', amount: 6 },
      { skill: 'Grazing', amount: 3 },
    ]);
    expect(result.evalCosts).toEqual([{
      skill: 'Sorrow',
      amount: "v(unit.nid + '_eternal_legion_cost', 0) + 1",
    }]);
    expect(result.hpExpressions).toEqual([
      'unit.get_max_hp() // 10',
      'min(unit.get_max_hp() // 2, unit.get_hp() - 1)',
      'min(unit.get_max_hp() // 2, unit.get_hp() - 1)',
      'max(5, unit.get_hp() // 2)',
    ]);
    expect(result.cooldownValues).toEqual([1, 2, 3, 5]);
  });

  test('consumes exact stack instances and evaluated HP once with rewind and replay', async ({ page }) => {
    await bootEotf(page);
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { ItemObject } = await import('/src/objects/item.ts');
      const { SkillObject } = await import('/src/objects/skill.ts');
      const { ActionLog } = await import('/src/engine/action.ts');
      const {
        applyCombatItemStartHooks,
        applyCombatItemEndHooks,
      } = await import('/src/combat/combat-lifecycle.ts');
      const unit = game.units.get('Player');
      const defender = game.units.get('Keeper');
      const old = {
        skills: unit.skills,
        hp: unit.currentHp,
        stats: { ...unit.stats },
      };
      const makeSkill = (nid: string) => new SkillObject(game.db.skills.get(nid));
      const stacks = Array.from({ length: 4 }, () => makeSkill('Thundersparks'));
      const thunder = new ItemObject(game.db.items.get('Thunderstruck'));
      unit.skills = [...stacks];
      const stackGame = {
        ...game,
        actionLog: new ActionLog(),
        db: game.db,
        gameVars: game.gameVars,
        levelVars: game.levelVars,
      };

      const stackBefore = stackGame.actionLog.actionIndex;
      const removed = applyCombatItemStartHooks(stackGame, unit, thunder);
      const stackAfter = stackGame.actionLog.actionIndex;
      const remainingIdentity = unit.skills[0] === stacks[3];
      while (stackGame.actionLog.actionIndex > stackBefore) {
        stackGame.actionLog.runActionBackward();
      }
      const restoredIdentity = unit.skills.every(
        (skill: any, index: number) => skill === stacks[index],
      );
      while (stackGame.actionLog.actionIndex < stackAfter) {
        stackGame.actionLog.runActionForward();
      }
      const replayedSkills = unit.skills.map((skill: any) => skill.nid);

      while (stackGame.actionLog.actionIndex > stackBefore) {
        stackGame.actionLog.runActionBackward();
      }
      const aqua = new ItemObject(game.db.items.get('Aqua_Knife'));
      unit.stats.HP = 30;
      unit.currentHp = 30;
      const hpGame = {
        ...game,
        actionLog: new ActionLog(),
        db: game.db,
        gameVars: game.gameVars,
        levelVars: game.levelVars,
      };
      const hpBefore = hpGame.actionLog.actionIndex;
      const mark = {
        attacker: unit,
        defender,
        item: aqua,
        hit: false,
        isCounter: false,
        attackInfo: [0, 0] as [number, number],
        mode: 'attack',
      };
      const hpHooks = applyCombatItemEndHooks(hpGame, [mark, { ...mark, hit: true }] as any);
      const hpAfter = hpGame.actionLog.actionIndex;
      const hpUsed = unit.currentHp;
      while (hpGame.actionLog.actionIndex > hpBefore) hpGame.actionLog.runActionBackward();
      const hpRewound = unit.currentHp;
      while (hpGame.actionLog.actionIndex < hpAfter) hpGame.actionLog.runActionForward();
      const hpReplayed = unit.currentHp;

      while (hpGame.actionLog.actionIndex > hpBefore) hpGame.actionLog.runActionBackward();
      unit.skills = old.skills;
      unit.currentHp = old.hp;
      unit.stats = old.stats;
      return {
        removed, remainingIdentity, restoredIdentity, replayedSkills,
        hpHooks, hpUsed, hpRewound, hpReplayed,
      };
    });

    expect(result).toEqual({
      removed: 3,
      remainingIdentity: true,
      restoredIdentity: true,
      replayedSkills: ['Thundersparks'],
      hpHooks: 1,
      hpUsed: 27,
      hpRewound: 30,
      hpReplayed: 27,
    });
  });

  test('charges direct map item uses through the same reversible lifecycle', async ({ page }) => {
    await bootEotf(page);
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { ItemObject } = await import('/src/objects/item.ts');
      const { SkillObject } = await import('/src/objects/skill.ts');
      const { applyCoreTargetedItem } =
        await import('/src/engine/states/game-states.ts');
      const unit = game.units.get('Player');
      const old = {
        skills: unit.skills,
        hp: unit.currentHp,
        finished: unit.finished,
      };
      const stack = new SkillObject(game.db.skills.get('Sorrow'));
      unit.skills = [stack];
      unit.currentHp = Math.max(1, unit.maxHp - 2);
      const beforeHp = unit.currentHp;
      unit.finished = false;
      const item = new ItemObject({
        nid: '_EotfDirectResourceUse',
        name: 'Direct Resource Use',
        desc: '',
        icon_nid: '',
        icon_index: [0, 0],
        components: [
          ['usable', null],
          ['target_self', null],
          ['heal', 1],
          ['stack_cost', 'Sorrow'],
          ['cooldown', 2],
        ],
      });

      const before = game.actionLog.actionIndex;
      const applied = applyCoreTargetedItem(unit, item, [...unit.position]);
      const after = game.actionLog.actionIndex;
      const used = {
        hp: unit.currentHp,
        stacks: unit.skills.filter((skill: any) => skill.nid === 'Sorrow').length,
        cooldown: item.data.get('cooldown'),
      };
      while (game.actionLog.actionIndex > before) game.actionLog.runActionBackward();
      const rewound = {
        hp: unit.currentHp,
        sameStack: unit.skills[0] === stack,
        cooldown: item.data.get('cooldown'),
      };
      while (game.actionLog.actionIndex < after) game.actionLog.runActionForward();
      const replayed = {
        hp: unit.currentHp,
        stacks: unit.skills.filter((skill: any) => skill.nid === 'Sorrow').length,
        cooldown: item.data.get('cooldown'),
      };
      while (game.actionLog.actionIndex > before) game.actionLog.runActionBackward();
      unit.skills = old.skills;
      unit.currentHp = old.hp;
      unit.finished = old.finished;
      return { beforeHp, applied, used, rewound, replayed };
    });

    expect(result.applied).toBe(true);
    expect(result.used).toEqual({ hp: result.beforeHp + 1, stacks: 0, cooldown: 2 });
    expect(result.rewound).toEqual({ hp: result.beforeHp, sameStack: true, cooldown: 0 });
    expect(result.replayed).toEqual({ hp: result.beforeHp + 1, stacks: 0, cooldown: 2 });
  });

  test('initializes, starts, ticks, resets, rewinds, and replays cooldowns', async ({ page }) => {
    await bootEotf(page);
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { ItemObject } = await import('/src/objects/item.ts');
      const { SkillObject } = await import('/src/objects/skill.ts');
      const { available } = await import('/src/combat/item-system.ts');
      const { ActionLog } = await import('/src/engine/action.ts');
      const { buildSaveDict, restoreGameState } = await import('/src/engine/save.ts');
      const { getSkillAbilityOptions } =
        await import('/src/engine/states/game-states.ts');
      const {
        applyItemEndChapterResourceHooks,
        applyItemEndResourceHooks,
        applyItemUpkeepResourceHooks,
      } = await import('/src/combat/item-resource-lifecycle.ts');
      const unit = game.units.get('Player');
      const oldTurn = game.turnCount;
      const judgment = new ItemObject(game.db.items.get('Judgment'));
      unit.skills = [new SkillObject(game.db.skills.get('Rev_Up'))];
      const abilityOption = getSkillAbilityOptions(game, unit)[0];
      const ordinary = abilityOption.item;
      unit.items = [judgment];
      const lifecycleGame = {
        actionLog: new ActionLog(),
        gameVars: game.gameVars,
        levelVars: game.levelVars,
        turnCount: game.turnCount,
      };

      const rewind = (before: number) => {
        while (lifecycleGame.actionLog.actionIndex > before) {
          lifecycleGame.actionLog.runActionBackward();
        }
      };
      const replay = (after: number) => {
        while (lifecycleGame.actionLog.actionIndex < after) {
          lifecycleGame.actionLog.runActionForward();
        }
      };

      const initial = {
        judgment: judgment.data.get('cooldown'),
        ordinary: ordinary.data.get('cooldown'),
        judgmentAvailable: available(unit, judgment, game.db, game),
        ordinaryAvailable: available(unit, ordinary, game.db, game),
      };
      lifecycleGame.turnCount = 1;
      applyItemUpkeepResourceHooks(lifecycleGame, unit, [ordinary]);
      const firstTurn = judgment.data.get('cooldown');
      lifecycleGame.turnCount = 2;
      const tickBefore = lifecycleGame.actionLog.actionIndex;
      applyItemUpkeepResourceHooks(lifecycleGame, unit, [ordinary]);
      const tickAfter = lifecycleGame.actionLog.actionIndex;
      const secondTurn = judgment.data.get('cooldown');
      rewind(tickBefore);
      const tickRewound = judgment.data.get('cooldown');
      replay(tickAfter);
      const tickReplayed = judgment.data.get('cooldown');

      ordinary.setData('cooldown', 0);
      const useBefore = lifecycleGame.actionLog.actionIndex;
      applyItemEndResourceHooks(lifecycleGame, unit, ordinary);
      const useAfter = lifecycleGame.actionLog.actionIndex;
      const used = ordinary.data.get('cooldown');
      rewind(useBefore);
      const useRewound = ordinary.data.get('cooldown');
      replay(useAfter);
      const useReplayed = ordinary.data.get('cooldown');

      applyItemEndChapterResourceHooks(judgment);
      applyItemEndChapterResourceHooks(ordinary);
      const chapterReset = {
        judgment: judgment.data.get('cooldown'),
        ordinary: ordinary.data.get('cooldown'),
      };

      judgment.setData('cooldown', 4);
      ordinary.setData('cooldown', 1);
      const save = buildSaveDict(game);
      await restoreGameState(game, save);
      const restoredUnit = game.units.get('Player');
      const restoredJudgment = restoredUnit.items.find(
        (item: any) => item.nid === 'Judgment',
      );
      const restoredOrdinary = getSkillAbilityOptions(game, restoredUnit)[0]?.item;
      const saveRoundTrip = {
        judgment: restoredJudgment?.data.get('cooldown'),
        ordinary: restoredOrdinary?.data.get('cooldown'),
        abilityIdentity: game.items.get(
          restoredUnit.skills[0]?.data.get('abilityItemKey:ability'),
        ) === restoredOrdinary,
      };
      game.turnCount = oldTurn;
      return {
        initial, firstTurn, secondTurn, tickRewound, tickReplayed,
        used, useRewound, useReplayed, chapterReset, saveRoundTrip,
      };
    });

    expect(result).toEqual({
      initial: {
        judgment: 5,
        ordinary: 0,
        judgmentAvailable: false,
        ordinaryAvailable: true,
      },
      firstTurn: 5,
      secondTurn: 4,
      tickRewound: 5,
      tickReplayed: 4,
      used: 1,
      useRewound: 0,
      useReplayed: 1,
      chapterReset: {
        judgment: 5,
        ordinary: 0,
      },
      saveRoundTrip: {
        judgment: 4,
        ordinary: 1,
        abilityIdentity: true,
      },
    });
  });
});
