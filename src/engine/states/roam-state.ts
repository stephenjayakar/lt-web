/**
 * roam-state.ts — Free Roam states for the Lex Talionis web engine.
 *
 * Implements ARPG-style direct unit control. The player moves a designated
 * roam unit with physics-based pixel movement, interacts with NPCs and
 * regions via SELECT, and can open menus with START.
 *
 * Two states:
 *   FreeRoamState           — Main roam mode with player movement
 *   FreeRoamRationalizeState — Slides all units back to grid positions
 *
 * Port of: lt-maker/app/engine/roam/
 */

import { MapState, type StateResult } from '../state';
import type { Surface } from '../surface';
import type { InputEvent } from '../input';
import {
  TILEWIDTH,
  TILEHEIGHT,
} from '../constants';
import { viewport } from '../viewport';
import {
  RoamPlayerMovementComponent,
  RationalizeMovementComponent,
  type RoamPosition,
} from '../../movement/roam-movement';
import type { UnitObject } from '../../objects/unit';
import { unitSpriteTint } from '../../combat/skill-system';
import type { FogRenderConfig } from '../../rendering/map-view';
import { evaluateCondition, type ConditionContext } from '../../events/event-manager';

// ---------------------------------------------------------------------------
// Lazy game reference (same pattern as game-states.ts)
// ---------------------------------------------------------------------------

let _game: any = null;
export function setRoamGameRef(g: any): void {
  _game = g;
}
function getGame(): any {
  if (!_game) throw new Error('Roam game reference not set. Call setRoamGameRef() first.');
  return _game;
}

const TALK_RANGE = 1.2; // tiles

// ---------------------------------------------------------------------------
// Local drawMap helper (duplicates the pattern from game-states.ts since
// that function is module-private)
// ---------------------------------------------------------------------------

/** Collect units for map-view rendering with roam offsets applied. */
function collectVisibleUnits(
  roamUnit: UnitObject | null,
  movementComponent: RoamPlayerMovementComponent | null,
): {
  x: number;
  y: number;
  visualOffsetX: number;
  visualOffsetY: number;
  sprite: any;
  team: string;
  finished: boolean;
  currentHp: number;
  maxHp: number;
  tintColor: [number, number, number] | null;
  tintAlpha: number;
}[] {
  const game = getGame();
  if (!game.board) return [];
  const allUnits: UnitObject[] = game.board.getAllUnits();
  const result: {
    x: number;
    y: number;
    visualOffsetX: number;
    visualOffsetY: number;
    sprite: any;
    team: string;
    finished: boolean;
    currentHp: number;
    maxHp: number;
    tintColor: [number, number, number] | null;
    tintAlpha: number;
  }[] = [];

  for (const u of allUnits) {
    if (u.isDead() || !u.position) continue;

    // In roam mode, all sprite states are 'standing' unless actively moving
    if (u.sprite && typeof u.sprite === 'object' && 'state' in u.sprite) {
      const spr = u.sprite as { state: string };
      // The roam movement component handles the roam unit's sprite state,
      // so only reset non-roam units
      if (u !== roamUnit && spr.state !== 'moving') {
        spr.state = 'standing';
      }
    }

    // Get smooth movement interpolation offset (in tile units)
    const moveOffset = game.movementSystem.getVisualOffset(u);
    let visualOffsetX = moveOffset ? moveOffset[0] : 0;
    let visualOffsetY = moveOffset ? moveOffset[1] : 0;

    // Apply roam offset for the player-controlled unit
    if (u === roamUnit && movementComponent) {
      const roamOffset = movementComponent.getVisualOffset();
      if (roamOffset) {
        visualOffsetX += roamOffset[0];
        visualOffsetY += roamOffset[1];
      }
    }

    result.push({
      x: u.position[0],
      y: u.position[1],
      visualOffsetX,
      visualOffsetY,
      sprite: u.sprite,
      team: u.team,
      finished: false, // In roam mode, no units are "finished"
      currentHp: u.currentHp,
      maxHp: u.maxHp,
      ...(() => {
        const tint = unitSpriteTint(u, game, performance.now());
        return { tintColor: tint?.color ?? null, tintAlpha: tint?.alpha ?? 0 };
      })(),
    });
  }
  return result;
}

