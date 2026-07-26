import { expect, test, type Page } from '@playwright/test';

async function bootEotf(page: Page): Promise<void> {
  await page.goto('/?harness=true&project=eotf.ltproj&level=X&clean=true&bundle=false');
  await page.waitForFunction(() => (window as any).__harness?.ready === true, undefined, {
    timeout: 30_000,
  });
}

test.describe('Embrace of the Fog event unit queries', () => {
  test('matches Python field, party, team, and traveler filtering', async ({ page }) => {
    await bootEotf(page);
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { evaluateExpression } = await import('/src/events/event-manager.ts');
      const context = {
        game,
        gameVars: game.gameVars,
        levelVars: game.levelVars,
      };
      const chosenNids = ['Player', 'Keeper', 'Trace', 'Gacha', 'Greeter', 'Al', 'Arc'];
      const chosen = chosenNids.map((nid) => game.units.get(nid));
      if (chosen.some((unit) => !unit)) {
        throw new Error(`Missing EOtF fixture unit: ${chosenNids.filter((_, i) => !chosen[i]).join(', ')}`);
      }
      const [player, reserve, dead, transient, enemy2, other, tile] = chosen;
      const configure = (
        unit: any,
        team: string,
        position: [number, number] | null,
        party: string,
        persistent: boolean,
        isDead = false,
      ) => {
        unit.team = team;
        unit.position = position;
        unit.party = party;
        unit.persistent = persistent;
        unit.dead = isDead;
        if (!isDead && unit.currentHp <= 0) unit.currentHp = 1;
      };
      configure(player, 'player', [3, 9], 'Reserves', true);
      configure(reserve, 'player', null, 'Reserves', true);
      configure(dead, 'player', [4, 9], 'Reserves', true, true);
      configure(transient, 'player', null, 'Reserves', false);
      configure(enemy2, 'enemy2', [5, 9], '', true);
      configure(other, 'other', [6, 9], '', true);
      configure(tile, 'enemy', [7, 9], '', true);
      tile.tags = [...new Set([...(tile.tags ?? []), 'Tile'])];
      player.traveler = reserve.nid;
      player.rescuing = reserve;
      reserve.rescuedBy = player;
      game.currentParty = 'Reserves';
      const party = game.getParty('Reserves');
      party.partyPrepManageSortOrder = [reserve.nid, player.nid, dead.nid];

      const warnings: string[] = [];
      const originalWarn = console.warn;
      console.warn = (...args: any[]) => {
        const text = args.map(String).join(' ');
        if (text.includes('EventCondition JS eval failed')) warnings.push(text);
        originalWarn(...args);
      };
      const evaluateNids = (expression: string) =>
        evaluateExpression(expression, context);
      const expressions = {
        livingParty: evaluateNids(
          "[u.nid for u in game.get_units_in_party() if u.nid in ['Player','Keeper','Trace','Gacha']]",
        ),
        allParty: evaluateNids(
          "[u.nid for u in game.get_all_units_in_party('Reserves') if u.nid in ['Player','Keeper','Trace','Gacha']]",
        ),
        fieldPlayers: evaluateNids(
          "[u.nid for u in game.get_player_units() if u.nid in ['Player','Keeper','Trace','Gacha']]",
        ),
        allPlayers: evaluateNids(
          "[u.nid for u in game.get_player_units(False) if u.nid in ['Player','Keeper','Trace','Gacha']]",
        ),
        enemies: evaluateNids(
          "[u.nid for u in game.get_enemy_units() if u.nid in ['Greeter','Al','Arc']]",
        ),
        others: evaluateNids(
          "[u.nid for u in game.get_other_units() if u.nid in ['Greeter','Al','Arc']]",
        ),
        allField: evaluateNids(
          "[u.nid for u in game.get_all_units() if u.nid in ['Player','Keeper','Trace','Gacha','Greeter','Al','Arc']]",
        ),
        allRegistered: evaluateNids(
          "[u.nid for u in game.get_all_units(False) if u.nid in ['Player','Keeper','Trace','Gacha','Greeter','Al','Arc']]",
        ),
        travelers: evaluateNids('[u.nid for u in game.get_travelers()]'),
        playerAndTravelers: evaluateNids(
          "[u.nid for u in game.get_player_units_and_travelers() if u.nid in ['Player','Keeper']]",
        ),
        partyNid: evaluateExpression("game.get_party('Reserves').nid", context),
        prepOrder: evaluateExpression(
          "game.get_party('Reserves').party_prep_manage_sort_order",
          context,
        ),
        missingDead: evaluateExpression("game.check_dead('__missing__')", context),
        missingAlive: evaluateExpression("game.check_alive('__missing__')", context),
      };

      const authored = {
        unitsInParty: 0,
        allUnitsInParty: 0,
        playerUnits: 0,
        enemyUnits: 0,
        teamUnits: 0,
      };
      for (const event of game.db.events.values()) {
        for (const line of event._source ?? []) {
          authored.unitsInParty += [...line.matchAll(/game\.get_units_in_party\(/g)].length;
          authored.allUnitsInParty += [...line.matchAll(/game\.get_all_units_in_party\(/g)].length;
          authored.playerUnits += [...line.matchAll(/game\.get_player_units\(/g)].length;
          authored.enemyUnits += [...line.matchAll(/game\.get_enemy_units\(/g)].length;
          authored.teamUnits += [...line.matchAll(/game\.get_team_units\(/g)].length;
        }
      }
      console.warn = originalWarn;
      return { authored, expressions, warnings };
    });

    expect(result.authored).toEqual({
      unitsInParty: 521,
      allUnitsInParty: 153,
      playerUnits: 195,
      enemyUnits: 141,
      teamUnits: 9,
    });
    expect(result.expressions).toEqual({
      livingParty: ['Keeper', 'Player'],
      allParty: ['Player', 'Keeper', 'Trace'],
      fieldPlayers: ['Player'],
      allPlayers: ['Player', 'Keeper', 'Trace', 'Gacha'],
      enemies: ['Greeter'],
      others: ['Al'],
      allField: ['Player', 'Greeter', 'Al'],
      allRegistered: ['Player', 'Keeper', 'Trace', 'Gacha', 'Greeter', 'Al', 'Arc'],
      travelers: ['Keeper'],
      playerAndTravelers: ['Player', 'Keeper'],
      partyNid: 'Reserves',
      prepOrder: ['Keeper', 'Player', 'Trace'],
      missingDead: false,
      missingAlive: false,
    });
    expect(result.warnings).toEqual([]);
  });

  test('round-trips party preparation order with legacy-save fallback', async ({ page }) => {
    await bootEotf(page);
    const snapshot = await page.evaluate(() => {
      const game = (window as any).__gameRef;
      game.getParty('Reserves').partyPrepManageSortOrder = ['Keeper', 'Player'];
      return (window as any).__harness.saveSnapshot();
    });
    const savedParty = snapshot.parties.find((party: any) => party.nid === 'Reserves');
    expect(savedParty.partyPrepManageSortOrder).toEqual(['Keeper', 'Player']);

    await page.evaluate(() => {
      (window as any).__gameRef.getParty('Reserves').partyPrepManageSortOrder = [];
    });
    expect(await page.evaluate(
      (saved) => (window as any).__harness.loadSnapshot(saved),
      snapshot,
    )).toBe(true);
    expect(await page.evaluate(
      () => (window as any).__gameRef.getParty('Reserves').partyPrepManageSortOrder,
    )).toEqual(['Keeper', 'Player']);

    const legacy = structuredClone(snapshot);
    for (const party of legacy.parties) delete party.partyPrepManageSortOrder;
    expect(await page.evaluate(
      (saved) => (window as any).__harness.loadSnapshot(saved),
      legacy,
    )).toBe(true);
    expect(await page.evaluate(
      () => (window as any).__gameRef.getParty('Reserves').partyPrepManageSortOrder,
    )).toEqual([]);
  });
});
