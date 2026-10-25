// Convex-backed persistence with an in-memory cache.
//
// Keys are namespaced: `save:<key>` for save.ts slots (JSON of the save dict)
// and `ls:<key>` for the synchronous store (records/achievements strings).
//
// - hydrate(): one query lists every key; small values arrive inline, the
//   sync-store values are fetched eagerly, and large save blobs lazily on
//   first read. Reads are served from the cache afterwards.
// - Writes update the cache immediately (read-your-writes) and go through a
//   per-key latest-wins queue that sends one request at a time, in order.
//   Save writes are awaited (resolve once Convex has committed them); sync
//   store writes are debounced and fire-and-forget.
// - Failures retry forever with backoff, are reported through onStatus, and
//   small pending writes are mirrored to a localStorage outbox so a closed tab
//   doesn't lose them (replayed on the next boot). Leaving the page with
//   unsynced writes triggers a beforeunload warning.

import type { CloudClient } from './cloud-client';
import { CloudError } from './cloud-client';
import type { AsyncKV, SyncKV } from './storage';

const MAX_INLINE_BYTES = 256 * 1024; // must match convex/kv.ts
const OUTBOX_MAX_BYTES = 256 * 1024;
const SYNC_DEBOUNCE_MS = 400;
/** Awaited writes reject after this many failed attempts (they keep retrying). */
const AWAIT_ATTEMPTS = 3;

export const SAVE_PREFIX = 'save:';
export const SYNC_PREFIX = 'ls:';

export interface CloudStatus {
  state: 'idle' | 'syncing' | 'error';
  pending: number;
  message: string | null;
}

interface Entry {
  payload: string | undefined; // undefined = not loaded yet (blob or large inline)
  blob: boolean;
  size: number;
  updatedAt: number;
}

interface Pending {
  payload: string | null; // null = delete
  seq: number;
  attempts: number;
}

interface Waiter {
  seq: number;
  resolve: () => void;
  reject: (err: Error) => void;
}

const encoder = new TextEncoder();
const byteLength = (s: string) => encoder.encode(s).length;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function gzip(text: string): Promise<Blob> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  return await new Response(stream).blob();
}

async function gunzip(blob: Blob): Promise<string> {
  const stream = blob.stream().pipeThrough(new DecompressionStream('gzip'));
  return await new Response(stream).text();
}

export class CloudStore {
  readonly client: CloudClient;
  readonly userId: string;
  private cache = new Map<string, Entry>();
  private pending = new Map<string, Pending>();
  private waiters = new Map<string, Waiter[]>();
  private seq = 0;
  private pumping = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private failures = 0;
  private lastError: string | null = null;
  private readonly outboxKey: string;
  private statusListeners = new Set<(s: CloudStatus) => void>();

  constructor(client: CloudClient, userId: string) {
    this.client = client;
    this.userId = userId;
    this.outboxKey = `lt-web.cloudOutbox.v1:${userId}`;
  }

  // ---- status -------------------------------------------------------------

  onStatus(listener: (s: CloudStatus) => void): () => void {
    this.statusListeners.add(listener);
    listener(this.status());
    return () => this.statusListeners.delete(listener);
  }

  status(): CloudStatus {
    const pending = this.pending.size;
    if (this.lastError && pending > 0) return { state: 'error', pending, message: this.lastError };
    return { state: pending > 0 ? 'syncing' : 'idle', pending, message: null };
  }

  hasPendingWrites(): boolean {
    return this.pending.size > 0;
  }

  private emit(): void {
    const s = this.status();
    for (const l of this.statusListeners) l(s);
  }

  // ---- hydration ------------------------------------------------------------

