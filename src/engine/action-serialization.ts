/**
 * action-serialization.ts — Python `Action.save`/`Action.restore` and
 * `ActionLog.save`/`ActionLog.restore` (lt-maker app/engine/action.py,
 * turnwheel.py), so a save or suspend keeps the turnwheel history.
 *
 * Like Python, an action is saved as its class name plus every attribute,
 * with game objects replaced by references: units by nid, items and skills
 * by uid, regions by nid, parties by nid, support pairs by their unit pair,
 * nested actions recursively. Engine singletons an action holds (the game,
 * board, database, tilemap, registries) are saved as named references and
 * resolve to the live objects after the load. Python keeps every item and
 * skill in a registry even after it leaves play; the web registers only
 * owned items and skills, so an item or skill no longer in play (a used-up
 * item, a removed status) is saved by value instead. Every other object is
 * saved by value with its sharing preserved, so cyclic and shared
 * structures come back as they were. The payload is plain JSON, so it
 * survives both IndexedDB and the cloud store.
 *
 * An action that cannot be saved (one holding a closure or an engine object
 * with no reference) cuts the saved history there: only the actions after it
 * are kept, so the turnwheel can still rewind to that point. Python has no
 * such fallback; it simply cannot save.
 */

import * as ActionModule from './action';
import { Action, type ActionLog } from './action';
import { CombatResultAction } from '../combat/combat-result-action';
import { CombatLifecycleRecord } from '../combat/combat-skill-lifecycle';
import { UnitObject } from '../objects/unit';
import { ItemObject } from '../objects/item';
import { SkillObject } from '../objects/skill';
import { PartyObject } from './party';

/** Version of the saved action-log payload. */
export const ACTION_LOG_VERSION = 1;

export interface SavedActionLog {
  version: number;
  /** Shared object table: every by-value object, referenced by index. */
  objects: unknown[];
  /** One encoded value per action. */
  actions: unknown[];
  actionIndex: number;
  firstFreeAction: number;
  record: number;
  /** Actions dropped from the front because they could not be saved. */
  dropped: number;
}

type Encoded = unknown;

class Unserializable extends Error {}

// ---------------------------------------------------------------------------
// Class registry
// ---------------------------------------------------------------------------

/** Classes that may be saved by value, keyed by a stable name (export name). */
const CLASS_BY_NAME = new Map<string, Function>();
const NAME_BY_CLASS = new Map<Function, string>();

function registerClass(name: string, ctor: Function): void {
  if (NAME_BY_CLASS.has(ctor)) return;
  CLASS_BY_NAME.set(name, ctor);
  NAME_BY_CLASS.set(ctor, name);
}

for (const [name, value] of Object.entries(ActionModule)) {
  if (typeof value === 'function' && value.prototype instanceof Action) registerClass(name, value);
}
registerClass('ActionLog', ActionModule.ActionLog);
registerClass('CombatResultAction', CombatResultAction);
registerClass('CombatLifecycleRecord', CombatLifecycleRecord);
registerClass('ItemObject', ItemObject);
registerClass('SkillObject', SkillObject);

/**
 * Fields an action needs only for its first do(); after that it replays
 * from captured state, so they are saved as null (Python actions keep no
 * closures, so there is nothing to mirror).
 */
const TRANSIENT_FIELDS: Record<string, readonly string[]> = {
  UpdatePersistentStoreAction: ['mutate', 'mutationResult'],
  CombatResultAction: ['resolve', 'result'],
};

// ---------------------------------------------------------------------------
// Engine references
// ---------------------------------------------------------------------------

const ENGINE_REFS = [
  'board', 'db', 'tilemap', 'bgTilemap', 'items', 'units', 'parties', 'initiative',
  'eventManager', 'actionLog', 'supports', 'phase', 'camera', 'cursor', 'pathSystem',
  'movementSystem', 'aiController', 'targetSystem', 'roamInfo', 'memory', 'gameVars',
  'levelVars', 'activeAiGroups', 'teamPaletteOverrides', 'currentLevel', 'records',
  'queryEngine', 'resources', 'audioManager', 'state', 'overworldController',
] as const;

function engineRefName(game: any, value: object): string | null {
  if (value === game) return 'game';
  for (const name of ENGINE_REFS) {
    if (game?.[name] === value) return name;
  }
  return null;
}

function resolveEngineRef(game: any, name: string): unknown {
  return name === 'game' ? game : game?.[name];
}

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

interface EncodeContext {
  game: any;
  objects: unknown[];
  ids: Map<object, number>;
  liveItems: Set<ItemObject>;
  liveSkills: Set<SkillObject>;
  liveRegions: Set<object>;
}

