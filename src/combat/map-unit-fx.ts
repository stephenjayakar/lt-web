/**
 * map-unit-fx.ts - Per-unit map sprite effects owned by Python's UnitSprite.
 *
 * Python keeps combat presentation state on `unit.sprite`, so it outlives the
 * combat that created it: the white hit flicker, the crit vibrate, the
 * combat-facing image state and lunge offset (`combat_attacker` /
 * `combat_anim`), the floating damage numbers, and the dying unit's white
 * flash + fade-out transition (unit_sprite.py `begin_flicker`,
 * `start_vibrate`, `change_state`, `damage_numbers`, `set_transition`).
 *
 * The map renderer reads `getUnitFx` while drawing each unit, and
 * `drawMapDamageNumbers` draws the numbers above the unit layer. Times use
 * the fixed 60 FPS engine clock (`fxNow`), the web equivalent of
 * `engine.get_time()`, so frame-stepped harness runs stay deterministic.
 */

import type { UnitObject } from '../objects/unit';
import type { Surface } from '../engine/surface';
import { FRAMETIME, TILEWIDTH, TILEHEIGHT, getFrameCount } from '../engine/constants';
import { getCombatSprite } from './combat-sprites';

export type FlickerMode = 'add' | 'sub';
export type FacingDirection = 'up' | 'down' | 'left' | 'right';

interface Flicker {
  start: number;
  duration: number;
  color: [number, number, number];
  mode: FlickerMode;
  fadeOut: boolean;
}

interface Vibrate {
  start: number;
  duration: number;
}

/** gui.DamageNumber (map variant: digits of a `small_*` or `extra_*` sheet). */
interface DamageNumber {
  digit: number;
  idx: number;
  length: number;
  sheet: string;
  start: number;
}

interface UnitFxState {
  flickers: Flicker[];
  vibrates: Vibrate[];
  damageNumbers: DamageNumber[];
  /** Combat image state: facing direction (move frames) + pixel offset. */
  pose: { direction: FacingDirection; offset: [number, number] } | null;
  /** `set_transition('fade_out')`: start time and duration. */
  fadeOut: { start: number; duration: number } | null;
  /** `unit.is_dying`: still drawn (stationary, no map HP bar) until Die. */
  dying: boolean;
  /** `set_transition`: an arrival/departure/move transition. */
  transition: TransitionFx | null;
  /** The transition's Warp/Swoosh animations (UnitSprite.animations). */
  anims: TransitionAnim[];
  /** add_warp_flowers particle bursts (UnitSprite.particles). */
  flowers: WarpFlowers[];
}

/** UnitSprite.set_transition states for arriving, leaving and moving. */
export type UnitTransitionState =
  | 'fade_in' | 'fade_out' | 'fade_move'
  | 'warp_in' | 'warp_out' | 'warp_move'
  | 'swoosh_in' | 'swoosh_out' | 'swoosh_move'
  | 'fake_in' | 'fake_out';

interface TransitionFx {
  state: UnitTransitionState;
  /** Engine frame the transition began (transition_counter = 450 then). */
  startFrame: number;
  /** `_fake_position`: where the sprite draws while it leaves. */
  fakePosition: [number, number] | null;
  /** fake_in/fake_out sprite offset, moved 2 px per frame. */
  slide: [number, number];
  slideFrame: number;
}

interface TransitionAnim {
  nid: 'Warp' | 'Swoosh';
  startFrame: number;
  reverse: boolean;
  offset: [number, number];
  /** Warp draws a 33%-translucent copy and an additive copy. */
  mode: 'translucent' | 'add' | 'normal';
}

interface WarpFlowers {
  startFrame: number;
  reverse: boolean;
  /** Pixel center of the tile the burst started on. */
  x: number;
  y: number;
}

/** Map animation sheet the transitions draw (resources/animations). */
export interface TransitionAnimSheet {
  image: CanvasImageSource;
  frameWidth: number;
  frameHeight: number;
  frameX: number;
  numFrames: number;
  /** ms per frame (constant timing). */
  speed: number;
}

