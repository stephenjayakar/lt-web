/**
 * SupportController — Manages support pairs, point accumulation, rank
 * progression, and stat bonus calculation.
 *
 * Ported from LT's app/engine/supports.py.
 */

import type { NID, AffinityDef, SupportPairPrefab, SupportRankRequirement } from '../data/types';
import type { UnitObject } from '../objects/unit';
import type { GameBoard } from '../objects/game-board';
import type { Database } from '../data/database';

// ------------------------------------------------------------------
// Interfaces
// ------------------------------------------------------------------

export interface SupportEffect {
  damage: number;
  resist: number;
  accuracy: number;
  avoid: number;
  crit: number;
  dodge: number;
  attack_speed: number;
  defense_speed: number;
}

export interface SupportPair {
  nid: string;           // "unit1 | unit2"
  unit1Nid: string;
  unit2Nid: string;
  points: number;
  lockedRanks: string[];     // Reached by points, not yet conversed
  unlockedRanks: string[];   // Conversed/available
  pointsGainedThisChapter: number;
  ranksGainedThisChapter: number;
}

function emptySupportEffect(): SupportEffect {
  return {
    damage: 0,
    resist: 0,
    accuracy: 0,
    avoid: 0,
    crit: 0,
    dodge: 0,
    attack_speed: 0,
    defense_speed: 0,
  };
}

function addEffects(a: SupportEffect, b: SupportEffect): SupportEffect {
  return {
    damage: a.damage + b.damage,
    resist: a.resist + b.resist,
    accuracy: a.accuracy + b.accuracy,
    avoid: a.avoid + b.avoid,
    crit: a.crit + b.crit,
    dodge: a.dodge + b.dodge,
    attack_speed: a.attack_speed + b.attack_speed,
    defense_speed: a.defense_speed + b.defense_speed,
  };
}

function scaleEffect(e: SupportEffect, factor: number): SupportEffect {
  return {
    damage: Math.floor(e.damage * factor),
    resist: Math.floor(e.resist * factor),
    accuracy: Math.floor(e.accuracy * factor),
    avoid: Math.floor(e.avoid * factor),
    crit: Math.floor(e.crit * factor),
    dodge: Math.floor(e.dodge * factor),
    attack_speed: Math.floor(e.attack_speed * factor),
    defense_speed: Math.floor(e.defense_speed * factor),
  };
}

// ------------------------------------------------------------------
// SupportController
// ------------------------------------------------------------------

export class SupportController {
  private pairPrefabs: SupportPairPrefab[];
  private supportRanks: string[];
  private supportConstants: Map<string, any>;
  private affinities: Map<string, AffinityDef>;

  /** Runtime pairs: key = "unit1 | unit2" (canonical order from prefab). */
  private pairs: Map<string, SupportPair> = new Map();

  /** Index: unitNid -> list of pair NIDs that involve this unit. */
  private unitPairIndex: Map<string, string[]> = new Map();

  constructor(
    pairPrefabs: SupportPairPrefab[],
    supportRanks: string[],
    supportConstants: Map<string, any>,
    affinities: Map<string, AffinityDef>,
  ) {
    this.pairPrefabs = pairPrefabs;
    this.supportRanks = supportRanks;
    this.supportConstants = supportConstants;
    this.affinities = affinities;
  }

  // ------------------------------------------------------------------
  // Initialisation
  // ------------------------------------------------------------------

  /** Create runtime SupportPair objects from prefabs. */
  initPairs(): void {
    this.pairs.clear();
    this.unitPairIndex.clear();

    for (const prefab of this.pairPrefabs) {
      const nid = `${prefab.unit1} | ${prefab.unit2}`;
      const pair: SupportPair = {
        nid,
        unit1Nid: prefab.unit1,
        unit2Nid: prefab.unit2,
        points: 0,
        lockedRanks: [],
        unlockedRanks: [],
        pointsGainedThisChapter: 0,
        ranksGainedThisChapter: 0,
      };
      this.pairs.set(nid, pair);

      // Build index
      if (!this.unitPairIndex.has(prefab.unit1)) {
        this.unitPairIndex.set(prefab.unit1, []);
      }
      this.unitPairIndex.get(prefab.unit1)!.push(nid);

      if (!this.unitPairIndex.has(prefab.unit2)) {
        this.unitPairIndex.set(prefab.unit2, []);
      }
      this.unitPairIndex.get(prefab.unit2)!.push(nid);
    }
  }

