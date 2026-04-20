import { expect, test, type Page } from '@playwright/test';

const ONBOARDING_STORAGE_KEY = 'sophia-onboarding-v2';
const LEGACY_ONBOARDING_STORAGE_KEY = 'sophia-onboarding';
const CAPTURE_FLAG_STORAGE_KEY = 'sophia.capture.enabled';

const END_SESSION_PATHS = ['/api/sophia/end-session', '/api/sessions/end'] as const;

type RitualType = 'prepare' | 'debrief' | 'reset' | 'vent';

export type CaptureEvent = {
  seq: number;
  recordedAt: string;
  category: string;
  name: string;
  payload?: unknown;
};

export type JournalEntry = {
  id: string;
  content: string;
  category: string | null;
  created_at: string | null;
  metadata: Record<string, unknown> | null;
};

export type JournalResponse = {
  entries: JournalEntry[];
  count: number;
};

type CaptureBridge = {
  enable?: () => void;
  clear?: () => void;
  export?: () => unknown;
  getEvents?: () => CaptureEvent[];
};

type SeedBrowserStateOptions = {
  enableCapture?: boolean;
};

function isEndSessionRequest(url: string): boolean {
  return END_SESSION_PATHS.some((path) => url.includes(path));
}

export async function seedSophiaBrowserState(
  page: Page,
  options: SeedBrowserStateOptions = {},
): Promise<void> {
  const { enableCapture = false } = options;

  await page.addInitScript(({ captureEnabled, onboardingStorageKey, legacyStorageKey, captureStorageKey }) => {
    const completedOnboarding = {
      state: {
        firstRun: {
          status: 'completed',
          currentStepId: null,
          completedSteps: [],
          skippedAt: null,
          completedAt: new Date().toISOString(),
        },
        contextualTips: {},
        preferences: {
          voiceOverEnabled: true,
          reducedMotion: true,
        },
        legacyStep: 'complete',
      },
      version: 2,
    };

    try {
      window.localStorage.removeItem(legacyStorageKey);
      window.localStorage.removeItem('sophia-session-bootstrap');
      window.localStorage.removeItem('sophia-session-store');
      window.localStorage.removeItem('sophia-session');

      for (const key of Object.keys(window.localStorage)) {
        if (key.startsWith('sophia.session.snapshot')) {
          window.localStorage.removeItem(key);
        }
      }

      window.localStorage.setItem(onboardingStorageKey, JSON.stringify(completedOnboarding));

      if (captureEnabled) {
        window.localStorage.setItem(captureStorageKey, '1');
      } else {
        window.localStorage.removeItem(captureStorageKey);
      }
    } catch {
      // Ignore localStorage bootstrap failures in E2E setup.
    }
  }, {
    captureEnabled: enableCapture,
    onboardingStorageKey: ONBOARDING_STORAGE_KEY,
    legacyStorageKey: LEGACY_ONBOARDING_STORAGE_KEY,
    captureStorageKey: CAPTURE_FLAG_STORAGE_KEY,
  });
}

export async function ensureDashboardReadyOrSkip(page: Page): Promise<void> {
  const deadline = Date.now() + 30_000;

  while (Date.now() < deadline) {
    const micButton = page.locator('[data-onboarding="mic-cta"]').first();
    if (await micButton.isVisible({ timeout: 500 }).catch(() => false)) {
      return;
    }

    const loginButton = page.getByRole('button', { name: /discord/i });
    if (await loginButton.isVisible({ timeout: 500 }).catch(() => false)) {
      test.skip(
        true,
        'AuthGate activo. Pasa un storageState autenticado (PW_STORAGE_STATE) para ejecutar estos E2E.',
      );
      return;
    }

    const consentAccept = page.getByRole('button', { name: /I agree|accept|aceptar/i }).first();
    if (await consentAccept.isVisible({ timeout: 300 }).catch(() => false)) {
      await consentAccept.click().catch(() => {});
    }

    await page.waitForTimeout(300);
  }

  const stillLoading = await page
    .getByText(/Opening a gentle space/i)
    .first()
    .isVisible()
    .catch(() => false);

  test.skip(
    stillLoading,
    'AuthGate quedó en loading (Opening a gentle space...). Provee sesión autenticada o storageState para E2E.',
  );

  await expect(page.locator('[data-onboarding="mic-cta"]').first()).toBeVisible({ timeout: 10_000 });
}

