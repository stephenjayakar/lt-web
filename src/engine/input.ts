/**
 * InputManager - Unified input handling for keyboard, mouse, touch, and gamepad.
 * Maps raw browser events to 9 abstract game buttons matching LT's input system.
 *
 * Mobile touch controls (no on-screen buttons):
 *  - Tap on canvas = move cursor to tapped tile + select
 *  - Drag on canvas = pan camera
 *  - Two-finger pinch = zoom in/out
 *  - Two-finger tap = BACK
 */

import { viewport } from './viewport';

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
  mouseMoved: boolean = false;
  private mouseButtons: Set<number> = new Set();

  /** Display scale info — set by main.ts each frame or on resize. */
  private displayScaleX: number = 1;
  private displayScaleY: number = 1;
  private displayOffsetX: number = 0;
  private displayOffsetY: number = 0;

  // Canvas-touch state (drag-to-pan / tap-to-select / pinch-to-zoom)
  private touchStartX: number = 0;
  private touchStartY: number = 0;
  private touchLastX: number = 0;
  private touchLastY: number = 0;
  touchActive: boolean = false;
  private touchIsDrag: boolean = false;
  private touchStartTime: number = 0;

  // Middle-click drag state (desktop pan)
  private middleDragActive: boolean = false;
  private middleDragLastX: number = 0;
  private middleDragLastY: number = 0;

  // Pinch-to-zoom state
  private pinchActive: boolean = false;
  private pinchStartDist: number = 0;
  private pinchLastDist: number = 0;

  /**
   * Camera pan delta accumulated from touch-dragging the canvas this frame.
   * Measured in CSS pixels. Consumer divides by cssScale to get game pixels.
   */
  cameraPanDeltaX: number = 0;
  cameraPanDeltaY: number = 0;

  /**
   * Zoom delta from pinch gesture this frame.
   * Positive = zoom in (fingers spread apart), negative = zoom out.
   * In "tiles" units — represents how much to change tilesAcross.
   */
  zoomDelta: number = 0;

  /** True if the device appears to support touch input. */
  isTouchDevice: boolean = false;

  // Fluid scroll for held directions
  private scrollStates: Map<GameButton, FluidScrollState> = new Map();
  private readonly INITIAL_DELAY = 350;
  private readonly REPEAT_DELAY = 60;

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

      // Middle-click (button 1) starts a drag-to-pan
      if (e.button === 1) {
        e.preventDefault();
        this.middleDragActive = true;
        this.middleDragLastX = e.clientX;
        this.middleDragLastY = e.clientY;
        return;
      }

      const btn = this._mouseButtonToGame(e.button);
      if (btn) {
        this.mouseClick = btn;
      }
      const rect = canvas.getBoundingClientRect();
      this.mouseX = e.clientX - rect.left;
      this.mouseY = e.clientY - rect.top;
    });

    canvas.addEventListener('mouseup', (e) => {
      this.mouseButtons.delete(e.button);
      if (e.button === 1) {
        this.middleDragActive = false;
      }
    });

    canvas.addEventListener('mousemove', (e) => {
      const rect = canvas.getBoundingClientRect();

      // Middle-click drag -> pan camera
      if (this.middleDragActive) {
        this.cameraPanDeltaX += -(e.clientX - this.middleDragLastX);
        this.cameraPanDeltaY += -(e.clientY - this.middleDragLastY);
        this.middleDragLastX = e.clientX;
        this.middleDragLastY = e.clientY;
        return;
      }

      this.mouseX = e.clientX - rect.left;
      this.mouseY = e.clientY - rect.top;
      this.mouseMoved = true;
    });

    canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    // Scroll wheel -> zoom
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      // deltaY > 0 = scroll down = zoom out (more tiles visible)
      // Normalize: ~120 per "notch" on most mice
      const delta = -e.deltaY / 120;
      this.zoomDelta += delta;
    }, { passive: false });

    // ----- Touch: tap-to-select, drag-to-pan, pinch-to-zoom, 2-finger-tap = BACK -----
    canvas.addEventListener('touchstart', (e) => {
      e.preventDefault();

      if (e.touches.length === 2) {
        // Start pinch
        this.pinchActive = true;
        this.touchIsDrag = false;
        this.touchActive = false;
        const d = this._touchDist(e.touches[0], e.touches[1]);
        this.pinchStartDist = d;
        this.pinchLastDist = d;
        return;
      }

      if (e.touches.length === 1) {
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
        this.touchStartTime = performance.now();
      }
    }, { passive: false });

    canvas.addEventListener('touchmove', (e) => {
      e.preventDefault();

      if (this.pinchActive && e.touches.length >= 2) {
        const d = this._touchDist(e.touches[0], e.touches[1]);
        // Convert pinch distance change to zoom delta.
        // Spreading fingers apart (d increasing) = zoom in = positive delta.
        // We scale by a sensitivity factor: 100 CSS-px of pinch = ~1 tile change.
        const pinchDelta = (d - this.pinchLastDist) / 100;
        this.zoomDelta += pinchDelta;
        this.pinchLastDist = d;

        // Also pan based on the midpoint movement
        const mid = this._touchMidpoint(e.touches[0], e.touches[1]);
        // (We'd need previous midpoint — skip pan during pinch for simplicity)
        return;
      }

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
        // Negate: dragging right moves camera left (scene slides right)
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

      // Two-finger tap = BACK (if pinch was active but barely moved)
      if (this.pinchActive && e.touches.length < 2) {
        const pinchDist = Math.abs(this.pinchLastDist - this.pinchStartDist);
        if (pinchDist < 20) {
          // Barely moved fingers = two-finger tap
          this.buttonJustPressed.add('BACK');
        }
        this.pinchActive = false;
        return;
      }

      if (!this.touchActive) return;

      if (!this.touchIsDrag) {
        // Tap on canvas -> select at tapped position
        this.mouseClick = 'SELECT';
      }

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

  private _touchDist(a: Touch, b: Touch): number {
    const dx = a.clientX - b.clientX;
    const dy = a.clientY - b.clientY;
    return Math.sqrt(dx * dx + dy * dy);
  }

  private _touchMidpoint(a: Touch, b: Touch): { x: number; y: number } {
    return { x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 };
  }

  private _mouseButtonToGame(button: number): GameButton | null {
    switch (button) {
      case 0: return 'SELECT';
      case 2: return 'BACK';
      case 1: return 'INFO';
      default: return null;
    }
  }

  /** Called once per frame to poll gamepad and process fluid scrolling */
  processInput(deltaMs: number): InputEvent {
    this._pollGamepad();

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
          state.triggered = true;
        } else if (state.holdTime > state.initialDelay) {
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

    const priorityOrder: GameButton[] = ['SELECT', 'BACK', 'INFO', 'AUX', 'START', 'UP', 'DOWN', 'LEFT', 'RIGHT'];
    for (const btn of priorityOrder) {
      if (this.buttonJustPressed.has(btn)) {
        return btn;
      }
    }

    if (directionEvent) return directionEvent;

    return null;
  }

  isPressed(button: GameButton): boolean {
    return this.buttonsDown.has(button);
  }

  justPressed(button: GameButton): boolean {
    return this.buttonJustPressed.has(button);
  }

  justReleased(button: GameButton): boolean {
    return this.buttonJustReleased.has(button);
  }

  /**
   * Clear transient per-frame input signals (justPressed, justReleased,
   * mouseClick) without touching held-button state or camera deltas.
   * Called between state-machine repeat iterations so that stale input
   * events don't get consumed by multiple states in the same frame.
   */
  clearFrameEvents(): void {
    this.buttonJustPressed.clear();
    this.buttonJustReleased.clear();
    this.mouseClick = null;
  }

  endFrame(): void {
    this.buttonJustPressed.clear();
    this.buttonJustReleased.clear();
    this.mouseClick = null;
    this.mouseMoved = false;
    this.cameraPanDeltaX = 0;
    this.cameraPanDeltaY = 0;
    this.zoomDelta = 0;
  }

  setDisplayScale(cssScale: number): void {
    this.displayScaleX = cssScale;
    this.displayScaleY = cssScale;
    this.displayOffsetX = 0;
    this.displayOffsetY = 0;
  }

  /** Get mouse position in game-pixel coordinates. */
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
   * Get the tile coordinates under the mouse/touch cursor.
   * Uses dynamic viewport dimensions.
   */
  getMouseTile(cameraOffsetX: number, cameraOffsetY: number): [number, number] | null {
    const [gx, gy] = this.getGameMousePos();
    if (gx < 0 || gy < 0 || gx >= viewport.width || gy >= viewport.height) return null;
    const tileX = Math.floor((gx + cameraOffsetX) / 16);
    const tileY = Math.floor((gy + cameraOffsetY) / 16);
    return [tileX, tileY];
  }

  private _pollGamepad(): void {
    if (this.gamepadIndex < 0) return;
    const gamepads = navigator.getGamepads();
    const gp = gamepads[this.gamepadIndex];
    if (!gp) return;

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

    const buttonMap: [number, GameButton][] = [
      [0, 'SELECT'], [1, 'BACK'], [2, 'INFO'], [3, 'AUX'],
      [9, 'START'], [4, 'AUX'],
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
