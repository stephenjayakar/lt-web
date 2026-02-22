// ---------------------------------------------------------------------------
// GameQueryEngine — Provides game state query functions for use in equation
// and condition evaluation contexts (event conditions, item/skill equations).
//
// Ported from LT's app/engine/query_engine.py.
// ---------------------------------------------------------------------------

import type { NID, RegionData } from '../data/types';
import type { UnitObject } from '../objects/unit';
import type { ItemObject } from '../objects/item';
import type { SkillObject } from '../objects/skill';

// ---------------------------------------------------------------------------
// Lazy game reference (avoids circular imports)
// ---------------------------------------------------------------------------

let _getGame: (() => any) | null = null;

/**
 * Set the lazy game reference getter. Must be called once at startup
 * (e.g. from main.ts) before any query functions are invoked.
 */
export function setQueryEngineGameRef(getter: () => any): void {
  _getGame = getter;
}

/** Internal helper — returns the live game state or throws. */
function getGame(): any {
  if (!_getGame) {
    throw new Error('QueryEngine: game reference not set. Call setQueryEngineGameRef() first.');
  }
  return _getGame();
}

// ---------------------------------------------------------------------------
// Filter options shared by several spatial query methods
// ---------------------------------------------------------------------------

interface UnitFilterOpts {
  nid?: string;
  team?: string;
  tag?: string;
  party?: string;
}

// ---------------------------------------------------------------------------
// GameQueryEngine
// ---------------------------------------------------------------------------

export class GameQueryEngine {
  // ========================================================================
  // Function dictionary (for injection into eval contexts)
  // ========================================================================

  /**
   * Build a dictionary of all public query methods, bound to this instance.
   * Keys use both camelCase and snake_case so that equations written in
   * either Python-style or JS-style naming conventions resolve correctly.
   */
  getFuncDict(): Record<string, Function> {
    const dict: Record<string, Function> = {};

    // Explicit mapping: snake_case alias -> method
    const methods: [string, string, Function][] = [
      ['u',                           'u',                           this.u],
      ['v',                           'v',                           this.v],
      ['getItem',                     'get_item',                    this.getItem],
      ['hasItem',                     'has_item',                    this.hasItem],
      ['getSubitem',                  'get_subitem',                 this.getSubitem],
      ['getSkill',                    'get_skill',                   this.getSkill],
      ['hasSkill',                    'has_skill',                   this.hasSkill],
      ['getKlass',                    'get_klass',                   this.getKlass],
      ['getClass',                    'get_class',                   this.getClass],
      ['getClosestAllies',            'get_closest_allies',          this.getClosestAllies],
      ['getUnitsWithinDistance',       'get_units_within_distance',   this.getUnitsWithinDistance],
      ['getAlliesWithinDistance',       'get_allies_within_distance',  this.getAlliesWithinDistance],
      ['getUnitsInArea',              'get_units_in_area',           this.getUnitsInArea],
      ['getDebuffCount',              'get_debuff_count',            this.getDebuffCount],
      ['getUnitsInRegion',            'get_units_in_region',         this.getUnitsInRegion],
      ['anyUnitInRegion',             'any_unit_in_region',          this.anyUnitInRegion],
      ['isDead',                      'is_dead',                     this.isDead],
      ['checkAlive',                  'check_alive',                 this.checkAlive],
      ['getInternalLevel',            'get_internal_level',          this.getInternalLevel],
      ['getSupportRank',              'get_support_rank',            this.getSupportRank],
      ['getTerrain',                  'get_terrain',                 this.getTerrain],
      ['hasAchievement',              'has_achievement',             this.hasAchievement],
      ['checkShove',                  'check_shove',                 this.checkShove],
      ['getMoney',                    'get_money',                   this.getMoney],
      ['getBexp',                     'get_bexp',                    this.getBexp],
      ['isRoam',                      'is_roam',                     this.isRoam],
      ['getRoamUnit',                 'get_roam_unit',               this.getRoamUnit],
      ['aiGroupActive',               'ai_group_active',             this.aiGroupActive],
      ['getTeamUnits',                'get_team_units',              this.getTeamUnits],
      ['getPlayerUnits',              'get_player_units',            this.getPlayerUnits],
      ['getEnemyUnits',               'get_enemy_units',             this.getEnemyUnits],
      ['getAllUnits',                  'get_all_units',               this.getAllUnits],
      ['getConvoyInventory',          'get_convoy_inventory',        this.getConvoyInventory],
    ];

    for (const [camelName, snakeName, fn] of methods) {
      const bound = fn.bind(this);
      dict[camelName] = bound;
      if (snakeName !== camelName) {
        dict[snakeName] = bound;
      }
    }

    return dict;
  }

