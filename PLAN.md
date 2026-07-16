# lt-web: Lex Talionis Runtime Parity Plan

This is the source of truth for bringing the TypeScript web runtime to behavioral
parity with the checked-in Python Lex Talionis engine under `lt-maker/`. It records
evidence, gaps, ordering, and completion gates. A feature is not considered at
parity merely because a similarly named class, command, or UI exists.

## Parity Contract

### In scope

- Runtime loading and execution of supported `.ltproj` projects
- Database/resource formats, runtime objects, actions, saves, and turnwheel
- State-machine flows, events (EVNT and PYEV1), queries, and triggers
- Item and skill component behavior used by runtime projects
- Movement, pathfinding, combat, AI, supports, fog, initiative, roam, and overworld
- Player-facing rendering, animation, audio, menus, settings, and input
- Browser-specific distribution features, provided they do not change game behavior

### Out of scope

- The Qt project editor and its editor-only validation/authoring UI
- Python packaging, launcher, and desktop-only developer tooling
- Pixel-identical behavior where browser platform constraints make it impossible;
  any accepted deviation must be documented and covered by a behavioral test

### Status vocabulary

- **Verified**: compared with the Python source and covered by an automated parity test
- **Implemented**: code path exists but has not passed the full parity gate
- **Partial**: important behavior, variants, hooks, or UI are missing
- **Missing**: reference behavior has no functional web implementation
- **Unknown**: not yet inventoried deeply enough to classify

### Completion gate

Runtime parity is complete only when all in-scope inventory rows are classified,
all Missing/Partial rows are resolved or explicitly accepted as deviations, the
default Sacred Stones project passes chapter/event soak tests, at least one
non-default representative `.ltproj` passes the compatibility suite, save/restore
and turnwheel reversibility tests pass, and `npm run build`, `npm run audit:parity`,
and the full Playwright suite are green.

## Evidence Baseline (2026-07-16)

Run `npm run audit:parity` to regenerate the source inventory. Current baseline:

| Domain | Python reference | Web inventory | Current classification |
|---|---:|---:|---|
| Event command NIDs | 255 | 204 recognized; 194 matching case labels | Partial |
| Item component NIDs | 201 | 86 exact string references; 74 with matching hook surfaces | Partial/Unknown |
| Skill component NIDs | 241 | 42 exact string references; 64 with matching hook surfaces | Partial/Unknown |
| Registered runtime states | broad Python state catalog | 41 web states | Partial |
| TypeScript runtime | n/a | 92 files, 50,675 lines | Builds |
| Browser regression suite | n/a | 79 Playwright tests | 79/79 passing |

Counts are inventories, not equivalence percentages: one generated hook can cover
many components, while one switch case can still omit flags or blocking behavior.

## Current State

The engine is playable through the current Sacred Stones coverage and has strong
foundations: Canvas rendering, a stack state machine, combat/AI/movement, EVNT and
PYEV1 interpreters, save/load, turnwheel, supports, fog, initiative, overworld,
roam, PWA/native wrappers, and a deterministic Playwright harness. It is **not yet
feature-complete relative to the Python runtime**. The roadmap below replaces the
older broad “phase complete” assessment.

### Multi-Project Support

The engine supports loading different `.ltproj` projects via the `?project=`
query parameter. Both **chunked** (directory-per-type with `.orderkeys`) and
**non-chunked** (single JSON array files) data formats are supported.

**Completed:**
- [x] Configurable project path via `?project=` query param
- [x] Non-chunked game_data fallback (items.json, skills.json, etc.)
- [x] Non-chunked tilemap fallback (single tilemaps.json)
- [x] Engine-level shared assets separated from project assets (sprites/menus, platforms, cursor)
- [x] Combat palette loading: added `palette_data/` subdirectory fallback path
- [x] URL encoding: `ResourceManager.resolveUrl()` now encodes path segments for spaces/special chars
- [x] Title screen: animated panorama fallback (tries `title_background0.png` when single file missing)
- [x] Icons, fonts, base-surf, sprite-loader all encode NIDs in URLs

**Known Limitations (per-project content):**
- Missing `combat_*.png` panoramas in non-default projects (combat backgrounds show nothing)
- Projects may reference combat effects/palettes not present — renders without them gracefully

---

### Known Bugs

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

### Recent Changes

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

## Execution Roadmap

Work proceeds in this order because later systems depend on earlier dispatch,
mutation, and lifecycle correctness. Check an item only after its verification gate
passes; record newly discovered work here immediately.

### P0 — Reproducible Inventory and Parity Harness

- [x] Define runtime parity scope, status vocabulary, and completion gate
- [x] Add a reproducible source inventory (`npm run audit:parity`)
- [x] Emit machine-readable audit JSON and fail CI on accidental coverage regressions
- [x] Build a command manifest mapping all 255 Python NIDs to web status, flags,
  blocking semantics, aliases, source function, and regression test
- [x] Build item/skill component manifests mapping component NIDs to generated hooks
- [ ] Inventory Python triggers, query functions, equations, and save fields
- [ ] Add representative non-default project fixtures to CI

**Gate:** every in-scope reference surface has an owner, status, and test target.

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
- [ ] Implement parser-recognized commands with no dispatcher case (currently includes
  item movement, dialog variants, special music, save deletion, and others)
