# P2 Actions, Saves, and Turnwheel Audit

## Direct persistent mutation gaps

`src/engine/states/game-states.ts` still bypasses existing actions in important production paths:

- Player movement directly moves the board unit and writes movement fields instead of using `MoveAction`.
- Trade directly swaps arrays/owners and consumes the turn despite existing `TradeAction`, `HasTradedAction`, and `WaitAction`.
- AI movement/wait/heal/item consumption mutates units/items directly.
- Event commands directly mutate skills, HP, EXP, AI, stats, tags, variables, chapter, attack/finish state, money/BEXP, convoy, and party despite many matching actions in `src/engine/action.ts`.

Python ordering to preserve includes money gain before record update, variables computing one new value then one setter action, skill mutation before banner/pause, and one clamped HP action.

## Save gaps

- Initiative runtime state is not serialized/restored.
- In-progress EventManager queue and GameEvent processor cursor are not restored, though PYEV1 has a processor save seam.
- Hybrid fog loses `previouslyVisitedTiles`.
- ActionLog/turnwheel history is not persisted in battle saves.
- Restart-save support is absent.
- Suspend deletion exists but lacks focused coverage.
- Overworld state is serialized as an untyped raw map and lacks a meaningful runtime round trip.

## Existing evidence

The broad PLAN wording is stale for several categories: current tests already cover significant unit/item/skill/lore/party/support/records/region/bounds/RNG behavior. Remaining tests should target the specific gaps above and compare normalized pre/post snapshots through real production paths, including undo and redo.

Primary sources: `lt-maker/app/engine/action.py`, serializer/game-state code; web: `src/engine/action.ts`, `src/engine/save.ts`, `src/engine/states/game-states.ts`.
