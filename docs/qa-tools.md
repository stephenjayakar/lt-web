# QA tools: jump, fast mode and auto-play (EOtF)

Tools for testing the Embrace of the Fog port quickly. You can start anywhere
in a run, run the game many times faster than real time, and let a simple
policy play rooms, events and battles while every floor, warning and error is
logged.

They exist only on the **dev server** and in builds made with **`LT_QA=1`**.
`vite.config.ts` defines `__LT_QA__`: `true` for `vite` (serve) and
`LT_QA=1 vite build`, and `false` for `npm run build` and `npm run build:site`.
In a player build the `import('./qa/qa-tools')` in `main.ts` is dead code, so
Rollup emits no QA chunk. The settings override and the state-machine draw skip
also compile away. `?qa` on a player build does nothing beyond selecting local
storage.

To check that nothing leaks into a player build:

```bash
npx vite build --outDir E:/BigData/lt-web-cache/prodcheck --emptyOutDir
grep -l "__qa\|QA_Fighter\|installQa" E:/BigData/lt-web-cache/prodcheck/assets/*.js   # expect no match
```

## Quick start (CLI)

```bash
# Act 1 floors 1-5 (about 20-40 s of play)
npm run qa:run -- --floor 1 --floors 5 --seed 5

# Act 2 floor 16 with a promoted party of five, play 5 floors
npm run qa:run -- --act 2 --floor 16 --floors 5 --party Player,Gorbat,Pilus,Viran,Taag --promoted

# A boss or trial directly (the Act and floor are inferred), stop when it ends
npm run qa:run -- --level Bootes --one-level --party-level 14 --boost 6
npm run qa:run -- --level Fabien --one-level --boost 10

# Four seeds at once against one dev server
npm run qa:run -- --floor 1 --floors 5 --seed 11 --parallel 4
```

`scripts/qa-run.mjs` reuses a dev server that is already running on `--port`
(default `$PLAYWRIGHT_PORT`, else 5191). If none is running, it starts
`vite --port N --strictPort` and stops it again by PID when it finishes. It
launches headless Chromium with `--mute-audio` and a fresh browser context for
each run, so records and saves always start clean. The exit code is 0 only if
every run ends `ok`.

To run in parallel, use `--parallel N` (N browsers, seeds `seed..seed+N-1`,
one server), or start several `qa:run` processes. Give each process its own
`--port`, or point them all at one server with `--url http://127.0.0.1:5191`.
Each page keeps one CPU core busy, so on this machine 3-4 runs at a time is a
reasonable limit.

Run `npm run qa:run -- --help` for every option. The main ones:

| Option | Meaning |
|---|---|
| `--act N` / `--floor N` / `--alter` | Where the run starts. The floor is absolute (Act 2 starts at floor 16 at long game length). |
| `--level NID` | Enter this battle level from the Act map: a trial, boss or elite through the Act's own Talk_Room commands, any other map as a standard combat. |
| `--party LIST` | `Nid[:level][:P][:Class][:+Item+Item]`, comma separated. `P` promotes; a number after `P` or a class is the post-promotion level. |
| `--party-level N`, `--promoted` / `--no-promote` | Defaults: level `1 + 0.8 * floor`, promoted from Act 2 on. |
| `--money`, `--records k=v,...`, `--vars k=v,...`, `--game-speed`, `--density`, `--seed` | State and the game RNG seed. Values are parsed as JSON where possible. |
| `--boost N` | QA stat boost: `change_stats` +N to every stat (+2N HP) and a full heal. Off by default. |
| `--floors N` / `--to-floor N` / `--one-level` / `--no-play` | What to play. |
| `--max-turns N` (40), `--force-win` | Turn limit per battle map; `--force-win` runs `win_game` at the limit instead of stopping. |
| `--rooms random\|combat,event,shop,respite,elite` | Room policy. Boss and trial rooms are always taken. |
| `--choices random\|first`, `--services all\|none\|a,b`, `--shop buy\|leave`, `--policy-seed N` | Policy for event choices, sub-room NPCs and shop screens (default: buy one random item per shop). |
| `--fast N` (0) | Frames per real frame. 0 = as fast as possible, 1 = normal speed. |
| `--draw-every N` (16) | Render only every Nth frame. |
| `--map-combat`, `--no-skip`, `--verbose` | Map combat instead of battle animations; keep event dialogue; keep `console.log`. |
| `--out DIR`, `--label`, `--shots`, `--headed`, `--timeout SEC` | Reports and debugging. |

