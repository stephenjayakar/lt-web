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
import { installWebControls } from './ui/web-controls';
import { installStartupStatus } from './ui/web-startup';
import './web-shell.css';
import { ResourceManager } from './data/resource-manager';
import { Database } from './data/database';
import { AudioManager } from './audio/audio-manager';
import { initGameState, game } from './engine/game-state';
import { isStrictMode, reportUnimplemented } from './engine/strict-mode';
import {
  REKKA_ITEM_COMPONENTS,
  REKKA_SKILL_COMPONENTS,
} from './engine/rekka-component-support';
import {
  assertEotfComponentCounts,
  EOTF_ITEM_COMPONENTS,
  EOTF_SKILL_COMPONENTS,
} from './engine/eotf-component-support';
import { setActionGameRef } from './engine/action';
import { setUnitGameRef } from './objects/unit';
import { initIcons } from './ui/icons';
import { initBaseSurf } from './ui/base-surf';
import { setMenuAudioManager } from './ui/menu';
import { initFonts } from './rendering/bmp-font';
import { initSpriteLoader } from './combat/sprite-loader';
import { loadExpDisplaySprites } from './ui/exp-display';
import {
  setGameRef,
  TitleState,
  TitleMainState,
  TitleModeState,
  LevelSelectState,
  OptionMenuState,
  FreeState,
  MoveState,
  MenuState,
  ItemUseState,
  BaseUseState,
  AccessoryChoiceState,
  CombatArtChoiceState,
  ItemTargetingState,
  PromotionChoiceState,
  TradeState,
  RescueState,
  TransferState,
  DropState,
  WeaponChoiceState,
  TargetingState,
  CombatState,
  AIState,
  TurnChangeState,
  PhaseChangeState,
  MovementState,
  EventState,
  ShopState,
  InfoMenuState,
  setInfoMenuGameRef,
  InitiativeUpkeepState,
} from './engine/states/game-states';
import {
  DialogLogState,
  ObjectiveMenuState,
  setObjectiveDialogGameRef,
} from './engine/states/objective-dialog-states';
import {
  PrepMainState,
  PrepPickUnitsState,
  PrepMapState,
  PrepFormationState,
  setPrepGameRef,
} from './engine/states/prep-state';
import {
  SupplyItemsState,
  ItemDiscardState,
  setSupplyGameRef,
} from './engine/states/supply-state';
import {
  BaseMainState,
  BaseConvosState,
  BaseSupportState,
  BaseCodexState,
  BaseAchievementState,
  BaseLoreState,
  BaseRecordsState,
  BaseSoundRoomState,
  BaseBexpSelectState,
  BaseBexpAllocateState,
  PartyTransferState,
  BaseManageState,
  setBaseGameRef,
} from './engine/states/base-state';
import {
  SettingsMenuState,
  setSettingsGameRef,
} from './engine/states/settings-state';
import {
  MinimapState,
  setMinimapGameRef,
} from './engine/states/minimap-state';
import {
  TextEntryState,
  setTextEntryGameRef,
} from './engine/states/text-entry-state';
import {
  VictoryState,
  setVictoryGameRef,
} from './engine/states/victory-state';
import {
  GameOverState,
  setGameOverGameRef,
} from './engine/states/game-over-state';
import {
  CreditState,
  setCreditGameRef,
} from './engine/states/credit-state';
import {
  TurnwheelState,
  setTurnwheelGameRef,
} from './engine/states/turnwheel-state';
import {
  OverworldFreeState,
  OverworldMovementState,
  OverworldLevelTransitionState,
  OverworldGameOptionMenuState,
  setOverworldGameRef,
} from './engine/states/overworld-state';
import {
  FreeRoamState,
  FreeRoamRationalizeState,
  setRoamGameRef,
} from './engine/states/roam-state';
import { setQueryEngineGameRef } from './engine/query-engine';
import { setEquationGameRef } from './combat/combat-calcs';
import { setSkillSystemGameRef } from './combat/skill-system';
import { setItemSystemGameRef } from './combat/item-system';
import { initPersistentSystems } from './engine/records';
import {
  SaveMenuState,
  LoadMenuState,
  setSaveLoadGameRef,
} from './engine/states/save-load-state';
import {
  registerServiceWorker,
  requestPersistentStorage,
  setupInstallPrompt,
  setupConnectivityTracking,
  onUpdateAvailable,
} from './pwa';
import { AssetBundle, installBundleFetchInterceptor, installBundleImageInterceptor } from './data/asset-bundle';
import { initNativePlatform, onAppPause, onAppResume } from './native';
import { PerfMonitor } from './engine/perf-monitor';
import { SurfacePool } from './engine/surface-pool';
import { installHarness } from './harness';

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
  const hasWebControls = !!document.getElementById('web-controls');
  const hasTouchControls = hasWebControls &&
    window.matchMedia('(pointer: coarse), (max-width: 700px)').matches;
  const utilityRailWidth = hasWebControls && !hasTouchControls ? 72 : 0;
  const screenW = Math.max(1, window.innerWidth - utilityRailWidth);
  const landscape = window.innerWidth > window.innerHeight;
  const dockHeight = hasTouchControls
    ? Math.round(landscape
      ? Math.min(160, Math.max(136, window.innerHeight * 0.45))
      : Math.min(196, Math.max(156, window.innerHeight * 0.25)))
    : 0;
  const screenH = Math.max(1, window.innerHeight - dockHeight);
  document.documentElement.style.setProperty('--touch-dock-height', `${dockHeight}px`);

  viewport.recalculate(screenW, screenH);

  // Physical canvas = viewport game pixels * renderScale
  display.canvas.width = Math.round(viewport.width * viewport.renderScale);
  display.canvas.height = Math.round(viewport.height * viewport.renderScale);
  display.canvas.style.width = `${screenW}px`;
  display.canvas.style.left = '0';
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
// Project selection screen
// ---------------------------------------------------------------------------

