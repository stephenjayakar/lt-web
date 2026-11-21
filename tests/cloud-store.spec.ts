import { test, expect, type Page } from '@playwright/test';

// Contract tests for the local-first cloud store (src/storage/cloud-store.ts)
// against in-page stub clients and in-memory local stores: no network, no
// auth. Boot-level offline behavior is in tests/offline-saves.spec.ts; the
// real dev deployment is covered by scripts/cloud-e2e.mjs.

async function openShell(page: Page): Promise<void> {
  // Any Vite-served page works; Playwright is WebDriver-controlled, so the app
  // stays in local storage mode and just shows the project picker.
  await page.goto('/?storage=local');
  await page.waitForFunction(() => document.readyState === 'complete');
  await page.evaluate(() => {
    localStorage.clear();
    // In-memory local stores shared by the cases below.
    (window as any).__memStores = () => {
      const saves = new Map<string, unknown>();
      const sync = new Map<string, string>();
      return {
        saves,
        sync,
        localSave: {
          get: async (k: string) => (saves.has(k) ? structuredClone(saves.get(k)) : undefined),
          set: async (k: string, v: unknown) => { saves.set(k, structuredClone(v)); },
          delete: async (k: string) => { saves.delete(k); },
          keys: async () => [...saves.keys()],
        },
        localSync: {
          getItem: (k: string) => sync.get(k) ?? null,
          setItem: (k: string, v: string) => { sync.set(k, v); },
          removeItem: (k: string) => { sync.delete(k); },
        },
        localSyncKeys: () => [...sync.keys()],
      };
    };
  });
}

