# LT Web Project Compatibility Plan

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
  `resources/custom_sprites/press_start.png` are present but fully transparent;
  the web runtime loads them, detects the empty art, and falls back to the
  configured project title and prompt.
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
- [x] Make unsupported project-used expressions and components fail loudly in
  development/test mode instead of quietly returning false or doing nothing.
- [x] Add focused trace output for event ID, command index, trigger locals, state
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
- [x] Validate all 330 distinct event conditions, all 69 distinct eval
  substitutions, and all 33 event loops against expected Python results.
- [x] Add scenarios for global shop selection, dynamic generic units,
  conditional recruitment, victory/route branches, and random-skill events.
- [x] Verify trigger-local payloads such as `unit`, `unit2`, `item`, `item2`,
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
- [x] Audit and port any reachable `cleave_2_range_aoe`, `phasewalk`, `charge`,
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
- [x] Preserve exact hook ordering, playback markers, event payloads, charge
  triggering, action reversal, and save/restore state.

Gate: every custom component referenced by project data has a golden test against
the Python implementation, including AI and turnwheel behavior where applicable.

## P3 — Core Rekka item and skill systems

### Player-facing mechanics

- [x] Implement 42 `combat_art` skills: command/menu flow, allowed-weapon
  filtering, child skill activation, cost/stack checks, targeting,
  cancellation, cleanup, proc presentation, and turnwheel behavior.
- [x] Complete combat-art AI selection and the child-component gaps tracked
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
- [x] Combat math: `armsthrift`, `armsthrift_always`, `dynamic_crit_accuracy`,
  all five `all_brave` skills, all 36 used alternate skill formula components
  (including additive critical damage), all 13 generic attack/defense proc
  parents and 12 authored proc rates, condition-aware Vantage/Desperation and
  close/distant counters, follow-up resistance, and all 55 authored minimum,
  maximum, evaluated, and capped skill-range modifications.
- [x] Turn/map lifecycle: `endstep_damage`, upkeep events, `galeforce`,
  condition-aware movement-type/Pass/terrain/grounding overrides, and
  no-attack-after-move restrictions.
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
- [x] Verify menu/state flows in their campaign contexts:
  - [x] Base/prep entry and return, unit management/convoy access, formation,
    options, and enabled save routes.
  - [x] Chapter-conditioned armory/vendor entry, flavor, and exact stock.
  - [x] Rekka promotion item/class/skill data through the map item flow.
  - [x] Prep-management trading with Rekka inventories and disabled support UI
    when the project's support pairs reference no available Rekka units.
  - [x] Rekka chapter-history/MVP records opened through Base Codex.
- [x] Verify every recruitment, talk, visit, chest/door, reinforcement, boss,
  escape/seize/defeat/survive objective, multi-stage objective, and chapter
  transition.
- [x] Add campaign checkpoints rather than attempting only one huge brittle
  end-to-end test:
  - [x] Early: Prologue level start, House visit reward/consumption, Gate seize,
    and chapter 1 transition with Lyn's inventory and party money preserved.
  - [x] Midgame: chapter 26 prep-registered Eliwood/Legault talk recruitment,
    Chest1 reward/consumption, throne seize, and chapter 27 persistence.
  - [x] Late: chapter 33's three one-time castle seizes remain incomplete after
    the first two, converge on victory after the third, and load chapter 34's
    prep rewards.
  - [x] Final map/ending: the morph convergence opens Nergal's group, Nergal's
    death loads `Final_2` and the Dragon encounter, and Dragon death renders
    Rekka's scripted credit cards before returning cleanly to title.
- [x] Exercise all 899 events through direct entrypoint tests or reachable
  campaign scenarios, including chaining, blocking/resume, and only-once rules.

Gate: a deterministic automated campaign route reaches the ending, with focused
alternate-route/optional-content scenarios and no event/state softlocks.

## P5 — Browser presentation and UX

- [x] Load Rekka's custom `logo.png` and `press_start.png`; render visible custom
  art or an explicit project-title fallback for its transparent files, with
  configured title music and an audio-unlock-safe start.
- [x] Audit every referenced panorama, portrait, map sprite, tileset, icon,
  animation, combat animation/effect, music track, and SFX; distinguish optional
  fallback from required-resource failure.
- [x] Visually verify title, save select, prep/base, representative maps,
  combat forecast, map combat, full battle animation, combat arts, accessories,
  shops, dialogue, chapter transition, ending, and credits.
- [x] Ensure menus remain legible and stable at 240×160 logical resolution
  across common desktop/mobile viewport sizes and device-pixel ratios.
- [x] Remove browser interaction jank: reliable focus, no page scrolling during
  play, correct keyboard repeat, gamepad navigation, touch hit targets, pause
  behavior, fullscreen/resizing, and visible audio state.
