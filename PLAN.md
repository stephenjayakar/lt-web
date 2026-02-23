# lt-web: Lex Talionis Web Engine -- Development Plan

This document tracks what has been built, what is partially complete, and what
remains to bring the TypeScript web port to feature parity with the original
Lex Talionis Python/Pygame engine.

---

## Current State

**84 source files, ~44,400 lines of TypeScript.**
Builds cleanly with zero type errors. All four development phases (Foundation,
Playable, Visual Polish, Mobile/Distribution) are complete. The engine loads
`.ltproj` game data over HTTP and runs at 60 fps on Canvas 2D with dynamic
viewport scaling for mobile and desktop.

### Multi-Project Support

The engine supports loading different `.ltproj` projects via the `?project=`
query parameter. Both **chunked** (directory-per-type with `.orderkeys`) and
**non-chunked** (single JSON array files) data formats are supported.

**Completed:**
- [x] Configurable project path via `?project=` query param
- [x] Non-chunked game_data fallback (items.json, skills.json, etc.)
- [x] Non-chunked tilemap fallback (single tilemaps.json)
- [x] Engine-level shared assets separated from project assets (sprites/menus, platforms, cursor)
- [x] Combat palette loading: added `palette_data/` subdirectory fallback path
- [x] URL encoding: `ResourceManager.resolveUrl()` now encodes path segments for spaces/special chars
- [x] Title screen: animated panorama fallback (tries `title_background0.png` when single file missing)
- [x] Icons, fonts, base-surf, sprite-loader all encode NIDs in URLs

**Known Limitations (per-project content):**
- Missing `combat_*.png` panoramas in non-default projects (combat backgrounds show nothing)
- Projects may reference combat effects/palettes not present — renders without them gracefully

---

### Known Bugs

- [ ] **First dialogue still renders over the portrait.** The dialogue box
  appears on top of the portrait sprite instead of being positioned to avoid it.
- [ ] **Combat animations at half speed sometimes.** Battle animations
  occasionally play at roughly half their normal speed.
- [ ] **Enemies leave blue rectangle at start position when attacking.** When
  an enemy unit initiates combat, a blue highlight rectangle remains at their
  original tile during the attack.
- [ ] **Lose cursor control after combat.** After combat resolves, the player
  cannot move the cursor or interact with the map.
- [ ] **Red rectangle randomly appears during magic attack.** A stray red
  rectangle/highlight flashes on screen during magic combat animations.
- [ ] **Terrain platforms swap/move after magic attack starts.** During magic
  combat animations, the terrain platform images appear to shift or swap sides
  unexpectedly, then swap back at the end.
- [ ] **Combat UI layout is wrong.** The combat UI (name tags, HP bars, weapon
  info) during GBA-style battle animations does not match the original Pygame
  engine's layout.

### Recent Changes

- **Magic sword / wind sword freeze fix.** Fixed `castSpell` in `animation-combat.ts`
  to check the item's `battle_cast_anim` component (e.g. "Gustblade", "Lightning",
  "Nosferatu") before falling back to the item NID. Without this, spell effects never
  spawned, causing the animation to loop forever waiting for `end_parent_loop` or
  `spell_hit`. Also implemented `magic_at_range` dynamic damage in `item-system.ts`
  (swaps STR→MAG and DEF→RES at distance > 1).
- **Multi-project support.** Fixed 3 hardcoded asset paths (base-surf, sprite-loader,
  cursor) to use configurable base URLs. Added `ResourceManager.getBaseUrl()` accessor.
  Separated engine-level shared assets (`/game-data/`) from project-level assets
  (`/game-data/{project}.ltproj/`).
- **Non-chunked data format support.** `loadChunked()` now falls back to loading
  single `game_data/{type}.json` array files when `.orderkeys` directories don't exist.
  `loadTilemaps()` now tries `tilemaps.json` bulk file before individual tilemap files.

---

## Remaining Work

### Multi-Project Compatibility (Active)

1. **Combat palette path fix** — Non-chunked palettes at `palette_data/combat_palettes.json`
   not found because engine looks one directory level up.
2. **URL encoding for resource NIDs** — Tilesets, portraits, icons, panoramas, and music
   with spaces/special characters in NIDs fail to load. Need `encodeURIComponent()` or
   `encodeURI()` on URL path segments.
3. **Animated title panoramas** — Projects with numbered frames (`title_background0.png`
   through `title_background32.png`) instead of single `title_background.png`.

### Still Missing (Lower Priority)

- Initiative bar rendering UI (visual bar showing unit order)
- Non-silent promotion choice UI (visual class selection)
- Level-up display after promotion
- Supply menu state UI
- Aura propagation, charge/cooldown, conditional activation, proc skills
- RNG mode integration into combat solver
- Difficulty selection UI
- Roam AI for NPCs, shop/talk menu in roam mode
- Rescue icon, status effect icons, movement arrows on map
- Growth rates display, support list, weapon rank letters in info menu
- Base screen sub-menus (supports, codex, BEXP, sound room, achievements)
