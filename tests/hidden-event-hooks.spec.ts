import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

async function waitForHarness(page: Page): Promise<void> {
  await page.waitForFunction(() => !!(window as any).__harness?.ready, { timeout: 15_000 });
}

async function stepFrames(page: Page, count: number): Promise<void> {
  await page.evaluate((frames) => (window as any).__harness.stepFrames(frames, null), count);
}

type CapturedCall = {
  nid: string;
  type: string;
  unit1: string | null;
  unit2: string | null;
  unitNid: string | null;
  position: [number, number] | null;
  localKeys: string[];
  item: string | null;
  item2: string | null;
  mode: string | null;
};

type ProducerResult = {
  calls: CapturedCall[];
  eventRuns: number;
  parentResumed?: string | null;
  nonAttackQueued?: number;
};

async function openFixture(page: Page): Promise<void> {
  await page.goto('/?harness=true&level=DEBUG&clean=true&bundle=false');
  await waitForHarness(page);
  await stepFrames(page, 5);
}

async function normalCombatProducer(page: Page): Promise<ProducerResult> {
  await page.evaluate(async () => {
    const game = (window as any).__gameRef;
    const { ItemObject } = await import('/src/objects/item.ts');
    const { SkillObject } = await import('/src/objects/skill.ts');
    const { queueAfterInitiatedCombatEvents } = await import('/src/combat/combat-lifecycle.ts');

    const attacker = game.units.get('Eirika');
    const defender = game.units.get('Bone');
    const partner = game.units.get('Seth');
    if (!attacker || !defender || !partner) throw new Error('combat fixture units missing');

    const nids = {
      attacker: '_NormalInitiatedAttacker',
      partner: '_NormalInitiatedPartner',
      defender: '_NormalInitiatedDefender',
      inactive: '_NormalInitiatedInactive',
      item: '_NormalItemEndCombat',
    };
    for (const nid of Object.values(nids)) {
      game.db.events.set(nid, {
        nid,
        name: nid,
        trigger: 'never',
        level_nid: game.currentLevel?.nid ?? null,
        condition: 'False',
        only_once: false,
        priority: 0,
        _source: ['inc_game_var;_normal_hidden_event_runs'],
      });
    }

    const makeSkill = (nid: string, eventNid: string, condition?: string) => new SkillObject({
      nid,
      name: nid,
      desc: '',
      icon_nid: '',
      icon_index: [0, 0],
      components: [
        ['event_after_initiated_combat', eventNid],
        ...(condition ? [['condition', condition]] : []),
      ],
    } as any);
    attacker.skills.push(
      makeSkill('_NormalHookSkill', nids.attacker),
      makeSkill('_NormalInactiveSkill', nids.inactive, 'False'),
    );
    defender.skills.push(makeSkill('_NormalDefenderSkill', nids.defender));
    partner.skills.push(makeSkill('_NormalPartnerSkill', nids.partner));

    const attackItem = new ItemObject({
      nid: '_NormalAttack',
      name: '_NormalAttack',
      desc: '',
      icon_nid: '',
      icon_index: [0, 0],
      components: [
        ['weapon', null], ['weapon_type', 'Sword'], ['weapon_rank', 'E'],
        ['damage', 0], ['hit', 100], ['crit', 0], ['weight', 0],
        ['uses', 99], ['min_range', 1], ['max_range', 1],
        ['event_after_combat_even_miss', nids.item],
      ],
    } as any);
    const defenseItem = new ItemObject({
      nid: '_NormalDefense',
      name: '_NormalDefense',
      desc: '',
      icon_nid: '',
      icon_index: [0, 0],
      components: [
        ['weapon', null], ['weapon_type', 'Sword'], ['weapon_rank', 'E'],
        ['damage', 0], ['hit', 100], ['crit', 0], ['weight', 0],
        ['uses', 99], ['min_range', 1], ['max_range', 1],
      ],
    } as any);
    attackItem.owner = attacker;
    defenseItem.owner = defender;
    attacker.items.unshift(attackItem);
    defender.items.unshift(defenseItem);
    attacker.equippedWeapon = attackItem;
    defender.equippedWeapon = defenseItem;

    for (const unit of [attacker, defender, partner]) {
      if (unit.position) game.board.removeUnit(unit);
      unit.dead = false;
      unit.currentHp = 999;
      unit.stats.HP = 999;
      unit.stats.DEF = 999;
      unit.stats.RES = 999;
    }
    for (const [x, y] of [[2, 2], [3, 2], [2, 3]]) {
      const occupant = game.board.getUnit(x, y);
      if (occupant) game.board.removeUnit(occupant);
    }
    game.board.setUnit(2, 2, attacker);
    game.board.setUnit(3, 2, defender);
    game.board.setUnit(2, 3, partner);
    attacker.strikePartner = partner;
    defender.strikePartner = null;

    game.eventManager.eventQueue.length = 0;
    game.gameVars.delete('_normal_hidden_event_runs');
    const relevant = new Set(Object.values(nids));
    const calls: Array<{ nid: string; trigger: any }> = [];
    const original = game.eventManager.triggerSpecific.bind(game.eventManager);
    game.eventManager.triggerSpecific = (nid: string, trigger: any, force?: boolean) => {
      if (relevant.has(nid)) calls.push({ nid, trigger });
      return original(nid, trigger, force);
    };
    (window as any).__hiddenHookCalls = calls;

    (window as any).__nonAttackQueued = queueAfterInitiatedCombatEvents(
      game, attacker, defender, attackItem, defenseItem, 'defense',
    );

    game.selectedUnit = attacker;
    game.combatTarget = defender;
    game.memory.set('combat_item', attackItem);
    game.memory.set('combat_strike_partners_selected', true);
    game.state.clear();
    game.state.change('combat');
  });

  await stepFrames(page, 1_200);
  return page.evaluate(() => {
    const game = (window as any).__gameRef;
    const calls = ((window as any).__hiddenHookCalls as Array<{ nid: string; trigger: any }>).map(({ nid, trigger }) => ({
      nid,
      type: trigger.type,
      unit1: trigger.unit1?.nid ?? null,
      unit2: trigger.unit2?.nid ?? null,
      unitNid: trigger.unitNid ?? null,
      position: trigger.position ?? null,
      localKeys: trigger.localArgs ? [...trigger.localArgs.keys()] : [],
      item: trigger.localArgs?.get('item')?.nid ?? null,
      item2: trigger.localArgs?.get('item2')?.nid ?? null,
      mode: trigger.localArgs?.get('mode') ?? null,
    }));
    return {
      calls,
      eventRuns: Number(game.gameVars.get('_normal_hidden_event_runs') ?? 0),
      nonAttackQueued: (window as any).__nonAttackQueued,
    };
  });
}

