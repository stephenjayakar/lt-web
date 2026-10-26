/**
 * game-states.ts - All game states for the Lex Talionis web engine.
 *
 * Each state class extends State or MapState and plugs into the
 * stack-based StateMachine.  A lazily-resolved `game` reference
 * provides access to the shared game context (camera, cursor, board,
 * units, tilemap, mapView, etc.) without creating circular imports.
 */

import type { SongObject } from '../../audio/music-controller';
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
  getFrameCount,
} from '../constants';
import { viewport, isSmallScreen } from '../viewport';

import type { UnitObject } from '../../objects/unit';
import type { ItemObject } from '../../objects/item';
import { auraHighlightPositions } from '../../combat/aura-system';
import type {
  RegionData,
  DifficultyMode,
  UnitGroupData,
  UniqueUnitData,
  GenericUnitData,
} from '../../data/types';
import { ItemObject as ItemObjectClass, createItemTree } from '../../objects/item';
import { SkillObject } from '../../objects/skill';
import { evaluateCondition, evaluateExpression, GameEvent, type ConditionContext, type EventCommand } from '../../events/event-manager';
import {
  activateCombatArt,
  deactivateCombatArts,
  getCombatArtOptions,
  type CombatArtOption,
} from '../../combat/combat-art-system';
import {
  MarkActionGroupStart,
  MoveAction,
  SetMovementLeftAction,
  MarkActionGroupEnd,
  MarkPhase,
  LockTurnwheel,
  MessageAction,
  SetGameVarAction,
  ChangePhaseMusicAction,
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
  RegisterItemTreeAction,
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
  DamageAction,
  WeaponUsesAction,
  SetCurrentHpAction,
  SetCurrentManaAction,
  GainExpAction,
  DeathAction,
  SetUnitExpAction,
  HasAttackedAction,
  HasNotAttackedAction,
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
  DecrementTimeRegionAction,
  AddTagAction,
  RemoveTagAction,
  UnequipItemAction,
  CreateUnitAction,
  UnregisterUnitAction,
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
  ShowLayerAction,
  HideLayerAction,
  AddMapAnimationAction,
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
  TransferTravelerAction,
} from '../action';

import { ChoiceMenu, type MenuItemRow, type MenuOption } from '../../ui/menu';
import {
  Choice as PrepChoice,
  ScrollingBackground as PrepScrollingBackground,
  baseSurf as prepBaseSurf,
  getSprite as prepGetSprite,
  isFirstPush as prepIsFirstPush,
  screenOrigin as prepScreenOrigin,
  shopPrice as prepShopPrice,
  textWidth as prepTextWidth,
  TradeMenu,
  checkTrade as prepCheckTrade,
} from '../../ui/prep-ui';
import { DifficultyModeObject } from '../difficulty';
export { InfoMenuState, setInfoMenuGameRef } from './info-menu-state';
import { getSprite } from '../../ui/sprites';
import { Banner, PhaseIn, acquiredItemText, colored, gainWexpText, itemIcon, skillIcon, stoleItemText, weaponIcon } from '../../ui/banner';
import { EVENT_COMMAND_FLAGS } from '../../events/event-command-flags';
import { getMenuBackgroundSync } from '../../ui/base-surf';
import { MenuBackground, MenuScene, blitText as blitMenuText, blitTextCenter as blitMenuTextCenter, getSprite as getMenuSprite, lineWrap, textWidth as menuTextWidth, type SpriteImage } from '../../ui/menu-chrome';
import { ChapterSelectMenu, HorizontalChoice, ModeSelectMenu, TitleMainMenu, chapterSelectFromSlots, preloadTitleMenuSprites } from '../../ui/title-menu';
import { getSetting } from './settings-state';
import { EventChoiceMenu, type EventChoiceEntry } from '../../ui/event-choice';
import { Dialog } from '../../ui/dialog';
import { drawStyledText, measureStyledText } from '../../ui/styled-text';
import { ExpBar as ExpBarClass, LevelUpScreen as LevelUpScreenClass } from '../../ui/exp-display';
import { EventPortrait } from '../../events/event-portrait';
import { parseScreenPosition } from '../../events/screen-positions';
import { MapCombat, type CombatResults } from '../../combat/map-combat';
import {
  queueAfterInitiatedCombatEvents,
  queueCombatSkillEvents,
  queueCombatSkillStartEvents,
  applyCombatItemStartHooks,
  applyCombatItemEndHooks,
  queueCombatItemBreakEvents,
  queueDirectItemUseEvents,
  queueCombatItemEvents,
  applyDroppableItemPickups,
  applyStolenItemTransfer,
  combatTradePair,
  applyCombatSkillEndHooks,
  triggerAbilityItemCharge,
  triggerSkillCharge,
} from '../../combat/combat-lifecycle';
import { internalLevel } from '../../combat/combat-components';
import { applySkillTurnHooks } from '../skill-turn-lifecycle';
import {
  applyItemEndResourceHooks,
  applyItemStartResourceHooks,
  applyItemUpkeepResourceHooks,
} from '../../combat/item-resource-lifecycle';
import { appendDialogLogEntry } from './objective-dialog-states';
import { supplyAvailableOnMap } from './supply-state';
import { MapAnimation } from '../../rendering/map-animation';
import { FONT } from '../../rendering/bmp-font';
import { computeArrowSegments } from '../../rendering/movement-arrows';
import type { FogRenderConfig } from '../../rendering/map-view';
import { shouldDrawMapHp } from '../../rendering/map-view';
import type { MapSpriteFx } from '../../rendering/map-sprite';
import { drawIcon16, drawItemIcon } from '../../ui/icons';
import {
  AnimationCombat,
  type TransformBattleAnimations,
} from '../../combat/animation-combat';
import { BattleAnimation as RealBattleAnimation } from '../../combat/battle-animation';
import { procCueMotion, type CombatProcCue } from '../../combat/proc-presentation';
import {
  clearUnitFx,
  drawMapDamageNumbers,
  getUnitFx,
  isUnitDying,
  markDying,
  startDyingFade,
  DEFAULT_TRANSITION_TIME,
} from '../../combat/map-unit-fx';
import {
  accuracy as combatAccuracy,
  critAccuracy as combatCritAccuracy,
  damage as combatDamage,
  attackSpeed,
  canCounterattack,
  canDefenderDouble,
  canDouble,
  computeBlitzPhases,
  computeCrit,
  computeDamage,
  computeExtraAttackPhases,
  computeStrikeCount,
  evaluateEquation,
  getEquippedWeapon,
  isMagic,
  avoid as combatAvoid,
} from '../../combat/combat-calcs';
import {
  isRepairableItem,
  numTargets,
  allowSameTarget,
  allowLessThanMaxTargets,
  isStealItem,
  stealItemRestrict,
  traceItemRestrict,
  available as itemAvailable,
  computeTargetIcon,
  fullPrice as itemFullPrice,
  buyPrice as itemBuyPrice,
  sellPrice as itemSellPrice,
  menuAfterCombat,
  canAttackAfterCombat,
  forceMapAnim,
  tradeable as itemTradeable,
  transforms,
  inventoryFull as itemInventoryFull,
  healAmount as itemHealAmount,
  solomonHpChange,
  canUnlock as itemCanUnlock,
} from '../../combat/item-system';
import {
  ignoreForcedMovement,
  expMultiplier,
  enemyExpMultiplier,
  wexpMultiplier,
  enemyWexpMultiplier,
  isCantoSkill,
  hasCanto as unitHasCanto,
  cantoMovement,
  canSelect,
  canTradeWith,
  hasDrainingCharge,
  modifiedMaximumRange,
  modifiedMinimumRange,
  movementType,
  priceSkillMultiplier,
  skillConditionActive,
  empowerHeal,
  unitSpriteTint,
  canUnlock as skillCanUnlock,
} from '../../combat/skill-system';
import { loadBattlePlatforms, loadAndConvertWeaponAnim, selectPalette, selectWeaponAnim } from '../../combat/sprite-loader';
import { handleBaseEventCommand } from './base-state';
import { RECORDS, ACHIEVEMENTS } from '../records';
import { saveGame as doSaveGame, suspendGame as doSuspendGame, hasSuspend, loadSaveSlots, deleteSuspend, formatPlaytime, loadSuspend as loadSuspendSave } from '../save';
import { getSyncStore } from '../../storage/storage';
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

function parsePyevCommandValue(value: string): any {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
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

/** Python utilities.type_checking.is_primitive_or_primitive_collection. */
function isPrimitiveOrPrimitiveCollection(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (['number', 'string', 'boolean'].includes(typeof value)) return true;
  if (Array.isArray(value)) return value.every(isPrimitiveOrPrimitiveCollection);
  if (value instanceof Set) return [...value].every(isPrimitiveOrPrimitiveCollection);
  if (value instanceof Map) {
    return [...value.keys()].every(isPrimitiveOrPrimitiveCollection) &&
      [...value.values()].every(isPrimitiveOrPrimitiveCollection);
  }
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype &&
      !('_raw' in (value as object))) {
    return Object.values(value as object).every(isPrimitiveOrPrimitiveCollection);
  }
  return false;
}

/**
 * Python event_commands._parse_command for one command signature: flags are
 * recognised anywhere, `Keyword=value` fills its named slot, and a
 * positional argument's slot is its raw index (flags included), exactly as
 * Python counts it.
 */
function parsePythonEventArgs(
  args: string[],
  keywords: string[],
  optionalKeywords: string[],
  flagNames: string[] = [],
): { value: (keyword: string) => string | undefined; flags: Set<string> } {
  const allKeywords = [...keywords, ...optionalKeywords];
  const values = new Map<string, string>();
  const flags = new Set<string>();
  args.forEach((arg, index) => {
    if (flagNames.includes(arg)) {
      flags.add(arg);
      return;
    }
    const equals = arg.indexOf('=');
    if (equals > 0 && allKeywords.includes(arg.slice(0, equals))) {
      values.set(arg.slice(0, equals), arg.slice(equals + 1));
      return;
    }
    if (index < allKeywords.length && !values.has(allKeywords[index])) {
      values.set(allKeywords[index], arg);
    }
  });
  return { value: (keyword: string) => values.get(keyword), flags };
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
  tintColor: [number, number, number] | null;
  tintAlpha: number;
  showHp: boolean;
  fx: MapSpriteFx | null;
  poseOverride: { state: 'standing' | 'moving'; direction?: 'up' | 'down' | 'left' | 'right' } | null;
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
    tintColor: [number, number, number] | null;
    tintAlpha: number;
    showHp: boolean;
    fx: MapSpriteFx | null;
    poseOverride: { state: 'standing' | 'moving'; direction?: 'up' | 'down' | 'left' | 'right' } | null;
  }[] = [];

  for (const u of allUnits) {
    if (!u.position) continue;
    // Python keeps an is_dying unit on the map until DeathManager's fade
    // ends; its HP already reached 0 when the combat results applied.
    if (u.isDead() && !isUnitDying(u)) continue;
    const unitFx = getUnitFx(u);

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
    if (unitFx) {
      visualOffsetX += unitFx.offset[0] / TILEWIDTH;
      visualOffsetY += unitFx.offset[1] / TILEHEIGHT;
    }

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
    const tint = unitSpriteTint(u, game, performance.now());

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
      // Evaluated lazily: max HP runs every stat-skill condition, and the
      // map view only needs it for units that survive its viewport cull
      // (Python's map_view likewise draws HP only for culled units).
      get maxHp() { return u.maxHp; },
      get showHp() {
        return shouldDrawMapHp(game, { team: u.team, currentHp: u.currentHp, maxHp: u.maxHp, isDying: unitFx?.dying, dead: u.dead });
      },
      specialTag,
      travelerCombatColor,
      droppable,
      tintColor: tint?.color ?? null,
      tintAlpha: tint?.alpha ?? 0,
      fx: unitFx,
      poseOverride: unitFx?.direction
        ? { state: 'moving', direction: unitFx.direction }
        : null,
    });
  }
  return result;
}

/** Render the map through MapView and blit onto `surf`. */
function drawMap(surf: Surface, showHighlights: boolean = true): Surface {
  const game = getGame();
  if (!game.board || !game.tilemap) return surf; // No level loaded
  game.syncSkillMapAnimations();
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
      // Python get_image: the active frame over a visible, unfinished player unit.
      const hover = game.cursor.getHover();
      const unit: UnitObject | null = game.board.getUnit(hover.x, hover.y);
      const activeUnit = !!unit && unit.team === 'player' && !unit.finished && !unit.tags.includes('Tile') &&
        game.board.inVision([hover.x, hover.y], 'player', game.getCurrentFogInfo?.(), game.db, game.getAllUnits());
      // LevelCursor formation frame: which half depends on the tile being a
      // formation spot (prep_formation_select uses formation_show).
      const inFormation = game.cursor.drawState === 'formation' &&
        (game.currentLevel?.regions ?? []).some((r: any) => r.region_type === 'formation' &&
          hover.x >= r.position[0] && hover.x < r.position[0] + (r.size?.[0] ?? 1) &&
          hover.y >= r.position[1] && hover.y < r.position[1] + (r.size?.[1] ?? 1));
      game.cursor.draw(s, [ox, oy] as [number, number], { activeUnit, inFormation });
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
  drawUnitMarkers(surf);
  // UnitSprite damage numbers outlive the combat that spawned them.
  const damageNumberCamera = game.camera.getOffset();
  drawMapDamageNumbers(surf, damageNumberCamera[0], damageNumberCamera[1]);
  // Python MapView.draw ends with game.ui_view.draw(surf).
  game.hud.draw(surf, game);
  return surf;
}

/** States in which Python UnitSprite.draw_markers uses the cursor's unit. */
const MARKER_CUR_UNIT_STATES = new Set([
  'move', 'menu', 'item', 'item_child', 'item_discard', 'weapon_choice', 'spell_choice',
  'targeting', 'combat_targeting', 'item_targeting',
]);

/**
 * Python UnitSprite.draw_markers: talk / interact / item target_icon
 * ('warning', 'danger') markers from SPRITES['marker_<name>'] above each
 * unit at (left - 2, top - 14) with a bob, cycling every 500 ms.
 */
function drawUnitMarkers(surf: Surface): void {
  const game = getGame();
  const stateName: string = game.state.getCurrentState()?.name ?? '';
  let curUnit: UnitObject | null = null;
  if (stateName === 'free') {
    const [cx, cy] = game.cursor.getPosition();
    const hover: UnitObject | null = game.board.getUnit(cx, cy);
    if (hover && !hover.tags.includes('Tile') &&
        game.board.inVision([cx, cy], 'player', game.getCurrentFogInfo?.(), game.db, game.getAllUnits())) {
      curUnit = hover;
    }
  } else if (MARKER_CUR_UNIT_STATES.has(stateName)) {
    curUnit = game.selectedUnit ?? null;
  } else if (stateName === 'free_roam') {
    curUnit = game.roamInfo?.roamUnitNid ? game.getUnit(game.roamInfo.roamUnitNid) ?? null : null;
  }
  if (!curUnit) return;
  const now = getFrameCount() * FRAMETIME;
  const offset = [0, 0, 0, 1, 2, 2, 2, 1][Math.floor(now / 100) % 8];
  const [camX, camY] = game.camera.getOffset();
  const talkPairs: [string, string][] = game.eventManager?.getTalkPairs?.() ?? [];
  const fogInfo = game.getCurrentFogInfo?.();
  for (const unit of game.units.values() as Iterable<UnitObject>) {
    if (!unit.position || unit.isDead() || unit === curUnit) continue;
    if (unit.team !== 'player' && !game.board.inVision(unit.position, 'player', fogInfo, game.db, game.getAllUnits())) continue;
    const markers: string[] = [];
    if (talkPairs.some(([a, b]) => a === curUnit!.nid && b === unit.nid) &&
        !game.eventManager?.isTalkHidden?.(curUnit.nid, unit.nid)) {
      markers.push('talk');
    }
    if (curUnit.team === 'player') {
      for (const item of unit.items) {
        const icon = computeTargetIcon(unit, item, curUnit, game.db, game);
        if (icon) markers.push(icon);
      }
    }
    const sprites = markers.map((name) => getSprite(`marker_${name}`)).filter((sprite): sprite is Surface => !!sprite);
    if (!sprites.length) continue;
    const icon = sprites[Math.floor(now / 500) % sprites.length];
    const left = unit.position[0] * TILEWIDTH - camX;
    const top = unit.position[1] * TILEHEIGHT - camY;
    surf.blit(icon, left - 2, top - 14 + offset);
  }
}

/**
 * Python Animation(RESOURCES.animations.get(nid), topleft): a resource
 * animation placed at a pixel top-left (screen or panel space).
 */
function createPixelAnimation(nid: string, x: number, y: number, hold = false): MapAnimation | null {
  const game = getGame();
  const prefab = game.db.mapAnimations?.get(nid);
  if (!prefab) return null;
  const anim = new MapAnimation(prefab, 0, 0, { hold });
  void game.resources.loadImage(`resources/animations/${nid}.png`).then((img: HTMLImageElement) => {
    anim.setImage(img);
    anim.x = x;
    anim.y = y;
  }).catch(() => {
    anim.done = true;
  });
  return anim;
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

/** Match BaseCombat.start_combat item-hook order for every armed participant. */
function applyCombatParticipantItemStartHooks(
  game: any,
  attacker: UnitObject,
  attackItem: ItemObject,
  defenders: UnitObject[],
): void {
  const processed = new Set<ItemObject>();
  const apply = (
    unit: UnitObject | null,
    item: ItemObject | null,
    target: UnitObject | null,
    item2: ItemObject | null,
    mode: string,
  ): void => {
    if (!unit || !item || processed.has(item)) return;
    processed.add(item);
    applyCombatItemStartHooks(game, unit, item, target, item2, mode);
  };

  const primaryDefender = defenders[0] ?? null;
  const primaryDefenseItem = primaryDefender
    ? getEquippedWeapon(primaryDefender, game.db, game)
    : null;
  apply(attacker, attackItem, primaryDefender, primaryDefenseItem, 'attack');
  const attackerPartner = attacker.strikePartner;
  apply(
    attackerPartner,
    attackerPartner ? getEquippedWeapon(attackerPartner, game.db, game) : null,
    primaryDefender,
    primaryDefenseItem,
    'attack',
  );
  for (const defender of defenders) {
    const defenderPartner = defender.strikePartner;
    apply(
      defenderPartner,
      defenderPartner ? getEquippedWeapon(defenderPartner, game.db, game) : null,
      attacker,
      attackItem,
      'defense',
    );
    apply(
      defender,
      getEquippedWeapon(defender, game.db, game),
      attacker,
      attackItem,
      'defense',
    );
  }
}

export interface SkillAbilityOption {
  skill: SkillObject;
  item: ItemObject;
  component: 'ability' | 'ability_attack_charge' | 'ability_parent';
}

/** Python skill_system.get_extra_abilities, with stable registered item identity. */
export function getSkillAbilityOptions(game: any, unit: UnitObject): SkillAbilityOption[] {
  const result: SkillAbilityOption[] = [];
  const components = [
    'ability',
    'ability_attack_charge',
    'ability_parent',
  ] as const;
  const registerTree = (item: ItemObject, key: string): void => {
    game.items.set(key, item);
    item.subitems.forEach((child, index) =>
      registerTree(child, `${key}_sub_${index}_${child.nid}`));
  };
  for (const skill of unit.skills) {
    const total = Number(skill.data.get('total_charge'));
    const charge = Number(skill.data.get('charge'));
    if (skill.hasComponent('build_charge') && Number.isFinite(total) && charge < total) {
      continue;
    }
    if (hasDrainingCharge(skill) && Number.isFinite(charge) && charge <= 0) continue;
    if (!skillConditionActive(skill, unit, { game })) continue;
    for (const component of components) {
      const itemNid = skill.getComponent<string>(component);
      if (!itemNid) continue;
      const prefab = game.db.items.get(itemNid);
      if (!prefab) continue;
      const dataKey = `abilityItemKey:${component}`;
      let registryKey = skill.data.get(dataKey);
      let item = typeof registryKey === 'string'
        ? game.items.get(registryKey) as ItemObject | undefined
        : undefined;
      if (!item || item.nid !== itemNid) {
        registryKey = `ability_${unit.nid}_${skill.uid}_${component}_${itemNid}`;
        item = createItemTree(prefab, (nid) => game.db.items.get(nid));
        registerTree(item, registryKey);
        skill.data.set(dataKey, registryKey);
      }
      item.owner = unit;
      result.push({ skill, item, component });
    }
  }
  return result;
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

/**
 * Python TradeAbility.targets: adjacent allies that can trade, plus the
 * unit's own traveler. No has_traded / has_attacked gate — trading again
 * is allowed; the trade constant disables it entirely.
 */
function getTradePartners(unit: UnitObject): UnitObject[] {
  const game = getGame();
  if (!game.db.getConstant('trade', true) || !unit.position) return [];
  const partners = getAdjacentAllies(unit, unit.position[0], unit.position[1])
    .filter((ally) => canTradeWith(unit, ally, game.db, game));
  const traveler: UnitObject | null = unit.traveler ? game.getUnit(unit.traveler) ?? null : null;
  if (traveler && canTradeWith(unit, traveler, game.db, game)) partners.push(traveler);
  return partners;
}

/**
 * Python unit_funcs.wait: fire unit_wait (actively_chosen local arg), then
 * mark the unit finished.
 */
function waitUnit(game: any, unit: UnitObject, activelyChosen: boolean): void {
  if (unit.position && game.eventManager) {
    const levelNid = game.currentLevel?.nid ?? '';
    const region = getRegionUnderPos(unit.position[0], unit.position[1]);
    const ctx = { game, unit1: unit, region, gameVars: game.gameVars, levelVars: game.levelVars };
    game.eventManager.trigger(
      {
        type: 'unit_wait', levelNid, unitNid: unit.nid, unit1: unit,
        position: [unit.position[0], unit.position[1]],
        region: region ?? undefined,
        localArgs: new Map<string, any>([['actively_chosen', activelyChosen]]),
      },
      ctx,
    );
  }
  game.actionLog.doAction(new WaitAction(unit));
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
    if (!region.position) continue;
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
        const movementGroup = movementType(
          traveler,
          game.db.classes.get(traveler.klass)?.movement_group ?? 'Infantry',
          game,
        );
        if (board.getMovementCost(nx, ny, movementGroup, game.db) >= 99) continue;
      }
      tiles.push([nx, ny]);
    }
  }
  return tiles;
}

/**
 * Enter a freshly loaded level the way Python's TurnChangeState.end does at
 * level start: free, then the player phase_change (banner, unit reset,
 * status upkeep, autocursor), with the level_start events on top.
 */
export function enterStartedLevel(game: any): void {
  game.state.clear();
  game.state.change('free');
  game.state.change('phase_change');
  if (game.eventManager?.hasActiveEvents()) game.state.change('event');
}

/**
 * Python Simple.get_topleft with a parent menu: child menus open beside the
 * parent's current row.
 */
export function placeChildMenu(child: ChoiceMenu, parent: ChoiceMenu): void {
  const row = parent.selectedIndex;
  if (parent.x < viewport.width / 2) {
    child.x = parent.x - 20 + parent.width;
    child.y = parent.y + row * 16 + 4;
  } else {
    child.x = viewport.width - 40 - parent.width;
    child.y = parent.y + row * 16 + 8;
  }
}

/**
 * Python LevelCursor.autocursor(immediate=True): first Lord-tagged player
 * unit on the map, else the first player unit; camera centred at once.
 */
export function autocursorImmediate(game: any): void {
  if (!game.cursor || !game.currentLevel) return;
  const players = (game.getAllUnits() as UnitObject[]).filter((unit) => unit.team === 'player' && !!unit.position);
  const target = players.find((unit) => unit.tags.includes('Lord')) ?? players[0];
  if (!target?.position) return;
  game.cursor.setPos(target.position[0], target.position[1]);
  game.camera?.focusTile?.(target.position[0], target.position[1]);
}

/** Python equations RESCUE_AID(carrier) >= RESCUE_WEIGHT(carried). */
function canCarry(carrier: UnitObject, carried: UnitObject, game: any): boolean {
  const aidExpr = game.db.getEquation?.('RESCUE_AID');
  const weightExpr = game.db.getEquation?.('RESCUE_WEIGHT');
  if (!aidExpr || !weightExpr) return true;
  try {
    return evaluateEquation(aidExpr, carrier, { db: game.db }) >=
      evaluateEquation(weightExpr, carried, { db: game.db });
  } catch {
    return true;
  }
}

/**
 * Python menus.Choice placement with no explicit topleft: (14, 8) when the
 * cursor is right of the screen's middle column, else flush right at
 * WINWIDTH - width - 14.
 */
function placeAutoMenu(menu: { x: number; y: number; width: number }, game: any): void {
  const cursorX = game.cursor?.getPosition?.()?.[0] ?? 0;
  const cameraX = Math.floor((game.camera?.getOffset?.()?.[0] ?? 0) / TILEWIDTH);
  const tilesAcross = Math.floor(viewport.width / TILEWIDTH);
  menu.y = 8;
  menu.x = cursorX > Math.floor(tilesAcross / 2) + cameraX ? 14 : viewport.width - menu.width - 14;
}

function canUnitStandAt(unit: UnitObject, x: number, y: number): boolean {
  const game = getGame();
  const movementGroup = movementType(
    unit,
    game.db.classes.get(unit.klass)?.movement_group ?? 'Infantry',
    game,
  );
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

function imageHasVisiblePixels(image: HTMLImageElement): boolean {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth || image.width;
    canvas.height = image.naturalHeight || image.height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context || canvas.width === 0 || canvas.height === 0) return false;
    context.drawImage(image, 0, 0);
    const alpha = context.getImageData(0, 0, canvas.width, canvas.height).data;
    for (let index = 3; index < alpha.length; index += 4) {
      if (alpha[index] !== 0) return true;
    }
    return false;
  } catch {
    // If pixel inspection is unavailable, trust the loaded project asset.
    return true;
  }
}

function drawTitleAssetFrame(
  surf: Surface,
  image: HTMLImageElement | SpriteImage,
  sx: number,
  sy: number,
  sw: number,
  sh: number,
  dx: number,
  dy: number,
): void {
  if (sw <= 0 || sh <= 0) return;
  const scale = surf.scale;
  surf.ctx.save();
  surf.ctx.imageSmoothingEnabled = false;
  surf.ctx.drawImage(
    image,
    sx, sy, sw, sh,
    Math.round(dx * scale), Math.round(dy * scale),
    Math.round(sw * scale), Math.round(sh * scale),
  );
  surf.ctx.restore();
}

function titleSceneBounds(): { x: number; y: number; width: number; height: number } {
  const width = Math.min(240, viewport.width);
  const height = Math.min(160, viewport.height);
  return {
    x: Math.floor((viewport.width - width) / 2),
    y: Math.floor((viewport.height - height) / 2),
    width,
    height,
  };
}

function drawTitleBackground(surf: Surface, image: HTMLImageElement | null): void {
  surf.fill(9, 12, 24);
  if (!image) return;
  const scene = titleSceneBounds();
  const scale = surf.scale;
  const imageWidth = image.naturalWidth || scene.width;
  const imageHeight = image.naturalHeight || scene.height;
  surf.ctx.imageSmoothingEnabled = false;
  surf.ctx.drawImage(
    image,
    0, 0, imageWidth, imageHeight,
    Math.round(scene.x * scale), Math.round(scene.y * scale),
    Math.round(scene.width * scale), Math.round(scene.height * scale),
  );
}

export class TitleState extends State {
  readonly name = 'title';
  override readonly showMap = false;
  override readonly inLevel = false;

  private bgImage: HTMLImageElement | null = null;
  private logoImage: HTMLImageElement | null = null;
  private pressStartImage: HTMLImageElement | null = null;
  private logoAssetLoaded: boolean = false;
  private pressStartAssetLoaded: boolean = false;
  /** Set once the custom_sprites lookups have resolved (engine fallback). */
  private logoChecked = false;
  private pressStartChecked = false;
  private pulseTimer: number = 0;

  override start(): StateResult {
    const game = getGame();
    this.bgImage = null;
    this.logoImage = null;
    this.pressStartImage = null;
    this.logoAssetLoaded = false;
    this.pressStartAssetLoaded = false;
    this.logoChecked = false;
    this.pressStartChecked = false;
    this.pulseTimer = 0;
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
    game.resources.tryLoadImage('resources/custom_sprites/logo.png').then((image: HTMLImageElement | null) => {
      this.logoAssetLoaded = !!image;
      this.logoChecked = true;
      this.logoImage = image && imageHasVisiblePixels(image) ? image : null;
    });
    game.resources.tryLoadImage('resources/custom_sprites/press_start.png').then((image: HTMLImageElement | null) => {
      this.pressStartAssetLoaded = !!image;
      this.pressStartChecked = true;
      this.pressStartImage = image && imageHasVisiblePixels(image) ? image : null;
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
    const scene = titleSceneBounds();
    drawTitleBackground(surf, this.bgImage);

    // Python SPRITES['logo']: the project custom_sprites logo, else the engine one.
    const logo = this.logoImage ?? (this.logoChecked && !this.logoAssetLoaded ? getMenuSprite('logo') : null);
    if (logo) {
      // Python TitleStartState: gui.Logo(logo, (WINWIDTH//2, clamp(WINHEIGHT//2 - 40,
      // logo_h//2, WINHEIGHT//2)), num_frames=1) blitted 1:1, centered.
      const logoW = logo.width;
      const logoH = logo.height;
      const centerY = Math.max(80 - 40, Math.min(Math.floor(logoH / 2), 80));
      drawTitleAssetFrame(surf, logo, 0, 0, logoW, logoH,
        scene.x + 120 - Math.floor(logoW / 2), scene.y + centerY - Math.floor(logoH / 2));
    }

    const pressStart = this.pressStartImage ?? (this.pressStartChecked && !this.pressStartAssetLoaded ? getMenuSprite('press_start') : null);
    if (pressStart) {
      // Python gui.Logo(press_start, (WINWIDTH//2, 4*WINHEIGHT//5)): an
      // 8-frame vertical strip played 0,0,1..6,7,7,6..1 at 64ms per frame.
      const sheetW = pressStart.width;
      const sheetH = pressStart.height;
      const numFrames = 8;
      const frameH = Math.floor(sheetH / numFrames);
      const anim = [0, 0, 1, 2, 3, 4, 5, 6, 7, 7, 6, 5, 4, 3, 2, 1];
      const frame = anim[Math.floor(this.pulseTimer / 64) % anim.length];
      drawTitleAssetFrame(surf, pressStart, 0, frame * frameH, sheetW, frameH,
        scene.x + 120 - Math.floor(sheetW / 2), scene.y + 128 - Math.floor(frameH / 2));
    }

    // Python: FONT['text'].blit(translate('_attribution'), surf, (4, WINHEIGHT - 16))
    surf.drawText(getGame().db.translate?.('_attribution') ?? '_attribution', scene.x + 4, scene.y + 160 - 16, 'white', 'text');

    return surf;
  }

  override takeInput(event: InputEvent): StateResult {
    const game = getGame();
    if (event === 'START' || event === 'SELECT' || game.input?.mouseClick === 'SELECT') {
      game.audioManager.resume();
      game.audioManager.playSfx('Start');
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

  private bg: MenuBackground | null = null;
  private scene = new MenuScene();
  private options: string[] = ['New Game', 'Extras'];
  private menu: TitleMainMenu = new TitleMainMenu(['New Game', 'Extras']);
  /** Python TitleMainState.state: menu slides in/out horizontally. */
  private phase: 'transition_in' | 'normal' | 'transition_out' = 'transition_in';
  private positionX = -WINWIDTH / 2;
  private selection: string | null = null;
  private hasSaveData: boolean = false;
  private hasSuspendData: boolean = false;
  private suspendWarned: boolean = false;
  private banner: Banner | null = null;
  private busy: boolean = false;

  override start(): StateResult {
    const game = getGame();
    this.bg = new MenuBackground('title_background', game.resources, false);
    preloadTitleMenuSprites();
    this.phase = 'transition_in';
    this.positionX = -WINWIDTH / 2;
    this.selection = null;

    // Python TitleMainState.start: ['New Game', 'Extras'], with
    // 'Load Game'/'Restart Level' in front when any save slot has data and
    // 'Continue' first when a suspend exists.
    const gameNid = game.db?.getConstant?.('game_nid', 'default') ?? 'default';
    const numSlots = game.db?.getConstant?.('num_save_slots', 3) ?? 3;
    this.hasSaveData = false;
    this.hasSuspendData = false;
    this.suspendWarned = false;
    this.banner = null;
    this.busy = false;
    this.rebuildOptions();
    Promise.all([
      loadSaveSlots(gameNid as string, numSlots as number),
      hasSuspend(gameNid as string),
    ]).then(([slots, hasSusp]) => {
      this.hasSaveData = slots.some(s => s.name !== '--NO DATA--');
      this.hasSuspendData = hasSusp;
      this.rebuildOptions();
    }).catch(() => {
      // Ignore errors — just show default options
    });
  }

  override begin(): StateResult {
    this.busy = false;
  }

  private rebuildOptions(): void {
    const opts: string[] = ['New Game', 'Extras'];
    if (this.hasSaveData) {
      opts.unshift('Restart Level');
      opts.unshift('Load Game');
    }
    if (this.hasSuspendData) {
      opts.unshift('Continue');
    }
    const current = this.menu.getCurrent();
    this.options = opts;
    this.menu = new TitleMainMenu(opts, 'title_menu_dark', (t) => getGame().db?.translate?.(t) ?? t);
    const keep = opts.indexOf(current);
    if (keep >= 0) this.menu.currentIndex = keep;
  }

  override update(): StateResult {
    const game = getGame();
    this.menu.update();
    this.bg?.update();
    if (this.banner && this.banner.update(game.frameDeltaMs ?? 16)) {
      this.banner = null;
    }
    if (this.phase === 'transition_in') {
      this.positionX += 20;
      if (this.positionX >= WINWIDTH / 2) {
        this.positionX = WINWIDTH / 2;
        this.phase = 'normal';
      }
    } else if (this.phase === 'transition_out') {
      this.positionX -= 20;
      if (this.positionX <= -WINWIDTH / 2) {
        this.positionX = -WINWIDTH / 2;
        this.phase = 'transition_in';
        this.choose(this.selection);
      }
    }
  }

  override draw(surf: Surface): Surface {
    if (this.bg) this.bg.draw(surf);
    else surf.fill(0, 0, 0);
    const s = this.scene.begin();
    this.menu.draw(s, this.positionX, WINHEIGHT / 2, { showCursor: this.phase === 'normal' });
    this.scene.present(surf);
    if (this.banner) this.banner.draw(surf);
    return surf;
  }

  /** Python TitleMainState.update transition_out branch. */
  private choose(selected: string | null): void {
    const game = getGame();
    if (selected === 'New Game') {
      game.state.change('title_mode');
    } else if (selected === 'Load Game') {
      game.memory.set('load_menu_mode', 'load');
      game.state.change('load_menu');
    } else if (selected === 'Restart Level') {
      game.memory.set('load_menu_mode', 'restart');
      game.state.change('load_menu');
    } else if (selected === 'Extras') {
      game.state.change('title_extras');
    }
  }

  override takeInput(event: InputEvent): StateResult {
    const game = getGame();
    if (this.banner) {
      // Python: dismissing the suspend alert continues with the selection.
      if (event) {
        this.banner = null;
        this.phase = 'transition_out';
      }
      return;
    }
    if (this.phase !== 'normal' || this.busy) return;

    if (event === 'DOWN') {
      if (this.menu.moveDown()) game.audioManager.playSfx('Select 6');
    } else if (event === 'UP') {
      if (this.menu.moveUp()) game.audioManager.playSfx('Select 6');
    } else if (event === 'SELECT' || game.input?.mouseClick === 'SELECT') {
      const selected = this.menu.getCurrent();
      this.selection = selected;
      game.audioManager.playSfx('Select 1');
      if (selected === 'Continue') {
        // Python continue_suspend: load the suspend and delete it.
        this.busy = true;
        void loadSuspendSave(game).then((ok: boolean) => {
          this.busy = false;
          if (ok) {
            // Python GameState.load restores the saved state stack and
            // autocursors immediately.
            if (game.state.getStackNames().length === 0) game.state.change('free');
            autocursorImmediate(game);
          }
        });
      } else if (this.hasSuspendData && !this.suspendWarned &&
          (selected === 'New Game' || selected === 'Load Game' || selected === 'Restart Level')) {
        // Python shows this alert once before an action that drops the suspend.
        const verb = selected === 'New Game' ? 'Starting a new game'
          : selected === 'Load Game' ? 'Loading a game' : 'Restarting a game';
        this.banner = new Banner(`${verb} will remove suspend!`, undefined, 3000);
        this.suspendWarned = true;
      } else {
        this.phase = 'transition_out';
      }
    } else if (event === 'BACK') {
      game.audioManager.playSfx('Select 4');
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
    // begin() runs right after start() on the first push; running the phase
    // setup in both pushed the next state twice.
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
      game.state.change('title_new');
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

    game.state.change('title_new');
  }

  private applyDeathChoice(): void {
    const game = getGame();
    game.currentMode.permadeath = this.menuOptions[this.cursor] === 'Classic';
    if (this.requiresGrowthChoice) {
      this.phase = 'growth_setup';
      this.cursor = 0;
      this.startGrowthSelection();
    } else {
      game.state.change('title_new');
    }
  }

  private applyGrowthChoice(): void {
    const game = getGame();
    game.currentMode.growths = this.menuOptions[this.cursor];
    game.state.change('title_new');
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

  private modeMenu: ModeSelectMenu | null = null;
  private modeBg: MenuBackground | null = null;
  private modeScene = new MenuScene();

  override update(): StateResult {
    this.modeMenu?.update();
    this.modeBg?.update();
  }

  /** Python TitleModeState.draw: label box, option description, ModeSelect. */
  override draw(surf: Surface): Surface {
    const game = getGame();
    if (!this.modeBg) this.modeBg = new MenuBackground('title_background', game.resources, false);
    this.modeBg.draw(surf);
    const translate = (t: string): string => game.db?.translate?.(t) ?? t;
    if (!this.modeMenu || this.modeMenu.options.join('|') !== this.menuOptions.join('|')) {
      this.modeMenu = new ModeSelectMenu(this.menuOptions.slice(), translate);
    }
    this.modeMenu.currentIndex = this.cursor;
    const s = this.modeScene.begin();
    // Label: base surf 96x88 with menu_shimmer2, translucent .1, at (142, 36).
    const label = new Surface(96, 88);
    label.blit(getMenuBackgroundSync(96, 88), 0, 0);
    const shimmer = getMenuSprite('menus/menu_shimmer2');
    if (shimmer) label.blitImage(shimmer, 0, 0, shimmer.width, shimmer.height, 95 - shimmer.width, 83 - shimmer.height);
    label.setAlpha(0.9);
    s.blit(label, 142, 36);
    // Dialog(option + '_desc') at (140, 34), text width WINWIDTH - 154, 4 lines.
    const option = this.menuOptions[this.cursor];
    if (option) {
      const desc = translate(`${option}_desc`);
      lineWrap('text', desc, WINWIDTH - 142 - 12).slice(0, 4).forEach((line, i) => {
        drawStyledText(s, line, 148, 42 + i * 16, 'white', 'text');
      });
    }
    this.modeMenu.draw(s, 68, WINHEIGHT / 2);
    this.modeScene.present(surf);
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
// 1a1a. TitleExtrasState — Python title_screen.TitleExtrasState
// Options / Credits (the 'Global Credits' event when the project has one).
// ============================================================================

export class TitleExtrasState extends State {
  readonly name = 'title_extras';
  override readonly showMap = false;
  override readonly inLevel = false;

  private bg: MenuBackground | null = null;
  private scene = new MenuScene();
  private menu = new TitleMainMenu(['Options', 'Credits']);
  /** TitleLoadState slide: in from 1.5 * WINWIDTH, out the same way. */
  private phase: 'transition_in' | 'normal' | 'transition_out' = 'transition_in';
  private positionX = Math.floor(WINWIDTH * 1.5);

  override start(): StateResult {
    const game = getGame();
    const options = ['Options', 'Credits'];
    if (game.db.getConstant('title_sound', false) && game.state.hasState?.('extras_sound_room')) {
      options.push('Sound Room');
    }
    this.menu = new TitleMainMenu(options, 'title_menu_dark', (t) => game.db?.translate?.(t) ?? t);
    this.bg = new MenuBackground('title_background', game.resources, false);
    preloadTitleMenuSprites();
    this.phase = 'transition_in';
    this.positionX = Math.floor(WINWIDTH * 1.5);
  }

  override update(): StateResult {
    this.menu.update();
    this.bg?.update();
    if (this.phase === 'transition_in') {
      this.positionX -= 20;
      if (this.positionX <= WINWIDTH / 2) {
        this.positionX = WINWIDTH / 2;
        this.phase = 'normal';
      }
    } else if (this.phase === 'transition_out') {
      this.positionX += 20;
      if (this.positionX >= Math.floor(WINWIDTH * 1.5)) {
        this.positionX = Math.floor(WINWIDTH * 1.5);
        this.phase = 'transition_in';
        getGame().state.back();
        return 'repeat';
      }
    }
  }

  override draw(surf: Surface): Surface {
    if (this.bg) this.bg.draw(surf);
    else surf.fill(0, 0, 0);
    const s = this.scene.begin();
    this.menu.draw(s, this.positionX, WINHEIGHT / 2);
    this.scene.present(surf);
    return surf;
  }

  override takeInput(event: InputEvent): StateResult {
    const game = getGame();
    if (this.phase !== 'normal') return;
    if (event === 'UP') {
      if (this.menu.moveUp()) game.audioManager.playSfx('Select 6');
    } else if (event === 'DOWN') {
      if (this.menu.moveDown()) game.audioManager.playSfx('Select 6');
    } else if (event === 'BACK') {
      game.audioManager.playSfx('Select 4');
      this.phase = 'transition_out';
    } else if (event === 'SELECT' || game.input?.mouseClick === 'SELECT') {
      game.audioManager.playSfx('Select 1');
      const selection = this.menu.getCurrent();
      if (selection === 'Options') {
        game.state.change('settings_menu');
      } else if (selection === 'Credits') {
        if (game.db.events.has('Global Credits') && game.eventManager?.triggerSpecific('Global Credits', { type: 'credits' }, true)) {
          game.state.change('event');
        } else {
          game.state.change('credit');
        }
      } else if (selection === 'Sound Room') {
        game.state.change('extras_sound_room');
      }
    }
  }
}

// ============================================================================
// 1a1b. TitleNewState — choose a save slot and build a new game.
// Port of lt-maker/app/engine/title_screen.py TitleNewState /
// TitleNewChildState / build_new_game: selecting an empty slot (or confirming
// "Overwrite" on a used one) resets the game (GameState.buildNew), keeps the
// chosen difficulty, starts the first level (skipping DEBUG), and writes a
// 'start' save into the slot while removing any suspend.
// ============================================================================

export class TitleNewState extends State {
  readonly name = 'title_new';
  override readonly showMap = false;
  override readonly inLevel = false;

  private bg: MenuBackground | null = null;
  private scene = new MenuScene();
  private slots: { idx: number; used: boolean }[] = [];
  private menu: ChapterSelectMenu | null = null;
  private loaded = false;
  /** TitleNewChildState Overwrite/Back choice, when open. */
  private child: HorizontalChoice | null = null;
  private building = false;
  private phase: 'transition_in' | 'normal' | 'transition_out' = 'transition_in';
  private positionX = Math.floor(WINWIDTH * 1.5);

  override start(): StateResult {
    const game = getGame();
    this.loaded = false;
    this.child = null;
    this.building = false;
    this.menu = null;
    this.phase = 'transition_in';
    this.positionX = Math.floor(WINWIDTH * 1.5);
    this.bg = new MenuBackground('title_background', game.resources, false);
    preloadTitleMenuSprites();
    const gameNid = game.db?.getConstant?.('game_nid', 'default') ?? 'default';
    const numSlots = Number(game.db?.getConstant?.('num_save_slots', 3) ?? 3) || 1;
    loadSaveSlots(gameNid as string, numSlots).then((slots) => {
      this.slots = slots.map((slot) => ({ idx: slot.idx, used: slot.name !== '--NO DATA--' }));
      this.menu = chapterSelectFromSlots(slots, game.db);
      const recent = slots.reduce((best, slot, i) => (slot.realtime > (slots[best]?.realtime ?? -1) ? i : best), 0);
      this.menu.moveTo(recent);
      this.loaded = true;
    }).catch(() => {
      this.slots = Array.from({ length: numSlots }, (_, idx) => ({ idx, used: false }));
      this.menu = chapterSelectFromSlots(this.slots.map(() => ({ name: '--NO DATA--' })), game.db);
      this.loaded = true;
    });
  }

  override update(): StateResult {
    this.menu?.update();
    this.child?.update();
    this.bg?.update();
    if (this.phase === 'transition_in') {
      this.positionX -= 20;
      if (this.positionX <= WINWIDTH / 2) {
        this.positionX = WINWIDTH / 2;
        this.phase = 'normal';
      }
    } else if (this.phase === 'transition_out') {
      this.positionX += 20;
      if (this.positionX >= Math.floor(WINWIDTH * 1.5)) {
        this.positionX = Math.floor(WINWIDTH * 1.5);
        this.phase = 'transition_in';
        // Python TitleNewState.back(): also pop an auto-advanced title_mode.
        const game = getGame();
        const stack: string[] = game.state.getStackNames?.() ?? [];
        if (stack[stack.length - 2] === 'title_mode') game.state.back();
        game.state.back();
        return 'repeat';
      }
    }
  }

  override draw(surf: Surface): Surface {
    if (this.bg) this.bg.draw(surf);
    else surf.fill(0, 0, 0);
    const s = this.scene.begin();
    this.menu?.draw(s, this.positionX, WINHEIGHT / 2);
    this.child?.draw(s, 8, WINHEIGHT - 24);
    this.scene.present(surf);
    return surf;
  }

  override takeInput(event: InputEvent): StateResult {
    const game = getGame();
    if (!this.loaded || this.building || !this.menu) return;
    if (this.child) {
      if (event === 'RIGHT') {
        if (this.child.moveDown()) game.audioManager.playSfx('Select 6');
      } else if (event === 'LEFT') {
        if (this.child.moveUp()) game.audioManager.playSfx('Select 6');
      } else if (event === 'BACK') {
        game.audioManager.playSfx('Select 4');
        this.child = null;
      } else if (event === 'SELECT') {
        if (this.child.getCurrent() === 'Overwrite') {
          void this.buildNewGame(this.slots[this.menu.currentIndex].idx);
        } else {
          game.audioManager.playSfx('Select 4');
          this.child = null;
        }
      }
      return;
    }
    if (this.phase !== 'normal') return;
    if (event === 'UP') {
      if (this.menu.moveUp()) game.audioManager.playSfx('Select 6');
    } else if (event === 'DOWN') {
      if (this.menu.moveDown()) game.audioManager.playSfx('Select 6');
    } else if (event === 'BACK') {
      game.audioManager.playSfx('Select 4');
      this.phase = 'transition_out';
    } else if (event === 'SELECT' || game.input?.mouseClick === 'SELECT') {
      const slot = this.slots[this.menu.currentIndex];
      if (!slot) return;
      if (slot.used) {
        game.audioManager.playSfx('Select 1');
        this.child = new HorizontalChoice(['Overwrite', 'Back']);
      } else {
        void this.buildNewGame(slot.idx);
      }
    }
  }

  private async buildNewGame(slot: number): Promise<void> {
    const game = getGame();
    this.building = true;
    game.audioManager.playSfx('Save');
    const oldMode = game.currentMode;
    game.buildNew();
    game.currentMode = oldMode;
    game.currentSaveSlot = slot;
    const levels: string[] = [...game.db.levels.keys()];
    let firstLevel = levels[0];
    if (firstLevel === 'DEBUG' && levels.length > 1) firstLevel = levels[1];
    try {
      await game.loadLevel(firstLevel);
    } catch (err) {
      console.error('TitleNewState: failed to start first level', err);
      this.building = false;
      return;
    }
    game.gameVars.set('_next_level_nid', firstLevel);
    try {
      const gameNid = game.db?.getConstant?.('game_nid', 'default') ?? 'default';
      await doSaveGame(game, slot, 'start');
      await deleteSuspend(gameNid as string);
    } catch (err) {
      console.warn('TitleNewState: failed to write start save', err);
    }
    enterStartedLevel(game);
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
      'text',
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
        surf.drawText('>', this.LIST_X - 2, y, 'yellow', 'text');
      }

      // Level name
      const color = isSelected ? 'white' : 'grey';
      surf.drawText(level.name, this.LIST_X + 8, y, color, 'text');
    }

    // Scroll indicators
    if (this.scrollOffset > 0) {
      surf.drawText('^', Math.floor(vw / 2), this.LIST_Y - 10, 'grey', 'text');
    }
    if (visibleEnd < this.levels.length) {
      const bottomY = this.LIST_Y + this.VISIBLE_ROWS * this.ROW_HEIGHT;
      surf.drawText('v', Math.floor(vw / 2), bottomY, 'grey', 'text');
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
        'text',
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
  /** Python OptionChildState Yes/No for End / Suspend / Save. */
  private confirm: ChoiceMenu | null = null;
  private confirmOwner: string | null = null;

  override begin(): StateResult {
    const game = getGame();
    // Python OptionMenuState._populate_options: Objective, Options, then
    // Suspend (permadeath) or Save, then End (not in roam); Guide at index 2
    // when guide lore is unlocked; Turnwheel at index 1 when enabled; custom
    // options inserted before Options.
    // TODO(qa): Python lists 'Unit' first (unit_menu); not ported yet.
    const options: MenuOption[] = [
      { label: 'Objective', value: 'objective', enabled: !!game.currentLevel },
      { label: 'Options', value: 'options', enabled: true },
    ];
    if (game.currentMode?.permadeath) {
      options.push({ label: 'Suspend', value: 'suspend', enabled: true });
    } else {
      options.push({ label: 'Save', value: 'save', enabled: true });
    }
    const roam = !!game.roamInfo?.roam;
    if (!roam) options.push({ label: 'End', value: 'end_turn', enabled: true });
    const guideUnlocked = [...(game.db.lore?.values?.() ?? [])].some((lore: any) =>
      lore.category === 'Guide' && (game.unlockedLore ?? []).includes(lore.nid));
    if (guideUnlocked && game.state.hasState?.('base_guide')) {
      options.splice(Math.min(2, options.length), 0, { label: 'Guide', value: 'guide', enabled: true });
    }
    const turnwheelConstant = game.db?.getConstant?.('turnwheel', null) ?? null;
    if (turnwheelConstant && game.gameVars.get('_turnwheel') && !roam) {
      options.splice(1, 0, { label: 'Turnwheel', value: 'turnwheel', enabled: true });
    }
    // Custom options from set_custom_options (Python general_states.py:463):
    // inserted before 'Options', disabled per _custom_options_disabled.
    const customOpts: string[] = game.gameVars.get('_custom_additional_options') ?? [];
    const customDisabled: boolean[] = game.gameVars.get('_custom_options_disabled') ?? [];
    const optionsIndex = options.findIndex((o) => o.value === 'options');
    options.splice(optionsIndex, 0, ...customOpts.map((label: string, idx: number) => ({
      label, value: `custom:${idx}`, enabled: !customDisabled[idx],
    })));

    this.menu = new ChoiceMenu(options, 0, 8);
    placeAutoMenu(this.menu, game);
    this.confirm = null;
    this.confirmOwner = null;
  }

  override takeInput(event: InputEvent): StateResult {
    if (!this.menu) return;
    const game = getGame();

    if (this.confirm) {
      const answer = event !== null ? this.confirm.handleInput(event) : null;
      if (!answer) return;
      const owner = this.confirmOwner;
      this.confirm = null;
      this.confirmOwner = null;
      if ('back' in answer || answer.selected !== 'Yes' || !owner) return;
      this.executeOption(owner);
      return;
    }

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
        let eventNid = evName;
        if (evName && !game.db.events.has(eventNid)) {
          const byName = [...game.db.events.values()].find(
            (candidate: any) => candidate.name === evName &&
              (!candidate.level_nid || candidate.level_nid === game.currentLevel?.nid),
          );
          if (byName) eventNid = byName.nid;
        }
        if (eventNid && game.eventManager.triggerSpecific(eventNid, { type: evName }, true)) {
          game.state.change('event');
        }
        return;
      }
      const selected = result.selected;
      if ((selected === 'end_turn' || selected === 'suspend' || selected === 'save') &&
          getSetting('confirm_end')) {
        // Python: confirm_end routes these through OptionChildState (Yes/No).
        this.confirmOwner = selected;
        this.confirm = new ChoiceMenu([
          { label: 'Yes', value: 'Yes', enabled: true },
          { label: 'No', value: 'No', enabled: true },
        ], 0, 0);
        placeChildMenu(this.confirm, this.menu);
        return;
      }
      this.executeOption(selected);
    }
  }

  private executeOption(selected: string): void {
    const game = getGame();
    {
      switch (selected) {
        case 'guide': {
          this.menu = null;
          game.state.back();
          game.state.change('base_guide');
          break;
        }
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
        case 'objective': {
          this.menu = null;
          game.state.back();
          game.state.change('objective_menu');
          break;
        }
        case 'save': {
          this.menu = null;
          game.state.back();
          game.state.change('save_menu');
          break;
        }
        case 'suspend': {
          // Python general_states.suspend: back(), process_temp_state(),
          // then save, so the suspend records the stack beneath the menu.
          this.menu = null;
          game.state.back();
          game.state.flushPending?.();
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
    this.confirm?.draw(surf);
    return surf;
  }
}

// ============================================================================
// 2. FreeState
// ============================================================================

export class FreeState extends MapState {
  readonly name = 'free';
  private auraHoverNid: string | null = null;

  override begin(): StateResult {
    const game = getGame();
    const board = getBoard();

    // Clear any stale highlights from previous states (matching Python's FreeState.begin)
    game.highlight.clear();
    this.auraHoverNid = null;

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

    // Preserve Python's initial turnwheel anchor, then close only a real unit
    // action group. Event/state returns must not append orphan markers that
    // consume the first turnwheel step.
    if (game.actionLog.actionIndex < 0 || game.actionLog.hasOpenActionGroup()) {
      game.actionLog.doAction(new MarkActionGroupEnd('free'));
    }

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
    }
    // Python FreeState.begin leaves the cursor where it is; the player-phase
    // start applies the autocursor setting instead (PhaseChangeState).
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
        if (unit && unit.team === 'player' && unit.canStillAct() && canSelect(unit, game)) {
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
        // Python FreeState: BACK does nothing (holding it speeds the cursor).
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
        // Python FreeState: START toggles the initiative bar, else opens the
        // minimap (minimap constant + _minimap game var), else errors.
        if (game.initiative) {
          game.initiative.toggleDraw();
        } else if (game.db.getConstant('minimap', true) && game.gameVars.get('_minimap') !== false) {
          game.state.change('minimap');
        } else {
          game.audioManager?.playSfx?.('Error');
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

    const pos = game.cursor.getHover();
    const unit = game.board.getUnit(pos.x, pos.y);
    const auraHoverNid = unit?.nid ?? null;
    if (auraHoverNid !== this.auraHoverNid) {
      game.highlight.setAuraHighlights(
        unit ? auraHighlightPositions(unit, game.board) : [],
      );
      this.auraHoverNid = auraHoverNid;
    }

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
      // Standard mode: Python auto-ends when the autoend_turn setting is on
      // and every selectable player unit has finished.
      const playerUnits: UnitObject[] = game.board.getTeamUnits('player');
      if (playerUnits.length > 0 && getSetting('autoend_turn')) {
        const allFinished = playerUnits.every((u) => u.finished || u.isDead() || u.tags.includes('Tile'));
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
    // pop back to FreeState by clearing the selection and returning. A unit
    // that attacked or traded but is not finished is in Canto (Python
    // MoveState with has_attacked / has_traded).
    const canto = !unit.finished && (unit.hasAttacked || unit.hasTraded);
    if (unit.finished || (!unit.canStillAct() && !canto)) {
      game.selectedUnit = null;
      game._moveOrigin = null;
      game.highlight.clear();
      game.state.back();
      return 'repeat';
    }

    this.previousPosition = [unit.position[0], unit.position[1]];
    // Save origin so MenuState can undo the move
    game._moveOrigin = [unit.position[0], unit.position[1]];

    // Compute valid moves + attack positions (Python: a unit that traded
    // only shows its remaining moves).
    this.validMoves = game.pathSystem.getValidMoves(unit, game.board);
    this.attackPositions = unit.hasTraded ? [] : game.pathSystem.getAttackPositions(
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

          // Python: a Canto move (after attacking/trading) goes to
          // canto_wait instead of the full action menu.
          const nextState = unit.hasAttacked || unit.hasTraded ? 'canto_wait' : 'menu';
          // If we have a path with length > 1, animate movement
          if (path && path.length > 1) {
            game.movementSystem.beginMove(unit, path, undefined, () => {
              // After movement animation completes, push the next state
            });
            game.state.change('movement');
            game._pendingAfterMovement = nextState;
          } else {
            // Already at destination or single tile, push directly
            game.state.change(nextState);
          }
        }
        break;
      }

      case 'BACK': {
        const deselectedUnit: UnitObject | null = game.selectedUnit;
        // Python MoveState: a Canto unit cannot cancel its committed action.
        if (deselectedUnit && (deselectedUnit.hasAttacked || deselectedUnit.hasTraded)) {
          game.audioManager?.playSfx?.('Error');
          break;
        }
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

/**
 * Python CantoWaitState: after a Canto move the unit may only Supply or Wait;
 * BACK undoes the Canto move.
 */
export class CantoWaitState extends State {
  readonly name = 'canto_wait';
  override readonly transparent = true;

  private menu: ChoiceMenu | null = null;

  override start(): StateResult {
    const game = getGame();
    const unit: UnitObject | null = game.selectedUnit;
    game.audioManager?.playSfx?.('Select 2');
    const options: MenuOption[] = [{ label: 'Wait', value: 'wait', enabled: true }];
    if (unit && supplyAvailableOnMap(unit, game)) {
      options.unshift({ label: 'Supply', value: 'supply', enabled: true });
    }
    this.menu = new ChoiceMenu(options, 0, 8);
    placeAutoMenu(this.menu, game);
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
    const unit: UnitObject | null = game.selectedUnit;

    if ('back' in result) {
      if (game._moveAction) {
        game.actionLog.reverseMoveToActionGroupStart(game._moveAction);
        game._moveAction = null;
      }
      if (unit?.position) game.cursor.setPos(unit.position[0], unit.position[1]);
      this.menu = null;
      game.state.back();
      return;
    }
    game.highlight.clear();
    if (result.selected === 'supply') {
      if (unit) game.memory.set('supply_unit', unit);
      game.state.change('supply_items');
      return;
    }
    this.menu = null;
    game._moveAction = null;
    game.state.clear();
    game.state.change('free');
    if (unit) {
      game.actionLog.doAction(new MarkActionGroupEnd('menu'));
      waitUnit(game, unit, true);
    }
    if (game.eventManager?.hasActiveEvents()) game.state.change('event');
  }

  override draw(surf: Surface): Surface {
    this.menu?.draw(surf);
    return surf;
  }
}

export class MenuState extends State {
  readonly name = 'menu';
  override readonly transparent = true;

  private menu: ChoiceMenu | null = null;
  private previousPosition: [number, number] | null = null;
  private validRegions: RegionData[] = [];
  private skillAbilities: SkillAbilityOption[] = [];
  private combatArts: CombatArtOption[] = [];

  override begin(): StateResult {
    const game = getGame();
    const unit: UnitObject = game.selectedUnit;
    const resumedAfterCombat = unit &&
      game.memory.get('menu_after_combat') === unit.nid;
    if (resumedAfterCombat) game.memory.delete('menu_after_combat');
    if (!unit || !unit.position) {
      game.state.back();
      return 'repeat';
    }

    // If the unit already finished (returned from a sub-state like ItemUse/Trade),
    // pop back so MoveState can clean up and return to FreeState.
    if (!resumedAfterCombat && (unit.finished || !unit.canStillAct())) {
      this.menu = null;
      game.state.back();
      return 'repeat';
    }

    this.previousPosition = game._moveOrigin ?? null;

    const ux = unit.position[0];
    const uy = unit.position[1];

    // --- Python MenuState.start option order ---------------------------
    // PRIMARY_ABILITIES (Attack, Spells, Talk), then event regions, then
    // OTHER_ABILITIES (Support, Drop, Rescue, Take, Give, Pair Up, Separate,
    // Switch, Transfer, Item, Supply, Trade), then Wait. Extra (skill)
    // abilities go after Spells/Attack and combat arts after Attack.
    const options: MenuOption[] = [];
    const ts = game.targetSystem;
    const hasTargets = (item: ItemObject): boolean =>
      itemAvailable(unit, item, game.db, game) &&
      (ts?.getValidTargetsRecursive(unit, item).length ?? 0) > 0;

    // Attack: weapons with a valid target (Python AttackAbility).
    const weaponTargets = unit.hasAttacked ? [] : [...new Set(unit.items
      .filter((item) => item.isWeapon() && itemAvailable(unit, item, game.db, game))
      .flatMap((item) => getTargetsInRange(unit, ux, uy, item)))];
    if (weaponTargets.length > 0) {
      options.push({ label: 'Attack', value: 'attack', enabled: true });
    }
    // Spells: spells (incl. staves) with a valid target (Python SpellAbility).
    const spellOptions = unit.hasAttacked ? [] : unit.items.filter((item) =>
      item.isSpell() && !item.isWeapon() && hasTargets(item));
    if (spellOptions.length > 0) {
      options.push({ label: 'Spells', value: 'spells', enabled: true });
    }
    // Talk
    const talkTargets = getAdjacentUnits(ux, uy).filter((other) => {
      if (other === unit || !game.eventManager) return false;
      const ctx = { game, unit1: unit, unit2: other, gameVars: game.gameVars, levelVars: game.levelVars };
      const events = game.eventManager.getEventsForTrigger({
        type: 'on_talk',
        levelNid: game.currentLevel?.nid ?? '',
        unitA: unit.nid,
        unitB: other.nid,
        unit1: unit,
        unit2: other,
      }, ctx);
      return events.length > 0 && !game.eventManager.isTalkHidden(unit.nid, other.nid);
    });
    if (talkTargets.length > 0) {
      options.push({ label: 'Talk', value: 'talk', enabled: true });
    }

    // Region interactions (Visit, Seize, Shop, Armory, Chest, etc.)
    this.validRegions = [];
    if (game.currentLevel?.regions) {
      for (const region of game.currentLevel.regions) {
        if (region.region_type.toLowerCase() !== 'event') continue;
        if (!region.position || !region.size) continue;
        const [rx, ry] = region.position;
        const [rw, rh] = region.size;
        if (ux >= rx && ux < rx + rw && uy >= ry && uy < ry + rh) {
          const condCtx: ConditionContext = {
            game, unit1: unit, region,
            gameVars: game.gameVars, levelVars: game.levelVars,
          };
          const conditionMet = evaluateCondition(region.condition ?? 'True', condCtx);
          if (!conditionMet) continue;
          const subNid = region.sub_nid || 'Visit';
          if (options.some(o => o.label === subNid)) continue;
          options.push({ label: subNid, value: `region_${region.nid}`, enabled: true });
          this.validRegions.push(region);
        }
      }
    }

    // Support
    const supportAvailable = game.gameVars.get('_supports') &&
      game.db.supportConstants.get('combat_convos');
    const adjacentSupportTargets = supportAvailable ? getAdjacentUnits(ux, uy).filter((other) => {
      if (other === unit) return false;
      const pair = game.supports?.getPair(unit.nid, other.nid);
      if (!pair) return false;
      return game.supports.canSupport(pair, game);
    }) : [];
    if (adjacentSupportTargets.length > 0) {
      options.push({ label: 'Support', value: 'support', enabled: true });
    }

    const pairUpEnabled = !!game.db.getConstant('pairup', false);
    const pairUpAllowed = pairUpEnabled && !game.db.getConstant('attack_stance_only', false);
    // Drop
    if (!pairUpEnabled && unit.isRescuing() && !unit.hasAttacked && !unit.hasRescued) {
      if (getAdjacentEmptyTiles(ux, uy, unit.rescuing).length > 0) {
        options.push({ label: 'Drop', value: 'drop', enabled: true });
      }
    }
    // Rescue (Python: aid >= the target's rescue weight)
    if (!pairUpEnabled && !unit.isRescuing() && !unit.hasAttacked && !unit.hasGiven && !unit.hasDropped &&
        getAdjacentAllies(unit, ux, uy).some((ally) =>
          !ally.isRescuing() && !ally.isRescued() && canCarry(unit, ally, game))) {
      options.push({ label: 'Rescue', value: 'rescue', enabled: true });
    }
    // Take
    if (!pairUpEnabled && !unit.isRescuing() && !unit.hasAttacked && !unit.hasGiven && !unit.hasDropped &&
        getAdjacentAllies(unit, ux, uy).some((ally) =>
          ally.isRescuing() && !!ally.rescuing && canCarry(unit, ally.rescuing, game))) {
      options.push({ label: 'Take', value: 'take', enabled: true });
    }
    // Give
    if (!pairUpEnabled && unit.isRescuing() && !!unit.rescuing && !unit.hasAttacked &&
        (!unit.hasTaken || game.db.getConstant('give_and_take', false)) && !unit.hasRescued &&
        getAdjacentAllies(unit, ux, uy).some((ally) =>
          !ally.isRescuing() && !ally.isRescued() && canCarry(ally, unit.rescuing!, game))) {
      options.push({ label: 'Give', value: 'give', enabled: true });
    }
    // Pair Up / Separate / Switch / Transfer
    if (pairUpAllowed && !unit.isRescuing() && !unit.isRescued() &&
        getAdjacentAllies(unit, ux, uy).some((ally) =>
          !ally.isRescued() && !ally.isRescuing() && ally.team === unit.team)) {
      options.push({ label: 'Pair Up', value: 'pair_up', enabled: true });
    }
    if (pairUpEnabled && unit.isRescuing() && unit.leadUnit && !unit.hasAttacked &&
        getAdjacentEmptyTiles(ux, uy, unit.rescuing).length > 0) {
      options.push({ label: 'Separate', value: 'separate', enabled: true });
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
    // Item: any item in the inventory (Python ItemAbility).
    if (unit.items.length > 0) {
      options.push({ label: 'Item', value: 'item', enabled: true });
    }
    // Supply — Python SupplyAbility.
    if (supplyAvailableOnMap(unit, game)) {
      options.push({ label: 'Supply', value: 'supply', enabled: true });
    }
    // Trade
    if (getTradePartners(unit).length > 0) {
      options.push({ label: 'Trade', value: 'trade', enabled: true });
    }

    // Wait is always available
    options.push({ label: 'Wait', value: 'wait', enabled: true });

    // Extra abilities after Spells/Attack (else after the region options).
    const availableAbilities = getSkillAbilityOptions(game, unit).filter(({ item }) => hasTargets(item));
    // Python stores uncategorized abilities in an ordered name-keyed dict:
    // later same-name grants replace the value without adding a duplicate row.
    this.skillAbilities = [...new Map(
      availableAbilities.map((ability) => [ability.item.name, ability]),
    ).values()];
    const abilityStart = options.findIndex((o) => o.value === 'spells') >= 0
      ? options.findIndex((o) => o.value === 'spells') + 1
      : options.findIndex((o) => o.value === 'attack') >= 0
        ? options.findIndex((o) => o.value === 'attack') + 1
        : this.validRegions.length;
    for (let index = this.skillAbilities.length - 1; index >= 0; index--) {
      options.splice(Math.min(options.length, abilityStart), 0, {
        label: this.skillAbilities[index].item.name,
        value: `skill_ability_${index}`,
        enabled: true,
      });
    }

    // Combat arts after Attack (else after the region options). With the
    // combat_art_category constant off (EotF) each art is listed by name.
    this.combatArts = unit.hasAttacked ? [] : getCombatArtOptions(game, unit);
    if (this.combatArts.length > 0) {
      const artStart = options.findIndex((o) => o.value === 'attack') >= 0
        ? options.findIndex((o) => o.value === 'attack') + 1
        : this.validRegions.length;
      if (game.db.getConstant('combat_art_category', false)) {
        options.splice(artStart, 0, { label: 'Combat Arts', value: 'combat_arts', enabled: true });
      } else {
        for (let index = this.combatArts.length - 1; index >= 0; index--) {
          options.splice(artStart, 0, {
            label: this.combatArts[index].skill.name,
            value: `combat_art_${index}`,
            enabled: true,
          });
        }
      }
    }

    // Python menus.Choice 'auto' placement: top-right when the cursor is on
    // the left half of the screen, top-left otherwise.
    this.menu = new ChoiceMenu(options, 0, 8);
    placeAutoMenu(this.menu, game);
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
      const unit: UnitObject = game.selectedUnit;
      // Python MenuState BACK after a trade/give/take: the move is committed.
      // Canto units may keep moving; everyone else waits.
      if (unit?.hasTraded) {
        this.menu = null;
        if (unitHasCanto(unit, unit, game)) {
          game.actionLog.doAction(new SetMovementLeftAction(unit, cantoMovement(unit, unit, game)));
          if (unit.position) game.cursor.setPos(unit.position[0], unit.position[1]);
          game.state.change('move');
        } else {
          game._moveAction = null;
          game.state.clear();
          game.state.change('free');
          waitUnit(game, unit, false);
          if (game.eventManager?.hasActiveEvents()) game.state.change('event');
        }
        return;
      }
      // Remove the uncommitted move and its action-group marker. The fallback
      // supports harness-created menu states that did not originate in MoveState.
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
      } else if (value === 'combat_arts') {
        this.menu = null;
        game.state.change('combat_art_choice');
      } else if (value.startsWith('combat_art_')) {
        const option = this.combatArts[Number(value.slice('combat_art_'.length))];
        deactivateCombatArts(unit);
        if (option && activateCombatArt(game, unit, option)) {
          this.menu = null;
          game.state.change('weapon_choice');
        }
      } else if (value === 'spells') {
        this.menu = null;
        game.memory.set('weapon_choice_mode', 'spells');
        game.state.change('weapon_choice');
      } else if (value === 'take' || value === 'give') {
        this.menu = null;
        game.memory.set('traveler_transfer_mode', value);
        game.state.change('traveler_transfer');
      } else if (value === 'item') {
        this.menu = null;
        game.state.change('item');
      } else if (value === 'accessory') {
        this.menu = null;
        game.state.change('accessory_choice');
      } else if (value.startsWith('skill_ability_')) {
        const index = Number(value.slice('skill_ability_'.length));
        const ability = this.skillAbilities[index];
        if (!ability) return;
        if (ability.item.hasComponent('multi_item') && ability.item.subitems.length > 0) {
          game.memory.set('ability_item', ability.item);
          this.menu = null;
          game.state.change('item_use');
          return;
        }
        game.memory.set('item_use_item', ability.item);
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
// 4b. AccessoryChoiceState - Equip an accessory without consuming the action
// ============================================================================

export class AccessoryChoiceState extends State {
  readonly name = 'accessory_choice';
  override readonly transparent = true;

  private menu: ChoiceMenu | null = null;
  private accessories: ItemObject[] = [];

  override begin(): StateResult {
    const game = getGame();
    const unit: UnitObject = game.selectedUnit;
    if (!unit) {
      game.state.back();
      return;
    }
    this.accessories = unit.items.filter((item) =>
      item.isAccessory() && unit.canEquip(item),
    );
    if (this.accessories.length === 0) {
      game.state.back();
      return;
    }
    const options = this.accessories.map((item, index) => ({
      label: `${unit.equippedAccessory === item ? 'E ' : ''}${item.name}`,
      value: `accessory_${index}`,
      enabled: true,
    }));
    this.menu = new ChoiceMenu(
      options,
      Math.max(4, viewport.width - 100),
      Math.max(4, (viewport.height - options.length * 16) / 2),
    );
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
      this.menu = null;
      game.state.back();
      return;
    }
    const index = Number(result.selected.slice('accessory_'.length));
    const item = this.accessories[index];
    const unit: UnitObject = game.selectedUnit;
    if (item && unit && unit.equippedAccessory !== item) {
      game.actionLog.doAction(new EquipItemAction(unit, item));
      game.actionLog.doAction(new BringToTopItemAction(unit, item));
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
  skillMode?: 'exact' | 'all' | 'none',
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

  // Python: a silent event promote/change_class learns only the class
  // skills listed at exactly the unit's level; the promotion screen learns
  // every skill up to the level when learn_skills_on_promote/_on_reclass is
  // set (ExpState.give_all_class_skills) and none otherwise.
  const mode = skillMode ?? (game.db.getConstant(
    kind === 'promote' ? 'learn_skills_on_promote' : 'learn_skills_on_reclass',
    false,
  ) ? 'all' : 'none');
  const unitKlass = game.db.classes.get(unit.klass);
  if (unitKlass?.learned_skills && mode !== 'none') {
    for (const [levelNeeded, classSkillNid] of unitKlass.learned_skills) {
      const learns = mode === 'exact' ? unit.level === levelNeeded : unit.level >= levelNeeded;
      if (learns && !unit.skills.some((s: SkillObject) => s.nid === classSkillNid)) {
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
  const customHeal = item.hasComponent('eval_heal') ||
    item.hasComponent('heal_no_target_restrict') ||
    item.hasComponent('solomon_heal');
  if (item.hasComponent('heal') || item.hasComponent('equation_heal') || customHeal) {
    let healAmount = item.getComponent<number>('heal') ?? 0;
    const equationNid = item.getComponent<string>('equation_heal');
    if (equationNid) {
      const expression = game.db.getEquation(equationNid) ?? equationNid;
      healAmount = evaluateEquation(expression, unit, { db: game.db, item });
    }
    for (const targetPosition of positions.values()) {
      const target = game.board.getUnit(targetPosition[0], targetPosition[1]);
      if (!target) continue;
      const solomonChange = solomonHpChange(unit, item, target, game);
      const amount = solomonChange ??
        itemHealAmount(unit, item, target, game) ??
        healAmount + empowerHeal(unit, target, game);
      if (customHeal || target.currentHp < target.maxHp) {
        game.actionLog.doAction(amount < 0
          ? new DamageAction(target, -amount)
          : new SetCurrentHpAction(target, target.currentHp + amount));
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

  if (item.hasComponent('restore') || item.hasComponent('restore_specific') ||
      item.hasComponent('restore_no_target_restrict')) {
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
      if (item.hasComponent('restore_no_target_restrict')) applied = true;
    }
  }

  if (item.hasComponent('refresh') || item.hasComponent('refresh_no_target_restrict')) {
    for (const targetPosition of positions.values()) {
      const target = game.board.getUnit(targetPosition[0], targetPosition[1]);
      if (target && (target.finished || item.hasComponent('refresh_no_target_restrict'))) {
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
  if (item.hasComponent('class_change')) {
    for (const targetPosition of positions.values()) {
      const target = game.board.getUnit(targetPosition[0], targetPosition[1]);
      const prefab = target ? game.db.units.get(target.nid) as any : null;
      const options = Array.isArray(prefab?.alternate_classes)
        ? [...prefab.alternate_classes] as string[]
        : [];
      if (!target || target.generic || options.length !== 1) continue;
      performPromotionOrClassChange(target, options[0], game, 'change_class');
      applied = true;
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
      if (componentNid === 'permanent_stat_change' ||
          componentNid === 'permanent_stat_change_early') {
        game.actionLog.doAction(new ApplyStatChangesAction(
          target,
          item.getNumericComponentMap(componentNid),
          componentNid === 'permanent_stat_change_early' ? unit : target,
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
  baseUse: boolean = false,
  resourcesStarted: boolean = false,
): void {
  const game = getGame();
  if (!resourcesStarted) applyItemStartResourceHooks(game, unit, item);
  applyItemEndResourceHooks(game, unit, item);
  const uniqueTargets = [...new Map(targets.map((target) => [target.nid, target])).values()];
  const allyHealing = [...healingDone.entries()]
    .filter(([target]) => target !== unit)
    .reduce((total, [, amount]) => total + Math.max(0, amount), 0);
  if (allyHealing > 0) {
    for (const skill of unit.skills) {
      const ratio = skill.getComponent<number>('live_to_serve');
      if (typeof ratio !== 'number') continue;
      const amount = Math.trunc(allyHealing * ratio);
      if (amount <= 0) continue;
      game.actionLog.doAction(new HealAction(unit, amount));
      triggerSkillCharge(game, skill);
    }
  }
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
  triggerAbilityItemCharge(game, unit, item, 'use');
  if (baseUse) game.actionLog.doAction(new HasTradedAction(unit));
  else if (!canAttackAfterCombat(unit, item)) game.actionLog.doAction(new WaitAction(unit));
  game.actionLog.doAction(new MarkActionGroupEnd('item_use'));
}

export function applyCoreTargetedItem(
  unit: UnitObject,
  item: ItemObject,
  position: [number, number],
  targetItem: ItemObject | null = null,
): boolean {
  const game = getGame();
  const resourceStart = game.actionLog.getLength();
  applyItemStartResourceHooks(game, unit, item);
  const targets = effectUnits(unit, item, position);
  const hpBefore = new Map(targets.map((target) => [target, target.currentHp]));
  if (!applyCoreTargetedEffects(unit, item, position, targetItem)) {
    while (game.actionLog.getLength() > resourceStart) game.actionLog.undo();
    return false;
  }
  const healingDone = new Map(
    targets.map((target) => [target, Math.max(0, target.currentHp - (hpBefore.get(target) ?? target.currentHp))]),
  );
  finishCoreItemUse(unit, item, targets, healingDone, false, true);
  return true;
}

/** Apply one multi-target item's effects to each selected main position, consuming it once. */
export function applyCoreMultiTargetedItem(
  unit: UnitObject,
  item: ItemObject,
  positions: [number, number][],
): boolean {
  const game = getGame();
  const resourceStart = game.actionLog.getLength();
  applyItemStartResourceHooks(game, unit, item);
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
  if (!applied) {
    while (game.actionLog.getLength() > resourceStart) game.actionLog.undo();
    return false;
  }
  const healingDone = new Map(
    [...targets.values()].map((target) => [
      target,
      Math.max(0, target.currentHp - (hpBefore.get(target) ?? target.currentHp)),
    ]),
  );
  finishCoreItemUse(unit, item, [...targets.values()], healingDone, false, true);
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
  const resourceStart = game.actionLog.getLength();
  applyItemStartResourceHooks(game, unit, item);
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
      if ((child.hasComponent('unload_unit') || child.hasComponent('self_unload_unit')) &&
          storedUnit &&
          !game.board.getUnit(position[0], position[1])) {
        game.actionLog.doAction(new WarpUnitAction(storedUnit, position, game.board));
        game.cursor.setPos(position[0], position[1]);
        applied = true;
        storedUnit = null;
      }
      applied = applyCoreTargetedEffects(unit, child, position) || applied;
    }
  }

  if (!applied) {
    while (game.actionLog.getLength() > resourceStart) game.actionLog.undo();
    return false;
  }
  const finalPosition = [...targetsByItem].reverse()
    .flatMap((positions) => [...positions].reverse())
    .find((position): position is [number, number] => !!position);
  if (finalPosition) {
    queueDirectItemUseEvents(
      game,
      unit,
      item,
      finalPosition,
      game.board.getUnit(finalPosition[0], finalPosition[1]),
    );
  }
  finishCoreItemUse(unit, item, [...targets.values()], new Map(), false, true);
  return true;
}

// ============================================================================
// 4a2. ItemMenuState / item child — Python general_states.ItemState and
// ItemChildState: the full inventory with an Equip / Expand / Use / Trade /
// Storage / Discard child menu (and a Yes/No confirm for Storage/Discard).
// ============================================================================

export class ItemMenuState extends State {
  readonly name = 'item';
  override readonly transparent = true;

  private menu: ChoiceMenu | null = null;
  private child: ChoiceMenu | null = null;
  private confirm: ChoiceMenu | null = null;
  private items: ItemObject[] = [];
  private childItem: ItemObject | null = null;
  private confirmAction: 'Storage' | 'Discard' | null = null;
  private selectedIndex = 0;

  override begin(): StateResult {
    const game = getGame();
    const unit: UnitObject | null = game.selectedUnit;
    if (!unit || !unit.position || unit.finished) {
      game.state.back();
      return 'repeat';
    }
    this.child = null;
    this.confirm = null;
    this.childItem = null;
    this.items = [...unit.items];
    if (this.items.length === 0) {
      game.state.back();
      return 'repeat';
    }
    this.buildMenu(unit);
  }

  private buildMenu(unit: UnitObject): void {
    const game = getGame();
    const options: MenuOption[] = this.items.map((item, index) => ({
      label: item.name,
      value: String(index),
      enabled: true,
      itemRow: itemMenuRow(unit, item, game),
    }));
    this.menu = new ChoiceMenu(options, 0, 8);
    this.menu.selectedIndex = Math.min(this.selectedIndex, options.length - 1);
    placeAutoMenu(this.menu, game);
  }

  private childOptions(unit: UnitObject, item: ItemObject): string[] {
    const game = getGame();
    const options: string[] = [];
    if (unit.items.includes(item) && unit.canEquip(item)) options.push('Equip');
    if (item.hasComponent('multi_item') && item.subitems.length > 0 && unit.items.includes(item)) options.push('Expand');
    const usable = (unit.getUsableItems().includes(item) || item.hasCoreUseEffect?.()) &&
      itemAvailable(unit, item, game.db, game) &&
      (game.targetSystem?.getValidTargetsRecursive(unit, item).length ?? 0) > 0;
    if (usable && !unit.hasAttacked) options.push('Use');
    if (getTradePartners(unit).length > 0 && !item.hasComponent('untradeable')) {
      options.push('Trade');
    }
    if (unit.items.includes(item)) {
      const locked = item.hasComponent('locked');
      if (!locked && game.gameVars.get('_convoy') &&
          (game.db.getConstant('long_range_storage', false) || supplyAvailableOnMap(unit, game))) {
        options.push('Storage');
      } else if (!locked && !item.hasComponent('undiscardable')) {
        options.push('Discard');
      }
    }
    if (options.length === 0) options.push('Nothing');
    return options;
  }

  override takeInput(event: InputEvent): StateResult {
    const game = getGame();
    const unit: UnitObject | null = game.selectedUnit;
    if (!unit) return;
    const active = this.confirm ?? this.child ?? this.menu;
    if (!active) return;
    let result: { selected: string } | { back: true } | null = null;
    if (game.input?.mouseClick) {
      const [gx, gy] = game.input.getGameMousePos();
      result = active.handleClick(gx, gy, game.input.mouseClick as 'SELECT' | 'BACK');
    } else if (game.input?.mouseMoved) {
      const [gx, gy] = game.input.getGameMousePos();
      active.handleMouseHover(gx, gy);
    }
    if (!result && event !== null) result = active.handleInput(event);
    if (!result) return;

    if (active === this.confirm) {
      if ('back' in result || result.selected === 'No') {
        this.confirm = null;
        return;
      }
      const item = this.childItem;
      if (item && unit.items.includes(item)) {
        if (this.confirmAction === 'Discard') {
          game.actionLog.doAction(new RemoveItemFromUnitAction(unit, item));
        } else if (this.confirmAction === 'Storage') {
          game.actionLog.doAction(new StoreItemAction(unit, item));
        }
      }
      this.confirm = null;
      this.child = null;
      this.items = [...unit.items];
      if (this.items.length === 0) {
        this.menu = null;
        game.state.back();
        return;
      }
      this.selectedIndex = Math.min(this.selectedIndex, this.items.length - 1);
      this.buildMenu(unit);
      return;
    }

    if (active === this.child) {
      if ('back' in result) {
        this.child = null;
        return;
      }
      const item = this.childItem;
      if (!item) return;
      const choice = result.selected;
      if (choice === 'Equip') {
        game.actionLog.doAction(new EquipItemAction(unit, item));
        if (unit.items.includes(item)) game.actionLog.doAction(new BringToTopItemAction(unit, item));
        this.child = null;
        this.items = [...unit.items];
        this.selectedIndex = Math.max(0, this.items.indexOf(item));
        this.buildMenu(unit);
      } else if (choice === 'Use' || choice === 'Expand') {
        // Reuse the item-use flow (self-target shortcut, promotions,
        // multi-item children, item targeting).
        this.child = null;
        this.menu = null;
        game.memory.set('item_menu_use_item', item);
        game.state.change('item_use');
      } else if (choice === 'Trade') {
        this.child = null;
        this.menu = null;
        game.state.change('trade');
      } else if (choice === 'Storage' || choice === 'Discard') {
        this.confirmAction = choice;
        this.confirm = new ChoiceMenu([
          { label: 'Yes', value: 'Yes', enabled: true },
          { label: 'No', value: 'No', enabled: true },
        ], 0, 0);
        placeChildMenu(this.confirm, this.child);
      }
      return;
    }

    // Inventory list
    if ('back' in result) {
      this.menu = null;
      game.state.back();
      return;
    }
    const index = Number(result.selected);
    const item = this.items[index];
    if (!item) return;
    this.selectedIndex = index;
    this.childItem = item;
    const opts = this.childOptions(unit, item).map((label) => ({
      label, value: label, enabled: label !== 'Nothing',
    }));
    this.child = new ChoiceMenu(opts, 0, 0);
    placeChildMenu(this.child, this.menu!);
  }

  override draw(surf: Surface): Surface {
    this.menu?.draw(surf);
    const game = getGame();
    const current = this.items[this.menu?.selectedIndex ?? -1];
    if (current && !this.child) drawItemDescriptionPanel(surf, game, game.selectedUnit, current);
    this.child?.draw(surf);
    this.confirm?.draw(surf);
    return surf;
  }
}

/** Python menu_options.ItemOption colours and uses string for a unit's item. */
function itemMenuRow(unit: UnitObject, item: ItemObject, game: any): MenuItemRow {
  const available = itemAvailable(unit, item, game.db, game);
  let mainColor = 'grey';
  let usesColor = 'grey';
  if (item.droppable) {
    mainColor = 'green';
    usesColor = 'green';
  } else if (available) {
    mainColor = 'white';
    usesColor = 'blue';
  }
  const index = item.iconIndex ?? [0, 0];
  return {
    iconNid: item.iconNid || null,
    iconIndex: [Number(index[0]) || 0, Number(index[1]) || 0],
    uses: item.maxUses > 0 ? String(item.uses) : '--',
    mainColor,
    usesColor,
  };
}

/** Python icons.get_portrait: the 96x80 face crop, optionally flipped. */
const panelPortraits = new Map<string, HTMLCanvasElement>();
function getPanelPortrait(game: any, nid: string, flip: boolean): HTMLCanvasElement | null {
  const key = `${nid}|${flip ? 1 : 0}`;
  const cached = panelPortraits.get(key);
  if (cached) return cached;
  const sheet = getColorkeyedPortrait(game, nid);
  if (!sheet) return null;
  const canvas = document.createElement('canvas');
  canvas.width = 96;
  canvas.height = 80;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  if (flip) {
    ctx.translate(96, 0);
    ctx.scale(-1, 1);
  }
  ctx.drawImage(sheet, 0, 0, 96, 80, 0, 0, 96, 80);
  panelPortraits.set(key, canvas);
  return canvas;
}

/**
 * Python ui_view.ItemDescriptionPanel (weapon/spell choice and the item
 * menu): the unit's portrait above a 96x56 panel opposite the cursor, with
 * Affin/Atk/Hit/Crit/Avo for usable weapons, otherwise the description.
 */
function drawItemDescriptionPanel(surf: Surface, game: any, unit: UnitObject | null, item: ItemObject): void {
  if (!unit) return;
  const width = 96;
  const height = 56;
  const cursorX = game.cursor?.getPosition?.()?.[0] ?? 0;
  const cameraX = Math.floor((game.camera?.getOffset?.()?.[0] ?? 0) / TILEWIDTH);
  const cursorLeft = !(cursorX > Math.floor(viewport.width / TILEWIDTH / 2) + cameraX);
  const left = cursorLeft ? 8 : viewport.width - 8 - (width + 2);
  const top = viewport.height - 8 - (height + 4);

  const portraitNid = (unit as any).portraitNid ?? game.db.units.get(unit.nid)?.portrait_nid ?? '';
  const portrait = portraitNid ? getPanelPortrait(game, portraitNid, cursorLeft) : null;
  if (portrait) surf.blitImage(portrait, 0, 0, 96, 80, left + 2, top - 76);

  const bx = left + 2;
  const by = top + 4;
  surf.blit(getMenuBackgroundSync(width, height), bx, by);
  const available = itemAvailable(unit, item, game.db, game);
  if (item.isWeapon() && available) {
    const t = top + 4;
    const l = left + 2;
    const affinWidth = measureStyledText('Affin', 'text');
    surf.drawText('Affin', l + Math.floor(width / 2) - 8 - Math.floor(affinWidth / 2), t + 4, 'white', 'text');
    surf.drawText('Atk', l + 5, t + 20, 'white', 'text');
    surf.drawText('Hit', l + 5, t + 36, 'white', 'text');
    const showCrit = !!game.db.getConstant('crit', true);
    surf.drawText(showCrit ? 'Crit' : 'AS', l + Math.floor(width / 2) + 5, t + 20, 'white', 'text');
    surf.drawText('Avo', l + Math.floor(width / 2) + 5, t + 36, 'white', 'text');
    let damage = '--';
    let hit = '--';
    let crit = '--';
    let avo = '--';
    let speed = '--';
    try {
      damage = String(combatDamage(unit, item, game.db, game));
      hit = String(combatAccuracy(unit, item, game.db, game));
      crit = String(combatCritAccuracy(unit, item, game.db, game));
      avo = String(combatAvoid(unit, game.db, game.board, null, game));
      speed = String(attackSpeed(unit, item, game.db, game));
    } catch {
      // Leave '--' for values the formulas cannot evaluate.
    }
    surf.drawTextRight(damage, l + Math.floor(width / 2) - 3, t + 20, 'blue', 'text');
    surf.drawTextRight(hit, l + Math.floor(width / 2) - 3, t + 36, 'blue', 'text');
    surf.drawTextRight(showCrit ? crit : speed, l + width - 10, t + 20, 'blue', 'text');
    surf.drawTextRight(avo, l + width - 10, t + 36, 'blue', 'text');
    const weaponType = item.getComponent<string>('weapon_type');
    const wtype = weaponType ? (game.db.weapons ?? []).find((w: any) => w.nid === weaponType) : null;
    const iconX = l + Math.floor(width / 2) - 8 + Math.floor(affinWidth / 2) + 8;
    if (wtype?.icon_nid) {
      drawIcon16(surf, wtype.icon_nid, [Number(wtype.icon_index?.[0]) || 0, Number(wtype.icon_index?.[1]) || 0], iconX, t + 4);
    } else {
      surf.drawText('--', l + Math.floor(width / 2) - 8 + affinWidth + 8, t + 4, 'blue', 'text');
    }
  } else {
    let desc = String(item.desc ?? '');
    if (!desc && !available) desc = 'Cannot wield.';
    const words = desc.replace(/\{br\}/g, '\n').split('\n');
    const lines: string[] = [];
    for (const paragraph of words) {
      let line = '';
      for (const word of paragraph.split(' ')) {
        const next = line ? `${line} ${word}` : word;
        if (line && measureStyledText(next, 'text') > width - 8) {
          lines.push(line);
          line = word;
        } else {
          line = next;
        }
      }
      lines.push(line);
    }
    lines.slice(0, 3).forEach((line, index) => {
      drawStyledText(surf, line, left + 6, top + 8 + index * 16, 'white', 'text');
    });
  }
}

// ============================================================================
// 4a3. TravelerTransferState — Python TakeAbility / GiveAbility targeting.
// ============================================================================

export class TravelerTransferState extends State {
  readonly name = 'traveler_transfer';
  override readonly transparent = true;

  private menu: ChoiceMenu | null = null;
  private mode: 'take' | 'give' = 'take';
  private candidates: UnitObject[] = [];

  override start(): StateResult {
    const game = getGame();
    this.mode = game.memory.get('traveler_transfer_mode') === 'give' ? 'give' : 'take';
    game.memory.delete('traveler_transfer_mode');
  }

  override begin(): StateResult {
    const game = getGame();
    const unit: UnitObject | null = game.selectedUnit;
    if (!unit || !unit.position) {
      game.state.back();
      return 'repeat';
    }
    const allies = getAdjacentAllies(unit, unit.position[0], unit.position[1]);
    this.candidates = this.mode === 'take'
      ? allies.filter((ally) => ally.isRescuing() && !!ally.rescuing && canCarry(unit, ally.rescuing, game))
      : allies.filter((ally) => !ally.isRescuing() && !ally.isRescued() &&
        !!unit.rescuing && canCarry(ally, unit.rescuing, game));
    if (this.candidates.length === 0) {
      game.state.back();
      return 'repeat';
    }
    this.menu = new ChoiceMenu(this.candidates.map((ally, index) => ({
      label: ally.name, value: String(index), enabled: true,
    })), 0, 8);
    placeAutoMenu(this.menu, game);
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
    const unit: UnitObject = game.selectedUnit;
    const other = this.candidates[Number(result.selected)];
    if (!unit || !other) return;
    // Python: HasTraded + Take/Give; neither counts as the major action, so
    // the unit returns to its action menu.
    game.actionLog.doAction(new HasTradedAction(unit));
    if (this.mode === 'take' && other.rescuing) {
      game.actionLog.doAction(new TransferTravelerAction(other, unit, other.rescuing, 'take'));
    } else if (this.mode === 'give' && unit.rescuing) {
      game.actionLog.doAction(new TransferTravelerAction(unit, other, unit.rescuing, 'give'));
    }
    this.menu = null;
    game.state.back();
  }

  override draw(surf: Surface): Surface {
    this.menu?.draw(surf);
    return surf;
  }
}

export class ItemUseState extends State {
  readonly name = 'item_use';
  override readonly transparent = true;

  private menu: ChoiceMenu | null = null;
  private usableItems: ItemObject[] = [];
  private topLevelItems: ItemObject[] = [];
  private parentItem: ItemObject | null = null;
  private abilityRoot: ItemObject | null = null;
  private directUse = false;

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
    this.abilityRoot = game.memory.get('ability_item') ?? null;
    game.memory.delete('ability_item');
    if (this.abilityRoot) {
      const children = this.abilityRoot.subitems.filter((child) =>
        itemAvailable(unit, child, game.db, game) &&
        (game.targetSystem?.getValidTargetsRecursive(unit, child).length ?? 0) > 0,
      );
      if (children.length === 0) {
        this.abilityRoot = null;
        game.state.back();
        return;
      }
      this.parentItem = this.abilityRoot;
      this.topLevelItems = [];
      this.setItemMenu(children, unit);
      return;
    }
    const directItem = game.memory.get('item_menu_use_item') as ItemObject | undefined;
    if (directItem) {
      // Python ItemChildState 'Use'/'Expand' on one inventory item.
      game.memory.delete('item_menu_use_item');
      this.topLevelItems = [directItem];
      this.setItemMenu(this.topLevelItems, unit);
      this.directUse = true;
      return this.takeInput('SELECT');
    }
    if (this.directUse) {
      // Came back from targeting/children of a direct use: return to the item menu.
      this.directUse = false;
      game.state.back();
      return 'repeat';
    }
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
      if (this.abilityRoot) {
        this.abilityRoot = null;
        this.parentItem = null;
        this.menu = null;
        game.state.back();
        return;
      }
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
        const needsPromotionRouting = item.hasComponent('promote') ||
          item.hasComponent('force_promote') ||
          item.hasComponent('class_change');
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
// 4b2. BaseUseState - Use usable_in_base items on the managed unit
// ============================================================================

export function canUseBaseItem(unit: UnitObject, item: ItemObject, game: any): boolean {
  if (!item.hasComponent('usable_in_base') || !item.hasComponent('usable')) return false;
  if (!itemAvailable(unit, item, game.db, game)) return false;
  if (item.maxUses > 0 && item.uses <= 0) return false;

  const expression = item.getComponent<string>('eval_target_restrict_2');
  if (expression && !evaluateCondition(expression, {
    game,
    unit1: unit,
    unit2: unit,
    item,
    position: unit.position ?? undefined,
    gameVars: game.gameVars,
    levelVars: game.levelVars,
  })) return false;

  const permanentStatComponent = item.hasComponent('permanent_stat_change_early')
    ? 'permanent_stat_change_early'
    : item.hasComponent('permanent_stat_change')
      ? 'permanent_stat_change'
      : null;
  if (permanentStatComponent) {
    const changes = item.getNumericComponentMap(permanentStatComponent);
    if (!Object.entries(changes).some(([stat, amount]) =>
      amount <= 0 || unit.getStatValue(stat) < unit.getStatCap(stat))) return false;
  }

  if (item.hasComponent('promote')) {
    const klass = game.db.classes.get(unit.klass);
    if (!klass?.turns_into?.length) return false;
  }
  return true;
}

/**
 * Python interaction.start_combat(unit, None, item) for items used from the
 * base/prep screens (PrepUseState, PrepItemsState). Returns 'pushed' when a
 * follow-up state (promotion choice, item event) was opened.
 */
export function useItemInBase(game: any, unit: UnitObject, item: ItemObject, origin: string): 'pushed' | 'done' {
  if (item.hasComponent('promote')) {
    const options = [...(game.db.classes.get(unit.klass)?.turns_into ?? [])];
    if (options.length > 1) {
      game.memory.set('promotion_choice_unit', unit);
      game.memory.set('promotion_choice_options', options);
      game.memory.set('promotion_choice_item', item);
      game.memory.set('promotion_choice_actor', unit);
      game.memory.set('promotion_choice_source', 'promote');
      game.memory.set('promotion_choice_origin', origin);
      game.state.change('promotion_choice');
      return 'pushed';
    }
    if (options.length === 1) {
      game.actionLog.doAction(new MarkActionGroupStart(unit, 'item_use'));
      applyItemStartResourceHooks(game, unit, item);
      performPromotionOrClassChange(unit, options[0], game, 'promote');
      finishCoreItemUse(unit, item, [unit], new Map(), true, true);
    }
  } else if (item.hasComponent('permanent_stat_change') ||
      item.hasComponent('permanent_stat_change_early')) {
    const componentNid = item.hasComponent('permanent_stat_change_early')
      ? 'permanent_stat_change_early'
      : 'permanent_stat_change';
    game.actionLog.doAction(new MarkActionGroupStart(unit, 'item_use'));
    applyItemStartResourceHooks(game, unit, item);
    game.actionLog.doAction(new ApplyStatChangesAction(
      unit,
      item.getNumericComponentMap(componentNid),
      unit,
    ));
    finishCoreItemUse(unit, item, [unit], new Map(), true, true);
  } else if (item.hasComponent('event_on_use') || item.hasComponent('event_on_hit') ||
      item.hasComponent('event_after_use') || item.hasComponent('event_after_combat') ||
      item.hasComponent('event_after_combat_on_hit') ||
      item.hasComponent('event_after_combat_even_miss')) {
    game.actionLog.doAction(new MarkActionGroupStart(unit, 'item_use'));
    applyItemStartResourceHooks(game, unit, item);
    queueDirectItemUseEvents(
      game,
      unit,
      item,
      unit.position ?? [0, 0],
      unit,
    );
    finishCoreItemUse(unit, item, [unit], new Map(), true, true);
    if (game.eventManager?.hasActiveEvents()) {
      game.state.change('event');
      return 'pushed';
    }
  }
  return 'done';
}

export class BaseUseState extends State {
  readonly name = 'base_use';
  override readonly showMap = false;
  override readonly inLevel = false;

  private unit: UnitObject | null = null;
  private items: ItemObject[] = [];
  /** Python PrepUseState: menus.Inventory at (6, 72) over the manage table. */
  private menu: PrepChoice | null = null;

  override begin(): StateResult {
    const game = getGame();
    this.unit = game.memory.get('base_use_unit') ?? game.selectedUnit ?? null;
    if (!this.unit) {
      game.state.back();
      return 'repeat';
    }
    this.buildMenu();
  }

  private buildMenu(): void {
    const game = getGame();
    if (!this.unit) return;
    const unit = this.unit;
    const numItems = Number(game.db.getConstant('num_items', 5));
    const numAccessories = Number(game.db.getConstant('num_accessories', 0));
    const regular = unit.items.filter((item) => !item.isAccessory());
    const accessories = unit.items.filter((item) => item.isAccessory());
    const slots: (ItemObject | null)[] = [...regular];
    while (slots.length < numItems) slots.push(null);
    slots.push(...accessories);
    while (slots.length < numItems + accessories.length + Math.max(0, numAccessories - accessories.length)) slots.push(null);
    this.items = slots.filter((item): item is ItemObject => !!item);
    const ignore = slots.map((item) => !item || !canUseBaseItem(unit, item, game));
    if (ignore.every(Boolean)) {
      this.menu = null;
      game.state.back();
      return;
    }
    const previous = this.menu?.currentIndex ?? 0;
    this.menu = new PrepChoice(game, slots.map((item) => item
      ? { kind: 'item' as const, item }
      : { kind: 'empty' as const }), [6, 72]);
    this.menu.setIgnore(ignore);
    if (!ignore[previous]) this.menu.currentIndex = previous;
  }

  override update(): StateResult {
    this.menu?.update();
    getGame().memory.get('manage_menu')?.update?.();
  }

  override takeInput(event: InputEvent): StateResult {
    if (!this.menu || !this.unit) return;
    const game = getGame();
    if (event === 'DOWN') { game.audioManager?.playSfx?.('Select 5'); this.menu.moveDown(prepIsFirstPush(game, 'DOWN')); return; }
    if (event === 'UP') { game.audioManager?.playSfx?.('Select 5'); this.menu.moveUp(prepIsFirstPush(game, 'UP')); return; }
    if (event === 'BACK') {
      game.audioManager?.playSfx?.('Select 4');
      this.menu = null;
      game.memory.delete('base_use_unit');
      game.state.back();
      return;
    }
    if (event !== 'SELECT') return;
    game.audioManager?.playSfx?.('Select 1');
    const selected = this.menu.getCurrentItem();
    const index = selected ? this.items.indexOf(selected) : -1;
    const item = this.items[index];
    if (!item || !canUseBaseItem(this.unit, item, game)) return;
    if (useItemInBase(game, this.unit, item, 'base_use') === 'pushed') return;
    this.buildMenu();
  }

  override draw(surf: Surface): Surface {
    const game = getGame();
    const bg = game.memory.get('prep_bg');
    if (bg?.draw) bg.draw(surf);
    else surf.fillRect(0, 0, viewport.width, viewport.height, 'rgba(8,8,24,0.96)');
    const [ox, oy] = prepScreenOrigin();
    game.memory.get('manage_menu')?.draw?.(surf, ox, oy);
    this.menu?.draw(surf, ox, oy);
    return surf;
  }

  override end(): StateResult {
    this.menu = null;
    getGame().memory.delete('base_use_unit');
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
  private targetItemMode: 'repair' | 'steal' | 'trace' | null = null;

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
    const customCombatUtility = activeItem.isSpell() && (
      activeItem.hasComponent('eval_heal') ||
      activeItem.hasComponent('heal_no_target_restrict') ||
      activeItem.hasComponent('solomon_heal') ||
      activeItem.hasComponent('restore_no_target_restrict') ||
      activeItem.hasComponent('refresh_no_target_restrict')
    );
    if (activeItem === this.item && (combatStatus || customCombatUtility)) {
      let defender = game.board.getUnit(target[0], target[1]);
      if (!defender && customCombatUtility) {
        const resolved = game.targetSystem.getTargetFromPosition(unit, activeItem, target);
        defender = [resolved.mainTarget, ...resolved.splash]
          .filter((position): position is [number, number] => !!position)
          .map((position) => game.board.getUnit(position[0], position[1]))
          .find((candidate: UnitObject | null): candidate is UnitObject => !!candidate) ?? null;
      }
      if (!defender) return;
      game.memory.set('combat_item', activeItem);
      game.memory.set('combat_target_position', [...target]);
      game.combatTarget = defender;
      game.highlight.clear();
      game.state.change('combat');
      return;
    }

    if (activeItem === this.item &&
        (activeItem.hasComponent('promote') || activeItem.hasComponent('force_promote') ||
         activeItem.hasComponent('class_change'))) {
      const defender = game.board.getUnit(target[0], target[1]);
      if (!defender) return;
      const forceKlass = activeItem.getComponent<string>('force_promote');
      const isClassChange = activeItem.hasComponent('class_change');
      let options: string[];
      if (forceKlass) {
        options = [forceKlass];
      } else if (isClassChange) {
        const prefab = game.db.units.get(defender.nid) as any;
        options = !defender.generic && Array.isArray(prefab?.alternate_classes)
          ? [...prefab.alternate_classes]
          : [];
      } else {
        const klass = game.db.classes.get(defender.klass);
        options = klass?.turns_into ? [...klass.turns_into] : [];
      }
      if (options.length === 0) return;
      if (options.length === 1) {
        applyItemStartResourceHooks(game, unit, this.item);
        performPromotionOrClassChange(
          defender,
          options[0],
          game,
          isClassChange ? 'change_class' : 'promote',
        );
        finishCoreItemUse(unit, this.item, [defender], new Map(), false, true);
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
      game.memory.set(
        'promotion_choice_source',
        isClassChange ? 'change_class' : 'promote',
      );
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

    if (activeItem === this.item && isStealItem(activeItem)) {
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

    if (activeItem === this.item && activeItem.hasComponent('trace')) {
      const defender = game.board.getUnit(target[0], target[1]);
      this.selectableTargetItems = defender?.items.filter((candidate: ItemObject) =>
        traceItemRestrict(unit, candidate, game.db),
      ) ?? [];
      if (!defender || this.selectableTargetItems.length === 0) return;
      this.pendingTarget = target;
      this.targetItemMode = 'trace';
      const options: MenuOption[] = this.selectableTargetItems.map((candidate, itemIndex) => ({
        label: candidate.name,
        value: `trace_${itemIndex}`,
        enabled: true,
      }));
      const [cameraX, cameraY] = game.camera.getOffset();
      const menuX = Math.min(target[0] * TILEWIDTH - cameraX + TILEWIDTH + 4, viewport.width - 100);
      const menuY = Math.min(target[1] * TILEHEIGHT - cameraY, viewport.height - options.length * 16 - 8);
      this.targetItemMenu = new ChoiceMenu(options, Math.max(0, menuX), Math.max(0, menuY));
      return;
    }

    if (activeItem === this.item &&
        (activeItem.isWeapon() ||
         (activeItem.isSpell() && !activeItem.hasCoreUseEffect()))) {
      const defender = game.board.getUnit(target[0], target[1]);
      if (!defender && (activeItem.hasComponent('event_on_use') ||
          activeItem.hasComponent('event_on_hit') ||
          activeItem.hasComponent('event_after_use') ||
          activeItem.hasComponent('event_after_combat') ||
          activeItem.hasComponent('event_after_combat_on_hit') ||
          activeItem.hasComponent('event_after_combat_even_miss'))) {
        applyItemStartResourceHooks(game, unit, activeItem);
        queueDirectItemUseEvents(game, unit, activeItem, target);
        finishCoreItemUse(unit, activeItem, [], new Map(), false, true);
        game.memory.delete('item_use_item');
        game.highlight.clear();
        if (game.eventManager?.hasActiveEvents()) game.state.change('event');
        else game.state.back();
        return;
      }
      if (!defender) return;
      game.memory.set('combat_item', activeItem);
      game.combatTarget = defender;
      game.highlight.clear();
      game.state.change('combat');
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
      if (game.eventManager?.hasActiveEvents()) game.state.change('event');
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
      const itemIndex = Number.parseInt(menuResult.selected.replace(/^(repair|steal|trace)_/, ''), 10);
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
      if (this.targetItemMode === 'trace' && unit && this.item && this.pendingTarget && targetItem) {
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
    this.drawSpellForecast(result);
    this.targetItemMenu?.draw(result);
    return result;
  }

  private spellForecastCursor = '';

  /**
   * Python CombatTargetingState.draw for a non-weapon item: the spell window
   * (ui_view.draw_spell_info) for the visible unit under the cursor, rebuilt
   * whenever the cursor moves (reset_info).
   */
  private drawSpellForecast(surf: Surface): void {
    const game = getGame();
    const unit: UnitObject | null = game.selectedUnit;
    const item = this.activeItem();
    if (!unit || !item || this.targetItemMenu) return;
    const [cx, cy] = game.cursor.getPosition();
    const key = `${cx},${cy}`;
    if (key !== this.spellForecastCursor) {
      this.spellForecastCursor = key;
      game.hud.resetInfo();
    }
    const visible = game.board?.inVision([cx, cy], 'player', game.getCurrentFogInfo?.(), game.db, game.getAllUnits?.()) ||
      item.hasComponent('ignore_fog_of_war');
    const targetUnit: UnitObject | null = visible ? game.board?.getUnit?.(cx, cy) ?? null : null;
    if (!targetUnit || item.isWeapon()) return;
    game.hud.drawSpellInfo(surf, game, unit, item, targetUnit);
  }

  override end(): StateResult {
    this.targetItemMenu = null;
    this.pendingTarget = null;
    this.selectableTargetItems = [];
    this.targetItemMode = null;
    this.sequenceIndex = 0;
    this.selectedTargets = [];
    this.spellForecastCursor = '';
    getGame().highlight.clear();
    getGame().hud.resetInfo();
    getGame().cursor.show?.();
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
    game.memory.delete('promotion_choice_source');
    game.memory.delete('promotion_choice_origin');
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
      const source = game.memory.get('promotion_choice_source') === 'change_class'
        ? 'change_class'
        : 'promote';
      const baseUse = game.memory.get('promotion_choice_origin') === 'base_use';
      if (target && item && actor) {
        if (baseUse) game.actionLog.doAction(new MarkActionGroupStart(actor, 'item_use'));
        applyItemStartResourceHooks(game, actor, item);
        performPromotionOrClassChange(target, newKlass, game, source);
        finishCoreItemUse(actor, item, [target], new Map(), baseUse, true);
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

  /** Python menus.Trade (shared with prep trading). */
  menu: TradeMenu | null = null;
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
      this.openTrade(unit);
      return;
    }

    if (!unit.position) {
      game.state.back();
      return;
    }

    this.adjacentAllies = getTradePartners(unit);
    if (this.adjacentAllies.length === 0) {
      game.state.back();
      return;
    }

    if (this.adjacentAllies.length === 1) {
      // Only one partner, skip selection
      this.tradePartner = this.adjacentAllies[0];
      this.openTrade(unit);
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

  /** Python TradeState.start: menus.Trade(initiator, partner). */
  private openTrade(unit: UnitObject): void {
    const game = getGame();
    if (!this.tradePartner) return;
    game.cursor.visible = false;
    this.menu = new TradeMenu(game, unit, this.tradePartner);
    this.phase = 'select_items';
  }

  /** Python TradeState.do_trade (+ has_traded). */
  private doTrade(): boolean {
    const game = getGame();
    const menu = this.menu;
    const selected = menu?.selectedItem();
    if (!menu || !selected) return false;
    const [owner1, item1] = selected;
    const [owner2, item2] = menu.currentItem();
    if (!prepCheckTrade(game, item1, owner1, item2, owner2)) {
      menu.unsetSelectedOption();
      return false;
    }
    const index1 = item1 ? owner1.items.indexOf(item1) : owner1.items.length;
    const index2 = item2 ? owner2.items.indexOf(item2) : owner2.items.length;
    game.actionLog.doAction(new TradeAction(owner1, index1, owner2, index2));
    game.actionLog.doAction(new HasTradedAction(game.selectedUnit));
    menu.unsetSelectedOption();
    menu.updateOptions();
    return true;
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
          this.openTrade(game.selectedUnit);
          this.targetMenu = null;
        }
      }
      return;
    }

    const menu = this.menu;
    if (this.phase !== 'select_items' || !menu) return;
    const sfx = (name: string): void => game.audioManager?.playSfx?.(name);
    if (event === 'DOWN') {
      if (menu.moveDown()) sfx('Select 6');
    } else if (event === 'UP') {
      if (menu.moveUp()) sfx('Select 6');
    } else if (event === 'RIGHT') {
      if (menu.moveRight()) sfx('TradeRight');
    } else if (event === 'LEFT') {
      if (menu.moveLeft()) sfx('TradeRight');
    } else if (event === 'BACK') {
      sfx('Select 4');
      if (menu.hasSelection()) {
        menu.unsetSelectedOption();
      } else {
        // Python TradeState.back: return to the unit's action menu. The
        // turn is not consumed; HasTraded was recorded per completed swap.
        game.cursor.visible = true;
        game.state.back();
      }
    } else if (event === 'SELECT') {
      if (menu.hasSelection()) {
        sfx(this.doTrade() ? 'Select 1' : 'Error');
      } else {
        sfx('Select 1');
        menu.setSelectedOption();
      }
    } else if (event === 'INFO') {
      sfx(menu.infoFlag ? 'Info Out' : 'Info In');
      menu.toggleInfo();
    }
  }

  override update(): StateResult {
    this.menu?.update();
  }

  override draw(surf: Surface): Surface {
    if (this.phase === 'select_partner' && this.targetMenu) {
      this.targetMenu.draw(surf);
    }
    if (this.phase === 'select_items' && this.menu) {
      // Python TradeState is a MapState: menus.Trade draws over the map.
      const { x, y } = MenuScene.origin();
      this.menu.draw(surf, x, y);
      this.menu.drawInfo(surf, x, y);
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

    const pairUp = !!game.db.getConstant('pairup', false);
    this.rescuableUnits = getAdjacentAllies(unit, unit.position[0], unit.position[1])
      .filter((ally) => !ally.isRescued() && !ally.isRescuing() &&
        (pairUp ? ally.team === unit.team : canCarry(unit, ally, game)));

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
// 5a. CombatArtChoiceState — Activate a child skill for the next attack
// ============================================================================

export class CombatArtChoiceState extends State {
  readonly name = 'combat_art_choice';
  override readonly transparent = true;

  private menu: ChoiceMenu | null = null;
  private options: CombatArtOption[] = [];

  override begin(): StateResult {
    const game = getGame();
    const unit: UnitObject = game.selectedUnit;
    if (!unit) {
      game.state.back();
      return;
    }
    deactivateCombatArts(unit);
    game.memory.delete('combat_art_parent');
    game.memory.delete('combat_art_weapons');
    // Targeting and weapon choice unwind themselves after combat. Combat art
    // choice must do the same or a finished unit is dropped back into the art
    // menu and the phase cannot advance without an extra cancel input.
    if (unit.finished || !unit.canStillAct()) {
      this.menu = null;
      game.state.back();
      return 'repeat';
    }
    this.options = getCombatArtOptions(game, unit);
    if (this.options.length === 0) {
      game.state.back();
      return;
    }
    const menuOptions = this.options.map((option, index) => ({
      label: option.skill.name,
      value: `combat_art_${index}`,
      enabled: true,
    }));
    this.menu = new ChoiceMenu(
      menuOptions,
      Math.max(4, viewport.width - 112),
      Math.max(4, (viewport.height - menuOptions.length * 16) / 2),
    );
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
      this.menu = null;
      game.state.back();
      return;
    }
    const index = Number(result.selected.slice('combat_art_'.length));
    const option = this.options[index];
    const unit: UnitObject = game.selectedUnit;
    if (option && unit && activateCombatArt(game, unit, option)) {
      this.menu = null;
      game.state.change('weapon_choice');
    }
  }

  override draw(surf: Surface): Surface {
    this.menu?.draw(surf);
    return surf;
  }
}

// ============================================================================
// 5b. WeaponChoiceState — Select which weapon to use before attacking
// ============================================================================

export class WeaponChoiceState extends State {
  readonly name = 'weapon_choice';
  override readonly transparent = true;

  private menu: ChoiceMenu | null = null;
  private weapons: ItemObject[] = [];
  private previousEquipped: ItemObject | null = null;
  /** Python SpellChoiceState: same menu over the unit's spells. */
  private spellMode = false;

  override start(): StateResult {
    const game = getGame();
    this.spellMode = game.memory.get('weapon_choice_mode') === 'spells';
    game.memory.delete('weapon_choice_mode');
  }

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

    const combatArtWeapons = game.memory.get('combat_art_weapons') as ItemObject[] | undefined;
    const combatArtMode = !!game.memory.get('combat_art_parent');
    // Python WeaponChoiceState / SpellChoiceState.get_options: weapons (or
    // spells) that have a valid target, in inventory order.
    const hasTargets = (item: ItemObject): boolean =>
      itemAvailable(unit, item, game.db, game) &&
      (game.targetSystem?.getValidTargetsRecursive(unit, item).length ?? 0) > 0;
    if (combatArtMode && combatArtWeapons) {
      this.weapons = combatArtWeapons.filter((item) =>
        unit.items.includes(item) && itemAvailable(unit, item, game.db, game));
    } else if (this.spellMode) {
      this.weapons = unit.items.filter((item) => item.isSpell() && !item.isWeapon() && hasTargets(item));
    } else {
      this.weapons = unit.items.filter((item) => item.isWeapon() && hasTargets(item));
    }

    if (this.weapons.length === 0) {
      game.state.back();
      return;
    }

    // Remember current equipped weapon for undo
    this.previousEquipped = getEquippedWeapon(unit, game.db, game);

    // Build menu options (Python always shows the menu, even for one item).
    const options: MenuOption[] = this.weapons.map((w, index) => ({
      label: w.name,
      value: String(index),
      enabled: true,
      itemRow: itemMenuRow(unit, w, game),
    }));

    this.menu = new ChoiceMenu(options, 0, 8);
    placeAutoMenu(this.menu, game);

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
    const minRange = modifiedMinimumRange(unit, weapon, game);
    const maxRange = modifiedMaximumRange(unit, weapon, game);
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
      if (game.memory.get('combat_art_parent')) {
        deactivateCombatArts(unit);
        game.memory.delete('combat_art_parent');
        game.memory.delete('combat_art_weapons');
      }
      game.highlight.clear();
      this.menu = null;
      game.state.back();
      return;
    }

    if ('selected' in result) {
      const weapon = this.weapons[Number(result.selected)];
      if (weapon && this.spellMode) {
        // Spells target through the chosen item, not the equipped weapon.
        game.highlight.clear();
        this.menu = null;
        game.memory.set('item_use_item', weapon);
        game.state.change('item_targeting');
        return;
      }
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
    // Python WeaponChoiceState.draw: item description panel, then the menu.
    const game = getGame();
    const current = this.weapons[this.menu?.selectedIndex ?? -1];
    if (current && this.menu) drawItemDescriptionPanel(surf, game, game.selectedUnit, current);
    this.menu?.draw(surf);
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
      const minRange = modifiedMinimumRange(unit, weapon, game);
      const maxRange = modifiedMaximumRange(unit, weapon, game);
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

    // Python CombatTargetingState.begin: game.cursor.combat_show().
    game.cursor.combatShow?.();
    // Position cursor on first target
    game.hud.prepareAttackInfo();
    this.focusTarget();
  }

  private focusTarget(): void {
    const game = getGame();
    game.hud.resetInfo();
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

    // Python CombatTargetingState.draw: the forecast window for the unit
    // under the cursor (ui_view.draw_attack_info).
    const target = this.targets[this.targetIndex];
    if (target) {
      const unit: UnitObject = game.selectedUnit;
      const weapon = getEquippedWeapon(unit, game.db, game);
      if (weapon && target.position) {
        // The red combat cursor (Cursor.combatShow) marks the target.
        game.hud.drawAttackInfo(surf, game, unit, weapon, target, this.attackerAssist, this.defenderAssist);
      }
    }
    return surf;
  }

  override end(): StateResult {
    const game = getGame();
    game.highlight.clear();
    game.hud.resetInfo();
    game.cursor.show?.();
    // Clear targets to prevent stale draw (red rectangle) when CombatState
    // draws on top of this transparent state
    this.targets = [];
  }
}

// ============================================================================
// 6. CombatState
// ============================================================================

export function resolveCombatTargetGroup(
  game: any,
  attacker: UnitObject,
  item: ItemObject,
  selectedDefender: UnitObject,
  selectedPosition: [number, number] | null = null,
): { representative: UnitObject; mainDefender: UnitObject | null; splashDefenders: UnitObject[] } {
  let mainDefender: UnitObject | null = selectedDefender;
  let splashDefenders: UnitObject[] = [];
  const targetPosition = selectedPosition ?? selectedDefender.position;
  if (game.targetSystem && targetPosition) {
    const resolved = game.targetSystem.getTargetFromPosition(attacker, item, targetPosition);
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
type CombatPhase = 'combat' | 'anim_exit' | 'death' | 'exp_init' | 'exp_wait' | 'exp0' | 'exp100' | 'exp_leave' | 'level_up' | 'level_screen' | 'stole' | 'rank_up' | 'got_item' | 'cleanup';

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
  /** Python AnimationCombat.battle_music: what battle_fade_in returned (null: nothing to undo) */
  private battleMusic: Promise<SongObject | null> | null = null;

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
  /** Python ExpState.level_up_animation. */
  private levelUpLogo: MapAnimation | null = null;

  /** Python ExpState.create_level_up_logo. */
  private createLevelUpLogo(): MapAnimation | null {
    const game = getGame();
    if (!this.combat) return createPixelAnimation('LevelUpBattle', 0, 6);
    const unit = this.getActiveCombat()?.attacker;
    if (unit?.position) {
      const [cx, cy] = game.camera.getPosition();
      return createPixelAnimation('LevelUpMap',
        (unit.position[0] - cx / TILEWIDTH - 2) * TILEWIDTH,
        (unit.position[1] - cy / TILEHEIGHT - 1) * TILEHEIGHT);
    }
    return createPixelAnimation('LevelUpMap', Math.floor(viewport.width / 2), Math.floor(viewport.height / 2));
  }
  private portraitImg: HTMLImageElement | null = null;

  // Dying units (Python game.death.dying_units) and whether their fade began
  private dyingUnits: UnitObject[] = [];
  private deathStarted: boolean = false;

  // Platform images for animation combat
  private leftPlatformImg: HTMLImageElement | null = null;
  private rightPlatformImg: HTMLImageElement | null = null;

  // Battle background panorama image
  private battleBackgroundImg: HTMLImageElement | null = null;
  private rankUpBanner: Banner | null = null;
  private stoleBanner: Banner | null = null;
  private stoleBannerShown: boolean = false;
  private gotItemBanner: Banner | null = null;
  private gotItemBannerQueue: Banner[] = [];
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
    const selectedCombatPosition = game.memory.get('combat_target_position') as
      [number, number] | undefined;
    game.memory.delete('combat_target_position');
    const attackItem = selectedCombatItem ?? getEquippedWeapon(attacker, game.db, game);
    if (!attackItem) {
      game.state.back();
      return;
    }
    const targetGroup = resolveCombatTargetGroup(
      game,
      attacker,
      attackItem,
      defender,
      selectedCombatPosition ?? null,
    );
    const primaryDefender = targetGroup.mainDefender;
    const splashDefenders = targetGroup.splashDefenders;
    defender = targetGroup.representative;
    const groupedCombat = !primaryDefender || splashDefenders.length > 0;
    const defenseItem = primaryDefender ? getEquippedWeapon(primaryDefender, game.db, game) : null;
    if (primaryDefender) {
      queueCombatSkillStartEvents(game, attacker, primaryDefender, attackItem, defenseItem);
    }
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
    applyCombatParticipantItemStartHooks(
      game,
      attacker,
      attackItem,
      [
        ...(primaryDefender ? [primaryDefender] : []),
        ...splashDefenders,
      ],
    );

    // Read and consume the combat script (set by interact_unit)
    const script = game.combatScript;
    game.combatScript = null;

    // Check if both units have battle animations available
    // Utility spells use the map presentation in LT and have no weapon pose.
    // Dual-strike mechanics currently use the map presentation so every
    // partner phase has an on-map actor and independent lunge/HP target.
    const hasAttackStance = !!attacker.strikePartner || !!primaryDefender?.strikePartner;
    // Python interaction.has_animation: the 'animation' setting (Always /
    // Your Turn / Combat Only / Never), inverted while START is held.
    const animSetting = String(getSetting('animation') ?? 'Always');
    const animWanted = animSetting === 'Always' ||
      (animSetting === 'Your Turn' && attacker.team === 'player') ||
      (animSetting === 'Combat Only' && !!primaryDefender && !game.db.areAllied(attacker.team, primaryDefender.team));
    const wantAnimation = animWanted !== !!game.input?.isPressed?.('START');
    // interact_unit;...;force_no_animation always uses the map presentation.
    const forceNoAnimation = !!game.memory.get('combat_force_no_animation');
    game.memory.delete('combat_force_no_animation');
    const canAnimate = wantAnimation && !forceNoAnimation && !groupedCombat && !hasAttackStance &&
      !attackItem.hasComponent('spell') && this.tryCreateAnimationCombat(
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
    this.dyingUnits = [];
    this.deathStarted = false;
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

    // Python AnimationCombat.start_battle_music: only animated combat changes
    // the music. A song with a -battle variant crossfades to it in place;
    // otherwise the battle song fades in over the phase music.
    this.battleMusic = null;
    if (this.isAnimationCombat && this.animCombat) {
      // Python runs start_battle_music in the 'battle_music' state after
      // init_pause, and finish() fades back when the fade_out ends.
      this.animCombat.onStartBattleMusic = () => {
        const levelMusic = (game.currentLevel?.music ?? {}) as unknown as Record<string, string | null | undefined>;
        const attackerBattle = attacker.tags.includes('Boss') ? levelMusic.boss_battle : null;
        const defenderBattle = defender?.tags?.includes('Boss') ? levelMusic.boss_battle : null;
        const teamBattle = levelMusic[`${attacker.team}_battle`];
        const battleTrack = attackerBattle || defenderBattle || teamBattle;
        if (battleTrack) {
          const fromStart = !!game.db.getConstant?.('restart_battle_music', true);
          this.battleMusic = game.audioManager.battleFadeIn(battleTrack, 400, fromStart);
        }
      };
      this.animCombat.onFinish = () => this.fadeBackBattleMusic();
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

      // Python `get_battle_anim` bails before any lookup when either side's
      // item forces the map animation, dropping the whole exchange to map
      // combat rather than animating one side only.
      if (forceMapAnim(attacker, attackItem)) return false;
      if (defenseItem && forceMapAnim(defender, defenseItem)) return false;

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

      const attackerTransforms = transforms(attacker, attackItem);
      const defenderTransforms = !!defenseItem && transforms(defender, defenseItem);

      // Transform resources conventionally expose the post-transform attack as
      // Dragonstone while the item itself has no weapon_type component.
      const atkWeaponAnim = attackerTransforms
        ? atkAnimData.weapon_anims.find((anim: any) => anim.nid === 'Dragonstone')
          ?? selectWeaponAnim(atkAnimData, atkWeaponType ?? null)
        : selectWeaponAnim(atkAnimData, atkWeaponType ?? null);
      const defWeaponAnim = defenderTransforms
        ? defAnimData.weapon_anims.find((anim: any) => anim.nid === 'Dragonstone')
          ?? selectWeaponAnim(defAnimData, defWeaponType ?? null)
        : selectWeaponAnim(defAnimData, defWeaponType ?? null);
      if (!atkWeaponAnim || !defWeaponAnim) return false;

      // Create BattleAnimation instances with real pose data but empty frames
      // (sprites will hot-swap in once async loading completes)
      const atkAnim = new RealBattleAnimation(atkWeaponAnim, new Map());
      const defAnim = new RealBattleAnimation(defWeaponAnim, new Map());
      const atkTransformWeaponAnim = attackerTransforms
        ? atkAnimData.weapon_anims.find((anim: any) => anim.nid === 'Transform') ?? null
        : null;
      const atkRevertWeaponAnim = attackerTransforms
        ? atkAnimData.weapon_anims.find((anim: any) => anim.nid === 'Revert') ?? null
        : null;
      const defTransformWeaponAnim = defenderTransforms
        ? defAnimData.weapon_anims.find((anim: any) => anim.nid === 'Transform') ?? null
        : null;
      const defRevertWeaponAnim = defenderTransforms
        ? defAnimData.weapon_anims.find((anim: any) => anim.nid === 'Revert') ?? null
        : null;
      if ((attackerTransforms && (!atkTransformWeaponAnim || !atkRevertWeaponAnim))
        || (defenderTransforms && (!defTransformWeaponAnim || !defRevertWeaponAnim))) {
        console.warn('Transform item is missing required Transform/Revert battle animations');
        return false;
      }
      const transformAnimations: TransformBattleAnimations = {
        attackerTransform: atkTransformWeaponAnim
          ? new RealBattleAnimation(atkTransformWeaponAnim, new Map())
          : null,
        attackerRevert: atkRevertWeaponAnim
          ? new RealBattleAnimation(atkRevertWeaponAnim, new Map())
          : null,
        defenderTransform: defTransformWeaponAnim
          ? new RealBattleAnimation(defTransformWeaponAnim, new Map())
          : null,
        defenderRevert: defRevertWeaponAnim
          ? new RealBattleAnimation(defRevertWeaponAnim, new Map())
          : null,
      };

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
        transformAnimations,
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

      // Battle background panorama (attacker's terrain) only with the
      // battle_bg setting on; Python's default is off, so the scene shows
      // over the dimmed map.
      const bgNid = getSetting('battle_bg') ? this.getUnitBackgroundNid(attacker, db) : null;
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
      const extraAnimations = [
        [atkAnimData.nid, atkTransformWeaponAnim, attacker, atkAnimData, transformAnimations.attackerTransform],
        [atkAnimData.nid, atkRevertWeaponAnim, attacker, atkAnimData, transformAnimations.attackerRevert],
        [defAnimData.nid, defTransformWeaponAnim, defender, defAnimData, transformAnimations.defenderTransform],
        [defAnimData.nid, defRevertWeaponAnim, defender, defAnimData, transformAnimations.defenderRevert],
      ] as const;
      for (const [animNid, weaponAnim, unit, combatAnimData, battleAnim] of extraAnimations) {
        if (weaponAnim && battleAnim) {
          this.loadSingleCombatSprite(
            animNid, weaponAnim, unit, combatAnimData, battleAnim, db,
          );
        }
      }

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

  private async loadSingleCombatSprite(
    animNid: string,
    weaponAnim: import('../../combat/battle-anim-types').WeaponAnimData,
    unit: UnitObject,
    combatAnimData: import('../../combat/battle-anim-types').CombatAnimData,
    battleAnim: RealBattleAnimation,
    db: any,
  ): Promise<void> {
    try {
      const palette = selectPalette(
        combatAnimData,
        unit,
        db.combatPalettes as Map<string, import('../../combat/battle-anim-types').PaletteData>,
      );
      if (!palette) return;
      const frames = await loadAndConvertWeaponAnim(
        getGame().resources,
        animNid,
        weaponAnim,
        palette,
      );
      if (!frames) return;
      for (const [nid, canvas] of frames) battleAnim.frameImages.set(nid, canvas);
    } catch (error) {
      console.warn(`Failed to load transform battle animation ${animNid}-${weaponAnim.nid}:`, error);
    }
  }

  override takeInput(): StateResult {
    const game = getGame();
    if (!game.input) return;

    // BACK (Escape/X) instantly skips combat (both animation and map combat).
    // START (S) toggles 4x speed for animation combat.
    if (game.input.justPressed('BACK')) {
      if (this.phase === 'combat' || this.phase === 'anim_exit') {
        // Skip the combat animation entirely — results will be applied
        // by the normal 'done' handling in update()
        const activeCombat = this.isAnimationCombat ? this.animCombat : this.combat;
        if (activeCombat) {
          activeCombat.skipToEnd();
        }
      } else if (this.phase === 'death' || this.phase === 'exp_init' || this.phase === 'exp_wait' ||
                 this.phase === 'exp0' || this.phase === 'exp100' || this.phase === 'exp_leave' ||
                 this.phase === 'level_up' || this.phase === 'level_screen') {
        // Skip post-combat phases — stop looping SFX, finish any pending
        // deaths, and jump straight to cleanup
        game.audioManager?.stopSfx?.('Experience Gain');
        this.finishDeathsNow();
        this.phase = 'cleanup';
        this.phaseTimer = 0;
      }
    }
    if (game.input.justPressed('START')) {
      // Python CombatState: START toggles combat.skip() / end_skip().
      const active = this.isAnimationCombat ? this.animCombat : this.combat;
      if (active) active.skipMode = !active.skipMode;
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
        // Python AnimationCombat applies clean_up1 (exp, wexp, items) while
        // the scene is still shown: results come in at exp_wait, the exp bar
        // draws over the battle, and the scene then slides out (anim_exit).
        const animReadyForExp = this.isAnimationCombat && this.animCombat?.state === 'exp_wait';
        if ((done || animReadyForExp) && !this.results) {
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
          game.actionLog.doAction(new HasAttackedAction(activeCombat.attacker));
          queueCombatItemBreakEvents(game, activeCombat.strikes);
          applyCombatItemEndHooks(game, activeCombat.strikes);
          queueCombatSkillEvents(
            game,
            activeCombat.strikes,
            activeCombat.attacker,
            activeCombat.defender,
            activeCombat.attackItem,
            activeCombat.defenseItem,
          );
          applyCombatSkillEndHooks(
            game,
            activeCombat.strikes,
            activeCombat.attacker,
            activeCombat.defender,
            activeCombat.procPlayback,
          );
          queueCombatItemEvents(game, activeCombat.strikes);
          if (this.results.stolenItem) {
            const stolenItem = this.results.stolenItem;
            const stealDefender = this.getPrimaryCombatDefender() ?? activeCombat.defender;
            const pendingDiscard = applyStolenItemTransfer(
              game.actionLog,
              game.db,
              activeCombat.attacker,
              stealDefender,
              stolenItem,
            );
            if (pendingDiscard) this.pendingDiscards.push(pendingDiscard);
          }
          // Droppable item pickup (Python simple_combat.handle_item_gain).
          const pickupResult = applyDroppableItemPickups(
            game.actionLog,
            game.db,
            this.results,
            activeCombat.attacker,
            this.getPrimaryCombatDefender() ?? activeCombat.defender,
          );
          // Python banner.AcquiredItem per pickup.
          this.gotItemBannerQueue = pickupResult.pickups.map(({ unit, item }) => new Banner(
            acquiredItemText(unit.name, item.name), itemIcon(item), 3000, { sound: 'Item' },
          ));
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
          // game.death.should_die: dying units stay on the map until the
          // dying fade, which Python runs after the exp screen (the combat
          // state pushes 'exp' in clean_up1 and 'dying' in clean_up2).
          this.dyingUnits = [
            ...this.getDefenderDeaths(),
            ...(this.results.attackerDead ? [activeCombat.attacker] : []),
          ].filter((unit, index, all) => all.indexOf(unit) === index);
          for (const unit of this.combatPresentationUnits()) {
            if (this.dyingUnits.includes(unit)) markDying(unit);
            else if (isUnitDying(unit)) clearUnitFx(unit); // miracle
          }
          this.deathStarted = false;
          if (this.results.expGained > 0 && activeCombat.attacker.team === 'player') {
            this.startExpPhase();
          } else {
            this.startRankUpOrCleanup();
          }
        }
        break;
      }

      case 'anim_exit': {
        // revert_transform -> fade_out_wait -> name_tags_out -> all_out ->
        // fade_out, after which the map shows for the dying fade.
        const finished = this.animCombat?.update(realDelta) ?? true;
        if (finished || this.animCombat?.state === 'done') this.startRankUpOrCleanup();
        break;
      }

      case 'death': {
        // DyingState / DeathManager.update: 'Death' SFX with a white flicker
        // and fade_out transition, then Die once 400 ms have passed.
        if (!this.deathStarted) {
          this.deathStarted = true;
          this.phaseTimer = 0;
          for (const unit of this.dyingUnits) {
            game.audioManager?.playSfx?.('Death');
            startDyingFade(unit);
          }
        } else {
          this.phaseTimer += realDelta;
        }
        if (this.phaseTimer >= DEFAULT_TRANSITION_TIME - 50) {
          this.finishDeathsNow();
          this.startRankUpOrCleanup();
        }
        break;
      }

      // ---------------------------------------------------------------
      // EXP state machine — faithful port of Python ExpState
      // Phases: exp_init → exp_wait → exp0 → [exp100 →] exp_leave → [level_up → level_screen →] cleanup
      // ---------------------------------------------------------------

      case 'exp_init': {
        // Create the ExpBar, start fade-in
        // Python passes combat_object only from AnimationCombat: map combat
        // centers the bar, the battle scene puts it at the bottom.
        this.expBar = new ExpBarClass(this.expOldExp, !this.isAnimationCombat);
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
          this.levelUpLogo = this.createLevelUpLogo();
        }
        this.phaseTimer += realDelta;
        // Python ExpState 'level_up' waits for the LevelUpMap/LevelUpBattle
        // logo (time-based); without one the 500 ms pause stands in.
        if (this.levelUpLogo) {
          this.levelUpLogo.update();
          if (this.phaseTimer < Math.min(4000, this.levelUpLogo.getDuration())) break;
        }
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
              game.db.classes?.get(unit.klass)?.name ?? unit.klass,
              createPixelAnimation,
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
        const resetByCombatHook = !attacker.hasAttacked;
        const hasCanto = !resetByCombatHook && !attacker.isDead() &&
          unitHasCanto(attacker, defender, game);
        const tradePair = combatTradePair(activeCombat!.strikes);
        const itemReturnsToMenu = attacker.team === 'player' &&
          menuAfterCombat(attacker, activeCombat!.attackItem);
        const returnsToMenu = attacker.team === 'player' &&
          (resetByCombatHook || itemReturnsToMenu);
        const retainsAttack = itemReturnsToMenu &&
          canAttackAfterCombat(attacker, activeCombat!.attackItem);

        if (!attacker.isDead()) {
          if (retainsAttack) {
            game.actionLog.doAction(new HasNotAttackedAction(attacker));
            game.actionLog.doAction(new HasTradedAction(attacker));
          }
          if (hasCanto) {
            game.actionLog.doAction(new SetMovementLeftAction(
              attacker,
              cantoMovement(attacker, defender, game),
            ));
          }

          // Canto keeps the unit actionable; all other attacks consume the turn.
          if (!hasCanto && !returnsToMenu && !resetByCombatHook) {
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

          // Python's clean_up2 triggers CombatEnd and then UnitDeath, but
          // every trigger pushes an EventState and the stack runs the last
          // one first: unit_death events run before combat_end events.
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
        }

        // Activate AI groups if an enemy was involved in combat
        if (game.aiController) {
          game.aiController.activateGroupOnCombat(activeCombat!.attacker, game);
          for (const combatDefender of combatDefenders) {
            game.aiController.activateGroupOnCombat(combatDefender, game);
          }
        }

        // Python has no engine-side win/loss detection: objectives are text,
        // and projects end levels through events (unit_death / combat_end ->
        // win_game / lose_game). An auto game over here pre-empted EOtF's
        // Global_Loss (defeat text + currency banking).

        // Python AnimationCombat.finish: fade back if and only if it was faded in
        this.fadeBackBattleMusic();

        // Restore cursor and HUD visibility (hidden at combat start)
        game.cursor.visible = true;
        game.cursor.combatDraw = false;
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

        if (!wasEventCombat) {
          // Queue the post-combat continuation before EventState so the event
          // is layered above it and pops back to the correct state. Python's
          // stack preserves menu/Canto/trade while combat events run.
          if (tradePair) {
            game.selectedUnit = tradePair.unit;
            if (tradePair.partner.position) {
              game.cursor.setPos(tradePair.partner.position[0], tradePair.partner.position[1]);
            }
            game.memory.set('trade_partner', tradePair.partner);
            game.state.change('trade');
          } else if (returnsToMenu && !attacker.isDead()) {
            game.selectedUnit = attacker;
            game.memory.set('menu_after_combat', attacker.nid);
            game.state.change('menu');
          } else if (attacker.team === 'player' && hasCanto) {
            game.selectedUnit = attacker;
            game.state.change('move');
          }

          if (game.eventManager?.hasActiveEvents()) {
            game.state.change('event');
          }
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

  /** AnimationCombat.finish: fade back if and only if the music faded in. */
  private fadeBackBattleMusic(): void {
    if (!this.battleMusic) return;
    const game = getGame();
    const fromStart = !!game.db.getConstant?.('restart_battle_music', true);
    const pending = this.battleMusic;
    this.battleMusic = null;
    void pending.then((song) => {
      if (song) void game.audioManager.battleFadeBack(song, fromStart);
    });
  }

  /** Units awaiting DyingState (Python is_dying) after this combat. */
  private combatPresentationUnits(): UnitObject[] {
    const active = this.getActiveCombat();
    if (!active) return [];
    return [...new Set([active.attacker, ...this.getCombatDefenders()])];
  }

  /** Die every pending unit immediately (end of the fade, or a skip). */
  private finishDeathsNow(): void {
    const game = getGame();
    const active = this.getActiveCombat();
    for (const unit of this.dyingUnits) {
      clearUnitFx(unit);
      if (!active) continue;
      game.actionLog.doAction(new DeathAction(unit, game.board, game.initiative));
    }
    this.dyingUnits = [];
  }

  private startRankUpOrCleanup(): void {
    if (this.isAnimationCombat && this.animCombat && this.animCombat.state !== 'done') {
      this.animCombat.expDone = true;
      this.phase = 'anim_exit';
      this.phaseTimer = 0;
      return;
    }
    if (this.dyingUnits.length > 0) {
      this.phase = 'death';
      this.phaseTimer = 0;
      return;
    }
    const activeCombat = this.getActiveCombat();
    if (this.results?.stolenItem && activeCombat && !this.stoleBannerShown) {
      // Python banner.StoleItem through AlertState.
      const stolen = this.results.stolenItem;
      const allied = getGame().db.areAllied?.('player', activeCombat.attacker.team) ?? activeCombat.attacker.team === 'player';
      this.stoleBanner = new Banner(
        stoleItemText(activeCombat.attacker.name, stolen.name), itemIcon(stolen), 3000,
        { sound: allied ? 'Item' : 'ItemBreak' },
      );
      this.phase = 'stole';
      this.phaseTimer = 0;
      return;
    }
    const rankUp = this.results?.attackerRankUp;
    const weaponType = activeCombat?.attackItem.getComponent<string>('weapon_type');
    if (rankUp && activeCombat && weaponType && !this.rankUpBannerShown) {
      this.rankUpBannerShown = true;
      // Python banner.GainWexp through AlertState.
      this.rankUpBanner = new Banner(
        gainWexpText(activeCombat.attacker.name, rankUp.rank), weaponIcon(getGame().db, weaponType), 3000,
        { sound: 'Item' },
      );
      this.phase = 'rank_up';
      this.phaseTimer = 0;
      return;
    }
    if (this.gotItemBannerQueue.length > 0) {
      this.gotItemBanner = this.gotItemBannerQueue.shift()!;
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

  /**
   * Render map combat (Python MapCombat.draw): hit/cast map animations, then
   * the MapCombatInfo windows. The unit flicker, lunge, facing, vibrate and
   * damage numbers live on the unit sprites (combat/map-unit-fx.ts).
   */
  private drawMapCombat(surf: Surface): Surface {
    const rs = this.combat!.getRenderState();
    const game = getGame();
    const cameraOffset = game.camera.getOffset();

    for (const anim of rs.mapAnimations) anim.draw(surf, cameraOffset[0], cameraOffset[1]);

    // Python draws the windows while the combat state is on the stack, which
    // includes the exp bar it pushes from clean_up1; the dying fade starts
    // only after the combat state is popped.
    if (this.phase !== 'death') {
      const cameraTiles: [number, number] = [cameraOffset[0] / TILEWIDTH, cameraOffset[1] / TILEHEIGHT];
      for (const info of rs.infos) info.draw(surf, cameraTiles);
    }

    // Skill proc icons ride above their unit's window (MapCombatInfo.draw).
    const cueRows = new Map<UnitObject, number>();
    for (const cue of rs.procCues) {
      const info = rs.infos.find((candidate) => candidate.unit === cue.unit);
      const row = cueRows.get(cue.unit) ?? 0;
      cueRows.set(cue.unit, row + 1);
      if (info?.position) {
        this.drawSkillIcon(surf, cue, info.ordering !== 'left', [info.position[0] + 39, info.position[1] - 16 + row * 16]);
        continue;
      }
      const position = cue.unit.position;
      if (!position) continue;
      const px = position[0] * TILEWIDTH - cameraOffset[0] + TILEWIDTH / 2;
      const py = position[1] * TILEHEIGHT - cameraOffset[1] - 24 - row * 17;
      this.drawSkillIcon(surf, cue, true, [px, py]);
    }

    // EXP / Level-up overlays (shared with animation combat)
    this.drawExpAndLevelUp(surf);

    return surf;
  }

  // ================================================================
  // Animation Combat Renderer — GBA-style full-screen battle scene
  // ================================================================

  /**
   * Render the battle scene. Python CombatState draws the map (the lower
   * state) and the 75% fuzz outside the viewbox; AnimationCombat.draw adds
   * the scene. Once its fade_out ends nothing is drawn, so the map shows
   * through for the dying fade and banners.
   */
  private drawAnimationCombat(surf: Surface): Surface {
    const game = getGame();
    const cameraOffset = game.camera.getOffset();
    const combat = this.animCombat!;
    combat.setCameraOffset(cameraOffset[0], cameraOffset[1]);
    combat.leftPlatform = this.leftPlatformImg;
    combat.rightPlatform = this.rightPlatformImg;
    combat.battleBackground = this.battleBackgroundImg;
    combat.draw(surf);

    // Full animation combat presents one skill at a time before the strike.
    const rs = combat.getRenderState();
    if (rs.procCue && combat.sceneVisible) {
      const isRight = !combat.leftIsAttacker
        ? rs.procCue.unit === combat.attacker
        : rs.procCue.unit === combat.defender;
      this.drawSkillIcon(surf, rs.procCue, isRight, null);
    }

    // EXP / Level-up overlays (shared)
    this.drawExpAndLevelUp(surf);
    return surf;
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
      surf.fillRect(0, 0, viewport.width, viewport.height, `rgba(0,0,0,${this.darkFuzzAlpha.toFixed(2)})`);
      this.levelUpLogo?.draw(surf, 0, 0);
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
    if (this.phase === 'got_item' && this.gotItemBanner) {
      this.gotItemBanner.draw(surf);
    }
  }

  /**
   * gui.SkillIcon: the skill name in the 'text' font beside its 16px icon,
   * bouncing in, holding, and fading out (timing in proc-presentation.ts).
   * With `pos` (map combat) it centers above the unit's window; otherwise
   * (battle scene) it sits at y=32 on the owner's side.
   */
  private drawSkillIcon(
    surf: Surface,
    cue: CombatProcCue,
    right: boolean,
    pos: [number, number] | null,
  ): void {
    const { alpha, offsetX } = procCueMotion(cue);
    if (alpha <= 0) return;
    const font = FONT['text'];
    const text = cue.skill.name;
    const textWidth = font ? font.width(text) : text.length * 5;
    const hasIcon = !!cue.skill.iconNid;
    const icon = new Surface(textWidth + 22, hasIcon ? 32 : 16);
    const textX = right ? 20 : 0;
    font?.blit(icon, text, textX, 0);
    if (hasIcon) drawIcon16(icon, cue.skill.iconNid, cue.skill.iconIndex, right ? 0 : textWidth + 4, 0);
    icon.setAlpha(alpha);
    let x: number;
    let y: number;
    if (pos) {
      x = pos[0] + offsetX - Math.floor(textWidth / 2) - 8;
      y = pos[1];
    } else {
      x = right ? WINWIDTH - 26 - textWidth + offsetX : offsetX + 4;
      y = 32;
    }
    surf.blit(icon, Math.round(x), y);
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
    if (path?.length === 1 &&
        path[0][0] === target[0] && path[0][1] === target[1]) {
      game.actionLog.doAction(new WarpUnitAction(unit, target, game.board));
      game.camera.focusTile(target[0], target[1]);
      return true;
    }
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
      if (unit && (unit.finished || unit.isDead())) {
        this.waitingForCombat = false;
        this.advanceToNextUnit();
      } else if (unit?.hasAttacked) {
        this.waitingForCombat = false;
        const target = this.pendingCombatTarget;
        if (unitHasCanto(unit, target, game)) {
          const retreat = game.aiController.getCantoRetreatAction(unit);
          if (retreat?.targetPosition) {
            this.moveWithAction(
              game,
              unit,
              retreat.targetPosition,
              retreat.movePath,
            );
            if (retreat.movePath && retreat.movePath.length > 1) {
              this.waitingForMovement = true;
              game.movementSystem.beginMove(
                unit,
                retreat.movePath,
                undefined,
                () => {
                  this.waitingForMovement = false;
                  game.actionLog.doAction(new WaitAction(unit));
                  this.advanceToNextUnit();
                },
              );
              return;
            }
          }
          game.actionLog.doAction(new WaitAction(unit));
        }
        this.advanceToNextUnit();
      } else if (unit) {
        // A combat-end Reset/EvalGaleforce cleared the action flags. Python's
        // AI controller completes this action without forcing Wait.
        this.waitingForCombat = false;
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
          if (action.combatArt &&
              !activateCombatArt(game, unit, action.combatArt)) {
            game.actionLog.doAction(new WaitAction(unit));
            this.advanceToNextUnit();
            break;
          }
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

      const endingUnit = curUnitNid ? game.getUnit(curUnitNid) : null;
      if (endingUnit) applySkillTurnHooks(game, [endingUnit], 'endstep');

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
    // Python stores the cursor only when the player phase ends.
    if (game.phase?.getCurrent() === 'player') {
      game.memory.set('previous_cursor_position', game.cursor.getPosition());
    }

    const endingTeam = game.phase?.getCurrent();
    if (endingTeam) {
      applySkillTurnHooks(
        game,
        game.getTeamUnits(endingTeam).filter((unit: UnitObject) => unit.position),
        'endstep',
      );
    }

    // Advance to next phase
    game.phase.next((team: string) => game.board.getTeamUnits(team));

    // Sync turnCount to GameState so event conditions like
    // "game.turncount == 2" resolve correctly
    game.turnCount = game.phase.turnCount;

    const currentTeam = game.phase.getCurrent();
    const turnCount = game.phase.turnCount;
    const levelNid = game.currentLevel?.nid;

    const upkeepUnits = game.getTeamUnits(currentTeam).filter(
      (candidate: UnitObject) => candidate.position,
    );
    for (const unit of upkeepUnits) {
      applySkillTurnHooks(game, [unit], 'upkeep');
      applyItemUpkeepResourceHooks(
        game,
        unit,
        getSkillAbilityOptions(game, unit).map((ability) => ability.item),
      );
    }

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

    // Python TurnChangeState.end: on entering player phase after turn one,
    // count timed regions down and remove expired ones before the phase
    // events fire, remembering each for a TimeRegionComplete trigger.
    const expiredRegions: RegionData[] = [];
    if (currentTeam === 'player' && turnCount > 1 && game.currentLevel?.regions) {
      for (const region of [...game.currentLevel.regions] as RegionData[]) {
        if (region.time_left === null || region.time_left === undefined) continue;
        game.actionLog.doAction(new DecrementTimeRegionAction(region));
        if (Number(region.time_left) <= 0) {
          game.actionLog.doAction(new RemoveRegionAction(region.nid, game.currentLevel.regions));
          expiredRegions.push(region);
        }
      }
    }

    // Fire event triggers — they'll queue events for the EventState
    // to process after the phase banner dismisses. Python triggers
    // TimeRegionComplete(s), PhaseChange, then the team's turn change, and
    // its event stack runs the last trigger first. Our queue is FIFO, so
    // enqueue the turn change, then phase_change, then expired regions in
    // reverse order.
    if (game.eventManager) {
      const ctx = { game, gameVars: game.gameVars, levelVars: game.levelVars };

      if (currentTeam === 'player') {
        // turn_change fires on player phase. level_start is queued by
        // loadLevel for turn one rather than here.
        game.eventManager.trigger(
          { type: 'turn_change', turnCount, levelNid },
          ctx,
        );
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

      // phase_change fires for every phase
      game.eventManager.trigger(
        { type: 'phase_change', team: currentTeam, levelNid },
        ctx,
      );

      for (const region of [...expiredRegions].reverse()) {
        const position = region.position
          ? [region.position[0], region.position[1]] as [number, number]
          : undefined;
        game.eventManager.trigger(
          { type: 'time_region_complete', levelNid, region, position },
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

    applySkillTurnHooks(game, [unit], 'upkeep');
    applyItemUpkeepResourceHooks(
      game,
      unit,
      getSkillAbilityOptions(game, unit).map((ability) => ability.item),
    );

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
export function fadeInPhaseMusic(game: any, atTurnChange: boolean = false): void {
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

  private banner: PhaseIn | null = null;
  private fadedIn = false;
  private roamSkip = false;

  override begin(): StateResult {
    const game = getGame();
    const currentTeam = game.phase.getCurrent();
    const turnCount = game.phase.turnCount;
    // States are singletons: re-arm the end-of-banner music fade per phase.
    this.fadedIn = false;
    // Python PhaseChangeState.is_roam: free roam skips the banner and music.
    this.roamSkip = !!(game.roamInfo?.roam && game.roamInfo.roamUnitNid &&
      game.getUnit(game.roamInfo.roamUnitNid)?.position);

    if (!this.roamSkip) {
      // Phase music: fade out whatever's playing before showing the banner
      // (matches Python: phase.fade_out_phase_music() at PhaseChangeState.begin()).
      fadeOutPhaseMusic(game);
      // Play this team's phase-change stinger (Python: PhaseIn.begin() plays
      // team.phase_change_sound_effect or 'Next Turn'; team-level overrides
      // aren't modeled in the web team data yet, so this always uses the default).
      game.audioManager?.playSfx?.('Next Turn');
    }

    // Turnwheel markers: lock during non-player phases, mark phase change
    game.actionLog.doAction(new LockTurnwheel(currentTeam !== 'player'));
    game.actionLog.doAction(new MarkPhase(currentTeam));

    // Python PhaseIn.begin (player): autocursor setting -> first 'Lord'
    // tagged player unit (else first player unit); otherwise return to the
    // cursor position remembered from the previous player phase.
    if (currentTeam === 'player') {
      const playerUnits = (game.getAllUnits() as UnitObject[]).filter((u) =>
        u.team === 'player' && !!u.position && !u.isDead());
      const lord = playerUnits.find((u) => u.tags.includes('Lord')) ?? playerUnits[0];
      const remembered = game.memory.get('previous_cursor_position') as [number, number] | undefined;
      const target = getSetting('autocursor') || !remembered ? lord?.position : remembered;
      if (target) {
        game.cursor.setPos(target[0], target[1]);
        game.camera.focusTile(target[0], target[1]);
      }
    }

    if (currentTeam === 'player' && game.db.getConstant('pairup', false)) {
      for (const leader of game.getAllUnits() as UnitObject[]) {
        const follower = leader.rescuing ?? (leader.traveler ? game.getUnit(leader.traveler) : null);
        if (leader.traveler && follower) {
          game.actionLog.doAction(new GuardPairUpkeepAction(leader, follower, game.db));
        }
      }
    }

    // Python game.phase.slide_in(): PhaseIn with turnbanner_<team>, or the
    // team-coloured variant when its combat colour diverged.
    const dbColor = game.db.teams.defs.find((t: { nid: string }) => t.nid === currentTeam)?.combatColor;
    const color = game.getTeamCombatColor?.(currentTeam) ?? dbColor;
    this.banner = this.roamSkip ? null : new PhaseIn(currentTeam, color !== dbColor ? color : null);

    // Python TurnChangeState.end -> status_upkeep also runs for the player
    // on turn 1 (the level start never passes through the web turn_change).
    if (currentTeam === 'player' && turnCount === 1 && !game.levelVars.get('_turn1_upkeep_done')) {
      game.levelVars.set('_turn1_upkeep_done', true);
      for (const unit of game.getTeamUnits('player').filter((candidate: UnitObject) => candidate.position)) {
        applySkillTurnHooks(game, [unit], 'upkeep');
        applyItemUpkeepResourceHooks(
          game,
          unit,
          getSkillAbilityOptions(game, unit).map((ability) => ability.item),
        );
      }
    }

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
      // Python PhaseChangeState.begin: ResetAll for every living unit, then
      // status upkeep for the phase's team.
      const living = (game.getAllUnits() as UnitObject[]).filter((unit) => !unit.isDead());
      game.actionLog.doAction(new ResetAllAction(living));
      const teamUnits: UnitObject[] = game.board.getTeamUnits(currentTeam);
      for (const unit of teamUnits) {
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
    if (!this.fadedIn && !this.roamSkip) {
      this.fadedIn = true;
      fadeInPhaseMusic(game, true);
    }
    if (game.turnCount === 1 && game.phase?.getCurrent() === 'player') {
      game.actionLog.setFirstFreeAction();
    }
  }

  override update(): StateResult {
    const game = getGame();
    if (this.roamSkip) {
      game.state.back();
      return;
    }
    if (!this.banner) return;

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

/**
 * Python general_states.ShopState: shopkeeper portrait, convo-white dialog
 * over menu_bg_clear, horizontal Buy/Sell choice, menus.Shop buy/sell lists
 * (ValueItemOption / StockValueItemOption), money_bg funds.
 */
export class ShopState extends State {
  readonly name = 'shop';
  override readonly transparent = false;

  /** Python ShopState.state. */
  phase: 'open' | 'choice' | 'buy' | 'sell' | 'close' | 'preview' = 'open';
  unit: UnitObject | null = null;
  shopItems: ItemObject[] = [];
  private stock: number[] | null = null;
  private shopId: string | null = null;
  private flavor: string | null = null;
  private preview = false;
  buyMenu: PrepChoice | null = null;
  sellMenu: PrepChoice | null = null;
  choiceMenu: PrepChoice | null = null;
  private menu: PrepChoice | null = null;
  private dialog: Dialog | null = null;
  private bg: PrepScrollingBackground | null = null;
  private messages: Record<string, string> = {};

  override start(): StateResult {
    const game = getGame();
    this.unit = game.shopUnit ?? game.selectedUnit ?? null;
    this.shopItems = game.shopItems ?? [];
    this.stock = game.shopStock ?? null;
    this.shopId = game.shopId ?? null;
    this.flavor = game.shopFlavor ?? null;
    this.preview = !!game.shopPreview;
    game.shopUnit = null;
    game.shopItems = null;
    game.shopStock = null;
    game.shopId = null;
    game.shopFlavor = null;
    game.shopPreview = false;

    const keys = ['opener', 'buy', 'back', 'leave', 'buy_again', 'convoy', 'no_stock', 'no_money',
      'max_inventory', 'sell_again', 'again', 'no_value', 'preview'];
    const armoryDefaults: Record<string, string> = { opener: 'armory', buy: 'armory', back: 'armory', leave: 'armory' };
    for (const key of keys) {
      if (this.flavor) {
        const flavored = `${this.flavor}_${key}`;
        this.messages[key] = game.db.translations?.has(flavored) ? flavored : `shop_${key}`;
      } else {
        this.messages[key] = `${armoryDefaults[key] ?? 'shop'}_${key}`;
      }
    }

    const unit = this.unit;
    let topleft: [number, number] = [44, 160 - 16 * 5 - 8 - 4];
    if (!this.preview && unit) {
      this.sellMenu = this.makeShopMenu(unit.items.filter((i) => !i.hasComponent('locked')), topleft, 'sell', null);
    }
    if (this.stock) topleft = [36, topleft[1] + 4];
    this.buyMenu = this.makeShopMenu(this.shopItems, topleft, 'buy', this.stock);
    this.choiceMenu = new PrepChoice(game, ['Buy', 'Sell'], [120, 32], null);
    this.choiceMenu.horizontal = true;
    this.choiceMenu.highlight = false;
    this.choiceMenu.textFont = 'convo-white';
    this.menu = null;
    this.phase = 'open';
    this.dialog = this.makeDialog(this.preview ? this.messages.preview : this.messages.opener);
    this.bg = new PrepScrollingBackground(game, 'rune_background');
  }

  get shopFlavor(): string { return this.flavor || 'armory'; }
  get shopStock(): number[] { return this.stock ?? this.shopItems.map(() => -1); }
  getFullPrice(item: ItemObject): number {
    const game = getGame();
    return itemFullPrice(this.unit, item, game.db, game) ?? 0;
  }
  getBuyPrice(item: ItemObject): number { return prepShopPrice(getGame(), this.unit, item, 'buy'); }
  getSellPrice(item: ItemObject): number { return prepShopPrice(getGame(), this.unit, item, 'sell'); }
  /** Buy the highlighted buy-menu item (Python ShopState 'buy' SELECT). */
  tryBuyItem(_game?: any): void {
    if (this.unit && this.buyMenu) this.buy(this.unit, this.buyMenu);
  }
  /** Sell the highlighted sell-menu item (Python ShopState 'sell' SELECT). */
  trySellItem(_game?: any, _items?: ItemObject[]): void {
    if (!this.sellMenu) return;
    const phase = this.phase;
    this.phase = 'sell';
    this.takeInput('SELECT');
    this.phase = phase === 'sell' ? 'sell' : phase;
  }

  private makeShopMenu(items: ItemObject[], topleft: [number, number], disp: 'buy' | 'sell', stock: number[] | null): PrepChoice {
    const menu = new PrepChoice(getGame(), [], topleft);
    menu.owner = this.unit;
    menu.dispValue = disp;
    menu.stock = stock;
    menu.setLimit(5);
    menu.hardLimit = true;
    menu.gem = true;
    menu.takesInput = false;
    menu.setOptions(items.map((item) => ({ kind: 'item' as const, item })));
    return menu;
  }

  /** Python ShopState.get_dialog: position (60, 8), 160px text, convo-white. */
  private makeDialog(nid: string): Dialog {
    const game = getGame();
    const [ox, oy] = prepScreenOrigin();
    const text = game.db.translate ? game.db.translate(nid) : nid;
    return new Dialog(text, undefined, undefined, undefined, undefined, false, {
      position: [ox + 60, oy + 8], width: 176, background: null, messageTail: null,
      fontType: 'convo', fontColor: 'white',
    });
  }

  private sellables(): ItemObject[] {
    return this.unit ? this.unit.items.filter((i) => !i.hasComponent('locked')) : [];
  }

  private updateSellOptions(): void {
    if (!this.sellMenu) return;
    const idx = this.sellMenu.currentIndex;
    this.sellMenu.setOptions(this.sellables().map((item) => ({ kind: 'item' as const, item })));
    this.sellMenu.currentIndex = Math.min(idx, this.sellMenu.options.length - 1);
  }

  private dialogReady(): boolean {
    return !this.dialog || this.dialog.isDone() || this.dialog.isWaiting();
  }

  private leave(): void {
    const game = getGame();
    if (this.unit?.hasTraded) game.actionLog.doAction(new HasAttackedAction(this.unit));
    game.state.back();
  }

  override takeInput(event: InputEvent): StateResult {
    const game = getGame();
    const sfx = (name: string) => game.audioManager?.playSfx?.(name);
    if (this.menu) {
      if (event === 'DOWN' || event === 'RIGHT') {
        if (this.menu.moveDown(prepIsFirstPush(game, event))) sfx('Select 6');
      } else if (event === 'UP' || event === 'LEFT') {
        if (this.menu.moveUp(prepIsFirstPush(game, event))) sfx('Select 6');
      }
    }
    const unit = this.unit;
    if (event === 'SELECT') {
      if (this.phase === 'open') {
        sfx('Select 1');
        this.dialog?.handleInput('SELECT');
        if (this.dialogReady()) {
          if (this.preview) {
            this.phase = 'preview';
            this.menu = this.buyMenu;
            if (this.buyMenu) this.buyMenu.takesInput = true;
          } else {
            this.phase = 'choice';
            this.menu = this.choiceMenu;
          }
        }
      } else if (this.phase === 'choice') {
        sfx('Select 1');
        const current = this.choiceMenu?.getCurrentText();
        if (current === 'Buy') {
          this.menu = this.buyMenu;
          this.phase = 'buy';
          this.dialog = this.makeDialog(this.messages.buy);
          if (this.buyMenu) this.buyMenu.takesInput = true;
        } else if (current === 'Sell' && this.sellables().length) {
          this.menu = this.sellMenu;
          this.phase = 'sell';
          if (this.sellMenu) this.sellMenu.takesInput = true;
        }
      } else if (this.phase === 'buy' && unit && this.buyMenu) {
        this.buy(unit, this.buyMenu);
      } else if (this.phase === 'sell' && unit && this.sellMenu) {
        const item = this.sellMenu.getCurrentItem();
        if (!item) { sfx('Select 4'); return; }
        const value = prepShopPrice(game, unit, item, 'sell');
        if (Number(itemFullPrice(null, item, game.db, game) ?? 0)) {
          const party = game.getParty();
          game.actionLog.doAction(new HasTradedAction(unit));
          sfx('GoldExchange');
          game.actionLog.doAction(new GainMoneyAction(value, party?.nid));
          game.actionLog.doAction(new UpdateRecordsAction('money', party?.nid, value));
          game.actionLog.doAction(new SetGameVarAction(game.gameVars, 'money', game.getMoney()));
          game.actionLog.doAction(new RemoveItemFromUnitAction(unit, item));
          this.dialog = this.makeDialog(this.messages.sell_again);
          this.updateSellOptions();
        } else {
          sfx('Select 4');
          this.dialog = this.makeDialog(this.messages.no_value);
        }
      } else if (this.phase === 'close') {
        sfx('Select 1');
        if (this.dialogReady()) this.leave();
        else this.dialog?.handleInput('SELECT');
      } else if (this.phase === 'preview') {
        if (this.menu?.infoFlag) {
          this.menu.toggleInfo();
          sfx('Info Out');
        } else {
          sfx('Select 4');
          this.phase = 'close';
          this.dialog = this.makeDialog(this.messages.leave);
        }
      }
    } else if (event === 'BACK') {
      if (this.phase === 'open' || this.phase === 'close') {
        sfx('Select 4');
        this.leave();
      } else if (this.phase === 'choice') {
        sfx('Select 4');
        this.phase = 'close';
        this.dialog = this.makeDialog(this.messages.leave);
      } else if ((this.phase === 'buy' || this.phase === 'sell' || this.phase === 'preview') && this.menu?.infoFlag) {
        // Python ShopState: BACK first closes an open help box.
        this.menu.toggleInfo();
        sfx('Info Out');
      } else if (this.phase === 'buy' || this.phase === 'sell') {
        sfx('Select 4');
        this.phase = 'choice';
        if (this.menu) this.menu.takesInput = false;
        this.menu = this.choiceMenu;
        this.dialog = this.makeDialog(this.messages.again);
      } else if (this.phase === 'preview') {
        sfx('Select 4');
        this.phase = 'close';
        this.dialog = this.makeDialog(this.messages.leave);
      }
    } else if (event === 'INFO') {
      if ((this.phase === 'buy' || this.phase === 'sell' || this.phase === 'preview') && this.menu) {
        this.menu.toggleInfo();
        sfx(this.menu.infoFlag ? 'Info In' : 'Info Out');
      }
    }
  }

  private buy(unit: UnitObject, menu: PrepChoice): void {
    const game = getGame();
    const sfx = (name: string) => game.audioManager?.playSfx?.(name);
    const item = menu.getCurrentItem();
    if (!item) { sfx('Select 4'); return; }
    const value = prepShopPrice(game, unit, item, 'buy');
    const stockIdx = menu.currentIndex;
    const stock = this.stock ? this.stock[stockIdx] ?? -1 : -1;
    const prefab = game.db?.items?.get(item.nid);
    const newItem: ItemObject | null = prefab ? new ItemObjectClass(prefab) : null;
    const full = newItem ? itemInventoryFull(unit, newItem, game.db) : true;
    const convoy = !!game.gameVars.get('_convoy');
    if (newItem && game.getMoney() - value >= 0 && stock !== 0 && (!full || convoy)) {
      const party = game.getParty();
      game.actionLog.doAction(new HasTradedAction(unit));
      sfx('GoldExchange');
      game.actionLog.doAction(new GainMoneyAction(-value, party?.nid));
      game.actionLog.doAction(new UpdateRecordsAction('money', party?.nid, -value));
      // Web-only mirror kept for saves/tooling that read the legacy var.
      game.actionLog.doAction(new SetGameVarAction(game.gameVars, 'money', game.getMoney()));
      const marker = `__shop_${this.shopId}_${item.nid}`;
      game.actionLog.doAction(new SetGameVarAction(game.gameVars, marker, Number(game.gameVars.get(marker) ?? 0) + 1));
      if (this.stock && stock > 0) this.stock[stockIdx] = stock - 1;
      if (!full) {
        game.actionLog.doAction(new GiveItemAction(unit, newItem));
        this.dialog = this.makeDialog(this.messages.buy_again);
      } else {
        game.actionLog.doAction(new PutItemInConvoy(newItem, party?.nid));
        this.dialog = this.makeDialog(this.messages.convoy);
      }
      this.updateSellOptions();
    } else if (stock === 0) {
      sfx('Select 4');
      this.dialog = this.makeDialog(this.messages.no_stock);
    } else if (game.getMoney() - value < 0) {
      sfx('Select 4');
      this.dialog = this.makeDialog(this.messages.no_money);
    } else {
      sfx('Select 4');
      this.dialog = this.makeDialog(this.messages.max_inventory);
    }
  }

  override update(): StateResult {
    this.dialog?.update();
    this.menu?.update();
  }

  override draw(surf: Surface): Surface {
    const game = getGame();
    const [ox, oy] = prepScreenOrigin();
    if (this.bg) this.bg.draw(surf);
    else surf.fill(0, 0, 0);
    surf.blit(prepBaseSurf(240 + 8, 48, 'menu_bg_clear'), ox - 4, oy + 8);
    // Python keeps drawing current_msg after it finishes.
    this.dialog?.draw(surf, true);
    const portrait = prepGetSprite(`${this.flavor || 'armory'}_portrait`) ?? prepGetSprite('armory_portrait');
    if (portrait) surf.blitImage(portrait, 0, 0, portrait.width, portrait.height, ox + 3, oy);
    const moneyBg = prepGetSprite('money_bg');
    if (moneyBg) {
      const prev = surf.getAlpha();
      surf.setAlpha(0.9);
      surf.blitImage(moneyBg, 0, 0, moneyBg.width, moneyBg.height, ox + 172, oy + 48);
      surf.setAlpha(prev);
    }
    surf.drawTextRight(String(game.getMoney()), ox + 223, oy + 48, 'white', 'text-blue');

    if (this.phase === 'sell' || (this.phase === 'choice' && this.choiceMenu?.getCurrentText() === 'Sell')) {
      this.sellMenu?.draw(surf, ox, oy);
    } else {
      this.buyMenu?.draw(surf, ox, oy);
      if (this.stock) {
        for (const [label, x] of [['Item', 80], ['Uses', 128], ['Stock', 156], ['Price', 186]] as [string, number][]) {
          const text = game.db.translate ? game.db.translate(label) : label;
          const w = prepTextWidth(text);
          surf.drawText(text, ox + x - Math.floor(w / 2), oy + 64, 'yellow', 'text');
        }
      }
    }
    if (this.phase === 'choice' && this.dialogReady()) this.choiceMenu?.draw(surf, ox, oy);
    if (this.buyMenu?.infoFlag && this.menu === this.buyMenu) this.buyMenu.drawInfo(surf, ox, oy);
    if (this.sellMenu?.infoFlag && this.menu === this.sellMenu) this.sellMenu.drawInfo(surf, ox, oy);
    return surf;
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

type EventCreditCard = {
  title: string;
  lines: string[];
  center: boolean;
  waitAtCenter: boolean;
  elapsedMs: number;
  pauseMs: number;
  height: number;
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

/** Python app/events/speak_style.SpeakStyle (unset fields are null). */
type SpeakStyleDef = {
  speaker?: string | null;
  position?: string | [number, number] | null;
  width?: number | null;
  speed?: number | null;
  fontColor?: string | null;
  fontType?: string | null;
  background?: string | null;
  numLines?: number | null;
  drawCursor?: boolean | null;
  messageTail?: string | null;
  transparency?: number | null;
  nameTagBg?: string | null;
  flags?: Set<string>;
};

/** Python SpeakStyleLibrary built-ins (WINWIDTH = 240). */
const BUILTIN_SPEAK_STYLES: Record<string, SpeakStyleDef> = {
  __default: { speed: 1, fontType: 'convo', background: 'message_bg_base', numLines: 2, drawCursor: true,
    messageTail: 'message_bg_tail', nameTagBg: 'name_tag', transparency: 0.05 },
  __default_text: { speed: 0.5, fontType: 'text', background: 'menu_bg_base', numLines: 0,
    nameTagBg: 'menu_bg_base', transparency: 0.05 },
  __default_help: { speed: 0.5, fontType: 'convo', background: 'None', drawCursor: false, numLines: 8,
    nameTagBg: 'name_tag', transparency: 0.05 },
  noir: { background: 'menu_bg_dark', fontColor: 'white', messageTail: 'None' },
  hint: { background: 'menu_bg_parchment', position: 'center', width: 128, numLines: 4, messageTail: 'None' },
  cinematic: { background: 'None', position: 'center', fontColor: 'grey', numLines: 5, fontType: 'chapter',
    drawCursor: false, messageTail: 'None' },
  narration: { background: 'menu_bg_base', position: [4, 110], width: 232, fontColor: 'white', messageTail: 'None' },
  narration_top: { background: 'menu_bg_base', position: [4, 2], width: 232, fontColor: 'white', messageTail: 'None' },
  clear: { background: 'None', fontColor: 'white', drawCursor: false, messageTail: 'None' },
  thought_bubble: { messageTail: 'message_bg_thought_tail', flags: new Set(['no_talk']) },
  boss_convo_left: { speed: 1, fontType: 'convo', background: 'message_bg_base', numLines: 2, drawCursor: true,
    messageTail: 'message_bg_tail', transparency: 0, position: [72, 112], width: 160 },
  boss_convo_right: { speed: 1, fontType: 'convo', background: 'message_bg_base', numLines: 2, drawCursor: true,
    messageTail: 'message_bg_tail', transparency: 0, position: [8, 112], width: 160 },
  overworld_narration: { background: 'None', position: [4, 110], width: 232, fontColor: 'white',
    numLines: 2, speed: 2 },
};

/** Python SpeakStyle.update: later non-null fields win; flags union. */
function mergeSpeakStyle(base: SpeakStyleDef, other: SpeakStyleDef): SpeakStyleDef {
  const out: SpeakStyleDef = { ...base };
  for (const [key, value] of Object.entries(other) as [keyof SpeakStyleDef, unknown][]) {
    if (key === 'flags' || value === null || value === undefined) continue;
    (out as Record<string, unknown>)[key] = value;
  }
  out.flags = new Set([...(base.flags ?? []), ...(other.flags ?? [])]);
  return out;
}

/** TextPosition: an Alignments name or an "x,y" point. */
function parseSpeakPosition(value: string | undefined): string | [number, number] | null {
  if (!value) return null;
  const point = value.match(/^\s*(-?\d+)\s*,\s*(-?\d+)\s*$/);
  if (point) return [parseInt(point[1], 10), parseInt(point[2], 10)];
  return value.trim().toLowerCase();
}

const colorkeyedPortraits: Map<string, HTMLCanvasElement | null> = new Map();
/** Portrait sheet with the LT colorkey removed, loaded on first use. */
function getColorkeyedPortrait(game: any, nid: string): HTMLCanvasElement | null {
  if (!nid) return null;
  if (colorkeyedPortraits.has(nid)) return colorkeyedPortraits.get(nid) ?? null;
  colorkeyedPortraits.set(nid, null);
  void game.resources.tryLoadImage(`resources/portraits/${nid}.png`).then((img: HTMLImageElement | null) => {
    if (!img) return;
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth || img.width;
    canvas.height = img.naturalHeight || img.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;
    ctx.drawImage(img, 0, 0);
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
    for (let i = 0; i < data.data.length; i += 4) {
      if (data.data[i] === 128 && data.data[i + 1] === 160 && data.data[i + 2] === 128) data.data[i + 3] = 0;
    }
    ctx.putImageData(data, 0, 0);
    colorkeyedPortraits.set(nid, canvas);
  });
  return null;
}

type EventTable = {
  nid: string;
  data: string;
  /** Unsubstituted TableData: expressions re-run text tags every frame. */
  rawData: string;
  title: string | null;
  rows: number;
  columns: number;
  rowWidth: number;
  alignment: string;
  background: string;
  entryType: string;
  textAlignment: string;
  expression: boolean;
  noBackground: boolean;
};

/**
 * A persistent on-screen text box drawn by the `textbox` event command.
 * Python keywords are ['NID', 'Text'] plus optional BoxPosition and Width.
 */
type EventTextbox = {
  nid: string;
  text: string;
  /** Unsubstituted text: Python re-runs text tags every frame for expressions. */
  rawText: string;
  alignment: string;
  width: number;
  numLines: number;
  bg: string;
  expression: boolean;
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
  /** Python-style command-driven credit lines scrolling over the event background. */
  private creditCards: EventCreditCard[] = [];
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
  private choiceMenu: EventChoiceMenu | null = null;
  /** Python PlayerChoiceState.should_persist: menu stays open after a pick. */
  private choicePersist: boolean = false;
  /** Cursor kept across a persistent choice's EventNid replays. */
  private choiceCursorMemory: Map<string, number> = new Map();
  private choiceResult: string | null = null;
  /** NID of the active choice; the selection is published under this name. */
  private choiceNid: string | null = null;
  /** Whether the active choice accepts BACK as a 'BACK' selection. */
  private choiceBackable = false;
  /** Event to run on each selection, from the choice's `EventNid` keyword. */
  private choiceEventNid: string | null = null;
  /** Parent choices paused while their EventNid selection event runs. */
  /** Presentation of events paused by a nested trigger_script/choice event. */
  private parkedEventPresentation: WeakMap<GameEvent, {
    eventTables: Map<string, EventTable>;
    eventTextboxes: Map<string, EventTextbox>;
    portraits: Map<string, EventPortrait>;
    portraitPriorityCounter: number;
    background: HTMLImageElement | null;
  }> = new WeakMap();
  /**
   * Parked events in pause order. Python pushes a new EventState for each
   * triggered sub-event; the paused parents stay on the (transparent) stack
   * and keep drawing their background, portraits and boxes underneath.
   */
  private parkedOrder: GameEvent[] = [];
  private suspendedChoiceEvents: Array<{
    owner: GameEvent;
    commandPointer: number;
    eventTables: Map<string, EventTable>;
    eventTextboxes: Map<string, EventTextbox>;
    portraits?: Map<string, EventPortrait>;
    replay: boolean;
    /** Python PlayerChoiceState stays below the sub-event (static cursor). */
    menu?: { draw(surf: Surface): void } | null;
  }> = [];

  // For-loop variables are event locals and shadow level/game variables.
  private forLoopStack: Array<{
    varName: string;
    values: unknown[];
    currentIndex: number;
    startPointer: number;
    hadLocal: boolean;
    oldLocal: unknown;
  }> = [];

  // Skip mode: when true, all speak/narrate commands are auto-advanced
  private skipMode: boolean = false;
  /** Python Event.super_skip: START skips through end_skip as well. */
  private superSkip: boolean = false;

  // Portrait state
  private portraits: Map<string, EventPortrait> = new Map();
  private portraitPriorityCounter: number = 1;
  /** Portrait loads in flight; blocking/dependent commands wait for completion. */
  private pendingPortraitLoads: number = 0;
  /** An async command is in flight and will advance the pointer itself. */
  private asyncCommandPending: boolean = false;
  private blockingPortraitLoads: number = 0;
  private overlaySprites: Map<string, EventOverlaySprite> = new Map();
  /** Persistent event-created tables, such as Rekka's live GoldDisplay. */
  private eventTables: Map<string, EventTable> = new Map();
  private eventTextboxes: Map<string, EventTextbox> = new Map();

  // Currently speaking portrait (for talk animation)
  private speakingPortrait: EventPortrait | null = null;
  private wasDialogTyping: boolean = false;

  // Background panorama image (drawn behind portraits, on top of map)
  private background: HTMLImageElement | null = null;
  private pendingBackgroundLoad: boolean = false;
  private backgroundLoadDone: boolean = false;
  private backgroundLoadToken: number = 0;

  // Chapter title overlay state
  /** Python ChapterTitleState.state ('none' when no title card is up). */
  private chapterTitlePhase: 'none' | 'begin' | 'sigil' | 'banner_grow_x' | 'banner_grow_y' |
    'ribbon_fade_in' | 'wait' | 'sigil_out' | 'ribbon_close' = 'none';
  /** Milliseconds since the current chapter-title phase began. */
  private chapterTitleTimer: number = 0;
  private chapterTitleText: string = '';
  private chapterTitleSigilFade = 0;
  private chapterTitleBannerX = 0;
  private chapterTitleBannerY = 6;
  private chapterTitleBannerFade = 0;
  /** TransitionBackground(chapter_title_bg) scroll counter, in pixels. */
  private chapterTitleBgCounter = 0;

  // Location card state
  private locationCard: { text: string; timer: number; phase: 'fade_in' | 'hold' | 'fade_out'; alpha: number } | null = null;

  /** Effective dialog text speed in milliseconds per character. */
  private getDialogTextSpeedMs(): number {
    const game = getGame();
    void game;
    const raw = getSetting('text_speed');
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
      this.creditCards = [];
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
      this.choiceNid = null;
      this.choiceBackable = false;
      this.choiceEventNid = null;
      this.forLoopStack = [];
      this.skipMode = false;
      this.superSkip = false;
      this.portraits.clear();
      this.portraitPriorityCounter = 1;
      this.pendingPortraitLoads = 0;
      this.blockingPortraitLoads = 0;
      this.overlaySprites.clear();
      this.eventTables.clear();
      this.eventTextboxes.clear();
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
      if (effective === 'INFO' && game.dialogLogEntries.length > 0) {
        game.state.change('dialog_log');
        return;
      }
      if (effective === 'BACK' || effective === 'START') {
        // Enable skip mode — dismiss this dialog and auto-skip all
        // remaining speak/narrate commands in the current event.
        // Python Event.take_input: START or BACK -> skip(super_skip=START).
        this.skipMode = true;
        if (effective === 'START') this.superSkip = true;
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

    // Python ChapterTitleState.take_input: START/SELECT/BACK end the card.
    if (this.chapterTitlePhase !== 'none') {
      if (effective === 'SELECT' || effective === 'BACK' || effective === 'START') {
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

    // Forward input to choice menu if active (Python PlayerChoiceState).
    if (this.choiceMenu) {
      let result: { selected: string } | { back: true } | null = null;
      if (game.input?.mouseClick) {
        const [gx, gy] = game.input.getGameMousePos();
        result = this.choiceMenu.handleClick(gx, gy, game.input.mouseClick as 'SELECT' | 'BACK');
      } else if (game.input?.mouseMoved) {
        const [gx, gy] = game.input.getGameMousePos();
        this.choiceMenu.handleMouseHover(gx, gy);
      }
      if (!result && effective !== null) {
        result = this.choiceMenu.handleInput(effective);
      }
      if (result === null) {
        if (this.choiceNid) {
          game.gameVars.set(`${this.choiceNid}_choice_hover`, this.choiceMenu.getCurrentOption()?.value ?? '');
        }
        return;
      }
      if ('back' in result) {
        if (!this.choicePersist && !this.choiceBackable) {
          // Python: non-backable, non-persistent choices refuse BACK.
          game.audioManager?.playSfx?.('Error');
          return;
        }
        game.audioManager?.playSfx?.('Select 4');
        // Backable: the choice's own var becomes 'BACK'; _last_choice keeps
        // its previous value (Python choice docs).
        if (this.choiceBackable && this.choiceNid) {
          game.actionLog.doAction(new SetGameVarAction(game.gameVars, this.choiceNid, 'BACK'));
          this.choiceResult = 'BACK';
        }
        this.choiceMenu = null;
        this.choiceNid = null;
        this.choiceBackable = false;
        this.choicePersist = false;
        this.choiceEventNid = null;
        this.advancePointer();
        return;
      }
      this.choiceResult = result.selected;
      // Publish under the choice's own name: authored events read the
      // selection back as `{v:<nid>}`, plus `_last_choice`.
      if (this.choiceNid) {
        game.actionLog.doAction(new SetGameVarAction(game.gameVars, this.choiceNid, this.choiceResult));
      }
      game.actionLog.doAction(new SetGameVarAction(game.gameVars, '_last_choice', this.choiceResult));
      const followUp = this.choiceEventNid;
      const persist = this.choicePersist;
      if (persist && !followUp) {
        // Persistent menus stay open; only BACK leaves them.
        return;
      }
      if (persist && this.choiceNid) {
        this.choiceCursorMemory.set(this.choiceNid, this.choiceMenu.selectedIndex);
      }
      const chosenMenu = this.choiceMenu;
      this.choiceMenu = null;
      this.choiceNid = null;
      this.choiceBackable = false;
      this.choicePersist = false;
      this.choiceEventNid = null;
      this.advancePointer();
      // Queue the selection event after advancing, so it runs before the
      // rest of this event resumes — matching Python, where the sub-event
      // inherits the current args and the parent continues afterwards.
      if (followUp) {
        const prefab = [...game.db.events.values()].find((candidate: any) =>
          candidate.nid === followUp ||
          candidate.name === followUp ||
          `${candidate.level_nid ?? ''} ${candidate.name ?? ''}`.trim() === followUp);
        if (prefab) {
          const queue = game.eventManager.eventQueue;
          const owner = this.currentEvent;
          const suspendedChoice = owner ? {
            owner,
            commandPointer: Math.max(0, owner.commandPointer - 1),
            eventTables: new Map(this.eventTables),
            eventTextboxes: new Map(this.eventTextboxes),
            portraits: new Map(this.portraits),
            // A persistent choice re-opens once its selection event ends.
            replay: persist,
            menu: chosenMenu,
          } : null;
          const priorLength = queue.length;
          game.eventManager.triggerSpecific(
            prefab.nid,
            { type: 'choice_selection', levelNid: game.currentLevel?.nid },
            true,
          );
          // triggerSpecific appends by default. Choice sub-events are
          // interrupts: run them now, then resume the parent at the already
          // advanced pointer. EOtF's sortie sub-event builds the selected
          // party before the parent starts the chapter.
          const interrupts = queue.splice(priorLength);
          const ownerIndex = owner ? queue.indexOf(owner) : -1;
          if (ownerIndex >= 0) queue.splice(ownerIndex, 1);
          if (owner) queue.unshift(...interrupts, owner);
          else queue.unshift(...interrupts);
          if (interrupts.length > 0) this.loadNextEvent(game);
          if (suspendedChoice && interrupts.length > 0) {
            this.suspendedChoiceEvents.push(suspendedChoice);
          }
        } else {
          console.warn(`choice: EventNid "${followUp}" not found`);
        }
      }
      return;
    }

    // Enable skip mode when BACK is pressed outside of any blocking UI.
    // This handles the case where the user presses Escape during wait,
    // transition, screen_shake, or between instant commands.
    if (effective === 'BACK' || effective === 'START') {
      this.skipMode = true;
      if (effective === 'START') this.superSkip = true;
      // If we're in a wait, transition, or other blockable state, resolve it
      if (this.waiting) {
        this.waiting = false;
        this.waitTimer = 0;
        this.creditCards = [];
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
    this.updateEventCreditCards();
    this.updateLocationCard();

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
        // Inline {c:...} commands (Python queue_command + unpause) run while
        // the dialog waits at its command pause.
        if (this.dialog.isCommandPaused()) {
          for (const line of this.dialog.takePendingCommands()) {
            this.runInlineDialogCommand(line, game);
          }
          this.dialog.commandUnpause();
        }
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

    // An asynchronous command (change_tilemap) resumes the event itself.
    if (this.asyncCommandPending) return;

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

    // Chapter title card (Python ChapterTitleState.update)
    if (this.chapterTitlePhase !== 'none') {
      if (this.skipMode) {
        this.chapterTitlePhase = 'none';
        this.chapterTitleTimer = 0;
        this.advancePointer();
      } else {
        this.updateChapterTitle();
        return;
      }
    }


    // Block while portrait images are still loading (async).
    // In the original Python engine, image loads are synchronous, so portraits
    // are always available when the next command (e.g. speak) executes.
    // In skip mode, we still need to wait — the portrait must exist in the
    // portraits map for subsequent commands that reference it by name.
    if (this.pendingPortraitLoads > 0) {
      const nextType = this.currentEvent?.getNextCommand()?.type;
      const needsLoadedPortrait = new Set([
        'remove_portrait', 'multi_remove_portrait', 'remove_all_portraits',
        'move_portrait', 'bop', 'bop_portrait', 'mirror_portrait',
        'add_expression', 'remove_expression', 'speak',
      ]).has(nextType ?? '');
      if (this.blockingPortraitLoads > 0 || needsLoadedPortrait) return;
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
      let blocking: boolean;
      try {
        blocking = this.executeCommand(cmd, game);
      } catch (error) {
        const trigger = ev.trigger ?? { type: 'unknown' };
        const traceValue = (value: any): any => {
          if (value === null || value === undefined ||
              typeof value === 'string' || typeof value === 'number' ||
              typeof value === 'boolean') return value;
          if (Array.isArray(value)) return value.slice(0, 20).map(traceValue);
          if (value instanceof Map) {
            return Object.fromEntries(
              [...value.entries()].slice(0, 20).map(([key, entry]) => [String(key), traceValue(entry)]),
            );
          }
          if (typeof value === 'object' && typeof value.nid === 'string') {
            return { nid: value.nid };
          }
          if (typeof value === 'object') {
            return Object.fromEntries(
              Object.entries(value)
                .filter(([, entry]) =>
                  entry === null || ['string', 'number', 'boolean'].includes(typeof entry))
                .slice(0, 20),
            );
          }
          return String(value);
        };
        const localArgs = trigger.localArgs instanceof Map
          ? traceValue(trigger.localArgs)
          : traceValue(trigger.localArgs ?? null);
        const trace = {
          eventId: ev.nid,
          commandIndex: ev.commandPointer,
          command: { type: cmd.type, args: cmd.args },
          trigger: {
            type: trigger.type,
            unitNid: trigger.unitNid ?? trigger.unit1?.nid ?? null,
            unit2Nid: trigger.unit2?.nid ?? null,
            itemNid: trigger.item?.nid ?? null,
            position: trigger.position ?? null,
            regionNid: trigger.regionNid ?? trigger.region?.nid ?? null,
            localArgs,
          },
          stateStack: game.state.getStackNames(),
          activeUnit: game.selectedUnit?.nid ?? null,
        };
        console.error(`[EventTrace] ${JSON.stringify(trace)}`);
        throw error;
      }
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

  /** Python PanoramaBackground: cover the whole window, centered. */
  private drawEventBackground(surf: Surface, image: HTMLImageElement): void {
    const bw = image.width;
    const bh = image.height;
    const coverScale = Math.max(1, surf.width / Math.max(1, bw), surf.height / Math.max(1, bh));
    const dw = bw * coverScale;
    const dh = bh * coverScale;
    const ps = surf.scale;
    surf.ctx.imageSmoothingEnabled = false;
    surf.ctx.drawImage(
      image, 0, 0, bw, bh,
      Math.round(((surf.width - dw) / 2) * ps), Math.round(((surf.height - dh) / 2) * ps),
      Math.round(dw * ps), Math.round(dh * ps),
    );
  }

  /**
   * Paused parent events (Python: lower EventState instances on the stack)
   * keep drawing beneath the running sub-event, including a chosen
   * PlayerChoiceState menu that has not popped yet.
   */
  private drawParkedLayers(surf: Surface): void {
    if (this.parkedOrder.length === 0) return;
    const ownTables = this.eventTables;
    const ownTextboxes = this.eventTextboxes;
    try {
      for (const event of this.parkedOrder) {
        const parked = this.parkedEventPresentation.get(event);
        if (!parked) continue;
        if (parked.background) this.drawEventBackground(surf, parked.background);
        for (const portrait of [...parked.portraits.values()].sort((a, b) => a.priority - b.priority)) {
          portrait.draw(surf);
        }
        this.eventTables = parked.eventTables;
        this.eventTextboxes = parked.eventTextboxes;
        this.drawEventTables(surf);
        this.drawEventTextboxes(surf);
        for (const suspended of this.suspendedChoiceEvents) {
          if (suspended.owner === event) suspended.menu?.draw(surf);
        }
      }
    } finally {
      this.eventTables = ownTables;
      this.eventTextboxes = ownTextboxes;
    }
  }

  override draw(surf: Surface): Surface {
    this.drawParkedLayers(surf);
    // Background panorama (drawn on top of map, behind portraits)
    if (this.background) {
      // Python PanoramaBackground fills the whole 240x160 window. The web
      // viewport can be larger than the authored scene, so scale the panorama
      // to cover it (centered) instead of leaving the map visible around it.
      this.drawEventBackground(surf, this.background);
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
      // Python Ending/PairedEnding: titles in the text font centred on x = 68.
      const ox = MenuScene.origin().x;
      blitMenuText(surf, 'text', this.endingCard.leftTitle,
        ox + 68 - Math.floor(menuTextWidth('text', this.endingCard.leftTitle) / 2),
        this.endingCard.rightTitle === null ? 24 : 12);
      if (this.endingCard.rightTitle !== null) {
        blitMenuText(surf, 'text', this.endingCard.rightTitle,
          ox + 68 - Math.floor(menuTextWidth('text', this.endingCard.rightTitle) / 2), 24);
      }
      this.endingCard.dialog.draw(surf, true);
    }
    if (this.dialog && this.dialog !== this.endingCard?.dialog) {
      this.dialog.draw(surf);
    }
    if (this.banner) {
      this.banner.draw(surf);
    }
    this.drawEventCreditCards(surf);
    this.drawEventTables(surf);
    this.drawEventTextboxes(surf);

    // Transition fade overlay. Python Event.draw blits the fade after the
    // portraits and text boxes, so a closed transition hides them too.
    if (this.transitionAlpha > 0) {
      surf.fillRect(0, 0, surf.width, surf.height, `rgba(${this.transitionColor},${this.transitionAlpha})`);
    }

    if (this.choiceMenu) {
      this.choiceMenu.draw(surf);
    }

    // Chapter title card (drawn on top of everything)
    if (this.chapterTitlePhase !== 'none') this.drawChapterTitle(surf);

    // Python dialog.LocationCard: text-font line on menu_bg_brown at (10, 1),
    // at most 90% opaque while fading in and out.
    if (this.locationCard && this.locationCard.alpha > 0) {
      const lc = this.locationCard;
      const lcW = menuTextWidth('text', lc.text) + 16;
      const lcH = (FONT['text']?.height ?? 16) + 8;
      const card = new Surface(lcW - (lcW % 8), lcH);
      card.blit(getMenuBackgroundSync(lcW, lcH, 'menu_bg_brown'), 0, 0);
      blitMenuTextCenter(card, 'text', lc.text, Math.floor(card.width / 2), 4);
      card.setAlpha(Math.min(0.9, lc.alpha));
      surf.blit(card, 10, 1);
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
        null,
        game.db.classes?.get(unit.klass)?.name ?? unit.klass,
        createPixelAnimation,
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
        // A level end trigger may queue a level-specific outro, the global
        // level-end event, and nested helper scripts. The web port processes
        // them in one EventState, so drain that queue before transitioning.
        // Otherwise the first nested helper to finish skips the remaining
        // cleanup (including EOtF's floor increment).
        if (game.eventManager?.getCurrentEvent()) {
          this.loadNextEvent(game);
          return;
        }
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
    // Python keeps portraits, tables/textboxes and the background on each
    // Event object, so a parent paused by trigger_script (or a choice's
    // EventNid) gets them back when it resumes. Park the outgoing event's
    // presentation while it is still pending.
    const previous = this.currentEvent;
    if (previous && previous !== next && !previous.isDone()) {
      this.parkedEventPresentation.set(previous, {
        eventTables: this.eventTables,
        eventTextboxes: this.eventTextboxes,
        portraits: this.portraits,
        portraitPriorityCounter: this.portraitPriorityCounter,
        background: this.background,
      });
      this.parkedOrder = this.parkedOrder.filter((event) => event !== previous);
      this.parkedOrder.push(previous);
      this.eventTables = new Map();
      this.eventTextboxes = new Map();
      this.portraits = new Map();
    }
    if (next) {
      this.currentEvent = next;
      this.dialog = null;
      this.endingCard = null;
      this.creditCards = [];
      this.banner = null;
      this.waitTimer = 0;
      this.waiting = false;
      this.portraits.clear();
      this.portraitPriorityCounter = 1;
      this.pendingPortraitLoads = 0;
      this.blockingPortraitLoads = 0;
      this.eventTables.clear();
      this.eventTextboxes.clear();
      let suspendedIndex = -1;
      for (let index = this.suspendedChoiceEvents.length - 1; index >= 0; index -= 1) {
        if (this.suspendedChoiceEvents[index].owner === next) {
          suspendedIndex = index;
          break;
        }
      }
      const parked = this.parkedEventPresentation.get(next);
      let restoredBackground: HTMLImageElement | null = null;
      this.parkedOrder = this.parkedOrder.filter((event) => event !== next);
      if (parked) {
        this.parkedEventPresentation.delete(next);
        this.eventTables = parked.eventTables;
        this.eventTextboxes = parked.eventTextboxes;
        this.portraits = parked.portraits;
        this.portraitPriorityCounter = parked.portraitPriorityCounter;
        restoredBackground = parked.background;
      }
      if (suspendedIndex >= 0) {
        const [suspended] = this.suspendedChoiceEvents.splice(suspendedIndex, 1);
        this.eventTables = suspended.eventTables;
        this.eventTextboxes = suspended.eventTextboxes;
        // The parent's portraits belong to its own Python Event object and
        // survive the selection event.
        if (suspended.portraits) this.portraits = suspended.portraits;
        if (suspended.replay) next.commandPointer = suspended.commandPointer;
      }
      this.background = restoredBackground;
      this.pendingBackgroundLoad = false;
      this.backgroundLoadDone = false;
      this.backgroundLoadToken++;
      this.chapterTitleTimer = 0;
      this.chapterTitlePhase = 'none';
      this.locationCard = null;
    } else {
      this.currentEvent = null;
      this.parkedOrder = [];
      this.endingCard = null;
      this.creditCards = [];
      this.portraits.clear();
      this.pendingPortraitLoads = 0;
      this.blockingPortraitLoads = 0;
      this.eventTables.clear();
      this.eventTextboxes.clear();
      this.background = null;
      this.pendingBackgroundLoad = false;
      this.backgroundLoadDone = false;
      this.backgroundLoadToken++;
      this.chapterTitleTimer = 0;
      this.chapterTitlePhase = 'none';
      this.locationCard = null;
      const previousState = game.state.stack[game.state.stack.length - 2];
      const resumeRoaming = previousState?.name === 'free' &&
        game.roamInfo?.roam &&
        !!game.roamInfo.roamUnitNid &&
        !!game.getUnit(game.roamInfo.roamUnitNid)?.position;
      game.state.back();
      if (resumeRoaming) game.state.change('free_roam');
      else if (!previousState) game.state.change('free');
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

    // Python EventState.level_end reads the ending level's _skip_save var
    // before clean_up; unless set, the between-chapter save screen shows.
    const skipSave = !!game.levelVars?.get?.('_skip_save');

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
      const enterNextLevel = (): void => {
        // Start the new level's events with a black screen so that
        // chapter_title + transition;Open work as expected
        if (game.eventManager?.hasActiveEvents()) this.startWithBlackScreen = true;
        enterStartedLevel(game);
      };
      if (skipSave) {
        enterNextLevel();
      } else {
        // Python level_end -> title_save (save_kind 'start'); its BACK or a
        // completed save continues into the next chapter.
        game.memory.set('title_save_continue', enterNextLevel);
        game.state.clear();
        game.state.change('title_save');
      }
    }).catch((err: unknown) => {
      this.levelTransitionInProgress = false;
      console.error('Failed to load next level:', err);
      game.state.clear();
      game.state.change('title');
    });
  }

  /**
   * Python pauses an event after a command whose trigger queued new events
   * (kill_unit's UnitDeath, autolevel_to's UnitLevelUp): their EventStates
   * sit above it and run first. Move events queued since `priorLength`
   * ahead of the current one and start them. The caller must already have
   * advanced past its command. Returns whether it switched events.
   */
  private runEventsQueuedSince(priorLength: number, game: any): boolean {
    const queue = game.eventManager?.eventQueue as GameEvent[] | undefined;
    const owner = this.currentEvent;
    if (!queue || !owner || queue.length <= priorLength) return false;
    const triggered = queue.splice(priorLength);
    const ownerIndex = queue.indexOf(owner);
    if (ownerIndex >= 0) queue.splice(ownerIndex, 1);
    queue.unshift(...triggered, owner);
    this.loadNextEvent(game);
    return true;
  }

  /**
   * Python event_functions.autolevel_to body: AutoLevel, then (unless
   * hidden) SetLevel and the UnitLevelUp trigger, then personal and class
   * skills. Returns the event-queue length before the trigger so callers can
   * run the triggered events first, or -1 when the unit is already there.
   */
  private autolevelUnitTo(
    unit: UnitObject,
    finalLevel: number,
    growthMethod: string | undefined,
    hidden: boolean,
    game: any,
  ): number {
    const currentLevel = unit.level;
    const difference = finalLevel - currentLevel;
    if (difference === 0) return -1;
    const autoLevel = new AutoLevelAction(unit, difference, growthMethod);
    game.actionLog.doAction(autoLevel);
    const levelUpQueueLength = game.eventManager?.eventQueue.length ?? 0;
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
    return levelUpQueueLength;
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

  private updateEventCreditCards(): void {
    const speed = 0.02;
    const startY = viewport.height;
    this.creditCards = this.creditCards.filter((card) => {
      card.elapsedMs += FRAMETIME;
      const centerY = Math.floor((viewport.height - card.height) / 2);
      const reachCenterMs = Math.max(0, (startY - centerY) / speed);
      let motionMs = card.elapsedMs;
      if (card.waitAtCenter && card.elapsedMs > reachCenterMs) {
        motionMs = card.elapsedMs <= reachCenterMs + card.pauseMs
          ? reachCenterMs
          : card.elapsedMs - card.pauseMs;
      }
      const y = startY - motionMs * speed;
      return y + card.height >= 0;
    });
  }

  private getEventCreditCardY(card: EventCreditCard): number {
    const speed = 0.02;
    const startY = viewport.height;
    const centerY = Math.floor((viewport.height - card.height) / 2);
    const reachCenterMs = Math.max(0, (startY - centerY) / speed);
    let motionMs = card.elapsedMs;
    if (card.waitAtCenter && card.elapsedMs > reachCenterMs) {
      motionMs = card.elapsedMs <= reachCenterMs + card.pauseMs
        ? reachCenterMs
        : card.elapsedMs - card.pauseMs;
    }
    return Math.floor(startY - motionMs * speed);
  }

  private updateChapterTitle(): void {
    this.chapterTitleTimer += FRAMETIME;
    this.chapterTitleBgCounter += FRAMETIME / 25;
    const ribbon = getMenuSprite('chapter_title_ribbon');
    const ribbonH = ribbon?.height ?? 32;
    const next = (phase: typeof this.chapterTitlePhase): void => {
      this.chapterTitlePhase = phase;
      this.chapterTitleTimer = 0;
    };
    switch (this.chapterTitlePhase) {
      case 'begin':
        if (this.chapterTitleTimer > 50 * 16) next('sigil');
        break;
      case 'sigil':
        this.chapterTitleSigilFade = Math.min(1, this.chapterTitleTimer / 1100);
        if (this.chapterTitleSigilFade >= 1) next('banner_grow_x');
        break;
      case 'banner_grow_x':
        this.chapterTitleBannerX = Math.min(WINWIDTH, this.chapterTitleBannerX + 10);
        if (this.chapterTitleBannerX >= WINWIDTH) next('banner_grow_y');
        break;
      case 'banner_grow_y':
        this.chapterTitleBannerY = Math.min(ribbonH, this.chapterTitleBannerY + 2);
        if (this.chapterTitleBannerY >= ribbonH) next('ribbon_fade_in');
        break;
      case 'ribbon_fade_in':
        this.chapterTitleBannerFade = Math.min(1, this.chapterTitleBannerFade + 0.02);
        if (this.chapterTitleBannerFade >= 1) next('wait');
        break;
      case 'wait':
        if (this.chapterTitleTimer > 5000) next('sigil_out');
        break;
      case 'sigil_out':
        this.chapterTitleSigilFade = Math.max(0, this.chapterTitleSigilFade - 0.02);
        if (this.chapterTitleSigilFade <= 0) next('ribbon_close');
        break;
      case 'ribbon_close':
        this.chapterTitleBannerY = Math.max(0, this.chapterTitleBannerY - 2);
        if (this.chapterTitleBannerY <= 0) {
          next('none');
          this.advancePointer();
        }
        break;
      default:
        break;
    }
  }

  /** Python ChapterTitleState.draw: scrolling bg, sigils, ribbon and banner. */
  private drawChapterTitle(surf: Surface): void {
    surf.fill(0, 0, 0);
    const { x: ox, y: oy } = MenuScene.origin();
    const s = surf.scale;
    const ctx = surf.ctx;
    const blitAlpha = (img: SpriteImage, sx: number, sy: number, sw: number, sh: number,
      dx: number, dy: number, alpha: number): void => {
      if (alpha <= 0 || sw <= 0 || sh <= 0) return;
      ctx.save();
      ctx.imageSmoothingEnabled = false;
      ctx.globalAlpha = Math.min(1, alpha);
      ctx.drawImage(img, sx, sy, sw, sh, Math.round(dx * s), Math.round(dy * s), Math.round(sw * s), Math.round(sh * s));
      ctx.restore();
    };
    // TransitionBackground: tiles scrolling diagonally up-left.
    const bg = getMenuSprite('chapter_title_bg');
    if (bg) {
      const cx = this.chapterTitleBgCounter % bg.width;
      const cy = this.chapterTitleBgCounter % bg.height;
      for (let x = -cx; x < viewport.width; x += bg.width) {
        for (let y = -cy; y < viewport.height; y += bg.height) {
          blitAlpha(bg, 0, 0, bg.width, bg.height, x, y, 1);
        }
      }
    }
    const sigil1 = getMenuSprite('chapter_title_sigil');
    const sigil2 = getMenuSprite('chapter_title_sigil2');
    if (sigil1) {
      const x = ox + Math.floor(WINWIDTH / 2) - Math.floor(sigil1.width / 2);
      const y = oy + Math.floor(WINHEIGHT / 2) - Math.floor(sigil1.height / 2);
      blitAlpha(sigil1, 0, 0, sigil1.width, sigil1.height, x + 1, y + 1, this.chapterTitleSigilFade);
      if (sigil2) blitAlpha(sigil2, 0, 0, sigil2.width, sigil2.height, x, y, this.chapterTitleSigilFade);
    }
    const ribbon = getMenuSprite('chapter_title_ribbon');
    const ribbonPhases = new Set(['ribbon_fade_in', 'wait', 'ribbon_close', 'sigil_out']);
    if (ribbon && ribbonPhases.has(this.chapterTitlePhase)) {
      const strip = new Surface(ribbon.width, ribbon.height);
      strip.blitImage(ribbon, 0, 0, ribbon.width, ribbon.height, 0, 0);
      const nameW = menuTextWidth('chapter-yellow', this.chapterTitleText);
      blitMenuText(strip, 'chapter-yellow', this.chapterTitleText,
        Math.floor(ribbon.width / 2) - Math.floor(nameW / 2), Math.floor(ribbon.height / 2) - 6);
      const h = this.chapterTitleBannerY;
      const top = Math.floor((ribbon.height - h) / 2);
      if (h > 0) {
        surf.blitFrom(strip, 0, top, ribbon.width, h,
          Math.floor(viewport.width / 2) - Math.floor(ribbon.width / 2), Math.floor(viewport.height / 2) - Math.floor(h / 2));
      }
    }
    const banner = getMenuSprite('chapter_title_banner');
    if (banner) {
      const w = Math.min(banner.width, this.chapterTitleBannerX);
      const h = Math.min(banner.height, this.chapterTitleBannerY);
      blitAlpha(banner, 0, 0, w, h, Math.floor(viewport.width / 2) - Math.floor(w / 2),
        Math.floor(viewport.height / 2) - Math.floor(h / 2), 1 - this.chapterTitleBannerFade);
    }
  }

  /**
   * Python dialog.LocationCard.update runs every frame from Event.other_boxes,
   * even while the event waits on the card's exist_time.
   */
  private updateLocationCard(): void {
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
    }
  }

  /** Python dialog.Credits.draw: credit_title heading, credit-font lines. */
  private drawEventCreditCards(surf: Surface): void {
    const ox = MenuScene.origin().x;
    const creditH = FONT['credit']?.height ?? 16;
    const titleH = FONT['credit_title']?.height ?? 8;
    for (const card of this.creditCards) {
      const y = this.getEventCreditCardY(card);
      blitMenuText(surf, 'credit_title', card.title, ox + 32, y);
      card.lines.forEach((line, i) => {
        const x = card.center ? Math.floor(WINWIDTH / 2) - Math.floor(menuTextWidth('credit', line) / 2) : 88;
        blitMenuText(surf, 'credit', line, ox + x, y + titleH + i * creditH);
      });
    }
  }

  /** Resolve table rows on every draw so expression-backed displays stay live. */
  private getEventTableRows(table: EventTable): string[] {
    let raw: any = table.data;
    if (table.expression) {
      try {
        const source = this.substituteEventArgs([table.rawData || table.data], getGame())[0] ?? table.data;
        raw = evaluateExpression(source, this.buildConditionContext());
      } catch (error) {
        console.warn(`table ${table.nid}: failed to evaluate "${table.data}"`, error);
        return [];
      }
    } else if (typeof raw === 'string') {
      const trimmed = raw.trim();
      const unwrapped = trimmed.startsWith('[') && trimmed.endsWith(']')
        ? trimmed.slice(1, -1)
        : trimmed;
      raw = unwrapped ? unwrapped.split(',').map(value => value.trim().replaceAll('{comma}', ',')) : [];
    }
    const values = Array.isArray(raw) ? raw : [raw];
    return values.map(value => {
      if (value && typeof value === 'object' && 'nid' in value) {
        return String(value.nid);
      }
      return value === null || value === undefined ? '' : String(value);
    });
  }

  /**
   * Draw persistent event textboxes. Like tables these re-resolve every frame
   * so an `expression` box tracks the value it displays — EotF uses them for
   * the currency counters shown beside the summoning pool and shops.
   */
  private drawEventTextboxes(surf: Surface): void {
    const game = getGame();
    for (const box of this.eventTextboxes.values()) {
      let text = box.text;
      if (box.expression) {
        try {
          // Python DynamicDialogWrapper: substitute text tags, then eval,
          // every frame so hover-driven descriptions stay current.
          const source = this.substituteEventArgs([box.rawText], game)[0] ?? box.rawText;
          const value = evaluateExpression(source, this.buildConditionContext());
          text = value === null || value === undefined ? '' : String(value);
        } catch (error) {
          console.warn(`textbox ${box.nid}: failed to evaluate "${box.rawText}"`, error);
          continue;
        }
      }
      const content = text.trim();
      if (!content) continue;

      // Python textbox uses the '__default_text' speak style: 'text' font on
      // a menu_bg_base window (the 'small' font only has lowercase glyphs).
      const paragraphs = content.split(/\{br\}|\n/);
      const maxTextWidth = box.width > 0 ? box.width - 16 : surf.width - 36;
      const lines: string[] = [];
      for (const paragraph of paragraphs) {
        const words = paragraph.split(' ');
        let line = '';
        for (const word of words) {
          const candidate = line ? `${line} ${word}` : word;
          if (line && measureStyledText(candidate, 'text') > maxTextWidth) {
            lines.push(line);
            line = word;
          } else {
            line = candidate;
          }
        }
        lines.push(line);
      }
      const shown = lines.slice(0, Math.max(box.numLines, 1) > 1 ? box.numLines : lines.length);
      const panelWidth = Math.min(
        surf.width - 20,
        box.width > 0 ? box.width : Math.max(24, ...shown.map(line => measureStyledText(line, 'text'))) + 16,
      );
      const panelHeight = Math.max(box.numLines, shown.length) * 16 + 8;
      const alignment = box.alignment;
      const x = alignment.includes('right')
        ? surf.width - panelWidth - 10
        : alignment.includes('left')
          ? 10
          : Math.floor((surf.width - panelWidth) / 2);
      const y = alignment.includes('bottom')
        ? surf.height - panelHeight - 10
        : alignment.includes('top')
          ? 10
          : Math.floor((surf.height - panelHeight) / 2);

      surf.blit(getMenuBackgroundSync(panelWidth, panelHeight, box.bg || 'menu_bg_base'), x, y);
      shown.forEach((line, index) => {
        drawStyledText(surf, line, x + 8, y + 4 + index * 16, 'white', 'text');
      });
    }
  }

  /** Draw persistent event tables in logical game space, matching LT's 10px margins. */
  private drawEventTables(surf: Surface): void {
    for (const table of this.eventTables.values()) {
      const values = this.getEventTableRows(table);
      const columns = Math.max(1, table.columns);
      const rows = Math.max(1, table.rows || Math.ceil(values.length / columns));
      // Python SimpleMenuUI row heights by entry type (portrait 80, chibi 32,
      // icon/text 16) and option widths (portrait 96, chibi 32).
      const entryType = table.entryType;
      const isImage = entryType === 'type_portrait' || entryType === 'type_chibi';
      const hasIcon = ['type_base_item', 'type_game_item', 'type_skill'].includes(entryType);
      const cellWidth = table.rowWidth > 0
        ? table.rowWidth
        : entryType === 'type_portrait' ? 96
          : entryType === 'type_chibi' ? 32
            : Math.max(24, ...values.map(value => measureStyledText(value.includes('|') ? value.slice(value.indexOf('|') + 1) : value, 'text') + 8 + (hasIcon || entryType === 'type_unit' ? 18 : 0)));
      const rowHeight = entryType === 'type_portrait' ? 80
        : entryType === 'type_chibi' ? 32
          : values.some(value => value.includes('<icon>')) ? 18 : 16;
      const titleHeight = table.title ? 16 : table.background === 'funds_display' ? 7 : 0;
      const panelWidth = Math.min(surf.width - 20, columns * cellWidth + (isImage ? 6 : 8));
      const panelHeight = Math.min(surf.height - 20, titleHeight + rows * rowHeight + 6);
      const alignment = table.alignment.toLowerCase();
      const x = alignment.includes('right')
        ? surf.width - panelWidth - 10
        : alignment.includes('left')
          ? 10
          : Math.floor((surf.width - panelWidth) / 2);
      const y = alignment.includes('bottom')
        ? surf.height - panelHeight - 10
        : alignment.includes('top')
          ? 10
          : Math.floor((surf.height - panelHeight) / 2);

      if (!table.noBackground) {
        if (table.background === 'funds_display') {
          // Rekka uses LT's compact 64x22 funds plate during the Bribe prompt.
          surf.fillRect(x, y, panelWidth, panelHeight, 'rgba(19,31,70,0.96)');
          surf.fillRect(x, y, panelWidth, 9, 'rgba(82,69,49,0.98)');
          surf.drawRect(x, y, panelWidth, panelHeight, 'rgba(214,191,112,1)');
          surf.drawRect(x + 2, y + 2, panelWidth - 4, panelHeight - 4, 'rgba(122,106,67,1)');
          surf.drawText('FUNDS', x + 4, y + 1, 'rgba(240,224,158,1)', 'small');
          surf.drawText('G', x + panelWidth - 8, y + panelHeight - 10, 'yellow', 'small');
        } else {
          surf.blit(getMenuBackgroundSync(panelWidth, panelHeight, table.background), x, y);
        }
      }

      if (table.title) {
        drawStyledText(surf, table.title, x + 5, y + 3, 'white', 'text');
      }
      const contentTop = y + titleHeight + 3;
      values.slice(0, rows * columns).forEach((value, index) => {
        const column = index % columns;
        const row = Math.floor(index / columns);
        const left = x + 3 + column * cellWidth;
        const right = x + 1 + (column + 1) * cellWidth;
        const textY = contentTop + row * rowHeight;
        const entryType = table.entryType;
        if (entryType === 'type_portrait' || entryType === 'type_chibi') {
          // Python BasicPortraitOption (96x80 main frame) / BasicChibiOption
          // (32x32 chibi at the sheet's right edge).
          const sheet = getColorkeyedPortrait(getGame(), value);
          if (sheet) {
            const ps = surf.scale;
            surf.ctx.imageSmoothingEnabled = false;
            if (entryType === 'type_portrait') {
              surf.ctx.drawImage(sheet, 0, 0, 96, 80, Math.round(left * ps), Math.round(textY * ps), 96 * ps, 80 * ps);
            } else {
              surf.ctx.drawImage(sheet, sheet.width - 32, 16, 32, 32, Math.round(left * ps), Math.round(textY * ps), 32 * ps, 32 * ps);
            }
          }
          return;
        }
        // Python SimpleMenuUI.parse_data: entries are 'nid' or 'nid|text'.
        const pipe = value.indexOf('|');
        const nid = pipe >= 0 ? value.slice(0, pipe) : value;
        const text = pipe >= 0 ? value.slice(pipe + 1) : null;
        let label = text ?? nid;
        let icon: { sheet: string; index: [number, number] } | null = null;
        let unitSprite: { draw(surf: Surface, x: number, y: number, a: number, b: number): void } | null = null;
        if (entryType === 'type_base_item' || entryType === 'type_skill') {
          const prefab = entryType === 'type_skill' ? getGame().db.skills.get(nid) : getGame().db.items.get(nid);
          label = text ?? prefab?.name ?? nid;
          if (prefab?.icon_nid && Array.isArray(prefab.icon_index)) icon = { sheet: prefab.icon_nid, index: prefab.icon_index };
        } else if (entryType === 'type_game_item') {
          const item = getGame().getItem?.(nid) ?? getGame().getItem?.(Number(nid));
          label = text ?? item?.name ?? nid;
          if (item?.iconNid) icon = { sheet: item.iconNid, index: item.iconIndex };
        } else if (entryType === 'type_unit') {
          // parse_unit: the unit's passive map sprite as a 16px icon.
          const unit = getGame().units.get(nid);
          label = text ?? unit?.name ?? getGame().db.units.get(nid)?.name ?? nid;
          if (unit?.sprite && typeof unit.sprite.draw === 'function') unitSprite = unit.sprite;
        } else if (entryType === 'type_class') {
          label = text ?? getGame().db.classes.get(nid)?.name ?? nid;
        } else if (entryType === 'type_icon') {
          const parts = nid.split('-');
          if (parts.length >= 4) {
            icon = { sheet: parts[0], index: [Number(parts[1]) || 0, Number(parts[2]) || 0] };
            label = text ?? parts.slice(3).join('-');
          }
        }
        const textX0 = icon || unitSprite ? left + 18 : left;
        if (icon) drawIcon16(surf, icon.sheet, icon.index, left, textY);
        if (unitSprite) {
          // parse_unit uses the 'passive' image, never the grey finished one.
          const sprite = unitSprite as any;
          const previous = sprite.state;
          if (previous === 'gray') sprite.state = 'standing';
          unitSprite.draw(surf, left + 2, textY - 1, 0, 0);
          sprite.state = previous;
        }
        const textAlignment = table.textAlignment.toLowerCase();
        const textWidth = measureStyledText(label, 'text');
        if (textAlignment === 'right' || table.background === 'funds_display') {
          const rightEdge = table.background === 'funds_display' ? right - 8 : right - 2;
          drawStyledText(surf, label, rightEdge - textWidth, textY, 'white', 'text');
        } else {
          const textX = textAlignment === 'center'
            ? textX0 + Math.max(0, Math.floor((cellWidth - textWidth) / 2))
            : textX0;
          drawStyledText(surf, label, textX, textY, 'white', 'text');
        }
      });
    }
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
    const matches = (item: ItemObject) =>
      item.nid === itemNid || String(item.uid) === String(itemNid);
    if (!recursive) return items?.find(matches);
    const find = (candidates: ItemObject[]): ItemObject | undefined => {
      for (const item of candidates) {
        if (matches(item)) return item;
        const nested = find(item.subitems);
        if (nested) return nested;
      }
      return undefined;
    };
    return items ? find(items) : undefined;
  }

  /** Match LT's skill-adjusted item/accessory inventory capacity check. */
  private inventoryFull(unit: UnitObject, item: ItemObject): boolean {
    return itemInventoryFull(unit, item, getGame().db);
  }

  /**
   * Resolve a position argument that could be either "x,y" coordinates
   * or a unit NID (resolves to the unit's current position).
   */
  private resolvePosition(posOrUnit: string, game: any): [number, number] | null {
    if (!posOrUnit) return null;
    // Try parsing as x,y coordinates first
    const normalized = posOrUnit.trim().replace(/^[[(]\s*|\s*[\])]$/g, '');
    const parts = normalized.split(',');
    if (parts.length >= 2) {
      const x = parseInt(parts[0].trim(), 10);
      const y = parseInt(parts[1].trim(), 10);
      if (!isNaN(x) && !isNaN(y)) return [x, y];
    }
    // Try resolving as a unit NID
    const unit = this.findUnit(posOrUnit);
    if (unit?.position) return [unit.position[0], unit.position[1]];
    const region = game.currentLevel?.regions?.find(
      (candidate: any) => candidate.nid === posOrUnit,
    );
    if (region?.position) return [region.position[0], region.position[1]];
    return null;
  }

  /** Start an undoable path-backed event move without consuming the unit's turn. */
  private beginEventMove(
    unit: UnitObject,
    target: [number, number],
    speedMs: number,
    game: GameState,
    onComplete: () => void,
  ): boolean {
    if (!unit.position || !game.board || !game.pathSystem) return false;
    const path = game.pathSystem.getPath(unit, target[0], target[1], game.board);
    game.actionLog.doAction(new WarpUnitAction(unit, target, game.board));
    if (!path || path.length <= 1) {
      return false;
    }
    const previousHasMoved = unit.hasMoved;
    const previousMovementLeft = unit.movementLeft;
    game.movementSystem.beginMove(
      unit,
      path,
      1000 / Math.max(1, speedMs),
      () => {
        unit.hasMoved = previousHasMoved;
        unit.movementLeft = previousMovementLeft;
        onComplete();
      },
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

  /** Evaluate LT game_var/level_var expressions while preserving bare-string shorthand. */
  private evaluateVariableExpression(source: string): any {
    const trimmed = source.trim();
    if (/^-?\d+(?:\.\d+)?(?:,-?\d+(?:\.\d+)?)+$/.test(trimmed)) {
      return source;
    }
    if (/^[A-Za-z_][A-Za-z0-9_ -]*$/.test(trimmed) &&
        !['True', 'False', 'None'].includes(trimmed)) {
      // Python evaluates the argument, so a bare local such as EOtF's
      // `level_var;flashing_pos;target_pos` stores the position, not the
      // word. Other bare words keep the web's lenient literal fallback.
      const context = this.buildConditionContext();
      const isLocal = /^[A-Za-z_]\w*$/.test(trimmed) && (
        context.localArgs?.has(trimmed) ||
        ['unit', 'unit1', 'unit2', 'target', 'position', 'region', 'item', 'target_pos'].includes(trimmed)
      );
      if (isLocal) {
        try {
          const evaluated = evaluateExpression(trimmed, context);
          if (evaluated !== undefined && evaluated !== null) return evaluated;
        } catch {
          // fall through to the literal
        }
      }
      return source;
    }
    try {
      const evaluated = evaluateExpression(trimmed, this.buildConditionContext());
      return evaluated === undefined ? source : evaluated;
    } catch {
      return source;
    }
  }

  /** Evaluate a variable command, preserving the typed result of a whole {e:...} argument. */
  private evaluateVariableCommand(rawSource: string, substitutedSource: string): any {
    const wholeEval = rawSource.match(/^\{(?:e|eval):([\s\S]+)\}$/);
    if (!wholeEval) return this.evaluateVariableExpression(substitutedSource);
    const context = this.buildConditionContext();
    const typedSource = (wholeEval?.[1] ?? rawSource).replace(
      /\{v:([A-Za-z_][A-Za-z0-9_]*)\}/g,
      (_match, key: string) => {
        let value: any;
        if (context.localArgs?.has(key)) value = context.localArgs.get(key);
        else if (context.levelVars?.has(key)) value = context.levelVars.get(key);
        else if (context.gameVars?.has(key)) value = context.gameVars.get(key);
        return value === undefined ? 'undefined' : JSON.stringify(value);
      },
    );
    try {
      const evaluated = evaluateExpression(typedSource, context);
      if (evaluated !== undefined) return evaluated;
    } catch {
      // Fall through: Python evaluates the fully substituted text.
    }
    return this.evaluateVariableExpression(substitutedSource);
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
        // Python Event local args are trigger.to_args(), so {region} and
        // {position} substitute from the trigger like any other local.
        ...(trigger?.region ? [['region', trigger.region] as [string, any]] : []),
        ...(trigger?.position ? [['position', trigger.position] as [string, any]] : []),
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

  /**
   * Run one `{c:...}` command embedded in dialog text without moving the
   * event's own command pointer. Commands that would block the event
   * (wait, bop_portrait, ...) instead hold the dialog for that long.
   */
  private runInlineDialogCommand(line: string, game: any): void {
    const cmd = GameEvent.parseCommand(line);
    if (!cmd || !this.dialog) return;
    if (cmd.type === 'wait') {
      this.dialog.holdFor(parseInt(cmd.args?.[0] ?? '', 10) || 0);
      return;
    }
    const event = this.currentEvent;
    const pointer = event?.commandPointer ?? 0;
    const dialog = this.dialog;
    const blocks = this.dialogBlocksCommands;
    try {
      this.executeCommand(cmd, game);
    } catch (error) {
      console.warn(`inline dialog command failed: ${line}`, error);
    }
    if (event) event.commandPointer = pointer;
    this.dialog = dialog;
    this.dialogBlocksCommands = blocks;
    if (this.waiting) {
      dialog.holdFor(this.waitTimer);
      this.waiting = false;
      this.waitTimer = 0;
    }
  }

  /** Python Event._resolve_speak_style(speaker_or_style, style_nid, manual_style). */
  private resolveSpeakStyle(game: any, speakerOrStyle: string, styleNid: string | null, manual: SpeakStyleDef): SpeakStyleDef {
    const lookup = (nid: string | null): SpeakStyleDef | undefined => {
      if (!nid) return undefined;
      const project = game.speakStyles instanceof Map ? game.speakStyles.get(nid) : undefined;
      return project && !Array.isArray(project) ? project : BUILTIN_SPEAK_STYLES[nid];
    };
    let current: SpeakStyleDef = mergeSpeakStyle({}, BUILTIN_SPEAK_STYLES.__default);
    const styles: SpeakStyleDef[] = [];
    const named = lookup(styleNid);
    if (named) styles.push(named);
    styles.push(manual);
    const speakerStyle = lookup(speakerOrStyle);
    if (speakerStyle) styles.push(speakerStyle);
    else current.speaker = speakerOrStyle;
    for (const style of styles) current = mergeSpeakStyle(current, style);
    return current;
  }

  /**
   * Build one `choice` entry the way Python's GridChoiceMenu option classes
   * render it: items/skills with their icon and name, units with their map
   * sprite and name, classes by name, `type_icon` as `sheet-x-y-text`.
   */
  private buildChoiceEntry(value: string, display: string | null, entryType: string, game: any): EventChoiceEntry {
    const iconOf = (obj: any): EventChoiceEntry['icon'] => {
      const sheet = obj?.icon_nid ?? obj?.iconNid;
      const index = obj?.icon_index ?? obj?.iconIndex;
      return sheet && Array.isArray(index) ? { sheet, index: [Number(index[0]) || 0, Number(index[1]) || 0] } : null;
    };
    switch (entryType) {
      case 'type_base_item': {
        const prefab = game.db.items.get(value);
        return { value, kind: 'icon', text: display ?? prefab?.name ?? value, icon: iconOf(prefab) };
      }
      case 'type_game_item': {
        const item = game.getItem?.(value) ?? game.getItem?.(Number(value)) ?? null;
        const uses = item && item.maxUses > 0 ? String(item.uses) : null;
        return { value, kind: 'icon', text: display ?? item?.name ?? value, icon: iconOf(item), uses };
      }
      case 'type_skill': {
        const prefab = game.db.skills.get(value);
        return { value, kind: 'icon', text: display ?? prefab?.name ?? value, icon: iconOf(prefab) };
      }
      case 'type_unit': {
        const unit = game.units.get(value) ?? null;
        const prefab = unit ?? game.db.units.get(value);
        const sprite = unit?.sprite && typeof unit.sprite.draw === 'function' ? unit.sprite : null;
        return { value, kind: 'sprite', text: display ?? prefab?.name ?? value, sprite };
      }
      case 'type_class': {
        const klass = game.db.classes.get(value);
        return { value, kind: 'sprite', text: display ?? klass?.name ?? value, sprite: null };
      }
      case 'type_icon': {
        const parts = value.split('-');
        if (parts.length >= 4) {
          const [sheet, x, y, ...rest] = parts;
          return { value, kind: 'icon', text: display ?? rest.join('-'), icon: { sheet, index: [Number(x) || 0, Number(y) || 0] } };
        }
        return { value, kind: 'text', text: display ?? value };
      }
      default:
        return { value, kind: 'text', text: display ?? value };
    }
  }

  /**
   * Substitute LT text tags ({unit}, {v:}, {e:}, {d:}, bare {var}) in event
   * command arguments, as Python's text_evaluator does when a command runs.
   * Also used every frame for `textbox ... expression`, which Python
   * re-evaluates continuously (e.g. `{v:<choice>_choice_hover}` descriptions).
   */
  private substituteEventArgs(rawArgs: string[], game: any): string[] {
    // Substitute template variables in all args:
    // {unit}/{unit1} -> the primary unit (from trigger.unitNid or unit1.nid)
    // {unit2} -> the secondary unit (from trigger.unit2.nid)
    const trigger = this.currentEvent?.trigger;
    const unitNid = trigger?.unitNid ?? trigger?.unit1?.nid ?? '';
    const unit2Nid = trigger?.unitB ?? trigger?.unit2?.nid ?? '';
    const expressionContext = this.buildConditionContext();
    const eventObjectToString = (result: unknown, nested = false): string => {
      const raw = result && typeof result === 'object' && '_raw' in result
        ? result._raw
        : result;
      if (raw && typeof raw === 'object') {
        if ('uid' in raw && raw.uid !== undefined) return String(raw.uid);
        if ('nid' in raw && raw.nid !== undefined) return String(raw.nid);
        if (Array.isArray(raw)) {
          return `[${raw.map((entry) => eventObjectToString(entry, true)).join(', ')}]`;
        }
        if (raw instanceof Map) {
          return `{${[...raw.entries()].map(([key, entry]) =>
            `${JSON.stringify(String(key))}: ${eventObjectToString(entry, true)}`).join(', ')}}`;
        }
        return `{${Object.entries(raw).map(([key, entry]) =>
          `${JSON.stringify(key)}: ${eventObjectToString(entry, true)}`).join(', ')}}`;
      }
      if (typeof raw === 'string') return nested ? JSON.stringify(raw) : raw;
      if (typeof raw === 'boolean') return raw ? 'True' : 'False';
      return raw === undefined || raw === null ? '' : String(raw);
    };
    const args = rawArgs.map((arg) => {
      let value = arg
        .replace(/\{unit1?\}/g, unitNid)
        .replace(/\{unit2\}/g, unit2Nid);
      const variableValue = (key: string): any => {
        if (expressionContext.localArgs?.has(key)) return expressionContext.localArgs.get(key);
        if (game.levelVars?.has?.(key)) return game.levelVars.get(key);
        if (game.gameVars?.has?.(key)) return game.gameVars.get(key);
        return undefined;
      };
      const replaceDataTags = (source: string): string => source.replace(
        /\{(?:d|data):([^{}]+)\}/g,
        (_match, path: string) => {
          const parts = path.split('.');
          let resolved = game.db.rawData?.get?.(parts[0]);
          if (parts.length === 2) {
            resolved = resolved?.get?.(parts[1]) ?? resolved?.[parts[1]];
          } else if (parts.length === 3) {
            let entry: unknown;
            if (parts[1].startsWith('[') && parts[1].endsWith(']')) {
              const terms = parts[1].slice(1, -1).split(',')
                .map((term: string) => term.trim())
                .filter(Boolean);
              entry = Array.isArray(resolved)
                ? resolved.find((candidate: unknown) => {
                  if (!candidate || typeof candidate !== 'object') return false;
                  return terms.every((term: string) => {
                    const [key, expected] = term.split('=').map((part) => part.trim());
                    if (expected === undefined) {
                      return Object.values(candidate).some((value) => String(value) === key);
                    }
                    return key in candidate && String(Reflect.get(candidate, key)) === expected;
                  });
                })
                : undefined;
            } else {
              entry = resolved?.get?.(parts[1]) ??
                (Array.isArray(resolved)
                  ? resolved.find((candidate: unknown) =>
                    !!candidate && typeof candidate === 'object' &&
                    'nid' in candidate && candidate.nid === parts[1])
                  : undefined);
            }
            resolved = entry && typeof entry === 'object' && parts[2] in entry
              ? Reflect.get(entry, parts[2])
              : undefined;
          }
          return resolved === undefined ? '??' : eventObjectToString(resolved);
        },
      );
      // Python TextEvaluator._evaluate_unit_fields: {f:[unit.]key[, fallback]}
      // reads unit.get_field (unit fields, then class fields); a class nid
      // reads that class's field. EOtF stores Undeath HP, possessors, and
      // original names this way.
      const replaceFieldTags = (source: string): string => source.replace(
        /\{(?:f|field):([^{}]*)\}/g,
        (_match, body: string) => {
          const comma = body.indexOf(',');
          const fieldText = comma >= 0 ? body.slice(0, comma) : body;
          const fallback = comma >= 0 ? body.slice(comma + 1) : ' ';
          const dot = body.indexOf('.');
          const [nid, field] = dot >= 0
            ? [fieldText.slice(0, fieldText.indexOf('.')), fieldText.slice(fieldText.indexOf('.') + 1)]
            : ['_unit', fieldText];
          const trigger = this.currentEvent?.trigger;
          const unit = nid === '_unit'
            ? (trigger?.unit1 ?? (unitNid ? this.findUnit(unitNid) : undefined))
            : nid === '_unit2'
              ? (trigger?.unit2 ?? (unit2Nid ? this.findUnit(unit2Nid) : undefined))
              : this.findUnit(nid);
          if (!unit) {
            const klass = game.db.classes.get(nid);
            const found = klass?.fields?.find?.((entry: [string, unknown]) => entry[0] === field);
            if (!found) {
              console.warn(`eval of {f:${body}} failed, unknown unit or class: ${nid}`);
              return '??';
            }
            return eventObjectToString(found[1]);
          }
          const fields: Map<string, unknown> | undefined = (unit as any).fields;
          if (fields?.has?.(field)) return eventObjectToString(fields.get(field));
          const classField = game.db.classes.get(unit.klass)?.fields?.find?.(
            (entry: [string, unknown]) => entry[0] === field,
          );
          return eventObjectToString(classField ? classField[1] : fallback);
        },
      );
      const typedVariableLiteral = (resolved: unknown): string => {
        if (typeof resolved === 'string') {
          const trimmed = resolved.trim();
          // Raw-data list/dict fields are stored as Python literal strings.
          // Inside {e:...}, Python substitutes those literals as expressions,
          // rather than quoting the entire value into a scalar string.
          if ((trimmed.startsWith('[') && trimmed.endsWith(']')) ||
              (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
              (trimmed.startsWith('(') && trimmed.endsWith(')'))) {
            return trimmed;
          }
        }
        return JSON.stringify(resolved) ?? 'null';
      };

      // Resolve typed {v:...} placeholders inside an eval before evaluating the
      // outer expression. JSON literals preserve arrays for indexing and random
      // choice instead of flattening them to comma-delimited text.
      for (let replacement = 0; replacement < 20; replacement += 1) {
        const evalIndex = value.indexOf('{eval:');
        const shortIndex = value.indexOf('{e:');
        const start = evalIndex < 0
          ? shortIndex
          : shortIndex < 0
            ? evalIndex
            : Math.min(evalIndex, shortIndex);
        if (start < 0) break;
        let depth = 0;
        let close = -1;
        for (let index = start; index < value.length; index += 1) {
          if (value[index] === '{') depth += 1;
          if (value[index] === '}') {
            depth -= 1;
            if (depth === 0) {
              close = index;
              break;
            }
          }
        }
        if (close < 0) break;
        const colon = value.indexOf(':', start);
        const expression = value.slice(colon + 1, close);
        const typedExpression = replaceDataTags(
          expression
            .replace(
              /(['"])\{v:([A-Za-z_][A-Za-z0-9_]*)\}\1/g,
              (_variableMatch, _quote: string, key: string) => {
                const resolved = variableValue(key);
                return typedVariableLiteral(resolved);
              },
            )
            .replace(
              /\{v:([A-Za-z_][A-Za-z0-9_]*)\}/g,
              (_variableMatch, key: string) => {
                const resolved = variableValue(key);
                return typedVariableLiteral(resolved);
              },
            )
            .replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, key: string) => {
              const resolved = variableValue(key);
              return resolved === undefined ? match : eventObjectToString(resolved);
            })
            .replace(/\{(?:f|field):[^{}]*\}/g, (match) => replaceFieldTags(match)),
        );
        const bareName = /^[A-Za-z_][A-Za-z0-9_]*$/.test(typedExpression);
        const contextName = /^(?:game|unit1?|unit2|target|region|position|target_pos|item)$/
          .test(typedExpression);
        const result = bareName && !contextName
          ? variableValue(typedExpression) ?? ''
          : evaluateExpression(typedExpression, expressionContext);
        value = value.slice(0, start) +
          eventObjectToString(result) +
          value.slice(close + 1);
      }
      // Python TextEvaluator._evaluate_vars: a missing variable becomes '??'
      // (so `if;len({v:missing}) > 0` fails to evaluate and is False).
      value = value.replace(/\{v:([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, key: string) => {
        const result = variableValue(key);
        return result === undefined ? '??' : eventObjectToString(result);
      });
      value = value.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, key: string) => {
        const result = variableValue(key);
        if (result !== undefined) return eventObjectToString(result);
        return match;
      });
      value = replaceFieldTags(value);
      value = replaceDataTags(value);
      return value;
    });
    return args;
  }

  private executeCommand(cmd: EventCommand, game: any): boolean {
    // Python's parser treats a command's flag tokens as flags wherever they
    // appear; move them after the positional arguments so an omitted
    // optional keyword (e.g. give_money's Party) is not filled by a flag.
    const commandMeta = EVENT_COMMAND_FLAGS[cmd.type];
    const givenArgs = cmd.args ?? [];
    const isFlag = (arg: string) => !!commandMeta?.flags.includes(arg.trim().toLowerCase());
    let rawArgs = givenArgs;
    if (commandMeta && givenArgs.some(isFlag)) {
      const positional = givenArgs.filter((arg) => !isFlag(arg));
      while (positional.length < commandMeta.slots) positional.push('');
      rawArgs = [...positional, ...givenArgs.filter(isFlag)];
    }

    let args = this.substituteEventArgs(rawArgs, game);

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
        // blocking commands resume normal presentation — unless START
        // requested a super skip.
        if (!this.superSkip) this.skipMode = false;
        this.advancePointer();
        return false;
      }

      // ----- Blocking commands -----

      case 's':           // short alias used in support conversations
      case 'say':
      case 'speak':
      case 'narrate': {
        // speak;SpeakerOrStyle;Text;TextPosition;Width;StyleNid;TextSpeed;
        // FontColor;FontType;DialogBox;NumLines;DrawCursor;MessageTail;
        // Transparency;NameTagBg;BoopSound;flags (Python event_commands.Speak).
        // say takes a list of texts joined by {sub_break}.
        const dialogFlagNames = new Set(['low_priority', 'hold', 'no_popup', 'fit', 'no_block',
          'no_talk', 'no_sound', 'autogray']);
        const optionalNames = ['textposition', 'width', 'stylenid', 'textspeed', 'fontcolor',
          'fonttype', 'dialogbox', 'numlines', 'drawcursor', 'messagetail', 'transparency',
          'nametagbg', 'boopsound'];
        const speakFlags = new Set<string>();
        const speakKw = new Map<string, string>();
        const speakerArg = (args[0] ?? '').trim();
        let text = args[1] ?? '';
        const restArgs = args.slice(2);
        const sayParts: string[] = [];
        let positional = 0;
        for (const raw of restArgs) {
          const entry = raw.trim();
          const lower = entry.toLowerCase();
          if (dialogFlagNames.has(lower)) {
            speakFlags.add(lower);
            continue;
          }
          const eq = entry.indexOf('=');
          const key = eq > 0 ? entry.slice(0, eq).trim().toLowerCase() : '';
          if (eq > 0 && optionalNames.includes(key)) {
            speakKw.set(key, entry.slice(eq + 1).trim());
            continue;
          }
          if (cmd.type === 'say') {
            sayParts.push(raw);
            continue;
          }
          if (positional < optionalNames.length) {
            if (entry) speakKw.set(optionalNames[positional], entry);
            positional += 1;
          }
        }
        if (cmd.type === 'say') text = [text, ...sayParts].join('{sub_break}');
        const noBlock = speakFlags.has('no_block');
        // In skip mode, auto-advance past all dialogue without showing it
        // (Python: hold speaks are still shown).
        if (this.skipMode && !speakFlags.has('hold')) {
          this.advancePointer();
          return false;
        }

        const numOrNull = (value: string | undefined): number | null => {
          if (value === undefined || value === '') return null;
          const parsed = Number(value);
          return Number.isFinite(parsed) ? parsed : null;
        };
        const boolOrNull = (value: string | undefined): boolean | null => {
          if (value === undefined || value === '') return null;
          return ['t', 'true', '1', 'y', 'yes'].includes(value.toLowerCase());
        };
        const drawCursorArg = boolOrNull(speakKw.get('drawcursor'));
        const manualStyle: SpeakStyleDef = {
          position: parseSpeakPosition(speakKw.get('textposition')),
          width: numOrNull(speakKw.get('width')),
          speed: numOrNull(speakKw.get('textspeed')),
          fontColor: speakKw.get('fontcolor') || null,
          fontType: speakKw.get('fonttype') || null,
          background: speakKw.get('dialogbox') || null,
          numLines: numOrNull(speakKw.get('numlines')),
          // Python speak(): cursor = True if draw_cursor is None
          drawCursor: drawCursorArg ?? true,
          messageTail: speakKw.get('messagetail') || null,
          transparency: numOrNull(speakKw.get('transparency')),
          nameTagBg: speakKw.get('nametagbg') || null,
          flags: speakFlags,
        };
        const style = this.resolveSpeakStyle(game, speakerArg, speakKw.get('stylenid') ?? null, manualStyle);
        let speaker = style.speaker ?? '';
        if (speaker === 'None') speaker = '';
        if (speaker.startsWith('"') && speaker.endsWith('"')) speaker = speaker.slice(1, -1);
        const speakerUnit = speaker ? this.findUnit(speaker) : undefined;
        if (speakerUnit) speaker = speakerUnit.nid;
        appendDialogLogEntry(game, speaker, text);

        // Stop previous speaking portrait
        if (this.speakingPortrait) {
          this.speakingPortrait.stopTalking();
          this.speakingPortrait = null;
        }

        // Look up portrait for the speaker
        const portrait = this.portraits.get(speaker) ?? null;
        const allFlags = style.flags ?? speakFlags;
        const noTalk = allFlags.has('no_talk');

        let numLines = style.numLines ?? 2;
        if (numLines === 0) {
          // Python: auto-choose 1 or 2 lines
          numLines = 2;
          if (portrait && !text.includes('{br}') && !text.includes('{clear}') &&
              measureStyledText(text, style.fontType ?? 'convo') < Math.floor(viewport.width / 2)) {
            numLines = 1;
          }
        }

        if (portrait && !noTalk && cmd.type !== 'narrate') {
          this.speakingPortrait = portrait;
          // Raise portrait priority (bring to front) unless low_priority
          if (!allFlags.has('low_priority')) {
            portrait.priority = this.portraitPriorityCounter++;
          }
        }

        this.dialog = new Dialog(
          text,
          speaker || undefined,
          portrait ?? undefined,
          this.getDialogTextSpeedMs(),
          style.speed ?? 1,
          noBlock,
          {
            position: style.position ?? null,
            width: style.width ?? null,
            numLines,
            background: style.background ?? null,
            fontColor: style.fontColor ?? null,
            fontType: style.fontType ?? null,
            drawCursor: style.drawCursor ?? true,
            messageTail: style.messageTail ?? null,
            transparency: style.transparency ?? 0.05,
            nameTagBg: style.nameTagBg ?? null,
            autosize: allFlags.has('fit'),
            hold: allFlags.has('hold'),
          },
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
        // transition (no direction) — toggles like Python event_functions.transition:
        // 'open' when the screen is currently closed, otherwise 'close'.
        // Parse optional duration (ms) and color
        const durationArg = parseInt(args[1], 10);
        if (!isNaN(durationArg) && durationArg > 0) {
          this.transitionDurationMs = Math.max(1, durationArg);
        } else {
          this.transitionDurationMs = 250; // Python Event._transition_speed
        }
        const explicitDirection = (args[0] ?? '').trim().toLowerCase();
        const screenClosed = this.transitionFadingIn || this.transitionHoldBlack ||
          (this.transitionAlpha >= 1 && !this.transitionFadingOut);
        const direction = explicitDirection || (screenClosed ? 'open' : 'close');
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
          this.transitionAlpha = direction === 'open' ? 0 : 1;
          this.transitionFadingIn = false;
          this.transitionFadingOut = false;
          this.transitionHoldBlack = direction !== 'open';
          this.advancePointer();
          return false;
        }
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
        // Python alert: banner.CustomIcon for an item/skill/icon alias, else banner.Custom.
        const text = args[0] ?? '';
        const alertItem = args[1] ? game.db.items.get(args[1]) : null;
        const alertSkill = args[2] ? game.db.skills.get(args[2]) : null;
        const alertIcon = alertItem ? itemIcon(alertItem)
          : alertSkill ? skillIcon(alertSkill)
            : args[3] ? { kind: 'alias' as const, alias: args[3] } : null;
        this.banner = new Banner(text, alertIcon, 3000, { iconLeft: !!alertIcon });
        this.bannerIsAlert = true;
        // Don't advance — advanced when banner finishes (in update) or early dismissed via input
        return true;
      }

      // ----- Unit commands (instant) -----

      case 'move_unit': {
        // move_unit;Unit;Position?;MovementType?;Placement?;Speed? with the
        // no_block/no_follow/silent flags anywhere (Python :1052). EOtF's
        // `move_unit;Loreia_F;5,4;no_block` walks the unit; it is not a
        // movement type.
        const muArgs = parsePythonEventArgs(
          args,
          ['Unit'],
          ['Position', 'MovementType', 'Placement', 'Speed'],
          ['no_block', 'no_follow', 'silent'],
        );
        const unitNid = muArgs.value('Unit') ?? '';
        const unit = this.findUnit(unitNid);
        const posStr = muArgs.value('Position') ?? '';
        let targetPos = this.resolvePosition(posStr, game);
        if (!targetPos && unit?.startingPosition) {
          targetPos = [unit.startingPosition[0], unit.startingPosition[1]];
        }
        if (!unit || !unit.position || !targetPos || !game.board) {
          this.advancePointer();
          return false;
        }

        const movementType = (muArgs.value('MovementType') || 'normal').toLowerCase();
        const placement = (muArgs.value('Placement') || 'giveup').toLowerCase().trim();
        const noBlock = muArgs.flags.has('no_block');
        const noFollow = muArgs.flags.has('no_follow');
        const parsedSpeed = parseInt(muArgs.value('Speed') ?? '', 10);
        const speedMs = Number.isFinite(parsedSpeed) && parsedSpeed > 0 ? parsedSpeed : 120;
        targetPos = this._checkPlacement(targetPos, placement, game, unit);
        if (!targetPos) {
          this.advancePointer();
          return false;
        }
        if (!noFollow) game.camera?.focusTile(targetPos[0], targetPos[1]);
        if (this.skipMode || movementType === 'immediate') {
          game.actionLog.doAction(new WarpUnitAction(unit, targetPos, game.board));
          this.advancePointer();
          return false;
        }
        if (movementType !== 'normal') {
          // Python Warp/FadeMove/Swoosh actions update position and begin their
          // sprite transition without pausing the event command stream.
          game.actionLog.doAction(new WarpUnitAction(unit, targetPos, game.board));
          this.advancePointer();
          return false;
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
          requestedPosition = this.resolvePosition(posArg, game);
        }

        if (existing) {
          requestedPosition ??= existing.startingPosition
            ? [existing.startingPosition[0], existing.startingPosition[1]]
            : null;
          const finalPosition = requestedPosition
            ? this._checkPlacement(requestedPosition, placement, game, existing)
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
        requestedPosition ??= unitData.starting_position
          ? [unitData.starting_position[0], unitData.starting_position[1]]
          : null;
        const finalPosition = requestedPosition
          ? this._checkPlacement(requestedPosition, placement, game)
          : null;
        if (finalPosition) {
          this.spawnUnitFromLevelData(unitData, finalPosition, game);
        } else {
          console.warn(`EventState add_unit: no valid position for "${unitNid}"`);
        }
        this.advancePointer();
        return false;
      }

      case 'create_unit': {
        // create_unit;Unit;Nid;Level;Position;EntryType;Placement;[copy_stats]
        // Creates a new unit instance from a template (either an already-
        // spawned unit or a UnitPrefab in the database) and optionally
        // places it on the map. Mirrors event_functions.create_unit().
        // Python parses Keyword=value arguments and flags in any slot; EOtF's
        // reinforcements are `create_unit;112;Position=2,4;copy_stats`.
        const cuArgs = parsePythonEventArgs(
          args,
          ['Unit'],
          ['Nid', 'Level', 'Position', 'EntryType', 'Placement'],
          ['copy_stats'],
        );
        const templateNid = cuArgs.value('Unit') ?? '';
        const explicitNid = (cuArgs.value('Nid') ?? '').trim();
        const levelStr = (cuArgs.value('Level') ?? '').trim();
        const posArg = (cuArgs.value('Position') ?? '').trim();
        const entryType = (cuArgs.value('EntryType') || 'fade').trim();
        const placement = (cuArgs.value('Placement') || 'giveup').trim().toLowerCase();
        const copyStats = cuArgs.flags.has('copy_stats');

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
          // Python GenericUnit.name: the faction's name.
          name: (baseFaction ? game.db.factions?.get?.(baseFaction)?.name : null) ?? newNid,
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
          // Python _parse_pos: "x,y", a bracketed tuple from {e:...}, or a
          // unit/region name.
          const parsed = this.resolvePosition(posArg, game);
          if (parsed) targetPos = this._checkPlacement(parsed, placement, game, newUnit);
        }
        void entryType; // Placement animation type is cosmetic-only in this port.

        game.actionLog.doAction(new CreateUnitAction(game, newUnit, targetPos));
        this.loadMapSpriteForUnit(newUnit, game);

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
        this.blockingPortraitLoads++;
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
            this.blockingPortraitLoads--;
          });
        // The load blocks on this pointer. Success installs the dialog; failure
        // advances here exactly once so a missing image cannot deadlock.
        return true;
      }

      case 'speak_style': {
        // speak_style;Style;Speaker;Position;Width;Speed;FontColor;FontType;
        // Background;NumLines;DrawCursor;MessageTail;Transparency;NameTagBg;
        // BoopSound;flags — Python event_functions.speak_style merges into an
        // existing style of the same name.
        const styleNid = (args[0] ?? '').trim();
        if (styleNid) {
          const names = ['speaker', 'position', 'width', 'speed', 'fontcolor', 'fonttype', 'background',
            'numlines', 'drawcursor', 'messagetail', 'transparency', 'nametagbg', 'boopsound'];
          const styleFlagNames = new Set(['low_priority', 'hold', 'no_popup', 'fit', 'no_talk', 'no_sound', 'autogray']);
          const kw = new Map<string, string>();
          const styleFlags = new Set<string>();
          let position = 0;
          for (const raw of args.slice(1)) {
            const entry = raw.trim();
            if (styleFlagNames.has(entry.toLowerCase())) {
              styleFlags.add(entry.toLowerCase());
              continue;
            }
            const eq = entry.indexOf('=');
            const key = eq > 0 ? entry.slice(0, eq).trim().toLowerCase() : '';
            if (eq > 0 && names.includes(key)) {
              kw.set(key, entry.slice(eq + 1).trim());
              continue;
            }
            if (position < names.length) {
              if (entry) kw.set(names[position], entry);
              position += 1;
            }
          }
          const num = (value: string | undefined): number | null => {
            if (!value) return null;
            const parsed = Number(value);
            return Number.isFinite(parsed) ? parsed : null;
          };
          const def: SpeakStyleDef = {
            speaker: kw.get('speaker') || null,
            position: parseSpeakPosition(kw.get('position')),
            width: num(kw.get('width')),
            speed: num(kw.get('speed')),
            fontColor: kw.get('fontcolor') || null,
            fontType: kw.get('fonttype') || null,
            background: kw.get('background') || null,
            numLines: num(kw.get('numlines')),
            drawCursor: kw.has('drawcursor') ? ['t', 'true', '1', 'y', 'yes'].includes(kw.get('drawcursor')!.toLowerCase()) : null,
            messageTail: kw.get('messagetail') || null,
            transparency: num(kw.get('transparency')),
            nameTagBg: kw.get('nametagbg') || null,
            flags: styleFlags,
          };
          if (!(game.speakStyles instanceof Map)) game.speakStyles = new Map();
          const existing: SpeakStyleDef | undefined = game.speakStyles.get(styleNid) ?? BUILTIN_SPEAK_STYLES[styleNid];
          game.speakStyles.set(styleNid, existing ? mergeSpeakStyle(existing, def) : def);
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
          getSyncStore().setItem('_music_title_screen', music);
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
        const enabledList = parseList(args[1]).map((v: string) => parseEventBool(v) ?? false);
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
        game.actionLog.doAction(new SetGameVarAction(game.gameVars, '_repair_shop', parseEventBool(args[0]) ?? false));
        this.advancePointer();
        return false;
      }

      case 'force_chapter_clean_up': {
        // force_chapter_clean_up (Python :748): game.clean_up(full=False) —
        // per-unit cleanup (heal, off-map, reset turn/rescue state) WITHOUT
        // the registry hand-off cleanUpLevel() does for level transitions
        // (Python keeps units registered here).
        game.applyItemEndChapterHooks();
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
        // Python get_open_formation_spots: unique, unoccupied, sorted (x, y).
        const openSpots = [...new Map(formationSpots.map((spot) => [spot.join(','), spot] as const)).values()]
          .filter(([x, y]) => !game.board?.getUnit(x, y))
          .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
        // Python get_units_in_party: persistent members in prep sort order.
        let candidates = (game.getUnitsInParty() as UnitObject[]).filter((u: any) =>
          !u.position && !u.tags?.includes('Blacklist') &&
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
          const rawValue = args[3];
          const value = rawValue !== undefined &&
              !['recursive', 'from_python', 'no_warn'].includes(rawValue)
            ? args.includes('from_python')
              ? parsePyevCommandValue(rawValue)
              : evaluateExpression(rawValue, this.buildConditionContext())
            : null;
          game.actionLog.doAction(new AddObjComponentAction(item, compNid, value));
        } else if (cmd.type === 'modify_item_component') {
          if (!item.components.has(compNid)) {
            console.warn(`modify_item_component: item lacks component ${compNid}`);
          } else {
            const value = args.includes('from_python')
              ? parsePyevCommandValue(args[3] ?? '')
              : evaluateExpression(args[3] ?? '', this.buildConditionContext());
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
            const rawValue = args[3];
            const value = rawValue !== undefined &&
                !['stack', 'from_python', 'no_warn'].includes(rawValue)
              ? evaluateExpression(rawValue, this.buildConditionContext())
              : null;
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
        const enabled = parseEventBool(args[0]) ?? false;
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
          const entries = args[1].split(',').map((part: string) => part.trim());
          const localArgs = new Map<string, string>();
          for (let index = 0; index < entries.length;) {
            const equals = entries[index].indexOf('=');
            if (equals >= 0) {
              localArgs.set(
                entries[index].slice(0, equals).trim(),
                entries[index].slice(equals + 1).trim(),
              );
              index += 1;
            } else {
              localArgs.set(entries[index], entries[index + 1] ?? '');
              index += 2;
            }
          }
          trig.localArgs = localArgs;
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
        const owner = this.currentEvent;
        const queue = game.eventManager.eventQueue as GameEvent[];
        const priorLength = queue.length;
        this.advancePointer();
        const queued = game.eventManager.triggerSpecific(targetNid, trig, true);
        if (!queued || !owner || queue.length <= priorLength) {
          console.warn(`trigger_script: no valid event matching "${eventName}"`);
          return false;
        }
        const nestedEvents = queue.splice(priorLength);
        const ownerIndex = queue.indexOf(owner);
        if (ownerIndex >= 0) queue.splice(ownerIndex, 1);
        queue.unshift(...nestedEvents, owner);
        this.loadNextEvent(game);
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
        // Python Event._get_skill: the first skill matching by nid or uid.
        const unit = this.findUnit(unitNid);
        const skill = unit?.skills?.find((candidate: SkillObject) =>
          candidate.nid === skillNid || String(candidate.uid) === skillNid);
        if (!unit || !skill || !dataKey) {
          console.warn(`set_skill_data: invalid unit/skill/key (${unitNid}/${skillNid}/${dataKey})`);
          this.advancePointer();
          return false;
        }
        // Python evaluates the Expression (e.g. EOtF's
        // `get_skill(unit, 'KnightsTour').data['charge'] + 1`) and skips the
        // command when it cannot be evaluated.
        let value: unknown;
        try {
          value = evaluateExpression(rawExpr.trim(), this.buildConditionContext());
        } catch {
          value = undefined;
        }
        if (value === undefined) {
          console.warn(`set_skill_data: could not evaluate ${rawExpr}`);
        } else {
          game.actionLog.doAction(new SetSkillDataAction(skill, dataKey, value));
        }
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

      case 'unload_unit': {
        const unitNid = args[0] ?? '';
        const unit = this.findUnit(unitNid);
        if (unit) game.actionLog.doAction(new UnregisterUnitAction(game, unit));
        this.advancePointer();
        return false;
      }

      case 'kill_unit': {
        // kill_unit;Unit;[immediate] (Python event_functions.kill_unit):
        // the unit dies, then UnitDeath fires with no killer and pauses this
        // event, so the unit_death events (EOtF: 49 `not unit2` reward and
        // cleanup scripts) run before the rest of this one.
        const unitNid = args[0] ?? '';
        const unit = this.findUnit(unitNid);
        const wasOnMap = !!unit?.position;
        const immediate = args.some(arg => arg.toLowerCase().trim() === 'immediate');
        if (!unit) {
          console.warn(`kill_unit: couldn't find unit ${unitNid}`);
          this.advancePointer();
          return false;
        }
        const deathPosition = unit.position
          ? [unit.position[0], unit.position[1]] as [number, number]
          : undefined;
        game.actionLog.doAction(new SetCurrentHpAction(unit, 0));
        game.actionLog.doAction(new DeathAction(unit, game.board, game.initiative));
        const queue = game.eventManager.eventQueue as GameEvent[];
        const priorLength = queue.length;
        game.eventManager.trigger(
          {
            type: 'unit_death', unit1: unit, unitNid: unit.nid,
            // An immediate death has already left the map in Python.
            position: immediate ? undefined : deathPosition,
            levelNid: game.currentLevel?.nid,
          },
          { game, unit1: unit, gameVars: game.gameVars, levelVars: game.levelVars },
        );
        if (queue.length > priorLength && this.currentEvent) {
          this.advancePointer();
          return this.runEventsQueuedSince(priorLength, game);
        }
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

          const finalPos = this._checkPlacement(position, placement, game, existing ?? null);
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
          const finalDestination = this._checkPlacement(destination, placement, game, existing ?? null);
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
        const groupFlags = new Set(['no_block', 'no_follow']);
        const positional = args.filter(arg => !groupFlags.has(arg.toLowerCase().trim()));
        const groupNid = positional[0] ?? '';
        const startingGroup = positional[1] ?? '';
        const movementType = (positional[2] || 'normal').toLowerCase().trim();
        const placement = (positional[3] ?? 'giveup').toLowerCase().trim();
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
          const finalPosition = this._checkPlacement(destination, placement, game, unit);
          if (!finalPosition) continue;
          if (this.skipMode || movementType !== 'normal') {
            game.actionLog.doAction(new WarpUnitAction(unit, finalPosition, game.board));
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
        const giArgs = parsePythonEventArgs(
          args,
          ['GlobalUnitOrConvoy', 'Item'],
          ['Party'],
          ['no_banner', 'no_choice', 'force_give', 'droppable'],
        );
        const giUnitNid = giArgs.value('GlobalUnitOrConvoy') ?? '';
        const giItemNid = giArgs.value('Item') ?? '';
        const giBannerFlag = !giArgs.flags.has('no_banner');
        let giDiscard = false;
        const giItemPrefab = game.db.items.get(giItemNid);
        const giExistingItem = /^\d+$/.test(giItemNid)
          ? game.getItem(giItemNid)
          : null;
        let giBannerText: string | undefined;
        const giItem = giItemPrefab
          ? createItemTree(giItemPrefab, (nid) => game.db.items.get(nid))
          : giExistingItem;
        if (giItem) {
          if (giItemPrefab) {
            game.actionLog.doAction(new RegisterItemTreeAction(
              game.items,
              giItem,
              `event_${giItem.uid}_${giItem.nid}`,
            ));
          }
          game.actionLog.doAction(new SetItemDroppableAction(giItem, giArgs.flags.has('droppable')));
          if (giUnitNid.toLowerCase() === 'convoy') {
            const giParty = game.getParty(giArgs.value('Party') || undefined);
            if (giParty) {
              game.actionLog.doAction(new PutItemInConvoy(giItem, giParty.nid));
              giBannerText = `${colored(giItem.name)} sent to convoy.`;
            }
          } else {
            const giUnit = this.findUnit(giUnitNid);
            if (giUnit && this.inventoryFull(giUnit, giItem) && giArgs.flags.has('no_choice')) {
              // Python: a full inventory with no_choice sends it to the convoy.
              game.actionLog.doAction(new PutItemInConvoy(giItem, game.getParty()?.nid));
              giBannerText = `${colored(giItem.name)} sent to convoy.`;
            } else if (giUnit) {
              const giFull = this.inventoryFull(giUnit, giItem);
              game.actionLog.doAction(new GiveItemAction(giUnit, giItem));
              giBannerText = acquiredItemText(giUnit.name, giItem.name);
              if (giFull) {
                // Python: otherwise the unit must discard down to capacity.
                game.memory.set('item_discard_current_unit', giUnit);
                game.memory.set('item_discard_new_item', giItem);
                game.memory.set('item_discard_force_give', giArgs.flags.has('force_give'));
                giDiscard = true;
              }
            }
          }
        }
        if (giDiscard) game.state.change('item_discard');
        if (giBannerFlag && giBannerText && !this.skipMode) {
          this.banner = new Banner(giBannerText, itemIcon(giItem), 3000, { sound: 'Item' });
          this.bannerIsAlert = true;
          return true;
        }
        this.advancePointer();
        return giDiscard;
      }

      case 'remove_item': {
        // remove_item;GlobalUnitOrConvoy;Item;Party? — items match by nid or
        // uid (Python Event._get_item_in_inventory); flags may sit anywhere.
        const riArgs = parsePythonEventArgs(args, ['GlobalUnitOrConvoy', 'Item'], ['Party'], ['no_banner']);
        const ownerNid = riArgs.value('GlobalUnitOrConvoy') ?? '';
        const itemNid = riArgs.value('Item') ?? '';
        const riBannerFlag = !riArgs.flags.has('no_banner');
        let riBannerText: string | undefined;
        let riIcon: ReturnType<typeof itemIcon> = null;
        if (ownerNid.toLowerCase() === 'convoy') {
          // Python looks the item up in the current convoy, then removes it
          // from the named party's convoy (default: current).
          const item = this.findInventoryItem('convoy', itemNid);
          const partyNid = riArgs.value('Party') || undefined;
          if (item) game.actionLog.doAction(new RemoveItemFromConvoy(item, game.getParty(partyNid)?.nid));
        } else {
          const unit = this.findUnit(ownerNid);
          const item = unit ? this.findInventoryItem(ownerNid, itemNid) : undefined;
          if (unit && item) {
            game.actionLog.doAction(new RemoveItemFromUnitAction(unit, item));
            riBannerText = `${colored(unit.name)} lost ${colored(item.name)}.`;
            riIcon = itemIcon(item);
          }
        }
        if (riBannerFlag && riBannerText && !this.skipMode) {
          this.banner = new Banner(riBannerText, riIcon, 3000, { sound: 'ItemBreak' });
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
          ? this.findInventoryItem(giverNid, args[2])
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
        const childId = args[2] ?? '';
        const registeredChild = game.getItem(childId);
        const childPrefab = registeredChild ? null : game.db.items.get(childId);
        const child = registeredChild ??
          (childPrefab ? createItemTree(childPrefab, (nid) => game.db.items.get(nid)) : null);
        const duplicate = !!child && (
          parent?.subitems.includes(child) ||
          parent?.subitems.some((candidate) => candidate.nid === child.nid)
        );
        if (parent?.hasComponent('multi_item') && child && !(duplicate && args.includes('no_duplicate'))) {
          if (!registeredChild) {
            const key = `event_sub_${parent.uid}_${child.uid}_${child.nid}`;
            game.actionLog.doAction(new RegisterItemTreeAction(game.items, child, key));
          }
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
          // Python matches the child by uid first, then nid, and unequips a
          // unit-owned child before removing it.
          const childId = args[2];
          const byUid = childId ? parent.subitems.find((child) => String(child.uid) === String(childId)) : undefined;
          const byNid = childId && !byUid ? parent.subitems.find((child) => child.nid === childId) : undefined;
          const children = childId
            ? [byUid ?? byNid].filter((child): child is ItemObject => !!child)
            : [...parent.subitems];
          const owner = (args[0] ?? '').toLowerCase() === 'convoy' ? undefined : this.findUnit(args[0] ?? '');
          for (const child of children) {
            if (owner) game.actionLog.doAction(new UnequipItemAction(owner, child));
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
          game.actionLog.doAction(new SetItemDroppableAction(item, parseEventBool(value) ?? false));
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
            this.banner = new Banner(`${colored(item.name)} broke.`, itemIcon(item), 3000, { sound: 'ItemBreak' });
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
          const skill = new SkillObject(skillPrefab);
          const initiatorArg = args[2] && !['no_banner', 'persistent'].includes(args[2])
            ? args[2]
            : '';
          const initiator = initiatorArg ? this.findUnit(initiatorArg) : undefined;
          skill.initiatorNid = initiator?.nid ?? null;
          if (args.includes('persistent')) {
            skill.data.set('sourceNid', unit.nid);
            skill.data.set('sourceType', 'personal');
          }
          const beforeCount = unit.skills.filter((candidate: SkillObject) => candidate.nid === skillNid).length;
          game.actionLog.doAction(new AddSkillAction(unit, skill));
          const afterCount = unit.skills.filter((candidate: SkillObject) => candidate.nid === skillNid).length;
          gsAdded = afterCount > beforeCount || unit.skills.includes(skill);
        }
        if (gsBannerFlag && gsAdded && unit && skillPrefab && !this.skipMode) {
          this.banner = new Banner(`${colored(unit.name)} got ${colored(skillPrefab.name)}.`, skillIcon(skillPrefab), 3000, { sound: 'Item' });
          this.bannerIsAlert = true;
          return true;
        }
        this.advancePointer();
        return false;
      }

      case 'remove_skill': {
        const unitNid = args[0] ?? '';
        const skillId = args[1] ?? '';
        const unit = this.findUnit(unitNid);
        const rsBannerFlag = !args.includes('no_banner');
        let rsRemovedSkill: SkillObject | undefined;
        if (unit) {
          const countArg = args.slice(2).find(arg => /^-?\d+$/.test(arg));
          const count = countArg === undefined ? -1 : parseInt(countArg, 10);
          const uid = /^\d+$/.test(skillId) ? parseInt(skillId, 10) : null;
          const matches = unit.skills.filter((skill: SkillObject) =>
            uid !== null ? skill.uid === uid : skill.nid === skillId);
          const removals = uid !== null || count === 1
            ? matches.slice(0, 1)
            : count < 0
              ? matches
              : matches.slice(0, count);
          rsRemovedSkill = removals[0];
          for (const skill of removals) {
            game.actionLog.doAction(new RemoveSkillAction(unit, skill));
          }
        }
        if (rsBannerFlag && rsRemovedSkill && unit && !this.skipMode) {
          this.banner = new Banner(`${colored(unit.name)} lost ${colored(rsRemovedSkill.name)}.`, skillIcon(rsRemovedSkill), 3000, { sound: 'Item' });
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

      case 'heal': {
        const unitNid = args[0] ?? '';
        const amount = Math.trunc(Number(args[1] ?? 0));
        const unit = this.findUnit(unitNid);
        if (unit && Number.isFinite(amount)) {
          game.actionLog.doAction(new HealAction(unit, amount));
        }
        this.advancePointer();
        return false;
      }

      case 'change_global_level_cap': {
        const amount = Math.trunc(Number(args[0] ?? 0));
        if (Number.isFinite(amount)) {
          const current = Number(game.gameVars.get('_global_level_cap_bonus') ?? 0);
          game.actionLog.doAction(new SetGameVarAction(
            game.gameVars,
            '_global_level_cap_bonus',
            current + amount,
          ));
        }
        this.advancePointer();
        return false;
      }

      case 'change_unit_level_cap': {
        const unit = this.findUnit(args[0] ?? '');
        const amount = Math.trunc(Number(args[1] ?? 0));
        if (unit && Number.isFinite(amount)) {
          const current = Number(unit.fields.get('_level_cap_bonus') ?? 0);
          game.actionLog.doAction(new SetUnitFieldAction(
            unit,
            '_level_cap_bonus',
            current + amount,
          ));
        }
        this.advancePointer();
        return false;
      }

      case 'give_exp': {
        const unitNid = args[0] ?? '';
        const unit = this.findUnit(unitNid);
        const silent = args.some(arg => arg.toLowerCase().trim() === 'silent');
        if (unit && silent) {
          // Python event_functions.give_exp silent branch: clamp, cap at the
          // class max level, and level through autolevel_to so the unit
          // fires unit_level_up and learns skills, keeping its current HP.
          const klass = game.db.classes.get(unit.klass);
          const maxLevel = Number(klass?.max_level ?? 20);
          const autoPromote = (game.db.getConstant('auto_promote', false) ||
            unit.tags.includes('AutoPromote')) && (klass?.turns_into?.length ?? 0) > 0 &&
            !unit.tags.includes('NoAutoPromote');
          let exp = Math.max(-100, Math.min(100, parseInt(args[1], 10) || 0));
          const canGive = unit.level < maxLevel || exp < 0 || autoPromote;
          const cap = 100 * ((canGive ? maxLevel + 1 : maxLevel) - unit.level) - unit.exp;
          exp = Math.min(exp, cap);
          const oldExp = unit.exp;
          let queueMarker = -1;
          if (oldExp + exp >= 100) {
            if (canGive) {
              game.actionLog.doAction(new SetUnitExpAction(unit, (oldExp + exp) % 100));
              // AutoLevel refills HP (mana is untouched by the web action).
              const oldHp = unit.currentHp;
              queueMarker = this.autolevelUnitTo(unit, unit.level + 1, undefined, false, game);
              game.actionLog.doAction(new SetCurrentHpAction(unit, oldHp));
            }
          } else if (oldExp + exp < 0) {
            if (unit.level > 1) {
              game.actionLog.doAction(new SetUnitExpAction(unit, 100 + oldExp + exp));
              queueMarker = this.autolevelUnitTo(unit, unit.level - 1, undefined, false, game);
            } else {
              game.actionLog.doAction(new SetUnitExpAction(unit, 0));
            }
          } else if (exp > 0) {
            if (canGive) game.actionLog.doAction(new SetUnitExpAction(unit, oldExp + exp));
          } else {
            game.actionLog.doAction(new SetUnitExpAction(unit, oldExp + exp));
          }
          this.advancePointer();
          return queueMarker >= 0 && this.runEventsQueuedSince(queueMarker, game);
        }
        if (unit) {
          game.actionLog.doAction(
            new GainExpAction(unit, parseInt(args[1], 10) || 0, game.currentMode?.growths ?? 'random'),
          );
        }
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
              this.banner = new Banner(gainWexpText(unit.name, rankUp.rank), weaponIcon(game.db, weaponType), 3000, { sound: 'Item' });
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
              this.banner = new Banner(gainWexpText(unit.name, rankUp.rank), weaponIcon(game.db, weaponType), 3000, { sound: 'Item' });
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
          // Python ChangeTeam reloads the sprite so the unit takes its new
          // team's palette.
          this.loadMapSpriteForUnit(unit, game);
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
        // Python AddTag is an action, so the turnwheel rewinds it.
        if (unit && tag) game.actionLog.doAction(new AddTagAction(unit, tag));
        this.advancePointer();
        return false;
      }

      case 'remove_tag': {
        const unitNid = args[0] ?? '';
        const tag = args[1] ?? '';
        const unit = this.findUnit(unitNid);
        if (unit && tag) game.actionLog.doAction(new RemoveTagAction(unit, tag));
        this.advancePointer();
        return false;
      }

      // ----- Game variable commands (instant) -----

      case 'game_var':
      case 'set_game_var': {
        const varName = args[0] ?? '';
        const value = this.evaluateVariableCommand(
          rawArgs[1] ?? 'True',
          args[1] ?? 'True',
        );
        if (!isPrimitiveOrPrimitiveCollection(value)) {
          // Python rejects units/items and keeps the previous value.
          console.warn(`game_var: ${args[1]} is not a valid variable`);
        } else if (varName && game.gameVars) {
          game.actionLog.doAction(new SetGameVarAction(game.gameVars, varName, value));
        }
        this.advancePointer();
        return false;
      }

      case 'inc_game_var': {
        const varName = args[0] ?? '';
        if (varName && game.gameVars) {
          const current = Number(game.gameVars.get(varName) ?? 0);
          const increment = args[1] === undefined
            ? 1
            : Number(this.evaluateVariableExpression(args[1]));
          game.actionLog.doAction(new SetGameVarAction(
            game.gameVars,
            varName,
            current + (Number.isFinite(increment) ? increment : 0),
          ));
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
        const value = this.evaluateVariableCommand(
          rawArgs[1] ?? 'True',
          args[1] ?? 'True',
        );
        if (!isPrimitiveOrPrimitiveCollection(value)) {
          // Python rejects units/items and keeps the previous value.
          console.warn(`level_var: ${args[1]} is not a valid variable`);
        } else if (varName && game.levelVars) {
          game.actionLog.doAction(new SetLevelVarAction(game.levelVars, varName, value));
        }
        this.advancePointer();
        return false;
      }

      case 'inc_level_var': {
        const varName = args[0] ?? '';
        if (varName && game.levelVars) {
          const current = Number(game.levelVars.get(varName) ?? 0);
          const increment = args[1] === undefined
            ? 1
            : Number(this.evaluateVariableExpression(args[1]));
          game.actionLog.doAction(new SetLevelVarAction(
            game.levelVars,
            varName,
            current + (Number.isFinite(increment) ? increment : 0),
          ));
        }
        this.advancePointer();
        return false;
      }

      // ----- Audio commands -----

      case 'music': {
        // Python event_functions.music: 'None' fades to pause, else fade_in
        // (fade 0 while the event is being skipped).
        const musicNid = args[0] ?? '';
        const parsedFade = args[1] !== undefined && args[1] !== '' && Number.isFinite(Number(args[1])) ? Number(args[1]) : 400;
        const fade = this.skipMode ? 0 : parsedFade;
        if (musicNid === 'None') {
          game.audioManager?.fadeToPause(fade);
        } else if (musicNid && game.audioManager) {
          void game.audioManager.playMusic(musicNid, fade);
        }
        // Python music() never blocks. (Advancing and then also waiting made
        // the wait's completion advance again, skipping the next command.)
        this.advancePointer();
        return false;
      }

      case 'change_music': {
        const phase = args[0] ?? '';
        const rawMusicNid = args[1] ?? '';
        const levelMusic = game.currentLevel?.music;
        if (phase && rawMusicNid && levelMusic) {
          game.actionLog.doAction(new ChangePhaseMusicAction(
            levelMusic,
            phase,
            rawMusicNid === 'None' ? null : rawMusicNid,
          ));
        }
        this.advancePointer();
        return false;
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
        // Python event_functions.music_fade_back(fade_out=400)
        if (game.audioManager) {
          const fade = args[0] !== undefined && args[0] !== '' && Number.isFinite(Number(args[0])) ? Number(args[0]) : 400;
          void game.audioManager.popMusic(fade);
        }
        this.advancePointer();
        return false;
      }

      case 'music_clear': {
        // Python event_functions.music_clear(fade_out=0): clear, or fade_clear when fading
        if (game.audioManager) {
          const fade = args[0] !== undefined && args[0] !== '' && Number.isFinite(Number(args[0])) ? Number(args[0]) : 0;
          game.audioManager.stopMusic(fade);
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
        const duration = parseInt(args[1] ?? '', 10);
        game.cursor?.setPos(resolved[0], resolved[1]);
        if (immediate) {
          if (cmd.type === 'center_cursor') {
            game.camera?.forceTile(resolved[0], resolved[1]);
          } else {
            game.camera?.forceTrackTile(resolved[0], resolved[1]);
          }
          this.advancePointer();
          return false;
        }
        if (Number.isFinite(duration) && duration > 0) {
          game.camera?.setPanDuration(duration);
        }
        if (cmd.type === 'center_cursor') {
          game.camera?.focusTile(resolved[0], resolved[1]);
        } else {
          game.camera?.trackTile(resolved[0], resolved[1]);
        }
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
        // give_money;Money;Party? with the no_banner flag anywhere (Python
        // :1984). `give_money;-300;no_banner` targets the current party.
        const gmArgs = parsePythonEventArgs(args, ['Money'], ['Party'], ['no_banner']);
        const amount = parseInt(gmArgs.value('Money') ?? '', 10) || 0;
        const moneyPartyNid = gmArgs.value('Party') || undefined;
        const gmBannerFlag = !gmArgs.flags.has('no_banner');
        const party = game.getParty(moneyPartyNid);
        if (party) {
          game.actionLog.doAction(new GainMoneyAction(amount, party.nid));
          game.actionLog.doAction(new UpdateRecordsAction('money', party.nid, amount));
          game.actionLog.doAction(
            new SetGameVarAction(game.gameVars, 'money', game.getMoney()),
          );
        }
        if (gmBannerFlag && !this.skipMode) {
          // Python banner.Advanced('Got <blue>N</> gold.', 'Item') / ('Lost ...', 'ItemBreak').
          const text = amount >= 0 ? `Got ${colored(String(amount))} gold.` : `Lost ${colored(String(-amount))} gold.`;
          this.banner = new Banner(text, null, 3000, { sound: amount >= 0 ? 'Item' : 'ItemBreak' });
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
          this.banner = new Banner(`Got ${colored(String(bexpAmount))} BEXP.`, null, 3000, { sound: 'Item' });
          this.bannerIsAlert = true;
          return true;
        }
        this.advancePointer();
        return false;
      }

      // ----- Convoy / Party commands -----

      case 'enable_convoy': {
        // enable_convoy;Activated (Python :691) sets the _convoy game var.
        game.actionLog.doAction(new SetGameVarAction(game.gameVars, '_convoy', parseEventBool(args[0] ?? 'true') ?? false));
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
        // end_turn;Team? (Python :723): with a team, skip phases until that
        // team is next; then end this event, forcibly clear every queued
        // event (Python event_state end_turn_flag), and change turns.
        const team = args[0];
        const fieldTeam = (nid: string) => [...game.units.values()].some((unit: UnitObject) =>
          unit.team === nid && !!unit.position && !unit.tags.includes('Tile'));
        if (team) {
          const teamExists = game.db.teams?.defs?.some((def: { nid: string }) => def.nid === team);
          if (!teamExists || !fieldTeam(team)) {
            console.warn(`end_turn: ${team} is not a valid team with units on the map`);
            this.advancePointer();
            return false;
          }
          for (let guard = 0; guard < 99 && game.phase.getNext(fieldTeam) !== team; guard += 1) {
            game.phase.next((nid: string) => game.board.getTeamUnits(nid));
          }
        }
        if (this.currentEvent) this.currentEvent.finish();
        if (game.eventManager) game.eventManager.eventQueue.length = 0;
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
        // equip_item;GlobalUnit;Item;[recursive] (Python :1594): nid or uid,
        // optionally inside multi-items; a multi-item equips its first
        // equippable child.
        const eqArgs = parsePythonEventArgs(args, ['GlobalUnit', 'Item'], [], ['recursive']);
        const unitNid2 = eqArgs.value('GlobalUnit') ?? '';
        const unit2 = this.findUnit(unitNid2);
        const item = unit2
          ? this.findInventoryItem(unitNid2, eqArgs.value('Item') ?? '', eqArgs.flags.has('recursive'))
          : undefined;
        if (unit2 && item) {
          if (item.hasComponent('multi_item')) {
            const child = item.subitems.find((subitem) => unit2.canEquip(subitem));
            if (child) game.actionLog.doAction(new EquipItemAction(unit2, child));
            else console.warn(`equip_item: no valid subitem to equip in ${item.nid}`);
          } else if (unit2.canEquip(item)) {
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
        const levelUpQueueLength = this.autolevelUnitTo(unit, finalLevel, growthMethod, hidden, game);
        this.advancePointer();
        // Python: a triggered UnitLevelUp pauses this event (after the skill
        // grants) so e.g. EOtF's Ability_Feat runs before it resumes.
        return levelUpQueueLength >= 0 && this.runEventsQueuedSince(levelUpQueueLength, game);
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
              isSilent ? 'exact' : undefined,
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
                ccIsSilent ? 'exact' : undefined,
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
        // choice;Nid;Title;Choices;RowWidth;Orientation;Alignment;BG;
        // EventNid;EntryType;Dimensions;TextAlign;flags — Python
        // event_commands.Choice. Optional arguments may be positional (in
        // that order) or `Key=Value`; bare words in _flags are flags.
        const choiceNid = args[0] ?? '_choice';
        const title = (args[1] ?? '').trim();
        const rawChoices = args[2] ?? '';
        const choiceFlagNames = new Set(['persist', 'expression', 'no_bg', 'no_cursor', 'arrows',
          'no_arrows', 'scroll_bar', 'no_scroll_bar', 'backable']);
        const optionalNames = ['rowwidth', 'orientation', 'alignment', 'bg', 'eventnid',
          'entrytype', 'dimensions', 'textalign'];
        const flags = new Set<string>();
        const keywords = new Map<string, string>();
        let positional = 0;
        for (const raw of args.slice(3)) {
          const entry = raw.trim();
          const lower = entry.toLowerCase();
          if (choiceFlagNames.has(lower)) {
            flags.add(lower);
            continue;
          }
          const eq = entry.indexOf('=');
          const key = eq > 0 ? entry.slice(0, eq).trim().toLowerCase() : '';
          if (eq > 0 && optionalNames.includes(key)) {
            keywords.set(key, entry.slice(eq + 1).trim());
            continue;
          }
          if (positional < optionalNames.length) {
            if (entry) keywords.set(optionalNames[positional], entry);
            positional += 1;
          }
        }

        // Choices is an EvaluableString: `expression` forces evaluation, but
        // authored menus also pass expressions such as `v('options')` without
        // the flag. Try evaluating and keep the result when it yields a list;
        // otherwise fall back to treating it as a literal comma list.
        let optionStrs: string[] | null = null;
        if (flags.has('expression') || /[([]/.test(rawChoices)) {
          try {
            const evaluated = evaluateExpression(rawChoices, this.buildConditionContext());
            if (Array.isArray(evaluated)) {
              optionStrs = evaluated.map((entry: unknown) => String(entry));
            } else if (flags.has('expression')) {
              optionStrs = String(evaluated ?? '').split(',');
            }
          } catch {
            // Fall through to the literal reading below.
          }
        }
        optionStrs ??= rawChoices.split(',');
        optionStrs = optionStrs
          .map((entry: string) => entry.trim())
          .filter((entry: string) => entry.length > 0);

        if (optionStrs.length > 0) {
          const entryType = (keywords.get('entrytype') ?? 'str').toLowerCase();
          const entries = optionStrs.map((entry: string) => {
            // `nid|display` hides an unreadable NID behind display text; the
            // stored result is always the NID half.
            const bar = entry.indexOf('|');
            const value = bar >= 0 ? entry.slice(0, bar).trim() : entry;
            const display = bar >= 0 ? entry.slice(bar + 1).replace(/\|/g, '').trim() : null;
            return this.buildChoiceEntry(value, display, entryType, game);
          });
          let size: [number, number] | null = null;
          const dims = keywords.get('dimensions');
          if (dims) {
            const [rows, cols] = dims.split(',').map((part: string) => parseInt(part.trim(), 10));
            if (Number.isFinite(rows) && Number.isFinite(cols)) size = [cols, rows];
          }
          const orientationRaw = (keywords.get('orientation') ?? 'vertical').toLowerCase();
          const orientation: 'vertical' | 'horizontal' =
            ['h', 'horiz', 'horizontal'].includes(orientationRaw) ? 'horizontal' : 'vertical';
          const alignRaw = (keywords.get('alignment') ?? 'center').trim();
          const alignPos = alignRaw.match(/^\s*(-?\d+)\s*,\s*(-?\d+)\s*$/);
          const alignment: string | [number, number] = alignPos
            ? [parseInt(alignPos[1], 10), parseInt(alignPos[2], 10)]
            : alignRaw.toLowerCase();
          const rowWidth = parseInt(keywords.get('rowwidth') ?? '', 10);
          const textAlignRaw = (keywords.get('textalign') ?? 'left').toLowerCase();
          this.choiceMenu = new EventChoiceMenu({
            entries,
            title: title || null,
            size,
            rowWidth: Number.isFinite(rowWidth) && rowWidth > 0 ? rowWidth : 0,
            alignment,
            orientation,
            bg: flags.has('no_bg') ? null : (keywords.get('bg') || 'menu_bg_base'),
            textAlign: textAlignRaw === 'center' || textAlignRaw === 'right' ? textAlignRaw : 'left',
            noCursor: flags.has('no_cursor'),
            screenWidth: viewport.width,
            screenHeight: viewport.height,
          });
          this.choiceNid = choiceNid;
          this.choiceBackable = flags.has('backable');
          this.choicePersist = flags.has('persist');
          const remembered = this.choiceCursorMemory.get(choiceNid);
          if (remembered !== undefined) {
            this.choiceMenu.setCursor(remembered);
            this.choiceCursorMemory.delete(choiceNid);
          }
          // Python sets `<nid>_choice_hover` to the highlighted value every
          // frame; descriptions in EotF's hub menus read it.
          game.gameVars.set(`${choiceNid}_choice_hover`, this.choiceMenu.getCurrentOption()?.value ?? '');
          // `EventNid` runs an event on each selection, inheriting this
          // event's args. EotF's sortie relies on it: the sub-event is what
          // moves the chosen unit into the deploying party, so ignoring it
          // left the next level with an empty party and nothing to deploy.
          this.choiceEventNid = keywords.get('eventnid') ?? null;
          return true; // block until user picks
        }
        this.advancePointer();
        return false;
      }

      case 'unchoice': {
        const suspended = this.suspendedChoiceEvents.at(-1);
        if (suspended) suspended.replay = true;
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
        // Python optional keywords: String, TimeLeft, HideTime — positional
        // in that order or as Key=value — plus only_once/interrupt_move flags.
        const optionalNames = ['string', 'timeleft', 'hidetime'];
        const optional = new Map<string, string>();
        let onlyOnce = false;
        let interruptMove = false;
        let positional = 0;
        for (let i = 4; i < args.length; i++) {
          const raw = args[i].trim();
          const lowered = raw.toLowerCase();
          if (lowered === 'only_once') { onlyOnce = true; continue; }
          if (lowered === 'interrupt_move') { interruptMove = true; continue; }
          const named = raw.match(/^(String|TimeLeft|HideTime)=(.*)$/i);
          if (named) {
            optional.set(named[1].toLowerCase(), named[2].trim());
            continue;
          }
          if (positional < optionalNames.length) {
            optional.set(optionalNames[positional], raw);
          }
          positional += 1;
        }
        const subNid = optional.get('string') ?? '';
        const parsedTime = parseInt(optional.get('timeleft') ?? '', 10);
        const timeLeft: number | null = Number.isNaN(parsedTime) ? null : parsedTime;
        const hideTime = parseEventBool(optional.get('hidetime')) ?? false;

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
        const maOptionArgs = args.slice(2);
        const parsedSpeed = Number(maOptionArgs[0]);
        const hasSpeed = Number.isFinite(parsedSpeed) && maOptionArgs[0]?.trim() !== '';
        const maSpeed = hasSpeed && parsedSpeed > 0 ? parsedSpeed : 1;
        const maFlags = new Set(
          (hasSpeed ? maOptionArgs.slice(1) : maOptionArgs)
            .map(arg => arg.toLowerCase().trim()),
        );
        const maNoBlock = maFlags.has('no_block');
        const maPermanent = maFlags.has('permanent');
        const maOverlay = maFlags.has('overlay');

        const maPrefab = game.db?.mapAnimations?.get(maAnimNid);
        if (!maPrefab) {
          console.warn(`map_anim: animation "${maAnimNid}" not found`);
          this.advancePointer();
          return false;
        }

        // Parse position
        let maPosition: [number, number] | null = null;
        const maPosMatch = maPosArg.match(/\(?(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)\)?/);
        if (maPosMatch) {
          maPosition = [parseFloat(maPosMatch[1]), parseFloat(maPosMatch[2])];
        } else {
          maPosition = this.resolvePosition(maPosArg, game);
        }
        if (!maPosition) {
          console.warn(`map_anim: position "${maPosArg}" not found`);
          this.advancePointer();
          return false;
        }

        // Create animation
        const mapAnim = new MapAnimation(maPrefab, maPosition[0], maPosition[1], {
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
        if (game.tilemap && maPermanent) {
          game.actionLog.doAction(new AddMapAnimationAction(game.tilemap, mapAnim, maOverlay));
        } else if (game.tilemap && maOverlay) {
          game.tilemap.highAnimations.push(mapAnim);
        } else if (game.tilemap) {
          game.tilemap.animations.push(mapAnim);
        }

        if (maNoBlock || maPermanent) {
          this.advancePointer();
          return false;
        }
        // Block for the animation duration; the wait's completion advances.
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
          // Python swaps the tilemap synchronously. The web load is async, so
          // hold the event (not via the frame wait timer, which would expire
          // and advance early) until the board exists, then continue.
          this.asyncCommandPending = true;
          game.changeTilemap(tmNid).finally(() => {
            this.asyncCommandPending = false;
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
        const layer = game.tilemap?.layers.find((candidate: any) => candidate.nid === layerNid);
        if (game.tilemap && layer && !layer.visible) {
          game.actionLog.doAction(new ShowLayerAction(
            game.tilemap,
            game.board,
            layerNid,
            transition,
          ));
        }
        this.advancePointer();
        return false;
      }

      case 'hide_layer': {
        // hide_layer;Layer[;LayerTransition] -- LayerTransition: 'fade' (default) or 'immediate'
        const layerNid2 = args[0] ?? '';
        const transition2 = args[1] === 'immediate' ? 'immediate' : 'fade';
        const layer2 = game.tilemap?.layers.find((candidate: any) => candidate.nid === layerNid2);
        if (game.tilemap && layer2?.visible) {
          game.actionLog.doAction(new HideLayerAction(
            game.tilemap,
            game.board,
            layerNid2,
            transition2,
          ));
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
        // for;varName;Expression — LT accepts Python list/range
        // comprehensions in addition to comma-delimited shorthand.
        const forVar = args[0] ?? '_i';
        const typedForExpression = args[1] ?? '';
        let forValues: unknown[] = [];
        if (typedForExpression.trim().startsWith('[') ||
            typedForExpression.includes(' for ') ||
            typedForExpression.startsWith('range') ||
            typedForExpression.includes('(')) {
          const evaluated = evaluateExpression(typedForExpression, this.buildConditionContext());
          if (Array.isArray(evaluated)) forValues = evaluated;
          else if (evaluated && typeof evaluated[Symbol.iterator] === 'function') {
            forValues = Array.from(evaluated);
          }
        } else {
          forValues = (args[1] ?? '').split(',')
            .map((value: string) => value.trim())
            .filter((value: string) => value.length > 0);
        }
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
        // Push loop context and publish the first value as an event local.
        // Authored EOtF loops intentionally reuse level-variable names
        // (`rooms`), so storing iterators in gameVars breaks shadowing.
        const localArgs = this.currentEvent!.trigger.localArgs ??= new Map();
        this.forLoopStack.push({
          varName: forVar,
          values: forValues,
          currentIndex: 0,
          startPointer: this.currentEvent!.commandPointer + 1,
          hadLocal: localArgs.has(forVar),
          oldLocal: localArgs.get(forVar),
        });
        localArgs.set(forVar, forValues[0]);
        this.advancePointer();
        return false;
      }

      case 'endf': {
        const loopCtx = this.forLoopStack[this.forLoopStack.length - 1];
        if (loopCtx) {
          loopCtx.currentIndex++;
          const localArgs = this.currentEvent!.trigger.localArgs ??= new Map();
          if (loopCtx.currentIndex < loopCtx.values.length) {
            // Set next value and jump back to loop start
            localArgs.set(loopCtx.varName, loopCtx.values[loopCtx.currentIndex]);
            this.currentEvent!.commandPointer = loopCtx.startPointer;
            return false;
          } else {
            // Loop complete — restore any shadowed outer local.
            if (loopCtx.hadLocal) localArgs.set(loopCtx.varName, loopCtx.oldLocal);
            else localArgs.delete(loopCtx.varName);
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
        if (blocks) this.blockingPortraitLoads++;
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
          if (blocks) this.blockingPortraitLoads--;
          if (blocks) {
            this.waiting = true;
            this.waitTimer = (14 * FRAMETIME) / speedMult + 33;
          }
        }).catch(() => {
          console.warn(`EventState: failed to load portrait "${resolvedNid}"`);
          this.pendingPortraitLoads--;
          if (blocks) this.blockingPortraitLoads--;
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
          this.blockingPortraitLoads++;
          game.resources.loadPortrait(resolvedNid).then((image: HTMLImageElement) => {
            const portrait = new EventPortrait(
              image, blinkOffset, smileOffset, pos, priority, pNid,
              { transition: true, mirror: autoMirror },
            );
            this.portraits.set(pNid, portrait);
            this.pendingPortraitLoads--;
            this.blockingPortraitLoads--;
          }).catch(() => {
            console.warn(`EventState: failed to load portrait "${resolvedNid}"`);
            this.pendingPortraitLoads--;
            this.blockingPortraitLoads--;
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

          const resourcePromise = game.resources?.loadPanorama(panoramaNid);
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
        this.chapterTitlePhase = 'begin';
        this.chapterTitleTimer = 0;
        this.chapterTitleSigilFade = 0;
        this.chapterTitleBannerX = 0;
        this.chapterTitleBannerY = 6;
        this.chapterTitleBannerFade = 0;
        this.chapterTitleBgCounter = 0;
        for (const nid of ['chapter_title_bg', 'chapter_title_ribbon', 'chapter_title_banner',
          'chapter_title_sigil', 'chapter_title_sigil2']) getMenuSprite(nid);

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
          if (unitHasCanto(hvUnit, null, game)) {
            game.actionLog.doAction(new SetMovementLeftAction(
              hvUnit,
              cantoMovement(hvUnit, null, game),
            ));
          } else {
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
        // Python unlock = find_unlock + spend_unlock: a Locktouch-style skill
        // opens the region for free; otherwise the unlocking item is one
        // that is available and whose can_unlock condition accepts this
        // region (chest keys only open chests). Spending procs its uses and
        // breaks it at zero; the unit cannot die from it.
        // Deviation: with several valid player items Python opens an item
        // choice (unlock_select); the web uses the first.
        const unlockUnit = this.findUnit(args[0]?.trim() ?? '');
        const region = this.currentEvent?.trigger?.region ?? null;
        if (cmd.type !== 'spend_unlock') game.memory.delete('unlock_item');
        if (unlockUnit && cmd.type !== 'spend_unlock') {
          if (!region) {
            console.warn('find_unlock: can only find_unlock within a region event');
          } else if (!skillCanUnlock(unlockUnit, region, game)) {
            const allItems: ItemObject[] = [];
            const walk = (items: ItemObject[]) => {
              for (const item of items) {
                allItems.push(item);
                walk(item.subitems ?? []);
              }
            };
            walk(unlockUnit.items);
            const valid = allItems.find((item) =>
              itemAvailable(unlockUnit, item, game.db, game) && itemCanUnlock(unlockUnit, item, region, game));
            if (valid) game.memory.set('unlock_item', valid);
          }
        }
        if (unlockUnit && cmd.type !== 'find_unlock') {
          const chosen = game.memory.get('unlock_item') as ItemObject | undefined;
          game.memory.delete('unlock_item');
          if (chosen && (chosen.hasComponent('uses') || chosen.hasComponent('c_uses'))) {
            const owner = chosen.owner ?? unlockUnit;
            game.actionLog.doAction(new WeaponUsesAction(chosen, owner));
          }
        }
        this.advancePointer();
        return false;
      }

      // ----- Interact Unit (scripted combat) -----
      case 'interact_unit': {
        // interact_unit;Unit;Position;CombatScript?;Ability?;Rounds? with
        // Python's flags (arena, force_animation, force_no_animation,
        // immediate) anywhere and Keyword=value arguments, e.g. EOtF's
        // `interact_unit;{charging_ally};{unit2};Ability=Flag_of_Hope`.
        const iuArgs = parsePythonEventArgs(
          args,
          ['Unit', 'Position'],
          ['CombatScript', 'Ability', 'Rounds'],
          ['arena', 'force_animation', 'force_no_animation', 'immediate', 'no_warn'],
        );
        const iuAttackerNid = iuArgs.value('Unit') ?? '';
        const iuTargetArg = iuArgs.value('Position') ?? '';
        const iuScriptStr = iuArgs.value('CombatScript') ?? '';
        const iuAbilityNid = iuArgs.value('Ability') ?? '';
        const iuImmediate = iuArgs.flags.has('immediate');

        const iuAttacker = this.findUnit(iuAttackerNid) ?? null;
        if (!iuAttacker || !iuAttacker.position) {
          console.warn(`interact_unit: attacker "${iuAttackerNid}" not found`);
          this.advancePointer();
          return false;
        }
        // Python _parse_pos: a unit, region, "x,y", or a bracketed tuple.
        const iuTargetPos = this.resolvePosition(iuTargetArg, game);
        if (!iuTargetPos) {
          console.warn(`interact_unit: target "${iuTargetArg}" not found`);
          this.advancePointer();
          return false;
        }

        const iuScript = iuScriptStr
          ? iuScriptStr.split(',').map((t: string) => t.trim().toLowerCase())
          : null;

        // Python: an Ability already carried (including multi-item
        // children) is used as is; otherwise a temporary item is created
        // and registered for this combat only, never added to inventory.
        let iuAbilityItem: ItemObject | null = null;
        if (iuAbilityNid) {
          const carried = (items: ItemObject[]): ItemObject | undefined => {
            for (const candidate of items) {
              if (candidate.nid === iuAbilityNid) return candidate;
              const nested = carried(candidate.subitems ?? []);
              if (nested) return nested;
            }
            return undefined;
          };
          let abilityItem = carried(iuAttacker.items) ?? null;
          if (!abilityItem) {
            const itemPrefab = game.db.items?.get(iuAbilityNid);
            if (!itemPrefab) {
              console.warn(`interact_unit: couldn't find item "${iuAbilityNid}"`);
              this.advancePointer();
              return false;
            }
            abilityItem = createItemTree(itemPrefab, (nid) => game.db.items.get(nid));
            abilityItem.owner = iuAttacker;
            game.actionLog.doAction(new RegisterItemTreeAction(
              game.items,
              abilityItem,
              `interact_${abilityItem.uid}_${abilityItem.nid}`,
            ));
          }
          iuAbilityItem = abilityItem;
        }

        // Resolve who is struck at the target position, including area
        // abilities aimed at an empty tile or the user's own tile.
        const iuItemForTargeting = iuAbilityItem ?? getEquippedWeapon(iuAttacker, game.db, game) ?? null;
        let iuDefender: UnitObject | null = game.board?.getUnit(iuTargetPos[0], iuTargetPos[1]) ?? null;
        if (iuItemForTargeting && game.targetSystem) {
          const resolved = game.targetSystem.getTargetFromPosition(iuAttacker, iuItemForTargeting, iuTargetPos);
          const struck = [resolved.mainTarget, ...resolved.splash]
            .filter((position: [number, number] | null): position is [number, number] => !!position)
            .map((position: [number, number]) => game.board.getUnit(position[0], position[1]))
            .filter((unit: UnitObject | null): unit is UnitObject => !!unit);
          if (!iuDefender || (iuDefender === iuAttacker && struck.some((unit: UnitObject) => unit !== iuAttacker))) {
            iuDefender = struck.find((unit: UnitObject) => unit !== iuAttacker) ?? struck[0] ?? iuDefender;
          }
        }
        if (!iuDefender) {
          console.warn(`interact_unit: nobody to strike at "${iuTargetArg}"`);
          this.advancePointer();
          return false;
        }
        game.memory.set('combat_target_position', [iuTargetPos[0], iuTargetPos[1]]);
        if (iuArgs.flags.has('force_no_animation')) game.memory.set('combat_force_no_animation', true);

        // Set up combat through CombatState
        game.selectedUnit = iuAttacker;
        game.combatTarget = iuDefender;
        game.combatScript = iuScript;
        game.eventCombat = true;  // Flag so CombatState doesn't double-push EventState
        if (iuAbilityItem) game.memory.set('combat_item', iuAbilityItem);

        if (iuImmediate) {
          // Immediate mode: resolve combat without visual animation
          const attackItem = iuAbilityItem ?? iuAttacker.items.find((i: ItemObject) => i.isWeapon());
          if (attackItem) {
            const targetGroup = resolveCombatTargetGroup(game, iuAttacker, attackItem, iuDefender);
            const grouped = !targetGroup.mainDefender || targetGroup.splashDefenders.length > 0;
            const defItem = targetGroup.mainDefender
              ? targetGroup.mainDefender.items.find((i: ItemObject) => i.isWeapon()) ?? null
              : null;
            if (targetGroup.mainDefender) {
              queueCombatSkillStartEvents(
                game, iuAttacker, targetGroup.mainDefender, attackItem, defItem,
              );
            }
            applyCombatParticipantItemStartHooks(
              game,
              iuAttacker,
              attackItem,
              [
                ...(targetGroup.mainDefender ? [targetGroup.mainDefender] : []),
                ...targetGroup.splashDefenders,
              ],
            );
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
            queueCombatItemBreakEvents(game, mc.strikes);
            applyCombatItemEndHooks(game, mc.strikes);
            queueCombatSkillEvents(
              game, mc.strikes, mc.attacker, mc.defender, attackItem, defItem,
            );
            applyCombatSkillEndHooks(
              game, mc.strikes, mc.attacker, mc.defender, mc.procPlayback,
            );
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
          game.memory.delete('combat_target_position');
          game.memory.delete('combat_force_no_animation');
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
        const luTeamArg = args[1] ?? '';
        const luHasExplicitTeam = game.db?.teams?.defs?.some(
          (team: { nid: string }) => team.nid === luTeamArg,
        ) ?? false;
        const luTeam = luHasExplicitTeam ? luTeamArg : 'player';
        const luAi = luHasExplicitTeam ? (args[2] || 'None') : 'None';
        const luNoWarn = args.some((arg) => arg.toLowerCase() === 'no_warn');
        if (game.units.has(luNid)) {
          if (!luNoWarn) console.warn(`load_unit: Unit "${luNid}" already exists`);
          this.advancePointer();
          return false;
        }
        const luPrefab = game.db?.units?.get(luNid);
        if (!luPrefab) {
          console.warn(`load_unit: Unit prefab "${luNid}" not found in db`);
          this.advancePointer();
          return false;
        }
        const luUnit = game.buildUnit(luPrefab, luTeam, luAi);
        luUnit.party = game.currentParty;
        game.actionLog.doAction(new CreateUnitAction(game, luUnit, null));
        this.loadMapSpriteForUnit(luUnit, game);
        this.advancePointer();
        return false;
      }

      case 'make_generic': {
        // make_generic;NID;Klass;Level;Team;AI;Faction;AnimVariant;ItemList
        let mgNid = args[0] ?? '';
        const assignCreatedUnit = mgNid.length === 0;
        const mgKlass = args[1] ?? '';
        const mgLevel = parseInt(args[2], 10) || 1;
        const mgTeam = args[3] || 'player';
        const mgAi = args[4] || 'None';
        // args[5] = faction (ignored for now)
        const mgFlags = new Set(['no_warn']);
        const mgVariant = args[6] && !mgFlags.has(args[6].toLowerCase())
          ? args[6]
          : '';
        const mgItemStr = args[7] && !mgFlags.has(args[7].toLowerCase())
          ? args[7]
          : '';
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
          // Python: a blank faction defaults to the first faction.
          faction: args[5] || ((game.db.factions?.values?.().next?.().value as any)?.nid ?? ''),
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
          if (game.currentParty) mgUnit.party = game.currentParty;
          game.actionLog.doAction(new CreateUnitAction(game, mgUnit, null));
          this.loadMapSpriteForUnit(mgUnit, game);
          if (assignCreatedUnit && this.currentEvent) {
            this.currentEvent.trigger.localArgs ??= new Map<string, any>();
            this.currentEvent.trigger.localArgs.set('created_unit', mgUnit.nid);
          }
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
        // Python ShopState shows stock columns only when a stock list is given.
        game.shopStock = shopStockStr ? shopStock : null;
        game.shopId = shopId || null;
        game.shopFlavor = args[2] || null;
        game.shopPreview = shopPreview;

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
        // Python event_functions.prep: PickUnitsEnabled (Bool, default
        // False), Music, OtherOptions (StringList), OtherOptionsEnabled
        // (BoolList), OtherOptionsOnSelect (StringList), descriptions.
        const prepBool = (value: string | undefined) =>
          ['t', 'true', '1', 'y', 'yes'].includes(String(value ?? '').trim().toLowerCase());
        const prepList = (value: string | undefined) =>
          value ? value.split(',').map((entry) => entry.trim()) : [];
        const pickEnabled = prepBool(args[0]);
        game.actionLog.doAction(new SetLevelVarAction(game.levelVars, '_prep_pick', pickEnabled));

        if (args[1]) {
          game.actionLog.doAction(new SetGameVarAction(game.gameVars, '_prep_music', args[1]));
          void game.audioManager.playMusic(args[1]);
        }
        const otherOptions = prepList(args[2]).filter(Boolean);
        if (otherOptions.length) {
          const enabled = prepList(args[3]).map(prepBool);
          while (enabled.length < otherOptions.length) enabled.push(false);
          const onSelect: (string | null)[] = prepList(args[4]).map((entry) => entry || null);
          while (onSelect.length < otherOptions.length) onSelect.push(null);
          const descs = prepList(args[5]);
          while (descs.length < otherOptions.length) descs.push('');
          game.actionLog.doAction(new SetGameVarAction(game.gameVars, '_prep_options_enabled', enabled.slice(0, otherOptions.length)));
          game.actionLog.doAction(new SetGameVarAction(game.gameVars, '_prep_options_events', onSelect.slice(0, otherOptions.length)));
          game.actionLog.doAction(new SetGameVarAction(game.gameVars, '_prep_additional_options', otherOptions));
          game.actionLog.doAction(new SetGameVarAction(game.gameVars, '_prep_options_info_descs', descs.slice(0, otherOptions.length)));
        } else {
          game.actionLog.doAction(new SetGameVarAction(game.gameVars, '_prep_options_enabled', []));
          game.actionLog.doAction(new SetGameVarAction(game.gameVars, '_prep_options_events', []));
          game.actionLog.doAction(new SetGameVarAction(game.gameVars, '_prep_options_info_descs', []));
          game.actionLog.doAction(new SetGameVarAction(game.gameVars, '_prep_additional_options', []));
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
        // Python event_functions.base: OtherOptions / OtherOptionsEnabled /
        // OtherOptionsOnSelect (enabled defaults to True).
        const baseList = (value: string | undefined) =>
          value ? value.split(',').map((entry) => entry.trim()) : [];
        const baseOptions = baseList(args[2]).filter(Boolean);
        if (baseOptions.length) {
          const enabled = baseList(args[3]).map((v) => !['f', 'false', '0', 'n', 'no'].includes(v.toLowerCase()));
          while (enabled.length < baseOptions.length) enabled.push(true);
          const onSelect: (string | null)[] = baseList(args[4]).map((v) => v || null);
          while (onSelect.length < baseOptions.length) onSelect.push(null);
          game.actionLog.doAction(new SetGameVarAction(game.gameVars, '_base_options_disabled', enabled.slice(0, baseOptions.length).map((b) => !b)));
          game.actionLog.doAction(new SetGameVarAction(game.gameVars, '_base_options_events', onSelect.slice(0, baseOptions.length)));
          game.actionLog.doAction(new SetGameVarAction(game.gameVars, '_base_additional_options', baseOptions));
        } else {
          game.actionLog.doAction(new SetGameVarAction(game.gameVars, '_base_options_disabled', []));
          game.actionLog.doAction(new SetGameVarAction(game.gameVars, '_base_options_events', []));
          game.actionLog.doAction(new SetGameVarAction(game.gameVars, '_base_additional_options', []));
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

      case 'credits': {
        const flagNames = new Set(['wait', 'center', 'no_split']);
        const flags = new Set(
          args
            .slice(2)
            .map((arg) => arg.toLowerCase().trim())
            .filter((arg) => flagNames.has(arg)),
        );
        const title = args[0] ?? '';
        const rawCredits = args[1] ?? '';
        const sourceLines = flags.has('no_split') ? [rawCredits] : rawCredits.split(',');
        const center = flags.has('center');
        // Python dialog.Credits.make_surf: line_wrap in the 'credit' font to
        // WINWIDTH - 12 (centered) or WINWIDTH - 88 (indented at x = 88).
        const lines: string[] = [];
        for (const source of sourceLines) {
          lines.push(...lineWrap('credit', source, center ? WINWIDTH - 12 : WINWIDTH - 88));
        }
        const lineCount = lines.length;
        const creditH = FONT['credit']?.height ?? 16;
        const titleH = FONT['credit_title']?.height ?? 8;
        const pauseMs = (lineCount + 1) * 1000;
        this.creditCards.push({
          title,
          lines,
          center,
          waitAtCenter: flags.has('wait'),
          elapsedMs: 0,
          pauseMs,
          height: titleH + lineCount * creditH,
        });
        this.waiting = true;
        this.waitTimer = (lineCount + 2) * creditH * 50 +
          (flags.has('wait') ? pauseMs * 2.1 : 0);
        return true;
      }

      case 'credit': {
        this.advancePointer();
        game.state.change('credit');
        return true; // Block until credits close
      }

      // ----- Support system event commands -----

      case 'enable_supports': {
        // enable_supports;Activated (Python :697) sets the _supports game var.
        game.actionLog.doAction(new SetGameVarAction(game.gameVars, '_supports', parseEventBool(args[0] ?? 'true') ?? false));
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
        const activated = parseEventBool(args[0] ?? 'true') ?? false;
        game.actionLog.doAction(new SetGameVarAction(game.gameVars, '_turnwheel', activated));
        this.advancePointer();
        return false;
      }

      case 'activate_turnwheel': {
        // activate_turnwheel;force
        // Opens the turnwheel UI. If 'force' is specified, the player
        // must use the turnwheel (cannot cancel).
        const force = parseEventBool(args[0] ?? 'true') ?? false;
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
        void game.resources.loadNamedSprite(spriteNid)
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

      case 'table': {
        // table;NID;TableData;Title;Dimensions;RowWidth;Alignment;BG;
        // EntryType;TextAlign;flags (Python event_commands.Table). Optional
        // arguments may be positional or `Key=Value`.
        const flagNames = new Set(['expression', 'no_bg']);
        const optionalNames = ['tabledata', 'title', 'dimensions', 'rowwidth', 'alignment',
          'bg', 'entrytype', 'textalign'];
        const parseTableArgs = (list: string[]): { nid: string; kw: Map<string, string>; flags: Set<string> } => {
          const kw = new Map<string, string>();
          const flags = new Set<string>();
          let position = 0;
          for (const entry of list.slice(1)) {
            const lower = entry.toLowerCase().trim();
            if (flagNames.has(lower)) {
              flags.add(lower);
              continue;
            }
            const eq = entry.indexOf('=');
            const key = eq > 0 ? entry.slice(0, eq).trim().toLowerCase() : '';
            if (eq > 0 && optionalNames.includes(key) && key !== 'tabledata') {
              kw.set(key, entry.slice(eq + 1).trim());
              continue;
            }
            if (position < optionalNames.length) {
              if (entry.trim() || optionalNames[position] === 'tabledata') kw.set(optionalNames[position], entry);
              position += 1;
            }
          }
          return { nid: (list[0] ?? '').trim(), kw, flags };
        };
        const parsed = parseTableArgs(args);
        const rawParsed = parseTableArgs(cmd.args ?? []);
        const nid = parsed.nid;
        if (!nid) {
          console.warn('table: missing table nid');
          this.advancePointer();
          return false;
        }
        if (this.eventTables.has(nid)) {
          console.warn(`table: duplicate table nid "${nid}"`);
          this.advancePointer();
          return false;
        }
        const dimensions = (parsed.kw.get('dimensions') ?? '').split(',').map(value => parseInt(value.trim(), 10));
        const rowWidth = parseInt(parsed.kw.get('rowwidth') ?? '', 10);
        this.eventTables.set(nid, {
          nid,
          data: parsed.kw.get('tabledata') ?? '',
          rawData: rawParsed.kw.get('tabledata') ?? parsed.kw.get('tabledata') ?? '',
          title: parsed.kw.get('title') || null,
          rows: Number.isFinite(dimensions[0]) ? Math.max(0, dimensions[0]) : 0,
          columns: Number.isFinite(dimensions[1]) ? Math.max(1, dimensions[1]) : 1,
          rowWidth: Number.isFinite(rowWidth) && rowWidth > 0 ? rowWidth : -1,
          alignment: parsed.kw.get('alignment') || 'top_left',
          background: parsed.kw.get('bg') || 'menu_bg_base',
          entryType: (parsed.kw.get('entrytype') || 'str').toLowerCase(),
          textAlignment: parsed.kw.get('textalign') || 'left',
          expression: parsed.flags.has('expression'),
          noBackground: parsed.flags.has('no_bg'),
        });
        this.advancePointer();
        return false;
      }

      case 'remove_table': {
        // LT has no separate remove_textbox: textboxes and tables share the
        // same removal command, keyed by NID.
        const removeNid = args[0] ?? '';
        this.eventTables.delete(removeNid);
        this.eventTextboxes.delete(removeNid);
        this.advancePointer();
        return false;
      }

      case 'textbox': {
        // textbox;NID;Text;BoxPosition;Width;NumLines;StyleNid;TextSpeed;
        // FontColor;FontType;BG;flags (Python event_commands.Textbox).
        const flagNames = new Set(['expression', 'from_python']);
        const isFlag = (arg: string): boolean => flagNames.has(arg.toLowerCase().trim());
        const flags = new Set(args.filter(isFlag).map((arg: string) => arg.toLowerCase().trim()));
        const positionalNames = ['nid', 'text', 'boxposition', 'width', 'numlines', 'stylenid',
          'textspeed', 'fontcolor', 'fonttype', 'bg'];
        const parseTextboxArgs = (list: string[]): Map<string, string> => {
          const out = new Map<string, string>();
          let index = 0;
          for (const entry of list) {
            if (isFlag(entry)) continue;
            const eq = entry.indexOf('=');
            const key = eq > 0 ? entry.slice(0, eq).trim().toLowerCase() : '';
            if (eq > 0 && positionalNames.includes(key) && index >= 2) {
              out.set(key, entry.slice(eq + 1));
            } else {
              if (index < positionalNames.length) out.set(positionalNames[index], entry);
              index += 1;
            }
          }
          return out;
        };
        const values = parseTextboxArgs(args);
        const rawValues = parseTextboxArgs(cmd.args ?? []);
        const nid = values.get('nid') ?? '';
        if (!nid) {
          console.warn('textbox: missing textbox nid');
          this.advancePointer();
          return false;
        }
        const width = parseInt(values.get('width') ?? '', 10);
        const numLines = parseInt(values.get('numlines') ?? '', 10);
        this.eventTextboxes.set(nid, {
          nid,
          text: values.get('text') ?? '',
          rawText: rawValues.get('text') ?? values.get('text') ?? '',
          alignment: (values.get('boxposition') || 'top_left').toLowerCase(),
          width: Number.isFinite(width) && width > 0 ? width : -1,
          numLines: Number.isFinite(numLines) && numLines > 0 ? numLines : 1,
          bg: (values.get('bg') || 'menu_bg_base').trim(),
          expression: flags.has('expression'),
        });
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
        // Python Bool validator: t/true/1/y/yes are true. EOtF writes `t`.
        const fogEnable = parseEventBool(args[0] ?? 'true') ?? false;
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
            game.actionLog.doAction(
              new UpdatePersistentStoreAction(
                RECORDS,
                () => RECORDS.create(nid, evaluateExpression(
                  value,
                  this.buildConditionContext(),
                )),
              ),
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
            game.actionLog.doAction(
              new UpdatePersistentStoreAction(
                RECORDS,
                () => RECORDS.update(nid, evaluateExpression(
                  value,
                  this.buildConditionContext(),
                )),
              ),
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
            game.actionLog.doAction(
              new UpdatePersistentStoreAction(
                RECORDS,
                () => RECORDS.replace(nid, evaluateExpression(
                  value,
                  this.buildConditionContext(),
                )),
              ),
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
                this.banner = new Banner(achievement.name, null, 2000);
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
        // skip_save;Bool (Python event_functions.skip_save) only records
        // the level var that tells the end-of-chapter save screen to skip
        // itself. It never writes a save; EOtF issues skip_save;t before
        // every win_game precisely so no save prompt (or save) happens.
        const skip = parseEventBool(args[0]) ?? false;
        game.actionLog.doAction(new SetLevelVarAction(game.levelVars, '_skip_save', skip));
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
  /**
   * Python TargetSystem.get_nearest_open_tile: rings of radius 0..9, each
   * scanned x = -r..r checking (x, +dy) before (x, -dy), accepting a tile the
   * unit can weakly traverse (mcost <= 5 or <= its movement) that is empty
   * (or holds the unit itself) and, when asked, that it can path to.
   */
  private nearestOpenTile(
    unit: UnitObject | null,
    position: [number, number],
    checkForValidPath: boolean,
    game: any,
  ): [number, number] | null {
    const board = game.board;
    if (!board) return null;
    const firstClass = game.db.classes.values().next().value;
    const klass = unit ? game.db.classes.get(unit.klass) : firstClass;
    const group = unit
      ? movementType(unit, klass?.movement_group ?? 'Infantry', game)
      : (firstClass?.movement_group ?? 'Infantry');
    const movement = unit ? unit.getMovement() : 0;
    const acceptable = (x: number, y: number): boolean => {
      if (!board.inBounds(x, y)) return false;
      const mcost = board.getMovementCost(x, y, group, game.db);
      if (!(mcost <= 5 || mcost <= movement)) return false;
      const occupant = board.getUnit(x, y);
      if (occupant && occupant !== unit) return false;
      if (checkForValidPath && unit?.position) {
        const path = game.pathSystem?.getPath(unit, x, y, board);
        if (!path) return false;
      }
      return true;
    };
    for (let r = 0; r < 10; r += 1) {
      for (let x = -r; x <= r; x += 1) {
        const magnitude = Math.abs(x);
        const n1: [number, number] = [position[0] + x, position[1] + r - magnitude];
        const n2: [number, number] = [position[0] + x, position[1] - r + magnitude];
        if (acceptable(n1[0], n1[1])) return n1;
        if (acceptable(n2[0], n2[1])) return n2;
      }
    }
    return null;
  }

  private _checkPlacement(
    position: [number, number],
    placement: string,
    game: any,
    unit: UnitObject | null = null,
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
      case 'closest':
        // Python get_closest_reachable_tile: nearest open tile the placed
        // unit can stand on (and reach, when it is already on the map).
        return this.nearestOpenTile(unit, position, true, game);
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
    void game.loadMapSpriteForUnit(unit).catch((err: any) => {
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
