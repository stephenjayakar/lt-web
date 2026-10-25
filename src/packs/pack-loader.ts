/**
 * pack-loader.ts — Download, verify, cache and unpack the hosted asset packs
 * into an AssetBundle (whose paths are relative to /game-data/).
 *
 * - boot packs load before the game starts (loadBoot), several at a time,
 *   with byte progress;
 * - background packs load after boot (startBackground); a request for one of
 *   their files waits for its pack (waitFor);
 * - demand packs load only when one of their files is first requested.
 *
 * Every chunk is looked up in the persistent ChunkCache by content hash
 * first; a downloaded chunk is verified (SHA-256) before it is cached or
 * used. A pack whose cached chunks fail to unpack is evicted and downloaded
 * once more.
 */

import { AssetBundle } from '../data/asset-bundle';
import type { ChunkCache } from './chunk-cache';
import { joinChunks, sha256Hex } from './manifest';
import type { PackChunkRef, PackInfo, PackManifest } from './manifest';

export interface PackProgress {
  /** Bytes of boot packs available so far (from cache or network) */
  loaded: number;
  total: number;
  /** Bytes fetched over the network this session */
  downloaded: number;
  packsDone: number;
  packsTotal: number;
}

/** An HTTP failure from the pack server; 401/403 mean sign-in or access trouble. */
export class PackHttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'PackHttpError';
    this.status = status;
  }
}

export interface PackLoaderOptions {
  manifest: PackManifest;
  /** Fetch one chunk's bytes by hash (adds auth). Non-2xx should throw PackHttpError. */
  fetchChunk: (hash: string) => Promise<ArrayBuffer>;
  cache: ChunkCache;
  bundle?: AssetBundle;
  /** Concurrent chunk downloads for boot packs */
  parallel?: number;
  onProgress?: (progress: PackProgress) => void;
  /** Retry delay base in ms (tests use 0) */
  retryDelayMs?: number;
}

const isAuthError = (err: unknown): boolean =>
  err instanceof PackHttpError && (err.status === 401 || err.status === 403);

export class PackLoader {
  readonly bundle: AssetBundle;
  readonly manifest: PackManifest;
  /** Bytes fetched over the network this session (0 when everything was cached) */
  downloadedBytes: number = 0;
  /** Bytes served from the persistent cache this session */
  cachedBytes: number = 0;

  private opts: PackLoaderOptions;
  private loads: Map<string, Promise<void>> = new Map();
  private loaded: Set<string> = new Set();
  private lazyFiles: Map<string, PackInfo> = new Map();
  private chunkFetches: Map<string, Promise<ArrayBuffer>> = new Map();

  constructor(opts: PackLoaderOptions) {
    this.opts = opts;
    this.manifest = opts.manifest;
    this.bundle = opts.bundle ?? new AssetBundle();
    for (const pack of opts.manifest.packs) {
      if (pack.load === 'boot') continue;
      for (const f of pack.files ?? []) this.lazyFiles.set(f, pack);
    }
  }

  /** Load every boot pack. Rejects on the first pack that cannot be loaded. */
  async loadBoot(): Promise<void> {
    const boot = this.manifest.packs.filter((p) => p.load === 'boot');
    const total = boot.reduce((n, p) => n + p.size, 0);
    let loaded = 0;
    let packsDone = 0;
    const report = () => this.opts.onProgress?.({
      loaded: Math.min(loaded, total), total, downloaded: this.downloadedBytes, packsDone, packsTotal: boot.length,
    });
    report();
    // Largest first so the long downloads overlap the many small ones.
    const queue = [...boot].sort((a, b) => b.size - a.size);
    const parallel = Math.max(1, this.opts.parallel ?? 6);
    let failure: unknown = null;
    const worker = async () => {
      while (queue.length && !failure) {
        const pack = queue.shift()!;
        try {
          await this.loadPack(pack, (n) => { loaded += n; report(); });
          packsDone++;
          report();
        } catch (err) {
          failure ??= err;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(parallel, boot.length) }, worker));
    if (failure) throw failure;
  }

  /**
   * Load background packs two at a time, then drop cached chunks the manifest
   * no longer names. Resolves when done; failures are logged, not thrown (the
   * game copes with missing optional assets).
   */
  async startBackground(): Promise<void> {
    const queue = this.manifest.packs.filter((p) => p.load === 'background');
    const worker = async () => {
      while (queue.length) {
        const pack = queue.shift()!;
        await this.loadPack(pack).catch((err) => console.warn(`[Packs] ${pack.name} failed to load`, err));
      }
    };
    await Promise.all([worker(), worker()]);
    await this.pruneCache();
  }

