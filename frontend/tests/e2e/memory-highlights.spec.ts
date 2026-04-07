import { expect, test, type Page, type TestInfo } from '@playwright/test';

type RawHighlight = {
  id?: string | number | null;
  text?: string | null;
  created_at?: string | null;
};

type NormalizedHighlight = {
  id: string;
  text: string;
  created_at?: string;
};

type StartResponse = {
  session_id: string;
  thread_id: string;
  greeting_message: string;
  message_id: string;
  memory_highlights: RawHighlight[];
  is_resumed: boolean;
  briefing_source: 'mem0' | 'fallback' | 'none' | 'openmemory';
  has_memory: boolean;
  session_type: string;
  preset_context: string;
  started_at: string;
};

type TrackerState = {
  startCalls: number;
  endCalls: number;
};

const END_SESSION_PATHS = ['/api/sophia/end-session', '/api/sessions/end'] as const;

const trackerByPage = new WeakMap<Page, TrackerState>();

function nowIso(offsetMs = 0): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

function isEndSessionRequest(url: string): boolean {
  return END_SESSION_PATHS.some((path) => url.includes(path));
}

function normalizeHighlights(input: unknown): NormalizedHighlight[] {
  if (!Array.isArray(input)) return [];

  return input
    .map((item, index) => {
      if (!item || typeof item !== 'object') return null;
      const rec = item as RawHighlight;
      const text = typeof rec.text === 'string' ? rec.text.trim() : '';
      if (!text) return null;

      const idRaw = rec.id ?? `idx-${index}`;
      const createdAt = typeof rec.created_at === 'string' ? rec.created_at : undefined;

      return {
        id: String(idRaw),
        text,
        ...(createdAt ? { created_at: createdAt } : {}),
      } satisfies NormalizedHighlight;
    })
    .filter((h): h is NormalizedHighlight => h !== null);
}

function highlightsSignature(highlights: NormalizedHighlight[]): string[] {
  return highlights.map((h) => `${h.id}::${h.text}`);
}

function diffHighlights(before: NormalizedHighlight[], after: NormalizedHighlight[]) {
  const beforeSig = new Set(highlightsSignature(before));
  const afterSig = new Set(highlightsSignature(after));

  const added = Array.from(afterSig).filter((sig) => !beforeSig.has(sig));
  const removed = Array.from(beforeSig).filter((sig) => !afterSig.has(sig));

  return { added, removed };
}

async function logHighlightsDiff(
  testInfo: TestInfo,
  label: string,
  before: NormalizedHighlight[],
  after: NormalizedHighlight[],
): Promise<void> {
  const diff = diffHighlights(before, after);
  const report = {
    label,
    before,
    after,
    diff,
  };

  console.log(`[memory-highlights-diff] ${label}`);
  console.log(JSON.stringify(report, null, 2));

  await testInfo.attach(`highlights-diff-${label}.json`, {
    body: JSON.stringify(report, null, 2),
    contentType: 'application/json',
  });
}

function installStartEndTracker(page: Page): void {
  const state: TrackerState = { startCalls: 0, endCalls: 0 };
  trackerByPage.set(page, state);

  page.on('request', (request) => {
    const url = request.url();
    const method = request.method().toUpperCase();

    if (method === 'POST' && url.includes('/api/sessions/start')) {
      state.startCalls += 1;
    }
    if (method === 'POST' && isEndSessionRequest(url)) {
      state.endCalls += 1;
    }
  });
}

async function assertCalledStart(page: Page): Promise<void> {
  const state = trackerByPage.get(page);
  expect(state, 'Tracker no inicializado para la página').toBeDefined();
  expect(state.startCalls, 'Expected at least one POST /api/sessions/start call').toBeGreaterThan(0);
}

async function clearSophiaStorage(page: Page): Promise<void> {
  await page.evaluate(() => {
    const removeIfExists = (key: string) => {
      try {
        localStorage.removeItem(key);
      } catch {
        // ignore
      }
    };

    removeIfExists('sophia-session-bootstrap');
    removeIfExists('sophia-session-store');
    removeIfExists('sophia-session');

    const keys = Object.keys(localStorage);
    for (const key of keys) {
      if (key.startsWith('sophia.session.snapshot')) {
        removeIfExists(key);
      }
    }
  });
}

