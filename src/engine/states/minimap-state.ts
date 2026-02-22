/**
 * minimap-state.ts — Minimap overlay state for the Lex Talionis web engine.
 *
 * Port of lt-maker/app/engine/minimap.py.
 * Shows a zoomed-out view of the entire tile map with colored terrain tiles,
 * unit dots, and a camera viewport indicator. Opens/closes with a rectangular
 * iris transition animation.
 */

import { State, type StateResult } from '../state';
import type { Surface } from '../surface';
import type { InputEvent } from '../input';
import { Surface as SurfaceClass } from '../surface';
import { viewport } from '../viewport';
import { TILEWIDTH, TILEHEIGHT, TILEX, TILEY } from '../constants';

// ---------------------------------------------------------------------------
// Lazy game reference (same pattern as prep-state.ts)
// ---------------------------------------------------------------------------

let _game: any = null;
export function setMinimapGameRef(g: any): void {
  _game = g;
}
function getGame(): any {
  if (!_game) throw new Error('Game reference not set for minimap state');
  return _game;
}

// ---------------------------------------------------------------------------
// Color mappings
// ---------------------------------------------------------------------------

/** Terrain NID/name → color for 4×4 minimap tiles. */
const TERRAIN_COLORS: Record<string, string> = {
  // Greens (terrain)
  'Grass': '#48a830',
  'Plain': '#48a830',
  'Floor': '#a89878',
  'Forest': '#206818',
  'Thicket': '#185810',
  'House': '#b87840',
  'Village': '#c89858',
  'Fort': '#888080',
  'Ruins': '#908878',
  'Throne': '#c8a838',
  'Chest': '#c8a050',
  'Gate': '#a89080',
  'Pillar': '#989088',
  'Wall': '#686060',
  'Mountain': '#786850',
  'Peak': '#686050',
  'Hill': '#78a848',
  'Desert': '#d8c878',
  'River': '#3878c8',
  'Sea': '#2860b0',
  'Lake': '#3070c0',
  'Bridge': '#a08858',
  'Sand': '#e8d898',
  'Snow': '#e8e8f0',
  'Cliff': '#685840',
  'Door': '#906830',
  'Shop': '#c89050',
  'Arena': '#c89050',
  'Armory': '#c89050',
  'Vendor': '#c89050',
  'Road': '#c8b888',
  'Pier': '#887858',
  'Lava': '#d83020',
};
const DEFAULT_TERRAIN_COLOR = '#48a830';

/** Team → color for unit dots. */
const TEAM_COLORS: Record<string, string> = {
  'player': '#4080ff',
  'enemy': '#ff4040',
  'enemy2': '#ff4040',
  'other': '#40d840',
  'ally': '#40d840',
};
const DEFAULT_TEAM_COLOR = '#808080';

/** Scale factor: each tile → 4×4 pixels on the minimap surface. */
const SCALE = 4;

// ---------------------------------------------------------------------------
// MiniMap — internal helper (not exported)
// ---------------------------------------------------------------------------

class MiniMap {
  private mapW: number;  // tiles
  private mapH: number;  // tiles
  private terrainSurf: SurfaceClass;
  private unitSurf: SurfaceClass;

  constructor(game: any) {
    const tilemap = game.tilemap;
    this.mapW = tilemap.width;
    this.mapH = tilemap.height;

    // ---- Terrain surface ----
    this.terrainSurf = new SurfaceClass(this.mapW * SCALE, this.mapH * SCALE);
    for (let y = 0; y < this.mapH; y++) {
      for (let x = 0; x < this.mapW; x++) {
        const terrainNid = game.board.getTerrain(x, y);
        let color = DEFAULT_TERRAIN_COLOR;
        if (terrainNid) {
          const terrainDef = game.db.terrain.get(terrainNid);
          if (terrainDef && terrainDef.name) {
            color = TERRAIN_COLORS[terrainDef.name] ?? DEFAULT_TERRAIN_COLOR;
          }
        }
        this.terrainSurf.fillRect(x * SCALE, y * SCALE, SCALE, SCALE, color);
      }
    }

    // ---- Unit surface (transparent) ----
    this.unitSurf = new SurfaceClass(this.mapW * SCALE, this.mapH * SCALE);
    this.buildUnits(game);
  }

