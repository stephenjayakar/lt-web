/**
 * Promotion-item flow parity tests.
 *
 * Ports lt-maker's Promote / ForcePromote item components
 * (app/engine/item_components/class_change_components.py) and the
 * 'promotion' / 'promotion_choice' states. See PLAN.md for the tracked
 * row and src/engine/states/game-states.ts (performPromotionOrClassChange,
 * ItemTargetingState.selectTarget, PromotionChoiceState) for the
 * implementation.
 *
 * Deviation from Python: the promotion display is a simplified
 * keyboard/mouse choice menu (PromotionChoiceState) rather than the full
 * scroll/fanfare animation screen. Mechanics (class swap, stat gains per
 * the promotion-value sentinel formula, wexp gain, learned-skill grants,
 * stat caps, level reset) are exact.
 */

import { test, expect } from '@playwright/test';

async function waitForHarness(page: any) {
  await page.waitForFunction(
    () => (window as any).__harness?.ready === true,
    { timeout: 30_000 },
  );
}

async function stepFrames(page: any, count: number, input?: string | null) {
  await page.evaluate(
    ({ count, input }: { count: number; input: string | null }) => {
      (window as any).__harness.stepFrames(count, input);
    },
    { count, input: input ?? null },
  );
}

async function getState(page: any) {
  return page.evaluate(() => (window as any).__harness.getState());
}

