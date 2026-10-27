import { expect, test, type Page } from '@playwright/test';

/**
 * EOtF engine-fork combat hooks that differ from upstream lt-maker:
 * game.rng_mode / set_mode_rng, item_funcs.is_magic's dragon clauses, the
 * extra_purple damage digits, UNIQUE sight_range, line/all-enemies AOE with
 * no main target, the exact-tile shove check and one-combat multi_target.
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

test.describe('EOtF engine fork combat hooks', () => {
  test('combat uses game.rng_mode and Run_Start can switch it to Classic', async ({ page }) => {
    await bootEotf(page);
    const result = await page.evaluate(() => {
      const game = (window as any).__gameRef;
      game.db.constants.delete('rng_mode');
      const runStart = [...game.db.events.values()].find((event: any) => event.name === '8. Run_Start');
      const source: string[] = (runStart?._source ?? []).map((line: string) => line.trim());
      const before = game.rngMode;
      const saved = game.currentMode.rng_mode;
      game.currentMode.rng_mode = 'Classic';
      const classic = game.rngMode;
      game.currentMode.rng_mode = saved;
      return { before, classic, saved, hasClassic: source.includes('set_mode_rng;Classic') };
    });
    expect(result).toEqual({ before: 'true_hit', classic: 'classic', saved: 'True Hit', hasClassic: true });
  });

  test('is_magic counts eval_dragon on Dragon units and eval_dragon_magic', async ({ page }) => {
    await bootEotf(page);
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { ItemObject } = await import('/src/objects/item.ts');
      const { SkillObject } = await import('/src/objects/skill.ts');
      const { itemIsMagic } = await import('/src/combat/combat-calcs.ts');
      const { available } = await import('/src/combat/item-system.ts');
      const { evaluateExpression } = await import('/src/events/event-manager.ts');
      const { setForkEngine } = await import('/src/engine/engine-flavor.ts');
      // A unit whose class is not Dragon-tagged (Player is a Manakete).
      const unit = [...game.units.values()].find((u: any) => u.position &&
        !(game.db.classes.get(u.klass)?.tags ?? []).includes('Dragon'));
      const make = (nid: string, components: Array<[string, unknown]>) => new ItemObject({
        nid, name: nid, desc: '', icon_nid: '', icon_index: [0, 0], components,
      } as any);
      const breath = make('_Breath', [['weapon', null], ['damage', 3], ['eval_dragon', 'True']]);
      const dragonMagic = make('_DragonMagic', [['weapon', null], ['damage', 3], ['eval_dragon_magic', 'True']]);
      const savedTags = unit.tags;
      const savedSkills = unit.skills;
      const isMagicExpr = (item: any) => evaluateExpression('item_funcs.is_magic(unit, item)', {
        game, unit1: unit, item, localArgs: new Map([['item', item]]),
      } as any);
      unit.tags = savedTags.filter((tag: string) => tag !== 'Dragon');
      const plainBreath = itemIsMagic(unit, breath, 0, game.db);
      unit.tags = [...unit.tags, 'Dragon'];
      const out = {
        plainBreath,
        dragonBreath: itemIsMagic(unit, breath, 0, game.db),
        dragonMagic: itemIsMagic(unit, dragonMagic, 0, game.db),
        expression: isMagicExpr(breath),
        usableBefore: available(unit, dragonMagic, game.db, game),
        usableMuzzled: true,
        upstreamDragonMagic: true,
      };
      unit.skills = [...savedSkills, new SkillObject(game.db.skills.get('Muzzled'))];
      out.usableMuzzled = available(unit, dragonMagic, game.db, game);
      setForkEngine(false);
      out.upstreamDragonMagic = itemIsMagic(unit, dragonMagic, 0, game.db);
      setForkEngine(true);
      unit.tags = savedTags;
      unit.skills = savedSkills;
      return out;
    });
    expect(result).toEqual({
      plainBreath: false,
      dragonBreath: true,
      dragonMagic: true,
      expression: true,
      usableBefore: true,
      usableMuzzled: false,
      upstreamDragonMagic: false,
    });
  });

  test('extra damage uses the purple digits 16 px right of the hit', async ({ page }) => {
    await bootEotf(page);
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const fx = await import('/src/combat/map-unit-fx.ts');
      const { getCombatSprite, preloadCombatSprites } = await import('/src/combat/combat-sprites.ts');
      await preloadCombatSprites(['damage_numbers_small_red', 'damage_numbers_extra_purple']);
      const unit = [...game.units.values()].find((u: any) => u.position);
      fx.clearUnitFx();
      fx.addDamageNumbers(unit, 7, 'small_red');
      fx.addDamageNumbers(unit, 3, 'extra_purple');
      const calls: Array<{ sheet: string; x: number }> = [];
      const red = getCombatSprite('damage_numbers_small_red');
      const purple = getCombatSprite('damage_numbers_extra_purple');
      const surf = {
        scale: 1,
        ctx: {
          globalAlpha: 1,
          imageSmoothingEnabled: false,
          drawImage(canvas: any, _sx: number, _sy: number, _sw: number, _sh: number, dx: number) {
            calls.push({ sheet: canvas === purple?.canvas ? 'purple' : canvas === red?.canvas ? 'red' : 'other', x: dx });
          },
        },
      };
      fx.drawMapDamageNumbers(surf as any, 0, 0, fx.fxNow() + 1000);
      fx.clearUnitFx();
      return { loaded: !!purple, calls, left: unit.position[0] * 16 + 4 };
    });
    expect(result.loaded).toBe(true);
    expect(result.calls).toEqual([
      { sheet: 'red', x: result.left - 4 },
      { sheet: 'purple', x: result.left + 16 - 4 },
    ]);
  });

  test('sight_range resolves UNIQUE (last active bonus) on the fork', async ({ page }) => {
    await bootEotf(page);
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { SkillObject } = await import('/src/objects/skill.ts');
      const { sightRange } = await import('/src/combat/skill-system.ts');
      const { setForkEngine } = await import('/src/engine/engine-flavor.ts');
      const unit = [...game.units.values()].find((u: any) => u.position);
      const saved = unit.skills;
      const make = (nid: string, value: number) => new SkillObject({
        nid, name: nid, desc: '', icon_nid: '', icon_index: [0, 0], components: [['sight_range_bonus', value]],
      } as any);
      unit.skills = [make('_SightA', 5), make('_SightB', 3)];
      const fork = sightRange(unit, game);
      setForkEngine(false);
      const upstream = sightRange(unit, game);
      setForkEngine(true);
      unit.skills = saved;
      return { fork, upstream };
    });
    expect(result).toEqual({ fork: 3, upstream: 8 });
  });

  test('line AOE weapons have no main target and Reposition pulls past the user', async ({ page }) => {
    await bootEotf(page);
    const result = await page.evaluate(async (arenaSrc) => {
      const game = (window as any).__gameRef;
      // eslint-disable-next-line no-new-func
      const makeArena = new Function(`${arenaSrc}; return makeArena;`)();
      const { ItemObject } = await import('/src/objects/item.ts');
      const { splash, targetRestrict } = await import('/src/combat/item-system.ts');
      const { setForkEngine } = await import('/src/engine/engine-flavor.ts');
      const arena = await makeArena(game, 6);
      if (!arena.origin) return null;
      const [x, y] = arena.origin;
      const user = arena.make('_ForkUser', 'player');
      const ally = arena.make('_ForkAlly', 'player');
      const foeA = arena.make('_ForkFoeA', 'enemy');
      const foeB = arena.make('_ForkFoeB', 'enemy');
      game.board.setUnit(x, y, user);
      game.board.setUnit(x + 1, y, foeA);
      game.board.setUnit(x + 2, y, foeB);
      const bolt = new ItemObject({
        nid: '_Bolt', name: '_Bolt', desc: '', icon_nid: '', icon_index: [0, 0],
        components: [['weapon', null], ['damage', 3], ['target_enemy', null], ['enemy_line_aoe', null]],
      } as any);
      const ctx = { board: game.board, db: game.db, game };
      const forkSplash = splash(user, bolt, [x + 2, y], ctx);
      setForkEngine(false);
      const upstreamSplash = splash(user, bolt, [x + 2, y], ctx);
      setForkEngine(true);

      // Reposition (shove -2): the ally adjacent to the user lands behind it.
      game.board.removeUnit(foeA);
      game.board.removeUnit(foeB);
      game.board.setUnit(x + 1, y, ally);
      const reposition = new ItemObject(game.db.items.get('Reposition'));
      const restrictOk = targetRestrict(user, reposition, [x + 1, y], [], ctx);
      const { applyOnHitForcedMovement } = await import('/src/combat/combat-lifecycle.ts');
      const { ActionLog } = await import('/src/engine/action.ts');
      const actionLog = new ActionLog();
      applyOnHitForcedMovement(
        { ...game, actionLog, db: game.db, board: game.board },
        {
          attacker: user, defender: ally, item: reposition, hit: true, crit: false, damage: 0,
          isCounter: false, mode: 'attack', attackInfo: [0, 0],
        } as any,
      );
      const moved = ally.position ? [...ally.position] : null;
      while (actionLog.actionIndex >= 0) actionLog.runActionBackward();
      setForkEngine(false);
      const upstreamRestrict = targetRestrict(user, reposition, [x + 1, y], [], ctx);
      setForkEngine(true);
      arena.cleanup();
      return { origin: [x, y], forkSplash, upstreamSplash, restrictOk, moved, upstreamRestrict };
    }, ARENA);
    expect(result).not.toBeNull();
    const [x, y] = result!.origin;
    expect(result!.forkSplash).toEqual({ mainTarget: null, splash: [[x + 1, y], [x + 2, y]] });
    expect(result!.upstreamSplash).toEqual({ mainTarget: [x + 2, y], splash: [[x + 1, y]] });
    expect(result!.restrictOk).toBe(true);
    expect(result!.moved).toEqual([x - 1, y]);
    expect(result!.upstreamRestrict).toBe(false);
  });

  test('multi_target weapons resolve as one counter-less combat on every target', async ({ page }) => {
    await bootEotf(page);
    const result = await page.evaluate(async (arenaSrc) => {
      const game = (window as any).__gameRef;
      // eslint-disable-next-line no-new-func
      const makeArena = new Function(`${arenaSrc}; return makeArena;`)();
      const { ItemObject } = await import('/src/objects/item.ts');
      const { resolveForkMultiTargetGroup } = await import('/src/engine/states/game-states.ts');
      const { CombatPhaseSolver } = await import('/src/combat/combat-solver.ts');
      const arena = await makeArena(game, 4);
      if (!arena.origin) return null;
      const [x, y] = arena.origin;
      const user = arena.make('_ForkThrower', 'player');
      const foeA = arena.make('_ForkTargetA', 'enemy');
      const foeB = arena.make('_ForkTargetB', 'enemy');
      game.board.setUnit(x, y, user);
      game.board.setUnit(x + 1, y, foeA);
      game.board.setUnit(x + 2, y, foeB);
      const thee = new ItemObject(game.db.items.get('Thee'));
      const lance = new ItemObject(game.db.items.get('Iron_Lance') ?? game.db.items.get('Thee'));
      foeA.items = [lance];
      foeA.equippedWeapon = lance;
      user.items = [thee];
      user.equippedWeapon = thee;
      const group = resolveForkMultiTargetGroup(game, user, thee, [[x + 1, y], [x + 2, y]]);
      const solver = new CombatPhaseSolver(() => 0, game);
      const strikes = solver.resolveGroup(
        user, thee, group.mainDefender, null, group.splashDefenders, game.db, 'classic', game.board,
      );
      const out = {
        main: group.mainDefender,
        splash: group.splashDefenders.map((unit: any) => unit.nid),
        strikes: strikes.map((strike: any) => `${strike.attacker.nid}>${strike.defender.nid}`),
      };
      arena.cleanup();
      return out;
    }, ARENA);
    expect(result).toEqual({
      main: null,
      splash: ['_ForkTargetA', '_ForkTargetB'],
      strikes: ['_ForkThrower>_ForkTargetA', '_ForkThrower>_ForkTargetB'],
    });
  });

  test('the AI aims a multi_target item as one counter-less combat that strikes once per target slot', async ({ page }) => {
    await bootEotf(page);
    const result = await page.evaluate(async (arenaSrc) => {
      const game = (window as any).__gameRef;
      const h = (window as any).__harness;
      // eslint-disable-next-line no-new-func
      const makeArena = new Function(`${arenaSrc}; return makeArena;`)();
      const { ItemObject } = await import('/src/objects/item.ts');
      const arena = await makeArena(game, 4);
      if (!arena.origin) return null;
      const [x, y] = arena.origin;
      const caster = arena.make('_AiSearCaster', 'enemy');
      const foe = arena.make('_AiSearFoe', 'player');
      for (const unit of [caster, foe]) {
        game.units.set(unit.nid, unit);
        unit.skills = [];
        unit.stats.HP = 80;
        unit.currentHp = 80;
      }
      game.board.setUnit(x, y, caster);
      game.board.setUnit(x + 1, y, foe);
      // Sear: multi_target 3. The foe's own weapon could counter at range 1.
      const sear = new ItemObject(game.db.items.get('Sear'));
      sear.owner = caster;
      caster.items = [sear];
      // A Mage with Anima rank C can cast Sear: AIController.attack drops an
      // item the unit cannot use.
      caster.klass = 'Mage';
      caster.wexp = { ...caster.wexp, Anima: 999 };
      const base = game.units.get('Player').equippedWeapon;
      const sword = new ItemObject({
        nid: '_AiSearCounter', name: '_AiSearCounter', desc: '', icon_nid: '', icon_index: [0, 0],
        components: [
          ...[...base.components.entries()].filter(([nid]: [string, unknown]) =>
            !['min_range', 'max_range', 'prf_unit', 'uses', 'c_uses'].includes(nid)),
          ['min_range', 1], ['max_range', 1],
        ],
      } as any);
      sword.owner = foe;
      foe.items = [sword];
      foe.equippedWeapon = sword;
      foe.wexp = { ...game.units.get('Player').wexp };
      const ai = game.state.allStates.get('ai');
      (ai as any).beginAICombat(caster, foe, sear);
      // MoveCameraState holds the combat until the camera centres on it.
      for (let i = 0; i < 120 && !game.state.allStates.get('combat')?.combat; i++) h.stepFrames(1, null);
      const combat = game.state.allStates.get('combat')?.combat;
      if (!combat) return { combat: null, stack: game.state.getStackNames() };
      let guard = 0;
      while (!combat.update(1000) && guard++ < 500) { /* play out */ }
      return {
        primary: combat.primaryDefender?.nid ?? null,
        defenders: combat.defenders.map((unit: any) => unit.nid),
        strikes: combat.strikes.map((strike: any) => `${strike.attacker.nid}>${strike.defender.nid}`),
      };
    }, ARENA);
    // EOtF's engine keeps the AI's `[target] * 3` duplicates in the merged
    // splash list, so Sear strikes its one target three times.
    expect(result).toEqual({
      primary: null,
      defenders: ['_AiSearFoe'],
      strikes: ['_AiSearCaster>_AiSearFoe', '_AiSearCaster>_AiSearFoe', '_AiSearCaster>_AiSearFoe'],
    });
  });

  test('weapon targeting collects multi_target picks and opens one grouped combat', async ({ page }) => {
    await bootEotf(page);
    const result = await page.evaluate(async (arenaSrc) => {
      const game = (window as any).__gameRef;
      const h = (window as any).__harness;
      // eslint-disable-next-line no-new-func
      const makeArena = new Function(`${arenaSrc}; return makeArena;`)();
      const { ItemObject } = await import('/src/objects/item.ts');
      const arena = await makeArena(game, 4);
      if (!arena.origin) return null;
      const [x, y] = arena.origin;
      const user = arena.make('_ForkArcher', 'player');
      const foeA = arena.make('_ForkMarkA', 'enemy');
      const foeB = arena.make('_ForkMarkB', 'enemy');
      for (const unit of [user, foeA, foeB]) game.units.set(unit.nid, unit);
      game.board.setUnit(x, y, user);
      game.board.setUnit(x - 1, y, foeA);
      game.board.setUnit(x + 1, y, foeB);
      // The Player class's own weapon, made a 1-range multi_target 2 item.
      const base = game.units.get('Player').equippedWeapon;
      const thee = new ItemObject({
        nid: '_ForkTwinShot', name: '_ForkTwinShot', desc: '', icon_nid: '', icon_index: [0, 0],
        components: [
          ...[...base.components.entries()].filter(([nid]: [string, unknown]) =>
            !['min_range', 'max_range', 'prf_unit', 'multi_target', 'uses', 'c_uses'].includes(nid)),
          ['min_range', 1], ['max_range', 1], ['multi_target', 2],
        ],
      } as any);
      thee.owner = user;
      user.items = [thee];
      user.equippedWeapon = thee;
      user.wexp = { ...game.units.get('Player').wexp };
      game.selectedUnit = user;
      game.state.change('combat_targeting');
      h.stepFrames(2, null);
      const targeting = game.state.getCurrentState();
      if (targeting?.name !== 'combat_targeting') {
        arena.cleanup();
        return { stack: game.state.getStackNames() };
      }
      const first = (targeting as any).targets?.[0];
      (targeting as any).confirmTarget(first);
      const stillTargeting = game.state.getCurrentState()?.name;
      const second = (targeting as any).targets?.[0];
      (targeting as any).confirmTarget(second);
      h.stepFrames(2, null);
      const combatState = game.state.allStates.get('combat');
      const combat = combatState?.combat;
      const picked = [first?.nid, second?.nid].sort();
      return {
        stillTargeting,
        picked,
        primary: combat?.primaryDefender?.nid ?? null,
        defenders: (combat?.defenders ?? []).map((unit: any) => unit.nid).sort(),
      };
    }, ARENA);
    expect(result).toEqual({
      stillTargeting: 'combat_targeting',
      picked: ['_ForkMarkA', '_ForkMarkB'],
      primary: null,
      defenders: ['_ForkMarkA', '_ForkMarkB'],
    });
  });
});
