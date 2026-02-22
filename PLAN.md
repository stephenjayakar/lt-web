# lt-web: Lex Talionis Web Engine -- Development Plan

This document tracks what has been built, what is partially complete, and what
remains to bring the TypeScript web port to feature parity with the original
Lex Talionis Python/Pygame engine.

---

## Current State

**47 source files, ~17,200 lines of TypeScript.**
Builds cleanly with zero type errors (176KB JS / 49KB gzipped).
Loads `.ltproj` game data over HTTP and runs a 60 fps game loop
rendering to a dynamically-scaled HTML5 Canvas with dynamic viewport
(mobile + desktop). Phase 1.2 core gameplay implemented, plus GBA-style
combat animations, team-colored map sprites, level select, and full
touch/mouse/keyboard input. Component dispatch system wired into combat.

### Recent Changes (Latest Session)
- **Component dispatch wired into combat.** `item-system.ts` and
  `skill-system.ts` dispatch layers now fully integrated into
  `combat-calcs.ts`. All damage/hit/avoid/crit/speed formulas go
  through item and skill modifiers. Supports formula overrides from
  skills, dynamic modifiers, multipliers, and effective damage.
- **Vantage/desperation/miracle in combat solver.** `combat-solver.ts`
  rewritten with full skill-based strike ordering: vantage (defender
  first), desperation (all attacker strikes before counter), disvantage,
  ignoreDyingInCombat (miracle), critAnyway. Uses `computeStrikeCount()`
  for brave weapons + dynamic multiattacks from skills.
- **AI system overhaul.** `ai-controller.ts` rewritten (540 lines) with:
  - All view_range modes: -1 (guard), -2 (single move), -3 (double
    move), -4 (full map), 0 (disabled), positive (custom range)
  - Guard mode movement restriction (only current position)
  - target/target_spec filtering: Tag, Class, Name, ID, Team with
    invert_targeting support
  - Behaviour iteration with fallback (tries each in order)
  - Primary -> secondary fallback per behaviour
  - Defend AI: Move_to Position/Starting (return to starting position)
  - Move_away_from (smart retreat -- maximize distance from threats)
  - Support/Steal/Interact/Move_to action types
  - Kill bonus in utility evaluation for target prioritization
  - Normalized offense_bias weighting
- **UnitObject.startingPosition and aiGroup.** Units now track where
  they were originally placed (for Defend AI) and their AI group NID.
  Both set during spawning.
- **ai_group field in level data.** UniqueUnitData and GenericUnitData
  types now include `ai_group: NID | null`.

### Previous Session
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

- [ ] **Data format edge cases.** The LT data has `UniqueUnitData` vs
  `GenericUnitData` discrimination that relies on the presence of a `klass`
  field. Verify this works for every unit in every level of `default.ltproj`.
  Some levels use `unit_groups` for reinforcements -- these are not spawned
  yet.
- [ ] **Tilemap sprite grid coordinate parsing.** LT stores tile coordinates
  as `"x,y"` string keys. Verify our parsing handles edge cases (negative
  coords, large maps, missing entries).
- [ ] **Map sprite loading failures.** Some classes may not have matching
  `<Name>-stand.png` / `<Name>-move.png` files. The engine silently sets
  `sprite = null` but the renderer must handle this gracefully with
  placeholders everywhere (verify `UnitRenderer.drawPlaceholder`).
- [ ] **Tileset manifest loading.** `tilesets.json` in the original uses a
  list of objects. Verify our `Database.loadTilesets` correctly parses the
  actual format.
- [ ] **State machine first-frame bootstrap.** The `TitleState` is pushed via
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

- [ ] **AI group support.** Groups of enemies that activate together when a
  threshold is met. `AIController` has `aiGroup` field on units but trigger
  threshold / ping logic not yet implemented.
  - Original: `app/engine/ai_controller.py` (lines 283-341)
- [ ] **AI item use.** AI units using healing items or staves.
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

