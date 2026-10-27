/**
 * sprites.ts — Python's SPRITES dictionary (app/sprites.py).
 *
 * Python loads every PNG under the engine's sprites/ folder keyed by file
 * name, then the project's resources/custom_sprites on top (resources.py),
 * so a project can replace any engine sprite by shipping a PNG of the same
 * name anywhere in that folder tree. Vite scans both trees at startup and
 * injects the name -> path index as __LT_SPRITES__ (vite.config.ts
 * discoverSprites); this module turns a name into a loaded Surface.
 *
 * Lookups are synchronous: the first get() starts the load and returns null,
 * and later frames get the Surface (Python loads them all at boot; callers
 * draw nothing for a frame or two instead).
 */

import { Surface, surfaceFromImage } from '../engine/surface';
import { isForkEngine } from '../engine/engine-flavor';

declare const __LT_SPRITES__: {
  engine: Record<string, string>;
  /** public/fork-sprites: EOtF engine-fork sprites (fork-only, or the fork's version of an engine sprite). */
  fork?: Record<string, string>;
  projects: Record<string, Record<string, string>>;
} | undefined;

const INDEX = typeof __LT_SPRITES__ !== 'undefined' ? __LT_SPRITES__ : { engine: {}, projects: {} };
const FORK: Record<string, string> = INDEX.fork ?? {};

let engineBase = '/game-data';
let projectBase = '';
let projectSprites: Record<string, string> = {};

const loaded: Map<string, Surface | null> = new Map();
const pending: Map<string, Promise<Surface | null>> = new Map();

/** Point the registry at the engine root and the active project. */
export function initSprites(engineBaseUrl: string, projectBaseUrl: string): void {
  engineBase = engineBaseUrl.replace(/\/$/, '');
  projectBase = projectBaseUrl.replace(/\/$/, '');
  const projectName = projectBase.split('/').pop() ?? '';
  projectSprites = INDEX.projects[projectName] ?? {};
  loaded.clear();
  pending.clear();
}

const encodePath = (path: string): string => path.split('/').map(encodeURIComponent).join('/');

/** URL of the fork's copy of an engine sprite, or null when the fork has none. */
function forkUrl(name: string): string | null {
  const fork = FORK[name];
  return fork ? `${engineBase}/fork-sprites/${encodePath(fork)}` : null;
}

/**
 * URL of an engine sprite (no project override) for loaders that build
 * engine paths themselves: the fork's copy for a project on EOtF's engine
 * fork (its SPRITES dictionary has the fork's file under that name), else
 * `defaultUrl`.
 */
export function engineSpriteUrl(name: string, defaultUrl: string): string {
  return (isForkEngine() ? forkUrl(name) : null) ?? defaultUrl;
}

/**
 * URL of a sprite by Python SPRITES name, or null when no such sprite exists.
 * Order: the project's custom_sprites, then (on the EOtF fork) the fork's
 * engine sprite, then the upstream engine sprite, then a fork-only sprite.
 */
export function spriteUrl(name: string): string | null {
  const custom = projectSprites[name];
  if (custom && projectBase) {
    return `${projectBase}/resources/custom_sprites/${encodePath(custom)}`;
  }
  if (isForkEngine()) {
    const fork = forkUrl(name);
    if (fork) return fork;
  }
  const engine = INDEX.engine[name];
  if (engine) return `${engineBase}/sprites/${encodePath(engine)}`;
  return forkUrl(name);
}

/** Whether SPRITES has an entry with this name (Python `name in SPRITES`). */
export function hasSprite(name: string): boolean {
  return name in projectSprites || name in INDEX.engine || name in FORK;
}

/**
 * Sprite names the EOtF fork suffixes with the `window_display` setting
 * (`'menu_bg_base' + str(cf.SETTINGS['window_display'])` and so on; the
 * fork never asks for the bare names). EOtF ships the skins as
 * resources/custom_sprites/menu/{1..4}/<name><n>.png.
 */
const WINDOW_SKIN_SPRITES: ReadonlySet<string> = new Set([
  'menu_bg_base', 'menu_gem_small', 'menu_shimmer1', 'menu_shimmer2',
  'money_bg', 'funds_display', 'rescue_window', 'give_window', 'sound_player',
  'tile_info_quick_opaque', 'tile_info_destructible_opaque', 'trade_window', 'Weather_Window',
]);

