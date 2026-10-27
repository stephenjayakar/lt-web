/**
 * game-states.ts - All game states for the Lex Talionis web engine.
 *
 * Each state class extends State or MapState and plugs into the
 * stack-based StateMachine.  A lazily-resolved `game` reference
 * provides access to the shared game context (camera, cursor, board,
 * units, tilemap, mapView, etc.) without creating circular imports.
 */

import { drawItemUseRolls } from '../../combat/item-use-rolls';
import type { SongObject } from '../../audio/music-controller';
import { State, MapState, type StateResult } from '../state';
import { isForkEngine } from '../engine-flavor';
import { canGiveExp, getEffectiveLevelCap } from '../leveling';
import { checkRegionInterrupt, interruptMovePath } from '../../movement/region-interrupt';
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
import { getSkillAbilityOptions, type SkillAbilityOption } from '../../combat/skill-abilities';
import { allAttackablePositions, attackablePositions } from '../target-system';
import { SkillObject } from '../../objects/skill';
import {
  evaluateCondition,
  evaluateConditionOr,
  evaluateExpression,
  evaluateExpressionOutcome,
  evaluateTextTag,
  GameEvent,
  pythonIterationValues,
  pythonLiteral,
  pythonStr,
  triggerFieldArgs,
  type ConditionContext,
  type EventCommand,
  type ExpressionOutcome,
} from '../../events/event-manager';
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
  IncrementTurnAction,
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
  AddTalkAction,
  RemoveTalkAction,
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
  ResetAction,
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
  AIGroupPingAction,
  RemoveMapAnimationAction,
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
import { DifficultyModeObject, rngOptionDisplay } from '../difficulty';
export { InfoMenuState, setInfoMenuGameRef } from './info-menu-state';
import { dexOptionUnit } from './dex-menu-state';
import { requestPromotion } from './promotion-state';
import { SelectionHelper } from '../selection-helper';
import { drawCarryPreview, drawTradePreview } from '../../ui/hud';
import { currentWindowSkin, getSprite, preloadSprites, skinnedSpriteNameFor, startupSkinnedSpriteName } from '../../ui/sprites';
import { roamVisualOffset } from '../../movement/roam-movement';
import { Banner, PhaseIn, acquiredItemText, colored, gainWexpText, itemIcon, skillIcon, stoleItemText, weaponIcon } from '../../ui/banner';
import { EVENT_COMMAND_FLAGS } from '../../events/event-command-flags';
import { getMenuBackgroundSync } from '../../ui/base-surf';
import { Pennant, MenuBackground, MenuScene, PanoramaFrames, loadPanoramaFrames, blitText as blitMenuText, blitTextCenter as blitMenuTextCenter, getSprite as getMenuSprite, lineWrap, textWidth as menuTextWidth, type SpriteImage } from '../../ui/menu-chrome';
import { ChapterSelectMenu, HorizontalChoice, ModeSelectMenu, TitleMainMenu, chapterSelectFromSlots, preloadTitleMenuSprites, titleBackgroundNid } from '../../ui/title-menu';
import { getSetting } from './settings-state';
import { EventChoiceMenu, type EventChoiceEntry } from '../../ui/event-choice';
import { HelpDialog, getLinkedHelpBoxes, itemHelpBox, type HelpBox } from '../../ui/help-menu';
import { Dialog } from '../../ui/dialog';
import { drawStyledText, measureStyledText } from '../../ui/styled-text';
import { ExpBar as ExpBarClass, LevelUpScreen as LevelUpScreenClass } from '../../ui/exp-display';
import { EventPortrait } from '../../events/event-portrait';
import { parseScreenPosition } from '../../events/screen-positions';
import { MapCombat, type CombatResults } from '../../combat/map-combat';
import type { CombatStrike } from '../../combat/combat-solver';
import {
  queueAfterInitiatedCombatEvents,
  queueCombatSkillEvents,
  queueCombatSkillStartEvents,
  applyCombatItemStartHooks,
  applyCombatItemEndHooks,
  queueCombatItemBreakEvents,
  queueDirectItemUseEvents,
  queueCombatItemEvents,
  queueCombatEndItemEvents,
  queueCombatEndSkillEvents,
  queueStrikeItemEvents,
  queueStrikeSkillEvents,
  applyDroppableItemPickups,
  applyStolenItemTransfer,
  combatTradePair,
  applyCombatSkillEndHooks,
  applyUnusableCombatItems,
  triggerAbilityItemCharge,
  triggerSkillCharge,
  playbackMarks,
} from '../../combat/combat-lifecycle';
import { internalLevel } from '../../combat/combat-components';
import {
  collectSkillTurnHooks,
  finishSkillTurnHooks,
  type CollectedSkillTurn,
} from '../skill-turn-lifecycle';
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
import type { FogRenderConfig, HighlightSource } from '../../rendering/map-view';
import type { HighlightLayer, HighlightManager } from '../../rendering/highlight';
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
  drawUnitTransitionOverlay,
  getTransitionPosition,
  getUnitFx,
  isUnitDying,
  markDying,
  offBoardTransitionUnits,
  setTransitionEnv,
  setUnitTransition,
  startDyingFade,
  DEFAULT_TRANSITION_TIME,
  type TransitionAnimSheet,
  type UnitTransitionState,
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
  allItemsWithMultiItems,
  bannerItemColor,
  computeTargetIcons,
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
  rangeRestrict as itemRangeRestrict,
  noAttackAfterMove as itemNoAttackAfterMove,
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
  modifiedHealAmount,
  unitSpriteTint,
  canUnlock as skillCanUnlock,
  unitHasTag,
  sourceAllowsPlainRemoval,
  changeAi,
  checkEnemy,
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
  setTransitionEnv({
    playSfx: (nid) => g?.audioManager?.playSfx?.(nid),
    anim: (nid) => transitionAnimSheet(g, nid),
    flowerSprite: () => getSprite('particle_warp_flower'),
  });
  preloadTransitionArt(g);
}

/**
 * Load the warp petal sprite and the Warp / Swoosh sheets as soon as a
 * project is known, so the first transition has them from its first frame.
 */
export function preloadTransitionArt(game: any): void {
  void preloadSprites(['particle_warp_flower']);
  transitionAnimSheet(game, 'Warp');
  transitionAnimSheet(game, 'Swoosh');
}

/** Whether the transition art (petals and both sheets) is ready (tests). */
export function transitionArtReady(): boolean {
  const ready = (nid: string) => {
    const sheet = transitionSheets.get(nid);
    return !!sheet && sheet !== 'loading';
  };
  return !!getSprite('particle_warp_flower') && ready('Warp') && ready('Swoosh');
}

const transitionSheets = new Map<string, TransitionAnimSheet | null | 'loading'>();

