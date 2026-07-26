import { expect, test, type Page } from '@playwright/test';

async function bootEotf(page: Page): Promise<void> {
  await page.goto('/?harness=true&project=eotf.ltproj&level=X&clean=true&bundle=false');
  await page.waitForFunction(() => (window as any).__harness?.ready === true, undefined, {
    timeout: 30_000,
  });
}

test.describe('Embrace of the Fog regeneration and recoil hooks', () => {
  test('count-locks all 40 authored upkeep, recoil, post-combat, and follow-up uses', async ({ page }) => {
    await bootEotf(page);
    const inventory = await page.evaluate(() => {
      const game = (window as any).__gameRef;
      const expressions = new Set(['eval_regeneration', 'eval_upkeep_damage']);
      const numbers = new Set([
        'regeneration',
        'upkeep_damage',
        'recoil',
        'post_combat_damage',
        'post_combat_damage_percent',
        'heal_after_follow_up',
      ]);
      const selected = new Set([...expressions, ...numbers]);
      const counts: Record<string, number> = {};
      const invalid: string[] = [];
      for (const skill of game.db.skills.values()) {
        for (const [nid, value] of skill.components) {
          if (!selected.has(nid)) continue;
          counts[nid] = (counts[nid] ?? 0) + 1;
          if (expressions.has(nid) &&
              (typeof value !== 'string' || value.length === 0)) {
            invalid.push(`${skill.nid}:${nid}:expression`);
          } else if (numbers.has(nid) && typeof value !== 'number') {
            invalid.push(`${skill.nid}:${nid}:number`);
          }
        }
      }
      return { counts, invalid };
    });

    expect(inventory).toEqual({
      counts: {
        eval_regeneration: 11,
        eval_upkeep_damage: 5,
        heal_after_follow_up: 1,
        post_combat_damage: 2,
        post_combat_damage_percent: 1,
        recoil: 9,
        regeneration: 9,
        upkeep_damage: 2,
      },
      invalid: [],
    });
  });

  test('applies signed and evaluated upkeep HP changes with exact replay', async ({ page }) => {
    await bootEotf(page);
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { SkillObject } = await import('/src/objects/skill.ts');
      const { ActionLog } = await import('/src/engine/action.ts');
      const { applySkillTurnHooks } =
        await import('/src/engine/skill-turn-lifecycle.ts');
      const unit = game.units.get('Player');
      if (!unit) return null;
      const old = {
        skills: unit.skills,
        stats: { ...unit.stats },
        hp: unit.currentHp,
      };
      const make = (nid: string, components: [string, unknown][]) =>
        new SkillObject({
          nid, name: '', desc: '', icon_nid: '', icon_index: [0, 0], components,
        });
      const regeneration = make('_Regeneration', [['regeneration', 0.2]]);
      const evaluatedRegeneration = make(
        '_EvalRegeneration',
        [['eval_regeneration', '3']],
      );
      const signedRegeneration = make('_SignedRegeneration', [['regeneration', -0.05]]);
      const upkeep = make('_UpkeepDamage', [['upkeep_damage', 2]]);
      const evaluatedDamage = make('_EvalUpkeepDamage', [
        ['eval_upkeep_damage', '4'],
        ['drain_charge', 1],
      ]);
      evaluatedDamage.data.set('charge', 1);
      evaluatedDamage.data.set('total_charge', 1);
      unit.skills = [
        regeneration,
        evaluatedRegeneration,
        signedRegeneration,
        upkeep,
        evaluatedDamage,
      ];
      unit.stats.HP = 20;
      unit.currentHp = 10;
      const turnGame = {
        ...game,
        actionLog: new ActionLog(),
        db: game.db,
        gameVars: game.gameVars,
        levelVars: game.levelVars,
        turnCount: 3,
      };
      const before = turnGame.actionLog.actionIndex;
      const effects = applySkillTurnHooks(turnGame, [unit], 'upkeep');
      const after = turnGame.actionLog.actionIndex;
      const changed = {
        hp: unit.currentHp,
        charge: evaluatedDamage.data.get('charge'),
        effects: effects.map((effect: any) => [effect.component, effect.value]),
      };
      while (turnGame.actionLog.actionIndex > before) {
        turnGame.actionLog.runActionBackward();
      }
      const reversed = {
        hp: unit.currentHp,
        charge: evaluatedDamage.data.get('charge'),
      };
      while (turnGame.actionLog.actionIndex < after) {
        turnGame.actionLog.runActionForward();
      }
      const replayed = {
        hp: unit.currentHp,
        charge: evaluatedDamage.data.get('charge'),
      };
      while (turnGame.actionLog.actionIndex > before) {
        turnGame.actionLog.runActionBackward();
      }
      unit.skills = old.skills;
      unit.stats = old.stats;
      unit.currentHp = old.hp;
      return { changed, reversed, replayed };
    });

    expect(result).toEqual({
      changed: {
        hp: 10,
        charge: 0,
        effects: [
          ['regeneration', 4],
          ['eval_regeneration', 3],
          ['regeneration', -1],
          ['upkeep_damage', -2],
          ['eval_upkeep_damage', -4],
        ],
      },
      reversed: { hp: 10, charge: 1 },
      replayed: { hp: 10, charge: 0 },
    });
  });

  test('applies standard recoil and post-combat damage nonlethally with replay', async ({ page }) => {
    await bootEotf(page);
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { SkillObject } = await import('/src/objects/skill.ts');
      const { ItemObject } = await import('/src/objects/item.ts');
      const { ActionLog } = await import('/src/engine/action.ts');
      const { applyCombatSkillEndHooks } =
        await import('/src/combat/combat-lifecycle.ts');
      const attacker = game.units.get('Player');
      const defender = game.units.get('Keeper');
      if (!attacker || !defender) return null;
      const old = {
        attackerSkills: attacker.skills,
        defenderSkills: defender.skills,
        attackerStats: { ...attacker.stats },
        defenderStats: { ...defender.stats },
        attackerHp: attacker.currentHp,
        defenderHp: defender.currentHp,
        defenderTeam: defender.team,
      };
      const make = (nid: string, component: [string, unknown]) => {
        const skill = new SkillObject({
          nid,
          name: '',
          desc: '',
          icon_nid: '',
          icon_index: [0, 0],
          components: [component, ['drain_charge', 1]],
        });
        skill.data.set('charge', 1);
        skill.data.set('total_charge', 1);
        return skill;
      };
      const recoil = make('_Recoil', ['recoil', 5]);
      const damage = make('_PostDamage', ['post_combat_damage', 6]);
      const percent = make('_PostPercent', ['post_combat_damage_percent', 0.2]);
      attacker.skills = [recoil, damage, percent];
      defender.skills = [];
      attacker.stats.HP = 20;
      attacker.currentHp = 20;
      defender.stats.HP = 50;
      defender.currentHp = 30;
      defender.team = 'enemy';
      const item = new ItemObject({
        nid: '_PostCombatItem',
        name: '',
        desc: '',
        icon_nid: '',
        icon_index: [0, 0],
        components: [['weapon', null]],
      });
      const actionLog = new ActionLog();
      const hookGame = { ...game, actionLog, db: game.db };
      const mark = {
        attacker,
        defender,
        item,
        hit: true,
        damage: 1,
        isCounter: false,
        mode: 'attack',
        attackInfo: [0, 0],
      };
      const before = actionLog.actionIndex;
      const applied = applyCombatSkillEndHooks(
        hookGame,
        [mark] as any,
        attacker,
        defender,
      );
      const after = actionLog.actionIndex;
      const changed = {
        attackerHp: attacker.currentHp,
        defenderHp: defender.currentHp,
        charges: [recoil, damage, percent].map((skill) => skill.data.get('charge')),
      };
      while (actionLog.actionIndex > before) actionLog.runActionBackward();
      const reversed = {
        attackerHp: attacker.currentHp,
        defenderHp: defender.currentHp,
        charges: [recoil, damage, percent].map((skill) => skill.data.get('charge')),
      };
      while (actionLog.actionIndex < after) actionLog.runActionForward();
      const replayed = {
        attackerHp: attacker.currentHp,
        defenderHp: defender.currentHp,
        charges: [recoil, damage, percent].map((skill) => skill.data.get('charge')),
      };
      while (actionLog.actionIndex > before) actionLog.runActionBackward();
      attacker.skills = old.attackerSkills;
      defender.skills = old.defenderSkills;
      attacker.stats = old.attackerStats;
      defender.stats = old.defenderStats;
      attacker.currentHp = old.attackerHp;
      defender.currentHp = old.defenderHp;
      defender.team = old.defenderTeam;
      return { applied, changed, reversed, replayed };
    });

    expect(result).toEqual({
      applied: 3,
      changed: {
        attackerHp: 15,
        defenderHp: 14,
        charges: [0, 0, 0],
      },
      reversed: {
        attackerHp: 20,
        defenderHp: 30,
        charges: [1, 1, 1],
      },
      replayed: {
        attackerHp: 15,
        defenderHp: 14,
        charges: [0, 0, 0],
      },
    });
  });

  test('heals a surviving defender immediately after a follow-up strike', async ({ page }) => {
    await bootEotf(page);
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { SkillObject } = await import('/src/objects/skill.ts');
      const { ItemObject } = await import('/src/objects/item.ts');
      const { ActionLog } = await import('/src/engine/action.ts');
      const { MapCombat } = await import('/src/combat/map-combat.ts');
      const attacker = game.units.get('Player');
      const defender = game.units.get('Keeper');
      if (!attacker || !defender) return null;
      const old = {
        attackerSkills: attacker.skills,
        defenderSkills: defender.skills,
        attackerItems: attacker.items,
        defenderItems: defender.items,
        attackerWeapon: attacker.equippedWeapon,
        defenderWeapon: defender.equippedWeapon,
        attackerStats: { ...attacker.stats },
        defenderStats: { ...defender.stats },
        attackerHp: attacker.currentHp,
        defenderHp: defender.currentHp,
        attackerTeam: attacker.team,
        defenderTeam: defender.team,
      };
      const followUp = new SkillObject({
        nid: '_FollowUpHeal',
        name: '',
        desc: '',
        icon_nid: '',
        icon_index: [0, 0],
        components: [['heal_after_follow_up', 4], ['drain_charge', 1]],
      });
      followUp.data.set('charge', 1);
      followUp.data.set('total_charge', 1);
      const item = new ItemObject({
        nid: '_FollowUpWeapon',
        name: '',
        desc: '',
        icon_nid: '',
        icon_index: [0, 0],
        components: [
          ['weapon', null], ['damage', 5], ['hit', 100],
          ['min_range', 1], ['max_range', 1],
        ],
      });
      item.owner = attacker;
      attacker.skills = [];
      defender.skills = [followUp];
      attacker.items = [item];
      defender.items = [];
      attacker.equippedWeapon = item;
      defender.equippedWeapon = null;
      attacker.stats.STR = 0;
      defender.stats.DEF = 0;
      attacker.stats.HP = 30;
      defender.stats.HP = 30;
      attacker.currentHp = 30;
      defender.currentHp = 20;
      attacker.team = 'player';
      defender.team = 'enemy';
      const actionLog = new ActionLog();
      const combat = new MapCombat(
        attacker,
        item,
        defender,
        null,
        game.db,
        'classic',
        game.board,
        ['hit1', 'hit1', 'end'],
        undefined,
        game,
      );
      const strikeHeals = combat.strikes.map(
        (strike: any) => strike.defenderSkillHpChange ?? 0,
      );
      combat.applyResults(actionLog);
      const changed = {
        hp: defender.currentHp,
        charge: followUp.data.get('charge'),
      };
      actionLog.runActionBackward();
      const reversed = {
        hp: defender.currentHp,
        charge: followUp.data.get('charge'),
      };

      attacker.skills = old.attackerSkills;
      defender.skills = old.defenderSkills;
      attacker.items = old.attackerItems;
      defender.items = old.defenderItems;
      attacker.equippedWeapon = old.attackerWeapon;
      defender.equippedWeapon = old.defenderWeapon;
      attacker.stats = old.attackerStats;
      defender.stats = old.defenderStats;
      attacker.currentHp = old.attackerHp;
      defender.currentHp = old.defenderHp;
      attacker.team = old.attackerTeam;
      defender.team = old.defenderTeam;
      return { strikeHeals, changed, reversed };
    });

    expect(result).toEqual({
      strikeHeals: [0, 4],
      changed: { hp: 14, charge: 0 },
      reversed: { hp: 20, charge: 1 },
    });
  });
});
