import { expect, test, type Page } from '@playwright/test';

async function waitForHarness(page: Page): Promise<void> {
  await page.waitForFunction(
    () => (window as any).__harness?.ready === true,
    { timeout: 60_000 },
  );
}

type TriggerTrace = {
  type: 'during_unit_level_up' | 'unit_level_up';
  unitNid: string;
  source: string;
  statChanges: Record<string, number>;
  combatPhase: string;
  screenState: string;
  copiedStatChanges: boolean;
  sameScreen: boolean;
};

type LifecycleResult = {
  trace: TriggerTrace[];
  atInterrupt: {
    topState: string;
    screenState: string;
    duringStarted: unknown;
    duringFinished: unknown;
    lateStarted: unknown;
  };
  atResume: {
    topState: string;
    combatPhase: string;
    screenState: string;
    sameScreen: boolean;
    duringFinished: unknown;
    lateStarted: unknown;
  };
  afterWait: {
    topState: string;
    screenState: string;
    lateStarted: unknown;
  };
  finalMarkers: {
    duringStarted: unknown;
    duringFinished: unknown;
    lateStarted: unknown;
  };
};

async function runCombatLevelUp(page: Page, zeroGrowths: boolean): Promise<LifecycleResult> {
  await page.goto('/?harness=true&level=0&clean=true&bundle=false');
  await waitForHarness(page);

  const setup = await page.evaluate(async ({ zeroGrowths }) => {
    const game = (window as any).__gameRef;
    const harness = (window as any).__harness;
    const { UnitObject } = await import('/src/objects/unit.ts');
    const { ItemObject } = await import('/src/objects/item.ts');
    const template = game.units.get('Eirika');
    const klass = template ? game.db.classes.get(template.klass) : null;
    if (!template || !klass) return false;

    let origin: [number, number] | null = null;
    for (let y = 1; y < game.board.height - 1 && !origin; y++) {
      for (let x = 1; x < game.board.width - 1 && !origin; x++) {
        if (!game.board.getUnit(x, y) && !game.board.getUnit(x + 1, y)) {
          origin = [x, y];
        }
      }
    }
    if (!origin) return false;

    const statNids = game.db.stats.map((stat: any) => stat.nid);
    const bases = Object.fromEntries(statNids.map((nid: string) => [nid, nid === 'HP' ? 20 : 1]));
    const growths = Object.fromEntries(statNids.map((nid: string) => [nid, zeroGrowths ? 0 : 100]));
    const emptyGrowths = Object.fromEntries(statNids.map((nid: string) => [nid, 0]));
    const makeUnit = (
      nid: string,
      name: string,
      team: string,
      level: number,
      unitGrowths: Record<string, number>,
    ) => {
      const unit = new UnitObject({
        nid,
        name,
        desc: '',
        variant: null,
        level,
        klass: template.klass,
        tags: [],
        bases,
        growths: unitGrowths,
        stat_cap_modifiers: {},
        starting_items: [],
        learned_skills: [],
        unit_notes: [],
        fields: [],
        wexp_gain: {},
        portrait_nid: '',
        affinity: '',
      } as any, klass);
      unit.team = team;
      unit.currentHp = unit.maxHp;
      return unit;
    };

    const attacker = makeUnit('_LevelTriggerAttacker', 'Level Trigger Attacker', 'player', 1, growths);
    const defender = makeUnit('_LevelTriggerDefender', 'Level Trigger Defender', 'enemy', 10, emptyGrowths);
    attacker.exp = 99;
    defender.currentHp = 1;

    const item = new ItemObject({
      nid: '_LevelTriggerSpell',
      name: 'Level Trigger Spell',
      desc: '',
      icon_nid: '',
      icon_index: [0, 0],
      components: [
        ['spell', null],
        ['target_enemy', null],
        ['damage', 99],
        ['hit', 100],
        ['uses', 5],
        ['min_range', 1],
        ['max_range', 1],
      ],
    });
    attacker.items.push(item);

    game.board.setUnit(origin[0], origin[1], attacker);
    game.board.setUnit(origin[0] + 1, origin[1], defender);
    game.units.set(attacker.nid, attacker);
    game.units.set(defender.nid, defender);

    game.db.events.set('_test_during_unit_level_up', {
      nid: '_test_during_unit_level_up',
      name: 'During Unit Level Up',
      trigger: 'during_unit_level_up',
      level_nid: '0',
      condition: "source == 'exp_gain'",
      only_once: false,
      priority: 0,
      _source: [
        'game_var;_during_level_started;yes',
        'wait;500',
        'game_var;_during_level_finished;yes',
      ],
    });
    game.db.events.set('_test_late_unit_level_up', {
      nid: '_test_late_unit_level_up',
      name: 'Late Unit Level Up',
      trigger: 'unit_level_up',
      level_nid: '0',
      condition: "source == 'exp_gain'",
      only_once: false,
      priority: 0,
      _source: ['game_var;_late_level_started;yes'],
    });

    const trace: TriggerTrace[] = [];
    const originalTrigger = game.eventManager.trigger.bind(game.eventManager);
    game.eventManager.trigger = (trigger: any, context: any) => {
      if (trigger.type === 'during_unit_level_up' || trigger.type === 'unit_level_up') {
        const combat = game.state.getCurrentState() as any;
        const screen = combat?.levelUpScreen;
        if (trigger.type === 'during_unit_level_up') {
          (window as any).__levelTriggerScreen = screen;
        }
        trace.push({
          type: trigger.type,
          unitNid: trigger.unit1?.nid ?? '',
          source: trigger.source ?? '',
          statChanges: { ...(trigger.statChanges ?? {}) },
          combatPhase: combat?.phase ?? '',
          screenState: screen?.state ?? '',
          copiedStatChanges: trigger.statChanges !== combat?.levelUpGains,
          sameScreen: !((window as any).__levelTriggerScreen) ||
            screen === (window as any).__levelTriggerScreen,
        });
      }
      return originalTrigger(trigger, context);
    };

    (window as any).__levelTriggerTrace = trace;
    (window as any).__levelTriggerNow = 0;
    Object.defineProperty(performance, 'now', {
      configurable: true,
      value: () => (window as any).__levelTriggerNow,
    });
    game.frameDeltaMs = 1000;
    game.selectedUnit = attacker;
    game.combatTarget = defender;
    game.combatScript = ['hit1'];
    game.memory.set('combat_item', item);
    game.state.change('combat');
    harness.stepFrames(1, null);
    return performance.now() === 0;
  }, { zeroGrowths });
  expect(setup).toBe(true);

  const atInterrupt = await page.evaluate(() => {
    const game = (window as any).__gameRef;
    const harness = (window as any).__harness;
    const trace = (window as any).__levelTriggerTrace as TriggerTrace[];
    for (let frame = 0; frame < 300; frame++) {
      (window as any).__levelTriggerNow += 400;
      harness.stepFrames(1, null);
      if (game.state.getCurrentState()?.name === 'event' &&
          trace.some((entry) => entry.type === 'during_unit_level_up')) {
        break;
      }
    }
    harness.stepFrames(1, null);
    const screen = (window as any).__levelTriggerScreen as any;
    return {
      topState: game.state.getCurrentState()?.name ?? '',
      screenState: screen?.state ?? '',
      duringStarted: game.gameVars.get('_during_level_started'),
      duringFinished: game.gameVars.get('_during_level_finished'),
      lateStarted: game.gameVars.get('_late_level_started'),
    };
  });

  const atResume = await page.evaluate(() => {
    const game = (window as any).__gameRef;
    const harness = (window as any).__harness;
    for (let frame = 0; frame < 60; frame++) {
      harness.stepFrames(1, null);
      if (game.state.getCurrentState()?.name === 'combat' &&
          game.gameVars.get('_during_level_finished') === 'yes') {
        break;
      }
    }
    const combat = game.state.getCurrentState() as any;
    const screen = combat?.levelUpScreen;
    return {
      topState: combat?.name ?? '',
      combatPhase: combat?.phase ?? '',
      screenState: screen?.state ?? '',
      sameScreen: screen === (window as any).__levelTriggerScreen,
      duringFinished: game.gameVars.get('_during_level_finished'),
      lateStarted: game.gameVars.get('_late_level_started'),
    };
  });

  const afterWait = await page.evaluate(() => {
    const game = (window as any).__gameRef;
    const harness = (window as any).__harness;
    (window as any).__levelTriggerNow += 1400;
    harness.stepFrames(1, null);
    const combat = game.state.getCurrentState() as any;
    return {
      topState: combat?.name ?? '',
      screenState: combat?.levelUpScreen?.state ?? '',
      lateStarted: game.gameVars.get('_late_level_started'),
    };
  });

  const finalMarkers = await page.evaluate(() => {
    const game = (window as any).__gameRef;
    const harness = (window as any).__harness;
    (window as any).__levelTriggerNow += 600;
    harness.stepFrames(1, null);
    for (let frame = 0; frame < 120; frame++) {
      harness.stepFrames(1, null);
      if (game.gameVars.get('_late_level_started') === 'yes') break;
    }
    return {
      duringStarted: game.gameVars.get('_during_level_started'),
      duringFinished: game.gameVars.get('_during_level_finished'),
      lateStarted: game.gameVars.get('_late_level_started'),
    };
  });

  const trace = await page.evaluate(
    () => (window as any).__levelTriggerTrace as TriggerTrace[],
  );
  return { trace, atInterrupt, atResume, afterWait, finalMarkers };
}

