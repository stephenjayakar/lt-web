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

type IconSheetImage = HTMLImageElement | HTMLCanvasElement;
const iconSheets: Map<string, IconSheetImage> = new Map();
const pendingLoads: Map<string, Promise<IconSheetImage | null>> = new Map();

/**
 * Python icons.py blits every icon after `set_colorkey(image, COLORKEY)`.
 * Most project icon sheets are RGB PNGs on the (128, 160, 128) key, so the
 * key colour must become transparent or each icon shows a green square.
 */
function applyIconColorkey(img: HTMLImageElement): IconSheetImage {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth || img.width;
    canvas.height = img.naturalHeight || img.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx || canvas.width === 0 || canvas.height === 0) return img;
    ctx.drawImage(img, 0, 0);
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const data = imageData.data;
    let keyed = false;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] === 128 && data[i + 1] === 160 && data[i + 2] === 128 && data[i + 3] !== 0) {
        data[i + 3] = 0;
        keyed = true;
      }
    }
    if (!keyed) return img;
    ctx.putImageData(imageData, 0, 0);
    return canvas;
  } catch {
    return img;
  }
}

/** Base URL for game data (set once at init). */
let baseUrl: string = '/game-data/default.ltproj';

type IconAlias = { sheetNid: string; index: [number, number] };

let iconAliases: Map<string, IconAlias> = new Map();
let aliasLoad: Promise<void> | null = null;

async function loadIconAliases(): Promise<void> {
  if (aliasLoad) return aliasLoad;
  aliasLoad = fetch(`${baseUrl}/resources/icons16/icons16.json`)
    .then(async (response) => {
      if (!response.ok) return;
      const sheets = await response.json() as Array<{
        nid?: string;
        subicon_dict?: Record<string, [number, number]>;
      }>;
      for (const sheet of sheets) {
        if (!sheet.nid) continue;
        for (const [alias, index] of Object.entries(sheet.subicon_dict ?? {})) {
          iconAliases.set(alias, { sheetNid: sheet.nid, index });
        }
      }
      await Promise.all(
        [...new Set([...iconAliases.values()].map((alias) => alias.sheetNid))]
          .map((nid) => loadIconSheet(nid, '16')),
      );
    })
    .catch(() => {
      // Missing icon metadata is valid for minimal projects.
    });
  return aliasLoad;
}

/** Initialize the icon system with the base URL for loading resources. */
export function initIcons(url: string): void {
  baseUrl = url.replace(/\/$/, '');
  iconAliases = new Map();
  aliasLoad = null;
  void loadIconAliases();
}

/** Wait until alias metadata and every referenced 16px sheet are ready. */
export async function preloadIconAliases(): Promise<void> {
  await loadIconAliases();
}

/**
 * Load an icon sheet by NID. Returns the image or null on failure.
 * Results are cached.
 */
export async function loadIconSheet(
  nid: string,
  size: '16' | '32' = '16',
): Promise<IconSheetImage | null> {
  const key = `${size}:${nid}`;
  const cached = iconSheets.get(key);
  if (cached) return cached;

  const pending = pendingLoads.get(key);
  if (pending) return pending;

  const folder = `icons${size}`;
  const url = `${baseUrl}/resources/${folder}/${encodeURIComponent(nid)}.png`;

  const promise = new Promise<IconSheetImage | null>((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      const sheet = applyIconColorkey(img);
      iconSheets.set(key, sheet);
      pendingLoads.delete(key);
      resolve(sheet);
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
export function getIconSheet(nid: string, size: '16' | '32' = '16'): IconSheetImage | null {
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

/** Draw a 16x16 icon by the alias stored in an icon sheet's subicon_dict. */
export function drawIconByAlias(
  surf: Surface,
  alias: string,
  dx: number,
  dy: number,
): boolean {
  const resolved = iconAliases.get(alias);
  if (!resolved) {
    void loadIconAliases();
    return false;
  }
  drawIcon16(surf, resolved.sheetNid, resolved.index, dx, dy);
  return true;
}

/** Exposed for deterministic rendering tests and diagnostics. */
export function resolveIconAlias(alias: string): IconAlias | null {
  return iconAliases.get(alias) ?? null;
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
  whiteness: number = 0,
): void {
  if (!item.iconNid) return;
  if (whiteness <= 0) {
    drawIcon16(surf, item.iconNid, item.iconIndex, dx, dy);
    return;
  }
  const img = getIconSheet(item.iconNid, '16');
  if (!img) return;
  surf.blitImage(whiteIcon(img, item.iconIndex, whiteness), 0, 0, ICON_SIZE_16, ICON_SIZE_16, dx, dy);
}

let whiteIconCanvas: HTMLCanvasElement | OffscreenCanvas | null = null;

/**
 * Python image_mods.make_white(icon, white): BLEND_RGB_ADD of
 * (int(255 * white),) * 3 onto the icon's colour, alpha untouched. Drawn on
 * one reusable 16x16 canvas, so the result must be blitted immediately.
 */
function whiteIcon(
  img: HTMLImageElement | ImageBitmap | HTMLCanvasElement | OffscreenCanvas,
  iconIndex: [number, number],
  whiteness: number,
): HTMLCanvasElement | OffscreenCanvas {
  if (!whiteIconCanvas) {
    whiteIconCanvas = typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(ICON_SIZE_16, ICON_SIZE_16)
      : Object.assign(document.createElement('canvas'), { width: ICON_SIZE_16, height: ICON_SIZE_16 });
  }
  const ctx = whiteIconCanvas.getContext('2d') as CanvasRenderingContext2D;
  const sx = iconIndex[0] * ICON_SIZE_16;
  const sy = iconIndex[1] * ICON_SIZE_16;
  const white = Math.max(0, Math.min(255, Math.trunc(255 * whiteness)));
  ctx.globalCompositeOperation = 'copy';
  ctx.drawImage(img, sx, sy, ICON_SIZE_16, ICON_SIZE_16, 0, 0, ICON_SIZE_16, ICON_SIZE_16);
  ctx.globalCompositeOperation = 'lighter';
  ctx.fillStyle = `rgb(${white},${white},${white})`;
  ctx.fillRect(0, 0, ICON_SIZE_16, ICON_SIZE_16);
  ctx.globalCompositeOperation = 'destination-in';
  ctx.drawImage(img, sx, sy, ICON_SIZE_16, ICON_SIZE_16, 0, 0, ICON_SIZE_16, ICON_SIZE_16);
  ctx.globalCompositeOperation = 'source-over';
  return whiteIconCanvas;
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
