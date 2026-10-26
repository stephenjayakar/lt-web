/**
 * turnwheel-state.ts - TurnwheelState (Divine Pulse)
 *
 * Transparent overlay state that allows the player to rewind and replay
 * game actions. Faithful port of Python's TurnwheelState from
 * app/engine/turnwheel.py.
 *
 * Navigation:
 *   LEFT/UP   = backward (undo)
 *   RIGHT/DOWN = forward (redo)
 *   SELECT    = confirm (finalize rewind, deduct use)
 *   BACK      = cancel (reset to original state, no cost)
 *
 * The display shows:
 *   - Red tint overlay when locked, green when unlocked
 *   - Description text of the current action group
 *   - Turn counter (top-right)
 *   - Remaining uses (bottom-right, if limited)
 */

import { MapState, type StateResult } from '../state';
import { Surface } from '../surface';
import type { InputEvent } from '../input';
import { viewport } from '../viewport';
import { baseSurf, blitSub, blitText, blitTextRight, getSprite, preloadSprites, textWidth } from '../../ui/menu-chrome';
import { drawStyledText } from '../../ui/styled-text';

// ---------------------------------------------------------------------------
// Lazy game reference — same pattern as game-states.ts
// ---------------------------------------------------------------------------

let _game: any = null;
export function setTurnwheelGameRef(g: any): void {
  _game = g;
}
function getGame(): any {
  if (!_game) throw new Error('Turnwheel game reference not set. Call setTurnwheelGameRef() first.');
  return _game;
}

// ---------------------------------------------------------------------------
// TurnwheelDisplay — manages the overlay text and HUD elements
// ---------------------------------------------------------------------------

class TurnwheelDisplay {
  private desc: string[];
  private turn: number;
  private state: 'in' | 'normal' | 'out' = 'in';
  private transition: number = -24;

  constructor(desc: string[], turn: number) {
    this.desc = desc;
    this.turn = turn;
  }

  changeText(desc: string[], turn: number): void {
    this.desc = desc;
    this.turn = turn;
  }

  fadeOut(): void {
    this.state = 'out';
  }

  draw(surf: Surface): void {
    const game = getGame();
    const vw = viewport.width;
    const vh = viewport.height;

    if (this.state === 'in') {
      this.transition += 2;
      if (this.transition >= 0) {
        this.transition = 0;
        this.state = 'normal';
      }
    } else if (this.state === 'out') {
      this.transition -= 2;
    }

    // focus_fade_red when locked, focus_fade_green otherwise (full window).
    drawCover(surf, getSprite(game.actionLog.locked ? 'focus_fade_red' : 'focus_fade_green'), 1);

    // Turnwheel message on a menu_bg_clear strip across the top.
    if (this.desc.length > 0) {
      const bg = baseSurf(vw, 8 + 16 * this.desc.length, 'menu_bg_clear');
      const box = new Surface(bg.width, bg.height);
      box.blit(bg, 0, 0);
      this.desc.forEach((line, idx) => drawStyledText(box, line, 4, 4 + 16 * idx, 'white', 'text'));
      if (this.transition !== 0) box.setAlpha(Math.max(0, 1 + this.transition / 24));
      surf.blit(box, 0, 0);
    }

    // Turn count: golden_words "Turn" + text-blue number, translucent .1.
    const turnBox = translucentBox();
    blitSub(turnBox, getSprite('golden_words'), 0, 17, 26, 10, 4, 6);
    blitTextRight(turnBox, 'text-blue', String(this.turn), 44, 3);
    surf.blit(turnBox, vw - 52, 4 + this.transition);

    // Unit count: unused/total player units on the map.
    const playerUnits = [...(game.units?.values?.() ?? [])]
      .filter((u: any) => u.team === 'player' && u.position);
    const unused = playerUnits.filter((u: any) => !u.finished);
    const countStr = `${unused.length}/${playerUnits.length}`;
    const countBox = translucentBox();
    blitText(countBox, 'text-blue', countStr, Math.floor(24 - textWidth('text-blue', countStr) / 2), 3);
    surf.blit(countBox, 4, vh - 28 - this.transition);

    // Uses remaining, only when limited.
    const maxUses = game.gameVars.get('_max_turnwheel_uses') ?? -1;
    if (maxUses > 0) {
      const usesText = `${game.gameVars.get('_current_turnwheel_uses') ?? 0} Left`;
      const usesBox = translucentBox();
      blitText(usesBox, 'text-blue', usesText, 48 - textWidth('text-blue', usesText) - 8, 4);
      surf.blit(usesBox, vw - 52, vh - 28 - this.transition);
    }
  }
}

