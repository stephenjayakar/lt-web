/**
 * prep-state.ts — GBA-style preparation screen states.
 *
 * PrepMainState: Main prep menu (Pick Units, Check Map, Fight!)
 * PrepPickUnitsState: Toggle units on/off the deployment map
 * PrepMapState: View the map with formation highlights
 */

import { State, type StateResult } from '../state';
import type { Surface } from '../surface';
import type { InputEvent } from '../input';
import { viewport } from '../viewport';
import type { UnitObject } from '../../objects/unit';

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
    this.options.push('Check Map');
    this.descriptions.push('View the battlefield.');
    this.options.push('Fight!');
    this.descriptions.push('Begin the battle!');

    this.cursor = 0;
    this.slideX = -120;
    this.slideTimer = 0;

    // Setup: force-place Required units on formation spots
    this.setupUnits();
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
    const panelY = 30;
    const panelW = 100;
    const panelH = this.options.length * 18 + 12;
    surf.fillRect(panelX, panelY, panelW, panelH, 'rgba(16,16,48,0.9)');
    surf.drawRect(panelX, panelY, panelW, panelH, 'rgba(100,100,180,0.7)');

    for (let i = 0; i < this.options.length; i++) {
      const optX = Math.floor(this.slideX);
      const optY = panelY + 6 + i * 18;

      if (i === this.cursor) {
        surf.fillRect(panelX + 2, optY - 2, panelW - 4, 16, 'rgba(64,64,160,0.6)');
        const bob = Math.sin(this.slideTimer / 300 * Math.PI) * 1.5;
        surf.drawText('>', optX - 8, optY + bob, 'rgba(255,255,128,1)', '8px monospace');
      }

      const optLabel = this.options[i];
      // Highlight "Fight!" in gold
      let textColor: string;
      if (optLabel === 'Fight!') {
        textColor = i === this.cursor ? 'rgba(255,220,128,1)' : 'rgba(200,180,100,1)';
      } else {
        textColor = i === this.cursor ? 'white' : 'rgba(180,180,200,1)';
      }
      surf.drawText(optLabel, optX, optY, textColor, '8px monospace');
    }

    // Description box
    if (this.cursor < this.descriptions.length) {
      const descY = panelY + panelH + 8;
      surf.fillRect(panelX, descY, panelW, 20, 'rgba(16,16,48,0.8)');
      surf.drawText(this.descriptions[this.cursor], panelX + 4, descY + 4, 'rgba(180,180,220,1)', '6px monospace');
    }

    // Unit count display
    const partyUnits = getPartyUnits();
    const deployed = partyUnits.filter(u => u.position !== null && u.position !== undefined).length;
    const total = partyUnits.length;
    const slots = getFormationSpots().length;
    const countText = `Units: ${deployed}/${Math.min(total, slots)}`;
    surf.drawText(countText, vw - 80, vh - 14, 'rgba(180,180,220,1)', '7px monospace');

    // Bottom button hints
    surf.fillRect(0, vh - 18, vw, 18, 'rgba(16,16,48,0.8)');
    surf.drawText('SELECT: Choose  |  START: Fight!', 4, vh - 14, 'rgba(140,140,180,0.8)', '6px monospace');

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
      } else if (selected === 'Check Map') {
        game.state.change('prep_map');
      } else if (selected === 'Fight!') {
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

    // Exit prep — go back to event system which will continue processing
    game.state.back();
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
