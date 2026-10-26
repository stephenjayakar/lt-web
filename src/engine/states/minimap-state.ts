/**
 * minimap-state.ts — Minimap overlay state for the Lex Talionis web engine.
 *
 * Port of lt-maker/app/engine/minimap.py.
 * Shows the whole map at 4 px per tile from the engine's Minimap_Tiles cells
 * (chosen by each terrain's `minimap` key, with Python's wall/river/sea/coast
 * neighbour rules and cliff-chain orientation), team pins from
 * Minimap_Sprites and the Minimap_Cursor camera frame. Opens/closes through
 * a growing rectangle rotating by 90 degrees.
 */

import { State, type StateResult } from '../state';
import type { Surface } from '../surface';
import type { InputEvent } from '../input';
import { Surface as SurfaceClass } from '../surface';
import { viewport } from '../viewport';
import { TILEWIDTH, TILEHEIGHT, FRAMETIME, getFrameCount } from '../constants';
import { getSprite, makeTranslucent } from '../../ui/sprites';

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
// Python MinimapCatalog (app/data/database/minimap.py)
// ---------------------------------------------------------------------------

const SINGLE_MAP: Record<string, [number, number]> = {
  Grass: [1, 0], House: [2, 0], Shop: [3, 0], Switch: [4, 0], Fort: [5, 0], Ruins: [6, 0],
  Forest: [8, 0], Thicket: [9, 0], Hill: [11, 0], Floor: [12, 0], Pillar: [13, 0], Throne: [14, 0],
  Chest: [15, 0], Mountain: [4, 1], Desert: [10, 0], Waste: [11, 1], Snow: [12, 1], Dark_Snow: [13, 1],
  Pier: [14, 1],
};
const COMPLEX_MAP = ['Wall', 'River', 'Sand', 'Sea', 'Lava'];
const CLIFFS = ['Cliff', 'Desert_Cliff', 'Snow_Cliff'];

/** Each tile -> 4x4 pixels on the minimap surface (Python scale_factor). */
const SCALE = 4;

type Pos = [number, number];

// ---------------------------------------------------------------------------
// CliffManager — Python minimap.CliffManager (cliff chain orientation)
// ---------------------------------------------------------------------------

class Link {
  position: Pos;
  adjacent = new Set<Link>();
  orientation = 0;
  constructor(pos: Pos) {
    this.position = pos;
  }
}

class CliffManager {
  private width: number;
  private grid: number[];

  constructor(positions: Pos[], width: number, height: number) {
    this.width = width;
    this.grid = new Array(width * height).fill(0);
    const unexplored = new Set(positions.map((pos) => new Link(pos)));
    for (const chain of this.genChains(unexplored)) this.placeChain(chain);
  }

