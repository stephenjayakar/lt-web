/**
 * perf-monitor.ts — Frame budget monitoring, performance overlay, and
 * profiling tools for the Lex Talionis web engine.
 *
 * Features:
 * - Per-frame metrics: FPS, frame time, update/draw breakdown
 * - Surface pool stats (hit rate, allocation count)
 * - Memory usage tracking (Chrome JS heap)
 * - Peak frame time (stutter detection) with 1-second windows
 * - Sustained frame budget violation detection (mobile optimization)
 * - Per-function timing via `timeFunction()` / `endTimeFunction()`
 * - Long frame spike logging with automatic console warnings
 * - Frame time histogram for distribution analysis
 * - Exportable profiling report (JSON) for offline analysis
 * - Semi-transparent HUD overlay (toggle with F3 or settings)
 *
 * The overlay renders in screen-space on top of everything else.
 * Data is also accessible via `PerfMonitor.getReport()` and
 * `PerfMonitor.exportReport()` for automated testing.
 *
 * Modelled after the Python engine's `LT_PROFILE` environment variable
 * approach (lt-maker/app/engine/driver.py) and `@frame_time` decorator
 * (lt-maker/app/utilities/frame_time.py), adapted for the browser.
 */

import { SurfacePool } from './surface-pool';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface FrameMetrics {
  frameTimeMs: number;
  updateTimeMs: number;
  drawTimeMs: number;
  fps: number;
  minFps: number;             // Worst FPS in the last second (like Python's draw_fps)
  surfacePoolHitRate: number;
  surfacePoolAcquires: number;
  surfacePoolCached: number;
  memoryUsageMb: number;
  canvasCount: number;        // Estimated active OffscreenCanvas count
}

interface FunctionTiming {
  name: string;
  totalMs: number;
  calls: number;
  maxMs: number;
}

interface LongFrameEntry {
  timestamp: number;
  frameTimeMs: number;
  updateTimeMs: number;
  drawTimeMs: number;
}

/** Histogram bucket for frame time distribution. */
interface HistogramBucket {
  label: string;
  count: number;
  percentage: number;
}

interface ProfilingReport {
  /** Duration of the profiling session in seconds. */
  durationSec: number;
  /** Total frames captured. */
  totalFrames: number;
  /** Average FPS over the session. */
  avgFps: number;
  /** Minimum FPS observed (1-second window). */
  minFps: number;
  /** 1st percentile frame time (worst frames). */
  p99FrameTimeMs: number;
  /** 95th percentile frame time. */
  p95FrameTimeMs: number;
  /** Median frame time. */
  medianFrameTimeMs: number;
  /** Average frame time. */
  avgFrameTimeMs: number;
  /** Peak single-frame time. */
  peakFrameTimeMs: number;
  /** Number of frames that exceeded the 16.67ms budget. */
  droppedFrames: number;
  /** Frame time distribution histogram. */
  histogram: HistogramBucket[];
  /** Top per-function timings (sorted by total time). */
  functionTimings: FunctionTiming[];
  /** Long frame spikes (>33ms). */
  longFrames: LongFrameEntry[];
  /** Surface pool stats. */
  surfacePool: { hitRate: number; peakCached: number };
  /** Memory usage stats (Chrome only). */
  memory: { peakMb: number; currentMb: number };
  /** Device info. */
  device: {
    userAgent: string;
    hardwareConcurrency: number;
    deviceMemoryGb: number | null;
    screenWidth: number;
    screenHeight: number;
    devicePixelRatio: number;
  };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Number of frames to average over for smoothed FPS. */
const SMOOTH_FRAMES = 60;

/** Frame time budget at 60fps. */
const BUDGET_MS = 16.67;

/** Threshold for "long frame" spike warnings. */
const LONG_FRAME_THRESHOLD_MS = 33.33; // 2 frames

/** Maximum long frame entries to keep. */
const MAX_LONG_FRAMES = 100;

/** How many seconds of sustained budget violation triggers a warning. */
const SUSTAINED_VIOLATION_SEC = 3;

// ---------------------------------------------------------------------------
// Histogram buckets (frame time ranges)
// ---------------------------------------------------------------------------

const HISTOGRAM_RANGES = [
  { max: 8, label: '<8ms' },
  { max: 12, label: '8-12ms' },
  { max: 16.67, label: '12-16ms' },
  { max: 20, label: '16-20ms' },
  { max: 33.33, label: '20-33ms' },
  { max: 50, label: '33-50ms' },
  { max: Infinity, label: '>50ms' },
];

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

class PerfMonitorImpl {
  private enabled: boolean = false;
  private frameStart: number = 0;
  private updateStart: number = 0;
  private updateEnd: number = 0;
  private drawStart: number = 0;
  private drawEnd: number = 0;

