import { expect, test, type Page } from '@playwright/test';

// EOtF fork query_engine / evaluator parity (temp/forkdiff-events.md rows
// 6, 7, 8, 10-15, 18, 20).

async function bootEotf(page: Page): Promise<void> {
  await page.goto('/?harness=true&project=eotf.ltproj&level=X&clean=true&bundle=false');
  await page.waitForFunction(() => (window as any).__harness?.ready === true, undefined, {
    timeout: 60_000,
  });
}

test.describe('EOtF fork event queries', () => {
  test('match the fork query engine for units, items, skills, and keywords', async ({ page }) => {
    await bootEotf(page);
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { evaluateExpression, evaluateCondition } = await import('/src/events/event-manager.ts');
      const { SkillObject } = await import('/src/objects/skill.ts');
      const { createItemTree } = await import('/src/objects/item.ts');
      const nids = ['Player', 'Keeper', 'Trace', 'Gacha', 'Greeter', 'Al', 'Arc'];
      const units = nids.map((nid) => game.units.get(nid));
      if (units.some((unit) => !unit)) throw new Error('missing EOtF fixture unit');
      const [player, ally, other, wall, enemy, enemy2, reserve] = units;
      for (const unit of units) {
        if (unit.position) game.board.removeUnit(unit);
        unit.position = null;
      }
      const place = (unit: any, team: string, position: [number, number] | null) => {
        unit.team = team;
        unit.dead = false;
        if (unit.currentHp <= 0) unit.currentHp = 1;
        unit.position = position;
        if (position) game.board.setUnit(position[0], position[1], unit);
      };
      place(player, 'player', [3, 9]);
      place(ally, 'player', [4, 9]);
      place(other, 'other', [3, 8]);
      place(wall, 'enemy', [2, 9]);
      wall.klass = 'Wall10'; // 'Tile' is a class tag in EOtF
      place(enemy, 'enemy', [5, 9]);
      place(enemy2, 'enemy2', [3, 11]);
      place(reserve, 'player', null);
      reserve.persistent = true;
      reserve.party = 'Shuffle';

      const failures: string[] = [];
      const originalWarn = console.warn;
      console.warn = (...args: any[]) => {
        const text = args.map(String).join(' ');
        if (text.includes('EventCondition JS eval failed')) failures.push(text);
        originalWarn(...args);
      };
      const ctx = (unit1?: any, unit2?: any) => ({
        game, unit1, unit2, gameVars: game.gameVars, levelVars: game.levelVars,
      });
      const cond = (expression: string, unit1?: any, unit2?: any) =>
        evaluateCondition(expression, ctx(unit1, unit2));
      const expr = (expression: string, unit1?: any, unit2?: any) =>
        evaluateExpression(expression, ctx(unit1, unit2));
      const nidsOf = (value: any) => Array.from(value ?? []).map((unit: any) => unit.nid).sort();

      // Row 6: has_skill(unit, skill), never (skill, unit).
      player.skills = [new SkillObject(game.db.skills.get('Allure'))];
      // Row 10/18: stacked charge instances, last truthy wins.
      const first = new SkillObject(game.db.skills.get('Allure'));
      first.data.set('charge', 2);
      first.data.set('total_charge', 5);
      const second = new SkillObject(game.db.skills.get('Allure'));
      second.data.set('charge', 3);
      second.data.set('total_charge', 6);
      const third = new SkillObject(game.db.skills.get('Allure'));
      third.data.set('charge', 0);
      third.data.set('total_charge', 0);
      ally.skills = [first, second, third];
      // Row 12: negative skills.
      enemy.skills = [
        new SkillObject(game.db.skills.get('Toxin')),
        new SkillObject(game.db.skills.get('Blinded')),
        new SkillObject(game.db.skills.get('Allure')),
      ];

      // Row 8: convoy / party / nid items.
      const ironPrefab = game.db.items.get('Iron_Sword');
      const epeePrefab = game.db.items.get('Epee');
      const convoyItem = createItemTree(ironPrefab, (nid: string) => game.db.items.get(nid));
      const shuffleConvoyItem = createItemTree(epeePrefab, (nid: string) => game.db.items.get(nid));
      for (const unit of units) unit.items = [];
      game.getParty(game.currentParty).convoy = [convoyItem];
      const shuffle = game.getParty('Shuffle');
      if (shuffle) shuffle.convoy = [shuffleConvoyItem];
      const zanbato = createItemTree(game.db.items.get('Zanbato'), (nid: string) => game.db.items.get(nid));
      reserve.items = [zanbato];
      zanbato.owner = reserve;

      game.levelVars.set('fork_v_probe', null);
      game.gameVars.set('fork_v_probe', 7);

      const out = {
        hasSkillQuoted: cond("has_skill('Player','Allure')"),
        hasSkillReversed: cond("has_skill('Allure','Player')"),
        hasSkillUnit: cond("has_skill(unit, 'Allure')", player),
        hasSkillAndPart: cond("has_skill('Player','Allure') and not has_skill('Keeper','Toxin')"),
        isDeadMissing: cond("is_dead('No_Such_Unit')"),
        checkDeadMissing: cond("game.check_dead('No_Such_Unit')"),
        checkAliveMissing: cond("check_alive('No_Such_Unit')"),
        notIsDeadMissing: cond("not is_dead('No_Such_Unit')"),
        isDeadMissingJs: expr("is_dead('No_Such_Unit')"),
        isDeadEquality: cond("is_dead('No_Such_Unit') == False"),
        convoyItem: cond("has_item('Iron_Sword', 'convoy')"),
        convoyItemNoNid: cond("has_item('Iron_Sword')"),
        convoyItemTeam: cond("has_item('Iron_Sword', team='player')"),
        convoyUid: cond(`has_item('${convoyItem.uid}', 'convoy')`),
        partyConvoy: cond("has_item('Epee', party='Shuffle')"),
        partyUnit: cond("has_item('Zanbato', party='Shuffle')"),
        partyMiss: cond("has_item('Zanbato', party='Nobody')"),
        nidKeyword: cond("has_item('Zanbato', nid='Arc')"),
        nidKeywordMiss: cond("has_item('Zanbato', nid='Player')"),
        positionalNidMiss: cond("has_item('Zanbato', 'Player')"),
        unitNidArg: cond("has_item('Zanbato', unit.nid)", reserve),
        charge: expr("get_charge(unit, 'Allure')", ally),
        totalCharge: expr("get_total_charge(unit, 'Allure')", ally),
        chargeCondition: cond(
          "has_skill(unit,'Allure') and get_charge(unit,'Allure') < get_total_charge(unit,'Allure')",
          ally,
        ),
        debuffs: expr('get_debuff_count(unit)', enemy),
        alliesWithin: nidsOf(expr('get_allies_within_distance(unit.position, 1)', player)),
        alliesWithinKw: nidsOf(expr('get_allies_within_distance(unit.position, dist=2)', player)),
        closestAllies: expr('[p[0].nid for p in get_closest_allies(unit.position, 5)]', player),
        unitsWithin: nidsOf(expr('get_units_within_distance(unit.position, 1)', player)),
        unitsWithinNid: nidsOf(expr("get_units_within_distance(unit.position, dist=2, nid='Greeter')", player)),
        unitsWithinTeamOnly: nidsOf(expr("get_units_within_distance(unit.position, team='enemy')", player)),
        unitsWithinMulti: nidsOf(expr("get_units_within_distance(unit.position, dist=3, team='player', tag='Female')", player)),
        closestUnits: expr('[p[0].nid for p in get_closest_units(unit.position, 3)]', player),
        inArea: nidsOf(expr('get_units_in_area([2, 8], [5, 9])')),
        allUnitsProxy: nidsOf(expr("[u for u in game.get_all_units() if u.nid in ['Player','Keeper','Trace','Gacha','Greeter','Al','Arc']]")),
        pivotOpen: expr('check_pivot(unit, target.position, 1)', other, player),
        pivotWall: expr('check_pivot(unit, target.position, 1)', ally, player),
        pivotBlocked: expr('check_pivot(unit, target.position, 1)', player, ally),
        notPivotBlocked: cond('not check_pivot(unit, target.position, 1)', player, ally),
        vFallthrough: expr("v('fork_v_probe')"),
        vFallthroughCondition: cond("v('fork_v_probe') == 7"),
        failures,
      };
      console.warn = originalWarn;
      return out;
    });

    expect(result.hasSkillQuoted).toBe(true);
    expect(result.hasSkillReversed).toBe(false);
    expect(result.hasSkillUnit).toBe(true);
    expect(result.hasSkillAndPart).toBe(true);
    expect(result.isDeadMissing).toBe(false);
    expect(result.checkDeadMissing).toBe(false);
    expect(result.checkAliveMissing).toBe(false);
    expect(result.notIsDeadMissing).toBe(true);
    expect(result.isDeadMissingJs).toBe(false);
    expect(result.isDeadEquality).toBe(true);
    expect(result.convoyItem).toBe(true);
    expect(result.convoyItemNoNid).toBe(false);
    expect(result.convoyItemTeam).toBe(true);
    expect(result.convoyUid).toBe(true);
    expect(result.partyConvoy).toBe(true);
    expect(result.partyUnit).toBe(true);
    expect(result.partyMiss).toBe(false);
    expect(result.nidKeyword).toBe(true);
    expect(result.nidKeywordMiss).toBe(false);
    expect(result.positionalNidMiss).toBe(false);
    expect(result.unitNidArg).toBe(true);
    expect(result.charge).toBe(3);
    expect(result.totalCharge).toBe(6);
    expect(result.chargeCondition).toBe(true);
    expect(result.debuffs).toBe(2);
    // Player team only: the 'other' unit at distance 1 is excluded.
    expect(result.alliesWithin).toEqual(['Keeper', 'Player']);
    expect(result.alliesWithinKw).toEqual(['Keeper', 'Player']);
    expect(result.closestAllies).toEqual(['Player', 'Keeper']);
    // The Wall10 unit (class tag 'Tile') is not a map-query unit.
    expect(result.unitsWithin).toEqual(['Keeper', 'Player', 'Trace']);
    expect(result.unitsWithinNid).toEqual(['Greeter']);
    // team= without dist keeps the default dist of 1.
    expect(result.unitsWithinTeamOnly).toEqual([]);
    expect(result.unitsWithinMulti).toEqual(['Player']);
    expect(result.closestUnits).toEqual(['Player', 'Keeper', 'Trace']);
    expect(result.inArea).toEqual(['Greeter', 'Keeper', 'Player', 'Trace']);
    expect(result.allUnitsProxy).toEqual(['Al', 'Greeter', 'Keeper', 'Player', 'Trace']);
    // Trace (3,8) pivots over Player (3,9) to the open (3,10); Keeper (4,9)
    // would land on the wall at (2,9); Player over Keeper lands on Greeter.
    expect(result.pivotOpen).toEqual([3, 10]);
    expect(result.pivotWall).toBe(false);
    expect(result.pivotBlocked).toBe(false);
    expect(result.notPivotBlocked).toBe(true);
    expect(result.vFallthrough).toBe(7);
    expect(result.vFallthroughCondition).toBe(true);
    expect(result.failures).toEqual([]);
  });
});