async function captureStartHighlights(page: Page): Promise<NormalizedHighlight[]> {
  const response = await page.waitForResponse((res) => {
    return (
      res.request().method().toUpperCase() === 'POST' &&
      res.url().includes('/api/sessions/start')
    );
  }, { timeout: 15_000 });

  const json = (await response.json()) as Partial<StartResponse>;
  return normalizeHighlights(json.memory_highlights);
}

async function readStoredSessionHighlights(page: Page): Promise<NormalizedHighlight[]> {
  const raw = await page.evaluate(() => {
    const payload = localStorage.getItem('sophia-session-store');
    if (!payload) return null;

    try {
      const parsed = JSON.parse(payload) as {
        state?: {
          session?: {
            memoryHighlights?: unknown;
          };
        };
      };
      return parsed?.state?.session?.memoryHighlights ?? null;
    } catch {
      return null;
    }
  });

  return normalizeHighlights(raw);
}

async function waitForSessionUiReady(page: Page): Promise<void> {
  await page.waitForURL(/\/session(\/|\?|$)/, { timeout: 15_000 }).catch(() => {});

  const headerEndButton = page.locator('button[title="End session"]').first();
  await expect(headerEndButton).toBeVisible({ timeout: 10_000 });

  await expect.poll(async () => {
    return await page.evaluate(() => {
      try {
        const payload = localStorage.getItem('sophia-session-store');
        if (!payload) return false;

        const parsed = JSON.parse(payload) as {
          state?: {
            session?: {
              sessionId?: string;
              isActive?: boolean;
              status?: string;
            };
          };
        };

        const session = parsed?.state?.session;
        return Boolean(session?.sessionId && session?.isActive && session?.status === 'active');
      } catch {
        return false;
      }
    });
  }, {
    timeout: 10_000,
    intervals: [200, 400, 800],
  }).toBe(true);
}

async function ensureDashboardReadyOrSkip(page: Page): Promise<void> {
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

  const stillLoading = await page.getByText(/Opening a gentle space/i).first().isVisible().catch(() => false);
  test.skip(
    stillLoading,
    'AuthGate quedó en loading (Opening a gentle space...). Provee sesión autenticada o storageState para E2E.',
  );

  const micButton = page.locator('[data-onboarding="mic-cta"]').first();
  await expect(micButton).toBeVisible({ timeout: 10_000 });
}

async function startFromHomeAndCapture(page: Page): Promise<NormalizedHighlight[]> {
  const capturePromise = captureStartHighlights(page);

  const micButton = page.locator('[data-onboarding="mic-cta"]').first();
  await micButton.click();

  const replaceStartFresh = page.getByRole('button', { name: /start fresh/i }).first();
  if (await replaceStartFresh.isVisible({ timeout: 1200 }).catch(() => false)) {
    await replaceStartFresh.click();
  }

  const highlights = await capturePromise;
  await waitForSessionUiReady(page);
  return highlights;
}

async function endSessionAndWaitRequest(page: Page): Promise<void> {
  const endReq = page.waitForResponse((res) => {
    return (
      res.request().method().toUpperCase() === 'POST' &&
      isEndSessionRequest(res.url())
    );
  }, { timeout: 15_000 });

  await waitForSessionUiReady(page);

  const headerEndButton = page.locator('button[title="End session"]').first();
  await expect(headerEndButton).toBeVisible({ timeout: 10_000 });
  const confirmEndButton = page.locator('nav').getByRole('button', { name: /^end session$/i });

  for (let attempt = 0; attempt < 3; attempt += 1) {
    await headerEndButton.click();
    if (await confirmEndButton.isVisible({ timeout: 1_000 }).catch(() => false)) {
      break;
    }
    await page.waitForTimeout(250);
  }

  await expect(confirmEndButton).toBeVisible({ timeout: 5_000 });
  await confirmEndButton.click();

  const leaveAnywayButton = page.getByRole('button', { name: /^leave anyway$/i }).first();
  if (await leaveAnywayButton.isVisible({ timeout: 1_500 }).catch(() => false)) {
    await leaveAnywayButton.click();
  }

  await endReq;
}

