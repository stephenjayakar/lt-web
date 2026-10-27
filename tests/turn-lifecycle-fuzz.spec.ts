import { expect, test, type Page } from '@playwright/test';

/**
 * Turn-lifecycle behaviours found by the EOtF differential fuzz
 * (tools/oracle/fuzz.mjs) and checked against upstream lt-maker and the
 * EOtF engine fork, which agree on all of them:
 *
 * - unit.add_skill at max stacks (1 without `stack`) displaces the oldest
 *   SourceType.DEFAULT instance, so re-gaining a status refreshes it; a
 *   DEFAULT skill never displaces a class/personal one.
 * - StatusUpkeepState defers each unit's hook actions (ChangeHP, timed
 *   RemoveSkill...) until every hook ran.
 * - kill_unit leaves current HP alone.
 */

test.describe.configure({ mode: 'parallel' });

async function boot(page: Page): Promise<void> {
  await page.goto('/?harness=true&level=0&clean=true&bundle=false');
  await page.waitForFunction(() => (window as any).__harness?.ready === true, undefined, { timeout: 60_000 });
  await page.evaluate(() => (window as any).__harness.settle(600));
}

/** Register throwaway skill prefabs in the page's database. */
async function definePrefabs(page: Page, prefabs: Array<{ nid: string; components: [string, unknown][] }>): Promise<void> {
  await page.evaluate((list) => {
    const g = (window as any).__gameRef;
    for (const { nid, components } of list) {
      g.db.skills.set(nid, { nid, name: nid, desc: '', icon_nid: null, icon_index: [0, 0], components });
    }
  }, prefabs);
}

test('an upkeep skill gain refreshes the status it re-grants', async ({ page }) => {
  await boot(page);
  await definePrefabs(page, [
    { nid: '_FzStatus', components: [['time', 2]] },
    { nid: '_FzGainer', components: [['upkeep_skill_gain', '_FzStatus']] },
  ]);
  const result = await page.evaluate(async () => {
    const g = (window as any).__gameRef;
    const { SkillObject } = await import('/src/objects/skill.ts');
    const { AddSkillAction, SetSkillDataAction } = await import('/src/engine/action.ts');
    const { applySkillTurnHooks } = await import('/src/engine/skill-turn-lifecycle.ts');
    const unit = g.units.get('Eirika');
    g.actionLog.doAction(new AddSkillAction(unit, new SkillObject(g.db.skills.get('_FzGainer'))));
    const old = new SkillObject(g.db.skills.get('_FzStatus'));
    g.actionLog.doAction(new AddSkillAction(unit, old));
    g.actionLog.doAction(new SetSkillDataAction(old, 'turns', 1));
    const start = g.actionLog.getLength();
    applySkillTurnHooks(g, [unit], 'upkeep');
    const statuses = unit.skills.filter((s: any) => s.nid === '_FzStatus');
    const after = { count: statuses.length, turns: statuses[0]?.data.get('turns'), same: statuses[0] === old };
    while (g.actionLog.getLength() > start) g.actionLog.undo();
    const undone = unit.skills.filter((s: any) => s.nid === '_FzStatus');
    return { after, undone: { count: undone.length, same: undone[0] === old, turns: old.data.get('turns') } };
  });
  expect(result.after).toEqual({ count: 1, turns: 2, same: false });
  expect(result.undone).toEqual({ count: 1, same: true, turns: 1 });
});

test('a granted status does not displace a learned skill with the same nid', async ({ page }) => {
  await boot(page);
  const result = await page.evaluate(async () => {
    const g = (window as any).__gameRef;
    const { SkillObject } = await import('/src/objects/skill.ts');
    const { AddSkillAction } = await import('/src/engine/action.ts');
    const unit = g.units.get('Seth');
    const klass = g.db.classes.get(unit.klass);
    const learnedNid = (klass?.learned_skills ?? []).map((entry: any) => entry[1])
      .find((nid: string) => g.db.skills.get(nid));
    if (!learnedNid) return null;
    // The class grant (Python SourceType.KLASS) if the unit lacks it here.
    let learned = unit.skills.find((s: any) => s.nid === learnedNid);
    if (!learned) {
      learned = new SkillObject(g.db.skills.get(learnedNid));
      unit.skills.push(learned);
    }
    const action = new AddSkillAction(unit, new SkillObject(g.db.skills.get(learnedNid)));
    action.execute();
    const after = unit.skills.filter((s: any) => s.nid === learnedNid);
    return { count: after.length, kept: after[0] === learned };
  });
  expect(result).toEqual({ count: 1, kept: true });
});

