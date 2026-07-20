import { test, expect, type Page } from '@playwright/test';

/**
 * Zero-usage command batch 1 (P1 completeness): set_skill_data, set_mode_rng,
 * set_mode_autolevels, show_minimap, set_game_board_bounds,
 * remove_game_board_bounds, dump_vars, delete_save.
 *
 * Python references: event_functions.py:2158 (set_skill_data), :2382
 * (set_mode_rng), :2367 (set_mode_autolevels), :3532 (show_minimap), :890/:901
 * (board bounds), :3996 (dump_vars), :769 (delete_save).
 */

async function waitForHarness(page: Page): Promise<void> {
  await page.waitForFunction(() => (window as any).__harness?.ready === true, undefined, {
    timeout: 30_000,
  });
}

async function stepFrames(page: Page, n: number, input?: string): Promise<void> {
  await page.evaluate(
    ({ n, input }) => (window as any).__harness.stepFrames(n, input),
    { n, input },
  );
}

/** Install a level-scoped event and run it to completion. */
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
  await stepFrames(page, 30);
}

async function boot(page: Page): Promise<void> {
  await page.goto('/?harness=true&level=0&clean=true&bundle=false');
  await waitForHarness(page);
  await stepFrames(page, 3);
}

test.describe('Event command batch 3 (zero-usage completeness)', () => {
  test('set_skill_data sets a skill data key reversibly', async ({ page }) => {
    await boot(page);
    // Prologue Eirika starts skill-less; grant one from the DB first.
    const skillNid = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      return [...g.db.skills.keys()][0] ?? null;
    });
    expect(skillNid).not.toBeNull();
    await runEvent(page, 'TestGrantSkill', [`give_skill;Eirika;${skillNid};no_banner`]);
    const hasSkill = await page.evaluate(
      (nid: string) => !!(window as any).__gameRef.units.get('Eirika').skills.find((s: any) => s.nid === nid),
      skillNid,
    );
    expect(hasSkill).toBe(true);
    await runEvent(page, 'TestSetSkillData', [
      `set_skill_data;Eirika;${skillNid};charge;5`,
    ]);
    const result = await page.evaluate((skillNid: string) => {
      const g = (window as any).__gameRef;
      const skill = g.units.get('Eirika').skills.find((s: any) => s.nid === skillNid);
      const value = skill.data.get('charge');
      const undone = (window as any).__harness.turnwheelUndo();
      const afterUndo = skill.data.has('charge');
      return { value, undone, afterUndo };
    }, skillNid);
    expect(result.value).toBe(5);
    expect(result.undone).toBe(true);
    expect(result.afterUndo).toBe(false);
  });

  test('set_mode_rng changes the difficulty mode rng and rejects invalid options', async ({ page }) => {
    await boot(page);
    await runEvent(page, 'TestSetRng', ['set_mode_rng;grandmaster']);
    let mode = await page.evaluate(() => (window as any).__gameRef.currentMode?.rng_mode);
    expect(mode).toBe('grandmaster');
    await runEvent(page, 'TestSetRngBad', ['set_mode_rng;bogus_mode']);
    mode = await page.evaluate(() => (window as any).__gameRef.currentMode?.rng_mode);
    expect(mode).toBe('grandmaster'); // unchanged on invalid input
  });

  test('set_mode_autolevels routes hidden/boss flags to the right fields', async ({ page }) => {
    await boot(page);
    await runEvent(page, 'TestAutolevels', [
      'set_mode_autolevels;3',
      'set_mode_autolevels;4;hidden',
      'set_mode_autolevels;5;boss',
      'set_mode_autolevels;6;hidden;boss',
    ]);
    const m = await page.evaluate(() => {
      const cm = (window as any).__gameRef.currentMode;
      return {
        enemyTrue: cm.enemyTruelevels,
        enemyAuto: cm.enemyAutolevels,
        bossTrue: cm.bossTruelevels,
        bossAuto: cm.bossAutolevels,
      };
    });
    expect(m).toEqual({ enemyTrue: 3, enemyAuto: 4, bossTrue: 5, bossAuto: 6 });
  });

  test('show_minimap blocks the event on the minimap state and resumes on close', async ({ page }) => {
    await boot(page);
    await page.evaluate(() => {
      const g = (window as any).__gameRef;
      g.db.events.set('TestMinimap', {
        name: 'TestMinimap', nid: 'TestMinimap', trigger: 'TestMinimap',
        level_nid: g.currentLevel?.nid ?? null,
        condition: 'True', only_once: false, priority: 0,
        _source: ['show_minimap', 'game_var;after_minimap;yes'],
      });
      g.eventManager.triggerSpecific('TestMinimap', { type: 'TestMinimap' }, true);
      g.state.change('event');
    });
    await stepFrames(page, 25); // let the minimap arrive transition finish
    const mid = await page.evaluate(() => ({
      state: (window as any).__gameRef.state.getCurrentState()?.name,
      after: (window as any).__gameRef.gameVars.get('after_minimap'),
    }));
    expect(mid.state).toBe('minimap');
    expect(mid.after).toBeUndefined();
    // Close the minimap; the event should resume and run the next command.
    await stepFrames(page, 1, 'BACK');
    await stepFrames(page, 40); // exit transition + event resume
    const after = await page.evaluate(() => (window as any).__gameRef.gameVars.get('after_minimap'));
    expect(after).toBe('yes');
  });

  test('set_game_board_bounds restricts movement and undoes; remove restores natural bounds', async ({ page }) => {
    await boot(page);
    const before = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      return { bounds: [...g.board.bounds], moves: (window as any).__harness ? g.pathSystem?.getValidMoves?.(g.units.get('Eirika'), g.board)?.length ?? -1 : -1 };
    });
    await runEvent(page, 'TestBounds', ['set_game_board_bounds;0;0;3;3']);
    const constrained = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const moves = g.pathSystem?.getValidMoves?.(g.units.get('Eirika'), g.board) ?? [];
      return {
        bounds: [...g.board.bounds],
        outOfBounds: moves.filter((m: [number, number]) => m[0] > 3 || m[1] > 3).length,
      };
    });
    expect(constrained.bounds).toEqual([0, 0, 3, 3]);
    expect(constrained.outOfBounds).toBe(0);
    // Turnwheel undo restores the previous bounds.
    const undone = await page.evaluate(() => {
      const ok = (window as any).__harness.turnwheelUndo();
      return { ok, bounds: [...(window as any).__gameRef.board.bounds] };
    });
    expect(undone.ok).toBe(true);
    expect(undone.bounds).toEqual(before.bounds);
    // And remove_game_board_bounds resets to natural after another set.
    await runEvent(page, 'TestBounds2', [
      'set_game_board_bounds;1;1;4;4',
      'remove_game_board_bounds',
    ]);
    const natural = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      return { bounds: [...g.board.bounds], w: g.tilemap.width, h: g.tilemap.height };
    });
    expect(natural.bounds).toEqual([0, 0, natural.w - 1, natural.h - 1]);
  });

  test('board bounds persist through save/load', async ({ page }) => {
    await boot(page);
    await runEvent(page, 'TestBoundsSave', ['set_game_board_bounds;0;0;5;5']);
    const result = await page.evaluate(async () => {
      const h = (window as any).__harness;
      const g = (window as any).__gameRef;
      const snap = h.saveSnapshot();
      g.board.resetBounds();
      const loaded = await h.loadSnapshot(snap);
      return { loaded: !!loaded, bounds: [...g.board.bounds] };
    });
    expect(result.bounds).toEqual([0, 0, 5, 5]);
  });

  test('dump_vars logs game and level vars without disturbing the event', async ({ page }) => {
    await boot(page);
    const logs: string[] = [];
    page.on('console', (msg) => {
      if (msg.text().includes('[dump_vars]')) logs.push(msg.text());
    });
    await runEvent(page, 'TestDump', [
      'game_var;dump_probe;42',
      'dump_vars',
      'game_var;after_dump;yes',
    ]);
    const after = await page.evaluate(() => (window as any).__gameRef.gameVars.get('after_dump'));
    expect(after).toBe('yes');
    expect(logs.length).toBeGreaterThanOrEqual(2); // game_vars + level_vars lines
    expect(logs.some((l) => l.includes('dump_probe'))).toBe(true);
  });

  test('delete_save removes a saved slot', async ({ page }) => {
    await boot(page);
    const saved = await page.evaluate(async () => {
      const g = (window as any).__gameRef;
      const saveModule = await import('/src/engine/save.ts');
      // Create a real save in slot 7, confirm it loads, then delete via command.
      await saveModule.saveGame(g, 7);
      return saveModule.loadGame(g, 7);
    });
    expect(saved).toBe(true);
    await runEvent(page, 'TestDeleteSave', ['delete_save;7']);
    // Give the async deletion a moment, then verify the slot is gone.
    await page.waitForTimeout(500);
    const loadedAfter = await page.evaluate(async () => {
      const g = (window as any).__gameRef;
      const saveModule = await import('/src/engine/save.ts');
      return saveModule.loadGame(g, 7).catch(() => false);
    });
    expect(loadedAfter).toBe(false);
  });
});