/** Render the map with roam-specific unit collection. */
function drawRoamMap(
  surf: Surface,
  roamUnit: UnitObject | null,
  movementComponent: RoamPlayerMovementComponent | null,
): Surface {
  const game = getGame();
  if (!game.board || !game.tilemap) return surf;
  game.syncSkillMapAnimations();
  game.camera.update();
  game.cursor.update();

  const cullRect = game.camera.getCullRect();
  const units = collectVisibleUnits(roamUnit, movementComponent);
  const highlights: Map<string, string> | null = null; // No highlights in roam mode

  const cursorInfo = {
    x: game.cursor.getHover().x,
    y: game.cursor.getHover().y,
    visible: game.cursor.visible,
    draw: (s: Surface, ox: number, oy: number) => {
      game.cursor.draw(s, [ox, oy] as [number, number]);
    },
  };

  // Build fog of war config if fog is active
  let fogConfig: FogRenderConfig | null = null;
  const fogInfo = game.getCurrentFogInfo?.();
  if (fogInfo && game.board && (fogInfo.isActive || game.board.fogRegionSet?.size > 0)) {
    fogConfig = {
      fogInfo,
      board: game.board,
      db: game.db,
      allUnits: game.getAllUnits(),
    };
  }

  const mapSurf = game.mapView.draw(
    game.tilemap,
    cullRect,
    units,
    highlights,
    cursorInfo,
    false, // showGrid
    surf.scale,
    fogConfig,
  );

  surf.blit(mapSurf);
  return surf;
}

// ============================================================================
// FreeRoamState — Main roam mode state
// ============================================================================

/**
 * FreeRoamState — The main roam mode state where the player directly
 * controls a unit with ARPG-style pixel movement.
 *
 * Input:
 *   - Arrow keys / WASD: move the roam unit
 *   - SELECT (Z/Enter): interact with nearby NPCs or regions
 *   - START (Enter): open the option menu
 *   - INFO (C/Shift): open info menu for the roam unit
 *   - BACK held: sprint
 */
export class FreeRoamState extends MapState {
  readonly name = 'free_roam';

  private roamUnit: UnitObject | null = null;
  private movementComponent: RoamPlayerMovementComponent | null = null;

  override start(): StateResult {
    this.roamUnit = null;
    this.movementComponent = null;
  }

  override begin(): StateResult {
    const game = getGame();
    if (!game) return;

    // Hide cursor — roam uses direct unit control
    game.cursor.visible = false;

    // Get the roam unit
    const roamInfo = game.roamInfo;
    if (!roamInfo || !roamInfo.roam || !roamInfo.roamUnitNid) {
      game.state.back();
      return 'repeat';
    }

    const unit = game.getUnit(roamInfo.roamUnitNid);
    if (!unit || !unit.position) {
      game.state.back();
      return 'repeat';
    }

    // Assign the roam unit if changed or first time
    if (this.roamUnit !== unit) {
      if (this.movementComponent) {
        this.movementComponent.finish();
      }
      this.roamUnit = unit;
      this.movementComponent = new RoamPlayerMovementComponent(
        unit,
        game.board,
        game.db,
      );
    }

    // Center camera on roam unit
    if (unit.position) {
      game.camera.focusTile(unit.position[0], unit.position[1]);
    }
  }

