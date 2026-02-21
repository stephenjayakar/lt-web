/**
 * battle-anim-types.ts
 *
 * TypeScript interfaces and constants for Lex Talionis battle animation data.
 * These types model the combat animation system: spritesheets cut into frames,
 * timeline-based pose definitions, weapon-specific animations, palette swaps,
 * and spell/weapon effect animations.
 *
 * The original LT engine stores this data in the .ltproj resources directory
 * as JSON + PNG spritesheets. Palette swapping is done at render time by
 * remapping indexed colors.
 */

// -----------------------------------------------------------------------
// Frame, Command, Pose — the building blocks of animation timelines
// -----------------------------------------------------------------------

/** A single frame cut from a spritesheet. */
export interface BattleAnimFrame {
  /** Unique identifier within its weapon anim, e.g. "Sword_000" */
  nid: string;
  /** Source rectangle on the spritesheet: [x, y, width, height] */
  rect: [number, number, number, number];
  /** Screen placement offset in 240×160 space: [x, y] */
  offset: [number, number];
}

/**
 * A command in a pose timeline.
 *
 * Command types include:
 *  - "frame"      — display a frame for N ticks: [duration, frameNid]
 *  - "wait"       — pause for N ticks: [duration]
 *  - "sound"      — play a sound effect: [soundNid]
 *  - "start_hit"  — marks the hit-detection point (no args)
 *  - "end_hit"    — ends the hit window (no args)
 *  - "spell"      — trigger spell effect: [effectNid]
 *  - "screen_flash"— flash screen: [duration, color?]
 *  - "screen_shake"— shake screen: [duration]
 *  - "self_tint"  — tint the sprite: [duration, r, g, b]
 *  - "enemy_tint" — tint the enemy: [duration, r, g, b]
 *  - And others defined by the LT scripting layer.
 */
export interface BattleAnimCommand {
  /** Command type identifier */
  nid: string;
  /** Command arguments, or null for commands that take no arguments */
  args: unknown[] | null;
}

/** A named pose: a sequence of commands forming one animation action. */
export interface BattleAnimPose {
  /**
   * Pose name, e.g. "Stand", "Attack", "Critical", "Dodge", "Miss",
   * "RangedStand", "RangedDodge", "Damaged", "RangedDamaged", etc.
   */
  nid: string;
  /** Ordered list of commands that make up this pose's timeline */
  timeline: BattleAnimCommand[];
}

// -----------------------------------------------------------------------
// Weapon animations and combat animations
// -----------------------------------------------------------------------

/**
 * A weapon animation: one weapon type's full set of poses and frames
 * within a combat animation. Each weapon anim has its own spritesheet.
 */
export interface WeaponAnimData {
  /** Weapon type identifier, e.g. "Sword", "Lance", "Unarmed", "MagicAnima" */
  nid: string;
  /** All poses for this weapon type */
  poses: BattleAnimPose[];
  /** All frames defined for this weapon type's spritesheet */
  frames: BattleAnimFrame[];
}

/**
 * A complete combat animation for one class or unit. Contains palette
 * references and one or more weapon animations, each with their own
 * spritesheet, poses, and frames.
 */
export interface CombatAnimData {
  /** Unique identifier, e.g. "Eirika_Lord", "Mercenary" */
  nid: string;
  /**
   * Palette mappings: each entry is [palette_name, palette_nid].
   * palette_name is the team/context (e.g. "GenericBlue", "GenericRed"),
   * palette_nid references a PaletteData entry.
   */
  palettes: [string, string][];
  /** Weapon-specific animations */
  weapon_anims: WeaponAnimData[];
}

// -----------------------------------------------------------------------
// Combat effects (spells, arrows, etc.)
// -----------------------------------------------------------------------

/**
 * A combat effect animation: visual effects for spells, arrows, and
 * other non-character animations that play during battle scenes.
 * Effects have their own spritesheets and palette data.
 */
export interface CombatEffectData {
  /** Unique identifier, e.g. "Arrow", "FireShoot", "Lightning" */
  nid: string;
  /** All poses for this effect */
  poses: BattleAnimPose[];
  /** All frames defined for this effect's spritesheet */
  frames: BattleAnimFrame[];
  /**
   * Palette mappings: each entry is [palette_name, palette_nid].
   * Effects can have their own palettes for recoloring.
   */
  palettes: [string, string][];
}

// -----------------------------------------------------------------------
// Palette data
// -----------------------------------------------------------------------

/**
 * A palette maps (x, y) grid coordinates on a palette image to RGB colors.
 * Used for palette-swap rendering: the base spritesheet uses indexed colors
 * at specific coordinates, which are remapped to team/character colors.
 */
export interface PaletteData {
  /** Unique palette identifier */
  nid: string;
  /** Color map: key is "x,y" string, value is [r, g, b] (0–255 each) */
  colors: Map<string, [number, number, number]>;
}

// -----------------------------------------------------------------------
// Constants: required poses, idle poses, fallback chain
// -----------------------------------------------------------------------

/** Poses that every weapon animation should define. */
export const REQUIRED_POSES: readonly string[] = ['Stand', 'Attack', 'Miss', 'Dodge'];

/** Poses considered "idle" (looping standing animations). */
export const IDLE_POSES: ReadonlySet<string> = new Set([
  'Stand',
  'RangedStand',
  'TransformStand',
]);

/**
 * Pose fallback chain: if pose X is missing from a weapon animation,
 * fall back to pose Y. Applied recursively until a pose is found or
 * no further fallback exists.
 */
export const POSE_FALLBACKS: Readonly<Record<string, string>> = {
  'RangedStand': 'Stand',
  'RangedDodge': 'Dodge',
  'Miss': 'Attack',
  'Critical': 'Attack',
  'Damaged': 'Stand',
  'RangedDamaged': 'Damaged',
};
