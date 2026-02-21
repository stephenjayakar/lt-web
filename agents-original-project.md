# AGENTS.md — Lex Talionis Engine Technical Reference

This document is a comprehensive technical reference for the Lex Talionis
(LT) game engine, a Python/Pygame-based tactical RPG engine in the style
of Fire Emblem. It covers the full architecture, data model, and all
major systems.

---

## 1. Project Overview

Lex Talionis is a Fire Emblem-style tactical RPG engine and editor.
The engine runs at a fixed **240x160 pixel** resolution (15x10 tiles at
16x16 pixels each), scaled up to the display. The codebase is Python 3,
using Pygame for rendering and input.

**Key entry points:**
- `run_engine.py` — Loads RESOURCES and DB, starts the game driver
- `run_editor.py` — Launches the Qt-based level editor
- `app/constants.py` — `TILEWIDTH=16`, `TILEHEIGHT=16`, `WINWIDTH=240`, `WINHEIGHT=160`, `FPS=60`

---

## 2. Project Structure

```
lt-maker/
  run_engine.py          # Engine entry point
  run_editor.py          # Editor entry point
  app/
    constants.py          # Global constants (tile size, resolution, FPS)
    engine/               # Core game engine
      driver.py           # Main game loop
      engine.py           # Pygame abstraction layer (353 lines)
      state_machine.py    # Stack-based state machine (294 lines)
      state.py            # Base State and MapState classes
      game_state.py       # Central GameState singleton (1694 lines)
      unit_sprite.py      # Map sprite rendering and animation
      combat_calcs.py     # Combat formula calculations
      ai_controller.py    # AI decision making (886 lines)
      action.py           # Command pattern actions (execute/reverse)
      combat/             # Combat resolution system
        solver.py          # CombatPhaseSolver (588 lines)
        interaction.py     # Combat entry point
        map_combat.py      # Map-view combat
        animation_combat.py # Full battle animation combat
        playback.py        # PlaybackBrush classes for combat visualization
      component_system/   # Code generation for item/skill hooks
        compile_item_system.py   # Generates item_system.py
        compile_skill_system.py  # Generates skill_system.py
        utils.py                 # ResolvePolicy, HookInfo
      item_components/    # 17 .py files, ~201 component classes
      skill_components/   # 18 .py files, ~240 component classes
      objects/            # Runtime game objects
        unit.py            # UnitObject (1035 lines)
        item.py            # ItemObject (145 lines)
        skill.py           # SkillObject (109 lines)
        tilemap.py         # TileMapObject + LayerObject (359 lines)
        region.py          # RegionObject
        level.py           # LevelObject
        ai_group.py        # AIGroupObject
      pathfinding/
      movement/
      graphics/
      info_menu/
      overworld/          # Overworld map system
      roam/               # Free roam mode
    data/
      database/
        database.py        # Database singleton (DB) with 30+ catalogs
        ai.py, items.py, skills.py, units.py, klass.py, levels.py, ...
      resources/
        resources.py       # RESOURCES singleton for asset loading
    events/
      event_commands.py    # ~256 EventCommand classes (4036 lines)
      triggers.py          # ~35+ EventTrigger classes (480 lines)
      event_manager.py     # EventManager
      event_state.py       # EventState
      regions.py           # Region prefab + RegionType enum
  default.ltproj/         # Default game project (Sacred Stones)
  resources/              # Engine resource files (sprites, fonts)
```

---

## 3. Engine Architecture

### 3.1 Game Loop (`app/engine/driver.py`)

```
while True:
    engine.update_time()
    raw_events = engine.get_events()
    event = input_manager.process_input(raw_events)
    surf, repeat = game.state.update(event, surf)
    while repeat:
        surf, repeat = game.state.update([], surf)
    engine.push_display(surf, screensize, DISPLAYSURF)
    engine.update_display()
    clock.tick()  # 60 FPS cap
```

### 3.2 Stack-Based State Machine (`app/engine/state_machine.py`)

~170 registered states. State lifecycle:
1. `start()` — Called once when first pushed
2. `begin()` — Called each time state becomes top of stack
3. `take_input(event)` — Process input
4. `update()` — Update logic
5. `draw(surf)` — Render
6. `end()` — Leaving top of stack
7. `finish()` — Removed from stack

Deferred transitions: `change(name)`, `back()`, `clear()` queue operations
processed via `process_temp_state()` at end of frame.

`'repeat'` return: re-runs the state machine in the same frame.