test('combat EXP level-up interrupts at level_up_wait, resumes, then fires the late trigger once', async ({ page }) => {
  const nonzero = await runCombatLevelUp(page, false);

  expect(nonzero.trace.map((entry) => entry.type)).toEqual([
    'during_unit_level_up',
    'unit_level_up',
  ]);
  for (const entry of nonzero.trace) {
    expect(entry.unitNid).toBe('_LevelTriggerAttacker');
    expect(entry.source).toBe('exp_gain');
    expect(entry.combatPhase).toBe('level_screen');
    expect(entry.copiedStatChanges).toBe(true);
    expect(entry.sameScreen).toBe(true);
  }
  expect(nonzero.trace[0].screenState).toBe('level_up_wait');
  expect(nonzero.trace[1].screenState).toBe('scroll_out');
  expect(nonzero.trace[0].statChanges).toEqual(nonzero.trace[1].statChanges);
  expect(Object.values(nonzero.trace[0].statChanges).some((value) => value !== 0)).toBe(true);

  expect(nonzero.atInterrupt).toEqual({
    topState: 'event',
    screenState: 'level_up_wait',
    duringStarted: 'yes',
    duringFinished: undefined,
    lateStarted: undefined,
  });
  expect(nonzero.atResume).toEqual({
    topState: 'combat',
    combatPhase: 'level_screen',
    screenState: 'level_up_wait',
    sameScreen: true,
    duringFinished: 'yes',
    lateStarted: undefined,
  });
  expect(nonzero.afterWait).toEqual({
    topState: 'combat',
    screenState: 'scroll_out',
    lateStarted: undefined,
  });
  expect(nonzero.finalMarkers).toEqual({
    duringStarted: 'yes',
    duringFinished: 'yes',
    lateStarted: 'yes',
  });

  // Python's inc_spark recursion still reaches DuringUnitLevelUp when every
  // displayed change is zero; the web flow must not skip the screen/trigger.
  const zero = await runCombatLevelUp(page, true);
  expect(zero.trace.map((entry) => entry.type)).toEqual([
    'during_unit_level_up',
    'unit_level_up',
  ]);
  expect(Object.values(zero.trace[0].statChanges).every((value) => value === 0)).toBe(true);
  expect(zero.trace[0]).toMatchObject({
    unitNid: '_LevelTriggerAttacker',
    source: 'exp_gain',
    combatPhase: 'level_screen',
    screenState: 'level_up_wait',
    copiedStatChanges: true,
  });
  expect(zero.atInterrupt.topState).toBe('event');
  expect(zero.atResume).toMatchObject({
    topState: 'combat',
    combatPhase: 'level_screen',
    screenState: 'level_up_wait',
    sameScreen: true,
  });
  expect(zero.finalMarkers).toEqual({
    duringStarted: 'yes',
    duringFinished: 'yes',
    lateStarted: 'yes',
  });
});

