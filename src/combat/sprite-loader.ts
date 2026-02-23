/**
 * sprite-loader.ts
 *
 * Loads combat animation spritesheets and applies palette conversion.
 *
 * The LT engine stores combat anim spritesheets with palette-encoded pixels:
 * each pixel RGB is (0, x, y) where (x, y) is a coordinate into the palette
 * grid. At load time, we remap every pixel to its target color from the
 * palette, then extract individual frames as HTMLCanvasElement tiles.
 *
 * The COLORKEY (128, 160, 128) is treated as fully transparent.
 */

import type { PaletteData, BattleAnimFrame, WeaponAnimData, CombatAnimData } from './battle-anim-types';
import type { ResourceManager } from '../data/resource-manager';
import { loadWeaponAnimSpritesheet } from '../data/loaders/combat-anim-loader';

// -----------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------

/** The chromakey color that should be treated as transparent. */
const COLORKEY_R = 128;
const COLORKEY_G = 160;
const COLORKEY_B = 128;

// -----------------------------------------------------------------------
// Palette conversion
// -----------------------------------------------------------------------

/**
 * Build a lookup table for palette conversion.
 *
 * The input palette maps "x,y" coords to [r, g, b].
 * The output maps packed RGB(0, x, y) values to packed target RGBA values.
 * We use a Map<number, number> where the key is (g << 8 | b) since R is
 * always 0 in palette-encoded pixels.
 */
function buildPaletteLUT(palette: PaletteData): Map<number, [number, number, number, number]> {
  const lut = new Map<number, [number, number, number, number]>();

  for (const [coordKey, [r, g, b]] of palette.colors) {
    const parts = coordKey.split(',');
    const px = parseInt(parts[0], 10);
    const py = parseInt(parts[1], 10);
    const key = (px << 8) | py; // pack the palette coord

    // Check if this maps to the COLORKEY → make transparent
    if (r === COLORKEY_R && g === COLORKEY_G && b === COLORKEY_B) {
      lut.set(key, [0, 0, 0, 0]);
    } else {
      lut.set(key, [r, g, b, 255]);
    }
  }

  return lut;
}

/**
 * Apply palette conversion to image pixel data in-place.
 *
 * For each pixel:
 *  - If R === 0, treat (G, B) as palette coordinates and look up the target color
 *  - If the target color is COLORKEY, set alpha to 0 (transparent)
 *  - If no palette entry matches, leave the pixel as-is (but make R=0 pixels transparent)
 *
 * Also handles raw COLORKEY pixels that aren't palette-encoded.
 */
function applyPaletteToImageData(
  imageData: ImageData,
  lut: Map<number, [number, number, number, number]>,
): void {
  const data = imageData.data;
  const len = data.length;

  for (let i = 0; i < len; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];

    // Check for literal COLORKEY pixels (might appear in some spritesheets)
    if (r === COLORKEY_R && g === COLORKEY_G && b === COLORKEY_B) {
      data[i] = 0;
      data[i + 1] = 0;
      data[i + 2] = 0;
      data[i + 3] = 0;
      continue;
    }

    // Palette-encoded pixels have R=0
    if (r === 0) {
      const key = (g << 8) | b;
      const replacement = lut.get(key);
      if (replacement) {
        data[i] = replacement[0];
        data[i + 1] = replacement[1];
        data[i + 2] = replacement[2];
        data[i + 3] = replacement[3];
      } else {
        // Unknown palette coordinate — make transparent
        data[i + 3] = 0;
      }
    }
    // Non-palette pixels (R != 0 and not COLORKEY) are left unchanged
  }
}

// -----------------------------------------------------------------------
// Frame extraction
// -----------------------------------------------------------------------

/**
 * Extract individual frames from a palette-converted spritesheet canvas.
 *
 * @param sheetCanvas - The full spritesheet with palette conversion applied
 * @param frames - Frame definitions from the weapon anim data
 * @returns Map from frame nid to extracted HTMLCanvasElement
 */
