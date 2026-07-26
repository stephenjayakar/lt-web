// ---------------------------------------------------------------------------
// Save / Load System — Serialize GameState to JSON, store in IndexedDB.
// Mirrors LT's app/engine/save.py.
// ---------------------------------------------------------------------------

import type { NID, LevelPrefab, ItemPrefab, SkillPrefab, RegionData } from '../data/types';
import type { Database } from '../data/database';
import type { UnitObject, StatusEffect } from '../objects/unit';
import { ItemObject as ItemObjectCtor } from '../objects/item';
import type { ItemObject } from '../objects/item';
import { SkillObject as SkillObjectCtor, setNextSkillUid, getNextSkillUid } from '../objects/skill';
import type { SkillObject } from '../objects/skill';
import { isItemSourcedSkill, dispatchEquipHooks, dispatchHoldHooks, ITEM_SOURCE_KEY, ITEM_SOURCE_TYPE_KEY, ITEM_SOURCE_NID_KEY } from '../combat/item-system';
import { removeAllAuraSourcedSkills } from '../combat/aura-system';
import { UnitObject as UnitObjectCtor } from '../objects/unit';
import type { PartyObject } from './party';
import { PartyObject as PartyObjectCtor } from './party';
import type { TileMapObject } from '../rendering/tilemap';
import { TileMapObject as TileMapObjectCtor } from '../rendering/tilemap';
import { DifficultyModeObject } from './difficulty';
import { Recordkeeper, type RecordkeeperSaveData } from './records';
import type { SupportPair } from './support-system';
import { SupportController } from './support-system';
import { GameBoard } from '../objects/game-board';
import { PathSystem } from '../pathfinding/path-system';
import { PhaseController } from './phase';
import { EventManager, GameEvent, type EventTrigger } from '../events/event-manager';
import { AIController } from '../ai/ai-controller';
import { RoamInfo } from './roam-info';
import { InitiativeTracker } from './initiative';
import { OverworldManager } from './overworld/overworld-manager';

// ============================================================================
// Save Data Interfaces
// ============================================================================

export interface UnitSaveData {
  nid: string;
  name: string;
  desc?: string;
  variant?: string | null;
  faction?: string | null;
  generic?: boolean;
  notes?: [string, string][];
  fields?: [string, any][];
  position: [number, number] | null;
  /** Optional for saves written before turn-start position persistence. */
  previousPosition?: [number, number] | null;
  team: string;
  klass: string;
  level: number;
  exp: number;
  stats: Record<string, number>;
  currentHp: number;
  growths: Record<string, number>;
  /** Optional for saves written before dynamic growth-point persistence. */
  growthPoints?: Record<string, number>;
  maxStats: Record<string, number>;
  statCapModifiers?: Record<string, number>;
  items: string[];        // item key references into items map
  /** Optional equipped-item keys for saves written after tracked equip state. */
  equippedWeaponKey?: string | null;
  equippedAccessoryKey?: string | null;
  skills: string[];       // skill NIDs (legacy; superseded by skillInstances with skillKey)
  tags: string[];
  ai: string;
  wexp: Record<string, number>;
  startingPosition: [number, number] | null;
  aiGroup: string;
  portraitNid: string;
  affinity: string;
  hasAttacked: boolean;
  hasMoved: boolean;
  hasTraded: boolean;
  finished: boolean;
  dead: boolean;
  hasCanto: boolean;
  party: string;
  persistent: boolean;
  statusEffects: StatusEffect[];
  rescuingNid: string | null;
  rescuedByNid: string | null;
  /** Optional Python-faithful pair-up/rescue state fields. */
  travelerNid?: string | null;
  leadUnit?: boolean;
  currentGuardGauge?: number;
  builtGuard?: boolean;
  /**
   * Mirrors Python's `current_mana` (unit.py:924). Only set on units that have
   * had `set_current_mana` applied at runtime; optional so legacy saves and
   * units that never touched mana restore with no dynamic property (matches
   * pre-existing behavior of items falling back to the MANA equation).
   */
  currentMana?: number;
  currentFatigue?: number;
  roamAi?: string | null;
  hasRescued?: boolean;
  hasDropped?: boolean;
  hasTaken?: boolean;
  hasGiven?: boolean;
  /** Per-unit skill instance records. New saves carry `skillKey` referencing
   *  an entry in `SaveDict.skills`; legacy saves carry inline `nid`/`data`
   *  and are restored via the re-derivation fallback. */
  skillInstances?: {
    nid: string;
    /** Identity key into SaveDict.skills (new-format saves). */
    skillKey?: string;
    /** Legacy inline instance data (old saves). */
    data?: [string, any][];
    initiatorNid?: string | null;
  }[];
}

export interface ItemSaveData {
  nid: string;
  name: string;
  desc: string;
  iconNid: string;
  iconIndex: [number, number];
  components: [string, any][];
  /** Optional for saves written before runtime item-data persistence. */
  data?: [string, any][];
  uses: number;
  maxUses: number;
  droppable: boolean;
  ownerNid: string | null;
  /** Key used in game.items map for lookup during restore. */
  mapKey: string;
  /** Optional for saves written before recursive subitem persistence. */
  subitemKeys?: string[];
}

export interface SkillSaveData {
  /** Per-instance identity (Python `uid`). */
  uid: number;
  /** Canonical key used by unit.skillInstances and item-source linkage. */
  skillKey: string;
  nid: string;
  /** Owning unit NID (Python `owner_nid`); null for orphaned skills. */
  ownerNid: string | null;
  /** NID of the granting/initiating unit (Python `initiator_nid`). */
  initiatorNid: string | null;
  name: string;
  desc: string;
  iconNid: string;
  iconIndex: [number, number];
  components: [string, any][];
  data: [string, any][];
  /** For item-sourced skills: the granting item's mapKey (reconnected on restore). */
  itemSourceKey?: string | null;
}

/** Full runtime region state, mirroring RegionData so runtime-created/mutated
 * regions (via add_region, region_condition, etc.) survive save/load. */
export interface RegionSaveData {
  nid: string;
  region_type: string;
  position: [number, number];
  size: [number, number];
  sub_nid: string;
  condition: string;
  time_left: number | null;
  only_once: boolean;
  interrupt_move: boolean;
  hide_time: boolean;
}

export interface LevelSaveData {
  nid: string;
  name: string;
  tilemapNid: string;
  layerVisibility: [string, boolean][];
  weather: string[];
  party: string;
  music: Record<string, string>;
  objective: { simple: string; win: string; loss: string };
  unitNids: string[];
  /** Full region state (position/size/type/condition/etc). Preferred over legacy regionNids. */
  regions?: RegionSaveData[];
  /** @deprecated Legacy field from saves written before full region-state persistence. */
  regionNids?: string[];
}

export interface PartySaveData {
  nid: string;
  name: string;
  leaderNid: string;
  money: number;
  convoyItemKeys: string[];
  bexp: number;
}

export interface SupportPairSaveData {
  nid: string;
  unit1Nid: string;
  unit2Nid: string;
  points: number;
  lockedRanks: string[];
  unlockedRanks: string[];
  pointsGainedThisChapter: number;
  ranksGainedThisChapter: number;
}

export interface InitiativeSaveData {
  unitLine: string[];
  initiativeLine: number[];
  currentIdx: number;
  drawMe: boolean;
}

export interface OverworldSaveData {
  prefabNid: string;
  enabledNodes: string[];
  enabledRoads: string[];
  entities: Array<[string, any]>;
  enabledMenuOptions: Array<[string, Array<[string, boolean]>]>;
  visibleMenuOptions: Array<[string, Array<[string, boolean]>]>;
  selectedPartyNid: string | null;
  nodeProperties: Array<[string, string[]]>;
  nextLevel: string | null;
}

export interface EventSaveData {
  nid: string;
  trigger: EventTrigger;
  commandPointer: number;
  state: 'running' | 'waiting' | 'done';
  currentDialog: { speaker: string; text: string } | null;
  waitingForInput: boolean;
  pyev1State?: any;
}

export interface SaveDict {
  units: UnitSaveData[];
  items: ItemSaveData[];
  skills: SkillSaveData[];
  level: LevelSaveData | null;
  skillCounter?: number;
  turncount: number;
  playtime: number;
  gameVars: [string, any][];
  levelVars: [string, any][];
  currentMode: Record<string, any> | null;
  parties: PartySaveData[];
  currentParty: string;
  stateStack: string[];
  activeAiGroups: string[];
  records: RecordkeeperSaveData | null;
  supports: SupportPairSaveData[] | null;
  marketItems: [string, number][];
  baseConvos: [string, boolean][];
  /** Optional for compatibility with saves written before lore persistence. */
  unlockedLore?: string[];
  talkOptions: [string, string][];
  fogState: any | null;
  roamInfo: { roam: boolean; roamUnitNid: string | null };
  overworldRegistry: [string, any][];
  memory: [string, any][];
  /** Optional for compatibility with saves written before dialog-log persistence. */
  dialogLogEntries?: Array<{ speaker: string; text: string }>;
  /** NIDs of only_once events already triggered. Optional for legacy saves (defaults to empty). */
  initiative?: InitiativeSaveData | null;
  overworld?: OverworldSaveData | null;
  eventQueue?: EventSaveData[];
  alreadyTriggeredEvents?: string[];
  /** Movement bounds override on the game board (Python game_state 'bounds'). */
  boardBounds?: [number, number, number, number];
  /**
   * Talk pair keys ("unitA|unitB") hidden via hide_talk (mirrors Python's
   * `game_state.talk_hidden`). Optional for legacy saves (defaults to empty).
   */
  talkHidden?: string[];
}