  /** Rebuild unit dot surface from current game state. */
  buildUnits(game: any): void {
    this.unitSurf.clear();
    const units = game.units as Map<string, any>;
    for (const unit of units.values()) {
      if (!unit.position) continue;
      if (unit.dead || unit.isDead?.()) continue;
      const team: string = unit.team ?? '';
      const color = TEAM_COLORS[team] ?? DEFAULT_TEAM_COLOR;
      this.unitSurf.fillRect(
        unit.position[0] * SCALE,
        unit.position[1] * SCALE,
        SCALE,
        SCALE,
        color,
      );
    }
  }

  /**
   * Draw the minimap onto the given surface.
   *
   * @param surf      Destination surface (the full viewport).
   * @param camPixelX Camera offset X in *pixels* (from Camera.getOffset()).
   * @param camPixelY Camera offset Y in *pixels*.
   * @param progress  Iris transition progress 0→1 (0 = hidden, 1 = fully open).
   * @param isExiting Whether we're closing (for future reverse animation use).
   */
  draw(
    surf: SurfaceClass,
    camPixelX: number,
    camPixelY: number,
    progress: number,
    _isExiting: boolean,
  ): void {
    progress = Math.max(0, Math.min(1, progress));

    // Composite terrain + units onto a working surface
    const fullW = this.mapW * SCALE;
    const fullH = this.mapH * SCALE;
    const composite = new SurfaceClass(fullW, fullH);
    composite.blit(this.terrainSurf, 0, 0);

    // Flicker unit dots (every ~400ms)
    const now = Date.now() % 2000;
    if (now < 1600) {
      composite.blit(this.unitSurf, 0, 0);
    } else {
      // Slightly brighter flash for unit dots
      const whiteSurf = this.unitSurf.copy();
      whiteSurf.setAlpha(0.7);
      composite.blit(whiteSurf, 0, 0);
    }

    // ---- Iris clip (expanding rectangle from center) ----
    let clipped: SurfaceClass;
    if (progress < 1) {
      const clipW = Math.max(1, Math.round(fullW * progress));
      const clipH = Math.max(1, Math.round(fullH * progress));
      const cx = Math.round((fullW - clipW) / 2);
      const cy = Math.round((fullH - clipH) / 2);
      clipped = composite.subsurface(cx, cy, clipW, clipH);
    } else {
      clipped = composite;
    }

    // ---- Scrollable viewport into the minimap ----
    // The minimap image may be larger than the screen; scroll it so the camera
    // area stays visible, matching the Python approach.
    const vw = viewport.width;
    const vh = viewport.height;
    const viewportTilesW = Math.floor(vw / SCALE) - 2;
    const viewportTilesH = Math.floor(vh / SCALE) - 2;

    // Camera position in tile coordinates
    const camTileX = camPixelX / TILEWIDTH;
    const camTileY = camPixelY / TILEHEIGHT;

    // Percentage of scroll
    const xperc = this.mapW > TILEX ? camTileX / (this.mapW - TILEX) : 0;
    const yperc = this.mapH > TILEY ? camTileY / (this.mapH - TILEY) : 0;
    const xdiff = Math.max(this.mapW - viewportTilesW, 0);
    const ydiff = Math.max(this.mapH - viewportTilesH, 0);
    const xProgress = Math.round(xdiff * xperc * SCALE);
    const yProgress = Math.round(ydiff * yperc * SCALE);

    // Subsurface the clipped minimap to the scrolled viewport
    const srcW = Math.min(clipped.width, vw - 2 * SCALE);
    const srcH = Math.min(clipped.height, vh - 2 * SCALE);
    // Clamp source offsets so we don't read past the edge
    const sx = Math.min(xProgress, Math.max(0, clipped.width - srcW));
    const sy = Math.min(yProgress, Math.max(0, clipped.height - srcH));
    const actualW = Math.min(srcW, clipped.width - sx);
    const actualH = Math.min(srcH, clipped.height - sy);

    let viewSurf: SurfaceClass;
    if (actualW > 0 && actualH > 0) {
      viewSurf = clipped.subsurface(sx, sy, actualW, actualH);
    } else {
      viewSurf = clipped;
    }

    // Slight transparency (10% translucent, i.e. 90% opaque)
    viewSurf.setAlpha(0.9);

    // Center on screen
    const drawX = Math.max(4, Math.round(vw / 2 - viewSurf.width / 2));
    const drawY = Math.max(4, Math.round(vh / 2 - viewSurf.height / 2));
    surf.blit(viewSurf, drawX, drawY);

    // ---- Camera cursor rectangle (white outline showing visible area) ----
    if (progress >= 1) {
      // Camera rect in minimap-pixel space, relative to the viewport sub-image
      const cursorX = drawX + Math.round(camTileX * SCALE) - sx;
      const cursorY = drawY + Math.round(camTileY * SCALE) - sy;
      // The visible area in tiles from the viewport
      const visTilesW = Math.ceil(vw / TILEWIDTH);
      const visTilesH = Math.ceil(vh / TILEHEIGHT);
      const cursorW = visTilesW * SCALE;
      const cursorH = visTilesH * SCALE;

      surf.drawRect(
        cursorX - 1,
        cursorY - 1,
        cursorW + 2,
        cursorH + 2,
        'rgba(255,255,255,0.9)',
      );

      // Inner brighter line for visibility
      surf.drawRect(
        cursorX,
        cursorY,
        cursorW,
        cursorH,
        'rgba(255,255,255,0.5)',
      );
    }
  }
}