## Reports

Each run writes `<out>/<timestamp>-<label>-p<port>[-r<i>]/` (default out:
`E:/BigData/lt-web-playtest`) containing:

- `report.md`: a compact log with one table row per floor (rooms offered,
  room chosen, each battle with objective, result, turns, combat count,
  player deaths with their turn and enemy kills, story events, warning and
  error counts, real time), per-floor notes (choices made, NPCs visited,
  stuck recovery), the party at the end, and every warning and error
  (deduplicated with a count). Each warning carries its first context: floor,
  level, turn, phase, state stack and running event.
- `report.json`: the same data in full, plus the options and timings.
- `jump.png`, `final.png`, and `floor-N.png` with `--shots`.

The run result is `ok` (target reached), `defeat` (game over), `stuck`
(turn limit, or no progress after recovery attempts), `error` (the engine
threw on every frame) or `timeout`.

Warnings and errors are the port's `console.warn`/`console.error` (its
equivalent of Python's `logging.warning`/`logging.error`, including the
`Python evaluation error (Python-equivalent)` messages that Python would log
too), uncaught exceptions and unhandled rejections. `[qa]` entries are the
driver's own notes.

## What each part does

### Jump (`src/qa/qa-jump.ts`)

Builds the state through the project's own run setup instead of faking it:

1. Records for a returning player: every tutorial and intro "first time"
   record is set (pass `--tutorials` to keep them), `Progress` is 3, and the
   requested units go in `Available_Units`, plus `Sortie_Slot`, `Game_Speed`,
   density and any `--records`.
2. New Game through `TitleNewState.buildNewGame` (which also writes the start
   save). The hub's `0. Setup` loads the owned units and creates the per-run
   vars, item pools and gacha pools.
3. In the hub: an ad-hoc event applies the party (`autolevel_to`, `promote`,
   `give_item`, `change_stats` for `--boost`), money and vars. It sets `Floor`
   and `Game_Level` to their values one floor before the target, sets the next
   chapter to `Act_N`, then runs `trigger_script;X 8. Run_Start`. The sortie
   choice is answered with the requested units. Upgrades, tonics, the convoy,
   starting gold, the X `level_end` (`Global_Level_End` adds the last floor and
   `Game_Level` step) and the Act intro (room generation) all run for real. On
   an Act's boss floor, `subboss` is preset to the Act's first trial so the
   boss room appears.
4. `--level`: a trial, boss or elite runs the Act's Talk_Room block for that
   level (`in_combat`, `next_reward`, `subboss`, `set_next_chapter`,
   `skip_save`, `win_game`). Any other map runs Talk_Room's standard-combat
   commands. The jump returns at preparations or at the first player phase.

Typical jump time: 2-4 s, plus 1-8 s to boot the page.

### Fast mode (`src/qa/qa-tools.ts`, `qa-clock.ts`)

- QA pages boot frame-stepped like the harness: no rAF loop. The QA pump
  steps frames itself, up to 30 ms per macrotask, and then yields so asset
  loads can resolve. `speed` 0 is unlimited; N is N× real time.
- Virtual clock: `performance.now()`/`Date.now()` advance exactly one frame
  time per stepped frame, so the presentation timers that read the clock
  (portrait fades, level-up screens, prep fades) keep pace with the frames.
