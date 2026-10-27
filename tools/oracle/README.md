# Differential oracle

Runs the same scenario through a real Python Lex Talionis engine and through
the web port, snapshots both after every step, and prints the fields that
differ.

```
npm run oracle                                  # every scenario in scenarios/
npm run oracle -- default-combat-exp            # one scenario (name or path)
npm run oracle -- eotf-hub-start --backend=upstream
npm run oracle -- default-trade --full          # every diff at every step
```

Exit code: `0` all match, `1` behaviour differences, `2` a driver failed
(harness error, step error or timeout). Raw runs are written to
`$LT_ORACLE_OUT/<scenario>/{py,web}.json` (default
`E:/BigData/lt-oracle/out`); `node tools/oracle/diff.mjs py.json web.json`
re-diffs two saved runs.

| File | Role |
|---|---|
| `py_driver.py` | Python side. Imports the engine in place and drives it headless. |
| `web/page-driver.ts` | Web side, loaded into a `?harness=true` page through Vite. |
| `web-driver.mjs` | Starts/reuses Vite, opens a muted headless Chromium, runs a scenario. |
| `run.mjs` | `npm run oracle`: runs both sides per scenario and diffs. |
| `diff.mjs` | Field-level comparison and report. |
| `noncomparable.json` | Fields ignored or normalised, each with its reason. |
| `scenarios/*.json` | Scenarios. |

## Engines

The Python side has two backends; the scenario picks one with `"engine"`, else
fork projects (`eotf.ltproj`) use `fork` and everything else `upstream`.
`--backend=` on the command line overrides both.

- **upstream**: rainlash/lt-maker from `lt-maker/`, under a venv with the
  engine requirements. lt-maker generates `item_system.py`, `skill_system.py`
  and the PyEv1 wrappers into its own tree at startup; the driver writes them
  to `$LT_ORACLE_HOME/gen/` instead and appends that to `app.__path__`, so
  the shared `lt-maker/` junction is never written to. Projects missing
  resource folders or catalogs upstream insists on (EOtF lacks
  `resources/fonts` and `game_data/credit`) load through a shim project under
  `$LT_ORACLE_HOME/shim/` that borrows them from `default.ltproj`; the run
  output lists what was borrowed under `shims`.
- **fork**: a project's own engine fork. EOtF players run one, so EOtF
  scenarios default to it. The fork is never copied into this repo: point
  `LT_FORK_ENGINE` at the fork's engine directory (the one holding `app/`,
  `sprites/`, `resources/`) and `LT_FORK_PYTHON` at an interpreter with its
  requirements, or put `fork_engine` / `fork_python` in
  `$LT_ORACLE_HOME/config.json` (outside the repo).

Both backends load the project from `lt-maker/<project>`, the same data the
web serves (`LT_ORACLE_PROJECT_DIR` overrides the Python side only; then the
two sides no longer run the same data).

### Setup

```bash
# upstream venv (pygame-ce 2.3.2 has a Python 3.12 wheel)
py -3.12 -m venv E:/BigData/lt-oracle/venv
E:/BigData/lt-oracle/venv/Scripts/python -m pip install pygame-ce==2.3.2 typing-extensions==4.8.0
# Chromium for the web side, once
npx playwright install chromium
```

| Variable | Default | Meaning |
|---|---|---|
| `LT_ORACLE_HOME` | `E:/BigData/lt-oracle` | run dirs, codegen overlay, shims, `config.json` |
| `LT_ORACLE_OUT` | `$LT_ORACLE_HOME/out` | raw run outputs |
| `LT_ORACLE_PYTHON` | `$LT_ORACLE_HOME/venv/Scripts/python.exe` | upstream interpreter |
| `LT_FORK_ENGINE`, `LT_FORK_PYTHON` | from `config.json` | fork engine dir and interpreter |
| `ORACLE_PORT` | `PLAYWRIGHT_PORT`, else 5190 | Vite port; a server already on it is reused, so use a port per worktree |
| `ORACLE_VITE_TIMEOUT_MS` | 300000 | how long to wait for Vite to transform the engine |

### How the Python side runs headless

