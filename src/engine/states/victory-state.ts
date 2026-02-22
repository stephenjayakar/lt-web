/**
 * victory-state.ts — Victory screen shown after completing a chapter.
 *
 * Displays an animated "VICTORY" banner and a stats panel (turn count, MVP)
 * that slides up from the bottom. The map draws underneath with a dark
 * semi-transparent overlay.
 *
 * Port of LT's victory screen concept. No Python reference file exists;
 * this is built from the spec and matches the engine's state patterns.
 */

import { State, type StateResult } from '../state';
import type { Surface } from '../surface';
import { Surface as SurfaceClass } from '../surface';
import type { InputEvent } from '../input';
import { viewport } from '../viewport';
import { WINWIDTH, WINHEIGHT } from '../constants';
import { getMenuBackgroundSync } from '../../ui/base-surf';

// ---------------------------------------------------------------------------
// Lazy game reference (same pattern as other state files)
// ---------------------------------------------------------------------------

let _game: any = null;
export function setVictoryGameRef(g: any): void {
  _game = g;
}
function getGame(): any {
  if (!_game) throw new Error('Game reference not set for victory state');
  return _game;
}

// ---------------------------------------------------------------------------
// Colors & layout constants
// ---------------------------------------------------------------------------

const GOLD = 'rgba(255,215,0,1)';
const GOLD_DIM = 'rgba(200,170,40,1)';
const YELLOW = 'rgba(255,255,128,1)';
const BLUE = 'rgba(128,180,255,1)';
const WHITE = 'rgba(255,255,255,1)';
const BANNER_COLOR = 'rgba(180,140,30,0.85)';
const BANNER_BORDER = 'rgba(255,220,80,0.9)';
const OVERLAY_COLOR = 'rgba(0,0,0,0.5)';

const STAT_PANEL_W = 96;
const STAT_PANEL_H = 40;
const BANNER_HEIGHT = 24;

const FONT_LABEL = '7px monospace';
const FONT_VALUE = '8px monospace';
const FONT_VICTORY = '14px monospace';

// ---------------------------------------------------------------------------
// Helper: find the MVP unit
// ---------------------------------------------------------------------------

interface MvpResult {
  name: string;
  kills: number;
}

function findMvp(): MvpResult {
  const game = getGame();
  let bestName = '???';
  let bestKills = 0;

  if (game.units) {
    for (const unit of game.units.values()) {
      if (unit.team !== 'player') continue;
      // Try kills first, fall back to records.kills or damage dealt
      const kills: number =
        unit.records?.kills ??
        unit.kill_count ??
        unit.records?.damage ??
        0;
      if (kills > bestKills) {
        bestKills = kills;
        bestName = unit.name ?? unit.nid ?? '???';
      }
    }
  }

  // If nobody has kills, just pick the first living player unit
  if (bestKills === 0 && game.units) {
    for (const unit of game.units.values()) {
      if (unit.team === 'player' && !unit.dead) {
        bestName = unit.name ?? unit.nid ?? '???';
        break;
      }
    }
  }

  return { name: bestName, kills: bestKills };
}

// ---------------------------------------------------------------------------
// VictoryState
// ---------------------------------------------------------------------------

export class VictoryState extends State {
  override readonly name = 'victory';
  override readonly showMap = true;

  private state: 'init' | 'allow_input' | 'leave' = 'init';
  private numFrame: number = 0;
  private numTransitionFrames: number = 20;
  private statSurf: SurfaceClass | null = null;
  private overlayAlpha: number = 0;
  private turnCount: number = 0;
  private mvpName: string = '???';

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  override start(): StateResult {
    const game = getGame();

    // Hide cursor if it exists
    if (game.cursor) {
      game.cursor.visible = false;
    }

    // Gather stats
    this.turnCount = game.turncount ?? game.turn_count ?? 0;
    const mvp = findMvp();
    this.mvpName = mvp.name;

    // Build the stat panel surface (9-slice background + text)
    this.statSurf = this.buildStatSurface();

    // Play victory fanfare if audio manager is available
    if (game.audio) {
      try {
        game.audio.playSfx?.('StageClear');
      } catch {
        // sound not available — skip
      }
      // Lower music volume slightly
      try {
        game.audio.setMusicVolume?.(0.3);
      } catch {
        // ignore
      }
    }

    // Reset animation state
    this.state = 'init';
    this.numFrame = 0;
    this.overlayAlpha = 0;
  }

  override update(): StateResult {
    if (this.state === 'init') {
      this.numFrame = Math.min(this.numFrame + 1, this.numTransitionFrames);
      // Fade overlay in during init
      this.overlayAlpha = Math.min(1, this.numFrame / this.numTransitionFrames);
      if (this.numFrame >= this.numTransitionFrames) {
        this.state = 'allow_input';
      }
    } else if (this.state === 'allow_input') {
      // Keep overlay fully faded in
      this.overlayAlpha = 1;
    }
  }

  override takeInput(event: InputEvent): StateResult {
    if (this.state !== 'allow_input') return;
    if (event === null) return;

    if (event === 'SELECT' || event === 'START' || event === 'BACK') {
      this.state = 'leave';
      const game = getGame();
      // Restore music volume
      if (game.audio) {
        try {
          game.audio.setMusicVolume?.(1.0);
        } catch {
          // ignore
        }
      }
      game.state.back();
      return 'repeat';
    }
  }

