// ---------------------------------------------------------------------------
// GameState — Central singleton that holds references to all major subsystems.
// Mirrors LT's `game` god-object from app/engine/game_state.py.
// ---------------------------------------------------------------------------

import type {
  NID,
  LevelPrefab,
  UnitPrefab,
  GenericUnitData,
  UniqueUnitData,
  KlassDef,
  FogOfWarConfig,
  DifficultyMode,
} from '../data/types';
import { DifficultyModeObject } from './difficulty';
import { FRAMETIME } from './constants';
import { Database } from '../data/database';
import { ResourceManager } from '../data/resource-manager';
import { StateMachine } from './state-machine';
import { Camera } from './camera';
import { Cursor } from './cursor';
import { ArrowRenderer } from '../rendering/movement-arrows';
import { UnitMarkerIcons } from '../rendering/unit-markers';
import { PhaseController } from './phase';
import {
  ActionLog,
  RemoveItemFromConvoy,
  RemoveItemFromUnitAction,
  RemoveSkillAction,
  RegisterItemTreeAction,
  SetSkillDataAction,
  type MoveAction,
} from './action';
import { GameBoard } from '../objects/game-board';
import { UnitObject } from '../objects/unit';
import { ItemObject, createItemTree } from '../objects/item';
import { TileMapObject } from '../rendering/tilemap';
import { HighlightManager } from '../rendering/highlight';
import { MapView } from '../rendering/map-view';
import { UnitRenderer } from '../rendering/unit-renderer';
import { PathSystem } from '../pathfinding/path-system';
import { MovementSystem } from '../movement/movement-system';
import { EventManager } from '../events/event-manager';
import { AudioManager } from '../audio/audio-manager';
import { HUD } from '../ui/hud';
import { AIController } from '../ai/ai-controller';
import { SkillObject } from '../objects/skill';
import {
  activeUnitAnimations,
  changeVariant,
  isCantoSkill,
} from '../combat/skill-system';
import { refreshAuras } from '../combat/aura-system';
import { refreshPositionStatuses } from './position-status-system';
import { MapSprite } from '../rendering/map-sprite';
import { MapAnimation } from '../rendering/map-animation';
import { SupportController } from './support-system';
import { InitiativeTracker } from './initiative';
import { PartyObject } from './party';
import type { GameEvent } from '../events/event-manager';
import type { InputManager } from './input';
import type { OverworldManager } from './overworld/overworld-manager';
import type { OverworldMovementManager } from './overworld/overworld-movement';
import { RoamInfo } from './roam-info';
import { Recordkeeper } from './records';
import { GameQueryEngine } from './query-engine';
import { TargetSystem } from './target-system';
import { getStartingClassSkillNids } from './learned-skills';
import { applyItemEndChapterResourceHooks } from '../combat/item-resource-lifecycle';


/**
 * GameState — The god object holding references to every major subsystem
 * and all live game data for the current session.
 */
export class GameState {
  // -- Subsystem references ------------------------------------------------
  db: Database;
  resources: ResourceManager;
  state: StateMachine;
  board: GameBoard | null;
  targetSystem: TargetSystem | null;
  private mapSpriteLoadVersions = new WeakMap<UnitObject, number>();
  camera: Camera;
  cursor: Cursor;
  arrowRenderer: ArrowRenderer;
  unitMarkers: UnitMarkerIcons;
  phase: PhaseController | null;
  highlight: HighlightManager;
  mapView: MapView;
  unitRenderer: UnitRenderer;
  pathSystem: PathSystem | null;
  movementSystem: MovementSystem;
  eventManager: EventManager | null;
  audioManager: AudioManager;
  hud: HUD;
  actionLog: ActionLog;
  aiController: AIController | null;
  supports: SupportController | null;
  initiative: InitiativeTracker | null;

  // -- Game data -----------------------------------------------------------
  units: Map<string, UnitObject>;
  items: Map<string, ItemObject>;
  currentLevel: LevelPrefab | null;
  tilemap: TileMapObject | null;
  /** Optional background tilemap drawn beneath the main one (Python
   * level.bg_tilemap, swapped by change_bg_tilemap). */
  bgTilemap: TileMapObject | null = null;

  /** Runtime team-palette overrides (Python change_team_palette):
   * teamNid -> { palette?, combatColor? }. Consulted ahead of DB team defs. */
  teamPaletteOverrides: Map<string, { palette?: string; combatColor?: string }> = new Map();

  /** Effective map-sprite palette for a team (override ?? DB def). */
  getTeamPalette(teamNid: string): string | undefined {
    return this.teamPaletteOverrides.get(teamNid)?.palette
      ?? this.db.teams.defs.find((t: any) => t.nid === teamNid)?.palette;
  }

  /** Effective combat color for a team (override ?? DB def). */
  getTeamCombatColor(teamNid: string): string {
    return this.teamPaletteOverrides.get(teamNid)?.combatColor
      ?? (this.db.teams.defs.find((t: any) => t.nid === teamNid) as any)?.combatColor
      ?? 'green';
  }
  turnCount: number;
  gameVars: Map<string, any>;
  levelVars: Map<string, any>;
  activeAiGroups: Set<string>;

  // -- Party system -------------------------------------------------------
  parties: Map<string, PartyObject>;
  currentParty: NID;

  // -- Input ----------------------------------------------------------------
  /** Reference to the InputManager, set after construction from main.ts. */
  input: InputManager | null = null;

  // -- Timing ---------------------------------------------------------------
  /** Actual frame delta in ms (set each frame by main loop). */
  frameDeltaMs: number = FRAMETIME;

  // -- Transient state (used by game states) --------------------------------
  selectedUnit: UnitObject | null;
  /** Unit to display in the InfoMenuState. Set before changing to 'info_menu'. */
  infoMenuUnit: UnitObject | null;
  combatTarget: UnitObject | null;
  /** Script tokens for scripted combat (interact_unit). Null for normal combat. */
  combatScript: string[] | null;
  /** Whether the current combat was triggered from an event (interact_unit).
   *  When true, CombatState should NOT push EventState on cleanup. */
  eventCombat: boolean;
  /** Transient shop data (set by shop event command, consumed by ShopState). */
  shopUnit: any | null;
  shopItems: any[] | null;
  shopStock: number[] | null;
  shopId: string | null;
  shopFlavor: string | null;
  currentEvent: GameEvent | null;
  _moveOrigin: [number, number] | null;
  _moveAction: MoveAction | null;
  _pendingAfterMovement: string | null;

  /**
   * Transient memory map for passing data between states.
   * Mirrors Python's game.memory dict. Used by turnwheel (force_turnwheel,
   * event_turnwheel) and other systems.
   */
  memory: Map<string, any>;
  /** Spoken dialog history used by the in-conversation log overlay. */
  dialogLogEntries: Array<{ speaker: string; text: string }>;

  // -- Base screen data -----------------------------------------------------
  /** Base conversations: key=convo NID, value=true if viewed/ignored. */
  baseConvos: Map<string, boolean>;
  /** Market items for base screen: key=item NID, value=stock (-1=infinite). */
  marketItems: Map<string, number>;
  /** Lore entries unlocked in the current playthrough, in unlock order. */
  unlockedLore: string[];

  // -- Difficulty mode -------------------------------------------------------
  /** Runtime difficulty mode for the current session. Null until initialized. */
  currentMode: DifficultyModeObject | null;

  // -- Overworld data -------------------------------------------------------
  /** Active overworld controller (null when not on world map). */
  overworldController: OverworldManager | null;
  /** Overworld movement manager (null when not on world map). */
  overworldMovement: OverworldMovementManager | null;
  /** Persistent overworld registry (survives level transitions). */
  overworldRegistry: Map<string, any>;

  // -- Roam mode ----------------------------------------------------------
  /** Free roam state info (ARPG-style unit control). */
  roamInfo: RoamInfo;

  // -- Records ------------------------------------------------------------
  /** Per-save game statistics (kills, damage, healing, MVP, etc.). */
  records: Recordkeeper;

  // -- Query engine -------------------------------------------------------
  /** Game state query engine for eval contexts. */
  queryEngine: GameQueryEngine;

  // -- Playtime -----------------------------------------------------------
  /** Total playtime in milliseconds across sessions. */
  playtime: number;