- [x] Verify animation timing, camera movement, overlays, map SFX, music fades,
  battle music transitions, and return-to-map audio.
- [x] Add screenshot baselines for representative screens and a lightweight
  manual audio checklist; pixel differences must not hide behavioral failures.

Gate: representative browser sessions are playable with keyboard, gamepad, and
touch, and visual/audio QA has no release-blocking defects.

## P6 — Save, turnwheel, AI, and determinism

- [x] Round-trip saves containing combat arts, equipped accessories, transformed
  units, multi-skill children, temporary statuses, custom component data,
  dynamically added components, convoy items, and pending chapter events.
- [x] Test undo/redo for every new persistent mutation: money costs, item copies,
  forced movement, equip state, skill grant/removal, reset/galeforce, HP/status,
  promotion, and transform.
- [x] Verify save migration/failure messaging for unsupported or older Rekka
  saves; never silently discard unknown state.
- [x] Add AI scenarios for custom targeting, warp/movement skills, combat arts,
  item restrictions, splash attacks, shops-independent loadouts, and priority
  modifiers.
- [x] Compare deterministic combat/growth/event RNG streams before and after
  preview, cancel, save/load, and turnwheel playback.

Gate: repeated runs from the same checkpoint produce the same actions and RNG
outcomes, and save/load plus undo/redo preserves object identity and event state.

## P7 — Release gate

- [x] `npm run build`
- [x] `npm run audit:parity`
- [x] Rekka component/expression/resource inventory is clean
- [x] Rekka all-level boot and event-settle suites are green
- [x] Rekka checkpoint campaign and optional-content suites are green
- [x] Full serial Playwright suite is green
- [x] `git diff --check`
- [x] Manual visual, audio, input, and save compatibility checklist is signed off
- [x] Document any deliberate deviations with user-visible impact and a
  regression test; there must be no silent deviations

## Active Next Slice

Embrace of the Fog P8.2: port the next coherent engine-generic skill family
selected from the generated compatibility inventory. Continue count-locking
only components whose real EotF value shapes and runtime behavior have focused
coverage.

## P8 — Embrace of the Fog 2.0

Target: public `LordTweed/Tweeds_Roguelite` commit `d9d2975` (2026-07-25),
installed as `lt-maker/eotf.ltproj`. Completion means a fresh browser profile can start a
new game, use the free-roaming base and permanent progression, complete short
and full three-act runs across difficulty modifiers, save/resume safely, and
return to the base without compatibility warnings or silent mechanic loss.

### P8.1 — Discovery and executable compatibility contract

- [x] Pin a current EotF source snapshot and record its project scale.
- [x] Add a generated EotF inventory for commands, expressions, components,
  custom Python hooks, and catalog-backed resources.
- [x] Add all-level clean-boot and level-start settlement smoke coverage.
- [ ] Classify all missing catalog resources as intentional or repair them.
- [ ] Count-lock every verified EotF item and skill component in strict mode.

### P8.2 — Expressions, event flow, and project-local components

- [x] Preserve Python component-object expression semantics for EotF's
  `blue`, `combat_art_proc`, `copysafe`, `has_affinities`, `shit`, `subskills`,
  and `tether_parameters` skill components.
- [x] Apply EotF `self_nihil` gates consistently across item availability,
  combat, combat arts, turn hooks, map/UI presentation, and generic skill hooks.
- [x] Preserve playback-aware `event_after_combat`, charged
  `event_after_kill`, `upkeep_event`, and reversible `upkeep_skill_gain`
  lifecycle behavior.
- [x] Preserve ordered `event_before_combat`, `crit_event`,
  `event_after_combat_if_take_damage`, `endstep_event`, and reversible
  `endstep_skill_gain` lifecycle behavior.
- [x] Preserve personal, reactive, and area `gain_skill_after_*` recipient,
  initiator, charge, immediate-combat snapshot, and undo/redo behavior.
- [x] Preserve per-strike and end-combat `give_*status*` timing, enemy/ally
  and AoE recipients, initiator attribution, status reactions, charges, and
  undo/redo behavior.
- [x] Preserve EotF's flat/evaluated post-combat damage and healing,
  multi-target damage, nonlethal recoil, percentage splash, charges, and
  undo/redo behavior.
- [x] Preserve strike-ordered self, critical, target-adjacent, and ranged
  ally lifelink with overkill clamps, plus ranged post-combat ally healing,
  exact charges, and undo/redo behavior.
- [x] Preserve permanent max-HP damage and Undying Will reconciliation,
  kill healing, enemy status removal, and configurable combat-count expiry
  with fields, skill data, stacks, and undo/redo intact.
- [x] Preserve full and event-driven miracle survival, target-aware defense
  proc rates, combat/kill charge increments, shared and limited charges, and
  reversible depleted-charge removal.
