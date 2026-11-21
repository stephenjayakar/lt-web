import { test, expect, type Page, type Route } from '@playwright/test';

// Cloud mode must never hold the game hostage to the network: boot reaches
// the title and saves/loads work with Convex unreachable, offline, or
// hanging (src/storage/cloud-boot.ts, src/storage/cloud-store.ts).
//
// Cloud mode is pointed at a mocked origin through the dev-only
// `window.__ltTestConvexUrl` hook (src/storage/storage.ts). Every request to
// a non-local host is intercepted, so nothing here reaches a real deployment.

// Normal (non-harness) boot plays the title music.
test.use({ launchOptions: { args: ['--mute-audio'] } });

const CONVEX_URL = 'https://convex.test.invalid';
const NS = CONVEX_URL.replace(/^https?:\/\//, '').replace(/[^a-zA-Z0-9]/g, '');
const GAME_URL = '/?storage=convex&project=default.ltproj&bundle=false';
const BOOT_TIMEOUT = 60_000;

type Mode = 'abort' | 'hang' | 'ok';
interface MockConvex {
  mode: Mode;
  /** Server-side kv rows, kept across reloads like the real table. */
  rows: Map<string, { key: string; size: number; updatedAt: number; blob: boolean; value: string }>;
  uploads: string[];
  calls: string[];
}

const b64url = (s: string) => Buffer.from(s).toString('base64url');
const fakeJwt = () =>
  `${b64url('{"alg":"none"}')}.${b64url(JSON.stringify({ sub: 'user1|session1', exp: Math.floor(Date.now() / 1000) + 3600 * 24 * 365 }))}.sig`;

async function setup(page: Page, opts: { session: boolean; mode: Mode }): Promise<MockConvex> {
  const mock: MockConvex = { mode: opts.mode, rows: new Map(), uploads: [], calls: [] };
  await page.addInitScript(({ url, ns, token, session }) => {
    (window as any).__ltTestConvexUrl = url;
    if (session && !localStorage.getItem(`lt-web.auth.v1:${ns}`)) {
      localStorage.setItem(`lt-web.auth.v1:${ns}`, JSON.stringify({ token, refreshToken: 'refresh' }));
    }
  }, { url: CONVEX_URL, ns: NS, token: fakeJwt(), session: opts.session });

  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  };
  await page.route((url) => url.hostname !== 'localhost' && url.hostname !== '127.0.0.1', async (route: Route) => {
    const req = route.request();
    if (mock.mode === 'abort') {
      await route.abort('internetdisconnected');
      return;
    }
    if (mock.mode === 'hang') {
      // Never answers. Leave the route pending (a stalled connection).
      await new Promise(() => {});
      return;
    }
    if (req.method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: cors });
      return;
    }
    const url = new URL(req.url());
    if (!url.hostname.endsWith('.invalid') || !url.pathname.startsWith('/api/')) {
      await route.fulfill({ status: 404, headers: cors, body: 'not mocked' });
      return;
    }
    const body = req.postDataJSON() as { path: string; args: any };
    mock.calls.push(body.path);
    let value: unknown = null;
    if (body.path === 'access:me') value = { userId: 'user1', email: 'owner@example.com', name: null };
    else if (body.path === 'access:environment') value = { google: true, fakeLogin: false };
    else if (body.path === 'kv:hydrate') value = [...mock.rows.values()];
    else if (body.path === 'kv:get') value = mock.rows.get(body.args.key) ?? null;
    else if (body.path === 'kv:setInline') {
      const { key, value: payload } = body.args;
      const updatedAt = Date.now();
      mock.rows.set(key, { key, size: payload.length, updatedAt, blob: false, value: payload });
      mock.uploads.push(key);
      value = { updatedAt };
    } else if (body.path === 'kv:remove') {
      mock.rows.delete(body.args.key);
      mock.uploads.push(`-${body.args.key}`);
    }
    await route.fulfill({
      status: 200,
      headers: cors,
      contentType: 'application/json',
      body: JSON.stringify({ status: 'success', value }),
    });
  });
  return mock;
}

async function bootToTitle(page: Page): Promise<number> {
  const t0 = Date.now();
  await page.goto(GAME_URL);
  await page.waitForFunction(() => document.documentElement.dataset.ltBoot === 'title', undefined, { timeout: BOOT_TIMEOUT });
  return Date.now() - t0;
}

