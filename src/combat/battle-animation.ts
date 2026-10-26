/**
 * battle-animation.ts - Port of lt-maker/app/engine/battle_animation.py.
 *
 * One BattleAnimation per combatant (plus one per child effect) interprets a
 * pose timeline: frame display, sounds, hit synchronization (start_hit /
 * wait_for_hit / spell_hit), child effects, loops, and the flash commands
 * (self/enemy/parent tint, screen dodge, foreground/background blend,
 * screen blend, opacity, blend modes). Drawing follows Python's draw_under /
 * draw / draw_over split so AnimationCombat can interleave both sides in
 * the same order as the original.
 */

import type {
  WeaponAnimData,
  BattleAnimFrame,
  BattleAnimPose,
  BattleAnimCommand,
  CombatEffectData,
} from './battle-anim-types';
import { IDLE_POSES } from './battle-anim-types';
import { WINWIDTH, WINHEIGHT } from '../engine/constants';
import type { Surface } from '../engine/surface';

type FrameImage = ImageBitmap | HTMLCanvasElement;
type Color = [number, number, number];
type BlendMode = 'normal' | 'add' | 'sub';

/** Battle animation speed multiplier (Python battle_animation.battle_anim_speed). */
let battleAnimSpeed = 1;
export function setBattleAnimSpeed(speed: number): void {
  battleAnimSpeed = speed;
}

/** Python start_dying_animation's list; popped from the end. */
const DEATH_OPACITY: readonly number[] = [
  0, 20, 20, 20, 20, 44, 44, 44, 44, 64,
  64, 64, 64, 84, 84, 84, 108, 108, 108, 108,
  128, 128, 128, 128, 148, 148, 148, 148, 172, 172,
  172, 192, 192, 192, 192, 212, 212, 212, 212, 236,
  236, 236, 236, 255, 255, 255, 0, 0, 0, 0,
  0, 0, -1, 0, 0, 0, 0, 0, 0, 255,
  0, 0, 0, 0, 0, 0, 255, 0, 0, 0,
  0, 0, 0, 255, 0, 0, 0, 0, 0, 0,
  255, 0, 0, 0, 0, 0, 0,
];

/** Draw data kept for diagnostics/tests (presence of resolved frames). */
export interface BattleAnimDrawData {
  state: string;
  right: boolean;
  mainFrame: { image: FrameImage; offset: [number, number] } | null;
  underFrame: { image: FrameImage; offset: [number, number] } | null;
  overFrame: { image: FrameImage; offset: [number, number] } | null;
  opacity: number;
  blendMode: BlendMode;
}

/** The owner callbacks BattleAnimation drives (AnimationCombat). */
export interface BattleAnimOwner {
  playSound(name: string): void;
  stopSound?(name: string): void;
  shake(): void;
  rawShake(num: number): void;
  startHit(anim: BattleAnimation, miss?: boolean): void;
  spellHit(anim: BattleAnimation): void;
  hitModifiers(): void;
  platformShake(): void;
  panAway(): void;
  panBack(): void;
  screenFlash(numFrames: number, color: Color, fadeOut?: number): void;
  darken(): void;
  lighten(): void;
  setBrightness(value: number): void;
  hitSpark(): void;
  critSpark(): void;
  spellEffectNid(anim: BattleAnimation): string | null;
  getEffectData(effectNid: string): CombatEffectData | null;
  getEffectFrameImages(effectNid: string): Map<string, FrameImage>;
}

function clampByte(value: number): number {
  return value < 0 ? 0 : value > 255 ? 255 : value;
}

/** image_mods.blend_colors */
function blendColors(a: Color, b: Color, t: number): Color {
  const k = Math.max(0, Math.min(1, t));
  return [0, 1, 2].map((i) => Math.trunc((b[i] - a[i]) * k) + a[i]) as Color;
}

function toColor(value: unknown): Color {
  const v = Array.isArray(value) ? value : [255, 255, 255];
  return [Number(v[0] ?? 0), Number(v[1] ?? 0), Number(v[2] ?? 0)];
}