  private static isAdjacent(a: Pos, b: Pos): boolean {
    return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) === 1;
  }

  private getAdjacent(link: Link, unexplored: Set<Link>): Set<Link> {
    const adj = new Set<Link>();
    const [x, y] = link.position;
    for (const other of unexplored) if (CliffManager.isAdjacent(other.position, link.position)) adj.add(other);
    for (const other of unexplored) {
      const [ox, oy] = other.position;
      if (Math.abs(ox - x) === 1 && Math.abs(oy - y) === 1 &&
          ![...adj].some((a) => CliffManager.isAdjacent(a.position, other.position))) {
        adj.add(other);
      }
    }
    return adj;
  }

  private genChains(unexplored: Set<Link>): Set<Link>[] {
    const chains: Set<Link>[] = [];
    if (unexplored.size === 0) return chains;
    let chain = new Set<Link>();
    const first = unexplored.values().next().value!;
    unexplored.delete(first);
    const explored: Link[] = [first];
    while (explored.length) {
      const current = explored.pop()!;
      chain.add(current);
      const adj = this.getAdjacent(current, unexplored);
      if (adj.size) {
        for (const a of adj) {
          current.adjacent.add(a);
          a.adjacent.add(current);
          explored.push(a);
          unexplored.delete(a);
        }
      } else if (explored.length) {
        continue;
      } else {
        chains.push(chain);
        if (unexplored.size) {
          chain = new Set<Link>();
          const next = unexplored.values().next().value!;
          unexplored.delete(next);
          explored.push(next);
        }
      }
    }
    return chains;
  }

  private static diff(a: Link, b: Link): Pos {
    return [b.position[0] - a.position[0], b.position[1] - a.position[1]];
  }

  private placeChain(chain: Set<Link>): void {
    if (chain.size === 1) {
      const link = chain.values().next().value!;
      link.orientation = 1;
      this.grid[link.position[0] + link.position[1] * this.width] = 1;
      return;
    }
    const endings = [...chain].filter((link) => link.adjacent.size === 1);
    const ending = endings.length ? endings[0] : chain.values().next().value!;
    const adjLink = ending.adjacent.values().next().value!;
    if (chain.size === 2) {
      const [dx, dy] = CliffManager.diff(ending, adjLink);
      ending.orientation = dx === 0 ? 2 : dy === 0 ? 1 : dx === dy ? 3 : 4;
    }
    // Python walks (prev, current) pairs from a set; a seen set keeps a
    // cyclic chain from looping forever.
    const explored: [Link, Link][] = [[ending, adjLink]];
    const seen = new Set<string>();
    while (explored.length) {
      const [prev, current] = explored.pop()!;
      const others = [...current.adjacent].filter((link) => link !== prev);
      if (others.length) {
        for (const next of others) {
          this.findOrientation(prev, current, next);
          const key = `${current.position}|${next.position}`;
          if (!seen.has(key)) {
            seen.add(key);
            explored.push([current, next]);
          }
        }
      } else {
        this.findEndingOrientation(prev, current);
      }
    }
    if (chain.size !== 2) this.findEndingOrientation(adjLink, ending);
    for (const link of chain) this.grid[link.position[0] + link.position[1] * this.width] = link.orientation;
  }

  private findOrientation(prev: Link, current: Link, next: Link): void {
    const [tdx, tdy] = CliffManager.diff(prev, next);
    if (tdx === 0) current.orientation = 2;
    else if (tdy === 0) current.orientation = 1;
    else current.orientation = tdy / tdx > 0 ? 3 : 4;
  }

  private findEndingOrientation(prev: Link, current: Link): void {
    const [dx, dy] = CliffManager.diff(prev, current);
    if (dy === 0 || dx === 0) {
      current.orientation = prev.orientation === 1 ? 1 : prev.orientation === 2 ? 2 : prev.orientation === 3 ? 4 : 3;
    } else {
      current.orientation = dx === dy ? 3 : 4;
    }
  }

  getOrientation(pos: Pos): Pos {
    const o = this.grid[pos[0] + pos[1] * this.width];
    return o === 2 ? [9, 6] : o === 3 ? [11, 6] : o === 4 ? [10, 6] : [8, 6];
  }
}

// ---------------------------------------------------------------------------
// MiniMap — Python minimap.MiniMap, built from Minimap_Tiles/_Sprites/_Cursor
// ---------------------------------------------------------------------------

/** Python image_mods.make_white: blend every opaque pixel toward white. */
function makeWhite(src: SurfaceClass, whiteness: number): SurfaceClass {
  const out = src.copy();
  const ctx = out.ctx;
  ctx.globalCompositeOperation = 'source-atop';
  ctx.fillStyle = `rgba(255,255,255,${Math.max(0, Math.min(1, whiteness))})`;
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.globalCompositeOperation = 'source-over';
  return out;
}

const COAST_TABLE: Record<number, Pos> = {
  0: [0, 7], 1: [1, 7], 2: [2, 7], 3: [3, 7], 4: [4, 7], 5: [4, 6], 6: [6, 6], 7: [2, 6],
  8: [0, 6], 9: [5, 6], 10: [3, 6], 11: [7, 6], 12: [1, 6], 13: [0, 5], 14: [0, 0],
};