- [ ] `transition` (open/close, fade to black and back)
- [ ] `add_unit` / `create_unit` (spawn units during events)
- [ ] `give_item` / `remove_item`
- [ ] `give_money` / `give_exp`
- [ ] `change_team` (defection / recruitment)
- [ ] `set_game_var` / `inc_game_var`
- [ ] `change_objective`
- [ ] `add_portrait` / `remove_portrait` (for dialog scenes)
- [ ] `music` / `sound`
- [ ] `win_game` / `lose_game`
- [ ] `if` / `elif` / `else` / `end` (flow control)
- [ ] `for` loop
- [ ] `set_tile` (change tilemap terrain mid-level)
- [ ] `add_region` / `remove_region`
- [ ] `camera` control (pan, center on unit)
- [ ] `map_anim` (play animation at a tile)

Original: `app/events/event_commands.py`, `app/events/event_functions.py`

---

## Phase 2 -- Visual Polish

### 2.1 Rendering

- [ ] **Autotile animation.** Tilesets with animated water/lava tiles. The
  tilemap data has `autotile_fps` and autotile column references. Needs a
  frame counter to swap between pre-rendered autotile frames.
  - Original: `app/engine/objects/tilemap.py` (lines 127-148)
- [ ] **Foreground tilemap layers.** Layers marked `foreground: true` should
  draw on top of units. `MapView` has a slot for this but it may not be
  wired up correctly in all states.
- [ ] **Weather particles.** Rain, snow, sand, fog. The original has a full
  particle system with pooling.
  - Original: `app/engine/particles.py`
- [ ] **Map animations.** Spritesheet-based animations played at map
  positions (miss, no-damage, level-up sparkle, etc.).
  - Original: `app/engine/animations.py`
- [x] **Unit sprite palette swap.** Team color conversion (blue -> red, etc.)
  by remapping palette colors on the map sprites. 4 default palettes
  (blue/red/green/purple) loaded from team definitions.
  - Original: `app/engine/unit_sprite.py`, `app/engine/image_mods.py` (color_convert)
- [ ] **Unit overlays.** HP bar under units, rescue icon, status effect
  icons, movement arrows.
  - Original: `app/engine/unit_sprite.py` (draw_hp, draw_rescue_icon, etc.)
- [ ] **Cursor sprite.** Replace the pulsing rectangle with the actual
  cursor sprite from `sprites/cursor.png` and `sprites/cursor2.png`.
- [ ] **Menu window backgrounds.** Replace solid-color menu backgrounds with
  proper 9-slice window chrome from system sprites.
  - Original: `app/engine/base_surf.py`
- [ ] **Portraits in dialog.** Show character portraits during `speak`
  events with positioning, blinking, and expression support.
  - Original: `app/events/event_portrait.py`
- [ ] **Bitmap font rendering.** Replace Canvas `fillText` with the original
  BMP font system for authentic GBA-style text.
  - Original: `app/engine/bmpfont.py`, `app/engine/fonts.py`
- [ ] **Icon rendering.** Load and display item/skill/class icons from icon
  sheets (16x16, 32x32).
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
- [ ] **Viewbox iris transition.** Not yet implemented (scene enters/exits
  abruptly).
- [ ] **Combat effect system.** Spell/weapon effects not yet implemented
  (100+ effects in default.ltproj).
- [ ] **Screen shake, damage numbers, hit/crit sparks.** Partially stubbed.

---

## Phase 3 -- Full Feature Parity

### 3.1 Game Screens

- [ ] **Title screen.** Proper title with background image, New Game, Load
  Game, Extras options.
  - Original: `app/engine/title_screen.py`
- [ ] **Prep screen.** Pre-battle unit management: pick units, set formation,
  manage items, access convoy, view supports.
  - Original: `app/engine/prep.py`, `app/engine/prep_gba.py`
- [ ] **Base screen.** Between-chapter hub with shops, conversations, unit
  management.
  - Original: `app/engine/base.py`
- [ ] **Info/status menu.** Detailed unit stats page (stats, growth rates,
  weapon ranks, items, skills, support list).
  - Original: `app/engine/info_menu/`
- [ ] **Settings menu.** Audio, display, controls, gameplay configuration.
  - Original: `app/engine/settings_menu.py`, `app/engine/config.py`
- [ ] **Minimap.** Zoomed-out full-map view with unit positions.
  - Original: `app/engine/minimap.py`
- [ ] **Victory screen.** End-of-chapter stats display.
  - Original: `app/engine/victory_screen.py`