/** The project's Warp / Swoosh map animation sheet, loaded on first use. */
function transitionAnimSheet(game: any, nid: 'Warp' | 'Swoosh'): TransitionAnimSheet | null {
  const cached = transitionSheets.get(nid);
  if (cached === 'loading') return null;
  if (cached !== undefined) return cached;
  const prefab = game?.db?.mapAnimations?.get?.(nid);
  // Not cached: the project's animations may not be loaded yet.
  if (!prefab || !game?.resources?.loadImage) return null;
  transitionSheets.set(nid, 'loading');
  void game.resources.loadImage(`resources/animations/${nid}.png`).then((image: HTMLImageElement) => {
    transitionSheets.set(nid, {
      image,
      frameWidth: Math.floor(image.width / prefab.frame_x),
      frameHeight: Math.floor(image.height / prefab.frame_y),
      frameX: prefab.frame_x,
      numFrames: prefab.num_frames,
      speed: Number(prefab.speed) || 25,
    });
  }).catch(() => transitionSheets.set(nid, null));
  return null;
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

/**
 * Python PhaseController.next/get_next: a team's phase is skipped unless it
 * has a unit on the map without the Tile tag (walls and doors don't count).
 */
export function phaseTeamUnits(game: any, team: string): UnitObject[] {
  return (game.board?.getTeamUnits(team) ?? [])
    .filter((unit: UnitObject) => !unitHasTag(unit, 'Tile', game));
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

/** An evaluation's value, or `undefined` when it raised (already logged). */
function outcomeValue(outcome: ExpressionOutcome): any {
  return outcome.ok ? outcome.value : undefined;
}

/**
 * Choice and table rows as EOtF's engine builds them. With `expression` the
 * value is evaluated: a list gives its entries, any other value one row, and
 * an empty list or a failed evaluation one blank row. Without it, the
 * (already brace-evaluated) text is split on commas, keeping brackets and
 * empty entries. There is always at least one row.
 */
function forkChoiceRows(source: string, expression: boolean, context: () => any): string[] {
  if (expression) {
    const outcome = evaluateExpressionOutcome(source, context());
    if (!outcome.ok) return [''];
    const value = outcome.value;
    if (Array.isArray(value)) return value.length ? value.map((entry) => pythonStr(entry)) : [''];
    return [pythonStr(value)];
  }
  return source.split(',').map((entry) => entry.trim().replaceAll('{comma}', ','));
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

/** Python str_utils.get_next_int: `name` if unused, else the first free "1", "2", ... */
function nextIntNid(name: string, units: Map<string, unknown>): string {
  if (!units.has(name)) return name;
  let counter = 1;
  while (units.has(String(counter))) counter++;
  return String(counter);
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
  poseOverride: { state: 'standing' | 'moving' | 'active'; direction?: 'up' | 'down' | 'left' | 'right' } | null;
  overlay: ((surf: Surface, left: number, top: number, cameraX: number, cameraY: number) => void) | null;
}[] {
  const game = getGame();
  if (!game.board) return [];
  // Python map_view draws every unit with a sprite position: on the map, or
  // still on its fake tile while a departure transition plays.
  const allUnits: UnitObject[] = [...game.board.getAllUnits(), ...offBoardTransitionUnits()];
  const currentTeam = game.phase.getCurrent();
  const eventOnStack = !!game.state.getStackNames?.().includes('event');
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
    poseOverride: { state: 'standing' | 'moving' | 'active'; direction?: 'up' | 'down' | 'left' | 'right' } | null;
    overlay: ((surf: Surface, left: number, top: number, cameraX: number, cameraY: number) => void) | null;
  }[] = [];

  for (const u of allUnits) {
    const drawPosition = getTransitionPosition(u);
    if (!drawPosition) continue;
    // Python keeps an is_dying unit on the map until DeathManager's fade
    // ends; its HP already reached 0 when the combat results applied.
    if (u.isDead() && !isUnitDying(u)) continue;
    const unitFx = getUnitFx(u);

    // Update sprite state: gray for finished units on the active team only.
    // Units from other teams should never appear greyed out.
    // In initiative mode, non-current-initiative units appear greyed.
    // Only a unit the movement system is walking keeps 'moving'. Combat
    // poses set 'moving' on the sprite every drawn frame (poseOverride), so a
    // left-over 'moving' must not block the state update: it used to keep
    // every unit that had fought (player and AI alike) out of its gray image.
    if (u.sprite && typeof u.sprite === 'object' && 'state' in u.sprite) {
      const spr = u.sprite as { state: string };
      if (!game.movementSystem.isUnitMoving(u)) {
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
    if (unitHasTag(u, 'Boss')) specialTag = 'Boss';
    else if (unitHasTag(u, 'Elite')) specialTag = 'Elite';
    else if (unitHasTag(u, 'Protect')) specialTag = 'Protect';

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
      x: drawPosition[0],
      y: drawPosition[1],
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
        // UnitSprite.draw_hp: only with transition_state 'normal', and Python
        // map_view passes event=True (no bars) whenever an event is on the
        // stack (prep and other event-opened screens included).
        if (unitFx?.transitioning) return false;
        if (eventOnStack) return false;
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
        : (!u.finished && !game.movementSystem.isUnitMoving(u) ? chosenSpritePose(game, u) : null),
      overlay: (s, left, top, cameraX, cameraY) => drawUnitTransitionOverlay(s, u, left, top, cameraX, cameraY),
    });
  }
  return result;
}

/**
 * Python CombatState.draw passes AnimationCombat's viewbox to the map as
 * map_view.draw's subsurface cull: units are drawn only inside the iris, and
 * not at all once it has closed (width 0), so the map behind a battle scene
 * shows terrain only.
 */
let animationViewbox: [number, number, number, number] | null = null;

/** Whether a battle scene's viewbox currently culls the map's units. */
export function animationViewboxActive(): boolean {
  return animationViewbox !== null;
}

/**
 * Draw the map with Python's viewbox unit cull: `drawMapWith(units)` renders
 * the map with the given units. Outside a battle scene it is one call; with
 * a closed viewbox units are left out; while the viewbox iris is open the
 * unit-less map is drawn and the iris rectangle is copied from a second
 * render with units (map_view.draw_units' subsurface).
 */
export function blitMapWithViewbox<T>(surf: Surface, units: T[], drawMapWith: (units: T[]) => Surface): void {
  const viewbox = animationViewbox;
  if (!viewbox) {
    surf.blit(drawMapWith(units));
    return;
  }
  surf.blit(drawMapWith([]));
  if (viewbox[2] <= 0 || viewbox[3] <= 0) return;
  const withUnits = drawMapWith(units);
  surf.blitFrom(withUnits, viewbox[0], viewbox[1], viewbox[2], viewbox[3], viewbox[0], viewbox[1]);
}

/**
 * One frame's view of the HighlightManager for MapView. spriteLayers()
 * advances each layer's grow-in cut-off (Python HighlightController.draw),
 * so it is taken once per drawn map even when blitMapWithViewbox renders
 * the map twice.
 */
function frameHighlights(manager: HighlightManager): HighlightSource {
  let layers: HighlightLayer[] | null = null;
  return {
    updateIdx: manager.updateIdx,
    getHighlights: () => manager.getHighlights(),
    spriteLayers: () => (layers ??= manager.spriteLayers()),
  };
}

/** LevelCursor.get_hover's visibility test (fog of war). */
function inVisionForHover(game: any, pos: [number, number]): boolean {
  return game.board?.inVision?.(pos, 'player', game.getCurrentFogInfo?.(), game.db, game.getAllUnits?.()) ?? true;
}

/**
 * Python CombatTargetingState.display_single_attack: the item's whole range
 * from where the unit stands in the light colour, then the splash around the
 * cursor and the cursor tile itself in the full colour (green for spells,
 * red otherwise).
 */
function displaySingleAttack(game: any, unit: UnitObject, item: ItemObject, cursor: [number, number]): void {
  if (!unit.position) return;
  const spell = item.isSpell();
  game.highlight.clear();
  const range = allAttackablePositions(unit, [item], [[unit.position[0], unit.position[1]]], game.board, game);
  game.highlight.addHighlights(range, spell ? 'spell_splash' : 'splash');
  const splash: [number, number][] = game.targetSystem?.getTargetFromPosition?.(unit, item, cursor)?.splash ?? [];
  game.highlight.addHighlights(splash, spell ? 'spell' : 'attack');
  game.highlight.addHighlights([cursor], spell ? 'spell' : 'attack');
}

/** Python AIPrefab.guard_ai: no behaviour ever moves the unit. */
function aiNeverMoves(prefab: any): boolean {
  const behaviours: any[] = prefab?.behaviours ?? [];
  if (behaviours.every((b) => b.action === 'None')) return false;
  return behaviours.every((b) => b.action === 'None' || Number(b.view_range) === -1);
}

/**
 * Python HighlightController.display_highlights(unit, light=True), shown
 * while the cursor hovers a unit: light spell range, light attack range and
 * light move range (each later layer replacing the earlier on shared tiles).
 */
function displayHoverHighlights(game: any, unit: UnitObject): void {
  if (!unit.position || !game.pathSystem) return;
  let moves: [number, number][] = game.pathSystem.getValidMoves(unit, game.board, true);
  if (game.db.getConstant('zero_move', false)) {
    const ai = changeAi(unit, unit.ai, game);
    if (ai && !game.isAiGroupActive?.(unit.aiGroup) && aiNeverMoves(game.db.ai?.get?.(ai))) {
      moves = [[unit.position[0], unit.position[1]]];
    }
  }
  const usable = (item: ItemObject): boolean => itemAvailable(unit, item, game.db, game);
  const items: ItemObject[] = unit.items ?? [];
  game.highlight.addHighlights(allAttackablePositions(unit, items.filter((i) => i.isSpell() && usable(i)), moves, game.board, game), 'spell_splash');
  game.highlight.addHighlights(allAttackablePositions(unit, items.filter((i) => i.isWeapon() && usable(i)), moves, game.board, game), 'splash');
  game.highlight.addHighlights(moves, 'possible_move');
}

/** UnitSprite.change_state('selected' | 'chosen' | 'normal') for the acting unit. */
export function setSpritePose(unit: UnitObject | null | undefined, pose: 'selected' | 'chosen' | null): void {
  if (!unit) return;
  (unit as any).mapSpritePose = pose;
  if (pose !== 'chosen') (unit as any).chosenNet = null;
}

/**
 * Python UnitSprite.update_state for 'selected' (walking in place facing
 * down) and 'chosen' (walking in place facing the cursor, keeping the last
 * direction while the cursor sits on the unit).
 */
function chosenSpritePose(
  game: any, unit: UnitObject,
): { state: 'moving' | 'active'; direction?: 'up' | 'down' | 'left' | 'right' } | null {
  const pose = (unit as any).mapSpritePose;
  if (pose === 'selected') return { state: 'moving', direction: 'down' };
  if (!pose && unit.position && unit.team === 'player' && game.cursor.visible) {
    // 'normal' state: the player unit under the visible cursor shows its
    // active frames.
    const [hx, hy] = game.cursor.getPosition();
    if (hx === unit.position[0] && hy === unit.position[1]) return { state: 'active' };
  }
  if (pose !== 'chosen' || !unit.position) return null;
  const [cx, cy] = game.cursor.getPosition();
  const net: [number, number] = [cx - unit.position[0], cy - unit.position[1]];
  if (net[0] !== 0 || net[1] !== 0) (unit as any).chosenNet = net;
  const [dx, dy]: [number, number] = (unit as any).chosenNet ?? [0, 0];
  let direction: 'up' | 'down' | 'left' | 'right';
  if (Math.abs(dx) >= Math.abs(dy)) direction = dx > 0 ? 'right' : dx < 0 ? 'left' : 'down';
  else direction = dy < 0 ? 'up' : 'down';
  return { state: 'moving', direction };
}

/** Render the map through MapView and blit onto `surf`. */
function drawMap(surf: Surface, showHighlights: boolean = true): Surface {
  const game = getGame();
  if (!game.board || !game.tilemap) return surf; // No level loaded
  game.syncSkillMapAnimations();
  game.camera.update();
  // Python MapState.draw: game.highlight.update() once per drawn map.
  game.highlight.update();
  game.cursor.update();

  const cullRect = game.camera.getCullRect();
  const units = collectVisibleUnits();
  const viewbox = animationViewbox;
  // Python HighlightController sprites (the manager hands MapView its layers),
  // snapshotted once: an open battle iris draws the map twice per frame.
  const highlights = showHighlights ? frameHighlights(game.highlight) : null;

  const cursorInfo = {
    x: game.cursor.getHover().x,
    y: game.cursor.getHover().y,
    visible: game.cursor.visible,
    draw: (s: Surface, ox: number, oy: number) => {
      // Python get_image: the active frame over a visible, unfinished player unit.
      const hover = game.cursor.getHover();
      const unit: UnitObject | null = game.board.getUnit(hover.x, hover.y);
      const activeUnit = !!unit && unit.team === 'player' && !unit.finished && !unitHasTag(unit, 'Tile') &&
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

  blitMapWithViewbox(surf, units, (drawn) => game.mapView.draw(
    game.tilemap,
    cullRect,
    drawn,
    highlights,
    cursorInfo,
    false, // showGrid
    surf.scale,
    fogConfig,
    game.unitMarkers,
    performance.now(),
  ));
  if (!viewbox) drawUnitMarkers(surf);
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
export function drawUnitMarkers(surf: Surface): void {
  const game = getGame();
  const currentState: any = game.state.getCurrentState();
  const stateName: string = currentState?.name ?? '';
  let curUnit: UnitObject | null = null;
  if (stateName === 'free') {
    const [cx, cy] = game.cursor.getPosition();
    const hover: UnitObject | null = game.board.getUnit(cx, cy);
    if (hover && !unitHasTag(hover, 'Tile') &&
        game.board.inVision([cx, cy], 'player', game.getCurrentFogInfo?.(), game.db, game.getAllUnits())) {
      curUnit = hover;
    }
  } else if (MARKER_CUR_UNIT_STATES.has(stateName)) {
    curUnit = game.selectedUnit ?? null;
  } else if (stateName === 'free_roam') {
    curUnit = game.roamInfo?.roamUnitNid ? game.getUnit(game.roamInfo.roamUnitNid) ?? null : null;
  }
  if (!curUnit) return;
  // Free roam: an NPC whose talk points at the roam unit shows a talk marker
  // while a talk target is in range, and the roam unit itself shows the
  // interact marker while standing in a visitable region.
  const roamState = stateName === 'free_roam' && game.roamInfo?.roam ? currentState : null;
  const roamTalkInRange = !!roamState?.getClosestUnit?.(true);
  const roamVisit = !!roamState?.getVisitRegion?.();
  const now = getFrameCount() * FRAMETIME;
  const offset = [0, 0, 0, 1, 2, 2, 2, 1][Math.floor(now / 100) % 8];
  const [camX, camY] = game.camera.getOffset();
  const talkPairs: [string, string][] = game.eventManager?.getTalkPairs?.() ?? [];
  const hasTalk = (a: string, b: string) => talkPairs.some(([x, y]) => x === a && y === b) &&
    !game.eventManager?.isTalkHidden?.(a, b);
  const fogInfo = game.getCurrentFogInfo?.();
  for (const unit of game.units.values() as Iterable<UnitObject>) {
    if (!unit.position || unit.isDead()) continue;
    if (unit === curUnit && !roamState) continue;
    if (unit.team !== 'player' && !game.board.inVision(unit.position, 'player', fogInfo, game.db, game.getAllUnits())) continue;
    const markers: string[] = [];
    if (roamState && roamTalkInRange && hasTalk(unit.nid, curUnit.nid)) {
      markers.push('talk');
    } else if (hasTalk(curUnit.nid, unit.nid)) {
      markers.push('talk');
    }
    if (roamState && roamVisit && unit === curUnit) markers.push('interact');
    if (curUnit.team === 'player') {
      // Python: item_system.target_icon over item_funcs.get_all_items(unit).
      for (const item of allItemsWithMultiItems(unit.items)) {
        markers.push(...computeTargetIcons(unit, item, curUnit, game.db, game));
      }
    }
    const sprites = markers.map((name) => getSprite(`marker_${name}`)).filter((sprite): sprite is Surface => !!sprite);
    if (!sprites.length) continue;
    const icon = sprites[Math.floor(now / 500) % sprites.length];
    // Roaming sprites sit at their sub-tile roam position.
    const roamOffset = roamState ? roamVisualOffset(unit) : null;
    const left = (unit.position[0] + (roamOffset?.[0] ?? 0)) * TILEWIDTH - camX;
    const top = (unit.position[1] + (roamOffset?.[1] ?? 0)) * TILEHEIGHT - camY;
    surf.blit(icon, left - 2, top - 14 + offset);
  }
}

/**
 * Python Animation(RESOURCES.animations.get(nid), topleft): a resource
 * animation placed at a pixel top-left (screen or panel space).
 */
export function createPixelAnimation(nid: string, x: number, y: number, hold = false): MapAnimation | null {
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

export { getSkillAbilityOptions, type SkillAbilityOption };

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
  // A unit that died in combat still waits (Python WaitState skips no dead
  // unit); its unit_wait has no position and no region.
  if (game.eventManager) {
    const levelNid = game.currentLevel?.nid ?? '';
    const region = unit.position ? getRegionUnderPos(unit.position[0], unit.position[1]) : null;
    const ctx = { game, unit1: unit, region, gameVars: game.gameVars, levelVars: game.levelVars };
    game.eventManager.trigger(
      {
        type: 'unit_wait', levelNid, unitNid: unit.nid, unit1: unit,
        position: unit.position ? [unit.position[0], unit.position[1]] : undefined,
        region: region ?? undefined,
        localArgs: new Map<string, any>([['actively_chosen', activelyChosen]]),
      },
      ctx,
    );
  }
  game.actionLog.doAction(new WaitAction(unit));
}

/** MovementState marker: the player move ended in an interrupt region. */
const SURPRISE_AFTER_MOVEMENT = '__surprise_wait__';

/**
 * Python UnitPathMovementComponent.finish(surprise=True) for a player unit:
 * HasAttacked, then clear to free + wait, whose WaitState waits the unit
 * (unit_wait with actively_chosen False). The Wait fires the region's
 * trigger and removes only_once interrupt regions.
 */
function finishPlayerSurpriseMove(game: any, unit: UnitObject): void {
  game.audioManager?.playSfx?.('Surprise');
  game.actionLog.doAction(new HasAttackedAction(unit));
  game._moveAction = null;
  game.state.clear();
  game.state.change('free');
  waitUnit(game, unit, false);
  if (game.eventManager?.hasActiveEvents()) game.state.change('event');
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
 * level start: free, status_upkeep, then the player phase_change (banner,
 * unit reset, autocursor), with the level_start events on top.
 */
export function enterStartedLevel(game: any): void {
  game.state.clear();
  game.state.change('free');
  game.state.change('status_upkeep');
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
    // Python TitleStartState.start: game.state.refresh() keeps only the
    // title screen (a game over or main_menu pushed it over the level).
    game.state.refresh();
    this.bgImage = null;
    this.logoImage = null;
    this.pressStartImage = null;
    this.logoAssetLoaded = false;
    this.pressStartAssetLoaded = false;
    this.logoChecked = false;
    this.pressStartChecked = false;
    this.pulseTimer = 0;
    // Load the title background panorama (try single file, then frame 0 for animated panoramas)
    const bgNid = titleBackgroundNid();
    game.resources.tryLoadImage(`resources/panoramas/${bgNid}.png`).then((img: HTMLImageElement | null) => {
      if (img) {
        this.bgImage = img;
      } else {
        // Animated panorama fallback: try <nid>0.png
        game.resources.tryLoadImage(`resources/panoramas/${bgNid}0.png`).then((img0: HTMLImageElement | null) => {
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
  /** The player moved the cursor before the async slot check finished. */
  private cursorMoved = false;
  private suspendWarned: boolean = false;
  private banner: Banner | null = null;
  private busy: boolean = false;

  override start(): StateResult {
    const game = getGame();
    this.bg = new MenuBackground(titleBackgroundNid(), game.resources, false);
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
    this.cursorMoved = false;
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
      // The EOtF fork comments out 'Restart Level'.
      if (!isForkEngine()) opts.unshift('Restart Level');
      opts.unshift('Load Game');
    }
    if (this.hasSuspendData) {
      opts.unshift('Continue');
    }
    const current = this.menu.getCurrent();
    this.options = opts;
    this.menu = new TitleMainMenu(opts, 'title_menu_dark', (t) => getGame().db?.translate?.(t) ?? t);
    // Python menus.Main starts on the first option (Continue when a suspend
    // exists); only keep a selection the player made before the async save
    // check filled in the list.
    const keep = this.cursorMoved ? opts.indexOf(current) : -1;
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
      this.cursorMoved = true;
      if (this.menu.moveDown()) game.audioManager.playSfx('Select 6');
    } else if (event === 'UP') {
      this.cursorMoved = true;
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
    if (!this.modeBg) this.modeBg = new MenuBackground(titleBackgroundNid(), game.resources, false);
    this.modeBg.draw(surf);
    const translate = (t: string): string => game.db?.translate?.(t) ?? t;
    if (!this.modeMenu || this.modeMenu.options.join('|') !== this.menuOptions.join('|')) {
      this.modeMenu = new ModeSelectMenu(this.menuOptions.slice(), translate);
    }
    this.modeMenu.currentIndex = this.cursor;
    const s = this.modeScene.begin();
    // Label: base surf 96x88 with menu_shimmer2, translucent .1, at (142, 36).
    const label = new Surface(96, 88);
    // A bare create_base_surf: EOtF keeps the startup skin (the shimmer is live).
    label.blit(getMenuBackgroundSync(96, 88, startupSkinnedSpriteName('menu_bg_base')), 0, 0);
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
    this.bg = new MenuBackground(titleBackgroundNid(), game.resources, false);
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
        if (isForkEngine()) {
          // EOtF fork TitleExtrasState: run 'Global Credits_Title' (Error
          // sfx when the project lacks it).
          if (game.db.events.has('Global Credits_Title') &&
              game.eventManager?.triggerSpecific('Global Credits_Title', { type: 'credits' }, true)) {
            game.state.change('event');
          } else {
            game.audioManager.playSfx('Error');
          }
        } else if (game.db.events.has('Global Credits') && game.eventManager?.triggerSpecific('Global Credits', { type: 'credits' }, true)) {
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
    this.bg = new MenuBackground(titleBackgroundNid(), game.resources, false);
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
    // Python OptionMenuState.start: game.cursor.hide().
    game.cursor.visible = false;
    const options: MenuOption[] = [
      { label: 'Objective', value: 'objective', enabled: !!game.currentLevel },
      { label: 'Options', value: 'options', enabled: true },
    ];
    // EOtF fork: no Save/Suspend on level 'X' (the Safe Location roam hub
    // saves through its own System_Menu event).
    if (!(isForkEngine() && game.currentLevel?.nid === 'X')) {
      if (game.currentMode?.permadeath) {
        options.push({ label: 'Suspend', value: 'suspend', enabled: true });
      } else {
        options.push({ label: 'Save', value: 'save', enabled: true });
      }
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
        // Python triggers the event over the option menu, which is back on
        // top once the event ends.
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
          // Python transition_to pops only itself: the option menu stays
          // beneath and is back on top when this screen closes.
          this.menu = null;
          game.state.change('base_guide');
          break;
        }
        case 'end_turn': {
          // Python OptionMenuState 'End' (upstream and fork) waits nobody
          // and pushes turn_change, status_endstep and the player 'ai'
          // phase: units with an AI act (and wait only if they did
          // something), then AIState's completion pushes turn_change, whose
          // begin runs status_endstep. The rest keep their action flags,
          // which the next ResetAll clears for living units only.
          this.menu = null;
          game.state.back();
          game.state.change('ai');
          break;
        }
        case 'turnwheel': {
          // Python OptionMenuState: open the turnwheel with uses left (an
          // unset count reads as 1). Upstream also treats -1 as unlimited;
          // EOtF's engine does not, so its default -1 shows Turnwheel_empty.
          const currentUses = Number(game.gameVars.get('_current_turnwheel_uses') ?? 1);
          if (currentUses > 0 || (currentUses === -1 && !isForkEngine())) {
            this.menu = null;
            game.state.change('turnwheel');
          } else {
            pushAlert(game, new Banner(game.db.translate('Turnwheel_empty')));
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
          // Python transition_to pops only itself: the option menu stays
          // beneath and is back on top when this screen closes.
          this.menu = null;
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
          // Python transition_to pops only itself: the option menu stays
          // beneath and is back on top when this screen closes.
          this.menu = null;
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
    // No unit is acting in free: every map sprite is back to 'normal'.
    for (const u of game.units.values()) setSpritePose(u, null);
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

    // Python HighlightController.handle_hover: the hovered unit's light
    // move/attack/spell ranges and its auras, cleared when the hover changes.
    const pos = game.cursor.getHover();
    const unit = game.board.getUnit(pos.x, pos.y);
    const visibleUnit = unit && !unitHasTag(unit, 'Tile') && inVisionForHover(game, [pos.x, pos.y]) ? unit : null;
    const auraHoverNid = visibleUnit?.nid ?? null;
    if (auraHoverNid !== this.auraHoverNid) {
      for (const type of ['possible_move', 'splash', 'spell_splash'] as const) game.highlight.clearType(type);
      if (visibleUnit) displayHoverHighlights(game, visibleUnit);
      game.highlight.setAuraHighlights(
        visibleUnit ? auraHighlightPositions(visibleUnit, game.board) : [],
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
      // Standard mode: Python auto-ends when the autoend_turn setting is on,
      // any unit is on the map, and every selectable player unit has
      // finished -- including when no player units are left (EOtF then
      // reaches its enemy_turn_change Global_Loss check).
      // Python get_player_units / get_all_units: units with a position.
      const fieldUnits: UnitObject[] = game.getAllUnits().filter((u: UnitObject) => u.position && !u.isDead());
      const playerUnits = fieldUnits.filter((u) => u.team === 'player');
      if (fieldUnits.length > 0 && getSetting('autoend_turn')) {
        const allFinished = playerUnits.every((u) =>
          u.finished || u.isDead() || unitHasTag(u, 'Tile') || !canSelect(u, game));
        if (allFinished) {
          // Python FreeState: turn_change, status_endstep, then the player
          // team's AI state on top (unselectable units act on their own).
          game.state.change('ai');
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
    game.memory.delete(ITEM_USE_CANTO);
    if (unit.finished || (!unit.canStillAct() && !canto)) {
      game.selectedUnit = null;
      game._moveOrigin = null;
      game.highlight.clear();
      game.state.back();
      return 'repeat';
    }

    // Python MoveState.begin: game.cursor.show() (the menu hid it) and the
    // unit's sprite walks in place facing down ('selected').
    game.cursor.show?.();
    setSpritePose(unit, 'selected');
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

    // Python MoveState.begin: display_highlights (spell, attack, then move
    // ranges, each replacing the earlier on shared tiles) or, after a trade,
    // only the remaining moves; plus the unit's auras.
    game.highlight.clear();
    // Python's valid moves keep allies' tiles (passable, shown in blue).
    const shownMoves: [number, number][] = game.pathSystem.getValidMoves(unit, game.board, true);
    if (!unit.hasTraded) {
      const usable = (item: ItemObject): boolean => itemAvailable(unit, item, game.db, game);
      game.highlight.addHighlights(
        allAttackablePositions(unit, unit.items.filter((i) => i.isSpell() && usable(i)), shownMoves, game.board, game), 'spell');
      game.highlight.addHighlights(
        allAttackablePositions(unit, unit.items.filter((i) => i.isWeapon() && usable(i)), shownMoves, game.board, game), 'attack');
    }
    game.highlight.addHighlights(shownMoves, 'move');
    game.highlight.setAuraHighlights(auraHighlightPositions(unit, game.board));
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
        // Python MoveState: the unit's own tile always works ("move in
        // place"), even when it has no valid moves (MOV -99 statuses such as
        // EOtF's Chains of Thanatos aura leave valid_moves empty).
        const selected: UnitObject | null = game.selectedUnit;
        const ownTile = !!selected?.position && selected.position[0] === pos.x && selected.position[1] === pos.y;
        const isValid = ownTile || this.validMoves.some(
          ([x, y]) => x === pos.x && y === pos.y,
        );
        if (isValid) {
          const unit: UnitObject = game.selectedUnit;
          const origin = this.previousPosition ?? unit.position;
          if (!origin) break;
          // EOtF fork MoveState: selecting a Canto unit's own tile waits it
          // at once (upstream goes to canto_wait).
          if (isForkEngine() && (unit.hasAttacked || unit.hasTraded) &&
              origin[0] === pos.x && origin[1] === pos.y) {
            game.audioManager?.playSfx?.('Select 2');
            this.forkCantoWait(unit);
            break;
          }

          // Compute path from the unit's current position (before moving on the board)
          const fullPath = game.pathSystem.getPath(
            unit,
            pos.x,
            pos.y,
            game.board,
          );
          // Python UnitPathMovementComponent: the walk stops on the first
          // interrupt_move region tile, and stopping in one is a surprise.
          const interrupted = fullPath
            ? interruptMovePath(unit, fullPath, game)
            : { path: fullPath, surprise: false };
          const path = interrupted.path;
          const destination: [number, number] = path && path.length > 0
            ? [path[path.length - 1][0], path[path.length - 1][1]]
            : [pos.x, pos.y];

          const movementCost = path
            ? game.pathSystem.getPathCost(unit, path, game.board)
            : 0;
          const moveAction = new MoveAction(
            unit,
            [origin[0], origin[1]],
            destination,
            game.board,
            movementCost,
          );
          // Python moves a unit that already attacked or traded as CantoMove.
          moveAction.canto = unit.hasAttacked || unit.hasTraded;
          game.actionLog.doAction(moveAction);
          game._moveAction = moveAction;


          // Python: a Canto move (after attacking/trading) goes to
          // canto_wait instead of the full action menu.
          const nextState = interrupted.surprise
            ? SURPRISE_AFTER_MOVEMENT
            : unit.hasAttacked || unit.hasTraded ? 'canto_wait' : 'menu';
          // If we have a path with length > 1, animate movement
          if (path && path.length > 1) {
            game.movementSystem.beginMove(unit, path, undefined, () => {
              // After movement animation completes, push the next state
            });
            game.state.change('movement');
            game._pendingAfterMovement = nextState;
          } else if (interrupted.surprise) {
            finishPlayerSurpriseMove(game, unit);
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
        // The EOtF fork instead ends the unit's turn (waits it) on BACK.
        if (deselectedUnit && (deselectedUnit.hasAttacked || deselectedUnit.hasTraded)) {
          if (isForkEngine()) {
            game.audioManager?.playSfx?.('Select 4');
            this.forkCantoWait(deselectedUnit);
          } else {
            game.audioManager?.playSfx?.('Error');
          }
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
          game.arrowRenderer.draw(
            surf, segments, cameraOffset, performance.now(),
            !!game.db.getConstant('translucent_unit_sprite', false),
          );
        }
      }
    }
    return surf;
  }

  override end(): StateResult {
    const game = getGame();
    game.highlight.clear();
  }

  /**
   * EOtF fork MoveState (BACK, or SELECT on its own tile, during Canto):
   * clear to free and wait the unit (actively_chosen=False).
   */
  private forkCantoWait(unit: UnitObject): void {
    const game = getGame();
    if (unit.position) game.cursor.setPos(unit.position[0], unit.position[1]);
    game.highlight.clear();
    game._moveOrigin = null;
    game._moveAction = null;
    game.state.clear();
    game.state.change('free');
    if (!unit.finished) {
      game.actionLog.doAction(new MarkActionGroupEnd('menu'));
      waitUnit(game, unit, false);
    }
    if (game.eventManager?.hasActiveEvents()) game.state.change('event');
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
    // Python CantoWaitState.begin: change_state('selected').
    setSpritePose(unit, 'selected');
    const options: MenuOption[] = [{ label: 'Wait', value: 'wait', enabled: true }];
    // The EOtF fork's CantoWaitState offers only Wait (no Supply).
    if (unit && !isForkEngine() && supplyAvailableOnMap(unit, game)) {
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
      // The EOtF fork calls cur_unit.wait() here (actively_chosen=False).
      waitUnit(game, unit, !isForkEngine());
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

    // Python MenuState.begin: game.cursor.hide(); the sprite faces the
    // cursor ('chosen'), or walks facing down once it has attacked.
    game.cursor.visible = false;
    setSpritePose(unit, unit.hasAttacked ? 'selected' : 'chosen');
    // Python MenuState.begin "Draw highlights": the first of Attack/Spells
    // offered shows its range from where the unit stands, plus its auras.
    game.highlight.clear();
    const here: [number, number][] = [[ux, uy]];
    const usable = (item: ItemObject): boolean => itemAvailable(unit, item, game.db, game);
    if (options.some((o) => o.value === 'attack')) {
      game.highlight.addHighlights(allAttackablePositions(unit, unit.items.filter((i) => i.isWeapon() && usable(i)), here, game.board, game), 'attack');
    } else if (options.some((o) => o.value === 'spells')) {
      game.highlight.addHighlights(allAttackablePositions(unit, unit.items.filter((i) => i.isSpell() && usable(i)), here, game.board, game), 'spell');
    }
    game.highlight.setAuraHighlights(auraHighlightPositions(unit, game.board));

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
      } else if (value in TARGET_ABILITY_BY_VALUE) {
        // Python MenuState: every other ability goes through TargetingState
        // (map cursor over its valid positions, pennant, previews).
        this.menu = null;
        game.highlight.clear();
        game.memory.set('ability', value);
        game.state.change('targeting');
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

  /** Python MenuState.end: remove_highlights(). */
  override end(): StateResult {
    getGame().highlight.clear();
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
  grantWexp: boolean = true,
): { statChanges: Record<string, number> } {
  const action = kind === 'promote'
    ? new PromoteAction(unit, newKlass)
    : new ClassChangeAction(unit, newKlass);
  game.actionLog.doAction(action);

  const { statChanges, newWexp } = action.getData();
  for (const [weaponNid, value] of Object.entries(newWexp)) {
    if (grantWexp && value > 0) {
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
  requestedHealing?: Map<UnitObject, number>,
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
        // Python HealHit(unit, item, target, heal, true_heal): the requested heal.
        if (requestedHealing && amount > 0) {
          requestedHealing.set(target, (requestedHealing.get(target) ?? 0) + amount);
        }
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
    if (target && !unitHasTag(target, 'Tile')) units.set(target.nid, target);
  }
  return [...units.values()];
}

export function finishCoreItemUse(
  unit: UnitObject,
  item: ItemObject,
  targets: UnitObject[] = [],
  healingDone: Map<UnitObject, number> = new Map(),
  baseUse: boolean = false,
  resourcesStarted: boolean = false,
  requestedHealing: Map<UnitObject, number> = new Map(),
  canto?: number | null,
): void {
  const game = getGame();
  if (!resourcesStarted) applyItemStartResourceHooks(game, unit, item);
  applyItemEndResourceHooks(game, unit, item);
  const uniqueTargets = [...new Map(targets.map((target) => [target.nid, target])).values()];
  // Python LiveToServe.after_strike runs after every strike of the one
  // attacker phase and heals int(X * the requested heal of every ally strike
  // so far that healed something), the phase's `heal_hit` playback. EOtF's
  // engine adds the user's heal modifiers to a positive amount only, so
  // nothing happens when no ally was healed.
  const liveToServe = unit.skills.filter((skill: SkillObject) =>
    typeof skill.getComponent<unknown>('live_to_serve') === 'number');
  let allyHealing = 0;
  for (const target of liveToServe.length > 0 ? uniqueTargets : []) {
    if (target !== unit && (healingDone.get(target) ?? 0) > 0) {
      allyHealing += requestedHealing.get(target) ?? healingDone.get(target) ?? 0;
    }
    for (const skill of liveToServe) {
      const base = Math.trunc(allyHealing * skill.getComponent<number>('live_to_serve')!);
      const amount = isForkEngine() && base > 0 ? modifiedHealAmount(base, unit, unit, game) : base;
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
    // Python handle_broken_items: the map combat (not a base use) alerts a
    // player's broken item unless it targeted the user itself.
    if (nextUses === 0 && !baseUse && game.memory.get(BROKEN_ALERT_SHOWN) !== item &&
        shouldAlertBrokenItem(unit, item, uniqueTargets[0] ?? null)) {
      const pending: Banner[] = game.memory.get(PENDING_ALERTS) ?? [];
      pending.push(brokenItemBanner(item));
      game.memory.set(PENDING_ALERTS, pending);
    }
  }
  if (game.memory.get(BROKEN_ALERT_SHOWN) === item) game.memory.delete(BROKEN_ALERT_SHOWN);
  triggerAbilityItemCharge(game, unit, item, 'use');
  if (baseUse) game.actionLog.doAction(new HasTradedAction(unit));
  else if (!canAttackAfterCombat(unit, item)) {
    // Python clean_up2: HasAttacked, then handle_state_stack moves a Canto
    // user on with its canto movement instead of waiting it.
    const cantoLeft = canto === undefined ? itemUseCantoMovement(game, unit, uniqueTargets[0] ?? null) : canto;
    game.actionLog.doAction(new HasAttackedAction(unit));
    if (cantoLeft !== null) {
      game.actionLog.doAction(new SetMovementLeftAction(unit, cantoLeft));
      game.memory.set(ITEM_USE_CANTO, unit);
      if (unit.position) game.cursor?.setPos?.(unit.position[0], unit.position[1]);
    } else {
      // Python WaitState: unit.wait() fires unit_wait (not actively chosen).
      waitUnit(game, unit, false);
    }
  }
  game.actionLog.doAction(new MarkActionGroupEnd('item_use'));
}

/** Memory key: broken-item banners waiting for the item menus to resume. */
const PENDING_ALERTS = 'pending_item_alerts';
/** Memory key: the item whose broken alert the promotion flow already showed. */
export const BROKEN_ALERT_SHOWN = 'broken_alert_shown';

/**
 * Python simple_combat.handle_broken_items' alert condition: a player unit's
 * item broke, the combat was not the unit targeting itself, the unit is not
 * dying, and no no_alert_on_break (alerts_when_broken, ALL_DEFAULT_TRUE).
 */
export function shouldAlertBrokenItem(unit: UnitObject, item: ItemObject, defender: UnitObject | null): boolean {
  return unit !== defender && unit.team === 'player' && unit.currentHp > 0 && !unit.isDead() &&
    !item.hasComponent('no_alert_on_break');
}

/** Python banner.BrokenItem: "<color>{item}</> broke." with the ItemBreak sound. */
export function brokenItemBanner(item: ItemObject): Banner {
  return new Banner(`${colored(item.name, bannerItemColor(item))} broke.`, itemIcon(item), 3000, { sound: 'ItemBreak' });
}

/** Push an AlertState for a banner (Python game.alerts.append + change('alert')). */
export function pushAlert(game: any, banner: Banner): void {
  const alerts: Banner[] = game.memory.get(ALERTS) ?? [];
  alerts.push(banner);
  game.memory.set(ALERTS, alerts);
  game.state.change('alert');
}

/**
 * Open an item use's queued events (its end_combat events, then unit_wait)
 * with its broken-item alerts above them: Python alerts in clean_up1, before
 * clean_up2's events and WaitState.
 */
function openItemUseEvents(game: any): void {
  if (game.eventManager?.hasActiveEvents()) game.state.change('event');
  showPendingAlerts(game);
}

/** The resumed item menu shows the item use's pending broken-item alerts first. */
function showPendingAlerts(game: any): boolean {
  const pending: Banner[] = game.memory.get(PENDING_ALERTS) ?? [];
  if (pending.length === 0) return false;
  game.memory.delete(PENDING_ALERTS);
  for (const banner of pending) pushAlert(game, banner);
  return true;
}

const ALERTS = 'alerts';

/**
 * Port of Python AlertState: shows the newest banner in game.alerts until it
 * times out or, after its pause, any input dismisses it.
 */
export class AlertState extends State {
  readonly name = 'alert';
  override readonly transparent = true;

  private current(): Banner | null {
    const alerts: Banner[] = getGame().memory.get(ALERTS) ?? [];
    return alerts[alerts.length - 1] ?? null;
  }

  private leave(): StateResult {
    const game = getGame();
    const alerts: Banner[] = game.memory.get(ALERTS) ?? [];
    alerts.pop();
    game.state.back();
    return 'repeat';
  }

  override takeInput(event: InputEvent): StateResult {
    const alert = this.current();
    if (event && alert && alert.canDismiss()) return this.leave();
  }

  override update(): StateResult {
    const alert = this.current();
    if (!alert) {
      getGame().state.back();
      return 'repeat';
    }
    if (alert.update(FRAMETIME)) return this.leave();
  }

  override draw(surf: Surface): Surface {
    this.current()?.draw(surf);
    return surf;
  }
}

/**
 * Port of Python WaitState: every unit that has attacked but is not finished
 * waits through unit.wait() (unit_wait, actively_chosen False). Combat pushes
 * it under its end-of-combat events, so it runs after them.
 */
export class WaitState extends State {
  readonly name = 'wait';
  override readonly transparent = true;

  override update(): StateResult {
    const game = getGame();
    game.state.back();
    for (const unit of game.getAllUnits() as UnitObject[]) {
      // Python iterates game.units, dead ones included: a unit killed in
      // combat after attacking is waited (finished) too.
      if (unit.hasAttacked && !unit.finished) waitUnit(game, unit, false);
    }
    if (game.eventManager?.hasActiveEvents()) game.state.change('event');
    return 'repeat';
  }
}

/** Memory key: the unit whose map item use left it in Canto. */
const ITEM_USE_CANTO = 'item_use_canto';

/**
 * Python simple_combat.handle_state_stack after an item use: with HasAttacked
 * already applied, has_canto(user, target) gives canto_movement; null when
 * the user must wait.
 */
export function itemUseCantoMovement(game: any, unit: UnitObject, target: UnitObject | null): number | null {
  if (unit.isDead()) return null;
  const hadAttacked = unit.hasAttacked;
  unit.hasAttacked = true;
  try {
    return unitHasCanto(unit, target, game) ? cantoMovement(unit, target, game) : null;
  } finally {
    unit.hasAttacked = hadAttacked;
  }
}

/**
 * The item menu resumed after an item use that left its user in Canto
 * swaps itself for the Canto 'move', as Python's handle_state_stack pushes
 * 'move' over the item menus; MoveState.begin then starts Canto.
 */
function enterCantoAfterItemUse(game: any, unit: UnitObject): boolean {
  if (game.memory.get(ITEM_USE_CANTO) !== unit || !unit.hasAttacked || unit.finished) return false;
  game.state.back();
  game.state.change('move');
  return true;
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
  drawItemUseRolls(game, unit, [{ item, positions: [position] }]);
  const targets = effectUnits(unit, item, position);
  const hpBefore = new Map(targets.map((target) => [target, target.currentHp]));
  const canto = classChangeCanto(game, unit, item, targets[0] ?? null);
  const requestedHealing = new Map<UnitObject, number>();
  if (!applyCoreTargetedEffects(unit, item, position, targetItem, requestedHealing)) {
    while (game.actionLog.getLength() > resourceStart) game.actionLog.undo();
    return false;
  }
  const healingDone = new Map(
    targets.map((target) => [target, Math.max(0, target.currentHp - (hpBefore.get(target) ?? target.currentHp))]),
  );
  finishCoreItemUse(unit, item, targets, healingDone, false, true, requestedHealing, canto);
  return true;
}

/**
 * Python changes class in the item's end_combat, after handle_state_stack
 * decided Canto, so a class-changing item's Canto uses the old class.
 */
function classChangeCanto(game: any, unit: UnitObject, item: ItemObject, target: UnitObject | null): number | null | undefined {
  const changesClass = ['promote', 'force_promote', 'class_change', 'force_class_change']
    .some((nid) => item.hasComponent(nid));
  return changesClass ? itemUseCantoMovement(game, unit, target) : undefined;
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
  drawItemUseRolls(game, unit, [{ item, positions }]);
  let applied = false;
  const targets = new Map<string, UnitObject>();
  const hpBefore = new Map<UnitObject, number>();
  const requestedHealing = new Map<UnitObject, number>();
  for (const position of positions) {
    for (const target of effectUnits(unit, item, position)) {
      targets.set(target.nid, target);
      if (!hpBefore.has(target)) hpBefore.set(target, target.currentHp);
    }
    applied = applyCoreTargetedEffects(unit, item, position, null, requestedHealing) || applied;
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
  finishCoreItemUse(unit, item, [...targets.values()], healingDone, false, true, requestedHealing);
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
  drawItemUseRolls(game, unit, item.subitems.map((child, childIndex) => ({
    item: child,
    positions: targetsByItem[childIndex] ?? [],
  })));
  let storedUnit: UnitObject | null = null;
  let applied = false;
  const targets = new Map<string, UnitObject>();
  const queue = (game.eventManager?.eventQueue ?? []) as GameEvent[];
  // Python resolves every child in the one attacker phase: each child's
  // on_hit (event_on_use / event_on_hit) is triggered against the unit on its
  // target tile, or the user (simple_process) when the tile is empty.
  const childEvents: GameEvent[] = [];

  for (let childIndex = 0; childIndex < item.subitems.length; childIndex++) {
    const child = item.subitems[childIndex];
    for (const position of targetsByItem[childIndex] ?? []) {
      for (const target of effectUnits(unit, child, position)) targets.set(target.nid, target);
      const before = queue.length;
      queueDirectItemUseEvents(
        game, unit, child, position, game.board.getUnit(position[0], position[1]) ?? unit,
        ['event_on_use', 'event_on_hit'],
      );
      childEvents.push(...queue.splice(before));
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
  // Event-only children (EOtF Entangle) still make a use.
  if (childEvents.length > 0) applied = true;

  if (!applied) {
    while (game.actionLog.getLength() > resourceStart) game.actionLog.undo();
    return false;
  }
  const finalPosition = [...targetsByItem].reverse()
    .flatMap((positions) => [...positions].reverse())
    .find((position): position is [number, number] => !!position);
  // The phase's triggers run newest first, before the parent's own events.
  queue.push(...childEvents.reverse());
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
    if (showPendingAlerts(game)) return 'repeat';
    if (unit && enterCantoAfterItemUse(game, unit)) return 'repeat';
    // Python ItemState.start: the sprite faces the cursor ('chosen').
    setSpritePose(unit, 'chosen');
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
    // The EOtF fork's ItemChildState has no Trade entry, and offers Storage
    // whenever the convoy is on (no long_range_storage / supply check).
    const fork = isForkEngine();
    if (!fork && getTradePartners(unit).length > 0 && !item.hasComponent('untradeable')) {
      options.push('Trade');
    }
    if (unit.items.includes(item)) {
      const locked = item.hasComponent('locked');
      if (!locked && game.gameVars.get('_convoy') &&
          (fork || game.db.getConstant('long_range_storage', true) || supplyAvailableOnMap(unit, game))) {
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
        // Python ItemChildState: Trade goes through TargetingState too.
        this.child = null;
        this.menu = null;
        game.memory.set('ability', 'trade');
        game.state.change('targeting');
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
    const game = getGame();
    const current = this.items[this.menu?.selectedIndex ?? -1];
    // Python ItemState.draw: the description panel, then the menu; the panel
    // stays under the transparent item_child menu.
    if (current) drawItemDescriptionPanel(surf, game, game.selectedUnit, current);
    this.menu?.draw(surf);
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
  } else if (isForkEngine() && item.hasComponent('c_uses')) {
    // EOtF fork ItemOption.get_color: chapter-use items get purple uses.
    mainColor = 'white';
    usesColor = 'purple';
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

  // The window 2 px right of and 4 px below the small gem, translucent by .1.
  const framed = new Surface(width + 2, height + 4);
  framed.blit(getMenuBackgroundSync(width, height), 2, 4);
  const gem = getSprite('menu_gem_small');
  if (gem) framed.blit(gem, 0, 0);
  framed.setAlpha(0.9);
  surf.blit(framed, left, top);
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

    if (showPendingAlerts(game)) return 'repeat';
    if (enterCantoAfterItemUse(game, unit)) return 'repeat';
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

/** A game_var/level_var expression that raised (Python aborts the command). */
const VARIABLE_EVALUATION_FAILED: unique symbol = Symbol('variableEvaluationFailed');

export function canUseBaseItem(unit: UnitObject, item: ItemObject, game: any): boolean {
  if (!item.hasComponent('usable_in_base') || !item.hasComponent('usable')) return false;
  if (!itemAvailable(unit, item, game.db, game)) return false;
  if (item.maxUses > 0 && item.uses <= 0) return false;

  // Python EvalTargetRestrict2.simple_target_restrict:
  // evaluate(value, unit, local_args={'item': item}); an exception passes.
  const expression = item.getComponent<string>('eval_target_restrict_2');
  if (expression && !evaluateConditionOr(expression, {
    game,
    unit1: unit,
    item,
    gameVars: game.gameVars,
    levelVars: game.levelVars,
    localArgs: new Map([['item', item]]),
  }, true)) return false;

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
    // Python Promote.end_combat: one option goes straight to the promotion
    // screen, several to promotion_choice; the item use completes after.
    const options = [...(game.db.classes.get(unit.klass)?.turns_into ?? [])];
    if (options.length === 0) return 'done';
    requestPromotion(game, {
      unit,
      kind: 'promote',
      options: [],
      nextClass: options.length === 1 ? options[0] : null,
      canGoBack: true,
      popBelow: 0,
      itemUse: { actor: unit, item, baseUse: origin === 'base_use' },
    });
    return 'pushed';
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
  /** The unit whose item opened a promotion screen over this state. */
  private resumeUnit: UnitObject | null = null;

  override begin(): StateResult {
    const game = getGame();
    this.unit = game.memory.get('base_use_unit') ?? this.resumeUnit ?? game.selectedUnit ?? null;
    this.resumeUnit = null;
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
    if (useItemInBase(game, this.unit, item, 'base_use') === 'pushed') {
      this.resumeUnit = this.unit;
      return;
    }
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

/**
 * Python ItemTargetingState's menu: a menus.Choice of the target's eligible
 * items (ItemOption rows) at the automatic Choice spot, top-right when the
 * cursor is on the left half of the screen and (14, 8) otherwise.
 */
class TargetItemChoice {
  readonly choice: PrepChoice;
  private readonly values: string[];

  constructor(game: any, items: ItemObject[], values: string[]) {
    this.values = values;
    this.choice = new PrepChoice(game, items.map((item) => ({ kind: 'item' as const, item })), [0, 8]);
    const cursorX = game.cursor?.getPosition?.()?.[0] ?? 0;
    const cameraX = Math.floor((game.camera?.getOffset?.()?.[0] ?? 0) / TILEWIDTH);
    const tilesAcross = Math.floor(viewport.width / TILEWIDTH);
    const width = this.choice.getMenuWidth();
    this.choice.topleft = [cursorX > Math.floor(tilesAcross / 2) + cameraX ? 14 : viewport.width - width - 14, 8];
  }

  private selected(): { selected: string } | null {
    const value = this.values[this.choice.currentIndex];
    return value === undefined ? null : { selected: value };
  }

  handleClick(gx: number, gy: number, button: 'SELECT' | 'BACK'): { selected: string } | { back: true } | null {
    if (button === 'BACK') return { back: true };
    const [ox, oy] = prepScreenOrigin();
    return this.choice.handleMouse(gx, gy, ox, oy) >= 0 ? this.selected() : null;
  }

  handleMouseHover(gx: number, gy: number): void {
    const [ox, oy] = prepScreenOrigin();
    this.choice.handleMouse(gx, gy, ox, oy);
  }

  handleInput(event: InputEvent): { selected: string } | { back: true } | null {
    const game = getGame();
    const sfx = (name: string): void => game.audioManager?.playSfx?.(name);
    if (event === 'DOWN') {
      if (this.choice.moveDown()) sfx('Select 6');
    } else if (event === 'UP') {
      if (this.choice.moveUp()) sfx('Select 6');
    } else if (event === 'BACK') {
      sfx('Select 4');
      return { back: true };
    } else if (event === 'SELECT') {
      sfx('Select 1');
      return this.selected();
    }
    return null;
  }

  draw(surf: Surface): void {
    this.choice.update();
    const [ox, oy] = prepScreenOrigin();
    this.choice.draw(surf, ox, oy);
  }
}

export class ItemTargetingState extends MapState {
  readonly name = 'item_targeting';

  private item: ItemObject | null = null;
  private targets: [number, number][] = [];
  private targetIndex = 0;
  private sequenceIndex = 0;
  private selectedTargets: [number, number][][] = [];
  private targetItemMenu: TargetItemChoice | null = null;
  private pendingTarget: [number, number] | null = null;
  private selectableTargetItems: ItemObject[] = [];
  private targetItemMode: 'repair' | 'steal' | 'trace' | null = null;
  private selection: SelectionHelper | null = null;

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
    // Python CombatTargetingState: SelectionHelper over the target set, the
    // cursor starting on the most wounded unit for healing items, else on
    // the target closest to the cursor.
    this.selection = new SelectionHelper(targets);
    this.targets = this.selection.posList;
    const cursor = game.cursor.getPosition() as [number, number];
    let start: [number, number] | null;
    if (activeItem.hasComponent('heal') || activeItem.hasComponent('magic_heal')) {
      const ratio = (pos: [number, number]): number => {
        const target: UnitObject | null = game.board.getUnit(pos[0], pos[1]);
        return target ? target.currentHp / Math.max(1, target.maxHp) : 9999;
      };
      start = this.targets.reduce<[number, number] | null>((best, pos) => (!best || ratio(pos) < ratio(best) ? pos : best), null);
    } else {
      start = this.selection.getClosest([cursor[0], cursor[1]]);
    }
    this.targetIndex = start ? Math.max(0, this.targets.indexOf(start)) : 0;
    game.highlight.clear();
    if (this.targets.length > 0) this.focusTarget();
    return this.targets.length > 0;
  }

  /** Move to the target position `next` picks from the current one. */
  private moveSelection(next: (pos: [number, number]) => [number, number] | null): void {
    const current = this.targets[this.targetIndex];
    if (!current) return;
    const pos = next(current);
    if (!pos) return;
    const idx = this.targets.findIndex((t) => t[0] === pos[0] && t[1] === pos[1]);
    if (idx < 0) return;
    this.targetIndex = idx;
    this.focusTarget();
  }

  private focusTarget(): void {
    const game = getGame();
    const target = this.targets[this.targetIndex];
    if (!target) return;
    game.cursor.setPos(target[0], target[1]);
    if (isSmallScreen()) game.camera.focusTile(target[0], target[1]);
    const unit: UnitObject | null = game.selectedUnit;
    const item = this.activeItem();
    if (unit && item) displaySingleAttack(game, unit, item, [target[0], target[1]]);
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
      // Python Promote/ForcePromote/ClassChange.end_combat: a single class
      // goes straight to the promotion (class change) screen, several to the
      // choice screen. The item's use completes once the level screen ends.
      const kind = isClassChange ? 'class_change' : 'promote';
      const itemUse = { actor: unit, item: this.item, baseUse: false };
      game.highlight.clear();
      if (forceKlass || options.length === 1) {
        game.memory.delete('item_use_item');
        game.state.back();
        requestPromotion(game, {
          unit: defender, kind, options: [], nextClass: options[0], canGoBack: false, popBelow: 0, itemUse,
        });
      } else {
        requestPromotion(game, {
          unit: defender, kind, options: isClassChange ? [] : options, nextClass: null,
          canGoBack: true, popBelow: 1, itemUse,
        });
      }
      // Python: the crest's map combat spent its last use and alerted
      // handle_broken_items' banner before end_combat opened these screens.
      if (this.item.maxUses > 0 && this.item.uses <= 1 &&
          shouldAlertBrokenItem(unit, this.item, defender)) {
        pushAlert(game, brokenItemBanner(this.item));
        game.memory.set(BROKEN_ALERT_SHOWN, this.item);
      }
      return;
    }

    if (activeItem === this.item && activeItem.hasComponent('repair')) {
      const defender = game.board.getUnit(target[0], target[1]);
      this.selectableTargetItems = defender?.items.filter(isRepairableItem) ?? [];
      if (this.selectableTargetItems.length === 0) return;
      this.pendingTarget = target;
      this.targetItemMode = 'repair';
      game.cursor.visible = false;
      this.targetItemMenu = new TargetItemChoice(game, this.selectableTargetItems,
        this.selectableTargetItems.map((_, itemIndex) => `repair_${itemIndex}`));
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
      game.cursor.visible = false;
      this.targetItemMenu = new TargetItemChoice(game, this.selectableTargetItems,
        this.selectableTargetItems.map((_, itemIndex) => `steal_${itemIndex}`));
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
      game.cursor.visible = false;
      this.targetItemMenu = new TargetItemChoice(game, this.selectableTargetItems,
        this.selectableTargetItems.map((_, itemIndex) => `trace_${itemIndex}`));
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
        if (game.eventManager?.hasActiveEvents()) openItemUseEvents(game);
        else game.state.back();
        return;
      }
      if (!defender) return;
      if (isForkEngine() && numTargets(unit, activeItem) > 1) {
        // Fork CombatTargetingState: pick up to num_targets positions (a
        // chosen one leaves the selection unless allow_same_target), then
        // engage them all at once.
        const chosen = this.selectedTargets[this.sequenceIndex];
        chosen.push(target);
        if (chosen.length < numTargets(unit, activeItem) && this.configureTargets(unit)) return;
        this.engageForkMultiTarget(activeItem);
        return;
      }
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

  /** Whether the active item resolves through CombatState rather than a core use. */
  private isCombatItem(activeItem: ItemObject): boolean {
    return activeItem === this.item &&
      (activeItem.isWeapon() || (activeItem.isSpell() && !activeItem.hasCoreUseEffect()));
  }

  /** Engage every chosen position of a fork multi_target combat item at once. */
  private engageForkMultiTarget(activeItem: ItemObject): void {
    const game = getGame();
    if (!enterForkMultiTargetCombat(game, this.selectedTargets[this.sequenceIndex])) return;
    game.memory.set('combat_item', activeItem);
    game.highlight.clear();
    game.state.change('combat');
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
      openItemUseEvents(game);
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
        // Python ItemTargetingState BACK pops it and the combat targeting
        // beneath, returning to the action menu.
        this.targetItemMenu = null;
        this.pendingTarget = null;
        this.selectableTargetItems = [];
        this.targetItemMode = null;
        game.cursor.show?.();
        this.cancelTargeting();
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
    if (event === 'UP' || event === 'LEFT' || event === 'DOWN' || event === 'RIGHT') {
      const direction: string = event;
      this.moveSelection((pos) => this.selection?.step(direction, pos) ?? null);
    } else if (event === 'AUX') {
      game.audioManager?.playSfx?.('Select 6');
      this.moveSelection((pos) => this.selection?.getNext(pos) ?? null);
    } else if (event === 'SELECT') {
      this.selectTarget(this.targetIndex);
    } else if (event === 'START') {
      const unit: UnitObject | null = game.selectedUnit;
      const activeItem = this.activeItem();
      if (unit && activeItem && this.selectedTargets[this.sequenceIndex].length > 0 &&
          allowLessThanMaxTargets(unit, activeItem)) {
        if (isForkEngine() && this.isCombatItem(activeItem)) this.engageForkMultiTarget(activeItem);
        else this.completeTargetGroup(unit);
      }
    } else if (event === 'BACK') {
      this.cancelTargeting();
    }
  }

  override draw(surf: Surface): Surface {
    const game = getGame();
    const result = drawMap(surf, true);
    this.drawSpellForecast(result);
    this.drawTargetItemsPreview(result);
    this.targetItemMenu?.draw(result);
    return result;
  }

  /**
   * Python CombatTargetingState.draw for items that target items (steal):
   * the trade preview of the unit under the cursor, items it can't take
   * greyed (item_restrict).
   */
  private drawTargetItemsPreview(surf: Surface): void {
    const game = getGame();
    const unit: UnitObject | null = game.selectedUnit;
    const item = this.activeItem();
    if (!unit || !item || this.targetItemMenu || !isStealItem(item)) return;
    const [cx, cy] = game.cursor.getPosition();
    const target: UnitObject | null = game.board?.getUnit?.(cx, cy) ?? null;
    if (!target) return;
    const ignore = target.items.map((candidate: ItemObject) => !stealItemRestrict(unit, item, target, candidate, game.db));
    drawTradePreview(surf, game, target, ignore);
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
    if (!unit || !item || this.targetItemMenu || isStealItem(item)) return;
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
// 4d. TradeState - Trade items between adjacent allied units
// ============================================================================

export class TradeState extends State {
  readonly name = 'trade';
  override readonly transparent = true;

  private tradePartner: UnitObject | null = null;

  /** Python menus.Trade (shared with prep trading). */
  menu: TradeMenu | null = null;
  private phase: 'select_items' | null = null;

  override start(): StateResult {
    this.menu = null;
    this.phase = null;
  }

  override begin(): StateResult {
    const game = getGame();
    if (this.menu) return;
    const unit: UnitObject = game.selectedUnit;
    // Python TradeState.start: the partner comes from game.memory, set by the
    // Trade targeting state, the open_trade event command or a combat trade.
    const partner = game.memory?.get?.('trade_partner') ?? null;
    game.memory?.delete?.('trade_partner');
    if (!unit || !partner) {
      game.state.back();
      return;
    }
    this.tradePartner = partner;
    this.openTrade(unit);
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
// 4g. AbilityTargetingState — Python general_states.TargetingState
// ============================================================================

/** Map abilities Python's MenuState sends through its TargetingState. */
export type TargetAbility =
  'Talk' | 'Support' | 'Drop' | 'Rescue' | 'Take' | 'Give' | 'Pair Up' | 'Separate' | 'Transfer' | 'Trade';

/** MenuState option values that open the targeting state. */
export const TARGET_ABILITY_BY_VALUE: Record<string, TargetAbility> = {
  talk: 'Talk', support: 'Support', drop: 'Drop', rescue: 'Rescue', take: 'Take', give: 'Give',
  pair_up: 'Pair Up', separate: 'Separate', transfer: 'Transfer', trade: 'Trade',
};

/** Python equations RESCUE_AID / RESCUE_WEIGHT (0 when the project lacks one). */
function rescueEquation(game: any, name: 'RESCUE_AID' | 'RESCUE_WEIGHT', unit: UnitObject): number {
  const expr = game.db.getEquation?.(name);
  if (!expr) return 0;
  try {
    return Number(evaluateEquation(expr, unit, { db: game.db })) || 0;
  } catch {
    return 0;
  }
}

/** Adjacent units with an on_talk event for this pair that is not hidden. */
function talkTargets(game: any, unit: UnitObject): UnitObject[] {
  if (!unit.position || !game.eventManager) return [];
  return getAdjacentUnits(unit.position[0], unit.position[1]).filter((other) => {
    if (other === unit) return false;
    const ctx = { game, unit1: unit, unit2: other, gameVars: game.gameVars, levelVars: game.levelVars };
    const events = game.eventManager.getEventsForTrigger({
      type: 'on_talk',
      levelNid: game.currentLevel?.nid ?? '',
      unitA: unit.nid,
      unitB: other.nid,
      unit1: unit,
      unit2: other,
    }, ctx);
    return events.length > 0 && !game.eventManager.isTalkHidden?.(unit.nid, other.nid);
  });
}

/** Adjacent units whose support pair can rank up now (Python SupportAbility). */
function supportTargets(game: any, unit: UnitObject): UnitObject[] {
  if (!unit.position || !game.gameVars.get('_supports') || !game.db.supportConstants?.get?.('combat_convos')) return [];
  return getAdjacentUnits(unit.position[0], unit.position[1]).filter((other) => {
    if (other === unit) return false;
    const pair = game.supports?.getPair(unit.nid, other.nid);
    return !!pair && game.supports.canSupport(pair, game);
  });
}

/** Python <Ability>.targets(unit): the positions the targeting cursor visits. */
export function abilityTargetPositions(game: any, unit: UnitObject, ability: TargetAbility): [number, number][] {
  if (!unit.position) return [];
  const [ux, uy] = unit.position;
  const pairUp = !!game.db.getConstant('pairup', false);
  const positions = (units: UnitObject[]): [number, number][] => units
    .filter((u) => !!u.position)
    .map((u) => [u.position![0], u.position![1]]);
  switch (ability) {
    case 'Talk':
      return positions(talkTargets(game, unit));
    case 'Support':
      return positions(supportTargets(game, unit));
    case 'Drop':
      if (pairUp || !unit.isRescuing() || !unit.rescuing || unit.hasAttacked || unit.hasRescued) return [];
      return getAdjacentEmptyTiles(ux, uy, unit.rescuing);
    case 'Rescue':
      if (pairUp || unit.isRescuing() || unit.hasAttacked || unit.hasGiven || unit.hasDropped) return [];
      return positions(getAdjacentAllies(unit, ux, uy).filter((ally) =>
        !ally.isRescuing() && !ally.isRescued() && canCarry(unit, ally, game)));
    case 'Take':
      if (pairUp || unit.isRescuing() || unit.hasAttacked || unit.hasGiven || unit.hasDropped) return [];
      return positions(getAdjacentAllies(unit, ux, uy).filter((ally) =>
        ally.isRescuing() && !!ally.rescuing && canCarry(unit, ally.rescuing, game)));
    case 'Give':
      if (pairUp || !unit.isRescuing() || !unit.rescuing || unit.hasAttacked || unit.hasRescued ||
          (unit.hasTaken && !game.db.getConstant('give_and_take', false))) return [];
      return positions(getAdjacentAllies(unit, ux, uy).filter((ally) =>
        !ally.isRescuing() && !ally.isRescued() && canCarry(ally, unit.rescuing!, game)));
    case 'Pair Up':
      if (!pairUp || game.db.getConstant('attack_stance_only', false) || unit.isRescuing() || unit.isRescued()) return [];
      return positions(getAdjacentAllies(unit, ux, uy).filter((ally) =>
        !ally.isRescued() && !ally.isRescuing() && ally.team === unit.team));
    case 'Separate':
      if (!pairUp || !unit.isRescuing() || !unit.leadUnit || unit.hasAttacked || !unit.rescuing) return [];
      return getAdjacentEmptyTiles(ux, uy, unit.rescuing);
    case 'Transfer':
      if (!pairUp || unit.hasGiven) return [];
      return positions(getAdjacentAllies(unit, ux, uy).filter((ally) => !!ally.traveler || !!unit.traveler));
    case 'Trade': {
      const partners = getTradePartners(unit);
      const out = positions(partners);
      // A traveler the unit can trade with is reached on the unit's own tile.
      if (partners.some((partner) => !partner.position)) out.push([ux, uy]);
      return out;
    }
  }
}

/**
 * Python TargetingState: the map cursor jumps between an ability's valid
 * positions (SelectionHelper: arrows pick the nearest position that way, AUX
 * the next one), a pennant scrolls the ability's `_desc` text, and Rescue,
 * Take, Give and Trade preview the units involved. SELECT runs the ability's
 * `do`; BACK returns to the action menu.
 */
export class AbilityTargetingState extends MapState {
  readonly name = 'targeting';

  ability: TargetAbility | null = null;
  selection: SelectionHelper | null = null;
  /** Trade: target the traveler a hovered unit carries instead of the unit. */
  travelerMode = false;
  private pennant: Pennant | null = null;

  override start(): StateResult {
    const game = getGame();
    const unit: UnitObject | null = game.selectedUnit;
    const value = String(game.memory.get('ability') ?? '');
    const names = Object.values(TARGET_ABILITY_BY_VALUE) as string[];
    this.ability = TARGET_ABILITY_BY_VALUE[value] ?? (names.includes(value) ? value as TargetAbility : null);
    this.travelerMode = false;
    this.selection = null;
    this.pennant = null;
    if (!unit?.position || !this.ability) {
      game.state.back();
      return 'repeat';
    }
    this.selection = new SelectionHelper(abilityTargetPositions(game, unit, this.ability));
    const closest = this.selection.getClosest([unit.position[0], unit.position[1]]);
    if (!closest) {
      game.state.back();
      return 'repeat';
    }
    this.setCursor(closest);
    const key = `${this.ability}_desc`;
    this.pennant = new Pennant(game.db.translate ? game.db.translate(key) : key);
  }

  override begin(): StateResult {
    const game = getGame();
    game.cursor.combatShow?.();
    game.cursor.visible = true;
    setSpritePose(game.selectedUnit, 'chosen');
  }

  private setCursor(pos: [number, number] | null): void {
    if (!pos) return;
    const game = getGame();
    game.cursor.setPos(pos[0], pos[1]);
    if (isSmallScreen()) game.camera.focusTile(pos[0], pos[1]);
  }

  private cursorPos(): [number, number] {
    const pos = getGame().cursor.getHover();
    return [pos.x, pos.y];
  }

  /** Python _handle_direction (Trade toggles onto a hovered unit's traveler first). */
  private handleDirection(next: (pos: [number, number]) => [number, number] | null): void {
    const game = getGame();
    const unit: UnitObject | null = game.selectedUnit;
    if (this.ability === 'Trade' && unit) {
      const [x, y] = this.cursorPos();
      const target: UnitObject | null = game.board.getUnit(x, y);
      if (target && target !== unit && target.traveler) {
        const traveler: UnitObject | null = game.getUnit(target.traveler);
        if (traveler && traveler.team === unit.team) this.travelerMode = !this.travelerMode;
      }
    }
    if (!this.travelerMode) this.setCursor(next(this.cursorPos()));
  }

  override takeInput(event: InputEvent): StateResult {
    const game = getGame();
    const selection = this.selection;
    if (!selection) return;
    const sfx = (name: string): void => game.audioManager?.playSfx?.(name);
    if (game.input?.mouseMoved || game.input?.mouseClick === 'SELECT') {
      const hovered = selection.handleMouse(getMouseTile());
      if (hovered) this.setCursor(hovered);
    }
    if (game.input?.mouseClick === 'BACK') event = 'BACK';
    else if (game.input?.mouseClick === 'SELECT' && selection.handleMouse(getMouseTile())) event = 'SELECT';
    if (event === 'UP' || event === 'DOWN' || event === 'LEFT' || event === 'RIGHT') {
      const direction: string = event;
      sfx('Select 6');
      this.handleDirection((pos) => selection.step(direction, pos));
    } else if (event === 'AUX') {
      sfx('Select 6');
      this.handleDirection((pos) => selection.getNext(pos));
    } else if (event === 'BACK') {
      sfx('Select 4');
      game.state.back();
    } else if (event === 'SELECT') {
      sfx('Select 1');
      this.confirm();
    }
  }

  /** The unit the ability acts on at the cursor (Python TargetingState SELECT). */
  private selectedPartner(unit: UnitObject): UnitObject | null {
    const game = getGame();
    const [x, y] = this.cursorPos();
    const hovered: UnitObject = game.board.getUnit(x, y) ?? unit;
    const travelerOf = (u: UnitObject): UnitObject | null => (u.traveler ? game.getUnit(u.traveler) ?? null : null);
    if (this.travelerMode) return travelerOf(hovered) ?? hovered;
    if (hovered === unit && unit.traveler && this.ability === 'Trade') return travelerOf(unit);
    return hovered;
  }

  /** Python <Ability>.do(unit). */
  private confirm(): void {
    const game = getGame();
    const unit: UnitObject | null = game.selectedUnit;
    const ability = this.ability;
    if (!unit || !ability) return;
    const [x, y] = this.cursorPos();
    const target: UnitObject | null = game.board.getUnit(x, y);
    const levelNid = game.currentLevel?.nid ?? '';
    switch (ability) {
      case 'Trade': {
        const partner = this.selectedPartner(unit);
        if (!partner || partner === unit) return;
        game.memory.set('trade_partner', partner);
        game.state.back();
        game.state.change('trade');
        return;
      }
      case 'Talk': {
        if (!target) return;
        // Python TalkAbility.do: back to the menu, HasTraded, fire on_talk.
        game.state.back();
        game.actionLog.doAction(new HasTradedAction(unit));
        const ctx = { game, unit1: unit, unit2: target, gameVars: game.gameVars, levelVars: game.levelVars };
        game.eventManager?.trigger({
          type: 'on_talk', levelNid, unitA: unit.nid, unitB: target.nid, unit1: unit, unit2: target,
        }, ctx);
        if (game.eventManager?.hasActiveEvents()) game.state.change('event');
        return;
      }
      case 'Support': {
        const pair = target ? game.supports?.getPair(unit.nid, target.nid) : null;
        if (!target || !pair || pair.lockedRanks.length === 0) return;
        const rank = pair.lockedRanks[0];
        game.state.back();
        game.actionLog.doAction(new HasTradedAction(unit));
        const ctx = { game, unit1: unit, unit2: target, gameVars: game.gameVars, levelVars: game.levelVars };
        game.eventManager?.trigger({
          type: 'on_support', levelNid, unit1: unit, unit2: target, position: unit.position,
          support_rank_nid: rank, is_replay: false,
        }, ctx);
        game.actionLog.doAction(new UnlockSupportRankAction(pair, rank));
        if (game.eventManager?.hasActiveEvents()) game.state.change('event');
        return;
      }
      case 'Drop': {
        const traveler = unit.rescuing;
        if (!traveler) return;
        game.actionLog.doAction(new DropAction(unit, traveler, game.board, [x, y]));
        // EOtF's engine (abilities.DropAbility.do): a Canto unit marks
        // HasTraded and returns to the action menu instead of waiting.
        if (isForkEngine() && unitHasCanto(unit, traveler, game)) game.actionLog.doAction(new HasTradedAction(unit));
        else game.actionLog.doAction(new WaitAction(unit));
        break;
      }
      case 'Separate': {
        const traveler = unit.rescuing;
        if (!traveler) return;
        game.actionLog.doAction(new SeparatePairUpAction(unit, traveler, game.board, game.db, [x, y], true));
        game.actionLog.doAction(new WaitAction(unit));
        break;
      }
      case 'Rescue': {
        if (!target) return;
        game.actionLog.doAction(new RescueAction(unit, target, game.board));
        if (isForkEngine() && unitHasCanto(unit, target, game)) game.actionLog.doAction(new HasTradedAction(unit));
        else game.actionLog.doAction(new WaitAction(unit));
        break;
      }
      case 'Pair Up': {
        if (!target) return;
        game.actionLog.doAction(new PairUpAction(unit, target, game.board, game.db));
        break;
      }
      case 'Take': {
        if (!target?.rescuing) return;
        // Neither Take nor Give is the major action: back to the menu.
        game.actionLog.doAction(new HasTradedAction(unit));
        game.actionLog.doAction(new TransferTravelerAction(target, unit, target.rescuing, 'take'));
        break;
      }
      case 'Give': {
        if (!target || !unit.rescuing) return;
        game.actionLog.doAction(new HasTradedAction(unit));
        game.actionLog.doAction(new TransferTravelerAction(unit, target, unit.rescuing, 'give'));
        break;
      }
      case 'Transfer': {
        if (!target) return;
        game.actionLog.doAction(new HasTradedAction(unit));
        game.actionLog.doAction(new TransferPairUpAction(unit, target, game.db));
        break;
      }
    }
    game.state.back();
  }

  override draw(surf: Surface): Surface {
    const game = getGame();
    surf = drawMap(surf, true);
    const unit: UnitObject | null = game.selectedUnit;
    if (unit && this.ability) {
      const [x, y] = this.cursorPos();
      const hovered: UnitObject | null = game.board.getUnit(x, y);
      const travelerOf = (u: UnitObject | null): UnitObject | null =>
        (u?.traveler ? game.getUnit(u.traveler) ?? null : null);
      if (this.ability === 'Rescue' && hovered) {
        drawCarryPreview(surf, game, 'rescue', unit, hovered,
          rescueEquation(game, 'RESCUE_AID', unit), rescueEquation(game, 'RESCUE_WEIGHT', hovered));
      } else if (this.ability === 'Take') {
        const traveler = travelerOf(hovered);
        if (traveler) {
          drawCarryPreview(surf, game, 'rescue', unit, traveler,
            rescueEquation(game, 'RESCUE_AID', unit), rescueEquation(game, 'RESCUE_WEIGHT', traveler));
        }
      } else if (this.ability === 'Give') {
        const traveler = travelerOf(unit);
        if (hovered && traveler) {
          drawCarryPreview(surf, game, 'give', traveler, hovered,
            rescueEquation(game, 'RESCUE_WEIGHT', traveler), rescueEquation(game, 'RESCUE_AID', hovered));
        }
      } else if (this.ability === 'Trade') {
        const target = hovered ?? unit;
        if (target !== unit) {
          const shown = this.travelerMode ? travelerOf(target) : target;
          if (shown) drawTradePreview(surf, game, shown);
        } else {
          const traveler = travelerOf(unit);
          if (traveler) drawTradePreview(surf, game, traveler);
        }
      }
    }
    if (this.pennant) {
      const tilemap = game.tilemap;
      const drawOnTop = !!tilemap && this.cursorPos()[1] >= tilemap.height - 1;
      this.pennant.draw(surf, drawOnTop);
    }
    return surf;
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
    // Python WeaponChoiceState.start: the sprite faces the cursor ('chosen').
    setSpritePose(unit, 'chosen');

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
    if (!unit.position) return;
    // Python WeaponChoiceState: target_system.get_attackable_positions.
    game.highlight.setAttackHighlights(
      attackablePositions(unit, weapon, [[unit.position[0], unit.position[1]]], game.board, game),
    );
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
      game.state.change('combat_targeting');
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
// UnlockSelectState — pick which key opens a region (find_unlock)
// ============================================================================

/**
 * Python general_states.UnlockSelectState: find_unlock pushes this when a
 * player unit carries more than one item able to open the region. A
 * menus.Choice over memory['all_unlock_items'] with the item description
 * panel; SELECT stores memory['unlock_item'] and pops, BACK cannot cancel.
 */
export class UnlockSelectState extends State {
  readonly name = 'unlock_select';
  override readonly transparent = true;

  private menu: ChoiceMenu | null = null;
  private unit: UnitObject | null = null;
  private items: ItemObject[] = [];

  override start(): StateResult {
    const game = getGame();
    this.unit = (game.memory.get('current_unit') as UnitObject | undefined) ?? null;
    this.items = [...((game.memory.get('all_unlock_items') as ItemObject[] | undefined) ?? [])];
    if (!this.unit || this.items.length === 0) {
      game.state.back();
      return 'repeat';
    }
    this.menu = new ChoiceMenu(this.items.map((item, index) => ({
      label: item.name,
      value: String(index),
      enabled: true,
      itemRow: itemMenuRow(this.unit!, item, game),
    })), 0, 8);
    placeAutoMenu(this.menu, game);
  }

  override begin(): StateResult {
    const game = getGame();
    if (game.cursor) game.cursor.visible = false;
  }

  override takeInput(event: InputEvent): StateResult {
    if (!this.menu) return;
    const game = getGame();
    if (game.input?.mouseMoved) {
      const [gx, gy] = game.input.getGameMousePos();
      this.menu.handleMouseHover(gx, gy);
    }
    let result: { selected: string } | { back: true } | null = null;
    if (game.input?.mouseClick === 'SELECT') {
      const [gx, gy] = game.input.getGameMousePos();
      result = this.menu.handleClick(gx, gy, 'SELECT');
    }
    if (!result && event === 'BACK') {
      // Python plays Error: the key has to be chosen.
      game.audioManager?.playSfx?.('Error');
      return;
    }
    if (!result && event !== null) result = this.menu.handleInput(event);
    if (!result || !('selected' in result)) return;
    const chosen = this.items[Number(result.selected)];
    if (!chosen) return;
    game.memory.set('unlock_item', chosen);
    this.menu = null;
    game.state.back();
  }

  override draw(surf: Surface): Surface {
    const game = getGame();
    const current = this.items[this.menu?.selectedIndex ?? -1];
    if (current && this.menu) drawItemDescriptionPanel(surf, game, this.unit, current);
    this.menu?.draw(surf);
    return surf;
  }
}

// ============================================================================
// 5b. TargetingState
// ============================================================================

export class TargetingState extends MapState {
  readonly name = 'combat_targeting';

  private targets: UnitObject[] = [];
  private targetIndex: number = 0;
  private selection: SelectionHelper | null = null;
  private attackerAssist: UnitObject | null = null;
  private defenderAssist: UnitObject | null = null;
  /** Fork multi_target weapons: positions chosen so far. */
  private chosenPositions: [number, number][] = [];

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
    this.chosenPositions = [];

    if (this.targets.length === 0) {
      game.state.back();
      return;
    }
    // Python SelectionHelper over the target-position set: start on the
    // target closest to the cursor (the unit); arrows move by direction.
    this.selection = new SelectionHelper(this.targets
      .filter((target) => !!target.position)
      .map((target) => [target.position![0], target.position![1]] as [number, number]));
    const byPos = (pos: [number, number] | null): UnitObject | undefined =>
      pos ? this.targets.find((t) => t.position?.[0] === pos[0] && t.position?.[1] === pos[1]) : undefined;
    this.targets = this.selection.posList.map((pos) => byPos(pos)).filter((t): t is UnitObject => !!t);
    const closest = byPos(this.selection.getClosest([unit.position[0], unit.position[1]]));
    this.targetIndex = closest ? Math.max(0, this.targets.indexOf(closest)) : 0;

    // Python CombatTargetingState.begin: game.cursor.combat_show().
    game.cursor.combatShow?.();
    // Position cursor on first target
    game.hud.prepareAttackInfo();
    this.focusTarget();
  }

  /** Move to the target at the position `next` picks from the current one. */
  private moveSelection(next: (pos: [number, number]) => [number, number] | null): void {
    const current = this.targets[this.targetIndex]?.position;
    if (!current) return;
    const pos = next([current[0], current[1]]);
    if (!pos) return;
    const idx = this.targets.findIndex((t) => t.position?.[0] === pos[0] && t.position?.[1] === pos[1]);
    if (idx < 0) return;
    this.targetIndex = idx;
    this.focusTarget();
  }

  private focusTarget(): void {
    const game = getGame();
    game.hud.resetInfo();
    const target = this.targets[this.targetIndex];
    if (target && target.position) {
      game.cursor.setPos(target.position[0], target.position[1]);
      const unit: UnitObject | null = game.selectedUnit;
      const weapon = unit ? getEquippedWeapon(unit, game.db, game) : null;
      if (unit && weapon) displaySingleAttack(game, unit, weapon, [target.position[0], target.position[1]]);
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

  /**
   * Engage the chosen target. A fork multi_target weapon first collects up
   * to num_targets units (Python CombatTargetingState._get_next_target: a
   * chosen unit leaves the selection unless allow_same_target, and selection
   * ends early once no other target remains).
   */
  private confirmTarget(target: UnitObject): void {
    const game = getGame();
    const unit: UnitObject = game.selectedUnit;
    const weapon = unit ? getEquippedWeapon(unit, game.db, game) : null;
    const wanted = weapon && isForkEngine() ? numTargets(unit, weapon) : 1;
    if (wanted > 1 && weapon && target.position) {
      this.chosenPositions.push([target.position[0], target.position[1]]);
      const sameTarget = allowSameTarget(unit, weapon);
      const pos: [number, number] = [target.position[0], target.position[1]];
      if (!sameTarget) {
        this.targets = this.targets.filter((candidate) => candidate !== target);
        this.selection?.removeTarget(pos);
      }
      if (this.chosenPositions.length < wanted && this.targets.length > 0) {
        // Python _get_next_target: the cursor moves to the closest remaining target.
        const closest = this.selection?.getClosest(pos);
        const idx = closest ? this.targets.findIndex((t) => t.position?.[0] === closest[0] && t.position?.[1] === closest[1]) : -1;
        this.targetIndex = idx >= 0 ? idx : Math.min(this.targetIndex, this.targets.length - 1);
        this.focusTarget();
        return;
      }
      if (this.chosenPositions.length > 1) {
        this.engageChosen();
        return;
      }
    }
    this.commitStrikePartners(target);
    game.combatTarget = target;
    game.highlight.clear();
    game.state.change('combat');
  }

  /** Fork multi_target: engage the positions chosen so far as one combat. */
  private engageChosen(): void {
    const game = getGame();
    const first = this.chosenPositions[0];
    const lone = first && this.chosenPositions.length === 1
      ? game.board.getUnit(first[0], first[1]) as UnitObject | null
      : null;
    if (lone) {
      this.commitStrikePartners(lone);
      game.combatTarget = lone;
    } else if (!enterForkMultiTargetCombat(game, this.chosenPositions)) {
      return;
    }
    game.highlight.clear();
    game.state.change('combat');
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
          this.confirmTarget(this.targets[this.targetIndex]);
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
      case 'DOWN':
      case 'RIGHT':
        // Python CombatTargetingState: SelectionHelper.get_<direction>.
        this.moveSelection((pos) => this.selection?.step(event, pos) ?? null);
        break;

      case 'AUX': {
        // Without pair up, AUX steps to the next target (get_next).
        if (!game.db.getConstant('pairup', false)) {
          this.moveSelection((pos) => this.selection?.getNext(pos) ?? null);
          game.audioManager?.playSfx?.('Select 6');
          break;
        }
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
        if (target) this.confirmTarget(target);
        break;
      }

      case 'START': {
        // Python: allow_less_than_max_targets lets START confirm early once
        // at least one target is chosen.
        const unit: UnitObject | null = game.selectedUnit;
        const weapon = unit ? getEquippedWeapon(unit, game.db, game) : null;
        if (unit && weapon && this.chosenPositions.length > 0 &&
            allowLessThanMaxTargets(unit, weapon)) {
          this.engageChosen();
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
 * EOtF engine fork `interaction.engage` for a multi_target item: every chosen
 * position's main target and splash join one splash list with no main
 * target, so the item resolves as a single counter-less combat (one use).
 * Upstream instead runs one item-target pair per position.
 */
export function resolveForkMultiTargetGroup(
  game: any,
  attacker: UnitObject,
  item: ItemObject,
  positions: [number, number][],
): {
  representative: UnitObject | null;
  mainDefender: null;
  splashDefenders: UnitObject[];
  splashStrikes: UnitObject[];
} {
  const splashStrikes: UnitObject[] = [];
  for (const position of positions) {
    const resolved = game.targetSystem?.getTargetFromPosition(attacker, item, position) ??
      { mainTarget: position, splash: [] };
    for (const target of [resolved.mainTarget, ...resolved.splash]) {
      if (!target) continue;
      const unit = game.board.getUnit(target[0], target[1]) as UnitObject | null;
      if (unit) splashStrikes.push(unit);
    }
  }
  // A position chosen again (the AI's `[target] * num_targets`,
  // allow_same_target) is kept in the strike list: the solver strikes that
  // unit once per entry, all in the same counter-less phase. Everything
  // else (participants, hooks, presentation) sees each unit once.
  const splashDefenders = [...new Set(splashStrikes)];
  return { representative: splashDefenders[0] ?? null, mainDefender: null, splashDefenders, splashStrikes };
}

/**
 * Hand a fork multi-target selection to CombatState: one chosen position is
 * an ordinary combat against it (Python passes the lone position, not a
 * list); several become one grouped combat.
 */
function enterForkMultiTargetCombat(game: any, positions: [number, number][]): UnitObject | null {
  const first = positions[0];
  const defender = first ? game.board.getUnit(first[0], first[1]) as UnitObject | null : null;
  if (!defender) return null;
  if (positions.length > 1) {
    game.memory.set('combat_multi_target_positions', positions.map((position) => [position[0], position[1]]));
  }
  game.combatTarget = defender;
  return defender;
}

/**
 * CombatState phases:
 * 1. 'combat' - Running the MapCombat animation (strikes, HP drain)
 * 2. 'death' - Death animation timer (fade-out)
 * 3. 'exp' - EXP bar animation
 * 4. 'levelup' - Level-up stat display
 * 5. 'cleanup' - Check win/loss, transition out
 */
type CombatPhase = 'combat' | 'anim_exit' | 'post_exp_events' | 'death' | 'exp_init' | 'exp_wait' | 'exp0' | 'exp100' | 'exp_leave' | 'level_up' | 'level_screen' | 'stole' | 'rank_up' | 'got_item' | 'broken_item' | 'cleanup';

/**
 * Python pushes an EventState per trigger and the stack runs the most recent
 * one first. Run each trigger thunk in Python call order and re-queue the
 * events they added so the FIFO queue runs them in Python's order: later
 * triggers first, each trigger's own matches in their usual order.
 */
function queueInStackOrder(game: any, triggers: Array<() => unknown>): GameEvent[] {
  const queue = game.eventManager?.eventQueue as GameEvent[] | undefined;
  if (!queue) return [];
  const slices: GameEvent[][] = [];
  for (const trigger of triggers) {
    const before = queue.length;
    trigger();
    slices.push(queue.splice(before));
  }
  const ordered = slices.reverse().flat();
  queue.push(...ordered);
  return ordered;
}

/**
 * Events a paused event (e.g. the one running interact_unit) must wait for:
 * when the interrupting events finish, EventState pops back to the state
 * above the paused event instead of resuming it there.
 */
const eventResumeBarriers: GameEvent[] = [];

/**
 * Run freshly queued events (at the end of the queue) before anything that
 * was already waiting, as Python's newly pushed EventStates do. A paused
 * event at the front (interact_unit's caller) resumes only after them; when
 * `pushState` is set an EventState opens on top of the current state now,
 * and the paused event is fenced so it resumes in its own EventState.
 */
export function runEventsBeforeWaiting(game: any, events: GameEvent[], pushState: boolean): boolean {
  const queue = game.eventManager?.eventQueue as GameEvent[] | undefined;
  if (!queue || events.length === 0) return false;
  for (const event of events) {
    const index = queue.indexOf(event);
    if (index >= 0) queue.splice(index, 1);
  }
  const waiting = queue[0] ?? null;
  queue.unshift(...events);
  if (pushState) {
    if (waiting) eventResumeBarriers.push(waiting);
    game.state.change('event');
  }
  return true;
}

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
  /** Frame clock for the combat level screen (Python ExpState current_time). */
  private levelScreenClock = 0;
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
  /** Python handle_broken_items alerts, newest (shown first) first. */
  private brokenBanners: Banner[] | null = null;
  private brokenBanner: Banner | null = null;
  private gotItemBanner: Banner | null = null;
  private gotItemBannerQueue: Banner[] = [];
  private pendingDiscards: Array<{ unit: UnitObject; item: ItemObject }> = [];
  private rankUpBannerShown: boolean = false;
  /** clean_up1 break events and clean_up2 unit_death events were queued. */
  private postExpEventsQueued: boolean = false;
  /** Events triggered with the results but run later, in Python's order. */
  private heldBreakEvents: GameEvent[] = [];
  private heldRankUpEvents: GameEvent[] = [];
  private heldEndEvents: GameEvent[] = [];
  /**
   * CombatEnd's events, triggered before end_combat and handle_death (the
   * fork's clean_up, upstream's clean_up2). They stay queued (EventStates
   * under 'dying') behind the UnitDeath events and run at cleanup; null
   * until triggered.
   */
  private pendingCombatEndEvents: GameEvent[] | null = null;
  /**
   * EOtF's engine fork (v1.90 simple_combat.clean_up / animation_combat
   * clean_up2) ends combat in one pass instead of upstream's clean_up0/1/2:
   * no combat_death trigger and no unit_weapon_rank_up trigger; wexp, exp and
   * records are handled after CombatEnd, and end_combat, UnitDeath and the
   * broken-item checks come last. Its EventStates (newest on top) therefore
   * run broken items -> unit_death -> dying fade -> end_combat hook events ->
   * map exp screen -> item gain -> combat_end. Animation combat shows exp in
   * the battle scene (clean_up1), as upstream does.
   */
  private forkCleanup: boolean = false;
  /** Fork map combat: the exp screen waits for the end_combat hook events. */
  private deferredExp: boolean = false;
  /** Fork: the end_combat hook events were handed to an EventState. */
  private endEventsRun: boolean = false;
  /** The presented phase's strike events were handed to an EventState. */
  private strikeEventsStarted: boolean = false;
  /**
   * Python pushes a fresh CombatState for every combat; the web's states are
   * singletons. A combat started by an event that runs during another combat
   * (EOtF event_before_combat follow-up attacks, event_on_hit combats) saves
   * the outer combat here and restores it once it is popped.
   */
  private suspendedCombats: Array<Record<string, unknown>> = [];
  private drawFrame = -1;
  private drawCalls = 0;
  private static readonly NESTING_KEPT = new Set([
    'name', 'transparent', 'inLevel', 'showMap', 'started', 'processed',
    'suspendedCombats', 'drawFrame', 'drawCalls',
  ]);

  override start(): StateResult {
    const game = getGame();
    const depth = (game.state.getStackNames() as string[]).filter((name) => name === this.name).length;
    if (depth <= 1 || !this.initialized) return;
    const saved: Record<string, unknown> = {};
    const fresh = new CombatState() as unknown as Record<string, unknown>;
    const self = this as unknown as Record<string, unknown>;
    for (const key of Object.keys(fresh)) {
      if (CombatState.NESTING_KEPT.has(key)) continue;
      saved[key] = self[key];
      self[key] = fresh[key];
    }
    this.suspendedCombats.push(saved);
  }

  override finish(): void {
    animationViewbox = null;
    const saved = this.suspendedCombats.pop();
    if (!saved) {
      // Cleared off the stack mid-combat (a game over from a UnitDeath
      // event, a level change): Python drops that CombatState, so the next
      // combat must not resume this one.
      if (this.initialized) {
        const fresh = new CombatState() as unknown as Record<string, unknown>;
        const self = this as unknown as Record<string, unknown>;
        for (const key of Object.keys(fresh)) {
          if (!CombatState.NESTING_KEPT.has(key)) self[key] = fresh[key];
        }
      }
      return;
    }
    Object.assign(this, saved);
    // The outer combat is still under way: keep the map clear of its UI.
    const game = getGame();
    game.cursor.visible = false;
    game.hud.visible = false;
  }

  /** Run `trigger` and take the events it queued back out of the queue. */
  private captureEvents(trigger: () => unknown): GameEvent[] {
    const queue = getGame().eventManager?.eventQueue as GameEvent[] | undefined;
    if (!queue) {
      trigger();
      return [];
    }
    const before = queue.length;
    trigger();
    return queue.splice(before);
  }

  /**
   * Python end_combat: per participant (attacker, its strike partner, the
   * defender's partner, each defender) skill hooks then the item's hooks,
   * each trigger pushing an EventState. The stack runs them newest first.
   */
  private orderEndCombatEvents(skillEvents: GameEvent[], itemEvents: GameEvent[]): GameEvent[] {
    const active = this.getActiveCombat();
    const participants: UnitObject[] = [];
    const add = (unit: UnitObject | null | undefined) => {
      if (unit && !participants.includes(unit)) participants.push(unit);
    };
    if (active) {
      add(active.attacker);
      add(active.attacker.strikePartner);
      add(active.defender?.strikePartner);
      for (const defender of this.getCombatDefenders()) add(defender);
    }
    const ordered: GameEvent[] = [];
    const take = (events: GameEvent[], unit: UnitObject | null) => {
      for (const event of events) {
        if (ordered.includes(event)) continue;
        if (unit === null || event.trigger?.unit1 === unit) ordered.push(event);
      }
    };
    for (const unit of participants) {
      take(skillEvents, unit);
      take(itemEvents, unit);
    }
    take(skillEvents, null);
    take(itemEvents, null);
    return ordered.reverse();
  }

  /**
   * Python's solver fires a phase's on_hit / after_strike / after_take_strike
   * events while it resolves the phase; the EventStates they push run
   * (newest trigger first) before the phase's hit is shown. The combat asks
   * for them as it resolves each phase and pauses before presenting it.
   */
  private triggerStrikeEvents(phase: CombatStrike[]): GameEvent[] {
    const game = getGame();
    if (!game.eventManager) return [];
    return this.captureEvents(() => {
      for (const strike of phase) {
        queueStrikeItemEvents(game, strike, 0);
        queueStrikeSkillEvents(game, strike);
      }
    }).reverse();
  }

  /**
   * Run the presented phase's strike events over the combat, and resume the
   * combat once they have all run. Returns whether the combat must wait.
   */
  private runPendingStrikeEvents(combat: MapCombat | AnimationCombat): boolean {
    const pending = combat.pendingStrikeEvents as GameEvent[] | null;
    if (!pending) return false;
    const game = getGame();
    const queue = (game.eventManager?.eventQueue ?? []) as GameEvent[];
    // Not started: they were taken out of the queue when triggered. Started:
    // any still queued did not get to run yet.
    const waiting = this.strikeEventsStarted
      ? pending.filter((event) => queue.includes(event))
      : pending;
    if (waiting.length > 0 && runEventsBeforeWaiting(game, waiting, true)) {
      this.strikeEventsStarted = true;
      return true;
    }
    this.strikeEventsStarted = false;
    combat.resumeAfterStrikeEvents();
    return false;
  }

  /** clean_up0: combat_death, run over the combat before the exp screen. */
  private runMidCombatEvents(): boolean {
    const game = getGame();
    // EOtF's engine fork has no combat_death trigger.
    if (!game.eventManager || this.forkCleanup) return false;
    const events = this.captureEvents(() => queueInStackOrder(game, this.deathTriggers('combat_death')));
    return runEventsBeforeWaiting(game, events, true);
  }

  /**
   * Trigger CombatEnd for the active combat. `capture` takes its events back
   * out of the queue for the caller to run; otherwise they stay queued.
   */
  private triggerCombatEnd(capture: boolean): GameEvent[] {
    const game = getGame();
    const active = this.getActiveCombat();
    if (!game.eventManager || !active) return [];
    const attacker = active.attacker;
    // EOtF's SimpleCombat.defender is None unless the combat has exactly one
    // main defender: a bomb thrown at an empty tile ends with no unit2.
    const defender = isForkEngine()
      ? this.getPrimaryCombatDefender()
      : this.getPrimaryCombatDefender() ?? active.defender;
    const ctx = { game, unit1: attacker, unit2: defender, gameVars: game.gameVars, levelVars: game.levelVars };
    const trigger = () => game.eventManager.trigger(
      {
        type: 'combat_end', unit1: attacker, unit2: defender, levelNid: game.currentLevel?.nid,
        position: this.results?.deathPositions?.get(attacker) ?? attacker.position,
        item: active.attackItem,
        isAnimationCombat: this.isAnimationCombat,
        // Python CombatEnd(..., self.full_playback): brush objects
        // (p.nid, p.attacker, p.main_attacker), not raw strikes.
        playback: playbackMarks(active.strikes, attacker, defender ?? null),
      },
      { ...ctx, position: attacker.position, item: active.attackItem },
    );
    if (capture) return this.captureEvents(trigger);
    const queue = game.eventManager.eventQueue as GameEvent[];
    const before = queue.length;
    trigger();
    return queue.slice(before);
  }

  /** One trigger thunk per dying unit (defenders, then the attacker). */
  private deathTriggers(type: 'combat_death' | 'unit_death'): Array<() => unknown> {
    const game = getGame();
    const active = this.getActiveCombat();
    if (!active || !game.eventManager) return [];
    const levelNid = game.currentLevel?.nid;
    const attacker = active.attacker;
    const defender = this.getPrimaryCombatDefender() ?? active.defender;
    const ctx = { game, unit1: attacker, unit2: defender, gameVars: game.gameVars, levelVars: game.levelVars };
    const dying: Array<{ unit: UnitObject; fallbackKiller: UnitObject }> = [
      ...this.getDefenderDeaths().map((unit) => ({ unit, fallbackKiller: attacker })),
      ...(this.results?.attackerDead ? [{ unit: attacker, fallbackKiller: defender }] : []),
    ];
    return dying.map(({ unit, fallbackKiller }) => () => {
      const killer = this.getCombatKiller(unit) ?? fallbackKiller;
      return game.eventManager.trigger(
        {
          type,
          unit1: unit,
          unit2: killer,
          unitNid: unit.nid,
          position: this.results?.deathPositions?.get(unit) ?? unit.position,
          levelNid,
        },
        { ...ctx, unit1: unit, unit2: killer },
      );
    });
  }

  /**
   * After the exp screen: Python's clean_up1 events (weapon rank, broken
   * items) and then clean_up2's UnitDeath, which runs before the dying fade.
   * Returns whether an EventState was opened over the combat.
   */
  private queuePostExpEvents(): boolean {
    const game = getGame();
    if (!game.eventManager) return false;
    // Upstream clean_up2 triggers CombatEnd before end_combat and
    // handle_death, so its events wait queued under the UnitDeath ones.
    if (!this.forkCleanup && !this.pendingCombatEndEvents) {
      this.pendingCombatEndEvents = this.triggerCombatEnd(false);
    }
    const unitDeath = this.captureEvents(() => queueInStackOrder(game, this.deathTriggers('unit_death')));
    const events = [...this.heldRankUpEvents, ...this.heldBreakEvents, ...unitDeath];
    this.heldRankUpEvents = [];
    this.heldBreakEvents = [];
    return runEventsBeforeWaiting(game, events, true);
  }

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
    this.eventCombat = !!game.eventCombat;

    if (!attacker || !defender) {
      game.state.back();
      return;
    }

    const selectedCombatItem = game.memory.get('combat_item') as ItemObject | undefined;
    game.memory.delete('combat_item');
    const selectedCombatPosition = game.memory.get('combat_target_position') as
      [number, number] | undefined;
    game.memory.delete('combat_target_position');
    const multiTargetPositions = game.memory.get('combat_multi_target_positions') as
      [number, number][] | undefined;
    game.memory.delete('combat_multi_target_positions');
    const attackItem = selectedCombatItem ?? getEquippedWeapon(attacker, game.db, game);
    if (!attackItem) {
      game.state.back();
      return;
    }
    const forkMultiTarget = isForkEngine() && (multiTargetPositions?.length ?? 0) > 1
      ? resolveForkMultiTargetGroup(game, attacker, attackItem, multiTargetPositions!)
      : null;
    const targetGroup = forkMultiTarget?.representative
      ? { ...forkMultiTarget, representative: forkMultiTarget.representative }
      : resolveCombatTargetGroup(
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
    // Python start_combat: event_before_combat and similar hooks each push
    // an EventState, run (newest first) before the first phase is solved.
    const startEvents: GameEvent[] = [];
    if (primaryDefender || isForkEngine()) {
      startEvents.push(...this.captureEvents(() =>
        queueCombatSkillStartEvents(
          game, attacker, primaryDefender ?? null, attackItem, defenseItem,
          isForkEngine() ? splashDefenders : [],
        )));
    }
    const rngMode = game.rngMode;

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
    startEvents.push(...this.captureEvents(() => applyCombatParticipantItemStartHooks(
      game,
      attacker,
      attackItem,
      [
        ...(primaryDefender ? [primaryDefender] : []),
        ...splashDefenders,
      ],
    )));

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
        groupedCombat
          ? {
            mainDefender: primaryDefender,
            splashDefenders,
            ...(forkMultiTarget ? { splashStrikes: forkMultiTarget.splashStrikes } : {}),
          }
          : undefined,
        game,
        { deferSolve: true },
      );
      this.combat.strikeEventHook = (phase) => this.triggerStrikeEvents(phase);
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
    this.brokenBanners = null;
    this.brokenBanner = null;
    this.gotItemBanner = null;
    this.gotItemBannerQueue = [];
    this.pendingDiscards = [];
    this.rankUpBannerShown = false;
    this.postExpEventsQueued = false;
    this.heldBreakEvents = [];
    this.heldRankUpEvents = [];
    this.heldEndEvents = [];
    this.pendingCombatEndEvents = null;
    this.forkCleanup = isForkEngine();
    this.deferredExp = false;
    this.endEventsRun = false;
    this.strikeEventsStarted = false;
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
        const attackerBattle = unitHasTag(attacker, 'Boss') ? levelMusic.boss_battle : null;
        const defenderBattle = defender && unitHasTag(defender, 'Boss') ? levelMusic.boss_battle : null;
        const teamBattle = levelMusic[`${attacker.team}_battle`];
        const battleTrack = attackerBattle || defenderBattle || teamBattle;
        if (battleTrack) {
          const fromStart = !!game.db.getConstant?.('restart_battle_music', true);
          this.battleMusic = game.audioManager.battleFadeIn(battleTrack, 400, fromStart);
        }
      };
      this.animCombat.onFinish = () => this.fadeBackBattleMusic();
    }

    const combatStartEvents = this.captureEvents(() => game.eventManager?.trigger(
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
    ));
    // start_event's CombatStart is pushed after start_combat's hooks, so it
    // runs first. The combat waits underneath: its first phase is solved
    // only once these have run (deferSolve).
    runEventsBeforeWaiting(game, [...combatStartEvents, ...startEvents.reverse()], true);
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
        { deferSolve: true },
      );
      this.animCombat.strikeEventHook = (phase) => this.triggerStrikeEvents(phase);

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
        // deaths, and jump straight to cleanup. UnitDeath events still run
        // before the units die, as clean_up2 does.
        game.audioManager?.stopSfx?.('Experience Gain');
        if (!this.postExpEventsQueued) {
          this.phase = 'post_exp_events';
        } else {
          this.finishDeathsNow();
          this.phase = 'cleanup';
        }
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
    animationViewbox = this.isAnimationCombat ? this.animCombat?.viewbox ?? null : null;
    if (!activeCombat) return;
    const game = getGame();

    // Use real frame delta for consistent timing across refresh rates
    const realDelta = game.frameDeltaMs ?? FRAMETIME;

    switch (this.phase) {
      case 'combat': {
        // A phase's strike events run over the combat before its hit.
        if (this.runPendingStrikeEvents(activeCombat)) break;
        // Pass real delta to combat (skip mode is handled inside AnimationCombat)
        const done = activeCombat.update(realDelta);
        if (this.runPendingStrikeEvents(activeCombat)) break;
        // Python AnimationCombat applies clean_up1 (exp, wexp, items) while
        // the scene is still shown: results come in at exp_wait, the exp bar
        // draws over the battle, and the scene then slides out (anim_exit).
        const animReadyForExp = this.isAnimationCombat && this.animCombat?.state === 'exp_wait';
        if ((done || animReadyForExp) && !this.results) {
          // Event hooks are triggered here, where their arguments still see
          // the combat's units on the map, but run in Python's order (see
          // runMidCombatEvents / queuePostExpEvents / the cleanup phase).
          const initiatedPartner = activeCombat.attacker.strikePartner;
          const initiatedEvents = this.captureEvents(() => {
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
          });
          this.results = activeCombat.applyResults(game.actionLog);
          game.actionLog.doAction(new HasAttackedAction(activeCombat.attacker));
          // Python on_broken runs in clean_up1, so these follow the exp screen.
          this.heldBreakEvents = this.captureEvents(() =>
            queueCombatItemBreakEvents(game, activeCombat.strikes)).reverse();
          applyCombatItemEndHooks(game, activeCombat.strikes);
          const skillEndEvents = [
            ...initiatedEvents,
            ...this.captureEvents(() => queueCombatEndSkillEvents(
              game,
              activeCombat.strikes,
              activeCombat.attacker,
              activeCombat.defender,
              activeCombat.attackItem,
              activeCombat.defenseItem,
            )),
          ];
          applyCombatSkillEndHooks(
            game,
            activeCombat.strikes,
            activeCombat.attacker,
            // EOtF's engine passes solver.defender, None for a combat with no
            // main target (line/all-enemy AOE, merged multi-target).
            isForkEngine() && !this.getPrimaryCombatDefender() ? null : activeCombat.defender,
            activeCombat.procPlayback,
          );
          applyUnusableCombatItems(game, [
            [activeCombat.attacker, activeCombat.attackItem],
            [this.getPrimaryCombatDefender(), activeCombat.defenseItem],
          ]);
          const itemEndEvents = this.captureEvents(() =>
            queueCombatEndItemEvents(game, activeCombat.strikes));
          this.heldEndEvents = this.orderEndCombatEvents(skillEndEvents, itemEndEvents);
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
            acquiredItemText(unit.name, item.name, bannerItemColor(item)), itemIcon(item), 3000, { sound: 'Item' },
          ));
          this.pendingDiscards = pickupResult.pendingDiscards;
          if (this.results.attackerRankUp) {
            const rankUp = this.results.attackerRankUp;
            const weaponType = activeCombat.attackItem.getComponent<string>('weapon_type');
            const wexpGained = this.results.attackerWexpGained;
            // EOtF's engine fork has no unit_weapon_rank_up trigger.
            if (weaponType && !this.forkCleanup) this.heldRankUpEvents = this.captureEvents(() => game.eventManager?.trigger(
                {
                  type: 'unit_weapon_rank_up',
                  levelNid: game.currentLevel?.nid ?? '',
                  unitNid: activeCombat.attacker.nid,
                  unit1: activeCombat.attacker,
                  weaponType,
                  oldWexp: (activeCombat.attacker.wexp[weaponType] ?? 0) - wexpGained,
                  rank: rankUp.rank,
                },
                {
                  game,
                  unit1: activeCombat.attacker,
                  unit2: this.getPrimaryCombatDefender() ?? activeCombat.defender,
                  gameVars: game.gameVars,
                  levelVars: game.levelVars,
                },
              ));
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
          // EOtF's engine (simple_combat.clean_up) triggers CombatEnd right
          // after should_die and handle_state_stack, before end_combat and
          // handle_death: its events wait under the dying and UnitDeath
          // states, so a game over from a UnitDeath event leaves them queued.
          if (this.forkCleanup) this.pendingCombatEndEvents = this.triggerCombatEnd(false);
          for (const unit of this.combatPresentationUnits()) {
            if (this.dyingUnits.includes(unit)) markDying(unit);
            else if (isUnitDying(unit)) { // miracle: DeathManager.miracle
              clearUnitFx(unit);
              unit.isDying = false;
            }
          }
          this.deathStarted = false;
          // clean_up0: combat_death runs over the combat before the exp
          // screen (the strikes' own events already ran between strikes).
          const pausedForEvents = this.runMidCombatEvents();
          const gainsExp = this.results.expGained > 0 && this.expUnit() !== null;
          // The fork's map combat pushes ExpState in its one clean_up, under
          // the dying and end_combat states, so the bar shows after them.
          this.deferredExp = gainsExp && this.forkCleanup && !this.isAnimationCombat;
          if (gainsExp && !this.deferredExp) {
            this.startExpPhase();
          } else if (pausedForEvents) {
            this.phase = 'post_exp_events';
            this.phaseTimer = 0;
          } else {
            this.startRankUpOrCleanup();
          }
        }
        break;
      }

      case 'post_exp_events':
        // Resumed after the clean_up1/clean_up2 events pushed over combat.
        this.startRankUpOrCleanup();
        break;

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
        // Python ExpState 'level_up' moves on once the LevelUpMap /
        // LevelUpBattle logo finishes. ExpState.draw advances the logo as
        // well, so it plays at twice its authored speed (see drawExpAndLevelUp).
        // Without a logo the 500 ms pause stands in.
        let logoDone = false;
        if (this.levelUpLogo) {
          logoDone = this.levelUpLogo.update() || this.phaseTimer >= 4000;
          if (!logoDone) break;
        }
        if (logoDone || this.phaseTimer >= 500) {
          this.levelScreenClock = 0;
          // Python ExpState: combat_object.darken_ui() as the screen opens.
          this.animCombat?.darkenUi();
          this.phase = 'level_screen';
          this.phaseTimer = 0;
          // Create the LevelUpScreen
          const unit = this.expUnit();
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
        // Update the LevelUpScreen animation on frame time, like Python's
        // ExpState (engine.get_time advances once per frame).
        this.levelScreenClock += realDelta;
        const now = this.levelScreenClock;
        if (this.levelUpScreen) {
          const result = this.levelUpScreen.update(now);
          if (result === 'entered_level_up_wait') {
            this.fireDuringUnitLevelUpTrigger();
          } else if (result === 'done') {
            // Python ExpState: combat_object.lighten_ui() once it closes.
            this.animCombat?.lightenUi();
            this.afterUnitLevelUp();
          }
        } else {
          // No screen object — skip
          this.afterUnitLevelUp();
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

      case 'broken_item': {
        if (!this.brokenBanner || this.brokenBanner.update(realDelta)) {
          this.brokenBanner = null;
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
          // Python handle_state_stack: an AI combat with Canto just returns
          // to the AI, whose canto step sets the movement itself.
          const stackForCanto: string[] = game.state.getStackNames?.() ?? [];
          if (hasCanto && stackForCanto[stackForCanto.length - 2] !== 'ai') {
            game.actionLog.doAction(new SetMovementLeftAction(
              attacker,
              cantoMovement(attacker, defender, game),
            ));
          }

        }

        // Python clean_up2 triggers CombatEnd and then the end_combat item and
        // skill hooks (UnitDeath ran before the dying fade); the stack runs
        // the newest first, so the hooks run before combat_end.
        let cleanupEvents: GameEvent[] = [];
        if (game.eventManager) {
          const queue = game.eventManager.eventQueue as GameEvent[];
          const combatEnd = this.pendingCombatEndEvents
            ? this.pendingCombatEndEvents.filter((event) => queue.includes(event))
            : this.triggerCombatEnd(true);
          this.pendingCombatEndEvents = null;
          cleanupEvents = [...this.heldEndEvents, ...combatEnd];
          this.heldEndEvents = [];
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
        const wasEventCombat = this.eventCombat;
        game.eventCombat = false;
        const stackNames: string[] = game.state.getStackNames?.() ?? [];
        const aiCombat = stackNames[stackNames.length - 2] === 'ai';

        game.state.back();

        // Python handle_state_stack: an event combat leaves the stack alone;
        // an AI combat without Canto pushes 'wait' over the AI; a player
        // attack that neither returns to the menu nor has Canto clears to
        // free + 'wait'. WaitState then waits the attacker through
        // unit.wait() (unit_wait, not actively chosen) after the end-of-combat
        // events pushed above it.
        if (!wasEventCombat && !hasCanto) {
          if (aiCombat) {
            game.state.change('wait');
          } else if (attacker.isDead() || !returnsToMenu) {
            // Python checks attacker.is_dying before the menu/Canto routing:
            // a player attacker that died also clears to free + wait.
            game.selectedUnit = null;
            game._moveOrigin = null;
            game._moveAction = null;
            game.highlight.clear();
            game.state.clear();
            game.state.change('free');
            game.state.change('wait');
          }
        }

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
          // stack preserves menu/Canto/trade while combat events run. An AI
          // combat (a player unit's AI on End included) returns to the AI,
          // which moves a Canto unit itself (handle_state_stack's ai branch).
          if (aiCombat) {
            // nothing: AIState continues
          } else if (tradePair) {
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

          if (!runEventsBeforeWaiting(game, cleanupEvents, true) &&
              game.eventManager?.hasActiveEvents()) {
            game.state.change('event');
          }
        } else {
          // interact_unit: its paused event resumes after these, as Python's
          // EventStates pushed above it run first.
          runEventsBeforeWaiting(game, cleanupEvents, false);
        }
        break;
      }
    }
  }

  /** The unit whose combat exp is shown (Python handle_exp's attacker or defender). */
  private expUnit(): UnitObject | null {
    if (this.results?.expUnit !== undefined) return this.results.expUnit;
    const attacker = this.getActiveCombat()?.attacker ?? null;
    return attacker?.team === 'player' ? attacker : null;
  }

  private startExpPhase(): void {
    const game = getGame();
    // Calculate EXP bar parameters (faithful to Python ExpState.start)
    const totalExp = this.results!.expGained;
    const currentExp = this.expUnit()?.exp ?? 0;
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
    const expUnit = this.expUnit();
    if (hasLevelUp && expUnit) {
      const unit = expUnit;
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
    const unit = this.expUnit();
    if (!game?.eventManager || !unit || !this.levelUpGains) return;
    const gains = { ...this.levelUpGains };
    const events = this.captureEvents(() => game.eventManager.trigger(
      {
        type: 'during_unit_level_up',
        levelNid: game.currentLevel?.nid ?? '',
        unitNid: unit.nid,
        unit1: unit,
        statChanges: gains,
        source: 'exp_gain',
      },
      { game, unit1: unit, gameVars: game.gameVars, levelVars: game.levelVars },
    ));
    // Ahead of an interact_unit caller waiting in the queue.
    runEventsBeforeWaiting(game, events, true);
  }

  /**
   * Python ExpState fires UnitLevelUp when the level screen closes; its
   * EventState runs before the combat continues to clean_up2.
   */
  private afterUnitLevelUp(): void {
    if (this.fireUnitLevelUpTrigger()) {
      this.phase = 'post_exp_events';
      this.phaseTimer = 0;
    } else {
      this.startRankUpOrCleanup();
    }
  }

  /**
   * Fire the `unit_level_up` trigger for a combat-driven level-up, mirroring
   * Python's level_up.py:279 `game.events.trigger(triggers.UnitLevelUp(self.unit,
   * self.stat_changes, self.source))` call which fires for every level-up
   * (not just `autolevel_to`, which already dispatches this trigger separately
   * at the event-command call site).
   */
  private fireUnitLevelUpTrigger(): boolean {
    const game = getGame();
    const unit = this.expUnit();
    if (!game?.eventManager || !unit || !this.levelUpGains) return false;
    const gains = { ...this.levelUpGains };
    const events = this.captureEvents(() => game.eventManager.trigger(
      {
        type: 'unit_level_up',
        levelNid: game.currentLevel?.nid ?? '',
        unitNid: unit.nid,
        unit1: unit,
        statChanges: gains,
        source: 'exp_gain',
      },
      { game, unit1: unit, gameVars: game.gameVars, levelVars: game.levelVars },
    ));
    return runEventsBeforeWaiting(game, events, true);
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

  /**
   * Python handle_broken_items: an alert for the attacker's broken item and
   * then the defender's (AlertState shows the newest first), each only for a
   * player unit that is not dying, never when a unit targeted itself.
   */
  private brokenItemBanners(): Banner[] {
    const combat = this.getActiveCombat();
    const results = this.results;
    if (!combat || !results) return [];
    const attacker = combat.attacker;
    const defender = this.getPrimaryCombatDefender() ?? combat.defender ?? null;
    const banners: Banner[] = [];
    if (results.attackWeaponBroke && combat.attackItem &&
        shouldAlertBrokenItem(attacker, combat.attackItem, defender)) {
      banners.push(brokenItemBanner(combat.attackItem));
    }
    if (results.defenseWeaponBroke && defender && combat.defenseItem && attacker !== defender &&
        shouldAlertBrokenItem(defender, combat.defenseItem, attacker)) {
      banners.push(brokenItemBanner(combat.defenseItem));
    }
    return banners.reverse();
  }

  private startRankUpOrCleanup(): void {
    if (this.isAnimationCombat && this.animCombat && this.animCombat.state !== 'done') {
      this.animCombat.expDone = true;
      this.phase = 'anim_exit';
      this.phaseTimer = 0;
      return;
    }
    // Python handle_broken_items pushes its alerts after on_broken's events,
    // so the banners show before them (and, upstream, after the exp screen;
    // the fork checks broken items last, so before everything else).
    if (this.brokenBanners === null) this.brokenBanners = this.brokenItemBanners();
    if (this.brokenBanners.length > 0) {
      this.brokenBanner = this.brokenBanners.shift() as Banner;
      this.phase = 'broken_item';
      this.phaseTimer = 0;
      return;
    }
    if (!this.postExpEventsQueued) {
      this.postExpEventsQueued = true;
      if (this.queuePostExpEvents()) {
        this.phase = 'post_exp_events';
        this.phaseTimer = 0;
        return;
      }
    }
    // Python DeathManager.miracle: a unit_death event that resurrected a
    // dying unit (EOtF TakenPrisoner) took it off dying_units.
    this.dyingUnits = this.dyingUnits.filter((unit) => isUnitDying(unit));
    if (this.dyingUnits.length > 0) {
      this.phase = 'death';
      this.phaseTimer = 0;
      return;
    }
    if (this.forkCleanup && !this.endEventsRun) {
      // Fork: end_combat's item/skill hook events run after the dying fade,
      // ahead of the map exp screen, item gain and combat_end.
      this.endEventsRun = true;
      const endEvents = this.heldEndEvents;
      this.heldEndEvents = [];
      if (runEventsBeforeWaiting(getGame(), endEvents, true)) {
        this.phase = 'post_exp_events';
        this.phaseTimer = 0;
        return;
      }
    }
    if (this.deferredExp) {
      this.deferredExp = false;
      this.startExpPhase();
      return;
    }
    const activeCombat = this.getActiveCombat();
    if (this.results?.stolenItem && activeCombat && !this.stoleBannerShown) {
      // Python banner.StoleItem through AlertState.
      const stolen = this.results.stolenItem;
      const allied = getGame().db.areAllied?.('player', activeCombat.attacker.team) ?? activeCombat.attacker.team === 'player';
      this.stoleBanner = new Banner(
        stoleItemText(activeCombat.attacker.name, stolen.name, bannerItemColor(stolen)), itemIcon(stolen), 3000,
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
    animationViewbox = null;
    // Stop looping EXP SFX if still playing
    const game = getGame();
    game.audioManager?.stopSfx?.('Experience Gain');
    game.memory.delete('combat_strike_partners_selected');
    // Events between strikes cover a combat still being solved, whose later
    // phases need the strike partners.
    const active = this.getActiveCombat();
    if (active && (this.results || this.phase !== 'combat')) {
      active.attacker.strikePartner = null;
      active.defender.strikePartner = null;
    }
  }

  override draw(surf: Surface): Surface {
    // Nested combats share this instance: draw it once, at the top copy.
    if (this.suspendedCombats.length > 0) {
      const frame = getFrameCount();
      if (this.drawFrame !== frame) {
        this.drawFrame = frame;
        this.drawCalls = 0;
      }
      this.drawCalls++;
      if (this.drawCalls <= this.suspendedCombats.length) return surf;
    }
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
    // The fork pops its combat state before any of that, exp included.
    if (this.phase !== 'death' && this.phase !== 'post_exp_events' &&
        !(this.forkCleanup && this.postExpEventsQueued)) {
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
   * state) and the fuzz (25% black) outside the viewbox; AnimationCombat.draw adds
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
      // Python ExpState.draw calls level_up_animation.update() again.
      this.levelUpLogo?.update();
      this.levelUpLogo?.draw(surf, 0, 0);
    }

    // Level-up stat screen
    if (this.phase === 'level_screen' && this.levelUpScreen) {
      this.levelUpScreen.draw(surf, this.levelScreenClock);
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
    if (this.phase === 'broken_item' && this.brokenBanner) {
      this.brokenBanner.draw(surf);
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
  private pendingCombatTile: [number, number] | null = null;
  /** Python unit.has_run_ai for this AI phase. */
  private ranAi = new Set<UnitObject>();
  /** Python AIState.cur_group: the last picked unit's AI group. */
  private curGroup: string | null = null;
  /** A unit that acted and waits (unit.wait()) once its events finish. */
  private pendingWaitUnit: UnitObject | null = null;

  /**
   * Python AIState.get_next_unit: an unfinished unit of the phase's team on
   * the map whose AI has not run; members of the last unit's AI group first,
   * then highest AI priority, then nearest to an enemy.
   */
  private pickNextUnit(game: any): UnitObject | null {
    const team = game.phase.getCurrent();
    const valid = (game.getAllUnits() as UnitObject[]).filter((unit) =>
      !!unit.position && !unit.finished && !unit.isDead() && !this.ranAi.has(unit) && unit.team === team);
    if (valid.length === 0) return null;
    let pool = valid;
    if (this.curGroup) {
      const groupUnits = valid.filter((unit) => unit.aiGroup === this.curGroup);
      if (groupUnits.length > 0) pool = groupUnits;
      else this.curGroup = null;
    }
    const priority = (unit: UnitObject) => Number(game.db.ai.get(changeAi(unit, unit.ai, game))?.priority ?? 0);
    const distance = (unit: UnitObject) => {
      const position = unit.position as [number, number];
      let best = -1;
      for (const other of game.getAllUnits() as UnitObject[]) {
        if (!other.position || other === unit || !checkEnemy(other, unit, game.db, game)) continue;
        const d = Math.abs(other.position[0] - position[0]) + Math.abs(other.position[1] - position[1]);
        if (best < 0 || d < best) best = d;
      }
      return best;
    };
    const ranked = pool
      .map((unit, index) => ({ unit, index, priority: priority(unit), distance: distance(unit) }))
      .sort((a, b) => b.priority - a.priority || a.distance - b.distance || a.index - b.index);
    return ranked[0].unit;
  }

  /** Python AIState: a unit that did something waits through unit.wait(). */
  private waitAfterAct(game: any, unit: UnitObject): void {
    waitUnit(game, unit, false);
    if (game.eventManager?.hasActiveEvents()) {
      this.waitingForEvent = true;
      game.state.change('event');
      return;
    }
    this.advanceToNextUnit();
  }

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
      // Python AIController.move: action.Move.
      const warp = new WarpUnitAction(unit, target, game.board);
      warp.turnwheelMove = true;
      game.actionLog.doAction(warp);
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

  /**
   * Python AIState.start: the phase's bookkeeping is reset once per
   * activation. begin() runs again whenever a pushed state (combat, wait,
   * event) pops back to the AI, and Python's begin only fades the music in;
   * has_run_ai and cur_unit survive until the phase ends (AIState.finish).
   */
  override start(): StateResult {
    const game = getGame();

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
      // Standard mode: units are picked one at a time (get_next_unit).
      this.aiUnits = [];
    }
    this.ranAi = new Set();
    this.curGroup = null;

    this.currentAiIndex = 0;
    this.frameCounter = 0;
    this.processing = false;
    this.waitingForCombat = false;
    this.waitingForMovement = false;
    this.waitingForEvent = false;
    this.pendingCombatTarget = null;
    this.pendingCombatWeapon = null;
    this.pendingCombatTile = null;
    this.pendingWaitUnit = null;

    game.cursor.visible = false;
  }

  override begin(): StateResult {
    // Phase music (Python: AIState.begin() -> phase.fade_in_phase_music()).
    fadeInPhaseMusic(getGame());
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
        // Python AIController.act canto step: has_canto(unit, None), then
        // SetMovementLeft(canto_movement(unit, None)) and canto_retreat.
        if (unitHasCanto(unit, null, game)) {
          game.actionLog.doAction(new SetMovementLeftAction(unit, cantoMovement(unit, null, game)));
          const retreat = game.aiController.getCantoRetreatAction(unit);
          if (retreat?.targetPosition) {
            // The canto walk is a normal Move: it stops on the first
            // interrupt_move tile, and the surprise sets HasAttacked before
            // the unit waits (firing the region trigger).
            const interrupted = retreat.movePath && retreat.movePath.length > 1 && unit.position
              ? interruptMovePath(unit, retreat.movePath, game)
              : { path: retreat.movePath, surprise: false };
            const movePath = interrupted.path;
            const stop = interrupted.surprise && movePath && movePath.length > 0
              ? movePath[movePath.length - 1]
              : retreat.targetPosition;
            this.moveWithAction(game, unit, [stop[0], stop[1]], movePath);
            const finish = (): boolean => {
              if (!interrupted.surprise) return false;
              game.audioManager?.playSfx?.('Surprise');
              game.actionLog.doAction(new HasAttackedAction(unit));
              this.waitAfterAct(game, unit);
              return true;
            };
            if (movePath && movePath.length > 1) {
              this.waitingForMovement = true;
              game.movementSystem.beginMove(
                unit,
                movePath,
                undefined,
                () => {
                  this.waitingForMovement = false;
                  if (finish()) return;
                  this.waitAfterAct(game, unit);
                },
              );
              return;
            }
            if (finish()) return;
          }
          // Python AIState: the unit acted, so it waits through unit.wait().
          this.waitAfterAct(game, unit);
          return;
        }
        // Combat skipped the wait for a target-dependent Canto, but the AI's
        // canto step (has_canto(unit, None)) has none: AIState waits it.
        this.waitAfterAct(game, unit);
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
        // Python AIState waits the unit once its action's events are done.
        const pending = this.pendingWaitUnit;
        this.pendingWaitUnit = null;
        if (pending) this.waitAfterAct(game, pending);
        else this.advanceToNextUnit();
      }
      return;
    }

    if (this.currentAiIndex >= this.aiUnits.length) {
      const next = game.initiative ? null : this.pickNextUnit(game);
      if (!next) {
        // AI phase complete: clear every AI group's triggered set.
        game.clearAiGroupTriggers?.();
        game.state.change('turn_change');
        return;
      }
      this.ranAi.add(next);
      this.curGroup = next.aiGroup || null;
      this.aiUnits.push(next);
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

    // Python AIController.act: a unit already standing in an interrupt_move
    // region is interrupted before it thinks; it does nothing and does not
    // wait (did_something stays False).
    if (checkRegionInterrupt(unit, game).length > 0) {
      this.currentAiIndex++;
      this.frameCounter = 0;
      return;
    }

    // Mark start of AI unit's action group (turnwheel marker)
    game.actionLog.doAction(new MarkActionGroupStart(unit, 'ai'));

    // Get AI decision
    const action = game.aiController.getAction(unit);

    // Python AIController.think: committing to a target (Primary) or to a
    // move off its tile (Secondary) triggers the unit's AI group. Once
    // min(threshold, group size) members are ready the group is pinged
    // active and its unmoved members run their AI again; until then this
    // unit does nothing.
    const samePosition = (a?: [number, number] | null, b?: [number, number] | null) =>
      !!a && !!b && a[0] === b[0] && a[1] === b[1];
    const commits = action.type === 'attack' || action.type === 'steal' || action.type === 'use_item'
      ? !!(action.targetUnit || action.targetPosition)
      : action.type === 'move' || action.type === 'interact'
        ? !!action.targetPosition && !samePosition(action.targetPosition, unit.position)
        : false;
    if (commits && unit.aiGroup && game.getAiGroup(unit.aiGroup)) {
      if (game.triggerAiGroup(unit.aiGroup, unit.nid)) {
        game.actionLog.doAction(new AIGroupPingAction(game, unit.aiGroup));
        for (const mate of game.getAllUnits() as UnitObject[]) {
          if (mate !== unit && mate.team === unit.team && mate.aiGroup === unit.aiGroup &&
              !mate.hasMoved && !mate.hasAttacked) {
            this.ranAi.delete(mate);
          }
        }
      } else {
        this.advanceToNextUnit();
        return;
      }
    }

    // Python UnitPathMovementComponent: the walk stops on the first
    // interrupting tile, and finish(surprise) applies HasAttacked and
    // interrupts the AI (no attack, item, interact or canto); the unit then
    // waits, which fires the region trigger.
    if (action.targetPosition && action.movePath && action.movePath.length > 1 && unit.position) {
      const interrupted = interruptMovePath(unit, action.movePath, game);
      if (interrupted.surprise) {
        const stop = interrupted.path[interrupted.path.length - 1];
        const finish = () => {
          game.audioManager?.playSfx?.('Surprise');
          game.actionLog.doAction(new HasAttackedAction(unit));
          waitUnit(game, unit, false);
          if (game.eventManager?.hasActiveEvents()) {
            this.waitingForEvent = true;
            game.state.change('event');
            return;
          }
          this.advanceToNextUnit();
        };
        this.moveWithAction(game, unit, [stop[0], stop[1]], interrupted.path);
        if (interrupted.path.length > 1) {
          this.waitingForMovement = true;
          game.movementSystem.beginMove(unit, interrupted.path, undefined, () => {
            this.waitingForMovement = false;
            finish();
          });
        } else {
          finish();
        }
        return;
      }
    }

    switch (action.type) {
      case 'attack':
      case 'steal': {
        if (action.targetPosition && (action.targetUnit || action.targetTile)) {
          if (action.combatArt &&
              !activateCombatArt(game, unit, action.combatArt)) {
            this.waitAfterAct(game, unit);
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
            this.pendingCombatTarget = action.targetUnit ?? null;
            this.pendingCombatWeapon = action.item!;
            this.pendingCombatTile = action.targetTile ?? null;
            game.movementSystem.beginMove(
              unit,
              action.movePath,
              undefined,
              () => {
                // Movement done — now push CombatState for animated combat
                this.beginAICombat(
                  unit, this.pendingCombatTarget, this.pendingCombatWeapon!, this.pendingCombatTile,
                );
              },
            );
          } else {
            // Already at position, attack directly
            this.moveWithAction(game, unit, action.targetPosition, action.movePath);
            this.beginAICombat(
              unit,
              action.targetUnit ?? null,
              action.item!,
              action.targetTile ?? null,
            );
          }
        } else {
          // No goal target: did_something stays False, no wait.
          this.advanceToNextUnit();
        }
        break;
      }

      case 'move': {
        if (action.targetPosition) {
          const prevPos: [number, number] | null = unit.position
            ? [unit.position[0], unit.position[1]]
            : null;

          const moved = this.moveWithAction(game, unit, action.targetPosition, action.movePath);

          if (action.movePath && action.movePath.length > 1 && prevPos) {
            this.waitingForMovement = true;
            game.movementSystem.beginMove(unit, action.movePath, undefined, () => {
              this.waitingForMovement = false;
              this.waitAfterAct(game, unit);
            });
          } else if (moved) {
            this.waitAfterAct(game, unit);
          } else {
            // A Secondary goal on its own tile: did_something stays False.
            this.advanceToNextUnit();
          }
        } else {
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
            // Python: the item's ai_combat ends in WaitState -> unit.wait().
            this.waitAfterAct(game, unit);
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

              // Python AIController.attack: HasAttacked only when a
              // region event triggered.
              if (triggered) game.actionLog.doAction(new HasAttackedAction(unit));
              // Push EventState if events were triggered
              if (triggered && game.eventManager.hasActiveEvents()) {
                this.waitingForEvent = true;
                game.state.change('event');
              }
            }

            // did_something: the unit moved to its interact goal; it waits
            // (unit.wait(), unit_wait) after the region's events.
            const moved = !!prevPos && (prevPos[0] !== action.targetPosition![0] || prevPos[1] !== action.targetPosition![1]);
            if (this.waitingForEvent) {
              if (moved) this.pendingWaitUnit = unit;
            } else if (moved) {
              this.waitAfterAct(game, unit);
            } else {
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
          this.advanceToNextUnit();
        }
        break;
      }

      case 'wait':
      default: {
        // Python AIState: no behaviour found anything, so did_something is
        // False and the unit does not wait (it stays unfinished).
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
    defender: UnitObject | null,
    weapon: ItemObject,
    tile: [number, number] | null = null,
  ): void {
    const game = getGame();

    // Python AIController.attack returns early for an item that is not
    // available: PrimaryAI scores skill abilities without that check, so a
    // unit can walk up for an ability whose cost it cannot pay (EOtF's
    // Thunderstruck without three Thundersparks). It starts no combat and,
    // having moved, waits.
    if (!itemAvailable(attacker, weapon, game.db, game)) {
      this.waitingForMovement = false;
      this.waitAfterAct(game, attacker);
      return;
    }

    // Python start_combat(unit, goal_target, ...) aims at the goal tile. A
    // target_tile item aimed at an empty tile hits only its splash: the
    // combat state takes the tile and the first unit it affects.
    if (!defender && tile) {
      const affected = game.targetSystem.getTargetFromPosition(attacker, weapon, tile);
      defender = [affected.mainTarget, ...affected.splash]
        .filter((position): position is [number, number] => !!position)
        .map((position) => game.board.getUnit(position[0], position[1]) as UnitObject | null)
        .find((candidate): candidate is UnitObject => !!candidate) ?? null;
      if (defender) game.memory.set('combat_target_position', [tile[0], tile[1]]);
    }
    if (!defender) {
      this.waitingForMovement = false;
      this.waitAfterAct(game, attacker);
      return;
    }

    // Python AIController.attack: EquipItem the chosen item when it is one of
    // the unit's own items (not a skill ability) and can be equipped. The AI
    // never brings it to the top of the inventory.
    if (attacker.getAllItems().includes(weapon) && attacker.canEquip(weapon)) {
      game.actionLog.doAction(new EquipItemAction(attacker, weapon));
    }
    // Python start_combat(unit, goal_target, goal_item): the chosen item is
    // the combat item even when it cannot be equipped (a skill's no_equip
    // ability weapon such as EOtF's Haymaker); falling back to the equipped
    // weapon found none and the combat ended before its first strike.
    game.memory.set('combat_item', weapon);
    // Python interaction.start_combat aims a multi_target item at
    // `[target] * num_targets`; EOtF's fork engage merges those positions
    // into one splash list with no main target: a single counter-less
    // combat that strikes the target once per entry each phase and spends
    // one use.
    const wanted = numTargets(attacker, weapon);
    if (isForkEngine() && wanted > 1 && defender.position) {
      const [x, y] = defender.position;
      game.memory.set(
        'combat_multi_target_positions',
        Array.from({ length: wanted }, () => [x, y] as [number, number]),
      );
    }

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

  /** Python pushes status_endstep above turn_change; it has run this turn change. */
  private endstepDone = false;

  override start(): StateResult {
    // A fresh turn change (a cleared one may have left the flag set).
    this.endstepDone = false;
  }

  override begin(): StateResult {
    const game = getGame();

    // Python: turn_change, then status_endstep on top, so the ending
    // phase's endstep hooks (and the events they queue) finish before
    // TurnChangeState.begin/end advance the phase.
    if (!this.endstepDone) {
      this.endstepDone = true;
      game.state.change('status_endstep');
      return 'repeat';
    }
    this.endstepDone = false;

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
        game.actionLog.doAction(new IncrementTurnAction());
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

    // Advance to next phase
    const phaseTurnBefore = game.phase.turnCount;
    game.phase.next((team: string) => phaseTeamUnits(game, team));

    // Python TurnChangeState.end: action.do(IncrementTurn()) when the phase
    // order wraps, so the turnwheel can reverse it. game.turnCount (read by
    // "game.turncount == 2" conditions) is the source; the phase copy follows.
    const wrapped = game.phase.turnCount !== phaseTurnBefore;
    game.phase.turnCount = game.turnCount;
    if (wrapped) game.actionLog.doAction(new IncrementTurnAction());

    const currentTeam = game.phase.getCurrent();
    // Python TurnChangeState.end: entering player phase, IncrementTurn then
    // UpdateRecords('turn') (the records screen's turns per chapter).
    if (currentTeam === 'player') game.actionLog.doAction(new UpdateRecordsAction('turn'));
    const turnCount = game.phase.turnCount;
    const levelNid = game.currentLevel?.nid;

    // Clear highlights before clearing the state stack (the clear() calls
    // finish() not end(), so FreeState.end() won't run to clean up highlights)
    game.highlight.clear();

    // Clear the entire state stack to prevent unbounded growth,
    // then push the appropriate states fresh.
    game.state.clear();

    // Python TurnChangeState.end: free/ai, status_upkeep, phase_change. The
    // phase events (pushed above) run first, then PhaseChangeState (ResetAll,
    // banner), then the new phase's upkeep hooks.
    game.state.change(currentTeam === 'player' ? 'free' : 'ai');
    game.state.change('status_upkeep');
    game.state.change('phase_change');

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

    // Pop self
    game.state.back();

    // Python InitiativeUpkeep.end: free/ai, status_upkeep, phase_change.
    game.state.change(unit.team === 'player' ? 'free' : 'ai');
    game.state.change('status_upkeep');
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
// 8c. StatusUpkeepState / StatusEndstepState
// ============================================================================

/**
 * Port of Python status_upkeep.StatusUpkeepState ('status_upkeep' and
 * 'status_endstep'). The phase team's units on the map are processed last
 * to first (Python pops them off the list), one per pass: the unit's skill
 * hooks, then its item hooks, then a lethal-damage death. Events a unit's
 * hooks queue (upkeep_event, unit_death) run before the next unit. Upkeep
 * ends by marking the phase for the turnwheel.
 */
export class StatusUpkeepState extends State {
  readonly name: string = 'status_upkeep';
  override readonly transparent = true;

  private units: UnitObject[] = [];
  private pendingFinish: CollectedSkillTurn | null = null;

  protected turnPhase(): 'upkeep' | 'endstep' {
    return 'upkeep';
  }

  override start(): StateResult {
    const game = getGame();
    this.pendingFinish = null;
    if (game.initiative) {
      const nid = game.initiative.getCurrentUnitNid();
      const unit = nid ? game.getUnit(nid) : null;
      this.units = unit ? [unit] : [];
    } else {
      const team = game.phase.getCurrent();
      this.units = (game.getAllUnits() as UnitObject[]).filter((unit) =>
        !!unit.position && unit.team === team && !unit.isDead());
    }
    // The level start reaches the player phase_change from several entry
    // points; its turn-one upkeep runs once per level.
    if (this.turnPhase() === 'upkeep' && !game.initiative &&
        game.phase.getCurrent() === 'player' && game.turnCount === 1) {
      if (game.levelVars.get('_turn1_upkeep_done')) this.units = [];
      else game.levelVars.set('_turn1_upkeep_done', true);
    }
  }

  override update(): StateResult {
    const game = getGame();
    const phase = this.turnPhase();
    // A unit whose hooks produced playback: Python runs the events they
    // queued (pushed over this state) before its pending actions.
    if (this.pendingFinish) {
      const collected = this.pendingFinish;
      this.pendingFinish = null;
      finishSkillTurnHooks(game, collected);
      if (game.eventManager?.hasActiveEvents()) {
        game.state.change('event');
        return 'repeat';
      }
    }
    while (this.units.length > 0) {
      const unit = this.units.pop() as UnitObject;
      if (!unit.position || unit.isDead()) continue;
      const collected = collectSkillTurnHooks(game, unit, phase);
      if (phase === 'upkeep') {
        applyItemUpkeepResourceHooks(
          game,
          unit,
          getSkillAbilityOptions(game, unit).map((ability) => ability.item),
        );
      }
      if (collected.playback && unit.position && game.eventManager?.hasActiveEvents()) {
        this.pendingFinish = collected;
        game.state.change('event');
        return 'repeat';
      }
      finishSkillTurnHooks(game, collected);
      if (game.eventManager?.hasActiveEvents()) {
        game.state.change('event');
        return 'repeat';
      }
    }
    // Python: "About to begin the real phase"
    if (phase === 'upkeep') game.actionLog.doAction(new MarkPhase(game.phase.getCurrent()));
    game.state.back();
    return 'repeat';
  }
}

export class StatusEndstepState extends StatusUpkeepState {
  override readonly name: string = 'status_endstep';

  protected override turnPhase(): 'upkeep' | 'endstep' {
    return 'endstep';
  }
}

// ============================================================================
// 8d. DyingState
// ============================================================================

/**
 * Port of Python DyingState / DeathManager for deaths outside combat
 * (kill_unit): 'Death' sfx, a white flicker and the fade_out transition,
 * then Die once default_transition_time - 50 ms have passed.
 */
export class DyingState extends State {
  readonly name = 'dying';
  override readonly transparent = true;

  private units: UnitObject[] = [];
  private startFrame = -1;

  override start(): StateResult {
    const game = getGame();
    this.units = (game.memory.get('dying_units') as UnitObject[] | undefined) ?? [];
    game.memory.delete('dying_units');
    this.startFrame = -1;
  }

  override update(): StateResult {
    const game = getGame();
    if (this.startFrame < 0) {
      this.startFrame = getFrameCount();
      for (const unit of this.units) {
        game.audioManager?.playSfx?.('Death');
        startDyingFade(unit);
      }
    }
    if ((getFrameCount() - this.startFrame) * FRAMETIME < DEFAULT_TRANSITION_TIME - 50) return;
    for (const unit of this.units) {
      clearUnitFx(unit);
      unit.isDying = false;
      if (unit.position) game.actionLog.doAction(new DeathAction(unit, game.board, game.initiative));
    }
    this.units = [];
    game.state.back();
    return 'repeat';
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

    // Turnwheel lock during non-player phases (status_upkeep marks the phase).
    game.actionLog.doAction(new LockTurnwheel(currentTeam !== 'player'));

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
        if (nextState === SURPRISE_AFTER_MOVEMENT) {
          if (game.selectedUnit) finishPlayerSurpriseMove(game, game.selectedUnit);
        } else {
          game.state.change(nextState);
        }
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
    // The EOtF fork's ShopState says 'shop_max' when hands are full (the key
    // was renamed shop_max_inventory upstream; EOtF only defines shop_max).
    if (isForkEngine()) this.messages.max_inventory = 'shop_max';

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
  boopSound?: string | null;
  flags?: Set<string>;
};

/** Python SpeakStyleLibrary built-ins (WINWIDTH = 240). */
const BUILTIN_SPEAK_STYLES: Record<string, SpeakStyleDef> = {
  __default: { speed: 1, fontType: 'convo', background: 'message_bg_base', numLines: 2, drawCursor: true,
    messageTail: 'message_bg_tail', nameTagBg: 'name_tag', transparency: 0.05, boopSound: 'Talk_Boop' },
  __default_text: { speed: 0.5, fontType: 'text', background: 'menu_bg_base', numLines: 0,
    nameTagBg: 'menu_bg_base', transparency: 0.05, boopSound: 'Talk_Boop' },
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

/** Built-in styles whose window EOtF's engine skins (`'menu_bg_base' + skin`). */
const SKINNED_SPEAK_STYLES = new Set(['__default_text', 'narration', 'narration_top']);

/**
 * BUILTIN_SPEAK_STYLES[nid]. On the EOtF fork the text-box styles carry the
 * window skin the game was started with (the engine's speak-style library is
 * built at New Game and saved), not the live setting.
 */
function builtinSpeakStyle(game: any, nid: string): SpeakStyleDef | undefined {
  const style = BUILTIN_SPEAK_STYLES[nid];
  if (!style || !isForkEngine() || !SKINNED_SPEAK_STYLES.has(nid)) return style;
  const bg = skinnedSpriteNameFor('menu_bg_base', game?.speakStyleSkin ?? currentWindowSkin());
  return { ...style, background: bg, ...(style.nameTagBg === 'menu_bg_base' ? { nameTagBg: bg } : {}) };
}

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
  /** `unlock` paused on unlock_select; spend the chosen key when it resumes. */
  private unlockAwaitingSpend = false;
  /** Event to run on each selection, from the choice's `EventNid` keyword. */
  private choiceEventNid: string | null = null;
  /** An open `expression` choice: re-evaluated every frame (refreshChoiceOptions). */
  private choiceRefresh: {
    raw: string;
    entryType: string;
    last: string[];
    compute: (source: string) => string[];
  } | null = null;
  /** The active choice's EntryType and stored values (PlayerChoiceState data). */
  private choiceEntryType = 'str';
  private choiceValues: string[] = [];
  /** Parent choices paused while their EventNid selection event runs. */
  /** Presentation of events paused by a nested trigger_script/choice event. */
  /**
   * Python EventState.game_over: lose_game / main_menu called for the
   * transition away; this state stops updating under it (reset by begin).
   */
  private gameOver = false;
  /** Events this state has started running (resumable when paused). */
  private begunEvents = new WeakSet<GameEvent>();
  private parkedEventPresentation: WeakMap<GameEvent, {
    eventTables: Map<string, EventTable>;
    eventTextboxes: Map<string, EventTextbox>;
    portraits: Map<string, EventPortrait>;
    portraitPriorityCounter: number;
    /** Portrait loads the parked event started that have not resolved yet. */
    pendingPortraitLoads: number;
    blockingPortraitLoads: number;
    background: HTMLImageElement | null;
    backgroundPanorama: PanoramaFrames | null;
  }> = new WeakMap();
  /** The panorama restoreParkedPresentation handed back with its background. */
  private restoredPanorama: PanoramaFrames | null = null;
  /** kill_unit's dying unit, waiting for its UnitDeath events to finish. */
  private pendingDyingUnits = new WeakMap<GameEvent, UnitObject>();
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
    /** The choice's nid and cursor: an `unchoice` re-opens the same Python
     * PlayerChoiceState, so the cursor stays where it was. */
    choiceNid?: string | null;
    cursor?: number;
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
  /** Python PanoramaBackground frame procession for `background`. */
  private backgroundPanorama: PanoramaFrames | null = null;
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
    this.gameOver = false;
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
    if (isNewEvent) this.parkPresentation(nextEvent);
    this.currentEvent = nextEvent;
    this.begunEvents.add(nextEvent);
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
      this.portraits = new Map();
      this.portraitPriorityCounter = 1;
      this.pendingPortraitLoads = 0;
      this.blockingPortraitLoads = 0;
      this.overlaySprites.clear();
      this.eventTables.clear();
      this.eventTextboxes.clear();
      this.speakingPortrait = null;
      this.wasDialogTyping = false;
      this.background = null;
      this.backgroundPanorama = null;
      this.pendingBackgroundLoad = false;
      this.backgroundLoadDone = false;
      this.backgroundLoadToken++;
      this.chapterTitlePhase = 'none';
      this.chapterTitleTimer = 0;
      this.chapterTitleText = '';
      this.locationCard = null;
      // Python keeps is_handling_end_event on the EventState that ran
      // win_game, which resumes once the LevelEnd events pushed above it
      // finish. Here one EventState runs every queued event, so an event
      // queued mid-outro (a combat's unit_death or item events from an
      // interact_unit in the outro, as in EOtF's elite outros) must not
      // clear it, or the level never ends.
      if (!game.levelVars?.get?.('_level_end_triggered')) this.isHandlingLevelEnd = false;
      this.levelTransitionInProgress = false;
      const restoredBackground = this.restoreParkedPresentation(nextEvent);
      if (restoredBackground !== undefined) {
        this.background = restoredBackground;
        this.backgroundPanorama = this.restoredPanorama;
      }
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
        game.audioManager?.playSfx?.('Select 4');
        // Enable skip mode — dismiss this dialog and auto-skip all
        // remaining speak/narrate commands in the current event.
        // Python Event.take_input: START or BACK -> skip(super_skip=START).
        this.skipMode = true;
        if (effective === 'START') this.superSkip = true;
        this.clearBoxesOnForkSkip();
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
      // Python Event.take_input: the SELECT click only sounds when talk
      // boops are off.
      if ((effective === 'SELECT' || effective === 'RIGHT' || effective === 'DOWN') && !getSetting('talk_boop')) {
        game.audioManager?.playSfx?.('Select 1');
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
      if (!result && effective === 'INFO' && this.openChoiceInfo(game)) return;
      if (!result && effective === 'AUX' && this.choiceMenu.nextHelpPage()) return;
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
      const chosenNid = this.choiceNid;
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
            choiceNid: chosenNid,
            cursor: chosenMenu.selectedIndex,
          } : null;
          const priorLength = queue.length;
          // Python PlayerChoiceState passes the choosing event's context
          // (unit, unit2, position, local_args) to the selection event, so
          // e.g. EOtF's Talk_TuneUp_Sub_2 can `remove_unit;{unit2}`.
          const ownerTrigger: any = owner?.trigger ?? {};
          game.eventManager.triggerSpecific(
            prefab.nid,
            {
              type: 'choice_selection',
              levelNid: game.currentLevel?.nid,
              unit1: ownerTrigger.unit1,
              unitNid: ownerTrigger.unitNid ?? ownerTrigger.unit1?.nid,
              unit2: ownerTrigger.unit2,
              unitB: ownerTrigger.unitB ?? ownerTrigger.unit2?.nid,
              position: ownerTrigger.position,
              region: ownerTrigger.region,
              localArgs: ownerTrigger.localArgs ? new Map(ownerTrigger.localArgs) : undefined,
            },
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
      game.audioManager?.playSfx?.('Select 4');
      this.skipMode = true;
      if (effective === 'START') this.superSkip = true;
      this.clearBoxesOnForkSkip();
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
    if (this.gameOver) return;
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
      this.refreshChoiceOptions(game);
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

      // kill_unit pushed 'dying' under the UnitDeath events it triggered;
      // with those done, the dying fade plays before this event goes on.
      const dyingUnit = this.pendingDyingUnits.get(ev);
      if (dyingUnit) {
        this.pendingDyingUnits.delete(ev);
        if (dyingUnit.position && isUnitDying(dyingUnit)) {
          game.memory.set('dying_units', [dyingUnit]);
          game.state.change('dying');
          return;
        }
      }

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
  /**
   * Python PanoramaBackground.draw (also for a paused parent event): the
   * current frame, scrolled horizontally for change_background;scroll
   * (ScrollingBackground: unscaled, tiled, time / scroll_speed px), then
   * update() advances the frame procession.
   */
  private drawBackgroundLayer(surf: Surface, image: HTMLImageElement, panorama: PanoramaFrames | null): void {
    const frame = panorama?.image ?? image;
    const speed = panorama?.scrollSpeed ?? null;
    if (speed) {
      const width = Math.max(1, frame.width);
      const { x: ox, y: oy } = MenuScene.origin();
      const counter = ((getFrameCount() * 1000 / 60) / speed) % width;
      let x = ox - counter;
      while (x > 0) x -= width;
      for (; x < viewport.width; x += width) {
        surf.blitImage(frame, 0, 0, frame.width, frame.height, Math.floor(x), oy);
      }
    } else {
      this.drawEventBackground(surf, frame);
    }
    panorama?.update(FRAMETIME);
  }

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
        if (parked.background) this.drawBackgroundLayer(surf, parked.background, parked.backgroundPanorama);
        // Python's paused Event.draw still updates its portraits (blinking,
        // fades) and drops the ones whose removal finished.
        for (const [name, portrait] of [...parked.portraits]) {
          if (portrait.update(FRAMETIME)) parked.portraits.delete(name);
        }
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
      this.drawBackgroundLayer(surf, this.background, this.backgroundPanorama);
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
    // Python LevelUpScreen draws the unit's portrait beside the stat panel.
    const screen = this.levelUpPresentation.screen;
    const portraitNid = (unit as any).portraitNid ?? null;
    if (portraitNid) {
      game.resources?.loadPortrait?.(portraitNid)?.then?.((img: HTMLImageElement) => screen.setPortrait(img))?.catch?.(() => {});
    }
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

  /** Events that ran the EOtF fork's non-terminating end_turn. */
  private forcedTurnEndEvents = new WeakSet<GameEvent>();

  /**
   * Finish the current event, dequeue it, and either load the next queued
   * event or pop the state.
   *
   * Matches Python EventState.end_event(): after dequeuing, checks _win_game
   * and _lose_game level variables to trigger level transitions.
   */
  private finishAndDequeue(): void {
    const game = getGame();
    const finishedEvent = this.currentEvent;
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

    // Python end_event: lose_game fades (transition_to) to the game over
    // screen, pushed over the whole stack; this EventState stops updating
    // under it. The title screen it leads to drops the rest (refresh).
    // Python leaves _lose_game set.
    if (game.levelVars.get('_lose_game')) {
      console.warn('GAME OVER — loss condition met via lose_game flag');
      this.gameOver = true;
      game.memory.set('next_state', 'game_over');
      game.state.change('transition_to');
      return;
    }

    // Python end_event: `main_menu` returns to the title screen once the
    // event that ran it ends (EOtF's game-clear event ends this way), the
    // same way: transition_to over the stack, which title_start refreshes.
    if (game.levelVars.get('_main_menu')) {
      game.levelVars.set('_main_menu', false);
      this.currentEvent = null;
      this.gameOver = true;
      game.memory.set('next_state', 'title');
      game.state.change('transition_to');
      return;
    }

    // --- Fork end_turn: change turns after the event that ran it ---
    if (finishedEvent && this.forcedTurnEndEvents.delete(finishedEvent)) {
      // Events still queued are kept (the fork never clears them) and run
      // from the EventState that turn_change pushes for its own triggers.
      this.currentEvent = null;
      game.state.back();
      game.state.change('turn_change');
      return;
    }

    // --- Normal event completion (no win/lose) ---
    this.loadNextEvent(game);
  }

  /**
   * Python keeps portraits, tables/textboxes and the background on each
   * Event object, so an event paused under another (trigger_script, a
   * choice's EventNid, an interrupting trigger) gets them back when it
   * resumes. Park the outgoing event's presentation while it is still
   * pending and give the incoming event fresh containers.
   */
  private parkPresentation(next: GameEvent | null): void {
    const previous = this.currentEvent;
    if (!previous || previous === next || previous.isDone()) return;
    this.parkedEventPresentation.set(previous, {
      eventTables: this.eventTables,
      eventTextboxes: this.eventTextboxes,
      portraits: this.portraits,
      portraitPriorityCounter: this.portraitPriorityCounter,
      pendingPortraitLoads: this.pendingPortraitLoads,
      blockingPortraitLoads: this.blockingPortraitLoads,
      background: this.background,
      backgroundPanorama: this.backgroundPanorama,
    });
    this.parkedOrder = this.parkedOrder.filter((event) => event !== previous);
    this.parkedOrder.push(previous);
    this.eventTables = new Map();
    this.eventTextboxes = new Map();
    this.portraits = new Map();
    this.pendingPortraitLoads = 0;
    this.blockingPortraitLoads = 0;
  }

  /**
   * Give a resuming event back its parked presentation. Returns the parked
   * background, or undefined when the event had nothing parked.
   */
  private restoreParkedPresentation(event: GameEvent): HTMLImageElement | null | undefined {
    this.parkedOrder = this.parkedOrder.filter((parkedEvent) => parkedEvent !== event);
    const parked = this.parkedEventPresentation.get(event);
    if (!parked) return undefined;
    this.parkedEventPresentation.delete(event);
    this.eventTables = parked.eventTables;
    this.eventTextboxes = parked.eventTextboxes;
    this.portraits = parked.portraits;
    this.portraitPriorityCounter = parked.portraitPriorityCounter;
    this.pendingPortraitLoads = parked.pendingPortraitLoads;
    this.blockingPortraitLoads = parked.blockingPortraitLoads;
    this.restoredPanorama = parked.backgroundPanorama;
    return parked.background;
  }

  /**
   * Portrait images load asynchronously here but synchronously in Python, so
   * a load may resolve after its event was paused by a nested event. The
   * portrait belongs to the event that ran the command: callers insert into
   * the map captured at command time, and this settles that event's counters.
   * Returns whether the owner is still the running event.
   */
  private settlePortraitLoad(owner: GameEvent | null, blocks: boolean): boolean {
    if (owner === this.currentEvent) {
      this.pendingPortraitLoads = Math.max(0, this.pendingPortraitLoads - 1);
      if (blocks) this.blockingPortraitLoads = Math.max(0, this.blockingPortraitLoads - 1);
      return true;
    }
    const parked = owner ? this.parkedEventPresentation.get(owner) : undefined;
    if (parked) {
      parked.pendingPortraitLoads = Math.max(0, parked.pendingPortraitLoads - 1);
      if (blocks) parked.blockingPortraitLoads = Math.max(0, parked.blockingPortraitLoads - 1);
    }
    return false;
  }

  /**
   * Try to load the next queued event, or pop the state if none remain.
   */
  private loadNextEvent(game: any): void {
    const next = game.eventManager?.getCurrentEvent() ?? null;
    const barrier = next ? eventResumeBarriers.lastIndexOf(next) : -1;
    if (barrier >= 0 && next && !this.begunEvents.has(next)) {
      // A queued event that has not started (a combat's CombatEnd events,
      // which wait under its dying and UnitDeath states): return to the
      // state above; it starts fresh when that state runs it.
      eventResumeBarriers.splice(barrier, 1);
      this.parkPresentation(next);
      this.currentEvent = null;
      game.state.back();
      return;
    }
    if (barrier >= 0 && next) {
      // Events that interrupted a state above this paused event (e.g. a
      // combat run by its interact_unit) are done: return to that state.
      // The paused event resumes in its own EventState further down.
      eventResumeBarriers.splice(barrier, 1);
      this.parkPresentation(next);
      this.currentEvent = next;
      this.restoredPanorama = null;
      const restoredBackground = this.restoreParkedPresentation(next);
      this.background = restoredBackground ?? null;
      this.backgroundPanorama = this.restoredPanorama;
      game.state.back();
      return;
    }
    // Python keeps portraits, tables/textboxes and the background on each
    // Event object, so a parent paused by trigger_script (or a choice's
    // EventNid) gets them back when it resumes. Park the outgoing event's
    // presentation while it is still pending.
    this.parkPresentation(next);
    if (next) {
      this.currentEvent = next;
      this.begunEvents.add(next);
      this.dialog = null;
      this.endingCard = null;
      this.creditCards = [];
      this.banner = null;
      this.waitTimer = 0;
      this.waiting = false;
      this.portraits = new Map();
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
      this.restoredPanorama = null;
      const restoredBackground = this.restoreParkedPresentation(next) ?? null;
      if (suspendedIndex >= 0) {
        const [suspended] = this.suspendedChoiceEvents.splice(suspendedIndex, 1);
        this.eventTables = suspended.eventTables;
        this.eventTextboxes = suspended.eventTextboxes;
        // The parent's portraits belong to its own Python Event object and
        // survive the selection event.
        if (suspended.portraits) this.portraits = suspended.portraits;
        if (suspended.replay) {
          next.commandPointer = suspended.commandPointer;
          if (suspended.choiceNid && suspended.cursor !== undefined && !this.choiceCursorMemory.has(suspended.choiceNid)) {
            this.choiceCursorMemory.set(suspended.choiceNid, suspended.cursor);
          }
        }
      }
      this.background = restoredBackground;
      this.backgroundPanorama = this.restoredPanorama;
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
      this.portraits = new Map();
      this.pendingPortraitLoads = 0;
      this.blockingPortraitLoads = 0;
      this.eventTables.clear();
      this.eventTextboxes.clear();
      this.background = null;
      this.backgroundPanorama = null;
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
    // Python keeps this in game.memory, not in the (saved, event-visible) game vars.
    game.memory.set('_prev_level_nid', currentLevelNid);

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

    // Python level_end records whether the next level comes from the overworld.
    if (currentIndex < levelNids.length - 1 || gotoLevel !== null) {
      const levelPrefab = game.db.levels.get(currentLevelNid);
      game.gameVars.set('_should_go_to_overworld',
        !!levelPrefab?.go_to_overworld && !!game.db.getConstant?.('overworld', false) && gotoLevel === null);
    }

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

  /**
   * Skipping an event in EOtF's engine drops every extra box, the nidded
   * tables and textboxes included (upstream keeps those).
   */
  private clearBoxesOnForkSkip(): void {
    if (!isForkEngine()) return;
    this.eventTables.clear();
    this.eventTextboxes.clear();
  }

  /** Resolve table rows on every draw so expression-backed displays stay live. */
  private getEventTableRows(table: EventTable): string[] {
    if (isForkEngine()) {
      const source = table.expression
        ? this.substituteEventArgs([table.rawData || table.data], getGame())[0] ?? table.data
        : table.data;
      return forkChoiceRows(source, table.expression, () => this.buildConditionContext());
    }
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
          // Python str(val): None shows as 'None'.
          text = pythonStr(value);
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
      if (isImage && table.background !== 'funds_display') {
        // Python SimpleIconTable: the cells form a (cols * row_width) x
        // (rows * row_height) content box placed 10px from the screen edges;
        // the menu background is create_base_surf(w + 10, h + 10) centred on it.
        const contentWidth = columns * cellWidth;
        const contentHeight = titleHeight + rows * rowHeight;
        const alignmentName = table.alignment.toLowerCase();
        const cx = alignmentName.includes('right') ? surf.width - contentWidth - 10
          : alignmentName.includes('left') ? 10 : Math.floor((surf.width - contentWidth) / 2);
        const cy = alignmentName.includes('bottom') ? surf.height - contentHeight - 10
          : alignmentName.includes('top') ? 10 : Math.floor((surf.height - contentHeight) / 2);
        if (!table.noBackground) {
          const bgWidth = (contentWidth + 10) - ((contentWidth + 10) % 8);
          const bgHeight = (contentHeight + 10) - ((contentHeight + 10) % 8);
          surf.blit(getMenuBackgroundSync(contentWidth + 10, contentHeight + 10, table.background),
            cx + Math.floor(contentWidth / 2 - bgWidth / 2), cy + Math.floor(contentHeight / 2 - bgHeight / 2));
        }
        if (table.title) drawStyledText(surf, table.title, cx, cy, 'white', 'text');
        const sheetScale = surf.scale;
        values.slice(0, rows * columns).forEach((value, index) => {
          const sheet = getColorkeyedPortrait(getGame(), value.split('|')[0]);
          if (!sheet) return;
          const left = cx + (index % columns) * cellWidth;
          const top = cy + titleHeight + Math.floor(index / columns) * rowHeight;
          surf.ctx.imageSmoothingEnabled = false;
          if (entryType === 'type_portrait') {
            surf.ctx.drawImage(sheet, 0, 0, 96, 80, Math.round(left * sheetScale), Math.round(top * sheetScale), 96 * sheetScale, 80 * sheetScale);
          } else {
            surf.ctx.drawImage(sheet, sheet.width - 32, 16, 32, 32, Math.round(left * sheetScale), Math.round(top * sheetScale), 32 * sheetScale, 32 * sheetScale);
          }
        });
        continue;
      }
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
    follow: boolean = false,
    silent: boolean = false,
  ): boolean {
    if (!unit.position || !game.board || !game.pathSystem) return false;
    const fullPath = game.pathSystem.getPath(unit, target[0], target[1], game.board);
    // Python check_position: interrupt_move regions stop even event moves
    // ("Interruption regions take precedence"). The event finish() Resets the
    // unit, so only the stop and the Surprise sound remain.
    const interrupted = fullPath && fullPath.length > 1
      ? interruptMovePath(unit, fullPath, game, { event: true })
      : { path: fullPath, surprise: false };
    const path = interrupted.path;
    if (interrupted.surprise && path && path.length > 0) {
      const stop = path[path.length - 1];
      target = [stop[0], stop[1]];
    }
    // Python Move with no path (event._move_unit) leaves the unit in place.
    if (!path || path.length === 0) return false;
    // Python event walks are action.Move(event=True).
    const walk = new WarpUnitAction(unit, target, game.board);
    walk.turnwheelMove = true;
    game.actionLog.doAction(walk);
    if (path.length <= 1) {
      if (interrupted.surprise) game.audioManager?.playSfx?.('Surprise');
      return false;
    }
    if (interrupted.surprise) {
      const done = onComplete;
      onComplete = () => {
        game.audioManager?.playSfx?.('Surprise');
        done();
      };
    }
    game.movementSystem.beginMove(
      unit,
      path,
      1000 / Math.max(1, speedMs),
      () => {
        // Python UnitPathMovementComponent.finish: an event move ends with
        // action.Reset, so the walker is fully refreshed (a unit that had
        // already acted can act again; EOtF's engine also runs on_refresh).
        game.actionLog.doAction(new ResetAction(unit));
        // Python arrives the unit when its move finishes (terrain and region
        // statuses). A refresh from another unit moving meanwhile (move_group)
        // saw this one mid-path and dropped them; re-derive now it's arrived.
        game.refreshPositionSkills?.();
        onComplete();
      },
      // Python MovementSystem.update: a following event move puts the
      // cursor on the unit and centers the camera on it at every tile.
      follow
        ? (position) => {
          game.cursor?.setPos(position[0], position[1]);
          game.camera?.focusTile(position[0], position[1]);
        }
        : undefined,
      silent,
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
  private evaluateVariableExpression(source: string, literalFallback = true): any {
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
    // Python's _eval_expr raises EvaluateException (fatal to the event).
    // Web deviation for game_var/level_var: keep the raw text as a string
    // value (event authors and tests accumulate text this way); callers that
    // need a number get a failure marker and skip the write.
    try {
      const evaluated = evaluateExpression(trimmed, this.buildConditionContext());
      if (evaluated !== undefined) return evaluated;
    } catch {
      // handled below
    }
    return literalFallback ? source : VARIABLE_EVALUATION_FAILED;
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
        // Python substitutes str(value); a missing variable is '??'.
        return value === undefined ? '??' : pythonLiteral(value);
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
        ...triggerFieldArgs(trigger),
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
      return project && !Array.isArray(project) ? project : builtinSpeakStyle(game, nid);
    };
    let current: SpeakStyleDef = mergeSpeakStyle({}, BUILTIN_SPEAK_STYLES.__default);
    const styles: SpeakStyleDef[] = [];
    const named = lookup(styleNid);
    if (named) styles.push(named);
    styles.push(manual);
    const speakerStyle = lookup(speakerOrStyle);
    // EOtF's engine names the speaker after merging the styles, so an
    // explicit speaker beats a StyleNid's; upstream sets it first.
    const speakerLast = isForkEngine();
    if (speakerStyle) styles.push(speakerStyle);
    else if (!speakerLast) current.speaker = speakerOrStyle;
    for (const style of styles) current = mergeSpeakStyle(current, style);
    if (speakerLast && speakerOrStyle && !speakerStyle) current.speaker = speakerOrStyle;
    return current;
  }

  /**
   * PlayerChoiceState INFO: a `type_unit` choice opens the info menu on the
   * hovered unit (scrolling through the listed units), and the engine fork's
   * `type_dex_unit` opens the unit dex on it. Returns false when INFO does
   * nothing for this entry type.
   */
  private openChoiceInfo(game: any): boolean {
    const menu = this.choiceMenu;
    if (!menu) return false;
    const selected = menu.getCurrentOption()?.value ?? '';
    if (this.choiceEntryType === 'type_unit') {
      const unit = game.units.get(selected);
      if (!unit) {
        game.audioManager?.playSfx?.('Error');
        return true;
      }
      const units = this.choiceValues
        .map((nid) => game.units.get(nid))
        .filter((candidate: UnitObject | undefined): candidate is UnitObject => !!candidate);
      game.memory.set('scroll_units', units);
      game.memory.set('current_unit', unit);
      game.infoMenuUnit = unit;
      game.state.change('info_menu');
      return true;
    }
    if (this.choiceEntryType === 'type_dex_unit') {
      if (!selected) {
        game.audioManager?.playSfx?.('Error');
        return true;
      }
      game.memory.set('curr_unit_info', selected);
      game.state.change('base_info_menu');
      return true;
    }
    // Other entry types toggle the hovered entry's help box (if any).
    return menu.toggleInfo();
  }

  /**
   * PlayerChoiceState.create_help_boxes: item choices get the item's help
   * box (the stat grid for weapons and spells), skill choices the skill's
   * description. The EOtF fork adds a page per colour-tagged keyword and has
   * none for `type_game_item`; upstream has a single page for all three.
   */
  private buildChoiceHelpBoxes(values: string[], entryType: string, game: any): HelpBox[][] {
    const fork = isForkEngine();
    const withLinks = (first: HelpBox, desc: string | undefined): HelpBox[] =>
      fork ? [first, ...getLinkedHelpBoxes(desc)] : [first];
    if (entryType === 'type_base_item' || (!fork && entryType === 'type_game_item')) {
      return values.map((value) => {
        let item: ItemObjectClass | null = null;
        if (entryType === 'type_base_item') {
          const prefab = game.db.items.get(value);
          item = prefab ? createItemTree(prefab, (nid) => game.db.items.get(nid)) : null;
        } else {
          item = game.getItem?.(Number(value)) ?? game.getItem?.(value) ?? null;
        }
        return item ? withLinks(itemHelpBox(item), item.desc) : [];
      });
    }
    if (entryType === 'type_skill') {
      return values.map((value) => {
        const skill = game.db.skills.get(value);
        return skill ? withLinks(new HelpDialog(skill.desc ?? ''), skill.desc) : [];
      });
    }
    return [];
  }

  /**
   * Build one `choice` entry the way Python's GridChoiceMenu option classes
   * render it: items/skills with their icon and name, units with their map
   * sprite and name, classes by name, `type_icon` as `sheet-x-y-text`.
   */
  /** `nid|display` hides an unreadable NID behind display text; the stored result is the NID half. */
  private buildChoiceEntries(options: string[], entryType: string, game: any): EventChoiceEntry[] {
    return options.map((entry: string) => {
      const bar = entry.indexOf('|');
      const value = bar >= 0 ? entry.slice(0, bar).trim() : entry;
      const display = bar >= 0 ? entry.slice(bar + 1).replace(/\|/g, '').trim() : null;
      return this.buildChoiceEntry(value, display, entryType, game);
    });
  }

  /**
   * Python PlayerChoiceState.update: an `expression` choice re-evaluates its
   * options and, when they changed, menu.set_data + create_help_boxes.
   */
  private refreshChoiceOptions(game: any): void {
    const refresh = this.choiceRefresh;
    const menu = this.choiceMenu;
    if (!refresh || !menu || !(menu instanceof EventChoiceMenu)) return;
    const source = this.substituteEventArgs([refresh.raw], game)[0] ?? refresh.raw;
    const next = refresh.compute(source);
    if (next.length === 0) return;
    if (next.length === refresh.last.length && next.every((entry, index) => entry === refresh.last[index])) {
      return;
    }
    refresh.last = next;
    const entries = this.buildChoiceEntries(next, refresh.entryType, game);
    const values = entries.map((entry: EventChoiceEntry) => entry.value);
    menu.setEntries(entries, this.buildChoiceHelpBoxes(values, refresh.entryType, game));
    this.choiceValues = values;
    if (this.choiceNid) {
      game.gameVars.set(`${this.choiceNid}_choice_hover`, menu.getCurrentOption()?.value ?? '');
    }
  }

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
      case 'type_dex_unit': {
        // Engine fork: BasicUnitOption.from_nid, so units that are not
        // loaded show their prefab's map sprite.
        const unit = dexOptionUnit(game, value);
        const sprite = unit ? {
          draw: (surf: Surface, x: number, y: number, ox: number, oy: number) => {
            (unit.sprite as any)?.draw?.(surf, x, y, ox, oy);
          },
        } : null;
        return { value, kind: 'sprite', text: display ?? game.db.units.get(value)?.name ?? value, sprite };
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
        return resolved === undefined ? 'None' : pythonLiteral(resolved);
      };

      // Resolve typed {v:...} placeholders inside an eval before evaluating the
      // outer expression. JSON literals preserve arrays for indexing and random
      // choice instead of flattening them to comma-delimited text.
      // Python TextEvaluator evaluates innermost braces first, so a nested
      // `{e:u('{e:receiver}').name}` resolves `{e:receiver}` to text before
      // the outer eval. Take the first eval tag that has no eval tag inside.
      const findInnermostEval = (): [number, number] | null => {
        const tagAt = (index: number): boolean =>
          value.startsWith('{e:', index) || value.startsWith('{eval:', index);
        for (let start = value.indexOf('{'); start >= 0; start = value.indexOf('{', start + 1)) {
          if (!tagAt(start)) continue;
          let depth = 0;
          let close = -1;
          let nested = false;
          for (let index = start; index < value.length; index += 1) {
            if (value[index] === '{') {
              if (index > start && tagAt(index)) nested = true;
              depth += 1;
            }
            if (value[index] === '}') {
              depth -= 1;
              if (depth === 0) {
                close = index;
                break;
              }
            }
          }
          if (close < 0) return null;
          if (!nested) return [start, close];
        }
        return null;
      };
      for (let replacement = 0; replacement < 20; replacement += 1) {
        const span = findInnermostEval();
        if (!span) break;
        const [start, close] = span;
        const colon = value.indexOf(':', start);
        const expression = value.slice(colon + 1, close);
        // Python evaluates innermost braces first as plain text: a {v:} inside
        // a {d:Data.{v:key}.field} tag is the raw key, so resolve those data
        // tags before typing the remaining variables.
        const withDataKeys = expression.replace(
          /\{(?:d|data):[^{}]*(?:\{v:[A-Za-z_][A-Za-z0-9_]*\}[^{}]*)+\}/g,
          (dataTag) => replaceDataTags(dataTag.replace(
            /\{v:([A-Za-z_][A-Za-z0-9_]*)\}/g,
            (_variableMatch, key: string) => eventObjectToString(variableValue(key)),
          )),
        );
        const typedExpression = replaceDataTags(
          withDataKeys
            .replace(
              /(['"])\{v:([A-Za-z_][A-Za-z0-9_]*)\}\1/g,
              (_variableMatch, quote: string, key: string) => {
                // Python substitutes str(value) as text, so a quoted
                // placeholder stays a string literal: '{v:counter}' -> '1'.
                const resolved = variableValue(key);
                return `${quote}${resolved === undefined ? '??' : pythonStr(resolved)}${quote}`;
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
        // Python TextEvaluator._evaluate_evals: _object_to_str(value), or '??'
        // when the expression raises.
        const text = bareName && !contextName
          ? eventObjectToString(variableValue(typedExpression) ?? '')
          : evaluateTextTag(typedExpression, expressionContext);
        value = value.slice(0, start) + text + value.slice(close + 1);
      }
      // Python TextEvaluator._evaluate_vars: {v:}/{var:} reads level_vars,
      // then game_vars (never local args). A var that exists but holds None
      // prints 'None' and does not fall through to game_vars (unlike
      // QueryEngine.v); a missing variable becomes '??' (so
      // `if;len({v:missing}) > 0` fails to evaluate and is False).
      value = value.replace(/\{(?:v|var):([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, key: string) => {
        const source = game.levelVars?.has?.(key) ? game.levelVars
          : game.gameVars?.has?.(key) ? game.gameVars : null;
        if (!source) return '??';
        const result = source.get(key);
        return result === null || result === undefined ? 'None' : eventObjectToString(result);
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
        // Python EventProcessor: a false `if` is evaluated a second time by
        // _jump_conditional, and that second answer decides whether the body
        // runs (a random condition such as `game.get_random(1, 2) == 1` draws
        // twice and can still enter the body).
        if (evaluateCondition(condition, ctx) ||
            evaluateCondition(this.substituteEventArgs([cmd.args?.[0] ?? condition], game)[0] ?? condition,
              this.buildConditionContext())) {
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
          // Python speak(): cursor = True if draw_cursor is None. EOtF's
          // engine leaves it unset, so a style's DrawCursor (cinematic's
          // False) survives a StyleNid.
          drawCursor: drawCursorArg ?? (isForkEngine() ? null : true),
          messageTail: speakKw.get('messagetail') || null,
          transparency: numOrNull(speakKw.get('transparency')),
          nameTagBg: speakKw.get('nametagbg') || null,
          boopSound: speakKw.get('boopsound') || null,
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
            boopSound: style.boopSound ?? null,
            noSound: allFlags.has('no_sound'),
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
        // Python toggles on the event's own transition_state (None for a fresh
        // event, so its first bare `transition` closes), not on whatever the
        // screen currently shows.
        const owner = this.currentEvent;
        const direction = explicitDirection ||
          (owner ? (owner.transitionState === 'close' ? 'open' : 'close')
            : ((this.transitionFadingIn || this.transitionHoldBlack ||
              (this.transitionAlpha >= 1 && !this.transitionFadingOut)) ? 'open' : 'close'));
        if (owner) owner.transitionState = direction === 'open' ? 'open' : 'close';
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
          // 'close' — fade to black. A screen that is already closed stays
          // black (Python layers each event's own overlay on top).
          const alreadyClosed = this.transitionHoldBlack ||
            (this.transitionAlpha >= 1 && !this.transitionFadingOut);
          this.transitionFadingIn = true;
          this.transitionFadingOut = false;
          this.transitionAlpha = alreadyClosed ? 1 : 0;
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
        if (movementType === 'normal') {
          // Python move_unit: a normal move needs a path (even when skipped);
          // without one it logs an error and the unit stays put.
          const walk = game.pathSystem?.getPath(unit, targetPos[0], targetPos[1], game.board);
          if (!walk || walk.length === 0) {
            console.error(`move_unit: no valid path for ${unit.nid} from ${unit.position} to ${targetPos}`);
            this.advancePointer();
            return false;
          }
        }
        if (this.skipMode || movementType === 'immediate') {
          // Python move_unit: action.Teleport.
          const teleport = new WarpUnitAction(unit, targetPos, game.board);
          teleport.turnwheelMove = true;
          game.actionLog.doAction(teleport);
          this.advancePointer();
          return false;
        }
        if (movementType !== 'normal') {
          // Python Warp/FadeMove/Swoosh actions update position and begin their
          // sprite transition without pausing the event command stream.
          const from: [number, number] = [unit.position[0], unit.position[1]];
          game.actionLog.doAction(new WarpUnitAction(unit, targetPos, game.board));
          this.moveTransition(unit, movementType, from);
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
        }, !noFollow, muArgs.flags.has('silent'));
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
        // add_unit;Unit;Position?;EntryType? (fade);Placement?;AnimationType?
        const auArgs = parsePythonEventArgs(args, ['Unit'], ['Position', 'EntryType', 'Placement', 'AnimationType']);
        const unitNid = auArgs.value('Unit') ?? '';
        const posArg = auArgs.value('Position') ?? 'starting';
        const placement = (auArgs.value('Placement') || 'giveup').toLowerCase().trim();
        const entryType = auArgs.value('EntryType') || 'fade';
        const fadeDirection = this.fadeDirection(auArgs.value('AnimationType'));
        const existing = game.units.get(unitNid);
        // Python add_unit refuses a unit on the map or flagged dead; a 0-HP
        // unit (EOtF's Search point, HP 0) that is not dead is placed.
        if (existing?.position || existing?.dead) {
          this.advancePointer();
          return false;
        }
        // Python add_unit: a unit carried by a rescuer standing on the map is
        // not added (upstream separates an off-map rescuer first; EOtF's
        // engine only checks rescuers on the map).
        const carrier = existing?.rescuedBy ?? null;
        if (carrier?.position && !carrier.isDead() &&
            !(carrier as any).isDying && !unitHasTag(carrier, 'Tile', game)) {
          console.warn(`add_unit: ${unitNid} is already traveling with ${carrier.nid}`);
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
            this.entryTransition(existing, entryType, fadeDirection, game);
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
          const placed = this.findUnit(unitNid);
          if (placed) this.entryTransition(placed, entryType, fadeDirection, game);
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
          // Python str_utils.get_next_int('201', unit nids): '201' if free,
          // else the first free '1', '2', ...
          newNid = nextIntNid('201', game.units);
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
        // Python create_unit builds GenericUnit(..., starting_skills=[]): class
        // skills only, whether the template is a unit or a prefab.
        const learnedSkills: [number, string][] = [];

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

        const newUnit = game.buildUnit(syntheticPrefab, baseTeam, baseAi, { generic: true });
        newUnit.generic = true;
        newUnit.faction = baseFaction || null;
        if (copyStats && templateUnit) {
          // The EOtF fork also copies the template's stat cap modifiers
          // (change_stat_cap_modifiers on summon/clone templates).
          if (isForkEngine()) {
            newUnit.statCapModifiers = { ...templateUnit.statCapModifiers };
          }
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
        game.actionLog.doAction(new CreateUnitAction(game, newUnit, targetPos));
        this.loadMapSpriteForUnit(newUnit, game);
        if (targetPos) this.entryTransition(newUnit, entryType, null, game);

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
            boopSound: kw.get('boopsound') || null,
            flags: styleFlags,
          };
          if (!(game.speakStyles instanceof Map)) game.speakStyles = new Map();
          const existing: SpeakStyleDef | undefined = game.speakStyles.get(styleNid) ?? builtinSpeakStyle(game, styleNid);
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
        // EOtF's engine keeps rescued travelers as candidates.
        const keepTravelers = isForkEngine();
        let candidates = (game.getUnitsInParty() as UnitObject[]).filter((u: any) =>
          !u.position && !u.tags?.includes('Blacklist') &&
          (keepTravelers || ![...game.units.values()].some((o: any) => o.traveler === u.nid)),
        );
        const fatigueOn = game.db.getConstant('fatigue', false) && game.gameVars.get('_fatigue') === 1;
        if (fatigueOn) candidates = candidates.filter((u: any) => (u.currentFatigue ?? 0) < (u.getStatValue?.('HP') ?? 99));
        candidates.sort((a: any, b: any) => (b.tags?.includes('Required') ? 1 : 0) - (a.tags?.includes('Required') ? 1 : 0));
        const numSlots = game.levelVars.get('_prep_slots') ?? openSpots.length;
        candidates.slice(0, numSlots).forEach((unit: UnitObject, idx: number) => {
          const spot = openSpots[idx];
          if (spot) {
            game.actionLog.doAction(new ArriveOnMapAction(game, unit, spot));
            // Python action.Reset: also runs on_refresh in EOtF's engine.
            game.actionLog.doAction(new ResetAction(unit));
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
        const listOutcome = evaluateExpressionOutcome(rawExpr, this.buildConditionContext());
        let list: any = listOutcome.ok ? listOutcome.value : undefined;
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
        // Python _eval_expr raises when the value expression fails and the
        // command does not run (evaluateExpression returns undefined).
        if (cmd.type === 'add_item_component') {
          const rawValue = args[3];
          const value = rawValue !== undefined &&
              !['recursive', 'from_python', 'no_warn'].includes(rawValue)
            ? args.includes('from_python')
              ? parsePyevCommandValue(rawValue)
              : outcomeValue(evaluateExpressionOutcome(rawValue, this.buildConditionContext()))
            : null;
          if (value !== undefined) game.actionLog.doAction(new AddObjComponentAction(item, compNid, value));
        } else if (cmd.type === 'modify_item_component') {
          if (!item.components.has(compNid)) {
            console.warn(`modify_item_component: item lacks component ${compNid}`);
          } else {
            const value = args.includes('from_python')
              ? parsePyevCommandValue(args[3] ?? '')
              : outcomeValue(evaluateExpressionOutcome(args[3] ?? '', this.buildConditionContext()));
            const property = args[4] && !['additive', 'recursive'].includes(args[4]) ? args[4] : null;
            if (value !== undefined) {
              game.actionLog.doAction(new ModifyObjComponentAction(
                item, compNid, value, property, args.includes('additive'),
              ));
            }
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
              ? outcomeValue(evaluateExpressionOutcome(rawValue, this.buildConditionContext()))
              : null;
            if (value === undefined) break;
            game.actionLog.doAction(new AddObjComponentAction(skill, compNid, value));
          } else if (cmd.type === 'modify_skill_component') {
            if (!skill.components.has(compNid)) {
              console.warn(`modify_skill_component: skill lacks component ${compNid}`);
              continue;
            }
            const value = outcomeValue(evaluateExpressionOutcome(args[3] ?? '', this.buildConditionContext()));
            if (value === undefined) break;
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
        // Python trigger_script passes the parent's local args (its whole
        // trigger.to_args(): item, mode, target_pos, position, ...) along with
        // unit1/unit2/position; trigger_script_with_args passes only its list.
        const parentTrigger = this.currentEvent?.trigger;
        const trig: any = cmd.type === 'trigger_script' && parentTrigger
          ? {
            ...parentTrigger,
            type: eventName,
            localArgs: new Map(parentTrigger.localArgs ?? []),
          }
          : { type: eventName };
        if (cmd.type === 'trigger_script') {
          const unit1 = args[1] ? game.units.get(args[1]) : this.currentEvent?.trigger?.unit1;
          const unit2 = args[2] ? game.units.get(args[2]) : this.currentEvent?.trigger?.unit2;
          trig.unit1 = unit1 ?? undefined;
          trig.unit2 = unit2 ?? undefined;
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

      case 'show_pokedex': {
        // Engine fork (event_functions.show_pokedex): pause into the unit dex
        // through a transition.
        return this.openStateWithTransition('base_info_menu', args, game);
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
        // set_mode_rng;RNG (Python event_functions.py) — not turnwheel-logged.
        // RNG is an RNGOption display value ('Classic', 'True Hit', ...); it
        // overrides the difficulty's rng_choice for combat (game.rng_mode).
        const raw = (args[0] ?? '').trim();
        const mode = rngOptionDisplay(raw);
        if (!mode) {
          console.warn(`set_mode_rng: ${raw} is not a valid RNG option`);
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
        // remove_unit;Unit;RemoveType? (fade);AnimationType?
        const ruArgs = parsePythonEventArgs(args, ['Unit'], ['RemoveType', 'AnimationType']);
        const unit = this.findUnit(ruArgs.value('Unit') ?? '');
        if (unit?.position) {
          this.exitTransition(unit, ruArgs.value('RemoveType') || 'fade', this.fadeDirection(ruArgs.value('AnimationType')), game);
          game.actionLog.doAction(new LeaveMapAction(game, unit));
        }
        this.advancePointer();
        return false;
      }

      case 'unload_unit': {
        const unitNid = args[0] ?? '';
        const unit = this.findUnit(unitNid);
        if (unit) {
          // EOtF's engine takes an on-map unit off through LeaveMap before
          // dropping it from the registry. (There the drop itself is not
          // undoable; here it stays an Action so the turnwheel keeps a
          // consistent unit list.)
          if (unit.position) game.actionLog.doAction(new LeaveMapAction(game, unit));
          game.actionLog.doAction(new UnregisterUnitAction(game, unit));
        } else {
          console.warn(`unload_unit: unit ${unitNid} doesn't exist`);
        }
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
        // Python kill_unit marks the unit dead (Die / DyingState) and leaves
        // its HP alone (upstream and the EOtF fork).
        // Python: an on-map unit goes through game.death.should_die and the
        // DyingState (Death sfx, white flicker, fade; Die after 400 ms) once
        // the UnitDeath events it triggers have run; `immediate` and off-map
        // units die at once.
        const animatedDeath = wasOnMap && !immediate && !this.skipMode;
        if (animatedDeath) markDying(unit);
        else game.actionLog.doAction(new DeathAction(unit, game.board, game.initiative));
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
        if (animatedDeath && this.currentEvent) this.pendingDyingUnits.set(this.currentEvent, unit);
        if (queue.length > priorLength && this.currentEvent) {
          this.advancePointer();
          return this.runEventsQueuedSince(priorLength, game);
        }
        this.advancePointer();
        return false;
      }

      case 'add_group': {
        // Python event_functions.add_group: Group, StartingGroup?, EntryType?
        // (fade), Placement? (giveup), flag `create` (place fresh copies of
        // the group's level units, Event._copy_unit). The web has no unit
        // entry transitions, so every EntryType arrives at once, as add_unit
        // and create_unit do.
        const agArgs = parsePythonEventArgs(args, ['Group'], ['StartingGroup', 'EntryType', 'Placement'], ['create']);
        const groupNid = agArgs.value('Group') ?? '';
        const startingGroup = agArgs.value('StartingGroup') ?? '';
        const placement = (agArgs.value('Placement') || 'giveup').toLowerCase().trim();
        const createCopies = agArgs.flags.has('create');
        const groupEntryType = agArgs.value('EntryType') || 'fade';
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
          let existing = this.findUnit(uNid);
          if (createCopies) {
            existing = this.copyLevelUnit(uNid, game) ?? undefined;
            if (!existing) continue;
          } else if (existing?.position || existing?.isDead()) {
            continue;
          }

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
            const placed = this.findUnit(uNid);
            if (placed) this.entryTransition(placed, groupEntryType, null, game);
          } else {
            // Unit exists but not on map — place them
            game.actionLog.doAction(new ArriveOnMapAction(game, existing, finalPos, true));
            this.entryTransition(existing, groupEntryType, null, game);
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
          if (movementType === 'swoosh' && !this.skipMode) {
            // Python Event._move_unit has no swoosh branch: the unit stays
            // where it arrived on the map edge.
          } else if (this.skipMode || movementType !== 'normal') {
            const from: [number, number] | null = spawnedUnit.position
              ? [spawnedUnit.position[0], spawnedUnit.position[1]]
              : null;
            game.actionLog.doAction(new ArriveOnMapAction(game, spawnedUnit, finalDestination));
            if (!this.skipMode && from) this.moveTransition(spawnedUnit, movementType, from);
          } else {
            moves.push({ unit: spawnedUnit, target: finalDestination });
          }
        }

        if (moves.length === 0) {
          this.advancePointer();
          return false;
        }
        const blocks = !noBlock;
        if (blocks) this.blockingEventMovements = moves.length;
        let startedMoves = 0;
        for (const move of moves) {
          // Python's camera follows the last following mover.
          const followMove = !noFollow && move === moves[moves.length - 1];
          const started = this.beginEventMove(move.unit, move.target, 120, game, () => {
            if (blocks) {
              this.blockingEventMovements--;
              if (this.blockingEventMovements === 0) this.advancePointer();
            }
          }, followMove);
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
        // Python remove_group: warp -> WarpOut, fade (default) -> FadeOut,
        // anything else leaves at once.
        const removeType = (args[1] || 'fade').toLowerCase();
        const groups: any[] = game.currentLevel?.unit_groups ?? [];
        const group = groups.find((g: any) => g.nid === groupNid);
        if (group) {
          const unitNids: string[] = group.units ?? [];
          for (const uNid of unitNids) {
            const unit = this.findUnit(uNid);
            if (unit?.position) {
              if (removeType === 'warp' || removeType === 'fade') this.exitTransition(unit, removeType, null, game);
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
          if (movementType === 'swoosh' && !this.skipMode) {
            // Python Event._move_unit has no swoosh branch: no move.
          } else if (this.skipMode || movementType !== 'normal') {
            const from: [number, number] = [unit.position[0], unit.position[1]];
            // Python Event._move_unit: Teleport when immediate or skipped.
            const warp = new WarpUnitAction(unit, finalPosition, game.board);
            warp.turnwheelMove = this.skipMode || movementType === 'immediate';
            game.actionLog.doAction(warp);
            if (!this.skipMode) this.moveTransition(unit, movementType, from);
          } else {
            moves.push({ unit, target: finalPosition });
          }
        }

        if (moves.length === 0) {
          this.advancePointer();
          return false;
        }
        const blocks = !noBlock;
        if (blocks) this.blockingEventMovements = moves.length;
        let startedMoves = 0;
        for (const move of moves) {
          // Python's camera follows the last following mover.
          const followMove = !noFollow && move === moves[moves.length - 1];
          const started = this.beginEventMove(move.unit, move.target, 120, game, () => {
            if (blocks) {
              this.blockingEventMovements--;
              if (this.blockingEventMovements === 0) this.advancePointer();
            }
          }, followMove);
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
              giBannerText = `${colored(giItem.name, bannerItemColor(giItem))} sent to convoy.`;
            }
          } else {
            const giUnit = this.findUnit(giUnitNid);
            if (giUnit && this.inventoryFull(giUnit, giItem) && giArgs.flags.has('no_choice')) {
              // Python: a full inventory with no_choice sends it to the convoy.
              game.actionLog.doAction(new PutItemInConvoy(giItem, game.getParty()?.nid));
              giBannerText = `${colored(giItem.name, bannerItemColor(giItem))} sent to convoy.`;
            } else if (giUnit) {
              const giFull = this.inventoryFull(giUnit, giItem);
              game.actionLog.doAction(new GiveItemAction(giUnit, giItem));
              giBannerText = acquiredItemText(giUnit.name, giItem.name, bannerItemColor(giItem));
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
            riBannerText = `${colored(unit.name)} lost ${colored(item.name, bannerItemColor(item))}.`;
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
          : outcomeValue(evaluateExpressionOutcome(rawValue, this.buildConditionContext()));
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
        const requested = Number(outcomeValue(evaluateExpressionOutcome(args[2] ?? '', this.buildConditionContext())));
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
            this.banner = new Banner(`${colored(item.name, bannerItemColor(item))} broke.`, itemIcon(item), 3000, { sound: 'ItemBreak' });
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
          // Python RemoveSkill without a source: instances granted by an
          // item, terrain, region, aura, rescue or the game stay, and a count
          // only counts the instances actually removed.
          const removable = matches.filter((skill: SkillObject) => sourceAllowsPlainRemoval(skill));
          const removals = uid !== null || count === 1
            ? matches.slice(0, 1).filter((skill: SkillObject) => removable.includes(skill))
            : count < 0
              ? removable
              : removable.slice(0, count);
          rsRemovedSkill = matches[0];
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
        if (unit && Number.isFinite(amount) && isForkEngine()) {
          // As EOtF's engine does: add HP scaled by the target's received-heal
          // hooks (against itself when no healer is named), plus the healer's
          // empower_heal and multiplier when Unit2 is given; a named healer
          // that can't be found heals nothing.
          const healerNid = (args[2] ?? '').trim();
          const healer = healerNid ? this.findUnit(healerNid) ?? null : null;
          if (healerNid && !healer) {
            console.warn(`heal: couldn't find healer ${healerNid}`);
          } else {
            const healed = modifiedHealAmount(amount, unit, healer, game);
            game.actionLog.doAction(new SetCurrentHpAction(unit, unit.currentHp + healed));
          }
        } else if (unit && Number.isFinite(amount)) {
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
          // level cap, and level through autolevel_to so the unit
          // fires unit_level_up and learns skills, keeping its current HP.
          const maxLevel = getEffectiveLevelCap(unit, game);
          let exp = Math.max(-100, Math.min(100, parseInt(args[1], 10) || 0));
          const fork = isForkEngine();
          // The fork has no max-exp clamp or can_give_exp gate here: below
          // get_level_cap it levels up, at the cap it parks exp at 99, and
          // otherwise it just sets exp (Endless_Growth relies on this).
          const canGive = fork ? unit.level < maxLevel : canGiveExp(unit, exp, game);
          if (!fork) {
            const cap = 100 * ((canGive ? maxLevel + 1 : maxLevel) - unit.level) - unit.exp;
            exp = Math.min(exp, cap);
          }
          const oldExp = unit.exp;
          let queueMarker = -1;
          if (oldExp + exp >= 100) {
            if (fork && !canGive) {
              game.actionLog.doAction(new SetUnitExpAction(unit, 99));
            } else if (canGive) {
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
          } else if (exp > 0 && !fork) {
            if (canGive) game.actionLog.doAction(new SetUnitExpAction(unit, oldExp + exp));
          } else {
            game.actionLog.doAction(new SetUnitExpAction(unit, oldExp + exp));
          }
          this.advancePointer();
          return queueMarker >= 0 && this.runEventsQueuedSince(queueMarker, game);
        }
        if (unit) {
          const exp = Math.max(-100, Math.min(100, parseInt(args[1], 10) || 0));
          game.actionLog.doAction(
            new GainExpAction(unit, exp, game.currentMode?.growths ?? 'random'),
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
        if (value === VARIABLE_EVALUATION_FAILED) {
          console.warn(`game_var: could not evaluate ${args[1]}`);
        } else if (!isPrimitiveOrPrimitiveCollection(value)) {
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
        const evaluatedIncrement = args[1] === undefined ? 1 : this.evaluateVariableExpression(args[1], false);
        if (evaluatedIncrement === VARIABLE_EVALUATION_FAILED) {
          console.warn(`inc_game_var: could not evaluate ${args[1]}`);
        } else if (varName && game.gameVars) {
          const current = Number(game.gameVars.get(varName) ?? 0);
          const increment = Number(evaluatedIncrement);
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
        if (value === VARIABLE_EVALUATION_FAILED) {
          console.warn(`level_var: could not evaluate ${args[1]}`);
        } else if (!isPrimitiveOrPrimitiveCollection(value)) {
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
        const evaluatedIncrement = args[1] === undefined ? 1 : this.evaluateVariableExpression(args[1], false);
        if (evaluatedIncrement === VARIABLE_EVALUATION_FAILED) {
          console.warn(`inc_level_var: could not evaluate ${args[1]}`);
        } else if (varName && game.levelVars) {
          const current = Number(game.levelVars.get(varName) ?? 0);
          const increment = Number(evaluatedIncrement);
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
        // Python event reset: action.Reset (movement back to full; EOtF's
        // engine also runs on_refresh outside phase change and prep).
        if (unit) game.actionLog.doAction(new ResetAction(unit));
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
        // EvaluableString (can_preprocess = False): stored raw and evaluated
        // at draw time, unlike ordinary arguments. EOtF's engine has no such
        // exemption: braces are evaluated when the command runs, and the draw
        // re-evaluates only what survived that pass.
        const objectiveArgs = isForkEngine() ? args : rawArgs;
        const newObj = objectiveArgs[0] ?? '';
        if (game.currentLevel?.objective) {
          game.currentLevel.objective.simple = newObj;
        }
        this.advancePointer();
        return false;
      }

      case 'change_objective_win': {
        const newWin = (isForkEngine() ? args : rawArgs)[0] ?? '';
        if (game.currentLevel?.objective) {
          game.currentLevel.objective.win = newWin;
        }
        this.advancePointer();
        return false;
      }

      case 'change_objective_loss': {
        const newLoss = (isForkEngine() ? args : rawArgs)[0] ?? '';
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
        // Python event_functions.open_convoy;GlobalUnit;[include_other_units]:
        // pause the event over 'supply_items' for that unit.
        const ocArgs = parsePythonEventArgs(args, ['GlobalUnit'], [], ['include_other_units']);
        const ocUnit = this.findUnit(ocArgs.value('GlobalUnit') ?? '');
        this.advancePointer();
        if (!ocUnit) {
          console.warn(`open_convoy: Couldn't find unit with nid ${ocArgs.value('GlobalUnit') ?? ''}`);
          return false;
        }
        game.memory.set('supply_unit', ocUnit);
        game.memory.set('include_other_units', ocArgs.flags.has('include_other_units'));
        game.state.change('supply_items');
        return true;
      }

      // ----- Talk management -----

      case 'add_talk': {
        // add_talk;unit1_nid;unit2_nid
        if (game.eventManager && args.length >= 2) {
          game.actionLog.doAction(new AddTalkAction(args[0], args[1]));
        }
        this.advancePointer();
        return false;
      }

      case 'remove_talk': {
        if (game.eventManager && args.length >= 2) {
          game.actionLog.doAction(new RemoveTalkAction(args[0], args[1]));
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
          unit.team === nid && !!unit.position && !unitHasTag(unit, 'Tile'));
        if (team) {
          const teamExists = game.db.teams?.defs?.some((def: { nid: string }) => def.nid === team);
          if (!teamExists || !fieldTeam(team)) {
            console.warn(`end_turn: ${team} is not a valid team with units on the map`);
            this.advancePointer();
            return false;
          }
          for (let guard = 0; guard < 99 && game.phase.getNext(fieldTeam) !== team; guard += 1) {
            game.phase.next((nid: string) => phaseTeamUnits(game, nid));
          }
        }
        if (isForkEngine() && this.currentEvent) {
          // EOtF fork end_turn only queues the turn-change states
          // (turn_change, status_endstep, ai); the event keeps running its
          // remaining commands (Countdown_Proc, Round_Change) and queued
          // events survive. Change turns once this event has finished.
          this.forcedTurnEndEvents.add(this.currentEvent);
          this.advancePointer();
          return false;
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
          : outcomeValue(evaluateExpressionOutcome(rawValue, this.buildConditionContext()));
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
        // Python event_functions.promote: one class (given, or the only
        // turns_into) plays the promotion screen, or applies directly when
        // silent; several open promotion_choice (silent is then ignored).
        const promoUnitNid = args[0] ?? '';
        const promoUnit = this.findUnit(promoUnitNid);
        this.advancePointer();
        if (!promoUnit) {
          console.warn(`promote: couldn't find unit "${promoUnitNid}"`);
          return false;
        }
        const isSilent = args.some((a: string) => a.toLowerCase() === 'silent');
        const klassList = (args[1] ?? '').split(',').map((s: string) => s.trim()).filter((s: string) => s.length > 0);
        let options: string[] = [];
        let newKlass: string | null = null;
        if (klassList.length === 1) {
          newKlass = klassList[0];
        } else if (klassList.length > 1) {
          options = klassList;
        } else {
          const turnsInto: string[] = game.db.classes.get(promoUnit.klass)?.turns_into ?? [];
          if (turnsInto.length === 0) {
            console.warn(`promote: no promotion classes available for unit "${promoUnitNid}"`);
            return false;
          }
          if (turnsInto.length === 1) newKlass = turnsInto[0];
        }
        if (isSilent && newKlass) {
          performPromotionOrClassChange(promoUnit, newKlass, game, 'promote', 'exact');
          this.loadMapSpriteForUnit(promoUnit, game);
          return false;
        }
        if (isSilent && options.length) {
          console.warn('promote: silent flag set with multiple klass options. Silent will be ignored.');
        }
        requestPromotion(game, {
          unit: promoUnit, kind: 'promote', options, nextClass: newKlass,
          canGoBack: false, popBelow: 0, itemUse: null,
        });
        return true;
      }

      case 'change_class': {
        // change_class;unit_nid;[class_nid1,class_nid2,...];[silent]
        // Python event_functions.change_class: the given classes, else the
        // unit prefab's alternate_classes. One class plays the class change
        // screen (or applies directly when silent); several open
        // class_change_choice.
        const ccUnitNid = args[0] ?? '';
        const ccUnit = this.findUnit(ccUnitNid);
        this.advancePointer();
        if (!ccUnit) {
          console.warn(`change_class: couldn't find unit "${ccUnitNid}"`);
          return false;
        }
        const ccIsSilent = args.some((a: string) => a.toLowerCase() === 'silent');
        // EOtF's engine fork adds a no_wexp flag (absent from every
        // upstream lt-maker): the class change skips the new class's
        // starting weapon experience.
        const ccNoWexp = args.some((a: string) => a.toLowerCase() === 'no_wexp');
        const ccKlassList = (args[1] ?? '').split(',').map((s: string) => s.trim()).filter((s: string) => s.length > 0);
        let ccOptions: string[] = [];
        let ccNewKlass: string | null = null;
        if (ccKlassList.length === 1) {
          ccNewKlass = ccKlassList[0];
        } else if (ccKlassList.length > 1) {
          ccOptions = ccKlassList;
        } else if (!ccUnit.generic) {
          const alternates: string[] = (game.db.units.get(ccUnit.nid) as any)?.alternate_classes ?? [];
          if (alternates.length === 0) {
            console.warn(`change_class: no alternate classes available for unit "${ccUnitNid}"`);
            return false;
          }
          if (alternates.length === 1) ccNewKlass = alternates[0];
        } else {
          console.warn(`change_class: no alternate classes available for unit "${ccUnitNid}"`);
          return false;
        }
        if (ccNewKlass === ccUnit.klass) {
          console.warn('change_class: no need to change classes');
          return false;
        }
        if (ccIsSilent && ccNewKlass) {
          performPromotionOrClassChange(ccUnit, ccNewKlass, game, 'change_class', 'exact', !ccNoWexp);
          this.loadMapSpriteForUnit(ccUnit, game);
          return false;
        }
        requestPromotion(game, {
          unit: ccUnit, kind: 'class_change', options: ccOptions, nextClass: ccNewKlass,
          canGoBack: false, popBelow: 0, itemUse: null,
        });
        return true;
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
        const expressionFlag = flags.has('expression');
        const forkChoice = isForkEngine();
        const computeOptions = (source: string): string[] => forkChoice
          ? forkChoiceRows(source, expressionFlag, () => this.buildConditionContext())
          : computeUpstreamOptions(source);
        const computeUpstreamOptions = (source: string): string[] => {
          let options: string[] | null = null;
          if (expressionFlag || /[([]/.test(source)) {
            try {
              const evaluated = evaluateExpression(source, this.buildConditionContext());
              if (Array.isArray(evaluated)) {
                options = evaluated.map((entry: unknown) => String(entry));
              } else if (expressionFlag) {
                options = String(evaluated ?? '').split(',');
              }
            } catch {
              // Fall through to the literal reading below.
            }
          }
          options ??= source.split(',');
          return options
            .map((entry: string) => entry.trim())
            .filter((entry: string) => entry.length > 0);
        };
        const optionStrs = computeOptions(rawChoices);

        if (optionStrs.length > 0) {
          const entryType = (keywords.get('entrytype') ?? 'str').toLowerCase();
          const entries = this.buildChoiceEntries(optionStrs, entryType, game);
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
            // Python bg defaults to menu_bg_base; the EOtF fork always uses
            // the (window-skinned) menu_bg_base, ignoring an authored BG and
            // the no_bg flag alike.
            bg: forkChoice
              ? 'menu_bg_base'
              : flags.has('no_bg') ? null : (keywords.get('bg') || 'menu_bg_base'),
            textAlign: textAlignRaw === 'center' || textAlignRaw === 'right' ? textAlignRaw : 'left',
            noCursor: flags.has('no_cursor'),
            screenWidth: viewport.width,
            screenHeight: viewport.height,
            helpBoxes: this.buildChoiceHelpBoxes(entries.map((entry: EventChoiceEntry) => entry.value), entryType, game),
          });
          this.choiceNid = choiceNid;
          this.choiceEntryType = entryType;
          this.choiceValues = entries.map((entry: EventChoiceEntry) => entry.value);
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
          // Python choice `expression`: the options are a callable that
          // PlayerChoiceState.update re-evaluates ({} tags included) every
          // frame, refreshing the menu when they change.
          this.choiceRefresh = expressionFlag
            ? { raw: rawArgs[2] ?? rawChoices, entryType, last: optionStrs, compute: computeOptions }
            : null;
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
          // action.FadeOut
          this.exitTransition(enemy, 'fade', null, game);
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

        if (maNoBlock || maPermanent || this.skipMode) {
          this.advancePointer();
          return false;
        }
        // Block for the animation duration; the wait's completion advances.
        this.waiting = true;
        this.waitTimer = mapAnim.getDuration();
        return true;
      }

      case 'remove_map_anim': {
        // Python remove_map_anim;MapAnim;FloatPosition;[overlay]:
        // action.RemoveMapAnim drops the animations with that nid on that
        // position, from the overlay layer with the flag.
        const rmaAnimNid = args[0] ?? '';
        const rmaPosArg = args[1] ?? '';
        const rmaMatch = rmaPosArg.match(/^\(?\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\)?$/);
        const rmaPos: [number, number] | null = rmaMatch
          ? [parseFloat(rmaMatch[1]), parseFloat(rmaMatch[2])]
          : this.resolvePosition(rmaPosArg, game);
        if (!rmaPos) {
          console.warn(`remove_map_anim: Could not find position ${rmaPosArg}`);
        } else if (game.tilemap) {
          const overlay = args.slice(2).some((arg) => arg.toLowerCase().trim() === 'overlay');
          game.actionLog.doAction(new RemoveMapAnimationAction(game.tilemap, rmaAnimNid, rmaPos, overlay));
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
            typedForExpression.includes('(') ||
            /^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+$/.test(typedForExpression.trim())) {
          // Python's for evaluates the expression and iterates it (a dict
          // such as unit.wexp yields its keys).
          const evaluated = outcomeValue(evaluateExpressionOutcome(typedForExpression, this.buildConditionContext()));
          if (evaluated !== undefined && evaluated !== null) {
            try {
              forValues = pythonIterationValues(evaluated);
            } catch {
              forValues = [];
            }
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
        const ownerPortraits = this.portraits;
        const portraitOwner = this.currentEvent;
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
          ownerPortraits.set(portraitNid, portrait);
          if (this.settlePortraitLoad(portraitOwner, blocks) && blocks) {
            this.waiting = true;
            this.waitTimer = (14 * FRAMETIME) / speedMult + 33;
          }
        }).catch(() => {
          console.warn(`EventState: failed to load portrait "${resolvedNid}"`);
          if (this.settlePortraitLoad(portraitOwner, blocks) && blocks) {
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
          const ownerPortraits = this.portraits;
          const portraitOwner = this.currentEvent;
          game.resources.loadPortrait(resolvedNid).then((image: HTMLImageElement) => {
            const portrait = new EventPortrait(
              image, blinkOffset, smileOffset, pos, priority, pNid,
              { transition: true, mirror: autoMirror },
            );
            ownerPortraits.set(pNid, portrait);
            this.settlePortraitLoad(portraitOwner, true);
          }).catch(() => {
            console.warn(`EventState: failed to load portrait "${resolvedNid}"`);
            this.settlePortraitLoad(portraitOwner, true);
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
        // Python ChangeBackground: Panorama?, Speed? (ms per pixel with the
        // scroll flag, default 50), flags keep_portraits and scroll.
        const bgKnownFlags = new Set(['keep_portraits', 'scroll']);
        const bgFlagSet = new Set<string>();
        const bgValues: string[] = [];
        for (const a of args) {
          const lower = a.trim().toLowerCase();
          if (bgKnownFlags.has(lower)) bgFlagSet.add(lower);
          else bgValues.push(a.trim());
        }
        const bgArgs = parsePythonEventArgs(bgValues, [], ['Panorama', 'Speed']);
        const bgNid: string | null = bgArgs.value('Panorama') || null;
        const bgSpeed = parseInt(bgArgs.value('Speed') ?? '', 10);
        const bgScrollSpeed = bgFlagSet.has('scroll') ? (Number.isFinite(bgSpeed) && bgSpeed > 0 ? bgSpeed : 50) : null;

        if (!bgNid) {
          // Remove background
          this.background = null;
          this.backgroundPanorama = null;
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

          // Python create_background(panorama, False): a PanoramaBackground
          // over every frame of the panorama.
          const resourcePromise = game.resources
            ? loadPanoramaFrames(panoramaNid, game.resources)
              .then((frames) => frames.length ? frames : Promise.reject(new Error('missing')))
            : null;
          if (!resourcePromise) {
            this.backgroundLoadDone = true;
          } else {
            resourcePromise.then((frames: HTMLImageElement[]) => {
              if (this.backgroundLoadToken === token) {
                this.background = frames[0];
                this.backgroundPanorama = new PanoramaFrames(frames);
                // create_background(panorama, scroll): a single frame scrolls;
                // multi-frame panoramas animate in place.
                if (bgScrollSpeed !== null && frames.length === 1) {
                  this.backgroundPanorama.scrollSpeed = bgScrollSpeed;
                }
              }
            }).catch(() => {
              // Python changes nothing for a panorama it doesn't have.
              console.warn(`EventState: panorama "${panoramaNid}" not found`);
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
        // With several valid items a player unit chooses one in
        // unlock_select (the event pauses); other teams take the first.
        const unlockUnit = this.findUnit(args[0]?.trim() ?? '');
        const region = this.currentEvent?.trigger?.region ?? null;
        // `unlock` re-runs after unlock_select pops; its find half is done.
        const resumingUnlock = cmd.type === 'unlock' && this.unlockAwaitingSpend;
        this.unlockAwaitingSpend = false;
        if (cmd.type !== 'spend_unlock' && !resumingUnlock) game.memory.delete('unlock_item');
        if (unlockUnit && cmd.type !== 'spend_unlock' && !resumingUnlock) {
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
            const valid = allItems.filter((item) =>
              itemAvailable(unlockUnit, item, game.db, game) && itemCanUnlock(unlockUnit, item, region, game));
            if (valid.length > 1 && unlockUnit.team === 'player') {
              game.memory.set('current_unit', unlockUnit);
              game.memory.set('all_unlock_items', valid);
              game.state.change('unlock_select');
              if (cmd.type === 'unlock') {
                // Python queues find_unlock then spend_unlock; spend after
                // the choice by re-running this command when the event resumes.
                this.unlockAwaitingSpend = true;
              } else {
                this.advancePointer();
              }
              return true;
            }
            if (valid[0]) game.memory.set('unlock_item', valid[0]);
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
        } else if (isForkEngine()) {
          // As EOtF's engine does: without an Ability, fight with the
          // equipped weapon, else the first item carried (any item, usable
          // or not); a unit with no items starts no combat.
          iuAbilityItem = getEquippedWeapon(iuAttacker, game.db, game) ?? iuAttacker.items[0] ?? null;
          if (!iuAbilityItem) {
            console.warn(`interact_unit: ${iuAttacker.nid} has no item`);
            this.advancePointer();
            return false;
          }
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
            if (targetGroup.mainDefender || isForkEngine()) {
              queueCombatSkillStartEvents(
                game, iuAttacker, targetGroup.mainDefender ?? null, attackItem, defItem,
                isForkEngine() ? targetGroup.splashDefenders : [],
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
            const rngMode2 = game.rngMode;
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
        // make_generic;Nid;Klass;Level;Team;AI?;Faction?;AnimationVariant?;
        // ItemList? (positional or Keyword=value, as Python parses them).
        const mgArgs = parsePythonEventArgs(
          args.filter((arg) => arg.toLowerCase() !== 'no_warn'),
          ['Nid', 'Klass', 'Level', 'Team'],
          ['AI', 'Faction', 'AnimationVariant', 'ItemList'],
        );
        let mgNid = (mgArgs.value('Nid') ?? '').trim();
        const assignCreatedUnit = mgNid.length === 0;
        const mgKlass = mgArgs.value('Klass') ?? '';
        const mgLevel = parseInt(mgArgs.value('Level') ?? '', 10) || 1;
        const mgTeam = mgArgs.value('Team') || 'player';
        const mgAi = mgArgs.value('AI') || 'None';
        const mgFaction = mgArgs.value('Faction') ?? '';
        const mgVariant = mgArgs.value('AnimationVariant') ?? '';
        const mgItemStr = mgArgs.value('ItemList') ?? '';
        const mgItems: [string, boolean][] = mgItemStr
          ? mgItemStr.split(',').map((s: string) => s.trim()).filter(Boolean)
            .map((nid: string) => [nid, false] as [string, boolean])
          : [];

        // Python str_utils.get_next_int('201', unit nids).
        if (!mgNid) {
          mgNid = nextIntNid('201', game.units);
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
          faction: mgFaction || ((game.db.factions?.values?.().next?.().value as any)?.nid ?? ''),
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
            // Python item_funcs.create_items(unit, ...): the shopper owns the
            // stock items, so ones they cannot use are listed in grey.
            const shopItem = new ItemObjectClass(prefab);
            shopItem.owner = shopUnit;
            shopItems.push(shopItem);
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
        // Python event_functions: game_vars['_hide_ui'] (read by
        // AnimationCombat.ui_should_be_hidden), set directly, not an action.
        game.gameVars.set('_hide_ui', cmd.type === 'hide_combat_ui');
        this.advancePointer();
        return false;

      case 'pause_background': {
        // pause_background;[PauseAt]: PanoramaBackground.pause(pause_at).
        const pauseArg = (args[0] ?? '').trim();
        const pauseAt = pauseArg ? parseInt(pauseArg, 10) : NaN;
        if (!this.backgroundPanorama) console.warn('Event pause_background: No current background to pause!');
        else this.backgroundPanorama.pause(Number.isFinite(pauseAt) ? pauseAt : null);
        this.advancePointer();
        return false;
      }

      case 'unpause_background':
        if (!this.backgroundPanorama) console.warn('Event unpause_background: No current background to unpause');
        else this.backgroundPanorama.unpause();
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
        // EOtF's engine has no option descriptions (no _prep_options_info_descs)
        // and pads the enabled list by how many on-select events were given.
        const forkPrep = isForkEngine();
        if (otherOptions.length) {
          const enabled = prepList(args[3]).map(prepBool);
          const givenEvents = prepList(args[4]).length;
          if (forkPrep) for (let i = givenEvents; i < otherOptions.length; i++) enabled.push(false);
          else while (enabled.length < otherOptions.length) enabled.push(false);
          const onSelect: (string | null)[] = prepList(args[4]).map((entry) => entry || null);
          while (onSelect.length < otherOptions.length) onSelect.push(null);
          const descs = prepList(args[5]);
          while (descs.length < otherOptions.length) descs.push('');
          game.actionLog.doAction(new SetGameVarAction(game.gameVars, '_prep_options_enabled',
            forkPrep ? enabled : enabled.slice(0, otherOptions.length)));
          game.actionLog.doAction(new SetGameVarAction(game.gameVars, '_prep_options_events', onSelect.slice(0, otherOptions.length)));
          game.actionLog.doAction(new SetGameVarAction(game.gameVars, '_prep_additional_options', otherOptions));
          if (!forkPrep) {
            game.actionLog.doAction(new SetGameVarAction(game.gameVars, '_prep_options_info_descs', descs.slice(0, otherOptions.length)));
          }
        } else {
          game.actionLog.doAction(new SetGameVarAction(game.gameVars, '_prep_options_enabled', []));
          game.actionLog.doAction(new SetGameVarAction(game.gameVars, '_prep_options_events', []));
          if (!forkPrep) game.actionLog.doAction(new SetGameVarAction(game.gameVars, '_prep_options_info_descs', []));
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
          // The EOtF fork ignores an authored BG (skinned menu_bg_base).
          background: (!isForkEngine() && parsed.kw.get('bg')) || 'menu_bg_base',
          entryType: (parsed.kw.get('entrytype') || 'str').toLowerCase(),
          textAlignment: parsed.kw.get('textalign') || 'left',
          expression: parsed.flags.has('expression'),
          // EOtF's engine draws the skinned background even with no_bg.
          noBackground: !isForkEngine() && parsed.flags.has('no_bg'),
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
          // Python: an is_dying unit (a unit_death event runs before the
          // dying fade) gets game.death.miracle instead: it leaves the dying
          // list and is never Die'd. ResurrectAction still heals it, as
          // Python's SetHP(1000) does.
          if (isUnitDying(unit)) {
            clearUnitFx(unit);
            unit.isDying = false;
          }
          game.actionLog.doAction(new ResurrectAction(unit));
          // Python resurrect follows with action.Reset (on_refresh in EOtF's
          // engine, where Null Refresh waits the unit).
          game.actionLog.doAction(new ResetAction(unit));
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
      // Python mutates RECORDS/ACHIEVEMENTS directly (no action.do): they are
      // cross-save data that the turnwheel never rewinds.
      case 'create_record': {
        // create_record;nid;expression
        try {
          const nid = args[0];
          const value = args[1] ?? 'True';
          if (nid && RECORDS) {
            // Python create_record: an expression that raises is logged and skipped.
            const evaluated = outcomeValue(evaluateExpressionOutcome(value, this.buildConditionContext()));
            if (evaluated !== undefined) RECORDS.create(nid, evaluated);
          }
        } catch (e) { console.warn('create_record error:', e); }
        this.advancePointer();
        return false;
      }
      case 'update_record': {
        try {
          const nid = args[0];
          const value = args[1] ?? 'True';
          if (nid && RECORDS) {
            // Python update_record: an expression that raises is logged and skipped.
            const evaluated = outcomeValue(evaluateExpressionOutcome(value, this.buildConditionContext()));
            if (evaluated !== undefined) RECORDS.update(nid, evaluated);
          }
        } catch (e) { console.warn('update_record error:', e); }
        this.advancePointer();
        return false;
      }
      case 'replace_record': {
        try {
          const nid = args[0];
          const value = args[1] ?? 'True';
          if (nid && RECORDS) {
            // Python replace_record: an expression that raises is logged and skipped.
            const evaluated = outcomeValue(evaluateExpressionOutcome(value, this.buildConditionContext()));
            if (evaluated !== undefined) RECORDS.replace(nid, evaluated);
          }
        } catch (e) { console.warn('replace_record error:', e); }
        this.advancePointer();
        return false;
      }
      case 'delete_record': {
        try {
          if (args[0] && RECORDS) {
            RECORDS.delete(args[0]);
          }
        } catch (e) { console.warn('delete_record error:', e); }
        this.advancePointer();
        return false;
      }
      case 'unlock_difficulty': {
        try {
          if (args[0] && RECORDS) {
            RECORDS.unlockDifficulty(args[0]);
          }
        } catch (e) { console.warn('unlock_difficulty error:', e); }
        this.advancePointer();
        return false;
      }
      case 'unlock_song': {
        try {
          if (args[0] && RECORDS) {
            RECORDS.unlockSong(args[0]);
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
            ACHIEVEMENTS.add(nid, name, desc, complete, hidden);
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
            ACHIEVEMENTS.updateAchievement(args[0], args[1], args[2], hidden);
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
            const changedToComplete = ACHIEVEMENTS.complete(args[0], complete);
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
            ACHIEVEMENTS.clear();
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
    canStay: boolean = true,
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
      if (occupant && !(canStay && occupant === unit)) return false;
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
        // EOtF's engine (forked mid-2024; v1.90's app/events/event.py)
        // places at get_nearest_open_tile(unit, position): the nearest tile
        // the unit can stand on with no unit on it, the unit itself counting
        // as an occupant. Upstream later required a path to the tile
        // (get_closest_reachable_tile) and let the unit's own tile count as
        // open (da99faa2d, 2025-12); EOtF has neither.
        return this.nearestOpenTile(unit, position, false, game, false);
      case 'push': {
        // Python: ForcedMovement(occupant, get_nearest_open_tile(occupant,
        // position)). The reference (2025-12 to 2026-10 lt-maker) also
        // accepted the occupant's own tile, so nobody moved and the units
        // stacked; EOtF's engine (forked mid-2024) and upstream since
        // 0f96fd6f6 (can_stay=False) move the occupant off the tile.
        const destination = this.nearestOpenTile(occupant, position, false, game, false);
        if (!destination) return null;
        game.actionLog.doAction(new WarpUnitAction(occupant, destination, game.board));
        return position;
      }
      default:
        return position;
    }
  }

  // -----------------------------------------------------------------------
  // Unit spawning helper: handles both unique and generic units from level data
  // -----------------------------------------------------------------------

  /** Python add_unit/remove_unit AnimationType: a fade direction, unless 'fade'. */
  private fadeDirection(animationType: string | undefined): string | null {
    const value = (animationType ?? '').trim().toLowerCase();
    return value && value !== 'fade' ? value : null;
  }

  /**
   * Python Event._place_unit's presentation once the unit is on its tile:
   * warp -> WarpIn, swoosh -> SwooshIn, fade -> FadeIn (sliding in from a
   * map edge or a fade direction), immediate -> nothing. Skipped events
   * arrive at once. Nothing here blocks the event.
   */
  private entryTransition(unit: UnitObject, entryType: string, fadeDirection: string | null, game: any): void {
    if (this.skipMode || !unit.position) return;
    const type = entryType.trim().toLowerCase();
    if (type === 'warp') setUnitTransition(unit, 'warp_in');
    else if (type === 'swoosh') setUnitTransition(unit, 'swoosh_in');
    else if (type === 'fade') this.fadeTransition(unit, fadeDirection, true, game);
  }

  /**
   * Python remove_unit's presentation, before the unit leaves: warp ->
   * WarpOut, swoosh -> SwooshOut, fade -> FadeOut, else LeaveMap alone.
   */
  private exitTransition(unit: UnitObject, removeType: string, fadeDirection: string | null, game: any): void {
    if (this.skipMode || !unit.position) return;
    const type = removeType.trim().toLowerCase();
    if (type === 'warp') setUnitTransition(unit, 'warp_out');
    else if (type === 'swoosh') setUnitTransition(unit, 'swoosh_out');
    else if (type === 'fade') this.fadeTransition(unit, fadeDirection, false, game);
  }

  /**
   * action.FadeIn / FadeOut: on a map edge (or with a fade direction) the
   * sprite slides a tile in (2 px out) as fake_in/fake_out, else it fades.
   */
  private fadeTransition(unit: UnitObject, fadeDirection: string | null, arriving: boolean, game: any): void {
    const [x, y] = unit.position as [number, number];
    const width = game.tilemap?.width ?? 0;
    const height = game.tilemap?.height ?? 0;
    const onBorder = x === 0 || y === 0 || x === width - 1 || y === height - 1;
    if (!onBorder && !fadeDirection) {
      setUnitTransition(unit, arriving ? 'fade_in' : 'fade_out');
      return;
    }
    const distance = arriving ? TILEWIDTH : 2;
    let offset: [number, number] = [0, 0];
    if (x === 0 || fadeDirection === 'west') offset = [-distance, 0];
    else if (x === width - 1 || fadeDirection === 'east') offset = [distance, 0];
    else if (y === 0 || fadeDirection === 'north') offset = [0, -distance];
    else if (y === height - 1 || fadeDirection === 'south') offset = [0, distance];
    setUnitTransition(unit, arriving ? 'fake_in' : 'fake_out', { offset });
  }

  /** action.Warp / FadeMove / Swoosh: the move transition from `from`. */
  private moveTransition(unit: UnitObject, movementType: string, from: [number, number]): void {
    const type = movementType.trim().toLowerCase();
    const state: UnitTransitionState | null = type === 'warp' ? 'warp_move'
      : type === 'fade' ? 'fade_move'
        : type === 'swoosh' ? 'swoosh_move'
          : null;
    if (state && !this.skipMode) setUnitTransition(unit, state, { from });
  }

  /**
   * Python Event._copy_unit: a fresh off-map copy of a level unit, named by
   * str_utils.get_next_int(prefab nid, registry) and registered directly.
   */
  private copyLevelUnit(unitNid: string, game: any): UnitObject | null {
    const unitData = (game.currentLevel?.units ?? []).find((candidate: any) => candidate.nid === unitNid);
    if (!unitData) {
      console.warn(`EventState: Could not find level unit prefab for unit with nid: ${unitNid}`);
      return null;
    }
    const newNid = nextIntNid(unitData.nid, game.units);
    if (unitData.generic === true) {
      game.spawnGenericUnit({ ...unitData, nid: newNid, starting_position: null });
    } else {
      const prefab = game.db.units.get(unitData.nid);
      if (!prefab) return null;
      game.spawnUnit({ ...prefab, nid: newNid }, unitData.team ?? 'player', null, unitData.ai ?? 'None');
    }
    const copy: UnitObject | undefined = game.units.get(newNid);
    if (!copy) return null;
    copy.dead = false;
    if (game.currentParty) copy.party = game.currentParty;
    this.loadMapSpriteForUnit(copy, game);
    return copy;
  }

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
