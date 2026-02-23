/**
 * battle-animation.ts
 *
 * Frame-by-frame animation playback controller for a single combatant's
 * battle sprite during GBA-style combat scenes. Drives the timeline-based
 * pose system: reads script commands, manages frame display state, handles
 * entrance/exit scaling, death flicker, hit synchronization, tinting,
 * and child effect spawning.
 *
 * One BattleAnimation exists per combatant (attacker + defender), plus
 * additional instances for child effects (spells, sparks, etc.).
 */

import type {
  WeaponAnimData,
  BattleAnimFrame,
  BattleAnimPose,
  BattleAnimCommand,
  CombatEffectData,
} from './battle-anim-types';
import { IDLE_POSES, POSE_FALLBACKS } from './battle-anim-types';
import { WINWIDTH } from '../engine/constants';

// -----------------------------------------------------------------------
// Draw data interface — everything the renderer needs to composite a frame
// -----------------------------------------------------------------------

export interface BattleAnimDrawData {
  state: string;
  right: boolean;
  /** Frame images to draw (null if nothing to display) */
  mainFrame: { image: ImageBitmap | HTMLCanvasElement; offset: [number, number] } | null;
  underFrame: { image: ImageBitmap | HTMLCanvasElement; offset: [number, number] } | null;
  overFrame: { image: ImageBitmap | HTMLCanvasElement; offset: [number, number] } | null;
  /** Entrance scaling progress: 0 = not started, 1 = fully entered */
  entranceProgress: number;
  /** Map pixel coords for entrance interpolation */
  initPosition: [number, number];
  /** Opacity 0-255, factoring in self-opacity and death */
  opacity: number;
  blendMode: 'normal' | 'add' | 'sub';
  /** Recoil offset in pixels */
  recoilX: number;
  /** Active tints with computed alpha */
  tints: { color: [number, number, number]; mode: 'add' | 'sub'; alpha: number }[];
  /** Draw white rect over sprite */
  deathFlash: boolean;
  /** Child effect draw data */
  effects: BattleAnimDrawData[];
  underEffects: BattleAnimDrawData[];
}

// -----------------------------------------------------------------------
// Death opacity sequence (87 entries)
// -----------------------------------------------------------------------

const DEATH_OPACITY_SEQUENCE: readonly number[] = [
  0, 0, 0, 0, 20, 20, 20, 40, 40, 40, 60, 60, 60, 80, 80, 80,
  100, 100, 100, 120, 120, 120, 140, 140, 140, 160, 160, 160,
  180, 180, 180, 200, 200, 200, 220, 220, 220, 240, 240, 240,
  255, 255, 255, 0, 255, 0, 255, 0, 255, 0, 255, 0,
  -1,
  0, 255, 0, 255, 0, 255, 0, 255, 0, 255, 0, 255,
  0, 255, 0, 255, 0, 255, 0, 255, 0, 255, 0, 255,
  0, 255, 0, 255, 0, 255, 0, 255, 0, 255, 255,
];

// -----------------------------------------------------------------------
// BattleAnimation class
// -----------------------------------------------------------------------

export class BattleAnimation {
  // --- State machine ---
  state: 'inert' | 'run' | 'wait' | 'dying' | 'leaving' = 'inert';
  animData: WeaponAnimData | null = null;
  frameImages: Map<string, ImageBitmap | HTMLCanvasElement> = new Map();
  currentPose: BattleAnimPose | null = null;
  scriptIndex: number = 0;
  frameCount: number = 0;
  numFrames: number = 0;
  processing: boolean = false;

  // --- Display state ---
  currentFrameNid: string | null = null;
  underFrameNid: string | null = null;
  overFrameNid: string | null = null;
  /** Extra offset for frame_with_offset command */
  frameOffset: [number, number] = [0, 0];

  // --- Pairing ---
  owner: any = null;
  partner: BattleAnimation | null = null;
  right: boolean = false;
  atRange: number = 0;

  // --- Entrance/exit ---
  entranceFrames: number = 14;
  entranceCounter: number = 14;
  initPosition: [number, number] = [0, 0];

