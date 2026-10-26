// ---------------------------------------------------------------------------
// AIController -- Decides actions for AI-controlled units.
// Implements LT's AI system with primary (attack) and secondary (move toward)
// behaviors. Supports all view_range modes, target/target_spec filtering,
// guard mode, defend (return to starting position), and move_away_from.
//
// Ported from: app/engine/ai_controller.py
// ---------------------------------------------------------------------------

import type { UnitObject } from '../objects/unit';
import { ItemObject } from '../objects/item';
import type { GameBoard } from '../objects/game-board';
import type { Database } from '../data/database';
import type { PathSystem } from '../pathfinding/path-system';
import type { AiBehavior } from '../data/types';
import {
  computeDamage,
  computeHit,
  computeCrit,
  canDouble,
  canCounterattack,
  computeBlitzPhases,
  computeExtraAttackPhases,
  computeStrikeCount,
  getEquippedWeapon,
  evaluateEquation,
  weaponTriangle,
} from '../combat/combat-calcs';
import {
  available as itemAvailable,
  healAmount as itemHealAmount,
  isStealItem,
  noAttackAfterMove as itemNoAttackAfterMove,
  stealItemRestrict,
  stealTargetStatRestrict,
} from '../combat/item-system';
import {
  aiPriorityMultiplier,
  changeAi,
  checkAlly,
  checkEnemy,
  criticalAdditionFormula,
  criticalMultiplierFormula,
  dynamicCritDamageAddition,
  modifiedMaximumRange,
  modifiedMinimumRange,
  unitHasTag,
  modifyCritDamage,
  noAttackAfterMove as skillNoAttackAfterMove,
} from '../combat/skill-system';
import { isForkEngine } from '../engine/engine-flavor';
import { evaluateCondition } from '../events/event-manager';
import type { ConditionContext } from '../events/event-manager';
import { SkillObject } from '../objects/skill';
import {
  COMBAT_ART_SOURCE,
  getCombatArtOptions,
  type CombatArtOption,
} from '../combat/combat-art-system';

export interface AIAction {
  type: 'attack' | 'steal' | 'move' | 'wait' | 'use_item' | 'interact';
  unit: UnitObject;
  targetPosition?: [number, number]; // position to move to
  targetUnit?: UnitObject; // unit to attack/heal
  item?: ItemObject; // weapon or item to use
  targetItem?: ItemObject; // exact defender inventory item selected for Steal
  movePath?: [number, number][]; // path to follow
  regionNid?: string; // region NID for interact actions
  regionSubNid?: string; // region sub_nid for interact actions (e.g., 'Destructible')
  combatArt?: CombatArtOption;
}

/**
 * AIController -- Decides actions for AI-controlled units.
 * Faithfully implements LT's AI system with:
 * - Behaviour iteration with fallback
 * - All view_range modes (-4 through positive)
 * - target/target_spec filtering with invert_targeting
 * - Guard mode movement restriction
 * - Defend AI (return to starting position)
 * - Move_away_from (smart retreat)
 * - Primary -> Secondary fallback per behaviour
 */
export class AIController {
  private db: Database;
  private board: GameBoard;
  private pathSystem: PathSystem;
  /** Reference to the game state for region lookups. Set after construction. */
  gameRef: any;

  constructor(db: Database, board: GameBoard, pathSystem: PathSystem) {
    this.db = db;
    this.board = board;
    this.pathSystem = pathSystem;
    this.gameRef = null;
  }

  /**
   * Determine the best action for an AI unit.
   * Iterates through behaviours in priority order, trying each until one succeeds.
   */
  getAction(unit: UnitObject): AIAction {
    const aiDef = this.db.ai.get(changeAi(unit, unit.ai, this.gameRef));

    // Default: just wait if no AI definition found
    if (!aiDef) {
      return { type: 'wait', unit };
    }

    // Walk through behaviours in priority order
    for (const behaviour of aiDef.behaviours) {
      // Skip 'None' action behaviours
      if (behaviour.action === 'None' || behaviour.action === '') continue;

      // Skip view_range 0 (disabled)
      if (behaviour.view_range === 0) continue;

      // Check condition (empty string = always true)
      if (behaviour.condition && behaviour.condition.trim() !== '') {
        const ctx: ConditionContext = {
          game: this.gameRef,
          unit1: unit,
          position: unit.position ?? undefined,
          gameVars: this.gameRef?.gameVars,
          levelVars: this.gameRef?.levelVars,
        };
        if (!evaluateCondition(behaviour.condition, ctx)) {
          continue;
        }
      }

      // Compute valid moves (guard mode restricts to current position)
      const validMoves = this.getValidMovesForBehaviour(unit, behaviour.view_range);

      // Try the behaviour
      const action = this.tryBehaviour(unit, behaviour, validMoves, aiDef.offense_bias);
      if (action) return action;
    }

    // All behaviours exhausted -- wait
    return { type: 'wait', unit };
  }

  /**
   * Python `AIController.canto_retreat`: choose the reachable tile farthest
   * from the average enemy position, breaking ties toward the current tile.
   */
  getCantoRetreatAction(unit: UnitObject): AIAction | null {
    if (!unit.position) return null;
    const validMoves = this.pathSystem.getValidMoves(unit, this.board);
    const enemies = this.getEnemies(unit).filter((enemy) => enemy.position);
    if (validMoves.length === 0 || enemies.length === 0) return null;
    const averageX = enemies.reduce(
      (total, enemy) => total + enemy.position![0],
      0,
    ) / enemies.length;
    const averageY = enemies.reduce(
      (total, enemy) => total + enemy.position![1],
      0,
    ) / enemies.length;
    let best = validMoves[0];
    let bestAverageDistance = -Infinity;
    let bestOriginDistance = Infinity;
    for (const move of validMoves) {
      const averageDistance =
        Math.abs(move[0] - averageX) + Math.abs(move[1] - averageY);
      const originDistance = this.distance(move, unit.position);
      if (averageDistance > bestAverageDistance ||
          (averageDistance === bestAverageDistance &&
           originDistance < bestOriginDistance)) {
        best = move;
        bestAverageDistance = averageDistance;
        bestOriginDistance = originDistance;
      }
    }
    if (best[0] === unit.position[0] && best[1] === unit.position[1]) return null;
    const movePath = this.pathSystem.getPath(unit, best[0], best[1], this.board);
    return {
      type: 'move',
      unit,
      targetPosition: best,
      movePath: movePath ?? [unit.position, best],
    };
  }

  /**
   * Get valid moves for a unit, accounting for guard mode.
   * Guard mode (view_range -1): unit can only stay in place.
   */
  private getValidMovesForBehaviour(
    unit: UnitObject,
    viewRange: number,
  ): [number, number][] {
    if (viewRange === -1) {
      const groupActive = this.gameRef?.isAiGroupActive
        ? this.gameRef.isAiGroupActive(unit.aiGroup)
        : false;
      if (groupActive) {
        return this.pathSystem.getValidMoves(unit, this.board);
      }
      // Guard mode: can only stay at current position
      return unit.position ? [unit.position] : [];
    }
    return this.pathSystem.getValidMoves(unit, this.board);
  }

