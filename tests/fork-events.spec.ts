import { expect, test, type Page } from '@playwright/test';

// EOtF fork event command parity (temp/forkdiff-events.md rows 1, 2, 16, 17).

async function bootEotf(page: Page): Promise<void> {
  await page.goto('/?harness=true&project=eotf.ltproj&level=X&clean=true&bundle=false');
  await page.waitForFunction(() => (window as any).__harness?.ready === true, undefined, {
    timeout: 60_000,
  });
  await page.evaluate(() => (window as any).__harness.stepFrames(5, null));
}

async function runEvent(page: Page, nid: string, source: string[], frames = 30): Promise<void> {
  await page.evaluate(({ nid, source, frames }) => {
    const g = (window as any).__gameRef;
    g.db.events.set(nid, {
      name: nid, nid, trigger: nid, level_nid: g.currentLevel?.nid ?? null,
      condition: 'True', only_once: false, priority: 0, _source: source,
    });
    g.eventManager.triggerSpecific(nid, { type: nid }, true);
    g.state.change('event');
    (window as any).__harness.stepFrames(frames, null);
  }, { nid, source, frames });
}

test.describe('EOtF fork event commands', () => {
  test('end_turn keeps running the event and keeps queued events', async ({ page }) => {
    await bootEotf(page);
    const before = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      for (const [nid, source] of [
        ['QaEndTurn', [
          'end_turn',
          'game_var;qa_after_end_turn;game.phase.get_current()',
          'trigger_script;QaNested',
          'game_var;qa_after_nested;1',
        ]],
        ['QaNested', ['game_var;qa_nested_phase;game.phase.get_current()']],
        ['QaQueuedBehind', ['game_var;qa_queued_ran;1']],
      ] as const) {
        g.db.events.set(nid, {
          name: nid, nid, trigger: nid, level_nid: g.currentLevel?.nid ?? null,
          condition: 'True', only_once: false, priority: 0, _source: source,
        });
      }
      g.eventManager.triggerSpecific('QaEndTurn', { type: 'QaEndTurn' }, true);
      g.eventManager.triggerSpecific('QaQueuedBehind', { type: 'QaQueuedBehind' }, true);
      const phase = g.phase.getCurrent();
      g.state.change('event');
      (window as any).__harness.stepFrames(20, null);
      return phase;
    });
    const result = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      return {
        phase: g.phase.getCurrent(),
        after: g.gameVars.get('qa_after_end_turn') ?? null,
        nested: g.gameVars.get('qa_nested_phase') ?? null,
        afterNested: g.gameVars.get('qa_after_nested') ?? null,
        queued: g.gameVars.get('qa_queued_ran') ?? null,
      };
    });
    expect(before).toBe('player');
    // The rest of the event (and its nested script) ran before the turn
    // changed, then the turn changed and the queued event still ran.
    expect(result.after).toBe('player');
    expect(result.nested).toBe('player');
    expect(result.afterNested).toBe(1);
    expect(result.queued).toBe(1);
    expect(result.phase).not.toBe('player');
  });

  test('silent give_exp uses the fork level cap and parks capped units at 99 exp', async ({ page }) => {
    await bootEotf(page);
    const setup = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const capped = g.units.get('Player');
      const low = g.units.get('Keeper');
      const maxLevel = Number(g.db.classes.get(capped.klass)?.max_level ?? 20);
      capped.level = maxLevel;
      capped.exp = 50;
      low.level = 1;
      low.exp = 50;
      return { maxLevel };
    });
    await runEvent(page, 'QaForkGiveExp', [
      'give_exp;Player;60;silent',
      'give_exp;Keeper;60;silent',
    ]);
    const result = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const capped = g.units.get('Player');
      const low = g.units.get('Keeper');
      return {
        cappedLevel: capped.level, cappedExp: capped.exp,
        lowLevel: low.level, lowExp: low.exp,
      };
    });
    expect(result).toEqual({
      cappedLevel: setup.maxLevel, cappedExp: 99,
      lowLevel: 2, lowExp: 10,
    });
  });

  test('create_unit copy_stats also copies stat cap modifiers', async ({ page }) => {
    await bootEotf(page);
    await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const template = g.units.get('Al');
      template.statCapModifiers = { ...template.statCapModifiers, STR: 5, DEF: -2 };
    });
    await runEvent(page, 'QaForkCopyStats', [
      'create_unit;Al;QaForkClone;;;;;copy_stats',
    ]);
    const result = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const template = g.units.get('Al');
      const clone = g.units.get('QaForkClone');
      return {
        exists: !!clone,
        str: clone?.statCapModifiers?.STR ?? null,
        def: clone?.statCapModifiers?.DEF ?? null,
        stats: JSON.stringify(clone?.stats) === JSON.stringify(template.stats),
      };
    });
    expect(result).toEqual({ exists: true, str: 5, def: -2, stats: true });
  });

  test('lethal upkeep damage kills the unit and fires unit_death with no killer', async ({ page }) => {
    await bootEotf(page);
    const result = await page.evaluate(async () => {
      const { SkillObject } = await import('/src/objects/skill.ts');
      const { applySkillTurnHooks } = await import('/src/engine/skill-turn-lifecycle.ts');
      const g = (window as any).__gameRef;
      const unit = g.units.get('Player');
      g.db.events.set('QaUpkeepDeath', {
        name: 'QaUpkeepDeath', nid: 'QaUpkeepDeath', trigger: 'unit_death',
        level_nid: g.currentLevel?.nid ?? null,
        condition: "unit.nid == 'Player' and not unit2",
        only_once: false, priority: 0,
        _source: ['game_var;qa_upkeep_death;1'],
      });
      if (!unit.position) {
        unit.position = [3, 9];
        g.board.setUnit(3, 9, unit);
      }
      const position = [...unit.position];
      unit.currentHp = 2;
      unit.skills = [new SkillObject({
        nid: '_QaPoison', name: 'Poison', desc: '', icon_nid: '', icon_index: [0, 0],
        components: [['upkeep_damage', 5]],
      })];
      const queue = g.eventManager.eventQueue;
      const priorLength = queue.length;
      applySkillTurnHooks(g, [unit], 'upkeep');
      const queued = queue.slice(priorLength).map((event: any) => event.nid);
      const trigger = queue[priorLength]?.trigger;
      return {
        dead: unit.dead,
        onBoard: g.board.getUnit(position[0], position[1]) === unit,
        queued,
        triggerPosition: trigger?.position ?? null,
        killer: trigger?.unit2 ?? null,
        position,
      };
    });
    expect(result.dead).toBe(true);
    expect(result.onBoard).toBe(false);
    expect(result.queued).toContain('QaUpkeepDeath');
    expect(result.triggerPosition).toEqual(result.position);
    expect(result.killer).toBeNull();
  });
});

