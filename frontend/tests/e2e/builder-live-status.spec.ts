import { expect, test, type Response } from '@playwright/test';

import {
  openDashboard,
  seedSophiaBrowserState,
  switchToTextMode,
} from './live-sophia.helpers';

test.skip(
  process.env.SOPHIA_E2E_TEST_AUTH !== 'true' || process.env.NEXT_PUBLIC_DEV_BYPASS_AUTH !== 'false',
  'Requires Better Auth E2E mode with auth bypass disabled.',
);

test.describe.configure({ mode: 'serial' });

type BuilderTaskUpdate = {
  taskId: string | null;
  status: string | null;
  detail: string | null;
  builderResultPresent: boolean;
};

function isBuilderTaskResponse(response: Response): boolean {
  return response.url().includes('/api/sophia/tasks/') && response.request().method().toUpperCase() === 'GET';
}

test('session UI polls builder task to completion', async ({ page }, testInfo) => {
  test.setTimeout(300_000);

  const taskUpdates: BuilderTaskUpdate[] = [];

  page.on('response', async (response) => {
    if (!isBuilderTaskResponse(response)) {
      return;
    }

    try {
      const payload = await response.json() as {
        task_id?: unknown;
        status?: unknown;
        detail?: unknown;
        builder_result?: unknown;
      };

      taskUpdates.push({
        taskId: typeof payload.task_id === 'string' ? payload.task_id : null,
        status: typeof payload.status === 'string' ? payload.status : null,
        detail: typeof payload.detail === 'string' ? payload.detail : null,
        builderResultPresent: payload.builder_result != null,
      });
    } catch {
      // Ignore malformed polling responses in the capture; the assertions below will fail if needed.
    }
  });

  await seedSophiaBrowserState(page);

  const loginResponse = await page.request.post('/api/test-auth/login', {
    data: {
      email: 'builder-smoke@example.com',
      name: 'Builder Smoke User',
      accountId: 'google-builder-smoke',
    },
  });

  expect(loginResponse.ok()).toBeTruthy();

  await openDashboard(page);

  await page.locator('[data-onboarding="mic-cta"]').first().click();

  const startFreshButton = page.getByRole('button', { name: /start fresh/i }).first();
  if (await startFreshButton.isVisible({ timeout: 1_500 }).catch(() => false)) {
    await startFreshButton.click();
  }

  await page.waitForURL(/\/session(\/|\?|$)/, { timeout: 45_000, waitUntil: 'commit' });
  await expect(page.getByRole('tablist', { name: /interaction mode/i })).toBeVisible({ timeout: 60_000 });
  await switchToTextMode(page);

  const messageInput = page.getByLabel('Message input');
  await messageInput.fill(
    "Please use the builder to create a one-page project brief titled 'Voice Transport Migration Status' with sections Goal, Current State, Risks, and Next Steps. Keep it concise.",
  );
  await messageInput.press('Enter');
  await expect(page.getByText('sophia is reflecting...')).toBeVisible({ timeout: 15_000 });

  const deadline = Date.now() + 220_000;
  let terminalUpdate: BuilderTaskUpdate | null = null;

  while (Date.now() < deadline) {
    const lastUpdate = taskUpdates.at(-1) ?? null;

    if (lastUpdate && ['completed', 'failed', 'cancelled', 'timed_out'].includes(lastUpdate.status ?? '')) {
      terminalUpdate = lastUpdate;
      break;
    }

    await page.waitForTimeout(2_000);
  }

  await testInfo.attach('builder-task-updates.json', {
    body: JSON.stringify(taskUpdates, null, 2),
    contentType: 'application/json',
  });

  expect(taskUpdates.length, 'Expected the session UI to poll the builder task status endpoint.').toBeGreaterThan(0);
  expect(terminalUpdate, 'Expected a terminal builder task status from the session UI polling.').toBeTruthy();
  expect(terminalUpdate?.status).toBe('completed');
  expect(terminalUpdate?.builderResultPresent).toBe(true);
});