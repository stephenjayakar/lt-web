/**
 * game-states.ts - All game states for the Lex Talionis web engine.
 *
 * Each state class extends State or MapState and plugs into the
 * stack-based StateMachine.  A lazily-resolved `game` reference
 * provides access to the shared game context (camera, cursor, board,
 * units, tilemap, mapView, etc.) without creating circular imports.
 */

import { State, MapState, type StateResult } from '../state';
import type { Surface } from '../surface';
import type { InputEvent } from '../input';
import {
  WINWIDTH,
  WINHEIGHT,
  TILEWIDTH,
  TILEHEIGHT,
  FRAMETIME,
} from '../constants';

import type { UnitObject } from '../../objects/unit';
import type { ItemObject } from '../../objects/item';

import { ChoiceMenu, type MenuOption } from '../../ui/menu';
import { Banner } from '../../ui/banner';
import { Dialog } from '../../ui/dialog';
import { MapCombat, type CombatResults } from '../../combat/map-combat';
import { AnimationCombat, type AnimationCombatRenderState, type AnimationCombatOwner } from '../../combat/animation-combat';
import { BattleAnimation as RealBattleAnimation, type BattleAnimDrawData } from '../../combat/battle-animation';
import { getEquippedWeapon } from '../../combat/combat-calcs';
import { loadBattlePlatforms, loadAndConvertWeaponAnim, selectPalette, selectWeaponAnim } from '../../combat/sprite-loader';

// ---------------------------------------------------------------------------
// Lazy game reference — set once at bootstrap to break circular deps.
// The `any` type is intentional: game-states.ts and game-state.ts would
// form a circular import if we typed this as GameState. The property names
// are validated at build time via the integration in main.ts.
// ---------------------------------------------------------------------------

let _game: any = null;
export function setGameRef(g: any): void {
  _game = g;
}
function getGame(): any {
  if (!_game) throw new Error('Game reference not set. Call setGameRef() first.');
  return _game;
}

/** Get the board, throwing a clear error if no level is loaded. */
function getBoard(): any {
  const game = getGame();
  if (!game.board) {
    throw new Error('No level loaded — game.board is null. Ensure loadLevel() completes before entering gameplay states.');
  }
  return game.board;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Active combat animation offsets, set by CombatState so that
 * collectVisibleUnits can apply lunge/shake to the fighting sprites.
 */
let _activeCombatOffsets: {
  attacker: UnitObject;
  defender: UnitObject;
  attackerOffset: [number, number]; // pixel offsets
  defenderOffset: [number, number];
} | null = null;

export function setActiveCombatOffsets(
  offsets: typeof _activeCombatOffsets,
): void {
  _activeCombatOffsets = offsets;
}

/** Collect units for map-view rendering from the game board. */
function collectVisibleUnits(): {
  x: number;
  y: number;
  /** Sub-tile visual offset in tile units for movement interpolation. */
  visualOffsetX: number;
  visualOffsetY: number;
  sprite: any;
  team: string;
  finished: boolean;
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
  }[] = [];

  for (const u of allUnits) {
    if (u.isDead() || !u.position) continue;

    // Update sprite state: gray for finished, standing otherwise
    // (moving state is set by the movement system)
    if (u.sprite && typeof u.sprite === 'object' && 'state' in u.sprite) {
      const spr = u.sprite as { state: string };
      if (spr.state !== 'moving') {
        spr.state = u.finished ? 'gray' : 'standing';
      }
    }

    // Get smooth movement interpolation offset (in tile units)
    const moveOffset = game.movementSystem.getVisualOffset(u);
    let visualOffsetX = moveOffset ? moveOffset[0] : 0;
    let visualOffsetY = moveOffset ? moveOffset[1] : 0;

    // Apply combat lunge/shake offsets (in pixels, convert to tile units)
    if (_activeCombatOffsets) {
      if (u === _activeCombatOffsets.attacker) {
        visualOffsetX += _activeCombatOffsets.attackerOffset[0] / TILEWIDTH;
        visualOffsetY += _activeCombatOffsets.attackerOffset[1] / TILEHEIGHT;
      } else if (u === _activeCombatOffsets.defender) {
        visualOffsetX += _activeCombatOffsets.defenderOffset[0] / TILEWIDTH;
        visualOffsetY += _activeCombatOffsets.defenderOffset[1] / TILEHEIGHT;
      }
    }

    result.push({
      x: u.position[0],
      y: u.position[1],
      visualOffsetX,
      visualOffsetY,
      sprite: u.sprite,
      team: u.team,
      finished: u.finished,
    });
  }
  return result;
}

/** Render the map through MapView and blit onto `surf`. */
function drawMap(surf: Surface, showHighlights: boolean = true): Surface {
  const game = getGame();
  if (!game.board || !game.tilemap) return surf; // No level loaded
  game.camera.update();
  game.cursor.update();

  const cullRect = game.camera.getCullRect();
  const units = collectVisibleUnits();
  const highlights: Map<string, string> | null = showHighlights
    ? game.highlight.getHighlights()
    : null;

  const cursorInfo = {
    x: game.cursor.getHover().x,
    y: game.cursor.getHover().y,
    visible: game.cursor.visible,
    draw: (s: Surface, ox: number, oy: number) => {
      game.cursor.draw(s, [ox, oy] as [number, number]);
    },
  };

  const mapSurf = game.mapView.draw(
    game.tilemap,
    cullRect,
    units,
    highlights,
    cursorInfo,
    false, // showGrid
    surf.scale,
  );

  surf.blit(mapSurf);
  return surf;
}

/** Move cursor and camera together. */
function moveCursor(dx: number, dy: number): void {
  const game = getGame();
  game.cursor.move(dx, dy);
  const pos = game.cursor.getHover();
  game.camera.focusTile(pos.x, pos.y);
}

/** Get the unit under the cursor, or null. */
function getUnitUnderCursor(): UnitObject | null {
  const game = getGame();
  const pos = game.cursor.getHover();
  return getBoard().getUnit(pos.x, pos.y);
}

/** Get all enemies of a unit within weapon range from a specific position. */
function getTargetsInRange(
  unit: UnitObject,
  fromX: number,
  fromY: number,
): UnitObject[] {
  const game = getGame();
  const weapon = getEquippedWeapon(unit);
  if (!weapon) return [];
  const minRange = weapon.getMinRange();
  const maxRange = weapon.getMaxRange();
  const allUnits: UnitObject[] = getBoard().getAllUnits();
  const targets: UnitObject[] = [];

  for (const other of allUnits) {
    if (other === unit) continue;
    if (other.isDead() || !other.position) continue;
    if (game.db.areAllied(unit.team, other.team)) continue;
    const dist =
      Math.abs(other.position[0] - fromX) +
      Math.abs(other.position[1] - fromY);
    if (dist >= minRange && dist <= maxRange) {
      targets.push(other);
    }
  }
  return targets;
}

/** Get all adjacent allied units to a unit at a specific position. */
function getAdjacentAllies(unit: UnitObject, x: number, y: number): UnitObject[] {
  const game = getGame();
  const board = getBoard();
  const dirs: [number, number][] = [[0, -1], [0, 1], [-1, 0], [1, 0]];
  const allies: UnitObject[] = [];
  for (const [dx, dy] of dirs) {
    const other = board.getUnit(x + dx, y + dy);
    if (other && other !== unit && !other.isDead() && game.db.areAllied(unit.team, other.team)) {
      allies.push(other);
    }
  }
  return allies;
}

/** Get all adjacent units (any team) at a specific position. */
function getAdjacentUnits(x: number, y: number): UnitObject[] {
  const board = getBoard();
  const dirs: [number, number][] = [[0, -1], [0, 1], [-1, 0], [1, 0]];
  const units: UnitObject[] = [];
  for (const [dx, dy] of dirs) {
    const other = board.getUnit(x + dx, y + dy);
    if (other && !other.isDead()) {
      units.push(other);
    }
  }
  return units;
}

/** Get all adjacent empty tiles that are in bounds. */
function getAdjacentEmptyTiles(x: number, y: number): [number, number][] {
  const board = getBoard();
  const dirs: [number, number][] = [[0, -1], [0, 1], [-1, 0], [1, 0]];
  const tiles: [number, number][] = [];
  for (const [dx, dy] of dirs) {
    const nx = x + dx;
    const ny = y + dy;
    if (board.inBounds(nx, ny) && !board.isOccupied(nx, ny)) {
      tiles.push([nx, ny]);
    }
  }
  return tiles;
}

// ---------------------------------------------------------------------------
// Mouse helpers
// ---------------------------------------------------------------------------

/**
 * Get the tile coordinates under the mouse cursor, or null if the mouse
 * is outside the game area or no InputManager is available.
 */
function getMouseTile(): [number, number] | null {
  const game = getGame();
  if (!game.input) return null;
  const cam = game.camera.getOffset();
  return game.input.getMouseTile(cam[0], cam[1]);
}

/**
 * If the mouse was clicked this frame (LMB), move the cursor to the
 * clicked tile and return 'SELECT'. If RMB, return 'BACK'.
 * If the mouse moved (no click), move the cursor to the hovered tile
 * and return null (no action, just hover tracking).
 *
 * Returns the effective InputEvent to process, or undefined to indicate
 * "mouse didn't do anything interesting — fall through to keyboard".
 */
function processMouseForMap(event: InputEvent): InputEvent | undefined {
  const game = getGame();
  if (!game.input) return undefined;

  const input = game.input;
  const tile = getMouseTile();

  // Handle mouse click: move cursor to tile, then return the action
  if (input.mouseClick) {
    if (input.mouseClick === 'SELECT' && tile) {
      // Move cursor to clicked tile
      game.cursor.setPos(tile[0], tile[1]);
      game.camera.focusTile(tile[0], tile[1]);
      return 'SELECT';
    }
    if (input.mouseClick === 'BACK') {
      return 'BACK';
    }
    if (input.mouseClick === 'INFO' && tile) {
      game.cursor.setPos(tile[0], tile[1]);
      game.camera.focusTile(tile[0], tile[1]);
      return 'INFO';
    }
  }

  // Handle mouse hover: move cursor to hovered tile (no action)
  if (input.mouseMoved && tile) {
    const curPos = game.cursor.getHover();
    if (tile[0] !== curPos.x || tile[1] !== curPos.y) {
      game.cursor.setPos(tile[0], tile[1]);
      // Don't auto-pan camera on hover — only on click.
      // This prevents disorienting camera movement while browsing.
    }
  }

  return undefined; // No mouse action to process
}

// ============================================================================
// 1. TitleState
// ============================================================================

export class TitleState extends State {
  readonly name = 'title';
  override readonly showMap = false;
  override readonly inLevel = false;

  override draw(surf: Surface): Surface {
    surf.fill(16, 16, 32);

    // Title text centred
    const title = 'Lex Talionis';
    const titleW = title.length * 7;
    surf.drawText(
      title,
      Math.floor((WINWIDTH - titleW) / 2),
      Math.floor(WINHEIGHT / 3),
      'white',
      '12px monospace',
    );

    // Prompt
    const prompt = 'Press START';
    const promptW = prompt.length * 5;
    surf.drawText(
      prompt,
      Math.floor((WINWIDTH - promptW) / 2),
      Math.floor(WINHEIGHT / 2),
      'rgba(200,200,220,1)',
      '8px monospace',
    );

    return surf;
  }

  override takeInput(event: InputEvent): StateResult {
    // Mouse click also starts the game
    const game = getGame();
    if (event === 'START' || event === 'SELECT' || game.input?.mouseClick === 'SELECT') {
      if (!game.board) {
        console.error('Cannot start: no level loaded (game.board is null). Check that game data is accessible.');
        return;
      }
      game.state.change('free');
      return;
    }
  }
}

// ============================================================================
// 1b. OptionMenuState (map option menu: End Turn, etc.)
// ============================================================================

export class OptionMenuState extends State {
  readonly name = 'option_menu';
  override readonly transparent = true;

  private menu: ChoiceMenu | null = null;

  override begin(): StateResult {
    const game = getGame();
    const options: MenuOption[] = [
      { label: 'End Turn', value: 'end_turn', enabled: true },
    ];
    // Centre the menu on screen
    const menuX = Math.floor(WINWIDTH / 2) - 30;
    const menuY = Math.floor(WINHEIGHT / 2) - 12;
    this.menu = new ChoiceMenu(options, menuX, menuY);
  }

