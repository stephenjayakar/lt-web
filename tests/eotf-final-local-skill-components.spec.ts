import { expect, test, type Page } from '@playwright/test';

async function bootEotf(page: Page): Promise<void> {
  await page.goto('/?harness=true&project=eotf.ltproj&level=X&clean=true&bundle=false');
  await page.waitForFunction(() => (window as any).__harness?.ready === true, undefined, {
    timeout: 30_000,
  });
}

test.describe('Embrace of the Fog remaining local skill components', () => {
  test('count-locks authored values and preserves Visual Charge chapter state', async ({
    page,
  }) => {
    await bootEotf(page);
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { SkillObject } = await import('/src/objects/skill.ts');
      const { evaluateExpression } = await import('/src/events/event-manager.ts');
      const selected = new Set([
        'booster_blocker',
        'trigger_charge',
        'upkeep_aoe_skill_gain',
        'visual_charge',
      ]);
      const rows: Array<{ skill: string; component: string; value: unknown }> = [];
      for (const skill of game.db.skills.values()) {
        for (const [component, value] of skill.components) {
          if (selected.has(component)) rows.push({ skill: skill.nid, component, value });
        }
      }
      const unit = game.units.get('Player');
      const oldSkills = unit.skills;
      const oldUnits = game.units;
      const visual = new SkillObject(game.db.skills.get('BP'));
      visual.data.set('charge', 2);
      unit.skills = [visual];
      game.units = new Map([[unit.nid, unit]]);
      const before = game.actionLog.actionIndex;
      const cleanup = game.applySkillEndChapterHooks();
      const reset = visual.data.get('charge');
      const after = game.actionLog.actionIndex;
      while (game.actionLog.actionIndex > before) {
        game.actionLog.runActionBackward();
      }
      const reversed = visual.data.get('charge');
      while (game.actionLog.actionIndex < after) {
        game.actionLog.runActionForward();
      }
      const redone = visual.data.get('charge');
      game.units = oldUnits;

      const blocker = new SkillObject(
        game.db.skills.get('The_Serpents_Deal_Blocker'),
      );
      unit.skills = [blocker];
      const marker = evaluateExpression(
        '[s.nid for s in unit.skills if s.booster_blocker]',
        {
          game,
          unit1: unit,
          gameVars: game.gameVars,
          levelVars: game.levelVars,
        },
      );
      unit.skills = oldSkills;
      return {
        counts: Object.fromEntries([...selected].map((component) => [
          component,
          rows.filter((row) => row.component === component).length,
        ])),
        visualValues: rows
          .filter((row) => row.component === 'visual_charge')
          .map((row) => row.value)
          .sort(),
        aoeShapesValid: rows
          .filter((row) => row.component === 'upkeep_aoe_skill_gain')
          .every((row) => {
            const value = row.value as Record<string, unknown>;
            return typeof value?.skill === 'string' &&
              typeof value?.range === 'number' &&
              typeof value?.affect_self === 'boolean' &&
              ['ally', 'enemy', 'any'].includes(String(value?.target));
          }),
        initialTotal: visual.data.get('total_charge'),
        cleanup,
        reset,
        reversed,
        redone,
        marker,
      };
    });

    expect(result.counts).toEqual({
      booster_blocker: 3,
      trigger_charge: 1,
      upkeep_aoe_skill_gain: 6,
      visual_charge: 2,
    });
    expect(result.visualValues).toEqual([3, 5]);
    expect(result.aoeShapesValid).toBe(true);
    expect(result.initialTotal).toBe(3);
    expect(result.cleanup).toEqual({ reset: 1, removed: 0 });
    expect([result.reset, result.reversed, result.redone]).toEqual([0, 2, 0]);
    expect(result.marker).toEqual(['The_Serpents_Deal_Blocker']);
  });

  test('forces one end-combat charge trigger with exact replay', async ({ page }) => {
    await bootEotf(page);
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { ItemObject } = await import('/src/objects/item.ts');
      const { SkillObject } = await import('/src/objects/skill.ts');
      const { applyCombatSkillEndHooks } =
        await import('/src/combat/combat-lifecycle.ts');
      const attacker = game.units.get('Player');
      const defender = game.units.get('Keeper');
      const oldSkills = attacker.skills;
      const source = new SkillObject({
        nid: '_ForcedCharge',
        name: '',
        desc: '',
        icon_nid: '',
        icon_index: [0, 0],
        components: [
          ['drain_charge', 3],
          ['trigger_charge', null],
        ],
      });
      attacker.skills = [source];
      const item = new ItemObject({
        nid: '_ForcedChargeWeapon',
        name: '',
        desc: '',
        icon_nid: '',
        icon_index: [0, 0],
        components: [['weapon', null]],
      });
      const before = game.actionLog.actionIndex;
      const applied = applyCombatSkillEndHooks(game, [{
        attacker,
        defender,
        item,
        hit: false,
        crit: false,
        damage: 0,
        isCounter: false,
        mode: 'attack',
        attackInfo: [0, 0],
      }], attacker, defender);
      const after = game.actionLog.actionIndex;
      const charge = source.data.get('charge');
      while (game.actionLog.actionIndex > before) game.actionLog.runActionBackward();
      const reversed = source.data.get('charge');
      while (game.actionLog.actionIndex < after) game.actionLog.runActionForward();
      const redone = source.data.get('charge');
      attacker.skills = oldSkills;
      return { applied, charge, reversed, redone };
    });

    expect(result).toEqual({
      applied: 1,
      charge: 2,
      reversed: 3,
      redone: 2,
    });
  });

  test('grants configured upkeep AoE skills by allegiance and replays identity', async ({
    page,
  }) => {
    await bootEotf(page);
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { SkillObject } = await import('/src/objects/skill.ts');
      const { applySkillTurnHooks } =
        await import('/src/engine/skill-turn-lifecycle.ts');
      const owner = game.units.get('Player');
      const target = game.units.get('Keeper');
      const old = {
        ownerSkills: owner.skills,
        ownerPosition: owner.position,
        ownerTeam: owner.team,
        targetSkills: target.skills,
        targetPosition: target.position,
        targetTeam: target.team,
        targetHp: target.currentHp,
        targetDead: target.dead,
      };
      owner.position = [1, 1];
      owner.team = 'player';
      target.position = [4, 1];
      target.team = 'enemy';
      target.currentHp = Math.max(1, target.currentHp);
      target.dead = false;
      const source = new SkillObject({
        nid: '_UpkeepAoe',
        name: '',
        desc: '',
        icon_nid: '',
        icon_index: [0, 0],
        components: [[
          'upkeep_aoe_skill_gain',
          {
            skill: 'Sky_Strike_Child',
            range: 3,
            affect_self: true,
            target: 'any',
          },
        ]],
      });
      owner.skills = [source];
      target.skills = [];
      const before = game.actionLog.actionIndex;
      const effects = applySkillTurnHooks(game, [owner], 'upkeep');
      const after = game.actionLog.actionIndex;
      const snapshot = () => ({
        owner: owner.skills
          .filter((skill: any) => skill.nid === 'Sky_Strike_Child')
          .map((skill: any) => ({ uid: skill.uid, initiator: skill.initiatorNid })),
        target: target.skills
          .filter((skill: any) => skill.nid === 'Sky_Strike_Child')
          .map((skill: any) => ({ uid: skill.uid, initiator: skill.initiatorNid })),
      });
      const changed = snapshot();
      while (game.actionLog.actionIndex > before) game.actionLog.runActionBackward();
      const reversed = snapshot();
      while (game.actionLog.actionIndex < after) game.actionLog.runActionForward();
      const redone = snapshot();

      owner.skills = old.ownerSkills;
      owner.position = old.ownerPosition;
      owner.team = old.ownerTeam;
      target.skills = old.targetSkills;
      target.position = old.targetPosition;
      target.team = old.targetTeam;
      target.currentHp = old.targetHp;
      target.dead = old.targetDead;
      return {
        effects: effects.map((effect: any) => ({
          component: effect.component,
          value: effect.value,
        })),
        changed,
        reversed,
        redone,
        ownerNid: owner.nid,
      };
    });

    expect(result.effects).toEqual([{
      component: 'upkeep_aoe_skill_gain',
      value: 2,
    }]);
    expect(result.changed.owner).toHaveLength(1);
    expect(result.changed.target).toHaveLength(1);
    expect(result.changed.owner[0].initiator).toBe(result.ownerNid);
    expect(result.changed.target[0].initiator).toBe(result.ownerNid);
    expect(result.reversed).toEqual({ owner: [], target: [] });
    expect(result.redone).toEqual(result.changed);
  });
});