- [ ] **Credits screen.**
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
- [ ] **Support system.** Adjacency-based support points, rank progression,
  stat bonuses, support conversations.
  - Original: `app/engine/supports.py`
- [ ] **Fog of war.** Three modes (GBA, Thracia, Hybrid): vision grids, fog
  tiles, previously-visited memory, torch items, thief vision.
  - Original: `app/engine/fog_of_war.py`, `app/engine/line_of_sight.py`, `app/engine/bresenham_line_algorithm.py`, `app/engine/game_board.py` (fog grids)
- [ ] **Turnwheel / Divine Pulse.** Full undo/redo of game actions. The
  `ActionLog` records actions; needs a UI to select how far to rewind,
  and reverse execution of all actions in the log.
  - Original: `app/engine/turnwheel.py`
- [ ] **Initiative turn system.** Non-phase-based turn order where units act
  based on speed. An alternative to the standard player/enemy phase cycle.
  - Original: `app/engine/initiative.py`
- [ ] **Overworld map.** Node-based world map with roads, party movement,
  and level selection (Fire Emblem 8-style).
  - Original: `app/engine/overworld/` (8 files)
- [ ] **Free roam mode.** ARPG-style free movement where the player directly
  controls a unit, talks to NPCs, explores.
  - Original: `app/engine/roam/` (5 files)
- [ ] **Promotion / class change.** Class upgrade menu with preview.
  - Original: `app/engine/promotion.py`
- [ ] **Convoy / supply system.** Shared item storage accessible from prep
  and via Supply units on the map.
  - Original: `app/engine/convoy_funcs.py`
- [ ] **Difficulty modes.** Runtime stat scaling for enemies, growth mode
  selection, RNG mode selection, permadeath toggle.
- [ ] **Parties.** Multi-party support (multiple player factions with
  separate inventories and unit pools).

### 3.3 Save / Load

- [ ] **Save system.** Serialize full `GameState` to IndexedDB or
  localStorage. Support multiple save slots, suspend saves, and
  chapter-start auto-saves.
- [ ] **Load system.** Deserialize and restore game state, reinitialize all
  subsystems from saved data.
- [ ] **Persistent records.** Cross-save achievements, unlocks, and
  statistics.

### 3.4 Expression / Equation Evaluator

- [ ] **Full equation support.** The original uses Python `eval()` for user-
  defined equations with access to unit stats, game vars, and utility
  functions. The current `evaluateEquation` in `combat-calcs.ts` handles
  basic math but not:
  - Ternary expressions (`x if condition else y`)
  - Unit attribute access (`unit.tags`, `'Mounted' in unit.tags`)
  - Game state queries
  - Custom functions beyond `max` / `min`
  - Original: `app/engine/evaluate.py`, `app/engine/query_engine.py`

### 3.5 Python Event Scripting

- [ ] **Python-syntax events.** LT supports a second event scripting format
  (PYEV1) where events are written in Python with a proxy API. Porting
  this would require either a JS-based Python subset interpreter or a
  complete reimplementation of the proxy API in TypeScript.
  - Original: `app/events/python_eventing/` (10+ files)
  - Recommendation: defer this indefinitely; focus on the semicolon-
    delimited format which covers 90%+ of existing games.

---

## Phase 4 -- Mobile / Distribution

- [x] **Touch controls.** Tap-to-move cursor, pinch-to-zoom, drag-to-pan.
  `isSmallScreen()` gates camera snap behavior (mobile centers, desktop
  stays put). No virtual D-pad yet — direct touch interaction only.
- [x] **Responsive scaling.** Dynamic viewport (`viewport.ts`) handles
  orientation changes, zoom levels, and different aspect ratios. HUD
  draws in screen-space at DPR-aware sizes. Middle-click pan + scroll
  zoom on desktop.
- [ ] **PWA support.** Service worker for offline play, manifest for add-to-
  homescreen.
- [ ] **Asset bundling.** Pack `.ltproj` assets into a single downloadable
  archive (zip) that can be loaded client-side, rather than requiring
  hundreds of individual HTTP requests.
- [ ] **Performance profiling.** Profile on low-end mobile devices. The
  `Surface` system creates many `OffscreenCanvas` objects; may need to
  pool or use WebGL for heavy scenes.