- `drawEvery`: intermediate frames run update logic but skip the draw pass
  and the blit (`qaDraw.skip` in `state-machine.ts`). Some presentation that Python
  also advances while drawing (sprite animation, combat effects) then takes
  more frames, but rules, RNG and outcomes are unchanged. The same seed gave
  identical floors, turns, combat counts and deaths at draw-every 1, 4, 8,
  16 and 32, and with map or animation combat.
- Events run in skip mode, as if START were pressed at the first line.
  Python's skip still stops at choices, which the policy answers. The driver
  dismisses held dialogue and alerts.
- Real player settings: fastest unit speed, instant text, no talk boops, no
  end-turn confirmation, volume 0. `combat: 'map'` pins the `animation`
  setting to Never. EOtF hides that setting; this changes presentation only.
- Runs are deterministic for a given `--seed` (the game RNG) and
  `--policy-seed` (the policy's own RNG, which never draws from the game's
  streams).

### Auto-play (`src/qa/qa-driver.ts`, `qa-policy.ts`)

On every frame the driver answers whatever the game is waiting for, through
normal inputs and engine paths:

- Act map: it reads the offered rooms (`room1..room4` level vars and
  rewards), picks one by policy, places the roam unit next to that room's NPC
  and presses SELECT. This is the real `on_talk`; only the walk is skipped.
- Shop and camp sub-rooms, and Act 4's service floors: it talks to each NPC
  once, then takes the exit. In a shop screen the `buy` policy opens Buy,
  presses SELECT on one random item (a purchase that fails for lack of money
  or space is fine) and leaves. The `leave` policy backs straight out.
- Choices: fixed `answers` by choice nid first, then the sortie plan. "Yes"
  for begin, enter, proceed, heal and similar prompts; "No" or BACK for
  abandon or quit prompts. Anything else is picked at random from the seeded
  policy RNG. A choice repeated more than `repeatLimit` times on one level is
  left through BACK or its leave option.
- Preparations: Fight. The between-chapter save prompt: BACK (continue
  without saving).
- Player phase: every unfinished player unit gets a QA AI preset
  (`QA_Fighter`, or `QA_Healer` for units with a healing item), and the
  engine's own `AIState` plays the phase, so movement, combat, canto, events
  and actions all go through the real code paths. The presets are registered
  in `db.ai` at boot. They attack anything reachable this turn and hold for
  the first 3 turns, then go for objective regions (Seize, Arrive, Escape,
  Defuse, Visit, Key Point, Switch) and pursue. Healers heal first. The
  units' own AI values are restored when the phase ends.
- Stuck detection: if the state stack, event pointer, turn and unit
  positions and HP stay unchanged for 3600 frames and 10 s, the driver presses
  BACK, then SELECT, then START, and then stops the run as `stuck`.

The AI is simple. It loses starting-level parties regularly and does not
handle objectives such as breaking a gate. Use `--boost` and `--force-win`
when the aim is to reach content rather than to test balance.

## In-page API (`window.__qa`)

Open `/?qa&project=eotf.ltproj&bundle=false` on the dev server (`?qa=16`
also turns fast mode on at boot), then:

```js
__qa.setFast({ speed: 0, skipEvents: true, drawEvery: 16, combat: 'map', quietLog: true });
await __qa.jump({ act: 2, floor: 16, party: ['Player', 'Gorbat', { nid: 'Pilus', level: 12, promote: true, items: ['Heal'] }], seed: 5 });
__qa.play({ floors: 3, maxTurns: 40, policy: { seed: 5, rooms: ['Combat'] } });
__qa.status();   // { phase, result, reason, level, floor, turn, state, fps, warnings, errors, ... }
__qa.report();   // floors, log, party, options
__qa.runScript(['give_money;5000;Player', 'game_var;Floor;20']);   // ad-hoc event commands
__qa.step(60, 'SELECT');                                          // step frames by hand
__qa.game;                                                        // the GameState
```

`tests/qa-tools.spec.ts` covers the Act 2 floor 16 jump and an auto-played
floor 1.
