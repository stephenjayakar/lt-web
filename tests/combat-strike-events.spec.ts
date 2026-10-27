import { expect, test, type Page } from '@playwright/test';

/**
 * Python's solver fires a phase's event_on_hit / event_on_strike events while
 * it resolves the phase; their EventStates run before that phase's hit is
 * shown or applied, and later phases are solved against what they changed.
 * event_before_combat events run before the first phase is solved.
 */

async function boot(page: Page, project?: string): Promise<void> {
  const query = project
    ? `/?harness=true&project=${project}&level=X&clean=true&bundle=false`
    : '/?harness=true&level=0&clean=true&bundle=false';
  await page.goto(query);
  await page.waitForFunction(() => (window as any).__harness?.ready === true, undefined, {
    timeout: 60_000,
  });
}

/** Place two fresh units `distance` tiles apart and start a CombatState. */
async function startCombat(
  page: Page,
  spec: {
    attackerStats?: Record<string, number>;
    defenderStats?: Record<string, number>;
    attackerHp: number;
    defenderHp: number;
    item: { nid: string; components: Array<[string, unknown]> } | { prefab: string };
    defenderItem?: { nid: string; components: Array<[string, unknown]> } | null;
    attackerSkills?: string[];
    distance: number;
    script: string[];
    events?: Record<string, string[]>;
    skills?: Record<string, Array<[string, unknown]>>;
  },
): Promise<boolean> {
  return page.evaluate(async (spec) => {
    const game = (window as any).__gameRef;
    const { UnitObject } = await import('/src/objects/unit.ts');
    const { ItemObject } = await import('/src/objects/item.ts');
    const { SkillObject } = await import('/src/objects/skill.ts');
    const klass = [...game.db.classes.values()].find((candidate: any) =>
      game.db.getConstant && (candidate.movement_group ?? 'Infantry') === 'Infantry') ??
      game.db.classes.values().next().value;
    if (!klass) return false;
    let origin: [number, number] | null = null;
    for (let y = 1; y < game.board.height - 1 && !origin; y++) {
      for (let x = 1; x + spec.distance < game.board.width - 1; x++) {
        if (!game.board.getUnit(x, y) && !game.board.getUnit(x + spec.distance, y)) {
          origin = [x, y];
          break;
        }
      }
    }
    if (!origin) return false;
    for (const [nid, source] of Object.entries(spec.events ?? {})) {
      game.db.events.set(nid, {
        nid, name: nid, trigger: nid, level_nid: null, condition: 'True', only_once: false,
        priority: 0, _source: source,
      });
    }
    for (const [nid, components] of Object.entries(spec.skills ?? {})) {
      game.db.skills.set(nid, {
        nid, name: nid, desc: '', icon_nid: '', icon_index: [0, 0], components,
      });
    }
    const makeUnit = (nid: string, team: string, hp: number, stats: Record<string, number>) => {
      const unit = new UnitObject({
        nid, name: nid, desc: '', variant: null, level: 1, klass: klass.nid, tags: [],
        bases: { HP: 40, STR: 0, MAG: 0, SKL: 5, SPD: 5, LCK: 0, DEF: 0, RES: 0, CON: 5, MOV: 5, ...stats },
        growths: {}, stat_cap_modifiers: {}, starting_items: [], learned_skills: [],
        unit_notes: [], fields: [], wexp_gain: {}, portrait_nid: '', affinity: '',
      } as any, klass);
      unit.team = team;
      unit.currentHp = hp;
      return unit;
    };
    const attacker = makeUnit('_StrikeAttacker', 'player', spec.attackerHp, spec.attackerStats ?? {});
    const defender = makeUnit('_StrikeDefender', 'enemy', spec.defenderHp, spec.defenderStats ?? {});
    const item = 'prefab' in spec.item
      ? new ItemObject(game.db.items.get(spec.item.prefab))
      : new ItemObject({
        nid: spec.item.nid, name: spec.item.nid, desc: '', icon_nid: '', icon_index: [0, 0],
        components: spec.item.components,
      });
    item.owner = attacker;
    attacker.items.push(item);
    if (spec.defenderItem) {
      const defenseItem = new ItemObject({
        nid: spec.defenderItem.nid, name: spec.defenderItem.nid, desc: '', icon_nid: '',
        icon_index: [0, 0], components: spec.defenderItem.components,
      });
      defenseItem.owner = defender;
      defender.items.push(defenseItem);
      // Equip it as a real unit would be: EOtF's get_weapon only reads the
      // equipped weapon, so an unequipped axe never counters.
      defender.equip(defenseItem);
    }
    for (const nid of spec.attackerSkills ?? []) {
      attacker.skills.push(new SkillObject(game.db.skills.get(nid)));
    }
    game.board.setUnit(origin[0], origin[1], attacker);
    game.board.setUnit(origin[0] + spec.distance, origin[1], defender);
    game.units.set(attacker.nid, attacker);
    game.units.set(defender.nid, defender);
    game.selectedUnit = attacker;
    game.combatTarget = defender;
    game.combatScript = spec.script;
    game.memory.set('combat_item', item);
    (window as any).__strikeTest = {
      attacker, defender, item, actionIndex: game.actionLog.actionIndex,
    };
    game.state.change('combat');
    return true;
  }, spec as any);
}

