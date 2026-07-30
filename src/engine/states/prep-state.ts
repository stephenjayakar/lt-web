/**
 * prep-state.ts — GBA-style preparation screen states.
 *
 * PrepMainState: Main prep menu (Pick Units, Manage, Formation, Options, Save, Fight)
 * PrepPickUnitsState: Toggle units on/off the deployment map
 * PrepMapState: View the map with formation highlights
 */

import { State, type StateResult } from '../state';
import type { Surface } from '../surface';
import type { InputEvent } from '../input';
import { viewport } from '../viewport';
import type { UnitObject } from '../../objects/unit';
import { ArriveOnMapAction, SwapUnitsAction } from '../action';

// Lazy game reference (same pattern as game-states.ts)
let _game: any = null;
export function setPrepGameRef(g: any): void {
  _game = g;
}
function getGame(): any {
  if (!_game) throw new Error('Game reference not set for prep states');
  return _game;
}

// ============================================================================
// Helpers
// ============================================================================

/** Get all living player units from the registry. */
function getPartyUnits(): UnitObject[] {
  const game = getGame();
  const units: UnitObject[] = [];
  for (const unit of game.units.values()) {
    if (unit.team === 'player' && !unit.dead) {
      units.push(unit);
    }
  }
  return units;
}

/** Get all formation spots from level regions. */
function getFormationSpots(): [number, number][] {
  const game = getGame();
  const spots: [number, number][] = [];
  if (!game.currentLevel?.regions) return spots;

  for (const region of game.currentLevel.regions) {
    if (region.region_type === 'formation') {
      const x = region.position[0];
      const y = region.position[1];
      const w = region.size?.[0] ?? 1;
      const h = region.size?.[1] ?? 1;
      for (let dx = 0; dx < w; dx++) {
        for (let dy = 0; dy < h; dy++) {
          spots.push([x + dx, y + dy]);
        }
      }
    }
  }
  return spots;
}

// ============================================================================
// PrepMainState — GBA-style main prep menu
// ============================================================================

export class PrepMainState extends State {
  readonly name = 'prep_main';
  override readonly showMap = false;
  override readonly inLevel = false;

  private options: string[] = [];
  private descriptions: string[] = [];
  private cursor: number = 0;
  private slideX: number = -120;
  private slideTimer: number = 0;
  private pickEnabled: boolean = true;

  override start(): StateResult {
    const game = getGame();

    // Check if pick units is enabled (set by the prep event command)
    this.pickEnabled = game.levelVars?.get('_prep_pick') !== false;

    // Build options
    this.options = [];
    this.descriptions = [];

    if (this.pickEnabled) {
      this.options.push('Pick Units');
      this.descriptions.push('Choose which units to deploy.');
    }
    this.options.push('Manage');
    this.descriptions.push('Manage units, equipment, and the convoy.');
    this.options.push('Formation');
    this.descriptions.push('Arrange deployed units on the map.');
    this.options.push('Options');
    this.descriptions.push('Adjust game settings.');
    this.options.push('Save');
    this.descriptions.push('Save your progress.');
    this.options.push('Fight');
    this.descriptions.push('Begin the battle!');

    this.cursor = 0;
    this.slideX = -120;
    this.slideTimer = 0;

    // Setup: force-place Required units on formation spots
    this.setupUnits();

    // on_prep_start fires each time the player enters preps
    // (matches Python engine/prep.py PrepMainState.start).
    if (game.eventManager) {
      const levelNid = game.currentLevel?.nid ?? '';
      const ctx = { game, gameVars: game.gameVars, levelVars: game.levelVars };
      // Only push an event state when this trigger queued a NEW event.
      // hasActiveEvents() also sees the parent event that opened prep (the
      // chapter intro running the `prep` command), and pushing a second
      // EventState for it corrupts the stack (empty stack after Fight!).
      const triggered = game.eventManager.trigger({ type: 'on_prep_start', levelNid }, ctx);
      if (triggered) {
        game.state.change('event');
      }
    }
  }

  private setupUnits(): void {
    const game = getGame();
    if (!game.currentLevel) return;

    const partyUnits = getPartyUnits();
    const formationSpots = getFormationSpots();

    // Force-place Required units that don't have positions
    for (const unit of partyUnits) {
      if (unit.tags?.includes('Required') && !unit.position) {
        const spot = formationSpots.find((s: [number, number]) =>
          !game.board?.getUnit(s[0], s[1])
        );
        if (spot && game.board) {
          game.board.setUnit(spot[0], spot[1], unit);
        }
      }
    }
  }

