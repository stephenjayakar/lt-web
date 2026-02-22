/**
 * event-portrait.ts — Runtime portrait displayed during event scenes.
 * Ported from: app/events/event_portrait.py
 *
 * An EventPortrait composites a character's face from a sprite sheet
 * (main face + mouth frames + eye blink frames) and handles transitions,
 * talking animation, blinking, expressions, and movement.
 *
 * Sprite sheet layout (128x112 px):
 *   Main face:     (0, 0, 96, 80)
 *   Chibi:         (96, 16, 32, 32)
 *   Half blink:    (96, 48, 32, 16)
 *   Full blink:    (96, 64, 32, 16)
 *   Open smile:    (0, 80, 32, 16)
 *   Half smile:    (32, 80, 32, 16)
 *   Close smile:   (64, 80, 32, 16)
 *   Open mouth:    (0, 96, 32, 16)
 *   Half mouth:    (32, 96, 32, 16)
 *   Close mouth:   (64, 96, 32, 16)
 */

import { Surface } from '../engine/surface';
import { FRAMETIME, COLORKEY } from '../engine/constants';

// Helper: convert frame count to milliseconds
function frames2ms(frames: number): number {
  return frames * FRAMETIME;
}

// Sprite sheet region coordinates
const MAIN_FACE = { x: 0, y: 0, w: 96, h: 80 };
const HALF_BLINK = { x: 96, y: 48, w: 32, h: 16 };
const FULL_BLINK = { x: 96, y: 64, w: 32, h: 16 };
// Winks are sub-regions of full blink
const LEFT_WINK = { x: 96, y: 64, w: 16, h: 16 };
const RIGHT_WINK = { x: 112, y: 64, w: 16, h: 16 };

// Mouth regions (row at y=96)
const OPEN_MOUTH = { x: 0, y: 96, w: 32, h: 16 };
const HALF_MOUTH = { x: 32, y: 96, w: 32, h: 16 };
const CLOSE_MOUTH = { x: 64, y: 96, w: 32, h: 16 };

// Smile regions (row at y=80)
const OPEN_SMILE = { x: 0, y: 80, w: 32, h: 16 };
const HALF_SMILE = { x: 32, y: 80, w: 32, h: 16 };
const CLOSE_SMILE = { x: 64, y: 80, w: 32, h: 16 };

// Transition timing
const TRANSITION_SPEED = frames2ms(14); // ~233ms
const SLIDE_LENGTH = 24;

// Blink timing
const BLINK_PERIOD_BASE = 7000; // ms
const BLINK_PERIOD_VARIANCE = 2000;
const BLINK_FRAME_DURATION = frames2ms(3); // 50ms per blink frame

/** Valid expression strings. */
export type Expression =
  | 'Smile'
  | 'OpenMouth'
  | 'CloseEyes'
  | 'HalfCloseEyes'
  | 'OpenEyes'
  | 'LeftWink'
  | 'RightWink'
  | 'FarWink'
  | 'NearWink';

export class EventPortrait {
  /** Name used to reference this portrait (usually character NID). */
  readonly name: string;

  /** The sprite sheet as a Surface with colorkey applied. */
  private image: Surface;

  /** Offsets for compositing overlays. */
  private blinkingOffset: [number, number];
  private smilingOffset: [number, number];

  /** Current screen position (pixels). */
  position: [number, number];

  /** Drawing priority (higher = drawn on top). */
  priority: number;

  /** Whether the portrait is horizontally mirrored. */
  mirror: boolean;

  /** Active expressions. */
  private expressions: Set<string> = new Set();

  // --- Transition state ---
  private transitioning: boolean = false;
  private transitionStart: number = 0;
  private transitionSpeed: number = TRANSITION_SPEED;
  private removing: boolean = false;
  private slide: 'left' | 'right' | null = null;

  // --- Blink state ---
  private blinkState: number = 0; // 0=open, 1=half, 2=full
  private blinkTimer: number = 0;
  private blinkPeriod: number;
  private blinkFrameTimer: number = 0;
  private blinkDirection: number = 1; // 1=closing, -1=opening

  // --- Talk state ---
  private talkOn: boolean = false;
  private talkState: number = 0; // 0=closed, 1=half, 2=open, 3=half
  private talkTimer: number = 0;
  private talkDuration: number = 0;

  // --- Movement ---
  private moveTarget: [number, number] | null = null;
  private moving: boolean = false;

