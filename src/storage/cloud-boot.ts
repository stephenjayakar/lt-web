// Cloud boot: install the local-first stores and start background sync.
//
// Nothing here may hold the game hostage to the network:
// - A stored session is trusted offline (identity from the cached `me()` or
//   the JWT subject); the server check runs in the background.
// - The sign-in gate only appears when there is no session, the player has
//   not chosen to play without cloud saves, and Convex answers within
//   BOOT_PROBE_TIMEOUT_MS. It offers a "play without signing in" button.
// - With a session, boot waits at most BOOT_SYNC_BUDGET_MS for the first
//   reconcile so a fast connection still starts with the newest cloud copy;
//   after that the game boots from local data and sync continues behind it.

import { CloudClient } from './cloud-client';
import { CloudStore } from './cloud-store';
import { installAccountPill, removeCloudScreen, showCloudMessage, showSignIn } from './cloud-ui';
import { convexSiteUrl, installStores } from './storage';

/** Longest boot waits for the first cloud reconcile before using local data. */
export const BOOT_SYNC_BUDGET_MS = 2_500;
/** Timeout for the sign-in gate's reachability probe and the redirect exchange. */
export const BOOT_PROBE_TIMEOUT_MS = 4_000;
const LOCAL_CHOICE_KEY = 'lt-web.playLocal.v1';

let activeStore: CloudStore | null = null;

/** The active cloud store (null in local mode). */
export function getCloudStore(): CloudStore | null {
  return activeStore;
}

const isOnline = () => navigator.onLine !== false;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function choseLocal(): boolean {
  try {
    return localStorage.getItem(LOCAL_CHOICE_KEY) !== null;
  } catch {
    return false;
  }
}

function setChoseLocal(on: boolean): void {
  try {
    if (on) localStorage.setItem(LOCAL_CHOICE_KEY, String(Date.now()));
    else localStorage.removeItem(LOCAL_CHOICE_KEY);
  } catch {
    // ignore
  }
}

/**
 * Install the local-first stores, sign in if possible, and start syncing.
 * Resolves once the game may boot (never resolves while a Google redirect is
 * in progress). Always resolves true otherwise.
 */
export async function bootCloud(url: string): Promise<boolean> {
  const client = new CloudClient(url, convexSiteUrl(url));

  if (client.hasPendingRedirect()) {
    showCloudMessage('Signing in', 'Finishing Google sign-in…');
    await client.completeRedirect(BOOT_PROBE_TIMEOUT_MS * 2);
    if (client.hasSession()) setChoseLocal(false);
  }

  if (!client.hasSession() && !choseLocal() && isOnline()) {
    showCloudMessage('Signing in', 'Checking the cloud save server…');
    const env = await client.environment(BOOT_PROBE_TIMEOUT_MS);
    if (env) {
      const choice = await showSignIn({
        error: client.error,
        fakeLogin: env.fakeLogin,
        onGoogle: () => client.signInWithGoogle(),
        onFake: (email, secret) => client.signInFake(email, secret),
      });
      if (choice === 'local') setChoseLocal(true);
    } else {
      console.info('[cloud] save server unreachable; playing with on-device saves');
    }
  }

  const user = client.sessionUser();
  const store = new CloudStore(user ? client : null, user?.userId ?? null);
  installStores(store.saveStore(), store.syncStore());
  activeStore = store;

  const pill = installAccountPill({
    email: user?.email ?? null,
    signedIn: !!user,
    onSignIn: async () => {
      setChoseLocal(false);
      await client.signInWithGoogle();
    },
    onSignOut: async () => {
      // Unsynced changes stay on this device and upload after the next sign-in.
      store.detach('Signed out');
      await client.signOut();
      setChoseLocal(false);
      window.location.reload();
    },
  });
  store.onStatus(pill.update);
  // A newer cloud copy of records/achievements/settings can land after the
  // engine read them (slow first sync): reload the in-memory copies.
  store.onRemoteChange((key) => {
    void (async () => {
      const records = await import('../engine/records');
      if (records.reloadPersistentSystemsFor(key)) return;
      if (key === 'lt-web-settings') (await import('../engine/states/settings-state')).reloadStoredSettings();
    })().catch((err) => console.warn('[cloud] could not reload synced data', err));
  });
  store.onAuthLost((message) => {
    if (client.hasSession()) client.dropSession(message);
    pill.setSignedOut(message);
  });

  if (user) {
    await store.start();
    // Confirm the session in the background; refused accounts stop syncing.
    void client.me().then((me) => {
      if (me) pill.setEmail(me.email ?? 'owner');
      else store.detach('That Google account is not allowed to use these saves.');
    }).catch(() => {
      if (!client.hasSession()) store.detach('Signed out. Sign in with Google again.');
    });
    if (isOnline()) {
      showCloudMessage('Loading', 'Syncing cloud saves…');
      await Promise.race([store.whenReconciled(), sleep(BOOT_SYNC_BUDGET_MS)]);
      if (!store.isReconciled()) console.info('[cloud] cloud sync is slow; starting from on-device saves');
    }
  }

  const flush = () => store.flushNow();
  window.addEventListener('pagehide', flush);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush();
  });

  (window as any).__cloud = { store, client, me: user };
  removeCloudScreen();
  return true;
}
