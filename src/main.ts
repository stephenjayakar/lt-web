/**
 * main.ts — Bootstrap and main loop for the Lex Talionis web engine.
 *
 * Initialises the canvas, loads game data, registers states, and runs
 * the 60fps game loop.  The game renders to a 240x160 OffscreenCanvas
 * (Surface) and is then scaled up to the visible <canvas> element.
 */

import { WINWIDTH, WINHEIGHT, FRAMETIME, updateAnimationCounters } from './engine/constants';
import { Surface } from './engine/surface';
import { InputManager } from './engine/input';
import { ResourceManager } from './data/resource-manager';
import { Database } from './data/database';
import { AudioManager } from './audio/audio-manager';
import { initGameState, game } from './engine/game-state';
import {
  setGameRef,
  TitleState,
  LevelSelectState,
  OptionMenuState,
  FreeState,
  MoveState,
  MenuState,
  ItemUseState,
  TradeState,
  RescueState,
  DropState,
  TargetingState,
  CombatState,
  AIState,
  TurnChangeState,
  PhaseChangeState,
  MovementState,
  EventState,
} from './engine/states/game-states';

// ---------------------------------------------------------------------------
// Display scaling
// ---------------------------------------------------------------------------

interface DisplayInfo {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  /** CSS pixels scale (how many CSS px per game pixel). */
  scale: number;
  /** The Surface render scale (game pixels -> physical canvas pixels). */
  renderScale: number;
  offsetX: number;
  offsetY: number;
}

/**
 * Compute the render scale that maps WINWIDTH x WINHEIGHT to the window,
 * accounting for devicePixelRatio for crisp physical pixels.
 */
function computeRenderScale(): { renderScale: number; cssScale: number; offsetX: number; offsetY: number } {
  const dpr = window.devicePixelRatio || 1;
  const viewW = window.innerWidth;
  const viewH = window.innerHeight;

  // CSS scale: how many CSS pixels per game pixel (maintain aspect ratio)
  const cssScale = Math.min(viewW / WINWIDTH, viewH / WINHEIGHT);

  // Render scale: CSS scale * DPR gives us 1:1 physical pixel mapping
  const renderScale = cssScale * dpr;

  const scaledW = WINWIDTH * cssScale;
  const scaledH = WINHEIGHT * cssScale;
  const offsetX = Math.floor((viewW - scaledW) / 2);
  const offsetY = Math.floor((viewH - scaledH) / 2);

  return { renderScale, cssScale, offsetX, offsetY };
}

function applyScale(display: DisplayInfo): void {
  const { renderScale, cssScale, offsetX, offsetY } = computeRenderScale();
  display.scale = cssScale;
  display.renderScale = renderScale;
  display.offsetX = offsetX;
  display.offsetY = offsetY;

  // The display canvas matches the physical pixel dimensions of the game area
  display.canvas.width = Math.round(WINWIDTH * renderScale);
  display.canvas.height = Math.round(WINHEIGHT * renderScale);
  display.canvas.style.width = `${Math.round(WINWIDTH * cssScale)}px`;
  display.canvas.style.height = `${Math.round(WINHEIGHT * cssScale)}px`;
  display.canvas.style.marginLeft = `${offsetX}px`;
  display.canvas.style.marginTop = `${offsetY}px`;

  display.ctx.imageSmoothingEnabled = false;
}

// ---------------------------------------------------------------------------
// Loading screen helper
// ---------------------------------------------------------------------------

function drawLoadingScreen(ctx: CanvasRenderingContext2D, message: string, renderScale: number = 1): void {
  const s = renderScale;
  ctx.fillStyle = '#101020';
  ctx.fillRect(0, 0, Math.round(WINWIDTH * s), Math.round(WINHEIGHT * s));

  ctx.font = `${Math.round(12 * s)}px monospace`;
  ctx.fillStyle = '#aaaacc';
  ctx.textBaseline = 'top';

  const textWidth = ctx.measureText(message).width;
  ctx.fillText(
    message,
    Math.floor((WINWIDTH * s - textWidth) / 2),
    Math.floor(WINHEIGHT * s / 2) - Math.round(4 * s),
  );
}

function drawErrorScreen(ctx: CanvasRenderingContext2D, error: string, renderScale: number = 1): void {
  const s = renderScale;
  ctx.fillStyle = '#200808';
  ctx.fillRect(0, 0, Math.round(WINWIDTH * s), Math.round(WINHEIGHT * s));

  ctx.font = `${Math.round(12 * s)}px monospace`;
  ctx.textBaseline = 'top';

  ctx.fillStyle = '#ff6666';
  ctx.fillText('Error', Math.round(8 * s), Math.round(8 * s));

  ctx.fillStyle = '#ccaaaa';
  const charW = ctx.measureText('M').width;
  const maxChars = Math.floor((WINWIDTH * s - 16 * s) / charW);
  const lines: string[] = [];
  let remaining = error;
  while (remaining.length > 0) {
    lines.push(remaining.substring(0, maxChars));
    remaining = remaining.substring(maxChars);
  }
  for (let i = 0; i < lines.length && i < 14; i++) {
    ctx.fillText(lines[i], Math.round(8 * s), Math.round((24 + i * 14) * s));
  }
}

// ---------------------------------------------------------------------------
// Audio initialisation on first user interaction
// ---------------------------------------------------------------------------

