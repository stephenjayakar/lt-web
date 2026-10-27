# EOtF playtest log (qa/playtest-win)

Setup: Windows 10, static server on 5184 serving a dist built to E: (C: was full),
Playwright Chromium (muted, headless) driven over a local command server.

## Progress

- Fresh profile, title -> New Game -> intro -> hub (Safe Location): Keeper,
  summoning portal (3 normal summons: Gorbat, Pilus, Viran), Records desk,
  Lorekeeper, Game Length -> Short, sortie party select.
- Enemy Tactics / Dense Fog are post-clear (Difficulty NPC) and not available
  on a fresh profile; playing the default difficulty.
- Act 1 F1: combat node (prep: save, options, fight; 3 turns, rout), rewards
  (War Banner, Blacksmith Soul). F2: rest site (heal, Fragile Memory summon:
  Roxl). F3: shops (armory buy, stratagem Dusk Looms), unit management via AUX,
  suspend + resume on a new build.
- Run 1 lost on Act 1 F5 (defend map: the green citizen died). Defeat flow,
  currency summary, save deletion and New Game back to the hub all worked.
- Run 2 lost on Act 1 F1 (driver bug in my tactical planner).
- Run 3 lost on Act 1 F9 (Adrius trial; 16 enemies vs 4 level-3 units).
  Exercised: arrive/seize/rout maps, prep save + reload of the same battle
  (deterministic replays), trade (map + prep), unit management, Optimize,
  per-unit Optimize, camps (heal, Fragile Memory, Recall), events, shops,
  stratagem purchase, rewards.
- Hub after runs: Trace/Arc/Spi NPCs appear; Essence menu; passwords
  HETJASQUEST / ILLUSION / PASSWORD123 via the text-entry grid (Hetja,
  Arrielle, Eve joined); portal summon (Inyx).
- Run 4: from Act 1 F2 on, a QA-only debug boost (temp/boost.js: raise party
  stats to ~60 HP / 18-22 offence and defence, applied through the page) so a
  scripted planner can reach the later acts; combats, AI and events still run
  normally. Run 4 cleared Act 1 (Adrius trial, Bootes boss) and reached the
  Act 2 F19 trial "Coalition" (13-turn limit), lost on the time limit.
- Run 5 lost on Act 1 F8 (defend map: citizen died). Run 6 cleared Act 1 again
  and Act 2 F11-F18 (arrive, visit-villages, destroy-monuments maps), lost the
  Coalition trial on its turn limit again. Bar/Spirit Tether intro and a tether
  talk at the hub table worked.
- Run 7 (stronger boost, skipping the Coalition trial) reached Act 1 F8 when
  the playtest was stopped on request. Furthest floor overall: Act 2 F19.
  The Act 3 floor-29 Grigol trial was not reached.

## Summary

Eight bugs fixed (below). The scripted runs exercised hub systems, every Act 1
and Act 2 node type seen (combat incl. rout/arrive/seize/defend/visit/destroy
maps, events, shops, camps, trials, the Bootes boss), prep save/reload,
suspend/resume, defeat flow and New Game with persistent records. No console
errors from the current build beyond the authored-data warnings listed below.

## Bugs

