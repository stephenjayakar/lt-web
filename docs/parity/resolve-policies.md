# Component resolve-policy audit (P3)

Point-in-time audit (2026-07-18) comparing Python's generated hook dispatchers
against the web port. Authoritative source: the `ITEM_HOOKS` / `SKILL_HOOKS`
registries in

- `lt-maker/app/engine/component_system/compile_item_system.py`
- `lt-maker/app/engine/component_system/compile_skill_system.py`

backed by the policy implementations in
`lt-maker/app/engine/component_system/utils.py`:

| Python policy | Semantics (`vals` = every component's return value that defines the hook) |
|---|---|
| `ALL_DEFAULT_FALSE` | `all(vals)` if `vals` non-empty, else `False` |
| `ALL_DEFAULT_TRUE` | `all(vals)` if `vals` non-empty, else `True` |
| `ANY_DEFAULT_FALSE` | `any(vals)` if `vals` non-empty, else `False` |
| `UNIQUE` | `vals[-1]` — the **last** component in iteration order (i.e. last skill/component that defines the hook wins), else the named default (or `None`) |
| `NUMERIC_ACCUM` | `sum(vals)`, `0` if empty |
| `NUMERIC_MULTIPLY` | `reduce(mul, vals, 1)`, `1` if empty |
| `MAXIMUM` / `MINIMUM` | `max(vals, default=0)` / `min(vals, default=0)` |
| `UNION` | `set(v for v in vals if v is not None)` |
| `LIST` | `vals` as-is (`[]` if empty) |
| `NO_RETURN` | runs every component's hook, no return value |

Important nuance: `ALL_DEFAULT_TRUE` does **not** mean "true if any component
says true" — it uses the same `all()` as `ALL_DEFAULT_FALSE`; the two only
differ in what they return when **no** component defines the hook at all.

## Web architecture note

The web port stores item components as a flat `Map<nid, value>` per
`ItemObject` (`src/objects/item.ts`) — one entry per component NID, so two
different item components can never both define the *same* hook name on one
item the way Python's `ItemComponent` subclasses can. This makes ordering
irrelevant for item-side hooks in practice (`getComponent` is 1:1), and the
audit found no item-system ordering bugs.

Skills are different: `SkillObject.components` is also a flat map, **but**
several different skill component NIDs can define the *same* Python hook
name (e.g. `damage_formula` and the legacy `alternate_damage_formula` alias
both feed the `damage_formula` hook; `oversplash`/`enemy_oversplash`/
`smart_oversplash`/`Cleave` all feed `alternate_splash`). The web's
`getSkillValue` helper in `src/combat/skill-system.ts` scans `unit.skills` in
order — this is where a real UNIQUE-policy bug was found and fixed (see
below).

## Findings table

Hooks actually implemented on the web side (`src/combat/item-system.ts`,
`src/combat/skill-system.ts`). Hooks with no web equivalent (parity gap, not
a resolve-policy bug) are out of scope for this audit and are tracked
elsewhere in PLAN.md.

| Hook | Python policy | Python default (no component) | Web behavior | Verdict |
|---|---|---|---|---|
| `is_weapon` / `is_spell` / `equippable` / `can_use` (item) | ALL_DEFAULT_FALSE | `False` | `item.hasComponent(...)`, flat 1:1 map | correct (see architecture note) |
| `can_counter` / `can_be_countered` / `can_double` (item) | ALL_DEFAULT_FALSE | `False` | hardcoded true-unless-negated for the always-weapon-tagged call sites | n/a (only queried on already-weapon/spell items; behaviorally equivalent, no ordering issue) |
| `available` (item) | ALL_DEFAULT_TRUE (AND-of-hooks, item + overrides + parent) | `True` | `itemComponentsAvailable` AND-chain across own/override/parent components | correct |
| `is_broken` / `is_unusable` (item) | ANY-true-wins (custom, not a generic policy) | `False` | n/a — not ported (tracked as parity gap) | n/a |
| `damage` / `hit` / `crit` / `weapon_type` / `weapon_rank` / `min_range` / `max_range` (item) | UNIQUE, has default | item's own default (`None`/`0`) | `item.getComponent(...)`, 1:1 map | correct |
| `modify_damage` / `modify_resist` / `modify_accuracy` / `modify_avoid` / `modify_crit_accuracy` / `modify_crit_damage` / `modify_attack_speed` (item) | NUMERIC_ACCUM | `0` | reads single `modify_*` component value, no summation across multiple different-NID contributors needed (1:1 map) | correct |
| `modify_weapon_triangle` (item) | NUMERIC_MULTIPLY, has default `1.0` | `1.0` | `modifyWeaponTriangle`: multiplies `reaver`/`double_triangle`/`custom_triangle_multiplier` contributions, starts at `1` | correct |
| `dynamic_damage` / `dynamic_multiattacks` / `dynamic_accuracy` / `dynamic_attack_speed` (item) | NUMERIC_ACCUM | `0` | sums `effective_damage`, deprecated `effective_tag`, `magic_at_range`, `brave`, etc. | correct |
| `damage_formula` / `resist_formula` / `accuracy_formula` / `avoid_formula` / `*_formula_override` (item) | UNIQUE | `None` | `item.getComponent(...)`, 1:1 map | correct |
| `target_icon` (item) | UNION | `set()` | `computeTargetIcon` returns a single value approximating the common-case union (documented limitation, not a policy bug) | n/a (documented gap) |
| `vantage` / `desperation` / `no_double` / `def_double` / `crit_anyway` / `ignore_terrain` / `distant_counter` / `close_counter` / `no_attack_after_move` / `pass_through` / `disvantage` / `ignore_dying_in_combat` / `ignore_forced_movement` / `ignore_rescue_penalty` (skill) | ALL_DEFAULT_FALSE | `False` | `hasAnySkill(unit, nid)` (OR-of-presence) | correct — every real component of these NIDs only ever contributes `True`, so OR-of-presence is equivalent to `all()` across a values list that is either empty or all-`True` |
| `can_counter` (skill) | ALL_DEFAULT_TRUE | `True` | `canCounter`: `True` unless any skill defines `cannot_counter` | correct (matches `all()` — a single `False` contributor flips it) |
| `has_canto` (skill) | ANY_DEFAULT_FALSE | `False` | `hasCanto`: `hasAnySkill(unit, 'canto')` | correct |
| `damage_formula` / `resist_formula` / `accuracy_formula` / `avoid_formula` / `attack_speed_formula` / `defense_speed_formula` / `*_formula_override` (skill) | **UNIQUE** (`vals[-1]`, last wins) | `None` (or `None` for overrides) | **was** `getSkillValue`: returned the **first** matching skill (early `return` in a `for` loop) | **WRONG → FIXED** |
| `exp_multiplier` / `enemy_exp_multiplier` / `wexp_multiplier` / `enemy_wexp_multiplier` (skill) | UNIQUE, has default `1.0` | `1.0` | same `getSkillValue` helper | **WRONG → FIXED** (same helper) |
| `alternate_splash` (skill) | UNIQUE | `None` | `alternateSplash`: returned on the **first** matching skill/component (early `return` inside nested loop) | **WRONG → FIXED** |
| `modify_damage` / `modify_resist` / `modify_accuracy` / `modify_avoid` / `modify_crit_accuracy` / `modify_crit_avoid` / `modify_crit_damage` / `modify_attack_speed` / `modify_defense_speed` (skill) | NUMERIC_ACCUM | `0` | `sumSkillValues` across all skills, plus a legacy alias component (`damage`, `resist`, `hit`, `avoid`, `crit`, `crit_avoid`, `attack_speed`, `defense_speed`) | correct |
| `empower_splash` (skill, via `oversplash`/`enemy_oversplash`/`smart_oversplash`) | NUMERIC_ACCUM | `0` | `empowerSplash`: sums all three component values across all skills | correct |
| `damage_multiplier` / `resist_multiplier` (skill) | NUMERIC_MULTIPLY | `1` | `productSkillValues` | correct |
| `dynamic_damage` / `dynamic_resist` / `dynamic_accuracy` / `dynamic_avoid` / `dynamic_multiattacks` (skill) | NUMERIC_ACCUM | `0` | sums a single component value per hook across skills | correct |
| `sight_range` (skill) | NUMERIC_ACCUM, has default `0` | `0` | sums flat + decreasing-bonus contributions across skills | correct |
| `stat_change` / `growth_change` (skill) | NUMERIC_ACCUM (per-stat) | `0` | sums matching `[stat, amount]` pairs across all skills | correct |

## Fixes applied

1. **`src/combat/skill-system.ts` — `getSkillValue<T>`** (used by
   `damageFormula`, `resistFormula`, `accuracyFormula`, `avoidFormula`,
   `resistFormulaOverride`, `accuracyFormulaOverride`,
   `avoidFormulaOverride`, `attackSpeedFormula`, `defenseSpeedFormula`,
   `expMultiplier`, `enemyExpMultiplier`, `wexpMultiplier`,
   `enemyWexpMultiplier`): changed from "return on first skill that defines
   the component" to "scan every skill, keep overwriting the result" so the
   **last** skill (in `unit.skills` order) that defines the hook wins,
   matching `utils.unique(vals) == vals[-1]` in
   `lt-maker/app/engine/component_system/utils.py:47-50`, as generated by
   `generate_skill_hook_str` in `compile_skill_system.py:178-198` (the
   dispatcher appends to `values` while iterating `unit.skills[:]` in
   order, then resolves with the hook's policy — for `UNIQUE` hooks that
   means the last append wins).

2. **`src/combat/skill-system.ts` — `alternateSplash`**: same bug, same
   fix. Python's `alternate_splash` hook (`compile_skill_system.py:38`,
   `ResolvePolicy.UNIQUE`) is fed by the `oversplash`, `enemy_oversplash`,
   `smart_oversplash`, and `Cleave` skill components; the web function now
   scans every skill/component in order and keeps overwriting instead of
   returning on the first match.

