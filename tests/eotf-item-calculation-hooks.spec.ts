import { expect, test, type Page } from '@playwright/test';

async function bootEotf(page: Page): Promise<void> {
  await page.goto('/?harness=true&project=eotf.ltproj&level=X&clean=true&bundle=false');
  await page.waitForFunction(() => (window as any).__harness?.ready === true, undefined, {
    timeout: 60_000,
  });
}

test.describe('Embrace of the Fog item calculation hooks', () => {
  test('evaluates real damage, hit, weight, and conditional formula components', async ({ page }) => {
    await bootEotf(page);
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { ItemObject } = await import('/src/objects/item.ts');
      const { SkillObject } = await import('/src/objects/skill.ts');
      const itemSystem = await import('/src/combat/item-system.ts');
      const unit = game.units.get('Player');
      const make = (nid: string) => new ItemObject(game.db.items.get(nid));
      const spark = make('Spark');
      const tri1 = make('Tri_Blade');
      const tri2 = make('Tri_Blade');
      const tao = make('Tao_Lance');
      const stone = make('Fire_Stone');
      const rune = make('Fire_Rune');
      const abundance = make('Abundance');
      const old = {
        items: unit.items,
        skills: unit.skills,
        tags: [...unit.tags],
        stats: { ...unit.stats },
      };

      unit.items = [tri1, tri2];
      unit.skills = [];
      unit.tags = [];
      unit.stats.STR = 9;
      unit.stats.MAG = 4;
      unit.stats.CON = 6;
      const mundane = {
        sparkDamage: itemSystem.damage(unit, spark, game),
        sparkHit: itemSystem.hit(unit, spark, game),
        triDamage: itemSystem.damage(unit, tri1, game),
        triAttackSpeed: itemSystem.modifyAttackSpeed(unit, tri1, game),
        triDefenseSpeed: itemSystem.modifyDefenseSpeed(unit, tri1, game),
        triAvoid: itemSystem.modifyAvoid(unit, tri1, game),
        taoDamage: itemSystem.damageFormula(unit, tao, game),
        taoResist: itemSystem.resistFormula(unit, tao, game),
        stoneDamage: itemSystem.damageFormula(unit, stone, game),
        stoneResist: itemSystem.resistFormula(unit, stone, game),
        runeDamage: itemSystem.damageFormula(unit, rune, game),
        runeResist: itemSystem.resistFormula(unit, rune, game),
        abundance: itemSystem.damage(unit, abundance, game),
      };

      unit.skills = [new SkillObject(game.db.skills.get('Focus_Mode'))];
      unit.tags = ['Dragon'];
      unit.stats.MAG = 12;
      const transformed = {
        sparkDamage: itemSystem.damage(unit, spark, game),
        sparkHit: itemSystem.hit(unit, spark, game),
        taoDamage: itemSystem.damageFormula(unit, tao, game),
        taoResist: itemSystem.resistFormula(unit, tao, game),
        stoneDamage: itemSystem.damageFormula(unit, stone, game),
        stoneResist: itemSystem.resistFormula(unit, stone, game),
        runeDamage: itemSystem.damageFormula(unit, rune, game),
        runeResist: itemSystem.resistFormula(unit, rune, game),
      };

      unit.items = old.items;
      unit.skills = old.skills;
      unit.tags = old.tags;
      unit.stats = old.stats;
      return { mundane, transformed };
    });

    expect(result.mundane).toEqual({
      sparkDamage: 6,
      sparkHit: 90,
      triDamage: 16,
      triAttackSpeed: -10,
      triDefenseSpeed: -10,
      triAvoid: -20,
      taoDamage: 'DAMAGE',
      taoResist: 'DEFENSE',
      stoneDamage: 'DAMAGE',
      stoneResist: 'DEFENSE',
      runeDamage: 'MAGIC_DAMAGE',
      runeResist: 'MAGIC_DEFENSE',
      abundance: 9,
    });
    expect(result.transformed).toEqual({
      sparkDamage: 10,
      sparkHit: 80,
      taoDamage: 'MAGIC_DAMAGE',
      taoResist: 'MAGIC_DEFENSE',
      stoneDamage: 'MAGIC_DAMAGE',
      stoneResist: 'WORSE_DEFENSE',
      runeDamage: 'MAGIC_DAMAGE',
      runeResist: 'WORSE_DEFENSE',
    });
  });

  test('applies extra damage as a separate non-critical reversible instance', async ({ page }) => {
    await bootEotf(page);
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { ItemObject } = await import('/src/objects/item.ts');
      const { MapCombat } = await import('/src/combat/map-combat.ts');
      const attacker = game.units.get('Player');
      const defender = game.units.get('Keeper');
      const item = new ItemObject(game.db.items.get('Aqua_Knife'));
      const old = {
        attackerItems: attacker.items,
        attackerAffinity: attacker.affinity,
        attackerSkills: attacker.skills,
        defenderSkills: defender.skills,
        defenderHp: defender.currentHp,
        defenderStats: { ...defender.stats },
        defenderTags: [...defender.tags],
      };
      attacker.items = [item];
      attacker.skills = [];
      defender.skills = [];
      attacker.affinity = 'Water';
      attacker.stats.HP = 30;
      attacker.currentHp = 30;
      defender.stats.HP = 100;
      defender.currentHp = 100;
      defender.tags = [];

      const beforeIndex = game.actionLog.actionIndex;
      const expectedExtraDamage = Math.floor(attacker.maxHp / 5);
      const combat = new MapCombat(
        attacker, item, defender, null, game.db, 'classic', game.board,
        ['crit1', 'end'], undefined, game,
      );
      const strike = (combat as any).strikes[0];
      const beforeHp = defender.currentHp;
      combat.applyResults(game.actionLog);
      const afterIndex = game.actionLog.actionIndex;
      const changedHp = defender.currentHp;
      while (game.actionLog.actionIndex > beforeIndex) game.actionLog.runActionBackward();
      const reversedHp = defender.currentHp;
      while (game.actionLog.actionIndex < afterIndex) game.actionLog.runActionForward();
      const redoneHp = defender.currentHp;

      defender.tags = ['IgnoringDamage'];
      const ignoredCombat = new MapCombat(
        attacker, item, defender, null, game.db, 'classic', game.board,
        ['crit1', 'end'], undefined, game,
      );
      const ignoredStrike = (ignoredCombat as any).strikes[0];

      attacker.items = old.attackerItems;
      attacker.affinity = old.attackerAffinity;
      attacker.skills = old.attackerSkills;
      defender.skills = old.defenderSkills;
      defender.currentHp = old.defenderHp;
      defender.stats = old.defenderStats;
      defender.tags = old.defenderTags;
      return {
        strike: {
          crit: strike.crit,
          damage: strike.damage,
          extraDamage: strike.extraDamage,
        },
        hp: { beforeHp, changedHp, reversedHp, redoneHp },
        ignoredExtraDamage: ignoredStrike.extraDamage,
        expectedExtraDamage,
      };
    });

    expect(result.strike.crit).toBe(true);
    expect(result.strike.extraDamage).toBe(result.expectedExtraDamage);
    expect(result.hp.changedHp).toBe(
      Math.max(0, result.hp.beforeHp - result.strike.damage - result.strike.extraDamage),
    );
    expect(result.hp.reversedHp).toBe(result.hp.beforeHp);
    expect(result.hp.redoneHp).toBe(result.hp.changedHp);
    expect(result.ignoredExtraDamage).toBe(0);
  });

  test('honors exempt weapon types and the Magician rank bypass', async ({ page }) => {
    await bootEotf(page);
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { ItemObject } = await import('/src/objects/item.ts');
      const { itemSystemAvailable, weaponRank, weaponType } =
        await import('/src/combat/item-system.ts');
      const unit = game.units.get('Player');
      const ladyBlade = new ItemObject(game.db.items.get('Lady_Blade'));
      const flareBlade = new ItemObject(game.db.items.get('Flare_Blade'));
      const old = {
        klass: unit.klass,
        tags: [...unit.tags],
        wexp: { ...unit.wexp },
      };
      const classes = [...game.db.classes.values()];
      const noSword = classes.find((klass: any) => !klass.wexp_gain?.Sword?.[0]);
      const swordClass = classes.find((klass: any) => klass.wexp_gain?.Sword?.[0]);
      unit.klass = noSword.nid;
      unit.tags = ['Female'];
      unit.wexp.Sword = 0;
      const exempt = itemSystemAvailable(unit, ladyBlade, game.db, game);

      unit.klass = swordClass.nid;
      unit.tags = [];
      unit.wexp.Sword = 1;
      const belowRank = itemSystemAvailable(unit, flareBlade, game.db, game);
      unit.tags = ['Magician'];
      const magician = itemSystemAvailable(unit, flareBlade, game.db, game);

      unit.klass = old.klass;
      unit.tags = old.tags;
      unit.wexp = old.wexp;
      return {
        exempt,
        belowRank,
        magician,
        ladyType: weaponType(unit, ladyBlade),
        flareRank: weaponRank(unit, flareBlade),
      };
    });

    expect(result).toEqual({
      exempt: true,
      belowRank: false,
      magician: true,
      ladyType: 'Sword',
      flareRank: 'D',
    });
  });

  test('executes every real EotF value in the supported calculation family', async ({ page }) => {
    await bootEotf(page);
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { ItemObject } = await import('/src/objects/item.ts');
      const itemSystem = await import('/src/combat/item-system.ts');
      const unit = game.units.get('Player');
      const componentNids = new Set([
        'damage_any', 'eval_damage', 'eval_damage_any', 'eval_extra_damage',
        'eval_hit', 'eval_weight', 'eval_magic', 'eval_dragon',
        'eval_dragon_magic', 'magic_weapon_rank', 'weapon_type_exempt',
      ]);
      const counts: Record<string, number> = {};
      const failures: string[] = [];
      for (const prefab of game.db.items.values()) {
        const selected = prefab.components.filter(([nid]: [string, any]) =>
          componentNids.has(nid));
        if (selected.length === 0) continue;
        const item = new ItemObject(prefab);
        for (const [nid] of selected) {
          counts[nid] = (counts[nid] ?? 0) + 1;
          let value: unknown;
          if (['damage_any', 'eval_damage', 'eval_damage_any'].includes(nid)) {
            value = itemSystem.damage(unit, item, game);
          } else if (nid === 'eval_extra_damage') {
            value = itemSystem.extraDamage(unit, item, game);
          } else if (nid === 'eval_hit') {
            value = itemSystem.hit(unit, item, game);
          } else if (nid === 'eval_weight') {
            value = itemSystem.modifyAttackSpeed(unit, item, game);
          } else if (['eval_magic', 'eval_dragon', 'eval_dragon_magic'].includes(nid)) {
            value = [
              itemSystem.damageFormula(unit, item, game),
              itemSystem.resistFormula(unit, item, game),
            ];
          } else if (nid === 'magic_weapon_rank') {
            value = itemSystem.weaponRank(unit, item);
          } else {
            value = itemSystem.weaponType(unit, item);
          }
          const valid = Array.isArray(value)
            ? value.every((entry) => typeof entry === 'string')
            : typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value));
          if (!valid) failures.push(`${prefab.nid}:${nid}:${String(value)}`);
        }
      }
      return { counts, failures };
    });

    expect(result.failures).toEqual([]);
    expect(result.counts).toEqual({
      damage_any: 8,
      eval_damage: 33,
      eval_damage_any: 1,
      eval_extra_damage: 9,
      eval_hit: 2,
      eval_weight: 2,
      eval_magic: 1,
      eval_dragon: 23,
      eval_dragon_magic: 13,
      magic_weapon_rank: 5,
      weapon_type_exempt: 26,
    });
  });
});