let windowDisplay: () => unknown = () => 1;

/** Settings register the live `window_display` value (avoids an import cycle). */
export function setWindowDisplayProvider(provider: () => unknown): void {
  windowDisplay = provider;
}

/** The live window_display skin (EOtF fork; 1 elsewhere). */
export function currentWindowSkin(): unknown {
  return windowDisplay() ?? 1;
}

let startupWindowDisplay: unknown = null;

/**
 * Remember the skin the session started with. EOtF's engine bakes the
 * skin into a few windows when it starts (bare `create_base_surf(w, h)`
 * calls take a default argument evaluated at import), so those keep the
 * startup skin until the game is restarted.
 */
export function freezeStartupWindowSkin(): void {
  startupWindowDisplay = windowDisplay() ?? 1;
}

/** `skinnedSpriteName` with a given skin number. */
export function skinnedSpriteNameFor(name: string, skin: unknown): string {
  if (!isForkEngine() || !WINDOW_SKIN_SPRITES.has(name)) return name;
  const skinned = `${name}${skin ?? 1}`;
  return hasSprite(skinned) ? skinned : name;
}

/** The skinned name for a window EOtF builds with the startup skin. */
export function startupSkinnedSpriteName(name: string): string {
  return skinnedSpriteNameFor(name, startupWindowDisplay ?? windowDisplay());
}

/**
 * The SPRITES name actually used for `name`: on the EOtF fork, the
 * window_display skin's copy of a menu/window sprite (falling back to the
 * bare name when that skin lacks it); otherwise `name` unchanged.
 */
export function skinnedSpriteName(name: string): string {
  return skinnedSpriteNameFor(name, windowDisplay());
}

/** Load a sprite (resolves null when it does not exist or fails to load). */
export function loadSprite(name: string): Promise<Surface | null> {
  if (loaded.has(name)) return Promise.resolve(loaded.get(name) ?? null);
  const inflight = pending.get(name);
  if (inflight) return inflight;
  const url = spriteUrl(name);
  if (!url) {
    loaded.set(name, null);
    return Promise.resolve(null);
  }
  const promise = new Promise<Surface | null>((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      const surf = surfaceFromImage(img);
      loaded.set(name, surf);
      pending.delete(name);
      resolve(surf);
    };
    img.onerror = () => {
      loaded.set(name, null);
      pending.delete(name);
      resolve(null);
    };
    img.src = url;
  });
  pending.set(name, promise);
  return promise;
}

/**
 * Python SPRITES.get(name, fallback). Returns null while the image is still
 * loading. Callers must not draw into the returned Surface; copy() first.
 */
export function getSprite(name: string, fallback?: string): Surface | null {
  name = skinnedSpriteName(name);
  if (!hasSprite(name) && fallback !== undefined) return getSprite(fallback);
  const surf = loaded.get(name);
  if (surf !== undefined) return surf;
  void loadSprite(name);
  return null;
}

/** Start loading a set of sprites; resolves when all have settled. */
export async function preloadSprites(names: readonly string[]): Promise<void> {
  await Promise.all(names.map((name) => loadSprite(name)));
}

/**
 * Python image_mods.make_translucent(image, t): multiply every pixel's alpha
 * by (255 - int(255 * t)) / 255. Unlike Surface.setAlpha this is baked into
 * the pixels, so text drawn on the result afterwards stays opaque.
 */
export function makeTranslucent(surf: Surface, t: number): Surface {
  const alpha = Math.max(0, Math.min(255, 255 - Math.trunc(255 * t))) / 255;
  const out = new Surface(surf.width, surf.height);
  out.ctx.globalAlpha = alpha;
  out.ctx.drawImage(surf.canvas, 0, 0, surf.width, surf.height);
  out.ctx.globalAlpha = 1;
  return out;
}

/** Python engine.subsurface: a copy of one region of a sprite. */
export function subsurface(surf: Surface, x: number, y: number, w: number, h: number): Surface {
  return surf.subsurface(x, y, w, h);
}
