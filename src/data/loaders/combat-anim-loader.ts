/**
 * combat-anim-loader.ts
 *
 * Loads combat animation data from a .ltproj resources directory.
 * Handles three JSON data files:
 *   - combat_anims/combat_anims.json   — character combat animations
 *   - combat_effects/combat_effects.json — spell/weapon effect animations
 *   - combat_palettes/combat_palettes.json — palette color maps
 *
 * Also provides image loaders for animation spritesheets.
 *
 * All loaders accept a ResourceManager instance and return Maps keyed by nid.
 */

import { ResourceManager } from '../resource-manager';
import type {
  CombatAnimData,
  CombatEffectData,
  PaletteData,
  WeaponAnimData,
  BattleAnimFrame,
  BattleAnimPose,
  BattleAnimCommand,
} from '../../combat/battle-anim-types';

// -----------------------------------------------------------------------
// Raw JSON shapes (what comes out of the JSON files before parsing)
// -----------------------------------------------------------------------

/** Raw weapon anim entry in combat_anims.json */
type RawWeaponAnim = {
  nid: string;
  poses: [string, [string, unknown[] | null][]][];
  frames: [string, [number, number, number, number], [number, number]][];
};

/** Raw combat anim entry in combat_anims.json */
type RawCombatAnim = {
  nid: string;
  palettes: [string, string][];
  weapon_anims: RawWeaponAnim[];
};

/** Raw combat effect entry in combat_effects.json */
type RawCombatEffect = {
  nid: string;
  poses: [string, [string, unknown[] | null][]][];
  frames: [string, [number, number, number, number], [number, number]][];
  palettes: [string, string][];
};

/** Raw palette entry in combat_palettes.json: [nid, [[[x,y],[r,g,b]], ...]] */
type RawPaletteEntry = [string, [[number, number], [number, number, number]][]];

// -----------------------------------------------------------------------
// Internal parsing helpers
// -----------------------------------------------------------------------

/**
 * Parse a raw frame tuple into a BattleAnimFrame.
 * Input: [frameNid, [x, y, w, h], [ox, oy]]
 */
function parseFrame(raw: [string, [number, number, number, number], [number, number]]): BattleAnimFrame {
  return {
    nid: raw[0],
    rect: raw[1],
    offset: raw[2],
  };
}

/**
 * Parse a raw command tuple into a BattleAnimCommand.
 * Input: [commandNid, argsOrNull]
 */
function parseCommand(raw: [string, unknown[] | null]): BattleAnimCommand {
  return {
    nid: raw[0],
    args: raw[1],
  };
}

/**
 * Parse a raw pose tuple into a BattleAnimPose.
 * Input: [poseName, [[cmdNid, argsOrNull], ...]]
 */
function parsePose(raw: [string, [string, unknown[] | null][]]): BattleAnimPose {
  return {
    nid: raw[0],
    timeline: raw[1].map(parseCommand),
  };
}

/**
 * Parse a raw weapon anim object into a WeaponAnimData.
 */
function parseWeaponAnim(raw: RawWeaponAnim): WeaponAnimData {
  return {
    nid: raw.nid,
    poses: raw.poses.map(parsePose),
    frames: raw.frames.map(parseFrame),
  };
}

/**
 * Parse a raw combat anim object into a CombatAnimData.
 */
function parseCombatAnim(raw: RawCombatAnim): CombatAnimData {
  return {
    nid: raw.nid,
    palettes: raw.palettes,
    weapon_anims: raw.weapon_anims.map(parseWeaponAnim),
  };
}

/**
 * Parse a raw combat effect object into a CombatEffectData.
 */
function parseCombatEffect(raw: RawCombatEffect): CombatEffectData {
  return {
    nid: raw.nid,
    poses: raw.poses.map(parsePose),
    frames: raw.frames.map(parseFrame),
    palettes: raw.palettes,
  };
}

/**
 * Parse a raw palette entry into a PaletteData.
 * Input: [nid, [[[x,y],[r,g,b]], ...]]
 */
function parsePalette(raw: RawPaletteEntry): PaletteData {
  const colors = new Map<string, [number, number, number]>();
  for (const [[x, y], [r, g, b]] of raw[1]) {
    colors.set(`${x},${y}`, [r, g, b]);
  }
  return {
    nid: raw[0],
    colors,
  };
}

// -----------------------------------------------------------------------
// Public loaders
// -----------------------------------------------------------------------

/**
 * Load all combat animations from the .ltproj resources.
 *
 * Reads `resources/combat_anims/combat_anims.json`, which contains an
 * array of combat animation objects, each with weapon-specific sub-animations.
 *
 * @param resources - The ResourceManager for the current .ltproj
 * @returns Map from animation nid to CombatAnimData
 */
export async function loadCombatAnims(
  resources: ResourceManager,
): Promise<Map<string, CombatAnimData>> {
  const result = new Map<string, CombatAnimData>();

  const rawData = await resources.tryLoadJson<RawCombatAnim[]>(
    'resources/combat_anims/combat_anims.json',
  );
  if (!rawData) {
    console.warn('combat-anim-loader: combat_anims.json not found or empty');
    return result;
  }

  for (const raw of rawData) {
    try {
      const parsed = parseCombatAnim(raw);
      result.set(parsed.nid, parsed);
    } catch (err) {
      console.error(`combat-anim-loader: failed to parse combat anim "${raw.nid}":`, err);
    }
  }

  return result;
}

