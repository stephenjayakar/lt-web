import type { Database } from '../data/database';
import type { ItemObject } from '../objects/item';
import type { GameBoard } from '../objects/game-board';
import type { UnitObject } from '../objects/unit';
import { evaluateEquation } from '../combat/combat-calcs';
import { getLine } from './line-of-sight';
import {
  validTargets,
  rangeRestrict,
  targetRestrict,
  splash,
  numTargets,
  allowSameTarget,
  allowLessThanMaxTargets,
  ignoreLineOfSight,
  allowTargetInFogOfWar,
  type SplashResult,
  type TargetPosition,
} from '../combat/item-system';

function positionKey(position: TargetPosition): string {
  return `${position[0]},${position[1]}`;
}

/**
 * Resolves component-provided targets into positions the item can reach.
 * This is the web counterpart to Python's TargetSystem target discovery.
 */
export class TargetSystem {
  private db: Database;
  private board: GameBoard;
  private game: any;

  constructor(db: Database, board: GameBoard, game?: any) {
    this.db = db;
    this.board = board;
    this.game = game;
  }

  /** Component hook results before range and other positional filtering. */
  getComponentTargets(unit: UnitObject, item: ItemObject): TargetPosition[] {
    return validTargets(unit, item, this.board, this.db);
  }

  /** Valid target positions from the unit's current (or supplied) origin. */
  getValidTargets(
    unit: UnitObject,
    item: ItemObject,
    origin: TargetPosition | null = unit.position,
  ): TargetPosition[] {
    if (!origin) return [];

    const minRange = item.getMinRange();
    let maxRange = item.hasComponent('global_range') ? 99 : item.getMaxRange();
    const rangeEquation = item.getComponent<string>('max_equation_range');
    if (rangeEquation) {
      const expression = this.db.getEquation(rangeEquation) ?? rangeEquation;
      maxRange = evaluateEquation(expression, unit, { db: this.db, item });
    }
    const relativeRestriction = rangeRestrict(unit, item, maxRange);
    const targets = this.getComponentTargets(unit, item).filter((position) => {
      const distance = Math.abs(position[0] - origin[0]) + Math.abs(position[1] - origin[1]);
      if (distance < minRange || distance > maxRange) return false;
      if (relativeRestriction &&
          !relativeRestriction.has(`${position[0] - origin[0]},${position[1] - origin[1]}`)) {
        return false;
      }
      if (this.db.getConstant('line_of_sight', false) && !ignoreLineOfSight(unit, item) &&
          !getLine(origin, position, (candidate) => this.board.getOpacity(candidate))) {
        return false;
      }

      const affected = this.getTargetFromPosition(unit, item, position);
      if (!affected.mainTarget && affected.splash.length === 0) return false;
      return targetRestrict(unit, item, position, affected.splash, {
        board: this.board,
        db: this.db,
        game: this.game,
      });
    });

    if (!allowSameTarget(unit, item) && !allowLessThanMaxTargets(unit, item) &&
        targets.length < numTargets(unit, item)) {
      return [];
    }
    return targets;
  }

  /** Expand splash components and apply targeting fog to every affected tile. */
  getTargetFromPosition(
    unit: UnitObject,
    item: ItemObject,
    position: TargetPosition,
  ): SplashResult {
    const result = splash(unit, item, position, {
      board: this.board,
      db: this.db,
      evaluateRangeEquation: (equationNid) => {
        const expression = this.db.getEquation(equationNid) ?? equationNid;
        return evaluateEquation(expression, unit, { db: this.db, item });
      },
    });

    const fogInfo = this.game?.getCurrentFogInfo?.();
    const fogApplies = !!fogInfo &&
      (unit.team === 'player' || this.db.getConstant('ai_fog_of_war', false)) &&
      !allowTargetInFogOfWar(unit, item);
    if (!fogApplies) return result;

    const visible = (candidate: TargetPosition): boolean => {
      if (candidate[0] === unit.position?.[0] && candidate[1] === unit.position?.[1]) return true;
      const target = this.board.getUnit(candidate[0], candidate[1]);
      if (target?.tags.includes('Tile')) return true;
      return this.board.inVision(
        candidate,
        unit.team,
        fogInfo,
        this.db,
        this.game?.getAllUnits?.() ?? this.board.getAllUnits(),
      );
    };

    return {
      mainTarget: result.mainTarget && visible(result.mainTarget) ? result.mainTarget : null,
      splash: result.splash.filter(visible),
    };
  }

  /**
   * Union targets across a multi-item tree. Sequence items require every child
   * to have at least one target, matching the Python target-system guard.
   */
  getValidTargetsRecursive(
    unit: UnitObject,
    item: ItemObject,
    origin: TargetPosition | null = unit.position,
  ): TargetPosition[] {
    if (item.subitems.length === 0) return this.getValidTargets(unit, item, origin);

    const merged = new Map<string, TargetPosition>();
    let requiredTargets = 0;
    for (const subitem of item.subitems) {
      const childTargets = this.getValidTargetsRecursive(unit, subitem, origin);
      if (item.hasComponent('sequence_item') && childTargets.length === 0) return [];
      if (item.hasComponent('sequence_item')) {
        requiredTargets += allowLessThanMaxTargets(unit, subitem) ? 1 : numTargets(unit, subitem);
      }
      for (const position of childTargets) merged.set(positionKey(position), position);
    }

    if (item.hasComponent('sequence_item') && !allowSameTarget(unit, item) &&
        merged.size < requiredTargets) {
      return [];
    }

    // Parent components such as Rescue's target_tile also contribute.
    for (const position of this.getValidTargets(unit, item, origin)) {
      merged.set(positionKey(position), position);
    }
    return [...merged.values()];
  }

  /** Resolve valid positions back to live units for combat-style targeting. */
  getValidUnitTargets(
    unit: UnitObject,
    item: ItemObject,
    origin: TargetPosition | null = unit.position,
  ): UnitObject[] {
    const targets: UnitObject[] = [];
    for (const [x, y] of this.getValidTargetsRecursive(unit, item, origin)) {
      const target = this.board.getUnit(x, y);
      if (target && !targets.includes(target)) targets.push(target);
    }
    return targets;
  }
}