  override takeInput(event: InputEvent): StateResult {
    const game = getGame();
    if (!game || !this.movementComponent || !this.roamUnit) return;

    // Sprint: hold BACK
    const inputMgr = game.input;
    const isSprinting = inputMgr?.isKeyHeld?.('x') || inputMgr?.isKeyHeld?.('Escape');
    this.movementComponent.setSprinting(!!isSprinting);

    // Directional input — check held keys for continuous movement
    let dx = 0;
    let dy = 0;
    if (inputMgr) {
      if (inputMgr.isPressed?.('UP') || inputMgr.isKeyHeld?.('ArrowUp') || inputMgr.isKeyHeld?.('w')) dy -= 1;
      if (inputMgr.isPressed?.('DOWN') || inputMgr.isKeyHeld?.('ArrowDown') || inputMgr.isKeyHeld?.('s')) dy += 1;
      if (inputMgr.isPressed?.('LEFT') || inputMgr.isKeyHeld?.('ArrowLeft') || inputMgr.isKeyHeld?.('a')) dx -= 1;
      if (inputMgr.isPressed?.('RIGHT') || inputMgr.isKeyHeld?.('ArrowRight') || inputMgr.isKeyHeld?.('d')) dx += 1;
    }
    // Also handle discrete events for this frame
    if (event === 'UP') dy -= 1;
    if (event === 'DOWN') dy += 1;
    if (event === 'LEFT') dx -= 1;
    if (event === 'RIGHT') dx += 1;

    this.movementComponent.setAcceleration(dx, dy);

    // SELECT: interact with NPCs/regions
    if (event === 'SELECT') {
      this.checkInteraction();
    }

    // START: open option menu (unless a roam_press_start event intercepts it)
    if (event === 'START') {
      this.checkStart();
    }

    // AUX: open option menu (unless a roam_press_aux event intercepts it)
    if (event === 'AUX') {
      this.checkAux();
    }

    // INFO: open info menu for roam unit (unless a roam_press_info event intercepts it)
    if (event === 'INFO') {
      this.checkInfo();
    }
  }

  /** Per-unit roam-AI bookkeeping: behaviour index + timers. */
  private npcRoamState: Map<string, { idx: number; waitMs: number; stepMs: number }> = new Map();

  private updateNpcRoamAi(game: any, dt: number): void {
    for (const unit of game.units.values()) {
      if (!unit.roamAi || !unit.position || unit.dead) continue;
      if (unit.nid === game.roamInfo?.roamUnitNid) continue;
      const aiDef = game.db.ai?.get?.(unit.roamAi);
      const behaviours = aiDef?.behaviours ?? [];
      if (behaviours.length === 0) continue;
      let st = this.npcRoamState.get(unit.nid);
      if (!st) { st = { idx: 0, waitMs: 0, stepMs: 0 }; this.npcRoamState.set(unit.nid, st); }
      const b = behaviours[st.idx % behaviours.length];
      if (!b || b.action === 'None') { st.idx++; continue; }
      if (b.action === 'Wait') {
        st.waitMs += dt * 1000;
        const target = typeof b.target_spec === 'number' ? b.target_spec : 1000;
        if (st.waitMs >= target) { st.waitMs = 0; st.idx++; }
      } else if (b.action === 'Move_to') {
        // Tile-step toward the behaviour's starting position target on a
        // roam_speed-scaled cadence; other target kinds are deferred.
        st.stepMs += dt * 1000;
        const cadence = 400 * (100 / Math.max(1, b.roam_speed ?? 100));
        if (st.stepMs < cadence) continue;
        st.stepMs = 0;
        const target = unit.startingPosition ?? null;
        if (!target) { st.idx++; continue; }
        const [ux, uy] = unit.position;
        const [tx, ty] = target;
        if (ux === tx && uy === ty) { st.idx++; continue; }
        const dx = Math.sign(tx - ux);
        const dy = dx === 0 ? Math.sign(ty - uy) : 0;
        const nx = ux + dx, ny = uy + dy;
        if (game.board && !game.board.getUnit(nx, ny) && game.board.checkBounds(nx, ny)) {
          game.board.removeUnit(unit);
          unit.position = [nx, ny];
          game.board.setUnit(nx, ny, unit);
        }
      } else {
        // Interact / Move_away_from etc. — deferred; skip to next behaviour.
        st.idx++;
      }
    }
  }

