# Rekka browser QA

This is the lightweight repeatable browser checklist for Rekka. Automated
screenshots are behavioral gates: each test first asserts the expected state or
data, so accepting a pixel change cannot conceal a state-flow failure.

## Automated visual coverage

- Title at desktop and portrait-phone sizes
- Chapter 7 map and preparations
- Armory and vendor entry
- Portrait dialogue
- Save selection
- Resourced and fallback full battle animation
- Combat proc presentation
- Camera, weather, tile animation, and overlay rendering
- Final credits
- DPR 2 responsive achievement/menu layout

Baselines live under `test-snapshots/` and are exercised by the focused Rekka
UI specs plus the rendering and combat-animation specs.

## Audio check

1. Open Rekka from the project picker with browser audio enabled.
2. Confirm `groovin_magic_instrumental` begins after the first title-screen
   interaction; the title must not remain silent after audio unlock.
3. Confirm Start plays its SFX and the title-menu music continues without a
   restart or overlap.
4. Enter a chapter, begin and end one map combat, then begin one full-animation
   combat. Confirm map SFX, battle-music push/pop, and return-to-map music.
5. Open the browser `Sound on` control, mute, then unmute. Confirm both music
   and SFX mute and return at their prior configured levels.
6. Background and restore the tab. Confirm audio suspends while hidden and
   resumes without duplicating the current track.

Automated call-order coverage for the same transitions is in
`tests/audio-parity.spec.ts`; the checklist exists for audible distortion,
mixing, or browser-policy regressions that call recording cannot detect.

## Known optional project fixtures

- `logo.png` and `press_start.png` are fully transparent, so the title uses the
  project name and a text prompt.
- Three unreferenced panorama catalog entries have no file.
- The Rekka DEBUG-only Eirika/Seth dialogue fixtures reference portraits that
  are not shipped by Rekka; playable campaign events do not reference them.
