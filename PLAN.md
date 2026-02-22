# lt-web: Lex Talionis Web Engine -- Development Plan

This document tracks what has been built, what is partially complete, and what
remains to bring the TypeScript web port to feature parity with the original
Lex Talionis Python/Pygame engine.

---

## Current State

**84 source files, ~44,400 lines of TypeScript.**
Builds cleanly with zero type errors. All four development phases (Foundation,
Playable, Visual Polish, Mobile/Distribution) are complete. The engine loads
`.ltproj` game data over HTTP and runs at 60 fps on Canvas 2D with dynamic
viewport scaling for mobile and desktop.

### Completed Systems (Summary)

All Phase 0-4 work is done. Key systems implemented:

- **Core**: Stack-based state machine (21+ states), tilemap rendering (multi-layer,
  autotile, weather, foreground), unit system (stats, items, skills, status, rescue),
  action menu, combat (weapon triangle, terrain, supports, component dispatch),
  AI (behaviours, targeting, healing, group activation), experience/leveling, win/loss
- **Events**: ~100+ commands across EVNT and PYEV1 formats, portrait system,
  dialog, transitions, camera control, flow control (if/for/while), query engine
- **Combat Animations**: GBA-style battle anims (~2,600 lines), spell/weapon effects,
  terrain panoramas, platforms, damage numbers, hit/crit sparks, viewbox iris
- **UI**: Bitmap fonts (23 variants), 9-slice menus, icons, HUD, dialog, banners
- **Game Screens**: Title, Prep, Base, Settings, Minimap, Victory, Credits,
  Info Menu, Save/Load, Overworld, Turnwheel
- **Advanced Systems**: Support system, fog of war, turnwheel, initiative turns,
  overworld map, free roam, promotion/class change, difficulty modes, parties/convoy,
  save/load (IndexedDB), records/achievements, query engine, equation evaluator
- **Platform**: Touch controls, responsive scaling, PWA, asset bundling,
  performance profiling, Capacitor/TWA wrapper

### Known Bugs

- [ ] **First dialogue still renders over the portrait.** The dialogue box
  appears on top of the portrait sprite instead of being positioned to avoid it.
- [ ] **No cursor sounds when using mouse.** Moving the cursor via mouse click
  does not play the `Select 5` sound that keyboard movement plays.
- [ ] **Combat animations at half speed sometimes.** Battle animations
  occasionally play at roughly half their normal speed.
- [ ] **Enemies leave blue rectangle at start position when attacking.** When
  an enemy unit initiates combat, a blue highlight rectangle remains at their
  original tile during the attack.
- [ ] **Lose cursor control after combat.** After combat resolves, the player
  cannot move the cursor or interact with the map.
- [ ] **Red rectangle randomly appears during magic attack.** A stray red
  rectangle/highlight flashes on screen during magic combat animations.
- [ ] **Terrain platforms swap/move after magic attack starts.** During magic
  combat animations, the terrain platform images appear to shift or swap sides
  unexpectedly, then swap back at the end.
- [ ] **No ESC to skip combat animation.** There is currently no way to press
  Escape to skip/fast-forward through a combat animation.
- [ ] **Combat UI layout is wrong.** The combat UI (name tags, HP bars, weapon
  info) during GBA-style battle animations does not match the original Pygame
  engine's layout. Needs to be matched faithfully.

### Recent Changes (Latest Session)

- **9 combat/UI/input bug fixes in one session.**
  - **Blue rectangle at enemy start position.** `CombatState.begin()` now calls
    `game.highlight.clear()` and `game.cursor.visible = false` before combat starts
    (matching Python's `interaction.py` + `red_cursor` state). Previously highlights
    from FreeState/TargetingState persisted through transparent CombatState.
  - **Red rectangle during magic attack.** `AIState.draw()` now skips the red
    AI-unit indicator rectangle when `waitingForCombat` is true. The red rect was
    bleeding through the transparent CombatState's viewbox iris during animation combat.
  - **Cursor control lost after combat.** AI `waitingForCombat` check now also tests
    `unit.hasAttacked` (not just `unit.finished || unit.isDead()`), fixing stuck state
    when AI units have canto. CombatState cleanup now restores `game.cursor.visible = true`.
  - **Platform swap/move during magic combat.** Fixed ranged platform X formula to
    include `pan_max` base offset (matching Python's `mock_combat.py`). Initialized
    `panOffset` to `+/-panConfig.max` based on attacker side (was 0). Fixed `pan()`
    toggle direction to match Python's `focus_right` logic.
  - **Combat animations at half speed.** Added frame-time accumulator to
    `AnimationCombat` — animation ticks now run at fixed 60fps rate regardless of
    monitor refresh rate. Converted entrance/initPause/hpDrain states from
    frame-count-based to ms-based timing. Prevents 2x speed on 120Hz monitors and
    half-speed on frame drops.
  - **ESC/START to skip combat animation.** Added `CombatState.takeInput()` — pressing
    BACK (Escape/X) or START (S) toggles `skipMode` on `AnimationCombat`. Skip mode
    runs animations at 4x speed and accelerates all state timers (matching Python's
    `battle_anim_speed = 0.25`).
  - **Mouse cursor sounds.** `processMouseForMap()` now plays `Select 5` when mouse
    click or hover moves the cursor to a new tile (was only played for keyboard movement).
  - **Dialog transition-in animation.** New `'transition_in'` dialog state with ~167ms
    (10 frame) grow+fade animation matching Python's `TRANSITION_IN`. During transition,
    only the background box is drawn (growing from center, fading in). Tail, speaker
    name, and text are not drawn until transition completes. SELECT skips transition.
  - **Combat UI overhaul.** HP bar panels now show HIT/DMG/CRT stat numbers (computed
    from `computeHit`/`computeDamage`/`computeCrit`), weapon name, and HP bar. Panel
    height increased from 28px to 44px to accommodate stats. Matches Python's layout
    with stat labels + right-aligned values.

---

## Remaining Work

### Still Missing (Lower Priority)

- Initiative bar rendering UI (visual bar showing unit order)
- Non-silent promotion choice UI (visual class selection)
- Level-up display after promotion
- Supply menu state UI
- Aura propagation, charge/cooldown, conditional activation, proc skills
- RNG mode integration into combat solver
- Difficulty selection UI
- Roam AI for NPCs, shop/talk menu in roam mode
- Rescue icon, status effect icons, movement arrows on map
- Growth rates display, support list, weapon rank letters in info menu
- Base screen sub-menus (supports, codex, BEXP, sound room, achievements)