/** Python coast() candidate sets per neighbour: [out of bounds, sea, coast, other]. */
const COAST_SETS: [number, number, number[], number[], number[], number[]][] = [
  [0, -1, [2, 3, 4, 8, 11, 12, 13], [0, 1, 5, 6, 7, 9, 10], [2, 3, 5, 6, 7, 9, 10, 11, 12, 13], [2, 3, 4, 8, 11, 12, 13]],
  [-1, 0, [1, 3, 4, 7, 10, 12, 13], [0, 2, 5, 6, 8, 9, 11], [1, 4, 5, 6, 8, 9, 10, 11, 12, 13], [1, 3, 4, 7, 10, 12, 13]],
  [1, 0, [1, 2, 4, 6, 9, 11, 13], [0, 3, 5, 7, 8, 10, 12], [1, 4, 5, 7, 8, 9, 10, 11, 12, 13], [1, 2, 4, 6, 9, 11, 13]],
  [0, 1, [1, 2, 3, 5, 9, 10, 13], [0, 4, 6, 7, 8, 11, 12], [2, 3, 6, 7, 8, 9, 10, 11, 12, 13], [1, 2, 3, 5, 9, 10, 13]],
  [-1, -1, [0, 1, 2, 3, 4, 7, 8, 10, 11, 12], [0, 1, 2, 5, 6, 7, 8, 9, 10, 11], [0, 1, 2, 5, 6, 7, 8, 9, 10, 11, 12], [0, 1, 2, 3, 4, 7, 8, 9, 10, 11, 12]],
  [1, -1, [0, 1, 2, 3, 4, 6, 8, 9, 11, 12], [0, 1, 3, 5, 6, 7, 8, 9, 10, 12], [0, 1, 3, 5, 6, 7, 8, 9, 10, 11, 12], [0, 1, 2, 3, 4, 6, 8, 9, 10, 11, 12]],
  [-1, 1, [0, 1, 2, 3, 4, 5, 7, 9, 10, 12], [0, 2, 4, 5, 6, 7, 8, 9, 11, 12], [0, 2, 4, 5, 6, 7, 8, 9, 10, 11, 12], [0, 1, 2, 3, 4, 5, 7, 9, 10, 11, 12]],
  [1, 1, [0, 1, 2, 3, 4, 5, 6, 9, 10, 11], [0, 3, 4, 5, 6, 7, 8, 10, 11, 12], [0, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], [0, 1, 2, 3, 4, 5, 6, 9, 10, 11, 12]],
];

class MiniMap {
  private mapW: number;
  private mapH: number;
  private surf: SurfaceClass;
  private pinSurf: SurfaceClass;
  private tiles: SurfaceClass;
  private cliffManager: CliffManager;
  private game: any;

