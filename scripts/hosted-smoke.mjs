#!/usr/bin/env node
// Smoke check of a hosted build (npm run build:site) in a fresh browser.
//
//   node scripts/hosted-smoke.mjs <baseUrl> [--fake]
//
// Without --fake (any deployment, e.g. the live site): the sign-in gate must
// appear and the game must not boot before sign-in. With --fake (DEV only;
// secret from the gitignored .e2e-fake-login.local): signs in through the
// dev-only test sign-in, waits for the cloud hydrate and the boot packs, and
// screenshots the title. Screenshots go to test-screenshots/hosted-*.png.
import { chromium } from '@playwright/test';
import { readFileSync, mkdirSync } from 'node:fs';

const base = (process.argv[2] ?? 'http://localhost:4173').replace(/\/$/, '');
const fake = process.argv.includes('--fake');
const log = (...a) => console.log('[hosted]', ...a);
mkdirSync('test-screenshots', { recursive: true });

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 960, height: 640 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const failed = [];
page.on('response', (r) => { if (r.status() >= 400) failed.push(`${r.status()} ${r.url()}`); });

try {
  await page.goto(`${base}/?storage=convex`); // automation defaults to local storage
  await page.getByRole('button', { name: 'Sign in with Google' }).waitFor({ timeout: 60_000 });
  await page.screenshot({ path: 'test-screenshots/hosted-signin.png' });
  const packsBefore = failed.length;
  log('ok - sign-in gate shown');

  if (fake) {
    const secret = /AUTH_FAKE_LOGIN_SECRET=(\S+)/.exec(readFileSync('.e2e-fake-login.local', 'utf8'))?.[1];
    if (!secret) throw new Error('No AUTH_FAKE_LOGIN_SECRET in .e2e-fake-login.local');
    await page.getByLabel('Email').fill('aj12ay@gmail.com');
    await page.getByLabel('Test sign-in secret').fill(secret);
    await page.getByRole('button', { name: 'Test sign-in' }).click();
    await page.waitForFunction(() => !!(window).__cloud && !document.getElementById('cloud-signin'), null, { timeout: 60_000 });
    const keys = await page.evaluate(() => (window).__cloud.store.keys('').length);
    log(`ok - signed in, hydrated ${keys} cloud keys`);
    // Boot packs download, then the title draws; give the title a moment.
    await page.waitForLoadState('networkidle', { timeout: 180_000 }).catch(() => {});
    await page.waitForTimeout(6000);
    await page.screenshot({ path: 'test-screenshots/hosted-title.png' });
    log('screenshot test-screenshots/hosted-title.png');
  }
  if (errors.length) throw new Error(`page errors:\n${errors.join('\n')}`);
  if (failed.length) log(`HTTP failures (${failed.length}, ${packsBefore} before sign-in):\n  ${failed.slice(0, 20).join('\n  ')}`);
  log('done');
} finally {
  await browser.close();
}