  // -- Save slot ----------------------------------------------------------
  /** Current save slot index (-1 if no save loaded). */
  currentSaveSlot: number;

  constructor(db: Database, resources: ResourceManager, audioManager: AudioManager) {
    this.db = db;
    this.resources = resources;
    this.audioManager = audioManager;

    // Subsystems that can be created eagerly
    this.state = new StateMachine();
    this.camera = new Camera();
    this.cursor = new Cursor();
    // Load cursor sprite eagerly (fire-and-forget — falls back to rectangle if it fails)
    // Cursor sprite is an engine-level shared asset at /game-data/sprites/cursor.png
    this.cursor.loadSprite('/game-data/sprites/cursor.png').catch(() => {});
    this.arrowRenderer = new ArrowRenderer();
    this.arrowRenderer.loadSprite('/sprites/movement_arrows.png').catch(() => {});
    this.unitMarkers = new UnitMarkerIcons();
    this.unitMarkers.loadAll().catch(() => {});
    this.highlight = new HighlightManager();
    this.mapView = new MapView();
    this.unitRenderer = new UnitRenderer();
    this.movementSystem = new MovementSystem();
    this.hud = new HUD();
    this.hud.setResourceManager(resources);
    this.actionLog = new ActionLog();

    // Subsystems that depend on level data — null until loadLevel()
    this.board = null;
    this.targetSystem = null;
    this.phase = null;
    this.pathSystem = null;
    // Unlike the other level-scoped subsystems, the EventManager exists from
    // construction: `on_startup` fires before any level loads, and Python
    // plays those events (a logo cutscene in Rekka, persistent-record setup
    // in EotF) before the player reaches the title. loadLevel() replaces this
    // instance with a level-scoped one.
    this.eventManager = new EventManager(this.db.events);
    this.eventManager.actionLog = this.actionLog;
    this.eventManager.setGameGetter(() => this);
    this.aiController = null;
    this.supports = null;
    this.initiative = null;

    // Game data
    this.units = new Map();
    this.items = new Map();
    this.currentLevel = null;
    this.tilemap = null;
    this.bgTilemap = null;
    this.turnCount = 1;
    this.gameVars = new Map();
    this.levelVars = new Map();
    this.activeAiGroups = new Set();

    // Party system
    this.parties = new Map();
    this.currentParty = '';

    // Transient state
    this.selectedUnit = null;
    this.infoMenuUnit = null;
    this.combatTarget = null;
    this.combatScript = null;
    this.eventCombat = false;
    this.shopUnit = null;
    this.shopItems = null;
    this.shopStock = null;
    this.shopId = null;
    this.shopFlavor = null;
    this.currentEvent = null;
    this._moveOrigin = null;
    this._moveAction = null;
    this._pendingAfterMovement = null;
    this.memory = new Map();
    this.dialogLogEntries = [];

    // Base screen data
    this.baseConvos = new Map();
    this.marketItems = new Map();
    this.unlockedLore = [];

    // Difficulty mode
    this.currentMode = null;

    // Overworld
    this.overworldController = null;
    this.overworldMovement = null;
    this.overworldRegistry = new Map();

    // Roam mode
    this.roamInfo = new RoamInfo();

    // Records
    this.records = new Recordkeeper();

    // Query engine
    this.queryEngine = new GameQueryEngine();

    // Playtime
    this.playtime = 0;

    // Save slot
    this.currentSaveSlot = -1;
  }

  // ========================================================================
  // Level cleanup (between chapters)
  // ========================================================================

  /**
   * Persistent units saved from the previous level's cleanUpLevel().
   * These are re-injected into the next level during loadLevel().
   */
  private persistentUnits: Map<string, UnitObject> = new Map();
  private persistentItems: Map<string, ItemObject> = new Map();

  /**
   * Clean up the current level in preparation for the next one.
   * Matches Python's game.clean_up(full=True):
   *   - Remove all units from the board
   *   - Heal all units to full HP
   *   - Drop travelers (rescue)
   *   - Reset unit turn state
   *   - Remove non-persistent units from the registry
   *   - Remove orphaned items/skills
   *   - Clear regions, level vars, etc.
   *   - Preserve persistent units and their items for the next level
   */

  /**
   * Build a runtime TileMapObject for any tilemap nid (loads tilesets and
   * autotiles). Extracted for change_bg_tilemap; loadLevel uses the same
   * loading logic inline.
   */
  /** Set/clear the background tilemap, mirrored onto the renderer. */
  setBgTilemap(tm: TileMapObject | null): void {
    this.bgTilemap = tm;
    this.mapView.bgTilemap = tm;
  }

  async buildTilemapObject(tilemapNid: string): Promise<TileMapObject | null> {
    const tilemapData = this.db.tilemaps.get(tilemapNid);
    if (!tilemapData) return null;
    const tilesetImages = new Map<NID, HTMLImageElement>();
    const autotileImages = new Map<NID, HTMLImageElement>();
    const tilesetDefs = new Map<NID, import('../data/types').TilesetData>();
    await Promise.all(
      tilemapData.tilesets.map(async (tsNid) => {
        const img = await this.resources.tryLoadImage(`resources/tilesets/${tsNid}.png`);
        if (img) tilesetImages.set(tsNid, img);
        const tsDef = this.db.tilesets.get(tsNid);
        if (tsDef) {
          tilesetDefs.set(tsNid, tsDef);
          if (tsDef.autotiles && Object.keys(tsDef.autotiles).length > 0) {
            const autoImg = await this.resources.tryLoadImage(`resources/tilesets/${tsNid}_autotiles.png`);
            if (autoImg) autotileImages.set(tsNid, autoImg);
          }
        }
      }),
    );
    return TileMapObject.fromPrefab(tilemapData, tilesetImages, tilesetDefs, autotileImages);
  }

  /**
   * Run item on_end_chapter hooks before either full or forced chapter cleanup.
   * The current party convoy is checked first, then the runtime owner and
   * current-party inventories, matching EotF's RemoveOnEndChapter component.
   */
  applyItemEndChapterHooks(): number {
    const chapterItems = new Set<ItemObject>(this.items.values());
    for (const unit of this.units.values()) {
      for (const item of unit.items) chapterItems.add(item);
    }
    for (const party of this.parties.values()) {
      for (const item of party.convoy) chapterItems.add(item);
    }
    const resetItems = new Set<ItemObject>();
    const resetItemTree = (item: ItemObject): void => {
      if (resetItems.has(item)) return;
      resetItems.add(item);
      applyItemEndChapterResourceHooks(item);
      for (const child of item.subitems) resetItemTree(child);
    };
    for (const item of [...chapterItems]) resetItemTree(item);

    let removed = 0;
    const party = this.getParty();
    const partyUnits = this.getAllUnitsInParty();
    for (const item of chapterItems) {
      if (!item.hasComponent('remove_on_end_chapter')) continue;
      if (party?.convoy.includes(item)) {
        this.actionLog.doAction(new RemoveItemFromConvoy(item, party.nid));
        removed++;
        continue;
      }
      const owner = item.owner && item.owner.items.includes(item)
        ? item.owner
        : partyUnits.find((unit) => unit.items.includes(item));
      if (owner) {
        this.actionLog.doAction(new RemoveItemFromUnitAction(owner, item));
        removed++;
      }
    }
    return removed;
  }

  /**
   * Run Python skill_system.on_end_chapter hooks in authored component order.
   * Charge resets and temporary-skill removal remain reversible so forced
   * cleanup and turnwheel playback observe the same runtime identity.
   */
  applySkillEndChapterHooks(): { reset: number; removed: number } {
    let reset = 0;
    let removed = 0;
    for (const unit of this.units.values()) {
      for (const skill of [...unit.skills]) {
        for (const [component] of skill.components) {
          if (component === 'build_charge') {
            this.actionLog.doAction(new SetSkillDataAction(skill, 'charge', 0));
            reset++;
          } else if (component === 'visual_charge') {
            this.actionLog.doAction(new SetSkillDataAction(skill, 'charge', 0));
            reset++;
          } else if (component === 'drain_charge' || component === 'charges_per_turn') {
            const total = Number(
              skill.data.get('total_charge') ?? skill.getComponent(component) ?? 0,
            );
            this.actionLog.doAction(new SetSkillDataAction(skill, 'charge', total));
            reset++;
          } else if (
            (
              component === 'time' ||
              component === 'end_time' ||
              component === 'combined_time' ||
              component === 'upkeep_stat_change' ||
              component === 'lost_on_upkeep' ||
              component === 'lost_on_endstep' ||
              component === 'lost_on_end_chapter' ||
              component === 'lost_on_end_combat2'
            ) &&
            unit.skills.includes(skill)
          ) {
            this.actionLog.doAction(new RemoveSkillAction(unit, skill));
            removed++;
          }
        }
      }
    }
    return { reset, removed };
  }

