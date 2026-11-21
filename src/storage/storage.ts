// Persistence backend registry.
//
// Two stores back everything the engine persists:
// - the async save store (save slots, restart copies, suspend) used by
//   src/engine/save.ts;
// - the sync store (persistent records, achievements, small settings) used by
//   src/engine/records.ts, whose API is synchronous.
//
// In 'local' mode both are on-device (IndexedDB/localStorage). 'convex' mode
// is local-first too: the same on-device stores, wrapped so every write is
// journaled and mirrored to Convex in the background when signed in and
// online (src/storage/cloud-store.ts). Neither mode waits on the network.

import { localSaveStore, localSyncStore } from './local-backend';

export interface AsyncKV {
  get(key: string): Promise<any>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  keys(): Promise<string[]>;
}

export interface SyncKV {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export type StorageMode = 'local' | 'convex';

let saveStore: AsyncKV = localSaveStore;
let syncStore: SyncKV = localSyncStore;

export function getSaveStore(): AsyncKV {
  return saveStore;
}

export function getSyncStore(): SyncKV {
  return syncStore;
}

export function installStores(save: AsyncKV, sync: SyncKV): void {
  saveStore = save;
  syncStore = sync;
}

export function convexUrl(): string | null {
  // Dev server only: Playwright specs point cloud mode at a mocked origin
  // (tests/offline-saves.spec.ts). Production builds drop this branch.
  if (import.meta.env.DEV && typeof window !== 'undefined') {
    const testUrl = (window as { __ltTestConvexUrl?: unknown }).__ltTestConvexUrl;
    if (typeof testUrl === 'string' && testUrl) return testUrl.replace(/\/$/, '');
  }
  const url = (import.meta.env.VITE_CONVEX_URL as string | undefined)?.trim();
  return url ? url.replace(/\/$/, '') : null;
}

export function convexSiteUrl(url: string): string {
  const site = (import.meta.env.VITE_CONVEX_SITE_URL as string | undefined)?.trim();
  return site ? site.replace(/\/$/, '') : url.replace(/\.convex\.cloud$/, '.convex.site');
}

/**
 * Pick the backend for this page load.
 * - `?storage=local|convex` forces one.
 * - No VITE_CONVEX_URL: local.
 * - Test/automation contexts (`?harness=true`, `?control=true`, or a
 *   WebDriver-controlled browser such as Playwright): local, so the test
 *   suite never needs auth and never touches the owner's cloud saves.
 * - Otherwise: convex.
 */
export function resolveStorageMode(params: URLSearchParams): StorageMode {
  const forced = params.get('storage');
  if (forced === 'local') return 'local';
  if (!convexUrl()) return 'local';
  if (forced === 'convex') return 'convex';
  if (params.get('harness') === 'true' || params.get('control') === 'true' || params.has('qa')) return 'local';
  if (typeof navigator !== 'undefined' && navigator.webdriver) return 'local';
  return 'convex';
}
