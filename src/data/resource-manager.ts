/**
 * ResourceManager loads all game assets from a hosted .ltproj folder.
 * The .ltproj must be served as static files at a base URL.
 *
 * Usage:
 *   const resources = new ResourceManager('/game-data/default.ltproj');
 *   await resources.load();
 *   const tilesetImg = resources.getTilesetImage('Prologue');
 */

import { Surface, surfaceFromImage } from '../engine/surface';

export class ResourceManager {
  private baseUrl: string;
  private images: Map<string, HTMLImageElement> = new Map();
  private imageCache: Map<string, Surface> = new Map();
  private audioBuffers: Map<string, ArrayBuffer> = new Map();
  private jsonCache: Map<string, unknown> = new Map();
  private pendingImages: Map<string, Promise<HTMLImageElement>> = new Map();
  /** Python RESOURCES.map_sprites: the project's map sprite nids (null if unlisted). */
  private mapSpriteNids: Promise<Set<string> | null> | null = null;
  /** Python RESOURCES.panoramas: the project's panorama nids (null if unlisted). */
  private panoramaNids: Promise<Set<string> | null> | null = null;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  /** Get the base URL for this resource manager. */
  getBaseUrl(): string {
    return this.baseUrl;
  }

  /**
   * Resolve a relative path to a full URL under the .ltproj root.
   * Each path segment is URI-encoded to handle spaces and special characters
   * (e.g., "Bethroen 2.png" -> "Bethroen%202.png") while preserving '/' separators.
   */
  private resolveUrl(path: string): string {
    const encoded = path.split('/').map(segment => encodeURIComponent(segment)).join('/');
    return `${this.baseUrl}/${encoded}`;
  }

  // -------------------------------------------------------------------
  // Image loading
  // -------------------------------------------------------------------