test('upkeep hooks read HP from before the deferred changes', async ({ page }) => {
  await boot(page);
  await definePrefabs(page, [
    { nid: '_FzDamage', components: [['upkeep_damage', 5]] },
    { nid: '_FzRegen', components: [['regeneration', 0.5]] },
  ]);
  const result = await page.evaluate(async () => {
    const g = (window as any).__gameRef;
    const { SkillObject } = await import('/src/objects/skill.ts');
    const { AddSkillAction } = await import('/src/engine/action.ts');
    const { applySkillTurnHooks } = await import('/src/engine/skill-turn-lifecycle.ts');
    const unit = g.units.get('Eirika');
    for (const nid of ['_FzDamage', '_FzRegen']) {
      g.actionLog.doAction(new AddSkillAction(unit, new SkillObject(g.db.skills.get(nid))));
    }
    unit.currentHp = unit.maxHp;
    applySkillTurnHooks(g, [unit], 'upkeep');
    return { hp: unit.currentHp, max: unit.maxHp };
  });
  // At full HP the regeneration check fails, so only the damage lands.
  expect(result.hp).toBe(result.max - 5);
});

test('kill_unit leaves the unit at its current HP', async ({ page }) => {
  await boot(page);
  const before = await page.evaluate(() => {
    const g = (window as any).__gameRef;
    g.units.get('Seth').currentHp = 9;
    g.db.events.set('_FzKill', {
      name: '_FzKill', nid: '_FzKill', trigger: '_FzKill', level_nid: g.currentLevel?.nid ?? null,
      condition: 'True', only_once: false, priority: 0, _source: ['kill_unit;Seth;immediate'],
    });
    g.eventManager.triggerSpecific('_FzKill', { type: '_FzKill' }, true);
    g.state.change('event');
    return 9;
  });
  await page.evaluate(() => (window as any).__harness.stepFrames(30, null));
  const after = await page.evaluate(() => {
    const seth = (window as any).__gameRef.units.get('Seth');
    return { dead: seth.dead, hp: seth.currentHp, position: seth.position };
  });
  expect(after).toEqual({ dead: true, hp: before, position: null });
});

test('EvalUpkeepDamage draws the combat stream once per damage tick', async ({ page }) => {
  await boot(page);
  await definePrefabs(page, [
    { nid: '_FzEvalDamage', components: [['eval_upkeep_damage', '3']] },
    { nid: '_FzEvalHeal', components: [['eval_upkeep_damage', '-2']] },
  ]);
  const result = await page.evaluate(async () => {
    const g = (window as any).__gameRef;
    const { SkillObject } = await import('/src/objects/skill.ts');
    const { AddSkillAction } = await import('/src/engine/action.ts');
    const { applySkillTurnHooks } = await import('/src/engine/skill-turn-lifecycle.ts');
    const { Lcg, getCombatRandomState, setCombatRandomState } = await import('/src/engine/static-random.ts');
    const run = (nid: string) => {
      const unit = g.units.get(nid === '_FzEvalDamage' ? 'Eirika' : 'Seth');
      g.actionLog.doAction(new AddSkillAction(unit, new SkillObject(g.db.skills.get(nid))));
      unit.currentHp = 10;
      g.gameVars.set('_random_seed', 0);
      setCombatRandomState(g, 0);
      applySkillTurnHooks(g, [unit], 'upkeep');
      return { hp: unit.currentHp, state: getCombatRandomState(g) };
    };
    const lcg = new Lcg(0);
    lcg.randint(1, 5);
    return { damage: run('_FzEvalDamage'), heal: run('_FzEvalHeal'), oneDraw: lcg.getState() };
  });
  expect(result.damage).toEqual({ hp: 7, state: result.oneDraw });
  // A negative amount heals, with the heal animation and no draw.
  expect(result.heal).toEqual({ hp: 12, state: 0 });
});

test('with heal/damage playback, upkeep events run before the pending HP changes', async ({ page }) => {
  await boot(page);
  await definePrefabs(page, [
    { nid: '_FzRegenEvent', components: [['upkeep_event', '_FzSetHp'], ['regeneration', 0.25]] },
  ]);
  const result = await page.evaluate(async () => {
    const g = (window as any).__gameRef;
    const { SkillObject } = await import('/src/objects/skill.ts');
    const { AddSkillAction } = await import('/src/engine/action.ts');
    g.db.events.set('_FzSetHp', {
      name: '_FzSetHp', nid: '_FzSetHp', trigger: null, level_nid: null,
      condition: 'True', only_once: false, priority: 0, _source: ['set_current_hp;Eirika;10'],
    });
    const unit = g.units.get('Eirika');
    g.actionLog.doAction(new AddSkillAction(unit, new SkillObject(g.db.skills.get('_FzRegenEvent'))));
    unit.currentHp = 5;
    g.turnCount = 2;
    g.state.change('status_upkeep');
    (window as any).__harness.stepFrames(120, null);
    return { hp: unit.currentHp, expected: Math.min(unit.maxHp, 10 + Math.trunc(unit.maxHp * 0.25)) };
  });
  // Python: the event sets 10, then the regeneration computed at 5 HP lands.
  expect(result.hp).toBe(result.expected);
});

