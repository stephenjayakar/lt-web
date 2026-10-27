import { getSprite } from '../ui/sprites';
import { getSetting } from '../engine/states/settings-state';
import { Surface } from '../engine/surface';
import type { TileMapObject } from './tilemap';
import { TILEWIDTH, TILEHEIGHT, getFrameCount } from '../engine/constants';
import { viewport } from '../engine/viewport';
import type { GameBoard } from '../objects/game-board';
import type { FogOfWarConfig, RegionData } from '../data/types';
import { FONT } from './bmp-font';
import type { Database } from '../data/database';
import type { UnitObject } from '../objects/unit';
import type { UnitMarkerIcons } from './unit-markers';
import type { MapSpriteFx } from './map-sprite';
import type { HighlightLayer } from './highlight';

export interface MapViewUnit {
  x: number;
  y: number;
  visualOffsetX: number;
  visualOffsetY: number;
  sprite: any;
  team: string;
  finished: boolean;
  currentHp: number;
  maxHp: number;
  specialTag?: 'Boss' | 'Elite' | 'Protect' | null;
  travelerCombatColor?: string | null;
  droppable?: boolean;
  tintColor?: [number, number, number] | null;
  tintAlpha?: number;
  /** Python UnitSprite.check_draw_hp(); undefined keeps the bar visible. */
  showHp?: boolean;
  /** Combat/death sprite effects (flicker tints, fade, stationary frame). */
  fx?: MapSpriteFx | null;
  /** Facing override (combat image states, pose_unit). */
  poseOverride?: { state: 'standing' | 'moving' | 'active'; direction?: 'up' | 'down' | 'left' | 'right' } | null;
  /** Drawn after the sprite at its tile top-left (transition animations, warp flowers). */
  overlay?: ((surf: Surface, left: number, top: number, cameraX: number, cameraY: number) => void) | null;
}

/**
 * Port of Python UnitSprite.check_draw_hp: roam levels hide bars when the
 * `roam_hide_hp` constant is on; dying/dead units never show one; otherwise
 * the hp_map_team ('All'|'Ally'|'Enemy') and hp_map_cull
 * ('All'|'Wounded'|'None') settings decide (Python defaults: All/All).
 */
export function shouldDrawMapHp(
  game: {
    roamInfo?: { roam?: boolean } | null;
    db: { getConstant(nid: string, fallback?: unknown): unknown; areAllied?(a: string, b: string): boolean };
    gameVars: Map<string, any>;
  },
  unit: { team: string; currentHp: number; maxHp: number; isDying?: boolean; dead?: boolean },
): boolean {
  if (game.roamInfo?.roam && game.db.getConstant('roam_hide_hp', false)) return false;
  if (unit.isDying || unit.dead) return false;
  const teamSetting = String(getSetting('hp_map_team') ?? 'All');
  const cullSetting = String(getSetting('hp_map_cull') ?? 'All');
  const allied = game.db.areAllied ? game.db.areAllied('player', unit.team) : unit.team === 'player';
  const teamOk = teamSetting === 'All' ||
    (teamSetting === 'Ally' && allied) ||
    (teamSetting === 'Enemy' && !allied);
  if (!teamOk) return false;
  if (cullSetting === 'All') return true;
  if (cullSetting === 'Wounded') return unit.currentHp < unit.maxHp;
  return false;
}

/**
 * Configuration for fog of war rendering, passed into MapView.draw().
 */
export interface FogRenderConfig {
  fogInfo: FogOfWarConfig;
  board: GameBoard;
  db: Database;
  allUnits: UnitObject[];
}

/**
 * MapView - The core rendering pipeline for the game map.
 * Draws all layers in order matching LT's map_view.py:
 * 1. Background tilemap
 * 2. Tile highlights (move/attack ranges)
 * 3. Grid lines (optional)
 * 4. Units (sorted by Y for depth)
 * 5. Foreground tilemap layers
 * 5.6. Fog of war overlay
 * 6. Cursor
 * 7. Weather (TODO)
 * 8. UI overlay
 */
export class MapView {
  /** Optional background tilemap drawn beneath the main one
   * (set from GameState when change_bg_tilemap applies). */
  bgTilemap: any | null = null;

  /** Live level regions, for Python's time-region countdown text. */
  regionSource: (() => readonly RegionData[] | null | undefined) | null = null;

  /** Live board movement bounds [minX, minY, maxX, maxY] (Python game.board.bounds). */
  boundsSource: (() => readonly [number, number, number, number] | null | undefined) | null = null;

