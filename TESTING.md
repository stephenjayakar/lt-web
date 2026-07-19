# Testing

Visual testing harness for the Lex Talionis web engine using Playwright.

Since most bugs in this engine are visual (rendering glitches, sprite issues,
tile misalignment), the test strategy uses **browser-based screenshot capture**
rather than unit tests on pure logic.

---

## Quick Start

```bash
# Install Playwright (one-time)
npm install
npx playwright install chromium

# Run all visual tests
npx playwright test

# Run Sacred Stones reliability soak loop (defaults to 5 iterations)
npm run test:ss:soak

# Custom soak loop size / filter
SOAK_ITERATIONS=20 SOAK_GREP="Sacred Stones Chapter Mechanics|Level Progression" npm run test:ss:soak

# Run with visible browser (useful for debugging)
npx playwright test --headed

# Run a specific test
npx playwright test -g "cursor movement"

# View HTML report after a run
npx playwright show-report
```

Screenshots are saved to `test-screenshots/`.

---

## How It Works

### The Harness (`src/harness.ts`)

When the game is loaded with `?harness=true`, the normal `requestAnimationFrame`
game loop is **replaced** with a programmatic API exposed on `window.__harness`:

| Method | Description |
|--------|-------------|
| `stepFrames(n, input?)` | Advance N frames, optionally injecting an input on the first frame |
| `screenshot()` | Capture the canvas as a PNG data URL |
| `getState()` | Get a snapshot of game state (units, cursor, current state name) |
| `injectInput(button)` | Queue an input for the next `stepFrames` call |
| `loadLevel(nid)` | Load a level with events (level_start triggers normally) |
| `loadLevelClean(nid)` | Load a level, skip all events, go straight to `free` state |
| `settle(maxFrames)` | Auto-advance through events/menus until reaching `free` state |
| `giveItem(unitNid, itemNid)` | Give a DB item to a unit (returns `true` on success). Item is inserted at front of inventory so it becomes equipped. |

### Sacred Stones Reliability Soak

`npm run test:ss:soak` runs a repeated Playwright pass over Sacred Stones-heavy
suites and fails on the first non-deterministic regression.

- Defaults: `SOAK_ITERATIONS=5`, `SOAK_WORKERS=1`
- Default grep:
  `Sacred Stones Later Chapters|Sacred Stones Chapter Mechanics|Level Progression`
- Override with env vars to expand/target specific suites.

**Deterministic seed sweep.** The engine's RNG seed (`_random_seed` in
`game.gameVars`, consumed by `src/engine/static-random.ts` and
`src/engine/leveling.ts`) defaults to `0` for every page load unless a test
sets it explicitly. Set `SOAK_SEED_BASE=<int>` to sweep a distinct seed per
iteration (`SOAK_SEED_BASE + iterationIndex`), exercising different
combat/growth RNG sequences across the sweep instead of re-running the same
seed-0 path every time:

```bash
# Sweep seeds 1000, 1001, 1002 across 3 iterations
SOAK_ITERATIONS=3 SOAK_SEED_BASE=1000 npm run test:ss:soak

# Or use the pre-wired alias (base seed 1000)
npm run test:soak:seeded
```

Seed threading mechanism: before each iteration, the soak script writes
`public/soak-seed.json` (`{"seed": N}`). `src/main.ts`'s harness bootstrap
fetches `/soak-seed.json` (via Vite's static `public/` serving) whenever the
page doesn't already have an explicit `?seed=` query param, and applies it by
setting `_random_seed` and clearing the derived `_combat_random_seed` /
`_growth_random_seed` state before the level loads. This means unmodified
spec files -- whose `page.goto('/?harness=true&...')` calls don't carry a
seed -- still pick up a distinct, fully reproducible seed per iteration with
no per-spec changes. Tests that explicitly call
`game.gameVars.set('_random_seed', N)` themselves (e.g. `rng-replay.spec.ts`)
are unaffected -- their explicit call happens later and simply overrides
whatever the soak sweep set. The seed file is removed after the soak run (and
between iterations when `SOAK_SEED_BASE` is unset), so a normal
`npx playwright test` run never sees it (`/soak-seed.json` 404s harmlessly).

**First-failure archiving.** On the first failing iteration, the soak script
stops (fail-fast, unchanged) and archives everything needed to reproduce it
under `soak-artifacts/<ISO-timestamp>/`:

| File | Contents |
|------|----------|
| `SUMMARY.txt` | Iteration number, grep, workers, seed, and a ready-to-paste repro command |
| `env.json` | Structured version of the same (iteration, grep, workers, seed, raw `SOAK_*` env) |
| `playwright-output.log` | Full stdout+stderr of the failing `npx playwright test` invocation |
| `soak-seed.json` | The exact seed file used for that iteration (if seeding was active) |
| `test-results/` | A copy of Playwright's `test-results/` (traces/screenshots, if enabled in `playwright.config.ts`) at the moment of failure |

`soak-artifacts/` is gitignored -- it's meant to be inspected locally (or
uploaded from CI) after a red soak run, not committed.

### URL Parameters