test.describe('Event command batch 3b (open_* menu commands)', () => {
  test('records_screen pauses into base_records and resumes on close', async ({ page }) => {
    await boot(page);
    await page.evaluate(() => {
      const g = (window as any).__gameRef;
      g.db.events.set('TestRecords', {
        name: 'TestRecords', nid: 'TestRecords', trigger: 'TestRecords',
        level_nid: g.currentLevel?.nid ?? null,
        condition: 'True', only_once: false, priority: 0,
        _source: ['records_screen', 'game_var;after_records;yes'],
      });
      g.eventManager.triggerSpecific('TestRecords', { type: 'TestRecords' }, true);
      g.state.change('event');
    });
    await stepFrames(page, 8);
    const mid = await page.evaluate(() => (window as any).__gameRef.state.getCurrentState()?.name);
    expect(mid).toBe('base_records');
    await stepFrames(page, 1, 'BACK');
    await stepFrames(page, 20);
    const after = await page.evaluate(() => (window as any).__gameRef.gameVars.get('after_records'));
    expect(after).toBe('yes');
  });

  test('open_library gates on unlocked non-guide lore', async ({ page }) => {
    await boot(page);
    // Without unlocked lore, the command no-ops and the event continues.
    await runEvent(page, 'TestLibNoLore', ['open_library', 'game_var;lib_skipped;yes']);
    const skipped = await page.evaluate(() => (window as any).__gameRef.gameVars.get('lib_skipped'));
    expect(skipped).toBe('yes');
    // Unlock a non-guide lore entry, then the state opens.
    const opened = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const lore = [...(g.db.lore?.values?.() ?? [])].find((l: any) => l.category !== 'Guide');
      if (!lore) return 'no-lore-in-db';
      g.unlockedLore.push(lore.nid);
      g.db.events.set('TestLib2', {
        name: 'TestLib2', nid: 'TestLib2', trigger: 'TestLib2',
        level_nid: g.currentLevel?.nid ?? null,
        condition: 'True', only_once: false, priority: 0,
        _source: ['open_library'],
      });
      g.eventManager.triggerSpecific('TestLib2', { type: 'TestLib2' }, true);
      g.state.change('event');
      return 'ok';
    });
    expect(opened).toBe('ok');
    await stepFrames(page, 8);
    const state = await page.evaluate(() => (window as any).__gameRef.state.getCurrentState()?.name);
    expect(state).toBe('base_library');
  });

  test('open_credits pauses into the credit state', async ({ page }) => {
    await boot(page);
    await page.evaluate(() => {
      const g = (window as any).__gameRef;
      g.db.events.set('TestCredits', {
        name: 'TestCredits', nid: 'TestCredits', trigger: 'TestCredits',
        level_nid: g.currentLevel?.nid ?? null,
        condition: 'True', only_once: false, priority: 0,
        _source: ['open_credits;default_background'],
      });
      g.eventManager.triggerSpecific('TestCredits', { type: 'TestCredits' }, true);
      g.state.change('event');
    });
    await stepFrames(page, 8);
    const state = await page.evaluate(() => (window as any).__gameRef.state.getCurrentState()?.name);
    expect(state).toBe('credit');
  });

  test('soundroom pauses into base_sound_room', async ({ page }) => {
    await boot(page);
    await runEvent(page, 'TestSoundroomPre', ['game_var;pre_sound;yes']);
    await page.evaluate(() => {
      const g = (window as any).__gameRef;
      g.db.events.set('TestSoundroom', {
        name: 'TestSoundroom', nid: 'TestSoundroom', trigger: 'TestSoundroom',
        level_nid: g.currentLevel?.nid ?? null,
        condition: 'True', only_once: false, priority: 0,
        _source: ['soundroom'],
      });
      g.eventManager.triggerSpecific('TestSoundroom', { type: 'TestSoundroom' }, true);
      g.state.change('event');
    });
    await stepFrames(page, 8);
    const state = await page.evaluate(() => (window as any).__gameRef.state.getCurrentState()?.name);
    expect(state).toBe('base_sound_room');
  });

  test('open_trade enters direct item trading between two named units', async ({ page }) => {
    await boot(page);
    await page.evaluate(() => {
      const g = (window as any).__gameRef;
      g.db.events.set('TestTrade', {
        name: 'TestTrade', nid: 'TestTrade', trigger: 'TestTrade',
        level_nid: g.currentLevel?.nid ?? null,
        condition: 'True', only_once: false, priority: 0,
        _source: ['open_trade;Eirika;Seth'],
      });
      g.eventManager.triggerSpecific('TestTrade', { type: 'TestTrade' }, true);
      g.state.change('event');
    });
    await stepFrames(page, 8);
    const result = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const st: any = g.state.getCurrentState();
      return {
        state: st?.name,
        phase: st?.phase ?? null,
        partner: st?.tradePartner?.nid ?? null,
      };
    });
    expect(result.state).toBe('trade');
    expect(result.phase).toBe('select_items');
    expect(result.partner).toBe('Seth');
  });
});

