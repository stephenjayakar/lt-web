import { test, expect, type Page } from '@playwright/test';

/**
 * Event data commands follow Python evaluation and action semantics:
 * set_skill_data/game_var evaluate their expression, runtime-added
 * components run their init(), and tag edits are turnwheel actions.
 */

test.describe.configure({ mode: 'parallel' });

async function boot(page: Page): Promise<void> {
  await page.goto('/?harness=true&level=DEBUG&bundle=false');
  await page.waitForFunction(() => (window as any).__harness?.ready === true, undefined, {
    timeout: 60_000,
  });
  await page.evaluate(() => (window as any).__harness.stepFrames(5, null));
}

async function runEvent(
  page: Page,
  nid: string,
  source: string[],
  localArgs: Record<string, unknown> = {},
): Promise<void> {
  await page.evaluate(({ nid, source, localArgs }) => {
    const g = (window as any).__gameRef;
    g.db.events.set(nid, {
      name: nid, nid, trigger: nid, level_nid: g.currentLevel?.nid ?? null,
      condition: 'True', only_once: false, priority: 0, _source: source,
    });
    g.eventManager.triggerSpecific(nid, {
      type: nid,
      localArgs: new Map(Object.entries(localArgs)),
    }, true);
    g.state.change('event');
  }, { nid, source, localArgs });
  await page.evaluate(() => (window as any).__harness.stepFrames(30, null));
}