  override takeInput(event: InputEvent): StateResult {
    if (!this.menu) return;
    const game = getGame();

    // Handle mouse click on menu options
    let result: { selected: string } | { back: true } | null = null;
    if (game.input?.mouseClick) {
      const [gx, gy] = game.input.getGameMousePos();
      result = this.menu.handleClick(gx, gy, game.input.mouseClick as 'SELECT' | 'BACK');
    }
    // Handle mouse hover to highlight menu options
    if (game.input?.mouseMoved) {
      const [gx, gy] = game.input.getGameMousePos();
      this.menu.handleMouseHover(gx, gy);
    }
    // Fall through to keyboard input if mouse didn't produce a result
    if (!result && event !== null) {
      result = this.menu.handleInput(event);
    }
    if (!result) return;

    if ('back' in result) {
      this.menu = null;
      game.state.back();
      return;
    }

    if ('selected' in result) {
      switch (result.selected) {
        case 'end_turn': {
          // Mark all player units as finished and trigger turn change
          const playerUnits: UnitObject[] = game.board?.getTeamUnits('player') ?? [];
          for (const unit of playerUnits) {
            unit.finished = true;
          }
          this.menu = null;
          game.state.back();
          game.state.change('turn_change');
          break;
        }
      }
    }
  }

  override draw(surf: Surface): Surface {
    if (this.menu) {
      this.menu.draw(surf);
    }
    return surf;
  }
}

// ============================================================================
// 2. FreeState
// ============================================================================

export class FreeState extends MapState {
  readonly name = 'free';

  override begin(): StateResult {
    const game = getGame();
    const board = getBoard();
    game.cursor.visible = true;

    // Auto-cursor to first available player unit
    const playerUnits: UnitObject[] = board.getTeamUnits('player');
    const available = playerUnits.find((u) => u.canStillAct() && u.position);
    if (available && available.position) {
      game.cursor.setPos(available.position[0], available.position[1]);
      game.camera.focusTile(available.position[0], available.position[1]);
    }
  }

  override takeInput(event: InputEvent): StateResult {
    const game = getGame();

    // Process mouse: click moves cursor to tile + fires action,
    // hover tracks cursor position silently.
    const mouseAction = processMouseForMap(event);
    const effective = mouseAction ?? event;

    if (effective === null) return;

    switch (effective) {
      case 'UP':
        moveCursor(0, -1);
        break;
      case 'DOWN':
        moveCursor(0, 1);
        break;
      case 'LEFT':
        moveCursor(-1, 0);
        break;
      case 'RIGHT':
        moveCursor(1, 0);
        break;

      case 'SELECT': {
        const unit = getUnitUnderCursor();
        if (unit && unit.team === 'player' && unit.canStillAct()) {
          game.selectedUnit = unit;
          game.state.change('move');
        } else {
          // No actionable unit — open option menu
          game.state.change('option_menu');
        }
        break;
      }

      case 'BACK': {
        // Right-click on map: open option menu (same as START)
        game.state.change('option_menu');
        break;
      }

      case 'INFO': {
        // Toggle highlight for the hovered unit
        const unit = getUnitUnderCursor();
        if (unit && unit.position) {
          const key = `${unit.position[0]},${unit.position[1]}`;
          const existing = game.highlight.getHighlights().get(key);
          if (existing === 'selected') {
            game.highlight.removeHighlight(
              unit.position[0],
              unit.position[1],
            );
          } else {
            game.highlight.addHighlight(
              unit.position[0],
              unit.position[1],
              'selected',
            );
          }
        }
        break;
      }

      case 'AUX': {
        // Cycle cursor through available player units
        const playerUnits: UnitObject[] = game.board.getTeamUnits('player');
        const available = playerUnits.filter(
          (u) => u.canStillAct() && u.position,
        );
        if (available.length === 0) break;

        const cursorPos = game.cursor.getPosition();
        // Find next unit after the one at cursor (or wrap)
        let nextIdx = 0;
        for (let i = 0; i < available.length; i++) {
          const p = available[i].position!;
          if (p[0] === cursorPos[0] && p[1] === cursorPos[1]) {
            nextIdx = (i + 1) % available.length;
            break;
          }
        }
        const next = available[nextIdx];
        if (next && next.position) {
          game.cursor.setPos(next.position[0], next.position[1]);
          game.camera.focusTile(next.position[0], next.position[1]);
        }
        break;
      }

      case 'START':
        game.state.change('option_menu');
        break;
    }
  }

  override update(): StateResult {
    const game = getGame();
    // Update HUD hover info
    const pos = game.cursor.getHover();
    const unit = game.board.getUnit(pos.x, pos.y);
    const terrainNid = game.board.getTerrain(pos.x, pos.y);
    const terrainDef = terrainNid ? game.db.terrain.get(terrainNid) : null;
    game.hud.setHover(
      unit,
      terrainDef?.name ?? '',
      0, // TODO: terrain defense bonus from constants/equations
    );

    // Auto end-turn: if all player units are finished, advance
    const playerUnits: UnitObject[] = game.board.getTeamUnits('player');
    if (playerUnits.length > 0) {
      const allFinished = playerUnits.every((u) => u.finished || u.isDead());
      if (allFinished) {
        game.state.change('turn_change');
        return;
      }
    }
  }

  override draw(surf: Surface): Surface {
    const game = getGame();
    surf = drawMap(surf);
    // Draw HUD overlay
    game.hud.draw(surf, game.db);
    return surf;
  }
}

// ============================================================================
// 3. MoveState
// ============================================================================

export class MoveState extends MapState {
  readonly name = 'move';

  private validMoves: [number, number][] = [];
  private attackPositions: [number, number][] = [];
  private previousPosition: [number, number] | null = null;

  override begin(): StateResult {
    const game = getGame();
    const unit: UnitObject = game.selectedUnit;
    if (!unit || !unit.position) {
      game.state.back();
      return;
    }

    // If the unit already finished (e.g. returned from menu after Wait/Attack),
    // pop back to FreeState by clearing the selection and returning.
    if (unit.finished || !unit.canStillAct()) {
      game.selectedUnit = null;
      game._moveOrigin = null;
      game.highlight.clear();
      game.state.back();
      return 'repeat';
    }

    this.previousPosition = [unit.position[0], unit.position[1]];
    // Save origin so MenuState can undo the move
    game._moveOrigin = [unit.position[0], unit.position[1]];

    // Compute valid moves + attack positions
    this.validMoves = game.pathSystem.getValidMoves(unit, game.board);
    this.attackPositions = game.pathSystem.getAttackPositions(
      unit,
      game.board,
      this.validMoves,
    );

    // Show highlights
    game.highlight.clear();
    game.highlight.setMoveHighlights(this.validMoves);
    game.highlight.setAttackHighlights(this.attackPositions);
  }

  override takeInput(event: InputEvent): StateResult {
    const game = getGame();

    // Process mouse input for map interaction
    const mouseAction = processMouseForMap(event);
    const effective = mouseAction ?? event;

    if (effective === null) return;

    switch (effective) {
      case 'UP':
        moveCursor(0, -1);
        break;
      case 'DOWN':
        moveCursor(0, 1);
        break;
      case 'LEFT':
        moveCursor(-1, 0);
        break;
      case 'RIGHT':
        moveCursor(1, 0);
        break;

      case 'SELECT': {
        const pos = game.cursor.getHover();
        const isValid = this.validMoves.some(
          ([x, y]) => x === pos.x && y === pos.y,
        );
        if (isValid) {
          const unit: UnitObject = game.selectedUnit;

          // Compute path from the unit's current position (before moving on the board)
          const path = game.pathSystem.getPath(
            unit,
            pos.x,
            pos.y,
            game.board,
          );

          // Move unit on the board
          game.board.moveUnit(unit, pos.x, pos.y);
          unit.hasMoved = true;

          // If we have a path with length > 1, animate movement
          if (path && path.length > 1) {
            game.movementSystem.beginMove(unit, path, undefined, () => {
              // After movement animation completes, push menu
            });
            game.state.change('movement');
            // After movement, push menu
            game._pendingAfterMovement = 'menu';
          } else {
            // Already at destination or single tile, push menu directly
            game.state.change('menu');
          }
        }
        break;
      }

      case 'BACK':
        game.highlight.clear();
        game._moveOrigin = null;
        game.state.back();
        break;
    }
  }

  override draw(surf: Surface): Surface {
    const game = getGame();
    game.highlight.update();
    surf = drawMap(surf, true);

    // Draw path preview from unit to cursor
    const unit: UnitObject = game.selectedUnit;
    if (unit && unit.position) {
      const cursorPos = game.cursor.getHover();
      const isValid = this.validMoves.some(
        ([x, y]) => x === cursorPos.x && y === cursorPos.y,
      );
      if (isValid) {
        const cameraOffset = game.camera.getOffset();
        const path = game.pathSystem.getPath(
          unit,
          cursorPos.x,
          cursorPos.y,
          game.board,
        );
        if (path && path.length > 1) {
          for (const [px, py] of path) {
            const screenX = px * TILEWIDTH - cameraOffset[0];
            const screenY = py * TILEHEIGHT - cameraOffset[1];
            surf.fillRect(
              screenX + 4,
              screenY + 4,
              TILEWIDTH - 8,
              TILEHEIGHT - 8,
              'rgba(255,255,255,0.35)',
            );
          }
        }
      }
    }
    return surf;
  }

  override end(): StateResult {
    const game = getGame();
    game.highlight.clear();
  }
}

// ============================================================================
// 4. MenuState
// ============================================================================

export class MenuState extends State {
  readonly name = 'menu';
  override readonly transparent = true;

  private menu: ChoiceMenu | null = null;
  private previousPosition: [number, number] | null = null;

  override begin(): StateResult {
    const game = getGame();
    const unit: UnitObject = game.selectedUnit;
    if (!unit || !unit.position) {
      game.state.back();
      return;
    }

    // If the unit already finished (returned from a sub-state like ItemUse/Trade),
    // pop back so MoveState can clean up and return to FreeState.
    if (unit.finished || !unit.canStillAct()) {
      this.menu = null;
      game.state.back();
      return 'repeat';
    }

    this.previousPosition = game._moveOrigin ?? null;

    const options: MenuOption[] = [];
    const ux = unit.position[0];
    const uy = unit.position[1];

    // Attack option — only if enemies are in weapon range from current position
    const targets = getTargetsInRange(unit, ux, uy);
    if (targets.length > 0) {
      options.push({ label: 'Attack', value: 'attack', enabled: true });
    }

    // Item option — if unit has usable healing/consumable items
    if (unit.hasUsableItems()) {
      options.push({ label: 'Item', value: 'item', enabled: true });
    }

    // Trade option — if adjacent allied unit exists and unit hasn't traded/attacked
    if (unit.canTrade()) {
      const adjacentAllies = getAdjacentAllies(unit, ux, uy);
      if (adjacentAllies.length > 0) {
        options.push({ label: 'Trade', value: 'trade', enabled: true });
      }
    }

    // Rescue option — if adjacent allied unit that can be rescued
    const rescuableUnits = getAdjacentAllies(unit, ux, uy).filter(
      (ally) => !ally.isRescued() && !ally.isRescuing(),
    );
    if (rescuableUnits.length > 0 && !unit.isRescuing()) {
      options.push({ label: 'Rescue', value: 'rescue', enabled: true });
    }

    // Drop option — if unit is carrying a rescued unit
    if (unit.isRescuing()) {
      const dropTiles = getAdjacentEmptyTiles(ux, uy);
      if (dropTiles.length > 0) {
        options.push({ label: 'Drop', value: 'drop', enabled: true });
      }
    }

    // Visit / Seize / Talk — check regions at current position
    if (game.currentLevel?.regions) {
      for (const region of game.currentLevel.regions) {
        const [rx, ry] = region.position;
        const [rw, rh] = region.size;
        if (ux >= rx && ux < rx + rw && uy >= ry && uy < ry + rh) {
          const rtype = region.region_type.toLowerCase();
          if (rtype === 'village' || rtype === 'visit') {
            options.push({ label: 'Visit', value: `visit_${region.nid}`, enabled: true });
          } else if (rtype === 'shop' || rtype === 'armory' || rtype === 'vendor') {
            options.push({ label: 'Shop', value: `shop_${region.nid}`, enabled: true });
          } else if (rtype === 'seize') {
            options.push({ label: 'Seize', value: `seize_${region.nid}`, enabled: true });
          }
        }
      }
    }

    // Talk option — check if adjacent allied or enemy unit has a talk event
    // Simplified: check for adjacent units with 'talk' tag or talk events
    const adjacentTalkTargets = getAdjacentUnits(ux, uy).filter((other) => {
      if (other === unit) return false;
      // Check if there's a talk event between these two units
      if (game.eventManager) {
        const events = game.eventManager.getEventsForTrigger({
          type: 'unit_talk',
          unitA: unit.nid,
          unitB: other.nid,
        });
        return events.length > 0;
      }
      return false;
    });
    if (adjacentTalkTargets.length > 0) {
      options.push({ label: 'Talk', value: 'talk', enabled: true });
    }

    // Wait is always available
    options.push({ label: 'Wait', value: 'wait', enabled: true });

    // Position the menu near the unit
    const cameraOffset = game.camera.getOffset();
    const menuX = ux * TILEWIDTH - cameraOffset[0] + TILEWIDTH + 4;
    const menuY = uy * TILEHEIGHT - cameraOffset[1];

    // Clamp menu to screen
    const clampedX = Math.min(menuX, WINWIDTH - 60);
    const clampedY = Math.min(menuY, WINHEIGHT - options.length * 16 - 8);

    this.menu = new ChoiceMenu(options, clampedX, Math.max(0, clampedY));
  }

