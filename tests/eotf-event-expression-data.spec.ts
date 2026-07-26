import { expect, test, type Page } from '@playwright/test';

async function bootEotf(page: Page): Promise<void> {
  await page.goto('/?harness=true&project=eotf.ltproj&level=X&clean=true&bundle=false');
  await page.waitForFunction(() => (window as any).__harness?.ready === true, undefined, {
    timeout: 30_000,
  });
}

test.describe('Embrace of the Fog event expression data', () => {
  test('hydrates Python raw data and live level units', async ({ page }) => {
    await bootEotf(page);
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { evaluateExpression } = await import('/src/events/event-manager.ts');
      const warnings: string[] = [];
      const originalWarn = console.warn;
      console.warn = (...args: any[]) => {
        const text = args.map(String).join(' ');
        if (text.includes('EventCondition JS eval failed')) warnings.push(text);
        originalWarn(...args);
      };
      const context = {
        game,
        gameVars: game.gameVars,
        levelVars: game.levelVars,
      };
      const authored = {
        getData: 0,
        sorted: 0,
        levelUnits: 0,
        missingRawData: [] as string[],
      };
      for (const event of game.db.events.values()) {
        for (const line of event._source ?? []) {
          if (line.includes('game.get_data(')) authored.getData++;
          if (line.includes('sorted(')) authored.sorted++;
          if (line.includes('game.level.units')) authored.levelUnits++;
          for (const match of line.matchAll(/game\.get_data\('([^']+)'\)/g)) {
            if (!game.db.rawData.has(match[1])) authored.missingRawData.push(match[1]);
          }
        }
      }
      const result = {
        rawDataCount: game.db.rawData.size,
        authored,
        enemyIrons: game.db.rawData.get('Enemy_Data').get('Irons'),
        typeLists: game.db.rawData.get('Type_Lists'),
        hubSongs: evaluateExpression(
          "game.get_data('Music_Data').get('hub_set').songs",
          context,
        ),
        defaultTonics: evaluateExpression(
          "[t.nid for t in game.get_data('Tonic_List') if t.type == 'Default']",
          context,
        ),
        levelUnitNids: evaluateExpression(
          '[u.nid for u in game.level.units]',
          context,
        ),
        warnings,
      };
      console.warn = originalWarn;
      return result;
    });

    expect(result.rawDataCount).toBe(17);
    expect(result.authored).toEqual({
      getData: 76,
      sorted: 19,
      levelUnits: 23,
      missingRawData: [],
    });
    expect(result.enemyIrons).toContain("'Iron_Sword'");
    expect(result.typeLists).toContain('Infantry');
    expect(result.hubSongs).toBe(
      "['Lounge_with_Talks_of_Tomorrow','Cityscape_Where_the_Light_Shines']",
    );
    expect(result.defaultTonics).toEqual([
      'Proficiency',
      'Agility',
      'Mending',
      'Wealth',
      'Luck',
      'Thievery',
      'Vigor',
      'Discovery',
    ]);
    expect(result.levelUnitNids).toContain('Player');
    expect(result.warnings).toEqual([]);
  });

  test('sorts real EotF lambda and tuple-key expressions stably', async ({ page }) => {
    await bootEotf(page);
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { evaluateExpression } = await import('/src/events/event-manager.ts');
      const candidates = [...game.db.units.values()]
        .filter((unit: any) => unit?.nid && unit?.name)
        .slice(0, 3)
        .map((unit: any) => unit.nid);
      game.levelVars.set('sort_players', candidates);
      game.levelVars.set('all_friends', candidates);
      const warnings: string[] = [];
      const originalWarn = console.warn;
      console.warn = (...args: any[]) => {
        const text = args.map(String).join(' ');
        if (text.includes('EventCondition JS eval failed')) warnings.push(text);
        originalWarn(...args);
      };
      const context = {
        game,
        gameVars: game.gameVars,
        levelVars: game.levelVars,
      };
      const byName = evaluateExpression(
        "sorted(game.level_vars.get('sort_players'), key=lambda u: DB.units.get(u).name)",
        context,
      );
      const tupleKey = evaluateExpression(
        "sorted(game.level_vars.get('all_friends'), key=lambda u: (DB.units.get(u).name not in ['Search'], DB.units.get(u).name))",
        context,
      );
      const highestLevel = evaluateExpression(
        'sorted([(unit, unit.level) for unit in game.level.units], key=lambda pair: pair[1], reverse=True)[0][0].nid',
        context,
      );
      const expected = [...candidates].sort((left, right) =>
        game.db.units.get(left).name.localeCompare(game.db.units.get(right).name));
      const expectedHighestLevel = [...game.units.values()]
        .sort((left: any, right: any) => right.level - left.level)[0].nid;
      game.levelVars.delete('sort_players');
      game.levelVars.delete('all_friends');
      console.warn = originalWarn;
      return {
        byName,
        tupleKey,
        expected,
        highestLevel,
        expectedHighestLevel,
        warnings,
      };
    });

    expect(result.warnings).toEqual([]);
    expect(result.byName).toEqual(result.expected);
    expect(result.tupleKey).toEqual(result.expected);
    expect(result.highestLevel).toBe(result.expectedHighestLevel);
  });
});