test.describe('Event command batch 3c (roaming + trigger_script)', () => {
  test('change_roaming toggles roam mode and change_roaming_unit assigns/clears', async ({ page }) => {
    await boot(page);
    await runEvent(page, 'TestRoamOn', [
      'change_roaming;true',
      'change_roaming_unit;Eirika',
    ]);
    let info = await page.evaluate(() => ({ ...( window as any).__gameRef.roamInfo }));
    expect(info.roam).toBe(true);
    expect(info.roamUnitNid).toBe('Eirika');
    await runEvent(page, 'TestRoamOff', [
      'change_roaming;false',
      'change_roaming_unit;NoSuchUnit',
    ]);
    info = await page.evaluate(() => ({ ...(window as any).__gameRef.roamInfo }));
    expect(info.roam).toBe(false);
    expect(info.roamUnitNid).toBeNull();
  });

  test('clean_up_roaming removes all on-map units except the roam unit', async ({ page }) => {
    await boot(page);
    await runEvent(page, 'TestRoamCleanup', [
      'change_roaming;true',
      'change_roaming_unit;Eirika',
      'clean_up_roaming',
    ]);
    const result = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const onMap = [...g.units.values()].filter((u: any) => u.position);
      return { count: onMap.length, nids: onMap.map((u: any) => u.nid) };
    });
    expect(result.nids).toEqual(['Eirika']);
  });

  test('trigger_script runs a named sub-event with unit context and resumes the parent', async ({ page }) => {
    await boot(page);
    await page.evaluate(() => {
      const g = (window as any).__gameRef;
      g.db.events.set('SubScript', {
        name: 'A Sub Script', nid: 'SubScript', trigger: 'SubScript',
        level_nid: g.currentLevel?.nid ?? null,
        condition: 'True', only_once: false, priority: 0,
        _source: ['game_var;sub_ran;yes', 'game_var;sub_unit;{e:unit1}'],
      });
    });
    await runEvent(page, 'TestTriggerScript', [
      'game_var;parent_before;yes',
      'trigger_script;SubScript;Eirika',
      'game_var;parent_after;yes',
    ]);
    await stepFrames(page, 20);
    const vars = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      return {
        before: g.gameVars.get('parent_before'),
        sub: g.gameVars.get('sub_ran'),
        after: g.gameVars.get('parent_after'),
      };
    });
    expect(vars.before).toBe('yes');
    expect(vars.sub).toBe('yes');
    expect(vars.after).toBe('yes');
  });

  test('trigger_script_with_args passes parsed local args to the sub-event', async ({ page }) => {
    await boot(page);
    await page.evaluate(() => {
      const g = (window as any).__gameRef;
      g.db.events.set('SubArgs', {
        name: 'SubArgs', nid: 'SubArgs', trigger: 'SubArgs',
        level_nid: g.currentLevel?.nid ?? null,
        condition: 'True', only_once: false, priority: 0,
        _source: ['game_var;got_arg;{e:reward}'],
      });
    });
    await runEvent(page, 'TestTriggerArgs', [
      'trigger_script_with_args;SubArgs;reward=Iron_Sword',
    ]);
    await stepFrames(page, 20);
    const got = await page.evaluate(() => (window as any).__gameRef.gameVars.get('got_arg'));
    expect(got).toBe('Iron_Sword');
  });
});

