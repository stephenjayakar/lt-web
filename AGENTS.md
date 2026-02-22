# AGENTS.md -- How the Engine Was Designed and Built

This document describes how the Lex Talionis web engine was architected
during a single AI-assisted session, covering the analysis strategy,
design decisions, parallelization approach, and the agent workflow that
produced ~9,200 lines of TypeScript across 37 files.

When making modifications, you should generally plan out what to do in PLAN.md, and update what you accomplished in there. Also, make sure to keep this file up to date with the architecture of the project.

**Important:** Always update PLAN.md when you complete tasks (check off items, update line counts, add to "Recent Changes") or discover new tasks/bugs (add them to the appropriate section). PLAN.md is the source of truth for project status.

---

## 0. Reference Codebase

The original **Lex Talionis** Python codebase (lt-maker) is checked into
this repo at `lt-maker/`. Use it as the authoritative reference for how
any feature should work. Key directories:

- `lt-maker/app/engine/` — core engine (state machine, rendering, game systems)
- `lt-maker/app/events/` — event scripting (commands, functions, portraits)
- `lt-maker/app/data/` — data loading and database
- `lt-maker/app/editor/` — editor UI (not relevant for the web port)
- `lt-maker/default.ltproj/` — default Sacred Stones project data
- `lt-maker/AGENTS.md` — comprehensive technical reference for the
  original engine (architecture, data model, all systems, conventions)

When implementing a new feature, **always read the corresponding Python
source first** to understand the original behavior before writing TypeScript.
The `lt-maker/AGENTS.md` file is an excellent starting point for understanding
any system before diving into the Python source.

---

## 1. Analysis Phase: Three Parallel Deep Dives

The original Lex Talionis codebase is approximately 80,000+ lines of
Python across 200+ files. Reading it sequentially would have been
prohibitively slow, so the analysis was split into three parallel
`explore` agents, each given a different cross-section of the codebase:

| Agent | Focus Area | Key Discoveries |
|-------|-----------|-----------------|
| **Architecture Agent** | Entry points, game loop, state machine, rendering pipeline, `engine.py`, `driver.py`, `state_machine.py`, `map_view.py` | Stack-based state machine with deferred transitions; 240x160 fixed resolution scaled to display; `engine.py` is the Pygame abstraction seam; immediate-mode rendering (no scene graph); module-level singletons everywhere |
| **Data Agent** | `.ltproj` structure, JSON formats, serialization, resource loading, tilemap format, sprite organization | Chunked vs non-chunked data; `.orderkeys` for ordering; terrain grid uses `"x,y"` string keys; component-based items/skills; tileset sprite grids reference `[tileset_nid, [x, y]]` |
| **Game Logic Agent** | Combat, AI, pathfinding, movement, turns, events, input, UI | CombatPhaseSolver with attacker/defender state machine; 4 RNG modes; AI utility evaluation with offense/defense bias; Dijkstra for movement ranges + A* for paths; semicolon-delimited event scripting |

Each agent returned a detailed architectural summary with file paths and
line numbers for every key component. These three summaries formed the
"mental model" used for all subsequent design decisions.

**Why three agents instead of one?** The codebase is too large for a
single exploration pass to cover thoroughly. By splitting along
architectural boundaries (infrastructure / data / logic), each agent
could read files in depth rather than skimming. The results were
complementary with minimal overlap.

---

## 2. Architecture Decisions

### 2.1 Canvas, Not WebGL

The original engine renders at 240x160 pixels and uses immediate-mode
compositing (every frame, blit layers onto surfaces from scratch). This
maps directly to the HTML5 Canvas 2D API. WebGL would be overkill for
this resolution and would add complexity for no visual benefit.

The `Surface` class wraps `OffscreenCanvas` to provide the same API as
Pygame's `Surface`: `blit`, `fill`, `subsurface`, `getPixel`, `copy`,
`flipH`, `flipV`, `makeGray`, `makeTranslucent`, and `colorConvert`.
This makes the rendering code a near-direct translation from Python.