  // --- Lunge/recoil ---
  lrOffset: number[] = [];

  // --- Opacity ---
  opacity: number = 255;
  selfOpacity: number = 255;

  // --- Tints ---
  tints: { startFrame: number; duration: number; color: [number, number, number]; mode: 'add' | 'sub' }[] = [];
  private globalFrameCounter: number = 0;

  // --- Child effects ---
  effects: BattleAnimation[] = [];
  underEffects: BattleAnimation[] = [];

  // --- Pan tracking (Python: self.pan_away) ---
  panAway: boolean = false;

  // --- Death ---
  deathOpacity: number[] = [];
  deathFlash: boolean = false;

  // --- Side assignment ---
  isLeft: boolean = false;

  // --- Pan/static ---
  static: boolean = false;
  ignorePan: boolean = false;

  // --- Blend ---
  blendMode: 'normal' | 'add' | 'sub' = 'normal';

  // --- Loop tracking ---
  private loopStartIndex: number = -1;
  private loopEndIndex: number = -1;
  private skipNextLoop: number = 0;

  // --- Hit synchronization flag ---
  waitForHit: boolean = false;

  // --- Frame lookup cache ---
  private frameDataMap: Map<string, BattleAnimFrame> = new Map();

  constructor(animData: WeaponAnimData, frameImages: Map<string, ImageBitmap | HTMLCanvasElement>) {
    this.animData = animData;
    this.frameImages = frameImages;
    this.rebuildFrameDataMap();
  }

  /** Build a lookup from frame nid to BattleAnimFrame for fast access. */
  private rebuildFrameDataMap(): void {
    this.frameDataMap.clear();
    if (!this.animData) return;
    for (const frame of this.animData.frames) {
      this.frameDataMap.set(frame.nid, frame);
    }
  }

  // -------------------------------------------------------------------
  // Setup
  // -------------------------------------------------------------------

  pair(
    owner: any,
    partner: BattleAnimation | null,
    right: boolean,
    atRange: number,
    entranceFrames: number,
    initPosition: [number, number],
  ): void {
    this.owner = owner;
    this.partner = partner;
    this.right = right;
    this.atRange = atRange;
    this.entranceFrames = entranceFrames;
    this.entranceCounter = entranceFrames;
    this.initPosition = initPosition;
  }

  // -------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------

  start(): void {
    this.state = 'run';
    this.setPose('Stand');
  }

  setPose(poseName: string): void {
    if (!this.animData) return;

    // Find the pose, applying fallback chain if needed
    let pose = this.findPose(poseName);
    if (!pose) {
      console.warn(`BattleAnimation: pose "${poseName}" not found, falling back to Stand`);
      pose = this.findPose('Stand');
    }
    if (!pose) return;

    this.currentPose = pose;
    this.state = 'run';
    this.scriptIndex = 0;
    this.frameCount = 0;
    this.numFrames = 0;
    this.processing = false;
    this.currentFrameNid = null;
    this.underFrameNid = null;
    this.overFrameNid = null;
    this.frameOffset = [0, 0];
    this.loopStartIndex = -1;
    this.loopEndIndex = -1;
    this.waitForHit = true;

    // Immediately start reading script commands
    this.readScript();
  }

  private findPose(poseName: string): BattleAnimPose | null {
    if (!this.animData) return null;

    const found = this.animData.poses.find(p => p.nid === poseName);
    if (found) return found;

    // Try fallback
    const fallback = POSE_FALLBACKS[poseName];
    if (fallback) return this.findPose(fallback);

    return null;
  }

  // -------------------------------------------------------------------
  // Main update
  // -------------------------------------------------------------------

