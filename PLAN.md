# LT Web Project Compatibility Plan

This file tracks only active work. Completed Rekka and EOtF implementation
detail belongs in git history, `LOG.md`, and generated reports under
`docs/parity/`.

## Release definition

Embrace of the Fog 2.0 is web-compatible when a fresh browser profile can:

- start a new game and use the free-roaming base and permanent progression;
- complete short and full three-act runs across difficulty modifiers;
- save, suspend, resume, and use the turnwheel without losing identity or
  deterministic state;
- return to the base without compatibility warnings, softlocks, or silent
  mechanic loss; and
- pass the EOtF audit, campaign checkpoints, all-level gates, build, parity
  audit, full serial suite, and visual/audio/input checks.

Target: public `LordTweed/Tweeds_Roguelite` commit `a500736e` (2026-10-25,
project metadata 2.0.1, identical to the official release's `EotF.ltproj`),
installed as `lt-maker/eotf.ltproj`. Upgraded from `d9d2975` (2.0.0) on
2026-10-26.

## Status

All P8 work is complete and every release-definition bullet is satisfied. No
slice is in progress.

Verified baseline:

- all 159 EOtF levels clean-boot without runtime failures;
- both authored raw-PYEV1 events execute, and persistent item/record mutations
  preserve identity plus undo/redo;
- focused EOtF expression, event, combat, item, skill, save, and presentation
  regressions plus the build and parity audit are green;
- all four campaign-valid settlement shards cover all 159 authored levels and
  settle green in one browser session using a restored per-level baseline;
- the continuous EOtF journey runs authored startup, hub roaming and talk,
  EventNid-backed scenario and unit choices, preparations, tactical movement,
  enemy AI, and combat without modeled gameplay state;
- authored hub and battle music-list substitutions resolve valid track NIDs,
  reversible phase overrides remain active through combat, generated inactive
  map sprites keep finished units visible, and 8px-aligned menu backgrounds
  contain their choice highlights;
- all eight missing catalog-backed resources are classified as intentional,
  unreferenced aliases, with zero unclassified missing resources;
- strict mode count-locks 74 verified item and 271 verified skill component
  NIDs and rejects count drift; and
- all 4,966 conditions, 252 eval substitutions, and 646 loop expressions execute
  in strict mode through the Python expression evaluator (`src/events/py-expr`:
  tokenizer, CPython-precedence parser, Python-semantics tree evaluator), whose
  parse trees match CPython's `ast` on all 7,912 distinct EOtF expressions and
  whose results match CPython on an 810-expression semantics fixture; failures
  CPython raises too are logged as Python-equivalent, while missing names and
  missing engine-wrapper attributes are reported as unported support;
- authored `c. Challenge_Unlocks` and `Item_EssenceRender` payloads run through
  `EventState`, covering unit loading, record/table updates, dynamic skill
  components, nested key/value arguments, parent resume, and currency mutation;
- a fresh normal-mode browser profile launches EOtF, traverses title and chapter
  selection into the authored intro, and persists `watched_intro`;
- campaign-valid level `X` settles in `free_roam` with Gacha, wardrobe, bar,
  music, records, and lore services; authored difficulty selection and lesser
  summoning mutate persistent density and create a positioned temporary unit;
- authored run checkpoints cover full/short Act 1–4 routing, camp EXP, generated
  armory/vendor inventories, supports, accessories, stratagems, trial rooms,
  boss-map settlement, battle victory back to `X`, and defeat currency banking;
- the real EOtF project preserves action undo, save/load, combat RNG replay,
  item/party migration fields, and AI economy behavior; its rendered canvas,
  audio controls, keyboard, pointer, touch, and gamepad paths are exercised;
- the full serial Playwright suite runs green on the `eotf` checkout, which has
  the `lt-maker/rekka.ltproj` fixture the earlier Codex worktree lacked;
- the packaged browser build boots EOtF from `/bundles/eotf.ltproj.zip` with
  engine fonts, menu sprites, and platforms staged into `dist/game-data/`;
- every EOtF item component NID the engine did not reference has been resolved:
  `no_equip` (37 authored ability weapons) now vetoes equip and auto-equip,
  `never_use_battle_animation` forces map combat, and `item_icon_flash` and the
  fork's `text_color` were later implemented too (2026-10-26 sweep);
- all 185 item and 270 skill component NIDs are read against their Lex Talionis
  Python definitions, so the audit reports zero unverified NIDs. That pass fixed
  ten semantic divergences, the largest being `weight`: it never reached attack
  or defense speed, because EOtF's `ATTACK_SPEED = SPD` carries no weight token
  and the penalty only lived in an unreachable fallback. Weight now applies via
  the modify_* hooks as Python does, which corrected doubling game-wide;
- two combat goldens encoded that weight bug and have been recomputed from the
  authored data (Brave_Sword weight 12 against CON 5 leaves Eirika at -2 attack
  speed, so Bone's counter doubles);
- all 223 authored tilesets load; EOtF ships the loose-prefab
  `resources/tilesets/tileset.json`, which the manifest-only loader missed;
- roaming works: `InputManager.isKeyHeld` was called by the free-roam state but
  never defined (optional chaining hid it), and roam terrain cost was read from
  the terrain NID instead of its mtype, so every tile reported impassable;
- `on_startup` events run. The EventManager only existed from `loadLevel`, so
  the boot-time trigger was skipped by its own null guard, and a level load
  discarded anything already queued. EotF creates its 91 persistent records
  there, including the `Progress` value its hub gates the opening conversation
  on, so the game replayed that conversation forever and could not advance;
- free-roam triggers carry `levelNid`. Without it `findMatchingEvents` drops
  every level-scoped event, which silently disabled all authored talks and the
  Gacha, Bar, Music, Records, and Skill Swap region services;
- `'Player' + '_skill_slots'` evaluates to `Player_skill_slots`. The string
  literal check only tested that an expression started and ended with a quote,
  so a concatenation had its outer quotes stripped and EotF built persistent
  record NIDs containing raw `' + '` text;
- `choice` follows the Python `Nid;Title;Choices` signature. lt-web read the
  title as the option list, ignored the `expression` and `backable` flags and
  `nid|label` display text, and never published the selection, so authored
  branches reading `{v:<nid>}` could not match. The hub menu rendered empty;
- `textbox` is implemented rather than stubbed, and `remove_table` clears
  textboxes as well as tables (LT has no separate removal command). EotF uses
  109 textboxes for the currency counters beside the summoning pool and shops;
- `choice` honours its `EventNid` keyword and evaluates an expression list even
  without the `expression` flag. The sortie menu depends on both: its
  sub-event is what moves chosen units into the deploying party, so without it
  the first act loaded with an empty party and deployed nobody;
- units start with the weapon experience their prefab grants. lt-web recorded
  it only for types whose unit-level `usable` flag was set, but that flag gates
  the class, not the unit — so EotF's Yusha and Rekka's Lyn could not wield the
  weapons they carry, and no combat was reachable;
- `tests/eotf-journey.spec.ts` walks one continuous play-through — boot,
  records, roaming, an NPC talk, deployment, and a resolved combat — because
  every defect above sat between systems that each passed in isolation.
- unit-dense maps hold frame rate. `unitSpriteTint` evaluated every skill's
  condition for every visible unit on every drawn frame before checking
  whether the skill defined a tint at all — no authored skill uses `unit_tint`
  and only 54 use `unit_flickering_tint`. Testing the component first took
  GrigolBoss (56 units) from 213ms to 7.8ms per frame, 5fps to 129fps.
  Python expressions compile once into closure trees, `wrapSkill` builds
  its component map lazily, and the query-function dictionary is built once;
- the asset bundle is a production default only. Loading it in dev cost 273MB
  of heap against 73MB without, and Vite already serves the project from disk.

The release gate is green: build, all four audits, the full serial suite,
`git diff --check`, and a packaged-build boot check all pass.

## Open work

### P8.1 — Executable compatibility contract

- [x] Make all-level event settlement green with campaign-valid prerequisites.
- [x] Classify every missing catalog resource as intentional or repair it.
- [x] Count-lock every verified EOtF item and skill component in strict mode.

### P8.2 — Expressions and event flow

- [x] Execute every distinct EOtF condition, eval substitution, and loop form
  without fallback.
- [x] Complete the remaining deep-comprehension, board/target-helper, and
  list-valued substitution semantics found by the settlement shards.
- [x] Verify high-volume generic-unit/group, record/table, dynamic-component,
  and trigger-script flows with real project payloads.
- [x] Replace the regex Python-to-JavaScript translation (event conditions,
  evals, loops, variables, component expressions, pyev1, equations) with a real
  Python expression implementation; differential against CPython on the corpus.
- [ ] Per-call-site eval context fidelity: Python passes a component-specific
  subset of unit/target/position/local args; the web still passes all of them.
- [ ] `item_funcs.has_damage` (combat conditions of Hurricane_Onslaught_Child,
  Rumbling_Earth_Child_Helper and Critical_Zone_Aura_Helper/Child) does not exist in the lt-maker reference, so those conditions raise
  and stay False there and here; confirm against EOtF's shipped engine (its
  v1.90 source is only on the Mac, so this is still open).
- [x] Save the action log so the turnwheel can rewind past a suspend/reload,
  as Python's `game_state.save` does (`src/engine/action-serialization.ts`,
  save version 1.1.0; `tests/turnwheel-save-restore.spec.ts`).