/** Compile-time constant injected by Vite — list of .ltproj directory names. */
declare const __AVAILABLE_PROJECTS__: string[];

/**
 * Show a project selection screen. The list is baked in at build time via
 * Vite's `define` (no runtime API call needed).
 * If only one project exists, it is auto-selected.
 */
function showProjectPicker(): Promise<string> {
  const projects: string[] = __AVAILABLE_PROJECTS__;

  if (projects.length === 0) return Promise.resolve('default.ltproj');
  if (projects.length === 1) return Promise.resolve(projects[0]);

  return new Promise<string>((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'project-picker';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-labelledby', 'project-picker-title');

    const card = document.createElement('main');
    card.className = 'project-picker__card';
    card.innerHTML = `
      <p class="project-picker__eyebrow">Lex Talionis · Web Player</p>
      <h1 id="project-picker-title">Choose your campaign</h1>
      <p class="project-picker__lede">Select a project to launch. Your campaign fills the browser and supports keyboard, pointer, touch, and gamepad input.</p>
    `;

    const list = document.createElement('div');
    list.className = 'project-picker__list';
    list.setAttribute('aria-label', 'Available campaigns');

    projects.forEach((proj, index) => {
      const btn = document.createElement('button');
      const rawName = proj.replace(/\.ltproj$/, '').replace(/_/g, ' ');
      const displayName = rawName === 'default'
        ? 'Default Campaign'
        : rawName.toLowerCase() === 'eotf'
          ? 'Embrace of the Fog'
        : rawName.replace(/\b\w/g, (letter) => letter.toUpperCase());
      btn.className = 'project-picker__button';
      btn.type = 'button';
      btn.setAttribute('aria-label', `Launch ${displayName}`);
      const number = document.createElement('span');
      number.className = 'project-picker__number';
      number.textContent = String(index + 1).padStart(2, '0');
      const name = document.createElement('span');
      name.className = 'project-picker__name';
      name.textContent = displayName;
      const arrow = document.createElement('span');
      arrow.className = 'project-picker__arrow';
      arrow.setAttribute('aria-hidden', 'true');
      arrow.textContent = '→';
      btn.append(number, name, arrow);
      btn.addEventListener('click', () => {
        overlay.remove();
        resolve(proj);
      });
      list.appendChild(btn);
    });

    const support = document.createElement('p');
    support.className = 'project-picker__support';
    support.textContent = 'Runs locally in your browser';

    card.appendChild(list);
    card.appendChild(support);
    overlay.appendChild(card);
    document.body.appendChild(overlay);
  });
}

