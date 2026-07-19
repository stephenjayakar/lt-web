/**
 * Movement path-preview arrows, shown while hovering a destination tile
 * during MoveState.
 *
 * Ported from: app/engine/level_cursor.py (LevelCursor.construct_arrows,
 * class Arrow). The sprite sheet 'movement_arrows' is a 128x32 grid of
 * 16x16 tiles (8 columns x 2 rows); each path tile picks one (col, row)
 * frame depending on its direction relative to its neighbors:
 *
 *   col 0/1, row 0/1: straight start pieces (right/left/up/down)
 *   col 6/7, row 0/1: straight end pieces (right/left/up/down)
 *   col 3, row 0: horizontal straight-through
 *   col 2, row 0: vertical straight-through
 *   col 4/5, row 0/1: corner pieces
 *
 * Timing: Arrow.draw uses `t = sin(radians((get_time()//5 - idx*6) % 180))`
 * to blend between a bright orange-red (200,40,0) and black, staggered by
 * path index (idx*6) so the pulse appears to travel along the path.
 */

import type { Surface } from '../engine/surface';
import { TILEWIDTH, TILEHEIGHT } from '../engine/constants';

export type ArrowSegment = {
  /** Sprite sheet column (0-7). */
  col: number;
  /** Sprite sheet row (0-1). */
  row: number;
  /** Tile position on the map. */
  position: [number, number];
  /** Index within the path (0 = start). */
  idx: number;
};

/**
 * Compute arrow segments for a path, given in start->end tile order.
 * Mirrors LevelCursor.construct_arrows exactly (path here is already in
 * start->end order, matching the reversed `path[::-1]` Python passes in).
 */
export function computeArrowSegments(path: [number, number][]): ArrowSegment[] {
  const segments: ArrowSegment[] = [];
  if (path.length <= 1) return segments;

  for (let idx = 0; idx < path.length; idx++) {
    const cur = path[idx];
    if (idx === 0) {
      const next = path[idx + 1];
      const dx = next[0] - cur[0];
      const dy = next[1] - cur[1];
      if (dx === 1 && dy === 0) segments.push({ col: 0, row: 0, position: cur, idx });
      else if (dx === -1 && dy === 0) segments.push({ col: 1, row: 1, position: cur, idx });
      else if (dx === 0 && dy === -1) segments.push({ col: 0, row: 1, position: cur, idx });
      else if (dx === 0 && dy === 1) segments.push({ col: 1, row: 0, position: cur, idx });
    } else if (idx === path.length - 1) {
      const prev = path[idx - 1];
      const dx = cur[0] - prev[0];
      const dy = cur[1] - prev[1];
      if (dx === 1 && dy === 0) segments.push({ col: 6, row: 0, position: cur, idx });
      else if (dx === -1 && dy === 0) segments.push({ col: 7, row: 1, position: cur, idx });
      else if (dx === 0 && dy === -1) segments.push({ col: 6, row: 1, position: cur, idx });
      else if (dx === 0 && dy === 1) segments.push({ col: 7, row: 0, position: cur, idx });
    } else {
      const next = path[idx + 1];
      const prev = path[idx - 1];
      const direction: [number, number] = [next[0] - prev[0], next[1] - prev[1]];
      const modifier: [number, number] = [cur[0] - prev[0], cur[1] - prev[1]];
      const isDir = (d: [number, number], a: number, b: number) => d[0] === a && d[1] === b;

      if (isDir(direction, 2, 0) || isDir(direction, -2, 0)) {
        segments.push({ col: 3, row: 0, position: cur, idx });
      } else if (isDir(direction, 0, 2) || isDir(direction, 0, -2)) {
        segments.push({ col: 2, row: 0, position: cur, idx });
      } else if (isDir(direction, 1, -1) || isDir(direction, -1, 1)) {
        if (isDir(modifier, 0, -1) || isDir(modifier, -1, 0)) {
          segments.push({ col: 4, row: 0, position: cur, idx });
        } else if (isDir(modifier, 1, 0) || isDir(modifier, 0, 1)) {
          segments.push({ col: 5, row: 1, position: cur, idx });
        }
      } else if (isDir(direction, 1, 1) || isDir(direction, -1, -1)) {
        if (isDir(modifier, 0, -1) || isDir(modifier, 1, 0)) {
          segments.push({ col: 5, row: 0, position: cur, idx });
        } else {
          segments.push({ col: 4, row: 1, position: cur, idx });
        }
      }
    }
  }
  return segments;
}

export class ArrowRenderer {
  private sheet: HTMLImageElement | null = null;

  async loadSprite(url: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        this.sheet = img;
        resolve();
      };
      img.onerror = () => reject(new Error('Failed to load movement_arrows sprite'));
      img.src = url;
    });
  }

  get loaded(): boolean {
    return this.sheet !== null;
  }

  /**
   * Draw arrow segments. `timeMs` should be a deterministic engine clock
   * (matches engine.get_time() usage in Python) so tests can force a value.
   */
  draw(
    surf: Surface,
    segments: ArrowSegment[],
    cameraOffset: [number, number],
    timeMs: number,
  ): void {
    for (const seg of segments) {
      const [x, y] = seg.position;
      const drawX = x * TILEWIDTH - cameraOffset[0];
      const drawY = y * TILEHEIGHT - cameraOffset[1];

      if (this.sheet) {
        // t = sin(radians((time//5 - idx*6) % 180)) drives a pulsing brightness,
        // staggered per path index so the pulse travels along the path.
        // (Exact per-pixel change_color/blend_colors tinting from Python is not
        // reproduced; we approximate the pulse with alpha so segment identity
        // and timing stay testable without pixel-level color math.)
        const phase = ((Math.floor(timeMs / 5) - seg.idx * 6) % 180 + 180) % 180;
        const t = Math.sin((phase * Math.PI) / 180);
        const prevAlpha = surf.getAlpha();
        surf.setAlpha(0.4 + 0.5 * t);
        surf.blitImage(
          this.sheet,
          seg.col * TILEWIDTH, seg.row * TILEHEIGHT, TILEWIDTH, TILEHEIGHT,
          drawX, drawY,
        );
        surf.setAlpha(prevAlpha);
      } else {
        surf.fillRect(drawX + 4, drawY + 4, TILEWIDTH - 8, TILEHEIGHT - 8, 'rgba(220,60,20,0.5)');
      }
    }
  }
}