  override update(): StateResult {
    const game = getGame();
    this.slideTimer += game.frameDeltaMs ?? 16;
    if (this.slideX < 24) {
      this.slideX = Math.min(24, this.slideX + 12);
    }
  }

  override draw(surf: Surface): Surface {
    const vw = viewport.width;
    const vh = viewport.height;

    // Background: dark blue with scrolling grid
    surf.fill(20, 20, 40);
    const gridSize = 24;
    const offset = (this.slideTimer / 50) % gridSize;
    for (let x = -gridSize + offset; x < vw; x += gridSize) {
      for (let y = -gridSize + offset; y < vh; y += gridSize) {
        surf.fillRect(x, y, 1, 1, 'rgba(60,60,100,0.3)');
      }
    }

    // Title bar
    surf.fillRect(0, 0, vw, 20, 'rgba(16,16,48,0.9)');
    surf.drawText('Preparations', 4, 4, 'rgba(220,200,128,1)', '10px monospace');

    // Chapter/objective display (top right)
    const level = getGame().currentLevel;
    if (level) {
      const name = level.name || level.nid;
      const nameW = name.length * 5;
      surf.drawText(name, vw - nameW - 4, 6, 'rgba(180,180,220,1)', '7px monospace');
    }

    // Menu panel
    const panelX = Math.floor(this.slideX - 8);
    const panelY = 24;
    const panelW = 104;
    const rowHeight = 15;
    const panelH = this.options.length * rowHeight + 8;
    surf.fillRect(panelX, panelY, panelW, panelH, 'rgba(16,16,48,0.9)');
    surf.drawRect(panelX, panelY, panelW, panelH, 'rgba(100,100,180,0.7)');

    for (let i = 0; i < this.options.length; i++) {
      const optX = Math.floor(this.slideX);
      const optY = panelY + 4 + i * rowHeight;

      if (i === this.cursor) {
        surf.fillRect(panelX + 2, optY - 2, panelW - 4, 14, 'rgba(64,64,160,0.6)');
        const bob = Math.sin(this.slideTimer / 300 * Math.PI) * 1.5;
        surf.drawText('>', optX - 8, optY + bob, 'rgba(255,255,128,1)', '8px monospace');
      }

      const optLabel = this.options[i];
      // Highlight "Fight" in gold
      let textColor: string;
      if (optLabel === 'Fight') {
        textColor = i === this.cursor ? 'rgba(255,220,128,1)' : 'rgba(200,180,100,1)';
      } else {
        textColor = i === this.cursor ? 'white' : 'rgba(180,180,200,1)';
      }
      surf.drawText(optLabel, optX, optY, textColor, '8px monospace');
    }

    // Description box
    if (this.cursor >= 0 && this.cursor < this.descriptions.length) {
      const descY = panelY + panelH + 3;
      surf.fillRect(8, descY, vw - 16, 13, 'rgba(16,16,48,0.8)');
      surf.drawText(this.descriptions[this.cursor], 12, descY + 3, 'rgba(180,180,220,1)', '6px monospace');
    }

    // Footer and unit count
    const partyUnits = getPartyUnits();
    const deployed = partyUnits.filter(u => u.position !== null && u.position !== undefined).length;
    const total = partyUnits.length;
    const slots = getFormationSpots().length;
    const countText = `Units ${deployed}/${Math.min(total, slots)}`;
    surf.fillRect(0, vh - 18, vw, 18, 'rgba(16,16,48,0.8)');
    surf.drawText('A: Choose   START: Fight', 4, vh - 17, 'rgba(170,170,210,1)', '6px monospace');
    surf.drawTextRight(countText, vw - 4, vh - 17, 'rgba(190,190,225,1)', '7px monospace');

    return surf;
  }

  override takeInput(event: InputEvent): StateResult {
    const game = getGame();

    // Also accept mouse click as SELECT
    let effective = event;
    if (game.input?.mouseClick === 'SELECT' && !effective) {
      effective = 'SELECT';
    }

    if (effective === 'UP') {
      this.cursor = (this.cursor - 1 + this.options.length) % this.options.length;
    } else if (effective === 'DOWN') {
      this.cursor = (this.cursor + 1) % this.options.length;
    } else if (effective === 'SELECT') {
      const selected = this.options[this.cursor];
      if (selected === 'Pick Units') {
        game.state.change('prep_pick');
      } else if (selected === 'Manage') {
        game.state.change('base_manage');
      } else if (selected === 'Formation') {
        game.state.change('prep_formation');
      } else if (selected === 'Options') {
        game.state.change('settings_menu');
      } else if (selected === 'Save') {
        game.state.change('save_menu');
      } else if (selected === 'Fight') {
        this.fight();
      }
    } else if (effective === 'START') {
      // START is a shortcut for Fight!
      this.fight();
    }
  }

