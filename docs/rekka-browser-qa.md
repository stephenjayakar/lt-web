# Rekka browser QA

This is the lightweight repeatable browser checklist for Rekka. Automated
screenshots are behavioral gates: each test first asserts the expected state or
data, so accepting a pixel change cannot conceal a state-flow failure.

## Release sign-off — 2026-07-23

- [x] Title, chapter select, save select, prep/base, map/HUD, armory/vendor,
  portrait dialogue, combat forecast, map combat, authored full battle
  animation, chapter transition, ending, and credits were rendered and
  inspected at 240×160 logical resolution.
- [x] Combat-art selection and cancellation, accessory equip/use, shop
  transactions, and return paths are covered by their Rekka functional specs.
- [x] Camera pans, overlay fades, animated tiles, skill/unit tints, map-hit and
  cast SFX, title unlock, phase fades, battle-music push/pop, and return-to-map
  audio pass focused rendering/audio specs.
- [x] The authored title track is a non-silent 263.09-second Ogg (−13.0 dB mean,
  0.0 dB peak). Start, attack-hit, and RefreshDance SFX are also non-silent;
  browser launch exposes `Sound on` and the first title interaction unlocks the
  queued track.
- [x] Keyboard/focus, gamepad D-pad, touch input/dock, resize/fullscreen,
  visibility pause, and mute controls pass `tests/web-shell.spec.ts` and
  `tests/platform-lifecycle.spec.ts`.
- [x] Empty-slot save selection, rich Rekka save/restore, legacy migration,
  suspend/restart/delete, event queue/regions, inventories, and skill identity
  pass the focused save suites.

## Automated visual coverage

- Title at desktop and portrait-phone sizes
- Chapter 7 map and preparations
- Armory and vendor entry
- Portrait dialogue
- Save selection
- Rekka combat forecast and map combat
- Rekka-authored full battle animation plus generic resourced/fallback coverage
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

- `logo.png` and `press_start.png` are authored but fully transparent. The web
  title deliberately renders the project name and a text prompt instead; this is
  user-visible and locked by `tests/rekka-title-ui.spec.ts`.
- Three unreferenced panorama catalog entries have no file. They are never
  requested by playable Rekka content; `npm run audit:rekka` fails if a required
  resource becomes missing.
- The Rekka DEBUG-only Eirika/Seth dialogue fixtures reference portraits that
  are not shipped by Rekka. Those DEBUG fixtures use the normal portrait
  fallback; playable campaign events do not reference them, and the resource
  audit preserves that classification.

There are no accepted behavioral deviations for playable Rekka content. The
three visible/optional asset cases above are explicit, audited, and regression
covered; unsupported project expressions or components fail strict boot.