function extractFrames(
  sheetCanvas: HTMLCanvasElement,
  frames: BattleAnimFrame[],
): Map<string, HTMLCanvasElement> {
  const result = new Map<string, HTMLCanvasElement>();
  const srcCtx = sheetCanvas.getContext('2d')!;

  for (const frame of frames) {
    const [sx, sy, sw, sh] = frame.rect;

    // Skip degenerate frames
    if (sw <= 0 || sh <= 0) continue;

    // Clamp to spritesheet bounds
    const clampedW = Math.min(sw, sheetCanvas.width - sx);
    const clampedH = Math.min(sh, sheetCanvas.height - sy);
    if (clampedW <= 0 || clampedH <= 0) continue;

    const frameCanvas = document.createElement('canvas');
    frameCanvas.width = sw;
    frameCanvas.height = sh;
    const frameCtx = frameCanvas.getContext('2d')!;

    // Copy the sub-region
    frameCtx.drawImage(
      sheetCanvas,
      sx, sy, clampedW, clampedH,
      0, 0, clampedW, clampedH,
    );

    result.set(frame.nid, frameCanvas);
  }

  return result;
}

// -----------------------------------------------------------------------
// Colorkey transparency (no palette)
// -----------------------------------------------------------------------

/**
 * Make all COLORKEY pixels transparent in raw image data.
 * Used when no palette is available (e.g. pre-colored effect spritesheets).
 */
function applyColorkey(data: Uint8ClampedArray): void {
  for (let i = 0; i < data.length; i += 4) {
    if (data[i] === COLORKEY_R && data[i + 1] === COLORKEY_G && data[i + 2] === COLORKEY_B) {
      data[i + 3] = 0; // Make transparent
    }
  }
}

// -----------------------------------------------------------------------
// Spritesheet-to-frames conversion (for effects)
// -----------------------------------------------------------------------

/**
 * Convert a loaded spritesheet image into individual frame canvases.
 *
 * Applies palette conversion if a palette is provided, otherwise just
 * applies colorkey transparency. Used for combat effect spritesheets.
 *
 * @param img - The loaded spritesheet HTMLImageElement
 * @param frames - Frame definitions (nid, rect, offset)
 * @param palette - Optional palette for color remapping
 * @returns Map from frame nid to HTMLCanvasElement
 */
export function convertSpritesheetToFrames(
  img: HTMLImageElement,
  frames: BattleAnimFrame[],
  palette: PaletteData | null,
): Map<string, HTMLCanvasElement> {
  const result = new Map<string, HTMLCanvasElement>();

  // Draw the full spritesheet to a canvas to get pixel data
  const fullCanvas = document.createElement('canvas');
  fullCanvas.width = img.naturalWidth || img.width;
  fullCanvas.height = img.naturalHeight || img.height;
  const fullCtx = fullCanvas.getContext('2d', { willReadFrequently: true })!;
  fullCtx.drawImage(img, 0, 0);

  // Apply palette conversion to the full sheet if palette provided
  const imageData = fullCtx.getImageData(0, 0, fullCanvas.width, fullCanvas.height);
  if (palette) {
    const lut = buildPaletteLUT(palette);
    applyPaletteToImageData(imageData, lut);
  } else {
    // Still apply colorkey transparency even without palette
    applyColorkey(imageData.data);
  }
  fullCtx.putImageData(imageData, 0, 0);

  // Extract each frame as a separate canvas
  for (const frame of frames) {
    const [sx, sy, sw, sh] = frame.rect;
    if (sw <= 0 || sh <= 0) continue;

    const frameCanvas = document.createElement('canvas');
    frameCanvas.width = sw;
    frameCanvas.height = sh;
    const frameCtx = frameCanvas.getContext('2d')!;
    frameCtx.drawImage(fullCanvas, sx, sy, sw, sh, 0, 0, sw, sh);

    result.set(frame.nid, frameCanvas);
  }

  return result;
}

// -----------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------

/**
 * Load a weapon animation's spritesheet, apply palette conversion, and
 * extract all frames.
 *
 * @param resources - ResourceManager for fetching the PNG
 * @param combatAnimNid - e.g. "Eirika_Lord"
 * @param weaponAnim - The weapon animation data (contains frame definitions)
 * @param palette - The palette to apply
 * @returns Map from frame nid to palette-converted HTMLCanvasElement, or null if loading fails
 */