test.describe('local-first cloud store', () => {
  test('saves resolve from local storage while the cloud hangs, then upload in the background', async ({ page }) => {
    await openShell(page);
    const result = await page.evaluate(async () => {
      const { CloudStore } = await import('/src/storage/cloud-store.ts');
      const mem = (window as any).__memStores();
      const calls: Array<{ path: string; args: any }> = [];
      let releaseHydrate: () => void = () => {};
      const hydrateGate = new Promise<void>((r) => { releaseHydrate = r; });
      const client: any = {
        hasSession: () => true,
        call: async (_kind: string, path: string, args: any) => {
          calls.push({ path, args });
          if (path === 'kv:hydrate') {
            await hydrateGate; // a hanging network
            return [];
          }
          await new Promise((r) => setTimeout(r, 10));
          return { updatedAt: Date.now() };
        },
        fetchSite: async () => { throw new Error('unexpected'); },
      };
      const store = new CloudStore(client, 'user-a', mem);
      await store.start();
      const saves = store.saveStore();
      const sync = store.syncStore();

      const t0 = performance.now();
      await saves.set('G-1', { slot: 1 });
      await saves.set('G-1.meta', { kind: 'battle' });
      sync.setItem('lt-persistent-records-G', 'v1');
      sync.setItem('lt-persistent-records-G', 'v2');
      sync.setItem('lt-persistent-records-G', 'v3');
      const saveMs = performance.now() - t0;
      const read = await saves.get('G-1');
      read.slot = 99; // reads are copies
      const local = {
        slot: (await saves.get('G-1')).slot,
        keys: (await saves.keys()).sort(),
        record: sync.getItem('lt-persistent-records-G'),
        pending: store.hasPendingWrites(),
        state: store.status().state,
        sentBeforeHydrate: calls.filter((c) => c.path !== 'kv:hydrate').length,
      };

      releaseHydrate();
      for (let i = 0; i < 100 && store.hasPendingWrites(); i++) await new Promise((r) => setTimeout(r, 50));
      await saves.delete('G-1.meta');
      for (let i = 0; i < 100 && store.hasPendingWrites(); i++) await new Promise((r) => setTimeout(r, 50));
      return {
        saveMs,
        local,
        sent: calls.filter((c) => c.path !== 'kv:hydrate').map((c) => `${c.path}:${c.args.key}${c.args.value ? `=${c.args.value}` : ''}`),
        synced: store.isSynced('save:G-1') && store.isSynced('ls:lt-persistent-records-G'),
        finalState: store.status().state,
        journal: JSON.parse(localStorage.getItem('lt-web.cloudSync.v1') ?? 'null'),
      };
    });
    expect(result.saveMs).toBeLessThan(500);
    expect(result.local).toEqual({
      slot: 1,
      keys: ['G-1', 'G-1.meta'],
      record: 'v3',
      pending: true,
      state: 'syncing',
      sentBeforeHydrate: 0, // nothing is pushed before the first reconcile
    });
    // Debounced latest-wins: only the final record value is sent.
    expect(result.sent).toEqual([
      'kv:setInline:save:G-1={"slot":1}',
      'kv:setInline:save:G-1.meta={"kind":"battle"}',
      'kv:setInline:ls:lt-persistent-records-G=v3',
      'kv:remove:save:G-1.meta',
    ]);
    expect(result.synced).toBe(true);
    expect(result.finalState).toBe('idle');
    expect(result.journal.userId).toBe('user-a');
    expect(result.journal.entries['save:G-1.meta']).toBeUndefined();
  });

  test('conflict rule: newest wins per key, legacy keys defer to the cloud', async ({ page }) => {
    await openShell(page);
    const result = await page.evaluate(async () => {
      const { CloudStore, decide } = await import('/src/storage/cloud-store.ts');
      const table = {
        cleanCloudNewer: decide({ cloudAt: 10, localAt: 10 }, { updatedAt: 20 }, true, { isSave: true, legacyMigrated: true }),
        cleanSame: decide({ cloudAt: 10 }, { updatedAt: 10 }, true, { isSave: true, legacyMigrated: true }),
        cleanDeletedInCloud: decide({ cloudAt: 10 }, undefined, true, { isSave: true, legacyMigrated: true }),
        dirtyCloudUnchanged: decide({ cloudAt: 10, localAt: 30, dirty: true }, { updatedAt: 10 }, true, { isSave: true, legacyMigrated: true }),
        dirtyBothChangedLocalNewer: decide({ cloudAt: 10, localAt: 30, dirty: true }, { updatedAt: 20 }, true, { isSave: true, legacyMigrated: true }),
        dirtyBothChangedCloudNewer: decide({ cloudAt: 10, localAt: 15, dirty: true }, { updatedAt: 20 }, true, { isSave: true, legacyMigrated: true }),
        dirtyNeverSyncedCloudOlder: decide({ localAt: 30, dirty: true }, { updatedAt: 20 }, true, { isSave: true, legacyMigrated: false }),
        legacyBoth: decide(undefined, { updatedAt: 5 }, true, { isSave: true, legacyMigrated: false }),
        legacyLocalSaveMigrated: decide(undefined, undefined, true, { isSave: true, legacyMigrated: true }),
        legacyLocalSaveNew: decide(undefined, undefined, true, { isSave: true, legacyMigrated: false }),
        legacyLocalRecord: decide(undefined, undefined, true, { isSave: false, legacyMigrated: true }),
      };

      // Integrated: one reconcile over a journal in every state.
      const mem = (window as any).__memStores();
      localStorage.setItem('lt-web.cloudMigrated.v1:user-b', '1');
      localStorage.setItem('lt-web.cloudSync.v1', JSON.stringify({
        userId: 'user-b',
        entries: {
          'save:pull': { cloudAt: 10, localAt: 10 },
          'save:gone': { cloudAt: 10, localAt: 10 },
          'save:mine': { cloudAt: 10, localAt: 30, dirty: true },
          'save:theirs': { cloudAt: 10, localAt: 15, dirty: true },
          'ls:lt-persistent-records-G': { cloudAt: 10, localAt: 10 },
        },
      }));
      mem.saves.set('pull', { v: 'old' });
      mem.saves.set('gone', { v: 'deleted elsewhere' });
      mem.saves.set('mine', { v: 'local edit' });
      mem.saves.set('theirs', { v: 'stale local edit' });
      mem.saves.set('stale-suspend', { v: 'pre-cloud backup' });
      mem.saves.set('legacy-both', { v: 'pre-cloud backup' });
      mem.sync.set('lt-persistent-records-G', '[old]');
      mem.sync.set('lt-web-settings', '{"local":1}');
      const rows = [
        { key: 'save:pull', size: 1, updatedAt: 20, blob: false, value: '{"v":"cloud"}' },
        { key: 'save:mine', size: 1, updatedAt: 20, blob: false, value: '{"v":"cloud older"}' },
        { key: 'save:theirs', size: 1, updatedAt: 20, blob: false, value: '{"v":"cloud newer"}' },
        { key: 'save:legacy-both', size: 1, updatedAt: 5, blob: false, value: '{"v":"cloud"}' },
        { key: 'save:cloud-only', size: 1, updatedAt: 5, blob: false },
        { key: 'ls:lt-persistent-records-G', size: 1, updatedAt: 20, blob: false, value: '[new]' },
      ];
      const sent: string[] = [];
      const client: any = {
        hasSession: () => true,
        call: async (_kind: string, path: string, args: any) => {
          if (path === 'kv:hydrate') return rows;
          if (path === 'kv:get') return { value: '{"v":"fetched"}' };
          sent.push(`${path}:${args.key}`);
          return { updatedAt: 40 };
        },
        fetchSite: async () => { throw new Error('unexpected'); },
      };
      const store = new CloudStore(client, 'user-b', mem);
      const remote: string[] = [];
      store.onRemoteChange((key) => remote.push(key));
      await store.start();
      await store.whenReconciled();
      for (let i = 0; i < 100 && store.hasPendingWrites(); i++) await new Promise((r) => setTimeout(r, 50));
      return {
        table,
        local: Object.fromEntries([...mem.saves].map(([k, v]: [string, any]) => [k, v.v]).sort()),
        records: mem.sync.get('lt-persistent-records-G'),
        settings: mem.sync.get('lt-web-settings'),
        sent: sent.sort(),
        remote,
      };
    });
    expect(result.table).toEqual({
      cleanCloudNewer: 'pull',
      cleanSame: 'none',
      cleanDeletedInCloud: 'drop-local',
      dirtyCloudUnchanged: 'push',
      dirtyBothChangedLocalNewer: 'push',
      dirtyBothChangedCloudNewer: 'pull',
      dirtyNeverSyncedCloudOlder: 'push',
      legacyBoth: 'pull',
      legacyLocalSaveMigrated: 'drop-local',
      legacyLocalSaveNew: 'push',
      legacyLocalRecord: 'push',
    });
    expect(result.local).toEqual({
      'cloud-only': 'fetched',
      'legacy-both': 'cloud',
      mine: 'local edit',
      pull: 'cloud',
      theirs: 'cloud newer',
    });
    expect(result.records).toBe('[new]');
    expect(result.settings).toBe('{"local":1}');
    expect(result.sent).toEqual(['kv:setInline:ls:lt-web-settings', 'kv:setInline:save:mine']);
    expect(result.remote).toEqual(['lt-persistent-records-G']);
  });

  test('network failures and offline never reach the game; sync resumes when back online', async ({ page }) => {
    test.slow();
    await openShell(page);
    await page.evaluate(async () => {
      const { CloudStore } = await import('/src/storage/cloud-store.ts');
      const { CloudError } = await import('/src/storage/cloud-client.ts');
      const mem = (window as any).__memStores();
      const w = window as any;
      w.__failuresLeft = 2;
      w.__sent = [];
      const client: any = {
        hasSession: () => true,
        call: async (_kind: string, path: string, args: any) => {
          if (w.__failuresLeft > 0) {
            w.__failuresLeft--;
            throw new CloudError('Network error: no response after 10s', true);
          }
          if (path === 'kv:hydrate') return [];
          w.__sent.push(`${args.key}=${args.value}`);
          return { updatedAt: 1 };
        },
        fetchSite: async () => { throw new Error('unexpected'); },
      };
      w.__store = new CloudStore(client, 'user-c', mem);
      w.__states = [];
      w.__store.onStatus((s: any) => w.__states.push(s.state));
      await w.__store.start();
      await w.__store.saveStore().set('G-2', { hp: 3 });
    });
    await page.waitForFunction(() => (window as any).__store.status().state === 'idle', undefined, { timeout: 20_000 });
    const firstPass = await page.evaluate(() => ({ sent: (window as any).__sent, states: (window as any).__states }));
    expect(firstPass.states).toContain('error');
    expect(firstPass.sent).toEqual(['save:G-2={"hp":3}']);

    // Offline: writes still resolve, the loop pauses, and resumes on `online`.
    await page.context().setOffline(true);
    const offline = await page.evaluate(async () => {
      const w = window as any;
      const t0 = performance.now();
      await w.__store.saveStore().set('G-3', { hp: 4 });
      w.__store.syncStore().setItem('lt-achievements-G', '[1]');
      await new Promise((r) => setTimeout(r, 800));
      return { ms: performance.now() - t0 - 800, state: w.__store.status().state, sent: w.__sent.length, pending: w.__store.hasPendingWrites() };
    });
    expect(offline.ms).toBeLessThan(500);
    expect(offline).toMatchObject({ state: 'offline', sent: 1, pending: true });
    await page.context().setOffline(false);
    await page.waitForFunction(() => !(window as any).__store.hasPendingWrites(), undefined, { timeout: 20_000 });
    const sent = await page.evaluate(() => (window as any).__sent.slice().sort());
    expect(sent).toEqual(['ls:lt-achievements-G=[1]', 'save:G-2={"hp":3}', 'save:G-3={"hp":4}']);
  });

  test('a refused session stops syncing but keeps local play working', async ({ page }) => {
    await openShell(page);
    const result = await page.evaluate(async () => {
      const { CloudStore } = await import('/src/storage/cloud-store.ts');
      const { CloudError } = await import('/src/storage/cloud-client.ts');
      const mem = (window as any).__memStores();
      let session = true;
      const client: any = {
        hasSession: () => session,
        call: async () => {
          session = false;
          throw new CloudError('Signed out. Sign in with Google again.');
        },
        fetchSite: async () => { throw new Error('unexpected'); },
      };
      const store = new CloudStore(client, 'user-d', mem);
      const lost: string[] = [];
      store.onAuthLost((m) => lost.push(m));
      await store.start();
      for (let i = 0; i < 50 && lost.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
      await store.saveStore().set('G-1', { ok: true });
      return { lost, state: store.status().state, value: await store.saveStore().get('G-1'), pending: store.hasPendingWrites() };
    });
    expect(result.lost).toEqual(['Signed out. Sign in with Google again.']);
    expect(result.state).toBe('signed-out');
    expect(result.value).toEqual({ ok: true });
    expect(result.pending).toBe(true); // uploads after the next sign-in
  });

  test('the cloud-first outbox replays locally and large values use the gzip blob route', async ({ page }) => {
    await openShell(page);
    const result = await page.evaluate(async () => {
      const { CloudStore } = await import('/src/storage/cloud-store.ts');
      const mem = (window as any).__memStores();
      localStorage.setItem('lt-web.cloudOutbox.v1:user-e', JSON.stringify({ 'ls:lt-persistent-records-G': '[9]' }));
      const sent: string[] = [];
      let blobBody: Blob | null = null;
      let blobQuery = '';
      const client: any = {
        hasSession: () => true,
        call: async (_kind: string, path: string, args: any) => {
          if (path === 'kv:hydrate') return [{ key: 'ls:lt-persistent-records-G', size: 3, updatedAt: 1, blob: false, value: '[1]' }];
          sent.push(`${path}:${args.key}`);
          return { updatedAt: 2 };
        },
        fetchSite: async (path: string, init: RequestInit = {}) => {
          if (init.method === 'POST') {
            blobQuery = path;
            blobBody = init.body as Blob;
            return new Response(JSON.stringify({ updatedAt: 3 }), { status: 200 });
          }
          return new Response(blobBody, { status: 200, headers: { 'X-KV-Encoding': 'gzip-json' } });
        },
      };
      const store = new CloudStore(client, 'user-e', mem);
      await store.start();
      const replayed = store.syncStore().getItem('lt-persistent-records-G');
      const big = { rows: Array.from({ length: 30000 }, (_, i) => `row-${i}`) };
      await store.saveStore().set('G-big', big);
      for (let i = 0; i < 100 && store.hasPendingWrites(); i++) await new Promise((r) => setTimeout(r, 50));
      // A second device pulls the blob entry back through GET.
      const mem2 = (window as any).__memStores();
      const reader = new CloudStore({
        ...client,
        call: async (_k: string, path: string) =>
          path === 'kv:hydrate' ? [{ key: 'save:G-big', size: 1, updatedAt: 3, blob: true }] : null,
      }, 'user-f', mem2);
      await reader.reconcile();
      const back: any = await reader.saveStore().get('G-big');
      return {
        replayed,
        outboxGone: localStorage.getItem('lt-web.cloudOutbox.v1:user-e') === null,
        sent,
        blobQuery,
        compressed: (blobBody as Blob | null)?.size ?? 0,
        raw: JSON.stringify(big).length,
        roundTrip: back?.rows?.length === 30000 && back.rows[29999] === 'row-29999',
      };
    });
    // The outbox value was newer than the cloud copy: it stays and uploads.
    expect(result.replayed).toBe('[9]');
    expect(result.outboxGone).toBe(true);
    expect(result.sent).toContain('kv:setInline:ls:lt-persistent-records-G');
    expect(result.sent).not.toContain('kv:setInline:save:G-big');
    expect(result.blobQuery).toContain('encoding=gzip-json');
    expect(result.compressed).toBeGreaterThan(0);
    expect(result.compressed).toBeLessThan(result.raw / 4);
    expect(result.roundTrip).toBe(true);
  });

  test('test and automation contexts select the local backend', async ({ page }) => {
    await openShell(page);
    const modes = await page.evaluate(async () => {
      const { resolveStorageMode, convexUrl } = await import('/src/storage/storage.ts');
      const mode = (qs: string) => resolveStorageMode(new URLSearchParams(qs));
      return {
        configured: !!convexUrl(),
        harness: mode('harness=true'),
        control: mode('control=true'),
        webdriver: mode('project=eotf.ltproj'),
        forcedLocal: mode('storage=local'),
        forcedConvex: mode('storage=convex'),
      };
    });
    expect(modes.harness).toBe('local');
    expect(modes.control).toBe('local');
    expect(modes.webdriver).toBe('local');
    expect(modes.forcedLocal).toBe('local');
    expect(modes.forcedConvex).toBe(modes.configured ? 'convex' : 'local');
  });
});
