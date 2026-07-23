import { test, expect } from '@playwright/test';

test.describe('skill turn lifecycle', () => {
  test('charge, time, expiry, and growing stat hooks are reversible', async ({ page }) => {
    await page.goto('/?harness=true&level=0&clean=true&bundle=false');
    await page.waitForFunction(() => !!(window as any).__harness?.ready, { timeout: 15000 });
    const result = await page.evaluate(async () => {
      const { SkillObject } = await import('/src/objects/skill.ts');
      const { applySkillTurnHooks } = await import('/src/engine/skill-turn-lifecycle.ts');
      const { statChange } = await import('/src/combat/skill-system.ts');
      const game = (window as any).__gameRef;
      const unit = game.getTeamUnits('player')[0];
      const oldSkills = unit.skills;
      const skill = new SkillObject({
        nid: '_TurnHooks', name: 'Turn Hooks', desc: '',
        icon_nid: '', icon_index: [0, 0],
        components: [
          ['build_charge', 5],
          ['upkeep_charge_increase', 2],
          ['charges_per_turn', 3],
          ['combined_time', 1],
        ],
      });
      const expiring = new SkillObject({
        nid: '_Expires', name: 'Expires', desc: '',
        icon_nid: '', icon_index: [0, 0],
        components: [['lost_on_endstep', null]],
      });
      const resources = new SkillObject({
        nid: '_Resources', name: 'Resources', desc: '',
        icon_nid: '', icon_index: [0, 0],
        components: [
          ['regeneration', 0.25],
          ['mana_regeneration', 3],
          ['upkeep_damage', 2],
          ['drain_charge', 2],
        ],
      });
      const growth = new SkillObject({
        nid: '_Growth', name: 'Growth', desc: '',
        icon_nid: '', icon_index: [0, 0],
        components: [['upkeep_stat_change', [['STR', 2]]]],
      });
      unit.skills = [skill, expiring, growth, resources];
      unit.currentHp = 10;
      unit.currentMana = 1;
      const before = game.actionLog.actionIndex;

      const upkeep = applySkillTurnHooks(game, [unit], 'upkeep');
      const afterUpkeep = {
        charge: skill.data.get('charge'),
        turns: skill.data.get('turns'),
        counter: growth.data.get('counter'),
        strength: statChange(unit, 'STR'),
        hp: unit.currentHp,
        mana: unit.currentMana,
        resourceCharge: resources.data.get('charge'),
        maxHp: unit.maxHp,
        effects: upkeep.map((effect: any) => effect.component),
      };
      const endstep = applySkillTurnHooks(game, [unit], 'endstep');
      const afterEndstep = {
        charge: skill.data.get('charge'),
        hasTimed: unit.skills.includes(skill),
        hasExpiring: unit.skills.includes(expiring),
        effects: endstep.map((effect: any) => effect.component),
      };
      const finalIndex = game.actionLog.actionIndex;

      while (game.actionLog.actionIndex > before) game.actionLog.runActionBackward();
      const reversed = {
        charge: skill.data.get('charge'),
        turns: skill.data.get('turns'),
        counter: growth.data.get('counter'),
        hasTimed: unit.skills.includes(skill),
        hasExpiring: unit.skills.includes(expiring),
        hp: unit.currentHp,
        mana: unit.currentMana,
        resourceCharge: resources.data.get('charge'),
      };
      while (game.actionLog.actionIndex < finalIndex) {
        game.actionLog.runActionForward();
      }
      const redone = {
        charge: skill.data.get('charge'),
        hasTimed: unit.skills.includes(skill),
        hasExpiring: unit.skills.includes(expiring),
      };
      unit.skills = oldSkills;
      return { afterUpkeep, afterEndstep, reversed, redone };
    });

    const expectedHp = 10 + Math.trunc(result.afterUpkeep.maxHp * 0.25) - 2;
    expect(result.afterUpkeep).toEqual({
      charge: 2,
      turns: 1,
      counter: 1,
      strength: 2,
      hp: expectedHp,
      mana: 4,
      resourceCharge: 1,
      maxHp: result.afterUpkeep.maxHp,
      effects: [
        'upkeep_charge_increase', 'combined_time', 'upkeep_stat_change',
        'regeneration', 'mana_regeneration', 'upkeep_damage',
      ],
    });
    expect(result.afterEndstep).toEqual({
      charge: 5,
      hasTimed: false,
      hasExpiring: false,
      effects: ['charges_per_turn', 'combined_time', 'lost_on_endstep'],
    });
    expect(result.reversed).toEqual({
      charge: 0,
      turns: 2,
      counter: 0,
      hasTimed: true,
      hasExpiring: true,
      hp: 10,
      mana: 1,
      resourceCharge: 2,
    });
    expect(result.redone).toEqual({
      charge: 5,
      hasTimed: false,
      hasExpiring: false,
    });
  });
});
