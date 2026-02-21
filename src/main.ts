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
  scale: number;
  offsetX: number;
  offsetY: number;
}

/**
 * Calculate the best integer (or fractional) scale to fit WINWIDTH x WINHEIGHT
 * into the available viewport while maintaining aspect ratio.
 * Prefers integer multiples for the crispest pixel art.
 */
function calculateScale(viewW: number, viewH: number): { scale: number; offsetX: number; offsetY: number } {
  const scaleX = viewW / WINWIDTH;
  const scaleY = viewH / WINHEIGHT;
  let scale = Math.min(scaleX, scaleY);

  // Prefer integer multiples for pixel-perfect rendering
  const intScale = Math.floor(scale);
  if (intScale >= 1) {
    scale = intScale;
  }

  const scaledW = WINWIDTH * scale;
  const scaledH = WINHEIGHT * scale;
  const offsetX = Math.floor((viewW - scaledW) / 2);
  const offsetY = Math.floor((viewH - scaledH) / 2);

  return { scale, offsetX, offsetY };
}

function applyScale(display: DisplayInfo): void {
  const { scale, offsetX, offsetY } = calculateScale(window.innerWidth, window.innerHeight);
  display.scale = scale;
  display.offsetX = offsetX;
  display.offsetY = offsetY;

  display.canvas.width = WINWIDTH;
  display.canvas.height = WINHEIGHT;
  display.canvas.style.width = `${WINWIDTH * scale}px`;
  display.canvas.style.height = `${WINHEIGHT * scale}px`;
  display.canvas.style.marginLeft = `${offsetX}px`;
  display.canvas.style.marginTop = `${offsetY}px`;

  display.ctx.imageSmoothingEnabled = false;
}

// ---------------------------------------------------------------------------
// Loading screen helper
// ---------------------------------------------------------------------------

function drawLoadingScreen(ctx: CanvasRenderingContext2D, message: string): void {
  ctx.fillStyle = '#101020';
  ctx.fillRect(0, 0, WINWIDTH, WINHEIGHT);

  ctx.font = '8px monospace';
  ctx.fillStyle = '#aaaacc';
  ctx.textBaseline = 'top';

  const textWidth = ctx.measureText(message).width;
  ctx.fillText(message, Math.floor((WINWIDTH - textWidth) / 2), Math.floor(WINHEIGHT / 2) - 4);
}

function drawErrorScreen(ctx: CanvasRenderingContext2D, error: string): void {
  ctx.fillStyle = '#200808';
  ctx.fillRect(0, 0, WINWIDTH, WINHEIGHT);

  ctx.font = '8px monospace';
  ctx.textBaseline = 'top';

  ctx.fillStyle = '#ff6666';
  ctx.fillText('Error', 8, 8);

  ctx.fillStyle = '#ccaaaa';
  // Word-wrap the error message across multiple lines
  const maxChars = Math.floor((WINWIDTH - 16) / 5);
  const lines: string[] = [];
  let remaining = error;
  while (remaining.length > 0) {
    lines.push(remaining.substring(0, maxChars));
    remaining = remaining.substring(maxChars);
  }
  for (let i = 0; i < lines.length && i < 14; i++) {
    ctx.fillText(lines[i], 8, 24 + i * 10);
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
    offsetX: 0,
    offsetY: 0,
  };

  applyScale(display);

  window.addEventListener('resize', () => {
    applyScale(display);
  });

  // --- 2. Show loading screen ---
  drawLoadingScreen(ctx, 'Loading...');

  // --- 3. Determine project URL from query params ---
  const params = new URLSearchParams(window.location.search);
  const projectPath = params.get('project') ?? 'default.ltproj';
  const baseUrl = `/game-data/${projectPath}`;

  // --- 4. Load game data ---
  const resources = new ResourceManager(baseUrl);
  const db = new Database();

  try {
    drawLoadingScreen(ctx, 'Loading database...');
    await db.load(resources);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('Failed to load database:', msg);
    drawErrorScreen(ctx, `DB load failed: ${msg}`);
    return;
  }

  // --- 5. Create AudioManager ---
  const audioManager = new AudioManager(baseUrl);
  setupAudioInit(audioManager);

  // --- 6. Create GameState ---
  drawLoadingScreen(ctx, 'Initializing...');
  const gameState = initGameState(db, resources, audioManager);

  // Wire up the lazy game reference used by all state classes
  setGameRef(gameState);

  // --- 7. Register all game states ---
  const states = [
    new TitleState(),
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

  // --- 8. Load the first level ---
  const firstLevelNid = db.levels.keys().next().value;
  if (firstLevelNid) {
    try {
      drawLoadingScreen(ctx, 'Loading level...');
      await gameState.loadLevel(firstLevelNid);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('Failed to load level:', msg);
      drawErrorScreen(ctx, `Level load failed: ${msg}`);
      return;
    }
  }

  // --- 9. Push initial state ---
  gameState.state.change('title');

  // --- 10. Create InputManager (needs the visible canvas for listeners) ---
  const inputManager = new InputManager(canvas);

  // --- 11. Create the game rendering surface (240x160 OffscreenCanvas) ---
  const gameSurface = new Surface(WINWIDTH, WINHEIGHT);

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

    // --- Blit game surface (OffscreenCanvas) onto the visible canvas ---
    display.ctx.clearRect(0, 0, WINWIDTH, WINHEIGHT);
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