async function immediateScriptedProducer(page: Page): Promise<ProducerResult> {
  await page.evaluate(async () => {
    const game = (window as any).__gameRef;
    const { ItemObject } = await import('/src/objects/item.ts');
    const { SkillObject } = await import('/src/objects/skill.ts');

    const attacker = game.units.get('Eirika');
    const defender = game.units.get('Bone');
    const partner = game.units.get('Seth');
    if (!attacker || !defender || !partner) throw new Error('combat fixture units missing');

    const nids = {
      attacker: '_ImmediateInitiatedAttacker',
      partner: '_ImmediateInitiatedPartner',
      defender: '_ImmediateInitiatedDefender',
      item: '_ImmediateItemEndCombat',
      parent: '_ImmediateCombatParent',
    };
    for (const nid of [nids.attacker, nids.partner, nids.defender, nids.item]) {
      game.db.events.set(nid, {
        nid,
        name: nid,
        trigger: 'never',
        level_nid: game.currentLevel?.nid ?? null,
        condition: 'False',
        only_once: false,
        priority: 0,
        _source: ['inc_game_var;_immediate_hidden_event_runs'],
      });
    }
    game.db.events.set(nids.parent, {
      nid: nids.parent,
      name: nids.parent,
      trigger: 'never',
      level_nid: game.currentLevel?.nid ?? null,
      condition: 'False',
      only_once: false,
      priority: 0,
      _source: [
        `interact_unit;${attacker.nid};${defender.nid};hit1,end;_ImmediateAttack;immediate`,
        'game_var;_immediate_parent_resumed;yes',
      ],
    });

    const makeSkill = (nid: string, eventNid: string) => new SkillObject({
      nid,
      name: nid,
      desc: '',
      icon_nid: '',
      icon_index: [0, 0],
      components: [['event_after_initiated_combat', eventNid]],
    } as any);
    attacker.skills.push(makeSkill('_ImmediateHookSkill', nids.attacker));
    defender.skills.push(makeSkill('_ImmediateDefenderSkill', nids.defender));
    partner.skills.push(makeSkill('_ImmediatePartnerSkill', nids.partner));

    const attackItem = new ItemObject({
      nid: '_ImmediateAttack',
      name: '_ImmediateAttack',
      desc: '',
      icon_nid: '',
      icon_index: [0, 0],
      components: [
        ['weapon', null], ['weapon_type', 'Sword'], ['weapon_rank', 'E'],
        ['damage', 0], ['hit', 100], ['crit', 0], ['weight', 0],
        ['uses', 99], ['min_range', 1], ['max_range', 1],
        ['event_after_combat_even_miss', nids.item],
      ],
    } as any);
    const defenseItem = new ItemObject({
      nid: '_ImmediateDefense',
      name: '_ImmediateDefense',
      desc: '',
      icon_nid: '',
      icon_index: [0, 0],
      components: [
        ['weapon', null], ['weapon_type', 'Sword'], ['weapon_rank', 'E'],
        ['damage', 0], ['hit', 100], ['crit', 0], ['weight', 0],
        ['uses', 99], ['min_range', 1], ['max_range', 1],
      ],
    } as any);
    attackItem.owner = attacker;
    defenseItem.owner = defender;
    attacker.items.unshift(attackItem);
    defender.items.unshift(defenseItem);
    attacker.equippedWeapon = attackItem;
    defender.equippedWeapon = defenseItem;

    for (const unit of [attacker, defender, partner]) {
      if (unit.position) game.board.removeUnit(unit);
      unit.dead = false;
      unit.currentHp = 999;
      unit.stats.HP = 999;
      unit.stats.DEF = 999;
      unit.stats.RES = 999;
    }
    for (const [x, y] of [[2, 2], [3, 2], [2, 3]]) {
      const occupant = game.board.getUnit(x, y);
      if (occupant) game.board.removeUnit(occupant);
    }
    game.board.setUnit(2, 2, attacker);
    game.board.setUnit(3, 2, defender);
    game.board.setUnit(2, 3, partner);
    attacker.strikePartner = partner;
    defender.strikePartner = null;

    game.eventManager.eventQueue.length = 0;
    game.gameVars.delete('_immediate_hidden_event_runs');
    game.gameVars.delete('_immediate_parent_resumed');
    const relevant = new Set([nids.attacker, nids.partner, nids.defender, nids.item]);
    const calls: Array<{ nid: string; trigger: any }> = [];
    const original = game.eventManager.triggerSpecific.bind(game.eventManager);
    game.eventManager.triggerSpecific = (nid: string, trigger: any, force?: boolean) => {
      if (relevant.has(nid)) calls.push({ nid, trigger });
      return original(nid, trigger, force);
    };
    (window as any).__hiddenHookCalls = calls;

    original(nids.parent, { type: nids.parent }, true);
    game.state.clear();
    game.state.change('event');
  });

  await stepFrames(page, 300);
  return page.evaluate(() => {
    const game = (window as any).__gameRef;
    const calls = ((window as any).__hiddenHookCalls as Array<{ nid: string; trigger: any }>).map(({ nid, trigger }) => ({
      nid,
      type: trigger.type,
      unit1: trigger.unit1?.nid ?? null,
      unit2: trigger.unit2?.nid ?? null,
      unitNid: trigger.unitNid ?? null,
      position: trigger.position ?? null,
      localKeys: trigger.localArgs ? [...trigger.localArgs.keys()] : [],
      item: trigger.localArgs?.get('item')?.nid ?? null,
      item2: trigger.localArgs?.get('item2')?.nid ?? null,
      mode: trigger.localArgs?.get('mode') ?? null,
    }));
    return {
      calls,
      eventRuns: Number(game.gameVars.get('_immediate_hidden_event_runs') ?? 0),
      parentResumed: game.gameVars.get('_immediate_parent_resumed') ?? null,
    };
  });
}

