# lt-web: Lex Talionis Web Engine -- Development Plan

This document tracks what has been built, what is partially complete, and what
remains to bring the TypeScript web port to feature parity with the original
Lex Talionis Python/Pygame engine.

---

## Current State

**49 source files, ~18,500 lines of TypeScript.**
Builds cleanly with zero type errors (176KB JS / 49KB gzipped).
Loads `.ltproj` game data over HTTP and runs a 60 fps game loop
rendering to a dynamically-scaled HTML5 Canvas with dynamic viewport
(mobile + desktop). Phase 1.2 core gameplay implemented, plus GBA-style
combat animations, team-colored map sprites, level select, and full
touch/mouse/keyboard input. Component dispatch system wired into combat.

### Recent Changes (Latest Session)
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
- **`load_unit` / `make_generic` stubs.** Skip gracefully to allow
  event progression in later chapter cinematics.
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
- [x] `remove_region` (add_region still stub)
- [x] `camera` control (`center_cursor`, `move_cursor`, `disp_cursor`, `flicker_cursor`)
  - [ ] `map_anim` (play animation at a tile — requires map animation system)
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
- [ ] `interact_unit` (scripted combat with forced outcomes — stubbed)
- [ ] `shop` (opens shop interface — not yet implemented)
- [ ] `prep` (opens preparations screen — not yet implemented)

Original: `app/events/event_commands.py`, `app/events/event_functions.py`

---

## Phase 2 -- Visual Polish

### 2.1 Rendering

- [ ] **Autotile animation.** Tilesets with animated water/lava tiles. The
  tilemap data has `autotile_fps` and autotile column references. Needs a
  frame counter to swap between pre-rendered autotile frames.
  - Original: `app/engine/objects/tilemap.py` (lines 127-148)
- [x] **Foreground tilemap layers.** Layers marked `foreground: true` draw
  on top of units. `TileMapObject.getForegroundImage()` composites visible
  foreground layers, drawn in `MapView.draw()` step 5 (after units, before cursor).
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
- [ ] **Menu window backgrounds.** Replace solid-color menu backgrounds with
  proper 9-slice window chrome from system sprites.
  - Original: `app/engine/base_surf.py`
- [x] **Portraits in dialog.** Full portrait system: `EventPortrait` class
  with sprite sheet compositing, blinking, talking, expressions, transitions,
  movement, bop, mirroring. All 9 portrait event commands implemented.
  Dialog positions as speech bubble relative to portrait.
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
| `engine/cursor.ts` | ~185 | Done — actual cursor sprite with 3-frame bounce animation |
| `engine/viewport.ts` | 98 | Done — dynamic viewport for mobile/desktop |
| `engine/phase.ts` | 77 | Done, needs initiative mode |
| `engine/action.ts` | 557 | Done — Move, Damage, Heal, HasAttacked, Wait, ResetAll, GainExp, UseItem, Trade, Rescue, Drop, Death, WeaponUses |
| `engine/game-state.ts` | 635 | Done — win/loss, skill loading, team palette, startingPosition, aiGroup activation |
| `engine/states/game-states.ts` | ~5480 | 17 states incl. LevelSelect, CombatState with battle music, AI group filtering, ~50 event commands |
| `data/types.ts` | 342 | Done |
| `data/database.ts` | 436 | Done — combat anim data loading |
| `data/loaders/combat-anim-loader.ts` | 342 | Done — combat anim JSON parsing |
| `data/resource-manager.ts` | 309 | Done |
| `objects/unit.ts` | ~429 | Done — levelUp(), status effects, rescue, canto, startingPosition, aiGroup, portraitNid |
| `objects/item.ts` | ~195 | Done — healing, stat boosters, uses decrement, droppable, isSpell/isUsable/targetsAllies/hasNoAI/canHeal |
| `objects/skill.ts` | 43 | Stub, needs component dispatch |
| `objects/game-board.ts` | 201 | Done, needs fog of war |
| `rendering/tilemap.ts` | 200 | Done — showLayer/hideLayer, needs autotile animation |
| `rendering/map-view.ts` | 270 | Done — dynamic viewport, unit HP bar overlays |
| `rendering/map-sprite.ts` | 294 | Done — team palette swap with `colorConvert()` |
| `rendering/unit-renderer.ts` | 143 | Done, needs overlays |
| `rendering/highlight.ts` | 137 | Done — threat highlight type, clearType/hasType helpers |
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
| `ai/ai-controller.ts` | ~1080 | Done — full behaviour iteration, guard, defend, retreat, target_spec, group activation, Support healing AI |
| `events/event-manager.ts` | 770 | Done — FIFO queue, condition evaluator, talk pairs, ConditionContext |
| `audio/audio-manager.ts` | 285 | Done — pushMusic/popMusic stack for battle music |
| `ui/menu.ts` | 205 | Done — click + hover mouse support. Needs 9-slice backgrounds |
| `ui/hud.ts` | ~253 | Done — screen-space rendering, terrain DEF + AVO display, chibi portraits |
| `ui/health-bar.ts` | 97 | Done |
| `events/event-portrait.ts` | ~430 | **NEW** — portrait compositing, blinking, talking, transitions, expressions |
| `events/screen-positions.ts` | ~100 | **NEW** — named screen position resolver for portraits |
| `ui/dialog.ts` | ~320 | Done — portrait-aware positioning with speech bubble tail, word-wrap |
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
