import { expect, test } from '@playwright/test';

async function waitForHarness(page: import('@playwright/test').Page): Promise<void> {
  await page.waitForFunction(() => !!(window as any).__harness?.ready, { timeout: 15000 });
}

test.describe('post-combat item menu hooks', () => {
  test('menu and attack-after-combat hooks preserve Python turn flags and menu access', async ({ page }) => {
    await page.goto('/?harness=true&level=0&clean=true&bundle=false');
    await waitForHarness(page);

    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { ItemObject } = await import('/src/objects/item.ts');
      const {
        menuAfterCombat,
        canAttackAfterCombat,
      } = await import('/src/combat/item-system.ts');
      const {
        HasAttackedAction,
        HasNotAttackedAction,
        HasTradedAction,
      } = await import('/src/engine/action.ts');
      const { MenuState, setGameRef } =
        await import('/src/engine/states/game-states.ts');
      const unit = game.units.get('Eirika');
      if (!unit) return null;
      setGameRef(game);

      const makeItem = (nid: string, component: string) => new ItemObject({
        nid, name: nid, desc: '', icon_nid: '', icon_index: [0, 0],
        components: [[component, null]],
      });
      const menuItem = makeItem('_MenuAfter', 'menu_after_combat');
      const attackItem = makeItem('_AttackAfter', 'attack_after_combat');
      const plainItem = makeItem('_Plain', 'weapon');
      const hooks = {
        menu: [menuAfterCombat(unit, menuItem), canAttackAfterCombat(unit, menuItem)],
        attack: [menuAfterCombat(unit, attackItem), canAttackAfterCombat(unit, attackItem)],
        plain: [menuAfterCombat(unit, plainItem), canAttackAfterCombat(unit, plainItem)],
      };

      const oldFlags = {
        hasAttacked: unit.hasAttacked,
        hasTraded: unit.hasTraded,
        finished: unit.finished,
      };
      unit.hasAttacked = false;
      unit.hasTraded = false;
      unit.finished = false;
      const beforeActionIndex = game.actionLog.actionIndex;
      game.actionLog.doAction(new HasAttackedAction(unit));
      game.actionLog.doAction(new HasNotAttackedAction(unit));
      game.actionLog.doAction(new HasTradedAction(unit));
      const afterActionIndex = game.actionLog.actionIndex;
      const attackAfterFlags = {
        hasAttacked: unit.hasAttacked,
        hasTraded: unit.hasTraded,
        finished: unit.finished,
      };

      unit.hasAttacked = true;
      unit.hasTraded = false;
      unit.finished = false;
      game.selectedUnit = unit;
      game.memory.set('menu_after_combat', unit.nid);
      const menu: any = new MenuState();
      menu.begin();
      const menuLabels = menu.menu?.options.map((option: any) => option.label) ?? [];
      const markerConsumed = !game.memory.has('menu_after_combat');

      while (game.actionLog.actionIndex > beforeActionIndex) {
        game.actionLog.runActionBackward();
      }
      while (game.actionLog.actionIndex < afterActionIndex) {
        game.actionLog.runActionForward();
      }
      const redoneFlags = {
        hasAttacked: unit.hasAttacked,
        hasTraded: unit.hasTraded,
        finished: unit.finished,
      };
      while (game.actionLog.actionIndex > beforeActionIndex) {
        game.actionLog.runActionBackward();
      }
      unit.hasAttacked = oldFlags.hasAttacked;
      unit.hasTraded = oldFlags.hasTraded;
      unit.finished = oldFlags.finished;
      return { hooks, attackAfterFlags, redoneFlags, menuLabels, markerConsumed };
    });

    expect(result).not.toBeNull();
    expect(result!.hooks).toEqual({
      menu: [true, false],
      attack: [true, true],
      plain: [false, false],
    });
    expect(result!.attackAfterFlags).toEqual({
      hasAttacked: false,
      hasTraded: true,
      finished: false,
    });
    expect(result!.redoneFlags).toEqual(result!.attackAfterFlags);
    expect(result!.menuLabels).not.toContain('Attack');
    expect(result!.menuLabels).toContain('Wait');
    expect(result!.markerConsumed).toBe(true);
  });
});