  // ========================================================================
  // Unit lookup
  // ========================================================================

  /**
   * Resolve a unit by NID.
   * Returns the live UnitObject or null if not found.
   */
  u(unitNid: string): UnitObject | null {
    const game = getGame();
    return game.getUnit?.(unitNid) ?? game.units?.get(unitNid) ?? null;
  }

  // ========================================================================
  // Variable lookup
  // ========================================================================

  /**
   * Look up a game variable. Checks levelVars first, then gameVars.
   * Returns `fallback` (default undefined) if neither map contains the key.
   */
  v(varname: string, fallback?: any): any {
    const game = getGame();
    if (game.levelVars?.has(varname)) {
      return game.levelVars.get(varname);
    }
    if (game.gameVars?.has(varname)) {
      return game.gameVars.get(varname);
    }
    return fallback;
  }

  // ========================================================================
  // Item queries
  // ========================================================================

  /**
   * Get an item from a unit's inventory by NID (or uid).
   *
   * @param unit     A UnitObject or unit NID string.
   * @param itemNidOrUid  The item NID to search for. If it's a numeric string,
   *                      also tries to look up by key in game.items.
   */
  getItem(unit: any, itemNidOrUid: string): ItemObject | null {
    const resolved = this._resolveUnit(unit);
    if (!resolved) return null;

    // Search the unit's inventory by nid
    for (const item of resolved.items) {
      if (item.nid === itemNidOrUid) return item;
    }

    // If the identifier looks numeric, try the global items map
    if (/^\d+$/.test(itemNidOrUid)) {
      const game = getGame();
      const globalItem = game.items?.get(itemNidOrUid);
      if (globalItem) return globalItem;
    }

    return null;
  }

  /**
   * Check if *any* unit (optionally matching filters) has a specific item.
   *
   * @param itemNid  Item NID to search for.
   * @param opts     Optional filters: nid, team, tag, party.
   */
  hasItem(itemNid: string, opts?: UnitFilterOpts): boolean {
    const game = getGame();
    for (const unit of game.units.values()) {
      if (opts && !this._matchesFilter(unit as UnitObject, opts)) continue;
      for (const item of (unit as UnitObject).items) {
        if (item.nid === itemNid) return true;
      }
    }
    return false;
  }

  // ========================================================================
  // Skill queries
  // ========================================================================

  /**
   * Get a skill from a unit by NID. Searches in reverse order so the most
   * recently added instance is returned first (matches Python behavior).
   */
  getSkill(unit: any, skillNid: string): SkillObject | null {
    const resolved = this._resolveUnit(unit);
    if (!resolved) return null;

    for (let i = resolved.skills.length - 1; i >= 0; i--) {
      if (resolved.skills[i].nid === skillNid) return resolved.skills[i];
    }
    return null;
  }

  /**
   * Check if a unit has a skill with the given NID.
   */
  hasSkill(unit: any, skillNid: string): boolean {
    return this.getSkill(unit, skillNid) !== null;
  }

  // ========================================================================
  // Class lookup
  // ========================================================================

  /**
   * Get the DB class definition for a unit's current class.
   */
  getKlass(unit: any): any {
    const resolved = this._resolveUnit(unit);
    if (!resolved) return null;
    const game = getGame();
    return game.db?.classes?.get(resolved.klass) ?? null;
  }

  /** Alias for getKlass. */
  getClass(unit: any): any {
    return this.getKlass(unit);
  }

  // ========================================================================
  // Spatial queries
  // ========================================================================

  /**
   * Find the closest allied (player-team) units to a position.
   *
   * @param position  A position [x, y] or a unit (uses its position).
   * @param num       Maximum number of results (default 1).
   * @returns         Array of [unit, distance] pairs sorted by ascending distance.
   */
  getClosestAllies(position: any, num: number = 1): [UnitObject, number][] {
    const pos = this._resolvePos(position);
    if (!pos) return [];

    const game = getGame();
    const alliedTeams = game.getAlliedTeams?.() ?? ['player'];

    const pairs: [UnitObject, number][] = [];
    for (const unit of game.units.values()) {
      const u = unit as UnitObject;
      if (!u.position || u.isDead()) continue;
      if (!alliedTeams.includes(u.team)) continue;
      const dist = this._manhattanDist(pos, u.position);
      pairs.push([u, dist]);
    }

    pairs.sort((a, b) => a[1] - b[1]);
    return pairs.slice(0, num);
  }