export class BattleAnimation {
  // --- Prefab ---
  animData: WeaponAnimData;
  frameImages: Map<string, FrameImage>;
  private poses: Map<string, BattleAnimPose> = new Map();
  private frames: Map<string, BattleAnimFrame> = new Map();
  readonly transform: boolean;
  readonly refresh: boolean;

  // --- clear() ---
  state: 'inert' | 'run' | 'wait' | 'dying' | 'leaving' = 'inert';
  inBasicState = false;
  processing = false;
  waitForHit = false;
  scriptIdx = 0;
  currentFrame: BattleAnimFrame | null = null;
  underFrame: BattleAnimFrame | null = null;
  overFrame: BattleAnimFrame | null = null;
  frameCount = 0;
  numFrames = 0;
  private loop: [number, number] | null = null;
  private skipNextLoop = 0;

  owner: BattleAnimOwner | null = null;
  partner: BattleAnimation | null = null;
  parent: BattleAnimation = this;
  right = true;
  atRange = 0;
  initPosition: [number, number] | null = null;
  entranceFrames = 0;
  entranceCounter = 0;
  currentPose: string | null = null;

  childEffects: BattleAnimation[] = [];
  underChildEffects: BattleAnimation[] = [];

  blend: BlendMode = 'normal';
  partialBlend = 0;
  foreground: Color | null = null;
  foregroundCounter = 0;
  background: Color | null = null;
  backgroundCounter = 0;
  flashColor: Color[] = [];
  flashCounter = 0;
  screenDodgeColor: Color | null = null;
  screenDodgeCounter = 0;
  opacity = 255;
  deathOpacity: number[] = [];
  static = false;
  ignorePan = false;
  panAwayFlag = false;
  lrOffset: number[] = [];
  effectOffset: [number, number] = [0, 0];
  personalOffset: [number, number] = [0, 0];

  /** Side flag kept for owners that track left/right separately. */
  isLeft = false;

  private imageCache = new Map<string, OffscreenCanvas>();

  constructor(animData: WeaponAnimData, frameImages: Map<string, FrameImage>) {
    this.animData = animData;
    this.frameImages = frameImages;
    for (const pose of animData.poses) this.poses.set(pose.nid, pose);
    for (const frame of animData.frames) this.frames.set(frame.nid, frame);
    this.generateMissingPoses();
    this.transform = animData.nid === 'Transform' || animData.nid === 'Revert';
    this.refresh = animData.nid.endsWith('Refresh');
  }

  /** _generate_missing_poses */
  private generateMissingPoses(): void {
    const copy = (to: string, from: string) => {
      if (!this.poses.has(to) && this.poses.has(from)) this.poses.set(to, this.poses.get(from)!);
    };
    copy('RangedStand', 'Stand');
    copy('RangedDodge', 'Dodge');
    copy('Miss', 'Attack');
    copy('Critical', 'Attack');
    copy('Damaged', 'Stand');
    copy('RangedDamaged', 'Damaged');
  }

  // ------------------------------------------------------------------
  // Pairing / pose control
  // ------------------------------------------------------------------

  pair(
    owner: BattleAnimOwner,
    partner: BattleAnimation | null,
    right: boolean,
    atRange: number,
    entranceFrames: number = 0,
    position: [number, number] | null = null,
    parent: BattleAnimation | null = null,
  ): void {
    this.owner = owner;
    this.partner = partner;
    this.parent = parent ?? this;
    this.right = right;
    this.atRange = atRange;
    this.entranceFrames = entranceFrames;
    this.entranceCounter = entranceFrames;
    this.initPosition = position;
    this.getStand();
    this.scriptIdx = 0;
    this.currentFrame = null;
    this.underFrame = null;
    this.overFrame = null;
    this.resetFrames();
  }

  isTransform(): boolean {
    return this.transform;
  }

  initiateTransform(): void {
    if (this.hasPose('Attack')) this.startAnim('Attack');
  }

  getStand(): void {
    this.currentPose = this.atRange ? 'RangedStand' : 'Stand';
  }

  getFrame(nid: unknown): BattleAnimFrame | null {
    return typeof nid === 'string' ? this.frames.get(nid) ?? null : null;
  }