test.describe('Event command batch 3d (component modification)', () => {
  test('add/modify/remove_item_component mutate reversibly', async ({ page }) => {
    await boot(page);
    const itemNid = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      return g.units.get('Eirika').items[0]?.nid ?? null;
    });
    expect(itemNid).not.toBeNull();
    await runEvent(page, 'TestItemComp', [
      `add_item_component;Eirika;${itemNid};crit;15`,
      `modify_item_component;Eirika;${itemNid};crit;10;additive`,
    ]);
    const after = await page.evaluate((itemNid: string) => {
      const g = (window as any).__gameRef;
      const item = g.units.get('Eirika').items.find((i: any) => i.nid === itemNid);
      return item.components.get('crit');
    }, itemNid);
    expect(after).toBe(25);
    await runEvent(page, 'TestItemCompRm', [`remove_item_component;Eirika;${itemNid};crit`]);
    const result = await page.evaluate((itemNid: string) => {
      const g = (window as any).__gameRef;
      const item = g.units.get('Eirika').items.find((i: any) => i.nid === itemNid);
      const removed = !item.components.has('crit');
      // Turnwheel: undo remove -> 25; undo modify -> 15; undo add -> absent
      const h = (window as any).__harness;
      h.turnwheelUndo();
      const afterUndoRemove = item.components.get('crit');
      h.turnwheelUndo();
      const afterUndoModify = item.components.get('crit');
      h.turnwheelUndo();
      const afterUndoAdd = item.components.has('crit');
      return { removed, afterUndoRemove, afterUndoModify, afterUndoAdd };
    }, itemNid);
    expect(result.removed).toBe(true);
    expect(result.afterUndoRemove).toBe(25);
    expect(result.afterUndoModify).toBe(15);
    expect(result.afterUndoAdd).toBe(false);
  });

  test('add/modify/remove_skill_component with stack flag hits all instances', async ({ page }) => {
    await boot(page);
    const skillNid = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      return [...g.db.skills.keys()][0] ?? null;
    });
    expect(skillNid).not.toBeNull();
    // Grant two stacked instances.
    await runEvent(page, 'TestSkillGrant', [
      `give_skill;Eirika;${skillNid};no_banner`,
      `give_skill;Eirika;${skillNid};no_banner`,
    ]);
    await runEvent(page, 'TestSkillComp', [
      `add_skill_component;Eirika;${skillNid};charges;3;stack`,
      `modify_skill_component;Eirika;${skillNid};charges;2;additive;stack`,
    ]);
    const values = await page.evaluate((skillNid: string) => {
      const g = (window as any).__gameRef;
      return g.units.get('Eirika').skills
        .filter((s: any) => s.nid === skillNid)
        .map((s: any) => s.components.get('charges'));
    }, skillNid);
    expect(values.length).toBeGreaterThanOrEqual(1);
    for (const v of values) expect(v).toBe(5);
    await runEvent(page, 'TestSkillCompRm', [
      `remove_skill_component;Eirika;${skillNid};charges;stack`,
    ]);
    const removed = await page.evaluate((skillNid: string) => {
      const g = (window as any).__gameRef;
      return g.units.get('Eirika').skills
        .filter((s: any) => s.nid === skillNid)
        .every((s: any) => !s.components.has('charges'));
    }, skillNid);
    expect(removed).toBe(true);
  });
});