// ---------------------------------------------------------------------------
// Component inventory: log unknown items/skill component NIDs
// ---------------------------------------------------------------------------

function logUnknownComponents(db: Database, projectPath: string): void {
  const componentNids = (components: any): string[] => components instanceof Map
    ? [...components.keys()]
    : Array.isArray(components)
      ? components.map((component: any) =>
        Array.isArray(component) ? component[0] : component)
      : Object.keys(components ?? {});

  if (projectPath === 'rekka.ltproj') {
    for (const item of db.items.values()) {
      for (const nid of componentNids(item.components)) {
        if (!REKKA_ITEM_COMPONENTS.has(nid)) {
          reportUnimplemented('item-component', nid, `Rekka item ${item.nid}`);
        }
      }
    }
    for (const skill of db.skills.values()) {
      for (const nid of componentNids(skill.components)) {
        if (!REKKA_SKILL_COMPONENTS.has(nid)) {
          reportUnimplemented('skill-component', nid, `Rekka skill ${skill.nid}`);
        }
      }
    }
    return;
  }

  if (projectPath === 'eotf.ltproj') {
    const missingItems = new Set<string>();
    const missingSkills = new Set<string>();
    for (const item of db.items.values()) {
      for (const nid of componentNids(item.components)) {
        if (!EOTF_ITEM_COMPONENTS.has(nid)) missingItems.add(nid);
      }
    }
    for (const skill of db.skills.values()) {
      for (const nid of componentNids(skill.components)) {
        if (!EOTF_SKILL_COMPONENTS.has(nid)) missingSkills.add(nid);
      }
    }
    if (isStrictMode()) assertEotfComponentCounts();
    if (isStrictMode()) {
      for (const nid of missingItems) {
        reportUnimplemented('item-component', nid, 'Embrace of the Fog');
      }
      for (const nid of missingSkills) {
        reportUnimplemented('skill-component', nid, 'Embrace of the Fog');
      }
    } else if (missingItems.size > 0 || missingSkills.size > 0) {
      console.debug(
        `[EotFCompatibility] ${missingItems.size} item and ${missingSkills.size} ` +
        'skill component NIDs remain outside the verified project contract',
      );
    }
    return;
  }

  const unknownItemComponents = new Set<string>();
  const unknownSkillComponents = new Set<string>();

  // Known item component NIDs (from the VALID_COMMANDS list plus common components)
  // This is a minimal check — we log components that look suspicious
  const knownItemComponents = new Set([
    'weapon_type', 'weapon_rank', 'hit', 'might', 'weight', 'crit', 'durability',
    'uses', 'value', 'description', 'name', 'unrepairable', 'rank_bonus',
    'prf_unit', 'prf_class', 'prf_tags', 'prf_affinity', 'mt', 'hit_bonus',
    'crit_bonus', 'weight_bonus', 'might_formula', 'hit_formula', 'crit_formula',
    'weight_formula', 'might_formula_override', 'hit_formula_override',
    'crit_formula_override', 'weight_formula_override', 'lock', 'steal_priority',
    'effective', 'glancing_hit', 'glancing_damage', 'magic', 'magic_at_range',
    'gba_steal', 'target_tile', 'target_unit', 'target_enemy', 'target_ally',
    'unlock_staff', 'unsplashable', 'enemy_blast_aoe', 'ally_blast_aoe',
    'smart_blast_aoe', 'ally_equation_blast_aoe', 'shape_blast_aoe',
    'smart_blast', 'eval_available', 'hp_cost', 'mana_cost', 'eval_mana_cost',
    'accessory', 'locked', 'unstealable', 'droppable', 'unrepairable',
  ]);

  const knownSkillComponents = new Set([
    'stat_change', 'growth_change', 'skill_description', 'name', 'description',
    'cooldown', 'cooldown_formula', 'cooldown_percent', 'builds_charge',
    'build_charge', 'drain_charge', 'charges_per_turn', 'miracle', 'dynamic_damage',
    'dynamic_resist', 'dynamic_accuracy', 'dynamic_avoid', 'dynamic_multiattacks',
    'cannot_counter', 'cannot_use_items', 'cannot_use_magic_items',
    'ignore_rescue_penalty', 'pairup_bonus', 'attack_speed_formula',
    'defense_speed_formula', 'damage_formula', 'accuracy_formula', 'avoid_formula',
    'resist_formula', 'damage_formula_override', 'accuracy_formula_override',
    'avoid_formula_override', 'resist_formula_override', 'exp_multiplier',
    'enemy_exp_multiplier', 'wexp_multiplier', 'enemy_wexp_multiplier',
    'status_on_hit', 'status_on_equip', 'status_on_unequip', 'status_on_level',
    'status_off_hit', 'prf_unit', 'prf_class', 'prf_tags', 'prf_affinity',
    'sight_range_bonus', 'decreasing_sight_range_bonus', 'overslip_blast_aoe',
    'cleave_aoe', 'aura', 'aura_range', 'aura_target', 'show_aura', 'hide_aura',
    'canto', 'canto_speed', 'canto_range', 'ignore_forced_movement',
  ]);

  // Collect unknown item components
  for (const itemPrefab of db.items.values()) {
    for (const componentNid of componentNids(itemPrefab.components)) {
      if (!knownItemComponents.has(componentNid)) {
        unknownItemComponents.add(componentNid);
      }
    }
  }

  // Collect unknown skill components
  for (const skillPrefab of db.skills.values()) {
    for (const componentNid of componentNids(skillPrefab.components)) {
      if (!knownSkillComponents.has(componentNid)) {
        unknownSkillComponents.add(componentNid);
      }
    }
  }

  // Log summary if any unknown components found
  const allUnknown = [...unknownItemComponents, ...unknownSkillComponents].sort();
  if (allUnknown.length > 0) {
    // The known-set below only tracks exported hook functions; many components
  // are implemented via direct getComponent() reads (see docs/parity/
  // resolve-policies.md and the audit's 'consumed' status), so absence here is
  // NOT an unimplemented claim. Kept at debug level to avoid misleading noise.
  console.debug(`[ComponentInventory] ${allUnknown.length} component nids without exported hook functions (may be implemented via direct reads): ${allUnknown.join(', ')}`);
  }
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

  // --- Determine project URL ---
  const params = new URLSearchParams(window.location.search);
  const harnessMode = params.get('harness') === 'true';
  const harnessLevel = params.get('level') ?? 'DEBUG';
  const harnessClean = params.get('clean') !== 'false'; // default: skip events
  let projectPath = params.get('project');

  // If no project specified:
  // - Harness mode defaults to default.ltproj for deterministic tests.
  // - Normal mode shows the project picker and redirects with ?project= param.
  if (!projectPath) {
    if (harnessMode) {
      const projects: string[] = __AVAILABLE_PROJECTS__;
      const hasDefault = projects.includes('default.ltproj');
      projectPath = hasDefault ? 'default.ltproj' : (projects[0] ?? 'default.ltproj');
      console.info(`[Harness] No project specified. Using ${projectPath}`);
    } else {
      const chosen = await showProjectPicker();
      const url = new URL(window.location.href);
      url.searchParams.set('project', chosen);
      window.location.href = url.toString();
      return;
    }
  }

  const startupStatus = harnessMode ? null : installStartupStatus(projectPath);
  startupStatus?.update('Preparing game data…');
  drawLoadingScreen(ctx, 'Loading...');
  const baseUrl = `/game-data/${projectPath}`;
  // A packaged deployment wants the single-zip bundle: it turns thousands of
  // asset requests into one. A dev server does not — Vite already serves the
  // project straight from disk, and holding the decompressed archive costs
  // hundreds of megabytes of heap (EotF measured 273MB with the bundle versus
  // 73MB without), which shows up as GC pauses while playing.
  //
  // So default to the bundle only in production builds. Either mode can be
  // forced with ?bundle=true / ?bundle=false.
  const bundleParam = params.get('bundle');
  const useBundle = bundleParam === 'true' ||
    (bundleParam !== 'false' && import.meta.env.PROD);

  // In harness mode, force zoom so viewport matches GBA resolution (240x160).
  // With tilesAcross=10 and Playwright viewport 480x320:
  //   cssScale = 320/(10*16) = 2.0, width = 480/2 = 240, height = 320/2 = 160
  if (harnessMode) {
    viewport.setZoom(10);
    applySize(display);
  }

  // --- Try loading asset bundle (single zip instead of hundreds of requests) ---
  if (useBundle) {
    const bundleUrl = `/bundles/${projectPath}.zip`;
    try {
      const bundle = new AssetBundle();
      await bundle.load(bundleUrl, (progress) => {
        startupStatus?.update(progress.message);
        drawLoadingScreen(ctx, progress.message);
      });
      // Install interceptors so ResourceManager reads from the bundle
      installBundleFetchInterceptor(bundle, baseUrl);
      installBundleImageInterceptor(bundle, baseUrl);
      console.info(`[Bundle] Loaded ${bundle.fileCount} files from ${bundleUrl}`);
    } catch {
      // Bundle not available — fall through to individual HTTP requests
      console.info('[Bundle] No asset bundle found, using individual requests');
    }
  }

  // --- Load game data ---
  const resources = new ResourceManager(baseUrl);
  const db = new Database();

  try {
    startupStatus?.update('Loading campaign database…');
    drawLoadingScreen(ctx, 'Loading database...');
    await db.load(resources);
    // Check for unknown components at load time
    logUnknownComponents(db, projectPath);
    if (harnessMode) {
      // Let tests re-run the scan after injecting synthetic components.
      (window as any).__logUnknownComponents = () => logUnknownComponents(db, projectPath);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('Failed to load database:', msg);
    startupStatus?.fail(msg);
    drawErrorScreen(ctx, `DB load failed: ${msg}`);
    return;
  }

  // --- Icons, Fonts & UI resources ---
  initIcons(baseUrl);
  // Engine-level shared assets (sprites/menus, platforms) live at /game-data/,
  // not inside the .ltproj directory.
  const engineBaseUrl = '/game-data';
  initBaseSurf(engineBaseUrl);
  initSpriteLoader(engineBaseUrl);
  // Load bitmap fonts (async, text rendering falls back to Canvas until ready)
  initFonts(baseUrl);
  // Load EXP display sprites (async, falls back to canvas primitives until ready)
  loadExpDisplaySprites();

  // --- Audio ---
  const audioManager = new AudioManager(baseUrl);
  setupAudioInit(audioManager);

  // --- GameState ---
  startupStatus?.update('Starting the game…');
  drawLoadingScreen(ctx, 'Initializing...');
  const gameState = initGameState(db, resources, audioManager);
  setUnitGameRef(() => gameState);
  setActionGameRef(() => gameState);
  setGameRef(gameState);
  setInfoMenuGameRef(gameState);
  setMenuAudioManager(audioManager);
  setPrepGameRef(gameState);
  setSupplyGameRef(gameState);
  setBaseGameRef(gameState);
  setSettingsGameRef(gameState);
  setTextEntryGameRef(gameState);
  setMinimapGameRef(gameState);
  setVictoryGameRef(gameState);
  setGameOverGameRef(gameState);
  setCreditGameRef(gameState);
  setTurnwheelGameRef(gameState);
  setOverworldGameRef(gameState);
  setRoamGameRef(gameState);
  setQueryEngineGameRef(() => gameState);
  setEquationGameRef(() => gameState);
  setSkillSystemGameRef(() => gameState);
  setItemSystemGameRef(() => gameState);
  setSaveLoadGameRef(gameState);
  setObjectiveDialogGameRef(gameState);

  // Initialize persistent systems (cross-save records and achievements)
  const gameNid = db.getConstant('game_nid', 'default') as string;
  initPersistentSystems(gameNid);


  // --- Register states ---
  const states = [
    new TitleState(),
    new TitleMainState(),
    new TitleModeState(),
    new LevelSelectState(),
    new OptionMenuState(),
    new ObjectiveMenuState(),
    new DialogLogState(),
    new FreeState(),
    new MoveState(),
    new MenuState(),
    new ItemUseState(),
    new BaseUseState(),
    new AccessoryChoiceState(),
    new CombatArtChoiceState(),
    new ItemTargetingState(),
    new PromotionChoiceState(),
    new TradeState(),
    new RescueState(),
    new TransferState(),
    new DropState(),
    new WeaponChoiceState(),
    new TargetingState(),
    new CombatState(),
    new AIState(),
    new TurnChangeState(),
    new InitiativeUpkeepState(),
    new PhaseChangeState(),
    new MovementState(),
    new EventState(),
    new ShopState(),
    new InfoMenuState(),
    new PrepMainState(),
    new PrepPickUnitsState(),
    new PrepMapState(),
    new PrepFormationState(),
    new SupplyItemsState(),
    new ItemDiscardState(),
    new BaseMainState(),
    new BaseConvosState(),
    new BaseSupportState(),
    new BaseCodexState(),
    new BaseAchievementState(),
    new BaseLoreState(false),
    new BaseLoreState(true),
    new BaseRecordsState(),
    new BaseSoundRoomState(),
    new BaseBexpSelectState(),
    new BaseBexpAllocateState(),
    new PartyTransferState(),
    new BaseManageState(),
    new SettingsMenuState(),
    new MinimapState(),
    new TextEntryState(),
    new VictoryState(),
    new GameOverState(),
    new CreditState(),
    new TurnwheelState(),
    new OverworldFreeState(),
    new OverworldMovementState(),
    new OverworldLevelTransitionState(),
    new OverworldGameOptionMenuState(),
    new FreeRoamState(),
    new FreeRoamRationalizeState(),
    new SaveMenuState(),
    new LoadMenuState(),
  ];
  for (const state of states) {
    gameState.state.register(state);
  }

  // Fire on_startup once per boot. This has to happen after the states are
  // registered: `trigger` only queues the event, and the queue is drained by
  // the event state. Firing it earlier left the event queued until the title
  // or level flow cleared it, so a project that initialises its persistent
  // records here (EotF creates Progress, currencies, and unit lists in an
  // on_startup event) silently started with none of them.
  const startupQueued = gameState.eventManager?.trigger(
    { type: 'on_startup' },
    { game: gameState, gameVars: gameState.gameVars, levelVars: new Map() },
  ) ?? false;

  // --- Push initial state (level is loaded via LevelSelectState) ---
  gameState.state.change('title');
  // Stacked above the title so the startup event runs first and pops back to
  // it, matching Python running on_startup before the player reaches a menu.
  if (startupQueued) gameState.state.change('event');

  // --- Input ---
  canvas.tabIndex = 0;
  canvas.setAttribute('aria-label', 'Game display');
  const inputManager = new InputManager(canvas);
  inputManager.setDisplayScale(viewport.cssScale);
  gameState.input = inputManager;
  const showWebControls = !harnessMode || params.get('controls') === 'true';
  if (showWebControls) {
    installWebControls(inputManager, audioManager);
    applySize(display);
    inputManager.setDisplayScale(viewport.cssScale);
  }
  canvas.focus({ preventScroll: true });

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

  // --- Harness mode: skip rAF loop, expose programmatic API ---
  if (harnessMode) {
    installHarness(gameState, gameSurface, display.canvas, display.ctx);
    // Expose game reference for advanced test manipulation
    (window as any).__gameRef = gameState;
    // Optional deterministic RNG seed hook for soak automation
    // (scripts/sacred-stones-soak.mjs). Two sources, checked in order:
    //   1. ?seed=<int> query param (explicit, per-navigation)
    //   2. /soak-seed.json static file (public/soak-seed.json), written by the
    //      soak script before each iteration so unmodified spec files (whose
    //      page.goto() calls don't carry a ?seed=) still pick up a distinct
    //      seed per iteration without every spec needing edits.
    // Either way, applying it clears any derived combat/growth RNG stream
    // state so a fresh, fully-deterministic sequence starts from this seed.
    function applySeed(seed: number, source: string): void {
      gameState.gameVars.set('_random_seed', seed);
      gameState.gameVars.delete('_combat_random_seed');
      gameState.gameVars.delete('_growth_random_seed');
      console.info(`[Harness] Deterministic RNG seed set from ${source}: ${seed}`);
    }
    const seedParam = params.get('seed');
    if (seedParam !== null) {
      const seed = Number.parseInt(seedParam, 10);
      if (Number.isFinite(seed)) {
        applySeed(seed, '?seed=');
      } else {
        console.warn(`[Harness] Ignoring invalid ?seed= value: ${seedParam}`);
      }
    } else {
      try {
        const res = await fetch('/soak-seed.json', { cache: 'no-store' });
        if (res.ok) {
          const data = await res.json();
          if (data && Number.isFinite(data.seed)) {
            applySeed(data.seed, '/soak-seed.json');
          }
        }
      } catch {
        // No soak-seed.json present (normal test/dev run) -- ignore.
      }
    }
    // Load the requested level directly
    try {
      const h = (window as any).__harness;
      if (harnessClean) {
        await h.loadLevelClean(harnessLevel);
      } else {
        await h.loadLevel(harnessLevel);
      }
      console.info(`[Harness] Level "${harnessLevel}" loaded (clean=${harnessClean}). Use window.__harness to drive the game.`);
    } catch (err) {
      console.error('[Harness] Failed to load level:', err);
      (window as any).__harness.ready = false;
    }
    // Don't start the rAF loop -- Playwright will drive frames via __harness.stepFrames()
    return;
  }

  // --- Game loop ---
  let lastTimestamp = 0;

  // F3 toggles performance overlay, F4 toggles profiling session
  let profilingSession = false;
  window.addEventListener('keydown', (e) => {
    if (e.key === 'F3') {
      e.preventDefault();
      PerfMonitor.toggle();
    }
    if (e.key === 'F4') {
      e.preventDefault();
      if (!profilingSession) {
        PerfMonitor.startProfiling();
        profilingSession = true;
        console.info('[Perf] Press F4 again to stop and export the profiling report');
      } else {
        const report = PerfMonitor.stopProfiling();
        profilingSession = false;
        // Log summary to console
        console.info('[Perf] === Profiling Report ===');
        console.info(`  Duration: ${report.durationSec.toFixed(1)}s, ${report.totalFrames} frames`);
        console.info(`  Avg FPS: ${report.avgFps.toFixed(1)}, Min FPS: ${report.minFps.toFixed(0)}`);
        console.info(`  Frame time: avg=${report.avgFrameTimeMs.toFixed(1)}ms, p95=${report.p95FrameTimeMs.toFixed(1)}ms, p99=${report.p99FrameTimeMs.toFixed(1)}ms, peak=${report.peakFrameTimeMs.toFixed(1)}ms`);
        console.info(`  Dropped frames: ${report.droppedFrames} (${(report.droppedFrames / report.totalFrames * 100).toFixed(1)}%)`);
        console.info(`  Memory peak: ${report.memory.peakMb.toFixed(0)}MB`);
        console.info('[Perf] Full report: __PerfMonitor.exportReport()');
        // Also store as downloadable JSON
        console.info('[Perf] Report object:', report);
      }
    }
  });

  function gameLoop(timestamp: number): void {
    PerfMonitor.beginFrame();

    const rawDelta = lastTimestamp === 0 ? FRAMETIME : timestamp - lastTimestamp;
    const deltaMs = Math.min(rawDelta, FRAMETIME * 3);
    lastTimestamp = timestamp;

    // Store real frame delta on game state for time-based animations
    game.frameDeltaMs = deltaMs;

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
    PerfMonitor.beginUpdate();
    let repeat = true;
    let iterations = 0;
    const maxIterations = 10;

    while (repeat && iterations < maxIterations) {
      const inputForThisIteration = iterations === 0 ? event : null;
      // Clear transient input signals on repeat iterations so stale
      // justPressed/mouseClick events don't get consumed by multiple
      // states during the repeat chain (prevents double-pop bugs).
      if (iterations > 0) {
        inputManager.clearFrameEvents();
      }
      const [, shouldRepeat] = game.state.update(inputForThisIteration, gameSurface);
      repeat = shouldRepeat;
      iterations++;
    }
    PerfMonitor.endUpdate();

    // --- Animations ---
    updateAnimationCounters();

    // --- Movement ---
    game.movementSystem.update(deltaMs);

    // --- Blit to display ---
    PerfMonitor.beginDraw();
    display.ctx.imageSmoothingEnabled = false;
    display.ctx.clearRect(0, 0, display.canvas.width, display.canvas.height);
    display.ctx.drawImage(gameSurface.canvas, 0, 0);

    // --- HUD overlay (fixed screen-space, not affected by zoom) ---
    game.hud.drawScreen(display.ctx, window.innerWidth, window.innerHeight, game.db, game.initiative, game.units);
    startupStatus?.remove();
    PerfMonitor.endDraw();

    // --- Performance overlay (screen-space, on top of everything) ---
    // Sync perf overlay with the in-game settings (display_fps)
    const fpsSettingVal = game.gameVars?.get('_setting_display_fps');
    if (fpsSettingVal !== undefined) {
      PerfMonitor.setEnabled(fpsSettingVal === 1 || fpsSettingVal === true);
    }
    PerfMonitor.draw(display.ctx, display.canvas.width, display.canvas.height);

    // --- End of frame ---
    PerfMonitor.endFrame();
    inputManager.endFrame();
    audioManager.resume();

    requestAnimationFrame(gameLoop);
  }

  requestAnimationFrame(gameLoop);

  // --- Native platform (Capacitor / TWA / Wake Lock) ---
  initNativePlatform();
  onAppPause(() => {
    // Pause audio when the app is backgrounded
    audioManager.suspendContext();
  });
  onAppResume(() => {
    // Resume audio when the app comes back
    audioManager.resume();
  });

  // --- PWA: install prompt + connectivity + service worker ---
  setupInstallPrompt();
  setupConnectivityTracking();
  onUpdateAvailable((apply) => {
    // Log update availability; the game can check and apply via settings menu
    console.info('[PWA] Update available — call apply() to reload with new version');
    // Store the apply function on the game state so the settings/title screen can use it
    game.gameVars.set('_pwa_update_available', true);
    game.gameVars.set('_pwa_apply_update', apply as any);
  });
  registerServiceWorker().then((reg) => {
    if (reg) {
      // Request persistent storage so the browser won't evict cached game data
      requestPersistentStorage().then((granted) => {
        if (granted) {
          console.info('[PWA] Persistent storage granted');
        }
      });
    }
  });
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