interface TransitionEnv {
  playSfx?(nid: string): void;
  anim?(nid: 'Warp' | 'Swoosh'): TransitionAnimSheet | null;
  flowerSprite?(): Surface | null;
}

let transitionEnv: TransitionEnv = {};

/** Sound, animation and particle sources for the transitions. */
export function setTransitionEnv(env: TransitionEnv): void {
  transitionEnv = env;
}

/** What the renderer applies to one unit this frame. */
export interface UnitFxVisual {
  /** Tints applied in order (Python add_tint / sub_tint per flicker). */
  tints: Array<{ color: [number, number, number]; mode: FlickerMode }>;
  /** Sprite opacity (1 - fade progress). */
  opacity: number;
  /** Pixel offset: combat lunge plus the ±1 crit vibrate. */
  offset: [number, number];
  /** Facing override for the combat image states. */
  direction: FacingDirection | null;
  /** Dying units draw a stationary frame (create_image stationary=True). */
  stationary: boolean;
  /** `unit.is_dying`: drawn although its HP reached 0; hides the map HP bar. */
  dying: boolean;
  /** Swoosh transitions stretch the sprite upward by this factor. */
  stretchY: number;
  /** A transition is running (UnitSprite.draw_hp shows no HP bar then). */
  transitioning: boolean;
}

/** UnitSprite.default_transition_time. */
export const DEFAULT_TRANSITION_TIME = 450;

const DAMAGE_NUMBER = { bounce: 400, pause: 600, total: 1200 };

const states = new Map<UnitObject, UnitFxState>();

/** Fixed-step engine time in ms (Python engine.get_time()). */
export function fxNow(): number {
  return getFrameCount() * FRAMETIME;
}

function stateFor(unit: UnitObject): UnitFxState {
  let state = states.get(unit);
  if (!state) {
    state = {
      flickers: [], vibrates: [], damageNumbers: [], pose: null, fadeOut: null, dying: false,
      transition: null, anims: [], flowers: [],
    };
    states.set(unit, state);
  }
  return state;
}

/** unit.sprite.begin_flicker / start_flicker. */
export function startFlicker(
  unit: UnitObject,
  delay: number,
  duration: number,
  color: [number, number, number],
  mode: FlickerMode = 'add',
  fadeOut: boolean = false,
): void {
  stateFor(unit).flickers.push({ start: fxNow() + delay, duration, color, mode, fadeOut });
}

/** unit.sprite.start_vibrate. */
export function startVibrate(unit: UnitObject, delay: number, duration: number): void {
  stateFor(unit).vibrates.push({ start: fxNow() + delay, duration });
}

/**
 * Python map combat damage numbers: one DamageNumber per digit, drawn by the
 * target's sprite. `sheet` is the `damage_numbers_<sheet>` sprite.
 */
export function addDamageNumbers(unit: UnitObject, damage: number, sheet: string): void {
  if (damage <= 0) return;
  const digits = String(damage);
  const state = stateFor(unit);
  const now = fxNow();
  for (let idx = 0; idx < digits.length; idx++) {
    state.damageNumbers.push({
      digit: Number(digits[idx]),
      idx,
      length: digits.length,
      sheet: `damage_numbers_${sheet}`,
      start: now,
    });
  }
}

/** Combat image state (`combat_attacker` & co.); null restores `normal`. */
export function setCombatPose(
  unit: UnitObject,
  direction: FacingDirection | null,
  offset: [number, number] = [0, 0],
): void {
  const state = stateFor(unit);
  state.pose = direction ? { direction, offset } : null;
}

export function setCombatPoseOffset(unit: UnitObject, offset: [number, number]): void {
  const pose = stateFor(unit).pose;
  if (pose) pose.offset = offset;
}

/** game.death.should_die: the unit stays on the map until its fade ends. */
export function markDying(unit: UnitObject): void {
  stateFor(unit).dying = true;
}

/** True between should_die and Die (or a miracle). */
export function isUnitDying(unit: UnitObject): boolean {
  return states.get(unit)?.dying === true;
}

