import { defineConfig, devices } from '@playwright/test';

const port = Number(process.env.PORT ?? 3000);
const host = process.env.PLAYWRIGHT_TEST_HOST ?? '127.0.0.1';
const baseURL =
  process.env.PLAYWRIGHT_TEST_BASE_URL ??
  process.env.E2E_BASE_URL ??
  `http://${host}:${port}`;

const webServerEnv = {
  ...process.env,
  NEXT_PUBLIC_DEV_BYPASS_AUTH: process.env.NEXT_PUBLIC_DEV_BYPASS_AUTH ?? 'true',
  NEXT_PUBLIC_SOPHIA_USER_ID: process.env.NEXT_PUBLIC_SOPHIA_USER_ID ?? 'e2e-user',
  NEXT_PUBLIC_GATEWAY_URL: process.env.NEXT_PUBLIC_GATEWAY_URL ?? 'http://localhost:8001',
  SOPHIA_LANGGRAPH_BASE_URL: process.env.SOPHIA_LANGGRAPH_BASE_URL ?? 'http://127.0.0.1:2024',
};

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  expect: {
    timeout: 10_000,
  },
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL,
    headless: true,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    // E2E runs against the real app shell but bypasses external OAuth.
    command: `pnpm exec next dev --hostname ${host} --port ${port}`,
    url: baseURL,
    env: webServerEnv,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});