import { defineConfig, devices } from '@playwright/test';
import { join } from 'node:path';

/**
 * playwright.config.ts — the e2e tier (ADR-005 keeps the UI framework-free, so
 * these run against real pages rather than a component harness).
 *
 * Two deliberate choices:
 *
 * 1. The server under test is the BUNDLED dist/crux.cjs, not index.ts. e2e is
 *    the last gate before shipping, so it should exercise the artifact that
 *    actually ships — including the esbuild step that inlines ui/* into the
 *    binary. A UI file missing from the inline list would pass every unit test
 *    and 404 here, which is exactly the bug worth catching.
 *
 * 2. The server runs against a throwaway HOME, so it opens a fresh
 *    $HOME/.crux/crux.db seeded by scripts/e2e-seed.mjs. Without this the suite
 *    would read the developer's real database — and the screenshots would
 *    publish whatever happened to be in it.
 */

const PORT      = Number(process.env.CRUX_E2E_PORT ?? 8765);
const BASE_URL  = `http://127.0.0.1:${PORT}`;
const FIXTURE_HOME = process.env.CRUX_E2E_HOME ?? join(process.cwd(), '.e2e-home');

export default defineConfig({
  testDir: 'test/e2e',
  // Screenshots are build artifacts, not assertions — see the note on
  // pixel-diffing in test/e2e/theme.spec.ts.
  outputDir: 'test/e2e/.output',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],

  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    // Fixed viewport so screenshots are comparable between runs and themes.
    viewport: { width: 1440, height: 900 },
  },

  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],

  webServer: {
    command: `node scripts/e2e-seed.ts && node dist/crux.cjs ui --no-open --port ${PORT}`,
    url: BASE_URL,
    reuseExistingServer: false,
    timeout: 60_000,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { HOME: FIXTURE_HOME, CRUX_E2E_HOME: FIXTURE_HOME },
  },
});
