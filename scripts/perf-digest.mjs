#!/usr/bin/env node
/**
 * perf-digest.mjs — behaviour fingerprint for performance work (A/B of two
 * builds of the same game logic). See docs/qa-tools.md.
 *
 *   node scripts/perf-digest.mjs [--level Loreia] [--port 5191] [--map-combat] [--turns 1]
 *
 * Jumps to a busy battle level with the QA tools, lets asset loads settle,
 * auto-plays whole turns (player phase by the QA AI, then the enemy AI
 * phase) and stops at the exact start of the next player phase (the turn
 * limit), then prints every unit's position, HP and death plus an md5 of
 * that list and the warning counts. Two builds whose logic is unchanged
 * print the same digest. Expects a dev server on --port (npm run dev).
 */

import crypto from 'node:crypto';
import { chromium } from '@playwright/test';

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};
const port = Number(opt('port', process.env.PLAYWRIGHT_PORT ?? 5191));
const level = opt('level', 'Loreia');
const turns = Number(opt('turns', 1));
const mapCombat = argv.includes('--map-combat');

const browser = await chromium.launch({ headless: true, args: ['--mute-audio'] });
const page = await (await browser.newContext()).newPage();
const warns = [];
page.on('console', (m) => {
  if (m.type() === 'warning' || m.type() === 'error') warns.push(m.text().slice(0, 200));
});
try {
  await page.goto(`http://127.0.0.1:${port}/?qa&project=eotf.ltproj&bundle=false&seed=5`, { timeout: 180_000 });
  await page.waitForFunction(() => window.__qa?.ready === true, undefined, { timeout: 120_000 });
  await page.evaluate((map) => window.__qa.setFast({
    speed: 0, skipEvents: true, drawEvery: 1, quietLog: false, combat: map ? 'map' : 'animation',
  }), mapCombat);
  await page.evaluate((nid) => window.__qa.jump({
    level: nid, party: ['Player', 'Gorbat', 'Pilus', 'Viran', 'Taag'], boost: 10, seed: 5,
  }), level);
  // Pause and let image loads finish, so frame-timed presentation starts
  // from the same point whatever the build's speed.
  const settleLoads = async () => {
    await page.evaluate(() => window.__qa.setFast({ speed: 0.0001 }));
    await page.waitForTimeout(500);
    await page.waitForFunction(() => (window.__qa.game.resources.pendingImages?.size ?? 0) === 0, undefined, { timeout: 60_000 });
    await page.waitForTimeout(1500);
    await page.evaluate(() => window.__qa.setFast({ speed: 0 }));
  };
  await settleLoads();
  await page.evaluate(() => window.__qa.play({ oneLevel: true, autoplay: false, hover: true, policy: { seed: 5 } }));
  await page.waitForFunction(() => {
    const g = window.__qa.game;
    return g.state.getCurrentState()?.name === 'free' && g.phase?.getCurrent?.() === 'player' && !g.eventManager?.hasActiveEvents();
  }, undefined, { timeout: 120_000 });
  await settleLoads();
  // The turn limit stops the driver at the first player phase past it.
  await page.evaluate((limit) => window.__qa.play({ oneLevel: true, autoplay: true, maxTurns: limit, policy: { seed: 5 } }), turns);
  await page.waitForFunction(() => window.__qa.status().phase === 'done', undefined, { timeout: 600_000 });
  const d = await page.evaluate(() => {
    const g = window.__qa.game;
    return {
      turn: g.turnCount,
      units: [...g.units.values()].filter((u) => u.position || u.isDead())
        .map((u) => `${u.nid}@${u.position}:${u.currentHp}${u.isDead() ? 'X' : ''}`).sort(),
    };
  });
  const list = d.units.join(' ');
  const counts = {};
  for (const w of warns) counts[w] = (counts[w] ?? 0) + 1;
  console.log(`digest ${crypto.createHash('md5').update(list).digest('hex')}  level ${level}  turn ${d.turn}  ${d.units.length} units${mapCombat ? '  map combat' : ''}`);
  console.log(list);
  console.log('warnings', JSON.stringify(Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 8)));
} finally {
  await browser.close();
}