### 2.2 Singleton Game State (Faithful Translation)

The original engine uses a module-level `game = GameState()` singleton
imported everywhere. Rather than fighting this pattern with dependency
injection (which would have required rewriting every system's API), the
port preserves it:

```
engine/game-state.ts  -> export let game: GameState
                      -> export function initGameState(...)
```

Game states use a lazy reference (`setGameRef` / `getGame`) to avoid
circular import issues that would arise from `game-states.ts` importing
`game-state.ts` which transitively imports everything.

### 2.3 Stack-Based State Machine (Direct Port)

The state machine is the backbone of LT. Every game mode (title screen,
free cursor, movement, combat, AI turn, events) is a `State` on the
stack. The port preserves this exactly:

- States have lifecycle methods: `start`, `begin`, `takeInput`, `update`,
  `draw`, `end`, `finish`
- Transitions are deferred: `change(name)` / `back()` / `clear()` queue
  operations processed at end of frame
- Transparency: transparent states (menus, combat overlay, events) let
  states beneath them draw too
- `'repeat'` return: any lifecycle method can return `'repeat'` to re-run
  the state machine in the same frame (enables instant state chains)

### 2.4 Data Loading Over HTTP

The original engine loads `.ltproj` data from the local filesystem. For
the web, assets are served as static files and fetched over HTTP:

```
/game-data/default.ltproj/
  metadata.json
  game_data/
    constants.json
    items/.orderkeys
    items/Iron_Sword.json
    ...
  resources/
    tilesets/Prologue.png
    map_sprites/Eirika_Lord-stand.png
    ...
```

The `ResourceManager` handles all fetching with caching and deduplication.
The `Database` loads chunked data by reading `.orderkeys` first, then
fetching each chunk in parallel.

### 2.5 TypeScript Constraints

The project uses `erasableSyntaxOnly: true` (a recent TypeScript strict
mode option). This disallows constructor parameter properties
(`constructor(private x: number)`) and enums, requiring explicit field
declarations. All agents were instructed about this constraint.

---

## 3. Build Phase: Parallel Agent Batches

After analysis, the engine was built in **5 batches**, each batch
launching 2-3 `general` agents in parallel. Each agent was given:

1. A list of files to write with detailed API signatures
2. Knowledge of the LT architecture from the analysis phase
3. The TypeScript constraint (`erasableSyntaxOnly`)
4. Instructions to read existing files for API compatibility

### Batch 1: Foundations (4 files written directly)
- `constants.ts`, `surface.ts`, `input.ts`, `state.ts`
- Written directly (not via agents) since they're small and foundational

### Batch 2: Three Agents in Parallel
| Agent | Files | Lines |
|-------|-------|------:|
| State Machine + Camera + Cursor | `state-machine.ts`, `camera.ts`, `cursor.ts` | ~470 |
| Data Types + Game Objects | `types.ts`, `unit.ts`, `item.ts`, `skill.ts` | ~625 |
| Resource Manager + Database | `resource-manager.ts`, `database.ts` | ~684 |

### Batch 3: Three Agents in Parallel
| Agent | Files | Lines |
|-------|-------|------:|
| Tilemap + Map View + Highlights | `tilemap.ts`, `map-view.ts`, `highlight.ts` | ~520 |
| Pathfinding + Movement | `pathfinding.ts`, `path-system.ts`, `movement-system.ts` | ~779 |
| Game Board + Phase + Actions | `game-board.ts`, `phase.ts`, `action.ts` | ~500 |

### Batch 4: Three Agents in Parallel
| Agent | Files | Lines |
|-------|-------|------:|
| Combat System | `combat-calcs.ts`, `combat-solver.ts`, `map-combat.ts` | ~861 |
| AI System | `ai-controller.ts` | ~413 |
| Map Sprite + Unit Renderer | `map-sprite.ts`, `unit-renderer.ts` | ~306 |

### Batch 5: Two Agents in Parallel
| Agent | Files | Lines |
|-------|-------|------:|
| UI System | `menu.ts`, `hud.ts`, `health-bar.ts`, `dialog.ts`, `banner.ts` | ~699 |
| Events + Audio | `event-manager.ts`, `audio-manager.ts` | ~630 |

### Batch 6: Two Agents in Parallel (Integration)
| Agent | Files | Lines |
|-------|-------|------:|
| GameState Singleton | `game-state.ts` | ~405 |
| All Game States | `game-states.ts` | ~1353 |

### Batch 7: One Agent (Entry Point)
| Agent | Files | Lines |
|-------|-------|------:|
| Main Entry Point | `main.ts` | ~308 |

**Total: ~15 agent invocations across 7 batches**, plus direct file
writes for the smallest files.

---

## 4. Agent Communication Pattern

Each agent was given a self-contained task with:

- **Exact file paths** to write
- **API signatures** (interfaces, method signatures, constructor shapes)
- **Implementation notes** (algorithm details, LT-specific behavior)
- **Constraints** (no constructor parameter properties, import paths)
- **Verification**: agents were told to read existing files first to match
  APIs, and the project was type-checked after each batch

The key challenge was **cross-file API compatibility**. When Agent A
writes `PathSystem` and Agent B writes `GameBoard`, they both need to
agree on the `GameBoard` API. This was handled by:

1. Writing foundational types first (`types.ts`, `unit.ts`, `item.ts`)
2. Specifying exact API contracts in agent prompts
3. Having later agents read earlier files before writing
4. Running `tsc --noEmit` after each batch to catch mismatches

No batch produced type errors. The final build was clean on the first
try.

---

## 5. Design Patterns Used

### Immediate-Mode Rendering
Every frame, the entire visible scene is redrawn from scratch. There is
no retained scene graph. This matches LT's Pygame rendering and is
simple to reason about:

```
MapView.draw() {
  blit background tilemap
  draw highlights
  draw grid
  draw units (Y-sorted)
  draw foreground tilemap
  draw cursor
}
```

### Command Pattern (Actions)
Every game mutation is an `Action` with `execute()` and `reverse()`.
This enables the turnwheel (time-rewind) feature and makes the game
state fully deterministic.

### Component-Based Items/Skills
Items and skills are bags of named components (`[name, value]` pairs).
The component name determines behavior (e.g., `"weapon"`, `"brave"`,
`"damage"`, `"uses"`). This is an entity-component pattern without the
"system" -- components are queried directly by the combat/targeting code.

### State Machine for Everything
Combat resolution, AI decision-making, event execution, and even the
map combat visual presentation all use internal state machines. The
top-level game state machine manages which of these is active.

---

## 6. What Worked Well

- **Parallel analysis** saved significant time. Three agents exploring
  different parts of the codebase simultaneously produced a comprehensive
  understanding in one round-trip.
- **Batch parallelism** for writing files was highly effective. Independent
  modules (pathfinding, combat, AI, UI) can be written simultaneously
  without conflicts.
- **Specifying exact APIs in prompts** prevented most cross-file
  compatibility issues. Type-checking after each batch caught the rest.
- **Faithful architectural translation** (keeping the singleton pattern,
  stack-based state machine, and immediate-mode rendering) avoided the
  need to redesign the game's control flow, which would have been the
  biggest risk.

## 7. What Could Be Improved

- **The `any` type** is used in a few places (the lazy game reference in
  `game-states.ts`, the `MapSprite = unknown` type alias). These should
  be replaced with proper typed interfaces to prevent runtime surprises.
- **No runtime testing** was done during the build. The engine compiles
  but has not been executed against real game data. The first runtime
  test will likely surface dozens of integration issues.
- **Agent prompt size** became a challenge for the larger files
  (`game-states.ts` at 1353 lines). Extremely detailed prompts were
  needed to get all 11 states correct in a single pass.
- **Duplicate combat-calcs.** Two agents independently wrote
  `combat-calcs.ts` with slightly different APIs. This was resolved by
  keeping the more complete version, but better coordination (or writing
  shared interfaces first) would have prevented it.
