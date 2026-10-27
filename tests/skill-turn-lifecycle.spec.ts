import { test, expect } from '@playwright/test';

test.describe('skill turn lifecycle', () => {
  test('charge, time, expiry, and growing stat hooks are reversible', async ({ page }) => {
    await page.goto('/?harness=true&level=0&clean=true&bundle=false');
    await page.waitForFunction(() => !!(window as any).__harness?.ready, { timeout: 15000 });
    const result = await page.evaluate(async () => {
      const { SkillObject } = await import('/src/objects/skill.ts');
      const { applySkillTurnHooks } = await import('/src/engine/skill-turn-lifecycle.ts');
      const { statChange } = await import('/src/combat/skill-system.ts');
      const game = (window as any).__gameRef;
      const unit = game.getTeamUnits('player')[0];
      const oldSkills = unit.skills;
      const skill = new SkillObject({
        nid: '_TurnHooks', name: 'Turn Hooks', desc: '',
        icon_nid: '', icon_index: [0, 0],
        components: [
          ['build_charge', 5],
          ['upkeep_charge_increase', 2],
          ['charges_per_turn', 3],
          ['combined_time', 1],
        ],
      });
      const expiring = new SkillObject({
        nid: '_Expires', name: 'Expires', desc: '',
        icon_nid: '', icon_index: [0, 0],
        components: [['lost_on_endstep', null]],
      });
      const resources = new SkillObject({
        nid: '_Resources', name: 'Resources', desc: '',
        icon_nid: '', icon_index: [0, 0],
        components: [
          ['regeneration', 0.25],
          ['mana_regeneration', 3],
          ['upkeep_damage', 2],
          ['drain_charge', 2],
        ],
      });
      const growth = new SkillObject({
        nid: '_Growth', name: 'Growth', desc: '',
        icon_nid: '', icon_index: [0, 0],
        components: [['upkeep_stat_change', [['STR', 2]]]],
      });
      unit.skills = [skill, expiring, growth, resources];
      unit.currentHp = 10;
      unit.currentMana = 1;
      const before = game.actionLog.actionIndex;

      const upkeep = applySkillTurnHooks(game, [unit], 'upkeep');
      const afterUpkeep = {
        charge: skill.data.get('charge'),
        turns: skill.data.get('turns'),
        counter: growth.data.get('counter'),
        strength: statChange(unit, 'STR'),
        hp: unit.currentHp,
        mana: unit.currentMana,
        resourceCharge: resources.data.get('charge'),
        maxHp: unit.maxHp,
        effects: upkeep.map((effect: any) => effect.component),
      };
      const endstep = applySkillTurnHooks(game, [unit], 'endstep');
      const afterEndstep = {
        charge: skill.data.get('charge'),
        hasTimed: unit.skills.includes(skill),
        hasExpiring: unit.skills.includes(expiring),
        effects: endstep.map((effect: any) => effect.component),
      };
      const finalIndex = game.actionLog.actionIndex;

      while (game.actionLog.actionIndex > before) game.actionLog.runActionBackward();
      const reversed = {
        charge: skill.data.get('charge'),
        turns: skill.data.get('turns'),
        counter: growth.data.get('counter'),
        hasTimed: unit.skills.includes(skill),
        hasExpiring: unit.skills.includes(expiring),
        hp: unit.currentHp,
        mana: unit.currentMana,
        resourceCharge: resources.data.get('charge'),
      };
      while (game.actionLog.actionIndex < finalIndex) {
        game.actionLog.runActionForward();
      }
      const redone = {
        charge: skill.data.get('charge'),
        hasTimed: unit.skills.includes(skill),
        hasExpiring: unit.skills.includes(expiring),
      };
      unit.skills = oldSkills;
      return { afterUpkeep, afterEndstep, reversed, redone };
    });

    const expectedHp = 10 + Math.trunc(result.afterUpkeep.maxHp * 0.25) - 2;
    expect(result.afterUpkeep).toEqual({
      charge: 2,
      turns: 1,
      counter: 1,
      strength: 2,
      hp: expectedHp,
      mana: 4,
      resourceCharge: 1,
      maxHp: result.afterUpkeep.maxHp,
      effects: [
        'upkeep_charge_increase', 'combined_time', 'upkeep_stat_change',
        'regeneration', 'mana_regeneration', 'upkeep_damage',
      ],
    });
    expect(result.afterEndstep).toEqual({
      charge: 5,
      hasTimed: false,
      hasExpiring: false,
      effects: ['charges_per_turn', 'combined_time', 'lost_on_endstep'],
    });
    expect(result.reversed).toEqual({
      charge: 0,
      turns: 2,
      counter: 0,
      hasTimed: true,
      hasExpiring: true,
      hp: 10,
      mana: 1,
      resourceCharge: 2,
    });
    expect(result.redone).toEqual({
      charge: 5,
      hasTimed: false,
      hasExpiring: false,
    });
  });

  // Python: turn_change + status_endstep on top (the ending phase's endstep
  // hooks and their events run first), then TurnChangeState.end advances the
  // phase, pushes free, status_upkeep, phase_change and fires the phase
  // events above them (turn_change runs before phase_change: last trigger
  // first). PhaseChangeState locks the turnwheel and ResetAlls; then
  // status_upkeep pops the team's units last to first, each unit's events
  // running before the next unit, and ends with MarkPhase.
  test('a turn change interleaves endstep, phase events, ResetAll, and per-unit upkeep in Python order', async ({ page }) => {
    await page.goto('/?harness=true&level=0&clean=true&bundle=false');
    await page.waitForFunction(() => !!(window as any).__harness?.ready, { timeout: 15000 });
    await page.evaluate(() => (window as any).__harness.settle(600));
    const players: string[] = await page.evaluate(async () => {
      const { SkillObject } = await import('/src/objects/skill.ts');
      const game = (window as any).__gameRef;
      const log: string[] = [];
      (window as any).__order = log;
      const players = game.getTeamUnits('player').filter((u: any) => u.position).slice(0, 2);
      const enemy = game.getTeamUnits('enemy').find((u: any) => u.position);
      const event = (nid: string, trigger: string, key: string) => game.db.events.set(nid, {
        name: nid, nid, trigger, level_nid: game.currentLevel?.nid ?? null,
        condition: 'True', only_once: false, priority: 0, _source: [`game_var;${key};1`],
      });
      const skill = (nid: string, components: [string, unknown][]) => new SkillObject({
        nid, name: nid, desc: '', icon_nid: '', icon_index: [0, 0], components,
      } as any);
      event('_OrdTurn', 'turn_change', '_ord_turn_change');
      event('_OrdPhase', 'phase_change', '_ord_phase_change');
      event('_OrdEndstep', '_OrdEndstep', '_ord_endstep');
      enemy.skills.push(skill('_OrdEnd', [['endstep_event', '_OrdEndstep']]));
      players.forEach((unit: any, index: number) => {
        event(`_OrdUpkeep${index}`, `_OrdUpkeep${index}`, `_ord_upkeep_${unit.nid}`);
        unit.currentHp = Math.max(1, unit.maxHp - 5);
        unit.skills.push(skill(`_OrdUp${index}`, [['regeneration', 0.5], ['upkeep_event', `_OrdUpkeep${index}`]]));
      });
      const set = game.gameVars.set.bind(game.gameVars);
      game.gameVars.set = (key: string, value: unknown) => {
        if (String(key).startsWith('_ord_')) log.push(`event:${key.slice(5)}:${game.phase.getCurrent()}`);
        return set(key, value);
      };
      const doAction = game.actionLog.doAction.bind(game.actionLog);
      game.actionLog.doAction = (action: any) => {
        const name = action.constructor.name;
        if (['ResetAllAction', 'MarkPhase', 'LockTurnwheel'].includes(name)) log.push(name);
        else if (name === 'SetCurrentHpAction' && players.includes(action.unit)) log.push(`hp:${action.unit.nid}`);
        return doAction(action);
      };
      game.phase.setCurrentTeam('enemy');
      game.state.clear();
      game.state.change('turn_change');
      return players.map((unit: any) => unit.nid);
    });
    expect(players).toHaveLength(2);
    await page.evaluate(() => (window as any).__harness.settle(1200));
    const order = await page.evaluate(() => (window as any).__order);
    const [first, second] = players;
    expect(order).toEqual([
      'event:endstep:enemy',
      'event:turn_change:player',
      'event:phase_change:player',
      'LockTurnwheel',
      'ResetAllAction',
      // Regeneration has playback, so Python's StatusUpkeepState runs the
      // queued upkeep event (pushed over it) before the unit's ChangeHP.
      `event:upkeep_${second}:player`,
      `hp:${second}`,
      `event:upkeep_${first}:player`,
      `hp:${first}`,
      'MarkPhase',
    ]);
  });

  // Python TurnChangeState.end: IncrementTurn, then UpdateRecords('turn'),
  // at level start and on every player phase (records screen turn counts).
  test('level start and each player phase record a turn', async ({ page }) => {
    await page.goto('/?harness=true&level=0&clean=true&bundle=false');
    await page.waitForFunction(() => !!(window as any).__harness?.ready, { timeout: 15000 });
    await page.evaluate(() => (window as any).__harness.settle(600));
    const before = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const turns = g.records.turnsTaken.map((r: any) => r.turn);
      g.phase.setCurrentTeam('enemy');
      g.state.clear();
      g.state.change('turn_change');
      return { turns, level: g.currentLevel.nid, counts: g.records.getTurncounts([g.currentLevel.nid]) };
    });
    expect(before.turns).toEqual([1]);
    expect(before.counts).toEqual([1]);
    await page.evaluate(() => (window as any).__harness.settle(1200));
    const after = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      return { turns: g.records.turnsTaken.map((r: any) => r.turn), counts: g.records.getTurncounts([g.currentLevel.nid]) };
    });
    expect(after).toEqual({ turns: [1, 2], counts: [2] });
  });

  // Python level start: TurnChangeState.end records the turn and fires
  // PhaseChange, TurnChange, LevelStart (run newest first), then
  // PhaseChangeState locks the turnwheel and ResetAlls, then status_upkeep
  // marks the phase.
  test('level start runs level_start, turn_change, phase_change, then ResetAll and MarkPhase', async ({ page }) => {
    await page.goto('/?harness=true&level=0&clean=true&bundle=false');
    await page.waitForFunction(() => !!(window as any).__harness?.ready, { timeout: 15000 });
    await page.evaluate(() => (window as any).__harness.settle(600));
    await page.evaluate(async () => {
      const g = (window as any).__gameRef;
      const log: string[] = [];
      (window as any).__order = log;
      for (const trigger of ['level_start', 'turn_change', 'phase_change']) {
        g.db.events.set(`_Ord_${trigger}`, {
          name: `_Ord_${trigger}`, nid: `_Ord_${trigger}`, trigger, level_nid: null,
          condition: 'True', only_once: false, priority: 0, _source: [`game_var;_ord_${trigger};1`],
        });
      }
      const set = g.gameVars.set.bind(g.gameVars);
      g.gameVars.set = (key: string, value: unknown) => {
        if (String(key).startsWith('_ord_')) log.push(`event:${key.slice(5)}`);
        return set(key, value);
      };
      const doAction = g.actionLog.doAction.bind(g.actionLog);
      g.actionLog.doAction = (action: any) => {
        const name = action.constructor.name;
        if (['ResetAllAction', 'MarkPhase', 'LockTurnwheel'].includes(name)) log.push(name);
        else if (name === 'UpdateRecordsAction' && action.recordType === 'turn') log.push('record:turn');
        return doAction(action);
      };
      const { enterStartedLevel } = await import('/src/engine/states/game-states.ts');
      g.cleanUpLevel?.();
      await g.loadLevel('0');
      enterStartedLevel(g);
    });
    await page.evaluate(() => (window as any).__harness.settle(1200));
    const order: string[] = await page.evaluate(() => (window as any).__order);
    expect(order).toEqual([
      'record:turn', 'event:level_start', 'event:turn_change', 'event:phase_change',
      'LockTurnwheel', 'ResetAllAction', 'MarkPhase',
    ]);
  });
});