  // ------------------------------------------------------------------
  // Pair lookup
  // ------------------------------------------------------------------

  /** Get pair by either unit order. */
  getPair(unit1Nid: string, unit2Nid: string): SupportPair | null {
    // Try canonical order
    const nid1 = `${unit1Nid} | ${unit2Nid}`;
    if (this.pairs.has(nid1)) return this.pairs.get(nid1)!;

    // Try reverse order
    const nid2 = `${unit2Nid} | ${unit1Nid}`;
    if (this.pairs.has(nid2)) return this.pairs.get(nid2)!;

    return null;
  }

  /** Get all pair NIDs involving a given unit. */
  private getPairNidsForUnit(unitNid: string): string[] {
    return this.unitPairIndex.get(unitNid) ?? [];
  }

  /** Get the prefab for a given pair NID. */
  private getPrefab(pairNid: string): SupportPairPrefab | null {
    const pair = this.pairs.get(pairNid);
    if (!pair) return null;
    return this.pairPrefabs.find(
      p => p.unit1 === pair.unit1Nid && p.unit2 === pair.unit2Nid
    ) ?? null;
  }

  /** Get the partner NID for a given unit in a pair. */
  private getPartnerNid(pairNid: string, unitNid: string): string | null {
    const pair = this.pairs.get(pairNid);
    if (!pair) return null;
    if (pair.unit1Nid === unitNid) return pair.unit2Nid;
    if (pair.unit2Nid === unitNid) return pair.unit1Nid;
    return null;
  }

  // ------------------------------------------------------------------
  // Constants helpers
  // ------------------------------------------------------------------

  private getConst(key: string, fallback: any): any {
    if (this.supportConstants.has(key)) {
      return this.supportConstants.get(key);
    }
    return fallback;
  }

  private get bonusRange(): number {
    return this.getConst('bonus_range', 3) as number;
  }

  private get growthRange(): number {
    return this.getConst('growth_range', 3) as number;
  }

  private get bonusMethod(): string {
    return this.getConst('bonus_method', 'Use Sum of Affinity Bonuses') as string;
  }

  private get rankLimit(): number {
    return this.getConst('rank_limit', 5) as number;
  }

  private get highestRankLimit(): number {
    return this.getConst('highest_rank_limit', 1) as number;
  }

  private get allyLimit(): number {
    return this.getConst('ally_limit', 0) as number;
  }

  private get bonusAllyLimit(): number {
    return this.getConst('bonus_ally_limit', 0) as number;
  }

  private get pointLimitPerChapter(): number {
    return this.getConst('point_limit_per_chapter', 0) as number;
  }

  private get rankLimitPerChapter(): number {
    return this.getConst('rank_limit_per_chapter', 1) as number;
  }

  private get endTurnPoints(): number {
    return this.getConst('end_turn_points', 1) as number;
  }

  private get combatPoints(): number {
    return this.getConst('combat_points', 5) as number;
  }

  private get chapterPoints(): number {
    return this.getConst('chapter_points', 0) as number;
  }

  // ------------------------------------------------------------------
  // Highest rank helpers
  // ------------------------------------------------------------------

  /** Get the highest unlocked rank for a pair. */
  private getHighestUnlockedRank(pair: SupportPair): string | null {
    if (pair.unlockedRanks.length === 0) return null;
    // Ranks are in order of the supportRanks array; later = higher
    let highestIdx = -1;
    let highestRank: string | null = null;
    for (const rank of pair.unlockedRanks) {
      const idx = this.supportRanks.indexOf(rank);
      if (idx > highestIdx) {
        highestIdx = idx;
        highestRank = rank;
      }
    }
    return highestRank;
  }

  /** Check if a rank is one of the "highest" ranks (last 2 in the rank list). */
  private isHighRank(rank: string): boolean {
    const idx = this.supportRanks.indexOf(rank);
    if (idx < 0) return false;
    // Top 2 ranks (typically A and S, or just A if only C/B/A)
    return idx >= this.supportRanks.length - 2;
  }

