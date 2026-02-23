/**
 * Bitmap font rendering system — pixel-perfect GBA-style text.
 *
 * Loads font spritesheets (.png) and character index files (.idx)
 * from `resources/fonts/`. Supports variable-width characters,
 * color palette variants, stacked (shadow/glow) rendering, and
 * all the font variants from the original Lex Talionis engine.
 *
 * Usage:
 *   await initFonts(baseUrl);
 *   FONT['text'].blit(surf, 'Hello', 10, 10);
 *   FONT['text-blue'].blit(surf, 'Blue text', 10, 26);
 */

import { Surface, registerBmpDrawText, registerBmpDrawTextRight } from '../engine/surface';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single character glyph in the spritesheet */
interface CharGlyph {
  /** Pixel X position on sheet (col * cellWidth) */
  x: number;
  /** Pixel Y position on sheet (row * cellHeight) */
  y: number;
  /** Rendered pixel width of this character */
  charWidth: number;
}

/** Font metadata from fonts.json */
interface FontDef {
  nid: string;
  fallback_ttf: string | null;
  fallback_size: number;
  default_color: string | null;
  outline_font: boolean;
  palettes: Record<string, number[][]>; // color name -> array of [r,g,b,a] tuples
}

// ---------------------------------------------------------------------------
// BmpFont class
// ---------------------------------------------------------------------------

export class BmpFont {
  readonly nid: string;
  readonly height: number;

  private cellWidth: number;
  private cellHeight: number;
  private chartable: Map<string, CharGlyph> = new Map();
  private allUppercase: boolean = false;
  private allLowercase: boolean = false;
  private stacked: boolean = false;
  private spaceOffset: number = 0;

  /** Spritesheet surfaces keyed by color name (or 'default') */
  private surfaces: Map<string, Surface> = new Map();

  /** The default color name (e.g. 'white', 'black') */
  private defaultColor: string;

  /** Glyph cache: `${char}:${color}` -> Surface */
  private glyphCache: Map<string, { surf: Surface; width: number }> = new Map();

  constructor(
    nid: string,
    defaultColor: string,
    baseSurface: Surface,
    chartable: Map<string, CharGlyph>,
    cellWidth: number,
    cellHeight: number,
    flags: { allUppercase?: boolean; allLowercase?: boolean; stacked?: boolean; spaceOffset?: number }
  ) {
    this.nid = nid;
    this.defaultColor = defaultColor;
    this.cellWidth = cellWidth;
    this.cellHeight = cellHeight;
    this.chartable = chartable;
    this.allUppercase = flags.allUppercase ?? false;
    this.allLowercase = flags.allLowercase ?? false;
    this.stacked = flags.stacked ?? false;
    this.spaceOffset = flags.spaceOffset ?? 0;

    // The visible height of the font: for stacked fonts, it's the cellHeight
    // (the lower half is the shadow layer)
    this.height = cellHeight;

    this.surfaces.set(defaultColor || 'default', baseSurface);
  }

  /** Add a color variant surface */
  addColorVariant(colorName: string, surface: Surface): void {
    this.surfaces.set(colorName, surface);
  }

  /** Copy all color variant surfaces from another font */
  copyVariantsFrom(other: BmpFont): void {
    for (const [key, surf] of other.surfaces) {
      this.surfaces.set(key, surf);
    }
  }

  /** Get text width in pixels */
  width(text: string): number {
    const str = this.modifyString(text);
    let w = 0;
    for (let i = 0; i < str.length; i++) {
      const glyph = this.chartable.get(str[i]);
      if (glyph) {
        w += glyph.charWidth + this.spaceOffset;
      } else {
        // Fallback: assume average width
        w += Math.floor(this.cellWidth * 0.6) + this.spaceOffset;
      }
    }
    // Remove trailing spaceOffset
    if (str.length > 0) w -= this.spaceOffset;
    return w;
  }

  /** Get (width, height) of rendered text */
  size(text: string): [number, number] {
    return [this.width(text), this.height];
  }

  /** Draw text at (x, y) on the target surface */
  blit(surf: Surface, text: string, x: number, y: number, color?: string): void {
    const str = this.modifyString(text);
    const colorKey = color ?? this.defaultColor ?? 'default';
    let left = x;

    for (let i = 0; i < str.length; i++) {
      const ch = str[i];
      const result = this.getGlyph(ch, colorKey);
      if (result) {
        surf.blit(result.surf, left, y);
        left += result.width + this.spaceOffset;
      } else {
        // Skip unknown characters with fallback width
        left += Math.floor(this.cellWidth * 0.6) + this.spaceOffset;
      }
    }
  }