type EventProducerKind = 'stat_change' | 'set_stats_immediate' | 'class_change' | 'promote';

type EventProducerResult = {
  trace: TriggerTrace[];
  atInterrupt: {
    currentEvent: string;
    screenState: string;
    sameScreen: boolean;
    actionApplied: boolean;
    duringStarted: unknown;
    duringFinished: unknown;
    producerAfter: unknown;
  };
  atResume: {
    currentEvent: string;
    screenState: string;
    sameScreen: boolean;
    duringFinished: unknown;
    producerAfter: unknown;
  };
  final: {
    duringStarted: unknown;
    duringFinished: unknown;
    producerAfter: unknown;
    lateStarted: unknown;
    screenPresent: boolean;
  };
};

async function runEventLevelUpProducer(
  page: Page,
  kind: EventProducerKind,
): Promise<EventProducerResult> {
  await page.goto('/?harness=true&level=0&clean=true&bundle=false');
  await waitForHarness(page);

  const setup = await page.evaluate(async ({ kind }) => {
    const game = (window as any).__gameRef;
    const harness = (window as any).__harness;
    const unit = game.units.get('Eirika');
    if (!unit) return false;

    let source: 'stat_change' | 'class_change' | 'promote';
    let command: string;
    let expected: unknown;
    if (kind === 'stat_change') {
      source = 'stat_change';
      command = `change_stats;${unit.nid};STR,2,DEF,-1`;
      expected = {
        STR: Math.min(2, unit.getStatCap('STR') - unit.stats.STR),
        DEF: Math.max(-1, -unit.stats.DEF),
      };
      (window as any).__producerBefore = {
        STR: unit.stats.STR,
        DEF: unit.stats.DEF,
      };
    } else if (kind === 'set_stats_immediate') {
      source = 'stat_change';
      const target = Math.min(unit.getStatCap('STR'), unit.stats.STR + 3);
      command = `set_stats;${unit.nid};STR,${target};immediate`;
      expected = target;
      (window as any).__producerBefore = unit.stats.STR;
    } else {
      const currentKlass = game.db.classes.get(unit.klass);
      const classes = [...game.db.classes.values()];
      const target = kind === 'promote'
        ? currentKlass?.turns_into?.[0] ??
          classes.find((klass: any) => klass.promotes_from === unit.klass)?.nid
        : classes.find((klass: any) =>
          klass.nid !== unit.klass &&
          klass.tier === currentKlass?.tier &&
          klass.bases &&
          klass.max_stats)?.nid;
      if (!target) return false;
      source = kind;
      command = `${kind === 'promote' ? 'promote' : 'change_class'};${unit.nid};${target}`;
      expected = target;
      (window as any).__producerBefore = unit.klass;
    }

    game.db.events.set('_test_event_level_producer', {
      nid: '_test_event_level_producer',
      name: 'Event Level Producer',
      trigger: '_test_event_level_producer',
      level_nid: '0',
      condition: 'true',
      only_once: false,
      priority: 0,
      _source: [
        command,
        'game_var;_producer_after;yes',
      ],
    });
    game.db.events.set('_test_event_level_during', {
      nid: '_test_event_level_during',
      name: 'Event Level During',
      trigger: 'during_unit_level_up',
      level_nid: '0',
      condition: `source == '${source}'`,
      only_once: false,
      priority: 0,
      _source: [
        'game_var;_event_during_started;yes',
        'wait;500',
        'game_var;_event_during_finished;yes',
      ],
    });
    game.db.events.set('_test_event_level_late', {
      nid: '_test_event_level_late',
      name: 'Event Level Late',
      trigger: 'unit_level_up',
      level_nid: '0',
      condition: `source == '${source}'`,
      only_once: false,
      priority: 0,
      _source: ['game_var;_event_late_started;yes'],
    });

    const trace: TriggerTrace[] = [];
    const originalTrigger = game.eventManager.trigger.bind(game.eventManager);
    game.eventManager.trigger = (trigger: any, context: any) => {
      if (trigger.type === 'during_unit_level_up' || trigger.type === 'unit_level_up') {
        const state = game.state.getCurrentState() as any;
        const presentation = state?.levelUpPresentation;
        if (trigger.type === 'during_unit_level_up') {
          (window as any).__eventLevelScreen = presentation?.screen;
        }
        trace.push({
          type: trigger.type,
          unitNid: trigger.unit1?.nid ?? '',
          source: trigger.source ?? '',
          statChanges: { ...(trigger.statChanges ?? {}) },
          combatPhase: state?.name ?? '',
          screenState: presentation?.screen?.state ?? '',
          copiedStatChanges: trigger.statChanges !== presentation?.statChanges,
          sameScreen: !((window as any).__eventLevelScreen) ||
            presentation?.screen === (window as any).__eventLevelScreen,
        });
      }
      return originalTrigger(trigger, context);
    };

    (window as any).__eventLevelTrace = trace;
    (window as any).__eventLevelExpected = expected;
    (window as any).__eventLevelKind = kind;
    (window as any).__eventLevelNow = 0;
    Object.defineProperty(performance, 'now', {
      configurable: true,
      value: () => (window as any).__eventLevelNow,
    });
    game.eventManager.triggerSpecific(
      '_test_event_level_producer',
      { type: '_test_event_level_producer' },
      true,
    );
    game.state.change('event');
    harness.stepFrames(1, null);
    return true;
  }, { kind });
  expect(setup).toBe(true);

  const atInterrupt = await page.evaluate(() => {
    const game = (window as any).__gameRef;
    const harness = (window as any).__harness;
    const trace = (window as any).__eventLevelTrace as TriggerTrace[];
    for (let frame = 0; frame < 300; frame++) {
      (window as any).__eventLevelNow += 400;
      harness.stepFrames(1, null);
      const state = game.state.getCurrentState() as any;
      if (trace.some((entry) => entry.type === 'during_unit_level_up') &&
          state?.currentEvent?.nid === '_test_event_level_during') {
        break;
      }
    }
    harness.stepFrames(1, null);
    const state = game.state.getCurrentState() as any;
    const unit = game.units.get('Eirika');
    const kind = (window as any).__eventLevelKind as EventProducerKind;
    const expected = (window as any).__eventLevelExpected;
    const before = (window as any).__producerBefore;
    const actionApplied = kind === 'stat_change'
      ? unit.stats.STR === before.STR + expected.STR &&
        unit.stats.DEF === before.DEF + expected.DEF
      : kind === 'set_stats_immediate'
        ? unit.stats.STR === expected
        : unit.klass === expected && unit.klass !== before;
    return {
      currentEvent: state?.currentEvent?.nid ?? '',
      screenState: state?.levelUpPresentation?.screen?.state ?? '',
      sameScreen: state?.levelUpPresentation?.screen === (window as any).__eventLevelScreen,
      actionApplied,
      duringStarted: game.gameVars.get('_event_during_started'),
      duringFinished: game.gameVars.get('_event_during_finished'),
      producerAfter: game.gameVars.get('_producer_after'),
    };
  });

  const atResume = await page.evaluate(() => {
    const game = (window as any).__gameRef;
    const harness = (window as any).__harness;
    for (let frame = 0; frame < 60; frame++) {
      harness.stepFrames(1, null);
      const state = game.state.getCurrentState() as any;
      if (state?.currentEvent?.nid === '_test_event_level_producer' &&
          game.gameVars.get('_event_during_finished') === 'yes') {
        break;
      }
    }
    const state = game.state.getCurrentState() as any;
    return {
      currentEvent: state?.currentEvent?.nid ?? '',
      screenState: state?.levelUpPresentation?.screen?.state ?? '',
      sameScreen: state?.levelUpPresentation?.screen === (window as any).__eventLevelScreen,
      duringFinished: game.gameVars.get('_event_during_finished'),
      producerAfter: game.gameVars.get('_producer_after'),
    };
  });

  const final = await page.evaluate(() => {
    const game = (window as any).__gameRef;
    const harness = (window as any).__harness;
    (window as any).__eventLevelNow += 1400;
    harness.stepFrames(1, null);
    (window as any).__eventLevelNow += 600;
    harness.stepFrames(1, null);
    for (let frame = 0; frame < 30; frame++) {
      harness.stepFrames(1, null);
      if (game.gameVars.get('_event_late_started') === 'yes') break;
    }
    const state = game.state.getCurrentState() as any;
    return {
      duringStarted: game.gameVars.get('_event_during_started'),
      duringFinished: game.gameVars.get('_event_during_finished'),
      producerAfter: game.gameVars.get('_producer_after'),
      lateStarted: game.gameVars.get('_event_late_started'),
      screenPresent: !!state?.levelUpPresentation,
    };
  });

  const trace = await page.evaluate(
    () => (window as any).__eventLevelTrace as TriggerTrace[],
  );
  return { trace, atInterrupt, atResume, final };
}

