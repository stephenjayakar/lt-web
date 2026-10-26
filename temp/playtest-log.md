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
- EXPRESSION (not fixed, py-expr branch): hub `X` event "b. The Table":
  `level_var;friend_pos;[(25,7),(23,5),(27,4),(23,12),(27,14)]` stores
  `[7,5,4,12,14]` (each tuple evaluates as a comma expression -> last value).
  The following `add_unit;{v:add_friend};{e:{v:friend_pos}[{friendos}]}` then
  gets position `7` and warns `add_unit: no valid position for "Gorbat"/"Viran"`,
  so owned units never sit at the hub table (no tether talks there).
- Hub Essence menu: the expression textbox is evaluated once before the choice
  sets `Run_Choice_choice_hover`, logging `EventCondition JS eval failed for
  "int(?? * (?? ** RECORDS.get(null + '_level')))"`; the next frame renders
  correctly. Python would also fail that first evaluation (logs an error).
