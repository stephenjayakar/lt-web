import { expect, test, type Page } from '@playwright/test';

async function bootEotf(page: Page): Promise<void> {
  await page.goto('/?harness=true&project=eotf.ltproj&level=X&clean=true&bundle=false');
  await page.waitForFunction(() => (window as any).__harness?.ready === true, undefined, {
    timeout: 60_000,
  });
}

test.describe('Embrace of the Fog item overrides and combat arts', () => {
  test('count-locks all 593 authored override, combat-art, and weapon-access uses', async ({ page }) => {
    await bootEotf(page);
    const inventory = await page.evaluate(() => {
      const game = (window as any).__gameRef;
      const selected = new Set([
        'item_override',
        'combat_art',
        'allowed_weapons',
        'wexp_usable_skill',
        'wexp_unusable_skill',
      ]);
      const counts: Record<string, number> = {};
      const invalid: string[] = [];
      for (const skill of game.db.skills.values()) {
        for (const [nid, value] of skill.components) {
          if (!selected.has(nid)) continue;
          counts[nid] = (counts[nid] ?? 0) + 1;
          if (typeof value !== 'string' || value.length === 0) {
            invalid.push(`${skill.nid}:${nid}:shape`);
          } else if (nid === 'item_override' && !game.db.items.has(value)) {
            invalid.push(`${skill.nid}:${nid}:${value}`);
          } else if (nid === 'combat_art' && !game.db.skills.has(value)) {
            invalid.push(`${skill.nid}:${nid}:${value}`);
          }
        }
      }
      return { counts, invalid };
    });

    expect(inventory).toEqual({
      counts: {
        allowed_weapons: 167,
        combat_art: 172,
        item_override: 199,
        wexp_unusable_skill: 15,
        wexp_usable_skill: 40,
      },
      invalid: [],
    });
  });

  test('dispatches active overrides with Python precedence through item hooks and expressions', async ({ page }) => {
    await bootEotf(page);
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { ItemObject } = await import('/src/objects/item.ts');
      const { SkillObject } = await import('/src/objects/skill.ts');
      const { ActionLog } = await import('/src/engine/action.ts');
      const {
        available,
        effectiveItemComponents,
      } = await import('/src/combat/item-system.ts');
      const {
        applyItemEndResourceHooks,
      } = await import('/src/combat/item-resource-lifecycle.ts');
      const { applyCombatComponents } =
        await import('/src/combat/combat-components.ts');
      const { evaluateCondition } = await import('/src/events/event-manager.ts');
      const unit = game.units.get('Player');
      const defender = game.units.get('Keeper');
      if (!unit || !defender) return null;
      const oldSkills = unit.skills;
      const oldHp = unit.currentHp;
      const oldFatigue = defender.currentFatigue;
      const makeSkill = (nid: string, components: [string, unknown][]) =>
        new SkillObject({
          nid, name: nid, desc: '', icon_nid: '', icon_index: [0, 0], components,
        });
      const putItem = (nid: string, components: [string, unknown][]) =>
        game.db.items.set(nid, {
          nid, name: nid, desc: '', icon_nid: '', icon_index: [0, 0], components,
        });
      putItem('_OverrideLow', [
        ['hit', 80], ['magic', null], ['eval_available', 'False'],
      ]);
      putItem('_OverrideHigh', [
        ['hit', 90], ['cannot_be_countered', null], ['eval_available', 'True'],
        ['eval_hp_cost', '3'], ['fatigue_on_hit', 7],
      ]);
      putItem('_OverrideInactive', [['damage', 99]]);
      putItem('_OverrideDepleted', [['crit', 99]]);
      const low = makeSkill('_OverrideLowSkill', [['item_override', '_OverrideLow']]);
      const high = makeSkill('_OverrideHighSkill', [['item_override', '_OverrideHigh']]);
      const inactive = makeSkill('_OverrideInactiveSkill', [
        ['item_override', '_OverrideInactive'], ['condition', 'False'],
      ]);
      const depleted = makeSkill('_OverrideDepletedSkill', [
        ['item_override', '_OverrideDepleted'], ['drain_charge', 1],
      ]);
      depleted.data.set('charge', 0);
      unit.skills = [low, high, inactive, depleted];
      const item = new ItemObject({
        nid: '_OverrideBase',
        name: 'Override Base',
        desc: '',
        icon_nid: '',
        icon_index: [0, 0],
        components: [['weapon', null], ['hit', 50], ['damage', 4]],
      });
      item.owner = unit;

      const entries = effectiveItemComponents(unit, item, game.db, game);
      const hookGame = {
        ...game,
        db: game.db,
        actionLog: new ActionLog(),
        gameVars: game.gameVars,
        levelVars: game.levelVars,
      };
      const before = hookGame.actionLog.actionIndex;
      unit.currentHp = 20;
      const applied = applyItemEndResourceHooks(hookGame, unit, item);
      const hpAfter = unit.currentHp;
      hookGame.actionLog.runActionBackward();
      const hpUndone = unit.currentHp;
      applyCombatComponents(
        unit,
        item,
        defender,
        null,
        [{
          attacker: unit,
          defender,
          item,
          hit: true,
          damage: 0,
          isCounter: false,
          mode: 'attack',
          attackInfo: [0, 0],
        }] as any,
        false,
        false,
        game.db,
        game,
      );
      const fatigueAfterHit = defender.currentFatigue;
      const expressionSeesMagic = evaluateCondition(
        "any([component.nid == 'magic' for component in item_system.get_all_components(unit, item)])",
        {
          game,
          unit1: unit,
          item,
          position: unit.position ?? undefined,
          gameVars: game.gameVars,
          levelVars: game.levelVars,
        },
      );
      const snapshot = {
        hit: item.getHit(),
        damage: item.getDamage(),
        magic: item.hasComponent('magic'),
        cannotBeCountered: item.hasComponent('cannot_be_countered'),
        inactiveDamage: entries.some(([nid, value]) => nid === 'damage' && value === 99),
        depletedCrit: entries.some(([nid]) => nid === 'crit'),
        hitValues: entries.filter(([nid]) => nid === 'hit').map(([, value]) => value),
        available: available(unit, item, game.db, game),
        expressionSeesMagic,
        applied,
        actions: hookGame.actionLog.actionIndex - before,
        hpAfter,
        hpUndone,
        fatigueAfterHit,
      };
      unit.skills = oldSkills;
      unit.currentHp = oldHp;
      defender.currentFatigue = oldFatigue;
      for (const nid of [
        '_OverrideLow', '_OverrideHigh', '_OverrideInactive', '_OverrideDepleted',
      ]) game.db.items.delete(nid);
      return snapshot;
    });

    expect(result).toEqual({
      hit: 90,
      damage: 4,
      magic: true,
      cannotBeCountered: true,
      inactiveDamage: false,
      depletedCrit: false,
      hitValues: [50, 90],
      available: true,
      expressionSeesMagic: true,
      applied: 1,
      actions: 0,
      hpAfter: 17,
      hpUndone: 20,
      fatigueAfterHit: 7,
    });
  });

  test('filters and activates combat arts while weapon grants remain order-independent', async ({ page }) => {
    await bootEotf(page);
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { ItemObject } = await import('/src/objects/item.ts');
      const { SkillObject } = await import('/src/objects/skill.ts');
      const {
        getCombatArtOptions,
        activateCombatArt,
        deactivateCombatArts,
      } = await import('/src/combat/combat-art-system.ts');
      const { available } = await import('/src/combat/item-system.ts');
      const unit = game.units.get('Player');
      if (!unit) return null;
      const oldSkills = unit.skills;
      const oldItems = unit.items;
      const oldWexp = { ...unit.wexp };
      const klass = game.db.classes.get(unit.klass);
      const weaponType = Object.keys(klass.wexp_gain).find(
        (nid) => klass.wexp_gain[nid] && !klass.wexp_gain[nid][0],
      ) ?? Object.keys(klass.wexp_gain)[0];
      const oldClassEntry = klass.wexp_gain[weaponType];
      klass.wexp_gain[weaponType] = [false, 0, oldClassEntry?.[2] ?? 251];
      unit.wexp[weaponType] = 31;
      const weapon = new ItemObject({
        nid: '_ArtWeapon',
        name: 'Art Weapon',
        desc: '',
        icon_nid: '',
        icon_index: [0, 0],
        components: [
          ['weapon', null], ['weapon_type', weaponType],
          ['weapon_rank', 'D'], ['damage', 4],
        ],
      });
      weapon.owner = unit;
      unit.items = [weapon];
      game.db.items.set('_ArtOverride', {
        nid: '_ArtOverride', name: '', desc: '', icon_nid: '', icon_index: [0, 0],
        components: [['damage', 12]],
      });
      game.db.skills.set('_ArtChild', {
        nid: '_ArtChild', name: '', desc: '', icon_nid: '', icon_index: [0, 0],
        components: [['item_override', '_ArtOverride']],
      });
      const parent = new SkillObject({
        nid: '_ArtParent',
        name: '',
        desc: '',
        icon_nid: '',
        icon_index: [0, 0],
        components: [
          ['combat_art', '_ArtChild'],
          ['allowed_weapons', 'item_system.is_weapon(unit, item)'],
          ['drain_charge', 1],
        ],
      });
      parent.data.set('charge', 1);
      const grant = new SkillObject({
        nid: '_Grant', name: '', desc: '', icon_nid: '', icon_index: [0, 0],
        components: [['wexp_usable_skill', weaponType]],
      });
      const forbid = new SkillObject({
        nid: '_Forbid', name: '', desc: '', icon_nid: '', icon_index: [0, 0],
        components: [['wexp_unusable_skill', weaponType]],
      });

      unit.skills = [parent, grant];
      const granted = available(unit, weapon, game.db, game);
      unit.skills = [parent, forbid, grant];
      const forbiddenFirst = available(unit, weapon, game.db, game);
      unit.skills = [parent, grant, forbid];
      const forbiddenLast = available(unit, weapon, game.db, game);
      unit.skills = [parent, grant];
      const options = getCombatArtOptions(game, unit, false);
      const damageBefore = weapon.getDamage();
      const activated = options.length > 0 && activateCombatArt(game, unit, options[0]);
      const damageActive = weapon.getDamage();
      const childActive = unit.skills.some((skill: any) => skill.nid === '_ArtChild');
      deactivateCombatArts(unit);
      const damageAfter = weapon.getDamage();

      unit.skills = oldSkills;
      unit.items = oldItems;
      unit.wexp = oldWexp;
      klass.wexp_gain[weaponType] = oldClassEntry;
      game.db.items.delete('_ArtOverride');
      game.db.skills.delete('_ArtChild');
      return {
        granted,
        forbiddenFirst,
        forbiddenLast,
        optionCount: options.length,
        damageBefore,
        activated,
        damageActive,
        childActive,
        damageAfter,
      };
    });

    expect(result).toEqual({
      granted: true,
      forbiddenFirst: false,
      forbiddenLast: false,
      optionCount: 1,
      damageBefore: 4,
      activated: true,
      damageActive: 12,
      childActive: true,
      damageAfter: 4,
    });
  });
});
