// ============================================================
// Lex Talionis Web — Records, Persistent Records & Achievements
// Port of: app/engine/records.py, app/engine/persistent_records.py,
//          app/engine/achievements.py
// ============================================================

import type { NID } from '../data/types';

// ------------------------------------------------------------------
// Record Interfaces (data objects)
// ------------------------------------------------------------------

export interface RecordBase {
  turn: number;
  levelNid: string | null;
}

export interface KillRecord extends RecordBase {
  type: 'KillRecord';
  killer: string;
  killee: string;
}

export interface DamageRecord extends RecordBase {
  type: 'DamageRecord';
  dealer: string;
  receiver: string;
  itemNid: string;
  overDamage: number;
  damage: number;
  kind: string; // 'hit' | 'crit' | 'miss'
}

export interface ItemRecord extends RecordBase {
  type: 'ItemRecord';
  user: string;
  itemNid: string;
}

export interface StealRecord extends RecordBase {
  type: 'StealRecord';
  stealer: string;
  stealee: string;
  itemNid: string;
}

export interface CombatRecord extends RecordBase {
  type: 'CombatRecord';
  attacker: string;
  defender: string;
  result: string; // 'hit' | 'miss' | 'crit'
}

export interface LevelRecord extends RecordBase {
  type: 'LevelRecord';
  unitNid: string;
  num: number;
  klass: string;
}

export interface MoneyRecord extends RecordBase {
  type: 'MoneyRecord';
  partyNid: string;
  num: number;
}

export interface TurnRecord extends RecordBase {
  type: 'TurnRecord';
}

type AnyRecord =
  | KillRecord
  | DamageRecord
  | ItemRecord
  | StealRecord
  | CombatRecord
  | LevelRecord
  | MoneyRecord
  | TurnRecord;

// ------------------------------------------------------------------
// Record Factory Helpers
// ------------------------------------------------------------------

function makeKillRecord(
  turn: number,
  levelNid: string | null,
  killer: string,
  killee: string
): KillRecord {
  return { type: 'KillRecord', turn, levelNid, killer, killee };
}

function makeDamageRecord(
  turn: number,
  levelNid: string | null,
  dealer: string,
  receiver: string,
  itemNid: string,
  overDamage: number,
  damage: number,
  kind: string
): DamageRecord {
  return { type: 'DamageRecord', turn, levelNid, dealer, receiver, itemNid, overDamage, damage, kind };
}

function makeItemRecord(
  turn: number,
  levelNid: string | null,
  user: string,
  itemNid: string
): ItemRecord {
  return { type: 'ItemRecord', turn, levelNid, user, itemNid };
}

function makeStealRecord(
  turn: number,
  levelNid: string | null,
  stealer: string,
  stealee: string,
  itemNid: string
): StealRecord {
  return { type: 'StealRecord', turn, levelNid, stealer, stealee, itemNid };
}

function makeCombatRecord(
  turn: number,
  levelNid: string | null,
  attacker: string,
  defender: string,
  result: string
): CombatRecord {
  return { type: 'CombatRecord', turn, levelNid, attacker, defender, result };
}

function makeLevelRecord(
  turn: number,
  levelNid: string | null,
  unitNid: string,
  num: number,
  klass: string
): LevelRecord {
  return { type: 'LevelRecord', turn, levelNid, unitNid, num, klass };
}

function makeMoneyRecord(
  turn: number,
  levelNid: string | null,
  partyNid: string,
  num: number
): MoneyRecord {
  return { type: 'MoneyRecord', turn, levelNid, partyNid, num };
}

function makeTurnRecord(turn: number, levelNid: string | null): TurnRecord {
  return { type: 'TurnRecord', turn, levelNid };
}

// ------------------------------------------------------------------
// Recordkeeper — per-save in-memory game statistics
// Mirrors app/engine/records.py Recordkeeper
// ------------------------------------------------------------------

export class Recordkeeper {
  kills: KillRecord[];
  damage: DamageRecord[];
  healing: DamageRecord[];
  death: KillRecord[];
  itemUse: ItemRecord[];
  steal: StealRecord[];
  combatResults: CombatRecord[];
  turnsTaken: TurnRecord[];
  levels: LevelRecord[];
  exp: LevelRecord[];
  money: MoneyRecord[];

