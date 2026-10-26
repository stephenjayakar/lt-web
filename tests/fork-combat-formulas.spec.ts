import { expect, test, type Page } from '@playwright/test';

/**
 * EOtF's engine fork resolves each combat formula from the item first
 * (combat_calcs.damage/defense/...: item_system.X_formula, then the skill's
 * only when the item's is the default). `magic` items use MAGIC_DAMAGE /
 * MAGIC_DEFENSE (weapon_components.Magic), and item formula hooks are
 * UNIQUE: the item's last formula component wins.
 */

async function bootEotf(page: Page): Promise<void> {
  await page.goto('/?harness=true&project=eotf.ltproj&level=X&clean=true&bundle=false');
  await page.waitForFunction(() => (window as any).__harness?.ready === true, undefined, { timeout: 60_000 });
}

test.describe('EOtF engine fork combat formulas', () => {
  test('magic items deal MAG damage and the item formula beats a skill formula', async ({ page }) => {
    await bootEotf(page);
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { ItemObject } = await import('/src/objects/item.ts');
      const { SkillObject } = await import('/src/objects/skill.ts');
      const { damage, defense } = await import('/src/combat/combat-calcs.ts');
      const { setForkEngine } = await import('/src/engine/engine-flavor.ts');
      const units = [...game.units.values()].filter((u: any) => u.position);
      const [attacker, defender] = units;
      const stat = (u: any, s: string) => u.getStatValue(s);
      const make = (nid: string, components: Array<[string, unknown]>) => new ItemObject({
        nid, name: nid, desc: '', icon_nid: '', icon_index: [0, 0], components,
      } as any);
      const blade = make('_ForkMagicBlade', [['weapon', null], ['magic', null], ['damage', 5]]);
      const tome = make('_ForkTome', [['weapon', null], ['magic', null], ['damage', 5]]);
      // Last formula component wins: alternate before magic -> MAGIC_DEFENSE.
      const ordered = make('_ForkOrdered', [
        ['weapon', null], ['alternate_resist_formula', 'ZERO'], ['magic', null], ['damage', 5],
      ]);
      const balance = new SkillObject({
        nid: '_ForkBalance', name: '_ForkBalance', desc: '', icon_nid: '', icon_index: [0, 0],
        components: [['alternate_resist_formula', 'BOTH_DEFENSE']],
      } as any);
      const savedSkills = defender.skills;
      const out: Record<string, number> = {
        mag: stat(attacker, 'MAG'),
        def: stat(defender, 'DEF'),
        res: stat(defender, 'RES'),
      };
      out.bladeDamage = damage(attacker, blade, game.db, game, defender);
      out.orderedDefense = defense(defender, ordered, game.db, game.board, game, attacker);
      defender.skills = [...savedSkills, balance];
      out.forkTomeDefense = defense(defender, tome, game.db, game.board, game, attacker);
      setForkEngine(false);
      out.upstreamTomeDefense = defense(defender, tome, game.db, game.board, game, attacker);
      setForkEngine(true);
      defender.skills = savedSkills;
      return out;
    });
    expect(result.bladeDamage).toBe(result.mag + 5);
    expect(result.orderedDefense).toBe(result.res);
    // Fork: the tome's MAGIC_DEFENSE wins over the skill's BOTH_DEFENSE.
    expect(result.forkTomeDefense).toBe(result.res);
    // Upstream: the skill alternate wins.
    expect(result.upstreamTomeDefense).toBe(result.def + result.res);
  });
});