export interface SaveMetadata {
  playtime: number;
  realtime: number;
  version: string;
  title: string;
  mode: string | null;
  levelNid: string | null;
  levelTitle: string;
  kind: string;
  displayName: string | null;
}

export interface SaveSlot {
  idx: number;
  name: string;
  playtime: number;
  realtime: number;
  kind: string;
  mode: string | null;
  levelNid: string | null;
  displayName: string | null;
}

// ============================================================================
// IndexedDB Helpers
// ============================================================================

const DB_NAME = 'lt-web-saves';
const STORE_NAME = 'saves';
const DB_VERSION = 1;
const CURRENT_SAVE_VERSION = '1.0.0';
let lastLoadError: string | null = null;

export function getLastLoadError(): string | null {
  return lastLoadError;
}

export function validateSaveVersion(version: string | undefined): void {
  if (!version) return; // Pre-version metadata is a supported legacy format.
  const major = Number.parseInt(version.split('.')[0] ?? '', 10);
  if (!Number.isFinite(major)) {
    throw new Error(`Save has an invalid version "${version}"`);
  }
  if (major > Number.parseInt(CURRENT_SAVE_VERSION.split('.')[0], 10)) {
    throw new Error(
      `Save version ${version} is newer than supported version ${CURRENT_SAVE_VERSION}`,
    );
  }
}

function validateSaveState(game: any, save: SaveDict): void {
  if (!save || typeof save !== 'object') {
    throw new Error('Save data is missing or corrupt');
  }
  for (const field of ['units', 'items', 'parties', 'gameVars', 'levelVars'] as const) {
    if (!Array.isArray(save[field])) {
      throw new Error(`Save data is corrupt: "${field}" must be an array`);
    }
  }
  for (const event of save.eventQueue ?? []) {
    if (!game.db?.events?.has?.(event.nid)) {
      throw new Error(`Save references missing event "${event.nid}"`);
    }
  }
  for (const stateName of save.stateStack ?? []) {
    if (!game.state?.hasState?.(stateName)) {
      throw new Error(`Save references unsupported state "${stateName}"`);
    }
  }
}

/** Cached database connection. */
let _dbInstance: IDBDatabase | null = null;

async function openDB(): Promise<IDBDatabase> {
  if (_dbInstance) return _dbInstance;

  return new Promise<IDBDatabase>((resolve, reject) => {
    try {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME);
        }
      };

      request.onsuccess = () => {
        _dbInstance = request.result;
        // Clear cached handle if the connection closes unexpectedly
        _dbInstance.onclose = () => { _dbInstance = null; };
        _dbInstance.onversionchange = () => {
          _dbInstance?.close();
          _dbInstance = null;
        };
        resolve(_dbInstance);
      };

      request.onerror = () => {
        console.warn('IndexedDB open failed:', request.error);
        reject(request.error);
      };
    } catch (err) {
      console.warn('IndexedDB not available:', err);
      reject(err);
    }
  });
}

async function idbGet(key: string): Promise<any> {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const request = store.get(key);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } catch (err) {
    console.warn(`idbGet("${key}") failed, trying localStorage fallback:`, err);
    return localStorageGet(key);
  }
}

async function idbSet(key: string, value: any): Promise<void> {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const request = store.put(value, key);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  } catch (err) {
    console.warn(`idbSet("${key}") failed, trying localStorage fallback:`, err);
    localStorageSet(key, value);
  }
}

async function idbDelete(key: string): Promise<void> {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const request = store.delete(key);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  } catch (err) {
    console.warn(`idbDelete("${key}") failed, trying localStorage fallback:`, err);
    localStorageDelete(key);
  }
}

async function idbKeys(): Promise<string[]> {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const request = store.getAllKeys();
      request.onsuccess = () => resolve(request.result as string[]);
      request.onerror = () => reject(request.error);
    });
  } catch (err) {
    console.warn('idbKeys() failed, trying localStorage fallback:', err);
    return localStorageKeys();
  }
}

// ============================================================================
// localStorage Fallback
// ============================================================================

const LS_PREFIX = 'lt-save:';

function localStorageGet(key: string): any {
  try {
    const raw = localStorage.getItem(LS_PREFIX + key);
    return raw ? JSON.parse(raw) : undefined;
  } catch {
    return undefined;
  }
}

function localStorageSet(key: string, value: any): void {
  try {
    localStorage.setItem(LS_PREFIX + key, JSON.stringify(value));
  } catch {
    console.warn('localStorage save failed (quota exceeded?)');
  }
}

function localStorageDelete(key: string): void {
  try {
    localStorage.removeItem(LS_PREFIX + key);
  } catch {
    // ignore
  }
}

function localStorageKeys(): string[] {
  const keys: string[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(LS_PREFIX)) {
        keys.push(k.slice(LS_PREFIX.length));
      }
    }
  } catch {
    // ignore
  }
  return keys;
}
// Serialization Functions
// ============================================================================

function serializeUnit(
  unit: UnitObject,
  itemKeyByObject: Map<ItemObject, string>,
  skillKeyByObject: Map<SkillObject, string>,
): UnitSaveData {
  const itemKeys = unit.items
    .map((item) => itemKeyByObject.get(item))
    .filter((key): key is string => !!key);
  const skillNids: string[] = unit.skills.map(s => s.nid);
  // New-format skillInstances reference the authoritative skill record by
  // skillKey; the per-instance data lives on that record. We omit `data`
  // here to avoid duplicating live ItemObject references (itemSource) that
  // would break JSON serialization. Legacy saves (no skillKey) carried
  // inline data; the restore fallback handles those separately.
  const skillInstances = unit.skills.map(skill => ({
    nid: skill.nid,
    skillKey: skillKeyByObject.get(skill),
    initiatorNid: skill.initiatorNid ?? null,
  }));

  return {
    nid: unit.nid,
    name: unit.name,
    desc: unit.desc,
    variant: unit.variant,
    faction: unit.faction,
    generic: unit.generic,
    notes: unit.notes.map(([key, value]) => [key, value]),
    fields: Array.from(unit.fields.entries()),
    position: unit.position ? [unit.position[0], unit.position[1]] : null,
    previousPosition: unit.previousPosition
      ? [unit.previousPosition[0], unit.previousPosition[1]]
      : null,
    team: unit.team,
    klass: unit.klass,
    level: unit.level,
    exp: unit.exp,
    stats: { ...unit.stats },
    currentHp: unit.currentHp,
    growths: { ...unit.growths },
    growthPoints: { ...unit.growthPoints },
    maxStats: { ...unit.maxStats },
    statCapModifiers: { ...unit.statCapModifiers },
    items: itemKeys,
    equippedWeaponKey: unit.equippedWeapon ? itemKeyByObject.get(unit.equippedWeapon) ?? null : null,
    equippedAccessoryKey: unit.equippedAccessory ? itemKeyByObject.get(unit.equippedAccessory) ?? null : null,
    skills: skillNids,
    tags: [...unit.tags],
    ai: unit.ai,
    wexp: { ...unit.wexp },
    startingPosition: unit.startingPosition
      ? [unit.startingPosition[0], unit.startingPosition[1]]
      : null,
    aiGroup: unit.aiGroup,
    portraitNid: unit.portraitNid,
    affinity: unit.affinity,
    hasAttacked: unit.hasAttacked,
    hasMoved: unit.hasMoved,
    hasTraded: unit.hasTraded,
    finished: unit.finished,
    dead: unit.dead,
    hasCanto: unit.hasCanto,
    party: unit.party,
    persistent: unit.persistent,
    statusEffects: unit.statusEffects.map(se => ({ ...se })),
    rescuingNid: unit.rescuing ? unit.rescuing.nid : null,
    rescuedByNid: unit.rescuedBy ? unit.rescuedBy.nid : null,
    travelerNid: unit.traveler,
    leadUnit: unit.leadUnit,
    currentGuardGauge: unit.getGuardGauge(),
    builtGuard: unit.builtGuard,
    hasRescued: unit.hasRescued,
    hasDropped: unit.hasDropped,
    hasTaken: unit.hasTaken,
    hasGiven: unit.hasGiven,
    skillInstances,
    currentMana: (unit as any).currentMana,
    currentFatigue: unit.currentFatigue || 0,
    roamAi: unit.roamAi ?? null,
  };
}

