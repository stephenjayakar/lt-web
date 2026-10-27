/**
 * QA virtual clock (dev/QA builds only; see docs/qa-tools.md).
 *
 * The engine is frame-stepped like Python's 60 FPS clock, but a few
 * presentation paths (portrait fades, level-up screens, prep fades, map
 * animations) read performance.now()/Date.now(). When QA runs step many
 * frames per real millisecond those waits would otherwise still take real
 * time. The virtual clock advances exactly one frame time per stepped frame,
 * so every wait is measured in frames and turbo speed applies uniformly.
 */

const realPerformanceNow = performance.now.bind(performance);
const realDateNow = Date.now.bind(Date);

let virtualMs = 0;
let dateOffsetMs = 0;
let installed = false;

/** Real wall-clock milliseconds (unaffected by the virtual clock). */
export function realNow(): number {
  return realPerformanceNow();
}

/** Real epoch milliseconds. */
export function realDate(): number {
  return realDateNow();
}

export function installVirtualClock(): void {
  if (installed) return;
  installed = true;
  virtualMs = realPerformanceNow();
  dateOffsetMs = realDateNow() - virtualMs;
  performance.now = () => virtualMs;
  Date.now = () => Math.floor(virtualMs + dateOffsetMs);
}

export function advanceVirtualClock(ms: number): void {
  virtualMs += ms;
}

export function virtualNow(): number {
  return virtualMs;
}