  /** Circular buffer of recent frame times for smoothed FPS. */
  private frameTimes: number[] = new Array(SMOOTH_FRAMES).fill(BUDGET_MS);
  private frameIndex: number = 0;
  private totalFrameTime: number = BUDGET_MS * SMOOTH_FRAMES;

  /** Metrics from the last completed frame. */
  private lastMetrics: FrameMetrics = {
    frameTimeMs: BUDGET_MS,
    updateTimeMs: 0,
    drawTimeMs: 0,
    fps: 60,
    minFps: 60,
    surfacePoolHitRate: 0,
    surfacePoolAcquires: 0,
    surfacePoolCached: 0,
    memoryUsageMb: 0,
    canvasCount: 0,
  };

  /** Peak frame time in the current 1-second window. */
  private peakFrameTimeMs: number = 0;
  private peakResetTimer: number = 0;

  /** Minimum FPS in the current 1-second window. */
  private windowMinFps: number = 60;
  private sessionMinFps: number = 60;

  // --- Per-function timing (like Python's @frame_time decorator) ---

  /** Active timers for the current frame. */
  private activeFuncTimers: Map<string, number> = new Map();

  /** Accumulated per-function timings across all frames. */
  private funcTimings: Map<string, { totalMs: number; calls: number; maxMs: number }> = new Map();

  // --- Long frame spike log ---

  private longFrames: LongFrameEntry[] = [];

  // --- Sustained budget violation detection ---

  private budgetViolationStart: number = 0;
  private budgetViolationWarned: boolean = false;

  // --- Histogram ---

  private histogramCounts: number[] = new Array(HISTOGRAM_RANGES.length).fill(0);

  // --- Profiling session ---

  private profilingActive: boolean = false;
  private profilingStart: number = 0;
  private profilingFrameCount: number = 0;
  private profilingFrameTimes: number[] = [];
  private peakMemoryMb: number = 0;
  private peakSurfacePoolCached: number = 0;
  private totalFrameCount: number = 0;

  // --- Canvas count tracking ---

  private estimatedCanvasCount: number = 0;

  // =========================================================================
  // Lifecycle methods (called from the game loop)
  // =========================================================================

  /** Call at the very start of each frame. */
  beginFrame(): void {
    this.frameStart = performance.now();
  }

  /** Call before the state machine update. */
  beginUpdate(): void {
    this.updateStart = performance.now();
  }

  /** Call after the state machine update completes. */
  endUpdate(): void {
    this.updateEnd = performance.now();
  }

  /** Call before blitting to the display canvas. */
  beginDraw(): void {
    this.drawStart = performance.now();
  }

  /** Call after blitting completes. */
  endDraw(): void {
    this.drawEnd = performance.now();
  }

