import { expect, test, type Page } from '@playwright/test';

/**
 * Turn-flow behaviours the differential oracle (tools/oracle) found
 * diverging from the Python engine, each checked against upstream lt-maker
 * and EOtF's engine fork:
 *
 * - action.Wait sets has_moved/has_traded/has_attacked with finished.
 * - ExpState level-ups pass increase_current_stats only for bonus_exp
 *   (always False on the fork).
 * - Item uses run CombatPhaseSolver.process: generate_roll() even without a
 *   hit value, a crit roll only with crits on and a crit value.
 * - GBAPoison.on_upkeep draws get_randint(1, value) from the combat stream.
 * - AddSkill/RemoveSkill recalc_unit autoequips (cannot_use_items).
 * - unit.movement_left reads live movement until the unit has moved.
 * - WaitState waits dead units too; a dying player attacker goes to wait.
 * - Event moves re-derive terrain statuses when the unit arrives.
 */

test.describe.configure({ mode: 'parallel' });

async function boot(page: Page): Promise<void> {
  await page.goto('/?harness=true&level=0&clean=true&bundle=false');
  await page.waitForFunction(() => (window as any).__harness?.ready === true, undefined, { timeout: 60_000 });
  await page.evaluate(() => (window as any).__harness.settle(600));
}

async function step(page: Page, frames: number): Promise<void> {
  await page.evaluate((n) => (window as any).__harness.stepFrames(n, null), frames);
}

test('Wait marks the unit moved, traded and attacked, and rewinds all of it', async ({ page }) => {
  await boot(page);
  const result = await page.evaluate(async () => {
    const g = (window as any).__gameRef;
    const { WaitAction } = await import('/src/engine/action.ts');
    const unit = g.units.get('Eirika');
    unit.resetTurnState();
    unit.hasMoved = true;
    const flags = () => ({
      finished: unit.finished, hasAttacked: unit.hasAttacked,
      hasTraded: unit.hasTraded, hasMoved: unit.hasMoved,
    });
    const action = new WaitAction(unit);
    action.execute();
    const after = flags();
    action.reverse();
    return { after, reversed: flags() };
  });
  expect(result.after).toEqual({ finished: true, hasAttacked: true, hasTraded: true, hasMoved: true });
  expect(result.reversed).toEqual({ finished: false, hasAttacked: false, hasTraded: false, hasMoved: true });
});

test('a level-up keeps current HP except on the bonus-exp screen (upstream only)', async ({ page }) => {
  await boot(page);
  const result = await page.evaluate(async () => {
    const g = (window as any).__gameRef;
    const { GainExpAction } = await import('/src/engine/action.ts');
    const { isForkEngine, setForkEngine } = await import('/src/engine/engine-flavor.ts');
    const wasFork = isForkEngine();
    const unit = g.units.get('Eirika');
    unit.growths.HP = 100;
    unit.exp = 0;
    unit.currentHp = 5;
    const run = (bonus: boolean, fork: boolean) => {
      setForkEngine(fork);
      const maxBefore = unit.maxHp;
      const action = new GainExpAction(unit, 100, 'Fixed', bonus);
      action.execute();
      const out = { hp: unit.currentHp, gained: unit.maxHp - maxBefore };
      action.reverse();
      return out;
    };
    const combat = run(false, false);
    const bonus = run(true, false);
    const forkBonus = run(true, true);
    setForkEngine(wasFork);
    return { combat, bonus, forkBonus, hpAfter: unit.currentHp };
  });
  expect(result.combat.gained).toBeGreaterThan(0);
  expect(result.combat.hp).toBe(5);
  expect(result.bonus.hp).toBe(5 + result.bonus.gained);
  expect(result.forkBonus.hp).toBe(5);
  expect(result.hpAfter).toBe(5);
});

