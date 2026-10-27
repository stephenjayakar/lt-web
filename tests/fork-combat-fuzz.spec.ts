import { expect, test, type Page } from '@playwright/test';

/**
 * Regressions found by a differential fuzz of combats against EOtF's own
 * engine (real EOtF units, weapons and skills). Each case keeps the setup the
 * fuzz used: the outcome noted in a comment is the fork engine's.
 */

async function bootEotf(page: Page): Promise<void> {
  await page.goto('/?harness=true&project=eotf.ltproj&level=X&clean=true&bundle=false');
  await page.waitForFunction(() => (window as any).__harness?.ready === true, undefined, { timeout: 60_000 });
}

/** Browser-side helpers: build real units on an open stretch of the map and fight. */
const KIT = `
  async function makeKit(game) {
    const { UnitObject } = await import('/src/objects/unit.ts');
    const { SkillObject } = await import('/src/objects/skill.ts');
    const { createItemTree } = await import('/src/objects/item.ts');
    const { AddSkillAction, EquipItemAction } = await import('/src/engine/action.ts');
    const { MapCombat } = await import('/src/combat/map-combat.ts');
    const { resolveCombatTargetGroup, setGameRef } = await import('/src/engine/states/game-states.ts');
    const calcs = await import('/src/combat/combat-calcs.ts');
    const lifecycle = await import('/src/combat/combat-lifecycle.ts');
    setGameRef(game);
    const db = game.db;
    const template = game.units.get('Player');
    const klass = db.classes.get(template.klass);
    let origin = null;
    for (let y = 1; y < game.board.height - 2 && !origin; y++) {
      for (let x = 2; x < game.board.width - 6; x++) {
        let free = true;
        for (let dx = -2; dx <= 5 && free; dx++) {
          for (let dy = -1; dy <= 1 && free; dy++) {
            if (game.board.getUnit(x + dx, y + dy)) free = false;
          }
        }
        if (free) { origin = [x, y]; break; }
      }
    }
    const made = [];
    const make = (nid, team, opts = {}) => {
      const unitKlass = db.classes.get(opts.klass ?? template.klass);
      const u = new UnitObject({
        nid, name: nid, desc: '', variant: null, level: 10, klass: opts.klass ?? template.klass,
        tags: [], bases: { ...unitKlass.bases }, growths: {}, stat_cap_modifiers: {},
        starting_items: [], learned_skills: [], unit_notes: [], fields: [],
        wexp_gain: {}, portrait_nid: '', affinity: '',
      }, unitKlass);
      u.team = team;
      u.skills = [];
      u.items = [];
      for (const stat of Object.keys(u.stats)) if (stat !== 'MOV' && stat !== 'CON') u.stats[stat] = 0;
      Object.assign(u.stats, opts.stats ?? {});
      u.stats.HP = opts.stats?.HP ?? 30;
      for (const w of [...db.weapons.values()].map((w) => w.nid ?? w)) u.wexp[w] = 999;
      for (const itemNid of opts.items ?? []) {
        const item = createItemTree(db.items.get(itemNid), (n) => db.items.get(n));
        item.owner = u;
        u.items.push(item);
        game.registerItem(item);
        u.onAddItem(item);
      }
      for (const skillNid of opts.skills ?? []) {
        new AddSkillAction(u, new SkillObject(db.skills.get(skillNid))).execute();
      }
      const first = u.items[0];
      if (first && opts.equip !== false && u.canEquip(first)) new EquipItemAction(u, first).execute();
      u.currentHp = opts.hp ?? u.maxHp;
      made.push(u);
      return u;
    };
    const place = (u, dx, dy) => game.registerUnit(u, [origin[0] + dx, origin[1] + dy]);
    // CombatState's flow: target group, map combat, results, end-of-combat hooks.
    const fight = (attacker, target, script = null, item = attacker.items[0]) => {
      const tg = resolveCombatTargetGroup(game, attacker, item, target, target.position);
      const grouped = !tg.mainDefender || tg.splashDefenders.length > 0;
      const defItem = tg.mainDefender ? calcs.getEquippedWeapon(tg.mainDefender, db, game) : null;
      if (tg.mainDefender) lifecycle.queueCombatSkillStartEvents(game, attacker, tg.mainDefender, item, defItem);
      const mc = new MapCombat(
        attacker, item, tg.representative, defItem, db, game.rngMode, game.board, script,
        grouped ? { mainDefender: tg.mainDefender, splashDefenders: tg.splashDefenders } : undefined, game,
      );
      const results = mc.applyResults(game.actionLog);
      lifecycle.applyCombatItemEndHooks(game, mc.strikes);
      lifecycle.applyCombatSkillEndHooks(game, mc.strikes, attacker, tg.mainDefender ? mc.defender : null, mc.procPlayback);
      return { mc, results, strikes: mc.strikes };
    };
    const cleanup = () => { for (const u of made) game.removeUnit(u.nid); };
    const skills = (u) => u.skills.map((s) => s.nid).sort();
    return { origin, make, place, fight, cleanup, skills, calcs, db };
  }
`;

