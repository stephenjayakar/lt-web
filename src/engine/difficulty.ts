// ---------------------------------------------------------------------------
// DifficultyModeObject — Runtime difficulty mode for the current game session.
// Mirrors LT's app/engine/objects/difficulty_mode.py.
// ---------------------------------------------------------------------------

import type { DifficultyMode, NID } from '../data/types';

/**
 * Runtime difficulty mode for the current game session.
 * Created from a DifficultyMode DB prefab at game start.
 * Stores the player's chosen settings plus mutable event-driven counters
 * that accumulate across chapters (e.g., scaling enemy autolevels).
 */
export class DifficultyModeObject {
  nid: NID;
  permadeath: boolean;
  growths: string;
  rng_mode: string;

  // Mutable event-driven autolevel counters
  // These are modified by event commands (e.g., increase_difficulty)
  // and persist across the entire playthrough.
  enemyAutolevels: number = 0;
  enemyTruelevels: number = 0;
  bossAutolevels: number = 0;
  bossTruelevels: number = 0;

  constructor(nid: NID, permadeath: boolean, growths: string, rng_mode: string) {
    this.nid = nid;
    this.permadeath = permadeath;
    this.growths = growths;
    this.rng_mode = rng_mode;
  }

  /** Create from a DifficultyMode DB prefab. */
  static fromPrefab(prefab: DifficultyMode): DifficultyModeObject {
    return new DifficultyModeObject(
      prefab.nid,
      prefab.permadeath_choice === 'Classic',
      prefab.growths_choice,
      prefab.rng_choice,
    );
  }

  /**
   * Get base stat bonus dict for a unit based on team/tags.
   * Player allies get player_bases, bosses get boss_bases, rest get enemy_bases.
   *
   * @param unit Object with team and tags (typically a UnitObject).
   * @param alliedTeams Array of team NIDs allied with the player.
   * @param prefab The DifficultyMode DB prefab for looking up bonus dicts.
   */
  getBaseBonus(
    unit: { team: string; tags: string[] },
    alliedTeams: string[],
    prefab: DifficultyMode,
  ): Record<string, number> {
    if (alliedTeams.includes(unit.team)) return prefab.player_bases;
    if (unit.tags.includes('Boss')) return prefab.boss_bases;
    return prefab.enemy_bases;
  }

  /** Get growth bonus for a unit (added during leveling). */
  getGrowthBonus(
    unit: { team: string; tags: string[] },
    alliedTeams: string[],
    prefab: DifficultyMode,
  ): Record<string, number> {
    if (alliedTeams.includes(unit.team)) return prefab.player_growths;
    if (unit.tags.includes('Boss')) return prefab.boss_growths;
    return prefab.enemy_growths;
  }

  /**
   * Get total difficulty autolevels for a unit.
   * Combines the static prefab autolevels with the mutable event-driven counters.
   */
  getDifficultyAutolevels(
    unit: { team: string; tags: string[] },
    alliedTeams: string[],
    prefab: DifficultyMode,
  ): number {
    if (alliedTeams.includes(unit.team)) return prefab.player_autolevels;
    if (unit.tags.includes('Boss')) {
      return prefab.boss_autolevels + this.bossAutolevels + this.bossTruelevels;
    }
    return prefab.enemy_autolevels + this.enemyAutolevels + this.enemyTruelevels;
  }

  /**
   * Get the number of mutable "true levels" for a unit.
   * True levels increase the displayed level without granting stat gains.
   */
  getDifficultyTruelevels(
    unit: { team: string; tags: string[] },
    alliedTeams: string[],
  ): number {
    if (alliedTeams.includes(unit.team)) return 0;
    if (unit.tags.includes('Boss')) return this.bossTruelevels;
    return this.enemyTruelevels;
  }

  /** Serialize for save system. */
  save(): Record<string, any> {
    return {
      nid: this.nid,
      permadeath: this.permadeath,
      growths: this.growths,
      rng_mode: this.rng_mode,
      enemyAutolevels: this.enemyAutolevels,
      enemyTruelevels: this.enemyTruelevels,
      bossAutolevels: this.bossAutolevels,
      bossTruelevels: this.bossTruelevels,
    };
  }

  /** Restore from saved data. */
  static restore(data: Record<string, any>): DifficultyModeObject {
    const obj = new DifficultyModeObject(
      data.nid,
      data.permadeath,
      data.growths,
      data.rng_mode,
    );
    obj.enemyAutolevels = data.enemyAutolevels ?? 0;
    obj.enemyTruelevels = data.enemyTruelevels ?? 0;
    obj.bossAutolevels = data.bossAutolevels ?? 0;
    obj.bossTruelevels = data.bossTruelevels ?? 0;
    return obj;
  }
}