/** base_surf.create_base_surf(48, 24) made translucent by .1. */
function translucentBox(): Surface {
  const box = new Surface(48, 24);
  const bg = baseSurf(48, 24);
  const alpha = bg.getAlpha();
  bg.setAlpha(0.9);
  box.blit(bg, 0, 0);
  bg.setAlpha(alpha);
  return box;
}

/** Blit a WINWIDTH x WINHEIGHT overlay stretched to cover the viewport. */
function drawCover(surf: Surface, img: HTMLImageElement | null, alpha: number): void {
  if (!img || alpha <= 0) return;
  const s = surf.scale;
  const ctx = surf.ctx;
  ctx.imageSmoothingEnabled = false;
  const prev = ctx.globalAlpha;
  ctx.globalAlpha = alpha;
  ctx.drawImage(img, 0, 0, img.width, img.height, 0, 0,
    Math.round(viewport.width * s), Math.round(viewport.height * s));
  ctx.globalAlpha = prev;
}

// ---------------------------------------------------------------------------
// TurnwheelState
// ---------------------------------------------------------------------------

export class TurnwheelState extends MapState {
  readonly name = 'turnwheel';
  override readonly transparent = true;

  private force: boolean = false;
  private activatedByPlayer: boolean = true;
  private display: TurnwheelDisplay | null = null;
  private transitionOut: number = 0;
  private turnwheelActivated: boolean = false;
  private lastDirection: 'FORWARD' | 'BACKWARD' = 'FORWARD';
  /** SpriteBackground(focus_fade, fade=True): 100 -> 0 transparency. */
  private bgFade = 100;
  private normalVolume: number | null = null;

  override begin(): StateResult {
    const game = getGame();

    // Whether the player MUST move the turnwheel back (forced by event)
    this.force = game.memory?.get?.('force_turnwheel') ?? false;
    this.activatedByPlayer = !(game.memory?.get?.('event_turnwheel') ?? false);
    if (game.memory?.delete) {
      game.memory.delete('force_turnwheel');
      game.memory.delete('event_turnwheel');
    }

    // Store starting turn for reference
    game.gameVars.set('turnwheel_starting_turn', game.turnCount);

    // Stop recording while the turnwheel is active
    game.actionLog.stopRecording();

    game.audioManager?.playSfx?.('TurnwheelIn2');
    // Python lowers the music to half volume while the turnwheel is open.
    const audio = game.audioManager;
    if (typeof audio?.getMusicVolume === 'function' && typeof audio?.setMusicVolume === 'function') {
      this.normalVolume = audio.getMusicVolume();
      audio.setMusicVolume((this.normalVolume as number) / 2);
    }
    this.bgFade = 100;
    preloadSprites(['focus_fade', 'focus_fade_red', 'focus_fade_green', 'golden_words']);

    // Set up navigation
    const turnwheelDesc = game.actionLog.setUp();
    this.display = new TurnwheelDisplay(turnwheelDesc, game.turnCount);

    this.transitionOut = 0;
    this.turnwheelActivated = false;
    this.lastDirection = 'FORWARD';
  }

