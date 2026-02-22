/**
 * Database — Loads all game design data from .ltproj/game_data/.
 * This is the equivalent of LT's DB singleton.
 *
 * Data files fall into two categories:
 *   - Non-chunked: a single JSON file (e.g. game_data/constants.json)
 *   - Chunked: a directory with an .orderkeys file listing NID keys,
 *     and one <key>.json file per entry (e.g. game_data/items/.orderkeys, game_data/items/Iron_Sword.json)
 */

import { ResourceManager } from './resource-manager';
import type {
  StatDef,
  WeaponDef,
  TerrainDef,
  ItemPrefab,
  SkillPrefab,
  KlassDef,
  UnitPrefab,
  LevelPrefab,
  AiDef,
  ConstantDef,
  EventPrefab,
  TilemapData,
  TilesetData,
  WeaponRankDef,
  DifficultyMode,
  NID,
  EquationDef,
  McostData,
  TeamsData,
} from './types';
import type { CombatAnimData, CombatEffectData, PaletteData } from '../combat/battle-anim-types';
import { loadCombatAnims, loadCombatEffects, loadCombatPalettes } from './loaders/combat-anim-loader';

export class Database {
  // Non-chunked data
  constants: Map<string, boolean | number | string> = new Map();
  stats: StatDef[] = [];
  equations: Map<string, string> = new Map();
  weaponRanks: WeaponRankDef[] = [];
  weapons: WeaponDef[] = [];
  terrain: Map<NID, TerrainDef> = new Map();
  mcost: { grid: number[][]; terrainTypes: string[]; unitTypes: string[] } = {
    grid: [],
    terrainTypes: [],
    unitTypes: [],
  };
  teams: { defs: { nid: string; palette: string }[]; alliances: [string, string][] } = {
    defs: [],
    alliances: [],
  };
  ai: Map<NID, AiDef> = new Map();
  difficultyModes: DifficultyMode[] = [];
  tags: string[] = [];

  // Chunked data
  items: Map<NID, ItemPrefab> = new Map();
  skills: Map<NID, SkillPrefab> = new Map();
  classes: Map<NID, KlassDef> = new Map();
  units: Map<NID, UnitPrefab> = new Map();
  levels: Map<NID, LevelPrefab> = new Map();
  events: Map<NID, EventPrefab> = new Map();

  // Resources
  tilemaps: Map<NID, TilemapData> = new Map();
  tilesets: Map<NID, TilesetData> = new Map();

  // Combat animation data
  combatAnims: Map<string, CombatAnimData> = new Map();
  combatEffects: Map<string, CombatEffectData> = new Map();
  combatPalettes: Map<string, PaletteData> = new Map();

  /**
   * Load the entire database from the .ltproj served by the given ResourceManager.
   * Non-chunked files are loaded in parallel first, then chunked data,
   * then tilemap/tileset resources (which may depend on level data).
   */
  async load(resources: ResourceManager): Promise<void> {
    // Phase 1: all non-chunked data in parallel
    const nonChunkedResults = await Promise.allSettled([
      this.loadConstants(resources),
      this.loadStats(resources),
      this.loadEquations(resources),
      this.loadWeaponRanks(resources),
      this.loadWeapons(resources),
      this.loadTerrain(resources),
      this.loadMcost(resources),
      this.loadTeams(resources),
      this.loadTags(resources),
      this.loadAi(resources),
      this.loadDifficultyModes(resources),
    ]);

    for (const result of nonChunkedResults) {
      if (result.status === 'rejected') {
        console.warn('Database: non-chunked loader failed:', result.reason);
      }
    }

    // Phase 2: chunked data in parallel
    const chunkedResults = await Promise.allSettled([
      this.loadChunked<ItemPrefab>(resources, 'items', this.items),
      this.loadChunked<SkillPrefab>(resources, 'skills', this.skills),
      this.loadChunked<KlassDef>(resources, 'classes', this.classes),
      this.loadChunked<UnitPrefab>(resources, 'units', this.units),
      this.loadChunked<LevelPrefab>(resources, 'levels', this.levels),
      this.loadChunked<EventPrefab>(resources, 'events', this.events),
    ]);

    for (const result of chunkedResults) {
      if (result.status === 'rejected') {
        console.warn('Database: chunked loader failed:', result.reason);
      }
    }

    // Phase 3: tilemap & tileset resources + combat animations (all independent)
    const phase3Results = await Promise.allSettled([
      this.loadTilemaps(resources),
      this.loadTilesets(resources),
      this.loadCombatAnimData(resources),
    ]);
    for (const result of phase3Results) {
      if (result.status === 'rejected') {
        console.warn('Database: phase 3 loader failed:', result.reason);
      }
    }
  }

  /** Load all combat animation data (anims, effects, palettes) in parallel. */
  private async loadCombatAnimData(resources: ResourceManager): Promise<void> {
    const [anims, effects, palettes] = await Promise.all([
      loadCombatAnims(resources),
      loadCombatEffects(resources),
      loadCombatPalettes(resources),
    ]);
    this.combatAnims = anims;
    this.combatEffects = effects;
    this.combatPalettes = palettes;
  }