  startAnim(pose: string): void {
    this.currentPose = pose;
    this.scriptIdx = 0;
    this.waitForHit = true;
    this.resetFrames();
  }

  /** Compatibility alias: start a pose by name. */
  setPose(pose: string): void {
    this.startAnim(pose);
  }

  hasPose(pose: string): boolean {
    return this.poses.has(pose);
  }

  endCurrentPose(): void {
    if (this.poses.has('Stand')) {
      this.getStand();
      this.state = 'run';
    } else {
      this.state = 'inert';
    }
    if (this.panAwayFlag) {
      this.panAwayFlag = false;
      this.owner?.panBack();
    }
    this.scriptIdx = 0;
  }

  resume(): void {
    if (this.state === 'wait') this.resetFrames();
    for (const effect of this.childEffects) effect.resume();
    for (const effect of this.underChildEffects) effect.resume();
    this.waitForHit = false;
  }

  finish(): void {
    this.getStand();
    this.state = 'leaving';
    this.scriptIdx = 0;
  }

  resetFrames(): void {
    this.state = 'run';
    this.frameCount = 0;
    this.numFrames = 0;
  }

  canProceed(): boolean {
    return !!this.loop || this.state === 'wait' || this.done();
  }

  done(): boolean {
    return this.state === 'inert' ||
      (this.state === 'run' && !!this.currentPose && IDLE_POSES.has(this.currentPose)) ||
      (this.transform && this.state === 'run' && this.scriptIdx >= this.script.length - 1) ||
      (this.refresh && this.state === 'run' && this.scriptIdx >= this.script.length - 1);
  }

  /** Compatibility: idle (standing) or finished. */
  isIdle(): boolean {
    return this.done();
  }

  isDone(): boolean {
    return this.state === 'inert';
  }

  dodge(): void {
    this.startAnim(this.atRange ? 'RangedDodge' : 'Dodge');
  }

  damaged(): void {
    this.startAnim(this.atRange ? 'RangedDamaged' : 'Damaged');
  }

  getNumFrames(num: unknown): number {
    return Math.max(1, Math.trunc(Math.trunc(Number(num)) * battleAnimSpeed));
  }

  startDyingAnimation(): void {
    this.state = 'dying';
    this.deathOpacity = [...DEATH_OPACITY];
  }

  waitForDying(): void {
    if (this.inBasicState) this.numFrames = Math.trunc(42 * battleAnimSpeed);
  }

  flash(numFrames: number, color: Color): void {
    this.flashCounter = numFrames;
    this.flashColor = [color];
  }

  screenDodge(numFrames: number, color: Color): void {
    this.screenDodgeCounter = numFrames;
    this.screenDodgeColor = color;
  }

  /** get_effect: a paired child effect started on its matching pose. */
  getEffect(effectNid: string, enemy: boolean = false, pose: string | null = null): BattleAnimation | null {
    const data = this.owner?.getEffectData(effectNid);
    if (!data || !this.owner) return null;
    const effect = new BattleAnimation(
      { nid: data.nid, poses: data.poses, frames: data.frames },
      this.owner.getEffectFrameImages(effectNid),
    );
    const right = enemy ? !this.right : this.right;
    const parent = enemy ? (this.parent.partner ?? this.parent) : this.parent;
    effect.pair(this.owner, this.partner, right, this.atRange, 0, null, parent);
    if (pose) effect.startAnim(pose);
    else if (this.currentPose && effect.hasPose(this.currentPose)) effect.startAnim(this.currentPose);
    else if (effect.hasPose('Attack')) effect.startAnim('Attack');
    return effect;
  }

  addEffect(effect: BattleAnimation, pose: string | null = null): void {
    if (pose && effect.hasPose(pose)) effect.currentPose = pose;
    this.childEffects.push(effect);
  }

  clearAllEffects(): void {
    for (const child of [...this.childEffects, ...this.underChildEffects]) child.clearAllEffects();
    this.childEffects = [];
    this.underChildEffects = [];
  }

  effectPlaying(): boolean {
    return this.childEffects.length > 0 || this.underChildEffects.length > 0;
  }

