// Local-first persistence with best-effort Convex sync.
//
// The device is the source of truth for play: every save, suspend and
// record write lands in the local stores (IndexedDB `lt-web-saves`,
// localStorage for the sync store) and resolves as soon as that local write
// has finished. Nothing the game awaits ever waits on the network. Convex is a
// background mirror that keeps devices in step:
//
// - Each local write marks its key dirty in a small sync journal in
//   localStorage (`lt-web.cloudSync.v1`): `localAt` (device clock), `cloudAt`
//   (the cloud `updatedAt` this device last pushed or pulled) and `dirty`.
//   The journal survives reloads, so unsynced writes from an offline session
//   upload on a later visit.
// - A single background loop first reconciles with the cloud (one `kv:hydrate`
//   query), then pushes dirty keys one at a time, latest local value wins.
//   Requests time out (cloud-client.ts), failures back off up to 30 s, the
//   loop pauses while the browser is offline and resumes on `online`. It never
//   throws into the game.
//
// Conflict rule (per key, see `decide`):
// - clean key, cloud moved past `cloudAt`     -> pull the cloud copy;
// - clean key, cloud row gone after a sync    -> it was deleted elsewhere, drop it;
// - dirty key, cloud unchanged since `cloudAt` -> push;
// - dirty key, cloud also changed             -> newest timestamp wins
//   (`localAt` vs cloud `updatedAt`; ties keep the local copy);
// - no journal entry (data from before local-first sync): the cloud copy wins
//   when one exists, since it was the source of truth until now. A local-only
//   save key is pushed on a device that never uploaded its local saves, and
//   dropped on one that did (the cloud deleted it, e.g. a resumed suspend);
//   a local-only sync-store key (records, settings) is pushed.
//
// Keys are namespaced in Convex: `save:<key>` for save.ts slots (JSON of the
// save dict) and `ls:<key>` for the synchronous store.

import type { CloudClient } from './cloud-client';
import { CloudError } from './cloud-client';
import { localSaveStore, localSyncStore } from './local-backend';
import type { AsyncKV, SyncKV } from './storage';

const MAX_INLINE_BYTES = 256 * 1024; // must match convex/kv.ts
const SYNC_DEBOUNCE_MS = 400;
const MAX_BACKOFF_MS = 30_000;
const JOURNAL_KEY = 'lt-web.cloudSync.v1';

export const SAVE_PREFIX = 'save:';
export const SYNC_PREFIX = 'ls:';

/** localStorage keys of the synchronous store that belong in the cloud. */
export const SYNC_KEY_PATTERN = /^(lt-persistent-records-|lt-achievements-|lt-web-settings$|_music_title_screen$)/;

export const migratedFlagKey = (userId: string) => `lt-web.cloudMigrated.v1:${userId}`;
const legacyOutboxKey = (userId: string) => `lt-web.cloudOutbox.v1:${userId}`;

export type CloudSyncState = 'idle' | 'syncing' | 'error' | 'offline' | 'signed-out';

export interface CloudStatus {
  state: CloudSyncState;
  /** Local changes not yet in the cloud. */
  pending: number;
  message: string | null;
}

/** One key's sync journal entry. */
export interface SyncEntry {
  /** Device time of the latest local write. */
  localAt?: number;
  /** Cloud `updatedAt` this device last pushed or pulled. */
  cloudAt?: number;
  /** A local write has not reached the cloud yet. */
  dirty?: boolean;
  /** The pending local write is a delete. */
  deleted?: boolean;
}

interface Journal {
  userId: string | null;
  entries: Record<string, SyncEntry>;
}

export interface CloudRow {
  key: string;
  size: number;
  updatedAt: number;
  blob: boolean;
  value?: string;
}

export type SyncAction = 'pull' | 'push' | 'drop-local' | 'none';