  // -------------------------------------------------------------------
  // Non-chunked loaders
  // -------------------------------------------------------------------

  /**
   * constants.json is an array of [key, value] tuples.
   */
  private async loadConstants(resources: ResourceManager): Promise<void> {
    const data = await resources.tryLoadJson<ConstantDef[]>('game_data/constants.json');
    if (!data) return;

    for (const [key, value] of data) {
      this.constants.set(key, value);
    }
  }

  /**
   * stats.json is an array of StatDef objects.
   */
  private async loadStats(resources: ResourceManager): Promise<void> {
    const data = await resources.tryLoadJson<StatDef[]>('game_data/stats.json');
    if (!data) return;
    this.stats = data;
  }

  /**
   * equations.json is an array of EquationDef objects ({ nid, expression }).
   */
  private async loadEquations(resources: ResourceManager): Promise<void> {
    const data = await resources.tryLoadJson<EquationDef[]>('game_data/equations.json');
    if (!data) return;

    for (const eq of data) {
      this.equations.set(eq.nid, eq.expression);
    }
  }

  /**
   * weapon_ranks.json is an array of WeaponRankDef objects.
   */
  private async loadWeaponRanks(resources: ResourceManager): Promise<void> {
    const data = await resources.tryLoadJson<WeaponRankDef[]>('game_data/weapon_ranks.json');
    if (!data) return;
    this.weaponRanks = data;
  }

  /**
   * weapons.json (a.k.a. weapon_types.json) is an array of WeaponDef objects.
   */
  private async loadWeapons(resources: ResourceManager): Promise<void> {
    // LT may use either "weapons.json" or "weapon_types.json"
    let data = await resources.tryLoadJson<WeaponDef[]>('game_data/weapons.json');
    if (!data) {
      data = await resources.tryLoadJson<WeaponDef[]>('game_data/weapon_types.json');
    }
    if (!data) return;
    this.weapons = data;
  }

  /**
   * terrain.json is an array of TerrainDef objects.
   */
  private async loadTerrain(resources: ResourceManager): Promise<void> {
    const data = await resources.tryLoadJson<TerrainDef[]>('game_data/terrain.json');
    if (!data) return;

    for (const t of data) {
      this.terrain.set(t.nid, t);
    }
  }

  /**
   * mcost.json is a tuple: [grid[][], terrain_type_nids[], movement_group_nids[]]
   */
  private async loadMcost(resources: ResourceManager): Promise<void> {
    const data = await resources.tryLoadJson<McostData>('game_data/mcost.json');
    if (!data) return;

    const [grid, terrainTypes, unitTypes] = data;
    this.mcost = { grid, terrainTypes, unitTypes };
  }

  /**
   * teams.json is a tuple: [TeamDef[], AlliancePair[]]
   * where TeamDef = { nid, map_sprite_palette } and AlliancePair = [nid, nid].
   */
  private async loadTeams(resources: ResourceManager): Promise<void> {
    const data = await resources.tryLoadJson<TeamsData>('game_data/teams.json');
    if (!data) return;

    const [defs, alliances] = data;
    this.teams = {
      defs: defs.map((d) => ({ nid: d.nid, palette: d.map_sprite_palette })),
      alliances: alliances ?? [],
    };
  }

  /**
   * tags.json is an array of strings.
   */
  private async loadTags(resources: ResourceManager): Promise<void> {
    const data = await resources.tryLoadJson<string[]>('game_data/tags.json');
    if (!data) return;
    this.tags = data;
  }

  /**
   * ai.json is an array of AiDef objects.
   */
  private async loadAi(resources: ResourceManager): Promise<void> {
    const data = await resources.tryLoadJson<AiDef[]>('game_data/ai.json');
    if (!data) return;

    for (const def of data) {
      this.ai.set(def.nid, def);
    }
  }

  /**
   * difficulty_modes.json is an array of DifficultyMode objects.
   */
  private async loadDifficultyModes(resources: ResourceManager): Promise<void> {
    const data = await resources.tryLoadJson<DifficultyMode[]>('game_data/difficulty_modes.json');
    if (!data) return;
    this.difficultyModes = data;
  }

  // -------------------------------------------------------------------
  // Chunked data loader
  // -------------------------------------------------------------------