  endLoop(): void {
    if (this.loop) {
      if (this.loop[1] >= 0) this.scriptIdx = this.loop[1];
      this.loop = null;
    } else {
      this.skipNextLoop++;
    }
  }

  /** Compatibility alias used by the owner's end_parent_loop handling. */
  breakLoop(): void {
    this.endLoop();
  }

  get script(): BattleAnimCommand[] {
    return (this.currentPose && this.poses.get(this.currentPose)?.timeline) || [];
  }

  /** Compatibility accessors for the child effect lists. */
  get effects(): BattleAnimation[] {
    return this.childEffects;
  }

  get underEffects(): BattleAnimation[] {
    return this.underChildEffects;
  }

  // ------------------------------------------------------------------
  // Update / script
  // ------------------------------------------------------------------

  update(): boolean {
    if (this.state === 'run') {
      if (this.frameCount >= this.numFrames) {
        this.processing = true;
        this.readScript();
      }
      if (this.currentPose && this.poses.has(this.currentPose)) {
        if (this.scriptIdx >= this.script.length) {
          if (IDLE_POSES.has(this.currentPose)) this.scriptIdx = 0;
          else if (this.transform || this.refresh) this.scriptIdx = this.script.length - 1;
          else this.endCurrentPose();
        }
      } else {
        this.endCurrentPose();
      }
      this.frameCount++;
      if (this.entranceCounter) this.entranceCounter--;
    } else if (this.state === 'dying') {
      if (this.deathOpacity.length) {
        let opacity = this.deathOpacity.pop()!;
        if (opacity === -1) {
          opacity = 255;
          this.flashColor = [[248, 248, 248]];
          this.flashCounter = 100;
          this.owner?.playSound('CombatDeath');
        }
        this.opacity = opacity;
      } else {
        this.state = 'inert';
      }
    } else if (this.state === 'leaving') {
      this.entranceCounter++;
      if (this.entranceCounter > this.entranceFrames) {
        this.entranceCounter = this.entranceFrames;
        this.state = 'inert';
      }
    }

    for (const child of this.childEffects) child.update();
    for (const child of this.underChildEffects) child.update();
    this.childEffects = this.childEffects.filter((child) => child.state !== 'inert');
    this.underChildEffects = this.underChildEffects.filter((child) => child.state !== 'inert');
    return this.state === 'inert';
  }

  readScript(): void {
    if (!this.currentPose || !this.poses.has(this.currentPose)) return;
    while (this.scriptIdx < this.script.length && this.processing) {
      this.runCommand(this.script[this.scriptIdx]);
      this.scriptIdx++;
    }
  }

