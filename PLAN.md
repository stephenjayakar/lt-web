# Rekka no Ken Alternative — Web Compatibility Plan

This plan tracks the work required for `lt-maker/rekka.ltproj` to play from the
title screen through the ending in the web runtime with the same authored
behavior as the Python engine. It replaces the generic parity backlog with a
project-driven release plan. A component name being parsed, or a chapter merely
loading, does not count as support.

## Release definition

Rekka is web-compatible when:

- every playable chapter and route can be completed without console errors,
  softlocks, skipped required events, or manual save edits;
- event conditions, substitutions, loops, commands, and trigger locals produce
  Python-equivalent results;
- every item and skill component actually used by the project behaves correctly,
  including its UI, AI, animation, action reversal, and save/restore effects;
- title, prep/base, map, combat, shops, supports, chapter transitions, credits,
  audio, keyboard/gamepad, and touch controls are usable at browser scale;
- representative saves load at chapter start, mid-turn, mid-map, and after
  chapter transition, and turnwheel undo/redo remains deterministic;
- the Rekka compatibility suite, build, parity audit, full serial test suite,
  and visual/audio release checks are green.

## Audited baseline

- Project: `Rekka no Ken Alternative` (`game_nid: FE7A`)
- Size: about 219 MB and 1,733 files
- Content: 48 levels (0–46 plus DEBUG), 899 events, 462 items, 586 skills,
  118 units, and 84 classes
- Component surface: 105 distinct item component NIDs and 130 distinct skill
  component NIDs
- Custom runtime code: 473 lines of item components and 313 lines of skill
  components under `resources/custom_components/`
- Custom title assets: `resources/custom_sprites/logo.png` and
  `resources/custom_sprites/press_start.png`
- Existing automated coverage is only a Prologue clean boot/intro, one Lyn
  combat, one save/load, and Rescue sequence shape. It is not campaign coverage.
- All Python event command NIDs are recognized structurally, but recognition
  does not prove command semantics, expression evaluation, UI, or resume order.

## P0 — Make failures observable

- [x] Add a Rekka audit that inventories project-used commands, components,
  expression helpers, custom components, referenced resources, and counts.
  Generate the report; do not hand-maintain counts in this file.
- [x] Add a clean-boot smoke for all 48 levels and record load errors, missing
  resources, unknown components, and unexpected terminal states.
- [x] Add a bounded `level_start` settle test for all playable levels. Fail on
  unknown commands, expression errors, event queue stalls, or silent condition
  fallback.
- [ ] Make unsupported project-used expressions and components fail loudly in
  development/test mode instead of quietly returning false or doing nothing.
- [ ] Add focused trace output for event ID, command index, trigger locals, state
  stack, and active unit so a campaign failure is reproducible.

Gate: all Rekka gaps produce actionable failures, and no required behavior is
silently skipped.

## P1 — Event and expression compatibility

This is the main campaign blocker. Rekka uses Python expressions throughout
conditions, substitutions, loops, shops, abilities, and combat events.

- [x] Implement project-used unit APIs: `get_hp`, `get_max_hp`, `get_stat`,
  accessories, previous position, flanking checks, and safe unit lookup.
- [x] Implement project-used game APIs and aliases: `_current_level.nid`,
  `game_vars` indexing/`get`, money, board bounds, terrain lookup, deterministic
  random choice, and current party/level access.
- [x] Implement expression namespaces used by Rekka:
  `item_funcs`, `item_system`, `skill_system`, `target_system`,
  `combat_calcs`, and `movement_funcs`.
- [x] Support the project-used Python expression forms: list/generator
  comprehensions, `any`/`all`, tuples and membership, indexing, modulo,
  floor division, exponentiation, string conversion/join, and nested
  `{e:...}`/`{eval:...}` substitutions.
- [x] Preserve deterministic RNG consumption for `get_random`,
  `get_random_choice`, combat previews, retries, saves, and turnwheel replay.
- [ ] Validate all 161 distinct `if`/`elif` expressions, all 80 distinct eval
  substitutions, and all 34 event loops against expected Python results.
- [ ] Add scenarios for global shop selection, dynamic generic units,
  conditional recruitment, victory/route branches, and random-skill events.
- [ ] Verify trigger-local payloads such as `unit`, `unit2`, `item`, `item2`,
  `mode`, `stat_changes`, `created_unit`, and loop variables.

Gate: every distinct Rekka expression parses and has a focused value/side-effect
test; every chapter intro settles without expression fallback.

## P2 — Port project-local components

The browser cannot execute Rekka's Python custom components. Port the used
behavior to typed TypeScript hooks and register it explicitly; do not add an
unsafe Python/eval bridge.

### Custom item components

- [x] `advance` and `advance_target_restrict` (forced movement and target
  validation)