  override update(): StateResult {
    const game = getGame();
    if (!game || !this.movementComponent) return;

    const dt = game.frameDeltaMs / 1000;
    this.movementComponent.update(dt);

    // NPC roam AI (Python free_roam_ai.FreeRoamAIHandler, simplified):
    // supports Wait and Move_to behaviours, tile-stepped on a cadence rather
    // than Python's pixel-smooth movement (documented deviation).
    this.updateNpcRoamAi(game, dt);

    // Follow camera to roam unit's sub-tile position
    if (this.roamUnit?.position && this.movementComponent.roamPosition) {
      const roamPos = this.movementComponent.roamPosition;
      game.camera.focusTile(roamPos.x, roamPos.y);
    }

    // Check for pending events
    if (game.eventManager?.hasActiveEvents()) {
      this.rationalizeAllUnits();
      game.state.change('event');
      return;
    }

    // Check for region interrupts
    this.checkRegionInterrupt();
  }

  override draw(surf: Surface): Surface {
    return drawRoamMap(surf, this.roamUnit, this.movementComponent);
  }

  // -- Interaction logic --

  private checkInteraction(): void {
    const game = getGame();
    if (!game || !this.roamUnit) return;

    // 1. Check for talk-eligible units within range
    const closestTalk = this.getClosestUnit(true);
    if (closestTalk && game.eventManager) {
      const triggered = game.eventManager.trigger(
        {
          // Python's free_roam_state.py:163 passes position=None here — this
          // is the one on_talk call site where position is intentionally
          // absent, matching Python's `triggers.OnTalk(self.roam_unit, other_unit, None)`.
          type: 'on_talk',
          unit1: this.roamUnit,
          unit2: closestTalk,
          unitA: this.roamUnit.nid,
          unitB: closestTalk.nid,
          // findMatchingEvents drops every level-scoped event when the
          // trigger carries no level, so omitting this silently disables
          // all authored talks. Python scopes by game.level implicitly.
          levelNid: game.currentLevel?.nid,
        },
        {
          game,
          unit1: this.roamUnit,
          unit2: closestTalk,
          gameVars: game.gameVars,
          levelVars: game.levelVars,
        },
      );
      if (triggered) {
        this.rationalizeAllUnits();
        return;
      }
    }

    // 2. Check for event regions at current position. Mirrors Python's
    // check_select(): try the region's own sub_nid as a RegionTrigger first
    // (this is how Shop/Armory/Visit/etc. regions fire in roam), and if
    // that finds no matching event, fall back to the generic
    // on_region_interact trigger (free_roam_state.py:171-179).
    const region = this.getVisitRegion();
    if (region && game.eventManager) {
      const ctx = {
        game,
        unit1: this.roamUnit,
        region,
        gameVars: game.gameVars,
        levelVars: game.levelVars,
      };
      let triggered = false;
      if (region.sub_nid) {
        triggered = game.eventManager.trigger(
          {
            type: region.sub_nid,
            regionNid: region.nid,
            unitNid: this.roamUnit.nid,
            unit1: this.roamUnit,
            region,
            levelNid: game.currentLevel?.nid,
          },
          ctx,
        );
      }
      if (!triggered) {
        triggered = game.eventManager.trigger(
          {
            type: 'on_region_interact',
            regionNid: region.nid,
            unitNid: this.roamUnit.nid,
            unit1: this.roamUnit,
            region,
            levelNid: game.currentLevel?.nid,
          },
          ctx,
        );
      }
      if (triggered) {
        if (region.only_once && game.currentLevel?.regions) {
          const idx = game.currentLevel.regions.indexOf(region);
          if (idx >= 0) {
            game.currentLevel.regions.splice(idx, 1);
          }
        }
        this.rationalizeAllUnits();
        return;
      }
    }

    // 3. Generic roam interact (catch-all)
    if (game.eventManager) {
      const closestUnits = this.getClosestUnits(false);
      const closestAny = closestUnits[0] ?? undefined;
      const triggered = game.eventManager.trigger(
        {
          type: 'on_roam_interact',
          unit1: this.roamUnit,
          unit2: closestAny,
          unitNid: this.roamUnit.nid,
          localArgs: new Map<string, any>([['units', closestUnits]]),
          levelNid: game.currentLevel?.nid,
        },
        {
          game,
          unit1: this.roamUnit,
          unit2: closestAny,
          gameVars: game.gameVars,
          levelVars: game.levelVars,
        },
      );
      if (triggered) {
        this.rationalizeAllUnits();
        return;
      }
    }
  }

