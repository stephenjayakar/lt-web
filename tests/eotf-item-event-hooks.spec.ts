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
      primary.items = [defenseItem];
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
});
