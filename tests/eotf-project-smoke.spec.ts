import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

interface EotfLevel {
  nid: string;
  name: string;
}

const projectRoot = path.join(process.cwd(), 'lt-maker/eotf.ltproj');
const projectAvailable = fs.existsSync(path.join(projectRoot, 'game_data/levels.json'));
const levels = projectAvailable
  ? JSON.parse(fs.readFileSync(
      path.join(projectRoot, 'game_data/levels.json'),
      'utf8',
    )) as EotfLevel[]
  : [];
const settledStates = new Set(['free', 'free_roam', 'prep_main', 'base_main']);

function expectedAssetNoise(text: string): boolean {
  return /404|Failed to load resource|not found \S*\.(png|ogg|mp3|wav|idx)/i.test(text);
}

function compatibilityFailure(text: string): boolean {
  return /EventCondition(?: JS eval failed|: cannot evaluate)|unknown (?:state|command|component)|event UI component is not implemented|failed to load level|Unhandled|PAGEERROR/i.test(text);
}

async function waitForHarness(page: Page): Promise<void> {
  await page.waitForFunction(() => (window as any).__harness?.ready === true, {
    timeout: 30_000,
  });
}

async function initializeCampaignRecords(page: Page): Promise<void> {
  await page.goto('/?harness=true&project=eotf.ltproj&level=X&clean=true&bundle=false');
  await waitForHarness(page);
  await page.evaluate(async () => {
    const game = (window as any).__gameRef;
    const records = await import('/src/engine/records.ts');
    const { GameEvent } = await import('/src/events/event-manager.ts');
    records.RECORDS.clear();
    const prefab = [...game.db.events.values()]
      .find((event: any) => event.name === 'Records_Setup');
    if (!prefab) throw new Error('Missing EOtF Records_Setup event');
    game.eventManager.eventQueue.push(new GameEvent(prefab, {
      type: 'on_startup',
      levelNid: 'X',
    }, () => game));
    game.state.change('event');
  });
  await page.evaluate(
    (states) => (window as any).__harness.settle(2_000, states),
    [...settledStates],
  );
  const initialized = await page.evaluate(async () => {
    const { RECORDS } = await import('/src/engine/records.ts');
    return {
      availableUnits: RECORDS.get('Available_Units'),
      inheritance: RECORDS.get('skill_inheritance'),
      gameSpeed: RECORDS.get('Game_Speed'),
    };
  });
  expect(initialized).toEqual({
    availableUnits: ['Player'],
    inheritance: { Nothing: 'None', Patchwork: 'Player' },
    gameSpeed: 1,
  });
}

