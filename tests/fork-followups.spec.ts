import { expect, test, type Page } from '@playwright/test';

/**
 * Fork-parity follow-ups: behaviour the EOtF engine fork (and upstream
 * lt-maker) resolves strike by strike or per refresh, pinned against the
 * Python sources.
 */

async function bootEotf(page: Page): Promise<void> {
  await page.goto('/?harness=true&project=eotf.ltproj&level=X&clean=true&bundle=false');
  await page.waitForFunction(() => (window as any).__harness?.ready === true, undefined, { timeout: 60_000 });
}

/** Browser-side helper source: synthetic units on an open row of the map. */
const ARENA = `
  async function makeArena(game, width) {
    const { UnitObject } = await import('/src/objects/unit.ts');
    const template = game.units.get('Player');
    const klass = game.db.classes.get(template.klass);
    let origin = null;
    for (let y = 0; y < game.board.height && !origin; y++) {
      for (let x = 2; x < game.board.width - width; x++) {
        const cells = Array.from({ length: width + 2 }, (_, i) => x - 2 + i);
        if (cells.every((cx) => !game.board.getUnit(cx, y) &&
            game.board.getMovementCost(cx, y, klass.movement_group ?? 'Infantry', game.db) < 99)) {
          origin = [x, y];
          break;
        }
      }
    }
    const made = [];
    const make = (nid, team) => {
      const unit = new UnitObject({
        nid, name: nid, desc: '', variant: null, level: 1, klass: template.klass,
        tags: [], bases: { ...klass.bases }, growths: {}, stat_cap_modifiers: {},
        starting_items: [], learned_skills: [], unit_notes: [], fields: [],
        wexp_gain: {}, portrait_nid: '', affinity: '',
      }, klass);
      unit.team = team;
      unit.skills = [];
      unit.stats.HP = 80;
      unit.currentHp = 80;
      made.push(unit);
      return unit;
    };
    const cleanup = () => {
      for (const unit of made) {
        game.board.removeUnit(unit);
        game.units.delete?.(unit.nid);
      }
    };
    return { origin, make, cleanup };
  }
`;

const SWORD = [
  ['weapon', null], ['target_enemy', null], ['min_range', 1], ['max_range', 1],
  ['damage', 1], ['hit', 100], ['crit', 0], ['weight', 0], ['weapon_type', 'Sword'],
  ['weapon_rank', 'E'],
];