### P8.3 — Roguelite systems and campaign proof

- [x] Verify title/new-game flow and persistent-record initialization.
- [x] Verify free-roaming base interactions, summoning, permanent upgrades,
  lore/codex, system unlocks, skill inheritance, and difficulty selection.
- [x] Verify stage choice, camps, shops, events, supports, accessories,
  stratagems, rewards, trials, bosses, and run abandonment.
- [x] Add deterministic short-run and full-run checkpoints through all acts,
  including death/victory returns and metaprogression persistence.
- [x] Verify save/load, suspend, migration, turnwheel, AI, RNG, rendering,
  audio, keyboard, pointer, touch, and gamepad behavior on the real project.

### P8.4 — Release gate

- [x] EOtF compatibility audit is clean.
- [x] EOtF all-level boot and event-settle suites are green.
- [x] EOtF base, short-run, full-run, and optional-system checkpoints are green.
- [x] Build, parity audit, full serial Playwright suite, visual/audio checklist,
  and `git diff --check` are green.
- [x] Package the project for browser delivery and document installation,
  licensing/credits, save storage, and intentional deviations.

### P8.5 — Browser playtest follow-ups

- [x] Gallery: fork-only `show_pokedex` opens the ported unit dex
  (`base_info_menu`), also from `type_dex_unit` choice INFO and manage AUX.
