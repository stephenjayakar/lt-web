/**
 * InputManager - Unified input handling for keyboard, mouse, touch buttons,
 * and gamepad.  Maps raw browser events to 9 abstract game buttons matching
 * LT's input system.
 *
 * Mobile touch handling:
 *  - Virtual overlay buttons (#touch-controls [data-btn] elements) are wired
 *    to the same buttonJustPressed / buttonsDown / buttonJustReleased sets as
 *    keyboard keys, so they work identically from the game-state perspective.
 *  - Canvas touch:  tap = move cursor to tile AND select (mouseClick),
 *    drag = pan camera (exposes cameraPanDeltaX/Y each frame).
 */

export type GameButton =
  | 'UP' | 'DOWN' | 'LEFT' | 'RIGHT'
  | 'SELECT' | 'BACK' | 'INFO' | 'AUX' | 'START';

export type InputEvent = GameButton | null;

interface FluidScrollState {
  held: boolean;
  holdTime: number;
  initialDelay: number;
  repeatDelay: number;
  triggered: boolean;
}

const DEFAULT_KEY_MAP: Record<string, GameButton> = {
  'ArrowUp': 'UP',
  'ArrowDown': 'DOWN',
  'ArrowLeft': 'LEFT',
  'ArrowRight': 'RIGHT',
  'KeyW': 'UP',
  'KeyS': 'DOWN',
  'KeyA': 'LEFT',
  'KeyD': 'RIGHT',
  'KeyZ': 'SELECT',
  'Enter': 'SELECT',
  'KeyX': 'BACK',
  'Escape': 'BACK',
  'KeyC': 'INFO',
  'ShiftLeft': 'INFO',
  'ShiftRight': 'INFO',
  'KeyV': 'AUX',
  'Tab': 'AUX',
  'Space': 'START',
};

/** Minimum CSS-px distance before a canvas touch is treated as a drag. */
const TOUCH_TAP_THRESHOLD = 12;

export class InputManager {
  private keysDown: Set<string> = new Set();
  private buttonsDown: Set<GameButton> = new Set();
  private buttonJustPressed: Set<GameButton> = new Set();
  private buttonJustReleased: Set<GameButton> = new Set();
  private keyMap: Record<string, GameButton>;

  // Mouse state
  mouseX: number = 0;
  mouseY: number = 0;
  mouseClick: GameButton | null = null;
  /** True if the mouse moved this frame (set in mousemove, cleared in endFrame). */
  mouseMoved: boolean = false;
  private mouseButtons: Set<number> = new Set();

  /** Display scale info — set by main.ts each frame or on resize. */
  private displayScaleX: number = 1;
  private displayScaleY: number = 1;
  private displayOffsetX: number = 0;
  private displayOffsetY: number = 0;

  // Canvas-touch state (drag-to-pan / tap-to-select)
  private touchStartX: number = 0;
  private touchStartY: number = 0;
  private touchLastX: number = 0;
  private touchLastY: number = 0;
  touchActive: boolean = false;
  private touchIsDrag: boolean = false;

  /**
   * Camera pan delta accumulated from touch-dragging the canvas this frame.
   * Measured in *CSS pixels* — the consumer (Camera) should divide by the
   * current CSS-per-game-pixel scale to convert to game pixels.
   * Reset to 0 each frame in endFrame().
   */
  cameraPanDeltaX: number = 0;
  cameraPanDeltaY: number = 0;

  /** True if the device appears to support touch input. */
  isTouchDevice: boolean = false;

  // Fluid scroll for held directions
  private scrollStates: Map<GameButton, FluidScrollState> = new Map();
  private readonly INITIAL_DELAY = 350; // ms before repeat starts
  private readonly REPEAT_DELAY = 60; // ms between repeats

  // Gamepad support
  private gamepadIndex: number = -1;

  constructor(canvas: HTMLCanvasElement, keyMap?: Record<string, GameButton>) {
    this.keyMap = keyMap ?? DEFAULT_KEY_MAP;
    this.isTouchDevice = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);
    this._setupListeners(canvas);

