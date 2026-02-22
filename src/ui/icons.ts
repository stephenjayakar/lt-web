/**
 * icons.ts — Icon rendering system for items, skills, and weapons.
 *
 * Ported from LT's app/engine/icons.py.
 * Loads icon sheets (16x16 grid cells) from resources/icons16/
 * and provides functions to extract and draw individual icons.
 */

import { Surface } from '../engine/surface';

const ICON_SIZE_16 = 16;
const ICON_SIZE_32 = 32;

// ============================================================
// Icon sheet cache
// ============================================================

const iconSheets: Map<string, HTMLImageElement> = new Map();
const pendingLoads: Map<string, Promise<HTMLImageElement | null>> = new Map();

/** Base URL for game data (set once at init). */
let baseUrl: string = '/game-data/default.ltproj';

/** Initialize the icon system with the base URL for loading resources. */
export function initIcons(url: string): void {
  baseUrl = url.replace(/\/$/, '');
}

/**
 * Load an icon sheet by NID. Returns the image or null on failure.
 * Results are cached.
 */
export async function loadIconSheet(
  nid: string,
  size: '16' | '32' = '16',
): Promise<HTMLImageElement | null> {
  const key = `${size}:${nid}`;
  const cached = iconSheets.get(key);
  if (cached) return cached;

  const pending = pendingLoads.get(key);
  if (pending) return pending;

  const folder = `icons${size}`;
  const url = `${baseUrl}/resources/${folder}/${nid}.png`;

  const promise = new Promise<HTMLImageElement | null>((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      iconSheets.set(key, img);
      pendingLoads.delete(key);
      resolve(img);
    };
    img.onerror = () => {
      pendingLoads.delete(key);
      resolve(null);
    };
    img.src = url;
  });

  pendingLoads.set(key, promise);
  return promise;
}

/**
 * Get the icon sheet image synchronously (returns null if not loaded yet).
 * Kicks off async load if needed.
 */
export function getIconSheet(nid: string, size: '16' | '32' = '16'): HTMLImageElement | null {
  const key = `${size}:${nid}`;
  const cached = iconSheets.get(key);
  if (cached) return cached;

  // Start async load
  void loadIconSheet(nid, size);
  return null;
}

/**
 * Draw a 16x16 icon from a sheet onto a surface.
 *
 * @param surf       Target surface.
 * @param iconNid    Icon sheet NID (e.g. "Sword", "Skills").
 * @param iconIndex  Grid coordinates [x, y] into the sheet.
 * @param dx         Destination X on the surface.
 * @param dy         Destination Y on the surface.
 */
export function drawIcon16(
  surf: Surface,
  iconNid: string,
  iconIndex: [number, number],
  dx: number,
  dy: number,
): void {
  const img = getIconSheet(iconNid, '16');
  if (!img) return; // Not loaded yet — will appear next frame

  const sx = iconIndex[0] * ICON_SIZE_16;
  const sy = iconIndex[1] * ICON_SIZE_16;
  surf.blitImage(img, sx, sy, ICON_SIZE_16, ICON_SIZE_16, dx, dy);
}

/**
 * Draw a 32x32 icon from a sheet onto a surface.
 */
export function drawIcon32(
  surf: Surface,
  iconNid: string,
  iconIndex: [number, number],
  dx: number,
  dy: number,
): void {
  const img = getIconSheet(iconNid, '32');
  if (!img) return;

  const sx = iconIndex[0] * ICON_SIZE_32;
  const sy = iconIndex[1] * ICON_SIZE_32;
  surf.blitImage(img, sx, sy, ICON_SIZE_32, ICON_SIZE_32, dx, dy);
}

/**
 * Draw an item's icon (16x16) onto a surface.
 * Reads the item's iconNid and iconIndex properties.
 */
export function drawItemIcon(
  surf: Surface,
  item: { iconNid: string; iconIndex: [number, number] },
  dx: number,
  dy: number,
): void {
  if (!item.iconNid) return;
  drawIcon16(surf, item.iconNid, item.iconIndex, dx, dy);
}

/**
 * Preload all icon sheets for a set of items/skills.
 * Call this when loading a level to ensure icons are ready.
 */
export async function preloadIconSheets(
  items: Iterable<{ iconNid: string }>,
): Promise<void> {
  const nids = new Set<string>();
  for (const item of items) {
    if (item.iconNid) nids.add(item.iconNid);
  }

  await Promise.all(
    Array.from(nids).map(nid => loadIconSheet(nid, '16')),
  );
}