Transparent states: `transparent = True` lets states beneath draw too.

### 3.3 GameState Singleton (`app/engine/game_state.py`, 1694 lines)

Central god object. Key registries: `unit_registry`, `item_registry`,
`skill_registry`, `region_registry`. Variable stores: `game_vars`,
`level_vars`. Controllers: `camera`, `cursor`, `phase`, `highlight`,
`map_view`, `movement`, `death`, `ai`, `events`, `board`, `path_system`,
`action_log`, `supports`.

Key methods:
- `start_level(level_nid)` — Load level, create tilemap, cursor, units
- `arrive(unit, position)` — Place unit on map
- `leave(unit)` — Remove unit from map
- `save()` / `load(s_dict)` — Full serialization

### 3.4 Rendering

Immediate-mode: every frame is redrawn from scratch. No scene graph.
`MapView.draw()` composites: background tilemap → highlights → grid →
units (Y-sorted) → foreground tilemap → cursor.

Sprite positioning (`unit_sprite.py:647`):
```python
topleft = left - max(0, (image.get_width() - 16)//2), top - 24
```
Fixed y-offset of -24 for all sprite states. Colorkey: `(128, 160, 128)`.

---

## 4. Data Model

### 4.1 Database (`app/data/database/database.py`)

30 catalog attributes: `constants`, `stats`, `equations`, `mcost`,
`terrain`, `weapon_ranks`, `weapons`, `teams`, `factions`, `items`,
`skills`, `tags`, `game_var_slots`, `classes`, `support_constants`,
`support_ranks`, `affinities`, `units`, `support_pairs`, `ai`,
`parties`, `difficulty_modes`, `credit`, `translations`, `lore`,
`levels`, `events`, `overworlds`, `raw_data`.

**Chunked data** (directory with `.orderkeys` + individual JSON files):
`events`, `items`, `skills`, `units`, `classes`, `levels`, `credit`.

**Non-chunked data** (single JSON file): everything else.

### 4.2 `.ltproj` Directory Format

```
project.ltproj/
  metadata.json
  game_data/
    constants.json, stats.json, equations.json, mcost.json, terrain.json,
    weapon_ranks.json, weapons.json, teams.json, factions.json, tags.json,
    ai.json, difficulty_modes.json, ...
    items/.orderkeys + per-item JSON
    skills/.orderkeys + per-skill JSON
    units/.orderkeys + per-unit JSON
    classes/.orderkeys + per-class JSON
    levels/.orderkeys + per-level JSON
    events/.orderkeys + per-event JSON
  resources/
    tilesets/, map_sprites/, combat_anims/, portraits/, panoramas/,
    music/, sfx/, ...
```

### 4.3 Key Data Formats

**Unit JSON** (unique):
```json
[{
  "nid": "Eirika", "name": "Eirika", "level": 1, "klass": "Eirika_Lord",
  "tags": ["Lord"], "bases": {"HP": 16, "STR": 4, ...},
  "growths": {"HP": 70, "STR": 40, ...},
  "starting_items": [["Rapier", false]],
  "learned_skills": [[1, "Canto"]],
  "wexp_gain": {"Sword": {"usable": true, "wexp_gain": 1, "cap": 251}}
}]
```

Note: Unit `bases` are **personal stat bases** already. They do NOT need
class bases added. The original engine (`unit.py:from_prefab`) uses the
unit's own bases directly for unique units. Class bases are only used
for generic units that don't have their own stats.

**Unit `growths`** are **personal growths**. The class has a separate
`growth_bonus` field that is added on top. The class `growths` field is
used only for generic units.

**Item JSON:**
```json
[{
  "nid": "Iron_Sword", "name": "Iron Sword", "desc": "...",
  "components": [["weapon", true], ["weapon_type", "Sword"],
    ["damage", 5], ["hit", 90], ["uses", {"starting_uses": 46, "uses": 46}]]
}]
```

**AI JSON:**
```json
[{
  "nid": "Pursue", "priority": 20, "offense_bias": 2,
  "behaviours": [
    {"action": "Attack", "target": "Enemy", "view_range": -4, "condition": ""},
    {"action": "Move_to", "target": "Enemy", "view_range": -4}
  ]
}]
```

**Level JSON** — contains `units` array with both unique and generic entries
discriminated by `"generic": true/false`.

---

## 5. Unit System (`app/engine/objects/unit.py`, 1035 lines)