export async function loadAndConvertWeaponAnim(
  resources: ResourceManager,
  combatAnimNid: string,
  weaponAnim: WeaponAnimData,
  palette: PaletteData,
): Promise<Map<string, HTMLCanvasElement> | null> {
  // Load the raw spritesheet image
  const sheetImage = await loadWeaponAnimSpritesheet(resources, combatAnimNid, weaponAnim.nid);
  if (!sheetImage) {
    console.warn(`sprite-loader: spritesheet not found for ${combatAnimNid}-${weaponAnim.nid}`);
    return null;
  }

  // Draw onto a canvas so we can manipulate pixel data
  const sheetCanvas = document.createElement('canvas');
  sheetCanvas.width = sheetImage.naturalWidth;
  sheetCanvas.height = sheetImage.naturalHeight;
  const ctx = sheetCanvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(sheetImage, 0, 0);

  // Get pixel data for palette conversion
  const imageData = ctx.getImageData(0, 0, sheetCanvas.width, sheetCanvas.height);

  // Build palette LUT and apply conversion
  const lut = buildPaletteLUT(palette);
  applyPaletteToImageData(imageData, lut);

  // Write converted pixels back
  ctx.putImageData(imageData, 0, 0);

  // Extract individual frames
  return extractFrames(sheetCanvas, weaponAnim.frames);
}

/**
 * Select the appropriate palette for a unit from a combat animation's palette list.
 *
 * Priority order:
 *  1. Match by unit name
 *  2. Match by unit nid
 *  3. Match by unit variant
 *  4. Match by team palette name (e.g. "GenericBlue" for player team)
 *  5. First palette in the list
 *
 * @param combatAnim - The combat animation data with palette list
 * @param unit - The unit to select a palette for
 * @param allPalettes - All loaded palettes
 * @returns The selected PaletteData, or null if no palette found
 */
export function selectPalette(
  combatAnim: CombatAnimData,
  unit: { name: string; nid: string; variant?: string; team: string },
  allPalettes: Map<string, PaletteData>,
): PaletteData | null {
  if (combatAnim.palettes.length === 0) return null;

  // Team → palette name mapping
  const teamPaletteNames: Record<string, string> = {
    'player': 'GenericBlue',
    'enemy': 'GenericRed',
    'enemy2': 'GenericPurple',
    'other': 'GenericGreen',
  };

  // Try matching by priority
  for (const [paletteName, paletteNid] of combatAnim.palettes) {
    if (paletteName === unit.name || paletteName === unit.nid) {
      const pal = allPalettes.get(paletteNid);
      if (pal) return pal;
    }
  }

  // Try variant
  if (unit.variant) {
    for (const [paletteName, paletteNid] of combatAnim.palettes) {
      if (paletteName === unit.variant) {
        const pal = allPalettes.get(paletteNid);
        if (pal) return pal;
      }
    }
  }

  // Try team palette
  const teamPalName = teamPaletteNames[unit.team] ?? 'GenericBlue';
  for (const [paletteName, paletteNid] of combatAnim.palettes) {
    if (paletteName === teamPalName) {
      const pal = allPalettes.get(paletteNid);
      if (pal) return pal;
    }
  }

  // Fallback: first palette
  const [, firstPaletteNid] = combatAnim.palettes[0];
  return allPalettes.get(firstPaletteNid) ?? null;
}

/**
 * Determine the weapon animation to use for a unit given their equipped item.
 *
 * Looks for a matching weapon type in the combat animation's weapon_anims list.
 * Falls back to "Unarmed" if no match.
 *
 * @param combatAnim - The combat animation data
 * @param weaponType - The weapon type string from the equipped item (e.g. "Sword", "Lance")
 * @returns The matching WeaponAnimData, or null if no animation found
 */