  cleanUpLevel(): void {
    this.applyItemEndChapterHooks();
    this.applySkillEndChapterHooks();

    // Remove all units from the board
    for (const unit of this.units.values()) {
      if (unit.position && this.board) {
        this.board.removeUnit(unit);
      }
    }

    // Per-unit cleanup
    for (const unit of this.units.values()) {
      // Drop rescued units
      if (unit.rescuing) {
        unit.rescuing.rescuedBy = null;
        unit.rescuing = null;
      }
      if (unit.rescuedBy) {
        unit.rescuedBy.rescuing = null;
        unit.rescuedBy = null;
      }
      unit.traveler = null;
      unit.leadUnit = false;
      unit.currentGuardGauge = 0;
      unit.builtGuard = false;
      unit.strikePartner = null;
      unit.skills = unit.skills.filter((skill) =>
        skill.data.get('pairupSourceType') !== 'traveler' &&
        skill.data.get('rescueSourceType') !== 'traveler',
      );

      // Heal to full HP
      unit.currentHp = unit.stats['HP'] ?? unit.currentHp;

      // Clear position (units are off-map between levels)
      unit.position = null;

      // Reset turn state
      unit.resetTurnState();
      unit.finished = false;
      unit.hasAttacked = false;
    }

    // Handle player death: resurrect if permadeath is off
    if (this.currentMode && !this.currentMode.permadeath) {
      for (const unit of this.units.values()) {
        if (unit.team === 'player' && unit.isDead()) {
          unit.dead = false;
          unit.currentHp = unit.stats['HP'] ?? 1;
        }
      }
    }

    // Preserve persistent units (player units) and their items
    this.persistentUnits.clear();
    this.persistentItems.clear();
    for (const [nid, unit] of this.units) {
      if (unit.persistent) {
        this.persistentUnits.set(nid, unit);
        // Preserve their items too
        for (const item of unit.items) {
          const itemKey = `${unit.nid}_${item.nid}_persistent`;
          this.persistentItems.set(itemKey, item);
        }
      }
    }

    // Preserve convoy items from all parties
    for (const party of this.parties.values()) {
      for (const item of party.convoy) {
        const itemKey = `convoy_${party.nid}_${item.uid}_${item.nid}`;
        this.persistentItems.set(itemKey, item);
      }
    }

    // Clear per-level state
    this.units.clear();
    this.items.clear();
    this.activeAiGroups.clear();
    this.levelVars.clear();
    this.highlight.clear();
    this.actionLog.clear();
    this.turnCount = 1;
    this.currentLevel = null;
    this.tilemap = null;
    this.bgTilemap = null;
    this.board = null;
    this.targetSystem = null;
    this.pathSystem = null;
    this.eventManager = null;
    this.aiController = null;
    this.supports = null;
    this.initiative = null;
    this.roamInfo = new RoamInfo();

    // Reset transient state
    this.selectedUnit = null;
    this.infoMenuUnit = null;
    this.combatTarget = null;
    this.combatScript = null;
    this.eventCombat = false;
    this.shopUnit = null;
    this.shopItems = null;
    this.shopStock = null;
    this.shopId = null;
    this.shopFlavor = null;
    this.currentEvent = null;
    this._moveOrigin = null;
    this._moveAction = null;
    this._pendingAfterMovement = null;

    // Reset turnwheel uses
    this.gameVars.set(
      '_current_turnwheel_uses',
      this.gameVars.get('_max_turnwheel_uses') ?? -1,
    );

    console.log(
      `cleanUpLevel: preserved ${this.persistentUnits.size} persistent units, ${this.persistentItems.size} items`,
    );
  }

  // ========================================================================
  // Level loading
  // ========================================================================

