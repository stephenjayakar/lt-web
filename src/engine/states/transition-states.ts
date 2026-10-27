/**
 * transition-states.ts — Python `transitions.py`: the short fade-to/from-
 * black states menus push between screens (`transition_in`, `transition_out`,
 * `transition_pop`, `transition_double_pop`, `transition_to`,
 * `transition_to_with_pop`). They are transparent overlays that take no
 * input, so a key pressed during the fade never reaches the next screen.
 *
 * Python times them with engine.get_time(); the web counts frame time, so a
 * stepped harness and a throttled tab fade the same number of frames.
 */

import { State, type StateResult } from '../state';
import type { Surface } from '../surface';

let gameRef: (() => any) | null = null;

export function setTransitionGameRef(getter: () => any): void {
  gameRef = getter;
}

/** Python transitions.transition_speed (multiplied by 133 ms). */
const TRANSITION_SPEED = 1;
const BASE_WAIT = 133;

abstract class TransitionBase extends State {
  override readonly transparent = true;
  protected elapsed = 0;
  protected waitTime = BASE_WAIT;
  private updated = false;

  override start(): StateResult {
    const game = gameRef?.();
    this.elapsed = 0;
    this.updated = false;
    const speed = Number(game?.memory?.get?.('transition_speed')) || TRANSITION_SPEED;
    this.waitTime = speed * BASE_WAIT;
  }

  /**
   * Python `engine.get_time() >= start_time + wait_time`, timed from the
   * start frame (whose update sees 0 ms) on the integer millisecond clock:
   * 133 ms ends on the eighth frame after it.
   */
  protected done(): boolean {
    const game = gameRef?.();
    if (this.updated) this.elapsed += Number(game?.frameDeltaMs) || 1000 / 60;
    this.updated = true;
    return Math.floor(this.elapsed + 1e-6) >= this.waitTime;
  }

  protected progress(): number {
    return Math.max(0, Math.min(1, this.elapsed / this.waitTime));
  }

  /** Black at `alpha` (Python make_translucent(bg_black, 1 - alpha)). */
  protected drawBlack(surf: Surface, alpha: number): Surface {
    if (alpha > 0) surf.fillRect(0, 0, surf.width, surf.height, `rgba(0,0,0,${alpha})`);
    return surf;
  }

  override finish(): void {
    gameRef?.()?.memory?.delete?.('transition_speed');
  }
}

/** Python TransitionInState: black fading away, then back. */
export class TransitionInState extends TransitionBase {
  readonly name: string = 'transition_in';

  override update(): StateResult {
    if (this.done()) {
      gameRef?.()?.state.back();
      return 'repeat';
    }
  }

  override draw(surf: Surface): Surface {
    return this.drawBlack(surf, 1 - this.progress());
  }
}

/** Python TransitionOutState: fading to black, then back. */
export class TransitionOutState extends TransitionInState {
  override readonly name: string = 'transition_out';

  override draw(surf: Surface): Surface {
    return this.drawBlack(surf, this.progress());
  }
}

/** Python TransitionPopState: fade to black, then pop it and the state below. */
export class TransitionPopState extends TransitionOutState {
  override readonly name: string = 'transition_pop';

  override update(): StateResult {
    if (this.done()) {
      const state = gameRef?.()?.state;
      state.back();
      state.back();
      return 'repeat';
    }
  }
}

/** Python TransitionDoublePopState. */
export class TransitionDoublePopState extends TransitionOutState {
  override readonly name: string = 'transition_double_pop';

  override update(): StateResult {
    if (this.done()) {
      const state = gameRef?.()?.state;
      state.back();
      state.back();
      state.back();
      return 'repeat';
    }
  }
}

/** Python TransitionToState: fade to black, then change to memory['next_state']. */
export class TransitionToState extends TransitionOutState {
  override readonly name: string = 'transition_to';

  override update(): StateResult {
    if (this.done()) {
      const game = gameRef?.();
      game.state.back();
      game.state.change(game.memory.get('next_state'));
      return 'repeat';
    }
  }
}

/** Python TransitionToWithPopState: pops the caller too. */
export class TransitionToWithPopState extends TransitionOutState {
  override readonly name: string = 'transition_to_with_pop';

  override update(): StateResult {
    if (this.done()) {
      const game = gameRef?.();
      game.state.back();
      game.state.back();
      game.state.change(game.memory.get('next_state'));
      return 'repeat';
    }
  }
}
