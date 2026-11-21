/**
 * `eval_warning` target icons (Python `EvalWarning.target_icon`) beyond the
 * fork's shipped Rexobscura dict, which item-icon-flash.spec.ts covers:
 *  - a fork dict with `is_danger: True` gives 'danger' only when its
 *    condition holds;
 *  - upstream's plain string value gives 'danger' when truthy;
 *  - an expression that raises contributes no icon;
 *  - nothing is drawn over a target that is not an enemy of the holder.
 */
import { expect, test, type Page } from '@playwright/test';

async function bootEotf(page: Page): Promise<void> {
  await page.goto('/?harness=true&project=eotf.ltproj&level=X&clean=true&bundle=false');
  await page.waitForFunction(() => (window as any).__harness?.ready === true, undefined, {
    timeout: 60_000,
  });
}

test('eval_warning dict, string and raising expressions', async ({ page }) => {
  await bootEotf(page);
  const result = await page.evaluate(async () => {
    const game = (window as any).__gameRef;
    const { UnitObject } = await import('/src/objects/unit.ts');
    const { ItemObject } = await import('/src/objects/item.ts');
    const { computeTargetIcons } = await import('/src/combat/item-system.ts');
    const klass = [...game.db.classes.values()].find((c: any) => c.wexp_gain?.Sword?.[0]);
    const makeUnit = (nid: string, team: string) => {
      const unit = new UnitObject({
        nid, name: nid, desc: '', variant: null, level: 1, klass: klass.nid,
        tags: [], bases: { ...klass.bases }, growths: {}, stat_cap_modifiers: {},
        starting_items: [], learned_skills: [], unit_notes: [], fields: [],
        wexp_gain: {}, portrait_nid: '', affinity: '',
      }, klass);
      unit.team = team;
      unit.items = [];
      unit.skills = [];
      unit.position = [1, 1];
      return unit;
    };
    const holder = makeUnit('_Warn_Holder', 'enemy');
    const target = makeUnit('_Warn_Target', 'player');
    const friend = makeUnit('_Warn_Friend', 'enemy');
    const sword = new ItemObject(game.db.items.get('Iron_Sword'));
    sword.owner = target;
    target.items = [sword];
    target.equippedWeapon = sword;

    const item = new ItemObject(game.db.items.get('Iron_Sword'));
    item.owner = holder;
    holder.items = [item];
    const icons = (value: unknown, against = target) => {
      item.components.set('eval_warning', value);
      return computeTargetIcons(holder, item, against, game.db, game);
    };
    return {
      dangerDictMatch: icons({ condition: "target.nid == '_Warn_Target' and item.nid == 'Iron_Sword'", is_danger: true }),
      dangerDictMiss: icons({ condition: "target.nid == 'Nobody'", is_danger: true }),
      warningDict: icons({ condition: 'True', is_danger: false }),
      stringMatch: icons("unit.nid == '_Warn_Holder' and target.get_weapon() is not None"),
      stringMiss: icons('target.get_weapon() is None'),
      raising: icons('this_does_not_exist.explode()'),
      notEnemy: icons({ condition: 'True', is_danger: true }, friend),
    };
  });
  expect(result).toEqual({
    dangerDictMatch: ['danger'],
    dangerDictMiss: [],
    warningDict: ['warning'],
    stringMatch: ['danger'],
    stringMiss: [],
    raising: [],
    notEnemy: [],
  });
});