/** The conflict rule for one key (documented at the top of this file). */
export function decide(
  entry: SyncEntry | undefined,
  row: { updatedAt: number } | undefined,
  hasLocal: boolean,
  opts: { isSave: boolean; legacyMigrated: boolean },
): SyncAction {
  if (entry?.dirty) {
    if (row && row.updatedAt > (entry.cloudAt ?? 0) && row.updatedAt > (entry.localAt ?? 0)) return 'pull';
    if (entry.deleted && !row) return 'none';
    return 'push';
  }
  if (entry?.cloudAt !== undefined) {
    if (!row) return hasLocal ? 'drop-local' : 'none';
    return row.updatedAt > entry.cloudAt ? 'pull' : 'none';
  }
  // No journal: data from before local-first sync.
  if (row) return 'pull';
  if (!hasLocal) return 'none';
  if (!opts.isSave) return 'push';
  return opts.legacyMigrated ? 'drop-local' : 'push';
}

const encoder = new TextEncoder();
const byteLength = (s: string) => encoder.encode(s).length;
const isOnline = () => typeof navigator === 'undefined' || navigator.onLine !== false;

async function gzip(text: string): Promise<Blob> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  return await new Response(stream).blob();
}

async function gunzip(blob: Blob): Promise<string> {
  const stream = blob.stream().pipeThrough(new DecompressionStream('gzip'));
  return await new Response(stream).text();
}

function localStorageKeys(): string[] {
  const keys: string[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key) keys.push(key);
    }
  } catch {
    // unavailable
  }
  return keys;
}

export interface CloudStoreOptions {
  /** Local save store (default: IndexedDB `lt-web-saves`). */
  localSave?: AsyncKV;
  /** Local sync store (default: localStorage). */
  localSync?: SyncKV;
  /** Sync-store keys present locally (default: localStorage keys matching SYNC_KEY_PATTERN). */
  localSyncKeys?: () => string[];
}

export class CloudStore {
  readonly client: CloudClient | null;
  userId: string | null;
  private readonly localSave: AsyncKV;
  private readonly localSync: SyncKV;
  private readonly localSyncKeys: () => string[];
  private journal: Journal;
  /** Per-key local write counter: a push or pull only settles if no newer local write happened. */
  private gens = new Map<string, number>();
  /** Values whose local write failed (quota): still readable and uploaded this session. */
  private saveOverlay = new Map<string, unknown>();
  private syncOverlay = new Map<string, string | null>();
  private reconciled = false;
  private running = false;
  private stopped = false;
  private signedOutMessage: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private wake: (() => void) | null = null;
  private failures = 0;
  private lastError: string | null = null;
  private reconcileWaiters: Array<() => void> = [];
  private statusListeners = new Set<(s: CloudStatus) => void>();
  private authLostListeners = new Set<(message: string) => void>();
  private remoteChangeListeners = new Set<(key: string) => void>();
  private listening = false;

  /**
   * `client`/`userId` null: signed out. Writes stay local but are still
   * journaled, so they upload after a later sign-in.
   */
  constructor(client: CloudClient | null, userId: string | null, opts: CloudStoreOptions = {}) {
    this.client = client;
    this.userId = client ? userId : null;
    this.localSave = opts.localSave ?? localSaveStore;
    this.localSync = opts.localSync ?? localSyncStore;
    this.localSyncKeys = opts.localSyncKeys
      ?? (() => localStorageKeys().filter((key) => SYNC_KEY_PATTERN.test(key)));
    this.journal = this.loadJournal();
    if (!this.client || !this.userId) this.signedOutMessage = 'Not signed in';
  }

  // ---- lifecycle ----------------------------------------------------------

  /** Replay a pre-local-first outbox and start syncing in the background. */
  async start(): Promise<void> {
    await this.replayLegacyOutbox();
    if (!this.listening && typeof window !== 'undefined') {
      this.listening = true;
      window.addEventListener('online', () => this.flushNow());
      window.addEventListener('offline', () => this.emit());
    }
    this.schedule(0);
  }

  /** Stop syncing (signed out / account refused). Local play continues. */
  detach(message: string): void {
    this.stopped = true;
    this.signedOutMessage = message;
    this.wake?.();
    this.emit();
    for (const l of this.authLostListeners) l(message);
  }

  onAuthLost(listener: (message: string) => void): void {
    this.authLostListeners.add(listener);
  }

