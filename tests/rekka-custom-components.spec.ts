import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

async function boot(page: Page): Promise<void> {
  await page.goto('/?harness=true&project=rekka.ltproj&level=0&clean=true&bundle=false');
  await page.waitForFunction(() => (window as any).__harness?.ready === true, {
    timeout: 30_000,
  });
  await page.evaluate(() => (window as any).__harness.stepFrames(3, null));
}

test.describe('Rekka project-local item components', () => {
  test('advance validates and reversibly moves both user and target', async ({ page }) => {
    await boot(page);
    const result = await page.evaluate(async () => {
      const { targetRestrict } = await import('/src/combat/item-system.ts');
      const { applyCombatItemEndHooks } = await import('/src/combat/combat-lifecycle.ts');
      const game = (window as any).__gameRef;
      const harness = (window as any).__harness;
      harness.giveItem('Lyn', 'TwoStepAbility');
      harness.warpUnit('Lyn', 10, 7);
      harness.warpUnit('101', 11, 7);
      const unit = game.units.get('Lyn');
      const target = game.units.get('101');
      const item = unit.items.find((candidate: any) => candidate.nid === 'TwoStepAbility');
      const valid = targetRestrict(unit, item, [11, 7], [], {
        board: game.board,
        db: game.db,
        game,
      });
      const applied = applyCombatItemEndHooks(game, [{
        attacker: unit,
        defender: target,
        item,
        hit: true,
        crit: false,
        damage: 0,
        isCounter: false,
      } as any]);
      const moved = {
        unit: [...unit.position],
        target: [...target.position],
      };
      const undoTarget = game.actionLog.undo();
      const undoUnit = game.actionLog.undo();
      const undone = {
        unit: [...unit.position],
        target: [...target.position],
      };
      undoUnit.execute();
      undoTarget.execute();
      return {
        valid,
        applied,
        moved,
        undone,
        redone: {
          unit: [...unit.position],
          target: [...target.position],
        },
      };
    });

    expect(result).toEqual({
      valid: true,
      applied: 2,
      moved: { unit: [12, 7], target: [13, 7] },
      undone: { unit: [10, 7], target: [11, 7] },
      redone: { unit: [12, 7], target: [13, 7] },
    });
  });

  test('gold_cost gates availability and spends money reversibly', async ({ page }) => {
    await boot(page);
    const result = await page.evaluate(async () => {
      const { available } = await import('/src/combat/item-system.ts');
      const { applyCombatItemStartHooks } = await import('/src/combat/combat-lifecycle.ts');
      const game = (window as any).__gameRef;
      const harness = (window as any).__harness;
      harness.giveItem('Lyn', 'GoldenWonder');
      const unit = game.units.get('Lyn');
      const item = unit.items.find((candidate: any) => candidate.nid === 'GoldenWonder');
      const party = game.getParty();
      party.money = 500;
      const availableAtCost = available(unit, item, game.db, game);
      const applied = applyCombatItemStartHooks(game, item);
      const afterSpend = party.money;
      const action = game.actionLog.undo();
      const afterUndo = party.money;
      party.money = 499;
      const unavailableBelowCost = available(unit, item, game.db, game);
      action.execute();
      return {
        availableAtCost,
        unavailableBelowCost,
        applied,
        afterSpend,
        afterUndo,
        afterRedo: party.money,
        actionName: action.constructor.name,
      };
    });

    expect(result).toEqual({
      availableAtCost: true,
      unavailableBelowCost: false,
      applied: 1,
      afterSpend: 0,
      afterUndo: 500,
      afterRedo: 0,
      actionName: 'GainMoneyAction',
    });
  });

  test('trace filters targets and creates a one-use copy with reversible identity', async ({ page }) => {
    await boot(page);
    const result = await page.evaluate(async () => {
      const { targetRestrict, traceItemRestrict } = await import('/src/combat/item-system.ts');
      const { applyCombatItemEndHooks } = await import('/src/combat/combat-lifecycle.ts');
      const game = (window as any).__gameRef;
      const harness = (window as any).__harness;
      harness.giveItem('Lyn', 'TraceAbility');
      harness.giveItem('101', 'DuelRing');
      harness.warpUnit('Lyn', 10, 7);
      harness.warpUnit('101', 11, 7);
      const unit = game.units.get('Lyn');
      const target = game.units.get('101');
      const trace = unit.items.find((candidate: any) => candidate.nid === 'TraceAbility');
      for (const existing of [...unit.items]) {
        if (existing === trace) continue;
        unit.items.splice(unit.items.indexOf(existing), 1);
        unit.onRemoveItem(existing);
      }
      unit.autoequip();
      const axe = target.items.find((candidate: any) => candidate.nid === 'Iron_Axe');
      const ring = target.items.find((candidate: any) => candidate.nid === 'DuelRing');
      const validTarget = targetRestrict(unit, trace, [11, 7], [], {
        board: game.board,
        db: game.db,
        game,
      });
      trace.data.set('target_item', axe);
      const beforeRegistry = new Set(game.items.values());
      const applied = applyCombatItemEndHooks(game, [{
        attacker: unit,
        defender: target,
        item: trace,
        hit: true,
        crit: false,
        damage: 0,
        isCounter: false,
      } as any]);
      const copy = unit.items.find((candidate: any) =>
        candidate.nid === 'Iron_Axe' && candidate !== axe);
      const registered = [...game.items.values()].includes(copy);
      const actions = [
        game.actionLog.undo(),
        game.actionLog.undo(),
        game.actionLog.undo(),
      ];
      const removed = !unit.items.includes(copy) &&
        ![...game.items.values()].includes(copy);
      for (const action of [...actions].reverse()) action.execute();
      const restored = unit.items.includes(copy) && [...game.items.values()].includes(copy);
      const snapshot = harness.saveSnapshot();
      const loaded = await harness.loadSnapshot(snapshot);
      const loadedUnit = game.units.get('Lyn');
      const loadedCopy = loadedUnit.items.find((candidate: any) =>
        candidate.nid === 'Iron_Axe' && candidate.uses === 1);
      return {
        validTarget,
        axeTraceable: traceItemRestrict(unit, axe, game.db),
        boardTarget: game.board.getUnit(11, 7)?.nid ?? null,
        unitItemCount: loadedUnit.items.length,
        ringTraceable: traceItemRestrict(unit, ring, game.db),
        applied,
        copiedNid: copy?.nid ?? null,
        copiedUses: copy?.uses ?? null,
        distinctIdentity: copy !== axe,
        registered,
        wasNewRegistryIdentity: !beforeRegistry.has(copy),
        actionNames: actions.map((action: any) => action.constructor.name),
        removed,
        restored,
        loaded,
        saveIdentityPreserved: !!loadedCopy && [...game.items.values()].includes(loadedCopy),
      };
    });

    expect(result).toEqual({
      validTarget: true,
      axeTraceable: true,
      boardTarget: '101',
      unitItemCount: 2,
      ringTraceable: false,
      applied: 3,
      copiedNid: 'Iron_Axe',
      copiedUses: 1,
      distinctIdentity: true,
      registered: true,
      wasNewRegistryIdentity: true,
      actionNames: ['GiveItemAction', 'SetItemUsesAction', 'RegisterItemTreeAction'],
      removed: true,
      restored: true,
      loaded: true,
      saveIdentityPreserved: true,
    });
  });
});