  constructor() {
    this.kills = [];
    this.damage = [];
    this.healing = [];
    this.death = [];
    this.itemUse = [];
    this.steal = [];
    this.combatResults = [];
    this.turnsTaken = [];
    this.levels = [];
    this.exp = [];
    this.money = [];
  }

  /**
   * Append a record of the given type.
   * `turn` and `levelNid` are provided by the caller (from game state).
   */
  append(
    recordType: string,
    turn: number,
    levelNid: string | null,
    ...args: unknown[]
  ): void {
    switch (recordType) {
      case 'kill':
        this.kills.push(
          makeKillRecord(turn, levelNid, args[0] as string, args[1] as string)
        );
        break;
      case 'damage':
        this.damage.push(
          makeDamageRecord(
            turn,
            levelNid,
            args[0] as string,
            args[1] as string,
            args[2] as string,
            args[3] as number,
            args[4] as number,
            args[5] as string
          )
        );
        break;
      case 'heal':
        this.healing.push(
          makeDamageRecord(
            turn,
            levelNid,
            args[0] as string,
            args[1] as string,
            args[2] as string,
            args[3] as number,
            args[4] as number,
            args[5] as string
          )
        );
        break;
      case 'death':
        this.death.push(
          makeKillRecord(turn, levelNid, args[0] as string, args[1] as string)
        );
        break;
      case 'item_use':
        this.itemUse.push(
          makeItemRecord(turn, levelNid, args[0] as string, args[1] as string)
        );
        break;
      case 'steal':
        this.steal.push(
          makeStealRecord(
            turn,
            levelNid,
            args[0] as string,
            args[1] as string,
            args[2] as string
          )
        );
        break;
      case 'hit':
        this.combatResults.push(
          makeCombatRecord(
            turn,
            levelNid,
            args[0] as string,
            args[1] as string,
            'hit'
          )
        );
        break;
      case 'miss':
        this.combatResults.push(
          makeCombatRecord(
            turn,
            levelNid,
            args[0] as string,
            args[1] as string,
            'miss'
          )
        );
        break;
      case 'crit':
        this.combatResults.push(
          makeCombatRecord(
            turn,
            levelNid,
            args[0] as string,
            args[1] as string,
            'crit'
          )
        );
        break;
      case 'turn':
        this.turnsTaken.push(makeTurnRecord(turn, levelNid));
        break;
      case 'level_gain':
        this.levels.push(
          makeLevelRecord(
            turn,
            levelNid,
            args[0] as string,
            args[1] as number,
            args[2] as string
          )
        );
        break;
      case 'exp_gain':
        this.exp.push(
          makeLevelRecord(
            turn,
            levelNid,
            args[0] as string,
            args[1] as number,
            args[2] as string
          )
        );
        break;
      case 'money':
        this.money.push(
          makeMoneyRecord(
            turn,
            levelNid,
            args[0] as string,
            args[1] as number
          )
        );
        break;
    }
  }

  /**
   * Pop the most recent record of the given type (for turnwheel undo).
   */
  pop(recordType: string): AnyRecord | undefined {
    switch (recordType) {
      case 'kill':
        return this.kills.pop();
      case 'damage':
        return this.damage.pop();
      case 'heal':
        return this.healing.pop();
      case 'death':
        return this.death.pop();
      case 'item_use':
        return this.itemUse.pop();
      case 'steal':
        return this.steal.pop();
      case 'hit':
      case 'miss':
      case 'crit':
        return this.combatResults.pop();
      case 'turn':
        return this.turnsTaken.pop();
      case 'level_gain':
        return this.levels.pop();
      case 'exp_gain':
        return this.exp.pop();
      case 'money':
        return this.money.pop();
      default:
        return undefined;
    }
  }

  // ----------------------------------------------------------------
  // Interrogation functions
  // ----------------------------------------------------------------

  /**
   * Returns ordered list of level NIDs played (based on turn records).
   * Excludes the current (last) level by convention in the original engine.
   */
  getLevels(): string[] {
    const levels: string[] = [];
    for (const record of this.turnsTaken) {
      if (record.levelNid !== null && !levels.includes(record.levelNid)) {
        levels.push(record.levelNid);
      }
    }
    return levels;
  }

  /**
   * For each level in list, return the max turn number recorded in that level.
   */
  getTurncounts(levels: string[]): number[] {
    const turncounts: number[] = [];
    for (const level of levels) {
      let maxTurncount = 0;
      for (const record of this.turnsTaken) {
        if (record.levelNid === level) {
          maxTurncount = Math.max(record.turn, maxTurncount);
        }
      }
      turncounts.push(maxTurncount);
    }
    return turncounts;
  }

