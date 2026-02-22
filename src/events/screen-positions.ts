/**
 * screen-positions.ts — Resolves named screen positions for portrait placement.
 * Ported from: app/events/screen_positions.py
 *
 * LT's fixed 240x160 resolution defines standard portrait positions for
 * dialog scenes. Portraits at or left of CenterLeft are auto-mirrored.
 */

import { viewport } from '../engine/viewport';

// Portrait face region is 96x80
const PORTRAIT_FACE_WIDTH = 96;
const PORTRAIT_FACE_HEIGHT = 80;

/**
 * Build named position maps using the current viewport dimensions.
 * Called at resolution time (not module load) so they reflect the
 * actual viewport size, which changes with zoom and screen resize.
 */
function getHorizPositions(): Record<string, number> {
  const W = viewport.width;
  return {
    offscreenleft: -PORTRAIT_FACE_WIDTH,
    farleft: -24,
    leftcorner: -16,
    left: 0,
    midleft: 24,
    centerleft: 24,
    centerright: W - 120,
    midright: W - 120,
    levelupright: W - 100,
    right: W - PORTRAIT_FACE_WIDTH,
    rightcorner: W - 80,
    farright: W - 72,
    offscreenright: W,
  };
}

function getVertPositions(): Record<string, number> {
  const H = viewport.height;
  return {
    top: 0,
    middle: Math.floor((H - PORTRAIT_FACE_HEIGHT) / 2),
    bottom: H - PORTRAIT_FACE_HEIGHT,
  };
}

/** Auto-mirror threshold: portraits at X <= this are mirrored. */
const MIRROR_THRESHOLD = 24; // matches centerleft

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
  const HORIZ = getHorizPositions();
  const VERT = getVertPositions();
  const lower = pos.toLowerCase().replace(/\s+/g, '');

  // Check for comma-separated pair
  if (lower.includes(',')) {
    const parts = lower.split(',');
    const first = parts[0];
    const second = parts[1];

    // Try named resolution for both parts
    const x = HORIZ[first] ?? parseFloat(first);
    const y = VERT[second] ?? parseFloat(second);

    if (!isNaN(x) && !isNaN(y)) {
      return {
        position: [x, y],
        mirror: x <= MIRROR_THRESHOLD,
      };
    }
  }

  // Single name: try horizontal first
  if (HORIZ[lower] !== undefined) {
    const x = HORIZ[lower];
    return {
      position: [x, VERT.bottom],
      mirror: x <= MIRROR_THRESHOLD,
    };
  }

  // Try vertical
  if (VERT[lower] !== undefined) {
    return {
      position: [HORIZ.left, VERT[lower]],
      mirror: true, // Left position = mirrored
    };
  }

  // Fallback: try numeric
  const num = parseFloat(lower);
  if (!isNaN(num)) {
    return {
      position: [num, VERT.bottom],
      mirror: num <= MIRROR_THRESHOLD,
    };
  }

  // Default: left bottom, mirrored
  return {
    position: [HORIZ.left, VERT.bottom],
    mirror: true,
  };
}