function serializeItem(item: ItemObject, mapKey: string, itemKeyByObject: Map<ItemObject, string>): ItemSaveData {
  const components: [string, any][] = [];
  for (const [k, v] of item.components) {
    components.push([k, v]);
  }

  return {
    nid: item.nid,
    name: item.name,
    desc: item.desc,
    iconNid: item.iconNid,
    iconIndex: [item.iconIndex[0], item.iconIndex[1]],
    components,
    data: Array.from(item.data.entries()),
    uses: item.uses,
    maxUses: item.maxUses,
    droppable: item.droppable,
    ownerNid: item.owner ? item.owner.nid : null,
    mapKey,
    subitemKeys: item.subitems
      .map((subitem) => itemKeyByObject.get(subitem))
      .filter((key): key is string => !!key),
  };
}

function serializeSkill(
  skill: SkillObject,
  skillKey: string,
  ownerNid: string | null,
  itemKeyByObject: Map<ItemObject, string>,
): SkillSaveData {
  const components: [string, any][] = [];
  for (const [k, v] of skill.components) {
    components.push([k, v]);
  }

  // The item-source entry holds a live ItemObject reference; swap it for the
  // item's canonical save key so restore can reconnect the same instance.
  // Other source metadata (pairupSource/rescueSource NID strings, itemSourceNid,
  // itemSourceType) is already JSON-serializable and round-trips in `data`.
  const data: [string, any][] = [];
  let itemSourceKey: string | null = null;
  for (const [k, v] of skill.data) {
    if (k === ITEM_SOURCE_KEY) {
      const key = v instanceof Object ? itemKeyByObject.get(v as ItemObject) : undefined;
      if (key) {
        itemSourceKey = key;
        continue; // drop the live reference; reconnected on restore
      }
      // Unresolvable reference: keep the entry as-is so legacy readers see it.
      data.push([k, v]);
    } else if (k === 'multiSkillSource' && v instanceof SkillObjectCtor) {
      data.push(['multiSkillSourceUid', v.uid]);
    } else {
      data.push([k, v]);
    }
  }

  return {
    uid: skill.uid,
    skillKey,
    nid: skill.nid,
    ownerNid,
    initiatorNid: skill.initiatorNid ?? null,
    name: skill.name,
    desc: skill.desc,
    iconNid: skill.iconNid,
    iconIndex: [skill.iconIndex[0], skill.iconIndex[1]],
    components,
    data,
    itemSourceKey,
  };
}

function serializeLevel(
  level: LevelPrefab,
  tilemap: TileMapObject | null,
): LevelSaveData {
  // Collect layer visibility
  const layerVisibility: [string, boolean][] = [];
  if (tilemap) {
    for (const layer of tilemap.layers) {
      layerVisibility.push([layer.nid, layer.visible]);
    }
  }

  // Collect active weather
  const weather: string[] = [];
  if (tilemap) {
    for (const w of tilemap.weather) {
      weather.push(w.nid);
    }
  }

  // Collect unit NIDs from level units
  const unitNids: string[] = level.units.map(u => u.nid);

  // Collect full region state (position/size/type/condition/etc.) so
  // runtime-created or -mutated regions survive save/load.
  const regions: RegionSaveData[] = (level.regions ?? []).map((r) => ({
    nid: r.nid,
    region_type: r.region_type,
    position: [r.position[0], r.position[1]],
    size: [r.size[0], r.size[1]],
    sub_nid: r.sub_nid,
    condition: r.condition,
    time_left: r.time_left,
    only_once: r.only_once,
    interrupt_move: r.interrupt_move,
    hide_time: r.hide_time,
  }));

  return {
    nid: level.nid,
    name: level.name,
    tilemapNid: level.tilemap,
    layerVisibility,
    weather,
    party: level.party,
    music: { ...level.music },
    objective: { ...level.objective },
    unitNids,
    regions,
  };
}

function serializeParty(party: PartyObject, itemKeyByObject: Map<ItemObject, string>): PartySaveData {
  const convoyItemKeys = party.convoy
    .map((item) => itemKeyByObject.get(item))
    .filter((key): key is string => !!key);

  return {
    nid: party.nid,
    name: party.name,
    leaderNid: party.leaderNid,
    money: party.money,
    convoyItemKeys,
    bexp: party.bexp,
  };
}

function serializeSupportPair(pair: SupportPair): SupportPairSaveData {
  return {
    nid: pair.nid,
    unit1Nid: pair.unit1Nid,
    unit2Nid: pair.unit2Nid,
    points: pair.points,
    lockedRanks: [...pair.lockedRanks],
    unlockedRanks: [...pair.unlockedRanks],
    pointsGainedThisChapter: pair.pointsGainedThisChapter,
    ranksGainedThisChapter: pair.ranksGainedThisChapter,
  };
}

// ============================================================================
// Build SaveDict from Game State
// ============================================================================

