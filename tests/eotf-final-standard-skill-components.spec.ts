import { expect, test, type Page } from '@playwright/test';

async function bootEotf(page: Page): Promise<void> {
  await page.goto('/?harness=true&project=eotf.ltproj&level=X&clean=true&bundle=false');
  await page.waitForFunction(() => (window as any).__harness?.ready === true, undefined, {
    timeout: 30_000,
  });
}

const COMPONENTS = [
  'Cleave',
  'combat_charge_increase_by_stat',
  'enemy_oversplash',
  'event_after_initiated_combat',
  'event_on_remove',
  'galeforce',
  'pairup_bonus',
  'post_combat_splash',
  'post_combat_splash_aoe',
  'skill_before_combat',
  'smart_oversplash',
] as const;

test.describe('Embrace of the Fog final standard skill components', () => {
  test('count-locks all 85 authored values and their event/skill references', async ({
    page,
  }) => {
    await bootEotf(page);
    const result = await page.evaluate((componentNids) => {
      const game = (window as any).__gameRef;
      const selected = new Set(componentNids);
      const counts: Record<string, number> = {};
      const invalid: string[] = [];
      const missing: string[] = [];
      for (const skill of game.db.skills.values()) {
        for (const [nid, value] of skill.components) {
          if (!selected.has(nid)) continue;
          counts[nid] = (counts[nid] ?? 0) + 1;
          if (['Cleave', 'galeforce'].includes(nid)) {
            if (value !== null) invalid.push(`${skill.nid}:${nid}`);
          } else if ([
            'enemy_oversplash',
            'post_combat_splash',
            'post_combat_splash_aoe',
            'smart_oversplash',
          ].includes(nid)) {
            if (typeof value !== 'number') invalid.push(`${skill.nid}:${nid}`);
          } else if (nid === 'skill_before_combat') {
            if (!value || typeof value !== 'object' ||
                typeof value.skill !== 'string' ||
                !['self', 'target', 'both'].includes(String(value.recipient)) ||
                !['ally', 'enemy', 'both'].includes(String(value.allegiance))) {
              invalid.push(`${skill.nid}:${nid}`);
            } else if (!game.db.skills.has(value.skill)) {
              missing.push(`${skill.nid}:${value.skill}`);
            }
          } else if (nid === 'pairup_bonus') {
            if (typeof value !== 'string') invalid.push(`${skill.nid}:${nid}`);
            else if (!game.db.skills.has(value)) missing.push(`${skill.nid}:${value}`);
          } else if ([
            'event_after_initiated_combat',
            'event_on_remove',
          ].includes(nid)) {
            if (typeof value !== 'string') invalid.push(`${skill.nid}:${nid}`);
            else if (!game.db.events.has(value)) missing.push(`${skill.nid}:${value}`);
          } else if (nid === 'combat_charge_increase_by_stat' &&
              typeof value !== 'string') {
            invalid.push(`${skill.nid}:${nid}`);
          }
        }
      }
      return { counts, invalid, missing, eventCount: game.db.events.size };
    }, [...COMPONENTS]);

    expect(result).toEqual({
      counts: {
        Cleave: 1,
        combat_charge_increase_by_stat: 1,
        enemy_oversplash: 2,
        event_after_initiated_combat: 35,
        event_on_remove: 14,
        galeforce: 6,
        pairup_bonus: 1,
        post_combat_splash: 3,
        post_combat_splash_aoe: 3,
        skill_before_combat: 16,
        smart_oversplash: 3,
      },
      invalid: [],
      missing: [],
      eventCount: 2339,
    });
  });

  test('resolves real AOE, pair-up, and stat-charge hooks', async ({ page }) => {
    await bootEotf(page);
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { SkillObject } = await import('/src/objects/skill.ts');
      const { ItemObject } = await import('/src/objects/item.ts');
      const {
        alternateSplash,
        empowerSplash,
        onPairup,
        onSeparate,
      } = await import('/src/combat/skill-system.ts');
      const { CombatSkillLifecycle } =
        await import('/src/combat/combat-skill-lifecycle.ts');
      const unit = game.units.get('Player');
      const leader = game.units.get('Keeper');
      const target = game.units.get('Trace');
      const old = {
        unitSkills: unit.skills,
        leaderSkills: leader.skills,
        unitStats: { ...unit.stats },
      };
      const resolveAoe = (skillNid: string) => {
        unit.skills = [new SkillObject(game.db.skills.get(skillNid))];
        return {
          alternate: alternateSplash(unit),
          range: empowerSplash(unit),
        };
      };
      const aoe = {
        cleave: resolveAoe('SteelScythes_Child'),
        enemy: resolveAoe('Thundering_Chaos_Slash_Child'),
        smart: resolveAoe('Dark_Crescendo_Proc'),
      };

      const relay = new SkillObject(game.db.skills.get('TurnRelay'));
      unit.skills = [relay];
      leader.skills = [];
      const added = onPairup(unit, leader, (nid) => {
        const prefab = game.db.skills.get(nid);
        return prefab ? new SkillObject(prefab) : null;
      });
      const paired = added.map((skill: any) => ({
        nid: skill.nid,
        source: skill.data.get('pairupSource'),
        type: skill.data.get('pairupSourceType'),
      }));
      const removed = onSeparate(unit, leader).map((skill: any) => skill.nid);

      const critical = new SkillObject(game.db.skills.get('Critical'));
      unit.skills = [critical];
      const stat = critical.getComponent('combat_charge_increase_by_stat');
      unit.stats.SKL = 7;
      const item = new ItemObject({
        nid: '_ChargeWeapon',
        name: '',
        desc: '',
        components: [['weapon', null]],
      });
      new CombatSkillLifecycle(game.db, () => 99, game).endCombat([{
        attacker: unit,
        defender: target,
        item,
        hit: true,
        crit: false,
        damage: 0,
        isCounter: false,
        mode: 'attack',
        attackInfo: [0, 0],
      }]);
      const charge = {
        stat,
        current: critical.data.get('charge'),
        total: critical.data.get('total_charge'),
      };

      unit.skills = old.unitSkills;
      leader.skills = old.leaderSkills;
      unit.stats = old.unitStats;
      return { aoe, paired, removed, charge };
    });

    expect(result).toEqual({
      aoe: {
        cleave: { alternate: 'enemy_cleave', range: 0 },
        enemy: { alternate: 'enemy_blast', range: 1 },
        smart: { alternate: 'smart_blast', range: 1 },
      },
      paired: [{
        nid: 'TurnRelay_Partner',
        source: 'Player',
        type: 'traveler',
      }],
      removed: ['TurnRelay_Partner'],
      charge: {
        stat: 'SKL',
        current: 7,
        total: 20,
      },
    });
  });

  test('runs real pre/post-combat, Galeforce, and event hooks reversibly', async ({
    page,
  }) => {
    await bootEotf(page);
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { SkillObject } = await import('/src/objects/skill.ts');
      const { ItemObject } = await import('/src/objects/item.ts');
      const { RemoveSkillAction } = await import('/src/engine/action.ts');
      const {
        applyCombatSkillEndHooks,
        queueAfterInitiatedCombatEvents,
        queueCombatSkillStartEvents,
      } = await import('/src/combat/combat-lifecycle.ts');
      const attacker = game.units.get('Player');
      const target = game.units.get('Keeper');
      const splashTarget = game.units.get('Trace');
      const outsider = game.units.get('Gacha');
      const old = {
        attackerSkills: attacker.skills,
        targetSkills: target.skills,
        splashSkills: splashTarget.skills,
        attackerTeam: attacker.team,
        targetTeam: target.team,
        splashTeam: splashTarget.team,
        outsiderTeam: outsider.team,
        attackerPosition: attacker.position,
        targetPosition: target.position,
        splashPosition: splashTarget.position,
        outsiderPosition: outsider.position,
        targetHp: target.currentHp,
        splashHp: splashTarget.currentHp,
        outsiderHp: outsider.currentHp,
        attackerFinished: attacker.finished,
        attackerMoved: attacker.hasMoved,
        attackerAttacked: attacker.hasAttacked,
        eventManager: game.eventManager,
      };
      attacker.team = 'player';
      target.team = splashTarget.team = outsider.team = 'enemy';
      attacker.position = [4, 5];
      target.position = [5, 5];
      splashTarget.position = [6, 5];
      outsider.position = [9, 5];
      const item = new ItemObject({
        nid: '_LifecycleWeapon',
        name: '',
        desc: '',
        components: [['weapon', null]],
      });
      const strike = {
        attacker,
        defender: target,
        item,
        hit: true,
        crit: false,
        damage: 1,
        isCounter: false,
        mode: 'attack',
        attackInfo: [0, 0] as [number, number],
      };
      const calls: { nid: string; type: string }[] = [];
      game.eventManager = {
        getPrefab(nid: string) {
          return game.db.events.get(nid);
        },
        triggerSpecific(nid: string, trigger: any) {
          calls.push({ nid, type: trigger.type });
          return true;
        },
      };

      const initiated = new SkillObject(game.db.skills.get('Call_to_Execution_Sub'));
      attacker.skills = [initiated];
      const wrongItem = queueAfterInitiatedCombatEvents(
        game,
        attacker,
        target,
        item,
        null,
        'attack',
      );
      initiated.data.set('_combat_condition', true);
      const snapshotted = queueAfterInitiatedCombatEvents(
        game,
        attacker,
        target,
        item,
        null,
        'attack',
      );
      initiated.data.delete('_combat_condition');

      const startIndex = game.actionLog.actionIndex;
      const beforeCombat = new SkillObject(game.db.skills.get('Spiked_Helm'));
      attacker.skills = [beforeCombat];
      target.skills = [];
      queueCombatSkillStartEvents(game, attacker, target, item, null);
      const preCombatEndIndex = game.actionLog.actionIndex;
      const preCombat = target.skills.map((skill: any) => skill.nid);
      while (game.actionLog.actionIndex > startIndex) {
        game.actionLog.runActionBackward();
      }
      const preCombatReversed = target.skills.map((skill: any) => skill.nid);
      while (game.actionLog.actionIndex < preCombatEndIndex) {
        game.actionLog.runActionForward();
      }

      const removal = new SkillObject(game.db.skills.get('Phalanx_Formation'));
      attacker.skills = [removal];
      game.actionLog.doAction(new RemoveSkillAction(attacker, removal));
      const removePresent = attacker.skills.includes(removal);

      attacker.skills = [new SkillObject(game.db.skills.get('Warabe_Asobi'))];
      target.skills = [new SkillObject(game.db.skills.get('Burning'))];
      target.currentHp = 20;
      splashTarget.currentHp = 20;
      outsider.currentHp = 20;
      const splashIndex = game.actionLog.actionIndex;
      applyCombatSkillEndHooks(game, [strike], attacker, target);
      const splash = {
        target: target.currentHp,
        nearby: splashTarget.currentHp,
        distant: outsider.currentHp,
      };
      const splashEndIndex = game.actionLog.actionIndex;
      while (game.actionLog.actionIndex > splashIndex) {
        game.actionLog.runActionBackward();
      }
      const splashReversed = {
        target: target.currentHp,
        nearby: splashTarget.currentHp,
        distant: outsider.currentHp,
      };
      while (game.actionLog.actionIndex < splashEndIndex) {
        game.actionLog.runActionForward();
      }

      const galeforce = new SkillObject(game.db.skills.get('Jump_Jump_Jump'));
      attacker.skills = [galeforce];
      target.skills = [];
      target.currentHp = 0;
      attacker.finished = true;
      attacker.hasMoved = true;
      attacker.hasAttacked = true;
      const galeforceIndex = game.actionLog.actionIndex;
      applyCombatSkillEndHooks(game, [strike], attacker, target);
      const refreshed = {
        finished: attacker.finished,
        moved: attacker.hasMoved,
        attacked: attacker.hasAttacked,
        jumping: attacker.skills.some((skill: any) => skill.nid === 'Jumping'),
      };
      while (game.actionLog.actionIndex > galeforceIndex) {
        game.actionLog.runActionBackward();
      }
      const refreshReversed = {
        finished: attacker.finished,
        moved: attacker.hasMoved,
        attacked: attacker.hasAttacked,
        jumping: attacker.skills.some((skill: any) => skill.nid === 'Jumping'),
      };

      attacker.skills = old.attackerSkills;
      target.skills = old.targetSkills;
      splashTarget.skills = old.splashSkills;
      attacker.team = old.attackerTeam;
      target.team = old.targetTeam;
      splashTarget.team = old.splashTeam;
      outsider.team = old.outsiderTeam;
      attacker.position = old.attackerPosition;
      target.position = old.targetPosition;
      splashTarget.position = old.splashPosition;
      outsider.position = old.outsiderPosition;
      target.currentHp = old.targetHp;
      splashTarget.currentHp = old.splashHp;
      outsider.currentHp = old.outsiderHp;
      attacker.finished = old.attackerFinished;
      attacker.hasMoved = old.attackerMoved;
      attacker.hasAttacked = old.attackerAttacked;
      game.eventManager = old.eventManager;
      return {
        wrongItem,
        snapshotted,
        calls,
        preCombat,
        preCombatReversed,
        removePresent,
        splash,
        splashReversed,
        refreshed,
        refreshReversed,
      };
    });

    expect(result.wrongItem).toBe(0);
    expect(result.snapshotted).toBe(1);
    expect(result.calls).toEqual([
      {
        nid: 'Global Item_Sovereign_Stone',
        type: 'event_after_initiated_combat',
      },
      {
        nid: 'Global Item_Invincible_Remove',
        type: 'event_on_remove',
      },
    ]);
    expect(result.preCombat).toEqual(['Spiked_Helm_Child']);
    expect(result.preCombatReversed).toEqual([]);
    expect(result.removePresent).toBe(false);
    expect(result.splash).toEqual({
      target: 16,
      nearby: 18,
      distant: 20,
    });
    expect(result.splashReversed).toEqual({
      target: 20,
      nearby: 20,
      distant: 20,
    });
    expect(result.refreshed).toEqual({
      finished: false,
      moved: false,
      attacked: false,
      jumping: true,
    });
    expect(result.refreshReversed).toEqual({
      finished: true,
      moved: true,
      attacked: true,
      jumping: false,
    });
  });
});
