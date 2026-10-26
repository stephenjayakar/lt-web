import { expect, test, type Page } from '@playwright/test';

/**
 * Fork unit_funcs.get_level_cap (class max_level + game/unit modifiers), the
 * ExpState max-exp clamp, the fork's silent give_exp, and combat exp coming
 * only from item exp components (simple_combat.calculate_exp).
 */

async function boot(page: Page, eotf: boolean): Promise<void> {
  await page.goto(eotf
    ? '/?harness=true&project=eotf.ltproj&level=X&clean=true&bundle=false'
    : '/?harness=true&level=0&clean=true&bundle=false');
  await page.waitForFunction(() => (window as any).__harness?.ready === true, undefined, {
    timeout: 60_000,
  });
}

async function runEvent(page: Page, nid: string, source: string[]): Promise<void> {
  await page.evaluate(({ nid, source }) => {
    const g = (window as any).__gameRef;
    g.db.events.set(nid, {
      name: nid, nid, trigger: nid,
      level_nid: g.currentLevel?.nid ?? null,
      condition: 'True', only_once: false, priority: 0,
      _source: source,
    });
    g.eventManager.triggerSpecific(nid, { type: nid }, true);
    g.state.change('event');
  }, { nid, source });
  await page.evaluate(() => (window as any).__harness.stepFrames(30));
}