export function buildSaveDict(game: any): SaveDict {
  // Assign canonical save keys from the item's current container. Runtime registry
  // keys may describe an old owner after event/trade movement and cannot be trusted.
  const itemKeyByObject = new Map<ItemObject, string>();
  const usedItemKeys = new Set<string>();
  const registerItem = (item: ItemObject, preferredKey: string) => {
    if (itemKeyByObject.has(item)) return;
    let key = preferredKey;
    let suffix = 2;
    while (usedItemKeys.has(key)) key = `${preferredKey}_${suffix++}`;
    usedItemKeys.add(key);
    itemKeyByObject.set(item, key);
    item.subitems.forEach((subitem, index) => registerItem(subitem, `${key}_sub_${index}_${subitem.nid}`));
  };
  for (const unit of (game.units as Map<string, UnitObject>).values()) {
    unit.items.forEach((item, index) => registerItem(item, `unit_${unit.nid}_${index}_${item.nid}`));
  }
  for (const party of (game.parties as Map<string, PartyObject>).values()) {
    party.convoy.forEach((item, index) => registerItem(item, `convoy_${party.nid}_${index}_${item.nid}`));
  }
  // Preserve registered objects that are temporarily outside an inventory/convoy.
  for (const [key, item] of game.items as Map<string, ItemObject>) {
    registerItem(item, key);
  }
  const items = [...itemKeyByObject.entries()]
    .map(([item, key]) => serializeItem(item, key, itemKeyByObject));

  // Serialize all units (skills serialized separately so each skill instance
  // gets its own record keyed by identity, mirroring Python's skill_registry).
  const units: UnitSaveData[] = [];

  // Assign canonical per-instance skill keys. Like item mapKeys, these are
  // derived from the per-instance uid so they survive save/load round trips
  // and let unit.skillInstances / itemSource linkage reference exact instances.
  const skillKeyByObject = new Map<SkillObject, string>();
  const usedSkillKeys = new Set<string>();
  const registerSkill = (skill: SkillObject, ownerNid: string | null, index: number) => {
    if (skillKeyByObject.has(skill)) return;
    const base = `skill_${skill.uid ?? `o${ownerNid ?? 'x'}_${index}_${skill.nid}`}`;
    let key = base;
    let suffix = 2;
    while (usedSkillKeys.has(key)) key = `${base}_${suffix++}`;
    usedSkillKeys.add(key);
    skillKeyByObject.set(skill, key);
  };
  for (const unit of (game.units as Map<string, UnitObject>).values()) {
    unit.skills.forEach((skill, index) => registerSkill(skill, unit.nid, index));
  }

  // Serialize every skill instance (no NID dedupe). Python's skill_registry
  // holds one entry per instance; deduping by NID collapsed per-unit instances
  // and severed subskill/source chains.
  const skills: SkillSaveData[] = [];
  for (const unit of (game.units as Map<string, UnitObject>).values()) {
    for (const skill of unit.skills) {
      const skillKey = skillKeyByObject.get(skill);
      if (!skillKey) continue;
      skills.push(serializeSkill(skill, skillKey, unit.nid, itemKeyByObject));
    }
  }

  for (const unit of (game.units as Map<string, UnitObject>).values()) {
    units.push(serializeUnit(unit, itemKeyByObject, skillKeyByObject));
  }

  // Serialize level
  let level: LevelSaveData | null = null;
  if (game.currentLevel) {
    level = serializeLevel(game.currentLevel as LevelPrefab, game.tilemap as TileMapObject | null);
  }

  // Serialize parties
  const parties: PartySaveData[] = [];
  for (const party of (game.parties as Map<string, PartyObject>).values()) {
    parties.push(serializeParty(party, itemKeyByObject));
  }

  const stateStack: string[] = game.state?.getStackNames?.() ?? [];

  // Serialize supports
  let supports: SupportPairSaveData[] | null = null;
  if (game.supports) {
    try {
      // Access the pairs from the SupportController
      // The pairs are private, so we check for a save method or iterate
      const supportCtrl = game.supports;
      if (supportCtrl && typeof supportCtrl === 'object') {
        // Try to access pairs via any cast since it's private
        const pairs = (supportCtrl as any).pairs as Map<string, SupportPair> | undefined;
        if (pairs) {
          supports = [];
          for (const pair of pairs.values()) {
            supports.push(serializeSupportPair(pair));
          }
        }
      }
    } catch (err) {
      console.warn('Failed to serialize supports:', err);
    }
  }

  // Serialize records
  let records: RecordkeeperSaveData | null = null;
  if (game.records) {
    try {
      const rk = game.records as Recordkeeper;
      records = rk.save();
    } catch {
      // No records available
    }
  }

  // Serialize fog state from levelVars
  let fogState: any | null = null;
  const fogActive = game.levelVars?.get?.('_fog_of_war');
  if (fogActive) {
    fogState = {
      isActive: fogActive,
      type: game.levelVars?.get?.('_fog_of_war_type') ?? 1,
      radius: game.levelVars?.get?.('_fog_of_war_radius') ?? 0,
      aiRadius: game.levelVars?.get?.('_ai_fog_of_war_radius') ?? null,
      otherRadius: game.levelVars?.get?.('_other_fog_of_war_radius') ?? null,
    };
  }

  // Playtime: check if game tracks it; default to 0
  const playtime: number = (game as any).playtime ?? 0;

  // Talk options: may not exist on GameState yet
  const talkOptions: [string, string][] = [];
  if ((game as any).talkOptions) {
    for (const [k, v] of (game as any).talkOptions as Map<string, string>) {
      talkOptions.push([k, v]);
    }
  }

  const initiative: InitiativeSaveData | null = game.initiative
    ? {
        unitLine: [...game.initiative.unitLine],
        initiativeLine: [...game.initiative.initiativeLine],
        currentIdx: game.initiative.currentIdx,
        drawMe: game.initiative.drawMe,
      }
    : null;

  const overworldController = game.overworldController as OverworldManager | null;
  const overworld: OverworldSaveData | null = overworldController
    ? {
        prefabNid: overworldController.prefab.nid,
        enabledNodes: [...overworldController.enabledNodes],
        enabledRoads: [...overworldController.enabledRoads],
        entities: [...overworldController.entities.entries()].map(([nid, entity]) => [
          nid,
          {
            nid: entity.nid,
            dtype: entity.dtype,
            dnid: entity.dnid,
            onNode: entity.onNode,
            team: entity.team,
            displayPosition: entity.displayPosition ? [...entity.displayPosition] : null,
          },
        ]),
        enabledMenuOptions: [...overworldController.enabledMenuOptions.entries()]
          .map(([nid, options]) => [nid, [...options.entries()]]),
        visibleMenuOptions: [...overworldController.visibleMenuOptions.entries()]
          .map(([nid, options]) => [nid, [...options.entries()]]),
        selectedPartyNid: overworldController.selectedPartyNid,
        nodeProperties: [...overworldController.nodeProperties.entries()]
          .map(([nid, properties]) => [nid, [...properties]]),
        nextLevel: overworldController.nextLevel,
      }
    : null;

  const eventQueue: EventSaveData[] = game.eventManager
    ? (game.eventManager as EventManager).eventQueue.map((event) => ({
        nid: event.nid,
        trigger: structuredClone(event.trigger),
        commandPointer: event.commandPointer,
        state: event.state,
        currentDialog: event.currentDialog ? { ...event.currentDialog } : null,
        waitingForInput: event.waitingForInput,
        pyev1State: event.pyev1Processor?.saveState?.(),
      }))
    : [];

  return {
    units,
    items,
    skills,
    level,
    turncount: game.turnCount ?? 1,
    playtime,
    gameVars: Array.from((game.gameVars as Map<string, any>).entries()),
    levelVars: Array.from((game.levelVars as Map<string, any>).entries()),
    currentMode: game.currentMode
      ? (game.currentMode as DifficultyModeObject).save()
      : null,
    parties,
    currentParty: game.currentParty ?? '',
    stateStack,
    activeAiGroups: Array.from((game.activeAiGroups as Set<string>).values()),
    records,
    supports,
    marketItems: Array.from((game.marketItems as Map<string, number>).entries()),
    baseConvos: Array.from((game.baseConvos as Map<string, boolean>).entries()),
    unlockedLore: [...(game.unlockedLore ?? [])],
    talkOptions,
    fogState,
    roamInfo: {
      roam: game.roamInfo?.roam ?? false,
      roamUnitNid: game.roamInfo?.roamUnitNid ?? null,
    },
    overworldRegistry: Array.from(
      (game.overworldRegistry as Map<string, any>).entries(),
    ),
    memory: Array.from((game.memory as Map<string, any>).entries()),
    dialogLogEntries: [...(game.dialogLogEntries ?? [])],
    initiative,
    overworld,
    eventQueue,
    // Persist the skill uid counter so subsequent constructions stay monotonic
    // and restored uids don't collide with new ones (Python set_next_uids).
    skillCounter: getNextSkillUid(),
    boardBounds: game.board
      ? ([...game.board.bounds] as [number, number, number, number])
      : undefined,
    alreadyTriggeredEvents: game.eventManager
      ? Array.from((game.eventManager as EventManager).getOnceTriggered())
      : [],
    talkHidden: game.eventManager
      ? (game.eventManager as EventManager).getTalkHidden()
      : [],
  };
}

// ============================================================================
// Build Metadata
// ============================================================================

function buildMetadata(game: any, kind: string): SaveMetadata {
  const level = game.currentLevel as LevelPrefab | null;
  const playtime: number = (game as any).playtime ?? 0;

  return {
    playtime,
    realtime: Date.now(),
    version: CURRENT_SAVE_VERSION,
    title: game.db?.getConstant?.('title', 'Lex Talionis') ?? 'Lex Talionis',
    mode: game.currentMode?.nid ?? null,
    levelNid: level?.nid ?? null,
    levelTitle: level?.name ?? 'Unknown',
    kind,
    displayName: null,
  };
}

// ============================================================================
// Save Functions
// ============================================================================

/**
 * Save the current game state to a numbered slot.
 *
 * @param game  The GameState singleton (typed as `any` to avoid circular deps).
 * @param slot  The save slot index (0-based).
 * @param kind  The save kind: 'start' | 'suspend' | 'battle' | 'turn_change'.
 */
export async function saveGame(
  game: any,
  slot: number,
  kind: string = 'battle',
): Promise<void> {
  try {
    const saveDict = buildSaveDict(game);
    const meta = buildMetadata(game, kind);

    const gameNid = game.db?.getConstant?.('game_nid', 'default') ?? 'default';
    const saveKey = `${gameNid}-${slot}`;
    const metaKey = `${saveKey}.meta`;

    await idbSet(saveKey, saveDict);
    await idbSet(metaKey, meta);


    const restartKey = `${gameNid}-restart-${slot}`;
    if (kind === 'start') {
      await idbSet(restartKey, structuredClone(saveDict));
      await idbSet(`${restartKey}.meta`, structuredClone(meta));
    } else if (
      typeof game.currentSaveSlot === 'number' &&
      game.currentSaveSlot !== slot
    ) {
      const oldRestartKey = `${gameNid}-restart-${game.currentSaveSlot}`;
      const oldRestart: SaveDict | undefined = await idbGet(oldRestartKey);
      const oldRestartMeta: SaveMetadata | undefined = await idbGet(`${oldRestartKey}.meta`);
      if (oldRestart && oldRestartMeta) {
        await idbSet(restartKey, structuredClone(oldRestart));
        await idbSet(`${restartKey}.meta`, structuredClone(oldRestartMeta));
      }
    }
    console.log(`Game saved to slot ${slot} (kind: ${kind})`);
  } catch (err) {
    console.error('Failed to save game:', err);
    throw err;
  }
}

/**
 * Save a suspend (quicksave) that is deleted after loading.
 */
export async function suspendGame(game: any): Promise<void> {
  try {
    const gameNid = game.db?.getConstant?.('game_nid', 'default') ?? 'default';
    const saveKey = `${gameNid}-suspend`;
    const saveDict = buildSaveDict(game);
    const meta = buildMetadata(game, 'suspend');

    await idbSet(saveKey, saveDict);
    await idbSet(`${saveKey}.meta`, meta);

    console.log('Game suspended');
  } catch (err) {
    console.error('Failed to suspend game:', err);
    throw err;
  }
}

// ============================================================================
// Restore Helpers
// ============================================================================

type SkillCtor = typeof SkillObjectCtor;

/**
 * Rebuild a single SkillObject instance from its new-format save record.
 * Restores per-instance uid, components, data, initiatorNid, and reconnects
 * an item-sourced skill's `itemSource` reference to the restored ItemObject
 * by its canonical save key. Returns null if the skill cannot be resolved
 * from DB or save data.
 */