test.describe('Event command batch 3e (recruit_generic, merge_parties, loop_units)', () => {
  test('recruit_generic converts a generic to a persistent named unit reversibly', async ({ page }) => {
    await boot(page);
    const genericNid = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const generic = [...g.units.values()].find((u: any) => u.generic);
      return generic?.nid ?? null;
    });
    expect(genericNid).not.toBeNull();
    await runEvent(page, 'TestRecruitGen', [
      `recruit_generic;${genericNid};Rebecca;Rebecca`,
    ]);
    const result = await page.evaluate((oldNid: string) => {
      const g = (window as any).__gameRef;
      const unit = g.units.get('Rebecca');
      const state = unit ? {
        exists: true, name: unit.name, persistent: unit.persistent,
        oldGone: !g.units.has(oldNid),
      } : { exists: false };
      const undone = (window as any).__harness.turnwheelUndo();
      return {
        ...state, undone,
        restoredOld: g.units.has(oldNid),
        newGone: !g.units.has('Rebecca'),
      };
    }, genericNid);
    expect(result.exists).toBe(true);
    expect(result.name).toBe('Rebecca');
    expect(result.persistent).toBe(true);
    expect(result.oldGone).toBe(true);
    expect(result.undone).toBe(true);
    expect(result.restoredOld).toBe(true);
    expect(result.newGone).toBe(true);
  });

  test('merge_parties moves units, convoy, money, and bexp reversibly', async ({ page }) => {
    await boot(page);
    const setup = await page.evaluate(async () => {
      const g = (window as any).__gameRef;
      const { PartyObject } = await import('/src/engine/party.ts');
      const { ItemObject } = await import('/src/objects/item.ts');
      const hostNid = [...g.parties.keys()][0];
      const guest = new PartyObject('GuestParty', 'Guests', 'Seth', 500, 30);
      const prefab = g.db.items.get('Iron_Sword') ?? [...g.db.items.values()][0];
      guest.convoy.push(new ItemObject(prefab));
      g.parties.set('GuestParty', guest);
      const seth = g.units.get('Seth');
      seth.party = 'GuestParty';
      const host = g.parties.get(hostNid);
      return { hostNid, hostMoney: host.money, hostConvoy: host.convoy.length };
    });
    await runEvent(page, 'TestMerge', [`merge_parties;${setup.hostNid};GuestParty`]);
    const merged = await page.evaluate((s: any) => {
      const g = (window as any).__gameRef;
      const host = g.parties.get(s.hostNid);
      const guest = g.parties.get('GuestParty');
      return {
        sethParty: g.units.get('Seth').party,
        hostMoney: host.money, guestMoney: guest.money,
        hostConvoyGain: host.convoy.length - s.hostConvoy,
        guestConvoy: guest.convoy.length,
        hostBexp: host.bexp,
      };
    }, setup);
    expect(merged.sethParty).toBe(setup.hostNid);
    expect(merged.hostMoney).toBe(setup.hostMoney + 500);
    expect(merged.guestMoney).toBe(0);
    expect(merged.hostConvoyGain).toBe(1);
    expect(merged.guestConvoy).toBe(0);
    const undone = await page.evaluate((s: any) => {
      const g = (window as any).__gameRef;
      const ok = (window as any).__harness.turnwheelUndo();
      const host = g.parties.get(s.hostNid);
      const guest = g.parties.get('GuestParty');
      return {
        ok, sethParty: g.units.get('Seth').party,
        hostMoney: host.money, guestMoney: guest.money, guestConvoy: guest.convoy.length,
      };
    }, setup);
    expect(undone.ok).toBe(true);
    expect(undone.sethParty).toBe('GuestParty');
    expect(undone.hostMoney).toBe(setup.hostMoney);
    expect(undone.guestMoney).toBe(500);
    expect(undone.guestConvoy).toBe(1);
  });

  test('loop_units runs the target event once per listed unit in order', async ({ page }) => {
    await boot(page);
    await page.evaluate(() => {
      const g = (window as any).__gameRef;
      g.gameVars.set('loop_log', '');
      g.db.events.set('LoopBody', {
        name: 'LoopBody', nid: 'LoopBody', trigger: 'LoopBody',
        level_nid: g.currentLevel?.nid ?? null,
        condition: 'True', only_once: false, priority: 0,
        _source: ['game_var;loop_{e:unit1.nid};yes'],
      });
    });
    await runEvent(page, 'TestLoopUnits', [
      'loop_units;Eirika,Seth;LoopBody',
      'game_var;loop_done;yes',
    ]);
    await stepFrames(page, 30);
    const vars = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      return {
        eirika: g.gameVars.get('loop_Eirika'),
        seth: g.gameVars.get('loop_Seth'),
        done: g.gameVars.get('loop_done'),
      };
    });
    expect(vars.done).toBe('yes');
    expect(vars.eirika).toBe('yes');
    expect(vars.seth).toBe('yes');
  });
});