  /**
   * Returns number of kills by unit, optionally filtered to a specific level.
   */
  getKills(unitNid: string, levelNid?: string): number {
    let count = 0;
    for (const record of this.kills) {
      if (record.killer === unitNid) {
        if (levelNid === undefined || record.levelNid === levelNid) {
          count++;
        }
      }
    }
    return count;
  }

  /**
   * Returns total damage dealt by unit, optionally filtered to a specific level.
   */
  getDamage(unitNid: string, levelNid?: string): number {
    let total = 0;
    for (const record of this.damage) {
      if (record.dealer === unitNid) {
        if (levelNid === undefined || record.levelNid === levelNid) {
          total += record.damage;
        }
      }
    }
    return total;
  }

  /**
   * Returns total healing done by unit (excluding self-healing),
   * optionally filtered to a specific level.
   */
  getHeal(unitNid: string, levelNid?: string): number {
    let total = 0;
    for (const record of this.healing) {
      if (record.dealer === unitNid && record.receiver !== unitNid) {
        if (levelNid === undefined || record.levelNid === levelNid) {
          total += record.damage;
        }
      }
    }
    return total;
  }

  /**
   * Composite score: kills * 20 + damage + healing.
   */
  determineScore(unitNid: string, levelNid?: string): number {
    const killScore = this.getKills(unitNid, levelNid);
    const damageScore = this.getDamage(unitNid, levelNid);
    const healScore = this.getHeal(unitNid, levelNid);
    return killScore * 20 + damageScore + healScore;
  }

  /**
   * Returns the unit NID with the highest score among the provided unit list.
   * If no unitNids are provided, searches across all kill/damage/heal records.
   */
  getMvp(levelNid?: string, unitNids?: string[]): string | null {
    // If no explicit unit list, gather all unique unit NIDs from records
    let candidates: string[];
    if (unitNids && unitNids.length > 0) {
      candidates = unitNids;
    } else {
      const nidSet = new Set<string>();
      for (const r of this.kills) nidSet.add(r.killer);
      for (const r of this.damage) nidSet.add(r.dealer);
      for (const r of this.healing) nidSet.add(r.dealer);
      candidates = Array.from(nidSet);
    }

    let bestScore = -1;
    let mvp: string | null = null;
    for (const nid of candidates) {
      const score = this.determineScore(nid, levelNid);
      if (score > bestScore) {
        bestScore = score;
        mvp = nid;
      }
    }
    return mvp;
  }

  /**
   * Returns the NID of the most recent killer of the given unit.
   */
  getKiller(unitNid: string, levelNid?: string): string | null {
    for (let i = this.kills.length - 1; i >= 0; i--) {
      const record = this.kills[i];
      if (record.killee === unitNid) {
        if (levelNid === undefined || record.levelNid === levelNid) {
          return record.killer;
        }
      }
    }
    return null;
  }

  // ----------------------------------------------------------------
  // Serialization
  // ----------------------------------------------------------------

  save(): RecordkeeperSaveData {
    return {
      kills: this.kills.slice(),
      damage: this.damage.slice(),
      healing: this.healing.slice(),
      death: this.death.slice(),
      itemUse: this.itemUse.slice(),
      steal: this.steal.slice(),
      combatResults: this.combatResults.slice(),
      turnsTaken: this.turnsTaken.slice(),
      levels: this.levels.slice(),
      exp: this.exp.slice(),
      money: this.money.slice(),
    };
  }

  static restore(data: RecordkeeperSaveData): Recordkeeper {
    const rk = new Recordkeeper();
    rk.kills = data.kills ?? [];
    rk.damage = data.damage ?? [];
    rk.healing = data.healing ?? [];
    rk.death = data.death ?? [];
    rk.itemUse = data.itemUse ?? [];
    rk.steal = data.steal ?? [];
    rk.combatResults = data.combatResults ?? [];
    rk.turnsTaken = data.turnsTaken ?? [];
    rk.levels = data.levels ?? [];
    rk.exp = data.exp ?? [];
    rk.money = data.money ?? [];
    return rk;
  }

  clear(): void {
    this.kills = [];
    this.damage = [];
    this.healing = [];
    this.death = [];
    this.itemUse = [];
    this.steal = [];
    this.combatResults = [];
    this.turnsTaken = [];
    this.levels = [];
    this.exp = [];
    this.money = [];
  }
}

