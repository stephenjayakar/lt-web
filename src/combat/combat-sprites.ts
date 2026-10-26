/**
 * combat-sprites.ts - Python `SPRITES.get(name)` for the combat UI.
 *
 * LT's engine sprites live in nested folders under `sprites/` and are looked
 * up by bare name; a project's `resources/custom_sprites/<name>.png`
 * overrides the engine copy. Combat presentation (map combat info windows,
 * damage numbers, battle-scene name tags and HP bars) draws these every
 * frame, so they are loaded once, asynchronously, and read synchronously
 * afterwards: `getCombatSprite` returns null until the image arrives.
 */

import { Surface, surfaceFromImage } from '../engine/surface';

/** Engine folder of each combat sprite family (Python walks them all). */
const SPRITE_DIRS: Array<[RegExp, string]> = [
  [/^damage_numbers_/, 'damage_numbers'],
  [/^(health_bar|arrow_advantage)$/, 'displays'],
  [/^(combat_|health_|guard_|empty_hp_blip|full_hp_blip|overflow)/, 'combat_displays'],
];

const cache = new Map<string, Surface | null>();
const pending = new Set<string>();
let projectResources: { loadImage(path: string): Promise<HTMLImageElement> } | null = null;

/** Project resource manager, for `custom_sprites` overrides. */
export function setCombatSpriteResources(resources: typeof projectResources): void {
  if (resources === projectResources) return;
  projectResources = resources;
  cache.clear();
}

function engineUrl(name: string): string {
  const dir = SPRITE_DIRS.find(([pattern]) => pattern.test(name))?.[1];
  return dir ? `/game-data/sprites/${dir}/${name}.png` : `/game-data/sprites/${name}.png`;
}

function loadImage(url: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

async function load(name: string): Promise<void> {
  let image: HTMLImageElement | null = null;
  if (projectResources) {
    try {
      image = await projectResources.loadImage(`resources/custom_sprites/${name}.png`);
    } catch {
      image = null;
    }
  }
  image ??= await loadImage(engineUrl(name));
  cache.set(name, image ? surfaceFromImage(image) : null);
  pending.delete(name);
}

/** Sprite by Python name, or null while it loads (or if it is missing). */
export function getCombatSprite(name: string): Surface | null {
  const cached = cache.get(name);
  if (cached !== undefined) return cached;
  if (!pending.has(name)) {
    pending.add(name);
    void load(name);
  }
  return null;
}

let preloadPromise: Promise<void> = Promise.resolve();

/** Resolves once the boot-time preload has finished (harness readiness). */
export function combatSpritesReady(): Promise<void> {
  return preloadPromise;
}

/** Start loading sprites ahead of their first draw. */
export function preloadCombatSprites(names: string[]): Promise<void> {
  preloadPromise = loadAll(names);
  return preloadPromise;
}

function loadAll(names: string[]): Promise<void> {
  const loads: Promise<void>[] = [];
  for (const name of names) {
    if (cache.has(name) || pending.has(name)) continue;
    pending.add(name);
    loads.push(load(name));
  }
  return Promise.all(loads).then(() => undefined);
}

/** True once every named sprite has finished loading (found or not). */
export function combatSpritesSettled(names: string[]): boolean {
  return names.every((name) => cache.has(name));
}

const TEAM_COLORS = ['blue', 'red', 'green', 'purple'];

/** Every sprite the combat presentations draw, for preloading at boot. */
export const COMBAT_UI_SPRITES: string[] = [
  ...['health', 'combat_stats', 'combat_stats_guard', 'combat_gem', 'combat_name_left', 'combat_name_right',
    'combat_main_left', 'combat_main_right', 'combat_main_crit_left', 'combat_main_crit_right', 'guard']
    .flatMap((base) => TEAM_COLORS.map((color) => `${base}_${color}`)),
  'health_bar', 'arrow_advantage', 'full_hp_blip', 'empty_hp_blip', 'overflow_hp_blip', 'overflowpurple_hp_blip',
  ...['red', 'yellow', 'cyan', 'small_red', 'small_yellow', 'small_cyan'].map((color) => `damage_numbers_${color}`),
];
