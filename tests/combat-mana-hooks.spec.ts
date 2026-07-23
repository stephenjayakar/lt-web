import { test, expect } from '@playwright/test';

test.describe('combat mana skill hooks', () => {
  test('gates, gains, spends, and rewinds mana with combat lifecycle', async ({ page }) => {
    await page.goto('/?harness=true&level=0&clean=true&bundle=false');
    await page.waitForFunction(() => !!(window as any).__harness?.ready, { timeout: 15000 });
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { SkillObject } = await import('/src/objects/skill.ts');
      const { evaluateEquation } = await import('/src/combat/combat-calcs.ts');
      const {
        CombatSkillLifecycle,
        CombatLifecycleRecord,
      } = await import('/src/combat/combat-skill-lifecycle.ts');
      const attacker = game.units.get('Eirika');
      const defender = [...game.units.values()].find((unit: any) => unit.team === 'enemy');
      const item = attacker?.items.find((candidate: any) => candidate.isWeapon());
      if (!attacker || !defender || !item) return null;

      const oldSkills = attacker.skills;
      const oldMana = attacker.currentMana;
      attacker.currentMana = 5;
      attacker.skills = [new SkillObject({
        nid: '_ManaHooks', name: 'Mana Hooks', desc: '',
        icon_nid: '', icon_index: [0, 0],
        components: [
          ['check_mana', 4],
          ['gain_mana', 'unit2.level + 1'],
          ['cost_mana', 4],
        ],
      })];
      const record = new CombatLifecycleRecord([attacker], null);
      const lifecycle = new CombatSkillLifecycle(game.db, () => 99, game);
      lifecycle.beginCombat(attacker, item, [defender], new Map([[defender, null]]));
      record.finish();
      const changed = attacker.currentMana;
      record.execute();
      record.reverse();
      const reversed = attacker.currentMana;
      record.execute();
      const redone = attacker.currentMana;

      attacker.currentMana = 3;
      const gatedRecord = new CombatLifecycleRecord([attacker], null);
      const gated = new CombatSkillLifecycle(game.db, () => 99, game);
      gated.beginCombat(attacker, item, [defender], new Map([[defender, null]]));
      gatedRecord.finish();
      const gatedMana = attacker.currentMana;

      attacker.skills = oldSkills;
      attacker.currentMana = oldMana;
      return {
        changed,
        reversed,
        redone,
        gatedMana,
        targetLevel: defender.level,
        maxMana: Math.max(0, Math.trunc(evaluateEquation(
          game.db.getEquation('MANA') ?? '0', attacker, { db: game.db },
        ))),
      };
    });

    expect(result).not.toBeNull();
    expect(result!.changed).toBe(
      Math.max(0, Math.min(result!.maxMana, 5 + result!.targetLevel + 1) - 4),
    );
    expect(result!.reversed).toBe(5);
    expect(result!.redone).toBe(result!.changed);
    expect(result!.gatedMana).toBe(3);
  });
});