function restoreSkillInstance(
  skillNid: string,
  savedSkillData: SkillSaveData | undefined,
  skillEntry: { nid: string; skillKey?: string; data?: [string, any][]; initiatorNid?: string | null },
  game: { db?: Database },
  SkillCtor: SkillCtor,
  itemsByKey: Map<string, ItemObject>,
): SkillObject | null {
  const dbSkillPrefab: SkillPrefab | undefined = game.db?.skills?.get?.(skillNid);
  const prefab: SkillPrefab | undefined = dbSkillPrefab ?? (savedSkillData ? {
    nid: savedSkillData.nid,
    name: savedSkillData.name,
    desc: savedSkillData.desc,
    icon_nid: savedSkillData.iconNid,
    icon_index: savedSkillData.iconIndex,
    components: savedSkillData.components,
  } : undefined);
  if (!prefab) {
    console.warn(`Skill "${skillNid}" not found in DB or save`);
    return null;
  }
  const skill = new SkillCtor(prefab);
  // Restore per-instance identity (Python self.uid = dat['uid']).
  if (savedSkillData && typeof savedSkillData.uid === 'number') {
    skill.restoreUid(savedSkillData.uid);
  }
  // Restore saved components (may have been modified at runtime).
  if (savedSkillData) {
    skill.components = new Map<string, any>();
    for (const [k, v] of savedSkillData.components) skill.components.set(k, v);
  }
  // Instance data: prefer the per-instance data captured on the unit record
  // (it round-trips pairup/rescue source NIDs and other per-instance state);
  // fall back to the shared skill-record data.
  const dataEntries = skillEntry.data ?? savedSkillData?.data ?? [];
  skill.data = new Map<string, any>(dataEntries);
  skill.initiatorNid = skillEntry.initiatorNid ?? savedSkillData?.initiatorNid ?? null;
  skill.ownerNid = savedSkillData?.ownerNid ?? null;

  // Reconnect item-source: the live ItemObject reference was swapped for the
  // item's mapKey at serialize time. Restore the exact object so mutations
  // (uses, data) flow through the right instance.
  if (savedSkillData?.itemSourceKey) {
    const item = itemsByKey.get(savedSkillData.itemSourceKey);
    if (item) {
      skill.data.set(ITEM_SOURCE_KEY, item);
      // Ensure source-type/nid tags are present (they round-trip via data,
      // but older new-format snapshots may have dropped them).
      if (!skill.data.has(ITEM_SOURCE_TYPE_KEY)) skill.data.set(ITEM_SOURCE_TYPE_KEY, 'item');
      if (!skill.data.has(ITEM_SOURCE_NID_KEY)) skill.data.set(ITEM_SOURCE_NID_KEY, item.nid);
    } else {
      console.warn(`Skill "${skillNid}": itemSourceKey "${savedSkillData.itemSourceKey}" not found in restored items`);
    }
  }
  return skill;
}

// ============================================================================
// Main Restore Function
// ============================================================================

/**
 * Restore the full game state from a SaveDict.
 *
 * CRITICAL: Restoration order matters. Items must be restored before units
 * (since units reference items), and units before parties, etc.
 *
 * This function uses dynamic imports to avoid circular dependency issues
 * with the object constructors.
 */