  /** Called with the sync-store key (unprefixed) when a cloud copy replaced or removed it locally. */
  onRemoteChange(listener: (key: string) => void): void {
    this.remoteChangeListeners.add(listener);
  }

  private notifyRemote(key: string): void {
    if (!key.startsWith(SYNC_PREFIX)) return;
    for (const l of this.remoteChangeListeners) {
      try {
        l(key.slice(SYNC_PREFIX.length));
      } catch (err) {
        console.warn('[cloud] remote change listener failed', err);
      }
    }
  }

  /** True once a reconcile with the cloud has completed this session. */
  isReconciled(): boolean {
    return this.reconciled;
  }

  /** Resolves after the first reconcile completes (never rejects; may never resolve offline). */
  whenReconciled(): Promise<void> {
    if (this.reconciled) return Promise.resolve();
    return new Promise((resolve) => this.reconcileWaiters.push(resolve));
  }

  // ---- status ---------------------------------------------------------------

  onStatus(listener: (s: CloudStatus) => void): () => void {
    this.statusListeners.add(listener);
    listener(this.status());
    return () => this.statusListeners.delete(listener);
  }

  status(): CloudStatus {
    const pending = this.pendingKeys().length;
    if (this.stopped || !this.client || !this.userId) {
      return { state: 'signed-out', pending, message: this.signedOutMessage };
    }
    if (!isOnline()) return { state: 'offline', pending, message: null };
    if (this.lastError) return { state: 'error', pending, message: this.lastError };
    if (pending > 0 || !this.reconciled) return { state: 'syncing', pending, message: null };
    return { state: 'idle', pending, message: null };
  }

  hasPendingWrites(): boolean {
    return this.pendingKeys().length > 0;
  }

  /** True when `key` (namespaced) is in the cloud with no local change pending. */
  isSynced(key: string): boolean {
    const entry = this.journal.entries[key];
    return !!entry && entry.cloudAt !== undefined && !entry.dirty;
  }

  /** The sync journal entry for a namespaced key (tests/diagnostics). */
  entry(key: string): SyncEntry | undefined {
    return this.journal.entries[key];
  }

  private pendingKeys(): string[] {
    return Object.keys(this.journal.entries).filter((k) => this.journal.entries[k].dirty);
  }

  private emit(): void {
    const s = this.status();
    for (const l of this.statusListeners) l(s);
  }

  // ---- journal ----------------------------------------------------------------

  private loadJournal(): Journal {
    try {
      const raw = JSON.parse(localStorage.getItem(JOURNAL_KEY) ?? 'null');
      if (raw && typeof raw === 'object' && raw.entries && typeof raw.entries === 'object') {
        return { userId: typeof raw.userId === 'string' ? raw.userId : null, entries: raw.entries };
      }
    } catch {
      // corrupt: start over (the conflict rule then defers to the cloud)
    }
    return { userId: null, entries: {} };
  }

  private saveJournal(): void {
    try {
      localStorage.setItem(JOURNAL_KEY, JSON.stringify(this.journal));
    } catch {
      // quota: the in-memory journal still drives this session
    }
  }

  private gen(key: string): number {
    return this.gens.get(key) ?? 0;
  }

  /** Record a local write to `key` and schedule its upload. */
  private touch(key: string, deleted: boolean, debounce: boolean): void {
    this.gens.set(key, this.gen(key) + 1);
    const prev = this.journal.entries[key] ?? {};
    this.journal.entries[key] = { ...prev, localAt: Date.now(), dirty: true, deleted };
    this.saveJournal();
    this.emit();
    this.schedule(debounce ? SYNC_DEBOUNCE_MS : 0);
  }

  // ---- local access -------------------------------------------------------------

  private async localSaveKeys(): Promise<string[]> {
    const keys = new Set(await this.localSave.keys().catch(() => [] as string[]));
    for (const key of this.saveOverlay.keys()) keys.add(key);
    return [...keys];
  }

  private async getLocalSave(key: string): Promise<unknown> {
    if (this.saveOverlay.has(key)) return structuredClone(this.saveOverlay.get(key));
    return await this.localSave.get(key);
  }

