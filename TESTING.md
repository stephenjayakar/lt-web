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

### Tips

- Use `clean` mode (default) to skip events and test map rendering directly
- Use `clean=false` when testing event rendering / cutscenes
- `settle()` auto-presses SELECT through events/menus -- use it to skip intros
- The DEBUG level is small (7 units) and fast to load -- ideal for quick iteration
- Screenshots are full-page captures at 480x320 (2x the GBA resolution)
