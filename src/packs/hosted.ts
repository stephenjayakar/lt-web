/**
 * hosted.ts — Hosted-site mode: game assets come from the content-hashed
 * packs under /packs/ instead of /game-data/ files and the single bundle zip.
 *
 * `npm run build:site` builds with __LT_HOSTED__ = true and writes
 * dist/packs/manifest.json plus one dist/packs/<sha256>.bin per chunk (every
 * file stays under the static host's 25 MiB limit). bootHostedPacks fetches
 * the manifest, loads the boot packs (from Cache Storage when their hashes
 * are already there), and serves /game-data/* from memory through the
 * AssetBundle fetch/image interceptors. Music keeps loading in the
 * background; a track requested before its pack arrives waits for it.
 *
 * Local dev, plain `npm run build`, and the Playwright harness are untouched:
 * __LT_HOSTED__ is false there and the existing /game-data + bundle paths run.
 */

import { installBundleFetchInterceptor, installBundleImageInterceptor } from '../data/asset-bundle';
import { openChunkCache, requestPersistentPackStorage } from './chunk-cache';
import type { ChunkCache } from './chunk-cache';
import { parseManifest } from './manifest';
import type { PackManifest } from './manifest';
import { PackHttpError, PackLoader } from './pack-loader';
import type { PackProgress } from './pack-loader';

declare const __LT_HOSTED__: boolean;

/** The base URL the engine requests game files under. */
export const GAME_DATA_BASE = '/game-data';
/** Where build-site writes the packs. */
export const PACKS_BASE = '/packs';

export function isHostedBuild(): boolean {
  return typeof __LT_HOSTED__ !== 'undefined' && __LT_HOSTED__;
}

/** The pack manifest (never served from a stale HTTP cache). */
export async function loadPackManifest(base: string = PACKS_BASE): Promise<PackManifest> {
  const res = await fetch(`${base}/manifest.json`, { cache: 'no-cache' });
  if (!res.ok) throw new PackHttpError(res.status, `Game data list unavailable (HTTP ${res.status}).`);
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new Error('Game data list is unreadable.');
  }
  const manifest = parseManifest(json);
  if (manifest.packs.length === 0) throw new Error('This build contains no game data.');
  return manifest;
}

/** Fetch one chunk file by hash. */
export function staticChunkFetcher(base: string = PACKS_BASE): (hash: string) => Promise<ArrayBuffer> {
  return async (hash) => {
    const res = await fetch(`${base}/${hash}.bin`);
    if (!res.ok) throw new PackHttpError(res.status, `Game data chunk ${hash.slice(0, 12)}: HTTP ${res.status}`);
    return await res.arrayBuffer();
  };
}

export interface HostedBootUi {
  update(message: string): void;
  progress?(fraction: number | null): void;
}

export interface HostedBootOptions {
  base?: string;
  cache?: ChunkCache;
  ui?: HostedBootUi;
  /** Install the /game-data interceptors (default true) */
  intercept?: boolean;
}

const mb = (n: number) => (n / 1048576).toFixed(1);

/**
 * Load the boot packs and install the /game-data interceptors. Returns the
 * loader; background packs keep loading after this resolves.
 */
export async function bootHostedPacks(manifest: PackManifest, options: HostedBootOptions = {}): Promise<PackLoader> {
  const { ui, base = PACKS_BASE } = options;
  const cache = options.cache ?? await openChunkCache();
  if (cache.persistent) requestPersistentPackStorage();

  const loader = new PackLoader({
    manifest,
    cache,
    fetchChunk: staticChunkFetcher(base),
    onProgress: (p: PackProgress) => {
      ui?.progress?.(p.total > 0 ? p.loaded / p.total : null);
      ui?.update(p.downloaded > 0
        ? `Downloading game data… ${mb(p.loaded)} / ${mb(p.total)} MB`
        : `Loading game data… ${p.packsDone} / ${p.packsTotal}`);
    },
  });
  await loader.loadBoot();
  ui?.progress?.(null);

  if (options.intercept !== false) {
    installBundleFetchInterceptor(loader.bundle, GAME_DATA_BASE, {
      waitFor: (path) => loader.waitFor(path),
      notFoundLocally: true,
    });
    installBundleImageInterceptor(loader.bundle, GAME_DATA_BASE, {
      waitFor: (path) => loader.waitFor(path),
    });
  }

  console.info(`[Packs] ${loader.bundle.fileCount} files ready (${mb(loader.downloadedBytes)} MB downloaded, `
    + `${mb(loader.cachedBytes)} MB from cache)`);
  void loader.startBackground();
  (window as unknown as { __ltPacks?: unknown }).__ltPacks = {
    get downloadedBytes() { return loader.downloadedBytes; },
    get cachedBytes() { return loader.cachedBytes; },
    get fileCount() { return loader.bundle.fileCount; },
    isLoaded: (name: string) => loader.isLoaded(name),
  };
  return loader;
}