  /**
   * Try a single behaviour. Returns an action if successful, null if not.
   * For Attack/Support/Steal: tries primary AI, falls back to secondary if no target.
   * For Move_to/Interact: uses secondary AI directly.
   * For Move_away_from: uses smart retreat.
   */
  private tryBehaviour(
    unit: UnitObject,
    behaviour: AiBehavior,
    validMoves: [number, number][],
    offenseBias: number,
  ): AIAction | null {
    const action = behaviour.action;

    if (action === 'Attack') {
      // Get targets based on target type and spec
      const targets = this.getTargets(unit, behaviour);
      const enemies = this.filterByViewRange(unit, targets, behaviour.view_range);

      // Try primary AI (attack)
      const primaryAction = this.primaryAI(unit, validMoves, enemies, offenseBias);
      if (primaryAction) return primaryAction;

      // Python falls back to SecondaryAI over every get_targets() position;
      // its own view-range limit (none at all for -1/-2) applies there.
      return this.pythonSecondaryAI(unit, behaviour, this.unitPositions(targets));
    }

    if (action === 'Support') {
      // Support targets are allies that need healing (HP < max)
      const allies = this.getAllies(unit).filter(ally => {
        return ally.currentHp < ally.maxHp;
      });
      // Also include self if the unit is damaged (for self-heal consumables)
      const selfDamaged = unit.currentHp < unit.maxHp;
      const filtered = this.filterByTargetSpec(allies, behaviour);
      const inRange = this.filterByViewRange(unit, filtered, behaviour.view_range);

      // Try primary AI: use a healing item/staff on an ally (or self)
      const primaryAction = this.supportPrimaryAI(unit, validMoves, inRange, selfDamaged);
      if (primaryAction) return primaryAction;

      // Python SecondaryAI over every allied target (help term 100).
      return this.pythonSecondaryAI(
        unit, behaviour, this.unitPositions(this.getTargets(unit, behaviour)),
      );
    }

    if (action === 'Steal') {
      const targets = this.getTargets(unit, behaviour);
      const enemies = this.filterByViewRange(unit, targets, behaviour.view_range);
      const primaryAction = this.stealPrimaryAI(unit, validMoves, enemies);
      if (primaryAction) return primaryAction;
      // Python SecondaryAI scores every Steal target 0 (fork) / None
      // (upstream), so a thief with nothing to steal in reach never advances.
      return this.pythonSecondaryAI(unit, behaviour, this.unitPositions(targets));
    }

    if (action === 'Interact') {
      // Python builds a SecondaryAI for Interact: path to the region tiles.
      return this.pythonSecondaryAI(unit, behaviour, this.getTargetPositions(unit, behaviour));
    }

    if (action === 'Move_to' || action === 'move_to') {
      // Python SecondaryAI over get_targets(): unit, region, position or
      // terrain target positions alike.
      const positions = ['Event', 'Terrain'].includes(String(behaviour.target))
        ? this.getTargetPositions(unit, behaviour)
        : behaviour.target === 'Position'
          ? this.getPositionTargets(unit, behaviour)
          : this.getTargets(unit, behaviour).map((target) => target.position).filter((pos): pos is [number, number] => !!pos);
      return this.pythonSecondaryAI(unit, behaviour, positions);
    }

    if (action === 'Move_away_from' || action === 'move_away_from') {
      return this.smartRetreat(unit, validMoves, behaviour);
    }

    if (action === 'Wait' || action === 'wait') {
      return { type: 'wait', unit };
    }

    return null;
  }

  // ====================================================================
  // Target resolution
  // ====================================================================

  /**
   * Get target units based on behaviour's target type and spec.
   */
  /** Python get_targets for target == 'Position' (Starting or a literal point). */
  private getPositionTargets(unit: UnitObject, behaviour: AiBehavior): [number, number][] {
    if (behaviour.target_spec === 'Starting') {
      return unit.startingPosition ? [[unit.startingPosition[0], unit.startingPosition[1]]] : [];
    }
    if (Array.isArray(behaviour.target_spec) && behaviour.target_spec.length === 2) {
      const pos: [number, number] = [Number(behaviour.target_spec[0]), Number(behaviour.target_spec[1])];
      if (!isNaN(pos[0]) && !isNaN(pos[1])) return [pos];
    }
    return [];
  }

  /**
   * Python ai_controller.SecondaryAI (Move_to / Interact, and the fallback of
   * Attack / Support / Steal): filter the target positions by the view-range
   * limit (view_range -4 first tries double-move range, then widens to
   * everything; -1, and -2 for Attack/Support/Steal, allow nothing), A* to
   * each one (enemies block; adjacent is good enough only for unit targets),
   * score by compute_priority and travel as far as possible along the best
   * path. A target without a path is skipped rather than approached in a
   * straight line. When the best position is the unit's own tile the AI is
   * done and the unit waits.
   */
  private pythonSecondaryAI(
    unit: UnitObject,
    behaviour: AiBehavior,
    allTargets: [number, number][],
  ): AIAction | null {
    const start = unit.position;
    if (!start) return null;
    const fork = isForkEngine();
    const groupActive = !!(unit.aiGroup && this.gameRef?.isAiGroupActive?.(unit.aiGroup));
    let viewRange = behaviour.view_range === -4 || groupActive ? -3 : behaviour.view_range;
    const movement = unit.getMovement();
    const zeroMove = this.getMaxItemRange(unit);
    const singleMove = zeroMove + movement;
    const doubleMove = singleMove + movement;
    let widened = false;
    const getLimit = (): number => {
      if (widened || viewRange === -4) return 99;
      if (viewRange === -3) return doubleMove;
      if (viewRange === -2) return ['Attack', 'Support', 'Steal'].includes(behaviour.action) ? -1 : singleMove;
      if (viewRange === -1) return -1;
      return viewRange;
    };
    const unique = allTargets.filter((pos, index) =>
      allTargets.findIndex((other) => other[0] === pos[0] && other[1] === pos[1]) === index);

    let available = unique.filter((pos) => this.distance(start, pos) <= getLimit());
    let bestTp: number | null = null;
    let bestTarget: [number, number] | null = null;
    let bestPath: [number, number][] | null = null;
    for (;;) {
      const target = available.pop();
      if (target) {
        const occupant = this.board.getUnit(target[0], target[1]);
        const adjGoodEnough = behaviour.target === 'Event' || behaviour.target === 'Terrain'
          ? false
          : behaviour.target === 'Position' && !occupant ? false : true;
        const limit = getLimit();
        const path = this.pathSystem.getPath(unit, target[0], target[1], this.board, {
          adjGoodEnough,
          limit: limit > 0 ? limit : undefined,
          // Upstream AStar treats any single tile costing more than the
          // unit's movement as impassable; EOtF's fork has no such cap.
          maxMovementLimit: fork ? undefined : movement,
        });
        if (!path || path.length === 0) continue;
        const tp = this.secondaryPriority(unit, behaviour, occupant, path.length);
        // Fork: max_tp starts at 0 and only a strictly positive score wins.
        // Upstream: max_tp starts at None so any non-None score can win.
        const better = fork
          ? tp !== null && tp > (bestTp ?? 0)
          : tp !== null && (bestTp === null || tp > bestTp);
        if (better) {
          bestTp = tp;
          bestTarget = target;
          bestPath = path;
        }
        continue;
      }
      if (bestTarget && bestPath) break;
      if ((behaviour.view_range === -4 || groupActive) && !widened) {
        widened = true;
        viewRange = -4;
        available = [...unique];
        continue;
      }
      return null;
    }

    const destination = this.pathSystem.travelAlgorithm(bestPath, unit, this.board);
    const stays = destination[0] === start[0] && destination[1] === start[1];
    const movePath = stays ? [start] : this.pathSystem.getPath(unit, destination[0], destination[1], this.board);
    if (behaviour.action === 'Interact') {
      const targetSpec = typeof behaviour.target_spec === 'string' ? behaviour.target_spec : '';
      const regions = this.gameRef?.currentLevel?.regions ?? [];
      const region = regions.find((r: any) =>
        r.region_type === 'event' && r.sub_nid === targetSpec &&
        destination[0] >= r.position[0] && destination[0] < r.position[0] + (r.size?.[0] ?? 1) &&
        destination[1] >= r.position[1] && destination[1] < r.position[1] + (r.size?.[1] ?? 1) &&
        (!r.condition || (() => {
          try {
            return evaluateCondition(r.condition, {
              game: this.gameRef, unit1: unit, region: r, position: destination,
              gameVars: this.gameRef?.gameVars, levelVars: this.gameRef?.levelVars,
            });
          } catch {
            return false;
          }
        })()));
      if (region) {
        return {
          type: 'interact',
          unit,
          targetPosition: destination,
          movePath: movePath ?? [start, destination],
          regionNid: region.nid,
          regionSubNid: region.sub_nid ?? targetSpec,
        };
      }
    }
    // Python: a goal position equal to the unit's own tile ends the AI
    // without trying further behaviours.
    if (stays) return { type: 'wait', unit };
    return {
      type: 'move',
      unit,
      targetPosition: destination,
      targetUnit: this.board.getUnit(bestTarget![0], bestTarget![1]) ?? undefined,
      movePath: movePath ?? [start, destination],
    };
  }