  private moveForward(): void {
    const game = getGame();
    const cursorSetPos = (pos: [number, number]) => {
      game.cursor.setPos(pos[0], pos[1]);
    };

    let oldMessage: string[] | null = null;
    if (this.lastDirection === 'BACKWARD') {
      game.actionLog.currentUnit = null;
      oldMessage = game.actionLog.forward(cursorSetPos);
    }
    let newMessage = game.actionLog.forward(cursorSetPos);
    if (newMessage === null) {
      newMessage = oldMessage;
    }
    if (newMessage !== null && this.display) {
      this.display.changeText(newMessage, game.turnCount);
    }
    this.lastDirection = 'FORWARD';
  }

  private moveBack(): void {
    const game = getGame();
    const cursorSetPos = (pos: [number, number]) => {
      game.cursor.setPos(pos[0], pos[1]);
    };

    let oldMessage: string[] | null = null;
    if (this.lastDirection === 'FORWARD') {
      game.actionLog.currentUnit = null;
      oldMessage = game.actionLog.backward(cursorSetPos);
    }
    let newMessage = game.actionLog.backward(cursorSetPos);
    if (newMessage === null) {
      newMessage = oldMessage;
    }
    if (newMessage !== null && this.display) {
      this.display.changeText(newMessage, game.turnCount);
    }
    this.lastDirection = 'BACKWARD';
  }

  private backOut(): void {
    const game = getGame();
    game.actionLog.reset();
    this.transitionOut = 24;
    if (this.display) this.display.fadeOut();
  }

  override takeInput(event: InputEvent): StateResult {
    if (this.transitionOut > 0) return; // Don't take input during transition

    const game = getGame();

    if (event === 'DOWN' || event === 'RIGHT') {
      this.moveForward();
    } else if (event === 'UP' || event === 'LEFT') {
      this.moveBack();
    } else if (event === 'SELECT') {
      if (game.actionLog.canUse()) {
        // Confirm turnwheel
        game.actionLog.finalize();
        this.transitionOut = 60;
        if (this.display) this.display.fadeOut();
        this.turnwheelActivated = true;
        // Deduct a use
        const currentUses = game.gameVars.get('_current_turnwheel_uses') ?? -1;
        if (currentUses > 0) {
          game.gameVars.set('_current_turnwheel_uses', currentUses - 1);
        }
      } else if (!this.force && !game.actionLog.locked) {
        // Not turned back, just exit
        this.backOut();
      } else {
        // Can't use — play error sound
        game.audioManager?.playSfx?.('Error');
      }
    } else if (event === 'BACK') {
      if (!this.force) {
        this.backOut();
      } else {
        game.audioManager?.playSfx?.('Error');
      }
    }
  }

  override update(): StateResult {
    const game = getGame();

    if (this.transitionOut > 0) {
      this.transitionOut -= 1;
      if (this.transitionOut <= 0) {
        if (this.activatedByPlayer) {
          // Pop back through the option_menu and free states
          game.state.back();
          game.state.back();
        } else {
          // Event-triggered: clear stack and go to free state
          game.state.clear();
          game.state.change('free');
          if (game.phase?.setPlayer) {
            game.phase.setPlayer();
          }
        }
        // Trigger OnTurnwheel event if the turnwheel was actually used
        if (this.turnwheelActivated) {
          if (game.eventManager) {
            game.eventManager.clear?.();
            game.eventManager.trigger?.(
              { type: 'on_turnwheel' },
              { game, gameVars: game.gameVars, levelVars: game.levelVars },
            );
          }
        }
      }
    }
  }

  override draw(surf: Surface): Surface {
    // SpriteBackground(focus_fade) fading in.
    if (this.bgFade > 0) this.bgFade = Math.max(0, this.bgFade - 4);
    drawCover(surf, getSprite('focus_fade'), 1 - this.bgFade / 100);
    if (this.display) {
      this.display.draw(surf);
    }
    return surf;
  }

  override end(): void {
    const game = getGame();
    if (this.normalVolume !== null) {
      game.audioManager?.setMusicVolume?.(this.normalVolume);
      this.normalVolume = null;
    }
    // Resume recording
    game.actionLog.startRecording();
  }
}
