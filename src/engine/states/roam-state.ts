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
import type { FogRenderConfig } from '../../rendering/map-view';

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
      if (inputMgr.isKeyHeld?.('ArrowUp') || inputMgr.isKeyHeld?.('w')) dy -= 1;
      if (inputMgr.isKeyHeld?.('ArrowDown') || inputMgr.isKeyHeld?.('s')) dy += 1;
      if (inputMgr.isKeyHeld?.('ArrowLeft') || inputMgr.isKeyHeld?.('a')) dx -= 1;
      if (inputMgr.isKeyHeld?.('ArrowRight') || inputMgr.isKeyHeld?.('d')) dx += 1;
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

    // START: open option menu
    if (event === 'START') {
      this.rationalizeAndDo(() => {
        game.state.push('option_menu');
      });
    }

    // INFO: open info menu for roam unit
    if (event === 'INFO') {
      if (this.roamUnit) {
        this.rationalizeAndDo(() => {
          game.infoMenuUnit = this.roamUnit;
          game.state.push('info_menu');
        });
      }
    }
  }

  override update(): StateResult {
    const game = getGame();
    if (!game || !this.movementComponent) return;

    const dt = game.frameDeltaMs / 1000;
    this.movementComponent.update(dt);

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
          type: 'on_talk',
          unit1: this.roamUnit,
          unit2: closestTalk,
          unitA: this.roamUnit.nid,
          unitB: closestTalk.nid,
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

    // 2. Check for event regions at current position
    const region = this.getVisitRegion();
    if (region && game.eventManager) {
      const subNid = region.sub_nid || 'on_region_interact';
      const triggered = game.eventManager.trigger(
        {
          type: subNid,
          regionNid: region.nid,
          unitNid: this.roamUnit.nid,
          unit1: this.roamUnit,
          region,
        },
        {
          game,
          unit1: this.roamUnit,
          region,
          gameVars: game.gameVars,
          levelVars: game.levelVars,
        },
      );
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
      const closestAny = this.getClosestUnit(false);
      const triggered = game.eventManager.trigger(
        {
          type: 'on_roam_interact',
          unit1: this.roamUnit,
          unit2: closestAny ?? undefined,
          unitNid: this.roamUnit.nid,
        },
        {
          game,
          unit1: this.roamUnit,
          unit2: closestAny ?? undefined,
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
            },
            {
              game,
              unit1: this.roamUnit,
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

  /** Find the closest unit within TALK_RANGE of the roam unit. */
  private getClosestUnit(mustHaveTalk: boolean): UnitObject | null {
    const game = getGame();
    if (!game || !this.movementComponent?.roamPosition) return null;

    const roamPos = this.movementComponent.roamPosition;
    let closest: UnitObject | null = null;
    let closestDist = TALK_RANGE;

    for (const unit of game.units.values()) {
      if (unit === this.roamUnit || !unit.position || unit.isDead()) continue;

      const dx = unit.position[0] - roamPos.x;
      const dy = unit.position[1] - roamPos.y;
      const dist = Math.sqrt(dx * dx + dy * dy);

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

  /** Find an EVENT region at the roam unit's grid position. */
  private getVisitRegion(): any | null {
    const game = getGame();
    if (!game || !this.roamUnit?.position || !game.currentLevel?.regions) return null;

    const [ux, uy] = this.roamUnit.position;
    for (const region of game.currentLevel.regions) {
      if (region.region_type !== 'event') continue;
      const [rx, ry] = region.position;
      const [rw, rh] = region.size;
      if (ux >= rx && ux < rx + rw && uy >= ry && uy < ry + rh) {
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
    game.state.push('free_roam_rationalize');
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
