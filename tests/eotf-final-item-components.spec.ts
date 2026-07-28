import { expect, test, type Page } from '@playwright/test';

async function bootEotf(page: Page): Promise<void> {
  await page.goto('/?harness=true&project=eotf.ltproj&level=X&clean=true&bundle=false');
  await page.waitForFunction(() => (window as any).__harness?.ready === true, undefined, {
    timeout: 60_000,
  });
}

test.describe('Embrace of the Fog final project-local item components', () => {
  test('count-locks both boosters and Judge of Originators', async ({ page }) => {
    await bootEotf(page);
    const result = await page.evaluate(() => {
      const game = (window as any).__gameRef;
      const collect = (componentNid: string) => [...game.db.items.values()]
        .flatMap((item: any) => item.components
          .filter(([nid]: [string, unknown]) => nid === componentNid)
          .map(([, value]: [string, unknown]) => ({ item: item.nid, value })));
      return {
        boosters: collect('permanent_stat_change_early'),
        solomon: collect('solomon_heal'),
      };
    });

    expect(result).toEqual({
      boosters: [
        { item: 'Angelic_Robe', value: [['HP', 4]] },
        { item: 'Angelic_Robe_Plus', value: [['HP', 6]] },
      ],
      solomon: [{ item: 'Judge_of_Originators', value: 10 }],
    });
  });

  test('applies the early HP booster at its cap and replays item identity', async ({ page }) => {
    await bootEotf(page);
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { ItemObject } = await import('/src/objects/item.ts');
      const { applyCoreTargetedItem } =
        await import('/src/engine/states/game-states.ts');
      const { targetRestrict } = await import('/src/combat/item-system.ts');
      const unit = game.units.get('Player');
      const old = {
        items: unit.items,
        stats: { ...unit.stats },
        hp: unit.currentHp,
        finished: unit.finished,
      };
      const item = new ItemObject(game.db.items.get('Angelic_Robe'));
      unit.items = [item];
      unit.finished = false;
      const cap = unit.getStatCap('HP');
      unit.stats.HP = cap - 2;
      unit.currentHp = cap - 7;
      const position = [...unit.position] as [number, number];
      const restrictionContext = {
        board: game.board,
        db: game.db,
        game,
      };
      const belowCap = targetRestrict(
        unit,
        item,
        position,
        [],
        restrictionContext,
      );
      const beforeIndex = game.actionLog.actionIndex;
      const applied = applyCoreTargetedItem(unit, item, position);
      const afterIndex = game.actionLog.actionIndex;
      const changed = {
        stat: unit.stats.HP,
        hp: unit.currentHp,
        itemPresent: unit.items.includes(item),
        uses: item.uses,
      };
      const atCap = targetRestrict(
        unit,
        item,
        position,
        [],
        restrictionContext,
      );
      while (game.actionLog.actionIndex > beforeIndex) {
        game.actionLog.runActionBackward();
      }
      const reversed = {
        stat: unit.stats.HP,
        hp: unit.currentHp,
        itemPresent: unit.items.includes(item),
        sameItem: unit.items[0] === item,
        uses: item.uses,
      };
      while (game.actionLog.actionIndex < afterIndex) {
        game.actionLog.runActionForward();
      }
      const redone = {
        stat: unit.stats.HP,
        hp: unit.currentHp,
        itemPresent: unit.items.includes(item),
        uses: item.uses,
      };
      unit.items = old.items;
      unit.stats = old.stats;
      unit.currentHp = old.hp;
      unit.finished = old.finished;
      return { applied, belowCap, atCap, cap, changed, reversed, redone };
    });

    expect(result.applied).toBe(true);
    expect(result.belowCap).toBe(true);
    expect(result.atCap).toBe(false);
    expect(result.changed).toEqual({
      stat: result.cap,
      hp: result.cap - 5,
      itemPresent: false,
      uses: 0,
    });
    expect(result.reversed).toEqual({
      stat: result.cap - 2,
      hp: result.cap - 7,
      itemPresent: true,
      sameItem: true,
      uses: 1,
    });
    expect(result.redone).toEqual(result.changed);
  });

  test('resolves Solomon damage, Monster healing, death, and replay in combat', async ({ page }) => {
    await bootEotf(page);
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { ItemObject } = await import('/src/objects/item.ts');
      const { MapCombat } = await import('/src/combat/map-combat.ts');
      const attacker = game.units.get('Player');
      const defender = game.units.get('Keeper');
      const old = {
        attackerSkills: attacker.skills,
        defenderSkills: defender.skills,
        attackerStats: { ...attacker.stats },
        defenderStats: { ...defender.stats },
        defenderTags: [...defender.tags],
        attackerTeam: attacker.team,
        defenderTeam: defender.team,
        defenderHp: defender.currentHp,
        defenderDead: defender.dead,
        attackerItems: attacker.items,
      };
      attacker.skills = [];
      defender.skills = [];
      attacker.team = 'player';
      defender.team = 'enemy';
      attacker.stats.RES = 12;
      defender.stats.RES = 7;
      defender.tags = defender.tags.filter((tag: string) => tag !== 'Monster');
      defender.currentHp = 10;
      defender.dead = false;
      const damageItem = new ItemObject(
        game.db.items.get('Judge_of_Originators'),
      );
      attacker.items = [damageItem];
      const damageBeforeIndex = game.actionLog.actionIndex;
      const damageCombat = new MapCombat(
        attacker,
        damageItem,
        defender,
        null,
        game.db,
        'classic',
        game.board,
        ['hit1', 'end'],
        undefined,
        game,
      );
      const damageResults = damageCombat.applyResults(game.actionLog);
      const damageAfterIndex = game.actionLog.actionIndex;
      const damaged = {
        strikeDamage: damageCombat.strikes[0]?.damage,
        hp: defender.currentHp,
        dead: defender.dead,
        resultDead: damageResults.defenderDead,
      };
      while (game.actionLog.actionIndex > damageBeforeIndex) {
        game.actionLog.runActionBackward();
      }
      const damageReversed = {
        hp: defender.currentHp,
        dead: defender.dead,
        uses: damageItem.uses,
      };
      while (game.actionLog.actionIndex < damageAfterIndex) {
        game.actionLog.runActionForward();
      }
      const damageRedone = {
        hp: defender.currentHp,
        dead: defender.dead,
        uses: damageItem.uses,
      };
      defender.tags.push('Monster');
      defender.team = 'player';
      defender.currentHp = defender.maxHp - 3;
      defender.dead = false;
      const healItem = new ItemObject(
        game.db.items.get('Judge_of_Originators'),
      );
      attacker.items = [healItem];
      const healBeforeIndex = game.actionLog.actionIndex;
      const healCombat = new MapCombat(
        attacker,
        healItem,
        defender,
        null,
        game.db,
        'classic',
        game.board,
        ['hit1', 'end'],
        undefined,
        game,
      );
      healCombat.applyResults(game.actionLog);
      const healAfterIndex = game.actionLog.actionIndex;
      const healed = {
        strikeDamage: healCombat.strikes[0]?.damage,
        hp: defender.currentHp,
        maxHp: defender.maxHp,
        dead: defender.dead,
      };
      while (game.actionLog.actionIndex > healBeforeIndex) {
        game.actionLog.runActionBackward();
      }
      const healReversed = {
        hp: defender.currentHp,
        dead: defender.dead,
        uses: healItem.uses,
      };
      while (game.actionLog.actionIndex < healAfterIndex) {
        game.actionLog.runActionForward();
      }
      const healRedone = {
        hp: defender.currentHp,
        dead: defender.dead,
        uses: healItem.uses,
      };
      while (game.actionLog.actionIndex > healBeforeIndex) {
        game.actionLog.runActionBackward();
      }

      attacker.skills = old.attackerSkills;
      defender.skills = old.defenderSkills;
      attacker.stats = old.attackerStats;
      defender.stats = old.defenderStats;
      defender.tags = old.defenderTags;
      attacker.team = old.attackerTeam;
      defender.team = old.defenderTeam;
      defender.currentHp = old.defenderHp;
      defender.dead = old.defenderDead;
      attacker.items = old.attackerItems;
      return {
        damaged,
        damageReversed,
        damageRedone,
        healed,
        healReversed,
        healRedone,
      };
    });

    expect(result.damaged).toEqual({
      strikeDamage: 15,
      hp: 0,
      dead: true,
      resultDead: true,
    });
    expect(result.damageReversed).toEqual({ hp: 10, dead: false, uses: 3 });
    expect(result.damageRedone).toEqual({ hp: 0, dead: true, uses: 2 });
    expect(result.healed.strikeDamage).toBe(-8);
    expect(result.healed.hp).toBe(result.healed.maxHp);
    expect(result.healed.dead).toBe(false);
    expect(result.healReversed).toEqual({
      hp: result.healed.maxHp - 3,
      dead: false,
      uses: 3,
    });
    expect(result.healRedone).toEqual({
      hp: result.healed.maxHp,
      dead: false,
      uses: 2,
    });
  });
});
