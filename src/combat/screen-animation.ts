/**
 * screen-animation.ts - Python animations.Animation drawn at a fixed screen
 * position: the battle scene's HitSpark, CritSpark, Miss*, NoDamage* and
 * GlancingHit* effects (mock_combat.py hit_spark / crit_spark / no_damage /
 * miss_anim / glancing_hit).
 */

import type { Surface } from '../engine/surface';
import type { MapAnimPrefab } from '../rendering/map-animation';
import { fxNow } from './map-unit-fx';
import { drawCanvas } from './battle-animation';

export class ScreenAnimation {
  readonly nid: string;
  private sheet: OffscreenCanvas | null = null;
  private width = 0;
  private height = 0;
  private counter = 0;
  private framesHeld = 0;
  private firstUpdate = 0;
  done = false;
  /** engine.BlendMode.BLEND_RGB_ADD tint. */
  additive = false;

  private readonly prefab: MapAnimPrefab;
  private readonly position: [number, number];
  private readonly flipSheet: boolean;

  constructor(prefab: MapAnimPrefab, position: [number, number], flipSheet: boolean = false) {
    this.prefab = prefab;
    this.position = position;
    this.flipSheet = flipSheet;
    this.nid = prefab.nid;
  }

  setImage(image: HTMLImageElement | ImageBitmap): void {
    const canvas = new OffscreenCanvas(image.width, image.height);
    const ctx = canvas.getContext('2d')!;
    if (this.flipSheet) {
      // `anim.sprite = engine.flip_horiz(anim.sprite)`: the whole sheet.
      ctx.translate(image.width, 0);
      ctx.scale(-1, 1);
    }
    ctx.drawImage(image, 0, 0);
    this.sheet = canvas;
    this.width = Math.floor(image.width / this.prefab.frame_x);
    this.height = Math.floor(image.height / this.prefab.frame_y);
    this.firstUpdate = fxNow();
  }

  /** Animation.update; returns true once the last frame has played. */
  update(): boolean {
    if (!this.sheet || this.done) return this.done;
    const frameTimes = (this.prefab.frame_times ?? '')
      .split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => Number.isFinite(n));
    if (this.prefab.use_frame_time) {
      this.framesHeld++;
      if (this.framesHeld >= (frameTimes[this.counter] ?? 1)) {
        this.framesHeld = 0;
        this.counter++;
      }
      if (this.counter >= Math.min(frameTimes.length, this.prefab.num_frames)) {
        this.counter = this.prefab.num_frames - 1;
        this.done = true;
      }
    } else {
      const speed = Math.max(1, Math.trunc(Number(this.prefab.speed)));
      this.counter = Math.floor((fxNow() - this.firstUpdate) / speed);
      if (this.counter >= this.prefab.num_frames) {
        this.counter = this.prefab.num_frames - 1;
        this.done = true;
      }
    }
    return this.done;
  }

  draw(surf: Surface): void {
    if (!this.sheet || this.done) return;
    const col = this.counter % this.prefab.frame_x;
    const row = Math.floor(this.counter / this.prefab.frame_x);
    const frame = new OffscreenCanvas(this.width, this.height);
    frame.getContext('2d')!.drawImage(
      this.sheet, col * this.width, row * this.height, this.width, this.height,
      0, 0, this.width, this.height,
    );
    drawCanvas(surf, frame, this.position[0], this.position[1], this.width, this.height,
      this.additive ? 'add' : 'normal', 1);
  }
}