  /**
   * Python SecondaryAI.compute_priority. Where upstream returns None (skip
   * the target) this returns null; the fork returns 0 there, which can never
   * beat its starting max_tp of 0.
   */
  private secondaryPriority(
    unit: UnitObject,
    behaviour: AiBehavior,
    occupant: UnitObject | null,
    pathLength: number,
  ): number | null {
    const fork = isForkEngine();
    const terms: Array<[number, number]> = [[1 - Math.log(pathLength) / 4, 60]];
    if (behaviour.action === 'Attack' && occupant) {
      const damageTerms = this.secondaryDamageTerms(unit, occupant);
      if (damageTerms.length === 0) return fork ? 0 : null;
      terms.push(...damageTerms);
    } else if (behaviour.action === 'Support' && occupant) {
      if (occupant === unit) return fork ? 0 : null;
      const maxHp = occupant.maxHp;
      const missing = maxHp - occupant.currentHp;
      terms.push([Math.min(1, Math.max(0, missing / maxHp)), 100]);
    } else if (behaviour.action === 'Steal' && occupant) {
      return fork ? 0 : null;
    } else if (behaviour.action === 'Interact' && !fork) {
      // Upstream only: lower the quality of tiles someone already stands on.
      terms.push([occupant ? 0 : 1, 15]);
    }
    return processTerms(terms);
  }

  /**
   * Python SecondaryAI.default_priority: best damage/status item against the
   * target plus its missing-HP weakness. The fork skips any item whose
   * expected damage is 0 (it never took upstream's `attack_zero_dam` /
   * `attack_zero_hit` change), so a target it cannot hurt or status gets no
   * terms at all.
   */
  private secondaryDamageTerms(unit: UnitObject, enemy: UnitObject): Array<[number, number]> {
    const fork = isForkEngine();
    const hpMax = enemy.maxHp;
    const weaknessTerm = (hpMax - enemy.currentHp) / hpMax;
    const attackZeroDam = !!this.db.getConstant('attack_zero_dam', true);
    const attackZeroHit = !!this.db.getConstant('attack_zero_hit', true);
    let tp: number | null = fork ? 0 : null;
    let highestDamage = 0;
    let highestStatus = 0;
    for (const item of this.allItems(unit)) {
      if (!itemAvailable(unit, item, this.db, this.gameRef)) continue;
      const statusTerm = item.getComponent('status_on_hit') ? 1 : 0;
      let trueDamage: number | null = fork ? 0 : null;
      if (item.isWeapon() || item.isSpell()) {
        const raw = itemHasDamage(item) ? this.predictedDamage(unit, item, enemy) : null;
        const hit = Math.min(1, Math.max(0, this.predictedHit(unit, item, enemy) / 100));
        if (fork) {
          trueDamage = raw ? raw * hit : 0;
        } else if (raw !== null && (raw > 0 || attackZeroDam) && (hit > 0 || attackZeroHit)) {
          trueDamage = raw * hit;
        }
      }
      if (fork ? (trueDamage ?? 0) <= 0 && statusTerm <= 0 : trueDamage === null && statusTerm <= 0) {
        continue;
      }
      const damageTerm = trueDamage ? Math.min(trueDamage / hpMax, 1) : 0;
      const newTp = damageTerm + statusTerm / 2;
      if (tp === null || newTp > tp) {
        tp = newTp;
        highestDamage = damageTerm;
        highestStatus = statusTerm;
      }
    }
    if (fork ? highestStatus === 0 && highestDamage === 0 : tp === null) return [];
    return [[highestDamage, 15], [highestStatus, 10], [weaknessTerm, 15]];
  }

  private unitPositions(units: UnitObject[]): [number, number][] {
    return units
      .filter((target) => !target.isDead() && target.position)
      .map((target) => [target.position![0], target.position![1]]);
  }

  /** Python item_funcs.get_all_items: multi items contribute their leaves. */
  private allItems(unit: UnitObject): ItemObject[] {
    const result: ItemObject[] = [];
    const visit = (item: ItemObject): void => {
      if (item.hasComponent('multi_item') && item.subitems.length > 0) {
        for (const subitem of item.subitems) visit(subitem);
      } else {
        result.push(item);
      }
    };
    for (const item of unit.items) visit(item);
    return result;
  }

  private getTargets(unit: UnitObject, behaviour: AiBehavior): UnitObject[] {
    const targetType = behaviour.target;

    let candidates: UnitObject[];

    if (targetType === 'Enemy') {
      candidates = this.getEnemies(unit);
    } else if (targetType === 'Ally') {
      candidates = this.getAllies(unit);
    } else if (targetType === 'Unit') {
      candidates = this.board.getAllUnits().filter(u => !u.isDead() && u.position);
    } else {
      // None or unsupported -- no targets
      return [];
    }

    candidates = this.filterByTargetSpec(candidates, behaviour);

    if (this.db.getConstant('ai_fog_of_war', false) && behaviour.target !== 'Position') {
      const fogInfo = this.gameRef?.getCurrentFogInfo?.();
      const allUnits = this.gameRef?.getAllUnits?.() ?? this.board.getAllUnits();
      candidates = candidates.filter((target) => {
        if (!target.position) return false;
        if (unitHasTag(target, 'Tile', this.gameRef)) return true;
        return this.board.inVision(target.position, unit.team, fogInfo, this.db, allUnits);
      });
    }

    return candidates;
  }

