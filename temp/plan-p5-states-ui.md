# P5 State Machine and UI Audit

## Inventory

Python registers 120 state names; web registers 59 concrete states. Many Python entries are aliases/internal phases and should map to documented mergers rather than empty web aliases. No checked-in name-by-name mapping or drift guard exists.

## Reachable gaps

- `objective_menu` and `dialog_log`.
- Title Extras flow.
- Trade mode variants (`combat_trade`, prep trade states) and correct cancel semantics.
- Weapon/spell/ability multi/submenu chooser variants and general targets-items flow.
- Full growth/support/WEXP info content.
- Resource-backed placeholders.

## Already implemented

Do not reimplement sequence/multi-target item use, repair/steal target-item menus, promotion choice, field/base `on_support` dispatch, base support registration, or asynchronous real info portraits.

## Trade is a concrete bug

Current TradeState ignores its selected indices, always swaps index 0, mutates arrays directly, omits tradeability/accessory/capacity rules, and marks the actor traded/finished on BACK. Python uses reversible TradeItem, sets `has_traded` only for successful normal trade, and has distinct normal/combat/prep cancel stack behavior.

## Recommended slices

1. Deterministic generated Python-to-web state mapping with `missing` classifications.
2. Correct normal/combat/prep trade and general item-target menu behavior.
3. Objective menu and reversible dialog-log capture/replay.
4. Reachable base supports from the real base menu.
5. Growth/support/WEXP info panels and real asset replacement.

Primary sources: `lt-maker/app/engine/state_machine.py`, trade/general/objective/dialog-log states; web: `src/main.ts`, `src/engine/states/game-states.ts`, `base-state.ts`.