  // --- Bop ---
  private bopActive: boolean = false;
  private bopCount: number = 0;
  private bopMaxCount: number = 0;
  private bopHeight: number = 2;
  private bopSpeed: number = frames2ms(8);
  private bopTimer: number = 0;
  private bopUp: boolean = true;

  // --- Saturation ---
  private saturation: number = 1.0;
  private saturationTarget: number = 1.0;
  private saturationSpeed: number = frames2ms(10); // ~167ms

  // --- Pre-composited face surface ---
  private faceSurface: Surface | null = null;
  private lastCompositeKey: string = '';

  constructor(
    image: HTMLImageElement,
    blinkingOffset: [number, number],
    smilingOffset: [number, number],
    position: [number, number],
    priority: number,
    name: string,
    options: {
      transition?: boolean;
      slide?: 'left' | 'right' | null;
      mirror?: boolean;
      expressions?: string[];
      speedMult?: number;
    } = {},
  ) {
    // Convert HTMLImageElement to Surface and apply colorkey transparency
    const imgSurf = new Surface(image.naturalWidth, image.naturalHeight);
    imgSurf.blitImage(image, 0, 0, image.naturalWidth, image.naturalHeight, 0, 0);
    applyColorkey(imgSurf);
    this.image = imgSurf;
    this.blinkingOffset = blinkingOffset;
    this.smilingOffset = smilingOffset;
    this.position = [position[0], position[1]];
    this.priority = priority;
    this.name = name;
    this.mirror = options.mirror ?? false;

    if (options.expressions) {
      for (const e of options.expressions) {
        this.expressions.add(e);
      }
    }

    // Transition in
    if (options.transition) {
      this.transitioning = true;
      this.transitionStart = performance.now();
      this.transitionSpeed = TRANSITION_SPEED / (options.speedMult ?? 1);
    }

    this.slide = options.slide ?? null;

    // Initialize blink timer with random period
    this.blinkPeriod =
      BLINK_PERIOD_BASE + (Math.random() * 2 - 1) * BLINK_PERIOD_VARIANCE;
    this.blinkTimer = 0;
  }

  // ------------------------------------------------------------------
  // Public API
  // ------------------------------------------------------------------

  /** Start removal transition. Returns immediately; call update() each frame. */
  end(speedMult: number = 1, slide?: 'left' | 'right'): void {
    this.removing = true;
    this.transitioning = true;
    this.transitionStart = performance.now();
    this.transitionSpeed = TRANSITION_SPEED / speedMult;
    if (slide) this.slide = slide;
  }

  /** Start the talking animation. */
  startTalking(): void {
    this.talkOn = true;
    this.talkState = 0;
    this.talkTimer = 0;
    this.talkDuration = this.randomTalkDuration(0);
  }

  /** Stop the talking animation. Mouth returns to closed. */
  stopTalking(): void {
    this.talkOn = false;
    this.talkState = 0;
  }

  /** Set expressions (replaces current set). */
  setExpressions(exprs: string[]): void {
    this.expressions.clear();
    for (const e of exprs) {
      this.expressions.add(e);
    }
  }

  /** Add a single expression. */
  addExpression(expr: string): void {
    this.expressions.add(expr);
  }

  /** Move portrait to a new position with animation. */
  move(target: [number, number], _speedMult: number = 1): void {
    this.moveTarget = [target[0], target[1]];
    this.moving = true;
  }

  /** Instant teleport to new position. */
  quickMove(target: [number, number]): void {
    this.position = [target[0], target[1]];
    this.moveTarget = null;
    this.moving = false;
  }

  /** Start a bobbing animation. */
  bop(numBops: number = 2, height: number = 2, speed?: number): void {
    this.bopActive = true;
    this.bopCount = 0;
    this.bopMaxCount = numBops * 2; // Each bop = up + down
    this.bopHeight = height;
    this.bopSpeed = speed ?? frames2ms(8);
    this.bopTimer = 0;
    this.bopUp = true;
  }

  /** Saturate (brighten) the portrait. */
  saturate(): void {
    this.saturationTarget = 1.0;
  }

  /** Desaturate (darken) the portrait. */
  desaturate(): void {
    this.saturationTarget = 0.0;
  }

  /** Whether the portrait has finished its removal transition. */
  get isFinished(): boolean {
    return this.removing && !this.transitioning;
  }