- [ ] Implement the 51 Python commands still absent from the parser, prioritized by
  project usage: unit/item mutation, party transfer/pair-up, scripts, overlays, and UI
- [ ] Implement overlay/table/textbox commands instead of silently advancing
- [ ] Match blocking/no-block, no-banner, immediate, and skip flags per command
- [ ] Audit all trigger payloads and EVNT/PYEV1 parity, including nested flow control

**Gate:** all Python event NIDs are recognized, intentionally dispatched, and covered
by parser plus behavioral tests; unsupported commands fail loudly in development.

### P2 — Actions, Save/Restore, and Turnwheel

- [ ] Route all event and gameplay mutations through reversible actions
- [ ] Inventory every Python save field and restoration-order dependency
- [ ] Add round-trip tests for units, items, skills, lore, parties, supports, fog,
  initiative, roam, overworld, records, achievements, and in-progress events
- [ ] Verify suspend deletion, battle saves, restart saves, and migration defaults
- [ ] Verify turnwheel undo/redo across combat, death/resurrection, recruitment,
  inventory/convoy, class change, support, fog, initiative, and event mutations

**Gate:** save round trips are lossless for in-scope state and every logged mutation
returns to byte-equivalent state after reverse/redo where the Python action does.

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
- [ ] Implement item target/restriction/use/end-combat hooks and multi/sub-item behavior
- [ ] Implement aura propagation and cleanup
- [ ] Implement charge/cooldown, conditional activation, proc, pair-up, and status hooks
- [ ] Verify component resolve policies (all/any/sum/unique/default) against Python
- [ ] Add fixture-driven component tests, including interactions between components

**Gate:** every runtime component is verified or documented as editor-only; combat and
item-use fixture matrices match Python outputs and side effects.

### P4 — Core Gameplay, Combat, AI, and RNG

- [ ] Compare combat strike ordering, playback, EXP/WEXP, death, and post-combat events
- [ ] Verify all RNG modes for hit, crit, level-up, and deterministic replay
- [ ] Finish dynamic/fixed level-up algorithms and growth-point persistence
- [ ] Complete AI terrain targeting, faction/party target specs, roam AI, and group rules
- [ ] Verify pathfinding, movement costs, LOS/fog, rescue/pair-up, canto, and initiative
- [ ] Add deterministic golden scenarios for weapon triangle, brave, vantage,
  desperation, miracle, effective damage, status, and scripted combat

**Gate:** deterministic scenario outputs and action/playback order match Python.

### P5 — State Machine and Player-Facing UI

- [ ] Inventory Python state names and map them to web states or documented mergers
- [ ] Implement supply/convoy, repair shop, trade variants, item discard/targeting,
  promotion/class choice, formation, text entry, and objective/dialog-log flows
- [ ] Implement difficulty/mode selection and complete title Extras flows
- [ ] Complete base submenus: supports, codex/library/guide, BEXP, records,
  achievements, sound room, and unit management
- [ ] Complete roam talk/shop interaction and overworld option menus
- [ ] Add initiative bar, rescue/status icons, movement arrows, growth/support/WEXP info
- [ ] Remove remaining placeholder portraits/sprites where resources exist

**Gate:** every in-scope Python state has an equivalent reachable flow with keyboard,
mouse, touch, cancel/back, transition, and resume tests.

### P6 — Rendering, Animation, Audio, and Resources

- [ ] Compare tile layers, autotiles, weather, map animations, fog, and camera effects
- [ ] Complete combat-animation fallback behavior without debug placeholder art
- [ ] Verify portrait expressions, dialog controls, transitions, overlays, and text layout
- [ ] Verify music-stack, phase/battle music overrides, SFX loops, and audio settings
- [ ] Build resource-path fixtures for spaces, Unicode, chunked/non-chunked data,
  animated panoramas, palette layouts, missing optional assets, and bundles
- [ ] Add screenshot/golden tolerances for representative maps and combat scenes

**Gate:** required assets load across fixture projects and visual/audio state transitions
match the reference within documented browser tolerances.

### P7 — Project Compatibility and Release Gate

- [ ] Expand Sacred Stones coverage from the current chapter/event matrix to a complete
  campaign smoke path with branch, recruitment, shop, convoy, save, and ending coverage
- [ ] Run repeated soak tests with deterministic seeds and archive first-failure state
- [ ] Validate at least one component-heavy and one PYEV1-heavy external project
- [ ] Test desktop, responsive touch, offline PWA, asset bundle, and native lifecycle
- [ ] Remove silent skips for known commands/components in production builds
- [ ] Publish a final parity report listing verified domains and accepted deviations

**Gate:** all completion-gate commands pass, compatibility fixtures are green, and no
unclassified runtime gaps remain.

## Active Next Slice

1. Continue combat component lifecycle parity with event-on-hit, item/skill proc,
   and fully reversible HP/EXP/death result actions.
2. Port the next high-usage unresolved item target/use/end-combat hook cluster from
   the generated component manifest and add interaction fixtures.
3. Implement the next project-used parser-recognized event commands that still lack
   dispatcher cases, with reversible mutations and blocking/flag coverage.