  /**
   * Called on INFO. Mirrors Python's check_info(): fires `roam_press_info`
   * first; only if nothing handles it do we fall back to the default info
   * menu (free_roam_state.py:191-203).
   */
  private checkInfo(): void {
    const game = getGame();
    if (!game || !this.roamUnit) return;
    const otherUnit = this.getClosestUnit(false);
    const triggered = game.eventManager?.trigger(
      { type: 'roam_press_info', unit1: this.roamUnit, unit2: otherUnit ?? undefined },
      { game, unit1: this.roamUnit, unit2: otherUnit ?? undefined, gameVars: game.gameVars, levelVars: game.levelVars },
    );
    if (triggered) {
      this.rationalizeAllUnits();
    } else {
      this.rationalizeAndDo(() => {
        game.infoMenuUnit = this.roamUnit;
        game.state.change('info_menu');
      });
    }
  }

  /**
   * Called on AUX. Mirrors Python's check_aux(): fires `roam_press_aux`;
   * opens the option menu only if nothing handled it, then always
   * rationalizes units (free_roam_state.py:205-213).
   */
  private checkAux(): void {
    const game = getGame();
    if (!game || !this.roamUnit) return;
    const otherUnit = this.getClosestUnit(false);
    const triggered = game.eventManager?.trigger(
      { type: 'roam_press_aux', unit1: this.roamUnit, unit2: otherUnit ?? undefined },
      { game, unit1: this.roamUnit, unit2: otherUnit ?? undefined, gameVars: game.gameVars, levelVars: game.levelVars },
    );
    if (!triggered) {
      game.state.change('option_menu');
    }
    this.rationalizeAllUnits();
  }

  /**
   * Called on START. Mirrors Python's check_start(): fires `roam_press_start`;
   * opens the option menu only if nothing handled it, then always
   * rationalizes units (free_roam_state.py:215-223).
   */
  private checkStart(): void {
    const game = getGame();
    if (!game || !this.roamUnit) return;
    const otherUnit = this.getClosestUnit(false);
    const triggered = game.eventManager?.trigger(
      { type: 'roam_press_start', unit1: this.roamUnit, unit2: otherUnit ?? undefined },
      { game, unit1: this.roamUnit, unit2: otherUnit ?? undefined, gameVars: game.gameVars, levelVars: game.levelVars },
    );
    if (!triggered) {
      game.state.change('option_menu');
    }
    this.rationalizeAllUnits();
  }

