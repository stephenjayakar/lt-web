import { expect, test, type Page } from '@playwright/test';

/**
 * Python event_functions.resurrect: a unit that is still dying (a
 * unit_death event runs before the dying fade) gets game.death.miracle: it
 * leaves dying_units, is never Die'd, and SetHP(1000) heals it. EOtF's
 * TakenPrisoner resurrects the fallen unit this way and turns it to the enemy
 * team; the port finished the death after the event anyway.
 */

async function waitForHarness(page: Page): Promise<void> {
  await page.waitForFunction(() => (window as any).__harness?.ready === true, undefined, { timeout: 60_000 });
}

async function lethalCombatWithResurrect(page: Page, fork: boolean) {
  await page.goto('/?harness=true&level=0&clean=true&bundle=false');
  await waitForHarness(page);
  const ready = await page.evaluate(async (fork) => {
    const game = (window as any).__gameRef;
    const { setForkEngine } = await import('/src/engine/engine-flavor.ts');
    setForkEngine(fork);
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
    const makeUnit = (nid: string, team: string, hp: number) => {
      const unit = new UnitObject({
        nid, name: nid, desc: '', variant: null, level: 1, klass: template.klass,
        tags: [], bases: { HP: 30, STR: 0, MAG: 0, SKL: 5, SPD: 5, LCK: 0, DEF: 0, RES: 0, CON: 5, MOV: 5 },
        growths: {}, stat_cap_modifiers: {}, starting_items: [], learned_skills: [],
        unit_notes: [], fields: [], wexp_gain: {}, portrait_nid: '', affinity: '',
      } as any, klass);
      unit.team = team;
      unit.currentHp = hp;
      return unit;
    };
    game.db.events.set('_ResurrectDying', {
      nid: '_ResurrectDying', name: '_ResurrectDying', trigger: 'unit_death', level_nid: '0',
      condition: "unit1.nid == '_RezDefender'", only_once: false, priority: 0,
      _source: ['resurrect;_RezDefender', 'level_var;_rez_ran;1'],
    });
    const attacker = makeUnit('_RezAttacker', 'player', 30);
    const defender = makeUnit('_RezDefender', 'enemy', 1);
    const item = new ItemObject({
      nid: '_RezSpell', name: '_RezSpell', desc: '', icon_nid: '', icon_index: [0, 0],
      components: [
        ['spell', null], ['target_enemy', null], ['damage', 99], ['hit', 100],
        ['uses', 5], ['min_range', 1], ['max_range', 2],
      ],
    });
    item.owner = attacker;
    attacker.items.push(item);
    game.board.setUnit(origin[0], origin[1], attacker);
    game.board.setUnit(origin[0] + 1, origin[1], defender);
    game.units.set(attacker.nid, attacker);
    game.units.set(defender.nid, defender);
    game.selectedUnit = attacker;
    game.combatTarget = defender;
    game.combatScript = ['hit1'];
    game.memory.set('combat_item', item);
    game.memory.set('combat_force_no_animation', true);
    (window as any).__rez = { attacker, defender };
    game.state.change('combat');
    return true;
  }, fork);
  expect(ready).toBe(true);

  return page.evaluate(async () => {
    const game = (window as any).__gameRef;
    const harness = (window as any).__harness;
    const { attacker, defender } = (window as any).__rez;
    let sawCombat = false;
    for (let frame = 0; frame < 4000; frame++) {
      harness.stepFrames(1, null);
      if (frame % 20 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
      const names: string[] = game.state.getStackNames();
      if (names.includes('combat')) sawCombat = true;
      else if (sawCombat && !game.eventManager?.hasActiveEvents()) break;
    }
    const result = {
      ran: game.levelVars.get('_rez_ran') === 1,
      dead: defender.isDead(),
      onMap: !!defender.position && game.board.getUnit(defender.position[0], defender.position[1]) === defender,
      hp: defender.currentHp,
    };
    const { setForkEngine } = await import('/src/engine/engine-flavor.ts');
    setForkEngine(false);
    for (const unit of [attacker, defender]) {
      if (unit.position) game.board.removeUnit(unit);
      game.units.delete(unit.nid);
    }
    delete (window as any).__rez;
    return result;
  });
}

test.describe('resurrect from a unit_death event', () => {
  for (const fork of [false, true]) {
    test(`a dying unit is miracled, not killed (${fork ? 'fork' : 'upstream'} cleanup)`, async ({ page }) => {
      expect(await lethalCombatWithResurrect(page, fork)).toEqual({ ran: true, dead: false, onMap: true, hp: 30 });
    });
  }
});
