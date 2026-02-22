# lt-web: Lex Talionis Web Engine -- Development Plan

This document tracks what has been built, what is partially complete, and what
remains to bring the TypeScript web port to feature parity with the original
Lex Talionis Python/Pygame engine.

---

## Current State

**84 source files, ~44,400 lines of TypeScript.**
Builds cleanly with zero type errors. Loads `.ltproj` game data over
HTTP and runs a 60 fps game loop rendering to a dynamically-scaled
HTML5 Canvas with dynamic viewport (mobile + desktop). Phase 1.2 core
gameplay implemented, plus GBA-style combat animations, team-colored
map sprites, level select, full touch/mouse/keyboard input, component
dispatch system, scripted combat, shop system, map animations, 9-slice
menu backgrounds, item icon rendering, JS-based condition evaluator,
GBA-style preparation screen, base screen hub, settings menu, minimap,
victory screen, credits screen, support system (adjacency-based support
points, rank progression, stat bonuses), fog of war (GBA/Thracia/Hybrid
modes, vision grids, torch/thief sight bonuses), turnwheel / Divine
Pulse (full undo/redo of game actions), initiative turn system
(speed-based per-unit turn order), and overworld map system (FE8-style
world map with nodes, roads, party movement).

### Known Bugs

- [x] ~~**Dialogue box positioned at bottom after turn transition.**~~ Fixed: dialog Y now uses Python's fixed formula (`viewport.height - boxH - 80 - 4`) instead of relative-to-portrait positioning. Dialog width expanded to full-width (matching Python).
- [x] ~~**Mouth animations too fast and random.**~~ Fixed: per-transition durations now match Python exactly (was using per-destination-state durations, which scrambled the timing).
- [x] ~~**Magic attacks freeze combat.**~~ Fixed 8 issues total: (1) `spell_hit` now pauses animation + enters wait state, (2) `spell_hit_2` (crit variant) implemented, (3) `wait_for_hit` is now conditional on `waitForHit` flag, (4) `endParentLoop` now calls `breakLoop()` on the parent attacker animation, (5) loop mechanism supports proper break-out via `skipNextLoop` counter, (6) **weapon type resolution now prepends "Magic" prefix** for magic items matching Python's `get_battle_anim()` (was passing raw `Anima`/`Light`/`Dark` which fell back to `Unarmed`), (7) **`startHit()` side detection** now uses `currentStrikeDefenderAnim` instead of anim identity comparison (child spell effects were misidentified), (8) **safety timeout** (600 frames) in `updateAnim()` prevents infinite loops if spell effects fail.
- [x] ~~**No hit/crit/attack sound effects.**~~ Fixed: `AnimationCombat.playSound()` now wired to `AudioManager.playSfx()`. `MapCombat` plays hit/crit/miss sounds at strike impact. Audio file URLs now use `encodeURIComponent` for proper handling of filenames with spaces.
- [x] ~~**No sound effects on move or UI interaction.**~~ Fixed: cursor movement plays `Select 5`, menu up/down plays `Select 6`, confirm plays `Select 1`, back plays `Select 4`. Mouse click and hover on menus now also plays corresponding sounds.
- [x] ~~**Can't select Move option.**~~ Not a real bug — Move is not a menu option (matches Python). Unit movement works via FreeState → MoveState flow.
- [x] ~~**Can't select weapon before attacking.**~~ Fixed: new `WeaponChoiceState` shows all usable weapons when attacking. Auto-selects if only one weapon. Shows attack range per weapon on hover. MenuState now goes to `weapon_choice` → `targeting` instead of directly to `targeting`.
- [x] ~~**Combat UI overlap.**~~ Fixed: name tags now render at top of screen (matching Python layout), HP bars at bottom. Name tags slide in from above, HP bars slide up from below. Each occupies its own screen region — no more overlap.

### Recent Changes (Latest Session)
- **6 follow-up fixes across magic combat, audio, UI, and menu sounds.**
  - **Magic weapon type resolution.** `game-states.ts` now prepends `"Magic"`
    prefix for items with `magic`/`magic_at_range` components before calling
    `selectWeaponAnim()`, matching Python's `get_battle_anim()`. Raw weapon types
    like `Anima`/`Light`/`Dark` were falling back to `Unarmed` (no Attack pose →
    freeze). `selectWeaponAnim()` rewritten with `Magic*` → `Magic` → `MagicGeneric`
    fallback chain and `Ranged*` prefix stripping (matching Python).
  - **Spell hit side detection.** `startHit()` now uses `currentStrikeDefenderAnim`
    (set during `beginStrike`) instead of comparing `anim === leftAnim`. Child spell
    effects pass themselves as `anim`, not the parent anim, so identity comparison
    always failed → damage applied to wrong side.
  - **Animation safety timeout.** `updateAnim()` now has a 600-frame (~10s) timeout.
    If the animation state gets stuck (spell effect fails to spawn, callback missed),
    it force-clears `awaitingHit` and transitions to `end_phase`.
  - **Audio URL encoding.** `loadSfxBuffer()` and `loadMusicBuffer()` now use
    `encodeURIComponent()` for filenames, fixing issues with SFX names containing
    spaces (e.g. `"Attack Hit 1"`, `"Select 5"`).
  - **Mouse/touch menu sounds.** `ChoiceMenu.handleClick()` now plays `Select 1`
    (confirm), `Select 4` (back), `Error` (disabled). `handleMouseHover()` plays
    `Select 6` when hover changes selection.
  - **Combat UI layout overhaul.** Name tags moved to top of screen (matching Python's
    layout where they slide in from y=-60). HP bars remain at bottom, sliding up from
    below screen. Each occupies its own screen region — no more overlap.

### Previous Session
- **8 bug fixes across combat, UI, portraits, and audio.**
  - **Magic attack freeze fix.** Five root causes in `battle-animation.ts` and
    `animation-combat.ts`: (1) `spell_hit` command now sets `state='wait'` and
    `processing=false` before calling `spellHit()` (was fire-and-forget),
    (2) `spell_hit_2` (crit spell variant) fully implemented (was unhandled →
    `awaitingHit` stuck true forever), (3) `wait_for_hit` now checks a
    `waitForHit` boolean flag set in `setPose()` and cleared in `resume()`
    (was unconditionally entering wait → child effects stuck forever),
    (4) `endParentLoop()` now calls `breakLoop()` on the parent attacker
    animation instead of `resume()` on the child (was never breaking the
    casting loop), (5) loop mechanism rewritten with `loopEndIndex` tracking,
    `breakLoop()` method, and `skipNextLoop` counter for proper loop exit.
    `resume()` also resumes child effects.
  - **Weapon choice state.** New `WeaponChoiceState` (`game-states.ts`)
    inserted between MenuState and TargetingState. Shows all equippable weapons
    (with uses remaining) when the unit selects Attack. Highlights attack range
    per weapon on hover. Auto-selects if only one weapon. Registered in
    `main.ts`. MenuState now routes Attack → `weapon_choice` → `targeting`.
  - **Portrait mouth animation timing.** `randomTalkDuration()` replaced with
    per-transition inline durations matching Python's `update_talk()` exactly.
    Each (source→target) state pair now has the correct duration range. Uses
    `Math.floor(Math.random() * 10) + 1` for 1-10 integer matching Python.
  - **Dialog positioning.** Dialog Y now uses Python's fixed formula
    (`viewport.height - boxH - 80 - 4`) instead of portrait-relative Y.
    Width expanded from 120px cap to full viewport width (matching Python's
    wide dialog style). No longer appears at bottom after turn transitions.
  - **Combat sound effects.** `AnimationCombat.playSound()` wired to
    `AudioManager.playSfx()` via new `audioManager` property set in
    `CombatState`. `MapCombat` plays `Attack Hit 1/2`, `Critical Hit 1`,
    or `Attack Miss 2` at lunge impact via new `audioManager` property
    and `hitSoundPlayed` guard.
  - **UI/cursor sound effects.** `moveCursor()` plays `Select 5`. `ChoiceMenu`
    plays `Select 6` (up/down), `Select 1` (confirm), `Select 4` (back),
    `Error` (disabled option). Wired via `setMenuAudioManager()` in `main.ts`.
  - **Combat UI layout.** `HP_BAR_SECTION_H` increased from 20 to 26.
    HP bar moved from `y+10` to `y+12`, HP text moved from `barY-1` to
    `barY+barH+1` (below bar). Weapon name, HP bar, and HP numbers no longer
    overlap.

### Previous Session
- **Phase 4 Mobile/Distribution completed.** All four remaining Phase 4
  items (PWA, Asset Bundling, Performance Profiling, Capacitor/TWA) are now
  fully implemented and wired in.
- **PWA support enhanced.** `src/pwa.ts` expanded with `beforeinstallprompt`
  capture and deferred install prompt API (`canInstall()`, `showInstallPrompt()`),
  update detection with `onUpdateAvailable()` callback, online/offline
  connectivity tracking (`setupConnectivityTracking()`, `isOnline()`),
  comprehensive `getPwaStatus()` for debugging. Vite plugin
  (`swPrecacheManifest()`) in `vite.config.ts` generates
  `precache-manifest.json` after each build listing all output files with
  content hashes. `public/sw.js` upgraded to v2: reads precache manifest on
  install (falls back to static list in dev), SPA navigation fallback
  serves cached `index.html` for offline navigation. `manifest.json`
  enhanced with `display_override`, `launch_handler`, `scope`, `id`,
  separated any/maskable icon entries. Install prompt, connectivity, and
  update handler wired into `main.ts` startup.