test.describe('fork level cap and exp', () => {
  test('EOtF caps at class max_level plus modifiers and clamps exp at the cap', async ({ page }) => {
    await boot(page, true);
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { getEffectiveLevelCap } = await import('/src/engine/leveling.ts');
      const { GainExpAction } = await import('/src/engine/action.ts');
      const unit = game.units.get('Player');
      const classCap = game.db.classes.get(unit.klass).max_level;
      game.gameVars.delete('_global_level_cap_bonus');
      unit.fields.delete('_level_cap_bonus');
      const caps: number[] = [getEffectiveLevelCap(unit, game)];
      game.gameVars.set('_global_level_cap_bonus', 5);
      caps.push(getEffectiveLevelCap(unit, game));
      unit.fields.set('_level_cap_bonus', 5);
      caps.push(getEffectiveLevelCap(unit, game));
      game.gameVars.delete('_global_level_cap_bonus');
      unit.fields.delete('_level_cap_bonus');

      // A unit one level below the cap: the gain is clamped so it lands on
      // the cap with 0 exp, then a further gain is refused.
      unit.level = classCap - 1;
      unit.exp = 50;
      const below = new GainExpAction(unit, 80, game.currentMode?.growths);
      game.actionLog.doAction(below);
      const atCap = { level: unit.level, exp: unit.exp, gained: below.getExpGained() };
      const capped = new GainExpAction(unit, 30, game.currentMode?.growths);
      game.actionLog.doAction(capped);
      const refused = { level: unit.level, exp: unit.exp, gained: capped.getExpGained() };
      game.actionLog.runActionBackward();
      game.actionLog.runActionBackward();
      const undone = { level: unit.level, exp: unit.exp };
      // Level 21+ exists in EOtF (Endless_Growth promotes at level > 20).
      unit.level = 20;
      unit.exp = 90;
      const past20 = new GainExpAction(unit, 20, game.currentMode?.growths);
      game.actionLog.doAction(past20);
      return {
        classCap, caps, atCap, refused, undone,
        past20: { level: unit.level, exp: unit.exp },
      };
    });
    expect(result.classCap).toBe(40);
    expect(result.caps).toEqual([40, 45, 50]);
    expect(result.atCap).toEqual({ level: 40, exp: 0, gained: 50 });
    expect(result.refused).toEqual({ level: 40, exp: 0, gained: 0 });
    expect(result.undone).toEqual({ level: 39, exp: 50 });
    expect(result.past20).toEqual({ level: 21, exp: 10 });
  });

  test('EOtF silent give_exp parks exp at 99 at the cap and levels past 20 below it', async ({ page }) => {
    await boot(page, true);
    await page.evaluate(() => {
      const game = (window as any).__gameRef;
      const unit = game.units.get('Player');
      game.gameVars.delete('_global_level_cap_bonus');
      unit.fields.delete('_level_cap_bonus');
      unit.level = 40;
      unit.exp = 90;
    });
    await runEvent(page, 'TestForkGiveExpAtCap', ['give_exp;Player;20;silent']);
    const atCap = await page.evaluate(() => {
      const unit = (window as any).__gameRef.units.get('Player');
      const snapshot = { level: unit.level, exp: unit.exp };
      unit.level = 20;
      unit.exp = 60;
      return snapshot;
    });
    await runEvent(page, 'TestForkGiveExpPast20', ['give_exp;Player;50;silent']);
    const past20 = await page.evaluate(() => {
      const unit = (window as any).__gameRef.units.get('Player');
      return { level: unit.level, exp: unit.exp };
    });
    expect(atCap).toEqual({ level: 40, exp: 99 });
    expect(past20).toEqual({ level: 21, exp: 10 });
  });

  test('combat exp comes only from item exp components, capped, with the unit growth method', async ({ page }) => {
    await boot(page, true);
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { ItemObject } = await import('/src/objects/item.ts');
      const { MapCombat } = await import('/src/combat/map-combat.ts');
      const attacker = game.units.get('Player');
      const defender = game.units.get('Keeper');
      const saved = {
        items: attacker.items, skills: attacker.skills, defSkills: defender.skills,
        hp: defender.currentHp, level: attacker.level, exp: attacker.exp,
      };
      attacker.skills = [];
      defender.skills = [];
      const makeWeapon = (nid: string, extra: [string, any][]) => new ItemObject({
        nid, name: nid, desc: '',
        components: [['weapon', null], ['damage', 1], ['hit', 100], ['uses', 20], ...extra],
      });
      const fight = (item: any) => {
        attacker.items = [item];
        defender.currentHp = defender.maxHp;
        const combat = new MapCombat(
          attacker, item, defender, null, game.db, 'classic', game.board, ['hit1', 'end'],
          undefined, game,
        );
        return combat.applyResults(game.actionLog);
      };
      attacker.level = 5;
      attacker.exp = 0;
      const plain = fight(makeWeapon('_ForkPlainWeapon', []));
      const plainAfter = { exp: attacker.exp, level: attacker.level, gained: plain.expGained };

      attacker.level = 5;
      attacker.exp = 95;
      const nativeRandom = Math.random;
      let randomCalls = 0;
      Math.random = () => { randomCalls++; return nativeRandom(); };
      let fixed: any;
      try {
        fixed = fight(makeWeapon('_ForkExpWeapon', [['exp', 10]]));
      } finally {
        Math.random = nativeRandom;
      }
      const fixedAfter = {
        exp: attacker.exp, level: attacker.level, gained: fixed.expGained,
        levelUps: fixed.levelUps.length,
      };

      attacker.level = 40;
      attacker.exp = 0;
      const capped = fight(makeWeapon('_ForkExpWeaponCap', [['exp', 10]]));
      const cappedAfter = { exp: attacker.exp, level: attacker.level, gained: capped.expGained };

      attacker.items = saved.items;
      attacker.skills = saved.skills;
      defender.skills = saved.defSkills;
      defender.currentHp = saved.hp;
      attacker.level = saved.level;
      attacker.exp = saved.exp;
      return {
        plainAfter, fixedAfter, cappedAfter, randomCalls,
        growths: game.currentMode?.growths,
      };
    });
    expect(result.plainAfter).toEqual({ exp: 0, level: 5, gained: 0 });
    expect(result.fixedAfter.level).toBe(6);
    expect(result.fixedAfter.levelUps).toBe(1);
    expect(result.fixedAfter.exp).toBe(95 + result.fixedAfter.gained - 100);
    expect(result.growths).toBe('Fixed');
    expect(result.randomCalls).toBe(0);
    expect(result.cappedAfter).toEqual({ exp: 0, level: 40, gained: 0 });
  });

  test('default project still caps at the class max_level', async ({ page }) => {
    await boot(page, false);
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { getEffectiveLevelCap } = await import('/src/engine/leveling.ts');
      const unit = game.units.get('Eirika');
      return {
        cap: getEffectiveLevelCap(unit, game),
        classCap: game.db.classes.get(unit.klass).max_level,
      };
    });
    expect(result.cap).toBe(result.classCap);
    await page.evaluate(() => {
      const unit = (window as any).__gameRef.units.get('Eirika');
      const cap = (window as any).__gameRef.db.classes.get(unit.klass).max_level;
      unit.level = cap;
      unit.exp = 90;
    });
    await runEvent(page, 'TestUpstreamGiveExpAtCap', ['give_exp;Eirika;20;silent']);
    const atCap = await page.evaluate(() => (window as any).__gameRef.units.get('Eirika').exp);
    // Upstream clamps the gain to 100 * (max_level - level) - exp = -90 at
    // the cap, so the exp drops to 0 instead of the fork's parked 99.
    expect(atCap).toBe(0);
  });
});
