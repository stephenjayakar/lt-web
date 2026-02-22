/**
 * surface-pool.ts — OffscreenCanvas / Surface pool for reuse.
 *
 * The engine creates many temporary Surface objects per frame (tilemap
 * compositing, minimap, etc.). Each Surface wraps an OffscreenCanvas,
 * which is expensive to allocate and GC. This pool recycles canvases
 * by size bucket to avoid allocation churn.
 *
 * Usage:
 *   const surf = SurfacePool.acquire(w, h);
 *   // ... draw on surf ...
 *   // when done (end of frame or no longer needed):
 *   SurfacePool.release(surf);
 *
 * The pool rounds dimensions up to the nearest multiple of BUCKET_SIZE
 * to increase reuse probability. A canvas larger than the requested
 * size is fine — the Surface's logical dimensions still match.
 */

import { Surface } from './surface';

/** Round up to the nearest multiple of this value. */
const BUCKET_SIZE = 32;

/** Maximum number of canvases to keep per size bucket. */
const MAX_PER_BUCKET = 4;

/** Total maximum canvases across all buckets. */
const MAX_TOTAL = 64;

interface PoolEntry {
  canvas: OffscreenCanvas;
  ctx: OffscreenCanvasRenderingContext2D;
  physicalW: number;
  physicalH: number;
}

function bucketKey(w: number, h: number): string {
  const bw = Math.ceil(w / BUCKET_SIZE) * BUCKET_SIZE;
  const bh = Math.ceil(h / BUCKET_SIZE) * BUCKET_SIZE;
  return `${bw}x${bh}`;
}

class SurfacePoolImpl {
  private buckets: Map<string, PoolEntry[]> = new Map();
  private totalCount: number = 0;

  // Stats for the performance monitor
  private _acquires: number = 0;
  private _hits: number = 0;
  private _releases: number = 0;

  /**
   * Acquire a Surface of at least the given logical dimensions.
   * The Surface is cleared before being returned.
   */
  acquire(width: number, height: number, scale: number = 1): Surface {
    this._acquires++;
    const physW = Math.round(width * scale);
    const physH = Math.round(height * scale);
    const key = bucketKey(physW, physH);

    const bucket = this.buckets.get(key);
    if (bucket && bucket.length > 0) {
      this._hits++;
      const entry = bucket.pop()!;
      this.totalCount--;

      // Resize the canvas if needed (should match due to bucketing)
      if (entry.canvas.width !== physW || entry.canvas.height !== physH) {
        entry.canvas.width = physW;
        entry.canvas.height = physH;
      }

      // Clear
      entry.ctx.clearRect(0, 0, physW, physH);
      entry.ctx.imageSmoothingEnabled = false;

      // Create a Surface wrapping the pooled canvas
      return Surface.fromPooled(width, height, scale, entry.canvas, entry.ctx);
    }

    // Cache miss — create new
    return new Surface(width, height, scale);
  }

  /**
   * Return a Surface to the pool for reuse.
   * The Surface should not be used after this call.
   */
  release(surface: Surface): void {
    this._releases++;

    const canvas = surface.canvas;
    const ctx = surface.ctx;
    const physW = canvas.width;
    const physH = canvas.height;

    // Don't pool very large surfaces (they waste memory)
    if (physW > 2048 || physH > 2048) return;

    // Don't exceed total limit
    if (this.totalCount >= MAX_TOTAL) return;

    const key = bucketKey(physW, physH);
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = [];
      this.buckets.set(key, bucket);
    }

    // Don't exceed per-bucket limit
    if (bucket.length >= MAX_PER_BUCKET) return;

    bucket.push({ canvas, ctx, physicalW: physW, physicalH: physH });
    this.totalCount++;
  }

  /**
   * Get pool statistics for the performance monitor.
   */
  getStats(): { pooled: number; acquires: number; hits: number; hitRate: number } {
    const hitRate = this._acquires > 0 ? this._hits / this._acquires : 0;
    return {
      pooled: this.totalCount,
      acquires: this._acquires,
      hits: this._hits,
      hitRate,
    };
  }

  /**
   * Reset per-frame counters (call at end of each frame).
   */
  resetFrameStats(): void {
    this._acquires = 0;
    this._hits = 0;
    this._releases = 0;
  }

  /**
   * Clear all pooled canvases to free memory.
   */
  clear(): void {
    this.buckets.clear();
    this.totalCount = 0;
  }
}

/** Global surface pool singleton. */
export const SurfacePool = new SurfacePoolImpl();