  /** Call at the very end of each frame to finalize metrics. */
  endFrame(): void {
    const frameEnd = performance.now();
    const frameTimeMs = frameEnd - this.frameStart;
    this.totalFrameCount++;

    // Smoothed FPS (circular buffer)
    this.totalFrameTime -= this.frameTimes[this.frameIndex];
    this.frameTimes[this.frameIndex] = frameTimeMs;
    this.totalFrameTime += frameTimeMs;
    this.frameIndex = (this.frameIndex + 1) % SMOOTH_FRAMES;

    const currentFps = 1000 / (this.totalFrameTime / SMOOTH_FRAMES);

    // Peak detection (1-second window)
    if (frameTimeMs > this.peakFrameTimeMs) {
      this.peakFrameTimeMs = frameTimeMs;
    }
    if (currentFps < this.windowMinFps) {
      this.windowMinFps = currentFps;
    }
    this.peakResetTimer += frameTimeMs;
    if (this.peakResetTimer > 1000) {
      // Record session-level min FPS
      if (this.windowMinFps < this.sessionMinFps && this.totalFrameCount > 60) {
        this.sessionMinFps = this.windowMinFps;
      }
      this.peakResetTimer = 0;
      this.peakFrameTimeMs = frameTimeMs;
      this.windowMinFps = currentFps;
    }

    // Surface pool stats
    const poolStats = SurfacePool.getStats();
    if (poolStats.pooled > this.peakSurfacePoolCached) {
      this.peakSurfacePoolCached = poolStats.pooled;
    }

    // Memory (Chrome-only Performance.memory)
    let memoryMb = 0;
    const perf = performance as any;
    if (perf.memory) {
      memoryMb = perf.memory.usedJSHeapSize / (1024 * 1024);
      if (memoryMb > this.peakMemoryMb) {
        this.peakMemoryMb = memoryMb;
      }
    }

    const updateMs = this.updateEnd - this.updateStart;
    const drawMs = this.drawEnd - this.drawStart;

    this.lastMetrics = {
      frameTimeMs,
      updateTimeMs: updateMs,
      drawTimeMs: drawMs,
      fps: currentFps,
      minFps: this.windowMinFps,
      surfacePoolHitRate: poolStats.hitRate,
      surfacePoolAcquires: poolStats.acquires,
      surfacePoolCached: poolStats.pooled,
      memoryUsageMb: memoryMb,
      canvasCount: this.estimatedCanvasCount,
    };

    // Histogram
    for (let i = 0; i < HISTOGRAM_RANGES.length; i++) {
      if (frameTimeMs < HISTOGRAM_RANGES[i].max) {
        this.histogramCounts[i]++;
        break;
      }
    }

    // Long frame spike detection
    if (frameTimeMs > LONG_FRAME_THRESHOLD_MS) {
      if (this.longFrames.length < MAX_LONG_FRAMES) {
        this.longFrames.push({
          timestamp: frameEnd,
          frameTimeMs,
          updateTimeMs: updateMs,
          drawTimeMs: drawMs,
        });
      }
      // Console warning for very long frames (>50ms = <20fps)
      if (frameTimeMs > 50) {
        console.warn(
          `[Perf] Long frame: ${frameTimeMs.toFixed(1)}ms ` +
          `(update=${updateMs.toFixed(1)}ms, draw=${drawMs.toFixed(1)}ms)`
        );
      }
    }

    // Sustained budget violation detection
    if (frameTimeMs > BUDGET_MS) {
      if (this.budgetViolationStart === 0) {
        this.budgetViolationStart = frameEnd;
      } else if (
        !this.budgetViolationWarned &&
        frameEnd - this.budgetViolationStart > SUSTAINED_VIOLATION_SEC * 1000
      ) {
        this.budgetViolationWarned = true;
        console.warn(
          `[Perf] Sustained frame budget violation for ${SUSTAINED_VIOLATION_SEC}s. ` +
          `Current FPS: ${currentFps.toFixed(0)}. Consider reducing viewport size or ` +
          `disabling weather/fog effects on this device.`
        );
      }
    } else {
      this.budgetViolationStart = 0;
      this.budgetViolationWarned = false;
    }

    // Profiling session recording
    if (this.profilingActive) {
      this.profilingFrameCount++;
      this.profilingFrameTimes.push(frameTimeMs);
    }

    // Reset per-frame counters
    SurfacePool.resetFrameStats();
    this.activeFuncTimers.clear();
  }

  // =========================================================================
  // Per-function timing (inspired by Python's @frame_time decorator)
  // =========================================================================

  /**
   * Start timing a named function/section. Call `endTimeFunction()` when done.
   * Multiple calls with the same name in one frame accumulate.
   *
   * Usage:
   *   PerfMonitor.timeFunction('pathfinding');
   *   // ... do work ...
   *   PerfMonitor.endTimeFunction('pathfinding');
   */
  timeFunction(name: string): void {
    this.activeFuncTimers.set(name, performance.now());
  }

  /** End timing a named function/section started with `timeFunction()`. */
  endTimeFunction(name: string): void {
    const start = this.activeFuncTimers.get(name);
    if (start === undefined) return;

    const elapsed = performance.now() - start;
    this.activeFuncTimers.delete(name);

    let timing = this.funcTimings.get(name);
    if (!timing) {
      timing = { totalMs: 0, calls: 0, maxMs: 0 };
      this.funcTimings.set(name, timing);
    }
    timing.totalMs += elapsed;
    timing.calls++;
    if (elapsed > timing.maxMs) {
      timing.maxMs = elapsed;
    }
  }

  // =========================================================================
  // Canvas count tracking
  // =========================================================================

  /** Update the estimated canvas count (call from Surface constructor). */
  setCanvasCount(count: number): void {
    this.estimatedCanvasCount = count;
  }

  // =========================================================================
  // Profiling session (record a window of frames for export)
  // =========================================================================

