# P1 Event Runtime Audit

## Established behavior

- All 255 Python event command NIDs are parser-recognized and have `EventState` cases.
- `no_banner` is implemented for item/skill/money/BEXP mutation banners.
- `screen_shake`, `map_anim`, and `interact_unit` already distinguish their primary blocking/immediate variants.

## Remaining command-flag gaps

- Portrait add/remove/move/bop/mirror do not consistently distinguish default blocking, `no_block`, `immediate`, fade, and skip behavior.
- `speak`/`say`/`narrate` ignore `no_block`; skip drops held dialogue instead of preserving/warping it.
- `transition` always blocks; `no_block` should let the fade continue while later commands execute.
- Cursor movement/flicker, unit/group movement, death animation, stat-change presentation, overlay sprites, deferred battle saves, transition-to-menu commands, and overworld movement/reveal still collapse Python flag variants.
- Web has one `skipMode`; Python distinguishes regular skip and super-skip, with `end_skip` clearing only regular skip.

Primary sources: `lt-maker/app/events/event.py`, `event_functions.py`, `overworld_event_functions.py`; web surface: `src/engine/states/game-states.ts`, `src/ui/dialog.ts`, `src/events/event-portrait.ts`.

## Top active task: deferred triggers

1. `during_unit_level_up`
   - Python fires after the last nonzero stat spark and before `level_up_wait`, then later fires `unit_level_up` after the screen exits.
   - Web currently fires only the late trigger.
   - Required seam: `src/ui/exp-display.ts` plus the level-screen owner in `game-states.ts`.

2. `event_after_initiated_combat`
   - Hidden skill component hook, attack mode only.
   - Fires for attacker and attacking strike partner before item end-combat events.
   - Payload: bearer as `unit1`, target as `unit2`, bearer position, locals `{item,item2,mode}`.
   - Required seam: `src/combat/combat-lifecycle.ts` and both combat event-queue callsites.

3. `event_on_remove`
   - Fires after a true skill removal, only on first `ActionLog.doAction`, not redo/reverse.
   - Event sees the skill already absent.
   - Required seam: `ActionLog.doAction`, `RemoveSkillAction`, and event `remove_skill` migration in `game-states.ts`.

Focused coverage should exercise real producers rather than directly calling EventManager: a combat level-up ordering spec and a hidden event-hook spec covering attack-only payload/order plus remove undo/redo semantics.
