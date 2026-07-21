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
| UI/state flow | `lt-maker/app/engine/*_state.py` | `src/engine/states/`, `src/ui/`, `src/main.ts` | closest state/UI spec |
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
7. Update `PLAN.md` minimally, verify, review the diff, then commit and push.

Event commands usually require checking all four surfaces: parser/alias metadata
in `event-manager.ts`, blocking registration and dispatch in `EventState`, an
`Action` for reversible mutations, and a regression proving command chaining or
resume. Save-affecting work should test a real round trip; action-backed work
should test undo and redo, not just `execute()`.

## Verification matrix

Use the cheapest gate that can falsify the change, then broaden once at the end.

| Change scope | Required verification |
|---|---|
| Docs only (`AGENTS.md`, prose-only `PLAN.md`) | `git diff --check` |
| Local TypeScript behavior | `npm run build` + one focused Playwright spec/test |
| Event parser/dispatcher or item/skill hook surface | focused spec + `npm run audit:parity:write` + `npm run audit:parity` + build |
| Save, action log, RNG, state-machine, combat sequencing | focused spec(s) + build + one full serial Playwright run at the end |
| Rendering/layout | focused spec + inspect the produced screenshot/render, then build |
| Release/large cross-system task | build + audit + full serial Playwright suite + `git diff --check` |

Compact commands:

```bash
# Discover exact title before using -g
rg -n "test\(|test\.describe" tests/<area>.spec.ts

# Focused loop
npx playwright test tests/<area>.spec.ts --workers=1 --reporter=dot
npx playwright test -g "<exact title>" --workers=1 --reporter=dot

# Final cross-system gate (run once, not after every edit)
npm run build
npm run audit:parity
npx playwright test --workers=1 --reporter=dot
git diff --check
```

On failure, rerun only the failing spec/title with a verbose reporter or trace.
Do not rerun the full suite merely to obtain a readable error. Use the shell's
configured Node/npm; do not prepend a hard-coded NVM path unless `command -v
node` shows the tool is genuinely unavailable.

`npm run audit:parity:write` owns these generated files:

- `docs/parity/event-commands.{json,md}`
- `docs/parity/item-components.{json,md}`
- `docs/parity/skill-components.{json,md}`

Do not hand-edit them. Do not run the write command for unrelated changes. After
regeneration, inspect `git diff --stat` and the relevant rows, not the whole files.

## PLAN.md policy

`PLAN.md` is the status source of truth, but it is not a session transcript.

- At startup, read only the matching checkbox/bug and `Active Next Slice` if the
  user did not provide a task. A direct user request takes priority over the queue.
- On completion, update an existing checkbox/bug and add at most one concise
  `Recent Changes` bullet describing behavior, tests, and deliberate deferrals.
- Add discovered work as a short unchecked item in the relevant phase. Do not
  paste investigation logs, repeated audit tables, or per-attempt narratives.
- Do not manually maintain TypeScript line counts, source-file counts, state
  counts, or test totals in `AGENTS.md`. Put generated coverage facts in parity
  artifacts; mention exact totals in `PLAN.md` only when the task changes a
  tracked baseline.
- Architecture details belong here only when they are stable and necessary for
  future edits. Feature completion details belong in `PLAN.md` and git history.

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
