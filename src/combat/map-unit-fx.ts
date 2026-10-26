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
    state = { flickers: [], vibrates: [], damageNumbers: [], pose: null, fadeOut: null, dying: false };
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
  if (!tints.length && !state.pose && !state.fadeOut && !state.dying && offsetX === 0) {
    if (!state.flickers.length && !state.vibrates.length && !state.damageNumbers.length) {
      states.delete(unit);
    }
    return null;
  }
  return {
    tints,
    opacity,
    offset: [offsetX, offsetY],
    direction: state.pose?.direction ?? null,
    stationary: state.dying,
    dying: state.dying,
  };
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