  private fight(): void {
    const game = getGame();
    const partyUnits = getPartyUnits();
    const deployed = partyUnits.filter(u => u.position !== null && u.position !== undefined).length;

    const minDeploy = game.levelVars?.get('_minimum_deployment') ?? 0;

    if (minDeploy > 0 && deployed < Math.min(minDeploy, partyUnits.length)) {
      console.warn(`Must deploy at least ${minDeploy} units (currently ${deployed})`);
      return;
    }

    if (deployed === 0) {
      console.warn('Must deploy at least one unit!');
      return;
    }

    // Older prep saves and direct prep entry can predate the initial
    // TurnChangeState-equivalent dispatch. Ensure authored turn-one setup is
    // queued exactly once before resuming the level-start event.
    if (game.turnCount === 1 &&
        !game.levelVars.get('_initial_turn_events_after_level_start') &&
        game.eventManager) {
      game.levelVars.set('_initial_turn_events_after_level_start', true);
      const levelNid = game.currentLevel?.nid;
      const context = { game, gameVars: game.gameVars, levelVars: game.levelVars };
      game.eventManager.trigger(
        { type: 'phase_change', team: game.phase?.getCurrent(), levelNid },
        context,
      );
      game.eventManager.trigger(
        { type: 'turn_change', turnCount: game.turnCount, levelNid },
        context,
      );
    }

    // Exit prep. Direct level loads may leave prep above a stale roam state
    // instead of a tactical Free/Event state; revealing it drains the stack.
    const previous = game.state.stack[game.state.stack.length - 2];
    if (previous?.name === 'free') {
      game.state.back();
    } else if (previous?.name === 'event') {
      // Prep commonly blocks the level-start event. Rebuild the tactical
      // base underneath it before resuming so the event cannot finish by
      // popping the last state and leaving a black, empty stack.
      game.state.clear();
      game.state.change('free');
      game.state.change('event');
    } else {
      game.state.clear();
      game.state.change('free');
    }
  }
}

// ============================================================================
// PrepFormationState — Move or swap deployed units on formation tiles
// ============================================================================

export class PrepFormationState extends State {
  readonly name = 'prep_formation';
  override readonly transparent = true;
  override readonly showMap = true;
  override readonly inLevel = true;

  private selectedUnit: UnitObject | null = null;

  override begin(): StateResult {
    const game = getGame();
    this.selectedUnit = null;
    game.highlight?.clear();
    for (const [x, y] of getFormationSpots()) {
      game.highlight?.addHighlight(x, y, 'move');
    }
    if (game.cursor) game.cursor.visible = true;
  }

  private isFormationTile(x: number, y: number): boolean {
    return getFormationSpots().some(([fx, fy]) => fx === x && fy === y);
  }

  override takeInput(event: InputEvent): StateResult {
    const game = getGame();
    if (event === 'UP' || event === 'DOWN' || event === 'LEFT' || event === 'RIGHT') {
      const dx = event === 'RIGHT' ? 1 : event === 'LEFT' ? -1 : 0;
      const dy = event === 'DOWN' ? 1 : event === 'UP' ? -1 : 0;
      game.cursor?.move(dx, dy);
      const hover = game.cursor?.getHover();
      if (hover) game.camera?.focusTile(hover.x, hover.y);
      return;
    }

    if (event === 'BACK') {
      if (this.selectedUnit) {
        this.selectedUnit = null;
      } else {
        game.state.back();
      }
      return;
    }

    if (event !== 'SELECT') return;
    const hover = game.cursor?.getHover();
    if (!hover) return;
    const hoveredUnit = game.board?.getUnit(hover.x, hover.y) ?? null;

    if (!this.selectedUnit) {
      // Campaign carry-over units should already be on formation tiles, but
      // accepting an out-of-region player here lets formation repair direct
      // chapter loads and old saves instead of leaving those units stranded.
      if (hoveredUnit?.team === 'player') {
        this.selectedUnit = hoveredUnit;
      }
      return;
    }

    if (!this.isFormationTile(hover.x, hover.y)) return;
    if (hoveredUnit === this.selectedUnit) {
      this.selectedUnit = null;
    } else if (hoveredUnit) {
      if (hoveredUnit.team !== 'player') return;
      game.actionLog.doAction(new SwapUnitsAction(this.selectedUnit, hoveredUnit, game.board));
      this.selectedUnit = null;
    } else {
      game.actionLog.doAction(new ArriveOnMapAction(
        game,
        this.selectedUnit,
        [hover.x, hover.y],
      ));
      this.selectedUnit = null;
    }
  }

