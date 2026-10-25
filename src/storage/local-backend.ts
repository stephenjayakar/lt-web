// Local (on-device) storage backend: IndexedDB `lt-web-saves` with a
// localStorage fallback for saves, and plain localStorage for the synchronous
// records/achievements store. Used by the Playwright harness, `?storage=local`,
// builds without VITE_CONVEX_URL, and as the source for the one-time cloud
// migration. Behavior is unchanged from the original save.ts helpers.

import type { AsyncKV, SyncKV } from './storage';

const DB_NAME = 'lt-web-saves';
const STORE_NAME = 'saves';
const DB_VERSION = 1;

/** Cached database connection. */
let _dbInstance: IDBDatabase | null = null;

async function openDB(): Promise<IDBDatabase> {
  if (_dbInstance) return _dbInstance;

  return new Promise<IDBDatabase>((resolve, reject) => {
    try {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME);
        }
      };

      request.onsuccess = () => {
        _dbInstance = request.result;
        // Clear cached handle if the connection closes unexpectedly
        _dbInstance.onclose = () => { _dbInstance = null; };
        _dbInstance.onversionchange = () => {
          _dbInstance?.close();
          _dbInstance = null;
        };
        resolve(_dbInstance);
      };

      request.onerror = () => {
        console.warn('IndexedDB open failed:', request.error);
        reject(request.error);
      };
    } catch (err) {
      console.warn('IndexedDB not available:', err);
      reject(err);
    }
  });
}

async function idbGet(key: string): Promise<any> {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const request = store.get(key);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } catch (err) {
    console.warn(`idbGet("${key}") failed, trying localStorage fallback:`, err);
    return localStorageGet(key);
  }
}

async function idbSet(key: string, value: any): Promise<void> {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const request = store.put(value, key);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  } catch (err) {
    console.warn(`idbSet("${key}") failed, trying localStorage fallback:`, err);
    localStorageSet(key, value);
  }
}

async function idbDelete(key: string): Promise<void> {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const request = store.delete(key);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  } catch (err) {
    console.warn(`idbDelete("${key}") failed, trying localStorage fallback:`, err);
    localStorageDelete(key);
  }
}

async function idbKeys(): Promise<string[]> {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const request = store.getAllKeys();
      request.onsuccess = () => resolve(request.result as string[]);
      request.onerror = () => reject(request.error);
    });
  } catch (err) {
    console.warn('idbKeys() failed, trying localStorage fallback:', err);
    return localStorageKeys();
  }
}

// ============================================================================
// localStorage Fallback
// ============================================================================

const LS_PREFIX = 'lt-save:';

function localStorageGet(key: string): any {
  try {
    const raw = localStorage.getItem(LS_PREFIX + key);
    return raw ? JSON.parse(raw) : undefined;
  } catch {
    return undefined;
  }
}

function localStorageSet(key: string, value: any): void {
  try {
    localStorage.setItem(LS_PREFIX + key, JSON.stringify(value));
  } catch {
    console.warn('localStorage save failed (quota exceeded?)');
  }
}

function localStorageDelete(key: string): void {
  try {
    localStorage.removeItem(LS_PREFIX + key);
  } catch {
    // ignore
  }
}

function localStorageKeys(): string[] {
  const keys: string[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(LS_PREFIX)) {
        keys.push(k.slice(LS_PREFIX.length));
      }
    }
  } catch {
    // ignore
  }
  return keys;
}

/** Save-slot store backed by IndexedDB (localStorage fallback). */
export const localSaveStore: AsyncKV = {
  get: idbGet,
  set: idbSet,
  delete: idbDelete,
  keys: idbKeys,
};

/** Every locally stored save key, from IndexedDB and the localStorage fallback. */
export async function allLocalSaveKeys(): Promise<string[]> {
  const keys = new Set<string>(localStorageKeys());
  try {
    for (const key of await idbKeys()) keys.add(key);
  } catch {
    // IndexedDB unavailable
  }
  return [...keys];
}

/** Read a local save value, preferring IndexedDB, then the localStorage fallback. */
export async function readLocalSave(key: string): Promise<unknown> {
  const fromIdb = await idbGet(key).catch(() => undefined);
  return fromIdb !== undefined ? fromIdb : localStorageGet(key);
}

/** Synchronous key/value store backed directly by localStorage. */
export const localSyncStore: SyncKV = {
  getItem(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  setItem(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {
      // localStorage may be unavailable (private mode, quota exceeded)
    }
  },
  removeItem(key) {
    try {
      localStorage.removeItem(key);
    } catch {
      // ignore
    }
  },
};
