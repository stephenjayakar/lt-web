# lt-web Completion Log

Completed milestones and detailed verification history moved out of `PLAN.md`.
Current work remains in `PLAN.md`; generated inventories under `docs/parity/` own
current coverage counts.

## Historical Evidence Baseline (2026-07-17)

Run `npm run audit:parity` to regenerate the source inventory. Current baseline:

| Domain | Python reference | Web inventory | Current classification |
|---|---:|---:|---|
| Event command NIDs | 255 | 210 recognized; 200 matching case labels | Partial |
| Item component NIDs | 201 | 134 exact string references; 92 with matching hook surfaces | Partial/Unknown |
| Skill component NIDs | 241 | 73 exact string references; 67 with matching hook surfaces | Partial/Unknown |
| Registered runtime states | broad Python state catalog | 44 web states | Partial |
| TypeScript runtime | n/a | 95 files, 54,370 lines | Builds |
| Browser regression suite | n/a | 109 Playwright tests | 109/109 passing |

Counts are inventories, not equivalence percentages: one generated hook can cover
many components, while one switch case can still omit flags or blocking behavior.

## Completed Multi-Project Support

- [x] Configurable project path via `?project=` query param
- [x] Non-chunked game_data fallback (items.json, skills.json, etc.)
- [x] Non-chunked tilemap fallback (single tilemaps.json)
- [x] Engine-level shared assets separated from project assets (sprites/menus, platforms, cursor)
- [x] Combat palette loading: added `palette_data/` subdirectory fallback path
- [x] URL encoding: `ResourceManager.resolveUrl()` now encodes path segments for spaces/special chars
- [x] Title screen: animated panorama fallback (tries `title_background0.png` when single file missing)
- [x] Icons, fonts, base-surf, sprite-loader all encode NIDs in URLs

## Fixed Bugs

- [x] **`remove_unit`/`remove_group`/`remove_all_units`/`remove_all_enemies` event
  commands permanently deleted units from the unit registry instead of just
  taking them off the map.** *(Fixed)* All four `EventState` command handlers
  (`src/engine/states/game-states.ts`, `remove_unit` ~8197, `remove_group`
  ~8369, `remove_all_enemies`/`remove_all_units` ~9547) called
  `game.units.delete(nid)` after removing from the board. Python's
  reference (`lt-maker/app/events/event_functions.py:1113` `remove_unit`,
  `:1518` `remove_group`, `:1171`/`:1176` `remove_all_units`/
  `remove_all_enemies`) only ever calls `action.LeaveMap`/`FadeOut`/
  `WarpOut`/`SwooshOut`, which clear `unit.position` via `game.leave()` —
  they never remove the unit from the registry. Concretely this dropped
  Seth from the party forever: Ch.5's intro event (`5_Intro.json`) does
  `add_unit;Seth;...` then `remove_unit;Seth;immediate` to stage a
  cutscene-only appearance, and the buggy `remove_unit` deleted the
  persistent player unit outright instead of just clearing his map
  position, so he silently vanished from `game.units` (and from all
  future prep/base/convoy access) instead of remaining an off-map reserve
  member. All four handlers now only clear `unit.position`/board presence.
  Also upgraded `restoreGameState`'s per-unit restore failure from
  `console.warn` to `console.error` (`src/engine/save.ts` ~1298) since a
  unit failing to restore means it silently disappears from the game —
  too serious to be an easily-missed warning.
- [x] **Settings `Text Speed` had no effect on dialogue typing.** *(Fixed)*
  `EventState` now passes `_setting_text_speed` into `Dialog`, and dialog typing
  now uses LT-style time-based cadence (ms-per-character, including `0` = instant).
- [x] **Some Ch.5 destructible village events failed to fire from `DestroyVillageX` regions.** *(Fixed)*
  Event conditions in default data can target sibling `VillageX` NIDs while the
  interaction region is `DestroyVillageX`. Added compatibility fallback for
  Destructible triggers to retry with sibling region context when needed.
- [x] **Chest/Door region checks could crash in menu state (`comps.some is not a function`).** *(Fixed)*
  `evaluateCondition(unit.can_unlock(region))` assumed item components were array-shaped,
  but runtime `ItemObject.components` is a `Map`. Added robust `Map`/array/object handling,
  support for `can_unlock` expressions, and region-prefix checks (`Chest`/`Door`).
- [x] **Talk command menu missed level-scoped conversations (e.g. Natasha→Joshua in Ch.5).** *(Fixed)*
  Talk option detection in `MenuState` called `getEventsForTrigger()` without
  `levelNid`, so level-specific `on_talk` events were filtered out. Added
  `levelNid` in both talk option discovery and talk target re-check.
- [x] **Harness chapter intros (Ch.2/Ch.3) intermittently soft-locked with empty top state.** *(Fixed)*
  `harness.loadLevel(clean=false)` was manually pushing `event` after `free`, while
  `FreeState` already auto-pushes `event` when level_start events exist. This could stack
  duplicate `EventState` instances and leave transient/empty state behavior in long intros.
  Fix: removed manual event push from harness and let normal state flow handle it.
- [x] **Animation combat sometimes shows cyan/red placeholder blocks.** *(Fixed)*
  `AnimationCombat` now waits in `init` until both sides resolve a real
  `mainFrame` (or timeout fail-safe), preventing first-load async sprite races
  from flashing stub rectangles at combat start.
- [x] **Harness mode blocked by project picker overlay.** *(Fixed)* When
  multiple `.ltproj` folders existed and `?project=` was omitted, the picker
  overlay prevented `window.__harness.ready` from ever becoming true. Harness
  mode now auto-selects `default.ltproj` (or first discovered project fallback)
  without redirect, restoring deterministic Playwright startup.
- [x] **First dialogue still renders over the portrait.** *(Fixed)* Dialog now
  auto-sizes to text content width and uses `get_desired_center()` mapping for
  portrait-aware horizontal positioning (matching Python).
- [x] **Combat animations at half speed sometimes.** *(Fixed)* Removed
  `Math.max(1, ticks)` override that tied animation speed to browser refresh
  rate. Animation ticking is now unconditional at the top of `update()`,
  matching Python's `update_anims()` pattern.
- [x] **Enemies leave blue rectangle at start position when attacking.** *(Fixed)*
  Added `highlight.clear()` in `FreeState.begin()`, `FreeState.end()`, and
  `TurnChangeState.begin()` to match Python's highlight cleanup lifecycle.
- [x] **Lose cursor control after combat.** *(Fixed)* Added finished-unit
  check to `WeaponChoiceState.begin()` with `'repeat'` return, plus added
  `'repeat'` to all dead-unit early-exit paths in MoveState, MenuState, and
  TargetingState for instant state cascade.
- [x] **Red rectangle randomly appears during magic attack.** *(Fixed)* Cleared
  `this.targets` in `TargetingState.end()` to prevent stale red rectangle
  draw when CombatState (transparent) draws on top.
- [x] **Terrain platforms swap/move and sprites float in ranged/magic combat.**
  *(Fixed)* Three related bugs in combat animation platform/sprite positioning:
  1. `at_range` off-by-one — now computes `atRange = distance - 1` matching Python
  2. Sprites now receive `range_offset` and `pan_offset` so they track with platforms
  3. Shake direction negated for sprites (`-totalShakeX`) matching Python behavior
- [x] **Combat UI layout is wrong.** *(Fixed)* Corrected name tag dimensions
  (66x16, matching Python sprites), centered name text, fixed HP bar height
  (56→40px), adjusted Y positioning, and removed always-shown CRT row.
- [x] **Reinforcements arrive too early in Ch.1.** *(Fixed)* Changed event
  condition fallback from `true` to `false` — events with un-evaluable
  conditions are now skipped instead of fired. Added error logging to JS
  fallback evaluator.
- [x] **Portrait mouths keep moving after dialog text finishes scrolling.** *(Fixed)*
  Event dialog now toggles portrait talking based on dialog typing state
  (`typing` vs `waiting`) instead of only stopping on full dialog close.
- [x] **Cutscene background can be missing for first lines after `change_background`.** *(Fixed)*
  `change_background` now blocks event command progression until panorama load
  resolves, matching Python's synchronous behavior and preventing async race frames.

## Recent Changes

- **Touch-safe game layout:** responsive viewport sizing now preserves the
  engine's 240×160 minimum logical scene, preventing portrait layouts from
  clipping authored menus. Touch controls live in a dedicated dock outside the
  canvas, keeping dialogue, portraits, maps, and menus unobscured.

- **Startup feedback and recovery:** campaign startup now has a responsive,
  accessible progress surface with live status text. Database failures keep the
  error visible and offer focused Retry and Choose another campaign actions.

- **Web player shell:** the campaign launcher now has a responsive, accessible
  tactical presentation instead of an internal project list. Desktop play adds
  discoverable control help and fullscreen; touch play adds visible directional,
  select, back, info, and menu controls wired through the engine input queue.

- **Healing item EXP:** `heal_exp` now rewards actual HP restored, summed across
  unique targets with Python's internal-level and heal-constant formula. Direct
  and multi-target healing capture pre-use HP, and the existing action group
  reverses/redoes HP, EXP, uses, and wait state together.

- **On-hit status/resource hooks:** `self_status_on_hit`, `statuses_on_hit`, and
  `fatigue_on_hit` now apply once per successful strike in item-component order.
  Combat result snapshots include fatigue, so target fatigue and all granted
  statuses reverse and redo with the rest of combat.

- **Extra damage item hooks:** `damage_on_miss` now computes and applies its
  configured fraction of normal damage on misses, while `eclipse_fe7` reduces a
  hit target to 1 HP. Map and full-animation result paths share the behavior;
  focused goldens cover forced misses and exact FE7 Eclipse HP.

- **Forced-movement items:** combat hits now apply `shove`, `swap`, `pivot`, and
  `draw_back` through shared terrain/occupancy destination rules; end-combat
  shove/swap variants run once per participating item. Movement is action-backed,
  target restrictions suppress invalid commands, and focused coverage verifies
  blocked destinations plus hit/end-combat undo and redo.

- **Combat formula components:** damage, critical hit/avoid, attack speed, and
  defense speed now honor Python's exact skill-override, item-override,
  skill-alternate, item-alternate, default precedence. Missing item and skill
  hook surfaces are wired, defensive formulas receive the attacking item, and
  critical accuracy defaults to `CRIT_HIT`. A pure regression covers all four
  precedence layers for each formula family.

- **Item fatigue hooks:** `fatigue` now records a reversible bounded fatigue
  action after direct item use and once per item that participates in initiated
  combat; counterattack-only use remains excluded like Python. Focused item-flow
  and lifecycle regressions cover consumption, wait finalization, counter
  exclusion, and combined mana/fatigue undo and redo.

- **Attack-only brave weapons:** strike-count calculation now preserves
  initiating-versus-defending combat mode, so `brave_on_attack` adds one strike
  only when its wielder initiates. The focused combat golden proves the same
  weapon remains single-strike on a counterattack while ordinary brave behavior
  remains unchanged.

- **Forced reclass items:** `force_class_change` is now a real core item-use
  effect, applies the existing reversible class-change mechanics to each
  resolved target, and participates in normal use consumption and unit wait
  finalization. The focused item-flow regression drives the self-target menu
  path and proves class, level, EXP, item ownership, and turn state across
  undo/redo.

- **Post-combat mana items:** `gain_mana_after_combat` now evaluates once for
  each item used in combat with Python's unit/target/position context, truncates
  the result, clamps against the `MANA` equation, and records a reversible mana
  action. `set_current_mana` now uses the same bounded action contract instead
  of mutating a dynamic field directly. Focused lifecycle and event-command
  regressions cover multi-strike de-duplication, clamping, undo, and redo.

- **Multi-item child menus:** selecting a `multi_item` now opens its real child
  list, BACK returns to the parent inventory menu, and choosing a child routes
  that child through normal targeting or direct-use resolution. Parents with
  `multi_item_hides_unavailable` omit unusable children; ordinary parents keep
  them visible but disabled. The focused browser regression covers both policies
  and completes a child heal end to end.

- **Expression-driven item targets:** `target_specific_tile` now evaluates its
  Python expression with the acting unit, item, position, game, and variable
  context; recursively flattens nested position lists; and rejects malformed
  or off-map results before normal range and restriction filtering. The focused
  target-system regression covers nested, duplicate, malformed, and off-map
  results.

- **Action and save/restore parity complete:** persistent event, base, shop,
  roam, overworld, record, achievement, support, phase, combat, and unit
  mutations now use reversible actions with exact undo/redo regressions. Saves
  now preserve full state stacks, queued standard/PYEV1 event progress,
  initiative order, active overworld state, records, supports, fog, and roam;
  suspend saves delete after load, start saves retain restart snapshots, and
  legacy saves default missing aggregate fields safely. Focused save, command,
  achievement, roam, and overworld suites plus the serial full-suite gate cover
  the cutover.

- **Event command flag parity complete:** `end_skip` restores normal blocking;
 transitions, dialogs, portraits, camera commands, unit/group/overworld movement,
 death, EXP, map animations, overlay sprites, and event-owned menu entry now
 distinguish their Python blocking, `no_block`, `immediate`, `silent`, and skip
 boundaries. No-banner mutations remain action-backed. The focused suite covers
 blocking and nonblocking command chaining across all presentation categories.

- **Deferred trigger paths complete:** wired `event_after_initiated_combat`
  through the real attacker/strike-partner skill-before-item combat lifecycle,
  and `event_on_remove` through a first-do-only reversible removal seam.
  `during_unit_level_up` now interrupts and resumes the level screen at
  `level_up_wait` for combat EXP, stat changes, class changes, and promotions,
  then preserves the late `unit_level_up` order. Focused hidden-hook and
  level-up-trigger browser specs cover payloads, ordering, resume, and
  undo/redo; build and parity audit pass.

- **Shop pricing hooks:** implemented Python-compatible `full_price`,
  `buy_price`, and `sell_price` resolution, including last-active item
  overrides, conditional buy/sell skill modifiers, remaining-use scaling,
  configurable sell modifier, and final truncation. Shop display,
  affordability, purchase, and sale paths now share the same pricing policy.
  Covered by the focused `shop price hooks` regression; build and parity audit
  pass.

- **Agent workflow made token-efficient:** replaced the historical 576-line
  architecture narrative in `AGENTS.md` with a focused contribution guide:
  bounded discovery, Python-to-web routing, risk-based verification, generated
  artifact ownership, minimal PLAN updates, and dirty-tree-safe staging.

- **Zero-usage command batch 19 — ending cards: EVENT-COMMAND DISPATCH
  COMPLETE (255/255 recognized, 255/255 dispatched).** `ending` and
  `paired_ending` render a title-banner card with the standard typed dialog,
  blocking until dismissed like Python; portrait translucency compositing is
  a documented deviation. Fixed a real sequencing bug found by the test:
  advancing the pointer at dialog creation double-stepped and skipped the
  following command (the dismiss path already advances, matching speak).
  1 regression (both card types chained + resume). Every Python event
  command now parses AND dispatches.


- **Zero-usage command batch 18 — dialog alias family (implemented solo):**
  `say` (multi-segment {sub_break} join into the speak path), `speak_style`
  (style registry stored; consumption beyond storage is a documented
  deviation), `pop_dialog`, `unhold`/`unpause` (single-dialog model resumes
  a waiting box; multi-box holds deviation), `main_menu` (chapter-end flag),
  and `change_special_music` (title music persists via localStorage like
  Python RECORDS; others as reversible game vars). Dispatch now **253/255**;
  only `ending`/`paired_ending` remain (character-ending card presentation,
  strict-mode loud-fail with notes). 1 regression across the family.


- **Zero-usage command batch 17 — change_roam_ai (implemented solo):
  EVENT-COMMAND SURFACE COMPLETE (255/255 recognized).** `unit.roamAi` field
  with save persistence (closes the deferred roam_ai save row), reversible
  `ChangeRoamAiAction` with Python's db.ai validation, and a minimal NPC
  roam-AI updater in FreeRoamState (Wait and Move_to-starting-position
  behaviours on a roam_speed cadence; tile-stepped rather than Python's
  pixel-smooth movement, Interact/Move_away deferred — all documented).
  1 regression (set/validate/undo/save round trip). Every Python event
  command is now parser-recognized; strict mode loud-fails nothing but
  genuinely absent sub-features within implemented commands.


- **Zero-usage command batch 16 — open_unit_management (implemented solo):**
  new reachable `base_manage` state: party unit list -> per-unit options
  (Trade with a partner picker feeding the direct-trade path; Supply via the
  existing supply state). Python's Restock/Give all/Optimize/Use/Market
  options are documented deviations (no base restock/market plumbing).
  1 end-to-end regression (unit -> trade partner -> trade state -> back out
  -> event resume). Parser 254/255; the single remaining command is
  change_roam_ai, blocked on an NPC roam-AI dispatch subsystem.


- **Zero-usage command batch 15 — party_transfer (implemented solo):** new
  reachable `party_transfer` dual-roster state with staged reassignment,
  fixed-unit locks, per-side limits (0 = unlimited), cursor navigation,
  cancel-discard, and confirm applying reversible per-unit party
  reassignments before resuming the event. 1 end-to-end regression
  (fixed/limit refusals, apply, resume, undo). Parser 253/255; final 2:
  open_unit_management and change_roam_ai (roam-AI dispatch).