  /**
   * Get target positions for Interact (Event regions) and Terrain targets.
   */
  private getTargetPositions(unit: UnitObject, behaviour: AiBehavior): [number, number][] {
    if (behaviour.target === 'Event') {
      // Find Event regions matching target_spec sub_nid
      const targetSpec = typeof behaviour.target_spec === 'string' ? behaviour.target_spec : '';
      const regions = this.gameRef?.currentLevel?.regions ?? [];
      const positions: [number, number][] = [];
      for (const region of regions) {
        if (region.region_type !== 'event') continue;
        if (targetSpec && region.sub_nid !== targetSpec) continue;
        // Evaluate region condition against this unit
        if (region.condition) {
          const condCtx: ConditionContext = {
            game: this.gameRef,
            unit1: unit,
            region,
            gameVars: this.gameRef?.gameVars,
            levelVars: this.gameRef?.levelVars,
          };
          try {
            if (!evaluateCondition(region.condition, condCtx)) continue;
          } catch {
            continue;
          }
        }
        // Add all positions in the region
        const [rx, ry] = region.position;
        const [rw, rh] = region.size ?? [1, 1];
        for (let x = rx; x < rx + rw; x++) {
          for (let y = ry; y < ry + rh; y++) {
            positions.push([x, y]);
          }
        }
      }
      // Deduplicate
      const seen = new Set<string>();
      return positions.filter(([x, y]) => {
        const key = `${x},${y}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }

    if (behaviour.target === 'Terrain') {
      const terrainSpec = behaviour.target_spec;
      if (typeof terrainSpec === 'string') {
        const positions: [number, number][] = [];
        for (let y = 0; y < this.board.height; y++) {
          for (let x = 0; x < this.board.width; x++) {
            if (this.board.getTerrain(x, y) === terrainSpec) {
              positions.push([x, y]);
            }
          }
        }
        return positions;
      }
      return [];
    }

    if (behaviour.target === 'Position') {
      if (behaviour.target_spec === 'Starting' && unit.startingPosition) {
        return [unit.startingPosition];
      }
      if (Array.isArray(behaviour.target_spec) && behaviour.target_spec.length === 2) {
        const pos: [number, number] = [
          Number(behaviour.target_spec[0]),
          Number(behaviour.target_spec[1]),
        ];
        if (!isNaN(pos[0]) && !isNaN(pos[1])) return [pos];
      }
    }

    return [];
  }

  /**
   * Filter units by target_spec and invert_targeting.
   */
  private filterByTargetSpec(units: UnitObject[], behaviour: AiBehavior): UnitObject[] {
    const spec = behaviour.target_spec;
    if (!spec) return units;

    // target_spec can be:
    // - null (no filter)
    // - "Starting" (for Position target)
    // - [specType, specValue] for unit filtering
    if (typeof spec === 'string') return units; // "Starting" etc handled elsewhere

    if (!Array.isArray(spec) || spec.length < 2) return units;

    const specType = spec[0];
    const specValue = spec[1];
    const invert = behaviour.invert_targeting;

    return units.filter(u => {
      let matches = false;

      switch (specType) {
        case 'Tag':
          matches = unitHasTag(u, specValue, this.gameRef);
          break;
        case 'Class':
          matches = u.klass === specValue;
          break;
        case 'Name':
          matches = u.name === specValue;
          break;
        case 'ID':
          matches = u.nid === specValue;
          break;
        case 'Team':
          matches = u.team === specValue;
          break;
        case 'Faction':
          matches = u.faction === specValue;
          break;
        case 'Party':
          matches = u.party === specValue;
          break;
        case 'All':
          matches = true;
          break;
        default:
          matches = true;
          break;
      }

      return invert ? !matches : matches;
    });
  }

  // ====================================================================
  // View range filtering
  // ====================================================================

  /**
   * Filter targets by view range.
   *
   * View range semantics:
   *   -1: Guard mode -- only targets reachable from current position (weapon range only)
   *   -2: Single move -- targets within (max_item_range + MOV)
   *   -3: Double move -- targets within (max_item_range + 2*MOV)
   *   -4: Entire map -- all targets
   *    0: Disabled -- no targets
   *   >0: Custom range -- targets within that many tiles
   */
  private filterByViewRange(
    unit: UnitObject,
    targets: UnitObject[],
    viewRange: number,
  ): UnitObject[] {
    if (viewRange === -4) return targets; // All targets
    if (viewRange === 0) return []; // Disabled

    const unitPos = unit.position;
    if (!unitPos) return [];

    const maxItemRange = this.getMaxItemRange(unit);
    const mov = unit.getStatValue('MOV');

    let limit: number;

    switch (viewRange) {
      case -1:
        // Guard: only targets within weapon range from current position
        limit = maxItemRange;
        break;
      case -2:
        // Single move range
        limit = maxItemRange + mov;
        break;
      case -3:
        // Double move range
        limit = maxItemRange + mov * 2;
        break;
      default:
        // Positive: literal tile range
        limit = viewRange > 0 ? viewRange : 99;
        break;
    }

    return targets.filter(t => {
      if (!t.position) return false;
      return this.distance(unitPos, t.position) <= limit;
    });
  }

  /**
   * Get the maximum range of any weapon or usable item the unit has.
   * Includes staves and spells for proper view range calculations.
   */
  private getMaxItemRange(unit: UnitObject): number {
    let maxRange = 0;
    for (const item of unit.items) {
      if ((item.isWeapon() || item.isSpell()) && itemAvailable(unit, item, this.db, this.gameRef)) {
        maxRange = Math.max(maxRange, modifiedMaximumRange(unit, item, this.gameRef));
      }
    }
    for (const item of this.getStealItems(unit)) {
      maxRange = Math.max(maxRange, modifiedMaximumRange(unit, item, this.gameRef));
    }
    return maxRange;
  }

  private getStealItems(unit: UnitObject): ItemObject[] {
    const items = unit.items.filter((item) =>
      isStealItem(item) &&
      itemAvailable(unit, item, this.db, this.gameRef),
    );
    if (unit.skills.some((skill) => skill.getComponent<string>('ability') === 'Steal')) {
      const prefab = this.db.items.get('Steal');
      if (prefab) {
        const ability = new ItemObject(prefab);
        ability.owner = unit;
        items.push(ability);
      }
    }
    return items;
  }

  /** Choose the highest-value legal inventory item, matching Python Steal AI. */
  private stealPrimaryAI(
    unit: UnitObject,
    validMoves: [number, number][],
    enemies: UnitObject[],
  ): AIAction | null {
    let best: AIAction | null = null;
    let bestValue = -Infinity;
    const stealItems = this.getStealItems(unit);
    for (const stealItem of stealItems) {
      for (const enemy of enemies) {
        if (!enemy.position || enemy.isDead()) continue;
        const atkExpr = this.db.getEquation('STEAL_ATK') ?? 'SPD';
        const stealAtk = evaluateEquation(atkExpr, unit, { db: this.db, item: stealItem });
        const defExpr = this.db.getEquation('STEAL_DEF') ?? 'SPD';
        const stealDef = evaluateEquation(defExpr, enemy, { db: this.db, item: stealItem });
        if (!stealTargetStatRestrict(unit, stealItem, enemy, stealAtk, stealDef)) continue;
        const legal = enemy.items.filter((candidate) =>
          stealItemRestrict(unit, stealItem, enemy, candidate, this.db),
        );
        if (legal.length === 0) continue;
        const targetItem = legal.reduce((most, candidate) =>
          candidate.getValue() >= most.getValue() ? candidate : most,
        );
        for (const pos of this.getAttackPositions(unit, validMoves, enemy, stealItem)) {
          const value = targetItem.getValue();
          if (value < bestValue) continue;
          bestValue = value;
          const path = unit.position
            ? this.pathSystem.getPath(unit, pos[0], pos[1], this.board)
            : null;
          best = {
            type: 'steal',
            unit,
            targetPosition: pos,
            targetUnit: enemy,
            targetItem,
            item: stealItem,
            movePath: path ?? [pos],
          };
        }
      }
    }
    return best;
  }

  // ====================================================================
  // Primary AI: Find best attack target + position
  // ====================================================================

  /**
   * Python PrimaryAI for Attack. Every available weapon/spell (multi items
   * contribute their leaves; sequence items are skipped like
   * get_ai_targets) and every ready combat art is tried against every
   * position it can reach a target from. A (item, target, move) triple is
   * scored by compute_priority and only a strictly positive score beats the
   * starting max_tp of 0, so a unit that cannot hurt anything it can reach
   * falls back to SecondaryAI. With more than 10 targets for an item, only
   * the strike position farthest from the enemies is scored per target.
   *
   * `enemies` are the behaviour's legal targets (Python behaviour_targets):
   * only those count as the main target or as splash.
   */
  private primaryAI(
    unit: UnitObject,
    validMoves: [number, number][],
    enemies: UnitObject[],
    offenseBias: number,
  ): AIAction | null {
    if (validMoves.length === 0 || !unit.position) return null;
    if (enemies.length === 0) return null;
    const origin: [number, number] = [unit.position[0], unit.position[1]];

    // Python PrimaryAI treats extra abilities (combat arts) as additional
    // items and evaluates them through the same target/priority loop.
    const variants: { weapon: ItemObject; combatArt?: CombatArtOption }[] = [];
    for (const item of this.allItems(unit)) {
      if (!item.isWeapon() && !item.isSpell()) continue;
      if (item.hasComponent('sequence_item')) continue;
      if (itemAvailable(unit, item, this.db, this.gameRef)) variants.push({ weapon: item });
    }
    for (const option of getCombatArtOptions(this.gameRef, unit, false)) {
      for (const weapon of option.weapons) variants.push({ weapon, combatArt: option });
    }
    if (variants.length === 0) return null;

    const enemyPositions = this.getEnemies(unit).map((enemy) => enemy.position!);
    let maxTp = 0;
    let bestAction: AIAction | null = null;

    for (const variant of variants) {
      this.withCombatArt(unit, variant.combatArt, () => {
        const item = variant.weapon;
        const noMoveAttack = itemNoAttackAfterMove(unit, item) ||
          skillNoAttackAfterMove(unit, { game: this.gameRef, item });
        const candidates = this.aiTargets(unit, item, validMoves);
        const many = candidates.length > 10;
        const validFrom = new Map<string, Set<string>>();
        for (const [targetPos, possibleMoves] of candidates) {
          const targetUnit = this.board.getUnit(targetPos[0], targetPos[1]);
          // The AI state can only start combat against a unit.
          if (!targetUnit || targetUnit === unit || targetUnit.isDead()) continue;
          let moves = possibleMoves;
          if (many) {
            const farthest = farthestAwayPos(origin, possibleMoves, enemyPositions);
            moves = [farthest ?? possibleMoves[0]];
          }
          for (const move of moves) {
            if (noMoveAttack && (move[0] !== origin[0] || move[1] !== origin[1])) continue;
            const tp = this.withTemporaryPosition(unit, move, () => {
              const key = `${move[0]},${move[1]}`;
              let valid = validFrom.get(key);
              if (!valid) {
                valid = new Set(this.validTargetsFrom(unit, item, move)
                  .map(([x, y]) => `${x},${y}`));
                validFrom.set(key, valid);
              }
              if (!valid.has(`${targetPos[0]},${targetPos[1]}`)) return 0;
              return this.computePrimaryPriority(
                unit, item, targetPos, move, origin, enemies, offenseBias,
              );
            });
            if (tp > maxTp) {
              maxTp = tp;
              const path = this.pathSystem.getPath(unit, move[0], move[1], this.board);
              bestAction = {
                type: 'attack',
                unit,
                targetPosition: move,
                targetUnit,
                item,
                movePath: path ?? [move],
                combatArt: variant.combatArt,
              };
            }
          }
        }
      });
    }

    return bestAction;
  }

  /**
   * Python target_system.get_ai_targets + get_possible_attack_positions: the
   * item's component targets that lie within its range of at least one
   * valid move, each with the moves it can be struck from.
   */
  private aiTargets(
    unit: UnitObject,
    item: ItemObject,
    validMoves: [number, number][],
  ): Array<[[number, number], [number, number][]]> {
    const targetSystem = this.gameRef?.targetSystem;
    const positions: [number, number][] = targetSystem
      ? targetSystem.getComponentTargets(unit, item)
      : this.getEnemies(unit).map((enemy) => enemy.position!);
    const minRange = modifiedMinimumRange(unit, item, this.gameRef);
    const maxRange = modifiedMaximumRange(unit, item, this.gameRef);
    const result: Array<[[number, number], [number, number][]]> = [];
    const seen = new Set<string>();
    for (const position of positions) {
      const key = `${position[0]},${position[1]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const moves = validMoves.filter((move) => {
        const distance = this.distance(move, position);
        return distance >= minRange && distance <= maxRange;
      });
      if (moves.length > 0) result.push([[position[0], position[1]], moves]);
    }
    return result;
  }

  /** Targets the item can legally hit from `move` (range, restrictions, splash). */
  private validTargetsFrom(
    unit: UnitObject,
    item: ItemObject,
    move: [number, number],
  ): [number, number][] {
    const targetSystem = this.gameRef?.targetSystem;
    if (targetSystem) return targetSystem.getValidTargetsRecursive(unit, item, move);
    return this.getEnemies(unit)
      .map((enemy) => enemy.position!)
      .filter((position) => {
        const distance = this.distance(move, position);
        return distance >= modifiedMinimumRange(unit, item, this.gameRef) &&
          distance <= modifiedMaximumRange(unit, item, this.gameRef);
      });
  }

  /**
   * Python PrimaryAI.compute_priority: item ai_priority hooks plus, for a
   * damaging item against an enemy, default_priority, each scaled by the
   * target's ai_priority_multiplier. Splash targets add their hook value and
   * a lethality x accuracy term (3 when certainly lethal), positive for
   * enemies and negative for allies. Only legal behaviour targets count.
   */
  private computePrimaryPriority(
    unit: UnitObject,
    item: ItemObject,
    targetPos: [number, number],
    move: [number, number],
    origin: [number, number],
    behaviourTargets: UnitObject[],
    offenseBias: number,
  ): number {
    let tp = 0;
    const targetSystem = this.gameRef?.targetSystem;
    const affected: { mainTarget: [number, number] | null; splash: [number, number][] } =
      targetSystem
        ? targetSystem.getTargetFromPosition(unit, item, targetPos)
        : { mainTarget: targetPos, splash: [] };
    const main = affected.mainTarget
      ? this.board.getUnit(affected.mainTarget[0], affected.mainTarget[1])
      : null;
    const damaging = itemHasDamage(item);
    if (main && behaviourTargets.includes(main)) {
      const aiPriority = this.itemAiPriority(unit, item, main, move);
      const multiplier = aiPriorityMultiplier(main, this.gameRef);
      if (aiPriority !== null) tp += aiPriority * multiplier;
      if (damaging && checkEnemy(unit, main, this.db)) {
        tp += this.defaultPriority(unit, item, main, move, origin, offenseBias) * multiplier;
      }
    }
    for (const splashPosition of affected.splash) {
      const splashTarget = this.board.getUnit(splashPosition[0], splashPosition[1]);
      if (!splashTarget || splashTarget === main || !behaviourTargets.includes(splashTarget)) continue;
      const aiPriority = this.itemAiPriority(unit, item, splashTarget, move);
      const multiplier = aiPriorityMultiplier(splashTarget, this.gameRef);
      if (aiPriority !== null) tp += aiPriority * multiplier;
      if (!damaging) continue;
      const accuracy = clamp01(this.predictedHit(unit, item, splashTarget) / 100);
      const lethality = clamp01(
        this.predictedDamage(unit, item, splashTarget) / Math.max(1, splashTarget.currentHp),
      );
      const priority = lethality * accuracy >= 1 ? 3 : lethality * accuracy;
      if (checkEnemy(unit, splashTarget, this.db)) tp += priority * multiplier;
      else if (checkAlly(unit, splashTarget, this.db)) tp -= priority * multiplier;
    }
    return tp;
  }

  /**
   * Python PrimaryAI.default_priority. Offense is 3 for a certain kill,
   * otherwise lethality x accuracy x attacks plus the crit increment;
   * defense subtracts the counter threat (target damage over the TARGET's
   * HP, as Python divides it), cut to 30% when the target cannot counter.
   * Attacks are compute_attack_phases (+ compute_blitzes on EOtF's fork)
   * times compute_multiattacks. Distance (weight 0.0001) only breaks ties.
   */
  private defaultPriority(
    unit: UnitObject,
    item: ItemObject,
    target: UnitObject,
    move: [number, number],
    origin: [number, number],
    offenseBias: number,
  ): number {
    const targetHp = Math.max(1, target.currentHp);
    const rawDamage = this.predictedDamage(unit, item, target);
    const critDamage = this.predictedCritDamage(unit, item, target, rawDamage);
    const lethality = clamp01(rawDamage / targetHp);
    const critLethality = clamp01(critDamage / targetHp);
    const accuracy = clamp01(this.predictedHit(unit, item, target) / 100);
    const critAccuracy = this.db.getConstant('crit', true)
      ? clamp01(computeCrit(unit, item, target, this.db, this.gameRef) / 100)
      : 0;

    const targetWeapon = getEquippedWeapon(target, this.db, this.gameRef);
    let targetDamage = targetWeapon
      ? clamp01(this.predictedDamage(target, targetWeapon, unit, 'defense', item) / targetHp)
      : 0;
    let targetAccuracy = targetWeapon
      ? clamp01(this.predictedHit(target, targetWeapon, unit, 'defense', item) / 100)
      : 0;
    if (!targetWeapon || !canCounterattack(unit, item, target, this.db, this.gameRef)) {
      targetDamage *= 0.3;
      targetAccuracy *= 0.3;
    }

    const doubles = canDouble(unit, item, target, targetWeapon, this.db, this.gameRef);
    let numAttacks = 1 +
      computeExtraAttackPhases(unit, item, target, targetWeapon, 'attack', [0, 0], this.gameRef) +
      (doubles ? 1 : 0);
    if (isForkEngine()) {
      numAttacks += computeBlitzPhases(unit, item, target, targetWeapon, 'attack', [0, 0], this.gameRef);
    }
    numAttacks *= computeStrikeCount(unit, item, target, targetWeapon, 'attack', [0, 0], this.gameRef);
    const firstStrike = lethality >= 1 ? lethality * accuracy : 0;
    if (numAttacks > 1 && targetDamage >= 1) {
      numAttacks -= targetAccuracy * (1 - firstStrike);
    }

    let offenseTerm = lethality * accuracy >= 1 ? 3 : lethality * accuracy * numAttacks;
    offenseTerm += (critLethality - lethality) * critAccuracy * accuracy * numAttacks;
    const defenseTerm = 1 - targetDamage * targetAccuracy * (1 - firstStrike);
    if (offenseTerm <= 0) {
      const zeroHit = accuracy <= 0 && this.db.getConstant('attack_zero_hit', true);
      const zeroDam = lethality <= 0 && this.db.getConstant('attack_zero_dam', true);
      if (!zeroHit && !zeroDam) return 0;
    }

    const maxDistance = unit.getMovement();
    const distanceTerm = maxDistance > 0
      ? (maxDistance - this.distance(move, origin)) / maxDistance
      : 1;
    const offenseWeight = offenseBias * (1 / (offenseBias + 1));
    const defenseWeight = 1 - offenseWeight;
    return processTerms([
      [offenseTerm, offenseWeight],
      [defenseTerm, defenseWeight],
      [distanceTerm, 0.0001],
    ]);
  }

  /**
   * Python item_system.ai_priority: the sum of every item component's
   * ai_priority hook, or null when the item defines none.
   */
  private itemAiPriority(
    unit: UnitObject,
    item: ItemObject,
    target: UnitObject,
    move: [number, number],
  ): number | null {
    let total = 0;
    let defined = false;
    const add = (value: number): void => {
      defined = true;
      total += value;
    };
    if (item.hasComponent('no_ai')) add(-1);
    const single = ['status_on_hit', 'status_after_combat_on_hit', 'status_after_combat_on_hit_foe_only'];
    for (const component of single) {
      const nid = item.getComponent<unknown>(component);
      if (item.hasComponent(component)) add(this.aiStatusPriority(unit, target, item, move, nid));
    }
    if (item.hasComponent('self_status_on_hit')) {
      add(this.aiStatusPriority(unit, unit, item, move, item.getComponent('self_status_on_hit')));
    }
    for (const component of ['statuses_on_hit', 'statuses_after_combat_on_hit']) {
      if (!item.hasComponent(component)) continue;
      const nids = item.getComponent<unknown>(component);
      add((Array.isArray(nids) ? nids : []).reduce<number>(
        (sum, nid) => sum + this.aiStatusPriority(unit, target, item, move, nid), 0,
      ));
    }
    if (item.hasComponent('stacks_on_hit')) {
      const value = item.getComponent<unknown>('stacks_on_hit');
      const nid = value instanceof Map
        ? value.get('skill')
        : (value as Record<string, unknown> | null)?.skill;
      add(this.aiStatusPriority(unit, target, item, move, nid ?? 'Canto'));
    }
    if (item.hasComponent('buff_ally')) {
      add(this.aiStatusPriorityBuff(unit, target, item, move, item.getComponent('buff_ally')));
    }
    for (const component of ['heal', 'equation_heal', 'heal_no_target_restrict', 'eval_heal']) {
      if (!item.hasComponent(component)) continue;
      add(checkAlly(unit, target, this.db) ? this.computeHealPriority(unit, item, target) : 0);
    }
    for (const component of ['steal', 'gba_steal', 'steal_con', 'gimme_that', 'thief_staff']) {
      if (!item.hasComponent(component)) continue;
      const enemies = this.getEnemies(unit).map((enemy) => enemy.position!);
      if (enemies.length === 0) {
        add(0.075);
        continue;
      }
      const averageX = enemies.reduce((sum, position) => sum + position[0], 0) / enemies.length;
      const averageY = enemies.reduce((sum, position) => sum + position[1], 0) / enemies.length;
      add(0.075 + 0.01 * (Math.abs(move[0] - averageX) + Math.abs(move[1] - averageY)));
    }
    return defined ? total : null;
  }

  /**
   * Python hit_components.ai_status_priority. Its "num_attacks" is
   * combat_calcs.outspeed, i.e. 0 or 1, so a status item only scores
   * accuracy when the attacker doubles.
   */
  private aiStatusPriority(
    unit: UnitObject,
    target: UnitObject,
    item: ItemObject,
    move: [number, number],
    statusNid: unknown,
  ): number {
    if (typeof statusNid !== 'string' || target.skills.some((skill) => skill.nid === statusNid)) {
      return 0;
    }
    const outspeed = this.statusOutspeed(unit, item, target);
    const accuracyTerm = clamp01(this.predictedHit(unit, item, target) / 100) * outspeed;
    const distanceTerm = target.position ? 0.01 * this.distance(move, target.position) : 0;
    return checkEnemy(unit, target, this.db)
      ? 0.5 * accuracyTerm + distanceTerm
      : -0.5 * accuracyTerm;
  }

  /** EOtF custom ai_status_priority_buff (buff_ally). */
  private aiStatusPriorityBuff(
    unit: UnitObject,
    target: UnitObject,
    item: ItemObject,
    move: [number, number],
    statusNid: unknown,
  ): number {
    if (typeof statusNid !== 'string' || target.skills.some((skill) => skill.nid === statusNid)) {
      return 0;
    }
    const outspeed = this.statusOutspeed(unit, item, target);
    const accuracyTerm = clamp01(this.predictedHit(unit, item, target) / 100) * outspeed;
    const distanceTerm = target.position ? 0.01 * this.distance(move, target.position) : 0;
    return checkEnemy(unit, target, this.db)
      ? -0.5 * accuracyTerm + distanceTerm
      : 1 + 0.5 * accuracyTerm;
  }

  private statusOutspeed(unit: UnitObject, item: ItemObject, target: UnitObject): number {
    const targetWeapon = getEquippedWeapon(target, this.db, this.gameRef);
    return canDouble(unit, item, target, targetWeapon, this.db, this.gameRef) ? 1 : 0;
  }

  /** Damage one strike would deal, as the combat solver resolves it. */
  private predictedDamage(
    unit: UnitObject,
    item: ItemObject,
    target: UnitObject,
    mode: 'attack' | 'defense' = 'attack',
    targetItem: ItemObject | null = getEquippedWeapon(target, this.db, this.gameRef),
  ): number {
    const triangle = weaponTriangle(item, targetItem, this.db, unit, target);
    const damage = computeDamage(unit, item, target, this.db, this.board, this.gameRef, mode);
    return Math.max(0, damage + triangle.damageBonus);
  }

  /** Hit chance of one strike, as the combat solver resolves it. */
  private predictedHit(
    unit: UnitObject,
    item: ItemObject,
    target: UnitObject,
    mode: 'attack' | 'defense' = 'attack',
    targetItem: ItemObject | null = getEquippedWeapon(target, this.db, this.gameRef),
  ): number {
    const triangle = weaponTriangle(item, targetItem, this.db, unit, target);
    const hit = computeHit(unit, item, target, this.db, this.board, this.gameRef, mode);
    return Math.max(0, Math.min(100, hit + triangle.hitBonus));
  }

  /** Critical damage of one strike, mirroring the combat solver's crit path. */
  private predictedCritDamage(
    unit: UnitObject,
    item: ItemObject,
    target: UnitObject,
    damage: number,
  ): number {
    const context = { game: this.gameRef, item, target };
    const multiplierFormula = criticalMultiplierFormula(unit, context) ?? 'CRIT_MULT';
    const multiplierExpression = this.db.getEquation(multiplierFormula) ??
      (multiplierFormula === 'CRIT_MULT' ? '3' : multiplierFormula);
    const additionFormula = criticalAdditionFormula(unit, context) ?? 'CRIT_ADD';
    const additionExpression = this.db.getEquation(additionFormula) ??
      (additionFormula === 'CRIT_ADD' ? '0' : additionFormula);
    let crit = damage * Math.max(0, evaluateEquation(multiplierExpression, unit, { db: this.db, item }));
    crit += evaluateEquation(additionExpression, unit, { db: this.db, item });
    crit += modifyCritDamage(unit, item, this.gameRef);
    const targetWeapon = getEquippedWeapon(target, this.db, this.gameRef);
    crit += dynamicCritDamageAddition(
      unit, item, target, targetWeapon, 'attack', [0, 0], crit, this.gameRef,
    );
    return Math.max(0, crit);
  }

  private withCombatArt(
    unit: UnitObject,
    option: CombatArtOption | undefined,
    callback: () => void,
  ): void {
    if (!option) {
      callback();
      return;
    }
    const prefab = this.db.skills.get(option.childNid);
    if (!prefab) return;
    const child = new SkillObject(prefab);
    child.data.set(COMBAT_ART_SOURCE, option.skill);
    const oldActive = option.skill.data.get('active');
    option.skill.data.set('active', true);
    unit.skills.push(child);
    try {
      callback();
    } finally {
      const index = unit.skills.indexOf(child);
      if (index >= 0) unit.skills.splice(index, 1);
      if (oldActive === undefined) option.skill.data.delete('active');
      else option.skill.data.set('active', oldActive);
    }
  }

  /** Match Python PrimaryAI.quick_move while evaluating move-dependent hooks. */
  private withTemporaryPosition<T>(
    unit: UnitObject,
    position: [number, number],
    callback: () => T,
  ): T {
    if (!unit.position ||
        (unit.position[0] === position[0] && unit.position[1] === position[1])) {
      return callback();
    }
    const origin: [number, number] = [unit.position[0], unit.position[1]];
    this.board.moveUnit(unit, position[0], position[1]);
    try {
      return callback();
    } finally {
      this.board.moveUnit(unit, origin[0], origin[1]);
    }
  }

  // ====================================================================
  // Support AI: Healing items and staves
  // ====================================================================

  /**
   * Gather all items the AI can use for healing/support:
   * - Staves (spell + target_ally + has uses)
   * - Consumable healing items (usable/heal + has uses)
   * Excludes items with the no_ai component.
   */
  private getSupportItems(unit: UnitObject): ItemObject[] {
    const items: ItemObject[] = [];
    for (const item of unit.items) {
      if (item.hasNoAI()) continue;
      if (!itemAvailable(unit, item, this.db, this.gameRef)) continue;

      // Staves: spell/magic items that target allies and can heal
      if ((item.isSpell() || item.hasComponent('weapon_type')) && item.targetsAllies() && item.canHeal()) {
        items.push(item);
        continue;
      }

      if ((item.isSpell() || item.hasComponent('weapon_type')) &&
          item.targetsAllies() && this.itemStatusNids(item).length > 0) {
        items.push(item);
        continue;
      }

      // Consumable healing items (Vulnerary, Elixir, etc.)
      if (item.isHealing() && !item.isWeapon()) {
        items.push(item);
        continue;
      }
    }
    return items;
  }

  private itemStatusNids(item: ItemObject): string[] {
    const result: string[] = [];
    const add = (value: unknown): void => {
      if (typeof value === 'string') result.push(value);
    };
    add(item.getComponent('buff_ally'));
    add(item.getComponent('status_after_combat_on_hit_foe_only'));
    const statuses = item.getComponent<unknown>('statuses_after_combat_on_hit');
    if (Array.isArray(statuses)) statuses.forEach(add);
    for (const component of ['stacks_on_hit', 'self_stacks_on_hit']) {
      const value = item.getComponent<unknown>(component);
      if (!value || typeof value !== 'object') continue;
      add(value instanceof Map
        ? value.get('skill')
        : (value as Record<string, unknown>).skill);
    }
    return [...new Set(result)];
  }

  private computeStatusPriority(
    unit: UnitObject,
    item: ItemObject,
    target: UnitObject,
    move: [number, number],
  ): number {
    const missing = this.itemStatusNids(item).filter(
      (nid) => !target.skills.some((skill) => skill.nid === nid),
    );
    if (missing.length === 0) return 0;
    const accuracy = item.hasComponent('hit')
      ? Math.min(1, Math.max(0, computeHit(
        unit, item, target, this.db, this.board, this.gameRef,
      ) / 100))
      : 1;
    const defenderWeapon = getEquippedWeapon(target, this.db, this.gameRef);
    const attacks = 1 + (canDouble(
      unit, item, target, defenderWeapon, this.db, this.gameRef,
    ) ? 1 : 0);
    const distance = target.position ? this.distance(move, target.position) : 0;
    return checkEnemy(unit, target, this.db)
      ? -0.5 * accuracy * attacks + 0.01 * distance
      : 1 + 0.5 * accuracy * attacks + 0.01 * distance;
  }

  /**
   * Primary AI for Support behavior: evaluate healing item use.
   * For each healing item × target × valid move position, compute heal priority.
   * Handles both staves (ranged, targets allies) and consumables (self-heal).
   *
   * Matches Python's PrimaryAI logic: items with target_ally use
   * item_system.ai_priority() which dispatches to Heal.ai_priority().
   */
  private supportPrimaryAI(
    unit: UnitObject,
    validMoves: [number, number][],
    targets: UnitObject[],
    selfDamaged: boolean,
  ): AIAction | null {
    if (validMoves.length === 0) return null;

    const items = this.getSupportItems(unit);
    if (items.length === 0) return null;

    let bestPriority = 0; // Must exceed 0 to be worth doing
    let bestAction: AIAction | null = null;

    for (const item of items) {
      const isStaff = item.isSpell() ||
        (item.targetsAllies() && item.getMaxRange(unit, this.gameRef) > 0);
      const isSelfHeal = !isStaff && item.isHealing();

      if (isStaff) {
        // Staff: evaluate against each ally target from each valid position
        for (const target of targets) {
          if (target.isDead() || !target.position) continue;
          const statusPriorityAvailable = this.computeStatusPriority(
            unit,
            item,
            target,
            validMoves[0],
          ) > 0;
          // Pure healing staves still require missing HP; status staves do not.
          if (target.currentHp >= target.maxHp && !statusPriorityAvailable) continue;

          const attackPositions = this.getAttackPositions(unit, validMoves, target, item);

          for (const pos of attackPositions) {
            const priority = Math.max(
              this.computeHealPriority(unit, item, target),
              this.computeStatusPriority(unit, item, target, pos),
            );
            if (priority > bestPriority) {
              bestPriority = priority;
              const path = unit.position
                ? this.pathSystem.getPath(unit, pos[0], pos[1], this.board)
                : null;

              bestAction = {
                type: 'attack', // Staves go through combat system
                unit,
                targetPosition: pos,
                targetUnit: target,
                item,
                movePath: path ?? [pos],
              };
            }
          }
        }
      } else if (isSelfHeal && selfDamaged) {
        // Consumable self-heal: can use from any valid move position
        // Python's range-0 hack: items with range 0 add all valid moves as
        // potential target positions, allowing self-heal from any reachable spot.
        // Pick the safest position (farthest from enemies).
        const enemies = this.getEnemies(unit);
        const priority = this.computeHealPriority(unit, item, unit);

        if (priority > bestPriority) {
          // Find the safest position to use the item from
          let safestPos = validMoves[0];
          let bestMinDist = -1;

          for (const pos of validMoves) {
            let minDistToEnemy = Infinity;
            for (const enemy of enemies) {
              if (!enemy.position) continue;
              minDistToEnemy = Math.min(minDistToEnemy, this.distance(pos, enemy.position));
            }
            if (minDistToEnemy > bestMinDist) {
              bestMinDist = minDistToEnemy;
              safestPos = pos;
            }
          }

          bestPriority = priority;
          const path = unit.position
            ? this.pathSystem.getPath(unit, safestPos[0], safestPos[1], this.board)
            : null;

          bestAction = {
            type: 'use_item', // Consumables bypass combat system
            unit,
            targetPosition: safestPos,
            targetUnit: unit, // Self-target
            item,
            movePath: path ?? [safestPos],
          };
        }
      }
    }

    return bestAction;
  }

  /**
   * Compute heal priority for an AI unit using a healing item on a target.
   * Matches Python's Heal.ai_priority():
   *   help_term = clamp(missing_health / max_hp, 0, 1)
   *   heal_term = clamp(min(heal_amount, missing_health) / max_hp, 0, 1)
   *   priority = help_term * heal_term
   *
   * Higher priority = ally is more injured AND the heal covers more of the gap.
   */
  private computeHealPriority(
    unit: UnitObject,
    item: ItemObject,
    target: UnitObject,
  ): number {
    const maxHp = target.maxHp;
    if (maxHp <= 0) return 0;

    const missingHealth = maxHp - target.currentHp;
    if (missingHealth <= 0) return 0;

    const helpTerm = Math.min(1, Math.max(0, missingHealth / maxHp));

    // Get heal amount — for staves, pass the caster's MAG stat
    const healAmount = itemHealAmount(unit, item, target, this.gameRef) ??
      item.getHealAmount(unit.getStatValue('MAG') ?? unit.getStatValue('STR') ?? 0);
    const effectiveHeal = Math.min(healAmount, missingHealth);
    const healTerm = Math.min(1, Math.max(0, effectiveHeal / maxHp));

    return helpTerm * healTerm;
  }

  // ====================================================================
  // Smart retreat (Move_away_from)
  // ====================================================================

  /**
   * Python AIController.smart_retreat: keep the targets strictly inside the
   * view-range limit (zero/single/double move or the literal range), and if
   * any remain and the unit has more than one tile to choose from, go to
   * utils.smart_farthest_away_pos -- the tile whose offset has the largest
   * dot product with the distance-weighted "away from the targets" vector.
   * Choosing the unit's own tile still ends the AI (the unit waits); only
   * when there is nothing to flee from does the next behaviour run.
   */
  private smartRetreat(
    unit: UnitObject,
    validMoves: [number, number][],
    behaviour: AiBehavior,
  ): AIAction | null {
    const start = unit.position;
    if (!start || validMoves.length === 0) return null;

    const zeroMove = this.getMaxItemRange(unit);
    const singleMove = zeroMove + unit.getMovement();
    const doubleMove = singleMove + unit.getMovement();
    const viewRange = behaviour.view_range;
    const limit = viewRange === -4 ? Infinity
      : viewRange === -3 ? doubleMove
        : viewRange === -2 ? singleMove
          : viewRange === -1 ? zeroMove
            : viewRange;
    const threats: Array<[[number, number], number]> = [];
    for (const position of this.unitPositions(this.getTargets(unit, behaviour))) {
      const magnitude = this.distance(start, position);
      // A zero magnitude would divide by zero in Python; it cannot be fled.
      if (magnitude > 0 && magnitude < limit) threats.push([position, magnitude]);
    }
    if (threats.length === 0 || validMoves.length <= 1) return null;

    const best = smartFarthestAwayPos(start, validMoves, threats);
    if (!best || (best[0] === start[0] && best[1] === start[1])) {
      return { type: 'wait', unit };
    }
    const movePath = this.pathSystem.getPath(unit, best[0], best[1], this.board);
    return {
      type: 'move',
      unit,
      targetPosition: best,
      movePath: movePath ?? [start, best],
    };
  }


  // ====================================================================
  // Helpers
  // ====================================================================

  /**
   * Get all valid attack positions for a unit against a specific target.
   * Returns positions in validMoves that are within the weapon's range of the target.
   */
  private getAttackPositions(
    unit: UnitObject,
    validMoves: [number, number][],
    target: UnitObject,
    item: ItemObject,
  ): [number, number][] {
    const targetPos = target.position;
    if (!targetPos) return [];

    const positions: [number, number][] = [];

    for (const move of validMoves) {
      const targetSystem = this.gameRef?.targetSystem;
      if (targetSystem) {
        const targets: [number, number][] = this.withTemporaryPosition(
          unit,
          move,
          () => targetSystem.getValidTargetsRecursive(unit, item, move),
        );
        if (targets.some(([x, y]) => x === targetPos[0] && y === targetPos[1])) {
          positions.push(move);
        }
        continue;
      }
      const dist = this.distance(move, targetPos);
      if (dist >= modifiedMinimumRange(unit, item, this.gameRef) &&
          dist <= modifiedMaximumRange(unit, item, this.gameRef)) positions.push(move);
    }

    return positions;
  }

  /**
   * Get all enemies of this unit.
   */
  private getEnemies(unit: UnitObject): UnitObject[] {
    return this.board.getAllUnits().filter((other) => {
      if (other === unit) return false;
      if (other.isDead()) return false;
      if (!other.position) return false;
      return checkEnemy(unit, other, this.db);
    });
  }

  /**
   * Get all allies of this unit (same team / allied teams).
   */
  private getAllies(unit: UnitObject): UnitObject[] {
    return this.board.getAllUnits().filter((other) => {
      if (other === unit) return false;
      if (other.isDead()) return false;
      if (!other.position) return false;
      return checkAlly(unit, other, this.db);
    });
  }

  /**
   * Manhattan distance between two positions.
   */
  private distance(a: [number, number], b: [number, number]): number {
    return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]);
  }

  // =========================================================================
  // AI Group Activation
  // =========================================================================

  /**
   * Check if a player unit at the given position triggers activation of any
   * AI group. A group activates when a player unit is within the detection
   * range (move + max weapon range) of any inactive group member.
   */
  checkGroupActivation(
    playerPos: [number, number],
    game: { isAiGroupActive(g: string): boolean; activateAiGroup(g: string): void },
  ): void {
    const allUnits = this.board.getAllUnits();
    for (const enemy of allUnits) {
      if (enemy.isDead() || !enemy.position) continue;
      if (!enemy.aiGroup || enemy.aiGroup === '') continue;
      if (enemy.team === 'player') continue;
      if (game.isAiGroupActive(enemy.aiGroup)) continue;

      // Detection range: movement + max weapon range
      const mov = enemy.getStatValue('MOV');
      const maxRange = this.getMaxItemRange(enemy);
      const detectionRange = mov + maxRange;

      if (this.distance(enemy.position, playerPos) <= detectionRange) {
        game.activateAiGroup(enemy.aiGroup);
      }
    }
  }

  /**
   * Activate the group of a unit that was involved in combat.
   */
  activateGroupOnCombat(
    unit: UnitObject,
    game: { activateAiGroup(g: string): void },
  ): void {
    if (unit.aiGroup && unit.aiGroup !== '') {
      game.activateAiGroup(unit.aiGroup);
    }
  }

}

/** Python utils.process_terms: weighted average of (value, weight) pairs. */
function processTerms(terms: Array<[number, number]>): number {
  const weightSum = terms.reduce((sum, [, weight]) => sum + weight, 0);
  if (weightSum <= 0) return 0;
  return terms.reduce((sum, [value, weight]) => sum + value * weight, 0) / weightSum;
}

function clamp01(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}

/** Python `item_system.damage(unit, item) is not None`. */
function itemHasDamage(item: ItemObject): boolean {
  return ['damage', 'damage_any', 'eval_damage', 'eval_damage_any', 'equation_damage']
    .some((component) => item.hasComponent(component));
}

function manhattan(a: readonly [number, number], b: readonly [number, number]): number {
  return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]);
}