    for (const dir of ['UP', 'DOWN', 'LEFT', 'RIGHT'] as GameButton[]) {
      this.scrollStates.set(dir, {
        held: false,
        holdTime: 0,
        initialDelay: this.INITIAL_DELAY,
        repeatDelay: this.REPEAT_DELAY,
        triggered: false,
      });
    }

    // Wire virtual touch overlay buttons (if present in the DOM)
    this._setupTouchButtons();
  }

  // -----------------------------------------------------------------------
  // Virtual touch-overlay buttons
  // -----------------------------------------------------------------------

  /**
   * Attach touchstart/touchend/touchcancel listeners on every element with
   * a `data-btn` attribute inside `#touch-controls`.  The attribute value
   * must be a valid GameButton name (e.g. "UP", "SELECT").
   */
  private _setupTouchButtons(): void {
    const container = document.getElementById('touch-controls');
    if (!container) return;

    const buttons = container.querySelectorAll<HTMLElement>('[data-btn]');
    buttons.forEach((el) => {
      const btnName = el.dataset['btn'] as GameButton | undefined;
      if (!btnName) return;

      el.addEventListener('touchstart', (e) => {
        e.preventDefault();
        e.stopPropagation(); // don't let this bubble to canvas touch handler
        this.buttonsDown.add(btnName);
        this.buttonJustPressed.add(btnName);
        el.classList.add('pressed');
      }, { passive: false });

      const release = (e: Event) => {
        e.preventDefault();
        e.stopPropagation();
        if (this.buttonsDown.has(btnName)) {
          this.buttonsDown.delete(btnName);
          this.buttonJustReleased.add(btnName);
        }
        el.classList.remove('pressed');
      };

      el.addEventListener('touchend', release, { passive: false });
      el.addEventListener('touchcancel', release, { passive: false });
    });
  }

  // -----------------------------------------------------------------------
  // Core event listeners
  // -----------------------------------------------------------------------

  private _setupListeners(canvas: HTMLCanvasElement): void {
    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      e.preventDefault();
      this.keysDown.add(e.code);
      const btn = this.keyMap[e.code];
      if (btn) {
        this.buttonsDown.add(btn);
        this.buttonJustPressed.add(btn);
      }
    });

    window.addEventListener('keyup', (e) => {
      this.keysDown.delete(e.code);
      const btn = this.keyMap[e.code];
      if (btn) {
        this.buttonsDown.delete(btn);
        this.buttonJustReleased.add(btn);
      }
    });

    canvas.addEventListener('mousedown', (e) => {
      this.mouseButtons.add(e.button);
      const btn = this._mouseButtonToGame(e.button);
      if (btn) {
        // Only set mouseClick — don't inject into buttonJustPressed.
        // Game states handle mouse clicks separately via mouseClick,
        // so injecting into the keyboard button system would cause
        // double-processing (once as keyboard SELECT, once as mouse click).
        this.mouseClick = btn;
      }
      // Update mouse position on click
      const rect = canvas.getBoundingClientRect();
      this.mouseX = e.clientX - rect.left;
      this.mouseY = e.clientY - rect.top;
    });

    canvas.addEventListener('mouseup', (e) => {
      this.mouseButtons.delete(e.button);
    });

    canvas.addEventListener('mousemove', (e) => {
      const rect = canvas.getBoundingClientRect();
      this.mouseX = e.clientX - rect.left;
      this.mouseY = e.clientY - rect.top;
      this.mouseMoved = true;
    });

    canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    // ----- Canvas touch: tap-to-select + drag-to-pan -----
    canvas.addEventListener('touchstart', (e) => {
      e.preventDefault();
      const touch = e.touches[0];
      const rect = canvas.getBoundingClientRect();
      const cx = touch.clientX - rect.left;
      const cy = touch.clientY - rect.top;
      this.touchStartX = cx;
      this.touchStartY = cy;
      this.touchLastX = cx;
      this.touchLastY = cy;
      this.mouseX = cx;
      this.mouseY = cy;
      this.touchActive = true;
      this.touchIsDrag = false;
    }, { passive: false });

    canvas.addEventListener('touchmove', (e) => {
      e.preventDefault();
      if (!this.touchActive) return;
      const touch = e.touches[0];
      const rect = canvas.getBoundingClientRect();
      const cx = touch.clientX - rect.left;
      const cy = touch.clientY - rect.top;

      const totalDx = cx - this.touchStartX;
      const totalDy = cy - this.touchStartY;
      const totalDist = Math.sqrt(totalDx * totalDx + totalDy * totalDy);

      if (!this.touchIsDrag && totalDist >= TOUCH_TAP_THRESHOLD) {
        this.touchIsDrag = true;
      }

      if (this.touchIsDrag) {
        // Accumulate frame delta for camera panning.
        // Negate because dragging right should move the camera left (scene
        // slides right), which means the camera x *decreases*.
        this.cameraPanDeltaX += -(cx - this.touchLastX);
        this.cameraPanDeltaY += -(cy - this.touchLastY);
      }

      this.touchLastX = cx;
      this.touchLastY = cy;
      this.mouseX = cx;
      this.mouseY = cy;
    }, { passive: false });

    const onTouchEnd = (e: TouchEvent) => {
      e.preventDefault();
      if (!this.touchActive) return;

      if (!this.touchIsDrag) {
        // Short tap on canvas → move cursor to tapped tile AND select.
        // Set mouseX/Y so getMouseTile() returns the tapped tile,
        // then fire mouseClick so game states treat it like a click.
        this.mouseClick = 'SELECT';
      }
      // If it was a drag, cameraPanDelta has already been accumulated.

      this.touchActive = false;
      this.touchIsDrag = false;
    };

    canvas.addEventListener('touchend', onTouchEnd, { passive: false });
    canvas.addEventListener('touchcancel', onTouchEnd, { passive: false });

    // Gamepad
    window.addEventListener('gamepadconnected', (e) => {
      this.gamepadIndex = e.gamepad.index;
    });
    window.addEventListener('gamepaddisconnected', () => {
      this.gamepadIndex = -1;
    });
  }

  private _mouseButtonToGame(button: number): GameButton | null {
    switch (button) {
      case 0: return 'SELECT'; // LMB
      case 2: return 'BACK';   // RMB
      case 1: return 'INFO';   // MMB
      default: return null;
    }
  }

  /** Called once per frame to poll gamepad and process fluid scrolling */
  processInput(deltaMs: number): InputEvent {
    // Poll gamepad
    this._pollGamepad();

    // Update fluid scroll for held directions
    let directionEvent: InputEvent = null;
    for (const dir of ['UP', 'DOWN', 'LEFT', 'RIGHT'] as GameButton[]) {
      const state = this.scrollStates.get(dir)!;
      if (this.buttonsDown.has(dir)) {
        if (!state.held) {
          state.held = true;
          state.holdTime = 0;
          state.triggered = false;
        }
        state.holdTime += deltaMs;
        if (!state.triggered) {
          // First press already in buttonJustPressed
          state.triggered = true;
        } else if (state.holdTime > state.initialDelay) {
          // Repeat
          const repeatTime = state.holdTime - state.initialDelay;
          if (repeatTime % state.repeatDelay < deltaMs) {
            directionEvent = dir;
          }
        }
      } else {
        state.held = false;
        state.holdTime = 0;
        state.triggered = false;
      }
    }

    // Priority: just-pressed buttons > held direction repeats
    // Return the highest-priority just-pressed button
    const priorityOrder: GameButton[] = ['SELECT', 'BACK', 'INFO', 'AUX', 'START', 'UP', 'DOWN', 'LEFT', 'RIGHT'];
    for (const btn of priorityOrder) {
      if (this.buttonJustPressed.has(btn)) {
        return btn;
      }
    }

    // Then held direction repeats
    if (directionEvent) return directionEvent;

    return null;
  }

  /** Check if a button is currently held down */
  isPressed(button: GameButton): boolean {
    return this.buttonsDown.has(button);
  }

  /** Check if a button was just pressed this frame */
  justPressed(button: GameButton): boolean {
    return this.buttonJustPressed.has(button);
  }

  /** Check if a button was just released this frame */
  justReleased(button: GameButton): boolean {
    return this.buttonJustReleased.has(button);
  }

  /** Clear per-frame state. Call at end of frame. */
  endFrame(): void {
    this.buttonJustPressed.clear();
    this.buttonJustReleased.clear();
    this.mouseClick = null;
    this.mouseMoved = false;
    this.cameraPanDeltaX = 0;
    this.cameraPanDeltaY = 0;
  }

  /**
   * Update the display scale info so mouse-to-game coordinate conversion
   * works. Called from main.ts on resize and at startup.
   * @param cssScale  CSS pixels per game pixel (uniform X and Y).
   */
  setDisplayScale(cssScale: number): void {
    this.displayScaleX = cssScale;
    this.displayScaleY = cssScale;
    // Offset is not needed because mouseX/Y are already relative to canvas
    this.displayOffsetX = 0;
    this.displayOffsetY = 0;
  }

  /** Get mouse position in game-pixel coordinates (0..WINWIDTH, 0..WINHEIGHT). */
  getGameMousePos(scaleX?: number, scaleY?: number, offsetX?: number, offsetY?: number): [number, number] {
    const sx = scaleX ?? this.displayScaleX;
    const sy = scaleY ?? this.displayScaleY;
    const ox = offsetX ?? this.displayOffsetX;
    const oy = offsetY ?? this.displayOffsetY;
    return [
      Math.floor((this.mouseX - ox) / sx),
      Math.floor((this.mouseY - oy) / sy),
    ];
  }

  /**
   * Get the tile coordinates under the mouse cursor.
   * @param cameraOffsetX  Camera pixel offset (from Camera.getOffset()[0]).
   * @param cameraOffsetY  Camera pixel offset (from Camera.getOffset()[1]).
   * @returns [tileX, tileY] or null if the mouse is outside the game area.
   */
  getMouseTile(cameraOffsetX: number, cameraOffsetY: number): [number, number] | null {
    const [gx, gy] = this.getGameMousePos();
    // Check if the mouse is within the game viewport
    if (gx < 0 || gy < 0 || gx >= 240 || gy >= 160) return null;
    // Convert game-pixel position + camera offset to tile coordinates
    const tileX = Math.floor((gx + cameraOffsetX) / 16);
    const tileY = Math.floor((gy + cameraOffsetY) / 16);
    return [tileX, tileY];
  }

  private _pollGamepad(): void {
    if (this.gamepadIndex < 0) return;
    const gamepads = navigator.getGamepads();
    const gp = gamepads[this.gamepadIndex];
    if (!gp) return;

    // D-pad or left stick
    const threshold = 0.5;
    const lx = gp.axes[0] ?? 0;
    const ly = gp.axes[1] ?? 0;

    if (lx < -threshold) this.buttonsDown.add('LEFT');
    else this.buttonsDown.delete('LEFT');
    if (lx > threshold) this.buttonsDown.add('RIGHT');
    else this.buttonsDown.delete('RIGHT');
    if (ly < -threshold) this.buttonsDown.add('UP');
    else this.buttonsDown.delete('UP');
    if (ly > threshold) this.buttonsDown.add('DOWN');
    else this.buttonsDown.delete('DOWN');

    // Buttons: A=SELECT, B=BACK, X=INFO, Y=AUX, Start=START
    const buttonMap: [number, GameButton][] = [
      [0, 'SELECT'], [1, 'BACK'], [2, 'INFO'], [3, 'AUX'],
      [9, 'START'], [4, 'AUX'], // LB also AUX
    ];
    for (const [idx, btn] of buttonMap) {
      if (gp.buttons[idx]?.pressed) {
        if (!this.buttonsDown.has(btn)) {
          this.buttonsDown.add(btn);
          this.buttonJustPressed.add(btn);
        }
      } else {
        if (this.buttonsDown.has(btn)) {
          this.buttonsDown.delete(btn);
          this.buttonJustReleased.add(btn);
        }
      }
    }
  }
}