  update(): boolean {
    this.globalFrameCounter++;

    switch (this.state) {
      case 'run':
        this.updateRun();
        break;
      case 'wait':
        // Do nothing — waiting for resume()
        break;
      case 'dying':
        this.updateDying();
        break;
      case 'leaving':
        this.updateLeaving();
        break;
      case 'inert':
        // Nothing to do
        break;
    }

    // Consume one recoil offset entry per frame
    if (this.lrOffset.length > 0) {
      this.lrOffset.shift();
    }

    // Prune expired tints
    this.tints = this.tints.filter(t => {
      return (this.globalFrameCounter - t.startFrame) < t.duration;
    });

    // Update child effects
    this.effects = this.effects.filter(e => {
      e.update();
      return !e.isDone();
    });
    this.underEffects = this.underEffects.filter(e => {
      e.update();
      return !e.isDone();
    });

    return this.isDone();
  }

  private updateRun(): void {
    this.frameCount++;
    if (this.frameCount >= this.numFrames) {
      // Current command duration elapsed — read next command(s)
      if (this.currentPose && this.scriptIndex >= this.currentPose.timeline.length) {
        // Script exhausted
        const poseName = this.currentPose.nid;
        if (IDLE_POSES.has(poseName)) {
          // Loop idle poses
          this.scriptIndex = 0;
          this.frameCount = 0;
          this.numFrames = 0;
          this.readScript();
        } else {
          // Return to Stand (Python: end_current_pose)
          // Safety: if pan_away is still True, auto-call pan_back
          if (this.panAway) {
            this.panAway = false;
            this.owner?.panBack?.();
          }
          this.setPose('Stand');
        }
      } else {
        this.readScript();
      }
    }
  }

  private updateDying(): void {
    if (this.deathOpacity.length === 0) {
      this.state = 'inert';
      return;
    }

    const value = this.deathOpacity.shift()!;
    this.deathFlash = false;

    if (value === -1) {
      this.deathFlash = true;
      this.opacity = 0;
      // Python: battle_animation.py plays 'CombatDeath' SFX on the flash frame
      this.owner?.playSound?.('CombatDeath');
    } else {
      this.opacity = value;
    }
  }

  private updateLeaving(): void {
    this.entranceCounter++;
    if (this.entranceCounter >= this.entranceFrames) {
      this.state = 'inert';
    }
  }

  // -------------------------------------------------------------------
  // Script reader
  // -------------------------------------------------------------------

  readScript(): void {
    if (!this.currentPose) return;
    this.processing = true;
    this.frameCount = 0;

    while (this.processing && this.scriptIndex < this.currentPose.timeline.length) {
      const cmd = this.currentPose.timeline[this.scriptIndex];
      this.scriptIndex++;
      this.handleCommand(cmd);
    }

    // If we ran out of commands without hitting a frame/wait, mark processing done
    this.processing = false;
  }

