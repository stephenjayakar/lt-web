/**
 * InputManager - Unified input handling for keyboard, mouse, and touch.
 * Maps raw browser events to 9 abstract game buttons matching LT's input system.
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
  private mouseButtons: Set<number> = new Set();

  // Touch state
  touchStartX: number = 0;
  touchStartY: number = 0;
  touchActive: boolean = false;

  // Fluid scroll for held directions
  private scrollStates: Map<GameButton, FluidScrollState> = new Map();
  private readonly INITIAL_DELAY = 350; // ms before repeat starts
  private readonly REPEAT_DELAY = 60; // ms between repeats

  // Gamepad support
  private gamepadIndex: number = -1;

  constructor(canvas: HTMLCanvasElement, keyMap?: Record<string, GameButton>) {
    this.keyMap = keyMap ?? DEFAULT_KEY_MAP;
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
        this.buttonsDown.add(btn);
        this.buttonJustPressed.add(btn);
        this.mouseClick = btn;
      }
    });

    canvas.addEventListener('mouseup', (e) => {
      this.mouseButtons.delete(e.button);
      const btn = this._mouseButtonToGame(e.button);
      if (btn) {
        this.buttonsDown.delete(btn);
        this.buttonJustReleased.add(btn);
      }
    });

    canvas.addEventListener('mousemove', (e) => {
      const rect = canvas.getBoundingClientRect();
      this.mouseX = e.clientX - rect.left;
      this.mouseY = e.clientY - rect.top;
    });

    canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    // Touch support for mobile
    canvas.addEventListener('touchstart', (e) => {
      e.preventDefault();
      const touch = e.touches[0];
      const rect = canvas.getBoundingClientRect();
      this.mouseX = touch.clientX - rect.left;
      this.mouseY = touch.clientY - rect.top;
      this.touchStartX = this.mouseX;
      this.touchStartY = this.mouseY;
      this.touchActive = true;
    });

    canvas.addEventListener('touchmove', (e) => {
      e.preventDefault();
      const touch = e.touches[0];
      const rect = canvas.getBoundingClientRect();
      this.mouseX = touch.clientX - rect.left;
      this.mouseY = touch.clientY - rect.top;
    });

    canvas.addEventListener('touchend', (e) => {
      e.preventDefault();
      if (this.touchActive) {
        const dx = this.mouseX - this.touchStartX;
        const dy = this.mouseY - this.touchStartY;
        const dist = Math.sqrt(dx * dx + dy * dy);

        if (dist < 10) {
          // Tap -> SELECT
          this.buttonJustPressed.add('SELECT');
          this.mouseClick = 'SELECT';
        } else {
          // Swipe -> direction
          if (Math.abs(dx) > Math.abs(dy)) {
            this.buttonJustPressed.add(dx > 0 ? 'RIGHT' : 'LEFT');
          } else {
            this.buttonJustPressed.add(dy > 0 ? 'DOWN' : 'UP');
          }
        }
        this.touchActive = false;
      }
    });

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
  }

  /** Get mouse position scaled to game coordinates */
  getGameMousePos(scaleX: number, scaleY: number, offsetX: number, offsetY: number): [number, number] {
    return [
      Math.floor((this.mouseX - offsetX) / scaleX),
      Math.floor((this.mouseY - offsetY) / scaleY),
    ];
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
