# AGENTS.md — Efficient contribution guide

This file is an operational guide, not a history of the port. Keep it short and
stable. `PLAN.md` owns project status; generated inventories under `docs/parity/`
own coverage counts; git history owns the change log.

## Non-negotiable rules

- `lt-maker/` is the behavioral reference. Before changing engine behavior, read
  the corresponding Python implementation and preserve its ordering, defaults,
  edge cases, and payload shape unless the web port documents a deliberate
  deviation.
- Persistent gameplay mutations must normally be `Action` subclasses with exact
  `execute()`/`reverse()` behavior so turnwheel replay remains deterministic.
- Preserve existing user changes. Start and finish with `git status --short`;
  never stage with `git add -A` in a dirty tree. Stage only task-owned paths or
  hunks.
- After any completed repo change (code, docs, config, or maintenance), commit
  and push the current branch without asking. If verification or push fails,
  report the exact blocker instead of claiming completion.
- TypeScript is strict and uses `erasableSyntaxOnly`; do not use enums or
  constructor parameter properties.

## Start with bounded discovery

Do not read `PLAN.md`, `AGENTS.md`, `game-states.ts`, `action.ts`, or a large
Python module front to back. Locate first, then read a narrow window.

```bash
git status --short --branch
rg -n "Active Next Slice|Known Bugs|<feature>" PLAN.md
rg -n "<symbol-or-nid>" src tests lt-maker/app
sed -n '<start>,<end>p' <located-file>
rg -n "test\.(describe|test)|test\(" tests/*.spec.ts
```

Use `rg --files <dir>` when filenames are unknown. Batch independent read-only
lookups into one command. Avoid broad recursive dumps, repeated `git diff`
prints, and full generated JSON/Markdown reads. If command output is large,
filter it at the source rather than rereading a truncated result.

Treat prior successful checks as a verification cache. Record which paths changed
after each green focused test, build, audit, or full suite; rerun a check only
when one of its relevant inputs changed, it failed, or the final gate explicitly
requires a fresh result. `LOG.md` and agent/chat transcripts are archives: search
them for a specific term or commit and never read them front to back.

For a normal change, the minimum useful context is:

1. the user request and relevant `PLAN.md` checkbox/bug;
2. the authoritative Python function/class;
3. the web call site plus the types it directly consumes;
4. one nearby regression or harness helper.

Do not perform repo-wide architecture audits or delegate work unless the user
explicitly requests them. Expand scope only when a focused test exposes a
cross-cutting defect.

## Reference-to-web map

| Change | Python reference | Web implementation | Typical tests |
|---|---|---|---|
| Event syntax/metadata | `lt-maker/app/events/event_commands.py` | `src/events/event-manager.ts` | `tests/event-commands-*.spec.ts`, `tests/command-flags.spec.ts` |
| Event behavior | `lt-maker/app/events/event_functions.py` | `src/engine/states/game-states.ts` | `tests/event-flow.spec.ts`, event command specs |
| Reversible mutation | `lt-maker/app/engine/action.py` | `src/engine/action.ts` | `tests/turnwheel-breadth.spec.ts`, feature spec |
| Items/skills | `lt-maker/app/engine/item_components/`, `skill_components/` | `src/combat/item-system.ts`, `skill-system.ts` | component/lifecycle specs |
| Targeting/range | Python item/skill systems and target helpers | `src/engine/target-system.ts` | feature spec, `tests/resolve-policies.spec.ts` |
| Combat | `lt-maker/app/engine/combat/` | `src/combat/` | `tests/combat-goldens.spec.ts`, focused combat specs |
| AI/pathfinding | `ai_controller.py`, `pathfinding/` | `src/ai/`, `src/pathfinding/` | `tests/ai-parity.spec.ts`, `movement-parity.spec.ts` |
| Save/restore | `game_state.py`, serializer code | `src/engine/save.ts`, object classes | `tests/save-fields.spec.ts`, feature save spec |
| UI/state flow | `docs/parity/states.md` first, then its linked Python state | linked web state, `src/ui/`, `src/main.ts` | closest state/UI spec |
| Rendering/resources | Python engine/resource code | `src/rendering/`, `src/data/` | rendering/resource specs |

Read `lt-maker/AGENTS.md` only when the relevant Python file is unclear or the
change crosses several Python subsystems.

## Architecture invariants

- `GameState` is a shared singleton. State classes use the existing lazy game
  reference to avoid circular imports.
- The top-level state machine is a deferred, stack-based machine. Lifecycle
  methods may return `'repeat'`; transparent states allow lower states to draw.
- Items and skills are component bags. Runtime components are often `Map` based,
  while project JSON values may be tuples/lists; verify the real serialized shape
  before parsing it.
- Items may form recursive `subitems`/`parentItem` graphs. Ownership, save keys,
  and transfer logic must preserve object identity.
- Combat and growth RNG streams are persistent. Never replace them with
  `Math.random()` or consume extra rolls during preview/playback.
- Combat has solver, map presentation, animation presentation, lifecycle, and
  result-action layers. A change affecting strike semantics may need all of them;
  do not assume changing only the solver is sufficient.
- Canvas rendering targets a 240x160 logical scene. Browser CSS/DPR size is not
  the same as logical engine size.
- Missing optional assets may degrade gracefully; missing required behavioral
  support should fail loudly in development strict mode.

## Editing workflow

1. Write down the reference contract in a few facts: inputs, mutation order,
   blocking/resume behavior, event payloads, and reversal/save requirements.
2. Trace the existing web path with `rg`; reuse current helpers and action/state
   patterns instead of creating a parallel subsystem.