  private handleCommand(cmd: BattleAnimCommand): void {
    const args = cmd.args ?? [];

    switch (cmd.nid) {
      // --- Frame display commands (stop processing) ---

      case 'frame': {
        this.numFrames = args[0] as number;
        this.currentFrameNid = args[1] as string;
        this.underFrameNid = null;
        this.overFrameNid = null;
        this.frameOffset = [0, 0];
        this.processing = false;
        break;
      }

      case 'dual_frame': {
        this.numFrames = args[0] as number;
        this.currentFrameNid = args[1] as string;
        this.underFrameNid = args[2] as string;
        this.overFrameNid = null;
        this.frameOffset = [0, 0];
        this.processing = false;
        break;
      }

      case 'over_frame': {
        this.numFrames = args[0] as number;
        this.overFrameNid = args[1] as string;
        this.processing = false;
        break;
      }

      case 'under_frame': {
        this.numFrames = args[0] as number;
        this.underFrameNid = args[1] as string;
        this.processing = false;
        break;
      }

      case 'wait': {
        this.numFrames = args[0] as number;
        this.currentFrameNid = null;
        this.underFrameNid = null;
        this.overFrameNid = null;
        this.frameOffset = [0, 0];
        this.processing = false;
        break;
      }

      case 'frame_with_offset': {
        this.numFrames = args[0] as number;
        this.currentFrameNid = args[1] as string;
        this.frameOffset = [args[2] as number, args[3] as number];
        this.underFrameNid = null;
        this.overFrameNid = null;
        this.processing = false;
        break;
      }

      case 'wait_for_hit': {
        if (this.waitForHit) {
          this.currentFrameNid = args[0] as string ?? null;
          this.underFrameNid = args[1] as string ?? null;
          this.overFrameNid = null;
          this.frameOffset = [0, 0];
          this.numFrames = 0;
          this.state = 'wait';
          this.processing = false;
        }
        // If waitForHit is false, skip this command (already been hit/resumed)
        break;
      }

      // --- Sound ---

      case 'sound': {
        this.owner?.playSound?.(args[0] as string);
        break;
      }

      // --- Hit synchronization ---

      case 'start_hit': {
        this.owner?.startHit?.(this);
        this.partner?.damaged();
        break;
      }

      case 'miss': {
        this.owner?.handleMiss?.(this);
        break;
      }

      // --- Spell ---

      case 'spell': {
        this.owner?.castSpell?.(this, args[0] as string);
        break;
      }

      case 'spell_hit': {
        this.state = 'wait';
        this.processing = false;
        // spellHit -> startHit handles shake, damage, defender pose, and
        // transitions AnimationCombat to combat_hit -> hp_change -> resume()
        this.owner?.spellHit?.(this);
        break;
      }

      case 'spell_hit_2': {
        this.state = 'wait';
        this.processing = false;
        // Same as spell_hit but for crits (stronger shake is handled by spellHit)
        this.owner?.spellHit?.(this);
        break;
      }

      // --- Tints ---

      case 'enemy_tint': {
        if (this.partner) {
          this.partner.tints.push({
            startFrame: this.partner.globalFrameCounter,
            duration: args[0] as number,
            color: args[1] as [number, number, number],
            mode: 'add',
          });
        }
        break;
      }

      case 'self_tint': {
        this.tints.push({
          startFrame: this.globalFrameCounter,
          duration: args[0] as number,
          color: args[1] as [number, number, number],
          mode: 'add',
        });
        break;
      }

      case 'screen_blend': {
        const frames = args[0] as number;
        const color = args[1] as [number, number, number];
        this.owner?.screenBlend?.(frames, color);
        break;
      }

      // --- Sparks ---

      case 'hit_spark': {
        this.owner?.showHitSpark?.(this);
        break;
      }

      case 'crit_spark': {
        this.owner?.showCritSpark?.(this);
        break;
      }

      // --- Screen effects ---

      case 'screen_shake': {
        this.owner?.shake?.(1);
        break;
      }

      case 'screen_shake_2': {
        this.owner?.shake?.(4);
        break;
      }

      case 'platform_shake': {
        this.owner?.platformShake?.();
        break;
      }

      case 'pan': {
        // Python: toggle pan_away flag, then call pan_away() or pan_back()
        this.panAway = !this.panAway;
        if (this.panAway) {
          this.owner?.panAway?.();
        } else {
          this.owner?.panBack?.();
        }
        break;
      }

      // --- Child effects ---

      case 'effect': {
        this.spawnEffect(args[0] as string, this.effects);
        break;
      }

      case 'under_effect': {
        this.spawnEffect(args[0] as string, this.underEffects);
        break;
      }

      case 'enemy_effect': {
        if (this.partner) {
          this.partner.spawnEffect(args[0] as string, this.partner.effects);
        }
        break;
      }

      // --- Loop control ---

      case 'start_loop': {
        if (this.skipNextLoop > 0) {
          // Skip past end_loop — find the matching end_loop
          this.skipNextLoop--;
          let depth = 1;
          while (this.scriptIndex < this.currentPose!.timeline.length && depth > 0) {
            const nextCmd = this.currentPose!.timeline[this.scriptIndex];
            this.scriptIndex++;
            if (nextCmd.nid === 'start_loop') depth++;
            if (nextCmd.nid === 'end_loop') depth--;
          }
        } else {
          this.loopStartIndex = this.scriptIndex;
          // Pre-scan forward to find matching end_loop index
          this.loopEndIndex = -1;
          let depth = 1;
          let scan = this.scriptIndex;
          while (scan < this.currentPose!.timeline.length && depth > 0) {
            const nextCmd = this.currentPose!.timeline[scan];
            if (nextCmd.nid === 'start_loop') depth++;
            if (nextCmd.nid === 'end_loop') {
              depth--;
              if (depth === 0) {
                this.loopEndIndex = scan + 1; // index AFTER end_loop
              }
            }
            scan++;
          }
        }
        break;
      }

      case 'end_loop': {
        if (this.loopStartIndex >= 0) {
          this.scriptIndex = this.loopStartIndex;
        }
        break;
      }

      case 'end_parent_loop': {
        this.owner?.endParentLoop?.(this);
        break;
      }

      // --- Opacity and blend ---

      case 'opacity': {
        this.selfOpacity = args[0] as number;
        break;
      }

      case 'blend': {
        this.blendMode = (args[0] as boolean) ? 'add' : 'normal';
        break;
      }

      case 'blend2': {
        this.blendMode = (args[0] as boolean) ? 'sub' : 'normal';
        break;
      }

      // --- Static / pan control ---

      case 'static': {
        this.static = args[0] as boolean;
        break;
      }

      case 'ignore_pan': {
        this.ignorePan = args[0] as boolean;
        break;
      }

      // --- Darken / lighten ---

      case 'darken': {
        this.owner?.darken?.();
        break;
      }

      case 'lighten': {
        this.owner?.lighten?.();
        break;
      }

      // --- Unknown ---

      default: {
        console.warn(`BattleAnimation: unknown command "${cmd.nid}"`);
        break;
      }
    }
  }