  /** Whether the portrait is currently transitioning (in or out). */
  get isTransitioning(): boolean {
    return this.transitioning;
  }

  /** Get the center X of the portrait face (for dialog positioning). */
  getDesiredCenter(): number {
    const faceWidth = MAIN_FACE.w;
    return this.position[0] + faceWidth / 2;
  }

  // ------------------------------------------------------------------
  // Update (called each frame)
  // ------------------------------------------------------------------

  /**
   * Update all animations. Returns true if the portrait should be removed
   * (removal transition complete).
   */
  update(dt: number): boolean {
    // Transition progress
    if (this.transitioning) {
      const elapsed = performance.now() - this.transitionStart;
      if (elapsed >= this.transitionSpeed) {
        this.transitioning = false;
        if (this.removing) {
          return true; // Signal removal
        }
      }
    }

    // Blink animation
    this.updateBlink(dt);

    // Talk animation
    this.updateTalk(dt);

    // Movement
    this.updateMovement(dt);

    // Bop
    this.updateBop(dt);

    // Saturation
    this.updateSaturation(dt);

    return false;
  }

  // ------------------------------------------------------------------
  // Draw
  // ------------------------------------------------------------------

  draw(surf: Surface): void {
    // Compute transition progress (0 = invisible, 1 = fully visible)
    let alpha = 1.0;
    let slideOffset = 0;

    if (this.transitioning) {
      const elapsed = performance.now() - this.transitionStart;
      let progress = Math.min(1, elapsed / this.transitionSpeed);
      if (this.removing) progress = 1 - progress;

      if (this.slide) {
        alpha = progress;
        const remaining = (1 - progress) * SLIDE_LENGTH;
        slideOffset = this.slide === 'right' ? remaining : -remaining;
      } else {
        alpha = progress;
      }
    }

    if (alpha <= 0) return;

    // Build composite face
    const face = this.createComposite();
    if (!face) return;

    // Apply mirroring
    const finalFace = this.mirror ? face.flipH() : face;

    // Compute draw position
    let drawX = this.position[0] + slideOffset;
    let drawY = this.position[1];

    // Bop offset
    if (this.bopActive && this.bopUp) {
      drawY -= this.bopHeight;
    }

    // Apply saturation (darken when desaturated)
    if (this.saturation < 1) {
      const darkness = 0.5 * (1 - this.saturation);
      finalFace.setAlpha(alpha);
      surf.blit(finalFace, drawX, drawY);
      // Draw a dark overlay for desaturation effect
      surf.fillRect(
        drawX, drawY,
        MAIN_FACE.w, MAIN_FACE.h,
        `rgba(0,0,0,${darkness * alpha})`,
      );
      return;
    }

    finalFace.setAlpha(alpha);
    surf.blit(finalFace, drawX, drawY);
  }

  // ------------------------------------------------------------------
  // Composite face from sprite sheet regions
  // ------------------------------------------------------------------

  /**
   * Build the composite face surface by layering:
   * 1. Main face (96x80)
   * 2. Mouth overlay at smiling_offset
   * 3. Eye overlay at blinking_offset
   */
  private createComposite(): Surface | null {
    // Build a cache key from current state
    const mouthIdx = this.getMouthFrameIndex();
    const eyeIdx = this.getEyeFrameIndex();
    const key = `${mouthIdx}_${eyeIdx}_${[...this.expressions].join(',')}`;

    if (key === this.lastCompositeKey && this.faceSurface) {
      return this.faceSurface;
    }

    const face = new Surface(MAIN_FACE.w, MAIN_FACE.h);

    // 1. Main face (blit from the colorkey-stripped Surface)
    face.blitFrom(
      this.image,
      MAIN_FACE.x, MAIN_FACE.y, MAIN_FACE.w, MAIN_FACE.h,
      0, 0,
    );

    // 2. Mouth overlay
    const mouthRegion = this.getMouthRegion(mouthIdx);
    if (mouthRegion) {
      face.blitFrom(
        this.image,
        mouthRegion.x, mouthRegion.y, mouthRegion.w, mouthRegion.h,
        this.smilingOffset[0], this.smilingOffset[1],
      );
    }

    // 3. Eye overlay
    const eyeRegion = this.getEyeRegion(eyeIdx);
    if (eyeRegion) {
      face.blitFrom(
        this.image,
        eyeRegion.x, eyeRegion.y, eyeRegion.w, eyeRegion.h,
        this.blinkingOffset[0], this.blinkingOffset[1],
      );
    }

    this.faceSurface = face;
    this.lastCompositeKey = key;
    return face;
  }

