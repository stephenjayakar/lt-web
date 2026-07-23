import { expect, test } from '@playwright/test';

async function waitForHarness(page: import('@playwright/test').Page): Promise<void> {
  await page.waitForFunction(() => !!(window as any).__harness?.ready, { timeout: 15000 });
}

test.describe('class-change and movement-restricted items', () => {
  test('reclasses from alternate_classes reversibly and blocks no-attack-after-move items', async ({ page }) => {
    await page.goto('/?harness=true&level=0&clean=true&bundle=false');
    await waitForHarness(page);

    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { ItemObject } = await import('/src/objects/item.ts');
      const {
        available,
        noAttackAfterMove,
        targetRestrict,
      } = await import('/src/combat/item-system.ts');
      const {
        applyCoreTargetedItem,
        PromotionChoiceState,
        setGameRef,
      } = await import('/src/engine/states/game-states.ts');
      const unit = game.units.get('Eirika');
      const prefab = game.db.units.get('Eirika');
      const sourceClass = game.db.classes.get('Fighter');
      const targetKlass = game.db.classes.has('Cavalier')
        ? 'Cavalier'
        : [...game.db.classes.keys()].find((nid: string) => nid !== 'Fighter');
      if (!unit || !prefab || !sourceClass || !targetKlass || !unit.position) return null;
      setGameRef(game);

      const oldAlternate = (prefab as any).alternate_classes;
      (prefab as any).alternate_classes = [targetKlass];
      const oldState = {
        klass: unit.klass,
        stats: { ...unit.stats },
        maxStats: { ...unit.maxStats },
        level: unit.level,
        exp: unit.exp,
        items: [...unit.items],
        finished: unit.finished,
        hasMoved: unit.hasMoved,
      };
      unit.klass = 'Fighter';
      unit.stats = { ...sourceClass.bases };
      unit.maxStats = { ...sourceClass.max_stats };
      unit.level = 10;
      unit.exp = 30;
      unit.finished = false;
      unit.hasMoved = false;

      const reclassItem = new ItemObject({
        nid: '_ClassChangeItem', name: 'Second Seal', desc: '',
        icon_nid: '', icon_index: [0, 0],
        components: [
          ['class_change', null],
          ['target_ally', null],
          ['min_range', 0],
          ['max_range', 0],
          ['uses', 1],
        ],
      });
      reclassItem.owner = unit;
      unit.items = [reclassItem];
      const restriction = targetRestrict(
        unit,
        reclassItem,
        unit.position,
        [],
        { board: game.board, db: game.db, game },
      );
      const beforeActionIndex = game.actionLog.actionIndex;
      const applied = applyCoreTargetedItem(unit, reclassItem, unit.position);
      const changed = {
        klass: unit.klass,
        uses: reclassItem.uses,
        inInventory: unit.items.includes(reclassItem),
        finished: unit.finished,
      };
      while (game.actionLog.actionIndex > beforeActionIndex) {
        game.actionLog.runActionBackward();
      }
      const reversed = {
        klass: unit.klass,
        uses: reclassItem.uses,
        inInventory: unit.items.includes(reclassItem),
        finished: unit.finished,
      };

      const secondKlass = [...game.db.classes.keys()].find(
        (nid: string) => nid !== 'Fighter' && nid !== targetKlass,
      );
      let choice: { klass: string; backs: number } | null = null;
      if (secondKlass) {
        const choiceItem = new ItemObject({
          nid: '_ClassChoiceItem', name: 'Choice Seal', desc: '',
          icon_nid: '', icon_index: [0, 0],
          components: [['class_change', null], ['uses', 1]],
        });
        choiceItem.owner = unit;
        unit.items = [choiceItem];
        unit.klass = 'Fighter';
        unit.finished = false;
        const choiceBeforeIndex = game.actionLog.actionIndex;
        game.memory.set('promotion_choice_unit', unit);
        game.memory.set('promotion_choice_options', [targetKlass, secondKlass]);
        game.memory.set('promotion_choice_item', choiceItem);
        game.memory.set('promotion_choice_actor', unit);
        game.memory.set('promotion_choice_source', 'change_class');
        const choiceState: any = new PromotionChoiceState();
        choiceState.begin();
        choiceState.menu.selectedIndex = 1;
        let backs = 0;
        const originalBack = game.state.back;
        game.state.back = () => { backs++; };
        choiceState.takeInput('SELECT');
        game.state.back = originalBack;
        choice = { klass: unit.klass, backs };
        while (game.actionLog.actionIndex > choiceBeforeIndex) {
          game.actionLog.runActionBackward();
        }
      }

      const movementItem = new ItemObject({
        nid: '_StationaryOnly', name: 'Stationary Only', desc: '',
        icon_nid: '', icon_index: [0, 0],
        components: [['no_attack_after_move', null]],
      });
      unit.hasMoved = false;
      const beforeMove = available(unit, movementItem, game.db, game);
      unit.hasMoved = true;
      const afterMove = available(unit, movementItem, game.db, game);
      const hook = noAttackAfterMove(unit, movementItem);

      (prefab as any).alternate_classes = oldAlternate;
      unit.klass = oldState.klass;
      unit.stats = oldState.stats;
      unit.maxStats = oldState.maxStats;
      unit.level = oldState.level;
      unit.exp = oldState.exp;
      unit.items = oldState.items;
      unit.finished = oldState.finished;
      unit.hasMoved = oldState.hasMoved;
      return {
        restriction,
        applied,
        targetKlass,
        changed,
        reversed,
        choice,
        secondKlass: secondKlass ?? null,
        movement: { beforeMove, afterMove, hook },
      };
    });

    expect(result).not.toBeNull();
    expect(result!.restriction).toBe(true);
    expect(result!.applied).toBe(true);
    expect(result!.changed).toEqual({
      klass: result!.targetKlass,
      uses: 0,
      inInventory: false,
      finished: true,
    });
    expect(result!.reversed).toEqual({
      klass: 'Fighter',
      uses: 1,
      inInventory: true,
      finished: false,
    });
    if (result!.secondKlass) {
      expect(result!.choice).toEqual({ klass: result!.secondKlass, backs: 2 });
    }
    expect(result!.movement).toEqual({
      beforeMove: true,
      afterMove: false,
      hook: true,
    });
  });
});
