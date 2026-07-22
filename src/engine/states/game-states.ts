/**
 * game-states.ts - All game states for the Lex Talionis web engine.
 *
 * Each state class extends State or MapState and plugs into the
 * stack-based StateMachine.  A lazily-resolved `game` reference
 * provides access to the shared game context (camera, cursor, board,
 * units, tilemap, mapView, etc.) without creating circular imports.
 */

import { State, MapState, type StateResult } from '../state';
import type { GameState } from '../game-state';
import { Surface } from '../surface';
import type { InputEvent } from '../input';
import {
  WINWIDTH,
  WINHEIGHT,
  TILEWIDTH,
  TILEHEIGHT,
  FRAMETIME,
  COLORKEY,
} from '../constants';
import { viewport, isSmallScreen } from '../viewport';

import type { UnitObject } from '../../objects/unit';
import type { ItemObject } from '../../objects/item';
import type {
  RegionData,
  DifficultyMode,
  UnitGroupData,
  UniqueUnitData,
  GenericUnitData,
} from '../../data/types';
import { ItemObject as ItemObjectClass, createItemTree } from '../../objects/item';
import { SkillObject } from '../../objects/skill';
import { evaluateCondition, evaluateExpression, type ConditionContext, type GameEvent, type EventCommand } from '../../events/event-manager';
import { MapSprite as MapSpriteClass } from '../../rendering/map-sprite';
import {
  MarkActionGroupStart,
  MoveAction,
  MarkActionGroupEnd,
  MarkPhase,
  LockTurnwheel,
  MessageAction,
  SetGameVarAction,
  PromoteAction,
  ClassChangeAction,
  GainWexpAction,
  SetWexpAction,
  SetUnitLevelAction,
  ResurrectAction,
  AddLoreAction,
  RemoveLoreAction,
  AutoLevelAction,
  AddSkillAction,
  SetUnitAttributeAction,
  ChangeFactionAction,
  ChangeUnitRecordAction,
  SetUnitFieldAction,
  ChangeUnitNoteAction,
  ChangeItemTextAction,
  SetItemDroppableAction,
  UpdateRecordsAction,
  SetItemDataAction,
  SetItemUsesAction,
  GiveItemAction,
  PutItemInConvoy,
  StoreItemAction,
  TakeItemFromConvoy,
  MoveItemBetweenUnitsAction,
  MoveItemBetweenConvoysAction,
  RemoveItemFromUnitAction,
  RemoveItemFromConvoy,
  AddSubItemAction,
  RemoveSubItemAction,
  HealAction,
  WeaponUsesAction,
  SetCurrentHpAction,
  SetCurrentManaAction,
  GainExpAction,
  DeathAction,
  SetUnitExpAction,
  HasAttackedAction,
  TradeAction,
  HasTradedAction,
  WaitAction,
  ResetAllAction,
  ProcessStatusEffectsAction,
  GainMoneyAction,
  GiveBexpAction,
  ApplyStatChangesAction,
  RemoveSkillAction,
  RefreshUnitAction,
  WarpUnitAction,
  RescueAction,
  DropAction,
  PairUpAction,
  SwitchPairUpAction,
  TransferPairUpAction,
  GuardPairUpkeepAction,
  SeparatePairUpAction,
  RemovePartnerAction,
  EquipItemAction,
  BringToTopItemAction,
  AddRegionAction,
  RemoveRegionAction,
  CreateUnitAction,
  SetLevelVarAction,
  SetGameBoardBoundsAction,
  SetSkillDataAction,
  AddObjComponentAction,
  ModifyObjComponentAction,
  RemoveObjComponentAction,
  RecruitGenericAction,
  MergePartiesAction,
  SetUnitPartyAction,
  ChangeFatigueAction,
  LeaveMapAction,
  ArriveOnMapAction,
  AddAnimToUnitAction,
  RemoveAnimFromUnitAction,
  ChangeBgTilemapAction,
  ChangeTeamPaletteAction,
  ChangeRoamAiAction,
  ChangeTeamAction,
  IncrementSupportPointsAction,
  UnlockSupportRankAction,
  DisableSupportRankAction,
  MoveInInitiativeAction,
  AddToInitiativeAction,
  EnableOverworldElementAction,
  MoveOverworldEntityAction,
  CreateOverworldEntityAction,
  RemoveOverworldEntityAction,
  DisableOverworldEntityAction,
  SetOverworldMenuOptionAction,
  UpdatePersistentStoreAction,
  SetRoamInfoAction,
} from '../action';

import { ChoiceMenu, type MenuOption } from '../../ui/menu';
import { DifficultyModeObject } from '../difficulty';
export { InfoMenuState, setInfoMenuGameRef } from './info-menu-state';
import { Banner } from '../../ui/banner';
import { Dialog } from '../../ui/dialog';
import { ExpBar as ExpBarClass, LevelUpScreen as LevelUpScreenClass } from '../../ui/exp-display';
import { EventPortrait } from '../../events/event-portrait';
import { parseScreenPosition } from '../../events/screen-positions';
import { MapCombat, type CombatResults } from '../../combat/map-combat';
import {
  queueAfterInitiatedCombatEvents,
  applyCombatItemEndHooks,
  queueCombatItemEvents,
  applyDroppableItemPickups,
} from '../../combat/combat-lifecycle';
import { internalLevel } from '../../combat/combat-components';
import { supplyAvailableOnMap } from './supply-state';
import { MapAnimation } from '../../rendering/map-animation';
import { computeArrowSegments } from '../../rendering/movement-arrows';
import type { FogRenderConfig } from '../../rendering/map-view';
import { drawItemIcon } from '../../ui/icons';
import { AnimationCombat, type AnimationCombatRenderState, type AnimationCombatOwner } from '../../combat/animation-combat';
import { BattleAnimation as RealBattleAnimation, type BattleAnimDrawData } from '../../combat/battle-animation';
import { evaluateEquation, getEquippedWeapon, isMagic } from '../../combat/combat-calcs';
import {
  isRepairableItem,
  numTargets,
  allowSameTarget,
  allowLessThanMaxTargets,
  stealItemRestrict,
  available as itemAvailable,
  computeTargetIcon,
  fullPrice as itemFullPrice,
  buyPrice as itemBuyPrice,
  sellPrice as itemSellPrice,
} from '../../combat/item-system';
import {
  ignoreForcedMovement,
  expMultiplier,
  enemyExpMultiplier,
  wexpMultiplier,
  enemyWexpMultiplier,
  isCantoSkill,
} from '../../combat/skill-system';
import { loadBattlePlatforms, loadAndConvertWeaponAnim, selectPalette, selectWeaponAnim } from '../../combat/sprite-loader';
import { handleBaseEventCommand } from './base-state';
import { RECORDS, ACHIEVEMENTS } from '../records';
import { saveGame as doSaveGame, suspendGame as doSuspendGame, hasSuspend, loadSaveSlots } from '../save';
import { getStartingClassSkillNids } from '../learned-skills';
import { reportUnimplemented } from '../strict-mode';

// ---------------------------------------------------------------------------
// Lazy game reference — set once at bootstrap to break circular deps.
// The `any` type is intentional: game-states.ts and game-state.ts would
// form a circular import if we typed this as GameState. The property names
// are validated at build time via the integration in main.ts.
// ---------------------------------------------------------------------------

let _game: any = null;
export function setGameRef(g: any): void {
  _game = g;
}
function getGame(): any {
  if (!_game) throw new Error('Game reference not set. Call setGameRef() first.');
  return _game;
}

/** Get the board, throwing a clear error if no level is loaded. */
function getBoard(): any {
  const game = getGame();
  if (!game.board) {
    throw new Error('No level loaded — game.board is null. Ensure loadLevel() completes before entering gameplay states.');
  }
  return game.board;
}

/** Match LT's Bool event validator. Invalid values remain invalid. */
function parseEventBool(value: string | undefined): boolean | null {
  if (value === undefined) return null;
  const normalized = value.trim().toLowerCase();
  if (['t', 'true', '1', 'y', 'yes'].includes(normalized)) return true;
  if (['f', 'false', '0', 'n', 'no'].includes(normalized)) return false;
  return null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract terrain defense and avoid bonuses from a terrain's status skill.
 * The terrain's `status` field references a skill NID. That skill's
 * components contain `stat_change` (for DEF) and `avoid` (for AVO).
 */
// Terrain bonuses imported from shared utility
import { getTerrainBonuses } from '../../combat/terrain-bonuses';

/**
 * Active combat animation offsets, set by CombatState so that
 * collectVisibleUnits can apply lunge/shake to the fighting sprites.
 */
let _activeCombatOffsets: {
  attacker: UnitObject;
  defender: UnitObject;
  attackerOffset: [number, number]; // pixel offsets
  defenderOffset: [number, number];
  defenderOffsets?: Map<UnitObject, [number, number]>;
} | null = null;

export function setActiveCombatOffsets(
  offsets: typeof _activeCombatOffsets,
): void {
  _activeCombatOffsets = offsets;
}

/** Collect units for map-view rendering from the game board. */
function collectVisibleUnits(): {
  x: number;
  y: number;
  /** Sub-tile visual offset in tile units for movement interpolation. */
  visualOffsetX: number;
  visualOffsetY: number;
  sprite: any;
  team: string;
  finished: boolean;
  currentHp: number;
  maxHp: number;
  specialTag: 'Boss' | 'Elite' | 'Protect' | null;
  travelerCombatColor: string | null;
  droppable: boolean;
}[] {
  const game = getGame();
  if (!game.board) return [];
  const allUnits: UnitObject[] = game.board.getAllUnits();
  const currentTeam = game.phase.getCurrent();
  const result: {
    x: number;
    y: number;
    visualOffsetX: number;
    visualOffsetY: number;
    sprite: any;
    team: string;
    finished: boolean;
    currentHp: number;
    maxHp: number;
    specialTag: 'Boss' | 'Elite' | 'Protect' | null;
    travelerCombatColor: string | null;
    droppable: boolean;
  }[] = [];

  for (const u of allUnits) {
    if (u.isDead() || !u.position) continue;

    // Update sprite state: gray for finished units on the active team only.
    // Units from other teams should never appear greyed out.
    // In initiative mode, non-current-initiative units appear greyed.
    // (moving state is set by the movement system)
    if (u.sprite && typeof u.sprite === 'object' && 'state' in u.sprite) {
      const spr = u.sprite as { state: string };
      if (spr.state !== 'moving') {
        let showGray = u.finished && u.team === currentTeam;
        // Initiative mode: grey out units that aren't the current initiative unit
        if (game.initiative) {
          const initNid = game.initiative.getCurrentUnitNid();
          if (initNid && u.nid !== initNid && u.team === currentTeam) {
            showGray = true;
          }
        }
        spr.state = showGray ? 'gray' : 'standing';
      }
    }

    // Get smooth movement interpolation offset (in tile units)
    const moveOffset = game.movementSystem.getVisualOffset(u);
    let visualOffsetX = moveOffset ? moveOffset[0] : 0;
    let visualOffsetY = moveOffset ? moveOffset[1] : 0;

    // Apply combat lunge/shake offsets (in pixels, convert to tile units)
    if (_activeCombatOffsets) {
      if (u === _activeCombatOffsets.attacker) {
        visualOffsetX += _activeCombatOffsets.attackerOffset[0] / TILEWIDTH;
        visualOffsetY += _activeCombatOffsets.attackerOffset[1] / TILEHEIGHT;
      } else {
        const defenderOffset = _activeCombatOffsets.defenderOffsets?.get(u) ??
          (u === _activeCombatOffsets.defender ? _activeCombatOffsets.defenderOffset : null);
        if (defenderOffset) {
          visualOffsetX += defenderOffset[0] / TILEWIDTH;
          visualOffsetY += defenderOffset[1] / TILEHEIGHT;
        }
      }
    }

    // Boss/Elite/Protect blink icon (unit_sprite.py draw_hp -- elif chain,
    // so Boss takes priority over Elite over Protect).
    let specialTag: 'Boss' | 'Elite' | 'Protect' | null = null;
    if (u.tags.includes('Boss')) specialTag = 'Boss';
    else if (u.tags.includes('Elite')) specialTag = 'Elite';
    else if (u.tags.includes('Protect')) specialTag = 'Protect';

    // Rescue/pairup marker: colored by the *carried* unit's team combat_color.
    // Suppressed when the 'pairup' constant is on (Python draws a paired
    // sprite offset instead; see unit_sprite.py draw()/draw_hp()).
    let travelerCombatColor: string | null = null;
    if (u.traveler && !game.db.getConstant('pairup', false)) {
      const traveler = game.units.get(u.traveler) ?? null;
      const travelerTeam = traveler?.team;
      const teamDef = travelerTeam
        ? game.db.teams.defs.find((t: { nid: string; combatColor: string }) => t.nid === travelerTeam)
        : undefined;
      travelerCombatColor = teamDef?.combatColor ?? 'green';
    }

    const droppable = u.items.some((it) => it.droppable);

    // Only report finished=true for units on the active team so that
    // downstream renderers (placeholder overlays, etc.) don't grey out
    // units from other teams.
    result.push({
      x: u.position[0],
      y: u.position[1],
      visualOffsetX,
      visualOffsetY,
      sprite: u.sprite,
      team: u.team,
      finished: u.finished && u.team === currentTeam,
      currentHp: u.currentHp,
      maxHp: u.maxHp,
      specialTag,
      travelerCombatColor,
      droppable,
    });
  }
  return result;
}

/** Render the map through MapView and blit onto `surf`. */
function drawMap(surf: Surface, showHighlights: boolean = true): Surface {
  const game = getGame();
  if (!game.board || !game.tilemap) return surf; // No level loaded
  game.camera.update();
  game.cursor.update();

  const cullRect = game.camera.getCullRect();
  const units = collectVisibleUnits();
  const highlights: Map<string, string> | null = showHighlights
    ? game.highlight.getHighlights()
    : null;

  const cursorInfo = {
    x: game.cursor.getHover().x,
    y: game.cursor.getHover().y,
    visible: game.cursor.visible,
    draw: (s: Surface, ox: number, oy: number) => {
      game.cursor.draw(s, [ox, oy] as [number, number]);
    },
  };

  // Build fog of war config if fog is active
  let fogConfig: FogRenderConfig | null = null;
  const fogInfo = game.getCurrentFogInfo?.();
  if (fogInfo && game.board && (fogInfo.isActive || game.board.fogRegionSet?.size > 0)) {
    fogConfig = {
      fogInfo,
      board: game.board,
      db: game.db,
      allUnits: game.getAllUnits(),
    };
  }

  const mapSurf = game.mapView.draw(
    game.tilemap,
    cullRect,
    units,
    highlights,
    cursorInfo,
    false, // showGrid
    surf.scale,
    fogConfig,
    game.unitMarkers,
    performance.now(),
  );

  surf.blit(mapSurf);
  return surf;
}

/** Move cursor and camera together. */
function moveCursor(dx: number, dy: number): void {
  const game = getGame();
  game.cursor.move(dx, dy);
  const pos = game.cursor.getHover();
  game.camera.focusTile(pos.x, pos.y);
  // Cursor movement sound (matching Python's 'Select 5')
  game.audioManager?.playSfx?.('Select 5');
}

/** Get the unit under the cursor, or null. */
function getUnitUnderCursor(): UnitObject | null {
  const game = getGame();
  const pos = game.cursor.getHover();
  return getBoard().getUnit(pos.x, pos.y);
}

/** Get all component-valid unit targets within weapon range from a position. */
function getTargetsInRange(
  unit: UnitObject,
  fromX: number,
  fromY: number,
  item?: ItemObject,
): UnitObject[] {
  const game = getGame();
  const weapon = item ?? getEquippedWeapon(unit, game.db, game);
  if (!weapon || !game.targetSystem) return [];
  return game.targetSystem.getValidUnitTargets(unit, weapon, [fromX, fromY]);
}

function getAvailableCombatItems(unit: UnitObject): ItemObject[] {
  const game = getGame();
  return unit.items.filter((item) =>
    (item.isWeapon() || item.isSpell()) && itemAvailable(unit, item, game.db, game),
  );
}

/** Get all adjacent allied units to a unit at a specific position. */
function getAdjacentAllies(unit: UnitObject, x: number, y: number): UnitObject[] {
  const game = getGame();
  const board = getBoard();
  const dirs: [number, number][] = [[0, -1], [0, 1], [-1, 0], [1, 0]];
  const allies: UnitObject[] = [];
  for (const [dx, dy] of dirs) {
    const other = board.getUnit(x + dx, y + dy);
    if (other && other !== unit && !other.isDead() && game.db.areAllied(unit.team, other.team)) {
      allies.push(other);
    }
  }
  return allies;
}

/** Get all adjacent units (any team) at a specific position. */
function getAdjacentUnits(x: number, y: number): UnitObject[] {
  const board = getBoard();
  const dirs: [number, number][] = [[0, -1], [0, 1], [-1, 0], [1, 0]];
  const units: UnitObject[] = [];
  for (const [dx, dy] of dirs) {
    const other = board.getUnit(x + dx, y + dy);
    if (other && !other.isDead()) {
      units.push(other);
    }
  }
  return units;
}

/**
 * Get the first region located at the given position (matches Python's
 * game.get_region_under_pos). Used by the unit_wait trigger payload.
 */
function getRegionUnderPos(x: number, y: number): RegionData | null {
  const game = getGame();
  const regions: RegionData[] = game.currentLevel?.regions ?? [];
  for (const region of regions) {
    const [rx, ry] = region.position;
    const [rw, rh] = region.size ?? [1, 1];
    if (x >= rx && x < rx + rw && y >= ry && y < ry + rh) {
      return region;
    }
  }
  return null;
}

/** Get all adjacent empty tiles that are in bounds. */
function getAdjacentEmptyTiles(x: number, y: number, traveler?: UnitObject | null): [number, number][] {
  const game = getGame();
  const board = getBoard();
  const dirs: [number, number][] = [[0, -1], [0, 1], [-1, 0], [1, 0]];
  const tiles: [number, number][] = [];
  for (const [dx, dy] of dirs) {
    const nx = x + dx;
    const ny = y + dy;
    if (board.inBounds(nx, ny) && !board.isOccupied(nx, ny)) {
      if (traveler) {
        const movementGroup = game.db.classes.get(traveler.klass)?.movement_group ?? 'Infantry';
        if (board.getMovementCost(nx, ny, movementGroup, game.db) >= 99) continue;
      }
      tiles.push([nx, ny]);
    }
  }
  return tiles;
}

function canUnitStandAt(unit: UnitObject, x: number, y: number): boolean {
  const game = getGame();
  const movementGroup = game.db.classes.get(unit.klass)?.movement_group ?? 'Infantry';
  return game.board.inBounds(x, y) &&
    game.board.getMovementCost(x, y, movementGroup, game.db) < 99;
}

// ---------------------------------------------------------------------------
// Mouse helpers
// ---------------------------------------------------------------------------

/**
 * Get the tile coordinates under the mouse cursor, or null if the mouse
 * is outside the game area or no InputManager is available.
 */
function getMouseTile(): [number, number] | null {
  const game = getGame();
  if (!game.input) return null;
  const cam = game.camera.getOffset();
  return game.input.getMouseTile(cam[0], cam[1]);
}

/**
 * If the mouse was clicked this frame (LMB), move the cursor to the
 * clicked tile and return 'SELECT'. If RMB, return 'BACK'.
 * If the mouse moved (no click), move the cursor to the hovered tile
 * and return null (no action, just hover tracking).
 *
 * Returns the effective InputEvent to process, or undefined to indicate
 * "mouse didn't do anything interesting — fall through to keyboard".
 */
function processMouseForMap(event: InputEvent): InputEvent | undefined {
  const game = getGame();
  if (!game.input) return undefined;

  const input = game.input;
  const tile = getMouseTile();

  // Handle mouse click: move cursor to tile, then return the action
  if (input.mouseClick) {
    if (input.mouseClick === 'SELECT' && tile) {
      const curPos = game.cursor.getHover();
      if (tile[0] !== curPos.x || tile[1] !== curPos.y) {
        game.audioManager?.playSfx?.('Select 5');
      }
      game.cursor.setPos(tile[0], tile[1]);
      // Only auto-center camera on tap for small/mobile screens
      if (isSmallScreen()) {
        game.camera.focusTile(tile[0], tile[1]);
      }
      return 'SELECT';
    }
    if (input.mouseClick === 'BACK') {
      return 'BACK';
    }
    if (input.mouseClick === 'INFO' && tile) {
      const curPos = game.cursor.getHover();
      if (tile[0] !== curPos.x || tile[1] !== curPos.y) {
        game.audioManager?.playSfx?.('Select 5');
      }
      game.cursor.setPos(tile[0], tile[1]);
      if (isSmallScreen()) {
        game.camera.focusTile(tile[0], tile[1]);
      }
      return 'INFO';
    }
  }

  // Handle mouse hover: move cursor to hovered tile (no action)
  if (input.mouseMoved && tile) {
    const curPos = game.cursor.getHover();
    if (tile[0] !== curPos.x || tile[1] !== curPos.y) {
      game.cursor.setPos(tile[0], tile[1]);
      // Play cursor movement sound on hover too (matches keyboard behavior)
      game.audioManager?.playSfx?.('Select 5');
    }
  }

  return undefined; // No mouse action to process
}

// ============================================================================
// 1. TitleStartState — "Press Start" splash screen
// ============================================================================

export class TitleState extends State {
  readonly name = 'title';
  override readonly showMap = false;
  override readonly inLevel = false;

  private bgImage: HTMLImageElement | null = null;
  private pulseTimer: number = 0;

  override start(): StateResult {
    const game = getGame();
    // Load the title background panorama (try single file, then frame 0 for animated panoramas)
    game.resources.tryLoadImage('resources/panoramas/title_background.png').then((img: HTMLImageElement | null) => {
      if (img) {
        this.bgImage = img;
      } else {
        // Animated panorama fallback: try title_background0.png
        game.resources.tryLoadImage('resources/panoramas/title_background0.png').then((img0: HTMLImageElement | null) => {
          this.bgImage = img0;
        });
      }
    });

    // Play title music if configured
    const titleMusic = game.db.getConstant('music_main', null) as string | null;
    if (titleMusic) {
      void game.audioManager.playMusic(titleMusic);
    }

    // Fire on_title_screen trigger when entering the title screen.
    // eventManager can be null when falling back to the title after a
    // campaign end / lose_game cleanup, so guard like every other site.
    if (game.eventManager) {
      game.eventManager.trigger(
        {
          type: 'on_title_screen',
        },
        { game, gameVars: game.gameVars, levelVars: new Map() },
      );
    }
  }

  override update(): StateResult {
    this.pulseTimer += getGame().frameDeltaMs ?? 16;
  }

  override draw(surf: Surface): Surface {
    const vw = viewport.width;
    const vh = viewport.height;

    // Background — scale panorama to fill viewport
    if (this.bgImage) {
      const s = surf.scale;
      const imgW = this.bgImage.naturalWidth || vw;
      const imgH = this.bgImage.naturalHeight || vh;
      surf.ctx.imageSmoothingEnabled = false;
      surf.ctx.drawImage(
        this.bgImage,
        0, 0, imgW, imgH,
        0, 0, Math.round(vw * s), Math.round(vh * s),
      );
    } else {
      surf.fill(16, 16, 32);
    }

    // Title text — centered, upper third
    const title = 'Lex Talionis';
    const titleW = title.length * 8;
    surf.drawText(
      title,
      Math.floor((vw - titleW) / 2),
      Math.floor(vh / 3),
      'white',
      '14px monospace',
    );

    // "Press Start" — pulsing alpha
    const alpha = 0.5 + 0.5 * Math.sin(this.pulseTimer / 500 * Math.PI);
    const prompt = 'Press Start';
    const promptW = prompt.length * 5;
    surf.drawText(
      prompt,
      Math.floor((vw - promptW) / 2),
      Math.floor(vh * 4 / 5),
      `rgba(200,200,220,${alpha.toFixed(2)})`,
      '8px monospace',
    );

    return surf;
  }

  override takeInput(event: InputEvent): StateResult {
    const game = getGame();
    if (event === 'START' || event === 'SELECT' || game.input?.mouseClick === 'SELECT') {
      game.state.change('title_main');
    }
  }
}

// ============================================================================
// 1a. TitleMainState — Main title menu (New Game / Extras)
// ============================================================================

export class TitleMainState extends State {
  readonly name = 'title_main';
  override readonly showMap = false;
  override readonly inLevel = false;

  private bgImage: HTMLImageElement | null = null;
  private options: string[] = ['New Game', 'Extras'];
  private cursor: number = 0;
  private slideX: number = -120;
  private targetX: number = 0;
  private slideTimer: number = 0;
  private hasSaveData: boolean = false;

  override start(): StateResult {
    const game = getGame();
    game.resources.tryLoadImage('resources/panoramas/title_background.png').then((img: HTMLImageElement | null) => {
      if (img) {
        this.bgImage = img;
      } else {
        // Animated panorama fallback: try title_background0.png
        game.resources.tryLoadImage('resources/panoramas/title_background0.png').then((img0: HTMLImageElement | null) => {
          this.bgImage = img0;
        });
      }
    });
    this.slideX = -120;
    this.targetX = 24;
    this.cursor = 0;

    // Check if any save data exists to show Load Game / Continue options
    const gameNid = game.db?.getConstant?.('game_nid', 'default') ?? 'default';
    const numSlots = game.db?.getConstant?.('num_save_slots', 3) ?? 3;
    Promise.all([
      loadSaveSlots(gameNid as string, numSlots as number),
      hasSuspend(gameNid as string),
    ]).then(([slots, hasSusp]) => {
      const hasAnySave = hasSusp || slots.some(s => s.name !== '--NO DATA--');
      this.hasSaveData = hasAnySave;
      this.rebuildOptions();
    }).catch(() => {
      // Ignore errors — just show default options
    });
  }

  override begin(): StateResult {
    this.slideX = -120;
    this.cursor = 0;
    this.slideTimer = 0;
    this.rebuildOptions();
  }

  private rebuildOptions(): void {
    const opts: string[] = [];
    if (this.hasSaveData) {
      opts.push('Continue');
    }
    opts.push('New Game');
    if (this.hasSaveData) {
      opts.push('Load Game');
    }
    opts.push('Extras');
    this.options = opts;
    // Keep cursor in bounds
    if (this.cursor >= this.options.length) {
      this.cursor = 0;
    }
  }

  override update(): StateResult {
    // Slide menu in
    if (this.slideX < this.targetX) {
      this.slideX = Math.min(this.targetX, this.slideX + 12);
    }
    this.slideTimer += getGame().frameDeltaMs ?? 16;
  }

  override draw(surf: Surface): Surface {
    const vw = viewport.width;
    const vh = viewport.height;

    // Background — scale panorama to fill viewport
    if (this.bgImage) {
      const s = surf.scale;
      const imgW = this.bgImage.naturalWidth || vw;
      const imgH = this.bgImage.naturalHeight || vh;
      surf.ctx.imageSmoothingEnabled = false;
      surf.ctx.drawImage(
        this.bgImage,
        0, 0, imgW, imgH,
        0, 0, Math.round(vw * s), Math.round(vh * s),
      );
    } else {
      surf.fill(16, 16, 32);
    }

    // Semi-transparent panel behind menu
    const panelX = Math.floor(this.slideX - 8);
    const panelY = Math.floor(vh / 2 - 10);
    const panelW = 90;
    const panelH = this.options.length * 16 + 8;
    surf.fillRect(panelX, panelY, panelW, panelH, 'rgba(16,16,48,0.85)');
    surf.drawRect(panelX, panelY, panelW, panelH, 'rgba(100,100,180,0.7)');

    // Menu options
    for (let i = 0; i < this.options.length; i++) {
      const optY = Math.floor(vh / 2 + i * 16 - 4);
      const optX = Math.floor(this.slideX);

      if (i === this.cursor) {
        // Highlight bar
        surf.fillRect(panelX + 2, optY - 2, panelW - 4, 14, 'rgba(64,64,160,0.6)');
        // Animated cursor arrow with bobbing
        const bobOffset = Math.sin(this.slideTimer / 300 * Math.PI) * 1.5;
        surf.drawText('>', optX - 8, optY + bobOffset, 'rgba(255,255,128,1)', '8px monospace');
      }

      const color = i === this.cursor ? 'white' : 'rgba(180,180,200,1)';
      surf.drawText(this.options[i], optX, optY, color, '8px monospace');
    }

    return surf;
  }

  override takeInput(event: InputEvent): StateResult {
    const game = getGame();

    if (event === 'UP') {
      this.cursor = (this.cursor - 1 + this.options.length) % this.options.length;
    } else if (event === 'DOWN') {
      this.cursor = (this.cursor + 1) % this.options.length;
    } else if (event === 'SELECT' || game.input?.mouseClick === 'SELECT') {
      const selected = this.options[this.cursor];
      if (selected === 'New Game') {
        game.state.change('title_mode');
      } else if (selected === 'Continue') {
        // Load the most recent save (highest realtime)
        game.state.change('load_menu');
      } else if (selected === 'Load Game') {
        game.state.change('load_menu');
      } else if (selected === 'Extras') {
        // Placeholder — not yet implemented
      }
    } else if (event === 'BACK') {
      game.state.back(); // Return to press-start screen
    }
  }
}

// ============================================================================
// 1a1. TitleModeState — Difficulty/mode selection (new-game flow)
// Port of lt-maker/app/engine/title_screen.py TitleModeState.
//
// Python's flow is difficulty_setup -> death_setup -> growth_setup, but the
// death/growth sub-screens only appear when the chosen mode's
// permadeath_choice/growths_choice is "Player Choice" — no bundled project
// (default/rekka/testing_proj.ltproj) uses Player Choice, so that branch is
// deferred here (documented, not invented) until a project fixture needs it.
// Like Python, the mode list itself is skipped entirely when there is at
// most one available (unlocked) difficulty mode — game.currentMode is set
// directly and we proceed straight to level_select.
// ============================================================================

type TitleModePhase = 'difficulty_setup' | 'death_setup' | 'growth_setup';

export class TitleModeState extends State {
  readonly name = 'title_mode';
  override readonly showMap = false;
  override readonly inLevel = false;

  private availableModes: DifficultyMode[] = [];
  private cursor: number = 0;
  private phase: TitleModePhase = 'difficulty_setup';
  private requiresPermadeathChoice = false;
  private requiresGrowthChoice = false;
  private menuOptions: string[] = [];

  private static readonly DEATH_OPTIONS = ['Classic', 'Casual'];
  private static readonly GROWTH_OPTIONS = ['Random', 'Fixed', 'Dynamic', 'Lucky', 'Bexp'];

  private get difficultyChoice(): boolean {
    return this.availableModes.length > 1;
  }

  private get currentModeNids(): string[] {
    return this.availableModes.map((m) => m.nid);
  }

  override start(): StateResult {
    const game = getGame();
    const allModes = game.db.difficultyModes;
    this.availableModes = allModes.filter(
      (m: DifficultyMode) => !m.start_locked || (RECORDS && RECORDS.checkDifficultyUnlocked(m.nid)),
    );
    this.cursor = 0;
    this.phase = 'difficulty_setup';
    this.requiresPermadeathChoice = false;
    this.requiresGrowthChoice = false;
    this.menuOptions = [];

    this.beginCurrentPhase();
  }

  override begin(): StateResult {
    this.beginCurrentPhase();
  }

  private beginCurrentPhase(): void {
    if (this.phase === 'difficulty_setup') {
      this.startDifficultySelection();
    } else if (this.phase === 'death_setup') {
      this.startDeathSelection();
    } else {
      this.startGrowthSelection();
    }
  }

  private startDifficultySelection(): void {
    const game = getGame();
    if (this.difficultyChoice) {
      this.menuOptions = this.availableModes.map((mode) => mode.name);
      this.cursor = Math.max(0, Math.min(this.cursor, this.menuOptions.length - 1));
      this.phase = 'difficulty_setup';
      return;
    }

    const fallbackMode = this.availableModes[0] ?? game.db.difficultyModes[0];
    if (fallbackMode) {
      const mode = DifficultyModeObject.fromPrefab(fallbackMode);
      game.currentMode = mode;
      this.requiresPermadeathChoice = fallbackMode.permadeath_choice === 'Player Choice';
      this.requiresGrowthChoice = fallbackMode.growths_choice === 'Player Choice';
    }

    if (this.requiresPermadeathChoice) {
      this.phase = 'death_setup';
      this.cursor = 1;
      this.startDeathSelection();
    } else if (this.requiresGrowthChoice) {
      this.phase = 'growth_setup';
      this.cursor = 0;
      this.startGrowthSelection();
    } else {
      game.state.change('level_select');
    }
  }

  private startDeathSelection(): void {
    this.menuOptions = TitleModeState.DEATH_OPTIONS.slice();
    this.cursor = Math.max(0, Math.min(this.cursor, this.menuOptions.length - 1));
    this.phase = 'death_setup';
  }

  private startGrowthSelection(): void {
    this.menuOptions = TitleModeState.GROWTH_OPTIONS.slice();
    this.cursor = Math.max(0, Math.min(this.cursor, this.menuOptions.length - 1));
    this.phase = 'growth_setup';
  }

  private chooseCurrentModeByIndex(index: number): void {
    const game = getGame();
    const mode = this.availableModes[index];
    if (!mode) return;

    const modeObj = DifficultyModeObject.fromPrefab(mode);
    game.currentMode = modeObj;
    this.requiresPermadeathChoice = mode.permadeath_choice === 'Player Choice';
    this.requiresGrowthChoice = mode.growths_choice === 'Player Choice';

    if (this.requiresPermadeathChoice) {
      this.phase = 'death_setup';
      this.cursor = 1;
      this.startDeathSelection();
      return;
    }

    if (this.requiresGrowthChoice) {
      this.phase = 'growth_setup';
      this.cursor = 0;
      this.startGrowthSelection();
      return;
    }

    game.state.change('level_select');
  }

  private applyDeathChoice(): void {
    const game = getGame();
    game.currentMode.permadeath = this.menuOptions[this.cursor] === 'Classic';
    if (this.requiresGrowthChoice) {
      this.phase = 'growth_setup';
      this.cursor = 0;
      this.startGrowthSelection();
    } else {
      game.state.change('level_select');
    }
  }

  private applyGrowthChoice(): void {
    const game = getGame();
    game.currentMode.growths = this.menuOptions[this.cursor];
    game.state.change('level_select');
  }

  private handleBack(): void {
    const game = getGame();
    if (this.phase === 'difficulty_setup') {
      game.state.back();
      return;
    }

    if (this.phase === 'death_setup') {
      if (this.difficultyChoice) {
        this.phase = 'difficulty_setup';
        this.cursor = 0;
        this.startDifficultySelection();
      } else {
        game.state.back();
      }
      return;
    }

    if (this.phase === 'growth_setup') {
      if (this.requiresPermadeathChoice) {
        this.phase = 'death_setup';
        this.cursor = 1;
        this.startDeathSelection();
      } else if (this.difficultyChoice) {
        this.phase = 'difficulty_setup';
        this.cursor = 0;
        this.startDifficultySelection();
      } else {
        game.state.back();
      }
    }
  }

  private moveCursor(delta: number): void {
    if (this.menuOptions.length === 0) return;
    this.cursor = (this.cursor + delta + this.menuOptions.length) % this.menuOptions.length;
  }

  override draw(surf: Surface): Surface {
    const vw = viewport.width;
    const vh = viewport.height;
    surf.fill(16, 16, 32);

    let title = 'Select Difficulty';
    if (this.phase === 'death_setup') title = 'Permadeath Rule';
    if (this.phase === 'growth_setup') title = 'Growth Method';
    const titleX = Math.floor(vw / 2) - (title.length * 4);
    surf.drawText(title, titleX, 10, 'white', '10px monospace');

    const options = this.menuOptions;
    for (let i = 0; i < options.length; i++) {
      const y = 30 + i * 16;
      const selected = i === this.cursor;
      if (selected) {
        surf.fillRect(20, y - 2, vw - 40, 14, 'rgba(60,80,160,0.6)');
        surf.drawText('>', 12, y, 'rgb(220,200,80)', '9px monospace');
      }
      surf.drawText(options[i], 24, y, selected ? 'white' : 'rgb(180,180,200)', '9px monospace');
    }

    if (this.phase !== 'difficulty_setup' && this.currentModeNids.length > 0) {
      const subtitle = `Mode: ${this.availableModes[Math.max(0, Math.min(this.cursor, this.availableModes.length - 1))]?.name ?? this.availableModes[0]?.name ?? 'None'}`;
      surf.drawText(subtitle, 14, vh - 16, 'rgba(200,200,240,0.8)', '7px monospace');
    }
    return surf;
  }

  override takeInput(event: InputEvent): StateResult {
    if (event === 'UP') {
      this.moveCursor(-1);
    } else if (event === 'DOWN') {
      this.moveCursor(1);
    } else if (event === 'BACK') {
      this.handleBack();
    } else if (event === 'SELECT' || getGame().input?.mouseClick === 'SELECT') {
      if (this.phase === 'difficulty_setup') {
        this.chooseCurrentModeByIndex(this.cursor);
      } else if (this.phase === 'death_setup') {
        this.applyDeathChoice();
      } else if (this.phase === 'growth_setup') {
        this.applyGrowthChoice();
      }
    }
  }
}

// ============================================================================
// 1a2. LevelSelectState (chapter / scenario picker)
// ============================================================================

export class LevelSelectState extends State {
  readonly name = 'level_select';
  override readonly showMap = false;
  override readonly inLevel = false;

  private levels: { nid: string; name: string }[] = [];
  private cursor: number = 0;
  private scrollOffset: number = 0;
  private loading: boolean = false;

  // Layout constants
  private readonly VISIBLE_ROWS = 7;
  private readonly ROW_HEIGHT = 16;
  private readonly LIST_Y = 30;
  private readonly LIST_X = 20;

  override begin(): StateResult {
    const game = getGame();
    this.levels = [];
    this.cursor = 0;
    this.scrollOffset = 0;
    this.loading = false;

    // Collect all levels from the database
    for (const [nid, prefab] of game.db.levels) {
      this.levels.push({ nid, name: prefab.name });
    }
  }

  override draw(surf: Surface): Surface {
    // Dark background
    surf.fill(16, 16, 32);

    // Title
    const vw = viewport.width;
    const vh = viewport.height;
    const title = 'Select Chapter';
    const titleW = title.length * 7;
    surf.drawText(
      title,
      Math.floor((vw - titleW) / 2),
      10,
      'white',
      '12px monospace',
    );

    // Level list
    const visibleStart = this.scrollOffset;
    const visibleEnd = Math.min(this.levels.length, visibleStart + this.VISIBLE_ROWS);

    for (let i = visibleStart; i < visibleEnd; i++) {
      const level = this.levels[i];
      const y = this.LIST_Y + (i - visibleStart) * this.ROW_HEIGHT;
      const isSelected = i === this.cursor;

      // Selection highlight
      if (isSelected) {
        surf.fillRect(this.LIST_X - 4, y - 1, vw - (this.LIST_X - 4) * 2, this.ROW_HEIGHT, 'rgba(60,80,160,0.6)');
      }

      // Cursor arrow
      if (isSelected) {
        surf.drawText('>', this.LIST_X - 2, y, 'rgb(220,200,80)', '10px monospace');
      }

      // Level name
      const color = isSelected ? 'rgb(255,255,220)' : 'rgb(180,180,200)';
      surf.drawText(level.name, this.LIST_X + 8, y, color, '10px monospace');
    }

    // Scroll indicators
    if (this.scrollOffset > 0) {
      surf.drawText('^', Math.floor(vw / 2), this.LIST_Y - 10, 'rgba(200,200,220,0.6)', '8px monospace');
    }
    if (visibleEnd < this.levels.length) {
      const bottomY = this.LIST_Y + this.VISIBLE_ROWS * this.ROW_HEIGHT;
      surf.drawText('v', Math.floor(vw / 2), bottomY, 'rgba(200,200,220,0.6)', '8px monospace');
    }

    // Loading indicator
    if (this.loading) {
      surf.fillRect(0, 0, vw, vh, 'rgba(0,0,0,0.5)');
      const loadText = 'Loading...';
      const loadW = loadText.length * 5;
      surf.drawText(
        loadText,
        Math.floor((vw - loadW) / 2),
        Math.floor(vh / 2),
        'white',
        '10px monospace',
      );
    }

    return surf;
  }

  override takeInput(event: InputEvent): StateResult {
    if (this.loading) return;
    const game = getGame();

    // Mouse hover to highlight
    if (game.input?.mouseMoved) {
      const [, gy] = game.input.getGameMousePos();
      const hoverIndex = this.getIndexAtY(gy);
      if (hoverIndex !== null) {
        this.cursor = hoverIndex;
      }
    }

    // Mouse click to select
    if (game.input?.mouseClick === 'SELECT') {
      const [, gy] = game.input.getGameMousePos();
      const clickIndex = this.getIndexAtY(gy);
      if (clickIndex !== null) {
        this.cursor = clickIndex;
        this.selectLevel();
        return;
      }
    }

    // Mouse right-click to go back
    if (game.input?.mouseClick === 'BACK') {
      game.state.back();
      return;
    }

    if (event === 'UP') {
      if (this.cursor > 0) {
        this.cursor--;
        // Scroll up if cursor is above visible area
        if (this.cursor < this.scrollOffset) {
          this.scrollOffset = this.cursor;
        }
      }
    } else if (event === 'DOWN') {
      if (this.cursor < this.levels.length - 1) {
        this.cursor++;
        // Scroll down if cursor is below visible area
        if (this.cursor >= this.scrollOffset + this.VISIBLE_ROWS) {
          this.scrollOffset = this.cursor - this.VISIBLE_ROWS + 1;
        }
      }
    } else if (event === 'SELECT' || event === 'START') {
      this.selectLevel();
    } else if (event === 'BACK') {
      game.state.back();
    }
  }

  private getIndexAtY(gy: number): number | null {
    const relY = gy - this.LIST_Y;
    if (relY < 0) return null;
    const row = Math.floor(relY / this.ROW_HEIGHT);
    if (row >= this.VISIBLE_ROWS) return null;
    const index = this.scrollOffset + row;
    if (index >= this.levels.length) return null;
    return index;
  }

  private selectLevel(): void {
    if (this.levels.length === 0) return;
    const selected = this.levels[this.cursor];
    const game = getGame();

    this.loading = true;

    // Load the level, then clear the stack and start gameplay.
    // Keep LevelSelectState on the stack during loading so the
    // loading overlay remains visible.
    game.loadLevel(selected.nid).then(() => {
      this.loading = false;
      game.state.clear();
      game.state.change('free');
      // If level_start triggered events, push EventState on top of FreeState
      if (game.eventManager?.hasActiveEvents()) {
        game.state.change('event');
      }
    }).catch((err: unknown) => {
      this.loading = false;
      console.error('Failed to load level:', err);
      // Go back to title on failure
      game.state.change('title');
    });
  }
}

// ============================================================================
// 1b. OptionMenuState (map option menu: End Turn, etc.)
// ============================================================================

export class OptionMenuState extends State {
  readonly name = 'option_menu';
  override readonly transparent = true;

  private menu: ChoiceMenu | null = null;

  override begin(): StateResult {
    const game = getGame();
    const hasMinimap = !!(game.board && game.tilemap);

    // Check if turnwheel is enabled (constant + game var)
    const turnwheelConstant = game.db?.getConstant?.('turnwheel', null) ?? null;
    const turnwheelEnabled = !!turnwheelConstant && !!game.gameVars.get('_turnwheel');

    const options: MenuOption[] = [];
    options.push({ label: 'End Turn', value: 'end_turn', enabled: true });
    if (turnwheelEnabled) {
      options.push({ label: 'Turnwheel', value: 'turnwheel', enabled: true });
    }
    options.push({ label: 'Minimap', value: 'minimap', enabled: hasMinimap });
    options.push({ label: 'Save', value: 'save', enabled: true });
    options.push({ label: 'Suspend', value: 'suspend', enabled: true });
    // Custom options from set_custom_options (Python general_states.py:463):
    // inserted before 'Options', disabled per _custom_options_disabled.
    const customOpts: string[] = game.gameVars.get('_custom_additional_options') ?? [];
    const customDisabled: boolean[] = game.gameVars.get('_custom_options_disabled') ?? [];
    customOpts.forEach((label: string, idx: number) => {
      options.push({ label, value: `custom:${idx}`, enabled: !customDisabled[idx] });
    });
    options.push({ label: 'Options', value: 'options', enabled: true });

    // Centre the menu on screen
    const menuX = Math.floor(viewport.width / 2) - 30;
    const menuY = Math.floor(viewport.height / 2) - (options.length * 8 + 4);
    this.menu = new ChoiceMenu(options, menuX, menuY);
  }

  override takeInput(event: InputEvent): StateResult {
    if (!this.menu) return;
    const game = getGame();

    // Handle mouse click on menu options
    let result: { selected: string } | { back: true } | null = null;
    if (game.input?.mouseClick) {
      const [gx, gy] = game.input.getGameMousePos();
      result = this.menu.handleClick(gx, gy, game.input.mouseClick as 'SELECT' | 'BACK');
    }
    // Handle mouse hover to highlight menu options
    if (game.input?.mouseMoved) {
      const [gx, gy] = game.input.getGameMousePos();
      this.menu.handleMouseHover(gx, gy);
    }
    // Fall through to keyboard input if mouse didn't produce a result
    if (!result && event !== null) {
      result = this.menu.handleInput(event);
    }
    if (!result) return;

    if ('back' in result) {
      this.menu = null;
      game.state.back();
      return;
    }

    if ('selected' in result) {
      if (result.selected.startsWith('custom:')) {
        // Custom option (set_custom_options): fire its configured event.
        const cIdx = parseInt(result.selected.slice(7), 10);
        const cEvents: (string | null)[] = getGame().gameVars.get('_custom_options_events') ?? [];
        const evName = cEvents[cIdx];
        const game = getGame();
        game.state.back();
        if (evName && game.eventManager.triggerSpecific(evName, { type: evName }, true)) {
          game.state.change('event');
        }
        return;
      }
      switch (result.selected) {
        case 'end_turn': {
          // Mark all player units as finished and trigger turn change
          const playerUnits: UnitObject[] = game.board?.getTeamUnits('player') ?? [];
          for (const unit of playerUnits) {
            game.actionLog.doAction(new WaitAction(unit));
          }
          this.menu = null;
          game.state.back();
          game.state.change('turn_change');
          break;
        }
        case 'turnwheel': {
          // Check if the player has uses remaining (or unlimited = -1)
          const currentUses = game.gameVars.get('_current_turnwheel_uses') ?? -1;
          if (currentUses > 0 || currentUses === -1) {
            this.menu = null;
            game.state.change('turnwheel');
          } else {
            // No uses remaining
            game.audioManager?.playSfx?.('Error');
          }
          break;
        }
        case 'minimap': {
          this.menu = null;
          game.state.back();
          game.state.change('minimap');
          break;
        }
        case 'save': {
          this.menu = null;
          game.state.back();
          game.state.change('save_menu');
          break;
        }
        case 'suspend': {
          this.menu = null;
          game.state.back();
          doSuspendGame(game).then(() => {
            game.state.clear();
            game.state.change('title');
          }).catch(() => {
            game.state.clear();
            game.state.change('title');
          });
          break;
        }
        case 'options': {
          this.menu = null;
          game.state.back();
          game.state.change('settings_menu');
          break;
        }
      }
    }
  }

  override draw(surf: Surface): Surface {
    if (this.menu) {
      this.menu.draw(surf);
    }
    return surf;
  }
}

// ============================================================================
// 2. FreeState
// ============================================================================

export class FreeState extends MapState {
  readonly name = 'free';

  override begin(): StateResult {
    const game = getGame();
    const board = getBoard();

    // Clear any stale highlights from previous states (matching Python's FreeState.begin)
    game.highlight.clear();

    // Check for free roam mode
    const roamInfo = game.roamInfo;
    if (roamInfo && roamInfo.roam && roamInfo.roamUnitNid) {
      const roamUnit = game.getUnit(roamInfo.roamUnitNid);
      if (roamUnit && roamUnit.position) {
        game.state.change('free_roam');
        return 'repeat';
      }
    }

    game.cursor.visible = true;

    // Phase music (Python: phase.fade_in_phase_music() in FreeState.begin() —
    // covers e.g. resuming a save mid-turn where phase_change never ran).
    fadeInPhaseMusic(game);

    // Mark end of previous action group (turnwheel marker)
    game.actionLog.doAction(new MarkActionGroupEnd('free'));

    // Initiative mode: auto-cursor to the initiative unit
    if (game.initiative) {
      const unitNid = game.initiative.getCurrentUnitNid();
      if (unitNid) {
        const unit = game.getUnit(unitNid);
        if (unit && unit.position) {
          game.cursor.setPos(unit.position[0], unit.position[1]);
          game.camera.focusTile(unit.position[0], unit.position[1]);
        }
      }
    } else {
      // Standard mode: auto-cursor to first available player unit
      const playerUnits: UnitObject[] = board.getTeamUnits('player');
      const available = playerUnits.find((u) => u.canStillAct() && u.position);
      if (available && available.position) {
        game.cursor.setPos(available.position[0], available.position[1]);
        game.camera.focusTile(available.position[0], available.position[1]);
      }
    }
  }

  override end(): StateResult {
    // Clear highlights when leaving FreeState (matching Python's FreeState.end)
    const game = getGame();
    game.highlight.clear();
  }

  override takeInput(event: InputEvent): StateResult {
    const game = getGame();

    // Process mouse: click moves cursor to tile + fires action,
    // hover tracks cursor position silently.
    const mouseAction = processMouseForMap(event);
    const effective = mouseAction ?? event;

    if (effective === null) return;

    switch (effective) {
      case 'UP':
        moveCursor(0, -1);
        break;
      case 'DOWN':
        moveCursor(0, 1);
        break;
      case 'LEFT':
        moveCursor(-1, 0);
        break;
      case 'RIGHT':
        moveCursor(1, 0);
        break;

      case 'SELECT': {
        const unit = getUnitUnderCursor();
        if (unit && unit.team === 'player' && unit.canStillAct()) {
          // In initiative mode, only allow selecting the current initiative unit
          if (game.initiative) {
            const initUnitNid = game.initiative.getCurrentUnitNid();
            if (initUnitNid && unit.nid !== initUnitNid) {
              // Not the initiative unit — treat as enemy click (show range) or error
              break;
            }
          }
          // Mark start of this unit's action group (turnwheel marker)
          game.actionLog.doAction(new MarkActionGroupStart(unit, 'free'));
          game.selectedUnit = unit;
          game.state.change('move');
          // unit_select fires after the cursor selection is committed
          // (matches Python general_states.py FreeState.take_input). Don't
          // push 'event' here directly — FreeState.update() (called later
          // this same frame, before the 'move' change is flushed) already
          // checks hasActiveEvents() and pushes it; pushing twice here would
          // double-stack the EventState.
          if (game.eventManager && unit.position) {
            const levelNid = game.currentLevel?.nid ?? '';
            const ctx = { game, unit1: unit, gameVars: game.gameVars, levelVars: game.levelVars };
            game.eventManager.trigger(
              {
                type: 'unit_select', levelNid, unitNid: unit.nid, unit1: unit,
                position: [unit.position[0], unit.position[1]],
              },
              ctx,
            );
          }
        } else if (unit && unit.team !== 'player' && unit.position) {
          // SELECT on enemy: toggle individual enemy range display
          const key = `${unit.position[0]},${unit.position[1]}`;
          const existing = game.highlight.getHighlights().get(key);
          if (existing === 'selected') {
            game.highlight.clearType('selected');
            game.highlight.clearType('move');
            game.highlight.clearType('attack');
          } else {
            game.highlight.clearType('selected');
            game.highlight.clearType('move');
            game.highlight.clearType('attack');
            const validMoves = game.pathSystem!.getValidMoves(unit, game.board);
            const attackPos = game.pathSystem!.getAttackPositions(unit, game.board, validMoves);
            game.highlight.setMoveHighlights(validMoves);
            game.highlight.setAttackHighlights(attackPos);
            game.highlight.addHighlight(unit.position[0], unit.position[1], 'selected');
          }
        } else {
          // No actionable unit — open option menu
          game.state.change('option_menu');
        }
        break;
      }

      case 'BACK': {
        // Right-click on map: open option menu (same as START)
        game.state.change('option_menu');
        break;
      }

      case 'INFO': {
        const unit = getUnitUnderCursor();
        if (!unit) {
          // Empty tile: toggle ALL enemy threat zone overlay
          if (game.highlight.hasType('threat')) {
            game.highlight.clearType('threat');
          } else {
            this.showAllEnemyThreat(game);
          }
        } else {
          // Any unit: open info menu
          game.infoMenuUnit = unit;
          game.state.change('info_menu');
        }
        break;
      }

      case 'AUX': {
        // Cycle cursor through available player units
        const playerUnits: UnitObject[] = game.board.getTeamUnits('player');
        const available = playerUnits.filter(
          (u) => u.canStillAct() && u.position,
        );
        if (available.length === 0) break;

        const cursorPos = game.cursor.getPosition();
        // Find next unit after the one at cursor (or wrap)
        let nextIdx = 0;
        for (let i = 0; i < available.length; i++) {
          const p = available[i].position!;
          if (p[0] === cursorPos[0] && p[1] === cursorPos[1]) {
            nextIdx = (i + 1) % available.length;
            break;
          }
        }
        const next = available[nextIdx];
        if (next && next.position) {
          game.cursor.setPos(next.position[0], next.position[1]);
          game.camera.focusTile(next.position[0], next.position[1]);
        }
        break;
      }

      case 'START':
        // In initiative mode, START toggles the initiative bar display
        if (game.initiative) {
          game.initiative.toggleDraw();
        } else {
          game.state.change('option_menu');
        }
        break;
    }
  }

  override update(): StateResult {
    const game = getGame();

    // Check for pending events (might have been queued by another state)
    if (game.eventManager?.hasActiveEvents()) {
      game.state.change('event');
      return;
    }

    // Update HUD hover info
    const pos = game.cursor.getHover();
    const unit = game.board.getUnit(pos.x, pos.y);
    const terrainNid = game.board.getTerrain(pos.x, pos.y);
    const terrainDef = terrainNid ? game.db.terrain.get(terrainNid) : null;
    const [tDef, tAvo] = getTerrainBonuses(terrainDef, game.db);
    game.hud.setHover(unit, terrainDef?.name ?? '', tDef, tAvo);

    // Auto end-turn logic
    if (game.initiative) {
      // Initiative mode: auto-end when the current initiative unit is finished
      const initUnitNid = game.initiative.getCurrentUnitNid();
      if (initUnitNid) {
        const initUnit = game.getUnit(initUnitNid);
        if (initUnit && initUnit.finished) {
          game.state.change('turn_change');
          return;
        }
      }
    } else {
      // Standard mode: if all player units are finished, advance
      const playerUnits: UnitObject[] = game.board.getTeamUnits('player');
      if (playerUnits.length > 0) {
        const allFinished = playerUnits.every((u) => u.finished || u.isDead());
        if (allFinished) {
          game.state.change('turn_change');
          return;
        }
      }
    }
  }

  override draw(surf: Surface): Surface {
    surf = drawMap(surf);
    // HUD is drawn in screen-space by main.ts after the game surface blit.
    return surf;
  }

  /**
   * Compute and display the union of all enemy units' attack ranges.
   * This iterates every enemy unit, computes their valid moves and
   * attack positions, and combines them into a single 'threat' overlay.
   */
  private showAllEnemyThreat(game: any): void {
    const board = game.board;
    const pathSystem = game.pathSystem;
    if (!board || !pathSystem) return;

    const allThreatPositions = new Set<string>();

    // Gather all teams that are hostile to the player
    const enemyTeams = ['enemy', 'enemy2'];
    for (const team of enemyTeams) {
      const enemies: UnitObject[] = board.getTeamUnits(team);
      for (const enemy of enemies) {
        if (!enemy.position || enemy.isDead()) continue;

        try {
          const validMoves = pathSystem.getValidMoves(enemy, board);
          const attackPos = pathSystem.getAttackPositions(enemy, board, validMoves);

          // Both move positions (they can attack from there) and attack positions are threats
          for (const [x, y] of validMoves) {
            allThreatPositions.add(`${x},${y}`);
          }
          for (const [x, y] of attackPos) {
            allThreatPositions.add(`${x},${y}`);
          }
        } catch (e) {
          // Skip units that fail (e.g. missing movement group data)
          continue;
        }
      }
    }

    // Convert to position array
    const positions: [number, number][] = [];
    for (const key of allThreatPositions) {
      const [x, y] = key.split(',').map(Number);
      positions.push([x, y]);
    }

    game.highlight.setThreatHighlights(positions);
  }
}

// ============================================================================
// 3. MoveState
// ============================================================================

export class MoveState extends MapState {
  readonly name = 'move';

  private validMoves: [number, number][] = [];
  private attackPositions: [number, number][] = [];
  private previousPosition: [number, number] | null = null;

  override begin(): StateResult {
    const game = getGame();
    const unit: UnitObject = game.selectedUnit;
    if (!unit || !unit.position) {
      game.state.back();
      return 'repeat';
    }

    // If the unit already finished (e.g. returned from menu after Wait/Attack),
    // pop back to FreeState by clearing the selection and returning.
    if (unit.finished || !unit.canStillAct()) {
      game.selectedUnit = null;
      game._moveOrigin = null;
      game.highlight.clear();
      game.state.back();
      return 'repeat';
    }

    this.previousPosition = [unit.position[0], unit.position[1]];
    // Save origin so MenuState can undo the move
    game._moveOrigin = [unit.position[0], unit.position[1]];

    // Compute valid moves + attack positions
    this.validMoves = game.pathSystem.getValidMoves(unit, game.board);
    this.attackPositions = game.pathSystem.getAttackPositions(
      unit,
      game.board,
      this.validMoves,
    );

    // Show highlights
    game.highlight.clear();
    game.highlight.setMoveHighlights(this.validMoves);
    game.highlight.setAttackHighlights(this.attackPositions);
  }

  override takeInput(event: InputEvent): StateResult {
    const game = getGame();

    // Process mouse input for map interaction
    const mouseAction = processMouseForMap(event);
    const effective = mouseAction ?? event;

    if (effective === null) return;

    switch (effective) {
      case 'UP':
        moveCursor(0, -1);
        break;
      case 'DOWN':
        moveCursor(0, 1);
        break;
      case 'LEFT':
        moveCursor(-1, 0);
        break;
      case 'RIGHT':
        moveCursor(1, 0);
        break;

      case 'SELECT': {
        const pos = game.cursor.getHover();
        const isValid = this.validMoves.some(
          ([x, y]) => x === pos.x && y === pos.y,
        );
        if (isValid) {
          const unit: UnitObject = game.selectedUnit;
          const origin = this.previousPosition ?? unit.position;
          if (!origin) break;

          // Compute path from the unit's current position (before moving on the board)
          const path = game.pathSystem.getPath(
            unit,
            pos.x,
            pos.y,
            game.board,
          );

          const movementCost = path
            ? game.pathSystem.getPathCost(unit, path, game.board)
            : 0;
          const moveAction = new MoveAction(
            unit,
            [origin[0], origin[1]],
            [pos.x, pos.y],
            game.board,
            movementCost,
          );
          game.actionLog.doAction(moveAction);
          game._moveAction = moveAction;

          // Check if this movement triggers AI group activation
          if (game.aiController && unit.team === 'player') {
            game.aiController.checkGroupActivation([pos.x, pos.y], game);
          }

          // If we have a path with length > 1, animate movement
          if (path && path.length > 1) {
            game.movementSystem.beginMove(unit, path, undefined, () => {
              // After movement animation completes, push menu
            });
            game.state.change('movement');
            // After movement, push menu
            game._pendingAfterMovement = 'menu';
          } else {
            // Already at destination or single tile, push menu directly
            game.state.change('menu');
          }
        }
        break;
      }

      case 'BACK': {
        const deselectedUnit: UnitObject | null = game.selectedUnit;
        game.highlight.clear();
        game._moveOrigin = null;
        game.state.back();
        // unit_deselect fires after the cursor selection is cleared
        // (matches Python general_states.py MoveState.take_input BACK).
        if (game.eventManager && deselectedUnit && deselectedUnit.position) {
          const levelNid = game.currentLevel?.nid ?? '';
          const ctx = { game, unit1: deselectedUnit, gameVars: game.gameVars, levelVars: game.levelVars };
          game.eventManager.trigger(
            {
              type: 'unit_deselect', levelNid, unitNid: deselectedUnit.nid, unit1: deselectedUnit,
              position: [deselectedUnit.position[0], deselectedUnit.position[1]],
            },
            ctx,
          );
          if (game.eventManager.hasActiveEvents()) {
            game.state.change('event');
          }
        }
        break;
      }
    }
  }

  override draw(surf: Surface): Surface {
    const game = getGame();
    game.highlight.update();
    surf = drawMap(surf, true);

    // Draw path preview from unit to cursor
    const unit: UnitObject = game.selectedUnit;
    if (unit && unit.position) {
      const cursorPos = game.cursor.getHover();
      const isValid = this.validMoves.some(
        ([x, y]) => x === cursorPos.x && y === cursorPos.y,
      );
      if (isValid) {
        const cameraOffset = game.camera.getOffset();
        const path = game.pathSystem.getPath(
          unit,
          cursorPos.x,
          cursorPos.y,
          game.board,
        );
        if (path && path.length > 1) {
          const segments = computeArrowSegments(path);
          game.arrowRenderer.draw(surf, segments, cameraOffset, performance.now());
        }
      }
    }
    return surf;
  }

  override end(): StateResult {
    const game = getGame();
    game.highlight.clear();
  }
}

// ============================================================================
// 4. MenuState
// ============================================================================

export class MenuState extends State {
  readonly name = 'menu';
  override readonly transparent = true;

  private menu: ChoiceMenu | null = null;
  private previousPosition: [number, number] | null = null;
  private validRegions: RegionData[] = [];
  private stealAbilityItem: ItemObject | null = null;

  override begin(): StateResult {
    const game = getGame();
    const unit: UnitObject = game.selectedUnit;
    if (!unit || !unit.position) {
      game.state.back();
      return 'repeat';
    }

    // If the unit already finished (returned from a sub-state like ItemUse/Trade),
    // pop back so MoveState can clean up and return to FreeState.
    if (unit.finished || !unit.canStillAct()) {
      this.menu = null;
      game.state.back();
      return 'repeat';
    }

    this.previousPosition = game._moveOrigin ?? null;

    const options: MenuOption[] = [];
    const ux = unit.position[0];
    const uy = unit.position[1];

    // Attack option — only if enemies are in weapon range from current position
    const targets = [...new Set(getAvailableCombatItems(unit)
      .flatMap((item) => getTargetsInRange(unit, ux, uy, item)))];
    if (targets.length > 0) {
      options.push({ label: 'Attack', value: 'attack', enabled: true });
    }

    // Skill abilities are backed by item prefabs in LT. The Steal class skill
    // resolves to the project's `Steal` item and uses ordinary item targeting.
    this.stealAbilityItem = null;
    if (unit.skills.some((skill: SkillObject) => skill.getComponent<string>('ability') === 'Steal')) {
      const prefab = game.db.items.get('Steal');
      if (prefab) {
        const abilityItem = new ItemObjectClass(prefab);
        abilityItem.owner = unit;
        if ((game.targetSystem?.getValidTargets(unit, abilityItem).length ?? 0) > 0) {
          this.stealAbilityItem = abilityItem;
          options.push({ label: 'Steal', value: 'steal', enabled: true });
        }
      }
    }

    // Item option — if unit has usable healing/consumable items
    const hasUsableItem = unit.getUsableItems().some((item) =>
      itemAvailable(unit, item, game.db, game) &&
      (game.targetSystem?.getValidTargetsRecursive(unit, item).length ?? 0) > 0,
    );
    if (hasUsableItem) {
      options.push({ label: 'Item', value: 'item', enabled: true });
    }

    // Trade option — if adjacent allied unit exists and unit hasn't traded/attacked
    if (unit.canTrade()) {
      const adjacentAllies = getAdjacentAllies(unit, ux, uy);
      if (adjacentAllies.length > 0) {
        options.push({ label: 'Trade', value: 'trade', enabled: true });
      }
    }

    const pairUpEnabled = game.db.getConstant('pairup', false);
    const pairUpAllowed = pairUpEnabled && !game.db.getConstant('attack_stance_only', false);
    const rescuableUnits = getAdjacentAllies(unit, ux, uy).filter((ally) =>
      !ally.isRescued() && !ally.isRescuing() &&
      (!pairUpEnabled || ally.team === unit.team),
    );
    if (!unit.isRescuing() && !unit.isRescued() && rescuableUnits.length > 0) {
      if (pairUpAllowed) options.push({ label: 'Pair Up', value: 'pair_up', enabled: true });
      else if (!pairUpEnabled) options.push({ label: 'Rescue', value: 'rescue', enabled: true });
    }

    if (unit.isRescuing()) {
      const dropTiles = getAdjacentEmptyTiles(ux, uy, unit.rescuing);
      if (dropTiles.length > 0) {
        if (pairUpEnabled && unit.leadUnit && !unit.hasAttacked) {
          options.push({ label: 'Separate', value: 'separate', enabled: true });
        } else if (!pairUpEnabled) {
          options.push({ label: 'Drop', value: 'drop', enabled: true });
        }
      }
    }

    if (pairUpEnabled && unit.traveler && unit.rescuing &&
        canUnitStandAt(unit.rescuing, ux, uy)) {
      options.push({ label: 'Switch', value: 'switch', enabled: true });
    }

    const transferTargets = pairUpEnabled && !unit.hasGiven
      ? getAdjacentAllies(unit, ux, uy).filter((ally) => !!ally.traveler || !!unit.traveler)
      : [];
    if (transferTargets.length > 0) {
      options.push({ label: 'Transfer', value: 'transfer', enabled: true });
    }

    // Region interactions (Visit, Seize, Shop, Armory, Chest, etc.)
    // Regions with region_type === 'event' show their sub_nid as the menu label.
    this.validRegions = [];
    if (game.currentLevel?.regions) {
      for (const region of game.currentLevel.regions) {
        if (region.region_type.toLowerCase() !== 'event') continue;
        const [rx, ry] = region.position;
        const [rw, rh] = region.size;
        if (ux >= rx && ux < rx + rw && uy >= ry && uy < ry + rh) {
          // Evaluate region condition
          const condCtx: ConditionContext = {
            game, unit1: unit, region,
            gameVars: game.gameVars, levelVars: game.levelVars,
          };
          const conditionStr = region.condition ?? 'True';
          const conditionMet = evaluateCondition(conditionStr, condCtx);
          if (!conditionMet) continue;
          // No duplicate sub_nid labels
          const subNid = region.sub_nid || 'Visit';
          if (options.some(o => o.label === subNid)) continue;
          options.push({ label: subNid, value: `region_${region.nid}`, enabled: true });
          this.validRegions.push(region);
        }
      }
    }

    // Talk option — check if adjacent unit has a talk event
    const adjacentTalkTargets = getAdjacentUnits(ux, uy).filter((other) => {
      if (other === unit) return false;
      // Check if there's a talk event between these two units
      if (game.eventManager) {
        const ctx = { game, unit1: unit, unit2: other, gameVars: game.gameVars, levelVars: game.levelVars };
        const levelNid = game.currentLevel?.nid ?? '';
        const events = game.eventManager.getEventsForTrigger({
          type: 'on_talk',
          levelNid,
          unitA: unit.nid,
          unitB: other.nid,
          unit1: unit,
          unit2: other,
        }, ctx);
        if (events.length === 0) return false;
        if (game.eventManager.isTalkHidden(unit.nid, other.nid)) return false;
        return true;
      }
      return false;
    });
    if (adjacentTalkTargets.length > 0) {
      options.push({ label: 'Talk', value: 'talk', enabled: true });
    }

    // Support option — check if adjacent unit has an unlocked-but-unviewed support rank
    // Gate: _supports enabled AND support_constants.combat_convos enabled
    const supportAvailable = game.gameVars.get('_supports') &&
      game.db.supportConstants.get('combat_convos');
    const adjacentSupportTargets = supportAvailable ? getAdjacentUnits(ux, uy).filter((other) => {
      if (other === unit) return false;
      // Check if there's a support pair with can_support (unlocked-but-unviewed rank)
      const pair = game.supports?.getPair(unit.nid, other.nid);
      if (!pair) return false;
      return game.supports.canSupport(pair, game);
    }) : [];
    if (adjacentSupportTargets.length > 0) {
      options.push({ label: 'Support', value: 'support', enabled: true });
    }

    // Supply — Python SupplyAbility: _convoy enabled and unit has 'Convoy'
    // tag or an adjacent same-team ally has 'AdjConvoy'.
    if (supplyAvailableOnMap(unit, game)) {
      options.push({ label: 'Supply', value: 'supply', enabled: true });
    }

    // Wait is always available
    options.push({ label: 'Wait', value: 'wait', enabled: true });

    // Position the menu near the unit
    const cameraOffset = game.camera.getOffset();
    const menuX = ux * TILEWIDTH - cameraOffset[0] + TILEWIDTH + 4;
    const menuY = uy * TILEHEIGHT - cameraOffset[1];

    // Clamp menu to screen
    const clampedX = Math.min(menuX, viewport.width - 60);
    const clampedY = Math.min(menuY, viewport.height - options.length * 16 - 8);

    this.menu = new ChoiceMenu(options, clampedX, Math.max(0, clampedY));
  }

  override takeInput(event: InputEvent): StateResult {
    if (!this.menu) return;
    const game = getGame();

    // Handle mouse click on menu options
    let result: { selected: string } | { back: true } | null = null;
    if (game.input?.mouseClick) {
      const [gx, gy] = game.input.getGameMousePos();
      result = this.menu.handleClick(gx, gy, game.input.mouseClick as 'SELECT' | 'BACK');
    }
    // Handle mouse hover to highlight menu options
    if (game.input?.mouseMoved) {
      const [gx, gy] = game.input.getGameMousePos();
      this.menu.handleMouseHover(gx, gy);
    }
    // Fall through to keyboard input if mouse didn't produce a result
    if (!result && event !== null) {
      result = this.menu.handleInput(event);
    }
    if (!result) return;

    if ('back' in result) {
      // Remove the uncommitted move and its action-group marker. The fallback
      // supports harness-created menu states that did not originate in MoveState.
      const unit: UnitObject = game.selectedUnit;
      if (game._moveAction) {
        game.actionLog.reverseMoveToActionGroupStart(game._moveAction);
        game._moveAction = null;
      } else if (unit && game._moveOrigin) {
        game.board.moveUnit(unit, game._moveOrigin[0], game._moveOrigin[1]);
        unit.hasMoved = false;
        unit.movementLeft = unit.getStatValue('MOV');
      }
      this.menu = null;
      game.state.back();
      return;
    }

    if ('selected' in result) {
      const value = result.selected;
      const unit: UnitObject = game.selectedUnit;

      if (value === 'attack') {
        this.menu = null;
        game.state.change('weapon_choice');
      } else if (value === 'item') {
        this.menu = null;
        game.state.change('item_use');
      } else if (value === 'steal' && this.stealAbilityItem) {
        game.memory.set('item_use_item', this.stealAbilityItem);
        this.menu = null;
        game.state.change('item_targeting');
      } else if (value === 'trade') {
        this.menu = null;
        game.state.change('trade');
      } else if (value === 'rescue' || value === 'pair_up') {
        this.menu = null;
        game.state.change('rescue');
      } else if (value === 'drop' || value === 'separate') {
        this.menu = null;
        game.state.change('drop');
      } else if (value === 'switch') {
        const follower = unit.rescuing;
        if (follower && unit.position && canUnitStandAt(follower, unit.position[0], unit.position[1])) {
          game.actionLog.doAction(new SwitchPairUpAction(unit, follower, game.board, game.db));
          game.selectedUnit = follower;
          game.cursor.setPos(follower.position![0], follower.position![1]);
          this.menu = null;
          return this.begin();
        }
      } else if (value === 'supply') {
        game.memory.set('supply_unit', unit);
        this.menu = null;
        game.state.change('supply_items');
      } else if (value.startsWith('region_')) {
        // Region interaction — triggered by sub_nid (Visit, Seize, Shop, Armory, Chest, etc.)
        const regionNid = value.slice('region_'.length);
        const region = this.validRegions.find((r) => r.nid === regionNid);
        const subNid = region?.sub_nid || '';
        const levelNid = game.currentLevel?.nid ?? '';
        const ctx = { game, unit1: unit, position: unit.position, region, gameVars: game.gameVars, levelVars: game.levelVars };
        let didTrigger = false;
        if (game.eventManager) {
          // Try region sub_nid as trigger type first (e.g., 'Visit', 'Seize', 'Armory')
          if (subNid) {
            didTrigger = game.eventManager.trigger(
              { type: subNid, levelNid, regionNid, unitNid: unit.nid, unit1: unit, region },
              ctx,
            );
          }

          // Compatibility fallback for destructible village events where LT data
          // conditions target the sibling "VillageX" region while interaction
          // originates from "DestroyVillageX".
          if (!didTrigger && subNid === 'Destructible' && region?.nid?.startsWith('Destroy') && game.currentLevel?.regions) {
            const aliasNid = region.nid.replace(/^Destroy/, '');
            const aliasRegion = game.currentLevel.regions.find(
              (r: RegionData) => r.nid === aliasNid,
            );
            if (aliasRegion) {
              const aliasCtx = {
                game,
                unit1: unit,
                position: unit.position,
                region: aliasRegion,
                gameVars: game.gameVars,
                levelVars: game.levelVars,
              };
              didTrigger = game.eventManager.trigger(
                { type: subNid, levelNid, regionNid: aliasRegion.nid, unitNid: unit.nid, unit1: unit, region: aliasRegion },
                aliasCtx,
              );
            }
          }

          // Fallback to generic on_region_interact
          if (!didTrigger) {
            didTrigger = game.eventManager.trigger(
              { type: 'on_region_interact', levelNid, regionNid, unitNid: unit.nid, unit1: unit, region },
              ctx,
            );
          }
        }
        // Remove only_once regions after triggering. For village tiles that
        // define both Visit + Destructible sibling regions on the same tile,
        // consume both siblings so interaction order stays one-time.
        if (didTrigger && region?.only_once && game.currentLevel?.regions) {
          const siblingNid = regionNid.startsWith('Destroy')
            ? regionNid.replace(/^Destroy/, '')
            : `Destroy${regionNid}`;
          const sibling = game.currentLevel.regions.find(
            (r: RegionData) =>
              r.nid === siblingNid &&
              r.region_type.toLowerCase() === 'event' &&
              r.position[0] === region.position[0] &&
              r.position[1] === region.position[1],
          );
          game.actionLog.doAction(new RemoveRegionAction(regionNid, game.currentLevel.regions));
          if (sibling) {
            game.actionLog.doAction(new RemoveRegionAction(sibling.nid, game.currentLevel.regions));
          }
        }
        if (unit) game.actionLog.doAction(new WaitAction(unit));
        this.menu = null;
        // Seize also checks win condition immediately
        if (subNid === 'Seize') {
          if (game.checkWinCondition()) {
            console.warn('VICTORY — seize condition met');
          }
        }
        if (game.eventManager?.hasActiveEvents()) {
          game.state.change('event');
        } else {
          game.state.back();
        }
      } else if (value === 'talk') {
        // Trigger talk event using 'on_talk' trigger type (matches LT Python)
        const adjacentTalkTargets = getAdjacentUnits(
          unit.position![0],
          unit.position![1],
        ).filter((other) => {
          if (other === unit) return false;
          if (game.eventManager) {
            const ctx = { game, unit1: unit, unit2: other, gameVars: game.gameVars, levelVars: game.levelVars };
            const levelNid = game.currentLevel?.nid ?? '';
            const events = game.eventManager.getEventsForTrigger({
              type: 'on_talk',
              levelNid,
              unitA: unit.nid,
              unitB: other.nid,
              unit1: unit,
              unit2: other,
            }, ctx);
            return events.length > 0;
          }
          return false;
        });
        if (adjacentTalkTargets.length > 0 && game.eventManager) {
          const target = adjacentTalkTargets[0];
          const talkLevelNid = game.currentLevel?.nid ?? '';
          const ctx = { game, unit1: unit, unit2: target, gameVars: game.gameVars, levelVars: game.levelVars };
          game.eventManager.trigger(
            {
              type: 'on_talk',
              levelNid: talkLevelNid,
              unitA: unit.nid,
              unitB: target.nid,
              unit1: unit,
              unit2: target,
            },
            ctx,
          );
        }
        if (unit) game.actionLog.doAction(new WaitAction(unit));
        this.menu = null;
        if (game.eventManager?.hasActiveEvents()) {
          game.state.change('event');
        } else {
          game.state.back();
        }
      } else if (value === 'support') {
        // Trigger support event using 'on_support' trigger type (matches LT Python)
        const adjacentSupportTargets = getAdjacentUnits(
          unit.position![0],
          unit.position![1],
        ).filter((other) => {
          if (other === unit) return false;
          const pair = game.supports?.getPair(unit.nid, other.nid);
          if (!pair) return false;
          return game.supports.canSupport(pair, game);
        });
        if (adjacentSupportTargets.length > 0 && game.supports && game.eventManager) {
          const target = adjacentSupportTargets[0];
          const pair = game.supports.getPair(unit.nid, target.nid);
          if (pair && pair.lockedRanks.length > 0) {
            const rank = pair.lockedRanks[0];
            // Match Python flow: back, HasTraded, trigger, unlock
            game.state.back();
            game.actionLog.doAction(new HasTradedAction(unit));
            const supportLevelNid = game.currentLevel?.nid ?? '';
            const ctx = {
              game,
              unit1: unit,
              unit2: target,
              gameVars: game.gameVars,
              levelVars: game.levelVars,
            };
            game.eventManager.trigger(
              {
                type: 'on_support',
                levelNid: supportLevelNid,
                unit1: unit,
                unit2: target,
                position: unit.position,
                support_rank_nid: rank,
                is_replay: false,
              },
              ctx,
            );
            // Mark the rank as viewed (unlock it)
            game.actionLog.doAction(new UnlockSupportRankAction(pair, rank));
            this.menu = null;
            if (game.eventManager?.hasActiveEvents()) {
              game.state.change('event');
            }
            return;
          }
        }
        // Should not reach here if menu option is properly gated
        if (unit) game.actionLog.doAction(new WaitAction(unit));
        this.menu = null;
        if (game.eventManager?.hasActiveEvents()) {
          game.state.change('event');
        } else {
          game.state.back();
        }
      } else if (value === 'wait') {
        // unit_wait fires before the unit is marked finished (matches
        // Python unit_funcs.wait(), called with actively_chosen=True here).
        if (unit && unit.position && game.eventManager) {
          const levelNid = game.currentLevel?.nid ?? '';
          const region = getRegionUnderPos(unit.position[0], unit.position[1]);
          const ctx = { game, unit1: unit, region, gameVars: game.gameVars, levelVars: game.levelVars };
          game.eventManager.trigger(
            {
              type: 'unit_wait', levelNid, unitNid: unit.nid, unit1: unit,
              position: [unit.position[0], unit.position[1]],
              region: region ?? undefined,
              localArgs: new Map<string, any>([['actively_chosen', true]]),
            },
            ctx,
          );
        }
        // Record end of action group (turnwheel marker)
        game.actionLog.doAction(new MarkActionGroupEnd('menu'));
        if (unit) game.actionLog.doAction(new WaitAction(unit));
        this.menu = null;
        game.state.back();
        if (game.eventManager?.hasActiveEvents()) {
          game.state.change('event');
        }
      }
    }
  }

  override draw(surf: Surface): Surface {
    if (this.menu) {
      this.menu.draw(surf);
    }
    return surf;
  }
}

// ============================================================================
// 4b. ItemUseState - Select and use a consumable item
// ============================================================================

/**
 * Shared promotion/class-change core: applies the class-swap action, grants
 * the new class's starting wexp (flat, additive -- matches Python's
 * action.AddWexp), and grants the new class's learned skills up to the
 * unit's current level (matching event_functions.py promote/change_class).
 * Every mutation goes through the reversible action log so turnwheel undo
 * restores class, stats, wexp, and skills exactly.
 */
export function performPromotionOrClassChange(
  unit: UnitObject,
  newKlass: string,
  game: any,
  kind: 'promote' | 'change_class' = 'promote',
): { statChanges: Record<string, number> } {
  const action = kind === 'promote'
    ? new PromoteAction(unit, newKlass)
    : new ClassChangeAction(unit, newKlass);
  game.actionLog.doAction(action);

  const { statChanges, newWexp } = action.getData();
  for (const [weaponNid, value] of Object.entries(newWexp)) {
    if (value > 0) {
      game.actionLog.doAction(new GainWexpAction(unit, weaponNid, value));
    }
  }

  const unitKlass = game.db.classes.get(unit.klass);
  if (unitKlass?.learned_skills) {
    for (const [levelNeeded, classSkillNid] of unitKlass.learned_skills) {
      if (unit.level >= levelNeeded && !unit.skills.some((s: SkillObject) => s.nid === classSkillNid)) {
        const skillPrefab = game.db.skills.get(classSkillNid);
        if (skillPrefab) {
          game.actionLog.doAction(new AddSkillAction(unit, new SkillObject(skillPrefab)));
        }
      }
    }
  }
  return { statChanges: { ...statChanges } };
}

function applyCoreTargetedEffects(
  unit: UnitObject,
  item: ItemObject,
  position: [number, number],
  targetItem: ItemObject | null = null,
): boolean {
  const game = getGame();
  if (!game.targetSystem) return false;
  const resolved = game.targetSystem.getTargetFromPosition(unit, item, position);
  const positions = new Map<string, [number, number]>();
  if (resolved.mainTarget) positions.set(`${resolved.mainTarget[0]},${resolved.mainTarget[1]}`, resolved.mainTarget);
  for (const splashPosition of resolved.splash) {
    positions.set(`${splashPosition[0]},${splashPosition[1]}`, splashPosition);
  }

  let applied = false;
  if (item.hasComponent('heal') || item.hasComponent('equation_heal')) {
    let healAmount = item.getComponent<number>('heal') ?? 0;
    const equationNid = item.getComponent<string>('equation_heal');
    if (equationNid) {
      const expression = game.db.getEquation(equationNid) ?? equationNid;
      healAmount = evaluateEquation(expression, unit, { db: game.db, item });
    }
    for (const targetPosition of positions.values()) {
      const target = game.board.getUnit(targetPosition[0], targetPosition[1]);
      if (target && target.currentHp < target.maxHp) {
        game.actionLog.doAction(new HealAction(target, healAmount));
        applied = true;
      }
    }
  }

  const statusNids = [
    item.getComponent<string>('status_on_hit'),
    item.getComponent<string>('status_after_combat_on_hit'),
  ].filter((nid): nid is string => !!nid);
  if (statusNids.length > 0) {
    for (const targetPosition of positions.values()) {
      const target = game.board.getUnit(targetPosition[0], targetPosition[1]);
      if (!target) continue;
      for (const statusNid of statusNids) {
        const prefab = game.db.skills.get(statusNid);
        if (prefab && !target.skills.some((skill: SkillObject) => skill.nid === statusNid)) {
          const statusSkill = new SkillObject(prefab);
          statusSkill.initiatorNid = unit.nid;
          game.actionLog.doAction(new AddSkillAction(target, statusSkill));
          applied = true;
        }
      }
    }
  }

  if (item.hasComponent('restore') || item.hasComponent('restore_specific')) {
    const specific = item.getComponent<string>('restore_specific');
    for (const targetPosition of positions.values()) {
      const target = game.board.getUnit(targetPosition[0], targetPosition[1]);
      if (!target) continue;
      const removable = target.skills.filter((skill: SkillObject) =>
        specific ? skill.nid === specific : skill.hasComponent('negative'),
      );
      for (const skill of removable) {
        game.actionLog.doAction(new RemoveSkillAction(target, skill));
        applied = true;
      }
    }
  }

  if (item.hasComponent('refresh')) {
    for (const targetPosition of positions.values()) {
      const target = game.board.getUnit(targetPosition[0], targetPosition[1]);
      if (target?.finished) {
        game.actionLog.doAction(new RefreshUnitAction(target));
        applied = true;
      }
    }
  }

  if (item.hasComponent('repair')) {
    const target = resolved.mainTarget
      ? game.board.getUnit(resolved.mainTarget[0], resolved.mainTarget[1])
      : null;
    if (target && targetItem && target.items.includes(targetItem) && isRepairableItem(targetItem)) {
      game.actionLog.doAction(new SetItemUsesAction(targetItem, targetItem.maxUses));
      applied = true;
    }
  }

  // Single-option promotion/force-promotion. Multi-option promotion is
  // routed through ItemTargetingState.selectTarget -> 'promotion_choice'
  // instead, since it needs a choice menu; this only covers the direct
  // (e.g. self-target) path used for uniform application logic.
  if (item.hasComponent('promote') || item.hasComponent('force_promote')) {
    const forceKlass = item.getComponent<string>('force_promote');
    for (const targetPosition of positions.values()) {
      const target = game.board.getUnit(targetPosition[0], targetPosition[1]);
      if (!target) continue;
      let options: string[] = [];
      if (forceKlass) {
        options = [forceKlass];
      } else {
        const klass = game.db.classes.get(target.klass);
        options = klass?.turns_into ? [...klass.turns_into] : [];
      }
      if (options.length === 1) {
        performPromotionOrClassChange(target, options[0], game, 'promote');
        applied = true;
      }
    }
  }
  const forcedClass = item.getComponent<string>('force_class_change');
  if (forcedClass && game.db.classes.has(forcedClass)) {
    for (const targetPosition of positions.values()) {
      const target = game.board.getUnit(targetPosition[0], targetPosition[1]);
      if (!target) continue;
      performPromotionOrClassChange(target, forcedClass, game, 'change_class');
      applied = true;
    }
  }


  // Generated item hooks run in component insertion order. Preserve that
  // ordering when one custom booster combines several permanent mutations.
  for (const targetPosition of positions.values()) {
    const target = game.board.getUnit(targetPosition[0], targetPosition[1]);
    if (!target) continue;

    for (const componentNid of item.components.keys()) {
      if (componentNid === 'permanent_stat_change') {
        game.actionLog.doAction(new ApplyStatChangesAction(
          target,
          item.getNumericComponentMap(componentNid),
        ));
        applied = true;
      } else if (componentNid === 'permanent_growth_change') {
        game.actionLog.doAction(new ChangeUnitRecordAction(
          target,
          'growths',
          item.getNumericComponentMap(componentNid),
          'add',
        ));
        applied = true;
      } else if (componentNid === 'permanent_statcap_change') {
        game.actionLog.doAction(new ChangeUnitRecordAction(
          target,
          'statCapModifiers',
          item.getNumericComponentMap(componentNid),
          'add',
        ));
        applied = true;
      } else if (componentNid === 'wexp_change') {
        for (const [weaponType, amount] of Object.entries(
          item.getNumericComponentMap(componentNid),
        )) {
          const action = new GainWexpAction(target, weaponType, amount);
          game.actionLog.doAction(action);
          const rankUp = action.getRankUp();
          if (rankUp) {
            game.eventManager?.trigger(
              {
                type: 'unit_weapon_rank_up',
                levelNid: game.currentLevel?.nid ?? '',
                unitNid: target.nid,
                unit1: target,
                item,
                weaponType,
                oldWexp: action.getOldWexp(),
                rank: rankUp.rank,
              },
              {
                game,
                unit1: target,
                item,
                position: target.position,
                gameVars: game.gameVars,
                levelVars: game.levelVars,
              },
            );
          }
        }
        applied = true;
      }
    }
  }
  return applied;
}

function effectUnits(
  unit: UnitObject,
  item: ItemObject,
  position: [number, number],
): UnitObject[] {
  const game = getGame();
  const resolved = game.targetSystem.getTargetFromPosition(unit, item, position);
  const units = new Map<string, UnitObject>();
  for (const targetPosition of [resolved.mainTarget, ...resolved.splash]) {
    if (!targetPosition) continue;
    const target = game.board.getUnit(targetPosition[0], targetPosition[1]);
    if (target && !target.tags.includes('Tile')) units.set(target.nid, target);
  }
  return [...units.values()];
}

function finishCoreItemUse(
  unit: UnitObject,
  item: ItemObject,
  targets: UnitObject[] = [],
  healingDone: Map<UnitObject, number> = new Map(),
): void {
  const game = getGame();
  const uniqueTargets = [...new Map(targets.map((target) => [target.nid, target])).values()];
  const weaponType = item.getComponent<string>('weapon_type');
  const wexpValue = weaponType ? Number(item.getComponent<number>('wexp') ?? 1) : 0;
  if (weaponType && wexpValue > 0 && uniqueTargets.length > 0) {
    const rewardTargets = game.db.getConstant('double_wexp', false)
      ? uniqueTargets
      : [uniqueTargets[0]];
    for (const target of rewardTargets) {
      const amount = Math.floor(
        wexpValue * wexpMultiplier(unit, target) * enemyWexpMultiplier(target, unit),
      );
      if (amount > 0) game.actionLog.doAction(new GainWexpAction(unit, weaponType, amount));
    }
  }

  const expValue = Number(item.getComponent<number>('exp') ?? 0);
  if (unit.team === 'player' && expValue !== 0 && uniqueTargets.length > 0) {
    let amount = 0;
    for (const target of uniqueTargets) {
      amount += expValue * expMultiplier(unit, target) * enemyExpMultiplier(target, unit);
    }
    const minExp = Number(game.db.getConstant('min_exp', 0));
    amount = Math.max(minExp, Math.min(100, Math.floor(amount)));
    if (amount !== 0) {
      game.actionLog.doAction(new GainExpAction(unit, amount, game.currentMode?.growths ?? 'random'));
    }
  }

  if (unit.team === 'player' && item.hasComponent('heal_exp')) {
    const promoteReset = game.db.getConstant('promote_level_reset', false);
    const unitLevel = promoteReset ? internalLevel(unit, game.db) : unit.level;
    const curve = Number(game.db.getConstant('heal_curve', 0));
    const magnitude = Number(game.db.getConstant('heal_magnitude', 0));
    const offset = Number(game.db.getConstant('heal_offset', 11));
    const minimum = Number(game.db.getConstant('heal_min', 11));
    let amount = 0;
    for (const healed of healingDone.values()) {
      if (healed <= 0) continue;
      amount += Math.max(curve * (healed - unitLevel + offset) + magnitude, minimum);
    }
    amount = Math.max(0, Math.min(100, Math.trunc(amount)));
    if (amount > 0) {
      game.actionLog.doAction(new GainExpAction(unit, amount, game.currentMode?.growths ?? 'random'));
    }
  }

  const fatigue = item.getComponent<number>('fatigue');
  if (typeof fatigue === 'number' && fatigue !== 0) {
    game.actionLog.doAction(new ChangeFatigueAction(unit, fatigue));
  }

  if (item.maxUses > 0) {
    const nextUses = Math.max(0, item.uses - 1);
    game.actionLog.doAction(new SetItemUsesAction(item, nextUses));
    if (nextUses === 0 && !item.hasComponent('no_break_out_of_uses') && unit.items.includes(item)) {
      game.actionLog.doAction(new RemoveItemFromUnitAction(unit, item));
    }
  }
  game.actionLog.doAction(new WaitAction(unit));
  game.actionLog.doAction(new MarkActionGroupEnd('item_use'));
}

export function applyCoreTargetedItem(
  unit: UnitObject,
  item: ItemObject,
  position: [number, number],
  targetItem: ItemObject | null = null,
): boolean {
  const targets = effectUnits(unit, item, position);
  const hpBefore = new Map(targets.map((target) => [target, target.currentHp]));
  if (!applyCoreTargetedEffects(unit, item, position, targetItem)) return false;
  const healingDone = new Map(
    targets.map((target) => [target, Math.max(0, target.currentHp - (hpBefore.get(target) ?? target.currentHp))]),
  );
  finishCoreItemUse(unit, item, targets, healingDone);
  return true;
}

/** Apply one multi-target item's effects to each selected main position, consuming it once. */
export function applyCoreMultiTargetedItem(
  unit: UnitObject,
  item: ItemObject,
  positions: [number, number][],
): boolean {
  let applied = false;
  const targets = new Map<string, UnitObject>();
  const hpBefore = new Map<UnitObject, number>();
  for (const position of positions) {
    for (const target of effectUnits(unit, item, position)) {
      targets.set(target.nid, target);
      if (!hpBefore.has(target)) hpBefore.set(target, target.currentHp);
    }
    applied = applyCoreTargetedEffects(unit, item, position) || applied;
  }
  if (!applied) return false;
  const healingDone = new Map(
    [...targets.values()].map((target) => [
      target,
      Math.max(0, target.currentHp - (hpBefore.get(target) ?? target.currentHp)),
    ]),
  );
  finishCoreItemUse(unit, item, [...targets.values()], healingDone);
  return true;
}

/** Resolve sequence children in order, including LT's store_unit → unload_unit warp pair. */
export function applyCoreSequenceItem(
  unit: UnitObject,
  item: ItemObject,
  targetsByItem: [number, number][][],
): boolean {
  const game = getGame();
  if (!item.hasComponent('sequence_item') || item.subitems.length === 0) return false;
  let storedUnit: UnitObject | null = null;
  let applied = false;
  const targets = new Map<string, UnitObject>();

  for (let childIndex = 0; childIndex < item.subitems.length; childIndex++) {
    const child = item.subitems[childIndex];
    for (const position of targetsByItem[childIndex] ?? []) {
      for (const target of effectUnits(unit, child, position)) targets.set(target.nid, target);
      const resolved = game.targetSystem.getTargetFromPosition(unit, child, position);
      if (child.hasComponent('store_unit') && resolved.mainTarget) {
        const target = game.board.getUnit(resolved.mainTarget[0], resolved.mainTarget[1]);
        if (target && !ignoreForcedMovement(target)) storedUnit = target;
      }
      if (child.hasComponent('unload_unit') && storedUnit &&
          !game.board.getUnit(position[0], position[1])) {
        game.actionLog.doAction(new WarpUnitAction(storedUnit, position, game.board));
        applied = true;
        storedUnit = null;
      }
      applied = applyCoreTargetedEffects(unit, child, position) || applied;
    }
  }

  if (!applied) return false;
  finishCoreItemUse(unit, item, [...targets.values()]);
  return true;
}

export class ItemUseState extends State {
  readonly name = 'item_use';
  override readonly transparent = true;

  private menu: ChoiceMenu | null = null;
  private usableItems: ItemObject[] = [];
  private topLevelItems: ItemObject[] = [];
  private parentItem: ItemObject | null = null;

  private setItemMenu(items: ItemObject[], unit: UnitObject): void {
    const game = getGame();
    this.usableItems = items;
    const options: MenuOption[] = items.map((item, i) => ({
      label: item.name,
      value: `item_${i}`,
      enabled: itemAvailable(unit, item, game.db, game) &&
        (game.targetSystem?.getValidTargetsRecursive(unit, item).length ?? 0) > 0,
    }));
    const cameraOffset = game.camera.getOffset();
    const menuX = unit.position
      ? unit.position[0] * TILEWIDTH - cameraOffset[0] + TILEWIDTH + 4
      : viewport.width / 2;
    const menuY = unit.position
      ? unit.position[1] * TILEHEIGHT - cameraOffset[1]
      : viewport.height / 2;
    const clampedX = Math.min(menuX, viewport.width - 70);
    const clampedY = Math.min(menuY, viewport.height - options.length * 16 - 8);
    this.menu = new ChoiceMenu(options, clampedX, Math.max(0, clampedY));
  }

  override begin(): StateResult {
    const game = getGame();
    const unit: UnitObject = game.selectedUnit;
    if (!unit) {
      game.state.back();
      return;
    }

    if (unit.finished) {
      game.state.back();
      return 'repeat';
    }

    this.parentItem = null;
    this.topLevelItems = unit.getUsableItems().filter((item) =>
      itemAvailable(unit, item, game.db, game) &&
      (game.targetSystem?.getValidTargetsRecursive(unit, item).length ?? 0) > 0,
    );
    if (this.topLevelItems.length === 0) {
      game.state.back();
      return;
    }
    this.setItemMenu(this.topLevelItems, unit);
  }

  override takeInput(event: InputEvent): StateResult {
    if (!this.menu) return;
    const game = getGame();

    let result: { selected: string } | { back: true } | null = null;
    if (game.input?.mouseClick) {
      const [gx, gy] = game.input.getGameMousePos();
      result = this.menu.handleClick(gx, gy, game.input.mouseClick as 'SELECT' | 'BACK');
    }
    if (game.input?.mouseMoved) {
      const [gx, gy] = game.input.getGameMousePos();
      this.menu.handleMouseHover(gx, gy);
    }
    if (!result && event !== null) result = this.menu.handleInput(event);
    if (!result) return;

    if ('back' in result) {
      if (this.parentItem) {
        this.parentItem = null;
        this.setItemMenu(this.topLevelItems, game.selectedUnit);
        return;
      }
      this.menu = null;
      game.state.back();
      return;
    }

    if ('selected' in result) {
      const idx = parseInt(result.selected.replace('item_', ''), 10);
      const item = this.usableItems[idx];
      const unit: UnitObject = game.selectedUnit;

      if (item && unit) {
        if (!this.parentItem && item.hasComponent('multi_item') && item.subitems.length > 0) {
          const hideUnavailable = item.hasComponent('multi_item_hides_unavailable');
          const children = hideUnavailable
            ? item.subitems.filter((child) => itemAvailable(unit, child, game.db, game))
            : [...item.subitems];
          if (children.length > 0) {
            this.parentItem = item;
            this.setItemMenu(children, unit);
          }
          return;
        }
        const targets = game.targetSystem?.getValidTargetsRecursive(unit, item) ?? [];
        // Promotion items always route through ItemTargetingState so that
        // multi-option promotions can present the choice menu, even when
        // (as with the default project's crests/seals) the only valid
        // target is the user.
        const needsPromotionRouting = item.hasComponent('promote') || item.hasComponent('force_promote');
        if (item.hasCoreUseEffect() && !item.hasComponent('sequence_item') && !needsPromotionRouting &&
            targets.length === 1 && unit.position &&
            targets[0][0] === unit.position[0] && targets[0][1] === unit.position[1]) {
          applyCoreTargetedItem(unit, item, targets[0]);
          this.menu = null;
          game.state.back();
          return;
        }
        if (targets.length > 0) {
          game.memory.set('item_use_item', item);
          this.menu = null;
          game.state.change('item_targeting');
          return;
        }
      }
    }
  }

  override draw(surf: Surface): Surface {
    if (this.menu) {
      this.menu.draw(surf);
    }
    return surf;
  }
}

// ============================================================================
// 4c. ItemTargetingState - Select a component-valid tile for a usable item
// ============================================================================

export class ItemTargetingState extends MapState {
  readonly name = 'item_targeting';

  private item: ItemObject | null = null;
  private targets: [number, number][] = [];
  private targetIndex = 0;
  private sequenceIndex = 0;
  private selectedTargets: [number, number][][] = [];
  private targetItemMenu: ChoiceMenu | null = null;
  private pendingTarget: [number, number] | null = null;
  private selectableTargetItems: ItemObject[] = [];
  private targetItemMode: 'repair' | 'steal' | null = null;

  /** Kept as a read-only runtime alias for repair-menu diagnostics/tests. */
  private get repairableItems(): ItemObject[] {
    return this.targetItemMode === 'repair' ? this.selectableTargetItems : [];
  }

  override begin(): StateResult {
    const game = getGame();
    const unit: UnitObject | null = game.selectedUnit;
    this.item = game.memory.get('item_use_item') ?? null;
    // Combat-routed spells finish the unit in CombatState. Unwind the item
    // targeting/menu stack when this state resumes beneath combat.
    if (unit?.finished) {
      game.memory.delete('item_use_item');
      game.state.back();
      return 'repeat';
    }
    if (!unit || !this.item || !game.targetSystem) {
      game.state.back();
      return 'repeat';
    }
    if (this.item.hasComponent('sequence_item') && this.item.subitems.length === 0) {
      game.memory.delete('item_use_item');
      game.state.back();
      return 'repeat';
    }
    this.sequenceIndex = 0;
    this.selectedTargets = [[]];
    this.targetItemMenu = null;
    this.pendingTarget = null;
    this.selectableTargetItems = [];
    this.targetItemMode = null;
    if (!this.configureTargets(unit)) {
      game.memory.delete('item_use_item');
      game.state.back();
      return 'repeat';
    }
  }

  private activeItem(): ItemObject | null {
    if (!this.item) return null;
    return this.item.hasComponent('sequence_item')
      ? this.item.subitems[this.sequenceIndex] ?? null
      : this.item;
  }

  private configureTargets(unit: UnitObject): boolean {
    const game = getGame();
    const activeItem = this.activeItem();
    if (!activeItem || !game.targetSystem) return false;
    let targets = game.targetSystem.getValidTargets(unit, activeItem);
    const sameTargetPolicy = this.item?.hasComponent('sequence_item') ? this.item : activeItem;
    if (sameTargetPolicy && !allowSameTarget(unit, sameTargetPolicy)) {
      const used = new Set(this.selectedTargets.flat().map((position) => `${position[0]},${position[1]}`));
      targets = targets.filter((position: [number, number]) => !used.has(`${position[0]},${position[1]}`));
    }
    this.targets = targets;
    this.targetIndex = 0;
    game.highlight.clear();
    game.highlight.setAttackHighlights(this.targets);
    if (this.targets.length > 0) this.focusTarget();
    return this.targets.length > 0;
  }

  private focusTarget(): void {
    const game = getGame();
    const target = this.targets[this.targetIndex];
    if (!target) return;
    game.cursor.setPos(target[0], target[1]);
    if (isSmallScreen()) game.camera.focusTile(target[0], target[1]);
  }

  private selectTarget(index: number): void {
    const game = getGame();
    const unit: UnitObject | null = game.selectedUnit;
    const target = this.targets[index];
    const activeItem = this.activeItem();
    if (!unit || !this.item || !activeItem || !target) return;

    const combatStatus = activeItem.hasComponent('hit') &&
      (activeItem.hasComponent('status_on_hit') || activeItem.hasComponent('status_after_combat_on_hit'));
    if (activeItem === this.item && combatStatus) {
      const defender = game.board.getUnit(target[0], target[1]);
      if (!defender) return;
      game.memory.set('combat_item', activeItem);
      game.combatTarget = defender;
      game.highlight.clear();
      game.state.change('combat');
      return;
    }

    if (activeItem === this.item &&
        (activeItem.hasComponent('promote') || activeItem.hasComponent('force_promote'))) {
      const defender = game.board.getUnit(target[0], target[1]);
      if (!defender) return;
      const forceKlass = activeItem.getComponent<string>('force_promote');
      let options: string[];
      if (forceKlass) {
        options = [forceKlass];
      } else {
        const klass = game.db.classes.get(defender.klass);
        options = klass?.turns_into ? [...klass.turns_into] : [];
      }
      if (options.length === 0) return;
      if (options.length === 1) {
        performPromotionOrClassChange(defender, options[0], game, 'promote');
        finishCoreItemUse(unit, this.item, [defender]);
        game.memory.delete('item_use_item');
        game.highlight.clear();
        game.state.back();
        return;
      }
      // Multiple promotion options: route to the choice menu state, matching
      // Python's game.state 'promotion_choice'.
      game.memory.set('promotion_choice_unit', defender);
      game.memory.set('promotion_choice_options', options);
      game.memory.set('promotion_choice_item', this.item);
      game.memory.set('promotion_choice_actor', unit);
      game.highlight.clear();
      game.state.change('promotion_choice');
      return;
    }

    if (activeItem === this.item && activeItem.hasComponent('repair')) {
      const defender = game.board.getUnit(target[0], target[1]);
      this.selectableTargetItems = defender?.items.filter(isRepairableItem) ?? [];
      if (this.selectableTargetItems.length === 0) return;
      this.pendingTarget = target;
      this.targetItemMode = 'repair';
      const options: MenuOption[] = this.selectableTargetItems.map((candidate, itemIndex) => ({
        label: `${candidate.name} ${candidate.uses}/${candidate.maxUses}`,
        value: `repair_${itemIndex}`,
        enabled: true,
      }));
      const [cameraX, cameraY] = game.camera.getOffset();
      const menuX = Math.min(target[0] * TILEWIDTH - cameraX + TILEWIDTH + 4, viewport.width - 100);
      const menuY = Math.min(target[1] * TILEHEIGHT - cameraY, viewport.height - options.length * 16 - 8);
      this.targetItemMenu = new ChoiceMenu(options, Math.max(0, menuX), Math.max(0, menuY));
      return;
    }

    if (activeItem === this.item &&
        (activeItem.hasComponent('steal') || activeItem.hasComponent('gba_steal'))) {
      const defender = game.board.getUnit(target[0], target[1]);
      this.selectableTargetItems = defender?.items.filter((candidate: ItemObject) =>
        stealItemRestrict(unit, activeItem, defender, candidate, game.db),
      ) ?? [];
      if (!defender || this.selectableTargetItems.length === 0) return;
      this.pendingTarget = target;
      this.targetItemMode = 'steal';
      const options: MenuOption[] = this.selectableTargetItems.map((candidate, itemIndex) => ({
        label: candidate.name,
        value: `steal_${itemIndex}`,
        enabled: true,
      }));
      const [cameraX, cameraY] = game.camera.getOffset();
      const menuX = Math.min(target[0] * TILEWIDTH - cameraX + TILEWIDTH + 4, viewport.width - 100);
      const menuY = Math.min(target[1] * TILEHEIGHT - cameraY, viewport.height - options.length * 16 - 8);
      this.targetItemMenu = new ChoiceMenu(options, Math.max(0, menuX), Math.max(0, menuY));
      return;
    }

    this.selectedTargets[this.sequenceIndex].push(target);
    if (this.selectedTargets[this.sequenceIndex].length < numTargets(unit, activeItem)) {
      if (!this.configureTargets(unit)) this.cancelTargeting();
      return;
    }
    this.completeTargetGroup(unit);
  }

  private completeTargetGroup(unit: UnitObject): void {
    const game = getGame();
    if (!this.item) return;
    if (this.item.hasComponent('sequence_item') && this.sequenceIndex < this.item.subitems.length - 1) {
      this.sequenceIndex += 1;
      this.selectedTargets.push([]);
      if (!this.configureTargets(unit)) this.cancelTargeting();
      return;
    }

    const applied = this.item.hasComponent('sequence_item')
      ? applyCoreSequenceItem(unit, this.item, this.selectedTargets)
      : applyCoreMultiTargetedItem(unit, this.item, this.selectedTargets[0]);
    if (applied) {
      game.memory.delete('item_use_item');
      game.highlight.clear();
      game.state.back();
    }
  }

  private cancelTargeting(): void {
    const game = getGame();
    game.memory.delete('item_use_item');
    game.highlight.clear();
    game.state.back();
  }

  override takeInput(event: InputEvent): StateResult {
    const game = getGame();
    if (this.targetItemMenu) {
      let menuResult: { selected: string } | { back: true } | null = null;
      if (game.input?.mouseClick) {
        const [gx, gy] = game.input.getGameMousePos();
        menuResult = this.targetItemMenu.handleClick(
          gx,
          gy,
          game.input.mouseClick as 'SELECT' | 'BACK',
        );
      }
      if (game.input?.mouseMoved) {
        const [gx, gy] = game.input.getGameMousePos();
        this.targetItemMenu.handleMouseHover(gx, gy);
      }
      if (!menuResult && event !== null) menuResult = this.targetItemMenu.handleInput(event);
      if (!menuResult) return;
      if ('back' in menuResult) {
        this.targetItemMenu = null;
        this.pendingTarget = null;
        this.selectableTargetItems = [];
        this.targetItemMode = null;
        return;
      }
      const itemIndex = Number.parseInt(menuResult.selected.replace(/^(repair|steal)_/, ''), 10);
      const unit: UnitObject | null = game.selectedUnit;
      const targetItem = this.selectableTargetItems[itemIndex];
      if (this.targetItemMode === 'steal' && unit && this.item && this.pendingTarget && targetItem) {
        const defender = game.board.getUnit(this.pendingTarget[0], this.pendingTarget[1]);
        if (defender) {
          this.item.data.set('target_item', targetItem);
          game.memory.set('combat_item', this.item);
          game.combatTarget = defender;
          game.highlight.clear();
          this.targetItemMenu = null;
          this.pendingTarget = null;
          this.selectableTargetItems = [];
          this.targetItemMode = null;
          game.state.change('combat');
        }
        return;
      }
      if (this.targetItemMode === 'repair' && unit && this.item && this.pendingTarget && targetItem &&
          applyCoreTargetedItem(unit, this.item, this.pendingTarget, targetItem)) {
        game.memory.delete('item_use_item');
        game.highlight.clear();
        this.targetItemMenu = null;
        this.pendingTarget = null;
        this.selectableTargetItems = [];
        this.targetItemMode = null;
        game.state.back();
      }
      return;
    }

    if (game.input?.mouseClick === 'SELECT') {
      const tile = getMouseTile();
      if (tile) {
        const index = this.targets.findIndex((target) => target[0] === tile[0] && target[1] === tile[1]);
        if (index >= 0) { this.selectTarget(index); return; }
      }
    }
    if (game.input?.mouseClick === 'BACK') {
      this.cancelTargeting();
      return;
    }
    if (event === null) return;
    if (event === 'UP' || event === 'LEFT') {
      this.targetIndex = (this.targetIndex - 1 + this.targets.length) % this.targets.length;
      this.focusTarget();
    } else if (event === 'DOWN' || event === 'RIGHT') {
      this.targetIndex = (this.targetIndex + 1) % this.targets.length;
      this.focusTarget();
    } else if (event === 'SELECT') {
      this.selectTarget(this.targetIndex);
    } else if (event === 'START') {
      const unit: UnitObject | null = game.selectedUnit;
      const activeItem = this.activeItem();
      if (unit && activeItem && this.selectedTargets[this.sequenceIndex].length > 0 &&
          allowLessThanMaxTargets(unit, activeItem)) {
        this.completeTargetGroup(unit);
      }
    } else if (event === 'BACK') {
      this.cancelTargeting();
    }
  }

  override draw(surf: Surface): Surface {
    const game = getGame();
    game.highlight.update();
    const result = drawMap(surf, true);
    this.drawTargetWarnings(result);
    this.targetItemMenu?.draw(result);
    return result;
  }

  /**
   * Python `Warning.target_icon` / `EvalWarning.target_icon`: a yellow '!'
   * (warning) or red '!' (danger) drawn above enemy units currently in the
   * item's target list, when the wielded item carries the corresponding
   * aesthetic component. Approximated with a small colored triangle since
   * the web has no bespoke icon sprite sheet wired in for this marker.
   */
  private drawTargetWarnings(surf: Surface): void {
    const game = getGame();
    const unit = game.selectedUnit;
    const item = this.activeItem();
    if (!unit || !item || !this.targets.length) return;
    if (!item.hasComponent('warning') && !item.hasComponent('eval_warning')) return;
    const cameraOffset = game.camera.getOffset();
    for (const target of this.targets) {
      const targetUnit = game.board?.getUnit?.(target[0], target[1]) ?? null;
      if (!targetUnit) continue;
      const icon = computeTargetIcon(unit, item, targetUnit, game.db, game);
      if (!icon) continue;
      const x = target[0] * TILEWIDTH - cameraOffset[0] + TILEWIDTH / 2;
      const y = target[1] * TILEHEIGHT - cameraOffset[1] - 4;
      const color = icon === 'danger' ? 'rgb(224,32,32)' : 'rgb(248,216,0)';
      surf.fillRect(x - 1, y - 8, 2, 6, color);
      surf.fillRect(x - 1, y - 1, 2, 2, color);
    }
  }

  override end(): StateResult {
    this.targetItemMenu = null;
    this.pendingTarget = null;
    this.selectableTargetItems = [];
    this.targetItemMode = null;
    this.sequenceIndex = 0;
    this.selectedTargets = [];
    getGame().highlight.clear();
  }
}

// ============================================================================
// 4c-2. PromotionChoiceState - Choose between multiple promotion targets
// ============================================================================

/**
 * Port of Python's PromotionChoiceState (game.state 'promotion_choice').
 * Reached from ItemTargetingState when the target's class has 2+
 * `turns_into` options. Presentation is a simplified keyboard/mouse choice
 * menu rather than the full scroll/fanfare screen; mechanics (class swap,
 * stat gains, wexp, skills) go through the same reversible core as the
 * single-option path (see `performPromotionOrClassChange`).
 */
export class PromotionChoiceState extends State {
  readonly name = 'promotion_choice';
  override readonly transparent = true;

  private menu: ChoiceMenu | null = null;
  private options: string[] = [];
  private targetUnit: UnitObject | null = null;

  override begin(): StateResult {
    const game = getGame();
    this.targetUnit = game.memory.get('promotion_choice_unit') ?? null;
    this.options = game.memory.get('promotion_choice_options') ?? [];
    if (!this.targetUnit || this.options.length === 0) {
      game.state.back();
      return 'repeat';
    }

    const menuOptions: MenuOption[] = this.options.map((klassNid: string) => ({
      label: game.db.classes.get(klassNid)?.name ?? klassNid,
      value: klassNid,
      enabled: true,
    }));

    const [cameraX, cameraY] = game.camera.getOffset();
    const pos = this.targetUnit.position;
    const menuX = pos
      ? Math.min(pos[0] * TILEWIDTH - cameraX + TILEWIDTH + 4, viewport.width - 100)
      : viewport.width / 2;
    const menuY = pos
      ? Math.min(pos[1] * TILEHEIGHT - cameraY, viewport.height - menuOptions.length * 16 - 8)
      : viewport.height / 2;
    this.menu = new ChoiceMenu(menuOptions, Math.max(0, menuX), Math.max(0, menuY));
  }

  private cleanupMemory(): void {
    const game = getGame();
    game.memory.delete('promotion_choice_unit');
    game.memory.delete('promotion_choice_options');
    game.memory.delete('promotion_choice_item');
    game.memory.delete('promotion_choice_actor');
  }

  override takeInput(event: InputEvent): StateResult {
    if (!this.menu) return;
    const game = getGame();

    let result: { selected: string } | { back: true } | null = null;
    if (game.input?.mouseClick) {
      const [gx, gy] = game.input.getGameMousePos();
      result = this.menu.handleClick(gx, gy, game.input.mouseClick as 'SELECT' | 'BACK');
    }
    if (game.input?.mouseMoved) {
      const [gx, gy] = game.input.getGameMousePos();
      this.menu.handleMouseHover(gx, gy);
    }
    if (!result && event !== null) result = this.menu.handleInput(event);
    if (!result) return;

    if ('back' in result) {
      // Cancel: refund (nothing consumed yet), return to target selection
      // without promoting -- mirrors Python's can_go_back refund path.
      this.cleanupMemory();
      this.menu = null;
      game.state.back();
      return;
    }

    if ('selected' in result) {
      const newKlass = result.selected;
      const target = this.targetUnit;
      const item: ItemObject | null = game.memory.get('promotion_choice_item') ?? null;
      const actor: UnitObject | null = game.memory.get('promotion_choice_actor') ?? null;
      if (target && item && actor) {
        performPromotionOrClassChange(target, newKlass, game, 'promote');
        finishCoreItemUse(actor, item, [target]);
      }
      this.cleanupMemory();
      game.memory.delete('item_use_item');
      game.highlight.clear();
      this.menu = null;
      game.state.back(); // pop promotion_choice
      game.state.back(); // pop item_targeting
    }
  }

  override draw(surf: Surface): Surface {
    if (this.menu) this.menu.draw(surf);
    return surf;
  }

  override end(): StateResult {
    this.menu = null;
  }
}

// ============================================================================
// 4d. TradeState - Trade items between adjacent allied units
// ============================================================================

export class TradeState extends State {
  readonly name = 'trade';
  override readonly transparent = true;

  private targetMenu: ChoiceMenu | null = null;
  private adjacentAllies: UnitObject[] = [];
  private tradePartner: UnitObject | null = null;

  // Item selection phase
  private itemMenuA: ChoiceMenu | null = null;
  private itemMenuB: ChoiceMenu | null = null;
  private selectedIndexA: number = -1;
  private phase: 'select_partner' | 'select_items' = 'select_partner';

  override begin(): StateResult {
    const game = getGame();
    const unit: UnitObject = game.selectedUnit;
    if (!unit) {
      game.state.back();
      return;
    }

    // Python's open_trade event command trades two explicit units directly,
    // bypassing the adjacency/partner menu.
    const forcedPartner = game.memory?.get?.('trade_partner');
    if (forcedPartner) {
      game.memory.delete('trade_partner');
      this.tradePartner = forcedPartner;
      this.buildItemMenus(unit);
      this.phase = 'select_items';
      return;
    }

    if (!unit.position) {
      game.state.back();
      return;
    }

    this.adjacentAllies = getAdjacentAllies(unit, unit.position[0], unit.position[1]);
    if (this.adjacentAllies.length === 0) {
      game.state.back();
      return;
    }

    if (this.adjacentAllies.length === 1) {
      // Only one partner, skip selection
      this.tradePartner = this.adjacentAllies[0];
      this.buildItemMenus(unit);
      this.phase = 'select_items';
    } else {
      const options: MenuOption[] = this.adjacentAllies.map((ally) => ({
        label: ally.name,
        value: ally.nid,
        enabled: true,
      }));

      this.targetMenu = new ChoiceMenu(options, viewport.width / 2 - 30, viewport.height / 2 - 16);
      this.phase = 'select_partner';
    }
  }

  private buildItemMenus(unit: UnitObject): void {
    const partner = this.tradePartner!;

    // Build items list for unit A (current unit)
    const optionsA: MenuOption[] = unit.items.map((item, i) => ({
      label: item.name,
      value: `a_${i}`,
      enabled: true,
    }));
    // Add empty slot
    optionsA.push({ label: '---', value: 'a_empty', enabled: false });

    this.itemMenuA = new ChoiceMenu(optionsA, 4, 20);

    // Build items list for unit B (trade partner)
    const optionsB: MenuOption[] = partner.items.map((item, i) => ({
      label: item.name,
      value: `b_${i}`,
      enabled: true,
    }));
    optionsB.push({ label: '---', value: 'b_empty', enabled: false });

    this.itemMenuB = new ChoiceMenu(optionsB, viewport.width / 2 + 4, 20);
    this.selectedIndexA = -1;
  }

  override takeInput(event: InputEvent): StateResult {
    if (event === null) return;
    const game = getGame();

    if (this.phase === 'select_partner' && this.targetMenu) {
      const result = this.targetMenu.handleInput(event);
      if (!result) return;

      if ('back' in result) {
        this.targetMenu = null;
        game.state.back();
        return;
      }

      if ('selected' in result) {
        this.tradePartner = this.adjacentAllies.find((a) => a.nid === result.selected) ?? null;
        if (this.tradePartner) {
          this.buildItemMenus(game.selectedUnit);
          this.phase = 'select_items';
          this.targetMenu = null;
        }
      }
      return;
    }

    if (this.phase === 'select_items') {
      // Simplified trade: BACK exits, otherwise just swap first items
      if (event === 'BACK') {
        const unit: UnitObject = game.selectedUnit;
        if (unit) {
          game.actionLog.doAction(new HasTradedAction(unit));
          game.actionLog.doAction(new WaitAction(unit));
        }
        game.state.back();
        return;
      }

      // For now, a simple swap of the first items from each unit
      if (event === 'SELECT') {
        const unit: UnitObject = game.selectedUnit;
        const partner = this.tradePartner;
        if (unit && partner && unit.items.length > 0 && partner.items.length > 0) {
          game.actionLog.doAction(new TradeAction(unit, 0, partner, 0));
        }
        if (unit) {
          game.actionLog.doAction(new HasTradedAction(unit));
          game.actionLog.doAction(new WaitAction(unit));
        }
        game.state.back();
      }
    }
  }

  override draw(surf: Surface): Surface {
    if (this.phase === 'select_partner' && this.targetMenu) {
      this.targetMenu.draw(surf);
    }

    if (this.phase === 'select_items') {
      // Draw a simplified trade UI
      surf.fillRect(0, 0, viewport.width, viewport.height, 'rgba(0,0,32,0.7)');

      const game = getGame();
      const unit: UnitObject = game.selectedUnit;
      const partner = this.tradePartner;

      // Unit A items
      surf.drawText(unit?.name ?? '', 4, 4, 'white', '8px monospace');
      if (unit) {
        unit.items.forEach((item, i) => {
          surf.drawText(item.name, 8, 16 + i * 12, 'rgba(200,200,255,1)', '7px monospace');
        });
      }

      // Unit B items
      const bx = viewport.width / 2 + 4;
      surf.drawText(partner?.name ?? '', bx, 4, 'white', '8px monospace');
      if (partner) {
        partner.items.forEach((item, i) => {
          surf.drawText(item.name, bx + 4, 16 + i * 12, 'rgba(200,200,255,1)', '7px monospace');
        });
      }

      surf.drawText('SELECT to swap, BACK to finish', 4, viewport.height - 12, 'rgba(160,160,200,1)', '7px monospace');
    }

    return surf;
  }
}

// ============================================================================
// 4d. RescueState - Select an adjacent ally to rescue
// ============================================================================

export class RescueState extends State {
  readonly name = 'rescue';
  override readonly transparent = true;

  private menu: ChoiceMenu | null = null;
  private rescuableUnits: UnitObject[] = [];

  override begin(): StateResult {
    const game = getGame();
    const unit: UnitObject = game.selectedUnit;
    if (!unit || !unit.position) {
      game.state.back();
      return;
    }

    this.rescuableUnits = getAdjacentAllies(unit, unit.position[0], unit.position[1])
      .filter((ally) => !ally.isRescued() && !ally.isRescuing() &&
        (!game.db.getConstant('pairup', false) || ally.team === unit.team));

    if (this.rescuableUnits.length === 0) {
      game.state.back();
      return;
    }

    const options: MenuOption[] = this.rescuableUnits.map((ally) => ({
      label: ally.name,
      value: ally.nid,
      enabled: true,
    }));

    this.menu = new ChoiceMenu(options, viewport.width / 2 - 30, viewport.height / 2 - 16);
  }

  override takeInput(event: InputEvent): StateResult {
    if (!this.menu || event === null) return;
    const game = getGame();

    const result = this.menu.handleInput(event);
    if (!result) return;

    if ('back' in result) {
      this.menu = null;
      game.state.back();
      return;
    }

    if ('selected' in result) {
      const target = this.rescuableUnits.find((u) => u.nid === result.selected);
      const unit: UnitObject = game.selectedUnit;

      if (target && unit) {
        const pairUp = game.db.getConstant('pairup', false) &&
          !game.db.getConstant('attack_stance_only', false);
        if (pairUp) {
          // Python PairUpAbility pairs the acting unit into the selected leader.
          game.actionLog.doAction(new PairUpAction(unit, target, game.board, game.db));
        } else {
          game.actionLog.doAction(new RescueAction(unit, target, game.board));
          game.actionLog.doAction(new WaitAction(unit));
        }
      }

      this.menu = null;
      game.state.back();
    }
  }

  override draw(surf: Surface): Surface {
    if (this.menu) {
      this.menu.draw(surf);
    }
    return surf;
  }
}

// ============================================================================
// 4e. TransferState - Exchange guard-stance travelers with an adjacent ally
// ============================================================================

export class TransferState extends State {
  readonly name = 'transfer';
  override readonly transparent = true;

  private menu: ChoiceMenu | null = null;
  private targets: UnitObject[] = [];

  override begin(): StateResult {
    const game = getGame();
    const unit: UnitObject | null = game.selectedUnit;
    if (!unit?.position || !game.db.getConstant('pairup', false) || unit.hasGiven) {
      game.state.back();
      return 'repeat';
    }
    this.targets = getAdjacentAllies(unit, unit.position[0], unit.position[1])
      .filter((ally) => !!ally.traveler || !!unit.traveler);
    if (this.targets.length === 0) {
      game.state.back();
      return 'repeat';
    }
    this.menu = new ChoiceMenu(this.targets.map((target) => ({
      label: target.name,
      value: target.nid,
      enabled: true,
    })), viewport.width / 2 - 30, viewport.height / 2 - 16);
  }

  override takeInput(event: InputEvent): StateResult {
    if (!this.menu || event === null) return;
    const game = getGame();
    const result = this.menu.handleInput(event);
    if (!result) return;
    if ('back' in result) {
      this.menu = null;
      game.state.back();
      return;
    }
    const unit: UnitObject | null = game.selectedUnit;
    const target = this.targets.find((candidate) => candidate.nid === result.selected);
    if (unit && target) {
      game.actionLog.doAction(new HasTradedAction(unit));
      game.actionLog.doAction(new TransferPairUpAction(unit, target, game.db));
    }
    this.menu = null;
    game.state.back();
  }

  override draw(surf: Surface): Surface {
    this.menu?.draw(surf);
    return surf;
  }
}

// ============================================================================
// 4f. DropState - Select a tile to drop a rescued unit
// ============================================================================

export class DropState extends MapState {
  readonly name = 'drop';

  private dropTiles: [number, number][] = [];

  override begin(): StateResult {
    const game = getGame();
    const unit: UnitObject = game.selectedUnit;
    if (!unit || !unit.position || !unit.rescuing) {
      game.state.back();
      return;
    }

    this.dropTiles = getAdjacentEmptyTiles(unit.position[0], unit.position[1], unit.rescuing);

    if (this.dropTiles.length === 0) {
      game.state.back();
      return;
    }

    // Highlight drop tiles
    game.highlight.clear();
    for (const [tx, ty] of this.dropTiles) {
      game.highlight.addHighlight(tx, ty, 'move');
    }

    // Position cursor on first drop tile
    game.cursor.setPos(this.dropTiles[0][0], this.dropTiles[0][1]);
  }

  override takeInput(event: InputEvent): StateResult {
    const game = getGame();

    // Process mouse input for map interaction
    const mouseAction = processMouseForMap(event);
    const effective = mouseAction ?? event;

    if (effective === null) return;

    switch (effective) {
      case 'UP':
        moveCursor(0, -1);
        break;
      case 'DOWN':
        moveCursor(0, 1);
        break;
      case 'LEFT':
        moveCursor(-1, 0);
        break;
      case 'RIGHT':
        moveCursor(1, 0);
        break;

      case 'SELECT': {
        const pos = game.cursor.getHover();
        const isValid = this.dropTiles.some(([x, y]) => x === pos.x && y === pos.y);
        if (isValid) {
          const unit: UnitObject = game.selectedUnit;
          const target = unit?.rescuing;
          if (unit && target) {
            if (game.db.getConstant('pairup', false) && unit.leadUnit) {
              game.actionLog.doAction(new SeparatePairUpAction(
                unit, target, game.board, game.db, [pos.x, pos.y], true,
              ));
            } else {
              game.actionLog.doAction(new DropAction(unit, target, game.board, [pos.x, pos.y]));
            }
            game.actionLog.doAction(new WaitAction(unit));
          }
          game.highlight.clear();
          game.state.back();
        }
        break;
      }

      case 'BACK':
        game.highlight.clear();
        game.state.back();
        break;
    }
  }

  override draw(surf: Surface): Surface {
    const game = getGame();
    game.highlight.update();
    return drawMap(surf, true);
  }

  override end(): StateResult {
    const game = getGame();
    game.highlight.clear();
  }
}

// ============================================================================
// 5a. WeaponChoiceState — Select which weapon to use before attacking
// ============================================================================

export class WeaponChoiceState extends State {
  readonly name = 'weapon_choice';
  override readonly transparent = true;

  private menu: ChoiceMenu | null = null;
  private weapons: ItemObject[] = [];
  private previousEquipped: ItemObject | null = null;

  override begin(): StateResult {
    const game = getGame();
    const unit: UnitObject = game.selectedUnit;
    if (!unit || !unit.position) {
      game.state.back();
      return 'repeat';
    }

    // If the unit already finished (returned from combat), pop back.
    if (unit.finished || !unit.canStillAct()) {
      this.menu = null;
      game.state.back();
      return 'repeat';
    }

    // Gather all usable weapons (has uses remaining, is a weapon)
    this.weapons = unit.items.filter(
      (item) => item.isWeapon() && itemAvailable(unit, item, game.db, game),
    );

    // Also include spells
    const spells = unit.items.filter(
      (item) => item.isSpell() && !item.isWeapon() && itemAvailable(unit, item, game.db, game),
    );
    this.weapons.push(...spells);

    if (this.weapons.length === 0) {
      game.state.back();
      return;
    }

    // If only one weapon, auto-select it
    if (this.weapons.length === 1) {
      this.equipWeapon(unit, this.weapons[0]);
      game.state.change('targeting');
      return;
    }

    // Remember current equipped weapon for undo
    this.previousEquipped = getEquippedWeapon(unit, game.db, game);

    // Build menu options
    const options: MenuOption[] = this.weapons.map((w) => ({
      label: w.name,
      value: w.nid,
      enabled: true,
    }));

    // Position menu near unit
    const cameraOffset = game.camera.getOffset();
    const menuX = unit.position[0] * TILEWIDTH - cameraOffset[0] + TILEWIDTH + 4;
    const menuY = unit.position[1] * TILEHEIGHT - cameraOffset[1];
    const clampedX = Math.min(menuX, viewport.width - 80);
    const clampedY = Math.min(menuY, viewport.height - options.length * 16 - 8);

    this.menu = new ChoiceMenu(options, clampedX, Math.max(0, clampedY));

    // Equip the first weapon and show its attack range
    this.equipWeapon(unit, this.weapons[0]);
    this.showWeaponRange(unit, this.weapons[0]);
  }
  private equipWeapon(unit: UnitObject, weapon: ItemObject): void {
    const game = getGame();
    // Python WeaponChoiceState._test_equip: record a reversible EquipItem so
    // the turnwheel can undo the choice and status_on_equip hooks fire.
    if (unit.canEquip(weapon)) {
      game.actionLog.doAction(new EquipItemAction(unit, weapon));
    }
  }

  private showWeaponRange(unit: UnitObject, weapon: ItemObject): void {
    const game = getGame();
    game.highlight.clear();
    const minRange = weapon.getMinRange();
    const maxRange = weapon.getMaxRange();
    const ux = unit.position![0];
    const uy = unit.position![1];
    const attackTiles: [number, number][] = [];
    for (let dx = -maxRange; dx <= maxRange; dx++) {
      for (let dy = -maxRange; dy <= maxRange; dy++) {
        const dist = Math.abs(dx) + Math.abs(dy);
        if (dist >= minRange && dist <= maxRange) {
          const tx = ux + dx;
          const ty = uy + dy;
          if (game.board.inBounds(tx, ty)) {
            attackTiles.push([tx, ty]);
          }
        }
      }
    }
    game.highlight.setAttackHighlights(attackTiles);
  }

  override takeInput(event: InputEvent): StateResult {
    if (!this.menu) return;
    const game = getGame();

    // Handle mouse
    let result: { selected: string } | { back: true } | null = null;
    if (game.input?.mouseClick) {
      const [gx, gy] = game.input.getGameMousePos();
      result = this.menu.handleClick(gx, gy, game.input.mouseClick as 'SELECT' | 'BACK');
    }
    if (game.input?.mouseMoved) {
      const [gx, gy] = game.input.getGameMousePos();
      this.menu.handleMouseHover(gx, gy);
    }
    if (!result && event !== null) {
      result = this.menu.handleInput(event);
    }
    if (!result) {
      // On UP/DOWN, update weapon range display
      if (event === 'UP' || event === 'DOWN') {
        const idx = this.menu.selectedIndex;
        if (idx >= 0 && idx < this.weapons.length) {
          const unit: UnitObject = game.selectedUnit;
          this.equipWeapon(unit, this.weapons[idx]);
          this.showWeaponRange(unit, this.weapons[idx]);
        }
      }
      return;
    }

    if ('back' in result) {
      // Restore previous equipped weapon
      const unit: UnitObject = game.selectedUnit;
      if (this.previousEquipped) {
        this.equipWeapon(unit, this.previousEquipped);
      }
      game.highlight.clear();
      this.menu = null;
      game.state.back();
      return;
    }

    if ('selected' in result) {
      const weapon = this.weapons.find((w) => w.nid === result.selected);
      if (weapon) {
        const unit: UnitObject = game.selectedUnit;
        this.equipWeapon(unit, weapon);
        // Python WeaponChoiceState: bring the selected item (or its ultimate
        // multi_item parent) to the top of inventory after equipping.
        let topItem = weapon;
        if (!unit.items.includes(weapon) && weapon.parentItem) {
          topItem = weapon.parentItem;
          while (topItem.parentItem) topItem = topItem.parentItem;
          if (!unit.items.includes(topItem)) topItem = weapon;
        }
        if (unit.items.includes(topItem)) {
          game.actionLog.doAction(new BringToTopItemAction(unit, topItem));
        }
      }
      game.highlight.clear();
      this.menu = null;
      game.state.change('targeting');
    }
  }

  override draw(surf: Surface): Surface {
    const game = getGame();
    game.highlight.update();
    surf = drawMap(surf, true);
    if (this.menu) {
      this.menu.draw(surf);
    }
    return surf;
  }

  override end(): StateResult {
    const game = getGame();
    game.highlight.clear();
  }
}

// ============================================================================
// 5b. TargetingState
// ============================================================================

export class TargetingState extends MapState {
  readonly name = 'targeting';

  private targets: UnitObject[] = [];
  private targetIndex: number = 0;
  private attackerAssist: UnitObject | null = null;
  private defenderAssist: UnitObject | null = null;

  override begin(): StateResult {
    const game = getGame();
    const unit: UnitObject = game.selectedUnit;
    if (!unit || !unit.position) {
      game.state.back();
      return 'repeat';
    }

    // If the unit already finished (returned from combat), pop back.
    if (unit.finished || !unit.canStillAct()) {
      game.highlight.clear();
      game.state.back();
      return 'repeat';
    }

    // Get valid targets
    this.targets = getTargetsInRange(
      unit,
      unit.position[0],
      unit.position[1],
    );
    this.targetIndex = 0;
    this.attackerAssist = null;
    this.defenderAssist = null;

    if (this.targets.length === 0) {
      game.state.back();
      return;
    }

    // Show attack range highlights
    game.highlight.clear();
    const weapon = getEquippedWeapon(unit, game.db, game);
    if (weapon) {
      const minRange = weapon.getMinRange();
      const maxRange = weapon.getMaxRange();
      const attackTiles: [number, number][] = [];
      const ux = unit.position[0];
      const uy = unit.position[1];
      for (let dx = -maxRange; dx <= maxRange; dx++) {
        for (let dy = -maxRange; dy <= maxRange; dy++) {
          const dist = Math.abs(dx) + Math.abs(dy);
          if (dist >= minRange && dist <= maxRange) {
            const tx = ux + dx;
            const ty = uy + dy;
            if (game.board.inBounds(tx, ty)) {
              attackTiles.push([tx, ty]);
            }
          }
        }
      }
      game.highlight.setAttackHighlights(attackTiles);
    }

    // Position cursor on first target
    this.focusTarget();
  }

  private focusTarget(): void {
    const game = getGame();
    const target = this.targets[this.targetIndex];
    if (target && target.position) {
      game.cursor.setPos(target.position[0], target.position[1]);
      // Only pan camera to target on mobile; desktop users can pan manually
      if (isSmallScreen()) {
        game.camera.focusTile(target.position[0], target.position[1]);
      }
      this.updateStrikePartners(target);
    }
  }

  private updateStrikePartners(target: UnitObject, preserveAttacker: boolean = false): void {
    const game = getGame();
    const unit: UnitObject | null = game.selectedUnit;
    const weapon = unit ? getEquippedWeapon(unit, game.db, game) : null;
    if (!unit || !weapon || !game.targetSystem?.findStrikePartners) {
      this.attackerAssist = null;
      this.defenderAssist = null;
      return;
    }
    const [attackerAssist, defenderAssist] = game.targetSystem.findStrikePartners(unit, target, weapon);
    if (!preserveAttacker || !this.attackerAssist ||
        !game.targetSystem.getStrikePartnerCandidates(unit, target).includes(this.attackerAssist)) {
      this.attackerAssist = attackerAssist;
    }
    this.defenderAssist = defenderAssist;
  }

  private commitStrikePartners(target: UnitObject): void {
    const game = getGame();
    const unit: UnitObject = game.selectedUnit;
    unit.strikePartner = this.attackerAssist;
    target.strikePartner = this.defenderAssist;
    game.memory.set('combat_strike_partners_selected', true);
  }

  override takeInput(event: InputEvent): StateResult {
    const game = getGame();

    // Mouse: clicking directly on a valid target selects it
    if (game.input?.mouseClick === 'SELECT') {
      const tile = getMouseTile();
      if (tile) {
        const clickedTargetIdx = this.targets.findIndex(
          (t) => t.position && t.position[0] === tile[0] && t.position[1] === tile[1],
        );
        if (clickedTargetIdx >= 0) {
          this.targetIndex = clickedTargetIdx;
          const target = this.targets[this.targetIndex];
          this.commitStrikePartners(target);
          game.combatTarget = target;
          game.highlight.clear();
          game.state.change('combat');
          return;
        }
      }
    }
    if (game.input?.mouseClick === 'BACK') {
      game.highlight.clear();
      game.state.back();
      return;
    }

    if (event === null) return;

    switch (event) {
      case 'UP':
      case 'LEFT':
        // Cycle to previous target
        if (this.targets.length > 0) {
          this.targetIndex =
            (this.targetIndex - 1 + this.targets.length) % this.targets.length;
          this.focusTarget();
        }
        break;

      case 'DOWN':
      case 'RIGHT':
        // Cycle to next target
        if (this.targets.length > 0) {
          this.targetIndex =
            (this.targetIndex + 1) % this.targets.length;
          this.focusTarget();
        }
        break;

      case 'AUX': {
        const unit: UnitObject | null = game.selectedUnit;
        const target = this.targets[this.targetIndex];
        if (!unit || !target || !game.targetSystem?.getStrikePartnerCandidates) break;
        const candidates: UnitObject[] = game.targetSystem.getStrikePartnerCandidates(unit, target);
        if (candidates.length > 1 && this.attackerAssist) {
          const current = candidates.indexOf(this.attackerAssist);
          this.attackerAssist = candidates[(current + 1 + candidates.length) % candidates.length];
          this.updateStrikePartners(target, true);
        }
        break;
      }

      case 'SELECT': {
        const target = this.targets[this.targetIndex];
        if (target) {
          this.commitStrikePartners(target);
          game.combatTarget = target;
          game.highlight.clear();
          game.state.change('combat');
        }
        break;
      }

      case 'BACK':
        game.highlight.clear();
        game.state.back();
        break;
    }
  }

  override draw(surf: Surface): Surface {
    const game = getGame();
    game.highlight.update();
    surf = drawMap(surf, true);

    // Draw target info overlay
    const target = this.targets[this.targetIndex];
    if (target) {
      const unit: UnitObject = game.selectedUnit;
      const weapon = getEquippedWeapon(unit, game.db, game);
      if (weapon && target.position) {
        const cameraOffset = game.camera.getOffset();
        const tx = target.position[0] * TILEWIDTH - cameraOffset[0];
        const ty = target.position[1] * TILEHEIGHT - cameraOffset[1];

        // Highlight target tile
        surf.fillRect(tx, ty, TILEWIDTH, TILEHEIGHT, 'rgba(255,0,0,0.3)');

        // Show target name/HP at top of screen
        surf.fillRect(0, 0, viewport.width, 16, 'rgba(0,0,0,0.7)');
        surf.drawText(
          `${target.name}  HP: ${target.currentHp}/${target.maxHp}`,
          4,
          4,
          'white',
          '8px monospace',
        );
        if (this.attackerAssist || this.defenderAssist) {
          const left = this.attackerAssist?.name ?? '-';
          const right = this.defenderAssist?.name ?? '-';
          surf.drawText(`Dual: ${left} / ${right}`, 4, 13, 'rgba(245,222,148,1)', '6px monospace');
        }
      }
    }
    return surf;
  }

  override end(): StateResult {
    const game = getGame();
    game.highlight.clear();
    // Clear targets to prevent stale draw (red rectangle) when CombatState
    // draws on top of this transparent state
    this.targets = [];
  }
}

// ============================================================================
// 6. CombatState
// ============================================================================

function resolveCombatTargetGroup(
  game: any,
  attacker: UnitObject,
  item: ItemObject,
  selectedDefender: UnitObject,
): { representative: UnitObject; mainDefender: UnitObject | null; splashDefenders: UnitObject[] } {
  let mainDefender: UnitObject | null = selectedDefender;
  let splashDefenders: UnitObject[] = [];
  if (game.targetSystem && selectedDefender.position) {
    const resolved = game.targetSystem.getTargetFromPosition(attacker, item, selectedDefender.position);
    mainDefender = resolved.mainTarget
      ? game.board.getUnit(resolved.mainTarget[0], resolved.mainTarget[1])
      : null;
    splashDefenders = [...new Set<UnitObject>(resolved.splash
      .map((position: [number, number]) => game.board.getUnit(position[0], position[1]))
      .filter((unit: UnitObject | null): unit is UnitObject => !!unit && unit !== mainDefender))];
  }
  return {
    representative: mainDefender ?? splashDefenders[0] ?? selectedDefender,
    mainDefender,
    splashDefenders,
  };
}

/**
 * CombatState phases:
 * 1. 'combat' - Running the MapCombat animation (strikes, HP drain)
 * 2. 'death' - Death animation timer (fade-out)
 * 3. 'exp' - EXP bar animation
 * 4. 'levelup' - Level-up stat display
 * 5. 'cleanup' - Check win/loss, transition out
 */
type CombatPhase = 'combat' | 'death' | 'exp_init' | 'exp_wait' | 'exp0' | 'exp100' | 'exp_leave' | 'level_up' | 'level_screen' | 'stole' | 'rank_up' | 'got_item' | 'cleanup';

export class CombatState extends State {
  private initialized: boolean = false;
  readonly name = 'combat';
  override readonly transparent = true;

  private combat: MapCombat | null = null;
  private animCombat: AnimationCombat | null = null;
  private isAnimationCombat: boolean = false;
  private results: CombatResults | null = null;
  private phase: CombatPhase = 'combat';
  private phaseTimer: number = 0;

  /**
   * Whether this combat was triggered from an event (interact_unit).
   * When true, CombatState should NOT push EventState on cleanup —
   * the calling EventState is already on the stack and will resume
   * processing when CombatState pops via back().
   * Matches Python's `event_combat` flag in `simple_combat.py`.
   */
  private eventCombat: boolean = false;

  /** Whether we successfully pushed battle music (guards popMusic). */
  private didPushBattleMusic: boolean = false;

  // EXP state machine (faithful port of Python ExpState)
  private expBar: ExpBarClass | null = null;
  private expOldExp: number = 0;
  private expGainAmount: number = 0;
  private expTotalTime: number = 0;    // ms to fill bar (1 frame per EXP point at 60fps)
  private expStartTime: number = 0;    // timestamp when current sub-phase started
  private expNeedLevelUp: boolean = false;

  // Level-up display
  private levelUpGains: Record<string, number> | null = null;
  private levelUpScreen: LevelUpScreenClass | null = null;
  private levelUpSoundPlayed: boolean = false;
  private darkFuzzAlpha: number = 0.34; // 66% translucent = 34% opaque black overlay
  private portraitImg: HTMLImageElement | null = null;

  // Death fade
  private deathFadeProgress: number = 0;

  // Platform images for animation combat
  private leftPlatformImg: HTMLImageElement | null = null;
  private rightPlatformImg: HTMLImageElement | null = null;

  // Battle background panorama image
  private battleBackgroundImg: HTMLImageElement | null = null;
  private rankUpBanner: Banner | null = null;
  private stoleBanner: Banner | null = null;
  private stoleBannerShown: boolean = false;
  private gotItemBanner: Banner | null = null;
  private gotItemBannerQueue: string[] = [];
  private pendingDiscards: Array<{ unit: UnitObject; item: ItemObject }> = [];
  private rankUpBannerShown: boolean = false;

  /** Get whichever combat controller is active (AnimationCombat or MapCombat). */
  private getActiveCombat(): MapCombat | AnimationCombat | null {
    return this.isAnimationCombat ? this.animCombat : this.combat;
  }

  private getCombatDefenders(): UnitObject[] {
    const active = this.getActiveCombat();
    if (!active) return [];
    return this.combat?.defenders ?? [active.defender];
  }

  private getPrimaryCombatDefender(): UnitObject | null {
    const active = this.getActiveCombat();
    if (!active) return null;
    return this.combat ? this.combat.primaryDefender : active.defender;
  }

  private getDefenderDeaths(): UnitObject[] {
    if (!this.results) return [];
    return this.results.defenderDeaths ??
      (this.results.defenderDead && this.getActiveCombat() ? [this.getActiveCombat()!.defender] : []);
  }

  private getCombatKiller(unit: UnitObject): UnitObject | null {
    const strikes = this.getActiveCombat()?.strikes ?? [];
    for (let index = strikes.length - 1; index >= 0; index--) {
      const strike = strikes[index];
      if (strike.defender === unit && strike.hit) return strike.attacker;
    }
    return null;
  }

  override begin(): StateResult {
    if (this.initialized) return;
    const game = getGame();
    const attacker: UnitObject = game.selectedUnit;
    let defender: UnitObject = game.combatTarget;

    if (!attacker || !defender) {
      game.state.back();
      return;
    }

    const selectedCombatItem = game.memory.get('combat_item') as ItemObject | undefined;
    game.memory.delete('combat_item');
    const attackItem = selectedCombatItem ?? getEquippedWeapon(attacker, game.db, game);
    if (!attackItem) {
      game.state.back();
      return;
    }

    const targetGroup = resolveCombatTargetGroup(game, attacker, attackItem, defender);
    const primaryDefender = targetGroup.mainDefender;
    const splashDefenders = targetGroup.splashDefenders;
    defender = targetGroup.representative;
    const groupedCombat = !primaryDefender || splashDefenders.length > 0;
    const defenseItem = primaryDefender ? getEquippedWeapon(primaryDefender, game.db, game) : null;
    const rngMode = game.db.getConstant('rng_mode', 'true_hit') as any;

    const playerSelectedPartners = !!game.memory.get('combat_strike_partners_selected');
    game.memory.delete('combat_strike_partners_selected');
    if (groupedCombat || !primaryDefender) {
      attacker.strikePartner = null;
      if (primaryDefender) primaryDefender.strikePartner = null;
    } else if (!playerSelectedPartners && game.targetSystem?.findStrikePartners) {
      const [attackerPartner, defenderPartner] = game.targetSystem.findStrikePartners(
        attacker, primaryDefender, attackItem,
      );
      attacker.strikePartner = attackerPartner;
      primaryDefender.strikePartner = defenderPartner;
    }

    // Read and consume the combat script (set by interact_unit)
    const script = game.combatScript;
    game.combatScript = null;

    // Check if both units have battle animations available
    // Utility spells use the map presentation in LT and have no weapon pose.
    // Dual-strike mechanics currently use the map presentation so every
    // partner phase has an on-map actor and independent lunge/HP target.
    const hasAttackStance = !!attacker.strikePartner || !!primaryDefender?.strikePartner;
    const canAnimate = !groupedCombat && !hasAttackStance && !attackItem.hasComponent('spell') && this.tryCreateAnimationCombat(
      attacker, attackItem, defender, defenseItem, rngMode, game, script,
    );

    if (canAnimate) {
      this.isAnimationCombat = true;
      this.combat = null;
      console.log(`CombatState: using AnimationCombat (${attacker.name} vs ${defender.name})`);
    } else {
      // Fallback to map combat
      this.isAnimationCombat = false;
      this.animCombat = null;
      this.combat = new MapCombat(
        attacker,
        attackItem,
        defender,
        defenseItem,
        game.db,
        rngMode,
        game.board,
        script,
        groupedCombat ? { mainDefender: primaryDefender, splashDefenders } : undefined,
        game,
      );
      // Wire audio manager for combat sound effects
      if (game.audioManager) {
        this.combat.audioManager = game.audioManager;
      }
      const targetNames = groupedCombat
        ? [primaryDefender, ...splashDefenders].filter(Boolean).map((unit) => unit!.name).join(', ')
        : defender.name;
      console.log(`CombatState: using MapCombat (${attacker.name} vs ${targetNames})`);
    }

    this.results = null;
    this.phase = 'combat';
    this.phaseTimer = 0;
    this.deathFadeProgress = 0;
    this.levelUpGains = null;
    this.levelUpScreen = null;
    this.levelUpSoundPlayed = false;
    this.expBar = null;
    this.portraitImg = null;
    this.rankUpBanner = null;
    this.stoleBanner = null;
    this.stoleBannerShown = false;
    this.gotItemBanner = null;
    this.gotItemBannerQueue = [];
    this.pendingDiscards = [];
    this.rankUpBannerShown = false;
    this.initialized = true;

    // Clear all highlights and hide cursor/HUD before combat starts
    // (Python does this in interaction.py and the red_cursor state)
    game.highlight.clear();
    game.cursor.visible = false;
    game.hud.visible = false;

    // Play battle music (push current phase music onto the stack)
    this.didPushBattleMusic = false;
    const levelMusic = game.currentLevel?.music;
    if (levelMusic) {
      const battleTrack = attacker.team === 'player'
        ? levelMusic.player_battle
        : levelMusic.enemy_battle;
      if (battleTrack) {
        this.didPushBattleMusic = true;
        void game.audioManager.pushMusic(battleTrack);
      }
    }

    const combatStartTriggered = game.eventManager?.trigger(
      {
        type: 'combat_start',
        unit1: attacker,
        unit2: primaryDefender,
        unitNid: attacker.nid,
        position: attacker.position ? [...attacker.position] as [number, number] : undefined,
        item: attackItem,
        isAnimationCombat: this.isAnimationCombat,
        levelNid: game.currentLevel?.nid,
      },
      {
        game,
        unit1: attacker,
        unit2: primaryDefender,
        position: attacker.position,
        item: attackItem,
        gameVars: game.gameVars,
        levelVars: game.levelVars,
      },
    ) ?? false;
    if (combatStartTriggered && !game.eventCombat) game.state.change('event');
  }

  /**
   * Try to create an AnimationCombat. Returns true if successful.
   * Requires both units to have combat animations defined in their classes,
   * and those animations must be loaded in the database.
   */
  private tryCreateAnimationCombat(
    attacker: UnitObject,
    attackItem: ItemObject,
    defender: UnitObject,
    defenseItem: ItemObject | null,
    rngMode: string,
    game: any,
    script?: string[] | null,
  ): boolean {
    try {
      const db = game.db;
      if (!db.combatAnims || db.combatAnims.size === 0) return false;

      // Look up combat anim NIDs from unit classes.
      // Fallback chain: combat_anim_nid -> class nid (handles projects
      // where combat_anim_nid is null or references a missing animation).
      const atkKlass = db.classes.get(attacker.klass);
      const defKlass = db.classes.get(defender.klass);
      if (!atkKlass || !defKlass) return false;

      const atkAnimData = db.combatAnims.get(atkKlass.combat_anim_nid ?? '')
        ?? db.combatAnims.get(atkKlass.nid);
      const defAnimData = db.combatAnims.get(defKlass.combat_anim_nid ?? '')
        ?? db.combatAnims.get(defKlass.nid);
      if (!atkAnimData || !defAnimData) return false;

      // Determine weapon type for selecting the weapon animation.
      // Python's get_battle_anim() prepends "Magic" to the weapon type when
      // the item has the 'magic' or 'magic_at_range' component, and prepends
      // "Ranged" for ranged weapons at distance > 1.
      let atkWeaponType = attackItem.getWeaponType() ?? null;
      if (atkWeaponType && isMagic(attackItem)) {
        atkWeaponType = 'Magic' + atkWeaponType;
      }
      let defWeaponType = defenseItem?.getWeaponType() ?? null;
      if (defWeaponType && defenseItem && isMagic(defenseItem)) {
        defWeaponType = 'Magic' + defWeaponType;
      }

      // Select weapon animations
      const atkWeaponAnim = selectWeaponAnim(atkAnimData, atkWeaponType ?? null);
      const defWeaponAnim = selectWeaponAnim(defAnimData, defWeaponType ?? null);
      if (!atkWeaponAnim || !defWeaponAnim) return false;

      // Create BattleAnimation instances with real pose data but empty frames
      // (sprites will hot-swap in once async loading completes)
      const atkAnim = new RealBattleAnimation(atkWeaponAnim, new Map());
      const defAnim = new RealBattleAnimation(defWeaponAnim, new Map());

      // Determine left/right assignment (player on right)
      let leftIsAttacker = true;
      if (defender.team === 'player' && attacker.team !== 'player') {
        leftIsAttacker = true; // attacker (enemy) on left, defender (player) on right
      } else if (attacker.team === 'player') {
        leftIsAttacker = false; // attacker (player) on right, defender on left
      }

      const leftAnim = leftIsAttacker ? atkAnim : defAnim;
      const rightAnim = leftIsAttacker ? defAnim : atkAnim;

      // Store resources on globalThis so effect loaders can access them
      (globalThis as any).__ltResources = game.resources;

      this.animCombat = new AnimationCombat(
        attacker,
        attackItem,
        defender,
        defenseItem,
        db,
        rngMode,
        leftAnim,
        rightAnim,
        leftIsAttacker,
        game.board,
        script,
        game,
      );

      // Wire audio manager for combat sound effects
      if (game.audioManager) {
        this.animCombat.audioManager = game.audioManager;
      }

      // Load platform images asynchronously (they'll appear once loaded)
      const isMelee = this.animCombat.combatRange <= 1;
      const leftUnit = leftIsAttacker ? attacker : defender;
      const rightUnit = leftIsAttacker ? defender : attacker;
      const leftPlatformType = this.getUnitPlatformType(leftUnit, db) ?? 'Plains';
      const rightPlatformType = this.getUnitPlatformType(rightUnit, db) ?? 'Plains';
      loadBattlePlatforms(leftPlatformType, rightPlatformType, isMelee).then(([left, right]) => {
        this.leftPlatformImg = left;
        this.rightPlatformImg = right;
      });

      // Load battle background panorama based on attacker's terrain
      const bgNid = this.getUnitBackgroundNid(attacker, db);
      if (bgNid) {
        const resources = getGame().resources;
        resources.loadPanorama(bgNid).then((img: HTMLImageElement) => {
          this.battleBackgroundImg = img;
        }).catch(() => {
          // Panorama not found — fall back to solid color background
        });
      }

      // Load and apply spritesheets asynchronously (sprites hot-swap in once ready)
      this.loadCombatSprites(
        atkAnimData.nid, atkWeaponAnim, attacker, atkAnimData, atkAnim,
        defAnimData.nid, defWeaponAnim, defender, defAnimData, defAnim,
        db,
      );

      return true;
    } catch (e) {
      console.warn('Failed to create AnimationCombat, falling back to MapCombat:', e);
      return false;
    }
  }

  /** Look up the terrain definition for a unit's map position. */
  private getUnitTerrain(unit: UnitObject, db: any): any | null {
    if (!unit.position) return null;
    const game = getGame();
    if (!game.tilemap) return null;

    // TileMapObject.getTerrain walks layers top-to-bottom
    const terrainNid = game.tilemap.getTerrain(unit.position[0], unit.position[1]);
    if (!terrainNid) return null;

    return db.terrain?.get(terrainNid) ?? null;
  }

  /** Look up the platform type for a unit's terrain tile. */
  private getUnitPlatformType(unit: UnitObject, db: any): string | null {
    const terrain = this.getUnitTerrain(unit, db);
    if (!terrain?.platform) return 'Plains';
    return terrain.platform;
  }

  /** Look up the panorama background NID for a unit's terrain tile. */
  private getUnitBackgroundNid(unit: UnitObject, db: any): string | null {
    const terrain = this.getUnitTerrain(unit, db);
    return terrain?.background ?? null;
  }

  /**
   * Asynchronously load and palette-convert combat animation spritesheets.
   * Once loaded, the frame images are hot-swapped into the BattleAnimation
   * instances so sprites appear mid-scene if loading takes time.
   */
  private async loadCombatSprites(
    atkAnimNid: string,
    atkWeaponAnim: import('../../combat/battle-anim-types').WeaponAnimData,
    attacker: UnitObject,
    atkCombatAnimData: import('../../combat/battle-anim-types').CombatAnimData,
    atkBattleAnim: RealBattleAnimation,
    defAnimNid: string,
    defWeaponAnim: import('../../combat/battle-anim-types').WeaponAnimData,
    defender: UnitObject,
    defCombatAnimData: import('../../combat/battle-anim-types').CombatAnimData,
    defBattleAnim: RealBattleAnimation,
    db: any,
  ): Promise<void> {
    try {
      const resources = getGame().resources;
      const palettes = db.combatPalettes as Map<string, import('../../combat/battle-anim-types').PaletteData>;

      // Select palettes for each unit
      const atkPalette = selectPalette(atkCombatAnimData, attacker, palettes);
      const defPalette = selectPalette(defCombatAnimData, defender, palettes);

      // Load both spritesheets in parallel
      const [atkFrames, defFrames] = await Promise.all([
        atkPalette
          ? loadAndConvertWeaponAnim(resources, atkAnimNid, atkWeaponAnim, atkPalette)
          : null,
        defPalette
          ? loadAndConvertWeaponAnim(resources, defAnimNid, defWeaponAnim, defPalette)
          : null,
      ]);

      // Hot-swap frame images into the running BattleAnimation instances
      if (atkFrames && atkFrames.size > 0) {
        for (const [nid, canvas] of atkFrames) {
          atkBattleAnim.frameImages.set(nid, canvas);
        }
      }
      if (defFrames && defFrames.size > 0) {
        for (const [nid, canvas] of defFrames) {
          defBattleAnim.frameImages.set(nid, canvas);
        }
      }
    } catch (e) {
      console.warn('Failed to load combat animation sprites:', e);
    }
  }

  override takeInput(): StateResult {
    const game = getGame();
    if (!game.input) return;

    // BACK (Escape/X) instantly skips combat (both animation and map combat).
    // START (S) toggles 4x speed for animation combat.
    if (game.input.justPressed('BACK')) {
      if (this.phase === 'combat') {
        // Skip the combat animation entirely — results will be applied
        // by the normal 'done' handling in update()
        const activeCombat = this.isAnimationCombat ? this.animCombat : this.combat;
        if (activeCombat) {
          activeCombat.skipToEnd();
        }
      } else if (this.phase === 'death' || this.phase === 'exp_init' || this.phase === 'exp_wait' ||
                 this.phase === 'exp0' || this.phase === 'exp100' || this.phase === 'exp_leave' ||
                 this.phase === 'level_up' || this.phase === 'level_screen') {
        // Skip post-combat phases — stop looping SFX and jump straight to cleanup
        game.audioManager?.stopSfx?.('Experience Gain');
        this.phase = 'cleanup';
        this.phaseTimer = 0;
      }
    }
    if (game.input.justPressed('START')) {
      if (this.animCombat) {
        this.animCombat.skipMode = !this.animCombat.skipMode;
      }
    }
  }

  override update(): StateResult {
    const activeCombat = this.isAnimationCombat ? this.animCombat : this.combat;
    if (!activeCombat) return;
    const game = getGame();

    // Use real frame delta for consistent timing across refresh rates
    const realDelta = game.frameDeltaMs ?? FRAMETIME;

    switch (this.phase) {
      case 'combat': {
        // Pass real delta to combat (skip mode is handled inside AnimationCombat)
        const done = activeCombat.update(realDelta);
        if (done) {
          const initiatedPartner = activeCombat.attacker.strikePartner;
          queueAfterInitiatedCombatEvents(
            game,
            activeCombat.attacker,
            activeCombat.defender,
            activeCombat.attackItem,
            activeCombat.defenseItem,
            'attack',
          );
          if (initiatedPartner) {
            queueAfterInitiatedCombatEvents(
              game,
              initiatedPartner,
              activeCombat.defender,
              activeCombat.attackItem,
              activeCombat.defenseItem,
              'attack',
            );
          }
          this.results = activeCombat.applyResults(game.actionLog);
          applyCombatItemEndHooks(game, activeCombat.strikes);
          queueCombatItemEvents(game, activeCombat.strikes);
          if (this.results.stolenItem) {
            const stolenItem = this.results.stolenItem;
            const stealDefender = this.getPrimaryCombatDefender() ?? activeCombat.defender;
            game.actionLog.doAction(new MoveItemBetweenUnitsAction(
              stealDefender,
              activeCombat.attacker,
              stolenItem,
            ));
            if (activeCombat.attacker.team !== 'player') {
              game.actionLog.doAction(new SetItemDroppableAction(stolenItem, true));
            }
            game.actionLog.doAction(new UpdateRecordsAction(
              'steal',
              activeCombat.attacker.nid,
              stealDefender.nid,
              stolenItem.nid,
            ));
          }
          // Droppable item pickup (Python simple_combat.handle_item_gain).
          const pickupResult = applyDroppableItemPickups(
            game.actionLog,
            game.db,
            this.results,
            activeCombat.attacker,
            this.getPrimaryCombatDefender() ?? activeCombat.defender,
          );
          this.gotItemBannerQueue = pickupResult.banners;
          this.pendingDiscards = pickupResult.pendingDiscards;
          if (this.results.attackerRankUp) {
            const rankUp = this.results.attackerRankUp;
            const weaponType = activeCombat.attackItem.getComponent<string>('weapon_type');
            if (weaponType) {
              game.eventManager?.trigger(
                {
                  type: 'unit_weapon_rank_up',
                  levelNid: game.currentLevel?.nid ?? '',
                  unitNid: activeCombat.attacker.nid,
                  unit1: activeCombat.attacker,
                  weaponType,
                  oldWexp: (activeCombat.attacker.wexp[weaponType] ?? 0) - this.results.attackerWexpGained,
                  rank: rankUp.rank,
                },
                {
                  game,
                  unit1: activeCombat.attacker,
                  unit2: this.getPrimaryCombatDefender() ?? activeCombat.defender,
                  gameVars: game.gameVars,
                  levelVars: game.levelVars,
                },
              );
            }
          }
          // Record combat message for turnwheel
          const atkName = activeCombat.attacker.name;
          const primaryDefender = this.getPrimaryCombatDefender();
          const defName = primaryDefender?.name;
          const isSpell = activeCombat.attackItem?.isSpell?.();
          const isHeal = activeCombat.attackItem?.targetsAllies?.();
          if (isHeal && defName) {
            game.actionLog.doAction(new MessageAction(`${atkName} helped ${defName}`));
          } else if (isSpell) {
            game.actionLog.doAction(new MessageAction(`${atkName} used ${activeCombat.attackItem?.name ?? 'spell'}`));
          } else if (defName) {
            game.actionLog.doAction(new MessageAction(`${atkName} attacked ${defName}`));
          } else {
            game.actionLog.doAction(new MessageAction(`${atkName} attacked`));
          }
          if (this.results.attackerDead || this.getDefenderDeaths().length > 0) {
            this.phase = 'death';
            this.phaseTimer = 0;
            this.deathFadeProgress = 0;
          } else if (this.results.expGained > 0 && activeCombat.attacker.team === 'player') {
            this.startExpPhase();
          } else {
            this.startRankUpOrCleanup();
          }
        }
        break;
      }

      case 'death': {
        // Death animation: 350ms fade-out
        this.phaseTimer += realDelta;
        this.deathFadeProgress = Math.min(1, this.phaseTimer / 350);
        if (this.phaseTimer >= 350) {
          // Remove dead units from board and initiative tracker
          for (const deadDefender of this.getDefenderDeaths()) {
            game.actionLog.doAction(new DeathAction(deadDefender, game.board, game.initiative));
          }
          if (this.results!.attackerDead) {
            game.actionLog.doAction(new DeathAction(
              activeCombat!.attacker,
              game.board,
              game.initiative,
            ));
          }

          // Check if attacker earned EXP
          if (
            !this.results!.attackerDead &&
            this.results!.expGained > 0 &&
            activeCombat!.attacker.team === 'player'
          ) {
            this.startExpPhase();
          } else {
            this.startRankUpOrCleanup();
          }
        }
        break;
      }

      // ---------------------------------------------------------------
      // EXP state machine — faithful port of Python ExpState
      // Phases: exp_init → exp_wait → exp0 → [exp100 →] exp_leave → [level_up → level_screen →] cleanup
      // ---------------------------------------------------------------

      case 'exp_init': {
        // Create the ExpBar, start fade-in
        const isCombatContext = !!this.getActiveCombat();
        this.expBar = new ExpBarClass(this.expOldExp, !isCombatContext);
        this.expStartTime = this.phaseTimer; // Use phaseTimer as accumulated time
        this.phase = 'exp_wait';
        this.phaseTimer = 0;
        break;
      }

      case 'exp_wait': {
        // 466ms pause before bar starts filling. Bar fades in during this time.
        this.phaseTimer += realDelta;
        if (this.expBar) this.expBar.update(this.expOldExp);
        if (this.phaseTimer > 466) {
          this.phase = 'exp0';
          this.phaseTimer = 0;
          // Start looping "Experience Gain" SFX
          game.audioManager?.playSfxLoop?.('Experience Gain');
        }
        break;
      }

      case 'exp0': {
        // Fill bar at 1 frame per EXP point. Linear interpolation.
        this.phaseTimer += realDelta;
        const progress = Math.min(1, this.phaseTimer / this.expTotalTime);
        const expSet = this.expOldExp + progress * this.expGainAmount;
        if (this.expBar) this.expBar.update(expSet);

        // Stop SFX when fill reaches target
        if (Math.floor(expSet) >= this.expOldExp + this.expGainAmount) {
          game.audioManager?.stopSfx?.('Experience Gain');
        }

        // Check if bar reaches 100 (level-up threshold)
        if (Math.floor(expSet) >= 100 && this.expNeedLevelUp) {
          this.phase = 'exp100';
          // Don't reset phaseTimer — continue from current time for smooth animation
          break;
        }

        // Wait extra 500ms after fill completes, then fade out
        if (this.phaseTimer >= this.expTotalTime + 500) {
          game.audioManager?.stopSfx?.('Experience Gain');
          if (this.expBar) this.expBar.fadeOut();
          this.phase = 'exp_leave';
          this.phaseTimer = 0;
        }
        break;
      }

      case 'exp100': {
        // Bar wraps past 100, continues filling from 0 with remaining EXP
        this.phaseTimer += realDelta;
        const progress100 = Math.min(1, this.phaseTimer / this.expTotalTime);
        // Wrap: subtract 100 from the running total
        const expSet100 = this.expOldExp + (this.expGainAmount * progress100) - 100;
        const clampedExp = Math.min(this.expOldExp + this.expGainAmount - 100, expSet100);
        if (this.expBar) this.expBar.update(clampedExp);

        // Stop SFX when fill reaches wrapped target
        if (Math.floor(clampedExp) >= this.expOldExp + this.expGainAmount - 100) {
          game.audioManager?.stopSfx?.('Experience Gain');
        }

        // Wait extra 333ms after fill, then trigger level-up
        if (this.phaseTimer >= this.expTotalTime + 333) {
          // Level-up gains were already computed by applyResults
          if (this.results!.levelUps.length > 0) {
            this.levelUpGains = this.results!.levelUps[0];
          }
          // Fade out the EXP bar
          if (this.expBar) this.expBar.fadeOut();
          // Chain: exp_leave → level_up → level_screen
          this.expNeedLevelUp = true;
          this.phase = 'exp_leave';
          this.phaseTimer = 0;
        }
        break;
      }

      case 'exp_leave': {
        // Fade out the EXP bar (iris close animation)
        if (this.expBar) {
          const fadeDone = this.expBar.update();
          if (fadeDone) {
            // If level-up pending, continue to level_up phase
            if (this.levelUpGains) {
              this.phase = 'level_up';
              this.phaseTimer = 0;
              this.levelUpSoundPlayed = false;
            } else {
              this.startRankUpOrCleanup();
            }
          }
        } else {
          // No bar — skip directly
          if (this.levelUpGains) {
            this.phase = 'level_up';
            this.phaseTimer = 0;
          } else {
            this.startRankUpOrCleanup();
          }
        }
        break;
      }

      case 'level_up': {
        // Play level-up SFX once, then show dark overlay briefly before going to stat screen
        if (!this.levelUpSoundPlayed) {
          game.audioManager?.playSfx?.('Level Up');
          this.levelUpSoundPlayed = true;
          this.phaseTimer = 0;
        }
        this.phaseTimer += realDelta;
        // Brief pause (500ms) to show the "Level Up" moment with dark overlay,
        // then transition to level_screen
        if (this.phaseTimer >= 500) {
          this.phase = 'level_screen';
          this.phaseTimer = 0;
          // Create the LevelUpScreen
          const activeCombat = this.getActiveCombat();
          const unit = activeCombat?.attacker;
          if (unit && this.levelUpGains) {
            const statDefs = game.db?.stats ?? [];
            this.levelUpScreen = new LevelUpScreenClass(
              unit,
              this.levelUpGains,
              (unit.level - 1), // old level (before the level-up that already happened)
              unit.level,       // new level
              statDefs,
              game.audioManager,
              this.portraitImg,
            );
          }
        }
        break;
      }

      case 'level_screen': {
        // Update the LevelUpScreen animation
        const now = performance.now();
        if (this.levelUpScreen) {
          const result = this.levelUpScreen.update(now);
          if (result === 'entered_level_up_wait') {
            this.fireDuringUnitLevelUpTrigger();
          } else if (result === 'done') {
            this.fireUnitLevelUpTrigger();
            this.startRankUpOrCleanup();
          }
        } else {
          // No screen object — skip
          this.fireUnitLevelUpTrigger();
          this.startRankUpOrCleanup();
        }
        break;
      }

      case 'rank_up': {
        if (!this.rankUpBanner || this.rankUpBanner.update(realDelta)) {
          this.rankUpBanner = null;
          this.startRankUpOrCleanup();
        }
        break;
      }

      case 'stole': {
        if (!this.stoleBanner || this.stoleBanner.update(realDelta)) {
          this.stoleBanner = null;
          this.stoleBannerShown = true;
          this.startRankUpOrCleanup();
        }
        break;
      }

      case 'got_item': {
        if (!this.gotItemBanner || this.gotItemBanner.update(realDelta)) {
          this.gotItemBanner = null;
          this.startRankUpOrCleanup();
        }
        break;
      }

      case 'cleanup': {
        const attacker = activeCombat!.attacker;
        const defender = this.getPrimaryCombatDefender() ?? activeCombat!.defender;
        const combatDefenders = this.getCombatDefenders();
        const hasCanto = attacker.hasCanto && attacker.team === 'player' && !attacker.isDead();

        if (!attacker.isDead()) {
          game.actionLog.doAction(new HasAttackedAction(attacker));

          // Canto keeps the unit actionable; all other attacks consume the turn.
          if (!hasCanto) {
            game.actionLog.doAction(new WaitAction(attacker));
          }
        }

        // Fire combat event triggers
        if (game.eventManager) {
          const levelNid = game.currentLevel?.nid;
          const ctx = { game, unit1: attacker, unit2: defender, gameVars: game.gameVars, levelVars: game.levelVars };

          // combat_death for each dead unit
          for (const deadDefender of this.getDefenderDeaths()) {
            const killer = this.getCombatKiller(deadDefender) ?? attacker;
            game.eventManager.trigger(
              {
                type: 'combat_death',
                unit1: deadDefender,
                unit2: killer,
                unitNid: deadDefender.nid,
                position: this.results?.deathPositions?.get(deadDefender) ?? deadDefender.position,
                levelNid,
              },
              { ...ctx, unit1: deadDefender, unit2: killer },
            );
          }
          if (this.results?.attackerDead) {
            const killer = this.getCombatKiller(attacker) ?? defender;
            game.eventManager.trigger(
              {
                type: 'combat_death', unit1: attacker, unit2: killer, unitNid: attacker.nid,
                position: this.results?.deathPositions?.get(attacker) ?? attacker.position, levelNid,
              },
              { ...ctx, unit1: attacker, unit2: killer },
            );
          }

          // combat_end fires after every combat
          game.eventManager.trigger(
            {
              type: 'combat_end', unit1: attacker, unit2: defender, levelNid,
              position: this.results?.deathPositions?.get(attacker) ?? attacker.position,
              item: activeCombat!.attackItem,
              isAnimationCombat: this.isAnimationCombat,
              playback: activeCombat!.strikes,
            },
            { ...ctx, position: attacker.position, item: activeCombat!.attackItem },
          );

          // Python fires unit_death after combat_end, once the encounter's
          // end-combat hooks and records have completed.
          for (const deadDefender of this.getDefenderDeaths()) {
            const killer = this.getCombatKiller(deadDefender) ?? attacker;
            game.eventManager.trigger(
              {
                type: 'unit_death', unit1: deadDefender, unit2: killer,
                unitNid: deadDefender.nid,
                position: this.results?.deathPositions?.get(deadDefender) ?? deadDefender.position,
                levelNid,
              },
              { ...ctx, unit1: deadDefender, unit2: killer },
            );
          }
          if (this.results?.attackerDead) {
            const killer = this.getCombatKiller(attacker) ?? defender;
            game.eventManager.trigger(
              {
                type: 'unit_death', unit1: attacker, unit2: killer,
                unitNid: attacker.nid,
                position: this.results?.deathPositions?.get(attacker) ?? attacker.position,
                levelNid,
              },
              { ...ctx, unit1: attacker, unit2: killer },
            );
          }
        }

        // Activate AI groups if an enemy was involved in combat
        if (game.aiController) {
          game.aiController.activateGroupOnCombat(activeCombat!.attacker, game);
          for (const combatDefender of combatDefenders) {
            game.aiController.activateGroupOnCombat(combatDefender, game);
          }
        }

        // Check win/loss conditions
        // Note: In the original Python engine, loss conditions are handled
        // through the event system (combat_death triggers → lose_game command).
        // This auto-detect is a fallback for cases where events don't fire.
        if (game.checkLossCondition()) {
          console.warn('GAME OVER — loss condition met');
          game.state.clear();
          game.state.change('game_over');
        } else if (game.checkWinCondition()) {
          console.warn('VICTORY — win condition met');
          // TODO: push a VictoryState / trigger level_end event
        }

        // Restore phase music (pop battle music from the stack)
        if (this.didPushBattleMusic) {
          void game.audioManager.popMusic();
          this.didPushBattleMusic = false;
        }

        // Restore cursor and HUD visibility (hidden at combat start)
        game.cursor.visible = true;
        game.hud.visible = true;

        // Clear combat animation offsets
        setActiveCombatOffsets(null);

        this.combat = null;
        this.animCombat = null;
        this.isAnimationCombat = false;
        this.initialized = false;
        this.results = null;
        this.leftPlatformImg = null;
        this.rightPlatformImg = null;
        this.battleBackgroundImg = null;

        // Clear eventCombat flag
        const wasEventCombat = game.eventCombat;
        game.eventCombat = false;

        // Pop combat state
        game.state.back();

        // A full player killer force-given a droppable item must resolve the
        // 'item_discard' state (Python GiveItem force_give -> item_discard).
        if (this.pendingDiscards.length > 0) {
          const queue = (game.memory.get('item_discard_queue') as any[] | undefined) ?? [];
          queue.push(...this.pendingDiscards);
          game.memory.set('item_discard_queue', queue);
          this.pendingDiscards = [];
          game.state.change('item_discard');
        }

        // If events were triggered by combat (combat_end, combat_death), push EventState.
        // BUT skip this when combat was triggered from an event (interact_unit) —
        // EventState is already on the stack below and will resume processing.
        // Matches Python's handle_state_stack which does `pass` for event_combat.
        if (!wasEventCombat && game.eventManager?.hasActiveEvents()) {
          game.state.change('event');
        }
        // If Canto, re-enter move state for remaining movement
        else if (!wasEventCombat && hasCanto) {
          game.selectedUnit = attacker;
          game.state.change('move');
        }
        break;
      }
    }
  }

  private startExpPhase(): void {
    const game = getGame();
    // Calculate EXP bar parameters (faithful to Python ExpState.start)
    const totalExp = this.results!.expGained;
    const activeCombat = this.getActiveCombat();
    const currentExp = activeCombat!.attacker.exp;
    const hasLevelUp = this.results!.levelUps.length > 0;

    // Calculate old EXP (before gain was applied by applyResults)
    if (hasLevelUp) {
      // Bar wraps around 100: old_exp = currentExp + 100 - totalExp
      // e.g. had 70 EXP, gained 50 → leveled → now has 20, old was 70
      this.expOldExp = currentExp + 100 - totalExp;
    } else {
      this.expOldExp = currentExp - totalExp;
    }
    this.expGainAmount = totalExp;
    this.expNeedLevelUp = hasLevelUp;

    // 1 frame per EXP point at 60fps = ~16.67ms per point
    this.expTotalTime = Math.max(1, Math.abs(totalExp) * FRAMETIME);

    this.levelUpGains = null;
    this.levelUpScreen = null;
    this.levelUpSoundPlayed = false;
    this.expBar = null;

    // Start loading portrait for potential level-up screen
    if (hasLevelUp && activeCombat?.attacker) {
      const unit = activeCombat.attacker;
      const portraitNid = (unit as any).portraitNid ?? unit.nid;
      game.resources?.loadPortrait?.(portraitNid)?.then?.((img: HTMLImageElement) => {
        this.portraitImg = img;
      })?.catch?.(() => {});
    }

    this.phase = 'exp_init';
    this.phaseTimer = 0;
  }

  /**
   * Fire Python's mid-screen trigger at LevelUpScreen's once-only transition
   * into level_up_wait. EventState covers CombatState, leaving this exact
   * screen instance paused until the event finishes.
   */
  private fireDuringUnitLevelUpTrigger(): void {
    const game = getGame();
    const activeCombat = this.getActiveCombat();
    const unit = activeCombat?.attacker;
    if (!game?.eventManager || !unit || !this.levelUpGains) return;
    const triggered = game.eventManager.trigger(
      {
        type: 'during_unit_level_up',
        levelNid: game.currentLevel?.nid ?? '',
        unitNid: unit.nid,
        unit1: unit,
        statChanges: { ...this.levelUpGains },
        source: 'exp_gain',
      },
      { game, unit1: unit, gameVars: game.gameVars, levelVars: game.levelVars },
    );
    if (triggered && game.eventManager.hasActiveEvents()) {
      game.state.change('event');
    }
  }

  /**
   * Fire the `unit_level_up` trigger for a combat-driven level-up, mirroring
   * Python's level_up.py:279 `game.events.trigger(triggers.UnitLevelUp(self.unit,
   * self.stat_changes, self.source))` call which fires for every level-up
   * (not just `autolevel_to`, which already dispatches this trigger separately
   * at the event-command call site).
   */
  private fireUnitLevelUpTrigger(): void {
    const game = getGame();
    const activeCombat = this.getActiveCombat();
    const unit = activeCombat?.attacker;
    if (!game?.eventManager || !unit || !this.levelUpGains) return;
    game.eventManager.trigger(
      {
        type: 'unit_level_up',
        levelNid: game.currentLevel?.nid ?? '',
        unitNid: unit.nid,
        unit1: unit,
        statChanges: { ...this.levelUpGains },
        source: 'exp_gain',
      },
      { game, unit1: unit, gameVars: game.gameVars, levelVars: game.levelVars },
    );
  }

  private startRankUpOrCleanup(): void {
    const activeCombat = this.getActiveCombat();
    if (this.results?.stolenItem && activeCombat && !this.stoleBannerShown) {
      this.stoleBanner = new Banner(
        `${activeCombat.attacker.name} stole ${this.results.stolenItem.name}.`,
        undefined,
        1800,
      );
      this.phase = 'stole';
      this.phaseTimer = 0;
      return;
    }
    const rankUp = this.results?.attackerRankUp;
    const weaponType = activeCombat?.attackItem.getComponent<string>('weapon_type');
    if (rankUp && activeCombat && weaponType && !this.rankUpBannerShown) {
      this.rankUpBannerShown = true;
      this.rankUpBanner = new Banner(
        `${activeCombat.attacker.name} reached rank ${rankUp.rank}.`,
        weaponType,
        1800,
      );
      this.phase = 'rank_up';
      this.phaseTimer = 0;
      return;
    }
    if (this.gotItemBannerQueue.length > 0) {
      const text = this.gotItemBannerQueue.shift()!;
      this.gotItemBanner = new Banner(text, undefined, 1400);
      this.phase = 'got_item';
      this.phaseTimer = 0;
      return;
    }
    this.phase = 'cleanup';
    this.phaseTimer = 0;
  }

  override end(): StateResult {
    // Always clear combat animation offsets when this state exits
    setActiveCombatOffsets(null);
    // Stop looping EXP SFX if still playing
    const game = getGame();
    game.audioManager?.stopSfx?.('Experience Gain');
    game.memory.delete('combat_strike_partners_selected');
    const active = this.getActiveCombat();
    if (active) {
      active.attacker.strikePartner = null;
      active.defender.strikePartner = null;
    }
  }

  override draw(surf: Surface): Surface {
    // Route to the appropriate renderer
    if (this.isAnimationCombat && this.animCombat) {
      return this.drawAnimationCombat(surf);
    }
    if (!this.combat) return surf;
    return this.drawMapCombat(surf);
  }

  /** Render map combat: overlays on top of the map (lunge, flash, HP bars, etc.) */
  private drawMapCombat(surf: Surface): Surface {
    const rs = this.combat!.getRenderState();
    const game = getGame();
    const cameraOffset = game.camera.getOffset();

    const atkPos = this.combat!.attacker.position;
    // Push combat animation offsets so collectVisibleUnits applies them
    // to the underlying map render (lunge + shake on the actual sprites)
    const atkLunge = rs.attackerAnim.lungeOffset;
    const atkShake = rs.attackerAnim.shakeOffset;
    const defLunge = rs.defenderAnim.lungeOffset;
    const defShake = rs.defenderAnim.shakeOffset;
    const defenderOffsets = new Map<UnitObject, [number, number]>(rs.defenders.map((entry) => [
      entry.unit,
      [
        entry.anim.lungeOffset[0] + entry.anim.shakeOffset[0],
        entry.anim.lungeOffset[1] + entry.anim.shakeOffset[1],
      ],
    ]));
    for (const entry of rs.assistants) {
      defenderOffsets.set(entry.unit, [
        entry.anim.lungeOffset[0] + entry.anim.shakeOffset[0],
        entry.anim.lungeOffset[1] + entry.anim.shakeOffset[1],
      ]);
    }
    setActiveCombatOffsets({
      attacker: this.combat!.attacker,
      defender: this.combat!.defender,
      attackerOffset: [atkLunge[0] + atkShake[0], atkLunge[1] + atkShake[1]],
      defenderOffset: [defLunge[0] + defShake[0], defLunge[1] + defShake[1]],
      defenderOffsets,
    });

    // White flash overlay on hit targets
    if (rs.attackerAnim.flashAlpha > 0 && atkPos) {
      const fx = atkPos[0] * TILEWIDTH - cameraOffset[0];
      const fy = atkPos[1] * TILEHEIGHT - cameraOffset[1];
      surf.fillRect(
        fx - 4, fy - 4,
        TILEWIDTH + 8, TILEHEIGHT + 8,
        `rgba(255,255,255,${rs.attackerAnim.flashAlpha.toFixed(2)})`,
      );
    }
    for (const entry of rs.defenders) {
      const position = entry.unit.position;
      if (entry.anim.flashAlpha <= 0 || !position) continue;
      const fx = position[0] * TILEWIDTH - cameraOffset[0];
      const fy = position[1] * TILEHEIGHT - cameraOffset[1];
      surf.fillRect(fx - 4, fy - 4, TILEWIDTH + 8, TILEHEIGHT + 8,
        `rgba(255,255,255,${entry.anim.flashAlpha.toFixed(2)})`);
    }

    // map_hit_add_blend / map_hit_sub_blend color tint on hit targets.
    // Additive blend brightens using the composite canvas 'lighter' op;
    // subtractive blend is approximated with a normal dark overlay (canvas
    // has no true subtractive blend mode) -- see PLAN.md for the note.
    this.drawUnitTint(surf, rs.attackerAnim, atkPos, cameraOffset);
    for (const entry of rs.defenders) {
      this.drawUnitTint(surf, entry.anim, entry.unit.position, cameraOffset);
    }

    // HP bars (positioned above the unit, accounting for shake/lunge).
    // no_map_hp_display suppresses both bars for this item use.
    if (!rs.noMapHpDisplay) {
      if (atkPos) {
        const atkShakeX = rs.attackerAnim.shakeOffset[0] + rs.attackerAnim.lungeOffset[0];
        const ax = atkPos[0] * TILEWIDTH - cameraOffset[0] + atkShakeX;
        const ay = atkPos[1] * TILEHEIGHT - cameraOffset[1] - 6;
        this.drawHpBar(surf, ax, ay, rs.attackerHp, rs.attackerMaxHp);
      }
      for (const entry of rs.defenders) {
        const position = entry.unit.position;
        if (!position) continue;
        const offsetX = entry.anim.shakeOffset[0] + entry.anim.lungeOffset[0];
        const dx = position[0] * TILEWIDTH - cameraOffset[0] + offsetX;
        const dy = position[1] * TILEHEIGHT - cameraOffset[1] - 6;
        this.drawHpBar(surf, dx, dy, entry.hp, entry.maxHp);
      }
    }

    // Floating damage numbers
    this.drawDamagePopupsMap(surf, rs.damagePopups, cameraOffset);

    // Death fade-out: dim the dying unit's tile with white overlay
    if (this.phase === 'death') {
      const alpha = this.deathFadeProgress * 0.85;
      for (const deadDefender of this.getDefenderDeaths()) {
        const position = deadDefender.position;
        if (!position) continue;
        const dx = position[0] * TILEWIDTH - cameraOffset[0];
        const dy = position[1] * TILEHEIGHT - cameraOffset[1];
        surf.fillRect(dx - 24, dy - 32, 64, 48, `rgba(255,255,255,${alpha.toFixed(2)})`);
      }
      if (this.results?.attackerDead && atkPos) {
        const ax = atkPos[0] * TILEWIDTH - cameraOffset[0];
        const ay = atkPos[1] * TILEHEIGHT - cameraOffset[1];
        surf.fillRect(ax - 24, ay - 32, 64, 48, `rgba(255,255,255,${alpha.toFixed(2)})`);
      }
    }

    // EXP / Level-up overlays (shared with animation combat)
    this.drawExpAndLevelUp(surf);

    return surf;
  }

  // ================================================================
  // Animation Combat Renderer — GBA-style full-screen battle scene
  // ================================================================

  /** Render the GBA-style animation combat scene. */
  private drawAnimationCombat(surf: Surface): Surface {
    // Pass camera offset so the viewbox iris can compute tile-relative positions
    const game = getGame();
    const cameraOffset = game.camera.getOffset();
    this.animCombat!.setCameraOffset(cameraOffset[0], cameraOffset[1]);

    const rs = this.animCombat!.getRenderState();

    // Screen shake (used for background/platforms)
    const shakeX = rs.screenShake[0];
    const shakeY = rs.screenShake[1];

    // Python-faithful sprite shake: sprites get negated total_shake_x (so they
    // move opposite to platforms, creating a ground-rumbling visual effect).
    // Python: shake = (-total_shake_x, total_shake_y)
    const spriteShakeX = -rs.totalShakeX;
    const spriteShakeY = rs.totalShakeY;

    // --- Viewbox iris during fade_in/fade_out ---
    // During transitions, the map is visible and we darken around a shrinking/growing iris.
    if (rs.viewbox) {
      const vb = rs.viewbox;
      // Darken everything outside the viewbox iris
      // Top bar
      if (vb.y > 0) {
        surf.fillRect(0, 0, WINWIDTH, Math.max(0, vb.y), 'rgba(0,0,0,0.75)');
      }
      // Bottom bar
      const botY = vb.y + vb.height;
      if (botY < WINHEIGHT) {
        surf.fillRect(0, botY, WINWIDTH, WINHEIGHT - botY, 'rgba(0,0,0,0.75)');
      }
      // Left bar (between top and bottom bars)
      if (vb.x > 0) {
        surf.fillRect(0, Math.max(0, vb.y), vb.x, Math.max(0, vb.height), 'rgba(0,0,0,0.75)');
      }
      // Right bar
      const rightX = vb.x + vb.width;
      if (rightX < WINWIDTH) {
        surf.fillRect(rightX, Math.max(0, vb.y), WINWIDTH - rightX, Math.max(0, vb.height), 'rgba(0,0,0,0.75)');
      }

      // If still fading in, don't draw the battle scene yet
      if (rs.state === 'fade_in') {
        return surf;
      }
    }

    // --- Full battle scene background ---
    // Once past fade_in, fill the screen with the battle background
    if (rs.state !== 'fade_in') {
      // Dark fallback fill (in case panorama hasn't loaded or is missing)
      surf.fillRect(shakeX, shakeY, WINWIDTH, WINHEIGHT, 'rgb(16,20,32)');
      // Draw the panorama background image if available
      if (this.battleBackgroundImg) {
        const bgW = this.battleBackgroundImg.naturalWidth || WINWIDTH;
        const bgH = this.battleBackgroundImg.naturalHeight || WINHEIGHT;
        surf.drawImageFull(this.battleBackgroundImg, shakeX, shakeY, bgW, bgH);
      }
    }

    // --- Platforms ---
    // GBA-style: left platform on the left, right platform on the right.
    // Melee platforms: 87x40, Ranged: 100x40. Positioned at WINHEIGHT - 72 = 88.
    const isMelee = this.animCombat!.combatRange <= 1;
    const PLAT_W = isMelee ? 87 : 100;
    const PLAT_H = 40;
    const SCENE_FLOOR_Y = WINHEIGHT - 72; // 88

    // Melee: platforms touch at center. Ranged: gap with pan offset.
    // Python formula (mock_combat.py:406-417):
    //   total_shake_x = shake_offset[0] + platform_shake_offset[0]
    //   total_shake_y = shake_offset[1] + platform_shake_offset[1]
    //   if at_range:
    //     left = W/2 - width - 11 - pan_max + total_shake_x + pan_offset
    //     right = W/2 + 11 + pan_max + total_shake_x + pan_offset
    //   else:
    //     left = W/2 - width + total_shake_x
    //     right = W/2 + total_shake_x
    let leftPlatX: number;
    let rightPlatX: number;
    const panMax = this.animCombat!.panConfig?.max ?? 0;
    const platShakeX = rs.totalShakeX;
    const platShakeY = rs.totalShakeY;
    if (isMelee) {
      leftPlatX = Math.floor(WINWIDTH / 2) - PLAT_W + platShakeX;
      rightPlatX = Math.floor(WINWIDTH / 2) + platShakeX;
    } else {
      leftPlatX = Math.floor(WINWIDTH / 2) - PLAT_W - 11 - panMax + platShakeX + rs.panOffset;
      rightPlatX = Math.floor(WINWIDTH / 2) + 11 + panMax + platShakeX + rs.panOffset;
    }
    // Python: top = platform_top + (platform_trans - platform_offset * platform_trans) + total_shake_y
    const leftPlatY = SCENE_FLOOR_Y + rs.leftPlatformY + platShakeY;
    const rightPlatY = SCENE_FLOOR_Y + rs.rightPlatformY + platShakeY;

    // Draw platforms (real images or fallback rectangles)
    if (this.leftPlatformImg) {
      const pw = this.leftPlatformImg.naturalWidth || PLAT_W;
      const ph = this.leftPlatformImg.naturalHeight || PLAT_H;
      surf.drawImageFull(this.leftPlatformImg, leftPlatX, leftPlatY, pw, ph);
    } else {
      surf.fillRect(leftPlatX, leftPlatY, PLAT_W, PLAT_H, 'rgb(60,80,50)');
      surf.fillRect(leftPlatX, leftPlatY, PLAT_W, 2, 'rgb(90,120,70)');
    }
    if (this.rightPlatformImg) {
      // Right platform is drawn horizontally flipped
      const pw = this.rightPlatformImg.naturalWidth || PLAT_W;
      const ph = this.rightPlatformImg.naturalHeight || PLAT_H;
      surf.drawImageFull(this.rightPlatformImg, rightPlatX, rightPlatY, pw, ph, 1, true);
    } else {
      surf.fillRect(rightPlatX, rightPlatY, PLAT_W, PLAT_H, 'rgb(60,80,50)');
      surf.fillRect(rightPlatX, rightPlatY, PLAT_W, 2, 'rgb(90,120,70)');
    }

    // --- Battle sprites ---
    // Draw under-frames, then main frames, then over-frames.
    // Each frame has an offset in 240x160 screen coords + recoil.
    const leftDraw = rs.leftDraw;
    const rightDraw = rs.rightDraw;

    // Helper to draw a single BattleAnimDrawData
    const drawBattleSprite = (
      draw: BattleAnimDrawData,
      fallbackColor: string,
      platformX: number,
      platformY: number,
      rangeOffset: number,
    ) => {
      const alpha = Math.max(0, Math.min(1, draw.opacity / 255));
      if (alpha <= 0) return;

      // Determine canvas composite mode
      const prevComposite = surf.ctx.globalCompositeOperation;
      if (draw.blendMode === 'add') {
        surf.ctx.globalCompositeOperation = 'lighter';
      }

       // Left-side sprites (right=false) need horizontal flip since
      // animation frames are authored facing left (for right-side position).
      const flipSprite = !draw.right;

      // Python-faithful sprite X offset: get_image applies shake + range_offset
      // + pan_offset into a `left` accumulator, then adds shake[0] again for
      // right-side sprites. We replicate this exactly.
      //
      // Python get_image (battle_animation.py:830-846):
      //   left = 0
      //   if not static: left += shake[0] + range_offset
      //   if at_range and not static: left += pan_offset
      //   if right: offset = (offset[0] + shake[0] + left, offset[1] + shake[1])
      //   else:     offset = (WINWIDTH - offset[0] - width + left, offset[1] + shake[1])
      //
      // where shake = (-total_shake_x, total_shake_y)
      let spriteLeft = spriteShakeX + rangeOffset;
      if (rs.isAtRange) {
        spriteLeft += rs.panOffset;
      }

      // Draw under-frame first (behind platform)
      this.drawAnimFrame(surf, draw.underFrame, alpha, spriteShakeX, spriteShakeY, draw.recoilX, flipSprite, spriteLeft, draw.right);

      // Draw main frame
      if (draw.mainFrame) {
        this.drawAnimFrame(surf, draw.mainFrame, alpha, spriteShakeX, spriteShakeY, draw.recoilX, flipSprite, spriteLeft, draw.right);
      } else {
        // Stub placeholder: colored rectangle on the platform
        const STUB_W = 32;
        const STUB_H = 40;
        const stubX = platformX + (PLAT_W - STUB_W) / 2;
        const stubY = platformY - STUB_H;
        surf.fillRect(stubX, stubY, STUB_W, STUB_H, `rgba(${fallbackColor},${alpha.toFixed(2)})`);
        surf.fillRect(stubX + STUB_W / 2 - 4, stubY + 2, 8, 8, `rgba(200,180,150,${alpha.toFixed(2)})`);
      }

      // Draw over-frame on top
      this.drawAnimFrame(surf, draw.overFrame, alpha, spriteShakeX, spriteShakeY, draw.recoilX, flipSprite, spriteLeft, draw.right);

      // Death flash: white overlay
      if (draw.deathFlash && draw.mainFrame) {
        const f = draw.mainFrame;
        surf.fillRect(
          f.offset[0] + spriteShakeX + draw.recoilX,
          f.offset[1] + spriteShakeY,
          (f.image as HTMLCanvasElement).width ?? 32,
          (f.image as HTMLCanvasElement).height ?? 40,
          'rgba(255,255,255,0.9)',
        );
      }

      // Tints
      for (const tint of draw.tints) {
        if (tint.alpha > 0 && draw.mainFrame) {
          const f = draw.mainFrame;
          const [tr, tg, tb] = tint.color;
          surf.fillRect(
            f.offset[0] + spriteShakeX + draw.recoilX,
            f.offset[1] + spriteShakeY,
            (f.image as HTMLCanvasElement).width ?? 32,
            (f.image as HTMLCanvasElement).height ?? 40,
            `rgba(${tr},${tg},${tb},${(tint.alpha * 0.5).toFixed(2)})`,
          );
        }
      }

      // Draw child effects (under first, then over)
      for (const ue of draw.underEffects) {
        drawBattleSprite(ue, fallbackColor, platformX, platformY, rangeOffset);
      }
      for (const e of draw.effects) {
        drawBattleSprite(e, fallbackColor, platformX, platformY, rangeOffset);
      }

      // Restore composite mode
      surf.ctx.globalCompositeOperation = prevComposite;
    };

    // Draw left combatant (Python: left_range_offset = -24 - pan_max for ranged, 0 for melee)
    drawBattleSprite(leftDraw, '80,120,200', leftPlatX, leftPlatY, rs.leftRangeOffset);
    // Draw right combatant (Python: right_range_offset = 24 + pan_max for ranged, 0 for melee)
    drawBattleSprite(rightDraw, '200,80,80', rightPlatX, rightPlatY, rs.rightRangeOffset);

    // --- Name tags ---
    // --- Name tags (top of screen, matching Python layout) ---
    // Python: name tags slide in from y=-60, visible at y=0.
    // Left name tag at x=-3, right name tag right-aligned.
    // Python sprite is ~66x16 pixels.
    const nameSlide = rs.nameTagProgress;
    if (nameSlide > 0) {
      const NAME_TAG_W = 66;
      const NAME_TAG_H = 16;
      // Slide in from above: Python uses top = -60 + name_offset * 60
      const nameY = -60 + nameSlide * 60 + shakeY;
      const leftNameX = -3 + shakeX;
      const rightNameX = WINWIDTH + 3 - NAME_TAG_W + shakeX;

      // Left name tag background (blue tint for player/left)
      surf.fillRect(leftNameX, nameY, NAME_TAG_W, NAME_TAG_H, 'rgba(32,32,64,0.9)');
      surf.drawRect(leftNameX, nameY, NAME_TAG_W, NAME_TAG_H, 'rgba(100,100,160,0.7)');
      // Center name text within tag (Python: HAlignment.CENTER at (30,8)/(36,8))
      // Use approximate char width for monospace font centering
      const charW = 5; // ~5px per char for 8px monospace
      const leftNameW = rs.leftHp.name.length * charW;
      surf.drawText(rs.leftHp.name, leftNameX + Math.floor((NAME_TAG_W - leftNameW) / 2), nameY + 4, 'white', '8px monospace');

      // Right name tag background (red tint for enemy/right)
      surf.fillRect(rightNameX, nameY, NAME_TAG_W, NAME_TAG_H, 'rgba(64,32,32,0.9)');
      surf.drawRect(rightNameX, nameY, NAME_TAG_W, NAME_TAG_H, 'rgba(160,100,100,0.7)');
      const rightNameW = rs.rightHp.name.length * charW;
      surf.drawText(rs.rightHp.name, rightNameX + Math.floor((NAME_TAG_W - rightNameW) / 2), nameY + 4, 'white', '8px monospace');
    }

    // --- HP bars (bottom of screen, matching Python layout) ---
    // Python: bars slide up from 52px below, visible at y=WINHEIGHT-barH.
    // Left bar at x=-3, right bar at x=WINWIDTH/2.
    // Python bar is 40px tall (no crit) or 48px (with crit), positioned at WINHEIGHT - barH.
    const hpSlide = rs.hpBarProgress;
    if (hpSlide > 0) {
      const HP_BAR_W = WINWIDTH / 2 + 3; // Each bar covers half the screen
      const HP_BAR_H = 40; // Matching Python's combat_main sprite height (no crit)
      // Bottom anchor: slide up from below screen
      const hpY = WINHEIGHT + (1 - hpSlide) * 52 - HP_BAR_H + shakeY;
      const leftHpX = -3 + shakeX;
      const rightHpX = WINWIDTH / 2 + shakeX;

      // Left HP bar
      this.drawBattleHpBar(surf, leftHpX, hpY, HP_BAR_W, HP_BAR_H, rs.leftHp);
      // Right HP bar
      this.drawBattleHpBar(surf, rightHpX, hpY, HP_BAR_W, HP_BAR_H, rs.rightHp);
    }

    // --- Spark effects ---
    for (const spark of rs.sparks) {
      const t = spark.elapsed / spark.duration;

      // Position spark at the defender's platform center
      const sparkBaseX = spark.isLeft
        ? leftPlatX + PLAT_W / 2
        : rightPlatX + PLAT_W / 2;
      const sparkBaseY = spark.isLeft ? leftPlatY - 16 : rightPlatY - 16;

      if (spark.type === 'hit') {
        // Burst of radiating particles
        const numParticles = 8;
        const alpha = Math.max(0, 1 - t * 1.5);
        for (let i = 0; i < numParticles; i++) {
          const angle = (i / numParticles) * Math.PI * 2;
          const dist = t * 20;
          const px = sparkBaseX + Math.cos(angle) * dist;
          const py = sparkBaseY + Math.sin(angle) * dist;
          const size = Math.max(1, 3 * (1 - t));
          surf.fillRect(px - size / 2, py - size / 2, size, size, `rgba(255,255,200,${alpha.toFixed(2)})`);
        }
      } else if (spark.type === 'crit') {
        // Dramatic crit flash + large particle burst
        const alpha = Math.max(0, 1 - t);
        if (t < 0.15) {
          // Initial flash
          const flashAlpha = (1 - t / 0.15) * 0.6;
          surf.fillRect(0, 0, WINWIDTH, WINHEIGHT, `rgba(255,255,255,${flashAlpha.toFixed(2)})`);
        }
        const numParticles = 16;
        for (let i = 0; i < numParticles; i++) {
          const angle = (i / numParticles) * Math.PI * 2 + t * 2;
          const dist = t * 35;
          const px = sparkBaseX + Math.cos(angle) * dist;
          const py = sparkBaseY + Math.sin(angle) * dist;
          const size = Math.max(1, 4 * (1 - t));
          surf.fillRect(px - size / 2, py - size / 2, size, size, `rgba(255,255,128,${alpha.toFixed(2)})`);
        }
      } else if (spark.type === 'noDamage') {
        // Small blue "ping"
        const alpha = Math.max(0, 1 - t * 2);
        const radius = t * 10 + 2;
        // Draw as a small ring approximation
        for (let i = 0; i < 8; i++) {
          const angle = (i / 8) * Math.PI * 2;
          const px = sparkBaseX + Math.cos(angle) * radius;
          const py = sparkBaseY + Math.sin(angle) * radius;
          surf.fillRect(px, py, 2, 2, `rgba(100,160,255,${alpha.toFixed(2)})`);
        }
      }
      // 'miss' is handled by damage popups already
    }

    // --- Damage popups (in battle scene space) with bounce physics ---
    for (const popup of rs.damagePopups) {
      const t = popup.elapsed; // time in ms

      // Position popups centered above the platform the hit landed on
      const isLeftSide = popup.x < WINWIDTH / (2 * TILEWIDTH);
      const popupBaseX = isLeftSide ? leftPlatX + PLAT_W / 2 : rightPlatX + PLAT_W / 2;
      const popupBaseY = isLeftSide ? leftPlatY - 24 : rightPlatY - 24;

      // Bounce physics: damped sine wave (3-phase animation)
      let floatY = 0;
      let alpha = 1;

      if (t < 400) {
        // Phase 0: Bounce (damped sine wave)
        floatY = -10 * Math.exp(-t / 250) * Math.sin(t / 25);
        alpha = Math.min(1, t / 100); // Fade in over first 100ms
      } else if (t < 1000) {
        // Phase 1: Pause (sit still)
        floatY = 0;
        alpha = 1;
      } else {
        // Phase 2: Fade out (drift upward)
        const fadeT = t - 1000;
        floatY = -fadeT / 15;
        alpha = Math.max(0, 1 - fadeT / 200);
      }

      if (popup.value === 0) {
        surf.drawText(
          'Miss', popupBaseX - 8, popupBaseY + floatY,
          `rgba(200,200,255,${alpha.toFixed(2)})`, '7px monospace',
        );
      } else {
        const text = popup.isCrit ? `${popup.value}!` : `${popup.value}`;
        const color = popup.isCrit
          ? `rgba(255,255,64,${alpha.toFixed(2)})`
          : `rgba(255,64,64,${alpha.toFixed(2)})`;
        const font = popup.isCrit ? '9px monospace' : '8px monospace';
        surf.drawText(text, popupBaseX - 4, popupBaseY + floatY, color, font);
      }
    }

    // --- Screen blend overlay ---
    if (rs.screenBlend) {
      const [r, g, b] = rs.screenBlend.color;
      surf.fillRect(
        0, 0, WINWIDTH, WINHEIGHT,
        `rgba(${r},${g},${b},${rs.screenBlend.alpha.toFixed(2)})`,
      );
    }

    // --- Fade-out iris ---
    if (rs.state === 'fade_out' && rs.viewbox) {
      const vb = rs.viewbox;
      // Draw black bars closing in
      if (vb.y > 0) surf.fillRect(0, 0, WINWIDTH, vb.y, 'rgb(0,0,0)');
      const botY = vb.y + vb.height;
      if (botY < WINHEIGHT) surf.fillRect(0, botY, WINWIDTH, WINHEIGHT - botY, 'rgb(0,0,0)');
      if (vb.x > 0) surf.fillRect(0, vb.y, vb.x, vb.height, 'rgb(0,0,0)');
      const rightX = vb.x + vb.width;
      if (rightX < WINWIDTH) surf.fillRect(rightX, vb.y, WINWIDTH - rightX, vb.height, 'rgb(0,0,0)');
    }

    // EXP / Level-up overlays (shared)
    this.drawExpAndLevelUp(surf);

    return surf;
  }

  /** Draw a battle-scene HP bar (used in animation combat).
   *  Compact layout matching GBA Python reference (40px height):
   *  Row 0: Weapon name (centered, y+2)
   *  Row 1-2: HIT / DMG labels + values (y+12, y+19)
   *  Row 3: HP number (left) + HP bar (right, y+28) */
  private drawBattleHpBar(
    surf: Surface,
    x: number,
    y: number,
    width: number,
    height: number,
    hp: { current: number; max: number; name: string; weapon: string; hit: number | null; damage: number | null; crit: number | null },
  ): void {
    // Background
    surf.fillRect(x, y, width, height, 'rgba(16,16,40,0.9)');
    surf.drawRect(x, y, width, height, 'rgba(100,100,160,0.8)');

    // Inset the content area to avoid drawing at the panel edges
    const pad = 3;
    const innerX = x + pad;
    const innerW = width - pad * 2;
    const valueRightX = x + width - pad;

    // --- Row 0: Weapon name (top, centered) ---
    const weaponFont = '7px monospace';
    const weaponCharW = 4; // approximate char width for 7px monospace
    const weaponW = hp.weapon.length * weaponCharW;
    surf.drawText(hp.weapon, innerX + Math.floor((innerW - weaponW) / 2), y + 2, 'rgba(220,220,255,1)', weaponFont);

    // --- Rows 1-2: Combat stats (HIT / DMG) ---
    const statFont = '6px monospace';
    const statLabelColor = 'rgba(140,140,180,1)';
    const statValueColor = 'rgba(255,255,255,1)';
    let statY = y + 11;

    // HIT
    surf.drawText('HIT', innerX, statY, statLabelColor, statFont);
    const hitStr = hp.hit !== null ? `${hp.hit}` : '--';
    surf.drawTextRight(hitStr, valueRightX, statY, statValueColor, statFont);
    statY += 7;

    // DMG
    surf.drawText('DMG', innerX, statY, statLabelColor, statFont);
    const dmgStr = hp.damage !== null ? `${hp.damage}` : '--';
    surf.drawTextRight(dmgStr, valueRightX, statY, statValueColor, statFont);

    // --- Row 3: HP number (left) + HP bar (right) ---
    const barX = innerX + 16;
    const barY = y + height - 9;
    const barW = innerW - 16;
    const barH = 5; // Matching Python's blip height
    const ratio = hp.max > 0 ? Math.max(0, Math.min(1, hp.current / hp.max)) : 0;

    // HP number to the left of the bar
    surf.drawTextRight(`${hp.current}`, barX - 2, barY - 1, 'white', '6px monospace');

    surf.fillRect(barX, barY, barW, barH, 'rgba(32,32,32,1)');
    let color: string;
    if (ratio > 0.5) color = 'rgba(64,200,64,1)';
    else if (ratio > 0.25) color = 'rgba(220,200,32,1)';
    else color = 'rgba(220,48,48,1)';
    const filled = Math.round(barW * ratio);
    if (filled > 0) surf.fillRect(barX, barY, filled, barH, color);
    surf.drawRect(barX, barY, barW, barH, 'rgba(120,120,140,0.8)');
  }

  /** Draw damage popups for map combat (tile-space positions). */
  private drawDamagePopupsMap(
    surf: Surface,
    popups: Array<{ x: number; y: number; value: number; isCrit: boolean; elapsed: number; duration: number }>,
    cameraOffset: [number, number],
  ): void {
    for (const popup of popups) {
      const t = popup.elapsed / popup.duration;
      const floatY = -12 * t;
      const alpha = Math.max(0, 1 - t * 1.2);
      const px = popup.x * TILEWIDTH - cameraOffset[0] + TILEWIDTH / 2;
      const py = popup.y * TILEHEIGHT - cameraOffset[1] + floatY - 4;

      if (popup.value === 0) {
        surf.drawText('Miss', px - 8, py, `rgba(200,200,255,${alpha.toFixed(2)})`, '7px monospace');
      } else {
        const text = popup.isCrit ? `${popup.value}!` : `${popup.value}`;
        const color = popup.isCrit
          ? `rgba(255,255,64,${alpha.toFixed(2)})`
          : `rgba(255,255,255,${alpha.toFixed(2)})`;
        const font = popup.isCrit ? '9px monospace' : '8px monospace';
        surf.drawText(text, px - 4, py, color, font);
      }
    }
  }

  /** Draw EXP bar and level-up stats (shared between map and animation combat). */
  private drawExpAndLevelUp(surf: Surface): void {
    // Draw EXP bar during all exp sub-phases
    const expPhases = ['exp_init', 'exp_wait', 'exp0', 'exp100', 'exp_leave'];
    if (expPhases.includes(this.phase)) {
      if (this.expBar) {
        this.expBar.draw(surf);
      }
    }

    // Dark overlay during level_up phase (before stat screen)
    if (this.phase === 'level_up') {
      surf.fillRect(0, 0, WINWIDTH, WINHEIGHT, `rgba(0,0,0,${this.darkFuzzAlpha.toFixed(2)})`);
    }

    // Level-up stat screen
    if (this.phase === 'level_screen' && this.levelUpScreen) {
      this.levelUpScreen.draw(surf, performance.now());
    }

    if (this.phase === 'rank_up' && this.rankUpBanner) {
      this.rankUpBanner.draw(surf);
    }
    if (this.phase === 'stole' && this.stoleBanner) {
      this.stoleBanner.draw(surf);
    }
  }

  /**
   * Draw a single animation frame (mainFrame/underFrame/overFrame) from
   * BattleAnimDrawData onto the battle scene surface.
   *
   * Frame offsets are in 240x160 screen space. The image is an
   * HTMLCanvasElement (palette-converted frame) or ImageBitmap.
   *
   * Python-faithful positioning (battle_animation.py:830-846):
   *   For right-side: final_x = offset[0] + shake[0] + left
   *   For left-side:  final_x = WINWIDTH - offset[0] - width + left
   *   where left = shake[0] + range_offset + pan_offset (the `spriteLeft` param)
   *
   * Note: resolveFrame already handles the left-side mirroring
   * (WINWIDTH - ox - frameWidth), so for left-side sprites the offset is
   * already mirrored. We just need to add spriteLeft (which includes
   * shake + range + pan) and for right-side sprites, also add shake[0].
   */
  private drawAnimFrame(
    surf: Surface,
    frame: { image: ImageBitmap | HTMLCanvasElement; offset: [number, number] } | null,
    alpha: number,
    spriteShakeX: number,
    spriteShakeY: number,
    recoilX: number,
    flipH: boolean = false,
    spriteLeft: number = 0,
    isRight: boolean = true,
  ): void {
    if (!frame) return;

    const img = frame.image;
    // Python: right side gets shake[0] + left; left side gets just left
    // (because left-side mirroring in resolveFrame already handles the base offset)
    const ox = isRight
      ? frame.offset[0] + spriteShakeX + spriteLeft + recoilX
      : frame.offset[0] + spriteLeft + recoilX;
    const oy = frame.offset[1] + spriteShakeY;

    const srcW = (img as HTMLCanvasElement).width ?? 32;
    const srcH = (img as HTMLCanvasElement).height ?? 40;
    surf.drawImageFull(img, ox, oy, srcW, srcH, alpha, flipH);
  }

  /**
   * Draw a map_hit_add_blend / map_hit_sub_blend color tint over a unit's
   * tile. Additive tints use canvas 'lighter' composite to brighten;
   * subtractive tints are approximated with a translucent dark overlay
   * (canvas 2D has no true subtractive/darken-only blend primitive).
   */
  private drawUnitTint(
    surf: Surface,
    anim: { tintColor: [number, number, number] | null; tintMode: 'add' | 'sub' | null; tintAlpha: number },
    position: [number, number] | null,
    cameraOffset: [number, number],
  ): void {
    if (!anim.tintColor || !anim.tintMode || anim.tintAlpha <= 0 || !position) return;
    const [r, g, b] = anim.tintColor;
    const fx = position[0] * TILEWIDTH - cameraOffset[0];
    const fy = position[1] * TILEHEIGHT - cameraOffset[1];
    const alpha = anim.tintAlpha.toFixed(2);
    const ctx = surf.ctx;
    const prevOp = ctx.globalCompositeOperation;
    if (anim.tintMode === 'add') {
      ctx.globalCompositeOperation = 'lighter';
      surf.fillRect(fx, fy, TILEWIDTH, TILEHEIGHT, `rgba(${r},${g},${b},${alpha})`);
    } else {
      // Darken toward the subtractive color.
      surf.fillRect(fx, fy, TILEWIDTH, TILEHEIGHT, `rgba(${255 - r},${255 - g},${255 - b},${alpha})`);
    }
    ctx.globalCompositeOperation = prevOp;
  }

  private drawHpBar(
    surf: Surface,
    x: number,
    y: number,
    current: number,
    max: number,
  ): void {
    const width = TILEWIDTH;
    const height = 4;
    const ratio = max > 0 ? Math.max(0, Math.min(1, current / max)) : 0;

    // Background
    surf.fillRect(x, y, width, height, 'rgba(32,32,32,0.8)');
    // Filled portion
    let color: string;
    if (ratio > 0.5) {
      color = 'rgba(64,200,64,1)';
    } else if (ratio > 0.25) {
      color = 'rgba(220,200,32,1)';
    } else {
      color = 'rgba(220,48,48,1)';
    }
    const filled = Math.round(width * ratio);
    if (filled > 0) {
      surf.fillRect(x, y, filled, height, color);
    }
    // Border
    surf.drawRect(x, y, width, height, 'rgba(120,120,120,0.8)');
  }

}

// ============================================================================
// 7. AIState
// ============================================================================

export class AIState extends MapState {
  readonly name = 'ai';

  private aiUnits: UnitObject[] = [];
  private currentAiIndex: number = 0;
  private frameCounter: number = 0;
  private processing: boolean = false;
  private waitingForCombat: boolean = false;
  private waitingForMovement: boolean = false;
  private waitingForEvent: boolean = false;
  private pendingCombatTarget: UnitObject | null = null;
  private pendingCombatWeapon: ItemObject | null = null;

  private moveWithAction(
    game: any,
    unit: UnitObject,
    target: [number, number],
    path?: [number, number][] | null,
  ): boolean {
    if (!unit.position) return false;
    const origin: [number, number] = [unit.position[0], unit.position[1]];
    if (origin[0] === target[0] && origin[1] === target[1]) return false;
    const movementCost = path
      ? game.pathSystem.getPathCost(unit, path, game.board)
      : 0;
    game.actionLog.doAction(
      new MoveAction(unit, origin, [target[0], target[1]], game.board, movementCost),
    );
    game.camera.focusTile(target[0], target[1]);
    return true;
  }

  override begin(): StateResult {
    const game = getGame();

    // Phase music (Python: AIState.begin() -> phase.fade_in_phase_music()).
    fadeInPhaseMusic(game);

    // Initiative mode: only process the single current initiative unit
    if (game.initiative) {
      const unitNid = game.initiative.getCurrentUnitNid();
      if (unitNid) {
        const unit = game.getUnit(unitNid);
        if (unit && unit.position && !unit.finished && !unit.isDead()) {
          this.aiUnits = [unit];
        } else {
          this.aiUnits = [];
        }
      } else {
        this.aiUnits = [];
      }
    } else {
      // Standard mode: gather all units for the current team
      const currentTeam = game.phase.getCurrent();
      this.aiUnits = game.board
        .getTeamUnits(currentTeam)
        .filter((u: UnitObject) => !u.isDead() && u.canStillAct() && game.isAiGroupActive(u.aiGroup));
    }

    this.currentAiIndex = 0;
    this.frameCounter = 0;
    this.processing = false;
    this.waitingForCombat = false;
    this.waitingForMovement = false;
    this.waitingForEvent = false;
    this.pendingCombatTarget = null;
    this.pendingCombatWeapon = null;

    game.cursor.visible = false;
  }

  override update(): StateResult {
    const game = getGame();

    // Wait for combat animation (CombatState) to finish.
    // CombatState pops itself via back(), which returns control here.
    if (this.waitingForCombat) {
      // CombatState is transparent and sits on top of us. If it has
      // popped, we are now the top state and can advance.
      // We detect this by checking if we're still waiting — CombatState
      // sets attacker.hasAttacked and attacker.finished in its cleanup.
      // Also check hasAttacked to handle canto units (finished=false but
      // hasAttacked=true).
      const unit = this.aiUnits[this.currentAiIndex];
      if (unit && (unit.finished || unit.isDead() || unit.hasAttacked)) {
        this.waitingForCombat = false;
        // AI units with canto should still be marked finished
        if (unit.hasAttacked && !unit.finished && !unit.isDead()) {
          game.actionLog.doAction(new WaitAction(unit));
        }
        this.advanceToNextUnit();
      }
      return;
    }

    // Wait for movement animations to finish
    if (this.waitingForMovement) {
      if (!game.movementSystem.isMoving()) {
        this.waitingForMovement = false;
      }
      return;
    }

    // Wait for event (from interact action) to finish
    if (this.waitingForEvent) {
      if (!game.eventManager?.hasActiveEvents()) {
        this.waitingForEvent = false;
        this.advanceToNextUnit();
      }
      return;
    }

    if (this.currentAiIndex >= this.aiUnits.length) {
      // All AI units processed — advance to turn change
      game.state.change('turn_change');
      return;
    }

    // Process one AI unit with a short delay between each.
    // SELECT (Enter/Z) fast-forwards by reducing the delay to 1 frame.
    const fastForward = game.input?.isPressed('SELECT') ?? false;
    const aiDelay = fastForward ? 1 : 6; // ~100ms normal, ~16ms when holding SELECT
    this.frameCounter++;
    if (this.frameCounter < aiDelay) return;
    this.frameCounter = 0;

    const unit = this.aiUnits[this.currentAiIndex];
    if (!unit || unit.isDead() || !unit.canStillAct()) {
      this.advanceToNextUnit();
      return;
    }

    // Mark start of AI unit's action group (turnwheel marker)
    game.actionLog.doAction(new MarkActionGroupStart(unit, 'ai'));

    // Get AI decision
    const action = game.aiController.getAction(unit);

    switch (action.type) {
      case 'attack':
      case 'steal': {
        if (action.targetPosition && action.targetUnit) {
          if (action.type === 'steal' && action.item && action.targetItem) {
            action.item.data.set('target_item', action.targetItem);
          }
          // Move unit to attack position
          const prevPos: [number, number] | null = unit.position
            ? [unit.position[0], unit.position[1]]
            : null;

          if (
            action.movePath &&
            action.movePath.length > 1 &&
            prevPos &&
            (action.targetPosition[0] !== prevPos[0] ||
              action.targetPosition[1] !== prevPos[1])
          ) {
            // Animate movement
            this.moveWithAction(game, unit, action.targetPosition, action.movePath);

            this.waitingForMovement = true;
            this.pendingCombatTarget = action.targetUnit!;
            this.pendingCombatWeapon = action.item!;
            game.movementSystem.beginMove(
              unit,
              action.movePath,
              undefined,
              () => {
                // Movement done — now push CombatState for animated combat
                this.beginAICombat(unit, this.pendingCombatTarget!, this.pendingCombatWeapon!);
              },
            );
          } else {
            // Already at position, attack directly
            this.moveWithAction(game, unit, action.targetPosition, action.movePath);
            this.beginAICombat(
              unit,
              action.targetUnit!,
              action.item!,
            );
          }
        } else {
          game.actionLog.doAction(new WaitAction(unit));
          this.advanceToNextUnit();
        }
        break;
      }

      case 'move': {
        if (action.targetPosition) {
          const prevPos: [number, number] | null = unit.position
            ? [unit.position[0], unit.position[1]]
            : null;

          this.moveWithAction(game, unit, action.targetPosition, action.movePath);

          if (action.movePath && action.movePath.length > 1 && prevPos) {
            this.waitingForMovement = true;
            game.movementSystem.beginMove(unit, action.movePath, undefined, () => {
              game.actionLog.doAction(new WaitAction(unit));
              this.waitingForMovement = false;
              this.advanceToNextUnit();
            });
          } else {
            game.actionLog.doAction(new WaitAction(unit));
            this.advanceToNextUnit();
          }
        } else {
          game.actionLog.doAction(new WaitAction(unit));
          this.advanceToNextUnit();
        }
        break;
      }

      case 'use_item': {
        // AI uses a consumable item (Vulnerary, Elixir, etc.)
        // Move to position first, then apply item effect
        if (action.targetPosition && action.item) {
          const prevPos: [number, number] | null = unit.position
            ? [unit.position[0], unit.position[1]]
            : null;

          const applyItem = () => {
            const item = action.item!;
            // Apply healing
            if (item.isHealing()) {
              game.actionLog.doAction(new HealAction(unit, item.getHealAmount()));
            }
            game.actionLog.doAction(new WeaponUsesAction(item, unit));
            game.actionLog.doAction(new WaitAction(unit));
            this.advanceToNextUnit();
          };

          if (
            action.movePath &&
            action.movePath.length > 1 &&
            prevPos &&
            (action.targetPosition[0] !== prevPos[0] ||
              action.targetPosition[1] !== prevPos[1])
          ) {
            this.moveWithAction(game, unit, action.targetPosition, action.movePath);
            this.waitingForMovement = true;
            game.movementSystem.beginMove(unit, action.movePath, undefined, () => {
              this.waitingForMovement = false;
              applyItem();
            });
          } else {
            this.moveWithAction(game, unit, action.targetPosition, action.movePath);
            applyItem();
          }
        } else {
          game.actionLog.doAction(new WaitAction(unit));
          this.advanceToNextUnit();
        }
        break;
      }

      case 'interact': {
        // AI interacting with a region (e.g., destroying a village)
        if (action.targetPosition) {
          const prevPos: [number, number] | null = unit.position
            ? [unit.position[0], unit.position[1]]
            : null;

          const triggerInteract = () => {
            // Find the region at the target position
            const regionNid = action.regionNid;
            const regionSubNid = action.regionSubNid ?? '';
            const regions = game.currentLevel?.regions ?? [];
            const region = regionNid
              ? regions.find((r: any) => r.nid === regionNid)
              : regions.find((r: any) =>
                  r.region_type === 'event' &&
                  r.sub_nid === regionSubNid &&
                  action.targetPosition![0] >= r.position[0] &&
                  action.targetPosition![0] < r.position[0] + (r.size?.[0] ?? 1) &&
                  action.targetPosition![1] >= r.position[1] &&
                  action.targetPosition![1] < r.position[1] + (r.size?.[1] ?? 1),
                );

            if (region && game.eventManager) {
              // Build context for event trigger
              const ctx = {
                game,
                unit1: unit,
                position: action.targetPosition,
                region,
                gameVars: game.gameVars,
                levelVars: game.levelVars,
              };

              // Try RegionTrigger (uses sub_nid as trigger type, e.g., 'Destructible')
              let triggered = game.eventManager.trigger(
                { type: region.sub_nid, unit1: unit, position: action.targetPosition, region, levelNid: game.currentLevel?.nid },
                ctx,
              );

              // Compatibility fallback for destructible village events that
              // reference sibling "VillageX" region NIDs.
              if (!triggered && region.sub_nid === 'Destructible' && region.nid?.startsWith('Destroy')) {
                const aliasNid = region.nid.replace(/^Destroy/, '');
                const aliasRegion = regions.find((r: any) => r.nid === aliasNid);
                if (aliasRegion) {
                  const aliasCtx = {
                    game,
                    unit1: unit,
                    position: action.targetPosition,
                    region: aliasRegion,
                    gameVars: game.gameVars,
                    levelVars: game.levelVars,
                  };
                  triggered = game.eventManager.trigger(
                    { type: aliasRegion.sub_nid ?? region.sub_nid, unit1: unit, position: action.targetPosition, region: aliasRegion, levelNid: game.currentLevel?.nid },
                    aliasCtx,
                  );
                }
              }

              // Fallback to generic on_region_interact
              if (!triggered) {
                triggered = game.eventManager.trigger(
                  { type: 'on_region_interact', unit1: unit, position: action.targetPosition, region, levelNid: game.currentLevel?.nid },
                  ctx,
                );
              }

              // Remove region if only_once. Also consume Visit/Destructible
              // sibling on the same tile so AI/player ordering is one-time.
              if (triggered && region.only_once) {
                const siblingNid = region.nid.startsWith('Destroy')
                  ? region.nid.replace(/^Destroy/, '')
                  : `Destroy${region.nid}`;
                const sibling = regions.find(
                  (candidate: any) =>
                    candidate.nid === siblingNid &&
                    candidate.region_type === 'event' &&
                    candidate.position[0] === region.position[0] &&
                    candidate.position[1] === region.position[1],
                );
                game.actionLog.doAction(new RemoveRegionAction(region.nid, regions));
                if (sibling) {
                  game.actionLog.doAction(new RemoveRegionAction(sibling.nid, regions));
                }
              }

              // Push EventState if events were triggered
              if (triggered && game.eventManager.hasActiveEvents()) {
                this.waitingForEvent = true;
                game.state.change('event');
              }
            }

            game.actionLog.doAction(new HasAttackedAction(unit));
            game.actionLog.doAction(new WaitAction(unit));
            if (!this.waitingForEvent) {
              this.advanceToNextUnit();
            }
          };

          if (
            action.movePath &&
            action.movePath.length > 1 &&
            prevPos &&
            (action.targetPosition[0] !== prevPos[0] ||
              action.targetPosition[1] !== prevPos[1])
          ) {
            // Move first, then interact
            this.moveWithAction(game, unit, action.targetPosition, action.movePath);
            this.waitingForMovement = true;
            game.movementSystem.beginMove(unit, action.movePath, undefined, () => {
              this.waitingForMovement = false;
              triggerInteract();
            });
          } else {
            this.moveWithAction(game, unit, action.targetPosition, action.movePath);
            triggerInteract();
          }
        } else {
          game.actionLog.doAction(new WaitAction(unit));
          this.advanceToNextUnit();
        }
        break;
      }

      case 'wait':
      default: {
        // unit_wait fires before the unit is marked finished, with
        // actively_chosen=false (matches Python unit_funcs.wait() defaults).
        if (unit.position && game.eventManager) {
          const levelNid = game.currentLevel?.nid ?? '';
          const region = getRegionUnderPos(unit.position[0], unit.position[1]);
          const ctx = { game, unit1: unit, region, gameVars: game.gameVars, levelVars: game.levelVars };
          game.eventManager.trigger(
            {
              type: 'unit_wait', levelNid, unitNid: unit.nid, unit1: unit,
              position: [unit.position[0], unit.position[1]],
              region: region ?? undefined,
              localArgs: new Map<any, any>([['actively_chosen', false]]),
            },
            ctx,
          );
        }
        game.actionLog.doAction(new WaitAction(unit));
        if (game.eventManager?.hasActiveEvents()) {
          this.waitingForEvent = true;
          game.state.change('event');
          return;
        }
        this.advanceToNextUnit();
        break;
      }
    }
  }

  /**
   * Push CombatState onto the state machine so the AI combat plays
   * with the same animations (lunge, shake, HP drain, death fade, EXP)
   * that the player sees. CombatState reads game.selectedUnit and
   * game.combatTarget, then pops itself when done. AIState.update()
   * detects the pop via waitingForCombat and advances to the next unit.
   */
  private beginAICombat(
    attacker: UnitObject,
    defender: UnitObject,
    weapon: ItemObject,
  ): void {
    const game = getGame();

    // Equip the AI's chosen weapon via a reversible action so the turnwheel
    // can undo it and status_on_equip hooks fire. Matches Python's
    // action.EquipItem in ai_controller.py.
    if (attacker.canEquip(weapon)) {
      game.actionLog.doAction(new EquipItemAction(attacker, weapon));
    }
    if (attacker.items.includes(weapon)) {
      game.actionLog.doAction(new BringToTopItemAction(attacker, weapon));
    }
    if (!weapon.isWeapon()) game.memory.set('combat_item', weapon);

    // CombatState.begin() reads these to set up the MapCombat instance
    game.selectedUnit = attacker;
    game.combatTarget = defender;

    this.waitingForCombat = true;
    this.waitingForMovement = false;

    // Push CombatState on top of AIState (CombatState is transparent,
    // so AIState.draw() still runs underneath).
    game.state.change('combat');
  }

  private advanceToNextUnit(): void {
    const game = getGame();
    // Mark end of AI unit's action group (turnwheel marker)
    game.actionLog.doAction(new MarkActionGroupEnd('ai'));
    this.currentAiIndex++;
    this.frameCounter = 0;
    this.waitingForCombat = false;
  }

  override draw(surf: Surface): Surface {
    surf = drawMap(surf, false);

    // Show current AI unit indicator — but NOT when combat is in progress
    // (CombatState is transparent and draws on top, so the red rect would
    // bleed through the viewbox iris during animation combat)
    if (!this.waitingForCombat) {
      const game = getGame();
      if (this.currentAiIndex < this.aiUnits.length) {
        const unit = this.aiUnits[this.currentAiIndex];
        if (unit && unit.position) {
          const cameraOffset = game.camera.getOffset();
          const ux = unit.position[0] * TILEWIDTH - cameraOffset[0];
          const uy = unit.position[1] * TILEHEIGHT - cameraOffset[1];
          surf.drawRect(ux, uy, TILEWIDTH, TILEHEIGHT, 'rgba(255,80,80,0.8)', 2);
        }
      }
    }
    return surf;
  }
}

// ============================================================================
// 8. TurnChangeState
// ============================================================================

export class TurnChangeState extends State {
  readonly name = 'turn_change';

  override begin(): StateResult {
    const game = getGame();

    // --- Initiative mode ---
    // Python: TurnChangeState.begin() calls refresh() + back() -> 'repeat'
    // Then TurnChangeState.end() does the real work. We do both in begin()
    // since our state machine doesn't call end() on back().
    if (game.initiative) {
      // Handle end-turn supports for initiative (player unit ending turn)
      const curUnitNid = game.initiative.getCurrentUnitNid();
      if (curUnitNid) {
        const curUnit = game.getUnit(curUnitNid);
        if (curUnit && curUnit.team === 'player' && game.supports) {
          for (const [pair, points] of game.supports.getEndTurnIncrements('player', game, curUnit.nid)) {
            game.actionLog.doAction(new IncrementSupportPointsAction(pair, points));
          }
        }
      }

      // Save cursor position to memory
      game.memory.set('previous_cursor_position', game.cursor.getPosition());

      // Advance initiative to next unit
      game.initiative.next();

      // If we wrapped back to the start, increment the turn counter
      if (game.initiative.atStart()) {
        game.turnCount++;
        if (game.phase) {
          game.phase.turnCount = game.turnCount;
        }
        // Fire turn_change event
        if (game.eventManager) {
          const ctx = { game, gameVars: game.gameVars, levelVars: game.levelVars };
          game.eventManager.trigger(
            { type: 'turn_change', turnCount: game.turnCount, levelNid: game.currentLevel?.nid },
            ctx,
          );
        }
      }

      // Clear the state stack and push initiative_upkeep
      game.state.clear();
      game.state.change('initiative_upkeep');

      return 'repeat';
    }

    // --- Standard phase mode ---

    // Handle end-turn supports for standard mode
    if (game.phase?.getCurrent() === 'player' && game.supports) {
      for (const [pair, points] of game.supports.getEndTurnIncrements('player', game)) {
        game.actionLog.doAction(new IncrementSupportPointsAction(pair, points));
      }
    }
    game.memory.set('previous_cursor_position', game.cursor.getPosition());

    // Advance to next phase
    game.phase.next((team: string) => game.board.getTeamUnits(team));

    // Sync turnCount to GameState so event conditions like
    // "game.turncount == 2" resolve correctly
    game.turnCount = game.phase.turnCount;

    const currentTeam = game.phase.getCurrent();
    const turnCount = game.phase.turnCount;
    const levelNid = game.currentLevel?.nid;

    // Clear highlights before clearing the state stack (the clear() calls
    // finish() not end(), so FreeState.end() won't run to clean up highlights)
    game.highlight.clear();

    // Clear the entire state stack to prevent unbounded growth,
    // then push the appropriate states fresh.
    game.state.clear();

    if (currentTeam === 'player') {
      // Player phase: push free, then phase banner on top
      game.state.change('free');
      game.state.change('phase_change');
    } else {
      // AI phase: push ai, then phase banner on top
      game.state.change('ai');
      game.state.change('phase_change');
    }

    // Fire event triggers — they'll queue events for the EventState
    // to process after the phase banner dismisses
    if (game.eventManager) {
      const ctx = { game, gameVars: game.gameVars, levelVars: game.levelVars };

      // phase_change fires for every phase
      game.eventManager.trigger(
        { type: 'phase_change', team: currentTeam, levelNid },
        ctx,
      );

      if (currentTeam === 'player') {
        // turn_change fires on player phase
        game.eventManager.trigger(
          { type: 'turn_change', turnCount, levelNid },
          ctx,
        );
        // level_start fires on the first player turn (turnCount === 1)
        // Note: loadLevel already triggers level_start, but only on initial load.
        // Subsequent level_start events from turn_change are NOT standard — 
        // the Python engine fires level_start separately. We skip it here.
      } else if (currentTeam === 'enemy') {
        game.eventManager.trigger(
          { type: 'enemy_turn_change', turnCount, levelNid },
          ctx,
        );
      } else if (currentTeam === 'enemy2') {
        game.eventManager.trigger(
          { type: 'enemy2_turn_change', turnCount, levelNid },
          ctx,
        );
      } else {
        game.eventManager.trigger(
          { type: 'other_turn_change', turnCount, levelNid, team: currentTeam },
          ctx,
        );
      }

      // If events were triggered, push EventState on top of everything
      if (game.eventManager.hasActiveEvents()) {
        game.state.change('event');
      }
    }

    return 'repeat';
  }
}

// ============================================================================
// 8b. InitiativeUpkeepState
// ============================================================================

/**
 * InitiativeUpkeepState — Transition state for the initiative system.
 *
 * Port of Python's InitiativeUpkeep (general_states.py).
 *
 * When initiative mode is active, this state is pushed after advancing
 * to the next unit in the initiative line. It determines which team the
 * current unit belongs to, updates the phase controller, and pushes the
 * appropriate gameplay state (free for player, ai for enemies), with a
 * phase_change banner on top.
 *
 * Design: The Python version uses begin() -> back() -> end(), where
 * end() does the real work. But in our TS state machine, back() calls
 * finish() not end(). So instead we do the work directly in begin(),
 * then pop self. The states we push via change() are deferred, so they
 * won't fire until after we're popped.
 */
export class InitiativeUpkeepState extends State {
  readonly name = 'initiative_upkeep';
  override readonly transparent = false;

  override begin(): StateResult {
    const game = getGame();
    if (!game.initiative) {
      game.state.back();
      return 'repeat';
    }

    const unitNid = game.initiative.getCurrentUnitNid();
    if (!unitNid) {
      game.state.back();
      return 'repeat';
    }

    const unit = game.getUnit(unitNid);
    if (!unit || unit.isDead() || !unit.position) {
      // Unit was removed/dead/off-map — skip to next via turn_change
      game.state.back();
      game.state.change('turn_change');
      return 'repeat';
    }

    // Matches Python: phase.next() in initiative mode sets current
    // to the initiative unit's team index
    if (game.phase) {
      game.phase.setCurrentTeam(unit.team);
    }

    // Pop self
    game.state.back();

    // Push the appropriate state
    if (unit.team === 'player') {
      game.state.change('free');
    } else {
      game.state.change('ai');
    }

    // Push phase_change banner on top for visual feedback
    // (Python pushes status_upkeep too, but we don't have that yet)
    game.state.change('phase_change');

    return 'repeat';
  }

  override takeInput(_event: InputEvent): StateResult {
    return 'repeat';
  }
}

// ============================================================================
// Phase music helpers
// ============================================================================
// Port of Python's app/engine/phase.py fade_in_phase_music / fade_out_phase_music.
// Level music is keyed by `{team}_phase` (player_phase, enemy_phase, ...).
// Fade duration defaults to 400ms (Python DEFAULT_FADE_TIME_MS), overridable
// via the `_phase_music_fade_ms` game var.

function getPhaseMusicNid(game: any, team: string): string | undefined {
  const music = game.currentLevel?.music as Record<string, string> | undefined;
  return music?.[team + '_phase'];
}

function getPhaseMusicFadeMs(game: any): number {
  const val = game.gameVars.get('_phase_music_fade_ms');
  return typeof val === 'number' ? val : 400;
}

/** Python: phase.fade_out_phase_music() — called at PhaseChangeState.begin(). */
function fadeOutPhaseMusic(game: any): void {
  const nextMusicNid = getPhaseMusicNid(game, game.phase.getCurrent());
  const currentlyPlaying = game.audioManager?.getCurrentMusicNid?.();
  // Don't fade out if we'll just fade back in to the same song.
  if (currentlyPlaying && nextMusicNid && nextMusicNid === currentlyPlaying) {
    return;
  }
  game.audioManager?.fadeToPause?.(getPhaseMusicFadeMs(game));
}

/** Python: phase.fade_in_phase_music(at_turn_change) — called at PhaseChangeState.end() / FreeState.begin(). */
function fadeInPhaseMusic(game: any, atTurnChange: boolean = false): void {
  const musicNid = getPhaseMusicNid(game, game.phase.getCurrent());
  const fade = getPhaseMusicFadeMs(game);
  if (musicNid) {
    const restart = atTurnChange && !!game.db.getConstant?.('restart_phase_music', true);
    void game.audioManager?.fadeIn?.(musicNid, fade, restart);
  } else {
    game.audioManager?.fadeToPause?.(fade);
  }
}

// ============================================================================
// 9. PhaseChangeState
// ============================================================================

export class PhaseChangeState extends State {
  readonly name = 'phase_change';
  override readonly transparent = true;

  private banner: Banner | null = null;
  private fadedIn = false;

  override begin(): StateResult {
    const game = getGame();
    const currentTeam = game.phase.getCurrent();
    const turnCount = game.phase.turnCount;

    // Phase music: fade out whatever's playing before showing the banner
    // (matches Python: phase.fade_out_phase_music() at PhaseChangeState.begin()).
    fadeOutPhaseMusic(game);
    // Play this team's phase-change stinger (Python: PhaseIn.begin() plays
    // team.phase_change_sound_effect or 'Next Turn'; team-level overrides
    // aren't modeled in the web team data yet, so this always uses the default).
    game.audioManager?.playSfx?.('Next Turn');

    // Turnwheel markers: lock during non-player phases, mark phase change
    game.actionLog.doAction(new LockTurnwheel(currentTeam !== 'player'));
    game.actionLog.doAction(new MarkPhase(currentTeam));

    if (currentTeam === 'player' && game.db.getConstant('pairup', false)) {
      for (const leader of game.getAllUnits() as UnitObject[]) {
        const follower = leader.rescuing ?? (leader.traveler ? game.getUnit(leader.traveler) : null);
        if (leader.traveler && follower) {
          game.actionLog.doAction(new GuardPairUpkeepAction(leader, follower, game.db));
        }
      }
    }

    let bannerText: string;
    let subText: string;

    switch (currentTeam) {
      case 'player':
        bannerText = 'Player Phase';
        subText = `Turn ${turnCount}`;
        break;
      case 'enemy':
        bannerText = 'Enemy Phase';
        subText = `Turn ${turnCount}`;
        break;
      default:
        bannerText = `${currentTeam} Phase`;
        subText = `Turn ${turnCount}`;
        break;
    }

    this.banner = new Banner(bannerText, subText);

    // Reset units for the new phase and process status effects
    if (game.initiative) {
      // Initiative mode: only reset the current initiative unit
      const unitNid = game.initiative.getCurrentUnitNid();
      if (unitNid) {
        const unit = game.getUnit(unitNid);
        if (unit && !unit.isDead()) {
          game.actionLog.doAction(new ResetAllAction([unit]));
          const statusAction = new ProcessStatusEffectsAction(unit);
          game.actionLog.doAction(statusAction);
          if (statusAction.damage > 0 && unit.currentHp <= 0) {
            game.actionLog.doAction(new DeathAction(unit, game.board, game.initiative));
          }
        }
      }
      // Move cursor to initiative unit's position
      if (unitNid) {
        const unit = game.getUnit(unitNid);
        if (unit && unit.position) {
          game.cursor.setPos(unit.position[0], unit.position[1]);
        }
      }
    } else {
      // Standard mode: reset all units of the team
      const teamUnits: UnitObject[] = game.board.getTeamUnits(currentTeam);
      for (const unit of teamUnits) {
        game.actionLog.doAction(new ResetAllAction([unit]));
        const statusAction = new ProcessStatusEffectsAction(unit);
        game.actionLog.doAction(statusAction);
        if (statusAction.damage > 0 && unit.currentHp <= 0) {
          game.actionLog.doAction(new DeathAction(unit, game.board, game.initiative));
        }
      }
    }
  }

  /**
   * Called when this state is popped off the stack.
   * Sets the first free action on the first player turn so the
   * turnwheel cannot rewind before this point.
   */
  override finish(): void {
    const game = getGame();
    // Phase music: fade back in on the way out (Python: phase.fade_in_phase_music
    // (at_turn_change=True) at PhaseChangeState.end()).
    if (!this.fadedIn) {
      this.fadedIn = true;
      fadeInPhaseMusic(game, true);
    }
    if (game.turnCount === 1 && game.phase?.getCurrent() === 'player') {
      game.actionLog.setFirstFreeAction();
    }
  }

  override update(): StateResult {
    if (!this.banner) return;
    const game = getGame();

    const done = this.banner.update(FRAMETIME);
    if (done) {
      this.banner = null;
      game.state.back();
    }
  }

  override draw(surf: Surface): Surface {
    if (this.banner) {
      this.banner.draw(surf);
    }
    return surf;
  }
}

// ============================================================================
// 10. MovementState
// ============================================================================

export class MovementState extends State {
  readonly name = 'movement';
  override readonly transparent = true;

  override update(): StateResult {
    const game = getGame();
    // movementSystem.update() is called by the main loop;
    // we only check completion status here.
    const stillMoving = game.movementSystem.isMoving();
    if (!stillMoving) {
      game.state.back();
      // If there is a pending state after movement, push it
      if (game._pendingAfterMovement) {
        const nextState = game._pendingAfterMovement;
        game._pendingAfterMovement = null;
        game.state.change(nextState);
      }
    }
  }

  override draw(surf: Surface): Surface {
    // Transparent — underlying MapState draws the map
    return surf;
  }
}

// ============================================================================
// 11. EventState
// ============================================================================

// ===================================================================
// ShopState — Buy/sell items at a shop
// ===================================================================

type ShopPhase = 'choice' | 'buy' | 'sell' | 'done';

export class ShopState extends State {
  readonly name = 'shop';
  override readonly transparent = false;

  private phase: ShopPhase = 'choice';
  private unit: UnitObject | null = null;
  private shopItems: ItemObject[] = [];
  private shopStock: number[] = []; // -1 = unlimited
  private shopId: string | null = null;
  private money: number = 0;

  // Buy/sell menu selection
  private menuIndex: number = 0;
  private sellIndex: number = 0;

  // Choice menu (Buy/Sell)
  private choiceIndex: number = 0; // 0=Buy, 1=Sell

  // Message display
  private message: string = '';
  private messageTimer: number = 0;

  override begin(): StateResult {
    const game = getGame();
    this.unit = game.shopUnit ?? game.selectedUnit;
    this.shopItems = game.shopItems ?? [];
    this.shopStock = game.shopStock ?? this.shopItems.map(() => -1);
    this.shopId = game.shopId;
    this.money = Number(game.getMoney());
    this.phase = 'choice';
    this.menuIndex = 0;
    this.sellIndex = 0;
    this.choiceIndex = 0;
    this.message = '';
    this.messageTimer = 0;

    // Clear transient shop data
    game.shopUnit = null;
    game.shopItems = null;
    game.shopStock = null;
    game.shopId = null;
  }

  override takeInput(event: InputEvent): StateResult {
    if (!event) return;
    const game = getGame();

    // Dismiss message
    if (this.messageTimer > 0) {
      if (event === 'SELECT' || event === 'BACK') {
        this.messageTimer = 0;
        this.message = '';
      }
      return;
    }

    switch (this.phase) {
      case 'choice': {
        if (event === 'LEFT') this.choiceIndex = 0;
        if (event === 'RIGHT') this.choiceIndex = 1;
        if (event === 'SELECT') {
          if (this.choiceIndex === 0) {
            this.phase = 'buy';
            this.menuIndex = 0;
          } else {
            this.phase = 'sell';
            this.sellIndex = 0;
          }
        }
        if (event === 'BACK') {
          game.state.back();
        }
        return;
      }

      case 'buy': {
        if (event === 'UP') {
          this.menuIndex = (this.menuIndex - 1 + this.shopItems.length) % this.shopItems.length;
        }
        if (event === 'DOWN') {
          this.menuIndex = (this.menuIndex + 1) % this.shopItems.length;
        }
        if (event === 'SELECT') {
          this.tryBuyItem(game);
        }
        if (event === 'BACK') {
          this.phase = 'choice';
        }
        return;
      }

      case 'sell': {
        if (!this.unit || this.unit.items.length === 0) {
          this.phase = 'choice';
          return;
        }
        const sellableItems = this.unit.items.filter((item) => this.getFullPrice(item) > 0);
        if (sellableItems.length === 0) {
          this.showMessage('Nothing to sell.');
          this.phase = 'choice';
          return;
        }
        if (event === 'UP') {
          this.sellIndex = (this.sellIndex - 1 + sellableItems.length) % sellableItems.length;
        }
        if (event === 'DOWN') {
          this.sellIndex = (this.sellIndex + 1) % sellableItems.length;
        }
        if (event === 'SELECT') {
          this.trySellItem(game, sellableItems);
        }
        if (event === 'BACK') {
          this.phase = 'choice';
        }
        return;
      }
    }
  }

  override update(): StateResult {
    if (this.messageTimer > 0) {
      this.messageTimer -= FRAMETIME;
      if (this.messageTimer <= 0) {
        this.message = '';
        this.messageTimer = 0;
      }
    }
  }

  override draw(surf: Surface): Surface {
    // Dark background
    surf.fillRect(0, 0, surf.width, surf.height, 'rgba(8, 8, 24, 0.95)');

    const FONT = '8px monospace';
    const SMALL = '7px monospace';
    const W = surf.width;

    // Title
    surf.drawText('SHOP', 4, 4, '#FFD700', FONT);

    // Money display
    const moneyStr = `Gold: ${this.money}`;
    surf.drawText(moneyStr, W - 4 - moneyStr.length * 5, 4, '#FFD700', FONT);

    // Unit name
    if (this.unit) {
      surf.drawText(this.unit.name, 4, 16, 'white', FONT);
    }

    if (this.message) {
      // Show message centered
      const mx = Math.floor((W - this.message.length * 5) / 2);
      surf.fillRect(mx - 4, 70, this.message.length * 5 + 8, 16, 'rgba(40, 40, 80, 0.95)');
      surf.drawText(this.message, mx, 74, '#FFD700', FONT);
      return surf;
    }

    switch (this.phase) {
      case 'choice': {
        // Buy/Sell choice
        const cx = Math.floor(W / 2);
        const cy = 50;
        surf.fillRect(cx - 50, cy, 100, 20, 'rgba(32, 32, 64, 0.9)');
        surf.drawRect(cx - 50, cy, 100, 20, 'rgba(180, 180, 220, 0.6)');
        const buyColor = this.choiceIndex === 0 ? '#FFD700' : 'rgba(160,160,160,1)';
        const sellColor = this.choiceIndex === 1 ? '#FFD700' : 'rgba(160,160,160,1)';
        surf.drawText('Buy', cx - 40, cy + 6, buyColor, FONT);
        surf.drawText('Sell', cx + 15, cy + 6, sellColor, FONT);
        break;
      }

      case 'buy': {
        this.drawBuyMenu(surf, FONT, SMALL);
        break;
      }

      case 'sell': {
        this.drawSellMenu(surf, FONT, SMALL);
        break;
      }
    }

    return surf;
  }

  private drawBuyMenu(surf: Surface, FONT: string, SMALL: string): void {
    const startY = 28;
    const rowH = 14;
    const W = surf.width;

    // Column headers
    surf.drawText('Item', 20, startY, 'rgba(180,180,220,1)', SMALL);
    surf.drawText('Price', W - 35, startY, 'rgba(180,180,220,1)', SMALL);

    for (let i = 0; i < this.shopItems.length; i++) {
      const item = this.shopItems[i] as ItemObject;
      const y = startY + 10 + i * rowH;
      const stock = this.shopStock[i] ?? -1;
      const price = this.getBuyPrice(item);
      const canAfford = this.money >= price && stock !== 0;

      // Highlight selected row
      if (i === this.menuIndex) {
        surf.fillRect(2, y - 2, W - 4, rowH, 'rgba(80, 80, 140, 0.7)');
      }

      // Draw item icon (16x16)
      drawItemIcon(surf, item, 2, y - 2);

      const textColor = canAfford ? 'white' : 'rgba(128,128,128,1)';
      surf.drawText(item.name, 20, y + 1, textColor, SMALL);

      // Price
      const priceStr = String(price);
      surf.drawText(priceStr, W - 6 - priceStr.length * 4, y + 1,
        canAfford ? '#90D0FF' : 'rgba(128,128,128,1)', SMALL);

      // Stock (if limited)
      if (stock >= 0) {
        const stockStr = `x${stock}`;
        surf.drawText(stockStr, W - 50 - stockStr.length * 4, y + 1,
          stock > 0 ? 'rgba(200,200,200,1)' : 'rgba(128,128,128,1)', SMALL);
      }
    }

    // Item description at bottom
    if (this.shopItems[this.menuIndex]) {
      const desc = this.shopItems[this.menuIndex].desc || '';
      if (desc) {
        surf.fillRect(0, surf.height - 14, W, 14, 'rgba(16,16,32,0.9)');
        surf.drawText(desc.slice(0, Math.floor(W / 4)), 4, surf.height - 11, 'rgba(200,200,200,1)', SMALL);
      }
    }
  }

  private drawSellMenu(surf: Surface, FONT: string, SMALL: string): void {
    const startY = 28;
    const rowH = 14;
    const W = surf.width;
    const sellableItems = this.unit?.items.filter((item) => this.getFullPrice(item) > 0) ?? [];

    surf.drawText('Item', 20, startY, 'rgba(180,180,220,1)', SMALL);
    surf.drawText('Value', W - 35, startY, 'rgba(180,180,220,1)', SMALL);

    for (let i = 0; i < sellableItems.length; i++) {
      const item = sellableItems[i];
      const y = startY + 10 + i * rowH;
      const price = this.getSellPrice(item);

      if (i === this.sellIndex) {
        surf.fillRect(2, y - 2, W - 4, rowH, 'rgba(80, 80, 140, 0.7)');
      }

      // Draw item icon (16x16)
      drawItemIcon(surf, item, 2, y - 2);

      surf.drawText(item.name, 20, y + 1, 'white', SMALL);
      const priceStr = String(price);
      surf.drawText(priceStr, W - 6 - priceStr.length * 4, y + 1, '#90D0FF', SMALL);
    }

    if (sellableItems.length === 0) {
      surf.drawText('No items to sell', 20, startY + 12, 'rgba(160,160,160,1)', SMALL);
    }
  }

  private tryBuyItem(game: any): void {
    const item = this.shopItems[this.menuIndex];
    if (!item || !this.unit) return;
    const price = this.getBuyPrice(item);
    const stock = this.shopStock[this.menuIndex] ?? -1;

    if (stock === 0) {
      this.showMessage('Out of stock!');
      return;
    }
    if (this.money < price) {
      this.showMessage('Not enough gold!');
      return;
    }
    if (this.unit.items.length >= 5) {
      this.showMessage('Inventory full!');
      return;
    }

    const party = game.getParty();
    if (!party) return;
    game.actionLog.doAction(new HasTradedAction(this.unit));
    game.actionLog.doAction(new GainMoneyAction(-price, party.nid));
    game.actionLog.doAction(new UpdateRecordsAction('money', party.nid, -price));
    this.money = game.getMoney();
    game.actionLog.doAction(new SetGameVarAction(game.gameVars, 'money', this.money));

    if (stock > 0) {
      this.shopStock[this.menuIndex] = stock - 1;
      if (this.shopId) {
        const boughtKey = `__shop_${this.shopId}_${item.nid}`;
        const bought = Number(game.gameVars.get(boughtKey) ?? 0);
        game.actionLog.doAction(new SetGameVarAction(game.gameVars, boughtKey, bought + 1));
      }
    }

    const prefab = game.db?.items?.get(item.nid);
    if (prefab) {
      const newItem = new ItemObjectClass(prefab);
      game.actionLog.doAction(new GiveItemAction(this.unit, newItem));
      this.showMessage(`Bought ${item.name}!`);
    }
  }

  private trySellItem(game: any, sellableItems: ItemObject[]): void {
    const item = sellableItems[this.sellIndex];
    if (!item || !this.unit) return;
    const price = this.getSellPrice(item);

    const party = game.getParty();
    if (!party) return;
    game.actionLog.doAction(new HasTradedAction(this.unit));
    game.actionLog.doAction(new GainMoneyAction(price, party.nid));
    game.actionLog.doAction(new UpdateRecordsAction('money', party.nid, price));
    this.money = game.getMoney();
    game.actionLog.doAction(new SetGameVarAction(game.gameVars, 'money', this.money));
    game.actionLog.doAction(new RemoveItemFromUnitAction(this.unit, item));

    this.showMessage(`Sold ${item.name}!`);

    // Adjust sell index
    const remaining = this.unit.items.filter((candidate) => this.getFullPrice(candidate) > 0);
    if (this.sellIndex >= remaining.length) {
      this.sellIndex = Math.max(0, remaining.length - 1);
    }
    if (remaining.length === 0) {
      this.phase = 'choice';
    }
  }

  private getFullPrice(item: ItemObject): number {
    const game = getGame();
    return itemFullPrice(this.unit, item, game.db, game) ?? 0;
  }

  private getBuyPrice(item: ItemObject): number {
    const game = getGame();
    const value = itemBuyPrice(this.unit, item, game.db, game);
    if (!value) return 0;
    return Math.trunc(value * this.getPriceSkillMultiplier(item, 'change_buy_price'));
  }

  private getSellPrice(item: ItemObject): number {
    const game = getGame();
    const value = itemSellPrice(this.unit, item, game.db, game);
    if (!value) return 0;
    return Math.trunc(value * this.getPriceSkillMultiplier(item, 'change_sell_price'));
  }

  private getPriceSkillMultiplier(
    item: ItemObject,
    componentNid: 'change_buy_price' | 'change_sell_price',
  ): number {
    if (!this.unit) return 1;
    const game = getGame();
    let result = 1;
    for (const skill of this.unit.skills) {
      const value = skill.getComponent<number>(componentNid);
      if (value === undefined) continue;
      const condition = skill.getComponent<string>('condition');
      if (condition && !evaluateCondition(condition, {
        game,
        unit1: this.unit,
        item,
        position: this.unit.position ?? undefined,
        gameVars: game.gameVars,
        levelVars: game.levelVars,
      })) continue;
      result = Number(value);
    }
    return result;
  }

  private showMessage(msg: string): void {
    this.message = msg;
    this.messageTimer = 1500;
  }
}

/**
 * Set of commands that block execution until they complete.
 * All other commands are "instant" and processed in burst within a single frame.
 */
const BLOCKING_COMMANDS: Set<string> = new Set([
  'speak', 'wait', 'transition', 'alert', 'ending', 'paired_ending',
  'add_portrait', 'remove_portrait', 'music', 'change_music',
]);

type EndingPortraitPresentation = {
  surface: Surface;
  nid: string;
  position: [number, number];
  alpha: number;
  flipped: boolean;
  resolvedThroughUnit: boolean;
};

type EndingCardPresentation = {
  leftTitle: string;
  rightTitle: string | null;
  dialog: Dialog;
  portraits: EndingPortraitPresentation[];
  waitForInput: boolean;
  waitTimerMs: number;
};

type EventLevelUpSource = 'stat_change' | 'class_change' | 'promote';

type EventLevelUpPresentation = {
  owner: GameEvent;
  unit: UnitObject;
  statChanges: Record<string, number>;
  source: EventLevelUpSource;
  screen: LevelUpScreenClass;
};

type EventOverlaySprite = {
  nid: string;
  image: HTMLImageElement | null;
  position: [number, number];
  zLevel: number;
  foreground: boolean;
};

/** Maximum instant commands processed per frame to prevent infinite loops. */
const MAX_BURST = 100;

export class EventState extends State {
  readonly name = 'event';
  override readonly transparent = true;

  // Active event pulled from the EventManager queue
  private currentEvent: GameEvent | null = null;

  // Level transition lock: set when levelEnd() kicks off an async loadLevel.
  // Prevents update() from processing commands while the load is in progress.
  private levelTransitionInProgress: boolean = false;

  // When true, begin() starts with a black screen (transitionAlpha = 1)
  // instead of clearing it. Set by levelEnd() so that chapter_title +
  // transition;Open work correctly after level transitions.
  private startWithBlackScreen: boolean = false;

  // Blocking-command state
  private dialog: Dialog | null = null;
  private dialogBlocksCommands: boolean = true;
  /** Persistent ending-card presentation; active blocking is tracked by dialog. */
  private endingCard: EndingCardPresentation | null = null;
  private banner: Banner | null = null;
  private bannerIsAlert: boolean = false;  // true if banner is from 'alert' command (allows early dismiss)
  private waitTimer: number = 0;
  private waiting: boolean = false;
  private waitingForCamera: boolean = false;
  private cameraWaitStartsFlicker: boolean = false;
  private cursorFlickerTimer: number = 0;
  private blockingEventMovements: number = 0;
  /** Non-combat Python ExpState level screen owned by the command that opened it. */
  private levelUpPresentation: EventLevelUpPresentation | null = null;

  // Transition fade state
  private transitionAlpha: number = 0;
  private transitionFadingIn: boolean = false;  // true = fading to black
  private transitionFadingOut: boolean = false; // true = fading from black
  private transitionHoldBlack: boolean = false; // true = holding black between open/close
  private transitionDurationMs: number = 133;   // fade duration in ms (Python: transitions.py:14)
  /** Whether the active fade owns command-pointer advancement. */
  private transitionBlocksCommands: boolean = true;
  private transitionColor: string = '0,0,0';    // fade color as "r,g,b"

  private stateAfterTransition: string | null = null;
  // Choice menu state
  private choiceMenu: ChoiceMenu | null = null;
  private choiceResult: string | null = null;

  // For-loop state: stack of { varName, values[], currentIndex, loopStartPointer }
  private forLoopStack: { varName: string; values: string[]; currentIndex: number; startPointer: number }[] = [];

  // Skip mode: when true, all speak/narrate commands are auto-advanced
  private skipMode: boolean = false;

  // Portrait state
  private portraits: Map<string, EventPortrait> = new Map();
  private portraitPriorityCounter: number = 1;
  /** Count of portrait image loads in flight — blocks command processing until 0. */
  private pendingPortraitLoads: number = 0;
  private overlaySprites: Map<string, EventOverlaySprite> = new Map();

  // Currently speaking portrait (for talk animation)
  private speakingPortrait: EventPortrait | null = null;
  private wasDialogTyping: boolean = false;

  // Background panorama image (drawn behind portraits, on top of map)
  private background: HTMLImageElement | null = null;
  private pendingBackgroundLoad: boolean = false;
  private backgroundLoadDone: boolean = false;
  private backgroundLoadToken: number = 0;

  // Chapter title overlay state
  private chapterTitlePhase: 'none' | 'fade_in' | 'hold' | 'fade_out' = 'none';
  private chapterTitleTimer: number = 0;
  private chapterTitleText: string = '';

  // Location card state
  private locationCard: { text: string; timer: number; phase: 'fade_in' | 'hold' | 'fade_out'; alpha: number } | null = null;

  /** Effective dialog text speed in milliseconds per character. */
  private getDialogTextSpeedMs(): number {
    const game = getGame();
    const raw = game.gameVars?.get('_setting_text_speed');
    if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) {
      return raw;
    }
    if (typeof raw === 'string') {
      const parsed = Number(raw);
      if (Number.isFinite(parsed) && parsed >= 0) return parsed;
    }
    return 32;
  }

  /** Optional per-dialog speed multiplier from command args (LT `text_speed`). */
  private getDialogSpeedMultiplier(args: string[]): number {
    const parseNumeric = (value: string): number | null => {
      const parsed = Number(value.trim());
      if (!Number.isFinite(parsed) || parsed < 0) return null;
      return parsed;
    };

    // PYEV1/keyword-style args: text_speed=5 or speed=5
    for (const arg of args) {
      const trimmed = arg.trim();
      const match = trimmed.match(/^(?:text_speed|speed)\s*=\s*(\d+(?:\.\d+)?)$/i);
      if (match) {
        const parsed = parseNumeric(match[1]);
        if (parsed !== null) return parsed;
      }
    }

    // Semicolon-format positional arg order:
    // speak;speaker;text;position;width;style_nid;text_speed;...
    const positional = args[5];
    if (typeof positional === 'string' && positional.trim() !== '') {
      const parsed = parseNumeric(positional);
      if (parsed !== null) return parsed;
    }

    return 1;
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  override begin(): StateResult {
    const game = getGame();
    const nextEvent = game.eventManager?.getCurrentEvent() ?? null;
    if (!nextEvent) {
      // Nothing to process — pop back immediately.
      // Return 'repeat' so the state machine flushes this back() before
      // running update() on us (which would queue a second back()).
      game.state.back();
      return 'repeat';
    }
    // Only do a full reset when starting a genuinely NEW event.
    // When EventState is re-activated after another state pops (e.g.,
    // movement, shop, combat), we keep skipMode and other state intact.
    const isNewEvent = nextEvent !== this.currentEvent;
    this.currentEvent = nextEvent;
    if (isNewEvent) {
      this.dialogBlocksCommands = true;
      // Full reset for a new event
      this.dialog = null;
      this.endingCard = null;
      this.banner = null;
      this.bannerIsAlert = false;
      this.waitTimer = 0;
      this.waiting = false;
      this.waitingForCamera = false;
      this.cameraWaitStartsFlicker = false;
      this.cursorFlickerTimer = 0;
      this.blockingEventMovements = 0;
      // If starting from a level transition, keep the screen black so
      // chapter_title + transition;Open work as expected. Otherwise reset.
      if (!this.startWithBlackScreen) {
        this.transitionAlpha = 0;
      } else {
        this.transitionAlpha = 1;
        this.startWithBlackScreen = false;
      }
      this.transitionFadingIn = false;
      this.transitionFadingOut = false;
      this.transitionHoldBlack = false;
      this.stateAfterTransition = null;
      this.choiceMenu = null;
      this.choiceResult = null;
      this.forLoopStack = [];
      this.skipMode = false;
      this.portraits.clear();
      this.portraitPriorityCounter = 1;
      this.pendingPortraitLoads = 0;
      this.overlaySprites.clear();
      this.speakingPortrait = null;
      this.wasDialogTyping = false;
      this.background = null;
      this.pendingBackgroundLoad = false;
      this.backgroundLoadDone = false;
      this.backgroundLoadToken++;
      this.chapterTitlePhase = 'none';
      this.chapterTitleTimer = 0;
      this.chapterTitleText = '';
      this.locationCard = null;
      this.isHandlingLevelEnd = false;
      this.levelTransitionInProgress = false;
    }
  }

  // -----------------------------------------------------------------------
  // Input
  // -----------------------------------------------------------------------

  override takeInput(event: InputEvent): StateResult {
    const game = getGame();

    let effective = event;
    if (game.input?.mouseClick === 'SELECT' && !effective) {
      effective = 'SELECT';
    } else if (game.input?.mouseClick === 'BACK' && !effective) {
      effective = 'BACK';
    }

    // Forward input to dialog if active
    if (this.dialog) {
      const dialogBlocksCommands = this.dialogBlocksCommands;
      if (effective === 'BACK') {
        // Enable skip mode — dismiss this dialog and auto-skip all
        // remaining speak/narrate commands in the current event.
        this.skipMode = true;
        this.dialog = null;
        this.endingCard = null;
        if (this.speakingPortrait) {
          this.speakingPortrait.stopTalking();
          this.speakingPortrait = null;
        }
        this.wasDialogTyping = false;
        if (dialogBlocksCommands) {
          this.advancePointer();
        }
        return;
      }
      const done = this.dialog.handleInput(effective);
      if (done) {
        this.dialog = null;
        if (this.speakingPortrait) {
          this.speakingPortrait.stopTalking();
          this.speakingPortrait = null;
        }
        this.wasDialogTyping = false;
        if (dialogBlocksCommands) {
          this.advancePointer();
        }
      }
      return;
    }

    // Allow skipping chapter title
    if (this.chapterTitlePhase !== 'none') {
      if (effective === 'SELECT' || effective === 'BACK') {
        this.chapterTitlePhase = 'none';
        this.chapterTitleTimer = 0;
        this.advancePointer();
      }
      return;
    }

    // Allow early dismiss of alert banners after 300ms
    if (this.banner && this.bannerIsAlert) {
      if (effective && this.banner.getElapsed() > 300) {
        this.banner = null;
        this.bannerIsAlert = false;
        this.advancePointer();
      }
      return;
    }

    // Forward input to choice menu if active
    if (this.choiceMenu) {
      const result = this.choiceMenu.handleInput(effective);
      if (result !== null) {
        if ('selected' in result) {
          this.choiceResult = result.selected;
        } else {
          // BACK — pick first option as default
          this.choiceResult = this.choiceMenu.options[0]?.value ?? '';
        }
        this.choiceMenu = null;
        this.advancePointer();
      }
      return;
    }

    // Enable skip mode when BACK is pressed outside of any blocking UI.
    // This handles the case where the user presses Escape during wait,
    // transition, screen_shake, or between instant commands.
    if (effective === 'BACK') {
      this.skipMode = true;
      // If we're in a wait, transition, or other blockable state, resolve it
      if (this.waiting) {
        this.waiting = false;
        this.waitTimer = 0;
        this.advancePointer();
      }
      if (this.banner) {
        this.banner = null;
        this.bannerIsAlert = false;
        this.advancePointer();
      }
      if (this.locationCard) {
        this.locationCard = null;
        this.advancePointer();
      }
    }
  }

  /** Advance fades that intentionally do not pause event command dispatch. */
  private updateNonBlockingTransition(): void {
    if (this.transitionBlocksCommands) return;

    if (this.transitionFadingIn) {
      this.transitionAlpha = this.skipMode
        ? 1
        : Math.min(1, this.transitionAlpha + FRAMETIME / this.transitionDurationMs);
      if (this.transitionAlpha >= 1) {
        this.transitionFadingIn = false;
        this.transitionHoldBlack = true;
      }
    } else if (this.transitionFadingOut) {
      this.transitionAlpha = this.skipMode
        ? 0
        : Math.max(0, this.transitionAlpha - FRAMETIME / this.transitionDurationMs);
      if (this.transitionAlpha <= 0) {
        this.transitionFadingOut = false;
        this.transitionHoldBlack = false;
      }
    }
  }

  // -----------------------------------------------------------------------
  // Update — burst-processes instant commands each frame
  // -----------------------------------------------------------------------

  override update(): StateResult {
    const game = getGame();
    this.updateNonBlockingTransition();

    // Block while a level transition is loading asynchronously
    if (this.levelTransitionInProgress) {
      return;
    }

    const presentation = this.levelUpPresentation;
    if (presentation && presentation.owner === this.currentEvent) {
      const result = presentation.screen.update(performance.now());
      if (result === 'entered_level_up_wait') {
        this.dispatchEventLevelUpTrigger('during_unit_level_up', presentation, true);
      } else if (result === 'done') {
        this.dispatchEventLevelUpTrigger('unit_level_up', presentation, false);
        this.levelUpPresentation = null;
        this.advancePointer();
      }
      return;
    }
    if (this.waitingForCamera) {
      if (this.skipMode) {
        game.camera?.snapToTarget();
      }
      if (game.camera?.isAtTarget() ?? true) {
        this.waitingForCamera = false;
        if (this.cameraWaitStartsFlicker && !this.skipMode) {
          this.cameraWaitStartsFlicker = false;
          if (game.cursor) game.cursor.visible = true;
          this.cursorFlickerTimer = 1000;
        } else {
          this.cameraWaitStartsFlicker = false;
          if (this.skipMode && game.cursor) game.cursor.visible = false;
          this.advancePointer();
        }
      } else {
        return;
      }
    }

    if (this.cursorFlickerTimer > 0) {
      if (this.skipMode) {
        this.cursorFlickerTimer = 0;
      } else {
        this.cursorFlickerTimer -= FRAMETIME;
      }
      if (this.cursorFlickerTimer <= 0) {
        if (game.cursor) game.cursor.visible = false;
        this.advancePointer();
      }
      return;
    }

    if (this.blockingEventMovements > 0) {
      return;
    }


    // --- Handle active blocking UI elements first ---

    // Dialog typewriter
    if (this.dialog) {
      const dialogBlocksCommands = this.dialogBlocksCommands;
      if (this.skipMode) {
        // Skip mode: instantly dismiss dialog
        this.dialog = null;
        this.endingCard = null;
        if (this.speakingPortrait) {
          this.speakingPortrait.stopTalking();
          this.speakingPortrait = null;
        }
        this.wasDialogTyping = false;
        if (dialogBlocksCommands) {
          this.advancePointer();
        }
      } else {
        this.dialog.update(FRAMETIME);
        const isTyping = this.dialog.isTyping();
        if (this.speakingPortrait) {
          if (isTyping && !this.wasDialogTyping) {
            this.speakingPortrait.startTalking();
          } else if (!isTyping && this.wasDialogTyping) {
            this.speakingPortrait.stopTalking();
          }
        }
        this.wasDialogTyping = isTyping;
        if (this.dialog.isDone()) {
          this.dialog = null;
          if (this.speakingPortrait) {
            this.speakingPortrait.stopTalking();
            this.speakingPortrait = null;
          }
          if (dialogBlocksCommands) {
            this.advancePointer();
          }
        } else if (this.endingCard?.dialog === this.dialog &&
                   !this.endingCard.waitForInput &&
                   this.dialog.isWaiting()) {
          this.endingCard.waitTimerMs += FRAMETIME;
          if (this.endingCard.waitTimerMs >= 5000) {
            this.dialog = null;
            this.advancePointer();
          } else {
            return;
          }
        } else if (dialogBlocksCommands) {
          return;
        }
      }
    }

    // Banner timer
    if (this.banner) {
      if (this.skipMode) {
        this.banner = null;
        this.bannerIsAlert = false;
        this.advancePointer();
      } else {
        const done = this.banner.update(FRAMETIME);
        if (done) {
          this.banner = null;
          this.bannerIsAlert = false;
          this.advancePointer();
        } else {
          return; // still showing banner
        }
      }
    }

    // Wait timer
    if (this.waiting) {
      if (this.skipMode) {
        this.waiting = false;
        this.waitTimer = 0;
        this.advancePointer();
      } else {
        this.waitTimer -= FRAMETIME;
        if (this.waitTimer <= 0) {
          this.waiting = false;
          this.advancePointer();
        }
        return;
      }
    }

    // Transition fade animation
    if (this.transitionFadingIn && this.transitionBlocksCommands) {
      if (this.skipMode) {
        this.transitionAlpha = 1;
        this.transitionFadingIn = false;
        this.transitionHoldBlack = true;
        if (this.transitionBlocksCommands) {
          const nextState = this.stateAfterTransition;
          this.stateAfterTransition = null;
          this.advancePointer();
          if (nextState) {
            game.state.change(nextState);
            return;
          }
        }
      } else {
        this.transitionAlpha = Math.min(1, this.transitionAlpha + FRAMETIME / this.transitionDurationMs);
        if (this.transitionAlpha >= 1) {
          this.transitionFadingIn = false;
          this.transitionHoldBlack = true;
          if (this.transitionBlocksCommands) {
            const nextState = this.stateAfterTransition;
            this.stateAfterTransition = null;
            this.advancePointer();
            if (nextState) {
              game.state.change(nextState);
              return;
            }
          }
          // Don't return — allow burst to continue while holding black
        } else if (this.transitionBlocksCommands) {
          return;
        }
      }
    }
    if (this.transitionFadingOut && this.transitionBlocksCommands) {
      if (this.skipMode) {
        this.transitionAlpha = 0;
        this.transitionFadingOut = false;
        this.transitionHoldBlack = false;
        if (this.transitionBlocksCommands) {
          this.advancePointer();
        }
      } else {
        this.transitionAlpha = Math.max(0, this.transitionAlpha - FRAMETIME / this.transitionDurationMs);
        if (this.transitionAlpha <= 0) {
          this.transitionFadingOut = false;
          this.transitionHoldBlack = false;
          if (this.transitionBlocksCommands) {
            this.advancePointer();
          }
        }
        if (this.transitionBlocksCommands) {
          return;
        }
      }
    }

    // Choice menu — block while active
    if (this.choiceMenu) {
      return;
    }

    // Overworld movement — block while an entity is moving along a road
    if (game.overworldMovement && game.overworldMovement.isMoving()) {
      game.overworldMovement.update(FRAMETIME);
      return;
    }

    // Chapter title overlay animation
    if (this.chapterTitlePhase !== 'none') {
      if (this.skipMode) {
        this.chapterTitlePhase = 'none';
        this.chapterTitleTimer = 0;
        this.advancePointer();
      } else {
        this.chapterTitleTimer += FRAMETIME;
        switch (this.chapterTitlePhase) {
          case 'fade_in':
            if (this.chapterTitleTimer >= 1000) {
              this.chapterTitlePhase = 'hold';
              this.chapterTitleTimer = 0;
            }
            break;
          case 'hold':
            if (this.chapterTitleTimer >= 3000) {
              this.chapterTitlePhase = 'fade_out';
              this.chapterTitleTimer = 0;
            }
            break;
          case 'fade_out':
            if (this.chapterTitleTimer >= 1000) {
              this.chapterTitlePhase = 'none';
              this.chapterTitleTimer = 0;
              this.advancePointer();
            }
            break;
        }
        return;
      }
    }

    // Location card timer (non-blocking: just updates alpha, doesn't stop command processing)
    if (this.locationCard) {
      this.locationCard.timer += FRAMETIME;
      switch (this.locationCard.phase) {
        case 'fade_in':
          this.locationCard.alpha = Math.min(0.9, this.locationCard.timer / 200);
          if (this.locationCard.timer >= 200) {
            this.locationCard.phase = 'hold';
            this.locationCard.timer = 0;
          }
          break;
        case 'hold':
          this.locationCard.alpha = 0.9;
          if (this.locationCard.timer >= 2000) {
            this.locationCard.phase = 'fade_out';
            this.locationCard.timer = 0;
          }
          break;
        case 'fade_out':
          this.locationCard.alpha = Math.max(0, 0.9 - (this.locationCard.timer / 200) * 0.9);
          if (this.locationCard.timer >= 200) {
            this.locationCard = null;
          }
          break;
      }
      // Location card does NOT block command processing — fall through
    }

    // Block while portrait images are still loading (async).
    // In the original Python engine, image loads are synchronous, so portraits
    // are always available when the next command (e.g. speak) executes.
    // In skip mode, we still need to wait — the portrait must exist in the
    // portraits map for subsequent commands that reference it by name.
    if (this.pendingPortraitLoads > 0) {
      return;
    }

    // Block while a panorama from change_background is loading.
    if (this.pendingBackgroundLoad) {
      if (this.backgroundLoadDone) {
        this.pendingBackgroundLoad = false;
        this.backgroundLoadDone = false;
        this.advancePointer();
      } else {
        return;
      }
    }

    // --- Burst-process commands ---
    let burst = 0;
    while (burst < MAX_BURST) {
      burst++;

      // Ensure we have an event to process
      if (!this.currentEvent) {
        this.finishAndDequeue();
        return;
      }

      const ev = this.currentEvent;

      // Check if event is complete
      if (ev.isDone()) {
        this.finishAndDequeue();
        return;
      }

      // getNextCommand() routes through the PYEV1 processor when the event
      // is Python-syntax (prefab._source starts with '#pyev1') — it evaluates
      // if/elif/else/for/while internally and returns only the leaf command
      // lines. For standard EVNT-format events it just reads commands[commandPointer].
      // (Previously this read `ev.commands[ev.commandPointer]` directly, which
      // is always empty for PYEV1 events — see GameEvent's constructor comment
      // that commands stays [] and getNextCommand() is required — so PYEV1
      // events silently finished without executing a single command.)
      const cmd = ev.getNextCommand();
      if (!cmd) {
        // Standard events: commandPointer ran past the last parsed command.
        // PYEV1 events: the processor's internal script pointer is exhausted
        // (getNextCommand() already flips ev.state to 'done' in that case).
        // Either way there's nothing left to execute.
        this.finishAndDequeue();
        return;
      }

      // Execute the command. Returns true if the command is blocking.
      const blocking = this.executeCommand(cmd, game);
      if (blocking) {
        break; // stop burst — wait for blocking command to finish
      }
      // Instant command: pointer was already advanced inside executeCommand,
      // continue processing next command in the same frame.
    }
  }

  // -----------------------------------------------------------------------
  // Draw
  // -----------------------------------------------------------------------

  override draw(surf: Surface): Surface {
    // Background panorama (drawn on top of map, behind portraits)
    if (this.background) {
      // Center the background image on the 240x160 surface
      const bx = Math.floor((surf.width - this.background.width) / 2);
      const by = Math.floor((surf.height - this.background.height) / 2);
      surf.blitImage(this.background, 0, 0, this.background.width, this.background.height, bx, by);
    }

    // Transition fade overlay
    if (this.transitionAlpha > 0) {
      surf.fillRect(0, 0, surf.width, surf.height, `rgba(${this.transitionColor},${this.transitionAlpha})`);
    }

    // Update and draw portraits (sorted by priority, ascending)
    const dt = FRAMETIME; // ~16.67ms per frame
    const toRemove: string[] = [];
    for (const [name, portrait] of this.portraits) {
      const finished = portrait.update(dt);
      if (finished) {
        toRemove.push(name);
      }
    }
    for (const name of toRemove) {
      this.portraits.delete(name);
    }

    // Draw portraits sorted by priority (lowest first = drawn behind)
    const sortedPortraits = [...this.portraits.values()].sort(
      (a, b) => a.priority - b.priority,
    );
    for (const portrait of sortedPortraits) {
      portrait.draw(surf);
    }

    this.drawEventOverlaySprites(surf, false);

    // Ending cards persist independently of the currently blocking dialog.
    if (this.endingCard) {
      surf.fillRect(0, 0, viewport.width, viewport.height, 'rgba(12,8,32,0.96)');
      for (const portrait of this.endingCard.portraits) {
        surf.blit(portrait.surface, portrait.position[0], portrait.position[1]);
      }
      const titleCenter = Math.floor(viewport.width / 2);
      surf.drawText(
        this.endingCard.leftTitle,
        titleCenter - this.endingCard.leftTitle.length * 3,
        this.endingCard.rightTitle === null ? 24 : 12,
        'rgba(220,200,128,1)',
        '6px monospace',
      );
      if (this.endingCard.rightTitle !== null) {
        surf.drawText(
          this.endingCard.rightTitle,
          titleCenter - this.endingCard.rightTitle.length * 3,
          24,
          'rgba(220,200,128,1)',
          '6px monospace',
        );
      }
      this.endingCard.dialog.draw(surf, true);
    }
    if (this.dialog && this.dialog !== this.endingCard?.dialog) {
      this.dialog.draw(surf);
    }
    if (this.banner) {
      this.banner.draw(surf);
    }
    if (this.choiceMenu) {
      this.choiceMenu.draw(surf);
    }

    // Chapter title overlay (drawn on top of everything)
    if (this.chapterTitlePhase !== 'none') {
      let ctAlpha = 1;
      if (this.chapterTitlePhase === 'fade_in') {
        ctAlpha = Math.min(1, this.chapterTitleTimer / 1000);
      } else if (this.chapterTitlePhase === 'fade_out') {
        ctAlpha = Math.max(0, 1 - this.chapterTitleTimer / 1000);
      }

      // Black background
      surf.fillRect(0, 0, surf.width, surf.height, `rgba(0,0,0,${ctAlpha})`);

      if (ctAlpha > 0.1) {
        // Horizontal banner bar across the middle
        const bannerY = Math.floor(surf.height / 2) - 16;
        const bannerH = 32;
        surf.fillRect(0, bannerY, surf.width, bannerH, `rgba(40,20,10,${ctAlpha * 0.9})`);
        // Gold border lines
        surf.fillRect(0, bannerY, surf.width, 1, `rgba(200,170,80,${ctAlpha * 0.8})`);
        surf.fillRect(0, bannerY + bannerH - 1, surf.width, 1, `rgba(200,170,80,${ctAlpha * 0.8})`);

        // Chapter title text (centered)
        const titleColor = `rgba(255,230,120,${ctAlpha})`;
        const titleFont = '10px monospace';
        // Approximate centering
        const textW = this.chapterTitleText.length * 6; // ~6px per char at 10px mono
        const tx = Math.floor((surf.width - textW) / 2);
        const ty = bannerY + Math.floor((bannerH - 10) / 2);
        surf.drawText(this.chapterTitleText, tx, ty, titleColor, titleFont);
      }
    }

    // Location card overlay (upper-left corner)
    if (this.locationCard && this.locationCard.alpha > 0) {
      const lc = this.locationCard;
      const lcPad = 8;
      const lcFont = '8px monospace';
      const lcTextW = lc.text.length * 5; // ~5px per char at 8px mono
      const lcW = lcTextW + lcPad * 2;
      const lcH = 16 + lcPad;
      const lcX = 10;
      const lcY = 4;

      // Brown card background
      surf.fillRect(lcX, lcY, lcW, lcH, `rgba(60,40,20,${lc.alpha})`);
      surf.drawRect(lcX, lcY, lcW, lcH, `rgba(140,110,60,${lc.alpha * 0.8})`);

      // Text
      surf.drawText(lc.text, lcX + lcPad, lcY + Math.floor(lcPad / 2), `rgba(255,240,200,${lc.alpha})`, lcFont);
    }

    if (this.levelUpPresentation) {
      this.levelUpPresentation.screen.draw(surf, performance.now());
    }

    this.drawEventOverlaySprites(surf, true);

    return surf;
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  /** Advance the command pointer of the current event by 1. */
  private advancePointer(): void {
    if (this.currentEvent) {
      this.currentEvent.commandPointer++;
    }
  }

  /**
   * Open the common non-combat level screen after its action has already
   * applied the displayed changes, matching Python ExpState.
   */
  private startEventLevelUpPresentation(
    unit: UnitObject,
    statChanges: Record<string, number>,
    source: EventLevelUpSource,
    oldLevel: number,
  ): boolean {
    if (!this.currentEvent) return false;
    const game = getGame();
    this.levelUpPresentation = {
      owner: this.currentEvent,
      unit,
      statChanges: { ...statChanges },
      source,
      screen: new LevelUpScreenClass(
        unit,
        statChanges,
        oldLevel,
        unit.level,
        game.db?.stats ?? [],
        game.audioManager,
      ),
    };
    return true;
  }

  /**
   * Dispatch a level-screen hook with a fresh payload copy. Mid-screen events
   * are moved ahead of their suspended producer event in the queue so this
   * EventState can run them immediately, then resume the same screen instance.
   */
  private dispatchEventLevelUpTrigger(
    type: 'during_unit_level_up' | 'unit_level_up',
    presentation: EventLevelUpPresentation,
    interrupt: boolean,
  ): void {
    const game = getGame();
    if (!game.eventManager) return;
    const queue = game.eventManager.eventQueue as GameEvent[];
    const priorLength = queue.length;
    const triggered = game.eventManager.trigger(
      {
        type,
        levelNid: game.currentLevel?.nid ?? '',
        unitNid: presentation.unit.nid,
        unit1: presentation.unit,
        statChanges: { ...presentation.statChanges },
        source: presentation.source,
      },
      this.buildConditionContext(),
    );
    if (!interrupt || !triggered || !this.currentEvent || queue.length <= priorLength) return;

    const owner = this.currentEvent;
    const queuedInterrupts = queue.splice(priorLength);
    const ownerIndex = queue.indexOf(owner);
    if (ownerIndex >= 0) queue.splice(ownerIndex, 1);
    queue.unshift(...queuedInterrupts, owner);
    this.loadNextEvent(game);
  }

  /** Track whether we are in the middle of handling a level end sequence. */
  private isHandlingLevelEnd: boolean = false;

  /**
   * Finish the current event, dequeue it, and either load the next queued
   * event or pop the state.
   *
   * Matches Python EventState.end_event(): after dequeuing, checks _win_game
   * and _lose_game level variables to trigger level transitions.
   */
  private finishAndDequeue(): void {
    const game = getGame();
    if (this.currentEvent) {
      this.currentEvent.finish();
    }
    game.eventManager?.dequeueCurrentEvent();

    // Clean up portraits and talking state
    if (this.speakingPortrait) {
      this.speakingPortrait.stopTalking();
      this.speakingPortrait = null;
    }
    this.wasDialogTyping = false;

    // --- Check win/lose flags (matches Python end_event logic) ---

    if (game.levelVars.get('_win_game') || this.isHandlingLevelEnd) {
      game.levelVars.set('_win_game', false);
      this.isHandlingLevelEnd = true;

      // Check if LevelEnd event was already triggered
      if (game.levelVars.get('_level_end_triggered')) {
        // LevelEnd event has run — proceed with actual level transition
        this.levelEnd(game);
        return;
      }

      // Try to trigger a LevelEnd event for outro cutscenes
      const levelNid = game.currentLevel?.nid ?? '';
      const didTrigger = game.eventManager?.trigger(
        { type: 'level_end', levelNid },
        { game, gameVars: game.gameVars, levelVars: game.levelVars },
      ) ?? false;

      if (didTrigger) {
        // Mark so we know to call levelEnd() after it finishes
        game.levelVars.set('_level_end_triggered', true);
        // The next event in the queue is the LevelEnd event — load it
        this.loadNextEvent(game);
        return;
      }

      // No LevelEnd event exists — proceed directly
      this.levelEnd(game);
      return;
    }

    if (game.levelVars.get('_lose_game')) {
      game.levelVars.set('_lose_game', false);
      console.warn('GAME OVER — loss condition met via lose_game flag');
      game.state.clear();
      game.state.change('game_over');
      return;
    }

    // --- Normal event completion (no win/lose) ---
    this.loadNextEvent(game);
  }

  /**
   * Try to load the next queued event, or pop the state if none remain.
   */
  private loadNextEvent(game: any): void {
    const next = game.eventManager?.getCurrentEvent() ?? null;
    if (next) {
      this.currentEvent = next;
      this.dialog = null;
      this.endingCard = null;
      this.banner = null;
      this.waitTimer = 0;
      this.waiting = false;
      this.portraits.clear();
      this.portraitPriorityCounter = 1;
      this.pendingPortraitLoads = 0;
      this.background = null;
      this.pendingBackgroundLoad = false;
      this.backgroundLoadDone = false;
      this.backgroundLoadToken++;
      this.chapterTitleTimer = 0;
      this.chapterTitlePhase = 'none';
      this.locationCard = null;
    } else {
      this.currentEvent = null;
      this.endingCard = null;
      this.portraits.clear();
      this.pendingPortraitLoads = 0;
      this.background = null;
      this.pendingBackgroundLoad = false;
      this.backgroundLoadDone = false;
      this.backgroundLoadToken++;
      this.chapterTitleTimer = 0;
      this.chapterTitlePhase = 'none';
      this.locationCard = null;
      game.state.back();
    }
  }

  /**
   * Handle level transition after win_game.
   * Matches Python EventState.level_end():
   *   1. Clean up the current level (persist player units, heal, etc.)
   *   2. Determine the next level (via _goto_level override or sequential)
   *   3. Load the next level and transition to free state
   */
  private levelEnd(game: any): void {
    const currentLevelNid = game.currentLevel?.nid ?? '';
    game.gameVars.set('_prev_level_nid', currentLevelNid);

    // Find current level index in the ordered db.levels map
    const levelNids = Array.from(game.db.levels.keys()) as string[];
    const currentIndex = levelNids.indexOf(currentLevelNid);

    // Clean up current level state (persist player units)
    game.cleanUpLevel();

    // Determine the next level
    let nextLevelNid: string | null = null;
    const gotoLevel = game.gameVars.get('_goto_level') ?? null;

    if (gotoLevel !== null) {
      if (gotoLevel === '_force_quit') {
        // Force quit to title
        game.state.clear();
        game.state.change('title');
        this.isHandlingLevelEnd = false;
        return;
      }
      nextLevelNid = gotoLevel as string;
      game.gameVars.delete('_goto_level');
    } else if (currentIndex >= 0 && currentIndex < levelNids.length - 1) {
      // Sequential: next level in order
      const candidateNid = levelNids[currentIndex + 1];
      // Skip debug levels (matching Python: 'debug' in next_level.nid.lower())
      if (candidateNid.toLowerCase().includes('debug')) {
        console.log('No more levels (next is debug). Returning to title.');
        game.state.clear();
        game.state.change('title');
        this.isHandlingLevelEnd = false;
        return;
      }
      nextLevelNid = candidateNid;
    }

    if (!nextLevelNid) {
      console.log('No more levels! Returning to title.');
      game.state.clear();
      game.state.change('title');
      this.isHandlingLevelEnd = false;
      return;
    }

    // Store next level NID for reference
    game.gameVars.set('_next_level_nid', nextLevelNid);
    this.isHandlingLevelEnd = false;

    console.log(`Level transition: ${currentLevelNid} -> ${nextLevelNid}`);

    // Lock event processing while the async load is in progress.
    // Also null out currentEvent so the burst loop doesn't try to
    // finishAndDequeue the old event (which would dequeue the new
    // level's events from the new EventManager's queue).
    this.levelTransitionInProgress = true;
    this.currentEvent = null;

    // Load the next level and transition to gameplay
    game.loadLevel(nextLevelNid).then(() => {
      // DON'T clear levelTransitionInProgress here — it will be reset
      // in begin() when EventState is re-pushed after the deferred ops.
      // If we clear it now, update() would run the burst loop with stale
      // state before processTempState flushes the clear/change ops.
      game.state.clear();
      game.state.change('free');
      // If level_start triggered events, push EventState
      if (game.eventManager?.hasActiveEvents()) {
        // Start the new level's events with a black screen so that
        // chapter_title + transition;Open work as expected
        this.startWithBlackScreen = true;
        game.state.change('event');
      }
    }).catch((err: unknown) => {
      this.levelTransitionInProgress = false;
      console.error('Failed to load next level:', err);
      game.state.clear();
      game.state.change('title');
    });
  }

  /**
   * Find the unit by NID — first try the game unit registry, then the board.
   */
  private findUnit(nid: string): UnitObject | undefined {
    const game = getGame();
    const fromRegistry = game.units.get(nid);
    if (fromRegistry) return fromRegistry;
    return game.board?.getAllUnits().find((u: UnitObject) => u.nid === nid);
  }
  private resolveEndingPortrait(
    portraitArg: string,
  ): { nid: string; resolvedThroughUnit: boolean } | null {
    const game = getGame();
    const runtimeUnit = this.findUnit(portraitArg);
    const unitPrefab = game.db?.units.get(portraitArg);
    const unitPortraitNid = runtimeUnit?.portraitNid || unitPrefab?.portrait_nid;
    if (unitPortraitNid) {
      return { nid: unitPortraitNid, resolvedThroughUnit: true };
    }
    return game.db?.portraits.has(portraitArg)
      ? { nid: portraitArg, resolvedThroughUnit: false }
      : null;
  }

  private createEndingPortrait(
    image: HTMLImageElement,
    nid: string,
    position: [number, number],
    alpha: number,
    flipped: boolean,
    resolvedThroughUnit: boolean,
  ): EndingPortraitPresentation {
    let portraitSurface = new Surface(96, 80);
    portraitSurface.blitImage(image, 0, 0, 96, 80, 0, 0);
    const imageData = portraitSurface.getImageData();
    const pixels = imageData.data;
    const [keyR, keyG, keyB] = COLORKEY;
    for (let i = 0; i < pixels.length; i += 4) {
      if (Math.abs(pixels[i] - keyR) <= 2 &&
          Math.abs(pixels[i + 1] - keyG) <= 2 &&
          Math.abs(pixels[i + 2] - keyB) <= 2) {
        pixels[i + 3] = 0;
      }
    }
    portraitSurface.putImageData(imageData);
    if (flipped) portraitSurface = portraitSurface.flipH();
    portraitSurface.setAlpha(alpha);
    return { surface: portraitSurface, nid, position, alpha, flipped, resolvedThroughUnit };
  }

  /** Resolve an item by NID from a unit inventory or the current party convoy. */
  private findInventoryItem(ownerOrConvoy: string, itemNid: string, recursive: boolean = false): ItemObject | undefined {
    const game = getGame();
    const items: ItemObject[] | undefined = ownerOrConvoy.toLowerCase() === 'convoy'
      ? game.getParty()?.convoy
      : this.findUnit(ownerOrConvoy)?.items;
    if (!recursive) return items?.find((item) => item.nid === itemNid);
    const find = (candidates: ItemObject[]): ItemObject | undefined => {
      for (const item of candidates) {
        if (item.nid === itemNid) return item;
        const nested = find(item.subitems);
        if (nested) return nested;
      }
      return undefined;
    };
    return items ? find(items) : undefined;
  }

  /** Match LT's item/accessory inventory capacity check (skill offsets remain a P3 hook gap). */
  private inventoryFull(unit: UnitObject, item: ItemObject): boolean {
    const game = getGame();
    const accessory = item.hasComponent('accessory');
    const limit = Number(game.db.getConstant(accessory ? 'num_accessories' : 'num_items', accessory ? 0 : 5));
    const count = unit.items.filter((candidate) => candidate.hasComponent('accessory') === accessory).length;
    return count >= limit;
  }

  /**
   * Resolve a position argument that could be either "x,y" coordinates
   * or a unit NID (resolves to the unit's current position).
   */
  private resolvePosition(posOrUnit: string, game: any): [number, number] | null {
    if (!posOrUnit) return null;
    // Try parsing as x,y coordinates first
    const parts = posOrUnit.split(',');
    if (parts.length >= 2) {
      const x = parseInt(parts[0].trim(), 10);
      const y = parseInt(parts[1].trim(), 10);
      if (!isNaN(x) && !isNaN(y)) return [x, y];
    }
    // Try resolving as a unit NID
    const unit = this.findUnit(posOrUnit);
    if (unit?.position) return [unit.position[0], unit.position[1]];
    return null;
  }

  /** Start a path-backed event move, keeping board occupancy at the destination. */
  private beginEventMove(
    unit: UnitObject,
    target: [number, number],
    speedMs: number,
    game: GameState,
    onComplete: () => void,
  ): boolean {
    if (!unit.position || !game.board || !game.pathSystem) return false;
    const path = game.pathSystem.getPath(unit, target[0], target[1], game.board);
    if (!path || path.length <= 1) {
      game.board.moveUnit(unit, target[0], target[1]);
      return false;
    }
    game.board.moveUnit(unit, target[0], target[1]);
    game.movementSystem.beginMove(
      unit,
      path,
      1000 / Math.max(1, speedMs),
      onComplete,
    );
    return true;
  }

  /** Parse LT's comma-delimited key/value number records (for example HP,5,STR,-1). */
  private parseNumberRecord(source: string): Record<string, number> {
    const record: Record<string, number> = {};
    const parts = source.split(',');
    const context = this.buildConditionContext();
    for (let index = 0; index + 1 < parts.length; index += 2) {
      const key = parts[index].trim();
      const rawValue = parts[index + 1].trim();
      if (!key) continue;
      let evaluated: any;
      try {
        evaluated = evaluateExpression(rawValue, context);
      } catch {
        evaluated = rawValue;
      }
      const value = Number(evaluated);
      if (Number.isFinite(value)) record[key] = value;
    }
    return record;
  }

  /** Open an event-owned state directly or after the standard fade-to-black. */
  private openStateWithTransition(
    targetState: string,
    commandArgs: string[],
    game: GameState,
  ): boolean {
    const immediate = commandArgs.some(arg => arg.toLowerCase().trim() === 'immediate');
    if (immediate || this.skipMode) {
      this.advancePointer();
      game.state.change(targetState);
      return true;
    }
    this.stateAfterTransition = targetState;
    this.transitionBlocksCommands = true;
    this.transitionFadingIn = true;
    this.transitionFadingOut = false;
    this.transitionHoldBlack = false;
    this.transitionDurationMs = 133;
    this.transitionAlpha = 0;
    return true;
  }

  private drawEventOverlaySprites(surf: Surface, foreground: boolean): void {
    const overlays = [...this.overlaySprites.values()]
      .filter(overlay => overlay.foreground === foreground && overlay.image)
      .sort((left, right) => left.zLevel - right.zLevel);
    for (const overlay of overlays) {
      const image = overlay.image;
      if (!image) continue;
      surf.blitImage(
        image,
        0,
        0,
        image.width,
        image.height,
        overlay.position[0],
        overlay.position[1],
      );
    }
  }

  /**
   * Build a ConditionContext from the current game state and event trigger.
   */
  private buildConditionContext(): ConditionContext {
    const game = getGame();
    const trigger = this.currentEvent?.trigger;
    return {
      game,
      unit1: trigger?.unit1,
      unit2: trigger?.unit2,
      position: trigger?.position,
      region: trigger?.region,
      item: trigger?.item,
      gameVars: game.gameVars,
      levelVars: game.levelVars,
      localArgs: new Map<string, any>([
        ...(trigger?.localArgs?.entries() ?? []),
        ['stat_changes', trigger?.statChanges],
        ['source', trigger?.source],
        ['weapon_type', trigger?.weaponType],
        ['old_wexp', trigger?.oldWexp],
        ['rank', trigger?.rank],
        ['is_animation_combat', trigger?.isAnimationCombat],
        ['playback', trigger?.playback],
      ]),
    };
  }

  // -----------------------------------------------------------------------
  // if / elif / else / end  flow-control
  // -----------------------------------------------------------------------

  /**
   * Jump forward from a false if/elif to the matching elif/else/end,
   * respecting nested if blocks.
   * Returns the index to jump to (the elif/else/end command itself).
   */
  private jumpToNextBranch(fromIndex: number): number {
    const commands = this.currentEvent!.commands;
    let depth = 0;
    for (let i = fromIndex + 1; i < commands.length; i++) {
      const t = commands[i].type;
      if (t === 'if') {
        depth++;
      } else if (t === 'end') {
        if (depth === 0) return i;
        depth--;
      } else if (depth === 0 && (t === 'elif' || t === 'else')) {
        return i;
      }
    }
    // Couldn't find matching end — jump past end of commands
    return commands.length;
  }

  /**
   * Jump forward from a true elif/else branch that was reached by
   * fall-through to the matching `end`, skipping nested if blocks.
   */
  private jumpToEnd(fromIndex: number): number {
    const commands = this.currentEvent!.commands;
    let depth = 0;
    for (let i = fromIndex + 1; i < commands.length; i++) {
      const t = commands[i].type;
      if (t === 'if') {
        depth++;
      } else if (t === 'end') {
        if (depth === 0) return i;
        depth--;
      }
    }
    return commands.length;
  }

  // -----------------------------------------------------------------------
  // Command execution — returns true if command is blocking
  // -----------------------------------------------------------------------

  private executeCommand(cmd: EventCommand, game: any): boolean {
    const rawArgs = cmd.args ?? [];

    // Substitute template variables in all args:
    // {unit} -> the unit that triggered this event (from trigger.unitNid or unit1.nid)
    // {unit2} -> the secondary unit (from trigger.unit2.nid)
    const trigger = this.currentEvent?.trigger;
    const unitNid = trigger?.unitNid ?? trigger?.unit1?.nid ?? '';
    const unit2Nid = trigger?.unitB ?? trigger?.unit2?.nid ?? '';
    const expressionContext = this.buildConditionContext();
    let args = rawArgs.map((arg) => {
      let value = arg.replace(/\{unit\}/g, unitNid).replace(/\{unit2\}/g, unit2Nid);
      value = value.replace(/\{(?:e|eval):([^{}]+)\}/g, (_match, expression: string) => {
        const result = evaluateExpression(expression, expressionContext);
        return result === undefined || result === null ? '' : String(result);
      });
      value = value.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, key: string) => {
        if (game.levelVars?.has?.(key)) return String(game.levelVars.get(key));
        if (game.gameVars?.has?.(key)) return String(game.gameVars.get(key));
        return match;
      });
      return value;
    });

    switch (cmd.type) {
      // ----- Flow control -----
      case 'if': {
        const condition = args[0] ?? 'True';
        const ctx = this.buildConditionContext();
        if (evaluateCondition(condition, ctx)) {
          // Condition true — advance into the if body
          this._jumpedToBranch = false;
          this.advancePointer();
        } else {
          // Condition false — jump to matching elif/else/end
          const target = this.jumpToNextBranch(this.currentEvent!.commandPointer);
          this.currentEvent!.commandPointer = target;
          this._jumpedToBranch = true;
          // Don't advance — we land ON the elif/else/end and it will be
          // processed next iteration.
        }
        return false;
      }

      case 'elif': {
        // If reached naturally (fall-through from a true if/elif body),
        // the previous branch was true — skip to end.
        // If jumped to from a false branch, the pointer lands here and
        // we evaluate the condition.
        //
        // We distinguish by checking: did we arrive here by advancing
        // (commandPointer was just set to this index by jumpToNextBranch)?
        // We use a simple heuristic: the previous command in the stream
        // will NOT be 'end' if we jumped here from a false branch — it
        // could be anything. But if we fell through, the previous executed
        // command was the last in the true block.
        //
        // Instead, use the fact that jumpToNextBranch lands ON this command
        // without advancing. So if we're processing it, there are two cases:
        // 1. We were jumped here (false branch) — evaluate condition.
        // 2. We fell through (true branch) — skip to end.
        //
        // The way to disambiguate: check if the command immediately before
        // this one is an `end` or some other command. But this is fragile.
        // Instead, use a simpler approach: we check if the condition that
        // brought us here by looking at whether the PREVIOUS if/elif at the
        // same nesting level was true. But tracking that is complex.
        //
        // Simplest correct approach: treat `elif` like Python's `elif`.
        // If we reach it by sequential execution (fall-through from true
        // block), jump to end. We know we fell through if the previous
        // instruction that was executed was NOT a jump (i.e., the pointer
        // was sequentially incremented to reach here).
        //
        // Actually the cleanest way: when a true if/elif body completes
        // and reaches an elif/else by fall-through, we must jump to end.
        // We handle this by checking if the previous command (pointer - 1)
        // is NOT 'if' and NOT 'elif' — if so, we fell through.
        //
        // But the pointer was advanced past all the body commands. The
        // command at pointer-1 is the last body command, not the if/elif.
        //
        // The correct approach used in LT: when an if/elif condition is
        // TRUE, we execute the body. When execution naturally reaches the
        // next elif/else, we know the previous branch succeeded, so we
        // jump to `end`. When an if/elif condition is FALSE, jumpToNextBranch
        // sets the pointer directly to the elif/else without advancing.
        //
        // So we need a flag. Let's track whether we're in a "jump-to" state.
        // Alternatively, check if the command BEFORE this elif was inside
        // the previous branch body (not another if/elif/else).
        //
        // Simplest: use the fact that jumpToNextBranch does NOT call
        // advancePointer, it sets commandPointer directly. So when we land
        // on elif from a false branch, the pointer equals our index.
        // When we fall through, advancePointer was called, so the pointer
        // also equals our index. Both cases look the same!
        //
        // The real disambiguation is: were we jumped to, or did we arrive
        // sequentially? We can't tell from the pointer alone.
        //
        // The LT engine handles this with a skip-to-end flag. Let's do the
        // same: when a true branch body finishes and we encounter elif/else,
        // we jump to end. We'll handle this by checking if the previous
        // command was NOT 'if' / 'elif' with false condition.
        //
        // Actually let me just implement this properly with a simple rule:
        // We need to know if we jumped here. Let's track `_jumpedToBranch`.
        if (this._jumpedToBranch) {
          this._jumpedToBranch = false;
          // We were jumped here from a false branch — evaluate condition
          const condition = args[0] ?? 'True';
          const ctx = this.buildConditionContext();
          if (evaluateCondition(condition, ctx)) {
            // Condition true — enter this elif body
            this.advancePointer();
          } else {
            // Still false — jump to next elif/else/end
            const target = this.jumpToNextBranch(this.currentEvent!.commandPointer);
            this.currentEvent!.commandPointer = target;
            this._jumpedToBranch = true;
          }
        } else {
          // Fell through from a true branch — skip to matching end
          const target = this.jumpToEnd(this.currentEvent!.commandPointer);
          this.currentEvent!.commandPointer = target;
          // Landing on `end`, which will just advance
        }
        return false;
      }

      case 'else': {
        if (this._jumpedToBranch) {
          this._jumpedToBranch = false;
          // Jumped here from a false branch — enter the else body
          this.advancePointer();
        } else {
          // Fell through from a true branch — skip to end
          const target = this.jumpToEnd(this.currentEvent!.commandPointer);
          this.currentEvent!.commandPointer = target;
        }
        return false;
      }

      case 'end': {
        // End of an if block — just advance
        this._jumpedToBranch = false;
        this.advancePointer();
        return false;
      }

      case 'finish': {
        // Immediately end the event
        this.currentEvent!.finish();
        return false;
      }

      case 'comment': {
        this.advancePointer();
        return false;
      }

      case 'end_skip': {
        // Python end_skip clears ordinary event skipping so subsequent
        // blocking commands resume normal presentation.
        this.skipMode = false;
        this.advancePointer();
        return false;
      }

      // ----- Blocking commands -----

      case 's':           // short alias used in support conversations
      case 'say':
      case 'speak':
      case 'narrate': {
        // say;Speaker;Text1,Text2,... (Python :322) = speak with the text
        // list joined by {sub_break}. Preserve recognized trailing flags.
        const dialogFlagNames: Record<string, true> = {
          low_priority: true,
          hold: true,
          no_popup: true,
          fit: true,
          no_block: true,
          no_talk: true,
          no_sound: true,
          autogray: true,
        };
        let flagArgs = args.slice(2)
          .map(s => s.toLowerCase())
          .filter(flag => dialogFlagNames[flag]);
        if (cmd.type === 'say' && args.length > 2) {
          const textParts = args.slice(1)
            .filter(value => !dialogFlagNames[value.toLowerCase()]);
          args = [args[0] ?? '', textParts.join('{sub_break}'), ...flagArgs];
        }
        // In skip mode, auto-advance past all dialogue without showing it
        if (this.skipMode) {
          this.advancePointer();
          return false;
        }
        const speaker = args[0] ?? '';
        const text = args[1] ?? '';

        // Stop previous speaking portrait
        if (this.speakingPortrait) {
          this.speakingPortrait.stopTalking();
          this.speakingPortrait = null;
        }

        // Look up portrait for the speaker
        const portrait = this.portraits.get(speaker) ?? null;

        // Check flags (flags are extra args like 'no_talk', 'low_priority', 'hold')
        flagArgs = args.slice(2)
          .map(s => s.toLowerCase())
          .filter(flag => dialogFlagNames[flag]);
        const noTalk = flagArgs.includes('no_talk');
        const noBlock = flagArgs.includes('no_block');

        if (portrait && !noTalk && cmd.type !== 'narrate') {
          this.speakingPortrait = portrait;

          // Raise portrait priority (bring to front) unless low_priority
          if (!flagArgs.includes('low_priority')) {
            portrait.priority = this.portraitPriorityCounter++;
          }
        }

        const dialogSpeedMult = this.getDialogSpeedMultiplier(args.slice(2));

        // Create dialog with optional portrait reference for positioning
        this.dialog = new Dialog(
          text,
          speaker || undefined,
          portrait ?? undefined,
          this.getDialogTextSpeedMs(),
          dialogSpeedMult,
          noBlock,
        );
        this.dialogBlocksCommands = !noBlock;
        this.wasDialogTyping = false;

        if (noBlock) {
          this.advancePointer();
          return false;
        }
        // Blocking dialogs advance when dismissed.
        return true;
      }

      case 'wait': {
        if (this.skipMode) {
          this.advancePointer();
          return false;
        }
        this.waiting = true;
        this.waitTimer = parseInt(args[0], 10) || 1000;
        return true;
      }

      case 'transition': {
        // transition;open[;duration[;r,g,b]] — fade FROM color (reveal)
        // transition;close[;duration[;r,g,b]] — fade TO color (hide)
        // transition (no args) — same as close
        // Parse optional duration (ms) and color
        const durationArg = parseInt(args[1], 10);
        if (!isNaN(durationArg) && durationArg > 0) {
          this.transitionDurationMs = durationArg;
        } else {
          this.transitionDurationMs = 133; // default (Python: transitions.py:14)
        }
        // Parse optional color (r,g,b)
        if (args[2]) {
          const colorParts = args[2].split(',');
          if (colorParts.length >= 3) {
            this.transitionColor = `${colorParts[0].trim()},${colorParts[1].trim()},${colorParts[2].trim()}`;
          }
        } else {
          this.transitionColor = '0,0,0'; // default black
        }

        if (this.skipMode) {
          // In skip mode, apply transitions instantly
          const dir = (args[0] ?? 'close').toLowerCase();
          this.transitionAlpha = dir === 'open' ? 0 : 1;
          this.transitionFadingIn = false;
          this.transitionFadingOut = false;
          this.transitionHoldBlack = dir !== 'open';
          this.advancePointer();
          return false;
        }
        const direction = (args[0] ?? 'close').toLowerCase();
        this.transitionBlocksCommands = !args.some(arg => arg.toLowerCase() === 'no_block');
        if (direction === 'open') {
          this.transitionFadingIn = false;
          this.transitionFadingOut = true;
          this.transitionAlpha = 1;
        } else {
          // 'close' — fade to black
          this.transitionFadingIn = true;
          this.transitionFadingOut = false;
          this.transitionAlpha = 0;
        }
        if (!this.transitionBlocksCommands) {
          this.advancePointer();
        }
        return this.transitionBlocksCommands;
      }

      case 'alert': {
        if (this.skipMode) {
          this.advancePointer();
          return false;
        }
        const text = args[0] ?? '';
        this.banner = new Banner(text, undefined, 3000);
        this.bannerIsAlert = true;
        // Don't advance — advanced when banner finishes (in update) or early dismissed via input
        return true;
      }

      // ----- Unit commands (instant) -----

      case 'move_unit': {
        const unitNid = args[0] ?? '';
        const unit = this.findUnit(unitNid);
        let targetPos: [number, number] | null = null;
        const posStr = args[1] ?? '';
        if (posStr) {
          const posParts = posStr.split(',').map((part: string) => parseInt(part.trim(), 10));
          if (posParts.length >= 2 && !isNaN(posParts[0]) && !isNaN(posParts[1])) {
            targetPos = [posParts[0], posParts[1]];
          }
        }
        if (!targetPos && unit?.startingPosition) {
          targetPos = [unit.startingPosition[0], unit.startingPosition[1]];
        }
        if (!unit || !unit.position || !targetPos || !game.board) {
          this.advancePointer();
          return false;
        }

        const movementType = (args[2] || 'normal').toLowerCase();
        const noBlock = args.some(arg => arg.toLowerCase().trim() === 'no_block');
        const noFollow = args.some(arg => arg.toLowerCase().trim() === 'no_follow');
        const parsedSpeed = parseInt(args[4] ?? '', 10);
        const speedMs = Number.isFinite(parsedSpeed) && parsedSpeed > 0 ? parsedSpeed : 120;
        if (!noFollow) game.camera?.focusTile(targetPos[0], targetPos[1]);
        if (this.skipMode || movementType === 'immediate') {
          game.board.moveUnit(unit, targetPos[0], targetPos[1]);
          this.advancePointer();
          return false;
        }
        if (movementType !== 'normal') {
          game.board.moveUnit(unit, targetPos[0], targetPos[1]);
          if (noBlock) {
            this.advancePointer();
            return false;
          }
          this.waiting = true;
          this.waitTimer = 333;
          return true;
        }

        const blocks = !noBlock;
        if (blocks) this.blockingEventMovements = 1;
        const started = this.beginEventMove(unit, targetPos, speedMs, game, () => {
          if (blocks) {
            this.blockingEventMovements = 0;
            this.advancePointer();
          }
        });
        if (!started) {
          this.blockingEventMovements = 0;
          this.advancePointer();
          return false;
        }
        if (noBlock) {
          this.advancePointer();
          return false;
        }
        return true;
      }

      case 'add_unit': {
        const unitNid = args[0] ?? '';
        const posArg = args[1] ?? 'starting';
        const placement = (args[3] || 'giveup').toLowerCase().trim();
        const existing = game.units.get(unitNid);
        if (existing?.position || existing?.isDead()) {
          this.advancePointer();
          return false;
        }

        let requestedPosition: [number, number] | null = null;
        if (posArg !== 'starting' && posArg !== '' && posArg !== 'immediate') {
          const parts = posArg.split(',').map((part: string) => parseInt(part.trim(), 10));
          if (parts.length >= 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
            requestedPosition = [parts[0], parts[1]];
          }
        }

        if (existing) {
          requestedPosition ??= existing.startingPosition
            ? [existing.startingPosition[0], existing.startingPosition[1]]
            : null;
          const finalPosition = requestedPosition
            ? this._checkPlacement(requestedPosition, placement, game)
            : null;
          if (finalPosition && game.board) {
            game.actionLog.doAction(new ArriveOnMapAction(game, existing, finalPosition, true));
          } else {
            console.warn(`EventState add_unit: no valid position for "${unitNid}"`);
          }
          this.advancePointer();
          return false;
        }

        const levelUnits = game.currentLevel?.units ?? [];
        const unitData = levelUnits.find(
          (candidate: UniqueUnitData | GenericUnitData) => candidate.nid === unitNid,
        );
        if (!unitData) {
          console.warn(`EventState add_unit: unit "${unitNid}" not found in level data`);
          this.advancePointer();
          return false;
        }
        this.spawnUnitFromLevelData(unitData, requestedPosition, game);
        this.advancePointer();
        return false;
      }

      case 'create_unit': {
        // create_unit;Unit;Nid;Level;Position;EntryType;Placement;[copy_stats]
        // Creates a new unit instance from a template (either an already-
        // spawned unit or a UnitPrefab in the database) and optionally
        // places it on the map. Mirrors event_functions.create_unit().
        const templateNid = args[0] ?? '';
        const explicitNid = (args[1] ?? '').trim();
        const levelStr = (args[2] ?? '').trim();
        const posArg = (args[3] ?? '').trim();
        const entryType = (args[4] || 'fade').trim();
        const placement = (args[5] || 'giveup').trim().toLowerCase();
        const flagArgs = args.slice(6).map((s) => s.toLowerCase());
        const copyStats = flagArgs.includes('copy_stats');

        const templateUnit = this.findUnit(templateNid);
        const templatePrefab = templateUnit ? undefined : game.db?.units?.get(templateNid);
        if (!templateUnit && !templatePrefab) {
          console.warn(`create_unit: couldn't find unit template "${templateNid}"`);
          this.advancePointer();
          return false;
        }

        // Resolve/assign the new unit's nid
        let newNid = explicitNid;
        if (!newNid) {
          let counter = 201;
          while (game.units.has(String(counter))) counter++;
          newNid = String(counter);
        } else if (game.units.has(newNid)) {
          console.warn(`create_unit: unit with nid "${newNid}" already exists`);
          this.advancePointer();
          return false;
        }

        const baseKlass = templateUnit ? templateUnit.klass : templatePrefab.klass;
        const firstFaction = (Array.from(game.db?.factions?.values?.() ?? [])[0] as any)?.nid ?? '';
        const baseFaction = (templateUnit ? templateUnit.faction : templatePrefab.faction) || firstFaction;
        const baseTeam = templateUnit ? templateUnit.team : (templatePrefab.team ?? 'player');
        const baseAi = templateUnit ? templateUnit.ai : (templatePrefab.ai ?? 'None');
        const baseVariant = templateUnit ? templateUnit.variant : (templatePrefab.variant ?? null);
        const parsedLevel = levelStr ? parseInt(levelStr, 10) : NaN;
        const baseLevel = !isNaN(parsedLevel) ? parsedLevel : (templateUnit ? templateUnit.level : templatePrefab.level);
        const baseItems: [string, boolean][] = templateUnit
          ? templateUnit.items.map((it: ItemObject) => [it.nid, !!it.droppable] as [string, boolean])
          : (templatePrefab.starting_items ?? []);
        const learnedSkills = templateUnit ? [] : (templatePrefab.learned_skills ?? []);

        const baseKlassDef = game.db?.classes?.get(baseKlass);
        if (!baseKlassDef) {
          console.warn(`create_unit: unknown class "${baseKlass}" for template "${templateNid}"`);
          this.advancePointer();
          return false;
        }

        // Like make_generic, a create_unit instance is built as a fresh
        // generic unit whose stats/growths/wexp come from the class
        // (Python: GenericUnit(...) -> UnitObject.from_prefab). copy_stats
        // then overwrites .stats with the template's own stats afterward.
        const syntheticPrefab: any = {
          nid: newNid,
          name: baseVariant || newNid,
          desc: '',
          variant: baseVariant,
          level: baseLevel,
          klass: baseKlass,
          tags: [],
          bases: { ...baseKlassDef.bases },
          growths: { ...baseKlassDef.growths },
          stat_cap_modifiers: {},
          faction: baseFaction,
          starting_items: baseItems,
          learned_skills: learnedSkills,
          wexp_gain: baseKlassDef.wexp_gain,
          portrait_nid: '',
          affinity: '',
        };

        const newUnit = game.buildUnit(syntheticPrefab, baseTeam, baseAi);
        newUnit.generic = true;
        newUnit.faction = baseFaction || null;
        if (copyStats && templateUnit) {
          newUnit.stats = { ...templateUnit.stats };
        }
        if (game.currentParty) {
          newUnit.party = game.currentParty;
        }

        // Resolve target position (if any), applying placement rules
        let targetPos: [number, number] | null = null;
        if (posArg) {
          const parts = posArg.split(',').map((s: string) => parseInt(s.trim(), 10));
          if (parts.length >= 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
            targetPos = this._checkPlacement([parts[0], parts[1]], placement, game);
          }
        }
        void entryType; // Placement animation type is cosmetic-only in this port.

        game.actionLog.doAction(new CreateUnitAction(game, newUnit, targetPos));

        // Mirror Python's {created_unit} substitution when Nid was left blank:
        // subsequent {e:created_unit} lookups in this event resolve to the
        // new unit's nid via the trigger's localArgs (see resolvePath()).
        if (!explicitNid && this.currentEvent) {
          if (!this.currentEvent.trigger.localArgs) {
            this.currentEvent.trigger.localArgs = new Map<string, any>();
          }
          this.currentEvent.trigger.localArgs.set('created_unit', newUnit.nid);
        }

        this.advancePointer();
        return false;
      }

      case 'ending':
      case 'paired_ending': {
        // ending;Portrait;Title;Text / paired_ending;L;R;LT;RT;Text
        if (this.skipMode) { this.advancePointer(); return false; }
        const isPaired = cmd.type === 'paired_ending';
        const requiredArgs = isPaired ? 5 : 3;
        const waitForInput = args.slice(requiredArgs)
          .some((flag) => flag.toLowerCase() === 'wait_for_input');
        const portraitArgs = isPaired
          ? [args[0] ?? '', args[1] ?? '']
          : [args[0] ?? ''];
        const resolved = portraitArgs.map((portraitArg) =>
          this.resolveEndingPortrait(portraitArg));
        const invalidIndex = resolved.findIndex((portrait) => portrait === null);
        if (invalidIndex >= 0) {
          console.warn(`${cmd.type}: couldn't find unit or portrait "${portraitArgs[invalidIndex]}"`);
          this.advancePointer();
          return false;
        }

        this.pendingPortraitLoads++;
        Promise.all(resolved.map((portrait) => game.resources.loadPortrait(portrait!.nid)))
          .then((images: HTMLImageElement[]) => {
            const dialog = new Dialog(
              isPaired ? (args[4] ?? '') : (args[2] ?? ''),
              '',
              undefined,
              this.getDialogTextSpeedMs(),
            );
            const portraits = images.map((image, index) => {
              const portrait = resolved[index]!;
              const position: [number, number] = isPaired
                ? (index === 0 ? [8, 49] : [136, 49])
                : [136, 57];
              const flipped = isPaired && index === 0 && portrait.resolvedThroughUnit;
              return this.createEndingPortrait(
                image,
                portrait.nid,
                position,
                isPaired ? 0.5 : 0.8,
                flipped,
                portrait.resolvedThroughUnit,
              );
            });
            this.endingCard = {
              leftTitle: isPaired ? (args[2] ?? '') : (args[1] ?? ''),
              rightTitle: isPaired ? (args[3] ?? '') : null,
              dialog,
              portraits,
              waitForInput,
              waitTimerMs: 0,
            };
            this.dialogBlocksCommands = true;
            this.dialog = dialog;
            this.wasDialogTyping = false;
          })
          .catch(() => {
            console.warn(`${cmd.type}: failed to load portrait image`);
            this.advancePointer();
          })
          .finally(() => {
            this.pendingPortraitLoads--;
          });
        // The load blocks on this pointer. Success installs the dialog; failure
        // advances here exactly once so a missing image cannot deadlock.
        return true;
      }

      case 'speak_style': {
        // speak_style;Nid;props... (Python speak style registry). The web
        // stores styles for future speak consumption; only text_speed and
        // speaker defaults are consumed today (documented deviation).
        const styleNid = args[0] ?? '';
        if (styleNid) {
          if (!game.speakStyles) game.speakStyles = new Map();
          game.speakStyles.set(styleNid, args.slice(1));
        }
        this.advancePointer();
        return false;
      }

      case 'pop_dialog': {
        // pop_dialog (Python :405-ish): removes the current text box.
        this.dialog = null;
        this.endingCard = null;
        this.advancePointer();
        return false;
      }

      case 'unhold':
      case 'unpause': {
        // unhold;Nid / unpause;[Nid] (Python :411/:416): the web keeps one
        // active dialog, so both resume it if waiting (multi-box holds are a
        // documented deviation).
        if (this.dialog && (this.dialog as any).state === 'waiting') {
          (this.dialog as any).handleInput?.('SELECT');
        }
        this.advancePointer();
        return false;
      }

      case 'main_menu': {
        // main_menu (Python :745): flags the chapter-end flow to return to
        // the main menu.
        game.actionLog.doAction(new SetLevelVarAction(game.levelVars, '_main_menu', true));
        this.advancePointer();
        return false;
      }

      case 'change_special_music': {
        // change_special_music;Type;Music (Python :106): title_screen music
        // persists in records; others are game vars.
        const kind = args[0] ?? '';
        const music = args[1] ?? '';
        if (kind === 'title_screen') {
          try { localStorage.setItem('_music_title_screen', music); } catch { /* private mode */ }
        } else if (kind) {
          game.actionLog.doAction(new SetGameVarAction(game.gameVars, `_music_${kind}`, music));
        }
        this.advancePointer();
        return false;
      }

      case 'change_roam_ai': {
        // change_roam_ai;Unit;AI (Python event_functions.py:2180): validated
        // against db.ai, reversible.
        const unit = game.units.get(args[0] ?? '');
        const aiNid = args[1] ?? '';
        if (!unit) console.warn(`change_roam_ai: couldn't find unit ${args[0]}`);
        else if (!game.db.ai?.has?.(aiNid)) console.warn(`change_roam_ai: couldn't find AI ${aiNid}`);
        else game.actionLog.doAction(new ChangeRoamAiAction(unit, aiNid));
        this.advancePointer();
        return false;
      }

      case 'open_unit_management': {
        // open_unit_management;Panorama — pause into the base manage flow.
        if (args[0]) game.memory.set('base_bg', args[0]);
        return this.openStateWithTransition('base_manage', args, game);
      }

      case 'party_transfer': {
        const [p1, p2] = [args[0] ?? '', args[1] ?? ''];
        if (!game.parties.has(p1) || !game.parties.has(p2)) {
          console.warn(`party_transfer: unknown party ${!game.parties.has(p1) ? p1 : p2}`);
          this.advancePointer();
          return false;
        }
        const fixed = (args[2] ?? '').split(',').map((s: string) => s.trim()).filter(Boolean);
        game.memory.set('party_transfer', [
          p1, p2, fixed, args[3] ?? '', args[4] ?? '',
          parseInt(args[5] ?? '0', 10) || 0, parseInt(args[6] ?? '0', 10) || 0,
        ]);
        this.advancePointer();
        game.state.change('party_transfer');
        return true;
      }

      case 'open_bexp_menu': {
        if (args[0]) game.memory.set('base_bg', args[0]);
        if (args[1]) {
          game.actionLog.doAction(
            new SetGameVarAction(game.gameVars, '_bexp_menu_music', args[1]),
          );
        }
        return this.openStateWithTransition('base_bexp_select', args, game);
      }

      case 'pose_unit': {
        const unit = game.units.get(args[0] ?? '');
        const pose = (args[1] ?? '').toLowerCase();
        const dir = (args[2] ?? '').toLowerCase();
        const validPoses = ['normal', 'active', 'moving', 'stand_dir', 'start_cast', 'end_cast'];
        const validDirs = ['up', 'down', 'left', 'right'];
        if (!unit) {
          console.warn(`pose_unit: couldn't find ${args[0]}`);
        } else if (!validPoses.includes(pose)) {
          console.warn(`pose_unit: ${pose} is not a valid sprite pose`);
        } else if (pose === 'start_cast' || pose === 'end_cast') {
          console.warn(`pose_unit: ${pose} not supported by web map sprites (deferred)`);
        } else if ((pose === 'moving' || pose === 'stand_dir') && !validDirs.includes(dir)) {
          console.warn(`pose_unit: ${dir} is not a valid direction`);
        } else if (pose === 'normal') {
          unit.poseOverride = null;
        } else if (pose === 'active') {
          unit.poseOverride = { state: 'standing' };
        } else {
          unit.poseOverride = { state: 'moving', direction: dir as any };
        }
        this.advancePointer();
        return false;
      }

      case 'set_custom_options': {
        // set_custom_options;Options;Enabled;Descs;Events (Python :3005) —
        // four reversible game-var writes consumed by the options menu.
        const parseList = (s: string | undefined) =>
          (s ?? '').split(',').map((x: string) => x.trim()).filter(Boolean);
        const optionsList = parseList(args[0]);
        const enabledList = parseList(args[1]).map((v: string) => v.toLowerCase() !== 'false');
        const descList = parseList(args[2]);
        const eventsListRaw = parseList(args[3]);
        if (enabledList.length > optionsList.length || descList.length > optionsList.length
          || eventsListRaw.length > optionsList.length) {
          console.warn('set_custom_options: list longer than options list');
          this.advancePointer();
          return false;
        }
        while (enabledList.length < optionsList.length) enabledList.push(true);
        const descs = optionsList.map((o: string, i: number) => descList[i] ?? `${o}_desc`);
        const eventsList: (string | null)[] = optionsList.map((_o: string, i: number) => eventsListRaw[i] ?? null);
        game.actionLog.doAction(new SetGameVarAction(game.gameVars, '_custom_options_disabled', enabledList.map((b: boolean) => !b)));
        game.actionLog.doAction(new SetGameVarAction(game.gameVars, '_custom_info_desc', descs));
        game.actionLog.doAction(new SetGameVarAction(game.gameVars, '_custom_options_events', eventsList));
        game.actionLog.doAction(new SetGameVarAction(game.gameVars, '_custom_additional_options', optionsList));
        this.advancePointer();
        return false;
      }

      case 'change_team_palette': {
        // change_team_palette;Team;MapSpritePalette;CombatVariantPalette;CombatColor
        // (Python :3985). Combat-variant battle-anim palettes are a documented
        // deferral; map-sprite palette + combat color apply reversibly.
        const teamNid = args[0] ?? '';
        const isTeam = game.db.teams.defs.some((t: any) => t.nid === teamNid);
        if (!isTeam) {
          console.warn(`change_team_palette: ${teamNid} is not a valid team nid`);
        } else {
          const next: { palette?: string; combatColor?: string } = {};
          if (args[1]) next.palette = args[1];
          if (args[3]) next.combatColor = args[3];
          if (args[2]) console.warn('change_team_palette: combat variant palettes not yet supported (deferred)');
          game.actionLog.doAction(new ChangeTeamPaletteAction(game, teamNid, next));
        }
        this.advancePointer();
        return false;
      }

      case 'change_bg_tilemap': {
        // change_bg_tilemap;[Tilemap] (Python event_functions.py:884 /
        // action.ChangeBGTileMap). No arg clears. Blocks until the tilemap's
        // tilesets finish loading (like change_background's sync semantics).
        const bgNid = (args[0] ?? '').trim();
        this.advancePointer();
        if (!bgNid) {
          game.actionLog.doAction(new ChangeBgTilemapAction(game, null));
          return false;
        }
        // Python applies synchronously from preloaded prefabs; the web loads
        // tileset images async and applies on completion (timing-only
        // deviation — the event does not block on the load).
        void game.buildTilemapObject(bgNid).then((tm: any) => {
          if (tm) game.actionLog.doAction(new ChangeBgTilemapAction(game, tm));
          else console.warn(`change_bg_tilemap: tilemap "${bgNid}" not found`);
        }).catch((err: any) => console.warn('change_bg_tilemap failed:', err));
        return false;
      }

      case 'text_entry': {
        // text_entry;Nid;String;CharLimit;IllegalChars;Default;MinChars;flags
        // (Python event_functions.py:3276). Pauses into the text_entry state;
        // the confirmed value lands as a game var via SetGameVarAction.
        const illegal = (args[3] ?? '').split(',').map((s: string) => s.trim()).filter(Boolean);
        game.memory.set('text_entry', [
          args[0] ?? '', args[1] ?? '', parseInt(args[2] ?? '16', 10) || 16,
          illegal, args.includes('force_entry'), args[4] || null,
          parseInt(args[5] ?? '0', 10) || 0,
        ]);
        this.advancePointer();
        game.state.change('text_entry');
        return true;
      }

      case 'enable_repair_shop': {
        // enable_repair_shop;bool (Python :694) — plain game-var toggle
        game.actionLog.doAction(new SetGameVarAction(game.gameVars, '_repair_shop', (args[0] ?? '').toLowerCase() === 'true'));
        this.advancePointer();
        return false;
      }

      case 'force_chapter_clean_up': {
        // force_chapter_clean_up (Python :748): game.clean_up(full=False) —
        // per-unit cleanup (heal, off-map, reset turn/rescue state) WITHOUT
        // the registry hand-off cleanUpLevel() does for level transitions
        // (Python keeps units registered here).
        for (const unit of game.units.values()) {
          if (unit.position && game.board) game.board.removeUnit(unit);
          if (unit.rescuing) { unit.rescuing.rescuedBy = null; unit.rescuing = null; }
          if (unit.rescuedBy) { unit.rescuedBy.rescuing = null; unit.rescuedBy = null; }
          unit.traveler = null;
          unit.currentHp = unit.stats['HP'] ?? unit.currentHp;
          unit.position = null;
          unit.resetTurnState();
          unit.finished = false;
          unit.hasAttacked = false;
        }
        this.advancePointer();
        return false;
      }

      case 'arrange_formation': {
        // arrange_formation (Python :2888): auto-places off-formation player
        // units onto open formation spots (Required first; Blacklist tag and
        // travelers excluded; fatigue gate applies when enabled).
        const formationSpots: [number, number][] = (game.currentLevel?.regions ?? [])
          .filter((r: any) => r.region_type === 'formation')
          .flatMap((r: any) => {
            const [rx, ry] = r.position;
            const [rw, rh] = r.size ?? [1, 1];
            const spots: [number, number][] = [];
            for (let y = ry; y < ry + rh; y++) for (let x = rx; x < rx + rw; x++) spots.push([x, y]);
            return spots;
          });
        const openSpots = formationSpots.filter(([x, y]) => !game.board?.getUnit(x, y));
        const onFormation = (pos: [number, number] | null) =>
          !!pos && formationSpots.some(([x, y]) => x === pos[0] && y === pos[1]);
        const partyNid = game.currentParty;
        let candidates = [...game.units.values()].filter((u: any) =>
          u.team === 'player' && (!partyNid || u.party === partyNid) &&
          !u.dead && !u.position && !u.tags?.includes('Blacklist') &&
          ![...game.units.values()].some((o: any) => o.traveler === u.nid),
        );
        const fatigueOn = game.db.getConstant('fatigue', false) && game.gameVars.get('_fatigue') === 1;
        if (fatigueOn) candidates = candidates.filter((u: any) => (u.currentFatigue ?? 0) < (u.getStatValue?.('HP') ?? 99));
        candidates.sort((a: any, b: any) => (b.tags?.includes('Required') ? 1 : 0) - (a.tags?.includes('Required') ? 1 : 0));
        const numSlots = game.levelVars.get('_prep_slots') ?? openSpots.length;
        candidates.slice(0, numSlots).forEach((unit: UnitObject, idx: number) => {
          const spot = openSpots[idx];
          if (spot) {
            game.actionLog.doAction(new ArriveOnMapAction(game, unit, spot));
            game.actionLog.doAction(new ResetAllAction([unit]));
          }
        });
        this.advancePointer();
        return false;
      }

      case 'add_unit_map_anim': {
        // add_unit_map_anim;MapAnim;Unit;Speed;flags (Python :2830).
        // 'permanent' loops and attaches reversibly; otherwise plays once at
        // the unit's tile. 'blend' compositing is not supported (deviation).
        const animNid = args[0] ?? '';
        const unit = game.units.get(args[1] ?? '');
        const speed = parseFloat(args[2] ?? '1') || 1;
        const permanent = args.includes('permanent');
        const prefab = game.db?.mapAnimations?.get(animNid);
        if (!prefab || !unit?.position) {
          console.warn(`add_unit_map_anim: invalid anim/unit (${args.join(';')})`);
          this.advancePointer();
          return false;
        }
        const anim = new MapAnimation(prefab, unit.position[0], unit.position[1], {
          loop: permanent, speedAdj: speed,
        });
        anim.followUnit = unit;
        void game.resources.loadImage(`resources/animations/${animNid}.png`)
          .then((img: HTMLImageElement) => { if (img) anim.setImage(img); })
          .catch(() => console.warn(`add_unit_map_anim: no sprite sheet for "${animNid}"`));
        if (permanent) {
          game.actionLog.doAction(new AddAnimToUnitAction(game, anim));
        } else if (game.tilemap) {
          game.tilemap.animations.push(anim);
        }
        const noBlock = args.some(arg => arg.toLowerCase().trim() === 'no_block');
        if (!permanent && !noBlock && !this.skipMode) {
          this.waiting = true;
          this.waitTimer = Math.max(FRAMETIME, anim.getDuration());
          return true;
        }
        this.advancePointer();
        return false;
      }

      case 'remove_unit_map_anim': {
        // remove_unit_map_anim;MapAnim;Unit (Python :2857), reversible.
        const unit = game.units.get(args[1] ?? '');
        if (!unit) console.warn(`remove_unit_map_anim: couldn't find unit ${args[1]}`);
        else game.actionLog.doAction(new RemoveAnimFromUnitAction(game, args[0] ?? '', unit));
        this.advancePointer();
        return false;
      }

      case 'add_fatigue': {
        // add_fatigue;Unit;Fatigue (Python event_functions.py:1305)
        const unit = game.units.get(args[0] ?? '');
        const amount = parseInt(args[1] ?? '0', 10) || 0;
        if (!unit) console.warn(`add_fatigue: couldn't find unit ${args[0]}`);
        else game.actionLog.doAction(new ChangeFatigueAction(unit, amount));
        this.advancePointer();
        return false;
      }

      case 'remove_generics_from_region': {
        // remove_generics_from_region;Nid (Python :2735): LeaveMap for every
        // generic inside the region's rectangle.
        const region = (game.currentLevel?.regions ?? []).find((r: any) => r.nid === (args[0] ?? ''));
        if (!region) {
          console.warn(`remove_generics_from_region: couldn't find region ${args[0]}`);
        } else {
          const [rx, ry] = region.position;
          const [rw, rh] = region.size ?? [1, 1];
          for (let y = ry; y < ry + rh; y++) {
            for (let x = rx; x < rx + rw; x++) {
              const unit = game.board?.getUnit(x, y);
              if (unit?.generic) game.actionLog.doAction(new LeaveMapAction(game, unit));
            }
          }
        }
        this.advancePointer();
        return false;
      }

      case 'recruit_generic': {
        // recruit_generic;Unit;Nid;Name (Python event_functions.py:1255):
        // converts a generic to a persistent named unit with a new nid.
        const unit = game.units.get(args[0] ?? '');
        const newNid = args[1] ?? '';
        if (!unit || !newNid) {
          console.warn(`recruit_generic: invalid unit/nid (${args.join(';')})`);
        } else if (game.units.has(newNid)) {
          console.warn(`recruit_generic: nid ${newNid} already exists`);
        } else {
          game.actionLog.doAction(new RecruitGenericAction(game, unit, newNid, args[2] ?? null));
        }
        this.advancePointer();
        return false;
      }

      case 'merge_parties': {
        // merge_parties;Party1;Party2 (Python :2864): guest merges into host.
        const [host, guest] = [args[0] ?? '', args[1] ?? ''];
        if (!game.parties.has(host) || !game.parties.has(guest)) {
          console.warn(`merge_parties: could not locate party ${!game.parties.has(host) ? host : guest}`);
        } else {
          game.actionLog.doAction(new MergePartiesAction(game, host, guest));
        }
        this.advancePointer();
        return false;
      }

      case 'loop_units': {
        // loop_units;Expression;Event (Python :3755): runs Event once per unit
        // nid, in order, before this event resumes. Web deviation: the
        // expression supports a comma-separated nid list or an expression
        // evaluating to an array/comma-list via evaluateExpression, not
        // arbitrary Python comprehensions.
        const rawExpr = args[0] ?? '';
        const eventName = args[1] ?? '';
        let list: any = evaluateExpression(rawExpr, this.buildConditionContext());
        // Fall back to treating the raw text as a comma-separated nid list when
        // the expression evaluator can't produce a string/array from it.
        if (list == null || (typeof list !== 'string' && !Array.isArray(list))) list = rawExpr;
        if (typeof list === 'string') list = list.split(',').map((s: string) => s.trim()).filter(Boolean);
        if (!Array.isArray(list) || list.length === 0) {
          console.warn(`loop_units: no units for expression "${rawExpr}"`);
          this.advancePointer();
          return false;
        }
        this.advancePointer();
        let queuedAny = false;
        for (const entry of list) {
          const nid = typeof entry === 'string' ? entry : entry?.nid;
          const unit = game.units.get(nid);
          const trig: any = { type: eventName };
          if (unit) trig.unit1 = unit;
          if (game.eventManager.triggerSpecific(eventName, trig, true)) queuedAny = true;
        }
        if (!queuedAny) {
          console.warn(`loop_units: event "${eventName}" not found`);
          return false;
        }
        game.state.change('event');
        return true;
      }

      case 'add_item_component':
      case 'modify_item_component':
      case 'remove_item_component': {
        // Python event_functions.py:1891/:1907/:1921; reversible component
        // mutation on a runtime item (unit inventory or convoy; recursive flag
        // searches subitems like other item commands).
        const item = this.findInventoryItem(args[0] ?? '', args[1] ?? '', args.includes('recursive'));
        const compNid = args[2] ?? '';
        if (!item || !compNid) {
          console.warn(`${cmd.type}: invalid owner/item/component (${args.join(';')})`);
          this.advancePointer();
          return false;
        }
        if (cmd.type === 'add_item_component') {
          const value = args[3] !== undefined
            ? evaluateExpression(args[3], this.buildConditionContext()) : null;
          game.actionLog.doAction(new AddObjComponentAction(item, compNid, value));
        } else if (cmd.type === 'modify_item_component') {
          if (!item.components.has(compNid)) {
            console.warn(`modify_item_component: item lacks component ${compNid}`);
          } else {
            const value = evaluateExpression(args[3] ?? '', this.buildConditionContext());
            const property = args[4] && !['additive', 'recursive'].includes(args[4]) ? args[4] : null;
            game.actionLog.doAction(new ModifyObjComponentAction(
              item, compNid, value, property, args.includes('additive'),
            ));
          }
        } else {
          game.actionLog.doAction(new RemoveObjComponentAction(item, compNid));
        }
        this.advancePointer();
        return false;
      }

      case 'add_skill_component':
      case 'modify_skill_component':
      case 'remove_skill_component': {
        // Python event_functions.py:1933+/:1955+; 'stack' applies to every
        // same-nid skill instance on the unit.
        const unit = game.units.get(args[0] ?? '');
        const skillNid = args[1] ?? '';
        const compNid = args[2] ?? '';
        const stacked = args.includes('stack');
        const skills = (unit?.skills ?? []).filter((s: any) => s.nid === skillNid);
        const targets = stacked ? skills : skills.slice(0, 1);
        if (!unit || targets.length === 0 || !compNid) {
          console.warn(`${cmd.type}: invalid unit/skill/component (${args.join(';')})`);
          this.advancePointer();
          return false;
        }
        for (const skill of targets) {
          if (cmd.type === 'add_skill_component') {
            const value = args[3] !== undefined
              ? evaluateExpression(args[3], this.buildConditionContext()) : null;
            game.actionLog.doAction(new AddObjComponentAction(skill, compNid, value));
          } else if (cmd.type === 'modify_skill_component') {
            if (!skill.components.has(compNid)) {
              console.warn(`modify_skill_component: skill lacks component ${compNid}`);
              continue;
            }
            const value = evaluateExpression(args[3] ?? '', this.buildConditionContext());
            const property = args[4] && !['additive', 'stack'].includes(args[4]) ? args[4] : null;
            game.actionLog.doAction(new ModifyObjComponentAction(
              skill, compNid, value, property, args.includes('additive'),
            ));
          } else {
            game.actionLog.doAction(new RemoveObjComponentAction(skill, compNid));
          }
        }
        this.advancePointer();
        return false;
      }

      case 'change_roaming': {
        // change_roaming;bool (Python event_functions.py:3774): toggles free
        // roam and resets the turnwheel's first free action like Python.
        const enabled = (args[0] ?? '').toLowerCase() === 'true';
        game.actionLog.setFirstFreeAction();
        game.roamInfo.roam = enabled;
        this.advancePointer();
        return false;
      }

      case 'change_roaming_unit': {
        // change_roaming_unit;unit (Python :3778): missing unit clears roam unit
        const unit = game.units.get(args[0] ?? '');
        game.roamInfo.roamUnitNid = unit ? unit.nid : null;
        this.advancePointer();
        return false;
      }

      case 'clean_up_roaming': {
        // clean_up_roaming (Python :3785): removes every on-map unit except the
        // roam unit (Python FadeOut -> off-map; explicitly not turnwheel-safe).
        const roamNid = game.roamInfo?.roamUnitNid;
        for (const unit of game.units.values()) {
          if (unit.position && unit.nid !== roamNid) {
            game.actionLog.doAction(new LeaveMapAction(game, unit));
          }
        }
        if (game.db.getConstant('initiative', false) && game.initiative) {
          game.initiative.clear?.();
          if (roamNid) game.initiative.insertUnit?.(roamNid);
        }
        this.advancePointer();
        return false;
      }

      case 'trigger_script':
      case 'trigger_script_with_args': {
        // trigger_script;Event;Unit1;Unit2 / trigger_script_with_args;Event;k=v,k=v
        // (Python :3722/:3741): queues the named event and pauses this one.
        const eventName = args[0] ?? '';
        const trig: any = { type: eventName };
        if (cmd.type === 'trigger_script') {
          const unit1 = args[1] ? game.units.get(args[1]) : this.currentEvent?.trigger?.unit1;
          const unit2 = args[2] ? game.units.get(args[2]) : this.currentEvent?.trigger?.unit2;
          if (unit1) trig.unit1 = unit1;
          if (unit2) trig.unit2 = unit2;
        } else if (args[1]) {
          trig.localArgs = new Map<string, any>(
            args[1].split(',').map((pair: string) => {
              const [k, ...rest] = pair.split('=');
              return [k.trim(), rest.join('=').trim()] as [string, any];
            }),
          );
        }
        // Match by nid first, then by event name (Python get_by_nid_or_name).
        let targetNid = eventName;
        if (!game.db.events.has(targetNid)) {
          const byName = [...game.db.events.values()].find(
            (ev: any) => ev.name === eventName &&
              (!ev.level_nid || ev.level_nid === game.currentLevel?.nid),
          );
          if (byName) targetNid = byName.nid;
        }
        this.advancePointer();
        const queued = game.eventManager.triggerSpecific(targetNid, trig, true);
        if (!queued) {
          console.warn(`trigger_script: no valid event matching "${eventName}"`);
          return false;
        }
        game.state.change('event');
        return true;
      }

      case 'records_screen': {
        // records_screen (Python event_functions.py:3427) — pause into records
        this.advancePointer();
        game.state.change('base_records');
        return true;
      }

      case 'open_library':
      case 'open_guide': {
        const wantGuide = cmd.type === 'open_guide';
        const unlocked: Set<string> = new Set(game.unlockedLore ?? []);
        const hasMatching = [...(game.db.lore?.values?.() ?? [])].some(
          (lore: any) => unlocked.has(lore.nid) && (lore.category === 'Guide') === wantGuide,
        );
        if (!hasMatching) {
          this.advancePointer();
          return false;
        }
        return this.openStateWithTransition(
          wantGuide ? 'base_guide' : 'base_library',
          args,
          game,
        );
      }

      case 'open_credits': {
        if (args[0]) game.memory.set('base_bg', args[0]);
        return this.openStateWithTransition('credit', args, game);
      }

      case 'soundroom': {
        if (args[0]) game.memory.set('base_bg', args[0]);
        return this.openStateWithTransition('base_sound_room', args, game);
      }

      case 'open_trade': {
        const unitA = game.units.get(args[0] ?? '');
        const unitB = game.units.get(args[1] ?? '');
        this.advancePointer();
        if (!unitA || !unitB) {
          console.warn(`open_trade: could not find unit ${!unitA ? args[0] : args[1]}`);
          return false;
        }
        game.selectedUnit = unitA;
        game.memory.set('trade_partner', unitB);
        game.state.change('trade');
        return true;
      }

      case 'set_skill_data': {
        const unitNid = args[0] ?? '';
        const skillNid = args[1] ?? '';
        const dataKey = args[2] ?? '';
        const rawExpr = args[3] ?? '';
        const unit = game.units.get(unitNid);
        const skill = unit?.skills?.find((candidate: SkillObject) => candidate.nid === skillNid);
        if (!unit || !skill || !dataKey) {
          console.warn(`set_skill_data: invalid unit/skill/key (${unitNid}/${skillNid}/${dataKey})`);
          this.advancePointer();
          return false;
        }
        let value: unknown = rawExpr;
        if (/^-?\d+(\.\d+)?$/.test(rawExpr)) value = Number(rawExpr);
        else if (rawExpr === 'True' || rawExpr === 'true') value = true;
        else if (rawExpr === 'False' || rawExpr === 'false') value = false;
        game.actionLog.doAction(new SetSkillDataAction(skill, dataKey, value));
        this.advancePointer();
        return false;
      }

      case 'set_mode_rng': {
        // set_mode_rng;RNG (Python event_functions.py:2382) — not turnwheel-logged
        const validModes = ['classic', 'true_hit', 'true_hit_plus', 'fates_hit', 'grandmaster'];
        const mode = (args[0] ?? '').trim();
        if (!validModes.includes(mode)) {
          console.warn(`set_mode_rng: ${mode} is not a valid RNG option`);
        } else if (game.currentMode) {
          game.currentMode.rng_mode = mode;
        }
        this.advancePointer();
        return false;
      }

      case 'set_mode_autolevels': {
        // set_mode_autolevels;Level;flags (Python event_functions.py:2367)
        // hidden flag -> autolevels (invisible); boss flag -> boss variants.
        const level = parseInt(args[0] ?? '0', 10) || 0;
        const flagSet = new Set(args.slice(1).map((a: string) => a.trim().toLowerCase()));
        if (game.currentMode) {
          if (flagSet.has('hidden')) {
            if (flagSet.has('boss')) game.currentMode.bossAutolevels = level;
            else game.currentMode.enemyAutolevels = level;
          } else {
            if (flagSet.has('boss')) game.currentMode.bossTruelevels = level;
            else game.currentMode.enemyTruelevels = level;
          }
        }
        this.advancePointer();
        return false;
      }

      case 'show_minimap': {
        // show_minimap (Python event_functions.py:3532) — pauses the event
        // while the minimap state is open; resumes when it pops.
        this.advancePointer();
        game.state.change('minimap');
        return true;
      }

      case 'set_game_board_bounds': {
        // set_game_board_bounds;MinX;MinY;MaxX;MaxY (Python event_functions.py:890)
        const [minX, minY, maxX, maxY] = args.slice(0, 4).map((a: string) => parseInt(a, 10));
        if (!game.board) {
          console.warn('set_game_board_bounds: no game board available');
        } else if (!(maxX > minX) || !(maxY > minY)) {
          console.warn(`set_game_board_bounds: Max must be strictly greater than Min (${minX},${minY},${maxX},${maxY})`);
        } else {
          game.actionLog.doAction(new SetGameBoardBoundsAction(game.board, [minX, minY, maxX, maxY]));
        }
        this.advancePointer();
        return false;
      }

      case 'remove_game_board_bounds': {
        // remove_game_board_bounds (Python event_functions.py:901)
        if (game.board && game.tilemap) {
          game.actionLog.doAction(new SetGameBoardBoundsAction(
            game.board,
            [0, 0, game.tilemap.width - 1, game.tilemap.height - 1],
          ));
        }
        this.advancePointer();
        return false;
      }

      case 'dump_vars': {
        // dump_vars (Python event_functions.py:3996) writes vars to a file and
        // opens it; the web logs a structured dump instead (documented deviation).
        console.log('[dump_vars] game_vars:', Object.fromEntries(game.gameVars));
        console.log('[dump_vars] level_vars:', Object.fromEntries(game.levelVars));
        this.advancePointer();
        return false;
      }

      case 'delete_save': {
        // delete_save;SaveSlot (Python event_functions.py:769); 'suspend'
        // deletes the quicksave. Fire-and-forget like other async browser IO.
        const slot = (args[0] ?? '').trim();
        void (async () => {
          const saveModule = await import('../save');
          if (slot.toLowerCase() === 'suspend') {
            await saveModule.deleteSuspend(game.db.getConstant('game_nid', 'default') as string);
          } else {
            const slotNum = parseInt(slot, 10);
            await saveModule.deleteSave(
              game.db.getConstant('game_nid', 'default') as string,
              Number.isNaN(slotNum) ? 0 : slotNum,
            );
          }
        })().catch((err) => console.warn('delete_save failed:', err));
        this.advancePointer();
        return false;
      }

      case 'set_position': {
        // set_position;x,y  (or a unit nid, resolved to its current position)
        // Overrides {e:position} for the remainder of this event, mirroring
        // Python's Event.position / text_evaluator.position.
        const posArg = args[0] ?? '';
        const resolved = this.resolvePosition(posArg, game);
        if (this.currentEvent) {
          this.currentEvent.trigger.position = resolved ?? undefined;
        }
        this.advancePointer();
        return false;
      }

      case 'remove_unit': {
        // Matches Python's remove_unit event function: it only takes the
        // unit off the map (action.LeaveMap/FadeOut/WarpOut/SwooshOut all
        // just clear position via game.leave()); it never removes the unit
        // from the unit registry. Persistent player units must remain in
        // game.units (as off-map reserve members) so they carry over to
        // future levels; only the map/board presence is cleared here.
        const unitNid = args[0] ?? '';
        const unit = this.findUnit(unitNid);
        if (unit?.position) {
          game.actionLog.doAction(new LeaveMapAction(game, unit));
        }
        this.advancePointer();
        return false;
      }

      case 'kill_unit': {
        const unitNid = args[0] ?? '';
        const unit = this.findUnit(unitNid);
        const wasOnMap = !!unit?.position;
        if (unit) {
          game.actionLog.doAction(new SetCurrentHpAction(unit, 0));
          game.actionLog.doAction(new DeathAction(unit, game.board, game.initiative));
        }
        const immediate = args.some(arg => arg.toLowerCase().trim() === 'immediate');
        if (this.skipMode || immediate || !wasOnMap) {
          this.advancePointer();
          return false;
        }
        this.waiting = true;
        this.waitTimer = 500;
        return true;
      }

      case 'add_group': {
        // Placement: giveup (default), stack, closest, push
        const groupNid = args[0] ?? '';
        const startingGroup = args[1] ?? '';
        // args[2] = entry type (ignored for now — all entries are immediate)
        const placement = (args[3] ?? 'giveup').toLowerCase().trim();
        const groups: any[] = game.currentLevel?.unit_groups ?? [];
        const group = groups.find((g: any) => g.nid === groupNid);
        if (!group) {
          console.warn(`EventState add_group: group "${groupNid}" not found`);
          this.advancePointer();
          return false;
        }

        const unitNids: string[] = group.units ?? [];
        const levelUnits = game.currentLevel?.units ?? [];

        for (const uNid of unitNids) {
          // Skip if already on map or dead
          const existing = this.findUnit(uNid);
          if (existing?.position || existing?.isDead()) continue;
          // If not spawned yet, skip units that are already in the registry
          if (existing && existing.position) continue;

          const position = this._getGroupPosition(startingGroup, uNid, group, groups, game);
          if (!position) continue;

          const finalPos = this._checkPlacement(position, placement, game);
          if (!finalPos) continue;

          // Need to spawn the unit first if not yet in registry
          if (!existing) {
            let unitData = levelUnits.find((u: any) => u.nid === uNid);
            if (!unitData) {
              const dbUnit = game.db.units.get(uNid);
              if (dbUnit) {
                unitData = { ...dbUnit, generic: false, team: 'enemy', ai: 'Normal' };
              } else {
                continue;
              }
            }
            this.spawnUnitFromLevelData(unitData, finalPos, game);
          } else {
            // Unit exists but not on map — place them
            game.actionLog.doAction(new ArriveOnMapAction(game, existing, finalPos, true));
          }
        }
        this.advancePointer();
        return false;
      }

      case 'spawn_group': {
        const groupNid = args[0] ?? '';
        const direction = (args[1] ?? 'south').toLowerCase().trim();
        const startingGroup = args[2] ?? '';
        const movementType = (args[3] || 'normal').toLowerCase().trim();
        const placement = (args[4] ?? 'giveup').toLowerCase().trim();
        const noBlock = args.some(arg => arg.toLowerCase().trim() === 'no_block');
        const noFollow = args.some(arg => arg.toLowerCase().trim() === 'no_follow');
        const groups = game.currentLevel?.unit_groups ?? [];
        const group = groups.find((groupCandidate: UnitGroupData) => groupCandidate.nid === groupNid);
        if (!group) {
          console.warn(`EventState spawn_group: group "${groupNid}" not found`);
          this.advancePointer();
          return false;
        }

        const levelUnits = game.currentLevel?.units ?? [];
        const mapW = game.tilemap?.width ?? 20;
        const mapH = game.tilemap?.height ?? 20;
        const moves: Array<{ unit: UnitObject; target: [number, number] }> = [];
        for (const unitNid of group.units) {
          const existing = this.findUnit(unitNid);
          if (existing?.position || existing?.isDead()) continue;
          const destination = this._getGroupPosition(
            startingGroup,
            unitNid,
            group,
            groups,
            game,
          );
          if (!destination) continue;
          const finalDestination = this._checkPlacement(destination, placement, game);
          if (!finalDestination) continue;

          let edgePosition: [number, number];
          if (direction === 'north') edgePosition = [finalDestination[0], 0];
          else if (direction === 'south') edgePosition = [finalDestination[0], mapH - 1];
          else if (direction === 'west') edgePosition = [0, finalDestination[1]];
          else edgePosition = [mapW - 1, finalDestination[1]];

          if (!existing) {
            let unitData = levelUnits.find(
              (candidate: UniqueUnitData | GenericUnitData) => candidate.nid === unitNid,
            );
            if (!unitData) {
              const dbUnit = game.db.units.get(unitNid);
              if (!dbUnit) continue;
              unitData = { ...dbUnit, generic: false, team: 'enemy', ai: 'Normal' };
            }
            this.spawnUnitFromLevelData(unitData, edgePosition, game);
          } else {
            game.actionLog.doAction(new ArriveOnMapAction(game, existing, edgePosition, true));
          }

          const spawnedUnit = this.findUnit(unitNid);
          if (!spawnedUnit || !game.board) continue;
          if (this.skipMode || movementType !== 'normal') {
            game.actionLog.doAction(new ArriveOnMapAction(game, spawnedUnit, finalDestination));
          } else {
            moves.push({ unit: spawnedUnit, target: finalDestination });
          }
        }

        if (moves.length === 0) {
          this.advancePointer();
          return false;
        }
        if (!noFollow) {
          const target = moves[moves.length - 1].target;
          game.camera?.focusTile(target[0], target[1]);
        }
        const blocks = !noBlock;
        if (blocks) this.blockingEventMovements = moves.length;
        let startedMoves = 0;
        for (const move of moves) {
          const started = this.beginEventMove(move.unit, move.target, 120, game, () => {
            if (blocks) {
              this.blockingEventMovements--;
              if (this.blockingEventMovements === 0) this.advancePointer();
            }
          });
          if (started) startedMoves++;
          else if (blocks) this.blockingEventMovements--;
        }
        if (startedMoves === 0) {
          this.blockingEventMovements = 0;
          this.advancePointer();
          return false;
        }
        if (noBlock) {
          this.advancePointer();
          return false;
        }
        if (this.blockingEventMovements === 0) {
          this.advancePointer();
          return false;
        }
        return true;
      }

      case 'remove_group': {
        // Matches Python's remove_group: only takes units off the map via
        // action.LeaveMap/FadeOut/WarpOut (position clear); it never deletes
        // them from the unit registry. See 'remove_unit' above for the same
        // fix and rationale (persistent player units must survive as
        // off-map reserve members).
        const groupNid = args[0] ?? '';
        const groups: any[] = game.currentLevel?.unit_groups ?? [];
        const group = groups.find((g: any) => g.nid === groupNid);
        if (group) {
          const unitNids: string[] = group.units ?? [];
          for (const uNid of unitNids) {
            const unit = this.findUnit(uNid);
            if (unit?.position) {
              game.actionLog.doAction(new LeaveMapAction(game, unit));
            }
          }
        }
        this.advancePointer();
        return false;
      }

      case 'move_group': {
        const groupNid = args[0] ?? '';
        const startingGroup = args[1] ?? '';
        const movementType = (args[2] || 'normal').toLowerCase().trim();
        const placement = (args[3] ?? 'giveup').toLowerCase().trim();
        const noBlock = args.some(arg => arg.toLowerCase().trim() === 'no_block');
        const noFollow = args.some(arg => arg.toLowerCase().trim() === 'no_follow');
        const groups = game.currentLevel?.unit_groups ?? [];
        const group = groups.find((groupCandidate: UnitGroupData) => groupCandidate.nid === groupNid);
        if (!group || !game.board) {
          this.advancePointer();
          return false;
        }

        const moves: Array<{ unit: UnitObject; target: [number, number] }> = [];
        for (const unitNid of group.units) {
          const unit = this.findUnit(unitNid);
          if (!unit?.position) continue;
          const destination = this._getGroupPosition(
            startingGroup,
            unitNid,
            group,
            groups,
            game,
          );
          if (!destination) continue;
          const finalPosition = this._checkPlacement(destination, placement, game);
          if (!finalPosition) continue;
          if (this.skipMode || movementType !== 'normal') {
            game.board.moveUnit(unit, finalPosition[0], finalPosition[1]);
          } else {
            moves.push({ unit, target: finalPosition });
          }
        }

        if (moves.length === 0) {
          this.advancePointer();
          return false;
        }
        if (!noFollow) {
          const target = moves[moves.length - 1].target;
          game.camera?.focusTile(target[0], target[1]);
        }
        const blocks = !noBlock;
        if (blocks) this.blockingEventMovements = moves.length;
        let startedMoves = 0;
        for (const move of moves) {
          const started = this.beginEventMove(move.unit, move.target, 120, game, () => {
            if (blocks) {
              this.blockingEventMovements--;
              if (this.blockingEventMovements === 0) this.advancePointer();
            }
          });
          if (started) startedMoves++;
          else if (blocks) this.blockingEventMovements--;
        }
        if (startedMoves === 0) {
          this.blockingEventMovements = 0;
          this.advancePointer();
          return false;
        }
        if (noBlock) {
          this.advancePointer();
          return false;
        }
        if (this.blockingEventMovements === 0) {
          this.advancePointer();
          return false;
        }
        return true;
      }

      // ----- Item / Skill commands (instant) -----

      case 'give_item': {
        // give_item;unit_nid;item_nid — give an item to a unit
        // If unit_nid is 'convoy', put it directly in the convoy
        const giUnitNid = args[0] ?? '';
        const giItemNid = args[1] ?? '';
        const giBannerFlag = !args.includes('no_banner');
        const giItemPrefab = game.db.items.get(giItemNid);
        let giBannerText: string | undefined;
        if (giItemPrefab) {
          const giItem = createItemTree(giItemPrefab, (nid) => game.db.items.get(nid));
          game.actionLog.doAction(new SetItemDroppableAction(giItem, args.includes('droppable')));
          if (giUnitNid.toLowerCase() === 'convoy') {
            const giParty = game.getParty(args[2] || undefined);
            if (giParty) {
              game.actionLog.doAction(new PutItemInConvoy(giItem, giParty.nid));
              giBannerText = `${giItem.name} sent to convoy.`;
            }
          } else {
            const giUnit = this.findUnit(giUnitNid);
            if (giUnit) {
              game.actionLog.doAction(new GiveItemAction(giUnit, giItem));
              const giArticle = /^[aeiou]/i.test(giItem.name) ? 'an' : 'a';
              giBannerText = `${giUnit.name} got ${giArticle} ${giItem.name}.`;
            }
          }
        }
        if (giBannerFlag && giBannerText && !this.skipMode) {
          this.banner = new Banner(giBannerText, undefined, 3000);
          this.bannerIsAlert = true;
          return true;
        }
        this.advancePointer();
        return false;
      }

      case 'remove_item': {
        const ownerNid = args[0] ?? '';
        const itemNid = args[1] ?? '';
        const riBannerFlag = !args.includes('no_banner');
        let riBannerText: string | undefined;
        if (ownerNid.toLowerCase() === 'convoy') {
          const partyArg = args.slice(2).find((arg) => arg !== 'no_banner');
          const party = game.getParty(partyArg || undefined);
          const item = party?.convoy.find((candidate: ItemObject) => candidate.nid === itemNid);
          if (item) game.actionLog.doAction(new RemoveItemFromConvoy(item, party?.nid));
        } else {
          const unit = this.findUnit(ownerNid);
          const item = unit?.items.find((candidate: ItemObject) => candidate.nid === itemNid);
          if (unit && item) {
            game.actionLog.doAction(new RemoveItemFromUnitAction(unit, item));
            riBannerText = `${unit.name} lost ${item.name}.`;
          }
        }
        if (riBannerFlag && riBannerText && !this.skipMode) {
          this.banner = new Banner(riBannerText, undefined, 3000);
          this.bannerIsAlert = true;
          return true;
        }
        this.advancePointer();
        return false;
      }

      case 'move_item': {
        const giverNid = args[0] ?? '';
        const receiverNid = args[1] ?? '';
        const giverIsConvoy = giverNid.toLowerCase() === 'convoy';
        const receiverIsConvoy = receiverNid.toLowerCase() === 'convoy';
        const giverUnit = giverIsConvoy ? undefined : this.findUnit(giverNid);
        const sourceItems: ItemObject[] | undefined = giverIsConvoy
          ? game.getParty()?.convoy
          : giverUnit?.items;
        const item = args[2]
          ? sourceItems?.find((candidate) => candidate.nid === args[2])
          : sourceItems?.at(-1);

        if (!item || (!giverIsConvoy && !giverUnit)) {
          console.warn(`Event move_item: invalid giver or item (${args.join(';')})`);
        } else if (giverIsConvoy && receiverIsConvoy) {
          console.warn('Event move_item: current convoy is already the receiver');
        } else if (giverIsConvoy) {
          const receiver = this.findUnit(receiverNid);
          if (receiver && !this.inventoryFull(receiver, item)) {
            game.actionLog.doAction(new TakeItemFromConvoy(receiver, item));
          } else {
            console.warn(`Event move_item: invalid or full receiver (${receiverNid})`);
          }
        } else if (receiverIsConvoy) {
          game.actionLog.doAction(new StoreItemAction(giverUnit!, item));
        } else {
          const receiver = this.findUnit(receiverNid);
          if (receiver && !this.inventoryFull(receiver, item)) {
            game.actionLog.doAction(new MoveItemBetweenUnitsAction(giverUnit!, receiver, item));
          } else {
            console.warn(`Event move_item: invalid or full receiver (${receiverNid})`);
          }
        }
        this.advancePointer();
        return false;
      }

      case 'move_item_between_convoys': {
        const itemNid = args[0] ?? '';
        const sourcePartyNid = args[1] ?? '';
        const targetPartyNid = args[2] ?? '';
        const sourceValid = game.parties.has(sourcePartyNid) || game.db.parties.has(sourcePartyNid);
        const targetValid = game.parties.has(targetPartyNid) || game.db.parties.has(targetPartyNid);
        const sourceParty = sourceValid ? game.getParty(sourcePartyNid) : null;
        const targetParty = targetValid ? game.getParty(targetPartyNid) : null;
        const item = sourceParty?.convoy.find((candidate: ItemObject) => candidate.nid === itemNid);
        if (item && sourceParty && targetParty && sourceParty !== targetParty) {
          game.actionLog.doAction(new MoveItemBetweenConvoysAction(item, sourcePartyNid, targetPartyNid));
        } else {
          console.warn(`Event move_item_between_convoys: invalid party or item (${args.join(';')})`);
        }
        this.advancePointer();
        return false;
      }

      case 'change_item_name':
      case 'change_item_desc': {
        const item = this.findInventoryItem(args[0] ?? '', args[1] ?? '');
        if (item) {
          const attribute = cmd.type === 'change_item_name' ? 'name' : 'desc';
          game.actionLog.doAction(new ChangeItemTextAction(item, attribute, args[2] ?? ''));
        }
        this.advancePointer();
        return false;
      }

      case 'add_item_to_multiitem': {
        const parent = this.findInventoryItem(args[0] ?? '', args[1] ?? '');
        const childNid = args[2] ?? '';
        const childPrefab = game.db.items.get(childNid);
        const duplicate = parent?.subitems.some((child) => child.nid === childNid) ?? false;
        if (parent?.hasComponent('multi_item') && childPrefab && !(duplicate && args.includes('no_duplicate'))) {
          const child = createItemTree(childPrefab, (nid) => game.db.items.get(nid));
          const key = `event_sub_${parent.nid}_${child.nid}_${game.items.size}`;
          const registerTree = (node: ItemObject, nodeKey: string) => {
            game.items.set(nodeKey, node);
            node.subitems.forEach((nested, index) => registerTree(nested, `${nodeKey}_sub_${index}_${nested.nid}`));
          };
          registerTree(child, key);
          game.actionLog.doAction(new AddSubItemAction(parent, child));
          if (args.includes('equip')) {
            console.warn('Event add_item_to_multiitem: equip flag awaits multi-item selection UI parity');
          }
        } else if (!duplicate || !args.includes('no_duplicate')) {
          console.warn(`Event add_item_to_multiitem: invalid parent or child (${args.join(';')})`);
        }
        this.advancePointer();
        return false;
      }

      case 'remove_item_from_multiitem': {
        const parent = this.findInventoryItem(args[0] ?? '', args[1] ?? '');
        if (parent?.hasComponent('multi_item')) {
          const children = args[2]
            ? parent.subitems.filter((child) => child.nid === args[2]).slice(0, 1)
            : [...parent.subitems];
          for (const child of children) {
            game.actionLog.doAction(new RemoveSubItemAction(parent, child));
          }
        } else {
          console.warn(`Event remove_item_from_multiitem: invalid parent (${args.join(';')})`);
        }
        this.advancePointer();
        return false;
      }

      case 'set_item_droppable': {
        const item = this.findInventoryItem(args[0] ?? '', args[1] ?? '');
        const value = (args[2] ?? '').toLowerCase();
        if (item) {
          game.actionLog.doAction(new SetItemDroppableAction(item, ['true', '1', 'yes'].includes(value)));
        }
        this.advancePointer();
        return false;
      }

      case 'set_item_data': {
        const item = this.findInventoryItem(args[0] ?? '', args[1] ?? '');
        const key = args[2] ?? '';
        const rawValue = args[3] ?? '';
        const value = args.includes('from_python')
          ? rawValue
          : evaluateExpression(rawValue, this.buildConditionContext());
        if (item && key && value !== undefined) {
          game.actionLog.doAction(new SetItemDataAction(item, key, value));
        } else if (item && key) {
          console.warn(`Event set_item_data: could not evaluate ${rawValue}`);
        }
        this.advancePointer();
        return false;
      }

      case 'set_item_uses': {
        const item = this.findInventoryItem(args[0] ?? '', args[1] ?? '', args.includes('recursive'));
        const requested = Number(evaluateExpression(args[2] ?? '', this.buildConditionContext()));
        if (item && item.maxUses > 0 && Number.isFinite(requested)) {
          const value = args.includes('additive') ? item.uses + requested : requested;
          game.actionLog.doAction(new SetItemUsesAction(item, value));
        } else {
          console.warn(`Event set_item_uses: invalid owner, item, or uses (${args.join(';')})`);
        }
        this.advancePointer();
        return false;
      }

      case 'break_item': {
        const item = this.findInventoryItem(args[0] ?? '', args[1] ?? '');
        const biBannerFlag = !args.includes('no_banner');
        const biUnitNid = args[0] ?? '';
        const biUnit = this.findUnit(biUnitNid);
        if (item && item.maxUses > 0) {
          game.actionLog.doAction(new SetItemUsesAction(item, 0));
          if (biBannerFlag && biUnit && biUnit.team === 'player' && !this.skipMode) {
            this.banner = new Banner(`${item.name} broke.`, undefined, 3000);
            this.bannerIsAlert = true;
            return true;
          }
        } else {
          console.warn(`Event break_item: item has no uses (${args.join(';')})`);
        }
        this.advancePointer();
        return false;
      }

      case 'give_skill': {
        const unitNid = args[0] ?? '';
        const skillNid = args[1] ?? '';
        const unit = this.findUnit(unitNid);
        const skillPrefab = game.db.skills.get(skillNid);
        const gsBannerFlag = !args.includes('no_banner');
        let gsAdded = false;
        if (unit && skillPrefab) {
          if (!unit.skills.some((s: SkillObject) => s.nid === skillNid)) {
            const skill = new SkillObject(skillPrefab);
            game.actionLog.doAction(new AddSkillAction(unit, skill));
            gsAdded = true;
          }
        }
        if (gsBannerFlag && gsAdded && unit && skillPrefab && !this.skipMode) {
          this.banner = new Banner(`${unit.name} got ${skillPrefab.name}.`, undefined, 3000);
          this.bannerIsAlert = true;
          return true;
        }
        this.advancePointer();
        return false;
      }

      case 'remove_skill': {
        const unitNid = args[0] ?? '';
        const skillNid = args[1] ?? '';
        const unit = this.findUnit(unitNid);
        const rsBannerFlag = !args.includes('no_banner');
        let rsRemovedSkill: SkillObject | undefined;
        if (unit) {
          rsRemovedSkill = unit.skills.find((skill: SkillObject) => skill.nid === skillNid);
          if (rsRemovedSkill) {
            game.actionLog.doAction(new RemoveSkillAction(unit, rsRemovedSkill));
          }
        }
        if (rsBannerFlag && rsRemovedSkill && unit && !this.skipMode) {
          this.banner = new Banner(`${unit.name} lost ${rsRemovedSkill.name}.`, undefined, 3000);
          this.bannerIsAlert = true;
          return true;
        }
        this.advancePointer();
        return false;
      }

      // ----- Stat / Property commands (instant) -----

      case 'set_current_hp': {
        const unitNid = args[0] ?? '';
        const hpValue = parseInt(args[1], 10);
        const unit = this.findUnit(unitNid);
        if (unit && !isNaN(hpValue)) {
          game.actionLog.doAction(new SetCurrentHpAction(unit, hpValue));
        }
        this.advancePointer();
        return false;
      }

      case 'give_exp': {
        const unitNid = args[0] ?? '';
        const amount = parseInt(args[1], 10) || 0;
        const unit = this.findUnit(unitNid);
        if (unit) {
          game.actionLog.doAction(
            new GainExpAction(unit, amount, game.currentMode?.growths ?? 'random'),
          );
        }
        const silent = args.some(arg => arg.toLowerCase().trim() === 'silent');
        if (!silent && !this.skipMode) {
          this.waiting = true;
          this.waitTimer = 750;
          return true;
        }
        this.advancePointer();
        return false;
      }

      case 'give_wexp': {
        const unit = game.units.get(args[0]);
        const weaponType = args[1];
        const amount = parseInt(args[2] ?? '', 10);
        if (unit && weaponType && Number.isFinite(amount)) {
          const action = new GainWexpAction(unit, weaponType, amount);
          game.actionLog.doAction(action);
          const rankUp = action.getRankUp();
          if (rankUp) {
            game.eventManager?.trigger(
              {
                type: 'unit_weapon_rank_up',
                levelNid: game.currentLevel?.nid ?? '',
                unitNid: unit.nid,
                unit1: unit,
                weaponType,
                oldWexp: action.getOldWexp(),
                rank: rankUp.rank,
              },
              this.buildConditionContext(),
            );
            if (!args.includes('no_banner') && !this.skipMode) {
              this.banner = new Banner(`${unit.name} reached rank ${rankUp.rank}.`, weaponType, 3000);
              this.bannerIsAlert = true;
              return true;
            }
          }
        } else {
          console.warn(`Event give_wexp: invalid unit, weapon type, or amount (${args.join(';')})`);
        }
        this.advancePointer();
        return false;
      }

      case 'set_wexp': {
        const unit = game.units.get(args[0]);
        const weaponType = args[1];
        const value = parseInt(args[2] ?? '', 10);
        if (unit && weaponType && Number.isFinite(value)) {
          const action = new SetWexpAction(unit, weaponType, value);
          game.actionLog.doAction(action);
          const rankUp = action.getRankUp();
          if (rankUp) {
            game.eventManager?.trigger(
              {
                type: 'unit_weapon_rank_up',
                levelNid: game.currentLevel?.nid ?? '',
                unitNid: unit.nid,
                unit1: unit,
                weaponType,
                oldWexp: action.getOldWexp(),
                rank: rankUp.rank,
              },
              this.buildConditionContext(),
            );
            if (!args.includes('no_banner') && !this.skipMode) {
              this.banner = new Banner(`${unit.name} reached rank ${rankUp.rank}.`, weaponType, 3000);
              this.bannerIsAlert = true;
              return true;
            }
          }
        } else {
          console.warn(`Event set_wexp: invalid unit, weapon type, or value (${args.join(';')})`);
        }
        this.advancePointer();
        return false;
      }

      case 'change_ai': {
        const unitNid = args[0] ?? '';
        const aiNid = args[1] ?? 'None';
        const unit = this.findUnit(unitNid);
        if (unit) {
          game.actionLog.doAction(new SetUnitAttributeAction(unit, 'ai', aiNid));
        }
        this.advancePointer();
        return false;
      }

      case 'change_ai_group': {
        const unit = this.findUnit(args[0] ?? '');
        if (unit) {
          game.actionLog.doAction(new SetUnitAttributeAction(unit, 'aiGroup', args[1] ?? ''));
        }
        this.advancePointer();
        return false;
      }

      case 'change_faction': {
        const unit = this.findUnit(args[0] ?? '');
        const factionNid = args[1] ?? '';
        if (unit && game.db.factions.has(factionNid)) {
          game.actionLog.doAction(new ChangeFactionAction(unit, factionNid));
        } else {
          console.warn(`Event change_faction: invalid unit or faction (${args.join(';')})`);
        }
        this.advancePointer();
        return false;
      }

      case 'change_portrait': {
        const unit = this.findUnit(args[0] ?? '');
        const portraitNid = args[1] || null;
        const portraitExists = !portraitNid || !game.db.portraits?.size || game.db.portraits.has(portraitNid);
        if (unit && portraitExists) {
          game.actionLog.doAction(new SetUnitAttributeAction(unit, 'portraitNid', portraitNid));
        } else {
          console.warn(`Event change_portrait: invalid unit or portrait (${args.join(';')})`);
        }
        this.advancePointer();
        return false;
      }

      case 'change_unit_desc': {
        const unit = this.findUnit(args[0] ?? '');
        if (unit) game.actionLog.doAction(new SetUnitAttributeAction(unit, 'desc', args[1] ?? ''));
        this.advancePointer();
        return false;
      }

      case 'change_affinity': {
        const unit = this.findUnit(args[0] ?? '');
        const affinityNid = args[1] ?? '';
        if (unit) {
          game.actionLog.doAction(new SetUnitAttributeAction(unit, 'affinity', affinityNid));
        }
        this.advancePointer();
        return false;
      }

      case 'change_team': {
        const unitNid = args[0] ?? '';
        const team = args[1] ?? 'player';
        const unit = this.findUnit(unitNid);
        if (unit) {
          game.actionLog.doAction(new ChangeTeamAction(unit, team));
          // Re-palette the sprite (would need async reload in full implementation)
        }
        this.advancePointer();
        return false;
      }

      case 'change_stats': {
        const unit = this.findUnit(args[0] ?? '');
        const requested = this.parseNumberRecord(args[1] ?? '');
        if (!unit || Object.keys(requested).length === 0) {
          this.advancePointer();
          return false;
        }
        const action = new ApplyStatChangesAction(unit, requested);
        game.actionLog.doAction(action);
        const applied = action.getAppliedChanges();
        const immediate = args.some((arg: string) => arg.toLowerCase() === 'immediate');
        if (!immediate && this.startEventLevelUpPresentation(unit, applied, 'stat_change', unit.level)) {
          return true;
        }
        this.advancePointer();
        return false;
      }

      case 'add_tag': {
        const unitNid = args[0] ?? '';
        const tag = args[1] ?? '';
        const unit = this.findUnit(unitNid);
        if (unit && tag && !unit.tags.includes(tag)) {
          unit.tags.push(tag);
        }
        this.advancePointer();
        return false;
      }

      case 'remove_tag': {
        const unitNid = args[0] ?? '';
        const tag = args[1] ?? '';
        const unit = this.findUnit(unitNid);
        if (unit && tag) {
          const idx = unit.tags.indexOf(tag);
          if (idx !== -1) unit.tags.splice(idx, 1);
        }
        this.advancePointer();
        return false;
      }

      // ----- Game variable commands (instant) -----

      case 'game_var':
      case 'set_game_var': {
        const varName = args[0] ?? '';
        const value = args[1] ?? 'true';
        if (varName && game.gameVars) {
          game.actionLog.doAction(new SetGameVarAction(game.gameVars, varName, value));
        }
        this.advancePointer();
        return false;
      }

      case 'inc_game_var': {
        const varName = args[0] ?? '';
        if (varName && game.gameVars) {
          const current = Number(game.gameVars.get(varName) ?? 0);
          game.actionLog.doAction(new SetGameVarAction(game.gameVars, varName, current + 1));
        }
        this.advancePointer();
        return false;
      }

      case 'set_next_chapter': {
        // Override sequential level progression: set _goto_level to a specific chapter NID.
        // Matches Python: action.do(action.SetGameVar("_goto_level", chapter))
        const chapterNid = args[0] ?? '';
        if (chapterNid) {
          if (!game.db.levels.has(chapterNid)) {
            console.warn(`set_next_chapter: "${chapterNid}" is not a valid chapter nid`);
          } else {
            game.actionLog.doAction(new SetGameVarAction(game.gameVars, '_goto_level', chapterNid));
          }
        }
        this.advancePointer();
        return false;
      }

      case 'level_var': {
        const varName = args[0] ?? '';
        const value = args[1] ?? 'true';
        if (varName && game.levelVars) {
          game.actionLog.doAction(new SetLevelVarAction(game.levelVars, varName, value));
        }
        this.advancePointer();
        return false;
      }

      case 'inc_level_var': {
        const varName = args[0] ?? '';
        if (varName && game.levelVars) {
          const current = Number(game.levelVars.get(varName) ?? 0);
          game.actionLog.doAction(new SetLevelVarAction(game.levelVars, varName, current + 1));
        }
        this.advancePointer();
        return false;
      }

      // ----- Audio commands -----

      case 'music':
      case 'change_music': {
        // change_music can be called two ways:
        // 1. music;musicNid (direct play)
        // 2. change_music;phase_type;musicNid (change phase music)
        // Phase types: player_phase, enemy_phase, other_phase, player_battle, enemy_battle
        const phaseTypes = ['player_phase', 'enemy_phase', 'other_phase', 'player_battle', 'enemy_battle'];
        let musicNid: string;
        if (args.length >= 2 && phaseTypes.includes(args[0])) {
          // Phase variant: args[0] is phase type, args[1] is music NID
          // TODO: actually store the phase music override for the level
          musicNid = args[1];
        } else {
          musicNid = args[0] ?? '';
        }
        if (musicNid && game.audioManager) {
          game.audioManager.playMusic(musicNid);
        }
        this.advancePointer();
        // Music is treated as blocking briefly to let the transition feel natural
        this.waiting = true;
        this.waitTimer = 100;
        return true;
      }

      case 'sound': {
        const soundNid = args[0] ?? '';
        if (soundNid && game.audioManager) {
          game.audioManager.playSfx(soundNid);
        }
        this.advancePointer();
        return false;
      }

      // ----- Win / Lose (instant — they change the state machine) -----

      case 'win_game': {
        // Matches Python: just set the flag — the actual level transition
        // happens in finishAndDequeue() after the event completes, allowing
        // remaining event commands (e.g., dialog, transitions) to run first.
        game.actionLog.doAction(new SetLevelVarAction(game.levelVars, '_win_game', true));
        this.advancePointer();
        return false;
      }

      case 'lose_game': {
        game.actionLog.doAction(new SetLevelVarAction(game.levelVars, '_lose_game', true));
        this.advancePointer();
        return false;
      }

      // ----- Turn management -----

      case 'has_attacked': {
        const unitNid = args[0] ?? '';
        const unit = this.findUnit(unitNid);
        if (unit) game.actionLog.doAction(new HasAttackedAction(unit));
        this.advancePointer();
        return false;
      }

      case 'has_finished': {
        const unitNid = args[0] ?? '';
        const unit = this.findUnit(unitNid);
        if (unit) game.actionLog.doAction(new WaitAction(unit));
        this.advancePointer();
        return false;
      }

      case 'reset': {
        const unitNid = args[0] ?? '';
        const unit = this.findUnit(unitNid);
        if (unit) game.actionLog.doAction(new RefreshUnitAction(unit));
        this.advancePointer();
        return false;
      }

      // ----- Audio extended -----

      case 'music_fade_back': {
        // Restore the previous music (pop the stack)
        if (game.audioManager) {
          void game.audioManager.popMusic();
        }
        this.advancePointer();
        return false;
      }

      case 'music_clear': {
        if (game.audioManager) {
          game.audioManager.stopMusic();
        }
        this.advancePointer();
        return false;
      }

      case 'stop_sound': {
        // SFX are fire-and-forget — no way to stop them currently
        this.advancePointer();
        return false;
      }

      // ----- Camera / cursor commands -----

      case 'center_cursor':
      case 'move_cursor': {
        // center_cursor;x,y or center_cursor;UnitNid
        const posOrUnit = args[0] ?? '';
        const resolved = this.resolvePosition(posOrUnit, game);
        if (!resolved) {
          this.advancePointer();
          return false;
        }
        const immediate = this.skipMode ||
          args.some(arg => arg.toLowerCase().trim() === 'immediate');
        const noBlock = args.some(arg => arg.toLowerCase().trim() === 'no_block');
        game.cursor?.setPos(resolved[0], resolved[1]);
        if (immediate) {
          game.camera?.forceTile(resolved[0], resolved[1]);
          this.advancePointer();
          return false;
        }
        game.camera?.focusTile(resolved[0], resolved[1]);
        if (noBlock || (game.camera?.isAtTarget() ?? true)) {
          this.advancePointer();
          return false;
        }
        this.waitingForCamera = true;
        this.cameraWaitStartsFlicker = false;
        return true;
      }

      case 'disp_cursor': {
        // disp_cursor;true/false — show or hide cursor
        const show = (args[0] ?? 'true').toLowerCase();
        if (game.cursor) {
          game.cursor.visible = show !== 'false' && show !== '0';
        }
        this.advancePointer();
        return false;
      }

      case 'screen_shake': {
        // screen_shake;duration;shake_type;flags
        // shake_type: default, combat, kill, random, celeste (default: 'default')
        // flags: no_block
        const durationMs = parseInt(args[0], 10) || 500;
        const shakeType = (args[1] ?? 'default').toLowerCase().trim();
        const noBlock = args.some((a: string) => a.toLowerCase().trim() === 'no_block');
        if (game.camera) {
          game.camera.setShake(shakeType, durationMs);
        }
        if (noBlock || this.skipMode) {
          this.advancePointer();
          return false;
        }
        // Block for the shake duration
        this.waitTimer = durationMs;
        this.waiting = true;
        return true;
      }

      case 'screen_shake_end': {
        if (game.camera) {
          game.camera.resetShake();
        }
        this.advancePointer();
        return false;
      }

      case 'flicker_cursor': {
        const flickerTarget = args[0] ?? '';
        const flickerPos = this.resolvePosition(flickerTarget, game);
        if (!flickerPos) {
          this.advancePointer();
          return false;
        }
        const immediate = args.some(arg => arg.toLowerCase().trim() === 'immediate');
        game.cursor?.setPos(flickerPos[0], flickerPos[1]);
        if (this.skipMode) {
          game.camera?.forceTile(flickerPos[0], flickerPos[1]);
          if (game.cursor) game.cursor.visible = false;
          this.advancePointer();
          return false;
        }
        if (immediate) {
          game.camera?.forceTile(flickerPos[0], flickerPos[1]);
        } else {
          game.camera?.focusTile(flickerPos[0], flickerPos[1]);
          if (!(game.camera?.isAtTarget() ?? true)) {
            this.waitingForCamera = true;
            this.cameraWaitStartsFlicker = true;
            return true;
          }
        }
        if (game.cursor) game.cursor.visible = true;
        this.cursorFlickerTimer = 1000;
        return true;
      }

      // ----- Objective changes -----

      case 'change_objective_simple':
      case 'change_objective': {
        const newObj = args[0] ?? '';
        if (game.currentLevel?.objective) {
          game.currentLevel.objective.simple = newObj;
        }
        this.advancePointer();
        return false;
      }

      case 'change_objective_win': {
        const newWin = args[0] ?? '';
        if (game.currentLevel?.objective) {
          game.currentLevel.objective.win = newWin;
        }
        this.advancePointer();
        return false;
      }

      case 'change_objective_loss': {
        const newLoss = args[0] ?? '';
        if (game.currentLevel?.objective) {
          game.currentLevel.objective.loss = newLoss;
        }
        this.advancePointer();
        return false;
      }

      // ----- Money / BExp -----

      case 'give_money': {
        // give_money;amount[;party_nid]
        const amount = parseInt(args[0], 10) || 0;
        const moneyPartyNid = args[1] || undefined;
        const gmBannerFlag = !args.includes('no_banner');
        const party = game.getParty(moneyPartyNid);
        if (party) {
          game.actionLog.doAction(new GainMoneyAction(amount, party.nid));
          game.actionLog.doAction(new UpdateRecordsAction('money', party.nid, amount));
          game.actionLog.doAction(
            new SetGameVarAction(game.gameVars, 'money', game.getMoney()),
          );
        }
        if (gmBannerFlag && !this.skipMode) {
          const text = amount >= 0 ? `Got ${amount} gold.` : `Lost ${-amount} gold.`;
          this.banner = new Banner(text, undefined, 3000);
          this.bannerIsAlert = true;
          return true;
        }
        this.advancePointer();
        return false;
      }

      case 'give_bexp': {
        // give_bexp;amount[;party_nid]
        const bexpAmount = parseInt(args[0], 10) || 0;
        const bexpPartyNid = args[1] || undefined;
        const gbBannerFlag = !args.includes('no_banner');
        const bexpParty = game.getParty(bexpPartyNid);
        if (bexpParty) {
          game.actionLog.doAction(new GiveBexpAction(bexpAmount, bexpParty.nid));
          game.actionLog.doAction(
            new SetGameVarAction(game.gameVars, 'bexp', game.getBexp()),
          );
        }
        if (gbBannerFlag && !this.skipMode) {
          this.banner = new Banner(`Got ${bexpAmount} BEXP.`, undefined, 3000);
          this.bannerIsAlert = true;
          return true;
        }
        this.advancePointer();
        return false;
      }

      // ----- Convoy / Party commands -----

      case 'enable_convoy': {
        // enable_convoy — enables or disables convoy access
        // Sets the _convoy game variable
        game.actionLog.doAction(new SetGameVarAction(game.gameVars, '_convoy', true));
        this.advancePointer();
        return false;
      }

      case 'disable_convoy': {
        game.actionLog.doAction(new SetGameVarAction(game.gameVars, '_convoy', false));
        this.advancePointer();
        return false;
      }

      case 'change_party': {
        // change_party;unit_nid;party_nid — assigns a unit to a different party
        const cpUnitNid = args[0] ?? '';
        const cpPartyNid = args[1] ?? '';
        const cpUnit = this.findUnit(cpUnitNid);
        if (cpUnit && cpPartyNid && game.parties.has(cpPartyNid)) {
          game.actionLog.doAction(new SetUnitPartyAction(cpUnit, cpPartyNid));
        }
        this.advancePointer();
        return false;
      }

      case 'open_convoy': {
        // open_convoy — opens the convoy/supply UI (stub for now)
        // This would push a supply_items state; currently just skip
        console.warn('open_convoy: convoy UI not yet implemented');
        this.advancePointer();
        return false;
      }

      // ----- Talk management -----

      case 'add_talk': {
        // add_talk;unit1_nid;unit2_nid
        if (game.eventManager && args.length >= 2) {
          game.eventManager.addTalkPair(args[0], args[1]);
        }
        this.advancePointer();
        return false;
      }

      case 'remove_talk': {
        if (game.eventManager && args.length >= 2) {
          game.eventManager.removeTalkPair(args[0], args[1]);
        }
        this.advancePointer();
        return false;
      }

      case 'hide_talk': {
        // hide_talk;unit1_nid;unit2_nid
        if (game.eventManager && args.length >= 2) {
          game.eventManager.hideTalk(args[0], args[1]);
        }
        this.advancePointer();
        return false;
      }

      case 'unhide_talk': {
        // unhide_talk;unit1_nid;unit2_nid
        if (game.eventManager && args.length >= 2) {
          game.eventManager.unhideTalk(args[0], args[1]);
        }
        this.advancePointer();
        return false;
      }

      // ----- End turn -----

      case 'end_turn': {
        // Finish this event, then trigger a turn change
        if (this.currentEvent) this.currentEvent.finish();
        game.eventManager?.dequeueCurrentEvent();
        this.currentEvent = null;
        game.state.back();
        game.state.change('turn_change');
        return true;
      }

      // ----- Unit property modifications -----

      case 'set_name': {
        const unitNid = args[0] ?? '';
        const newName = args[1] ?? '';
        const unit = this.findUnit(unitNid);
        if (unit) game.actionLog.doAction(new SetUnitAttributeAction(unit, 'name', newName));
        this.advancePointer();
        return false;
      }

      case 'set_variant': {
        const unit = this.findUnit(args[0] ?? '');
        if (unit) game.actionLog.doAction(new SetUnitAttributeAction(unit, 'variant', args[1] || null));
        this.advancePointer();
        return false;
      }

      case 'set_unit_field': {
        const unit = this.findUnit(args[0] ?? '');
        const key = args[1] ?? '';
        const rawValue = args[2] ?? '';
        const value = args.includes('from_python')
          ? rawValue
          : evaluateExpression(rawValue, this.buildConditionContext());
        if (unit && key && value !== undefined) {
          game.actionLog.doAction(new SetUnitFieldAction(unit, key, value, args.includes('increment_mode')));
        } else if (unit && key) {
          console.warn(`Event set_unit_field: could not evaluate ${rawValue}`);
        }
        this.advancePointer();
        return false;
      }

      case 'set_unit_note': {
        const unit = this.findUnit(args[0] ?? '');
        const category = args[1] ?? '';
        if (unit && category) {
          game.actionLog.doAction(new ChangeUnitNoteAction(unit, category, args[2] ?? ''));
        }
        this.advancePointer();
        return false;
      }

      case 'remove_unit_note': {
        const unit = this.findUnit(args[0] ?? '');
        const category = args[1] ?? '';
        if (unit && category) game.actionLog.doAction(new ChangeUnitNoteAction(unit, category, null));
        this.advancePointer();
        return false;
      }

      case 'equip_item': {
        // equip_item;unit_nid;item_nid — move item to front of inventory
        const unitNid2 = args[0] ?? '';
        const itemNid = args[1] ?? '';
        const unit2 = this.findUnit(unitNid2);
        if (unit2) {
          const item = unit2.items.find((candidate: ItemObject) => candidate.nid === itemNid);
          if (item && unit2.canEquip(item)) {
            game.actionLog.doAction(new EquipItemAction(unit2, item));
          }
        }
        this.advancePointer();
        return false;
      }

      case 'set_current_mana': {
        const unitNid3 = args[0] ?? '';
        const mana = parseInt(args[1], 10);
        const unit3 = this.findUnit(unitNid3);
        if (unit3 && !isNaN(mana)) {
          const manaExpression = game.db.getEquation('MANA') ?? '0';
          const maximum = Math.max(
            0,
            Math.trunc(evaluateEquation(manaExpression, unit3, { db: game.db })),
          );
          game.actionLog.doAction(new SetCurrentManaAction(unit3, mana, maximum));
        }
        this.advancePointer();
        return false;
      }

      case 'has_traded': {
        const unitNid4 = args[0] ?? '';
        const unit4 = this.findUnit(unitNid4);
        if (unit4) game.actionLog.doAction(new HasTradedAction(unit4));
        this.advancePointer();
        return false;
      }

      case 'set_exp': {
        const unitNid5 = args[0] ?? '';
        const expVal = parseInt(args[1], 10);
        const unit5 = this.findUnit(unitNid5);
        if (unit5 && !isNaN(expVal)) {
          game.actionLog.doAction(new SetUnitExpAction(unit5, expVal));
        }
        this.advancePointer();
        return false;
      }

      case 'set_unit_level': {
        const unit = game.units.get(args[0]);
        const level = parseInt(args[1] ?? '', 10);
        if (unit && Number.isFinite(level) && level >= 1) {
          game.actionLog.doAction(new SetUnitLevelAction(unit, level));
        } else {
          console.warn(`Event set_unit_level: invalid unit or level (${args.join(';')})`);
        }
        this.advancePointer();
        return false;
      }

      case 'autolevel_to': {
        const unit = game.units.get(args[0]);
        const finalLevel = parseInt(args[1] ?? '', 10);
        const optionalArgs = args.slice(2);
        const growthMethods = new Set(['fixed', 'random', 'dynamic', 'lucky', 'bexp']);
        const growthMethod = optionalArgs.find((arg: string) => growthMethods.has(arg.toLowerCase()));
        const hidden = optionalArgs.some((arg: string) => arg.toLowerCase() === 'hidden');
        if (!unit || !Number.isFinite(finalLevel)) {
          console.warn(`Event autolevel_to: invalid unit or level (${args.join(';')})`);
          this.advancePointer();
          return false;
        }
        const currentLevel = unit.level;
        const difference = finalLevel - currentLevel;
        if (difference === 0) {
          this.advancePointer();
          return false;
        }

        const autoLevel = new AutoLevelAction(unit, difference, growthMethod);
        game.actionLog.doAction(autoLevel);
        if (!hidden) {
          game.actionLog.doAction(new SetUnitLevelAction(unit, Math.max(1, finalLevel)));
          game.eventManager?.trigger(
            {
              type: 'unit_level_up',
              levelNid: game.currentLevel?.nid ?? '',
              unitNid: unit.nid,
              unit1: unit,
              statChanges: { ...autoLevel.statChanges },
              source: 'event',
            },
            this.buildConditionContext(),
          );
        }
        this.grantAutolevelSkills(unit, currentLevel, game);
        this.advancePointer();
        return false;
      }

      case 'set_stats': {
        const unit = this.findUnit(args[0] ?? '');
        const requestedValues = this.parseNumberRecord(args[1] ?? '');
        if (!unit || Object.keys(requestedValues).length === 0) {
          this.advancePointer();
          return false;
        }
        const deltas = Object.fromEntries(
          Object.entries(requestedValues).map(([stat, value]) => [
            stat,
            value - (unit.stats[stat] ?? 0),
          ]),
        );
        const action = new ApplyStatChangesAction(unit, deltas);
        game.actionLog.doAction(action);
        const applied = action.getAppliedChanges();
        const immediate = args.some((arg: string) => arg.toLowerCase() === 'immediate');
        if (!immediate && this.startEventLevelUpPresentation(unit, applied, 'stat_change', unit.level)) {
          return true;
        }
        this.advancePointer();
        return false;
      }

      case 'change_growths':
      case 'set_growths': {
        const unit = this.findUnit(args[0] ?? '');
        const values = this.parseNumberRecord(args[1] ?? '');
        if (unit && Object.keys(values).length > 0) {
          const mode = cmd.type === 'change_growths' ? 'add' : 'set';
          game.actionLog.doAction(new ChangeUnitRecordAction(unit, 'growths', values, mode));
        }
        this.advancePointer();
        return false;
      }

      case 'change_stat_cap_modifiers':
      case 'set_stat_cap_modifiers': {
        const unit = this.findUnit(args[0] ?? '');
        const values = this.parseNumberRecord(args[1] ?? '');
        if (unit && Object.keys(values).length > 0) {
          const mode = cmd.type === 'change_stat_cap_modifiers' ? 'add' : 'set';
          game.actionLog.doAction(new ChangeUnitRecordAction(unit, 'statCapModifiers', values, mode));
        }
        this.advancePointer();
        return false;
      }

      case 'promote': {
        // promote;unit_nid;[class_nid1,class_nid2,...];[silent]
        // Silent applies the action without presentation; otherwise the shared
        // non-combat level screen presents the action's copied stat changes.
        const promoUnitNid = args[0] ?? '';
        const promoUnit = this.findUnit(promoUnitNid);
        if (promoUnit) {
          const klassListStr = args[1] ?? '';
          const isSilent = args.some((a: string) => a.toLowerCase() === 'silent');
          let klassList = klassListStr
            ? klassListStr.split(',').map((s: string) => s.trim()).filter((s: string) => s.length > 0)
            : [];

          // If no class list given, use the class's turns_into
          if (klassList.length === 0) {
            const currentKlass = game.db.classes.get(promoUnit.klass);
            if (currentKlass && currentKlass.turns_into && currentKlass.turns_into.length > 0) {
              klassList = [...currentKlass.turns_into];
            }
          }

          if (klassList.length > 0) {
            // A choice UI is not yet available in the event-command flow, so
            // preserve the existing first-option fallback.
            const newKlass = klassList[0];
            const oldLevel = promoUnit.level;
            const { statChanges } = performPromotionOrClassChange(
              promoUnit,
              newKlass,
              game,
              'promote',
            );
            this.loadMapSpriteForUnit(promoUnit, game);
            if (!isSilent && this.startEventLevelUpPresentation(
              promoUnit,
              statChanges,
              'promote',
              oldLevel,
            )) {
              return true;
            }
          } else {
            console.warn(`promote: no promotion classes available for unit "${promoUnitNid}"`);
          }
        }
        this.advancePointer();
        return false;
      }

      case 'change_class': {
        // change_class;unit_nid;[class_nid1,class_nid2,...];[silent]
        // Silent applies the action without presentation; otherwise the shared
        // non-combat level screen presents the action's copied stat changes.
        const ccUnitNid = args[0] ?? '';
        const ccUnit = this.findUnit(ccUnitNid);
        if (ccUnit) {
          const ccKlassListStr = args[1] ?? '';
          const ccIsSilent = args.some((a: string) => a.toLowerCase() === 'silent');
          let ccKlassList = ccKlassListStr
            ? ccKlassListStr.split(',').map((s: string) => s.trim()).filter((s: string) => s.length > 0)
            : [];

          // If no class list given, use the class's turns_into as a fallback
          if (ccKlassList.length === 0) {
            const currentKlass = game.db.classes.get(ccUnit.klass);
            if (currentKlass && currentKlass.turns_into && currentKlass.turns_into.length > 0) {
              ccKlassList = [...currentKlass.turns_into];
            }
          }

          if (ccKlassList.length > 0) {
            const newKlass = ccKlassList[0];
            if (newKlass !== ccUnit.klass) {
              const oldLevel = ccUnit.level;
              const { statChanges } = performPromotionOrClassChange(
                ccUnit,
                newKlass,
                game,
                'change_class',
              );
              this.loadMapSpriteForUnit(ccUnit, game);
              if (!ccIsSilent && this.startEventLevelUpPresentation(
                ccUnit,
                statChanges,
                'class_change',
                oldLevel,
              )) {
                return true;
              }
            }
          } else {
            console.warn(`change_class: no class options available for unit "${ccUnitNid}"`);
          }
        }
        this.advancePointer();
        return false;
      }

      // ----- Choice menu -----

      case 'choice': {
        // choice;header;option1,option2,option3
        const _header = args[0] ?? 'Choose';
        const optionStrs = (args[1] ?? '').split(',').map((s: string) => s.trim()).filter((s: string) => s.length > 0);
        if (optionStrs.length > 0) {
          const menuOptions: MenuOption[] = optionStrs.map((s: string) => ({
            label: s,
            value: s,
            enabled: true,
          }));
          // Center the menu on screen
          const menuX = 80;
          const menuY = 40;
          this.choiceMenu = new ChoiceMenu(menuOptions, menuX, menuY);
          return true; // block until user picks
        }
        this.advancePointer();
        return false;
      }

      case 'unchoice': {
        this.choiceResult = null;
        this.advancePointer();
        return false;
      }

      // ----- Remove all units / enemies -----

      case 'remove_all_enemies': {
        // Matches Python's remove_all_enemies: only takes units off the
        // map (action.FadeOut clears position); never deletes from the
        // unit registry. See 'remove_unit' above for rationale.
        const enemies = game.board?.getTeamUnits('enemy') ?? [];
        for (const enemy of enemies) {
          game.actionLog.doAction(new LeaveMapAction(game, enemy));
        }
        this.advancePointer();
        return false;
      }

      case 'remove_all_units': {
        // Matches Python's remove_all_units: only takes units off the map
        // (action.LeaveMap clears position); never deletes from the unit
        // registry. See 'remove_unit' above for rationale.
        const allUnits = game.board?.getAllUnits() ?? [];
        for (const unit of allUnits) {
          game.actionLog.doAction(new LeaveMapAction(game, unit));
        }
        this.advancePointer();
        return false;
      }

      // ----- Region management -----

      case 'add_region': {
        // add_region;NID;Position;Size;RegionType;SubNid;TimeLeft;flags
        // Example: add_region;MyRegion;5,6;1,1;event;Visit;only_once
        const regionNid = args[0] ?? '';
        const posStr = args[1] ?? '0,0';
        const sizeStr = args[2] ?? '1,1';
        const regionType = (args[3] ?? 'normal').toLowerCase();
        const subNid = args[4] ?? '';
        // Time left could be in args[5], flags could be scattered in remaining args
        let timeLeft: number | null = null;
        let onlyOnce = false;
        let interruptMove = false;
        let hideTime = false;
        for (let i = 5; i < args.length; i++) {
          const a = args[i].toLowerCase().trim();
          if (a === 'only_once') onlyOnce = true;
          else if (a === 'interrupt_move') interruptMove = true;
          else if (a === 'true' || a === 'false') hideTime = a === 'true';
          else {
            const n = parseInt(a, 10);
            if (!isNaN(n) && timeLeft === null) timeLeft = n;
          }
        }

        // Parse position
        const posParts = posStr.split(',').map((s: string) => parseInt(s.trim(), 10));
        const pos: [number, number] = [posParts[0] || 0, posParts[1] || 0];

        // Parse size
        const sizeParts = sizeStr.split(',').map((s: string) => parseInt(s.trim(), 10));
        const size: [number, number] = [sizeParts[0] || 1, sizeParts[1] || 1];

        // Check for duplicate NID
        if (game.currentLevel?.regions?.some((r: RegionData) => r.nid === regionNid)) {
          console.warn(`add_region: Region "${regionNid}" already exists`);
          this.advancePointer();
          return false;
        }

        const newRegion: RegionData = {
          nid: regionNid,
          region_type: regionType,
          position: pos,
          size: size,
          sub_nid: subNid,
          condition: 'True',
          time_left: timeLeft,
          only_once: onlyOnce,
          interrupt_move: interruptMove,
          hide_time: hideTime,
        };

        if (!game.currentLevel) {
          this.advancePointer();
          return false;
        }
        if (!game.currentLevel.regions) {
          game.currentLevel.regions = [];
        }
        game.actionLog.doAction(new AddRegionAction(newRegion, game.currentLevel.regions));
        this.advancePointer();
        return false;
      }

      case 'remove_region': {
        const regionNid = args[0] ?? '';
        if (game.currentLevel?.regions) {
          game.actionLog.doAction(new RemoveRegionAction(regionNid, game.currentLevel.regions));
        }
        this.advancePointer();
        return false;
      }

      case 'region_condition': {
        // region_condition;RegionNID;ConditionExpression
        const rcNid = args[0] ?? '';
        const rcCondition = args[1] ?? 'True';
        if (game.currentLevel?.regions) {
          const reg = game.currentLevel.regions.find((r: RegionData) => r.nid === rcNid);
          if (reg) {
            reg.condition = rcCondition;
          } else {
            console.warn(`region_condition: Region "${rcNid}" not found`);
          }
        }
        this.advancePointer();
        return false;
      }

      // ----- Map animations -----

      case 'map_anim': {
        // map_anim;AnimNid;Position;[Speed];[flags]
        // Position: x,y or (x,y) or UnitNid
        // flags: no_block, permanent, overlay
        const maAnimNid = args[0] ?? '';
        const maPosArg = args[1] ?? '';
        const maSpeedArg = args[2] ?? '1';
        const maFlagsStr = args.slice(3).join(';').toLowerCase();
        const maNoBlock = maFlagsStr.includes('no_block');
        const maPermanent = maFlagsStr.includes('permanent');
        const maOverlay = maFlagsStr.includes('overlay');

        const maPrefab = game.db?.mapAnimations?.get(maAnimNid);
        if (!maPrefab) {
          console.warn(`map_anim: animation "${maAnimNid}" not found`);
          this.advancePointer();
          return false;
        }

        // Parse position
        let maX = 0, maY = 0;
        const maPosMatch = maPosArg.match(/\(?(\d+),\s*(\d+)\)?/);
        if (maPosMatch) {
          maX = parseInt(maPosMatch[1], 10);
          maY = parseInt(maPosMatch[2], 10);
        } else {
          // Try as unit NID
          const maUnit = game.units.get(maPosArg);
          if (maUnit?.position) {
            maX = maUnit.position[0];
            maY = maUnit.position[1];
          }
        }

        const maSpeed = parseFloat(maSpeedArg) || 1;

        // Create animation
        const mapAnim = new MapAnimation(maPrefab, maX, maY, {
          loop: maPermanent,
          speedAdj: maSpeed,
        });

        // Load the sprite sheet asynchronously (animation starts once loaded)
        void game.resources.loadImage(`resources/animations/${maAnimNid}.png`).then((maImg: HTMLImageElement) => {
          if (maImg) mapAnim.setImage(maImg);
        }).catch(() => {
          console.warn(`map_anim: failed to load sprite sheet for "${maAnimNid}"`);
        });

        // Add to tilemap
        if (game.tilemap) {
          if (maOverlay) {
            game.tilemap.highAnimations.push(mapAnim);
          } else {
            game.tilemap.animations.push(mapAnim);
          }
        }

        this.advancePointer();
        if (maNoBlock || maPermanent) {
          return false;
        }
        // Block for animation duration
        this.waiting = true;
        this.waitTimer = mapAnim.getDuration();
        return true;
      }

      case 'remove_map_anim': {
        // remove_map_anim;AnimNid
        const rmaAnimNid = args[0] ?? '';
        if (game.tilemap) {
          game.tilemap.animations = game.tilemap.animations.filter((a: MapAnimation) => a.nid !== rmaAnimNid);
          game.tilemap.highAnimations = game.tilemap.highAnimations.filter((a: MapAnimation) => a.nid !== rmaAnimNid);
        }
        this.advancePointer();
        return false;
      }

      // ----- Tilemap commands -----

      case 'change_tilemap': {
        // change_tilemap;TilemapNid[;PositionOffset;reload]
        const tmNid = args[0] ?? '';
        if (tmNid) {
          // Async: block the event until the tilemap is loaded
          this.waiting = true;
          game.changeTilemap(tmNid).then(() => {
            this.waiting = false;
            this.advancePointer();
          });
          return true;
        }
        this.advancePointer();
        return false;
      }

      case 'show_layer': {
        // show_layer;Layer[;LayerTransition] -- LayerTransition: 'fade' (default) or 'immediate'
        const layerNid = args[0] ?? '';
        const transition = args[1] === 'immediate' ? 'immediate' : 'fade';
        if (game.tilemap) {
          game.tilemap.showLayer(layerNid, transition);
        }
        this.advancePointer();
        return false;
      }

      case 'hide_layer': {
        // hide_layer;Layer[;LayerTransition] -- LayerTransition: 'fade' (default) or 'immediate'
        const layerNid2 = args[0] ?? '';
        const transition2 = args[1] === 'immediate' ? 'immediate' : 'fade';
        if (game.tilemap) {
          game.tilemap.hideLayer(layerNid2, transition2);
        }
        this.advancePointer();
        return false;
      }

      // ----- Weather -----

      case 'add_weather': {
        // add_weather;nid
        const weatherNid = (args[0] ?? '').toLowerCase();
        if (weatherNid && game.tilemap) {
          game.tilemap.addWeather(weatherNid);
        }
        this.advancePointer();
        return false;
      }

      case 'remove_weather': {
        // remove_weather;nid
        const weatherNid2 = (args[0] ?? '').toLowerCase();
        if (weatherNid2 && game.tilemap) {
          game.tilemap.removeWeather(weatherNid2);
        }
        this.advancePointer();
        return false;
      }

      // ----- Modify game var (arithmetic) -----

      case 'modify_game_var': {
        // modify_game_var;name;expression
        const gvarName = args[0] ?? '';
        const gvarExpr = args[1] ?? '0';
        const gvarVal = parseInt(gvarExpr, 10);
        if (!isNaN(gvarVal)) {
          game.actionLog.doAction(new SetGameVarAction(game.gameVars, gvarName, gvarVal));
        }
        this.advancePointer();
        return false;
      }

      case 'modify_level_var': {
        const lvarName = args[0] ?? '';
        const lvarExpr = args[1] ?? '0';
        const lvarVal = parseInt(lvarExpr, 10);
        if (!isNaN(lvarVal)) {
          game.actionLog.doAction(new SetLevelVarAction(game.levelVars, lvarName, lvarVal));
        }
        this.advancePointer();
        return false;
      }

      // ----- For loops -----

      case 'for': {
        // for;varName;value1,value2,value3
        const forVar = args[0] ?? '_i';
        const forValues = (args[1] ?? '').split(',').map((s: string) => s.trim()).filter((s: string) => s.length > 0);
        if (forValues.length === 0) {
          // Empty loop — skip to matching endf
          const commands = this.currentEvent!.commands;
          let depth = 0;
          for (let i = this.currentEvent!.commandPointer + 1; i < commands.length; i++) {
            if (commands[i].type === 'for') depth++;
            if (commands[i].type === 'endf') {
              if (depth === 0) {
                this.currentEvent!.commandPointer = i + 1;
                return false;
              }
              depth--;
            }
          }
          this.currentEvent!.commandPointer = this.currentEvent!.commands.length;
          return false;
        }
        // Push loop context and set first value
        this.forLoopStack.push({
          varName: forVar,
          values: forValues,
          currentIndex: 0,
          startPointer: this.currentEvent!.commandPointer + 1,
        });
        game.actionLog.doAction(new SetGameVarAction(game.gameVars, forVar, forValues[0]));
        this.advancePointer();
        return false;
      }

      case 'endf': {
        const loopCtx = this.forLoopStack[this.forLoopStack.length - 1];
        if (loopCtx) {
          loopCtx.currentIndex++;
          if (loopCtx.currentIndex < loopCtx.values.length) {
            // Set next value and jump back to loop start
            game.actionLog.doAction(
              new SetGameVarAction(game.gameVars, loopCtx.varName, loopCtx.values[loopCtx.currentIndex]),
            );
            this.currentEvent!.commandPointer = loopCtx.startPointer;
            return false;
          } else {
            // Loop complete — pop and advance past endf
            this.forLoopStack.pop();
            this.advancePointer();
            return false;
          }
        }
        this.advancePointer();
        return false;
      }

      // ----- Portrait commands -----
      case 'add_portrait': {
        // add_portrait;PortraitNid;ScreenPosition;[Slide];[ExpressionList]
        // flags (in args): mirror, immediate, no_block, low_priority, low_saturation
        const portraitNid = args[0] ?? '';
        const positionStr = args[1] ?? 'Left';
        // Remaining args may be slide, expressions, or flags
        const extraArgs = args.slice(2).map(s => s.toLowerCase().trim());
        const knownFlags = new Set(['mirror', 'immediate', 'no_block', 'low_priority', 'low_saturation']);

        // Separate flags from positional args
        const pFlags = extraArgs.filter(a => knownFlags.has(a));
        const pArgs = extraArgs.filter(a => !knownFlags.has(a));

        const slideArg = pArgs[0] ?? '';
        const expressionArg = pArgs[1] ?? '';
        const parsedSpeedMult = parseFloat(pArgs[2] ?? '');
        const speedMult = Number.isFinite(parsedSpeedMult) && parsedSpeedMult > 0
          ? parsedSpeedMult
          : 1;

        if (!portraitNid) {
          this.advancePointer();
          return false;
        }

        // Resolve portrait NID: try unit portrait_nid first, then direct
        const game = getGame();
        let resolvedNid = portraitNid;
        const unitPrefab = game.db?.units.get(portraitNid);
        if (unitPrefab && unitPrefab.portrait_nid) {
          resolvedNid = unitPrefab.portrait_nid;
        }

        // Get portrait metadata
        const portraitMeta = game.db?.portraits.get(resolvedNid);
        const blinkOffset: [number, number] = portraitMeta?.blinking_offset ?? [24, 32];
        const smileOffset: [number, number] = portraitMeta?.smiling_offset ?? [16, 48];

        // Parse position
        const { position: pos, mirror: autoMirror } = parseScreenPosition(positionStr);

        // Parse slide
        const slide: 'left' | 'right' | null =
          slideArg === 'left' ? 'left' :
          slideArg === 'right' ? 'right' : null;

        // Parse expressions
        const expressions = expressionArg
          ? expressionArg.split(',').map(s => s.trim()).filter(Boolean)
          : [];

        // Check flags
        const isMirror = pFlags.includes('mirror') ? !autoMirror : autoMirror;
        const immediate = pFlags.includes('immediate') || this.skipMode;
        const lowPriority = pFlags.includes('low_priority');
        const blocks = !immediate && !pFlags.includes('no_block');

        let priority = this.portraitPriorityCounter++;
        if (lowPriority) priority -= 1000;

        // Load portrait image asynchronously. Block command processing until
        // the image is ready — in the original Python engine, image loads are
        // synchronous, so the portrait is always available when subsequent
        // commands (e.g. speak) execute.
        this.pendingPortraitLoads++;
        game.resources.loadPortrait(resolvedNid).then((image: HTMLImageElement) => {
          const portrait = new EventPortrait(
            image,
            blinkOffset,
            smileOffset,
            pos,
            priority,
            portraitNid, // Use original NID as the name key
            {
              transition: !immediate,
              slide,
              mirror: isMirror,
              expressions,
              speedMult,
            },
          );
          this.portraits.set(portraitNid, portrait);
          this.pendingPortraitLoads--;
          if (blocks) {
            this.waiting = true;
            this.waitTimer = (14 * FRAMETIME) / speedMult + 33;
          }
        }).catch(() => {
          console.warn(`EventState: failed to load portrait "${resolvedNid}"`);
          this.pendingPortraitLoads--;
          if (blocks) {
            this.advancePointer();
          }
        });

        if (!blocks) {
          this.advancePointer();
        }
        // Always break the burst while the synchronous-reference portrait load
        // is emulated asynchronously. Blocking transitions advance via waitTimer.
        return true;
      }

      case 'multi_add_portrait': {
        // multi_add_portrait;P1;Pos1;P2;Pos2;[P3;Pos3;P4;Pos4]
        // Process pairs of (portrait, position)
        for (let i = 0; i + 1 < args.length; i += 2) {
          const pNid = args[i] ?? '';
          const pPos = args[i + 1] ?? 'Left';
          if (!pNid) continue;

          const game = getGame();
          let resolvedNid = pNid;
          const unitPrefab = game.db?.units.get(pNid);
          if (unitPrefab && unitPrefab.portrait_nid) {
            resolvedNid = unitPrefab.portrait_nid;
          }
          const portraitMeta = game.db?.portraits.get(resolvedNid);
          const blinkOffset: [number, number] = portraitMeta?.blinking_offset ?? [24, 32];
          const smileOffset: [number, number] = portraitMeta?.smiling_offset ?? [16, 48];
          const { position: pos, mirror: autoMirror } = parseScreenPosition(pPos);
          const priority = this.portraitPriorityCounter++;

          this.pendingPortraitLoads++;
          game.resources.loadPortrait(resolvedNid).then((image: HTMLImageElement) => {
            const portrait = new EventPortrait(
              image, blinkOffset, smileOffset, pos, priority, pNid,
              { transition: true, mirror: autoMirror },
            );
            this.portraits.set(pNid, portrait);
            this.pendingPortraitLoads--;
          }).catch(() => {
            console.warn(`EventState: failed to load portrait "${resolvedNid}"`);
            this.pendingPortraitLoads--;
          });
        }
        this.advancePointer();
        return true; // Block burst until all portrait images are loaded
      }

      case 'remove_portrait': {
        // remove_portrait;PortraitNid;[SpeedMult];[Slide];[flags]
        const removeNid = args[0] ?? '';
        const removeExtraArgs = args.slice(1).map(s => s.toLowerCase().trim());
        const removeImmediate = removeExtraArgs.includes('immediate') || this.skipMode;
        const removeNoBlock = removeExtraArgs.includes('no_block');
        const speedMultStr = removeExtraArgs.find(a => !isNaN(parseFloat(a)));
        const speedMult = Math.max(0.001, speedMultStr ? parseFloat(speedMultStr) : 1);
        const removeSlide = removeExtraArgs.find(a => a === 'left' || a === 'right') as 'left' | 'right' | undefined;

        const portrait = this.portraits.get(removeNid);
        if (!portrait) {
          this.advancePointer();
          return false;
        }
        if (removeImmediate) {
          this.portraits.delete(removeNid);
        } else {
          portrait.end(speedMult, removeSlide);
        }
        if (!removeImmediate && !removeNoBlock) {
          this.waiting = true;
          this.waitTimer = (14 * FRAMETIME) / speedMult + 33;
          return true;
        }
        this.advancePointer();
        return false;
      }

      case 'multi_remove_portrait': {
        // multi_remove_portrait;P1;P2;...[;immediate]
        const mrExtraArgs = args.map(s => s.toLowerCase().trim());
        const mrImmediate = mrExtraArgs.includes('immediate');
        const mrNids = args.filter(a => a.toLowerCase().trim() !== 'immediate');
        for (const nid of mrNids) {
          const portrait = this.portraits.get(nid);
          if (portrait) {
            if (mrImmediate) {
              this.portraits.delete(nid);
            } else {
              portrait.end();
            }
          }
        }
        this.advancePointer();
        return false;
      }

      case 'remove_all_portraits': {
        const rapImmediate = args.some(a => a.toLowerCase().trim() === 'immediate');
        if (rapImmediate) {
          this.portraits.clear();
        } else {
          for (const portrait of this.portraits.values()) {
            portrait.end();
          }
        }
        this.advancePointer();
        return false;
      }

      case 'move_portrait': {
        // move_portrait;PortraitNid;ScreenPosition;[SpeedMult];[flags]
        const moveNid = args[0] ?? '';
        const movePos = args[1] ?? 'Left';
        const moveExtraArgs = args.slice(2).map(a => a.toLowerCase().trim());
        const moveImmediate = moveExtraArgs.includes('immediate') || this.skipMode;
        const moveNoBlock = moveExtraArgs.includes('no_block');
        const parsedMoveSpeed = parseFloat(args[2] ?? '');
        const moveSpeed = Number.isFinite(parsedMoveSpeed) && parsedMoveSpeed > 0
          ? parsedMoveSpeed
          : 1;

        const portrait = this.portraits.get(moveNid);
        if (!portrait) {
          this.advancePointer();
          return false;
        }
        const { position: newPos } = parseScreenPosition(movePos);
        if (moveImmediate) {
          portrait.quickMove(newPos);
        } else {
          const travelTime = portrait.move(newPos, moveSpeed);
          if (!moveNoBlock) {
            this.waiting = true;
            this.waitTimer = travelTime + 66;
            return true;
          }
        }
        this.advancePointer();
        return false;
      }

      case 'bop':           // short alias
      case 'bop_portrait': {
        // bop_portrait;PortraitNid;[NumBops];[Time];[flags]
        const bopNid = args[0] ?? '';
        const numBops = parseInt(args[1], 10) || 2;
        const bopTime = parseInt(args[2], 10) || 8 * FRAMETIME;
        const bopNoBlock = args.some(arg => arg.toLowerCase().trim() === 'no_block');

        const portrait = this.portraits.get(bopNid);
        if (!portrait) {
          this.advancePointer();
          return false;
        }
        portrait.bop(numBops, 2, bopTime);
        if (!bopNoBlock) {
          this.waiting = true;
          this.waitTimer = (2 * numBops + 1) * bopTime;
          return true;
        }
        this.advancePointer();
        return false;
      }

      case 'mirror_portrait': {
        // mirror_portrait;PortraitNid;[SpeedMult];[flags]
        const mirrorNid = args[0] ?? '';
        const portrait = this.portraits.get(mirrorNid);
        if (!portrait) {
          this.advancePointer();
          return false;
        }
        const parsedMirrorSpeed = parseFloat(args[1] ?? '');
        const mirrorSpeed = Number.isFinite(parsedMirrorSpeed) && parsedMirrorSpeed > 0
          ? parsedMirrorSpeed
          : 1;
        portrait.mirror = !portrait.mirror;
        if (!this.skipMode && !args.some(arg => arg.toLowerCase().trim() === 'no_block')) {
          this.waiting = true;
          this.waitTimer = (14 * FRAMETIME) / mirrorSpeed + 33;
          return true;
        }
        this.advancePointer();
        return false;
      }

      case 'expression': {
        // expression;PortraitNid;ExpressionList (comma-separated)
        const exprNid = args[0] ?? '';
        const exprList = args[1] ?? '';
        const portrait = this.portraits.get(exprNid);
        if (portrait) {
          const exprs = exprList.split(',').map(s => s.trim()).filter(Boolean);
          portrait.setExpressions(exprs);
        }
        this.advancePointer();
        return false;
      }

      // ----- Background -----
      case 'change_background': {
        // change_background;[PanoramaNid];[keep_portraits];[scroll]
        // No panorama arg = remove background
        const bgKnownFlags = new Set(['keep_portraits', 'scroll']);
        const bgFlagSet = new Set<string>();
        let bgNid: string | null = null;

        for (const a of args) {
          const lower = a.trim().toLowerCase();
          if (bgKnownFlags.has(lower)) {
            bgFlagSet.add(lower);
          } else if (a.trim() && !bgNid) {
            bgNid = a.trim(); // Keep original case for the panorama NID
          }
        }

        if (!bgNid) {
          // Remove background
          this.background = null;
          this.pendingBackgroundLoad = false;
          this.backgroundLoadDone = false;
          this.backgroundLoadToken++;
          if (!bgFlagSet.has('keep_portraits')) {
            this.portraits.clear();
          }
          this.advancePointer();
          return false;
        } else {
          // Load panorama image asynchronously and block command progression
          // until the load resolves to match Python's synchronous semantics.
          const game = getGame();
          const panoramaNid = bgNid;
          const token = ++this.backgroundLoadToken;
          this.pendingBackgroundLoad = true;
          this.backgroundLoadDone = false;

          const resourcePromise = game.resourceManager?.loadPanorama(panoramaNid);
          if (!resourcePromise) {
            this.backgroundLoadDone = true;
          } else {
            resourcePromise.then((img: HTMLImageElement) => {
              if (this.backgroundLoadToken === token) {
                this.background = img;
              }
            }).catch(() => {
              console.warn(`EventState: panorama "${panoramaNid}" not found`);
              if (this.backgroundLoadToken === token) {
                this.background = null;
              }
            }).finally(() => {
              if (this.backgroundLoadToken === token) {
                this.backgroundLoadDone = true;
              }
            });
          }
        }

        // By default, change_background clears all portraits
        if (!bgFlagSet.has('keep_portraits')) {
          this.portraits.clear();
        }

        return true;
      }

      // ----- Chapter Title -----
      case 'chapter_title': {
        // chapter_title;[Music];[CustomTitle]
        const ctMusic = args[0]?.trim() || null;
        const ctTitle = args[1]?.trim() || null;

        // Start music if specified
        if (ctMusic) {
          const game = getGame();
          game.audioManager?.playMusic(ctMusic);
        }

        // Determine title text
        const game2 = getGame();
        this.chapterTitleText = ctTitle || game2.currentLevel?.name || 'Chapter';
        this.chapterTitlePhase = 'fade_in';
        this.chapterTitleTimer = 0;

        // Disable skip mode (player must watch or manually skip)
        this.skipMode = false;

        // Blocking — don't advance pointer; the update loop handles it
        return true;
      }

      // ----- Location Card -----
      case 'location_card': {
        // location_card;Text
        const lcText = args[0]?.trim() || '';
        this.locationCard = {
          text: lcText,
          timer: 0,
          phase: 'fade_in',
          alpha: 0,
        };
        // Block for the fade_in + hold duration. The wait timer mechanism
        // will advance the pointer when done.
        this.waiting = true;
        this.waitTimer = 2200; // 200ms fade in + 2000ms hold
        return true;
      }

      // ----- Has Visited (marks unit as having completed an action) -----
      case 'has_visited': {
        // has_visited;UnitNid;[attacked]
        const hvUnitNid = args[0]?.trim() ?? '';
        const hvFlags = args.slice(1).map(a => a.trim().toLowerCase());
        const hvUnit = this.findUnit(hvUnitNid);
        if (hvUnit) {
          if (hvFlags.includes('attacked')) {
            game.actionLog.doAction(new HasAttackedAction(hvUnit));
          } else {
            game.actionLog.doAction(new HasTradedAction(hvUnit));
          }
          if (!hvUnit.hasCanto) {
            game.actionLog.doAction(new WaitAction(hvUnit));
          }
        }
        this.advancePointer();
        return false;
      }

      // ----- Unlock (simplified: consume a key/lockpick use) -----
      case 'unlock':
      case 'find_unlock':
      case 'spend_unlock': {
        // unlock;UnitNid — in the full Python engine, this is a complex macro.
        // Simplified: find the first item with 'unlock' component, decrement its uses.
        const unlockUnitNid = args[0]?.trim() ?? '';
        const unlockUnit = this.findUnit(unlockUnitNid);
        if (unlockUnit) {
          // Find first item that can unlock (has 'unlock' or 'key' component)
          const keyItem = unlockUnit.items.find(item => {
            for (const [compName] of item.components) {
              if (compName === 'unlock' || compName === 'Unlock' ||
                  compName === 'keys' || compName === 'Keys' ||
                  compName === 'can_unlock') return true;
            }
            return false;
          });
          if (keyItem && keyItem.uses !== undefined && keyItem.uses > 0) {
            game.actionLog.doAction(new WeaponUsesAction(keyItem, unlockUnit));
            if ((keyItem.uses ?? 0) <= 0) {
              game.actionLog.doAction(new RemoveItemFromUnitAction(unlockUnit, keyItem));
            }
          }
          // If no key item, check for Locktouch skill (no item consumed)
          // Already handled implicitly — if no key found, nothing happens
        }
        this.advancePointer();
        return false;
      }

      // ----- Interact Unit (scripted combat) -----
      case 'interact_unit': {
        // interact_unit;AttackerNid;TargetNidOrPos;CombatScript;Ability;flags
        // e.g. interact_unit;Eirika;Boss;hit1,crit1,end;Rapier
        // CombatScript: comma-separated tokens (hit1,hit2,crit1,crit2,miss1,miss2,--,end)
        // flags: immediate, force_animation, force_no_animation
        const iuAttackerNid = args[0] ?? '';
        const iuTargetArg = args[1] ?? '';
        const iuScriptStr = args[2] ?? '';
        const iuAbilityNid = args[3] ?? '';
        const iuFlagsStr = args.slice(4).join(';').toLowerCase();
        const iuImmediate = iuFlagsStr.includes('immediate');

        // Resolve attacker
        const iuAttacker = game.units.get(iuAttackerNid) ?? null;
        if (!iuAttacker) {
          console.warn(`interact_unit: attacker "${iuAttackerNid}" not found`);
          this.advancePointer();
          return false;
        }

        // Resolve defender - try unit NID first, then position
        let iuDefender: UnitObject | null = null;
        iuDefender = game.units.get(iuTargetArg) ?? null;
        if (!iuDefender) {
          // Try parsing as position (x,y)
          const posMatch = iuTargetArg.match(/\(?(\d+),\s*(\d+)\)?/);
          if (posMatch && game.board) {
            const tx = parseInt(posMatch[1], 10);
            const ty = parseInt(posMatch[2], 10);
            iuDefender = game.board.getUnit(tx, ty);
          }
        }
        if (!iuDefender) {
          console.warn(`interact_unit: target "${iuTargetArg}" not found`);
          this.advancePointer();
          return false;
        }

        // Parse combat script
        const iuScript = iuScriptStr
          ? iuScriptStr.split(',').map((t: string) => t.trim().toLowerCase())
          : null;

        // Resolve ability/item — equip specified weapon if provided
        let iuAbilityItem: ItemObject | null = null;
        if (iuAbilityNid) {
          let abilityItem = iuAttacker.items.find(
            (i: ItemObject) => i.nid === iuAbilityNid || i.name === iuAbilityNid,
          );
          if (!abilityItem && game.db) {
            // Create a temporary item from the DB
            const itemPrefab = game.db.items?.get(iuAbilityNid);
            if (itemPrefab) {
              abilityItem = new ItemObjectClass(itemPrefab);
              game.actionLog.doAction(new GiveItemAction(iuAttacker, abilityItem));
            }
          }
          if (abilityItem) {
            iuAbilityItem = abilityItem;
            // Move to front of inventory (equip)
            game.actionLog.doAction(new BringToTopItemAction(iuAttacker, abilityItem));
            if (iuAttacker.canEquip(abilityItem)) {
              game.actionLog.doAction(new EquipItemAction(iuAttacker, abilityItem));
            }
          }
        }

        // Set up combat through CombatState
        game.selectedUnit = iuAttacker;
        game.combatTarget = iuDefender;
        game.combatScript = iuScript;
        game.eventCombat = true;  // Flag so CombatState doesn't double-push EventState
        if (iuAbilityItem && !iuAbilityItem.isWeapon()) {
          game.memory.set('combat_item', iuAbilityItem);
        }

        if (iuImmediate) {
          // Immediate mode: resolve combat without visual animation
          const attackItem = iuAbilityItem ?? iuAttacker.items.find((i: ItemObject) => i.isWeapon());
          if (attackItem) {
            const targetGroup = resolveCombatTargetGroup(game, iuAttacker, attackItem, iuDefender);
            const grouped = !targetGroup.mainDefender || targetGroup.splashDefenders.length > 0;
            const defItem = targetGroup.mainDefender
              ? targetGroup.mainDefender.items.find((i: ItemObject) => i.isWeapon()) ?? null
              : null;
            const rngMode2 = game.db.getConstant('rng_mode', 'true_hit') as any;
            const mc = new MapCombat(
              iuAttacker, attackItem, targetGroup.representative, defItem,
              game.db, rngMode2, game.board, iuScript,
              grouped ? {
                mainDefender: targetGroup.mainDefender,
                splashDefenders: targetGroup.splashDefenders,
              } : undefined,
              game,
            );
            // Run combat to completion instantly
            while (mc.state !== 'done') {
              mc.update(16);
            }
            const initiatedPartner = iuAttacker.strikePartner;
            queueAfterInitiatedCombatEvents(
              game,
              iuAttacker,
              targetGroup.representative,
              attackItem,
              defItem,
              'attack',
            );
            if (initiatedPartner) {
              queueAfterInitiatedCombatEvents(
                game,
                initiatedPartner,
                targetGroup.representative,
                attackItem,
                defItem,
                'attack',
              );
            }
            const results = mc.applyResults(game.actionLog);
            applyCombatItemEndHooks(game, mc.strikes);
            queueCombatItemEvents(game, mc.strikes);
            // Handle deaths
            for (const deadDefender of results.defenderDeaths ??
              (results.defenderDead ? [targetGroup.representative] : [])) {
              game.actionLog.doAction(new DeathAction(deadDefender, game.board, game.initiative));
            }
            if (results.attackerDead && game.board) {
              game.actionLog.doAction(new DeathAction(iuAttacker, game.board, game.initiative));
            }
          }
          game.memory.delete('combat_item');
          game.combatScript = null;
          game.eventCombat = false;
          this.advancePointer();
          return false;
        } else {
          // Push combat state — event pauses until combat completes
          game.state.change('combat');
          this.advancePointer();
          return true; // Block until combat state completes
        }
      }

      // ----- Load unit into memory (doesn't place on map) -----
      case 'load_unit': {
        // load_unit;UniqueUnitNID;Team;AI
        const luNid = args[0] ?? '';
        const luTeam = args[1] || 'player';
        const luAi = args[2] || 'None';
        if (game.units.has(luNid)) {
          console.warn(`load_unit: Unit "${luNid}" already exists`);
          this.advancePointer();
          return false;
        }
        const luPrefab = game.db?.units?.get(luNid);
        if (!luPrefab) {
          console.warn(`load_unit: Unit prefab "${luNid}" not found in db`);
          this.advancePointer();
          return false;
        }
        // Spawn into memory with no position (doesn't place on map)
        const luUnit = game.spawnUnit(luPrefab, luTeam, null, luAi);
        this.loadMapSpriteForUnit(luUnit, game);
        this.advancePointer();
        return false;
      }

      case 'make_generic': {
        // make_generic;NID;Klass;Level;Team;AI;Faction;AnimVariant;ItemList
        let mgNid = args[0] ?? '';
        const mgKlass = args[1] ?? '';
        const mgLevel = parseInt(args[2], 10) || 1;
        const mgTeam = args[3] || 'player';
        const mgAi = args[4] || 'None';
        // args[5] = faction (ignored for now)
        const mgVariant = args[6] || '';
        // args[7] = comma-separated item list
        const mgItemStr = args[7] ?? '';
        const mgItems: [string, boolean][] = mgItemStr
          ? mgItemStr.split(',').map((s: string) => [s.trim(), false] as [string, boolean])
          : [];

        // Auto-generate NID if empty
        if (!mgNid) {
          let counter = 201;
          while (game.units.has(String(counter))) counter++;
          mgNid = String(counter);
        } else if (game.units.has(mgNid)) {
          console.warn(`make_generic: Unit "${mgNid}" already exists`);
          this.advancePointer();
          return false;
        }

        const mgKlassDef = game.db?.classes?.get(mgKlass);
        if (!mgKlassDef) {
          console.warn(`make_generic: Class "${mgKlass}" not found in db`);
          this.advancePointer();
          return false;
        }

        // Build synthetic GenericUnitData and spawn
        const mgData: any = {
          nid: mgNid,
          variant: mgVariant || null,
          level: mgLevel,
          klass: mgKlass,
          faction: args[5] || '',
          starting_items: mgItems,
          starting_skills: [],
          team: mgTeam,
          ai: mgAi,
          ai_group: null,
          starting_position: null,
          generic: true,
        };
        game.spawnGenericUnit(mgData);
        const mgUnit = game.units.get(mgNid);
        if (mgUnit) {
          game.actionLog.doAction(new CreateUnitAction(game, mgUnit, null));
          this.loadMapSpriteForUnit(mgUnit, game);
        }
        this.advancePointer();
        return false;
      }

      // ----- Shop -----
      case 'shop': {
        // shop;UnitNid;Item1,Item2,...;[Flavor];[Stock1,Stock2,...];[ShopId];[preview]
        const shopUnitNid = args[0] ?? '';
        const shopItemsStr = args[1] ?? '';
        const shopFlavor = args[2] ?? 'armory';
        const shopStockStr = args[3] ?? '';
        const shopId = args[4] ?? '';
        const shopFlags = args.slice(5).join(';').toLowerCase();
        const shopPreview = shopFlags.includes('preview');

        // Resolve unit
        let shopUnit = game.units.get(shopUnitNid) ?? null;
        if (!shopUnit && shopUnitNid === '{unit}') {
          shopUnit = game.selectedUnit;
        }
        if (!shopUnit) {
          console.warn(`shop: unit "${shopUnitNid}" not found`);
          this.advancePointer();
          return false;
        }

        // Create item objects from NID list
        const shopItemNids = shopItemsStr.split(',').map((s: string) => s.trim()).filter(Boolean);
        const shopItems: ItemObject[] = [];
        for (const itemNid of shopItemNids) {
          const prefab = game.db?.items?.get(itemNid);
          if (prefab) {
            shopItems.push(new ItemObjectClass(prefab));
          } else {
            console.warn(`shop: item "${itemNid}" not found in db`);
          }
        }

        if (shopItems.length === 0) {
          console.warn('shop: no valid items');
          this.advancePointer();
          return false;
        }

        // Parse stock list
        let shopStock: number[] = shopItems.map(() => -1);
        if (shopStockStr) {
          const stockParts = shopStockStr.split(',').map((s: string) => parseInt(s.trim(), 10));
          for (let si = 0; si < shopItems.length && si < stockParts.length; si++) {
            if (!isNaN(stockParts[si])) {
              shopStock[si] = stockParts[si];
            }
          }
          // Adjust for persistent stock tracking
          if (shopId) {
            for (let si = 0; si < shopItems.length; si++) {
              if (shopStock[si] > 0) {
                const boughtKey = `__shop_${shopId}_${shopItems[si].nid}`;
                const bought = Number(game.gameVars.get(boughtKey) ?? 0);
                shopStock[si] = Math.max(0, shopStock[si] - bought);
              }
            }
          }
        }

        // Set up transient data for ShopState
        game.shopUnit = shopUnit;
        game.shopItems = shopItems;
        game.shopStock = shopStock;
        game.shopId = shopId || null;

        // Push shop state
        game.state.change('shop');
        this.advancePointer();
        return true; // Block until shop closes
      }

      case 'hide_combat_ui':
      case 'show_combat_ui':
      case 'pause_background':
      case 'unpause_background':
        // Visual/UI commands — skip for now to allow event progression
        this.advancePointer();
        return false;

      // ----- Preparation / Base (stubs) -----

      case 'prep': {
        // prep — opens preparations screen
        // args[0]: pick units enabled ('True'/'False'), default True
        // args[1]: music track to play during prep
        const pickEnabled = args[0] !== 'False' && args[0] !== 'false';
        game.actionLog.doAction(new SetLevelVarAction(game.levelVars, '_prep_pick', pickEnabled));

        if (args[1]) {
          void game.audioManager.playMusic(args[1]);
        }

        // Advance pointer before pushing — when prep exits (back()),
        // the EventState resumes and processes the next command.
        this.advancePointer();
        game.state.change('prep_main');
        return true; // Block until prep closes
      }

      case 'base': {
        // base — opens base/camp screen with panorama background and menu.
        // args: [background, music, other_options, options_enabled, options_events]
        const baseBg = args[0] || '';
        const baseMusic = args[1] || '';
        if (baseBg) {
          game.actionLog.doAction(new SetGameVarAction(game.gameVars, '_base_bg_name', baseBg));
        }
        if (baseMusic) {
          game.actionLog.doAction(new SetGameVarAction(game.gameVars, '_base_music', baseMusic));
        }
        // Check for show_map flag
        if (args[0] === 'show_map' || args[0] === 'True') {
          game.actionLog.doAction(new SetGameVarAction(game.gameVars, '_base_transparent', true));
        }
        this.advancePointer();
        game.state.change('base_main');
        return true; // Block until base closes
      }

      // ----- Overworld commands -----

      case 'toggle_narration_mode': {
        // Narration mode toggle — visual-only, currently a no-op
        this.advancePointer();
        return false;
      }

      case 'overworld_cinematic': {
        // Set up overworld as a background for cutscenes
        // args[0] = overworld NID (optional, uses first if omitted)
        // The OverworldManager is imported lazily to avoid circular deps
        if (game.db.overworlds.size > 0) {
          const owNid = args[0] || null;
          let prefab = null;
          if (owNid) {
            prefab = game.db.overworlds.get(owNid);
          } else {
            prefab = game.db.overworlds.values().next().value ?? null;
          }
          if (prefab && !game.overworldController) {
            // Store the prefab NID so the overworld state can pick it up
            game.actionLog.doAction(
              new SetGameVarAction(game.gameVars, '_overworld_cinematic_nid', prefab.nid),
            );
          }
        }
        this.advancePointer();
        return false;
      }

      case 'reveal_overworld_node': {
        const nodeNid = args[0];
        if (nodeNid && game.overworldController) {
          game.actionLog.doAction(
            new EnableOverworldElementAction(game.overworldController.enabledNodes, nodeNid),
          );
          const immediate = args.some(arg => arg.toLowerCase().trim() === 'immediate');
          if (!immediate && !this.skipMode) {
            this.waiting = true;
            this.waitTimer = 500;
            return true;
          }
        }
        this.advancePointer();
        return false;
      }

      case 'reveal_overworld_road': {
        const [node1, node2] = args;
        const owCtrl = game.overworldController;
        const road = node1 && node2 && owCtrl
          ? [...owCtrl.roads.values()].find((candidate: any) =>
              (candidate.node1 === node1 && candidate.node2 === node2) ||
              (candidate.node1 === node2 && candidate.node2 === node1))
          : null;
        if (road) {
          game.actionLog.doAction(
            new EnableOverworldElementAction(owCtrl.enabledRoads, road.nid),
          );
          const immediate = args.some(arg => arg.toLowerCase().trim() === 'immediate');
          if (!immediate && !this.skipMode) {
            this.waiting = true;
            this.waitTimer = 500;
            return true;
          }
        }
        this.advancePointer();
        return false;
      }

      case 'overworld_move_unit': {
        // args[0] = entity NID, args[1] = target node NID
        // This is non-blocking when no overworld controller exists
        const entityNid = args[0];
        const targetNodeNid = args[1];
        const owCtrl = game.overworldController;
        if (entityNid && targetNodeNid && owCtrl) {
          const entity = owCtrl.entities.get(entityNid);
          if (entity && entity.onNode) {
            const pathPoints = owCtrl.getPathPoints(entity.onNode, targetNodeNid);
            if (pathPoints && pathPoints.length >= 2 && game.overworldMovement) {
              game.overworldMovement.beginMove(entity, pathPoints, {
                follow: true,
                callback: () => {
                  game.actionLog.doAction(
                    new MoveOverworldEntityAction(owCtrl, entityNid, targetNodeNid),
                  );
                },
              });
              this.advancePointer();
              const noBlock = args.some(arg => arg.toLowerCase().trim() === 'no_block');
              return !noBlock;
            } else {
              // No path or no movement manager — instant move
              game.actionLog.doAction(
                new MoveOverworldEntityAction(owCtrl, entityNid, targetNodeNid),
              );
            }
          }
        }
        this.advancePointer();
        return false;
      }

      case 'set_overworld_position': {
        // args[0] = entity NID, args[1] = node NID or "x,y"
        const entityNid = args[0];
        const posArg = args[1];
        const owCtrl = game.overworldController;
        if (entityNid && posArg && owCtrl) {
          const node = owCtrl.getNode(posArg);
          if (node) {
            game.actionLog.doAction(new MoveOverworldEntityAction(owCtrl, entityNid, posArg));
          } else {
            // Try x,y format
            const coords = posArg.split(',');
            if (coords.length === 2) {
              const x = parseInt(coords[0], 10);
              const y = parseInt(coords[1], 10);
              const entity = owCtrl.entities.get(entityNid);
              if (entity && !isNaN(x) && !isNaN(y)) {
                game.actionLog.doAction(new MoveOverworldEntityAction(owCtrl, entityNid, [x, y]));
              }
            }
          }
        }
        this.advancePointer();
        return false;
      }

      case 'create_overworld_entity': {
        // Python: create_overworld_entity;Nid;[Unit];[Team], or delete via flag.
        const owCtrl = game.overworldController;
        const eNid = args[0];
        if (owCtrl && eNid) {
          const deleteEntity = args.some(arg => arg.toLowerCase().trim() === 'delete');
          if (deleteEntity) {
            if (owCtrl.entities.has(eNid)) {
              game.actionLog.doAction(new RemoveOverworldEntityAction(owCtrl, eNid));
            }
          } else {
            const unitNid = args[1];
            const requestedTeam = args[2] || 'player';
            const team = game.db.teams?.has?.(requestedTeam) ? requestedTeam : 'player';
            const unitExists = unitNid &&
              (game.units.has(unitNid) || game.db.units?.has?.(unitNid));
            if (unitExists && !owCtrl.entities.has(eNid)) {
              game.actionLog.doAction(
                new CreateOverworldEntityAction(owCtrl, eNid, 'unit', unitNid, team, null),
              );
            }
          }
        }
        this.advancePointer();
        return false;
      }

      case 'disable_overworld_entity': {
        // Python disables the entity on-map without deleting its identity.
        const owCtrl = game.overworldController;
        const entity = args[0] ? owCtrl?.entities.get(args[0]) : null;
        if (entity) {
          game.actionLog.doAction(new DisableOverworldEntityAction(entity));
        }
        this.advancePointer();
        return false;
      }

      case 'set_overworld_menu_option_enabled': {
        // args[0] = node NID, args[1] = option NID, args[2] = 'True'/'False'
        const owCtrl = game.overworldController;
        if (owCtrl && args[0] && args[1]) {
          const enabled = args[2] !== 'False' && args[2] !== 'false';
          const options = owCtrl.enabledMenuOptions.get(args[0]);
          if (options) {
            game.actionLog.doAction(new SetOverworldMenuOptionAction(options, args[1], enabled));
          }
        }
        this.advancePointer();
        return false;
      }

      case 'set_overworld_menu_option_visible': {
        // args[0] = node NID, args[1] = option NID, args[2] = 'True'/'False'
        const owCtrl = game.overworldController;
        if (owCtrl && args[0] && args[1]) {
          const visible = args[2] !== 'False' && args[2] !== 'false';
          const options = owCtrl.visibleMenuOptions.get(args[0]);
          if (options) {
            game.actionLog.doAction(new SetOverworldMenuOptionAction(options, args[1], visible));
          }
        }
        this.advancePointer();
        return false;
      }

      case 'enter_level_from_overworld': {
        // args[0] = level NID (optional — uses node's level if omitted)
        const owCtrl = game.overworldController;
        if (owCtrl) {
          const levelNid = args[0] || owCtrl.nextLevel;
          if (levelNid) {
            game.actionLog.doAction(new SetGameVarAction(game.gameVars, '_overworld_level', levelNid));
            game.state.change('overworld_level_transition');
            this.advancePointer();
            return true; // Block until level transition completes
          }
        }
        this.advancePointer();
        return false;
      }

      // ----- Arena / overlay (stubs) -----

      // ----- Base screen event commands -----
      case 'add_base_convo':
      case 'ignore_base_convo':
      case 'remove_base_convo':
      case 'add_market_item':
      case 'remove_market_item':
      case 'clear_market_items': {
        handleBaseEventCommand(cmd.type, args, game);
        this.advancePointer();
        return false;
      }

      // ----- Victory / Credits event commands -----
      case 'victory_screen': {
        this.advancePointer();
        game.state.change('victory');
        return true; // Block until victory screen closes
      }

      case 'credits':
      case 'credit': {
        this.advancePointer();
        game.state.change('credit');
        return true; // Block until credits close
      }

      // ----- Support system event commands -----

      case 'enable_supports': {
        // Sets the _supports game var to enable supports
        game.actionLog.doAction(new SetGameVarAction(game.gameVars, '_supports', true));
        this.advancePointer();
        return false;
      }

      case 'increment_support_points': {
        // increment_support_points;unit1;unit2;amount
        const u1 = args[0];
        const u2 = args[1];
        const amount = parseInt(args[2] ?? '1', 10);
        if (u1 && u2 && game.supports) {
          const pair = game.supports.getPair(u1, u2);
          if (pair) {
            game.actionLog.doAction(new IncrementSupportPointsAction(pair, amount));
          }
        }
        this.advancePointer();
        return false;
      }

      case 'unlock_support_rank': {
        // unlock_support_rank;unit1;unit2;rank
        const u1 = args[0];
        const u2 = args[1];
        const rank = args[2];
        if (u1 && u2 && rank && game.supports) {
          const pair = game.supports.getPair(u1, u2);
          if (pair) {
            game.actionLog.doAction(new UnlockSupportRankAction(pair, rank));
          }
        }
        this.advancePointer();
        return false;
      }

      case 'disable_support_rank': {
        // disable_support_rank;unit1;unit2;rank
        const u1 = args[0];
        const u2 = args[1];
        const rank = args[2];
        if (u1 && u2 && rank && game.supports) {
          const pair = game.supports.getPair(u1, u2);
          if (pair) {
            game.actionLog.doAction(new DisableSupportRankAction(pair, rank));
          }
        }
        this.advancePointer();
        return false;
      }

      case 'enable_turnwheel': {
        // enable_turnwheel;true/false
        const activated = args[0]?.toLowerCase() !== 'false';
        game.actionLog.doAction(new SetGameVarAction(game.gameVars, '_turnwheel', activated));
        this.advancePointer();
        return false;
      }

      case 'activate_turnwheel': {
        // activate_turnwheel;force
        // Opens the turnwheel UI. If 'force' is specified, the player
        // must use the turnwheel (cannot cancel).
        const force = args[0]?.toLowerCase() !== 'false';
        if (!game.memory) game.memory = new Map();
        game.memory.set('force_turnwheel', force);
        game.memory.set('event_turnwheel', true);
        game.state.change('turnwheel');
        this.advancePointer();
        return true; // blocking — turnwheel state takes over
      }

      case 'clear_turnwheel': {
        // clear_turnwheel — sets the first free action to current position,
        // preventing the turnwheel from rewinding before this point.
        game.actionLog.setFirstFreeAction();
        this.advancePointer();
        return false;
      }

      case 'stop_turnwheel_recording': {
        game.actionLog.stopRecording();
        this.advancePointer();
        return false;
      }

      case 'start_turnwheel_recording': {
        game.actionLog.startRecording();
        this.advancePointer();
        return false;
      }

      case 'draw_overlay_sprite': {
        const nid = args[0] ?? '';
        const spriteNid = args[1] ?? '';
        const positionParts = (args[2] || '0,0').split(',').map(part => parseInt(part.trim(), 10));
        const position: [number, number] = [
          Number.isFinite(positionParts[0]) ? positionParts[0] : 0,
          Number.isFinite(positionParts[1]) ? positionParts[1] : 0,
        ];
        const zLevel = parseInt(args[3] ?? '0', 10) || 0;
        const animation = (args[4] ?? '').toLowerCase().trim();
        const speed = parseInt(args[5] ?? '1000', 10) || 1000;
        const noBlock = args.some(arg => arg.toLowerCase().trim() === 'no_block');
        const foreground = args.some(arg => arg.toLowerCase().trim() === 'foreground');
        const overlay: EventOverlaySprite = {
          nid,
          image: null,
          position,
          zLevel,
          foreground,
        };
        this.overlaySprites.set(nid, overlay);
        void game.resources.loadSystemSprite(spriteNid)
          .then((image: HTMLImageElement) => {
            if (this.overlaySprites.get(nid) === overlay) overlay.image = image;
          })
          .catch(() => console.warn(`draw_overlay_sprite: no sprite "${spriteNid}"`));
        if (animation && !noBlock && !this.skipMode) {
          this.waiting = true;
          this.waitTimer = speed;
          return true;
        }
        this.advancePointer();
        return false;
      }

      case 'remove_overlay_sprite': {
        const nid = args[0] ?? '';
        const animation = (args[1] ?? '').toLowerCase().trim();
        const speed = parseInt(args[2] ?? '1000', 10) || 1000;
        const noBlock = args.some(arg => arg.toLowerCase().trim() === 'no_block');
        this.overlaySprites.delete(nid);
        if (animation && !noBlock && !this.skipMode) {
          this.waiting = true;
          this.waitTimer = speed;
          return true;
        }
        this.advancePointer();
        return false;
      }

      case 'table':
      case 'remove_table':
      case 'textbox': {
        console.warn(`${cmd.type}: event UI component is not implemented`);
        this.advancePointer();
        return false;
      }

      case 'resurrect': {
        const unit = game.units.get(args[0]);
        if (unit) {
          game.actionLog.doAction(new ResurrectAction(unit));
        } else {
          console.warn(`Event resurrect: unit not found (${args[0] ?? ''})`);
        }
        this.advancePointer();
        return false;
      }

      case 'add_lore': {
        const loreNid = args[0];
        if (loreNid) game.actionLog.doAction(new AddLoreAction(loreNid));
        this.advancePointer();
        return false;
      }

      case 'remove_lore': {
        const loreNid = args[0];
        if (loreNid) game.actionLog.doAction(new RemoveLoreAction(loreNid));
        this.advancePointer();
        return false;
      }

      case 'pair_up': {
        // pair_up;Follower;Leader (nickname: rescue)
        const follower = this.findUnit(args[0] ?? '');
        const leader = this.findUnit(args[1] ?? '');
        if (!follower) {
          console.warn(`Event pair_up: follower not found (${args[0] ?? ''})`);
        } else if (follower.rescuedBy || follower.rescuing) {
          console.warn(`Event pair_up: follower is already traveling (${follower.nid})`);
        } else if (!leader) {
          console.warn(`Event pair_up: leader not found (${args[1] ?? ''})`);
        } else if (leader.rescuedBy || leader.rescuing) {
          console.warn(`Event pair_up: leader is already traveling (${leader.nid})`);
        } else {
          let canPairUp = game.db.getConstant('pairup', false) &&
            !game.db.getConstant('attack_stance_only', false);
          if (canPairUp && game.db.getConstant('player_pairup_only', false)) {
            canPairUp = leader.team === 'player' && follower.team === 'player';
          }
          if (canPairUp) {
            game.actionLog.doAction(new PairUpAction(follower, leader, game.board, game.db));
          } else {
            // Python falls back to classic Rescue whenever guard stance is unavailable.
            game.actionLog.doAction(new RescueAction(leader, follower, game.board));
          }
        }
        this.advancePointer();
        return false;
      }

      case 'separate': {
        // separate;Leader (nickname: drop). Event separation is non-spatial.
        const leader = this.findUnit(args[0] ?? '');
        const follower = leader?.rescuing ?? null;
        if (!leader) {
          console.warn(`Event separate: unit not found (${args[0] ?? ''})`);
        } else if (!follower) {
          console.warn(`Event separate: unit has no traveler (${leader.nid})`);
        } else if (game.db.getConstant('pairup', false)) {
          game.actionLog.doAction(new SeparatePairUpAction(
            leader, follower, game.board, game.db, null, true,
          ));
        } else {
          // RemovePartner deliberately clears the relationship without placing
          // the traveler on the map; Rekka's Glutton/Capture events rely on this.
          game.actionLog.doAction(new RemovePartnerAction(leader, follower));
        }
        this.advancePointer();
        return false;
      }

      case 'enable_fog_of_war': {
        const fogEnableStr = args[0]?.toLowerCase?.() ?? 'true';
        const fogEnable = fogEnableStr === 'true' || fogEnableStr === '1';
        game.actionLog.doAction(new SetLevelVarAction(game.levelVars, '_fog_of_war', fogEnable));
        console.log(`Event: enable_fog_of_war -> ${fogEnable}`);
        this.advancePointer();
        return false;
      }

      case 'set_fog_of_war': {
        const fogModeStr = (args[0] ?? 'gba').toLowerCase();
        let fogMode = 1;
        if (fogModeStr === 'gba') fogMode = 1;
        else if (fogModeStr === 'thracia') fogMode = 2;
        else if (fogModeStr === 'hybrid') fogMode = 3;
        else if (fogModeStr === 'gba_deprecated') fogMode = 0;
        else { const fp = parseInt(fogModeStr, 10); if (!isNaN(fp)) fogMode = fp; }
        const fogRadius = parseInt(args[1] ?? '0', 10) || 0;
        const fogAiRadius = args[2] ? (parseInt(args[2], 10) || fogRadius) : fogRadius;
        const fogOtherRadius = args[3] ? (parseInt(args[3], 10) || fogAiRadius) : fogAiRadius;
        game.actionLog.doAction(new SetLevelVarAction(game.levelVars, '_fog_of_war_type', fogMode));
        game.actionLog.doAction(new SetLevelVarAction(game.levelVars, '_fog_of_war_radius', fogRadius));
        game.actionLog.doAction(new SetLevelVarAction(game.levelVars, '_ai_fog_of_war_radius', fogAiRadius));
        game.actionLog.doAction(new SetLevelVarAction(game.levelVars, '_other_fog_of_war_radius', fogOtherRadius));
        console.log(`Event: set_fog_of_war mode=${fogMode} radius=${fogRadius} ai=${fogAiRadius} other=${fogOtherRadius}`);
        this.advancePointer();
        return false;
      }

      // ---------------------------------------------------------------
      // Initiative commands
      // ---------------------------------------------------------------

      case 'add_to_initiative': {
        // add_to_initiative;UnitNid;Position
        // Adds unit at position relative to current initiative index
        const unitNid = args[0] ?? '';
        const pos = parseInt(args[1] ?? '0', 10) || 0;
        const unit = this.findUnit(unitNid);
        if (unit && game.initiative) {
          game.actionLog.doAction(new AddToInitiativeAction(unit.nid, pos, game.initiative));
        }
        this.advancePointer();
        return false;
      }

      case 'move_in_initiative': {
        // move_in_initiative;UnitNid;Offset
        // Moves unit by offset positions in the initiative order
        const unitNid = args[0] ?? '';
        const offset = parseInt(args[1] ?? '0', 10) || 0;
        const unit = this.findUnit(unitNid);
        if (unit && game.initiative) {
          game.actionLog.doAction(new MoveInInitiativeAction(unit.nid, offset, game.initiative));
        }
        this.advancePointer();
        return false;
      }

      // ---------------------------------------------------------------
      // Roam mode commands
      // ---------------------------------------------------------------

      case 'set_roam': {
        // set_roam;true/false
        const val = (args[0] ?? 'true').toLowerCase();
        game.actionLog.doAction(
          new SetRoamInfoAction(game.roamInfo, 'roam', val !== 'false' && val !== '0'),
        );
        console.log(`Event: set_roam -> ${game.roamInfo.roam}`);
        this.advancePointer();
        return false;
      }

      case 'set_roam_unit': {
        // set_roam_unit;UnitNid
        game.actionLog.doAction(
          new SetRoamInfoAction(game.roamInfo, 'roamUnitNid', args[0] || null),
        );
        console.log(`Event: set_roam_unit -> ${game.roamInfo.roamUnitNid}`);
        this.advancePointer();
        return false;
      }

      // ----- Persistent records & achievements -----
      case 'create_record': {
        // create_record;nid;expression
        try {
          const nid = args[0];
          const value = args[1] ?? 'true';
          if (nid && RECORDS) {
            let evaluated: any = value;
            if (value === 'True' || value === 'true') evaluated = true;
            else if (value === 'False' || value === 'false') evaluated = false;
            else if (!isNaN(Number(value))) evaluated = Number(value);
            game.actionLog.doAction(
              new UpdatePersistentStoreAction(RECORDS, () => RECORDS.create(nid, evaluated)),
            );
          }
        } catch (e) { console.warn('create_record error:', e); }
        this.advancePointer();
        return false;
      }
      case 'update_record': {
        try {
          const nid = args[0];
          const value = args[1] ?? 'true';
          if (nid && RECORDS) {
            let evaluated: any = value;
            if (value === 'True' || value === 'true') evaluated = true;
            else if (value === 'False' || value === 'false') evaluated = false;
            else if (!isNaN(Number(value))) evaluated = Number(value);
            game.actionLog.doAction(
              new UpdatePersistentStoreAction(RECORDS, () => RECORDS.update(nid, evaluated)),
            );
          }
        } catch (e) { console.warn('update_record error:', e); }
        this.advancePointer();
        return false;
      }
      case 'replace_record': {
        try {
          const nid = args[0];
          const value = args[1] ?? 'true';
          if (nid && RECORDS) {
            let evaluated: any = value;
            if (value === 'True' || value === 'true') evaluated = true;
            else if (value === 'False' || value === 'false') evaluated = false;
            else if (!isNaN(Number(value))) evaluated = Number(value);
            game.actionLog.doAction(
              new UpdatePersistentStoreAction(RECORDS, () => RECORDS.replace(nid, evaluated)),
            );
          }
        } catch (e) { console.warn('replace_record error:', e); }
        this.advancePointer();
        return false;
      }
      case 'delete_record': {
        try {
          if (args[0] && RECORDS) {
            game.actionLog.doAction(
              new UpdatePersistentStoreAction(RECORDS, () => RECORDS.delete(args[0])),
            );
          }
        } catch (e) { console.warn('delete_record error:', e); }
        this.advancePointer();
        return false;
      }
      case 'unlock_difficulty': {
        try {
          if (args[0] && RECORDS) {
            game.actionLog.doAction(
              new UpdatePersistentStoreAction(RECORDS, () => RECORDS.unlockDifficulty(args[0])),
            );
          }
        } catch (e) { console.warn('unlock_difficulty error:', e); }
        this.advancePointer();
        return false;
      }
      case 'unlock_song': {
        try {
          if (args[0] && RECORDS) {
            game.actionLog.doAction(
              new UpdatePersistentStoreAction(RECORDS, () => RECORDS.unlockSong(args[0])),
            );
          }
        } catch (e) { console.warn('unlock_song error:', e); }
        this.advancePointer();
        return false;
      }
      case 'create_achievement': {
        // create_achievement;nid;name;description;[completed];[hidden]
        try {
          if (args[0] && args[1] !== undefined && args[2] !== undefined && ACHIEVEMENTS) {
            const nid = args[0];
            const name = args[1];
            const desc = args[2];
            const flags = new Set(args.slice(3).map((flag) => flag.toLowerCase()));
            const complete = flags.has('completed');
            const hidden = flags.has('hidden');
            game.actionLog.doAction(
              new UpdatePersistentStoreAction(
                ACHIEVEMENTS,
                () => ACHIEVEMENTS.add(nid, name, desc, complete, hidden),
              ),
            );
          } else {
            console.warn(`Event create_achievement: missing required argument (${args.join(';')})`);
          }
        } catch (e) { console.warn('create_achievement error:', e); }
        this.advancePointer();
        return false;
      }
      case 'update_achievement': {
        // update_achievement;nid;name;description;[hidden]
        try {
          if (args[0] && args[1] !== undefined && args[2] !== undefined && ACHIEVEMENTS) {
            const hidden = args.slice(3).some((flag) => flag.toLowerCase() === 'hidden');
            game.actionLog.doAction(
              new UpdatePersistentStoreAction(
                ACHIEVEMENTS,
                () => ACHIEVEMENTS.updateAchievement(args[0], args[1], args[2], hidden),
              ),
            );
          } else {
            console.warn(`Event update_achievement: missing required argument (${args.join(';')})`);
          }
        } catch (e) { console.warn('update_achievement error:', e); }
        this.advancePointer();
        return false;
      }
      case 'complete_achievement': {
        // complete_achievement;nid;bool;[banner]
        try {
          const complete = parseEventBool(args[1]);
          if (args[0] && complete !== null && ACHIEVEMENTS) {
            const action = new UpdatePersistentStoreAction(
              ACHIEVEMENTS,
              () => ACHIEVEMENTS.complete(args[0], complete),
            );
            game.actionLog.doAction(action);
            const changedToComplete = action.result;
            const banner = args.slice(2).some((flag) => flag.toLowerCase() === 'banner');
            if (changedToComplete && banner && !this.skipMode) {
              const achievement = ACHIEVEMENTS.getAchievement(args[0]);
              if (achievement) {
                game.audioManager?.playSfx?.('Item');
                this.banner = new Banner(achievement.name, 'Achievement Unlocked', 2000);
                this.bannerIsAlert = false;
                // Python waits two seconds and removes the notification before advancing.
                return true;
              }
            }
          } else {
            console.warn(`Event complete_achievement: invalid achievement or bool (${args.join(';')})`);
          }
        } catch (e) { console.warn('complete_achievement error:', e); }
        this.advancePointer();
        return false;
      }
      case 'clear_achievements': {
        try {
          if (ACHIEVEMENTS) {
            game.actionLog.doAction(
              new UpdatePersistentStoreAction(ACHIEVEMENTS, () => ACHIEVEMENTS.clear()),
            );
          }
        } catch (e) { console.warn('clear_achievements error:', e); }
        this.advancePointer();
        return false;
      }
      case 'open_achievements': {
        const background = args[0];
        if (!background) {
          console.warn('Event open_achievements: missing required background');
          this.advancePointer();
          return false;
        }
        game.actionLog.doAction(new SetGameVarAction(game.gameVars, '_base_bg_name', background));
        this.advancePointer();
        game.state.change('base_achievement');
        return true;
      }

      // ----- Save/load commands -----
      case 'battle_save':
      case 'battle_save_prompt': {
        // battle_save — save during chapter (auto-save or prompted)
        // For now, push the save menu state
        game.state.change('save_menu');
        this.advancePointer();
        return true; // blocking until save menu exits
      }
      case 'skip_save': {
        // skip_save — silently auto-save to current slot
        try {
          const slot = game.currentSaveSlot >= 0 ? game.currentSaveSlot : 0;
          doSaveGame(game, slot, 'battle').catch((err: any) => {
            console.warn('skip_save failed:', err);
          });
        } catch (e) { console.warn('skip_save error:', e); }
        this.advancePointer();
        return false;
      }
      case 'suspend': {
        // suspend — save and return to title
        try {
          doSuspendGame(game).then(() => {
            game.state.clear();
            game.state.change('title');
          }).catch(() => {
            game.state.clear();
            game.state.change('title');
          });
        } catch (e) {
          console.warn('suspend error:', e);
          game.state.clear();
          game.state.change('title');
        }
        this.advancePointer();
        return false;
      }

      default:
        // Unknown/unimplemented command — report and skip
        reportUnimplemented('command', cmd.type, `EventState dispatch`);
        this.advancePointer();
        return false;
    }
  }

  // -----------------------------------------------------------------------
  // Group position lookup: mirrors Python's Event._get_position()
  // -----------------------------------------------------------------------

  /**
   * Resolve the position for a unit within a group command.
   *
   * @param nextPos     The StartingGroup parameter. Rules:
   *   - empty/null  → use the group's own positions dict
   *   - 'starting'  → use unit.startingPosition
   *   - 'x,y'       → literal coordinate (all units get same position)
   *   - other string → another group NID's positions dict
   * @param unitNid    The unit to look up
   * @param group      The primary group being operated on
   * @param allGroups  All level unit groups (for cross-group lookups)
   * @param game       GameState reference
   */
  private _getGroupPosition(
    nextPos: string,
    unitNid: string,
    group: any,
    allGroups: any[],
    game: any,
  ): [number, number] | null {
    if (!nextPos || nextPos === '') {
      // Use the group's own positions dict
      const pos = group.positions?.[unitNid];
      return pos ? [pos[0], pos[1]] : null;
    }

    if (nextPos.toLowerCase() === 'starting') {
      // Use the unit's starting_position
      const unit = this.findUnit(unitNid);
      if (unit?.startingPosition) {
        return [unit.startingPosition[0], unit.startingPosition[1]];
      }
      // Also check level data for starting_position
      const levelUnits = game.currentLevel?.units ?? [];
      const levelUnit = levelUnits.find((u: any) => u.nid === unitNid);
      if (levelUnit?.starting_position) {
        return [levelUnit.starting_position[0], levelUnit.starting_position[1]];
      }
      return null;
    }

    // Check if it's a literal "x,y" coordinate
    if (nextPos.includes(',')) {
      const parts = nextPos.split(',').map((s: string) => parseInt(s.trim(), 10));
      if (parts.length >= 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
        return [parts[0], parts[1]];
      }
    }

    // Otherwise, treat as another group's NID and look up positions
    const otherGroup = allGroups.find((g: any) => g.nid === nextPos);
    if (otherGroup?.positions?.[unitNid]) {
      const pos = otherGroup.positions[unitNid];
      return [pos[0], pos[1]];
    }

    return null;
  }

  /**
   * Check placement validity: mirrors Python's Event._check_placement().
   *
   * @param position  Desired position
   * @param placement One of: 'giveup', 'stack', 'closest', 'push'
   * @param game      GameState reference
   * @returns The final position, or null if placement fails
   */
  private _checkPlacement(
    position: [number, number],
    placement: string,
    game: any,
  ): [number, number] | null {
    // Check bounds
    if (game.tilemap && !game.tilemap.checkBounds(position[0], position[1])) {
      return null;
    }

    // Check if tile is occupied
    const occupant = game.board?.getUnit(position[0], position[1]);
    if (!occupant) {
      return position; // tile is free
    }

    switch (placement) {
      case 'giveup':
        return null; // skip this unit
      case 'stack':
        return position; // place on top (units overlap)
      case 'closest': {
        // Find nearest unoccupied tile
        const maxRange = 10;
        for (let r = 1; r <= maxRange; r++) {
          for (let dx = -r; dx <= r; dx++) {
            for (let dy = -r; dy <= r; dy++) {
              if (Math.abs(dx) + Math.abs(dy) !== r) continue;
              const nx = position[0] + dx;
              const ny = position[1] + dy;
              if (game.tilemap && !game.tilemap.checkBounds(nx, ny)) continue;
              if (!game.board?.getUnit(nx, ny)) {
                return [nx, ny];
              }
            }
          }
        }
        return null;
      }
      case 'push': {
        // Push the occupant to a nearby tile, then use this position
        const maxRange = 5;
        for (let r = 1; r <= maxRange; r++) {
          for (let dx = -r; dx <= r; dx++) {
            for (let dy = -r; dy <= r; dy++) {
              if (Math.abs(dx) + Math.abs(dy) !== r) continue;
              const nx = position[0] + dx;
              const ny = position[1] + dy;
              if (game.tilemap && !game.tilemap.checkBounds(nx, ny)) continue;
              if (!game.board?.getUnit(nx, ny)) {
                game.actionLog.doAction(new ArriveOnMapAction(game, occupant, [nx, ny]));
                return position;
              }
            }
          }
        }
        return null;
      }
      default:
        return position;
    }
  }

  // -----------------------------------------------------------------------
  // Unit spawning helper: handles both unique and generic units from level data
  // -----------------------------------------------------------------------

  private spawnUnitFromLevelData(
    unitData: any,
    posOverride: [number, number] | null,
    game: any,
  ): void {
    const isGeneric = unitData.generic === true;
    const pos = posOverride ?? unitData.starting_position ?? null;

    if (isGeneric) {
      // Generic unit — build synthetic prefab and spawn
      const data = { ...unitData, starting_position: pos };
      game.spawnGenericUnit(data);
      const spawned = game.units.get(unitData.nid);
      if (spawned) {
        game.actionLog.doAction(new CreateUnitAction(game, spawned, pos, true));
        this.loadMapSpriteForUnit(spawned, game);
      }
    } else {
      // Unique unit — look up prefab from db
      const prefab = game.db.units.get(unitData.nid);
      if (prefab) {
        const spawned = game.spawnUnit(
          prefab,
          unitData.team ?? 'player',
          pos,
          unitData.ai ?? 'None',
        );
        game.actionLog.doAction(new CreateUnitAction(game, spawned, pos, true));
        this.loadMapSpriteForUnit(spawned, game);
      } else {
        console.warn(`EventState: unique unit prefab "${unitData.nid}" not found in db`);
      }
    }
  }

  // -----------------------------------------------------------------------
  // Async helper: load map sprite for a newly spawned unit
  // -----------------------------------------------------------------------

  private loadMapSpriteForUnit(unit: UnitObject, game: any): void {
    const klassDef = game.db.classes.get(unit.klass);
    if (!klassDef) return;
    const spriteNid = klassDef.map_sprite_nid;
    if (!spriteNid) return;

    const teamDef = game.db.teams.defs.find((t: any) => t.nid === unit.team);
    const teamPalette = teamDef?.palette ?? undefined;

    // Fire-and-forget async load
    game.resources.tryLoadMapSprite(spriteNid).then((sprites: any) => {
      const mapSprite = MapSpriteClass.fromImages(sprites.stand, sprites.move, teamPalette);
      unit.sprite = mapSprite;
    }).catch((err: any) => {
      console.warn(`EventState: failed to load map sprite for unit "${unit.nid}":`, err);
    });
  }

  // -----------------------------------------------------------------------
  // Helper: grant skills from a new class after promotion/class change
  // -----------------------------------------------------------------------

  /** Grant personal/class skills crossed by autolevel_to, using actions. */
  private grantAutolevelSkills(unit: UnitObject, startingLevel: number, game: any): void {
    const personalPrefab = game.db.units.get(unit.nid);
    if (personalPrefab?.learned_skills) {
      for (const [level, skillNid] of personalPrefab.learned_skills) {
        if (
          startingLevel < level &&
          level <= unit.level &&
          skillNid !== 'Feat' &&
          !unit.skills.some((skill: any) => skill.nid === skillNid)
        ) {
          const prefab = game.db.skills.get(skillNid);
          if (prefab) game.actionLog.doAction(new AddSkillAction(unit, new SkillObject(prefab)));
        }
      }
    }

    for (const skillNid of getStartingClassSkillNids(unit, startingLevel, game)) {
      const prefab = game.db.skills.get(skillNid);
      if (prefab) game.actionLog.doAction(new AddSkillAction(unit, new SkillObject(prefab)));
    }
  }

  /**
   * Grant learned skills from the unit's current class.
   * After promotion/class change, iterate the new class's learned_skills
   * and add any skills the unit doesn't already have, up to their current level.
   * Matches Python's event_functions.py promote/change_class logic.
   */
  private grantClassSkills(unit: UnitObject, game: any): void {
    const unitKlass = game.db.classes.get(unit.klass);
    if (!unitKlass || !unitKlass.learned_skills) return;

    for (const [levelNeeded, classSkillNid] of unitKlass.learned_skills) {
      if (unit.level >= levelNeeded) {
        // Check if unit already has this skill
        const hasSkill = unit.skills.some((s: any) => s.nid === classSkillNid);
        if (!hasSkill) {
          const skillPrefab = game.db.skills.get(classSkillNid);
          if (skillPrefab) {
            game.actionLog.doAction(new AddSkillAction(unit, new SkillObject(skillPrefab)));
          }
        }
      }
    }
  }

  // -----------------------------------------------------------------------
  // Internal flag for if/elif/else flow control
  // -----------------------------------------------------------------------
  private _jumpedToBranch: boolean = false;
}
