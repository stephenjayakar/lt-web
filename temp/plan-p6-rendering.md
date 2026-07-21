# P6 Rendering, Animation, Audio, and Resources Audit

## Combat animation fallback

Default-project happy paths load, but missing/late animation readiness still reaches debug rectangles:

- blue/red 32x40 unit stubs;
- green platform rectangles;
- flat dark panorama fallback;
- child effects without frames.

Python selects MapCombat unless both battle animations, palettes, weapon animations, and referenced spell effects validate. Checked-in platforms, common combat sheets, palettes, effects, panoramas, and skill icons exist; ordinary fallback failures are primarily readiness/selection bugs, not missing assets.

## Playback marks

The solver and controllers retain proc data, but neither animation nor map combat renders it. Missing behavior includes:

- attack pre-procs, defense pre-procs, passive display icons;
- attack/defense proc and hit-proc timing;
- one-at-a-time blocking queues in full animation;
- nonblocking health-bar icons in map combat;
- combat effects keyed by `procSkill.nid`;
- 400 ms bounce/fade-in, 700 ms hold, 150 ms fade-out timing;
- `display_skill_icon_in_combat` and `hide_skill_icon_in_combat` hooks.

## Goldens

Representative map goldens already cover levels 0 and 3 at 2% pixel tolerance. Combat saves an artifact but has no committed `toHaveScreenshot` baseline/tolerance. Combat goldens should pair pixel comparison with structural assertions for real main frames, platform images, proc kind/skill, and loaded icon sheet.

Recommended order: validate resources and fall back to MapCombat; remove debug stubs; add full-animation proc queue; add map/hit proc icons; then commit deterministic combat goldens.

Primary surfaces: `src/combat/animation-combat.ts`, `map-combat.ts`, `combat-skill-lifecycle.ts`, `combat-solver.ts`, and CombatState rendering.
