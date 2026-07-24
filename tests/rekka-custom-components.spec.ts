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