- [x] `gold_cost` (availability, payment, refund, undo/redo)
- [x] `trace` (item targeting, one-use copy, ownership, AI, save identity)
- [ ] Audit and port any reachable `cleave_2_range_aoe`, `phasewalk`, `charge`,
  or `bullrush` content even if current static usage is zero.

### Custom skill components

- [x] Movement/reset hooks: `powerstaff`, `combat_artist`, `second_wind`, and
  14 uses of `eval_galeforce`
- [x] Combat modifiers: `givebacker` and `disvantage`
- [x] Combat survival: `nine_lives_event`, `true_miracle_event`, and
  `true_miracle_event_after_combat`
- [x] Event hooks: 13 `event_after_combat`, 10 `event_before_combat`,
  20 `event_on_upkeep`, 17 `event_after_hit`, 4 `event_after_strike`,
  3 `event_after_crit`, plus hit/dodge/strike variants
- [x] Availability restrictions, including four
  `cannot_use_items_except_armor` uses
- [ ] Preserve exact hook ordering, playback markers, event payloads, charge
  triggering, action reversal, and save/restore state.

Gate: every custom component referenced by project data has a golden test against
the Python implementation, including AI and turnwheel behavior where applicable.

## P3 — Core Rekka item and skill systems

### Player-facing mechanics

- [x] Implement 42 `combat_art` skills: command/menu flow, allowed-weapon
  filtering, child skill activation, cost/stack checks, targeting,
  cancellation, cleanup, proc presentation, and turnwheel behavior.
- [ ] Complete combat-art AI selection and the child-component gaps tracked
  below; inactive/grey presentation is tracked separately.
- [x] Implement 26 `multi_skill` wrappers with correct child ownership,
  duplicate/stack handling, removal, save IDs, and UI grouping.
- [x] Implement 88 `equippable_accessory` items. Treat rings as the project's
  one accessory slot, not ordinary inventory: capacity, equip/unequip,
  `status_on_equip`, convoy/trade, auto-equip, UI, AI, save, and turnwheel.
- [x] Implement inactive skill presentation for 16 `hidden_if_inactive` and
  10 `grey_if_inactive` uses.
- [x] Implement gameplay semantics for all five `transform` stones: equipped
  stat changes, target/range behavior, status hooks, reversion, save identity,
  and turnwheel. Rekka's five stones have no finite-use component, so there is
  no project-content breakage transition.
- [x] Add Python-parity Transform/Dragonstone/Revert battle-animation swaps for
  transform stones, including dead-unit and skip handling; missing required
  clips fall back to map combat instead of silently substituting an ordinary
  weapon animation.
- [x] Implement all 11 `usable_in_base` items in the base management UI,
  including cap-aware stat boosters, normal/`c_uses` consumption, Master Seal
  level/class restrictions, Heaven Seal promotion, save-safe identity, and
  turnwheel reversal.

### Combat and lifecycle mechanics

- [x] End-of-combat/chapter cleanup for all 17 `lost_on_end_combat2` and
  45 `lost_on_end_chapter` uses, including relationship/initiator options,
  event-on-remove ordering, multi-skill ownership, and turnwheel reversal.
- [x] Unit control/status: condition-aware `unselectable`, `immune_status`,
  `reflect_status`, `ignore_damage`, `TrueMiracle`, and `death_tether`, with
  proc presentation, charge handling, source identity, and undo/redo.
- [x] Pre/post combat: all six `skill_before_combat` grants,
  `post_combat_splash`/`post_combat_splash_aoe`, `live_to_serve`, and all
  project-used kill/attack/combat/miss/damage skill-grant hooks, including
  immediate later-strike visibility, charge use, and turnwheel restoration.
- [x] Combat math: `armsthrift`, `dynamic_crit_accuracy`,
  `alternate_critical_multiplier_formula`, and maximum-range modification.
- [x] Turn/map lifecycle: `endstep_damage`, upkeep events, `galeforce`, and
  movement-type overrides.
- [x] Targeting/AI/economy: five `witch_warp_expression` uses,
  `ignore_alliances`, additional accessory capacity, buy-price changes, and
  AI-priority modifiers.
- [x] Confirm attack/pre-attack proc ordering in the real Rekka combat-art and
  custom-event cases; existing generic proc coverage is not sufficient.

Gate: each project-used component is classified Verified or Deliberate
Deviation, with no Missing/Partial rows in the Rekka-generated inventory.

## P4 — Commands, states, and complete campaign flow

- [x] Replace the `table`/`remove_table` no-op with the event UI required by the
  Bribe ability and GoldDisplay.
- [x] Validate high-volume command semantics and blocking order:
  - [x] Unit add/move, including relative destinations, placement policy,
    stacked swaps, warp ordering, and turnwheel replay.
  - [x] Cursor/camera and layer visibility, including duration-backed pans,
    terrain refresh, and turnwheel replay.
  - [x] Stats, attack flags, item/skill changes, and AI changes, including
    stack limits/removal counts, persistent grants, and object-valued loops.
  - [x] Map animations, shops, prep, and unit groups, including permanent
    overlays and Chapter 28's staged Rath reinforcement movement.
