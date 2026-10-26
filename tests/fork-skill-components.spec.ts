import { expect, test, type Page } from '@playwright/test';

/**
 * EOtF's engine fork customises several built-in item/skill components
 * (temp/forkdiff-components.md rows 3-16). Each case checks the fork result
 * and, where upstream lt-maker differs, the upstream result with the engine
 * flavour switched off.
 */

async function bootEotf(page: Page): Promise<void> {
  await page.goto('/?harness=true&project=eotf.ltproj&level=X&clean=true&bundle=false');
  await page.waitForFunction(() => (window as any).__harness?.ready === true, undefined, { timeout: 60_000 });
}

test.describe('EOtF engine fork skill and item components', () => {
  test('effective damage: no triangle addition and negate ignores the skill condition', async ({ page }) => {
    await bootEotf(page);
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { ItemObject } = await import('/src/objects/item.ts');
      const { SkillObject } = await import('/src/objects/skill.ts');
      const { dynamicDamage } = await import('/src/combat/item-system.ts');
      const { setForkEngine } = await import('/src/engine/engine-flavor.ts');
      const attacker = game.units.get('Player');
      const defender = game.units.get('Keeper');
      const old = { tags: defender.tags, skills: defender.skills };
      const blade = new ItemObject({
        nid: '_ForkSlayer', name: '_ForkSlayer', desc: '',
        components: [['weapon', null], ['damage', 5], ['effective_damage', {
          effective_tags: ['_ForkArmor'], effective_multiplier: 3,
        }]],
      } as any);
      const guard = new SkillObject({
        nid: '_ForkGuard', name: '_ForkGuard', desc: '',
        components: [['negate_tags', ['_ForkArmor']], ['condition', 'False']],
      } as any);
      const run = () => ({
        bonus: dynamicDamage(attacker, blade, defender, null, 'attack', null, 0, game.db, game, 2),
        negated: (() => {
          defender.skills = [guard];
          const value = dynamicDamage(attacker, blade, defender, null, 'attack', null, 0, game.db, game, 2);
          defender.skills = [];
          return value;
        })(),
      });
      try {
        defender.tags = [...old.tags, '_ForkArmor'];
        defender.skills = [];
        const fork = run();
        setForkEngine(false);
        const upstream = run();
        return { fork, upstream };
      } finally {
        setForkEngine(true);
        defender.tags = old.tags;
        defender.skills = old.skills;
      }
    });
    // Fork: (3 - 1) * 5 and a false-condition negate still negates.
    expect(result.fork).toEqual({ bonus: 10, negated: 0 });
    // Upstream: (3 - 1) * (5 + 2 triangle); the inactive negate is ignored.
    expect(result.upstream).toEqual({ bonus: 14, negated: 14 });
  });

  test('terrain skills, NullCanto, and NoMulti/BlockMulti follow the fork', async ({ page }) => {
    await bootEotf(page);
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { ItemObject } = await import('/src/objects/item.ts');
      const { SkillObject } = await import('/src/objects/skill.ts');
      const { skillConditionActive, cantoMovement } = await import('/src/combat/skill-system.ts');
      const { computeStrikeCount } = await import('/src/combat/combat-calcs.ts');
      const { setForkEngine } = await import('/src/engine/engine-flavor.ts');
      const unit = game.units.get('Player');
      const target = game.units.get('Keeper');
      const old = {
        tags: unit.tags, targetTags: target.tags, skills: unit.skills, movementLeft: unit.movementLeft,
      };
      const terrain = new SkillObject(game.db.skills.get('Avoid10'));
      const make = (nid: string, components: Array<[string, unknown]>) => new SkillObject({
        nid, name: nid, desc: '', icon_nid: '', icon_index: [0, 0], components,
      } as any);
      const brave = (tags: string[]) => new ItemObject({
        nid: '_ForkBrave', name: '_ForkBrave', desc: '',
        components: [['weapon', null], ['damage', 1], ['brave', null], ['item_tags', tags]],
      } as any);
      const run = () => {
        unit.tags = [...old.tags, 'Flying'];
        const terrainOnFlier = skillConditionActive(terrain, unit, { game });
        unit.tags = [...old.tags, 'NullCanto'];
        unit.movementLeft = 4;
        unit.skills = [make('_ForkCanto', [['canto', null]])];
        const canto = cantoMovement(unit, null, game);
        unit.skills = [make('_ForkCanter', [['canter', 3]])];
        const canter = cantoMovement(unit, null, game);
        unit.tags = old.tags;
        unit.skills = [make('_ForkBravery', [['dynamic_multiattacks', '1']])];
        const noMulti = computeStrikeCount(unit, brave(['NoMulti']), target, null, 'attack', [0, 0], game);
        const normal = computeStrikeCount(unit, brave([]), target, null, 'attack', [0, 0], game);
        target.tags = [...old.targetTags, 'BlockMulti'];
        const blockMulti = computeStrikeCount(unit, brave([]), target, null, 'attack', [0, 0], game);
        target.tags = old.targetTags;
        return { terrainOnFlier, canto, canter, noMulti, normal, blockMulti };
      };
      try {
        const fork = run();
        setForkEngine(false);
        const upstream = run();
        return { fork, upstream };
      } finally {
        setForkEngine(true);
        unit.tags = old.tags; target.tags = old.targetTags;
        unit.skills = old.skills; unit.movementLeft = old.movementLeft;
      }
    });
    expect(result.fork).toEqual({
      terrainOnFlier: true, canto: 1, canter: 1, noMulti: 1, normal: 3, blockMulti: 1,
    });
    expect(result.upstream).toEqual({
      terrainOnFlier: false, canto: 4, canter: 3, noMulti: 3, normal: 3, blockMulti: 3,
    });
  });

  test('heal, regeneration, lifelink, and live-to-serve use the fork heal multipliers', async ({ page }) => {
    await bootEotf(page);
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { ItemObject } = await import('/src/objects/item.ts');
      const { SkillObject } = await import('/src/objects/skill.ts');
      const { healAmount } = await import('/src/combat/item-system.ts');
      const { applySkillTurnHooks } = await import('/src/engine/skill-turn-lifecycle.ts');
      const { MapCombat } = await import('/src/combat/map-combat.ts');
      const { setForkEngine } = await import('/src/engine/engine-flavor.ts');
      const attacker = game.units.get('Player');
      const defender = game.units.get('Keeper');
      const old = {
        attackerSkills: attacker.skills, defenderSkills: defender.skills,
        attackerItems: attacker.items, attackerHp: attacker.currentHp, defenderHp: defender.currentHp,
        attackerTeam: attacker.team, defenderTeam: defender.team,
      };
      const make = (nid: string, components: Array<[string, unknown]>) => new SkillObject({
        nid, name: nid, desc: '', icon_nid: '', icon_index: [0, 0], components,
      } as any);
      const staff = new ItemObject({
        nid: '_ForkHeal', name: '_ForkHeal', desc: '', components: [['heal', 10]],
      } as any);
      const weapon = new ItemObject({
        nid: '_ForkLifelinkWeapon', name: '_ForkLifelinkWeapon', desc: '',
        components: [['weapon', null], ['damage', 100], ['hit', 100], ['uses', 20]],
      } as any);
      const run = () => {
        // heal 10 + empower 2, halved by the target's received multiplier.
        attacker.skills = [make('_ForkHealer', [['empower_heal', 2]])];
        defender.skills = [make('_ForkWounds', [['empower_heal_received_multiplier', 0.5]])];
        const heal = healAmount(attacker, staff, defender, game);

        // Regeneration 50% of max HP, halved by the received multiplier.
        defender.skills = [
          make('_ForkRegen', [['regeneration', 0.5]]),
          make('_ForkWounds', [['empower_heal_received_multiplier', 0.5]]),
        ];
        defender.currentHp = 1;
        const effects = applySkillTurnHooks(game, [defender], 'upkeep');
        const regen = effects.find((effect: any) => effect.component === 'regeneration')?.value ?? null;
        defender.currentHp = old.defenderHp;

        // A missed strike: lifelink still heals the striker's empower bonus.
        attacker.team = 'player'; defender.team = 'enemy';
        attacker.items = [weapon];
        attacker.skills = [make('_ForkLifelink', [['lifelink', 0.5], ['empower_heal', 3]])];
        defender.skills = [];
        attacker.currentHp = Math.max(1, attacker.maxHp - 10);
        const hpBefore = attacker.currentHp;
        const miss = new MapCombat(
          attacker, weapon, defender, null, game.db, 'classic', game.board, ['miss1', 'end'], undefined, game,
        );
        const missSelf = miss.strikes[0].selfSkillHpChange;
        // Hit for 6 (defender at 12 HP): lifelink 0.5 * 12 = 6, + 3 empower.
        defender.currentHp = Math.min(12, defender.maxHp);
        const hit = new MapCombat(
          attacker, weapon, defender, null, game.db, 'classic', game.board, ['hit1', 'end'], undefined, game,
        );
        const hitSelf = hit.strikes[0].selfSkillHpChange;
        // Live to serve on a weapon strike heals only the empower bonus (fork).
        attacker.skills = [make('_ForkLiveToServe', [['live_to_serve', 0.5], ['empower_heal', 2]])];
        defender.currentHp = old.defenderHp;
        const serve = new MapCombat(
          attacker, weapon, defender, null, game.db, 'classic', game.board, ['miss1', 'end'], undefined, game,
        );
        const serveSelf = serve.strikes[0].selfSkillHpChange;
        attacker.currentHp = hpBefore;
        return { heal, regen, missSelf, hitSelf, serveSelf };
      };
      try {
        const fork = run();
        setForkEngine(false);
        const upstream = run();
        return { fork, upstream };
      } finally {
        setForkEngine(true);
        attacker.skills = old.attackerSkills; defender.skills = old.defenderSkills;
        attacker.items = old.attackerItems;
        attacker.currentHp = old.attackerHp; defender.currentHp = old.defenderHp;
        attacker.team = old.attackerTeam; defender.team = old.defenderTeam;
      }
    });
    expect(result.fork.heal).toBe(6);
    expect(result.fork.missSelf).toBe(3);
    expect(result.fork.hitSelf).toBe(9);
    expect(result.fork.serveSelf).toBe(2);
    expect(result.upstream).toMatchObject({ heal: 6, missSelf: 0, hitSelf: 6, serveSelf: 0 });
    expect(result.upstream.regen).toBeGreaterThan(result.fork.regen);
  });

  test('live to serve adds the user\'s own heal bonus on item use (fork)', async ({ page }) => {
    await bootEotf(page);
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { ItemObject } = await import('/src/objects/item.ts');
      const { SkillObject } = await import('/src/objects/skill.ts');
      const { applyCoreTargetedItem, setGameRef } = await import('/src/engine/states/game-states.ts');
      setGameRef(game);
      const { setForkEngine } = await import('/src/engine/engine-flavor.ts');
      const unit = game.units.get('Player');
      const old = { skills: unit.skills, hp: unit.currentHp };
      const run = () => {
        const item = new ItemObject({
          nid: '_ForkSelfHeal', name: '', desc: '', icon_nid: '', icon_index: [0, 0],
          components: [['usable', null], ['target_self', null], ['heal', 5], ['uses', 2]],
        } as any);
        unit.items.push(item);
        item.owner = unit;
        unit.skills = [new SkillObject({
          nid: '_ForkServe', name: '', desc: '', components: [['live_to_serve', 0.5], ['empower_heal', 2]],
        } as any)];
        unit.currentHp = 1;
        const before = game.actionLog.actionIndex;
        applyCoreTargetedItem(unit, item, [...unit.position]);
        const gained = unit.currentHp - 1;
        while (game.actionLog.actionIndex > before) game.actionLog.runActionBackward();
        unit.items.splice(unit.items.indexOf(item), 1);
        return gained;
      };
      try {
        const fork = run();
        setForkEngine(false);
        const upstream = run();
        return { fork, upstream };
      } finally {
        setForkEngine(true);
        unit.skills = old.skills;
        unit.currentHp = old.hp;
      }
    });
    // Heal 5 + 2 empower; the fork's LiveToServe then adds _get_heal_amount(0) = 2.
    expect(result).toEqual({ fork: 9, upstream: 7 });
  });

  test('a missed lifelink strike heals the striker in the combat result', async ({ page }) => {
    await bootEotf(page);
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { ItemObject } = await import('/src/objects/item.ts');
      const { SkillObject } = await import('/src/objects/skill.ts');
      const { MapCombat } = await import('/src/combat/map-combat.ts');
      const attacker = game.units.get('Player');
      const defender = game.units.get('Keeper');
      const old = {
        attackerSkills: attacker.skills, defenderSkills: defender.skills, attackerItems: attacker.items,
        attackerHp: attacker.currentHp, defenderHp: defender.currentHp,
        attackerTeam: attacker.team, defenderTeam: defender.team,
      };
      const weapon = new ItemObject({
        nid: '_ForkMissWeapon', name: '_ForkMissWeapon', desc: '',
        components: [['weapon', null], ['damage', 1], ['hit', 100], ['uses', 20]],
      } as any);
      try {
        attacker.team = 'player'; defender.team = 'enemy';
        attacker.items = [weapon];
        attacker.skills = [new SkillObject({
          nid: '_ForkLifelink', name: '', desc: '', components: [['lifelink', 0.5], ['empower_heal', 3]],
        } as any)];
        defender.skills = [];
        attacker.currentHp = Math.max(1, attacker.maxHp - 10);
        const before = attacker.currentHp;
        const beforeIndex = game.actionLog.actionIndex;
        const combat = new MapCombat(
          attacker, weapon, defender, null, game.db, 'classic', game.board, ['miss1', 'end'], undefined, game,
        );
        combat.applyResults(game.actionLog);
        const after = attacker.currentHp;
        while (game.actionLog.actionIndex > beforeIndex) game.actionLog.runActionBackward();
        return { before, after, reversed: attacker.currentHp };
      } finally {
        attacker.skills = old.attackerSkills; defender.skills = old.defenderSkills;
        attacker.items = old.attackerItems;
        attacker.currentHp = old.attackerHp; defender.currentHp = old.defenderHp;
        attacker.team = old.attackerTeam; defender.team = old.defenderTeam;
      }
    });
    expect(result.after).toBe(result.before + 3);
    expect(result.reversed).toBe(result.before);
  });

  test('Thracian Miracle keeps its proc after the parent condition turns off', async ({ page }) => {
    await bootEotf(page);
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { SkillObject } = await import('/src/objects/skill.ts');
      const { ItemObject } = await import('/src/objects/item.ts');
      const { CombatPhaseSolver } = await import('/src/combat/combat-solver.ts');
      const { setForkEngine } = await import('/src/engine/engine-flavor.ts');
      const attacker = game.units.get('Player');
      const defender = game.units.get('Keeper');
      const old = {
        attackerSkills: attacker.skills, defenderSkills: defender.skills,
        attackerItems: attacker.items, defenderItems: defender.items,
        attackerWeapon: attacker.equippedWeapon, defenderWeapon: defender.equippedWeapon,
        attackerHp: attacker.currentHp, defenderHp: defender.currentHp,
        attackerTeam: attacker.team, defenderTeam: defender.team,
      };
      const weapon = new ItemObject({
        nid: '_ForkLethal', name: '_ForkLethal', desc: '',
        components: [['weapon', null], ['damage', 500], ['hit', 100], ['uses', 99]],
      } as any);
      const run = () => {
        const thracian = new SkillObject(game.db.skills.get('Thracian_Miracle'));
        thracian.components.set('proc_rate', 100);
        defender.skills = [thracian];
        defender.currentHp = defender.maxHp;
        const solver = new CombatPhaseSolver(() => 0, game);
        const strikes = solver.resolve(
          attacker, weapon, defender, null, game.db, 'classic', null, ['hit1', 'hit1', 'end'],
        );
        let hp = defender.maxHp;
        const hps = strikes.map((strike: any) => {
          hp -= strike.damage + (strike.extraDamage ?? 0);
          return hp;
        });
        return { hps, remaining: defender.skills.map((skill: any) => skill.nid) };
      };
      try {
        attacker.team = 'player'; defender.team = 'enemy';
        attacker.items = [weapon]; attacker.equippedWeapon = weapon;
        defender.items = []; defender.equippedWeapon = null;
        attacker.skills = [];
        const fork = run();
        setForkEngine(false);
        const upstream = run();
        return { fork, upstream };
      } finally {
        setForkEngine(true);
        attacker.skills = old.attackerSkills; defender.skills = old.defenderSkills;
        attacker.items = old.attackerItems; defender.items = old.defenderItems;
        attacker.equippedWeapon = old.attackerWeapon; defender.equippedWeapon = old.defenderWeapon;
        attacker.currentHp = old.attackerHp; defender.currentHp = old.defenderHp;
        attacker.team = old.attackerTeam; defender.team = old.defenderTeam;
      }
    });
    // Fork: the proc's TrueMiracle stays for the follow-up (cleaned up after combat).
    expect(result.fork.hps).toEqual([1, 1]);
    expect(result.fork.remaining).toEqual(['Thracian_Miracle', 'Thracian_Miracle_Proc']);
    // Upstream: the proc is removed, and at 1 HP the parent no longer procs.
    expect(result.upstream.hps[0]).toBe(1);
    expect(result.upstream.hps[1]).toBeLessThanOrEqual(0);
    expect(result.upstream.remaining).toEqual(['Thracian_Miracle']);
  });

  test('ignore_damage beats TrueMiracle and tags the unit IgnoringDamage', async ({ page }) => {
    await bootEotf(page);
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { SkillObject } = await import('/src/objects/skill.ts');
      const { damagePreventionSkill, additionalTags } = await import('/src/combat/skill-system.ts');
      const { setForkEngine } = await import('/src/engine/engine-flavor.ts');
      const unit = game.units.get('Keeper');
      const old = unit.skills;
      const make = (nid: string, components: Array<[string, unknown]>) => new SkillObject({
        nid, name: nid, desc: '', icon_nid: '', icon_index: [0, 0], components,
      } as any);
      try {
        unit.skills = [make('_ForkMiracle', [['TrueMiracle', null]]), make('_ForkIgnore', [['ignore_damage', null]])];
        const fork = {
          proc: damagePreventionSkill(unit, true, new Set(), game)?.component ?? null,
          tagged: additionalTags(unit, game).has('IgnoringDamage'),
        };
        setForkEngine(false);
        const upstream = {
          proc: damagePreventionSkill(unit, true, new Set(), game)?.component ?? null,
          tagged: additionalTags(unit, game).has('IgnoringDamage'),
        };
        return { fork, upstream };
      } finally {
        setForkEngine(true);
        unit.skills = old;
      }
    });
    expect(result.fork).toEqual({ proc: 'ignore_damage', tagged: true });
    expect(result.upstream).toEqual({ proc: 'ignore_damage', tagged: false });
  });

  test('TrueDamage items resolve alternate formulas to ZERO, overrides included', async ({ page }) => {
    await bootEotf(page);
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { ItemObject } = await import('/src/objects/item.ts');
      const { SkillObject } = await import('/src/objects/skill.ts');
      const { damage, defense } = await import('/src/combat/combat-calcs.ts');
      const { setForkEngine } = await import('/src/engine/engine-flavor.ts');
      const attacker = game.units.get('Player');
      const defender = game.units.get('Keeper');
      const old = { skills: attacker.skills, items: attacker.items };
      const gun = (tags: string[]) => new ItemObject({
        nid: '_ForkGun', name: '_ForkGun', desc: '',
        components: [
          ['weapon', null], ['damage', 7],
          ['alternate_damage_formula', 'ZERO'], ['alternate_resist_formula', 'ZERO'],
          ['item_tags', tags],
        ],
      } as any);
      const magicOverride = new SkillObject({
        nid: '_ForkMagicOverride', name: '', desc: '', components: [['item_override', 'Magic_Override']],
      } as any);
      const run = (tags: string[]) => {
        const item = gun(tags);
        attacker.items = [item];
        item.owner = attacker;
        attacker.skills = [magicOverride];
        const out = {
          damage: damage(attacker, item, game.db, game, defender),
          defense: defense(defender, item, game.db, game.board, game, attacker),
        };
        attacker.skills = old.skills;
        return out;
      };
      try {
        const stats = {
          mag: attacker.getStatValue('MAG'),
          res: defender.getStatValue('RES'),
        };
        const fork = run(['TrueDamage']);
        const exception = run(['TrueDamage', 'TDException']);
        setForkEngine(false);
        const upstream = run(['TrueDamage']);
        return { stats, fork, exception, upstream };
      } finally {
        setForkEngine(true);
        attacker.skills = old.skills;
        attacker.items = old.items;
      }
    });
    expect(result.fork).toEqual({ damage: 7, defense: 0 });
    expect(result.exception).toEqual({ damage: result.stats.mag + 7, defense: result.stats.res });
    expect(result.upstream).toEqual({ damage: result.stats.mag + 7, defense: result.stats.res });
  });

  test('a full player inventory may still GBA-steal', async ({ page }) => {
    await bootEotf(page);
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { ItemObject } = await import('/src/objects/item.ts');
      const { stealItemRestrict, inventoryFull } = await import('/src/combat/item-system.ts');
      const { setForkEngine } = await import('/src/engine/engine-flavor.ts');
      const stealer = game.units.get('Player');
      const target = game.units.get('Keeper');
      const old = { items: stealer.items, team: stealer.team, targetItems: target.items };
      const make = (nid: string, components: Array<[string, unknown]> = []) =>
        new ItemObject({ nid, name: nid, desc: '', components } as any);
      const steal = new ItemObject(game.db.items.get('Steal'));
      const loot = make('_ForkLoot', [['usable', null]]);
      try {
        stealer.team = 'player';
        stealer.items = [steal, ...Array.from({ length: 10 }, (_, i) => make(`_ForkFill${i}`))];
        target.items = [loot];
        const full = inventoryFull(stealer, loot, game.db);
        const fork = stealItemRestrict(stealer, steal, target, loot, game.db);
        setForkEngine(false);
        const upstream = stealItemRestrict(stealer, steal, target, loot, game.db);
        return { full, fork, upstream };
      } finally {
        setForkEngine(true);
        stealer.items = old.items; stealer.team = old.team; target.items = old.targetItems;
      }
    });
    expect(result).toEqual({ full: true, fork: true, upstream: false });
  });
});
