# AI controller: fork vs upstream vs web

Sources: fork `/Users/stephen/Desktop/EotF/app/engine/ai_controller.py` (+ utils, combat_calcs,
target_system, item/skill ai hooks), upstream `lt-maker/app/engine/ai_controller.py`, web
`src/ai/ai-controller.ts` (after 99f3d8e). EOtF data: `lt-maker/eotf.ltproj/game_data/ai.json`
(57 AIs: Attack 54 behaviours, Move_to 22, Interact 20, Support 9, Move_away_from 3, Steal 2; no
Terrain targets), constants `attack_zero_hit=True`, `attack_zero_dam=True`, `line_of_sight=False`,
`ai_fog_of_war=False`, `min_damage=1`.

Class: F = fork-only, U = upstream change after the fork, B = both engines agree (web bug).
"Web before" is the state at 99f3d8e; "Now" is this branch (`qa/fork-ai`).

| # | Area | Fork | Upstream | Web before | Class | EOtF uses? | Now |
|---|---|---|---|---|---|---|---|
| 1 | PrimaryAI default_priority num_attacks | `phases + blitzes`, `× multiattacks` | `phases × multiattacks` (no blitzes) | `1 + double`, no brave/multi/blitz | F | 6 `dynamic_blitzes` skills, 30 brave, 23 `dynamic_multiattacks` | fixed; blitzes gated on `isForkEngine()` |
| 2 | PrimaryAI default_priority scoring | offense 3 if lethal×acc ≥ 1 else lethal×acc×attacks; crit increment; defense − target dmg/**target** HP × acc, ×0.3 if no counter; zero-hit/zero-dam escape; weights bias/(bias+1); distance 0.0001; `process_terms` | same | custom heuristic (kill bonus +2, distance 0.1, counter weapon by range) | B | every Attack AI | fixed (both engines) |
| 3 | PrimaryAI acceptance | `max_tp = 0`, strict `>`: no positive score → SecondaryAI | same | best of `-Infinity`: always attacked if any position | B | yes | fixed |
| 4 | compute_priority hooks | item `ai_priority` sum (status_on_hit family, statuses, stacks_on_hit, no_ai −1, heal, buff_ally, steal family) × `ai_priority_multiplier`; default only for damaging item vs enemy | same | multiplier only; no item hooks; no_ai items skipped | B | 139 status_on_hit / 101 status_after_combat weapons+spells, 30 no_ai, 14 buff_ally | fixed |
| 5 | Splash scoring | only legal behaviour targets; hook + (3 or lethal×acc), + enemy / − ally | same | full utility, allies penalised even when not legal targets | B | blast/AOE items | fixed |
| 6 | Items tried by Attack PrimaryAI | all available items (multi-item leaves) + extra abilities; sequence items skipped by get_ai_targets | + `extra_command` items | weapons only | B (U for extra_command) | spells with status_on_hit; no extra_command | fixed: weapons + spells + combat arts |
| 7 | >10 targets | only `farthest_away_pos(orig, moves, enemies)` scored per target | same | every move | B | large hub/endgame maps | fixed |
| 8 | no_attack_after_move | moves other than origin skipped | same | ignored | B | 8 weapons/spells | fixed |
| 9 | SecondaryAI for Attack/Support/Steal | Python SecondaryAI: view limit (−1, and −2 for these actions: none), A*, compute_priority, travel | same | nearest by path, Manhattan fallback toward unreachable targets, view filter `≤ range+MOV` | B | 12 Attack −2, 10 Attack −1, 3 Support −2, 2 Steal −2, 21 Attack −3/−4 | fixed (−2/−1 never advance) |
| 10 | SecondaryAI max_tp | `0`, strict `>` (a score ≤ 0, e.g. path > e⁴ ≈ 54 tiles, is never picked) | `None`, any non-None score | upstream | U | Move_to −4 on large maps | fixed, gated |
| 11 | SecondaryAI default_priority damage | `true_damage = raw×hit if raw else 0`; skip item if ≤ 0 and no status; no terms → 0 | `attack_zero_dam`/`attack_zero_hit` keep 0-damage items; None when nothing | none (nearest target) | U | all Attack −3/−4 (constants True) | fixed, gated |
| 12 | SecondaryAI Support/Steal/self | return 0 | return None | n/a | U | yes | fixed (both never win) |
| 13 | SecondaryAI Interact term | none | `(0 if occupied else 1, 15)` | upstream | U | 20 Interact behaviours | fixed, gated |
| 14 | SecondaryAI A* `max_movement_limit` | absent | tiles costing > MOV impassable | upstream | U | yes | fixed, gated |
| 15 | Target `Terrain` | absent (no targets) | supported | upstream | U | not used | skipped (not exercised) |
| 16 | Move_away_from | `smart_farthest_away_pos`; strict `<` view limits (zero/single/double/range); needs > 1 move; home as best still ends the AI | same | max of min distance, `≤`, home → next behaviour | B | 3 behaviours | fixed |
| 17 | AI act: `check_region_interrupt(unit)` | condition-aware interrupt | same (HEAD) | absent | B | mines/traps | skipped: state report row 5 (separate task) |
| 18 | quick_move | PickUnitUp/PutUnitDown (aura/arrive hooks) | QuickLeave/QuickArrive | `board.moveUnit` only | U (refactor) | aura skills | skipped: the web's temporary move runs no arrive/leave hooks, so aura-dependent scoring can differ in both engines |
| 19 | Turnwheel markers | none (Move…Wait groups) | MarkActionGroupStart/End | upstream | U | turnwheel off | skipped |
| 20 | Support PrimaryAI | compute_priority over Heal/buff hooks + range-0 self hack | same | custom heal/status priority | B | 9 Support behaviours | skipped: approximates Heal.ai_priority; not in rows 6-8 |
| 21 | Steal PrimaryAI | Steal.ai_priority (0.075 + 0.01×distance to enemy average) | same | highest item value | B | 2 behaviours | skipped (not in rows 6-8) |
| 22 | PrimaryAI equips each item while scoring | EquipItem action | same | not equipped | B | equip-conditioned skills | skipped (minor) |
| 23 | `item_funcs.get_max_range` for view limits | all available items | same | weapons/spells + steal | B | rare | skipped (minor) |
| 24 | Tie-breaks | Python set iteration order | same | list order (last max wins for sorted()[-1]) | — | — | not reproducible |

Notes
- Row 2: Python divides the counter damage by the target's HP, not the attacker's; ported as is.
- Damage/hit predictions use `computeDamage`/`computeHit` plus the weapon-triangle bonus, as the
  web combat solver resolves a strike, so the combat report's `min_damage` fix (combat B2) flows in.
- Rows 6-8 of `temp/forkdiff-state.md` were verified against the code: the num_attacks formula, the
  scoring terms, the >10 rule, ai_priority hooks, SecondaryAI terms and smart_farthest_away_pos are as
  described. Row 8's class "B" is right (fork and upstream utils agree).