  override takeInput(event: InputEvent): StateResult {
    if (!this.menu) return;
    const game = getGame();

    // Handle mouse click on menu options
    let result: { selected: string } | { back: true } | null = null;
    if (game.input?.mouseClick) {
      const [gx, gy] = game.input.getGameMousePos();
      result = this.menu.handleClick(gx, gy, game.input.mouseClick as 'SELECT' | 'BACK');
    }
    // Handle mouse hover to highlight menu options
    if (game.input?.mouseMoved) {
      const [gx, gy] = game.input.getGameMousePos();
      this.menu.handleMouseHover(gx, gy);
    }
    // Fall through to keyboard input if mouse didn't produce a result
    if (!result && event !== null) {
      result = this.menu.handleInput(event);
    }
    if (!result) return;

    if ('back' in result) {
      // Undo move — put unit back at original position
      const unit: UnitObject = game.selectedUnit;
      if (unit && game._moveOrigin) {
        game.board.moveUnit(
          unit,
          game._moveOrigin[0],
          game._moveOrigin[1],
        );
        unit.hasMoved = false;
      }
      this.menu = null;
      game.state.back();
      return;
    }

    if ('selected' in result) {
      const value = result.selected;
      const unit: UnitObject = game.selectedUnit;

      if (value === 'attack') {
        this.menu = null;
        game.state.change('targeting');
      } else if (value === 'item') {
        this.menu = null;
        game.state.change('item_use');
      } else if (value === 'trade') {
        this.menu = null;
        game.state.change('trade');
      } else if (value === 'rescue') {
        this.menu = null;
        game.state.change('rescue');
      } else if (value === 'drop') {
        this.menu = null;
        game.state.change('drop');
      } else if (value.startsWith('visit_') || value.startsWith('shop_')) {
        // Trigger the region event
        const regionNid = value.split('_').slice(1).join('_');
        if (game.eventManager) {
          game.eventManager.trigger(
            { type: 'region_event', regionNid, unitNid: unit.nid },
            game.gameVars,
          );
        }
        if (unit) unit.finished = true;
        this.menu = null;
        game.state.back();
      } else if (value.startsWith('seize_')) {
        // Seize: mark level as won
        if (unit) unit.finished = true;
        this.menu = null;
        // Check win immediately
        if (game.checkWinCondition()) {
          console.warn('VICTORY — seize condition met');
          // TODO: push VictoryState
        }
        game.state.back();
      } else if (value === 'talk') {
        // Trigger talk event
        const adjacentTalkTargets = getAdjacentUnits(
          unit.position![0],
          unit.position![1],
        ).filter((other) => {
          if (other === unit) return false;
          if (game.eventManager) {
            const events = game.eventManager.getEventsForTrigger({
              type: 'unit_talk',
              unitA: unit.nid,
              unitB: other.nid,
            });
            return events.length > 0;
          }
          return false;
        });
        if (adjacentTalkTargets.length > 0 && game.eventManager) {
          game.eventManager.trigger(
            {
              type: 'unit_talk',
              unitA: unit.nid,
              unitB: adjacentTalkTargets[0].nid,
            },
            game.gameVars,
          );
        }
        if (unit) unit.finished = true;
        this.menu = null;
        game.state.back();
      } else if (value === 'wait') {
        if (unit) unit.finished = true;
        this.menu = null;
        game.state.back();
      }
    }
  }

  override draw(surf: Surface): Surface {
    if (this.menu) {
      this.menu.draw(surf);
    }
    return surf;
  }
}

// ============================================================================
// 4b. ItemUseState - Select and use a consumable item
// ============================================================================

export class ItemUseState extends State {
  readonly name = 'item_use';
  override readonly transparent = true;

  private menu: ChoiceMenu | null = null;
  private usableItems: ItemObject[] = [];

  override begin(): StateResult {
    const game = getGame();
    const unit: UnitObject = game.selectedUnit;
    if (!unit) {
      game.state.back();
      return;
    }

    this.usableItems = unit.getUsableItems();
    if (this.usableItems.length === 0) {
      game.state.back();
      return;
    }

    const options: MenuOption[] = this.usableItems.map((item, i) => ({
      label: item.name,
      value: `item_${i}`,
      enabled: true,
    }));

    // Position near the unit
    const cameraOffset = game.camera.getOffset();
    const menuX = unit.position
      ? unit.position[0] * TILEWIDTH - cameraOffset[0] + TILEWIDTH + 4
      : WINWIDTH / 2;
    const menuY = unit.position
      ? unit.position[1] * TILEHEIGHT - cameraOffset[1]
      : WINHEIGHT / 2;

    const clampedX = Math.min(menuX, WINWIDTH - 70);
    const clampedY = Math.min(menuY, WINHEIGHT - options.length * 16 - 8);

    this.menu = new ChoiceMenu(options, clampedX, Math.max(0, clampedY));
  }

  override takeInput(event: InputEvent): StateResult {
    if (!this.menu || event === null) return;
    const game = getGame();

    const result = this.menu.handleInput(event);
    if (!result) return;

    if ('back' in result) {
      this.menu = null;
      game.state.back();
      return;
    }

    if ('selected' in result) {
      const idx = parseInt(result.selected.replace('item_', ''), 10);
      const item = this.usableItems[idx];
      const unit: UnitObject = game.selectedUnit;

      if (item && unit) {
        // Apply item effect
        if (item.isHealing()) {
          const healAmount = item.getHealAmount();
          unit.currentHp = Math.min(unit.maxHp, unit.currentHp + healAmount);
        }
        if (item.isStatBooster()) {
          const changes = item.getStatChanges();
          for (const [stat, amount] of Object.entries(changes)) {
            if (unit.stats[stat] !== undefined) {
              unit.stats[stat] += amount;
            }
          }
        }

        // Decrement uses
        const broken = item.decrementUses();
        if (broken) {
          const itemIdx = unit.items.indexOf(item);
          if (itemIdx !== -1) unit.items.splice(itemIdx, 1);
        }

        // Using an item finishes the unit's turn
        unit.finished = true;
      }

      this.menu = null;
      game.state.back();
    }
  }

  override draw(surf: Surface): Surface {
    if (this.menu) {
      this.menu.draw(surf);
    }
    return surf;
  }
}

// ============================================================================
// 4c. TradeState - Trade items between adjacent allied units
// ============================================================================

export class TradeState extends State {
  readonly name = 'trade';
  override readonly transparent = true;

  private targetMenu: ChoiceMenu | null = null;
  private adjacentAllies: UnitObject[] = [];
  private tradePartner: UnitObject | null = null;

  // Item selection phase
  private itemMenuA: ChoiceMenu | null = null;
  private itemMenuB: ChoiceMenu | null = null;
  private selectedIndexA: number = -1;
  private phase: 'select_partner' | 'select_items' = 'select_partner';

  override begin(): StateResult {
    const game = getGame();
    const unit: UnitObject = game.selectedUnit;
    if (!unit || !unit.position) {
      game.state.back();
      return;
    }

    this.adjacentAllies = getAdjacentAllies(unit, unit.position[0], unit.position[1]);
    if (this.adjacentAllies.length === 0) {
      game.state.back();
      return;
    }

    if (this.adjacentAllies.length === 1) {
      // Only one partner, skip selection
      this.tradePartner = this.adjacentAllies[0];
      this.buildItemMenus(unit);
      this.phase = 'select_items';
    } else {
      const options: MenuOption[] = this.adjacentAllies.map((ally) => ({
        label: ally.name,
        value: ally.nid,
        enabled: true,
      }));

      this.targetMenu = new ChoiceMenu(options, WINWIDTH / 2 - 30, WINHEIGHT / 2 - 16);
      this.phase = 'select_partner';
    }
  }

  private buildItemMenus(unit: UnitObject): void {
    const partner = this.tradePartner!;

    // Build items list for unit A (current unit)
    const optionsA: MenuOption[] = unit.items.map((item, i) => ({
      label: item.name,
      value: `a_${i}`,
      enabled: true,
    }));
    // Add empty slot
    optionsA.push({ label: '---', value: 'a_empty', enabled: false });

    this.itemMenuA = new ChoiceMenu(optionsA, 4, 20);

    // Build items list for unit B (trade partner)
    const optionsB: MenuOption[] = partner.items.map((item, i) => ({
      label: item.name,
      value: `b_${i}`,
      enabled: true,
    }));
    optionsB.push({ label: '---', value: 'b_empty', enabled: false });

    this.itemMenuB = new ChoiceMenu(optionsB, WINWIDTH / 2 + 4, 20);
    this.selectedIndexA = -1;
  }

  override takeInput(event: InputEvent): StateResult {
    if (event === null) return;
    const game = getGame();

    if (this.phase === 'select_partner' && this.targetMenu) {
      const result = this.targetMenu.handleInput(event);
      if (!result) return;

      if ('back' in result) {
        this.targetMenu = null;
        game.state.back();
        return;
      }

      if ('selected' in result) {
        this.tradePartner = this.adjacentAllies.find((a) => a.nid === result.selected) ?? null;
        if (this.tradePartner) {
          this.buildItemMenus(game.selectedUnit);
          this.phase = 'select_items';
          this.targetMenu = null;
        }
      }
      return;
    }

    if (this.phase === 'select_items') {
      // Simplified trade: BACK exits, otherwise just swap first items
      if (event === 'BACK') {
        const unit: UnitObject = game.selectedUnit;
        if (unit) {
          unit.hasTraded = true;
          unit.finished = true;
        }
        game.state.back();
        return;
      }

      // For now, a simple swap of the first items from each unit
      if (event === 'SELECT') {
        const unit: UnitObject = game.selectedUnit;
        const partner = this.tradePartner;
        if (unit && partner && unit.items.length > 0 && partner.items.length > 0) {
          const itemA = unit.items[0];
          const itemB = partner.items[0];
          unit.items[0] = itemB;
          partner.items[0] = itemA;
          itemA.owner = partner;
          itemB.owner = unit;
        }
        if (unit) {
          unit.hasTraded = true;
          unit.finished = true;
        }
        game.state.back();
      }
    }
  }

  override draw(surf: Surface): Surface {
    if (this.phase === 'select_partner' && this.targetMenu) {
      this.targetMenu.draw(surf);
    }

    if (this.phase === 'select_items') {
      // Draw a simplified trade UI
      surf.fillRect(0, 0, WINWIDTH, WINHEIGHT, 'rgba(0,0,32,0.7)');

      const game = getGame();
      const unit: UnitObject = game.selectedUnit;
      const partner = this.tradePartner;

      // Unit A items
      surf.drawText(unit?.name ?? '', 4, 4, 'white', '8px monospace');
      if (unit) {
        unit.items.forEach((item, i) => {
          surf.drawText(item.name, 8, 16 + i * 12, 'rgba(200,200,255,1)', '7px monospace');
        });
      }

      // Unit B items
      const bx = WINWIDTH / 2 + 4;
      surf.drawText(partner?.name ?? '', bx, 4, 'white', '8px monospace');
      if (partner) {
        partner.items.forEach((item, i) => {
          surf.drawText(item.name, bx + 4, 16 + i * 12, 'rgba(200,200,255,1)', '7px monospace');
        });
      }

      surf.drawText('SELECT to swap, BACK to finish', 4, WINHEIGHT - 12, 'rgba(160,160,200,1)', '7px monospace');
    }

    return surf;
  }
}

// ============================================================================
// 4d. RescueState - Select an adjacent ally to rescue
// ============================================================================

export class RescueState extends State {
  readonly name = 'rescue';
  override readonly transparent = true;

  private menu: ChoiceMenu | null = null;
  private rescuableUnits: UnitObject[] = [];

  override begin(): StateResult {
    const game = getGame();
    const unit: UnitObject = game.selectedUnit;
    if (!unit || !unit.position) {
      game.state.back();
      return;
    }

    this.rescuableUnits = getAdjacentAllies(unit, unit.position[0], unit.position[1])
      .filter((ally) => !ally.isRescued() && !ally.isRescuing());

    if (this.rescuableUnits.length === 0) {
      game.state.back();
      return;
    }

    const options: MenuOption[] = this.rescuableUnits.map((ally) => ({
      label: ally.name,
      value: ally.nid,
      enabled: true,
    }));

    this.menu = new ChoiceMenu(options, WINWIDTH / 2 - 30, WINHEIGHT / 2 - 16);
  }