- [x] Surface all skill-granted EotF abilities as persistent item trees with
  condition/charge gating, multi-item choice, combat and empty-tile event
  routing, aura-parent charges, save identity, and team-wide combat-art use.
- [x] Preserve all 123 real uses of EotF's evaluated damage, hit, weight,
  physical/magic/dragon formula, separate extra-damage, ally-damage, exempt
  weapon-type, and Magician rank-bypass item components.
- [x] Preserve all 58 real uses of EotF's evaluated minimum/maximum range,
  smart/ally blast, all-unit and big-cleave AoE, and tile-unless-ally targeting
  across player targeting, counters, AI, threat ranges, and UI.
- [x] Preserve all 107 real uses of EotF's stack, evaluated stack/HP, cooldown,
  and starting-cooldown item resources across availability, combat, direct use,
  upkeep, chapter cleanup, save data, and undo/redo.
- [x] Preserve all 13 real uses of EotF's evaluated/unrestricted healing,
  refresh, and restore item hooks across target routing, combat/AoE hits,
  direct consumables, AI valuation, modifiers, and undo/redo.
- [x] Preserve all 27 real uses of EotF's strict, flexible, signed,
  initiation-only, self, pivot, draw-back, and collision-event forced-movement
  item hooks with exact blocking rules, payloads, and undo/redo.
- [x] Preserve all 11 real uses of EotF's pre-combat, per-hit-target
  post-combat, and item-break event hooks with exact participant context,
  deduplication, ordering, and local payloads.
- [x] Preserve all 57 real uses of EotF's immediate and end-combat item
  status/stack hooks, including mid-combat phase recalculation, support-AI
  valuation, self-stack removal, and single-action turnwheel replay.
- [x] Preserve all 5 real uses of EotF's CON-gated, equipped-item, and
  unconditional theft hooks across target/item restrictions, player choice,
  AI valuation, hit transfer, records, overflow discard, and turnwheel replay.
- [x] Preserve all 5 real uses of EotF's self-unload sequence hook across
  weakly traversable targeting, user warping, cursor follow, parent event
  routing, free-action semantics, sequence-tree identity, and turnwheel replay.
- [x] Remove all 11 EotF chapter-temporary items from current-party unit and
  convoy inventories before persistent snapshots, including exact action
  replay and full/non-full cleanup entry points.
- [x] Preserve EotF's Blitz Strike crit refresh with active-phase and shared
  charge gating, multi-crit deduplication, and exact turnwheel replay.
- [x] Port all 53 used project-local item components, including the final
  immediate HP boosters and Solomon's signed RES-based damage/Monster healing.
- [x] Preserve all 30 EotF Savage status, multi-status, and current-HP splash
  hooks with start-combat condition snapshots, enemy shells, and exact replay.
- [x] Activate all 21 authored EotF evaluated and target-aware additive
  critical-damage expressions in scripted and RNG combat, including nested
  Python conditionals and the two dormant Python hook-name mismatches.
- [x] Preserve all 32 EotF per-strike gain, removal, event, and damage
  mitigation uses with immediate/deferred ordering, combat-condition and
  charge gates, full expression context, and exact turnwheel replay.
- [x] Preserve all 13 EotF cover and application-time stat uses with
  strict/partial HP-action rewriting, aura-owner cover, frozen expression
  values, charge, save identity, and exact turnwheel replay.
- [x] Preserve all 54 EotF dynamic attack-phase, multi-hit, pre-counter blitz,
  evaluated extra-damage, alternate magic-formula, and encounter-frozen stat
  uses with full Python expression context and combat-order coverage.
- [x] Activate all 647 EotF evaluated stat, damage, hit/avoid, crit/dodge,
  resist, true-speed, and dynamic damage-multiplier uses across forecasts,
  AI scoring, doubling, and strike resolution.
- [x] Preserve all 3,421 EotF foundational hidden/class-skill metadata,
  drain/build/per-turn charge initialization and reversible chapter resets,
  and end-of-chapter skill expiry uses.
- [x] Gate all 1,999 EotF condition/combat-condition, static stat, damage,
  hit/avoid, crit/dodge, resist, speed, multiplier, and cannot-double uses
  across forecasts, AI scoring, and combat snapshots.
- [x] Preserve all 786 EotF aura child, range, and ally/enemy/unit target uses
  with Python stack limits, stable source replacement, off-board cleanup,
  movement undo, and save/load re-derivation.
- [x] Preserve all 392 EotF upkeep/endstep/combined timers, growing-stat
  counters, option-driven combat expiry, and reversible chapter cleanup uses.
- [x] Preserve all 593 EotF item-override, combat-art, allowed-weapon, and
  weapon-access uses with reverse-skill precedence, condition/charge gating,
  expression dispatch, resource/status hooks, and weapon filtering.