test('hidden initiated-combat hooks preserve Python payload, ordering, partners, and scripted resume', async ({ page }) => {
  await openFixture(page);
  const normal = await normalCombatProducer(page);

  expect(normal.nonAttackQueued).toBe(0);
  expect(normal.calls.map((call) => call.nid)).toEqual([
    '_NormalInitiatedAttacker',
    '_NormalInitiatedPartner',
    '_NormalItemEndCombat',
  ]);
  expect(normal.calls.slice(0, 2)).toEqual([
    {
      nid: '_NormalInitiatedAttacker',
      type: 'event_after_initiated_combat',
      unit1: 'Eirika',
      unit2: 'Bone',
      unitNid: 'Eirika',
      position: [2, 2],
      localKeys: ['item', 'item2', 'mode'],
      item: '_NormalAttack',
      item2: '_NormalDefense',
      mode: 'attack',
    },
    {
      nid: '_NormalInitiatedPartner',
      type: 'event_after_initiated_combat',
      unit1: 'Seth',
      unit2: 'Bone',
      unitNid: 'Seth',
      position: [2, 3],
      localKeys: ['item', 'item2', 'mode'],
      item: '_NormalAttack',
      item2: '_NormalDefense',
      mode: 'attack',
    },
  ]);
  expect(normal.eventRuns).toBe(3);

  await openFixture(page);
  const immediate = await immediateScriptedProducer(page);

  expect(immediate.calls.map((call) => call.nid)).toEqual([
    '_ImmediateInitiatedAttacker',
    '_ImmediateInitiatedPartner',
    '_ImmediateItemEndCombat',
  ]);
  expect(immediate.calls.slice(0, 2)).toEqual([
    {
      nid: '_ImmediateInitiatedAttacker',
      type: 'event_after_initiated_combat',
      unit1: 'Eirika',
      unit2: 'Bone',
      unitNid: 'Eirika',
      position: [2, 2],
      localKeys: ['item', 'item2', 'mode'],
      item: '_ImmediateAttack',
      item2: '_ImmediateDefense',
      mode: 'attack',
    },
    {
      nid: '_ImmediateInitiatedPartner',
      type: 'event_after_initiated_combat',
      unit1: 'Seth',
      unit2: 'Bone',
      unitNid: 'Seth',
      position: [2, 3],
      localKeys: ['item', 'item2', 'mode'],
      item: '_ImmediateAttack',
      item2: '_ImmediateDefense',
      mode: 'attack',
    },
  ]);
  expect(immediate.eventRuns).toBe(3);
  expect(immediate.parentResumed).toBe('yes');
});

