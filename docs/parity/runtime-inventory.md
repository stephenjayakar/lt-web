# Runtime Inventory: Triggers, Query Functions, Equations, Save Fields

Research audit generated 2026-07-17 by a GLM-5.2 subagent (omp/OpenRouter), reviewed and
annotated by hand. This is discovery evidence for the P0 roadmap row, not a parity claim.

## 1. TRIGGERS (lt-maker/app/events/triggers.py)

| nid | triggers.py:line | payload fields | REFERENCED/UNREFERENCED in src/ | web path:line if referenced | notes |
|---|---|---|---|---|---|
| level_start | 57 | (none) | REFERENCED | src/engine/game-state.ts:611 | Fired in `loadLevel` step k; also mentioned in comments at game-state.ts:411, game-states.ts:908 |
| level_end | 66 | (none) | REFERENCED | src/engine/states/game-states.ts:6975 | Fired from EventState on win_game; guarded by `_level_end_triggered` levelVar (6966) |
| overworld_start | 73 | (none) | UNREFERENCED | — | Overworld entry trigger not wired in web port |
| level_select | 84 | (none) | REFERENCED | src/engine/states/game-states.ts:736 | String present only as `LevelSelectState.name` / `state.change('level_select')`; trigger type `level_select` is NOT fired |
| phase_change | 91 | `team: NID` | REFERENCED | src/engine/states/game-states.ts:5681 | Fired as trigger with `team`; nid also used as state name `PhaseChangeState` (5801) and `state.change('phase_change')` (5667,5671,5786) |
| turn_change | 99 | (none) | REFERENCED | src/engine/states/game-states.ts:5624, 5688 | Fired as trigger with `turnCount`; nid also used as state name `TurnChangeState` (game-states.ts:992,1253,1263) |
| enemy_turn_change | 107 | (none) | REFERENCED | src/engine/states/game-states.ts:5697 | Fired with `turnCount`, `levelNid` |
| enemy2_turn_change | 114 | (none) | REFERENCED | src/engine/states/game-states.ts:5702 | Fired with `turnCount`, `levelNid` |
| other_turn_change | 121 | (none) | REFERENCED | src/engine/states/game-states.ts:5707 | Fired with `turnCount`, `levelNid`, `team` |
| on_region_interact | 130 | `unit1: UnitObject`, `position: Tuple[int,int]`, `region: RegionObject` | REFERENCED | src/engine/states/game-states.ts:1775; src/engine/states/roam-state.ts:350 | Roam path uses `region.sub_nid` fallback to `'on_region_interact'`; web payload passes `unitNid`, `unit1`, `region`, `levelNid` |
| on_roam_interact | 145 | `unit1: UnitObject`, `units: List[UnitObject]` | REFERENCED | src/engine/states/roam-state.ts:384 | *(Fixed 2026-07-18)* Added `getClosestUnits()` (mirrors Python's `get_closest_units()`) and pass the full sorted list via `localArgs.get('units')`, resolvable as `{e:units}`/condition `units`. `unit1`/`unit2`/`unitNid` retained as web conveniences. |
| combat_death | 156 | `unit1: UnitObject`, `unit2: Optional[UnitObject]`, `position: Tuple[int,int]` | REFERENCED | src/engine/states/game-states.ts:4177, 4191 | Fired per dead defender and dead attacker; web adds `unitNid`, `levelNid` |
| unit_death | 166 | `unit1: UnitObject`, `unit2: Optional[UnitObject]`, `position: Tuple[int,int]` | REFERENCED | src/engine/states/game-states.ts:4216, 4228 | Fired after combat_end (4210 comment); web adds `unitNid`, `levelNid` |
| unit_wait | 176 | `unit1: UnitObject`, `position: Tuple[int,int]`, `region: Optional[RegionObject]`, `actively_chosen: bool` | REFERENCED | src/engine/states/game-states.ts:1913 (player Wait menu, `actively_chosen=true`), :5594 (AI auto-wait, `actively_chosen=false`) | `actively_chosen` passed via `localArgs`; region via `getRegionUnderPos()` helper (game-states.ts:392) |
| unit_select | 187 | `unit1: UnitObject`, `position: Tuple[int,int]` | REFERENCED | src/engine/states/game-states.ts:1150 | Fired in FreeState SELECT; relies on FreeState.update()'s existing hasActiveEvents() check to push EventState (avoids double-push) |
| unit_deselect | 196 | `unit1: UnitObject`, `position: Tuple[int,int]` | REFERENCED | src/engine/states/game-states.ts:1472 | Fired in MoveState BACK (cancel) handler, after `game.state.back()` |
| unit_level_up | 205 | `unit1: UnitObject`, `stat_changes: Dict[NID,int]`, `source: str` | REFERENCED | src/engine/states/game-states.ts:9625 (`autolevel_to` event command) and :4712/:4956 (`fireUnitLevelUpTrigger()`, combat-driven level-ups) | *(Audited + fixed 2026-07-18)* `stat_changes`/`source` ARE present (via `EventManager.trigger()`'s generic `localArgs` mapping of `trigger.statChanges`/`trigger.source`, event-manager.ts:1311-1312) — the "unverified" note was stale. Real gap found: combat/EXP-driven level-ups (level_up.py:279's unconditional `game.events.trigger(triggers.UnitLevelUp(...))` on every level-up) never fired the trigger at all in the web port — only the synthetic `autolevel_to` event command dispatched it. Added `CombatState.fireUnitLevelUpTrigger()`, called when the level_screen phase completes, firing with `source: 'exp_gain'` (matching Python's `self.source = 'exp_gain'` default in level_up.py:91). |
| during_unit_level_up | 215 | `unit1: UnitObject`, `stat_changes: Dict[NID,int]`, `source: str` | UNREFERENCED | — | Deferred: the seam exists (LevelUpScreen.update() 'get_next_spark'->'level_up_wait' transition in src/ui/exp-display.ts:378-390, mirroring level_up.py:522), but firing there mid-CombatState 'level_screen' phase has no clean event-pump point (EventState is only ever pushed after CombatState pops, at game-states.ts ~4310) — pumping mid-animation would require restructuring CombatState's phase machine to interleave with EventState, out of scope for this slice |
| unit_weapon_rank_up | 225 | `unit: UnitObject`, `weapon_type: NID`, `old_wexp: int`, `rank: str` | REFERENCED | src/engine/states/game-states.ts:2005, 3895 | Fired from promote/class-change paths; web payload uses `unit1`/`unitNid` (not `unit`) |
| combat_start | 236 | `unit1: UnitObject`, `unit2: UnitObject`, `position: Tuple[int,int]`, `item: ItemObject`, `is_animation_combat: bool` | REFERENCED | src/engine/states/game-states.ts:3602 | Web payload uses `isAnimationCombat` (camelCase) and adds `unitNid` |
| combat_end | 248 | `unit1: UnitObject`, `unit2: UnitObject`, `position: Tuple[int,int]`, `item: ItemObject`, `playback: List[PlaybackBrush]` | REFERENCED | src/engine/states/game-states.ts:4798-4807 | *(Audited 2026-07-18: already fixed, note was stale)* `playback: activeCombat!.strikes` IS present in the payload and reaches condition/`{e:}` context via the generic `localArgs` mapping (event-manager.ts:1317). |
| on_talk | 260 | `unit1: UnitObject`, `unit2: UnitObject`, `position: Tuple[int,int]` | REFERENCED | src/engine/states/game-states.ts:1629, 1824, 1841; src/engine/states/roam-state.ts:327 | Web uses `unitA`/`unitB` NID pair plus `unit1`/`unit2`. *(Audited 2026-07-18)* Roam-path `position` omission is intentional parity, not a gap: Python's `free_roam_state.py:163` calls `triggers.OnTalk(self.roam_unit, other_unit, None)` — position is `None` at that one call site in Python too. |
| on_support | 270 | `unit1: UnitObject`, `unit2: UnitObject`, `position: Tuple[int,int]`, `support_rank_nid: NID`, `is_replay: bool` | REFERENCED | src/engine/states/game-states.ts:2210+ (field Support option trigger); src/engine/states/base-state.ts:530+ (BaseSupportState trigger) | Field Support option fires when adjacent unit has unlocked-but-unviewed rank; gate: `_supports` gameVar + `support_constants.combat_convos` enabled. Base submenu shows all support pairs with any unlocked/locked ranks and replays conversations. |
| on_base_convo | 282 | `base_convo: NID`, `unit: NID` (deprecated) | UNREFERENCED | — | Base-conversation trigger not wired |
| on_prep_start | 291 | (none) | REFERENCED | src/engine/states/prep-state.ts:PrepMainState.start() | Fired once per prep entry, before setupUnits(); pushes EventState directly if events queued |
| on_base_start | 298 | (none) | REFERENCED | src/engine/states/base-state.ts:BaseMainState.start() | Fired once per base entry, after buildMenu(); pushes EventState directly if events queued |
| on_turnwheel | 307 | (none) | REFERENCED | src/engine/states/turnwheel-state.ts:296 | Fired post-turnwheel with `game`/`gameVars`/`levelVars` ctx |
| on_turnwheel | triggers.py:307 | — | REFERENCED | turnwheel-state.ts:296 | |
| on_title_screen | triggers.py:314 | (none) | REFERENCED | game-states.ts:588 | Fired when entering TitleState; fires on_startup in same boot sequence per Python semantics |
| on_startup | triggers.py:321 | (none) | REFERENCED | main.ts:526 | Fired once at game boot after DB/game state init, before any state change |
| time_region_complete | triggers.py:328 | position, region | UNREFERENCED | — | time-region feature missing |
| on_overworld_node_select | triggers.py:343 | entity_nid, node_nid | REFERENCED | overworld-state.ts:241 | Fired when entity selects node; payload entity_nid/node_nid match Python trigger fields |
| roam_press_start | triggers.py:352 | unit1, unit2 | UNREFERENCED | — | roam input/aux missing |
| roam_press_info | triggers.py:361 | unit1, unit2 | UNREFERENCED | — | |
| roam_press_aux | triggers.py:370 | unit1, unit2 | UNREFERENCED | — | |
| roaming_interrupt | triggers.py:379 | unit1, position, region | REFERENCED | roam-state.ts:419 | web omits unit1/position |
| preview | triggers.py:401 | position, region | UNREFERENCED | — | 'preview' string appears in game-states.ts:9924 as shop flag, unrelated |
| event_on_hit | triggers.py:412 | unit1, unit2, position, item, target_pos, mode, attack_info | REFERENCED | combat-lifecycle.ts:51 | referenced as component name; nid resolved via `eventNid()` |
| event_after_combat | triggers.py:429 | unit1, unit2, position, item, target_pos, mode | REFERENCED | combat-lifecycle.ts:69 | web also dispatches non-Python `event_after_use`, `event_after_combat_on_hit` |
| event_after_initiated_combat | triggers.py:445 | unit1, unit2, position, item, mode | UNREFERENCED | — | hidden skill/item trigger missing |
| event_on_remove | triggers.py:460 | unit1 | UNREFERENCED | — | hidden skill trigger missing |
| unlock_staff | triggers.py:471 | unit1, position, item, region | UNREFERENCED (as trigger) | — | appears in item-system.ts:61,431,695 only as item COMPONENT, never dispatched as trigger |
| (RegionTrigger, dynamic nid) | triggers.py:390 | nid, unit1, position, region, item | REFERENCED (dynamic) | roam-state.ts:350,353 | dispatched via `region.sub_nid` |

**Totals (updated 2026-07-19):** 30/41 constant nids referenced, 11 unreferenced. Recent slices wired unit_wait, unit_select, unit_deselect, on_prep_start, on_base_start, on_startup, on_title_screen, on_overworld_node_select. Still unreferenced: overworld_start (1), on_base_convo (1), roam-input (3), time-region (1), during-level-up (1, deferred — no event-pump seam in CombatState's level-up animation), on_support (1, deferred — no support-conversation UI exists yet), hidden skill/item triggers (2).

---

## 2. QUERY FUNCTIONS

Source: `lt-maker/app/engine/query_engine.py` (471 lines) — 21 public methods auto-registered into `func_dict` via `dir(self)`. Web port: `src/engine/query-engine.ts` (869 lines) — explicit `[camelCase, snake_case, fn]` table in `getFuncDict()` (lines 56-93), both aliases bound.

| python function | python source | purpose | web status | web src path:line | notes |
|---|---|---|---|---|---|
| get_item | query_engine.py:55 | item by nid/uid from unit inventory (or convoy if unit=='convoy') | IMPLEMENTED | query-engine.ts:155 | drops `unit=='convoy'` path; convoy via separate `getConvoyInventory` |
| get_subitem | query_engine.py:80 | child subitem by nid from parent multi-item | IMPLEMENTED | query-engine.ts:599 | drops convoy path |
| has_item | query_engine.py:110 | true if any matching unit holds the item | IMPLEMENTED | query-engine.ts:180 | no convoy check |
| get_skill | query_engine.py:150 | skill by nid from unit.all_skills (reversed) | IMPLEMENTED | query-engine.ts:199 | searches unit.skills, not all_skills |
| has_skill | query_engine.py:168 | true if unit has skill | IMPLEMENTED | query-engine.ts:212 | |
| get_klass | query_engine.py:180 | DB Klass prefab for unit's class | IMPLEMENTED | query-engine.ts:223 | |
| get_class | query_engine.py:195 | alias of get_klass | IMPLEMENTED | query-engine.ts:231 | |
| get_closest_allies | query_engine.py:197 | N closest player units with distances | IMPLEMENTED | query-engine.ts:246 | web uses `getAlliedTeams()` (broader); drops distance tuples |
| get_units_within_distance | query_engine.py:214 | units within Manhattan dist matching filters | IMPLEMENTED | query-engine.ts:274 | drops distance tuples |
| get_allies_within_distance | query_engine.py:247 | player units within dist | IMPLEMENTED | query-engine.ts:299 | re-implemented directly, broader team set |
| get_units_in_area | query_engine.py:260 | units in rectangular area (two corners) | IMPLEMENTED | query-engine.ts:324 | |
| get_debuff_count | query_engine.py:284 | count of `skill.negative` skills | IMPLEMENTED | query-engine.ts:354 | SEMANTIC MISMATCH: web counts statusEffects w/ negative statMods/DOT/immobilize/stun |
| get_units_in_region | query_engine.py:298 | units in region via `region.contains()` | IMPLEMENTED | query-engine.ts:380 | SHAPE GAP: rectangular bounds only, not arbitrary region shape |
| any_unit_in_region | query_engine.py:330 | true if any matching unit in region | IMPLEMENTED | query-engine.ts:406 | inherits rectangular-only gap |
| is_dead | query_engine.py:349 | true if unit dead | IMPLEMENTED | query-engine.ts:418 | SEMANTIC MISMATCH: Python returns False for not-found; web returns True |
| u | query_engine.py:363 | shorthand for game.get_unit | IMPLEMENTED | query-engine.ts:120 | |
| v | query_engine.py:374 | level_vars then game_vars fallback | IMPLEMENTED | query-engine.ts:133 | |
| get_support_rank | query_engine.py:391 | most-recently-obtained support rank | IMPLEMENTED | query-engine.ts:438 | SEMANTIC MISMATCH: web returns highest-ranked |
| get_terrain | query_engine.py:411 | terrain nid at position | IMPLEMENTED | query-engine.ts:483 | |
| has_achievement | query_engine.py:424 | true if achievement completed | IMPLEMENTED | query-engine.ts:502 | |
| check_shove | query_engine.py:436 | destination for pushing target away from anchor | IMPLEMENTED | query-engine.ts:522 | web returns null on first blocked tile; Python keeps last valid; movement-cost predicate differs |

**Totals:** 21/21 IMPLEMENTED (no outright missing functions). Web adds 12 web-only helpers (`checkAlive`, `getInternalLevel`, `getMoney`, `getBexp`, `isRoam`, `getRoamUnit`, `aiGroupActive`, `getTeamUnits`, `getPlayerUnits`, `getEnemyUnits`, `getAllUnits`, `getConvoyInventory`) sourcing behavior from other Python modules. Gaps are behavioral fidelity, not coverage.

---

## 3. EQUATIONS

Source: `lt-maker/default.ltproj/game_data/equations.json` (32 nids) + `lt-maker/app/engine/equations.py` (tokenize + rewrite + `exec` full Python). Web evaluator: `src/combat/combat-calcs.ts` `evaluateEquation` / `evaluateEquationCondition`; DB load in `src/data/database.ts`.

### Equation nid inventory

| nid | python expression | referenced in src/ | web src path | notes |
|---|---|---|---|---|
| HITPOINTS | `HP` | no | — | read via `unit.stats['HP']` elsewhere |
| MOVEMENT | `MOV` | no | — | via `unit.getStatValue('MOV')` |
| ATTACK_SPEED | `SPD` | yes | combat-calcs.ts:393 | weight-token substitution |
| DEFENSE_SPEED | `SPD` | yes | combat-calcs.ts:416 | |
| HIT | `SKL*2 + LCK//2` | yes | combat-calcs.ts:290 | `//` bug: LCK//2 not rewritten (see parity) |
| AVOID | `SPD*2 + LCK` | yes | combat-calcs.ts:314 | |
| CRIT_HIT | `SKL//2` | no | — | web uses `'CRIT'` instead |
| CRIT_AVOID | `LCK` | yes | combat-calcs.ts:718 | |
| DAMAGE | `STR` | yes | combat-calcs.ts:347 | |
| DEFENSE | `DEF` | yes | combat-calcs.ts:369 | |
| MAGIC_DAMAGE | `MAG` | no | — | DAMAGE + isMagic branching used instead |
| MAGIC_DEFENSE | `RES` | yes | combat-calcs.ts:369 | |
| MAGIC_RANGE | `max(5, MAG//2)` | no | — | no callsite |
| CRIT_ADD | `0` | no | — | |
| CRIT_MULT | `3` | no | — | |
| THRACIA_CRIT | `0` | no | — | |
| SPEED_TO_DOUBLE | `4` | yes | combat-calcs.ts:550 | `db.getEquation(...)` w/ fallback 4 |
| RATING | `(HP - 10)//2 + max(STR, MAG) + SKL + SPD + LCK//2 + DEF + RES` | no | — | |
| RESCUE_AID | `max(0, 25 - CON) if 'Mounted' in unit.tags else max(0, CON - 1)` | no | — | would exercise web's limited ternary+tag path |
| RESCUE_WEIGHT | `CON` | no | — | |
| STEAL_ATK | `SPD` | yes | ai-controller.ts:550; item-system.ts:708 | |
| STEAL_DEF | `SPD` | yes | ai-controller.ts:556; item-system.ts:709 | |
| HEAL | `MAG + 10` | no | — | resolved via item-component name, not this nid |
| CONSTITUTION | `CON` | no | — | |
| INITIATIVE | `SPD` | yes (lowercase) | initiative.ts:22 | CASE BUG: looks up `'initiative'`, DB has `'INITIATIVE'` — returns undefined, falls back to 0 |
| MANA | `20` | yes | item-system.ts:124 | raw string value, NOT evaluated |
| ZERO | `0` | no | — | |
| SKILL_PROC | `SKL//4` | no | — | |
| DEVIL_AXE | `29 -  LCK` | no | — | |
| MEND | `MAG + 20` | no | — | |
| STATUS_STAFF_HIT | `30 + SKL + MAG*5` | no | — | |
| STATUS_STAFF_AVOID | `RES*5` | no | — | |

**Extra nids referenced in src/ but NOT in default equations.json** (rely on fallback): `MAX_GUARD` (fallback 10), `GAUGE_INCREASE` (fallback 2), `CRIT` (fallback `'SKL // 2'`), `initiative` (fallback 0).

### Evaluator syntax parity

Python (`equations.py`): tokenize → rewrite (stat nid → `(unit.stats['X'] + unit.stat_bonus('X'))`; equation nid → recursive call) → wrap in `int(...)` unless `float` substring present → `exec` `def NID(equations, unit): return ...`. Full Python expression power.

Web (`combat-calcs.ts` `evaluateEquation`): regex/string-rewrite → `new Function('Math','clamp', ...)`. Pipeline: ternary regex → equation-nid substitution (longest-first) → stat-token substitution → `unit.level`/`unit.klass`/`unit.get_internal_level()` → `DB.constants.value('x')` → `//` → Math.floor → wrap `max/min/abs/int/float` → `Math.floor(result)`.

Concrete parity gaps:

1. **`//` only matches numeric-literal operands** — regex `/(\b[\d.]+)\s*\/\/\s*([\d.]+\b)/g`. Any `//` with compound operand (`LCK // 2`, `(HP - 10) // 2`) survives as a JS line comment, silently truncating the expression. Breaks `HIT`, `CRIT_HIT`, `RATING`, `SKILL_PROC`, `MAGIC_RANGE`, `CRIT` fallback. **Severity: high.**
2. **Always-integer truncation** — web wraps every result in `Math.floor`; Python uses `int()` (trunc toward zero) and skips when `float` present. Negative-result divergence.
3. **No logical operators** — `and`/`or`/`not` unsupported in `evaluateEquationCondition`; compound conditions default to true.
4. **No arbitrary `unit.X` access** — only `unit.level`, `unit.klass`, `unit.get_internal_level()` substituted; any other attribute/method breaks in `new Function`.
5. **No arbitrary builtins** — only `max/min/abs/int/float` wrapped; `pow`/`round`/`sum`/`sorted`/`len` fail.
6. **Query functions not wired** — `GameQueryEngine.getFuncDict()` exists but `evaluateEquation` never consults it (Python's exec scope also lacks them, so parity here, but docstring claims otherwise).
7. **Ternary regex top-level only** — nested ternaries or ternaries inside `max(...)` args unhandled.
8. **`'Tag' in unit.tags` bare form only** — compound tag conditions fail. Impacts `RESCUE_AID`.
9. **Case-sensitive equation lookup** — `initiative.ts:22` looks up `'initiative'`, DB key is `'INITIATIVE'`; returns undefined → fallback 0. Python lowercases partial accessor and resolves.
10. **Web implements `DB.constants.value(...)` substitution that Python does not actually support** — `DB` not in Python exec globals; would `NameError`.

---

## 4. SAVE FIELDS

Sources: `game_state.py:398` (GameState.save), `unit.py:893` (UnitObject.save), `item.py:112` (ItemObject.save), `skill.py:82` (SkillObject.save). Web: `src/engine/save.ts` — `buildSaveDict` (541), `serializeUnit` (358), `serializeItem` (422), `serializeSkill` (447), `restoreGameState` (790+).

### GameState save fields

| field | python source | web status | web src path:line | notes |
|---|---|---|---|---|
| units | game_state.py:399 | PERSISTED | save.ts:657 | |
| items | game_state.py:400 | PERSISTED | save.ts:658 | |
| skills | game_state.py:401 | PERSISTED | save.ts:659 | |
| terrain_status_registry | game_state.py:402 | N/A (documented, 2026-07-17) | — | Web has no terrain-granted-status system at all (no `add_terrain_status`/`register_terrain_status` equivalent, no terrain-status skill grants anywhere in `src/`). Nothing to serialize; adding a registry field with no producer would be dead code. Deferred until a terrain-status feature is ported. |
| regions | game_state.py:403 | MISSING | — | region registry not serialized |
| level | game_state.py:404 | PERSISTED | save.ts:660 | |
| overworlds | game_state.py:405 | PARTIAL | save.ts:683-685 | Map entries, not full `overworld.save()` objects — shape differs |
| turncount | game_state.py:406 | PERSISTED | save.ts:661 | |
| playtime | game_state.py:407 | PERSISTED | save.ts:662 | |
| game_vars | game_state.py:408 | PERSISTED | save.ts:663 | |
| level_vars | game_state.py:409 | PERSISTED | save.ts:664 | |
| current_mode | game_state.py:410 | PERSISTED | save.ts:665-667 | via `DifficultyModeObject.save()` |
| teams | game_state.py:411 | N/A (documented, 2026-07-17) | — | Python's `teams` registry IS runtime-mutable (`change_team_palette` command calls `TeamObject.change_palettes()`), but the web port does not implement `change_team_palette` (grepped `src/engine/states/game-states.ts` — no case for it) and has no other runtime team-mutation path; `AlliancePair`/`TeamDef` are read-only DB data (`src/data/types.ts:270,273`). Teams are purely DB-static in the web port today, so there is nothing to serialize. Blocked on porting `change_team_palette`; revisit then. |
| parties | game_state.py:412 | PERSISTED | save.ts:668 | |
| current_party | game_state.py:413 | PERSISTED | save.ts:669 | |
| state | game_state.py:414 | PARTIAL | save.ts:670 | only current state name (`stateStack`), not full state-machine save |
| action_log | game_state.py:415 | DEFERRED (documented, 2026-07-17) | — | Large feature: `src/engine/action.ts` has no `serialize`/`save`/`restore` scaffolding at all (grepped) — the web action log is in-memory only. Persisting it (for mid-battle-save turnwheel history) requires a serialization format for every Action subclass, out of scope for this slice. Deferred; see runtime-inventory.md Highest-Risk Gaps #5 for the related `already_triggered_events` gap (since closed, see below) which was a much smaller, tractable slice of the same area. |
| events | game_state.py:416 | MISSING | — | EventManager state not serialized |
| supports | game_state.py:417 | PERSISTED | save.ts:673 | |
| records | game_state.py:418 | PERSISTED | save.ts:672 | |
| speak_styles | game_state.py:419 | N/A (documented, 2026-07-17) | — | `speak_style` is a recognized event-command token (`src/events/event-manager.ts:55,153`) but has no case in the game-states.ts command switch (grepped, no match) — it is unimplemented, so there is no runtime `SpeakStyleLibrary`-equivalent state to serialize. Deferred until `speak_style` itself is wired. |
| market_items | game_state.py:420 | PERSISTED | save.ts:674 | |
| unlocked_lore | game_state.py:421 | PERSISTED | save.ts:676 | |
| dialog_log | game_state.py:422 | N/A (documented, 2026-07-17) | — | No `DialogLog`-equivalent runtime object in the web port (grepped `src/` for `dialogLog`/`dialog_log` — no hits outside this doc). Nothing to persist. |
| already_triggered_events | game_state.py:423 | PERSISTED | save.ts:812-814 | Closed in an earlier slice (see PLAN.md P2 "already_triggered_events + full region-state save-field parity"). |
| talk_options | game_state.py:424 | PERSISTED | save.ts:677 | |
| talk_hidden | game_state.py:425 | PERSISTED (closed 2026-07-17) | save.ts (SaveDict.talkHidden), event-manager.ts (`EventManager.talkHidden`/`hideTalk`/`unhideTalk`/`isTalkHidden`/`getTalkHidden`/`restoreTalkHidden`) | Previously `hide_talk`/`unhide_talk` were no-ops in game-states.ts ("not yet tracked visually"). Added an `EventManager`-backed hidden-pair `Set<string>` (keys `"unitA\|unitB"`, order-independent lookup), wired both event commands to it, filtered it into the map Talk-menu-option check (game-states.ts, the `adjacentTalkTargets` filter), and persisted/restored it in save.ts (optional field, defaults to empty set for legacy saves). Test: tests/save-fields.spec.ts. |
| base_convos | game_state.py:426 | PERSISTED | save.ts:675 | |
| current_random_state | game_state.py:427 | MISSING | — | combat RNG diverges after load |
| bounds | game_state.py:428 | N/A (documented, 2026-07-17) | — | `set_game_board_bounds`/`remove_game_board_bounds` event commands are unimplemented in the web port (grepped `game_board_bounds`/`GameBoardBounds` across `src/` — no hits), so there is no runtime bounds field to serialize. Blocked on those commands being ported first. |
| fog_state | game_state.py:429 | PARTIAL | save.ts:678 | rebuilt from `levelVars._fog_of_war*`, not `previously_visited_tiles` |
| roam_info | game_state.py:430 | PERSISTED | save.ts:679-682 | only `roam` + `roamUnitNid` |

### Unit save fields

| field | python source | web status | web src path:line | notes |
|---|---|---|---|---|
| nid | unit.py:894 | PERSISTED | save.ts:363 | |
| prefab_nid | unit.py:895 | MISSING | — | restore uses nid only |
| position | unit.py:896 | PERSISTED | save.ts:371 | |
| team | unit.py:897 | PERSISTED | save.ts:372 | |
| party | unit.py:898 | PERSISTED | save.ts:399 | |
| klass | unit.py:899 | PERSISTED | save.ts:373 | |
| variant | unit.py:900 | PERSISTED | save.ts:366 | |
| faction | unit.py:901 | PERSISTED | save.ts:367 | |
| level | unit.py:902 | PERSISTED | save.ts:374 | |
| exp | unit.py:903 | PERSISTED | save.ts:375 | |
| generic | unit.py:904 | PERSISTED | save.ts:368 | |
| persistent | unit.py:905 | PERSISTED | save.ts:400 | |
| ai | unit.py:906 | PERSISTED | save.ts:385 | |
| roam_ai | unit.py:907 | N/A (documented, 2026-07-17) | — | Web has no per-unit roam-AI dispatch at all: Free Roam mode (`src/engine/states/roam-state.ts`) only ever drives the single player-controlled unit directly (`FreeRoamState.roamUnit`) — there is no NPC roam-AI system for `change_roam_ai`/`set_roam_ai` to target, and neither event command is implemented (grepped, no case in game-states.ts). Web's `roam_ai` in `src/data/types.ts:308` is an unrelated AI-def boolean flag, not a per-unit field. Adding a stored `unit.roamAi` with no consumer would be dead code. Deferred until NPC roam-AI is ported. |
| ai_group | unit.py:908 | PERSISTED | save.ts:390 | |
| items | unit.py:909 | PERSISTED | save.ts:382 | stores item map keys, not uids |
| name | unit.py:910 | PERSISTED | save.ts:364 | |
| desc | unit.py:911 | PERSISTED | save.ts:365 | |
| tags | unit.py:912 | PERSISTED | save.ts:384 | |
| stats | unit.py:913 | PERSISTED | save.ts:376 | |
| growths | unit.py:914 | PERSISTED | save.ts:378 | |
| growth_points | unit.py:915 | PERSISTED | save.ts:379 | |
| stat_cap_modifiers | unit.py:916 | PERSISTED | save.ts:381 | |
| starting_position | unit.py:917 | PERSISTED | save.ts:387-389 | |
| wexp | unit.py:918 | PERSISTED | save.ts:386 | |
| portrait_nid | unit.py:919 | PERSISTED | save.ts:391 | |
| affinity | unit.py:920 | PERSISTED | save.ts:392 | |
| skills | unit.py:921 | PARTIAL | save.ts:383,412 | Python stores `(uid, source, source_type)` per skill; web stores NIDs + `skillInstances` (nid+data); `source`/`source_type` lost |
| notes | unit.py:922 | PERSISTED | save.ts:369 | |
| current_hp | unit.py:923 | PERSISTED | save.ts:377 | |
| current_mana | unit.py:924 | PERSISTED (closed 2026-07-17) | save.ts:446 (serialize), save.ts:1185-1187 (restore), UnitSaveData.currentMana | Web tracks `unit.currentMana` as a dynamic (not class-declared) property, set via the `set_current_mana` event command (game-states.ts) and consumed by `item-system.ts:125` mana-cost checks (falls back to the `MANA` equation when unset). Now persisted as an optional field; legacy saves and units that never touched mana restore with the property left unset (unchanged fallback behavior). Test: tests/save-fields.spec.ts. |
| current_fatigue | unit.py:925 | N/A (documented, 2026-07-17) | — | Web has no fatigue mechanic at all — grepped `src/` (excluding tests) for `fatigue` (any case): zero hits. No `set_current_fatigue`-equivalent command, no runtime field, no consumer. Nothing to persist; adding a field would be dead code. Deferred until a fatigue system is ported. |
| traveler | unit.py:926 | PERSISTED | save.ts:404 | `travelerNid` |
| current_guard_gauge | unit.py:927 | PERSISTED | save.ts:406 | |
| built_guard | unit.py:928 | PERSISTED | save.ts:407 | |
| dead | unit.py:929 | PERSISTED | save.ts:397 | |
| action_state | unit.py:930 | PARTIAL | save.ts:393-398,408-411 | only 9 hardcoded booleans; arbitrary action_state keys dropped |
| _fields | unit.py:931 | PERSISTED | save.ts:370 | `fields` |
| equipped_weapon | unit.py:932 | MISSING | — | equipment resets on reload |
| equipped_accessory | unit.py:933 | MISSING | — | |

### Item save fields

| field | python source | web status | web src path:line | notes |
|---|---|---|---|---|
| uid | item.py:114 | MISSING | — | web uses string `mapKey` instead (save.ts:441) |
| nid | item.py:115 | PERSISTED | save.ts:427 | |
| name | item.py:116 | PERSISTED | save.ts:428 | |
| desc | item.py:117 | PERSISTED | save.ts:429 | |
| owner_nid | item.py:118 | PERSISTED | save.ts:439 | `ownerNid` |
| droppable | item.py:119 | PERSISTED | save.ts:438 | |
| data | item.py:120 | PERSISTED | save.ts:434 | |
| subitems | item.py:121 | PERSISTED | save.ts:442-444 | `subitemKeys` (keys, not uids) |
| command_item | item.py:122 | MISSING | — | |
| components | item.py:124 | PERSISTED | save.ts:430-432 | |

### Skill save fields

| field | python source | web status | web src path:line | notes |
|---|---|---|---|---|
| uid | skill.py:84 | MISSING | — | web keys by nid; dedupes by nid in buildSaveDict:576-586, collapsing per-unit instances |
| nid | skill.py:85 | PERSISTED | save.ts:461 | |
| owner_nid | skill.py:86 | MISSING | — | per-skill owner lost |
| data | skill.py:87 | PERSISTED | save.ts:455-457,466 | |
| initiator_nid | skill.py:88 | MISSING | — | initiator identity lost |
| subskill | skill.py:89 | MISSING | — | subskill uid chain lost |
| components | skill.py:91 | PERSISTED | save.ts:448-450,464 | |

Web adds `activeAiGroups` and `memory` with no Python counterpart (web-only extensions, not gaps).

---

## Highest-Risk Gaps

Ranked by likely gameplay/save-corruption impact:

1. **Equation `//` evaluator bug (combat-calcs.ts).** Floor-division with any non-numeric operand silently truncates the expression via JS line-comment parsing. Affects live equations `HIT` (`SKL*2 + LCK//2`) and `CRIT` fallback (`SKL // 2`), plus all unreferenced-but-default equations using `//`. Core combat math is wrong.
2. **`INITIATIVE` equation case-lookup bug (initiative.ts:22).** Looks up `'initiative'`, DB key is `'INITIATIVE'`; returns undefined → fallback 0. Initiative turn order broken for any project relying on the default equation.
3. **Skill `uid`/`owner_nid`/`initiator_nid`/`subskill` not persisted (save.ts).** Web dedupes skills by NID, collapsing per-unit instances and severing subskill chains. Class-change skill ledger and sourced-skill restoration corrupted on save/load.
4. **`current_random_state` not persisted.** Combat RNG diverges after load; turnwheel reversibility across save boundaries breaks; deterministic-replay guarantees lost.
5. **`already_triggered_events` + `events` (EventManager state) not persisted.** One-shot events re-fire on reload; story/progression state regress.
6. **Unit `equipped_weapon`/`equipped_accessory` not persisted.** Equipment resets on reload; mid-combat save restore leaves units unarmed.
7. **Unit `skills` tuple loses `source`/`source_type`.** Class-change and Pair Up/Rescue skill attribution corrupted; turnwheel undo of skill grants may misfire.
8. **`get_debuff_count` semantic mismatch (query-engine.ts:354).** Web counts statusEffects vs Python's `skill.negative`; any event condition relying on debuff count behaves differently.
9. **19 of 41 event triggers unreferenced.** Whole feature categories have no trigger dispatch: overworld (3), base/prep (4), roam-input (3), unit cursor selection (3), hidden skill/item lifecycle (`event_after_initiated_combat`, `event_on_remove`). Projects using these triggers will silently no-op.
10. **GameState `state` (only current name, not full stack), `teams`, `regions`, `bounds`, `terrain_status_registry` not properly persisted.** Mid-level save restore loses state-machine depth and runtime map mutations; shape mismatches rather than clean missing fields.

Lower-risk but worth tracking: `get_units_in_region` rectangular-only shape (vs `region.contains()`), `is_dead` not-found inversion, `get_support_rank` selection divergence, convoy-path item queries routed through a separate helper, `action_state` arbitrary-key loss, Item `command_item`.

**Closed 2026-07-17 (P2 save-field gap closeout):** Unit `current_mana` (persisted — has a live runtime representation via `set_current_mana`); `talk_hidden` (persisted — `hide_talk`/`unhide_talk` were dead-lettered no-ops, now backed by an `EventManager` hidden-pair set that also feeds the map Talk-menu filter). **Documented as non-applicable/deferred** (no runtime representation to serialize; adding fields would be dead code): Unit `current_fatigue` (no fatigue system in web at all), Unit `roam_ai` (no NPC roam-AI dispatch in web's Free Roam), GameState `terrain_status_registry` (no terrain-granted-status system), GameState `teams` (registry is DB-static in web; Python's runtime mutation path `change_team_palette` is unported), GameState `bounds` (`set_game_board_bounds`/`remove_game_board_bounds` unported), GameState `speak_styles` (`speak_style` command unwired), GameState `dialog_log` (no DialogLog-equivalent object). GameState `action_log` remains a large deferred feature (no serialization scaffolding exists for any Action subclass).

---

## Reviewer verification notes (Claude, 2026-07-17)

- **Equation `//` bug — confirmed, severity revised down.** Stat tokens are numeric
  before the `//` rewrite runs, so `LCK//2`-style forms work; only compound or
  parenthesized left operands (e.g. `(HP - 10)//2` in `RATING`) fall through and
  turn the rest of the expression into a JS comment. Real, but `HIT` is unaffected.
- **`INITIATIVE` case bug — confirmed.** `initiative.ts` looks up `initiative`; the
  DB Map key is `INITIATIVE`; result is always the 0 fallback.
- **`current_random_state` "missing" — discounted.** The web engine persists the
  combat/growth LCG seed+state through game variables (see the persistent combat RNG
  slice in PLAN.md), an intentional representation difference, not a gap.
- **`equipped_weapon`/`equipped_accessory` "missing" — in flight.** The tracked equip
  lifecycle slice adds these fields with save persistence.
