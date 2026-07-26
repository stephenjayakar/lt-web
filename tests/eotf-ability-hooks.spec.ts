import { expect, test, type Page } from '@playwright/test';

async function bootEotf(page: Page): Promise<void> {
  await page.goto('/?harness=true&project=eotf.ltproj&level=X&clean=true&bundle=false');
  await page.waitForFunction(() => (window as any).__harness?.ready === true, undefined, {
    timeout: 30_000,
  });
}

test.describe('Embrace of the Fog skill abilities', () => {
  test('surfaces a charged combat ability with stable item identity and one charge per combat', async ({
    page,
  }) => {
    await bootEotf(page);
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const harness = (window as any).__harness;
      const { SkillObject } = await import('/src/objects/skill.ts');
      const {
        getSkillAbilityOptions,
        MenuState,
      } = await import('/src/engine/states/game-states.ts');
      const { applyCombatSkillEndHooks } =
        await import('/src/combat/combat-lifecycle.ts');
      const unit = game.units.get('Player');
      const target = game.units.get('Keeper');
      harness.warpUnit(unit.nid, 5, 5);
      harness.warpUnit(target.nid, 6, 5);
      unit.team = 'player';
      target.team = 'enemy';
      unit.finished = false;
      unit.hasAttacked = false;
      const skill = new SkillObject(game.db.skills.get('Sucker_Punch'));
      unit.skills = [skill];
      game.selectedUnit = unit;

      const first = getSkillAbilityOptions(game, unit);
      const second = getSkillAbilityOptions(game, unit);
      const option = first[0];
      const registryKey = skill.data.get('abilityItemKey:ability_attack_charge');
      const menuState = new MenuState();
      menuState.begin();
      const menu = (menuState as any).menu;
      const menuOptions = menu.options.map((candidate: any) => ({
        label: candidate.label,
        value: candidate.value,
      }));
      menu.selectedIndex = menu.options.findIndex((candidate: any) =>
        candidate.label === 'Sucker Punch');
      menuState.takeInput('SELECT');
      const routedItem = game.memory.get('item_use_item');

      const strike = (attackInfo: [number, number]) => ({
        attacker: unit,
        defender: target,
        item: option.item,
        hit: true,
        crit: false,
        damage: 1,
        isCounter: false,
        mode: 'attack',
        attackInfo,
      });
      const beforeIndex = game.actionLog.actionIndex;
      const before = skill.data.get('charge');
      applyCombatSkillEndHooks(
        game,
        [strike([0, 0]), strike([0, 1])],
        unit,
        target,
      );
      const afterIndex = game.actionLog.actionIndex;
      const changed = skill.data.get('charge');
      while (game.actionLog.actionIndex > beforeIndex) game.actionLog.runActionBackward();
      const reversed = skill.data.get('charge');
      while (game.actionLog.actionIndex < afterIndex) game.actionLog.runActionForward();
      const redone = skill.data.get('charge');

      return {
        option: {
          component: option.component,
          skill: option.skill.nid,
          item: option.item.nid,
          owner: option.item.owner?.nid,
        },
        stableIdentity: first[0].item === second[0].item,
        registeredIdentity: game.items.get(registryKey) === option.item,
        menuOptions,
        routedIdentity: routedItem === option.item,
        charges: { before, changed, reversed, redone },
        value: game.db.skills.get('Sucker_Punch')?.components.find(
          ([nid]: [string, any]) => nid === 'ability_attack_charge',
        )?.[1],
      };
    });

    expect(result.option).toEqual({
      component: 'ability_attack_charge',
      skill: 'Sucker_Punch',
      item: 'Sucker_Punch',
      owner: 'Player',
    });
    expect(result.stableIdentity).toBe(true);
    expect(result.registeredIdentity).toBe(true);
    expect(result.menuOptions).toContainEqual(expect.objectContaining({
      label: 'Sucker Punch',
    }));
    expect(result.routedIdentity).toBe(true);
    expect(result.charges).toEqual({
      before: 2,
      changed: 1,
      reversed: 2,
      redone: 1,
    });
    expect(result.value).toBe('Sucker_Punch');
  });

  test('round-trips a generated ability item through a real save restore', async ({ page }) => {
    await bootEotf(page);
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { SkillObject } = await import('/src/objects/skill.ts');
      const { getSkillAbilityOptions } =
        await import('/src/engine/states/game-states.ts');
      const { buildSaveDict, restoreGameState } = await import('/src/engine/save.ts');
      const unit = game.units.get('Player');
      unit.skills = [new SkillObject(game.db.skills.get('Capture'))];
      const beforeOption = getSkillAbilityOptions(game, unit)[0];
      beforeOption.item.data.set('_abilityRoundTrip', 37);
      const registryKey = beforeOption.skill.data.get('abilityItemKey:ability');
      const save = buildSaveDict(game);
      const savedItem = save.items.find((entry: any) => entry.mapKey === registryKey);
      await restoreGameState(game, save);
      const restoredUnit = game.units.get('Player');
      const restoredOption = getSkillAbilityOptions(game, restoredUnit)[0];
      return {
        registryKey,
        saved: {
          nid: savedItem?.nid,
          marker: savedItem?.data?.find(
            ([key]: [string, any]) => key === '_abilityRoundTrip',
          )?.[1],
        },
        restored: {
          item: restoredOption.item.nid,
          owner: restoredOption.item.owner?.nid,
          marker: restoredOption.item.data.get('_abilityRoundTrip'),
          registryIdentity: game.items.get(registryKey) === restoredOption.item,
          skillKey: restoredOption.skill.data.get('abilityItemKey:ability'),
        },
      };
    });

    expect(result.saved).toEqual({ nid: 'Capture', marker: 37 });
    expect(result.restored).toEqual({
      item: 'Capture',
      owner: 'Player',
      marker: 37,
      registryIdentity: true,
      skillKey: result.registryKey,
    });
  });

  test('consumes a standard ability charge after a reversible utility use', async ({ page }) => {
    await bootEotf(page);
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { SkillObject } = await import('/src/objects/skill.ts');
      const {
        applyCoreTargetedItem,
        getSkillAbilityOptions,
      } = await import('/src/engine/states/game-states.ts');
      const unit = game.units.get('Player');
      const skill = new SkillObject(game.db.skills.get('Patchwork'));
      unit.skills = [skill];
      unit.currentHp = Math.max(1, unit.maxHp - 10);
      const option = getSkillAbilityOptions(game, unit)[0];
      const beforeIndex = game.actionLog.actionIndex;
      const before = { hp: unit.currentHp, charge: skill.data.get('charge') };
      const applied = applyCoreTargetedItem(unit, option.item, unit.position);
      const afterIndex = game.actionLog.actionIndex;
      const changed = { hp: unit.currentHp, charge: skill.data.get('charge') };
      while (game.actionLog.actionIndex > beforeIndex) game.actionLog.runActionBackward();
      const reversed = { hp: unit.currentHp, charge: skill.data.get('charge') };
      while (game.actionLog.actionIndex < afterIndex) game.actionLog.runActionForward();
      const redone = { hp: unit.currentHp, charge: skill.data.get('charge') };
      return {
        applied,
        before,
        changed,
        reversed,
        redone,
        option: {
          component: option.component,
          item: option.item.nid,
        },
        maxHp: unit.maxHp,
      };
    });

    expect(result.applied).toBe(true);
    expect(result.option).toEqual({ component: 'ability', item: 'Patchwork' });
    expect(result.changed).toEqual({
      hp: Math.min(result.before.hp + 4, result.maxHp),
      charge: 1,
    });
    expect(result.reversed).toEqual(result.before);
    expect(result.redone).toEqual(result.changed);
  });

  test('routes a real multi-item ability through its authored child menu', async ({ page }) => {
    await bootEotf(page);
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const harness = (window as any).__harness;
      const { SkillObject } = await import('/src/objects/skill.ts');
      const {
        ItemUseState,
        MenuState,
      } = await import('/src/engine/states/game-states.ts');
      const unit = game.units.get('Player');
      const target = game.units.get('Keeper');
      harness.warpUnit(unit.nid, 5, 5);
      harness.warpUnit(target.nid, 6, 5);
      unit.team = 'player';
      target.team = 'enemy';
      unit.finished = false;
      unit.skills = [new SkillObject(game.db.skills.get('Sharks_Arts'))];
      game.selectedUnit = unit;

      const main = new MenuState();
      main.begin();
      const mainMenu = (main as any).menu;
      const abilityIndex = mainMenu.options.findIndex((option: any) =>
        option.value.startsWith('skill_ability_'));
      const abilityLabel = mainMenu.options[abilityIndex]?.label;
      mainMenu.selectedIndex = abilityIndex;
      main.takeInput('SELECT');
      const root = game.memory.get('ability_item');

      const children = new ItemUseState();
      children.begin();
      const childMenu = (children as any).menu;
      const childLabels = childMenu.options.map((option: any) => option.label);
      childMenu.selectedIndex = 0;
      children.takeInput('SELECT');
      const selected = game.memory.get('item_use_item');
      return {
        abilityLabel,
        root: {
          nid: root?.nid,
          children: root?.subitems.map((item: any) => item.nid),
        },
        childLabels,
        selected: {
          nid: selected?.nid,
          parent: selected?.parentItem?.nid,
        },
      };
    });

    expect(result.abilityLabel).toBe("<red>Shark's Arts</>");
    expect(result.root).toEqual({
      nid: 'Sharks_Arts',
      children: ['Haymaker', 'RightHook', 'Suplex', 'Roundhouse'],
    });
    expect(result.childLabels).toEqual([
      'Haymaker',
      'Right Hook',
      'Suplex',
      'Roundhouse',
    ]);
    expect(result.selected).toEqual({
      nid: 'Haymaker',
      parent: 'Sharks_Arts',
    });
  });

  test('evaluates aura parent conditions and charges the source of an empty-tile ability', async ({
    page,
  }) => {
    await bootEotf(page);
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const harness = (window as any).__harness;
      const { SkillObject } = await import('/src/objects/skill.ts');
      const { getSkillAbilityOptions, ItemTargetingState } =
        await import('/src/engine/states/game-states.ts');
      const owner = game.units.get('Player');
      const recipient = game.units.get('Lib');
      harness.warpUnit(recipient.nid, 8, 8);
      const parent = new SkillObject(game.db.skills.get('Spur_Summon'));
      const child = new SkillObject(game.db.skills.get('Summon_Stand'));
      owner.skills = [parent];
      recipient.skills = [child];
      child.data.set('auraSourceType', 'aura');
      child.data.set('auraOwnerNid', owner.nid);
      child.data.set('auraParentSkillUid', parent.uid);

      const active = getSkillAbilityOptions(game, recipient);
      parent.data.set('charge', 0);
      const depleted = getSkillAbilityOptions(game, recipient);
      parent.data.set('charge', 1);
      const giftParent = new SkillObject(game.db.skills.get('Gift_of_Cinders'));
      const giftChild = new SkillObject(game.db.skills.get('Gift_of_Cinders_Child'));
      giftChild.data.set('auraSourceType', 'aura');
      giftChild.data.set('auraOwnerNid', owner.nid);
      giftChild.data.set('auraParentSkillUid', giftParent.uid);
      owner.skills = [giftParent];
      recipient.skills = [giftChild];
      recipient.affinity = 'Fire';
      const giftActive = getSkillAbilityOptions(game, recipient).map(
        (option: any) => option.item.nid,
      );
      owner.skills = [parent];
      recipient.skills = [child];
      const calls: any[] = [];
      const oldManager = game.eventManager;
      game.eventManager = {
        hasActiveEvents() {
          return false;
        },
        triggerSpecific(nid: string, trigger: any) {
          calls.push({
            nid,
            type: trigger.type,
            unit: trigger.unit1?.nid,
            target: trigger.unit2?.nid ?? null,
            targetPos: trigger.localArgs.get('target_pos'),
          });
          return true;
        },
      };
      const beforeIndex = game.actionLog.actionIndex;
      game.selectedUnit = recipient;
      recipient.finished = false;
      game.memory.set('item_use_item', active[0].item);
      const targeting = new ItemTargetingState();
      targeting.begin();
      const targetPosition = (targeting as any).targets[0] as [number, number];
      targeting.takeInput('SELECT');
      const afterIndex = game.actionLog.actionIndex;
      const changed = parent.data.get('charge');
      while (game.actionLog.actionIndex > beforeIndex) game.actionLog.runActionBackward();
      const reversed = parent.data.get('charge');
      while (game.actionLog.actionIndex < afterIndex) game.actionLog.runActionForward();
      const redone = parent.data.get('charge');
      game.eventManager = oldManager;
      return {
        active: active.map((option: any) => ({
          component: option.component,
          item: option.item.nid,
        })),
        depleted: depleted.length,
        giftActive,
        targetPosition,
        calls,
        charges: { changed, reversed, redone },
      };
    });

    expect(result.active).toEqual([{
      component: 'ability_parent',
      item: 'Summon_Stand',
    }]);
    expect(result.depleted).toBe(0);
    expect(result.giftActive).toEqual(['Hellspark_Free']);
    expect(result.calls).toEqual([{
      nid: 'Global Ability_SummonStand',
      type: 'event_on_hit',
      unit: 'Lib',
      target: null,
      targetPos: result.targetPosition,
    }]);
    expect(result.charges).toEqual({ changed: 0, reversed: 1, redone: 0 });
  });

  test('consumes a team-wide combat art charge for current-party and Flex allies', async ({
    page,
  }) => {
    await bootEotf(page);
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { SkillObject } = await import('/src/objects/skill.ts');
      const { ItemObject } = await import('/src/objects/item.ts');
      const { applyCombatSkillEndHooks } =
        await import('/src/combat/combat-lifecycle.ts');
      const unit = game.units.get('Player');
      const ally = game.units.get('Lib');
      const target = game.units.get('Keeper');
      unit.team = 'player';
      ally.team = 'player';
      target.team = 'enemy';
      unit.party = game.currentParty;
      ally.party = 'Flex';
      const source = new SkillObject(game.db.skills.get('Gemini_Impact'));
      const shared = new SkillObject(game.db.skills.get('Gemini_Impact'));
      const child = new SkillObject(game.db.skills.get('Gemini_Impact_Proc'));
      source.data.set('active', true);
      child.data.set('combatArtSource', source);
      unit.skills = [source, child];
      ally.skills = [shared];
      const item = new ItemObject({
        nid: '_EotfGeminiWeapon',
        name: 'EotF Gemini Weapon',
        desc: '',
        components: [['weapon', null]],
      });
      const strike = {
        attacker: unit,
        defender: target,
        item,
        hit: true,
        crit: false,
        damage: 1,
        isCounter: false,
        mode: 'attack',
        attackInfo: [0, 0] as [number, number],
      };
      const beforeIndex = game.actionLog.actionIndex;
      const snapshot = () => ({
        source: source.data.get('charge'),
        shared: shared.data.get('charge'),
        active: source.data.get('active'),
        child: unit.skills.includes(child),
      });
      const before = snapshot();
      applyCombatSkillEndHooks(game, [strike], unit, target);
      const afterIndex = game.actionLog.actionIndex;
      const changed = snapshot();
      while (game.actionLog.actionIndex > beforeIndex) game.actionLog.runActionBackward();
      const reversed = snapshot();
      while (game.actionLog.actionIndex < afterIndex) game.actionLog.runActionForward();
      const redone = snapshot();
      return { before, changed, reversed, redone };
    });

    expect(result.before).toEqual({
      source: 2,
      shared: 2,
      active: true,
      child: true,
    });
    expect(result.changed).toEqual({
      source: 1,
      shared: 1,
      active: false,
      child: false,
    });
    expect(result.reversed).toEqual(result.before);
    expect(result.redone).toEqual(result.changed);
  });
});