test.describe('Event command batch 3f (fatigue + region generics)', () => {
  test('add_fatigue accumulates with floor 0, undoes, and persists', async ({ page }) => {
    await boot(page);
    await runEvent(page, 'TestFatigue', [
      'add_fatigue;Eirika;5',
      'add_fatigue;Eirika;-99',
      'add_fatigue;Eirika;3',
    ]);
    const result = await page.evaluate(async () => {
      const g = (window as any).__gameRef;
      const h = (window as any).__harness;
      const now = g.units.get('Eirika').currentFatigue;
      // Undo against the live action log first (undoing after a snapshot
      // restore would target stale pre-restore objects).
      h.turnwheelUndo();
      const afterUndo = g.units.get('Eirika').currentFatigue;
      // Then prove save/load round-trips the field.
      g.units.get('Eirika').currentFatigue = 7;
      const snap = h.saveSnapshot();
      g.units.get('Eirika').currentFatigue = 0;
      await h.loadSnapshot(snap);
      const restored = g.units.get('Eirika').currentFatigue;
      return { now, afterUndo, restored };
    });
    expect(result.now).toBe(3);       // 5 -> floor 0 -> +3
    expect(result.afterUndo).toBe(0); // undo the +3 back to the floored 0
    expect(result.restored).toBe(7);
  });

  test('remove_generics_from_region off-maps generics inside the region only', async ({ page }) => {
    await boot(page);
    const setup = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      // Place one generic inside a synthetic region and Eirika inside it too.
      const generic = [...g.units.values()].find((u: any) => u.generic && u.position);
      if (!generic) return null;
      g.board.removeUnit(generic);
      generic.position = [2, 2];
      g.board.setUnit(2, 2, generic);
      const eirika = g.units.get('Eirika');
      g.board.removeUnit(eirika);
      eirika.position = [3, 2];
      g.board.setUnit(3, 2, eirika);
      g.currentLevel.regions.push({
        nid: 'TestZone', region_type: 'normal', position: [2, 2], size: [2, 1],
        sub_nid: '', condition: 'True', only_once: false, interrupt_move: false,
      });
      return { genericNid: generic.nid };
    });
    expect(setup).not.toBeNull();
    await runEvent(page, 'TestRemoveGenerics', ['remove_generics_from_region;TestZone']);
    const result = await page.evaluate((genericNid: string) => {
      const g = (window as any).__gameRef;
      const genericPos = g.units.get(genericNid)?.position ?? null;
      const eirikaPos = g.units.get('Eirika').position;
      const undone = (window as any).__harness.turnwheelUndo();
      const restoredPos = g.units.get(genericNid)?.position ?? null;
      return { genericPos, eirikaPos, undone, restoredPos };
    }, setup!.genericNid);
    expect(result.genericPos).toBeNull();      // generic removed
    expect(result.eirikaPos).toEqual([3, 2]);  // named unit untouched
    expect(result.undone).toBe(true);
    expect(result.restoredPos).toEqual([2, 2]);
  });
});

test.describe('Event command batch 3g (unit map animations)', () => {
  test('add_unit_map_anim attaches, follows, removes, and undoes', async ({ page }) => {
    await boot(page);
    const animNid = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      return [...(g.db.mapAnimations?.keys?.() ?? [])][0] ?? null;
    });
    expect(animNid).not.toBeNull();
    await runEvent(page, 'TestUnitAnim', [
      `add_unit_map_anim;${animNid};Eirika;1;permanent`,
    ]);
    const attached = await page.evaluate((animNid: string) => {
      const g = (window as any).__gameRef;
      const anim = g.tilemap.animations.find((a: any) => a.nid === animNid);
      return { present: !!anim, follows: anim?.followUnit?.nid === 'Eirika' };
    }, animNid);
    expect(attached.present).toBe(true);
    expect(attached.follows).toBe(true);
    // Follow check: move the unit; the anim re-centers on the new tile.
    const followed = await page.evaluate(async (animNid: string) => {
      const g = (window as any).__gameRef;
      const eirika = g.units.get('Eirika');
      g.board.removeUnit(eirika);
      eirika.position = [7, 7];
      g.board.setUnit(7, 7, eirika);
      (window as any).__harness.stepFrames(3);
      const anim = g.tilemap.animations.find((a: any) => a.nid === animNid);
      // Tile 7 => pixel 7*16+8 center; x is center minus half frame width.
      return { x: anim.x + (anim.frameWidth ?? 0) / 2, present: !!anim };
    }, animNid);
    expect(followed.present).toBe(true);
    await runEvent(page, 'TestUnitAnimRm', [`remove_unit_map_anim;${animNid};Eirika`]);
    const result = await page.evaluate((animNid: string) => {
      const g = (window as any).__gameRef;
      const gone = !g.tilemap.animations.some((a: any) => a.nid === animNid);
      const h = (window as any).__harness;
      h.turnwheelUndo(); // undo remove -> anim back
      const restored = g.tilemap.animations.some((a: any) => a.nid === animNid);
      h.turnwheelUndo(); // undo add -> anim gone
      const goneAgain = !g.tilemap.animations.some((a: any) => a.nid === animNid);
      return { gone, restored, goneAgain };
    }, animNid);
    expect(result.gone).toBe(true);
    expect(result.restored).toBe(true);
    expect(result.goneAgain).toBe(true);
  });
});

test.describe('Event command batch 3h (repair shop, cleanup, formation)', () => {
  test('enable_repair_shop toggles the game var reversibly', async ({ page }) => {
    await boot(page);
    await runEvent(page, 'TestRepair', ['enable_repair_shop;true']);
    const result = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const on = g.gameVars.get('_repair_shop');
      (window as any).__harness.turnwheelUndo();
      const after = g.gameVars.get('_repair_shop');
      return { on, after };
    });
    expect(result.on).toBe(true);
    expect(result.after).not.toBe(true);
  });

  test('force_chapter_clean_up heals and resets persistent units', async ({ page }) => {
    await boot(page);
    const before = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const eirika = g.units.get('Eirika');
      eirika.currentHp = 1;
      eirika.finished = true;
      return { hp: eirika.currentHp };
    });
    expect(before.hp).toBe(1);
    await runEvent(page, 'TestCleanup', ['force_chapter_clean_up']);
    const after = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const eirika = g.units.get('Eirika');
      return { hp: eirika.currentHp, finished: eirika.finished };
    });
    expect(after.hp).toBeGreaterThan(1); // healed by cleanup
    expect(after.finished).toBe(false);
  });

  test('arrange_formation places off-map party units on open formation spots', async ({ page }) => {
    await boot(page);
    const setup = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      // Synthetic formation region + one off-map player unit.
      g.currentLevel.regions.push({
        nid: 'TestFormation', region_type: 'formation', position: [1, 1], size: [2, 1],
        sub_nid: '', condition: 'True', only_once: false, interrupt_move: false,
      });
      const seth = g.units.get('Seth');
      if (seth.position) g.board.removeUnit(seth);
      seth.position = null;
      return { party: seth.party, team: seth.team };
    });
    expect(setup.team).toBe('player');
    await runEvent(page, 'TestArrange', ['arrange_formation']);
    const placed = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const pos = g.units.get('Seth').position;
      const inSpot = pos && pos[1] === 1 && (pos[0] === 1 || pos[0] === 2);
      return { pos, inSpot };
    });
    expect(placed.inSpot).toBe(true);
  });
});