export async function openDashboard(page: Page): Promise<void> {
  await page.goto('/');
  await ensureDashboardReadyOrSkip(page);
}

export async function startSessionFromDashboard(
  page: Page,
  options: { ritual?: RitualType } = {},
): Promise<void> {
  if (options.ritual) {
    await page.locator(`[data-ritual="${options.ritual}"]`).first().click();
  }

  await page.locator('[data-onboarding="mic-cta"]').first().click();

  const replaceStartFresh = page.getByRole('button', { name: /start fresh/i }).first();
  if (await replaceStartFresh.isVisible({ timeout: 1_200 }).catch(() => false)) {
    await replaceStartFresh.click();
  }

  await page.waitForURL(/\/session(\/|\?|$)/, { timeout: 20_000 });
  await expect(page.getByRole('tablist', { name: /interaction mode/i })).toBeVisible({ timeout: 10_000 });
}

export async function switchToTextMode(page: Page): Promise<void> {
  const textTab = page.getByRole('tab', { name: 'text' });
  if ((await textTab.getAttribute('aria-selected')) !== 'true') {
    await textTab.click({ force: true });
  }

  await expect(textTab).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByLabel('Message input')).toBeVisible({ timeout: 10_000 });
}

export async function sendTextTurn(page: Page, message: string): Promise<void> {
  const chatResponse = page.waitForResponse((response) => {
    return (
      response.request().method().toUpperCase() === 'POST' &&
      response.url().includes('/api/chat')
    );
  }, { timeout: 30_000 });

  await page.getByLabel('Message input').fill(message);
  await page.getByLabel('Send message').click();

  await chatResponse;

  const reflectingIndicator = page.getByText('sophia is reflecting...').first();
  if (await reflectingIndicator.isVisible({ timeout: 2_500 }).catch(() => false)) {
    await reflectingIndicator.waitFor({ state: 'hidden', timeout: 45_000 }).catch(() => {});
    return;
  }

  await page.waitForTimeout(6_000);
}

export async function endSession(page: Page): Promise<void> {
  const endRequest = page.waitForResponse((response) => {
    return (
      response.request().method().toUpperCase() === 'POST' &&
      isEndSessionRequest(response.url())
    );
  }, { timeout: 20_000 });

  const headerEndButton = page.locator('button[title="End session"]').first();
  await expect(headerEndButton).toBeVisible({ timeout: 10_000 });
  await headerEndButton.click();

  const confirmEndButton = page.getByRole('button', { name: /^end session$/i }).first();
  await expect(confirmEndButton).toBeVisible({ timeout: 5_000 });
  await confirmEndButton.click();

  const leaveAnywayButton = page.getByRole('button', { name: /leave anyway/i }).first();
  const leaveAnywayVisible = await Promise.race([
    leaveAnywayButton.waitFor({ state: 'visible', timeout: 4_000 }).then(() => true).catch(() => false),
    endRequest.then(() => false).catch(() => false),
  ]);

  if (leaveAnywayVisible) {
    await leaveAnywayButton.click({ force: true });
  }

  await endRequest;

  const feedbackSkipButton = page.getByRole('button', { name: /^skip$/i }).first();
  if (await feedbackSkipButton.isVisible({ timeout: 8_000 }).catch(() => false)) {
    await feedbackSkipButton.click();
    await page.waitForTimeout(800);
  }

  const continueSummary = page.getByText('tap to continue').first();
  if (await continueSummary.isVisible({ timeout: 12_000 }).catch(() => false)) {
    await continueSummary.click();
    await page.waitForTimeout(800);
  }

  const skipToRecapButton = page.getByRole('button', { name: /skip to recap/i }).first();
  if (await skipToRecapButton.isVisible({ timeout: 5_000 }).catch(() => false)) {
    await skipToRecapButton.click();
  }
}