  override takeInput(event: InputEvent): StateResult {
    if (!this.menu || event === null) return;
    const game = getGame();

    const result = this.menu.handleInput(event);
    if (!result) return;

    if ('back' in result) {
      this.menu = null;
      game.state.back();
      return;
    }

    if ('selected' in result) {
      const target = this.rescuableUnits.find((u) => u.nid === result.selected);
      const unit: UnitObject = game.selectedUnit;

      if (target && unit) {
        // Remove target from board
        game.board.removeUnit(target);
        // Set rescue references
        unit.rescuing = target;
        target.rescuedBy = unit;
        // Finish the unit's turn
        unit.finished = true;
      }

      this.menu = null;
      game.state.back();
    }
  }

  override draw(surf: Surface): Surface {
    if (this.menu) {
      this.menu.draw(surf);
    }
    return surf;
  }
}

// ============================================================================
// 4e. DropState - Select a tile to drop a rescued unit
// ============================================================================

export class DropState extends MapState {
  readonly name = 'drop';

  private dropTiles: [number, number][] = [];

  override begin(): StateResult {
    const game = getGame();
    const unit: UnitObject = game.selectedUnit;
    if (!unit || !unit.position || !unit.rescuing) {
      game.state.back();
      return;
    }

    this.dropTiles = getAdjacentEmptyTiles(unit.position[0], unit.position[1]);

    if (this.dropTiles.length === 0) {
      game.state.back();
      return;
    }

    // Highlight drop tiles
    game.highlight.clear();
    for (const [tx, ty] of this.dropTiles) {
      game.highlight.addHighlight(tx, ty, 'move');
    }

    // Position cursor on first drop tile
    game.cursor.setPos(this.dropTiles[0][0], this.dropTiles[0][1]);
  }

  override takeInput(event: InputEvent): StateResult {
    const game = getGame();

    // Process mouse input for map interaction
    const mouseAction = processMouseForMap(event);
    const effective = mouseAction ?? event;

    if (effective === null) return;

    switch (effective) {
      case 'UP':
        moveCursor(0, -1);
        break;
      case 'DOWN':
        moveCursor(0, 1);
        break;
      case 'LEFT':
        moveCursor(-1, 0);
        break;
      case 'RIGHT':
        moveCursor(1, 0);
        break;

      case 'SELECT': {
        const pos = game.cursor.getHover();
        const isValid = this.dropTiles.some(([x, y]) => x === pos.x && y === pos.y);
        if (isValid) {
          const unit: UnitObject = game.selectedUnit;
          const target = unit?.rescuing;
          if (unit && target) {
            // Drop the rescued unit
            unit.rescuing = null;
            target.rescuedBy = null;
            game.board.setUnit(pos.x, pos.y, target);
            // Finish unit's turn
            unit.finished = true;
          }
          game.highlight.clear();
          game.state.back();
        }
        break;
      }

      case 'BACK':
        game.highlight.clear();
        game.state.back();
        break;
    }
  }

  override draw(surf: Surface): Surface {
    const game = getGame();
    game.highlight.update();
    return drawMap(surf, true);
  }

  override end(): StateResult {
    const game = getGame();
    game.highlight.clear();
  }
}

// ============================================================================
// 5. TargetingState
// ============================================================================

export class TargetingState extends MapState {
  readonly name = 'targeting';

  private targets: UnitObject[] = [];
  private targetIndex: number = 0;

  override begin(): StateResult {
    const game = getGame();
    const unit: UnitObject = game.selectedUnit;
    if (!unit || !unit.position) {
      game.state.back();
      return;
    }

    // If the unit already finished (returned from combat), pop back.
    if (unit.finished || !unit.canStillAct()) {
      game.highlight.clear();
      game.state.back();
      return 'repeat';
    }

    // Get valid targets
    this.targets = getTargetsInRange(
      unit,
      unit.position[0],
      unit.position[1],
    );
    this.targetIndex = 0;

    if (this.targets.length === 0) {
      game.state.back();
      return;
    }

    // Show attack range highlights
    game.highlight.clear();
    const weapon = getEquippedWeapon(unit);
    if (weapon) {
      const minRange = weapon.getMinRange();
      const maxRange = weapon.getMaxRange();
      const attackTiles: [number, number][] = [];
      const ux = unit.position[0];
      const uy = unit.position[1];
      for (let dx = -maxRange; dx <= maxRange; dx++) {
        for (let dy = -maxRange; dy <= maxRange; dy++) {
          const dist = Math.abs(dx) + Math.abs(dy);
          if (dist >= minRange && dist <= maxRange) {
            const tx = ux + dx;
            const ty = uy + dy;
            if (game.board.inBounds(tx, ty)) {
              attackTiles.push([tx, ty]);
            }
          }
        }
      }
      game.highlight.setAttackHighlights(attackTiles);
    }

    // Position cursor on first target
    this.focusTarget();
  }

  private focusTarget(): void {
    const game = getGame();
    const target = this.targets[this.targetIndex];
    if (target && target.position) {
      game.cursor.setPos(target.position[0], target.position[1]);
      game.camera.focusTile(target.position[0], target.position[1]);
    }
  }

  override takeInput(event: InputEvent): StateResult {
    const game = getGame();

    // Mouse: clicking directly on a valid target selects it
    if (game.input?.mouseClick === 'SELECT') {
      const tile = getMouseTile();
      if (tile) {
        const clickedTargetIdx = this.targets.findIndex(
          (t) => t.position && t.position[0] === tile[0] && t.position[1] === tile[1],
        );
        if (clickedTargetIdx >= 0) {
          this.targetIndex = clickedTargetIdx;
          const target = this.targets[this.targetIndex];
          game.combatTarget = target;
          game.highlight.clear();
          game.state.change('combat');
          return;
        }
      }
    }
    if (game.input?.mouseClick === 'BACK') {
      game.highlight.clear();
      game.state.back();
      return;
    }

    if (event === null) return;

    switch (event) {
      case 'UP':
      case 'LEFT':
        // Cycle to previous target
        if (this.targets.length > 0) {
          this.targetIndex =
            (this.targetIndex - 1 + this.targets.length) % this.targets.length;
          this.focusTarget();
        }
        break;

      case 'DOWN':
      case 'RIGHT':
        // Cycle to next target
        if (this.targets.length > 0) {
          this.targetIndex =
            (this.targetIndex + 1) % this.targets.length;
          this.focusTarget();
        }
        break;

      case 'SELECT': {
        const target = this.targets[this.targetIndex];
        if (target) {
          game.combatTarget = target;
          game.highlight.clear();
          game.state.change('combat');
        }
        break;
      }

      case 'BACK':
        game.highlight.clear();
        game.state.back();
        break;
    }
  }

  override draw(surf: Surface): Surface {
    const game = getGame();
    game.highlight.update();
    surf = drawMap(surf, true);

    // Draw target info overlay
    const target = this.targets[this.targetIndex];
    if (target) {
      const unit: UnitObject = game.selectedUnit;
      const weapon = getEquippedWeapon(unit);
      if (weapon && target.position) {
        const cameraOffset = game.camera.getOffset();
        const tx = target.position[0] * TILEWIDTH - cameraOffset[0];
        const ty = target.position[1] * TILEHEIGHT - cameraOffset[1];

        // Highlight target tile
        surf.fillRect(tx, ty, TILEWIDTH, TILEHEIGHT, 'rgba(255,0,0,0.3)');

        // Show target name/HP at top of screen
        surf.fillRect(0, 0, WINWIDTH, 16, 'rgba(0,0,0,0.7)');
        surf.drawText(
          `${target.name}  HP: ${target.currentHp}/${target.maxHp}`,
          4,
          4,
          'white',
          '8px monospace',
        );
      }
    }
    return surf;
  }

  override end(): StateResult {
    const game = getGame();
    game.highlight.clear();
  }
}

// ============================================================================
// 6. CombatState
// ============================================================================

/**
 * CombatState phases:
 * 1. 'combat' - Running the MapCombat animation (strikes, HP drain)
 * 2. 'death' - Death animation timer (fade-out)
 * 3. 'exp' - EXP bar animation
 * 4. 'levelup' - Level-up stat display
 * 5. 'cleanup' - Check win/loss, transition out
 */
type CombatPhase = 'combat' | 'death' | 'exp' | 'levelup' | 'cleanup';

export class CombatState extends State {
  readonly name = 'combat';
  override readonly transparent = true;

  private combat: MapCombat | null = null;
  private animCombat: AnimationCombat | null = null;
  private isAnimationCombat: boolean = false;
  private results: CombatResults | null = null;
  private phase: CombatPhase = 'combat';
  private phaseTimer: number = 0;

  // EXP bar animation
  private expDisplayStart: number = 0;
  private expDisplayTarget: number = 0;
  private expDisplayCurrent: number = 0;

  // Level-up display
  private levelUpGains: Record<string, number> | null = null;

  // Death fade
  private deathFadeProgress: number = 0;

  // Platform images for animation combat
  private leftPlatformImg: HTMLImageElement | null = null;
  private rightPlatformImg: HTMLImageElement | null = null;

  // Battle background panorama image
  private battleBackgroundImg: HTMLImageElement | null = null;

  /** Get whichever combat controller is active (AnimationCombat or MapCombat). */
  private getActiveCombat(): MapCombat | AnimationCombat | null {
    return this.isAnimationCombat ? this.animCombat : this.combat;
  }

  override begin(): StateResult {
    const game = getGame();
    const attacker: UnitObject = game.selectedUnit;
    const defender: UnitObject = game.combatTarget;

    if (!attacker || !defender) {
      game.state.back();
      return;
    }

    const attackItem = getEquippedWeapon(attacker);
    if (!attackItem) {
      game.state.back();
      return;
    }

    const defenseItem = getEquippedWeapon(defender);
    const rngMode = game.db.getConstant('rng_mode', 'true_hit') as any;

    // Check if both units have battle animations available
    const canAnimate = this.tryCreateAnimationCombat(
      attacker, attackItem, defender, defenseItem, rngMode, game,
    );

    if (canAnimate) {
      this.isAnimationCombat = true;
      this.combat = null;
      console.log(`CombatState: using AnimationCombat (${attacker.name} vs ${defender.name})`);
    } else {
      // Fallback to map combat
      this.isAnimationCombat = false;
      this.animCombat = null;
      this.combat = new MapCombat(
        attacker,
        attackItem,
        defender,
        defenseItem,
        game.db,
        rngMode,
      );
      console.log(`CombatState: using MapCombat (${attacker.name} vs ${defender.name})`);
    }

    this.results = null;
    this.phase = 'combat';
    this.phaseTimer = 0;
    this.deathFadeProgress = 0;
    this.levelUpGains = null;
  }

  /**
   * Try to create an AnimationCombat. Returns true if successful.
   * Requires both units to have combat animations defined in their classes,
   * and those animations must be loaded in the database.
   */
  private tryCreateAnimationCombat(
    attacker: UnitObject,
    attackItem: ItemObject,
    defender: UnitObject,
    defenseItem: ItemObject | null,
    rngMode: string,
    game: any,
  ): boolean {
    try {
      const db = game.db;
      if (!db.combatAnims || db.combatAnims.size === 0) return false;

      // Look up combat anim NIDs from unit classes
      const atkKlass = db.classes.get(attacker.klass);
      const defKlass = db.classes.get(defender.klass);
      if (!atkKlass?.combat_anim_nid || !defKlass?.combat_anim_nid) return false;

      const atkAnimData = db.combatAnims.get(atkKlass.combat_anim_nid);
      const defAnimData = db.combatAnims.get(defKlass.combat_anim_nid);
      if (!atkAnimData || !defAnimData) return false;

      // Determine weapon type for selecting the weapon animation
      const atkWeaponType = attackItem.getWeaponType() ?? null;
      const defWeaponType = defenseItem?.getWeaponType() ?? null;

      // Select weapon animations
      const atkWeaponAnim = selectWeaponAnim(atkAnimData, atkWeaponType ?? null);
      const defWeaponAnim = selectWeaponAnim(defAnimData, defWeaponType ?? null);
      if (!atkWeaponAnim || !defWeaponAnim) return false;

      // Create BattleAnimation instances with real pose data but empty frames
      // (sprites will hot-swap in once async loading completes)
      const atkAnim = new RealBattleAnimation(atkWeaponAnim, new Map());
      const defAnim = new RealBattleAnimation(defWeaponAnim, new Map());

      // Determine left/right assignment (player on right)
      let leftIsAttacker = true;
      if (defender.team === 'player' && attacker.team !== 'player') {
        leftIsAttacker = true; // attacker (enemy) on left, defender (player) on right
      } else if (attacker.team === 'player') {
        leftIsAttacker = false; // attacker (player) on right, defender on left
      }

      const leftAnim = leftIsAttacker ? atkAnim : defAnim;
      const rightAnim = leftIsAttacker ? defAnim : atkAnim;

      this.animCombat = new AnimationCombat(
        attacker,
        attackItem,
        defender,
        defenseItem,
        db,
        rngMode,
        leftAnim,
        rightAnim,
        leftIsAttacker,
      );

      // Load platform images asynchronously (they'll appear once loaded)
      const isMelee = this.animCombat.combatRange <= 1;
      const leftUnit = leftIsAttacker ? attacker : defender;
      const rightUnit = leftIsAttacker ? defender : attacker;
      const leftPlatformType = this.getUnitPlatformType(leftUnit, db) ?? 'Plains';
      const rightPlatformType = this.getUnitPlatformType(rightUnit, db) ?? 'Plains';
      loadBattlePlatforms(leftPlatformType, rightPlatformType, isMelee).then(([left, right]) => {
        this.leftPlatformImg = left;
        this.rightPlatformImg = right;
      });

      // Load battle background panorama based on attacker's terrain
      const bgNid = this.getUnitBackgroundNid(attacker, db);
      if (bgNid) {
        const resources = getGame().resources;
        resources.loadPanorama(bgNid).then((img: HTMLImageElement) => {
          this.battleBackgroundImg = img;
        }).catch(() => {
          // Panorama not found — fall back to solid color background
        });
      }

      // Load and apply spritesheets asynchronously (sprites hot-swap in once ready)
      this.loadCombatSprites(
        atkAnimData.nid, atkWeaponAnim, attacker, atkAnimData, atkAnim,
        defAnimData.nid, defWeaponAnim, defender, defAnimData, defAnim,
        db,
      );

      return true;
    } catch (e) {
      console.warn('Failed to create AnimationCombat, falling back to MapCombat:', e);
      return false;
    }
  }