test('event stat changes use the level screen lifecycle while immediate set_stats skips it', async ({ page }) => {
  const displayed = await runEventLevelUpProducer(page, 'stat_change');
  expect(displayed.trace.map((entry) => entry.type)).toEqual([
    'during_unit_level_up',
    'unit_level_up',
  ]);
  for (const entry of displayed.trace) {
    expect(entry).toMatchObject({
      unitNid: 'Eirika',
      source: 'stat_change',
      combatPhase: 'event',
      copiedStatChanges: true,
      sameScreen: true,
    });
  }
  expect(displayed.trace[0].screenState).toBe('level_up_wait');
  expect(displayed.trace[1].screenState).toBe('scroll_out');
  expect(displayed.trace[0].statChanges).toEqual({ STR: 2, DEF: -1 });
  expect(displayed.trace[1].statChanges).toEqual(displayed.trace[0].statChanges);
  expect(displayed.atInterrupt).toEqual({
    currentEvent: '_test_event_level_during',
    screenState: 'level_up_wait',
    sameScreen: true,
    actionApplied: true,
    duringStarted: 'yes',
    duringFinished: undefined,
    producerAfter: undefined,
  });
  expect(displayed.atResume).toEqual({
    currentEvent: '_test_event_level_producer',
    screenState: 'level_up_wait',
    sameScreen: true,
    duringFinished: 'yes',
    producerAfter: undefined,
  });
  expect(displayed.final).toEqual({
    duringStarted: 'yes',
    duringFinished: 'yes',
    producerAfter: 'yes',
    lateStarted: 'yes',
    screenPresent: false,
  });

  const immediate = await runEventLevelUpProducer(page, 'set_stats_immediate');
  expect(immediate.trace).toEqual([]);
  expect(immediate.atInterrupt.actionApplied).toBe(true);
  expect(immediate.final).toEqual({
    duringStarted: undefined,
    duringFinished: undefined,
    producerAfter: 'yes',
    lateStarted: undefined,
    screenPresent: false,
  });
});