  private runCommand(command: BattleAnimCommand): void {
    this.inBasicState = false;
    const v = command.args ?? [];
    const owner = this.owner;
    switch (command.nid) {
      case 'frame':
        this.frameCount = 0;
        this.numFrames = this.getNumFrames(v[0]);
        this.currentFrame = this.getFrame(v[1]);
        this.underFrame = this.overFrame = null;
        this.processing = false;
        break;
      case 'over_frame':
        this.frameCount = 0;
        this.numFrames = this.getNumFrames(v[0]);
        this.overFrame = this.getFrame(v[1]);
        this.underFrame = this.currentFrame = null;
        this.processing = false;
        break;
      case 'under_frame':
        this.frameCount = 0;
        this.numFrames = this.getNumFrames(v[0]);
        this.underFrame = this.getFrame(v[1]);
        this.overFrame = this.currentFrame = null;
        this.processing = false;
        break;
      case 'frame_with_offset':
        this.frameCount = 0;
        this.numFrames = this.getNumFrames(v[0]);
        this.currentFrame = this.getFrame(v[1]);
        this.underFrame = this.overFrame = null;
        this.processing = false;
        this.personalOffset = [Math.trunc(Number(v[2])), Math.trunc(Number(v[3]))];
        break;
      case 'dual_frame':
        this.frameCount = 0;
        this.numFrames = this.getNumFrames(v[0]);
        this.currentFrame = this.getFrame(v[1]);
        this.underFrame = this.getFrame(v[2]);
        this.overFrame = null;
        this.processing = false;
        break;
      case 'wait':
        this.frameCount = 0;
        this.numFrames = this.getNumFrames(v[0]);
        this.currentFrame = this.overFrame = this.underFrame = null;
        this.processing = false;
        break;

      case 'sound':
        owner?.playSound(String(v[0]));
        break;
      case 'stop_sound':
        owner?.stopSound?.(String(v[0]));
        break;

      case 'start_hit':
        owner?.shake();
        owner?.startHit(this);
        if (this.partner) {
          this.partner.damaged();
          this.partner.lrOffset = [-1, -2, -3, -2, -1];
        }
        break;
      case 'wait_for_hit':
        if (this.waitForHit) {
          this.currentFrame = this.getFrame(v[0]);
          this.underFrame = this.getFrame(v[1]);
          this.overFrame = null;
          this.processing = false;
          this.state = 'wait';
          this.inBasicState = true;
        }
        break;
      case 'miss':
        owner?.startHit(this, true);
        this.partner?.dodge();
        break;
      case 'spell_hit':
        this.state = 'wait';
        this.processing = false;
        owner?.shake();
        owner?.spellHit(this);
        owner?.hitModifiers();
        this.partner?.damaged();
        break;
      case 'spell_hit_2':
        this.state = 'wait';
        this.processing = false;
        owner?.rawShake(4);
        owner?.spellHit(this);
        owner?.hitModifiers();
        this.partner?.damaged();
        break;

      case 'effect':
      case 'effect_with_offset': {
        const child = this.getEffect(String(v[0]));
        if (child) {
          if (command.nid === 'effect_with_offset') child.effectOffset = [Number(v[1]), Number(v[2])];
          this.childEffects.push(child);
        }
        break;
      }
      case 'under_effect':
      case 'under_effect_with_offset': {
        const child = this.getEffect(String(v[0]));
        if (child) {
          if (command.nid === 'under_effect_with_offset') child.effectOffset = [Number(v[1]), Number(v[2])];
          this.parent.underChildEffects.push(child);
        }
        break;
      }
      case 'enemy_effect':
      case 'enemy_effect_with_offset': {
        const child = this.getEffect(String(v[0]), true);
        if (child && this.partner) {
          if (command.nid === 'enemy_effect_with_offset') child.effectOffset = [Number(v[1]), Number(v[2])];
          this.partner.childEffects.push(child);
        }
        break;
      }
      case 'enemy_under_effect': {
        const child = this.getEffect(String(v[0]), true);
        if (child && this.partner) this.partner.underChildEffects.push(child);
        break;
      }
      case 'clear_all_effects':
        this.clearAllEffects();
        break;
      case 'spell': {
        const effectNid = v[0] ? String(v[0]) : owner?.spellEffectNid(this) ?? null;
        const child = effectNid ? this.getEffect(effectNid) : null;
        if (child) this.childEffects.push(child);
        break;
      }

      case 'blend':
        this.blend = v[0] ? 'add' : 'normal';
        break;
      case 'blend2':
        this.blend = v[0] ? 'sub' : 'normal';
        break;
      case 'partial_blend':
        this.partialBlend = Math.trunc(Number(v[0]));
        break;
      case 'static':
        this.static = !!v[0];
        break;
      case 'ignore_pan':
        this.ignorePan = !!v[0];
        break;
      case 'opacity':
        this.opacity = Math.trunc(Number(v[0]));
        break;
      case 'parent_opacity':
        this.parent.opacity = Math.trunc(Number(v[0]));
        break;

      case 'pan':
        this.panAwayFlag = !this.panAwayFlag;
        if (this.panAwayFlag) owner?.panAway();
        else owner?.panBack();
        break;

      case 'self_tint':
        this.flash(this.getNumFrames(v[0]), toColor(v[1]));
        break;
      case 'parent_tint':
        this.parent.flash(this.getNumFrames(v[0]), toColor(v[1]));
        break;
      case 'parent_tint_blend': {
        const a = toColor(v[1]);
        const b = toColor(v[2]);
        this.parent.flashCounter = this.getNumFrames(v[0]);
        this.parent.flashColor = [0, 0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875, 1]
          .map((t) => (t === 0 ? a : t === 1 ? b : blendColors(a, b, t)));
        break;
      }
      case 'enemy_tint':
        this.partner?.flash(this.getNumFrames(v[0]), toColor(v[1]));
        break;
      case 'self_screen_dodge':
        this.screenDodge(this.getNumFrames(v[0]), toColor(v[1]));
        break;
      case 'enemy_screen_dodge':
        this.partner?.screenDodge(this.getNumFrames(v[0]), toColor(v[1]));
        break;
      case 'background_blend':
        this.backgroundCounter = this.getNumFrames(v[0]);
        this.background = toColor(v[1]);
        break;
      case 'foreground_blend':
        this.foregroundCounter = this.getNumFrames(v[0]);
        this.foreground = toColor(v[1]);
        break;
      case 'screen_blend':
        owner?.screenFlash(this.getNumFrames(v[0]), toColor(v[1]));
        break;
      case 'screen_blend_with_fade_out':
        owner?.screenFlash(this.getNumFrames(v[0]), toColor(v[2]), this.getNumFrames(v[1]));
        break;

      case 'platform_shake':
        owner?.platformShake();
        break;
      case 'screen_shake':
        owner?.rawShake(1);
        break;
      case 'screen_shake_2':
        owner?.rawShake(4);
        break;
      case 'darken':
        owner?.darken();
        break;
      case 'lighten':
        owner?.lighten();
        break;
      case 'set_brightness':
        owner?.setBrightness(Math.trunc(Number(v[0])) / 255);
        break;
      case 'hit_spark':
        owner?.hitSpark();
        break;
      case 'crit_spark':
        owner?.critSpark();
        break;

      case 'start_loop':
        if (this.skipNextLoop) this.skipNextLoop--;
        else this.loop = [this.scriptIdx, -1];
        break;
      case 'end_loop':
        if (this.loop) {
          this.loop = [this.loop[0], this.scriptIdx];
          this.scriptIdx = this.loop[0];
        }
        break;
      case 'end_parent_loop':
        this.parent.endLoop();
        break;
      case 'end_child_loop':
        for (const child of [...this.childEffects, ...this.underChildEffects]) child.endLoop();
        break;
      default:
        break;
    }
  }