export interface RecordkeeperSaveData {
  kills: KillRecord[];
  damage: DamageRecord[];
  healing: DamageRecord[];
  death: KillRecord[];
  itemUse: ItemRecord[];
  steal: StealRecord[];
  combatResults: CombatRecord[];
  turnsTaken: TurnRecord[];
  levels: LevelRecord[];
  exp: LevelRecord[];
  money: MoneyRecord[];
}

// ------------------------------------------------------------------
// PersistentRecordManager — cross-save key-value records
// Mirrors app/engine/persistent_records.py
// Backed by localStorage
// ------------------------------------------------------------------

interface PersistentRecordEntry {
  nid: NID;
  value: unknown;
}

export class PersistentRecordManager {
  private entries: Map<NID, PersistentRecordEntry>;
  private storageKey: string;

  constructor(gameNid: string) {
    this.entries = new Map();
    this.storageKey = `lt-persistent-records-${gameNid}`;
  }

  // ---- Core CRUD ----

  get(nid: NID): unknown {
    const entry = this.entries.get(nid);
    return entry ? entry.value : null;
  }

  set(nid: NID, value: unknown): void {
    this.entries.set(nid, { nid, value });
    this.persist();
  }

  has(nid: NID): boolean {
    return this.entries.has(nid);
  }

  delete(nid: NID): void {
    if (this.entries.has(nid)) {
      this.entries.delete(nid);
      this.persist();
    }
  }

  /**
   * Create only if the NID does not already exist.
   */
  create(nid: NID, value: unknown = null): void {
    if (this.entries.has(nid)) {
      return;
    }
    this.entries.set(nid, { nid, value });
    this.persist();
  }

  /**
   * Update only if the NID already exists.
   */
  update(nid: NID, value: unknown): void {
    if (!this.entries.has(nid)) {
      return;
    }
    this.entries.set(nid, { nid, value });
    this.persist();
  }

  /**
   * Upsert — update if exists, create if not.
   */
  replace(nid: NID, value: unknown): void {
    this.entries.set(nid, { nid, value });
    this.persist();
  }

  // ---- Difficulty unlocks ----

  unlockDifficulty(nid: NID): void {
    if (this.entries.has(nid)) {
      return;
    }
    this.entries.set(nid, { nid, value: true });
    this.persist();
  }

  checkDifficultyUnlocked(nid: NID): boolean {
    const entry = this.entries.get(nid);
    return entry ? !!entry.value : false;
  }

  // ---- Song unlocks ----

  unlockSong(nid: NID): void {
    if (this.entries.has(nid)) {
      return;
    }
    this.entries.set(nid, { nid, value: true });
    this.persist();
  }

  checkSongUnlocked(nid: NID): boolean {
    const entry = this.entries.get(nid);
    return entry ? !!entry.value : false;
  }

  // ---- Serialization ----

  save(): PersistentRecordEntry[] {
    return Array.from(this.entries.values());
  }

  restore(data: PersistentRecordEntry[]): void {
    this.entries.clear();
    if (Array.isArray(data)) {
      for (const entry of data) {
        this.entries.set(entry.nid, entry);
      }
    }
  }

  clear(): void {
    this.entries.clear();
    this.persist();
  }

  /**
   * Immediately writes current state to localStorage.
   */
  persist(): void {
    try {
      const json = JSON.stringify(this.save());
      localStorage.setItem(this.storageKey, json);
    } catch {
      // localStorage may be unavailable (SSR, quota exceeded, etc.)
    }
  }

  /**
   * Load from localStorage and return a new PersistentRecordManager instance.
   */
  static load(gameNid: string): PersistentRecordManager {
    const manager = new PersistentRecordManager(gameNid);
    try {
      const raw = localStorage.getItem(`lt-persistent-records-${gameNid}`);
      if (raw) {
        const data = JSON.parse(raw) as PersistentRecordEntry[];
        manager.restore(data);
      }
    } catch {
      // localStorage may be unavailable or data corrupted
    }
    return manager;
  }
}

// ------------------------------------------------------------------
// AchievementManager — cross-save achievements
// Mirrors app/engine/achievements.py
// Backed by localStorage
// ------------------------------------------------------------------

export interface AchievementEntry {
  nid: NID;
  name: string;
  desc: string;
  complete: boolean;
  hidden: boolean;
}