  /**
   * Load a level by NID.
   *
   * Steps mirror LT's level-load sequence:
   *   a. Fetch LevelPrefab from db
   *   b. Build tilemap (load tileset images, construct TileMapObject)
   *   c. Create GameBoard and populate terrain
   *   d. Spawn units (unique and generic)
   *   e. Load map sprites for each unit
   *   f. Create PathSystem
   *   g. Create PhaseController with team order
   *   h. Create EventManager from db.events
   *   i. Initialize camera to map size
   *   j. Set up music
   *   k. Trigger 'level_start' event
   */
  async loadLevel(levelNid: string): Promise<void> {
    // a. Get LevelPrefab --------------------------------------------------
    const levelPrefab = this.db.levels.get(levelNid);
    if (!levelPrefab) {
      throw new Error(`GameState.loadLevel: unknown level "${levelNid}"`);
    }
    // Clone the level's mutable containers so runtime mutations (region
    // consumption, etc.) don't leak back into the shared DB prefab object —
    // a later loadLevel() of the same level must start pristine. Units are
    // handled separately below via fresh runtime Unit objects, so they don't
    // need cloning here.
    this.currentLevel = { ...levelPrefab, regions: (levelPrefab.regions ?? []).map((r) => ({ ...r })) };

    // Reset per-level state
    this.units.clear();
    this.items.clear();
    this.activeAiGroups.clear();
    this.levelVars.clear();
    this.highlight.clear();
    this.actionLog.clear();
    this.turnCount = 1;
    this.selectedUnit = null;
    this.infoMenuUnit = null;
    this.combatTarget = null;
    this.combatScript = null;
    this.eventCombat = false;
    this.shopUnit = null;
    this.shopItems = null;
    this.shopStock = null;
    this.shopId = null;
    this.shopFlavor = null;
    this.currentEvent = null;
    this._moveOrigin = null;
    this._moveAction = null;
    this._pendingAfterMovement = null;

    // a2. Initialize parties and set current party from level ----------------
    this.initParties();
    if (levelPrefab.party) {
      this.currentParty = levelPrefab.party;
    }

    // b. Load tilemap ------------------------------------------------------
    const tilemapData = this.db.tilemaps.get(levelPrefab.tilemap);
    if (!tilemapData) {
      throw new Error(
        `GameState.loadLevel: tilemap "${levelPrefab.tilemap}" not found in db`,
      );
    }

    // Load all tileset images and autotile images referenced by this tilemap
    const tilesetImages = new Map<NID, HTMLImageElement>();
    const autotileImages = new Map<NID, HTMLImageElement>();
    const tilesetDefs = new Map<NID, import('../data/types').TilesetData>();
    await Promise.all(
      tilemapData.tilesets.map(async (tsNid) => {
        const img = await this.resources.tryLoadImage(
          `resources/tilesets/${tsNid}.png`,
        );
        if (img) {
          tilesetImages.set(tsNid, img);
        }
        // Load tileset definition for autotile mapping
        const tsDef = this.db.tilesets.get(tsNid);
        if (tsDef) {
          tilesetDefs.set(tsNid, tsDef);
          // Load autotile image if this tileset has autotiles
          if (tsDef.autotiles && Object.keys(tsDef.autotiles).length > 0) {
            const autoImg = await this.resources.tryLoadImage(
              `resources/tilesets/${tsNid}_autotiles.png`,
            );
            if (autoImg) {
              autotileImages.set(tsNid, autoImg);
            }
          }
        }
      }),
    );

    this.tilemap = TileMapObject.fromPrefab(tilemapData, tilesetImages, tilesetDefs, autotileImages);

    // c. Create GameBoard from tilemap ------------------------------------
    this.board = new GameBoard(this.tilemap.width, this.tilemap.height);
    this.board.onUnitPositionChanged = () => this.refreshPositionSkills();
    this.targetSystem = new TargetSystem(this.db, this.board, this);
    this.board.initFromTilemap(this.tilemap);

    // c2. Initialize fog of war grids and opacity grid --------------------
    const teamOrder = this.db.teams.defs.map((t) => t.nid);
    this.board.initFogGrids(teamOrder);
    this.board.initOpacityGrid(this.db);

    // c3. Initialize difficulty mode if not already set -------------------
    this.initDifficulty();

    // d. Spawn units -------------------------------------------------------
    // Track which persistent units were placed on the map in this level
    const placedPersistentUnits = new Set<string>();

    for (const unitData of levelPrefab.units) {
      if (isUniqueUnitData(unitData)) {
        // Check if this unit was persisted from a previous level
        const persistedUnit = this.persistentUnits.get(unitData.nid);
        if (persistedUnit) {
          // Re-use the persistent unit (with its current stats, items, XP)
          // but place it at the new level's position
          const position = unitData.starting_position;
          if (position && this.board) {
            this.board.setUnit(position[0], position[1], persistedUnit);
          } else {
            persistedUnit.position = position;
          }
          persistedUnit.startingPosition = position ? [...position] as [number, number] : null;
          // Preserve runtime team/AI for persistent units (matches Python):
          // recruits and event-driven allegiance changes should carry across
          // chapter transitions instead of being overwritten by level prefab data.
          persistedUnit.resetTurnState();
          persistedUnit.finished = false;
          persistedUnit.hasAttacked = false;
          this.units.set(persistedUnit.nid, persistedUnit);
          // Re-register items
          for (let i = 0; i < persistedUnit.items.length; i++) {
            this.registerItemTreeDirect(
              persistedUnit.items[i],
              `${persistedUnit.nid}_${persistedUnit.items[i].nid}_${i}`,
            );
          }
          placedPersistentUnits.add(unitData.nid);
        } else {
          this.spawnUniqueUnit(unitData);
        }
      } else {
        this.spawnGenericUnit(unitData);
      }
    }

    // d1b. Register remaining persistent units that aren't in this level's unit list
    // (they stay in the registry but off-map, e.g., for convoy access or future levels)
    for (const [nid, unit] of this.persistentUnits) {
      if (!placedPersistentUnits.has(nid) && !this.units.has(nid)) {
        unit.position = null;
        this.units.set(nid, unit);
        // Re-register items
        for (let i = 0; i < unit.items.length; i++) {
          this.registerItemTreeDirect(
            unit.items[i],
            `${unit.nid}_${unit.items[i].nid}_${i}`,
          );
        }
      }
    }
    for (const party of this.parties.values()) {
      party.convoy.forEach((item, index) =>
        this.registerItemTreeDirect(item, `convoy_${party.nid}_${index}_${item.nid}`));
    }

    // Clear the persistent storage now that units have been restored
    this.persistentUnits.clear();
    this.persistentItems.clear();

    // Board placement callbacks run before newly spawned units are registered
    // in `this.units`; converge all source-derived skills after the spawn pass.
    this.refreshPositionSkills();

    // d2. Initialize fog of war vision for all spawned units ----------------
    this.recalculateAllFow();

    // e. Load map sprites for each spawned unit ----------------------------
    await this.loadAllMapSprites();

    // f. Create PathSystem -------------------------------------------------
    this.pathSystem = new PathSystem(this.db, this);

    // g. Create PhaseController (uses teamOrder from step c2) ---------------
    this.phase = new PhaseController(teamOrder);

    // h. Create EventManager -----------------------------------------------
    // Carry over anything already queued. `on_startup` is queued before any
    // level exists, so replacing the manager outright dropped it and the
    // project's startup events never ran.
    const pendingEvents = this.eventManager?.eventQueue ?? [];
    this.eventManager = new EventManager(this.db.events);
    this.eventManager.actionLog = this.actionLog;
    this.eventManager.setGameGetter(() => this);
    if (pendingEvents.length > 0) this.eventManager.eventQueue.push(...pendingEvents);

    // h2. Create AIController -----------------------------------------------
    this.aiController = new AIController(this.db, this.board, this.pathSystem);
    this.aiController.gameRef = this;

    // h3. Create SupportController ------------------------------------------
    this.supports = new SupportController(
      this.db.supportPairs,
      this.db.supportRanks,
      this.db.supportConstants,
      this.db.affinities,
      this,
    );
    this.supports.initPairs();

    // h4. Initialize initiative if enabled ----------------------------------
    if (this.db.getConstant('initiative', false)) {
      this.initiative = new InitiativeTracker();
      const allUnits = this.getAllUnits().filter(u => u.position && !u.isDead());
      this.initiative.start(allUnits, this.db);
    } else {
      this.initiative = null;
    }

    // i. Initialize camera and cursor to map size --------------------------
    this.camera.setMapSize(this.tilemap.width, this.tilemap.height);
    this.camera.forcePosition(0, 0);
    this.cursor.setMapSize(this.tilemap.width, this.tilemap.height);
    this.cursor.setPos(0, 0);

    // j. Set up music ------------------------------------------------------
    if (levelPrefab.music?.player_phase) {
      await this.audioManager.playMusic(levelPrefab.music.player_phase);
    }

    // k2. Set up roam info from level prefab ---------------------------------
    this.roamInfo = new RoamInfo(
      !!(levelPrefab as any).roam,
      (levelPrefab as any).roam_unit ?? null,
    );

    // k. Queue the initial player-phase events -----------------------------
    // Python calls phase_change, turn_change, then level_start from
    // TurnChangeState, but its event stack executes the last trigger first.
    // Our event queue is FIFO, so enqueue level_start first to preserve the
    // authored execution order. EOtF's level_start removes stale Deployed
    // tags and turn_change then restores them for the actual sortie.
    if (this.eventManager) {
      this.levelVars.set('_initial_turn_events_after_level_start', true);
      const eventContext = {
        game: this,
        gameVars: this.gameVars,
        levelVars: this.levelVars,
      };
      this.eventManager.trigger(
        { type: 'level_start', levelNid },
        eventContext,
      );
      this.eventManager.trigger(
        { type: 'phase_change', team: this.phase.getCurrent(), levelNid },
        eventContext,
      );
      this.eventManager.trigger(
        { type: 'turn_change', turnCount: this.turnCount, levelNid },
        eventContext,
      );
    }
  }

  // ========================================================================
  // Change Tilemap (mid-event)
  // ========================================================================

  /**
   * Swap the current level's tilemap to a different one.
   * Used by the `change_tilemap` event command for cutscene backdrops.
   * Removes all units from the map, rebuilds the game board, resets cursor.
   */
  async changeTilemap(tilemapNid: string): Promise<void> {
    const tilemapData = this.db.tilemaps.get(tilemapNid);
    if (!tilemapData) {
      console.warn(`changeTilemap: tilemap "${tilemapNid}" not found`);
      return;
    }

    // Save current unit positions before removing them
    const savedPositions = new Map<string, [number, number]>();
    for (const unit of this.units.values()) {
      if (unit.position) {
        savedPositions.set(unit.nid, [unit.position[0], unit.position[1]]);
        // Remove from board without action log
        if (this.board) this.board.removeUnit(unit);
        else unit.position = null;
      }
    }
    const oldNid = this.tilemap ? this.tilemap.nid : '';
    this.levelVars.set(`_prev_pos_${oldNid}`, savedPositions);

    // Load tileset images for the new tilemap
    const tilesetImages = new Map<string, HTMLImageElement>();
    const autotileImages = new Map<string, HTMLImageElement>();
    const tilesetDefs = new Map<string, import('../data/types').TilesetData>();
    await Promise.all(
      tilemapData.tilesets.map(async (tsNid: string) => {
        const img = await this.resources.tryLoadImage(
          `resources/tilesets/${tsNid}.png`,
        );
        if (img) tilesetImages.set(tsNid, img);
        const tsDef = this.db.tilesets.get(tsNid);
        if (tsDef) {
          tilesetDefs.set(tsNid, tsDef);
          if (tsDef.autotiles && Object.keys(tsDef.autotiles).length > 0) {
            const autoImg = await this.resources.tryLoadImage(
              `resources/tilesets/${tsNid}_autotiles.png`,
            );
            if (autoImg) autotileImages.set(tsNid, autoImg);
          }
        }
      }),
    );

    // Create the new tilemap
    this.tilemap = TileMapObject.fromPrefab(tilemapData, tilesetImages, tilesetDefs, autotileImages);

    // Rebuild game board
    this.board = new GameBoard(this.tilemap.width, this.tilemap.height);
    this.board.onUnitPositionChanged = () => this.refreshPositionSkills();
    this.targetSystem = new TargetSystem(this.db, this.board, this);
    this.board.initFromTilemap(this.tilemap);

    // Reinitialize fog of war grids and opacity
    const teamNids = this.db.teams.defs.map((t) => t.nid);
    this.board.initFogGrids(teamNids);
    this.board.initOpacityGrid(this.db);

    // Reset cursor and camera to new map bounds
    this.cursor.setMapSize(this.tilemap.width, this.tilemap.height);
    this.cursor.setPos(0, 0);
    this.camera.setMapSize(this.tilemap.width, this.tilemap.height);
    this.camera.forcePosition(0, 0);

    // Clear highlights
    this.highlight.clear();
  }

