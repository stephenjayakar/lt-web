/**
 * base-surf.ts — 9-slice window background system.
 *
 * Ported from LT's app/engine/base_surf.py.
 * Creates window chrome surfaces from 24x24 (or NxN) sprite sheets
 * divided into 8x8 tile slices.
 */

import { Surface } from '../engine/surface';

const SLICE_SIZE = 8;

/**
 * Create a 9-slice window background surface.
 *
 * @param image   The source sprite sheet (24x24 or larger, multiples of 8).
 * @param width   Desired output width in pixels (snapped down to multiple of 8).
 * @param height  Desired output height in pixels (snapped down to multiple of 8).
 * @returns       A Surface with the 9-sliced background drawn.
 */
export function createBaseSurf(
  image: HTMLImageElement,
  width: number,
  height: number,
): Surface {
  const W = Math.floor(width / SLICE_SIZE) * SLICE_SIZE;
  const H = Math.floor(height / SLICE_SIZE) * SLICE_SIZE;

  if (W < SLICE_SIZE * 2 || H < SLICE_SIZE * 2) {
    // Too small for 9-slice, just return a dark surface
    const s = new Surface(Math.max(W, 16), Math.max(H, 16));
    s.fillRect(0, 0, s.width, s.height, 'rgba(16,16,32,0.9)');
    return s;
  }

  const surf = new Surface(W, H);
  const imgW = image.width;
  const imgH = image.height;

  // Source tile counts (how many 8x8 tiles along each edge of the source)
  const srcCols = Math.floor(imgW / SLICE_SIZE);
  const srcRows = Math.floor(imgH / SLICE_SIZE);

  // Center tiles = everything except first and last column/row
  const centerCols = Math.max(1, srcCols - 2);
  const centerRows = Math.max(1, srcRows - 2);

  // Destination tile counts
  const dstCols = Math.floor(W / SLICE_SIZE);
  const dstRows = Math.floor(H / SLICE_SIZE);

  // Fill center (interior tiles)
  for (let row = 1; row < dstRows - 1; row++) {
    for (let col = 1; col < dstCols - 1; col++) {
      // Pick a random center tile
      const srcCol = 1 + Math.floor(Math.random() * centerCols);
      const srcRow = 1 + Math.floor(Math.random() * centerRows);
      surf.blitImage(
        image,
        srcCol * SLICE_SIZE, srcRow * SLICE_SIZE,
        SLICE_SIZE, SLICE_SIZE,
        col * SLICE_SIZE, row * SLICE_SIZE,
      );
    }
  }

  // Fill top edge
  for (let col = 1; col < dstCols - 1; col++) {
    const srcCol = 1 + Math.floor(Math.random() * centerCols);
    surf.blitImage(
      image,
      srcCol * SLICE_SIZE, 0,
      SLICE_SIZE, SLICE_SIZE,
      col * SLICE_SIZE, 0,
    );
  }

  // Fill bottom edge
  for (let col = 1; col < dstCols - 1; col++) {
    const srcCol = 1 + Math.floor(Math.random() * centerCols);
    surf.blitImage(
      image,
      srcCol * SLICE_SIZE, (srcRows - 1) * SLICE_SIZE,
      SLICE_SIZE, SLICE_SIZE,
      col * SLICE_SIZE, (dstRows - 1) * SLICE_SIZE,
    );
  }

  // Fill left edge
  for (let row = 1; row < dstRows - 1; row++) {
    const srcRow = 1 + Math.floor(Math.random() * centerRows);
    surf.blitImage(
      image,
      0, srcRow * SLICE_SIZE,
      SLICE_SIZE, SLICE_SIZE,
      0, row * SLICE_SIZE,
    );
  }

  // Fill right edge
  for (let row = 1; row < dstRows - 1; row++) {
    const srcRow = 1 + Math.floor(Math.random() * centerRows);
    surf.blitImage(
      image,
      (srcCols - 1) * SLICE_SIZE, srcRow * SLICE_SIZE,
      SLICE_SIZE, SLICE_SIZE,
      (dstCols - 1) * SLICE_SIZE, row * SLICE_SIZE,
    );
  }

  // Four corners
  // Top-left
  surf.blitImage(image, 0, 0, SLICE_SIZE, SLICE_SIZE, 0, 0);
  // Top-right
  surf.blitImage(
    image,
    (srcCols - 1) * SLICE_SIZE, 0,
    SLICE_SIZE, SLICE_SIZE,
    (dstCols - 1) * SLICE_SIZE, 0,
  );
  // Bottom-left
  surf.blitImage(
    image,
    0, (srcRows - 1) * SLICE_SIZE,
    SLICE_SIZE, SLICE_SIZE,
    0, (dstRows - 1) * SLICE_SIZE,
  );
  // Bottom-right
  surf.blitImage(
    image,
    (srcCols - 1) * SLICE_SIZE, (srcRows - 1) * SLICE_SIZE,
    SLICE_SIZE, SLICE_SIZE,
    (dstCols - 1) * SLICE_SIZE, (dstRows - 1) * SLICE_SIZE,
  );

  return surf;
}

// ============================================================
// Global cache of loaded menu background sprites
// ============================================================

const bgCache: Map<string, HTMLImageElement> = new Map();
const bgPending: Map<string, Promise<HTMLImageElement | null>> = new Map();

/**
 * Load a menu background sprite from the game data server.
 * Returns the cached image or null if loading fails.
 * Uses the path pattern: /game-data/sprites/menus/{nid}.png
 */
export async function loadMenuBgSprite(nid: string): Promise<HTMLImageElement | null> {
  const cached = bgCache.get(nid);
  if (cached) return cached;

  const pending = bgPending.get(nid);
  if (pending) return pending;

  const url = `/game-data/sprites/menus/${nid}.png`;
  const promise = new Promise<HTMLImageElement | null>((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      bgCache.set(nid, img);
      bgPending.delete(nid);
      resolve(img);
    };
    img.onerror = () => {
      bgPending.delete(nid);
      resolve(null);
    };
    img.src = url;
  });

  bgPending.set(nid, promise);
  return promise;
}

// Pre-rendered surface cache (keyed by "nid:WxH")
const surfCache: Map<string, Surface> = new Map();

/**
 * Get a 9-slice menu background surface, loading the sprite if needed.
 * Returns a cached surface or creates a new one.
 * Falls back to a solid dark surface if the sprite hasn't loaded yet.
 */
export async function getMenuBackground(
  width: number,
  height: number,
  nid: string = 'menu_bg_base',
): Promise<Surface> {
  const key = `${nid}:${width}x${height}`;
  const cached = surfCache.get(key);
  if (cached) return cached;

  const img = await loadMenuBgSprite(nid);
  if (!img) {
    // Fallback: solid dark surface
    const fallback = new Surface(width, height);
    fallback.fillRect(0, 0, width, height, 'rgba(16,16,32,0.9)');
    return fallback;
  }

  const surf = createBaseSurf(img, width, height);
  surfCache.set(key, surf);
  return surf;
}

/**
 * Synchronous version that returns a cached surface or a dark fallback.
 * Kicks off async load if not cached yet.
 */
export function getMenuBackgroundSync(
  width: number,
  height: number,
  nid: string = 'menu_bg_base',
): Surface {
  const key = `${nid}:${width}x${height}`;
  const cached = surfCache.get(key);
  if (cached) return cached;

  // Start async load
  void getMenuBackground(width, height, nid);

  // Return fallback
  const fallback = new Surface(width, height);
  fallback.fillRect(0, 0, width, height, 'rgba(16,16,32,0.9)');
  return fallback;
}