  override draw(surf: Surface): Surface {
    surf.fillRect(0, 0, viewport.width, 15, 'rgba(16,16,48,0.88)');
    surf.drawText(
      this.selectedUnit
        ? `Move ${this.selectedUnit.name}: choose a blue tile`
        : 'Formation: choose a deployed unit',
      4,
      3,
      'rgba(220,220,240,1)',
      '6px monospace',
    );
    return surf;
  }

  override end(): StateResult {
    getGame().highlight?.clear();
    this.selectedUnit = null;
  }
}

// ============================================================================
// PrepPickUnitsState — Toggle units on/off the map
// ============================================================================

export class PrepPickUnitsState extends State {
  readonly name = 'prep_pick';
  override readonly showMap = false;
  override readonly inLevel = false;

  private partyUnits: UnitObject[] = [];
  private cursor: number = 0;
  private scrollOffset: number = 0;
  private readonly VISIBLE_ROWS = 6;
  private readonly ROW_HEIGHT = 18;

  override begin(): StateResult {
    this.refreshUnits();
    this.cursor = 0;
    this.scrollOffset = 0;
  }

  private refreshUnits(): void {
    this.partyUnits = getPartyUnits();
    // Sort: deployed first, then by name
    this.partyUnits.sort((a, b) => {
      const aDeployed = a.position ? 1 : 0;
      const bDeployed = b.position ? 1 : 0;
      if (aDeployed !== bDeployed) return bDeployed - aDeployed;
      return a.name.localeCompare(b.name);
    });
  }

  override draw(surf: Surface): Surface {
    const vw = viewport.width;
    const vh = viewport.height;

    surf.fill(20, 20, 40);

    // Title
    surf.fillRect(0, 0, vw, 16, 'rgba(16,16,48,0.9)');
    surf.drawText('Pick Units', 4, 3, 'rgba(220,200,128,1)', '9px monospace');

    const formationSpots = getFormationSpots();
    const maxSlots = formationSpots.length;
    const deployed = this.partyUnits.filter(u => u.position).length;
    surf.drawText(`${deployed}/${maxSlots}`, vw - 30, 3, 'white', '8px monospace');

    // Unit list
    const listY = 20;
    const visibleEnd = Math.min(this.partyUnits.length, this.scrollOffset + this.VISIBLE_ROWS);

    for (let i = this.scrollOffset; i < visibleEnd; i++) {
      const unit = this.partyUnits[i];
      const rowIdx = i - this.scrollOffset;
      const y = listY + rowIdx * this.ROW_HEIGHT;

      // Highlight current row
      if (i === this.cursor) {
        surf.fillRect(2, y, vw - 4, this.ROW_HEIGHT - 2, 'rgba(64,64,160,0.5)');
      }

      // Deployed indicator
      const isDeployed = unit.position !== null && unit.position !== undefined;
      const statusColor = isDeployed ? 'rgba(64,200,64,1)' : 'rgba(120,120,120,1)';
      surf.fillRect(4, y + 4, 8, 8, statusColor);

      // Required tag
      const isRequired = unit.tags?.includes('Required');

      // Unit name
      const nameColor = isRequired ? 'rgba(255,200,128,1)' : 'white';
      surf.drawText(unit.name, 16, y + 2, nameColor, '7px monospace');

      // Class
      surf.drawText(unit.klass, 90, y + 2, 'rgba(160,160,200,1)', '6px monospace');

      // Level
      surf.drawText(`Lv${unit.level}`, 150, y + 2, 'rgba(160,160,200,1)', '6px monospace');

      // HP
      const hpText = `${unit.currentHp}/${unit.maxHp}`;
      surf.drawText(hpText, 180, y + 2, 'rgba(160,200,160,1)', '6px monospace');

      // Lock indicator for Required units
      if (isRequired) {
        surf.drawText('*', vw - 12, y + 2, 'rgba(255,200,128,1)', '7px monospace');
      }
    }

    // Scroll indicators
    if (this.scrollOffset > 0) {
      surf.drawText('^', vw / 2, listY - 6, 'rgba(180,180,220,0.6)', '7px monospace');
    }
    if (visibleEnd < this.partyUnits.length) {
      surf.drawText('v', vw / 2, listY + this.VISIBLE_ROWS * this.ROW_HEIGHT, 'rgba(180,180,220,0.6)', '7px monospace');
    }

    // Bottom bar
    surf.fillRect(0, vh - 14, vw, 14, 'rgba(16,16,48,0.8)');
    surf.drawText('SELECT: Toggle  |  B: Back', 4, vh - 11, 'rgba(140,140,180,0.8)', '6px monospace');

    return surf;
  }