  private gridSurface: Surface | null = null;
  private boundsSurface: Surface | null = null;

  private mapSurface: Surface;
  private currentScale: number;

  constructor() {
    this.currentScale = 1;
    this.mapSurface = Surface.frame(viewport.width, viewport.height, 1);
  }

  /** Ensure the internal surface matches the target scale. */
  private ensureSurface(targetScale: number): void {
    if (this.currentScale !== targetScale) {
      this.currentScale = targetScale;
      this.mapSurface = Surface.frame(viewport.width, viewport.height, targetScale);
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
   * @param renderScale Canvas render scale.
   * @param fogConfig  Optional fog of war rendering configuration.
   * @returns          The composited map surface, ready for presentation.
   */
  draw(
    tilemap: TileMapObject,
    cullRect: { x: number; y: number; w: number; h: number },
    units: MapViewUnit[],
    highlights: Map<string, string> | HighlightSource | null,
    cursor: {
      x: number;
      y: number;
      visible: boolean;
      draw: (surf: Surface, ox: number, oy: number) => void;
    } | null,
    showGrid: boolean,
    renderScale: number = 1,
    fogConfig: FogRenderConfig | null = null,
    markers: UnitMarkerIcons | null = null,
    markerTimeMs: number = 0,
  ): Surface {
    this.ensureSurface(renderScale);
    this.mapSurface.clear();

    // The cull rect includes a 1-tile margin around the viewport for
    // rendering tiles that partially overlap edges. The actual camera
    // offset is one tile inset from the cull rect origin.
    const offsetX = cullRect.x + TILEWIDTH;
    const offsetY = cullRect.y + TILEHEIGHT;

    // Determine if fog of war is active
    const fogActive = fogConfig &&
      (fogConfig.fogInfo.isActive || fogConfig.board.fogRegionSet.size > 0);

    // 0. Optional background tilemap (Python level.bg_tilemap)
    const bgTm = this.bgTilemap;
    if (bgTm) {
      bgTm.updateAutotiles(Date.now());
      const bgImg = bgTm.getFullImage(cullRect);
      if (bgImg) this.mapSurface.blit(bgImg, offsetX, offsetY);
    }

    // 1. Background tilemap layers
    // Update autotile animation frame before rendering
    tilemap.updateAutotiles(Date.now());
    // The returned surface is larger than the viewport (includes margin).
    // We blit it shifted left/up by the margin so the visible area starts
    // at the camera position, not the margin.
    const bg = tilemap.getFullImage(cullRect);
    this.mapSurface.blit(bg, -TILEWIDTH, -TILEHEIGHT);

    // 2. Tile highlights
    if (highlights instanceof Map) {
      if (highlights.size > 0) this.drawHighlights(this.mapSurface, highlights, offsetX, offsetY);
    } else if (highlights) {
      this.drawHighlightLayers(this.mapSurface, highlights, offsetX, offsetY);
    }

    // 3. Grid lines and level bounds (Python MapView.draw_grid)
    this.drawGrid(this.mapSurface, tilemap.width, tilemap.height, offsetX, offsetY, renderScale);

    // 3.5. Map animations (below units)
    for (const anim of tilemap.animations) {
      if (anim.followUnit?.position) anim.setTilePosition(anim.followUnit.position[0], anim.followUnit.position[1]);
      else if (anim.followUnit) anim.done = true; // unit left the map
    }
    tilemap.animations = tilemap.animations.filter(anim => !anim.update());
    for (const anim of tilemap.animations) {
      anim.draw(this.mapSurface, cullRect.x, cullRect.y);
    }

    // 4. Units (sorted by Y for depth ordering)
    // Filter out units not in vision when fog is active
    let visibleUnits = units;
    if (fogActive && fogConfig) {
      visibleUnits = units.filter(u => {
        const pos: [number, number] = [u.x, u.y];
        return fogConfig.board.inVision(
          pos,
          'player',
          fogConfig.fogInfo,
          fogConfig.db,
          fogConfig.allUnits,
        );
      });
    }
    this.drawUnits(this.mapSurface, visibleUnits, offsetX, offsetY, markers, markerTimeMs);

    // 5. Foreground tilemap layers (drawn on top of units)
    const fg = tilemap.getForegroundImage(cullRect);
    if (fg) {
      this.mapSurface.blit(fg, -TILEWIDTH, -TILEHEIGHT);
    }

    // 5.5. High map animations (above units/foreground)
    for (const anim of tilemap.highAnimations) {
      if (anim.followUnit?.position) anim.setTilePosition(anim.followUnit.position[0], anim.followUnit.position[1]);
      else if (anim.followUnit) anim.done = true;
    }
    tilemap.highAnimations = tilemap.highAnimations.filter(anim => !anim.update());
    for (const anim of tilemap.highAnimations) {
      anim.draw(this.mapSurface, cullRect.x, cullRect.y);
    }

    // 5.6. Fog of war overlay
    if (fogActive && fogConfig) {
      this.drawFogOfWar(this.mapSurface, fogConfig, cullRect, offsetX, offsetY, tilemap.width, tilemap.height);
    }

    // 5.7. Time region countdowns (Python MapView.time_region_text)
    this.drawTimeRegionText(this.mapSurface, offsetX, offsetY);

    // 6. Cursor
    if (cursor && cursor.visible) {
      cursor.draw(this.mapSurface, offsetX, offsetY);
    }

    // 7. Weather particles and overlays
    tilemap.updateWeather();
    for (const weather of tilemap.weather) {
      weather.draw(this.mapSurface, cullRect.x, cullRect.y);
    }

    // 8. UI overlay - handled externally

    return this.mapSurface;
  }

  /**
   * Draw movement/attack range highlights as semi-transparent colored tiles.
   */
  private drawTimeRegionText(surf: Surface, offsetX: number, offsetY: number): void {
    const regions = this.regionSource?.();
    const font = FONT['text-yellow'];
    if (!regions || !font) return;
    const bob = 2 * Math.sin(Math.floor(performance.now() / 500));
    for (const region of regions) {
      if (region.hide_time || region.time_left === null || region.time_left === undefined ||
          !region.position) continue;
      const text = String(region.time_left);
      const width = font.width(text);
      const [w, h] = region.size ?? [1, 1];
      const centerX = (region.position[0] + w / 2) * TILEWIDTH - offsetX;
      const centerY = (region.position[1] + h / 2) * TILEHEIGHT - offsetY;
      font.blit(surf, text, centerX - Math.floor(width / 2) - 1, centerY - 12 + bob);
    }
  }

  /**
   * Python HighlightController.draw: the formation highlight, the yellow
   * Escape/Arrive region tiles, then each highlight sprite layer, all
   * animated frame update_idx // 4 (update_idx cycles 0..63 per frame). A
   * fresh layer grows in: its frame is cut `cutoff` px from the top-left and
   * drawn at the tile's corner.
   */
  private drawHighlightLayers(surf: Surface, source: HighlightSource, offsetX: number, offsetY: number): void {
    const frame = Math.floor((source.updateIdx ?? getFrameCount() % 64) / 4);
    const onScreen = (px: number, py: number): boolean =>
      px + TILEWIDTH > 0 && py + TILEHEIGHT > 0 && px < viewport.width && py < viewport.height;
    const blitAt = (sprite: Surface, key: string, cut: number): void => {
      const [tx, ty] = key.split(',').map(Number);
      const px = tx * TILEWIDTH - offsetX;
      const py = ty * TILEHEIGHT - offsetY;
      if (!onScreen(px, py)) return;
      surf.blitFrom(sprite, frame * TILEWIDTH + cut, cut, TILEWIDTH - cut, TILEHEIGHT - cut, px, py);
    };
    const merged = source.getHighlights();
    const formation = getSprite('highlight_blue');
    const fills = new Map<string, string>();
    for (const [key, type] of merged) {
      if (type === 'formation') {
        if (formation) blitAt(formation, key, 0);
        else fills.set(key, type);
      } else if (type === 'selected' || type === 'threat') {
        fills.set(key, type);
      }
    }
    const escape = getSprite('highlight_yellow');
    if (escape) {
      for (const region of this.regionSource?.() ?? []) {
        const subNid = String(region.sub_nid ?? '');
        if (String(region.region_type ?? '').toLowerCase() !== 'event' || !['Escape', 'Arrive'].includes(subNid)) continue;
        if (!region.position) continue;
        const [w, h] = region.size ?? [1, 1];
        for (let x = 0; x < w; x++) {
          for (let y = 0; y < h; y++) blitAt(escape, `${region.position[0] + x},${region.position[1] + y}`, 0);
        }
      }
    }
    for (const layer of source.spriteLayers()) {
      const sprite = getSprite(layer.sprite);
      if (!sprite) {
        for (const key of layer.keys) fills.set(key, layer.type);
        continue;
      }
      for (const key of layer.keys) blitAt(sprite, key, layer.cutoff);
    }
    if (fills.size) this.drawHighlights(surf, fills, offsetX, offsetY);
  }

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

      if (colorType === 'formation') {
        // Python Highlight.draw: highlight_blue frame update_idx // 4, where
        // update_idx cycles 0..63 once per frame.
        const sprite = getFormationHighlightSprite();
        if (sprite) {
          const frame = Math.floor((getFrameCount() % 64) / 4);
          surf.blitImage(sprite, frame * TILEWIDTH, 0, TILEWIDTH, TILEHEIGHT, px, py);
          continue;
        }
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
    units: MapViewUnit[],
    offsetX: number,
    offsetY: number,
    markers: UnitMarkerIcons | null = null,
    markerTimeMs: number = 0,
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
        const sprite = unit.sprite as any;
        const pose = (unit as any).poseOverride;
        if (pose) {
          sprite.state = pose.state;
          if (pose.direction) sprite.direction = pose.direction;
        }
        sprite.draw(
          surf,
          worldX,
          worldY,
          offsetX,
          offsetY,
          unit.tintColor,
          unit.tintAlpha ?? 0,
          unit.fx ?? null,
        );
        unit.overlay?.(surf, px, py, offsetX, offsetY);
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

      // Python MapHealthBar.draw: map_health_outline at (left, top + 13)
      // and the first int(12 * hp / max) + 1 pixels of map_health_bar at
      // (left + 1, top + 14).
      const maxHp = unit.maxHp;
      if (unit.showHp !== false) {
        const outline = getSprite('map_health_outline');
        const bar = getSprite('map_health_bar');
        if (outline && bar) {
          const fraction = Math.max(0, Math.min(1, unit.currentHp / Math.max(1, maxHp)));
          surf.blit(outline, px, py + 13);
          if (fraction > 0) surf.blitFrom(bar, 0, 0, Math.trunc(12 * fraction) + 1, 1, px + 1, py + 14);
        }
      }

      // Rescue/status overlay icons (see unit-markers.ts).
      if (markers && markers.loaded && (unit.specialTag || unit.travelerCombatColor || unit.droppable)) {
        markers.draw(
          surf,
          px + 8,
          py + 8,
          {
            specialTag: unit.specialTag ?? null,
            travelerCombatColor: unit.travelerCombatColor ?? null,
            droppable: unit.droppable ?? false,
          },
          markerTimeMs,
        );
      }
    }
  }

  /**
   * Draw fog of war overlay.
   *
   * Iterates every visible tile in the viewport:
   * - Tiles NOT in vision with known terrain: semi-transparent dark overlay
   * - Tiles NOT in vision with unknown terrain: fully opaque black
   */
  private drawFogOfWar(
    surf: Surface,
    fogConfig: FogRenderConfig,
    cullRect: { x: number; y: number; w: number; h: number },
    offsetX: number,
    offsetY: number,
    mapW: number,
    mapH: number,
  ): void {
    const { fogInfo, board, db, allUnits } = fogConfig;

    // Compute visible tile range
    const startCol = Math.max(0, Math.floor(offsetX / TILEWIDTH) - 1);
    const endCol = Math.min(mapW - 1, Math.ceil((offsetX + viewport.width) / TILEWIDTH) + 1);
    const startRow = Math.max(0, Math.floor(offsetY / TILEHEIGHT) - 1);
    const endRow = Math.min(mapH - 1, Math.ceil((offsetY + viewport.height) / TILEHEIGHT) + 1);

    for (let ty = startRow; ty <= endRow; ty++) {
      for (let tx = startCol; tx <= endCol; tx++) {
        const pos: [number, number] = [tx, ty];
        const isVisible = board.inVision(pos, 'player', fogInfo, db, allUnits);

        if (!isVisible) {
          const px = tx * TILEWIDTH - offsetX;
          const py = ty * TILEHEIGHT - offsetY;

          // Quick viewport cull
          if (
            px + TILEWIDTH <= 0 || py + TILEHEIGHT <= 0 ||
            px >= viewport.width || py >= viewport.height
          ) {
            continue;
          }

          const known = board.terrainKnown(pos, isVisible, fogInfo);
          if (known) {
            // Terrain is known but not in vision: semi-transparent dark overlay
            surf.fillRect(px, py, TILEWIDTH, TILEHEIGHT, 'rgba(0,0,0,0.55)');
          } else {
            // Terrain is unknown: fully opaque black
            surf.fillRect(px, py, TILEWIDTH, TILEHEIGHT, 'rgba(0,0,0,1.0)');
          }
        }
      }
    }
  }

  /**
   * Draw a tile grid overlay. Thin lines at each tile boundary.
   */
  /**
   * Python MapView.draw_grid: grid lines at the 'grid_opacity' setting (drawn
   * when above 30) inside the board bounds, plus thick bound lines when the
   * bounds are not the whole map and 'show_bounds' is on. Lines are drawn
   * onto their own layer (pygame draw_line sets pixels) and blitted once.
   */
  private drawGrid(
    surf: Surface,
    mapW: number,
    mapH: number,
    offsetX: number,
    offsetY: number,
    renderScale: number,
  ): void {
    const bounds = this.boundsSource?.() ?? [0, 0, mapW - 1, mapH - 1];
    const regularBounds = bounds[0] === 0 && bounds[1] === 0 &&
      bounds[2] === mapW - 1 && bounds[3] === mapH - 1;
    const left = bounds[0] * TILEWIDTH - offsetX;
    const right = (bounds[2] + 1) * TILEWIDTH - offsetX;
    const top = bounds[1] * TILEHEIGHT - offsetY;
    const bottom = (bounds[3] + 1) * TILEHEIGHT - offsetY;

    const opacity = Number(getSetting('grid_opacity')) || 0;
    const outsideOpacity = Math.min(255, opacity + 56);
    const drawGridLines = opacity > 30;
    const drawBounds = !regularBounds && !!getSetting('show_bounds');
    if (!drawGridLines && !drawBounds) return;

    const layer = (existing: Surface | null): Surface => {
      const target = existing && existing.scale === renderScale ? existing
        : Surface.frame(viewport.width, viewport.height, renderScale);
      target.clear();
      return target;
    };

    if (drawGridLines) {
      const grid = this.gridSurface = layer(this.gridSurface);
      for (let x = left; x < right; x += TILEWIDTH) {
        grid.fillRect(x - 1, top, 1, bottom - top + 1, '#000');
      }
      for (let y = top; y < bottom; y += TILEHEIGHT) {
        grid.fillRect(left, y, right - left + 1, 1, '#000');
      }
      if (drawBounds) {
        // The bound lines replace (not blend over) the grid pixels beneath.
        const s = grid.scale;
        const clear = (x: number, y: number, w: number, h: number) =>
          grid.ctx.clearRect(Math.round(x * s), Math.round(y * s), Math.round(w * s), Math.round(h * s));
        clear(left - 2, top - 2, right - left + 4, 3);
        clear(left - 2, top - 1, 3, bottom - top + 2);
        clear(right - 1, top - 1, 3, bottom - top + 2);
        clear(left - 2, bottom - 1, right - left + 4, 3);
      }
      grid.setAlpha(opacity / 255);
      surf.blit(grid);
    }

    if (drawBounds) {
      const lines = this.boundsSurface = layer(this.boundsSurface);
      // pygame draw_line(width=3) spreads 1px either side of the line.
      lines.fillRect(left - 2, top - 2, right - left + 4, 3, '#000');
      lines.fillRect(left - 2, top - 1, 3, bottom - top + 2, '#000');
      lines.fillRect(right - 1, top - 1, 3, bottom - top + 2, '#000');
      lines.fillRect(left - 2, bottom - 1, right - left + 4, 3, '#000');
      lines.setAlpha(outsideOpacity / 255);
      surf.blit(lines);
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let formationHighlight: HTMLImageElement | null = null;
let formationHighlightRequested = false;
/** Python SPRITES['highlight_blue'] (16 animation frames of 16x16). */
function getFormationHighlightSprite(): HTMLImageElement | null {
  if (!formationHighlightRequested) {
    formationHighlightRequested = true;
    const img = new Image();
    img.onload = () => { formationHighlight = img; };
    img.src = '/game-data/sprites/highlights/highlight_blue.png';
  }
  return formationHighlight;
}

/** What MapView.draw needs from the HighlightManager for sprite highlights. */
export interface HighlightSource {
  updateIdx?: number;
  getHighlights(): Map<string, string>;
  spriteLayers(): HighlightLayer[];
}

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
    case 'aura':     return 'rgba(190,120,255,0.20)';
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