export async function keepAllRecapMemories(page: Page, maxRounds = 12): Promise<number> {
  let keptCount = 0;

  for (let round = 0; round < maxRounds; round += 1) {
    const introButton = page.getByRole('button', { name: 'Got it' }).first();
    if (await introButton.isVisible({ timeout: 500 }).catch(() => false)) {
      await introButton.click({ force: true });
      await page.waitForTimeout(500);
      continue;
    }

    const saveButton = page.locator('[data-onboarding="recap-memory-save"]').first();
    if (await saveButton.isVisible({ timeout: 500 }).catch(() => false)) {
      return keptCount;
    }

    const retryButton = page.getByRole('button', { name: /^retry$/i }).first();
    if (await retryButton.isVisible({ timeout: 500 }).catch(() => false)) {
      await retryButton.click({ force: true });
      await page.waitForTimeout(1_200);
      continue;
    }

    const processingHeading = page.getByRole('heading', { name: /recap is still processing/i }).first();
    if (await processingHeading.isVisible({ timeout: 500 }).catch(() => false)) {
      await page.waitForTimeout(1_200);
      continue;
    }

    const emptyState = page.getByText('No new memories from this session.').first();
    if (await emptyState.isVisible({ timeout: 500 }).catch(() => false)) {
      return keptCount;
    }

    const keepButton = page.getByLabel('Keep this memory').first();
    if (!(await keepButton.isVisible({ timeout: 1_500 }).catch(() => false))) {
      await page.waitForTimeout(900);
      continue;
    }

    await keepButton.click();
    keptCount += 1;
    await page.waitForTimeout(900);
  }

  await expect(page.locator('[data-onboarding="recap-memory-save"]').first()).toBeVisible({ timeout: 10_000 });
  return keptCount;
}

export function parseHighlightIdsFromUrl(page: Page): string[] {
  const url = new URL(page.url());
  const rawValue = url.searchParams.get('highlight');
  if (!rawValue) {
    return [];
  }

  return rawValue
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

export async function fetchJournal(page: Page): Promise<JournalResponse> {
  const response = await page.request.get('/api/journal');
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as JournalResponse;
}

export async function enableCaptureBridge(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const capture = (window as Window & { __sophiaCapture?: CaptureBridge }).__sophiaCapture;
    return Boolean(capture);
  });

  await page.evaluate(() => {
    const capture = (window as Window & { __sophiaCapture?: CaptureBridge }).__sophiaCapture;
    capture?.enable?.();
    capture?.clear?.();
  });
}

export async function waitForCaptureEvent(
  page: Page,
  expected: { category?: string; name: string },
  timeout = 45_000,
): Promise<void> {
  await page.waitForFunction(({ category, name }) => {
    const capture = (window as Window & { __sophiaCapture?: CaptureBridge }).__sophiaCapture;
    const events = capture?.getEvents?.() ?? [];

    return events.some((event) => event.name === name && (!category || event.category === category));
  }, expected, { timeout });
}

export async function getCaptureEvents(page: Page): Promise<CaptureEvent[]> {
  return page.evaluate(() => {
    const capture = (window as Window & { __sophiaCapture?: CaptureBridge }).__sophiaCapture;
    return capture?.getEvents?.() ?? [];
  });
}

export async function exportCapture(page: Page): Promise<unknown> {
  return page.evaluate(() => {
    const capture = (window as Window & { __sophiaCapture?: CaptureBridge }).__sophiaCapture;
    return capture?.export?.() ?? null;
  });
}