  /** Look up the terrain definition for a unit's map position. */
  private getUnitTerrain(unit: UnitObject, db: any): any | null {
    if (!unit.position) return null;
    const game = getGame();
    if (!game.tilemap) return null;

    // TileMapObject.getTerrain walks layers top-to-bottom
    const terrainNid = game.tilemap.getTerrain(unit.position[0], unit.position[1]);
    if (!terrainNid) return null;

    return db.terrain?.get(terrainNid) ?? null;
  }

  /** Look up the platform type for a unit's terrain tile. */
  private getUnitPlatformType(unit: UnitObject, db: any): string | null {
    const terrain = this.getUnitTerrain(unit, db);
    if (!terrain?.platform) return 'Plains';
    return terrain.platform;
  }

  /** Look up the panorama background NID for a unit's terrain tile. */
  private getUnitBackgroundNid(unit: UnitObject, db: any): string | null {
    const terrain = this.getUnitTerrain(unit, db);
    return terrain?.background ?? null;
  }

  /**
   * Asynchronously load and palette-convert combat animation spritesheets.
   * Once loaded, the frame images are hot-swapped into the BattleAnimation
   * instances so sprites appear mid-scene if loading takes time.
   */
  private async loadCombatSprites(
    atkAnimNid: string,
    atkWeaponAnim: import('../../combat/battle-anim-types').WeaponAnimData,
    attacker: UnitObject,
    atkCombatAnimData: import('../../combat/battle-anim-types').CombatAnimData,
    atkBattleAnim: RealBattleAnimation,
    defAnimNid: string,
    defWeaponAnim: import('../../combat/battle-anim-types').WeaponAnimData,
    defender: UnitObject,
    defCombatAnimData: import('../../combat/battle-anim-types').CombatAnimData,
    defBattleAnim: RealBattleAnimation,
    db: any,
  ): Promise<void> {
    try {
      const resources = getGame().resources;
      const palettes = db.combatPalettes as Map<string, import('../../combat/battle-anim-types').PaletteData>;

      // Select palettes for each unit
      const atkPalette = selectPalette(atkCombatAnimData, attacker, palettes);
      const defPalette = selectPalette(defCombatAnimData, defender, palettes);

      // Load both spritesheets in parallel
      const [atkFrames, defFrames] = await Promise.all([
        atkPalette
          ? loadAndConvertWeaponAnim(resources, atkAnimNid, atkWeaponAnim, atkPalette)
          : null,
        defPalette
          ? loadAndConvertWeaponAnim(resources, defAnimNid, defWeaponAnim, defPalette)
          : null,
      ]);

      // Hot-swap frame images into the running BattleAnimation instances
      if (atkFrames && atkFrames.size > 0) {
        for (const [nid, canvas] of atkFrames) {
          atkBattleAnim.frameImages.set(nid, canvas);
        }
      }
      if (defFrames && defFrames.size > 0) {
        for (const [nid, canvas] of defFrames) {
          defBattleAnim.frameImages.set(nid, canvas);
        }
      }
    } catch (e) {
      console.warn('Failed to load combat animation sprites:', e);
    }
  }

  override update(): StateResult {
    const activeCombat = this.isAnimationCombat ? this.animCombat : this.combat;
    if (!activeCombat) return;
    const game = getGame();

    switch (this.phase) {
      case 'combat': {
        const done = activeCombat.update(FRAMETIME);
        if (done) {
          this.results = activeCombat.applyResults();
          if (this.results.attackerDead || this.results.defenderDead) {
            this.phase = 'death';
            this.phaseTimer = 0;
            this.deathFadeProgress = 0;
          } else if (this.results.expGained > 0 && activeCombat.attacker.team === 'player') {
            this.startExpPhase();
          } else {
            this.phase = 'cleanup';
            this.phaseTimer = 0;
          }
        }
        break;
      }

      case 'death': {
        // Death animation: 500ms fade-out
        this.phaseTimer += FRAMETIME;
        this.deathFadeProgress = Math.min(1, this.phaseTimer / 500);
        if (this.phaseTimer >= 500) {
          // Remove dead units from board
          if (this.results!.defenderDead) {
            game.board.removeUnit(activeCombat!.defender);
          }
          if (this.results!.attackerDead) {
            game.board.removeUnit(activeCombat!.attacker);
          }

          // Check if attacker earned EXP
          if (
            !this.results!.attackerDead &&
            this.results!.expGained > 0 &&
            activeCombat!.attacker.team === 'player'
          ) {
            this.startExpPhase();
          } else {
            this.phase = 'cleanup';
            this.phaseTimer = 0;
          }
        }
        break;
      }

      case 'exp': {
        // Animate EXP bar fill over 500ms
        this.phaseTimer += FRAMETIME;
        const t = Math.min(1, this.phaseTimer / 500);
        this.expDisplayCurrent = this.expDisplayStart + (this.expDisplayTarget - this.expDisplayStart) * t;

        if (t >= 1) {
          // Check for level-ups
          if (this.results!.levelUps.length > 0) {
            this.levelUpGains = this.results!.levelUps[0];
            this.phase = 'levelup';
            this.phaseTimer = 0;
          } else {
            this.phase = 'cleanup';
            this.phaseTimer = 0;
          }
        }
        break;
      }

      case 'levelup': {
        // Show level-up stats for 1500ms
        this.phaseTimer += FRAMETIME;
        if (this.phaseTimer >= 1500) {
          this.phase = 'cleanup';
          this.phaseTimer = 0;
        }
        break;
      }

      case 'cleanup': {
        const attacker = activeCombat!.attacker;
        const hasCanto = attacker.hasCanto && attacker.team === 'player' && !attacker.isDead();

        if (!attacker.isDead()) {
          attacker.hasAttacked = true;

          // Check for Canto: if the unit has canto, don't mark as finished
          if (hasCanto) {
            attacker.finished = false;
          } else {
            attacker.finished = true;
          }
        }

        // Check win/loss conditions
        if (game.checkLossCondition()) {
          console.warn('GAME OVER — loss condition met');
          // TODO: push a GameOverState
        } else if (game.checkWinCondition()) {
          console.warn('VICTORY — win condition met');
          // TODO: push a VictoryState / trigger level_end event
        }

        // Clear combat animation offsets
        setActiveCombatOffsets(null);

        this.combat = null;
        this.animCombat = null;
        this.isAnimationCombat = false;
        this.results = null;
        this.leftPlatformImg = null;
        this.rightPlatformImg = null;
        this.battleBackgroundImg = null;

        // Pop combat state
        game.state.back();

        // If Canto, re-enter move state for remaining movement
        if (hasCanto) {
          game.selectedUnit = attacker;
          game.state.change('move');
        }
        break;
      }
    }
  }

  private startExpPhase(): void {
    // EXP bar starts at the attacker's current EXP before gain
    // (applyResults already applied it, so we calculate backwards)
    const totalExp = this.results!.expGained;
    const activeCombat = this.getActiveCombat();
    const currentExp = activeCombat!.attacker.exp;
    // If level-ups happened, the bar wraps around 100
    if (this.results!.levelUps.length > 0) {
      this.expDisplayStart = 0;
      this.expDisplayTarget = currentExp;
    } else {
      this.expDisplayStart = currentExp - totalExp;
      this.expDisplayTarget = currentExp;
    }
    this.expDisplayCurrent = this.expDisplayStart;
    this.phase = 'exp';
    this.phaseTimer = 0;
  }

  override end(): StateResult {
    // Always clear combat animation offsets when this state exits
    setActiveCombatOffsets(null);
  }

  override draw(surf: Surface): Surface {
    // Route to the appropriate renderer
    if (this.isAnimationCombat && this.animCombat) {
      return this.drawAnimationCombat(surf);
    }
    if (!this.combat) return surf;
    return this.drawMapCombat(surf);
  }

  /** Render map combat: overlays on top of the map (lunge, flash, HP bars, etc.) */
  private drawMapCombat(surf: Surface): Surface {
    const rs = this.combat!.getRenderState();
    const game = getGame();
    const cameraOffset = game.camera.getOffset();

    const atkPos = this.combat!.attacker.position;
    const defPos = this.combat!.defender.position;

    // Push combat animation offsets so collectVisibleUnits applies them
    // to the underlying map render (lunge + shake on the actual sprites)
    const atkLunge = rs.attackerAnim.lungeOffset;
    const atkShake = rs.attackerAnim.shakeOffset;
    const defLunge = rs.defenderAnim.lungeOffset;
    const defShake = rs.defenderAnim.shakeOffset;
    setActiveCombatOffsets({
      attacker: this.combat!.attacker,
      defender: this.combat!.defender,
      attackerOffset: [atkLunge[0] + atkShake[0], atkLunge[1] + atkShake[1]],
      defenderOffset: [defLunge[0] + defShake[0], defLunge[1] + defShake[1]],
    });

    // White flash overlay on hit targets
    if (rs.attackerAnim.flashAlpha > 0 && atkPos) {
      const fx = atkPos[0] * TILEWIDTH - cameraOffset[0];
      const fy = atkPos[1] * TILEHEIGHT - cameraOffset[1];
      surf.fillRect(
        fx - 4, fy - 4,
        TILEWIDTH + 8, TILEHEIGHT + 8,
        `rgba(255,255,255,${rs.attackerAnim.flashAlpha.toFixed(2)})`,
      );
    }
    if (rs.defenderAnim.flashAlpha > 0 && defPos) {
      const fx = defPos[0] * TILEWIDTH - cameraOffset[0];
      const fy = defPos[1] * TILEHEIGHT - cameraOffset[1];
      surf.fillRect(
        fx - 4, fy - 4,
        TILEWIDTH + 8, TILEHEIGHT + 8,
        `rgba(255,255,255,${rs.defenderAnim.flashAlpha.toFixed(2)})`,
      );
    }

    // HP bars (positioned above the unit, accounting for shake/lunge)
    if (atkPos) {
      const atkShakeX = rs.attackerAnim.shakeOffset[0] + rs.attackerAnim.lungeOffset[0];
      const ax = atkPos[0] * TILEWIDTH - cameraOffset[0] + atkShakeX;
      const ay = atkPos[1] * TILEHEIGHT - cameraOffset[1] - 6;
      this.drawHpBar(surf, ax, ay, rs.attackerHp, rs.attackerMaxHp);
    }
    if (defPos) {
      const defShakeX = rs.defenderAnim.shakeOffset[0] + rs.defenderAnim.lungeOffset[0];
      const dx = defPos[0] * TILEWIDTH - cameraOffset[0] + defShakeX;
      const dy = defPos[1] * TILEHEIGHT - cameraOffset[1] - 6;
      this.drawHpBar(surf, dx, dy, rs.defenderHp, rs.defenderMaxHp);
    }

    // Floating damage numbers
    this.drawDamagePopupsMap(surf, rs.damagePopups, cameraOffset);

    // Death fade-out: dim the dying unit's tile with white overlay
    if (this.phase === 'death') {
      const alpha = this.deathFadeProgress * 0.85;
      if (this.results?.defenderDead && defPos) {
        const dx = defPos[0] * TILEWIDTH - cameraOffset[0];
        const dy = defPos[1] * TILEHEIGHT - cameraOffset[1];
        surf.fillRect(dx - 24, dy - 32, 64, 48, `rgba(255,255,255,${alpha.toFixed(2)})`);
      }
      if (this.results?.attackerDead && atkPos) {
        const ax = atkPos[0] * TILEWIDTH - cameraOffset[0];
        const ay = atkPos[1] * TILEHEIGHT - cameraOffset[1];
        surf.fillRect(ax - 24, ay - 32, 64, 48, `rgba(255,255,255,${alpha.toFixed(2)})`);
      }
    }

    // EXP / Level-up overlays (shared with animation combat)
    this.drawExpAndLevelUp(surf);

    return surf;
  }