  // ========================================================================
  // AI Group Activation
  // ========================================================================

  /** Check if an AI group is active (empty/null group IDs are always active). */
  isAiGroupActive(groupId: string): boolean {
    return !groupId || groupId === '' || this.activeAiGroups.has(groupId);
  }

  /** Activate an AI group so its members will act on the next AI turn. */
  activateAiGroup(groupId: string): void {
    if (!groupId || groupId === '') return;
    if (this.activeAiGroups.has(groupId)) return;
    this.activeAiGroups.add(groupId);
    console.log(`AI Group activated: ${groupId}`);
  }

  // ========================================================================
  // Win / Loss condition checking
  // ========================================================================

  /**
   * Check if the win condition for the current level is met.
   *
   * LT objectives use string conditions like:
   * - "Rout" / "Defeat All Enemies" — all enemies dead
   * - "Defeat Boss" / "Kill Boss" — boss unit dead
   * - "Seize" — player unit standing on a seize region
   * - "Survive" — survive for X turns (handled by turn counter)
   * - "Escape" — all player units escaped
   *
   * Returns true if the win condition is met.
   */
  checkWinCondition(): boolean {
    if (!this.currentLevel?.objective) return false;
    const win = this.currentLevel.objective.win.toLowerCase();

    // Rout: all enemy units dead
    if (win.includes('rout') || win.includes('defeat all')) {
      const enemies = this.board?.getTeamUnits('enemy') ?? [];
      const livingEnemies = enemies.filter((u) => !u.isDead());
      return livingEnemies.length === 0;
    }

    // Defeat boss: any unit tagged 'boss' on the enemy team is dead
    if (win.includes('boss')) {
      for (const unit of this.units.values()) {
        if (
          unit.team === 'enemy' &&
          unit.tags.includes('Boss') &&
          !unit.isDead()
        ) {
          return false;
        }
      }
      // If we had at least one boss and they're all dead
      let hadBoss = false;
      for (const unit of this.units.values()) {
        if (unit.team === 'enemy' && unit.tags.includes('Boss')) {
          hadBoss = true;
          break;
        }
      }
      return hadBoss;
    }

    // Seize: a player unit is on a 'seize' region (region_type === 'event', sub_nid === 'Seize')
    if (win.includes('seize')) {
      if (this.currentLevel.regions) {
        for (const region of this.currentLevel.regions) {
          if (region.region_type.toLowerCase() === 'event' && region.sub_nid === 'Seize') {
            const [rx, ry] = region.position;
            const [rw, rh] = region.size;
            for (let tx = rx; tx < rx + rw; tx++) {
              for (let ty = ry; ty < ry + rh; ty++) {
                const unit = this.board?.getUnit(tx, ty);
                if (unit && unit.team === 'player') {
                  return true;
                }
              }
            }
          }
        }
      }
      return false;
    }

    // Survive X turns: parse turn count from condition
    if (win.includes('survive')) {
      const match = win.match(/(\d+)/);
      if (match) {
        const targetTurns = parseInt(match[1], 10);
        return this.turnCount > targetTurns;
      }
    }

    return false;
  }

  /**
   * Check if the loss condition for the current level is met.
   *
   * Common loss conditions:
   * - "Eirika dies" / "{unit} dies" — specific unit is dead
   * - Any player unit dies (permadeath loss)
   * - Lord dies
   *
   * Returns true if the loss condition is met (game over).
   */
  checkLossCondition(): boolean {
    if (!this.currentLevel?.objective) return false;
    const loss = this.currentLevel.objective.loss.toLowerCase();

    // Check for specific unit death: "{name} dies"
    const dieMatch = loss.match(/(\w+)\s+dies/);
    if (dieMatch) {
      const unitName = dieMatch[1];
      for (const unit of this.units.values()) {
        if (
          unit.team === 'player' &&
          (unit.name.toLowerCase() === unitName.toLowerCase() ||
           unit.nid.toLowerCase() === unitName.toLowerCase()) &&
          unit.isDead()
        ) {
          return true;
        }
      }
    }

    // Lord dies: any unit tagged 'Lord' on the player team is dead
    if (loss.includes('lord')) {
      for (const unit of this.units.values()) {
        if (
          unit.team === 'player' &&
          unit.tags.includes('Lord') &&
          unit.isDead()
        ) {
          return true;
        }
      }
    }

    // All player units dead
    if (loss.includes('all') &&
        (loss.includes('die') || loss.includes('dead') || loss.includes('defeated'))) {
      const playerUnits = this.board?.getTeamUnits('player') ?? [];
      const living = playerUnits.filter((u) => !u.isDead());
      return living.length === 0;
    }

    // Default: check if any unit tagged 'Lord' died (standard FE behavior)
    for (const unit of this.units.values()) {
      if (
        unit.team === 'player' &&
        unit.tags.includes('Lord') &&
        unit.isDead()
      ) {
        return true;
      }
    }

    return false;
  }

  // ========================================================================
  // Difficulty Mode
  // ========================================================================

  /**
   * Initialize the difficulty mode for the current session.
   * If currentMode is already set (e.g., loaded from save), does nothing.
   * Otherwise, creates a DifficultyModeObject from the first available
   * difficulty mode in the database.
   */
  initDifficulty(): void {
    if (this.currentMode) return;
    if (this.db.difficultyModes.length > 0) {
      this.currentMode = DifficultyModeObject.fromPrefab(this.db.difficultyModes[0]);
    }
  }

  /**
   * Get the DB prefab for the current difficulty mode.
   * Returns null if no difficulty mode is set.
   */
  get mode(): DifficultyMode | null {
    if (!this.currentMode) return null;
    return this.db.difficultyModes.find(m => m.nid === this.currentMode!.nid) ?? null;
  }

  /**
   * Get all team NIDs that are allied with 'player'.
   * Includes 'player' itself plus any teams linked via alliance pairs.
   */
  getAlliedTeams(): string[] {
    const allied = ['player'];
    for (const [a, b] of this.db.teams.alliances) {
      if (a === 'player' && !allied.includes(b)) allied.push(b);
      if (b === 'player' && !allied.includes(a)) allied.push(a);
    }
    return allied;
  }

  // ========================================================================
  // Fog of War
  // ========================================================================

  /**
   * Get the current fog of war configuration from level variables.
   * Port of LT's game_state.get_current_fog_info().
   */
  getCurrentFogInfo(): FogOfWarConfig {
    const aiRadius = (this.levelVars.get('_ai_fog_of_war_radius') ??
      this.levelVars.get('_fog_of_war_radius') ?? 0) as number;
    return {
      isActive: (this.levelVars.get('_fog_of_war') ?? false) as boolean,
      mode: (this.levelVars.get('_fog_of_war_type') ?? 1) as number,
      defaultRadius: (this.levelVars.get('_fog_of_war_radius') ?? 0) as number,
      aiRadius,
      otherRadius: (this.levelVars.get('_other_fog_of_war_radius') ?? aiRadius) as number,
    };
  }

  /**
   * Recalculate fog of war vision for all units on the board.
   * Called after fog configuration changes (enable/disable/set).
   */
  recalculateAllFow(): void {
    if (!this.board) return;
    const fogInfo = this.getCurrentFogInfo();
    for (const unit of this.units.values()) {
      if (unit.position && !unit.isDead()) {
        const radius = this.board.getFogOfWarRadius(unit, fogInfo, this.db);
        this.board.updateFow(unit, unit.position, radius);
      } else {
        this.board.clearUnitFow(unit);
      }
    }
  }

