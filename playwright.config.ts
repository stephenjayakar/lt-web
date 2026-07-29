import { defineConfig } from '@playwright/test';

const port = Number(process.env.PLAYWRIGHT_PORT ?? 5173);

export default defineConfig({
  testDir: './tests',
  // Resource-heavy project boots and long event simulations can exceed one
  // minute when the complete serial suite has kept the browser worker busy.
  // Keep assertion-specific waits narrow, but give each integration scenario
  // enough total time to finish under sustained release-gate load.
  timeout: 120_000,
  retries: 0,
  // Workers default to half the cores, which runs spec files concurrently.
  // Files with independent cases opt into parallel mode themselves; files that
  // build state across cases remain ordered. `npm test` excludes @milestone
  // campaign sweeps; `npm run test:release` is the full single-worker gate.
  //
  // Anything sensitive to wall-clock pacing must wait on observable state
  // rather than a fixed sleep — under concurrency a frame can arrive far
  // later than it does on an idle machine.
  use: {
    baseURL: `http://localhost:${port}`,
    // Use a fixed viewport so screenshots are deterministic
    viewport: { width: 480, height: 320 },
    screenshot: 'off',
  },
  webServer: {
    command: `npm run dev -- --port ${port}`,
    port,
    reuseExistingServer: true,
    timeout: 30_000,
  },
  // Store screenshots in a dedicated directory
  outputDir: './test-results',
  snapshotDir: './test-snapshots',
});