  // ================================================================
  // Animation Combat Renderer — GBA-style full-screen battle scene
  // ================================================================

  /** Render the GBA-style animation combat scene. */
  private drawAnimationCombat(surf: Surface): Surface {
    const rs = this.animCombat!.getRenderState();

    // Apply screen shake to the entire scene
    const shakeX = rs.screenShake[0];
    const shakeY = rs.screenShake[1];

    // --- Viewbox iris during fade_in/fade_out ---
    // During transitions, the map is visible and we darken around a shrinking/growing iris.
    if (rs.viewbox) {
      const vb = rs.viewbox;
      // Darken everything outside the viewbox iris
      // Top bar
      if (vb.y > 0) {
        surf.fillRect(0, 0, WINWIDTH, Math.max(0, vb.y), 'rgba(0,0,0,0.85)');
      }
      // Bottom bar
      const botY = vb.y + vb.height;
      if (botY < WINHEIGHT) {
        surf.fillRect(0, botY, WINWIDTH, WINHEIGHT - botY, 'rgba(0,0,0,0.85)');
      }
      // Left bar (between top and bottom bars)
      if (vb.x > 0) {
        surf.fillRect(0, Math.max(0, vb.y), vb.x, Math.max(0, vb.height), 'rgba(0,0,0,0.85)');
      }
      // Right bar
      const rightX = vb.x + vb.width;
      if (rightX < WINWIDTH) {
        surf.fillRect(rightX, Math.max(0, vb.y), WINWIDTH - rightX, Math.max(0, vb.height), 'rgba(0,0,0,0.85)');
      }

      // If still fading in, don't draw the battle scene yet
      if (rs.state === 'fade_in') {
        return surf;
      }
    }

    // --- Full battle scene background ---
    // Once past fade_in, fill the screen with the battle background
    if (rs.state !== 'fade_in') {
      // Dark fallback fill (in case panorama hasn't loaded or is missing)
      surf.fillRect(shakeX, shakeY, WINWIDTH, WINHEIGHT, 'rgb(16,20,32)');
      // Draw the panorama background image if available
      if (this.battleBackgroundImg) {
        const bgW = this.battleBackgroundImg.naturalWidth || WINWIDTH;
        const bgH = this.battleBackgroundImg.naturalHeight || WINHEIGHT;
        surf.drawImageFull(this.battleBackgroundImg, shakeX, shakeY, bgW, bgH);
      }
    }

    // --- Platforms ---
    // GBA-style: left platform on the left, right platform on the right.
    // Melee platforms: 87x40, Ranged: 100x40. Positioned at WINHEIGHT - 72 = 88.
    const isMelee = this.animCombat!.combatRange <= 1;
    const PLAT_W = isMelee ? 87 : 100;
    const PLAT_H = 40;
    const SCENE_FLOOR_Y = WINHEIGHT - 72; // 88

    // Melee: platforms touch at center. Ranged: gap with pan offset.
    let leftPlatX: number;
    let rightPlatX: number;
    if (isMelee) {
      leftPlatX = Math.floor(WINWIDTH / 2) - PLAT_W + shakeX;
      rightPlatX = Math.floor(WINWIDTH / 2) + shakeX;
    } else {
      leftPlatX = Math.floor(WINWIDTH / 2) - PLAT_W - 11 + shakeX - rs.panOffset;
      rightPlatX = Math.floor(WINWIDTH / 2) + 11 + shakeX + rs.panOffset;
    }
    const leftPlatY = SCENE_FLOOR_Y + rs.leftPlatformY + rs.platformShakeY + shakeY;
    const rightPlatY = SCENE_FLOOR_Y + rs.rightPlatformY + rs.platformShakeY + shakeY;

    // Draw platforms (real images or fallback rectangles)
    if (this.leftPlatformImg) {
      const pw = this.leftPlatformImg.naturalWidth || PLAT_W;
      const ph = this.leftPlatformImg.naturalHeight || PLAT_H;
      surf.drawImageFull(this.leftPlatformImg, leftPlatX, leftPlatY, pw, ph);
    } else {
      surf.fillRect(leftPlatX, leftPlatY, PLAT_W, PLAT_H, 'rgb(60,80,50)');
      surf.fillRect(leftPlatX, leftPlatY, PLAT_W, 2, 'rgb(90,120,70)');
    }
    if (this.rightPlatformImg) {
      // Right platform is drawn horizontally flipped
      const pw = this.rightPlatformImg.naturalWidth || PLAT_W;
      const ph = this.rightPlatformImg.naturalHeight || PLAT_H;
      surf.drawImageFull(this.rightPlatformImg, rightPlatX, rightPlatY, pw, ph, 1, true);
    } else {
      surf.fillRect(rightPlatX, rightPlatY, PLAT_W, PLAT_H, 'rgb(60,80,50)');
      surf.fillRect(rightPlatX, rightPlatY, PLAT_W, 2, 'rgb(90,120,70)');
    }

    // --- Battle sprites ---
    // Draw under-frames, then main frames, then over-frames.
    // Each frame has an offset in 240x160 screen coords + recoil.
    const leftDraw = rs.leftDraw;
    const rightDraw = rs.rightDraw;

    // Helper to draw a single BattleAnimDrawData
    const drawBattleSprite = (
      draw: BattleAnimDrawData,
      fallbackColor: string,
      platformX: number,
      platformY: number,
    ) => {
      const alpha = Math.max(0, Math.min(1, draw.opacity / 255));
      if (alpha <= 0) return;

      // Determine canvas composite mode
      const prevComposite = surf.ctx.globalCompositeOperation;
      if (draw.blendMode === 'add') {
        surf.ctx.globalCompositeOperation = 'lighter';
      }

       // Left-side sprites (right=false) need horizontal flip since
      // animation frames are authored facing left (for right-side position).
      const flipSprite = !draw.right;

      // Draw under-frame first (behind platform)
      this.drawAnimFrame(surf, draw.underFrame, alpha, shakeX, shakeY, draw.recoilX, flipSprite);

      // Draw main frame
      if (draw.mainFrame) {
        this.drawAnimFrame(surf, draw.mainFrame, alpha, shakeX, shakeY, draw.recoilX, flipSprite);
      } else {
        // Stub placeholder: colored rectangle on the platform
        const STUB_W = 32;
        const STUB_H = 40;
        const stubX = platformX + (PLAT_W - STUB_W) / 2;
        const stubY = platformY - STUB_H;
        surf.fillRect(stubX, stubY, STUB_W, STUB_H, `rgba(${fallbackColor},${alpha.toFixed(2)})`);
        surf.fillRect(stubX + STUB_W / 2 - 4, stubY + 2, 8, 8, `rgba(200,180,150,${alpha.toFixed(2)})`);
      }

      // Draw over-frame on top
      this.drawAnimFrame(surf, draw.overFrame, alpha, shakeX, shakeY, draw.recoilX, flipSprite);

      // Death flash: white overlay
      if (draw.deathFlash && draw.mainFrame) {
        const f = draw.mainFrame;
        surf.fillRect(
          f.offset[0] + shakeX + draw.recoilX,
          f.offset[1] + shakeY,
          (f.image as HTMLCanvasElement).width ?? 32,
          (f.image as HTMLCanvasElement).height ?? 40,
          'rgba(255,255,255,0.9)',
        );
      }

      // Tints
      for (const tint of draw.tints) {
        if (tint.alpha > 0 && draw.mainFrame) {
          const f = draw.mainFrame;
          const [tr, tg, tb] = tint.color;
          surf.fillRect(
            f.offset[0] + shakeX + draw.recoilX,
            f.offset[1] + shakeY,
            (f.image as HTMLCanvasElement).width ?? 32,
            (f.image as HTMLCanvasElement).height ?? 40,
            `rgba(${tr},${tg},${tb},${(tint.alpha * 0.5).toFixed(2)})`,
          );
        }
      }

      // Draw child effects (under first, then over)
      for (const ue of draw.underEffects) {
        drawBattleSprite(ue, fallbackColor, platformX, platformY);
      }
      for (const e of draw.effects) {
        drawBattleSprite(e, fallbackColor, platformX, platformY);
      }

      // Restore composite mode
      surf.ctx.globalCompositeOperation = prevComposite;
    };

    // Draw left combatant
    drawBattleSprite(leftDraw, '80,120,200', leftPlatX, leftPlatY);
    // Draw right combatant
    drawBattleSprite(rightDraw, '200,80,80', rightPlatX, rightPlatY);

    // --- Name tags ---
    // Slide in from left/right edges based on nameTagProgress
    const nameSlide = rs.nameTagProgress;
    if (nameSlide > 0) {
      const NAME_TAG_W = 80;
      const NAME_TAG_H = 12;
      const leftNameX = -NAME_TAG_W + nameSlide * (NAME_TAG_W + 4) + shakeX;
      const rightNameX = WINWIDTH - nameSlide * (NAME_TAG_W + 4) + shakeX;
      const nameY = 4 + shakeY;

      // Left name tag background
      surf.fillRect(leftNameX, nameY, NAME_TAG_W, NAME_TAG_H, 'rgba(32,32,64,0.9)');
      surf.drawText(rs.leftHp.name, leftNameX + 3, nameY + 2, 'white', '8px monospace');

      // Right name tag background
      surf.fillRect(rightNameX, nameY, NAME_TAG_W, NAME_TAG_H, 'rgba(64,32,32,0.9)');
      surf.drawText(rs.rightHp.name, rightNameX + 3, nameY + 2, 'white', '8px monospace');
    }

    // --- HP bars ---
    // Slide in from left/right edges based on hpBarProgress
    const hpSlide = rs.hpBarProgress;
    if (hpSlide > 0) {
      const HP_BAR_W = 72;
      const HP_BAR_SECTION_H = 20;
      const leftHpX = -HP_BAR_W + hpSlide * (HP_BAR_W + 4) + shakeX;
      const rightHpX = WINWIDTH - hpSlide * (HP_BAR_W + 4) + shakeX;
      const hpY = 18 + shakeY;

      // Left HP bar
      this.drawBattleHpBar(surf, leftHpX, hpY, HP_BAR_W, HP_BAR_SECTION_H, rs.leftHp);
      // Right HP bar
      this.drawBattleHpBar(surf, rightHpX, hpY, HP_BAR_W, HP_BAR_SECTION_H, rs.rightHp);
    }

    // --- Damage popups (in battle scene space) ---
    for (const popup of rs.damagePopups) {
      const t = popup.elapsed / popup.duration;
      const floatY = -16 * t;
      const alpha = Math.max(0, 1 - t * 1.2);

      // Position popups centered above the platform the hit landed on
      const isLeftSide = popup.x < WINWIDTH / (2 * TILEWIDTH);
      const popupBaseX = isLeftSide ? leftPlatX + PLAT_W / 2 : rightPlatX + PLAT_W / 2;
      const popupBaseY = isLeftSide ? leftPlatY - 24 : rightPlatY - 24;

      if (popup.value === 0) {
        surf.drawText(
          'Miss', popupBaseX - 8, popupBaseY + floatY,
          `rgba(200,200,255,${alpha.toFixed(2)})`, '7px monospace',
        );
      } else {
        const text = popup.isCrit ? `${popup.value}!` : `${popup.value}`;
        const color = popup.isCrit
          ? `rgba(255,255,64,${alpha.toFixed(2)})`
          : `rgba(255,255,255,${alpha.toFixed(2)})`;
        const font = popup.isCrit ? '9px monospace' : '8px monospace';
        surf.drawText(text, popupBaseX - 4, popupBaseY + floatY, color, font);
      }
    }

    // --- Screen blend overlay ---
    if (rs.screenBlend) {
      const [r, g, b] = rs.screenBlend.color;
      surf.fillRect(
        0, 0, WINWIDTH, WINHEIGHT,
        `rgba(${r},${g},${b},${rs.screenBlend.alpha.toFixed(2)})`,
      );
    }

    // --- Fade-out iris ---
    if (rs.state === 'fade_out' && rs.viewbox) {
      const vb = rs.viewbox;
      // Draw black bars closing in
      if (vb.y > 0) surf.fillRect(0, 0, WINWIDTH, vb.y, 'rgb(0,0,0)');
      const botY = vb.y + vb.height;
      if (botY < WINHEIGHT) surf.fillRect(0, botY, WINWIDTH, WINHEIGHT - botY, 'rgb(0,0,0)');
      if (vb.x > 0) surf.fillRect(0, vb.y, vb.x, vb.height, 'rgb(0,0,0)');
      const rightX = vb.x + vb.width;
      if (rightX < WINWIDTH) surf.fillRect(rightX, vb.y, WINWIDTH - rightX, vb.height, 'rgb(0,0,0)');
    }

    // EXP / Level-up overlays (shared)
    this.drawExpAndLevelUp(surf);

    return surf;
  }