function setupAudioInit(audioManager: AudioManager): void {
  const initAudio = () => {
    audioManager.init();
    window.removeEventListener('click', initAudio);
    window.removeEventListener('keydown', initAudio);
    window.removeEventListener('touchstart', initAudio);
  };
  window.addEventListener('click', initAudio, { once: true });
  window.addEventListener('keydown', initAudio, { once: true });
  window.addEventListener('touchstart', initAudio, { once: true });
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // --- 1. Get canvas and set up display ---
  const canvas = document.getElementById('game-canvas') as HTMLCanvasElement | null;
  if (!canvas) {
    throw new Error('Could not find #game-canvas element');
  }

  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Could not get 2D rendering context');
  }

  const display: DisplayInfo = {
    canvas,
    ctx,
    scale: 1,
    renderScale: 1,
    offsetX: 0,
    offsetY: 0,
  };

  applyScale(display);

  // --- 2. Show loading screen ---
  drawLoadingScreen(ctx, 'Loading...', display.renderScale);

  // --- 3. Determine project URL from query params ---
  const params = new URLSearchParams(window.location.search);
  const projectPath = params.get('project') ?? 'default.ltproj';
  const baseUrl = `/game-data/${projectPath}`;

  // --- 4. Load game data ---
  const resources = new ResourceManager(baseUrl);
  const db = new Database();

  try {
    drawLoadingScreen(ctx, 'Loading database...', display.renderScale);
    await db.load(resources);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('Failed to load database:', msg);
    drawErrorScreen(ctx, `DB load failed: ${msg}`, display.renderScale);
    return;
  }

  // --- 5. Create AudioManager ---
  const audioManager = new AudioManager(baseUrl);
  setupAudioInit(audioManager);

  // --- 6. Create GameState ---
  drawLoadingScreen(ctx, 'Initializing...', display.renderScale);
  const gameState = initGameState(db, resources, audioManager);

  // Wire up the lazy game reference used by all state classes
  setGameRef(gameState);

  // --- 7. Register all game states ---
  const states = [
    new TitleState(),
    new LevelSelectState(),
    new OptionMenuState(),
    new FreeState(),
    new MoveState(),
    new MenuState(),
    new ItemUseState(),
    new TradeState(),
    new RescueState(),
    new DropState(),
    new TargetingState(),
    new CombatState(),
    new AIState(),
    new TurnChangeState(),
    new PhaseChangeState(),
    new MovementState(),
    new EventState(),
  ];

  for (const state of states) {
    gameState.state.register(state);
  }

  // --- 8. Push initial state (level is loaded via LevelSelectState) ---
  gameState.state.change('title');

  // --- 10. Create InputManager (needs the visible canvas for listeners) ---
  const inputManager = new InputManager(canvas);
  inputManager.setDisplayScale(display.scale);
  gameState.input = inputManager;

  // --- 11. Create the game rendering surface ---
  // The surface is logically 240x160 but physically scaled to match the
  // window so sprites get nearest-neighbor scaling and text is crisp.
  let gameSurface = new Surface(WINWIDTH, WINHEIGHT, display.renderScale);

  // Recreate game surface on resize (scale changes)
  window.addEventListener('resize', () => {
    applyScale(display);
    gameSurface = new Surface(WINWIDTH, WINHEIGHT, display.renderScale);
    inputManager.setDisplayScale(display.scale);
  });

  // --- 12. Main game loop ---
  let lastTimestamp = 0;

  function gameLoop(timestamp: number): void {
    // Delta time capped to avoid spiral of death on tab-away
    const rawDelta = lastTimestamp === 0 ? FRAMETIME : timestamp - lastTimestamp;
    const deltaMs = Math.min(rawDelta, FRAMETIME * 3);
    lastTimestamp = timestamp;

    // --- Process input ---
    const event = inputManager.processInput(deltaMs);

    // --- Clear game surface ---
    gameSurface.clear();

    // --- State machine update (may repeat) ---
    let repeat = true;
    let iterations = 0;
    const maxIterations = 10; // safety limit to prevent infinite loops

    while (repeat && iterations < maxIterations) {
      // Only pass real input on the first iteration; repeat iterations
      // get null so the same key press isn't consumed multiple times.
      const inputForThisIteration = iterations === 0 ? event : null;
      const [, shouldRepeat] = game.state.update(inputForThisIteration, gameSurface);
      repeat = shouldRepeat;
      iterations++;
    }

    // --- Update animation counters ---
    updateAnimationCounters();

    // --- Update movement system ---
    game.movementSystem.update(deltaMs);

    // --- Blit game surface onto the visible canvas ---
    // The game surface's physical canvas matches the display canvas size,
    // so this is a 1:1 copy with no additional scaling.
    display.ctx.imageSmoothingEnabled = false;
    display.ctx.clearRect(0, 0, display.canvas.width, display.canvas.height);
    display.ctx.drawImage(gameSurface.canvas, 0, 0);

    // --- End-of-frame input cleanup ---
    inputManager.endFrame();

    // --- Resume audio context if it was suspended (tab switch, etc.) ---
    audioManager.resume();

    requestAnimationFrame(gameLoop);
  }

  requestAnimationFrame(gameLoop);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

main().catch((err) => {
  console.error('Fatal error during startup:', err);

  const canvas = document.getElementById('game-canvas') as HTMLCanvasElement | null;
  if (canvas) {
    const ctx = canvas.getContext('2d');
    if (ctx) {
      canvas.width = WINWIDTH;
      canvas.height = WINHEIGHT;
      drawErrorScreen(ctx, err instanceof Error ? err.message : String(err));
    }
  }
});