function buildStartResponse(seed: {
  sessionId: string;
  threadId: string;
  messageId: string;
  highlights: RawHighlight[];
  isResumed?: boolean;
  source?: StartResponse['briefing_source'];
}): StartResponse {
  return {
    session_id: seed.sessionId,
    thread_id: seed.threadId,
    greeting_message: 'Hey — mocked start response',
    message_id: seed.messageId,
    memory_highlights: seed.highlights,
    is_resumed: seed.isResumed ?? false,
    briefing_source: seed.source ?? 'mem0',
    has_memory: seed.highlights.length > 0,
    session_type: 'chat',
    preset_context: 'gaming',
    started_at: nowIso(),
  };
}

async function setupMockNetwork(page: Page, startQueue: StartResponse[]): Promise<void> {
  let startIndex = 0;

  await page.route('**/api/sessions/active', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ has_active_session: false, session: null }),
    });
  });

  await page.route('**/api/bootstrap/**', async (route) => {
    const url = route.request().url();
    if (url.includes('/opener')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          opener_text: 'mock bootstrap opener',
          suggested_ritual: null,
          emotional_context: null,
          has_opener: false,
        }),
      });
      return;
    }

    if (url.includes('/status')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ has_opener: false, user_id: 'mock-user' }),
      });
      return;
    }

    await route.continue();
  });

  await page.route('**/api/sessions/start', async (route) => {
    const payload = startQueue[Math.min(startIndex, startQueue.length - 1)];
    startIndex += 1;

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(payload),
    });
  });

  await page.route('**/api/sophia/end-session', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        session_id: 'mock-session-end',
        ended_at: nowIso(),
        duration_minutes: 8,
        turn_count: 6,
        recap_artifacts: {
          takeaway: 'mock recap',
          memory_candidates: [
            { id: 'cand-1', text: 'mock memory candidate', category: 'episodic', created_at: nowIso() },
          ],
        },
        offer_debrief: false,
      }),
    });
  });

  await page.route('**/api/sessions/end', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        session_id: 'mock-session-end',
        ended_at: nowIso(),
        duration_minutes: 8,
        turn_count: 6,
        recap_artifacts: {
          takeaway: 'mock recap',
          memory_candidates: [
            { id: 'cand-1', text: 'mock memory candidate', category: 'episodic', created_at: nowIso() },
          ],
        },
        offer_debrief: false,
      }),
    });
  });

  await page.route('**/api/consent/check', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ hasConsent: true, consentDate: nowIso(-3600_000) }),
    });
  });

  await page.route('**/api/consent/accept', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true }),
    });
  });
}

