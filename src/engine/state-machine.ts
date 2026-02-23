/**
 * StateMachine - Stack-based state machine matching LT's architecture.
 *
 * States live on a stack. The topmost state receives input and updates.
 * Transparent states allow states beneath them to draw as well (the stack
 * is walked downward until a non-transparent state is found, then drawn
 * bottom-up).
 *
 * State transitions (change/back/clear) are deferred: they are queued into
 * temp_state and processed at the end of update() so that the current
 * lifecycle frame completes cleanly.
 */

import { State, type StateResult } from './state';
import type { Surface } from './surface';
import type { InputEvent } from './input';

type TempOp =
  | { kind: 'change'; name: string }
  | { kind: 'back' }
  | { kind: 'clear' };

export class StateMachine {
  private stack: State[] = [];
  private tempState: TempOp[] = [];
  private allStates: Map<string, State> = new Map();

  /** Register a state so it can be referenced by name. */
  register(state: State): void {
    this.allStates.set(state.name, state);
  }

  /** Queue a state transition: push `name` onto the stack (deferred). */
  change(name: string): void {
    this.tempState.push({ kind: 'change', name });
  }

  /** Queue a pop: return to the previous state (deferred). */
  back(): void {
    this.tempState.push({ kind: 'back' });
  }

  /** Queue a full clear of the stack (deferred). */
  clear(): void {
    this.tempState.push({ kind: 'clear' });
  }

  /** Return the state currently on top of the stack, or undefined. */
  getCurrentState(): State | undefined {
    return this.stack.length > 0 ? this.stack[this.stack.length - 1] : undefined;
  }

  /**
   * Run one frame of the state lifecycle.
   *
   * Lifecycle order for the top-of-stack state:
   *   start  (once, first frame only)
   *   begin  (each time state becomes active)
   *   takeInput
   *   update
   *   draw   (respecting transparency – see below)
   *   end    (if another state was pushed on top)
   *
   * Transparency: walk down the stack from the top to find the lowest
   * contiguous run of transparent states. Draw from that base upward so
   * that all visible layers composite correctly.
   *
   * Repeat: if any lifecycle method returns 'repeat', this function
   * returns [surf, true] so the caller can re-run the frame.
   *
   * Deferred transitions are flushed at the very end.
   */
  update(event: InputEvent, surf: Surface): [Surface, boolean] {
    const current = this.getCurrentState();
    if (!current) {
      if (this.tempState.length === 0) {
        // No state on the stack AND nothing queued — the game loop will
        // spin forever doing nothing. This indicates a bootstrap error
        // (e.g. gameState.state.change('title') was never called).
        console.warn('StateMachine.update: empty stack with no pending transitions — this is a bug; the stack was drained by too many back() calls');
        return [surf, false];
      }
      // Even with an empty stack, process deferred transitions so that
      // an initial change('title') (queued before the first update) is
      // flushed and the state actually gets pushed.
      this.processTempState();
      // If we just pushed a state, signal repeat so it runs this frame.
      return [surf, this.stack.length > 0];
    }

    let repeat = false;

    // --- start (first time only) ---
    if (!current.started) {
      current.started = true;
      current.processed = false;
      if (this.runStep(() => current.start())) {
        repeat = true;
      }
    }

    // --- begin (each activation) ---
    if (!current.processed) {
      current.processed = true;
      if (this.runStep(() => current.begin())) {
        repeat = true;
      }
    }

    // --- takeInput ---
    if (this.runStep(() => current.takeInput(event))) {
      repeat = true;
    }

    // --- update ---
    if (this.runStep(() => current.update())) {
      repeat = true;
    }

    // --- draw (with transparency walk) ---
    surf = this.drawStack(surf);

    // --- process deferred transitions ---
    this.processTempState();

    return [surf, repeat];
  }

  // ------------------------------------------------------------------
  // Internal helpers
  // ------------------------------------------------------------------

  /** Execute a lifecycle step; return true if it signalled 'repeat'. */
  private runStep(fn: () => StateResult): boolean {
    return fn() === 'repeat';
  }

  /**
   * Walk the stack to find the drawing range, then draw bottom-up.
   * Starting from the top, walk down while states are transparent.
   * The first non-transparent state (or the bottom of the stack) is
   * the base. Draw from base upward.
   */
  private drawStack(surf: Surface): Surface {
    if (this.stack.length === 0) return surf;

    let baseIndex = this.stack.length - 1;
    while (baseIndex > 0 && this.stack[baseIndex].transparent) {
      baseIndex--;
    }

    for (let i = baseIndex; i < this.stack.length; i++) {
      surf = this.stack[i].draw(surf);
    }

    return surf;
  }

  /**
   * Flush the deferred transition queue.
   *
   * Note: Unlike Python's process_temp_state, this calls end() on each
   * displaced state during multi-transition processing. In Python, end()
   * is called once in update() on the original top, and process_temp_state
   * only handles stack manipulation. The difference only matters when
   * multiple transitions are queued in a single frame (rare).
   */
  private processTempState(): void {
    while (this.tempState.length > 0) {
      const op = this.tempState.shift()!;

      switch (op.kind) {
        case 'change': {
          const state = this.allStates.get(op.name);
          if (!state) {
            console.warn(`StateMachine: unknown state "${op.name}"`);
            break;
          }

          // Notify the current top that it is being covered.
          const prev = this.getCurrentState();
          if (prev) {
            prev.end();
            prev.processed = false;
          }

          this.stack.push(state);
          // start and begin will fire on the next update() call
          // because started/processed are still false on a fresh state.
          state.started = false;
          state.processed = false;
          break;
        }

        case 'back': {
          const popped = this.stack.pop();
          if (popped) {
            popped.finish();
            popped.started = false;
            popped.processed = false;
          }
          // The newly-exposed top needs begin() on next update.
          const newTop = this.getCurrentState();
          if (newTop) {
            newTop.processed = false;
          }
          break;
        }

        case 'clear': {
          while (this.stack.length > 0) {
            const s = this.stack.pop()!;
            s.finish();
            s.started = false;
            s.processed = false;
          }
          break;
        }
      }
    }
  }
}
