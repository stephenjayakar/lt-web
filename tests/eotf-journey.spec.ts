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
 * Where it takes a shortcut it says so. Two are deliberate: the sortie menu is
 * driven by changing party directly rather than navigating its unit picker,
 * and the battle phase warps the player next to the enemy instead of spending
 * turns closing the distance. Both stand in for player input, not for engine
 * behaviour — every state transition, event, and combat calculation below runs
 * through the real engine.
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

    // ---- 4. Deploy -------------------------------------------------------
    // The hub runs on the Reserves party and the acts run on Player, so the
    // sortie's job is to move the chosen units across. Standing in for the
    // unit picker here; win_game is the real transition the sortie performs.
    await page.evaluate(() => {
      const game = (window as any).__gameRef;
      game.db.events.set('_journey_depart', {
        name: '_journey_depart', nid: '_journey_depart', trigger: '_journey_depart',
        level_nid: 'X', condition: 'True', only_once: false, priority: 0,
        _source: ['change_party;Player;Player', 'win_game'],
      });
      game.eventManager.triggerSpecific(
        '_journey_depart', { type: '_journey_depart', levelNid: 'X' }, true,
      );
      game.state.change('event');
    });
    await settle(page, 25_000, ['free', 'free_roam', 'prep_main']);

    const deployed = await page.evaluate(() => {
      const game = (window as any).__gameRef;
      const onBoard = [...game.units.values()].filter((unit: any) => unit.position);
      return {
        level: game.currentLevel?.nid,
        players: onBoard.filter((unit: any) => unit.team === 'player').map((unit: any) => unit.nid),
      };
    });
    expect(deployed.level, 'departing must leave the hub').not.toBe('X');
    expect(deployed.players, 'the deploying party must be placed on the new map').toContain('Player');

    // ---- 5. Fight --------------------------------------------------------
    // EX_2 is an authored one-on-one map, so the outcome is easy to read.
    // Warping closes the distance the player would otherwise walk; the attack
    // itself goes through the real cursor, action menu, and targeting states.
    await page.evaluate(() => (window as any).__harness.loadLevel('EX_2'));
    await settle(page, 15_000, ['free', 'prep_main']);

    // An authored battle opens in preparations; walk its menu down to Fight
    // the way a player would, rather than forcing the state.
    if (await stateName(page) === 'prep_main') {
      const prep = await page.evaluate(() => {
        const state: any = (window as any).__gameRef.state.getCurrentState();
        return { options: state?.options ?? [], cursor: state?.cursor ?? 0 };
      });
      const fightIndex = prep.options.indexOf('Fight');
      expect(fightIndex, 'preparations should offer Fight').toBeGreaterThanOrEqual(0);
      for (let i = prep.cursor; i < fightIndex; i += 1) {
        await stepFrames(page, 3, 'DOWN');
      }
      await stepFrames(page, 3, 'SELECT');
      await settle(page, 10_000, ['free']);
    }
    expect(await stateName(page), 'Fight must start the battle').toBe('free');

    const combatants = await page.evaluate(() => {
      const game = (window as any).__gameRef;
      const player = game.getUnit('Yusha');
      const enemy = game.getUnit('Dragon');
      (window as any).__harness.warpUnit('Yusha', enemy.position[0], enemy.position[1] + 1);
      return {
        enemyNid: enemy.nid,
        enemyPos: [...enemy.position],
        enemyHp: enemy.currentHp,
        playerHp: player.currentHp,
      };
    });
    await stepFrames(page, 5);

    // Cursor to the player, select, confirm the tile, then Attack.
    const cursor = await page.evaluate(() => (window as any).__harness.getState().cursorPos);
    const [targetX, targetY] = [combatants.enemyPos[0], combatants.enemyPos[1] + 1];
    // Re-read the cursor each step: a fixed number of presses overshoots when
    // a frame drops or the cursor is nudged by the warp.
    for (let guard = 0; guard < 60; guard += 1) {
      const [cx, cy] = await page.evaluate(() =>
        (window as any).__harness.getState().cursorPos);
      if (cx === targetX && cy === targetY) break;
      if (cx !== targetX) await stepFrames(page, 4, cx < targetX ? 'RIGHT' : 'LEFT');
      else await stepFrames(page, 4, cy < targetY ? 'DOWN' : 'UP');
    }
    expect(
      await page.evaluate(() => (window as any).__harness.getState().cursorPos),
      'cursor should reach the player',
    ).toEqual([targetX, targetY]);

    await stepFrames(page, 3, 'SELECT'); // pick up the unit
    await stepFrames(page, 8);
    await stepFrames(page, 3, 'SELECT'); // stay on this tile, open the menu
    await stepFrames(page, 8);
    expect(await stateName(page), 'confirming the move must open the action menu').toBe('menu');

    // Attack must be offered at all: it only appears when the unit can wield
    // its own weapon, which depends on the wexp the unit prefab grants.
    const actionMenu = await page.evaluate(() => {
      const state: any = (window as any).__gameRef.state.getCurrentState();
      return state?.menu?.options?.map((option: any) => option.label) ?? [];
    });
    expect(actionMenu, 'an adjacent enemy must offer Attack').toContain('Attack');

    await stepFrames(page, 3, 'SELECT'); // Attack is the first entry
    await stepFrames(page, 8);
    if (await stateName(page) === 'weapon_choice') {
      await stepFrames(page, 3, 'SELECT');
      await stepFrames(page, 8);
    }
    await stepFrames(page, 3, 'SELECT'); // confirm the target
    await stepFrames(page, 10);

    // Let the exchange play out and control return to the map.
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const name = await stateName(page);
      if (name === 'free' || name === 'menu') break;
      await stepFrames(page, 10, 'SELECT');
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

    // Assert on the exchange rather than on who wins: this authored pairing is
    // a starting unit against a late-game dragon, so the counter is what lands.
    // Either way, HP moving proves targeting, the combat solver, and the damage
    // calculations all ran against real units and items.
    const enemyTookDamage = outcome.enemyDead ||
      (outcome.enemyHp !== null && outcome.enemyHp < combatants.enemyHp);
    const playerTookDamage = outcome.playerDead ||
      (outcome.playerHp !== null && outcome.playerHp < combatants.playerHp);
    expect(
      enemyTookDamage || playerTookDamage,
      `combat must change HP (enemy ${combatants.enemyHp}->${outcome.enemyHp}, ` +
      `player ${combatants.playerHp}->${outcome.playerHp})`,
    ).toBe(true);
    expect(['free', 'menu', 'phase_change']).toContain(await stateName(page));
    expect(compatibilityFailures, compatibilityFailures.join('\n')).toEqual([]);
  });
});