  /**
   * Load chunked data from game_data/<type>/.
   *
   * The directory contains:
   *   - .orderkeys  — JSON array of NID strings defining load order
   *   - <nid>.json  — one file per entry
   *
   * Entries are loaded in parallel and inserted into the given Map
   * in the order specified by .orderkeys.
   */
  private async loadChunked<T extends { nid: NID }>(
    resources: ResourceManager,
    type: string,
    target: Map<NID, T>,
  ): Promise<void> {
    const orderKeys = await resources.tryLoadJson<string[]>(
      `game_data/${type}/.orderkeys`,
    );
    if (!orderKeys) {
      console.warn(`Database: no .orderkeys for chunked type "${type}"`);
      return;
    }

    // Load all chunks in parallel
    // LT serialises each chunk as a single-element array: [{...}]
    const entries = await Promise.all(
      orderKeys.map(async (key) => {
        const raw = await resources.tryLoadJson<T | T[]>(
          `game_data/${type}/${key}.json`,
        );
        // Unwrap the array if present
        const data: T | null = raw
          ? (Array.isArray(raw) ? (raw as T[])[0] ?? null : raw)
          : null;
        return { key, data };
      }),
    );

    // Insert in order, preserving .orderkeys ordering in the Map
    for (const { key, data } of entries) {
      if (data && (data as any).nid !== undefined) {
        target.set((data as any).nid, data);
      } else if (data) {
        // Fallback: use the orderkey as the nid
        target.set(key as NID, data);
      } else {
        console.warn(`Database: missing chunk game_data/${type}/${key}.json`);
      }
    }
  }

  // -------------------------------------------------------------------
  // Tilemap & Tileset loaders
  // -------------------------------------------------------------------

  /**
   * Load tilemap data for every tilemap referenced by loaded levels.
   * Tilemap JSON files live at resources/tilemaps/<nid>.json
   */
  private async loadTilemaps(resources: ResourceManager): Promise<void> {
    // Collect all unique tilemap NIDs referenced by levels
    const tilemapNids = new Set<string>();
    for (const level of this.levels.values()) {
      if (level.tilemap) {
        tilemapNids.add(level.tilemap);
      }
    }

    if (tilemapNids.size === 0) return;

    const results = await Promise.all(
      [...tilemapNids].map(async (nid) => {
        // LT stores tilemap data at resources/tilemaps/tilemap_data/<nid>.json
        // NIDs may contain spaces but filenames use underscores.
        const fileNid = nid.replace(/ /g, '_');

        let raw: TilemapData | TilemapData[] | null = null;

        // Try the most likely paths first (tilemap_data subdir with underscore),
        // using silent probing to avoid noisy console warnings for expected misses.
        const candidates = [
          `resources/tilemaps/tilemap_data/${fileNid}.json`,
          `resources/tilemaps/tilemap_data/${nid}.json`,
          `resources/tilemaps/${fileNid}.json`,
          `resources/tilemaps/${nid}.json`,
        ];

        for (const path of candidates) {
          raw = await resources.tryLoadJsonSilent<TilemapData | TilemapData[]>(path);
          if (raw) break;
        }

        // Unwrap array if present (LT wraps all data in single-element arrays)
        const data: TilemapData | null = raw
          ? (Array.isArray(raw) ? (raw as TilemapData[])[0] ?? null : raw)
          : null;

        return { nid, data };
      }),
    );

    for (const { nid, data } of results) {
      if (data) {
        this.tilemaps.set(nid, data);
      } else {
        console.warn(`Database: tilemap data not found for "${nid}"`);
      }
    }
  }

  /**
   * Load tileset metadata.
   * tilesets.json is an array of TilesetData objects stored at
   * resources/tilesets/tilesets.json.
   */
  private async loadTilesets(resources: ResourceManager): Promise<void> {
    const data = await resources.tryLoadJson<TilesetData[]>(
      'resources/tilesets/tilesets.json',
    );
    if (!data) return;

    for (const ts of data) {
      this.tilesets.set(ts.nid, ts);
    }
  }

  // -------------------------------------------------------------------
  // Convenience accessors
  // -------------------------------------------------------------------

  /** Get a constant value by key, or a default if missing. */
  getConstant<T extends boolean | number | string>(key: string, defaultValue: T): T {
    const val = this.constants.get(key);
    if (val === undefined) return defaultValue;
    return val as T;
  }

  /** Get a stat definition by NID. */
  getStat(nid: NID): StatDef | undefined {
    return this.stats.find((s) => s.nid === nid);
  }

  /** Get an equation expression by NID. */
  getEquation(nid: NID): string | undefined {
    return this.equations.get(nid);
  }

  /** Get terrain movement cost for a given terrain type and unit movement group. */
  getMovementCost(terrainType: string, movementGroup: string): number {
    const tIdx = this.mcost.terrainTypes.indexOf(terrainType);
    const uIdx = this.mcost.unitTypes.indexOf(movementGroup);
    if (tIdx < 0 || uIdx < 0) return 99; // impassable by default
    // Grid layout: grid[terrainTypeIndex][movementGroupIndex]
    return this.mcost.grid[tIdx]?.[uIdx] ?? 99;
  }

  /** Check if two teams are allied. */
  areAllied(teamA: string, teamB: string): boolean {
    if (teamA === teamB) return true;
    return this.teams.alliances.some(
      ([a, b]) => (a === teamA && b === teamB) || (a === teamB && b === teamA),
    );
  }
}
