import { Surface } from '../engine/surface';
import { TILEWIDTH, TILEHEIGHT, ANIMATION_COUNTERS } from '../engine/constants';

export type HighlightType =
  'move' | 'attack' | 'spell' | 'splash' | 'selected' | 'threat' | 'aura' | 'formation' |
  'possible_move' | 'spell_splash';

/**
 * Python HighlightController images, in its draw (dict) order. 'splash' is
 * the light attack range (highlight_lightred), 'possible_move' the light
 * move range and 'spell_splash' the light spell range.
 */
export const HIGHLIGHT_SPRITES: [HighlightType, string][] = [
  ['spell', 'highlight_green'],
  ['attack', 'highlight_red'],
  ['splash', 'highlight_lightred'],
  ['possible_move', 'highlight_lightblue'],
  ['move', 'highlight_blue'],
  ['aura', 'highlight_lightpurple'],
  ['spell_splash', 'highlight_lightgreen'],
];

/** One sprite highlight layer for a frame: its tiles and grow-in cut-off. */
export interface HighlightLayer {
  type: HighlightType;
  sprite: string;
  keys: string[];
  cutoff: number;
}

/** Python HighlightController.starting_cutoff. */
const STARTING_CUTOFF = 7;

/** Base RGBA for each highlight type (alpha is the centre value of the pulse). */
const HIGHLIGHT_COLORS: Record<HighlightType, [number, number, number, number]> = {
  move:     [0,   100, 255, 0.25],
  attack:   [255, 0,   0,   0.25],
  spell:    [0,   200, 80,  0.25],
  splash:   [255, 120, 120, 0.20],
  possible_move: [120, 170, 255, 0.20],
  spell_splash: [120, 220, 140, 0.20],
  selected: [255, 255, 0,   0.30],
  threat:   [180, 0,   80,  0.22],  // Magenta/purple for enemy threat zones
  aura:     [190, 120, 255, 0.20],
  // Python Highlight.show_formation draws the animated highlight_blue sprite
  // (map-view); this colour is only the fallback before it loads.
  formation: [0,  100, 255, 0.25],
};

/**
 * HighlightManager - Manages colored tile overlays for movement/attack ranges.
 * Supports different highlight types: move (blue), attack (red), spell (green), etc.
 */
export class HighlightManager {
  private highlights: Map<string, HighlightType> = new Map(); // "x,y" -> type
  /** Aura is an overlay layer so clearing hover never destroys threat ranges. */
  private auraHighlights = new Set<string>();

  /** Python update_idx: sprite frame = updateIdx // 4, advanced once per drawn map. */
  updateIdx = 0;

  /** Python transitions: per-type grow-in cut-off, reset whenever the type changes. */
  private transitions = new Map<HighlightType, number>();

  private touch(type: HighlightType): void {
    this.transitions.set(type, STARTING_CUTOFF);
  }

  /**
   * The sprite-drawn highlight layers for this frame, in Python's draw order.
   * Like HighlightController.draw, each non-empty layer's cut-off shrinks by
   * one per drawn frame, so a new range grows in over 7 frames.
   */
  spriteLayers(): HighlightLayer[] {
    const byType = new Map<HighlightType, string[]>();
    for (const [key, type] of this.highlights) {
      if (!byType.has(type)) byType.set(type, []);
      byType.get(type)!.push(key);
    }
    if (this.auraHighlights.size) byType.set('aura', [...this.auraHighlights]);
    const layers: HighlightLayer[] = [];
    for (const [type, sprite] of HIGHLIGHT_SPRITES) {
      const keys = byType.get(type);
      if (!keys?.length) continue;
      const cutoff = Math.max(0, (this.transitions.get(type) ?? STARTING_CUTOFF) - 1);
      this.transitions.set(type, cutoff);
      layers.push({ type, sprite, keys, cutoff });
    }
    return layers;
  }

