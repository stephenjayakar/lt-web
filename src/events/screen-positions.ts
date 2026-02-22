/**
 * screen-positions.ts — Resolves named screen positions for portrait placement.
 * Ported from: app/events/screen_positions.py
 *
 * LT's fixed 240x160 resolution defines standard portrait positions for
 * dialog scenes. Portraits at or left of CenterLeft are auto-mirrored.
 */

import { WINWIDTH, WINHEIGHT } from '../engine/constants';

// Portrait face region is 96x80
const PORTRAIT_FACE_WIDTH = 96;
const PORTRAIT_FACE_HEIGHT = 80;

/** Named horizontal screen positions (x offset in pixels). */
const HORIZ_POSITIONS: Record<string, number> = {
  offscreenleft: -PORTRAIT_FACE_WIDTH,
  farleft: -24,
  leftcorner: -16,
  left: 0,
  midleft: 24,
  centerleft: 24,
  centerright: WINWIDTH - 120,
  midright: WINWIDTH - 120,
  levelupright: WINWIDTH - 100,
  right: WINWIDTH - PORTRAIT_FACE_WIDTH,
  rightcorner: WINWIDTH - 80,
  farright: WINWIDTH - 72,
  offscreenright: WINWIDTH,
};

/** Named vertical screen positions (y offset in pixels). */
const VERT_POSITIONS: Record<string, number> = {
  top: 0,
  middle: Math.floor((WINHEIGHT - PORTRAIT_FACE_HEIGHT) / 2),
  bottom: WINHEIGHT - PORTRAIT_FACE_HEIGHT,
};

/** Auto-mirror threshold: portraits at X <= this are mirrored. */
const MIRROR_THRESHOLD = HORIZ_POSITIONS.centerleft;

/**
 * Resolve a position string to [x, y] and whether to auto-mirror.
 *
 * Accepts:
 * - A single horizontal name (e.g. "Left", "MidRight") → (x, Bottom)
 * - A single vertical name (e.g. "Top", "Middle") → (Left, y)
 * - A comma-separated pair "horiz,vert" (e.g. "Left,Top")
 * - A literal "x,y" numeric pair (e.g. "24,80")
 */
export function parseScreenPosition(pos: string): {
  position: [number, number];
  mirror: boolean;
} {
  const lower = pos.toLowerCase().replace(/\s+/g, '');

  // Check for comma-separated pair
  if (lower.includes(',')) {
    const parts = lower.split(',');
    const first = parts[0];
    const second = parts[1];

    // Try named resolution for both parts
    const x = HORIZ_POSITIONS[first] ?? parseFloat(first);
    const y = VERT_POSITIONS[second] ?? parseFloat(second);

    if (!isNaN(x) && !isNaN(y)) {
      return {
        position: [x, y],
        mirror: x <= MIRROR_THRESHOLD,
      };
    }
  }

  // Single name: try horizontal first
  if (HORIZ_POSITIONS[lower] !== undefined) {
    const x = HORIZ_POSITIONS[lower];
    return {
      position: [x, VERT_POSITIONS.bottom],
      mirror: x <= MIRROR_THRESHOLD,
    };
  }

  // Try vertical
  if (VERT_POSITIONS[lower] !== undefined) {
    return {
      position: [HORIZ_POSITIONS.left, VERT_POSITIONS[lower]],
      mirror: true, // Left position = mirrored
    };
  }

  // Fallback: try numeric
  const num = parseFloat(lower);
  if (!isNaN(num)) {
    return {
      position: [num, VERT_POSITIONS.bottom],
      mirror: num <= MIRROR_THRESHOLD,
    };
  }

  // Default: left bottom, mirrored
  return {
    position: [HORIZ_POSITIONS.left, VERT_POSITIONS.bottom],
    mirror: true,
  };
}
