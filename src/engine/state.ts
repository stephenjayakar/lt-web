/**
 * State - Base class for all game states.
 * Matches LT's stack-based state machine architecture.
 */

import type { Surface } from './surface';
import type { InputEvent } from './input';

export type StateResult = 'repeat' | void;

export abstract class State {
  abstract readonly name: string;
  readonly inLevel: boolean = true;
  readonly showMap: boolean = true;
  readonly transparent: boolean = false;
  
  started: boolean = false;
  processed: boolean = false;

  /** Called once when first pushed onto the stack */
  start(): StateResult { return; }

  /** Called each time this state becomes the top of the stack */
  begin(): StateResult { return; }

  /** Process one input event per frame */
  takeInput(event: InputEvent): StateResult { return; }

  /** Per-frame logic update */
  update(): StateResult { return; }

  /** Render to the surface */
  draw(surf: Surface): Surface { return surf; }

  /** Called when another state is pushed on top */
  end(): StateResult { return; }

  /** Called when this state is popped off the stack */
  finish(): void { }
}

/**
 * MapState - Base class for states that render the game map.
 */
export abstract class MapState extends State {
  override readonly showMap: boolean = true;

  override draw(surf: Surface): Surface {
    // Will be overridden to call game.camera.update() and game.mapView.draw()
    return surf;
  }
}
