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
import type { Surface } from '../surface';
import type { InputEvent } from '../input';
import { WINWIDTH, WINHEIGHT } from '../constants';
import { viewport } from '../viewport';

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

    // Animate transition
    if (this.state === 'in') {
      this.transition += 2;
      if (this.transition >= 0) {
        this.transition = 0;
        this.state = 'normal';
      }
    } else if (this.state === 'out') {
      this.transition -= 2;
    }

    // Tinted overlay: red if locked, green if unlocked
    if (game.actionLog.locked) {
      surf.fillRect(0, 0, vw, vh, 'rgba(180,40,40,0.15)');
    } else {
      surf.fillRect(0, 0, vw, vh, 'rgba(40,180,40,0.15)');
    }

    // Description text (top area)
    if (this.desc.length > 0) {
      const numLines = this.desc.length;
      const bgH = 8 + 16 * numLines;
      const alpha = this.transition !== 0 ? Math.max(0, 1 - Math.abs(this.transition) / 24) : 1;
      surf.fillRect(0, 0, vw, bgH, `rgba(16,16,32,${(0.7 * alpha).toFixed(2)})`);
      for (let i = 0; i < this.desc.length; i++) {
        surf.drawText(
          this.desc[i],
          4,
          4 + 16 * i + this.transition,
          `rgba(255,255,255,${alpha.toFixed(2)})`,
          '8px monospace',
        );
      }
    }

    // Turn counter (top-right)
    const turnY = 4 + this.transition;
    const turnBgW = 48;
    const turnBgH = 20;
    const turnX = vw - turnBgW - 4;
    surf.fillRect(turnX, turnY, turnBgW, turnBgH, 'rgba(16,16,32,0.7)');
    surf.drawRect(turnX, turnY, turnBgW, turnBgH, 'rgba(80,80,160,0.6)');
    surf.drawText('Turn', turnX + 4, turnY + 4, 'rgba(200,180,100,1)', '7px monospace');
    const turnStr = String(this.turn);
    const turnStrW = turnStr.length * 5;
    surf.drawText(turnStr, turnX + turnBgW - turnStrW - 4, turnY + 4, 'rgba(120,180,255,1)', '8px monospace');

    // Unit count (bottom-left)
    const countY = vh - 24 - this.transition;
    const countBgW = 48;
    const countBgH = 20;
    surf.fillRect(4, countY, countBgW, countBgH, 'rgba(16,16,32,0.7)');
    surf.drawRect(4, countY, countBgW, countBgH, 'rgba(80,80,160,0.6)');

    const playerUnits = game.board?.getTeamUnits('player')?.filter((u: any) => u.position && !u.isDead()) ?? [];
    const unusedUnits = playerUnits.filter((u: any) => !u.finished);
    const countStr = `${unusedUnits.length}/${playerUnits.length}`;
    const countW = countStr.length * 5;
    surf.drawText(countStr, 4 + Math.floor((countBgW - countW) / 2), countY + 4, 'rgba(120,180,255,1)', '8px monospace');

    // Uses remaining (bottom-right, only if limited)
    const maxUses = game.gameVars.get('_max_turnwheel_uses') ?? -1;
    if (maxUses > 0) {
      const currentUses = game.gameVars.get('_current_turnwheel_uses') ?? 0;
      const usesY = vh - 24 - this.transition;
      const usesBgW = 48;
      const usesBgH = 20;
      const usesX = vw - usesBgW - 4;
      surf.fillRect(usesX, usesY, usesBgW, usesBgH, 'rgba(16,16,32,0.7)');
      surf.drawRect(usesX, usesY, usesBgW, usesBgH, 'rgba(80,80,160,0.6)');
      const usesText = `${currentUses} Left`;
      const usesTextW = usesText.length * 5;
      surf.drawText(usesText, usesX + usesBgW - usesTextW - 4, usesY + 4, 'rgba(120,180,255,1)', '8px monospace');
    }
  }
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
    // Draw the display overlay
    if (this.display) {
      this.display.draw(surf);
    }
    return surf;
  }

  override end(): void {
    const game = getGame();
    // Resume recording
    game.actionLog.startRecording();
  }
}
