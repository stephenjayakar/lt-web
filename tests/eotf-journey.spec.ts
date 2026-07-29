/**
 * eotf-journey.spec.ts — one continuous play-through of Embrace of the Fog.
 *
 * The rest of the EotF suite checks systems in isolation, with helpers that
 * queue setup events by hand and fixtures that stand in for authored data.
 * That let a fully green suite coexist with a hub where the player could not
 * move, talk to anyone, use a service, or deploy — each piece worked, but
 * nothing walked the seams between them.
 *
 * This test walks those seams in order, using the authored project at every
 * step: boot the game, let its own `on_startup` event build the persistent
 * records, roam the hub, talk to an NPC, deploy through a party change, and
 * fight a real battle to a resolved outcome.
 *
 * One boundary is deliberate: after proving the authored sortie selector and
 * deployment picker, the combat phase loads the deterministic authored EX_2
 * map. Roaming, party selection, preparations, tactical movement, phase
 * changes, AI, and combat are all driven through normal engine input.
 */

import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

const projectRoot = path.join(process.cwd(), 'lt-maker/eotf.ltproj');
const projectAvailable = fs.existsSync(path.join(projectRoot, 'game_data/levels.json'));

async function waitForHarness(page: Page): Promise<void> {
  await page.waitForFunction(() => (window as any).__harness?.ready === true, undefined, {
    timeout: 60_000,
  });
}

async function stepFrames(page: Page, count: number, input?: string | null): Promise<void> {
  await page.evaluate(
    ({ count, input }) => (window as any).__harness.stepFrames(count, input ?? null),
    { count, input: input ?? null },
  );
}

async function settle(page: Page, frames: number, states: string[]): Promise<void> {
  await page.evaluate(
    ({ frames, states }) => (window as any).__harness.settle(frames, states),
    { frames, states },
  );
}

async function stateName(page: Page): Promise<string> {
  return page.evaluate(() => (window as any).__harness.getState().currentStateName);
}

/** Put the roam unit on a tile and keep its sub-tile position in step. */
async function placeRoamUnit(page: Page, x: number, y: number): Promise<void> {
  await page.evaluate(({ x, y }) => {
    const game = (window as any).__gameRef;
    const roam = game.state.stack.find((state: any) => state.name === 'free_roam');
    if (!roam?.movementComponent) throw new Error('free_roam has no movement component');
    const unit = game.getUnit(game.roamInfo.roamUnitNid);
    game.board.removeUnit(unit);
    unit.position = [x, y];
    game.board.setUnit(x, y, unit);
    // The talk range check reads the sub-tile position, not the grid tile.
    roam.movementComponent.roamPosition = { x, y };
  }, { x, y });
}