  /** Count total unlocked support ranks across all pairs for a unit. */
  private countTotalRanks(unitNid: string): number {
    let count = 0;
    for (const pairNid of this.getPairNidsForUnit(unitNid)) {
      const pair = this.pairs.get(pairNid);
      if (pair) {
        count += pair.unlockedRanks.length;
      }
    }
    return count;
  }

  /** Count high-rank unlocked supports for a unit. */
  private countHighRanks(unitNid: string): number {
    let count = 0;
    for (const pairNid of this.getPairNidsForUnit(unitNid)) {
      const pair = this.pairs.get(pairNid);
      if (pair) {
        for (const rank of pair.unlockedRanks) {
          if (this.isHighRank(rank)) {
            count++;
          }
        }
      }
    }
    return count;
  }

  /** Count unique supported partners (with at least one unlocked rank). */
  private countAllies(unitNid: string): number {
    let count = 0;
    for (const pairNid of this.getPairNidsForUnit(unitNid)) {
      const pair = this.pairs.get(pairNid);
      if (pair && pair.unlockedRanks.length > 0) {
        count++;
      }
    }
    return count;
  }

  // ------------------------------------------------------------------
  // Bonus calculation
  // ------------------------------------------------------------------

  /**
   * Calculate the stat bonus from a single support pairing at a given rank.
   * Combines affinity bonuses (from both units' affinities) and pair-specific bonuses.
   */
  getBonus(
    unit: UnitObject,
    partner: UnitObject,
    highestRank: string,
  ): SupportEffect {
    const pair = this.getPair(unit.nid, partner.nid);
    if (!pair) return emptySupportEffect();

    const prefab = this.getPrefab(pair.nid);
    if (!prefab) return emptySupportEffect();

    // Get pair-specific bonus for this rank
    let pairBonus = emptySupportEffect();
    for (const req of prefab.requirements) {
      if (req.support_rank === highestRank) {
        pairBonus = {
          damage: req.damage ?? 0,
          resist: req.resist ?? 0,
          accuracy: req.accuracy ?? 0,
          avoid: req.avoid ?? 0,
          crit: req.crit ?? 0,
          dodge: req.dodge ?? 0,
          attack_speed: req.attack_speed ?? 0,
          defense_speed: req.defense_speed ?? 0,
        };
        break;
      }
    }

    // Get affinity bonuses based on bonus_method
    const affinityBonus = this.computeAffinityBonus(unit, partner, highestRank);

    return addEffects(pairBonus, affinityBonus);
  }

  /** Compute the affinity-based bonus based on the bonus_method constant. */
  private computeAffinityBonus(
    unit: UnitObject,
    partner: UnitObject,
    rank: string,
  ): SupportEffect {
    const method = this.bonusMethod;

    if (method === 'No Bonus') {
      return emptySupportEffect();
    }

    const unitAffinity = this.affinities.get(unit.affinity);
    const partnerAffinity = this.affinities.get(partner.affinity);

    const unitBonus = unitAffinity
      ? this.getAffinityBonusForRank(unitAffinity, rank)
      : emptySupportEffect();

    const partnerBonus = partnerAffinity
      ? this.getAffinityBonusForRank(partnerAffinity, rank)
      : emptySupportEffect();

    switch (method) {
      case 'Use Personal Affinity Bonus':
        return unitBonus;

      case "Use Partner's Affinity Bonus":
        return partnerBonus;

      case 'Use Average of Affinity Bonuses':
        return scaleEffect(addEffects(unitBonus, partnerBonus), 0.5);

      case 'Use Sum of Affinity Bonuses':
      default:
        return addEffects(unitBonus, partnerBonus);
    }
  }

  /** Get the affinity bonus for a specific rank from an affinity definition. */
  private getAffinityBonusForRank(affinity: AffinityDef, rank: string): SupportEffect {
    if (!affinity.bonus) return emptySupportEffect();

    for (const bonus of affinity.bonus) {
      if (bonus.support_rank === rank) {
        return {
          damage: bonus.damage ?? 0,
          resist: bonus.resist ?? 0,
          accuracy: bonus.accuracy ?? 0,
          avoid: bonus.avoid ?? 0,
          crit: bonus.crit ?? 0,
          dodge: bonus.dodge ?? 0,
          attack_speed: bonus.attack_speed ?? 0,
          defense_speed: bonus.defense_speed ?? 0,
        };
      }
    }

    return emptySupportEffect();
  }