  /** Start recording a profiling session. */
  startProfiling(): void {
    this.profilingActive = true;
    this.profilingStart = performance.now();
    this.profilingFrameCount = 0;
    this.profilingFrameTimes = [];
    this.funcTimings.clear();
    this.longFrames = [];
    this.histogramCounts.fill(0);
    this.peakMemoryMb = 0;
    this.peakSurfacePoolCached = 0;
    console.info('[Perf] Profiling started');
  }

  /** Stop recording and return the profiling report. */
  stopProfiling(): ProfilingReport {
    this.profilingActive = false;
    const durationMs = performance.now() - this.profilingStart;
    console.info(`[Perf] Profiling stopped after ${(durationMs / 1000).toFixed(1)}s, ${this.profilingFrameCount} frames`);
    return this.buildReport(durationMs);
  }

  /**
   * Export the current profiling report as a JSON string.
   * Can be called at any time; uses accumulated data since last `startProfiling()`.
   */
  exportReport(): string {
    const durationMs = this.profilingActive
      ? performance.now() - this.profilingStart
      : this.profilingFrameTimes.length * BUDGET_MS;
    return JSON.stringify(this.buildReport(durationMs), null, 2);
  }

  private buildReport(durationMs: number): ProfilingReport {
    const ft = this.profilingFrameTimes.length > 0
      ? [...this.profilingFrameTimes].sort((a, b) => a - b)
      : [...this.frameTimes].sort((a, b) => a - b);

    const totalFrames = ft.length;
    const sumMs = ft.reduce((a, b) => a + b, 0);

    // Percentiles
    const p = (pct: number) => ft[Math.min(Math.floor(totalFrames * pct / 100), totalFrames - 1)] ?? 0;

    // Histogram
    const totalHist = this.histogramCounts.reduce((a, b) => a + b, 0) || 1;
    const histogram: HistogramBucket[] = HISTOGRAM_RANGES.map((range, i) => ({
      label: range.label,
      count: this.histogramCounts[i],
      percentage: (this.histogramCounts[i] / totalHist) * 100,
    }));

    // Function timings (sorted by total time descending)
    const functionTimings: FunctionTiming[] = Array.from(this.funcTimings.entries())
      .map(([name, t]) => ({ name, totalMs: t.totalMs, calls: t.calls, maxMs: t.maxMs }))
      .sort((a, b) => b.totalMs - a.totalMs);

    // Device info
    const nav = navigator as any;
    const device = {
      userAgent: navigator.userAgent,
      hardwareConcurrency: navigator.hardwareConcurrency ?? 0,
      deviceMemoryGb: nav.deviceMemory ?? null,
      screenWidth: screen.width,
      screenHeight: screen.height,
      devicePixelRatio: window.devicePixelRatio,
    };

    return {
      durationSec: durationMs / 1000,
      totalFrames,
      avgFps: totalFrames / (durationMs / 1000),
      minFps: this.sessionMinFps,
      p99FrameTimeMs: p(99),
      p95FrameTimeMs: p(95),
      medianFrameTimeMs: p(50),
      avgFrameTimeMs: totalFrames > 0 ? sumMs / totalFrames : 0,
      peakFrameTimeMs: ft[totalFrames - 1] ?? 0,
      droppedFrames: ft.filter((t) => t > BUDGET_MS).length,
      histogram,
      functionTimings,
      longFrames: this.longFrames.slice(),
      surfacePool: {
        hitRate: this.lastMetrics.surfacePoolHitRate,
        peakCached: this.peakSurfacePoolCached,
      },
      memory: {
        peakMb: this.peakMemoryMb,
        currentMb: this.lastMetrics.memoryUsageMb,
      },
      device,
    };
  }

  // =========================================================================
  // Rendering — overlay HUD
  // =========================================================================

