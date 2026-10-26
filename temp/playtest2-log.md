# EOtF playtest 2 log (qa/playtest-2)

Setup: Windows 10, dist built to E:/BigData/lt-web-cache/pt2-dist with a
throwaway Vite config (temp/pt2, not committed) that exposes the game state in
control mode; static server on 5194; Playwright Chromium (muted, headless)
driven by a local command server on 5195. Fresh browser profile.

## Environment notes

- The shared bundle E:/BigData/lt-web-cache/bundles/eotf.ltproj.zip (junctioned
  as public/bundles in lt-web and this worktree) was built before 9e93d83 and
  still has `\`-separated entry names, so a build that copies it boots with no
  data. Rebuilt the bundle into the playtest dist with the fixed script.
- A static dist also needs public/game-data (engine sprites, default.ltproj
  fonts, fork-sprites); the dev server serves /game-data from lt-maker/.

## Progress

- Fresh profile: title -> New Game (single slot, title_mode auto-skips) ->
  intro -> hub. Summoning portal: 3 normal summons (Tinola, Taag, Moudrost),
  not-enough-currency alert, Help topics. Trace (Hero) upgrade grid (bottom_left
  alignment verified), Keeper -> Game Length kept at long (Game_Speed 1),
  sortie with all 4 units, save at "Safe Location", Load Game from title.
- Act 1 F1: rooms were missing (bug 1); after the fix, three combat nodes;
  took the Monk node (reward Essence), prep -> Fight on map 91 (Arrive).
- Map 91: option menu screens (Objective, Codex, Gallery, Stratagems), Suspend
  (bug 4), prep Save + Load Game, turnwheel enabled via `_turnwheel` (EOtF
  never sets it outside DEBUG) and rewound turn 2 -> turn 1 start (bug 5),
  confirmed, replayed; won (Arrive) on turn 10; accessory/reward choice.
- F2 camp: Fragile Memory summon (Brad), healer. Suspend from roam -> Continue
  on a rebuilt dist. F3 shop node: strategist (Mighty Mobility), armory buy,
  trainer EXP, general store (not enough money), AUX unit management (trade,
  Give all, Items/convoy tabs). F4 event (blacksmith, Steel weapons).
  F5 Mage node: prep Pick Units (Taag out, Brad in), Optimize All, Seize map
  68 won. F6 event (sculpture prayer: heal + max HP down). F7 Soldier node:
  Controls page rebind INFO -> I (Invalid Choice! for a bound key), I opened
  the info menu and C did not; map 8 "Destruction": lord died turn 5, then the
  whole party -> "You have been defeated" -> GAME OVER -> title (save slot
  cleared, only New Game/Extras). Run currencies banked to RECORDS (Essence
  50, Flame 20, Fragments 35).
- Base systems (hub after the loss; currencies and unlock records granted via
  RECORDS to reach locked content): Architect upgrades (not-enough alert,
  Bonus Units, Promotion/Revival Magic, Free Accessory, Sortie Slot, Tonic
  Maker -> Alchemist appears, Mending tonic), Spiritmaster (EXP Gain Up level
  1 -> cost 150), Lorekeeper, Records desk (Records, password entry ->
  HETJASQUEST recruits Hetja after bug 6, Reminisce), Music room (hub track),
  Difficulty NPC (Fatigue on/off, density 0/1, Check Rewards), Bar (tether
  intro), tether talk with Tinola, wardrobe skill swap (Patchwork Player ->
  Taag), sparking summon (dex INFO on the choice, Brad), Trace promotion
  upgrade with Master Seals, Controls Restore Defaults.
- Run 2 (long): Bonus Units sortie with 5 slots (Hetja bonus), free accessory,
  F1 Strategist map 26 (Double Time), F2 event (play), F3 camp (Promotion
  Magic: Moudrost -> Basara, Recall Taag), F4 Mage map 1 (planner stalled on a
  cliff map; engine-AI fallback), F5 event (wagon loot), F6 shop (Power
  Armory page vendor letter, general store, trainer), F7 sculpture heal,
  F8 Seize map 67 (Hetja and Moudrost died), F9-10 events (strongmen,
  declined duel), F11 Arrive map 60: wiped once, reloaded the prep save,
  Formation swap, boosted stats via eval for coverage, won; F12 camp
  (Revival Magic: Moudrost, Fragile Memory: Milly), F13 map 41, F14 healer
  + trial "The Wolf" (escort): Loreia died -> second GAME OVER (Global_Loss
  delete_save;0 / suspend, matches the data).

## Bugs

1. FIXED f872105 - no floor rooms in any Act: `{e:'room' + '{v:counter}' + '_reward'}`
   raised TypeError under the Python evaluator because a quoted `{v:}` inside
   `{e:}` became a typed literal (int 1, quotes dropped). Python substitutes the
   var text inside the quotes. (`tests/event-choice-bg.spec.ts`)
2. FIXED 4701a90 - weapons without a `hit` component (Vortex, Spark, Ragnarok,
   20 EOtF weapons) forecast 0-11% hit and the AI treated them as useless;
   Python compute_hit returns 10000 (always hit). (`tests/fork-combat-math.spec.ts`)
3. FIXED e8fd25a - Objective/Options/Guide and custom option events (Codex,
   Gallery, Stratagems) popped the option menu, so closing them returned to the
   map; Python keeps the option menu beneath (transition_to pops only itself).
   (`tests/event-commands-3.spec.ts`)
4. FIXED a6ae576 - Suspend on map 91 failed ("Failed to suspend game") and
   dumped to the title, losing the mid-map state: authored region Fake_Arrive
   has position None and serializeLevel read position[0].
   (`tests/event-region-save.spec.ts`)
5. FIXED f3e2be7 - the turnwheel could not restore the turn number: turning
   back into turn 1 still showed/kept "Turn 2" (Python logs IncrementTurn as
   an action). Also a loaded mid-map save rebuilt the phase controller at 1
   and copied that back at the next wrap, resetting the turn counter.
   (`tests/turnwheel-breadth.spec.ts`)
6. FIXED e802eab - reopening a text_entry (desk password) left the previous
   keydown listener attached (web pops call finish(), not end()): typed keys
   landed once per stale listener and Enter's keyboard-mode toggle cancelled
   out on even counts. (`tests/event-commands-3.spec.ts`)

## Minor / not fixed

- `RECORDS.get('Bonus_Units') and len({v:bonus_units}) > 0` and
  `u('Libra_P').party` warnings in sortie/Run_Start: Python logs the same
  errors ({v:} missing -> '??' SyntaxError; u() None) - content, not port.
- Info menu Items page shows Hit 13 for Vortex (no hit component). Python
  upstream prints `str(None)`; the fork's page is unknown here, so left as is.
- `console.warn('VICTORY — seize condition met')` / `GAME OVER — loss
  condition met` are debug logs at warning level (noise only).
- Turnwheel is unreachable in normal EOtF play (`_turnwheel` only set by the
  DEBUG level), same as Python.
