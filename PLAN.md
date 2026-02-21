# lt-web: Lex Talionis Web Engine -- Development Plan

This document tracks what has been built, what is partially complete, and what
remains to bring the TypeScript web port to feature parity with the original
Lex Talionis Python/Pygame engine.

---

## Current State

**38 source files, ~12,000+ lines of TypeScript.**
Builds cleanly with zero type errors.
Loads `.ltproj` game data over HTTP and runs a 60 fps game loop
rendering to a dynamically-scaled HTML5 Canvas (240x160 logical, DPR-
aware physical resolution for crisp text and nearest-neighbor sprites).
Phase 1.2 core gameplay implemented: death handling, EXP/level-up with
growth rolls, win/loss conditions, item use, trading, rescue/drop,
status effects, canto, weapon uses, and 16 game states.

### Recent Changes (Latest Session)
- **Fixed AI combat animations.** AI combat was running synchronously in
  a `while` loop with zero visual frames. Now pushes `CombatState` via
  `game.state.change('combat')` — same animated path as player combat.
  AI move-only also waits for movement animation before advancing.
- **Fixed unit stats double-counting.** Constructor was adding class bases
  to prefab bases (Eirika HP: 16+16=32). Now uses prefab bases directly.
- **Fixed weapon triangle sign bug.** Disadvantage data already stored
  negative values; code was double-negating.
- **Expanded event system to ~100+ commands** with alias resolution.
- **Fixed EventState** to use `EventCommand.args[]` array format.
- **Fixed symlink** for `default.ltproj` game data.
- **Added null guards** for `game.board` throughout game states.
- **Fixed turn state flow** — units could still act after finishing.
  Added cascade guards in MoveState/MenuState/TargetingState.
- **Dynamic render resolution.** Surface class supports a scale factor.
  Physical canvas is `width*scale x height*scale`. All drawing ops auto-
  scale. Text renders at native resolution. Sprites use nearest-neighbor.
- **Full mouse controls.** LMB click on tile moves cursor + fires action.
  RMB = context-dependent back. Mouse hover tracks cursor in real-time.
  Click-on-menu-option support. All map states (Free, Move, Targeting,
  Drop) and menu states (Menu, OptionMenu) support mouse. Mouse events
  decoupled from keyboard button system to prevent double-processing.

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
  threshold is met. Currently `AIController` ignores `ai_groups`.
  - Original: `app/engine/ai_controller.py` (lines 283-341)
- [ ] **AI item use.** AI units using healing items or staves.
- [ ] **AI view range guard mode.** `view_range = -1` means "don't move, only
  attack if enemy is adjacent." Currently the code may not handle this
  correctly.
- [ ] **AI retreat / smart positioning.** `Move_away_from` behavior and
  `smart_retreat()`.

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
- [ ] **Unit sprite palette swap.** Team color conversion (blue -> red, etc.)
  by remapping palette colors on the map sprites. Currently units always
  use their default palette.
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

### 2.2 Combat Animations (IN PROGRESS)

Full GBA-style battle animation system — LT's flagship feature.
~3500 lines across the original Python (`battle_animation.py` 998 lines,
`animation_combat.py` 1359 lines, `mock_combat.py` 500 lines).

**Implementation plan:**

- [ ] **Battle animation data loading.** Load `combat_anims.json` and
  `combat_effects.json` with frame rects, pose timelines, and palette
  mappings. Load spritesheet PNGs via ResourceManager with colorkey and
  palette conversion (`(0,x,y)` -> target RGB via palette coordinate map).
  - Data: `resources/combat_anims/combat_anims.json`, `*.png` spritesheets
  - Palette system: `combat_palettes.json` maps `(x,y)` grid coords to RGB
  - Colorkey: `(128,160,128)` for characters, `(0,0,0)` for effects

- [ ] **BattleAnimation controller.** Frame-by-frame pose playback engine:
  - Script commands: `frame`, `dual_frame`, `over_frame`, `under_frame`,
    `wait`, `sound`, `start_hit`, `wait_for_hit`, `miss`, `spell`,
    `spell_hit`, `enemy_tint`, `self_tint`, `screen_blend`, `hit_spark`,
    `screen_shake`, `pan`, `start_loop`/`end_loop`, `effect`, `opacity`
  - States: `inert`, `run`, `wait`, `dying`, `leaving`
  - Entrance scaling (map sprite -> battle position over 14 frames)
  - Death animation (87-frame opacity flicker sequence + white flash)
  - Pose fallback chain (RangedStand->Stand, Critical->Attack, etc.)
  - Looping for idle poses (Stand, RangedStand)

- [ ] **AnimationCombat state machine.** The full battle scene coordinator:
  - States: init -> red_cursor -> fade_in (viewbox iris) -> entrance ->
    init_pause -> begin_phase -> anim -> combat_hit -> hp_change ->
    end_phase (loop) -> exp -> fade_out (viewbox iris) -> done
  - Left/right assignment (player on right, enemy on left)
  - Camera panning between combatants (offset-based, range-dependent)
  - Screen shake patterns (4 intensity levels)
  - Damage numbers, proc icons, miss text