test.describe('Event command batch 3i (text_entry)', () => {
  test('text_entry collects typed text into a game var with limits enforced', async ({ page }) => {
    await boot(page);
    await page.evaluate(() => {
      const g = (window as any).__gameRef;
      g.db.events.set('TestTextEntry', {
        name: 'TestTextEntry', nid: 'TestTextEntry', trigger: 'TestTextEntry',
        level_nid: g.currentLevel?.nid ?? null,
        condition: 'True', only_once: false, priority: 0,
        _source: ['text_entry;tactician;Name your tactician;8;x,y;Mark;2', 'game_var;after_entry;yes'],
      });
      g.eventManager.triggerSpecific('TestTextEntry', { type: 'TestTextEntry' }, true);
      g.state.change('event');
    });
    await stepFrames(page, 6);
    const driving = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const st: any = g.state.getCurrentState();
      if (st?.name !== 'text_entry') return { state: st?.name };
      const startText = st.currentText;         // default string
      st.appendChar('x');                        // illegal, rejected
      const afterIllegal = st.currentText;
      st.appendChar('!'); st.appendChar('!');    // legal chars
      st.appendChar('a'); st.appendChar('b'); st.appendChar('c'); st.appendChar('d');
      const afterLimit = st.currentText;         // capped at 8
      st.backspace();
      const afterBackspace = st.currentText;
      const confirmed = st.confirm();
      return { state: 'text_entry', startText, afterIllegal, afterLimit, afterBackspace, confirmed };
    });
    expect(driving.state).toBe('text_entry');
    expect(driving.startText).toBe('Mark');
    expect(driving.afterIllegal).toBe('Mark');
    expect(driving.afterLimit).toBe('Mark!!ab');   // 8-char cap
    expect(driving.afterBackspace).toBe('Mark!!a');
    expect(driving.confirmed).toBe(true);
    await stepFrames(page, 15);
    const vars = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      return { tactician: g.gameVars.get('tactician'), after: g.gameVars.get('after_entry') };
    });
    expect(vars.tactician).toBe('Mark!!a');
    expect(vars.after).toBe('yes');
  });

  test('text_entry rejects below-minimum confirm and honors force_entry cancel gate', async ({ page }) => {
    await boot(page);
    await page.evaluate(() => {
      const g = (window as any).__gameRef;
      g.db.events.set('TestTextMin', {
        name: 'TestTextMin', nid: 'TestTextMin', trigger: 'TestTextMin',
        level_nid: g.currentLevel?.nid ?? null,
        condition: 'True', only_once: false, priority: 0,
        _source: ['text_entry;mintest;Enter;8;;;3;force_entry'],
      });
      g.eventManager.triggerSpecific('TestTextMin', { type: 'TestTextMin' }, true);
      g.state.change('event');
    });
    await stepFrames(page, 6);
    const result = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const st: any = g.state.getCurrentState();
      if (st?.name !== 'text_entry') return { state: st?.name };
      st.appendChar('a');
      const shortConfirm = st.confirm();          // below min of 3 -> false
      const stillHere = g.state.getCurrentState()?.name;
      st.takeInput('AUX');                        // force_entry: cancel blocked
      const afterAux = g.state.getCurrentState()?.name;
      st.appendChar('b'); st.appendChar('c');
      const okConfirm = st.confirm();
      return { state: 'text_entry', shortConfirm, stillHere, afterAux, okConfirm };
    });
    expect(result.state).toBe('text_entry');
    expect(result.shortConfirm).toBe(false);
    expect(result.stillHere).toBe('text_entry');
    expect(result.afterAux).toBe('text_entry');
    expect(result.okConfirm).toBe(true);
    await stepFrames(page, 10);
    const value = await page.evaluate(() => (window as any).__gameRef.gameVars.get('mintest'));
    expect(value).toBe('abc');
  });
});