  async hydrate(): Promise<void> {
    const rows: Array<{ key: string; size: number; updatedAt: number; blob: boolean; value?: string }> =
      await this.client.call('query', 'kv:hydrate', {});
    this.cache.clear();
    for (const r of rows) {
      this.cache.set(r.key, { payload: r.value ?? undefined, blob: r.blob, size: r.size, updatedAt: r.updatedAt });
    }
    // The sync store must be fully in memory before records initialize.
    await Promise.all(
      [...this.cache.keys()].filter((k) => k.startsWith(SYNC_PREFIX)).map((k) => this.read(k)),
    );
    this.replayOutbox();
  }

  has(key: string): boolean {
    return this.cache.has(key);
  }

  keys(prefix: string): string[] {
    return [...this.cache.keys()].filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length));
  }

  /** Cached payload without fetching (sync store). */
  peek(key: string): string | null {
    return this.cache.get(key)?.payload ?? null;
  }

  /** Payload for `key`, fetching it from Convex on first access. */
  async read(key: string): Promise<string | undefined> {
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    if (entry.payload !== undefined) return entry.payload;
    let payload: string | undefined;
    if (entry.blob) {
      const res = await this.client.fetchSite(`/kv/blob?key=${encodeURIComponent(key)}`);
      if (res.status === 404) payload = undefined;
      else if (!res.ok) throw new CloudError(`Cloud read failed (${res.status}): ${await res.text()}`, res.status >= 500, res.status);
      else {
        const blob = await res.blob();
        payload = res.headers.get('X-KV-Encoding') === 'gzip-json' ? await gunzip(blob) : await blob.text();
      }
    } else {
      const row = await this.client.call('query', 'kv:get', { key });
      payload = row?.value ?? undefined;
    }
    // Only fill the cache if no write replaced the entry meanwhile.
    const current = this.cache.get(key);
    if (current === entry) {
      if (payload === undefined) this.cache.delete(key);
      else entry.payload = payload;
    }
    return current === entry ? payload : this.cache.get(key)?.payload;
  }

  // ---- writes -----------------------------------------------------------------

  /**
   * Set (string) or delete (null) a key. Updates the cache now; the returned
   * promise settles when Convex has committed this write (or a newer one for
   * the same key), and rejects after AWAIT_ATTEMPTS failures while the write
   * keeps retrying in the background.
   */
  write(key: string, payload: string | null, opts: { debounce?: boolean } = {}): Promise<void> {
    if (payload === null) this.cache.delete(key);
    else this.cache.set(key, { payload, blob: false, size: byteLength(payload), updatedAt: Date.now() });
    const seq = ++this.seq;
    this.pending.set(key, { payload, seq, attempts: 0 });
    this.saveOutbox();
    const promise = new Promise<void>((resolve, reject) => {
      const list = this.waiters.get(key) ?? [];
      list.push({ seq, resolve, reject });
      this.waiters.set(key, list);
    });
    this.schedule(opts.debounce ? SYNC_DEBOUNCE_MS : 0);
    this.emit();
    return promise;
  }

  /** Send everything pending now (page hide / visibility change). */
  flushNow(): void {
    this.schedule(0);
  }

  private schedule(delay: number): void {
    if (this.pumping) return;
    if (this.timer !== null) {
      if (delay > 0) return; // an earlier timer will fire anyway
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.pump();
    }, delay);
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.pending.size > 0) {
        const [key, item] = this.pending.entries().next().value as [string, Pending];
        try {
          await this.send(key, item.payload);
          this.failures = 0;
          this.lastError = null;
          if (this.pending.get(key)?.seq === item.seq) {
            this.pending.delete(key);
            this.saveOutbox();
          }
          this.settle(key, item.seq, null);
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          item.attempts++;
          this.failures++;
          this.lastError = error.message;
          console.warn(`[cloud] write "${key}" failed (attempt ${item.attempts}):`, error.message);
          if (item.attempts >= AWAIT_ATTEMPTS) this.settle(key, item.seq, error);
          // Rotate this key to the back so one bad key can't starve the rest.
          if (this.pending.get(key) === item) {
            this.pending.delete(key);
            this.pending.set(key, item);
          }
          this.emit();
          await sleep(Math.min(30_000, 1000 * 2 ** Math.min(this.failures - 1, 5)));
        }
        this.emit();
      }
    } finally {
      this.pumping = false;
      this.emit();
    }
  }

  private settle(key: string, seq: number, error: Error | null): void {
    const list = this.waiters.get(key);
    if (!list) return;
    const remaining: Waiter[] = [];
    for (const w of list) {
      if (w.seq > seq) remaining.push(w);
      else if (error) w.reject(error);
      else w.resolve();
    }
    if (remaining.length) this.waiters.set(key, remaining);
    else this.waiters.delete(key);
  }

  private async send(key: string, payload: string | null, keepalive = false): Promise<void> {
    if (payload === null) {
      await this.client.call('mutation', 'kv:remove', { key }, keepalive);
      return;
    }
    const size = byteLength(payload);
    if (size <= MAX_INLINE_BYTES) {
      const r = await this.client.call('mutation', 'kv:setInline', { key, value: payload }, keepalive);
      const entry = this.cache.get(key);
      if (entry?.payload === payload) entry.updatedAt = r.updatedAt;
      return;
    }
    const body = await gzip(payload);
    const qs = new URLSearchParams({ key, encoding: 'gzip-json', size: String(size) });
    const res = await this.client.fetchSite(`/kv/blob?${qs}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body,
    });
    if (!res.ok) {
      throw new CloudError(`Cloud upload failed (${res.status}): ${await res.text()}`, res.status >= 500, res.status);
    }
    const { updatedAt } = await res.json();
    const entry = this.cache.get(key);
    if (entry?.payload === payload) {
      entry.blob = true;
      entry.updatedAt = updatedAt;
    }
  }

  // ---- outbox (small pending writes survive a closed tab) -----------------

  private saveOutbox(): void {
    const box: Record<string, string | null> = {};
    for (const [key, item] of this.pending) {
      if (item.payload === null || item.payload.length <= OUTBOX_MAX_BYTES) box[key] = item.payload;
    }
    try {
      if (Object.keys(box).length === 0) localStorage.removeItem(this.outboxKey);
      else localStorage.setItem(this.outboxKey, JSON.stringify(box));
    } catch {
      // quota: the beforeunload warning still covers it
    }
  }

  private replayOutbox(): void {
    let box: Record<string, string | null> | null = null;
    try {
      box = JSON.parse(localStorage.getItem(this.outboxKey) ?? 'null');
    } catch {
      box = null;
    }
    if (!box) return;
    for (const [key, payload] of Object.entries(box)) {
      console.info(`[cloud] replaying unsynced write for "${key}"`);
      void this.write(key, payload).catch(() => {});
    }
  }

  // ---- adapters ---------------------------------------------------------------

  saveStore(): AsyncKV {
    return {
      get: async (key) => {
        const payload = await this.read(SAVE_PREFIX + key);
        return payload === undefined ? undefined : JSON.parse(payload);
      },
      set: async (key, value) => {
        await this.write(SAVE_PREFIX + key, JSON.stringify(value));
      },
      delete: async (key) => {
        if (!this.cache.has(SAVE_PREFIX + key) && !this.pending.has(SAVE_PREFIX + key)) return;
        await this.write(SAVE_PREFIX + key, null);
      },
      keys: async () => this.keys(SAVE_PREFIX),
    };
  }

  syncStore(): SyncKV {
    return {
      getItem: (key) => this.peek(SYNC_PREFIX + key),
      setItem: (key, value) => {
        if (this.peek(SYNC_PREFIX + key) === value) return;
        this.write(SYNC_PREFIX + key, value, { debounce: true }).catch(() => {
          // surfaced through onStatus; keeps retrying
        });
      },
      removeItem: (key) => {
        if (!this.cache.has(SYNC_PREFIX + key)) return;
        this.write(SYNC_PREFIX + key, null, { debounce: true }).catch(() => {});
      },
    };
  }
}