  /** Draw text right-aligned so the text ends at x */
  blitRight(surf: Surface, text: string, x: number, y: number, color?: string): void {
    const w = this.width(text);
    this.blit(surf, text, x - w, y, color);
  }

  /** Draw text centered on x */
  blitCenter(surf: Surface, text: string, x: number, y: number, color?: string): void {
    const w = this.width(text);
    this.blit(surf, text, x - Math.floor(w / 2), y, color);
  }

  /** Get a single character glyph (with caching) */
  private getGlyph(ch: string, colorKey: string): { surf: Surface; width: number } | null {
    const cacheKey = `${ch}:${colorKey}`;
    let cached = this.glyphCache.get(cacheKey);
    if (cached) return cached;

    const glyph = this.chartable.get(ch);
    if (!glyph) return null;

    const sheet = this.surfaces.get(colorKey) ?? this.surfaces.get(this.defaultColor) ?? this.surfaces.get('default');
    if (!sheet) return null;

    if (this.stacked) {
      // Stacked: draw lower half first (shadow), then upper half on top
      const glyphSurf = new Surface(this.cellWidth, this.cellHeight);
      // Lower layer (shadow) at y + cellHeight
      const lowSrc = sheet.subsurface(glyph.x, glyph.y + this.cellHeight, this.cellWidth, this.cellHeight);
      glyphSurf.blit(lowSrc, 0, 0);
      // Upper layer (main) on top
      const highSrc = sheet.subsurface(glyph.x, glyph.y, this.cellWidth, this.cellHeight);
      glyphSurf.blit(highSrc, 0, 0);
      cached = { surf: glyphSurf, width: glyph.charWidth };
    } else {
      // Normal: just extract the glyph rectangle
      const glyphSurf = sheet.subsurface(glyph.x, glyph.y, this.cellWidth, this.cellHeight);
      cached = { surf: glyphSurf, width: glyph.charWidth };
    }

    this.glyphCache.set(cacheKey, cached);
    return cached;
  }

  /** Apply uppercase/lowercase transforms */
  private modifyString(text: string): string {
    if (this.allUppercase) return text.toUpperCase();
    if (this.allLowercase) return text.toLowerCase();
    return text;
  }
}

// ---------------------------------------------------------------------------
// IDX parser
// ---------------------------------------------------------------------------

interface ParsedIdx {
  cellWidth: number;
  cellHeight: number;
  allUppercase: boolean;
  allLowercase: boolean;
  stacked: boolean;
  spaceOffset: number;
  chartable: Map<string, CharGlyph>;
}

function parseIdx(idxText: string): ParsedIdx {
  let cellWidth = 8;
  let cellHeight = 16;
  let allUppercase = false;
  let allLowercase = false;
  let stacked = false;
  let spaceOffset = 0;
  const chartable = new Map<string, CharGlyph>();

  const lines = idxText.split('\n');
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    // Check for directives
    if (line.startsWith('width')) {
      const parts = line.split(/\s+/);
      cellWidth = parseInt(parts[1], 10);
      continue;
    }
    if (line.startsWith('height')) {
      const parts = line.split(/\s+/);
      cellHeight = parseInt(parts[1], 10);
      continue;
    }
    if (line === 'alluppercase') { allUppercase = true; continue; }
    if (line === 'alllowercase') { allLowercase = true; continue; }
    if (line === 'stacked') { stacked = true; continue; }
    if (line.startsWith('space_offset')) {
      const parts = line.split(/\s+/);
      spaceOffset = parseInt(parts[1], 10);
      continue;
    }
    if (line.startsWith('transrgb')) continue; // Legacy, skip

    // Character entry: CHAR COL ROW CHAR_WIDTH
    const parts = line.split(/\s+/);
    if (parts.length >= 4) {
      let ch = parts[0];
      if (ch === 'space') ch = ' ';
      const col = parseInt(parts[1], 10);
      const row = parseInt(parts[2], 10);
      const charWidth = parseInt(parts[3], 10);

      chartable.set(ch, {
        x: col * cellWidth,
        y: row * cellHeight,
        charWidth,
      });
    }
  }

  return { cellWidth, cellHeight, allUppercase, allLowercase, stacked, spaceOffset, chartable };
}

// ---------------------------------------------------------------------------
// Color conversion for palette variants
// ---------------------------------------------------------------------------

/**
 * Create a color-converted copy of a font spritesheet.
 * Maps pixels matching colors in `fromPalette` to corresponding colors in `toPalette`.
 */
