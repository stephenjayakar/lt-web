import { expect, test, type Page } from '@playwright/test';

/**
 * Python CombatEnd carries the combat's full_playback: MarkHit / MarkCrit /
 * MarkMiss brushes with nid, attacker, defender and main_attacker. EOtF's
 * Renpet, Riposte and similar combat_end events filter it with
 * `x.nid in ('mark_crit')`; the port passed the raw strikes, which have no
 * nid, so every such condition raised AttributeError (QA sweep, Act 1).
 */

async function waitForHarness(page: Page): Promise<void> {
  await page.waitForFunction(() => (window as any).__harness?.ready === true, undefined, { timeout: 60_000 });
}

test('combat_end events read Mark* playback brushes', async ({ page }) => {
  const failures: string[] = [];
  page.on('console', (message) => {
    if (message.text().includes('EventCondition JS eval failed')) failures.push(message.text());
  });
  await page.goto('/?harness=true&level=0&clean=true&bundle=false');
  await waitForHarness(page);
  const ready = await page.evaluate(async () => {
    const game = (window as any).__gameRef;
    const { UnitObject } = await import('/src/objects/unit.ts');
    const { ItemObject } = await import('/src/objects/item.ts');
    const template = game.units.get('Eirika');
    const klass = template ? game.db.classes.get(template.klass) : null;
    if (!template || !klass) return false;
    let origin: [number, number] | null = null;
    for (let y = 1; y < game.board.height - 1 && !origin; y++) {
      for (let x = 1; x < game.board.width - 1; x++) {
        if (!game.board.getUnit(x, y) && !game.board.getUnit(x + 1, y)) {
          origin = [x, y];
          break;
        }
      }
    }
    if (!origin) return false;
    const makeUnit = (nid: string, team: string) => {
      const unit = new UnitObject({
        nid, name: nid, desc: '', variant: null, level: 1, klass: template.klass,
        tags: [], bases: { HP: 60, STR: 0, MAG: 0, SKL: 5, SPD: 5, LCK: 0, DEF: 0, RES: 0, CON: 5, MOV: 5 },
        growths: {}, stat_cap_modifiers: {}, starting_items: [], learned_skills: [],
        unit_notes: [], fields: [], wexp_gain: {}, portrait_nid: '', affinity: '',
      } as any, klass);
      unit.team = team;
      unit.currentHp = 60;
      return unit;
    };
    game.db.events.set('_PlaybackEnd', {
      nid: '_PlaybackEnd', name: '_PlaybackEnd', trigger: 'combat_end', level_nid: '0',
      condition: "unit.nid == '_PbAttacker'", only_once: false, priority: 0,
      _source: [
        "game_var;_pb_marks;[x.nid for x in playback]",
        "if;any(p.attacker is unit and (p.main_attacker is unit or p.attacker is p.main_attacker.strike_partner) for p in [x for x in playback if x.nid in ('mark_crit')])",
        'game_var;_pb_crit;1',
        'end',
        "if;any(p.attacker is unit2 for p in [x for x in playback if x.nid in ('mark_miss')])",
        'game_var;_pb_counter_miss;1',
        'end',
      ],
    });
    const attacker = makeUnit('_PbAttacker', 'player');
    const defender = makeUnit('_PbDefender', 'enemy');
    const weapon = (nid: string) => {
      const item = new ItemObject({
        nid, name: nid, desc: '', icon_nid: '', icon_index: [0, 0],
        components: [['weapon', null], ['target_enemy', null], ['damage', 1], ['hit', 100], ['min_range', 1], ['max_range', 1]],
      });
      return item;
    };
    const a = weapon('_PbSword');
    a.owner = attacker;
    attacker.items.push(a);
    attacker.equippedWeapon = a;
    const d = weapon('_PbLance');
    d.owner = defender;
    defender.items.push(d);
    defender.equippedWeapon = d;
    game.board.setUnit(origin[0], origin[1], attacker);
    game.board.setUnit(origin[0] + 1, origin[1], defender);
    game.units.set(attacker.nid, attacker);
    game.units.set(defender.nid, defender);
    game.selectedUnit = attacker;
    game.combatTarget = defender;
    game.combatScript = ['crit1', 'miss2'];
    game.memory.set('combat_item', a);
    game.memory.set('combat_force_no_animation', true);
    (window as any).__pb = { attacker, defender };
    game.state.change('combat');
    return true;
  });
  expect(ready).toBe(true);
  const result = await page.evaluate(async () => {
    const game = (window as any).__gameRef;
    const harness = (window as any).__harness;
    let sawCombat = false;
    for (let frame = 0; frame < 4000; frame++) {
      harness.stepFrames(1, null);
      if (frame % 20 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
      const names: string[] = game.state.getStackNames();
      if (names.includes('combat')) sawCombat = true;
      else if (sawCombat && !game.eventManager?.hasActiveEvents()) break;
    }
    const { attacker, defender } = (window as any).__pb;
    for (const unit of [attacker, defender]) {
      if (unit.position) game.board.removeUnit(unit);
      game.units.delete(unit.nid);
    }
    return {
      marks: game.gameVars.get('_pb_marks'),
      crit: game.gameVars.get('_pb_crit') ?? 0,
      counterMiss: game.gameVars.get('_pb_counter_miss') ?? 0,
    };
  });
  expect(failures).toEqual([]);
  expect(result).toEqual({ marks: ['mark_crit', 'mark_miss'], crit: 1, counterMiss: 1 });
});