- [x] Validate `make_generic`, `add_group`, `spawn_group`, `change_tilemap`,
  `add_skill_component`, `set_custom_options`, and all three `pair_up` script
  uses in their actual chapter contexts.
- [ ] Verify menu/state flows in their campaign contexts:
  - [x] Base/prep entry and return, unit management/convoy access, formation,
    options, and enabled save routes.
  - [ ] Trading, shops and armory/vendor stock, support, promotion, and records.
- [ ] Verify every recruitment, talk, visit, chest/door, reinforcement, boss,
  escape/seize/defeat/survive objective, route split, and chapter transition.
- [ ] Add campaign checkpoints covering early, midgame, late, final map, ending,
  and credits rather than attempting only one huge brittle end-to-end test.
- [ ] Exercise all 899 events through direct entrypoint tests or reachable
  campaign scenarios, including chaining, blocking/resume, and only-once rules.

Gate: a deterministic automated campaign route reaches the ending, with focused
alternate-route/optional-content scenarios and no event/state softlocks.

## P5 — Browser presentation and UX

- [ ] Load and render Rekka's custom `logo.png` and `press_start.png` on the
  title screen with its configured title music and an audio-unlock-safe start.
- [ ] Audit every referenced panorama, portrait, map sprite, tileset, icon,
  animation, combat animation/effect, music track, and SFX; distinguish optional
  fallback from required-resource failure.
- [ ] Visually verify title, save select, prep/base, representative maps,
  combat forecast, map combat, full battle animation, combat arts, accessories,
  shops, dialogue, chapter transition, ending, and credits.
- [ ] Ensure menus remain legible and stable at 240×160 logical resolution
  across common desktop/mobile viewport sizes and device-pixel ratios.
- [ ] Remove browser interaction jank: reliable focus, no page scrolling during
  play, correct keyboard repeat, gamepad navigation, touch hit targets, pause
  behavior, fullscreen/resizing, and visible audio state.
- [ ] Verify animation timing, camera movement, overlays, map SFX, music fades,
  battle music transitions, and return-to-map audio.
- [ ] Add screenshot baselines for representative screens and a lightweight
  manual audio checklist; pixel differences must not hide behavioral failures.

Gate: representative browser sessions are playable with keyboard, gamepad, and
touch, and visual/audio QA has no release-blocking defects.

## P6 — Save, turnwheel, AI, and determinism

- [ ] Round-trip saves containing combat arts, equipped accessories, transformed
  units, multi-skill children, temporary statuses, custom component data,
  dynamically added components, convoy items, and pending chapter events.
- [ ] Test undo/redo for every new persistent mutation: money costs, item copies,
  forced movement, equip state, skill grant/removal, reset/galeforce, HP/status,
  promotion, and transform.
- [ ] Verify save migration/failure messaging for unsupported or older Rekka
  saves; never silently discard unknown state.
- [ ] Add AI scenarios for custom targeting, warp/movement skills, combat arts,
  item restrictions, splash attacks, shops-independent loadouts, and priority
  modifiers.
- [ ] Compare deterministic combat/growth/event RNG streams before and after
  preview, cancel, save/load, and turnwheel playback.

Gate: repeated runs from the same checkpoint produce the same actions and RNG
outcomes, and save/load plus undo/redo preserves object identity and event state.

## P7 — Release gate

- [ ] `npm run build`
- [ ] `npm run audit:parity`
- [ ] Rekka component/expression/resource inventory is clean
- [ ] Rekka all-level boot and event-settle suites are green
- [ ] Rekka checkpoint campaign and optional-route suites are green
- [ ] Full serial Playwright suite is green
- [ ] `git diff --check`
- [ ] Manual visual, audio, input, and save compatibility checklist is signed off
- [ ] Document any deliberate deviations with user-visible impact and a
  regression test; there must be no silent deviations

## Active Next Slice

1. Validate P4 menu/state flows in their actual chapter contexts.
2. Extend campaign checkpoints through route splits, promotion, and endgame.
3. Exercise event entrypoints and only-once/chaining behavior systematically.
4. Complete browser UX/audio/input QA, save migration coverage, and the release
   gate.

## Already present — verify, do not reimplement blindly

- Generic event item hooks and shove/swap paths exist in the web combat lifecycle.
- `self_status_on_hit` exists in combat component handling.
- Upkeep/endstep timing for `time`, `end_time`, `combined_time`,
  `lost_on_upkeep`, `lost_on_endstep`, and regeneration has web implementation.
- Rekka's generic-unit, group, tilemap, dynamic skill-component, custom-option,
  and pair/rescue scripts have focused campaign-context coverage.
- Command-name coverage is broad; the remaining work is semantic parity,
  expression support, lifecycle ordering, presentation, and campaign proof.
