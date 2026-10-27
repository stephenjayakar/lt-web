import { expect, test, type Page } from '@playwright/test';

/**
 * EOtF's engine fork ends combat in one clean_up (v1.90 simple_combat.py):
 * CombatEnd, item gain, wexp/exp and records, then end_combat hooks,
 * UnitDeath and broken items. Every trigger pushes an EventState, newest on
 * top, so they run broken -> unit_death -> dying fade -> end_combat hook
 * events -> exp screen -> combat_end. There is no combat_death trigger.
 */

async function waitForHarness(page: Page): Promise<void> {
  await page.waitForFunction(() => (window as any).__harness?.ready === true, undefined, { timeout: 60_000 });
}

type Entry = {
  label: string; combat: boolean; phase: string | null; onMap: boolean;
  /** The defender's Python `dead` / `is_dying` and the queued event nids. */
  dead: boolean; dying: boolean; queued: string[];
};

async function runHookCombat(page: Page, fork: boolean, extras = false, loseGame = false): Promise<Entry[]> {
  await page.goto('/?harness=true&level=0&clean=true&bundle=false');
  await waitForHarness(page);
  const ready = await page.evaluate(async ({ fork, extras, loseGame }) => {
    const game = (window as any).__gameRef;
    const { setForkEngine } = await import('/src/engine/engine-flavor.ts');
    setForkEngine(fork);
    const { UnitObject } = await import('/src/objects/unit.ts');
    const { ItemObject } = await import('/src/objects/item.ts');
    const { SkillObject } = await import('/src/objects/skill.ts');
    const template = game.units.get('Eirika');
    const klass = template ? game.db.classes.get(template.klass) : null;
    if (!template || !klass) return false;
    let origin: [number, number] | null = null;
    for (let y = 1; y < game.board.height - 1 && !origin; y++) {
      for (let x = 1; x < game.board.width - 1; x++) {
        if (!game.board.getUnit(x, y) && !game.board.getUnit(x + 1, y)) {
          origin = [x, y];
          break;
        }
      }
    }
    if (!origin) return false;
    const makeUnit = (nid: string, team: string, hp: number) => {
      const unit = new UnitObject({
        nid, name: nid, desc: '', variant: null, level: 1, klass: template.klass,
        tags: [], bases: { HP: 30, STR: 0, MAG: 0, SKL: 5, SPD: 5, LCK: 0, DEF: 0, RES: 0, CON: 5, MOV: 5 },
        growths: {}, stat_cap_modifiers: {}, starting_items: [], learned_skills: [],
        unit_notes: [], fields: [], wexp_gain: {}, portrait_nid: '', affinity: '',
      } as any, klass);
      unit.team = team;
      unit.currentHp = hp;
      return unit;
    };
    const define = (nid: string, trigger: string, label: string, condition = 'True') => {
      game.db.events.set(nid, {
        nid, name: nid, trigger, level_nid: '0', condition, only_once: false, priority: 0,
        _source: [`level_var;_fork_order;{_fork_order}>${label}`],
      });
    };
    define('_ForkOnHit', '_ForkOnHit', 'on_hit');
    define('_ForkItemAfter', '_ForkItemAfter', 'item_after_combat');
    define('_ForkSkillAfter', '_ForkSkillAfter', 'skill_after_combat');
    define('_ForkCombatDeath', 'combat_death', 'combat_death', "unit1.nid == '_ForkDefender'");
    define('_ForkUnitDeath', 'unit_death', 'unit_death', "unit1.nid == '_ForkDefender'");
    define('_ForkCombatEnd', 'combat_end', 'combat_end', "unit2.nid == '_ForkDefender'");
    // What UnitDeath's events see: Python sets `dead` only in Die.
    game.db.events.get('_ForkUnitDeath')._source.push(
      "level_var;_fork_dead;[unit1.dead, unit1.is_dying, game.check_dead('_ForkDefender')]");
    if (loseGame) game.db.events.get('_ForkUnitDeath')._source.push('lose_game');
    // CombatEnd's playback: brush objects with attributes (p.nid, ...).
    game.db.events.get('_ForkCombatEnd')._source.push(
      'level_var;_fork_playback;[(p.nid, p.attacker.nid, p.defender.nid, p.main_attacker.nid) for p in playback]');
    if (extras) {
      define('_ForkUnitWait', 'unit_wait', 'unit_wait', "unit1.nid == '_ForkAttacker' and not actively_chosen");
    }
    game.db.skills.set('_ForkSkill', {
      nid: '_ForkSkill', name: '_ForkSkill', desc: '', icon_nid: '', icon_index: [0, 0],
      components: [['event_after_combat', '_ForkSkillAfter']],
    });
    game.levelVars.set('_fork_order', '');
    const attacker = makeUnit('_ForkAttacker', 'player', 30);
    const defender = makeUnit('_ForkDefender', 'enemy', 1);
    attacker.skills.push(new SkillObject(game.db.skills.get('_ForkSkill')));
    const item = new ItemObject({
      nid: '_ForkSpell', name: '_ForkSpell', desc: '', icon_nid: '', icon_index: [0, 0],
      components: [
        ['spell', null], ['target_enemy', null], ['damage', 99], ['hit', 100],
        ['uses', extras ? 1 : 2], ['min_range', 1], ['max_range', 2], ['exp', 30],
        ['event_on_hit', '_ForkOnHit'], ['event_after_combat_even_miss', '_ForkItemAfter'],
      ],
    });
    item.owner = attacker;
    attacker.items.push(item);
    game.board.setUnit(origin[0], origin[1], attacker);
    game.board.setUnit(origin[0] + 1, origin[1], defender);
    game.units.set(attacker.nid, attacker);
    game.units.set(defender.nid, defender);
    game.selectedUnit = attacker;
    game.combatTarget = defender;
    game.combatScript = ['hit1'];
    game.memory.set('combat_item', item);
    game.memory.set('combat_force_no_animation', true);
    (window as any).__forkOrderTest = { attacker, defender };
    game.state.change('combat');
    return true;
  }, { fork, extras, loseGame });
  expect(ready).toBe(true);

  return page.evaluate(async ({ extras, loseGame }) => {
    const game = (window as any).__gameRef;
    const harness = (window as any).__harness;
    const { attacker, defender } = (window as any).__forkOrderTest;
    const seen: Entry[] = [];
    const probe = () => ({
      dead: !!defender.dead,
      dying: !!defender.isDying,
      queued: (game.eventManager.eventQueue as any[]).map((event) => event.nid),
    });
    const combatState = (game.state as any).allStates.get('combat');
    let last = '';
    let sawExp = false;
    let sawBroken = false;
    for (let frame = 0; frame < 4000; frame++) {
      harness.stepFrames(1, null);
      if (frame % 20 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
      const names = game.state.getStackNames();
      const inCombat = names.includes('combat');
      if (!sawExp && inCombat && game.state.getCurrentState()?.name === 'combat' &&
          String(combatState.phase).startsWith('exp')) {
        sawExp = true;
        seen.push({ label: 'exp', combat: true, phase: combatState.phase, onMap: !!defender.position, ...probe() });
      }
      if (!sawBroken && inCombat && combatState.phase === 'broken_item') {
        sawBroken = true;
        seen.push({
          label: `broken:${combatState.brokenBanner?.text}`, combat: true, phase: 'broken_item',
          onMap: !!defender.position, ...probe(),
        });
      }
      const order = String(game.levelVars.get('_fork_order') ?? '');
      if (order !== last) {
        seen.push({
          label: order.slice(last.length).replace(/^>/, ''),
          combat: inCombat,
          phase: inCombat ? combatState.phase : null,
          onMap: !!defender.position,
          ...probe(),
        });
        last = order;
      }
      if (game.state.getCurrentState()?.name === 'free' &&
          last.includes(extras ? 'unit_wait' : 'combat_end')) break;
      if (loseGame && game.state.getCurrentState()?.name === 'game_over') break;
    }
    (window as any).__forkCombatLeft = {
      initialized: combatState.initialized,
      stack: game.state.getStackNames(),
    };
    const { setForkEngine } = await import('/src/engine/engine-flavor.ts');
    setForkEngine(false);
    (window as any).__forkDeathEnd = probe();
    if (attacker.position) game.board.removeUnit(attacker);
    game.units.delete(attacker.nid);
    game.units.delete(defender.nid);
    delete (window as any).__forkOrderTest;
    return seen;
  }, { extras, loseGame });
}

test.describe('EOtF engine fork combat cleanup order', () => {
  test('map combat: unit_death, fade, end_combat hooks, exp, then combat_end; no combat_death', async ({ page }) => {
    const timeline = await runHookCombat(page, true);
    expect(timeline.map((entry) => entry.label)).toEqual([
      'on_hit', 'unit_death', 'item_after_combat', 'skill_after_combat', 'exp', 'combat_end',
    ]);
    // Strike events still run between strikes, before the hit lands.
    expect(timeline[0]).toMatchObject({ combat: true, phase: 'combat', onMap: true });
    // UnitDeath runs before the dying fade; the hook events after it.
    expect(timeline[1]).toMatchObject({ onMap: true });
    expect(timeline[2]).toMatchObject({ onMap: false });
    // The exp screen follows the end_combat hook events.
    expect(timeline[4]).toMatchObject({ combat: true, onMap: false });
    expect(timeline[5]).toMatchObject({ combat: false });
  });

  // Python: clean_up's should_die only marks is_dying; UnitDeath's events
  // see `dead` False (check_dead True) with the unit still on the map, and
  // Die sets `dead` when the fade ends. CombatEnd was triggered first (the
  // fork's clean_up, upstream's clean_up2), so its events wait in the queue
  // under the UnitDeath ones.
  for (const fork of [true, false]) {
    test(`${fork ? 'fork' : 'upstream'}: UnitDeath events see is_dying, not dead; Die sets dead after the fade`, async ({ page }) => {
      const timeline = await runHookCombat(page, fork);
      const unitDeath = timeline.find((entry) => entry.label === 'unit_death');
      expect(unitDeath).toMatchObject({ onMap: true, dead: false, dying: true });
      expect(unitDeath?.queued).toContain('_ForkCombatEnd');
      const seenByEvent = await page.evaluate(() =>
        JSON.parse(JSON.stringify((window as any).__gameRef.levelVars.get('_fork_dead'))));
      expect(seenByEvent).toEqual([false, true, true]);
      const after = timeline.find((entry) => entry.label === 'item_after_combat');
      expect(after).toMatchObject({ onMap: false, dead: true, dying: false });
      expect(await page.evaluate(() => (window as any).__forkDeathEnd)).toMatchObject({ dead: true, dying: false });
    });
  }

  // Python: a game over from a UnitDeath event stops there; the dying fade
  // never runs (the unit stays is_dying, not dead), CombatEnd's events stay
  // queued, and the dropped CombatState never resumes in a later combat.
  test('fork: a game over from UnitDeath leaves the unit dying and the combat closed', async ({ page }) => {
    const timeline = await runHookCombat(page, true, false, true);
    expect(timeline.map((entry) => entry.label)).toEqual(['on_hit', 'unit_death']);
    expect(await page.evaluate(() => (window as any).__forkDeathEnd)).toMatchObject({
      dead: false, dying: true, queued: expect.arrayContaining(['_ForkCombatEnd']),
    });
    expect(await page.evaluate(() => (window as any).__forkCombatLeft)).toEqual({
      initialized: false, stack: ['game_over'],
    });
  });

  test('combat_end playback holds mark brushes read by attribute (p.nid, p.attacker)', async ({ page }) => {
    const timeline = await runHookCombat(page, true);
    expect(timeline.map((entry) => entry.label)).toContain('combat_end');
    const playback = await page.evaluate(() => (window as any).__gameRef.levelVars.get('_fork_playback'));
    expect(JSON.parse(JSON.stringify(playback))).toEqual([
      ['mark_hit', '_ForkAttacker', '_ForkDefender', '_ForkAttacker'],
    ]);
  });

  test('upstream projects keep the three-part cleanup with combat_death', async ({ page }) => {
    const timeline = await runHookCombat(page, false);
    // clean_up0 combat_death, clean_up1's exp screen, then clean_up2.
    expect(timeline.map((entry) => entry.label)).toEqual([
      'on_hit', 'exp', 'combat_death', 'unit_death', 'item_after_combat', 'skill_after_combat', 'combat_end',
    ]);
    expect(timeline[3]).toMatchObject({ onMap: true });
  });

  // Python handle_broken_items alerts "<blue>X</> broke." (pushed last in the
  // fork's clean_up, so shown first; after the exp screen upstream), and
  // handle_state_stack's WaitState waits the attacker through unit.wait()
  // (unit_wait, not actively chosen) after every end-of-combat event.
  test('fork: the broken-item alert shows first and unit_wait fires after combat_end', async ({ page }) => {
    const timeline = await runHookCombat(page, true, true);
    expect(timeline.map((entry) => entry.label)).toEqual([
      'on_hit', 'broken:<blue>_ForkSpell</> broke.', 'unit_death', 'item_after_combat', 'skill_after_combat',
      'exp', 'combat_end', 'unit_wait',
    ]);
    expect(timeline[7]).toMatchObject({ combat: false });
  });

  test('upstream: the broken-item alert follows the exp screen and unit_wait comes last', async ({ page }) => {
    const labels = (await runHookCombat(page, false, true)).map((entry) => entry.label);
    // clean_up1 pushes the alert under the exp screen; clean_up2's UnitDeath
    // comes after it (combat_death is clean_up0's).
    const broken = labels.indexOf('broken:<blue>_ForkSpell</> broke.');
    expect(broken).toBeGreaterThan(labels.indexOf('exp'));
    expect(broken).toBeGreaterThan(labels.indexOf('combat_death'));
    expect(broken).toBeLessThan(labels.indexOf('unit_death'));
    expect(labels.slice(-2)).toEqual(['combat_end', 'unit_wait']);
  });
});