  /** Draw a battle-scene HP bar (used in animation combat). */
  private drawBattleHpBar(
    surf: Surface,
    x: number,
    y: number,
    width: number,
    height: number,
    hp: { current: number; max: number; name: string; weapon: string },
  ): void {
    // Background
    surf.fillRect(x, y, width, height, 'rgba(16,16,40,0.9)');
    surf.drawRect(x, y, width, height, 'rgba(100,100,160,0.8)');

    // Weapon name
    surf.drawText(hp.weapon, x + 3, y + 2, 'rgba(180,180,220,1)', '7px monospace');

    // HP bar
    const barX = x + 3;
    const barY = y + 10;
    const barW = width - 6;
    const barH = 5;
    const ratio = hp.max > 0 ? Math.max(0, Math.min(1, hp.current / hp.max)) : 0;

    surf.fillRect(barX, barY, barW, barH, 'rgba(32,32,32,1)');
    let color: string;
    if (ratio > 0.5) color = 'rgba(64,200,64,1)';
    else if (ratio > 0.25) color = 'rgba(220,200,32,1)';
    else color = 'rgba(220,48,48,1)';
    const filled = Math.round(barW * ratio);
    if (filled > 0) surf.fillRect(barX, barY, filled, barH, color);
    surf.drawRect(barX, barY, barW, barH, 'rgba(120,120,140,0.8)');

    // HP text
    surf.drawText(
      `${hp.current}/${hp.max}`,
      barX + barW - 28, barY - 1,
      'white', '6px monospace',
    );
  }

  /** Draw damage popups for map combat (tile-space positions). */
  private drawDamagePopupsMap(
    surf: Surface,
    popups: Array<{ x: number; y: number; value: number; isCrit: boolean; elapsed: number; duration: number }>,
    cameraOffset: [number, number],
  ): void {
    for (const popup of popups) {
      const t = popup.elapsed / popup.duration;
      const floatY = -12 * t;
      const alpha = Math.max(0, 1 - t * 1.2);
      const px = popup.x * TILEWIDTH - cameraOffset[0] + TILEWIDTH / 2;
      const py = popup.y * TILEHEIGHT - cameraOffset[1] + floatY - 4;

      if (popup.value === 0) {
        surf.drawText('Miss', px - 8, py, `rgba(200,200,255,${alpha.toFixed(2)})`, '7px monospace');
      } else {
        const text = popup.isCrit ? `${popup.value}!` : `${popup.value}`;
        const color = popup.isCrit
          ? `rgba(255,255,64,${alpha.toFixed(2)})`
          : `rgba(255,255,255,${alpha.toFixed(2)})`;
        const font = popup.isCrit ? '9px monospace' : '8px monospace';
        surf.drawText(text, px - 4, py, color, font);
      }
    }
  }

  /** Draw EXP bar and level-up stats (shared between map and animation combat). */
  private drawExpAndLevelUp(surf: Surface): void {
    if (this.phase === 'exp' || this.phase === 'levelup') {
      this.drawExpBar(surf);
    }
    if (this.phase === 'levelup' && this.levelUpGains) {
      this.drawLevelUpStats(surf);
    }
  }

  /**
   * Draw a single animation frame (mainFrame/underFrame/overFrame) from
   * BattleAnimDrawData onto the battle scene surface.
   *
   * Frame offsets are in 240x160 screen space. The image is an
   * HTMLCanvasElement (palette-converted frame) or ImageBitmap.
   */
  private drawAnimFrame(
    surf: Surface,
    frame: { image: ImageBitmap | HTMLCanvasElement; offset: [number, number] } | null,
    alpha: number,
    shakeX: number,
    shakeY: number,
    recoilX: number,
    flipH: boolean = false,
  ): void {
    if (!frame) return;

    const img = frame.image;
    const ox = frame.offset[0] + shakeX + recoilX;
    const oy = frame.offset[1] + shakeY;

    const srcW = (img as HTMLCanvasElement).width ?? 32;
    const srcH = (img as HTMLCanvasElement).height ?? 40;
    surf.drawImageFull(img, ox, oy, srcW, srcH, alpha, flipH);
  }

  private drawHpBar(
    surf: Surface,
    x: number,
    y: number,
    current: number,
    max: number,
  ): void {
    const width = TILEWIDTH;
    const height = 4;
    const ratio = max > 0 ? Math.max(0, Math.min(1, current / max)) : 0;

    // Background
    surf.fillRect(x, y, width, height, 'rgba(32,32,32,0.8)');
    // Filled portion
    let color: string;
    if (ratio > 0.5) {
      color = 'rgba(64,200,64,1)';
    } else if (ratio > 0.25) {
      color = 'rgba(220,200,32,1)';
    } else {
      color = 'rgba(220,48,48,1)';
    }
    const filled = Math.round(width * ratio);
    if (filled > 0) {
      surf.fillRect(x, y, filled, height, color);
    }
    // Border
    surf.drawRect(x, y, width, height, 'rgba(120,120,120,0.8)');
  }

  private drawExpBar(surf: Surface): void {
    const barX = 4;
    const barY = WINHEIGHT - 14;
    const barW = WINWIDTH - 8;
    const barH = 10;

    // Background
    surf.fillRect(barX, barY, barW, barH, 'rgba(16,16,48,0.9)');

    // EXP fill
    const ratio = this.expDisplayCurrent / 100;
    const fillW = Math.round(barW * Math.max(0, Math.min(1, ratio)));
    if (fillW > 0) {
      surf.fillRect(barX, barY, fillW, barH, 'rgba(64,160,255,1)');
    }

    // Border
    surf.drawRect(barX, barY, barW, barH, 'rgba(120,120,180,1)');

    // Text
    const expText = `EXP ${Math.round(this.expDisplayCurrent)}`;
    surf.drawText(expText, barX + 2, barY + 1, 'white', '8px monospace');
  }

  private drawLevelUpStats(surf: Surface): void {
    if (!this.levelUpGains) return;

    const boxW = 80;
    const boxH = 10 + Object.keys(this.levelUpGains).length * 10;
    const boxX = Math.floor((WINWIDTH - boxW) / 2);
    const boxY = Math.floor((WINHEIGHT - boxH) / 2) - 20;

    // Background
    surf.fillRect(boxX, boxY, boxW, boxH, 'rgba(16,16,48,0.95)');
    surf.drawRect(boxX, boxY, boxW, boxH, 'rgba(200,200,255,0.8)');

    // Title
    surf.drawText('LEVEL UP!', boxX + 4, boxY + 2, 'rgba(255,255,128,1)', '8px monospace');

    // Stat gains
    let y = boxY + 12;
    for (const [stat, gain] of Object.entries(this.levelUpGains)) {
      const color = gain > 0 ? 'rgba(128,255,128,1)' : 'rgba(160,160,160,1)';
      const text = gain > 0 ? `${stat} +${gain}` : `${stat} --`;
      surf.drawText(text, boxX + 8, y, color, '7px monospace');
      y += 10;
    }
  }
}

// ============================================================================
// 7. AIState
// ============================================================================

export class AIState extends MapState {
  readonly name = 'ai';

  private aiUnits: UnitObject[] = [];
  private currentAiIndex: number = 0;
  private frameCounter: number = 0;
  private processing: boolean = false;
  private waitingForCombat: boolean = false;
  private waitingForMovement: boolean = false;
  private pendingCombatTarget: UnitObject | null = null;
  private pendingCombatWeapon: ItemObject | null = null;

  override begin(): StateResult {
    const game = getGame();
    const currentTeam = game.phase.getCurrent();
    this.aiUnits = game.board
      .getTeamUnits(currentTeam)
      .filter((u: UnitObject) => !u.isDead() && u.canStillAct());
    this.currentAiIndex = 0;
    this.frameCounter = 0;
    this.processing = false;
    this.waitingForCombat = false;
    this.waitingForMovement = false;
    this.pendingCombatTarget = null;
    this.pendingCombatWeapon = null;

    game.cursor.visible = false;
  }

  override update(): StateResult {
    const game = getGame();

    // Wait for combat animation (CombatState) to finish.
    // CombatState pops itself via back(), which returns control here.
    if (this.waitingForCombat) {
      // CombatState is transparent and sits on top of us. If it has
      // popped, we are now the top state and can advance.
      // We detect this by checking if we're still waiting — CombatState
      // sets attacker.hasAttacked and attacker.finished in its cleanup.
      const unit = this.aiUnits[this.currentAiIndex];
      if (unit && (unit.finished || unit.isDead())) {
        this.waitingForCombat = false;
        this.advanceToNextUnit();
      }
      return;
    }

    // Wait for movement animations to finish
    if (this.waitingForMovement) {
      if (!game.movementSystem.isMoving()) {
        this.waitingForMovement = false;
      }
      return;
    }

    if (this.currentAiIndex >= this.aiUnits.length) {
      // All AI units processed — advance to turn change
      game.state.change('turn_change');
      return;
    }

    // Process one AI unit with a short delay between each
    this.frameCounter++;
    if (this.frameCounter < 15) return; // ~0.25s pause between AI actions
    this.frameCounter = 0;

    const unit = this.aiUnits[this.currentAiIndex];
    if (!unit || unit.isDead() || !unit.canStillAct()) {
      this.advanceToNextUnit();
      return;
    }

    // Get AI decision
    const action = game.aiController.getAction(unit);

    switch (action.type) {
      case 'attack': {
        if (action.targetPosition && action.targetUnit) {
          // Move unit to attack position
          const prevPos: [number, number] | null = unit.position
            ? [unit.position[0], unit.position[1]]
            : null;

          if (
            action.movePath &&
            action.movePath.length > 1 &&
            prevPos &&
            (action.targetPosition[0] !== prevPos[0] ||
              action.targetPosition[1] !== prevPos[1])
          ) {
            // Animate movement
            game.board.moveUnit(
              unit,
              action.targetPosition[0],
              action.targetPosition[1],
            );
            game.camera.focusTile(
              action.targetPosition[0],
              action.targetPosition[1],
            );

            this.waitingForMovement = true;
            this.pendingCombatTarget = action.targetUnit!;
            this.pendingCombatWeapon = action.item!;
            game.movementSystem.beginMove(
              unit,
              action.movePath,
              undefined,
              () => {
                // Movement done — now push CombatState for animated combat
                this.beginAICombat(unit, this.pendingCombatTarget!, this.pendingCombatWeapon!);
              },
            );
          } else {
            // Already at position, attack directly
            if (action.targetPosition) {
              game.board.moveUnit(
                unit,
                action.targetPosition[0],
                action.targetPosition[1],
              );
            }
            this.beginAICombat(
              unit,
              action.targetUnit!,
              action.item!,
            );
          }
        } else {
          unit.finished = true;
          this.advanceToNextUnit();
        }
        break;
      }

      case 'move': {
        if (action.targetPosition) {
          const prevPos: [number, number] | null = unit.position
            ? [unit.position[0], unit.position[1]]
            : null;

          game.board.moveUnit(
            unit,
            action.targetPosition[0],
            action.targetPosition[1],
          );
          game.camera.focusTile(
            action.targetPosition[0],
            action.targetPosition[1],
          );

          if (action.movePath && action.movePath.length > 1 && prevPos) {
            this.waitingForMovement = true;
            game.movementSystem.beginMove(unit, action.movePath, undefined, () => {
              unit.finished = true;
              this.waitingForMovement = false;
              this.advanceToNextUnit();
            });
          } else {
            unit.hasMoved = true;
            unit.finished = true;
            this.advanceToNextUnit();
          }
        } else {
          unit.finished = true;
          this.advanceToNextUnit();
        }
        break;
      }

      case 'wait':
      default:
        unit.finished = true;
        this.advanceToNextUnit();
        break;
    }
  }