3. Patch the smallest coherent surface. Use `apply_patch`; do not rewrite whole
   large files with ad hoc Python or shell scripts.
4. Add or extend the narrowest relevant regression. Prefer the dedicated spec;
   do not keep adding unrelated cases to `tests/harness.spec.ts`.
5. Run the focused test first. Diagnose a failure with that single test before
   running broader gates.
6. Update generated parity artifacts only if their source surface changed.
7. For every completed roadmap task, update its `PLAN.md` checkbox/status and
   `Active Next Slice`; update `LOG.md` only when archiving completed detail.
   Then verify, review the diff, commit, and push.

Event commands usually require checking all four surfaces: parser/alias metadata
in `event-manager.ts`, blocking registration and dispatch in `EventState`, an
`Action` for reversible mutations, and a regression proving command chaining or
resume. Save-affecting work should test a real round trip; action-backed work
should test undo and redo, not just `execute()`.

## Verification matrix

Use the cheapest gate that can falsify the change, then broaden once at the end.

EOtF's all-level settlement gate covers 159 distinct authored levels and remains
required milestone/final coverage. Do not run it in the normal edit loop:
focused expression tests should take seconds, targeted level shards should
diagnose campaign failures, the full settlement gate should run only at
milestones/final verification, and the full serial suite should run only at the
release gate. Tests tagged `@milestone` are excluded from `npm test`; run them
with `npm run test:milestone`, or include everything with `npm run test:release`.
Keep comprehensive campaign coverage without putting it in the ordinary edit
loop.

| Change scope | Required verification |
|---|---|
| Docs only (`AGENTS.md`, prose-only `PLAN.md`) | `git diff --check` |
| Local TypeScript behavior | build + the narrowest unit-style Playwright test |
| Event parser/dispatcher or item/skill hook surface | focused test + `npm run audit:parity:write` + `npm run audit:parity` + build |
| Save, action log, RNG, state-machine, combat sequencing | focused unit-style contract tests + build; add one narrow browser smoke only for a cross-state seam |
| Rendering/layout | focused spec + inspect the produced screenshot/render, then build |
| Release/large cross-system task | build + audit + `npm run test:release` + `git diff --check` |

Compact commands:

```bash
# Discover exact title before using -g
rg -n "test\(|test\.describe" tests/<area>.spec.ts

# Focused loop
npx playwright test tests/<area>.spec.ts --workers=1 --reporter=dot
npx playwright test -g "<exact title>" --workers=1 --reporter=dot

# Fast broad gate (parallel; excludes campaign-scale @milestone cases)
npm test

# Release gate only
npm run build
npm run audit:parity
npm run test:release
git diff --check
```

On failure, rerun only the failing spec/title with a verbose reporter or trace.
Do not rerun the full suite merely to obtain a readable error. Use the shell's
configured Node/npm; do not prepend a hard-coded NVM path unless `command -v
node` shows the tool is genuinely unavailable.

For a long goal containing several related slices, a "final" full-suite gate
means once before the next pause or handoff, after the last relevant source
change—not once per slice. Focused tests and the build are the per-commit gates;
coalesce related edits into coherent commits and do not repeat an unchanged
green build, audit, or full suite during review/staging.

`npm run audit:parity:write` owns these generated files:

- `docs/parity/event-commands.{json,md}`
- `docs/parity/item-components.{json,md}`
- `docs/parity/skill-components.{json,md}`

Do not hand-edit them. Do not run the write command for unrelated changes. After
regeneration, inspect `git diff --stat` and the relevant rows, not the whole files.

`npm run audit:states:write` owns `docs/parity/states.{json,md}`. Query that
inventory before searching both state trees; regenerate it only when Python state
names, registered web states, or their documented mergers change.

## PLAN.md policy

`PLAN.md` is the status source of truth, but it is not a session transcript.

- At startup, read only the matching checkbox/bug and `Active Next Slice` if the
  user did not provide a task. A direct user request takes priority over the queue.
- Every completed roadmap task must update its checkbox/status and, when needed,
  `Active Next Slice`. Keep this to the affected lines. Untracked maintenance
  does not need a synthetic roadmap entry. Move an item to `LOG.md` only when
  removing completed detail from `PLAN.md`; git history owns routine change notes.
- Add discovered work as a short unchecked item in the relevant phase. Do not
  paste investigation logs, repeated audit tables, or per-attempt narratives.
- Do not manually maintain TypeScript line counts, source-file counts, state
  counts, or test totals in `AGENTS.md`. Put generated coverage facts in parity
  artifacts; mention exact totals in `PLAN.md` only when the task changes a
  tracked baseline.
- Architecture details belong here only when they are stable and necessary for
  future edits. Completed milestones belong in `LOG.md`; routine details belong
  in git history.

## Delegation when explicitly requested

- Give each agent one bounded seam with exact allowed paths and one focused
  acceptance check. Do not launch overlapping repo-wide audits and implementations.
- Point agents at files/symbols instead of pasting source. Ask for a compact
  contract, changed paths, and test result; put reusable long research in one
  named `temp/plan-*.md` file rather than returning it through chat.
- The parent reviews the diff/result, not the agent transcript. Avoid duplicate
  peer messages plus structured yields, and do not make agents run broad gates,
  update planning files, commit, or push; integration owns those once.

## Final review and git

Before staging:

```bash
git status --short
git diff --stat
git diff -- <task-owned paths>
git diff --check
```

Confirm no debug files, screenshots, test artifacts, or unrelated generated
changes are included. Stage explicit paths; use patch staging for a shared dirty
file. Commit with a behavior-focused message, push the current branch, and report
the focused/full gates actually run plus any remaining deviation.
