// Cloud boot sequence: sign the owner in, hydrate saves/records from Convex,
// migrate any on-device data once, and install the cloud stores. The game
// must not boot until this resolves true.

import { CloudClient, CloudError } from './cloud-client';
import type { CloudUser } from './cloud-client';
import { CloudStore, SAVE_PREFIX, SYNC_PREFIX } from './cloud-store';
import { installAccountPill, removeCloudScreen, showCloudMessage, showSignIn } from './cloud-ui';
import { allLocalSaveKeys, localSyncStore, readLocalSave } from './local-backend';
import { convexSiteUrl, installStores } from './storage';

/** localStorage keys of the synchronous store that belong in the cloud. */
const SYNC_KEY_PATTERN = /^(lt-persistent-records-|lt-achievements-|_music_title_screen$)/;

let activeStore: CloudStore | null = null;

/** The active cloud store (null in local mode). */
export function getCloudStore(): CloudStore | null {
  return activeStore;
}

async function signedInUser(client: CloudClient): Promise<CloudUser> {
  for (;;) {
    if (client.hasSession()) {
      try {
        const me = await client.me();
        if (me) return me;
        client.dropSession('That Google account is not allowed to use these saves.');
      } catch (err) {
        if (err instanceof CloudError && err.network) {
          await new Promise<void>((resolve) =>
            showCloudMessage('Offline', `Can't reach the cloud save server (${err.message}).`, {
              label: 'Retry',
              run: () => resolve(),
            }),
          );
          continue;
        }
        client.dropSession(err instanceof Error ? err.message : String(err));
      }
    }
    const env = await client.environment();
    await showSignIn({
      error: client.error,
      fakeLogin: env.fakeLogin,
      onGoogle: () => client.signInWithGoogle(),
      onFake: (email, secret) => client.signInFake(email, secret),
    });
  }
}

/** Retry `task` until it succeeds, showing a blocking message between attempts. */
async function withRetryScreen<T>(title: string, task: () => Promise<T>): Promise<T> {
  for (;;) {
    try {
      return await task();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[cloud] ${title} failed:`, err);
      await new Promise<void>((resolve) =>
        showCloudMessage(title, `Failed: ${message}`, { label: 'Retry', run: () => resolve() }),
      );
    }
  }
}

/**
 * Upload on-device saves/records the cloud doesn't have yet. Runs once per
 * account per device; local data is left in place as a backup but is never
 * read again in cloud mode.
 */
async function migrateLocalData(store: CloudStore, userId: string): Promise<void> {
  const flag = `lt-web.cloudMigrated.v1:${userId}`;
  try {
    if (localStorage.getItem(flag)) return;
  } catch {
    return;
  }
  const uploads: Promise<void>[] = [];
  for (const key of await allLocalSaveKeys()) {
    if (store.has(SAVE_PREFIX + key)) continue;
    const value = await readLocalSave(key);
    if (value === undefined) continue;
    console.info(`[cloud] migrating local save "${key}"`);
    uploads.push(store.write(SAVE_PREFIX + key, JSON.stringify(value)));
  }
  const syncKeys: string[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && SYNC_KEY_PATTERN.test(key)) syncKeys.push(key);
    }
  } catch {
    // ignore
  }
  for (const key of syncKeys) {
    if (store.has(SYNC_PREFIX + key)) continue;
    const value = localSyncStore.getItem(key);
    if (value === null) continue;
    console.info(`[cloud] migrating local "${key}"`);
    uploads.push(store.write(SYNC_PREFIX + key, value));
  }
  if (uploads.length) showCloudMessage('Uploading', `Moving ${uploads.length} local save item(s) to the cloud…`);
  await Promise.all(uploads);
  localStorage.setItem(flag, String(Date.now()));
}

/**
 * Sign in, hydrate, migrate, and install the Convex-backed stores.
 * Resolves once the game may boot (never resolves while a Google redirect is
 * in progress).
 */
export async function bootCloud(url: string): Promise<boolean> {
  const client = new CloudClient(url, convexSiteUrl(url));
  showCloudMessage('Signing in', 'Checking your session…');
  await client.completeRedirect();
  const me = await signedInUser(client);

  showCloudMessage('Loading', 'Loading cloud saves…');
  const store = new CloudStore(client, me.userId);
  await withRetryScreen('Loading cloud saves', () => store.hydrate());
  await withRetryScreen('Uploading local saves', () => migrateLocalData(store, me.userId));
  installStores(store.saveStore(), store.syncStore());
  activeStore = store;

  const update = installAccountPill(me.email ?? 'owner', async () => {
    if (store.hasPendingWrites() && !confirm('Some progress has not reached the cloud yet. Sign out anyway?')) return;
    await client.signOut();
    window.location.reload();
  });
  store.onStatus(update);

  const flush = () => store.flushNow();
  window.addEventListener('pagehide', flush);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush();
  });
  window.addEventListener('beforeunload', (event) => {
    if (!store.hasPendingWrites()) return;
    store.flushNow();
    event.preventDefault();
    event.returnValue = '';
  });

  (window as any).__cloud = { store, client, me };
  removeCloudScreen();
  return true;
}