  override draw(surf: Surface): Surface {
    const vw = viewport.width;
    const vh = viewport.height;

    // 1. Draw the map underneath (or dark fill if no level)
    this.drawMapBackground(surf);

    // 2. Semi-transparent dark overlay
    const alpha = 0.5 * this.overlayAlpha;
    surf.fillRect(0, 0, vw, vh, `rgba(0,0,0,${alpha})`);

    // Animation progress (0 to 1)
    const t = Math.min(1, this.numFrame / this.numTransitionFrames);
    // Ease-out quad for smoother animation
    const eased = 1 - (1 - t) * (1 - t);

    // 3. Draw VICTORY banner
    this.drawBanner(surf, eased);

    // 4. Draw stat panel sliding up from bottom
    this.drawStatPanel(surf, eased);

    return surf;
  }

  // -----------------------------------------------------------------------
  // Drawing helpers
  // -----------------------------------------------------------------------

  private drawMapBackground(surf: Surface): void {
    const game = getGame();

    // Try to draw the actual map if available
    if (game.mapView && game.camera) {
      try {
        game.camera.update();
        game.mapView.draw(surf, game.camera);
      } catch {
        // Fall back to dark fill
        surf.fill(16, 16, 32);
      }
    } else {
      surf.fill(16, 16, 32);
    }
  }

  private drawBanner(surf: Surface, t: number): void {
    const vw = viewport.width;
    const vh = viewport.height;

    // Banner positioned at roughly 1/3 from the top
    const bannerCenterY = Math.floor(vh * 0.30);
    const currentHeight = Math.max(1, Math.floor(BANNER_HEIGHT * t));
    const bannerY = bannerCenterY - Math.floor(currentHeight / 2);

    // Opacity fades in with animation
    const opacity = t;

    // Gold background bar
    const r = 180, g = 140, b = 30;
    const barAlpha = 0.85 * opacity;
    surf.fillRect(0, bannerY, vw, currentHeight, `rgba(${r},${g},${b},${barAlpha})`);

    // Top and bottom border lines
    const borderAlpha = 0.9 * opacity;
    surf.fillRect(0, bannerY, vw, 1, `rgba(255,220,80,${borderAlpha})`);
    surf.fillRect(0, bannerY + currentHeight - 1, vw, 1, `rgba(255,220,80,${borderAlpha})`);

    // "VICTORY" text — only draw when there's enough height for it to look good
    if (currentHeight >= 10) {
      const text = 'VICTORY';
      // Approximate text width: ~8px per char at 14px font
      const textW = text.length * 8;
      const textX = Math.floor((vw - textW) / 2);
      // Vertically center in the banner
      const textY = bannerY + Math.floor((currentHeight - 14) / 2);

      // Shadow
      const shadowAlpha = 0.7 * opacity;
      surf.drawText(text, textX + 1, textY + 1, `rgba(80,50,0,${shadowAlpha})`, FONT_VICTORY);

      // Main text
      const textAlpha = opacity;
      surf.drawText(text, textX, textY, `rgba(255,255,255,${textAlpha})`, FONT_VICTORY);
    }
  }

  private drawStatPanel(surf: Surface, t: number): void {
    if (!this.statSurf) return;

    const vw = viewport.width;
    const vh = viewport.height;

    // Panel slides up from the bottom
    const panelW = this.statSurf.width;
    const panelH = this.statSurf.height;
    const targetY = vh - panelH - 8; // 8px padding from bottom
    const startY = vh; // starts just below the screen

    const currentY = Math.floor(startY + (targetY - startY) * t);
    const panelX = Math.floor((vw - panelW) / 2);

    // Fade in the panel
    this.statSurf.setAlpha(t);
    surf.blit(this.statSurf, panelX, currentY);
    this.statSurf.setAlpha(1); // restore
  }

  // -----------------------------------------------------------------------
  // Stat surface construction
  // -----------------------------------------------------------------------

  private buildStatSurface(): SurfaceClass {
    const w = STAT_PANEL_W;
    const h = STAT_PANEL_H;

    // Get 9-slice menu background (or dark fallback)
    const bg = getMenuBackgroundSync(w, h);
    const panel = bg.copy();

    // Layout:
    //   Row 1 (y=4):  "Turns" (yellow)   turnCount (blue)
    //   Row 2 (y=20): "MVP"   (yellow)   mvpName   (blue)

    const labelX = 6;
    const valueX = 42;
    const row1Y = 6;
    const row2Y = 22;

    // Row 1: Turns
    panel.drawText('Turns', labelX, row1Y, YELLOW, FONT_LABEL);
    panel.drawText(String(this.turnCount), valueX, row1Y, BLUE, FONT_VALUE);

    // Row 2: MVP
    panel.drawText('MVP', labelX, row2Y, YELLOW, FONT_LABEL);
    // Truncate MVP name if too long for the panel
    let mvpDisplay = this.mvpName;
    if (mvpDisplay.length > 8) {
      mvpDisplay = mvpDisplay.substring(0, 7) + '.';
    }
    panel.drawText(mvpDisplay, valueX, row2Y, BLUE, FONT_VALUE);

    return panel;
  }
}
