import { test, expect } from '@playwright/test';

test.describe('scripted Pair Up combat', () => {
  test('scripted leader phases retain attack-stance partner strikes', async ({ page }) => {
    await page.goto('/?harness=true&level=0&clean=true&bundle=false');
    await page.waitForFunction(() => !!(window as any).__harness?.ready, { timeout: 15000 });
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { UnitObject } = await import('/src/objects/unit.ts');
      const { ItemObject } = await import('/src/objects/item.ts');
      const { CombatPhaseSolver } = await import('/src/combat/combat-solver.ts');
      const template = game.db.units.get('Eirika');
      const klass = template && game.db.classes.get(template.klass);
      const weaponPrefab = game.db.items.get('Iron_Sword') ?? game.db.items.get('Iron Sword');
      if (!template || !klass || !weaponPrefab) return null;
      const makeUnit = (nid: string, team: string) => {
        const unit = new UnitObject({ ...template, nid, name: nid, starting_items: [] }, klass);
        unit.team = team;
        unit.stats.HP = 99;
        unit.maxStats.HP = 99;
        unit.currentHp = 99;
        const item = new ItemObject(weaponPrefab);
        item.owner = unit;
        unit.items = [item];
        return unit;
      };
      const attacker = makeUnit('_ScriptLeaderA', 'player');
      const attackPartner = makeUnit('_ScriptPartnerA', 'player');
      const defender = makeUnit('_ScriptLeaderD', 'enemy');
      const defensePartner = makeUnit('_ScriptPartnerD', 'enemy');
      attacker.strikePartner = attackPartner;
      defender.strikePartner = defensePartner;
      const oldPairup = game.db.constants.get('pairup');
      game.db.constants.set('pairup', true);
      const solver = new CombatPhaseSolver(() => 0, game);
      const strikes = solver.resolve(
        attacker,
        attacker.items[0],
        defender,
        defender.items[0],
        game.db,
        'grandmaster',
        game.board,
        ['hit1', 'hit2', 'end'],
      ).map((strike: any) => ({
        attacker: strike.attacker.nid,
        assist: !!strike.assist,
        isCounter: strike.isCounter,
      }));
      if (oldPairup === undefined) game.db.constants.delete('pairup');
      else game.db.constants.set('pairup', oldPairup);
      return strikes;
    });

    expect(result).toEqual([
      { attacker: '_ScriptLeaderA', assist: false, isCounter: false },
      { attacker: '_ScriptPartnerA', assist: true, isCounter: false },
      { attacker: '_ScriptLeaderD', assist: false, isCounter: true },
      { attacker: '_ScriptPartnerD', assist: true, isCounter: true },
    ]);
  });

  test('full-animation guard rewards include the carried follower and rewind', async ({ page }) => {
    await page.goto('/?harness=true&level=0&clean=true&bundle=false');
    await page.waitForFunction(() => !!(window as any).__harness?.ready, { timeout: 15000 });
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { AnimationCombat } = await import('/src/combat/animation-combat.ts');
      const { CombatResultAction } = await import('/src/combat/combat-result-action.ts');
      const leader = game.units.get('Eirika');
      const follower = game.units.get('Seth');
      const enemy = [...game.units.values()].find((unit: any) => unit.team === 'enemy');
      if (!leader || !follower || !enemy) return null;
      const oldExp = follower.exp;
      follower.exp = 0;
      const animation: any = Object.create(AnimationCombat.prototype);
      Object.assign(animation, {
        db: game.db,
        game,
        strikes: [{
          attacker: enemy,
          defender: leader,
          guarded: true,
        }],
      });
      const action = new CombatResultAction(
        [leader, follower],
        [],
        () => animation.grantGuardFollowerExp(leader, follower, 'fixed'),
      );
      const before = game.actionLog.actionIndex;
      game.actionLog.doAction(action);
      const changed = follower.exp;
      game.actionLog.runActionBackward();
      const reversed = follower.exp;
      game.actionLog.runActionForward();
      const redone = follower.exp;
      while (game.actionLog.actionIndex > before) game.actionLog.runActionBackward();
      follower.exp = oldExp;
      return { changed, reversed, redone };
    });

    expect(result).not.toBeNull();
    expect(result!.changed).toBe(10);
    expect(result!.reversed).toBe(0);
    expect(result!.redone).toBe(result!.changed);
  });
});
