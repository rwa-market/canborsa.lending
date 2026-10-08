import { defineConfig, devices } from '@playwright/test'

/**
 * E2E against Canton DevNet: local DevNet backend and Vite (http://localhost:5173) or prod.
 *   E2E_BASE_URL=https://lending.… pnpm --filter @lending/frontend e2e
 * loop.spec.ts: Loop wallet with SDK and /api mocks, against Vite only (no backend);
 * mobile.spec.ts: phone screen as a guest;
 * devnet.spec.ts: node wallet and service roles: E2E_NODE_USER and E2E_NODE_PASSWORD.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 300_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:5173',
    trace: 'retain-on-failure',
  },
  // loop.spec.ts needs only Vite (its API is mocked): started here unless E2E_BASE_URL points
  // elsewhere; a dev server already on :5173 is reused
  ...(process.env.E2E_BASE_URL
    ? {}
    : {
        webServer: {
          command: 'pnpm exec vite --port 5173 --strictPort',
          url: 'http://localhost:5173',
          reuseExistingServer: true,
          timeout: 120_000,
        },
      }),
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] }, testIgnore: /mobile\.spec\.ts/ },
    { name: 'mobile', use: { ...devices['Pixel 7'] }, testMatch: /mobile\.spec\.ts/ },
  ],
})