export async function restoreGameState(game: any, s: SaveDict): Promise<void> {
  validateSaveState(game, s);
  // Use static imports (already imported at top of file)
  const ItemCtor = ItemObjectCtor;
  const SkillCtor = SkillObjectCtor;
  const UnitCtor = UnitObjectCtor;
  const PartyCtor = PartyObjectCtor;

  // 1. Reset transient game state
  game.units.clear();
  game.items.clear();
  game.activeAiGroups.clear();
  game.selectedUnit = null;
  game.infoMenuUnit = null;
  game.combatTarget = null;
  game.combatScript = null;
  game.shopUnit = null;
  game.shopItems = null;
  game.shopStock = null;
  game.currentEvent = null;
  game._moveOrigin = null;
  game._pendingAfterMovement = null;
  game.initiative = null;
  game.overworldController = null;
  game.overworldMovement = null;

  // 2. Restore game vars and level vars
  game.gameVars = new Map(s.gameVars);
  game.levelVars = new Map(s.levelVars);

  // 3. Restore difficulty mode
  if (s.currentMode) {
    game.currentMode = DifficultyModeObject.restore(s.currentMode);
  } else {
    game.currentMode = null;
  }

  // 4. Restore playtime and turncount
  game.turnCount = s.turncount;
  if ((game as any).playtime !== undefined) {
    (game as any).playtime = s.playtime;
  }

  // 5. Restore items FIRST (units reference items by key)
  const itemsByKey = new Map<string, ItemObject>();
  for (const itemData of s.items) {
    try {
      // Try to find prefab in DB for full fidelity
      const dbPrefab: ItemPrefab | undefined = game.db?.items?.get?.(itemData.nid);
      const prefab: ItemPrefab = dbPrefab ?? {
        nid: itemData.nid,
        name: itemData.name,
        desc: itemData.desc,
        icon_nid: itemData.iconNid,
        icon_index: itemData.iconIndex,
        components: itemData.components,
      };

      const item = new ItemCtor(prefab);

      // Override runtime state from save
      item.name = itemData.name;
      item.desc = itemData.desc;
      item.uses = itemData.uses;
      item.maxUses = itemData.maxUses;
      item.droppable = itemData.droppable;
      item.data.clear();
      for (const [k, v] of itemData.data ?? []) item.data.set(k, v);
      if (!itemData.data) {
        const chapterUses = item.components.has('c_uses') && !item.components.has('uses');
        if (item.maxUses > 0) item.data.set(chapterUses ? 'starting_c_uses' : 'starting_uses', item.maxUses);
        if (item.maxUses > 0) item.data.set(chapterUses ? 'c_uses' : 'uses', item.uses);
      }

      // Override component values from save (they may have been modified at runtime)
      (item as any).components = new Map<string, any>();
      for (const [k, v] of itemData.components) {
        item.components.set(k, v);
      }

      itemsByKey.set(itemData.mapKey, item);
      game.items.set(itemData.mapKey, item);
    } catch (err) {
      console.warn(`Failed to restore item "${itemData.nid}" (key: ${itemData.mapKey}):`, err);
    }
  }
  // Reconnect recursive item graphs only after every saved item exists.
  for (const itemData of s.items) {
    const parent = itemsByKey.get(itemData.mapKey);
    if (!parent) continue;
    parent.subitems = (itemData.subitemKeys ?? [])
      .map((key) => itemsByKey.get(key))
      .filter((item): item is ItemObject => !!item);
    for (const child of parent.subitems) child.parentItem = parent;
  }

  // 6. Restore skills lookup. New-format saves key every instance by skillKey
  // (identity-preserving); legacy saves only have NIDs, so keep the by-nid
  // fallback for backward compatibility.
  const skillsByKey = new Map<string, SkillSaveData>();
  const skillsByNid = new Map<string, SkillSaveData>();
  for (const skillData of s.skills) {
    if (skillData.skillKey) skillsByKey.set(skillData.skillKey, skillData);
    // Legacy by-nid lookup keeps the last-seen record (mirrors old behavior).
    skillsByNid.set(skillData.nid, skillData);
  }
  // Re-seed the per-instance uid counter so restored uids stay stable and new
  // constructions don't collide (Python set_next_uids).
  if (s.skillCounter !== undefined) {
    setNextSkillUid(s.skillCounter);
  } else {
    let maxUid = 99;
    for (const skillData of s.skills) {
      if (typeof skillData.uid === 'number' && skillData.uid > maxUid) maxUid = skillData.uid;
    }
    setNextSkillUid(maxUid + 1);
  }

  // 7. Restore units (reference items/skills by key/nid lookup)
  const unitsByNid = new Map<string, UnitObject>();
  for (const unitData of s.units) {
    try {
      // Get the class definition from DB
      const klassDef = game.db?.classes?.get?.(unitData.klass);
      if (!klassDef) {
        console.warn(`Skipping unit "${unitData.nid}": class "${unitData.klass}" not found in DB`);
        continue;
      }

      // Build a synthetic UnitPrefab from the saved data
      const syntheticPrefab = {
        nid: unitData.nid,
        name: unitData.name,
        desc: unitData.desc ?? '',
        variant: unitData.variant ?? null,
        level: unitData.level,
        klass: unitData.klass,
        tags: unitData.tags,
        bases: unitData.stats,
        growths: unitData.growths,
        starting_items: [] as [string, boolean][],
        learned_skills: [] as [number, string][],
        wexp_gain: {} as Record<string, [boolean, number, number]>,
        portrait_nid: unitData.portraitNid,
        affinity: unitData.affinity,
      };

      const unit = new UnitCtor(syntheticPrefab, klassDef);

      // Override all fields from saved data
      unit.desc = unitData.desc ?? unit.desc;
      unit.variant = unitData.variant ?? null;
      unit.faction = unitData.faction ?? null;
      unit.generic = unitData.generic ?? false;
      unit.notes = (unitData.notes ?? []).map(([key, value]) => [key, value]);
      unit.fields = new Map(unitData.fields ?? []);
      unit.position = unitData.position;
      unit.team = unitData.team;
      unit.level = unitData.level;
      unit.exp = unitData.exp;
      unit.stats = { ...unitData.stats };
      unit.currentHp = unitData.currentHp;
      unit.growths = { ...unitData.growths };
      unit.growthPoints = { ...(unitData.growthPoints ?? {}) };
      for (const stat of Object.keys(unit.growths)) {
        if (unit.growthPoints[stat] === undefined) unit.growthPoints[stat] = 0;
      }
      unit.maxStats = { ...unitData.maxStats };
      unit.statCapModifiers = { ...(unitData.statCapModifiers ?? {}) };
      for (const stat of Object.keys(unit.maxStats)) {
        if (unit.statCapModifiers[stat] === undefined) unit.statCapModifiers[stat] = 0;
      }
      unit.tags = [...unitData.tags];
      unit.ai = unitData.ai;
      unit.wexp = { ...unitData.wexp };
      unit.startingPosition = unitData.startingPosition;
      unit.previousPosition = unitData.previousPosition
        ? [unitData.previousPosition[0], unitData.previousPosition[1]]
        : unitData.position
          ? [unitData.position[0], unitData.position[1]]
          : null;
      unit.aiGroup = unitData.aiGroup;
      unit.portraitNid = unitData.portraitNid;
      unit.affinity = unitData.affinity;
      unit.hasAttacked = unitData.hasAttacked;
      unit.hasMoved = unitData.hasMoved;
      unit.hasTraded = unitData.hasTraded;
      unit.finished = unitData.finished;
      unit.dead = unitData.dead;
      unit.hasCanto = unitData.hasCanto;
      unit.party = unitData.party;
      unit.persistent = unitData.persistent;
      unit.statusEffects = unitData.statusEffects.map(se => ({ ...se }));
      unit.traveler = unitData.travelerNid ?? unitData.rescuingNid ?? null;
      unit.leadUnit = unitData.leadUnit ?? (
        game.db.getConstant('pairup', false) && !!unitData.rescuingNid
      );
      unit.currentGuardGauge = unitData.currentGuardGauge ?? 0;
      unit.builtGuard = unitData.builtGuard ?? false;
      unit.hasRescued = unitData.hasRescued ?? false;
      unit.hasDropped = unitData.hasDropped ?? false;
      unit.hasTaken = unitData.hasTaken ?? false;
      unit.hasGiven = unitData.hasGiven ?? false;
      if (unitData.currentFatigue !== undefined) {
        unit.currentFatigue = unitData.currentFatigue;
      }
      if (unitData.roamAi !== undefined) {
        unit.roamAi = unitData.roamAi;
      }
      if (unitData.currentMana !== undefined) {
        (unit as any).currentMana = unitData.currentMana;
      }

      // Restore items onto the unit
      unit.items = [];
      for (const itemKey of unitData.items) {
        const item = itemsByKey.get(itemKey);
        if (item) {
          item.owner = unit;
          unit.items.push(item);
        } else {
          console.warn(`Unit "${unitData.nid}": item key "${itemKey}" not found in restored items`);
        }
      }

      // Restore tracked equipped weapon/accessory (autoequip fallback for old saves).
      unit.equippedWeapon = null;
      unit.equippedAccessory = null;
      const equippedWeapon = unitData.equippedWeaponKey != null
        ? itemsByKey.get(unitData.equippedWeaponKey) ?? null
        : null;
      const equippedAccessory = unitData.equippedAccessoryKey != null
        ? itemsByKey.get(unitData.equippedAccessoryKey) ?? null
        : null;
      if (equippedWeapon) unit.equippedWeapon = equippedWeapon;
      if (equippedAccessory) unit.equippedAccessory = equippedAccessory;
      // Old saves (or broken refs) fall back to autoequip-derived values.
      if (!unit.equippedWeapon || !unit.equippedAccessory) unit.autoequip();

      // Restore skills. New-format saves (skillInstances with skillKey) restore
      // every instance directly — including item-sourced skills, whose itemSource
      // reference is reconnected to the restored item by mapKey. Legacy saves
      // (no skillKey) skip item-sourced entries and re-derive them from equipped
      // / held items via dispatch hooks, preserving the old code path.
      unit.skills = [];
      const skillEntries: UnitSaveData['skillInstances'] = unitData.skillInstances ??
        unitData.skills.map(nid => ({
          nid,
          skillKey: undefined,
          data: undefined as [string, unknown][] | undefined,
          initiatorNid: null as string | null,
        }));
      const newFormat = skillEntries.some(e => e.skillKey);
      for (const skillEntry of skillEntries) {
        const skillNid = skillEntry.nid;
        const savedSkillData = skillEntry.skillKey
          ? skillsByKey.get(skillEntry.skillKey)
          : skillsByNid.get(skillNid);
        if (newFormat && skillEntry.skillKey) {
          // Item-sourced skills are restored as instances below; do not skip.
          try {
            const restored = restoreSkillInstance(
              skillNid,
              savedSkillData,
              skillEntry,
              game,
              SkillCtor,
              itemsByKey,
            );
            if (restored) unit.skills.push(restored);
          } catch (err) {
            console.warn(`Unit "${unitData.nid}": failed to restore skill "${skillNid}":`, err);
          }
          continue;
        }
        // Legacy path: skip item-sourced entries; they are re-derived below.
        const isItemSourced = Array.isArray(skillEntry.data) &&
          skillEntry.data.some(([k, v]) => k === ITEM_SOURCE_TYPE_KEY && v === 'item');
        if (isItemSourced) continue;
        try {
          const dbSkillPrefab: SkillPrefab | undefined = game.db?.skills?.get?.(skillNid);
          const instanceData = skillEntry.data;
          if (dbSkillPrefab) {
            const skill = new SkillCtor(dbSkillPrefab);
            if (savedSkillData) {
              (skill as any).components = new Map<string, any>();
              for (const [k, v] of savedSkillData.components) skill.components.set(k, v);
            }
            (skill as any).data = new Map<string, any>(instanceData ?? savedSkillData?.data ?? []);
            skill.initiatorNid = skillEntry.initiatorNid ?? null;
            skill.ownerNid = unit.nid;
            unit.skills.push(skill);
          } else if (savedSkillData) {
            const syntheticSkillPrefab: SkillPrefab = {
              nid: savedSkillData.nid,
              name: savedSkillData.name,
              desc: savedSkillData.desc,
              icon_nid: savedSkillData.iconNid,
              icon_index: savedSkillData.iconIndex,
              components: savedSkillData.components,
            };
            const skill = new SkillCtor(syntheticSkillPrefab);
            (skill as any).data = new Map<string, any>(instanceData ?? savedSkillData.data);
            skill.initiatorNid = skillEntry.initiatorNid ?? null;
            skill.ownerNid = unit.nid;
            unit.skills.push(skill);
          } else {
            console.warn(`Unit "${unitData.nid}": skill "${skillNid}" not found in DB or save`);
          }
        } catch (err) {
          console.warn(`Unit "${unitData.nid}": failed to restore skill "${skillNid}":`, err);
        }
      }

      // Reconnect multi-skill child ownership after all instances for this
      // unit exist. Saved UIDs are stable and avoid serializing live objects.
      for (const skill of unit.skills) {
        const sourceUid = skill.data.get('multiSkillSourceUid');
        if (typeof sourceUid !== 'number') continue;
        const source = unit.skills.find((candidate) => candidate.uid === sourceUid);
        if (source) {
          skill.data.set('multiSkillSource', source);
          skill.data.delete('multiSkillSourceUid');
          if (!skill.data.has('multiSkillSourceType')) {
            skill.data.set('multiSkillSourceType', 'multi_skill');
          }
        }
      }

      // Re-derive item-sourced skills ONLY for legacy saves (new-format
      // restores them as instances above with their itemSource reconnected).
      if (!newFormat) {
        if (unit.equippedWeapon) dispatchEquipHooks(unit, unit.equippedWeapon, true, game.db);
        if (unit.equippedAccessory) dispatchEquipHooks(unit, unit.equippedAccessory, true, game.db);
        for (const invItem of unit.items) dispatchHoldHooks(unit, invItem, true, game.db);
      }

      unitsByNid.set(unit.nid, unit);
      game.units.set(unit.nid, unit);
    } catch (err) {
      // A unit failing to restore here means it silently vanishes from the
      // game (not present in game.units at all), which is a serious data-
      // loss bug rather than an ignorable warning — surface it loudly.
      console.error(`Failed to restore unit "${unitData.nid}" — unit will be MISSING after load:`, err);
    }
  }

  // 7b. Resolve rescue references (needs all units to be created first)
  // 7b. Resolve rescue/pair references after every unit exists. No lifecycle
  // hooks run here; saved skills are already the authoritative runtime list.
  for (const unitData of s.units) {
    const unit = unitsByNid.get(unitData.nid);
    if (!unit) continue;
    const rescuingNid = unitData.rescuingNid ?? (unitData.leadUnit ? unitData.travelerNid : null);
    const rescuedByNid = unitData.rescuedByNid ?? (!unitData.leadUnit ? unitData.travelerNid : null);
    if (rescuingNid) unit.rescuing = unitsByNid.get(rescuingNid) ?? null;
    if (rescuedByNid) unit.rescuedBy = unitsByNid.get(rescuedByNid) ?? null;
  }

  // 8. Restore parties
  game.parties.clear();
  for (const partyData of s.parties) {
    try {
      const party = new PartyCtor(
        partyData.nid,
        partyData.name,
        partyData.leaderNid,
        partyData.money,
        partyData.bexp,
      );

      // Restore convoy items
      party.convoy = [];
      for (const itemKey of partyData.convoyItemKeys) {
        const item = itemsByKey.get(itemKey);
        if (item) {
          item.owner = null; // Convoy items are unowned
          party.convoy.push(item);
        }
      }

      game.parties.set(party.nid, party);
    } catch (err) {
      console.warn(`Failed to restore party "${partyData.nid}":`, err);
    }
  }
  game.currentParty = s.currentParty;

  // 9. Restore market/base
  game.marketItems = new Map(s.marketItems);
  game.baseConvos = new Map(s.baseConvos);
  game.unlockedLore = [...(s.unlockedLore ?? [])];

  // 9b. Restore talk options if game supports them
  if ((game as any).talkOptions !== undefined) {
    (game as any).talkOptions = new Map(s.talkOptions);
  }

  // 10. Restore records
  if (s.records) {
    try {
      game.records = Recordkeeper.restore(s.records);
    } catch (err) {
      console.warn('Failed to restore records:', err);
    }
  }

  // 11. Restore supports
  if (s.supports && game.supports) {
    try {
      const supportCtrl = game.supports;
      const pairs = (supportCtrl as any).pairs as Map<string, SupportPair> | undefined;
      if (pairs) {
        for (const savedPair of s.supports) {
          const existing = pairs.get(savedPair.nid);
          if (existing) {
            existing.points = savedPair.points;
            existing.lockedRanks = [...savedPair.lockedRanks];
            existing.unlockedRanks = [...savedPair.unlockedRanks];
            existing.pointsGainedThisChapter = savedPair.pointsGainedThisChapter;
            existing.ranksGainedThisChapter = savedPair.ranksGainedThisChapter;
          }
        }
      }
    } catch (err) {
      console.warn('Failed to restore supports:', err);
    }
  }

  // 12. Restore active AI groups
  game.activeAiGroups = new Set(s.activeAiGroups);

  // 13. Restore roam info
  if (game.roamInfo) {
    game.roamInfo.roam = s.roamInfo.roam;
    game.roamInfo.roamUnitNid = s.roamInfo.roamUnitNid;
  } else {
    game.roamInfo = new RoamInfo(s.roamInfo.roam, s.roamInfo.roamUnitNid);
  }

  // 14. Restore memory
  game.memory = new Map(s.memory);
  game.dialogLogEntries = (s.dialogLogEntries ?? []).map((entry) => ({ ...entry }));

  // 15. Restore level (if present)
  if (s.level) {
    await restoreLevel(game, s.level, unitsByNid, s.alreadyTriggeredEvents, s.talkHidden);
  }

  // Restore movement bounds after the board exists (legacy saves: natural bounds).
  if (s.boardBounds && game.board) {
    game.board.setBounds(...s.boardBounds);
  }

  if (s.initiative) {
    game.initiative = new InitiativeTracker();
    game.initiative.unitLine = [...s.initiative.unitLine];
    game.initiative.initiativeLine = [...s.initiative.initiativeLine];
    game.initiative.currentIdx = s.initiative.currentIdx;
    game.initiative.drawMe = s.initiative.drawMe;
  } else if (game.db?.getConstant?.('initiative', false)) {
    game.initiative = new InitiativeTracker();
    game.initiative.start(
      [...unitsByNid.values()].filter((unit) => unit.position && !unit.isDead()),
      game.db,
    );
  }

  if (s.overworld) {
    const prefab = game.db?.overworlds?.get?.(s.overworld.prefabNid);
    if (prefab) {
      const overworld = new OverworldManager(prefab);
      overworld.enabledNodes = new Set(s.overworld.enabledNodes);
      overworld.enabledRoads = new Set(s.overworld.enabledRoads);
      overworld.entities = new Map(structuredClone(s.overworld.entities));
      overworld.enabledMenuOptions = new Map(
        s.overworld.enabledMenuOptions.map(([nid, options]) => [nid, new Map(options)]),
      );
      overworld.visibleMenuOptions = new Map(
        s.overworld.visibleMenuOptions.map(([nid, options]) => [nid, new Map(options)]),
      );
      overworld.selectedPartyNid = s.overworld.selectedPartyNid;
      overworld.nodeProperties = new Map(
        s.overworld.nodeProperties.map(([nid, properties]) => [nid, new Set(properties)]),
      );
      overworld.nextLevel = s.overworld.nextLevel;
      game.overworldController = overworld;
    } else {
      console.warn(`Failed to restore overworld "${s.overworld.prefabNid}": prefab missing`);
    }
  }

  if (game.eventManager && s.eventQueue) {
    game.eventManager.eventQueue = [];
    for (const savedEvent of s.eventQueue) {
      const prefab = game.eventManager.getPrefab(savedEvent.nid);
      if (!prefab) {
        console.warn(`Failed to restore event "${savedEvent.nid}": prefab missing`);
        continue;
      }
      const event = new GameEvent(prefab, structuredClone(savedEvent.trigger), () => game);
      event.commandPointer = savedEvent.commandPointer;
      event.state = savedEvent.state;
      event.currentDialog = savedEvent.currentDialog ? { ...savedEvent.currentDialog } : null;
      event.waitingForInput = savedEvent.waitingForInput;
      if (savedEvent.pyev1State && event.pyev1Processor?.restoreState) {
        event.pyev1Processor.restoreState(savedEvent.pyev1State);
      }
      game.eventManager.eventQueue.push(event);
    }
  }

  if (s.stateStack?.length && game.state?.restoreStack) {
    game.state.restoreStack(s.stateStack);
  }

  // 16. Restore overworld registry
  game.overworldRegistry = new Map(s.overworldRegistry);
}