interface EventSample {
  combatPhase: string | null;
  presentation: string | null;
  strikesSolved: number;
  attackerHp: number;
  defenderHp: number;
}

/** Step until combat is over, sampling each time an EventState opens. */
async function runCombat(page: Page): Promise<{
  samples: EventSample[];
  damages: number[];
  attackerHp: number;
  defenderHp: number;
}> {
  return page.evaluate(async () => {
    const game = (window as any).__gameRef;
    const harness = (window as any).__harness;
    const { attacker, defender } = (window as any).__strikeTest;
    const combatState = game.state.allStates.get('combat');
    const samples: EventSample[] = [];
    let lastTop = '';
    let sawCombat = false;
    let lastActive: any = null;
    for (let frame = 0; frame < 4000; frame++) {
      harness.stepFrames(1, null);
      if (frame % 20 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
      const names: string[] = game.state.getStackNames();
      const top = game.state.getCurrentState()?.name ?? '';
      if (names.includes('combat')) {
        sawCombat = true;
        lastActive = (combatState.isAnimationCombat ? combatState.animCombat : combatState.combat) ?? lastActive;
      }
      if (top === 'event' && lastTop !== 'event' && names.includes('combat')) {
        const active = combatState.isAnimationCombat ? combatState.animCombat : combatState.combat;
        samples.push({
          combatPhase: combatState.phase,
          presentation: active?.state ?? null,
          strikesSolved: active?.strikes.length ?? 0,
          attackerHp: attacker.currentHp,
          defenderHp: defender.currentHp,
        });
      }
      lastTop = top;
      if (sawCombat && !names.includes('combat') && top !== 'event') break;
    }
    return {
      samples,
      damages: (lastActive?.strikes ?? []).map((strike: any) => strike.damage),
      attackerHp: attacker.currentHp,
      defenderHp: defender.currentHp,
    };
  });
}

test.describe('combat strike events run between strikes', () => {
  test('map combat runs event_on_hit before its hit and solves later strikes against it', async ({ page }) => {
    await boot(page);
    const ready = await startCombat(page, {
      attackerHp: 30,
      defenderHp: 30,
      defenderStats: { DEF: 5 },
      distance: 1,
      script: ['hit1', 'hit1'],
      events: {
        _StrikeOnHit: [
          'set_current_hp;{unit};{e:unit.get_hp() - 4}',
          'give_skill;{unit2};_StrikeBreak;no_banner',
        ],
      },
      skills: { _StrikeBreak: [['stack', 3], ['stat_change', [['DEF', -3]]]] },
      item: {
        nid: '_StrikeBlade',
        components: [
          ['weapon', null], ['target_enemy', null], ['damage', 10], ['hit', 100],
          ['min_range', 1], ['max_range', 1], ['uses', 10], ['event_on_hit', '_StrikeOnHit'],
        ],
      },
    });
    expect(ready).toBe(true);
    const result = await runCombat(page);

    // Each hit's event ran over the combat, paused before that hit: the first
    // saw the defender untouched and only its own phase solved; the second
    // saw the first hit applied and the attacker's HP the first event set.
    expect(result.samples).toEqual([
      { combatPhase: 'combat', presentation: 'strike_events', strikesSolved: 1, attackerHp: 30, defenderHp: 30 },
      { combatPhase: 'combat', presentation: 'strike_events', strikesSolved: 2, attackerHp: 26, defenderHp: 25 },
    ]);
    // The second hit was solved after the first event's DEF -3.
    expect(result.damages).toEqual([5, 8]);
    // The events' HP changes survive the end-of-combat result application.
    expect(result.attackerHp).toBe(22);
    expect(result.defenderHp).toBe(17);

    // Turnwheel: the combat (strikes and events) reverses and replays exactly.
    const wheel = await page.evaluate(() => {
      const game = (window as any).__gameRef;
      const { attacker, defender, actionIndex } = (window as any).__strikeTest;
      const end = game.actionLog.actionIndex;
      const state = () => ({
        attackerHp: attacker.currentHp,
        defenderHp: defender.currentHp,
        breaks: defender.skills.filter((skill: any) => skill.nid === '_StrikeBreak').length,
      });
      while (game.actionLog.actionIndex > actionIndex) game.actionLog.runActionBackward();
      const before = state();
      while (game.actionLog.actionIndex < end) game.actionLog.runActionForward();
      return { before, after: state() };
    });
    expect(wheel.before).toEqual({ attackerHp: 30, defenderHp: 30, breaks: 0 });
    expect(wheel.after).toEqual({ attackerHp: 22, defenderHp: 17, breaks: 2 });
  });

  for (const command of ['kill_unit', 'remove_unit']) {
    test(`a strike event that runs ${command} on the target mid-combat ends cleanly`, async ({ page }) => {
      await boot(page);
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      const ready = await startCombat(page, {
        attackerHp: 30,
        defenderHp: 30,
        distance: 1,
        script: ['hit1', 'hit1'],
        events: { _StrikeRemove: [`${command};{unit2}`] },
        item: {
          nid: '_StrikeBlade',
          components: [
            ['weapon', null], ['target_enemy', null], ['damage', 3], ['hit', 100],
            ['min_range', 1], ['max_range', 1], ['event_on_hit', '_StrikeRemove'],
          ],
        },
      });
      expect(ready).toBe(true);
      const result = await runCombat(page);
      const after = await page.evaluate(() => {
        const game = (window as any).__gameRef;
        const { defender } = (window as any).__strikeTest;
        return {
          top: game.state.getCurrentState()?.name,
          onMap: !!defender.position,
          dead: !!defender.dead,
        };
      });
      expect(errors).toEqual([]);
      expect(result.samples.length).toBeGreaterThanOrEqual(1);
      expect(after.top).not.toBe('combat');
      expect(after.onMap).toBe(false);
      if (command === 'kill_unit') expect(after.dead).toBe(true);
    });
  }

  test('combats started by strike and before-combat events run inside the waiting combat', async ({ page }) => {
    await boot(page);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const ready = await startCombat(page, {
      attackerHp: 30,
      defenderHp: 60,
      defenderStats: { HP: 60 },
      attackerStats: { SPD: 0 },
      distance: 1,
      script: ['hit1', 'hit1'],
      events: {
        _StrikeNested: ['interact_unit;{unit};{unit2};hit1;_NestedBolt;force_no_animation'],
        // Guarded like EOtF's Offhand_Attack: the follow-up combat's own
        // start must not start another one.
        _BeforeNested: [
          "if;v('_before_nested', 0) == 0",
          'level_var;_before_nested;1',
          'interact_unit;{unit};{unit2};hit1;_NestedBolt;force_no_animation',
          'end',
        ],
      },
      skills: { _BeforeSkill: [['event_before_combat', '_BeforeNested']] },
      attackerSkills: [],
      item: {
        nid: '_StrikeBlade',
        components: [
          ['weapon', null], ['target_enemy', null], ['damage', 3], ['hit', 100],
          ['min_range', 1], ['max_range', 1], ['event_on_hit', '_StrikeNested'],
        ],
      },
    });
    expect(ready).toBe(true);
    await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { SkillObject } = await import('/src/objects/skill.ts');
      const { CombatPhaseSolver } = await import('/src/combat/combat-solver.ts');
      game.db.items.set('_NestedBolt', {
        nid: '_NestedBolt', name: '_NestedBolt', desc: '', icon_nid: '', icon_index: [0, 0],
        components: [
          ['weapon', null], ['target_enemy', null], ['damage', 7], ['hit', 100],
          ['min_range', 1], ['max_range', 1],
        ],
      });
      const state = (window as any).__strikeTest;
      state.attacker.skills.push(new SkillObject(game.db.skills.get('_BeforeSkill')));
      // Four combats' exp would level up and wait on the level screen.
      state.attacker.level = 20;
      // Defender HP whenever a combat solves its first phase.
      const seen = new WeakSet<object>();
      state.firstPhaseHps = [];
      const original = CombatPhaseSolver.prototype.resolveNextPhase;
      state.restore = () => { CombatPhaseSolver.prototype.resolveNextPhase = original; };
      CombatPhaseSolver.prototype.resolveNextPhase = function (this: any) {
        if (!seen.has(this)) {
          seen.add(this);
          state.firstPhaseHps.push(state.defender.currentHp);
        }
        return original.call(this);
      };
    });
    const result = await runCombat(page);
    const after = await page.evaluate(() => {
      const game = (window as any).__gameRef;
      const state = (window as any).__strikeTest;
      state.restore();
      return {
        firstPhaseHps: state.firstPhaseHps,
        top: game.state.getCurrentState()?.name,
        stack: game.state.getStackNames().filter((name: string) => name === 'combat').length,
      };
    });
    expect(errors).toEqual([]);
    // The before-combat combat ran first (60 -> 53); the outer combat solved
    // its first phase only afterwards. Each outer hit's event combat (7)
    // runs before that hit (3) lands: 53 -> 46 -> 43 -> 36 -> 33.
    expect(after.firstPhaseHps).toEqual([60, 53, 53, 43]);
    expect(result.damages).toEqual([3, 3]);
    expect(result.defenderHp).toBe(33);
    expect(after.stack).toBe(0);
  });

  test('animation combat pauses for event_on_hit the same way', async ({ page }) => {
    await boot(page);
    const ready = await page.evaluate(() => {
      const game = (window as any).__gameRef;
      const attacker = game.units.get('Eirika');
      const defender = [...game.units.values()].find((unit: any) =>
        unit.team === 'enemy' && unit.position && !unit.isDead());
      const weapon = attacker?.items.find((item: any) => item.isWeapon());
      if (!attacker?.position || !defender || !weapon) return false;
      game.db.events.set('_AnimOnHit', {
        nid: '_AnimOnHit', name: '_AnimOnHit', trigger: '_AnimOnHit', level_nid: null,
        condition: 'True', only_once: false, priority: 0,
        _source: ['set_current_hp;{unit};{e:unit.get_hp() - 4}'],
      });
      weapon.components.set('event_on_hit', '_AnimOnHit');
      game.board.moveUnit(defender, attacker.position[0], attacker.position[1] - 1);
      defender.currentHp = defender.maxHp;
      attacker.currentHp = attacker.maxHp;
      game.selectedUnit = attacker;
      game.combatTarget = defender;
      game.combatScript = ['hit1', 'hit1', 'end'];
      (window as any).__strikeTest = { attacker, defender, weapon, startHp: attacker.currentHp };
      game.state.change('combat');
      return true;
    });
    expect(ready).toBe(true);
    const result = await runCombat(page);
    const startHp = await page.evaluate(() => {
      const { weapon, startHp } = (window as any).__strikeTest;
      weapon.components.delete('event_on_hit');
      return startHp;
    });

    expect(result.samples.map((sample) => [sample.presentation, sample.strikesSolved, sample.attackerHp]))
      .toEqual([
        ['strike_events', 1, startHp],
        ['strike_events', 2, startHp - 4],
      ]);
    expect(result.attackerHp).toBe(startHp - 8);
  });

  test('EOtF S_L: the second brave hit is solved after the first hit\'s DEF debuff', async ({ page }) => {
    await boot(page, 'eotf.ltproj');
    // Ability_S_L_Debuff lowers the higher of DEF/RES by 3; S_L resists with
    // min(DEF, RES), so DEF 5 / RES 4 becomes DEF 2 for the second hit.
    const ready = await startCombat(page, {
      attackerHp: 30,
      defenderHp: 40,
      defenderStats: { DEF: 5, RES: 4 },
      distance: 2,
      script: ['hit1', 'hit1'],
      item: { prefab: 'S_L' },
    });
    expect(ready).toBe(true);
    const result = await runCombat(page);
    expect(result.samples.map((sample) => sample.strikesSolved)).toEqual([1, 2]);
    expect(result.damages.length).toBe(2);
    expect(result.damages[1] - result.damages[0]).toBe(2);
    expect(result.defenderHp).toBe(40 - result.damages[0] - result.damages[1]);
  });

  test('EOtF Avowed: event_before_combat records HP before the first strike', async ({ page }) => {
    await boot(page, 'eotf.ltproj');
    // Ability_Avowed_Start records the unit's HP before combat; after combat
    // Ability_Avowed_End spreads half the HP lost to every other Avowed ally.
    const ready = await startCombat(page, {
      attackerHp: 30,
      defenderHp: 40,
      attackerSkills: ['Avowed'],
      defenderStats: { STR: 12 },
      distance: 1,
      script: ['hit1', 'hit2'],
      defenderItem: {
        nid: '_StrikeAxe',
        components: [
          ['weapon', null], ['target_enemy', null], ['damage', 3], ['hit', 100],
          ['min_range', 1], ['max_range', 1],
        ],
      },
      item: {
        nid: '_StrikeLance',
        components: [
          ['weapon', null], ['target_enemy', null], ['damage', 3], ['hit', 100],
          ['min_range', 1], ['max_range', 1],
        ],
      },
    });
    expect(ready).toBe(true);
    // An Avowed ally elsewhere on the map; note what the before-combat event
    // had recorded when the first phase was solved.
    const placed = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { UnitObject } = await import('/src/objects/unit.ts');
      const { SkillObject } = await import('/src/objects/skill.ts');
      const { CombatPhaseSolver } = await import('/src/combat/combat-solver.ts');
      const state = (window as any).__strikeTest;
      const klass = game.db.classes.get(state.attacker.klass);
      const ally = new UnitObject({
        nid: '_StrikeAvowedAlly', name: '_StrikeAvowedAlly', desc: '', variant: null, level: 1,
        klass: klass.nid, tags: [],
        bases: { HP: 40, STR: 0, MAG: 0, SKL: 5, SPD: 5, LCK: 0, DEF: 0, RES: 0, CON: 5, MOV: 5 },
        growths: {}, stat_cap_modifiers: {}, starting_items: [], learned_skills: [],
        unit_notes: [], fields: [], wexp_gain: {}, portrait_nid: '', affinity: '',
      } as any, klass);
      ally.team = 'player';
      ally.currentHp = 20;
      ally.skills.push(new SkillObject(game.db.skills.get('Avowed')));
      let spot: [number, number] | null = null;
      for (let y = game.board.height - 2; y > 0 && !spot; y--) {
        for (let x = game.board.width - 2; x > 0; x--) {
          if (!game.board.getUnit(x, y)) { spot = [x, y]; break; }
        }
      }
      if (!spot) return false;
      game.board.setUnit(spot[0], spot[1], ally);
      game.units.set(ally.nid, ally);
      state.ally = ally;
      game.levelVars.delete('avow_hp_start');
      const original = CombatPhaseSolver.prototype.resolveNextPhase;
      state.restore = () => { CombatPhaseSolver.prototype.resolveNextPhase = original; };
      CombatPhaseSolver.prototype.resolveNextPhase = function (this: any) {
        state.atFirstPhase ??= game.levelVars.get('avow_hp_start') ?? null;
        return original.call(this);
      };
      return true;
    });
    expect(placed).toBe(true);
    const result = await runCombat(page);
    const after = await page.evaluate(() => {
      const game = (window as any).__gameRef;
      const state = (window as any).__strikeTest;
      state.restore();
      return {
        atFirstPhase: state.atFirstPhase,
        start: game.levelVars.get('avow_hp_start'),
        end: game.levelVars.get('avow_hp_end'),
        allyHp: state.ally.currentHp,
      };
    });
    // The counter took 15 HP; half of it reached the other Avowed unit.
    expect(result.attackerHp).toBe(15);
    expect(after).toEqual({ atFirstPhase: 30, start: 30, end: 15, allyHp: 13 });
  });

  test('EOtF Entangle: every child fires event_on_hit, the phase newest first', async ({ page }) => {
    await boot(page, 'eotf.ltproj');
    const queued = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { createItemTree } = await import('/src/objects/item.ts');
      const { applyCoreSequenceItem } = await import('/src/engine/states/game-states.ts');
      const caster = game.units.get('Player');
      if (!caster?.position) return null;
      const free: Array<[number, number]> = [];
      for (let y = 0; y < game.board.height && free.length < 3; y++) {
        for (let x = 0; x < game.board.width && free.length < 3; x++) {
          const distance = Math.abs(x - caster.position[0]) + Math.abs(y - caster.position[1]);
          if (distance >= 1 && distance <= 5 && !game.board.getUnit(x, y)) free.push([x, y]);
        }
      }
      if (free.length < 3) return null;
      const { UnitObject } = await import('/src/objects/unit.ts');
      const klass = game.db.classes.get(caster.klass);
      const makeUnit = (nid: string, team: string, position: [number, number]) => {
        const unit = new UnitObject({
          nid, name: nid, desc: '', variant: null, level: 1, klass: klass.nid, tags: [],
          bases: { HP: 20, STR: 0, MAG: 0, SKL: 5, SPD: 5, LCK: 0, DEF: 0, RES: 0, CON: 5, MOV: 5 },
          growths: {}, stat_cap_modifiers: {}, starting_items: [], learned_skills: [],
          unit_notes: [], fields: [], wexp_gain: {}, portrait_nid: '', affinity: '',
        } as any, klass);
        unit.team = team;
        game.board.setUnit(position[0], position[1], unit);
        game.units.set(nid, unit);
        return unit;
      };
      const ally = makeUnit('_EntangleAlly', 'player', free[0]);
      const enemy = makeUnit('_EntangleEnemy', 'enemy', free[1]);
      const entangle = createItemTree(game.db.items.get('Entangle'), (nid: string) => game.db.items.get(nid));
      entangle.owner = caster;
      caster.items.push(entangle);
      game.eventManager.eventQueue.length = 0;
      // Children in authored order: Entangle_4 (tile), _1 (ally), _2 (tile), _3 (enemy).
      const applied = applyCoreSequenceItem(caster, entangle, [
        [free[2]], [ally.position], [free[2]], [enemy.position],
      ]);
      // The caster's automatic wait (unit_wait) queues after the hit events.
      const hits = game.eventManager.eventQueue.filter((event: any) =>
        String(event.nid ?? event.prefab?.nid ?? event.name).includes('Entangle'));
      return {
        applied,
        order: hits.map((event: any) => event.nid ?? event.prefab?.nid ?? event.name),
        unit2: hits.map((event: any) => event.trigger?.unit2?.nid ?? null),
        casterNid: caster.nid,
        allyNid: ally.nid,
        enemyNid: enemy.nid,
      };
    });
    expect(queued).not.toBeNull();
    expect(queued!.applied).toBe(true);
    // Python pushes the four triggers in child order and runs them newest
    // first, so Entangle_Shuffle reads what the other three recorded.
    expect(queued!.order).toEqual([
      'Global Item_Entangle_Enemy',
      'Global Item_Entangle_Position',
      'Global Item_Entangle_Ally',
      'Global Item_Entangle_Shuffle',
    ]);
    expect(queued!.unit2).toEqual([
      queued!.enemyNid, queued!.casterNid, queued!.allyNid, queued!.casterNid,
    ]);
  });
});
