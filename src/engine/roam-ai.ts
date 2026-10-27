/**
 * roam-ai.ts — Python `roam/free_roam_ai.py` (FreeRoamAIHandler, RoamAI).
 *
 * Units whose roam AI (`change_roam_ai`) names a `roam_ai` AI definition
 * walk on their own while the player roams: each behaviour in turn (whose
 * condition holds) waits, moves to / away from its targets, or walks to an
 * event region and fires it. Movement uses RoamAIMovementComponent along a
 * ThetaStar path, recalculated every 333 ms. EOtF uses it for the hub's
 * secret follower (`change_roam_ai;the_follower;Follow_Player`, which
 * follows the unit tagged Roamer).
 *
 * Python's handler never applies the behaviour's roam_speed in the fork
 * (upstream added `set_speed` later), so the fork walks at speed 1.
 */

import type { UnitObject } from '../objects/unit';
import type { AiBehavior } from '../data/types';
import { RoamAIMovementComponent, getRoamPosition } from '../movement/roam-movement';
import { evaluateCondition } from '../events/event-manager';
import { available as itemAvailable, maximumRange } from '../combat/item-system';
import { smartFarthestAwayPos } from '../ai/ai-controller';
import { isForkEngine } from './engine-flavor';

const BASE_SPEED_DENOMINATOR = 100;
const RECALCULATE_TIME = 333; // ms

type Pos = [number, number];

type RoamAIState =
  | { type: 'move'; target: Pos; proximity: number }
  | { type: 'wait'; time: number }
  | { type: 'interact'; region: any; proximity: number };

function distance(a: readonly [number, number], b: readonly [number, number]): number {
  return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]);
}

function regionPositions(region: any): Pos[] {
  if (!region?.position) return [];
  const [rx, ry] = region.position;
  const [rw, rh] = region.size ?? [1, 1];
  const out: Pos[] = [];
  for (let x = rx; x < rx + rw; x++) for (let y = ry; y < ry + rh; y++) out.push([x, y]);
  return out;
}

function regionCenter(region: any): Pos {
  const [rw, rh] = region.size ?? [1, 1];
  return [Math.trunc(region.position[0] + Math.floor(rw / 2)), Math.trunc(region.position[1] + Math.floor(rh / 2))];
}

/** Python RoamAI. */
export class RoamAI {
  unit: UnitObject;
  state: RoamAIState | null = null;
  /** Python order: goal first, next waypoint last. */
  path: Pos[] = [];
  private behaviourIdx = 0;
  private behaviour: AiBehavior | null = null;
  speedMult = 1;
  private lastRecalculate: number;
  private game: any;

  constructor(unit: UnitObject, game: any, now: number) {
    this.unit = unit;
    this.game = game;
    this.lastRecalculate = now;
  }

  resetForNextBehaviour(): void {
    this.state = null;
    this.resetPath();
  }

  resetPath(): void {
    this.path = [];
  }

  private behaviours(): AiBehavior[] {
    return this.game.db.ai?.get?.(this.unit.roamAi)?.behaviours ?? [];
  }

  private setNextBehaviour(): void {
    const behaviours = this.behaviours();
    let counter = 0;
    this.behaviour = null;
    while (this.behaviourIdx < behaviours.length && counter < 99) {
      counter++;
      const next = behaviours[this.behaviourIdx];
      this.behaviourIdx++;
      if (this.behaviourIdx >= behaviours.length) this.behaviourIdx = 0;
      const condition = String(next.condition ?? '').trim();
      if (!condition || evaluateCondition(condition, {
        game: this.game,
        unit1: this.unit,
        position: this.unit.position ?? undefined,
        gameVars: this.game.gameVars,
        levelVars: this.game.levelVars,
      })) {
        this.behaviour = next;
        return;
      }
    }
    console.error(`No AI behaviour of ${this.unit.roamAi} with a valid condition was found`);
    this.behaviourIdx = 0;
  }

  private getPath(pos: Pos): Pos[] {
    if (!this.unit.position || !this.game.pathSystem || !this.game.board) return [];
    const path = this.game.pathSystem.getPath(this.unit, pos[0], pos[1], this.game.board, { freeMovement: true });
    return path ? [...path].reverse() as Pos[] : [];
  }

