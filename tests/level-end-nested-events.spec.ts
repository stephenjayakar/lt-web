import { expect, test } from '@playwright/test';

/**
 * Python EventState.end_event: the EventState that saw win_game triggers the
 * level_end events and keeps is_handling_end_event; each triggered event runs
 * in its own EventState, and when control returns to the handling one it
 * calls level_end. The port runs every event in one EventState and reset its
 * handling flag whenever a new event started after a pushed state popped, so
 * an outro whose interact_unit fired combat_end events never left the level
 * (QA sweep: EOtF's Gemini and Nikume elites cycled empty turns forever).
 */
test('a level_end event that fights and fires combat_end still ends the level', async ({ page }) => {
  await page.goto('/?harness=true&level=DEBUG&bundle=false');
  await page.waitForFunction(() => !!(window as any).__harness?.ready, { timeout: 15000 });
  const setup = await page.evaluate(async () => {
    const game = (window as any).__gameRef;
    const { GameEvent } = await import('/src/events/event-manager.ts');
    const eirika = game.units.get('Eirika');
    const enemies = [...game.units.values()].filter((u: any) => u.position && u.team !== 'player' && !u.isDead());
    const target = enemies[0];
    if (!eirika || !target) return null;
    const next = [...game.db.levels.keys()].find((nid: string) => nid !== 'DEBUG');
    const define = (nid: string, trigger: string, source: string[]) => {
      const prefab = { nid, name: nid, trigger, level_nid: 'DEBUG', condition: 'True', only_once: false, priority: 0, _source: source };
      game.db.events.set(nid, prefab);
      game.eventManager.allEvents?.set?.(nid, prefab);
    };
    define('_NestedOutro', 'level_end', [
      `interact_unit;Eirika;${target.nid};miss1`,
      'game_var;_outro_done;1',
    ]);
    define('_NestedCombatEnd', 'combat_end', ['game_var;_combat_end_ran;1']);
    const prefab = {
      nid: '_NestedWin', name: '_NestedWin', trigger: 'qa', level_nid: null, condition: 'True',
      only_once: false, priority: 0, _source: [`set_next_chapter;${next}`, 'win_game'],
    };
    game.eventManager.eventQueue.push(new GameEvent(prefab as any, { type: 'qa' } as any, () => game));
    game.state.change('event');
    return { next };
  });
  expect(setup).not.toBeNull();
  const result = await page.evaluate(async () => {
    const game = (window as any).__gameRef;
    const harness = (window as any).__harness;
    let outro = false;
    let combatEnd = false;
    for (let frame = 0; frame < 6000; frame++) {
      harness.stepFrames(1, frame % 7 === 0 ? 'SELECT' : null);
      if (frame % 20 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
      outro ||= game.gameVars.get('_outro_done') === 1;
      combatEnd ||= game.gameVars.get('_combat_end_ran') === 1;
      if (game.gameVars.get('_next_level_nid')) break;
    }
    return { outro, combatEnd, next: game.gameVars.get('_next_level_nid') ?? null };
  });
  expect(result).toEqual({ outro: true, combatEnd: true, next: setup!.next });
});