  constructor(game: any, tiles: SurfaceClass) {
    this.game = game;
    this.tiles = tiles;
    this.mapW = game.tilemap.width;
    this.mapH = game.tilemap.height;
    this.surf = new SurfaceClass(this.mapW * SCALE, this.mapH * SCALE);
    this.pinSurf = new SurfaceClass(this.mapW * SCALE, this.mapH * SCALE);

    const cliffs: Pos[] = [];
    for (let x = 0; x < this.mapW; x++) {
      for (let y = 0; y < this.mapH; y++) if (CLIFFS.includes(this.key([x, y]))) cliffs.push([x, y]);
    }
    this.cliffManager = new CliffManager(cliffs, this.mapW, this.mapH);

    for (let x = 0; x < this.mapW; x++) {
      for (let y = 0; y < this.mapH; y++) {
        const cell = this.handleKey(this.key([x, y]), [x, y]);
        if (cell) this.surf.blitFrom(this.tiles, cell[0] * SCALE, cell[1] * SCALE, SCALE, SCALE, x * SCALE, y * SCALE);
      }
    }
    // Python set_colorkey(self.surf, (0, 0, 0)): black is transparent.
    const data = this.surf.getImageData();
    for (let i = 0; i < data.data.length; i += 4) {
      if (data.data[i] === 0 && data.data[i + 1] === 0 && data.data[i + 2] === 0) data.data[i + 3] = 0;
    }
    this.surf.putImageData(data);

    // Fog of war: known terrain is halved, unknown terrain is near-black.
    const fogInfo = game.getCurrentFogInfo?.();
    if (fogInfo && (fogInfo.isActive || game.board.fogRegionSet?.size > 0)) {
      const ctx = this.surf.ctx;
      for (let x = 0; x < this.mapW; x++) {
        for (let y = 0; y < this.mapH; y++) {
          const visible = game.board.inVision([x, y], 'player', fogInfo, game.db, game.getAllUnits());
          if (visible) continue;
          if (game.board.terrainKnown([x, y], visible, fogInfo)) {
            ctx.globalCompositeOperation = 'multiply';
            this.surf.fillRect(x * SCALE, y * SCALE, SCALE, SCALE, 'rgb(128,128,128)');
            ctx.globalCompositeOperation = 'source-over';
          } else {
            this.surf.fillRect(x * SCALE, y * SCALE, SCALE, SCALE, 'rgb(12,12,12)');
          }
        }
      }
    }
    this.buildUnits(game);
  }

  /** Python get_minimap_key. */
  private key(pos: Pos): string {
    const nid = this.game.board.getTerrain(pos[0], pos[1]);
    return (nid && this.game.db.terrain.get(nid)?.minimap) || 'Grass';
  }

  private inBounds(pos: Pos): boolean {
    return pos[0] >= 0 && pos[1] >= 0 && pos[0] < this.mapW && pos[1] < this.mapH;
  }

  /** Python handle_key: the Minimap_Tiles cell (x, y) for a terrain key. */
  private handleKey(key: string, pos: Pos): Pos | null {
    if (SINGLE_MAP[key]) return SINGLE_MAP[key];
    if (key === 'Bridge') return this.bridgeLeftRight(pos) ? [0, 1] : [8, 1];
    if (key === 'Door') return this.doorType(pos);
    if (COMPLEX_MAP.includes(key)) return this.complexShape(key, pos);
    if (key === 'Coast') return this.coastCell(pos, 'Coast', ['Sea', 'Pier', 'River', 'Bridge'], [0, 0]);
    if (key === 'Lava_Coast') return this.coastCell(pos, 'Lava_Coast', ['Lava'], [0, 3]);
    if (CLIFFS.includes(key)) {
      const o = this.cliffManager.getOrientation(pos);
      if (key === 'Desert_Cliff') return [o[0] + 4, o[1]];
      if (key === 'Snow_Cliff') return [o[0] - 4, o[1] + 1];
      return o;
    }
    console.warn(`Minimap: unrecognized minimap key ${key}`);
    return null;
  }

  private bridgeLeftRight(pos: Pos): boolean {
    let p: Pos = pos;
    while (this.inBounds(p) && this.key(p) === 'Bridge') p = [p[0] - 1, p[1]];
    return this.inBounds(p) && !['Sea', 'River', 'Wall', 'Lava'].includes(this.key(p));
  }

  private doorType(pos: Pos): Pos {
    const left: Pos = [pos[0] - 1, pos[1]];
    const right: Pos = [pos[0] + 1, pos[1]];
    if (this.inBounds(left) && this.key(left) === 'Door') return [7, 1];
    if (this.inBounds(right) && this.key(right) === 'Door') return [6, 1];
    return [7, 0];
  }

