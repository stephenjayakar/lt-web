import { expect, test, type Page } from '@playwright/test';

async function bootEotf(page: Page): Promise<void> {
  await page.goto('/?harness=true&project=eotf.ltproj&level=X&clean=true&bundle=false');
  await page.waitForFunction(() => (window as any).__harness?.ready === true, undefined, {
    timeout: 30_000,
  });
}

test.describe('Embrace of the Fog timed skill lifecycle', () => {
  test('count-locks all 392 authored phase, combat, and chapter expiry uses', async ({ page }) => {
    await bootEotf(page);
    const inventory = await page.evaluate(() => {
      const game = (window as any).__gameRef;
      const selected = new Set([
        'time',
        'end_time',
        'combined_time',
        'upkeep_stat_change',
        'lost_on_upkeep',
        'lost_on_endstep',
        'lost_on_end_combat2',
      ]);
      const counts: Record<string, number> = {};
      const invalid: string[] = [];
      for (const skill of game.db.skills.values()) {
        for (const [nid, value] of skill.components) {
          if (!selected.has(nid)) continue;
          counts[nid] = (counts[nid] ?? 0) + 1;
          if (['time', 'end_time', 'combined_time'].includes(nid) &&
              (!Number.isInteger(value) || value <= 0)) invalid.push(`${skill.nid}:${nid}`);
          if (['lost_on_upkeep', 'lost_on_endstep'].includes(nid) && value !== null) {
            invalid.push(`${skill.nid}:${nid}`);
          }
          if (nid === 'upkeep_stat_change' && (!Array.isArray(value) ||
              value.some((entry: unknown) => !Array.isArray(entry) ||
                typeof entry[0] !== 'string' || typeof entry[1] !== 'number'))) {
            invalid.push(`${skill.nid}:${nid}`);
          }
          if (nid === 'lost_on_end_combat2') {
            const keys = value && typeof value === 'object'
              ? Object.keys(value).sort()
              : [];
            if (keys.join(',') !==
                'lost_on_ally,lost_on_enemy,lost_on_self,lost_on_splash') {
              invalid.push(`${skill.nid}:${nid}`);
            }
          }
        }
      }
      return { counts, invalid };
    });

    expect(inventory).toEqual({
      counts: {
        combined_time: 56,
        end_time: 43,
        lost_on_end_combat2: 55,
        lost_on_endstep: 61,
        lost_on_upkeep: 79,
        time: 89,
        upkeep_stat_change: 9,
      },
      invalid: [],
    });
  });

  test('decrements phase timers and removes chapter-temporary skills reversibly', async ({ page }) => {
    await bootEotf(page);
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { SkillObject } = await import('/src/objects/skill.ts');
      const { applySkillTurnHooks } = await import('/src/engine/skill-turn-lifecycle.ts');
      const unit = game.units.get('Player');
      if (!unit) return null;
      const make = (nid: string, components: [string, unknown][]) => new SkillObject({
        nid,
        name: nid,
        desc: '',
        icon_nid: '',
        icon_index: [0, 0],
        components,
      });
      const time = make('_Time', [['time', 2]]);
      const endTime = make('_EndTime', [['end_time', 2]]);
      const combined = make('_Combined', [['combined_time', 1]]);
      const upkeepLost = make('_UpkeepLost', [['lost_on_upkeep', null]]);
      const endstepLost = make('_EndstepLost', [['lost_on_endstep', null]]);
      const growing = make('_Growing', [['upkeep_stat_change', [['STR', 1]]]]);
      const oldSkills = unit.skills;
      unit.skills = [time, endTime, combined, upkeepLost, endstepLost, growing];
      const start = game.actionLog.actionIndex;

      applySkillTurnHooks(game, [unit], 'upkeep');
      const afterUpkeep = {
        time: time.data.get('turns'),
        endTime: endTime.data.get('turns'),
        combined: combined.data.get('turns'),
        upkeepLost: unit.skills.includes(upkeepLost),
        growing: growing.data.get('counter'),
      };
      applySkillTurnHooks(game, [unit], 'endstep');
      const afterEndstep = {
        time: time.data.get('turns'),
        endTime: endTime.data.get('turns'),
        combined: unit.skills.includes(combined),
        endstepLost: unit.skills.includes(endstepLost),
      };
      applySkillTurnHooks(game, [unit], 'upkeep');
      applySkillTurnHooks(game, [unit], 'endstep');
      const finalIndex = game.actionLog.actionIndex;
      const expired = {
        time: unit.skills.includes(time),
        endTime: unit.skills.includes(endTime),
        growing: growing.data.get('counter'),
      };
      while (game.actionLog.actionIndex > start) game.actionLog.runActionBackward();
      const reversed = {
        nids: unit.skills.map((skill: any) => skill.nid),
        time: time.data.get('turns'),
        endTime: endTime.data.get('turns'),
        combined: combined.data.get('turns'),
        growing: growing.data.get('counter'),
      };
      while (game.actionLog.actionIndex < finalIndex) game.actionLog.runActionForward();
      const redone = {
        nids: unit.skills.map((skill: any) => skill.nid),
        growing: growing.data.get('counter'),
      };

      const chapterSkills = [
        make('_ChapterTime', [['time', 2]]),
        make('_ChapterEndTime', [['end_time', 2]]),
        make('_ChapterCombined', [['combined_time', 1]]),
        make('_ChapterGrowing', [['upkeep_stat_change', [['STR', 1]]]]),
        make('_ChapterUpkeep', [['lost_on_upkeep', null]]),
        make('_ChapterEndstep', [['lost_on_endstep', null]]),
        make('_ChapterCombat', [['lost_on_end_combat2', {
          lost_on_self: true,
          lost_on_ally: true,
          lost_on_enemy: true,
          lost_on_splash: true,
        }]]),
      ];
      unit.skills = chapterSkills;
      const oldUnits = game.units;
      game.units = new Map([[unit.nid, unit]]);
      const chapterStart = game.actionLog.actionIndex;
      const chapterEffects = game.applySkillEndChapterHooks();
      const chapterApplied = unit.skills.length;
      const chapterFinal = game.actionLog.actionIndex;
      while (game.actionLog.actionIndex > chapterStart) game.actionLog.runActionBackward();
      const chapterReversed = unit.skills.map((skill: any) => skill.nid);
      while (game.actionLog.actionIndex < chapterFinal) game.actionLog.runActionForward();
      const chapterRedone = unit.skills.length;
      game.units = oldUnits;
      unit.skills = oldSkills;
      return {
        afterUpkeep,
        afterEndstep,
        expired,
        reversed,
        redone,
        chapterEffects,
        chapterApplied,
        chapterReversed,
        chapterRedone,
      };
    });

    expect(result).not.toBeNull();
    expect(result!.afterUpkeep).toEqual({
      time: 1,
      endTime: 2,
      combined: 1,
      upkeepLost: false,
      growing: 1,
    });
    expect(result!.afterEndstep).toEqual({
      time: 1,
      endTime: 1,
      combined: false,
      endstepLost: false,
    });
    expect(result!.expired).toEqual({ time: false, endTime: false, growing: 2 });
    expect(result!.reversed).toEqual({
      nids: ['_Time', '_EndTime', '_Combined', '_UpkeepLost', '_EndstepLost', '_Growing'],
      time: 2,
      endTime: 2,
      combined: 2,
      growing: 0,
    });
    expect(result!.redone).toEqual({ nids: ['_Growing'], growing: 2 });
    expect(result!.chapterEffects).toEqual({ reset: 0, removed: 7 });
    expect(result!.chapterApplied).toBe(0);
    expect(result!.chapterReversed).toEqual([
      '_ChapterTime',
      '_ChapterEndTime',
      '_ChapterCombined',
      '_ChapterGrowing',
      '_ChapterUpkeep',
      '_ChapterEndstep',
      '_ChapterCombat',
    ]);
    expect(result!.chapterRedone).toBe(0);
  });

  test('honors enemy versus splash combat-expiry options with exact replay', async ({ page }) => {
    await bootEotf(page);
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { SkillObject } = await import('/src/objects/skill.ts');
      const { ItemObject } = await import('/src/objects/item.ts');
      const { applyCombatSkillEndHooks } = await import('/src/combat/combat-lifecycle.ts');
      const attacker = game.units.get('Player');
      const defender = game.units.get('Keeper');
      if (!attacker || !defender) return null;
      attacker.team = 'player';
      defender.team = 'enemy';
      const item = new ItemObject({
        nid: '_TimedWeapon',
        name: '',
        desc: '',
        components: [['weapon', null], ['damage', 0], ['hit', 100]],
      });
      const expiry = (nid: string, lostOnSplash: boolean) => new SkillObject({
        nid,
        name: nid,
        desc: '',
        icon_nid: '',
        icon_index: [0, 0],
        components: [['lost_on_end_combat2', {
          lost_on_self: false,
          lost_on_ally: false,
          lost_on_enemy: true,
          lost_on_splash: lostOnSplash,
        }]],
      });
      const oldSkills = attacker.skills;
      const enemyOnly = expiry('_EnemyOnly', false);
      const enemyAndSplash = expiry('_EnemyAndSplash', true);
      attacker.skills = [enemyOnly, enemyAndSplash];
      const strike = (mode: 'attack' | 'splash') => [{
        attacker,
        defender,
        item,
        hit: true,
        crit: false,
        damage: 1,
        isCounter: false,
        mode,
        attackInfo: [0, 0] as [number, number],
      }];

      const splashStart = game.actionLog.actionIndex;
      applyCombatSkillEndHooks(game, strike('splash'), attacker, defender);
      const splashApplied = attacker.skills.map((skill: any) => skill.nid);
      const splashFinal = game.actionLog.actionIndex;
      while (game.actionLog.actionIndex > splashStart) game.actionLog.runActionBackward();
      const splashReversed = attacker.skills.map((skill: any) => skill.nid);
      while (game.actionLog.actionIndex < splashFinal) game.actionLog.runActionForward();
      const splashRedone = attacker.skills.map((skill: any) => skill.nid);

      attacker.skills = [expiry('_EnemyOnly2', false), expiry('_EnemyAndSplash2', true)];
      applyCombatSkillEndHooks(game, strike('attack'), attacker, defender);
      const enemyApplied = attacker.skills.map((skill: any) => skill.nid);
      attacker.skills = oldSkills;
      return { splashApplied, splashReversed, splashRedone, enemyApplied };
    });

    expect(result).toEqual({
      splashApplied: ['_EnemyOnly'],
      splashReversed: ['_EnemyOnly', '_EnemyAndSplash'],
      splashRedone: ['_EnemyOnly'],
      enemyApplied: [],
    });
  });
});
