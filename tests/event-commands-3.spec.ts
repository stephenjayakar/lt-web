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
