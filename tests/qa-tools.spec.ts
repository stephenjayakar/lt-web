/**
 * qa-tools.spec.ts — the QA jump/fast/auto-play tools (src/qa/,
 * docs/qa-tools.md) against the authored EOtF project.
 *
 * The dev server compiles the tools in (__LT_QA__); player builds do not.
 */

import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

const projectAvailable = fs.existsSync(path.join(process.cwd(), 'lt-maker/eotf.ltproj/game_data/levels.json'));

async function bootQa(page: Page): Promise<void> {
  await page.goto('/?qa&project=eotf.ltproj&bundle=false&seed=5');
  await page.waitForFunction(() => (window as any).__qa?.ready === true, undefined, { timeout: 90_000 });
  await page.evaluate(() => (window as any).__qa.setFast({ speed: 0, skipEvents: true, quietLog: true, drawEvery: 16 }));
}

test.describe('QA tools', () => {
  test.skip(!projectAvailable, 'lt-maker/eotf.ltproj is not installed');

  test('jump to Act 2 floor 16 runs Run_Start with a promoted party of five', async ({ page }) => {
    test.slow();
    await bootQa(page);
    const jump = await page.evaluate(() => (window as any).__qa.jump({
      act: 2,
      floor: 16,
      party: ['Player', 'Gorbat', 'Pilus', 'Viran', { nid: 'Taag', items: ['Vulnerary'] }],
      promoted: true,
      seed: 5,
    }));
    expect(jump.level).toBe('Act_2');
    expect(jump.floor).toBe(16);
    expect(jump.state).toBe('free_roam');
    const party = Object.fromEntries(jump.party.map((u: any) => [u.nid, u]));
    expect(Object.keys(party).sort()).toEqual(['Gorbat', 'Pilus', 'Player', 'Taag', 'Viran']);
    // Promotion through `promote`, levels through `autolevel_to` (1 + 0.8 * floor).
    expect(party.Gorbat.klass).toBe('Great_Knight');
    expect(party.Pilus.klass).toBe('Bishop');
    expect(party.Gorbat.level).toBe(14);
    expect(party.Taag.items).toContain('Vulnerary');
    const vars = await page.evaluate(() => {
      const game = (window as any).__qa.game;
      return {
        gameLevel: game.gameVars.get('Game_Level'),
        convoy: game.gameVars.get('_convoy'),
        rooms: ['room1', 'room2', 'room3'].map((nid) => game.levelVars.get(nid)),
      };
    });
    // Global_Level_End added the 16th Game_Level step; Run_Start ran for real.
    expect(vars.gameLevel).toBeCloseTo(0.45 * 16, 5);
    expect(vars.convoy).toBe(true);
    expect(vars.rooms.every((room: unknown) => typeof room === 'string')).toBe(true);
  });

  test('auto-play clears Act 1 floor 1 and logs the floor', async ({ page }) => {
    test.slow();
    await bootQa(page);
    await page.evaluate(() => (window as any).__qa.jump({ floor: 1, seed: 5, boost: 5 }));
    await page.evaluate(() => (window as any).__qa.play({ floors: 1, policy: { seed: 5 } }));
    await page.waitForFunction(() => (window as any).__qa.status().phase === 'done', undefined, { timeout: 180_000 });
    const report = await page.evaluate(() => (window as any).__qa.report());
    expect(report.status.result, report.status.reason).toBe('ok');
    const floor = report.floors[0];
    expect(floor.floor).toBe(1);
    // Floor 1 is always three combat rooms (Act_1 Intro rigs it).
    expect(floor.roomsOffered).toHaveLength(3);
    expect(floor.roomsOffered.every((room: string) => room.startsWith('Combat'))).toBe(true);
    const battle = floor.levels.find((level: any) => level.kind === 'battle');
    expect(battle?.result).toBe('won');
    expect(battle?.combats).toBeGreaterThan(0);
    expect(report.log.filter((entry: any) => entry.kind === 'error' || entry.kind === 'pageerror')).toEqual([]);
  });
});
