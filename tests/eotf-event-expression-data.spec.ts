import { expect, test, type Page } from '@playwright/test';

async function bootEotf(page: Page, level = 'X'): Promise<void> {
  await page.goto(`/?harness=true&project=eotf.ltproj&level=${level}&clean=true&bundle=false`);
  await page.waitForFunction(() => (window as any).__harness?.ready === true, undefined, {
    timeout: 60_000,
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
        enemyTeamPresent: evaluateExpression(
          "any([u.team in ['enemy','enemy2'] for u in game.level.units])",
          context,
        ),
        expectedEnemyTeamPresent: [...game.units.values()]
          .some((unit: any) => ['enemy', 'enemy2'].includes(unit.team)),
        noneLiteral: evaluateExpression(
          "{'Nothing':'None','actual':None}",
          context,
        ),
        listAddition: evaluateExpression(
          "['Agility'] + ['Mending']",
          context,
        ),
        actOneMaps: evaluateExpression(
          "[lvl.nid for lvl in DB.levels if 'Act1_Map' in lvl.tags]",
          context,
        ),
        objectiveSimple: evaluateExpression(
          "game.level.objective.get('simple')",
          context,
        ),
        expectedObjectiveSimple: game.currentLevel.objective.simple,
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
    expect(result.enemyTeamPresent).toBe(result.expectedEnemyTeamPresent);
    expect(result.noneLiteral).toEqual({ Nothing: 'None', actual: null });
    expect(result.listAddition).toEqual(['Agility', 'Mending']);
    expect(result.actOneMaps.length).toBeGreaterThan(0);
    expect(result.objectiveSimple).toBe(result.expectedObjectiveSimple);
    expect(result.warnings).toEqual([]);
  });

  test('applies raw-data music choices to reversible EOtF phase slots', async ({ page }) => {
    await bootEotf(page);
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { GameEvent } = await import('/src/events/event-manager.ts');
      game.audioManager.clearCalls();
      const oldEnemyPhase = game.currentLevel.music.enemy_phase;
      const prefab = {
        nid: '_EotfMusicLiteral',
        name: 'EotF Music Literal',
        trigger: 'test',
        level_nid: 'X',
        condition: '',
        only_once: false,
        priority: 0,
        _source: [
          "lvar;battle_songs;['Lounge_with_Talks_of_Tomorrow','Cityscape_Where_the_Light_Shines']",
          'lvar;song_choice;game.get_random_choice({v:battle_songs})',
          "change_music;player_phase;{e:v('song_choice')}",
          "change_music;enemy_phase;{e:v('song_choice')}",
          "music;{e:v('song_choice')}",
        ],
      };
      game.db.events.set(prefab.nid, prefab);
      game.eventManager.eventQueue.push(new GameEvent(
        prefab,
        { type: 'test', levelNid: 'X' },
        () => game,
      ));
      game.state.change('event');
      for (let frame = 0; frame < 60; frame += 1) {
        await (window as any).__harness.stepFrames(1);
      }

      const chosen = game.currentLevel.music.player_phase;
      const calls = [...game.audioManager.calls];
      const undone = game.actionLog.undo();
      return {
        chosen,
        enemyPhase: game.currentLevel.music.enemy_phase,
        oldEnemyPhase,
        undoneAction: undone?.constructor.name,
        directPlayNids: calls
          .filter((call: any) => call.op === 'play')
          .map((call: any) => call.nid),
      };
    });

    expect([
      'Lounge_with_Talks_of_Tomorrow',
      'Cityscape_Where_the_Light_Shines',
    ]).toContain(result.chosen);
    expect(result.directPlayNids).toEqual([result.chosen]);
    expect(result.undoneAction).toBe('ChangePhaseMusicAction');
    expect(result.enemyPhase).toBe(result.oldEnemyPhase);
  });

  test('keeps authored EOtF phase music active through enemy-initiated combat', async ({ page }) => {
    await bootEotf(page, 'EX_2');
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { GameEvent } = await import('/src/events/event-manager.ts');
      game.gameVars.set('battle_songs', ['For_the_Dawn']);
      game.gameVars.set('played_tracks_battle', []);
      const prefab = [...game.db.events.values()]
        .find((event: any) => event.name === 'Music_Battle_Start');
      game.eventManager.eventQueue.push(new GameEvent(
        prefab,
        { type: 'script', levelNid: 'EX_2' },
        () => game,
      ));
      game.state.change('event');
      await (window as any).__harness.settle(3_000, ['free']);

      game.audioManager.init();
      await game.audioManager.playMusic(game.currentLevel.music.player_phase, 0);
      const attacker = game.getUnit('Dragon');
      const defender = game.getUnit('Yusha');
      game.selectedUnit = attacker;
      game.combatTarget = defender;
      game.combatScript = ['hit1'];
      game.memory.set('combat_item', attacker.items[0]);
      game.audioManager.clearCalls();
      game.state.change('combat');
      await (window as any).__harness.stepFrames(2);
      await new Promise((resolve) => setTimeout(resolve, 250));
      return {
        state: game.state.getCurrentState()?.name,
        phaseTrack: game.currentLevel.music.player_phase,
        currentTrack: game.audioManager.getCurrentMusicNid(),
        combatMusicCalls: [...game.audioManager.calls],
      };
    });

    expect(result.state).toBe('combat');
    expect(result.phaseTrack).toBe('For_the_Dawn');
    expect(result.currentTrack).toBe('For_the_Dawn');
    expect(result.combatMusicCalls).toEqual([]);
  });

  test('generates visible gray frames for finished EOtF units', async ({ page }) => {
    await bootEotf(page);
    const result = await page.evaluate(() => {
      const game = (window as any).__gameRef;
      const sprite = game.getUnit('Player')?.sprite;
      sprite.state = 'standing';
      const standing = sprite.getCurrentFrame().getImageData().data;
      sprite.state = 'gray';
      const gray = sprite.getCurrentFrame().getImageData().data;
      const opaquePixels = (data: Uint8ClampedArray) => {
        let count = 0;
        for (let index = 3; index < data.length; index += 4) {
          if (data[index] > 0) count += 1;
        }
        return count;
      };
      return {
        standingOpaque: opaquePixels(standing),
        grayOpaque: opaquePixels(gray),
      };
    });

    expect(result.standingOpaque).toBeGreaterThan(0);
    expect(result.grayOpaque).toBe(result.standingOpaque);
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

  test('evaluates authored persistent-record values with fallbacks reversibly', async ({ page }) => {
    const warnings: string[] = [];
    page.on('console', (message) => {
      const text = message.text();
      if (/EventCondition JS eval failed|record error/i.test(text)) warnings.push(text);
    });
    await bootEotf(page);
    const authoredCounts = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { RECORDS } = await import('/src/engine/records.ts');
      RECORDS.clear();
      RECORDS.create('Available_Units', ['Player']);
      RECORDS.create('Counter', 4);
      RECORDS.create('skill_inheritance', { Nothing: 'None' });
      game.actionLog.clear();
      const counts = { create: 0, update: 0, replace: 0 };
      for (const event of game.db.events.values()) {
        for (const line of event._source ?? []) {
          const command = line.trim().split(';', 1)[0];
          if (command === 'create_record') counts.create++;
          if (command === 'update_record') counts.update++;
          if (command === 'replace_record') counts.replace++;
        }
      }
      const nid = 'TestEotfRecordExpressions';
      game.db.events.set(nid, {
        name: nid,
        nid,
        trigger: nid,
        level_nid: game.currentLevel?.nid ?? null,
        condition: 'True',
        only_once: false,
        priority: 0,
        _source: [
          "create_record;Created;{'status':'Discovered'}",
          "update_record;Available_Units;RECORDS.get('Available_Units') + ['Kaku']",
          "update_record;Counter;RECORDS.get('Counter') + 2",
          "update_record;skill_inheritance;RECORDS.get('skill_inheritance').update({'Patchwork':'Player'})",
          "replace_record;Tether;(5 * (RECORDS.get('MissingLevel', 0) + 1))",
        ],
      });
      game.eventManager.triggerSpecific(nid, { type: nid }, true);
      game.state.change('event');
      return counts;
    });
    await page.evaluate(() => (window as any).__harness.stepFrames(40, null));
    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { RECORDS } = await import('/src/engine/records.ts');
      const snapshot = () => ({
        created: RECORDS.get('Created'),
        units: RECORDS.get('Available_Units'),
        counter: RECORDS.get('Counter'),
        inheritance: RECORDS.get('skill_inheritance'),
        tether: RECORDS.get('Tether'),
      });
      const changed = structuredClone(snapshot());
      const actions = Array.from({ length: 5 }, () => game.actionLog.undo());
      const undone = structuredClone(snapshot());
      for (const action of [...actions].reverse()) action?.execute();
      return {
        changed,
        undone,
        redone: structuredClone(snapshot()),
        actionNames: actions.map((action: any) => action?.constructor?.name ?? null),
      };
    });

    expect(authoredCounts).toEqual({ create: 249, update: 208, replace: 1 });
    expect(result.changed).toEqual({
      created: { status: 'Discovered' },
      units: ['Player', 'Kaku'],
      counter: 6,
      inheritance: { Nothing: 'None', Patchwork: 'Player' },
      tether: 5,
    });
    expect(result.undone).toEqual({
      created: null,
      units: ['Player'],
      counter: 4,
      inheritance: { Nothing: 'None' },
      tether: null,
    });
    expect(result.redone).toEqual(result.changed);
    expect(result.actionNames).toEqual(Array(5).fill('UpdatePersistentStoreAction'));
    expect(warnings).toEqual([]);
  });
});