  private checkRegionInterrupt(): void {
    const game = getGame();
    if (!game || !this.roamUnit?.position || !game.currentLevel?.regions) return;

    for (const region of game.currentLevel.regions) {
      if (!region.interrupt_move) continue;

      const [rx, ry] = region.position;
      const [rw, rh] = region.size;
      const [ux, uy] = this.roamUnit.position;

      if (ux >= rx && ux < rx + rw && uy >= ry && uy < ry + rh) {
        if (game.eventManager) {
          const triggered = game.eventManager.trigger(
            {
              type: 'roaming_interrupt',
              regionNid: region.nid,
              region,
              unit1: this.roamUnit,
              unitNid: this.roamUnit.nid,
              position: this.roamUnit.position,
            },
            {
              game,
              unit1: this.roamUnit,
              position: this.roamUnit.position,
              region,
              gameVars: game.gameVars,
              levelVars: game.levelVars,
            },
          );
          if (triggered) {
            if (region.only_once) {
              const idx = game.currentLevel.regions.indexOf(region);
              if (idx >= 0) game.currentLevel.regions.splice(idx, 1);
            }
            this.rationalizeAllUnits();
            return;
          }
        }
      }
    }
  }
  /**
   * Measure proximity from the live sub-tile position, as Python does.
   *
   * The web movement component updates `unit.position` as soon as the player
   * crosses a half-tile boundary. After turning a corner, inertia can therefore
   * leave the sprite just outside TALK_RANGE while its occupied tile is already
   * adjacent to the NPC. Treat that grid adjacency as in range so SELECT cannot
   * fail from a few residual sub-pixels.
   */
  private getInteractionDistance(unit: UnitObject): number {
    const roamPos = this.movementComponent?.roamPosition;
    if (!roamPos) return Number.POSITIVE_INFINITY;

    const subTileDistance =
      Math.abs(unit.position![0] - roamPos.x) +
      Math.abs(unit.position![1] - roamPos.y);
    if (!this.roamUnit?.position) return subTileDistance;

    const gridDistance =
      Math.abs(unit.position![0] - this.roamUnit.position[0]) +
      Math.abs(unit.position![1] - this.roamUnit.position[1]);
    return gridDistance < TALK_RANGE
      ? Math.min(subTileDistance, gridDistance)
      : subTileDistance;
  }

  /** Find the closest unit within TALK_RANGE of the roam unit. */
  private getClosestUnit(mustHaveTalk: boolean): UnitObject | null {
    const game = getGame();
    if (!game || !this.movementComponent?.roamPosition) return null;

    let closest: UnitObject | null = null;
    let closestDist = TALK_RANGE;

    for (const unit of game.units.values()) {
      if (unit === this.roamUnit || !unit.position || unit.isDead()) continue;

      // Python measures from the sprite's live sub-tile position. The helper
      // also accounts for the web port's earlier grid-boundary synchronization.
      const dist = this.getInteractionDistance(unit);

      if (dist < closestDist) {
        if (mustHaveTalk) {
          // Check if there's a talk event between these units
          if (game.eventManager?.hasTalkPair?.(this.roamUnit!.nid, unit.nid)) {
            closest = unit;
            closestDist = dist;
          }
        } else {
          closest = unit;
          closestDist = dist;
        }
      }
    }
    return closest;
  }

  /**
   * Find all units within TALK_RANGE of the roam unit, sorted by distance
   * (closest first). Mirrors Python's `get_closest_units()`
   * (free_roam_state.py:95) which backs both `get_closest_unit()` and the
   * `units` list on the `on_roam_interact` trigger.
   */
  private getClosestUnits(mustHaveTalk: boolean): UnitObject[] {
    const game = getGame();
    if (!game || !this.movementComponent?.roamPosition) return [];

    const candidates: Array<{ unit: UnitObject; dist: number }> = [];

    for (const unit of game.units.values()) {
      if (unit === this.roamUnit || !unit.position || unit.isDead()) continue;

      const dist = this.getInteractionDistance(unit);
      if (dist >= TALK_RANGE) continue;

      if (mustHaveTalk && !game.eventManager?.hasTalkPair?.(this.roamUnit!.nid, unit.nid)) {
        continue;
      }
      candidates.push({ unit, dist });
    }

    candidates.sort((a, b) => a.dist - b.dist);
    return candidates.map((c) => c.unit);
  }