// ============================================================================
// Level Restoration
// ============================================================================

/**
 * Restore a level from saved data. This rebuilds the tilemap, game board,
 * path system, phase controller, etc.
 *
 * This is the most complex part of loading — it mirrors the level-loading
 * sequence in GameState.loadLevel() but uses saved state instead of fresh
 * prefab data.
 */
async function restoreLevel(
  game: any,
  levelData: LevelSaveData,
  unitsByNid: Map<string, UnitObject>,
  alreadyTriggeredEvents: string[] | undefined,
  talkHidden?: string[],
): Promise<void> {
  try {
    // Get the level prefab from DB
    const levelPrefab = game.db?.levels?.get?.(levelData.nid);
    if (!levelPrefab) {
      console.warn(`restoreLevel: level "${levelData.nid}" not found in DB`);
      return;
    }

    // Build the runtime region list. Prefer the fully-serialized `regions`
    // field. For legacy saves that only have `regionNids`, fall back to the
    // prefab's regions filtered to the saved NIDs — this is the "least
    // surprising" legacy behavior: it preserves which regions existed
    // (add/remove_region effects) even though per-region runtime mutations
    // (e.g. region_condition edits) are lost, since that data was never
    // captured by the old format. Very old saves with neither field fall
    // back to using the prefab's regions unmodified (current pre-fix
    // behavior).
    let regions: RegionData[];
    if (levelData.regions) {
      regions = levelData.regions.map((r) => ({ ...r }));
    } else if ((levelData as any).regionNids) {
      const savedNids: string[] = (levelData as any).regionNids;
      regions = (levelPrefab.regions ?? []).filter((r: RegionData) => savedNids.includes(r.nid));
    } else {
      regions = levelPrefab.regions ?? [];
    }
    // Clone the prefab so runtime region mutations don't leak back into the
    // shared DB prefab object (game.currentLevel used to alias it directly).
    game.currentLevel = { ...levelPrefab, regions };

    // Load tilemap
    const tilemapData = game.db?.tilemaps?.get?.(levelData.tilemapNid);
    if (!tilemapData) {
      console.warn(`restoreLevel: tilemap "${levelData.tilemapNid}" not found in DB`);
      return;
    }

    // Load tileset images
    const tilesetImages = new Map<string, HTMLImageElement>();
    const autotileImages = new Map<string, HTMLImageElement>();
    const tilesetDefs = new Map<string, any>();

    await Promise.all(
      tilemapData.tilesets.map(async (tsNid: string) => {
        const img = await game.resources?.tryLoadImage?.(
          `resources/tilesets/${tsNid}.png`,
        );
        if (img) tilesetImages.set(tsNid, img);

        const tsDef = game.db?.tilesets?.get?.(tsNid);
        if (tsDef) {
          tilesetDefs.set(tsNid, tsDef);
          if (tsDef.autotiles && Object.keys(tsDef.autotiles).length > 0) {
            const autoImg = await game.resources?.tryLoadImage?.(
              `resources/tilesets/${tsNid}_autotiles.png`,
            );
            if (autoImg) autotileImages.set(tsNid, autoImg);
          }
        }
      }),
    );

    // Build tilemap
    game.tilemap = TileMapObjectCtor.fromPrefab(tilemapData, tilesetImages, tilesetDefs, autotileImages);

    // Restore layer visibility
    if (game.tilemap && levelData.layerVisibility) {
      for (const [layerNid, visible] of levelData.layerVisibility) {
        if (visible) {
          game.tilemap.showLayer(layerNid, 'immediate');
        } else {
          game.tilemap.hideLayer(layerNid, 'immediate');
        }
      }
    }

    // Restore weather
    if (game.tilemap && levelData.weather) {
      for (const weatherNid of levelData.weather) {
        game.tilemap.addWeather(weatherNid);
      }
    }

    // Create GameBoard
    game.board = new GameBoard(game.tilemap.width, game.tilemap.height);
    game.board.onUnitPositionChanged = () => game.refreshPositionSkills();
    game.board.initFromTilemap(game.tilemap);

    // Initialize fog grids and opacity
    const teamOrder = game.db?.teams?.defs?.map((t: any) => t.nid) ?? [];
    game.board.initFogGrids(teamOrder);
    game.board.initOpacityGrid(game.db);

    // Place units on the board
    for (const unit of unitsByNid.values()) {
      if (unit.position && !unit.dead) {
        try {
          game.board.setUnit(unit.position[0], unit.position[1], unit);
        } catch (err) {
          console.warn(`restoreLevel: failed to place unit "${unit.nid}" at ${unit.position}:`, err);
        }
      }
    }

    // Re-derive aura coverage from scratch: auras are purely a function of
    // live position + skills, so strip any aura-sourced skills that came in
    // via the raw skill-restore loop above (their tags may be stale) and
    // recompute fresh now that every unit is placed on the board.
    for (const unit of unitsByNid.values()) {
      removeAllAuraSourcedSkills(unit);
    }
    if (game.refreshPositionSkills) {
      game.refreshPositionSkills();
    }

    // Recalculate fog of war
    if (game.recalculateAllFow) {
      game.recalculateAllFow();
    }

    // Rebuild each effective unit/skill variant after restoring skills.
    await game.loadAllMapSprites?.();

    // Create PathSystem
    game.pathSystem = new PathSystem(game.db, game);

    // Create PhaseController
    game.phase = new PhaseController(teamOrder);

    // Create EventManager
    game.eventManager = new EventManager(game.db?.events);
    game.eventManager.actionLog = game.actionLog ?? null;
    game.eventManager.setGameGetter(() => game);
    game.eventManager.restoreOnceTriggered(alreadyTriggeredEvents);
    game.eventManager.restoreTalkHidden(talkHidden);

    // Create AIController
    game.aiController = new AIController(game.db, game.board, game.pathSystem);
    game.aiController.gameRef = game;

    // Create/restore SupportController
    if (!game.supports && game.db?.supportPairs) {
      game.supports = new SupportController(
        game.db.supportPairs,
        game.db.supportRanks,
        game.db.supportConstants,
        game.db.affinities,
        game,
      );
      game.supports.initPairs();
    }

    // Initialize camera and cursor
    if (game.camera && game.tilemap) {
      game.camera.setMapSize(game.tilemap.width, game.tilemap.height);
      game.camera.forcePosition(0, 0);
    }
    if (game.cursor && game.tilemap) {
      game.cursor.setMapSize(game.tilemap.width, game.tilemap.height);
      game.cursor.setPos(0, 0);
    }

    // Clear highlights
    if (game.highlight) {
      game.highlight.clear();
    }

    // Restore music
    if (levelData.music?.player_phase && game.audioManager) {
      try {
        await game.audioManager.playMusic(levelData.music.player_phase);
      } catch {
        // Music load failure is non-fatal
      }
    }
  } catch (err) {
    console.error('restoreLevel failed:', err);
    throw err;
  }
}

