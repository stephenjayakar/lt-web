import { expect, test, type Page } from '@playwright/test';

/**
 * EOtF's engine fork (and, where noted, both engines) in the action, AI,
 * targeting and map-flow seams:
 * - unit tags are a list: add_tag appends, remove_tag drops one copy;
 * - event moves, event reset/resurrect and a dying rescuer's traveler all go
 *   through action.Reset (on_refresh, so Null Refresh waits the unit);
 * - Drop waits a droppee of the current phase's team;
 * - target_restrict receives the main target (empty for spell blasts and
 *   line AOEs), 99-range items reach the whole map, and eval_special_range
 *   restricts splash when there is no main target;
 * - cancelling a move also reverses items stored from the item menu;
 * - the AI re-equips items[0] after thinking, tries skill abilities but not
 *   combat arts, and never brings its weapon to the top.
 *
 * Scenes use EOtF's hub map (level X): the open box x 21..28, y 11..15.
 */

async function bootEotf(page: Page): Promise<void> {
  await page.goto('/?harness=true&project=eotf.ltproj&level=X&clean=true&bundle=false');
  await page.waitForFunction(() => (window as any).__harness?.ready === true, undefined, { timeout: 60_000 });
  await page.evaluate(async () => {
    const g = (window as any).__gameRef;
    const { ItemObject } = await import('/src/objects/item.ts');
    const { SkillObject } = await import('/src/objects/skill.ts');
    const flavor = await import('/src/engine/engine-flavor.ts');
    for (const unit of [...g.units.values()]) if (unit.position) g.board.removeUnit(unit);
    const flat = { HP: 40, STR: 0, MAG: 0, SKL: 0, SPD: 0, LCK: 0, DEF: 0, RES: 0, CON: 5, MOV: 3 };
    const item = (nid: string, components: Array<[string, unknown]>) => new ItemObject({
      nid, name: nid, desc: '', icon_nid: '', icon_index: [0, 0], components,
    } as any);
    const weapon = (nid: string, damage: number, extra: Array<[string, unknown]> = []) => item(nid, [
      ['weapon', null], ['target_enemy', null], ['damage', damage], ['hit', 100],
      ['min_range', 1], ['max_range', 1], ['uses', 40], ...extra,
    ]);
    const skill = (nid: string) => new SkillObject(g.db.skills.get(nid));
    const place = (unit: any, team: string, pos: [number, number], stats: Record<string, number> = {}) => {
      unit.team = team;
      unit.stats = { ...flat, ...stats };
      unit.currentHp = unit.stats.HP;
      unit.skills = [];
      unit.items = [];
      unit.equippedWeapon = null;
      unit.equippedAccessory = null;
      unit.aiGroup = '';
      unit.tags = [];
      unit.resetTurnState();
      g.board.setUnit(pos[0], pos[1], unit);
      return unit;
    };
    const give = (unit: any, items: any[]) => {
      unit.items = items;
      for (const it of items) it.owner = unit;
    };
    const ai = (nid: string, behaviours: Array<Record<string, unknown>>) => {
      g.db.ai.set(nid, {
        nid, priority: 0, offense_bias: 2,
        behaviours: behaviours.map((b) => ({
          target_spec: null, invert_targeting: false, roam_speed: 0,
          desired_proximity: 0, condition: '', ...b,
        })),
      });
      return nid;
    };
    const units = {
      keeper: g.units.get('Keeper'), player: g.units.get('Player'), lib: g.units.get('Lib'),
    };
    flavor.setForkEngine(true);
    (window as any).__flow = { g, ...units, place, give, ai, item, weapon, skill, flavor };
  });
}

async function stepFrames(page: Page, n: number): Promise<void> {
  await page.evaluate((count) => (window as any).__harness.stepFrames(count), n);
}