test.describe('Embrace of the Fog end-to-end journey', () => {
  test.skip(!projectAvailable, 'lt-maker/eotf.ltproj is not installed');

  test('boots, initialises records, roams, talks, deploys, and fights', async ({ page }) => {
    // A full play-through: several authored events, two level loads, and a
    // combat resolution.
    test.slow();

    const compatibilityFailures: string[] = [];
    page.on('console', (message) => {
      const text = message.text();
      if (/unknown (?:state|command|component)|event UI component is not implemented|failed to load level|PAGEERROR/i
        .test(text)) {
        compatibilityFailures.push(text);
      }
    });

    // ---- 1. Boot ---------------------------------------------------------
    // clean=false so the project's own events run. The engine must fire
    // `on_startup` for EotF to have any persistent state at all.
    await page.goto('/?harness=true&project=eotf.ltproj&level=X&clean=false&bundle=false');
    await waitForHarness(page);
    await settle(page, 12_000, ['free_roam']);

    const records = await page.evaluate(async () => {
      const module = await import('/src/engine/records.ts');
      return {
        progress: module.RECORDS.get('Progress'),
        availableUnits: module.RECORDS.get('Available_Units'),
        gameSpeed: module.RECORDS.get('Game_Speed'),
      };
    });
    expect(records.progress, 'on_startup must create Progress').toBe(0);
    expect(records.availableUnits).toEqual(['Player']);
    expect(records.gameSpeed).toBe(1);
    expect(await stateName(page)).toBe('free_roam');

    // ---- 2. Roam the hub -------------------------------------------------
    // A held direction has to actually walk the unit; this is engine input,
    // physics, and terrain cost together.
    const walked = await page.evaluate(() => {
      const game = (window as any).__gameRef;
      const unit = game.getUnit(game.roamInfo.roamUnitNid);
      const start = [...unit.position];
      game.input.keysDown.add('KeyS'); // south is open from the start tile
      for (let frame = 0; frame < 90; frame += 1) (window as any).__harness.stepFrames(1, null);
      game.input.keysDown.delete('KeyS');
      return { start, end: [...unit.position] };
    });
    expect(walked.end, 'a held key must move the roam unit').not.toEqual(walked.start);

    // ---- 3. Talk to an NPC ----------------------------------------------
    // Keeper is the hub's opening conversation. It is level-scoped, needs a
    // registered talk pair, and ends by advancing Progress — so reaching the
    // far side of it exercises trigger matching, talk range, and the record
    // write that gates the rest of the game.
    const keeper = await page.evaluate(() =>
      (window as any).__gameRef.getUnit('Keeper')?.position ?? null);
    expect(keeper, 'Keeper should be on the hub map').not.toBeNull();
    await placeRoamUnit(page, keeper![0] - 1, keeper![1]);
    await stepFrames(page, 3, 'SELECT');
    await stepFrames(page, 5);
    expect(await stateName(page), 'SELECT beside Keeper must start the talk').toBe('event');

    // Press through the conversation until it hands control back.
    for (let attempt = 0; attempt < 120; attempt += 1) {
      if (await stateName(page) === 'free_roam') break;
      await stepFrames(page, 8, 'SELECT');
    }
    expect(await stateName(page), 'the talk must end and return to roaming').toBe('free_roam');

    const progressAfterTalk = await page.evaluate(async () => {
      const module = await import('/src/engine/records.ts');
      return module.RECORDS.get('Progress');
    });
    expect(progressAfterTalk, 'the talk must advance Progress').toBeGreaterThan(0);

    // ---- 4. Pick a sortie and deploy ------------------------------------
    // Run the authored scenario selector and its EventNid-backed unit picker.
    // This is the seam that previously lost the parent choice's local tables,
    // replayed with a stale command pointer, and left selected units in the
    // Reserves party.
    await page.evaluate(() => {
      const game = (window as any).__gameRef;
      game.eventManager.triggerSpecific(
        'X 8. Run_Start',
        { type: 'journey_sortie', levelNid: 'X' },
        true,
      );
      game.state.change('event');
    });
    const sortie = await page.evaluate(async () => {
      const game = (window as any).__gameRef;
      let lastChoice = '';
      const picked: string[] = [];
      for (let frame = 0; frame < 25_000; frame += 1) {
        const state = game.state.getCurrentState();
        if (game.currentLevel?.nid !== 'X' &&
            ['free', 'free_roam', 'prep_main'].includes(state?.name)) {
          return {
            level: game.currentLevel.nid,
            party: game.getUnit('Player')?.party,
            selected: picked,
          };
        }
        const choice = state?.choiceMenu;
        if (choice) {
          const values = choice.options.map((option: any) => option.value);
          const signature = `${state.choiceNid}:${values.join('|')}`;
          if (signature !== lastChoice) {
            let target: string | undefined;
            if (state.choiceNid === 'New_Party') {
              target = values.find((value: string) =>
                value !== 'Filter' && value !== 'Search');
              if (target) picked.push(target);
            } else if (state.choiceNid === 'deploy') {
              target = values.find((value: string) => value === 'Yes');
            }
            if (!target) throw new Error(
              `Unexpected sortie choice ${state.choiceNid}: ${values.join(', ')}`,
            );
            choice.selectedIndex = values.indexOf(target);
            (window as any).__harness.injectInput('SELECT');
            lastChoice = signature;
          }
        } else {
          lastChoice = '';
          if (state?.dialog || state?.banner) {
            (window as any).__harness.injectInput('SELECT');
          }
        }
        (window as any).__harness.stepFrames(1);
        if (frame % 20 === 0) await new Promise(resolve => setTimeout(resolve, 0));
      }
      throw new Error('Authored sortie did not reach a battle');
    });
    expect(sortie.level, 'the authored scenario selection must leave the hub').not.toBe('X');
    expect(sortie.party, 'the selected unit must move to the deploying party').toBe('Player');
    expect(sortie.selected, 'the authored picker must publish its selection').toContain('Player');

    // ---- 5. Fight --------------------------------------------------------
    // EX_2 is an authored one-on-one map, so tactical input and the resulting
    // enemy phase are deterministic.
    await page.evaluate(() => {
      (window as any).__gameRef.roamInfo.roam = false;
      (window as any).__gameRef.state.clear();
      (window as any).__gameRef.state.change('free');
      (window as any).__harness.stepFrames(2);
      return (window as any).__harness.loadLevel('EX_2');
    });
    await settle(page, 15_000, ['prep_main']);

    // An authored battle opens in preparations; walk its menu down to Fight
    // the way a player would, rather than forcing the state.
    if (await stateName(page) === 'prep_main') {
      const prep = await page.evaluate(() => {
        const game = (window as any).__gameRef;
        const state: any = game.state.getCurrentState();
        return {
          options: state?.options ?? [],
          cursor: state?.cursor ?? 0,
        };
      });
      const fightIndex = prep.options.indexOf('Fight');
      expect(fightIndex, 'preparations should offer Fight').toBeGreaterThanOrEqual(0);
      for (let i = prep.cursor; i < fightIndex; i += 1) {
        await stepFrames(page, 3, 'DOWN');
      }
      await stepFrames(page, 3, 'SELECT');
      await settle(page, 10_000, ['free']);
    }
    const battleStart = await page.evaluate(() => {
      const game = (window as any).__gameRef;
      return {
        current: game.state.getCurrentState()?.name,
        stack: game.state.stack.map((state: any) => state.name),
        level: game.currentLevel?.nid,
      };
    });
    expect(
      battleStart.current,
      `Fight must start the battle: ${JSON.stringify(battleStart)}`,
    ).toBe('free');

    const combatants = await page.evaluate(() => {
      const game = (window as any).__gameRef;
      const player = game.getUnit('Yusha');
      const enemy = game.getUnit('Dragon');
      const moveTarget = game.pathSystem.getValidMoves(player, game.board)
        .sort((left: [number, number], right: [number, number]) => {
          const leftDistance =
            Math.abs(left[0] - enemy.position[0]) + Math.abs(left[1] - enemy.position[1]);
          const rightDistance =
            Math.abs(right[0] - enemy.position[0]) + Math.abs(right[1] - enemy.position[1]);
          return leftDistance - rightDistance;
        })[0];
      return {
        enemyNid: enemy.nid,
        enemyHp: enemy.currentHp,
        playerHp: player.currentHp,
        playerPos: [...player.position],
        moveTarget,
      };
    });

    const moveCursorTo = async ([targetX, targetY]: [number, number]): Promise<void> => {
      for (let guard = 0; guard < 60; guard += 1) {
        const [cursorX, cursorY] = await page.evaluate(() =>
          (window as any).__harness.getState().cursorPos);
        if (cursorX === targetX && cursorY === targetY) return;
        if (cursorX !== targetX) {
          await stepFrames(page, 4, cursorX < targetX ? 'RIGHT' : 'LEFT');
        } else {
          await stepFrames(page, 4, cursorY < targetY ? 'DOWN' : 'UP');
        }
      }
      throw new Error(`Cursor did not reach ${targetX},${targetY}`);
    };

    // Move the unit as close to the dragon as its authored movement permits.
    // Ending the turn there lets the enemy AI initiate the exchange.
    await moveCursorTo(combatants.playerPos as [number, number]);
    await stepFrames(page, 3, 'SELECT');
    await stepFrames(page, 8);
    await moveCursorTo(combatants.moveTarget as [number, number]);
    await stepFrames(page, 3, 'SELECT');
    await settle(page, 5_000, ['menu']);
    await stepFrames(page, 2);
    expect(await stateName(page), 'confirming the move must open the action menu').toBe('menu');

    const actionMenu = await page.evaluate(() => {
      const state: any = (window as any).__gameRef.state.getCurrentState();
      return {
        labels: state?.menu?.options?.map((option: any) => option.label) ?? [],
        cursor: state?.menu?.cursor ?? 0,
      };
    });
    const waitIndex = actionMenu.labels.indexOf('Wait');
    expect(waitIndex, `action menu must offer Wait: ${actionMenu.labels.join(', ')}`)
      .toBeGreaterThanOrEqual(0);
    for (let i = actionMenu.cursor; i < waitIndex; i += 1) {
      await stepFrames(page, 3, 'DOWN');
    }
    await stepFrames(page, 3, 'SELECT');

    // The only remaining unit is the enemy. Its authored AI must close the
    // final tile, choose an attack, and resolve combat without a harness warp.
    for (let frame = 0; frame < 6_000; frame += 1) {
      const changed = await page.evaluate(({ enemyHp, playerHp }) => {
        const game = (window as any).__gameRef;
        return game.getUnit('Dragon')?.currentHp !== enemyHp ||
          game.getUnit('Yusha')?.currentHp !== playerHp;
      }, combatants);
      if (changed) break;
      await stepFrames(page, 1);
    }

    const outcome = await page.evaluate((enemyNid: string) => {
      const game = (window as any).__gameRef;
      const enemy = game.getUnit(enemyNid);
      const player = game.getUnit('Yusha');
      return {
        enemyHp: enemy?.currentHp ?? null,
        playerHp: player?.currentHp ?? null,
        enemyDead: !!enemy?.isDead?.(),
        playerDead: !!player?.isDead?.(),
      };
    }, combatants.enemyNid);

    const enemyTookDamage = outcome.enemyDead ||
      (outcome.enemyHp !== null && outcome.enemyHp < combatants.enemyHp);
    const playerTookDamage = outcome.playerDead ||
      (outcome.playerHp !== null && outcome.playerHp < combatants.playerHp);
    expect(
      enemyTookDamage || playerTookDamage,
      `AI combat must change HP (enemy ${combatants.enemyHp}->${outcome.enemyHp}, ` +
      `player ${combatants.playerHp}->${outcome.playerHp})`,
    ).toBe(true);
    expect(compatibilityFailures, compatibilityFailures.join('\n')).toEqual([]);
  });
});
