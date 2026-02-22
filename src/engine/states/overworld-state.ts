/**
 * overworld-state.ts - Game states for the overworld (world map) system.
 *
 * Three states:
 *   OverworldFreeState   - Main exploration: move cursor, select nodes, start movement
 *   OverworldMovementState - Entity moving along roads (transparent overlay)
 *   OverworldLevelTransitionState - Entering a battle from the overworld
 *
 * Port of: lt-maker/app/engine/overworld/overworld_states.py
 */

import { State, type StateResult } from '../state';
import type { Surface } from '../surface';
import type { InputEvent } from '../input';
import {
  TILEWIDTH,
  TILEHEIGHT,
} from '../constants';
import { viewport, isSmallScreen } from '../viewport';
import { OverworldManager } from '../overworld/overworld-manager';
import { OverworldMovementManager } from '../overworld/overworld-movement';
import type { OverworldNodeObject } from '../overworld/overworld-objects';
import type { OverworldPrefab, TilemapData } from '../../data/types';
import { ChoiceMenu, type MenuOption } from '../../ui/menu';
import { TileMapObject } from '../../rendering/tilemap';

// ---------------------------------------------------------------------------
// Lazy game reference (same pattern as game-states.ts)
// ---------------------------------------------------------------------------

let _game: any = null;
export function setOverworldGameRef(g: any): void {
  _game = g;
}
function getGame(): any {
  if (!_game) throw new Error('Overworld game reference not set');
  return _game;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Move cursor and camera together. */
function moveCursor(dx: number, dy: number): void {
  const game = getGame();
  game.cursor.move(dx, dy);
  const pos = game.cursor.getHover();
  game.camera.focusTile(pos.x, pos.y);
}

/** Get the tile under the mouse, or null. */
function getMouseTile(): [number, number] | null {
  const game = getGame();
  if (!game.input) return null;
  const cam = game.camera.getOffset();
  return game.input.getMouseTile(cam[0], cam[1]);
}

// ============================================================================
// OverworldFreeState - Main exploration state
// ============================================================================

export class OverworldFreeState extends State {
  readonly name = 'overworld';
  override readonly showMap = false;
  override readonly inLevel = false;

  private hoveredNode: OverworldNodeObject | null = null;
  private nodeMenu: ChoiceMenu | null = null;
  private menuNodeNid: string | null = null;

  override start(): StateResult {
    const game = getGame();

    // If there's already an overworld controller set up (e.g., from event),
    // use it. Otherwise, try to load the first overworld from the database.
    if (!game.overworldController) {
      const firstOverworld = game.db.overworlds.values().next().value as OverworldPrefab | undefined;
      if (!firstOverworld) {
        console.warn('OverworldFreeState: no overworlds in database');
        game.state.back();
        return;
      }
      this.setupOverworld(firstOverworld);
    }

    if (!game.overworldMovement) {
      game.overworldMovement = new OverworldMovementManager();
    }

    // Set up camera and cursor based on tilemap (if loaded)
    const ow = game.overworldController as OverworldManager;
    if (game.tilemap) {
      game.camera.setMapSize(game.tilemap.width, game.tilemap.height);
      game.cursor.setMapSize(game.tilemap.width, game.tilemap.height);
    } else {
      const [mw, mh] = ow.mapSize();
      game.camera.setMapSize(mw, mh);
      game.cursor.setMapSize(mw, mh);
    }

    // Center camera on the selected party if there is one
    const selected = ow.getSelectedEntity();
    if (selected?.displayPosition) {
      game.cursor.setPos(selected.displayPosition[0], selected.displayPosition[1]);
      game.camera.forceTile(selected.displayPosition[0], selected.displayPosition[1]);
    }

    // Play overworld music
    if (ow.prefab.music) {
      void game.audioManager.playMusic(ow.prefab.music);
    }
  }

  private async setupOverworld(prefab: OverworldPrefab): Promise<void> {
    const game = getGame();
    game.overworldController = new OverworldManager(prefab);

    // Load tilemap if specified
    if (prefab.tilemap) {
      const tilemapData = game.db.tilemaps.get(prefab.tilemap);
      if (tilemapData) {
        await this.loadTilemap(tilemapData, game);
      }
    }

    // Enable all nodes and roads by default for now
    const ow = game.overworldController as OverworldManager;
    for (const node of ow.nodes.values()) {
      ow.enableNode(node.nid);
    }
    for (const road of ow.roads.values()) {
      ow.enableRoad(road.nid);
    }
  }

  private async loadTilemap(tilemapData: TilemapData, game: any): Promise<void> {
    const tilesetImages = new Map<string, HTMLImageElement>();
    const autotileImages = new Map<string, HTMLImageElement>();
    const tilesetDefs = new Map<string, any>();
    await Promise.all(
      tilemapData.tilesets.map(async (tsNid: string) => {
        const img = await game.resources.tryLoadImage(`resources/tilesets/${tsNid}.png`);
        if (img) tilesetImages.set(tsNid, img);
        const tsDef = game.db.tilesets.get(tsNid);
        if (tsDef) {
          tilesetDefs.set(tsNid, tsDef);
          if (tsDef.autotiles && Object.keys(tsDef.autotiles).length > 0) {
            const autoImg = await game.resources.tryLoadImage(`resources/tilesets/${tsNid}_autotiles.png`);
            if (autoImg) autotileImages.set(tsNid, autoImg);
          }
        }
      }),
    );

    game.tilemap = TileMapObject.fromPrefab(tilemapData, tilesetImages, tilesetDefs, autotileImages);
  }

  override begin(): StateResult {
    const game = getGame();
    game.cursor.visible = true;
    this.nodeMenu = null;
    this.menuNodeNid = null;
  }

  override takeInput(event: InputEvent): StateResult {
    const game = getGame();
    const ow = game.overworldController as OverworldManager | null;
    if (!ow) return;

    // If a node menu is open, handle that first
    if (this.nodeMenu) {
      return this.handleMenuInput(event);
    }

    // Mouse input
    if (game.input?.mouseClick === 'SELECT') {
      const tile = getMouseTile();
      if (tile) {
        game.cursor.setPos(tile[0], tile[1]);
        if (isSmallScreen()) {
          game.camera.focusTile(tile[0], tile[1]);
        }
        this.handleSelect(ow, game);
        return;
      }
    }
    if (game.input?.mouseClick === 'BACK') {
      this.handleBack(ow, game);
      return;
    }
    if (game.input?.mouseMoved) {
      const tile = getMouseTile();
      if (tile) {
        const curPos = game.cursor.getHover();
        if (tile[0] !== curPos.x || tile[1] !== curPos.y) {
          game.cursor.setPos(tile[0], tile[1]);
        }
      }
    }

    if (event === null) return;

    switch (event) {
      case 'UP':    moveCursor(0, -1); break;
      case 'DOWN':  moveCursor(0, 1); break;
      case 'LEFT':  moveCursor(-1, 0); break;
      case 'RIGHT': moveCursor(1, 0); break;

      case 'SELECT':
        this.handleSelect(ow, game);
        break;

      case 'BACK':
        this.handleBack(ow, game);
        break;
    }
  }

  private handleSelect(ow: OverworldManager, game: any): void {
    const cursorPos = game.cursor.getHover();
    const node = ow.nodeAt([cursorPos.x, cursorPos.y]);

    if (!node) return;

    const selected = ow.getSelectedEntity();

    if (selected && selected.onNode === node.nid) {
      // Party is on this node — open the node menu
      this.openNodeMenu(ow, node, game);
    } else if (selected && selected.onNode) {
      // Try to move the party to the clicked node
      const pathPoints = ow.getPathPoints(selected.onNode, node.nid);
      if (pathPoints && pathPoints.length >= 2) {
        const moveMgr = game.overworldMovement as OverworldMovementManager;
        moveMgr.beginMove(selected, pathPoints, {
          follow: true,
          callback: () => {
            ow.movePartyToNode(selected.nid, node.nid);
          },
        });
        game.state.change('overworld_movement');
      }
    }
  }

  private handleBack(ow: OverworldManager, game: any): void {
    // Snap to party position
    const selected = ow.getSelectedEntity();
    if (selected?.displayPosition) {
      game.cursor.setPos(
        Math.round(selected.displayPosition[0]),
        Math.round(selected.displayPosition[1]),
      );
      game.camera.focusTile(
        Math.round(selected.displayPosition[0]),
        Math.round(selected.displayPosition[1]),
      );
    }
  }

  private openNodeMenu(ow: OverworldManager, node: OverworldNodeObject, game: any): void {
    const options: MenuOption[] = [];

    // Add menu options from the node prefab
    for (const opt of node.prefab.menu_options) {
      const visible = ow.visibleMenuOptions.get(node.nid)?.get(opt.nid) ?? opt.visible;
      if (!visible) continue;
      const enabled = ow.enabledMenuOptions.get(node.nid)?.get(opt.nid) ?? opt.enabled;
      options.push({
        label: opt.option_name || opt.nid,
        value: opt.nid,
        enabled,
      });
    }

    // If the node has a level, add "Enter" option
    if (node.prefab.level) {
      const hasEnter = options.some(o => o.value === 'Enter' || o.label === 'Enter');
      if (!hasEnter) {
        options.push({ label: 'Enter', value: '_enter_level', enabled: true });
      }
    }

    if (options.length === 0) return;

    // Position menu at center of screen
    const menuX = Math.floor(viewport.width / 2) - 30;
    const menuY = Math.floor(viewport.height / 2) - (options.length * 8 + 4);
    this.nodeMenu = new ChoiceMenu(options, menuX, menuY);
    this.menuNodeNid = node.nid;
  }

  private handleMenuInput(event: InputEvent): StateResult {
    if (!this.nodeMenu) return;
    const game = getGame();
    const ow = game.overworldController as OverworldManager;

    // Handle mouse click on menu options
    let result: { selected: string } | { back: true } | null = null;
    if (game.input?.mouseClick) {
      const [gx, gy] = game.input.getGameMousePos();
      result = this.nodeMenu.handleClick(gx, gy, game.input.mouseClick as 'SELECT' | 'BACK');
    }
    if (game.input?.mouseMoved) {
      const [gx, gy] = game.input.getGameMousePos();
      this.nodeMenu.handleMouseHover(gx, gy);
    }
    if (!result && event !== null) {
      result = this.nodeMenu.handleInput(event);
    }
    if (!result) return;

    if ('back' in result) {
      this.nodeMenu = null;
      this.menuNodeNid = null;
      return;
    }

    if ('selected' in result) {
      const value = result.selected;

      if (value === '_enter_level') {
        // Enter the level associated with this node
        const node = ow.getNode(this.menuNodeNid!);
        if (node?.prefab.level) {
          ow.nextLevel = node.prefab.level;
          this.nodeMenu = null;
          this.menuNodeNid = null;
          game.state.change('overworld_next_level');
        }
      } else {
        // Trigger the event associated with this menu option
        const node = ow.getNode(this.menuNodeNid!);
        if (node && game.eventManager) {
          const opt = node.prefab.menu_options.find(o => o.nid === value);
          if (opt?.event) {
            const ctx = { game, gameVars: game.gameVars, levelVars: game.levelVars };
            game.eventManager.trigger(
              { type: 'overworld_menu', optionNid: value, nodeNid: this.menuNodeNid },
              ctx,
            );
            if (game.eventManager.hasActiveEvents()) {
              game.state.change('event');
            }
          }
        }
        this.nodeMenu = null;
        this.menuNodeNid = null;
      }
    }
  }

  override update(): StateResult {
    const game = getGame();

    // Update hovered node name
    const cursorPos = game.cursor.getHover();
    const ow = game.overworldController as OverworldManager | null;
    if (ow) {
      this.hoveredNode = ow.nodeAt([cursorPos.x, cursorPos.y]) ?? null;
    }

    // Check for pending events
    if (game.eventManager?.hasActiveEvents()) {
      game.state.change('event');
    }
  }

  override draw(surf: Surface): Surface {
    const game = getGame();
    const ow = game.overworldController as OverworldManager | null;
    if (!ow) return surf;

    // 1. Draw tilemap background
    if (game.tilemap) {
      game.camera.update();
      game.cursor.update();
      const cullRect = game.camera.getCullRect();
      game.tilemap.updateAutotiles(Date.now());
      const bg = game.tilemap.getFullImage(cullRect);
      surf.blit(bg, -TILEWIDTH, -TILEHEIGHT);

      // Foreground layers
      const fg = game.tilemap.getForegroundImage(cullRect);
      if (fg) surf.blit(fg, -TILEWIDTH, -TILEHEIGHT);
    } else {
      // No tilemap: dark background
      surf.fill(24, 32, 48);
      game.camera.update();
      game.cursor.update();
    }

    const cameraOffset = game.camera.getOffset();

    // 2. Draw enabled roads
    for (const road of ow.roads.values()) {
      if (!ow.enabledRoads.has(road.nid)) continue;
      this.drawRoad(surf, road.points, cameraOffset);
    }

    // 3. Draw enabled nodes
    for (const node of ow.nodes.values()) {
      if (!ow.enabledNodes.has(node.nid)) continue;
      this.drawNode(surf, node, cameraOffset);
    }

    // 4. Draw entities
    for (const entity of ow.entities.values()) {
      if (!entity.displayPosition) continue;
      this.drawEntity(surf, entity.displayPosition, entity.team, cameraOffset);
    }

    // 5. Draw cursor
    if (game.cursor.visible) {
      game.cursor.draw(surf, cameraOffset);
    }

    // 6. Draw UI: hovered node name
    if (this.hoveredNode && ow.enabledNodes.has(this.hoveredNode.nid)) {
      const name = this.hoveredNode.name;
      const textW = name.length * 5;
      const barW = textW + 12;
      const barX = Math.floor((viewport.width - barW) / 2);
      const barY = viewport.height - 20;
      surf.fillRect(barX, barY, barW, 14, 'rgba(0,0,32,0.8)');
      surf.drawRect(barX, barY, barW, 14, 'rgba(100,100,180,0.5)');
      surf.drawText(name, barX + 6, barY + 3, 'white', '8px monospace');
    }

    // 7. Draw node menu if open
    if (this.nodeMenu) {
      this.nodeMenu.draw(surf);
    }

    return surf;
  }

  // ---- Drawing helpers ----

  private drawRoad(
    surf: Surface,
    points: [number, number][],
    cameraOffset: [number, number],
  ): void {
    if (points.length < 2) return;
    for (let i = 0; i < points.length - 1; i++) {
      const x1 = points[i][0] * TILEWIDTH + TILEWIDTH / 2 - cameraOffset[0];
      const y1 = points[i][1] * TILEHEIGHT + TILEHEIGHT / 2 - cameraOffset[1];
      const x2 = points[i + 1][0] * TILEWIDTH + TILEWIDTH / 2 - cameraOffset[0];
      const y2 = points[i + 1][1] * TILEHEIGHT + TILEHEIGHT / 2 - cameraOffset[1];
      surf.drawLine(x1, y1, x2, y2, 'rgba(200,180,120,0.7)', 2);
    }
  }

  private drawNode(
    surf: Surface,
    node: OverworldNodeObject,
    cameraOffset: [number, number],
  ): void {
    const px = node.position[0] * TILEWIDTH - cameraOffset[0];
    const py = node.position[1] * TILEHEIGHT - cameraOffset[1];

    // Draw node as a circle indicator
    const cx = px + TILEWIDTH / 2;
    const cy = py + TILEHEIGHT / 2;
    const radius = 5;

    // Outer ring
    surf.ctx.beginPath();
    surf.ctx.arc(
      cx * surf.scale,
      cy * surf.scale,
      radius * surf.scale,
      0,
      Math.PI * 2,
    );
    surf.ctx.fillStyle = 'rgba(255,220,120,0.9)';
    surf.ctx.fill();
    surf.ctx.strokeStyle = 'rgba(180,140,60,1)';
    surf.ctx.lineWidth = 1 * surf.scale;
    surf.ctx.stroke();

    // Node has a level: draw a small dot in center
    if (node.prefab.level) {
      surf.ctx.beginPath();
      surf.ctx.arc(
        cx * surf.scale,
        cy * surf.scale,
        2 * surf.scale,
        0,
        Math.PI * 2,
      );
      surf.ctx.fillStyle = 'rgba(255,100,100,0.9)';
      surf.ctx.fill();
    }
  }

  private drawEntity(
    surf: Surface,
    pos: [number, number],
    team: string,
    cameraOffset: [number, number],
  ): void {
    const px = pos[0] * TILEWIDTH - cameraOffset[0];
    const py = pos[1] * TILEHEIGHT - cameraOffset[1];

    // Draw as a small colored diamond/arrow
    const cx = px + TILEWIDTH / 2;
    const cy = py + TILEHEIGHT / 2 - 4; // Slightly above center

    const color = team === 'player'
      ? 'rgba(64,160,255,0.95)'
      : team === 'enemy'
        ? 'rgba(220,40,40,0.95)'
        : 'rgba(40,180,40,0.95)';

    // Diamond shape
    const s = surf.scale;
    surf.ctx.beginPath();
    surf.ctx.moveTo(cx * s, (cy - 4) * s);
    surf.ctx.lineTo((cx + 4) * s, cy * s);
    surf.ctx.lineTo(cx * s, (cy + 4) * s);
    surf.ctx.lineTo((cx - 4) * s, cy * s);
    surf.ctx.closePath();
    surf.ctx.fillStyle = color;
    surf.ctx.fill();
    surf.ctx.strokeStyle = 'rgba(255,255,255,0.7)';
    surf.ctx.lineWidth = 1 * s;
    surf.ctx.stroke();
  }
}

// ============================================================================
// OverworldMovementState - Entity moving along roads
// ============================================================================

export class OverworldMovementState extends State {
  readonly name = 'overworld_movement';
  override readonly transparent = true;
  override readonly showMap = false;
  override readonly inLevel = false;

  override begin(): StateResult {
    const game = getGame();
    game.cursor.visible = false;
  }

  override update(): StateResult {
    const game = getGame();
    const moveMgr = game.overworldMovement as OverworldMovementManager | null;
    if (!moveMgr) {
      game.state.back();
      return;
    }

    // Update movement animation
    moveMgr.update(game.frameDeltaMs ?? 16);

    // Follow camera to the moving entity
    const followPos = moveMgr.getFollowingEntityPosition();
    if (followPos) {
      game.camera.focusTile(Math.round(followPos[0]), Math.round(followPos[1]));
    }

    // When movement is done, pop back
    if (!moveMgr.isMoving()) {
      game.cursor.visible = true;

      // Move cursor to where the entity ended up
      const ow = game.overworldController as OverworldManager | null;
      const selected = ow?.getSelectedEntity();
      if (selected?.displayPosition) {
        game.cursor.setPos(
          Math.round(selected.displayPosition[0]),
          Math.round(selected.displayPosition[1]),
        );
      }

      game.state.back();
    }
  }

  override takeInput(event: InputEvent): StateResult {
    // Allow fast-forwarding movement with SELECT
    if (event === 'SELECT') {
      const game = getGame();
      const moveMgr = game.overworldMovement as OverworldMovementManager | null;
      moveMgr?.finishAllMovement();
    }
  }

  override draw(surf: Surface): Surface {
    // Movement state is transparent — the OverworldFreeState draws underneath
    return surf;
  }
}

// ============================================================================
// OverworldLevelTransitionState - Entering a battle from overworld
// ============================================================================

export class OverworldLevelTransitionState extends State {
  readonly name = 'overworld_next_level';
  override readonly transparent = true;
  override readonly showMap = false;
  override readonly inLevel = false;

  private loading: boolean = false;
  private fadeProgress: number = 0;
  private fadeDuration: number = 500; // ms

  override start(): StateResult {
    this.loading = false;
    this.fadeProgress = 0;
  }

  override update(): StateResult {
    const game = getGame();
    const ow = game.overworldController as OverworldManager | null;

    // Fade to black
    this.fadeProgress = Math.min(1, this.fadeProgress + (game.frameDeltaMs ?? 16) / this.fadeDuration);

    if (this.fadeProgress >= 1 && !this.loading) {
      this.loading = true;

      const levelNid = ow?.nextLevel;
      if (!levelNid) {
        game.state.back();
        return;
      }

      // Load the level
      game.loadLevel(levelNid).then(() => {
        game.state.clear();
        game.state.change('free');
        if (game.eventManager?.hasActiveEvents()) {
          game.state.change('event');
        }
      }).catch((err: unknown) => {
        console.error('Failed to load level from overworld:', err);
        game.state.back();
      });
    }
  }

  override draw(surf: Surface): Surface {
    // Draw fade-to-black overlay
    const alpha = Math.min(1, this.fadeProgress);
    surf.fillRect(0, 0, viewport.width, viewport.height, `rgba(0,0,0,${alpha.toFixed(2)})`);

    if (this.loading) {
      const loadText = 'Loading...';
      const textW = loadText.length * 5;
      surf.drawText(
        loadText,
        Math.floor((viewport.width - textW) / 2),
        Math.floor(viewport.height / 2),
        'white',
        '8px monospace',
      );
    }

    return surf;
  }
}