test.describe('Event command batch 3j (change_bg_tilemap)', () => {
  test('change_bg_tilemap sets, undoes, and clears the background tilemap', async ({ page }) => {
    await boot(page);
    const otherTilemap = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const current = g.tilemap?.nid;
      return [...g.db.tilemaps.keys()].find((nid: string) => nid !== current) ?? null;
    });
    expect(otherTilemap).not.toBeNull();
    await runEvent(page, 'TestBgTilemap', [
      `change_bg_tilemap;${otherTilemap}`,
      'game_var;after_bg;yes',
    ]);
    // The bg tilemap applies when its tileset images finish loading — wait on
    // the state, not a frame count.
    await page.waitForFunction(
      (nid: string) => (window as any).__gameRef.bgTilemap?.nid === nid,
      otherTilemap,
      { timeout: 15_000 },
    );
    const set = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      return {
        bg: g.bgTilemap?.nid ?? null,
        mirrored: g.mapView.bgTilemap?.nid ?? null,
        after: g.gameVars.get('after_bg'),
      };
    });
    expect(set.bg).toBe(otherTilemap);
    expect(set.mirrored).toBe(otherTilemap);
    expect(set.after).toBe('yes');
    // Undo restores no-background; then a clear command also works.
    const undone = await page.evaluate(() => {
      (window as any).__harness.turnwheelUndo();
      const g = (window as any).__gameRef;
      return g.bgTilemap === null && g.mapView.bgTilemap === null;
    });
    expect(undone).toBe(true);
    await runEvent(page, 'TestBgSet2', [`change_bg_tilemap;${otherTilemap}`]);
    await page.waitForFunction(
      (nid: string) => (window as any).__gameRef.bgTilemap?.nid === nid,
      otherTilemap,
      { timeout: 15_000 },
    );
    await runEvent(page, 'TestBgClear', ['change_bg_tilemap']);
    const cleared = await page.evaluate(() => (window as any).__gameRef.bgTilemap === null);
    expect(cleared).toBe(true);
  });
});

test.describe('Event command batch 3k (change_team_palette)', () => {
  test('change_team_palette overrides palette/color, rebuilds sprites, and undoes', async ({ page }) => {
    await boot(page);
    const paletteNid = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const enemyDef = g.db.teams.defs.find((t: any) => t.nid === 'enemy');
      const playerDef = g.db.teams.defs.find((t: any) => t.nid === 'player');
      // Use the enemy team's palette as the override target for player.
      return { enemy: enemyDef?.palette ?? null, playerOrig: playerDef?.palette ?? null };
    });
    expect(paletteNid.enemy).not.toBeNull();
    await runEvent(page, 'TestTeamPal', [
      `change_team_palette;player;${paletteNid.enemy};;red`,
    ]);
    const applied = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      return {
        palette: g.getTeamPalette('player'),
        color: g.getTeamCombatColor('player'),
      };
    });
    expect(applied.palette).toBe(paletteNid.enemy);
    expect(applied.color).toBe('red');
    const undone = await page.evaluate(() => {
      (window as any).__harness.turnwheelUndo();
      const g = (window as any).__gameRef;
      return {
        palette: g.getTeamPalette('player'),
        color: g.getTeamCombatColor('player'),
      };
    });
    expect(undone.palette).toBe(paletteNid.playerOrig);
    expect(undone.color).not.toBe('red');
    // Invalid team warns without applying.
    await runEvent(page, 'TestTeamPalBad', ['change_team_palette;no_such_team;X']);
    const stillClean = await page.evaluate(
      () => (window as any).__gameRef.teamPaletteOverrides.size,
    );
    expect(stillClean).toBe(0);
  });
});

test.describe('Event command batch 3l (set_custom_options)', () => {
  test('set_custom_options adds selectable entries to the option menu that fire events', async ({ page }) => {
    await boot(page);
    await page.evaluate(() => {
      const g = (window as any).__gameRef;
      g.db.events.set('CustomOptEvent', {
        name: 'CustomOptEvent', nid: 'CustomOptEvent', trigger: 'CustomOptEvent',
        level_nid: g.currentLevel?.nid ?? null,
        condition: 'True', only_once: false, priority: 0,
        _source: ['game_var;custom_fired;yes'],
      });
    });
    await runEvent(page, 'TestCustomOpts', [
      'set_custom_options;Chronicle,Locked Thing;true,false;See the story so far;CustomOptEvent',
    ]);
    const vars = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      return {
        opts: g.gameVars.get('_custom_additional_options'),
        disabled: g.gameVars.get('_custom_options_disabled'),
        events: g.gameVars.get('_custom_options_events'),
      };
    });
    expect(vars.opts).toEqual(['Chronicle', 'Locked Thing']);
    expect(vars.disabled).toEqual([false, true]);
    expect(vars.events).toEqual(['CustomOptEvent', null]);
    // Open the option menu; entries appear before 'Options'; select the first.
    const menu = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      g.state.change('option_menu');
      (window as any).__harness.stepFrames(3);
      const st: any = g.state.getCurrentState();
      const labels = st.menu?.options?.map((o: any) => ({ label: o.label, value: o.value, enabled: o.enabled })) ?? [];
      const customIdx = labels.findIndex((o: any) => o.value === 'custom:0');
      const optionsIdx = labels.findIndex((o: any) => o.value === 'options');
      if (customIdx >= 0) st.menu.selectedIndex = customIdx;
      return { labels, customIdx, optionsIdx };
    });
    expect(menu.customIdx).toBeGreaterThanOrEqual(0);
    expect(menu.customIdx).toBeLessThan(menu.optionsIdx);
    expect(menu.labels[menu.customIdx + 1]?.enabled).toBe(false); // Locked Thing disabled
    await stepFrames(page, 1, 'SELECT');
    await stepFrames(page, 15);
    const fired = await page.evaluate(() => (window as any).__gameRef.gameVars.get('custom_fired'));
    expect(fired).toBe('yes');
  });
});