  // ------------------------------------------------------------------
  // Drawing
  // ------------------------------------------------------------------

  /**
   * get_image: the (flipped, tinted) frame image and its screen offset.
   * `shake` is AnimationCombat's (-total_shake_x, total_shake_y).
   */
  private getOffset(frame: BattleAnimFrame, width: number, shake: [number, number], rangeOffset: number, panOffset: number): [number, number] {
    let ox = frame.offset[0] + Math.trunc((WINWIDTH - 240) / 2);
    let oy = frame.offset[1] + (WINHEIGHT - 160);
    if (this.lrOffset.length) ox += this.lrOffset.pop()!;
    ox += this.effectOffset[0];
    oy += this.effectOffset[1];
    ox += this.personalOffset[0];
    oy += this.personalOffset[1];
    let left = 0;
    if (!this.static) left += shake[0] + rangeOffset;
    if (this.atRange && !this.static) {
      if (this.ignorePan) left -= this.right ? rangeOffset - 24 : rangeOffset + 24;
      else left += panOffset;
    }
    if (this.right) return [ox + shake[0] + left, oy + shake[1]];
    return [WINWIDTH - ox - width + left, oy + shake[1]];
  }

  /** Frame image (flipped for the left side) with an optional flash/dodge. */
  private frameCanvas(frame: BattleAnimFrame, flash: Color | null, dodge: Color | null): OffscreenCanvas | null {
    const source = this.frameImages.get(frame.nid);
    if (!source) return null;
    const key = `${frame.nid}|${this.right ? 1 : 0}|${flash?.join(',') ?? ''}|${dodge?.join(',') ?? ''}`;
    const cached = this.imageCache.get(key);
    if (cached) return cached;
    const width = source.width;
    const height = source.height;
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    ctx.imageSmoothingEnabled = false;
    if (!this.right) {
      ctx.translate(width, 0);
      ctx.scale(-1, 1);
    }
    ctx.drawImage(source, 0, 0);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (flash || dodge) {
      const image = ctx.getImageData(0, 0, width, height);
      const d = image.data;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i + 3] === 0) continue;
        if (flash) {
          // image_mods.change_color: add each band (subtract when negative)
          d[i] = clampByte(d[i] + flash[0]);
          d[i + 1] = clampByte(d[i + 1] + flash[1]);
          d[i + 2] = clampByte(d[i + 2] + flash[2]);
        }
        if (dodge) {
          // image_mods.screen_dodge: 1 - (1 - c)(1 - color)
          d[i] = 255 - Math.trunc((255 - d[i]) * (255 - dodge[0]) / 255);
          d[i + 1] = 255 - Math.trunc((255 - d[i + 1]) * (255 - dodge[1]) / 255);
          d[i + 2] = 255 - Math.trunc((255 - d[i + 2]) * (255 - dodge[2]) / 255);
        }
      }
      ctx.putImageData(image, 0, 0);
    }
    if (this.imageCache.size > 256) this.imageCache.clear();
    this.imageCache.set(key, canvas);
    return canvas;
  }

  private blitFrame(
    surf: Surface,
    frame: BattleAnimFrame,
    shake: [number, number],
    rangeOffset: number,
    panOffset: number,
    full: boolean,
  ): void {
    let flash: Color | null = null;
    let dodge: Color | null = null;
    if (full) {
      // handle_flash / handle_screen_dodge advance once per draw.
      if (this.flashColor.length) {
        flash = this.flashColor[((this.flashCounter % this.flashColor.length) + this.flashColor.length) % this.flashColor.length];
        this.flashCounter--;
        if (this.flashCounter <= 0) {
          this.flashColor = [];
          this.flashCounter = 0;
        }
      }
      if (this.screenDodgeColor) {
        dodge = this.screenDodgeColor;
        this.screenDodgeCounter--;
        if (this.screenDodgeCounter <= 0) {
          this.screenDodgeColor = null;
          this.screenDodgeCounter = 0;
        }
      }
    }
    const canvas = this.frameCanvas(frame, flash, dodge);
    const width = canvas?.width ?? frame.rect[2];
    let height = canvas?.height ?? frame.rect[3];
    let [x, y] = this.getOffset(frame, width, shake, rangeOffset, panOffset);
    if (!canvas) return;
    let drawW = width;
    if (full && this.entranceCounter && this.entranceFrames) {
      // Move the animations in at the beginning and out at the end.
      const progress = (this.entranceFrames - this.entranceCounter) / this.entranceFrames;
      drawW = Math.trunc(progress * width);
      height = Math.trunc(progress * height);
      const init = this.initPosition ?? [x, y];
      x = Math.trunc(init[0] + progress * (x - init[0]));
      y = Math.trunc(init[1] + progress * (y - init[1]));
    }
    if (drawW <= 0 || height <= 0) return;
    const alpha = full ? Math.max(0, Math.min(255, this.opacity)) / 255 : 1;
    drawCanvas(surf, canvas, x, y, drawW, height, this.blend, alpha);
    if (full && this.blend !== 'normal' && this.partialBlend) {
      drawCanvas(surf, canvas, x, y, drawW, height, 'normal', 1 - this.partialBlend / 255);
    }
  }

  /** BattleAnimation.draw */
  draw(surf: Surface, shake: [number, number] = [0, 0], rangeOffset: number = 0, panOffset: number = 0): void {
    if (this.state === 'inert') return;
    if (this.background && this.blend === 'normal') fillScreen(surf, this.background, 'add');
    for (const child of this.underChildEffects) child.draw(surf, [0, 0], rangeOffset, panOffset);
    if (this.currentFrame) this.blitFrame(surf, this.currentFrame, shake, rangeOffset, panOffset, true);
    for (const child of this.childEffects) child.draw(surf, [0, 0], rangeOffset, panOffset);
    if (this.foreground) {
      fillScreen(surf, this.foreground, 'add');
      this.foregroundCounter--;
      if (this.foregroundCounter <= 0) {
        this.foreground = null;
        this.foregroundCounter = 0;
      }
    }
    if (this.background) {
      this.backgroundCounter--;
      if (this.backgroundCounter <= 0) {
        this.background = null;
        this.backgroundCounter = 0;
      }
    }
  }

  /** BattleAnimation.draw_under */
  drawUnder(surf: Surface, shake: [number, number] = [0, 0], rangeOffset: number = 0, panOffset: number = 0): void {
    if (this.state === 'inert') return;
    for (const child of this.underChildEffects) child.drawUnder(surf, [0, 0], rangeOffset, panOffset);
    if (this.underFrame) this.blitFrame(surf, this.underFrame, shake, rangeOffset, panOffset, false);
    for (const child of this.childEffects) child.drawUnder(surf, [0, 0], rangeOffset, panOffset);
  }

  /** BattleAnimation.draw_over */
  drawOver(surf: Surface, shake: [number, number] = [0, 0], rangeOffset: number = 0, panOffset: number = 0): void {
    if (this.state !== 'inert' && this.overFrame) {
      this.blitFrame(surf, this.overFrame, shake, rangeOffset, panOffset, false);
    }
  }

  /** Resolved frames, for diagnostics and the asset-loading gate. */
  getDrawData(): BattleAnimDrawData {
    const resolve = (frame: BattleAnimFrame | null) => {
      if (!frame) return null;
      const image = this.frameImages.get(frame.nid);
      if (!image) return null;
      const ox = this.right ? frame.offset[0] : WINWIDTH - frame.offset[0] - frame.rect[2];
      return { image, offset: [ox, frame.offset[1]] as [number, number] };
    };
    let main = resolve(this.currentFrame);
    if (!main && this.state !== 'inert') {
      // Before pairing, report the first Stand frame so callers can tell
      // whether the spritesheet has arrived.
      const stand = this.poses.get(this.atRange ? 'RangedStand' : 'Stand')?.timeline
        .find((cmd) => cmd.nid === 'frame' || cmd.nid === 'dual_frame');
      main = resolve(this.getFrame(stand?.args?.[1]));
    } else if (!main && this.state === 'inert') {
      const stand = this.poses.get('Stand')?.timeline.find((cmd) => cmd.nid === 'frame' || cmd.nid === 'dual_frame');
      main = resolve(this.getFrame(stand?.args?.[1]));
    }
    return {
      state: this.state,
      right: this.right,
      mainFrame: main,
      underFrame: resolve(this.underFrame),
      overFrame: resolve(this.overFrame),
      opacity: this.opacity,
      blendMode: this.blend,
    };
  }
}