  private complexShape(key: string, pos: Pos): Pos {
    let column = COMPLEX_MAP.indexOf(key) + 2;
    const keys = key === 'Sand' ? ['Sand', 'Desert', 'Desert_Cliff', 'Wall']
      : key === 'Sea' || key === 'River' ? ['Sea', 'Coast', 'River', 'Wall', 'Pier', 'Bridge']
        : [key];
    if (key === 'Lava') column += 2;
    let row = 0;
    const match = (p: Pos) => !this.inBounds(p) || keys.includes(this.key(p));
    if (match([pos[0] - 1, pos[1]])) row += 1;
    if (match([pos[0] + 1, pos[1]])) row += 2;
    if (match([pos[0], pos[1] - 1])) row += 4;
    if (match([pos[0], pos[1] + 1])) row += 8;
    return [row, column];
  }

  /** Python coast(allow_recurse=False): the coast piece number 0-14. */
  private coastValue(pos: Pos, coastKey: string, seaKeys: string[], allowRecurse: boolean): number {
    let candidates: number[] | null = null;
    for (const [dx, dy, oob, sea, coast, other] of COAST_SETS) {
      const p: Pos = [pos[0] + dx, pos[1] + dy];
      let set: number[];
      if (!this.inBounds(p)) set = oob;
      else if (seaKeys.includes(this.key(p))) set = sea;
      else if (this.key(p) === coastKey) set = coast;
      else set = other;
      candidates = candidates === null ? [...set] : candidates.filter((v) => set.includes(v));
    }
    const intersection = (candidates ?? []).sort((a, b) => a - b);
    if (intersection.length === 0) return 14;
    let value = intersection[0];
    if (intersection.length >= 2 && allowRecurse && [9, 10, 11, 12].includes(value)) {
      const leftPos: Pos = [pos[0] - 1, pos[1]];
      const rightPos: Pos = [pos[0] + 1, pos[1]];
      // Python recurses with the default (Coast) keys.
      if (this.inBounds(leftPos) && this.key(leftPos) === coastKey) {
        const left = this.coastValue(leftPos, 'Coast', ['Sea', 'Pier', 'River', 'Bridge'], false);
        if (left === 9) value = 10;
        else if (left === 11) value = 12;
      }
      if (this.inBounds(rightPos) && this.key(rightPos) === coastKey) {
        const right = this.coastValue(rightPos, 'Coast', ['Sea', 'Pier', 'River', 'Bridge'], false);
        if (right === 10) value = 9;
        else if (right === 12) value = 11;
      }
    }
    return value;
  }

  private coastCell(pos: Pos, coastKey: string, seaKeys: string[], offset: Pos): Pos {
    const [row, column] = COAST_TABLE[this.coastValue(pos, coastKey, seaKeys, true)];
    return [row + offset[0], column + offset[1]];
  }

  /** Python build_units: one Minimap_Sprites cell per team index. */
  buildUnits(game: any): void {
    this.pinSurf.clear();
    const pins = getSprite('Minimap_Sprites');
    if (!pins) return;
    const teams: string[] = game.db.teams.defs.map((team: { nid: string }) => team.nid);
    const fogInfo = game.getCurrentFogInfo?.();
    for (const unit of (game.units as Map<string, any>).values()) {
      if (!unit.position || unit.dead || unit.isDead?.() || unit.tags?.includes('Tile')) continue;
      if (!game.board.inVision(unit.position, 'player', fogInfo, game.db, game.getAllUnits())) continue;
      let idx = teams.indexOf(unit.team);
      if (idx < 0 || idx * SCALE >= pins.width) idx = 0;
      this.pinSurf.blitFrom(pins, SCALE * idx, 0, SCALE, SCALE, unit.position[0] * SCALE, unit.position[1] * SCALE);
    }
  }