test('a timed item-sourced skill is not removed by its time hook and keeps counting', async ({ page }) => {
  await boot(page);
  await definePrefabs(page, [{ nid: '_FzTimed', components: [['time', 1]] }]);
  const result = await page.evaluate(async () => {
    const g = (window as any).__gameRef;
    const { SkillObject } = await import('/src/objects/skill.ts');
    const { applySkillTurnHooks } = await import('/src/engine/skill-turn-lifecycle.ts');
    const unit = g.units.get('Eirika');
    const sourced = new SkillObject(g.db.skills.get('_FzTimed'));
    sourced.data.set('itemSourceType', 'item');
    unit.skills.push(sourced);
    const plain = new SkillObject(g.db.skills.get('_FzTimed'));
    g.units.get('Seth').skills.push(plain);
    applySkillTurnHooks(g, [unit, g.units.get('Seth')], 'upkeep');
    return {
      sourced: { kept: unit.skills.includes(sourced), turns: sourced.data.get('turns') },
      plainKept: g.units.get('Seth').skills.includes(plain),
    };
  });
  expect(result).toEqual({ sourced: { kept: true, turns: 0 }, plainKept: false });
});

test('giving a unit an aura skill propagates the aura at once', async ({ page }) => {
  await boot(page);
  await definePrefabs(page, [
    { nid: '_FzAuraChild', components: [] },
    { nid: '_FzAura', components: [['aura', '_FzAuraChild'], ['aura_range', 99], ['aura_target', 'ally']] },
  ]);
  const result = await page.evaluate(async () => {
    const g = (window as any).__gameRef;
    const { SkillObject } = await import('/src/objects/skill.ts');
    const { AddSkillAction } = await import('/src/engine/action.ts');
    const seth = g.units.get('Seth');
    const action = new AddSkillAction(g.units.get('Eirika'), new SkillObject(g.db.skills.get('_FzAura')));
    action.execute();
    const given = seth.skills.some((s: any) => s.nid === '_FzAuraChild');
    action.reverse();
    return { given, released: !seth.skills.some((s: any) => s.nid === '_FzAuraChild') };
  });
  expect(result).toEqual({ given: true, released: true });
});

test('upkeep damage runs after_take_strike over the pending actions', async ({ page }) => {
  await boot(page);
  await definePrefabs(page, [
    { nid: '_FzGained', components: [['stack', 9]] },
    { nid: '_FzOnHurt', components: [['gain_skill_after_take_damage', '_FzGained']] },
    { nid: '_FzMiracle', components: [['TrueMiracle', null]] },
    { nid: '_FzBurn', components: [['upkeep_damage', 50]] },
  ]);
  const result = await page.evaluate(async () => {
    const g = (window as any).__gameRef;
    const { SkillObject } = await import('/src/objects/skill.ts');
    const { AddSkillAction } = await import('/src/engine/action.ts');
    const { applySkillTurnHooks } = await import('/src/engine/skill-turn-lifecycle.ts');
    const unit = g.units.get('Eirika');
    for (const nid of ['_FzOnHurt', '_FzMiracle', '_FzBurn']) {
      g.actionLog.doAction(new AddSkillAction(unit, new SkillObject(g.db.skills.get(nid))));
    }
    unit.currentHp = 10;
    applySkillTurnHooks(g, [unit], 'upkeep');
    return { hp: unit.currentHp, dead: unit.isDead(), gained: unit.skills.filter((s: any) => s.nid === '_FzGained').length };
  });
  // TrueMiracle leaves 1 HP from the lethal tick; the hit grants one stack.
  expect(result).toEqual({ hp: 1, dead: false, gained: 1 });
});


test('negative statuses are inactive while the unit has immune_status', async ({ page }) => {
  await boot(page);
  await definePrefabs(page, [
    { nid: '_FzPoison', components: [['negative', null], ['upkeep_damage', 4], ['time', 3]] },
    { nid: '_FzWard', components: [['immune_status', null], ['lost_on_upkeep', null]] },
  ]);
  const result = await page.evaluate(async () => {
    const g = (window as any).__gameRef;
    const { SkillObject } = await import('/src/objects/skill.ts');
    const { applySkillTurnHooks } = await import('/src/engine/skill-turn-lifecycle.ts');
    const unit = g.units.get('Eirika');
    // Pushed directly: immune_status would purge a status added after it.
    const poison = new SkillObject(g.db.skills.get('_FzPoison'));
    unit.skills.push(poison, new SkillObject(g.db.skills.get('_FzWard')));
    unit.currentHp = 12;
    applySkillTurnHooks(g, [unit], 'upkeep');
    const first = { hp: unit.currentHp, ward: unit.skills.some((s: any) => s.nid === '_FzWard'), turns: poison.data.get('turns') };
    applySkillTurnHooks(g, [unit], 'upkeep');
    return { first, second: { hp: unit.currentHp, turns: poison.data.get('turns') } };
  });
  // The ward blocks the first tick (time still counts) and expires with it.
  expect(result.first).toEqual({ hp: 12, ward: false, turns: 2 });
  expect(result.second).toEqual({ hp: 8, turns: 1 });
});