/** DeathManager.update first tick: white flicker and the fade_out transition. */
export function startDyingFade(unit: UnitObject): void {
  const state = stateFor(unit);
  state.dying = true;
  const now = fxNow();
  state.flickers.push({
    start: now,
    duration: DEFAULT_TRANSITION_TIME,
    color: [255, 255, 255],
    mode: 'add',
    fadeOut: false,
  });
  state.fadeOut = { start: now, duration: DEFAULT_TRANSITION_TIME };
}

/** Drop every effect on a unit (death, miracle, or a new level). */
export function clearUnitFx(unit?: UnitObject): void {
  if (unit) states.delete(unit);
  else states.clear();
}

/** Facing that `handle_net_position` picks for a tile delta. */
export function facingFor(dx: number, dy: number): FacingDirection {
  if (Math.abs(dx) >= Math.abs(dy)) {
    if (dx > 0) return 'right';
    if (dx < 0) return 'left';
    return 'down';
  }
  return dy < 0 ? 'up' : 'down';
}

/** Current visual effects for a unit, or null when it draws normally. */
export function getUnitFx(unit: UnitObject, now: number = fxNow()): UnitFxVisual | null {
  const state = states.get(unit);
  if (!state) return null;
  const tints: UnitFxVisual['tints'] = [];
  state.flickers = state.flickers.filter((flicker) => now <= flicker.start + flicker.duration);
  for (const flicker of state.flickers) {
    if (now < flicker.start) continue;
    let color = flicker.color;
    if (flicker.fadeOut) {
      const passed = now - flicker.start;
      color = color.map((c) => Math.floor((flicker.duration - passed) * c / flicker.duration)) as [number, number, number];
    }
    tints.push({ color, mode: flicker.mode });
  }
  let offsetX = state.pose?.offset[0] ?? 0;
  const offsetY = state.pose?.offset[1] ?? 0;
  state.vibrates = state.vibrates.filter((vibrate) => now <= vibrate.start + vibrate.duration);
  for (const vibrate of state.vibrates) {
    if (now >= vibrate.start) offsetX += getFrameCount() % 2 ? 1 : -1;
  }
  let opacity = 1;
  if (state.fadeOut) {
    const progress = Math.max(0, Math.min(1, (now - state.fadeOut.start) / state.fadeOut.duration));
    opacity = 1 - progress;
  }
  advanceTransition(unit, state);
  const transition = state.transition;
  let stretchY = 1;
  let direction: FacingDirection | null = state.pose?.direction ?? null;
  let finalOffsetY = offsetY;
  if (transition) {
    const progress = transitionProgress(transition);
    const t = transition.state;
    const leaving = t === 'fade_out' || t === 'warp_out' || t === 'swoosh_out' ||
      t === 'fade_move' || t === 'warp_move' || t === 'swoosh_move' || t === 'fake_out';
    // unit_sprite.draw: make_translucent(image, progress) while leaving,
    // (1 - progress) while arriving.
    opacity *= leaving ? 1 - progress : progress;
    if (t === 'swoosh_out' || t === 'swoosh_move') stretchY = Math.max(0, progress - 0.4) * 3 + 1;
    else if (t === 'swoosh_in') stretchY = Math.max(0, (1 - progress) - 0.4) * 3 + 1;
    offsetX += transition.slide[0];
    finalOffsetY += transition.slide[1];
    if (t === 'fake_in' || t === 'fake_out') {
      // change_state('fake_transition_*'): face the way the unit slides.
      const sx = Math.sign(transition.slide[0]);
      const sy = Math.sign(transition.slide[1]);
      direction = t === 'fake_in' ? facingFor(-sx, -sy) : facingFor(sx, sy);
    } else if (t === 'swoosh_in') {
      direction = 'down';
    }
  }
  const hasOverlay = state.anims.length > 0 || state.flowers.length > 0;
  if (!tints.length && !state.pose && !state.fadeOut && !state.dying && offsetX === 0 && !transition) {
    if (!state.flickers.length && !state.vibrates.length && !state.damageNumbers.length && !hasOverlay) {
      states.delete(unit);
    }
    return null;
  }
  return {
    tints,
    opacity,
    offset: [offsetX, finalOffsetY],
    direction,
    stationary: state.dying,
    dying: state.dying,
    stretchY,
    transitioning: !!transition,
  };
}