  /**
   * For a path (relative to /game-data/) the bundle lacks: a promise that
   * settles once the lazy pack holding it has loaded (starting a demand pack),
   * or null when no pack holds it.
   */
  waitFor(path: string): Promise<void> | null {
    const pack = this.lazyFiles.get(path);
    if (!pack || this.loaded.has(pack.name)) return null;
    return this.loadPack(pack);
  }

  isLoaded(name: string): boolean {
    return this.loaded.has(name);
  }

  /** Delete cached chunks that no pack in the manifest references. */
  async pruneCache(): Promise<number> {
    const keep = new Set(this.manifest.packs.flatMap((p) => p.chunks.map((c) => c.hash)));
    let removed = 0;
    for (const hash of await this.opts.cache.keys()) {
      if (keep.has(hash)) continue;
      await this.opts.cache.delete(hash);
      removed++;
    }
    return removed;
  }

  private loadPack(pack: PackInfo, onBytes?: (n: number) => void): Promise<void> {
    let pending = this.loads.get(pack.name);
    if (!pending) {
      pending = this.fetchAndUnpack(pack, onBytes).then(
        () => { this.loaded.add(pack.name); },
        (err) => {
          this.loads.delete(pack.name); // allow a later retry
          throw err;
        },
      );
      this.loads.set(pack.name, pending);
    }
    return pending;
  }

  private async fetchAndUnpack(pack: PackInfo, onBytes?: (n: number) => void): Promise<void> {
    const fromCache = { value: true };
    let parts = await Promise.all(pack.chunks.map((c) => this.getChunk(c, false, fromCache)));
    try {
      await this.unpack(pack, parts);
    } catch (err) {
      if (!fromCache.value) throw err;
      // A cached chunk was damaged in a way the size check missed: evict and refetch once.
      console.warn(`[Packs] cached ${pack.name} is unreadable; downloading it again`, err);
      for (const c of pack.chunks) await this.opts.cache.delete(c.hash);
      parts = await Promise.all(pack.chunks.map((c) => this.getChunk(c, true, fromCache)));
      await this.unpack(pack, parts);
    }
    onBytes?.(pack.size);
  }

  private async unpack(pack: PackInfo, parts: ArrayBuffer[]): Promise<void> {
    const buffer = joinChunks(parts.map((p) => new Uint8Array(p)));
    if (pack.chunks.length > 1 && await sha256Hex(buffer) !== pack.hash) {
      throw new Error(`Asset pack ${pack.name} does not match its hash`);
    }
    const count = await this.bundle.addZip(buffer);
    if (count !== pack.fileCount && pack.fileCount > 0) {
      throw new Error(`Asset pack ${pack.name}: ${count} files, expected ${pack.fileCount}`);
    }
  }

  /** One chunk: from the cache when present (size-checked), else downloaded and verified. */
  private async getChunk(ref: PackChunkRef, skipCache: boolean, fromCache: { value: boolean }): Promise<ArrayBuffer> {
    if (!skipCache) {
      const hit = await this.opts.cache.get(ref.hash);
      if (hit && hit.byteLength === ref.size) {
        this.cachedBytes += ref.size;
        return hit;
      }
      if (hit) await this.opts.cache.delete(ref.hash);
    }
    fromCache.value = false;
    // Two packs may share a chunk: download it once.
    let pending = this.chunkFetches.get(ref.hash);
    if (!pending) {
      pending = this.download(ref).finally(() => this.chunkFetches.delete(ref.hash));
      this.chunkFetches.set(ref.hash, pending);
    }
    return pending;
  }

  private async download(ref: PackChunkRef): Promise<ArrayBuffer> {
    const delay = this.opts.retryDelayMs ?? 1500;
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, delay * attempt));
      try {
        const data = await this.opts.fetchChunk(ref.hash);
        if (data.byteLength !== ref.size || await sha256Hex(data) !== ref.hash) {
          throw new Error(`Asset chunk ${ref.hash.slice(0, 12)} arrived damaged`);
        }
        this.downloadedBytes += data.byteLength;
        await this.opts.cache.put(ref.hash, data);
        return data;
      } catch (err) {
        if (isAuthError(err)) throw err;
        if (err instanceof PackHttpError && err.status === 404) throw err;
        lastError = err;
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }
}