- [x] EOtF engine UI: weather window, forecast digits 100-998, four window
  skins (startup/New Game baked parts), forced skin on Choice/Table, red
  sold-out stock, item help grid offsets, Gallery dex entries.
- [x] Map ability targeting (Trade/Rescue/Take/Give/Drop/Talk/Support...)
  is Python's TargetingState: SelectionHelper cursor (CPython set order),
  pennant, trade/rescue/give previews; combat and spell targeting move by
  direction too and steal shows the trade preview.
- [ ] Targeting highlights: Python draws light spell/attack highlight sprites
  over the whole range plus the cursor tile; the web fills target tiles.
- [x] Promotion items and non-silent event `promote`/`change_class` play
  promotion.py's choice, animation, and level screens.
- [x] Act 2 HUD "glyph": map content under the 75%-opaque unit panel, as in
  Python (pinned in `tests/map-hud.spec.ts`).
- [x] AI-used promotion items: neither engine's AI picks one (Promote has no
  `ai_priority` and no damage, so PrimaryAI never scores it above 0); nothing
  to port. BACK from an item's promotion choice returns to the map with the
  unit still able to act and the item unspent, as Python's reverse_use (a
  broken crest comes back last; a Canto user lands in the Canto move with
  canto movement). Map item uses give Canto like combat (handle_state_stack),
  decided before a class change.
- [x] Engine sprites: the EOtF fork's copies (123x60 `unit_info_bg`, 48x30
  `menu_bg_parchment`, 15 fork-only) win for EOtF and are packed with the
  engine assets; fonts and platforms match upstream.
- [x] Fork-parity audit (`temp/plan-fork-diff.md`): EOtF follows its engine
  fork's combat cleanup order, formula precedence, components, level cap, AI,
  events/queries, map/menu flow, window skin and info menu (`isForkEngine()`).
