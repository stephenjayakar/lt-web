import { Surface } from '../engine/surface';
import type { TilemapData, TilemapLayerData, NID } from '../data/types';
import { TILEWIDTH, TILEHEIGHT } from '../engine/constants';

/**
 * LayerObject - A single layer of a tilemap, pre-rendered to a Surface.
 */
export class LayerObject {
  nid: string;
  visible: boolean;
  foreground: boolean;
  terrainGrid: Map<string, NID>; // "x,y" -> terrain NID
  surface: Surface | null = null;

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
   *
   * Creates a surface of (width * TILEWIDTH) x (height * TILEHEIGHT) pixels.
   * For each entry in spriteGrid, draws the corresponding 16x16 tile from
   * the tileset image at the correct map position.
   */
  buildSurface(
    width: number,
    height: number,
    spriteGrid: Record<string, [NID, [number, number]]>,
    tilesetImages: Map<NID, HTMLImageElement>,
  ): void {
    const pixelW = width * TILEWIDTH;
    const pixelH = height * TILEHEIGHT;
    this.surface = new Surface(pixelW, pixelH);

    for (const [posKey, [tilesetNid, [tileCol, tileRow]]] of Object.entries(spriteGrid)) {
      const image = tilesetImages.get(tilesetNid);
      if (!image) continue;

      const parts = posKey.split(',');
      const mapX = parseInt(parts[0], 10);
      const mapY = parseInt(parts[1], 10);

      // Source rect within the tileset image
      const sx = tileCol * TILEWIDTH;
      const sy = tileRow * TILEHEIGHT;

      // Destination on the layer surface
      const dx = mapX * TILEWIDTH;
      const dy = mapY * TILEHEIGHT;

      this.surface.blitImage(image, sx, sy, TILEWIDTH, TILEHEIGHT, dx, dy);
    }
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
   */
  static fromPrefab(
    data: TilemapData,
    tilesetImages: Map<NID, HTMLImageElement>,
  ): TileMapObject {
    const [w, h] = data.size;
    const tilemap = new TileMapObject(data.nid, w, h);

    for (const layerData of data.layers) {
      const layer = new LayerObject(layerData);
      layer.buildSurface(w, h, layerData.sprite_grid, tilesetImages);
      tilemap.layers.push(layer);
    }

    return tilemap;
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

      result.blitFrom(layer.surface, srcX, srcY, drawW, drawH, destX, destY);
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

  /** Check if a tile position is within map bounds. */
  checkBounds(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.width && y < this.height;
  }
}