  // ========================================================================
  // Unit queries
  // ========================================================================

  /** Get all living units in the registry. */
  getAllUnits(): UnitObject[] {
    return Array.from(this.units.values());
  }

  /** Get all living units belonging to a specific team. */
  getTeamUnits(team: string): UnitObject[] {
    const result: UnitObject[] = [];
    for (const unit of this.units.values()) {
      if (unit.team === team && !unit.isDead()) {
        result.push(unit);
      }
    }
    return result;
  }

  /** Get a unit by NID, or null if not found. */
  getUnit(nid: string): UnitObject | null {
    return this.units.get(nid) ?? null;
  }

  /** Python item_registry lookup by stable numeric UID. */
  getItem(itemUid: number | string): ItemObject | null {
    const uid = Number(itemUid);
    if (!Number.isFinite(uid)) return null;
    for (const item of new Set(this.items.values())) {
      if (item.uid === uid) return item;
    }
    return null;
  }

  /** Register a new recursive item tree through the reversible action log. */
  registerItem(item: ItemObject): void {
    if ([...this.items.values()].includes(item)) return;
    this.actionLog.doAction(
      new RegisterItemTreeAction(this.items, item, `item_${item.uid}_${item.nid}`),
    );
  }

  /** Register an already-owned tree during deterministic construction/load. */
  registerItemTreeDirect(item: ItemObject, key: string): void {
    this.items.set(key, item);
    item.subitems.forEach((child, index) =>
      this.registerItemTreeDirect(child, `${key}_sub_${index}_${child.nid}`));
  }

  /** Python-facing aliases used by raw PYEV1 event code. */
  get_item(itemUid: number | string): ItemObject | null {
    return this.getItem(itemUid);
  }

  register_item(item: ItemObject): void {
    this.registerItem(item);
  }

  get item_registry(): {
    get: (uid: number | string) => ItemObject | null;
    values: () => IterableIterator<ItemObject>;
  } {
    return {
      get: (uid) => this.getItem(uid),
      values: () => new Set(this.items.values()).values(),
    };
  }

  // ========================================================================
  // Party system
  // ========================================================================

  /** Get a party by NID (defaults to current party). Auto-creates if missing. */
  getParty(partyNid?: string | null): PartyObject | null {
    const nid = partyNid || this.currentParty;
    if (!nid) return null;
    if (!this.parties.has(nid)) {
      this._buildParty(nid);
    }
    return this.parties.get(nid) ?? null;
  }

  /** Create a party from DB prefab data. */
  private _buildParty(partyNid: string): void {
    const prefab = this.db.parties.get(partyNid);
    if (prefab) {
      this.parties.set(partyNid, new PartyObject(prefab.nid, prefab.name, prefab.leader));
    } else {
      // Fall back to first party in DB
      const firstParty = this.db.parties.values().next().value;
      if (firstParty) {
        this.parties.set(partyNid, new PartyObject(firstParty.nid, firstParty.name, firstParty.leader));
      }
    }
  }

  /** Initialize all parties from DB. Called during game initialization. */
  initParties(): void {
    for (const prefab of this.db.parties.values()) {
      if (!this.parties.has(prefab.nid)) {
        this.parties.set(prefab.nid, new PartyObject(prefab.nid, prefab.name, prefab.leader));
      }
    }
    // Set current party to first party if not set
    if (!this.currentParty && this.db.parties.size > 0) {
      this.currentParty = this.db.parties.values().next().value?.nid ?? '';
    }
  }

  /** Get all living units in a party. */
  getUnitsInParty(partyNid?: string): UnitObject[] {
    const nid = partyNid || this.currentParty;
    const result: UnitObject[] = [];
    for (const unit of this.units.values()) {
      if (unit.team === 'player' && unit.party === nid && !unit.isDead()) {
        result.push(unit);
      }
    }
    return result;
  }

  /** Get all units in a party including dead ones. */
  getAllUnitsInParty(partyNid?: string): UnitObject[] {
    const nid = partyNid || this.currentParty;
    const result: UnitObject[] = [];
    for (const unit of this.units.values()) {
      if (unit.team === 'player' && unit.party === nid) {
        result.push(unit);
      }
    }
    return result;
  }

  /** Get the current party's money. */
  getMoney(): number {
    return this.getParty()?.money ?? 0;
  }

  /** Get the current party's BEXP. */
  getBexp(): number {
    return this.getParty()?.bexp ?? 0;
  }

  // ========================================================================
  // Unit spawning / removal
  // ========================================================================

  /**
   * Spawn a unit from a UnitPrefab and place it on the board.
   *
   * @param prefab   The unit template from the database.
   * @param team     Team NID (e.g. 'player', 'enemy').
   * @param position Starting tile position, or null for off-map.
   * @param ai       AI behaviour NID.
   * @returns        The created UnitObject.
   */
  spawnUnit(
    prefab: UnitPrefab,
    team: string,
    position: [number, number] | null,
    ai: NID,
  ): UnitObject {
    const unit = this.buildUnit(prefab, team, ai);
    this.registerUnit(unit, position);
    return unit;
  }

  /**
   * Construct a UnitObject from a prefab (equips starting items/skills,
   * autoequips) WITHOUT registering it into `this.units` or placing it on
   * the board. Split out from spawnUnit() so callers that need reversible
   * registration (e.g. the `create_unit` event command) can wrap the
   * registration step in an undoable action while construction itself
   * (which has no observable side effects on shared state) happens eagerly.
   */
  buildUnit(prefab: UnitPrefab, team: string, ai: NID): UnitObject {
    const klassDef = this.db.classes.get(prefab.klass);
    if (!klassDef) {
      throw new Error(
        `GameState.buildUnit: unknown class "${prefab.klass}" for unit "${prefab.nid}"`,
      );
    }

    const unit = new UnitObject(prefab, klassDef);
    unit.team = team;
    unit.ai = ai;

    // Equip starting items
    for (const entry of prefab.starting_items) {
      const itemNid = entry[0];
      const isDroppable = entry[1] ?? false;
      const itemPrefab = this.db.items.get(itemNid);
      if (itemPrefab) {
        const item = createItemTree(itemPrefab, (nid) => this.db.items.get(nid));
        item.owner = unit;
        item.droppable = isDroppable;
        unit.items.push(item);
        unit.onAddItem(item);
        this.registerItemTreeDirect(item, `${unit.nid}_${item.nid}_${unit.items.length}`);
      }
    }

    // Python UnitObject creates every DB-wide Global skill before personal and
    // class skills. These mechanic-level skills must exist on newly built
    // generics and uniques alike.
    for (const skillPrefab of this.db.skills.values()) {
      if (!skillPrefab.components.some(([nid]) => nid === 'global')) continue;
      const skill = new SkillObject(skillPrefab);
      skill.data.set('sourceType', 'global');
      skill.data.set('sourceNid', 'game');
      unit.skills.push(skill);
      if (isCantoSkill(skill)) unit.hasCanto = true;
    }

    // Equip starting skills from learned_skills (tuples of [requiredLevel, skillNid])
    if (prefab.learned_skills) {
      for (const [requiredLevel, skillNid] of prefab.learned_skills) {
        // Only equip skills the unit has reached the level for
        if (unit.level < requiredLevel) continue;
        const skillPrefab = this.db.skills.get(skillNid);
        if (skillPrefab) {
          const skill = new SkillObject(skillPrefab);
          unit.skills.push(skill);

          // Check for canto
          if (isCantoSkill(skill)) {
            unit.hasCanto = true;
          }
        }
      }
    }

    // Autoequip after starting items/skills are populated (Python UnitObject.__init__).
    unit.autoequip();
    return unit;
  }

  /**
   * Register a constructed unit into `this.units` and place it on the
   * board (or leave it off-map if `position` is null). Mirrors the tail
   * end of spawnUnit(); split out so it can be re-run by an undoable
   * action's execute()/reverse() pair (see CreateUnitAction).
   */
  registerUnit(unit: UnitObject, position: [number, number] | null): void {
    // Place on board
    if (position && this.board) {
      this.board.setUnit(position[0], position[1], unit);
    } else {
      unit.position = position;
    }

    // Record starting position for Defend AI / return-home
    unit.startingPosition = position ? [...position] as [number, number] : null;

    // Set party for player units if not already assigned
    if (!unit.party && unit.team === 'player') {
      unit.party = this.currentParty;
    }

    this.units.set(unit.nid, unit);
    this.refreshPositionSkills();
  }

