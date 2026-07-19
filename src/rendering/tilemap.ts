import { Surface } from '../engine/surface';
import { SurfacePool } from '../engine/surface-pool';
import type { TilemapData, TilemapLayerData, TilesetData, NID } from '../data/types';
import { TILEWIDTH, TILEHEIGHT } from '../engine/constants';
import { WeatherSystem } from './weather';
import type { MapAnimation } from './map-animation';

/** Number of autotile animation frames (matches Python AUTOTILE_FRAMES). */
const AUTOTILE_FRAMES = 16;

/**
 * LayerObject - A single layer of a tilemap, pre-rendered to a Surface.
 * Supports animated autotile frames.
 */
/** Fade transition duration in ms (matches Python LayerObject.transition_speed). */
const LAYER_TRANSITION_SPEED = 333;

export class LayerObject {
  nid: string;
  visible: boolean;
  foreground: boolean;
  terrainGrid: Map<string, NID>; // "x,y" -> terrain NID
  surface: Surface | null = null;

  /** Pre-rendered autotile frames (one per AUTOTILE_FRAMES). */
  private autotileFrames: Surface[] = [];
  /** Current autotile frame index. */
  private autotileFrame: number = 0;
  /** Whether this layer has any autotiles. */
  hasAutotiles: boolean = false;

  /** Fade transition state: null | 'fade_in' | 'fade_out'. */
  state: 'fade_in' | 'fade_out' | null = null;
  /** Current translucence (1 = fully transparent, 0 = fully opaque), matching Python semantics. */
  translucence: number = 1;
  private startUpdate: number = 0;

  constructor(layerData: TilemapLayerData) {
    this.nid = layerData.nid;
    this.visible = layerData.visible;
    this.foreground = layerData.foreground;

    this.terrainGrid = new Map();
    for (const [key, terrainNid] of Object.entries(layerData.terrain_grid)) {
      this.terrainGrid.set(key, terrainNid);
    }
  }

  /**
   * Build the full surface from tileset images.
   * Tiles that have autotile animations are NOT placed on the static surface;
   * instead, they go into the autotile frame surfaces.
   */
  buildSurface(
    width: number,
    height: number,
    spriteGrid: Record<string, [NID, [number, number]]>,
    tilesetImages: Map<NID, HTMLImageElement>,
    tilesetAutotiles: Map<NID, Record<string, number>>,
    autotileImages: Map<NID, HTMLImageElement>,
  ): void {
    const pixelW = width * TILEWIDTH;
    const pixelH = height * TILEHEIGHT;
    this.surface = new Surface(pixelW, pixelH);

    // Build a set of autotile positions for quick lookup
    // A tile at sprite_grid position [tilesetNid, [col, row]] is an autotile if
    // tilesetAutotiles[tilesetNid]["col,row"] exists
    const autotileTiles: { mapX: number; mapY: number; tilesetNid: NID; column: number }[] = [];

    for (const [posKey, [tilesetNid, [tileCol, tileRow]]] of Object.entries(spriteGrid)) {
      const image = tilesetImages.get(tilesetNid);
      if (!image) continue;

      const parts = posKey.split(',');
      const mapX = parseInt(parts[0], 10);
      const mapY = parseInt(parts[1], 10);

      // Guard against malformed keys (NaN) or out-of-bounds coordinates
      if (isNaN(mapX) || isNaN(mapY) || mapX < 0 || mapY < 0 || mapX >= width || mapY >= height) {
        continue;
      }

      // Check if this tile position is an autotile
      const tsAutotiles = tilesetAutotiles.get(tilesetNid);
      const tileKey = `${tileCol},${tileRow}`;
      const autotileCol = tsAutotiles?.[tileKey];

      if (autotileCol !== undefined && autotileImages.has(tilesetNid)) {
        // This is an autotile — DON'T blit on static surface
        autotileTiles.push({ mapX, mapY, tilesetNid, column: autotileCol });
      } else {
        // Static tile — blit on the main surface
        const sx = tileCol * TILEWIDTH;
        const sy = tileRow * TILEHEIGHT;
        const dx = mapX * TILEWIDTH;
        const dy = mapY * TILEHEIGHT;
        this.surface.blitImage(image, sx, sy, TILEWIDTH, TILEHEIGHT, dx, dy);
      }
    }

    // Build autotile frame surfaces if there are any autotiles
    if (autotileTiles.length > 0) {
      this.hasAutotiles = true;
      for (let frameIdx = 0; frameIdx < AUTOTILE_FRAMES; frameIdx++) {
        const frameSurf = new Surface(pixelW, pixelH);
        for (const { mapX, mapY, tilesetNid, column } of autotileTiles) {
          const autoImg = autotileImages.get(tilesetNid);
          if (!autoImg) continue;
          // Source: column * TILEWIDTH, frameIdx * TILEHEIGHT
          const sx = column * TILEWIDTH;
          const sy = frameIdx * TILEHEIGHT;
          const dx = mapX * TILEWIDTH;
          const dy = mapY * TILEHEIGHT;
          frameSurf.blitImage(autoImg, sx, sy, TILEWIDTH, TILEHEIGHT, dx, dy);
        }
        this.autotileFrames.push(frameSurf);
      }
    }
  }

