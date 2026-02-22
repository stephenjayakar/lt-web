import { Surface } from '../engine/surface';
import type { TilemapData, TilemapLayerData, TilesetData, NID } from '../data/types';
import { TILEWIDTH, TILEHEIGHT } from '../engine/constants';
import { WeatherSystem } from './weather';

/** Number of autotile animation frames (matches Python AUTOTILE_FRAMES). */
const AUTOTILE_FRAMES = 16;

/**
 * LayerObject - A single layer of a tilemap, pre-rendered to a Surface.
 * Supports animated autotile frames.
 */
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
    if (!this.hasAutotiles || this.autotileWaitMs <= 0) return;
    const frame = Math.floor(currentTimeMs / this.autotileWaitMs) % AUTOTILE_FRAMES;
    for (const layer of this.layers) {
      layer.setAutotileFrame(frame);
    }
  }

  /**
   * Get terrain at a tile position.
   * Walks layers top-to-bottom (last layer = highest priority) to find first
   * defined terrain. Returns null if no layer defines terrain at this position.
   */
  getTerrain(x: number, y: number): NID | null {
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
    return null;
  }

  /**
   * Get the full rendered image for the camera viewport (background layers only).
   * Composites all visible, non-foreground layers into a single surface and returns
   * only the portion visible within cullRect.
   */
  getFullImage(cullRect: { x: number; y: number; w: number; h: number }): Surface {
    const result = new Surface(cullRect.w, cullRect.h);

    for (const layer of this.layers) {
      if (!layer.visible || layer.foreground || !layer.surface) continue;

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

      // Static tiles
      result.blitFrom(layer.surface, srcX, srcY, drawW, drawH, destX, destY);

      // Autotile overlay
      const autoSurf = layer.getAutotileImage();
      if (autoSurf) {
        result.blitFrom(autoSurf, srcX, srcY, drawW, drawH, destX, destY);
      }
    }

    return result;
  }

  /**
   * Get foreground layers for drawing on top of units.
   * Returns null if no visible foreground layers exist.
   */
  getForegroundImage(cullRect: { x: number; y: number; w: number; h: number }): Surface | null {
    const hasForeground = this.layers.some(l => l.visible && l.foreground && l.surface);
    if (!hasForeground) return null;

    const result = new Surface(cullRect.w, cullRect.h);

    for (const layer of this.layers) {
      if (!layer.visible || !layer.foreground || !layer.surface) continue;

      const srcX = Math.max(0, cullRect.x);
      const srcY = Math.max(0, cullRect.y);
      const srcRight = Math.min(this.pixelWidth, cullRect.x + cullRect.w);
      const srcBottom = Math.min(this.pixelHeight, cullRect.y + cullRect.h);

      if (srcRight <= srcX || srcBottom <= srcY) continue;

      const drawW = srcRight - srcX;
      const drawH = srcBottom - srcY;
      const destX = srcX - cullRect.x;
      const destY = srcY - cullRect.y;

      result.blitFrom(layer.surface, srcX, srcY, drawW, drawH, destX, destY);

      // Autotile overlay
      const autoSurf = layer.getAutotileImage();
      if (autoSurf) {
        result.blitFrom(autoSurf, srcX, srcY, drawW, drawH, destX, destY);
      }
    }

    return result;
  }

  /** Show a layer by NID. */
  showLayer(nid: string): void {
    const layer = this.layers.find(l => l.nid === nid);
    if (layer) layer.visible = true;
  }

  /** Hide a layer by NID. */
  hideLayer(nid: string): void {
    const layer = this.layers.find(l => l.nid === nid);
    if (layer) layer.visible = false;
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