  /**
   * Remove a unit from the board and the unit registry.
   */
  removeUnit(nid: string): void {
    const unit = this.units.get(nid);
    if (!unit) return;

    if (this.board) {
      this.board.removeUnit(unit);
    }

    this.units.delete(nid);
  }

  /**
   * Recompute aura coverage (skills granted by `aura` skill components) for
   * every unit on the board, adding/removing child skills as needed. Wired
   * to `board.onUnitPositionChanged` so it runs after any unit arrives,
   * leaves, moves, or is removed (mirrors Python's `game.arrive`/
   * `game.leave` aura hooks, but as a full recompute rather than an
   * incremental per-tile registry). Also safe to call after save/load
   * restoration to re-derive aura coverage from scratch.
   */
  refreshAuras(): void {
    if (!this.board) return;
    refreshAuras(this.units.values(), this.board, this.db);
  }

  /** Re-derive all position-sourced skills after any board registry change. */
  refreshPositionSkills(): void {
    if (!this.board) return;
    refreshPositionStatuses(this.units.values(), this.board, this.db, this);
    this.refreshAuras();
  }

  /** Rebuild derived, looping UnitAnim overlays without persisting them. */
  syncSkillMapAnimations(): void {
    if (!this.tilemap) return;
    const desired = new Map<string, { unit: UnitObject; nid: string }>();
    for (const unit of this.units.values()) {
      if (!unit.position || unit.isDead()) continue;
      for (const entry of activeUnitAnimations(unit, this)) {
        desired.set(entry.key, { unit, nid: entry.nid });
      }
    }
    this.tilemap.highAnimations = this.tilemap.highAnimations.filter(
      (animation: MapAnimation) =>
        !animation.skillAnimationKey || desired.has(animation.skillAnimationKey),
    );
    const existing = new Set(
      this.tilemap.highAnimations
        .map((animation: MapAnimation) => animation.skillAnimationKey)
        .filter((key: string | null): key is string => !!key),
    );
    for (const [key, entry] of desired) {
      if (existing.has(key) || !entry.unit.position) continue;
      const prefab = this.db.mapAnimations.get(entry.nid);
      if (!prefab) continue;
      const animation = new MapAnimation(
        prefab,
        entry.unit.position[0],
        entry.unit.position[1],
        { loop: true },
      );
      animation.skillAnimationKey = key;
      animation.followUnit = entry.unit;
      this.tilemap.highAnimations.push(animation);
      void this.resources.loadImage(`resources/animations/${entry.nid}.png`)
        .then((image) => animation.setImage(image))
        .catch(() => {
          animation.done = true;
          console.warn(`UnitAnim: no sprite sheet for "${entry.nid}"`);
        });
    }
  }

  // ========================================================================
  // Internal helpers
  // ========================================================================

  /**
   * Spawn a unique unit from level data.
   * Unique units reference a UnitPrefab in db.units by NID.
   *
   * Difficulty bonuses applied:
   *   - Base stat bonuses added to unit stats
   *   - (Unique units do NOT get difficulty autolevels — they use
   *     difficulty_auto_level which is growth-bonus-only, handled separately)
   */
  spawnUniqueUnit(data: UniqueUnitData): void {
    const prefab = this.db.units.get(data.nid);
    if (!prefab) {
      console.warn(`GameState: unique unit prefab "${data.nid}" not found in db`);
      return;
    }
    const unit = this.spawnUnit(prefab, data.team, data.starting_position, data.ai);
    if (data.ai_group) unit.aiGroup = data.ai_group;

    // Apply difficulty base bonuses
    this.applyDifficultyBaseBonuses(unit);
  }

  /**
   * Spawn a generic unit from level data.
   * Generic units are defined inline with class, level, items, etc.
   *
   * Matches the Python behaviour:
   *   1. Name is resolved from the faction definition (not the NID).
   *   2. Stats start from class bases.
   *   3. Auto-leveling is applied using the FIXED growth method
   *      (deterministic, matching Python's default for enemies).
   */
  spawnGenericUnit(data: GenericUnitData): void {
    // Build a synthetic UnitPrefab from the generic data
    const klassDef = this.db.classes.get(data.klass);
    if (!klassDef) {
      console.warn(
        `GameState: class "${data.klass}" not found for generic unit "${data.nid}"`,
      );
      return;
    }

    // Resolve display name from faction (Python: GenericUnit.name -> DB.factions.get(self.faction).name)
    let displayName = data.variant || data.nid;
    if (data.faction) {
      const faction = this.db.factions.get(data.faction);
      if (faction) {
        displayName = data.variant || faction.name;
      }
    }

    // Convert generic starting_skills (NID[]) to learned_skills format ([level, NID][])
    const learnedSkills: [number, string][] = (data.starting_skills ?? []).map(
      (skillNid) => [1, skillNid] as [number, string],
    );

    const syntheticPrefab: UnitPrefab = {
      nid: data.nid,
      name: displayName,
      desc: '',
      level: data.level,
      klass: data.klass,
      tags: [],
      bases: { ...klassDef.bases },
      growths: { ...klassDef.growths },
      starting_items: data.starting_items,
      learned_skills: learnedSkills,
      wexp_gain: klassDef.wexp_gain,
      portrait_nid: '',
      affinity: '',
    };

    const unit = this.spawnUnit(syntheticPrefab, data.team, data.starting_position, data.ai);
    unit.generic = true;
    unit.variant = data.variant ?? null;
    unit.faction = data.faction || null;
    const unitFaction = data.faction ? this.db.factions.get(data.faction) : null;
    if (unitFaction) unit.desc = unitFaction.desc ?? '';
    if (data.ai_group) unit.aiGroup = data.ai_group;

    // Generic units are NOT persistent across levels (Python: self.persistent = False)
    unit.persistent = false;

    // Python creates generic class skills before autoleveling. `Feat` entries
    // resolve through the shared growth RNG when generic_feats is enabled.
    for (const skillNid of getStartingClassSkillNids(unit, 0, this)) {
      const skillPrefab = this.db.skills.get(skillNid);
      if (!skillPrefab) continue;
      const skill = new SkillObject(skillPrefab);
      unit.skills.push(skill);
      if (isCantoSkill(skill)) unit.hasCanto = true;
    }

    // Auto-level: apply FIXED growth-based stat increases.
    // Python: num_levels = self.level - 1 for tier 0/1 base classes
    const numLevels = this.getAutoLevelCount(data.level, klassDef);
    if (numLevels > 0) {
      autoLevelFixed(unit, 1, numLevels, klassDef);
    }

    // Apply difficulty bonuses (base stats + autolevels)
    this.applyDifficultyBaseBonuses(unit);
    this.applyDifficultyAutolevels(unit, klassDef);
  }

  /**
   * Compute the number of auto-level iterations for a generic unit.
   * Matches Python's logic from unit.py lines 274-278:
   *   tier 0: level - 1
   *   tier 1: level
   *   tier 2+: level + sum(max_level of promote chain back to tier 1)
   *
   * For simplicity we use: level - 1 for tier <= 1, and for tier >= 2 we
   * add the max_level of the immediate promotes_from class.
   */
  private getAutoLevelCount(unitLevel: number, klassDef: KlassDef): number {
    if (klassDef.tier <= 1) {
      return unitLevel - 1;
    }
    // Promoted class: internal level includes levels from previous tier
    let baseLevels = 0;
    if (klassDef.promotes_from) {
      const baseClass = this.db.classes.get(klassDef.promotes_from);
      if (baseClass) {
        baseLevels = baseClass.max_level ?? 20;
      }
    }
    return unitLevel + baseLevels - 1;
  }

