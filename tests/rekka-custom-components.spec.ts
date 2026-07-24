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
});
