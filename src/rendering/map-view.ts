import { Surface } from '../engine/surface';
import type { TileMapObject } from './tilemap';
import { TILEWIDTH, TILEHEIGHT } from '../engine/constants';
import { viewport } from '../engine/viewport';

/**
 * MapView - The core rendering pipeline for the game map.
 * Draws all layers in order matching LT's map_view.py:
 * 1. Background tilemap
 * 2. Tile highlights (move/attack ranges)
 * 3. Grid lines (optional)
 * 4. Units (sorted by Y for depth)
 * 5. Foreground tilemap layers
 * 6. Cursor
 * 7. Weather (TODO)
 * 8. UI overlay
 */
export class MapView {
  private mapSurface: Surface;
  private currentScale: number;

  constructor() {
    this.currentScale = 1;
    this.mapSurface = new Surface(viewport.width, viewport.height, 1);
  }

  /** Ensure the internal surface matches the target scale. */
  private ensureSurface(targetScale: number): void {
    if (this.currentScale !== targetScale) {
      this.currentScale = targetScale;
      this.mapSurface = new Surface(viewport.width, viewport.height, targetScale);
    }
  }

  /**
   * Draw a full frame of the map view.
   *
   * @param tilemap    The runtime tilemap with pre-rendered layers.
   * @param cullRect   The camera viewport in world-pixel coordinates.
   * @param units      Units currently on the map (only those with positions).
   * @param highlights "x,y" -> highlight color type, or null for none.
   * @param cursor     The cursor to draw, or null.
   * @param showGrid   Whether to draw the tile grid overlay.
   * @returns          The composited map surface, ready for presentation.
   */
  draw(
    tilemap: TileMapObject,
    cullRect: { x: number; y: number; w: number; h: number },
    units: { x: number; y: number; visualOffsetX: number; visualOffsetY: number; sprite: any; team: string; finished: boolean }[],
    highlights: Map<string, string> | null,
    cursor: {
      x: number;
      y: number;
      visible: boolean;
      draw: (surf: Surface, ox: number, oy: number) => void;
    } | null,
    showGrid: boolean,
    renderScale: number = 1,
  ): Surface {
    this.ensureSurface(renderScale);
    this.mapSurface.clear();

    // The cull rect includes a 1-tile margin around the viewport for
    // rendering tiles that partially overlap edges. The actual camera
    // offset is one tile inset from the cull rect origin.
    const offsetX = cullRect.x + TILEWIDTH;
    const offsetY = cullRect.y + TILEHEIGHT;

    // 1. Background tilemap layers
    // The returned surface is larger than the viewport (includes margin).
    // We blit it shifted left/up by the margin so the visible area starts
    // at the camera position, not the margin.
    const bg = tilemap.getFullImage(cullRect);
    this.mapSurface.blit(bg, -TILEWIDTH, -TILEHEIGHT);

    // 2. Tile highlights
    if (highlights && highlights.size > 0) {
      this.drawHighlights(this.mapSurface, highlights, offsetX, offsetY);
    }

    // 3. Grid lines
    if (showGrid) {
      this.drawGrid(this.mapSurface, tilemap.width, tilemap.height, offsetX, offsetY);
    }

    // 4. Units (sorted by Y for depth ordering)
    this.drawUnits(this.mapSurface, units, offsetX, offsetY);

    // 5. Foreground tilemap layers (drawn on top of units)
    const fg = tilemap.getForegroundImage(cullRect);
    if (fg) {
      this.mapSurface.blit(fg, -TILEWIDTH, -TILEHEIGHT);
    }

    // 6. Cursor
    if (cursor && cursor.visible) {
      cursor.draw(this.mapSurface, offsetX, offsetY);
    }

    // 7. Weather - TODO
    // 8. UI overlay - handled externally

    return this.mapSurface;
  }

  /**
   * Draw movement/attack range highlights as semi-transparent colored tiles.
   */
  private drawHighlights(
    surf: Surface,
    highlights: Map<string, string>,
    offsetX: number,
    offsetY: number,
  ): void {
    for (const [key, colorType] of highlights) {
      const parts = key.split(',');
      const tileX = parseInt(parts[0], 10);
      const tileY = parseInt(parts[1], 10);

      const px = tileX * TILEWIDTH - offsetX;
      const py = tileY * TILEHEIGHT - offsetY;

      // Quick viewport cull
      if (
        px + TILEWIDTH <= 0 || py + TILEHEIGHT <= 0 ||
        px >= viewport.width || py >= viewport.height
      ) {
        continue;
      }

      const color = highlightColor(colorType);
      surf.fillRect(px, py, TILEWIDTH, TILEHEIGHT, color);
    }
  }