test('event class change and promotion share the interruptible level screen producer', async ({ page }) => {
  for (const kind of ['class_change', 'promote'] as const) {
    const result = await runEventLevelUpProducer(page, kind);
    expect(result.trace.map((entry) => entry.type)).toEqual([
      'during_unit_level_up',
      'unit_level_up',
    ]);
    for (const entry of result.trace) {
      expect(entry.unitNid).toBe('Eirika');
      expect(entry.source).toBe(kind);
      expect(entry.combatPhase).toBe('event');
      expect(entry.copiedStatChanges).toBe(true);
      expect(entry.sameScreen).toBe(true);
    }
    expect(result.trace[0].screenState).toBe('level_up_wait');
    expect(result.trace[1].screenState).toBe('scroll_out');
    expect(result.trace[1].statChanges).toEqual(result.trace[0].statChanges);
    expect(Object.keys(result.trace[0].statChanges).length).toBeGreaterThan(0);
    expect(result.atInterrupt).toMatchObject({
      currentEvent: '_test_event_level_during',
      screenState: 'level_up_wait',
      sameScreen: true,
      actionApplied: true,
      duringStarted: 'yes',
      duringFinished: undefined,
      producerAfter: undefined,
    });
    expect(result.atResume).toEqual({
      currentEvent: '_test_event_level_producer',
      screenState: 'level_up_wait',
      sameScreen: true,
      duringFinished: 'yes',
      producerAfter: undefined,
    });
    expect(result.final).toEqual({
      duringStarted: 'yes',
      duringFinished: 'yes',
      producerAfter: 'yes',
      lateStarted: 'yes',
      screenPresent: false,
    });
  }
});