### 5.1 `from_prefab(prefab, current_mode)` — Unit Construction

For **unique units**: uses `prefab.bases` directly as stats (these are
the unit's personal bases, NOT class bases added on top).

For **generic units**: stats come from class bases since generics don't
have personal stats.

**Growth calculation**: `unit.growths = prefab.growths` for unique units.
Class `growth_bonus` (NOT `growths`) is added for the effective growth rate.

### 5.2 Key Properties

- `stats`: Base stats (personal for unique, class for generic)
- `growths`: Personal growth rates
- `skills` property: De-duplicated, visible skills (most recent wins for same NID)
- `get_stat(stat_nid)`: `stats[nid] + stat_bonus(nid)` (includes skill/item bonuses)
- `get_internal_level()`: Effective level across promotion tiers

### 5.3 `__getattr__` Fallback

Falls back to DB prefab for missing attributes. Editor-defined properties
are accessible without explicit fields.

---

## 6. Component System

All item and skill behavior is defined through **components** that
implement **hooks**. The system uses code generation.

### 6.1 Code Generation

`compile_item_system.py` and `compile_skill_system.py` generate
`item_system.py` and `skill_system.py` at startup. For each hook, a
function is generated that iterates all components on the item/skill and
calls `component.{hook_name}()`, resolving results via `ResolvePolicy`.

### 6.2 ResolvePolicy

| Policy | Behavior |
|--------|----------|
| `UNIQUE` | Return last component's value |
| `ALL_DEFAULT_FALSE` | `all(values)`, default `False` |
| `ALL_DEFAULT_TRUE` | `all(values)`, default `True` |
| `ANY_DEFAULT_FALSE` | `any(values)`, default `False` |
| `NUMERIC_ACCUM` | Sum all values |
| `NUMERIC_MULTIPLY` | Product of all values |
| `NO_RETURN` | Side-effects only |

### 6.3 Item Hooks (~110+)

Boolean flags: `is_weapon`, `is_spell`, `equippable`, `can_counter`, ...
Formulas: `damage_formula`, `resist_formula`, `accuracy_formula`, ...
Values: `damage`, `hit`, `crit`, `weapon_type`, `weapon_rank`, ranges, ...
Modifiers: `modify_damage`, `modify_accuracy`, `dynamic_damage`, ...
Events: `on_hit`, `on_crit`, `on_miss`, `start_combat`, `end_combat`, ...

### 6.4 Skill Hooks (~150+)

Boolean: `vantage`, `desperation`, `crit_anyway`, `no_double`, ...
Modifiers: `modify_damage`, `dynamic_damage`, `damage_multiplier`, ...
Events: `before_add`, `after_add`, `start_combat`, `after_strike`, ...

### 6.5 Item Component Files (17 files, ~201 classes)

`base_components.py` (weapon, spell, uses), `weapon_components.py` (damage, hit),
`hit_components.py` (on_hit effects), `target_components.py` (targeting),
`usable_components.py` (healing, stat boosters), `aoe_components.py`,
`extra_components.py` (brave, effective), `formula_components.py`, etc.

### 6.6 Skill Component Files (18 files, ~240 classes)

`base_components.py` (hidden, aura), `combat_components.py` (vantage, brave),
`combat2_components.py` (dynamic modifiers, procs), `movement_components.py`
(canto, pass, flying), `status_components.py` (regen, poison),
`attribute_components.py` (stat/growth changes), etc.

---

## 7. Combat System

### 7.1 Entry Point (`app/engine/combat/interaction.py`)

`start_combat()` → `engage()` → creates combat controller:
- `MapCombat` — Map-view combat
- `AnimationCombat` — Full battle animation (1v1)
- `SimpleCombat` — Instant/skip

### 7.2 CombatPhaseSolver (`app/engine/combat/solver.py`, 588 lines)

State machine: `Init → Attacker → Defender → (double?) → Done`

Strike order: Attacker → (brave?) → Defender counter → (brave?) →
Attacker double → Defender double.

`process()` handles a single strike: compute hit → RNG roll → hit/miss/crit →
call hooks (`on_hit`, `on_crit`, `on_miss`, `after_strike`).

**RNG Modes**: Classic (1 roll), True Hit (avg of 2), True Hit+ (avg of 3),
Grandmaster (always hits).

### 7.3 Combat Calculations (`app/engine/combat_calcs.py`)

`compute_hit()`, `compute_damage()`, `compute_crit()`,
`compute_attack_phases()` (doubling), `compute_multiattacks()` (brave),
`can_counterattack()`.

---

## 8. AI System (`app/engine/ai_controller.py`, 886 lines)

### 8.1 AIController

State machine: `Init → Primary/Secondary → Done`

`act()` → `think()` → `move()` → `attack()` → `canto_retreat()`

### 8.2 AI Behaviours

Each `AIBehaviour` has:
- `action`: Attack, Support, Steal, Interact, Move_to, Move_away_from, Wait
- `target`: Enemy, Ally, Unit, Position, Event, Terrain, Time
- `target_spec`: All, Class, Tag, Name, Team, Faction, Party, ID
- `view_range`: -1 (guard), -2 (single move), -3 (double move), -4 (entire map)
- `condition`: Python expression string

### 8.3 PrimaryAI

Evaluates all `item × target × move` combinations. Utility =
`offense_term * offense_bias + defense_term * (1 - offense_bias)`.

### 8.4 AI Groups

Units in the same AI group coordinate activation. When one triggers,
all others in the group also activate.

---

## 9. Event System

### 9.1 Event Commands (`app/events/event_commands.py`, ~256 classes)

Key command categories:
- **Flow**: `if`, `elif`, `else`, `end`, `for`, `endf`, `finish`, `wait`
- **Music**: `music`, `music_clear`, `sound`, `change_music`
- **Portrait**: `add_portrait`, `remove_portrait`, `move_portrait`, `expression`
- **BG/FG**: `transition`, `change_background`
- **Dialog**: `speak`, `narrate`, `unhold`
- **Cursor/Camera**: `disp_cursor`, `move_cursor`, `center_cursor`
- **Variables**: `game_var`, `inc_game_var`, `level_var`, `win_game`, `lose_game`
- **Tilemap**: `show_layer`, `hide_layer`, `add_weather`, `change_tilemap`
- **Region**: `add_region`, `remove_region`
- **Units**: `load_unit`, `create_unit`, `add_unit`, `move_unit`, `remove_unit`, `kill_unit`
- **Unit Props**: `change_stats`, `set_stats`, `add_tag`, `change_team`, `change_class`
- **Items**: `give_item`, `remove_item`
- **Skills**: `give_skill`, `remove_skill`
- **Groups**: `spawn_group`, `move_group`, `remove_group`
- **Misc**: `shop`, `choice`, `prep`, `base`, `alert`

Commands serialize as semicolon-delimited: `nid;param1;param2;flag1`.

### 9.2 Event Triggers (~35+ types)

Key triggers: `level_start`, `level_end`, `turn_change`, `enemy_turn_change`,
`phase_change`, `combat_start`, `combat_end`, `combat_death`, `unit_death`,
`unit_wait`, `unit_select`, `unit_level_up`, `on_talk`, `on_support`,
`on_region_interact`, `on_prep_start`, `on_base_start`.

### 9.3 Event Manager

`game.events.trigger(trigger_object)` checks if any event matches the
trigger's NID and condition. Events are queued and processed by `EventState`.

---

## 10. Map / Tilemap System

### 10.1 TileMapObject (`app/engine/objects/tilemap.py`)

Layers: each has `terrain_grid` (pos → terrain NID), `sprite_grid`
(pos → [tileset_nid, [col, row]]), `visible`, `foreground` flags.

`get_terrain(pos)` checks visible layers top-down.
`background_layers()` / `foreground_layers()` filter by `foreground` flag.

### 10.2 Regions

Types: NORMAL, STATUS, EVENT, FORMATION, FOG, VISION, TERRAIN.
Fields: `nid`, `region_type`, `position`, `size`, `sub_nid`, `condition`.

---

## 11. Important Conventions

1. **NID vs UID**: NIDs are name strings. UIDs are auto-incrementing ints for items/skills.
2. **Colorkey**: Sprite background is `(128, 160, 128)`, applied via `set_colorkey()`.
3. **Singleton pattern**: `game = GameState()`, `DB = Database()`, `RESOURCES`.
4. **`__getattr__` fallback**: Unit/Item/Skill objects fall back to DB prefabs.
5. **Code generation**: `item_system.py` and `skill_system.py` are generated — don't edit directly.
6. **Semicolon events**: Event commands serialize as `nid;param1;param2`.
7. **wexp_gain format**: In unit JSON, this is `{"Sword": {"usable": true, "wexp_gain": 1, "cap": 251}}`. In class JSON, same structure.