test.describe('EOtF engine fork: combat fuzz regressions', () => {
  test.setTimeout(240_000);
  test('equipped weapon, max-HP clamp, chapter uses and per-phase use cost', async ({ page }) => {
    await bootEotf(page);
    const result = await page.evaluate(async (kitSrc) => {
      const game = (window as any).__gameRef;
      // eslint-disable-next-line no-new-func
      const kit = await (new Function(`${kitSrc}; return makeKit;`)())(game);
      if (!kit.origin) return null;
      try {
        // A unit holding only a weapon it does not equip has no weapon.
        const holder = kit.make('_FzHolder', 'enemy', { items: ['Wary_Maul'], equip: false });
        const resolved = kit.calcs.resolveWeapon(holder);

        // HP_Double: max HP 40 from a 20 HP stat; attacking must not clamp to 20.
        const big = kit.make('_FzBig', 'player', { klass: 'Myrmidon', items: ['Iron_Sword'], skills: ['HP_Double'], stats: { HP: 20, STR: 5 }, hp: 30 });
        const dummy = kit.make('_FzDummy', 'enemy', { stats: { HP: 30 } });
        kit.place(big, 0, 0);
        kit.place(dummy, 1, 0);
        kit.fight(big, dummy, ['hit1', 'end']);
        const bigHp = big.currentHp;
        game.removeUnit(dummy.nid);

        // Mansplitter (chapter uses 3, cleave): one phase striking two foes
        // costs one use; at 0 chapter uses the axe stays in the inventory.
        const axer = kit.make('_FzAxer', 'player', { klass: 'Fighter', items: ['Mansplitter'], stats: { STR: 1 } });
        const foeA = kit.make('_FzFoeA', 'enemy', { stats: { HP: 60 } });
        const foeB = kit.make('_FzFoeB', 'enemy', { stats: { HP: 60 } });
        kit.place(axer, 3, 0);
        kit.place(foeA, 4, 0);
        kit.place(foeB, 3, 1);
        const axe = axer.items[0];
        const cleave = kit.fight(axer, foeA, ['hit1', 'end']);
        const afterOne = axe.data.get('c_uses');
        axe.data.set('c_uses', 1);
        axe.uses = 1;
        kit.fight(axer, foeA, ['hit1', 'end']);
        return {
          resolved, bigHp, bigMax: big.maxHp,
          cleaveTargets: cleave.strikes.map((s: any) => s.defender.nid).sort(),
          afterOne, afterLast: axe.data.get('c_uses'), kept: axer.items.includes(axe),
        };
      } finally {
        kit.cleanup();
      }
    }, KIT);
    expect(result).not.toBeNull();
    expect(result!.resolved).toBeNull();
    expect(result!.bigMax).toBe(40);
    expect(result!.bigHp).toBe(30);
    expect(result!.cleaveTargets).toEqual(['_FzFoeA', '_FzFoeB']);
    expect(result!.afterOne).toBe(2);
    expect(result!.afterLast).toBe(0);
    expect(result!.kept).toBe(true);
  });

  test('end of combat: splash recoil, main-target statuses, override conditions, shared hit sets', async ({ page }) => {
    await bootEotf(page);
    const result = await page.evaluate(async (kitSrc) => {
      const game = (window as any).__gameRef;
      // eslint-disable-next-line no-new-func
      const kit = await (new Function(`${kitSrc}; return makeKit;`)())(game);
      if (!kit.origin) return null;
      try {
        // Explode (no main target) burns its target; Burning's better_recoil
        // then costs it 4 more HP at end_combat. Bleed Smoke's
        // give_status_after_combat has no target in such a combat.
        const caster = kit.make('_FzCaster', 'player', { klass: 'Cleric', items: ['Explode'], skills: ['Bleed_Smoke', 'Nimble'], stats: { MAG: 5 } });
        const burnt = kit.make('_FzBurnt', 'enemy', { stats: { HP: 40 } });
        const doomed = kit.make('_FzDoomed', 'enemy', { stats: { HP: 3 }, hp: 3 });
        kit.place(caster, 0, 0);
        kit.place(burnt, 2, 0);
        kit.place(doomed, 2, 1);
        const blast = kit.fight(caster, burnt, ['hit1', 'end']);
        const dealt = blast.strikes.find((s: any) => s.defender === burnt)?.damage ?? 0;
        const burntHp = burnt.currentHp;
        const burntSkills = kit.skills(burnt);
        const casterSkills = kit.skills(caster);
        game.removeUnit(burnt.nid);
        game.removeUnit(doomed.nid);

        // Scorch (Fire) with the Animus strikes: only Burn Strike's override
        // is active (its combat_condition snapshot), so the target burns and
        // is not dazzled.
        const striker = kit.make('_FzStriker', 'player', {
          klass: 'Mage', items: ['Scorch'], stats: { MAG: 5 },
          skills: ['Animus_Strike', 'Burn_Strike', 'Ice_Strike', 'Thunder_Strike'],
        });
        const struck = kit.make('_FzStruck', 'enemy', { stats: { HP: 60 } });
        kit.place(striker, 4, 0);
        kit.place(struck, 5, 0);
        kit.fight(striker, struck, ['hit1', 'end']);
        const struckSkills = kit.skills(struck);
        game.removeUnit(striker.nid);
        game.removeUnit(struck.nid);

        // Steel Knife (Toxin) against a countering Upheaval (Exposed): the
        // shared hit set lets the initiator's knife poison both, and the
        // axe's Exposed is never given.
        const knifer = kit.make('_FzKnifer', 'player', { klass: 'Thief', items: ['Steel_Knife'], stats: { HP: 60, STR: 1 } });
        const axeman = kit.make('_FzAxeman', 'enemy', { klass: 'Fighter', items: ['Upheaval'], stats: { HP: 60, STR: 1 } });
        kit.place(knifer, 0, 1);
        kit.place(axeman, 2, 1);
        const duel = kit.fight(knifer, axeman, ['hit1', 'hit2', 'end']);
        return {
          dealt, burntHp, burntSkills, casterSkills, struckSkills,
          duelStrikes: duel.strikes.length,
          kniferSkills: kit.skills(knifer), axemanSkills: kit.skills(axeman),
        };
      } finally {
        kit.cleanup();
      }
    }, KIT);
    expect(result).not.toBeNull();
    expect(result!.burntSkills).toContain('Burning');
    expect(result!.burntHp).toBe(40 - result!.dealt - 4);
    expect(result!.burntSkills).not.toContain('Bleeding');
    // A splash kill in a combat without a main target grants no kill skill.
    expect(result!.casterSkills).not.toContain('Nimble_Child');
    expect(result!.struckSkills).toContain('Burning');
    expect(result!.struckSkills).not.toContain('Dazzled');
    expect(result!.duelStrikes).toBe(2);
    expect(result!.kniferSkills).toContain('Toxin');
    expect(result!.axemanSkills).toContain('Toxin');
    expect(result!.kniferSkills).not.toContain('Exposed');
  });

  test('conditions: armsthrift, combat-conditioned ignore_damage, splash Miracle, hidden(), clamp, cleave order', async ({ page }) => {
    await bootEotf(page);
    const result = await page.evaluate(async (kitSrc) => {
      const game = (window as any).__gameRef;
      // eslint-disable-next-line no-new-func
      const kit = await (new Function(`${kitSrc}; return makeKit;`)())(game);
      if (!kit.origin) return null;
      const { evaluatePythonInContext } = await import('/src/events/event-manager.ts');
      const { splash } = await import('/src/combat/item-system.ts');
      const { SkillObject } = await import('/src/objects/skill.ts');
      try {
        // Alpha Sanctuary's armsthrift needs Formation Alpha: uses are spent.
        const thrifty = kit.make('_FzThrifty', 'player', { klass: 'Fighter', items: ['Mansplitter'], skills: ['Alpha_Sanctuary'], stats: { STR: 1 } });
        // Divine Barrier Helper ignores damage only with 3+ foes near.
        const barrier = kit.make('_FzBarrier', 'enemy', { skills: ['Divine_Barrier_Helper'], stats: { HP: 40 } });
        kit.place(thrifty, 0, 0);
        kit.place(barrier, 1, 0);
        const hit = kit.fight(thrifty, barrier, ['hit1', 'end']);
        const thriftUses = thrifty.items[0].data.get('c_uses');
        const barrierHp = barrier.currentHp;
        const barrierDealt = hit.strikes[0].damage;
        game.removeUnit(thrifty.nid);
        game.removeUnit(barrier.nid);

        // Legend (full miracle) on a splash unit of an Explode: revived to full.
        const caster = kit.make('_FzCaster2', 'player', { klass: 'Cleric', items: ['Explode'], stats: { MAG: 20 } });
        const main = kit.make('_FzMain', 'enemy', { stats: { HP: 40 } });
        const legend = kit.make('_FzLegend', 'enemy', { skills: ['Legend'], stats: { HP: 20 }, hp: 2 });
        legend.skills.find((s: any) => s.nid === 'Legend').data.set('charge', 1);
        kit.place(caster, 0, 1);
        kit.place(main, 2, 1);
        kit.place(legend, 3, 1);
        kit.fight(caster, main, ['hit1', 'end']);
        const legendHp = legend.currentHp;

        // skill_system.hidden counts an inactive hidden_if_inactive skill.
        const spotlight = new SkillObject(kit.db.skills.get('Spotlight'));
        main.skills.push(spotlight);
        spotlight.ownerNid = main.nid;
        const ctx = { game, unit1: main, localArgs: new Map([['s', spotlight]]) };
        const hidden = evaluatePythonInContext('skill_system.hidden(s, unit)', ctx as any);
        const clamp = evaluatePythonInContext('utils.clamp(0, 10, -33)', { game } as any);

        // Enemy Cleave in the engine's set order (fork engine: [(4, 7), (3, 5)]).
        const user = { nid: '_FzCleaver', team: 'player', position: [3, 6], skills: [], tags: [], klass: game.units.get('Player').klass };
        const units = new Map([['2,6', { nid: 'a', team: 'enemy', position: [2, 6], skills: [], tags: [] }],
          ['4,7', { nid: 'b', team: 'enemy', position: [4, 7], skills: [], tags: [] }],
          ['3,5', { nid: 'c', team: 'enemy', position: [3, 5], skills: [], tags: [] }]]);
        const board = {
          width: 30, height: 30, getUnit: (x: number, y: number) => units.get(`${x},${y}`) ?? null,
          inBounds: () => true, checkBounds: () => true, getAllUnits: () => [...units.values()],
        };
        const { ItemObject } = await import('/src/objects/item.ts');
        const hunger = new ItemObject(kit.db.items.get('Hunger'));
        const cleave = splash(user as any, hunger, [2, 6], { board, db: kit.db, game } as any);
        return {
          thriftUses, barrierHp, barrierDealt, legendHp,
          hidden: hidden.ok ? hidden.value : String(hidden.error), clamp: clamp.ok ? clamp.value : null,
          cleave,
        };
      } finally {
        kit.cleanup();
      }
    }, KIT);
    expect(result).not.toBeNull();
    expect(result!.thriftUses).toBe(2);
    expect(result!.barrierDealt).toBeGreaterThan(0);
    expect(result!.barrierHp).toBe(40 - result!.barrierDealt);
    // Revived to full by cleanup_combat, then Explode's Burning recoils 4 at
    // end_combat (fork engine order): 20 - 4.
    expect(result!.legendHp).toBe(16);
    expect(result!.hidden).toBe(true);
    expect(result!.clamp).toBe(0);
    expect(result!.cleave).toEqual({ mainTarget: [2, 6], splash: [[4, 7], [3, 5]] });
  });
});
