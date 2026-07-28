import { expect, test } from '@playwright/test';

test('one Rekka snapshot preserves rich item, skill, convoy, and pending-event state', async ({
  page,
}) => {
  await page.goto('/?harness=true&project=rekka.ltproj&level=0&clean=true&bundle=false');
  await page.waitForFunction(() => (window as any).__harness?.ready === true, {
    timeout: 60_000,
  });

  const result = await page.evaluate(async () => {
    const { AddSkillAction, EquipItemAction } = await import('/src/engine/action.ts');
    const { GameEvent } = await import('/src/events/event-manager.ts');
    const { ItemObject } = await import('/src/objects/item.ts');
    const { SkillObject } = await import('/src/objects/skill.ts');
    const game = (window as any).__gameRef;
    const unit = game.units.get('Lyn');
    const party = game.getParty();

    const stone = new ItemObject(game.db.items.get('Divinestone'));
    stone.owner = unit;
    stone.data.set('rekkaCustomState', { mode: 'dragon', turns: 3 });
    unit.items.push(stone);
    unit.onAddItem(stone);
    game.actionLog.doAction(new EquipItemAction(unit, stone));

    const accessory = new ItemObject(game.db.items.get('MoraleRing'));
    accessory.owner = unit;
    unit.items.push(accessory);
    unit.onAddItem(accessory);
    game.actionLog.doAction(new EquipItemAction(unit, accessory));

    let combatArt = unit.skills.find((skill: any) => skill.nid === 'ExhaustArt');
    if (!combatArt) {
      combatArt = new SkillObject(game.db.skills.get('ExhaustArt'));
      game.actionLog.doAction(new AddSkillAction(unit, combatArt));
    }
    combatArt.data.set('charge', 2);
    combatArt.data.set('total_charge', 3);
    combatArt.data.set('rekkaCustomState', 'ready');

    const multiSkill = new SkillObject(game.db.skills.get('CCCRRRRR'));
    game.actionLog.doAction(new AddSkillAction(unit, multiSkill));

    const temporaryStatus = new SkillObject({
      nid: '_RekkaTemporaryStatus',
      name: 'Rekka temporary status',
      desc: '',
      icon_nid: 'Skills',
      icon_index: [0, 0],
      components: [['time', 2]],
    });
    temporaryStatus.data.set('turns', 2);
    temporaryStatus.data.set('source', 'rekka-rich-save');
    temporaryStatus.components.set('dynamic_save_marker', { value: 7 });
    game.actionLog.doAction(new AddSkillAction(unit, temporaryStatus));

    const convoyItem = new ItemObject(game.db.items.get('Vulnerary'));
    convoyItem.data.set('rekkaCustomState', 'convoy');
    party.convoy.push(convoyItem);

    const eventPrefab = {
      nid: '_RekkaPendingSaveEvent',
      name: 'Rekka pending save event',
      trigger: 'test',
      level_nid: '0',
      condition: 'True',
      only_once: false,
      priority: 0,
      _source: ['wait;1000', 'game_var;rekka_pending_resumed;yes'],
    };
    game.db.events.set(eventPrefab.nid, eventPrefab);
    game.eventManager.eventQueue.push(new GameEvent(
      eventPrefab,
      { type: 'test', levelNid: '0' },
      () => game,
    ));

    const snapshot = (window as any).__harness.saveSnapshot();
    const loaded = await (window as any).__harness.loadSnapshot(snapshot);
    const restored = game.units.get('Lyn');
    const restoredStone = restored.items.find((item: any) => item.nid === 'Divinestone');
    const restoredAccessory = restored.items.find((item: any) => item.nid === 'MoraleRing');
    const restoredArt = restored.skills.find((skill: any) => skill.nid === 'ExhaustArt');
    const restoredTemporary = restored.skills.find((skill: any) =>
      skill.nid === '_RekkaTemporaryStatus' &&
      skill.data.get('source') === 'rekka-rich-save');
    const restoredRoot = restored.skills.find((skill: any) => skill.nid === 'CCCRRRRR');
    const restoredChild = restored.skills.find((skill: any) =>
      skill.data.get('multiSkillSource') === restoredRoot);
    const restoredConvoy = game.getParty().convoy.find((item: any) =>
      item.data.get('rekkaCustomState') === 'convoy');
    const pending = game.eventManager.getCurrentEvent();

    return {
      loaded,
      weapon: restored.equippedWeapon?.nid,
      weaponIdentity: restored.equippedWeapon === restoredStone,
      weaponCustomData: restoredStone?.data.get('rekkaCustomState'),
      accessory: restored.equippedAccessory?.nid,
      accessoryIdentity: restored.equippedAccessory === restoredAccessory,
      combatArt: {
        charge: restoredArt?.data.get('charge'),
        total: restoredArt?.data.get('total_charge'),
        custom: restoredArt?.data.get('rekkaCustomState'),
        component: restoredArt?.getComponent('combat_art'),
      },
      multiSkillIdentity: Boolean(restoredRoot && restoredChild),
      temporaryStatus: {
        turns: restoredTemporary?.data.get('turns'),
        dynamic: restoredTemporary?.getComponent('dynamic_save_marker'),
      },
      convoy: {
        nid: restoredConvoy?.nid,
        custom: restoredConvoy?.data.get('rekkaCustomState'),
      },
      pendingEvent: {
        nid: pending?.nid,
        pointer: pending?.commandPointer,
      },
    };
  });

  expect(result).toEqual({
    loaded: true,
    weapon: 'Divinestone',
    weaponIdentity: true,
    weaponCustomData: { mode: 'dragon', turns: 3 },
    accessory: 'MoraleRing',
    accessoryIdentity: true,
    combatArt: {
      charge: 2,
      total: 3,
      custom: 'ready',
      component: 'Exhaust',
    },
    multiSkillIdentity: true,
    temporaryStatus: {
      turns: 2,
      dynamic: { value: 7 },
    },
    convoy: {
      nid: 'Vulnerary',
      custom: 'convoy',
    },
    pendingEvent: {
      nid: '_RekkaPendingSaveEvent',
      pointer: 0,
    },
  });
});