  /**
   * Draw the performance overlay onto the display canvas (screen-space).
   * Called after the game has been rendered, in display coordinates.
   * Matches the Python engine's `draw_fps()` style but with more detail.
   */
  draw(ctx: CanvasRenderingContext2D, screenW: number, _screenH: number): void {
    if (!this.enabled) return;

    const m = this.lastMetrics;
    const lines: { text: string; color: string }[] = [];

    // FPS (color-coded like Python: green >= 55, yellow >= 30, red < 30)
    const fpsColor = m.fps >= 55 ? '#88ff88' : m.fps >= 30 ? '#ffff88' : '#ff8888';
    lines.push({ text: `FPS: ${m.fps.toFixed(0)} (min: ${m.minFps.toFixed(0)})`, color: fpsColor });

    // Frame breakdown
    lines.push({ text: `Frame: ${m.frameTimeMs.toFixed(1)}ms`, color: '#cccccc' });
    lines.push({ text: `  Update: ${m.updateTimeMs.toFixed(1)}ms`, color: '#cccccc' });
    lines.push({ text: `  Draw: ${m.drawTimeMs.toFixed(1)}ms`, color: '#cccccc' });

    // Peak (red if over budget)
    const peakColor = this.peakFrameTimeMs > 20 ? '#ff8888' : '#cccccc';
    lines.push({ text: `Peak: ${this.peakFrameTimeMs.toFixed(1)}ms`, color: peakColor });

    // Surface pool
    const poolStats = SurfacePool.getStats();
    lines.push({ text: `Pool: ${poolStats.pooled} cached`, color: '#aaaacc' });

    // Memory (Chrome only)
    if (m.memoryUsageMb > 0) {
      const memColor = m.memoryUsageMb > 200 ? '#ff8888' : '#cccccc';
      lines.push({ text: `Mem: ${m.memoryUsageMb.toFixed(0)}MB`, color: memColor });
    }

    // Top function timings (if any)
    const topFuncs = Array.from(this.funcTimings.entries())
      .sort((a, b) => b[1].totalMs - a[1].totalMs)
      .slice(0, 3);
    if (topFuncs.length > 0) {
      lines.push({ text: '--- Hotspots ---', color: '#888888' });
      for (const [name, t] of topFuncs) {
        const avgMs = t.calls > 0 ? t.totalMs / t.calls : 0;
        lines.push({
          text: `${name}: ${avgMs.toFixed(1)}ms avg`,
          color: avgMs > 5 ? '#ffaa88' : '#cccccc',
        });
      }
    }

    // Draw background box
    const lineHeight = 13;
    const padding = 4;
    const boxW = 170;
    const boxH = lines.length * lineHeight + padding * 2;
    const boxX = screenW - boxW - 4;
    const boxY = 4;

    ctx.fillStyle = 'rgba(0, 0, 0, 0.75)';
    ctx.fillRect(boxX, boxY, boxW, boxH);

    // Draw text
    ctx.font = '10px monospace';
    ctx.textBaseline = 'top';

    for (let i = 0; i < lines.length; i++) {
      ctx.fillStyle = lines[i].color;
      ctx.fillText(lines[i].text, boxX + padding, boxY + padding + i * lineHeight);
    }
  }

  // =========================================================================
  // Control
  // =========================================================================

  /** Toggle the overlay on/off. */
  toggle(): void {
    this.enabled = !this.enabled;
  }

  /** Set enabled state. */
  setEnabled(value: boolean): void {
    this.enabled = value;
  }

  /** Check if overlay is enabled. */
  isEnabled(): boolean {
    return this.enabled;
  }

  // =========================================================================
  // Data access
  // =========================================================================

  /** Get the latest frame metrics. */
  getReport(): FrameMetrics {
    return { ...this.lastMetrics };
  }

  /** Get smoothed FPS. */
  getFps(): number {
    return this.lastMetrics.fps;
  }

  /** Get peak frame time in the current 1-second window. */
  getPeakFrameTimeMs(): number {
    return this.peakFrameTimeMs;
  }

  /** Get per-function timing data. */
  getFunctionTimings(): FunctionTiming[] {
    return Array.from(this.funcTimings.entries())
      .map(([name, t]) => ({ name, totalMs: t.totalMs, calls: t.calls, maxMs: t.maxMs }))
      .sort((a, b) => b.totalMs - a.totalMs);
  }

  /** Reset all accumulated data. */
  reset(): void {
    this.frameTimes.fill(BUDGET_MS);
    this.frameIndex = 0;
    this.totalFrameTime = BUDGET_MS * SMOOTH_FRAMES;
    this.peakFrameTimeMs = 0;
    this.peakResetTimer = 0;
    this.windowMinFps = 60;
    this.sessionMinFps = 60;
    this.funcTimings.clear();
    this.longFrames = [];
    this.histogramCounts.fill(0);
    this.peakMemoryMb = 0;
    this.peakSurfacePoolCached = 0;
    this.totalFrameCount = 0;
    this.budgetViolationStart = 0;
    this.budgetViolationWarned = false;
  }
}

/** Global performance monitor singleton. */
export const PerfMonitor = new PerfMonitorImpl();

// Expose on globalThis for console access during development
(globalThis as any).__PerfMonitor = PerfMonitor;