  // -------------------------------------------------------------------
  // External triggers
  // -------------------------------------------------------------------

  /** Break out of the current start_loop/end_loop cycle. Called by
   *  child effects via end_parent_loop to stop the parent from looping. */
  breakLoop(): void {
    if (this.loopStartIndex >= 0 && this.loopEndIndex >= 0) {
      this.scriptIndex = this.loopEndIndex;
      this.loopStartIndex = -1;
      this.loopEndIndex = -1;
    } else {
      // No active loop, queue a skip for the next loop encountered
      this.skipNextLoop++;
    }
  }

  resume(): void {
    if (this.state === 'wait') {
      this.state = 'run';
      this.waitForHit = false;
      this.readScript();
    }
    // Also resume any child effects that are waiting
    for (const effect of this.effects) {
      effect.resume();
    }
    for (const effect of this.underEffects) {
      effect.resume();
    }
  }

  damaged(): void {
    const poseName = this.atRange > 0 ? 'RangedDamaged' : 'Damaged';
    this.setPose(poseName);
  }

  startDying(): void {
    this.deathOpacity = [...DEATH_OPACITY_SEQUENCE];
    this.deathFlash = false;
    this.state = 'dying';
  }

  startLeaving(): void {
    this.entranceCounter = 0;
    this.state = 'leaving';
  }

  // -------------------------------------------------------------------
  // Child effect spawning
  // -------------------------------------------------------------------

  spawnEffect(effectNid: string, targetList: BattleAnimation[]): void {
    if (!this.owner?.getEffectData) return;

    const effectData: CombatEffectData | null = this.owner.getEffectData(effectNid);
    if (!effectData) {
      console.warn(`BattleAnimation: effect "${effectNid}" not found`);
      return;
    }

    const effectFrameImages: Map<string, ImageBitmap | HTMLCanvasElement> =
      this.owner.getEffectFrameImages?.(effectNid) ?? new Map();

    // Create a WeaponAnimData-compatible object from the effect data
    const weaponAnimCompat: WeaponAnimData = {
      nid: effectData.nid,
      poses: effectData.poses,
      frames: effectData.frames,
    };

    const effect = new BattleAnimation(weaponAnimCompat, effectFrameImages);
    effect.pair(this.owner, this.partner, this.right, this.atRange, 0, this.initPosition);
    effect.entranceCounter = 0; // no entrance animation for effects
    effect.entranceFrames = 0;
    effect.state = 'run';

    // Start with the default pose (usually "Attack" or the first pose)
    const attackPose = effectData.poses.find(p => p.nid === 'Attack');
    const defaultPose = attackPose ?? effectData.poses[0];
    if (defaultPose) {
      effect.currentPose = defaultPose;
      effect.scriptIndex = 0;
      effect.frameCount = 0;
      effect.numFrames = 0;
      effect.readScript();
    }

    targetList.push(effect);
  }