  /**
   * Get all units within a Manhattan distance of a position, optionally
   * filtered by nid/team/tag/party.
   *
   * @param position  A position [x, y] or a unit.
   * @param dist      Maximum Manhattan distance (default 1).
   * @param opts      Optional unit filters.
   */
  getUnitsWithinDistance(
    position: any,
    dist: number = 1,
    opts?: UnitFilterOpts,
  ): UnitObject[] {
    const pos = this._resolvePos(position);
    if (!pos) return [];

    const game = getGame();
    const result: UnitObject[] = [];

    for (const unit of game.units.values()) {
      const u = unit as UnitObject;
      if (!u.position || u.isDead()) continue;
      if (this._manhattanDist(pos, u.position) > dist) continue;
      if (opts && !this._matchesFilter(u, opts)) continue;
      result.push(u);
    }

    return result;
  }

  /**
   * Get all allied (player-team) units within a Manhattan distance.
   */
  getAlliesWithinDistance(position: any, dist: number = 1): UnitObject[] {
    const pos = this._resolvePos(position);
    if (!pos) return [];

    const game = getGame();
    const alliedTeams = game.getAlliedTeams?.() ?? ['player'];

    const result: UnitObject[] = [];
    for (const unit of game.units.values()) {
      const u = unit as UnitObject;
      if (!u.position || u.isDead()) continue;
      if (!alliedTeams.includes(u.team)) continue;
      if (this._manhattanDist(pos, u.position) > dist) continue;
      result.push(u);
    }

    return result;
  }

  /**
   * Get all units within a rectangular area defined by two corners.
   *
   * @param corner1  Top-left corner [x, y] (inclusive).
   * @param corner2  Bottom-right corner [x, y] (inclusive).
   */
  getUnitsInArea(corner1: [number, number], corner2: [number, number]): UnitObject[] {
    const minX = Math.min(corner1[0], corner2[0]);
    const maxX = Math.max(corner1[0], corner2[0]);
    const minY = Math.min(corner1[1], corner2[1]);
    const maxY = Math.max(corner1[1], corner2[1]);

    const game = getGame();
    const result: UnitObject[] = [];

    for (const unit of game.units.values()) {
      const u = unit as UnitObject;
      if (!u.position || u.isDead()) continue;
      const [ux, uy] = u.position;
      if (ux >= minX && ux <= maxX && uy >= minY && uy <= maxY) {
        result.push(u);
      }
    }

    return result;
  }

  // ========================================================================
  // Status / debuff queries
  // ========================================================================

  /**
   * Count the number of negative status effects (debuffs) on a unit.
   * A debuff is any status effect that has negative stat modifiers,
   * DOT damage, immobilize, or stun.
   */
  getDebuffCount(unit: any): number {
    const resolved = this._resolveUnit(unit);
    if (!resolved) return 0;

    let count = 0;
    for (const effect of resolved.statusEffects) {
      const isNegative =
        effect.dotDamage > 0 ||
        effect.immobilize ||
        effect.stun ||
        Object.values(effect.statMods).some((v: number) => v < 0);
      if (isNegative) count++;
    }
    return count;
  }

  // ========================================================================
  // Region queries
  // ========================================================================

  /**
   * Get all units inside a region, optionally filtered.
   *
   * @param region  A RegionData object or a region NID string.
   * @param opts    Optional unit filters: nid, team, tag.
   */
  getUnitsInRegion(region: any, opts?: { nid?: string; team?: string; tag?: string }): UnitObject[] {
    const regionData = this._resolveRegion(region);
    if (!regionData) return [];

    const [rx, ry] = regionData.position;
    const [rw, rh] = regionData.size;

    const game = getGame();
    const result: UnitObject[] = [];

    for (const unit of game.units.values()) {
      const u = unit as UnitObject;
      if (!u.position || u.isDead()) continue;
      const [ux, uy] = u.position;
      if (ux >= rx && ux < rx + rw && uy >= ry && uy < ry + rh) {
        if (opts && !this._matchesFilter(u, opts)) continue;
        result.push(u);
      }
    }

    return result;
  }

  /**
   * Check if any unit matching the filters is inside a region.
   */
  anyUnitInRegion(region: any, opts?: { nid?: string; team?: string; tag?: string }): boolean {
    return this.getUnitsInRegion(region, opts).length > 0;
  }