test.describe('Event data command parity', () => {
  test('set_skill_data evaluates its expression', async ({ page }) => {
    await boot(page);
    const skillNid = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const nid = [...g.db.skills.keys()][0];
      (window as any).__harness.addSkill('Eirika', nid);
      return nid;
    });
    await runEvent(page, 'QaSkillData', [
      `set_skill_data;Eirika;${skillNid};charge;2`,
      `set_skill_data;Eirika;${skillNid};charge;get_skill(game.get_unit('Eirika'), '${skillNid}').data['charge'] + 1`,
      // Unevaluable expressions are skipped rather than stored as text.
      `set_skill_data;Eirika;${skillNid};charge;no_such_name + 1`,
    ]);
    const charge = await page.evaluate((nid: string) =>
      (window as any).__gameRef.units.get('Eirika').skills.find((s: any) => s.nid === nid).data.get('charge'),
    skillNid);
    expect(charge).toBe(3);
  });

  test('variables store evaluated locals and reject objects', async ({ page }) => {
    await boot(page);
    await runEvent(page, 'QaVars', [
      'level_var;qa_pos;target_pos',
      'game_var;qa_word;SomeWord',
      'game_var;qa_unit;True',
      "game_var;qa_unit;game.get_unit('Eirika')",
    ], { target_pos: [3, 4] });
    const vars = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      return { pos: g.levelVars.get('qa_pos'), word: g.gameVars.get('qa_word'), unit: g.gameVars.get('qa_unit') };
    });
    expect(vars.pos).toEqual([3, 4]);
    expect(vars.word).toBe('SomeWord');
    // Python's is_primitive_or_primitive_collection rejects the unit.
    expect(vars.unit).toBe(true);
  });

  test('runtime-added uses and end_time components run their init', async ({ page }) => {
    await boot(page);
    const setup = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const item = g.units.get('Eirika').items.find((candidate: any) => !candidate.components.has('uses'))
        ?? g.units.get('Eirika').items[0];
      if (item.components.has('uses')) item.components.delete('uses');
      const skillNid = [...g.db.skills.values()].find((skill: any) =>
        !skill.components.some(([nid]: [string]) => ['end_time', 'time', 'combined_time'].includes(nid)))?.nid;
      (window as any).__harness.addSkill('Eirika', skillNid);
      return { itemUid: item.uid, skillNid };
    });
    await runEvent(page, 'QaComponents', [
      `add_item_component;Eirika;${setup.itemUid};uses;3`,
      `add_skill_component;Eirika;${setup.skillNid};end_time;2`,
    ]);
    const result = await page.evaluate(({ itemUid, skillNid }) => {
      const g = (window as any).__gameRef;
      const unit = g.units.get('Eirika');
      const item = unit.items.find((candidate: any) => candidate.uid === itemUid);
      const skill = unit.skills.find((candidate: any) => candidate.nid === skillNid);
      return {
        uses: item.data.get('uses'),
        starting: item.data.get('starting_uses'),
        itemUses: item.uses,
        turns: skill.data.get('turns'),
        startingTurns: skill.data.get('starting_turns'),
      };
    }, setup);
    expect(result).toEqual({ uses: 3, starting: 3, itemUses: 3, turns: 2, startingTurns: 2 });
  });

  test('expressions read Python UnitObject attributes EOtF uses', async ({ page }) => {
    await boot(page);
    const skillNid = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const nid = [...g.db.skills.keys()][0];
      (window as any).__harness.addSkill('Eirika', nid);
      const skill = g.units.get('Eirika').skills.find((s: any) => s.nid === nid);
      skill.data.set('charge', 4);
      return nid;
    });
    await runEvent(page, 'QaUnitAttrs', [
      "game_var;qa_portrait;u('Eirika').portrait_nid",
      "game_var;qa_party;u('Eirika').party",
      `game_var;qa_charge;u('Eirika').get_skill('${skillNid}').data['charge'] + 1`,
      "game_var;qa_attacked;u('Eirika')._has_attacked",
    ]);
    const result = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const eirika = g.units.get('Eirika');
      return {
        portrait: g.gameVars.get('qa_portrait'),
        expectedPortrait: eirika.portraitNid,
        party: g.gameVars.get('qa_party'),
        expectedParty: eirika.party,
        charge: g.gameVars.get('qa_charge'),
        attacked: g.gameVars.get('qa_attacked'),
      };
    });
    expect(result.portrait).toBe(result.expectedPortrait);
    expect(result.party).toBe(result.expectedParty);
    expect(result.charge).toBe(5);
    expect(result.attacked).toBe(false);
  });

  test('arrange_formation deploys persistent party units to sorted open spots', async ({ page }) => {
    await boot(page);
    await page.evaluate(() => {
      const g = (window as any).__gameRef;
      g.currentLevel.regions.push(
        { nid: 'QaFormA', region_type: 'formation', position: [5, 1], size: [1, 2], sub_nid: '', condition: 'True' },
        { nid: 'QaFormB', region_type: 'formation', position: [2, 3], size: [1, 1], sub_nid: '', condition: 'True' },
      );
      for (const nid of ['Eirika', 'Seth']) {
        const unit = g.units.get(nid);
        if (unit.position) g.board.removeUnit(unit);
        unit.position = null;
      }
      // Prep order puts Seth first; a non-persistent unit is never deployed.
      g.getParty().partyPrepManageSortOrder = ['Seth', 'Eirika'];
      g.units.get('Eirika').persistent = true;
      g.units.get('Seth').persistent = true;
    });
    await runEvent(page, 'QaArrange', ['arrange_formation']);
    const placed = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      return { seth: g.units.get('Seth').position, eirika: g.units.get('Eirika').position };
    });
    // Python sorts open spots by (x, y): (2,3) then (5,1).
    expect(placed).toEqual({ seth: [2, 3], eirika: [5, 1] });
  });

  test('closest placement scans like Python and skips untraversable tiles', async ({ page }) => {
    await boot(page);
    const setup = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const eirika = g.units.get('Eirika');
      const [x, y] = eirika.position;
      const seth = g.units.get('Seth');
      if (seth.position) g.board.removeUnit(seth);
      seth.position = null;
      // Ring 1 is scanned left, down, up, right. Wall off the left tile and
      // make sure the tile below is open plain ground.
      g.board.setTerrain(x - 1, y, '9');
      g.board.setTerrain(x, y + 1, '1');
      const below = g.board.getUnit(x, y + 1);
      if (below) { g.board.removeUnit(below); below.position = null; }
      return { target: [x, y] };
    });
    await runEvent(page, 'QaClosest', [
      `add_unit;Seth;${setup.target[0]},${setup.target[1]};immediate;closest`,
    ]);
    const position = await page.evaluate(() => (window as any).__gameRef.units.get('Seth').position);
    expect(position).toEqual([setup.target[0], setup.target[1] + 1]);
  });

  test('{f:unit.field} placeholders read unit and class fields', async ({ page }) => {
    await boot(page);
    await runEvent(page, 'QaFields', [
      'set_unit_field;Eirika;QaHp;5',
      'game_var;qa_f;{f:Eirika.QaHp}',
      'game_var;qa_e;{e:{f:Eirika.QaHp} + 1}',
      'game_var;qa_fallback;{f:Eirika.QaMissing,7}',
    ]);
    const vars = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      return { f: g.gameVars.get('qa_f'), e: g.gameVars.get('qa_e'), fallback: g.gameVars.get('qa_fallback') };
    });
    expect(vars).toEqual({ f: 5, e: 6, fallback: 7 });
  });

  test('end_turn ends the turn and clears every queued event', async ({ page }) => {
    await boot(page);
    await page.evaluate(() => {
      const g = (window as any).__gameRef;
      for (const [nid, source] of [
        ['QaEndTurn', ['end_turn', 'game_var;qa_after_end_turn;1']],
        ['QaQueuedBehind', ['game_var;qa_queued_ran;1']],
      ] as const) {
        g.db.events.set(nid, {
          name: nid, nid, trigger: nid, level_nid: g.currentLevel?.nid ?? null,
          condition: 'True', only_once: false, priority: 0, _source: source,
        });
        g.eventManager.triggerSpecific(nid, { type: nid }, true);
      }
      g.state.change('event');
      (window as any).__harness.stepFrames(10, null);
    });
    const result = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      return {
        phase: g.phase.getCurrent(),
        after: g.gameVars.get('qa_after_end_turn') ?? null,
        queued: g.gameVars.get('qa_queued_ran') ?? null,
      };
    });
    expect(result).toEqual({ phase: 'enemy', after: null, queued: null });
  });

  test('make_generic names units after their faction and joins the party', async ({ page }) => {
    await boot(page);
    await runEvent(page, 'QaGeneric', [
      'make_generic;QaGen;Soldier;1;player;None;;Female',
    ]);
    const result = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const unit = g.units.get('QaGen');
      const firstFaction = g.db.factions.values().next().value;
      return {
        name: unit?.name, faction: unit?.faction, party: unit?.party,
        expectedName: firstFaction?.name, expectedFaction: firstFaction?.nid, currentParty: g.currentParty,
      };
    });
    // Python: a blank faction defaults to the first; variant is not a name.
    expect(result.faction).toBe(result.expectedFaction);
    expect(result.name).toBe(result.expectedName);
    expect(result.party).toBe(result.currentParty);
  });

  test('strict mode accepts Python calls that return None', async ({ page }) => {
    await page.goto('/?harness=true&level=DEBUG&bundle=false&strict=true');
    await page.waitForFunction(() => (window as any).__harness?.ready === true, undefined, {
      timeout: 60_000,
    });
    const result = await page.evaluate(async () => {
      const g = (window as any).__gameRef;
      const { evaluateExpression } = await import('/src/events/event-manager.ts');
      const item = g.units.get('Eirika').items[0];
      try {
        const value = evaluateExpression('game.register_item(copied_item)', {
          game: g, gameVars: g.gameVars, levelVars: g.levelVars,
          localArgs: new Map([['copied_item', item]]),
        } as any);
        return { threw: false, value: value ?? null };
      } catch (error: any) {
        return { threw: true, message: String(error?.message ?? error) };
      }
    });
    expect(result).toEqual({ threw: false, value: null });
  });

  test('music, map_anim, and change_tilemap never skip the following command', async ({ page }) => {
    await boot(page);
    const anim = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      return {
        anim: [...g.db.mapAnimations.keys()][0] ?? null,
        tilemap: g.currentLevel.tilemap,
      };
    });
    await runEvent(page, 'QaNoSkip', [
      'music;None',
      'game_var;qa_after_music;1',
      `map_anim;${anim.anim};2,2`,
      'game_var;qa_after_anim;1',
      `change_tilemap;${anim.tilemap}`,
      'game_var;qa_after_tilemap_1;1',
      'game_var;qa_after_tilemap_2;1',
    ]);
    await page.waitForFunction(() => {
      (window as any).__harness.stepFrames(5, null);
      return (window as any).__gameRef.gameVars.get('qa_after_tilemap_2') === 1;
    }, undefined, { timeout: 15_000 });
    const vars = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      return ['qa_after_music', 'qa_after_anim', 'qa_after_tilemap_1', 'qa_after_tilemap_2']
        .map((key) => g.gameVars.get(key) ?? null);
    });
    expect(vars).toEqual([1, 1, 1, 1]);
  });

  test('push placement moves the occupant to the nearest open tile instead of stacking', async ({ page }) => {
    await boot(page);
    const setup = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const eirika = g.units.get('Eirika');
      const [x, y] = eirika.position;
      const seth = g.units.get('Seth');
      if (seth.position) g.board.removeUnit(seth);
      seth.position = null;
      // Ring 1 is scanned left, down, up, right: wall off the left tile so
      // Eirika is pushed to the open tile below.
      g.board.setTerrain(x - 1, y, '9');
      g.board.setTerrain(x, y + 1, '1');
      const below = g.board.getUnit(x, y + 1);
      if (below) { g.board.removeUnit(below); below.position = null; }
      return { target: [x, y] };
    });
    await runEvent(page, 'QaPush', [
      `add_unit;Seth;${setup.target[0]},${setup.target[1]};immediate;push`,
    ]);
    const placed = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      return {
        seth: g.units.get('Seth').position,
        eirika: g.units.get('Eirika').position,
        boardAtTarget: g.board.getUnit(...g.units.get('Seth').position)?.nid,
      };
    });
    expect(placed.seth).toEqual(setup.target);
    expect(placed.eirika).toEqual([setup.target[0], setup.target[1] + 1]);
    expect(placed.boardAtTarget).toBe('Seth');
  });

  test('add_tag and remove_tag rewind with the turnwheel', async ({ page }) => {
    await boot(page);
    await runEvent(page, 'QaTags', ['add_tag;Eirika;QaDeployed']);
    const result = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const eirika = g.units.get('Eirika');
      const tagged = eirika.tags.includes('QaDeployed');
      (window as any).__harness.turnwheelUndo();
      return { tagged, afterUndo: eirika.tags.includes('QaDeployed') };
    });
    expect(result).toEqual({ tagged: true, afterUndo: false });
  });

  test('move_unit treats no_block in the movement slot as a flag and walks', async ({ page }) => {
    await boot(page);
    const target = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const seth = g.units.get('Seth');
      const moves = g.pathSystem.getValidMoves(seth, g.board)
        .filter((pos: [number, number]) => pos[0] !== seth.position[0] || pos[1] !== seth.position[1]);
      return moves[0];
    });
    await runEvent(page, 'QaMove', [
      `move_unit;Seth;${target[0]},${target[1]};no_block`,
      'game_var;qa_after_move;1',
    ]);
    await page.evaluate(() => (window as any).__harness.stepFrames(120, null));
    const result = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      return { position: g.units.get('Seth').position, after: g.gameVars.get('qa_after_move') };
    });
    expect(result.position).toEqual(target);
    expect(result.after).toBe(1);
  });
});