  // -------------------------------------------------------------------
  // Draw data
  // -------------------------------------------------------------------

  getDrawData(): BattleAnimDrawData {
    const recoilX = this.lrOffset.length > 0 ? this.lrOffset[0] : 0;

    // Compute entrance progress
    let entranceProgress: number;
    if (this.entranceFrames <= 0) {
      entranceProgress = 1;
    } else {
      entranceProgress = Math.max(0, Math.min(1,
        (this.entranceFrames - this.entranceCounter) / this.entranceFrames,
      ));
    }

    // Compute effective opacity
    let effectiveOpacity = Math.min(this.selfOpacity, this.opacity);
    if (this.state === 'dying' && this.opacity < 255) {
      effectiveOpacity = Math.min(effectiveOpacity, 255 - this.opacity);
    }

    // Build tint info with computed alpha
    const activeTints = this.tints.map(t => {
      const elapsed = this.globalFrameCounter - t.startFrame;
      const remaining = t.duration - elapsed;
      const alpha = Math.max(0, Math.min(1, remaining / t.duration));
      return { color: t.color, mode: t.mode, alpha };
    });

    return {
      state: this.state,
      right: this.right,
      mainFrame: this.resolveFrame(this.currentFrameNid, this.frameOffset),
      underFrame: this.resolveFrame(this.underFrameNid, [0, 0]),
      overFrame: this.resolveFrame(this.overFrameNid, [0, 0]),
      entranceProgress,
      initPosition: this.initPosition,
      opacity: effectiveOpacity,
      blendMode: this.blendMode,
      recoilX: recoilX * (this.right ? -1 : 1),
      tints: activeTints,
      deathFlash: this.deathFlash,
      effects: this.effects.map(e => e.getDrawData()),
      underEffects: this.underEffects.map(e => e.getDrawData()),
    };
  }

  private resolveFrame(
    frameNid: string | null,
    extraOffset: [number, number],
  ): { image: ImageBitmap | HTMLCanvasElement; offset: [number, number] } | null {
    if (!frameNid) return null;

    const image = this.frameImages.get(frameNid);
    if (!image) return null;

    const frameData = this.frameDataMap.get(frameNid);
    if (!frameData) return null;

    let ox = frameData.offset[0] + extraOffset[0];
    let oy = frameData.offset[1] + extraOffset[1];

    // Mirror x-offset for left-side combatant
    if (!this.right) {
      const frameWidth = frameData.rect[2];
      ox = WINWIDTH - ox - frameWidth;
    }

    return { image, offset: [ox, oy] };
  }

  // -------------------------------------------------------------------
  // Query
  // -------------------------------------------------------------------

  isDone(): boolean {
    if (this.state !== 'inert') return false;
    if (this.effects.some(e => !e.isDone())) return false;
    if (this.underEffects.some(e => !e.isDone())) return false;
    return true;
  }

  /** Whether the animation is in an idle/standing pose. */
  isIdle(): boolean {
    if (!this.currentPose) return true;
    return IDLE_POSES.has(this.currentPose.nid);
  }

  /** The current pose name (string accessor for duck-typed compatibility). */
  get currentPoseName(): string {
    return this.currentPose?.nid ?? 'Stand';
  }

  /** Begin the death/flicker animation. */
  startDeath(): void {
    this.state = 'dying';
    this.deathOpacity = [...DEATH_OPACITY_SEQUENCE];
    this.deathFlash = false;
    this.opacity = 0;
  }
}