  /**
   * Aggregate all support bonuses for a unit from all partners within range.
   * This is the main method called by combat calcs.
   *
   * Respects `bonus_range` and `bonus_ally_limit` constants.
   */
  getSupportRankBonus(
    unit: UnitObject,
    board: GameBoard | null,
    db: Database,
    game: any,
  ): SupportEffect {
    if (!board || !unit.position) return emptySupportEffect();

    const bonusRange = this.bonusRange;
    const allyLimit = this.bonusAllyLimit;
    let totalBonus = emptySupportEffect();
    let allyCount = 0;

    for (const pairNid of this.getPairNidsForUnit(unit.nid)) {
      const pair = this.pairs.get(pairNid);
      if (!pair) continue;

      // Get highest unlocked rank
      const highestRank = this.getHighestUnlockedRank(pair);
      if (!highestRank) continue;

      // Get partner NID
      const partnerNid = this.getPartnerNid(pairNid, unit.nid);
      if (!partnerNid) continue;

      // Get partner unit
      const partner = game?.getUnit?.(partnerNid) ?? game?.units?.get(partnerNid);
      if (!partner || !partner.position) continue;
      if (partner.isDead?.()) continue;

      // Check if one_way: if the pair is one-way, only unit1 receives bonuses
      const prefab = this.getPrefab(pairNid);
      if (prefab?.one_way && pair.unit2Nid === unit.nid) continue;

      // Check range
      if (!this.isWithinRange(unit, partner, bonusRange, board, db, game)) continue;

      // Enforce ally limit
      if (allyLimit > 0 && allyCount >= allyLimit) break;

      const bonus = this.getBonus(unit, partner, highestRank);
      totalBonus = addEffects(totalBonus, bonus);
      allyCount++;
    }

    return totalBonus;
  }

  // ------------------------------------------------------------------
  // Point management
  // ------------------------------------------------------------------

  /** Add points to a pair, handle rank thresholds. */
  incrementPoints(pair: SupportPair, amount: number): void {
    // Check per-chapter point limit
    const pointLimit = this.pointLimitPerChapter;
    if (pointLimit > 0) {
      const remaining = pointLimit - pair.pointsGainedThisChapter;
      if (remaining <= 0) return;
      amount = Math.min(amount, remaining);
    }

    pair.points += amount;
    pair.pointsGainedThisChapter += amount;

    // Check if any rank thresholds have been crossed
    const prefab = this.getPrefab(pair.nid);
    if (!prefab) return;

    for (const req of prefab.requirements) {
      const rank = req.support_rank;
      // Already locked or unlocked? Skip.
      if (pair.lockedRanks.includes(rank) || pair.unlockedRanks.includes(rank)) continue;

      if (pair.points >= req.requirement) {
        // Check gate: if the gate is non-empty, the previous rank must be unlocked
        if (req.gate && req.gate !== '') {
          if (!pair.unlockedRanks.includes(req.gate)) continue;
        }
        pair.lockedRanks.push(rank);
      }
    }
  }

  // ------------------------------------------------------------------
  // Conversation availability
  // ------------------------------------------------------------------

  /** Check if a conversation is available (locked ranks + limit checks). */
  canSupport(pair: SupportPair, game: any): boolean {
    // Must have at least one locked rank
    if (pair.lockedRanks.length === 0) return false;

    // Check per-chapter rank limit
    const rankLimitChapter = this.rankLimitPerChapter;
    if (rankLimitChapter > 0 && pair.ranksGainedThisChapter >= rankLimitChapter) {
      return false;
    }

    // Check total rank limits for both units
    const unit1TotalRanks = this.countTotalRanks(pair.unit1Nid);
    const unit2TotalRanks = this.countTotalRanks(pair.unit2Nid);
    if (this.rankLimit > 0) {
      if (unit1TotalRanks >= this.rankLimit) return false;
      if (unit2TotalRanks >= this.rankLimit) return false;
    }

    // Check highest rank limit
    if (this.highestRankLimit > 0) {
      const nextRank = pair.lockedRanks[0];
      if (nextRank && this.isHighRank(nextRank)) {
        if (this.countHighRanks(pair.unit1Nid) >= this.highestRankLimit) return false;
        if (this.countHighRanks(pair.unit2Nid) >= this.highestRankLimit) return false;
      }
    }

    // Check ally limit
    if (this.allyLimit > 0) {
      // Count unique partners; if the pair doesn't already have an unlocked rank,
      // unlocking one would add a new ally
      if (pair.unlockedRanks.length === 0) {
        if (this.countAllies(pair.unit1Nid) >= this.allyLimit) return false;
        if (this.countAllies(pair.unit2Nid) >= this.allyLimit) return false;
      }
    }

    return true;
  }