// Values below were recorded from EOtF's own engine running the same event
// lines from the hub (level X).
test.describe('EOtF fork event commands (engine-checked)', () => {
  test('heal adds HP scaled by received-heal hooks, plus healer bonuses with Unit2', async ({ page }) => {
    await bootEotf(page);
    const hp = "game_var;{0};game.get_unit('Player').get_hp()";
    const cap = (name: string) => hp.replace('{0}', name);
    await runEvent(page, 'QaForkHeal', [
      'set_current_hp;Player;1', 'heal;Player;10', cap('qa_plain'),
      'set_current_hp;Player;1', 'heal;Player;99', cap('qa_clamped'),
      'set_current_hp;Player;1', 'give_skill;Player;Mending_Circle_Child;no_banner', 'heal;Player;3', cap('qa_received'),
      'set_current_hp;Player;1', 'give_skill;Keeper;HaveFaith;no_banner', 'heal;Player;3;Keeper', cap('qa_healer'),
      'set_current_hp;Player;1', 'give_skill;Player;HaveFaith;no_banner', 'heal;Player;3', cap('qa_self_no_unit2'),
      'set_current_hp;Player;1', 'heal;Player;3;Nobody', cap('qa_missing_healer'),
      'remove_skill;Player;Mending_Circle_Child;no_banner', 'remove_skill;Player;HaveFaith;no_banner',
      'set_current_hp;Player;1', 'give_skill;Player;Blight;no_banner', 'heal;Player;4', cap('qa_blight'),
      'set_current_hp;Player;1', 'give_skill;Player;Self_Neglect;no_banner', 'heal;Player;10', cap('qa_neglect'),
      'set_current_hp;Player;1', 'heal;Player;10;Keeper', cap('qa_neglect_healer'),
    ], 60);
    const result = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      const names = ['plain', 'clamped', 'received', 'healer', 'self_no_unit2',
        'missing_healer', 'blight', 'neglect', 'neglect_healer'];
      return {
        maxHp: g.units.get('Player').maxHp,
        ...Object.fromEntries(names.map((name) => [name, g.gameVars.get(`qa_${name}`) ?? null])),
      };
    });
    expect(result).toEqual({
      maxHp: result.maxHp,
      plain: 11, clamped: result.maxHp, received: 6, healer: 9, self_no_unit2: 6,
      missing_healer: 1, blight: 5, neglect: 1, neglect_healer: 1,
    });
  });
  test('get_tile_units lists the on-map Tile units that get_all_units leaves out', async ({ page }) => {
    await bootEotf(page);
    await runEvent(page, 'QaForkTiles', [
      'game_var;qa_tiles_before;[u.nid for u in game.get_tile_units()]',
      'add_tag;Keeper;Tile',
      'game_var;qa_tiles;[u.nid for u in game.get_tile_units()]',
      "game_var;qa_all;'Keeper' in [u.nid for u in game.get_all_units()]",
    ]);
    const result = await page.evaluate(() => {
      const g = (window as any).__gameRef;
      return {
        before: g.gameVars.get('qa_tiles_before'),
        tiles: g.gameVars.get('qa_tiles'),
        all: g.gameVars.get('qa_all'),
      };
    });
    expect(result).toEqual({ before: [], tiles: ['Keeper'], all: false });
  });

  test('change_objective_* bakes braces when the command runs', async ({ page }) => {
    await bootEotf(page);
    await page.evaluate(() => {
      const g = (window as any).__gameRef;
      g.levelVars.set('win_con', 2);
      g.levelVars.set('all_turn_count', 5);
    });
    await runEvent(page, 'QaForkObjective', [
      'change_objective_simple;Extinguish {v:win_con} / 4,Defeat Boss',
      'game_var;qa_obj_plain;game.level.objective.get("simple")',
      "lvar;obj_simple;'Defeat Grigol,Defeat Bosses {v:win_con} / 4'",
      "change_objective_simple;{e:'{v:obj_simple}' + ', <purple>{v:all_turn_count} turns</>'}",
      'change_objective_win;Seize {v:win_con} / 2,Defend Tower',
    ]);
    const result = await page.evaluate(async () => {
      const { evaluateText } = await import('/src/ui/hud.ts');
      const g = (window as any).__gameRef;
      const stored = {
        plain: g.gameVars.get('qa_obj_plain'),
        lvar: g.levelVars.get('obj_simple'),
        nested: g.currentLevel.objective.simple,
        win: g.currentLevel.objective.win,
      };
      g.levelVars.set('win_con', 3);
      return { ...stored, drawn: evaluateText(g.currentLevel.objective.simple, g) };
    });
    expect(result).toEqual({
      plain: 'Extinguish 2 / 4,Defeat Boss',
      lvar: 'Defeat Grigol,Defeat Bosses 2 / 4',
      nested: 'Defeat Grigol,Defeat Bosses 2 / 4, <purple>5 turns</>',
      win: 'Seize 2 / 2,Defend Tower',
      drawn: 'Defeat Grigol,Defeat Bosses 2 / 4, <purple>5 turns</>',
    });
  });
});