test.describe('Rekka project-local skill components', () => {
  test('givebacker adds missing HP to static damage', async ({ page }) => {
    await boot(page);
    const result = await page.evaluate(async () => {
      const { modifyDamage } = await import('/src/combat/skill-system.ts');
      const game = (window as any).__gameRef;
      const unit = game.units.get('Lyn');
      const prefab = game.db.skills.get('ReversalArt');
      const { SkillObject } = await import('/src/objects/skill.ts');
      unit.skills.push(new SkillObject(prefab));
      unit.currentHp = unit.getMaxHP() - 7;
      return {
        missingHp: unit.getMaxHP() - unit.currentHp,
        modifier: modifyDamage(unit, null),
      };
    });

    expect(result).toEqual({ missingHp: 7, modifier: 7 });
  });

  test('cannot_use_items_except_armor allows Gear and rejects other weapon types', async ({ page }) => {
    await boot(page);
    const result = await page.evaluate(async () => {
      const { available } = await import('/src/combat/item-system.ts');
      const { SkillObject } = await import('/src/objects/skill.ts');
      const { ItemObject } = await import('/src/objects/item.ts');
      const game = (window as any).__gameRef;
      const unit = game.units.get('Lyn');
      unit.skills.push(new SkillObject(game.db.skills.get('BunkerStatus')));
      // Rekka currently has no Gear prefab, so install the minimal synthetic
      // weapon proficiency needed to isolate the custom availability hook.
      game.db.classes.get(unit.klass).wexp_gain.Gear = [true, 0];
      unit.wexp.Gear = 1;
      const armor = new ItemObject({
        nid: 'TestArmor',
        name: 'Test Armor',
        desc: '',
        components: [['weapon_type', 'Gear']],
      });
      const weapon = new ItemObject({
        nid: 'TestSword',
        name: 'Test Sword',
        desc: '',
        components: [['weapon_type', 'Sword']],
      });
      return {
        armor: available(unit, armor, game.db, game),
        weapon: available(unit, weapon, game.db, game),
      };
    });

    expect(result).toEqual({ armor: true, weapon: false });
  });

  test('combat event hooks preserve Python strike and participant order', async ({ page }) => {
    await boot(page);
    const result = await page.evaluate(async () => {
      const {
        queueCombatSkillEvents,
        queueCombatSkillStartEvents,
      } = await import('/src/combat/combat-lifecycle.ts');
      const { SkillObject } = await import('/src/objects/skill.ts');
      const game = (window as any).__gameRef;
      const attacker = game.units.get('Lyn');
      const defender = game.units.get('101');
      const attackItem = attacker.items.find((item: any) => item.isWeapon());
      const defenseItem = defender.items.find((item: any) => item.isWeapon());
      attacker.skills = [new SkillObject({
        nid: 'TestAttackerHooks',
        name: 'Test Attacker Hooks',
        desc: '',
        components: [
          ['event_before_combat', 'attacker_before'],
          ['event_after_strike', 'after_strike'],
          ['event_after_hit', 'after_hit'],
          ['event_after_crit', 'after_crit'],
          ['event_after_combat', 'attacker_end'],
        ],
      })];
      defender.skills = [new SkillObject({
        nid: 'TestDefenderHooks',
        name: 'Test Defender Hooks',
        desc: '',
        components: [
          ['event_before_combat', 'defender_before'],
          ['event_when_hit', 'when_hit'],
          ['event_after_combat_when_hit', 'after_combat_hit'],
          ['event_after_combat', 'defender_end'],
        ],
      })];
      const calls: any[] = [];
      game.eventManager.triggerSpecific = (nid: string, trigger: any) => {
        calls.push({
          nid,
          type: trigger.type,
          unit1: trigger.unit1.nid,
          unit2: trigger.unit2.nid,
          item: trigger.localArgs.get('item')?.nid ?? null,
          item2: trigger.localArgs.get('item2')?.nid ?? null,
          mode: trigger.localArgs.get('mode'),
        });
        return true;
      };
      const start = queueCombatSkillStartEvents(
        game, attacker, defender, attackItem, defenseItem,
      );
      const end = queueCombatSkillEvents(game, [{
        attacker,
        defender,
        item: attackItem,
        hit: true,
        crit: true,
        damage: 8,
        isCounter: false,
        mode: 'attack',
        attackInfo: [0, 0],
      }], attacker, defender, attackItem, defenseItem);
      return { start, end, calls };
    });

    expect(result.start).toBe(2);
    expect(result.end).toBe(7);
    expect(result.calls.map((call: any) => call.nid)).toEqual([
      'attacker_before',
      'defender_before',
      'after_strike',
      'after_hit',
      'after_crit',
      'when_hit',
      'attacker_end',
      'after_combat_hit',
      'defender_end',
    ]);
    expect(result.calls[0]).toMatchObject({
      unit1: 'Lyn',
      unit2: '101',
      item: 'Iron_Sword',
      item2: 'Iron_Axe',
      mode: 'attack',
    });
    expect(result.calls[5]).toMatchObject({
      unit1: '101',
      unit2: 'Lyn',
      item: 'Iron_Axe',
      item2: 'Iron_Sword',
      mode: 'attack',
    });
  });

  test('event_on_upkeep uses the bearer payload and component order', async ({ page }) => {
    await boot(page);
    const result = await page.evaluate(async () => {
      const { applySkillTurnHooks } = await import('/src/engine/skill-turn-lifecycle.ts');
      const { SkillObject } = await import('/src/objects/skill.ts');
      const game = (window as any).__gameRef;
      const unit = game.units.get('Lyn');
      unit.skills = [new SkillObject({
        nid: 'TestUpkeepEvent',
        name: 'Test Upkeep Event',
        desc: '',
        components: [
          ['event_on_upkeep', 'upkeep_event'],
          ['upkeep_stat_change', [['STR', 1]]],
        ],
      })];
      const calls: any[] = [];
      game.eventManager.triggerSpecific = (nid: string, trigger: any) => {
        calls.push({
          nid,
          type: trigger.type,
          unit1: trigger.unit1.nid,
          unit2: trigger.unit2.nid,
          item: trigger.localArgs.get('item'),
          mode: trigger.localArgs.get('mode'),
        });
        return true;
      };
      const effects = applySkillTurnHooks(game, [unit], 'upkeep');
      return {
        calls,
        components: effects.map((effect: any) => effect.component),
        counter: unit.skills[0].data.get('counter'),
      };
    });

    expect(result).toEqual({
      calls: [{
        nid: 'upkeep_event',
        type: 'event_on_upkeep',
        unit1: 'Lyn',
        unit2: 'Lyn',
        item: null,
        mode: null,
      }],
      components: ['event_on_upkeep', 'upkeep_stat_change'],
      counter: 1,
    });
  });

  test('movement hooks reset and undo the full unit action state', async ({ page }) => {
    await boot(page);
    const result = await page.evaluate(async () => {
      const { applyCombatSkillEndHooks } = await import('/src/combat/combat-lifecycle.ts');
      const { SkillObject } = await import('/src/objects/skill.ts');
      const { ItemObject } = await import('/src/objects/item.ts');
      const game = (window as any).__gameRef;
      const unit = game.units.get('Lyn');
      const target = game.units.get('101');
      const weapon = unit.items.find((item: any) => item.isWeapon());
      const staff = new ItemObject({
        nid: 'TestStaff',
        name: 'Test Staff',
        desc: '',
        components: [['weapon_type', 'Staff']],
      });
      const cases = [
        {
          component: 'powerstaff',
          value: null,
          item: staff,
          strike: { hit: true },
        },
        {
          component: 'combat_artist',
          value: null,
          item: weapon,
          strike: { hit: true, attackProcs: [{ kind: 'attack_pre_proc', unit }] },
        },
        {
          component: 'second_wind',
          value: null,
          item: weapon,
          strike: { hit: false },
        },
        {
          component: 'eval_galeforce',
          value: 'True',
          item: weapon,
          strike: { hit: true },
        },
      ];
      const outcomes: any[] = [];
      for (const testCase of cases) {
        unit.skills = [new SkillObject({
          nid: `Test_${testCase.component}`,
          name: testCase.component,
          desc: '',
          components: [[testCase.component, testCase.value]],
        })];
        Object.assign(unit, {
          hasAttacked: true,
          hasMoved: true,
          hasTraded: true,
          finished: true,
          hasRescued: true,
          hasDropped: true,
          hasTaken: true,
          hasGiven: true,
          movementLeft: 1,
        });
        const applied = applyCombatSkillEndHooks(game, [{
          attacker: unit,
          defender: target,
          item: testCase.item,
          hit: testCase.strike.hit,
          crit: false,
          damage: 0,
          isCounter: false,
          mode: 'attack',
          attackInfo: [0, 0],
          attackProcs: testCase.strike.attackProcs,
        }], unit, target);
        const after = {
          finished: unit.finished,
          hasAttacked: unit.hasAttacked,
          hasRescued: unit.hasRescued,
          movementLeft: unit.movementLeft,
        };
        const action = game.actionLog.undo();
        const undone = {
          finished: unit.finished,
          hasAttacked: unit.hasAttacked,
          hasRescued: unit.hasRescued,
          movementLeft: unit.movementLeft,
        };
        action.execute();
        outcomes.push({
          component: testCase.component,
          applied,
          action: action.constructor.name,
          after,
          undone,
          redoneFinished: unit.finished,
        });
      }
      return outcomes;
    });

    expect(result).toEqual([
      'powerstaff',
      'combat_artist',
      'second_wind',
      'eval_galeforce',
    ].map((component) => ({
      component,
      applied: 1,
      action: 'ResetAction',
      after: {
        finished: false,
        hasAttacked: false,
        hasRescued: false,
        movementLeft: 6,
      },
      undone: {
        finished: true,
        hasAttacked: true,
        hasRescued: true,
        movementLeft: 1,
      },
      redoneFinished: false,
    })));
  });
});
