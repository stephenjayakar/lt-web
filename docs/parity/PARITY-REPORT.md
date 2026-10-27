# Runtime Parity Report: Lex Talionis Web Engine

**Report Date:** 2026-10-26
**Evidence window:** Historical baseline 2026-07-19; completion refresh 2026-07-23; EOtF sweep 2026-10-26
**Report Type:** Published (P7 complete; P8 EOtF release gate)

This report is regenerable at any time via `npm run audit:parity` and `npm run build` using the instructions in the "How to Regenerate This Report" section.

---

## Current Completion Refresh (2026-10-26)

- Event parser and dispatcher coverage: **255/255** Python command NIDs.
- Components: **180/201** item and **192/241** skill NIDs referenced; matching
  hook surfaces cover **110/201** item and **93/241** skill NIDs. Every one of
  EOtF's 185 item and 270 skill component NIDs is verified
  (`docs/parity/eotf-compat.md`, zero unverified).
- Triggers: all **41** Python trigger NIDs are referenced; 38 are dispatched.
  `preview` and the `unlock_staff` trigger are upstream-only (absent from
  EOtF's fork) and `level_select` fires only from the overworld, which EOtF
  does not use.
- Runtime states: **113** Python states classified as **65 exact** and
  **48 documented mergers**, with **0 open flows** (`docs/parity/states.md`).
- Runtime source: **151 TypeScript files / 103,871 lines**.
- Browser suite: **1103 tests in 184 spec files**.

Generated files under `docs/parity/` remain authoritative when these narrative
figures age.

---

## Parity Contract (In Scope)

### In Scope
- Runtime loading and execution of supported `.ltproj` projects
- Database/resource formats, runtime objects, actions, saves, and turnwheel
- State-machine flows, events (EVNT and PYEV1), queries, and triggers
- Item and skill component behavior used by runtime projects
- Movement, pathfinding, combat, AI, supports, fog, initiative, roam, and overworld
- Player-facing rendering, animation, audio, menus, settings, and input
- Browser-specific distribution features, provided they do not change game behavior

### Out of Scope
- The Qt project editor and its editor-only validation/authoring UI
- Python packaging, launcher, and desktop-only developer tooling
- Pixel-identical behavior where browser platform constraints make it impossible;
  any accepted deviation must be documented and covered by a behavioral test

---

## Evidence Baseline (2026-07-19, historical)

The inventory when the report was first published (see the current refresh above):

| Domain | Python Reference | Web Implementation | Source |
|--------|-----------------|------------------|--------|
| Event command NIDs | 255 total | 211 recognized; 202 dispatched | `npm run audit:parity` |
| Item component NIDs | 201 total | 135 exact references; 92 with hook surfaces | `npm run audit:parity` |
| Skill component NIDs | 241 total | 84 exact references; 67 with hook surfaces | `npm run audit:parity` |
| Registered runtime states | (broad catalog) | 53 web states | `npm run audit:parity` |
| TypeScript runtime | n/a | 100 files, 60,159 lines | `npm run build` output |
| Browser regression suite | n/a | 40 spec files, 368 tests | `npx playwright test --reporter=json` |

**Note:** Counts are inventories, not equivalence percentages. One generated hook can cover many components; one switch case can still omit flags or blocking behavior.

---

## Verified Domains

Domains with current inventory counts, verification method, and specification references:

| Domain | Count (Web) | Reference (Python) | Verification Method | Spec File | Status |
|--------|----------:|---------------:|---|---|---|
| Event commands (dispatched) | 255/255 | 255 nids | Structural audit + golden tests | `src/events/event-manager.ts` + `tests/command-flags.spec.ts`, `tests/event-commands-2.spec.ts`, `tests/event-flow.spec.ts` | Implemented |
| Event commands (parser recognized) | 255/255 | 255 nids | Parser inventory | `src/events/event-manager.ts` | Implemented |
| Item components (referenced) | 180/201 | 201 nids | Exact string match audit | `docs/parity/item-components.md` | All EOtF NIDs verified |
| Item components (hook surfaces) | 110/201 | 201 nids | Hook dispatch audit | `src/combat/item-system.ts` | Inventory only |
| Skill components (referenced) | 192/241 | 241 nids | Exact string match audit | `docs/parity/skill-components.md` | All EOtF NIDs verified |
| Skill components (hook surfaces) | 93/241 | 241 nids | Hook dispatch audit | `src/combat/skill-system.ts` | Inventory only |
| Triggers (dispatched) | 38/41 | 41 constant nids | Trigger dispatch audit | `docs/parity/runtime-inventory.md §1` | Remaining 3 unreachable in EOtF |
| Query functions | 21/21 | 21 public methods | Behavioral equivalence | `src/engine/query-engine.ts` | Implemented |
| Save fields | all, including `action_log` (save 1.1.0); a few representation differences | Python `game_state.save` | Serialization audit + `tests/turnwheel-save-restore.spec.ts` | `docs/parity/runtime-inventory.md §4` (status banner) | Implemented |
| Equations | 32 nids | 32 nids | Evaluator + golden regression | `src/combat/combat-calcs.ts` + `tests/equation-parity.spec.ts` | Implemented |
| Combat mode RNG | 5 modes | 5 modes | Deterministic replay + turnwheel | `tests/rng-replay.spec.ts` + `tests/combat-goldens.spec.ts` | Verified |
| Turnwheel actions | 40+ reversible classes | Python `action.py` | Action round-trip tests | `src/engine/action.ts` + `tests/turnwheel-breadth.spec.ts` | Verified |
| Movement/pathfinding | A*, Dijkstra range, LOS, canto | Python `pathfinding.py` | Golden scenario tests | `tests/pathfinding-movement.spec.ts` | Verified |
| Combat mechanics | strike order, playback, EXP/WEXP, death | Python `solver.py`, `simple_combat.py` | Golden scenario matrix | `tests/combat-goldens.spec.ts` | Verified |
| AI targeting | terrain, faction/party, group-active | Python `ai_controller.py` | Behavioral + edge-case tests | `tests/ai-parity.spec.ts` | Verified |
| Audio system | music stack, phase/battle override, SFX, settings | Python `sound.py`, `phase.py` | Call-recording assertions | `tests/audio-parity.spec.ts` | Verified |
| Portrait/dialog | blink timing, mouth animation, expression, text layout, transitions | Python `event_portrait.py`, `dialog.py`, `transitions.py` | Direct constant verification + harness tests | `tests/dialog-portrait.spec.ts` | Verified |
| Rendering/animation | tile layers, autotiles, weather, fog, camera, unit markers, battle assets/fallback | Python map and combat rendering | Visual regression + structural tests | `tests/rendering-parity.spec.ts`, `tests/combat-animation-fallback.spec.ts` | Verified |
| Component resolve policies | all/any/sum/unique/default semantics | Python `compile_item_system.py`, `compile_skill_system.py` | Direct dispatch function tests | `tests/resolve-policies.spec.ts` | Verified |
| Save/load round-trip | unit, item, skill, party, support, fog, achievement persistence | Python `game_state.py`, `save.py` | Full-chain integration tests | `tests/skill-identity-save.spec.ts`, `tests/event-region-save.spec.ts`, `tests/save-fields.spec.ts` | Verified |

---

## Browser Visual Tolerances

Deterministic map baselines allow a maximum 2% differing-pixel ratio. They cover
autotile frames, layer fades, a weather overlay, and camera positioning at a
fixed 480x320 browser viewport. Combat baselines use a stricter 1% ratio on the
canvas and cover both resource-backed battle animation and the missing-animation
map-sprite fallback. These tolerances absorb platform rasterization differences
while still failing on displaced UI, missing sprites, incorrect layers, or broad
palette changes.

---

## Accepted Deviations Registry

Deviations from Python behaviour that remain, plus the entries this registry
used to carry and how they were closed. "EOtF" says whether Embrace of the Fog
can reach the difference.

| Deviation | Area | Reason | EOtF | Status |
|-----------|------|--------|------|--------|
| Fonts fall back to `default.ltproj` when a project ships none | Resources | Lex Talionis keeps fonts at engine level; a browser has no engine install | Yes (EOtF ships no fonts) | Documented (`README.md`) |
| `resources/tilesets/tileset.json` probe when `tilesets.json` is absent | Resources | Python globs the directory; a browser cannot | Yes | Documented (`README.md`) |
| Keyboard rebinding keeps the web's extra default aliases and adds Restore Defaults | Settings | A browser player cannot delete `saves/config.ini` | Yes | Documented (`README.md`) |
| Per-unit level-cap modifier survives save/load | Save | The fork forgets it on reload (fork bug) | Yes | Deliberate (`temp/plan-fork-diff.md`) |
| Subtractive blends (`blend2`, `map_hit_sub_blend`) draw with canvas `difference` | Rendering | Canvas has no `BLEND_RGB_SUB`; `difference` matches whenever the destination is brighter | No (0 uses) | Documented |
| Turnwheel history after a reload | Save | FIXED 2026-10-26: saves carry the action log (Python Action.save/restore: units by nid, items/skills by uid, by value once out of play), so a suspend or save keeps the turnwheel history; pre-1.1.0 saves load with an empty log (`tests/turnwheel-save-restore.spec.ts`) | Yes | Fixed |
| Mutual kill: droppable items are not handed to the dying killer | Combat | Python gives them to a unit that is dying, so the item is lost either way; only the banner differs | Rare | Documented |
| Initiative bar draws team chips, not chibis | UI | Chibi art is not guaranteed per unit | No (`initiative` off) | Documented |
| Movement arrows | Rendering | FIXED 2026-10-26: constant 0.9 alpha; the pulse/tint only with `translucent_unit_sprite` (`tests/map-ui.spec.ts`) | Yes | Fixed |
| `item_icon_flash` and effective-weapon icon flash | Combat UI | FIXED 2026-10-26: `item_icon_mod` make_white on forecast, spell and battle item icons (`tests/item-icon-flash.spec.ts`) | Yes (154 + 7 + 2 items) | Fixed |
| Target markers for effective weapons and the fork's `eval_warning` | Map UI | FIXED 2026-10-26: `target_icon` danger/warning markers over all multi-item leaves | Yes | Fixed |
| `text_color` | Item UI | FIXED 2026-10-26: the fork honours the colour in menus and banners (`tests/fork-text-color.spec.ts`) | Yes (2 items) | Fixed |
| Map footsteps | Audio | FIXED 2026-10-26: `UnitSound` loops on path moves and in free roam (`tests/unit-footsteps.spec.ts`) | Yes | Fixed |
| Free-roam movement, rationalize slide, roam AI | Roam | FIXED 2026-10-26: fork physics, ally pass-through, wall corrections, 6 tiles/s rationalize, FreeRoamAIHandler with ThetaStar (`tests/roam-movement.spec.ts`) | Yes (hub, secret follower) | Fixed |
| Battle music push/pop | Audio | FIXED: channel-pair crossfade (`src/audio/music-controller.ts`, `tests/audio-parity.spec.ts`) | Yes | Fixed |
| Portrait fades not blocking | Events | FIXED: `add_portrait`/`remove_portrait` block unless `no_block`/`immediate` | Yes | Fixed |
| Cursor jumps instead of panning | Camera | FIXED: `move_cursor`/`center_cursor` pan and wait unless `immediate`/`no_block` | Yes | Fixed |
| Item cast pose | Combat animation | FIXED: `map_cast_pose` holds the caster instead of lunging | No (0 uses) | Fixed |
| Supply menu as a flat list | UI | FIXED: Python convoy tabs and sort order | Yes | Fixed |
| Promotion fanfare as a choice menu | UI | FIXED 2026-10-26: promotion/class-change screens port promotion.py (`tests/eotf-promotion-screens.spec.ts`) | Yes | Fixed |
| Doubling not re-evaluated mid-combat | Combat | FIXED: phases are solved as the presentation reaches them (`CombatPhaseSolver`), with doubling checked each phase | Yes | Fixed |
| Per-strike combat events after the last strike | Combat events | FIXED 2026-10-26 (`tests/combat-strike-events.spec.ts`) | Yes | Fixed |
| Glancing hits, `//` in equations, `INITIATIVE` lookup, phase music, no-banner flags, UNIQUE policy, roam talk distance, roam region fallback, roam press triggers, PYEV1 game context | Various | FIXED 2026-07-18/19 | — | Fixed |

### EOtF engine-version notes

EOtF d9d2975's `metadata.json` (`"version": "2.0.0"`, 2026-07-25) is the game's
own release number, written by a private lt-maker fork in the pre-2024-09
metadata format (upstream switched to `engine_version` in `8206fbc07`). The fork
branched from upstream between mid-June and early September 2024 and adds
commands no upstream release has (`heal`, `change_global_level_cap`,
`change_unit_level_cap`, `unload_unit`, `show_pokedex`, `return`, and
`change_class`'s `no_wexp` flag). The reference `lt-maker/` is upstream
`b811e266` (VERSION `2026.02.17a`, cloned 2026-02-21). Where the two disagree the
web follows what EOtF's engine does.

The fork's v1.90 build source (`VERSION = "1.9.5"`, 581 `.py` files) is closest to
upstream `5078af9f` (2024-02-04): 377 files are byte-identical. A systematic
three-way diff (base→fork, base→upstream, upstream→fork) of `app/engine`,
`app/events`, `app/data` and `app/utilities` is in `temp/plan-fork-diff.md`, with
every behavioural difference classified and checked against EOtF data. Fixes that
follow fork-specific behaviour check `isForkEngine()`
(`src/engine/engine-flavor.ts`: the project's `metadata.json` names `EotF`), so
other projects keep upstream behaviour; places where both Python engines agree and
the web followed neither are fixed for every project.

| Behaviour | Reference (`2026.02.17a`) | EOtF's engine | Web |
|---|---|---|---|
| `heal`, `change_class ...;no_wexp`, level-cap and `unload_unit` commands | absent (parse errors) | fork-only commands | implemented from EOtF usage; `no_wexp` skips the class's starting wexp |
| Unit dex (`show_pokedex`, `type_dex_unit` choice INFO, prep/base manage AUX, `game.is_favorited`) | absent | `base_info_menu` (`info_menu/base_copy_info_menu.py`); favourites are `__is_favorited__<nid>__` records | `src/engine/states/dex-menu-state.ts`, ported from the v1.90 build's source; fork-only sprites (unit select glow/bar, type icons) ship in `public/fork-sprites/`. No fade transitions, like the web's other full-screen menus |
| `has_finished` | no-op: `action.Wait` lost in `0623423e7` (2026-01-24), restored in `8a5e12750` (2026-03-24) | 2024 base waits the unit | `WaitAction` |
| `push` placement | occupant's own tile counts as open (`da99faa2d`, 2025-12), so units stack; fixed upstream in `0f96fd6f6` (2026-10-23, `can_stay=False`) | 2024 base pushes the occupant | nearest open tile without the occupant's own, then a forced move |
| `closest` placement | `get_closest_reachable_tile`: needs a path from the unit, and its own tile counts as open (`da99faa2d`, 2025-12) | `get_nearest_open_tile`: no path check, the unit's own tile is occupied (v1.90 `app/events/event.py`) | EOtF's behaviour |
| End of combat | `clean_up0/1/2`: `combat_death`, then the exp pause, then UnitDeath, end_combat hooks, CombatEnd | one `clean_up()`: no `combat_death`, no `unit_weapon_rank_up`; EventStates run broken items → unit_death → dying fade → end_combat hook events → map exp screen → item gain → combat_end | EOtF's order (`tests/fork-combat-cleanup.spec.ts`); strike events still run between phases |
| Combat formula precedence | skill override > item override > skill alternate > item alternate | item formula (`magic`, `alternate_*`, `eval_*`) wins; skill formula only when the item's is the default; defender modify hooks get the attacker's weapon | EOtF's (`tests/fork-combat-formulas.spec.ts`) |
| Line/all-enemies AOE, `multi_target`, `shove` | target tile's unit is a full combatant; one combat per target; stepwise shove, magnitude > 0 | no main target (one strike, no counter); one counter-less combat; only the final tile is checked, negative magnitudes pull | EOtF's (`tests/fork-combat-hooks.spec.ts`) |
| Built-in components | effective_damage adds the triangle bonus and checks negate conditions; terrain skills skip fliers; no NoMulti; heal additions only; proc removed unconditionally | the reverse, plus empower-heal multipliers on heal/equation_heal/lifelink/regeneration/live_to_serve, NullCanto caps, IgnoringDamage vs TrueMiracle, TrueDamage zero formulas, full-inventory gba_steal | EOtF's (`tests/fork-skill-components.spec.ts`) |
| Level cap | class `max_level` | class `max_level` + global + unit modifiers (silent `give_exp` parks exp at 99) | EOtF's (`tests/fork-leveling.spec.ts`) |
| `end_turn`, `copy_stats` | `end_turn` ends the event; `copy_stats` copies stats only | the event keeps running and the turn changes after it; stat cap modifiers are copied too | EOtF's (`tests/fork-events.spec.ts`) |
| AI | PrimaryAI/SecondaryAI with `attack_zero_dam`, no blitzes | attack count includes blitzes; SecondaryAI skips 0-damage targets and keeps `max_tp` 0 | EOtF's (`tests/fork-ai.spec.ts`; `temp/forkdiff-ai.md`) |
| Map and menu flow | Save on every map; canto BACK = error, own tile → canto_wait (actively chosen, Supply); Storage needs `long_range_storage`/supply, Trade option; Restart Level on title; animation/battle_bg/display_hints settings | no Save/Suspend on level `X`; canto BACK/own tile waits (not actively chosen); Storage whenever `_convoy`, no Trade; Temporary units can't be managed; Credits runs `Global Credits_Title`; `window_display` setting instead | EOtF's (`tests/fork-ui-flow.spec.ts`) |
| Window skin | one engine `menu_bg_base` set | `window_display` 1-3 suffixes every window, gem, shimmer, funds and tile-info sprite (art in `custom_sprites/menu/1..4`) | EOtF's |
| Info menu, help boxes, level screen | upstream pages, single help box, `level_screen` with 8 stats, 144px exp bar | TYPE row, accessory splitter, AS, 10 weapon ranks, class-skill/status page; keyword-linked help pages (AUX); INFO on item/skill choices; `LevelScreen2` with 10 stats; 136px exp bar | EOtF's (`tests/fork-info-menu.spec.ts`) |
| Engine sprites | upstream `sprites/` | `unit_info_bg` 123x60 (with the fork's hover-panel layout) and `menu_bg_parchment` 48x30 differ; 15 fork-only sprites (purple extra-damage digits, LevelScreen2, info-menu art...). Fonts and platforms are identical | the fork's copies (`public/fork-sprites/`, served at `/game-data/fork-sprites/` and packed with the engine assets) win for EOtF (`tests/fork-engine-assets.spec.ts`) |
| Per-unit level-cap modifier on save/load | n/a | the fork forgets it on reload (fork bug) | kept: deliberate deviation |

The same audit found places where both Python engines agree and the web followed
neither; these are fixed for every project: `magic` items now use MAGIC_DAMAGE
(EOtF's 187 magic weapons without an alternate formula hit with STR) and item
formula hooks resolve UNIQUE by component order; `compute_damage`'s step order,
`min_damage` and `crit_anyway`, and the triangle hit before the 0-100 clamp; the
solver's phase alternation, vantage/disvantage and defender desperation; combat
RNG from `game.rng_mode` with `set_mode_rng` display names; combat exp only from
item exp components and level-ups with the unit's growth method; unit tags as own
∪ class ∪ skill `has_tags`; `interrupt_move` regions; NullRefresh on Reset; lethal
upkeep damage firing `unit_death`; and the query functions `has_skill`, `is_dead`,
`has_item`, `get_debuff_count`, allied-unit queries, Tile/dying filters, keyword
arguments, `get_charge` and `v()` (`tests/fork-combat-math.spec.ts`,
`tests/fork-unit-tags.spec.ts`, `tests/fork-region-interrupt.spec.ts`,
`tests/fork-event-queries.spec.ts`).

Follow-ups, also both engines (`tests/fork-followups.spec.ts`): Shove, Swap, Pivot,
DrawBack and EOtF's flex shoves are `on_hit` actions applied with each hit before
the next phase is solved (a shoved melee defender cannot counter); the solver
follows `item_has_uses`/`can_counterattack`, so a weapon spent mid-combat strikes
no more; a surviving player defender earns its weapon's exp when the attacker
doesn't (`handle_exp`); phase skipping ignores Tile units; AI canto retreats and
event `move_unit` walks stop on `interrupt_move` regions (the event keeps running;
Python's player-surprise state clear is not reproduced for event moves); `choice;...;expression`
re-evaluates every frame; non-fading battle-scene `screen_blend` flashes draw at
full strength. Battle animations draw no extra-damage digits, as the fork's
AnimationCombat (only map combat shows them, in `extra_purple`).

---

## Remaining Gaps (2026-10-26)

The July snapshot that used to sit here (44 parser-missing and 53
dispatcher-missing commands, 9 unwired triggers, deferred support UI, fatigue,
terrain status, team palettes, speak styles, scripted sub-events, NPC roam AI,
promotion screens and mid-combat doubling) is closed; it is in git history.
What is still open, most player-visible first:

| Gap | EOtF reach | Why it remains |
|-----|------------|----------------|
| The board holds one unit per tile; Python allows stacking | Only in free roam, where the roam components keep a stacked unit's position and restore the grid (`quickArrive`/`quickLeave`) | Board-wide multi-occupancy would touch every board query |
| `item_funcs.has_damage` (Hurricane_Onslaught_Child, Rumbling_Earth_Child_Helper, Critical_Zone_Aura_Helper/Child conditions) | Yes | Not in the lt-maker reference, so the conditions raise and stay False in both; needs the fork's source to confirm |
| Expressions get every context name; Python passes a per-call-site subset | Only expressions that would raise in Python | Low impact; tracked in `PLAN.md` P8.2 |
| `speak_styles` and team palettes are not saved | No: EOtF's two `speak_style` uses are inside one event and it never changes palettes | No consumer |
| Combat variant palettes in `change_team_palette` | No (0 uses) | No consumer |
| `preview`, `unlock_staff` triggers, overworld `level_select` | No (upstream-only or overworld-only) | Unreachable |

---

## Completion-Gate Checklist

Reference: `PLAN.md` P8.4 (EOtF release gate).

| Item | Status | Evidence |
|------|--------|----------|
| EOtF compatibility audit clean | ✓ | `npm run audit:eotf`: 0 unverified item/skill NIDs, 8 intentional missing catalog aliases |
| Parser and dispatcher cover every command | ✓ | `npm run audit:parity`: 255/255 |
| State-flow audit | ✓ | `npm run audit:states`: 0 open flows |
| Milestone suite | ✓ | `npx playwright test --grep @milestone` (run with each sweep) |
| Build | ✓ | `npx vite build` |

---

## How to Regenerate This Report

```bash
# Regenerate component/command manifests
npm run audit:parity:write

# Run full Playwright regression suite
npx playwright test --reporter=json

# Check for parsing/dispatch coverage
npm run audit:parity

# Build to confirm no TypeScript errors
npm run build

# Run specific parity suites
npx playwright test --grep "parity|golden|resolve|audio|dialog|rendering|pathfinding|equipment"
```

---

**Evidence sources:** PLAN.md, runtime-inventory.md, resolve-policies.md, event-commands.md, item-components.md, skill-components.md, src/, tests/  
**Status:** Published; refreshed 2026-10-26.