/**
 * Load all combat effect animations from the .ltproj resources.
 *
 * Reads `resources/combat_effects/combat_effects.json`, which contains an
 * array of effect animation objects. Effects are spell animations, arrows,
 * weapon trails, and other visual effects displayed during battle scenes.
 *
 * @param resources - The ResourceManager for the current .ltproj
 * @returns Map from effect nid to CombatEffectData
 */
export async function loadCombatEffects(
  resources: ResourceManager,
): Promise<Map<string, CombatEffectData>> {
  const result = new Map<string, CombatEffectData>();

  const rawData = await resources.tryLoadJson<RawCombatEffect[]>(
    'resources/combat_effects/combat_effects.json',
  );
  if (!rawData) {
    console.warn('combat-anim-loader: combat_effects.json not found or empty');
    return result;
  }

  for (const raw of rawData) {
    try {
      const parsed = parseCombatEffect(raw);
      result.set(parsed.nid, parsed);
    } catch (err) {
      console.error(`combat-anim-loader: failed to parse combat effect "${raw.nid}":`, err);
    }
  }

  return result;
}

/**
 * Load all combat palettes from the .ltproj resources.
 *
 * Supports two storage formats:
 *   - Chunked (default.ltproj): `.orderkeys` + individual JSON files in
 *     `resources/combat_palettes/palette_data/{nid}.json`
 *   - Non-chunked (older/testing): single `resources/combat_palettes/combat_palettes.json`
 *
 * @param resources - The ResourceManager for the current .ltproj
 * @returns Map from palette nid to PaletteData
 */
export async function loadCombatPalettes(
  resources: ResourceManager,
): Promise<Map<string, PaletteData>> {
  const result = new Map<string, PaletteData>();

  // Try chunked format first (default.ltproj uses this)
  const orderKeys = await resources.tryLoadJsonSilent<string[]>(
    'resources/combat_palettes/palette_data/.orderkeys',
  );

  if (orderKeys && orderKeys.length > 0) {
    // Chunked: load each palette file in parallel
    const entries = await Promise.all(
      orderKeys.map(async (key) => {
        // Each chunk file is a single-element array: [[nid, [[[x,y],[r,g,b]], ...]]]
        const raw = await resources.tryLoadJsonSilent<RawPaletteEntry[]>(
          `resources/combat_palettes/palette_data/${key}.json`,
        );
        return { key, raw };
      }),
    );

    for (const { key, raw } of entries) {
      if (!raw || !Array.isArray(raw) || raw.length === 0) continue;
      try {
        // Unwrap the single-element array
        const entry = raw[0];
        if (!entry || !Array.isArray(entry) || entry.length < 2) continue;
        const parsed = parsePalette(entry);
        result.set(parsed.nid, parsed);
      } catch (err) {
        console.error(`combat-anim-loader: failed to parse chunked palette "${key}":`, err);
      }
    }

    return result;
  }

  // Fall back to non-chunked format
  const rawData = await resources.tryLoadJsonSilent<RawPaletteEntry[]>(
    'resources/combat_palettes/combat_palettes.json',
  );
  if (!rawData) {
    // Also try the old path
    const altData = await resources.tryLoadJsonSilent<RawPaletteEntry[]>(
      'resources/combat_palettes/palettes.json',
    );
    if (!altData) {
      console.warn('combat-anim-loader: no combat palettes found (tried chunked + non-chunked)');
      return result;
    }
    for (const raw of altData) {
      try {
        const parsed = parsePalette(raw);
        result.set(parsed.nid, parsed);
      } catch (err) {
        console.error(`combat-anim-loader: failed to parse palette "${raw[0]}":`, err);
      }
    }
    return result;
  }

  for (const raw of rawData) {
    try {
      const parsed = parsePalette(raw);
      result.set(parsed.nid, parsed);
    } catch (err) {
      console.error(`combat-anim-loader: failed to parse palette "${raw[0]}":`, err);
    }
  }

  return result;
}

/**
 * Load the spritesheet PNG for a specific weapon animation.
 *
 * Spritesheets are stored at:
 *   resources/combat_anims/{combatAnimNid}-{weaponAnimNid}.png
 *
 * For example, "Eirika_Lord" with weapon "Sword" loads:
 *   resources/combat_anims/Eirika_Lord-Sword.png
 *
 * Returns the raw HTMLImageElement. Palette conversion is applied at render
 * time, not during loading.
 *
 * @param resources - The ResourceManager for the current .ltproj
 * @param combatAnimNid - The combat animation's nid (e.g. "Eirika_Lord")
 * @param weaponAnimNid - The weapon animation's nid (e.g. "Sword")
 * @returns The spritesheet image, or null if not found
 */
export async function loadWeaponAnimSpritesheet(
  resources: ResourceManager,
  combatAnimNid: string,
  weaponAnimNid: string,
): Promise<HTMLImageElement | null> {
  const path = `resources/combat_anims/${combatAnimNid}-${weaponAnimNid}.png`;
  return resources.tryLoadImage(path);
}

/**
 * Load the spritesheet PNG for a combat effect animation.
 *
 * Effect spritesheets are stored at:
 *   resources/combat_effects/{effectNid}.png
 *
 * @param resources - The ResourceManager for the current .ltproj
 * @param effectNid - The effect's nid (e.g. "Arrow", "FireShoot")
 * @returns The spritesheet image, or null if not found
 */
export async function loadEffectSpritesheet(
  resources: ResourceManager,
  effectNid: string,
): Promise<HTMLImageElement | null> {
  const path = `resources/combat_effects/${effectNid}.png`;
  return resources.tryLoadImage(path);
}