  // ========================================================================
  // Death check
  // ========================================================================

  /**
   * Check if a unit is dead. Accepts a unit NID or UnitObject.
   * Returns true if the unit is dead or not found in the game.
   */
  isDead(unit: any): boolean {
    const resolved = this._resolveUnit(unit);
    if (!resolved) {
      // Unit not found in game — treat as dead
      return true;
    }
    return resolved.isDead();
  }

  // ========================================================================
  // Support system
  // ========================================================================

  /**
   * Get the current support rank between two units.
   *
   * @param unit1  First unit (NID or UnitObject).
   * @param unit2  Second unit (NID or UnitObject).
   * @returns      The highest unlocked rank string (e.g. "C", "B", "A"), or null.
   */
  getSupportRank(unit1: any, unit2: any): string | null {
    const u1 = this._resolveUnit(unit1);
    const u2 = this._resolveUnit(unit2);
    if (!u1 || !u2) return null;

    const game = getGame();
    const supports = game.supports;
    if (!supports) return null;

    // The support controller stores pairs keyed as "unit1 | unit2".
    // Try both orderings.
    const pairKey1 = `${u1.nid} | ${u2.nid}`;
    const pairKey2 = `${u2.nid} | ${u1.nid}`;

    const pair = supports.pairs?.get(pairKey1) ?? supports.pairs?.get(pairKey2);
    if (!pair) return null;

    // Return the highest unlocked rank
    if (!pair.unlockedRanks || pair.unlockedRanks.length === 0) return null;

    // Ranks are ordered in the supportRanks array; find the highest
    const rankOrder: string[] = supports.supportRanks ?? [];
    let highestIdx = -1;
    let highestRank: string | null = null;
    for (const rank of pair.unlockedRanks) {
      const idx = rankOrder.indexOf(rank);
      if (idx > highestIdx) {
        highestIdx = idx;
        highestRank = rank;
      }
    }

    return highestRank;
  }

  // ========================================================================
  // Terrain
  // ========================================================================

  /**
   * Get the terrain NID at a position.
   *
   * @param pos  A position [x, y] or a unit (uses its position).
   * @returns    The terrain NID string, or null if out of bounds.
   */
  getTerrain(pos: any): string | null {
    const resolved = this._resolvePos(pos);
    if (!resolved) return null;

    const game = getGame();
    const board = game.board;
    if (!board) return null;

    return board.getTerrain(resolved[0], resolved[1]);
  }

  // ========================================================================
  // Achievement
  // ========================================================================

  /**
   * Check if an achievement has been unlocked.
   * Checks gameVars for an achievement flag.
   */
  hasAchievement(nid: string): boolean {
    const game = getGame();
    // Achievements are typically stored as gameVars with a key like "_achievement_<nid>"
    if (game.gameVars?.has(`_achievement_${nid}`)) {
      return !!game.gameVars.get(`_achievement_${nid}`);
    }
    // Also check a dedicated achievements set if available
    if (game.achievements) {
      return game.achievements.has?.(nid) ?? false;
    }
    return false;
  }

  // ========================================================================
  // Shove / push calculation
  // ========================================================================

  /**
   * Calculate the destination position when pushing a target unit away from
   * an anchor position by a given magnitude.
   *
   * Checks that each tile along the push path is in bounds, not occupied
   * (except by the target itself), and traversable.
   *
   * @param target     The unit being pushed (NID or UnitObject).
   * @param anchorPos  The position the push originates from [x, y].
   * @param magnitude  Number of tiles to push.
   * @returns          The final destination [x, y], or null if the push is blocked.
   */
  checkShove(target: any, anchorPos: [number, number], magnitude: number): [number, number] | null {
    const resolved = this._resolveUnit(target);
    if (!resolved || !resolved.position) return null;

    const game = getGame();
    const board = game.board;
    if (!board) return null;

    const [tx, ty] = resolved.position;
    const [ax, ay] = anchorPos;

    // Compute push direction (sign-based, not normalized)
    const dx = tx - ax;
    const dy = ty - ay;

    // Must have a clear direction (not same position)
    if (dx === 0 && dy === 0) return null;

    // Normalize to unit direction.
    // For cardinal pushes, one of dx/dy will be 0.
    // For diagonal pushes (shouldn't normally happen in LT), we still handle it.
    let ndx = 0;
    let ndy = 0;
    if (Math.abs(dx) >= Math.abs(dy)) {
      ndx = dx > 0 ? 1 : -1;
    } else {
      ndy = dy > 0 ? 1 : -1;
    }

    // Walk the push path
    let destX = tx;
    let destY = ty;

    for (let step = 1; step <= magnitude; step++) {
      const nextX = tx + ndx * step;
      const nextY = ty + ndy * step;

      // Check bounds
      if (!board.inBounds(nextX, nextY)) return null;

      // Check occupancy (another unit blocks the push)
      const occupant = board.getUnit(nextX, nextY);
      if (occupant && occupant !== resolved) return null;

      // Check movement cost (99 = impassable)
      if (game.db) {
        const klassDef = game.db.classes?.get(resolved.klass);
        const movGroup = klassDef?.movement_group ?? 'Infantry';
        const cost = board.getMovementCost(nextX, nextY, movGroup, game.db);
        if (cost >= 99) return null;
      }

      destX = nextX;
      destY = nextY;
    }

    // If we didn't move at all, the push failed
    if (destX === tx && destY === ty) return null;

    return [destX, destY];
  }