export class AchievementManager {
  private achievements: Map<NID, AchievementEntry>;
  private storageKey: string;

  constructor(gameNid: string) {
    this.achievements = new Map();
    this.storageKey = `lt-achievements-${gameNid}`;
  }

  /**
   * Add a new achievement. If one with the same NID already exists, this is a no-op.
   */
  add(
    nid: NID,
    name: string,
    desc: string,
    complete: boolean = false,
    hidden: boolean = false
  ): void {
    if (this.achievements.has(nid)) {
      return;
    }
    this.achievements.set(nid, { nid, name, desc, complete, hidden });
    this.persist();
  }

  /**
   * Update an existing achievement's metadata. Does not change completion status.
   */
  updateAchievement(nid: NID, name: string, desc: string, hidden: boolean): void {
    const a = this.achievements.get(nid);
    if (!a) {
      return;
    }
    a.name = name;
    a.desc = desc;
    a.hidden = hidden;
    this.persist();
  }

  /**
   * Remove an achievement by NID.
   */
  remove(nid: NID): void {
    if (this.achievements.has(nid)) {
      this.achievements.delete(nid);
      this.persist();
    }
  }

  /**
   * Mark an achievement as complete (or incomplete).
   * Returns the new completion state, or false if achievement doesn't exist.
   */
  complete(nid: NID, value: boolean = true): boolean {
    const a = this.achievements.get(nid);
    if (!a) {
      return false;
    }
    a.complete = value;
    this.persist();
    return value;
  }

  /**
   * Returns true if the achievement exists and is complete.
   */
  checkAchievement(nid: NID): boolean {
    const a = this.achievements.get(nid);
    return a ? a.complete : false;
  }

  /**
   * Returns true if the achievement is marked hidden AND is not yet complete.
   */
  getHidden(nid: NID): boolean {
    const a = this.achievements.get(nid);
    if (!a) return false;
    return a.hidden && !a.complete;
  }

  /**
   * Returns all achievements as an array.
   */
  getAll(): AchievementEntry[] {
    return Array.from(this.achievements.values());
  }

  /**
   * Get a single achievement by NID.
   */
  getAchievement(nid: NID): AchievementEntry | null {
    return this.achievements.get(nid) ?? null;
  }

  // ---- Serialization ----

  save(): AchievementEntry[] {
    return Array.from(this.achievements.values());
  }

  restore(data: AchievementEntry[]): void {
    this.achievements.clear();
    if (Array.isArray(data)) {
      for (const entry of data) {
        this.achievements.set(entry.nid, {
          nid: entry.nid,
          name: entry.name,
          desc: entry.desc,
          complete: !!entry.complete,
          hidden: !!entry.hidden,
        });
      }
    }
  }

  clear(): void {
    this.achievements.clear();
    this.persist();
  }

  /**
   * Immediately writes current state to localStorage.
   */
  persist(): void {
    try {
      const json = JSON.stringify(this.save());
      localStorage.setItem(this.storageKey, json);
    } catch {
      // localStorage may be unavailable
    }
  }

  /**
   * Load from localStorage and return a new AchievementManager instance.
   */
  static load(gameNid: string): AchievementManager {
    const manager = new AchievementManager(gameNid);
    try {
      const raw = localStorage.getItem(`lt-achievements-${gameNid}`);
      if (raw) {
        const data = JSON.parse(raw) as AchievementEntry[];
        manager.restore(data);
      }
    } catch {
      // localStorage may be unavailable or data corrupted
    }
    return manager;
  }
}

// ------------------------------------------------------------------
// Module-level singletons
// ------------------------------------------------------------------

export let RECORDS: PersistentRecordManager;
export let ACHIEVEMENTS: AchievementManager;

/**
 * Initialize the persistent systems (persistent records + achievements)
 * from localStorage. Call once at engine startup after the game NID is known.
 */
export function initPersistentSystems(gameNid: string): void {
  RECORDS = PersistentRecordManager.load(gameNid);
  ACHIEVEMENTS = AchievementManager.load(gameNid);
}

/**
 * Reset the persistent systems — clears existing data and re-loads
 * from localStorage with the given game NID. Useful when switching
 * game projects.
 */
export function resetPersistentSystems(gameNid: string): void {
  RECORDS = PersistentRecordManager.load(gameNid);
  ACHIEVEMENTS = AchievementManager.load(gameNid);
}