- [ ] **Combat scene rendering.** Full draw pipeline:
  - Terrain-specific battle backgrounds (panorama images, fade in/out)
  - Platforms (54 terrain variants, melee vs ranged, horizontally flipped)
  - Under-frames, main frames, over-frames, effect frames (layered draw)
  - HP bars with name tags, weapon info, hit/mt/crit stats
  - Hit sparks and crit sparks

- [ ] **Viewbox iris transition.** 250ms shrinking/expanding rectangle
  centered on the defender's tile for entering/exiting battle scene.

- [ ] **Combat effect system.** Same script engine as battle anims but
  for spell/weapon effects. `end_parent_loop` interaction with parent.
  100+ effects in default.ltproj (projectiles, magic, healing, procs).

- [ ] **Weapon animation resolution.** Map item type to weapon anim NID:
  Sword, MagicSword, Lance, RangedLance, Axe, MagicAxe, Bow, MagicAnima,
  MagicLight, MagicDark, MagicStaff, Transform, Unarmed. Ranged/Magic
  prefix logic with fallbacks.

- [ ] **Wire into CombatState.** `has_animation()` check: if both units
  have battle anims loaded, use AnimationCombat; otherwise fall back to
  existing MapCombat. User setting: Always/Your Turn/Never.

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

- [ ] **Component system.** Full item and skill component dispatch (the
  original compiles Python source at startup). In TS, implement as a
  dispatch table mapping component names to handler functions.
  - Original: `app/engine/item_components/` (16 files), `app/engine/skill_components/` (16 files), `app/engine/component_system/`
  - This is critical for items and skills to actually *work* beyond basic
    damage/hit/range.
- [ ] **Skill system.** Runtime skill effects: stat modifiers, combat hooks
  (vantage, desperation, wary fighter), aura propagation, charge/cooldown,
  conditional activation, status immunity.
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

- [ ] **Touch controls.** Virtual D-pad and action buttons for mobile. The
  `InputManager` has basic tap/swipe but needs a proper on-screen control
  overlay.
- [ ] **Responsive scaling.** Handle portrait/landscape orientation changes,
  notch safe areas, and different aspect ratios.
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
| `engine/surface.ts` | 300+ | Done — scale-aware Surface with DPR support, nearest-neighbor sprites, crisp text |
| `engine/input.ts` | 340+ | Done — mouse decoupled from keyboard, tile conversion, display scale. Needs touch UI overlay |
| `engine/state.ts` | 52 | Done |
| `engine/state-machine.ts` | 202 | Done |
| `engine/camera.ts` | 133 | Done, needs shake effect |
| `engine/cursor.ts` | 135 | Done, needs actual cursor sprite |
| `engine/phase.ts` | 77 | Done, needs initiative mode |
| `engine/action.ts` | 480+ | Done — Move, Damage, Heal, HasAttacked, Wait, ResetAll, GainExp, UseItem, Trade, Rescue, Drop, Death, WeaponUses |
| `engine/game-state.ts` | 560+ | Done — win/loss conditions, skill loading, droppable items, input ref |
| `engine/states/game-states.ts` | 2100+ | 16 states: +ItemUse, Trade, Rescue, Drop. CombatState with death/EXP/levelup. AI uses CombatState. Full mouse support. |
| `data/types.ts` | 307 | Done |
| `data/database.ts` | 387 | Done |
| `data/resource-manager.ts` | 297 | Done |
| `objects/unit.ts` | 330+ | Done — levelUp(), status effects, rescue, canto, effective stats |
| `objects/item.ts` | 160+ | Done — healing, stat boosters, uses decrement, droppable |
| `objects/skill.ts` | 43 | Stub, needs component dispatch |
| `objects/game-board.ts` | 201 | Done, needs fog of war |
| `rendering/tilemap.ts` | 188 | Done, needs autotile animation |
| `rendering/map-view.ts` | 220 | Done, needs weather/animations |
| `rendering/map-sprite.ts` | 163 | Done, needs palette swap |
| `rendering/unit-renderer.ts` | 143 | Done, needs overlays |
| `rendering/highlight.ts` | 112 | Done |
| `pathfinding/pathfinding.ts` | 408 | Done |
| `pathfinding/path-system.ts` | 228 | Done |
| `movement/movement-system.ts` | 143 | Done, needs roam movement |
| `combat/combat-calcs.ts` | 338 | Done, needs skill/component hooks |
| `combat/combat-solver.ts` | 203 | Done, needs vantage/desperation |
| `combat/map-combat.ts` | 340+ | Done — weapon uses, growth-based levelup, droppable items, CombatResults |
| `ai/ai-controller.ts` | 413 | Done, needs group AI / retreat |
| `events/event-manager.ts` | 385+ | Partial — +getEventsForTrigger(), +unit_talk/region_event triggers. Needs ~50 more commands |
| `audio/audio-manager.ts` | 261 | Done |
| `ui/menu.ts` | 200+ | Done — click + hover mouse support. Needs 9-slice backgrounds |
| `ui/hud.ts` | 143 | Done, needs icons |
| `ui/health-bar.ts` | 97 | Done |
| `ui/dialog.ts` | 207 | Done, needs portraits |
| `ui/banner.ts` | 108 | Done |
| `main.ts` | 340+ | Done — dynamic render resolution, DPR-aware display, input wiring |

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