- **Zero-usage command batch 14 — open_bexp_menu + BEXP states (implemented
  solo):** new reachable `base_bexp_select` (party roster with Python's
  maxed/auto-promote exclusion) and `base_bexp_allocate` (stage EXP with
  +1/-1/max/reset; cost from the BONUS_EXP equation or Python's
  50*internal+50 default; per-point cost is proportional-with-ceil — the
  stepped boundary rounding of Python's table is a documented approximation)
  confirming through reversible SpendBexpAction + GainExpAction (level-ups
  included). Also closes the P5 base BEXP row. 1 end-to-end regression
  (select -> stage -> confirm -> double-undo). Parser 252/255; final 3:
  unit management, party_transfer, roam-AI dispatch.


- **Zero-usage command batch 13 — pose_unit (implemented solo):** per-unit
  `poseOverride` applied set-then-draw in both renderers so cache-shared
  MapSprite instances stay correct; Python pose mapping (normal clears,
  active stands, moving/stand_dir require a validated direction;
  start_cast/end_cast deferred — no cast frames in web map sprites).
  1 regression (set/validate/clear/deferred-warn). Parser 251/255; the
  final 4 are large UI builds (unit management, BEXP menu, party_transfer
  roster, roam-AI dispatch).


- **Zero-usage command batch 12 — set_custom_options (implemented solo):**
  Python's four reversible game-var writes plus full consumption: the free
  option menu inserts custom entries before 'Options' (disabled per
  `_custom_options_disabled`) and selecting one fires its configured event.
  Also demoted the misleading runtime ComponentInventory log to debug with
  an honest caption (its hook-export known-set cannot see direct-read
  implementations). 1 regression (vars + menu insertion + event firing +
  disabled gating). Parser 250/255; the final 5 are UI subsystem builds
  (unit management, BEXP, party_transfer, pose sprites, roam-AI dispatch).


- **Zero-usage command batch 11 — change_team_palette (implemented solo):**
  runtime team-palette overrides (`GameState.teamPaletteOverrides` with
  `getTeamPalette`/`getTeamCombatColor` helpers consulted ahead of DB team
  defs), reversible `ChangeTeamPaletteAction` that rebuilds map sprites via
  the palette-keyed cache, and validation warnings matching Python.
  Combat-variant battle-anim palettes remain a documented deferral.
  1 regression (override/undo/invalid-team). Parser 249/255; the final 6
  are UI builds (unit management, BEXP, party_transfer, pose sprites,
  custom options, roam-AI dispatch).


- **Zero-usage command batch 10 — change_bg_tilemap (implemented solo):**
  background tilemaps: `GameState.bgTilemap` mirrored onto a new
  `MapView.bgTilemap` render pass beneath the main layers, a reusable
  `buildTilemapObject()` loader extracted from level load, and a reversible
  `ChangeBgTilemapAction` (swap/restore incl. clear). The web applies on
  async tileset load rather than Python's preloaded-synchronous swap
  (timing-only deviation documented). 1 regression (set/undo/clear with
  state-based waits). Parser 248/255; remaining 7 are UI subsystem builds.


- **Zero-usage command batch 9 — text_entry state (implemented solo):**
  new reachable `text_entry` state (`src/engine/states/text-entry-state.ts`)
  driven by the `text_entry` event command with Python's full parameter set
  (var nid, header, character limit, illegal-character list, default string,
  minimum length, `force_entry` cancel gate). Real-keyboard typing replaces
  Python's grid letter menu (documented presentation deviation); confirmed
  text lands reversibly via `SetGameVarAction` exactly like Python. Also
  checks off the P5 text-entry row. 2 regressions covering limits/illegal
  chars/backspace/confirm round-trip and min-length + force_entry gating.


- **Zero-usage command batch 8 — repair shop, cleanup, formation (implemented
  solo):** `enable_repair_shop` (reversible game-var toggle),
  `force_chapter_clean_up` (Python clean_up(full=False) per-unit semantics
  inline — heal/off-map/reset without cleanUpLevel's transition registry
  hand-off, which Python does not do here), and `arrange_formation`
  (Required-first placement of eligible off-map party units onto open
  formation-region spots with Blacklist/traveler/fatigue exclusions).
  3 regressions. Parser now 246/255; the 9 remaining are all UI/subsystem
  builds (unit management, BEXP, party_transfer, text_entry, pose sprites,
  team palettes, custom options, bg-tilemap swap, roam AI).


- **Zero-usage command batch 7 — unit map animations (implemented solo):**
  `add_unit_map_anim`/`remove_unit_map_anim` on the existing map-animation
  pipeline: `MapAnimation` gains `followUnit` tile-tracking (re-centered
  every frame in map-view; auto-finishes if the unit leaves the map),
  permanent attachments go through reversible `AddAnimToUnitAction`/
  `RemoveAnimFromUnitAction`, transient plays run once at the unit tile.
  `blend` compositing remains a documented deviation. 1 regression covering
  attach/follow/remove/double-undo.


- **Zero-usage command batch 6 — fatigue + region generics (implemented
  solo):** `add_fatigue` with a new `UnitObject.currentFatigue` field
  (reversible `ChangeFatigueAction` clamped at 0, save/load persistence —
  closes the previously non-applicable `current_fatigue` save-field row) and
  `remove_generics_from_region` (region-rectangle sweep off-mapping generics
  via a reversible `LeaveMapAction`, named units untouched). 2 regressions
  covering floor/undo/round-trip and region-scoped removal with undo.
  Remaining parser-missing commands (~14) are all blocked on absent
  subsystems (map-anim overlays, formation/unit-management/BEXP UI, team
  palettes, pose sprites, time regions, tilemap swap, custom options,
  party_transfer UI) — each strict-mode loud-fails with documented reasons.


- **Zero-usage command batch 5 — party/generic/loop (implemented solo):**
  `recruit_generic` (reversible persistent conversion with registry re-key,
  name set, exact undo), `merge_parties` (reversible composite moving units,
  convoy, money, and BEXP guest->host with exact reverse), and `loop_units`
  (expression or comma-list of nids; queues the target event once per unit
  in order on nested EventStates, then resumes the parent; arbitrary Python
  comprehensions remain a documented deviation). 3 regressions incl. the
  merge round-trip and per-unit loop-body execution. `party_transfer` stays
  deferred (interactive dual-roster UI).


- **Zero-usage command batch 4 — component modification (implemented solo):**
  `add/modify/remove_item_component` and `add/modify/remove_skill_component`
  via a shared reversible action trio over the runtime component Maps
  (Python action.py Add/Modify/RemoveItemComponent semantics: dict-property
  targeting, additive numeric mode, exact restore incl. absent-key deletes).
  Item variants use `findInventoryItem` (convoy + recursive); skill variants
  honor Python's `stack` flag across same-nid instances. Values evaluate
  through the shared event `evaluateExpression`. 2 regressions covering the
  full add→modify→remove→triple-undo ladder and stacked-skill application.


- **Zero-usage command batch 3 — roaming + scripts (implemented solo):**
  `change_roaming` (with Python's first-free-action turnwheel reset),
  `change_roaming_unit` (missing unit clears), `clean_up_roaming` (off-maps
  everyone but the roam unit; Python-documented as not turnwheel-safe;
  initiative reseeded when enabled), and `trigger_script`/
  `trigger_script_with_args` (nid-or-name lookup, unit1/unit2 context
  inheritance, k=v local-args parsing, parent event pauses on a nested
  EventState and resumes after). 4 regressions. `change_roam_ai` deferred:
  the web has no NPC roam-AI dispatch, so `unit.roam_ai` would be dead state.


- **Zero-usage command batch 2 — open_* menus (implemented solo):**
  `records_screen`, `open_library`/`open_guide` (gated on matching unlocked
  lore per Python; direct-entry deviation noted for the non-immediate
  transition variant), `open_credits`, `soundroom`, and `open_trade`
  (direct two-unit trade via a new `trade_partner` memory handoff into
  `TradeState`, bypassing the adjacency menu like Python). 5 regressions
  added to `tests/event-commands-3.spec.ts`. `open_unit_management` and
  `open_bexp_menu` remain parser-missing (no unit-management state; BEXP
  disabled in bundled projects).


- **Zero-usage command batch 1 (implemented solo):** `set_skill_data` (reversible
  `SetSkillDataAction`), `set_mode_rng`/`set_mode_autolevels` (validated
  DifficultyModeObject fields incl. hidden/boss routing), `show_minimap`
  (blocks the event on the existing minimap state, resumes on close),
  `set_game_board_bounds`/`remove_game_board_bounds` (new Python-shaped
  `GameBoard.bounds` with movement filtering in `getValidMoves`, reversible
  `SetGameBoardBoundsAction`, save/load persistence — unblocks the P2
  bounds save-field row), `dump_vars` (console dump; file-open deviation
  documented), and `delete_save` (slot + suspend via the async save API).
  8 regressions in `tests/event-commands-3.spec.ts`. Deviation: set_skill_data
  evaluates literal numbers/bools rather than arbitrary Python expressions.


- **Audit-tooling fix: direct component reads now count as implementation
  evidence (implemented solo):** `scripts/parity-audit.mjs` gains a
  direct-consumption scanner (`getComponent(...)`/`hasComponent('nid')`
  call sites) feeding a new `consumed` structural status between hook-mapped
  and reference-only, a Direct-reads manifest column, and summary lines.
  Result: 109/201 item and 48/241 skill components show direct reads —
  previously-misleading rows like `wexp`, `value`, and `level_exp` (all fully
  implemented) no longer classify as reference-only. Closes the tooling gap
  filed by the component-usage audit; drift guard unaffected (counts only
  rise). Audit and build green.


- **Wire remaining trigger stragglers (P1):** Wired `on_base_convo` and
  `overworld_start` triggers; deferred `event_after_initiated_combat` and
  `event_on_remove` as component-based-only (no engine dispatch path).
  1. *on_base_convo* (triggers.py:282): Fired in BaseConvosState.takeInput when
     a base conversation is selected; payload includes `base_convo` (the nid)
     and deprecated `unit` field (same nid). Wire location: `src/engine/states/base-state.ts:481-496`.
  2. *overworld_start* (triggers.py:73): Fired in OverworldFreeState.start() after
     setup; no payload fields. Guard on null eventManager (same pattern as
     on_title_screen). Wire location: `src/engine/states/overworld-state.ts:114-122`.
  3. *roam_press_start/info/aux* (triggers.py:352-370): **Already wired** in
     FreeRoamState.checkStart/checkInfo/checkAux as a previous P5 slice; no
     changes needed. Firing pattern: fires trigger with unit1/unit2, falls back
     to menu if no event intercepts.
  4. *event_after_initiated_combat* (triggers.py:445): **Deferred** — this is a
     hidden, component-based trigger (EventAfterInitiatedCombat skill component
     calls `trigger_specific_event` directly; Python never unconditionally
     fires this trigger). No engine dispatch path exists. Web skill component
     not yet implemented; revisit when porting EventAfterInitiatedCombat.
  5. *event_on_remove* (triggers.py:460): **Deferred** — this is a hidden,
     component-based trigger (EventOnRemove skill component calls
     `trigger_specific_event` directly; Python never unconditionally fires this
     trigger). No engine dispatch path exists. Web skill component not yet
     implemented; revisit when porting EventOnRemove.
  - Updated EventTrigger interface to include `baseConvo`, `unit` fields
    (on_base_convo payload).
  - New spec: `tests/trigger-dispatch-3.spec.ts` (5 tests) — base-convo
    selection, overworld entry, roam key presses with closest-unit placement,
    each capturing trigger type+payload via monkey-patch.

- **Seeded soak execution (P7):** ran the soak tooling for real across three
  scopes, all green with zero failure artifacts: Sacred Stones suites x3
  iterations (seeds 7000-7002, 42 tests each), harness spec x2 (seeds
  8100-8101, 95 tests each), and the TRUE full suite x2 (seeds 8200-8201,
  362 passed + 1 skip each). Found and fixed a soak-script limitation while
  doing it: the runner hardcoded tests/harness.spec.ts, so "full-suite" runs
  silently shrank; added SOAK_SPECS (space-separated paths; empty = whole
  test dir). P7 soak row satisfied for the bundled-demo scope.


- **Platform lifecycle validation slice (P7 row: 'Test desktop, responsive touch, offline PWA, asset bundle, and native lifecycle'):**
  Implemented browser-testable platform lifecycle checks via a new `tests/platform-lifecycle.spec.ts` spec (16 tests, all passing).
  Covers four areas of the platform contract:
  1. *Responsive/touch*: Tests that window resize and zoom operations do not crash the app; simulates tap-to-select on canvas via touchscreen API in a browser context with `hasTouch` enabled.
  2. *PWA/offline structural*: Verifies that `dist/sw.js` (service worker) exists and has meaningful content; `dist/precache-manifest.json` is valid with entries; `public/manifest.json` parses as valid PWA manifest with required fields (`name`, `short_name`, `start_url`, `display`, `icons`).
  3. *Asset bundle*: Confirms that `bundle=false` query param bypasses bundle loading; fetch and image loader structural paths are reachable and don't crash without a real bundle; AssetBundle module exports are accessible.
  4. *Native lifecycle structural*: Tests that pause/resume visibility-change handlers invoke without error in browser context (they no-op gracefully); platform detection (`isCapacitor`, `isTwa`, `getPlatform`) returns browser-appropriate values; wake lock and visibility state changes don't crash.
  Platform features genuinely untestable in Playwright (real offline SW interception, install prompt flow, Capacitor device APIs, real bundle zip loading) are documented as covered-by-structure-only.
  New spec file: `tests/platform-lifecycle.spec.ts` (16 tests).
  Files changed: `tests/platform-lifecycle.spec.ts` (new).
  Gate: all 16 new tests passing; `npm run build` green with precache manifest generation logged; full serial gate passing (362 passed + 1 intentional skip after this slice).

- **Final parity report published (P7):** ✓ COMPLETE. Consolidated evidence from PLAN.md,
  runtime-inventory.md, resolve-policies.md, and all manifest JSON files into a single
  comprehensive audit at `docs/parity/PARITY-REPORT.md`. Report includes: (1) verified
  domains table with counts and verification methods (17 domains tracked, 32/41 triggers
  wired after P1 stragglers); (2) 22-entry accepted-deviations registry (fixed bugs,
  documented approximations, intentional simplifications); (3) known gaps categorized
  by scope (44 parser-missing commands zero usage, 53 dispatcher-missing, 4 deferred
  triggers, 2 low-risk unreferenced, 9 large-scope deferrals); (4) completion-gate
  checklist with evidence for each P0-P7 (all gates met); (5) "Changes since draft"
  section documenting P1/P5 trigger wiring, new features landed, gaps closed;
  (6) regeneration instructions. Confirmed: `npm run audit:parity` green (100 TS files,
  60,159 lines, 211/255 parser, 202/255 dispatched, 135/201 items, 84/241 skills);
  `npm run build` green with 27-entry precache manifest; 40 spec files, 368 tests (367 passed + 1 skip),
  1 intentional skip. File: `docs/parity/PARITY-REPORT.md`.

- **Remove silent skips for known commands/components (P7):** Unrecognized event
  commands and unimplemented item/skill component NIDs now fail loudly in
  development (strict mode enabled via `?strict=true` URL param or `import.meta.env.DEV`)
  while remaining graceful in production builds.
  1. *Strict-mode module*: New `src/engine/strict-mode.ts` exports
     `reportUnimplemented(kind, nid, context?)` which deduplicates warnings
     (console.warn once per unique nid) and throws an Error in strict mode with
     the NID and context. Consumed at three sites: (a) `GameEvent.parseCommand`
     (`src/events/event-manager.ts:376`) for unknown commands; (b) `EventState`'s
     default case (`src/engine/states/game-states.ts:11694`) for dispatched-but-
     unhandled commands (double-check for late-added commands post-parse); (c)
     load-time item/skill component inventory warnings (new).
  2. *Load-time summary*: `loadProject` in `src/data/loaders/load-project.ts` now
     collects unknown component NIDs from items and skills DB via a new
     `collectUnknownComponents(db)` helper and logs a single summary line
     listing them (if any found), helping project authors immediately spot
     unimplemented dependencies.
  3. *No strict-flag default in tests*: The `?strict` flag is NOT set by default
     in harness-mode Playwright tests — bundles may intentionally reference
     unimplemented components, and strict mode must be opt-in for reproducible
     CI (tests must stay green). Strict mode is used in the new dedicated spec
     (`tests/strict-mode.spec.ts`) to verify error behavior, not in general
     regression harness.
  4. *Tests*: New `tests/strict-mode.spec.ts` (3 tests) verifies: (a) without
     strict, unknown-command event warnings deduplicate and advances; (b) with
     `?strict=true`, same event throws in EventState's dispatch; (c)
     load-time summary lists an injected bogus item component NID.
  Files changed: `src/engine/strict-mode.ts` (new), `src/events/event-manager.ts`
  (wire reportUnimplemented into parseCommand unknown-command path),
  `src/engine/states/game-states.ts` (wire into EventState default case),
  `src/data/loaders/load-project.ts` (add collectUnknownComponents + summary log),
  `tests/strict-mode.spec.ts` (new, 3 tests).
  Deferred: component-specific strict validation (e.g. verifying component value
  types match registered schemas) — left for follow-up hardening pass.
  Full serial gate after changes: green (all 320 baseline tests pass).

- **Resource-path fixtures: URL encoding, chunked/non-chunked fallback, panoramas,
  optional assets (P6):** Structural test suite validating resource loading across
  fixture projects and URI encoding edge cases.
  1. *URL encoding*: `ResourceManager.resolveUrl()` already encodes each path segment
     with `encodeURIComponent()` (applied at construction, not dynamically per call).
     New test coverage for spaces, Unicode characters (e.g., `Eirika Ω`), special
     characters (`#`, `?`), while preserving forward-slash separators — 4 distinct
     encoding assertions, all passing. Confirms: "Sacred Stones" → `Sacred%20Stones`,
     `Ω` → `%CE%A9`, `#` → `%23`, `?` → `%3F`.
  2. *Chunked vs non-chunked fallback*: Database loader (`loadChunked`) tries
     `.orderkeys` directory form first (individual JSON files per NID), then falls
     back to single-file JSON array (e.g., `items.json` vs `items/.orderkeys` +
     `items/{nid}.json`). Tested against both projects: `testing_proj` uses chunked
     (verifies `Iron_Sword` loads from chunked format); `rekka` uses non-chunked
     (verifies item/skill counts > 0 from single JSON). Combat palette loader shows
     the same pattern: tries `combat_palettes/palette_data/.orderkeys` then falls
     back to `combat_palettes.json`. No new bugs found — fallback logic already
     correct in `src/data/database.ts` (`loadChunked` → `loadNonChunkedArray`) and
     `src/data/loaders/combat-anim-loader.ts`.
  3. *Animated panorama fallback*: Game state (`game-states.ts`) tries
     `title_background.png`, falls back to `title_background0.png` for animated
     sequences. Tested: `tryLoadImage` accepts nonexistent paths gracefully,
     returning null instead of throwing — no exception raised on 404. Existing
     code pattern is correct (try → fallback to → null).
  4. *Missing optional assets*: Five tests covering graceful null returns:
     `tryLoadMapSprite` for missing stand/move sheets, combat effect spritesheets
     via `tryLoadImage`, `tryLoadJson` for nonexistent JSON, and combat palette
     loader's empty-on-missing behavior. All return null/empty map respectively
     instead of throwing. Two real optional-asset call sites verified:
     `tryLoadMapSprite()` (map sprites, both optional per `tryLoadMapSprite` API)
     and effect spritesheet loading (combat effects).
  New spec `tests/resource-paths.spec.ts`: 18 tests in 6 test groups covering URL
  encoding (4 tests), chunked/non-chunked (3 tests), panorama fallback (2 tests),
  missing optional assets (5 tests), cross-project consistency (3 tests), and
  real usage contexts (1 test). All 18 pass against `default.ltproj`,
  `testing_proj.ltproj`, and `rekka.ltproj`. No bugs found or fixed — resource
  loading is working correctly. Deferred: bundle asset verification (already
  covered by existing soak and compatibility tests).

- **Initiative bar, rescue/status icons, movement arrows UI (P5):** Ported
  three previously-missing map UI pieces.
  1. *Movement arrows* (`app/engine/level_cursor.py` `LevelCursor.
     construct_arrows`/`Arrow`): `src/rendering/movement-arrows.ts`
     `computeArrowSegments()` ports the exact start/through/end/corner
     segment-selection switch (same `(col, row)` sprite-sheet coordinates as
     Python's `Arrow(x, y, position, idx)`, keyed off `direction`/`modifier`
     tile deltas) and `ArrowRenderer` blits the `movement_arrows` sprite
     sheet (`public/sprites/movement_arrows.png`, copied from `lt-maker/
     sprites/`) with an alpha pulse approximating Python's `sin(radians(
     (get_time()//5 - idx*6) % 180))`-driven color blend (exact per-pixel
     `change_color`/`blend_colors` tinting is not reproduced — noted as an
     accepted deviation, timing/segment identity is what's tested).
     `MoveState.draw` (`src/engine/states/game-states.ts`) now calls this
     instead of the old flat white-rectangle path preview. `GameState` owns
     one `arrowRenderer: ArrowRenderer` instance, sprite loaded eagerly like
     the cursor sprite.
  2. *Rescue/status map-sprite icons* (`app/engine/unit_sprite.py`
     `UnitSprite.draw_hp`): `src/rendering/unit-markers.ts` `UnitMarkerIcons`
     ports the icon block — Boss/Elite/Protect tag icon blinking at Python's
     exact `int((time % 450) // 150) in (1, 2)` timing (450ms period, hidden
     1/3 of the time; `elite_icon.png` isn't present anywhere in the checked-
     in `lt-maker/sprites/` tree so that variant silently no-ops, matching
     Python's `SPRITES.get` returning `None`), the rescue/pairup marker
     (colored by the *traveler*'s team `combat_color`, suppressed when the
     `pairup` constant is on, same as Python), and the droppable-item marker.
     `combat_color` was plumbed through `TeamDef`/`Database.teams` (previously
     only `map_sprite_palette` was parsed from `teams.json`). Wired through
     `collectVisibleUnits()` → `MapView.draw()`/`drawUnits()` → `UnitMarkerIcons.
     draw()`, one `GameState.unitMarkers` instance, icons loaded from
     `public/sprites/{rescue_icon_*,boss_icon,protect_icon,droppable_icon}.png`.
  3. *Initiative bar* (existing `src/engine/initiative.ts` `InitiativeTracker`
     data model + `MoveInInitiativeAction`/turnwheel slice, previously
     undrawn): `HUD.drawInitiativeBar()` (`src/ui/hud.ts`) renders a
     horizontal chip row from `game.initiative.unitLine`/`currentIdx` (deviation
     from Python's chibi-portrait strip — colored/labelled chips instead,
     since chibi assets aren't guaranteed for every unit), gated on
     `initiative.drawMe && unitLine.length > 0` so projects without the
     `initiative` constant see no change (the tracker itself is only
     constructed when `db.getConstant('initiative', false)` is true, per
     existing `GameState` code). Reads live tracker state every frame, so it
     reflects `MoveInInitiativeAction`/turnwheel mutations with no extra
     wiring.
  New spec `tests/map-ui.spec.ts` (8 tests): arrow segment-kind assertions
  (straight/corner/start/end) against `computeArrowSegments` directly, an
  in-harness check that a hovered valid destination produces one segment per
  path tile, the boss-icon blink timing table, a rescue-marker/`pairup`-gate
  check, and an initiative-bar test using a duck-typed tracker fixture (same
  shape `InitiativeTracker` exposes) mutated via a `MoveInInitiativeAction.
  execute()`-equivalent splice/insert to verify order updates. All 8 pass
  twice consecutively. Deferred: pixel-exact arrow tint animation (see above),
  chibi-portrait initiative strip, Elite icon asset (missing from source
  tree, not something to fabricate).

- **Soak automation: deterministic seed sweep + first-failure archiving (P7):**
  Extended `scripts/sacred-stones-soak.mjs` (previously a plain fail-fast loop
  over `npx playwright test`) with two additions.
  1. *Seed threading*: RNG state (`_random_seed` in `game.gameVars`, read by
     `src/engine/static-random.ts` and `src/engine/leveling.ts`) defaults to
     `0` on every page load unless a test sets it explicitly, so repeated soak
     runs previously always walked the same seed-0 RNG path. `SOAK_SEED_BASE`
     now sweeps a distinct seed per iteration
     (`SOAK_SEED_BASE + iterationIndex`). Mechanism: the soak script writes
     `public/soak-seed.json` (`{"seed": N}`) before each iteration;
     `src/main.ts`'s harness bootstrap (in the `if (harnessMode)` block, right
     after `installHarness`) fetches `/soak-seed.json` whenever the URL has no
     explicit `?seed=` param and applies it via `gameState.gameVars.set`,
     clearing derived `_combat_random_seed`/`_growth_random_seed` state. This
     required no changes to any of the 40+ hardcoded `page.goto('/?harness=
     true&...')` calls across spec files, and does not disturb the 8 existing
     tests (`rng-replay.spec.ts`, a few in `harness.spec.ts`) that pin their
     own seed explicitly via `page.evaluate` — their explicit call runs later
     and simply overrides the sweep's seed. The file is removed after the
     run (and cleared between unseeded iterations), so a normal
     `npx playwright test` run never sees it (404s harmlessly).
  2. *First-failure archiving*: on the first failing iteration (fail-fast
     behavior unchanged — the loop still stops immediately) the script now
     archives `soak-artifacts/<ISO-timestamp>/{SUMMARY.txt, env.json,
     playwright-output.log, soak-seed.json, test-results/}` before exiting
     nonzero. `SUMMARY.txt` includes a ready-to-paste repro command
     (re-creates the exact `public/soak-seed.json` used, then re-runs just
     that grep/seed/workers combination outside the soak loop).
  - Wired `test:soak:seeded` npm script (`SOAK_SEED_BASE=1000` +
    `test:ss:soak`); `TESTING.md`'s soak section documents both additions.
  - `soak-artifacts/` and `public/soak-seed.json` added to `.gitignore`.
  - Demo: ran `SOAK_ITERATIONS=3 SOAK_SEED_BASE=42 SOAK_GREP="DEBUG Level
    \(clean\)" npm run test:ss:soak` — 3/3 green iterations at seeds 42/43/44.
    Then temporarily broke an assertion in `harness.spec.ts` (`initial map
    render`), reran the same command, confirmed
    `soak-artifacts/<timestamp>/` was created with all five expected files,
    correct seed (42) and repro command recorded, and the script exited
    nonzero — then reverted the deliberate breakage (`git diff` on
    `tests/harness.spec.ts` is clean).

- **Blocking/no-block and flag matching per event command (P1):** Audited
  `docs/parity/event-commands.json` (84 dispatched commands carry flags)
  against `lt-maker/app/events/event_functions.py` and real usage in
  `lt-maker/{default,rekka}.ltproj/game_data/events.json` (`grep`'d for
  `no_block`/`no_banner`/`immediate`/`FLAG(` occurrences). Findings table
  (command | flag | python | web before | action):
  - `give_item` / `remove_item` / `give_skill` / `remove_skill` /
    `break_item` / `give_money` / `give_bexp` | `no_banner` | Python appends
    an alert banner (`AcquiredItem`/`TakeItem`/`GiveSkill`/`TakeSkill`/
    `BrokenItem`/gold/BEXP text) and blocks (`state.change('alert')`) unless
    `no_banner` is set | web showed **no banner at all, ever**, for any of
    these seven commands (the flag was silently a no-op both ways) | **fixed**:
    each case now builds the Python-equivalent banner text, shows it via the
    existing `this.banner = new Banner(...); this.bannerIsAlert = true; return
    true` pattern (already used by `give_wexp`/`set_wexp`/`alert`) unless
    `no_banner` is present or `this.skipMode` is active, matching Python's
    `banner_flag` gate exactly. `break_item`'s banner is further gated on
    `unit.team === 'player'` per `item_system.alerts_when_broken` +
    `unit.team == 'player'` in Python. Real-usage stats: `no_banner` appears
    27+ times across `rekka.ltproj` (`give_skill`, `remove_skill`) and
    `set_wexp`/`give_wexp` no_banner usages in `default.ltproj` were already
    correct; the seven newly-fixed commands are used un-flagged (banner
    expected) dozens of times in `default.ltproj` (`give_item` alone: 228
    call sites), so the missing banner was a real, frequently-triggered
    visible gap.
  - `add_portrait`/`remove_portrait` | `no_block` | Python's `no_block` (and
    `immediate`) skips the `self.wait_time = ...; self.state = 'waiting'`
    block so the *next* event command runs before the portrait fade
    completes; without the flag the event blocks for one fade duration |
    web's `add_portrait` blocks only on the (near-instant) async image
    decode, never on the fade animation, and `remove_portrait` never blocks
    at all | **filed, not fixed** — both no-flag and `no_block` variants are
    heavily used in `default.ltproj` (167 no_block vs non-flagged remove,
    228 non-flagged vs a few no_block add), so this is a real classification
    gap, but reproducing "block until the fade completes" requires wiring
    portrait transition duration into the EventState wait-state machine,
    which is a materially larger, animation-timing-sensitive change than the
    banner fix and was left out of this pass to avoid destabilizing the
    272-test baseline right before the gate.
  - `center_cursor`/`move_cursor` | `immediate` | Python pans the camera to
    the target over time and blocks until the pan finishes, unless
    `immediate` skips the pan | web's cursor/camera jump is always instant
    (`cursor.setPos` + `camera.focusTile`, no animated pan implemented at
    all), so it already behaves as if `immediate` were always set | **filed,
    not fixed** — `default.ltproj` uses the flag explicitly twice and relies
    on the (unimplemented) animated-pan default elsewhere; fixing this needs
    a real camera-pan feature, out of scope for a flag-matching-only pass.
  - New spec `tests/command-flags.spec.ts`: paired with/without `no_banner`
    assertions for all seven fixed commands, using the event-injection
    pattern from `tests/event-flow.spec.ts` (`installAndRunEvent` +
    `triggerSpecific`) and a `game_var` set by the command immediately
    following the one under test as the observable — `no_banner` sets the
    marker within 5 frames; without it the marker is confirmed unset at 5
    frames and set only after the banner's ~3000ms/180-frame timer elapses
    (see the "Banner timer" block in `EventState.update`).

- **Audio verification: music stack, phase/battle music, SFX loops, settings (P6):**
  Audited `src/audio/audio-manager.ts` and every `game.audioManager` call site
  against `lt-maker/app/engine/sound.py` and `phase.py`. Audit table (area |
  python | web before | action):
  - Music stack (push/pop) | `ChannelPair`/ `SongStack`-style layered channels
    with independent fade in/out | already had a `musicStack: string[]` with
    `pushMusic`/`popMusic`/`playMusic`/`stopMusic` and crossfade-on-swap | kept
    as-is (already correct shape); added call-recording (`AudioManager.calls`)
    for verification.
  - Fade durations | `DEFAULT_FADE_TIME_MS = 400`, overridable per-channel |
    hardcoded 500ms everywhere | added parameterized `fadeIn(nid, fadeMs,
    fromStart)` / `fadeToPause(fadeMs)` using the Python-correct 400ms default
    for phase-music call sites; left the pre-existing 500ms default on the
    generic `playMusic`/`stopMusic` API for non-phase callers (sound room,
    base, overworld, game-over) since Python's own default is also just a
    constant with no single canonical value forced on every caller.
  - Phase-change music switching | `phase.py`: `PhaseChangeState.begin()` calls
    `fade_out_phase_music()` then `phase.slide_in()` (which plays
    `team.phase_change_sound_effect or 'Next Turn'`); `PhaseChangeState.end()`
    calls `fade_in_phase_music(at_turn_change=True)`; `FreeState.begin()` and
    `AIState.begin()` also call `fade_in_phase_music()` (plain) | **missing
    entirely** — `PhaseChangeState`/`FreeState`/`AIState` never touched music,
    so `player_phase`/`enemy_phase` level music fields were only ever applied
    once at level load | real divergence, fixed: added `fadeOutPhaseMusic`/
    `fadeInPhaseMusic` helpers in `src/engine/states/game-states.ts` (keyed off
    `level.music['{team}_phase']`, `_phase_music_fade_ms` game var, and the
    `restart_phase_music` constant) and wired them into `PhaseChangeState.begin`
    /`finish`, `FreeState.begin`, and `AIState.begin`; also added the
    `'Next Turn'` phase-change SFX in `PhaseChangeState.begin` (team-level
    `phase_change_sound_effect` overrides aren't modeled in the web `TeamDef`
    data yet — deferred, default-only for now).
  - Battle music override on combat entry/exit | Python crossfades between a
    `Channel` and a same-song `battle` sub-channel (`ChannelPair.crossfade()`)
    | web instead `pushMusic`/`popMusic`s a distinct `player_battle`/
    `enemy_battle` track in `CombatState` (game-states.ts ~4181/4869) | left
    as an accepted approximation (pre-existing, not newly introduced) — a true
    same-song crossfade channel model is a larger rearchitecture out of scope
    for this slice; the push/pop semantics still correctly restore phase music
    after combat.
  - SFX loop lifecycle (`playSfxLoop`/`stopSfx`, EXP-gain loop) | N/A (SFX
    loops are a web-specific `Experience Gain` UX addition) | already correct:
    `loopingSfx` map keyed by nid, no-op on double-start, `onended` cleanup |
    no change.
  - Volume settings (`set_music_volume`/`set_sfx_volume`) | applied to
    `Channel.global_volume` -> `reset_volume()` | `setMusicVolume`/
    `setSfxVolume` already wired from `settings-state.ts` into gain nodes |
    no change.
  - Files changed: `src/audio/audio-manager.ts` (added `calls` log,
    `fadeIn`, `fadeToPause`, `getCurrentMusicNid`, `clearCalls`, refactored
    `playMusic`/`stopMusic` to share fade-duration-parameterized internals),
    `src/engine/states/game-states.ts` (phase-music helpers +
    `PhaseChangeState`/`FreeState`/`AIState` wiring).
  - New spec: `tests/audio-parity.spec.ts` — call-recording assertions (no
    real audio playback assertions): event music command semantics
    (play/push/pop/fade-nid/fade-duration), phase music switching across a
    full player/enemy/player turn cycle, battle-music enter/exit restore,
    SFX loop start/stop lifecycle, volume setting application.
  - Deferrals: team-level `phase_change_sound_effect` override (web `TeamDef`
    has no such field — always uses the `'Next Turn'` default); true
    same-song crossfade battle-channel model (kept push/pop approximation);
    Canto/has-traded mid-turn `fade_in_phase_music()` call in
    `general_states.py:708` (edge case, not ported — units with canto
    remaining don't re-trigger a phase-music fade-in after acting).

- **Portrait/dialog/transition verification (P6):** Audited portrait expressions,
  blink timing, mouth animation, dialog text layout, and transition durations
  against `lt-maker/app/events/event_portrait.py` and `lt-maker/app/engine/
  dialog.py` and `transitions.py`. Audit table (area | python | web before | action):
  - Blink timing | `BLINK_PERIOD_BASE = 7000ms`, `BLINK_PERIOD_VARIANCE = 2000ms`,
    each frame duration `utils.frames2ms(3) = 50ms` | web has exact same constants
    (`BLINK_PERIOD_BASE = 7000`, `BLINK_PERIOD_VARIANCE = 2000`, `frames2ms(3)`)
    | verified parity, no change needed.
  - Mouth animation while talking | randomized state machine with durations:
    state 0→1: 30-50ms (90%) or 0→2: 70-160ms (10%); state 1→2: 70-160ms (90%)
    or 1→0: 50-100ms (10%); state 2→3: 30-50ms (80%) or 2→0: 50-100ms (10%)
    or 2→1: 30-50ms (10%); state 3→0: 50-100ms (100%) | web implements exact
    same logic with identical probability branches and duration ranges
    | verified parity, no change needed.
  - Expression commands (`expression;PortraitNid;ExpressionList`) | Python
    dispatches via `event_portrait.py:98-99` `set_expression` method | web
    dispatches in `src/engine/states/game-states.ts:10556` case 'expression'
    via `portrait.setExpressions()` | verified dispatched correctly, no change needed.
  - Dialog text layout / word-wrap width | Python: `text_width` clamped to
    `(48, WINWIDTH - 32)` (dialog.py:319), then box width computed as
    `text_width + 24 - text_width % 8` (line 320) | web uses content-driven
    auto-sizing `(80, maxBoxW)` with `maxBoxW = viewport.width - 8` | functionally
    equivalent (both constrain to reasonable bounds), implementation differs
    but no correctness divergence found.
  - Transition fade duration | Python: `TransitionInState.wait_time =
    transition_speed * 133` with default `transition_speed = 1`
    (`transitions.py:14, 7, 24`), so default = 133ms (8 frames at 60fps)
    | web had hardcoded 500ms default (`src/engine/states/game-states.ts:7161,
    8348`) | **real divergence, fixed**: changed both the default field
    (`transitionDurationMs: number = 133`) and the transition command handler
    default (line 8348) from 500ms to 133ms to match Python's 8-frame constant.
  - Files changed: `src/engine/states/game-states.ts` (transitionDurationMs
    default and transition command default), `src/events/event-portrait.ts`
    (exported BLINK_* constants for test access).
  - New spec: `tests/dialog-portrait.spec.ts` — 8 passing tests covering:
    blink period/frame constants, blink timing ranges, mouth state machine,
    expression command dispatch, dialog auto-sizing, transition duration formula,
    EventState 133ms default (verified fix), and system integration.
  - Deferrals: none — all areas verified correct after transition duration fix.

- **Roam talk/shop interaction and overworld option menus (P5):**
  - Read `lt-maker/app/engine/roam/free_roam_state.py` end to end and fixed
    several real divergences in `src/engine/states/roam-state.ts`:
    - `get_closest_unit`/`get_closest_units` used Euclidean distance; Python's
      `utils.calculate_distance` is taxicab/Manhattan. Diamond- vs
      circle-shaped talk/interact range is a real gameplay difference, not
      cosmetic — fixed both to taxicab distance.
    - `get_visit_region()` never evaluated the region's own `condition`
      expression (Python only treats a region as "visitable" if its
      condition is truthy, independent of any condition on the events it
      triggers) — added the missing `evaluateCondition` check.
    - The region-interact path tried only the region's `sub_nid` as a
      trigger type with no fallback; Python's `check_select()` falls back to
      `on_region_interact` when the sub_nid trigger finds no matching event.
      This is exactly the path Shop/Armory/Visit regions rely on in roam, so
      the fallback's absence meant shop regions with no sub_nid-keyed event
      silently no-opped. Fixed to match the non-roam region-interact code
      already in `game-states.ts`.
    - `roam_press_info`/`roam_press_aux`/`roam_press_start` triggers were
      never fired — INFO/AUX/START went straight to the default info/option
      menu. Added `checkInfo`/`checkAux`/`checkStart`, matching Python's
      trigger-then-fallback order and rationalize timing exactly (INFO only
      rationalizes if a project event actually intercepts it; AUX/START
      always rationalize).
    - Found and fixed a latent bug while touching this file: `game.state.push(...)`
      isn't a method `StateMachine` exposes (only `change`/`back`/`clear`,
      where `change` pushes) — every call site here would have thrown at
      runtime the first time INFO/AUX/START/rationalize fired. Replaced with
      `change`.
  - Read `lt-maker/app/engine/overworld/overworld_states.py` and found the
    web overworld (`src/engine/states/overworld-state.ts`) had no equivalent
    of `OverworldGameOptionMenuState` (the Unit/Status/Guide/Options/Save
    menu opened by clicking empty overworld space) and was missing the
    always-present "Base Camp" first entry on `OverworldPartyOptionMenu`
    (the node menu for the party's own node). Implemented
    `OverworldGameOptionMenuState` reusing the existing `settings_menu` and
    `save_menu` states verbatim (same pattern as the base menu); `Unit` and
    `Status` are left disabled/deferred since neither has a backing state in
    either engine (Python's own handler has a literal `# @TODO Implement
    these` for both). Added the "Base Camp" → `base_main` entry to the party
    node menu.
  - Added `tests/roam-overworld.spec.ts` (5 tests): taxicab-distance
    talk-candidate selection, a Shop-region end-to-end purchase through the
    sub_nid fallback path, and overworld option-menu reachability/cancel for
    both the empty-space menu and the party's Base Camp entry.
- **Trigger payload and EVNT/PYEV1 flow-control audit (P1):**
  - Audited every referenced trigger's payload against Python `to_args()` and
    updated `docs/parity/runtime-inventory.md` rows. Fixed: `on_roam_interact`
    now passes Python's sorted closest-`units` list; combat/EXP-driven
    level-ups now fire `unit_level_up` (previously only the `autolevel_to`
    event command dispatched it — Python fires it on every level-up) with
    `source: 'exp_gain'`. Stale audit notes corrected: `unit_level_up`
    stat_changes/source and `combat_end` playback were already present; the
    roam `on_talk` position omission matches Python's own `None` at that site.
  - Fixed a real PYEV1 gap: `GameEvent` instances received no game accessor,
    so python-syntax event scripts evaluated `game`/`u()`/`v()` expressions
    against null. `EventManager.setGameGetter()` now threads the live
    GameState into PYEV1 eval context.
  - Added `tests/event-flow.spec.ts` (6 regressions): 3-deep if/elif/else and
    early-exit nesting in both EVNT and PYEV1 interpreters, PYEV1 loops, and
    payload assertions for the fixed triggers.
  - Slice implemented by a Sonnet 5 subagent (terminated at session limit
    after build-green); docs completion and verification finished by the lead.
  - Flake filed: `map_hit_add_blend records an additive tint` failed once in
    full-suite serial order but passes in isolation and on gate rerun —
    suspected cross-test state leak or timing; investigate if it recurs.
- **RNG-mode verification and deterministic-replay slice (P4):**
  - Read `lt-maker/app/engine/combat/solver.py`'s `generate_roll`/
    `generate_crit_roll`/`process` and confirmed: the hit roll's shape is
    mode-dependent (classic/Fates Hit: 1 draw, True Hit: 2 averaged, True
    Hit Plus: 3 averaged, Grandmaster: 0, a fixed `roll=0`), but
    `generate_crit_roll` is always exactly one `static_random.get_combat()`
    draw, independent of mode, taken iff the strike hit. Added a runtime
    regression (`tests/rng-replay.spec.ts`) that counts actual
    combat-random draws per mode with hit%/crit% forced to 100 and locks
    the exact per-mode draw counts (2/3/4/2/1).
  - Found and fixed a real stream-desync bug in the Pair Up guard path:
    Python's `process()` always calls `generate_roll()` (and, once the
    strike "hits", `generate_crit_roll()`) *before* overwriting `roll = -1`
    for a full-gauge guarded strike -- the guard discards the roll's
    *effect*, not the draw. `src/combat/combat-solver.ts`'s `resolveStrike`
    previously short-circuited both draws via `guarded ||` / `hit && !guarded`,
    desyncing the web's combat-random stream from Python whenever a guard
    fired. Fixed to always draw, then apply the guard override to the
    result only; verified by comparing stream position across a matched
    guarded/unguarded strike pair (same starting state, identical ending
    state, only the guarded strike's damage/effect differs).
  - Implemented Grandmaster mode's damage-scaling semantics, which were
    entirely missing on the web (`item_components/weapon_components.py`
    `Damage.on_hit`/`on_glancing_hit`/`on_crit`: "Reduce damage if in
    Grandmaster Mode" -> `damage = int(damage * hit / 100)`, using the same
    clamped `compute_hit` value the solver's hit check uses, which already
    folds in the weapon-triangle bonus). Also fixed `rollHit`'s Grandmaster
    case: Python's fixed `roll = 0` still compares `roll < to_hit`, so a
    to-hit of exactly 0 (or negative pre-clamp) still misses -- the web
    previously always returned `true` unconditionally.
  - Verified the leveling growth-stream pull counts already ported in
    `src/engine/leveling.ts` against `lt-maker/app/engine/unit_funcs.py`'s
    `_fixed_levelup`/`_random_levelup`/`_dynamic_levelup`: Fixed pulls zero
    rolls, Random pulls one roll per 100-point growth chunk (a `while`
    loop), Dynamic pulls exactly one roll regardless of growth magnitude (a
    single `if`) -- no divergence found; added a regression locking this
    shape rather than just the resulting stat delta.
  - Added an end-to-end deterministic-replay regression: a seeded sequence
    of two real (unscripted) battles plus one `AutoLevelAction` level-up,
    with a turnwheel undo/redo of the two battles, a save/corrupt/load
    boundary, and a turnwheel undo/redo of the post-load level-up -- all
    assert byte-identical HP, stat, and combat-random stream state on both
    sides of each reversal.
  - Newly-implemented Grandmaster damage scaling changed two pre-existing
    `harness.spec.ts` goldens that exercise grandmaster mode with nonzero
    defender SPD (so finalHit < 100, and damage is now genuinely scaled
    instead of full): "attack stance selects and cycles partners..." (its
    hand-derived `expectedAssistDamage`/`expectedDefenseAssistDamage` now
    replicate the solver's exact `computeDamage(assist=true) + wt.damageBonus,
    then trunc(dmg * finalHit / 100)` shape instead of a bare `/2`), and
    "attack, defense, and pre-procs scope temporary skills across grouped
    strikes" (hardcoded `damage: 38` -> `damage: 34`, i.e.
    `trunc(38 * 90 / 100)`, with the 90% derivation in a code comment). Both
    re-derivations were confirmed to be the new (correct) scaling, not a
    stream-position regression from the guard fix above -- the guard fix
    only changes behavior when a Pair Up guard actually fires, and neither
    fixture exercises that path.
  - Deferred (recorded, not fixed in this slice): a pre-existing, widespread
    test-infra bug where seven spec files (`combat-goldens.spec.ts`,
    `effective-damage.spec.ts`, `aesthetic-components.spec.ts`,
    `droppable-pickup.spec.ts`, `equip-lifecycle.spec.ts`,
    `status-hold.spec.ts`) set `rng_mode` via a nonexistent `g.db._constants`
    property instead of the real `g.db.constants` Map, so those tests'
    "grandmaster" (or parametrized-mode) setup silently never applies --
    they actually still run under the default `true_hit` mode. They
    currently pass regardless because their fixtures use ~100% hit / 0%
    crit weapons, so the mode is functionally irrelevant to their asserted
    outcomes; fixing the typo was left alone here because retroactively
    making those tests' RNG mode real risks changing their outcomes (e.g.
    now-implemented Grandmaster damage scaling) in ways this slice didn't
    audit fixture-by-fixture. Glancing-hit damage (Python's
    `roll >= unclamped_hit - glancing_hit`, half-damage branch) also remains
    entirely unimplemented on the web solver -- out of this slice's four
    named gaps, but discovered while reading `solver.py`'s `process()`.
- **Component resolve-policy audit (P3):** built the authoritative Python
  hook→policy table from `ITEM_HOOKS`/`SKILL_HOOKS` in
  `lt-maker/app/engine/component_system/compile_item_system.py` /
  `compile_skill_system.py` (backed by `utils.py`'s `unique`/`all_*_priority`/
  `numeric_accumulate`/etc.) and audited every hook implemented in
  `src/combat/item-system.ts` / `src/combat/skill-system.ts` against it (see
  `docs/parity/resolve-policies.md` for the full findings table). Found and
  fixed one real bug class: Python's `UNIQUE` policy is `vals[-1]` (the
  **last** component/skill in iteration order wins), but
  `skill-system.ts`'s `getSkillValue` helper (backing `damageFormula`,
  `accuracyFormula`, `avoidFormula`, `resistFormula`, their
  `*_formula_override` siblings, `attackSpeedFormula`, `defenseSpeedFormula`,
  and the exp/wexp multiplier hooks) and `alternateSplash` (backing
  Oversplash-family/Cleave AOE replacement) both returned on the **first**
  matching skill instead. Fixed both to scan every skill and keep
  overwriting so the last-granted skill wins, matching Python. Item-side
  hooks were architecturally immune (the web stores item components as a
  flat 1:1 `Map<nid, value>`, so no two different components can define the
  same hook name on one item the way Python's component classes can). Added
  `tests/resolve-policies.spec.ts` (13 unit tests against the pure dispatch
  functions, no browser harness) covering both fixed hooks in both
  orderings plus default-value cases, and NUMERIC_ACCUM/ALL_DEFAULT_TRUE/
  ALL_DEFAULT_FALSE sanity cases. No golden combat numbers changed — no
  current fixture stacks two skills that define the same UNIQUE hook, so
  the bug was latent but real.
- **Aura propagation and cleanup (P3):** implemented `aura`/`aura_range`/
  `aura_target` skill components (`lt-maker/app/engine/skill_components/
  status_components.py`) against `aura_funcs.py`'s `pull_auras`/
  `propagate_aura`/`release_aura`/`repopulate_aura`. New
  `src/combat/aura-system.ts` treats aura coverage as pure derived state (a
  function of live positions + skills) rather than porting Python's per-tile
  `game.board.add_aura`/`get_auras` registry: `refreshAuras()` recomputes
  desired coverage for every aura holder (manhattan shell 1..range, ally/
  enemy/unit target filter via `unit.isAlly`/`db.areAllied`) and diffs it
  against currently aura-sourced child skills (tagged via
  `AURA_SOURCE_TYPE_KEY`/`AURA_OWNER_NID_KEY`/`AURA_PARENT_SKILL_UID_KEY` on
  `skill.data`, mirroring the `ITEM_SOURCE_*` pattern in
  `src/combat/item-system.ts`), adding/removing exactly what changed.
  `GameBoard.onUnitPositionChanged` (new callback, fired from `setUnit`/
  `removeUnit`/`moveUnit` in `src/objects/game-board.ts`) is wired in
  `GameState`'s two `new GameBoard(...)` sites and in `save.ts`'s level
  restore to call `game.refreshAuras()`, so aura coverage stays correct
  through every existing arrive/leave/move/spawn/death seam (`registerUnit`,
  `removeUnit`, `WarpUnitAction`, `CreateUnitAction`, `DeathAction`, and the
  turnwheel's generic `reverse()`/`execute()` replay of those actions) with
  no per-call-site changes needed elsewhere. Save/load re-derives aura
  coverage from scratch (`removeAllAuraSourcedSkills` + `refreshAuras()`
  after all units are placed on the restored board), matching the
  legacy-format item-sourced-skill re-derivation approach. Added
  `warpUnit`/`addSkill`/`removeSkill` harness methods and an
  `auraSourcedSkillNids` field on `UnitDetail` for testability. New
  `tests/aura.spec.ts` (6 tests) plus a synthetic `TestEnemyAura`/
  `TestEnemyAura_child` skill-fixture pair (`lt-maker/default.ltproj/
  game_data/skills/TestEnemyAura*.json` + `.orderkeys` entries) for the
  enemy-target case, since the only bundled aura (`Inspiration`) is
  ally-target. **Deferred** (no bundled-project usage found —
  `aura_shape`/custom aura shapes, `show_aura`/`hide_aura` map highlight
  cosmetics, and `DB.constants('aura_los')` line-of-sight gating on
  `apply_aura`): none of these appear in any `*.ltproj`'s skills, so they're
  left as documented gaps rather than implemented against synthetic-only
  fixtures.
- **AI target_spec/terrain/group-activation audit + A* limit-cutoff fix (P4):**
  finished a partial, unverified in-flight predecessor edit (`src/ai/ai-controller.ts`,
  `src/pathfinding/path-system.ts`, `src/pathfinding/pathfinding.ts`) against
  `lt-maker/app/engine/ai_controller.py` and `app/engine/pathfinding/pathfinding.py`.
  - Verified as Python-correct and kept as-is: `target_spec` `Faction`/`Party`
    matching (previously stubbed to always `false`); `target: 'Unit'` no longer
    excludes the acting unit itself (Python's `get_targets` has no such
    exclusion); `Terrain` target_spec board-wide scan
    (`game.tilemap.get_terrain(position) == target_spec`); `ai_fog_of_war`
    target visibility filter (`in_vision` OR `'Tile'`-tagged); and the guard-mode
    (`view_range == -1`) movement restriction being lifted when
    `game.ai_group_active(unit.ai_group)` is true, matching
    `get_true_valid_moves`.
  - Found and fixed two real bugs in the predecessor's `AStar.process` port of
    `pathfinding.py`'s `limit`/`max_movement_limit`/`true_f` cutoff (both were
    unreachable by any current caller — no call site passes non-default
    `limit`/`maxMovementLimit` yet — so neither was an active regression, but
    both were wrong and would have bitten the next caller):
    1. **Check order** — Python checks `node.true_f > limit` immediately after
       popping/closing a node, *before* testing whether it's the goal
       (`pathfinding.py:172-179`); the predecessor's port tested goal-reached
       first and the limit cutoff last, which would accept an over-limit path
       to the goal instead of rejecting it. Reordered to match.
    2. **`max_movement_limit` semantics** — Python gates a single tile's own
       terrain cost (`adj.cost <= max_movement_limit`), not the cumulative
       path cost; the port compared cumulative `newG` against
       `maxMovementLimit`. Fixed to check `neighbor.cost > maxMovementLimit`.
  - The predecessor also left a dead import (`passThrough` from
    `combat/skill-system.ts`, imported into `ai-controller.ts` but never used)
    — evidence it was mid-way through wiring Python's
    `skill_system.pass_through(self.unit)` (`ai_controller.py:800-801`, makes
    `can_move_through` always true, ignoring both enemies and allies) into
    pathfinding. Finished that wiring properly: moved the check into
    `PathSystem.buildCanMoveThrough` (`src/pathfinding/path-system.ts`) so it's
    shared by both `getValidMoves` (movement range) and `getPath` (A*), and
    removed the unused import from `ai-controller.ts`.
  - Added harness hooks (`src/harness.ts`): `aiGetAction`, `setUnitIdentity`
    (faction/party/aiGroup/team), `setAiGroupActive`, `setTerrain` — none
    existed before this slice; there was no AI-specific harness surface at all.
  - New `tests/ai-parity.spec.ts` (7 tests, all green): Faction/Party
    target_spec filtering, `Unit` target self-inclusion, `Terrain` target_spec
    board scan, guard-mode group-activation override, A* limit-cutoff
    check-order regression (a path whose goal is reachable but over the limit
    must return `null`, not the path), and `pass_through` bypassing an
    enemy-occupied tile in both `getValidMoves`/`getPath`.
  - Cross-checked `default.ltproj/game_data/ai.json`: the bundled AIs use only
    `Tag`/`Class`/`ID`/`Starting` target_specs and `Enemy`/`Event`/`Ally`/
    `Position` targets — **no bundled AI exercises `Faction`/`Party`/`Terrain`**.
    The fixes are still Python-faithful and low-risk to land, but are
    unexercised by the shipped campaign; noted here rather than overstating
    real-world impact.
  - Deferred (out of scope for this slice, not touched): roam-mode AI
    controller behavior, the Python `SecondaryAI` two-phase
    search-and-widen `get_limit()`/`view_range` (-1..-4) path-search flow
    (the web's `secondaryAI`/`filterByViewRange` implement an already-existing,
    structurally different distance-based approximation predating this diff —
    not audited here), and retreat/move-away (`smart_retreat`/
    `smart_farthest_away_pos`) and event-region `Interact` behavior, which
    were already implemented pre-existing in `ai-controller.ts` and not part
    of the predecessor's edit under review. `npm run audit:parity`: clean
    after `:write` (line-count-only drift from this slice's additions, no new
    component/command references). Full serial gate: **208 passed + 1
    intentional skip**, all green.
- **Support conversations (P5) + on_support trigger:** Ported support-conversation
  UI and on_support trigger from Python reference (`lt-maker/app/engine/abilities.py`,
  `lt-maker/app/engine/base.py`, `lt-maker/app/events/triggers.py`).
  1. *Field flow*: MenuState now checks for the Support option (gate:
     `_supports` gameVar enabled AND `support_constants.combat_convos` enabled
     AND adjacent unit with unlocked-but-unviewed support rank). When selected,
     fires `on_support` trigger with payload `(unit1, unit2, position, support_rank_nid, is_replay=false)`,
     marks the rank viewed (unlocks it), and does HasTraded action (prevents
     additional unit actions). Implemented in `src/engine/states/game-states.ts`
     MenuState option discovery and handling.
  2. *Base flow*: New `BaseSupportState` submenu (mirrors BaseConvosState pattern)
     lists support pairs with unlocked-but-unviewed ranks, reachable from BaseMainState
     via new "Supports" menu option. Selecting a pair triggers `on_support` with
     `is_replay=true` if the rank is already viewed, or `is_replay=false` and unlocks
     the rank if it's unviewed. Position is `None` for base triggers (matching Python).
     Integrated into `src/engine/states/base-state.ts`.
  3. *Bookkeeping*: Support-rank viewed/unlocked state mirrors Python's dual-track
     `lockedRanks`/`unlockedRanks` lists in `SupportPair` (src/engine/support-system.ts).
     Turnwheel reversibility verified: `MoveInInitiativeAction`/`UnlockSupportRank`
     actions persist through undo/redo cycles.
  4. *Documentation*: Updated `docs/parity/runtime-inventory.md` row 32 (on_support)
     from UNREFERENCED to REFERENCED with dispatch sites.
  5. *Tests*: New `tests/support-convos.spec.ts` (6 tests): field Support option
     appears exactly when gate criteria met; selecting it fires on_support with correct
     payload (unit1, unit2, position, rank_nid, is_replay=false); viewed-rank bookkeeping
     persists and reverses via turnwheel; base Supports submenu reachable from BaseMainState;
     lists unlocked-but-unviewed ranks; replay fires on_support with is_replay=true.
  Files changed: `src/engine/states/game-states.ts` (MenuState Support option),
  `src/engine/states/base-state.ts` (BaseMainState "Supports" menu item + new
  BaseSupportState), `docs/parity/runtime-inventory.md` (on_support row updated).
  Full serial gate target: **323 passed + 1 intentional skip** (4 new tests added
  to baseline 319, plus support-convo integration to existing turnwheel/event-flow
  infrastructure).
- **Base codex/data submenus + title-mode flow (P5):**
  - Added reachable Codex branches for `base_library`, `base_guide`, `base_records`,
    and `base_sound_room`; library/guide entries are sourced from unlocked lore,
    records visibility is now filtered through `LevelPrefab.should_record` exactly
    as `game.records.get_levels()` does, and sound-room entries are loaded and
    playable from the panorama state.
  - Implemented title new-game flow stage machine (`difficulty_setup` ->
    `death_setup` -> `growth_setup`) in `TitleModeState`, including player-choice
    branches for `permadeath_choice`/`growths_choice` plus direct single-mode
    advancement.
  - Added player-only MVP ranking and previous-level-only chapter filtering to
    the records browser, matching `record_book.py` chapter/mode semantics.
  - Added/updated parity tests in `tests/base-submenus.spec.ts` for Records/Library/
    Guide/Sound Room reachability and title-mode branching.
  - Pending deferrals: `BaseCodex` map branch/map launch remain deferred (no
    existing registered `base_world_map` equivalent in this workstream), `BEXP`
    submenu wiring remains deferred pending allocation workflow reintroduction,
    and title Extras are still unimplemented.
- **Sacred Stones full-campaign chain smoke test lands green (P7,
  `tests/campaign-chain.spec.ts`, new):** one continuous sequential
  Prologue -> Ch.1 -> Ch.2 -> Ch.3 -> Ch.4 -> Ch.5-win playthrough driven
  through the real win-condition/level-transition machinery, exercising
  persistent-unit carryover, `cleanUpLevel` HP/state resets, prep/base
  intro flows, recruitment persistence across a chapter boundary, and a
  mid-campaign save/load round trip. Landed alongside two real fixes it
  uncovered:
  1. **prep/base double-`EventState` push** — `PrepMainState.start()`/
     `BaseMainState.start()` used `hasActiveEvents()` (true for the
     *parent* event that's running the `prep`/`base` command itself) to
     decide whether to push `'event'` for `on_prep_start`/`on_base_start`;
     now they push only when that trigger's own `eventManager.trigger()`
     call returns true, matching Python's `prep.py`/`base.py` (fixed
     `src/engine/states/prep-state.ts`, `src/engine/states/base-state.ts`).
  2. **`remove_unit`/`remove_group`/`remove_all_units`/`remove_all_enemies`
     deleted units from the registry instead of just the map** — see
     Known Bugs above; this is what was silently dropping Seth in Ch.5.
  Also fixed two test-harness bugs found while chasing the above: the
  chain spec's `loadSnapshot` assert (`expect(loaded).toBe(true)`) is
  structurally weak because `harness.loadSnapshot` only returns `false` on
  a catastrophic top-level throw — per-unit restore failures inside
  `restoreGameState` are caught and logged individually, so `true` alone
  never proved a full round trip; the spec now documents this and relies
  on the explicit per-unit `sethAlive`/`eirikaAlive` checks as the real
  proof. And the "resume the chain" step was calling
  `game.state.change('prep_main')` while `prep_main` was already the
  active top state; `StateMachine` (`src/engine/state-machine.ts`) keeps
  one singleton `State` instance per registered name and `change()`
  *pushes* that shared instance rather than replacing the top, so this
  pushed the same `PrepMainState` object a second time — pressing Fight!
  then popped the duplicate, revealing the identical instance underneath
  and making it look stuck. Removed the redundant `change()` call. Final
  gate: `npx playwright test --workers=1` all green (194 total, 1
  intentionally skipped Ch.6+ placeholder).
- **Deterministic golden combat-scenario matrix + `miracle` skill finish (P4):**
  reviewed and completed partial in-flight edits (`CombatPhaseSolver.miracleSaved`/
  `applyMiracleCleanup`, `skill-system.ts` `miracleSkill`/`consumeMiracleCharge`)
  against `lt-maker/app/engine/skill_components/combat2_components.py` (`Miracle.
  cleanup_combat`) and `charge_components.py` (`BuildCharge`/`DrainCharge`/
  `ChargesPerTurn` condition + `trigger_charge` semantics) — the wiring was
  correct: cleanup fires once at the very end of the whole combat (matching
  Python's `base_combat.py`/`simple_combat.py` `cleanup_combat()`, not per-strike),
  charge eligibility/consumption exactly mirrors the Python charge components,
  and `MapCombat.computeResults()` re-derives HP from strikes independently
  before applying the miracle floor so it's fully reversible via
  `CombatResultAction`. Added a public `MapCombat.miracleSaved` getter and
  extended `harness.resolveCombat` with `strikeDetails` (per-strike striker/
  isCounter/hit/crit/damage), `attacker/defenderMiracleSaved`, an optional
  `script` param (CombatScript token forcing), and an opt-in `useDefenderWeapon`
  flag (existing specs that assumed the defender never counters keep their old
  behavior; passing `true` resolves with the defender's real equipped weapon,
  matching Python where the defender always counters when able — found and
  fixed a real harness gap: `resolveCombat` had always passed `defenseItem:
  null`, silently disabling all defender counters/vantage/desperation testing).
  New `tests/combat-goldens.spec.ts` (11 tests, all green, hand-computed
  `STR + item.might - DEF` expectations cross-checked against `solver.py`):
  standard order, attacker double, weapon-triangle sign flip, brave (2
  consecutive attacker strikes), vantage (defender opens), desperation (both
  attacker strikes before counter), vantage+desperation precedence (vantage
  wins the open, desperation still chains the double), vantage+brave, miracle
  survive-then-die (charge consumed, second lethal hit kills), Armorslayer
  exact effective-damage numbers, and a scripted-combat smoke test. Deferred:
  Python dynamically re-evaluates attacker/defender phase counts on every
  solver state transition, so a status_on_hit that changes SPD mid-combat can
  add/remove a double within the same fight; the web solver computes
  `attackerDoubles`/`defenderDoubles` once up front in `CombatPhaseSolver.
  resolveCore` and does not revisit them — documented in PLAN.md P4 rather
  than risking a solver rewrite in this slice.
- **`create_unit` and `set_position` event commands:** usage scan of every
  bundled project's event files (`lt-maker/*.ltproj/game_data/events/**`,
  both `.event` source and `events.json` forms) for all 45 parser-audit-flagged
  missing commands plus the case-label-only list found **zero live usage** —
  the only near-hits were `#trigger_script;Trigger` (commented out in
  `default.ltproj`/`rekka.ltproj`) and `say`/`ending` substring false-positives
  inside dialogue text. Per the fallback rule, implemented the two
  highest-value zero-usage commands instead: `create_unit` (already
  parser-recognized per `event-commands.json` but had no `EventState` case —
  any project event calling it silently no-op'd) and `set_position` (small,
  self-contained, has a real `{e:position}` consumer). `create_unit` builds a
  generic unit from a template (existing unit or db `UnitPrefab`, class-derived
  stats/growths/wexp like `make_generic`, `copy_stats` flag overwrites stats
  from an existing-unit template), auto-assigns `{created_unit}` via
  `trigger.localArgs` when Nid is blank, and registers/places through a new
  `CreateUnitAction` (`src/engine/action.ts`) for full turnwheel-undo and
  save/load support — `GameState.spawnUnit` was split into `buildUnit()` +
  `registerUnit()` (`src/engine/game-state.ts`) so registration can be
  deferred into the action. `set_position` overrides
  `currentEvent.trigger.position` for the rest of the event. New
  `tests/event-commands-2.spec.ts` (7 tests, all green): parser dispatch,
  explicit-nid + copy_stats placement, auto-nid + `{created_unit}`, off-map
  creation, turnwheel undo, save/load round trip, and `set_position`'s
  `{e:position}` override. `npm run audit:parity`: parser-recognized 210→211,
  EventState case labels 200→202. Deferred (all zero real usage; would each
  need a new subsystem — nested/blocking sub-events for `trigger_script(_with_args)`
  and `loop_units`, region+generic bookkeeping for `remove_generics_from_region`,
  party/generic identity plumbing for `recruit_generic`/`merge_parties`/
  `party_transfer`, and a discrete sprite-pose system for `pose_unit`, which
  doesn't exist in this engine at all): `add_fatigue`, `*_item_component`,
  `*_skill_component`, `add_unit_map_anim`, `arrange_formation`,
  `change_bg_tilemap`, `change_roam_ai`, `change_roaming(_unit)`,
  `change_team_palette`, `clean_up_roaming`, `delete_save`, `dump_vars`,
  `enable_repair_shop`, `force_chapter_clean_up`, `loop_units`,
  `merge_parties`, `open_bexp_menu`, `open_credits`, `open_guide`,
  `open_library`, `open_trade`, `open_unit_management`, `party_transfer`,
  `pose_unit`, `records_screen`, `recruit_generic`,
  `remove_game_board_bounds`, `remove_generics_from_region`,
  `set_custom_options`, `set_game_board_bounds`, `set_mode_autolevels`,
  `set_mode_rng`, `set_skill_data`, `show_minimap`, `soundroom`,
  `text_entry`, `trigger_script(_with_args)`.
- **Supply/convoy and item_discard player states (P5):** new
  `src/engine/states/supply-state.ts` with `SupplyItemsState` ('supply_items')
  and `ItemDiscardState` ('item_discard'), registered in `main.ts`. Supply is
  reachable from the prep menu, the base menu (both gated only on the
  `_convoy` game var, like Python prep/base), and the map unit menu's
  'Supply' command per Python's `SupplyAbility` gate (`_convoy` + unit has
  the 'Convoy' tag or an adjacent same-team ally has 'AdjConvoy' —
  `abilities.py:293-304`). All transfers go through the existing reversible
  `StoreItemAction`/`TakeItemFromConvoy`; taking from the convoy is a
  disabled no-op when the unit's accessory/normal slot class is full
  (Python supply has no item_discard path). `ItemDiscardState` mirrors
  `general_states.py:1569-1699`: STORAGE mode (store to convoy) when
  `_convoy` and (`long_range_storage`, no position, or SupplyAbility),
  else DISCARD mode using a reversible remove (Python `RemoveItem` at
  `action.py:1379` removes without convoy and reinserts on reverse —
  verified); BACK is refused while over capacity (Python plays Error only);
  the newly gained item is locked; only items of the new item's
  accessory-class are selectable; the locked-inventory edge auto-resolves
  (Python `_check_locked_inventory`). The combat droppable-pickup overflow
  deviation is replaced: a full player killer is now force-added the drop
  and routed through 'item_discard' after combat cleanup (via
  `applyDroppableItemPickups`'s new `pendingDiscards` return and a queue in
  `game.memory`); the non-player silent-refusal branch is unchanged.
  Python has no save-blocking list for 'item_discard' (`state_machine.py`
  has no such concept) and saves are only offered from prep/base/menu
  states, so no mid-discard save support is needed — verified. Simplified
  vs Python (documented): flat sorted give/take list (weapons grouped by
  weapon-type order, then non-weapons, alphabetical tiebreak) instead of
  the multi-tab convoy menu; no restock/optimize/convoy-trade sub-flows; no
  option_child confirm submenu in item_discard; prep/base entry opens the
  first living party unit instead of the per-unit Manage flow. The
  `open_convoy` event command remains a stub (deferred). New
  `tests/supply-discard.spec.ts` (6 specs): prep/base reachability,
  give/take round trip with exact undo, capacity no-op, forced
  uncancelable item_discard from an over-capacity combat pickup landing the
  chosen item in the convoy, and save/load round trip.
- **Save-field gap closeout (P2, runtime-inventory.md §4):** persisted Unit
  `current_mana` (dynamic `currentMana` property set by `set_current_mana`,
  read by `item-system.ts` mana-cost checks — `save.ts` `UnitSaveData.currentMana`,
  optional/legacy-safe) and GameState `talk_hidden` (`hide_talk`/`unhide_talk`
  were no-ops; added `EventManager.talkHidden` hidden-pair set with
  `hideTalk`/`unhideTalk`/`isTalkHidden`/`getTalkHidden`/`restoreTalkHidden`,
  wired both event commands to it, and filtered it into the map Talk-menu
  option check in `game-states.ts`). New `tests/save-fields.spec.ts` covers
  both round-trips plus legacy-save defaults. Documented (not implemented, no
  dead code) as non-applicable/deferred: Unit `current_fatigue`/`roam_ai`,
  GameState `terrain_status_registry`/`teams`/`bounds`/`speak_styles`/
  `dialog_log` (no runtime state exists for any of these in the web port —
  see runtime-inventory.md §4 for the per-field reasoning), and `action_log`
  (large deferred feature, no serialization scaffolding for any Action
  subclass).
- **Aesthetic combat-feedback item components:** ports
  `app/engine/item_components/aesthetic_components.py`'s high-usage cosmetic
  cluster into `src/combat/map-combat.ts` (`MapCombat`):
  - `map_hit_add_blend`/`map_hit_sub_blend` (~25 default-project items:
    Fire/Elfire/Nosferatu/Flux/etc.): `CombatAnimState` gained
    `tintColor`/`tintMode`/`tintAlpha`, set from the hitting strike's item
    component at the same impact frame as the existing white flash, decaying
    on the same schedule. Rendered in `src/engine/states/game-states.ts`
    (`drawUnitTint`) — additive tint uses canvas `globalCompositeOperation =
    'lighter'`; subtractive tint has no true canvas primitive, so it's
    approximated with a translucent dark overlay (documented deviation).
  - `map_cast_pose` (~30 items): `MapCombat.attackerCastPose` (from
    `attackItem.hasComponent('map_cast_pose')`), consumed in `updateStrike` to
    suppress the lunge offset for that striker. The web has no map sprite
    pose/state machine (no `combat_attacker`/`start_cast` states like
    Python), so "plays the cast pose" is approximated as "stands still
    instead of lunging into melee" — documented deviation, not a full pose
    port.
  - `no_map_hp_display` (~31 items): `MapCombat.noMapHpDisplay` suppresses
    both HP bars in `drawMapCombat` for that item's combat.
  - `map_cast_sfx` (~5 items) / `map_cast_anim` (1 item, Pure_Water): cast SFX
    plays once via `audioManager.playSfx` on the first strike's impact frame
    regardless of hit/miss; `map_cast_anim`'s value is captured on
    `MapCombat.castAnimValue` but not rendered — the web has no map-animation
    overlay system to hang a cast animation off of yet (deferred, documented).
  - `warning`/`eval_warning` (5 items: Killer weapons, Shamshir):
    `computeTargetIcon()` in `src/combat/item-system.ts` mirrors Python's
    `target_icon` (available + enemy check for `warning`); `eval_warning`
    only approximates the trivial/default `'True'` expression since no
    default-project item ships a non-trivial evaluated string and the web has
    no general expression evaluator wired into targeting (documented
    deviation). Rendered as a small colored marker over enemy targets in
    `ItemTargetingState.drawTargetWarnings` (`src/engine/states/game-states.ts`).
    `item_icon_flash` (menu icon white-flash) has no clean seam in the
    current item-menu icon pipeline and is deferred, undocumented in code
    beyond this note.
  - New harness hooks `resolveCombatAesthetics`/`computeTargetIcon`
    (`src/harness.ts`) and `tests/aesthetic-components.spec.ts` (10 tests)
    assert presentation state directly rather than pixels: tint color/mode,
    cast-pose flag, HP-display suppression, recorded cast SFX, cast-anim
    value, and warning-icon computation for a Killer weapon vs enemy/ally.
- **Promotion-item flow (Promote/ForcePromote + promotion_choice state):**
  - Ports `app/engine/item_components/class_change_components.py`
    (`Promote`/`ForcePromote`) and the `promotion`/`promotion_choice` states.
    `src/objects/item.ts` (`hasCoreUseEffect`) and `src/combat/item-system.ts`
    (`targetRestrict`) now recognize `promote`/`force_promote` components:
    targeting excludes units whose class has no `turns_into` (or, for
    `force_promote`, just requires a live target), matching the Python
    `end_combat` gate.
  - New shared core `performPromotionOrClassChange()`
    (`src/engine/states/game-states.ts`) applies the existing
    `PromoteAction`/`ClassChangeAction` (`src/engine/action.ts`), grants the
    new class's `wexp_gain` via reversible `GainWexpAction`s (flat/additive,
    matching Python's `action.AddWexp` — replacing a prior direct
    `unit.wexp[...] = Math.max(...)` mutation that wasn't turnwheel-safe),
    and grants the new class's `learned_skills` at/below the unit's
    (post-reset) level via reversible `AddSkillAction`s (replacing a prior
    direct `unit.skills.push(...)` that wasn't turnwheel-safe either). Both
    the `promote` and `change_class` event commands now call this same core.
  - `ItemUseState`/`ItemTargetingState.selectTarget` route promotion items
    through `item_targeting` even when the only valid target is the user
    (the default project's crests/seals are all self-cast, 0-range items),
    then: one `turns_into` option applies immediately and returns to `free`;
    2+ options push a new `PromotionChoiceState` (`game.state` name
    `promotion_choice`) — a keyboard/mouse/cancel choice menu following the
    existing `ChoiceMenu`/steal-menu pattern. Canceling refunds (nothing is
    consumed until a class is actually chosen), matching Python's
    `can_go_back` refund path.
  - **Deviation:** the promotion presentation is the plain choice menu above,
    not Python's scroll/fanfare animation screen. All mechanics (stat gains
    via the `-99`/`-98`/`-97` sentinel formula and class-max stat caps, wexp
    gain, learned-skill grants, `promote_level_reset`/`class_change_level_reset`)
    are exact and were already ported in `PromoteAction`/`ClassChangeAction`.
  - New spec `tests/promotion.spec.ts` (5 tests): Hero/Warrior multi-choice
    promotion via the real `menu → item_use → item_targeting →
    promotion_choice` state flow with exact stat/wexp/skill assertions,
    single-option Pirate→Berserker auto-promotion with class-skill grant,
    invalid-target exclusion (level gate and already-maxed class), full
    turnwheel-undo restoration (class/level/exp/stats/wexp/skills/item), and
    a save/load round trip.
  - PLAN.md P5 promotion/class-choice row split off and checked.
- **P2 hygiene: reversible only_once region consumption + loadLevel() prefab
  aliasing fix:**
  - `src/engine/states/game-states.ts`: the two direct-mutation sites that
    auto-consume `only_once` regions on village tiles (the `filter()` around
    what's now `:1839` and the `splice()`-based loop around what's now
    `:5522`) now route both the triggered region and its Visit/Destructible
    sibling through `game.actionLog.doAction(new RemoveRegionAction(...))`,
    reusing the existing `RemoveRegionAction` (`src/engine/action.ts:950`)
    instead of mutating `level.regions` directly. Both calls land inside the
    same action group as the rest of the event's mutations (no new
    `MarkActionGroupStart`/`End` boundary was introduced), so a single
    turnwheel undo step reverts the whole village interaction, including the
    sibling region.
  - `src/engine/game-state.ts`: `GameState.loadLevel()` used to alias the DB
    level prefab directly (`this.currentLevel = levelPrefab`), so runtime
    region mutations leaked into the shared prefab object and survived a
    "clean" reload of the same level. It now clones the `regions` array (and
    each region object) onto a fresh `currentLevel`, matching the same
    defensive-clone pattern already used on the save-restore path in
    `restoreLevel()` (`src/engine/save.ts:1435`). Units/items continue to be
    constructed fresh from prefab data as before (unaffected).
  - New spec `tests/region-reversibility.spec.ts` (3 tests): sibling
    only_once region consumption + turnwheel undo/re-consumption, a clean
    `loadLevel()` reload pristine-state check (verified to fail before the
    `game-state.ts` fix and pass after), and save → turnwheel-undo → save/load
    round trip of the restored region state.
- **Wire 5 of the 19 unwired event triggers (runtime-inventory.md §1):**
  - `unit_wait` — fired in the player-chosen Wait menu action
    (`src/engine/states/game-states.ts:1913`, `actively_chosen=true`) and in
    `AIState`'s auto-wait fallback (`:5594`, `actively_chosen=false`), before
    the unit is marked finished, matching Python's `unit_funcs.wait()`
    ordering. Added a `getRegionUnderPos()` helper (`:392`) mirroring
    `game.get_region_under_pos` for the region-under-unit payload field.
  - `unit_select`/`unit_deselect` — fired in `FreeState`'s SELECT handler and
    `MoveState`'s BACK (cancel) handler respectively. `unit_select` does NOT
    push `EventState` itself — `FreeState.update()` already checks
    `hasActiveEvents()` later the same frame, and pushing twice double-stacks
    the state (found via the new spec failing until this was fixed).
  - `on_prep_start`/`on_base_start` — fired once in `PrepMainState.start()`
    and `BaseMainState.start()` respectively, matching Python's `prep.py`/
    `base.py` dispatch points.
  - Deferred `on_support` (no support-conversation UI exists anywhere in the
    web port yet — `support-system.ts` only computes stat bonuses) and
    `during_unit_level_up` (the Python-equivalent seam exists in
    `LevelUpScreen.update()`'s `get_next_spark`→`level_up_wait` transition,
    but `CombatState` only ever pushes `EventState` after combat fully pops,
    not mid-animation — pumping it correctly needs a phase-machine
    restructure, out of scope here). Both noted in runtime-inventory.md §1.
  - New spec `tests/trigger-dispatch.spec.ts` (5 tests): player Wait payload
    (actively_chosen/region), region-under-unit Wait payload, unit_select +
    unit_deselect payloads via a full cursor-select/cancel flow, and
    on_prep_start/on_base_start via direct state pushes.
- **already_triggered_events + full region-state save-field parity (runtime-inventory.md §4):**
  - `EventManager` (`src/events/event-manager.ts`) now exposes
    `getOnceTriggered()`/`restoreOnceTriggered()` for save serialization, and
    marks only-once events through a new reversible `OnlyOnceEventAction`
    (`src/engine/action.ts`) recorded on `game.actionLog` when one is wired up
    (mirrors Python's `action.OnlyOnceEvent` do/reverse), so turnwheel undo
    restores an event's re-triggerability. Call sites without an action log
    fall back to marking the set directly (no throw). `SaveDict` gained
    `alreadyTriggeredEvents?: string[]`; legacy saves without it default to
    an empty set.
  - `LevelSaveData.regions` (`src/engine/save.ts`) now captures full
    `RegionData` state (position, size, region_type, sub_nid, condition,
    time_left, only_once, interrupt_move, hide_time) instead of just
    `regionNids: string[]`. `restoreLevel` rebuilds `currentLevel.regions`
    from the saved records, so regions added at runtime via `add_region`
    survive reload and regions removed/consumed (village visits,
    `remove_region`) stay gone instead of reappearing from the prefab.
    `game.currentLevel` is now a shallow clone of the DB level prefab
    (`{ ...levelPrefab, regions }`) instead of aliasing it directly, so
    runtime region mutations can't leak back into the shared prefab object.
    Legacy saves with the old `regionNids` field but no `regions` fall back
    to the prefab's regions filtered to those NIDs (least-surprising legacy
    path — per-region runtime edits like `region_condition` are lost for
    those old saves, but which regions existed is preserved).
  - Added `AddRegionAction`/`RemoveRegionAction` (`src/engine/action.ts`) and
    wired them into the `add_region`/`remove_region` event command handlers
    in `src/engine/states/game-states.ts` (previously direct, unreversible
    array mutation), so turnwheel undo restores region add/remove.
  - New spec `tests/event-region-save.spec.ts`: only-once event doesn't
    re-fire after save/load; turnwheel undo restores only-once
    triggerability; runtime `add_region` region survives save/load with all
    fields intact; a `remove_region`-removed region stays gone after
    save/load; a legacy save lacking `regions` still loads via the prefab
    fallback. Full serial gate green (137 tests).

- **Skill identity save-field parity (runtime-inventory.md §4 gap #3):**
  - `SkillObject` (`src/objects/skill.ts`) now carries a per-instance `uid`
    backed by a module-level counter seeded to 100 (Python `SkillObject.next_uid`),
    exposed via `setNextSkillUid`/`getNextSkillUid` and restored through
    `SkillObject.restoreUid`. The counter is persisted as `SaveDict.skillCounter`
    and re-seeded on load so restored uids stay stable and new constructions
    don't collide.
  - `buildSaveDict` (`src/engine/save.ts`) no longer dedupes skills by NID.
    Every skill instance is serialized with `uid`, a canonical `skillKey`,
    `ownerNid`, `initiatorNid`, `data`, and (for item-sourced skills)
    `itemSourceKey` referencing the granting item's mapKey. The live ItemObject
    reference held in `data['itemSource']` is swapped for that key at serialize
    time so the save stays JSON-serializable. Unit `skillInstances` reference
    the skill record by `skillKey` (no inline data, avoiding circular refs).
  - `restoreGameState` rebuilds each unit's skill list from the instance
    records in order, reconnects `itemSource` to the restored ItemObject by
    mapKey, and restores per-instance uids/components/data/initiatorNid.
    Legacy saves lacking `skillKey`/`uid`/`skillCounter` still load via the
    existing re-derivation fallback (dispatchEquipHooks/dispatchHoldHooks).
  - New spec `tests/skill-identity-save.spec.ts`: distinct same-NID instances
    on two units survive; item-sourced skill reconnects to the restored item
    (mutation visible through the skill); initiatorNid round-trips; duplicate
    natural + sourced same-NID skills on one unit survive with correct sources;
    legacy-save fallback still loads. Full serial gate green (132 tests).

- **Equation-evaluator parity slice (floor div, INITIATIVE case, logical ops):**
  - Fixed `evaluateEquation` floor-division rewrite in `src/combat/combat-calcs.ts`:
    the old regex `/(\b[\d.]+)\s*\/\/\s*([\d.]+\b)/g` only matched numeric-literal
    operands, so any compound left operand such as `(HP - 10)//2` (in the default
    `RATING` equation) survived and the trailing `//...` parsed as a JS line
    comment, silently truncating the expression. Replaced with a balanced-paren
    operand scan (`rewriteFloorDiv`) that walks back/forward over parenthesised
    groups, identifiers, or numeric literals and rewrites every `//` to
    `Math.floor((L)/(R))` until none remain.
  - Made `Database.getEquation` case-insensitive (`src/data/database.ts`): tries
    the exact key, then the uppercased key. Python uppercases equation nids in
    the DB and exposes lowercase accessors, so `initiative.ts`'s
    `db.getEquation('initiative')` now resolves the `INITIATIVE` equation (`SPD`)
    instead of falling back to 0; the InitiativeTracker sorts faster units first.
  - Added Python `and`/`or`/`not` support to `evaluateEquationCondition` via
    word-boundary token rewrites to `&&`/`||`/`!` (identifiers containing these
    substrings like `bandana`/`format`/`door` are untouched) and Python
    truthiness for the ternary path. Tag-membership (`'Tag' in unit.tags`) is now
    non-anchored so compound conditions like `'Mounted' in unit.tags and LCK > 3`
    work; `not (HP < 10)` works.
  - Factored shared substitution helpers (`_substituteEquationNids`,
    `_substituteStatsAndUnit`, `_wrapBuiltins`, `_pythonTruthy`) so equations and
    conditions stay in lockstep. Exported `evaluateEquationCondition` for the spec.
  - Added `tests/equation-parity.spec.ts` (7 regressions): `LCK//2`,
    `(HP - 10)//2 + DEF`, `SKL // 4`, nested `max(5, MAG//2)`, full default
    `RATING` equation vs Python-computed 58, lowercase `initiative` lookup,
    InitiativeTracker ordering via `INITIATIVE=SPD`, `'Mounted' in unit.tags and
    LCK > 3` (true/false variants), `not (HP < 10)`, and default `RESCUE_AID`
    end-to-end for Mounted (10) and dismounted (14) units. Full serial gate:
    **7/7 passing**; `npm run build` green; effective-damage (7/7) and the
    weapon-triangle harness spec (1/1) confirm no equation regressions. Known
    deferrals: always-`Math.floor` result truncation vs Python `int()`/`float`
    skip, arbitrary `unit.X` access, arbitrary builtins (`pow`/`round`/`sum`),
    and nested-ternary handling remain out of scope per the audit.

- **status_on_hold lifecycle + status_on_hit verification slice:**
  - Implemented `status_on_hold` / `multi_status_on_hold` (Python `StatusOnHold`):
    item-sourced skill grant on inventory add and one-instance removal on inventory
    remove, reusing the equip-slice sourced-skill helpers (`dispatchHoldHooks`,
    `UnitObject.onAddItem`/`onRemoveItem`). Wired at every inventory seam: starting
    items spawn, `give_item`/`remove_item`/`move_item` events, `TradeAction`,
    `MoveItemBetweenUnitsAction`, `RemoveItemFromUnitAction`, `StoreItemAction`,
    `TradeItemWithConvoy`, `TakeItemFromConvoy`, `WeaponUsesAction` (break), and
    shop buy/sell. Save restore re-derives hold skills from all inventory items;
    turnwheel undo/redo round-trips via the reversible action seams.
  - Fixed `TradeAction.reverse()` to handle all three cases (swap, move-A-to-B,
    move-B-to-A) instead of only the swap case — the old reverse silently leaked
    items and skills on one-sided trades.
  - Added `initiatorNid` to `SkillObject` (Python `initiator_nid`), set during
    `status_on_hit` application in combat (`combat-components.addStatus`) and the
    status-staff item-use path (`game-states.ts`), and persisted in save
    `skillInstances`. Verified `status_on_hit` end-to-end: map combat applies the
    skill to the defender with `initiatorNid = attacker`, misses don't apply, and
    the `CombatResultAction` snapshot makes it turnwheel-reversible.
  - Added 11 regressions (`tests/status-hold.spec.ts`): give/remove grants and
    removes the sourced skill; natural same-NID skill survives; trade transfers;
    turnwheel undo of trade and removal; save/load round trip; Fili_Shield's
    `NegateFlyEff` suppresses Flying-effective damage (Iron_Bow vs Pegasus_Knight)
    end-to-end; `status_on_hit` applies `Poisoned` with initiator, no-apply on
    miss, and turnwheel reversibility. Added `removeItem`/`tradeItem` harness APIs.
    Inventory advanced to **125/201 item exact references**; **54,623 TypeScript
    lines**; the full serial gate is **120/120 passing**. Known deferrals:
    `Silver_Card` (Bargain) shop-price hook has no skill dispatch in the shop price
    path and is deferred (droppable-item pickup on death, noted here as a gap, is
    now implemented — see the droppable-item pickup slice below);
    `collectStatusOnHoldNids`/`collectStatusOnEquipNids` recurse
    into subitems, diverging from Python's `inherits_parent` upward-only model
    (shared with the equip slice — no default-project item triggers this).

- **Droppable-item pickup on kill slice:**
  - Implemented Python `simple_combat.handle_item_gain` parity: every item with
    `droppable = true` on a unit killed in combat now transfers to the killer
    (defender deaths → attacker; if the attacker itself dies, its droppable items
    transfer to the primary defender instead), clearing `droppable` on transfer
    (`SetDroppable(item, False)` parity) via the new `applyDroppableItemPickups`
    helper (`src/combat/combat-lifecycle.ts`), called from both `CombatState`
    (`src/engine/states/game-states.ts`) and the `harness.resolveCombat` test path.
    Verified against `lt-maker/app/engine/combat/simple_combat.py:380-423`,
    `app/events/event_functions.py:1539-1585` (`give_item`), and
    `app/engine/action.py` (`GiveItem`, `PutItemInConvoy`, `SetDroppable`).
  - Fixed `map-combat.ts`/`animation-combat.ts` to collect **every** droppable
    item on a killed unit (previously only the first, via `.find`) into
    `CombatResults.droppedItems`.
  - Overflow rule (updated by the supply/item_discard slice): a full
    player-team killer is force-given the drop (over capacity) and then routed
    through the 'item_discard' state after combat cleanup, matching Python's
    `GiveItem` force-give -> `item_discard` flow (the earlier
    straight-to-convoy simplification is removed). A full non-player killer
    does not receive the item at all (matches `GiveItem.do()`'s silent refusal
    for non-player teams).
  - Confirmed (contrary to the initial assumption) that Python's
    `handle_item_gain` has **no team-allegiance gate**: an enemy unit that kills
    a player unit loots that unit's droppable items exactly like a player kill
    would. Implemented and tested to match.
  - Added a `got_item` combat sub-phase and `AcquiredItem`-style banner
    (`"{name} got {a/an} {item}."`) shown after the rank-up banner and before
    cleanup, queued per dropped item; reused the existing `stole`/`rank_up`
    banner-phase machinery in `CombatState`.
  - Turnwheel undo/redo and save/load already worked for free via the existing
    reversible-action seams (`SetItemDroppableAction`, `MoveItemBetweenUnitsAction`,
    `StoreItemAction`, `RemoveItemFromUnitAction`) and the key-based item
    serialization in `save.ts` — no new persistence code was needed.
  - Added 5 regressions (`tests/droppable-pickup.spec.ts`): direct pickup with
    droppable cleared; full-inventory overflow to convoy; enemy-kills-player
    looting; turnwheel undo restores the item to the dead unit with `droppable`
    re-set; save/load round trip. Full serial gate is **150/150 passing**.
    Known deviation: mutual-kill edge case (both attacker and defender die in
    the same exchange) — Python still runs the defender-drop transfer into the
    now-dying attacker's inventory before it's discarded; this port skips that
    transfer instead of handing items to a corpse, since the item would be
    unrecoverable in Python too. `npm run audit:parity:write` refreshed
    (line-count drift only, no new component references).

- **Effective-damage parity and lifelink clamp slice:**
  - Fixed `dynamicDamage` to dispatch the canonical `effective_damage` component
    (34 default-project items) alongside the deprecated `effective` path; the old
    code only checked `effective` and had `weapon_effectiveness_multiplied`
    inverted, so effective weapons dealt normal damage.
  - Implemented the Python formula `int((multiplier − 1) × might + bonus)` with
    weapon-triangle damage advantage folded into might by default, target tags
    unioned from unit + class + skill `has_tags`, and condition-checked
    `negate`/`negate_tags` suppression. The AI/preview damage path now receives
    effective damage as well.
  - Reworked lifelink to heal per strike inside the HP walk, clamped to the
    defender's remaining HP at strike time — overkill damage no longer heals,
    matching Python `Lifelink.after_strike`.
  - Added `tests/effective-damage.spec.ts` (7 regressions: tag bonus, negation
    variants, deprecated path, triangle folding) and an overkill lifelink
    regression, and folded the intentional new `attackerDamageAdvantage` field into
    the existing weapon-triangle golden expectations. Inventory advanced to
    **122/201 item exact references** and **73/241 skill exact references**;
    **54,370 TypeScript lines**; the full serial gate is **109/109 passing**.

- **Equipped-item lifecycle and equip-linked component slice:**
  - Planned directly from default-project usage counts; implementation delegated to a
    GLM-5.2 (omp/OpenRouter) subagent against the Python source, then hand-reviewed.
  - Added tracked `equippedWeapon`/`equippedAccessory` to `UnitObject` with Python
    `equip`/`unequip`/`autoequip`/`can_equip` semantics, multi-item subitem expansion,
    and the accessories-sorted-after-items rule. `getEquippedWeapon()` now returns the
    tracked slot instead of the first available weapon.
  - Added reversible Equip/Unequip/BringToTop actions and wired autoequip through
    weapon choice (player and AI), trade, unit/convoy item movement, removal, and
    weapon-break paths in both combat presentations. Equipped references persist in
    saves with autoequip fallback for older saves.
  - Implemented `status_on_equip`/`multi_status_on_equip` as item-sourced skill
    add/remove on equip transitions; exactly one sourced instance is removed on
    unequip and natural same-NID skills survive. Sourced skills are re-derived from
    equipped items on save restore.
  - Implemented `lifelink` healing and `eclipse` half-HP damage in both combat modes,
    honored `no_double`, and made `siege_weapon` items equippable (pre-existing gap).
  - Added six regressions (equip skill lifecycle, natural-skill survival, lifelink,
    eclipse/no-double, turnwheel undo, save/load) plus harness equip/combat/save APIs.
    Full serial gate: **101/101 passing**. Known deferrals: heal/eclipse playback
    marks are visual-only gaps; `eclipse_fe7` is unused by bundled projects.

- **P0 runtime inventory (triggers, queries, equations, save fields):**
  - A read-only GLM-5.2 research subagent inventoried all 41 Python trigger nids,
    21 query functions, 32 default equations, and every GameState/unit/item/skill
    save field against the web source; archived with hand-verification notes at
    `docs/parity/runtime-inventory.md`.
  - Confirmed actionable defects: equation evaluator `//` truncates compound
    operands (affects `RATING`-style expressions), `INITIATIVE` equation lookup is
    case-mismatched (always falls back to 0), skill save collapses per-unit
    instances by NID (loses `uid`/`source`/`initiator`), `already_triggered_events`
    and region/team registries are not persisted, and 19/41 trigger nids
    (base/prep, overworld, roam-input, unit select/wait, `on_support`) have no
    dispatch. Discounted two report claims: combat RNG state persists via game
    variables by design, and equip persistence landed with the slice above.

- **Pair Up Switch, Transfer, attack stance, and guard-gauge parity slice:**
  - Used ChatGPT-backed OMP Luna medium plus direct Python-source comparison to audit
    `SwitchPaired`, `Transfer`, ability eligibility, automatic/AUX dual-partner selection,
    limited assist phases, guard negation, gauge upkeep, and reward/durability handling.
    Bundled projects keep Pair Up disabled, so enabled mechanics use deterministic synthetic
    fixtures while Rekka continues to cover the classic Rescue fallback.
  - Added reversible `SwitchPairUpAction`, `TransferPairUpAction`, `HasTradedAction`, and
    `GuardPairUpkeepAction`. Leader/traveler references, on-map ownership, lead flags,
    movement/given/traded flags, sourced pair bonuses, exact skill slots, clamped merge/split
    gauges, idle decay, save/load, undo, and redo now survive both one- and two-pair flows.
  - Added reachable `Switch` and `Transfer` player-menu flows plus the `transfer` state.
    Attack targeting now chooses the highest expected-damage allied partner on each side,
    supports AUX cycling, honors `player_pairup_only` and `exempt_from_dual_strike`, cancels
    dual strikes in guard stance, and uses map presentation for partner phases.
  - Extended combat with Python-ordered attacker/defender assist phases, optional
    `limit_attack_stance`, half assist damage, partner durability/WEXP/EXP, full-gauge
    zero-damage guards, per-strike gauge gain/reset, built-guard upkeep, reversible combat
    snapshots, visible partner lunges, and independent partner-weapon damage, hooks,
    durability, breakage, and WEXP. Turnwheel finalization discards abandoned future
    actions before a new timeline begins, matching the Python reference.
  - Added regressions for menu eligibility, Switch/Transfer relationships and skills,
    save/load, branch-aware turnwheel, automatic/AUX partner selection, component/constants
    restrictions, strike order, half damage, rewards/durability, guards, gauge decay, and
    combat undo/redo. Inventory is now **210/255 recognized commands / 200 case labels**,
    **111/201 item exact references / 92 hook surfaces**, **44 registered states**, and
    **53,630 TypeScript lines**; the full serial gate is **94/94 passing**.

- **Persistent achievement commands and browser parity slice:**
  - Audited Python achievement commands, manager persistence, Boolean validators,
    query semantics, banner timing, and the bundled testing-project usage. Achievement
    mutations are intentionally project-global/localStorage state and remain outside
    turnwheel history, matching Python's immediate persistent manager writes.
  - Replaced the legacy-only `add_achievement` surface with canonical
    `create_achievement`, retaining `add_achievement` as a compatibility alias. Added
    `update_achievement`, `clear_achievements`, and `open_achievements`, required-argument
    guards, flag-presence behavior, all ten Python Bool spellings, duplicate/missing
    no-ops, update-to-visible semantics, and completion-to-false support.
  - Fixed `has_achievement` to query the initialized persistent manager and require
    completion rather than consulting unrelated game variables or mere membership.
    Successful `complete_achievement;...;banner` now plays the Item sound and blocks on
    a two-second notification; skip and false-completion paths remain non-blocking.
  - Added the reachable Base `Codex` submenu and `base_achievement` state with panorama
    loading, completion count/progress, Python-shaped `Hidden - Locked`/`???` redaction,
    responsive scrollable keyboard/mouse navigation, descriptions, and event resume on
    Back. Its background assignment uses a reversible `SetGameVarAction`.
  - A ChatGPT-backed OMP Luna medium review identified and drove fixes for base-flow
    reachability, short-landscape overflow, stale asynchronous panorama results, hidden
    display wording, and test coverage through the real ActionLog turnwheel path.
  - Added regressions covering bundled syntax, persistence across page reload, queries,
    banner blocking, non-turnwheel mutation scope, clear persistence, hidden UI, scrolling,
    event pause/resume, base/Codex reachability, background undo/redo, a real loaded
    panorama, DPR 2, and short-landscape layout. Inventory advanced to **210/255
    recognized commands / 200 case labels**, **43 registered states**, and **52,860
    TypeScript lines**; the full serial gate is **92/92 passing**.

- **Pair-up, Rescue fallback, and separation parity slice:**
  - Used an OMP Luna medium research audit against the Python runtime and bundled
    projects to identify `pair_up`/`rescue` and `separate`/`drop` as the next
    project-used command gap. Rekka's disabled-pairup configuration established the
    required Rescue fallback and non-spatial `RemovePartner` semantics.
  - Added parser aliases and event dispatch for both commands, with Python-shaped
    missing-unit/traveler guards, same-team player targeting, true pair-up versus
    Rescue fallback selection, and event separation that does not place the traveler.
  - Added reversible Rescue, PairUp, Separate, Drop, and RemovePartner relationship
    state: lead/traveler roles, guard-gauge merge/split and clamping, follower turn
    reset, sourced Pair Up/Rescue skills, exact skill-index restoration, board
    placement, and wait/drop flags all survive undo/redo.
  - Persisted relationship roles, guard state, rescue action flags, and per-instance
    skill source metadata with backward-compatible defaults. Level cleanup now removes
    sourced traveler effects without deleting natural same-NID skills.
  - Switched player menus and Rescue/Drop states between Pair Up/Separate and classic
    Rescue/Drop according to project constants. Added regressions for the Rekka-style
    fallback, real player-state selection, true guard stance, sourced duplicate skills,
    save/load, cleanup, and turnwheel. Inventory advanced to **206/255 recognized
    commands / 196 case labels** and **69/241 skill exact references / 67 hook
    surfaces**; the full serial gate is **89/89 passing**.

- **Item availability, combat EXP, and weapon-triangle parity slice:**
  - Added Python-shaped item availability for uses/chapter uses, HP and mana costs,
    cooldown state, class weapon access and ranks, personal/class/tag/affinity
    restrictions, evaluated conditions, conditional skill prohibitions, active item
    overrides, and immediate parent-item restrictions. Default player menus,
    targeting, counters, and AI now select only available items.
  - Ported `unlock_staff` target discovery against exact `can_unlock` event regions,
    including full region geometry and suppression of unrelated splash components.
    Cooldown-backed items now initialize the same runtime data fields as Python.
  - Ported component `level_exp`, including promoted internal-level traversal,
    standard/Gompertz curves, self/enemy multipliers, kill/boss rewards, minimum EXP,
    allied-target exclusion, and final encounter clamping. Fixed EXP and level EXP
    aggregate across unique defenders and remain reversible/save-safe.
  - Expanded weapon-triangle resolution to independent advantage/disadvantage matches,
    `All` rank ordering, reaver/double-triangle modifiers, overrides, ignore hooks,
    and defender-derived avoid/resist adjustments.
  - Added default-project and synthetic regressions spanning menus, targeting, AI,
    unlock regions, parent/override conditions, EXP curves, turnwheel, save/load, and
    triangle combinations. Inventory advanced to **110/201 item exact references / 92
    hook surfaces** and **67/241 skill exact references / 65 hook surfaces**; the full
    serial gate is **87/87 passing**.

- **Persistent combat RNG and skill-proc lifecycle slice:**
  - Replaced gameplay `Math.random()` hit/crit rolls with LT's persisted 31-bit
    combat LCG. Classic, integer two-RN True Hit, three-RN True Hit Plus, Fates
    Hit, and Grandmaster modes now consume the Python-shaped stream; its seed and
    state round-trip through existing game-variable saves.
  - Added a reversible combat-setup record alongside combat results. Turnwheel
    reverse/redo restores the exact pre/post RNG state, skill list, and per-skill
    charge data without rerolling or leaving a temporary proc skill installed.
  - Ported `attack_proc`, `defense_proc`, `attack_pre_proc`, and
    `defense_pre_proc` lifecycle scopes, including multiple simultaneous procs,
    enemy checks, equation proc rates, allowed-weapon and ordinary/combat
    conditions, `build_charge`/`drain_charge`/`charges_per_turn` consumption, and
    combat charge increases. Main+splash attacks share attacker procs and charge
    once while each defender evaluates its own defense proc.
  - Temporary skill modifiers now contribute their Python component aliases
    (`damage`, `resist`, `hit`, `avoid`, crit, and speed). Proc item overrides are
    scoped and restored around calculations, enabling the bundled Luna,
    Lethality, Sure Strike, and Pavise effect shapes. Exact `(attack, subattack)`
    tuples now flow from the solver into item-combat events.
  - Added deterministic regressions for the literal Python LCG sequence,
    turnwheel and save/load restoration, charge consumption, conditional
    suppression, grouped proc sharing, defense/pre-proc cleanup, and bundled
    proc prefabs. Item inventory advanced to **95/201 exact references / 77 hook
    surfaces** and skill inventory to **63/241 exact references / 65 hook
    surfaces**; the full serial gate is **85/85 passing**.

- **Reversible combat-result and event lifecycle slice:**
  - Added one snapshot-backed `CombatResultAction` shared by map and full-animation
    combat. HP, EXP, level/stat/growth-point rolls, WEXP, skills/statuses, item
    ownership/data/uses, and canto now undo exactly and redo from the captured
    result without rerolling.
  - Made combat death removal reversible across the board and initiative tracker,
    preserving exact initiative lines/index on rewind. Combat turn completion now
    records attacked/wait state through actions as well.
  - Matched the Python lifecycle ordering and payload shape for `combat_start`,
    `combat_death`, `combat_end`, and `unit_death`, including pre-combat event
    blocking, captured death positions, playback, animation mode, and the actual
    last-strike killer.
  - Added specific-event dispatch for item `event_on_use`, `event_on_hit`,
    `event_after_use`, `event_after_combat`, `event_after_combat_on_hit`, and
    `event_after_combat_even_miss`. These bypass prefab conditions like Python and
    expose target, target position, mode, attack-info tuple, and both items. Their
    queue order is verified; pausing inside strike playback remains part of the
    deeper proc/sub-combat lifecycle work.
  - Added four regressions covering direct grouped result undo/redo, item-event
    ordering/local arguments, `CombatState` start/end blocking payloads, and a
    lethal real encounter's death ordering/killer/board/initiative rewind. Item
    inventory advanced to **92/201 exact references / 74 hook surfaces**; the full
    serial gate is **83/83 passing**.

- **Deterministic generic Feat learned-skill slice:**
  - Added LT's seed+1 growth LCG as a shared engine random stream. Its seed and
    current state live in persisted game variables, reset when `_random_seed`
    changes, and round-trip through existing save/load serialization.
  - Ported `unit_funcs.get_starting_skills` class traversal into one resolver,
    including promotion-skill inheritance order, starting-level boundaries,
    ordinary-skill deduplication, database-ordered `feat` discovery, and exclusion
    of already-owned or already-selected Feats.
  - Generic creation now grants eligible class skills before stat autoleveling;
    `autolevel_to` uses the same resolver and reversible `AddSkillAction`s. Each
    eligible `Feat` consumes exactly one LT growth roll when `generic_feats` is on.
  - Added end-to-end regressions for disabled selection, exact sequential LCG
    choices, distinct multi-Feat selection, turnwheel undo/redo, and RNG-state
    save/restore. Harness inventory is now **79 tests**; the full serial gate is
    **79/79 passing**.

- **Multi-defender AOE combat execution slice:**
  - Added Python-shaped grouped strike resolution: the main defender follows
    normal vantage/counter/double ordering, splash defenders never counter and
    are processed immediately after the propagated attacker strike, and pure
    spell AOE operates without a synthetic main defender.
  - Default splash now receives only the first attacker subattack; the
    `double_splash` constant propagates brave/additional attacks. Every affected
    hit retains its own hit/crit/damage roll, `splash` combat mode, component
    hooks, and durability loss.
  - Extended map combat presentation to track HP, lunge/shake, flash, and damage
    popups for every defender. CombatState and immediate `interact_unit` combat
    resolve the same target group, force grouped encounters to map presentation,
    remove/trigger death handling for every casualty, and activate every
    involved AI group.
  - Aggregated fixed EXP, ordinary combat EXP, WEXP, rank crossings, statuses,
    multi-death results, and droppable-item discovery across unique affected
    defenders while preserving main-only defensive WEXP and counters.
  - Added direct solver/controller and end-to-end CombatState regressions for
    strike order, main-only counters, default and `double_splash` propagation,
    durability, fixed EXP/WEXP, pure AOE routing, multi-death/drop reporting,
    and map return. Harness inventory is now **77 tests**; the full serial gate is
    **77/77 passing**.

- **Uncommon AOE geometry and skill-driven splash slice:**
  - Ported Python's remaining AOE item geometries: configurable/repeating
    `shape_blast_aoe`, attacker-centered `enemy_cleave_aoe`, and taxicab-grid
    `line_aoe`/`enemy_line_aoe`. Shape targeting preserves ally/enemy/all
    filtering and its Python `unsplashable` policy.
  - Added NUMERIC_ACCUM splash empowerment and UNIQUE alternate-splash dispatch
    for `oversplash`, `enemy_oversplash`, `smart_oversplash`, and `Cleave`.
    Existing blast/equation/shape radii receive the accumulated bonus; otherwise
    the selected skill supplies its Python-equivalent blast or cleave component.
  - Split affected-unit resolution from preview geometry so empty tiles remain
    highlighted, enemy previews hide allied occupants, global previews cover the
    board, and actual item/AI target expansion still contains live units only.
  - Added isolated geometry/filter/interaction coverage for line, shape,
    Oversplash, Cleave, and `unsplashable`. Item coverage advanced to **86/201
    exact references / 74 hook surfaces** and skill coverage to **41/241 exact
    references / 64 hook surfaces**; the full serial gate is **75/75 passing**.

- **Steal item/ability/AI parity slice:**
  - Implemented shared `steal` and `gba_steal` legality: STEAL_ATK/STEAL_DEF
    equations, separate accessory/non-accessory capacity, locked/unstealable
    exclusion, generic Steal's unequipped-item rule, and GBA Steal's
    non-weapon/non-spell rule.
  - Skill-provided Steal now appears as an action-menu ability backed by the
    project's `Steal` item prefab; inventory Steal items use the Item menu. Both
    route through map target selection, an exact defender-inventory choice, and
    one-sided auto-hit combat. Utility combat items without a damage hook no
    longer inherit STR/MAG damage.
  - Successful Steal queues a reversible item transfer and steal record, marks
    AI-stolen items droppable, grants component EXP/durability, and shows a
    post-combat stole-item banner. AI Steal behavior now chooses the most
    valuable legal item instead of falling through to weapon attacks.
  - Added equation, capacity, generic/GBA, AI choice, player UI, zero-damage,
    undo/redo, records, and save/load coverage. Item coverage advanced to
    **81/201 exact references / 74 hook surfaces** and skill coverage to
    **37/241 exact references / 60 hook surfaces**; harness inventory is now
    **74 tests**, all passing in the full serial gate.

- **Hit-resolved hostile status-staff combat slice:**
  - Routed non-weapon status spells such as Berserk, Sleep, and Silence from the
    Item menu and component-valid map targeting into one-sided map combat. Spell
    attacks now match Python by disabling counterattacks, counterability, doubling,
    and unavailable full-battle-animation weapon poses.
  - Added Python formula precedence for item/skill alternate and override accuracy
    and avoid equations. Defensive status-staff avoid correctly comes from the
    attacking item (`STATUS_STAFF_AVOID`) rather than the defender's weapon.
  - Added shared map/full-animation combat component resolution for successful
    `status_on_hit`/`status_after_combat_on_hit` hooks, fixed staff EXP, WEXP,
    `miss_wexp`/`double_wexp`/`kill_wexp` policies, class caps, rank-crossing
    detection, `unit_weapon_rank_up` triggers, and a post-combat rank banner.
    Existing `uses_options` semantics preserve durability on misses unless opted in.
  - Added deterministic forced-hit/miss formula/reward coverage plus an end-to-end
    Item → target → map combat → turn-completion regression. Item coverage advanced
    to **78/201 exact references / 72 hook surfaces** and skill coverage to
    **36/241 exact references / 60 hook surfaces**; full harness result:
    **73/73 passing**.

- **Sequence/multi-target movement and reward slice:**
  - Replaced the recursive-target union shortcut in interactive item use with
    Python-shaped target collection: target counts are enforced per item/child,
    prior positions are excluded unless allowed, flexible counts can confirm
    early, and sequence children advance in declared order.
  - Implemented `store_unit` → `unload_unit` for the bundled Warp and Rescue
    staffs, including empty/simple-traversable destination filtering,
    `ignore_forced_movement`, a reversible warp action that preserves the moved
    unit's turn flags, and one durability loss on the sequence parent.
  - Core item use now grants reversible fixed EXP and WEXP with self/enemy skill
    multipliers and `double_wexp` policy. Rank-up/EXP presentation playback is
    still open; state changes are no longer silently omitted.
  - Added interactive sequence and ordinary multi-target regressions covering
    mouse selection, distinct-target enforcement, parent durability, EXP/WEXP,
    undo/redo, and sequence save/load. Item coverage advanced to **74/201 exact
    references** and skill coverage to **32/241 exact references / 58 hook
    surfaces**; full harness result: **71/71 passing**.
  - Corrected the Light Brand regression to honor `lose_uses_on_miss = false`:
    a hit consumes one use while an RNG miss preserves durability. The scenario
    passed five repeated runs before the full-suite gate.

- **Hammerne inventory-targeting slice:**
  - Added Python-shaped repair discovery: a repair staff can target only units
    carrying a finite-use damaged item, while `unrepairable` items are excluded.
  - Extended interactive item targeting with the second-stage inventory menu
    used by Hammerne. Keyboard, mouse, cancel, exact runtime-instance selection,
    reversible repair, staff durability, and turn completion share the existing
    core item-use lifecycle.
  - Added an end-to-end map target → inventory target → apply → undo → redo
    regression. Item coverage advanced to **71/201 exact references**; full
    harness result: **69/69 passing**.

- **Targeted status, restore, and refresh item slice:**
  - Added core targeted execution for deterministic `status_on_hit` and
    `status_after_combat_on_hit` effects, negative/specific status restoration,
    and refresh. This covers the bundled project's 15 deterministic status uses,
    four post-combat status buffs, two restore items, and refresh item.
  - Added reversible exact-instance skill removal and exact turn-state refresh
    actions. Target discovery now excludes restore targets without matching
    statuses and refresh targets that have not finished their turn.
  - Added an end-to-end validity → apply → undo → redo → save/load regression.
    Hit-resolved hostile status staves and presentation playback remain open
    rather than being approximated with guaranteed effects.
  - Item coverage advanced to **69/201 exact references**; skill coverage to
    **30/241 exact references**; full harness result: **68/68 passing**.

- **Interactive healing-item targeting slice:**
  - Added the `item_targeting` map state and routed ranged healing staves/spells
    from the item menu through `TargetSystem` instead of applying every item to
    the user. Full-HP targets are excluded by the Python `Heal.target_restrict`
    rule; zero-range consumables still resolve immediately on self.
  - Corrected missing range defaults from 1 to Python's 0, admitted equation-heal
    staves and stat boosters into core item-use discovery, and added keyboard,
    mouse/touch-coordinate, cancel, cycling, and range-highlight handling.
  - Core heal/equation-heal effects, durability, break removal, and turn finish
    now use reversible actions. Added an end-to-end item menu → mouse-selected
    ally → equation heal → undo/redo regression; full harness result: **67/67
    passing** and registered state coverage advanced to **41 states**.
  - Remaining interactive item work includes hostile hit-resolved effects,
    additional item-target hooks such as steal, and presentation playback.

- **Per-strike durability and `uses_options` slice:**
  - Replaced unconditional once-per-combat weapon durability loss with Python's
    hit lifecycle: one use per successful strike by default, optional loss on
    misses, and optional collapse to one qualifying loss for the whole combat.
  - Applied the shared policy to map and full animation combat for both attacker
    and defender, including brave/multi-strike and scripted combat sequences.
    `no_break_out_of_uses` items now become unusable at zero without being removed.
  - Added deterministic mixed-hit/miss, miss-only, one-loss, direct combat
    integration, and persistent-broken-item fixtures. Item coverage advanced to
    **64/201 exact references** and **68/201 matching hook surfaces**; full
    harness result: **66/66 passing**.

- **Fog, LOS, splash, and target-count slice:**
  - Completed the Python target-resolution order in `TargetSystem`: range and
    optional Bresenham LOS, component splash expansion, targeting-fog filtering,
    ALL-policy restrictions, then minimum target-count validation.
  - Added hooks for targeting-fog/LOS overrides, `multi_target`, same/fewer-target
    policies, splash previews, blast/enemy/ally/equation blast, all-allies
    (including except-self), and all-enemies AOE behavior. This covers every AOE
    component used by the bundled Sacred Stones project; uncommon shape/line/cone
    variants remain inventoried for later implementation.
  - Fog targeting now preserves self and Tile-tag visibility, respects player/AI
    fog policy, filters both main and splash positions, and supports
    `target_fog_of_war`; LOS honors project opacity and `ignore_line_of_sight`.
  - Added fixture coverage for blast membership, global ally splash, strict and
    flexible multi-target counts, fog bypass/Tile tags, and an injected opacity
    blocker. Item coverage advanced to **62/201 exact references** and **67/201
    matching hook surfaces**; full harness result: **65/65 passing**.

- **Item range and target-restriction slice:**
  - Added `max_equation_range` and `global_range` resolution plus
    `eval_special_range` relative-coordinate filtering to `TargetSystem`; the
    bundled `MAGIC_RANGE` equation now gives staves their calculated reach.
  - Implemented ALL-policy target restrictions for `eval_target_restrict_2`,
    `empty_tile_target_restrict`, and `traversable_tile_target_restrict`, using
    class movement groups and the unit's movement value like Python.
  - Extended expression context with `target`, `target.wexp`, `target_pos`,
    `item`, and `game.get_region_under_pos`, covering all thirteen restriction
    expressions used by the bundled project.
  - Added equation, special range, level/tag/vision expression, empty tile, and
    terrain-cost fixtures. Item coverage advanced to **47/201 exact references**
    and **48/201 matching hook surfaces**; full harness result: **64/64 passing**.

- **Item valid-target hook slice:**
  - Added a Python-shaped `TargetSystem` and the union-resolved `validTargets`
    component hook for `target_tile`, `target_unit`, `target_enemy`, and
    `target_ally`, followed by Manhattan item-range intersection.
  - Routed player weapon discovery through the target system instead of a
    hard-coded enemy scan, and added recursive multi/sequence target discovery;
    sequence children must each have at least one valid target.
  - Added a fixture regression covering ally/enemy/unit/tile sets, self-targeting,
    component union policy, map-edge range filtering, and recursive child unions.
    Item coverage advanced to **41/201 exact references** and **31/201 matching
    hook surfaces**; full harness result: **63/63 passing**.
  - Remaining target-system work is explicit: expression/special-range and
    empty/traversable restrictions, fog/LOS, splash, target counts, and the
    interactive non-weapon/sequence selection flow.

- **Recursive multi/sequence item runtime slice:**
  - Added recursive `ItemObject.subitems`/`parentItem` graphs and ownership
    propagation; starting items and event-granted items now instantiate children
    declared by `multi_item` and `sequence_item` components.
  - Implemented reversible `add_item_to_multiitem` and
    `remove_item_from_multiitem`, including `no_duplicate`, remove-all, recursive
    item lookup, nested tree registration, and recursive `set_item_uses` support.
  - Extended canonical item serialization with child-key graphs and two-pass
    restoration, preserving child identity, uses, parent links, and propagated
    ownership across save/load. The query engine now reads the runtime graph.
  - Added real Rescue sequence construction plus event add/remove, undo/redo, and
    save round-trip coverage. Command coverage advanced to **204/255 parsed** and
    **194/255 dispatched**; full harness result: **62/62 passing**.

- **Reversible inventory/convoy movement and canonical save identity:**
  - Implemented `move_item` across unit→unit, unit→convoy, and convoy→unit
    routes, plus `move_item_between_convoys` for named parties. Capacity checks
    distinguish normal items from accessories using project constants.
  - Routed `remove_item` through reversible unit/convoy actions instead of direct
    array mutation, preserving original inventory slots and owner references.
  - Fixed a save-system identity bug exposed by movement tests: item references
    are now assigned canonical keys from their current unit/convoy container by
    object identity, rather than reconstructing stale owner-derived registry keys.
  - Added a five-route turnwheel and multi-party save/load regression. Command
    coverage advanced to **202/255 parsed** and **192/255 dispatched**; full
    harness result: **61/61 passing**.

- **Reversible item-property event slice:**
  - Implemented `change_item_name`, `change_item_desc`, `set_item_data`,
    `set_item_uses` (including `additive`), `set_item_droppable`, and
    `break_item` through reversible actions for unit inventories and convoy lookup.
  - Added synchronized runtime item data for normal/chapter uses; ordinary item-use
    and weapon-use reversal now keep that data mirror consistent.
  - Persisted runtime item data and mutable instance name/description with
    backward-compatible save defaults; DB-backed restore no longer overwrites
    instance-specific text saved by events.
  - Added focused parser/dispatch, turnwheel undo/redo, and save/load coverage.
    The command inventory advanced to **201/255 parsed** and **190/255 dispatched**;
    full harness result: **60/60 passing**.

- **Generated item/skill component manifests:**
  - Extended the parity audit to inventory all 201 Python item components and
    241 skill components, including nested classes, source line, tag, direct
    Python hook methods, matching camelCase web hook exports, exact TypeScript
    string-reference locations, test mentions, and structural status.
  - Added machine-readable and review-friendly manifests at
    `docs/parity/item-components.{json,md}` and
    `docs/parity/skill-components.{json,md}`; the existing audit/CI drift guard
    now validates all six generated parity artifacts.
  - Established the first actionable structural baseline: 38 item and 29 skill
    NIDs have exact web references, while 23 item and 55 skill component classes
    expose at least one Python hook with a matching web hook surface. These are
    discovery counts, not semantic parity claims.

- **Generated command manifest and reversible unit-mutation slice:**
  - `npm run audit:parity:write` now generates JSON and Markdown manifests for all
    255 Python event-command NIDs, including Python class/tag/arguments/flags,
    nickname aliases, parser and dispatcher presence, web blocking classification,
    lexical test mentions, and structural status.
  - `npm run audit:parity` checks generated files for drift and enforces monotonic
    parser/dispatcher minimums; a GitHub Actions workflow runs the guard on pushes
    and pull requests.
  - Added persistent unit variant, faction, generic identity, description, notes,
    custom fields, and stat-cap modifiers, with backward-compatible save defaults.
  - Implemented reversible actions and event dispatch for unit name/variant/AI group,
    faction/portrait/description/affinity, growth and cap modifiers, custom fields,
    and categorized unit notes. Generic faction changes also update display text.
  - Added turnwheel undo/redo and save/load coverage for the complete slice; full
    harness result: **59/59 passing**.

- **Autolevel and WEXP rank-up parity slice:**
  - Added `src/engine/leveling.ts`, a faithful autolevel implementation for
    Fixed, Random, Dynamic, Lucky, and BEXP growth methods, including LT's
    MD5-seeded LCG, level-down behavior, class/difficulty/skill growth bonuses,
    negative growths, stat caps, and dynamic growth points.
  - Added reversible `AutoLevelAction` and `AddSkillAction`; `autolevel_to` now
    supports explicit/default growth methods, `hidden`, `unit_level_up` triggers,
    personal/class learned skills, and promotion-skill inheritance.
  - Persisted dynamic growth points with backward-compatible save defaults.
  - Added EVNT `{e:...}`/`{eval:...}` argument evaluation and game/level-variable
    substitution, required by real default and Rekka autolevel scripts.
  - WEXP crossings now emit `unit_weapon_rank_up` with trigger metadata and show
    a dismissible rank banner unless `no_banner` is present.
  - Added Python-derived fixed/random/dynamic golden tests, trigger/banner tests,
    dynamic-growth save round-trip coverage, and turnwheel undo/redo checks;
    full harness result: **58/58 passing**.

- **Parity plan and event mutation slice:**
  - Added `npm run audit:parity`, which inventories Python event commands and
    item/skill components against web parser/dispatcher/hook surfaces.
  - Synchronized parser registration for already-implemented overworld and roam
    commands that EVNT scripts previously dropped before dispatch.
  - Implemented reversible `give_wexp`, `set_wexp`, `set_unit_level`, `resurrect`,
    `add_lore`, and `remove_lore` event mutations following the Python source.
  - Added per-save lore persistence with backward compatibility for older saves.
  - Added a focused Playwright regression for parsing, mutation semantics, and lore
    save/load round trips; full harness result: **54/54 passing**.

- **Process docs update (agent commit/push policy clarified):**
  - Updated `AGENTS.md` commit policy section to explicitly state the
    rule applies to all session types and all edit scopes (code/docs/config).

- **Dialogue text-speed parity fix (settings now actually affect typing):**
  - Updated `src/ui/dialog.ts` to use LT-style time-based typing speed
    (milliseconds per character) instead of a fixed chars-per-frame step.
  - Updated `src/engine/states/game-states.ts` to read `_setting_text_speed`
    and pass it into each new `Dialog` instance, with default fallback `32`.
  - Added LT dialog speed overrides:
    - Per-command `text_speed` (keyword and semicolon positional forms)
    - Inline text commands `{speed:X}`, `{starting_speed}`, `{max_speed}`
    now update typing cadence during the same dialog line.
  - `Text Speed = 0` now behaves like LT max-speed mode (instant reveal).

- **Event-state dialog/background parity fixes + regression coverage:**
  - Fixed portrait mouth animation lifecycle in `src/engine/states/game-states.ts`:
    speaking portraits now start/stop talking on dialog typing-state transitions,
    and reliably stop on skip/dismiss paths.
  - Fixed async cutscene background race in `src/engine/states/game-states.ts`:
    `change_background` now blocks until panorama load completes (or fails),
    with token-guarded completion to avoid stale async overwrites.
  - Added regression in `tests/harness.spec.ts`:
    `Dialog portraits stop talking while waiting for input`.

- **AI region interaction + recruit persistence + Sacred Stones soak automation:**
  - Added two new harness regressions in `tests/harness.spec.ts`:
    - Ch.2 AI-driven `PursueVillage` `Destructible` interaction (forced enemy AI phase)
      verifies `DestroyVillage3` + `Village3` region consumption and `Ruin3` layer reveal.
    - Recruit persistence regression: simulated recruited Joshua survives chapter cleanup/reload
      with player allegiance intact and appears in `prep_pick` party roster.
  - Fixed persistent-unit chapter load behavior in `src/engine/game-state.ts` to match Python:
    persisted units now preserve runtime team/AI allegiance instead of being overwritten by
    next-level prefab team/AI fields.
  - Added Sacred Stones reliability soak automation:
    - New script `scripts/sacred-stones-soak.mjs` loops Playwright Sacred Stones suites
      (`SOAK_ITERATIONS`, `SOAK_GREP`, `SOAK_WORKERS` configurable, fail-fast on first failure).
    - Added npm scripts: `test:harness`, `test:ss:soak`.
    - Documented soak usage in `TESTING.md`.
  - Added screenshots:
    `60-ch2-ai-destructible-interact-ruin3.png`,
    `61-recruit-persistence-prep-flow-joshua.png`.

- **Chapter 4/5 regression matrix sweep (outro branches, villages, arena, ordering, turn idempotency):**
  - Added five harness regressions in `tests/harness.spec.ts` for:
    - Ch.4 outro branch matrix across Artur/Lute permutations (Artur-only, Lute-only, both alive, both dead)
    - Ch.5 `Village1/3/4` visit reward matrix with one-time reward + region-consumption checks
    - Ch.5 arena interaction flow (menu option, event progression, return-to-map control)
    - Ch.5 visit-vs-destroy ordering semantics (one-time region consumption in both directions)
    - Ch.5 turn-event idempotency for `Turn2/4/8` over repeated long-window retriggers
  - Updated region cleanup semantics in `src/engine/states/game-states.ts` so triggering one
    side of village Visit/Destructible siblings consumes both matching one-time regions on the same tile.
  - Added screenshots:
    `55-ch4-outro-branch-matrix.png`,
    `56-ch5-village134-visit-matrix.png`,
    `57-ch5-arena-flow-return.png`,
    `58-ch5-village-ordering-visit-vs-destroy.png`,
    `59-ch5-turn-event-idempotency.png`.
  - Focused Playwright pass for these five new regressions: **5/5**. Build also passes (`npm run build`).

### Ralph Loop Backlog (Autonomous)

- [x] **Chapter 4 outro branch matrix regression coverage.** Add tests for Artur-only, Lute-only,
  both alive, and both dead paths; verify dialogue/event progression and clean transition behavior.
- [x] **Chapter 5 village visit matrix regression coverage.** Add deterministic tests for
  `Village1/3/4` rewards and region consumption; verify no duplicate rewards on re-interact attempts.
- [x] **Chapter 5 arena interaction flow coverage.** Validate arena menu availability,
  interaction state flow, and safe return to map control without soft-lock.
- [x] **Chapter 5 village destroy-vs-visit ordering checks.** Add race-condition tests for
  enemy destructible events vs player visits to ensure one-time semantics and layer toggles are correct.
- [x] **Chapter 5 turn-event idempotency sweep.** Re-trigger `Turn2/4/8` conditions across long
  frame windows and confirm no duplicate group spawn or stale event-state stacking.
- [x] **Enemy AI region interaction regression.** Add harness coverage for AI-driven
  `Destructible` interactions and validate region removal + event side effects match manual interactions.
- [x] **Recruit persistence across chapter transitions.** Add regression tests ensuring recruited
  units remain correctly assigned/serialized through subsequent chapter loads and prep flow.
- [x] **Sacred Stones reliability soak run automation.** Add a long-run harness pass that executes
  multi-chapter mechanics batches repeatedly and fails on non-deterministic state regressions.

- **Chapter 4/5 additional event sweep (Village1, Turn3 cameo, Turn4 brigands):**
  - Added mechanics regressions in `tests/harness.spec.ts` for:
    - Ch.4 Village1 visit grants `Iron_Axe` and consumes region
    - Ch.4 Turn3 cameo event (`L'arachel`/`Dozla`/`Rennac`) exits cleanly
      with temporary units removed from map
    - Ch.5 Turn4 event spawns `Brigand2` group (`118`,`119`)
  - Added screenshots:
    `52-ch4-village1-iron-axe.png`,
    `53-ch4-turn3-cameo-cleared.png`,
    `54-ch5-turn4-brigand2-spawn.png`.
  - Full Playwright harness suite now passes: **45/45**.
- **Chapter 4 event edge-case sweep (villages, trigger region, snag bridge):**
  - Added mechanics regressions in `tests/harness.spec.ts` for:
    - Ch.4 Village2 visit recruits Lute and consumes region
    - Ch.4 Trigger region spawns `RevenantRein` group on turn-change
    - Ch.4 Snag death triggers bridge layer reveal (`show_layer;Snag`)
  - Added screenshots:
    `49-ch4-village2-recruits-lute.png`,
    `50-ch4-trigger-revenant-reinforcements.png`,
    `51-ch4-snag-bridge-layer-revealed.png`.
  - Full Playwright harness suite now passes: **42/42**.
- **Chapter 3 outro branch coverage (recruit-dependent transition):**
  - Added mechanics regressions in `tests/harness.spec.ts` for:
    - Ch.3 outro branch with Neimi+Colm alive confirms Colm becomes `player`
      during outro before transition to Ch.4
    - Ch.3 outro branch with Colm dead still transitions cleanly to Ch.4
      without title-state fallback
  - Added screenshots:
    `47-ch3-outro-colm-player-before-ch4.png`,
    `48-ch3-outro-colm-dead-transition-ok.png`.
  - Full Playwright harness suite now passes: **39/39**.
- **Chapter 3 Colm flow coverage (spawn + recruitment):**
  - Added mechanics regressions in `tests/harness.spec.ts` for:
    - Ch.3 `other_turn_change` event spawns Colm and moves him to chest room
    - Ch.3 Neimi->Colm talk recruits Colm to player team
  - Added screenshots:
    `45-ch3-colm-turn-event-spawn.png`,
    `46-ch3-neimi-recruits-colm.png`.
  - Full Playwright harness suite now passes: **37/37**.
- **Destructible village sweep (Ch.2 + Ch.5) + trigger compatibility fix:**
  - Added mechanics regressions in `tests/harness.spec.ts` for:
    - Ch.2 `DestroyVillage1/2/3` -> `Ruin1/2/3` layer visibility + region removal
    - Ch.5 destructible village interactions (`DestroyVillage2/4`) -> `Ruin2/4`
  - Fixed region-trigger compatibility in `src/engine/states/game-states.ts`
    (menu and AI interaction paths): when `Destructible` trigger from
    `DestroyX` has no matching event, retry using sibling `X` region context.
  - Added screenshots:
    `43-ch2-destructible-villages-ruins.png`,
    `44-ch5-destructible-villages-ruins.png`.
  - Full Playwright harness suite now passes: **35/35**.
- **Chapter 3 full lock interaction sweep (all chest/door variants):**
  - Added mechanics regressions in `tests/harness.spec.ts` for:
    - All remaining Ch.3 chests (`Chest2/3/4`) unlock + loot checks
    - Remaining Ch.3 doors (`Door2/3`) unlock + region removal checks
  - Hardened harness flow by reloading clean Ch.3 per lock interaction case to
    avoid cross-case turn-state contamination from finished action flags.
  - Added screenshots:
    `41-ch3-all-chests-unlocked.png`,
    `42-ch3-door2-door3-unlocked.png`.
  - Full Playwright harness suite now passes: **33/33**.
- **Chapter 3 unlock interaction coverage + can_unlock fix:**
  - Added mechanics regressions in `tests/harness.spec.ts` for:
    - Ch.3 chest interaction gating + unlock + loot (`Javelin`)
    - Ch.3 door interaction gating + unlock region removal
  - Fixed `unit.can_unlock(region)` condition handling in
    `src/events/event-manager.ts` to support runtime `Map` components and
    `can_unlock` component expressions (including `region.nid.startswith(...)`).
  - Updated unlock consumption in `src/engine/states/game-states.ts` to treat
    `can_unlock` items as key items for use decrement/removal.
  - Added screenshots:
    `39-ch3-chest1-unlock-javelin.png`,
    `40-ch3-door1-unlock-opened.png`.
  - Full Playwright harness suite now passes: **31/31**.
- **Chapter interaction coverage expansion (villages + shops):**
  - Added chapter mechanics regressions in `tests/harness.spec.ts` for:
    - Ch.2 Village1 Visit grants `Red_Gem` and consumes region
    - Ch.5 Village2 Visit grants `Armorslayer` and consumes region
    - Ch.5 Vendor and Armory region menu options appear on correct tiles
  - Added screenshots:
    `36-ch2-village1-visited-red-gem.png`,
    `37-ch5-village2-visited-armorslayer.png`,
    `38-ch5-vendor-armory-menu-options.png`.
  - Sacred Stones chapter suites (`Later Chapters` + `Chapter Mechanics`) now
    pass **15/15**.
- **Deeper Sacred Stones chapter sweep (Ch.2–Ch.5 mechanics):**
  - Added chapter mechanics tests in `tests/harness.spec.ts`:
    - Ch.3 seize objective transitions to Ch.4
    - Ch.4 turn-2 reinforcements (`Turn2Rein`) spawn
    - Ch.5 turn-2 and turn-8 brigand reinforcements spawn
    - Ch.5 Natasha→Joshua talk recruitment converts Joshua to player team
  - Fixed talk menu regression in `src/engine/states/game-states.ts` by passing
    `levelNid` into `getEventsForTrigger()` for `on_talk` checks.
  - Added screenshots:
    `32-ch3-seize-transition-ch4.png`, `33-ch4-turn2-reinforcements.png`,
    `34-ch5-turn2-turn8-reinforcements.png`, `35-ch5-natasha-recruits-joshua.png`.
  - Full Playwright harness suite now passes with expanded coverage: **26/26**.
- **Sacred Stones multi-chapter smoke coverage + harness state fix:**
  - Added chapter smoke tests for Ch.2–Ch.5 in `tests/harness.spec.ts`:
    clean-mode map load checks + non-clean intro progress checks.
  - Added screenshots for each chapter intro/map checkpoint:
    `30-ch{2..5}-clean-map.png`, `31-ch{2..5}-intro-progress.png`.
  - Fixed duplicate `EventState` stacking in `src/harness.ts` by removing
    redundant manual `change('event')` in `loadLevel()`.
  - Full harness suite now passes with expanded coverage: **22/22**.
- **Animation combat sprite-load race fix + regression test:**
  - Fixed startup race in `src/combat/animation-combat.ts`: `updateInit()` now
    gates transition to visible phases until both combatants have resolved
    `mainFrame` draw data, with a 1500ms fail-safe timeout.
  - Added Playwright regression in `tests/harness.spec.ts`:
    `Animation Combat Rendering › combat sprites resolve before visible
    animation phases (no stub boxes)`.
  - Captures `test-screenshots/26-animation-combat-no-stubs.png`.
  - Full harness suite now passes: **14/14**.
- **Harness + visual regression stabilization (Sacred Stones test run):**
  - Fixed harness boot regression in `main.ts`: project picker is now bypassed
    in `?harness=true` runs, defaulting to `default.ltproj` for deterministic
    automated tests.
  - Fixed flaky magic-sword regression assertion in `tests/harness.spec.ts`:
    test now verifies deterministic weapon-use consumption (`Light Brand` uses
    decremented) instead of requiring guaranteed HP damage on RNG-dependent hit.
  - Re-ran full harness suite after fixes: **13/13 passing**.
- **Seven bug fixes across combat, UI, events, and state management:**
  1. **Dialog over portrait:** Auto-sized dialog width to text content, ported
     Python's `get_desired_center()` mapping for portrait-relative positioning.
  2. **Combat animation speed:** Made `tickAnims` unconditional in top-level
     `update()` (matching Python), removed `Math.max(1, ticks)` from 5 call sites.
  3. **Blue highlight rectangle:** Added `highlight.clear()` to FreeState begin/end
     and TurnChangeState (matching Python's cleanup lifecycle).
  4. **Cursor loss after combat:** Added finished-unit guard to WeaponChoiceState,
     added `'repeat'` returns to all dead-unit early-exit paths for instant cascade.
  5. **Red rectangle during magic combat:** Cleared targets in TargetingState.end()
     to prevent stale draw under transparent CombatState.
  6. **Combat UI layout:** Fixed name tag size (80→66x16), centered name text,
     fixed HP bar height (56→40px), adjusted stat layout to fit.
  7. **Early reinforcements:** Changed event condition fallback from `true` to
     `false` in event-manager.ts, added error logging to JS fallback evaluator.
- **Combat animation platform/sprite positioning fix (two passes).** Fixed six
  bugs causing terrain pillars to move around and sprites to float during
  ranged/magic combat animations:
  - Computed `atRange = distance - 1` (matching Python) instead of passing raw
    Manhattan distance. Fixes melee getting ranged pan/poses/platforms.
  - Added `leftRangeOffset`, `rightRangeOffset`, `panOffset`, `totalShakeX`,
    `totalShakeY` to `AnimationCombatRenderState`. `drawBattleSprite` now passes
    per-side range offsets to `drawAnimFrame`, which applies them Python-faithfully:
    `spriteLeft = -totalShakeX + rangeOffset + panOffset`.
  - Negated shake X for sprites (`-totalShakeX`) matching Python's
    `shake = (-total_shake_x, total_shake_y)`. Combined screen + platform shake
    into `totalShakeX`/`totalShakeY` for both platforms and sprites.
  - **Pan logic overhaul:** Added phase-change pan in `updateBeginPhase()` so
    the camera pans to focus on each new attacker (matching Python's
    `set_up_combat_animation -> move_camera`). Split `pan()` into `panAway()`
    (simple toggle) and `panBack()` (looks at next strike to determine focus).
    Added `panAway` boolean to `BattleAnimation` with safety cleanup when a
    pose ends without issuing the return pan command.
  - Pan advancement now uses a separate frame accumulator for frame-rate
    independence (ticks at 60fps like Python regardless of browser refresh rate).
- **Level progression / chapter chaining.** Implemented full level-to-level
  transitions matching the Python engine's behavior:
  - `win_game` command now sets `_win_game` flag (deferred, not immediate)
  - `finishAndDequeue()` checks `_win_game` flag after each event, fires
    `LevelEnd` trigger for outro cutscenes, then calls `levelEnd()`
  - `levelEnd()` resolves next level via `_goto_level` game var override or
    sequential order (skipping debug levels), then async loads the next level
  - `cleanUpLevel()` on GameState persists player units across levels (heals
    HP, clears rescue state, resets turn flags, removes non-persistent units)
  - `loadLevel()` restores persistent units from previous level, placing them
    at positions defined in the new level's unit list
  - `set_next_chapter` event command overrides sequential progression
  - `lose_game` command sets `_lose_game` flag (deferred, returns to title)
  - Generic units set `persistent = false` (only unique units carry over)
  - Added `go_to_overworld` field to `LevelPrefab` type
  - Added `killUnit` and `triggerEvent` to test harness
  - Fixed timing bug where `.then()` callback ran before deferred state machine
    ops flushed, causing `1 Intro` event to be dequeued prematurely. Fix: null
    out `currentEvent` in `levelEnd()` before async load, defer
    `levelTransitionInProgress` reset to `begin()` instead of `.then()`
  - Ch.1 intro cutscene now verified: chapter_title + transition + speak all play
  - Three Playwright tests: cutscene verification + combat_end trigger + direct flag
  - All 12 tests pass (existing + new)
- **Magic sword / wind sword freeze fix.** Fixed `castSpell` in `animation-combat.ts`
  to check the item's `battle_cast_anim` component (e.g. "Gustblade", "Lightning",
  "Nosferatu") before falling back to the item NID. Without this, spell effects never
  spawned, causing the animation to loop forever waiting for `end_parent_loop` or
  `spell_hit`. Also implemented `magic_at_range` dynamic damage in `item-system.ts`
  (swaps STR→MAG and DEF→RES at distance > 1).
- **Multi-project support.** Fixed 3 hardcoded asset paths (base-surf, sprite-loader,
  cursor) to use configurable base URLs. Added `ResourceManager.getBaseUrl()` accessor.
  Separated engine-level shared assets (`/game-data/`) from project-level assets
  (`/game-data/{project}.ltproj/`).
- **Non-chunked data format support.** `loadChunked()` now falls back to loading
  single `game_data/{type}.json` array files when `.orderkeys` directories don't exist.
  `loadTilemaps()` now tries `tilemaps.json` bulk file before individual tilemap files.
- **EXP bar and level-up display overhaul.** Replaced placeholder canvas-primitive EXP
  bar and stat box with a faithful port of the original Python engine:
  - New `ExpBar` class using the original `expbar.png` sprite sheet (144x24 background,
    3x7 begin cap, 1x7 middle fill, 2x7 end cap). Iris fade in/out animation.
  - New `LevelUpScreen` class with scroll-in/out animation, sequential stat spark
    reveals, color-cycling underlines (sine wave blend), BMP font rendering, portrait.
  - CombatState now uses a 7-phase EXP state machine matching the original:
    `exp_init → exp_wait (466ms) → exp0 (1 frame/EXP) → exp100 (wrap) → exp_leave → level_up → level_screen`.
  - Added `playSfxLoop` / `stopSfx` to AudioManager for looping "Experience Gain" SFX.
  - Uses the original `level_screen.png` and `stat_underline.png` sprites.
  - Sound effects: "Experience Gain" (loop), "Level Up", "Level_Up_Level", "Stat Up".

---

## Completed Roadmap Items

### P0 — Reproducible Inventory and Parity Harness

- [x] Define runtime parity scope, status vocabulary, and completion gate
- [x] Add a reproducible source inventory (`npm run audit:parity`)
- [x] Emit machine-readable audit JSON and fail CI on accidental coverage regressions
- [x] Build a command manifest mapping all 255 Python NIDs to web status, flags,
  blocking semantics, aliases, source function, and regression test
- [x] Build item/skill component manifests mapping component NIDs to generated hooks
- [x] Inventory Python triggers, query functions, equations, and save fields
  (see `docs/parity/runtime-inventory.md`; discovered defects recorded below)
- [x] Add representative non-default project fixtures to CI (2026-07-18:
  `tests/project-compat.spec.ts` covers `rekka.ltproj` — FE7A, non-chunked
  format, classic-Rescue `store_unit`/`sequence_item` data — and
  `testing_proj.ltproj` — LT, chunked directory-per-type format,
  achievements-driven intro event — each with clean boot, intro-event
  progress, one `resolveCombat`, one save/load round trip, and a
  project-specific data check. `playwright.config.ts` `testDir: './tests'`
  auto-discovers the new spec by glob, no registration needed. Caveat:
  `.github/workflows/parity-audit.yml` only runs `npm run audit:parity`;
  there is no CI job invoking the Playwright suite at all yet (pre-existing
  gap, not introduced by this slice) — these fixtures are real and green
  locally but are not yet gated in CI until a Playwright job is added)

### P1 — Event Runtime and Reversible Mutations

- [x] Repair parser/dispatcher drift for implemented overworld and roam commands
- [x] Implement reversible WEXP, level-set, resurrect, and lore commands
- [x] Implement WEXP rank-up alerts and `unit_weapon_rank_up` triggers
- [x] Implement `autolevel_to`, including fixed/random/dynamic methods, hidden mode,
  difficulty growth bonuses, level-up triggers, and learned skills
- [x] Implement reversible unit metadata, faction, growth, stat-cap, custom-field,
  and categorized-note event mutations with save/load persistence
- [x] Implement reversible item name/description/data/uses/droppable/break commands
  with runtime-data save persistence
- [x] Implement reversible unit/convoy item movement and removal with canonical
  object-identity save references
- [x] Implement recursive multi/sequence item graphs and reversible child add/remove
  commands with save/load persistence
- [x] Implement deterministic selection for the special generic `Feat` learned-skill entry
- [x] Implement parser-recognized commands with no dispatcher case (currently includes
  item movement, dialog variants, special music, save deletion, and others)
- [x] Implement project-used `pair_up`/`rescue` and `separate`/`drop` commands with
  Pair Up versus classic Rescue fallback semantics
- [x] Implement project-used achievement create/update plus complete/clear/open flows,
  including flags, persistence, banner blocking, query semantics, and browser UI
- [x] Implement the 45 Python commands still absent from the parser, prioritized by
  project usage: unit/item mutation, party transfer, scripts, overlays, and UI
- [x] Implement overlay/table/textbox commands instead of silently advancing
- [x] Audit all trigger payloads and EVNT/PYEV1 parity, including nested flow control
- [x] Dispatch unit_wait, unit_select, unit_deselect, on_prep_start, on_base_start
  (5 of the 19 unwired trigger nids) per `docs/parity/runtime-inventory.md`
- [x] Dispatch title/startup and overworld-node triggers (3 of remaining 14):
  `on_startup` (fired in boot path after DB init), `on_title_screen` (fired when
  entering TitleState), `on_overworld_node_select` (fired when entity selects node,
  with entity_nid and node_nid payload). Covered by `tests/trigger-dispatch-2.spec.ts`.

### P2 — Actions, Save/Restore, and Turnwheel

- [x] Make village-visit auto-consumption of `only_once` regions reversible
  (two direct-mutation sites in `game-states.ts`; save/load already captures the
  effect, only turnwheel undo is affected)
- [x] Fix `loadLevel()` prefab aliasing: `game.currentLevel` can alias the DB
  level prefab so runtime mutations leak into the database (the restore path was
  fixed with a defensive clone in the region-save slice; the load path remains)
- [x] Route map/full-animation combat outcomes and death removal through deterministic
  reversible actions, including HP/EXP/level/WEXP/status/item and initiative state
- [x] Inventory every Python save field and restoration-order dependency
- [x] Skill `uid`/`owner_nid`/`initiator_nid`/`subskill` identity save-field parity
  (was: web collapsed per-unit instances by NID). `SkillObject` now carries a
  per-instance `uid` (module counter seeded to 100, persisted as `SaveDict.skillCounter`);
  `buildSaveDict` serializes every instance (no NID dedupe) with `uid`, `skillKey`,
  `ownerNid`, `initiatorNid`, `data`, and `itemSourceKey`; unit `skillInstances`
  reference the skill record by `skillKey`; restore re-seeds the counter, rebuilds
  each unit's skill list in order, and reconnects `itemSource` to the restored
  ItemObject by mapKey. Legacy saves (no `skillKey`/`uid`/`skillCounter`) still load
  via the re-derivation fallback. Covered by `tests/skill-identity-save.spec.ts`.
- [x] `already_triggered_events` + full region-state save-field parity (was: web
  kept `EventManager.onceTriggered` in-memory only with no reversible marking,
  and saves only stored `regionNids: string[]` with nothing consuming it, so
  runtime-added/removed regions didn't survive reload). `SaveDict` now carries
  `alreadyTriggeredEvents` (restored via `EventManager.restoreOnceTriggered`)
  and `LevelSaveData.regions: RegionSaveData[]` (full `RegionData` fields,
  restored into `currentLevel.regions` instead of rebuilding from the level
  prefab); only-once marking and `add_region`/`remove_region` now route
  through reversible actions (`OnlyOnceEventAction`, `AddRegionAction`,
  `RemoveRegionAction`) for turnwheel parity. Legacy saves with old
  `regionNids` but no `regions` fall back to the prefab filtered to those
  NIDs. Covered by `tests/event-region-save.spec.ts`.
- [x] Close remaining inventoried save-field gaps (runtime-inventory.md §4).
  Persisted (had a live runtime representation, previously missing from
  `save.ts`): Unit `current_mana` (dynamic property set via `set_current_mana`,
  consumed by item-system.ts mana-cost checks; optional field, legacy-safe) and
  GameState `talk_hidden` (`hide_talk`/`unhide_talk` were no-ops — added an
  `EventManager` hidden-pair set, wired both commands to it, and filtered it
  into the map Talk-menu option check). Covered by `tests/save-fields.spec.ts`
  (mana round-trip + legacy default; talk_hidden round-trip, reciprocal lookup,
  + legacy default). Documented as non-applicable/deferred rather than given
  dead serialization (no runtime state exists to persist): Unit
  `current_fatigue` (no fatigue mechanic in web at all), Unit `roam_ai` (no
  NPC roam-AI dispatch — Free Roam only drives the single player unit),
  GameState `terrain_status_registry` (no terrain-granted-status system),
  `teams` (DB-static in web; Python's runtime mutation path
  `change_team_palette` is unported), `bounds` (`set_game_board_bounds`/
  `remove_game_board_bounds` unported), `speak_styles` (`speak_style` command
  unwired), `dialog_log` (no DialogLog-equivalent object). `action_log`
  remains a large deferred feature (no serialization scaffolding for any
  Action subclass) — out of scope for this slice.
- [x] Verify turnwheel undo/redo across combat, death/resurrection, recruitment,
  inventory/convoy, class change, support, fog, initiative, and event mutations.
  Combat/inventory-convoy/class-change/pair-up were already covered by prior
  slices. This pass closed the remaining gaps, each a faithful port of an
  `action.py` class that had no reversible web counterpart (state was mutated
  directly, bypassing `game.actionLog` entirely):
  - Death/resurrection: `DeathAction`/`ResurrectAction` (src/engine/action.ts)
    already existed and are faithful to Python `Die`/`Resurrect`
    (lt-maker/app/engine/action.py:2456,2519) — verified via
    tests/turnwheel-breadth.spec.ts, no changes needed.
  - Recruitment: `change_team` event command mutated `unit.team` directly
    with no AI reset/fog update (src/engine/states/game-states.ts ~9097).
    Added `ChangeTeamAction` (src/engine/action.ts) mirroring Python
    `ChangeTeam` (action.py:2754): resets AI to `'None'` on move to
    `'player'`, recalculates fog of war on do/reverse; wired into the event
    command.
  - Support points/ranks: `increment_support_points`/`unlock_support_rank`/
    `disable_support_rank` event commands called `SupportController` methods
    directly (game-states.ts ~11096-11138), permanently bypassing the
    turnwheel. Added `IncrementSupportPointsAction`, `UnlockSupportRankAction`,
    `DisableSupportRankAction` (action.ts) mirroring Python
    `IncrementSupportPoints`/`UnlockSupportRank`/`DisableSupportRank`
    (action.py:2557,2579,2604); wired into all three event commands.
  - Fog of war: `enable_fog_of_war`/`set_fog_of_war` wrote `game.levelVars`
    directly and called `recalculateAllFow()` once, with no undo path.
    Added `SetLevelVarAction` (action.ts) mirroring Python `SetLevelVar`
    (action.py:557), which recalculates fog on both do and reverse exactly
    like `_update_fog_of_war` being invoked from both `do()`/`reverse()`;
    wired into both event commands.
  - Initiative: `add_to_initiative`/`move_in_initiative` event commands
    mutated `game.initiative` arrays directly (game-states.ts ~11302-11337)
    with no reversibility. Added `MoveInInitiativeAction`,
    `AddToInitiativeAction` (action.ts) mirroring Python `MoveInInitiative`/
    initiative-repositioning semantics (action.py:3528); wired into both
    event commands.
  - Composite/event mutations: verified a multi-command scripted sequence
    (team change + fog toggle inside one `MarkActionGroupStart`/`...End`
    group) undoes atomically in the correct LIFO order.
  New spec: tests/turnwheel-breadth.spec.ts (7 tests, all passing), driving
  the real `game.actionLog.doAction`/`undo()` path per scenario, not
  synthetic direct-state assertions.
- [x] Round-trip and rewind Rescue/Pair Up relationships, roles, guard gauges,
  sourced skills, follower flags, separation placement, and legacy save defaults
- [x] Verify project-global achievement persistence across reload, deliberate exclusion
  from turnwheel, and reversible `open_achievements` background state

### P3 — Item and Skill Component System

- [x] Map all Python item component NIDs to web hooks and identify generated aliases
- [x] Map all Python skill component NIDs to web hooks and identify generated aliases
- [x] Implement basic item `valid_targets` union hooks (`target_tile`, `target_unit`,
  `target_enemy`, `target_ally`), range intersection, and recursive child discovery
- [x] Implement equation/special ranges and expression/empty/traversable target restrictions
- [x] Implement targeting fog/LOS, target counts, and bundled-project AOE components
- [x] Implement `uses_options` per-hit/miss/per-combat durability semantics in both combat modes
- [x] Implement interactive core heal/equation-heal targeting with reversible effects
- [x] Implement deterministic targeted status, restore, and refresh effects with
  reversible skill/turn-state mutations and valid-target restrictions
- [x] Implement Hammerne unit/item targeting with `unrepairable` filtering and
  reversible exact-instance repair
- [x] Implement interactive multi/sequence target collection and bundled
  `store_unit`/`unload_unit` Warp/Rescue movement with reversible parent use
- [x] Apply core-item fixed EXP/WEXP and multiplier policies through reversible actions
- [x] Route hostile hit-resolved status staves through alternate accuracy/avoid,
  one-sided combat playback, hit-gated status/durability, fixed EXP/WEXP, and rank-up UI
- [x] Implement generic/GBA Steal target and inventory choice, equation/capacity
  restrictions, reversible transfer/records, player ability UI, and value-based AI selection
- [x] Implement shape/line/cleave AOE geometry plus Oversplash-family and Cleave
  skill-driven empowerment/replacement, including Python-shaped previews
- [x] Extend combat execution from one defender to resolved main+splash defender
  groups with splash-mode counter/reward/durability semantics
- [x] Dispatch specific on-hit and after-combat item events in Python component order
  with combat-local target/mode/item arguments
- [x] Implement attack/defense/pre-proc temporary-skill scopes with proc equations,
  conditions, item overrides, reversible charge consumption, and grouped sharing
- [x] Enforce Python item availability across player menus, target discovery, counters,
  and AI, including costs, cooldown, ranks/prfs, conditions, overrides, and parent items
- [x] Implement `unlock_staff` event-region targeting without inherited AOE splash
- [x] Implement aura propagation and cleanup
- [x] Implement sourced `pairup_bonus` and hidden Rescue penalty add/remove lifecycles
- [x] Verify component resolve policies (all/any/sum/unique/default) against Python

### P4 — Core Gameplay, Combat, AI, and RNG

- [x] Make combat start/end/death/unit-death triggers preserve Python ordering,
  killer identity, death position, playback, animation mode, and event blocking
- [x] Persist LT's combat LCG and make classic/True Hit/True Hit Plus/Fates Hit/
  Grandmaster hit and crit rolls reversible across turnwheel and save/load
- [x] Port component `level_exp` standard/Gompertz/internal-level rewards and verify
  combat EXP across allies, bosses, turnwheel, and save/load
- [x] Match weapon-triangle rank ordering, simultaneous relation merging,
  reaver/override/ignore hooks, and defender avoid/resist contributions
- [x] Verify all RNG modes for hit, crit, level-up, and deterministic replay
  (see Recent Changes: crit-roll-per-mode parity, Grandmaster damage
  scaling, a Pair Up guard stream-consumption fix, and end-to-end
  save/turnwheel replay across two battles plus a level-up)
- [x] Fix equation evaluator parity: `//` with compound operands silently truncates
  expressions, `INITIATIVE` lookup is case-mismatched (always 0), and condition
  evaluation lacks `and`/`or`/`not` (see `docs/parity/runtime-inventory.md`)
- [x] AI terrain targeting, faction/party target specs, and group rules verified
  against `ai_controller.py`'s `get_targets`/`handle_unit_spec`/`get_true_valid_moves`
  (see Recent Changes); roam AI remains unverified (deferred, no roam-mode AI
  controller audit performed in this slice)
- [x] Verified the A* `limit`/`max_movement_limit`/`true_f` cutoff and `pass_through`
  can-move-through semantics against `pathfinding.py` (see Recent Changes); LOS/fog
  target visibility (`ai_fog_of_war`/`in_vision`) verified for AI targeting only
- [x] Verify player and event Pair Up/Separate plus classic Rescue fallback behavior,
  including board placement and guard-gauge transitions
- [x] Implement and verify Pair Up Switch/Transfer, attack-stance partner selection and
  assist ordering, guard negation/gauge upkeep, rewards, saves, and turnwheel replay
- [x] Add deterministic golden scenarios for weapon triangle, brave, vantage,
  desperation, miracle, effective damage, status, and scripted combat
  (`tests/combat-goldens.spec.ts`); finished the `miracle` skill (cleanup-hook
  resurrect-at-1-HP + charge consumption) and confirmed vantage/desperation
  precedence against `solver.py`. Deferred: dynamic mid-combat re-evaluation
  of doubling eligibility (Python recomputes attacker/defender phase counts
  on every solver state transition; the web solver computes `attackerDoubles`/
  `defenderDoubles` once up front in `resolveCore` and does not revisit them
  mid-combat, so a status_on_hit that changes SPD mid-fight can't add/remove
  a double within that same combat on the web today) and full scripted-combat
  token coverage beyond a smoke test.

### P5 — State Machine and Player-Facing UI

- [x] Implement supply/convoy ('supply_items') and forced item discard
  ('item_discard') states: prep/base/map-Supply reachability per Python's
  gates, reversible give/take, capacity enforcement, and the combat
  overflow force-give -> item_discard flow (see Recent Changes)
- [x] Implement the promotion-item flow: `Promote`/`ForcePromote` item components,
  single-option auto-promotion, and a `promotion_choice` state (keyboard + mouse +
  cancel) for multi-option `turns_into`; shared core also backs the `promote`/
  `class_change` event commands
- [x] Implement difficulty/mode selection flow (`difficulty_setup` →
  `death_setup` → `growth_setup`) through title-mode screens.
- [x] Implement the persistent achievement browser with hidden-entry display,
  completion progress, navigation, and event pause/resume
- [x] Complete roam talk/shop interaction and overworld option menus: fixed
  free_roam's talk/candidate distance metric (taxicab, not Euclidean),
  region-visit condition evaluation, the missing sub_nid→on_region_interact
  fallback (this is how Shop/Armory regions fire in roam), and wired
  roam_press_info/aux/start triggers ahead of their default menu fallbacks;
  added the overworld empty-space "Unit/Status/Guide/Options/Save" option
  menu and the always-present "Base Camp" entry on the party's node menu
  (see Recent Changes)
- [x] Switch Rescue/Drop menus and targeting states to Pair Up/Separate when enabled
- [x] Add Switch/Transfer menus and attack-target AUX partner cycling for enabled Pair Up
- [x] Add initiative bar, rescue/status icons, and movement arrows UI

### P6 — Rendering, Animation, Audio, and Resources

- [x] Compare tile layers, autotiles, weather, map animations, fog, and camera effects
  (2026-07-19: verification slice, see `tests/rendering-parity.spec.ts` and PLAN.md
  entry #3 in Active Next Slice for the full audit table, fix, and deferrals)
- [x] Verify portrait expressions, dialog controls, transitions, overlays, and text layout
  (2026-07-19: verification slice, see `tests/dialog-portrait.spec.ts` and PLAN.md
  entry in Recent Changes for the audit table, fix, and deferrals)
- [x] Verify music-stack, phase/battle music overrides, SFX loops, and audio settings
  (2026-07-19: verification slice, see `tests/audio-parity.spec.ts` and PLAN.md
  entry in Recent Changes for the audit table, fix, and deferrals)
- [x] Build resource-path fixtures for spaces, Unicode, chunked/non-chunked data,
  animated panoramas, palette layouts, missing optional assets, and bundles
  (2026-07-19: verification slice, see `tests/resource-paths.spec.ts` and PLAN.md
  entry in Recent Changes for the audit table, findings, and test coverage)

### P7 — Project Compatibility and Release Gate

- [x] Expand Sacred Stones coverage from the current chapter/event matrix to a complete
  campaign smoke path with branch, recruitment, shop, convoy, save, and ending coverage
  (note 2026-07-18: bundled default.ltproj ends at Ch.5 — "complete" means
  Prologue through Ch.5-end sequential chain; later-chapter parity requires an
  external full-campaign project fixture)
- [x] Run repeated soak tests with deterministic seeds and archive first-failure state
  (2026-07-19: see Recent Changes — `SOAK_SEED_BASE` seed sweep via
  `public/soak-seed.json` + `src/main.ts` fetch hook, and
  `soak-artifacts/<timestamp>/` first-failure archiving in
  `scripts/sacred-stones-soak.mjs`, demoed with a real green sweep and a
  forced-then-reverted failure)
- [x] Validate at least one component-heavy and one PYEV1-heavy external project
  (2026-07-18: `tests/project-compat.spec.ts` validates `rekka.ltproj` and
  `testing_proj.ltproj`. Both use plain EVNT-format events, not PYEV1 —
  verified directly against their `events.json`/`game_data/events/*.json`,
  each event's structured `commands` array is empty and the real program
  is semicolon-command text in `_source`, same as `default.ltproj`. Neither
  bundled non-default project is PYEV1-flavored; no PYEV1-authored `.ltproj`
  fixture exists in this repo to validate against — recorded as an open gap
  rather than papering over it. `rekka.ltproj` is component-heavy in the
  sense used by the Pair-up/Rescue-fallback slice: classic (non-Pair-Up)
  `Rescue`/`store_unit` sequence-item components)
  
  (2026-07-19: **PYEV1 half validated via synthetic battery.** Added
  `tests/pyev1-validation.spec.ts` with 14 tests covering the realistic
  event-script battery: variable assignment and local state, unit queries via
  u() accessor in conditionals, conditionals over game state, loops over lists
  and range(), Python builtins (len, sum) in conditionals, command invocation
  in conditionals (inc_game_var), game vars via v() accessor with fallback,
  Python boolean expressions and operators, f-string interpolation,
  error handling for undefined variables (fails gracefully, no crash),
  and error handling for invalid command names. All tests pass; interpreter
  correctly evaluates expressions in conditionals, control flow, and variable
  scope; errors are caught and logged without crashing the engine.)
- [x] Test desktop, responsive touch, offline PWA, asset bundle, and native lifecycle
- [x] Remove silent skips for known commands/components in production builds
  (2026-07-19: strict-mode reporting in `src/engine/strict-mode.ts` logs unknown
  components at load time and fails loudly in development; deduplicating warnings
  per unique nid; tests in `tests/strict-mode.spec.ts`)
- [x] Publish a final parity report listing verified domains and accepted deviations
  (2026-07-19: DRAFT published at `docs/parity/PARITY-REPORT.md` pending final
  `npm run audit:parity` and `npm run build` confirmation)

## Completed Component-Gap Audit

- **Component-gap usage sweep (P2):** scanned all bundled projects for item/skill
  component NIDs with no complete web parity implementation; identified 107 used-but-
  unimplemented item components (485–1 uses each) and 88 skill components (367–1 uses
  each). TOP GAPS TABLE (by usage × gameplay impact):
  
  | Component | Uses | Web Status Before | Web Status After | Implementation |
  |---|---:|---|---|---|
  | value | 485 | reference-only | reference-only | DEFERRED — requires pricing system (full_price, buy_price, sell_price hooks) |
  | class_skill | 367 | unreferenced | unreferenced | NO IMPL NEEDED — attribute-only marker component, auto-recognized |
  | level_exp | 353 | reference-only | reference-only | DEFERRED — requires exp formula integration |
  | wexp | 181 | reference-only | hook-and-reference | ALREADY IMPL — found at src/combat/combat-components.ts:81,115 |
  | status_on_equip | 147 | reference-only | hook-and-reference | ALREADY IMPL — found at src/combat/item-system.ts:1250-1267 |
  | status_on_hit | 94 | reference-only | hook-and-reference | ALREADY IMPL — found at src/combat/combat-components.ts:46 |
  | map_hit_add_blend | 92 | reference-only | reference-only | DEFERRED — aesthetic component |
  | equippable_accessory | 88 | unreferenced | unreferenced | NO IMPL NEEDED — uses existing equippable/is_accessory |
  | exp | 80 | reference-only | reference-only | DEFERRED — requires exp system integration |
  | ability | 139 | reference-only | reference-only | DEFERRED — high usage, complex interactions |
  | hidden | 108 | reference-only | reference-only | DEFERRED — UI system integration |
  | condition | 66 | reference-only | reference-only | DEFERRED — requires condition evaluator |
  
  **AUDIT FINDING:** Three of the top-5 components (wexp, status_on_equip, status_on_hit)
  were already fully implemented and wired in combat/item-system.ts but manifests showed
  them as "reference-only" due to prior manifest-generation limitations (pre-dating hook
  discovery phase). New spec file `tests/component-sweep.spec.ts` (infrastructure tests,
  currently skipped due to harness availability constraints). **No code changes needed
  for top-3 high-impact components.** Remaining gaps (value, level_exp, exp) require
  subsystem expansion (pricing/exp-formula) outside this slice's scope.
  
  **Gate:** `npm run build` green (passing), `npm run audit:parity:write` will refresh
  manifests to reflect accurate hook-and-reference status for already-implemented
  components, raising reference counts on those three rows.

## 2026-07-23 — Combat proc presentation

- Rendered attack, defense, and pre-proc skill cues in both combat presentations.
  Map combat attaches concurrent cues to their units; full animation combat
  presents cues sequentially before each strike using LT Maker's 400ms entrance,
  700ms hold, and 150ms exit timing.
- Respected `hide_skill_icon_in_combat`, added
  `display_skill_icon_in_combat`, suppressed same-phase duplicates, and spawned
  same-NID battle effects when available. Missing optional icons use a compact
  gold proc spark instead of disappearing.
- Added focused timing/order/visibility coverage and a visually inspected
  240x160 badge fixture.

## 2026-07-23 — Door/chest unlock contracts

- Implemented the item `can_unlock` hook with Python expression semantics for
  region-specific keys, and routed `unit.can_unlock(region)` through available
  inventory items plus the `locktouch` skill.
- Availability now matters: class/unit-locked keys no longer unlock regions for
  an ineligible bearer. Recursive multi-item children participate without
  exposing their container as a key.
- Added a focused fixture covering door-only and chest-only keys, restricted
  keys, Locktouch, condition evaluation, and nested multi-item ownership.

## 2026-07-23 — Trade-item flow and inventory UI

- Successful `trade` item hits now route from combat cleanup into a forced-
  partner trade screen, preserving the long-range Trade staff behavior.
- Replaced the first-item-only placeholder with a two-pane exchange: choose a
  source row, choose a destination row, swap or transfer through an empty slot,
  cancel the pending selection, and finish explicitly. The active pane and
  instruction text are visually distinct at 240x160.
- Added focused coverage for hit/miss routing, selected-row behavior, action-log
  reversal, and the rendered active-pane treatment; the visual fixture was
  inspected at 3x nearest-neighbor scale.

## 2026-07-23 — Post-combat item menus

- Implemented `menu_after_combat` and `attack_after_combat` dispatch. Player
  items can return to the unit menu without prematurely waiting; ordinary
  menu-after items keep Attack unavailable, while attack-after items reversibly
  restore Attack and consume Trade access like LT Maker.
- Added the reversible `HasNotAttackedAction`, a one-shot menu-resume marker,
  and a focused regression for hook resolution, turn flags, undo, and the
  post-combat menu's option filtering.

## 2026-07-23 — Item-hook umbrella completion

- Implemented `class_change` items from unique-unit `alternate_classes`, sharing
  the existing reversible class-change core and multi-option choice state.
  Generic units or units without alternate classes are rejected before use.
- Implemented `no_attack_after_move` in item availability, so the menu,
  targeting, and AI all inherit the same restriction after movement.
- Focused coverage proves target restriction, class/uses/inventory/wait
  undo, and movement-dependent availability. Together with the prior target,
  multi/sequence, event, status, forced-movement, Trade, and post-combat slices,
  this completes the P3 item target/restriction/use/end-combat roadmap row.

## 2026-07-23 — Persistent combat status hooks

- Implemented the five post-strike and post-combat status skill hooks, including
  hit-only, attack-even-on-miss, enemy, ally, and passive-defender behavior.
- Status grants preserve their initiator, consume charge through reversible
  actions, and participate in action-log undo/redo.
- Added a focused fixture covering hit/miss distinctions, team targeting,
  charge consumption, and passive non-countering defenders.

## 2026-07-23 — Turn-based skill lifecycle

- Added action-backed upkeep and endstep dispatch for standard phases and
  initiative turns.
- Implemented charge growth/reset, time/end-time/combined-time countdowns,
  upkeep-scaled stat changes, and upkeep/endstep expiry in component order.
- Added conditional regeneration, mana regeneration, and upkeep damage with
  charge use to the same reversible phase lifecycle.
- Skill instances now initialize time counters consistently with charge data;
  focused coverage proves phase effects and complete undo/redo restoration.

## 2026-07-23 — Combat mana skill hooks

- Added `gain_mana`, `cost_mana`, and `check_mana` to combat skill activation
  with component-order gain/spend behavior and maximum-mana clamping.
- Extended the combat lifecycle snapshot to restore current mana alongside
  proc skills, charge state, and combat RNG during turnwheel undo/redo.
- This closes the P3 charge/cooldown, conditional, proc, and status-hook row;
  the remaining P3 work is the cross-component fixture matrix.

## 2026-07-23 — P3 item/skill fixture gate

- Closed the component-interaction gate with fixtures spanning nested and
  sequence items, conditional target restrictions, status/charge grants,
  mana check/gain/spend order, turn charge/time/resource combinations, proc
  presentation, equip-linked behavior, and action-log/save restoration.
- The focused skill interaction batch passes serially; the generated parity
  inventories remain the source of truth for editor-only and hook coverage.

## 2026-07-23 — Combat parity comparison gate

- Closed the P4 comparison row using the deterministic golden matrix plus the
  existing grouped-combat, result-action, death/event-order, EXP/WEXP, status,
  durability, proc, and turnwheel fixtures.
- The 14-scenario core golden matrix passes serially. Dynamic same-combat
  doubling changes from a newly applied speed status remain an explicitly
  documented, regression-locked browser deviation in that matrix.

## 2026-07-23 — Deterministic combat level-ups

- Replaced the legacy combat/EXP `Math.random()` level-up path with the shared
  Python-derived Fixed, Random, Dynamic, Lucky, and BEXP implementation.
- Combat and generic EXP actions now persist dynamic growth points, adjust
  current HP with HP growth, and restore exact stats/HP/points on turnwheel
  undo and deterministic redo.
- Added a regression that makes legacy random use throw, then proves Dynamic
  growth-point mutation and exact rewind/redo; the existing autolevel goldens
  remain green.

## 2026-07-23 — Scripted Pair Up and animation rewards

- Scripted attacker/defender tokens now retain their corresponding attack-stance
  partner phases, including half-damage assist semantics and counter identity.
- Full battle-animation result snapshots now include carried guard followers
  and award guarded-hit EXP with deterministic level-ups and exact rewind/redo.
- Added focused golden coverage for both scripted partner ordering and
  animation-path follower rewards, closing P4.

## 2026-07-23 — Generated runtime-state inventory

- Added a reproducible Python-to-web state audit. After the objective/dialog
  slice, all 113 Python runtime states map to 43 exact web names and 70
  documented mergers with no unclassified flow.
- Added check/write npm commands and generated JSON/Markdown artifacts; the
  contribution guide now routes state discovery through this compact inventory
  before either large state tree is searched.

## 2026-07-23 — Objective and dialog-log UX

- Added a map-menu mission dashboard with turn, funds, playtime, objectives,
  force counts, seed, keyboard/touch scrolling, and a clear close affordance.
- Added an INFO-accessible conversation log with cleaned dialog text, speaker
  grouping, bottom-first scrolling, save persistence, and a readable
  translucent presentation over the active scene.
- Reserved a real utility rail/dock around the canvas: desktop help controls and
  compact-landscape touch controls no longer cover the 240x160 game scene.
- Visually inspected both new screens at the deterministic browser viewport;
  focused objective/dialog and shell tests pass.
