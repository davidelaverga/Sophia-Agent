import { type Page, expect, test } from '@playwright/test';

import { seedSophiaBrowserState } from './live-sophia.helpers';

test.skip(
  process.env.SOPHIA_E2E_TEST_AUTH !== 'true' || process.env.NEXT_PUBLIC_DEV_BYPASS_AUTH !== 'false',
  'Requires Better Auth E2E mode with auth bypass disabled.',
);

async function primeConsent(page: Page) {
  await page.addInitScript(() => {
    window.localStorage.setItem('sophia_consent_accepted', 'true');
  });
}

test('real login smoke seeds a Better Auth session and unlocks the dashboard', async ({ page }) => {
  test.setTimeout(120_000);

  await seedSophiaBrowserState(page);
  await primeConsent(page);

  await page.goto('/');
  await expect(page.getByRole('button', { name: /google/i })).toBeVisible({ timeout: 15_000 });

  const beforeAuthResponse = await page.request.get('/api/auth/me');
  expect(beforeAuthResponse.ok()).toBeTruthy();
  await expect(beforeAuthResponse.json()).resolves.toEqual({
    authenticated: false,
    user: null,
  });

  const loginResponse = await page.request.post('/api/test-auth/login', {
    data: {
      email: 'auth-smoke@example.com',
      name: 'Auth Smoke User',
      accountId: 'google-auth-smoke',
    },
  });

  expect(loginResponse.ok()).toBeTruthy();
  await expect(loginResponse.json()).resolves.toEqual(
    expect.objectContaining({
      ok: true,
      user: expect.objectContaining({
        email: 'auth-smoke@example.com',
        name: 'Auth Smoke User',
      }),
    }),
  );

  const backendSyncResponsePromise = page.waitForResponse((response) => {
    return response.url().includes('/api/auth/sync-backend') && response.request().method() === 'POST';
  });

  await page.goto('/');

  const backendSyncResponse = await backendSyncResponsePromise;
  expect(backendSyncResponse.ok()).toBeTruthy();

  await expect(page.locator('[data-onboarding="mic-cta"]').first()).toBeVisible({ timeout: 20_000 });

  const afterAuthResponse = await page.request.get('/api/auth/me');
  expect(afterAuthResponse.ok()).toBeTruthy();
  await expect(afterAuthResponse.json()).resolves.toEqual(
    expect.objectContaining({
      authenticated: true,
      user: expect.objectContaining({
        email: 'auth-smoke@example.com',
      }),
    }),
  );
});