  /**
   * Push CombatState onto the state machine so the AI combat plays
   * with the same animations (lunge, shake, HP drain, death fade, EXP)
   * that the player sees. CombatState reads game.selectedUnit and
   * game.combatTarget, then pops itself when done. AIState.update()
   * detects the pop via waitingForCombat and advances to the next unit.
   */
  private beginAICombat(
    attacker: UnitObject,
    defender: UnitObject,
    _weapon: ItemObject,
  ): void {
    const game = getGame();

    // CombatState.begin() reads these to set up the MapCombat instance
    game.selectedUnit = attacker;
    game.combatTarget = defender;

    this.waitingForCombat = true;
    this.waitingForMovement = false;

    // Push CombatState on top of AIState (CombatState is transparent,
    // so AIState.draw() still runs underneath).
    game.state.change('combat');
  }

  private advanceToNextUnit(): void {
    this.currentAiIndex++;
    this.frameCounter = 0;
    this.waitingForCombat = false;
  }

  override draw(surf: Surface): Surface {
    surf = drawMap(surf, false);

    // Show current AI unit indicator
    const game = getGame();
    if (this.currentAiIndex < this.aiUnits.length) {
      const unit = this.aiUnits[this.currentAiIndex];
      if (unit && unit.position) {
        const cameraOffset = game.camera.getOffset();
        const ux = unit.position[0] * TILEWIDTH - cameraOffset[0];
        const uy = unit.position[1] * TILEHEIGHT - cameraOffset[1];
        surf.drawRect(ux, uy, TILEWIDTH, TILEHEIGHT, 'rgba(255,80,80,0.8)', 2);
      }
    }
    return surf;
  }
}

// ============================================================================
// 8. TurnChangeState
// ============================================================================

export class TurnChangeState extends State {
  readonly name = 'turn_change';

  override begin(): StateResult {
    const game = getGame();

    // Advance to next phase
    game.phase.next((team: string) => game.board.getTeamUnits(team));

    const currentTeam = game.phase.getCurrent();

    // Clear the entire state stack to prevent unbounded growth,
    // then push the appropriate states fresh.
    game.state.clear();

    if (currentTeam === 'player') {
      // Player phase: push free, then phase banner on top
      game.state.change('free');
      game.state.change('phase_change');
    } else {
      // AI phase: push ai, then phase banner on top
      game.state.change('ai');
      game.state.change('phase_change');
    }

    return 'repeat';
  }
}

// ============================================================================
// 9. PhaseChangeState
// ============================================================================

export class PhaseChangeState extends State {
  readonly name = 'phase_change';
  override readonly transparent = true;

  private banner: Banner | null = null;

  override begin(): StateResult {
    const game = getGame();
    const currentTeam = game.phase.getCurrent();
    const turnCount = game.phase.turnCount;

    let bannerText: string;
    let subText: string;

    switch (currentTeam) {
      case 'player':
        bannerText = 'Player Phase';
        subText = `Turn ${turnCount}`;
        break;
      case 'enemy':
        bannerText = 'Enemy Phase';
        subText = `Turn ${turnCount}`;
        break;
      default:
        bannerText = `${currentTeam} Phase`;
        subText = `Turn ${turnCount}`;
        break;
    }

    this.banner = new Banner(bannerText, subText);

    // Reset all units for the new phase and process status effects
    const teamUnits: UnitObject[] = game.board.getTeamUnits(currentTeam);
    for (const unit of teamUnits) {
      unit.resetTurnState();
      // Process status effects (DOT damage, duration tick-down)
      const dotDamage = unit.processStatusEffects();
      if (dotDamage > 0) {
        // Unit took status damage — check if they died from it
        if (unit.currentHp <= 0) {
          unit.dead = true;
          game.board.removeUnit(unit);
        }
      }
    }
  }

  override update(): StateResult {
    if (!this.banner) return;
    const game = getGame();

    const done = this.banner.update(FRAMETIME);
    if (done) {
      this.banner = null;
      game.state.back();
    }
  }

  override draw(surf: Surface): Surface {
    if (this.banner) {
      this.banner.draw(surf);
    }
    return surf;
  }
}

// ============================================================================
// 10. MovementState
// ============================================================================

export class MovementState extends State {
  readonly name = 'movement';
  override readonly transparent = true;

  override update(): StateResult {
    const game = getGame();
    // movementSystem.update() is called by the main loop;
    // we only check completion status here.
    const stillMoving = game.movementSystem.isMoving();
    if (!stillMoving) {
      game.state.back();
      // If there is a pending state after movement, push it
      if (game._pendingAfterMovement) {
        const nextState = game._pendingAfterMovement;
        game._pendingAfterMovement = null;
        game.state.change(nextState);
      }
    }
  }

  override draw(surf: Surface): Surface {
    // Transparent — underlying MapState draws the map
    return surf;
  }
}

// ============================================================================
// 11. EventState
// ============================================================================

export class EventState extends State {
  readonly name = 'event';
  override readonly transparent = true;

  private dialog: Dialog | null = null;
  private commands: any[] = [];
  private commandIndex: number = 0;
  private waitTimer: number = 0;
  private waiting: boolean = false;

  override begin(): StateResult {
    const game = getGame();
    // Load event commands from the game's current event
    this.commands = game.currentEvent?.commands ?? [];
    this.commandIndex = 0;
    this.dialog = null;
    this.waitTimer = 0;
    this.waiting = false;
  }

  override takeInput(event: InputEvent): StateResult {
    const game = getGame();

    // Forward input to dialog if active
    if (this.dialog) {
      // Mouse click advances dialog (LMB = SELECT, RMB = BACK/skip)
      let effective = event;
      if (game.input?.mouseClick === 'SELECT' && !effective) {
        effective = 'SELECT';
      } else if (game.input?.mouseClick === 'BACK' && !effective) {
        effective = 'BACK';
      }
      const done = this.dialog.handleInput(effective);
      if (done) {
        this.dialog = null;
        this.commandIndex++;
      }
    }
  }

  override update(): StateResult {
    const game = getGame();

    // Update dialog typewriter
    if (this.dialog) {
      this.dialog.update();
      return;
    }

    // Handle wait timer
    if (this.waiting) {
      this.waitTimer -= FRAMETIME;
      if (this.waitTimer <= 0) {
        this.waiting = false;
        this.commandIndex++;
      }
      return;
    }

    // Process next command
    if (this.commandIndex >= this.commands.length) {
      // Event complete
      game.currentEvent = null;
      game.state.back();
      return;
    }

    const cmd = this.commands[this.commandIndex];
    if (!cmd) {
      this.commandIndex++;
      return;
    }

    // EventCommand format: { type: string, args: string[] }
    // args are semicolon-delimited from the source line after the command name.
    const args = cmd.args ?? [];

    switch (cmd.type) {
      case 'speak': {
        // speak;SpeakerName;Dialog text here
        const speaker = args[0] ?? '';
        const text = args[1] ?? '';
        this.dialog = new Dialog(text, speaker || undefined);
        break;
      }

      case 'wait': {
        // wait;duration_ms
        this.waiting = true;
        this.waitTimer = parseInt(args[0], 10) || 1000;
        break;
      }

      case 'transition': {
        // transition;type (e.g. "close", "open", "fade_in", "fade_out")
        // For now, just wait a short time to simulate the transition
        this.waiting = true;
        this.waitTimer = 500;
        break;
      }

      case 'move_unit': {
        // move_unit;unit_nid;x,y
        const unitNid = args[0] ?? '';
        const posStr = args[1] ?? '';
        const posParts = posStr.split(',').map((s: string) => parseInt(s.trim(), 10));
        const unit: UnitObject | undefined = game.board
          .getAllUnits()
          .find((u: UnitObject) => u.nid === unitNid);
        if (unit && posParts.length >= 2 && !isNaN(posParts[0]) && !isNaN(posParts[1])) {
          game.board.moveUnit(unit, posParts[0], posParts[1]);
        }
        this.commandIndex++;
        break;
      }

      case 'add_unit': {
        // add_unit;unit_nid;x,y  (or add_unit;unit_nid;starting)
        // Placeholder — full implementation needs spawn logic
        this.commandIndex++;
        break;
      }

      case 'remove_unit': {
        // remove_unit;unit_nid
        const unitNid = args[0] ?? '';
        const unit: UnitObject | undefined = game.board
          .getAllUnits()
          .find((u: UnitObject) => u.nid === unitNid);
        if (unit) {
          game.board.removeUnit(unit);
        }
        this.commandIndex++;
        break;
      }

      case 'add_group': {
        // add_group;group_nid  — spawn all units in a group at their positions
        // Placeholder — needs group spawn logic
        this.commandIndex++;
        break;
      }

      case 'remove_group': {
        // remove_group;group_nid  — remove all units in a group from the map
        // Placeholder — needs group removal logic
        this.commandIndex++;
        break;
      }

      case 'move_group': {
        // move_group;group_nid  — move group units to their new positions
        // Placeholder — needs group movement logic
        this.commandIndex++;
        break;
      }

      case 'give_item': {
        // give_item;unit_nid;item_nid
        // Placeholder — needs item creation from DB
        this.commandIndex++;
        break;
      }

      case 'remove_item': {
        // remove_item;unit_nid;item_nid
        const unitNid = args[0] ?? '';
        const itemNid = args[1] ?? '';
        const unit: UnitObject | undefined = game.board
          .getAllUnits()
          .find((u: UnitObject) => u.nid === unitNid);
        if (unit) {
          const idx = unit.items.findIndex(i => i.nid === itemNid);
          if (idx !== -1) {
            unit.items.splice(idx, 1);
          }
        }
        this.commandIndex++;
        break;
      }

      case 'set_current_hp': {
        // set_current_hp;unit_nid;value
        const unitNid = args[0] ?? '';
        const hpValue = parseInt(args[1], 10);
        const unit: UnitObject | undefined = game.board
          .getAllUnits()
          .find((u: UnitObject) => u.nid === unitNid);
        if (unit && !isNaN(hpValue)) {
          unit.currentHp = Math.min(hpValue, unit.maxHp);
        }
        this.commandIndex++;
        break;
      }

      case 'change_ai': {
        // change_ai;unit_nid;ai_nid
        const unitNid = args[0] ?? '';
        const aiNid = args[1] ?? 'None';
        const unit: UnitObject | undefined = game.board
          .getAllUnits()
          .find((u: UnitObject) => u.nid === unitNid);
        if (unit) {
          unit.ai = aiNid;
        }
        this.commandIndex++;
        break;
      }

      case 'change_team': {
        // change_team;unit_nid;team
        const unitNid = args[0] ?? '';
        const team = args[1] ?? 'player';
        const unit: UnitObject | undefined = game.board
          .getAllUnits()
          .find((u: UnitObject) => u.nid === unitNid);
        if (unit) {
          unit.team = team;
        }
        this.commandIndex++;
        break;
      }

      case 'game_var':
      case 'set_game_var': {
        // game_var;var_name;value
        const varName = args[0] ?? '';
        const value = args[1] ?? 'true';
        if (varName && game.gameVars) {
          game.gameVars.set(varName, value);
        }
        this.commandIndex++;
        break;
      }

      case 'music':
      case 'change_music': {
        // music;music_nid  — change background music
        // Placeholder — needs audio manager integration
        this.commandIndex++;
        break;
      }

      case 'sound': {
        // sound;sound_nid  — play a sound effect
        // Placeholder — needs audio manager integration
        this.commandIndex++;
        break;
      }

      case 'win_game': {
        // win_game — trigger victory
        game.state.clear();
        game.state.change('title');
        break;
      }

      case 'lose_game': {
        // lose_game — trigger defeat
        game.state.clear();
        game.state.change('title');
        break;
      }

      // Portrait commands — advance immediately (visual-only, no game state change)
      case 'add_portrait':
      case 'multi_add_portrait':
      case 'remove_portrait':
      case 'multi_remove_portrait':
      case 'remove_all_portraits':
      case 'move_portrait':
      case 'bop_portrait':
      case 'mirror_portrait':
      case 'expression':
      case 'hide_combat_ui':
      case 'show_combat_ui':
      case 'change_background':
      case 'disp_cursor':
      case 'move_cursor':
      case 'center_cursor':
      case 'flicker_cursor':
      case 'screen_shake':
      case 'screen_shake_end':
        // These are visual/UI commands that need proper rendering support.
        // For now, skip them to allow the event to progress.
        this.commandIndex++;
        break;

      // Flow control — skip for now (would need conditional evaluation)
      case 'if':
      case 'elif':
      case 'else':
      case 'end':
      case 'for':
      case 'endf':
      case 'finish':
      case 'end_skip':
      case 'comment':
        this.commandIndex++;
        break;

      default:
        // Unknown/unimplemented command — skip
        this.commandIndex++;
        break;
    }
  }

  override draw(surf: Surface): Surface {
    if (this.dialog) {
      this.dialog.draw(surf);
    }
    return surf;
  }
}