### Why this matters for combat

`accuracyFormula`/`avoidFormula`/`damageFormula`/etc. (and their
`*_formula_override` siblings) are consulted directly in
`src/combat/combat-calcs.ts` to pick the equation used for to-hit, avoid,
damage, and speed. A unit with two skills that each redefine a formula (a
realistic case — e.g. a base-kit "always uses MAGIC_DAMAGE" skill plus a
later-granted override skill) previously had its **earliest**-granted skill
win regardless of stacking order; Python always lets the most-recently
defined component win. The fix makes formula selection order-correct.
`alternate_splash` similarly determines which of several stacked
AOE-replacement skills (Oversplash-family vs. Cleave) actually governs a
single-target item's splash — previously the first-added skill silently
"won" forever even after a stronger/later skill was granted.

## Test coverage

`tests/resolve-policies.spec.ts` exercises the fixed hooks directly as unit
tests against `src/combat/skill-system.ts` (constructing minimal fake
`SkillObject`/unit values, no browser harness needed):

- `damageFormula`, `accuracyFormula` (+ alias), `resistFormulaOverride`,
  `expMultiplier`: last-defined skill wins in both orderings, with a
  default-value case per hook.
- `alternateSplash`: last-defined skill/component wins in both orderings
  (`oversplash` vs `Cleave`), with a default-`null` case.
- `modifyDamage`, `empowerSplash`: NUMERIC_ACCUM sums across skills/aliases,
  with a default-`0` case.
- `canCounter`, `noDouble`: ALL_DEFAULT_TRUE / ALL_DEFAULT_FALSE-shaped
  booleans behave correctly at the boundary (no contributing skill vs. one
  disabling skill).

No golden-combat numbers changed: the existing `default.ltproj`/test-fixture
units never stack two skills that define the same UNIQUE hook, so the bug
was latent (order-independent in all current fixtures) but real for any
multi-skill build using formula-override or splash-replacement skills
together.
