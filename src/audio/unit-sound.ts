/**
 * unit-sound.ts — Python `unit_sound.UnitSound`: map footsteps.
 *
 * A moving unit plays `Map_Step_<sound>` on fixed frames of a per-movement-
 * class loop. Python ticks every unit's sound once per drawn map frame
 * (`MapView.draw_units`), at full volume, or in free roam scaled by the
 * unit's distance from the screen centre. Path moves call play() when they
 * start (unless the move is silent) and stop() when they finish; free-roam
 * movement calls play() while the unit is above its minimum speed and stop()
 * otherwise. stop() cuts the step that is still sounding.
 */

import type { UnitObject } from '../objects/unit';
import { isForkEngine } from '../engine/engine-flavor';
import { TILEHEIGHT, TILEWIDTH } from '../engine/constants';
import { viewport } from '../engine/viewport';

type StepSound = 'Flier' | 'Mounted' | 'Armor' | 'Infantry' | 'Mogall';

/** Python UnitSound.sound_catalog: frame -> step sound, or 'repeat' to loop. */
const SOUND_CATALOG: Record<StepSound, Record<number, string>> = {
  Flier: { 0: 'Flier', 20: 'repeat' },
  Mounted: { 0: 'Mounted1', 3: 'Mounted2', 10: 'Mounted3', 21: 'repeat' },
  Armor: { 0: 'Armor1', 16: 'Armor2', 32: 'repeat' },
  Infantry: { 0: 'Infantry1', 8: 'Infantry2', 16: 'repeat' },
  Mogall: { 0: 'Mogall', 19: 'repeat' },
};

export interface StepAudio {
  playSfx(nid: string, volume?: number): unknown;
  stopSfx(nid: string): void;
}

/** Unit tags as Python's `unit.tags` (own, class, and skill-granted). */
export type UnitTagCheck = (unit: UnitObject, tag: string) => boolean;

class UnitSound {
  frame = 0;
  currentSound: StepSound | null = null;
  playingSound: string | null = null;

  play(unit: UnitObject, hasTag: UnitTagCheck): void {
    // EOtF's fork predates upstream's Mogall loop.
    if (!isForkEngine() && hasTag(unit, 'Mogall')) this.currentSound = 'Mogall';
    else if (hasTag(unit, 'Flying')) this.currentSound = 'Flier';
    else if (hasTag(unit, 'Mounted')) this.currentSound = 'Mounted';
    else if (hasTag(unit, 'Armor')) this.currentSound = 'Armor';
    else this.currentSound = 'Infantry';
  }

  update(audio: StepAudio | null, volume: number): void {
    if (!this.currentSound) return;
    const sound = SOUND_CATALOG[this.currentSound][this.frame];
    if (sound === 'repeat') {
      this.frame = -1;
    } else if (sound !== undefined) {
      this.playingSound = `Map_Step_${sound}`;
      void audio?.playSfx(this.playingSound, volume);
    }
    this.frame++;
  }

  stop(audio: StepAudio | null): void {
    if (this.playingSound) audio?.stopSfx(this.playingSound);
    this.currentSound = null;
    this.playingSound = null;
    this.frame = 0;
  }
}

const sounds = new WeakMap<UnitObject, UnitSound>();

function soundOf(unit: UnitObject): UnitSound {
  let sound = sounds.get(unit);
  if (!sound) sounds.set(unit, sound = new UnitSound());
  return sound;
}

let audioRef: StepAudio | null = null;
let tagCheck: UnitTagCheck = (unit, tag) => (unit.tags ?? []).includes(tag);

/** Wire the audio sink and the unit-tag check (done once at boot). */
export function configureUnitSounds(audio: StepAudio | null, hasTag?: UnitTagCheck): void {
  audioRef = audio;
  if (hasTag) tagCheck = hasTag;
}

/** Python `unit.sound.play()`. */
export function playUnitSound(unit: UnitObject): void {
  soundOf(unit).play(unit, tagCheck);
}

/** Python `unit.sound.stop()`. */
export function stopUnitSound(unit: UnitObject): void {
  const sound = sounds.get(unit);
  if (sound && (sound.currentSound || sound.playingSound)) sound.stop(audioRef);
}

/** The step loop a unit is currently playing (tests). */
export function unitSoundState(unit: UnitObject): { sound: string | null; frame: number } {
  const sound = sounds.get(unit);
  return { sound: sound?.currentSound ?? null, frame: sound?.frame ?? 0 };
}

/**
 * Python MapView.draw_units: tick every placed unit's footsteps once per
 * frame. In free roam the volume falls off with distance from the centre of
 * the camera's cull rect (in tiles), reaching 0 at (TILEX + TILEY) / 2.
 */
export function updateUnitSounds(
  units: Iterable<UnitObject>,
  roam: boolean,
  cullRect: { x: number; y: number; w: number; h: number } | null,
): void {
  const tilesX = viewport.width / TILEWIDTH;
  const tilesY = viewport.height / TILEHEIGHT;
  const centre = cullRect
    ? [(cullRect.x + cullRect.w / 2) / TILEWIDTH, (cullRect.y + cullRect.h / 2) / TILEHEIGHT]
    : [0, 0];
  for (const unit of units) {
    const sound = sounds.get(unit);
    if (!sound?.currentSound) continue;
    let volume = 1;
    if (roam) {
      volume = unit.position
        ? Math.max(1 - Math.hypot(unit.position[0] - centre[0], unit.position[1] - centre[1]) / ((tilesX + tilesY) / 2), 0)
        : 0;
    }
    sound.update(audioRef, volume);
  }
}
