// ---------------------------------------------------------------------------
// AIController -- Decides actions for AI-controlled units.
// Implements LT's AI system with primary (attack) and secondary (move toward)
// behaviors, evaluated per-unit based on the AiDef from the database.
// ---------------------------------------------------------------------------

import type { UnitObject } from '../objects/unit';
import type { ItemObject } from '../objects/item';
import type { GameBoard } from '../objects/game-board';
import type { Database } from '../data/database';
import type { PathSystem } from '../pathfinding/path-system';
import {
  computeDamage,
  computeHit,
  computeCrit,
  canDouble,
  getEquippedWeapon,
} from '../combat/combat-calcs';

export interface AIAction {
  type: 'attack' | 'move' | 'wait';
  unit: UnitObject;
  targetPosition?: [number, number]; // position to move to
  targetUnit?: UnitObject; // unit to attack
  item?: ItemObject; // weapon to use
  movePath?: [number, number][]; // path to follow
}

/**
 * AIController -- Decides actions for AI-controlled units.
 * Implements LT's AI system with primary (attack) and secondary (move toward)
 * behaviors.
 */
export class AIController {
  private db: Database;
  private board: GameBoard;
  private pathSystem: PathSystem;

  constructor(db: Database, board: GameBoard, pathSystem: PathSystem) {
    this.db = db;
    this.board = board;
    this.pathSystem = pathSystem;
  }

  /**
   * Determine the best action for an AI unit.
   * Behavior lookup from db.ai based on unit's ai NID.
   */
  getAction(unit: UnitObject): AIAction {
    const aiDef = this.db.ai.get(unit.ai);

    // Default: just wait if no AI definition found
    if (!aiDef) {
      return { type: 'wait', unit };
    }

    const validMoves = this.pathSystem.getValidMoves(unit, this.board);

    // Walk through behaviours in priority order.
    // The first behaviour whose action type succeeds is used.
    for (const behaviour of aiDef.behaviours) {
      const viewRange = behaviour.view_range;

      if (behaviour.action === 'attack') {
        // Guard mode (viewRange -1): only attack if enemy is already adjacent
        // For other view ranges, use primaryAI with visible enemies
        const action = this.primaryAI(unit, validMoves, viewRange, aiDef.offense_bias);
        if (action) return action;
      }

      if (behaviour.action === 'move_to' || behaviour.action === 'pursue') {
        // Guard mode: don't move
        if (viewRange === -1) continue;

        const action = this.secondaryAI(unit, validMoves, viewRange);
        if (action) return action;
      }
    }

    // Fallback: try primary then secondary with defaults
    const primaryAction = this.primaryAI(unit, validMoves, -4, aiDef.offense_bias);
    if (primaryAction) return primaryAction;

    const secondaryAction = this.secondaryAI(unit, validMoves, -4);
    if (secondaryAction) return secondaryAction;

    return { type: 'wait', unit };
  }

  /**
   * Primary AI: Find best attack target + position.
   * For each weapon, for each enemy in range, evaluate utility.
   */
  private primaryAI(
    unit: UnitObject,
    validMoves: [number, number][],
    viewRange: number,
    offenseBias: number,
  ): AIAction | null {
    if (validMoves.length === 0) return null;

    const enemies = this.getVisibleEnemies(unit, viewRange);
    if (enemies.length === 0) return null;

    // Gather all weapons the unit can use
    const weapons: ItemObject[] = [];
    for (const item of unit.items) {
      if (item.isWeapon()) {
        weapons.push(item);
      }
    }

    if (weapons.length === 0) return null;

    let bestUtility = -Infinity;
    let bestAction: AIAction | null = null;

    for (const weapon of weapons) {
      for (const enemy of enemies) {
        if (enemy.isDead()) continue;

        const attackPositions = this.getAttackPositions(validMoves, enemy, weapon);

        for (const pos of attackPositions) {
          const utility = this.evaluateAttackUtility(
            unit,
            weapon,
            enemy,
            pos,
            offenseBias,
          );

          if (utility > bestUtility) {
            bestUtility = utility;

            // Compute the path to the attack position
            const path = unit.position
              ? this.pathSystem.getPath(unit, pos[0], pos[1], this.board)
              : null;

            bestAction = {
              type: 'attack',
              unit,
              targetPosition: pos,
              targetUnit: enemy,
              item: weapon,
              movePath: path ?? [pos],
            };
          }
        }
      }
    }

    return bestAction;
  }