// ---------------------------------------------------------------------------
// Arrival / departure transitions (UnitSprite.set_transition)
// ---------------------------------------------------------------------------

const WARP_FLOWER_FRAMES = 40;

function transitionProgress(transition: TransitionFx): number {
  const elapsed = (getFrameCount() - transition.startFrame) * FRAMETIME;
  return Math.max(0, Math.min(1, elapsed / DEFAULT_TRANSITION_TIME));
}

/**
 * UnitSprite.set_transition. Moves (`*_move`) start on `from`, the tile the
 * unit left; leaving transitions draw on the unit's current tile. Sounds,
 * Warp/Swoosh animations, the white warp flicker and warp flowers start
 * here, as in Python.
 */
export function setUnitTransition(
  unit: UnitObject,
  transitionState: UnitTransitionState,
  opts: { from?: [number, number] | null; offset?: [number, number] } = {},
): void {
  const state = stateFor(unit);
  const frame = getFrameCount();
  const here: [number, number] | null = unit.position ? [unit.position[0], unit.position[1]] : null;
  const transition: TransitionFx = {
    state: transitionState, startFrame: frame, fakePosition: null,
    slide: [0, 0], slideFrame: frame,
  };
  const anim = (nid: 'Warp' | 'Swoosh', reverse: boolean) => {
    if (nid === 'Warp') {
      state.anims.push({ nid, startFrame: frame, reverse, offset: [-7, -24], mode: 'translucent' });
      state.anims.push({ nid, startFrame: frame, reverse, offset: [-7, -24], mode: 'add' });
    } else {
      state.anims.push({ nid, startFrame: frame, reverse, offset: [-12, -40], mode: 'normal' });
    }
  };
  const flowers = (at: [number, number] | null, reverse: boolean) => {
    if (!at) return;
    state.flowers.push({
      startFrame: frame, reverse,
      x: at[0] * TILEWIDTH + TILEWIDTH / 2,
      y: at[1] * TILEHEIGHT + TILEHEIGHT / 2,
    });
  };
  const sfx = (nid: string) => transitionEnv.playSfx?.(nid);
  switch (transitionState) {
    case 'fake_in':
      transition.slide = opts.offset ? [opts.offset[0], opts.offset[1]] : [0, 0];
      break;
    case 'fake_out':
      transition.fakePosition = here;
      transition.slide = opts.offset ? [opts.offset[0], opts.offset[1]] : [0, 0];
      break;
    case 'fade_in':
      break;
    case 'fade_out':
      transition.fakePosition = here;
      break;
    case 'fade_move':
      transition.fakePosition = opts.from ?? here;
      break;
    case 'warp_in':
      sfx('WarpEnd');
      anim('Warp', false);
      flowers(here, true);
      break;
    case 'warp_out':
    case 'warp_move':
      sfx('Warp');
      transition.fakePosition = transitionState === 'warp_move' ? opts.from ?? here : here;
      anim('Warp', false);
      state.flickers.push({ start: fxNow(), duration: DEFAULT_TRANSITION_TIME, color: [255, 255, 255], mode: 'add', fadeOut: false });
      flowers(transition.fakePosition, false);
      break;
    case 'swoosh_in':
      sfx('Sword Whoosh');
      anim('Swoosh', false);
      break;
    case 'swoosh_out':
    case 'swoosh_move':
      sfx('Sword Whoosh');
      transition.fakePosition = transitionState === 'swoosh_move' ? opts.from ?? here : here;
      anim('Swoosh', true);
      break;
  }
  state.transition = transition;
}