  /** Set the current autotile frame index. */
  setAutotileFrame(frame: number): void {
    this.autotileFrame = frame % AUTOTILE_FRAMES;
  }

  /** Get the current autotile frame surface (or null if no autotiles). */
  getAutotileImage(): Surface | null {
    if (!this.hasAutotiles || this.autotileFrames.length === 0) return null;
    return this.autotileFrames[this.autotileFrame] ?? null;
  }

  /** Current autotile frame index, for test/harness introspection. */
  getAutotileFrameIndex(): number {
    return this.autotileFrame;
  }

  /** Instantly show/hide (no fade). Matches Python quick_show/quick_hide. */
  quickShow(): void { this.visible = true; this.state = null; }
  quickHide(): void { this.visible = false; this.state = null; }

  /** Fade in the layer. Matches Python LayerObject.show(). */
  show(nowMs: number): void {
    if (!this.visible) {
      this.visible = true;
      this.state = 'fade_in';
      this.translucence = 1;
      this.startUpdate = nowMs;
    }
  }

  /** Fade out the layer. Matches Python LayerObject.hide(). */
  hide(nowMs: number): void {
    if (this.visible) {
      this.visible = false;
      this.state = 'fade_out';
      this.translucence = 0;
      this.startUpdate = nowMs;
    }
  }

  /**
   * Advance the fade transition. Matches Python LayerObject.update().
   * A layer that is fading out is still drawn (with dropping opacity) even
   * though `visible` has already flipped to false.
   */
  updateTransition(nowMs: number): void {
    if (this.state === 'fade_in') {
      this.translucence = 1 - (nowMs - this.startUpdate) / LAYER_TRANSITION_SPEED;
      if (this.translucence <= 0) {
        this.translucence = 0;
        this.state = null;
      }
    } else if (this.state === 'fade_out') {
      this.translucence = (nowMs - this.startUpdate) / LAYER_TRANSITION_SPEED;
      if (this.translucence >= 1) {
        this.translucence = 1;
        this.state = null;
      }
    }
  }

  /** Whether this layer should currently be drawn (visible, or fading out). */
  shouldDraw(): boolean {
    return this.visible || this.state === 'fade_out';
  }

  /** Opacity to render this layer at right now (1 = opaque). */
  get renderAlpha(): number {
    if (this.state === 'fade_in' || this.state === 'fade_out') {
      return Math.max(0, Math.min(1, 1 - this.translucence));
    }
    return 1;
  }
}

/**
 * TileMapObject - The full runtime tilemap with layers.
 * Matches LT's TileMapObject from app/engine/objects/tilemap.py
 */
export class TileMapObject {
  nid: NID;
  width: number; // in tiles
  height: number; // in tiles
  pixelWidth: number;
  pixelHeight: number;
  layers: LayerObject[] = [];

  /** Autotile animation timing. */
  private autotileFps: number = 29;
  private autotileWaitMs: number = 0;
  private hasAutotiles: boolean = false;

  /** Active weather systems. */
  weather: WeatherSystem[] = [];

  /** Map animations drawn below units. */
  animations: MapAnimation[] = [];
  /** Map animations drawn above units (overlay). */
  highAnimations: MapAnimation[] = [];

  /** Reusable surface for getFullImage (avoids per-frame allocation). */
  private _bgSurface: Surface | null = null;
  private _bgSurfW: number = 0;
  private _bgSurfH: number = 0;
  /** Reusable surface for getForegroundImage. */
  private _fgSurface: Surface | null = null;
  private _fgSurfW: number = 0;
  private _fgSurfH: number = 0;

  private constructor(nid: NID, width: number, height: number) {
    this.nid = nid;
    this.width = width;
    this.height = height;
    this.pixelWidth = width * TILEWIDTH;
    this.pixelHeight = height * TILEHEIGHT;
  }

