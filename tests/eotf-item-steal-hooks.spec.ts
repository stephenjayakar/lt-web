import { expect, test, type Page } from '@playwright/test';

async function bootEotf(page: Page): Promise<void> {
  await page.goto('/?harness=true&project=eotf.ltproj&level=X&clean=true&bundle=false');
  await page.waitForFunction(() => (window as any).__harness?.ready === true, undefined, {
    timeout: 30_000,
  });
}

test.describe('Embrace of the Fog custom theft items', () => {
  test('count-locks the five authored null-valued theft components', async ({ page }) => {
    await bootEotf(page);
    const authored = await page.evaluate(() => {
      const game = (window as any).__gameRef;
      const wanted = new Set(['steal_con', 'gimme_that', 'thief_staff']);
      const entries: Array<{ item: string; component: string; value: unknown }> = [];
      for (const item of game.db.items.values()) {
        for (const [component, value] of item.components) {
          if (wanted.has(component)) entries.push({ item: item.nid, component, value });
        }
      }
      return entries.sort((left, right) => left.item.localeCompare(right.item));
    });

    expect(authored).toEqual([
      { item: 'Gimme_That', component: 'gimme_that', value: null },
      { item: 'Steal_Plus', component: 'steal_con', value: null },
      { item: 'Steal_Plus_Free', component: 'steal_con', value: null },
      { item: 'Steal_Plus_Motivation', component: 'steal_con', value: null },
      { item: 'Thief', component: 'thief_staff', value: null },
    ]);
  });

  test('matches speed, strength, constitution, equipment, lock, and overflow gates', async ({
    page,
  }) => {
    await bootEotf(page);
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { UnitObject } = await import('/src/objects/unit.ts');
      const { ItemObject } = await import('/src/objects/item.ts');
      const {
        inventoryCapacity,
        stealItemRestrict,
        stealTargetStatRestrict,
      } = await import('/src/combat/item-system.ts');
      const template = game.units.get('Player');
      const klass = game.db.classes.get(template.klass);
      const makeUnit = (nid: string, team: string) => {
        const unit = new UnitObject({
          nid, name: nid, desc: '', variant: null, level: 1, klass: template.klass,
          tags: [], bases: {
            ...klass.bases,
            HP: 30, STR: 12, MAG: 0, SKL: 10, SPD: 10,
            LCK: 0, DEF: 0, RES: 0, CON: 5, MOV: 5,
          },
          growths: {}, stat_cap_modifiers: {}, starting_items: [],
          learned_skills: [], unit_notes: [], fields: [], wexp_gain: {},
          portrait_nid: '', affinity: '',
        }, klass);
        unit.team = team;
        unit.items = [];
        return unit;
      };
      const makeItem = (nid: string, components: [string, unknown][]) =>
        new ItemObject({
          nid, name: nid, desc: '', icon_nid: '', icon_index: [0, 0], components,
        });

      const stealer = makeUnit('_Stealer', 'player');
      const defender = makeUnit('_Defender', 'enemy');
      defender.stats.SPD = 9;
      defender.stats.STR = 7;
      const stealCon = makeItem('_StealCon', [['steal_con', null]]);
      const gimme = makeItem('_Gimme', [['gimme_that', null]]);
      const thiefStaff = makeItem('_ThiefStaff', [['thief_staff', null]]);
      const light = makeItem('_Light', [['weight', 5]]);
      const heavy = makeItem('_Heavy', [['weight', 6]]);
      const locked = makeItem('_Locked', [['locked', null]]);
      const weapon = makeItem('_Weapon', [['weapon', null], ['weight', 5]]);
      defender.items = [light, heavy, locked, weapon];
      defender.equippedWeapon = weapon;

      const unitGates = {
        stealConPass: stealTargetStatRestrict(stealer, stealCon, defender, 10, 9),
        stealConSpeedFail: stealTargetStatRestrict(stealer, stealCon, defender, 8, 9),
        gimmePass: stealTargetStatRestrict(stealer, gimme, defender, 10, 9),
        gimmeStrengthFail: (() => {
          defender.stats.STR = 8;
          const allowed = stealTargetStatRestrict(stealer, gimme, defender, 10, 9);
          defender.stats.STR = 7;
          return allowed;
        })(),
        thiefIgnoresSpeed: stealTargetStatRestrict(stealer, thiefStaff, defender, 0, 99),
      };
      const itemGates = {
        stealConLight: stealItemRestrict(stealer, stealCon, defender, light, game.db),
        stealConHeavy: stealItemRestrict(stealer, stealCon, defender, heavy, game.db),
        stealConEquipped: stealItemRestrict(stealer, stealCon, defender, weapon, game.db),
        gimmeEquipped: stealItemRestrict(stealer, gimme, defender, weapon, game.db),
        thiefEquipped: stealItemRestrict(stealer, thiefStaff, defender, weapon, game.db),
        thiefHeavy: stealItemRestrict(stealer, thiefStaff, defender, heavy, game.db),
        locked: stealItemRestrict(stealer, gimme, defender, locked, game.db),
      };

      const capacity = inventoryCapacity(stealer, false, game.db);
      stealer.items = Array.from(
        { length: capacity },
        (_, index) => makeItem(`_Filler${index}`, []),
      );
      const playerOverflow = stealItemRestrict(stealer, stealCon, defender, light, game.db);
      stealer.team = 'enemy';
      const enemyOverflow = stealItemRestrict(stealer, stealCon, defender, light, game.db);
      return { unitGates, itemGates, playerOverflow, enemyOverflow };
    });

    expect(result).toEqual({
      unitGates: {
        stealConPass: true,
        stealConSpeedFail: false,
        gimmePass: true,
        gimmeStrengthFail: false,
        thiefIgnoresSpeed: true,
      },
      itemGates: {
        stealConLight: true,
        stealConHeavy: false,
        stealConEquipped: false,
        gimmeEquipped: true,
        thiefEquipped: false,
        thiefHeavy: true,
        locked: false,
      },
      playerOverflow: true,
      enemyOverflow: false,
    });
  });

  test('routes item choice, AI selection, hit transfer, records, and replay', async ({ page }) => {
    await bootEotf(page);
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { UnitObject } = await import('/src/objects/unit.ts');
      const { ItemObject } = await import('/src/objects/item.ts');
      const { ItemTargetingState } = await import('/src/engine/states/game-states.ts');
      const { applyCombatComponents } = await import('/src/combat/combat-components.ts');
      const { applyStolenItemTransfer } = await import('/src/combat/combat-lifecycle.ts');
      const { inventoryCapacity } = await import('/src/combat/item-system.ts');
      const { ActionLog } = await import('/src/engine/action.ts');
      const attacker = game.units.get('Player');
      if (!attacker?.position) return null;
      const klass = game.db.classes.get(attacker.klass);
      const defender = new UnitObject({
        nid: '_TheftTarget', name: '', desc: '', variant: null, level: 1,
        klass: attacker.klass, tags: [], bases: { ...klass.bases },
        growths: {}, stat_cap_modifiers: {}, starting_items: [],
        learned_skills: [], unit_notes: [], fields: [], wexp_gain: {},
        portrait_nid: '', affinity: '',
      }, klass);
      defender.team = 'enemy';
      const makeItem = (nid: string, components: [string, unknown][]) =>
        new ItemObject({
          nid, name: nid, desc: '', icon_nid: '', icon_index: [0, 0], components,
        });
      const theftItem = makeItem('_EotfTheft', [
        ['spell', null], ['target_enemy', null], ['min_range', 1], ['max_range', 1],
        ['thief_staff', null], ['hit', 100],
      ]);
      const cheap = makeItem('_Cheap', [['value', 10]]);
      const valuable = makeItem('_Valuable', [['value', 999]]);
      const locked = makeItem('_Locked', [['locked', null], ['value', 9999]]);
      theftItem.owner = attacker;
      cheap.owner = defender;
      valuable.owner = defender;
      locked.owner = defender;
      const capacity = inventoryCapacity(attacker, false, game.db);
      const fillers = Array.from(
        { length: Math.max(0, capacity - 1) },
        (_, index) => makeItem(`_TheftFiller${index}`, []),
      );
      attacker.items = [theftItem, ...fillers];
      attacker.items.forEach((item: any) => { item.owner = attacker; });
      defender.items = [cheap, valuable, locked];
      defender.equippedWeapon = null;
      attacker.stats.SPD = 0;
      defender.stats.SPD = 99;

      const adjacent = [[1, 0], [-1, 0], [0, 1], [0, -1]]
        .map(([dx, dy]) => [attacker.position[0] + dx, attacker.position[1] + dy] as [number, number])
        .find(([x, y]) => game.board.inBounds(x, y) && !game.board.getUnit(x, y));
      if (!adjacent) return null;
      game.board.setUnit(adjacent[0], adjacent[1], defender);

      game.selectedUnit = attacker;
      game.memory.set('item_use_item', theftItem);
      const targeting = new ItemTargetingState();
      targeting.begin();
      const targetIndex = (targeting as any).targets.findIndex(
        ([x, y]: [number, number]) => x === adjacent[0] && y === adjacent[1],
      );
      if (targetIndex >= 0) (targeting as any).selectTarget(targetIndex);
      const choiceNids = (targeting as any).selectableTargetItems.map(
        (item: any) => item.nid,
      );

      const aiAction = (game.aiController as any).stealPrimaryAI(
        attacker,
        [attacker.position],
        [defender],
      );
      const ai = {
        type: aiAction?.type ?? null,
        item: aiAction?.item?.nid ?? null,
        targetItem: aiAction?.targetItem?.nid ?? null,
      };

      theftItem.data.set('target_item', valuable);
      const strike = {
        attacker, defender, item: theftItem, hit: true, crit: false, damage: 0,
        isCounter: false, mode: 'attack', attackInfo: [0, 0] as [number, number],
      };
      const componentResult = applyCombatComponents(
        attacker,
        theftItem,
        defender,
        null,
        [strike] as any,
        false,
        false,
        game.db,
      );
      const actionLog = new ActionLog();
      const recordsBefore = game.records.steal.length;
      const pendingDiscard = applyStolenItemTransfer(
        actionLog,
        game.db,
        attacker,
        defender,
        componentResult.stolenItem!,
      );
      const snapshot = () => ({
        attackerHas: attacker.items.includes(valuable),
        defenderHas: defender.items.includes(valuable),
        records: game.records.steal.length - recordsBefore,
        targetDataCleared: !theftItem.data.has('target_item'),
      });
      const applied = snapshot();
      while (actionLog.actionIndex >= 0) actionLog.runActionBackward();
      const reversed = snapshot();
      while (actionLog.actionIndex < actionLog.actions.length - 1) {
        actionLog.runActionForward();
      }
      const redone = snapshot();
      return {
        choiceNids,
        ai,
        combatUseEffect: theftItem.hasCombatUseEffect(),
        resolved: componentResult.stolenItem?.nid ?? null,
        pendingDiscard: pendingDiscard
          ? {
              unit: pendingDiscard.unit.nid,
              item: pendingDiscard.item.nid,
            }
          : null,
        applied,
        reversed,
        redone,
      };
    });

    expect(result).not.toBeNull();
    expect(result!.choiceNids).toEqual(['_Cheap', '_Valuable']);
    expect(result!.ai).toEqual({
      type: 'steal',
      item: '_EotfTheft',
      targetItem: '_Valuable',
    });
    expect(result!.combatUseEffect).toBe(true);
    expect(result!.resolved).toBe('_Valuable');
    expect(result!.pendingDiscard).toEqual({
      unit: 'Player',
      item: '_Valuable',
    });
    expect(result!.applied).toEqual({
      attackerHas: true,
      defenderHas: false,
      records: 1,
      targetDataCleared: true,
    });
    expect(result!.reversed).toEqual({
      attackerHas: false,
      defenderHas: true,
      records: 0,
      targetDataCleared: true,
    });
    expect(result!.redone).toEqual(result!.applied);
  });
});
