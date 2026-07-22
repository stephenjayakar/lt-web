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

## Evidence

Run `npm run audit:parity` for the current source inventory. Generated coverage
counts live under `docs/parity/`; completed milestones and the historical baseline
live in `LOG.md`.

Detailed 2026-07-21 audit notes for the remaining roadmap are staged as working
documents under `temp/plan-*.md`. They record source-grounded gaps and proposed
test seams; they are not completion evidence.

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

**Known Limitations (per-project content):**
- Missing `combat_*.png` panoramas in non-default projects (combat backgrounds show nothing)
- Projects may reference combat effects/palettes not present — renders without them gracefully

---

## Execution Roadmap

Only open work remains here. Completed items and detailed verification history are
archived in `LOG.md`.

### P1 — Event Runtime and Reversible Mutations

- [x] Match blocking/no-block, no-banner, immediate, and skip flags per command

**Gate:** all Python event NIDs are recognized, intentionally dispatched, and covered
by parser plus behavioral tests; unsupported commands fail loudly in development.

### P2 — Actions, Save/Restore, and Turnwheel

- [x] Route all event and gameplay mutations through reversible actions
- [x] Add round-trip tests for units, items, skills, lore, parties, supports, fog,
  initiative, roam, overworld, records, achievements, and in-progress events
- [x] Verify suspend deletion, battle saves, restart saves, and migration defaults

**Gate:** save round trips are lossless for in-scope state and every logged mutation
returns to byte-equivalent state after reverse/redo where the Python action does.

### P3 — Item and Skill Component System

- [ ] Implement item target/restriction/use/end-combat hooks and multi/sub-item behavior
- [ ] Implement remaining charge/cooldown, conditional activation, proc, and status hooks
- [ ] Add fixture-driven component tests, including interactions between components

**Gate:** every runtime component is verified or documented as editor-only; combat and
item-use fixture matrices match Python outputs and side effects.

### P4 — Core Gameplay, Combat, AI, and RNG

- [ ] Compare combat strike ordering, playback, EXP/WEXP, death, and post-combat events
- [ ] Finish dynamic/fixed level-up algorithms and growth-point persistence
- [ ] Extend Pair Up golden coverage to scripted-combat partner phases and guard-follower
  rewards in the full battle-animation presentation

**Gate:** deterministic scenario outputs and action/playback order match Python.

### P5 — State Machine and Player-Facing UI

- [ ] Inventory Python state names and map them to web states or documented mergers
- [ ] Implement remaining trade/item-targeting variants and objective/dialog-log flows
- [ ] Complete base supports and base-menu launch plumbing
- [ ] Add growth/support/WEXP info
- [ ] Remove remaining placeholder portraits/sprites where resources exist

**Gate:** every in-scope Python state has an equivalent reachable flow with keyboard,
mouse, touch, cancel/back, transition, and resume tests.

### P6 — Rendering, Animation, Audio, and Resources

- [ ] Complete combat-animation fallback behavior without debug placeholder art
- [ ] Render attack/defense/pre-proc playback marks with Python-timed icons and effects
- [ ] Add screenshot/golden tolerances for representative maps and combat scenes

**Gate:** required assets load across fixture projects and visual/audio state transitions
match the reference within documented browser tolerances.

## Active Next Slice

Queue refreshed 2026-07-22 after extra damage item parity:

1. Implement remaining item target/restriction/use/end-combat hooks and
   multi/sub-item behavior.
2. Continue the open roadmap in dependency order; keep generated inventories as
   the authoritative coverage counts.
