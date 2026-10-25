/**
 * chunk-cache.ts — Persistent, content-addressed storage for downloaded pack
 * chunks, so the hosted game's assets (hundreds of MB) are fetched from
 * Convex once per browser rather than once per visit.
 *
 * Backed by Cache Storage under PACK_CACHE_NAME. public/sw.js deletes every
 * cache that is not its own on activation, except names starting with
 * "lt-packs" — keep that prefix if this name changes.
 */

export const PACK_CACHE_NAME = 'lt-packs-v1';
const KEY_PREFIX = 'https://lt-packs.invalid/chunk/';

export interface ChunkCache {
  get(hash: string): Promise<ArrayBuffer | null>;
  put(hash: string, data: ArrayBuffer): Promise<void>;
  delete(hash: string): Promise<void>;
  keys(): Promise<string[]>;
  /** True when entries survive a reload. */
  readonly persistent: boolean;
}

/** Non-persistent fallback (no Cache Storage, e.g. some private modes) and test double. */
export class MemoryChunkCache implements ChunkCache {
  readonly persistent: boolean = false;
  private map: Map<string, ArrayBuffer> = new Map();

  async get(hash: string): Promise<ArrayBuffer | null> {
    return this.map.get(hash) ?? null;
  }

  async put(hash: string, data: ArrayBuffer): Promise<void> {
    this.map.set(hash, data);
  }

  async delete(hash: string): Promise<void> {
    this.map.delete(hash);
  }

  async keys(): Promise<string[]> {
    return [...this.map.keys()];
  }
}

class CacheStorageChunkCache implements ChunkCache {
  readonly persistent: boolean = true;
  private cache: Cache;

  constructor(cache: Cache) {
    this.cache = cache;
  }

  async get(hash: string): Promise<ArrayBuffer | null> {
    try {
      const hit = await this.cache.match(KEY_PREFIX + hash);
      return hit ? await hit.arrayBuffer() : null;
    } catch {
      return null;
    }
  }

  async put(hash: string, data: ArrayBuffer): Promise<void> {
    try {
      await this.cache.put(KEY_PREFIX + hash, new Response(data, {
        headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(data.byteLength) },
      }));
    } catch (err) {
      // Quota exceeded or storage unavailable: the game still runs from memory.
      console.warn('[Packs] Could not cache chunk', hash.slice(0, 12), err);
    }
  }

  async delete(hash: string): Promise<void> {
    await this.cache.delete(KEY_PREFIX + hash).catch(() => false);
  }

  async keys(): Promise<string[]> {
    try {
      const requests = await this.cache.keys();
      return requests
        .map((r) => r.url)
        .filter((u) => u.startsWith(KEY_PREFIX))
        .map((u) => u.slice(KEY_PREFIX.length));
    } catch {
      return [];
    }
  }
}

/** The persistent chunk cache, or a memory cache when Cache Storage is unavailable. */
export async function openChunkCache(): Promise<ChunkCache> {
  if (typeof caches !== 'undefined') {
    try {
      return new CacheStorageChunkCache(await caches.open(PACK_CACHE_NAME));
    } catch {
      // fall through
    }
  }
  console.warn('[Packs] Cache Storage unavailable; game data will be downloaded again next visit');
  return new MemoryChunkCache();
}

/**
 * Ask the browser not to evict the pack cache under storage pressure.
 * Chrome and Safari decide silently; Firefox would prompt, so skip it there.
 */
export function requestPersistentPackStorage(): void {
  try {
    if (/Firefox\//.test(navigator.userAgent) || !navigator.storage?.persist) return;
    void navigator.storage.persisted()
      .then((already) => already || navigator.storage.persist())
      .catch(() => {});
  } catch {
    // ignore
  }
}