  // ========================================================================
  // Subitem lookup
  // ========================================================================

  /**
   * Get a subitem from a parent item in a unit's inventory.
   *
   * Searches the unit's items for the child NID first, then checks the
   * parent item's "subitems" component if present.
   *
   * @param unit           A UnitObject or unit NID string.
   * @param parentItemNid  The NID of the parent (multi-item).
   * @param childItemNid   The NID of the child subitem to find.
   * @returns              The child ItemObject, or null if not found.
   */
  getSubitem(unit: any, parentItemNid: string, childItemNid: string): ItemObject | null {
    const resolved = this._resolveUnit(unit);
    if (!resolved) return null;

    // First check if the child item is directly in the unit's inventory
    for (const item of resolved.items) {
      if (item.nid === childItemNid) return item;
    }

    // Then check the parent item's subitems component
    const parentItem = this.getItem(resolved, parentItemNid);
    if (parentItem) {
      const subitems = parentItem.getComponent<ItemObject[]>('subitems');
      if (subitems && Array.isArray(subitems)) {
        for (const sub of subitems) {
          if (sub.nid === childItemNid) return sub;
        }
      }
    }

    return null;
  }

  // ========================================================================
  // Alive check
  // ========================================================================

  /**
   * Check if a unit is alive. Opposite of isDead.
   * Returns true if the unit exists in the game and is not dead.
   */
  checkAlive(unitNid: string): boolean {
    return !this.isDead(unitNid);
  }

  // ========================================================================
  // Internal level
  // ========================================================================

  /**
   * Get the effective level of a unit accounting for promoted class.
   *
   * If the unit's class has tier > 0 (promoted), the internal level adds
   * the max_level of the base class (promotes_from) to the unit's level.
   * Falls back to the unit's raw level.
   */
  getInternalLevel(unit: any): number {
    const resolved = this._resolveUnit(unit);
    if (!resolved) return 0;

    const game = getGame();
    const klassDef = game.db?.classes?.get(resolved.klass);
    if (!klassDef) return resolved.level;

    if (klassDef.tier > 0 && klassDef.promotes_from) {
      const baseClass = game.db?.classes?.get(klassDef.promotes_from);
      if (baseClass) {
        return resolved.level + (baseClass.max_level ?? 20);
      }
    }

    return resolved.level;
  }

  // ========================================================================
  // Party resource queries
  // ========================================================================

  /**
   * Get the current party's money.
   */
  getMoney(): number {
    const game = getGame();
    return game.getMoney?.() ?? 0;
  }

  /**
   * Get the current party's BEXP (bonus experience).
   */
  getBexp(): number {
    const game = getGame();
    return game.getBexp?.() ?? 0;
  }

  // ========================================================================
  // Roam mode
  // ========================================================================

  /**
   * Check if roam mode is currently active.
   */
  isRoam(): boolean {
    const game = getGame();
    return game.roamInfo?.roam ?? false;
  }

  /**
   * Get the unit currently designated as the roam unit.
   * Returns the UnitObject or null if roam mode is inactive or no unit set.
   */
  getRoamUnit(): UnitObject | null {
    const game = getGame();
    const roamNid = game.roamInfo?.roamUnitNid;
    if (!roamNid) return null;
    return this.u(roamNid);
  }

  // ========================================================================
  // AI group
  // ========================================================================

  /**
   * Check if an AI group is active.
   *
   * @param nid  The AI group NID.
   * @returns    True if the group is active (or if the NID is empty/null).
   */
  aiGroupActive(nid: string): boolean {
    const game = getGame();
    return game.isAiGroupActive?.(nid) ?? false;
  }

