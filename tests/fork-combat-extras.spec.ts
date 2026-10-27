import { expect, test, type Page } from '@playwright/test';

/**
 * EOtF engine-fork combat details: how extra damage instances are counted
 * and gated, TrueMiracle against extra damage, Spotlight blocking witch
 * warps, aura children's initiator and item_funcs.has_damage. The extra
 * damage numbers mirror runs of the fork engine (Aqua Knife wielded by a
 * 30 HP unit with no STR, against a 40 HP unit with no DEF).
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

test.describe('EOtF engine fork combat extras', () => {
  test('extra damage: one instance per component, item damage required, flat against TrueMiracle', async ({ page }) => {
    await bootEotf(page);
    const result = await page.evaluate(async (arenaSrc) => {
      const game = (window as any).__gameRef;
      // eslint-disable-next-line no-new-func
      const makeArena = new Function(`${arenaSrc}; return makeArena;`)();
      const { ItemObject } = await import('/src/objects/item.ts');
      const { SkillObject } = await import('/src/objects/skill.ts');
      const { CombatPhaseSolver } = await import('/src/combat/combat-solver.ts');
      const { setForkEngine } = await import('/src/engine/engine-flavor.ts');
      const arena = await makeArena(game, 4);
      if (!arena.origin) return null;
      const [x, y] = arena.origin;
      const user = arena.make('_ExtraUser', 'player');
      const foe = arena.make('_ExtraFoe', 'enemy');
      game.board.setUnit(x, y, user);
      game.board.setUnit(x + 1, y, foe);
      for (const stat of Object.keys(user.stats)) {
        if (stat !== 'HP' && stat !== 'MOV' && stat !== 'CON') { user.stats[stat] = 0; foe.stats[stat] = 0; }
      }
      user.stats.HP = 30; user.currentHp = 30;
      foe.stats.HP = 40;
      foe.items = [];
      const knife = new ItemObject(game.db.items.get('Aqua_Knife'));
      knife.owner = user;
      user.items = [knife];
      user.equippedWeapon = knife;
      const skill = (nid: string) => new SkillObject(game.db.skills.get(nid));
      const strike = (item: any, hp: number) => {
        foe.currentHp = hp;
        const [hit] = new CombatPhaseSolver(() => 0, game).resolve(
          user, item, foe, null, game.db, 'classic', game.board, ['hit1', 'end'],
        );
        return {
          damage: hit.damage,
          extra: hit.extraDamage ?? 0,
          instances: hit.extraDamageInstances ?? 1,
          hpAfter: Math.max(0, hp - hit.damage - (hit.extraDamage ?? 0)),
        };
      };
      try {
        const plain = strike(knife, 40);
        // Pendulum Power Helper: +1 damage, an ED_OR override (a second
        // eval_extra_damage component) and +1 skill extra damage.
        user.skills = [skill('Pendulum_Power_Helper'), skill('Pendulum_Power'), skill('Pendulum_Power')];
        const helper = strike(knife, 40);
        user.skills = [];
        foe.skills = [skill('True_Miracle')];
        const miracleNormal = strike(knife, 5);
        const miracleTotal = strike(knife, 7);
        const miracleNone = strike(knife, 30);
        foe.skills = [];
        // An eval_extra_damage item without a damage hook deals none.
        const noDamage = new ItemObject({
          nid: '_ExtraOnly', name: '_ExtraOnly', desc: '', icon_nid: '', icon_index: [0, 0],
          components: [['weapon', null], ['hit', 100], ['target_enemy', null], ['eval_extra_damage', '5']],
        } as any);
        noDamage.owner = user;
        const noDamageFork = strike(noDamage, 40).extra;
        // A skill eval_extra_damage adds nothing unless the item has the component.
        const plainBlade = new ItemObject({
          nid: '_PlainBlade', name: '_PlainBlade', desc: '', icon_nid: '', icon_index: [0, 0],
          components: [['weapon', null], ['damage', 4], ['hit', 100], ['target_enemy', null]],
        } as any);
        plainBlade.owner = user;
        user.skills = [new SkillObject({
          nid: '_SkillExtra', name: '', desc: '', icon_nid: '', icon_index: [0, 0],
          components: [['eval_extra_damage', '3']],
        } as any)];
        const skillOnlyFork = strike(plainBlade, 40).extra;
        setForkEngine(false);
        const skillOnlyUpstream = strike(plainBlade, 40).extra;
        user.skills = [];
        const noDamageUpstream = strike(noDamage, 40).extra;
        setForkEngine(true);
        return {
          plain, helper, miracleNormal, miracleTotal, miracleNone,
          noDamageFork, noDamageUpstream, skillOnlyFork, skillOnlyUpstream,
        };
      } finally {
        setForkEngine(true);
        arena.cleanup();
      }
    }, ARENA);
    expect(result).not.toBeNull();
    // Fork engine: damage 6 + extra 3, 40 -> 31.
    expect(result!.plain).toEqual({ damage: 6, extra: 3, instances: 1, hpAfter: 31 });
    // Fork engine: damage 7 and two extra_damage brushes of 4, 40 -> 25.
    expect(result!.helper).toEqual({ damage: 7, extra: 8, instances: 2, hpAfter: 25 });
    // TrueMiracle leaves exactly 1 HP whether normal damage alone or normal
    // plus extra damage would be lethal (fork engine: 5 -> 1 and 7 -> 1).
    expect(result!.miracleNormal.hpAfter).toBe(1);
    expect(result!.miracleTotal.hpAfter).toBe(1);
    expect(result!.miracleNone).toEqual({ damage: 6, extra: 3, instances: 1, hpAfter: 21 });
    expect(result!.noDamageFork).toBe(0);
    expect(result!.noDamageUpstream).toBe(5);
    expect(result!.skillOnlyFork).toBe(0);
    expect(result!.skillOnlyUpstream).toBe(3);
  });

  test('Spotlight blocks witch warps and has_damage reads item components', async ({ page }) => {
    await bootEotf(page);
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { SkillObject } = await import('/src/objects/skill.ts');
      const { ItemObject } = await import('/src/objects/item.ts');
      const { witchWarpPositions } = await import('/src/combat/skill-system.ts');
      const { RECORDS } = await import('/src/engine/records.ts');
      const { evaluateCondition } = await import('/src/events/event-manager.ts');
      const { setForkEngine } = await import('/src/engine/engine-flavor.ts');
      const unit = game.units.get('Player');
      const oldSkills = unit.skills;
      const oldTeam = unit.team;
      const oldWeather = RECORDS.get('Weather_level');
      const oldVar = game.gameVars.get('current_weather');
      const ally = { nid: '_WarpAlly', team: 'player', position: [4, 4] };
      const board = {
        getAllUnits: () => [ally],
        checkBounds: (x: number, y: number) => x >= 0 && y >= 0 && x < 12 && y < 12,
        getUnit: (x: number, y: number) => (x === 4 && y === 4 ? ally : null),
        getMovementCost: () => 1,
      };
      try {
        unit.team = 'player';
        unit.skills = [new SkillObject(game.db.skills.get('WitchWarp')), new SkillObject(game.db.skills.get('Spotlight'))];
        RECORDS.replace('Weather_level', 1);
        game.gameVars.set('current_weather', 'Rain');
        const cloudy = witchWarpPositions(unit, board, game.db, game).length;
        game.gameVars.set('current_weather', 'Sun');
        const sunny = witchWarpPositions(unit, board, game.db, game).length;
        setForkEngine(false);
        const sunnyUpstream = witchWarpPositions(unit, board, game.db, game).length;
        setForkEngine(true);

        // item_funcs.has_damage: component presence, a 0 value included.
        const zero = new ItemObject({
          nid: '_ZeroDamage', name: '', desc: '', icon_nid: '', icon_index: [0, 0],
          components: [['weapon', null], ['damage', 0]],
        } as any);
        const none = new ItemObject({
          nid: '_NoDamage', name: '', desc: '', icon_nid: '', icon_index: [0, 0],
          components: [['weapon', null]],
        } as any);
        const ctx = (item: any) => ({ game, unit1: unit, item, localArgs: new Map([['item', item]]) });
        const hasDamage = [
          evaluateCondition('item_funcs.has_damage(unit, item)', ctx(zero)),
          evaluateCondition('item_funcs.has_damage(unit, item)', ctx(none)),
        ];
        setForkEngine(false);
        const hasDamageUpstream = evaluateCondition('item_funcs.has_damage(unit, item)', ctx(zero));
        setForkEngine(true);
        return { cloudy, sunny, sunnyUpstream, hasDamage, hasDamageUpstream };
      } finally {
        setForkEngine(true);
        unit.skills = oldSkills;
        unit.team = oldTeam;
        RECORDS.replace('Weather_level', oldWeather);
        if (oldVar === undefined) game.gameVars.delete('current_weather');
        else game.gameVars.set('current_weather', oldVar);
      }
    });
    expect(result.cloudy).toBeGreaterThan(0);
    expect(result.sunny).toBe(0);
    expect(result.sunnyUpstream).toBe(result.cloudy);
    expect(result.hasDamage).toEqual([true, false]);
    expect(result.hasDamageUpstream).toBe(false);
  });

  test('aura children carry the aura owner as initiator on the fork', async ({ page }) => {
    await bootEotf(page);
    const result = await page.evaluate(async (arenaSrc) => {
      const game = (window as any).__gameRef;
      // eslint-disable-next-line no-new-func
      const makeArena = new Function(`${arenaSrc}; return makeArena;`)();
      const { SkillObject } = await import('/src/objects/skill.ts');
      const { refreshAuras } = await import('/src/combat/aura-system.ts');
      const { setForkEngine } = await import('/src/engine/engine-flavor.ts');
      const arena = await makeArena(game, 4);
      if (!arena.origin) return null;
      const [x, y] = arena.origin;
      const owner = arena.make('_AuraOwner', 'player');
      const ally = arena.make('_AuraAlly', 'player');
      game.board.setUnit(x, y, owner);
      game.board.setUnit(x + 1, y, ally);
      const run = () => {
        owner.skills = [new SkillObject(game.db.skills.get('Sovereign_Stone_Aura'))];
        refreshAuras([owner, ally], game.board, game.db);
        const child = ally.skills.find((skill: any) => skill.nid === 'Sovereign_Stone_Aura_Child');
        const initiator = child?.initiatorNid ?? null;
        owner.skills = [];
        refreshAuras([owner, ally], game.board, game.db);
        return { found: !!child, initiator };
      };
      try {
        const fork = run();
        setForkEngine(false);
        const upstream = run();
        return { fork, upstream };
      } finally {
        setForkEngine(true);
        arena.cleanup();
      }
    }, ARENA);
    expect(result).not.toBeNull();
    expect(result!.fork).toEqual({ found: true, initiator: '_AuraOwner' });
    expect(result!.upstream).toEqual({ found: true, initiator: null });
  });
});