  /** Returns whether to try the next behaviour. */
  private calcState(now: number): boolean {
    const behaviour = this.behaviour!;
    const action = String(behaviour.action);
    if (action === 'None') return false;
    if (action === 'Wait') {
      const toWait = Number(behaviour.target_spec) || 0;
      this.state = { type: 'wait', time: now + toWait };
      return false;
    }
    if (action === 'Move_to') {
      const target = this.approach();
      if (target) this.state = { type: 'move', target, proximity: Number(behaviour.desired_proximity ?? 0) };
      return false;
    }
    if (action === 'Interact') {
      const region = this.findRegion();
      if (region) this.state = { type: 'interact', region, proximity: Number(behaviour.desired_proximity ?? 0) };
      return false;
    }
    if (action === 'Move_away_from') {
      const target = this.retreat();
      if (target) this.state = { type: 'move', target, proximity: Number(behaviour.desired_proximity ?? 0) };
      return false;
    }
    // A behaviour roaming does not support.
    return true;
  }

  think(now: number): void {
    let counter = 0;
    while (counter < 99) {
      counter++;
      this.setNextBehaviour();
      if (!this.behaviour) return;
      this.speedMult = Number(this.behaviour.roam_speed ?? 100) / BASE_SPEED_DENOMINATOR;
      if (!this.calcState(now)) return;
    }
    console.error(`Infinite loop detected in ${this.unit.nid}'s ${this.unit.roamAi} AI`);
  }

  private maxRange(): number {
    let best = 0;
    for (const item of this.unit.items) {
      try {
        if (!itemAvailable(this.unit, item, this.game.db, this.game)) continue;
        best = Math.max(best, maximumRange(this.unit, item, this.game) || 0);
      } catch {
        // Unusable item.
      }
    }
    return best;
  }

  private filteredTargets(): Array<[Pos, number]> {
    const behaviour = this.behaviour!;
    const here = this.unit.position!;
    const positions: Pos[] = this.game.aiController?.targetPositions?.(
      this.unit, behaviour, this.game.units.values(),
    ) ?? [];
    const zeroMove = this.maxRange();
    const singleMove = zeroMove + this.unit.getMovement();
    const doubleMove = singleMove + this.unit.getMovement();
    let targets: Array<[Pos, number]> = positions.map((pos) => [pos, distance(here, pos)]);
    const viewRange = Number(behaviour.view_range);
    if (viewRange === -4) {
      // Entire map.
    } else if (viewRange === -3) targets = targets.filter(([, mag]) => mag < doubleMove);
    else if (viewRange === -2) targets = targets.filter(([, mag]) => mag < singleMove);
    else if (viewRange === -1) targets = targets.filter(([, mag]) => mag < zeroMove);
    else targets = targets.filter(([, mag]) => mag < viewRange);
    return targets;
  }

  private approach(): Pos | null {
    const here = this.unit.position!;
    const targets = this.filteredTargets().map(([pos]) => pos)
      .sort((a, b) => distance(here, a) - distance(here, b));
    return targets[0] ?? null;
  }

  private retreat(): Pos | null {
    const validMoves: Pos[] = this.game.pathSystem?.getValidMoves?.(this.unit, this.game.board) ?? [];
    const targets = this.filteredTargets();
    if (!targets.length) return null;
    return smartFarthestAwayPos(this.unit.position!, validMoves, targets);
  }

  private findRegion(): any | null {
    const here = this.unit.position!;
    const spec = this.behaviour!.target_spec;
    const regions = (this.game.currentLevel?.regions ?? []).filter((region: any) => {
      if (String(region.region_type ?? '').toLowerCase() !== 'event' || region.sub_nid !== spec) return false;
      if (!region.condition) return true;
      try {
        return evaluateCondition(region.condition, {
          game: this.game, unit1: this.unit, region,
          gameVars: this.game.gameVars, levelVars: this.game.levelVars,
        });
      } catch {
        console.warn(`Could not evaluate region conditional ${region.condition}`);
        return false;
      }
    });
    const nearest = (region: any) => Math.min(...regionPositions(region).map((pos) => distance(here, pos)));
    regions.sort((a: any, b: any) => nearest(a) - nearest(b));
    return regions[0] ?? null;
  }

  act(now: number): void {
    const state = this.state;
    if (!state) return;
    if (state.type === 'move') {
      if (now - this.lastRecalculate >= RECALCULATE_TIME) {
        this.calcState(now);
        const current = this.state as RoamAIState | null;
        if (current?.type === 'move') this.path = this.getPath(current.target);
        this.lastRecalculate = now;
      }
      const current = this.state as RoamAIState | null;
      if (current?.type === 'move') this.move(current.target, current.proximity);
    } else if (state.type === 'wait') {
      if (now > state.time) this.resetForNextBehaviour();
    } else {
      this.makePath(regionCenter(state.region));
      this.interact(state.region, state.proximity);
    }
  }