test.describe('EOtF engine fork: actions, AI and map flow', () => {
  test.beforeEach(async ({ page }) => bootEotf(page));

  test('add_tag stacks copies on the fork; remove_tag drops one; undo restores', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { keeper, place, flavor } = (window as any).__flow;
      const { AddTagAction, RemoveTagAction } = await import('/src/engine/action.ts');
      place(keeper, 'other', [22, 12]);
      const run = (fork: boolean) => {
        flavor.setForkEngine(fork);
        keeper.tags = [];
        const steps = [
          new AddTagAction(keeper, 'Blacklist'),
          new AddTagAction(keeper, 'Blacklist'),
          new RemoveTagAction(keeper, 'Blacklist'),
        ];
        for (const step of steps) step.execute();
        const after = [...keeper.tags];
        for (const step of [...steps].reverse()) step.reverse();
        return { after, undone: [...keeper.tags] };
      };
      const fork = run(true);
      const upstream = run(false);
      flavor.setForkEngine(true);
      return { fork, upstream };
    });
    expect(result.fork).toEqual({ after: ['Blacklist'], undone: [] });
    expect(result.upstream).toEqual({ after: [], undone: [] });
  });

  test('an event move refreshes the walker (action.Reset); Null Refresh waits it', async ({ page }) => {
    const setup = await page.evaluate(() => {
      const { g, keeper, player, place, skill } = (window as any).__flow;
      // An unfinished second player unit keeps the turn from auto-ending.
      place(player, 'player', [27, 11]);
      const run = (nullRefresh: boolean, from: [number, number], to: [number, number], flag: string) => {
        if (keeper.position) g.board.removeUnit(keeper);
        place(keeper, 'player', from);
        if (nullRefresh) keeper.skills = [skill('Nope_Child')];
        keeper.hasMoved = keeper.hasAttacked = keeper.finished = true;
        keeper.movementLeft = 0;
        g.db.events.set(flag, {
          name: flag, nid: flag, trigger: flag, level_nid: g.currentLevel?.nid ?? null,
          condition: 'True', only_once: false, priority: 0,
          _source: [`move_unit;Keeper;${to[0]},${to[1]}`, `game_var;${flag};1`],
        });
        g.eventManager.triggerSpecific(flag, { type: flag }, true);
        g.state.change('event');
      };
      (window as any).__flowMove = run;
      run(false, [22, 13], [25, 13], '_flow_moved_a');
      return true;
    });
    expect(setup).toBe(true);
    const waitFor = async (flag: string) => {
      for (let frame = 0; frame < 600; frame += 5) {
        await stepFrames(page, 5);
        if (await page.evaluate((f) => (window as any).__gameRef.gameVars.get(f), flag)) return;
      }
    };
    const snapshot = () => page.evaluate(() => {
      const keeper = (window as any).__flow.keeper;
      return {
        position: keeper.position && [...keeper.position],
        finished: keeper.finished,
        hasAttacked: keeper.hasAttacked,
        movementLeft: keeper.movementLeft,
      };
    });
    await waitFor('_flow_moved_a');
    const plain = await snapshot();
    await page.evaluate(() => (window as any).__flowMove(true, [22, 14], [25, 14], '_flow_moved_b'));
    await waitFor('_flow_moved_b');
    const blocked = await snapshot();
    expect(plain).toEqual({ position: [25, 13], finished: false, hasAttacked: false, movementLeft: 3 });
    expect(blocked).toMatchObject({ position: [25, 14], finished: true, hasAttacked: true });
  });

  test('event reset and resurrect go through action.Reset (Null Refresh waits)', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { g, keeper, player, place } = (window as any).__flow;
      const { EventState } = await import('/src/engine/states/game-states.ts');
      place(keeper, 'player', [22, 13]);
      // An unfinished second player unit keeps the turn from auto-ending.
      place(player, 'player', [27, 15]);
      const runCommand = (command: string) => {
        g.db.events.set('_flow_cmd', {
          name: '_flow_cmd', nid: '_flow_cmd', trigger: '_flow_cmd', level_nid: g.currentLevel?.nid ?? null,
          condition: 'True', only_once: false, priority: 0, _source: [command],
        });
        g.eventManager.triggerSpecific('_flow_cmd', { type: '_flow_cmd' }, true);
        g.state.change('event');
      };
      (window as any).__flowCmd = runCommand;
      keeper.hasMoved = keeper.finished = true;
      keeper.movementLeft = 0;
      runCommand('reset;Keeper');
      return EventState !== undefined;
    });
    expect(result).toBe(true);
    await stepFrames(page, 20);
    const plain = await page.evaluate(() => {
      const { keeper, skill } = (window as any).__flow;
      const out = { finished: keeper.finished, movementLeft: keeper.movementLeft };
      keeper.skills = [skill('Nope_Child')];
      keeper.finished = false;
      (window as any).__flowCmd('reset;Keeper');
      return out;
    });
    await stepFrames(page, 20);
    const nullRefresh = await page.evaluate(() => {
      const { keeper } = (window as any).__flow;
      const out = { finished: keeper.finished };
      keeper.dead = true;
      keeper.finished = false;
      (window as any).__flowCmd('resurrect;Keeper');
      return out;
    });
    await stepFrames(page, 20);
    const resurrected = await page.evaluate(() => {
      const { keeper } = (window as any).__flow;
      return { dead: keeper.dead, finished: keeper.finished };
    });
    expect(plain).toEqual({ finished: false, movementLeft: 3 });
    expect(nullRefresh).toEqual({ finished: true });
    expect(resurrected).toEqual({ dead: false, finished: true });
  });

  test('a dying rescuer drops its traveler; off-phase travelers are Reset; undo restores', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { g, keeper, lib, place, skill } = (window as any).__flow;
      const { RescueAction, DeathAction } = await import('/src/engine/action.ts');
      const run = (travelerTeam: string, nullRefresh: boolean) => {
        for (const unit of [keeper, lib]) if (unit.position) g.board.removeUnit(unit);
        keeper.dead = false;
        place(keeper, 'player', [22, 13]);
        place(lib, travelerTeam, [23, 13]);
        if (nullRefresh) lib.skills = [skill('Nope_Child')];
        new RescueAction(keeper, lib, g.board).execute();
        lib.finished = true;
        const death = new DeathAction(keeper, g.board);
        death.execute();
        const after = {
          libAt: lib.position && [...lib.position],
          onTile: g.board.getUnit(22, 13)?.nid ?? null,
          carried: keeper.traveler,
          finished: lib.finished,
        };
        death.reverse();
        const undone = {
          libAt: lib.position,
          keeperAt: keeper.position && [...keeper.position],
          carried: keeper.traveler,
          rescuedBy: lib.rescuedBy?.nid ?? null,
          dead: keeper.dead,
        };
        return { after, undone };
      };
      // Player phase: a player traveler is waited by Drop; an "other" one is
      // Reset (refreshed), unless Null Refresh waits it instead.
      return { own: run('player', false), other: run('other', false), blocked: run('other', true) };
    });
    expect(result.own.after).toEqual({ libAt: [22, 13], onTile: 'Lib', carried: null, finished: true });
    expect(result.other.after.finished).toBe(false);
    expect(result.blocked.after.finished).toBe(true);
    expect(result.own.undone).toEqual({
      libAt: null, keeperAt: [22, 13], carried: 'Lib', rescuedBy: 'Keeper', dead: false,
    });
  });

  test('Drop waits a droppee of the current phase only', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { g, keeper, lib, place } = (window as any).__flow;
      const { RescueAction, DropAction } = await import('/src/engine/action.ts');
      const run = (team: string) => {
        for (const unit of [keeper, lib]) if (unit.position) g.board.removeUnit(unit);
        place(keeper, 'player', [22, 13]);
        place(lib, team, [23, 13]);
        new RescueAction(keeper, lib, g.board).execute();
        const drop = new DropAction(keeper, lib, g.board, [22, 14]);
        drop.execute();
        const finished = lib.finished;
        drop.reverse();
        return { finished, undone: lib.finished };
      };
      return { player: run('player'), other: run('other') };
    });
    expect(result.player).toEqual({ finished: true, undone: false });
    expect(result.other).toEqual({ finished: false, undone: false });
  });

  test('target_restrict sees the main target: a spell blast may centre on an occupied tile', async ({ page }) => {
    const result = await page.evaluate(() => {
      const { g, player, keeper, place, give, item, flavor } = (window as any).__flow;
      place(player, 'player', [22, 13]);
      place(keeper, 'enemy', [24, 13]);
      const blast = item('_FlowServe', [
        ['target_tile', null], ['blast_aoe', 1], ['empty_tile_target_restrict', null], ['spell', null],
        ['min_range', 1], ['max_range', 3], ['damage', 5],
      ]);
      give(player, [blast]);
      const has = (targets: [number, number][], x: number, y: number) =>
        targets.some((t) => t[0] === x && t[1] === y);
      flavor.setForkEngine(true);
      const fork = g.targetSystem.getValidTargets(player, blast);
      flavor.setForkEngine(false);
      const upstream = g.targetSystem.getValidTargets(player, blast);
      flavor.setForkEngine(true);
      return {
        fork: { occupied: has(fork, 24, 13), beside: has(fork, 23, 13) },
        upstream: { occupied: has(upstream, 24, 13), beside: has(upstream, 23, 13) },
      };
    });
    expect(result.fork).toEqual({ occupied: true, beside: true });
    expect(result.upstream).toEqual({ occupied: false, beside: true });
  });

  test('99-range items reach the whole map on the fork; eval_special_range checks splash', async ({ page }) => {
    const result = await page.evaluate(() => {
      const { g, player, keeper, lib, place, give, weapon, item, flavor } = (window as any).__flow;
      place(player, 'player', [22, 13]);
      place(keeper, 'enemy', [23, 13]);
      // Minimum range 2 with a 99 maximum: the adjacent enemy.
      const far = weapon('_FlowFar', 5, [['min_range', 2], ['max_range', 99]]);
      // A cross-shaped blast: the cursor on an empty cross tile with an
      // enemy off the cross in the blast.
      const cross = item('_FlowCross', [
        ['weapon', null], ['target_enemy', null], ['target_tile', null], ['damage', 5], ['hit', 100],
        ['min_range', 1], ['max_range', 5], ['enemy_blast_aoe', 1],
        ['eval_special_range', 'x == 0 or y == 0'],
      ]);
      give(player, [far, cross]);
      const has = (targets: [number, number][], x: number, y: number) =>
        targets.some((t) => t[0] === x && t[1] === y);
      const read = () => {
        const farTargets = g.targetSystem.getValidTargets(player, far);
        g.board.removeUnit(keeper);
        place(keeper, 'enemy', [26, 14]);
        place(lib, 'enemy', [26, 11]);
        const crossTargets = g.targetSystem.getValidTargets(player, cross);
        g.board.removeUnit(keeper);
        g.board.removeUnit(lib);
        place(keeper, 'enemy', [23, 13]);
        return {
          adjacent: has(farTargets, 23, 13),
          // (26,13) is on the cross and empty; (26,14) is off it.
          emptyCross: has(crossTargets, 26, 13),
          // (26,11) is off the cross: never targetable.
          offCross: has(crossTargets, 26, 11),
        };
      };
      flavor.setForkEngine(true);
      const fork = read();
      flavor.setForkEngine(false);
      const upstream = read();
      flavor.setForkEngine(true);
      return { fork, upstream };
    });
    expect(result.fork).toEqual({ adjacent: true, emptyCross: false, offCross: false });
    expect(result.upstream).toEqual({ adjacent: false, emptyCross: true, offCross: false });
  });

  test('cancelling a move reverses item-menu storage on the fork only', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { g, player, place, give, weapon, flavor } = (window as any).__flow;
      const { ActionLog, StoreItemAction, EquipItemAction, SetMovementLeftAction } =
        await import('/src/engine/action.ts');
      const run = (fork: boolean) => {
        flavor.setForkEngine(fork);
        if (player.position) g.board.removeUnit(player);
        place(player, 'player', [22, 13]);
        const sword = weapon('_FlowSword', 5);
        const lance = weapon('_FlowLance', 5);
        give(player, [sword, lance]);
        const log = new ActionLog();
        const move = new SetMovementLeftAction(player, 1);
        log.doAction(move);
        log.doAction(new EquipItemAction(player, lance));
        log.doAction(new StoreItemAction(player, sword));
        log.hardRemove(move);
        return {
          items: player.items.map((it: any) => it.nid),
          equipped: player.equippedWeapon?.nid ?? null,
          remaining: log.actions.length,
        };
      };
      const fork = run(true);
      const upstream = run(false);
      flavor.setForkEngine(true);
      return { fork, upstream };
    });
    expect(result.fork).toEqual({ items: ['_FlowSword', '_FlowLance'], equipped: '_FlowLance', remaining: 1 });
    expect(result.upstream).toEqual({ items: ['_FlowLance'], equipped: '_FlowLance', remaining: 2 });
  });

  test('an AI unit an event resets after its combat does not run its AI again that phase', async ({ page }) => {
    // Python AIState keeps has_run_ai for the whole phase (start(), not
    // begin()). EOtF's Evened_Scales resets the attacker in a combat_end
    // event; re-picking it attacked a True_Miracle target forever.
    const setup = await page.evaluate(() => {
      const { g, keeper, player, place, give, weapon, ai } = (window as any).__flow;
      place(keeper, 'enemy', [22, 13]);
      give(keeper, [weapon('_FlowPoke', 1)]);
      keeper.ai = ai('_FlowPursue', [{ action: 'Attack', target: 'Enemy', view_range: -1 }]);
      place(player, 'player', [23, 13], { DEF: 0 });
      give(player, []);
      for (const [nid, event] of [...g.db.events.entries()]) {
        if (event.trigger === 'combat_end' || event.trigger === 'unit_wait') g.db.events.delete(nid);
      }
      g.db.events.set('_FlowResetAfterCombat', {
        nid: '_FlowResetAfterCombat', name: '_FlowResetAfterCombat', trigger: 'combat_end', level_nid: null,
        condition: "unit.nid == 'Keeper'", only_once: false, priority: 0,
        _source: ["game_var;qa_keeper_combats;v('qa_keeper_combats', 0) + 1", 'reset;Keeper'],
      });
      g.memory.set('combat_force_no_animation', true);
      g.phase.setCurrentTeam('enemy');
      g.state.change('ai');
      return true;
    });
    expect(setup).toBe(true);
    let state = '';
    for (let i = 0; i < 400; i++) {
      await stepFrames(page, 5);
      state = await page.evaluate(() => {
        const g = (window as any).__gameRef;
        const names = g.state.getStackNames();
        return names[names.length - 1] ?? '';
      });
      if (state !== 'ai' && state !== 'combat' && state !== 'event' && state !== 'move_camera' && state !== 'movement') break;
    }
    const combats = await page.evaluate(() => (window as any).__gameRef.gameVars.get('qa_keeper_combats'));
    expect(combats).toBe(1);
    expect(state).not.toBe('ai');
  });

  test('after thinking the AI holds items[0], not the weapon it last attacked with', async ({ page }) => {
    const result = await page.evaluate(() => {
      const { g, keeper, player, place, give, weapon, ai } = (window as any).__flow;
      place(keeper, 'enemy', [22, 13]);
      const sword = weapon('_FlowSword', 5);
      const bow = weapon('_FlowBow', 5, [['min_range', 2], ['max_range', 2]]);
      give(keeper, [sword, bow]);
      keeper.equip(bow);
      keeper.ai = ai('_FlowGuard', [{ action: 'Attack', target: 'Enemy', view_range: -1 }]);
      // Nobody in reach: the guard waits.
      place(player, 'player', [28, 15]);
      const action = g.aiController.getAction(keeper);
      return { type: action.type, equipped: keeper.equippedWeapon?.nid ?? null };
    });
    expect(result).toEqual({ type: 'wait', equipped: '_FlowSword' });
  });

  test('the fork AI tries skill abilities but never combat arts', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { g, keeper, player, place, give, weapon, skill, ai } = (window as any).__flow;
      const { getCombatArtOptions } = await import('/src/combat/combat-art-system.ts');
      place(keeper, 'enemy', [22, 13]);
      give(keeper, [weapon('_FlowStick', 1)]);
      keeper.ai = ai('_FlowGuard2', [{ action: 'Attack', target: 'Enemy', view_range: -1 }]);
      place(player, 'player', [23, 13], { DEF: 3 });
      const brief = (action: any) => ({
        type: action.type,
        item: action.item?.nid ?? null,
        art: action.combatArt?.skill?.nid ?? null,
      });
      // Sucker Punch (6 damage) is an ability_attack_charge item.
      keeper.skills = [skill('Sucker_Punch_Normal')];
      const ability = brief(g.aiController.getAction(keeper));
      // Capture Piece is a combat art the chess enemies hold: a ready option,
      // but the fork AI never tries it.
      keeper.skills = [skill('Capture_Piece')];
      const options = getCombatArtOptions(g, keeper, false).map((o: any) => o.skill.nid);
      const forkArt = brief(g.aiController.getAction(keeper));
      return { ability, options, forkArt };
    });
    expect(result.ability).toEqual({ type: 'attack', item: 'Sucker_Punch', art: null });
    expect(result.options).toEqual(['Capture_Piece']);
    expect(result.forkArt).toEqual({ type: 'attack', item: '_FlowStick', art: null });
  });

  test('the AI strike shell keeps eval_special_range squares at 99 range', async ({ page }) => {
    const result = await page.evaluate(() => {
      const { g, keeper, player, place, give, item, ai, flavor } = (window as any).__flow;
      const ray = () => item('_FlowRay', [
        ['weapon', null], ['target_enemy', null], ['damage', 15], ['hit', 100],
        ['min_range', 1], ['max_range', 99], ['eval_special_range', 'x == 0 or y == 0'],
      ]);
      const run = (fork: boolean, target: [number, number]) => {
        flavor.setForkEngine(fork);
        for (const unit of [keeper, player]) if (unit.position) g.board.removeUnit(unit);
        place(keeper, 'enemy', [22, 13]);
        give(keeper, [ray()]);
        keeper.ai = ai('_FlowRayGuard', [{ action: 'Attack', target: 'Enemy', view_range: -1 }]);
        place(player, 'player', target);
        return g.aiController.getAction(keeper).type;
      };
      const out = {
        forkDiagonal: run(true, [25, 15]),
        forkCross: run(true, [27, 13]),
        upstreamDiagonal: run(false, [25, 15]),
      };
      flavor.setForkEngine(true);
      return out;
    });
    expect(result).toEqual({ forkDiagonal: 'wait', forkCross: 'attack', upstreamDiagonal: 'wait' });
  });

  test('attack highlights cover the whole map for 99-range items on the fork', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { g, player, place, give, weapon, flavor } = (window as any).__flow;
      const { attackablePositions } = await import('/src/engine/target-system.ts');
      place(player, 'player', [22, 13]);
      const far = weapon('_FlowFar', 5, [['min_range', 2], ['max_range', 99]]);
      const cross = weapon('_FlowCross', 5, [['max_range', 3], ['eval_special_range', 'x == 0 or y == 0']]);
      give(player, [far, cross]);
      const [left, top, right, bottom] = g.board.bounds;
      const tiles = (right - left + 1) * (bottom - top + 1);
      const read = () => {
        const farTiles = attackablePositions(player, far, [[22, 13]], g.board, g);
        const crossTiles = attackablePositions(player, cross, [[22, 13]], g.board, g);
        const has = (list: [number, number][], x: number, y: number) =>
          list.some((t) => t[0] === x && t[1] === y);
        return {
          far: farTiles.length,
          adjacent: has(farTiles, 23, 13),
          crossCount: crossTiles.length,
          diagonal: has(crossTiles, 23, 14),
        };
      };
      flavor.setForkEngine(true);
      const fork = read();
      flavor.setForkEngine(false);
      const upstream = read();
      flavor.setForkEngine(true);
      const highlighted = g.pathSystem.getAttackPositions(player, g.board, [[22, 13]]).length;
      return { tiles, fork, upstream, highlighted };
    });
    expect(result.fork).toEqual({ far: result.tiles, adjacent: true, crossCount: 12, diagonal: false });
    // Upstream drops the tiles nearer than the minimum range (own tile + 4).
    expect(result.upstream).toEqual({ far: result.tiles - 5, adjacent: false, crossCount: 12, diagonal: false });
    // The move-state highlight unions every weapon and omits the move tile.
    expect(result.highlighted).toBe(result.tiles - 1);
  });

  test('without an equippable items[0] the AI can end up holding an ability weapon', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { g, keeper, player, place, give, item, weapon, ai } = (window as any).__flow;
      const { SkillObject } = await import('/src/objects/skill.ts');
      g.db.items.set('_FlowAbilityBlade', {
        nid: '_FlowAbilityBlade', name: '_FlowAbilityBlade', desc: '', icon_nid: '', icon_index: [0, 0],
        components: [['weapon', null], ['target_enemy', null], ['damage', 1], ['hit', 100],
          ['min_range', 1], ['max_range', 1]],
      });
      place(keeper, 'enemy', [22, 13]);
      const tonic = item('_FlowTonic', [['usable', null], ['heal', 10], ['uses', 3]]);
      const sword = weapon('_FlowSword', 5);
      give(keeper, [tonic, sword]);
      keeper.equip(sword);
      keeper.skills = [new SkillObject({
        nid: '_FlowBladeSkill', name: '_FlowBladeSkill', desc: '', icon_nid: '', icon_index: [0, 0],
        components: [['ability', '_FlowAbilityBlade']],
      } as any)];
      keeper.ai = ai('_FlowGuard3', [{ action: 'Attack', target: 'Enemy', view_range: -1 }]);
      place(player, 'player', [28, 15]);
      const action = g.aiController.getAction(keeper);
      const held = keeper.equippedWeapon?.nid ?? null;
      // With the sword first, items[0] wins again.
      give(keeper, [sword, tonic]);
      g.aiController.getAction(keeper);
      return { type: action.type, held, after: keeper.equippedWeapon?.nid ?? null };
    });
    expect(result).toEqual({ type: 'wait', held: '_FlowAbilityBlade', after: '_FlowSword' });
  });
});