function makeEncodeContext(game: any, live?: EncodeContext): EncodeContext {
  if (live) {
    return { ...live, objects: [], ids: new Map() };
  }
  const liveItems = new Set<ItemObject>(game?.items?.values?.() ?? []);
  const liveSkills = new Set<SkillObject>();
  for (const unit of game?.units?.values?.() ?? []) {
    for (const skill of unit.skills ?? []) liveSkills.add(skill);
  }
  return {
    game,
    objects: [],
    ids: new Map(),
    liveItems,
    liveSkills,
    liveRegions: new Set<object>(game?.currentLevel?.regions ?? []),
  };
}

function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isSupportPair(game: any, value: any): boolean {
  if (typeof value?.unit1Nid !== 'string' || typeof value?.unit2Nid !== 'string') return false;
  return game?.supports?.getPair?.(value.unit1Nid, value.unit2Nid) === value;
}

function encodeFields(ctx: EncodeContext, source: object, className: string | null): Record<string, Encoded> {
  const transient = className ? TRANSIENT_FIELDS[className] ?? [] : [];
  const fields: Record<string, Encoded> = {};
  for (const [key, value] of Object.entries(source)) {
    fields[key] = transient.includes(key) ? null : encode(ctx, value, `${className ?? 'object'}.${key}`);
  }
  return fields;
}

/** Store a by-value object in the shared table, preserving sharing and cycles. */
function tableEntry(ctx: EncodeContext, value: object, build: () => unknown): Encoded {
  const existing = ctx.ids.get(value);
  if (existing !== undefined) return ['oref', existing];
  const id = ctx.objects.length;
  ctx.ids.set(value, id);
  ctx.objects.push(null);
  ctx.objects[id] = build();
  return ['oref', id];
}

function encode(ctx: EncodeContext, value: unknown, path: string): Encoded {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (value === undefined) return ['undef'];
  if (typeof value === 'number') return Number.isFinite(value) ? value : ['num', String(value)];
  if (typeof value === 'bigint' || typeof value === 'symbol') throw new Unserializable(`${path}: ${typeof value}`);
  if (typeof value === 'function') throw new Unserializable(`${path}: function`);
  const obj = value as object;

  const ref = engineRefName(ctx.game, obj);
  if (ref) return ['ref', ref];
  if (obj instanceof UnitObject) {
    if (ctx.game?.units?.get?.(obj.nid) !== obj) throw new Unserializable(`${path}: unit ${obj.nid} is not registered`);
    return ['unit', obj.nid];
  }
  if (obj instanceof ItemObject && ctx.liveItems.has(obj)) return ['item', obj.uid];
  if (obj instanceof SkillObject && ctx.liveSkills.has(obj)) return ['skill', obj.uid];
  if (obj instanceof PartyObject) return ['party', obj.nid];
  if (ctx.liveRegions.has(obj)) return ['region', (obj as any).nid];
  if (isSupportPair(ctx.game, obj)) return ['support', (obj as any).unit1Nid, (obj as any).unit2Nid];

  if (Array.isArray(obj)) {
    return tableEntry(ctx, obj, () => ['list', obj.map((entry, i) => encode(ctx, entry, `${path}[${i}]`))]);
  }
  if (obj instanceof Map) {
    return tableEntry(ctx, obj, () => ['map', [...obj.entries()].map(([k, v]) => [
      encode(ctx, k, `${path}.key`), encode(ctx, v, `${path}.value`),
    ])]);
  }
  if (obj instanceof Set) {
    return tableEntry(ctx, obj, () => ['set', [...obj].map((entry) => encode(ctx, entry, `${path}[]`))]);
  }
  if (isPlainObject(obj)) {
    return tableEntry(ctx, obj, () => ['dict', encodeFields(ctx, obj, null)]);
  }
  const className = NAME_BY_CLASS.get(obj.constructor);
  if (!className) throw new Unserializable(`${path}: ${obj.constructor?.name ?? 'object'} instance`);
  return tableEntry(ctx, obj, () => ['inst', className, encodeFields(ctx, obj, className)]);
}

/** Python ActionLog.save. */
export function saveActionLog(game: any, log: ActionLog): SavedActionLog {
  const actions = log.getActions();
  const live = makeEncodeContext(game);
  // First pass: find the last action that cannot be saved on its own.
  let lastBad = -1;
  for (let i = 0; i < actions.length; i++) {
    try {
      encode(makeEncodeContext(game, live), actions[i], NAME_BY_CLASS.get(actions[i].constructor) ?? 'Action');
    } catch (error) {
      if (!(error instanceof Unserializable)) throw error;
      console.warn(`Turnwheel history before action ${i} is not saved: ${error.message}`);
      lastBad = i;
    }
  }
  const kept = actions.slice(lastBad + 1);
  const ctx = makeEncodeContext(game, live);
  const encoded = kept.map((action) => encode(ctx, action, 'action'));
  const dropped = lastBad + 1;
  return {
    version: ACTION_LOG_VERSION,
    objects: ctx.objects,
    actions: encoded,
    actionIndex: log.actionIndex - dropped,
    firstFreeAction: Math.max(-1, log.firstFreeAction - dropped),
    record: log.recordCounter,
    dropped,
  };
}