  /** Move the first locked rank to unlocked. */
  unlockRank(pairNid: string, rank: string): void {
    const pair = this.pairs.get(pairNid);
    if (!pair) return;

    const idx = pair.lockedRanks.indexOf(rank);
    if (idx >= 0) {
      pair.lockedRanks.splice(idx, 1);
    }
    if (!pair.unlockedRanks.includes(rank)) {
      pair.unlockedRanks.push(rank);
    }
    pair.ranksGainedThisChapter++;
  }

  /** Disable a rank: remove from both locked and unlocked. */
  disableRank(pairNid: string, rank: string): void {
    const pair = this.pairs.get(pairNid);
    if (!pair) return;

    const lockedIdx = pair.lockedRanks.indexOf(rank);
    if (lockedIdx >= 0) pair.lockedRanks.splice(lockedIdx, 1);

    const unlockedIdx = pair.unlockedRanks.indexOf(rank);
    if (unlockedIdx >= 0) pair.unlockedRanks.splice(unlockedIdx, 1);
  }

  // ------------------------------------------------------------------
  // Growth: increment points at specific game events
  // ------------------------------------------------------------------

  /**
   * Called at end of turn: for each pair where both units are on the same
   * team (or allied), check if within growth_range, and add end_turn_points.
   */
  incrementEndTurnSupports(team: string, game: any): void {
    const pts = this.endTurnPoints;
    if (pts <= 0) return;

    for (const pair of this.pairs.values()) {
      const unit1 = game?.getUnit?.(pair.unit1Nid) ?? game?.units?.get(pair.unit1Nid);
      const unit2 = game?.getUnit?.(pair.unit2Nid) ?? game?.units?.get(pair.unit2Nid);

      if (!unit1 || !unit2) continue;
      if (!unit1.position || !unit2.position) continue;
      if (unit1.isDead?.() || unit2.isDead?.()) continue;

      // Both units must be on the team or allied with the team
      const db = game?.db as Database | undefined;
      const onTeam1 = unit1.team === team || (db?.areAllied(unit1.team, team) ?? false);
      const onTeam2 = unit2.team === team || (db?.areAllied(unit2.team, team) ?? false);
      if (!onTeam1 || !onTeam2) continue;

      // Check range
      if (!this.isWithinGrowthRange(unit1, unit2, game)) continue;

      this.incrementPoints(pair, pts);
    }
  }

  /**
   * Called after combat: for each of the unit's support partners within
   * growth_range, add combat_points.
   */
  incrementEndCombatSupports(unit: UnitObject, game: any): void {
    const pts = this.combatPoints;
    if (pts <= 0) return;

    for (const pairNid of this.getPairNidsForUnit(unit.nid)) {
      const pair = this.pairs.get(pairNid);
      if (!pair) continue;

      const partnerNid = this.getPartnerNid(pairNid, unit.nid);
      if (!partnerNid) continue;

      const partner = game?.getUnit?.(partnerNid) ?? game?.units?.get(partnerNid);
      if (!partner || !partner.position) continue;
      if (partner.isDead?.()) continue;

      if (!this.isWithinGrowthRange(unit, partner, game)) continue;

      this.incrementPoints(pair, pts);
    }
  }

  /**
   * Called at chapter end: add chapter_points to all pairs with both units
   * on the map.
   */
  incrementEndChapterSupports(game: any): void {
    const pts = this.chapterPoints;
    if (pts <= 0) return;

    for (const pair of this.pairs.values()) {
      const unit1 = game?.getUnit?.(pair.unit1Nid) ?? game?.units?.get(pair.unit1Nid);
      const unit2 = game?.getUnit?.(pair.unit2Nid) ?? game?.units?.get(pair.unit2Nid);

      if (!unit1 || !unit2) continue;
      if (!unit1.position || !unit2.position) continue;
      if (unit1.isDead?.() || unit2.isDead?.()) continue;

      this.incrementPoints(pair, pts);
    }
  }

