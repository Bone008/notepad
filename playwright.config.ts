import { defineConfig } from '@playwright/test';

const PORT = 3123;

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
  },
  webServer: {
    command: `NOTEPAD_CREATE_SECRET=e2e NOTEPAD_DB=:memory: NOTEPAD_RATE_LIMITS=0 PORT=${PORT} node server/dist/index.js`,
    url: `http://localhost:${PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 30_000,
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