- [x] Fork-parity leftovers (`tests/fork-followups.spec.ts`): on-hit movers
  (shove/swap/pivot/draw_back, flex shoves) land with the hit before the next
  phase is solved; the solver stops a side whose weapon runs out mid-combat;
  a surviving player defender earns its weapon exp; Tile units don't keep a
  phase alive; AI canto retreats and event moves stop on interrupt regions;
  `choice;...;expression` re-evaluates every frame; battle animations draw no
  extra-damage digits (the fork's AnimationCombat has none).
- [x] Fork events from the engine source (`tests/fork-events.spec.ts`): heal scaling, get_tile_units, baked objectives, choice/table rows and skin, interact_unit item, StyleNid cursor, skip drops tables, find_item.
- [x] Fork AI/flow (`tests/fork-ai-flow.spec.ts`): list-valued unit tags,
  Reset (on_refresh) after event moves/reset/resurrect and for a dying
  rescuer's traveler, Drop waits same-phase droppees, main-target
  target_restrict with 99-range and eval_special_range splash rules, menu
  cancel undoes item-menu storage; the AI re-equips
  items[0], tries skill abilities (never combat arts) and no longer brings its
  weapon to the top.
- [x] Strike timing (`tests/fork-followups.spec.ts` "Python strike timing"):
  on-hit shove/swap/pivot/draw_back destinations are fixed when their phase is
  solved; each phase is solved against the HP earlier phases left (HP
  formulas, skill conditions, lifelink before a counter); live_to_serve heals
  X of the phase's requested ally heals after every strike; the AI's
  multi_target items are one counter-less combat on the fork; item heals in
  combat land on the hit (items without damage deal none); splash-only
  attackers carry their own HP between phases; shove impact events join
  the strike's on_hit events in component order.
- [x] Fork combat from source (`tests/fork-combat-{splash,extras}.spec.ts`): no-target AOE repeats, duplicate multi-target strikes, lifelink/live_to_serve zero cases, extra-damage instances, Spotlight warps, aura initiator, has_damage.
- [x] AnimationCombat's non-fading `screen_blend` flash draws at full strength.
- [x] UI parity: help boxes type their text out through the `__default_help`
  dialog (`tests/help-typewriter.spec.ts`); the Controls settings page rebinds
  keyboard keys, saved in the sync store (`tests/key-remap.spec.ts`);
  upstream `choice`/`table` draw an authored BG by create_base_surf's rule
  (the fork ignores it) and `{v:}` prints a None var as `None`
  (`tests/event-choice-bg.spec.ts`).
- [x] Phase start order (`tests/skill-turn-lifecycle.spec.ts`): status_endstep
  before turn_change, phase events, then PhaseChange ResetAll, then
  status_upkeep per unit (last first, its events before the next), MarkPhase.
- [x] Automatic waits after combat / item use go through Python's WaitState
  (`unit.wait()`, `unit_wait` with actively_chosen False) after the
  end-of-combat events (`tests/fork-combat-cleanup.spec.ts`).
- [x] Broken-item alert (`handle_broken_items` → AlertState, "X broke.") in
  combat, on ally-targeted item uses, and before a crest's promotion choice.
- [x] Partial/deviation sweep (2026-10-26; `docs/parity/PARITY-REPORT.md`
  registry and "Remaining Gaps"): map footsteps (`UnitSound`,
  `tests/unit-footsteps.spec.ts`); the fork's hub SELECT/INFO sounds and
  check_select order; free-roam movement, rationalize slide, roam AI and the
  fork's 1.0 talk range (`tests/roam-movement.spec.ts`); item icon white flash
  and target markers for effective weapons and the fork's eval_warning
  (`tests/item-icon-flash.spec.ts`); the fork's `text_color`
  (`tests/fork-text-color.spec.ts`); movement arrows at a constant 0.9 alpha.
- [x] Unit entry/exit transitions (`tests/unit-transitions.spec.ts`): fade (edge
  slide), warp (anim, flicker, petals, sounds) and swoosh for add_unit,
  create_unit, add_group, remove_unit/group, move_unit/group and spawn_group,
  non-blocking as in Python; kill_unit plays DyingState before going on.

### P8.6 — Differential oracle findings

`npm run oracle` (`tools/oracle/README.md`) replays scenarios on upstream
lt-maker or EOtF's engine fork and on the web. Open behaviour diffs:

- [ ] Unique units get their class `learned_skills` (Canto on Paladins).
- [ ] `WaitAction` also sets has_moved/has_traded/has_attacked.
- [ ] Every level unit gets the level's party (Python `level_setup`).
- [ ] Generics raise wexp to their items' requirements.
- [ ] Generic autolevels honour `enemy_leveling` and, for promoted classes,
  `promoted_autolevels_fraction`.
- [ ] Combat level-ups leave current HP alone (only bonus exp raises it).
- [ ] Item uses and staves draw the combat RNG like Python's solver.
- [ ] `gba_poison`; `cannot_use_items` unequips; a unit whose stun ends at
  upkeep acts that phase.
- [ ] EOtF fork: units on Fixed growths start with 50 growth points per stat.