- [x] Preserve all 441 EotF alternate item-equation, effectiveness,
  range-dependent magic, and weapon-triangle uses, including Python
  base-plus-override numeric accumulation and effectiveness negation.
- [x] Preserve all 437 EotF action-retention, brave, counter, doubling, and
  miss-damage item uses with equipped-weapon authority, exact weapon/spell/
  siege defaults, and base-plus-override numeric accumulation.
- [x] Preserve all 40 EotF signed/evaluated regeneration, upkeep damage,
  standard recoil, nonlethal post-combat damage, and immediate follow-up
  healing uses with charge timing and exact turnwheel replay.
- [x] Preserve all 23 EotF timed resistance, negative and specific-status
  blocking, immunity, and upkeep ailment cleansing uses with charge timing
  and exact turnwheel replay.
- [x] Preserve all 51 EotF fatal-damage, fatal-block, dazzle, blind, berserk,
  sweep-immunity, no-stack, and paragon marker uses across death events,
  combat/item expressions, target gates, and stack-selection scripts.
- [x] Preserve all 50 EotF Canto, Canto+, Canto Sharp, fixed Canter, and
  evaluated Canter uses with Python gating, maximum movement resolution,
  Canto Control, player/AI post-combat routing, and exact turnwheel replay.
- [x] Preserve all 7 EotF accessory swaps, inventory expansions, and item-slot
  penalties with independent last-active hook resolution across supply,
  theft, reward, and discard capacity checks.
- [x] Preserve all 12 EotF total, enemy-targeted, standard-magic, and
  evaluated-magic item lockouts across equip, targeting, AI, and use checks.
- [x] Preserve all 3 EotF expression-driven growth skills across shared
  leveling and growth-rate UI evaluation with active-skill gating.
- [x] Preserve EotF's multi-skill post-combat grant with authored ordering,
  one charge trigger, and exact turnwheel replay.
- [x] Preserve EotF's Gain Terrain override and generic Ignore Terrain
  false-priority resolution for combat terrain bonuses.
- [x] Apply the four EotF status-region skills on arrival/removal with
  Ignore Region Status and Gain Terrain precedence.
- [x] Preserve EotF `bloody_moon` Beast buffs and `ride_the_lightning`
  range-limited status propagation through reversible after-gain hooks.
- [x] Queue all eight EOtF `start_and_end_event_initiate` event pairs with
  initiator-only filtering and complete combat local arguments.
- [x] Preserve EOtF visual counters, forced end-combat charge use, upkeep AoE
  grants, and booster marker expression access.
- [ ] Execute every distinct EotF condition, eval substitution, and loop form.
- [ ] Verify EotF's high-volume generic-unit/group, record/table, dynamic
  component, and trigger-script event flows with real project payloads.
- [x] Port all 53 used project-local item components with focused value-shape,
  mutation-order, targeting, combat, undo/redo, and save coverage.
- [x] Port all 108 used project-local skill components with focused lifecycle,
  proc-order, charge, tether, status, damage-redirection, and save coverage.

### P8.3 — Roguelite systems and campaign proof

- [ ] Verify title/new-game flow and persistent-record initialization.
- [ ] Verify free-roaming base interactions, summoning, permanent upgrades,
  lore/codex, system unlocks, skill inheritance, and difficulty selection.
- [ ] Verify stage-choice generation, camps, shops, events, supports,
  accessories, stratagems, rewards, trials, bosses, and run abandonment.
- [ ] Add deterministic short-run and full-run checkpoints through all acts,
  including death/victory returns to base and metaprogression persistence.
- [ ] Verify save/load, suspend, migration, turnwheel, AI, RNG, audio, rendering,
  keyboard, pointer, touch, and gamepad behavior on the real project.

### P8.4 — Release gate

- [ ] EotF compatibility audit is clean.
- [ ] EotF all-level boot and event-settle suites are green.
- [ ] EotF base, short-run, full-run, and optional-system checkpoints are green.
- [ ] Build, engine parity audit, full serial Playwright suite, visual/audio
  checklist, and `git diff --check` are green.
- [ ] Package the project for browser delivery and document installation,
  licensing/credits, save storage, and known intentional deviations.

## Already present — verify, do not reimplement blindly

- Generic event item hooks and shove/swap paths exist in the web combat lifecycle.
- `self_status_on_hit` exists in combat component handling.
- Upkeep/endstep timing for `time`, `end_time`, `combined_time`,
  `lost_on_upkeep`, `lost_on_endstep`, and regeneration has web implementation.
- Rekka's generic-unit, group, tilemap, dynamic skill-component, custom-option,
  and pair/rescue scripts have focused campaign-context coverage.
- Command-name coverage is broad; the remaining work is semantic parity,
  expression support, lifecycle ordering, presentation, and campaign proof.