1. FIXED 9e93d83 — `npm run bundle` on Windows wrote `\`-separated zip entry
   names; the bundle loaded but every lookup missed, so the game booted with no
   data. (`tests/bundle-assets.spec.ts`)
2. FIXED db03db6 — case-only filename mismatches (portraits Bishop, Haryld,
   Vance, Nikolas, Datura, Kolbane(+_promo); panorama `bedroom` -> Bedroom.png)
   were missing in the web build. Python on Windows resolves them; AssetBundle
   and hosted packs now fall back to a case-insensitive match.

3. FIXED 24a0b5b — prep screen drew the calling event's held black transition
   over the map (EOtF chapters reach `prep;t` transitioned out), so the prep
   menu sat on a black screen. Prep map states now draw only the map beneath
   them, as Python MapStates. (`tests/prep-screens.spec.ts`)
4. FIXED e091ef1 — free roam drew no TALK/interact markers (hub NPCs, floor
   node tents/wagons). (`tests/roam-overworld.spec.ts`)
5. FIXED 7095278 — roam INFO/AUX/START and region interrupts carried no level,
   so EOtF's level-scoped Run_Info / Unit_Info (unit management) never fired on
   act maps; AUX opened the option menu instead. (`tests/roam-overworld.spec.ts`)
6. FIXED dc0e8f8 — store/trade/convoy actions did not unequip the item leaving
   the inventory; "Give all" left Gorbat with Killer Helm equipped from the
   convoy. (`tests/item-unequip.spec.ts`)

7. FIXED d436dc8 — with the new Python evaluator, a quoted `{v:}` inside `{e:}`
   lost its quotes (`'room' + '{v:counter}'` -> `'room' + 1`, TypeError), so
   the Act intro never set room rewards. (`tests/qa-playtest.spec.ts`)
8. FIXED 1c72a70 — MoveState ignored SELECT on the unit's own tile when it had
   no valid moves (EOtF Chains of Thanatos leaves neighbours at MOV -99), so
   the unit could not even Wait. (`tests/movement-parity.spec.ts`)

## Open findings (not fixed) with repro

- Prep: once, while a script selected Fight in prep_main, Pick Units opened
  instead and later Enters toggled the Lord out of the deployment (level 53,
  Act 1 F6). Not reproduced; likely input timing in my driver, but worth a
  look if prep_main can accept SELECT before its menu is ready.
- Text entry (hub desk -> Enter Password): Enter toggles a web-only
  keyboard-typing mode instead of acting as SELECT (Z works). Deliberate web
  convenience, but it differs from Python's grid-only entry.
- Headless Chromium logs `[Perf] Long frame` 50-90 ms (update, not draw)
  during combat animations. Repro: any battle in a headless Playwright run.
- Save failure `Cannot read properties of null (reading '0')` on level 91
  (Fake_Arrive region with no position) was seen once on the pre-merge build;
  current eotf already serializes position-less regions.

## Minor / not fixed

- `combat_palettes/palette_data/.orderkeys` lists "New Palette", "New Palette (1)"
  but files are New_Palette*.json (Python loads every *.json in the dir). The web
  loader fetches by orderkey so those two palettes are skipped. No combat anim
  references them, so no visible effect.
- `Event change_portrait: invalid unit or portrait (Griselda;Griselda)` warns on
  every chapter start (Ability_Bloodforce runs for an absent Griselda); Python
  logs the same error, no visible effect.
- The EOtF fork HUD shows generic enemies as "<Class> <Level>" (ported from the
  fork), while the combat banner shows their name ("Phantom").
- Headless Chromium (no GPU) logs `[Perf] Long frame` 50-90 ms in combat
  update; environment-dependent, not investigated.
- RESOLVED by the merged py-expr evaluator (eotf 623cf7b): hub `X` event "b. The Table":
  `level_var;friend_pos;[(25,7),(23,5),(27,4),(23,12),(27,14)]` stores
  `[7,5,4,12,14]` (each tuple evaluates as a comma expression -> last value).
  The following `add_unit;{v:add_friend};{e:{v:friend_pos}[{friendos}]}` then
  gets position `7` and warns `add_unit: no valid position for "Gorbat"/"Viran"`,
  so owned units never sit at the hub table (no tether talks there).
- Hub Essence menu: the expression textbox is evaluated once before the choice
  sets `Run_Choice_choice_hover`, logging `EventCondition JS eval failed for
  "int(?? * (?? ** RECORDS.get(null + '_level')))"`; the next frame renders
  correctly. Python would also fail that first evaluation (logs an error).
- Unit management "Optimize All" from an act node map strips every party unit
  except the roam lord (Python `convoy_funcs.optimize_all` only re-arms units
  with a map position). Matches Python; noted as a trap, not a port bug.