  /** Find an EVENT region at the roam unit's grid position. */
  private getVisitRegion(): any | null {
    const game = getGame();
    if (!game || !this.roamUnit?.position || !game.currentLevel?.regions) return null;

    const [ux, uy] = this.roamUnit.position;
    for (const region of game.currentLevel.regions) {
      if ((region.region_type ?? '').toLowerCase() !== 'event') continue;
      const [rx, ry] = region.position;
      const [rw, rh] = region.size;
      if (ux >= rx && ux < rx + rw && uy >= ry && uy < ry + rh) {
        // Mirrors Python's get_visit_region(): the region's own `condition`
        // expression must evaluate truthy for it to be considered a visit
        // target (free_roam_state.py:125-141), independent of any condition
        // on the events triggered from it.
        const condCtx: ConditionContext = {
          game,
          unit1: this.roamUnit,
          region,
          gameVars: game.gameVars,
          levelVars: game.levelVars,
        };
        const conditionStr = region.condition ?? 'True';
        if (!evaluateCondition(conditionStr, condCtx)) continue;
        return region;
      }
    }
    return null;
  }

  /** Rationalize all units (stop movement, slide to grid). */
  rationalizeAllUnits(): void {
    const game = getGame();
    if (!game) return;

    // Stop player movement
    if (this.movementComponent) {
      this.movementComponent.finish();
    }

    // Null out roam unit ref so begin() re-acquires it on re-entry
    this.roamUnit = null;
    this.movementComponent = null;

    // Push rationalize state
    game.state.change('free_roam_rationalize');
  }

  /** Helper: rationalize, then perform an action. */
  private rationalizeAndDo(callback: () => void): void {
    // For simple menu operations, just do them directly since
    // we don't have NPC AI movement to stop yet
    if (this.movementComponent) {
      this.movementComponent.finish();
    }
    this.roamUnit = null;
    this.movementComponent = null;
    callback();
  }

  /** Leave roam mode entirely. */
  leave(): StateResult {
    const game = getGame();
    if (!game) return;

    if (this.movementComponent) {
      this.movementComponent.finish();
    }
    this.roamUnit = null;
    this.movementComponent = null;

    game.roamInfo?.clear();
    game.cursor.visible = true;
    game.state.back();
    return 'repeat';
  }

  /** Get visual offset for the roam unit (for external rendering). */
  getRoamOffset(unit: UnitObject): [number, number] | null {
    if (unit === this.roamUnit && this.movementComponent) {
      return this.movementComponent.getVisualOffset();
    }
    return null;
  }
}

// ============================================================================
// FreeRoamRationalizeState — Slides units back to grid
// ============================================================================

/**
 * FreeRoamRationalizeState — Slides all units from sub-tile roam
 * positions back to grid positions. Transparent overlay that lets
 * the map draw beneath.
 */
export class FreeRoamRationalizeState extends MapState {
  readonly name = 'free_roam_rationalize';
  override readonly transparent = true;

  private components: RationalizeMovementComponent[] = [];
  private allDone = false;

  override begin(): StateResult {
    const game = getGame();
    if (!game) return;

    this.components = [];
    this.allDone = false;

    // For now, since we only track the player roam unit's sub-tile
    // position, just do an immediate grid snap for simplicity.
    // In a full implementation, this would read each unit's roam position
    // and create rationalize components for NPC wandering as well.

    // If no components to process, immediately done
    if (this.components.length === 0) {
      this.allDone = true;
    }
  }

  override update(): StateResult {
    const game = getGame();
    if (!game) return;

    if (this.allDone) {
      game.state.back();
      return 'repeat';
    }

    const dt = game.frameDeltaMs / 1000;
    let anyActive = false;
    for (const comp of this.components) {
      if (!comp.done) {
        comp.update(dt);
        if (!comp.done) anyActive = true;
      }
    }

    if (!anyActive) {
      this.allDone = true;
      game.state.back();
      return 'repeat';
    }
  }

  override draw(surf: Surface): Surface {
    return drawRoamMap(surf, null, null);
  }
}
