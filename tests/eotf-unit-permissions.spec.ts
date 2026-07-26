import { expect, test, type Page } from '@playwright/test';

async function bootEotf(page: Page): Promise<void> {
  await page.goto('/?harness=true&project=eotf.ltproj&level=X&clean=true&bundle=false');
  await page.waitForFunction(() => (window as any).__harness?.ready === true, undefined, {
    timeout: 30_000,
  });
}

test.describe('Embrace of the Fog unit permission skills', () => {
  test('count-locks all 40 authored permission and alliance markers', async ({ page }) => {
    await bootEotf(page);
    const result = await page.evaluate(() => {
      const game = (window as any).__gameRef;
      const selected = new Set([
        'cannot_trade',
        'ignore_alliances',
        'ignore_rescue_penalty',
        'locktouch',
        'unselectable',
      ]);
      const counts: Record<string, number> = {};
      const invalid: string[] = [];
      for (const skill of game.db.skills.values()) {
        for (const [nid, value] of skill.components) {
          if (!selected.has(nid)) continue;
          counts[nid] = (counts[nid] ?? 0) + 1;
          if (value !== null) invalid.push(`${skill.nid}:${nid}`);
        }
      }
      return { counts, invalid };
    });

    expect(result).toEqual({
      counts: {
        cannot_trade: 2,
        ignore_alliances: 9,
        ignore_rescue_penalty: 8,
        locktouch: 6,
        unselectable: 15,
      },
      invalid: [],
    });
  });

  test('conditions and charges gate selection, alliances, rescue, locks, and trade', async ({ page }) => {
    await bootEotf(page);
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { SkillObject } = await import('/src/objects/skill.ts');
      const {
        canSelect,
        canTradeWith,
        canUnlock,
        checkAlly,
        checkEnemy,
        ignoreRescuePenalty,
        noTrade,
        onRescue,
      } = await import('/src/combat/skill-system.ts');
      const unit = game.units.get('Player');
      const target = game.units.get('Keeper');
      const oldUnitSkills = unit.skills;
      const oldTargetSkills = target.skills;
      const oldUnitItems = unit.items;
      const oldTargetTeam = target.team;
      const oldFlags = {
        hasTraded: unit.hasTraded,
        hasAttacked: unit.hasAttacked,
      };
      const make = (nid: string, components: [string, unknown][]) =>
        new SkillObject({
          nid, name: nid, desc: '', icon_nid: '', icon_index: [0, 0], components,
        });
      const inactive = (component: string) =>
        make(`_Inactive_${component}`, [[component, null], ['condition', 'False']]);
      const active = (component: string) =>
        make(`_Active_${component}`, [[component, null], ['condition', 'True']]);

      try {
        target.team = unit.team;
        target.skills = [];
        unit.items = [];
        unit.hasTraded = false;
        unit.hasAttacked = false;

        unit.skills = [inactive('unselectable')];
        const selectableInactive = canSelect(unit, game);
        unit.skills = [active('unselectable')];
        const selectableActive = canSelect(unit, game);

        unit.skills = [inactive('ignore_alliances')];
        const alliancesInactive = {
          ally: checkAlly(unit, target, game.db, game),
          enemy: checkEnemy(unit, target, game.db, game),
        };
        const chargedAlliance = make('_ChargedAlliance', [
          ['ignore_alliances', null],
          ['drain_charge', 1],
        ]);
        chargedAlliance.data.set('charge', 0);
        unit.skills = [chargedAlliance];
        const allianceDepleted = checkAlly(unit, target, game.db, game);
        chargedAlliance.data.set('charge', 1);
        const alliancesActive = {
          ally: checkAlly(unit, target, game.db, game),
          enemy: checkEnemy(unit, target, game.db, game),
        };

        unit.skills = [inactive('ignore_rescue_penalty')];
        const rescueInactive = {
          ignored: ignoreRescuePenalty(unit, game),
          grants: onRescue(
            unit,
            target,
            (nid: string) => make(nid, []),
            game,
          ).map((skill: any) => skill.nid),
        };
        unit.skills = [active('ignore_rescue_penalty')];
        const rescueActive = {
          ignored: ignoreRescuePenalty(unit, game),
          grants: onRescue(
            unit,
            target,
            (nid: string) => make(nid, []),
            game,
          ).map((skill: any) => skill.nid),
        };

        unit.skills = [inactive('locktouch')];
        const unlockInactive = {
          hook: canUnlock(unit, {}, game),
          unit: unit.canUnlock({}),
        };
        unit.skills = [active('locktouch')];
        const unlockActive = {
          hook: canUnlock(unit, {}, game),
          unit: unit.canUnlock({}),
        };

        unit.skills = [inactive('cannot_trade')];
        const tradeInactive = {
          blocked: noTrade(unit, game),
          turn: unit.canTrade(),
          partner: canTradeWith(unit, target, game.db, game),
        };
        unit.skills = [active('cannot_trade')];
        const tradeActive = {
          blocked: noTrade(unit, game),
          turn: unit.canTrade(),
          partner: canTradeWith(unit, target, game.db, game),
        };
        unit.skills = [];
        target.skills = [active('cannot_trade')];
        const partnerBlocked = canTradeWith(unit, target, game.db, game);

        return {
          selectableInactive,
          selectableActive,
          alliancesInactive,
          allianceDepleted,
          alliancesActive,
          rescueInactive,
          rescueActive,
          unlockInactive,
          unlockActive,
          tradeInactive,
          tradeActive,
          partnerBlocked,
        };
      } finally {
        unit.skills = oldUnitSkills;
        target.skills = oldTargetSkills;
        unit.items = oldUnitItems;
        target.team = oldTargetTeam;
        unit.hasTraded = oldFlags.hasTraded;
        unit.hasAttacked = oldFlags.hasAttacked;
      }
    });

    expect(result).toEqual({
      selectableInactive: true,
      selectableActive: false,
      alliancesInactive: { ally: true, enemy: false },
      allianceDepleted: true,
      alliancesActive: { ally: false, enemy: true },
      rescueInactive: { ignored: false, grants: ['Rescue'] },
      rescueActive: { ignored: true, grants: [] },
      unlockInactive: { hook: false, unit: false },
      unlockActive: { hook: true, unit: true },
      tradeInactive: { blocked: false, turn: true, partner: true },
      tradeActive: { blocked: true, turn: false, partner: false },
      partnerBlocked: false,
    });
  });
});