  // ------------------------------------------------------------------
  // Mouth frame selection
  // ------------------------------------------------------------------

  /**
   * Get the current mouth frame index:
   * 0 = closed, 1 = half, 2 = open
   */
  private getMouthFrameIndex(): number {
    if (this.expressions.has('OpenMouth')) return 2;

    if (!this.talkOn) return 0;

    // Map talk_state to mouth frame
    switch (this.talkState) {
      case 0: return 0; // closed
      case 1: return 1; // half
      case 2: return 2; // open
      case 3: return 1; // half (closing)
      default: return 0;
    }
  }

  /**
   * Get the sprite sheet region for a mouth frame.
   * Uses smile variants if Smile expression is active.
   */
  private getMouthRegion(idx: number): { x: number; y: number; w: number; h: number } | null {
    const useSmile = this.expressions.has('Smile');

    switch (idx) {
      case 0: return useSmile ? CLOSE_SMILE : CLOSE_MOUTH;
      case 1: return useSmile ? HALF_SMILE : HALF_MOUTH;
      case 2: return useSmile ? OPEN_SMILE : OPEN_MOUTH;
      default: return null;
    }
  }

  // ------------------------------------------------------------------
  // Eye frame selection
  // ------------------------------------------------------------------

  /**
   * Get the current eye frame index:
   * 0 = open (no overlay), 1 = half blink, 2 = full blink,
   * 3 = left wink, 4 = right wink
   */
  private getEyeFrameIndex(): number {
    if (this.expressions.has('CloseEyes')) return 2;
    if (this.expressions.has('HalfCloseEyes')) return 1;
    if (this.expressions.has('OpenEyes')) return 0;
    if (this.expressions.has('LeftWink') || this.expressions.has('FarWink')) return 3;
    if (this.expressions.has('RightWink') || this.expressions.has('NearWink')) return 4;

    // Auto-blink
    return this.blinkState;
  }

  /**
   * Get the sprite sheet region for an eye frame.
   * Returns null for "open" (no overlay needed).
   */
  private getEyeRegion(idx: number): { x: number; y: number; w: number; h: number } | null {
    switch (idx) {
      case 0: return null; // Open — no overlay
      case 1: return HALF_BLINK;
      case 2: return FULL_BLINK;
      case 3: return LEFT_WINK;
      case 4: return RIGHT_WINK;
      default: return null;
    }
  }

  // ------------------------------------------------------------------
  // Blink animation
  // ------------------------------------------------------------------

  private updateBlink(dt: number): void {
    // Don't auto-blink if expression overrides
    if (
      this.expressions.has('CloseEyes') ||
      this.expressions.has('HalfCloseEyes') ||
      this.expressions.has('OpenEyes') ||
      this.expressions.has('LeftWink') ||
      this.expressions.has('RightWink') ||
      this.expressions.has('FarWink') ||
      this.expressions.has('NearWink')
    ) {
      return;
    }

    this.blinkTimer += dt;

    if (this.blinkState === 0) {
      // Eyes open — wait for blink period
      if (this.blinkTimer >= this.blinkPeriod) {
        this.blinkState = 1;
        this.blinkDirection = 1;
        this.blinkFrameTimer = 0;
        this.blinkTimer = 0;
        this.blinkPeriod =
          BLINK_PERIOD_BASE + (Math.random() * 2 - 1) * BLINK_PERIOD_VARIANCE;
      }
    } else {
      // Blinking in progress
      this.blinkFrameTimer += dt;
      if (this.blinkFrameTimer >= BLINK_FRAME_DURATION) {
        this.blinkFrameTimer = 0;
        this.blinkState += this.blinkDirection;

        if (this.blinkState >= 2) {
          this.blinkDirection = -1; // Start opening
          this.blinkState = 2;
        }
        if (this.blinkState <= 0) {
          this.blinkState = 0;
          this.blinkDirection = 1;
        }
      }
    }
  }

  // ------------------------------------------------------------------
  // Talk animation (randomized mouth state machine)
  // ------------------------------------------------------------------