// ---------------------------------------------------------------------------
// MinimapState (name: 'minimap')
// ---------------------------------------------------------------------------

export class MinimapState extends State {
  readonly name = 'minimap';
  override readonly transparent = true;
  override readonly showMap = true;

  private minimap: MiniMap | null = null;
  private arriveTimer: number = 0;
  private exitTimer: number = 0;
  private isExiting: boolean = false;
  private transitionTime: number = 200; // ms

  override start(): StateResult {
    const game = getGame();
    this.minimap = new MiniMap(game);
    this.arriveTimer = 0;
    this.exitTimer = 0;
    this.isExiting = false;
  }

  override takeInput(event: InputEvent): StateResult {
    const game = getGame();

    // Don't allow exit while still arriving
    const arriving = this.arriveTimer < this.transitionTime;

    // Directional input: move the game cursor (which moves the camera)
    if (event === 'UP' || event === 'DOWN' || event === 'LEFT' || event === 'RIGHT') {
      if (game.cursor) {
        const dx = event === 'RIGHT' ? 1 : event === 'LEFT' ? -1 : 0;
        const dy = event === 'DOWN' ? 1 : event === 'UP' ? -1 : 0;
        game.cursor.move(dx, dy);
        const pos = game.cursor.getHover();
        game.camera.focusTile(pos.x, pos.y);
      }
      // Rebuild unit overlay in case something changed
      if (this.minimap) {
        this.minimap.buildUnits(game);
      }
      return;
    }

    // Exit on BACK / SELECT / START (only after arrive transition completes)
    if (
      (event === 'BACK' || event === 'SELECT' || event === 'START') &&
      !arriving &&
      !this.isExiting
    ) {
      this.isExiting = true;
      this.exitTimer = 0;
    }
  }

  override update(): StateResult {
    const game = getGame();
    const dt = game.frameDeltaMs ?? 16;

    if (this.isExiting) {
      this.exitTimer += dt;
      if (this.exitTimer >= this.transitionTime) {
        game.state.back();
        return;
      }
    } else if (this.arriveTimer < this.transitionTime) {
      this.arriveTimer += dt;
      if (this.arriveTimer > this.transitionTime) {
        this.arriveTimer = this.transitionTime;
      }
    }
  }

  override draw(surf: Surface): Surface {
    if (!this.minimap) return surf;

    const game = getGame();
    const [camX, camY] = game.camera.getOffset();

    // Compute progress 0→1
    let progress: number;
    if (this.isExiting) {
      // Reverse: 1 → 0
      progress = Math.max(0, 1 - this.exitTimer / this.transitionTime);
    } else {
      progress = Math.min(1, this.arriveTimer / this.transitionTime);
    }

    this.minimap.draw(surf as SurfaceClass, camX, camY, progress, this.isExiting);
    return surf;
  }
}