function colorConvertFont(baseSurface: Surface, fromPalette: number[][], toPalette: number[][]): Surface {
  const result = baseSurface.copy();
  const imageData = result.getImageData();
  const data = imageData.data;

  // Build a lookup map: "r,g,b" -> [newR, newG, newB, newA]
  const colorMap = new Map<string, number[]>();
  const len = Math.min(fromPalette.length, toPalette.length);
  for (let i = 0; i < len; i++) {
    const from = fromPalette[i];
    const to = toPalette[i];
    colorMap.set(`${from[0]},${from[1]},${from[2]}`, to);
  }

  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue; // Skip fully transparent pixels
    const key = `${data[i]},${data[i + 1]},${data[i + 2]}`;
    const mapped = colorMap.get(key);
    if (mapped) {
      data[i] = mapped[0];
      data[i + 1] = mapped[1];
      data[i + 2] = mapped[2];
      if (mapped.length > 3) data[i + 3] = mapped[3];
    }
  }

  result.putImageData(imageData);
  return result;
}

// ---------------------------------------------------------------------------
// Font Registry
// ---------------------------------------------------------------------------

/** Global font registry. Access fonts by NID: FONT['text'], FONT['text-blue'], etc. */
export const FONT: Record<string, BmpFont> = {};

/** Whether fonts have been initialized */
let fontsReady = false;

/** Check if fonts are loaded */
export function areFontsReady(): boolean {
  return fontsReady;
}

/**
 * Initialize the font system. Loads fonts.json, then loads all font
 * spritesheets and .idx files, creates color variants.
 *
 * @param baseUrl - Base URL for game data (e.g. '/game-data/default.ltproj')
 */
export async function initFonts(baseUrl: string): Promise<void> {
  const fontsUrl = `${baseUrl}/resources/fonts/fonts.json`;
  let fontDefs: FontDef[];
  try {
    const resp = await fetch(fontsUrl);
    if (!resp.ok) {
      console.warn(`[BmpFont] Failed to load fonts.json: ${resp.status}`);
      return;
    }
    fontDefs = await resp.json();
  } catch (e) {
    console.warn('[BmpFont] Failed to fetch fonts.json:', e);
    return;
  }

  // Load all fonts in parallel
  const loadPromises = fontDefs.map(async (def) => {
    try {
      await loadFont(def, baseUrl);
    } catch (e) {
      console.warn(`[BmpFont] Failed to load font '${def.nid}':`, e);
    }
  });

  await Promise.all(loadPromises);
  fontsReady = true;

  // Register the BMP draw callbacks on Surface
  registerBmpDrawText(bmpDrawText);
  registerBmpDrawTextRight(bmpDrawTextRight);

  console.log(`[BmpFont] Loaded ${Object.keys(FONT).length} font variants`);
}

async function loadFont(def: FontDef, baseUrl: string): Promise<void> {
  const pngUrl = `${baseUrl}/resources/fonts/${encodeURIComponent(def.nid)}.png`;
  const idxUrl = `${baseUrl}/resources/fonts/${encodeURIComponent(def.nid)}.idx`;

  // Fetch PNG and IDX in parallel
  const [imgResp, idxResp] = await Promise.all([
    loadImage(pngUrl),
    fetch(idxUrl).then(r => r.ok ? r.text() : null),
  ]);

  if (!imgResp || !idxResp) {
    console.warn(`[BmpFont] Missing files for font '${def.nid}'`);
    return;
  }

  // Parse the IDX file
  const parsed = parseIdx(idxResp);

  // Create the base surface from the image
  const baseSurface = surfaceFromImg(imgResp);

  // Create the base BmpFont
  const defaultColor = def.default_color ?? 'default';
  const font = new BmpFont(
    def.nid,
    defaultColor,
    baseSurface,
    parsed.chartable,
    parsed.cellWidth,
    parsed.cellHeight,
    {
      allUppercase: parsed.allUppercase,
      allLowercase: parsed.allLowercase,
      stacked: parsed.stacked,
      spaceOffset: parsed.spaceOffset,
    }
  );

  // Register the base font
  FONT[def.nid] = font;

  // Create color variants
  const palettes = def.palettes || {};
  const defaultPalette = palettes[defaultColor];

  for (const [colorName, palette] of Object.entries(palettes)) {
    if (colorName === defaultColor) {
      // The base surface already uses this palette
      font.addColorVariant(colorName, baseSurface);
    } else if (defaultPalette) {
      // Create a color-converted variant
      const variantSurf = colorConvertFont(baseSurface, defaultPalette, palette);
      font.addColorVariant(colorName, variantSurf);
    }

  }

  // Register shortcut fonts: "fontNid-colorName" -> same font with a
  // different default color. We create a lightweight BmpFont that
  // shares the parent's chartable and color surfaces.
  for (const colorName of Object.keys(palettes)) {
    if (colorName === defaultColor) continue;
    const shortcutFont = new BmpFont(
      `${def.nid}-${colorName}`,
      colorName,
      baseSurface,
      parsed.chartable,
      parsed.cellWidth,
      parsed.cellHeight,
      {
        allUppercase: parsed.allUppercase,
        allLowercase: parsed.allLowercase,
        stacked: parsed.stacked,
        spaceOffset: parsed.spaceOffset,
      }
    );
    // Share all the color variant surfaces from the parent font
    shortcutFont.copyVariantsFrom(font);
    FONT[`${def.nid}-${colorName}`] = shortcutFont;
  }
}