  private updateTalk(dt: number): void {
    if (!this.talkOn) return;

    this.talkTimer += dt;
    if (this.talkTimer < this.talkDuration) return;

    this.talkTimer = 0;

    // State transitions (matching Python's randomized mouth movement)
    const rand = Math.random();
    switch (this.talkState) {
      case 0: // Closed
        if (rand < 0.1) {
          this.talkState = 2; // Skip to open
          this.talkDuration = this.randomTalkDuration(2);
        } else {
          this.talkState = 1; // Half
          this.talkDuration = this.randomTalkDuration(1);
        }
        break;
      case 1: // Half (opening)
        if (rand < 0.1) {
          this.talkState = 0; // Back to closed
          this.talkDuration = this.randomTalkDuration(0);
        } else {
          this.talkState = 2; // Open
          this.talkDuration = this.randomTalkDuration(2);
        }
        break;
      case 2: // Open
        if (rand < 0.1) {
          this.talkState = 0;
          this.talkDuration = this.randomTalkDuration(0);
        } else if (rand < 0.2) {
          this.talkState = 1;
          this.talkDuration = this.randomTalkDuration(1);
        } else {
          this.talkState = 3; // Half (closing)
          this.talkDuration = this.randomTalkDuration(3);
        }
        break;
      case 3: // Half (closing)
        this.talkState = 0;
        this.talkDuration = this.randomTalkDuration(0);
        break;
    }
  }

  /**
   * Generate a random duration for a talk state.
   * Different states have different timing ranges.
   */
  private randomTalkDuration(state: number): number {
    switch (state) {
      case 0: return 30 + Math.random() * 20; // closed: 30-50ms
      case 1: return 70 + Math.random() * 90; // half open: 70-160ms
      case 2: return 30 + Math.random() * 20; // open: 30-50ms
      case 3: return 50 + Math.random() * 50; // half close: 50-100ms
      default: return 50;
    }
  }

  // ------------------------------------------------------------------
  // Movement
  // ------------------------------------------------------------------

  private updateMovement(_dt: number): void {
    if (!this.moving || !this.moveTarget) return;

    const dx = this.moveTarget[0] - this.position[0];
    const dy = this.moveTarget[1] - this.position[1];
    const dist = Math.abs(dx) + Math.abs(dy);

    if (dist < 1) {
      this.position = [this.moveTarget[0], this.moveTarget[1]];
      this.moving = false;
      this.moveTarget = null;
      return;
    }

    // Approach algorithm: move clamp(dist/8, 1, 8) pixels per frame
    const speed = Math.max(1, Math.min(8, dist / 8));
    const angle = Math.atan2(dy, dx);
    this.position[0] += Math.cos(angle) * speed;
    this.position[1] += Math.sin(angle) * speed;
  }

  // ------------------------------------------------------------------
  // Bop
  // ------------------------------------------------------------------

  private updateBop(dt: number): void {
    if (!this.bopActive) return;

    this.bopTimer += dt;
    if (this.bopTimer >= this.bopSpeed) {
      this.bopTimer = 0;
      this.bopUp = !this.bopUp;
      this.bopCount++;

      if (this.bopCount >= this.bopMaxCount) {
        this.bopActive = false;
        this.bopUp = false;
      }
    }
  }

  // ------------------------------------------------------------------
  // Saturation
  // ------------------------------------------------------------------

  private updateSaturation(dt: number): void {
    if (this.saturation === this.saturationTarget) return;

    const step = dt / this.saturationSpeed;
    if (this.saturation < this.saturationTarget) {
      this.saturation = Math.min(this.saturationTarget, this.saturation + step);
    } else {
      this.saturation = Math.max(this.saturationTarget, this.saturation - step);
    }
  }
}

// ---------------------------------------------------------------------------
// Colorkey removal for portrait sprite sheets
// ---------------------------------------------------------------------------

/**
 * Replace the LT colorkey background (128, 160, 128) with full transparency.
 * Portrait PNGs use this green as a chroma-key background instead of alpha.
 */
function applyColorkey(surf: Surface): void {
  const imageData = surf.getImageData();
  const data = imageData.data;
  const [kr, kg, kb] = COLORKEY;
  const tolerance = 2;

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    if (
      Math.abs(r - kr) <= tolerance &&
      Math.abs(g - kg) <= tolerance &&
      Math.abs(b - kb) <= tolerance
    ) {
      data[i + 3] = 0; // Set alpha to 0 (transparent)
    }
  }

  surf.putImageData(imageData);
}
