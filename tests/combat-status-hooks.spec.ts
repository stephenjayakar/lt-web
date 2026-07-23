import { expect, test } from '@playwright/test';

async function waitForHarness(page: import('@playwright/test').Page): Promise<void> {
  await page.waitForFunction(() => !!(window as any).__harness?.ready, { timeout: 15000 });
}

test.describe('combat status skill hooks', () => {
  test('dispatches hit/combat/attack ally-enemy semantics with reversible charge use', async ({ page }) => {
    await page.goto('/?harness=true&level=0&clean=true&bundle=false');
    await waitForHarness(page);

    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { ItemObject } = await import('/src/objects/item.ts');
      const { SkillObject } = await import('/src/objects/skill.ts');
      const { applyCombatSkillEndHooks } =
        await import('/src/combat/combat-lifecycle.ts');
      const attacker = game.units.get('Eirika');
      const ally = game.units.get('Seth');
      const enemy = [...game.units.values()].find((unit: any) => unit.team === 'enemy');
      if (!attacker || !ally || !enemy) return null;

      const statusNid = '_CombatHookStatus';
      game.db.skills.set(statusNid, {
        nid: statusNid, name: 'Marked', desc: '',
        icon_nid: '', icon_index: [0, 0], components: [],
      });
      const item = new ItemObject({
        nid: '_HookWeapon', name: 'Hook Weapon', desc: '',
        icon_nid: '', icon_index: [0, 0],
        components: [['weapon', null], ['uses', 20]],
      });
      const oldSkills = [...attacker.skills];
      const oldEnemySkills = [...enemy.skills];
      const oldAllySkills = [...ally.skills];

      const run = (
        component: string,
        target: any,
        hit: boolean,
        charged = false,
      ) => {
        const components: [string, any][] = [[component, statusNid]];
        if (charged) components.push(['drain_charge', 2]);
        const hook = new SkillObject({
          nid: `_Hook_${component}`, name: component, desc: '',
          icon_nid: '', icon_index: [0, 0], components,
        });
        attacker.skills = [hook];
        target.skills = target === enemy ? [...oldEnemySkills] : [...oldAllySkills];
        const before = game.actionLog.actionIndex;
        const applied = applyCombatSkillEndHooks(game, [{
          attacker, defender: target, item, hit, crit: false, damage: 0,
          isCounter: false, attackInfo: [0, 0],
        }]);
        const after = game.actionLog.actionIndex;
        const changed = {
          applied,
          hasStatus: target.skills.some((skill: any) => skill.nid === statusNid),
          initiator: target.skills.find((skill: any) => skill.nid === statusNid)?.initiatorNid ?? null,
          charge: hook.data.get('charge') ?? null,
        };
        while (game.actionLog.actionIndex > before) game.actionLog.runActionBackward();
        const reversed = {
          hasStatus: target.skills.some((skill: any) => skill.nid === statusNid),
          charge: hook.data.get('charge') ?? null,
        };
        while (game.actionLog.actionIndex < after) game.actionLog.runActionForward();
        const redone = {
          hasStatus: target.skills.some((skill: any) => skill.nid === statusNid),
          charge: hook.data.get('charge') ?? null,
        };
        while (game.actionLog.actionIndex > before) game.actionLog.runActionBackward();
        return { changed, reversed, redone };
      };

      const afterHit = run('give_status_after_hit', enemy, true, true);
      const onHitMiss = run('give_status_after_combat_on_hit', enemy, false);
      const afterAttackMiss = run('give_status_after_attack', enemy, false);
      const enemyAfterCombat = run('give_status_after_combat', enemy, false);
      const allyAfterCombat = run('give_ally_status_after_combat', ally, false);

      attacker.skills = [];
      enemy.skills = [new SkillObject({
        nid: '_DefenderHook', name: 'Defender Hook', desc: '',
        icon_nid: '', icon_index: [0, 0],
        components: [['give_status_after_combat', statusNid]],
      })];
      const passiveBefore = game.actionLog.actionIndex;
      const passiveApplied = applyCombatSkillEndHooks(game, [{
        attacker, defender: enemy, item, hit: false, crit: false, damage: 0,
        isCounter: false, attackInfo: [0, 0],
      }], attacker, enemy);
      const passiveDefender = {
        applied: passiveApplied,
        attackerMarked: attacker.skills.some((skill: any) => skill.nid === statusNid),
      };
      while (game.actionLog.actionIndex > passiveBefore) game.actionLog.runActionBackward();

      attacker.skills = oldSkills;
      enemy.skills = oldEnemySkills;
      ally.skills = oldAllySkills;
      game.db.skills.delete(statusNid);
      return {
        afterHit,
        onHitMiss,
        afterAttackMiss,
        enemyAfterCombat,
        allyAfterCombat,
        passiveDefender,
      };
    });

    expect(result).not.toBeNull();
    expect(result!.afterHit).toEqual({
      changed: { applied: 1, hasStatus: true, initiator: 'Eirika', charge: 1 },
      reversed: { hasStatus: false, charge: 2 },
      redone: { hasStatus: true, charge: 1 },
    });
    expect(result!.onHitMiss.changed.applied).toBe(0);
    expect(result!.onHitMiss.changed.hasStatus).toBe(false);
    expect(result!.afterAttackMiss.changed.applied).toBe(1);
    expect(result!.afterAttackMiss.changed.hasStatus).toBe(true);
    expect(result!.enemyAfterCombat.changed.applied).toBe(1);
    expect(result!.enemyAfterCombat.changed.hasStatus).toBe(true);
    expect(result!.allyAfterCombat.changed.applied).toBe(1);
    expect(result!.allyAfterCombat.changed.hasStatus).toBe(true);
    expect(result!.passiveDefender).toEqual({
      applied: 1,
      attackerMarked: true,
    });
  });
});