// ============================================================================
// Load Functions
// ============================================================================

/**
 * Load a saved game from a numbered slot.
 *
 * @param game  The GameState singleton.
 * @param slot  The save slot index.
 * @returns     True if the load succeeded, false if no save was found.
 */
export async function loadGame(game: any, slot: number): Promise<boolean> {
  lastLoadError = null;
  try {
    const gameNid = game.db?.getConstant?.('game_nid', 'default') ?? 'default';
    const saveKey = `${gameNid}-${slot}`;
    const saveDict: SaveDict | undefined = await idbGet(saveKey);

    if (!saveDict) {
      console.warn(`loadGame: no save found in slot ${slot}`);
      return false;
    }

    const metadata: SaveMetadata | undefined = await idbGet(`${saveKey}.meta`);
    validateSaveVersion(metadata?.version);
    await restoreGameState(game, saveDict);
    console.log(`Game loaded from slot ${slot}`);
    return true;
  } catch (err) {
    lastLoadError = err instanceof Error ? err.message : String(err);
    console.error(`Failed to load game from slot ${slot}:`, err);
    return false;
  }
}

export async function loadRestart(game: any, slot: number): Promise<boolean> {
  lastLoadError = null;
  try {
    const gameNid = game.db?.getConstant?.('game_nid', 'default') ?? 'default';
    const saveDict: SaveDict | undefined = await idbGet(`${gameNid}-restart-${slot}`);
    if (!saveDict) return false;
    const metadata: SaveMetadata | undefined = await idbGet(`${gameNid}-restart-${slot}.meta`);
    validateSaveVersion(metadata?.version);
    await restoreGameState(game, saveDict);
    return true;
  } catch (err) {
    lastLoadError = err instanceof Error ? err.message : String(err);
    console.error(`Failed to load restart save ${slot}:`, err);
    return false;
  }
}

/**
 * Load a suspend (quicksave). The suspend is deleted after successful load.
 */
export async function loadSuspend(game: any): Promise<boolean> {
  lastLoadError = null;
  try {
    const gameNid = game.db?.getConstant?.('game_nid', 'default') ?? 'default';
    const saveKey = `${gameNid}-suspend`;
    const saveDict: SaveDict | undefined = await idbGet(saveKey);

    if (!saveDict) {
      console.warn('loadSuspend: no suspend save found');
      return false;
    }

    const metadata: SaveMetadata | undefined = await idbGet(`${saveKey}.meta`);
    validateSaveVersion(metadata?.version);
    await restoreGameState(game, saveDict);

    // Delete suspend after successful load
    await idbDelete(saveKey);
    await idbDelete(`${saveKey}.meta`);

    console.log('Suspend loaded and cleared');
    return true;
  } catch (err) {
    lastLoadError = err instanceof Error ? err.message : String(err);
    console.error('Failed to load suspend:', err);
    return false;
  }
}

// ============================================================================
// Slot Management
// ============================================================================

/**
 * Load metadata for all save slots to display in the save/load menu.
 *
 * @param gameNid   The game project NID.
 * @param numSlots  Number of save slots to check.
 * @returns         Array of SaveSlot objects (empty slots have name '--NO DATA--').
 */
export async function loadSaveSlots(
  gameNid: string,
  numSlots: number,
): Promise<SaveSlot[]> {
  const slots: SaveSlot[] = [];

  for (let i = 0; i < numSlots; i++) {
    try {
      const metaKey = `${gameNid}-${i}.meta`;
      const meta: SaveMetadata | undefined = await idbGet(metaKey);

      if (meta) {
        slots.push({
          idx: i,
          name: meta.levelTitle,
          playtime: meta.playtime,
          realtime: meta.realtime,
          kind: meta.kind,
          mode: meta.mode,
          levelNid: meta.levelNid,
          displayName: meta.displayName,
        });
      } else {
        slots.push({
          idx: i,
          name: '--NO DATA--',
          playtime: 0,
          realtime: 0,
          kind: '',
          mode: null,
          levelNid: null,
          displayName: null,
        });
      }
    } catch (err) {
      console.warn(`Failed to load save slot ${i} metadata:`, err);
      slots.push({
        idx: i,
        name: '--NO DATA--',
        playtime: 0,
        realtime: 0,
        kind: '',
        mode: null,
        levelNid: null,
        displayName: null,
      });
    }
  }

  return slots;
}

/**
 * Delete a save from a specific slot.
 */
export async function deleteSave(
  gameNid: string,
  slot: number,
): Promise<void> {
  try {
    await idbDelete(`${gameNid}-${slot}`);
    await idbDelete(`${gameNid}-${slot}.meta`);
    console.log(`Save slot ${slot} deleted`);
    await idbDelete(`${gameNid}-restart-${slot}`);
    await idbDelete(`${gameNid}-restart-${slot}.meta`);
  } catch (err) {
    console.error(`Failed to delete save slot ${slot}:`, err);
  }
}

/**
 * Check whether a suspend save exists for the given game.
 */
export async function hasSuspend(gameNid: string): Promise<boolean> {
  try {
    const meta = await idbGet(`${gameNid}-suspend.meta`);
    return !!meta;
  } catch {
    return false;
  }
}

/**
 * Delete the suspend save.
 */
export async function deleteSuspend(gameNid: string): Promise<void> {
  try {
    await idbDelete(`${gameNid}-suspend`);
    await idbDelete(`${gameNid}-suspend.meta`);
  } catch (err) {
    console.warn('Failed to delete suspend:', err);
  }
}

// ============================================================================
// Utility: List all save keys (for debugging / cleanup)
// ============================================================================

/**
 * List all save keys in the store. Useful for debugging.
 */
export async function listAllSaves(): Promise<string[]> {
  return idbKeys();
}

/**
 * Format playtime in milliseconds to a human-readable string.
 * e.g., 3661000 -> "1:01:01"
 */
export function formatPlaytime(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const pad = (n: number) => n.toString().padStart(2, '0');

  if (hours > 0) {
    return `${hours}:${pad(minutes)}:${pad(seconds)}`;
  }
  return `${minutes}:${pad(seconds)}`;
}
