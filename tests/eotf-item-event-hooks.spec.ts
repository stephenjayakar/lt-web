import { expect, test, type Page } from '@playwright/test';

async function bootEotf(page: Page): Promise<void> {
  await page.goto('/?harness=true&project=eotf.ltproj&level=X&clean=true&bundle=false');
  await page.waitForFunction(() => (window as any).__harness?.ready === true, undefined, {
    timeout: 60_000,
  });
}

test.describe('Embrace of the Fog item event hooks', () => {
  test('count-locks every authored event value', async ({ page }) => {
    await bootEotf(page);
    const values = await page.evaluate(() => {
      const game = (window as any).__gameRef;
      const wanted = new Set([
        'event_before_combat',
        'event_for_each_after_combat_on_hit',
        'event_on_break',
      ]);
      const result: Record<string, unknown[]> = {};
      for (const item of game.db.items.values()) {
        for (const [nid, value] of item.components) {
          if (wanted.has(nid)) (result[nid] ??= []).push(value);
        }
      }
      return result;
    });

    expect(values).toEqual({
      event_on_break: ['Global Item_Edryd_Axe', 'Global Ability_Mockery_Break'],
      event_before_combat: [
        'Global Ability_Break_Verse_Start',
        'Global Ability_Tidal_Surge_Remove',
        'Global Ability_Hibernation',
        'Global Ability_Hibernation',
        'Global Ability_Big_Shove',
        'Global Ability_Big_Shove',
        'Global Ability_Disincorporate_Start',
      ],
      event_for_each_after_combat_on_hit: [
        'Global Item_Coil_Staff',
        'Global Ability_Skyflow_Confluence',
      ],
    });
  });

  test('queues pre-combat events with exact participant context', async ({ page }) => {
    await bootEotf(page);
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { ItemObject } = await import('/src/objects/item.ts');
      const { applyCombatItemStartHooks } =
        await import('/src/combat/combat-lifecycle.ts');
      const unit = game.units.get('Player');
      const target = game.units.get('Keeper');
      const item = new ItemObject(game.db.items.get('Verse'));
      const item2 = new ItemObject({
        nid: '_EventDefenseItem',
        name: '',
        desc: '',
        icon_nid: '',
        icon_index: [0, 0],
        components: [['weapon', null]],
      });
      const calls: any[] = [];
      const eventManager = {
        triggerSpecific(nid: string, trigger: any) {
          calls.push({ nid, trigger });
          return true;
        },
      };
      const queued = applyCombatItemStartHooks(
        { ...game, eventManager },
        unit,
        item,
        target,
        item2,
        'defense',
      );
      const call = calls[0];
      return {
        queued,
        nid: call.nid,
        type: call.trigger.type,
        unit1: call.trigger.unit1.nid,
        unit2: call.trigger.unit2.nid,
        unitNid: call.trigger.unitNid,
        position: call.trigger.position,
        itemIdentity: call.trigger.item === item &&
          call.trigger.localArgs.get('item') === item,
        item2Identity: call.trigger.localArgs.get('item2') === item2,
        mode: call.trigger.localArgs.get('mode'),
      };
    });

    expect(result).toEqual({
      queued: 1,
      nid: 'Global Ability_Break_Verse_Start',
      type: 'event_before_combat',
      unit1: 'Player',
      unit2: 'Keeper',
      unitNid: 'Player',
      position: result.position,
      itemIdentity: true,
      item2Identity: true,
      mode: 'defense',
    });
    expect(result.position).toHaveLength(2);
  });

  test('deduplicates per-hit targets and queues break events after uses reach zero', async ({
    page,
  }) => {
    await bootEotf(page);
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { ItemObject } = await import('/src/objects/item.ts');
      const { queueCombatItemBreakEvents, queueCombatItemEvents } =
        await import('/src/combat/combat-lifecycle.ts');
      const attacker = game.units.get('Player');
      const primary = game.units.get('Keeper');
      const secondary = [...game.units.values()].find(
        (unit: any) => unit !== attacker && unit !== primary,
      );
      if (!secondary) return null;
      const defenseItem = new ItemObject({
        nid: '_EventTargetWeapon',
        name: '',
        desc: '',
        icon_nid: '',
        icon_index: [0, 0],
        components: [['weapon', null]],
      });
      const oldPrimaryItems = primary.items;
      const oldPrimaryWeapon = primary.equippedWeapon;
      primary.items = [defenseItem];
      // item2 is the target's equipped weapon (Python resolve_weapon).
      primary.equippedWeapon = defenseItem;
      const coil = new ItemObject(game.db.items.get('Coil'));
      const mark = (defender: any, hit: boolean) => ({
        attacker,
        defender,
        item: coil,
        hit,
        crit: false,
        damage: 0,
        isCounter: false,
        mode: 'attack',
        attackInfo: [0, 0] as [number, number],
      });
      const perHitCalls: any[] = [];
      const perHitQueued = queueCombatItemEvents(
        {
          ...game,
          eventManager: {
            triggerSpecific(nid: string, trigger: any) {
              perHitCalls.push({ nid, trigger });
              return true;
            },
          },
        },
        [
          mark(primary, true),
          mark(primary, true),
          mark(secondary, true),
          mark(secondary, false),
        ] as any,
      );

      const broken = new ItemObject(game.db.items.get('Edryd_Axe'));
      broken.setUses(0);
      const intact = new ItemObject(game.db.items.get('Mockery'));
      intact.setUses(1);
      const breakCalls: any[] = [];
      const breakManager = {
        triggerSpecific(nid: string, trigger: any) {
          breakCalls.push({ nid, trigger });
          return true;
        },
      };
      const breakMark = (item: any) => ({
        attacker,
        defender: primary,
        item,
        hit: true,
        crit: false,
        damage: 0,
        isCounter: false,
        mode: 'attack',
        attackInfo: [0, 0] as [number, number],
      });
      const breakQueued = queueCombatItemBreakEvents(
        { ...game, eventManager: breakManager },
        [breakMark(broken)] as any,
      );
      const intactQueued = queueCombatItemBreakEvents(
        { ...game, eventManager: breakManager },
        [breakMark(intact)] as any,
      );
      primary.items = oldPrimaryItems;
      primary.equippedWeapon = oldPrimaryWeapon;

      return {
        perHitQueued,
        perHit: perHitCalls.map(({ nid, trigger }) => ({
          nid,
          type: trigger.type,
          unit1: trigger.unit1.nid,
          unit2: trigger.unit2.nid,
          targetFoe: trigger.localArgs.get('target_foe').nid,
          itemIdentity: trigger.localArgs.get('item') === coil,
          item2Identity: trigger.localArgs.get('item2') === defenseItem,
          mode: trigger.localArgs.get('mode'),
        })),
        breakQueued,
        intactQueued,
        breaks: breakCalls.map(({ nid, trigger }) => ({
          nid,
          type: trigger.type,
          unit1: trigger.unit1.nid,
          hasUnit2: !!trigger.unit2,
          itemIdentity: trigger.item === broken &&
            trigger.localArgs.get('item') === broken,
          localKeys: [...trigger.localArgs.keys()],
        })),
      };
    });

    expect(result).not.toBeNull();
    expect(result!.perHitQueued).toBe(2);
    expect(result!.perHit).toEqual([
      {
        nid: 'Global Item_Coil_Staff',
        type: 'event_for_each_after_combat_on_hit',
        unit1: 'Player',
        unit2: 'Keeper',
        targetFoe: 'Keeper',
        itemIdentity: true,
        item2Identity: true,
        mode: 'attack',
      },
      {
        nid: 'Global Item_Coil_Staff',
        type: 'event_for_each_after_combat_on_hit',
        unit1: 'Player',
        unit2: 'Keeper',
        targetFoe: result!.perHit[1].targetFoe,
        itemIdentity: true,
        item2Identity: true,
        mode: 'attack',
      },
    ]);
    expect(result!.perHit[1].targetFoe).not.toBe('Keeper');
    expect(result!.breakQueued).toBe(1);
    expect(result!.intactQueued).toBe(0);
    expect(result!.breaks).toEqual([{
      nid: 'Global Item_Edryd_Axe',
      type: 'event_on_break',
      unit1: 'Player',
      hasUnit2: false,
      itemIdentity: true,
      localKeys: ['item'],
    }]);
  });

  // Python: the item's map combat alerts its broken item in clean_up1, then
  // clean_up2 runs its events and WaitState's unit_wait comes last.
  test('a tile-targeted last use alerts "broke." before its after-use event and unit_wait', async ({ page }) => {
    await bootEotf(page);
    const setup = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { ItemObject } = await import('/src/objects/item.ts');
      const unit = game.units.get('Player');
      const [x, y] = unit.position;
      const tile = [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]].find(([tx, ty]) =>
        game.board.inBounds(tx, ty) && !game.board.getUnit(tx, ty));
      if (!tile) return null;
      const event = (nid: string, trigger: string, condition: string, key: string) => game.db.events.set(nid, {
        name: nid, nid, trigger, level_nid: game.currentLevel?.nid ?? null, condition,
        only_once: false, priority: 0, _source: [`game_var;${key};{e:v('_ord_step', 0)}`, `game_var;_ord_step;{e:v('_ord_step', 0) + 1}`],
      });
      event('_OrdAfterUse', '_OrdAfterUse', 'True', '_ord_after_use');
      event('_OrdWait', 'unit_wait', "unit1.nid == 'Player' and not actively_chosen", '_ord_wait');
      game.gameVars.set('_ord_step', 1);
      const item = new ItemObject({
        nid: '_OrdFlare', name: 'Flare', desc: '', icon_nid: '', icon_index: [0, 0],
        components: [
          ['spell', null], ['target_tile', null], ['uses', 1], ['min_range', 1], ['max_range', 1],
          ['event_after_use', '_OrdAfterUse'],
        ],
      });
      item.owner = unit;
      unit.items = [item];
      unit.resetTurnState();
      game.selectedUnit = unit;
      game.memory.set('item_use_item', item);
      game.state.change('item_targeting');
      (window as any).__ordTile = tile;
      return tile;
    });
    expect(setup).not.toBeNull();
    await page.evaluate(() => (window as any).__harness.stepFrames(2, null));
    const order = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const harness = (window as any).__harness;
      const state = game.state.getCurrentState();
      const [tx, ty] = (window as any).__ordTile;
      state.selectTarget(state.targets.findIndex(([x, y]: [number, number]) => x === tx && y === ty));
      let alertAt: number | null = null;
      let text: string | null = null;
      for (let frame = 0; frame < 600; frame++) {
        harness.stepFrames(1, null);
        if (alertAt === null && game.state.getCurrentState()?.name === 'alert') {
          alertAt = Number(game.gameVars.get('_ord_step'));
          const alerts = game.memory.get('alerts') ?? [];
          text = alerts[alerts.length - 1]?.text ?? null;
        }
        if (game.gameVars.get('_ord_wait') !== undefined) break;
      }
      return {
        alertAt, text,
        afterUse: game.gameVars.get('_ord_after_use'),
        wait: game.gameVars.get('_ord_wait'),
        finished: game.units.get('Player').finished,
      };
    });
    // The alert shows while nothing has run (step 1), then the event, then unit_wait.
    expect(order).toEqual({ alertAt: 1, text: '<blue>Flare</> broke.', afterUse: 1, wait: 2, finished: true });
  });
});