test.describe('Embrace of the Fog project compatibility', () => {
  test.skip(!projectAvailable, 'lt-maker/eotf.ltproj is not installed');

  test('authored startup records initialize campaign prerequisites', async ({ page }) => {
    await initializeCampaignRecords(page);
  });

  test('project picker discovers a linked EotF checkout with a friendly name', async ({ page }) => {
    await page.goto('/');
    await expect(
      page.getByRole('button', { name: 'Launch Embrace of the Fog' }),
    ).toBeVisible();
  });

  test('EotF expression scope exposes game units and item availability', async ({ page }) => {
    const failures: string[] = [];
    page.on('console', (message) => {
      const text = message.text();
      if (text.includes('EventCondition JS eval failed')) failures.push(text);
    });
    await page.goto('/?harness=true&project=eotf.ltproj&level=X&clean=true&bundle=false');
    await waitForHarness(page);

    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { evaluateCondition } = await import('/src/events/event-manager.ts');
      const unit = game.units.get('Player');
      const context = {
        game,
        unit1: unit,
        gameVars: game.gameVars,
        levelVars: game.levelVars,
      };
      return {
        keyblade: evaluateCondition(
          "item_system.available(unit, DB.items.get('Keyblade'))",
          context,
        ),
        pylon: evaluateCondition(
          "any([u.position for u in game.units if u.klass == 'Pylon' and not is_dead(u.nid)])",
          context,
        ),
      };
    });

    expect(result.keyblade).toEqual(expect.any(Boolean));
    expect(result.pylon).toEqual(expect.any(Boolean));
    expect(failures).toEqual([]);
  });

  test('EotF component markers and values retain Python expression shape', async ({ page }) => {
    const failures: string[] = [];
    page.on('console', (message) => {
      const text = message.text();
      if (text.includes('EventCondition JS eval failed')) failures.push(text);
    });
    await page.goto('/?harness=true&project=eotf.ltproj&level=X&clean=true&bundle=false');
    await waitForHarness(page);

    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const { SkillObject } = await import('/src/objects/skill.ts');
      const { evaluateExpression } = await import('/src/events/event-manager.ts');
      const unit = game.units.get('Player');
      const added = [
        'Shove',
        'Fire_Sovereign',
        'Graveyard_Bash',
        'Jealous_Patrons',
        'Beastform',
        'Gemini_Impact_Proc',
      ].map(
        (nid) => new SkillObject(game.db.skills.get(nid)),
      );
      unit.skills.push(...added);
      const context = {
        game,
        unit1: unit,
        gameVars: game.gameVars,
        levelVars: game.levelVars,
      };
      const values = {
        copySafe: evaluateExpression(
          "[s.nid for s in unit.skills if s.copysafe]",
          context,
        ),
        fireAffinity: evaluateExpression(
          "any([s.has_affinities and 'Fire' in s.has_affinities.value for s in unit.skills])",
          context,
        ),
        subskills: evaluateExpression(
          "get_skill(unit, 'Graveyard_Bash').subskills.value",
          context,
        ),
        shoveCost: evaluateExpression(
          "DB.skills.get('Shove').components.get('tether_parameters').value.get('cost')",
          context,
        ),
        contractSkills: evaluateExpression(
          "[s.nid for s in DB.skills if s.components.get('tether_parameters') and s.components.get('tether_parameters').value.get('level') == 99]",
          context,
        ),
        markerSkills: evaluateExpression(
          "[s.nid for s in unit.skills if s.shit or s.blue or s.combat_art_proc]",
          context,
        ),
      };
      unit.skills.splice(unit.skills.length - added.length, added.length);
      return values;
    });

    expect(result.copySafe).toEqual(expect.arrayContaining(['Shove', 'Fire_Sovereign']));
    expect(result.fireAffinity).toBe(true);
    expect(result.subskills).toEqual(['Graveyard_Bash_P', 'Graveyard_Bash_O']);
    expect(result.shoveCost).toBe(20);
    expect(result.contractSkills).toEqual(expect.arrayContaining([
      'Ice_Sovereign',
      'Water_Sovereign',
      'Wind_Sovereign',
      'Earth_Sovereign',
      'Anima_Sovereign',
    ]));
    expect(result.markerSkills).toEqual(expect.arrayContaining([
      'Jealous_Patrons',
      'Beastform',
      'Gemini_Impact_Proc',
    ]));
    expect(failures).toEqual([]);
  });

  test('EotF strict inventory accepts verified markers and rejects unknown NIDs', async ({ page }) => {
    await page.goto('/?harness=true&project=eotf.ltproj&level=X&clean=true&bundle=false');
    await waitForHarness(page);

    const result = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      const {
        EOTF_ITEM_COMPONENTS,
        EOTF_SKILL_COMPONENTS,
      } = await import('/src/engine/eotf-component-support.ts');
      const savedItems = [...game.db.items.values()].map((prefab: any) =>
        [prefab, prefab.components] as const);
      const savedSkills = [...game.db.skills.values()].map((prefab: any) =>
        [prefab, prefab.components] as const);
      for (const [prefab] of savedItems) {
        prefab.components = prefab.components.filter(([nid]: [string, any]) =>
          EOTF_ITEM_COMPONENTS.has(nid));
      }
      for (const [prefab] of savedSkills) {
        prefab.components = prefab.components.filter(([nid]: [string, any]) =>
          EOTF_SKILL_COMPONENTS.has(nid));
      }
      const originalUrl = location.href;
      history.replaceState(null, '', `${location.pathname}${location.search}&strict=true`);
      let verifiedError: string | null = null;
      let unknownError: string | null = null;
      try {
        try {
          (window as any).__logUnknownComponents();
        } catch (error) {
          verifiedError = String(error);
        }
        game.db.items.set('_EotfUnknownComponentProbe', {
          nid: '_EotfUnknownComponentProbe',
          components: [['definitely_not_an_eotf_component', null]],
        });
        try {
          (window as any).__logUnknownComponents();
        } catch (error) {
          unknownError = String(error);
        }
      } finally {
        game.db.items.delete('_EotfUnknownComponentProbe');
        for (const [prefab, components] of savedItems) prefab.components = components;
        for (const [prefab, components] of savedSkills) prefab.components = components;
        history.replaceState(null, '', originalUrl);
      }
      return { verifiedError, unknownError };
    });

    expect(result.verifiedError).toBeNull();
    expect(result.unknownError).toContain('definitely_not_an_eotf_component');
  });

  test('all levels clean boot without runtime failures', async ({ page }) => {
    test.setTimeout(12 * 60_000);
    const failures: string[] = [];
    let currentLevel = 'startup';
    page.on('pageerror', (error) => {
      failures.push(`${currentLevel}: PAGEERROR: ${error.message}`);
    });
    page.on('console', (message) => {
      const text = message.text();
      if (!expectedAssetNoise(text) && compatibilityFailure(text)) {
        failures.push(`${currentLevel}: ${message.type().toUpperCase()}: ${text}`);
      }
    });

    for (const level of levels) {
      currentLevel = level.nid;
      await page.goto(`/?harness=true&project=eotf.ltproj&level=${encodeURIComponent(level.nid)}&clean=true&bundle=false`);
      await waitForHarness(page);
      await page.evaluate(() => (window as any).__harness.stepFrames(3, null));
      const state = await page.evaluate(() => (window as any).__harness.getState());
      if (state.levelNid !== level.nid) {
        failures.push(`${level.nid}: loaded level ${String(state.levelNid)}`);
      }
      if (!settledStates.has(state.currentStateName)) {
        failures.push(`${level.nid}: clean boot ended in ${String(state.currentStateName)}`);
      }
    }

    expect(failures, failures.join('\n')).toEqual([]);
  });

  test.describe('all level-start event queues settle without compatibility failures', () => {
    test.describe.configure({ mode: 'parallel' });
    const shardCount = 4;
    for (let shard = 0; shard < shardCount; shard++) {
      test(`catalog shard ${shard + 1}/${shardCount}`, async ({ page }) => {
        test.setTimeout(15 * 60_000);
        const failures: string[] = [];
        const observedFailures = new Set<string>();
        let currentLevel = 'startup';
        page.on('pageerror', (error) => {
          failures.push(`${currentLevel}: PAGEERROR: ${error.message}`);
        });
        page.on('console', (message) => {
          const text = message.text();
          if (!expectedAssetNoise(text) && compatibilityFailure(text)) {
            const failure = `${currentLevel}: ${message.type().toUpperCase()}: ${text.split('\n', 1)[0]}`;
            if (!observedFailures.has(failure)) {
              observedFailures.add(failure);
              failures.push(failure);
            }
          }
        });

        await initializeCampaignRecords(page);
        for (const [index, level] of levels.entries()) {
          if (index % shardCount !== shard) continue;
          currentLevel = level.nid;
          await page.goto(`/?harness=true&project=eotf.ltproj&level=${encodeURIComponent(level.nid)}&clean=false&bundle=false`);
          await waitForHarness(page);
          await page.evaluate(
            (states) => (window as any).__harness.settle(300, states),
            [...settledStates],
          );
          const state = await page.evaluate(() => (window as any).__harness.getState());
          if (state.levelNid !== level.nid) {
            failures.push(`${level.nid}: loaded level ${String(state.levelNid)}`);
          }
          if (!settledStates.has(state.currentStateName)) {
            failures.push(
              `${level.nid}: level_start ended in ${String(state.currentStateName)} [${state.stateStack.join(', ')}]`,
            );
          }
        }

        expect(failures, failures.join('\n')).toEqual([]);
      });
    }
  });
});