test.describe('EOtF fork-parity follow-ups', () => {
  test('shove moves the target on the hit, so a melee defender cannot counter', async ({ page }) => {
    await bootEotf(page);
    const result = await page.evaluate(async ({ arenaSrc, sword }) => {
      const game = (window as any).__gameRef;
      // eslint-disable-next-line no-new-func
      const makeArena = new Function(`${arenaSrc}; return makeArena;`)();
      const { ItemObject } = await import('/src/objects/item.ts');
      const { MapCombat } = await import('/src/combat/map-combat.ts');
      const { applyCombatItemEndHooks } = await import('/src/combat/combat-lifecycle.ts');
      const arena = await makeArena(game, 4);
      if (!arena.origin) return null;
      const [x, y] = arena.origin;
      const attacker = arena.make('_ShoveAttacker', 'player');
      const defender = arena.make('_ShoveDefender', 'enemy');
      game.board.setUnit(x, y, attacker);
      game.board.setUnit(x + 1, y, defender);
      const shoveSword = new ItemObject({
        nid: '_ShoveSword', name: '_ShoveSword', desc: '', icon_nid: '', icon_index: [0, 0],
        components: [...sword, ['shove', 1]],
      } as any);
      const sword2 = new ItemObject({
        nid: '_PlainSword', name: '_PlainSword', desc: '', icon_nid: '', icon_index: [0, 0],
        components: sword,
      } as any);
      attacker.items = [shoveSword];
      shoveSword.owner = attacker;
      attacker.equippedWeapon = shoveSword;
      defender.items = [sword2];
      sword2.owner = defender;
      defender.equippedWeapon = sword2;
      for (const unit of [attacker, defender]) {
        unit.stats.SPD = 5;
        unit.stats.SKL = 30;
      }

      const before = game.actionLog.actionIndex;
      const combat = new MapCombat(
        attacker, shoveSword, defender, sword2, game.db, 'grandmaster', game.board,
        null, undefined, game,
      );
      // The solver waits for the presentation before solving past the shove.
      const resolvedAtStart = (combat as any).strikes.length;
      const movedAtStart = defender.position ? [...defender.position] : null;
      let guard = 0;
      while (!combat.update(1000) && guard++ < 500) { /* play out */ }
      combat.applyResults(game.actionLog);
      const strikes = (combat as any).strikes.map(
        (strike: any) => `${strike.attacker.nid}>${strike.defender.nid}`,
      );
      // End-of-combat item hooks must not shove a second time.
      applyCombatItemEndHooks(game, (combat as any).strikes);
      const after = defender.position ? [...defender.position] : null;
      while (game.actionLog.actionIndex > before) game.actionLog.runActionBackward();
      const rewound = defender.position ? [...defender.position] : null;
      arena.cleanup();
      return { origin: [x, y], resolvedAtStart, movedAtStart, strikes, after, rewound };
    }, { arenaSrc: ARENA, sword: SWORD });
    expect(result).not.toBeNull();
    const [x, y] = result!.origin;
    expect(result!.resolvedAtStart).toBe(1);
    expect(result!.movedAtStart).toEqual([x + 1, y]);
    expect(result!.strikes).toEqual(['_ShoveAttacker>_ShoveDefender']);
    expect(result!.after).toEqual([x + 2, y]);
    expect(result!.rewound).toEqual([x + 1, y]);
  });

  test('a weapon that runs out of uses mid-combat strikes no more', async ({ page }) => {
    await bootEotf(page);
    const result = await page.evaluate(async ({ arenaSrc, sword }) => {
      const game = (window as any).__gameRef;
      // eslint-disable-next-line no-new-func
      const makeArena = new Function(`${arenaSrc}; return makeArena;`)();
      const { ItemObject } = await import('/src/objects/item.ts');
      const { CombatPhaseSolver } = await import('/src/combat/combat-solver.ts');
      const arena = await makeArena(game, 3);
      if (!arena.origin) return null;
      const [x, y] = arena.origin;
      const attacker = arena.make('_UsesAttacker', 'player');
      const defender = arena.make('_UsesDefender', 'enemy');
      game.board.setUnit(x, y, attacker);
      game.board.setUnit(x + 1, y, defender);
      const makeSword = (nid: string, extra: unknown[][]) => new ItemObject({
        nid, name: nid, desc: '', icon_nid: '', icon_index: [0, 0],
        components: [...sword, ...extra],
      } as any);
      const run = (atkExtra: unknown[][], defExtra: unknown[][], atkSpd: number, defSpd: number) => {
        const atkItem = makeSword('_AtkSword', atkExtra);
        const defItem = makeSword('_DefSword', defExtra);
        attacker.items = [atkItem];
        atkItem.owner = attacker;
        attacker.equippedWeapon = atkItem;
        defender.items = [defItem];
        defItem.owner = defender;
        defender.equippedWeapon = defItem;
        attacker.stats.SPD = atkSpd;
        defender.stats.SPD = defSpd;
        const solver = new CombatPhaseSolver(() => 0, game);
        return solver.resolve(attacker, atkItem, defender, defItem, game.db, 'classic', game.board)
          .map((strike: any) => strike.isCounter ? 'D' : 'A')
          .join('');
      };
      const out = {
        // Attacker doubles; one use: no follow-up.
        attackerOneUse: run([['uses', 1]], [], 30, 0),
        attackerTwoUses: run([['uses', 2]], [], 30, 0),
        // Brave with one use: one strike.
        braveOneUse: run([['uses', 1], ['brave', null]], [], 5, 5),
        // Defender doubles with a one-use weapon: one counter (A D, not A D D).
        defenderOneUse: run([], [['uses', 1]], 0, 30),
        // one_loss_per_combat spends its use at end_combat only.
        oneLossPerCombat: run([['uses', 1], ['uses_options', [['one_loss_per_combat', true]]]], [], 30, 0),
      };
      arena.cleanup();
      return out;
    }, { arenaSrc: ARENA, sword: SWORD });
    expect(result).toEqual({
      attackerOneUse: 'AD',
      attackerTwoUses: 'ADA',
      braveOneUse: 'AD',
      defenderOneUse: 'AD',
      oneLossPerCombat: 'ADA',
    });
  });

  test('a player unit countering on enemy phase earns its weapon exp', async ({ page }) => {
    await bootEotf(page);
    const result = await page.evaluate(async ({ arenaSrc, sword }) => {
      const game = (window as any).__gameRef;
      // eslint-disable-next-line no-new-func
      const makeArena = new Function(`${arenaSrc}; return makeArena;`)();
      const { ItemObject } = await import('/src/objects/item.ts');
      const { MapCombat } = await import('/src/combat/map-combat.ts');
      const arena = await makeArena(game, 3);
      if (!arena.origin) return null;
      const [x, y] = arena.origin;
      const enemy = arena.make('_ExpEnemy', 'enemy');
      const player = arena.make('_ExpPlayer', 'player');
      game.board.setUnit(x, y, enemy);
      game.board.setUnit(x + 1, y, player);
      const arm = (unit: any, nid: string) => {
        const item = new ItemObject({
          nid, name: nid, desc: '', icon_nid: '', icon_index: [0, 0],
          components: [...sword, ['level_exp', null]],
        } as any);
        unit.items = [item];
        item.owner = unit;
        unit.equippedWeapon = item;
        return item;
      };
      const enemyItem = arm(enemy, '_EnemySword');
      const playerItem = arm(player, '_PlayerSword');
      player.exp = 0;
      const fight = (attacker: any, atkItem: any, defender: any, defItem: any) => {
        const before = game.actionLog.actionIndex;
        const combat = new MapCombat(
          attacker, atkItem, defender, defItem, game.db, 'grandmaster', game.board,
          null, undefined, game,
        );
        let guard = 0;
        while (!combat.update(1000) && guard++ < 500) { /* play out */ }
        const results = combat.applyResults(game.actionLog);
        const out = {
          expUnit: results.expUnit?.nid ?? null,
          expGained: results.expGained,
          playerExp: player.exp,
        };
        while (game.actionLog.actionIndex > before) game.actionLog.runActionBackward();
        return { ...out, rewoundExp: player.exp };
      };
      const enemyPhase = fight(enemy, enemyItem, player, playerItem);
      const playerPhase = fight(player, playerItem, enemy, enemyItem);
      arena.cleanup();
      return { enemyPhase, playerPhase };
    }, { arenaSrc: ARENA, sword: SWORD });
    expect(result).not.toBeNull();
    expect(result!.enemyPhase.expUnit).toBe('_ExpPlayer');
    expect(result!.enemyPhase.expGained).toBeGreaterThan(0);
    expect(result!.enemyPhase.playerExp).toBe(result!.enemyPhase.expGained);
    expect(result!.enemyPhase.rewoundExp).toBe(0);
    expect(result!.playerPhase.expUnit).toBe('_ExpPlayer');
    expect(result!.playerPhase.expGained).toBe(result!.enemyPhase.expGained);
  });

  test('Tile units (walls, doors) do not keep a team phase from being skipped', async ({ page }) => {
    await bootEotf(page);
    const result = await page.evaluate(async (arenaSrc) => {
      const game = (window as any).__gameRef;
      // eslint-disable-next-line no-new-func
      const makeArena = new Function(`${arenaSrc}; return makeArena;`)();
      const { PhaseController } = await import('/src/engine/phase.ts');
      const { phaseTeamUnits } = await import('/src/engine/states/game-states.ts');
      const arena = await makeArena(game, 1);
      if (!arena.origin) return null;
      const [x, y] = arena.origin;
      const teams = game.db.teams.defs.map((def: any) => def.nid);
      const others = [...game.units.values()].some((unit: any) => unit.position && unit.team === 'enemy2');
      const wall = arena.make('_PhaseWall', 'enemy2');
      game.board.setUnit(x, y, wall);
      const after = (tags: string[]) => {
        wall.tags = tags;
        const phase = new PhaseController(teams);
        phase.setCurrentTeam('enemy');
        phase.next((team: string) => phaseTeamUnits(game, team));
        return phase.getCurrent();
      };
      const out = { others, tile: after(['Tile']), soldier: after([]) };
      arena.cleanup();
      return out;
    }, ARENA);
    expect(result).not.toBeNull();
    expect(result!.others).toBe(false);
    expect(result!.soldier).toBe('enemy2');
    expect(result!.tile).not.toBe('enemy2');
  });

  test('battle animations draw no digits for EOtF extra damage', async ({ page }) => {
    await bootEotf(page);
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { ItemObject } = await import('/src/objects/item.ts');
      const { AnimationCombat } = await import('/src/combat/animation-combat.ts');
      const attacker = game.units.get('Player');
      const defender = game.units.get('Keeper');
      const old = {
        items: attacker.items, skills: attacker.skills, defSkills: defender.skills,
        hp: defender.currentHp, stats: { ...defender.stats }, tags: [...defender.tags],
      };
      const knife = new ItemObject(game.db.items.get('Aqua_Knife'));
      attacker.items = [knife];
      attacker.skills = [];
      defender.skills = [];
      defender.tags = [];
      defender.stats.HP = 100;
      defender.currentHp = 100;
      const combat = new AnimationCombat(
        attacker, knife, defender, null, game.db, 'classic',
        {} as any, {} as any, true, game.board, ['hit1', 'end'], game,
      );
      const strike = (combat as any).strikes[0];
      (combat as any).applyStrike(false);
      const sheets = (combat as any).damageNumbers.map((digit: any) => digit.sheet);
      attacker.items = old.items;
      attacker.skills = old.skills;
      defender.skills = old.defSkills;
      defender.currentHp = old.hp;
      defender.stats = old.stats;
      defender.tags = old.tags;
      return { damage: strike.damage, extra: strike.extraDamage, sheets };
    });
    expect(result.extra).toBeGreaterThan(0);
    expect(result.sheets).toEqual(String(result.damage).split('').map(() => 'damage_numbers_red'));
  });

  test('a battle-scene screen_blend flash without fade-out draws at full strength', async ({ page }) => {
    await bootEotf(page);
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { AnimationCombat } = await import('/src/combat/animation-combat.ts');
      const { Surface } = await import('/src/engine/surface.ts');
      const attacker = game.units.get('Player');
      const defender = game.units.get('Keeper');
      const item = attacker.items.find((candidate: any) => candidate.isWeapon()) ?? attacker.items[0];
      const combat = new AnimationCombat(
        attacker, item, defender, null, game.db, 'classic',
        {} as any, {} as any, true, game.board, ['miss1', 'end'], game,
      ) as any;
      const red = (frames: number, fade: number) => {
        const surf = new Surface(8, 8);
        combat.screenFlash(frames, [200, 0, 0], fade);
        const reds: number[] = [];
        for (let i = 0; i < frames + fade + 1; i++) {
          surf.ctx.fillStyle = 'rgb(0,0,0)';
          surf.ctx.fillRect(0, 0, 8, 8);
          combat.drawForeground(surf);
          reds.push(surf.ctx.getImageData(1, 1, 1, 1).data[0]);
        }
        return reds;
      };
      return { plain: red(2, 0), fading: red(1, 2) };
    });
    // screen_blend: full colour for its frames, then gone.
    expect(result.plain).toEqual([200, 200, 0]);
    // screen_blend_with_fade_out: full, then frames-left/fade-frames.
    expect(result.fading).toEqual([200, 200, 100, 0]);
  });

  test('an expression choice re-evaluates its options while it is open', async ({ page }) => {
    await bootEotf(page);
    await page.evaluate(() => {
      const game = (window as any).__gameRef;
      game.gameVars.set('_lazy_opts', ['Alpha', 'Beta']);
      game.gameVars.set('_lazy_label', 'Gamma');
      game.db.events.set('_TestLazyChoice', {
        name: '_TestLazyChoice', nid: '_TestLazyChoice', trigger: '_TestLazyChoice',
        level_nid: game.currentLevel?.nid ?? null, condition: 'True', only_once: false, priority: 0,
        _source: ["choice;_lazy;Pick;v('_lazy_opts') + ['{v:_lazy_label}'];expression"],
      });
      game.eventManager.triggerSpecific('_TestLazyChoice', { type: '_TestLazyChoice' }, true);
      game.state.change('event');
    });
    const options = () => page.evaluate(() => {
      const state = (window as any).__gameRef.state.getCurrentState();
      return state?.choiceMenu?.options?.map((option: any) => option.value) ?? null;
    });
    await page.evaluate(() => (window as any).__harness.stepFrames(5));
    const opened = await options();
    await page.evaluate(() => {
      const game = (window as any).__gameRef;
      game.gameVars.set('_lazy_opts', ['Alpha', 'Beta', 'Delta']);
      game.gameVars.set('_lazy_label', 'Omega');
    });
    await page.evaluate(() => (window as any).__harness.stepFrames(2));
    const refreshed = await options();
    expect(opened).toEqual(['Alpha', 'Beta', 'Gamma']);
    expect(refreshed).toEqual(['Alpha', 'Beta', 'Delta', 'Omega']);
  });
});