| Param | Default | Description |
|-------|---------|-------------|
| `harness` | `false` | Enable the test harness (set to `true`) |
| `level` | `DEBUG` | Level NID to load (`0`=Prologue, `1`=Ch.1, ..., `DEBUG`) |
| `clean` | `true` | Skip `level_start` events (go straight to map gameplay) |
| `bundle` | `true` | Use asset bundle (set to `false` for dev) |

### Example: Manual Browser Testing

Start the dev server and open a harness URL:

```bash
npm run dev
# Then open: http://localhost:5173/?harness=true&level=0&bundle=false
```

In the browser console:

```js
// Step 10 frames
__harness.stepFrames(10)

// Move cursor right
__harness.stepFrames(5, 'RIGHT')

// Select
__harness.stepFrames(5, 'SELECT')

// Take a screenshot (returns data URL)
await __harness.screenshot()

// Check game state
__harness.getState()

// Auto-advance through events
__harness.settle(500)
```

Valid input buttons: `UP`, `DOWN`, `LEFT`, `RIGHT`, `SELECT`, `BACK`, `INFO`, `AUX`, `START`

---

## Test Structure

Tests live in `tests/harness.spec.ts`:

```
tests/
  harness.spec.ts    -- Playwright test scenarios
test-screenshots/    -- Captured PNGs (not committed)
playwright.config.ts -- Playwright config (uses Vite dev server)
```

### Current Test Scenarios

**DEBUG Level (clean mode)**
- Initial map render
- Cursor movement
- Unit selection + movement range highlights
- Action menu open/close

**Prologue (clean mode)**
- Initial map render
- Cursor navigation to boss unit

**Magic Sword Combat**
- Give Eirika a Light Brand (magic sword with `battle_cast_anim`), attack adjacent enemy, verify combat resolves without freezing and damage is dealt

**Prologue (with events)**
- Event state rendering (intro cutscene)

---

## Adding New Tests

```typescript
test('my new scenario', async ({ page }) => {
  // Load a level in clean mode (no events)
  await page.goto('/?harness=true&level=0&bundle=false');
  await waitForHarness(page);

  // Step frames to render
  await stepFrames(page, 10);

  // Move cursor
  await stepFrames(page, 5, 'RIGHT');

  // Check state
  const state = await getState(page);
  expect(state.currentStateName).toBe('free');

  // Save screenshot
  await saveScreenshot(page, 'my-scenario');
});
```

### Testing Combat and Gameplay

To test combat scenarios (e.g. verifying a weapon type doesn't freeze), use
`giveItem` to equip units with specific weapons, then drive the UI through
the combat flow:

```typescript
test('magic sword combat works', async ({ page }) => {
  await page.goto('/?harness=true&level=DEBUG&bundle=false');
  await waitForHarness(page);
  await stepFrames(page, 5);

  // Give Eirika a Light Brand (magic sword with battle_cast_anim)
  const given = await giveItem(page, 'Eirika', 'Light_Brand');
  expect(given).toBe(true);

  // Navigate to Eirika at (2,6), Bone (enemy) is adjacent at (2,5)
  await navigateCursorTo(page, 2, 6, ...state.cursorPos);

  // SELECT unit -> move state -> SELECT same tile -> menu
  // -> SELECT "Attack" -> weapon_choice -> SELECT weapon -> targeting
  // -> SELECT target -> combat
  await stepFrames(page, 3, 'SELECT');  // select unit
  await stepFrames(page, 10);
  await stepFrames(page, 3, 'SELECT');  // confirm position
  await stepFrames(page, 10);
  await stepFrames(page, 3, 'SELECT');  // pick "Attack"
  await stepFrames(page, 10);
  await stepFrames(page, 3, 'SELECT');  // pick weapon (if weapon_choice)
  await stepFrames(page, 10);
  await stepFrames(page, 3, 'SELECT');  // confirm target

  // Run frames until combat resolves, pressing BACK to dismiss post-combat menus
  for (let batch = 0; batch < 200; batch++) {
    await stepFrames(page, 20);
    const s = await getState(page);
    if (s.currentStateName === 'free') break;
    // After combat ends, BACK dismisses leftover menus
    await stepFrames(page, 3, 'BACK');
  }
});
```

**Key state flow for combat:** `free → move → menu → weapon_choice → targeting → combat → (post-combat) → free`

The DEBUG level has these useful adjacencies for combat testing:
- **Eirika (player, 2,6)** is adjacent to **Bone (enemy, 2,5)** — immediate melee combat
- **Seth (player, 5,4)** has MOV 8 and can reach most enemies in one turn
- **Generic Shaman (player, 4,6)** has Flux/Luna (magic weapons) for testing spell combat

### Tips

- Use `clean` mode (default) to skip events and test map rendering directly
- Use `clean=false` when testing event rendering / cutscenes
- `settle()` auto-presses SELECT through events/menus -- use it to skip intros
- The DEBUG level is small (7 units) and fast to load -- ideal for quick iteration
- Screenshots are full-page captures at 480x320 (2x the GBA resolution)
- Use `giveItem` to test specific weapons — item NIDs match filenames in `lt-maker/default.ltproj/game_data/items/` (e.g. `Light_Brand`, `Wind_Sword`, `Runesword`)