  /** Python occlude: reveal through a growing rectangle rotating by 90 degrees. */
  private occlude(image: SurfaceClass, progress: number, isExiting: boolean): SurfaceClass {
    const width = Math.trunc(this.mapH * SCALE * 0.25) + Math.trunc(this.mapH * SCALE * 0.75 * progress);
    const height = Math.trunc(this.mapW * SCALE * 0.25) + Math.trunc(this.mapW * SCALE * 0.75 * progress);
    const out = image.copy();
    const ctx = out.ctx;
    ctx.save();
    ctx.globalCompositeOperation = 'destination-in';
    ctx.translate(out.width / 2, out.height / 2);
    // pygame rotate(+deg) turns counter-clockwise; canvas rotate(+rad) clockwise.
    ctx.rotate(-(progress * (isExiting ? 90 : -90)) * Math.PI / 180);
    ctx.fillStyle = '#fff';
    ctx.fillRect(-width / 2, -height / 2, width, height);
    ctx.restore();
    return out;
  }

  /** Python MiniMap.draw; camera position in tiles. */
  draw(surf: SurfaceClass, camTileX: number, camTileY: number, progress: number, isExiting: boolean, now: number): void {
    const currentTime = now % 2000;
    progress = Math.max(0, Math.min(1, progress));
    let image = this.surf.copy();
    let units = this.pinSurf;
    if (currentTime > 1600) units = makeWhite(units, 0.01 * (100 - Math.floor(Math.abs(currentTime - 1800) / 2)));
    image.blit(units, 0, 0);
    if (progress !== 1) image = this.occlude(image, progress, isExiting);

    const vw = viewport.width;
    const vh = viewport.height;
    const tileX = Math.floor(vw / TILEWIDTH);
    const tileY = Math.floor(vh / TILEHEIGHT);
    const viewportW = Math.floor(vw / SCALE) - 2;
    const viewportH = Math.floor(vh / SCALE) - 2;
    const xperc = this.mapW > tileX ? camTileX / (this.mapW - tileX) : 0;
    const yperc = this.mapH > tileY ? camTileY / (this.mapH - tileY) : 0;
    const xprogress = Math.trunc(Math.max(this.mapW - viewportW, 0) * xperc * SCALE);
    const yprogress = Math.trunc(Math.max(this.mapH - viewportH, 0) * yperc * SCALE);
    const w = Math.min(image.width, vw - 2 * SCALE);
    const h = Math.min(image.height, vh - 2 * SCALE);
    const view = makeTranslucent(image.subsurface(xprogress, yprogress, w, h), 0.1);
    const left = Math.max(4, Math.floor(vw / 2) - Math.floor(view.width / 2));
    const top = Math.max(4, Math.floor(vh / 2) - Math.floor(view.height / 2));
    surf.blit(view, left, top);

    let cursor = getSprite('Minimap_Cursor');
    if (progress === 1 && cursor) {
      if (currentTime > 1600 || (currentTime > 600 && currentTime < 1000)) {
        const centre = currentTime > 1600 ? 1800 : 800;
        cursor = makeWhite(cursor, 0.01 * (100 - Math.floor(Math.abs(currentTime - centre) / 2)));
      }
      surf.blit(cursor, left + camTileX * SCALE - 1 - xprogress, top + camTileY * SCALE - 1 - yprogress);
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
    game.audioManager?.playSfx?.('Map In');
    const tiles = getSprite('Minimap_Tiles');
    this.minimap = tiles ? new MiniMap(game, tiles) : null;
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
      game.audioManager?.playSfx?.('Map Out');
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
    const game = getGame();
    if (!this.minimap) {
      // Minimap_Tiles was still loading when the state started.
      const tiles = getSprite('Minimap_Tiles');
      if (!tiles) return surf;
      this.minimap = new MiniMap(game, tiles);
    }
    const [camX, camY] = game.camera.getPosition();

    // Compute progress 0→1
    let progress: number;
    if (this.isExiting) {
      // Reverse: 1 → 0
      progress = Math.max(0, 1 - this.exitTimer / this.transitionTime);
    } else {
      progress = Math.min(1, this.arriveTimer / this.transitionTime);
    }

    this.minimap.draw(surf as SurfaceClass, camX / TILEWIDTH, camY / TILEHEIGHT, progress, this.isExiting,
      getFrameCount() * FRAMETIME);
    return surf;
  }
}
