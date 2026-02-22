import { Surface } from '../engine/surface';
import { TILEWIDTH, TILEHEIGHT, ANIMATION_COUNTERS } from '../engine/constants';

export type HighlightType = 'move' | 'attack' | 'spell' | 'splash' | 'selected' | 'threat';

/** Base RGBA for each highlight type (alpha is the centre value of the pulse). */
const HIGHLIGHT_COLORS: Record<HighlightType, [number, number, number, number]> = {
  move:     [0,   100, 255, 0.25],
  attack:   [255, 0,   0,   0.25],
  spell:    [0,   200, 80,  0.25],
  splash:   [200, 100, 255, 0.20],
  selected: [255, 255, 0,   0.30],
  threat:   [180, 0,   80,  0.22],  // Magenta/purple for enemy threat zones
};

/**
 * HighlightManager - Manages colored tile overlays for movement/attack ranges.
 * Supports different highlight types: move (blue), attack (red), spell (green), etc.
 */
export class HighlightManager {
  private highlights: Map<string, HighlightType> = new Map(); // "x,y" -> type

  /** Current pulse multiplier (0..1), updated each frame. */
  private pulse: number = 1.0;

  addHighlight(x: number, y: number, type: HighlightType): void {
    this.highlights.set(`${x},${y}`, type);
  }

  removeHighlight(x: number, y: number): void {
    this.highlights.delete(`${x},${y}`);
  }

  clear(): void {
    this.highlights.clear();
  }

  setMoveHighlights(positions: [number, number][]): void {
    // Remove existing move highlights
    for (const [key, type] of this.highlights) {
      if (type === 'move') this.highlights.delete(key);
    }
    for (const [x, y] of positions) {
      this.highlights.set(`${x},${y}`, 'move');
    }
  }

  setAttackHighlights(positions: [number, number][]): void {
    for (const [key, type] of this.highlights) {
      if (type === 'attack') this.highlights.delete(key);
    }
    for (const [x, y] of positions) {
      this.highlights.set(`${x},${y}`, 'attack');
    }
  }

  setSpellHighlights(positions: [number, number][]): void {
    for (const [key, type] of this.highlights) {
      if (type === 'spell') this.highlights.delete(key);
    }
    for (const [x, y] of positions) {
      this.highlights.set(`${x},${y}`, 'spell');
    }
  }

  setThreatHighlights(positions: [number, number][]): void {
    for (const [key, type] of this.highlights) {
      if (type === 'threat') this.highlights.delete(key);
    }
    for (const [x, y] of positions) {
      this.highlights.set(`${x},${y}`, 'threat');
    }
  }

  /** Clear all highlights of a specific type. */
  clearType(type: HighlightType): void {
    for (const [key, t] of this.highlights) {
      if (t === type) this.highlights.delete(key);
    }
  }

  /** Check if any highlights of a given type exist. */
  hasType(type: HighlightType): boolean {
    for (const t of this.highlights.values()) {
      if (t === type) return true;
    }
    return false;
  }

  getHighlights(): Map<string, HighlightType> {
    return this.highlights;
  }

  /**
   * Draw all highlights onto a surface.
   * @param surf     Target surface (typically the map surface).
   * @param offsetX  Camera offset X (world pixels of the viewport top-left).
   * @param offsetY  Camera offset Y.
   */
  draw(surf: Surface, offsetX: number, offsetY: number): void {
    for (const [key, type] of this.highlights) {
      const parts = key.split(',');
      const tileX = parseInt(parts[0], 10);
      const tileY = parseInt(parts[1], 10);

      const px = tileX * TILEWIDTH - offsetX;
      const py = tileY * TILEHEIGHT - offsetY;

      // Quick cull: skip tiles entirely outside the surface
      if (
        px + TILEWIDTH <= 0 || py + TILEHEIGHT <= 0 ||
        px >= surf.width || py >= surf.height
      ) {
        continue;
      }

      const [r, g, b, baseAlpha] = HIGHLIGHT_COLORS[type];
      // Apply the pulse: alpha oscillates gently around the base
      const alpha = baseAlpha * this.pulse;
      surf.fillRect(px, py, TILEWIDTH, TILEHEIGHT, `rgba(${r},${g},${b},${alpha})`);
    }
  }

  /**
   * Animated pulse effect. Call once per frame.
   * Uses the passive animation counter for a smooth sine-like pulse
   * that oscillates alpha between ~0.7x and ~1.0x of the base value.
   */
  update(): void {
    // passive counter cycles 0-3 over ~64 frames at 60fps (~1s period)
    const counter = ANIMATION_COUNTERS.passive; // 0..3
    // Map to a smooth triangle wave: 0->0, 1->1, 2->1, 3->0
    // then remap to 0.7..1.0 range for a subtle pulse
    const triangle = counter < 2 ? counter : 4 - counter; // 0, 1, 1, 0
    this.pulse = 0.7 + 0.3 * (triangle / 1); // 0.7, 1.0, 1.0, 0.7
  }
}