/** UnitSprite.update_state / update_transition, caught up to this frame. */
function advanceTransition(unit: UnitObject, state: UnitFxState): void {
  const transition = state.transition;
  if (!transition) return;
  const frame = getFrameCount();
  if (transition.state === 'fake_in' || transition.state === 'fake_out') {
    const growing = transition.state === 'fake_out';
    while (transition.slideFrame < frame) {
      transition.slideFrame++;
      for (const axis of [0, 1]) {
        const value = transition.slide[axis];
        if (value === 0) continue;
        transition.slide[axis] = value + (growing ? Math.sign(value) * 2 : -Math.sign(value) * 2);
      }
      const [x, y] = transition.slide;
      if (growing ? Math.abs(x) > TILEWIDTH || Math.abs(y) > TILEHEIGHT : x === 0 && y === 0) {
        state.transition = null;
        return;
      }
    }
    return;
  }
  const elapsed = (frame - transition.startFrame) * FRAMETIME;
  if (DEFAULT_TRANSITION_TIME - elapsed >= 0) return;
  // transition_counter ran out: _fake_position clears, then the next state.
  state.transition = null;
  if (transition.state === 'fade_move') setUnitTransition(unit, 'fade_in');
  else if (transition.state === 'warp_move') setUnitTransition(unit, 'warp_in');
  else if (transition.state === 'swoosh_move') setUnitTransition(unit, 'swoosh_in');
}

/** Where a transitioning unit draws (its fake position while it leaves). */
export function getTransitionPosition(unit: UnitObject): [number, number] | null {
  const state = states.get(unit);
  if (!state) return unit.position;
  advanceTransition(unit, state);
  return state.transition?.fakePosition ?? unit.position;
}

/** Units drawn off the board: leaving units still on their fake tile. */
export function offBoardTransitionUnits(): UnitObject[] {
  const units: UnitObject[] = [];
  for (const [unit, state] of states) {
    advanceTransition(unit, state);
    if (!unit.position && state.transition?.fakePosition) units.push(unit);
  }
  return units;
}

/** The unit's transition state, or null (tests and draw_hp). */
export function getUnitTransition(unit: UnitObject): UnitTransitionState | null {
  const state = states.get(unit);
  if (!state) return null;
  advanceTransition(unit, state);
  return state.transition?.state ?? null;
}

/**
 * Draw a unit's transition animations and warp flowers (UnitSprite.draw:
 * animations at the sprite's tile top-left, then its particle systems).
 */
export function drawUnitTransitionOverlay(
  surf: Surface,
  unit: UnitObject,
  left: number,
  top: number,
  cameraX: number,
  cameraY: number,
): void {
  const state = states.get(unit);
  if (!state || (!state.anims.length && !state.flowers.length)) return;
  const frame = getFrameCount();
  state.anims = state.anims.filter((anim) => {
    const sheet = transitionEnv.anim?.(anim.nid) ?? null;
    if (!sheet) return (frame - anim.startFrame) * FRAMETIME < 1000;
    const counter = Math.floor(((frame - anim.startFrame) * FRAMETIME) / Math.max(1, sheet.speed));
    if (counter >= sheet.numFrames) return false;
    const index = anim.reverse ? sheet.numFrames - 1 - counter : counter;
    const sx = (index % sheet.frameX) * sheet.frameWidth;
    const sy = Math.floor(index / sheet.frameX) * sheet.frameHeight;
    const ctx = surf.ctx;
    const scale = surf.scale;
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    if (anim.mode === 'translucent') ctx.globalAlpha = 1 - 0.33;
    else if (anim.mode === 'add') ctx.globalCompositeOperation = 'lighter';
    ctx.drawImage(
      sheet.image, sx, sy, sheet.frameWidth, sheet.frameHeight,
      Math.round((left + anim.offset[0]) * scale), Math.round((top + anim.offset[1]) * scale),
      sheet.frameWidth * scale, sheet.frameHeight * scale,
    );
    ctx.restore();
    return true;
  });
  const sprite = transitionEnv.flowerSprite?.() ?? null;
  state.flowers = state.flowers.filter((burst) => {
    const age = frame - burst.startFrame;
    if (age >= WARP_FLOWER_FRAMES) return false;
    if (sprite) {
      for (const [x, y] of warpFlowerPositions(burst, age)) surf.blit(sprite, Math.floor(x - cameraX), Math.floor(y - cameraY));
    }
    return true;
  });
}

/**
 * particles.WarpFlower / ReverseWarpFlower: 16 petals at speed 4.5 from the
 * tile center, angle num*pi/8 + pi/16, turning pi/64 a frame for 40 frames
 * (the reverse burst pre-runs 40 frames and flies back in).
 */