  /**
   * Draw units sorted by Y position for correct depth ordering.
   * Units with higher Y (further down the map) are drawn later so they
   * appear in front of units above them.
   */
  private drawUnits(
    surf: Surface,
    units: { x: number; y: number; visualOffsetX: number; visualOffsetY: number; sprite: any; team: string; finished: boolean }[],
    offsetX: number,
    offsetY: number,
  ): void {
    // Sort by Y (ascending) for painter's algorithm depth
    const sorted = [...units].sort((a, b) => a.y - b.y);

    for (const unit of sorted) {
      // World-space position of the tile's top-left, including sub-tile visual offset
      // for smooth movement interpolation. visualOffset is in tile units, convert to pixels.
      const worldX = unit.x * TILEWIDTH + unit.visualOffsetX * TILEWIDTH;
      const worldY = unit.y * TILEHEIGHT + unit.visualOffsetY * TILEHEIGHT;

      // Screen-space position (for culling and placeholders)
      const px = worldX - offsetX;
      const py = worldY - offsetY;

      // Viewport cull (allow a margin for sprites larger than one tile)
      const margin = TILEWIDTH * 2;
      if (
        px + TILEWIDTH + margin <= 0 || py + TILEHEIGHT + margin <= 0 ||
        px - margin >= viewport.width || py - margin >= viewport.height
      ) {
        continue;
      }

      if (unit.sprite && typeof unit.sprite === 'object' && 'draw' in unit.sprite) {
        // MapSprite.draw(surf, worldX, worldY, cameraOffsetX, cameraOffsetY)
        // The sprite does its own anchor offset calculation internally.
        // Finished units use the 'gray' sprite state (pre-rendered desaturated
        // frames), so no additional overlay is needed.
        const sprite = unit.sprite as { draw: (s: Surface, wx: number, wy: number, ox: number, oy: number) => void };
        sprite.draw(surf, worldX, worldY, offsetX, offsetY);
      } else {
        // Fallback: draw a colored rectangle placeholder
        const color = unitPlaceholderColor(unit.team);
        surf.fillRect(px + 2, py + 2, TILEWIDTH - 4, TILEHEIGHT - 4, color);

        // Dim finished units (only for placeholder rectangles; real sprites
        // use their gray frame row instead).
        if (unit.finished) {
          surf.fillRect(px, py, TILEWIDTH, TILEHEIGHT, 'rgba(0,0,0,0.35)');
        }
      }
    }
  }

  /**
   * Draw a tile grid overlay. Thin lines at each tile boundary.
   */
  private drawGrid(
    surf: Surface,
    mapW: number,
    mapH: number,
    offsetX: number,
    offsetY: number,
  ): void {
    const color = 'rgba(255,255,255,0.12)';

    // Compute the range of grid lines visible in the viewport
    const startCol = Math.max(0, Math.floor(offsetX / TILEWIDTH));
    const endCol = Math.min(mapW, Math.ceil((offsetX + viewport.width) / TILEWIDTH));
    const startRow = Math.max(0, Math.floor(offsetY / TILEHEIGHT));
    const endRow = Math.min(mapH, Math.ceil((offsetY + viewport.height) / TILEHEIGHT));

    // Vertical lines
    for (let col = startCol; col <= endCol; col++) {
      const x = col * TILEWIDTH - offsetX;
      surf.drawLine(x, 0, x, viewport.height, color, 1);
    }

    // Horizontal lines
    for (let row = startRow; row <= endRow; row++) {
      const y = row * TILEHEIGHT - offsetY;
      surf.drawLine(0, y, viewport.width, y, color, 1);
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Map a highlight type string to an rgba() color string.
 */
function highlightColor(type: string): string {
  switch (type) {
    case 'move':     return 'rgba(0,100,255,0.25)';
    case 'attack':   return 'rgba(255,0,0,0.25)';
    case 'spell':    return 'rgba(0,200,80,0.25)';
    case 'splash':   return 'rgba(200,100,255,0.20)';
    case 'selected': return 'rgba(255,255,0,0.30)';
    default:         return 'rgba(255,255,255,0.15)';
  }
}

/**
 * Placeholder unit rectangle color by team.
 */
function unitPlaceholderColor(team: string): string {
  switch (team) {
    case 'player': return 'rgba(64,128,255,0.9)';
    case 'enemy':  return 'rgba(220,40,40,0.9)';
    case 'other':  return 'rgba(40,180,40,0.9)';
    default:       return 'rgba(160,160,160,0.9)';
  }
}
