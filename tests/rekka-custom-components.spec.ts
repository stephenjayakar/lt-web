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
  test('zero-use custom movement and cleave components match their Python contracts', async ({ page }) => {
    await boot(page);
    const result = await page.evaluate(async () => {
      const { GameBoard } = await import('/src/objects/game-board.ts');
      const { ItemObject } = await import('/src/objects/item.ts');
      const {
        rekkaMovementEndpoints,
        splash,
        splashPositions,
        targetRestrict,
      } = await import('/src/combat/item-system.ts');
      const { applyCombatItemEndHooks } = await import('/src/combat/combat-lifecycle.ts');
      const { CombatPhaseSolver } = await import('/src/combat/combat-solver.ts');
      const game = (window as any).__gameRef;
      const attacker = game.units.get('Lyn');
      const target = game.units.get('101');
      const bystander = game.units.get('Batta');
      if (!attacker || !target || !bystander) return null;

      const board = new GameBoard(16, 16);
      const movementGroup = game.db.classes.get(attacker.klass).movement_group;
      const floor = [...game.db.terrain.values()].find((terrain: any) =>
        game.db.getMovementCost(terrain.mtype, movementGroup) < 99);
      const wall = [...game.db.terrain.values()].find((terrain: any) =>
        game.db.getMovementCost(terrain.mtype, movementGroup) >= 99);
      if (!floor || !wall) return null;
      for (let y = 0; y < board.height; y++) {
        for (let x = 0; x < board.width; x++) board.setTerrain(x, y, floor.nid);
      }

      board.setUnit(2, 2, attacker);
      board.setTerrain(3, 2, wall.nid);
      board.setTerrain(4, 2, wall.nid);
      const movementItem = (nid: string, component: string, value: unknown) =>
        new ItemObject({
          nid, name: nid, desc: '', icon_nid: '', icon_index: [0, 0],
          components: [
            [component, value], ['target_tile', null],
            ['min_range', 1], ['max_range', 1],
          ],
        });
      const phasewalk = movementItem('_Phasewalk', 'phasewalk', [wall.nid]);
      const charge = movementItem('_Charge', 'charge', [floor.nid]);
      const bullrush = movementItem('_Bullrush', 'bullrush', [floor.nid]);
      const serialize = (map: Map<string, [number, number]>) =>
        Object.fromEntries([...map.entries()]);

      const phaseTargets = rekkaMovementEndpoints(
        attacker, phasewalk, board, game.db, game,
      );
      const phaseRestriction = targetRestrict(
        attacker, phasewalk, [3, 2], [],
        { board, db: game.db, game },
      );
      const invalidRestriction = targetRestrict(
        attacker, phasewalk, [2, 3], [],
        { board, db: game.db, game },
      );

      // Execute Phasewalk through the same end-combat hook used at runtime,
      // then prove its WarpUnitAction restores the exact origin.
      board.setUnit(3, 2, target);
      const phaseStrike: any = {
        attacker, defender: target, item: phasewalk,
        hit: true, crit: false, damage: 0, isCounter: false,
        mode: 'attack', attackInfo: [0, 0],
      };
      const actionStart = game.actionLog.actions.length;
      const phaseApplied = applyCombatItemEndHooks(
        { ...game, board }, [phaseStrike],
      );
      const phaseAfter = [...attacker.position];
      const phaseActions = game.actionLog.actions.slice(actionStart);
      const phaseUndo = game.actionLog.undo();
      const phaseRestored = [...attacker.position];

      // Charge/Bullrush expose fixed endpoints. Charge must displace an
      // endpoint occupant before warping the user, with both actions reversible.
      board.removeUnit(target);
      board.setTerrain(3, 2, floor.nid);
      board.setTerrain(4, 2, floor.nid);
      const chargeTargets = rekkaMovementEndpoints(
        attacker, charge, board, game.db, game,
      );
      const bullrushTargets = rekkaMovementEndpoints(
        attacker, bullrush, board, game.db, game,
      );
      board.setUnit(3, 2, target);
      const chargeEndpoint = chargeTargets.get('3,2')!;
      board.setUnit(chargeEndpoint[0], chargeEndpoint[1], bystander);
      const chargeStrike: any = { ...phaseStrike, item: charge };
      const chargeStart = game.actionLog.actions.length;
      const chargeApplied = applyCombatItemEndHooks(
        { ...game, board }, [chargeStrike],
      );
      const chargeActions = game.actionLog.actions.slice(chargeStart);
      const chargeAfter = {
        attacker: [...attacker.position],
        bystander: [...bystander.position],
      };
      for (let i = 0; i < chargeActions.length; i++) game.actionLog.undo();
      const chargeRestored = {
        attacker: [...attacker.position],
        bystander: [...bystander.position],
      };

      // The cleave affects occupied tiles anywhere in the surrounding 5x5,
      // previews only empty tiles, and overrides ordinary damage to HP - 1.
      board.removeUnit(target);
      board.removeUnit(bystander);
      board.setUnit(8, 8, attacker);
      board.setUnit(9, 8, target);
      board.setUnit(11, 10, bystander);
      target.currentHp = Math.min(30, target.maxHp);
      const cleave = new ItemObject({
        nid: '_Cleave2', name: '_Cleave2', desc: '',
        icon_nid: '', icon_index: [0, 0],
        components: [
          ['weapon', null], ['target_enemy', null], ['cleave_2_range_aoe', null],
          ['damage', 999], ['hit', 100], ['min_range', 1], ['max_range', 1],
        ],
      });
      const cleaveSplash = splash(
        attacker, cleave, [9, 8], { board, db: game.db },
      );
      const cleavePreview = splashPositions(
        attacker, cleave, [9, 8], { board, db: game.db },
      );
      const solver = new CombatPhaseSolver(() => 0, game);
      const cleaveStrikes = solver.resolve(
        attacker, cleave, target, null, game.db, 'classic', board, null,
      );

      return {
        movement: attacker.getMovement(),
        phase: serialize(phaseTargets),
        charge: serialize(chargeTargets),
        bullrush: serialize(bullrushTargets),
        restrictions: { phaseRestriction, invalidRestriction },
        phaseExecution: {
          applied: phaseApplied,
          after: phaseAfter,
          actions: phaseActions.map((action: any) => action.constructor.name),
          undo: phaseUndo?.constructor?.name ?? null,
          restored: phaseRestored,
        },
        chargeExecution: {
          applied: chargeApplied,
          actions: chargeActions.map((action: any) => action.constructor.name),
          after: chargeAfter,
          restored: chargeRestored,
        },
        cleave: {
          main: cleaveSplash.mainTarget,
          splash: cleaveSplash.splash.map((position) => position.join(',')).sort(),
          previewHasOccupied: cleavePreview.some(([x, y]) =>
            !!board.getUnit(x, y)),
          previewCount: cleavePreview.length,
          damage: cleaveStrikes[0]?.damage,
          targetHp: target.currentHp,
        },
      };
    });

    expect(result).not.toBeNull();
    expect(result!.phase['3,2']).toEqual([5, 2]);
    expect(result!.charge['3,2']).toEqual([
      2 + Math.trunc(result!.movement / 2), 2,
    ]);
    expect(result!.bullrush['3,2']).toEqual([2 + result!.movement, 2]);
    expect(result!.restrictions).toEqual({
      phaseRestriction: true,
      invalidRestriction: false,
    });
    expect(result!.phaseExecution).toEqual({
      applied: 1,
      after: [5, 2],
      actions: ['WarpUnitAction'],
      undo: 'WarpUnitAction',
      restored: [2, 2],
    });
    expect(result!.chargeExecution.applied).toBe(2);
    expect(result!.chargeExecution.actions).toEqual([
      'WarpUnitAction', 'WarpUnitAction',
    ]);
    expect(result!.chargeExecution.after.attacker).toEqual(
      result!.charge['3,2'],
    );
    // Python get_nearest_open_tile accepts the occupant's own tile, so the
    // forced-movement action is deliberately a no-op before the stacking warp.
    expect(result!.chargeExecution.after.bystander).toEqual(
      result!.charge['3,2'],
    );
    expect(result!.chargeExecution.restored).toEqual({
      attacker: [2, 2],
      bystander: result!.charge['3,2'],
    });
    expect(result!.cleave.main).toEqual([9, 8]);
    expect(result!.cleave.splash).toContain('11,10');
    expect(result!.cleave.previewHasOccupied).toBe(false);
    expect(result!.cleave.previewCount).toBeGreaterThan(0);
    expect(result!.cleave.damage).toBe(result!.cleave.targetHp - 1);
  });

  test('transform stones apply equipped stats, range, status, undo, and save identity', async ({ page }) => {
    await boot(page);
    const result = await page.evaluate(async () => {
      const { transforms } = await import('/src/combat/item-system.ts');
      const { EquipItemAction } = await import('/src/engine/action.ts');
      const { ItemObject } = await import('/src/objects/item.ts');
      const game = (window as any).__gameRef;
      const harness = (window as any).__harness;
      const unit = game.units.get('Lyn');
      const catalog = ['Firestone', 'Shadowstone', 'Seastone', 'Bloodstone', 'Divinestone']
        .map((nid) => {
          const item = new ItemObject(game.db.items.get(nid));
          return {
            nid,
            marker: transforms(unit, item),
            range: [item.getMinRange(), item.getMaxRange()],
            hasUses: item.hasComponent('uses'),
          };
        });
      const base = {
        hp: unit.getStatValue('HP'),
        str: unit.getStatValue('STR'),
        def: unit.getStatValue('DEF'),
      };
      const stone = new ItemObject(game.db.items.get('Divinestone'));
      stone.owner = unit;
      unit.items.push(stone);
      unit.onAddItem(stone);
      const equip = new EquipItemAction(unit, stone);
      game.actionLog.doAction(equip);
      const equipped = {
        marker: transforms(unit, stone),
        range: [stone.getMinRange(), stone.getMaxRange()],
        hp: unit.getStatValue('HP'),
        str: unit.getStatValue('STR'),
        def: unit.getStatValue('DEF'),
        status: unit.skills.some((skill: any) =>
          skill.nid === 'DragonScales' && skill.data.get('itemSource') === stone),
        equipped: unit.equippedWeapon?.nid ?? null,
      };
      const action = game.actionLog.undo();
      const undone = {
        hp: unit.getStatValue('HP'),
        str: unit.getStatValue('STR'),
        def: unit.getStatValue('DEF'),
        status: unit.skills.some((skill: any) => skill.nid === 'DragonScales'),
      };
      action.execute();
      const snapshot = harness.saveSnapshot();
      const loaded = await harness.loadSnapshot(snapshot);
      const loadedUnit = game.units.get('Lyn');
      const loadedStone = loadedUnit.equippedWeapon;
      return {
        catalog,
        base,
        equipped,
        action: action.constructor.name,
        undone,
        loaded,
        loadedStone: loadedStone?.nid ?? null,
        identityPreserved: !!loadedStone && loadedUnit.items.includes(loadedStone),
        loadedStats: {
          hp: loadedUnit.getStatValue('HP'),
          str: loadedUnit.getStatValue('STR'),
          def: loadedUnit.getStatValue('DEF'),
        },
        loadedStatus: loadedUnit.skills.some((skill: any) =>
          skill.nid === 'DragonScales' && skill.data.get('itemSource') === loadedStone),
      };
    });

    expect(result.equipped).toEqual({
      marker: true,
      range: [1, 5],
      hp: result.base.hp + 200,
      str: result.base.str + 30,
      def: result.base.def + 40,
      status: true,
      equipped: 'Divinestone',
    });
    expect(result.catalog).toEqual([
      { nid: 'Firestone', marker: true, range: [1, 7], hasUses: false },
      { nid: 'Shadowstone', marker: true, range: [1, 3], hasUses: false },
      { nid: 'Seastone', marker: true, range: [1, 1], hasUses: false },
      { nid: 'Bloodstone', marker: true, range: [1, 2], hasUses: false },
      { nid: 'Divinestone', marker: true, range: [1, 5], hasUses: false },
    ]);
    expect(result).toMatchObject({
      action: 'EquipItemAction',
      undone: {
        hp: result.base.hp,
        str: result.base.str,
        def: result.base.def,
        status: false,
      },
      loaded: true,
      loadedStone: 'Divinestone',
      identityPreserved: true,
      loadedStats: {
        hp: result.base.hp + 200,
        str: result.base.str + 30,
        def: result.base.def + 40,
      },
      loadedStatus: true,
    });
  });

  test('transform stones swap Transform, combat, and Revert battle animations', async ({ page }) => {
    await boot(page);
    const result = await page.evaluate(async () => {
      const { CombatState } = await import('/src/engine/states/game-states.ts');
      const { ItemObject } = await import('/src/objects/item.ts');
      const game = (window as any).__gameRef;
      const attacker = game.units.get('Lyn');
      const defender = game.units.get('101');
      const attackerClass = game.db.classes.get(attacker.klass);
      const defenderClass = game.db.classes.get(defender.klass);
      const oldAttackerAnim = attackerClass.combat_anim_nid;
      const oldDefenderAnim = defenderClass.combat_anim_nid;
      attackerClass.combat_anim_nid = 'Manakete';
      defenderClass.combat_anim_nid = 'Manakete';
      const stone = new ItemObject(game.db.items.get('Divinestone'));
      stone.owner = attacker;
      attacker.items.push(stone);
      attacker.onAddItem(stone);
      attacker.equip(stone);
      game.board.moveUnit(
        defender,
        attacker.position[0],
        attacker.position[1] - 1,
      );

      const state: any = new CombatState();
      const created = state.tryCreateAnimationCombat(
        attacker,
        stone,
        defender,
        defender.getEquippedWeapon(),
        'classic',
        game,
      );
      const combat: any = state.animCombat;
      const introSide = combat.leftIsAttacker ? combat.leftAnim : combat.rightAnim;
      const intro = introSide.animData.nid;

      combat.stateTimer = 10_000;
      combat.updateInitPause();
      const introState = combat.state;
      for (let i = 0; i < 2_000 && !introSide.isIdle(); i++) introSide.update();
      combat.updateTransform();
      const mainSide = combat.leftIsAttacker ? combat.leftAnim : combat.rightAnim;
      const main = mainSide.animData.nid;
      const mainState = combat.state;

      combat.leftTargetHp = 1;
      combat.rightTargetHp = 1;
      combat.state = 'exp_wait';
      combat.updateExpWait();
      const revertSide = combat.leftIsAttacker ? combat.leftAnim : combat.rightAnim;
      const revert = revertSide.animData.nid;
      const revertState = combat.state;
      for (let i = 0; i < 2_000 && !revertSide.isIdle(); i++) revertSide.update();
      combat.updateRevert();

      attackerClass.combat_anim_nid = oldAttackerAnim;
      defenderClass.combat_anim_nid = oldDefenderAnim;
      return {
        created,
        intro,
        introState,
        main,
        mainState,
        revert,
        revertState,
        finalState: combat.state,
      };
    });

    expect(result).toEqual({
      created: true,
      intro: 'Transform',
      introState: 'transform',
      main: 'Dragonstone',
      mainState: 'begin_phase',
      revert: 'Revert',
      revertState: 'revert',
      finalState: 'fade_out',
    });
  });

  test('all usable_in_base items appear in management and apply reversible effects', async ({ page }) => {
    await boot(page);
    const result = await page.evaluate(async () => {
      const { BaseManageState } = await import('/src/engine/states/base-state.ts');
      const { BaseUseState } = await import('/src/engine/states/game-states.ts');
      const { ItemObject } = await import('/src/objects/item.ts');
      const game = (window as any).__gameRef;
      const harness = (window as any).__harness;
      const unit = game.units.get('Lyn');
      const expected = [
        'Angelic_Robe', 'Energy_Ring', 'Secret_Book', 'Speedwing', 'Goddess_Icon',
        'Dragonshield', 'Talisman', 'Swiftsole', 'Body_Ring', 'Master_Seal', 'HeavenSeal',
      ];
      const catalog = [...game.db.items.values()]
        .filter((item: any) => Array.isArray(item.components)
          ? item.components.some((component: any) => component[0] === 'usable_in_base')
          : item.components.has('usable_in_base'))
        .map((item: any) => item.nid)
        .sort();

      const robe = new ItemObject(game.db.items.get('Angelic_Robe'));
      robe.owner = unit;
      unit.items.push(robe);
      const manage: any = new BaseManageState();
      manage.selectedNid = unit.nid;
      manage.buildOptionMenu();
      const useOption = manage.optionMenu.options.find((option: any) => option.value === 'use');

      const beforeRobe = {
        hp: unit.stats.HP,
        currentHp: unit.currentHp,
        uses: robe.uses,
        hasTraded: unit.hasTraded,
        actions: game.actionLog.actions.length,
      };
      game.memory.set('base_use_unit', unit);
      const robeState: any = new BaseUseState();
      robeState.begin();
      robeState.takeInput('SELECT');
      const afterRobe = {
        hp: unit.stats.HP,
        currentHp: unit.currentHp,
        uses: robe.uses,
        hasTraded: unit.hasTraded,
        retained: unit.items.includes(robe),
      };
      while (game.actionLog.actions.length > beforeRobe.actions) game.actionLog.undo();
      const undoneRobe = {
        hp: unit.stats.HP,
        currentHp: unit.currentHp,
        uses: robe.uses,
        hasTraded: unit.hasTraded,
        retained: unit.items.includes(robe),
      };
      unit.items.splice(unit.items.indexOf(robe), 1);

      const seal = new ItemObject(game.db.items.get('HeavenSeal'));
      seal.owner = unit;
      unit.items.push(seal);
      const beforeSeal = {
        klass: unit.klass,
        actions: game.actionLog.actions.length,
      };
      game.memory.set('base_use_unit', unit);
      const sealState: any = new BaseUseState();
      sealState.begin();
      sealState.takeInput('SELECT');
      const afterSeal = {
        klass: unit.klass,
        retained: unit.items.includes(seal),
        uses: seal.uses,
      };
      while (game.actionLog.actions.length > beforeSeal.actions) game.actionLog.undo();
      const undoneSeal = {
        klass: unit.klass,
        retained: unit.items.includes(seal),
        uses: seal.uses,
      };
      unit.items.splice(unit.items.indexOf(seal), 1);

      const oldLevel = unit.level;
      const oldKlass = unit.klass;
      unit.klass = 'Myrmidon';
      const masterSeal = new ItemObject(game.db.items.get('Master_Seal'));
      masterSeal.owner = unit;
      unit.items.push(masterSeal);
      unit.level = 9;
      game.memory.set('base_use_unit', unit);
      const levelNineState: any = new BaseUseState();
      levelNineState.begin();
      const masterAtNine = levelNineState.menu.options[0].enabled;
      unit.level = 10;
      const levelTenState: any = new BaseUseState();
      levelTenState.begin();
      const masterAtTen = levelTenState.menu.options[0].enabled;
      unit.level = oldLevel;
      unit.klass = oldKlass;
      const snapshot = harness.saveSnapshot();
      const loaded = await harness.loadSnapshot(snapshot);
      const loadedUnit = game.units.get('Lyn');
      const loadedMasterSeal = loadedUnit.items.find((item: any) => item.nid === 'Master_Seal');

      return {
        catalog,
        expected: [...expected].sort(),
        useOption: { enabled: useOption.enabled, label: useOption.label },
        beforeRobe,
        afterRobe,
        undoneRobe,
        beforeSeal,
        afterSeal,
        undoneSeal,
        masterSeal: {
          atLevelNine: masterAtNine,
          atLevelTen: masterAtTen,
          uses: masterSeal.uses,
          maxUses: masterSeal.maxUses,
        },
        loaded,
        loadedIdentity: !!loadedMasterSeal && loadedMasterSeal.owner === loadedUnit,
      };
    });

    expect(result.catalog).toEqual(result.expected);
    expect(result.useOption).toEqual({ enabled: true, label: 'Use' });
    expect(result.afterRobe).toEqual({
      hp: result.beforeRobe.hp + 3,
      currentHp: result.beforeRobe.currentHp + 3,
      uses: result.beforeRobe.uses - 1,
      hasTraded: true,
      retained: true,
    });
    expect(result.undoneRobe).toEqual({
      hp: result.beforeRobe.hp,
      currentHp: result.beforeRobe.currentHp,
      uses: result.beforeRobe.uses,
      hasTraded: result.beforeRobe.hasTraded,
      retained: true,
    });
    expect(result.afterSeal).toEqual({
      klass: 'BladeLord',
      retained: false,
      uses: 0,
    });
    expect(result.undoneSeal).toEqual({
      klass: result.beforeSeal.klass,
      retained: true,
      uses: 1,
    });
    expect(result.masterSeal).toEqual({
      atLevelNine: false,
      atLevelTen: true,
      uses: 1,
      maxUses: 1,
    });
    expect(result.loaded).toBe(true);
    expect(result.loadedIdentity).toBe(true);
  });

  test('equippable_accessory uses the ring slot with reversible equip hooks and save identity', async ({ page }) => {
    await boot(page);
    const result = await page.evaluate(async () => {
      const { inventoryFull } = await import('/src/combat/item-system.ts');
      const { EquipItemAction } = await import('/src/engine/action.ts');
      const { ItemObject } = await import('/src/objects/item.ts');
      const game = (window as any).__gameRef;
      const harness = (window as any).__harness;
      const unit = game.units.get('Lyn');
      for (const item of [...unit.items]) {
        if (!item.isAccessory()) continue;
        if (unit.equippedAccessory === item) unit.unequip(item);
        unit.items.splice(unit.items.indexOf(item), 1);
        unit.onRemoveItem(item);
      }
      harness.giveItem('Lyn', 'DuelRing');
      const duel = unit.items.find((item: any) => item.nid === 'DuelRing');
      const weaponBefore = unit.equippedWeapon?.nid ?? null;
      const initial = {
        isAccessory: duel.isAccessory(),
        equipped: unit.equippedAccessory?.nid ?? null,
        weapon: weaponBefore,
        skills: unit.skills.filter((skill: any) =>
          skill.data.get('itemSource') === duel).map((skill: any) => skill.nid),
      };

      const morale = new ItemObject(game.db.items.get('MoraleRing'));
      morale.owner = unit;
      const fullAtOne = inventoryFull(unit, morale, game.db);
      unit.items.push(morale);
      unit.onAddItem(morale);
      const equip = new EquipItemAction(unit, morale);
      game.actionLog.doAction(equip);
      const swapped = {
        equipped: unit.equippedAccessory?.nid ?? null,
        weapon: unit.equippedWeapon?.nid ?? null,
        hasDuel: unit.skills.some((skill: any) => skill.nid === 'Duel'),
        hasMorale: unit.skills.some((skill: any) => skill.nid === 'Morale'),
      };
      const action = game.actionLog.undo();
      const undone = {
        equipped: unit.equippedAccessory?.nid ?? null,
        hasDuel: unit.skills.some((skill: any) => skill.nid === 'Duel'),
        hasMorale: unit.skills.some((skill: any) => skill.nid === 'Morale'),
      };
      action.execute();
      const snapshot = harness.saveSnapshot();
      const loaded = await harness.loadSnapshot(snapshot);
      const loadedUnit = game.units.get('Lyn');
      const loadedAccessory = loadedUnit.equippedAccessory;
      return {
        initial,
        fullAtOne,
        action: action.constructor.name,
        swapped,
        undone,
        loaded,
        loadedAccessory: loadedAccessory?.nid ?? null,
        identityPreserved: !!loadedAccessory && loadedUnit.items.includes(loadedAccessory),
        loadedSkill: loadedUnit.skills.some((skill: any) => skill.nid === 'Morale'),
      };
    });

    expect(result).toEqual({
      initial: {
        isAccessory: true,
        equipped: 'DuelRing',
        weapon: null,
        skills: ['Duel'],
      },
      fullAtOne: true,
      action: 'EquipItemAction',
      swapped: {
        equipped: 'MoraleRing',
        weapon: null,
        hasDuel: false,
        hasMorale: true,
      },
      undone: {
        equipped: 'DuelRing',
        hasDuel: true,
        hasMorale: false,
      },
      loaded: true,
      loadedAccessory: 'MoraleRing',
      identityPreserved: true,
      loadedSkill: true,
    });
  });

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
      const applied = applyCombatItemStartHooks(game, unit, item);
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
  test('global, upkeep_event, empower_heal, and lost_on_kill follow Python hooks', async ({ page }) => {
    await boot(page);
    const result = await page.evaluate(async () => {
      const { applySkillTurnHooks } = await import('/src/engine/skill-turn-lifecycle.ts');
      const { applyCombatSkillEndHooks } = await import('/src/combat/combat-lifecycle.ts');
      const { empowerHeal, unitSpriteTint } = await import('/src/combat/skill-system.ts');
      const { SkillObject } = await import('/src/objects/skill.ts');
      const game = (window as any).__gameRef;
      const unit = game.units.get('Lyn');
      const target = game.units.get('101');
      const globalNids = [...game.db.skills.values()]
        .filter((prefab: any) => prefab.components.some((component: any) =>
          component[0] === 'global'))
        .map((prefab: any) => prefab.nid);
      const globalsInstalled = globalNids.every((nid: string) =>
        unit.skills.some((skill: any) =>
          skill.nid === nid && skill.data.get('sourceType') === 'global'));

      const upkeep = new SkillObject({
        nid: '_Upkeep', name: '_Upkeep', desc: '',
        components: [['upkeep_event', 'Global Ability_MomentumGain']],
      });
      unit.skills = [upkeep];
      const calls: any[] = [];
      game.eventManager.triggerSpecific = (nid: string, trigger: any) => {
        calls.push({ nid, type: trigger.type, unit: trigger.unit1.nid });
        return true;
      };
      const upkeepEffects = applySkillTurnHooks(game, [unit], 'upkeep');

      const healer = new SkillObject({
        nid: '_Empower', name: '_Empower', desc: '',
        components: [['empower_heal', "unit.get_stat('MAG')"]],
      });
      unit.skills = [healer];
      const empowered = empowerHeal(unit, target, game);
      const tinted = new SkillObject({
        nid: '_Tinted', name: '_Tinted', desc: '',
        components: [['unit_tint', [12, 34, 56]]],
      });
      const flickering = new SkillObject({
        nid: '_Flickering', name: '_Flickering', desc: '',
        components: [['unit_flickering_tint', [78, 90, 123]]],
      });
      unit.skills = [tinted];
      const staticTint = unitSpriteTint(unit, game, 500);
      unit.skills = [flickering];
      const flickerOn = unitSpriteTint(unit, game, 100);
      const flickerOff = unitSpriteTint(unit, game, 500);

      const temporary = new SkillObject({
        nid: '_UntilKill', name: '_UntilKill', desc: '',
        components: [['lost_on_kill', null]],
      });
      unit.skills = [temporary];
      target.currentHp = 0;
      const weapon = unit.items.find((item: any) => item.isWeapon());
      const actionStart = game.actionLog.actions.length;
      const removed = applyCombatSkillEndHooks(game, [{
        attacker: unit,
        defender: target,
        item: weapon,
        hit: true,
        crit: false,
        damage: 1,
        isCounter: false,
        mode: 'attack',
        attackInfo: [0, 0],
      }], unit, target);
      const absentAfterKill = !unit.skills.includes(temporary);
      while (game.actionLog.actions.length > actionStart) game.actionLog.undo();

      return {
        globalNids,
        globalsInstalled,
        calls,
        upkeepComponents: upkeepEffects.map((effect: any) => effect.component),
        empowered,
        expectedEmpower: unit.stats.MAG,
        staticTint,
        flickerOn,
        flickerOff,
        removed,
        absentAfterKill,
        restoredAfterUndo: unit.skills.includes(temporary),
      };
    });

    expect(result.globalNids.length).toBeGreaterThan(0);
    expect(result.globalsInstalled).toBe(true);
    expect(result.calls).toEqual([{
      nid: 'Global Ability_MomentumGain',
      type: 'upkeep_event',
      unit: 'Lyn',
    }]);
    expect(result.upkeepComponents).toEqual(['upkeep_event']);
    expect(result.empowered).toBe(result.expectedEmpower);
    expect(result.staticTint).toEqual({ color: [12, 34, 56], alpha: 1 });
    expect(result.flickerOn).toEqual({ color: [78, 90, 123], alpha: 1 });
    expect(result.flickerOff).toEqual({ color: [78, 90, 123], alpha: 0 });
    expect(result.removed).toBeGreaterThanOrEqual(1);
    expect(result.absentAfterKill).toBe(true);
    expect(result.restoredAfterUndo).toBe(true);
  });

  test('combat art menu activates, cancels, and consumes a reversible child skill', async ({ page }) => {
    await boot(page);
    const result = await page.evaluate(async () => {
      const {
        CombatArtChoiceState,
        WeaponChoiceState,
      } = await import('/src/engine/states/game-states.ts');
      const { applyCombatSkillEndHooks } = await import('/src/combat/combat-lifecycle.ts');
      const { modifyDamage } = await import('/src/combat/skill-system.ts');
      const { SkillObject } = await import('/src/objects/skill.ts');
      const game = (window as any).__gameRef;
      const harness = (window as any).__harness;
      const unit = game.units.get('Lyn');
      const target = game.units.get('101');
      harness.warpUnit('Lyn', 10, 7);
      harness.warpUnit('101', 11, 7);
      const klass = game.db.classes.get(unit.klass);
      klass.wexp_gain.Sword = [true, 0];
      unit.wexp.Sword = 200;
      unit.autoequip();
      const weapon = unit.items.find((item: any) => item.isWeapon());
      game.db.skills.set('TestCombatArtChild', {
        nid: 'TestCombatArtChild',
        name: 'Test Combat Art Child',
        desc: '',
        components: [['damage', 10]],
      });
      const parent = new SkillObject({
        nid: 'TestCombatArt',
        name: 'Test Combat Art',
        desc: '',
        components: [
          ['combat_art', 'TestCombatArtChild'],
          ['allowed_weapons', 'item_system.is_weapon(unit, item)'],
          ['charges_per_turn', 1],
        ],
      });
      parent.data.set('charge', 1);
      parent.data.set('total_charge', 1);
      unit.skills = [parent];
      game.selectedUnit = unit;

      const firstMenu = new CombatArtChoiceState();
      firstMenu.begin();
      firstMenu.takeInput('SELECT');
      const firstChild = unit.skills.find((skill: any) =>
        skill.data.get('combatArtSource') === parent);
      const activated = {
        active: parent.data.get('active'),
        child: firstChild?.nid ?? null,
        modifier: modifyDamage(unit, weapon),
        weaponCount: (game.memory.get('combat_art_weapons') ?? []).length,
      };

      const weaponMenu = new WeaponChoiceState();
      weaponMenu.begin();
      weaponMenu.takeInput('BACK');
      const cancelled = {
        active: parent.data.get('active'),
        hasChild: unit.skills.some((skill: any) =>
          skill.data.get('combatArtSource') === parent),
        memory: game.memory.has('combat_art_parent'),
      };

      const secondMenu = new CombatArtChoiceState();
      secondMenu.begin();
      secondMenu.takeInput('SELECT');
      const child = unit.skills.find((skill: any) =>
        skill.data.get('combatArtSource') === parent);
      const applied = applyCombatSkillEndHooks(game, [{
        attacker: unit,
        defender: target,
        item: weapon,
        hit: true,
        crit: false,
        damage: 1,
        isCounter: false,
        mode: 'attack',
        attackInfo: [0, 0],
      }], unit, target);
      const consumed = {
        active: parent.data.get('active'),
        charge: parent.data.get('charge'),
        hasChild: unit.skills.includes(child),
        memory: game.memory.has('combat_art_parent'),
      };
      const actions = [
        game.actionLog.undo(),
        game.actionLog.undo(),
        game.actionLog.undo(),
      ];
      const undone = {
        active: parent.data.get('active'),
        charge: parent.data.get('charge'),
        hasChild: unit.skills.includes(child),
      };
      for (const action of [...actions].reverse()) action.execute();
      return {
        activated,
        cancelled,
        applied,
        consumed,
        actionNames: actions.map((action: any) => action.constructor.name),
        undone,
        redone: {
          active: parent.data.get('active'),
          charge: parent.data.get('charge'),
          hasChild: unit.skills.includes(child),
        },
      };
    });

    expect(result).toEqual({
      activated: {
        active: true,
        child: 'TestCombatArtChild',
        modifier: 10,
        weaponCount: 1,
      },
      cancelled: {
        active: false,
        hasChild: false,
        memory: false,
      },
      applied: 2,
      consumed: {
        active: false,
        charge: 0,
        hasChild: false,
        memory: false,
      },
      actionNames: [
        'RemoveSkillAction',
        'SetSkillDataAction',
        'SetSkillDataAction',
      ],
      undone: {
        active: true,
        charge: 1,
        hasChild: true,
      },
      redone: {
        active: false,
        charge: 0,
        hasChild: false,
      },
    });
  });

  test('multi_skill preserves nested ownership, duplicates, save identity, and removal', async ({ page }) => {
    await boot(page);
    const result = await page.evaluate(async () => {
      const { AddSkillAction, RemoveSkillAction } = await import('/src/engine/action.ts');
      const { SkillObject } = await import('/src/objects/skill.ts');
      const game = (window as any).__gameRef;
      const harness = (window as any).__harness;
      const unit = game.units.get('Lyn');
      unit.skills = [];

      const natural = new SkillObject(game.db.skills.get('PersonalSpaceLong'));
      unit.skills.push(natural);
      const personal = new SkillObject(game.db.skills.get('PersonalSpace'));
      const personalAction = new AddSkillAction(unit, personal);
      game.actionLog.doAction(personalAction);
      const directChildren = unit.skills.filter((skill: any) =>
        skill.data.get('multiSkillSource') === personal);
      const duplicateState = {
        longCount: unit.skills.filter((skill: any) =>
          skill.nid === 'PersonalSpaceLong').length,
        children: directChildren.map((skill: any) => skill.nid),
        naturalSourced: natural.data.has('multiSkillSource'),
      };
      const removePersonal = new RemoveSkillAction(unit, personal);
      game.actionLog.doAction(removePersonal);
      const naturalSurvives = unit.skills.includes(natural);
      game.actionLog.undo().execute();

      const root = new SkillObject(game.db.skills.get('CCCRRRRR'));
      const rootAction = new AddSkillAction(unit, root);
      game.actionLog.doAction(rootAction);
      const chain = ['CCCRRRRR', 'Ring', 'Ring_1', 'Ring_2', 'Ring_3', 'Charm_a'];
      const beforeSave = chain.map((nid) => {
        const skill = unit.skills.find((candidate: any) => candidate.nid === nid);
        return {
          nid,
          uid: skill?.uid ?? null,
          source: skill?.data.get('multiSkillSource')?.nid ?? null,
        };
      });
      const snapshot = harness.saveSnapshot();
      const loaded = await harness.loadSnapshot(snapshot);
      const loadedUnit = game.units.get('Lyn');
      const loadedRoot = loadedUnit.skills.find((skill: any) => skill.nid === 'CCCRRRRR');
      const afterSave = chain.map((nid) => {
        const skill = loadedUnit.skills.find((candidate: any) => candidate.nid === nid);
        return {
          nid,
          uid: skill?.uid ?? null,
          source: skill?.data.get('multiSkillSource')?.nid ?? null,
        };
      });
      const removeRoot = new RemoveSkillAction(loadedUnit, loadedRoot);
      game.actionLog.doAction(removeRoot);
      const removed = chain.every((nid) =>
        !loadedUnit.skills.some((skill: any) => skill.nid === nid));
      const removal = game.actionLog.undo();
      const restored = chain.every((nid) =>
        loadedUnit.skills.some((skill: any) => skill.nid === nid));
      removal.execute();

      return {
        duplicateState,
        naturalSurvives,
        loaded,
        beforeSave,
        afterSave,
        removed,
        removalAction: removal.constructor.name,
        restored,
        redone: chain.every((nid) =>
          !loadedUnit.skills.some((skill: any) => skill.nid === nid)),
      };
    });

    expect(result.duplicateState).toEqual({
      longCount: 1,
      children: ['PersonalSpaceClose'],
      naturalSourced: false,
    });
    expect(result.naturalSurvives).toBe(true);
    expect(result.loaded).toBe(true);
    expect(result.afterSave).toEqual(result.beforeSave);
    expect(result.beforeSave.map((entry: any) => ({
      nid: entry.nid,
      source: entry.source,
    }))).toEqual([
      { nid: 'CCCRRRRR', source: null },
      { nid: 'Ring', source: 'CCCRRRRR' },
      { nid: 'Ring_1', source: 'Ring' },
      { nid: 'Ring_2', source: 'Ring_1' },
      { nid: 'Ring_3', source: 'Ring_2' },
      { nid: 'Charm_a', source: 'Ring_3' },
    ]);
    expect(result).toMatchObject({
      removed: true,
      removalAction: 'RemoveSkillAction',
      restored: true,
      redone: true,
    });
  });

  test('inactive skill presentation hides or greys without losing active entries', async ({ page }) => {
    await boot(page);
    const result = await page.evaluate(async () => {
      const { skillInfoPresentation } = await import('/src/engine/states/info-menu-state.ts');
      const { SkillObject } = await import('/src/objects/skill.ts');
      const game = (window as any).__gameRef;
      const unit = game.units.get('Lyn');
      const make = (nid: string, marker: string, condition: string) => new SkillObject({
        nid,
        name: nid,
        desc: '',
        components: [
          ['condition', condition],
          [marker, null],
        ],
      });
      const hiddenOff = make('HiddenOff', 'hidden_if_inactive', 'False');
      const hiddenOn = make('HiddenOn', 'hidden_if_inactive', 'True');
      const greyOff = make('GreyOff', 'grey_if_inactive', 'False');
      const greyOn = make('GreyOn', 'grey_if_inactive', 'True');
      const depleted = new SkillObject({
        nid: 'Depleted',
        name: 'Depleted',
        desc: '',
        components: [
          ['charges_per_turn', 1],
          ['grey_if_inactive', null],
        ],
      });
      depleted.data.set('charge', 0);
      return Object.fromEntries(
        [hiddenOff, hiddenOn, greyOff, greyOn, depleted].map((skill) => [
          skill.nid,
          skillInfoPresentation(skill, unit, game),
        ]),
      );
    });

    expect(result).toEqual({
      HiddenOff: 'hidden',
      HiddenOn: 'normal',
      GreyOff: 'grey',
      GreyOn: 'normal',
      Depleted: 'grey',
    });
  });

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
      attacker.skills = [];
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

  test('combat and chapter expiry remove every Rekka temporary skill reversibly', async ({ page }) => {
    await boot(page);
    const result = await page.evaluate(async () => {
      const { applyCombatSkillEndHooks } = await import('/src/combat/combat-lifecycle.ts');
      const { SkillObject } = await import('/src/objects/skill.ts');
      const game = (window as any).__gameRef;
      const attacker = game.units.get('Lyn');
      const defender = game.units.get('101');
      const componentNids = (prefab: any) => Array.isArray(prefab.components)
        ? prefab.components.map((component: any) => component[0])
        : [...prefab.components.keys()];
      const combatCatalog = [...game.db.skills.values()]
        .filter((skill: any) => componentNids(skill).includes('lost_on_end_combat2'))
        .map((skill: any) => skill.nid);
      const chapterCatalog = [...game.db.skills.values()]
        .filter((skill: any) => componentNids(skill).includes('lost_on_end_chapter'))
        .map((skill: any) => skill.nid);

      const attackSkill = new SkillObject(game.db.skills.get('BaffleStatus'));
      const defenseSkill = new SkillObject(game.db.skills.get('ShieldStatus'));
      attacker.skills = [attackSkill];
      defender.skills = [defenseSkill];
      const actionStart = game.actionLog.actions.length;
      const removed = applyCombatSkillEndHooks(
        game,
        [{
          attacker,
          defender,
          item: attacker.items.find((item: any) => item.isWeapon()),
          hit: true,
          crit: false,
          damage: 1,
          isCounter: false,
          mode: 'attack',
          attackInfo: [0, 0],
        }],
        attacker,
        defender,
      );
      const afterCombat = {
        attacker: attacker.skills.map((skill: any) => skill.nid),
        defender: defender.skills.map((skill: any) => skill.nid),
      };
      while (game.actionLog.actions.length > actionStart) game.actionLog.undo();
      const undone = {
        attacker: attacker.skills.map((skill: any) => skill.nid),
        defender: defender.skills.map((skill: any) => skill.nid),
      };

      attacker.skills.push(new SkillObject(game.db.skills.get('MomentumStack')));
      attacker.persistent = true;
      game.cleanUpLevel();
      const persistent = game.persistentUnits.get('Lyn');
      return {
        combatCount: combatCatalog.length,
        chapterCount: chapterCatalog.length,
        removed,
        afterCombat,
        undone,
        afterChapter: persistent.skills.map((skill: any) => skill.nid),
      };
    });

    expect(result).toEqual({
      combatCount: 17,
      chapterCount: 45,
      removed: 2,
      afterCombat: { attacker: [], defender: [] },
      undone: { attacker: ['BaffleStatus'], defender: ['ShieldStatus'] },
      afterChapter: [],
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

  test('turn lifecycle handles Rekka endstep healing, galeforce, upkeep events, and flight', async ({ page }) => {
    await boot(page);
    const result = await page.evaluate(async () => {
      const { applyCombatSkillEndHooks } = await import('/src/combat/combat-lifecycle.ts');
      const { movementType } = await import('/src/combat/skill-system.ts');
      const { applySkillTurnHooks } = await import('/src/engine/skill-turn-lifecycle.ts');
      const { SkillObject } = await import('/src/objects/skill.ts');
      const game = (window as any).__gameRef;
      const unit = game.units.get('Lyn');
      const target = game.units.get('101');
      const weapon = unit.items.find((item: any) => item.isWeapon());
      const componentNids = (prefab: any) => Array.isArray(prefab.components)
        ? prefab.components.map((component: any) => component[0])
        : [...prefab.components.keys()];
      const count = (nid: string) => [...game.db.skills.values()]
        .filter((skill: any) => componentNids(skill).includes(nid)).length;

      unit.currentHp = 5;
      unit.skills = [new SkillObject(game.db.skills.get('MagicCircleStatus'))];
      const endstepStart = game.actionLog.actions.length;
      const endstepEffects = applySkillTurnHooks(game, [unit], 'endstep');
      const endstepHp = unit.currentHp;
      while (game.actionLog.actions.length > endstepStart) game.actionLog.undo();
      const endstepUndoneHp = unit.currentHp;

      const galeforce = new SkillObject(game.db.skills.get('Galeforce'));
      unit.skills = [galeforce];
      Object.assign(unit, {
        hasAttacked: true,
        hasMoved: true,
        hasTraded: true,
        finished: true,
        movementLeft: 0,
      });
      target.currentHp = 0;
      const galeforceStart = game.actionLog.actions.length;
      const galeforceApplied = applyCombatSkillEndHooks(game, [{
        attacker: unit,
        defender: target,
        item: weapon,
        hit: true,
        crit: false,
        damage: 99,
        isCounter: false,
        mode: 'attack',
        attackInfo: [0, 0],
      }], unit, target);
      const afterGaleforce = {
        finished: unit.finished,
        movementLeft: unit.movementLeft,
        charge: galeforce.data.get('charge'),
      };
      while (game.actionLog.actions.length > galeforceStart) game.actionLog.undo();
      const undoneGaleforce = {
        finished: unit.finished,
        movementLeft: unit.movementLeft,
        charge: galeforce.data.get('charge'),
      };

      unit.skills = [];
      const defaultMovement = movementType(
        unit,
        game.db.classes.get(unit.klass)?.movement_group ?? 'Infantry',
        game,
      );
      unit.skills = [new SkillObject(game.db.skills.get('Float'))];
      const flight = {
        helper: movementType(unit, defaultMovement, game),
        pathSystem: (game.pathSystem as any).getMovementGroup(unit),
      };

      return {
        catalog: {
          endstepDamage: count('endstep_damage'),
          upkeepEvents: count('event_on_upkeep'),
          galeforce: count('galeforce'),
          evalGaleforce: count('eval_galeforce'),
          movementType: count('movement_type'),
        },
        endstep: {
          effects: endstepEffects.map((effect: any) => [effect.component, effect.value]),
          hp: endstepHp,
          undoneHp: endstepUndoneHp,
        },
        galeforceApplied,
        afterGaleforce,
        undoneGaleforce,
        defaultMovement,
        flight,
      };
    });

    expect(result.catalog).toEqual({
      endstepDamage: 1,
      upkeepEvents: 20,
      galeforce: 1,
      evalGaleforce: 14,
      movementType: 1,
    });
    expect(result.endstep).toEqual({
      effects: [['endstep_damage', 10]],
      hp: 15,
      undoneHp: 5,
    });
    expect(result.galeforceApplied).toBe(1);
    expect(result.afterGaleforce).toEqual({
      finished: false,
      movementLeft: 6,
      charge: 0,
    });
    expect(result.undoneGaleforce).toEqual({
      finished: true,
      movementLeft: 0,
      charge: 1,
    });
    expect(result.defaultMovement).not.toBe('Fliers');
    expect(result.flight).toEqual({ helper: 'Fliers', pathSystem: 'Fliers' });
  });

  test('targeting, AI, inventory, and shop hooks cover every Rekka use', async ({ page }) => {
    await boot(page);
    const result = await page.evaluate(async () => {
      const {
        inventoryCapacity,
      } = await import('/src/combat/item-system.ts');
      const {
        aiPriorityMultiplier,
        checkAlly,
        checkEnemy,
        inventoryCapacityOffsets,
        priceSkillMultiplier,
        witchWarpPositions,
      } = await import('/src/combat/skill-system.ts');
      const { validTargets, buyPrice } = await import('/src/combat/item-system.ts');
      const { ItemObject } = await import('/src/objects/item.ts');
      const { SkillObject } = await import('/src/objects/skill.ts');
      const game = (window as any).__gameRef;
      const unit = game.units.get('Lyn');
      const alliedTarget = game.units.get('101');
      alliedTarget.team = unit.team;
      const componentNids = (prefab: any) => Array.isArray(prefab.components)
        ? prefab.components.map((component: any) => component[0])
        : [...prefab.components.keys()];
      const count = (nid: string) => [...game.db.skills.values()]
        .filter((skill: any) => componentNids(skill).includes(nid)).length;

      unit.skills = [new SkillObject(game.db.skills.get('BetrayerRing'))];
      const enemyItem = new ItemObject({
        nid: 'TestEnemyTarget',
        name: 'Test Enemy Target',
        desc: '',
        components: [['target_enemy', null]],
      });
      const alliance = {
        ally: checkAlly(unit, alliedTarget, game.db),
        enemy: checkEnemy(unit, alliedTarget, game.db),
        targetable: validTargets(unit, enemyItem, game.board, game.db, game)
          .some(([x, y]: [number, number]) =>
            x === alliedTarget.position[0] && y === alliedTarget.position[1]),
      };

      unit.skills = [new SkillObject(game.db.skills.get('Hoarder'))];
      const offsets = inventoryCapacityOffsets(unit);
      const capacities = {
        baseItems: Number(game.db.getConstant('num_items', 5)),
        baseAccessories: Number(game.db.getConstant('num_accessories', 0)),
        items: inventoryCapacity(unit, false, game.db),
        accessories: inventoryCapacity(unit, true, game.db),
      };

      const priceItem = unit.items.find((item: any) => item.isWeapon());
      unit.skills = [new SkillObject(game.db.skills.get('BargainRingAbility'))];
      const baseBuyPrice = buyPrice(unit, priceItem, game.db, game);
      const buyMultiplier = priceSkillMultiplier(
        unit, priceItem, 'change_buy_price', game,
      );

      alliedTarget.skills = [new SkillObject(game.db.skills.get('CamoflageStatus'))];
      const hiddenPriority = aiPriorityMultiplier(alliedTarget, game);
      alliedTarget.skills = [new SkillObject(game.db.skills.get('Provoke'))];
      const provokePriority = aiPriorityMultiplier(alliedTarget, game);

      unit.skills = [new SkillObject(game.db.skills.get('BeaconWitchWarp'))];
      alliedTarget.skills = [new SkillObject(game.db.skills.get('Beacon'))];
      if (alliedTarget.position) game.board.removeUnit(alliedTarget);
      let beaconPosition: [number, number] | null = null;
      const origin = unit.position;
      for (let y = 1; y < game.board.height - 1 && !beaconPosition; y++) {
        for (let x = 1; x < game.board.width - 1; x++) {
          if (game.board.getUnit(x, y) || !origin) continue;
          const distance = Math.abs(x - origin[0]) + Math.abs(y - origin[1]);
          if (distance <= unit.getMovement() + 2) continue;
          const openAdjacent = [[x, y - 1], [x - 1, y], [x + 1, y], [x, y + 1]]
            .some(([ax, ay]) => !game.board.getUnit(ax, ay));
          if (openAdjacent) {
            beaconPosition = [x, y];
            break;
          }
        }
      }
      if (!beaconPosition) throw new Error('No distant Beacon test position');
      game.board.setUnit(beaconPosition[0], beaconPosition[1], alliedTarget);
      const warpCases: Record<string, number> = {};
      const runWarpCase = (
        sourceNid: string,
        targetSkillNid: string | null,
        targetTeam: string,
        injured: boolean,
        sourceExtraSkillNid: string | null = null,
      ) => {
        unit.skills = [
          new SkillObject(game.db.skills.get(sourceNid)),
          ...(sourceExtraSkillNid
            ? [new SkillObject(game.db.skills.get(sourceExtraSkillNid))]
            : []),
        ];
        alliedTarget.skills = targetSkillNid
          ? [new SkillObject(game.db.skills.get(targetSkillNid))]
          : [];
        alliedTarget.team = targetTeam;
        alliedTarget.currentHp = injured ? Math.max(1, alliedTarget.maxHp - 1) : alliedTarget.maxHp;
        warpCases[sourceNid] = witchWarpPositions(unit, game.board, game.db, game).length;
      };
      runWarpCase('BeaconWitchWarp', 'Beacon', 'player', false);
      runWarpCase('CrisisSurge', null, 'player', true);
      runWarpCase('Sharker', null, 'enemy', true);
      runWarpCase('SwordSummonJoin', 'SwordSummon', 'player', false);
      runWarpCase('SoulLinkJoin', 'Soullinked', 'player', false, 'Soullinked');

      unit.skills = [new SkillObject(game.db.skills.get('BeaconWitchWarp'))];
      alliedTarget.skills = [new SkillObject(game.db.skills.get('Beacon'))];
      alliedTarget.team = 'player';
      const warpPositions = witchWarpPositions(unit, game.board, game.db, game);
      const validMoves = game.pathSystem.getValidMoves(unit, game.board);
      const distantWarp = warpPositions.find(([x, y]) =>
        !!origin && Math.abs(x - origin[0]) + Math.abs(y - origin[1]) > unit.getMovement());
      const warpPath = distantWarp
        ? game.pathSystem.getPath(unit, distantWarp[0], distantWarp[1], game.board)
        : null;

      return {
        catalog: {
          witchWarp: count('witch_warp_expression'),
          ignoreAlliances: count('ignore_alliances'),
          accessories: count('additional_accessories'),
          buyPrice: count('change_buy_price'),
          aiPriority: count('modify_ai_priority'),
        },
        alliance,
        offsets,
        capacities,
        price: {
          base: baseBuyPrice,
          multiplier: buyMultiplier,
          final: Math.trunc(Number(baseBuyPrice ?? 0) * buyMultiplier),
        },
        priorities: { hidden: hiddenPriority, provoke: provokePriority },
        warpCases,
        warp: {
          count: warpPositions.length,
          distant: distantWarp ?? null,
          included: !!distantWarp && validMoves.some(([x, y]) =>
            x === distantWarp[0] && y === distantWarp[1]),
          pathLength: warpPath?.length ?? 0,
        },
      };
    });

    expect(result.catalog).toEqual({
      witchWarp: 5,
      ignoreAlliances: 2,
      accessories: 1,
      buyPrice: 1,
      aiPriority: 2,
    });
    expect(result.alliance).toEqual({ ally: false, enemy: true, targetable: true });
    expect(result.offsets).toEqual({ items: -3, accessories: 3 });
    expect(result.capacities.items).toBe(result.capacities.baseItems - 3);
    expect(result.capacities.accessories).toBe(result.capacities.baseAccessories + 3);
    expect(result.price.multiplier).toBe(-0.5);
    expect(result.price.final).toBe(Math.trunc(result.price.base * -0.5));
    expect(result.priorities).toEqual({ hidden: 0, provoke: 99 });
    expect(result.warpCases).toEqual({
      BeaconWitchWarp: expect.any(Number),
      CrisisSurge: expect.any(Number),
      Sharker: expect.any(Number),
      SwordSummonJoin: expect.any(Number),
      SoulLinkJoin: expect.any(Number),
    });
    for (const count of Object.values(result.warpCases)) expect(count).toBeGreaterThan(0);
    expect(result.warp.count).toBeGreaterThan(0);
    expect(result.warp.distant).not.toBeNull();
    expect(result.warp.included).toBe(true);
    expect(result.warp.pathLength).toBe(1);
  });

  test('real Rekka combat-art and proc children preserve Python ordering and hooks', async ({ page }) => {
    await boot(page);
    const result = await page.evaluate(async () => {
      const { CombatPhaseSolver } = await import('/src/combat/combat-solver.ts');
      const {
        applyCombatSkillEndHooks,
        queueCombatSkillEvents,
      } = await import('/src/combat/combat-lifecycle.ts');
      const { usesConsumedByStrikes } = await import('/src/combat/item-system.ts');
      const { SkillObject } = await import('/src/objects/skill.ts');
      const game = (window as any).__gameRef;
      const attacker = game.units.get('Lyn');
      const defender = game.units.get('101');
      const attackItem = attacker.items.find((item: any) => item.isWeapon());
      const defenseItem = defender.items.find((item: any) => item.isWeapon());
      game.db.equations.set('RE_MOVE', '100');
      game.db.equations.set('DUPLICATE', '100');
      game.db.equations.set('CHARMED_LIFE', '100');

      const combatArt = new SkillObject(game.db.skills.get('Rounders'));
      combatArt.data.set('active', true);
      const combatArtChild = new SkillObject(game.db.skills.get('RoundersArt'));
      combatArtChild.data.set('combatArtSource', combatArt);
      const singer = new SkillObject(game.db.skills.get('Singer'));
      const duplicate = new SkillObject(game.db.skills.get('Duplicate'));
      const charmed = new SkillObject(game.db.skills.get('CharmedLife'));
      attacker.skills = [combatArt, combatArtChild, singer, duplicate];
      defender.skills = [charmed];
      const solver = new CombatPhaseSolver(() => 0, game);
      const strikes = solver.resolve(
        attacker,
        attackItem,
        defender,
        defenseItem,
        game.db,
        'classic',
        game.board,
        ['hit1', 'end'],
      );
      const playback = solver.procPlayback.map((mark: any) =>
        `${mark.kind}:${mark.procSkill.nid}`);
      const temporaryChildrenAfterSolve = {
        singer: attacker.skills.some((skill: any) => skill.nid === 'SingerProc'),
        duplicate: attacker.skills.some((skill: any) => skill.nid === 'DupeProc'),
        charmed: defender.skills.some((skill: any) => skill.nid === 'CharmedLifeProc'),
      };

      const events: any[] = [];
      game.eventManager.triggerSpecific = (nid: string, trigger: any) => {
        events.push({
          nid,
          type: trigger.type,
          unit1: trigger.unit1.nid,
          unit2: trigger.unit2.nid,
          item: trigger.item?.nid ?? null,
          mode: trigger.localArgs.get('mode'),
        });
        return true;
      };
      const queued = queueCombatSkillEvents(
        game, strikes, attacker, defender, attackItem, defenseItem,
      );

      Object.assign(attacker, {
        hasAttacked: true,
        hasMoved: true,
        hasTraded: true,
        finished: true,
        movementLeft: 0,
      });
      const actionStart = game.actionLog.actions.length;
      applyCombatSkillEndHooks(
        game, strikes, attacker, defender, solver.procPlayback,
      );
      const singerReset = {
        finished: attacker.finished,
        movementLeft: attacker.movementLeft,
      };
      while (game.actionLog.actions.length > actionStart) game.actionLog.undo();

      attacker.skills = [new SkillObject(game.db.skills.get('Preserve'))];
      defender.skills = [];
      const preserveSolver = new CombatPhaseSolver(() => 0, game);
      const preserveStrikes = preserveSolver.resolve(
        attacker,
        attackItem,
        defender,
        defenseItem,
        game.db,
        'classic',
        game.board,
        ['hit1', 'end'],
      );
      const preserve = {
        playback: preserveSolver.procPlayback.map((mark: any) =>
          `${mark.kind}:${mark.procSkill.nid}`),
        usesConsumed: usesConsumedByStrikes(attacker, attackItem, preserveStrikes),
      };

      return {
        playback,
        temporaryChildrenAfterSolve,
        queued,
        events,
        singerReset,
        preserve,
      };
    });

    expect(result.playback).toEqual([
      'attack_pre_proc:RoundersArt',
      'attack_pre_proc:SingerProc',
      'defense_pre_proc:CharmedLifeProc',
      'attack_proc:DupeProc',
    ]);
    expect(result.temporaryChildrenAfterSolve).toEqual({
      singer: false,
      duplicate: false,
      charmed: false,
    });
    expect(result.queued).toBe(1);
    expect(result.events).toEqual([{
      nid: 'Global Ability_Duplicate',
      type: 'event_after_hit',
      unit1: 'Lyn',
      unit2: '101',
      item: 'Iron_Sword',
      mode: 'attack',
    }]);
    expect(result.singerReset).toEqual({ finished: false, movementLeft: 6 });
    expect(result.preserve).toEqual({
      playback: ['attack_proc:PreserveProc'],
      usesConsumed: 0,
    });
  });

  test('survival hooks clamp lethal strikes and preserve reversible consumption', async ({ page }) => {
    await boot(page);
    const result = await page.evaluate(async () => {
      const { MapCombat } = await import('/src/combat/map-combat.ts');
      const {
        applyCombatSkillEndHooks,
        queueCombatSkillEvents,
      } = await import('/src/combat/combat-lifecycle.ts');
      const { SkillObject } = await import('/src/objects/skill.ts');
      const game = (window as any).__gameRef;
      const attacker = game.units.get('Lyn');
      const defender = game.units.get('101');
      attacker.skills = [];
      const attackItem = attacker.items.find((item: any) => item.isWeapon());
      const defenseItem = defender.items.find((item: any) => item.isWeapon());
      const run = (skill: any) => {
        defender.currentHp = 1;
        defender.skills = [skill];
        const combat = new MapCombat(
          attacker,
          attackItem,
          defender,
          defenseItem,
          game.db,
          'classic',
          game.board,
          ['hit1', 'end'],
          undefined,
          game,
        );
        combat.skipToEnd();
        const results = combat.applyResults(game.actionLog);
        return { combat, results };
      };

      const nineLives = new SkillObject(game.db.skills.get('NineLives'));
      const nine = run(nineLives);
      const nineApplied = applyCombatSkillEndHooks(
        game, nine.combat.strikes, attacker, defender,
      );
      const nineRemoved = !defender.skills.includes(nineLives);
      const removeAction = game.actionLog.undo();
      const nineRestored = defender.skills.includes(nineLives);
      removeAction.execute();

      const calls: any[] = [];
      game.eventManager.triggerSpecific = (nid: string, trigger: any) => {
        calls.push({
          nid,
          type: trigger.type,
          unit1: trigger.unit1.nid,
          unit2: trigger.unit2.nid,
        });
        return true;
      };
      const soulAtlas = new SkillObject(game.db.skills.get('SoulAtlas'));
      const soul = run(soulAtlas);
      applyCombatSkillEndHooks(game, soul.combat.strikes, attacker, defender);
      const soulQueued = queueCombatSkillEvents(
        game,
        soul.combat.strikes,
        attacker,
        defender,
        attackItem,
        defenseItem,
      );

      const immediate = new SkillObject({
        nid: 'TestTrueMiracleEvent',
        name: 'Test True Miracle Event',
        desc: '',
        components: [
          ['true_miracle_event', 'miracle_now'],
          ['charges_per_turn', 1],
        ],
      });
      immediate.data.set('charge', 1);
      immediate.data.set('total_charge', 1);
      const immediateCombat = run(immediate);
      const immediateApplied = applyCombatSkillEndHooks(
        game, immediateCombat.combat.strikes, attacker, defender,
      );
      const immediateQueued = queueCombatSkillEvents(
        game,
        immediateCombat.combat.strikes,
        attacker,
        defender,
        attackItem,
        defenseItem,
      );
      const chargeAfter = immediate.data.get('charge');
      const chargeAction = game.actionLog.undo();
      const chargeUndone = immediate.data.get('charge');

      return {
        nine: {
          hp: defender.currentHp,
          strikeDamage: nine.combat.strikes[0].damage,
          proc: nine.combat.strikes[0].survivalProc?.component,
          applied: nineApplied,
          removed: nineRemoved,
          action: removeAction.constructor.name,
          restored: nineRestored,
        },
        soul: {
          proc: soul.combat.strikes[0].survivalProc?.component,
          queued: soulQueued,
        },
        immediate: {
          proc: immediateCombat.combat.strikes[0].survivalProc?.component,
          applied: immediateApplied,
          queued: immediateQueued,
          chargeAfter,
          action: chargeAction.constructor.name,
          chargeUndone,
        },
        calls,
      };
    });

    expect(result).toEqual({
      nine: {
        hp: 1,
        strikeDamage: 0,
        proc: 'nine_lives_event',
        applied: 1,
        removed: true,
        action: 'RemoveSkillAction',
        restored: true,
      },
      soul: {
        proc: 'true_miracle_event_after_combat',
        queued: 1,
      },
      immediate: {
        proc: 'true_miracle_event',
        applied: 1,
        queued: 1,
        chargeAfter: 0,
        action: 'SetSkillDataAction',
        chargeUndone: 1,
      },
      calls: [
        {
          nid: 'Global Ability_SoulAtlasTriggered',
          type: 'true_miracle_event_after_combat',
          unit1: '101',
          unit2: 'Lyn',
        },
        {
          nid: 'miracle_now',
          type: 'true_miracle_event',
          unit1: '101',
          unit2: 'Lyn',
        },
      ],
    });
  });

  test('pre/post combat grants, splash damage, and live-to-serve match Rekka data', async ({ page }) => {
    await boot(page);
    const result = await page.evaluate(async () => {
      const {
        applyCombatSkillEndHooks,
        queueCombatSkillStartEvents,
      } = await import('/src/combat/combat-lifecycle.ts');
      const { applyCoreTargetedItem } = await import('/src/engine/states/game-states.ts');
      const { MapCombat } = await import('/src/combat/map-combat.ts');
      const { ItemObject } = await import('/src/objects/item.ts');
      const { SkillObject } = await import('/src/objects/skill.ts');
      const game = (window as any).__gameRef;
      const attacker = game.units.get('Lyn');
      const defender = game.units.get('101');
      const attackItem = attacker.items.find((item: any) => item.isWeapon());
      const defenseItem = defender.items.find((item: any) => item.isWeapon());

      const beforeCombatCatalog = [...game.db.skills.values()]
        .filter((skill: any) => skill.components.some((component: any) =>
          component[0] === 'skill_before_combat'))
        .map((skill: any) => skill.nid);
      attacker.skills = [new SkillObject(game.db.skills.get('Clone'))];
      defender.skills = [];
      const startActions = game.actionLog.actions.length;
      queueCombatSkillStartEvents(game, attacker, defender, attackItem, defenseItem);
      const beforeCombatGranted = defender.skills.map((skill: any) => skill.nid);
      while (game.actionLog.actions.length > startActions) game.actionLog.undo();
      const beforeCombatUndone = defender.skills.map((skill: any) => skill.nid);

      const ally = defender;
      const oldAllyTeam = ally.team;
      ally.team = 'player';
      attacker.skills = [new SkillObject(game.db.skills.get('LifeToServe'))];
      attacker.currentHp = Math.max(1, attacker.maxHp - 10);
      ally.currentHp = Math.max(1, ally.maxHp - 5);
      const healItem = new ItemObject({
        nid: 'TestBaseHeal',
        name: 'Test Base Heal',
        desc: '',
        components: [
          ['usable', null],
          ['target_ally', null],
          ['heal', 5],
          ['uses', 3],
        ],
      });
      healItem.owner = attacker;
      attacker.items.push(healItem);
      const healingStart = game.actionLog.actions.length;
      const hpBefore = { attacker: attacker.currentHp, ally: ally.currentHp };
      const healed = applyCoreTargetedItem(attacker, healItem, ally.position);
      const hpAfter = { attacker: attacker.currentHp, ally: ally.currentHp };
      while (game.actionLog.actions.length > healingStart) game.actionLog.undo();
      ally.team = oldAllyTeam;

      const splashTarget = [...game.units.values()].find((unit: any) =>
        unit !== defender && unit.team === 'enemy' && unit.position);
      const adjacent = [
        [defender.position[0] + 1, defender.position[1]],
        [defender.position[0] - 1, defender.position[1]],
        [defender.position[0], defender.position[1] + 1],
        [defender.position[0], defender.position[1] - 1],
      ].find(([x, y]) => game.board.inBounds(x, y) && !game.board.getUnit(x, y));
      game.board.moveUnit(splashTarget, adjacent[0], adjacent[1]);
      splashTarget.currentHp = 20;
      attacker.skills = [new SkillObject(game.db.skills.get('BrutalSwingArt'))];
      const splashStart = game.actionLog.actions.length;
      const splashApplied = applyCombatSkillEndHooks(game, [{
        attacker,
        defender,
        item: attackItem,
        hit: true,
        crit: false,
        damage: 1,
        isCounter: false,
        mode: 'attack',
        attackInfo: [0, 0],
      }], attacker, defender);
      const splashHp = splashTarget.currentHp;
      while (game.actionLog.actions.length > splashStart) game.actionLog.undo();
      const splashUndone = splashTarget.currentHp;

      defender.currentHp = defender.maxHp;
      defender.skills = [new SkillObject(game.db.skills.get('AtBat'))];
      const missCombat = new MapCombat(
        attacker, attackItem, defender, defenseItem, game.db, 'classic', game.board,
        ['miss1', 'end'], undefined, game,
      );
      const missGrant = defender.skills.some((skill: any) => skill.nid === 'AtBatBall');
      defender.skills = [new SkillObject(game.db.skills.get('AtBat'))];
      const damageCombat = new MapCombat(
        attacker, attackItem, defender, defenseItem, game.db, 'classic', game.board,
        ['hit1', 'end'], undefined, game,
      );
      const damageGrant = defender.skills.some((skill: any) => skill.nid === 'AtBatStrike');

      attacker.skills = [
        new SkillObject(game.db.skills.get('AtBat')),
        new SkillObject(game.db.skills.get('Waiter')),
        new SkillObject(game.db.skills.get('NorthStarArt')),
      ];
      defender.skills = [];
      defender.currentHp = 1;
      const grantCombat = new MapCombat(
        attacker, attackItem, defender, defenseItem, game.db, 'classic', game.board,
        ['hit1', 'end'], undefined, game,
      );
      grantCombat.skipToEnd();
      grantCombat.applyResults(game.actionLog);
      const grantStart = game.actionLog.actions.length;
      const grantsApplied = applyCombatSkillEndHooks(
        game, grantCombat.strikes, attacker, defender,
      );
      const granted = attacker.skills
        .map((skill: any) => skill.nid)
        .filter((nid: string) => ['AtBatBase', 'HasAttacked', 'NorthStarStatus'].includes(nid))
        .sort();
      while (game.actionLog.actions.length > grantStart) game.actionLog.undo();
      const grantsUndone = attacker.skills.some((skill: any) =>
        ['AtBatBase', 'HasAttacked', 'NorthStarStatus'].includes(skill.nid));

      return {
        beforeCombatCount: beforeCombatCatalog.length,
        beforeCombatGranted,
        beforeCombatUndone,
        healing: {
          applied: healed,
          attacker: hpAfter.attacker - hpBefore.attacker,
          ally: hpAfter.ally - hpBefore.ally,
        },
        splash: { applied: splashApplied, hp: splashHp, undone: splashUndone },
        immediate: {
          missStrikes: missCombat.strikes.length,
          missGrant,
          damageStrikes: damageCombat.strikes.length,
          damageGrant,
        },
        grants: { applied: grantsApplied, granted, undone: grantsUndone },
      };
    });

    expect(result).toEqual({
      beforeCombatCount: 6,
      beforeCombatGranted: ['Braveheart'],
      beforeCombatUndone: [],
      healing: { applied: true, attacker: 5, ally: 5 },
      splash: { applied: 1, hp: 5, undone: 20 },
      immediate: {
        missStrikes: 1,
        missGrant: true,
        damageStrikes: 1,
        damageGrant: true,
      },
      grants: {
        applied: 3,
        granted: ['AtBatBase', 'HasAttacked', 'NorthStarStatus'],
        undone: false,
      },
    });
  });

  test('unit control, status reflection, damage prevention, and death tether are reversible', async ({ page }) => {
    await boot(page);
    const result = await page.evaluate(async () => {
      const { AddSkillAction, DeathAction } = await import('/src/engine/action.ts');
      const { MapCombat } = await import('/src/combat/map-combat.ts');
      const { canSelect } = await import('/src/combat/skill-system.ts');
      const { SkillObject } = await import('/src/objects/skill.ts');
      const game = (window as any).__gameRef;
      const attacker = game.units.get('Lyn');
      const defender = game.units.get('101');
      const attackItem = attacker.items.find((item: any) => item.isWeapon());
      const defenseItem = defender.items.find((item: any) => item.isWeapon());

      attacker.skills = [new SkillObject(game.db.skills.get('Stunned'))];
      const selectable = canSelect(attacker);

      attacker.skills = [];
      defender.skills = [
        new SkillObject(game.db.skills.get('DarkGift')),
        new SkillObject(game.db.skills.get('TheNineVolumesOfNonsense10')),
      ];
      const reflectedStatus = new SkillObject(game.db.skills.get('BaffleStatus'));
      reflectedStatus.initiatorNid = attacker.nid;
      game.actionLog.doAction(new AddSkillAction(defender, reflectedStatus));
      const afterStatus = {
        attacker: attacker.skills.map((skill: any) => skill.nid),
        defender: defender.skills.map((skill: any) => skill.nid),
      };
      const statusAction = game.actionLog.undo();
      const undoneStatus = {
        attacker: attacker.skills.map((skill: any) => skill.nid),
        defender: defender.skills.map((skill: any) => skill.nid),
      };

      const run = (skillNid: string, hp: number) => {
        defender.currentHp = hp;
        defender.skills = [new SkillObject(game.db.skills.get(skillNid))];
        const combat = new MapCombat(
          attacker,
          attackItem,
          defender,
          defenseItem,
          game.db,
          'classic',
          game.board,
          ['hit1', 'end'],
          undefined,
          game,
        );
        combat.skipToEnd();
        combat.applyResults(game.actionLog);
        return {
          hp: defender.currentHp,
          damage: combat.strikes[0].damage,
          proc: combat.strikes[0].survivalProc?.component ?? null,
          defenseProc: combat.strikes[0].defenseProcs?.at(-1)?.procSkill.nid ?? null,
        };
      };
      const ignored = run('IgnoreDamage', 20);
      const endured = run('EndureStatus', 1);

      attacker.skills = [new SkillObject(game.db.skills.get('Split'))];
      const tethered = new SkillObject(game.db.skills.get('BaffleStatus'));
      tethered.initiatorNid = attacker.nid;
      defender.skills = [tethered];
      const death = new DeathAction(attacker, game.board, game.initiative);
      game.actionLog.doAction(death);
      const afterDeath = {
        dead: attacker.dead,
        tethered: defender.skills.includes(tethered),
      };
      const deathAction = game.actionLog.undo();
      const undoneDeath = {
        dead: attacker.dead,
        tethered: defender.skills.includes(tethered),
        onBoard: game.board.getUnit(attacker.position[0], attacker.position[1]) === attacker,
      };

      return {
        selectable,
        afterStatus,
        statusAction: statusAction.constructor.name,
        undoneStatus,
        ignored,
        endured,
        afterDeath,
        deathAction: deathAction.constructor.name,
        undoneDeath,
      };
    });

    expect(result).toEqual({
      selectable: false,
      afterStatus: {
        attacker: ['BaffleStatus'],
        defender: ['DarkGift', 'TheNineVolumesOfNonsense10'],
      },
      statusAction: 'AddSkillAction',
      undoneStatus: {
        attacker: [],
        defender: ['DarkGift', 'TheNineVolumesOfNonsense10'],
      },
      ignored: {
        hp: 20,
        damage: 0,
        proc: 'ignore_damage',
        defenseProc: 'IgnoreDamage',
      },
      endured: {
        hp: 1,
        damage: 0,
        proc: 'TrueMiracle',
        defenseProc: 'EndureStatus',
      },
      afterDeath: { dead: true, tethered: false },
      deathAction: 'DeathAction',
      undoneDeath: { dead: false, tethered: true, onBoard: true },
    });
  });

  test('combat math hooks cover Rekka durability, crit, and maximum range', async ({ page }) => {
    await boot(page);
    const result = await page.evaluate(async () => {
      const { CombatPhaseSolver } = await import('/src/combat/combat-solver.ts');
      const {
        canCounterattack,
        computeCrit,
        computeDamage,
        weaponTriangle,
      } = await import('/src/combat/combat-calcs.ts');
      const {
        usesConsumedByStrikes,
      } = await import('/src/combat/item-system.ts');
      const {
        armsthriftRestoration,
        modifiedMaximumRange,
      } = await import('/src/combat/skill-system.ts');
      const { ItemObject } = await import('/src/objects/item.ts');
      const { SkillObject } = await import('/src/objects/skill.ts');
      const game = (window as any).__gameRef;
      const attacker = game.units.get('Lyn');
      const defender = game.units.get('101');
      const attackItem = attacker.items.find((item: any) => item.isWeapon());
      const defenseItem = defender.items.find((item: any) => item.isWeapon());
      const componentNids = (prefab: any) => Array.isArray(prefab.components)
        ? prefab.components.map((component: any) => component[0])
        : [...prefab.components.keys()];
      const count = (nid: string) => [...game.db.skills.values()]
        .filter((skill: any) => componentNids(skill).includes(nid)).length;

      attacker.skills = [new SkillObject(game.db.skills.get('Blessed'))];
      const strike = {
        attacker,
        defender,
        item: attackItem,
        hit: true,
        crit: false,
        damage: 1,
        isCounter: false,
        mode: 'attack',
        attackInfo: [0, 0],
      };
      const unrepairable = new ItemObject({
        nid: 'TestUnrepairable',
        name: 'Test Unrepairable',
        desc: '',
        components: [['weapon_type', 'Sword'], ['uses', 10], ['unrepairable', null]],
      });
      const unrepairableStrike = { ...strike, item: unrepairable };
      const durability = {
        restoration: armsthriftRestoration(attacker, attackItem),
        twoHits: usesConsumedByStrikes(attacker, attackItem, [strike, strike]),
        unrepairable: usesConsumedByStrikes(attacker, unrepairable, [unrepairableStrike]),
      };

      attacker.skills = [new SkillObject(game.db.skills.get('FuriosoArt'))];
      const dynamicCrit = computeCrit(
        attacker, attackItem, defender, game.db, game, 'attack', [2, 1],
      );
      attacker.skills = [new SkillObject(game.db.skills.get('Poise'))];
      attacker.previousPosition = attacker.position
        ? [attacker.position[0], attacker.position[1]]
        : null;
      const poiseStanding = computeCrit(attacker, attackItem, defender, game.db, game);
      attacker.previousPosition = attacker.position
        ? [attacker.position[0] + 1, attacker.position[1]]
        : null;
      const poiseMoved = computeCrit(attacker, attackItem, defender, game.db, game);

      attacker.skills = [new SkillObject(game.db.skills.get('Lethal'))];
      const normalDamage = computeDamage(
        attacker, attackItem, defender, game.db, game.board, game,
      ) + weaponTriangle(attackItem, defenseItem, game.db, attacker, defender).damageBonus;
      const lethalStrike = new CombatPhaseSolver(() => 0, game).resolve(
        attacker,
        attackItem,
        defender,
        defenseItem,
        game.db,
        'classic',
        game.board,
        ['crit1', 'end'],
      )[0];

      const oldAttackerPosition = attacker.position;
      const oldDefenderPosition = defender.position;
      attacker.position = [0, 0];
      defender.position = [6, 0];
      defender.skills = [new SkillObject(game.db.skills.get('Savant'))];
      const oldDefenseWeaponType = defenseItem.getComponent('weapon_type');
      defenseItem.components.set('weapon_type', 'Staff');
      const range = {
        base: defenseItem.getMaxRange(),
        modified: modifiedMaximumRange(defender, defenseItem, game),
        countersAtSix: canCounterattack(attacker, attackItem, defender, game.db, game),
      };
      defenseItem.components.set('weapon_type', oldDefenseWeaponType);
      attacker.position = oldAttackerPosition;
      defender.position = oldDefenderPosition;
      attacker.previousPosition = [7, 8];
      const snapshot = (window as any).__harness.saveSnapshot();
      await (window as any).__harness.loadSnapshot(snapshot);
      const savedPreviousPosition = game.units.get('Lyn').previousPosition;

      return {
        catalog: {
          armsthrift: count('armsthrift'),
          dynamicCrit: count('dynamic_crit_accuracy'),
          alternateCrit: count('alternate_critical_multiplier_formula'),
          maximumRange: count('modify_maximum_range'),
        },
        durability,
        dynamicCrit,
        poise: { standing: poiseStanding, moved: poiseMoved },
        normalDamage,
        lethalDamage: lethalStrike.damage,
        range,
        savedPreviousPosition,
      };
    });

    expect(result.catalog).toEqual({
      armsthrift: 2,
      dynamicCrit: 4,
      alternateCrit: 1,
      maximumRange: 3,
    });
    expect(result.durability).toEqual({
      restoration: 1,
      twoHits: 0,
      unrepairable: 1,
    });
    expect(result.dynamicCrit).toBe(100);
    expect(result.poise.standing).toBe(100);
    expect(result.poise.moved).toBeLessThan(100);
    expect(result.lethalDamage).toBe(result.normalDamage * 999);
    expect(result.range).toEqual({
      base: 1,
      modified: 6,
      countersAtSix: true,
    });
    expect(result.savedPreviousPosition).toEqual([7, 8]);
  });
});