  /** Reset per-chapter tracking counters for all pairs. */
  resetChapterCounts(): void {
    for (const pair of this.pairs.values()) {
      pair.pointsGainedThisChapter = 0;
      pair.ranksGainedThisChapter = 0;
    }
  }

  // ------------------------------------------------------------------
  // Range checking
  // ------------------------------------------------------------------

  /**
   * Check if two units are within a specified range.
   *
   * Range logic:
   *   0 = Both units can target the same enemy (overlapping attack ranges)
   *   1-98 = Manhattan distance between units
   *   99 = Entire map (always in range)
   */
  private isWithinRange(
    unit1: UnitObject,
    unit2: UnitObject,
    range: number,
    board: GameBoard | null,
    db: Database,
    game: any,
  ): boolean {
    if (!unit1.position || !unit2.position) return false;

    // 99 = entire map, always in range
    if (range >= 99) return true;

    // 0 = overlapping attack ranges
    if (range === 0) {
      return this.haveOverlappingAttackRanges(unit1, unit2, board, db, game);
    }

    // 1-98 = Manhattan distance
    const dist = Math.abs(unit1.position[0] - unit2.position[0]) +
                 Math.abs(unit1.position[1] - unit2.position[1]);
    return dist <= range;
  }

  /** Check if two units are within the growth_range constant. */
  private isWithinGrowthRange(
    unit1: UnitObject,
    unit2: UnitObject,
    game: any,
  ): boolean {
    const range = this.growthRange;
    const board = game?.board as GameBoard | null;
    const db = game?.db as Database;
    return this.isWithinRange(unit1, unit2, range, board, db, game);
  }

  /**
   * Check if two units have overlapping attack ranges.
   * Used when growth_range or bonus_range is 0.
   * Computes each unit's attack reach and checks for any common tile.
   */
  private haveOverlappingAttackRanges(
    unit1: UnitObject,
    unit2: UnitObject,
    board: GameBoard | null,
    _db: Database,
    game: any,
  ): boolean {
    if (!board || !unit1.position || !unit2.position) return false;

    // Get attack ranges for both units
    const attackRange1 = this.getUnitAttackRange(unit1);
    const attackRange2 = this.getUnitAttackRange(unit2);

    if (attackRange1[1] <= 0 && attackRange2[1] <= 0) return false;

    // Build the set of tiles unit1 can attack from its position
    const tiles1 = new Set<string>();
    const [minR1, maxR1] = attackRange1;
    const pos1 = unit1.position;
    for (let dx = -maxR1; dx <= maxR1; dx++) {
      for (let dy = -maxR1; dy <= maxR1; dy++) {
        const dist = Math.abs(dx) + Math.abs(dy);
        if (dist < minR1 || dist > maxR1) continue;
        const tx = pos1[0] + dx;
        const ty = pos1[1] + dy;
        if (board.inBounds(tx, ty)) {
          tiles1.add(`${tx},${ty}`);
        }
      }
    }

    // Check if unit2 can attack any of the same tiles
    const [minR2, maxR2] = attackRange2;
    const pos2 = unit2.position;
    for (let dx = -maxR2; dx <= maxR2; dx++) {
      for (let dy = -maxR2; dy <= maxR2; dy++) {
        const dist = Math.abs(dx) + Math.abs(dy);
        if (dist < minR2 || dist > maxR2) continue;
        const tx = pos2[0] + dx;
        const ty = pos2[1] + dy;
        if (board.inBounds(tx, ty) && tiles1.has(`${tx},${ty}`)) {
          return true;
        }
      }
    }

    return false;
  }

  /** Get the attack range (min, max) for a unit's equipped weapon. */
  private getUnitAttackRange(unit: UnitObject): [number, number] {
    for (const item of unit.items) {
      if (item.isWeapon()) {
        return [item.getMinRange(), item.getMaxRange()];
      }
    }
    return [0, 0];
  }
}
