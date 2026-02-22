/**
 * main.ts — Bootstrap and main loop for the Lex Talionis web engine.
 *
 * The canvas fills the entire screen. The viewport (in game pixels) is
 * dynamic based on screen aspect ratio and zoom level. Touch controls
 * are tap-to-select, drag-to-pan, pinch-to-zoom.
 */

import { FRAMETIME, updateAnimationCounters } from './engine/constants';
import { viewport } from './engine/viewport';
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
  ShopState,
} from './engine/states/game-states';

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

interface DisplayInfo {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
}

/**
 * Resize the display canvas to match the screen and recalculate viewport.
 */
function applySize(display: DisplayInfo): void {
  const screenW = window.innerWidth;
  const screenH = window.innerHeight;

  viewport.recalculate(screenW, screenH);

  // Physical canvas = viewport game pixels * renderScale
  display.canvas.width = Math.round(viewport.width * viewport.renderScale);
  display.canvas.height = Math.round(viewport.height * viewport.renderScale);
  display.canvas.style.width = `${screenW}px`;
  display.canvas.style.height = `${screenH}px`;
  display.ctx.imageSmoothingEnabled = false;
}

// ---------------------------------------------------------------------------
// Loading / error screens
// ---------------------------------------------------------------------------

function drawLoadingScreen(ctx: CanvasRenderingContext2D, message: string): void {
  const s = viewport.renderScale;
  const w = viewport.width;
  const h = viewport.height;
  ctx.fillStyle = '#101020';
  ctx.fillRect(0, 0, Math.round(w * s), Math.round(h * s));

  ctx.font = `${Math.round(12 * s)}px monospace`;
  ctx.fillStyle = '#aaaacc';
  ctx.textBaseline = 'top';

  const textWidth = ctx.measureText(message).width;
  ctx.fillText(
    message,
    Math.floor((w * s - textWidth) / 2),
    Math.floor(h * s / 2) - Math.round(4 * s),
  );
}

function drawErrorScreen(ctx: CanvasRenderingContext2D, error: string): void {
  const s = viewport.renderScale;
  const w = viewport.width;
  const h = viewport.height;
  ctx.fillStyle = '#200808';
  ctx.fillRect(0, 0, Math.round(w * s), Math.round(h * s));

  ctx.font = `${Math.round(12 * s)}px monospace`;
  ctx.textBaseline = 'top';

  ctx.fillStyle = '#ff6666';
  ctx.fillText('Error', Math.round(8 * s), Math.round(8 * s));

  ctx.fillStyle = '#ccaaaa';
  const charW = ctx.measureText('M').width;
  const maxChars = Math.floor((w * s - 16 * s) / charW);
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
  const canvas = document.getElementById('game-canvas') as HTMLCanvasElement | null;
  if (!canvas) {
    throw new Error('Could not find #game-canvas element');
  }

  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Could not get 2D rendering context');
  }

  const display: DisplayInfo = { canvas, ctx };

  // Initial viewport calculation
  applySize(display);
  drawLoadingScreen(ctx, 'Loading...');

  // --- Determine project URL ---
  const params = new URLSearchParams(window.location.search);
  const projectPath = params.get('project') ?? 'default.ltproj';
  const baseUrl = `/game-data/${projectPath}`;

  // --- Load game data ---
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

  // --- Audio ---
  const audioManager = new AudioManager(baseUrl);
  setupAudioInit(audioManager);

  // --- GameState ---
  drawLoadingScreen(ctx, 'Initializing...');
  const gameState = initGameState(db, resources, audioManager);
  setGameRef(gameState);

  // --- Register states ---
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
    new ShopState(),
  ];
  for (const state of states) {
    gameState.state.register(state);
  }

  // --- Push initial state (level is loaded via LevelSelectState) ---
  gameState.state.change('title');

  // --- Input ---
  const inputManager = new InputManager(canvas);
  inputManager.setDisplayScale(viewport.cssScale);
  gameState.input = inputManager;

  // --- Game surface (dynamic size) ---
  let gameSurface = new Surface(viewport.width, viewport.height, viewport.renderScale);
  let lastViewW = viewport.width;
  let lastViewH = viewport.height;

  /** Recreate surface if viewport changed. */
  function refreshSurface(): void {
    if (viewport.width !== lastViewW || viewport.height !== lastViewH) {
      gameSurface = new Surface(viewport.width, viewport.height, viewport.renderScale);
      lastViewW = viewport.width;
      lastViewH = viewport.height;
    }
  }

  // Handle window resize
  window.addEventListener('resize', () => {
    applySize(display);
    inputManager.setDisplayScale(viewport.cssScale);
    refreshSurface();
  });

  // --- Game loop ---
  let lastTimestamp = 0;

  function gameLoop(timestamp: number): void {
    const rawDelta = lastTimestamp === 0 ? FRAMETIME : timestamp - lastTimestamp;
    const deltaMs = Math.min(rawDelta, FRAMETIME * 3);
    lastTimestamp = timestamp;

    // --- Process input ---
    const event = inputManager.processInput(deltaMs);

    // --- Apply pinch-to-zoom ---
    if (inputManager.zoomDelta !== 0) {
      viewport.zoom(inputManager.zoomDelta);
      applySize(display);
      inputManager.setDisplayScale(viewport.cssScale);
      refreshSurface();
    }

    // --- Apply touch-drag camera panning ---
    if (inputManager.cameraPanDeltaX !== 0 || inputManager.cameraPanDeltaY !== 0) {
      const panScale = viewport.cssScale || 1;
      game.camera.pan(
        inputManager.cameraPanDeltaX / panScale,
        inputManager.cameraPanDeltaY / panScale,
      );
    }

    // --- Clear ---
    gameSurface.clear();

    // --- State machine update ---
    let repeat = true;
    let iterations = 0;
    const maxIterations = 10;

    while (repeat && iterations < maxIterations) {
      const inputForThisIteration = iterations === 0 ? event : null;
      const [, shouldRepeat] = game.state.update(inputForThisIteration, gameSurface);
      repeat = shouldRepeat;
      iterations++;
    }

    // --- Animations ---
    updateAnimationCounters();

    // --- Movement ---
    game.movementSystem.update(deltaMs);

    // --- Blit to display ---
    display.ctx.imageSmoothingEnabled = false;
    display.ctx.clearRect(0, 0, display.canvas.width, display.canvas.height);
    display.ctx.drawImage(gameSurface.canvas, 0, 0);

    // --- HUD overlay (fixed screen-space, not affected by zoom) ---
    game.hud.drawScreen(display.ctx, window.innerWidth, window.innerHeight, game.db);

    // --- End of frame ---
    inputManager.endFrame();
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
      canvas.width = 240;
      canvas.height = 160;
      ctx.fillStyle = '#200808';
      ctx.fillRect(0, 0, 240, 160);
      ctx.font = '12px monospace';
      ctx.fillStyle = '#ff6666';
      ctx.fillText('Fatal error — see console', 8, 80);
    }
  }
});