- [ ] **Capacitor / TWA wrapper.** Native mobile app packaging via Capacitor
  (iOS/Android) for app store distribution.

---

## File-by-File Status

| File | Lines | Status |
|------|------:|--------|
| `engine/constants.ts` | 37 | Done |
| `engine/surface.ts` | 333 | Done — scale-aware Surface, `drawImageFull()` for combat anims |
| `engine/input.ts` | 476 | Done — mouse, touch, pinch-zoom, drag-pan, scroll-zoom, middle-click pan |
| `engine/state.ts` | 52 | Done |
| `engine/state-machine.ts` | 207 | Done |
| `engine/camera.ts` | 111 | Done — dynamic viewport, `pan()` method, needs shake effect |
| `engine/cursor.ts` | 135 | Done, needs actual cursor sprite |
| `engine/viewport.ts` | 98 | Done — dynamic viewport for mobile/desktop |
| `engine/phase.ts` | 77 | Done, needs initiative mode |
| `engine/action.ts` | 557 | Done — Move, Damage, Heal, HasAttacked, Wait, ResetAll, GainExp, UseItem, Trade, Rescue, Drop, Death, WeaponUses |
| `engine/game-state.ts` | 615 | Done — win/loss, skill loading, team palette, startingPosition, aiGroup |
| `engine/states/game-states.ts` | 3495 | 17 states incl. LevelSelect, CombatState with animation combat, AI animated combat |
| `data/types.ts` | 342 | Done |
| `data/database.ts` | 436 | Done — combat anim data loading |
| `data/loaders/combat-anim-loader.ts` | 342 | Done — combat anim JSON parsing |
| `data/resource-manager.ts` | 309 | Done |
| `objects/unit.ts` | 420 | Done — levelUp(), status effects, rescue, canto, startingPosition, aiGroup |
| `objects/item.ts` | 159 | Done — healing, stat boosters, uses decrement, droppable |
| `objects/skill.ts` | 43 | Stub, needs component dispatch |
| `objects/game-board.ts` | 201 | Done, needs fog of war |
| `rendering/tilemap.ts` | 188 | Done, needs autotile animation |
| `rendering/map-view.ts` | 250 | Done — dynamic viewport support |
| `rendering/map-sprite.ts` | 294 | Done — team palette swap with `colorConvert()` |
| `rendering/unit-renderer.ts` | 143 | Done, needs overlays |
| `rendering/highlight.ts` | 112 | Done |
| `pathfinding/pathfinding.ts` | 408 | Done |
| `pathfinding/path-system.ts` | 228 | Done |
| `movement/movement-system.ts` | 168 | Done, needs roam movement |
| `combat/combat-calcs.ts` | 455 | Done — full item-system + skill-system dispatch |
| `combat/combat-solver.ts` | 275 | Done — vantage, desperation, miracle, disvantage |
| `combat/item-system.ts` | 248 | Done — item component dispatch layer |
| `combat/skill-system.ts` | 399 | Done — skill component dispatch layer |
| `combat/map-combat.ts` | 552 | Done — weapon uses, growth-based levelup, CombatResults |
| `combat/animation-combat.ts` | 920 | Done — full animation combat state machine |
| `combat/battle-animation.ts` | 763 | Done — frame-by-frame pose playback |
| `combat/battle-anim-types.ts` | 162 | Done — type definitions |
| `combat/sprite-loader.ts` | 380 | Done — palette conversion, platform loading |
| `ai/ai-controller.ts` | 540 | Done — full behaviour iteration, guard, defend, retreat, target_spec |
| `events/event-manager.ts` | 530 | Done — FIFO queue, condition evaluator, ConditionContext |
| `audio/audio-manager.ts` | 261 | Done |
| `ui/menu.ts` | 205 | Done — click + hover mouse support. Needs 9-slice backgrounds |
| `ui/hud.ts` | 214 | Done — screen-space rendering, terrain DEF + AVO display |
| `ui/health-bar.ts` | 97 | Done |
| `ui/dialog.ts` | 207 | Done, needs portraits |
| `ui/banner.ts` | 108 | Done |
| `main.ts` | 318 | Done — LevelSelectState, dynamic viewport, DPR-aware display |

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
