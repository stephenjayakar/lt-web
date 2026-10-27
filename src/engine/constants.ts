// Core engine constants - matches LT's GBA-resolution design
export const TILEWIDTH = 16;
export const TILEHEIGHT = 16;
export const TILEX = 15; // viewport width in tiles
export const TILEY = 10; // viewport height in tiles
export const WINWIDTH = TILEX * TILEWIDTH; // 240
export const WINHEIGHT = TILEY * TILEHEIGHT; // 160
export const FPS = 60;
export const FRAMETIME = 1000 / FPS;

// Transparent color key (used in original for colorkey transparency)
export const COLORKEY: [number, number, number] = [128, 160, 128];

// Portrait dimensions (LT standard)
export const PORTRAIT_WIDTH = 128;
export const PORTRAIT_HEIGHT = 112;

// Animation frame counters
export const ANIMATION_COUNTERS = {
  /** Python passive_sprite_counter.count (0, 1, 2): passive/gray map sprite frame. */
  passive: 0,
  /** Python active_sprite_counter.count (0, 1, 2): the hovered unit's active frame. */
  activeSprite: 0,
  /** Python move_sprite_counter.count (0..3): walking frames. */
  move: 0,
  active: 0,
  fast: 0,
  arrow: 0,
};

/** Python app.counters.generic3counter (0 -> 1 -> 2 -> 1 -> 0 ...). */
class Generic3Counter {
  count = 0;
  private lastUpdate = 0;
  private lastCount = 1;
  private readonly first: number;
  private readonly second: number;

  constructor(first: number, second: number) {
    this.first = first;
    this.second = second;
  }

  update(time: number): void {
    const limit = this.count === 1 ? this.second : this.first;
    if (time - this.lastUpdate <= limit) return;
    this.lastUpdate = time;
    if (this.count === 0) { this.count = 1; this.lastCount = 0; }
    else if (this.count === 2) { this.count = 1; this.lastCount = 2; }
    else if (this.lastCount === 0) { this.count = 2; this.lastCount = 1; }
    else { this.count = 0; this.lastCount = 1; }
  }
}

/** Python app.counters.simplecounter. */
class SimpleCounter {
  count = 0;
  private lastUpdate = 0;
  private readonly times: number[];

  constructor(times: number[]) {
    this.times = times;
  }

  update(time: number): void {
    if (time - this.lastUpdate > this.times[this.count]) {
      this.count = (this.count + 1) % this.times.length;
      this.lastUpdate = time;
    }
  }
}

/** Python utils.frames2ms: int(16.67 * frames). */
const frames2msInt = (frames: number): number => Math.trunc(16.67 * frames);
// Python game_counters.Counters, driven by the engine's integer ms clock.
const passiveSpriteCounter = new Generic3Counter(frames2msInt(32), frames2msInt(4));
const activeSpriteCounter = new Generic3Counter(frames2msInt(20), frames2msInt(4));
const moveSpriteCounter = new SimpleCounter([frames2msInt(13), frames2msInt(6), frames2msInt(13), frames2msInt(6)]);

let _frameCount = 0;
export function updateAnimationCounters(): void {
  _frameCount++;
  const time = Math.floor(_frameCount * 1000 / 60);
  passiveSpriteCounter.update(time);
  activeSpriteCounter.update(time);
  moveSpriteCounter.update(time);
  ANIMATION_COUNTERS.passive = passiveSpriteCounter.count;
  ANIMATION_COUNTERS.activeSprite = activeSpriteCounter.count;
  ANIMATION_COUNTERS.move = moveSpriteCounter.count;
  // Active animation: faster cycling
  ANIMATION_COUNTERS.active = Math.floor(_frameCount / 8) % 8;
  // Fast: every 4 frames
  ANIMATION_COUNTERS.fast = Math.floor(_frameCount / 4) % 4;
  // Arrow animation
  ANIMATION_COUNTERS.arrow = Math.floor(_frameCount / 6) % 8;
}

export function getFrameCount(): number {
  return _frameCount;
}