`SDL_VIDEODRIVER=dummy`, `SDL_AUDIODRIVER=dummy`, volumes 0, and the engine
clock replaced by a frame counter (every update is exactly 1000/60 ms), so
timed states are deterministic. Asset-loading threads are joined before the
state that polls them. The engine is run from a scratch directory per process
(`$LT_ORACLE_HOME/run-<backend>-<n>`, junctions to the engine's read-only
folders plus an emptied `saves/`), because it reads and writes `saves/`
(config, persistent records, suspends) relative to the working directory.
Settings: `animation=Never` (map combat), `autoend_turn=0`, `confirm_end=0`,
`text_speed=0`, `mouse=0`, `debug=0`; the web side sets the same settings.
Input is injected through the engine's own input manager (one frame pressed,
one released), and the state machine is updated exactly like `driver.run`.
The web side gets the same frame clock: `performance.now()` advances 1000/60
ms per stepped frame (level-up, promotion and prep screens time themselves
with it), and a New Game reuses the scenario seed (`fixedRandomSeed`, like
Python's `random_seed` setting).

## Scenario schema

```jsonc
{
  "name": "default-combat-exp",       // output folder and report title
  "description": "...",
  "project": "default.ltproj",        // folder under lt-maker/
  "engine": "upstream",               // optional: "upstream" | "fork"
  "level": "DEBUG",
  "events": false,                    // false: trigger-based events never fire
                                      // (explicit "event" actions still run)
  "startup_events": true,             // run on_startup first, as the title screen does
  "seed": 0,                          // _random_seed for the combat/growth/other LCGs
  "rng_mode": "True Hit",             // RNGOption value (Classic, True Hit, True Hit Plus, Fates Hit, Grandmaster)
  "growths": "Fixed",                 // GrowthOption value (Random, Fixed, Dynamic)
  "include": "eotf-run-start",        // start from another scenario: its fields, setup and actions first
  "start_game_vars": {"Game_Level": 1}, // set right after build_new, before level events
  "start_records": {"Progress": 3},   // persistent records (RECORDS.replace) after on_startup
  "settings": {"autoend_turn": 1},    // config overrides, both sides
  "setup": [ ... ],                   // direct state edits after the level settles
  "actions": [ ... ],                 // one snapshot after each
  "ignore": ["units.*.ai"],           // extra non-comparable paths for this scenario
  "known_diffs": ["units.Eirika.hp"], // reported as (known), do not fail the run
  "run_state": "run-state/eotf-run.json", // captured run state loaded before the level (see Run states)
  "levels": ["0", "1"],               // level sweep instead of "level": one snapshot per level
  "through_prep": true,               // press Fight when a level settles in preparations
  "level_actions": [{"do": "end_turn"}] // sweep: actions run on every turn-based level after it starts
}
```

The difficulty mode is rebuilt with the scenario's `rng_mode`/`growths`
before the level builds, so generic autolevels use them too. Both default to
`True Hit` (Python's own default mode object pins it) and `Fixed`.

Start sequence on both sides: optional `on_startup` events, fresh game vars
holding the seed, the level load, then the real level-start states
(turn_change / phase_change / status_upkeep on Python, `enterStartedLevel` on
the web) settled to a resting state, with dialog advanced by SELECT.

### Setup ops

Applied through engine actions, not the UI. Unit ops can be combined in one
object.

| Op | Effect |
|---|---|
| `{"unit": "Eirika", "hp": 5}` | current HP |
| `"stats": {"STR": 10}` | base stats (HP refills to max unless `hp` is given) |
| `"growths": {...}`, `"level": 5`, `"exp": 95` | raw fields |
| `"items": ["Iron_Sword"]` | replace the inventory |
| `"add_items": [...]`, `"add_skills": [...]`, `"remove_skills": [...]` | |
| `"position": [x, y]` or `null` | warp / arrive / leave the map |
| `"team": "player"` | change team |
| `{"game_var": "Foo", "value": 1}`, `{"level_var": ...}` | variables |
| `{"kill": "Bone"}` | death action |

### Actions

Actions drive the real UI flow: the map cursor is placed on a tile, menus
are walked with UP/DOWN presses (so hover side effects such as auto-equip
run), and SELECT confirms. After each action the driver settles: it steps
frames until a resting state (`free`, `menu`, `move`, `free_roam`,
`prep_main`, the choice/targeting menus...) holds for three frames with no
pending state change or moving unit, pressing SELECT to advance dialog.

| Action | Flow |
|---|---|
| `{"do": "move", "unit": "Eirika", "to": [3, 7]}` | free -> select unit -> move -> select tile -> menu |
| `{"do": "wait", "unit": "Eirika"}` | `Wait` in the unit menu (moves in place first if needed) |
| `{"do": "attack", "unit": "Eirika", "target": "Bone" \| [x, y], "item": "Rapier"}` | `Attack` -> weapon -> target -> combat, settled |
| `{"do": "spell", "unit": "Moulder", "target": "Vanessa", "item": "Heal"}` | `Spells` -> spell -> target |
| `{"do": "use_item", "unit": "Eirika", "item": "Vulnerary", "option": "Use", "target": ...}` | `Item` -> item -> option |
| `{"do": "trade", "unit": "Vanessa", "with": "Moulder", "give": ["Javelin"], "take": ["Vulnerary"]}` | trade screen; each give/take lands in the first free slot |
| `{"do": "end_turn"}` | option menu `End`, runs the AI phases until player phase (or free roam, or a game over) |
| `{"do": "attack_or_wait", "unit": "Player"}` | attack the nearest valid target with the first weapon if the menu offers Attack, else Wait |
| `{"do": "event", "script": ["give_money;100", "..."]}` | inline event (also `"nid"` for a DB event, `"trigger"` for a trigger class) |
| `{"do": "choose", "option": "Fight"}` | pick an option in the top state's menu, including event `choice` menus (grids walked by rows, then columns; `value\|text` entries match on either part) |
| `{"do": "roam_talk", "target": "Keeper", "from": [x, y]}` | free roam: put the roam unit beside the target, inside the talk range, and SELECT |
| `{"do": "save_load", "states": ["free"]}` | suspend in each engine's own format and continue (Python: `game.save()` pickled and loaded as `save.load_game` does; web: `suspendGame` / `loadSuspend`); the report also lists anything an engine's own reload changed |
| `{"do": "press", "button": "START"}`, `{"do": "frames", "n": 30}`, `{"do": "settle"}` | raw control |

Every action accepts `max_frames`; `event` and `settle` accept `skip`
(the button used to advance dialog, default SELECT). A failing action records
its error and a snapshot, and stops the run.

Where the two UIs differ, the drivers adapt and say so in code: the web
targeting states keep their own target index (cycled with RIGHT) where
Python teleports the cursor; staves go through `item_targeting` on the web;
several trade partners are a menu on the web instead of map targeting.

## Snapshot schema

```jsonc
{
  "level", "turn", "phase", "state",      // top state name
  "stack",                                 // informational only
  "money",                                 // current party
  "units": { "<nid>": {
      "team", "party", "position", "dead", "hp", "max_hp", "level", "exp",
      "klass", "stats", "growth_points", "wexp",
      "items": [{"nid", "uses", "c_uses", "droppable"}],
      "equipped_weapon", "skills", "skill_data",
      "finished", "has_attacked", "has_traded", "has_moved",
      "ai", "ai_group", "traveler", "generic" } },
  "game_vars", "level_vars", "regions": [{"nid", "region_type", "position", "size", "sub_nid", "time_left", "only_once"}],
  "objective": {"simple", "win", "loss"},
  "music",                                 // song on top of the music stack
  "events",                                // queued/running event nids, in processing order
  "already_triggered",                     // only_once events used
  "rng": {"combat", "growth", "other"}     // LCG states; catches extra or missing rolls
}
```

## Non-comparable fields

`noncomparable.json` holds the rules, each with its reason:

- ignored: `frame`, `stack`, the web's RNG and bookkeeping game/level vars
  (`_combat_random_*`, `_growth_random_*`, `_other_random_*`,
  `_initial_turn_events_after_level_start`, `_turn1_upkeep_done`), the web's
  `game_vars.money` mirror, web skill-data bookkeeping (`positionStatus*`,
  `sourceType`, `sourceNid`, ability-item keys) and Python's
  `ability_item_uid`;
- a missing entry equals 0 in `stats`, `wexp`, `growth_points`;
- `null` equals `""` for `ai_group`;
- `skills` is compared as a multiset (`py-only` / `web-only` lists).

The report prints a diff at the step where it first appears or changes;
later steps only count it as persisting, and `(now equal)` marks one that
went away. `--full` prints everything, `--all` lists matching steps too.

## Scenarios and the current baseline

All scenarios run to completion on both sides, and all match.

| Group | Scenarios |
|---|---|
| default.ltproj starters | `default-*`: combat exp, level-up, AI phase, heal staff, trade, Vulnerary, event commands, statuses over turns, Prologue intro, event-built units |
| Level-up / promotion / class change | `default-growth-promotion` (upstream, Random), `eotf-growth-{fixed,random,dynamic}` (fork, seed 7): give_exp, autolevel_to, promote, change_class |
| Save/load round trip | `default-save-load`, `eotf-save-load`, `eotf-room-battle`: suspend and continue mid-level, then play on |
| EOtF run | `eotf-hub-start`, `eotf-run-start` (hub records, roam talk, Depart, sortie, stage room, prep, enemy phase), `eotf-room-battle` (on to defeat and back to the hub) |
| EOtF maps | `eotf-ex2-combat`, `eotf-ex2-ai-phase`, `eotf-room1-event-units` |

Known quirk both engines share: a load restarts the growth and "other" RNG
streams from the seed (Python saves only the combat stream), which the
report shows as `(… reload changed) rng.other`.

Matching so far: combat strike order, damage, weapon uses, exp and RNG in the
default and EOtF attacks; trade results; Vulnerary and Heal amounts and their
combat RNG draws; Wait and post-combat action flags (dead units included);
level-up HP; `gba_poison`, Stunned/Sleep unequipping and expiring at upkeep;
terrain statuses after event moves; inline
event commands (vars, money, items, HP, team, regions, movement, stats, exp,
wexp, unit removal); the EOtF Dragon AI phase; unit loading/deployment by
event in EOtF; unit construction (class skills, parties, generic wexp and
autolevels, promoted generics, the fork's starting growth points) for level
units, `load_unit` and `create_unit` (default-event-units, eotf-hub-start).

## EOtF under each engine

- **fork**: boots `lt-maker/eotf.ltproj` (project 2.0.1, the data the fork release ships) directly. The hub
  (`X`) runs its level_start events and settles into free roam; `EX_2`
  combat and AI phases run; event-loaded units can be fought on room maps.
- **upstream**: loads EOtF only through the shim (no `resources/fonts`, no
  `game_data/credit`), then runs the same scenarios.
- **both**: room levels (`0`, `1`, ...) started directly with their level
  events lack the run state the hub's run-start events create (`Floor`, item
  pools such as `irons`, the party) and stop in `Global_Level_Start` /
  `Generate_Enemies`, on the fork too. Reach real rooms through the hub
  instead: `"include": "eotf-run-start"` ends on turn 1 of a generated room
  after its enemy phase. For isolated maps use `"events": false` plus event
  scripts and setup, or seed variables with `start_game_vars`.

## Run states

Room levels need the state a real run builds before them. A run state is
captured once from a Python engine and loaded into both engines before each
level, so both start from the same documented state:

```
<fork python> -I tools/oracle/capture_run_state.py -o $LT_ORACLE_HOME/run-state/eotf-run.json
```

The capture boots the project, runs on_startup, starts the hub with its
events, triggers the hub keeper's run-start event, answers its menus (the
first units offered, then "Yes"), and lets the real level end carry the run
into the next level (`Act_1`). Once that level settles it writes JSON with
the game vars, persistent records, parties (money, convoy), spent only_once
events and the persistent units with their items and skills as the Python
engine saves them. Both drivers load it after `build_new`: units start off
the map without terrain statuses, as after a level end, and the uid counters
continue after the captured items and skills. The file is generated from the
project's data, so it stays outside the repo.

## Level sweeps

`node tools/oracle/level-sweep.mjs [sweep.json] [--levels=a,b] [--chunk=8]
[--workers=3]` starts every level (default `sweeps/eotf-level-sweep.json`:
all EOtF levels except DEBUG) from the run state on both engines, settles
through preparations to the first player phase, and diffs one snapshot per
level. Levels run in chunks (one Python process and one page per chunk,
`workers` chunks in parallel, about ten minutes for EOtF). It prints a
per-level table and writes `report.md` and `diffs.json` under
`$LT_ORACLE_OUT/<name>/`. Diffs on generic units' construction (stats, HP,
weapon experience, equipped weapon, growth points, party, class skills) are
counted in their own column, so level flow differences stand out.

`sweeps/eotf-first-turn.json` adds one full turn per level (end the turn,
AI phases, next upkeep); `sweeps/eotf-first-turn-act.json` first lets the
Player attack the nearest enemy in range (else wait). The table then shows
each step's result and how many diffs are new since the previous step.

## Writing a scenario

1. Pick a level and look at its units: `levels/<nid>.json` (split projects)
   or `game_data/levels.json`.
2. Prefer `"events": false` and explicit `event` scripts, unless the level's
   own events are what you are testing.
3. Run `npm run oracle -- <name>`; if a driver errors, the step's error says
   which state it was in. `-v` streams both engines' logs.
4. Put fields that differ for a documented reason in `known_diffs`, not
   `ignore`.