test('a Vulnerary use draws the solver hit roll, recorded for the turnwheel', async ({ page }) => {
  await boot(page);
  const result = await page.evaluate(async () => {
    const g = (window as any).__gameRef;
    const { ItemObject } = await import('/src/objects/item.ts');
    const { applyCoreTargetedItem } = await import('/src/engine/states/game-states.ts');
    const { drawItemUseRolls } = await import('/src/combat/item-use-rolls.ts');
    const { Lcg, getCombatRandomState, setCombatRandomState } = await import('/src/engine/static-random.ts');
    const unit = g.units.get('Eirika');
    const vulnerary = new ItemObject(g.db.items.get('Vulnerary'));
    unit.items.push(vulnerary);
    vulnerary.owner = unit;
    unit.currentHp = 3;
    g.gameVars.set('_random_seed', 0);
    setCombatRandomState(g, 0);
    const draws = { classic: 1, fates_hit: 1, true_hit: 2, true_hit_plus: 3, grandmaster: 0 } as Record<string, number>;
    const lcg = new Lcg(0);
    for (let i = 0; i < draws[g.rngMode]; i++) lcg.randint(0, 99);

    const start = g.actionLog.getLength();
    const applied = applyCoreTargetedItem(unit, vulnerary, [unit.position[0], unit.position[1]]);
    const used = { state: getCombatRandomState(g), hp: unit.currentHp };
    while (g.actionLog.getLength() > start) g.actionLog.undo();
    const undone = { state: getCombatRandomState(g), hp: unit.currentHp };

    // An empty target tile goes through simple_process: no draw.
    let empty: number[] | null = null;
    for (let x = 0; x < g.board.width && !empty; x++) {
      for (let y = 0; y < g.board.height; y++) {
        if (!g.board.getUnit(x, y)) { empty = [x, y]; break; }
      }
    }
    drawItemUseRolls(g, unit, [{ item: vulnerary, positions: [empty] }]);
    return { applied, used, undone, expected: lcg.getState(), afterEmpty: getCombatRandomState(g) };
  });
  expect(result.applied).toBe(true);
  expect(result.used).toEqual({ state: result.expected, hp: 13 });
  expect(result.undone).toEqual({ state: 0, hp: 3 });
  expect(result.afterEmpty).toBe(0);
});

test('solver strikes always draw the hit roll and draw a crit roll only for a crit value', async ({ page }) => {
  await boot(page);
  const result = await page.evaluate(async () => {
    const g = (window as any).__gameRef;
    const { UnitObject } = await import('/src/objects/unit.ts');
    const { ItemObject } = await import('/src/objects/item.ts');
    const { CombatPhaseSolver } = await import('/src/combat/combat-solver.ts');
    const { getCombatRandom, setCombatRandomState } = await import('/src/engine/static-random.ts');
    const template = g.units.get('Eirika');
    const klass = g.db.classes.get(template.klass);
    const makeUnit = (nid: string) => {
      const unit = new UnitObject({
        nid, name: nid, desc: '', variant: null, level: 1, klass: template.klass,
        tags: [], bases: { HP: 30, STR: 0, MAG: 0, SKL: 0, SPD: 5, LCK: 0, DEF: 0, RES: 0, CON: 5, MOV: 5 },
        growths: {}, stat_cap_modifiers: {}, starting_items: [], learned_skills: [],
        unit_notes: [], fields: [], wexp_gain: {}, portrait_nid: '', affinity: '',
      } as any, klass);
      unit.currentHp = 30;
      return unit;
    };
    const count = (components: [string, unknown][]) => {
      const item = new ItemObject({
        nid: '_RollItem', name: '_RollItem', desc: '', icon_nid: '', icon_index: [0, 0], components,
      });
      g.gameVars.set('_random_seed', 3);
      setCombatRandomState(g, 3);
      let draws = 0;
      const solver = new CombatPhaseSolver(() => { draws += 1; return getCombatRandom(g); }, g);
      const attacker = makeUnit('_RollA');
      const defender = makeUnit('_RollD');
      attacker.items.push(item);
      solver.resolve(attacker, item, defender, null, g.db, 'true_hit', null, null);
      return draws;
    };
    return {
      noHitNoCrit: count([['weapon', null], ['damage', 0], ['uses', 9]]),
      hitNoCrit: count([['weapon', null], ['damage', 0], ['hit', 100], ['uses', 9]]),
      hitCrit: count([['weapon', null], ['damage', 0], ['hit', 100], ['crit', 0], ['uses', 9]]),
    };
  });
  expect(result).toEqual({ noHitNoCrit: 2, hitNoCrit: 2, hitCrit: 3 });
});

test('Poisoned (gba_poison) loses 1..value HP from the combat stream at upkeep', async ({ page }) => {
  await boot(page);
  const result = await page.evaluate(async () => {
    const g = (window as any).__gameRef;
    const { SkillObject } = await import('/src/objects/skill.ts');
    const { AddSkillAction } = await import('/src/engine/action.ts');
    const { applySkillTurnHooks } = await import('/src/engine/skill-turn-lifecycle.ts');
    const { Lcg, getCombatRandomState, setCombatRandomState } = await import('/src/engine/static-random.ts');
    const unit = g.units.get('Eirika');
    unit.currentHp = 15;
    g.actionLog.doAction(new AddSkillAction(unit, new SkillObject(g.db.skills.get('Poisoned'))));
    g.gameVars.set('_random_seed', 0);
    setCombatRandomState(g, 0);
    const lcg = new Lcg(0);
    const loss = lcg.randint(1, 5);
    const start = g.actionLog.getLength();
    applySkillTurnHooks(g, [unit], 'upkeep');
    const after = { hp: unit.currentHp, state: getCombatRandomState(g) };
    while (g.actionLog.getLength() > start) g.actionLog.undo();
    return { after, expected: { hp: 15 - loss, state: lcg.getState() }, undone: { hp: unit.currentHp, state: getCombatRandomState(g) } };
  });
  expect(result.after).toEqual(result.expected);
  expect(result.undone).toEqual({ hp: 15, state: 0 });
});