  /**
   * Secondary AI: Move toward nearest enemy if can't attack.
   * Uses A* to find paths to enemies, moves as close as possible.
   */
  private secondaryAI(
    unit: UnitObject,
    validMoves: [number, number][],
    viewRange: number,
  ): AIAction | null {
    if (validMoves.length === 0) return null;
    if (!unit.position) return null;

    const enemies = this.getVisibleEnemies(unit, viewRange);
    if (enemies.length === 0) return null;

    // Find the nearest enemy by path distance
    let bestPath: [number, number][] | null = null;
    let bestDist = Infinity;
    let nearestEnemy: UnitObject | null = null;

    for (const enemy of enemies) {
      if (enemy.isDead() || !enemy.position) continue;

      const path = this.pathSystem.getPath(
        unit,
        enemy.position[0],
        enemy.position[1],
        this.board,
      );

      if (path && path.length > 0) {
        // Path length approximates real distance (including terrain cost)
        const dist = path.length;
        if (dist < bestDist) {
          bestDist = dist;
          bestPath = path;
          nearestEnemy = enemy;
        }
      } else {
        // Fallback: use Manhattan distance if no path found
        const manhattanDist = this.distance(unit.position, enemy.position);
        if (manhattanDist < bestDist) {
          bestDist = manhattanDist;
          nearestEnemy = enemy;
          bestPath = null; // no valid path, but we track the enemy
        }
      }
    }

    if (!nearestEnemy) {
      return { type: 'wait', unit };
    }

    // If we have a path, use travelAlgorithm to find the best reachable position
    if (bestPath && bestPath.length > 1) {
      const moveTarget = this.pathSystem.travelAlgorithm(bestPath, unit, this.board);

      // Only move if the target is different from current position
      if (
        moveTarget[0] !== unit.position[0] ||
        moveTarget[1] !== unit.position[1]
      ) {
        // Get the sub-path to the move target
        const movePath = this.pathSystem.getPath(
          unit,
          moveTarget[0],
          moveTarget[1],
          this.board,
        );

        return {
          type: 'move',
          unit,
          targetPosition: moveTarget,
          targetUnit: nearestEnemy,
          movePath: movePath ?? [unit.position, moveTarget],
        };
      }
    }

    // Can't move any closer -- just wait
    return { type: 'wait', unit };
  }

  /**
   * Evaluate attack utility for choosing best target.
   * Higher utility = better attack choice.
   * Factors: lethality, accuracy, damage dealt, risk taken.
   */
  private evaluateAttackUtility(
    unit: UnitObject,
    item: ItemObject,
    target: UnitObject,
    attackPosition: [number, number],
    offenseBias: number,
  ): number {
    // --- Offense ---
    const expectedDamage = computeDamage(unit, item, target, this.db);
    const targetHP = Math.max(1, target.currentHp);
    const lethality = Math.min(1.0, expectedDamage / targetHP);

    const hitChance = computeHit(unit, item, target, this.db);
    const accuracy = hitChance / 100;

    const defenderWeapon = getEquippedWeapon(target);
    const doubles = canDouble(unit, item, target, defenderWeapon, this.db);
    const numAttacks = 1 + (doubles ? 1 : 0);

    const critChance = computeCrit(unit, item, target, this.db);
    const critBonus = (critChance / 100) * 0.5;

    const offense = lethality * accuracy * numAttacks + critBonus;

    // --- Defense ---
    // Determine distance from attack position to target
    const targetPos = target.position;
    const dist = targetPos
      ? this.distance(attackPosition, targetPos)
      : 1;

    // Check if target has a weapon that can counter at this distance
    const counterWeapon = this.findCounterWeapon(target, dist);
    let defense: number;

    if (counterWeapon) {
      const targetDamage = computeDamage(target, counterWeapon, unit, this.db);
      const targetAccuracy = computeHit(target, counterWeapon, unit, this.db);
      const rawThreat = (targetDamage * targetAccuracy) / 100;
      const unitHP = Math.max(1, unit.currentHp);
      defense = 1 - Math.min(1.0, rawThreat / unitHP);
    } else {
      // Target can't counter-attack -- reduce defense penalty by 70%
      // (i.e. we're mostly safe, so defense factor is high)
      const estimatedThreat = defenderWeapon
        ? (computeDamage(target, defenderWeapon, unit, this.db) *
            computeHit(target, defenderWeapon, unit, this.db)) / 100
        : 0;
      const unitHP = Math.max(1, unit.currentHp);
      defense = 1 - (Math.min(1.0, estimatedThreat / unitHP) * 0.3);
    }

    // --- Distance factor ---
    // Slight preference for closer attack positions (less movement = less risk)
    const unitPos = unit.position ?? attackPosition;
    const movementDistance = this.distance(unitPos, attackPosition);
    const distanceFactor = 1 / (1 + movementDistance * 0.1);

    // --- Final utility ---
    const utility =
      offense * offenseBias +
      defense * (2 - offenseBias) +
      distanceFactor * 0.1;

    return utility;
  }