test.describe('Promotion item flow', () => {
  test('Master Seal promotes a Fighter through the multi-option promotion_choice state', async ({ page }) => {
    await page.goto('/?harness=true&level=0&clean=true&bundle=false');
    await waitForHarness(page);

    const setup = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { ItemObject } = await import('/src/objects/item.ts');
      const unit = game.units.get('Eirika');
      const klass = game.db.classes.get('Fighter');
      const itemPrefab = game.db.items.get('Master_Seal');
      if (!unit || !klass || !itemPrefab) return null;

      unit.klass = 'Fighter';
      unit.stats = { ...klass.bases };
      unit.maxStats = { ...klass.max_stats };
      unit.level = 10;
      unit.exp = 0;
      unit.wexp = {};
      unit.skills = [];
      unit.currentHp = klass.bases.HP;
      unit.finished = false;
      unit.hasMoved = false;
      unit.hasAttacked = false;
      unit.items = [];

      const item = new ItemObject(itemPrefab);
      item.owner = unit;
      unit.items.push(item);

      const validTargets = game.targetSystem.getValidTargets(unit, item);
      const options = game.db.classes.get('Fighter').turns_into;

      game.selectedUnit = unit;
      if (unit.position) game.cursor.setPos(unit.position[0], unit.position[1]);
      const beforeActionIndex = game.actionLog.actionIndex;
      game.state.change('item_use');

      return {
        unitNid: unit.nid,
        validTargetCount: validTargets.length,
        options,
        beforeActionIndex,
        beforeStats: { ...unit.stats },
        beforeMaxStats: { ...unit.maxStats },
        beforeKlass: unit.klass,
        beforeLevel: unit.level,
        beforeExp: unit.exp,
        beforeWexp: { ...unit.wexp },
        beforeSkills: unit.skills.map((s: any) => s.nid),
      };
    });
    expect(setup).not.toBeNull();
    expect(setup!.validTargetCount).toBe(1); // self-target only (range 0)
    expect(setup!.options).toEqual(['Hero', 'Warrior']);

    await stepFrames(page, 2);
    expect((await getState(page)).currentStateName).toBe('item_use');

    await stepFrames(page, 1, 'SELECT'); // pick the (only) item
    await stepFrames(page, 2);
    expect((await getState(page)).currentStateName).toBe('item_targeting');

    await stepFrames(page, 1, 'SELECT'); // confirm the (only, self) target
    await stepFrames(page, 2);
    expect((await getState(page)).currentStateName).toBe('promotion_choice');

    // Exercise the choice menu: move to the second option (Warrior) and select it.
    await stepFrames(page, 1, 'DOWN');
    await stepFrames(page, 1, 'SELECT');
    await stepFrames(page, 3);

    const result = await page.evaluate(({ unitNid, beforeActionIndex }) => {
      const game = (window as any).__gameRef;
      const unit = game.units.get(unitNid);
      const item = unit.items.find((i: any) => i.nid === 'Master_Seal');
      return {
        state: game.state.getCurrentState()?.name,
        klass: unit.klass,
        level: unit.level,
        exp: unit.exp,
        stats: { ...unit.stats },
        wexp: { ...unit.wexp },
        skillNids: unit.skills.map((s: any) => s.nid),
        itemPresent: !!item,
        itemUses: item?.uses,
        finished: unit.finished,
        actionIndexAdvanced: game.actionLog.actionIndex > beforeActionIndex,
      };
    }, { unitNid: setup!.unitNid, beforeActionIndex: setup!.beforeActionIndex });

    expect(result.klass).toBe('Warrior');
    expect(result.level).toBe(1); // promote_level_reset
    expect(result.exp).toBe(0);
    // Fighter bases -> Warrior promotion values (uncapped by Warrior max_stats).
    expect(result.stats).toEqual({
      HP: 23, STR: 6, MAG: 0, SKL: 4, SPD: 4, LCK: 0, DEF: 5, CON: 13, MOV: 6, RES: 3, LEAD: 0,
    });
    // Warrior wexp_gain: Axe [true, 40], Bow [true, 1].
    expect(result.wexp).toEqual({ Axe: 40, Bow: 1 });
    expect(result.skillNids).toEqual([]); // Warrior has no learned_skills
    // Item is consumable with 1 use; it is removed once exhausted.
    expect(result.itemPresent).toBe(false);
    expect(result.finished).toBe(true);
    expect(result.actionIndexAdvanced).toBe(true);
    expect(result.state).toBe('free');
  });

  test('Master Seal auto-promotes a single-option Pirate to Berserker, granting class skills', async ({ page }) => {
    await page.goto('/?harness=true&level=0&clean=true&bundle=false');
    await waitForHarness(page);

    const setup = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { ItemObject } = await import('/src/objects/item.ts');
      const unit = game.units.get('Eirika');
      const klass = game.db.classes.get('Pirate');
      const itemPrefab = game.db.items.get('Master_Seal');
      if (!unit || !klass || !itemPrefab) return null;

      unit.klass = 'Pirate';
      unit.stats = { ...klass.bases };
      unit.maxStats = { ...klass.max_stats };
      unit.level = 10;
      unit.exp = 0;
      unit.wexp = {};
      unit.skills = [];
      unit.currentHp = klass.bases.HP;
      unit.finished = false;
      unit.hasMoved = false;
      unit.hasAttacked = false;
      unit.items = [];

      const item = new ItemObject(itemPrefab);
      item.owner = unit;
      unit.items.push(item);

      game.selectedUnit = unit;
      if (unit.position) game.cursor.setPos(unit.position[0], unit.position[1]);
      game.state.change('item_use');
      return { unitNid: unit.nid, options: game.db.classes.get('Pirate').turns_into };
    });
    expect(setup).not.toBeNull();
    expect(setup!.options).toEqual(['Berserker']);

    await stepFrames(page, 2);
    expect((await getState(page)).currentStateName).toBe('item_use');
    await stepFrames(page, 1, 'SELECT');
    await stepFrames(page, 2);
    expect((await getState(page)).currentStateName).toBe('item_targeting');
    await stepFrames(page, 1, 'SELECT'); // single option: auto-applies, no promotion_choice
    await stepFrames(page, 3);

    const result = await page.evaluate(({ unitNid }) => {
      const game = (window as any).__gameRef;
      const unit = game.units.get(unitNid);
      return {
        state: game.state.getCurrentState()?.name,
        klass: unit.klass,
        level: unit.level,
        stats: { ...unit.stats },
        wexp: { ...unit.wexp },
        skillNids: unit.skills.map((s: any) => s.nid),
      };
    }, { unitNid: setup!.unitNid });

    expect(result.state).toBe('free');
    expect(result.klass).toBe('Berserker');
    expect(result.stats).toEqual({
      HP: 23, STR: 5, MAG: 0, SKL: 3, SPD: 7, LCK: 0, DEF: 5, CON: 13, MOV: 6, RES: 2, LEAD: 0,
    });
    expect(result.wexp).toEqual({ Axe: 40 });
    expect(result.skillNids).toEqual(['Crit_Plus15']);
  });

  test('invalid promotion targets are excluded (level gate and already-maxed class)', async ({ page }) => {
    await page.goto('/?harness=true&level=0&clean=true&bundle=false');
    await waitForHarness(page);

    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { ItemObject } = await import('/src/objects/item.ts');
      const itemPrefab = game.db.items.get('Master_Seal');
      const unit = game.units.get('Seth');
      if (!unit || !itemPrefab) return null;

      const item = new ItemObject(itemPrefab);
      item.owner = unit;

      // Below the eval_target_restrict_2 level gate (unit.level >= 10).
      unit.klass = 'Fighter';
      unit.level = 5;
      unit.items = [item];
      const belowLevelTargets = game.targetSystem.getValidTargets(unit, item);

      // At/above the level gate but already at max tier (no turns_into).
      unit.klass = 'Warrior';
      unit.level = 10;
      const maxedClassTargets = game.targetSystem.getValidTargets(unit, item);

      // Eligible: correct class, correct level.
      unit.klass = 'Fighter';
      unit.level = 10;
      const eligibleTargets = game.targetSystem.getValidTargets(unit, item);

      return {
        belowLevelCount: belowLevelTargets.length,
        maxedClassCount: maxedClassTargets.length,
        eligibleCount: eligibleTargets.length,
      };
    });
    expect(result).not.toBeNull();
    expect(result!.belowLevelCount).toBe(0);
    expect(result!.maxedClassCount).toBe(0); // Warrior not in Master_Seal's prf_class
    expect(result!.eligibleCount).toBe(1);
  });

  test('turnwheel undo restores class, level, exp, stats, wexp, and skills exactly', async ({ page }) => {
    await page.goto('/?harness=true&level=0&clean=true&bundle=false');
    await waitForHarness(page);

    const setup = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { ItemObject } = await import('/src/objects/item.ts');
      const unit = game.units.get('Eirika');
      const klass = game.db.classes.get('Pirate');
      const itemPrefab = game.db.items.get('Master_Seal');
      if (!unit || !klass || !itemPrefab) return null;

      unit.klass = 'Pirate';
      unit.stats = { ...klass.bases };
      unit.maxStats = { ...klass.max_stats };
      unit.level = 10;
      unit.exp = 0;
      unit.wexp = { Sword: 5 };
      unit.skills = [];
      unit.currentHp = klass.bases.HP;
      unit.finished = false;
      unit.hasMoved = false;
      unit.hasAttacked = false;
      unit.items = [];

      const item = new ItemObject(itemPrefab);
      item.owner = unit;
      unit.items.push(item);

      const before = {
        klass: unit.klass,
        level: unit.level,
        exp: unit.exp,
        stats: { ...unit.stats },
        maxStats: { ...unit.maxStats },
        wexp: { ...unit.wexp },
        skillNids: unit.skills.map((s: any) => s.nid),
        itemNids: unit.items.map((i: any) => i.nid),
      };

      game.selectedUnit = unit;
      if (unit.position) game.cursor.setPos(unit.position[0], unit.position[1]);
      game.state.change('item_use');
      return { unitNid: unit.nid, before };
    });
    expect(setup).not.toBeNull();

    await stepFrames(page, 2);
    await stepFrames(page, 1, 'SELECT');
    await stepFrames(page, 2);
    await stepFrames(page, 1, 'SELECT');
    await stepFrames(page, 3);

    const promoted = await page.evaluate(({ unitNid }) => {
      const game = (window as any).__gameRef;
      const unit = game.units.get(unitNid);
      return { klass: unit.klass, level: unit.level };
    }, { unitNid: setup!.unitNid });
    expect(promoted.klass).toBe('Berserker');
    expect(promoted.level).toBe(1);

    // Undo the whole item-use action group (repeatedly, to cover every
    // sub-action: class swap, wexp gain, skill grant, item consumption).
    const restored = await page.evaluate(({ unitNid }) => {
      const game = (window as any).__gameRef;
      const log = game.actionLog;
      for (let i = 0; i < 20 && log.actionIndex > 0; i++) log.undo();
      const unit = game.units.get(unitNid);
      return {
        klass: unit.klass,
        level: unit.level,
        exp: unit.exp,
        stats: { ...unit.stats },
        maxStats: { ...unit.maxStats },
        wexp: { ...unit.wexp },
        skillNids: unit.skills.map((s: any) => s.nid),
        itemNids: unit.items.map((i: any) => i.nid),
      };
    }, { unitNid: setup!.unitNid });

    expect(restored).toEqual(setup!.before);
  });

  test('promotion survives a save/load round trip', async ({ page }) => {
    await page.goto('/?harness=true&level=0&clean=true&bundle=false');
    await waitForHarness(page);

    const setup = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { ItemObject } = await import('/src/objects/item.ts');
      const unit = game.units.get('Eirika');
      const klass = game.db.classes.get('Pirate');
      const itemPrefab = game.db.items.get('Master_Seal');
      if (!unit || !klass || !itemPrefab) return null;

      unit.klass = 'Pirate';
      unit.stats = { ...klass.bases };
      unit.maxStats = { ...klass.max_stats };
      unit.level = 10;
      unit.exp = 0;
      unit.wexp = {};
      unit.skills = [];
      unit.currentHp = klass.bases.HP;
      unit.finished = false;
      unit.hasMoved = false;
      unit.hasAttacked = false;
      unit.items = [];

      const item = new ItemObject(itemPrefab);
      item.owner = unit;
      unit.items.push(item);

      game.selectedUnit = unit;
      if (unit.position) game.cursor.setPos(unit.position[0], unit.position[1]);
      game.state.change('item_use');
      return { unitNid: unit.nid };
    });
    expect(setup).not.toBeNull();

    await stepFrames(page, 2);
    await stepFrames(page, 1, 'SELECT');
    await stepFrames(page, 2);
    await stepFrames(page, 1, 'SELECT');
    await stepFrames(page, 3);

    const beforeSave = await page.evaluate(({ unitNid }) => {
      const game = (window as any).__gameRef;
      const unit = game.units.get(unitNid);
      return {
        klass: unit.klass,
        level: unit.level,
        stats: { ...unit.stats },
        wexp: { ...unit.wexp },
        skillNids: unit.skills.map((s: any) => s.nid),
      };
    }, { unitNid: setup!.unitNid });
    expect(beforeSave.klass).toBe('Berserker');

    const roundTrip = await page.evaluate(async ({ unitNid }) => {
      const game = (window as any).__gameRef;
      const snapshot = (window as any).__harness.saveSnapshot();
      const ok = await (window as any).__harness.loadSnapshot(snapshot);
      const unit = game.units.get(unitNid);
      return {
        ok,
        klass: unit.klass,
        level: unit.level,
        stats: { ...unit.stats },
        wexp: { ...unit.wexp },
        skillNids: unit.skills.map((s: any) => s.nid),
      };
    }, { unitNid: setup!.unitNid });

    expect(roundTrip.ok).toBe(true);
    expect(roundTrip.klass).toBe(beforeSave.klass);
    expect(roundTrip.level).toBe(beforeSave.level);
    expect(roundTrip.stats).toEqual(beforeSave.stats);
    expect(roundTrip.wexp).toEqual(beforeSave.wexp);
    expect(roundTrip.skillNids).toEqual(beforeSave.skillNids);
  });

  test('force_class_change item reclasses once and reverses through the item action group', async ({ page }) => {
    await page.goto('/?harness=true&level=0&clean=true&bundle=false');
    await waitForHarness(page);

    const setup = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { ItemObject } = await import('/src/objects/item.ts');
      const unit = game.units.get('Eirika');
      const sourceClass = game.db.classes.get('Fighter');
      const targetKlass = game.db.classes.has('Cavalier')
        ? 'Cavalier'
        : [...game.db.classes.keys()].find((nid: string) => nid !== 'Fighter');
      if (!unit || !sourceClass || !targetKlass || !unit.position) return null;

      unit.klass = 'Fighter';
      unit.stats = { ...sourceClass.bases };
      unit.maxStats = { ...sourceClass.max_stats };
      unit.level = 10;
      unit.exp = 25;
      unit.wexp = {};
      unit.skills = [];
      unit.currentHp = sourceClass.bases.HP;
      unit.currentFatigue = 2;
      unit.resetTurnState();
      const item = new ItemObject({
        nid: '_ForceClassChangeItem',
        name: 'Reclass Seal',
        desc: '',
        icon_nid: '',
        icon_index: [0, 0],
        components: [
          ['force_class_change', targetKlass],
          ['target_ally', null],
          ['min_range', 0],
          ['max_range', 0],
          ['fatigue', 3],
          ['uses', 1],
        ],
      });
      item.owner = unit;
      unit.items = [item];
      game.selectedUnit = unit;
      game.cursor.setPos(unit.position[0], unit.position[1]);
      const beforeActionIndex = game.actionLog.actionIndex;
      game.state.change('item_use');
      return { targetKlass, beforeActionIndex };
    });
    expect(setup).not.toBeNull();

    await stepFrames(page, 2);
    expect((await getState(page)).currentStateName).toBe('item_use');
    await stepFrames(page, 1, 'SELECT');
    await stepFrames(page, 3);

    const result = await page.evaluate(({ targetKlass, beforeActionIndex }) => {
      const game = (window as any).__gameRef;
      const unit = game.units.get('Eirika');
      const actionLog = game.actionLog as any;
      const snapshot = () => ({
        klass: unit.klass,
        level: unit.level,
        exp: unit.exp,
        fatigue: unit.currentFatigue,
        itemPresent: unit.items.some((item: any) => item.nid === '_ForceClassChangeItem'),
        finished: unit.finished,
      });
      const changed = snapshot();
      const finalActionIndex = actionLog.actionIndex;
      const actionNames = actionLog.actions
        .slice(beforeActionIndex + 1, finalActionIndex + 1)
        .map((action: any) => action.constructor.name);
      while (actionLog.actionIndex > beforeActionIndex) actionLog.runActionBackward();
      const reversed = snapshot();
      while (actionLog.actionIndex < finalActionIndex) actionLog.runActionForward();
      return {
        targetKlass,
        state: game.state.getCurrentState()?.name,
        changed,
        reversed,
        redone: snapshot(),
        actionNames,
      };
    }, setup!);

    expect(result.changed).toMatchObject({
      klass: result.targetKlass,
      level: 10,
      exp: 25,
      fatigue: 5,
      itemPresent: false,
      finished: true,
    });
    expect(result.reversed).toMatchObject({
      klass: 'Fighter',
      level: 10,
      exp: 25,
      fatigue: 2,
      itemPresent: true,
      finished: false,
    });
    expect(result.redone).toEqual(result.changed);
    expect(result.actionNames).toContain('ClassChangeAction');
    expect(result.actionNames).toContain('ChangeFatigueAction');
    expect(result.state).toBe('free');
  });
});
