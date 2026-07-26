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

## In progress

**P8.1/P8.2 — Campaign-valid all-level event settlement**

The active slice is making the sharded 159-level `level_start` settlement gate
green after running EOtF's authored `Records_Setup` prerequisites.

Current work:

- finish the remaining deep-comprehension and list-valued substitution fixes
  exposed by the sharded settlement diagnostics;
- complete the remaining board/target game-proxy helpers;
- rerun all settlement shards and record exact unresolved levels/states; and
- keep focused expression tests, the build, parity audit, and clean-boot gate
  green after the final evaluator changes.

Verified baseline:

- all 159 EOtF levels clean-boot without runtime failures;
- both authored raw-PYEV1 events execute, and persistent item/record mutations
  preserve identity plus undo/redo;
- focused EOtF expression, event, combat, item, skill, save, and presentation
  regressions plus the build and parity audit are green; and
- the previous full-suite collection failure was checkout-specific: this
  Codex worktree lacked `lt-maker/rekka.ltproj`, while the main checkout has
  that fixture. Rerun the full serial suite after moving this work to `eotf`.

The settlement shards currently remain the first engine blocker. With
`Records_Setup` initialized, they are exposing nested/list-valued substitutions,
deep comprehensions, and levels that remain in `event` after the diagnostic
frame budget. Once those are green, the remaining work is campaign proof,
strict resource classification, release-wide input/audio/visual/save checks,
and browser packaging.

## Open work

### P8.1 — Executable compatibility contract

- [ ] Make all-level event settlement green with campaign-valid prerequisites.
- [ ] Classify every missing catalog resource as intentional or repair it.
- [ ] Count-lock every verified EOtF item and skill component in strict mode.

### P8.2 — Expressions and event flow

- [ ] Execute every distinct EOtF condition, eval substitution, and loop form
  without fallback.
- [ ] Complete the remaining deep-comprehension, board/target-helper, and
  list-valued substitution semantics found by the settlement shards.
- [ ] Verify high-volume generic-unit/group, record/table, dynamic-component,
  and trigger-script flows with real project payloads.

### P8.3 — Roguelite systems and campaign proof

- [ ] Verify title/new-game flow and persistent-record initialization.
- [ ] Verify free-roaming base interactions, summoning, permanent upgrades,
  lore/codex, system unlocks, skill inheritance, and difficulty selection.
- [ ] Verify stage choice, camps, shops, events, supports, accessories,
  stratagems, rewards, trials, bosses, and run abandonment.
- [ ] Add deterministic short-run and full-run checkpoints through all acts,
  including death/victory returns and metaprogression persistence.
- [ ] Verify save/load, suspend, migration, turnwheel, AI, RNG, rendering,
  audio, keyboard, pointer, touch, and gamepad behavior on the real project.

### P8.4 — Release gate

- [ ] EOtF compatibility audit is clean.
- [ ] EOtF all-level boot and event-settle suites are green.
- [ ] EOtF base, short-run, full-run, and optional-system checkpoints are green.
- [ ] Build, parity audit, full serial Playwright suite, visual/audio checklist,
  and `git diff --check` are green.
- [ ] Package the project for browser delivery and document installation,
  licensing/credits, save storage, and intentional deviations.
