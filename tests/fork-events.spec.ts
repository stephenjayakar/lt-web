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
