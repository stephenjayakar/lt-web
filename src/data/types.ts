// ============================================================
// Lex Talionis Web — Game Data Type Interfaces
// Mirrors the JSON serialization formats used by the LT engine.
// ============================================================

/** String identifier used as the universal key type throughout the engine. */
export type NID = string;

// ------------------------------------------------------------------
// Core definitions
// ------------------------------------------------------------------

export interface StatDef {
  nid: NID;
  name: string;
  maximum: number;
  desc: string;
  position: string;
}

export interface EquationDef {
  nid: NID;
  expression: string;
}

export interface WeaponRankDef {
  rank: string;
  requirement: number;
}

export interface WeaponAdvantage {
  weapon_type: NID;
  weapon_rank: string;        // e.g. "All", "S", "A" — which ranks this applies to
  damage: string;
  resist: string;             // defense bonus vs this type
  accuracy: string;
  avoid: string;              // evasion bonus
  crit: string;
  dodge: string;              // crit-avoid bonus
  attack_speed: string;
  defense_speed: string;      // defensive AS bonus
}

export interface WeaponDef {
  nid: NID;
  name: string;
  force_melee_anim: boolean;
  hide_from_display: boolean;
  rank_bonus: any[];          // rank-based bonus entries
  advantage: WeaponAdvantage[];
  disadvantage: WeaponAdvantage[];
  icon_nid: NID;
  icon_index: [number, number];
}

// ------------------------------------------------------------------
// Terrain
// ------------------------------------------------------------------

export interface TerrainDef {
  nid: NID;
  name: string;
  color: [number, number, number];
  minimap: string;
  platform: string;
  background: string;
  mtype: string;
  opaque: boolean;
  status: string | null;
}

// ------------------------------------------------------------------
// Component-based data (items / skills)
// ------------------------------------------------------------------

/** Tuple of [component_nid, value]. */
export type ComponentData = [string, any];

export interface ItemPrefab {
  nid: NID;
  name: string;
  desc: string;
  icon_nid: NID;
  icon_index: [number, number];
  components: [string, any][];
}

export interface SkillPrefab {
  nid: NID;
  name: string;
  desc: string;
  icon_nid: NID;
  icon_index: [number, number];
  components: [string, any][];
}

// ------------------------------------------------------------------
// Classes
// ------------------------------------------------------------------

export interface KlassDef {
  nid: NID;
  name: string;
  desc: string;
  tier: number;
  movement_group: string;
  promotes_from: NID | null;
  turns_into: NID[];
  tags: string[];
  max_level: number;
  bases: Record<string, number>;
  /** Growths used for generic units (and added to unique unit growths when unit_stats_as_bonus is true). */
  growths: Record<string, number>;
  /** Bonus added to unique unit growths during leveling (separate from `growths`). */
  growth_bonus: Record<string, number>;
  promotion: Record<string, number>;
  max_stats: Record<string, number>;
  /** [level, skill_nid] */
  learned_skills: [number, NID][];
  /** [usable, wexp_gain, cap] per weapon type */
  wexp_gain: Record<string, [boolean, number, number]>;
  icon_nid: NID;
  icon_index: [number, number];
  map_sprite_nid: NID;
  combat_anim_nid: NID | null;
  /** Custom user-defined fields (empty in default project). */
  fields: any[];
}

// ------------------------------------------------------------------
// Units
// ------------------------------------------------------------------

export interface UnitPrefab {
  nid: NID;
  name: string;
  desc: string;
  level: number;
  klass: NID;
  tags: string[];
  bases: Record<string, number>;
  growths: Record<string, number>;
  /** [item_nid, is_droppable] */
  starting_items: [NID, boolean][];
  /** [level, skill_nid] */
  learned_skills: [number, NID][];
  /** [usable, wexp_gain, cap] per weapon type */
  wexp_gain: Record<string, [boolean, number, number]>;
  portrait_nid: NID;
  affinity: string;
}

// ------------------------------------------------------------------
// Tilemap / Tilesets
// ------------------------------------------------------------------

export interface TilemapLayerData {
  nid: string;
  visible: boolean;
  foreground: boolean;
  /** key = "x,y" -> terrain NID */
  terrain_grid: Record<string, NID>;
  /** key = "x,y" -> [tileset_nid, [col, row]] */
  sprite_grid: Record<string, [NID, [number, number]]>;
}