  private getLocalSync(key: string): string | null {
    if (this.syncOverlay.has(key)) return this.syncOverlay.get(key) ?? null;
    return this.localSync.getItem(key);
  }

  private setLocalSync(key: string, value: string | null): void {
    if (value === null) this.localSync.removeItem(key);
    else this.localSync.setItem(key, value);
    if (this.localSync.getItem(key) === value) this.syncOverlay.delete(key);
    else this.syncOverlay.set(key, value);
  }

  private async setLocalSave(key: string, value: unknown): Promise<void> {
    try {
      await this.localSave.set(key, value);
      this.saveOverlay.delete(key);
    } catch (err) {
      console.warn(`[saves] local write of "${key}" failed; keeping it in memory`, err);
      this.saveOverlay.set(key, structuredClone(value));
    }
  }

  private async deleteLocalSave(key: string): Promise<void> {
    this.saveOverlay.delete(key);
    await this.localSave.delete(key).catch((err) => console.warn(`[saves] local delete of "${key}" failed`, err));
  }

  /** The local value as the cloud stores it: string, null (deleted), or undefined (nothing to send). */
  private async localPayload(key: string): Promise<string | null | undefined> {
    const deleted = !!this.journal.entries[key]?.deleted;
    if (key.startsWith(SAVE_PREFIX)) {
      const value = await this.getLocalSave(key.slice(SAVE_PREFIX.length));
      if (value === undefined) return deleted ? null : undefined;
      return JSON.stringify(value);
    }
    const value = this.getLocalSync(key.slice(SYNC_PREFIX.length));
    if (value === null) return deleted ? null : undefined;
    return value;
  }

  private async applyLocal(key: string, payload: string | null): Promise<void> {
    if (key.startsWith(SAVE_PREFIX)) {
      const k = key.slice(SAVE_PREFIX.length);
      if (payload === null) await this.deleteLocalSave(k);
      else await this.setLocalSave(k, JSON.parse(payload));
    } else {
      this.setLocalSync(key.slice(SYNC_PREFIX.length), payload);
    }
  }

  // ---- adapters ---------------------------------------------------------------

  saveStore(): AsyncKV {
    return {
      get: async (key) => await this.getLocalSave(key),
      set: async (key, value) => {
        await this.setLocalSave(key, value);
        this.touch(SAVE_PREFIX + key, false, false);
      },
      delete: async (key) => {
        const known = (await this.localSaveKeys()).includes(key) || !!this.journal.entries[SAVE_PREFIX + key];
        await this.deleteLocalSave(key);
        if (known) this.touch(SAVE_PREFIX + key, true, false);
      },
      keys: async () => await this.localSaveKeys(),
    };
  }

  syncStore(): SyncKV {
    return {
      getItem: (key) => this.getLocalSync(key),
      setItem: (key, value) => {
        if (this.getLocalSync(key) === value) return;
        this.setLocalSync(key, value);
        this.touch(SYNC_PREFIX + key, false, true);
      },
      removeItem: (key) => {
        if (this.getLocalSync(key) === null && !this.journal.entries[SYNC_PREFIX + key]) return;
        this.setLocalSync(key, null);
        this.touch(SYNC_PREFIX + key, true, true);
      },
    };
  }

  // ---- background sync loop -----------------------------------------------------

  /** Push pending changes now (page hide, back online). */
  flushNow(): void {
    this.wake?.();
    this.schedule(0);
  }

  private active(): boolean {
    return !this.stopped && !!this.client && !!this.userId;
  }