test('remove-skill hook fires once after true removal and event command resumes', async ({ page }) => {
  await openFixture(page);

  const immediate = await page.evaluate(async () => {
    const game = (window as any).__gameRef;
    const { SkillObject } = await import('/src/objects/skill.ts');
    const { RemoveSkillAction } = await import('/src/engine/action.ts');
    const unit = game.units.get('Eirika');
    if (!unit) throw new Error('remove-skill fixture unit missing');

    const directEventNid = '_RemoveSkillDirectEvent';
    const scriptedEventNid = '_RemoveSkillScriptedEvent';
    const parentEventNid = '_RemoveSkillParentEvent';
    const missingEventNid = '_RemoveSkillMissingEvent';
    for (const [nid, source] of [
      [directEventNid, ['inc_game_var;_remove_direct_event_runs']],
      [scriptedEventNid, ['inc_game_var;_remove_scripted_event_runs']],
      [parentEventNid, [
        'remove_skill;Eirika;_RemoveScriptedSkill;no_banner',
        'game_var;_remove_parent_resumed;yes',
      ]],
    ] as Array<[string, string[]]>) {
      game.db.events.set(nid, {
        nid,
        name: nid,
        trigger: 'never',
        level_nid: game.currentLevel?.nid ?? null,
        condition: 'False',
        only_once: false,
        priority: 0,
        _source: source,
      });
    }

    const makeSkill = (nid: string, eventNid?: string) => new SkillObject({
      nid,
      name: nid,
      desc: '',
      icon_nid: '',
      icon_index: [0, 0],
      components: eventNid ? [['event_on_remove', eventNid]] : [],
    } as any);
    const unrelatedSkill = makeSkill('_RemoveUnrelatedSkill');
    const directSkill = makeSkill('_RemoveDirectSkill', directEventNid);
    const missingEventSkill = makeSkill('_RemoveMissingEventSkill', missingEventNid);
    unit.skills.push(unrelatedSkill, directSkill, missingEventSkill);
    const directIndex = unit.skills.indexOf(directSkill);

    game.eventManager.eventQueue.length = 0;
    game.gameVars.delete('_remove_direct_event_runs');
    game.gameVars.delete('_remove_scripted_event_runs');
    game.gameVars.delete('_remove_parent_resumed');
    game.actionLog.clear();

    const calls: Array<{
      nid: string;
      trigger: any;
      removedSkillAbsent: boolean;
    }> = [];
    const originalTriggerSpecific = game.eventManager.triggerSpecific.bind(game.eventManager);
    game.eventManager.triggerSpecific = (nid: string, trigger: any, force?: boolean) => {
      const removedNid = nid === directEventNid
        ? directSkill.nid
        : nid === scriptedEventNid
          ? '_RemoveScriptedSkill'
          : missingEventSkill.nid;
      calls.push({
        nid,
        trigger,
        removedSkillAbsent: !unit.skills.some((skill: any) => skill.nid === removedNid),
      });
      return originalTriggerSpecific(nid, trigger, force);
    };

    const removeActions: any[] = [];
    const originalDoAction = game.actionLog.doAction.bind(game.actionLog);
    game.actionLog.doAction = (action: any) => {
      if (action instanceof RemoveSkillAction) removeActions.push(action);
      originalDoAction(action);
    };

    const directAction = new RemoveSkillAction(unit, directSkill);
    game.actionLog.doAction(directAction);
    const callsAfterFirstDo = calls.length;
    const absentAfterDo = !unit.skills.includes(directSkill);

    const undoneAction = game.actionLog.undo();
    const callsAfterUndo = calls.length;
    const exactSkillRestored = undoneAction === directAction &&
      unit.skills[directIndex] === directSkill;

    directAction.execute();
    const callsAfterRedo = calls.length;
    const absentAfterRedo = !unit.skills.includes(directSkill);

    game.actionLog.doAction(new RemoveSkillAction(unit, unrelatedSkill));
    game.actionLog.doAction(new RemoveSkillAction(unit, missingEventSkill));
    const removalActionsBeforeParent = removeActions.length;

    const scriptedSkill = makeSkill('_RemoveScriptedSkill', scriptedEventNid);
    unit.skills.push(scriptedSkill);
    originalTriggerSpecific(parentEventNid, { type: parentEventNid }, true);
    game.state.clear();
    game.state.change('event');

    (window as any).__removeSkillHookResult = {
      calls,
      removeActions,
      removalActionsBeforeParent,
      directAction,
      scriptedSkill,
    };
    return {
      callsAfterFirstDo,
      callsAfterUndo,
      callsAfterRedo,
      absentAfterDo,
      exactSkillRestored,
      absentAfterRedo,
    };
  });

  expect(immediate).toEqual({
    callsAfterFirstDo: 1,
    callsAfterUndo: 1,
    callsAfterRedo: 1,
    absentAfterDo: true,
    exactSkillRestored: true,
    absentAfterRedo: true,
  });

  await stepFrames(page, 400);
  const completed = await page.evaluate(() => {
    const game = (window as any).__gameRef;
    const result = (window as any).__removeSkillHookResult;
    return {
      calls: result.calls.map((call: any) => ({
        nid: call.nid,
        type: call.trigger.type,
        unit1: call.trigger.unit1?.nid ?? null,
        triggerKeys: Object.keys(call.trigger).sort(),
        removedSkillAbsent: call.removedSkillAbsent,
      })),
      scriptedRemovalActions:
        result.removeActions.length - result.removalActionsBeforeParent,
      scriptedSkillAbsent: !game.units.get('Eirika').skills.includes(result.scriptedSkill),
      directRuns: Number(game.gameVars.get('_remove_direct_event_runs') ?? 0),
      scriptedRuns: Number(game.gameVars.get('_remove_scripted_event_runs') ?? 0),
      parentResumed: game.gameVars.get('_remove_parent_resumed') ?? null,
    };
  });

  expect(completed).toEqual({
    calls: [
      {
        nid: '_RemoveSkillDirectEvent',
        type: 'event_on_remove',
        unit1: 'Eirika',
        triggerKeys: ['type', 'unit1'],
        removedSkillAbsent: true,
      },
      {
        nid: '_RemoveSkillScriptedEvent',
        type: 'event_on_remove',
        unit1: 'Eirika',
        triggerKeys: ['type', 'unit1'],
        removedSkillAbsent: true,
      },
    ],
    scriptedRemovalActions: 1,
    scriptedSkillAbsent: true,
    directRuns: 1,
    scriptedRuns: 1,
    parentResumed: 'yes',
  });
});
