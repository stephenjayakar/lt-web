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

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  /** Resolve a relative path to a full URL under the .ltproj root. */
  private resolveUrl(path: string): string {
    return `${this.baseUrl}/${path}`;
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
    const [stand, move] = await Promise.all([
      this.tryLoadImage(`resources/map_sprites/${nid}-stand.png`),
      this.tryLoadImage(`resources/map_sprites/${nid}-move.png`),
    ]);
    return { stand, move };
  }

  /** Load a portrait image by NID. */
  async loadPortrait(nid: string): Promise<HTMLImageElement> {
    return this.loadImage(`resources/portraits/${nid}.png`);
  }

  /** Load a system sprite by name (e.g. "cursor", "menus"). */
  async loadSystemSprite(name: string): Promise<HTMLImageElement> {
    return this.loadImage(`sprites/${name}.png`);
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