  override takeInput(event: InputEvent): StateResult {
    const game = getGame();

    let effective = event;
    if (game.input?.mouseClick === 'SELECT' && !effective) {
      effective = 'SELECT';
    }

    if (effective === 'UP') {
      this.cursor = Math.max(0, this.cursor - 1);
      if (this.cursor < this.scrollOffset) {
        this.scrollOffset = this.cursor;
      }
    } else if (effective === 'DOWN') {
      this.cursor = Math.min(this.partyUnits.length - 1, this.cursor + 1);
      if (this.cursor >= this.scrollOffset + this.VISIBLE_ROWS) {
        this.scrollOffset = this.cursor - this.VISIBLE_ROWS + 1;
      }
    } else if (effective === 'SELECT') {
      this.toggleUnit();
    } else if (effective === 'BACK') {
      game.state.back();
    }
  }

  private toggleUnit(): void {
    const game = getGame();
    if (this.cursor < 0 || this.cursor >= this.partyUnits.length) return;

    const unit = this.partyUnits[this.cursor];
    const isDeployed = unit.position !== null && unit.position !== undefined;
    const isRequired = unit.tags?.includes('Required');

    if (isDeployed) {
      // Remove from map (unless Required)
      if (isRequired) return;

      if (unit.position && game.board) {
        game.board.removeUnit(unit);
      }
    } else {
      // Place on map at first available formation spot
      const formationSpots = getFormationSpots();
      const openSpot = formationSpots.find(s => !game.board?.getUnit(s[0], s[1]));
      if (openSpot && game.board) {
        game.board.setUnit(openSpot[0], openSpot[1], unit);
      }
    }

    this.refreshUnits();
  }
}

// ============================================================================
// PrepMapState — View the map with formation highlights
// ============================================================================

export class PrepMapState extends State {
  readonly name = 'prep_map';
  override readonly transparent = true;
  override readonly showMap = true;
  override readonly inLevel = true;

  override begin(): StateResult {
    const game = getGame();

    // Clear existing highlights and show formation spots
    if (game.highlight) {
      game.highlight.clear();
    }

    // Add formation highlights
    if (game.currentLevel?.regions) {
      for (const region of game.currentLevel.regions) {
        if (region.region_type === 'formation') {
          const x = region.position[0];
          const y = region.position[1];
          const w = region.size?.[0] ?? 1;
          const h = region.size?.[1] ?? 1;
          for (let dx = 0; dx < w; dx++) {
            for (let dy = 0; dy < h; dy++) {
              game.highlight.addHighlight(x + dx, y + dy, 'move');
            }
          }
        }
      }
    }

    // Show cursor
    if (game.cursor) {
      game.cursor.visible = true;
    }
  }

  override draw(surf: Surface): Surface {
    // Draw info overlay at top
    surf.fillRect(0, 0, viewport.width, 14, 'rgba(16,16,48,0.85)');
    surf.drawText('Check Map  |  B: Back  |  START: Fight!', 4, 2, 'rgba(180,180,220,0.9)', '6px monospace');
    return surf;
  }

  override takeInput(event: InputEvent): StateResult {
    const game = getGame();

    if (event === 'BACK') {
      if (game.highlight) {
        game.highlight.clear();
      }
      game.state.back();
    } else if (event === 'START') {
      // Fight shortcut: clear highlights, back to prep_main, then fight
      if (game.highlight) {
        game.highlight.clear();
      }
      // Just go back to prep_main; user can confirm Fight! from there
      game.state.back();
    } else if (event === 'UP' || event === 'DOWN' || event === 'LEFT' || event === 'RIGHT') {
      // Move cursor
      if (game.cursor) {
        const dx = event === 'RIGHT' ? 1 : event === 'LEFT' ? -1 : 0;
        const dy = event === 'DOWN' ? 1 : event === 'UP' ? -1 : 0;
        game.cursor.move(dx, dy);
        const pos = game.cursor.getHover();
        game.camera.focusTile(pos.x, pos.y);
      }
    }
  }

  override end(): StateResult {
    const game = getGame();
    if (game.highlight) {
      game.highlight.clear();
    }
  }
}
