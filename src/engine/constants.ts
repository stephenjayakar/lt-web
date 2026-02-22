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
  passive: 0,
  active: 0,
  fast: 0,
  arrow: 0,
};

let _frameCount = 0;
export function updateAnimationCounters(): void {
  _frameCount++;
  // Passive animation: cycles every 64 frames (about 1s at 60fps)
  ANIMATION_COUNTERS.passive = Math.floor(_frameCount / 32) % 4;
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