export function warpFlowerPositions(burst: { x: number; y: number; reverse: boolean }, age: number): Array<[number, number]> {
  const speed = 4.5;
  const step = Math.PI / 8;
  const positions: Array<[number, number]> = [];
  for (let num = 0; num < 16; num++) {
    let angle = num * step + step / 2;
    let x = burst.x;
    let y = burst.y;
    if (burst.reverse) {
      for (let i = 0; i < WARP_FLOWER_FRAMES; i++) {
        angle -= Math.PI / 64;
        x += speed * Math.cos(angle);
        y += speed * Math.sin(angle);
      }
      for (let i = 0; i < age; i++) {
        angle += Math.PI / 64;
        x -= speed * Math.cos(angle);
        y -= speed * Math.sin(angle);
      }
    } else {
      for (let i = 0; i < age; i++) {
        angle -= Math.PI / 64;
        x += speed * Math.cos(angle);
        y += speed * Math.sin(angle);
      }
    }
    positions.push([x, y]);
  }
  return positions;
}

/** True while any unit still has floating damage numbers to draw. */
export function hasMapDamageNumbers(): boolean {
  for (const state of states.values()) if (state.damageNumbers.length) return true;
  return false;
}

/**
 * Draw every unit's damage numbers (UnitSprite.draw: DamageNumber.draw at
 * the tile top-left + (4, 0)). Call after the unit layer.
 */
export function drawMapDamageNumbers(
  surf: Surface,
  cameraX: number,
  cameraY: number,
  now: number = fxNow(),
): void {
  for (const [unit, state] of states) {
    if (!state.damageNumbers.length) continue;
    state.damageNumbers = state.damageNumbers.filter((num) => now - num.start <= DAMAGE_NUMBER.total);
    if (!unit.position) continue;
    const visual = getUnitFx(unit, now);
    const left = unit.position[0] * TILEWIDTH - cameraX + (visual?.offset[0] ?? 0) + 4;
    const top = unit.position[1] * TILEHEIGHT - cameraY + (visual?.offset[1] ?? 0);
    for (const num of state.damageNumbers) {
      drawDamageNumber(surf, num, now - num.start, left, top);
    }
  }
}

function drawDamageNumber(surf: Surface, num: DamageNumber, elapsed: number, x: number, y: number): void {
  const sheet = getCombatSprite(num.sheet);
  if (!sheet) return;
  const initTime = 50 * num.idx; // small/extra numbers start without the +50 delay
  if (elapsed <= initTime) return;
  let topPos = 0;
  let alpha = 1;
  const stateTime = elapsed - initTime;
  if (stateTime <= DAMAGE_NUMBER.bounce) {
    topPos = 10 * Math.exp(-stateTime / 250) * Math.sin(stateTime / 25);
    alpha = 1 - Math.max(0, Math.min(1, (200 - stateTime) / 200));
  } else if (elapsed > initTime + DAMAGE_NUMBER.bounce + DAMAGE_NUMBER.pause) {
    const fadeTime = elapsed - initTime - DAMAGE_NUMBER.bounce - DAMAGE_NUMBER.pause;
    topPos = fadeTime / 10;
    alpha = 1 - Math.max(0, Math.min(1, fadeTime / 150));
  }
  if (alpha <= 0) return;
  const ctx = surf.ctx;
  const scale = surf.scale;
  const prevAlpha = ctx.globalAlpha;
  ctx.imageSmoothingEnabled = false;
  ctx.globalAlpha = alpha;
  // EOtF fork gui.DamageNumber: `extra_*` digits are small digits shifted
  // 16 px right of the main number.
  const extra = num.sheet.startsWith('damage_numbers_extra');
  const dx = (extra ? 16 : 0) + x - 4 * num.length + 8 * num.idx;
  const dy = y - topPos;
  ctx.drawImage(
    sheet.canvas,
    num.digit * 16, 0, 16, 16,
    Math.round(dx * scale), Math.round(dy * scale), 16 * scale, 16 * scale,
  );
  ctx.globalAlpha = prevAlpha;
}