  // ========================================================================
  // Team unit queries
  // ========================================================================

  /**
   * Get all units belonging to a specific team.
   *
   * @param team         The team string (e.g. 'player', 'enemy', 'other').
   * @param onlyOnField  If true, only returns units that have a position
   *                     and are not dead. Defaults to false.
   */
  getTeamUnits(team: string, onlyOnField: boolean = false): UnitObject[] {
    const game = getGame();
    const result: UnitObject[] = [];

    for (const unit of game.units.values()) {
      const u = unit as UnitObject;
      if (u.team !== team) continue;
      if (onlyOnField && (u.position == null || u.isDead())) continue;
      result.push(u);
    }

    return result;
  }

  /**
   * Get all player-team units.
   *
   * @param onlyOnField  If true, only returns units on the field and alive.
   */
  getPlayerUnits(onlyOnField: boolean = false): UnitObject[] {
    return this.getTeamUnits('player', onlyOnField);
  }

  /**
   * Get all enemy-team units.
   *
   * @param onlyOnField  If true, only returns units on the field and alive.
   */
  getEnemyUnits(onlyOnField: boolean = false): UnitObject[] {
    return this.getTeamUnits('enemy', onlyOnField);
  }

  /**
   * Get all units across all teams.
   *
   * @param onlyOnField  If true, only returns units on the field and alive.
   */
  getAllUnits(onlyOnField: boolean = false): UnitObject[] {
    const game = getGame();
    const result: UnitObject[] = [];

    for (const unit of game.units.values()) {
      const u = unit as UnitObject;
      if (onlyOnField && (u.position == null || u.isDead())) continue;
      result.push(u);
    }

    return result;
  }

  // ========================================================================
  // Convoy
  // ========================================================================

  /**
   * Get the convoy inventory for a party.
   *
   * @param partyNid  The party NID. If omitted, uses the current party.
   * @returns         The array of items in the convoy, or an empty array.
   */
  getConvoyInventory(partyNid?: string): ItemObject[] {
    const game = getGame();
    const party = game.getParty?.(partyNid);
    return party?.convoy ?? [];
  }

  // ========================================================================
  // Private helpers
  // ========================================================================

  /**
   * Resolve a unit reference. Accepts a UnitObject (returned as-is),
   * a string NID (looked up via u()), or null.
   */
  private _resolveUnit(unitOrNid: any): UnitObject | null {
    if (!unitOrNid) return null;
    if (typeof unitOrNid === 'string') return this.u(unitOrNid);
    if (unitOrNid.nid !== undefined) return unitOrNid as UnitObject;
    return null;
  }

  /**
   * Resolve a position. Accepts a [x, y] array or a unit/object with
   * a `position` property.
   */
  private _resolvePos(posOrUnit: any): [number, number] | null {
    if (!posOrUnit) return null;
    if (Array.isArray(posOrUnit) && posOrUnit.length >= 2) {
      return [posOrUnit[0], posOrUnit[1]];
    }
    if (posOrUnit.position) {
      return posOrUnit.position as [number, number];
    }
    return null;
  }

  /**
   * Resolve a region reference. Accepts a RegionData object (returned as-is)
   * or a string NID (looked up in the current level's regions).
   */
  private _resolveRegion(regionOrNid: any): RegionData | null {
    if (!regionOrNid) return null;

    if (typeof regionOrNid === 'string') {
      const game = getGame();
      const regions = game.currentLevel?.regions;
      if (!regions) return null;
      return (regions as RegionData[]).find((r: RegionData) => r.nid === regionOrNid) ?? null;
    }

    // Assume it's already a RegionData-like object
    if (regionOrNid.position && regionOrNid.size) {
      return regionOrNid as RegionData;
    }

    return null;
  }

  /** Manhattan distance between two positions. */
  private _manhattanDist(a: [number, number], b: [number, number]): number {
    return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]);
  }

  /**
   * Check if a unit matches the given filter options.
   * All specified filter properties must match (AND logic).
   */
  private _matchesFilter(unit: UnitObject, opts: UnitFilterOpts): boolean {
    if (opts.nid !== undefined && unit.nid !== opts.nid) return false;
    if (opts.team !== undefined && unit.team !== opts.team) return false;
    if (opts.tag !== undefined && !unit.tags.includes(opts.tag)) return false;
    if (opts.party !== undefined && unit.party !== opts.party) return false;
    return true;
  }
}
