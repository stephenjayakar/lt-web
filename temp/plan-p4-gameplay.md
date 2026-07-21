# P4 Gameplay, Combat, AI, and RNG Audit

## Combat sequencing gaps

- Scripted combat treats every `--` as one attacker strike and stops at script exhaustion. Python uses natural phase transitions for `--` and exhausted scripts, including attacker/defender partner phases.
- Web lacks Python's first-class ordered playback brush stream; proc playback is separate from strikes.
- Result application currently combines HP/death, durability, WEXP/EXP, drops, and partner cleanup before later death/event cleanup. Python stages combat-death, cleanup hooks, rewards, combat-end, item gain/supports, post-combat hooks, then unit-death.
- Attack-stance WEXP differs from checked-in Python behavior and needs an explicit parity decision.

## Level-up gap

Autolevel algorithms and growth-point persistence exist, but live EXP level-ups still call `UnitObject.levelUp` instead of the dynamic/fixed algorithms in `src/engine/leveling.ts`. All level producers must use one algorithm and preserve RNG/growth-point consumption.

## Pair Up gap

Map-combat Pair Up exists, but:

- scripted combat lacks partner phase scheduling;
- `AnimationCombat` rejects any strike partner;
- full-animation partner/guard sprites, phases, WEXP/durability, pair EXP, guard EXP, and death/reward conditions are absent;
- guard rewards should be skipped when the leader is dying and follow Python's guard-hit counting.

Deterministic goldens should assert leader/partner/defender phase order, scripted exhaustion, reward amounts, and RNG roll counts.

Primary sources: Python combat solver/simple/animation combat and playback modules; web: `src/combat/combat-solver.ts`, `map-combat.ts`, `animation-combat.ts`, `combat-components.ts`, and CombatState cleanup.