  /**
   * Load an image from a relative path and cache it.
   * Deduplicates concurrent requests for the same URL.
   */
  async loadImage(path: string): Promise<HTMLImageElement> {
    const url = this.resolveUrl(path);

    const cached = this.images.get(url);
    if (cached) return cached;

    // Deduplicate: if we already have an in-flight request, return that promise.
    const pending = this.pendingImages.get(url);
    if (pending) return pending;

    const promise = new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        this.images.set(url, img);
        this.pendingImages.delete(url);
        resolve(img);
      };
      img.onerror = (_event) => {
        this.pendingImages.delete(url);
        reject(new Error(`Failed to load image: ${url}`));
      };
      img.src = url;
    });

    this.pendingImages.set(url, promise);
    return promise;
  }

  /**
   * Try to load an image, returning null on failure instead of throwing.
   */
  async tryLoadImage(path: string): Promise<HTMLImageElement | null> {
    try {
      return await this.loadImage(path);
    } catch {
      console.warn(`ResourceManager: image not found – ${path}`);
      return null;
    }
  }

  // -------------------------------------------------------------------
  // JSON loading
  // -------------------------------------------------------------------

  /** Load and parse JSON from a relative path. Results are cached. */
  async loadJson<T>(path: string): Promise<T> {
    const url = this.resolveUrl(path);

    const cached = this.jsonCache.get(url);
    if (cached !== undefined) return cached as T;

    const resp = await fetch(url);
    if (!resp.ok) {
      throw new Error(`Failed to load ${path}: HTTP ${resp.status} ${resp.statusText}`);
    }

    const data: T = await resp.json();
    this.jsonCache.set(url, data);
    return data;
  }

  /**
   * Try to load JSON, returning null on failure instead of throwing.
   */
  async tryLoadJson<T>(path: string): Promise<T | null> {
    try {
      return await this.loadJson<T>(path);
    } catch {
      console.warn(`ResourceManager: JSON not found – ${path}`);
      return null;
    }
  }

  /**
   * Try to load JSON silently — returns null on failure without logging.
   * Used for fallback path probing where failures are expected.
   */
  async tryLoadJsonSilent<T>(path: string): Promise<T | null> {
    try {
      return await this.loadJson<T>(path);
    } catch {
      return null;
    }
  }

  // -------------------------------------------------------------------
  // Audio loading
  // -------------------------------------------------------------------

  /** Load a raw audio file as an ArrayBuffer. */
  async loadAudio(path: string): Promise<ArrayBuffer> {
    const url = this.resolveUrl(path);

    const cached = this.audioBuffers.get(url);
    if (cached) return cached;

    const resp = await fetch(url);
    if (!resp.ok) {
      throw new Error(`Failed to load audio ${path}: HTTP ${resp.status}`);
    }

    const buffer = await resp.arrayBuffer();
    this.audioBuffers.set(url, buffer);
    return buffer;
  }

  /** Try to load audio, returning null on failure. */
  async tryLoadAudio(path: string): Promise<ArrayBuffer | null> {
    try {
      return await this.loadAudio(path);
    } catch {
      console.warn(`ResourceManager: audio not found – ${path}`);
      return null;
    }
  }

  // -------------------------------------------------------------------
  // Text loading
  // -------------------------------------------------------------------

  /** Load a raw text file. */
  async loadText(path: string): Promise<string> {
    const url = this.resolveUrl(path);
    const resp = await fetch(url);
    if (!resp.ok) {
      throw new Error(`Failed to load text ${path}: HTTP ${resp.status}`);
    }
    return resp.text();
  }

  /** Try to load text, returning null on failure. */
  async tryLoadText(path: string): Promise<string | null> {
    try {
      return await this.loadText(path);
    } catch {
      console.warn(`ResourceManager: text not found – ${path}`);
      return null;
    }
  }

  // -------------------------------------------------------------------
  // Domain-specific loaders
  // -------------------------------------------------------------------

  /** Load a tileset image by NID. */
  async loadTilesetImage(nid: string): Promise<HTMLImageElement> {
    return this.loadImage(`resources/tilesets/${nid}.png`);
  }

  /** Load map sprite images (stand and move sheets). */
  async loadMapSprite(
    nid: string,
  ): Promise<{ stand: HTMLImageElement; move: HTMLImageElement }> {
    const [stand, move] = await Promise.all([
      this.loadImage(`resources/map_sprites/${nid}-stand.png`),
      this.loadImage(`resources/map_sprites/${nid}-move.png`),
    ]);
    return { stand, move };
  }

  /**
   * Try to load map sprite images, returning null for missing sheets.
   */
  async tryLoadMapSprite(
    nid: string,
  ): Promise<{ stand: HTMLImageElement | null; move: HTMLImageElement | null }> {
    // Python looks the nid up in RESOURCES.map_sprites (the catalog in
    // map_sprites.json) and only then loads files; a missing variant such as
    // "<Class>Female" is a silent miss, not a failed image request.
    const catalog = await this.loadMapSpriteCatalog();
    if (catalog && !catalog.has(nid)) return { stand: null, move: null };
    const [stand, move] = await Promise.all([
      this.tryLoadImage(`resources/map_sprites/${nid}-stand.png`),
      this.tryLoadImage(`resources/map_sprites/${nid}-move.png`),
    ]);
    return { stand, move };
  }

  private loadMapSpriteCatalog(): Promise<Set<string> | null> {
    this.mapSpriteNids ??= this.tryLoadJsonSilent<unknown[]>('resources/map_sprites/map_sprites.json').then((list) => {
      if (!Array.isArray(list) || list.length === 0) return null;
      const nids = list.map((entry) =>
        typeof entry === 'string' ? entry : (entry as { nid?: unknown } | null)?.nid);
      return nids.every((n) => typeof n === 'string') ? new Set(nids as string[]) : null;
    });
    return this.mapSpriteNids;
  }

  /**
   * Whether panoramas.json lists `nid` (Python RESOURCES.panoramas.get), or
   * null when the project has no readable catalog.
   */
  async hasPanorama(nid: string): Promise<boolean | null> {
    this.panoramaNids ??= this.tryLoadJsonSilent<unknown[]>('resources/panoramas/panoramas.json').then((list) => {
      if (!Array.isArray(list) || list.length === 0) return null;
      const nids = list.map((entry) => Array.isArray(entry) ? entry[0]
        : typeof entry === 'string' ? entry : (entry as { nid?: unknown } | null)?.nid);
      return nids.every((n) => typeof n === 'string') ? new Set(nids as string[]) : null;
    });
    const catalog = await this.panoramaNids;
    return catalog ? catalog.has(nid) : null;
  }

  /** Load a portrait image by NID. */
  async loadPortrait(nid: string): Promise<HTMLImageElement> {
    return this.loadImage(`resources/portraits/${nid}.png`);
  }

  /**
   * Load a SPRITES entry by name (e.g. an event overlay sprite).
   *
   * Python's SPRITES dict holds the engine sprites with the project's
   * resources/custom_sprites/*.png layered over them by basename, so a
   * project sprite wins. Engine sprites are staged at /game-data/sprites/,
   * beside — not inside — the .ltproj directory.
   */
  async loadSystemSprite(name: string): Promise<HTMLImageElement> {
    try {
      return await this.loadImage(`resources/custom_sprites/${name}.png`);
    } catch {
      const encoded = encodeURIComponent(name);
      const engineUrl = `${this.baseUrl.replace(/\/[^/]*$/, '')}/sprites/${encoded}.png`;
      return this.loadAbsoluteImage(engineUrl);
    }
  }

  /** Load and cache an image by absolute URL. */
  private loadAbsoluteImage(url: string): Promise<HTMLImageElement> {
    const cached = this.images.get(url);
    if (cached) return Promise.resolve(cached);
    const pending = this.pendingImages.get(url);
    if (pending) return pending;
    const promise = new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        this.images.set(url, img);
        this.pendingImages.delete(url);
        resolve(img);
      };
      img.onerror = () => {
        this.pendingImages.delete(url);
        reject(new Error(`Failed to load image: ${url}`));
      };
      img.src = url;
    });
    this.pendingImages.set(url, promise);
    return promise;
  }

  /**
   * Python SPRITES lookup: project `custom_sprites` override engine sprites
   * of the same name (engine sprites live under /game-data/sprites/ and its
   * menus/ folder). Used by draw_overlay_sprite and similar commands.
   */
  async loadNamedSprite(name: string): Promise<HTMLImageElement> {
    const candidates = [
      `resources/custom_sprites/${name}.png`,
      `../sprites/${name}.png`,
      `../sprites/menus/${name}.png`,
    ];
    for (const candidate of candidates) {
      try {
        return await this.loadImage(candidate);
      } catch {
        // try the next location
      }
    }
    throw new Error(`Sprite not found: ${name}`);
  }

  /** Load an icon sheet from a folder (e.g. "icons", "item_icons"). */
  async loadIconSheet(folder: string, nid: string): Promise<HTMLImageElement> {
    return this.loadImage(`resources/${folder}/${nid}.png`);
  }

  /** Load a panorama / background image. */
  async loadPanorama(nid: string): Promise<HTMLImageElement> {
    return this.loadImage(`resources/panoramas/${nid}.png`);
  }

  // -------------------------------------------------------------------
  // Surface helpers
  // -------------------------------------------------------------------

  /**
   * Get (or create) a Surface from a previously-loaded image.
   * The path is the same relative path passed to loadImage.
   */
  getSurface(path: string): Surface | null {
    const url = this.resolveUrl(path);

    const cached = this.imageCache.get(url);
    if (cached) return cached;

    const img = this.images.get(url);
    if (!img) return null;

    const surface = surfaceFromImage(img);
    this.imageCache.set(url, surface);
    return surface;
  }

  /**
   * Load an image and immediately convert it to a Surface.
   */
  async loadSurface(path: string): Promise<Surface> {
    await this.loadImage(path);
    const surface = this.getSurface(path);
    if (!surface) {
      throw new Error(`Failed to create surface for ${path}`);
    }
    return surface;
  }

  /**
   * Try to load an image as a Surface, returning null on failure.
   */
  async tryLoadSurface(path: string): Promise<Surface | null> {
    const img = await this.tryLoadImage(path);
    if (!img) return null;
    return this.getSurface(path);
  }

  // -------------------------------------------------------------------
  // Cache management
  // -------------------------------------------------------------------

  /** Check if an image is already loaded for the given path. */
  hasImage(path: string): boolean {
    return this.images.has(this.resolveUrl(path));
  }

  /** Check if JSON data is already cached for the given path. */
  hasJson(path: string): boolean {
    return this.jsonCache.has(this.resolveUrl(path));
  }

  /** Remove a cached image (and its Surface, if any). */
  evictImage(path: string): void {
    const url = this.resolveUrl(path);
    this.images.delete(url);
    this.imageCache.delete(url);
  }

  /** Remove cached JSON data. */
  evictJson(path: string): void {
    this.jsonCache.delete(this.resolveUrl(path));
  }

  /** Clear all caches. */
  clearAll(): void {
    this.images.clear();
    this.imageCache.clear();
    this.audioBuffers.clear();
    this.jsonCache.clear();
    this.pendingImages.clear();
  }
}