// ---------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------

interface DecodeContext {
  game: any;
  table: unknown[];
  decoded: Map<number, unknown>;
}

function findSkill(game: any, uid: number): SkillObject | null {
  for (const unit of game?.units?.values?.() ?? []) {
    const skill = unit.skills?.find?.((candidate: SkillObject) => candidate.uid === uid);
    if (skill) return skill;
  }
  return null;
}

function decodeEntry(ctx: DecodeContext, id: number): unknown {
  if (ctx.decoded.has(id)) return ctx.decoded.get(id);
  const entry = ctx.table[id] as [string, ...unknown[]];
  const kind = entry[0];
  if (kind === 'list') {
    const out: unknown[] = [];
    ctx.decoded.set(id, out);
    for (const item of entry[1] as unknown[]) out.push(decode(ctx, item));
    return out;
  }
  if (kind === 'map') {
    const out = new Map();
    ctx.decoded.set(id, out);
    for (const [k, v] of entry[1] as [unknown, unknown][]) out.set(decode(ctx, k), decode(ctx, v));
    return out;
  }
  if (kind === 'set') {
    const out = new Set();
    ctx.decoded.set(id, out);
    for (const item of entry[1] as unknown[]) out.add(decode(ctx, item));
    return out;
  }
  if (kind === 'dict') {
    const out: Record<string, unknown> = {};
    ctx.decoded.set(id, out);
    for (const [k, v] of Object.entries(entry[1] as Record<string, unknown>)) out[k] = decode(ctx, v);
    return out;
  }
  if (kind === 'inst') {
    const ctor = CLASS_BY_NAME.get(entry[1] as string);
    if (!ctor) throw new Error(`Unknown saved class ${String(entry[1])}`);
    const out = Object.create(ctor.prototype);
    ctx.decoded.set(id, out);
    for (const [k, v] of Object.entries(entry[2] as Record<string, unknown>)) out[k] = decode(ctx, v);
    return out;
  }
  throw new Error(`Unknown saved object kind ${String(kind)}`);
}

function decode(ctx: DecodeContext, value: Encoded): unknown {
  if (!Array.isArray(value)) return value;
  const [kind, a, b] = value as [string, unknown, unknown];
  switch (kind) {
    case 'undef': return undefined;
    case 'num': return Number(a);
    case 'oref': return decodeEntry(ctx, a as number);
    case 'ref': return resolveEngineRef(ctx.game, a as string);
    case 'unit': {
      const unit = ctx.game?.units?.get?.(a as string);
      if (!unit) throw new Error(`Saved action refers to missing unit ${String(a)}`);
      return unit;
    }
    case 'item': {
      const item = ctx.game?.getItem?.(a as number);
      if (!item) throw new Error(`Saved action refers to missing item ${String(a)}`);
      return item;
    }
    case 'skill': {
      const skill = findSkill(ctx.game, a as number);
      if (!skill) throw new Error(`Saved action refers to missing skill ${String(a)}`);
      return skill;
    }
    case 'party': return ctx.game?.parties?.get?.(a as string) ?? null;
    case 'region': {
      const region = (ctx.game?.currentLevel?.regions ?? []).find((r: any) => r.nid === a);
      if (!region) throw new Error(`Saved action refers to missing region ${String(a)}`);
      return region;
    }
    case 'support': return ctx.game?.supports?.getPair?.(a as string, b as string) ?? null;
    default: throw new Error(`Unknown saved value kind ${String(kind)}`);
  }
}

/**
 * Python ActionLog.restore. Call after every unit, item, skill, region and
 * engine subsystem of the save has been restored. A log that fails to
 * restore leaves the turnwheel empty rather than failing the load.
 */
export function restoreActionLog(game: any, log: ActionLog, saved: SavedActionLog | null | undefined): void {
  if (!saved || saved.version !== ACTION_LOG_VERSION || !Array.isArray(saved.actions)) {
    log.clear();
    return;
  }
  try {
    const ctx: DecodeContext = { game, table: saved.objects ?? [], decoded: new Map() };
    const actions = saved.actions.map((value) => decode(ctx, value));
    if (!actions.every((action) => action instanceof Action)) throw new Error('Saved action log holds a non-action');
    log.restoreState(actions as Action[], saved.actionIndex, saved.firstFreeAction, saved.record ?? 0);
  } catch (error) {
    console.warn('Could not restore the turnwheel history; it starts empty.', error);
    log.clear();
  }
}