/**
 * Python utils.farthest_away_pos: the move farthest from the average enemy
 * position, then closest to `position`. Python takes the last of a stable
 * sort over a set, so full ties resolve by set order; here the last tied
 * move in list order wins.
 */
export function farthestAwayPos(
  position: [number, number],
  validMoves: [number, number][],
  enemyPositions: [number, number][],
): [number, number] | null {
  if (validMoves.length === 0 || enemyPositions.length === 0) return null;
  const average: [number, number] = [
    enemyPositions.reduce((sum, pos) => sum + pos[0], 0) / enemyPositions.length,
    enemyPositions.reduce((sum, pos) => sum + pos[1], 0) / enemyPositions.length,
  ];
  let best: [number, number] | null = null;
  let bestAway = -Infinity;
  let bestNear = Infinity;
  for (const move of validMoves) {
    const away = manhattan(average, move);
    const near = manhattan(position, move);
    if (away > bestAway || (away === bestAway && near <= bestNear)) {
      best = move;
      bestAway = away;
      bestNear = near;
    }
  }
  return best;
}

/**
 * Python utils.smart_farthest_away_pos: average the unit-to-threat offsets,
 * each divided by its distance, and pick the move whose offset has the
 * largest dot product with that "away" vector (last tied move wins).
 */
export function smartFarthestAwayPos(
  position: [number, number],
  validMoves: [number, number][],
  threats: Array<[[number, number], number]>,
): [number, number] | null {
  if (validMoves.length === 0 || threats.length === 0) return null;
  let awayX = 0;
  let awayY = 0;
  for (const [pos, magnitude] of threats) {
    awayX += (position[0] - pos[0]) / magnitude;
    awayY += (position[1] - pos[1]) / magnitude;
  }
  awayX /= threats.length;
  awayY /= threats.length;
  let best: [number, number] | null = null;
  let bestDot = -Infinity;
  for (const move of validMoves) {
    const dot = (move[0] - position[0]) * awayX + (move[1] - position[1]) * awayY;
    if (dot >= bestDot) {
      best = move;
      bestDot = dot;
    }
  }
  return best;
}
