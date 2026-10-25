#!/usr/bin/env node
// End-to-end check of Convex cloud saves against the DEV deployment.
//
//   npx vite --port 5180 &          # dev server (port must be in dev SITE_URL)
//   node scripts/cloud-e2e.mjs [baseUrl]
//
// Uses the dev-only fake-google sign-in; the secret is read from the
// gitignored .e2e-fake-login.local (AUTH_FAKE_LOGIN_SECRET=...). Writes test
// keys (E2E*) and EotF progress into the owner's dev saves.
import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';

const base = process.argv[2] ?? 'http://localhost:5180';
const secret = /AUTH_FAKE_LOGIN_SECRET=(\S+)/.exec(readFileSync('.e2e-fake-login.local', 'utf8'))?.[1];
if (!secret) throw new Error('No AUTH_FAKE_LOGIN_SECRET in .e2e-fake-login.local');
const OWNER = 'aj12ay@gmail.com';
const GAME_URL = `${base}/?project=eotf.ltproj&storage=convex&bundle=false`;
const stamp = Date.now();
const MIG = `E2EMIG${stamp}`; // unique per run: migration never overwrites existing cloud keys
const log = (...a) => console.log('[e2e]', ...a);
const check = (cond, msg) => {
  if (!cond) throw new Error(`FAILED: ${msg}`);
  log('ok -', msg);
};