  /**
   * Construct a TileMapObject from serialized prefab data and loaded tileset
   * images. Each layer's surface is pre-rendered from its sprite_grid.
   * Autotile data is used to build animated tile frame surfaces.
   */
  static fromPrefab(
    data: TilemapData,
    tilesetImages: Map<NID, HTMLImageElement>,
    tilesetDefs?: Map<NID, TilesetData>,
    autotileImages?: Map<NID, HTMLImageElement>,
  ): TileMapObject {
    const [w, h] = data.size;
    const tilemap = new TileMapObject(data.nid, w, h);
    tilemap.autotileFps = data.autotile_fps ?? 29;
    // autotile_wait = int(fps * 16.66) ms per frame
    tilemap.autotileWaitMs = tilemap.autotileFps > 0
      ? Math.floor(tilemap.autotileFps * 16.66)
      : 0;

    // Build autotile lookup per tileset
    const tilesetAutotiles = new Map<NID, Record<string, number>>();
    if (tilesetDefs) {
      for (const [nid, tsDef] of tilesetDefs) {
        if (tsDef.autotiles && Object.keys(tsDef.autotiles).length > 0) {
          tilesetAutotiles.set(nid, tsDef.autotiles);
        }
      }
    }

    for (const layerData of data.layers) {
      const layer = new LayerObject(layerData);
      layer.buildSurface(
        w, h, layerData.sprite_grid, tilesetImages,
        tilesetAutotiles,
        autotileImages ?? new Map(),
      );
      tilemap.layers.push(layer);
      if (layer.hasAutotiles) tilemap.hasAutotiles = true;
    }

    return tilemap;
  }

  /**
   * Update autotile animation frame based on elapsed time.
   * Call once per frame from the game loop.
   */
  updateAutotiles(currentTimeMs: number): void {
    if (this.hasAutotiles && this.autotileWaitMs > 0) {
      const frame = Math.floor(currentTimeMs / this.autotileWaitMs) % AUTOTILE_FRAMES;
      for (const layer of this.layers) {
        layer.setAutotileFrame(frame);
      }
    }
    // Advance any in-progress show/hide fade transitions (LayerObject.update()).
    for (const layer of this.layers) {
      if (layer.state) layer.updateTransition(currentTimeMs);
    }
  }

  /**
   * Get terrain at a tile position.
   * Walks layers top-to-bottom (last layer = highest priority) to find first
   * defined terrain. Returns '0' (default terrain NID) if no layer defines
   * terrain at this position, matching Python's tilemap.get_terrain() behaviour.
   */
  getTerrain(x: number, y: number): NID {
    const key = `${x},${y}`;
    // Iterate in reverse: highest layer has priority
    for (let i = this.layers.length - 1; i >= 0; i--) {
      const layer = this.layers[i];
      if (!layer.visible) continue;
      const terrain = layer.terrainGrid.get(key);
      if (terrain !== undefined) {
        return terrain;
      }
    }
    // Match Python default: return '0' for unmapped positions
    return '0';
  }

  /**
   * Get the full rendered image for the camera viewport (background layers only).
   * Composites all visible, non-foreground layers into a single surface and returns
   * only the portion visible within cullRect.
   */
  getFullImage(cullRect: { x: number; y: number; w: number; h: number }): Surface {
    // Reuse cached surface if dimensions match, otherwise allocate via pool
    if (!this._bgSurface || this._bgSurfW !== cullRect.w || this._bgSurfH !== cullRect.h) {
      if (this._bgSurface) SurfacePool.release(this._bgSurface);
      this._bgSurface = SurfacePool.acquire(cullRect.w, cullRect.h);
      this._bgSurfW = cullRect.w;
      this._bgSurfH = cullRect.h;
    } else {
      this._bgSurface.clear();
    }
    const result = this._bgSurface;

    for (const layer of this.layers) {
      if (!layer.shouldDraw() || layer.foreground || !layer.surface) continue;

      // Compute the overlap between the cull rect and the layer surface
      const srcX = Math.max(0, cullRect.x);
      const srcY = Math.max(0, cullRect.y);
      const srcRight = Math.min(this.pixelWidth, cullRect.x + cullRect.w);
      const srcBottom = Math.min(this.pixelHeight, cullRect.y + cullRect.h);

      if (srcRight <= srcX || srcBottom <= srcY) continue;

      const drawW = srcRight - srcX;
      const drawH = srcBottom - srcY;
      const destX = srcX - cullRect.x;
      const destY = srcY - cullRect.y;

      const alpha = layer.renderAlpha;
      layer.surface.setAlpha(alpha);
      // Static tiles
      result.blitFrom(layer.surface, srcX, srcY, drawW, drawH, destX, destY);
      layer.surface.setAlpha(1);

      // Autotile overlay
      const autoSurf = layer.getAutotileImage();
      if (autoSurf) {
        autoSurf.setAlpha(alpha);
        result.blitFrom(autoSurf, srcX, srcY, drawW, drawH, destX, destY);
        autoSurf.setAlpha(1);
      }
    }

    return result;
  }