test('Stunned unequips and pins movement; losing it re-equips and restores movement', async ({ page }) => {
  await boot(page);
  const result = await page.evaluate(async () => {
    const g = (window as any).__gameRef;
    const { SkillObject } = await import('/src/objects/skill.ts');
    const { AddSkillAction, RemoveSkillAction } = await import('/src/engine/action.ts');
    const unit = g.units.get('Eirika');
    unit.autoequip();
    const weapon = unit.equippedWeapon?.nid ?? null;
    const stun = new SkillObject(g.db.skills.get('Stunned'));
    const add = new AddSkillAction(unit, stun);
    add.execute();
    unit.resetTurnState();
    const stunned = { weapon: unit.equippedWeapon?.nid ?? null, move: unit.movementLeft };
    const remove = new RemoveSkillAction(unit, stun);
    remove.execute();
    const recovered = { weapon: unit.equippedWeapon?.nid ?? null, move: unit.movementLeft, mov: unit.getMovement() };
    remove.reverse();
    const rewoundRemove = unit.equippedWeapon?.nid ?? null;
    add.reverse();
    return { weapon, stunned, recovered, rewoundRemove, rewoundAdd: unit.equippedWeapon?.nid ?? null };
  });
  expect(result.weapon).not.toBeNull();
  expect(result.stunned.weapon).toBeNull();
  expect(result.stunned.move).toBeLessThanOrEqual(0);
  expect(result.recovered.weapon).toBe(result.weapon);
  expect(result.recovered.move).toBe(result.recovered.mov);
  expect(result.recovered.move).toBeGreaterThan(0);
  expect(result.rewoundRemove).toBeNull();
  expect(result.rewoundAdd).toBe(result.weapon);
});

test('WaitState waits a unit that attacked and died', async ({ page }) => {
  await boot(page);
  const result = await page.evaluate(async () => {
    const g = (window as any).__gameRef;
    const { DeathAction } = await import('/src/engine/action.ts');
    const unit = g.units.get('Seth');
    unit.resetTurnState();
    unit.hasAttacked = true;
    g.actionLog.doAction(new DeathAction(unit, g.board, g.initiative ?? null));
    g.state.change('wait');
    (window as any).__harness.stepFrames(3, null);
    return { dead: unit.isDead(), finished: unit.finished, hasTraded: unit.hasTraded, hasMoved: unit.hasMoved };
  });
  expect(result).toEqual({ dead: true, finished: true, hasTraded: true, hasMoved: true });
});

test('move_group units keep the terrain status of the tile they arrive on', async ({ page }) => {
  await boot(page);
  const targets = await page.evaluate(() => {
    const g = (window as any).__gameRef;
    const picks: Record<string, number[]> = {};
    const taken = new Set<string>();
    for (const nid of ['Eirika', 'Seth']) {
      const unit = g.units.get(nid);
      for (let i = 0; i < g.board.width * g.board.height && !picks[nid]; i++) {
        const x = i % g.board.width;
        const y = Math.floor(i / g.board.width);
        const status = g.db.terrain.get(g.board.getTerrain(x, y))?.status;
        // Eirika walks onto the forest; Seth's later warp (any tile) is the
        // board change that used to drop her status mid-walk.
        if ((nid === 'Eirika') !== (status === 'Forest') || g.board.getUnit(x, y) || taken.has(`${x},${y}`)) continue;
        const path = g.pathSystem.getPath(unit, x, y, g.board);
        if (!path || path.length < 2) continue;
        picks[nid] = [x, y];
        taken.add(`${x},${y}`);
      }
    }
    if (!picks.Eirika || !picks.Seth) return null;
    g.currentLevel.unit_groups.push({ nid: '_TerrainGroup', units: ['Eirika', 'Seth'], positions: picks });
    g.db.events.set('_TerrainMove', {
      name: '_TerrainMove', nid: '_TerrainMove', trigger: '_TerrainMove', level_nid: g.currentLevel?.nid ?? null,
      condition: 'True', only_once: false, priority: 0, _source: ['move_group;_TerrainGroup'],
    });
    g.eventManager.triggerSpecific('_TerrainMove', { type: '_TerrainMove' }, true);
    g.state.change('event');
    return picks;
  });
  expect(targets).not.toBeNull();
  await step(page, 240);
  const result = await page.evaluate(() => {
    const g = (window as any).__gameRef;
    return ['Eirika', 'Seth'].map((nid) => {
      const unit = g.units.get(nid);
      return { position: unit.position, forest: unit.skills.some((s: any) => s.nid === 'Forest') };
    });
  });
  expect(result).toEqual([
    { position: targets!.Eirika, forest: true },
    { position: targets!.Seth, forest: false },
  ]);
});