  /**
   * Apply difficulty base stat bonuses to a unit.
   * Called after spawning to add stat adjustments from the current difficulty mode.
   */
  private applyDifficultyBaseBonuses(unit: UnitObject): void {
    if (!this.currentMode) return;
    const prefab = this.mode;
    if (!prefab) return;

    const alliedTeams = this.getAlliedTeams();
    const baseBonus = this.currentMode.getBaseBonus(unit, alliedTeams, prefab);
    if (!baseBonus) return;

    for (const [stat, bonus] of Object.entries(baseBonus)) {
      if (bonus !== 0 && unit.stats[stat] !== undefined) {
        const maxStat = unit.getStatCap(stat);
        unit.stats[stat] = Math.min(maxStat, Math.max(0, unit.stats[stat] + bonus));
      }
    }

    // Update HP if it was adjusted
    if (baseBonus['HP'] && baseBonus['HP'] > 0) {
      unit.currentHp = unit.stats['HP'] ?? unit.currentHp;
    }
  }

  /**
   * Apply difficulty autolevels to a generic unit.
   * Difficulty autolevels grant extra FIXED-method level-ups beyond
   * the unit's normal level. Also applies "true levels" which increase
   * the displayed level without stat gains.
   */
  private applyDifficultyAutolevels(unit: UnitObject, klassDef: KlassDef): void {
    if (!this.currentMode) return;
    const prefab = this.mode;
    if (!prefab) return;

    const alliedTeams = this.getAlliedTeams();
    const extraLevels = this.currentMode.getDifficultyAutolevels(unit, alliedTeams, prefab);

    if (extraLevels > 0) {
      // Apply promoted_autolevels_fraction for promoted units
      let effectiveLevels = extraLevels;
      if (klassDef.tier >= 2 && prefab.promoted_autolevels_fraction !== undefined) {
        effectiveLevels = Math.round(extraLevels * prefab.promoted_autolevels_fraction);
      }

      if (effectiveLevels > 0) {
        // Use the unit's current level as the base for additional auto-leveling
        autoLevelFixed(unit, unit.level, effectiveLevels, klassDef);
      }
    }

    // Apply true levels (display only — increase level without stat gains)
    const trueLevels = this.currentMode.getDifficultyTruelevels(unit, alliedTeams);
    if (trueLevels > 0) {
      unit.level += trueLevels;
    }
  }

  /**
   * Load map sprites for every unit currently in the registry.
   * The sprite NID comes from the unit's class definition.
   *
   * If a sprite fails to load, the unit's `sprite` remains null and
   * the renderer draws a colored placeholder rectangle instead (see
   * MapView.drawUnits and UnitRenderer.drawPlaceholder).
   */
  async loadAllMapSprites(): Promise<void> {
    const loadPromises: Promise<void>[] = [];
    // Cache loaded sprites by (spriteNid + teamPalette) to avoid redundant loads
    // when multiple units of the same class/team need the same sprite.
    const spriteCache = new Map<string, ReturnType<typeof MapSprite.fromImages>>();

    for (const unit of this.units.values()) {
      loadPromises.push(this.loadMapSpriteForUnit(unit, spriteCache));
    }

    await Promise.all(loadPromises);
  }

  /** Load one unit's effective variant, falling back to its class base sprite. */
  async loadMapSpriteForUnit(
    unit: UnitObject,
    spriteCache: Map<string, ReturnType<typeof MapSprite.fromImages>> = new Map(),
  ): Promise<void> {
    const loadVersion = (this.mapSpriteLoadVersions.get(unit) ?? 0) + 1;
    this.mapSpriteLoadVersions.set(unit, loadVersion);
    const klassDef = this.db.classes.get(unit.klass);
    const baseNid = klassDef?.map_sprite_nid;
    if (!baseNid) {
      console.warn(
        `GameState.loadMapSpriteForUnit: class "${unit.klass}" has no map sprite for "${unit.nid}"`,
      );
      return;
    }
    const variant = changeVariant(unit, this);
    const requestedNid = variant ? `${baseNid}${variant}` : baseNid;
    const teamPalette = this.getTeamPalette(unit.team) ?? undefined;
    const autogenerateGray = this.db.getConstant('autogenerate_grey_map_sprites', false);
    const cacheKey = `${requestedNid}__${teamPalette ?? ''}__${autogenerateGray}`;
    if (spriteCache.has(cacheKey)) {
      if (this.mapSpriteLoadVersions.get(unit) === loadVersion) {
        unit.sprite = spriteCache.get(cacheKey) ?? null;
      }
      return;
    }
    let selectedNid = requestedNid;
    let sprites = await this.resources.tryLoadMapSprite(requestedNid);
    if (!sprites.stand && requestedNid !== baseNid) {
      selectedNid = baseNid;
      sprites = await this.resources.tryLoadMapSprite(baseNid);
    }
    const mapSprite = MapSprite.fromImages(
      sprites.stand,
      sprites.move,
      teamPalette,
      autogenerateGray,
    );
    if (mapSprite) mapSprite.resourceNid = selectedNid;
    else {
      console.warn(
        `GameState.loadMapSpriteForUnit: sprite "${requestedNid}" failed for "${unit.nid}"`,
      );
    }
    spriteCache.set(cacheKey, mapSprite);
    if (this.mapSpriteLoadVersions.get(unit) === loadVersion) {
      unit.sprite = mapSprite;
    }
  }
}

// ============================================================================
// Auto-leveling (FIXED growth method)
// ============================================================================

/**
 * Apply deterministic FIXED-mode auto-leveling to a unit.
 *
 * Matches Python's `_fixed_levelup` from unit_funcs.py lines 109-126:
 *   For each stat, for each pseudo-level from baseLevel to baseLevel+numLevels-1:
 *     - growth >= 100 => guaranteed +1 per 100
 *     - remainder: compute (50 + remainder * level) % 100;
 *       if result < remainder => +1
 *
 * This creates a perfectly deterministic, evenly-spaced level-up pattern.
 *
 * @param unit       The unit to level up (stats are modified in-place).
 * @param baseLevel  Starting pseudo-level (usually 1).
 * @param numLevels  Number of levels to auto-apply.
 * @param klassDef   Class definition for growth_bonus and max_stats.
 */
function autoLevelFixed(
  unit: UnitObject,
  baseLevel: number,
  numLevels: number,
  klassDef: import('../data/types').KlassDef,
): void {
  const totalGains: Record<string, number> = {};
  for (const stat of Object.keys(unit.stats)) {
    totalGains[stat] = 0;
  }

  for (let i = 0; i < numLevels; i++) {
    const level = baseLevel + i;
    for (const stat of Object.keys(unit.growths)) {
      // Total growth = unit growths (which are class growths for generics) + class growth_bonus
      let growth = (unit.growths[stat] ?? 0) + (klassDef.growth_bonus?.[stat] ?? 0);
      let gained = 0;

      // Guaranteed gains for growth >= 100
      if (growth >= 100) {
        gained += Math.floor(growth / 100);
        growth = growth % 100;
      }

      // Fractional part: deterministic sawtooth
      if (growth > 0) {
        const growthInc = (50 + growth * level) % 100;
        if (growthInc < growth) {
          gained += 1;
        }
      }

      if (totalGains[stat] !== undefined) {
        totalGains[stat] += gained;
      }
    }
  }

  // Apply gains, clamped to [0, max_stats]
  for (const stat of Object.keys(totalGains)) {
    const maxStat = unit.getStatCap(stat);
    const currentVal = unit.stats[stat] ?? 0;
    const maxGain = Math.max(0, maxStat - currentVal);
    const gain = Math.min(totalGains[stat], maxGain);
    if (gain > 0) {
      unit.stats[stat] = currentVal + gain;
    }
  }

  // Reset HP to full after auto-leveling
  unit.currentHp = unit.stats['HP'] ?? unit.currentHp;
}

// ============================================================================
// Type guards
// ============================================================================

/**
 * Discriminate between UniqueUnitData and GenericUnitData.
 * The actual data uses an explicit `generic` boolean flag.
 */
function isUniqueUnitData(
  data: UniqueUnitData | GenericUnitData,
): data is UniqueUnitData {
  return (data as any).generic !== true;
}

// ============================================================================
// Module-level singleton
// ============================================================================

/** The active GameState singleton. Undefined until initGameState() is called. */
export let game: GameState;

/**
 * Create and install the global GameState singleton.
 * Call once at application startup after the Database has been loaded.
 */
export function initGameState(
  db: Database,
  resources: ResourceManager,
  audioManager: AudioManager,
): GameState {
  game = new GameState(db, resources, audioManager);
  return game;
}