  private schedule(delay: number): void {
    if (!this.active()) return;
    if (this.running) return;
    if (this.timer !== null) {
      if (delay > 0) return; // an earlier timer will fire anyway
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.run();
    }, delay);
  }

  private backoff(): Promise<void> {
    const ms = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.min(this.failures - 1, 5));
    return new Promise<void>((resolve) => {
      const t = setTimeout(done, ms);
      function done() {
        clearTimeout(t);
        resolve();
      }
      this.wake = done;
    }).finally(() => {
      this.wake = null;
    });
  }

  private async run(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.emit();
    try {
      while (this.active()) {
        if (!isOnline()) break; // resumes on the `online` event
        try {
          if (!this.reconciled) {
            await this.reconcile();
          } else {
            const key = this.pendingKeys()[0];
            if (key === undefined) break;
            await this.push(key);
          }
          this.failures = 0;
          this.lastError = null;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (this.client && (!this.client.hasSession() || (err instanceof CloudError && !err.network
            && /signed out|not allowed|unauthenticated/i.test(message)))) {
            console.warn('[cloud] sync stopped:', message);
            this.detach(message);
            break;
          }
          this.failures++;
          this.lastError = message;
          console.warn(`[cloud] sync failed (attempt ${this.failures}): ${message}`);
          this.rotateFailedKey();
          this.emit();
          await this.backoff();
        }
        this.emit();
      }
    } finally {
      this.running = false;
      this.emit();
    }
  }

  /** Move the head pending key to the back so one bad key can't starve the rest. */
  private rotateFailedKey(): void {
    if (!this.reconciled) return;
    const key = this.pendingKeys()[0];
    if (key === undefined) return;
    const entry = this.journal.entries[key];
    delete this.journal.entries[key];
    this.journal.entries[key] = entry;
  }

  /** Compare the cloud with the journal and pull, drop, or queue each key. */
  async reconcile(): Promise<void> {
    if (!this.client || !this.userId) return;
    const rows: CloudRow[] = await this.client.call('query', 'kv:hydrate', {});
    if (this.journal.userId !== this.userId) {
      // Another account (or none) synced this device: no cloud base applies.
      for (const entry of Object.values(this.journal.entries)) delete entry.cloudAt;
      this.journal.userId = this.userId;
      this.saveJournal();
    }
    let legacyMigrated = false;
    try {
      legacyMigrated = !!localStorage.getItem(migratedFlagKey(this.userId));
    } catch {
      // ignore
    }
    const cloud = new Map(rows.map((r) => [r.key, r]));
    const local = new Set<string>([
      ...(await this.localSaveKeys()).map((k) => SAVE_PREFIX + k),
      ...this.localSyncKeys().map((k) => SYNC_PREFIX + k),
      ...[...this.syncOverlay].filter(([, v]) => v !== null).map(([k]) => SYNC_PREFIX + k),
    ]);
    const all = new Set([...cloud.keys(), ...local, ...Object.keys(this.journal.entries)]);
    for (const key of all) {
      const isSave = key.startsWith(SAVE_PREFIX);
      if (!isSave && !key.startsWith(SYNC_PREFIX)) continue;
      const row = cloud.get(key);
      const entry = this.journal.entries[key];
      const hasLocal = local.has(key) || (!isSave && this.getLocalSync(key.slice(SYNC_PREFIX.length)) !== null);
      const action = decide(entry, row, hasLocal, { isSave, legacyMigrated });
      if (action === 'pull' && row) {
        if (entry?.dirty) console.info(`[cloud] "${key}": the cloud copy is newer; it replaces this device's copy`);
        await this.pull(key, row);
      } else if (action === 'drop-local') {
        console.info(`[cloud] "${key}" was deleted in the cloud; removing the local copy`);
        const gen = this.gen(key);
        await this.applyLocal(key, null);
        if (this.gen(key) === gen) delete this.journal.entries[key];
        this.notifyRemote(key);
      } else if (action === 'push') {
        this.journal.entries[key] = { ...entry, localAt: entry?.localAt ?? Date.now(), dirty: true };
      } else if (!row && entry && !entry.dirty) {
        delete this.journal.entries[key];
      } else if (!row && entry?.dirty && entry.deleted) {
        delete this.journal.entries[key]; // deleted here, never reached the cloud
      }
    }
    this.saveJournal();
    try {
      localStorage.setItem(migratedFlagKey(this.userId), String(Date.now()));
    } catch {
      // ignore
    }
    this.reconciled = true;
    for (const resolve of this.reconcileWaiters.splice(0)) resolve();
    this.emit();
  }

  private async pull(key: string, row: CloudRow): Promise<void> {
    const gen = this.gen(key);
    const payload = row.value ?? await this.fetchCloud(key, row.blob);
    if (this.gen(key) !== gen) return; // written locally meanwhile: that write is newer
    if (payload === undefined) return; // vanished; the next reconcile sorts it out
    await this.applyLocal(key, payload);
    if (this.gen(key) !== gen) return;
    this.journal.entries[key] = { localAt: row.updatedAt, cloudAt: row.updatedAt, dirty: false };
    this.saveJournal();
    this.notifyRemote(key);
  }

  private async push(key: string): Promise<void> {
    const gen = this.gen(key);
    const payload = await this.localPayload(key);
    let cloudAt: number | undefined;
    if (payload === undefined) {
      console.warn(`[cloud] "${key}" has no local value to upload; skipping`);
    } else {
      cloudAt = await this.send(key, payload);
    }
    const entry = this.journal.entries[key];
    if (!entry) return;
    if (this.gen(key) !== gen) {
      // A newer local write arrived during the upload; it stays dirty.
      if (cloudAt !== undefined) entry.cloudAt = cloudAt;
    } else if (payload === null || payload === undefined) {
      delete this.journal.entries[key];
    } else {
      this.journal.entries[key] = { localAt: entry.localAt, cloudAt, dirty: false };
    }
    this.saveJournal();
  }

  /** Cloud payload for `key` (inline rows too large for hydrate, or blobs). */
  private async fetchCloud(key: string, blob: boolean): Promise<string | undefined> {
    const client = this.client!;
    if (!blob) {
      const row = await client.call('query', 'kv:get', { key });
      if (row?.blob) return await this.fetchCloud(key, true);
      return row?.value ?? undefined;
    }
    const res = await client.fetchSite(`/kv/blob?key=${encodeURIComponent(key)}`);
    if (res.status === 404) return undefined;
    if (!res.ok) throw new CloudError(`Cloud read failed (${res.status}): ${await res.text()}`, res.status >= 500, res.status);
    const data = await res.blob();
    return res.headers.get('X-KV-Encoding') === 'gzip-json' ? await gunzip(data) : await data.text();
  }

  /** Upload one value; returns the cloud `updatedAt`. */
  private async send(key: string, payload: string | null): Promise<number> {
    const client = this.client!;
    if (payload === null) {
      await client.call('mutation', 'kv:remove', { key });
      return Date.now();
    }
    const size = byteLength(payload);
    if (size <= MAX_INLINE_BYTES) {
      const r = await client.call('mutation', 'kv:setInline', { key, value: payload });
      return Number(r?.updatedAt ?? Date.now());
    }
    const body = await gzip(payload);
    const qs = new URLSearchParams({ key, encoding: 'gzip-json', size: String(size) });
    const res = await client.fetchSite(`/kv/blob?${qs}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body,
    });
    if (!res.ok) {
      throw new CloudError(`Cloud upload failed (${res.status}): ${await res.text()}`, res.status >= 500, res.status);
    }
    const { updatedAt } = await res.json();
    return Number(updatedAt ?? Date.now());
  }

  // ---- migration from the cloud-first store ---------------------------------------

  /**
   * The old cloud-first store mirrored unsynced small writes to a per-user
   * outbox. Those are the newest values for their keys: apply them locally
   * and queue them.
   */
  private async replayLegacyOutbox(): Promise<void> {
    if (!this.userId) return;
    let box: Record<string, string | null> | null = null;
    try {
      box = JSON.parse(localStorage.getItem(legacyOutboxKey(this.userId)) ?? 'null');
    } catch {
      box = null;
    }
    if (!box) return;
    for (const [key, payload] of Object.entries(box)) {
      if (!key.startsWith(SAVE_PREFIX) && !key.startsWith(SYNC_PREFIX)) continue;
      console.info(`[cloud] replaying unsynced write for "${key}"`);
      try {
        await this.applyLocal(key, payload);
        this.touch(key, payload === null, false);
      } catch (err) {
        console.warn(`[cloud] could not replay "${key}"`, err);
      }
    }
    try {
      localStorage.removeItem(legacyOutboxKey(this.userId));
    } catch {
      // ignore
    }
  }
}