  /**
   * Get all valid attack positions for a unit against a specific target.
   * Returns positions in validMoves that are within the weapon's range of the target.
   */
  private getAttackPositions(
    validMoves: [number, number][],
    target: UnitObject,
    item: ItemObject,
  ): [number, number][] {
    const targetPos = target.position;
    if (!targetPos) return [];

    const minRange = item.getMinRange();
    const maxRange = item.getMaxRange();
    const positions: [number, number][] = [];

    for (const move of validMoves) {
      const dist = this.distance(move, targetPos);
      if (dist >= minRange && dist <= maxRange) {
        positions.push(move);
      }
    }

    return positions;
  }

  /**
   * Get all enemies visible to this unit.
   * Filter by view range:
   *   -1 = guard mode (only enemies adjacent to current position)
   *   -3 = enemies within 2x unit's MOV stat
   *   -4 = all enemies on the map
   *   >0 = enemies within that many tiles
   */
  private getVisibleEnemies(unit: UnitObject, viewRange: number): UnitObject[] {
    const allUnits = this.board.getAllUnits();
    const unitPos = unit.position;

    // Filter to enemies only (not same team and not allied)
    const enemies = allUnits.filter((other) => {
      if (other === unit) return false;
      if (other.isDead()) return false;
      if (!other.position) return false;
      return !this.db.areAllied(unit.team, other.team);
    });

    // Apply view range filter
    if (viewRange === -4) {
      // Infinite view range: return all enemies
      return enemies;
    }

    if (!unitPos) return [];

    if (viewRange === -1) {
      // Guard mode: only enemies adjacent (Manhattan distance 1)
      return enemies.filter((enemy) => {
        return this.distance(unitPos, enemy.position!) === 1;
      });
    }

    if (viewRange === -3) {
      // Double movement range
      const movRange = unit.getStatValue('MOV') * 2;
      return enemies.filter((enemy) => {
        return this.distance(unitPos, enemy.position!) <= movRange;
      });
    }

    // Positive view range: enemies within that many tiles
    if (viewRange > 0) {
      return enemies.filter((enemy) => {
        return this.distance(unitPos, enemy.position!) <= viewRange;
      });
    }

    // Fallback: all enemies
    return enemies;
  }

  /**
   * Find a weapon on the defender that can counter at the given distance.
   * Returns the first matching weapon, or null.
   */
  private findCounterWeapon(defender: UnitObject, dist: number): ItemObject | null {
    for (const item of defender.items) {
      if (!item.isWeapon()) continue;
      if (dist >= item.getMinRange() && dist <= item.getMaxRange()) {
        return item;
      }
    }
    return null;
  }

  /**
   * Manhattan distance between two positions.
   */
  private distance(a: [number, number], b: [number, number]): number {
    return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]);
  }
}