export function selectWeaponAnim(
  combatAnim: CombatAnimData,
  weaponType: string | null,
): WeaponAnimData | null {
  if (!weaponType) {
    // Try Unarmed
    return combatAnim.weapon_anims.find(wa => wa.nid === 'Unarmed') ?? null;
  }

  // Direct match (e.g. "MagicAnima", "Sword", item-specific "MagicElfire")
  const direct = combatAnim.weapon_anims.find(wa => wa.nid === weaponType);
  if (direct) return direct;

  // For magic types (prefixed with "Magic"), try fallbacks:
  // MagicAnima -> Magic -> MagicGeneric
  if (weaponType.startsWith('Magic')) {
    const magicFallbacks = ['Magic', 'MagicGeneric'];
    for (const fb of magicFallbacks) {
      const found = combatAnim.weapon_anims.find(wa => wa.nid === fb);
      if (found) return found;
    }
  }

  // For ranged types (prefixed with "Ranged"), try stripping the prefix:
  // RangedBow -> Bow
  if (weaponType.startsWith('Ranged')) {
    const base = weaponType.slice(6); // strip "Ranged"
    const found = combatAnim.weapon_anims.find(wa => wa.nid === base);
    if (found) return found;
  }

  // Try generic weapon categories for non-prefixed types
  const genericMappings: Record<string, string[]> = {
    'Sword': ['Sword'],
    'Lance': ['Lance'],
    'Axe': ['Axe'],
    'Bow': ['Bow', 'RangedBow'],
  };

  const candidates = genericMappings[weaponType];
  if (candidates) {
    for (const candidate of candidates) {
      const found = combatAnim.weapon_anims.find(wa => wa.nid === candidate);
      if (found) return found;
    }
  }

  // Last resort: Unarmed
  return combatAnim.weapon_anims.find(wa => wa.nid === 'Unarmed') ?? null;
}

// -----------------------------------------------------------------------
// Platform image loading
// -----------------------------------------------------------------------

/** Base URL for engine-level shared assets (set once at init). */
let engineBaseUrl: string = '/game-data';

/** Initialize the sprite-loader system with the engine base URL (parent of .ltproj dirs). */
export function initSpriteLoader(url: string): void {
  engineBaseUrl = url.replace(/\/$/, '');
}

/** Cached platform images: key is "{TerrainType}-{Melee|Ranged}" */
const platformCache = new Map<string, HTMLImageElement>();

/**
 * Load a platform image for the battle scene.
 *
 * Platforms are per-project resources, stored at:
 *   {baseUrl}/resources/platforms/{terrainPlatform}-{Melee|Ranged}.png
 *
 * The right-side platform should be drawn flipped horizontally by the renderer.
 *
 * @param terrainPlatform - The terrain's platform type (e.g. "Plains", "Forest")
 * @param melee - True for melee range (87x40), false for ranged (100x40)
 * @returns The platform image, or null if not found
 */
export async function loadPlatformImage(
  terrainPlatform: string,
  melee: boolean,
): Promise<HTMLImageElement | null> {
  const suffix = melee ? 'Melee' : 'Ranged';
  const key = `${terrainPlatform}-${suffix}`;

  const cached = platformCache.get(key);
  if (cached) return cached;

  const url = `${engineBaseUrl}/resources/platforms/${encodeURIComponent(key)}.png`;

  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.crossOrigin = 'anonymous';
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error(`Failed to load platform: ${url}`));
      el.src = url;
    });
    platformCache.set(key, img);
    return img;
  } catch {
    // Try fallback to Arena
    if (terrainPlatform !== 'Arena') {
      return loadPlatformImage('Arena', melee);
    }
    return null;
  }
}

/**
 * Load both platforms for a battle scene.
 *
 * @param leftTerrainPlatform - Platform type for the left combatant
 * @param rightTerrainPlatform - Platform type for the right combatant
 * @param melee - Whether this is melee range combat
 * @returns [leftPlatformImg, rightPlatformImg] — either or both may be null
 */
export async function loadBattlePlatforms(
  leftTerrainPlatform: string,
  rightTerrainPlatform: string,
  melee: boolean,
): Promise<[HTMLImageElement | null, HTMLImageElement | null]> {
  const [left, right] = await Promise.all([
    loadPlatformImage(leftTerrainPlatform, melee),
    loadPlatformImage(rightTerrainPlatform, melee),
  ]);
  return [left, right];
}