- **Performance profiling enhanced.** `src/engine/perf-monitor.ts` rewritten
  to ~440 lines with: min FPS tracking (matching Python's `draw_fps()`
  from `lt-maker/app/engine/driver.py`), sustained budget violation
  detection (warns after 3s of dropped frames — critical for mobile),
  per-function timing API (`timeFunction()`/`endTimeFunction()` inspired
  by Python's `@frame_time` decorator from `lt-maker/app/utilities/
  frame_time.py`), long frame spike logging (>33ms entries, console warn
  at >50ms), frame time histogram (7 buckets), profiling session recording
  with F4 key (start/stop with console summary), exportable JSON report
  with percentiles (p50/p95/p99), dropped frame count, device info
  (hardwareConcurrency, deviceMemory, DPR), function hotspots, and memory
  stats. `__PerfMonitor` exposed on globalThis for console profiling.
  HUD overlay expanded to show min FPS, top 3 function hotspots with
  color-coded timing.
- **Capacitor / TWA wrapper implemented.** `capacitor.config.ts` enhanced
  with SplashScreen plugin config, iOS scroll disable, server
  allowNavigation. New `twa-manifest.json` for bubblewrap Android TWA
  builds. New `scripts/setup-native.mjs` interactive setup script with
  prerequisite checking and step-by-step guidance. New `src/native.ts`
  (~210 lines) with platform detection, Screen Wake Lock API, dynamic
  Capacitor plugin loading, app pause/resume lifecycle (audio
  suspend/resume via new `AudioManager.suspendContext()`), Android back
  button handling, safe area inset detection. Package.json: added
  `setup:capacitor`, `setup:twa`, `cap:sync`, `cap:ios`, `cap:android`
  scripts.

### Previous Session
- **Equation evaluator wiring completed.** `setEquationGameRef()` now called
  in `main.ts` so combat equation evaluation can access DB, constants, and
  named equations at runtime. Previously the game reference was defined but
  never connected.
- **Query engine functions injected into event condition evaluator.** The
  `evaluateWithJsFallback()` in `event-manager.ts` now imports
  `GameQueryEngine` and injects all 28 query functions (u, get_item,
  has_item, get_subitem, get_skill, has_skill, get_klass, is_dead,
  check_alive, get_internal_level, get_support_rank, get_terrain,
  has_achievement, check_shove, get_money, get_bexp, is_roam,
  get_roam_unit, ai_group_active, get_team_units, get_player_units,
  get_enemy_units, get_all_units, get_convoy_inventory, etc.) into
  the `new Function()` eval scope. Event conditions can now call any
  query function directly (e.g., `is_dead('Boss')`, `get_money() > 1000`).
- **GameQueryEngine expanded to 874 lines.** Added 13 new methods:
  getSubitem, checkAlive, getInternalLevel, getMoney, getBexp, isRoam,
  getRoamUnit, aiGroupActive, getTeamUnits, getPlayerUnits, getEnemyUnits,
  getAllUnits, getConvoyInventory. All with snake_case aliases.

### Previous Session
- **Save/load system implemented.** New `src/engine/save.ts` (~1474 lines)
  with IndexedDB storage (localStorage fallback), full serialization for
  units/items/skills/levels/parties/supports, `saveGame()`, `suspendGame()`,
  `loadGame()`, `loadSuspend()`, `restoreGameState()` (15-step ordered
  restoration). Save/Load UI in `src/engine/states/save-load-state.ts`
  (~300 lines) with `SaveMenuState` and `LoadMenuState`. Event commands:
  `battle_save`, `battle_save_prompt`, `skip_save`, `suspend`.
- **Query engine implemented.** New `src/engine/query-engine.ts` (~647 lines)
  with `GameQueryEngine` class providing all Python query functions (u, v,
  getItem, hasItem, getSkill, hasSkill, getKlass, getClosestAllies,
  getUnitsWithinDistance, getUnitsInRegion, isDead, getSupportRank,
  getTerrain, hasAchievement, checkShove) with camelCase + snake_case aliases.
- **PYEV1 Python-syntax events implemented.** New `src/events/python-events.ts`
  (~995 lines) with `PythonEventProcessor` — line-by-line interpreter with
  indentation-based blocks, if/elif/else/for/while flow control, `$command`
  tokenizer, Python-to-JS expression translation with builtins. Integrated
  into `GameEvent` constructor for automatic detection.
- **Build fixes.** Replaced `await import()` with static imports in
  game-states.ts event handlers, replaced `require()` with static import
  in event-manager.ts, fixed save-load-state.ts to use correct ChoiceMenu
  API (`handleInput()` instead of non-existent `.pressed`/`.moveCursor`).

### Previous Session
- **Records system implemented.** New `src/engine/records.ts` (~903 lines)
  with three systems: `Recordkeeper` (per-save in-memory game statistics —
  kills, damage, healing, deaths, item use, steals, combat results, turns,
  levels, exp, money — with append/pop, interrogation methods like getKills,
  getDamage, getHeal, determineScore, getMvp, getKiller, getLevels,
  getTurncounts, and full save/restore/clear); `PersistentRecordManager`
  (cross-save key-value records backed by localStorage — CRUD operations,
  difficulty/song unlock tracking); `AchievementManager` (cross-save
  achievements backed by localStorage — add/complete/check/getAll with
  hidden achievement support). Module-level singletons `RECORDS` and
  `ACHIEVEMENTS` with `initPersistentSystems()`/`resetPersistentSystems()`.

### Previous Session
- **Free Roam system implemented.** ARPG-style direct unit control for roam
  mode levels. New files: `src/engine/roam-info.ts` (~25 lines, roam state
  data on GameState), `src/movement/roam-movement.ts` (~300 lines,
  `RoamPlayerMovementComponent` with physics-based acceleration/deceleration,
  sprinting, collision detection against terrain and enemy units, sub-tile
  grid sync; `RationalizeMovementComponent` slides units back to grid),
  `src/engine/states/roam-state.ts` (~470 lines, `FreeRoamState` with direct
  unit control, NPC/region interaction within talk range, region interrupts,
  roam-specific map rendering with sub-tile visual offsets;
  `FreeRoamRationalizeState` transparent overlay for grid snap transitions).
  `GameState.roamInfo` field initialized from level prefab `roam`/`roam_unit`
  fields. `FreeState.begin()` redirects to `free_roam` when roam mode is
  active. Event commands `set_roam` and `set_roam_unit` added to
  `EventCommandType` and EventState command handler. Both new states
  registered in `main.ts` with `setRoamGameRef()`.

### Previous Session
- **Difficulty modes implemented.** New `src/engine/difficulty.ts` (~135 lines)
  with `DifficultyModeObject` runtime class. Created from DB prefab at
  `loadLevel()`. Stores permadeath, growths, RNG mode, and mutable autolevel
  counters. `GameState` gains `currentMode`, `initDifficulty()`, `mode` getter,
  `getAlliedTeams()`. Unit spawning now applies difficulty base stat bonuses
  (unique + generic) and difficulty autolevels (generic only) with
  `promoted_autolevels_fraction` and true levels.
- **Promotion / class change actions implemented.** New `PromoteAction` and
  `ClassChangeAction` in `action.ts` (~240 lines combined). `PromoteAction`
  uses the target class's promotion dict with sentinel values (-99 set to new
  base, -98 only-if-bigger, -97 base diff). `ClassChangeAction` uses
  (new base − old base) clamped. Both handle growth changes when
  `unit_stats_as_bonus` is true, wexp gain, max stat updates, HP adjustment,
  and full undo/redo. Event commands `promote` and `change_class` rewritten
  in game-states.ts: resolve class list (single class or `turns_into`), create
  action via `doAction()`, grant new class skills via `grantClassSkills()`
  helper, apply wexp, reload map sprites. Replaced the old stub `change_class`
  that only set `unit.klass`.

### Previous Session
- **Party and Convoy systems implemented.** Full party system ported from
  Python's `app/engine/objects/party.py`. New `PartyPrefab` type in
  `data/types.ts`. `Database.loadParties()` loads `parties.json` (array
  of `{nid, name, leader}`) in Phase 1 non-chunked data loading. New
  `PartyObject` class in `src/engine/party.ts` (~32 lines) with `nid`,
  `name`, `leaderNid`, `money`, `convoy` (ItemObject[]), `bexp` fields.
  `GameState` extended with `parties` Map, `currentParty` NID,
  `getParty()` (auto-creates from DB prefab), `initParties()`,
  `getUnitsInParty()`, `getAllUnitsInParty()`, `getMoney()`, `getBexp()`.
  Parties initialized during `loadLevel()` with `currentParty` set from
  level prefab. Player units auto-assigned to current party on spawn.
  `UnitObject` extended with `party: NID` and `persistent: boolean`
  fields. Seven new Action classes in `action.ts` for convoy operations:
  `PutItemInConvoy`, `TakeItemFromConvoy`, `RemoveItemFromConvoy`,
  `StoreItemAction`, `TradeItemWithConvoy`, `GainMoneyAction`,
  `GiveBexpAction` — all using `_getGame` pattern to avoid circular deps.
  `setActionGameRef()` wired in `main.ts`. Event commands updated:
  `give_money`/`give_bexp` now use party system (with backward-compatible
  `gameVars` sync). New commands: `enable_convoy`, `disable_convoy`,
  `change_party`, `open_convoy` (stub). `give_item` supports `'convoy'`
  as target to place items directly in the party convoy.

### Previous Session
- **Initiative turn system implemented.** Full port of the initiative-based
  turn system from Python's `app/engine/initiative.py`. When the `initiative`
  constant is enabled, units take individual turns ordered by initiative
  value (from DB equation) instead of the standard team-phase cycle.
  `InitiativeTracker` class (`src/engine/initiative.ts`, ~210 lines) manages
  the unit line with binary insert, wrap-around cycling, and index tracking.
  New `InitiativeUpkeepState` determines which state to push (free/ai) based
  on the current initiative unit's team. `TurnChangeState` advances
  initiative and increments turn count on cycle wrap. `FreeState`: auto-cursor
  to initiative unit, restricts selection to that unit, auto-ends turn when
  finished, START toggles initiative bar. `AIState`: only processes the
  single current initiative unit. `PhaseChangeState`: only resets the
  initiative unit (not whole team). Unit sprites grey out non-initiative units
  during their team's turn. Event commands: `add_to_initiative` (insert at
  position relative to current index), `move_in_initiative` (shift by offset).
  Auto-insert/remove on unit spawn/death via event commands (`add_unit`,
  `add_group`, `spawn_group`, `remove_unit`, `kill_unit`) and combat death
  (both MapCombat and AnimationCombat paths, plus interact_unit scripted
  combat). Registered in `main.ts`. Still missing: initiative bar rendering
  UI (the visual bar showing unit order at bottom/top of screen).

### Previous Session
- **Overworld map system implemented.** Full Fire Emblem 8-style world map
  with nodes, roads, entities, and level entry. New files:
  `src/engine/overworld/overworld-objects.ts` (41 lines, runtime types),
  `src/engine/overworld/overworld-manager.ts` (~465 lines, graph operations
  with Dijkstra shortest path, entity CRUD, node properties, menu option
  toggles), `src/engine/overworld/overworld-movement.ts` (~180 lines,
  animated entity movement along road waypoints with interpolation and
  camera follow). Three game states in `src/engine/states/overworld-state.ts`
  (~670 lines): `OverworldFreeState` (cursor movement, node selection, party
  movement initiation, node menu with dynamic options, tilemap rendering,
  road/node/entity drawing), `OverworldMovementState` (transparent overlay,
  movement manager updates, fast-forward with SELECT),
  `OverworldLevelTransitionState` (fade-to-black, loads level, transitions).
  Database loads `overworlds.json` with `loadOverworlds()`. Data types:
  `NodeMenuEvent`, `OverworldNodePrefab`, `OverworldPrefab` in `types.ts`.
  11 event commands fully implemented: `overworld_cinematic`,
  `reveal_overworld_node`, `reveal_overworld_road`, `overworld_move_unit`
  (blocking with road animation + movement manager unblock in EventState
  update), `set_overworld_position`, `create_overworld_entity`,
  `disable_overworld_entity`, `set_overworld_menu_option_enabled`,
  `set_overworld_menu_option_visible`, `enter_level_from_overworld`,
  `toggle_narration_mode`. `omove` alias for `overworld_move_unit`.
  GameState integration: `overworldController`, `overworldMovement`,
  `overworldRegistry` fields. All three states registered in `main.ts`.

### Previous Session
- **Turnwheel / Divine Pulse implemented.** Full undo/redo system for game
  actions, faithfully ported from Python's `app/engine/turnwheel.py`. Enhanced
  `ActionLog` in `src/engine/action.ts` with turnwheel navigation: action
  groups (Move, Phase, Extra types), `doAction()` for recording, `setUp()`
  to build navigation groups, `backward()`/`forward()` for stepping through
  groups, `finalize()` to confirm rewind, `reset()` to cancel. Five marker
  actions: `MarkActionGroupStart`, `MarkActionGroupEnd`, `MarkPhase`,
  `LockTurnwheel`, `MessageAction`. New `TurnwheelState` in
  `src/engine/states/turnwheel-state.ts` (~300 lines) — transparent overlay
  with red/green tint (locked/unlocked), description text, turn counter,
  unit count, remaining uses display. Navigation via LEFT/UP (backward) and
  RIGHT/DOWN (forward), SELECT to confirm, BACK to cancel. Force mode
  prevents canceling. Deducts uses on confirm. Integration across game states:
  FreeState records `MarkActionGroupEnd` on begin and `MarkActionGroupStart`
  on unit select; MenuState records `MarkActionGroupEnd` on Wait;
  PhaseChangeState records `LockTurnwheel` + `MarkPhase` + sets first free
  action on first player turn; AIState records group start/end per AI unit;
  CombatState records `MessageAction` for combat descriptions. OptionMenuState
  shows "Turnwheel" option when `turnwheel` constant and `_turnwheel` game
  var are both set. Event commands: `enable_turnwheel`, `activate_turnwheel`
  (with force mode), `clear_turnwheel`, `stop_turnwheel_recording`,
  `start_turnwheel_recording`. `GameState.memory` Map added for inter-state
  communication.

### Previous Session
- **Fog of war system implemented.** New `src/engine/line-of-sight.ts`
  (~170 lines) porting the Bresenham line algorithm and `simpleCheck()`
  for LOS verification. `GameBoard` extended with fog of war grids
  (per-team 2D arrays of Sets), vantage points, opacity grid, fog/vision
  regions, and `previouslyVisitedTiles` for Hybrid mode. Full `inVision()`
  logic supporting player allied-team checking, non-player team checking,
  and optional `fog_los` Bresenham verification. `terrainKnown()` supports
  GBA (always known), Thracia (only in vision), and Hybrid (in vision or
  previously visited) modes. `MapView` draws fog overlay: semi-transparent
  dark for known-but-not-visible terrain, opaque black for unknown terrain,
  and filters out units not in player vision. `GameState.getCurrentFogInfo()`
  reads fog config from `levelVars`. `recalculateAllFow()` updates all
  unit vision grids. `sightRange()` added to `skill-system.ts` for
  `sight_range_bonus` and `decreasing_sight_range_bonus` skill components.
  `SkillObject.data` Map added for runtime skill state (e.g., torch
  counters). Event commands `enable_fog_of_war` and `set_fog_of_war` fully
  implemented. `FogOfWarConfig` type added to `types.ts`. Fog grids and
  opacity grid initialized during `loadLevel()` and `changeTilemap()`.

### Previous Session
- **Support system implemented.** New `src/engine/support-system.ts`
  (~500 lines) with `SupportController` class. Loads support pairs,
  ranks, constants, and affinities from DB. Tracks per-pair points,
  locked/unlocked ranks, per-chapter limits. Five affinity bonus methods
  (No Bonus, Personal, Partner's, Average, Sum). Range checking (0 =
  overlapping attack ranges, 1-98 = Manhattan, 99 = entire map).
  Growth triggers: `incrementEndTurnSupports`, `incrementEndCombatSupports`,
  `incrementEndChapterSupports`. Combat bonuses wired into `computeHit`,
  `computeDamage`, `computeCrit` via optional `game` parameter. Event
  commands: `enable_supports`, `increment_support_points`,
  `unlock_support_rank`, `disable_support_rank`. `UnitObject.affinity`
  field added. 4 new types in `data/types.ts`.

### Previous Session
- **Base screen implemented.** New `src/engine/states/base-state.ts`
  (~510 lines) with `BaseMainState` (main hub menu: Manage, Market,
  Convos, Options, Save, Continue) and `BaseConvosState` (transparent
  child menu for base conversations). `base` event command now pushes
  `base_main` state, reading `_base_bg_name`, `_base_music`,
  `_base_transparent`, `_base_market` game vars. Panorama background
  loaded async. Event commands `add_base_convo`, `ignore_base_convo`,
  `remove_base_convo`, `add_market_item`, `remove_market_item`,
  `clear_market_items` all wired. `GameState.baseConvos` and
  `GameState.marketItems` Maps added for persistence.
- **Settings menu implemented.** New `src/engine/states/settings-state.ts`
  (~621 lines) with `SettingsMenuState`. Two-tab layout (Config/Controls)
  with 14 config settings: animation mode, unit/text speed, music/sound
  volume, terrain/objective display, autocursor, autoend turn, confirm
  end, grid opacity, HP map team/cull, FPS display. Slider, bool, and
  choice option types. Settings persisted in `game.gameVars` with
  `_setting_` prefix. Volume changes apply immediately. Controls tab
  shows key bindings read-only. Accessible from OptionMenuState and
  base screen.
- **Minimap implemented.** New `src/engine/states/minimap-state.ts`
  (~355 lines) with `MinimapState` (transparent overlay) and `MiniMap`
  helper class. Renders entire tilemap at 4px/tile with terrain-type
  color coding (30+ terrain colors), team-colored unit dots, camera
  viewport indicator rectangle. 200ms rectangular iris transition on
  open/close. Scrollable viewport tracks camera position. Accessible
  from OptionMenuState "Minimap" option.
- **Victory screen implemented.** New `src/engine/states/victory-state.ts`
  (~332 lines) with `VictoryState`. Shows animated "VICTORY" banner
  (gold bar scaling + fading in) and stats panel (turn count, MVP)
  sliding up from bottom over 20 frames with ease-out easing. Map draws
  underneath with dark overlay. MVP determined by kills/damage. Triggered
  by `victory_screen` event command.
- **Credits screen implemented.** New `src/engine/states/credit-state.ts`
  (~438 lines) with `CreditState`. Vertically scrolling credit lines
  over dark background or panorama. Engine credits, web port info,
  acknowledgments. Edge-fade effect, text shadows on headers, DOWN
  speeds up scrolling. Triggered by `credits`/`credit` event command.
- **OptionMenuState expanded.** Now includes "Minimap" and "Options"
  entries alongside "End Turn". Minimap enabled when level is loaded.

### Previous Session
- **GBA-style preparation screen.** Implemented `prep` event command
  handler and three new states in `src/engine/states/prep-state.ts`:
  `PrepMainState` (main menu: Pick Units, Check Map, Fight!),
  `PrepPickUnitsState` (toggle player units on/off formation spots),
  `PrepMapState` (transparent map view with formation highlights and
  cursor navigation). Required units are auto-placed and locked.
  The `prep` event command now blocks and pushes the prep screen;
  pressing "Fight!" pops back to the event system to continue.

### Previous Session
- **Screen shake, damage numbers, and hit/crit spark animations.** Combat
  visual polish pass. `showHitSpark()` and `showCritSpark()` in
  `AnimationCombat` now spawn particle-based spark effects: hit sparks
  (8 radiating white/yellow particles), crit sparks (16-particle burst
  with white screen flash), no-damage blue ping, miss handled by popups.
  Damage popups upgraded from simple linear float to Python-faithful
  damped-sine-wave bounce physics (3 phases: 400ms bounce, 600ms pause,
  200ms fade-out drift, 1200ms total). Normal damage in red, crits in
  yellow, miss in blue-white. Spark effects rendered as canvas-drawn
  particles in `drawAnimationCombat()`.

### Previous Session
- **Combat effect system implemented.** Spell/weapon effects (arrows, fire,
  lightning, etc.) now play during GBA-style battle animations. Added
  `getEffectData()`, `getEffectFrameImages()`, `loadEffectSprites()`, and
  `hotSwapEffectFrames()` to `AnimationCombat`. `castSpell` now resolves
  effect NIDs and spawns child animations. `BattleAnimation.spawnEffect()`
  made public. New `convertSpritesheetToFrames()` and `applyColorkey()`
  in `sprite-loader.ts`. Global `__ltResources` set in `CombatState` for
  async effect loader access.

### Previous Session
- **Runtime integration bug fixes (Phase 1.1 -- all 5 items resolved).**
  - Data format edge cases: faction loading, generic unit name resolution,
    FIXED-mode auto-leveling for generic units.
  - Tilemap coord parsing: NaN/bounds guards, getTerrain returns '0' default.
  - Map sprite failures: warnings on null sprites, sprite caching.
  - Tileset manifest: defensive guards for malformed JSON.
  - State machine bootstrap: empty-stack warning, documentation.

### Previous Session
- **Group command position system rewrite.** `add_group`, `spawn_group`,
  and `move_group` now correctly implement the Python `_get_position()`
  logic: empty = group's own positions, `'starting'` = unit.startingPosition,
  `'x,y'` = literal coordinates (all units), or another group NID for
  cross-group position lookup. Placement modes (`giveup`, `stack`,
  `closest`, `push`) properly handle occupied tiles. `spawn_group` now
  spawns units at the correct map edge based on cardinal direction and
  moves them to destination positions. Fixes all chapter cutscene unit
  spawning (intro, reinforcements, bandits).
- **JavaScript-based condition evaluator fallback.** When the pattern
  matcher cannot parse a complex condition, a `Function()`-based fallback
  evaluates the expression with a Python-compatible game proxy scope.
  Supports complex chains like
  `game.level.regions.get('X').contains(game.get_unit('Y').position)`,
  `any(... for unit in game.get_units_in_party())`,
  `len(game.get_enemy_units()) == 0`, and all standard Python operators.
  Translates Python `len()`, `True/False/None`, `and/or/not`, and
  generator-expression `any()` to JavaScript equivalents. Fixes chapter 1
  enemy reinforcement conditions.
- **AI Interact behaviour for Destructible regions.** AI units with
  `PursueVillage` AI can now find and interact with Event regions matching
  `target_spec` (e.g., `Destructible`). `getTargetPositions()` searches
  level regions by `sub_nid`, evaluates region conditions. When reachable,
  returns `'interact'` action type that triggers `RegionTrigger` events
  (fires `show_layer;Ruin` to swap village to ruins). `AIState` handles
  `'interact'` actions: moves unit, triggers event, removes `only_once`
  regions, waits for event completion. Fixes village destruction in
  chapters 2 and 5.
- **Skip mode (Escape) fix.** Pressing Escape now enables skip mode
  regardless of what blocking state the event is in (not just during
  dialog). Works during `wait`, `transition`, `banner`, `location_card`,
  `chapter_title`, and between instant commands. The `update()` loop
  also checks skip mode to instantly resolve blocking UI (dialog,
  banner, wait, transition, chapter title).

### Previous Session
- **`interact_unit` scripted combat.** Full implementation of the
  `interact_unit` event command for scripted combat with forced outcomes.
  CombatScript tokens (`hit1`, `hit2`, `crit1`, `crit2`, `miss1`, `miss2`,
  `--`, `end`) control who strikes and forced hit/miss/crit results.
  `CombatPhaseSolver.resolveScripted()` processes script tokens. Script
  passed through MapCombat and AnimationCombat constructors. Supports
  both animation and map combat modes. `immediate` flag skips combat
  animation entirely, applying results instantly.
- **Shop event command and ShopState.** `shop` event command opens a full
  shop interface. ShopState supports buy and sell modes with tab switching.
  Buy mode shows available items with prices, stock tracking, and
  affordability indication. Sell mode shows unit's sellable items with
  values. Gold display, item descriptions, inventory full/out-of-stock
  messages. Shop data stored as transient fields on GameState (`shopUnit`,
  `shopItems`, `shopStock`). Money via `game.gameVars.get('money')`.
- **Map animation system.** New `src/rendering/map-animation.ts` (~170
  lines). Sprite-sheet based animations with `frame_x`, `frame_y`,
  `num_frames`, `speed`, `frame_times`, `use_frame_time` support.
  Animations loaded from `resources/animations/animations.json` manifest.
  `map_anim` / `remove_map_anim` event commands. Animations render in
  MapView at below-unit or above-unit layers. Database loads animation
  catalog via `loadMapAnimations()`.
- **9-slice menu window backgrounds.** New `src/ui/base-surf.ts` (~230
  lines). Loads 24x24 source sprite (8x8 tiles) from
  `sprites/menus/menu_bg_base.png`. Creates arbitrarily-sized window
  backgrounds with proper corner/edge/center tiling. Integrated into
  ChoiceMenu via `getMenuBackgroundSync()`.
- **Icon rendering system.** New `src/ui/icons.ts` (~150 lines). Loads
  16x16 and 32x32 icon sheets from `resources/icons16/` and
  `resources/icons32/`. `drawItemIcon()` renders item icons by
  `icon_nid` and `icon_index` ([x, y] grid coords). Integrated into
  shop buy and sell menus.
- **Bitmap font rendering system.** New `src/rendering/bmp-font.ts`
  (~530 lines). Loads all 23 font variants from `resources/fonts/`
  (`.png` spritesheets + `.idx` character maps). `BmpFont` class
  supports: variable-width glyphs, stacked rendering (chapter/label
  fonts), `allUppercase`/`allLowercase` transforms, `spaceOffset`.
  Color palette variants generated via pixel-level color conversion
  (19 colors for text/small/narrow fonts). `Surface.drawText()` auto-
  routes to BMP fonts via callback pattern (avoids circular deps).
  CSS font sizes mapped to BMP font NIDs (<=7px -> small, else text).
  CSS colors mapped to palette names. Dialog word-wrap uses BMP font
  width measurement for accurate line breaks.
- **Event command gap analysis and fixes.**
  - Added `s` alias for `speak` (fixes 173 broken support conversation
    dialogue lines).
  - Added `bop` alias for `bop_portrait`.
  - Fixed `change_music` phase variant: now correctly reads `args[1]`
    as music NID when `args[0]` is a phase type (player_phase, etc.).
  - Implemented `change_tilemap` event command: swaps the level's
    tilemap mid-event, saves unit positions, rebuilds game board,
    resets cursor/camera. Used for cutscene backdrop changes.
  - Added `prep` and `base` stubs (skip to proceed).
  - Added overworld command stubs (`toggle_narration_mode`,
    `overworld_cinematic`, `reveal_overworld_node/road`,
    `overworld_move_unit`, `set_overworld_position`).
  - Added arena/overlay/advanced stubs (`draw_overlay_sprite`,
    `table`, `textbox`, `set_wexp`, `resurrect`, `autolevel_to`,
    `add_lore`, `add_base_convo`, `enable_fog_of_war`, `set_fog_of_war`).
- **Critical gameplay bug fixes (chapters 0-2).**
  - `{unit}` / `{unit2}` template variable substitution now applies to
    ALL event command args (was only `shop`). Fixes village rewards, house
    visits, unlock, portrait loading, has_visited across all chapters.
  - `move_cursor` / `center_cursor` / `flicker_cursor` now resolve unit
    NIDs to positions (e.g., `move_cursor;Eirika` finds Eirika's tile).
    Fixes camera choreography in all chapter cutscenes.
  - `check_alive()` added to condition evaluator (opposite of
    `check_dead()`). Fixes Garcia/Ross chapter 2 outro recruit branch.
  - Dialog `{clear}` tag: clears text box and waits for input, then
    continues typing. Fixes multi-page dialog in chapter 1/2 outros.
  - Dialog `{c:...}` inline command tags skipped gracefully (no more
    literal `{c:expression;...}` rendered as text).
  - Dialog `{p}` pause tag handled; unknown `{tags}` silently skipped.
  - `transition` command now supports custom duration and color params
    (`transition;Close;750;248,248,248` for white fades).
  - `move_unit` with no position falls back to `startingPosition`.
  - New `resolvePosition()` helper resolves "x,y" coords OR unit NIDs.

### Previous Session
- **Autotile animation system.** Tilesets with animated water/lava tiles
  now animate at runtime. `LayerObject.buildSurface()` identifies autotile
  positions from `TilesetData.autotiles` dict, builds 16 pre-rendered
  frame surfaces per layer. `TileMapObject.updateAutotiles()` cycles
  frames based on `autotile_fps` timing. Composited in `getFullImage()`
  and `getForegroundImage()`. Autotile images loaded in
  `GameState.loadLevel()` from `{tileset}_autotiles.png`.
- **Weather particle system.** New `src/rendering/weather.ts` (~240 lines)
  with `WeatherSystem` class. 7 weather types: rain (blue streaks), snow
  (drifting white flakes), sand (horizontal tan particles), light (fading
  golden motes), dark (same motes), night (blue overlay), sunset (warm
  overlay). Particles are canvas-drawn shapes (no sprite loading). System
  pre-fills 300 frames on creation so particles don't gradually appear.
  `TileMapObject.addWeather()`/`removeWeather()` manage active systems.
  Weather renders in MapView after foreground/cursor layers.
  `add_weather`/`remove_weather` event commands implemented.
- **`load_unit` event command.** Loads a unique unit from DB into memory
  without placing on the map. Looks up unit prefab, creates UnitObject
  from prefab data (stats, items, skills), and registers in
  `game.allUnits`. Supports level override argument.
- **`make_generic` event command.** Fabricates a generic unit from
  class/level/team without placing on map. Creates a UnitObject with
  class-derived stats, assigns to specified team, registers in
  `game.allUnits`.
- **Equation evaluator improvements.** Now supports Python ternary
  expressions (`X if COND else Y`) and `'Tag' in unit.tags` within
  stat equations (needed for `RESCUE_AID` and similar conditional
  formulas). New `evaluateEquationCondition()` helper.
- **Condition evaluator improvements.** Added support for: `'X' in
  unit.tags`, `'X' not in unit.tags`, `has_item()`, `has_skill()`,
  `v()` variable lookup, `unit.can_unlock(region)`,
  `any_unit_in_region()`, `is_dead()`.

### Previous Session
- **Fix region type matching in action menu.** The action menu was
  checking `region_type` against hardcoded strings like 'village',
  'visit', 'shop', 'seize' — but actual level data uses
  `region_type: 'event'` with `sub_nid: 'Visit'`, `'Seize'`, etc.
  Now correctly checks `region_type === 'event'` and uses `sub_nid`
  as the menu label. Evaluates region conditions. Supports any sub_nid
  (Visit, Seize, Shop, Armory, Chest, Door, Escape, Secret, etc.).
  Also removes `only_once` regions after triggering.
- **RegionData interface expanded.** Added `time_left`, `only_once`,
  `interrupt_move`, `hide_time` fields to match Python. All fields
  present in actual level JSON data.
- **`add_region` event command implemented.** Creates new RegionData
  and pushes to `game.currentLevel.regions`. Parses NID, position,
  size, region type, sub_nid, time_left, and flags (only_once,
  interrupt_move). Checks for duplicate NIDs.
- **`region_condition` event command implemented.** Updates a region's
  condition expression string by NID.
- **Screen shake system.** Camera now supports shake effects with 5
  pattern types: default (gentle vertical), combat (diagonal), kill
  (violent), random (16 random offsets ±4), celeste (subtle ±1).
  Shake offsets applied in `getOffset()`. Duration-based auto-reset.
  `screen_shake` command blocks by default, `no_block` flag available.
  `screen_shake_end` immediately resets shake.
- **Alert command fixed.** Duration changed from 1500ms to 3000ms
  (matching Python's `time_to_wait`). After 300ms (`time_to_pause`),
  any input dismisses the alert early. Previously no input handling
  during alert display.
- **Seize win-condition fix.** Now checks `region_type === 'event'`
  with `sub_nid === 'Seize'` (was checking `region_type === 'seize'`).
  Also iterates all tiles in multi-tile regions (was only checking
  top-left corner).

### Previous Session
- **Enemy threat zones.** Press INFO (C/Shift) on an empty tile to
  toggle all-enemy threat range overlay (magenta/purple). Press SELECT
  on an enemy unit to show that unit's individual move (blue) and attack
  (red) ranges. Press INFO on an enemy to show their range. Computed
  using PathSystem.getValidMoves + getAttackPositions for each enemy.
  New `'threat'` highlight type added to HighlightManager.
- **Chibi portrait in HUD.** Unit info panel now shows the unit's 32x32
  chibi portrait (extracted from sprite sheet at position 96,16) to the
  left of the name/stats. Portraits loaded asynchronously via
  ResourceManager and cached per portrait NID. HUD text shifts right
  when portrait is displayed.
- **Combat UI moved to bottom of screen.** Animation combat name tags
  and HP bars now anchor to bottom-left/right of the game surface,
  just above the EXP bar. HUD (unit info + terrain) stays at top.
  Prevents overlap between HUD and combat UI elements.
- **UI zoom-aware positioning.** Portraits and dialog boxes now use
  `viewport.width`/`viewport.height` instead of hardcoded 240x160.
  Screen positions for portraits recalculated dynamically on each
  `parseScreenPosition()` call. Dialog anchors correctly at viewport
  bottom regardless of zoom level.
- **Gameplay speed improvements:**
  - Unit movement: 6 → 10 tiles/sec
  - AI delay between actions: 250ms → 100ms (16ms when holding SELECT)
  - Combat strike cycle: ~40% faster (init 150ms, strike 130ms, HP drain 250ms)
  - Phase banner: 1500ms → 1000ms
  - Death fade: 500ms → 350ms, EXP fill: 500ms → 350ms, level-up: 1500ms → 1200ms
  - SELECT (Enter/Z) fast-forwards: combat at 3x, EXP/level-up at 4x, AI at instant
- **Fix reinforcements not spawning.** `game.turnCount` was stuck at 1
  because it was never synced from `game.phase.turnCount` after phase
  advances. Now synced in TurnChangeState.begin(). This fixes ALL
  turn-conditioned events (reinforcements, AI changes, etc.) for every
  chapter.
- **portraitNid field on UnitObject.** Copied from `UnitPrefab.portrait_nid`
  at construction time, enabling portrait lookup without database access.

### Previous Session
- **Dialog text word-wrapping.** Dialog boxes now word-wrap text to fit
  within the box width. Uses Canvas `measureText()` for accurate pixel
  width measurement. Box height auto-sizes based on number of wrapped
  lines. Fixes text overflow in both portrait speech bubbles (120px) and
  full-width bottom bars (236px).
- **`change_background` event command.** Loads panorama images from
  `resources/panoramas/` and displays them as full-screen backgrounds
  behind portraits during dialogue scenes. Supports `keep_portraits`
  flag (default clears portraits on background change). 45 uses across
  chapters 0-4. Background drawn on top of map, behind portraits.
- **`chapter_title` event command.** Full-screen chapter title overlay
  with fade-in (1s), hold (3s), fade-out (1s) animation. Gold banner
  bar with chapter name text. Skippable via SELECT/BACK. Disables
  skip mode so players see the title.
- **`location_card` event command.** Small translucent brown card in
  the upper-left corner showing location text. Fades in (200ms), holds
  (2s), fades out (200ms). Blocks event processing during display.
- **`has_visited` event command.** Marks a unit as having completed
  their action (sets `hasTraded` or `hasAttacked` flag). Units without
  Canto are marked as finished. Supports `attacked` flag.
- **`unlock` event command.** Simplified unlock that finds the first
  key/lockpick item in the unit's inventory and decrements its uses.
  Broken items are removed from inventory.
- **`interact_unit` event command.** Stubbed (logs warning) — scripted
  combat with forced outcomes is complex and deferred.
- **`load_unit` / `make_generic` fully implemented.** `load_unit` loads
  unique units from DB into memory (stats, items, skills). `make_generic`
  fabricates generic units from class/level/team. Both register into
  `game.allUnits` without placing on map.
- **Foreground tilemap layers verified.** Already fully implemented in
  both `TileMapObject` and `MapView` — no changes needed.
- **`set_tile` command removed from plan.** Does not exist in the
  original Python engine. Terrain changes use `show_layer`/`hide_layer`.

### Previous Session
- **AI item use (healing items and staves).** AI units with `Support`
  behavior now use `supportPrimaryAI()` to evaluate all healing items
  (staves and consumables) against injured allies. Implements the Python
  `Heal.ai_priority()` formula: `help_term * heal_term` where help_term
  is missing health fraction and heal_term is effective heal fraction.
  Staves go through the combat system (`'attack'` action); consumables
  (Vulnerary, Elixir) use a new `'use_item'` action type that applies
  healing directly. Self-targeting for consumables uses a "safest position"
  heuristic (farthest from enemies). SecondaryAI for Support now weights
  by injury severity (weight 100) over distance (weight 60), matching
  Python behavior. Items with `no_ai` component are skipped.
  New `ItemObject` methods: `isSpell()`, `isUsable()`, `targetsAllies()`,
  `hasNoAI()`, `canHeal()`. `getHealAmount()` now accepts optional caster
  MAG for staff equation estimation. `getMaxItemRange()` now includes
  spells/staves for proper view range calculations.
- **Portraits in dialog.** Full portrait system ported from Python:
  - New `EventPortrait` class (`event-portrait.ts`, ~430 lines) with
    sprite sheet compositing (main face + mouth frames + eye blink),
    automatic blinking, talking animation (randomized mouth state machine),
    transitions (fade in/out + slide), movement, bop, mirroring,
    saturation, and expression system (Smile, CloseEyes, Wink, etc.).
  - New `screen-positions.ts` (~100 lines) resolving named positions
    (Left, Right, MidLeft, CenterRight, etc.) to pixel coordinates
    with auto-mirror for left-side portraits.
  - Portrait metadata loaded from `portraits.json` (blinking_offset,
    smiling_offset) via Database. `PortraitPrefab` type added.
  - All 9 portrait event commands implemented: `add_portrait`,
    `multi_add_portrait`, `remove_portrait`, `multi_remove_portrait`,
    `remove_all_portraits`, `move_portrait`, `bop_portrait`,
    `mirror_portrait`, `expression`.
  - `speak` command now looks up speaker's portrait, starts talking
    animation, and passes portrait to Dialog for positioning.
  - Dialog draws as speech bubble above portrait with tail pointer,
    or full-width bar at bottom when no portrait is active.
  - Portrait NID resolution: tries `unit.portrait_nid` first, then
    direct NID lookup in `RESOURCES.portraits`.
- **Cursor sprite.** Replaced the pulsing rectangle with the actual
  128x128 cursor sprite sheet. 3-frame back-and-forth bounce animation
  matching Python's `GenericAnimCounter`. Loaded eagerly at game init.
- **AGENTS.md updated** with reference codebase section pointing to
  `lt-maker/` directory and `lt-maker/AGENTS.md` technical reference.

### Previous Session
- **Terrain avoid/defense now applied in combat.** Extracted shared
  `terrain-bonuses.ts` utility. `avoid()` and `defense()` in combat-calcs
  now accept an optional `board` parameter and add terrain bonuses from
  the terrain's status skill. Threaded through CombatPhaseSolver,
  MapCombat, AnimationCombat, and AIController.
- **HUD moved to top of screen.** Unit info panel (top-left) and terrain
  info panel (top-right) no longer overlap with dialogue boxes at bottom.
- **Skip-all-dialogue.** Pressing BACK (X/Escape) during a dialog now
  enables "skip mode" which auto-advances through all remaining speak,
  narrate, wait, alert, and transition commands in the current event.
  Non-dialogue commands (unit spawns, variable changes, etc.) still execute.
- **Battle music transitions.** AudioManager now has a music stack
  (`pushMusic`/`popMusic`). CombatState plays `player_battle` or
  `enemy_battle` music when combat begins and restores phase music
  when combat ends. Uses `LevelMusic.player_battle`/`enemy_battle`
  fields that were previously defined but unused.
- **Enemy grey-out fix.** Units from non-active teams no longer appear
  greyed out. The `finished` flag is now scoped to the current phase
  team in `collectVisibleUnits()`, `UnitRenderer`, and `MapView`.
- **Event system expansion (~40 commands).** Implemented: visual
  transitions (fade to/from black), for-loops with variable iteration,
  camera/cursor control, objective changes, money/bexp, talk pair
  management, end_turn, music_fade_back/music_clear, choice menus,
  unit property modifications (set_name, equip_item, set_stats,
  change_class, etc.), remove_all_enemies/units, region removal,
  tilemap layer show/hide, modify_game_var/level_var.
- **For-loop execution.** `for;varName;val1,val2,...` / `endf` now
  correctly iterates with a loop stack, setting game vars per iteration.
- **Transition fade.** `transition;close` fades to black (500ms),
  `transition;open` fades from black. Black screen is held between
  close/open for event commands that run while hidden.
- **Runtime bug fixes.**
  - Level loading screen stays visible during async load (moved
    `state.clear()` into `.then()` callback).
  - `add_group` spawning falls back to `db.units` when unit NID not
    found in level data.
  - `teams.json` alliances defaults to `[]` to prevent crash on
    malformed data.
- **AI group activation.** `GameState.activeAiGroups` tracks which
  groups are active. Groups activate when a player unit moves within
  detection range (move + weapon range) of any group member, or when
  any group member is attacked. `AIState` skips units in inactive groups.
  `AIController.checkGroupActivation()` and `activateGroupOnCombat()`
  methods added.
- **Unit HP bar overlays.** Small color-coded HP bars (green/yellow/red)
  rendered below each unit on the map. `collectVisibleUnits()` now
  passes `currentHp`/`maxHp` to the renderer.
- **Tilemap layer visibility.** `TileMapObject.showLayer()`/`hideLayer()`
  for event-driven layer toggling.
- **EventManager talk pairs.** `addTalkPair()`/`removeTalkPair()`/
  `hasTalkPair()` for dynamic talk event management.

### Previous Session
- Component dispatch wired into combat (`item-system.ts`, `skill-system.ts`).
- Vantage/desperation/miracle in combat solver.
- AI system overhaul (all view_range modes, target_spec, guard, defend, retreat).
- UnitObject.startingPosition and aiGroup fields.

### Earlier Session
- GBA-style combat animations (920 + 763 lines).
- Enemy team colors via palette swapping.
- Level select screen.
- Terrain AVO display, mobile UI / responsive viewport.
- Combat animation fixes.

### Earlier Sessions
- Fixed AI combat animations (push CombatState, not synchronous loop).
- Fixed unit stats double-counting, weapon triangle sign bug.
- Expanded event system to ~100+ commands with alias resolution.
- Dynamic render resolution, full mouse controls, turn state flow fixes.

---

## Phase 0 -- Foundation (DONE)

Everything in this phase compiles and is wired together end-to-end.

- [x] Vite + TypeScript project scaffold
- [x] `Surface` -- OffscreenCanvas wrapper replacing Pygame surfaces
- [x] `InputManager` -- keyboard, mouse, touch, gamepad
- [x] `StateMachine` -- stack-based with deferred transitions and transparency
- [x] `State` / `MapState` base classes
- [x] `Camera` -- smooth scrolling, tile focus, map bounds clamping
- [x] `Cursor` -- tile-grid cursor with smooth visual interpolation
- [x] `ResourceManager` -- HTTP asset loader for `.ltproj` static files
- [x] `Database` -- loads all game data (chunked + non-chunked JSON)
- [x] `data/types.ts` -- TypeScript interfaces for every LT data format
- [x] `TileMapObject` / `LayerObject` -- multi-layer tilemap with pre-rendered surfaces
- [x] `MapView` -- rendering pipeline (tilemap, highlights, units, cursor, grid)
- [x] `HighlightManager` -- colored tile overlays (move, attack, spell, selected)
- [x] `MapSprite` -- unit map sprite animation (stand/move sheets, directional frames)
- [x] `UnitRenderer` -- sprite management and depth-sorted unit drawing
- [x] `UnitObject`, `ItemObject`, `SkillObject` -- runtime game objects
- [x] `GameBoard` -- spatial grid with terrain, unit tracking, movement costs
- [x] `Dijkstra` + `AStar` pathfinding with MinHeap
- [x] `PathSystem` -- high-level API (valid moves, attack positions, paths)
- [x] `MovementSystem` -- animated unit path traversal
- [x] `PhaseController` -- turn/phase cycling with team skip logic
- [x] `ActionLog` + concrete `Action` classes (Move, Damage, Heal, Wait, etc.)
- [x] `CombatCalcs` -- hit, damage, crit, avoid, attack speed, doubling, weapon triangle
- [x] `CombatPhaseSolver` -- strike sequencing (attacker, counter, double, brave)
- [x] `MapCombat` -- visual combat controller with HP drain animation
- [x] `AIController` -- primary (attack utility) and secondary (move toward) behaviors
- [x] `EventManager` + `GameEvent` -- scripted events with semicolon-delimited commands
- [x] `AudioManager` -- Web Audio API (music crossfade, SFX, format fallback)
- [x] `ChoiceMenu`, `HUD`, `HealthBar`, `Dialog`, `Banner` -- UI components
- [x] `GameState` singleton -- subsystem hub and level loader
- [x] 11 game states (Title, Free, Move, Menu, Targeting, Combat, AI, TurnChange, PhaseChange, Movement, Event)
- [x] `main.ts` -- bootstrap, canvas scaling, 60 fps game loop

---

## Phase 1 -- Make It Playable

These items are needed to play through a single chapter of the default
Sacred Stones project end-to-end without crashes. Roughly ordered by
priority.

### 1.1 Runtime Integration Bugs

The engine compiles but has not been tested against live data yet.
Expect issues in all of the following areas:

- [x] **Data format edge cases.** The LT data has `UniqueUnitData` vs
  `GenericUnitData` discrimination that relies on the presence of a `klass`
  field. Verify this works for every unit in every level of `default.ltproj`.
  Some levels use `unit_groups` for reinforcements -- these are not spawned
  yet.
- [x] **Tilemap sprite grid coordinate parsing.** LT stores tile coordinates
  as `"x,y"` string keys. Verify our parsing handles edge cases (negative
  coords, large maps, missing entries).
- [x] **Map sprite loading failures.** Some classes may not have matching
  `<Name>-stand.png` / `<Name>-move.png` files. The engine silently sets
  `sprite = null` but the renderer must handle this gracefully with
  placeholders everywhere (verify `UnitRenderer.drawPlaceholder`).
- [x] **Tileset manifest loading.** `tilesets.json` in the original uses a
  list of objects. Verify our `Database.loadTilesets` correctly parses the
  actual format.
- [x] **State machine first-frame bootstrap.** The `TitleState` is pushed via
  `game.state.change('title')` before the first `update()` call. Verify
  `processTempState` handles this correctly on frame 1.

### 1.2 Core Gameplay (DONE)

- [x] **Unit abilities / action menu options.** MenuState now dynamically
  builds options: Attack, Item, Trade, Rescue, Drop, Visit, Shop, Seize,
  Talk, Wait — each with proper targeting/eligibility checks.
  New states: `ItemUseState`, `TradeState`, `RescueState`, `DropState`.
- [x] **Item use during gameplay.** Healing items and stat boosters can
  be selected and used from the Item menu. Uses are decremented, broken
  items are removed from inventory.
- [x] **Trading.** Adjacent allied units can swap items via the TradeState.
  Simplified swap UI (first item exchange).
- [x] **Rescue / Drop.** Units can rescue adjacent allies (removes from
  board, sets carry references). Drop places rescued unit on an adjacent
  empty tile. `rescuing`/`rescuedBy` properties on UnitObject.
- [x] **Talk events.** Menu checks EventManager for `unit_talk` triggers
  between adjacent unit pairs and shows Talk option when available.
- [x] **Region interactions.** Visit, Shop, Seize — the menu checks
  `currentLevel.regions` for matching region types at the unit's position.
  Seize immediately checks win condition. Visit/Shop trigger region events.
- [x] **Status effects / upkeep.** `StatusEffect` interface with stat mods,
  DOT damage, immobilize, stun, and duration. `UnitObject.processStatusEffects()`
  called during `PhaseChangeState`. DOT deaths are handled. Units with stun
  cannot act.
- [x] **Death handling.** CombatState now has a 500ms death fade-out phase.
  Dead units are removed from the board. Win/loss conditions are checked
  after every combat (player and AI). AI combat also checks conditions.
- [x] **Experience and level-up.** `UnitObject.levelUp()` performs growth-based
  stat rolls with max stat caps from the class. `MapCombat.applyResults()`
  returns detailed results including `levelUps` stat gain records.
  CombatState shows animated EXP bar (500ms) and level-up stat display (1500ms).
  Supports 'random' and 'fixed' growth modes.
- [x] **Win/loss conditions.** `GameState.checkWinCondition()` and
  `checkLossCondition()` evaluate level objectives: Rout, Defeat Boss,
  Seize, Survive X turns, specific unit death, Lord death.
- [x] **Canto (move after attacking).** Units with `hasCanto` (from skills
  with 'canto' component) are not marked finished after combat and re-enter
  MoveState for remaining movement.
- [x] **Weapon uses.** Weapons lose 1 use per combat. Broken weapons are
  removed from inventory. Both attacker and defender weapons are tracked.
- [x] **Droppable items.** Items marked as droppable in starting_items are
  tracked via `ItemObject.droppable`. Detected in combat results for
  future item-drop-on-death handling.
- [x] **Skill loading.** Starting skills are now equipped from `learned_skills`
  (level-gated) during unit spawning. Generic unit `starting_skills` are
  also loaded. Canto skill detection is automatic.

### 1.3 AI Improvements

- [x] **AI group support.** Groups of enemies that activate together when a
  player unit enters detection range or a group member is attacked.
  `GameState.activeAiGroups` tracks activation state. `AIController` has
  `checkGroupActivation()` and `activateGroupOnCombat()`. `AIState` skips
  units in inactive groups.
- [x] **AI item use.** AI units using healing items or staves. Full
  `supportPrimaryAI()` with heal priority evaluation, self-heal for
  consumables, `'use_item'` action type in AIState.
- [x] **AI view range guard mode.** `view_range = -1` restricts valid moves
  to current position only. All view_range modes (-4 through positive) now
  correctly implemented.
- [x] **AI retreat / smart positioning.** `Move_away_from` behavior and
  `smart_retreat()` implemented — maximizes minimum distance from threats.
- [x] **AI target/target_spec filtering.** Tag, Class, Name, ID, Team
  filtering with `invert_targeting` support. Behaviour iteration with
  per-behaviour primary -> secondary fallback.
- [x] **Defend AI.** `Move_to` Position/Starting returns unit to
  `startingPosition` when no enemies in range.

### 1.4 Event System Expansion

The current event system handles `speak`, `wait`, `move_unit`,
`remove_unit`. The original has ~60 event commands. Priority commands to
add:

- [x] `transition` (open/close, fade to black and back with 500ms animation)
- [x] `add_unit` / `create_unit` (spawn units during events)
- [x] `give_item` / `remove_item`
- [x] `give_money` / `give_exp`
- [x] `change_team` (defection / recruitment)
- [x] `set_game_var` / `inc_game_var` / `modify_game_var`
- [x] `change_objective` / `change_objective_win` / `change_objective_loss`
- [x] `add_portrait` / `remove_portrait` (full portrait system with compositing,
  expressions, blinking, talking animation, transitions, movement, bop)
- [x] `music` / `sound` / `music_fade_back` / `music_clear`
- [x] `win_game` / `lose_game`
- [x] `if` / `elif` / `else` / `end` (flow control with condition evaluator)
- [x] `for` / `endf` loop (iterates over comma-separated values)
  - [x] `set_tile` — N/A (does not exist in original engine; use show_layer/hide_layer)
- [x] `add_region` (creates RegionData with position, size, type, sub_nid, flags)
- [x] `remove_region`
- [x] `region_condition` (updates region condition expression)
- [x] `camera` control (`center_cursor`, `move_cursor`, `disp_cursor`, `flicker_cursor`)
  - [x] `map_anim` / `remove_map_anim` (sprite-sheet animations at map positions)
- [x] `choice` / `unchoice` (branching dialogue menus)
- [x] `show_layer` / `hide_layer` (tilemap layer toggling)
- [x] `add_talk` / `remove_talk` (dynamic talk pair management)
- [x] `end_turn` (force turn change from events)
- [x] Unit modifications: `set_name`, `equip_item`, `set_stats`, `set_exp`,
  `change_class`, `has_traded`, `set_current_mana`
- [x] `remove_all_enemies` / `remove_all_units`
- [x] `add_group` / `spawn_group` / `remove_group` / `move_group`
- [x] `change_background` (panorama loading, keep_portraits flag, remove on empty)
- [x] `chapter_title` (full-screen overlay with fade animation, skippable)
- [x] `location_card` (translucent upper-left card with fade animation)
- [x] `has_visited` (marks unit action state, handles Canto)
- [x] `unlock` (simplified: finds key item, decrements uses)
- [x] `load_unit` (loads unique unit from DB into memory, stats/items/skills)
- [x] `make_generic` (fabricates generic unit from class/level/team)
- [x] `add_weather` / `remove_weather` (weather particle effects on map)
- [x] `screen_shake` / `screen_shake_end` (5 shake patterns, blocking/non-blocking)
- [x] `interact_unit` (scripted combat with forced outcomes, CombatScript tokens, immediate mode)
- [x] `shop` (full shop interface: buy/sell with stock, gold tracking, item icons)
- [x] `change_tilemap` (swaps tilemap mid-event, saves/restores unit positions, rebuilds board)
- [x] `s` / `bop` aliases (speak short alias for support convos, bop_portrait alias)
- [x] `prep` (GBA-style prep screen: Pick Units, Check Map, Fight!)

Original: `app/events/event_commands.py`, `app/events/event_functions.py`

---

## Phase 2 -- Visual Polish

### 2.1 Rendering

- [x] **Autotile animation.** LayerObject builds 16 autotile frame surfaces
  from `TilesetData.autotiles` dict. TileMapObject.updateAutotiles() cycles
  frames based on `autotile_fps` timing. Composited in getFullImage/
  getForegroundImage. Autotile images loaded from `{tileset}_autotiles.png`.
  - Original: `app/engine/objects/tilemap.py` (lines 127-148)
- [x] **Foreground tilemap layers.** Layers marked `foreground: true` draw
  on top of units. `TileMapObject.getForegroundImage()` composites visible
  foreground layers, drawn in `MapView.draw()` step 5 (after units, before cursor).
- [x] **Weather particles.** WeatherSystem class with 7 weather types (rain,
  snow, sand, light, dark, night, sunset). Canvas-drawn particles, no sprite
  loading. TileMapObject.addWeather/removeWeather methods. Rendered in MapView
  after foreground. `add_weather`/`remove_weather` event commands.
  - Original: `app/engine/particles.py`
- [x] **Map animations.** Spritesheet-based animations played at map
  positions. New `src/rendering/map-animation.ts` (~170 lines). Loaded from
  `resources/animations/animations.json`. `map_anim`/`remove_map_anim` event
  commands. Below-unit and above-unit rendering layers in MapView.
  - Original: `app/engine/animations.py`
- [x] **Unit sprite palette swap.** Team color conversion (blue -> red, etc.)
  by remapping palette colors on the map sprites. 4 default palettes
  (blue/red/green/purple) loaded from team definitions.
  - Original: `app/engine/unit_sprite.py`, `app/engine/image_mods.py` (color_convert)
- [x] **Unit HP bar overlays.** Color-coded HP bars (green/yellow/red)
  rendered below each unit on the map. Still needed: rescue icon, status
  effect icons, movement arrows.
  - Original: `app/engine/unit_sprite.py` (draw_hp, draw_rescue_icon, etc.)
- [x] **Enemy threat zones.** INFO on empty tile toggles all-enemy attack
  range overlay (magenta). SELECT/INFO on enemy shows individual range.
  Computed via PathSystem per enemy unit. New `'threat'` highlight type.
  - Original: `app/engine/boundary.py`
- [x] **Cursor sprite.** Uses the actual 128x128 cursor sprite sheet
  (`sprites/cursor.png`) with 32x32 frames. 3-frame back-and-forth
  bounce animation (timing [20,2,8,2] = ~533ms cycle) matching the
  Python `GenericAnimCounter`. Centered on tile with 8px overhang.
  Falls back to rectangle outline if sprite fails to load.
- [x] **Menu window backgrounds.** 9-slice window system (`src/ui/base-surf.ts`,
  ~230 lines). Loads 24x24 source sprite, creates arbitrarily-sized windows
  with corner/edge/center tiling. Integrated into ChoiceMenu.
  - Original: `app/engine/base_surf.py`
- [x] **Portraits in dialog.** Full portrait system: `EventPortrait` class
  with sprite sheet compositing, blinking, talking, expressions, transitions,
  movement, bop, mirroring. All 9 portrait event commands implemented.
  Dialog positions as speech bubble relative to portrait.
  - Original: `app/events/event_portrait.py`
- [x] **Bitmap font rendering.** New `src/rendering/bmp-font.ts` (~530 lines).
  Loads all 23 font variants from `resources/fonts/` (PNG spritesheets +
  `.idx` character maps). Supports variable-width glyphs, color palette
  variants (19 colors for text/small/narrow), stacked rendering (chapter/
  label), allUppercase/allLowercase transforms. `Surface.drawText()` auto-
  routes to BMP fonts when loaded, with transparent fallback to Canvas
  `fillText`. Dialog word-wrap uses BMP font width measurement.
  - Original: `app/engine/bmpfont.py`, `app/engine/fonts.py`
- [x] **Icon rendering.** New `src/ui/icons.ts` (~150 lines). Loads 16x16 and
  32x32 icon sheets from `resources/icons16/` and `resources/icons32/`.
  `drawItemIcon()` renders item icons by `icon_nid` and `icon_index`.
  Integrated into shop buy/sell menus.
  - Original: `app/engine/icons.py`

### 2.2 Combat Animations (MOSTLY DONE)

Full GBA-style battle animation system — LT's flagship feature.
Implemented in ~2,600 lines across 5 files: `animation-combat.ts` (920),
`battle-animation.ts` (763), `sprite-loader.ts` (380),
`combat-anim-loader.ts` (342), `battle-anim-types.ts` (162).

- [x] **Battle animation data loading.** Loads `combat_anims.json` and
  `combat_effects.json`. Spritesheet PNGs loaded via ResourceManager with
  colorkey `(128,160,128)` and palette conversion `(0,x,y)` -> target RGB.
- [x] **BattleAnimation controller.** Frame-by-frame pose playback with
  `frame`, `wait`, `start_hit`, `wait_for_hit` commands. States: `inert`,
  `run`, `wait`, `dying`, `leaving`. Pose fallback chain, looping idle.
- [x] **AnimationCombat state machine.** Scene coordinator with left/right
  assignment, entrance animations, combat phases, HP drain, death handling.
- [x] **Combat scene rendering.** Terrain-specific panorama backgrounds,
  platform images (melee/ranged variants), sprite layering, HP bars.
- [x] **Weapon animation resolution.** Maps item weapon type to anim NID
  with fallbacks. `selectWeaponAnim()` in `sprite-loader.ts`.
- [x] **Wire into CombatState.** Auto-detects if both units have anims,
  falls back to MapCombat. Async sprite hot-swap during scene.
- [x] **Viewbox iris transition.** Rectangular iris that converges
  asymmetrically toward the defender's screen-relative tile position on
  combat entry (250ms) and expands back on exit. Uses the exact Python
  `build_viewbox` algorithm with camera-relative coordinates. Dark overlay
  at 75% opacity punched out around the iris window.
  - Original: `app/engine/combat/animation_combat.py` (build_viewbox)
- [x] **Combat effect system.** Spell/weapon effects (arrows, fire,
  lightning, etc.) now load and play during GBA-style battle animations.
  `AnimationCombat` implements `getEffectData()` and `getEffectFrameImages()`
  so `BattleAnimation.spawnEffect()` can find and render effects. Effect
  spritesheets are loaded asynchronously with palette conversion and
  hot-swapped into running animations. `castSpell` resolves effect NIDs
  and spawns child `BattleAnimation` instances. New
  `convertSpritesheetToFrames()` in `sprite-loader.ts` handles effect
  spritesheet extraction with colorkey/palette support.
- [x] **Screen shake, damage numbers, hit/crit sparks.** Spark effects
  (hit/crit/noDamage) with canvas-drawn particles. Bounce-physics damage
  numbers with damped sine wave (3-phase: bounce, pause, fade). Duration
  increased to 1200ms. Normal damage red, crit yellow, miss blue-white.

---

## Phase 3 -- Full Feature Parity

### 3.1 Game Screens

- [x] **Title screen.** Two-state title: `TitleStartState` (panorama
  background from `resources/panoramas/title_background.png`, pulsing
  "Press Start" prompt, title music) and `TitleMainState` (sliding menu
  panel with New Game / Extras options, cursor navigation, highlight bar).
  - Original: `app/engine/title_screen.py`
- [x] **Prep screen (GBA-style).** Three states in `prep-state.ts`:
  `PrepMainState` (main menu: Pick Units, Check Map, Fight!),
  `PrepPickUnitsState` (scrollable unit list with deploy toggle),
  `PrepMapState` (transparent map view with formation highlights).
  Required units auto-placed and locked. Validates minimum deployment.
  - Original: `app/engine/prep.py`, `app/engine/prep_gba.py`
- [x] **Base screen.** Two states in `base-state.ts`: `BaseMainState`
  (hub menu: Manage, Market, Convos, Options, Save, Continue) and
  `BaseConvosState` (transparent convo sub-menu). Panorama background,
  music, dynamic menu options. Event commands: `add_base_convo`,
  `ignore_base_convo`, `remove_base_convo`, `add_market_item`,
  `remove_market_item`, `clear_market_items`. Still missing: supports,
  codex, BEXP, sound room, achievements, library/guide sub-screens.
  - Original: `app/engine/base.py`
- [x] **Info/status menu (basic).** Three-page unit info screen: personal
  data (stats, class, level), equipment (items, battle stats), skills
  (weapon exp, skill list). 621 lines in `info-menu-state.ts`. Still
  missing: growth rates display, support list, weapon rank letters.
  - Original: `app/engine/info_menu/`
- [x] **Settings menu.** Two-tab Config/Controls menu in
  `settings-state.ts` (~621 lines). 14 config settings (animation,
  speed, volume, display, gameplay). Slider/bool/choice types. Settings
  stored in gameVars with `_setting_` prefix, volume changes immediate.
  - Original: `app/engine/settings_menu.py`, `app/engine/config.py`
- [x] **Minimap.** `minimap-state.ts` (~355 lines). Renders full tilemap
  at 4px/tile with 30+ terrain colors, team-colored unit dots, camera
  viewport indicator. 200ms iris transition. Scrollable. Accessible from
  OptionMenuState.
  - Original: `app/engine/minimap.py`
- [x] **Victory screen.** `victory-state.ts` (~332 lines). Animated
  "VICTORY" banner + stats panel (turns, MVP). Map underneath with dark
  overlay. 20-frame ease-out animation. `victory_screen` event command.
  - Original: `app/engine/victory_screen.py`
- [x] **Credits screen.** `credit-state.ts` (~438 lines). Scrolling
  credits with edge-fade, text shadows, speed-up. `credits`/`credit`
  event command.
  - Original: `app/engine/credit_state.py`

### 3.2 Advanced Game Systems

- [x] **Component system (core).** Item and skill component dispatch
  (`item-system.ts`, `skill-system.ts`) wired into `combat-calcs.ts`.
  Handles: value hooks, boolean hooks, static modifiers, dynamic modifiers,
  multipliers, formula overrides. Covers ~80% of combat-relevant components.
  - Still missing: aura propagation, charge/cooldown, conditional activation,
    status immunity, proc skills.
  - Original: `app/engine/item_components/` (16 files), `app/engine/skill_components/` (16 files)
- [x] **Skill system (combat).** Runtime combat hooks: vantage, desperation,
  disvantage, noDouble, defDouble, distantCounter, closeCounter, critAnyway,
  ignoreDyingInCombat (miracle). All wired into `combat-solver.ts`.
  - Still missing: aura propagation, charge/cooldown, conditional activation,
    status immunity, proc skills.
  - Original: `app/engine/aura_funcs.py`, `app/engine/skill_components/`
- [x] **Support system.** Full `SupportController` in
  `src/engine/support-system.ts` (~500 lines). Support pairs with point
  accumulation, rank progression (locked -> unlocked), affinity-based stat
  bonuses (5 bonus methods), and per-chapter limits. Growth triggers: end
  turn, end combat, end chapter. Range modes: Manhattan distance (1-98),
  overlapping attack ranges (0), entire map (99). Combat calc integration:
  support bonuses for accuracy/avoid/damage/resist/crit/dodge. Database
  loaders for `support_ranks.json`, `support_constants.json`,
  `affinities.json`, `support_pairs.json`. Event commands:
  `enable_supports`, `increment_support_points`, `unlock_support_rank`,
  `disable_support_rank`. Types: `SupportRankBonus`, `AffinityDef`,
  `SupportRankRequirement`, `SupportPairPrefab` in `types.ts`.
  `UnitObject.affinity` field added.
  - Original: `app/engine/supports.py`
- [x] **Fog of war.** Three modes (GBA, Thracia, Hybrid): vision grids, fog
  tiles, previously-visited memory, torch items, thief vision. New
  `src/engine/line-of-sight.ts` (~170 lines) with Bresenham LOS algorithm
  and `simpleCheck()`. `GameBoard` extended with fog grids (per-team 2D
  Set grids), vantage points, opacity grid, fog/vision regions,
  `previouslyVisitedTiles`. Methods: `initFogGrids()`, `initOpacityGrid()`,
  `updateFow()`, `clearUnitFow()`, `inVision()`, `terrainKnown()`,
  `getFogOfWarRadius()`, `addFogRegion()`/`removeFogRegion()`,
  `addVisionRegion()`/`removeVisionRegion()`. `FogOfWarConfig` type in
  `types.ts`. `GameState.getCurrentFogInfo()` reads fog config from
  `levelVars`. `GameState.recalculateAllFow()` updates all unit vision.
  `MapView` draws fog overlay (semi-transparent dark for known terrain,
  opaque black for unknown) and filters units not in vision. `sightRange()`
  in `skill-system.ts` sums `sight_range_bonus` and
  `decreasing_sight_range_bonus` skill components. Event commands
  `enable_fog_of_war` and `set_fog_of_war` implemented. `SkillObject.data`
  Map added for runtime skill state.
  - Original: `app/engine/fog_of_war.py`, `app/engine/line_of_sight.py`, `app/engine/bresenham_line_algorithm.py`, `app/engine/game_board.py` (fog grids)
- [x] **Turnwheel / Divine Pulse.** Full undo/redo of game actions. Enhanced
  `ActionLog` (action.ts) with turnwheel navigation: `doAction()`, `setUp()`,
  `backward()`, `forward()`, `finalize()`, `reset()`, action groups (Move,
  Phase, Extra), lock mechanism, recording counter, `setFirstFreeAction()`.
  Marker actions: `MarkActionGroupStart`, `MarkActionGroupEnd`, `MarkPhase`,
  `LockTurnwheel`, `MessageAction`. New `TurnwheelState` (turnwheel-state.ts,
  ~300 lines) with transparent overlay, red/green tint, description text,
  turn counter, uses display, LEFT/UP backward, RIGHT/DOWN forward, SELECT
  confirm, BACK cancel. Integration: FreeState records `MarkActionGroupEnd`
  on begin and `MarkActionGroupStart` on unit select. MenuState records
  `MarkActionGroupEnd` on Wait. PhaseChangeState records `LockTurnwheel` +
  `MarkPhase`. AIState records group start/end per AI unit. OptionMenuState
  shows "Turnwheel" option when enabled. Event commands: `enable_turnwheel`,
  `activate_turnwheel`, `clear_turnwheel`, `stop_turnwheel_recording`,
  `start_turnwheel_recording`. `GameState.memory` Map added for state
  communication. CombatState records `MessageAction` for combat descriptions.
  - Original: `app/engine/turnwheel.py`
- [x] **Initiative turn system.** Non-phase-based turn order where units act
  based on speed. An alternative to the standard player/enemy phase cycle.
  New `src/engine/initiative.ts` (~210 lines) with `InitiativeTracker` class:
  sorted unit line (descending initiative), binary insert, index tracking,
  wrap-around next/back. `InitiativeUpkeepState` pushes free/ai + phase_change
  based on current initiative unit's team. `TurnChangeState` modified for
  initiative: advances initiative, increments turnCount on wrap. `FreeState`
  modified: auto-cursor to initiative unit, only allows selecting that unit,
  auto-ends turn when it's finished, START toggles initiative bar. `AIState`
  modified: only processes the single initiative unit. `PhaseChangeState`
  modified: only resets the initiative unit (not whole team). Unit sprites
  grey out non-initiative units. Event commands: `add_to_initiative`,
  `move_in_initiative`. Initiative auto-insert on `add_unit`/`add_group`/
  `spawn_group`, auto-remove on `remove_unit`/`kill_unit`/combat death.
  Registered in main.ts. Still missing: initiative bar rendering UI.
  - Original: `app/engine/initiative.py`
- [x] **Overworld map.** Node-based world map with roads, party movement,
  and level selection (Fire Emblem 8-style). Three new files:
  `src/engine/overworld/overworld-objects.ts` (runtime types),
  `src/engine/overworld/overworld-manager.ts` (~465 lines, graph/entity/menu
  management with Dijkstra shortest path),
  `src/engine/overworld/overworld-movement.ts` (~180 lines, animated road
  movement). Three game states in `src/engine/states/overworld-state.ts`
  (~670 lines): `OverworldFreeState` (cursor nav, node selection, menu),
  `OverworldMovementState` (transparent entity movement overlay),
  `OverworldLevelTransitionState` (fade-to-black level entry). Database
  loads `overworlds.json`. 11 event commands: `overworld_cinematic`,
  `reveal_overworld_node/road`, `overworld_move_unit` (blocking with road
  animation), `set_overworld_position`, `create_overworld_entity`,
  `disable_overworld_entity`, `set_overworld_menu_option_enabled/visible`,
  `enter_level_from_overworld`, `toggle_narration_mode`. `omove` alias.
  GameState fields: `overworldController`, `overworldMovement`,
  `overworldRegistry`.
  - Original: `app/engine/overworld/` (8 files)
- [x] **Free roam mode.** ARPG-style free movement where the player directly
  controls a unit, talks to NPCs, explores. Implemented: `FreeRoamState`,
  `FreeRoamRationalizeState`, `RoamPlayerMovementComponent` with physics-based
  movement, collision detection, NPC/region interaction. Event commands:
  `set_roam`, `set_roam_unit`. Still missing: roam AI for NPCs, shop/talk
  menu in roam mode.
  - Original: `app/engine/roam/` (5 files)
- [x] **Promotion / class change.** Silent promotion and class change via
  event commands (`promote`, `change_class`). New `PromoteAction` and
  `ClassChangeAction` in `action.ts` (~240 lines combined) — faithful ports
  of Python's `action.Promote` and `action.ClassChange` with sentinel values
  (-99, -98, -97), growth changes when `unit_stats_as_bonus` is true, wexp
  gain, max stat updates. Both use the `_getGame` pattern for DB access.
  Event commands: `promote;unit;[class_list];[silent]` and
  `change_class;unit;[class_list];[silent]` — resolve class list (or use
  `turns_into`), create action, grant new class skills, apply wexp, reload
  map sprites. `grantClassSkills()` helper iterates `learned_skills` and
  adds missing skills up to current level. Still missing: non-silent
  promotion choice UI state (visual battle anim swap), level-up display
  after promotion.
  - Original: `app/engine/promotion.py`, `app/engine/action.py`
- [x] **Difficulty modes.** New `src/engine/difficulty.ts` (~135 lines) with
  `DifficultyModeObject` class — runtime difficulty for the session, created
  from `DifficultyMode` DB prefab. Stores permadeath, growths, RNG mode,
  and mutable event-driven autolevel counters (enemy/boss autolevels and
  truelevels). Methods: `getBaseBonus()`, `getGrowthBonus()`,
  `getDifficultyAutolevels()`, `getDifficultyTruelevels()`, `save()`,
  `restore()`, `fromPrefab()`. `GameState` integration: `currentMode` field,
  `initDifficulty()` called during `loadLevel()`, `mode` getter for DB
  prefab, `getAlliedTeams()` for player-allied team resolution.
  `spawnUniqueUnit()` applies difficulty base bonuses.
  `spawnGenericUnit()` applies base bonuses + difficulty autolevels (with
  `promoted_autolevels_fraction` for promoted units) + true levels. Still
  missing: RNG mode integration into combat solver, difficulty selection UI,
  growth mode integration into leveling, permadeath toggle in death handling.
- [x] **Convoy / supply system.** Shared item storage accessible from prep
  and via Supply units on the map. Implemented: 7 Action classes
  (PutItemInConvoy, TakeItemFromConvoy, RemoveItemFromConvoy,
  StoreItemAction, TradeItemWithConvoy, GainMoneyAction, GiveBexpAction).
  Event commands: `enable_convoy`, `disable_convoy`, `give_item` to convoy.
  Still missing: Supply menu state UI (supply_items stub).
  - Original: `app/engine/convoy_funcs.py`
- [x] **Parties.** Multi-party support (multiple player factions with
  separate inventories and unit pools). Implemented: `PartyObject` class,
  DB loader, GameState integration (parties Map, currentParty, getParty,
  getUnitsInParty, getMoney, getBexp). Event commands: `change_party`,
  `give_money`, `give_bexp`.

### 3.3 Save / Load

- [x] **Save system.** New `src/engine/save.ts` (~1474 lines) with IndexedDB
  storage layer (localStorage fallback). Serialization for units, items,
  skills, levels, parties, supports. `saveGame()`, `suspendGame()`,
  `loadSaveSlots()`, `deleteSave()`, `hasSuspend()`, `formatPlaytime()`.
  Save/Load UI states in `src/engine/states/save-load-state.ts` (~300 lines).
  Event commands: `battle_save`, `battle_save_prompt`, `skip_save`, `suspend`.
- [x] **Load system.** `loadGame()`, `loadSuspend()`, `restoreGameState()`
  with 15-step ordered restoration (items -> skills -> units -> rescue refs ->
  parties -> level). Wired into LoadMenuState with slot selection and suspend
  resume.
- [x] **Persistent records.** `src/engine/records.ts` (~903 lines) with three
  systems: `Recordkeeper` (per-save stats), `PersistentRecordManager`
  (cross-save key-value records via localStorage), `AchievementManager`
  (cross-save achievements). Event commands: `create_record`, `update_record`,
  `replace_record`, `delete_record`, `unlock_difficulty`, `unlock_song`,
  `add_achievement`, `complete_achievement`.

### 3.4 Expression / Equation Evaluator

- [x] **Ternary expressions.** `x if condition else y` now parsed and
  evaluated in equation evaluator.
- [x] **Unit tag checks in equations.** `'Tag' in unit.tags` works for
  conditional stat formulas (e.g. RESCUE_AID).
- [x] **Condition evaluator.** Supports `'X' in unit.tags`, `'X' not in
  unit.tags`, `has_item()`, `has_skill()`, `v()`, `can_unlock()`,
  `any_unit_in_region()`, `is_dead()`, `check_alive()`.
- [x] **JavaScript fallback evaluator.** Complex Python expressions that
  the pattern matcher can't handle are evaluated via `Function()` with a
  Python-compatible game proxy scope. Handles `game.level.regions.get()`,
  `game.get_unit()`, `len()`, `any()` generators, and all standard
  operators.
- [x] **Full equation support.** New `src/engine/query-engine.ts` (~647 lines)
  with `GameQueryEngine` class providing all Python query functions: `u()`,
  `v()`, `getItem()`, `hasItem()`, `getSkill()`, `hasSkill()`, `getKlass()`,
  `getClosestAllies()`, `getUnitsWithinDistance()`, `getUnitsInRegion()`,
  `isDead()`, `getSupportRank()`, `getTerrain()`, `hasAchievement()`,
  `checkShove()`. `getFuncDict()` with both camelCase and snake_case aliases.
  - Original: `app/engine/evaluate.py`, `app/engine/query_engine.py`

### 3.5 Python Event Scripting

- [x] **Python-syntax events (PYEV1).** New `src/events/python-events.ts`
  (~995 lines) with `isPyev1()` detection and `PythonEventProcessor` class.
  Line-by-line interpreter with indentation-based block structure. Supports
  if/elif/else, for, while flow control. `$command` tokenizer converts
  PYEV1 `$command` lines to standard semicolon-delimited event commands.
  Python-to-JS expression translation with builtins (range, len, sorted,
  etc.). Integrated into `GameEvent` constructor for automatic PYEV1
  detection.
  - Original: `app/events/python_eventing/` (10+ files)

---

## Phase 4 -- Mobile / Distribution

- [x] **Touch controls.** Tap-to-move cursor, pinch-to-zoom, drag-to-pan.
  `isSmallScreen()` gates camera snap behavior (mobile centers, desktop
  stays put). No virtual D-pad yet — direct touch interaction only.
- [x] **Responsive scaling.** Dynamic viewport (`viewport.ts`) handles
  orientation changes, zoom levels, and different aspect ratios. HUD
  draws in screen-space at DPR-aware sizes. Middle-click pan + scroll
  zoom on desktop.
- [x] **PWA support.** Full PWA implementation: service worker (`public/sw.js`)
  with Vite-build-aware precaching (reads `precache-manifest.json` generated
  by a Vite plugin), stale-while-revalidate for app shell, cache-first for
  game assets, SPA navigation fallback for offline. Web app manifest with
  display_override, launch_handler, separated any/maskable icons. `src/pwa.ts`
  handles SW registration, `beforeinstallprompt` capture with deferred install
  prompt (`canInstall()`, `showInstallPrompt()`), update detection with
  callback API (`onUpdateAvailable()`), persistent storage request,
  online/offline connectivity tracking, standalone mode check, comprehensive
  `getPwaStatus()`. Install prompt and connectivity wired into `main.ts`.
- [x] **Asset bundling.** New `src/data/asset-bundle.ts` — client-side zip
  parser (manual central directory parsing + DecompressionStream), in-memory
  file store, fetch/Image interceptors for transparent ResourceManager
  compatibility. Build script `scripts/bundle-assets.mjs` packs `.ltproj`
  into zip with DEFLATE. Auto-detected at `/bundles/<project>.zip` on
  startup, opt-out via `?bundle=false`. Zero external dependencies.
- [x] **Performance profiling.** Comprehensive `src/engine/perf-monitor.ts`
  (~440 lines) — frame budget monitor with: smoothed FPS + min FPS (matching
  Python's `draw_fps()`), frame/update/draw time breakdown, peak stutter
  detection (1-second window), sustained budget violation warning (3s
  threshold with console warning for mobile), per-function timing via
  `timeFunction()`/`endTimeFunction()` (inspired by Python's `@frame_time`
  decorator), long frame spike logging (>33ms, console warns at >50ms),
  frame time histogram with 7 buckets for distribution analysis, profiling
  session recording (F4 key start/stop) with exportable JSON report
  (percentiles, dropped frames, device info, function hotspots, memory
  stats), `__PerfMonitor` exposed on globalThis for console access. HUD
  overlay shows FPS (color-coded), frame breakdown, peak, pool stats,
  memory, top 3 function hotspots. `src/engine/surface-pool.ts` —
  OffscreenCanvas recycling by size bucket. Game loop fully instrumented.
- [x] **Capacitor / TWA wrapper.** `capacitor.config.ts` for iOS/Android
  (fullscreen, dark status bar, splash screen, HTTPS scheme, iOS scroll
  disable, server allowNavigation). `twa-manifest.json` for bubblewrap
  Android TWA builds. `scripts/setup-native.mjs` interactive setup script
  (`npm run setup:capacitor` / `npm run setup:twa`) with prerequisite
  checking, platform auto-detection, step-by-step guidance. `src/native.ts`
  (~210 lines) — platform detection (Capacitor iOS/Android, TWA, PWA,
  browser), Screen Wake Lock API, status bar/splash screen plugin loading
  (dynamic imports), app pause/resume lifecycle with audio suspend/resume,
  Android back button handling, safe area inset detection for notched
  devices. `@capacitor/core` and `@capacitor/cli` as devDependencies.
  Package.json scripts: `setup:capacitor`, `setup:twa`, `cap:sync`,
  `cap:ios`, `cap:android`.

---

## File-by-File Status

| File | Lines | Status |
|------|------:|--------|
| `engine/constants.ts` | 41 | Done |
| `engine/surface.ts` | 358 | Done — scale-aware Surface, `drawImageFull()`, BMP font callback integration |
| `engine/input.ts` | 476 | Done — mouse, touch, pinch-zoom, drag-pan, scroll-zoom, middle-click pan |
| `engine/state.ts` | 52 | Done |
| `engine/state-machine.ts` | 207 | Done |
| `engine/camera.ts` | 180 | Done — dynamic viewport, `pan()` method, screen shake (5 patterns) |
| `engine/cursor.ts` | 194 | Done — actual cursor sprite with 3-frame bounce animation |
| `engine/viewport.ts` | 98 | Done — dynamic viewport for mobile/desktop |
| `engine/phase.ts` | 77 | Done, needs initiative mode |
| `engine/difficulty.ts` | 135 | Done — DifficultyModeObject runtime class, fromPrefab, base/growth/autolevel bonuses, save/restore |
| `engine/action.ts` | 1720 | Done — Move, Damage, Heal, HasAttacked, Wait, ResetAll, GainExp, UseItem, Trade, Rescue, Drop, Death, WeaponUses, PromoteAction, ClassChangeAction, Convoy actions, Money/Bexp |
| `engine/overworld/overworld-objects.ts` | 41 | Done — OverworldNodeObject, RoadObject, OverworldEntityObject interfaces |
| `engine/overworld/overworld-manager.ts` | 465 | Done — graph ops (Dijkstra), entity CRUD, node properties, menu options |
| `engine/overworld/overworld-movement.ts` | 180 | Done — animated road movement, interpolation, camera follow |
| `engine/states/overworld-state.ts` | 668 | Done — OverworldFreeState, OverworldMovementState, OverworldLevelTransitionState |
| `engine/initiative.ts` | 210 | Done — InitiativeTracker class, binary insert, initiative equation |
| `engine/game-state.ts` | 1150 | Done — win/loss, skill loading, team palette, startingPosition, aiGroup activation, autotile/weather loading, shop transient fields, combatScript, baseConvos, marketItems, overworld fields, initiative init, difficulty mode (currentMode, initDifficulty, getAlliedTeams, applyDifficultyBaseBonuses, applyDifficultyAutolevels) |
| `engine/states/game-states.ts` | 8050 | 21 states (+ ShopState + TitleMainState + InitiativeUpkeepState), scripted combat, ~84 event commands incl. promote + change_class (with PromoteAction/ClassChangeAction, grantClassSkills, wexp), 11 overworld + 2 initiative commands, initiative mode, {unit} template vars, group position system, placement modes, skip mode fix, viewbox iris, combat VFX, minimap/options in OptionMenu |
| `engine/states/prep-state.ts` | 499 | Done — GBA-style prep: PrepMainState, PrepPickUnitsState, PrepMapState |
| `engine/states/base-state.ts` | 510 | Done — Base hub: BaseMainState, BaseConvosState, handleBaseEventCommand |
| `engine/states/settings-state.ts` | 621 | Done — Settings: Config (14 options) + Controls tabs, slider/bool/choice |
| `engine/states/minimap-state.ts` | 355 | Done — Minimap overlay: terrain colors, unit dots, iris transition |
| `engine/states/victory-state.ts` | 332 | Done — Victory banner + stats panel, 20-frame animation |
| `engine/states/credit-state.ts` | 438 | Done — Scrolling credits, edge-fade, panorama background |
| `engine/states/info-menu-state.ts` | 621 | Done — detailed unit stats page (stats, items, skills, class info) |
| `engine/states/save-load-state.ts` | 300 | Done — SaveMenuState, LoadMenuState with slot selection |
| `engine/records.ts` | 903 | Done — Recordkeeper, PersistentRecordManager, AchievementManager |
| `engine/query-engine.ts` | 874 | Done — GameQueryEngine with all Python query functions (28 methods + snake_case aliases) |
| `engine/save.ts` | 1474 | Done — IndexedDB save/load, suspend, 15-step restore |
| `events/python-events.ts` | 995 | Done — PYEV1 processor with Python-syntax interpreter |
| `data/types.ts` | 371 | Done |
| `data/database.ts` | 479 | Done — combat anim data loading, map animation catalog |
| `data/loaders/combat-anim-loader.ts` | 342 | Done — combat anim JSON parsing |
| `data/resource-manager.ts` | 309 | Done |
| `objects/unit.ts` | 429 | Done — levelUp(), status effects, rescue, canto, startingPosition, aiGroup, portraitNid |
| `objects/item.ts` | 196 | Done — healing, stat boosters, uses decrement, droppable, isSpell/isUsable/targetsAllies/hasNoAI/canHeal |
| `objects/skill.ts` | 43 | Stub, needs component dispatch |
| `objects/game-board.ts` | 201 | Done, needs fog of war |
| `rendering/tilemap.ts` | 360 | Done — showLayer/hideLayer, autotile animation, weather management, pooled surface caching for getFullImage/getForegroundImage |
| `rendering/map-view.ts` | 287 | Done — dynamic viewport, unit HP bar overlays, weather rendering |
| `rendering/weather.ts` | 238 | Done — WeatherSystem with 7 types (rain, snow, sand, light, dark, night, sunset) |
| `rendering/map-animation.ts` | 169 | Done — MapAnimation sprite-sheet system, below/above-unit rendering |
| `rendering/bmp-font.ts` | 526 | Done — Bitmap font system: BmpFont class, IDX parser, palette variants, font registry |
| `rendering/map-sprite.ts` | 294 | Done — team palette swap with `colorConvert()` |
| `rendering/unit-renderer.ts` | 145 | Done, needs overlays |
| `rendering/highlight.ts` | 137 | Done — threat highlight type, clearType/hasType helpers |
| `pathfinding/pathfinding.ts` | 408 | Done |
| `pathfinding/path-system.ts` | 228 | Done |
| `movement/movement-system.ts` | 168 | Done, needs roam movement |
| `combat/combat-calcs.ts` | 722 | Done — full item-system + skill-system dispatch, Python ternary, equation-refs, DB constants, unit properties, clamp/int/float builtins |
| `combat/combat-solver.ts` | 409 | Done — vantage, desperation, miracle, disvantage, resolveScripted() for CombatScript |
| `combat/item-system.ts` | 247 | Done — item component dispatch layer |
| `combat/skill-system.ts` | 398 | Done — skill component dispatch layer |
| `combat/terrain-bonuses.ts` | 53 | Done — shared terrain avoid/defense utility |
| `combat/map-combat.ts` | 555 | Done — weapon uses, growth-based levelup, CombatResults, script parameter |
| `combat/animation-combat.ts` | 1078 | Done — full animation combat state machine, script parameter, combat effects, sparks, viewbox iris |
| `combat/battle-animation.ts` | 763 | Done — frame-by-frame pose playback, public spawnEffect for combat effects |
| `combat/battle-anim-types.ts` | 162 | Done — type definitions |
| `combat/sprite-loader.ts` | 453 | Done — palette conversion, platform loading, convertSpritesheetToFrames for effects |
| `ai/ai-controller.ts` | 1195 | Done — full behaviour iteration, guard, defend, retreat, target_spec, group activation, Support healing AI, Interact (Event regions) |
| `events/event-manager.ts` | 1265 | Done — FIFO queue, condition evaluator (tags, has_item, has_skill, v(), is_dead, check_alive), JS fallback eval with query engine injection (28 functions), talk pairs, base/victory/credit event types |
| `audio/audio-manager.ts` | 293 | Done — pushMusic/popMusic stack for battle music, suspendContext() for app backgrounding |
| `ui/menu.ts` | 204 | Done — click + hover mouse support, 9-slice backgrounds via base-surf |
| `ui/base-surf.ts` | 228 | Done — 9-slice menu window backgrounds from system sprites |
| `ui/icons.ts` | 151 | Done — Icon sheet loading (16x16/32x32), drawItemIcon() |
| `ui/hud.ts` | 253 | Done — screen-space rendering, terrain DEF + AVO display, chibi portraits |
| `ui/health-bar.ts` | 97 | Done |
| `events/event-portrait.ts` | 700 | Done — portrait compositing, blinking, talking, transitions, expressions |
| `events/screen-positions.ts` | 117 | Done — named screen position resolver for portraits |
| `ui/dialog.ts` | 367 | Done — portrait-aware positioning, word-wrap, BMP font widths, {clear}/{c:...}/{p} inline tags |
| `ui/banner.ts` | 113 | Done |
| `main.ts` | 496 | Done — LevelSelectState, dynamic viewport, DPR-aware display, all state registration, icon + font init, equation + query engine game ref wiring, PWA registration + install prompt + connectivity, asset bundle auto-detection, perf monitor instrumentation (F3 overlay, F4 profiling), native platform init |
| `pwa.ts` | 310 | Done — SW registration, beforeinstallprompt capture, deferred install API, update detection with callback, persistent storage, connectivity tracking, getPwaStatus() |
| `native.ts` | 210 | Done — Platform detection (Capacitor/TWA/PWA/browser), Wake Lock API, StatusBar/SplashScreen plugin loading, app pause/resume lifecycle, Android back button, safe area insets |
| `data/asset-bundle.ts` | 497 | Done — Zip parser (central directory), DecompressionStream, AssetBundle class, fetch/Image interceptors |
| `engine/surface-pool.ts` | 151 | Done — OffscreenCanvas recycling by size bucket, per-frame stats |
| `engine/perf-monitor.ts` | 440 | Done — Frame budget monitor, min FPS, sustained violation detection, per-function timing, long frame spike log, histogram, profiling sessions (F4), exportable JSON report, __PerfMonitor globalThis |

---

## Estimated Effort

| Phase | Scope | Rough Estimate |
|-------|-------|----------------|
| Phase 1 | Playable single chapter | 2-4 weeks |
| Phase 2 | Visual polish + battle anims | 3-6 weeks |
| Phase 3 | Full feature parity | 2-4 months |
| Phase 4 | Mobile / distribution | 2-4 weeks |

These are rough estimates for a single developer working full-time.
The component system (Phase 3) is the largest single item since it
underpins how every item and skill in the game actually functions.
