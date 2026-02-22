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
  ItemPrefab,
} from '../data/types';
import { Database } from '../data/database';
import { ResourceManager } from '../data/resource-manager';
import { StateMachine } from './state-machine';
import { Camera } from './camera';
import { Cursor } from './cursor';
import { PhaseController } from './phase';
import { ActionLog } from './action';
import { GameBoard } from '../objects/game-board';
import { UnitObject } from '../objects/unit';
import { ItemObject } from '../objects/item';
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
import { MapSprite } from '../rendering/map-sprite';
import type { GameEvent } from '../events/event-manager';
import type { InputManager } from './input';

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
  camera: Camera;
  cursor: Cursor;
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

  // -- Game data -----------------------------------------------------------
  units: Map<string, UnitObject>;
  items: Map<string, ItemObject>;
  currentLevel: LevelPrefab | null;
  tilemap: TileMapObject | null;
  turnCount: number;
  gameVars: Map<string, any>;
  levelVars: Map<string, any>;
  activeAiGroups: Set<string>;

  // -- Input ----------------------------------------------------------------
  /** Reference to the InputManager, set after construction from main.ts. */
  input: InputManager | null = null;

  // -- Transient state (used by game states) --------------------------------
  selectedUnit: UnitObject | null;
  combatTarget: UnitObject | null;
  currentEvent: GameEvent | null;
  _moveOrigin: [number, number] | null;
  _pendingAfterMovement: string | null;

  constructor(db: Database, resources: ResourceManager, audioManager: AudioManager) {
    this.db = db;
    this.resources = resources;
    this.audioManager = audioManager;

    // Subsystems that can be created eagerly
    this.state = new StateMachine();
    this.camera = new Camera();
    this.cursor = new Cursor();
    // Load cursor sprite eagerly (fire-and-forget — falls back to rectangle if it fails)
    this.cursor.loadSprite('/sprites/cursor.png').catch(() => {});
    this.highlight = new HighlightManager();
    this.mapView = new MapView();
    this.unitRenderer = new UnitRenderer();
    this.movementSystem = new MovementSystem();
    this.hud = new HUD();
    this.hud.setResourceManager(resources);
    this.actionLog = new ActionLog();

    // Subsystems that depend on level data — null until loadLevel()
    this.board = null;
    this.phase = null;
    this.pathSystem = null;
    this.eventManager = null;
    this.aiController = null;

    // Game data
    this.units = new Map();
    this.items = new Map();
    this.currentLevel = null;
    this.tilemap = null;
    this.turnCount = 1;
    this.gameVars = new Map();
    this.levelVars = new Map();
    this.activeAiGroups = new Set();

    // Transient state
    this.selectedUnit = null;
    this.combatTarget = null;
    this.currentEvent = null;
    this._moveOrigin = null;
    this._pendingAfterMovement = null;
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
    this.currentLevel = levelPrefab;

    // Reset per-level state
    this.units.clear();
    this.items.clear();
    this.activeAiGroups.clear();
    this.levelVars.clear();
    this.highlight.clear();
    this.actionLog.clear();
    this.turnCount = 1;
    this.selectedUnit = null;
    this.combatTarget = null;
    this.currentEvent = null;
    this._moveOrigin = null;
    this._pendingAfterMovement = null;

    // b. Load tilemap ------------------------------------------------------
    const tilemapData = this.db.tilemaps.get(levelPrefab.tilemap);
    if (!tilemapData) {
      throw new Error(
        `GameState.loadLevel: tilemap "${levelPrefab.tilemap}" not found in db`,
      );
    }

    // Load all tileset images referenced by this tilemap
    const tilesetImages = new Map<NID, HTMLImageElement>();
    await Promise.all(
      tilemapData.tilesets.map(async (tsNid) => {
        const img = await this.resources.tryLoadImage(
          `resources/tilesets/${tsNid}.png`,
        );
        if (img) {
          tilesetImages.set(tsNid, img);
        }
      }),
    );

    this.tilemap = TileMapObject.fromPrefab(tilemapData, tilesetImages);

    // c. Create GameBoard from tilemap ------------------------------------
    this.board = new GameBoard(this.tilemap.width, this.tilemap.height);
    this.board.initFromTilemap(this.tilemap);

    // d. Spawn units -------------------------------------------------------
    for (const unitData of levelPrefab.units) {
      if (isUniqueUnitData(unitData)) {
        this.spawnUniqueUnit(unitData);
      } else {
        this.spawnGenericUnit(unitData);
      }
    }

    // e. Load map sprites for each spawned unit ----------------------------
    await this.loadAllMapSprites();

    // f. Create PathSystem -------------------------------------------------
    this.pathSystem = new PathSystem(this.db);

    // g. Create PhaseController --------------------------------------------
    const teamOrder = this.db.teams.defs.map((t) => t.nid);
    this.phase = new PhaseController(teamOrder);

    // h. Create EventManager -----------------------------------------------
    this.eventManager = new EventManager(this.db.events);

    // h2. Create AIController -----------------------------------------------
    this.aiController = new AIController(this.db, this.board, this.pathSystem);

    // i. Initialize camera and cursor to map size --------------------------
    this.camera.setMapSize(this.tilemap.width, this.tilemap.height);
    this.camera.forcePosition(0, 0);
    this.cursor.setMapSize(this.tilemap.width, this.tilemap.height);
    this.cursor.setPos(0, 0);

    // j. Set up music ------------------------------------------------------
    if (levelPrefab.music?.player_phase) {
      await this.audioManager.playMusic(levelPrefab.music.player_phase);
    }

    // k. Trigger 'level_start' event ---------------------------------------
    if (this.eventManager) {
      this.eventManager.trigger(
        { type: 'level_start', levelNid },
        { game: this, gameVars: this.gameVars, levelVars: this.levelVars },
      );
    }
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
    if (loss.includes('all') && loss.includes('die')) {
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
    const klassDef = this.db.classes.get(prefab.klass);
    if (!klassDef) {
      throw new Error(
        `GameState.spawnUnit: unknown class "${prefab.klass}" for unit "${prefab.nid}"`,
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
        const item = new ItemObject(itemPrefab);
        item.owner = unit;
        item.droppable = isDroppable;
        unit.items.push(item);
        this.items.set(`${unit.nid}_${item.nid}_${unit.items.length}`, item);
      }
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
          if (skill.hasComponent('canto')) {
            unit.hasCanto = true;
          }
        }
      }
    }

    // Place on board
    if (position && this.board) {
      this.board.setUnit(position[0], position[1], unit);
    } else {
      unit.position = position;
    }

    // Record starting position for Defend AI / return-home
    unit.startingPosition = position ? [...position] as [number, number] : null;

    this.units.set(unit.nid, unit);
    return unit;
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

  // ========================================================================
  // Internal helpers
  // ========================================================================

  /**
   * Spawn a unique unit from level data.
   * Unique units reference a UnitPrefab in db.units by NID.
   */
  spawnUniqueUnit(data: UniqueUnitData): void {
    const prefab = this.db.units.get(data.nid);
    if (!prefab) {
      console.warn(`GameState: unique unit prefab "${data.nid}" not found in db`);
      return;
    }
    const unit = this.spawnUnit(prefab, data.team, data.starting_position, data.ai);
    if (data.ai_group) unit.aiGroup = data.ai_group;
  }

  /**
   * Spawn a generic unit from level data.
   * Generic units are defined inline with class, level, items, etc.
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

    // Convert generic starting_skills (NID[]) to learned_skills format ([level, NID][])
    const learnedSkills: [number, string][] = (data.starting_skills ?? []).map(
      (skillNid) => [1, skillNid] as [number, string],
    );

    const syntheticPrefab: UnitPrefab = {
      nid: data.nid,
      name: data.variant || data.nid,
      desc: '',
      level: data.level,
      klass: data.klass,
      tags: [],
      bases: klassDef.bases,
      growths: klassDef.growths,
      starting_items: data.starting_items,
      learned_skills: learnedSkills,
      wexp_gain: klassDef.wexp_gain,
      portrait_nid: '',
      affinity: '',
    };

    const unit = this.spawnUnit(syntheticPrefab, data.team, data.starting_position, data.ai);
    if (data.ai_group) unit.aiGroup = data.ai_group;
  }

  /**
   * Load map sprites for every unit currently in the registry.
   * The sprite NID comes from the unit's class definition.
   */
  private async loadAllMapSprites(): Promise<void> {
    const loadPromises: Promise<void>[] = [];

    for (const unit of this.units.values()) {
      const klassDef = this.db.classes.get(unit.klass);
      if (!klassDef) continue;

      const spriteNid = klassDef.map_sprite_nid;
      if (!spriteNid) continue;

      // Look up team palette for coloring (enemy=red, other=green, etc.)
      const teamDef = this.db.teams.defs.find(t => t.nid === unit.team);
      const teamPalette = teamDef?.palette ?? undefined;

      loadPromises.push(
        this.resources.tryLoadMapSprite(spriteNid).then((sprites) => {
          // Construct a proper MapSprite from the loaded images.
          // MapSprite.fromImages handles null move images gracefully.
          // Pass teamPalette to recolor from blue to the unit's team color.
          const mapSprite = MapSprite.fromImages(sprites.stand, sprites.move, teamPalette);
          unit.sprite = mapSprite;
        }),
      );
    }

    await Promise.all(loadPromises);
  }
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
