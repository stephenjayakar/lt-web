import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  // Resource-heavy project boots and long event simulations can exceed one
  // minute when the complete serial suite has kept the browser worker busy.
  // Keep assertion-specific waits narrow, but give each integration scenario
  // enough total time to finish under sustained release-gate load.
  timeout: 120_000,
  retries: 0,
  use: {
    baseURL: 'http://localhost:5173',
    // Use a fixed viewport so screenshots are deterministic
    viewport: { width: 480, height: 320 },
    screenshot: 'off',
  },
  webServer: {
    command: 'npm run dev -- --port 5173',
    port: 5173,
    reuseExistingServer: true,
    timeout: 30_000,
  },
  // Store screenshots in a dedicated directory
  outputDir: './test-results',
  snapshotDir: './test-snapshots',
});
