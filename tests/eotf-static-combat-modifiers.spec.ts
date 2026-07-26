import { expect, test, type Page } from '@playwright/test';

async function bootEotf(page: Page): Promise<void> {
  await page.goto('/?harness=true&project=eotf.ltproj&level=X&clean=true&bundle=false');
  await page.waitForFunction(() => (window as any).__harness?.ready === true, undefined, {
    timeout: 30_000,
  });
}

test.describe('Embrace of the Fog conditional static combat modifiers', () => {
  test('count-locks all 1,999 authored component uses and value shapes', async ({ page }) => {
    await bootEotf(page);
    const inventory = await page.evaluate(() => {
      const game = (window as any).__gameRef;
      const selected = new Set([
        'attack_speed', 'avoid', 'cannot_double', 'combat_condition', 'condition',
        'crit', 'crit_avoid', 'damage', 'damage_multiplier', 'defense_speed',
        'hit', 'resist', 'resist_multiplier', 'stat_change',
      ]);
      const counts: Record<string, number> = {};
      const invalid: string[] = [];
      for (const skill of game.db.skills.values()) {
        for (const [nid, value] of skill.components) {
          if (!selected.has(nid)) continue;
          counts[nid] = (counts[nid] ?? 0) + 1;
          if ((nid === 'condition' || nid === 'combat_condition') &&
              typeof value !== 'string') invalid.push(`${skill.nid}:${nid}`);
          else if (nid === 'stat_change' && (!Array.isArray(value) ||
              value.some((entry: unknown) => !Array.isArray(entry) ||
                typeof entry[0] !== 'string' || typeof entry[1] !== 'number'))) {
            invalid.push(`${skill.nid}:${nid}`);
          } else if (nid === 'cannot_double' && value !== null) {
            invalid.push(`${skill.nid}:${nid}`);
          } else if (!['condition', 'combat_condition', 'stat_change', 'cannot_double'].includes(nid) &&
              typeof value !== 'number') invalid.push(`${skill.nid}:${nid}`);
        }
      }
      return { counts, invalid };
    });

    expect(inventory.invalid).toEqual([]);
    expect(inventory.counts).toEqual({
      attack_speed: 32,
      avoid: 76,
      cannot_double: 39,
      combat_condition: 472,
      condition: 558,
      crit: 81,
      crit_avoid: 33,
      damage: 49,
      damage_multiplier: 24,
      defense_speed: 30,
      hit: 115,
      resist: 37,
      resist_multiplier: 35,
      stat_change: 418,
    });
    expect(Object.values(inventory.counts)
      .reduce((total, count) => total + count, 0)).toBe(1999);
  });

  test('applies condition, combat snapshot, and charge gates to every hook', async ({ page }) => {
    await bootEotf(page);
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { SkillObject } = await import('/src/objects/skill.ts');
      const skills = await import('/src/combat/skill-system.ts');
      const unit = game.units.get('Player');
      const target = game.units.get('Keeper');
      if (!unit || !target) return null;
      unit.team = 'player';
      const item = unit.items.find((candidate: any) => candidate.isWeapon()) ?? null;
      const item2 = target.items.find((candidate: any) => candidate.isWeapon()) ?? null;
      const modifiers: [string, unknown][] = [
        ['stat_change', [['STR', 3]]],
        ['damage', 4],
        ['hit', 5],
        ['avoid', 6],
        ['crit', 7],
        ['crit_avoid', 8],
        ['attack_speed', 9],
        ['defense_speed', 10],
        ['resist', 11],
        ['damage_multiplier', 0.5],
        ['resist_multiplier', 0.25],
        ['cannot_double', null],
      ];
      const make = (nid: string, gates: [string, unknown][]) => new SkillObject({
        nid,
        name: nid,
        desc: '',
        icon_nid: '',
        icon_index: [0, 0],
        components: [...gates, ...modifiers],
      });
      const active = make('_StaticActive', [
        ['condition', "unit.team == 'player'"],
        ['combat_condition', "mode == 'attack' and unit2.nid == 'Keeper'"],
      ]);
      const genericInactive = make('_StaticGenericInactive', [['condition', 'False']]);
      const depleted = make('_StaticDepleted', [['drain_charge', 1]]);
      depleted.data.set('charge', 0);
      active.data.set('_combat_condition', true);
      const oldSkills = unit.skills;
      unit.skills = [active, genericInactive, depleted];
      const context: [number, number] = [0, 0];
      const snapshot = () => ({
        stat: skills.statChange(unit, 'STR', game),
        damage: skills.modifyDamage(unit, item, game, target, item2, 'attack', context),
        hit: skills.modifyAccuracy(unit, item, game, target, item2, 'attack', context),
        avoid: skills.modifyAvoid(unit, item, game, target, item2, 'attack', context),
        crit: skills.modifyCritAccuracy(unit, item, game, target, item2, 'attack', context),
        dodge: skills.modifyCritAvoid(unit, item, game, target, item2, 'attack', context),
        attackSpeed: skills.modifyAttackSpeed(
          unit, item, game, target, item2, 'attack', context,
        ),
        defenseSpeed: skills.modifyDefenseSpeed(
          unit, item, game, target, item2, 'attack', context,
        ),
        resist: skills.modifyResist(unit, item, game, target, item2, 'attack', context),
        damageMultiplier: skills.damageMultiplier(
          unit, item, target, item2, 'attack', context, 20, game,
        ),
        resistMultiplier: skills.resistMultiplier(
          unit, item, target, item2, 'attack', context, 20, game,
        ),
        cannotDouble: skills.noDouble(
          unit, game, item, target, item2, 'attack', context,
        ),
      });
      const enabled = snapshot();
      active.data.set('_combat_condition', false);
      const disabled = snapshot();
      active.data.delete('_combat_condition');
      const liveAttack = skills.modifyDamage(
        unit, item, game, target, item2, 'attack', context,
      );
      const liveDefense = skills.modifyDamage(
        unit, item, game, target, item2, 'defense', context,
      );
      const liveCannotDouble = skills.noDouble(
        unit, game, item, target, item2, 'attack', context,
      );
      unit.skills = oldSkills;
      return { enabled, disabled, liveAttack, liveDefense, liveCannotDouble };
    });

    expect(result).not.toBeNull();
    expect(result!.enabled).toEqual({
      stat: 3,
      damage: 4,
      hit: 5,
      avoid: 6,
      crit: 7,
      dodge: 8,
      attackSpeed: 9,
      defenseSpeed: 10,
      resist: 11,
      damageMultiplier: 0.5,
      resistMultiplier: 0.25,
      cannotDouble: true,
    });
    expect(result!.disabled).toEqual({
      stat: 0,
      damage: 0,
      hit: 0,
      avoid: 0,
      crit: 0,
      dodge: 0,
      attackSpeed: 0,
      defenseSpeed: 0,
      resist: 0,
      damageMultiplier: 1,
      resistMultiplier: 1,
      cannotDouble: false,
    });
    expect(result!.liveAttack).toBe(4);
    expect(result!.liveDefense).toBe(0);
    expect(result!.liveCannotDouble).toBe(true);
  });
});