const browser = await chromium.launch();
const newPage = async () => {
  const ctx = await browser.newContext({ viewport: { width: 960, height: 640 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => log('pageerror:', e.message));
  return { ctx, page };
};

async function fakeSignIn(page, email, secretValue) {
  await page.getByRole('button', { name: 'Sign in with Google' }).waitFor({ timeout: 30_000 });
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Test sign-in secret').fill(secretValue);
  await page.getByRole('button', { name: 'Test sign-in' }).click();
}

async function waitForCloudBoot(page) {
  await page.waitForFunction(() => !!window.__cloud && !document.getElementById('cloud-signin'), null, { timeout: 60_000 });
  // (waitForFunction does not await async predicates, so poll from Node.)
  for (let i = 0; i < 240; i++) {
    const ready = await page.evaluate(async () => {
      const r = await import('/src/engine/records.ts');
      const gs = await import('/src/engine/game-state.ts');
      return !!r.RECORDS && !!gs.game?.state;
    });
    if (ready) return;
    await page.waitForTimeout(500);
  }
  throw new Error('game never finished booting');
}

const waitSynced = (page) =>
  page.waitForFunction(() => !window.__cloud.store.hasPendingWrites(), null, { timeout: 60_000 });

try {
  // ---- Context A: seed local data, reject outsiders, sign in, play, save ----
  const a = await newPage();
  await a.page.goto(`${base}/?project=eotf.ltproj&storage=local&harness=true&bundle=false&level=X`);
  await a.page.waitForFunction(() => !!window.__harness?.ready, null, { timeout: 120_000 });
  await a.page.evaluate(async ({ stamp, MIG }) => {
    const local = await import('/src/storage/local-backend.ts');
    await local.localSaveStore.set(`${MIG}-0`, { migrated: true, stamp });
    await local.localSaveStore.set(`${MIG}-0.meta`, { levelTitle: 'Migrated', stamp });
    localStorage.setItem(`lt-achievements-${MIG}`, JSON.stringify([{ nid: 'mig', name: 'M', desc: '', complete: true, hidden: false, stamp }]));
    // Make sure this device has not migrated yet for any account.
    for (const k of Object.keys(localStorage)) if (k.startsWith('lt-web.cloudMigrated')) localStorage.removeItem(k);
  }, { stamp, MIG });
  log('seeded local IndexedDB/localStorage data');

  await a.page.goto(GAME_URL);
  await fakeSignIn(a.page, 'mallory@example.com', secret);
  await a.page.getByText("This game's saves are private to its owner.").waitFor({ timeout: 20_000 });
  check(true, 'non-allowlisted email is rejected');
  await fakeSignIn(a.page, OWNER, 'wrong-secret');
  await a.page.getByText('Wrong test sign-in secret.').waitFor({ timeout: 20_000 });
  check(true, 'wrong test secret is rejected');
  await fakeSignIn(a.page, OWNER, secret);
  await waitForCloudBoot(a.page);
  check(true, 'owner signed in and the game booted');
  await waitSynced(a.page);
  check(
    await a.page.evaluate((MIG) => window.__cloud.store.has(`save:${MIG}-0`) && window.__cloud.store.has(`ls:lt-achievements-${MIG}`), MIG),
    'local save + achievements were migrated to the cloud',
  );

  // Real gameplay record: drive the EotF title/intro until it records watched_intro.
  const introWatched = () => a.page.evaluate(async () => {
    const r = await import('/src/engine/records.ts');
    return r.RECORDS.get('watched_intro') === 1;
  });
  const before = await introWatched();
  log('watched_intro before:', before);
  const canvas = a.page.locator('#game-canvas');
  await canvas.click({ position: { x: 5, y: 5 } }).catch(() => {});
  await a.page.waitForTimeout(3000);
  for (let i = 0; i < 60 && !(await introWatched()); i++) {
    await a.page.keyboard.press('Enter');
    await a.page.waitForTimeout(700);
  }
  check(await introWatched(), 'gameplay set persistent record watched_intro=1');

  const result = await a.page.evaluate(async (stamp) => {
    const r = await import('/src/engine/records.ts');
    const { game } = await import('/src/engine/game-state.ts');
    const save = await import('/src/engine/save.ts');
    const storage = await import('/src/storage/storage.ts');
    r.RECORDS.set('cloud_e2e_marker', stamp);
    await save.saveGame(game, 2, 'battle');
    await save.suspendGame(game);
    // Large value: exercises the gzip blob path (> 256 KiB inline limit).
    const big = { stamp, filler: Array.from({ length: 40000 }, (_, i) => ({ i, s: `row-${i}-${stamp}` })) };
    await storage.getSaveStore().set('E2EBLOB-0', big);
    const store = window.__cloud.store;
    return {
      slotInCloud: store.has('save:EotF-2'),
      bigBytes: JSON.stringify(big).length,
      level: game.currentLevel?.nid ?? null,
      state: game.state.getCurrentState?.()?.name ?? null,
    };
  }, stamp);
  log('saved:', JSON.stringify(result));
  check(result.slotInCloud, 'saveGame resolved with slot 2 in the cloud');
  await waitSynced(a.page);
  check(true, 'records/achievements queue flushed');
  await a.ctx.close();

  // ---- Context B: fresh browser, sign in, everything comes back ----
  const b = await newPage();
  await b.page.goto(GAME_URL);
  await fakeSignIn(b.page, OWNER, secret);
  await waitForCloudBoot(b.page);
  const restored = await b.page.evaluate(async ({ stamp, MIG }) => {
    const r = await import('/src/engine/records.ts');
    const save = await import('/src/engine/save.ts');
    const storage = await import('/src/storage/storage.ts');
    const { game } = await import('/src/engine/game-state.ts');
    const slots = await save.loadSaveSlots('EotF', 3);
    const big = await storage.getSaveStore().get('E2EBLOB-0');
    const mig = await storage.getSaveStore().get(`${MIG}-0`);
    const hasSuspend = await save.hasSuspend('EotF');
    const loaded = await save.loadGame(game, 2);
    return {
      watchedIntro: r.RECORDS.get('watched_intro'),
      marker: r.RECORDS.get('cloud_e2e_marker'),
      slot2: slots[2]?.name,
      hasSuspend,
      loaded,
      loadError: save.getLastLoadError(),
      bigOk: big?.stamp === stamp && big?.filler?.length === 40000 && big.filler[39999].s === `row-39999-${stamp}`,
      migOk: mig?.stamp === stamp,
      blobFlag: window.__cloud.store.cache?.get?.('save:E2EBLOB-0')?.blob ?? null,
    };
  }, { stamp, MIG });
  log('restored:', JSON.stringify(restored));
  check(restored.watchedIntro === 1, 'record watched_intro restored from Convex');
  check(restored.marker === stamp, 'record cloud_e2e_marker restored from Convex');
  check(restored.slot2 && restored.slot2 !== '--NO DATA--', `save slot 2 listed (${restored.slot2})`);
  check(restored.hasSuspend, 'suspend present');
  check(restored.loaded, `loadGame(slot 2) from Convex succeeded ${restored.loadError ?? ''}`);
  check(restored.blobFlag === true, 'large value stored as a blob');
  check(restored.bigOk, '1.6 MB value round-tripped through gzip blob file storage');
  check(restored.migOk, 'migrated save readable from the cloud');

  // Session persists across reload (no sign-in screen).
  await b.page.reload();
  await waitForCloudBoot(b.page);
  check(true, 'session persisted across reload');

  // Clean up test keys (exercises delete + blob cleanup) and sign out.
  await b.page.evaluate(async () => {
    const storage = await import('/src/storage/storage.ts');
    for (const k of await storage.getSaveStore().keys()) {
      if (k.startsWith('E2E')) await storage.getSaveStore().delete(k);
    }
    for (const k of window.__cloud.store.keys('ls:')) {
      if (k.startsWith('lt-achievements-E2E')) storage.getSyncStore().removeItem(k);
    }
  });
  await waitSynced(b.page);
  await b.page.getByRole('button', { name: /Cloud|Saving/ }).click();
  await b.page.getByRole('button', { name: 'Sign out' }).click();
  await b.page.getByRole('button', { name: 'Sign in with Google' }).waitFor({ timeout: 30_000 });
  check(true, 'sign out returns to the sign-in gate');
  await b.ctx.close();
  log('ALL CHECKS PASSED');
} finally {
  await browser.close();
}
