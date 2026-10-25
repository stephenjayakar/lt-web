import { test, expect, type Page } from '@playwright/test';

// Contract tests for the Convex-backed storage adapter (src/storage/cloud-store.ts)
// against an in-page stub client: no network, no auth. The real deployment is
// covered by scripts/cloud-e2e.mjs.

async function openShell(page: Page): Promise<void> {
  // Any Vite-served page works; Playwright is WebDriver-controlled, so the app
  // stays in local storage mode and just shows the project picker.
  await page.goto('/?storage=local');
  await page.waitForFunction(() => document.readyState === 'complete');
}

test.describe('cloud store adapter', () => {
  test('coalesces writes per key, awaits saves, and serves reads from the cache', async ({ page }) => {
    await openShell(page);
    const result = await page.evaluate(async () => {
      const { CloudStore } = await import('/src/storage/cloud-store.ts');
      const calls: Array<{ path: string; args: any }> = [];
      const client: any = {
        call: async (_kind: string, path: string, args: any) => {
          calls.push({ path, args });
          if (path === 'kv:hydrate') {
            return [
              { key: 'ls:lt-persistent-records-G', size: 2, updatedAt: 1, blob: false, value: '[{"nid":"a","value":1}]' },
              { key: 'save:G-0.meta', size: 2, updatedAt: 1, blob: false, value: '{"kind":"battle"}' },
              { key: 'save:G-0', size: 999999, updatedAt: 1, blob: false },
            ];
          }
          if (path === 'kv:get') return { value: '{"units":[1,2]}' };
          await new Promise((r) => setTimeout(r, 20));
          return { updatedAt: Date.now() };
        },
        fetchSite: async () => { throw new Error('unexpected'); },
      };
      localStorage.clear();
      const store = new CloudStore(client, 'user-a');
      await store.hydrate();
      const sync = store.syncStore();
      const saves = store.saveStore();
      const hydratedRecords = sync.getItem('lt-persistent-records-G');

      sync.setItem('lt-persistent-records-G', 'v1');
      sync.setItem('lt-persistent-records-G', 'v2');
      sync.setItem('lt-persistent-records-G', 'v3');
      const readYourWrite = sync.getItem('lt-persistent-records-G');

      await saves.set('G-1', { slot: 1 });
      const savedAfterAwait = calls.some((c) => c.path === 'kv:setInline' && c.args.key === 'save:G-1');
      const lazy = await saves.get('G-0');
      const a = await saves.get('G-1');
      a.slot = 99;
      const b = await saves.get('G-1');
      await new Promise((r) => setTimeout(r, 700));
      const recordWrites = calls.filter((c) => c.path === 'kv:setInline' && c.args.key === 'ls:lt-persistent-records-G');
      await saves.delete('G-0');
      return {
        hydratedRecords,
        readYourWrite,
        savedAfterAwait,
        lazy,
        freshCopy: b.slot,
        recordWrites: recordWrites.map((c) => c.args.value),
        keys: await saves.keys(),
        removed: calls.some((c) => c.path === 'kv:remove' && c.args.key === 'save:G-0'),
        pending: store.hasPendingWrites(),
      };
    });
    expect(result.hydratedRecords).toBe('[{"nid":"a","value":1}]');
    expect(result.readYourWrite).toBe('v3');
    expect(result.savedAfterAwait).toBe(true);
    expect(result.lazy).toEqual({ units: [1, 2] });
    expect(result.freshCopy).toBe(1);
    // Debounced latest-wins: only the final value is sent.
    expect(result.recordWrites).toEqual(['v3']);
    expect(result.keys.sort()).toEqual(['G-0.meta', 'G-1']);
    expect(result.removed).toBe(true);
    expect(result.pending).toBe(false);
  });

  test('failures surface in status, reject awaited saves, keep retrying, and survive in the outbox', async ({ page }) => {
    test.slow();
    await openShell(page);
    const result = await page.evaluate(async () => {
      const { CloudStore } = await import('/src/storage/cloud-store.ts');
      const { CloudError } = await import('/src/storage/cloud-client.ts');
      localStorage.clear();
      let failuresLeft = 3;
      const sent: string[] = [];
      const client: any = {
        call: async (_kind: string, path: string, args: any) => {
          if (path === 'kv:hydrate') return [];
          if (args.key.startsWith('save:') && failuresLeft > 0) {
            failuresLeft--;
            throw new CloudError('Network error: offline', true);
          }
          sent.push(`${args.key}=${args.value}`);
          return { updatedAt: 1 };
        },
        fetchSite: async () => { throw new Error('unexpected'); },
      };
      const store = new CloudStore(client, 'user-b');
      await store.hydrate();
      const states: string[] = [];
      store.onStatus((s) => states.push(s.state));
      store.syncStore().setItem('lt-achievements-G', '[1]');
      const outboxWhilePending = localStorage.getItem('lt-web.cloudOutbox.v1:user-b');
      let rejected: string | null = null;
      const save = store.saveStore().set('G-2', { hp: 3 }).catch((err: Error) => { rejected = err.message; });
      await save;
      // The awaited write rejected after 3 failures but is still queued...
      const stillPending = store.hasPendingWrites();
      // ...and lands once the network is back.
      for (let i = 0; i < 100 && store.hasPendingWrites(); i++) await new Promise((r) => setTimeout(r, 100));
      return {
        outboxWhilePending,
        rejected,
        stillPending,
        sawError: states.includes('error'),
        finalState: store.status().state,
        sent,
        outboxAfter: localStorage.getItem('lt-web.cloudOutbox.v1:user-b'),
      };
    });
    expect(JSON.parse(result.outboxWhilePending ?? '{}')).toEqual({ 'ls:lt-achievements-G': '[1]' });
    expect(result.rejected).toContain('offline');
    expect(result.stillPending).toBe(true);
    expect(result.sawError).toBe(true);
    expect(result.finalState).toBe('idle');
    expect(result.sent.sort()).toEqual(['ls:lt-achievements-G=[1]', 'save:G-2={"hp":3}']);
    expect(result.outboxAfter).toBeNull();
  });

  test('outbox replays on the next boot and large values use the gzip blob route', async ({ page }) => {
    await openShell(page);
    const result = await page.evaluate(async () => {
      const { CloudStore } = await import('/src/storage/cloud-store.ts');
      localStorage.clear();
      localStorage.setItem('lt-web.cloudOutbox.v1:user-c', JSON.stringify({ 'ls:lt-persistent-records-G': '[9]' }));
      const sent: string[] = [];
      let blobBody: Blob | null = null;
      let blobQuery = '';
      const client: any = {
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
      const store = new CloudStore(client, 'user-c');
      await store.hydrate();
      const replayed = store.syncStore().getItem('lt-persistent-records-G');
      const big = { rows: Array.from({ length: 30000 }, (_, i) => `row-${i}`) };
      await store.saveStore().set('G-big', big);
      // A fresh store hydrating the blob entry reads it back through GET.
      const reader = new CloudStore({
        ...client,
        call: async (_k: string, path: string) =>
          path === 'kv:hydrate' ? [{ key: 'save:G-big', size: 1, updatedAt: 3, blob: true }] : null,
      }, 'user-d');
      await reader.hydrate();
      const back = await reader.saveStore().get('G-big');
      for (let i = 0; i < 50 && store.hasPendingWrites(); i++) await new Promise((r) => setTimeout(r, 50));
      return {
        replayed,
        sent,
        blobQuery,
        compressed: (blobBody as Blob | null)?.size ?? 0,
        raw: JSON.stringify(big).length,
        roundTrip: back?.rows?.length === 30000 && back.rows[29999] === 'row-29999',
      };
    });
    expect(result.replayed).toBe('[9]');
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