export interface TilemapData {
  nid: NID;
  size: [number, number];
  autotile_fps: number;
  layers: TilemapLayerData[];
  tilesets: NID[];
}

export interface TilesetData {
  nid: NID;
  terrain_grid: Record<string, NID>;
  autotiles: Record<string, number>;
}

// ------------------------------------------------------------------
// Levels
// ------------------------------------------------------------------

export interface LevelMusic {
  player_phase: string;
  enemy_phase: string;
  player_battle?: string;
  enemy_battle?: string;
}

export interface LevelObjective {
  simple: string;
  win: string;
  loss: string;
}

export interface UniqueUnitData {
  nid: NID;
  team: string;
  ai: NID;
  ai_group: NID | null;
  starting_position: [number, number] | null;
  generic: false;
}

export interface GenericUnitData {
  nid: NID;
  variant: string | null;
  level: number;
  klass: NID;
  faction: NID;
  /** [item_nid, is_droppable] */
  starting_items: [NID, boolean][];
  starting_skills: NID[];
  team: string;
  ai: NID;
  ai_group: NID | null;
  starting_position: [number, number] | null;
  generic: true;
}

export interface UnitGroupData {
  nid: NID;
  units: NID[];
  positions: Record<NID, [number, number]>;
}

export interface RegionData {
  nid: NID;
  region_type: string;
  position: [number, number];
  size: [number, number];
  sub_nid: string;
  condition: string;
}

export interface LevelPrefab {
  nid: NID;
  name: string;
  tilemap: NID;
  party: NID;
  music: LevelMusic;
  objective: LevelObjective;
  units: (UniqueUnitData | GenericUnitData)[];
  regions: RegionData[];
  unit_groups: UnitGroupData[];
}

// ------------------------------------------------------------------
// Teams / Alliances
// ------------------------------------------------------------------

export interface TeamDef {
  nid: NID;
  map_sprite_palette: string;
}

/** [team_a, team_b] – these two teams are allied. */
export type AlliancePair = [NID, NID];

/** [team_definitions, alliance_pairs] */
export type TeamsData = [TeamDef[], AlliancePair[]];

// ------------------------------------------------------------------
// AI
// ------------------------------------------------------------------

export interface AiBehavior {
  action: string;
  target: string;
  target_spec: string | string[] | null;
  view_range: number;
  invert_targeting: boolean;
  roam_speed: number;
  desired_proximity: number;
  /** Condition expression; empty string = no condition. */
  condition: string;
}

export interface AiDef {
  nid: NID;
  behaviours: AiBehavior[];
  priority: number;
  offense_bias: number;
  roam_ai: boolean;
}

// ------------------------------------------------------------------
// Movement costs
// ------------------------------------------------------------------

/** [grid, terrain_type_nids, movement_group_nids] */
export type McostData = [number[][], string[], string[]];

// ------------------------------------------------------------------
// Difficulty / Constants / Metadata
// ------------------------------------------------------------------

export interface DifficultyMode {
  nid: NID;
  name: string;
  color: string;
  permadeath_choice: string;
  growths_choice: string;
  rng_choice: string;
  player_bases: Record<string, number>;
  enemy_bases: Record<string, number>;
  boss_bases: Record<string, number>;
  player_growths: Record<string, number>;
  enemy_growths: Record<string, number>;
  boss_growths: Record<string, number>;
  player_autolevels: number;
  enemy_autolevels: number;
  boss_autolevels: number;
  promoted_autolevels_fraction: number;
  start_locked: boolean;
}

/** [constant_nid, value] */
export type ConstantDef = [string, boolean | number | string];

export interface ProjectMetadata {
  date: string;
  engine_version: string;
  serialization_version: number;
  project: string;
  as_chunks: boolean;
}

// ------------------------------------------------------------------
// Event system
// ------------------------------------------------------------------

export interface EventPrefab {
  name: string;
  nid: NID;
  trigger: string;
  level_nid: NID | null;
  condition: string;
  only_once: boolean;
  priority: number;
  _source: string[];
}
