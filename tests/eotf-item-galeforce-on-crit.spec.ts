import { expect, test, type Page } from '@playwright/test';

async function bootEotf(page: Page): Promise<void> {
  await page.goto('/?harness=true&project=eotf.ltproj&level=X&clean=true&bundle=false');
  await page.waitForFunction(() => (window as any).__harness?.ready === true, undefined, {
    timeout: 30_000,
  });
}

test.describe('Embrace of the Fog Blitz Strike item hook', () => {
  test('count-locks the override and its skill/status references', async ({ page }) => {
    await bootEotf(page);
    const result = await page.evaluate(() => {
      const game = (window as any).__gameRef;
      const uses = [...game.db.items.values()].flatMap((item: any) =>
        item.components
          .filter(([nid]: [string, unknown]) => nid === 'galeforce_on_crit')
          .map(([, value]: [string, unknown]) => ({ item: item.nid, value })),
      );
      const blitz = game.db.skills.get('Blitz_Strike');
      const status = game.db.skills.get('Galeforce_Status');
      return {
        uses,
        override: blitz?.components.find(
          ([nid]: [string, unknown]) => nid === 'item_override',
        )?.[1],
        charges: blitz?.components.find(
          ([nid]: [string, unknown]) => nid === 'drain_charge_all',
        )?.[1],
        statusComponents: status?.components.map(
          ([nid]: [string, unknown]) => nid,
        ),
      };
    });

    expect(result).toEqual({
      uses: [{ item: 'BlitzStrikeOverride', value: null }],
      override: 'BlitzStrikeOverride',
      charges: 2,
      statusComponents: ['hidden', 'lost_on_end_chapter'],
    });
  });

  test('grants once per crit combat, shares the charge, and replays exactly', async ({ page }) => {
    await bootEotf(page);
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { SkillObject } = await import('/src/objects/skill.ts');
      const { ItemObject } = await import('/src/objects/item.ts');
      const { applyCombatItemEndHooks } =
        await import('/src/combat/combat-lifecycle.ts');
      const attacker = game.units.get('Player');
      const ally = game.units.get('Lib');
      const defender = game.units.get('Keeper');
      const old = {
        attackerSkills: attacker.skills,
        allySkills: ally.skills,
        defenderSkills: defender.skills,
        attackerTeam: attacker.team,
        allyTeam: ally.team,
        defenderTeam: defender.team,
        attackerParty: attacker.party,
        allyParty: ally.party,
        defenderParty: defender.party,
        attackerItems: attacker.items,
      };
      attacker.team = 'player';
      ally.team = 'player';
      defender.team = 'enemy';
      attacker.party = game.currentParty;
      ally.party = game.currentParty;
      defender.party = 'enemy';
      const ownerBlitz = new SkillObject(game.db.skills.get('Blitz_Strike'));
      const allyBlitz = new SkillObject(game.db.skills.get('Blitz_Strike'));
      const enemyBlitz = new SkillObject(game.db.skills.get('Blitz_Strike'));
      attacker.skills = [ownerBlitz];
      ally.skills = [allyBlitz];
      defender.skills = [enemyBlitz];
      const item = new ItemObject({
        nid: '_EotfBlitzWeapon',
        name: 'EotF Blitz Weapon',
        desc: '',
        components: [['weapon', null]],
      });
      attacker.items = [item];
      const mark = {
        attacker,
        defender,
        item,
        hit: true,
        crit: false,
        damage: 1,
        isCounter: false,
        mode: 'attack',
        attackInfo: [0, 0] as [number, number],
      };
      const beforeIndex = game.actionLog.actionIndex;
      const noCritApplied = applyCombatItemEndHooks(game, [mark]);
      const afterNoCritIndex = game.actionLog.actionIndex;
      const applied = applyCombatItemEndHooks(game, [
        { ...mark, crit: true },
        { ...mark, crit: true, attackInfo: [0, 1] as [number, number] },
      ]);
      const afterIndex = game.actionLog.actionIndex;
      const status = attacker.skills.find(
        (skill: any) => skill.nid === 'Galeforce_Status',
      );
      const snapshot = () => ({
        ownerCharge: ownerBlitz.data.get('charge'),
        allyCharge: allyBlitz.data.get('charge'),
        enemyCharge: enemyBlitz.data.get('charge'),
        statusCount: attacker.skills.filter(
          (skill: any) => skill.nid === 'Galeforce_Status',
        ).length,
        sameStatus: attacker.skills.includes(status),
      });
      const changed = snapshot();
      while (game.actionLog.actionIndex > beforeIndex) {
        game.actionLog.runActionBackward();
      }
      const reversed = snapshot();
      while (game.actionLog.actionIndex < afterIndex) {
        game.actionLog.runActionForward();
      }
      const redone = snapshot();
      const initiatorNid = status?.initiatorNid;
      attacker.skills = old.attackerSkills;
      ally.skills = old.allySkills;
      defender.skills = old.defenderSkills;
      attacker.team = old.attackerTeam;
      ally.team = old.allyTeam;
      defender.team = old.defenderTeam;
      attacker.party = old.attackerParty;
      ally.party = old.allyParty;
      defender.party = old.defenderParty;
      attacker.items = old.attackerItems;
      return {
        noCritApplied,
        noCritActions: afterNoCritIndex - beforeIndex,
        applied,
        changed,
        reversed,
        redone,
        initiatorNid,
      };
    });

    expect(result.noCritApplied).toBe(0);
    expect(result.noCritActions).toBe(0);
    expect(result.applied).toBe(2);
    expect(result.changed).toEqual({
      ownerCharge: 1,
      allyCharge: 1,
      enemyCharge: 2,
      statusCount: 1,
      sameStatus: true,
    });
    expect(result.reversed).toEqual({
      ownerCharge: 2,
      allyCharge: 2,
      enemyCharge: 2,
      statusCount: 0,
      sameStatus: false,
    });
    expect(result.redone).toEqual(result.changed);
    expect(result.initiatorNid).toBe('Player');
  });

  test('does not trigger out of phase or when the shared charge is depleted', async ({ page }) => {
    await bootEotf(page);
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { SkillObject } = await import('/src/objects/skill.ts');
      const { ItemObject } = await import('/src/objects/item.ts');
      const { applyCombatItemEndHooks } =
        await import('/src/combat/combat-lifecycle.ts');
      const attacker = game.units.get('Player');
      const defender = game.units.get('Keeper');
      const oldSkills = attacker.skills;
      const oldTeam = attacker.team;
      const blitz = new SkillObject(game.db.skills.get('Blitz_Strike'));
      attacker.skills = [blitz];
      const item = new ItemObject({
        nid: '_EotfDepletedBlitzWeapon',
        name: 'Depleted EotF Blitz Weapon',
        desc: '',
        components: [['weapon', null]],
      });
      const beforeIndex = game.actionLog.actionIndex;
      const strike = {
        attacker,
        defender,
        item,
        hit: true,
        crit: true,
        damage: 1,
        isCounter: false,
        mode: 'attack',
        attackInfo: [0, 0] as [number, number],
      };
      const currentTeam = game.phase.getCurrent();
      attacker.team = currentTeam === 'player' ? 'enemy' : 'player';
      const wrongPhaseApplied = applyCombatItemEndHooks(game, [strike]);
      attacker.team = currentTeam;
      blitz.data.set('charge', 0);
      const depletedApplied = applyCombatItemEndHooks(game, [strike]);
      const result = {
        wrongPhaseApplied,
        depletedApplied,
        actions: game.actionLog.actionIndex - beforeIndex,
        charge: blitz.data.get('charge'),
        status: attacker.skills.some(
          (skill: any) => skill.nid === 'Galeforce_Status',
        ),
      };
      attacker.skills = oldSkills;
      attacker.team = oldTeam;
      return result;
    });

    expect(result).toEqual({
      wrongPhaseApplied: 0,
      depletedApplied: 0,
      actions: 0,
      charge: 0,
      status: false,
    });
  });
});
