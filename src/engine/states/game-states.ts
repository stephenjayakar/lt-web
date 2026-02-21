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
import { getEquippedWeapon } from '../../combat/combat-calcs';

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



// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Collect units for map-view rendering from the game board. */
function collectVisibleUnits(): {
  x: number;
  y: number;
  sprite: any;
  team: string;
  finished: boolean;
}[] {
  const game = getGame();
  const allUnits: UnitObject[] = game.board.getAllUnits();
  const result: {
    x: number;
    y: number;
    sprite: any;
    team: string;
    finished: boolean;
  }[] = [];

  for (const u of allUnits) {
    if (u.isDead() || !u.position) continue;
    result.push({
      x: u.position[0],
      y: u.position[1],
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
  return game.board.getUnit(pos.x, pos.y);
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
  const allUnits: UnitObject[] = game.board.getAllUnits();
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
  const dirs: [number, number][] = [[0, -1], [0, 1], [-1, 0], [1, 0]];
  const allies: UnitObject[] = [];
  for (const [dx, dy] of dirs) {
    const other = game.board.getUnit(x + dx, y + dy);
    if (other && other !== unit && !other.isDead() && game.db.areAllied(unit.team, other.team)) {
      allies.push(other);
    }
  }
  return allies;
}

/** Get all adjacent units (any team) at a specific position. */
function getAdjacentUnits(x: number, y: number): UnitObject[] {
  const game = getGame();
  const dirs: [number, number][] = [[0, -1], [0, 1], [-1, 0], [1, 0]];
  const units: UnitObject[] = [];
  for (const [dx, dy] of dirs) {
    const other = game.board.getUnit(x + dx, y + dy);
    if (other && !other.isDead()) {
      units.push(other);
    }
  }
  return units;
}

/** Get all adjacent empty tiles that are in bounds. */
function getAdjacentEmptyTiles(x: number, y: number): [number, number][] {
  const game = getGame();
  const dirs: [number, number][] = [[0, -1], [0, 1], [-1, 0], [1, 0]];
  const tiles: [number, number][] = [];
  for (const [dx, dy] of dirs) {
    const nx = x + dx;
    const ny = y + dy;
    if (game.board.inBounds(nx, ny) && !game.board.isOccupied(nx, ny)) {
      tiles.push([nx, ny]);
    }
  }
  return tiles;
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
    if (event === 'START' || event === 'SELECT') {
      const game = getGame();
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
    game.cursor.visible = true;

    // Auto-cursor to first available player unit
    const playerUnits: UnitObject[] = game.board.getTeamUnits('player');
    const available = playerUnits.find((u) => u.canStillAct() && u.position);
    if (available && available.position) {
      game.cursor.setPos(available.position[0], available.position[1]);
      game.camera.focusTile(available.position[0], available.position[1]);
    }
  }

  override takeInput(event: InputEvent): StateResult {
    if (event === null) return;
    const game = getGame();

    switch (event) {
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
    if (event === null) return;
    const game = getGame();

    switch (event) {
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
    if (!this.menu || event === null) return;
    const game = getGame();

    const result = this.menu.handleInput(event);
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
    if (event === null) return;
    const game = getGame();

    switch (event) {
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
    if (event === null) return;
    const game = getGame();

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

    this.combat = new MapCombat(
      attacker,
      attackItem,
      defender,
      defenseItem,
      game.db,
      rngMode,
    );

    this.results = null;
    this.phase = 'combat';
    this.phaseTimer = 0;
    this.deathFadeProgress = 0;
    this.levelUpGains = null;
  }

  override update(): StateResult {
    if (!this.combat) return;
    const game = getGame();

    switch (this.phase) {
      case 'combat': {
        const done = this.combat.update(FRAMETIME);
        if (done) {
          this.results = this.combat.applyResults();
          if (this.results.attackerDead || this.results.defenderDead) {
            this.phase = 'death';
            this.phaseTimer = 0;
            this.deathFadeProgress = 0;
          } else if (this.results.expGained > 0 && this.combat.attacker.team === 'player') {
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
            game.board.removeUnit(this.combat.defender);
          }
          if (this.results!.attackerDead) {
            game.board.removeUnit(this.combat.attacker);
          }

          // Check if attacker earned EXP
          if (
            !this.results!.attackerDead &&
            this.results!.expGained > 0 &&
            this.combat.attacker.team === 'player'
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
        const attacker = this.combat.attacker;
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

        this.combat = null;
        this.results = null;

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
    const currentExp = this.combat!.attacker.exp;
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

  override draw(surf: Surface): Surface {
    if (!this.combat) return surf;

    const rs = this.combat.getRenderState();
    const game = getGame();
    const cameraOffset = game.camera.getOffset();

    // Draw combat health bars overlay
    const atkPos = this.combat.attacker.position;
    const defPos = this.combat.defender.position;

    // Attacker HP bar
    if (atkPos) {
      const ax = atkPos[0] * TILEWIDTH - cameraOffset[0];
      const ay = atkPos[1] * TILEHEIGHT - cameraOffset[1] - 6;
      this.drawHpBar(surf, ax, ay, rs.attackerHp, rs.attackerMaxHp);
    }

    // Defender HP bar
    if (defPos) {
      const dx = defPos[0] * TILEWIDTH - cameraOffset[0];
      const dy = defPos[1] * TILEHEIGHT - cameraOffset[1] - 6;
      this.drawHpBar(surf, dx, dy, rs.defenderHp, rs.defenderMaxHp);
    }

    // Strike flash effect
    if (this.phase === 'combat' && rs.state === 'strike' && rs.currentStrike) {
      const targetPos = rs.currentStrike.defender.position;
      if (targetPos) {
        const fx = targetPos[0] * TILEWIDTH - cameraOffset[0];
        const fy = targetPos[1] * TILEHEIGHT - cameraOffset[1];
        surf.fillRect(fx, fy, TILEWIDTH, TILEHEIGHT, 'rgba(255,255,255,0.6)');
      }
    }

    // Miss text
    if (
      this.phase === 'combat' &&
      rs.state === 'hp_change' &&
      rs.currentStrike &&
      !rs.currentStrike.hit
    ) {
      const targetPos = rs.currentStrike.defender.position;
      if (targetPos) {
        const mx = targetPos[0] * TILEWIDTH - cameraOffset[0];
        const my = targetPos[1] * TILEHEIGHT - cameraOffset[1] - 10;
        surf.drawText('MISS', mx, my, 'white', '8px monospace');
      }
    }

    // Death fade-out overlay on the dying unit
    if (this.phase === 'death') {
      const alpha = this.deathFadeProgress * 0.8;
      if (this.results?.defenderDead && defPos) {
        const dx = defPos[0] * TILEWIDTH - cameraOffset[0];
        const dy = defPos[1] * TILEHEIGHT - cameraOffset[1];
        surf.fillRect(dx, dy, TILEWIDTH, TILEHEIGHT, `rgba(255,255,255,${alpha})`);
      }
      if (this.results?.attackerDead && atkPos) {
        const ax = atkPos[0] * TILEWIDTH - cameraOffset[0];
        const ay = atkPos[1] * TILEHEIGHT - cameraOffset[1];
        surf.fillRect(ax, ay, TILEWIDTH, TILEHEIGHT, `rgba(255,255,255,${alpha})`);
      }
    }

    // EXP bar display
    if (this.phase === 'exp' || this.phase === 'levelup') {
      this.drawExpBar(surf);
    }

    // Level-up display
    if (this.phase === 'levelup' && this.levelUpGains) {
      this.drawLevelUpStats(surf);
    }

    return surf;
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

    game.cursor.visible = false;
  }

  override update(): StateResult {
    const game = getGame();

    // Wait for movement/combat animations to finish
    if (this.waitingForMovement) {
      if (!game.movementSystem.isMoving()) {
        this.waitingForMovement = false;
        // After movement, check if we need combat
        if (this.waitingForCombat) {
          // Combat will be handled next frame
        } else {
          this.advanceToNextUnit();
        }
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
            game.movementSystem.beginMove(
              unit,
              action.movePath,
              undefined,
              () => {
                // Movement done — initiate combat
                this.initiateAICombat(unit, action.targetUnit!, action.item!);
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
            this.initiateAICombat(
              unit,
              action.targetUnit,
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
            });
          } else {
            unit.hasMoved = true;
            unit.finished = true;
          }
          this.advanceToNextUnit();
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

  private initiateAICombat(
    attacker: UnitObject,
    defender: UnitObject,
    weapon: ItemObject,
  ): void {
    const game = getGame();
    const defenseItem = getEquippedWeapon(defender);
    const rngMode = game.db.getConstant('rng_mode', 'true_hit') as any;

    const combat = new MapCombat(
      attacker,
      weapon,
      defender,
      defenseItem,
      game.db,
      rngMode,
    );

    // Run combat to completion synchronously (simplified)
    let done = false;
    while (!done) {
      done = combat.update(FRAMETIME);
    }

    const results = combat.applyResults();

    if (results.defenderDead) {
      game.board.removeUnit(defender);
    }
    if (results.attackerDead) {
      game.board.removeUnit(attacker);
    }

    attacker.hasAttacked = true;
    attacker.finished = true;

    // Check win/loss conditions after AI combat
    if (game.checkLossCondition()) {
      console.warn('GAME OVER — loss condition met during AI phase');
      // TODO: push GameOverState
    } else if (game.checkWinCondition()) {
      console.warn('VICTORY — win condition met during AI phase');
      // TODO: push VictoryState
    }

    this.advanceToNextUnit();
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
    // Forward input to dialog if active
    if (this.dialog) {
      const done = this.dialog.handleInput(event);
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

    switch (cmd.type) {
      case 'speak':
        this.dialog = new Dialog(
          cmd.text ?? '',
          cmd.speaker ?? undefined,
        );
        break;

      case 'wait':
        this.waiting = true;
        this.waitTimer = cmd.duration ?? 1000;
        break;

      case 'move_unit': {
        const unit: UnitObject | undefined = game.board
          .getAllUnits()
          .find((u: UnitObject) => u.nid === cmd.unit);
        if (unit && cmd.position) {
          game.board.moveUnit(unit, cmd.position[0], cmd.position[1]);
        }
        this.commandIndex++;
        break;
      }

      case 'add_unit': {
        // Placeholder for spawning units during events
        this.commandIndex++;
        break;
      }

      case 'remove_unit': {
        const unit: UnitObject | undefined = game.board
          .getAllUnits()
          .find((u: UnitObject) => u.nid === cmd.unit);
        if (unit) {
          game.board.removeUnit(unit);
        }
        this.commandIndex++;
        break;
      }

      default:
        // Unknown command — skip
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