  /** Current pulse multiplier (0..1), updated each frame. */
  private pulse: number = 1.0;

  addHighlight(x: number, y: number, type: HighlightType): void {
    this.highlights.set(`${x},${y}`, type);
    this.touch(type);
  }

  /** Python add_highlights(positions, name): replaces other types on those tiles. */
  addHighlights(positions: [number, number][], type: HighlightType): void {
    for (const [x, y] of positions) this.highlights.set(`${x},${y}`, type);
    this.touch(type);
  }

  removeHighlight(x: number, y: number): void {
    this.highlights.delete(`${x},${y}`);
  }

  clear(): void {
    this.highlights.clear();
    this.auraHighlights.clear();
    this.transitions.clear();
  }

  setMoveHighlights(positions: [number, number][]): void {
    // Remove existing move highlights
    for (const [key, type] of this.highlights) {
      if (type === 'move') this.highlights.delete(key);
    }
    for (const [x, y] of positions) {
      this.highlights.set(`${x},${y}`, 'move');
    }
    this.touch('move');
  }

  setAttackHighlights(positions: [number, number][]): void {
    for (const [key, type] of this.highlights) {
      if (type === 'attack') this.highlights.delete(key);
    }
    for (const [x, y] of positions) {
      this.highlights.set(`${x},${y}`, 'attack');
    }
    this.touch('attack');
  }

  setSpellHighlights(positions: [number, number][]): void {
    for (const [key, type] of this.highlights) {
      if (type === 'spell') this.highlights.delete(key);
    }
    for (const [x, y] of positions) {
      this.highlights.set(`${x},${y}`, 'spell');
    }
    this.touch('spell');
  }

  setThreatHighlights(positions: [number, number][]): void {
    for (const [key, type] of this.highlights) {
      if (type === 'threat') this.highlights.delete(key);
    }
    for (const [x, y] of positions) {
      this.highlights.set(`${x},${y}`, 'threat');
    }
    this.touch('threat');
  }

  setAuraHighlights(positions: [number, number][]): void {
    this.auraHighlights = new Set(positions.map(([x, y]) => `${x},${y}`));
    this.touch('aura');
  }

  /** Clear all highlights of a specific type. */
  clearType(type: HighlightType): void {
    this.touch(type);
    if (type === 'aura') {
      this.auraHighlights.clear();
      return;
    }
    for (const [key, t] of this.highlights) {
      if (t === type) this.highlights.delete(key);
    }
  }

  /** Check if any highlights of a given type exist. */
  hasType(type: HighlightType): boolean {
    if (type === 'aura') return this.auraHighlights.size > 0;
    for (const t of this.highlights.values()) {
      if (t === type) return true;
    }
    return false;
  }

  getHighlights(): Map<string, HighlightType> {
    const merged = new Map(this.highlights);
    for (const key of this.auraHighlights) merged.set(key, 'aura');
    return merged;
  }

  /**
   * Draw all highlights onto a surface.
   * @param surf     Target surface (typically the map surface).
   * @param offsetX  Camera offset X (world pixels of the viewport top-left).
   * @param offsetY  Camera offset Y.
   */
  draw(surf: Surface, offsetX: number, offsetY: number): void {
    for (const [key, type] of this.getHighlights()) {
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
    // Python HighlightController.update: the sprite frame counter (0..63).
    this.updateIdx = (this.updateIdx + 1) % 64;
    // passive counter cycles 0-3 over ~64 frames at 60fps (~1s period)
    const counter = ANIMATION_COUNTERS.passive; // 0..3
    // Map to a smooth triangle wave: 0->0, 1->1, 2->1, 3->0
    // then remap to 0.7..1.0 range for a subtle pulse
    const triangle = Math.min(1, counter); // passive_sprite_counter 0, 1, 2
    this.pulse = 0.7 + 0.3 * (triangle / 1); // 0.7, 1.0, 1.0, 0.7
  }
}