test.describe('Python strike timing: what each phase is solved against', () => {
  test('on-hit shove destinations are fixed when the phase is solved, not when it is shown', async ({ page }) => {
    await bootEotf(page);
    const result = await page.evaluate(async ({ arenaSrc, sword }) => {
      const game = (window as any).__gameRef;
      // eslint-disable-next-line no-new-func
      const makeArena = new Function(`${arenaSrc}; return makeArena;`)();
      const { ItemObject } = await import('/src/objects/item.ts');
      const { MapCombat } = await import('/src/combat/map-combat.ts');
      const arena = await makeArena(game, 4);
      if (!arena.origin) return null;
      const [x, y] = arena.origin;
      const user = arena.make('_BlastShover', 'player');
      const near = arena.make('_ShovedNear', 'enemy');
      const far = arena.make('_ShovedFar', 'enemy');
      game.board.setUnit(x, y, user);
      game.board.setUnit(x + 1, y, near);
      game.board.setUnit(x + 2, y, far);
      const blast = new ItemObject({
        nid: '_BlastShove', name: '_BlastShove', desc: '', icon_nid: '', icon_index: [0, 0],
        components: [
          ...sword.filter(([nid]: [string, unknown]) => nid !== 'max_range'),
          ['max_range', 2], ['shove', 1],
        ],
      } as any);
      blast.owner = user;
      user.items = [blast];
      user.equippedWeapon = blast;
      near.items = [];
      far.items = [];
      user.stats.SKL = 30;
      const before = game.actionLog.actionIndex;
      // Main target: the far unit; the near one is splash. Both strikes are
      // one Python phase: both shoves are checked against the board before
      // either moves, so the near unit (blocked by the far one) stays put.
      const combat = new MapCombat(
        user, blast, far, null, game.db, 'grandmaster', game.board, null,
        { mainDefender: far, splashDefenders: [near] }, game,
      );
      let guard = 0;
      while (!combat.update(1000) && guard++ < 500) { /* play out */ }
      const strikes = (combat as any).strikes.map(
        (strike: any) => `${strike.attacker.nid}>${strike.defender.nid}:${strike.hit ? 'hit' : 'miss'}`,
      );
      const moved = { near: [...near.position], far: [...far.position] };
      while (game.actionLog.actionIndex > before) game.actionLog.runActionBackward();
      const rewound = { near: [...near.position], far: [...far.position] };
      arena.cleanup();
      return { origin: [x, y], strikes, moved, rewound };
    }, { arenaSrc: ARENA, sword: SWORD });
    expect(result).not.toBeNull();
    const [x, y] = result!.origin;
    expect(result!.strikes).toEqual(['_BlastShover>_ShovedFar:hit', '_BlastShover>_ShovedNear:hit']);
    expect(result!.moved).toEqual({ near: [x + 1, y], far: [x + 3, y] });
    expect(result!.rewound).toEqual({ near: [x + 1, y], far: [x + 2, y] });
  });

  test('later phases read the HP earlier phases left: HP formulas and lifelink', async ({ page }) => {
    await bootEotf(page);
    const result = await page.evaluate(async ({ arenaSrc, sword }) => {
      const game = (window as any).__gameRef;
      // eslint-disable-next-line no-new-func
      const makeArena = new Function(`${arenaSrc}; return makeArena;`)();
      const { ItemObject } = await import('/src/objects/item.ts');
      const { SkillObject } = await import('/src/objects/skill.ts');
      const { CombatPhaseSolver } = await import('/src/combat/combat-solver.ts');
      const arena = await makeArena(game, 3);
      if (!arena.origin) return null;
      const [x, y] = arena.origin;
      const attacker = arena.make('_HpReader', 'player');
      const defender = arena.make('_HpCounter', 'enemy');
      game.board.setUnit(x, y, attacker);
      game.board.setUnit(x + 1, y, defender);
      const skill = (nid: string, components: unknown[][]) => new SkillObject({
        nid, name: nid, desc: '', icon_nid: '', icon_index: [0, 0], components,
      } as any);
      const makeSword = (nid: string, damage: number) => new ItemObject({
        nid, name: nid, desc: '', icon_nid: '', icon_index: [0, 0],
        components: [...sword.filter(([key]: [string, unknown]) => key !== 'damage'), ['damage', damage]],
      } as any);
      const run = (skills: unknown[], atkHp: number, atkDamage: number, defDamage: number) => {
        const atkItem = makeSword('_HpAtkSword', atkDamage);
        const defItem = makeSword('_HpDefSword', defDamage);
        attacker.items = [atkItem];
        atkItem.owner = attacker;
        attacker.equippedWeapon = atkItem;
        defender.items = [defItem];
        defItem.owner = defender;
        defender.equippedWeapon = defItem;
        attacker.skills = skills;
        for (const unit of [attacker, defender]) {
          unit.stats.STR = 0;
          unit.stats.MAG = 0;
          unit.stats.DEF = 0;
          unit.stats.RES = 0;
          unit.stats.SKL = 30;
          unit.stats.LCK = 0;
        }
        attacker.stats.SPD = 30;
        defender.stats.SPD = 0;
        attacker.currentHp = atkHp;
        defender.currentHp = 80;
        const solver = new CombatPhaseSolver(() => 0, game);
        const strikes = solver.resolve(attacker, atkItem, defender, defItem, game.db, 'classic', game.board)
          .map((strike: any) => `${strike.isCounter ? 'D' : 'A'}${strike.damage}`);
        return { strikes, hpAfter: attacker.currentHp };
      };
      // EOtF's damage equation doubles weapon might (5 -> 10, 15 -> 30).
      const out = {
        // (max HP - HP) // 2: the follow-up sees the 30 HP the counter took,
        // 2 * (5 + 15) = 40 (pre-combat HP would give 10).
        formula: run([skill('_HpFormula', [['dynamic_damage', '(unit.get_max_hp() - unit.get_hp()) // 2']])], 80, 5, 15),
        // Lifelink heals 10 before the 34-damage counter: 30 + 10 - 34 = 6,
        // alive to double (30 - 34 would have died).
        lifelink: run([skill('_HpLifelink', [['lifelink', 1.0]])], 30, 5, 17),
      };
      arena.cleanup();
      return out;
    }, { arenaSrc: ARENA, sword: SWORD });
    expect(result).toEqual({
      formula: { strikes: ['A10', 'D30', 'A40'], hpAfter: 80 },
      lifelink: { strikes: ['A10', 'D34', 'A10'], hpAfter: 30 },
    });
  });

  test('live_to_serve heals X of the requested ally heal after every strike', async ({ page }) => {
    await bootEotf(page);
    const result = await page.evaluate(async ({ arenaSrc }) => {
      const game = (window as any).__gameRef;
      // eslint-disable-next-line no-new-func
      const makeArena = new Function(`${arenaSrc}; return makeArena;`)();
      const { ItemObject } = await import('/src/objects/item.ts');
      const { SkillObject } = await import('/src/objects/skill.ts');
      const { CombatPhaseSolver } = await import('/src/combat/combat-solver.ts');
      const { applyCoreTargetedItem } = await import('/src/engine/states/game-states.ts');
      const arena = await makeArena(game, 3);
      if (!arena.origin) return null;
      const [x, y] = arena.origin;
      const healer = arena.make('_Server', 'player');
      const ally = arena.make('_Served', 'player');
      for (const unit of [healer, ally]) game.units.set(unit.nid, unit);
      game.board.setUnit(x, y, healer);
      game.board.setUnit(x + 1, y, ally);
      healer.skills = [new SkillObject(game.db.skills.get('LiveToServe'))];
      const staff = () => {
        const item = new ItemObject({
          nid: '_ServeStaff', name: '_ServeStaff', desc: '', icon_nid: '', icon_index: [0, 0],
          components: [['spell', null], ['target_ally', null], ['min_range', 1], ['max_range', 1], ['heal', 10]],
        } as any);
        item.owner = healer;
        healer.items = [item];
        return item;
      };
      // Item use: the ally is missing 2 HP; Python totals the requested 10.
      healer.currentHp = 50;
      ally.currentHp = 78;
      const before = game.actionLog.actionIndex;
      const used = applyCoreTargetedItem(healer, staff(), [x + 1, y]);
      const itemUse = { used, healer: healer.currentHp, ally: ally.currentHp };
      while (game.actionLog.actionIndex > before) game.actionLog.runActionBackward();
      // Combat path (AI staves): the strike's own after_strike heal.
      healer.currentHp = 50;
      ally.currentHp = 78;
      const item = staff();
      const solver = new CombatPhaseSolver(() => 0, game);
      const [strike] = solver.resolveGroup(healer, item, null, null, [ally], game.db, 'classic', game.board);
      const combat = { selfHeal: strike?.selfSkillHpChange ?? null };
      game.units.delete(healer.nid);
      game.units.delete(ally.nid);
      arena.cleanup();
      return { itemUse, combat };
    }, { arenaSrc: ARENA });
    expect(result).toEqual({
      itemUse: { used: true, healer: 55, ally: 80 },
      combat: { selfHeal: 5 },
    });
  });

  test('item heals in combat land on each hit, not at end of combat', async ({ page }) => {
    await bootEotf(page);
    const result = await page.evaluate(async ({ arenaSrc }) => {
      const game = (window as any).__gameRef;
      // eslint-disable-next-line no-new-func
      const makeArena = new Function(`${arenaSrc}; return makeArena;`)();
      const { ItemObject } = await import('/src/objects/item.ts');
      const { MapCombat } = await import('/src/combat/map-combat.ts');
      const { applyCombatItemEndHooks } = await import('/src/combat/combat-lifecycle.ts');
      const { healAmount } = await import('/src/combat/item-system.ts');
      const arena = await makeArena(game, 3);
      if (!arena.origin) return null;
      const [x, y] = arena.origin;
      const healer = arena.make('_HitHealer', 'enemy');
      const ally = arena.make('_HitHealed', 'enemy');
      game.board.setUnit(x, y, healer);
      game.board.setUnit(x + 1, y, ally);
      // A brave heal: two phases of heal 10 on an ally missing 15 HP.
      const staff = new ItemObject({
        nid: '_HitHealStaff', name: '_HitHealStaff', desc: '', icon_nid: '', icon_index: [0, 0],
        components: [['spell', null], ['target_ally', null], ['min_range', 1], ['max_range', 1],
          ['heal', 10], ['brave', null]],
      } as any);
      staff.owner = healer;
      healer.items = [staff];
      ally.currentHp = 65;
      const heal = healAmount(healer, staff, ally, game);
      const before = game.actionLog.actionIndex;
      const combat = new MapCombat(
        healer, staff, ally, null, game.db, 'classic', game.board, null,
        { mainDefender: null, splashDefenders: [ally] }, game,
      );
      let guard = 0;
      while (!combat.update(1000) && guard++ < 500) { /* play out */ }
      const damages = (combat as any).strikes.map((strike: any) => strike.damage);
      combat.applyResults(game.actionLog);
      const afterCombat = ally.currentHp;
      const endHookActions = applyCombatItemEndHooks(game, (combat as any).strikes);
      const afterHooks = ally.currentHp;
      while (game.actionLog.actionIndex > before) game.actionLog.runActionBackward();
      const rewound = ally.currentHp;
      arena.cleanup();
      return { heal, damages, afterCombat, endHookActions, afterHooks, rewound };
    }, { arenaSrc: ARENA });
    expect(result).toEqual({
      heal: 10,
      damages: [-10, -10],
      afterCombat: 80,
      endHookActions: 0,
      afterHooks: 80,
      rewound: 65,
    });
  });

  test('a splash-only attacker carries its own lifelink HP into later phases', async ({ page }) => {
    await bootEotf(page);
    const result = await page.evaluate(async ({ arenaSrc, sword }) => {
      const game = (window as any).__gameRef;
      // eslint-disable-next-line no-new-func
      const makeArena = new Function(`${arenaSrc}; return makeArena;`)();
      const { ItemObject } = await import('/src/objects/item.ts');
      const { SkillObject } = await import('/src/objects/skill.ts');
      const { CombatPhaseSolver } = await import('/src/combat/combat-solver.ts');
      const arena = await makeArena(game, 3);
      if (!arena.origin) return null;
      const [x, y] = arena.origin;
      const attacker = arena.make('_SplashLeech', 'player');
      const target = arena.make('_SplashTarget', 'enemy');
      game.board.setUnit(x, y, attacker);
      game.board.setUnit(x + 1, y, target);
      for (const unit of [attacker, target]) {
        unit.stats.STR = 0;
        unit.stats.DEF = 0;
        unit.stats.SKL = 30;
        unit.stats.LCK = 0;
      }
      attacker.skills = [new SkillObject({
        nid: '_SplashLeechSkill', name: '', desc: '', icon_nid: '', icon_index: [0, 0],
        components: [['lifelink', 1.0], ['dynamic_damage', '(unit.get_max_hp() - unit.get_hp()) // 2']],
      } as any)];
      const brave = new ItemObject({
        nid: '_SplashBrave', name: '_SplashBrave', desc: '', icon_nid: '', icon_index: [0, 0],
        components: [...sword.filter(([nid]: [string, unknown]) => nid !== 'damage'),
          ['damage', 5], ['brave', null]],
      } as any);
      brave.owner = attacker;
      attacker.items = [brave];
      attacker.equippedWeapon = brave;
      attacker.currentHp = 40;
      // No main target: both brave hits are splash-only phases. The first
      // heals the attacker to full, so the second's HP formula adds nothing.
      const strikes = new CombatPhaseSolver(() => 0, game).resolveGroup(
        attacker, brave, null, null, [target], game.db, 'classic', game.board,
      ).map((strike: any) => strike.damage);
      const hp = attacker.currentHp;
      arena.cleanup();
      return { strikes, hp };
    }, { arenaSrc: ARENA, sword: SWORD });
    // EOtF doubles might: 2 * (5 + (80 - 40) // 2) = 50, then 2 * (5 + 0) = 10.
    expect(result).toEqual({ strikes: [50, 10], hp: 40 });
  });

  test('a shove impact event joins its strike\'s on_hit events in component order', async ({ page }) => {
    await bootEotf(page);
    const result = await page.evaluate(async ({ arenaSrc, sword }) => {
      const game = (window as any).__gameRef;
      // eslint-disable-next-line no-new-func
      const makeArena = new Function(`${arenaSrc}; return makeArena;`)();
      const { ItemObject } = await import('/src/objects/item.ts');
      const { MapCombat } = await import('/src/combat/map-combat.ts');
      const { queueStrikeItemEvents } = await import('/src/combat/combat-lifecycle.ts');
      for (const nid of ['_ShoveImpact', '_ShoveOnHit']) {
        game.db.events.set(nid, {
          name: nid, nid, trigger: nid, level_nid: null, condition: 'True',
          only_once: false, priority: 0, _source: ['wait;1'],
        });
      }
      const arena = await makeArena(game, 4);
      if (!arena.origin) return null;
      const [x, y] = arena.origin;
      const user = arena.make('_ImpactShover', 'player');
      const target = arena.make('_ImpactTarget', 'enemy');
      const wall = arena.make('_ImpactWall', 'enemy');
      game.board.setUnit(x, y, user);
      game.board.setUnit(x + 1, y, target);
      game.board.setUnit(x + 2, y, wall);
      target.items = [];
      user.stats.SKL = 30;
      const shove = ['shove_flex_stops_event', { magnitude: 2, impact_event: '_ShoveImpact' }];
      const onHit = ['event_on_hit', '_ShoveOnHit'];
      const run = (extra: unknown[][]) => {
        const item = new ItemObject({
          nid: '_ImpactItem', name: '_ImpactItem', desc: '', icon_nid: '', icon_index: [0, 0],
          components: [...sword, ...extra],
        } as any);
        item.owner = user;
        user.items = [item];
        user.equippedWeapon = item;
        const combat = new MapCombat(
          user, item, target, null, game.db, 'grandmaster', game.board, null, undefined, game,
          { deferSolve: true },
        );
        const queue = game.eventManager.eventQueue;
        combat.strikeEventHook = (phase: any[]) => {
          const start = queue.length;
          for (const strike of phase) queueStrikeItemEvents(game, strike, 0);
          return queue.splice(start);
        };
        let guard = 0;
        while (!(combat as any).pendingStrikeEvents && guard++ < 50) combat.update(1000);
        const events = ((combat as any).pendingStrikeEvents ?? []).map((event: any) => event.nid);
        const impact = ((combat as any).pendingStrikeEvents ?? [])
          .find((event: any) => event.nid === '_ShoveImpact')?.trigger;
        return { events, occupant: impact?.unit2?.nid ?? null, leftover: queue.length };
      };
      const out = { shoveFirst: run([shove, onHit]), onHitFirst: run([onHit, shove]) };
      arena.cleanup();
      return out;
    }, { arenaSrc: ARENA, sword: SWORD });
    expect(result).toEqual({
      shoveFirst: { events: ['_ShoveImpact', '_ShoveOnHit'], occupant: '_ImpactWall', leftover: 0 },
      onHitFirst: { events: ['_ShoveOnHit', '_ShoveImpact'], occupant: '_ImpactWall', leftover: 0 },
    });
  });
});