// ---------------------------------------------------------------------------
// Helper utilities
// ---------------------------------------------------------------------------

function loadImage(url: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => {
      console.warn(`[BmpFont] Failed to load image: ${url}`);
      resolve(null);
    };
    img.src = url;
  });
}

function surfaceFromImg(img: HTMLImageElement): Surface {
  const s = new Surface(img.width, img.height);
  s.ctx.drawImage(img, 0, 0);
  return s;
}

// ---------------------------------------------------------------------------
// BMP draw callback for Surface.drawText integration
// ---------------------------------------------------------------------------

/**
 * Map CSS color strings to BMP font palette color names.
 * Covers all colors currently used in the codebase.
 */
const CSS_TO_FONT_COLOR: Record<string, string> = {
  'white': 'white',
  '#FFD700': 'yellow',
  'rgb(220,200,80)': 'yellow',
  'rgba(255,255,128,1)': 'yellow',
  'rgba(248,240,136,1)': 'yellow',
  'rgba(255,240,200,1)': 'yellow',
  'rgba(180,180,220,1)': 'grey',
  'rgba(200,200,255,1)': 'blue',
  'rgba(200,200,220,0.6)': 'grey',
  'rgba(160,160,200,1)': 'grey',
  'rgba(128,128,128,1)': 'grey',
  'rgba(200,200,200,1)': 'grey',
  'rgba(160,160,160,1)': 'grey',
  'rgba(220, 220, 220, 1)': 'grey',
  '#90D0FF': 'blue',
  'rgba(80, 80, 140, 0.7)': 'blue',
  'rgba(140,140,180,1)': 'grey',
  'rgba(255,255,255,1)': 'white',
  'rgba(220,220,255,1)': 'white',
};

/**
 * Callback registered with Surface to intercept drawText calls.
 * Tries to render with BMP fonts; returns true if successful,
 * false to fall back to Canvas fillText.
 */
function bmpDrawText(surf: Surface, text: string, x: number, y: number, color: string, fontStr: string): boolean {
  if (!fontsReady) return false;

  // Check if fontStr is already a BMP font NID (e.g. 'text', 'text-blue', 'convo')
  if (FONT[fontStr]) {
    FONT[fontStr].blit(surf, text, x, y);
    return true;
  }

  // Check if it's a CSS font string — map to BMP font based on size
  const sizeMatch = fontStr.match(/(\d+(?:\.\d+)?)px/);
  if (!sizeMatch) return false;

  const size = parseFloat(sizeMatch[1]);

  // Map font size to BMP font NID
  let fontNid: string;
  if (size <= 7) {
    fontNid = 'small';
  } else {
    fontNid = 'text';
  }

  const font = FONT[fontNid];
  if (!font) return false;

  // Resolve CSS color to palette color name
  const paletteColor = CSS_TO_FONT_COLOR[color] ?? 'white';

  font.blit(surf, text, x, y, paletteColor);
  return true;
}

/**
 * Right-aligned BMP font draw callback for Surface.drawTextRight.
 * Text ends at x (x is the right edge).
 */
function bmpDrawTextRight(surf: Surface, text: string, x: number, y: number, color: string, fontStr: string): boolean {
  if (!fontsReady) return false;

  if (FONT[fontStr]) {
    FONT[fontStr].blitRight(surf, text, x, y);
    return true;
  }

  const sizeMatch = fontStr.match(/(\d+(?:\.\d+)?)px/);
  if (!sizeMatch) return false;

  const size = parseFloat(sizeMatch[1]);
  let fontNid: string;
  if (size <= 7) {
    fontNid = 'small';
  } else {
    fontNid = 'text';
  }

  const font = FONT[fontNid];
  if (!font) return false;

  const paletteColor = CSS_TO_FONT_COLOR[color] ?? 'white';
  font.blitRight(surf, text, x, y, paletteColor);
  return true;
}