/** Save slot 1 + a suspend through the real save API; returns timings and what loads back. */
async function saveAndLoad(page: Page, slot: number) {
  return await page.evaluate(async (slot) => {
    const { game } = await import('/src/engine/game-state.ts');
    const save = await import('/src/engine/save.ts');
    const nid = game.db.getConstant('game_nid', 'default');
    const t0 = performance.now();
    await save.saveGame(game, slot, 'battle');
    await save.suspendGame(game);
    const saveMs = performance.now() - t0;
    const slots = await save.loadSaveSlots(nid, 3);
    const loaded = await save.loadGame(game, slot);
    return {
      nid,
      saveMs,
      listed: !!slots[slot] && slots[slot].name !== '--NO DATA--',
      hasSuspend: await save.hasSuspend(nid),
      loaded,
      loadError: save.getLastLoadError?.() ?? null,
    };
  }, slot);
}

const pillState = (page: Page) => page.locator('#cloud-account').getAttribute('data-state');

test.describe('offline-first cloud saves', () => {
  test('Convex unreachable and browser offline: boot, save and load work; uploads resume online', async ({ page }) => {
    test.slow();
    const mock = await setup(page, { session: true, mode: 'abort' });
    await bootToTitle(page);
    await expect(page.locator('#cloud-signin')).toHaveCount(0);

    const first = await saveAndLoad(page, 1);
    expect(first).toMatchObject({ listed: true, hasSuspend: true, loaded: true });
    expect(first.saveMs).toBeLessThan(3_000);
    await expect.poll(() => pillState(page)).toMatch(/error|syncing/);

    // The whole browser goes offline: still no waiting on the network.
    await page.context().setOffline(true);
    const offline = await saveAndLoad(page, 2);
    expect(offline).toMatchObject({ listed: true, hasSuspend: true, loaded: true });
    expect(offline.saveMs).toBeLessThan(3_000);
    await expect.poll(() => pillState(page)).toBe('offline');
    expect(await page.evaluate(() => (window as any).__cloud.store.hasPendingWrites())).toBe(true);

    // Back online with a working server: the queued saves upload.
    mock.mode = 'ok';
    await page.context().setOffline(false);
    await page.waitForFunction(() => !(window as any).__cloud.store.hasPendingWrites(), undefined, { timeout: 45_000 });
    expect(mock.uploads).toEqual(expect.arrayContaining([
      `save:${first.nid}-1`,
      `save:${first.nid}-1.meta`,
      `save:${first.nid}-2`,
      `save:${first.nid}-suspend`,
    ]));
    await expect.poll(() => pillState(page)).toBe('idle');

    // A reload reconciles with the server (nothing new) and keeps the saves.
    await bootToTitle(page);
    await page.waitForFunction(() => (window as any).__cloud.store.isReconciled(), undefined, { timeout: 15_000 });
    const slots = await page.evaluate(async (nid) => {
      const save = await import('/src/engine/save.ts');
      return (await save.loadSaveSlots(nid, 3)).map((s: any) => s?.name ?? null);
    }, first.nid);
    expect(slots[1]).not.toBe('--NO DATA--');
    expect(slots[2]).not.toBe('--NO DATA--');
  });

  test('a hanging Convex request does not hold up boot or saves (signed in)', async ({ page }) => {
    const logs: string[] = [];
    page.on('console', (m) => logs.push(m.text()));
    await setup(page, { session: true, mode: 'hang' });
    const ms = await bootToTitle(page);
    // Boot waits at most BOOT_SYNC_BUDGET_MS (2.5 s) for the first sync,
    // far below the 10 s request timeout.
    expect(ms).toBeLessThan(15_000);
    expect(logs.some((l) => l.includes('cloud sync is slow'))).toBe(true);
    const saved = await saveAndLoad(page, 0);
    expect(saved).toMatchObject({ listed: true, loaded: true });
    expect(saved.saveMs).toBeLessThan(3_000);
  });

  test('a hanging Convex request does not hold up boot (signed out)', async ({ page }) => {
    await setup(page, { session: false, mode: 'hang' });
    const ms = await bootToTitle(page);
    // The sign-in gate's reachability probe gives up after 4 s.
    expect(ms).toBeLessThan(15_000);
    await expect(page.locator('#cloud-account')).toHaveAttribute('data-state', 'signed-out');
  });

  test('signed out with a reachable server: the gate offers local play and remembers it', async ({ page }) => {
    await setup(page, { session: false, mode: 'ok' });
    await page.goto(GAME_URL);
    await page.getByRole('button', { name: 'Play without signing in' }).click();
    await page.waitForFunction(() => document.documentElement.dataset.ltBoot === 'title', undefined, { timeout: BOOT_TIMEOUT });
    const saved = await saveAndLoad(page, 0);
    expect(saved).toMatchObject({ listed: true, loaded: true });
    // The choice sticks: no gate on the next visit.
    await bootToTitle(page);
    await expect(page.locator('#cloud-signin')).toHaveCount(0);
  });
});