/** Blit a canvas onto a (possibly scaled) surface with a Python blend mode. */
export function drawCanvas(
  surf: Surface,
  canvas: OffscreenCanvas | HTMLCanvasElement | ImageBitmap,
  x: number,
  y: number,
  w: number,
  h: number,
  blend: BlendMode,
  alpha: number,
): void {
  if (alpha <= 0) return;
  const ctx = surf.ctx;
  const s = surf.scale;
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.globalAlpha = Math.min(1, alpha);
  // BLEND_RGB_ADD -> 'lighter'; BLEND_RGB_SUB has no canvas equivalent,
  // 'difference' matches it wherever the destination is the brighter side.
  if (blend === 'add') ctx.globalCompositeOperation = 'lighter';
  else if (blend === 'sub') ctx.globalCompositeOperation = 'difference';
  ctx.drawImage(canvas, Math.round(x * s), Math.round(y * s), Math.round(w * s), Math.round(h * s));
  ctx.restore();
}

/** Full-screen additive (or normal) color fill (Python bg_black.fill(color)). */
export function fillScreen(surf: Surface, color: Color, blend: BlendMode, alpha: number = 1): void {
  const ctx = surf.ctx;
  ctx.save();
  ctx.globalAlpha = alpha;
  if (blend === 'add') ctx.globalCompositeOperation = 'lighter';
  ctx.fillStyle = `rgb(${color[0]},${color[1]},${color[2]})`;
  ctx.fillRect(0, 0, surf.canvas.width, surf.canvas.height);
  ctx.restore();
}
