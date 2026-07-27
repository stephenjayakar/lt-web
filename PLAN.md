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

Target: public `LordTweed/Tweeds_Roguelite` commit `d9d2975` (2026-07-25),
installed as `lt-maker/eotf.ltproj`.

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
- all eight missing catalog-backed resources are classified as intentional,
  unreferenced aliases, with zero unclassified missing resources;
- strict mode count-locks 74 verified item and 270 verified skill component
  NIDs and rejects count drift; and
- all 4,937 conditions, 249 eval substitutions, and 646 loop expressions execute
  in strict mode without evaluator fallback, including nested comprehensions,
  board/target helpers, and list-valued substitutions;
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
  `never_use_battle_animation` forces map combat, and `item_icon_flash` plus the
  deprecated `text_color` are recorded in `README.md` as cosmetic deviations;
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
- unit-dense maps hold frame rate. `unitSpriteTint` evaluated every skill's
  condition for every visible unit on every drawn frame before checking
  whether the skill defined a tint at all — no authored skill uses `unit_tint`
  and only 54 use `unit_flickering_tint`. Testing the component first took
  GrigolBoss (56 units) from 213ms to 7.8ms per frame, 5fps to 129fps.
  Expression compilation and translation are now cached, `wrapSkill` builds
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