test.describe('Memory highlights stale investigation (network-driven)', () => {
  test.beforeEach(async ({ page }) => {
    installStartEndTracker(page);

    await page.addInitScript(() => {
      try {
        const onboardingCompletedAt = new Date().toISOString();

        localStorage.setItem('sophia_consent_accepted', 'true');
        localStorage.setItem('sophia-onboarding-v2', JSON.stringify({
          state: {
            firstRun: {
              status: 'completed',
              currentStepId: null,
              completedSteps: [],
              skippedAt: null,
              completedAt: onboardingCompletedAt,
            },
            contextualTips: {},
            preferences: {
              voiceOverEnabled: false,
              reducedMotion: true,
            },
            legacyStep: 'complete',
          },
          version: 2,
        }));
      } catch {
        // ignore
      }
    });
  });

  test('calls POST /api/sessions/start and uses network highlights as source of truth', async ({ page }, testInfo) => {
    const firstStart = buildStartResponse({
      sessionId: '00000000-0000-4000-8000-000000000001',
      threadId: '00000000-0000-4000-8000-000000000011',
      messageId: 'msg-start-1',
      highlights: [
        { id: 'net-h1', text: 'Network memory alpha', created_at: nowIso(-10_000) },
        { id: 'net-h2', text: 'Network memory beta', created_at: nowIso(-8_000) },
      ],
    });

    await setupMockNetwork(page, [firstStart]);

    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await ensureDashboardReadyOrSkip(page);

    const fromNetwork = await startFromHomeAndCapture(page);
    await assertCalledStart(page);

    expect(fromNetwork).toEqual(normalizeHighlights(firstStart.memory_highlights));

    const stored = await readStoredSessionHighlights(page);
    expect(highlightsSignature(stored)).toEqual(highlightsSignature(fromNetwork));

    await logHighlightsDiff(testInfo, 'start-network-vs-store', fromNetwork, stored);
  });

  test('hot flow updates highlights: Start -> End -> immediate Start', async ({ page }, testInfo) => {
    const startA = buildStartResponse({
      sessionId: '00000000-0000-4000-8000-000000000002',
      threadId: '00000000-0000-4000-8000-000000000022',
      messageId: 'msg-start-a',
      highlights: [
        { id: 'old-1', text: 'Old highlight from previous memory', created_at: nowIso(-30_000) },
      ],
    });

    const startB = buildStartResponse({
      sessionId: '00000000-0000-4000-8000-000000000003',
      threadId: '00000000-0000-4000-8000-000000000033',
      messageId: 'msg-start-b',
      highlights: [
        { id: 'new-1', text: 'New memory generated in hot flow', created_at: nowIso(-2_000) },
      ],
    });

    await setupMockNetwork(page, [startA, startB]);

    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await ensureDashboardReadyOrSkip(page);

    const first = await startFromHomeAndCapture(page);
    expect(first).toEqual(normalizeHighlights(startA.memory_highlights));

    await endSessionAndWaitRequest(page);

    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await ensureDashboardReadyOrSkip(page);

    const second = await startFromHomeAndCapture(page);

    expect(second).toEqual(normalizeHighlights(startB.memory_highlights));
    expect(highlightsSignature(second)).not.toEqual(highlightsSignature(first));

    await logHighlightsDiff(testInfo, 'hot-flow-startA-vs-startB', first, second);
  });

  test('after clearSophiaStorage + reload, FE does not reuse stale highlights', async ({ page }, testInfo) => {
    const startOld = buildStartResponse({
      sessionId: '00000000-0000-4000-8000-000000000004',
      threadId: '00000000-0000-4000-8000-000000000044',
      messageId: 'msg-start-old',
      highlights: [
        { id: 'stale-1', text: 'Potential stale cached memory', created_at: nowIso(-45_000) },
      ],
    });

    const startFresh = buildStartResponse({
      sessionId: '00000000-0000-4000-8000-000000000005',
      threadId: '00000000-0000-4000-8000-000000000055',
      messageId: 'msg-start-fresh',
      highlights: [
        { id: 'fresh-1', text: 'Fresh memory after storage clear', created_at: nowIso(-1_000) },
      ],
    });

    await setupMockNetwork(page, [startOld, startFresh]);

    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await ensureDashboardReadyOrSkip(page);

    const beforeClear = await startFromHomeAndCapture(page);
    expect(beforeClear).toEqual(normalizeHighlights(startOld.memory_highlights));

    await clearSophiaStorage(page);

    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await ensureDashboardReadyOrSkip(page);

    const afterClear = await startFromHomeAndCapture(page);

    expect(afterClear).toEqual(normalizeHighlights(startFresh.memory_highlights));
    expect(highlightsSignature(afterClear)).not.toEqual(highlightsSignature(beforeClear));

    await logHighlightsDiff(testInfo, 'clear-storage-before-vs-after', beforeClear, afterClear);
  });

  test('bonus: cold-start simulation (bridge loss) returns different start highlights', async ({ page }, testInfo) => {
    const hotStart = buildStartResponse({
      sessionId: '00000000-0000-4000-8000-000000000006',
      threadId: '00000000-0000-4000-8000-000000000066',
      messageId: 'msg-hot',
      highlights: [
        { id: 'bridge-hot-1', text: 'Bridge memory while backend is hot', created_at: nowIso(-1_500) },
      ],
    });

    const coldStart = buildStartResponse({
      sessionId: '00000000-0000-4000-8000-000000000007',
      threadId: '00000000-0000-4000-8000-000000000077',
      messageId: 'msg-cold',
      highlights: [
        { id: 'cold-fallback-1', text: 'Older memory after bridge loss', created_at: nowIso(-120_000) },
      ],
    });

    await setupMockNetwork(page, [hotStart, coldStart]);

    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await ensureDashboardReadyOrSkip(page);

    const hot = await startFromHomeAndCapture(page);

    await clearSophiaStorage(page);
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await ensureDashboardReadyOrSkip(page);

    const cold = await startFromHomeAndCapture(page);

    expect(hot).toEqual(normalizeHighlights(hotStart.memory_highlights));
    expect(cold).toEqual(normalizeHighlights(coldStart.memory_highlights));
    expect(highlightsSignature(cold)).not.toEqual(highlightsSignature(hot));

    await logHighlightsDiff(testInfo, 'bonus-hot-vs-cold', hot, cold);
  });
});