  /**
   * Get foreground layers for drawing on top of units.
   * Returns null if no visible foreground layers exist.
   */
  getForegroundImage(cullRect: { x: number; y: number; w: number; h: number }): Surface | null {
    const hasForeground = this.layers.some(l => l.shouldDraw() && l.foreground && l.surface);
    if (!hasForeground) return null;

    // Reuse cached surface if dimensions match, otherwise allocate via pool
    if (!this._fgSurface || this._fgSurfW !== cullRect.w || this._fgSurfH !== cullRect.h) {
      if (this._fgSurface) SurfacePool.release(this._fgSurface);
      this._fgSurface = SurfacePool.acquire(cullRect.w, cullRect.h);
      this._fgSurfW = cullRect.w;
      this._fgSurfH = cullRect.h;
    } else {
      this._fgSurface.clear();
    }
    const result = this._fgSurface;

    for (const layer of this.layers) {
      if (!layer.shouldDraw() || !layer.foreground || !layer.surface) continue;

      const srcX = Math.max(0, cullRect.x);
      const srcY = Math.max(0, cullRect.y);
      const srcRight = Math.min(this.pixelWidth, cullRect.x + cullRect.w);
      const srcBottom = Math.min(this.pixelHeight, cullRect.y + cullRect.h);

      if (srcRight <= srcX || srcBottom <= srcY) continue;

      const drawW = srcRight - srcX;
      const drawH = srcBottom - srcY;
      const destX = srcX - cullRect.x;
      const destY = srcY - cullRect.y;

      const alpha = layer.renderAlpha;
      layer.surface.setAlpha(alpha);
      result.blitFrom(layer.surface, srcX, srcY, drawW, drawH, destX, destY);
      layer.surface.setAlpha(1);

      // Autotile overlay
      const autoSurf = layer.getAutotileImage();
      if (autoSurf) {
        autoSurf.setAlpha(alpha);
        result.blitFrom(autoSurf, srcX, srcY, drawW, drawH, destX, destY);
        autoSurf.setAlpha(1);
      }
    }

    return result;
  }

  /** Current autotile frame index (shared across all layers), for test/harness introspection. */
  getAutotileFrameIndex(): number {
    const layer = this.layers.find((l) => l.hasAutotiles);
    return layer ? layer.getAutotileFrameIndex() : 0;
  }

  /**
   * Show a layer by NID. Matches Python show_layer event command: fades in by
   * default (333ms), unless `transition === 'immediate'` in which case it pops
   * in instantly (Python's quick_show()).
   */
  showLayer(nid: string, transition: 'fade' | 'immediate' = 'fade', nowMs: number = Date.now()): void {
    const layer = this.layers.find(l => l.nid === nid);
    if (!layer) return;
    if (transition === 'immediate') {
      layer.quickShow();
    } else {
      layer.show(nowMs);
    }
  }

  /**
   * Hide a layer by NID. Matches Python hide_layer event command: fades out by
   * default (333ms), unless `transition === 'immediate'` (Python's quick_hide()).
   */
  hideLayer(nid: string, transition: 'fade' | 'immediate' = 'fade', nowMs: number = Date.now()): void {
    const layer = this.layers.find(l => l.nid === nid);
    if (!layer) return;
    if (transition === 'immediate') {
      layer.quickHide();
    } else {
      layer.hide(nowMs);
    }
  }

  /** Add a weather effect by NID. Does nothing if already active. */
  addWeather(nid: string): void {
    const lower = nid.toLowerCase();
    if (this.weather.some(w => w.nid === lower)) return;
    this.weather.push(new WeatherSystem(lower, this.width, this.height));
  }

  /** Remove a weather effect by NID. */
  removeWeather(nid: string): void {
    const lower = nid.toLowerCase();
    this.weather = this.weather.filter(w => w.nid !== lower);
  }

  /** Update all active weather systems. Call once per frame. */
  updateWeather(): void {
    for (const w of this.weather) {
      w.update();
    }
  }

  /** Check if a tile position is within map bounds. */
  checkBounds(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.width && y < this.height;
  }
}