  private interact(region: any, proximity: number): void {
    const here = this.unit.position!;
    const positions = regionPositions(region)
      .filter((pos) => distance(here, pos) <= proximity)
      .sort((a, b) => distance(here, a) - distance(here, b));
    if (!positions.length) return;
    const pos = positions[0];
    const events = this.game.eventManager;
    const ctx = { game: this.game, unit1: this.unit, region, position: pos, gameVars: this.game.gameVars, levelVars: this.game.levelVars };
    let triggered = !!events?.trigger({
      type: region.sub_nid, regionNid: region.nid, unitNid: this.unit.nid, unit1: this.unit,
      region, position: pos, levelNid: this.game.currentLevel?.nid,
    }, ctx);
    if (!triggered) {
      triggered = !!events?.trigger({
        type: 'on_region_interact', regionNid: region.nid, unitNid: this.unit.nid, unit1: this.unit,
        region, position: pos, levelNid: this.game.currentLevel?.nid,
      }, ctx);
    }
    if (triggered && region.only_once) {
      const regions = this.game.currentLevel?.regions;
      const idx = regions?.indexOf(region) ?? -1;
      if (idx >= 0) regions.splice(idx, 1);
    }
    if (triggered) this.unit.hasAttacked = true;
    this.resetForNextBehaviour();
  }

  private move(target: Pos, proximity: number): void {
    const roam = getRoamPosition(this.unit);
    const position: readonly [number, number] = roam ? [roam.x, roam.y] : this.unit.position!;
    if (distance(position, target) <= proximity) {
      this.resetForNextBehaviour();
      return;
    }
    this.makePath(target);
  }

  private makePath(target: Pos): void {
    if (this.path.length && (this.path[0][0] !== target[0] || this.path[0][1] !== target[1])) {
      this.path = this.getPath(target);
    }
    if (!this.path.length) this.path = this.getPath(target);
  }
}

/** Python FreeRoamAIHandler. */
export class FreeRoamAIHandler {
  active = true;
  private roamAis = new Map<string, RoamAI>();
  private components = new Map<string, RoamAIMovementComponent>();
  private now = 0;
  private game: any;

  constructor(game: any) {
    this.game = game;
    for (const unit of this.placedUnits()) this.addMovementComponent(unit);
    this.startAllUnits();
  }

  private placedUnits(): UnitObject[] {
    return [...this.game.units.values()].filter((u: UnitObject) => u.position && !u.isDead());
  }

  private addMovementComponent(unit: UnitObject): RoamAIMovementComponent | null {
    const aiNid = unit.roamAi;
    if (!aiNid || !this.game.db.ai?.get?.(aiNid)?.roam_ai) return null;
    this.roamAis.set(unit.nid, new RoamAI(unit, this.game, this.now));
    const mc = new RoamAIMovementComponent(unit, this.game.board, this.game.db, this.game);
    this.components.set(unit.nid, mc);
    return mc;
  }

  addUnit(unit: UnitObject): void {
    const mc = this.addMovementComponent(unit);
    mc?.start();
  }

  containsUnit(unit: UnitObject): boolean {
    return this.components.has(unit.nid);
  }

  stop(unit: UnitObject): void {
    this.components.get(unit.nid)?.finish();
  }

  stopAllUnits(): void {
    this.active = false;
    for (const mc of this.components.values()) mc.finish();
  }

  startAllUnits(): void {
    this.active = true;
    for (const mc of this.components.values()) mc.start();
  }

  resetAllUnits(): void {
    for (const mc of this.components.values()) mc.resetPosition();
    for (const ai of this.roamAis.values()) ai.resetPath();
  }

  /** Python update (think/act) followed by the movement system's update of the components. */
  update(dtMs: number): void {
    this.now += dtMs;
    if (this.active) {
      for (const unit of this.game.units.values() as Iterable<UnitObject>) {
        const ai = this.roamAis.get(unit.nid);
        if (!ai || !unit.position) continue;
        if (!ai.state) ai.think(this.now);
        // Upstream applies the behaviour's roam speed; the fork never does.
        this.components.get(unit.nid)!.setSpeed(isForkEngine() ? 1 : ai.speedMult);
        ai.act(this.now);
        this.components.get(unit.nid)!.setPath(ai.path);
      }
    }
    for (const [nid, mc] of this.components) {
      const unit = this.game.units.get(nid);
      if (!unit?.position || unit.isDead?.()) continue;
      mc.update(dtMs / 1000);
    }
  }
}
