# P3 Item and Skill Component Audit

## Completed active slice

Shop pricing is now implemented and committed in `7844859`:

- `full_price`, `buy_price`, `sell_price`
- last-active item override
- conditional buy/sell multipliers
- remaining ordinary-use scaling
- configurable sell modifier
- final truncation at the shop boundary

## Existing component coverage

Already substantial: target unions/filters, multi-target and sequence child ordering, store-to-unload, item combat event ordering, conditional combat procs, charge consumption, and core multi/sequence item-use flows.

## Systemic skill-resolution gap

Most helpers in `src/combat/skill-system.ts` do not apply Python's whole-skill AND condition, equipped-item fallback, `ignore_conditional`, combat-condition/charge gates, snapshot iteration, or exact UNIQUE/sum/product policies. A shared ordered active-component iterator should replace separate ad hoc conventions.

## Phase and lifecycle gaps

- `charges_per_turn` reset.
- Time/end-time and lost-on-upkeep/endstep/end-chapter behavior.
- Regeneration/poison/status phase dispatch.
- Add/remove lifecycle ordering, stack skills, multi-skill, immune/reflect status, and true-remove events.
- Remaining after-strike/cleanup/post-combat/end-combat skill hooks.
- Combat-art/menu activation/deactivation flow.

## Item gaps

- Deprecated `eval_target_restrict` path and its simple restriction behavior.
- `equippable_accessory` capacity/slot semantics.
- Base-use policies for `usable`/`usable_in_base`.
- `self_status_on_hit` and forced movement (shove/pivot/draw-back/swap), including end-combat variants.
- Attack/menu-after-combat.
- `c_uses` chapter reset.
- Correct item override accumulation for non-UNIQUE hooks.

Zero catalog usage is prioritization evidence, not proof that a runtime component is editor-only. Custom Rekka components must be inventoried separately from core Python components.

Primary sources: Python compiled component systems and item/skill component modules; web: `src/combat/item-system.ts`, `skill-system.ts`, `combat-skill-lifecycle.ts`, `combat-lifecycle.ts`, `src/engine/action.ts`.
