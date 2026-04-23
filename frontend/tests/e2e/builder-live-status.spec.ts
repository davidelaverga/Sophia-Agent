import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { expect, test, type Page, type Response, type TestInfo } from '@playwright/test';

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

const BUILDER_TASK_TERMINAL_STATUSES = ['completed', 'failed', 'cancelled', 'timed_out'] as const;
const PDF_PROMPT_TITLE = 'Pear Field Guide Refresh E2E';
const PDF_ARTIFACT_FILE_NAME = 'pear-field-guide-refresh-e2e.pdf';
// Multi-page PDF builds can legitimately run close to the delegated builder's
// 600s backend timeout, especially after a refresh when the browser resumes
// polling mid-run.
const HEAVY_BUILDER_TEST_TIMEOUT_MS = 780_000;
const HEAVY_BUILDER_TERMINAL_DEADLINE_MS = 660_000;
const PDFJS_STANDARD_FONT_DATA_DIR = `${resolve(process.cwd(), 'node_modules', 'pdfjs-dist', 'standard_fonts').replace(/\\/g, '/')}/`;
const PDF_PROMPT = [
  `Please create a real 4-page PDF titled '${PDF_PROMPT_TITLE}'.`,
  'Include page 1 covering pear basics, page 2 comparing common pear varieties, page 3 with storage and serving guidance, and page 4 with additional practical pear notes.',
  'Make it polished, specific, and easy to read.',
].join(' ');

type BuilderTaskUpdate = {
  taskId: string | null;
  status: string | null;
  detail: string | null;
  builderResultPresent: boolean;
};

type TaskResponsePayload = {
  task_id?: unknown;
  status?: unknown;
  detail?: unknown;
  builder_result?: unknown;
};

type PdfQualityReport = {
  pageCount: number;
  pageTextLengths: number[];
  totalTextLength: number;
  issues: string[];
};

function isBuilderTaskResponse(response: Response): boolean {
  const url = response.url();
  return url.includes('/api/sophia/')
    && url.includes('/tasks/')
    && !url.includes('/tasks/active')
    && response.request().method().toUpperCase() === 'GET';
}

function isActiveTaskResponse(response: Response): boolean {
  const url = response.url();
  return url.includes('/api/sophia/')
    && url.includes('/tasks/active')
    && response.request().method().toUpperCase() === 'GET';
}

function toBuilderTaskUpdate(payload: TaskResponsePayload): BuilderTaskUpdate {
  return {
    taskId: typeof payload.task_id === 'string' ? payload.task_id : null,
    status: typeof payload.status === 'string' ? payload.status : null,
    detail: typeof payload.detail === 'string' ? payload.detail : null,
    builderResultPresent: payload.builder_result != null,
  };
}

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

function hasAnyToken(text: string, tokens: string[]): boolean {
  return tokens.some((token) => text.includes(token));
}

async function readPdfTextPages(pdfBuffer: Buffer): Promise<string[]> {
  class NodeFileBinaryDataFactory {
    cMapUrl: string | null;
    standardFontDataUrl: string | null;
    wasmUrl: string | null;

    constructor({
      cMapUrl = null,
      standardFontDataUrl = null,
      wasmUrl = null,
    }: {
      cMapUrl?: string | null;
      standardFontDataUrl?: string | null;
      wasmUrl?: string | null;
    }) {
      this.cMapUrl = cMapUrl;
      this.standardFontDataUrl = standardFontDataUrl;
      this.wasmUrl = wasmUrl;
    }

    async fetch({ kind, filename }: { kind: 'cMapUrl' | 'standardFontDataUrl' | 'wasmUrl'; filename: string }): Promise<Uint8Array> {
      const basePath = this[kind];
      if (!basePath) {
        throw new Error(`Ensure that the \`${kind}\` API parameter is provided.`);
      }

      return new Uint8Array(await readFile(`${basePath}${filename}`));
    }
  }

  const pdfjsModule = await import('pdfjs-dist/legacy/build/pdf.mjs') as unknown as {
    getDocument: (options: {
      data: Uint8Array;
      disableWorker: boolean;
      useWorkerFetch: boolean;
      isEvalSupported: boolean;
      standardFontDataUrl: string;
      BinaryDataFactory: typeof NodeFileBinaryDataFactory;
    }) => {
      promise: Promise<{
        numPages: number;
        getPage: (pageNumber: number) => Promise<{
          getTextContent: () => Promise<{
            items: Array<{ str?: string }>;
          }>;
        }>;
      }>;
    };
  };

  const loadingTask = pdfjsModule.getDocument({
    data: new Uint8Array(pdfBuffer),
    disableWorker: true,
    useWorkerFetch: false,
    isEvalSupported: false,
    standardFontDataUrl: PDFJS_STANDARD_FONT_DATA_DIR,
    BinaryDataFactory: NodeFileBinaryDataFactory,
  });
  const pdfDocument = await loadingTask.promise;
  const pages: string[] = [];

  for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber += 1) {
    const page = await pdfDocument.getPage(pageNumber);
    const textContent = await page.getTextContent();
    const pageText = textContent.items
      .map((item) => (typeof item?.str === 'string' ? item.str : ''))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    pages.push(pageText);
  }

  return pages;
}

function evaluatePdfQuality(pageTexts: string[]): PdfQualityReport {
  const normalizedPages = pageTexts.map((pageText) => normalizeText(pageText));
  const fullText = normalizedPages.join(' ');
  const pageTextLengths = pageTexts.map((pageText) => pageText.length);
  const totalTextLength = pageTextLengths.reduce((sum, value) => sum + value, 0);
  const issues: string[] = [];

  if (pageTexts.length !== 4) {
    issues.push(`expected 4 pages, got ${pageTexts.length}`);
  }

  if (totalTextLength < 1_200) {
    issues.push(`expected at least 1200 extracted chars, got ${totalTextLength}`);
  }

  pageTextLengths.forEach((pageLength, index) => {
    if (pageLength < 180) {
      issues.push(`page ${index + 1} extracted only ${pageLength} chars`);
    }
  });

  if (!fullText.includes(normalizeText(PDF_PROMPT_TITLE))) {
    issues.push('pdf text did not include the requested title');
  }

  if (!fullText.includes('pear')) {
    issues.push('pdf text did not mention pears');
  }

  if (!hasAnyToken(fullText, ['variet', 'bartlett', 'anjou', 'bosc', 'comice', 'concorde'])) {
    issues.push('pdf text did not cover pear varieties');
  }

  if (!hasAnyToken(fullText, ['storage', 'store', 'ripen', 'refrigerat', 'serving', 'serve', 'pairing'])) {
    issues.push('pdf text did not cover storage or serving guidance');
  }

  if (new Set(normalizedPages.filter(Boolean)).size < normalizedPages.filter(Boolean).length) {
    issues.push('pdf pages contained duplicate extracted text');
  }

  return {
    pageCount: pageTexts.length,
    pageTextLengths,
    totalTextLength,
    issues,
  };
}

async function startAuthenticatedTextSession(page: Page): Promise<void> {
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

  const clearSessionsResponse = await page.evaluate(async () => {
    const response = await fetch('/api/sessions/bulk?user_id=google-builder-smoke', {
      method: 'DELETE',
    });

    return {
      ok: response.ok,
      status: response.status,
      body: await response.text(),
    };
  });
  expect(
    clearSessionsResponse.ok,
    `Session cleanup failed: ${clearSessionsResponse.status} ${clearSessionsResponse.body}`,
  ).toBeTruthy();

  const startSessionResponse = await page.evaluate(async () => {
    const response = await fetch('/api/sessions/start', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        user_id: 'google-builder-smoke',
        session_type: 'chat',
        preset_context: 'gaming',
      }),
    });

    return {
      ok: response.ok,
      status: response.status,
      body: await response.text(),
    };
  });
  expect(
    startSessionResponse.ok,
    `Session bootstrap failed: ${startSessionResponse.status} ${startSessionResponse.body}`,
  ).toBeTruthy();

  await page.goto('/session', { waitUntil: 'domcontentloaded' });
  await page.waitForURL(/\/session(\/|\?|$)/, { timeout: 45_000, waitUntil: 'commit' });
  await expect(page.getByRole('tablist', { name: /interaction mode/i })).toBeVisible({ timeout: 60_000 });
  await switchToTextMode(page);
}

async function sendBuilderPrompt(page: Page, prompt: string): Promise<void> {
  const chatResponse = page.waitForResponse((response) => {
    return (
      response.request().method().toUpperCase() === 'POST' &&
      response.url().includes('/api/chat')
    );
  }, { timeout: 30_000 });

  const messageInput = page.getByLabel('Message input');
  await messageInput.fill(prompt);
  await messageInput.press('Enter');

  await chatResponse;

  const reflectingIndicator = page.getByText('sophia is reflecting...').first();
  if (await reflectingIndicator.isVisible({ timeout: 2_500 }).catch(() => false)) {
    await reflectingIndicator.waitFor({ state: 'hidden', timeout: 45_000 }).catch(() => {});
    return;
  }

  await page.waitForTimeout(6_000);
}

async function waitForTaskUpdate(
  page: Page,
  taskUpdates: BuilderTaskUpdate[],
  predicate: (taskUpdate: BuilderTaskUpdate) => boolean,
  deadlineMs: number,
): Promise<BuilderTaskUpdate | null> {
  while (Date.now() < deadlineMs) {
    const taskUpdate = taskUpdates.find(predicate);
    if (taskUpdate) {
      return taskUpdate;
    }

    await page.waitForTimeout(1_500);
  }

  return null;
}

async function attachTaskUpdates(testInfo: TestInfo, taskUpdates: BuilderTaskUpdate[], name: string): Promise<void> {
  await testInfo.attach(name, {
    body: JSON.stringify(taskUpdates, null, 2),
    contentType: 'application/json',
  });
}

test('session UI polls builder task to completion', async ({ page }, testInfo) => {
  test.setTimeout(300_000);

  const taskUpdates: BuilderTaskUpdate[] = [];

  page.on('response', async (response) => {
    if (!isBuilderTaskResponse(response)) {
      return;
    }

    try {
      const payload = await response.json() as TaskResponsePayload;
      taskUpdates.push(toBuilderTaskUpdate(payload));
    } catch {
      // Ignore malformed polling responses in the capture; the assertions below will fail if needed.
    }
  });

  await startAuthenticatedTextSession(page);
  await sendBuilderPrompt(
    page,
    "Please create a single markdown file titled 'Voice Transport Migration Status' with sections Goal, Current State, Risks, and Next Steps. Keep it concise and save just one final .md deliverable.",
  );

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

  await attachTaskUpdates(testInfo, taskUpdates, 'builder-task-updates.json');

  expect(taskUpdates.length, 'Expected the session UI to poll the builder task status endpoint.').toBeGreaterThan(0);

  if (!terminalUpdate) {
    await expect(
      page.getByRole('button', { name: /deliverable complete/i }).first(),
    ).toBeVisible({ timeout: 30_000 });
    expect(taskUpdates.some((taskUpdate) => taskUpdate.taskId)).toBe(true);
    return;
  }

  expect(terminalUpdate.status).toBe('completed');
  expect(terminalUpdate.builderResultPresent).toBe(true);
});

test('session UI recovers builder state after refresh and validates the downloaded PDF', async ({ page }, testInfo) => {
  test.setTimeout(HEAVY_BUILDER_TEST_TIMEOUT_MS);

  const taskUpdates: BuilderTaskUpdate[] = [];

  page.on('response', async (response) => {
    if (!isBuilderTaskResponse(response)) {
      return;
    }

    try {
      const payload = await response.json() as TaskResponsePayload;
      taskUpdates.push(toBuilderTaskUpdate(payload));
    } catch {
      // Ignore malformed polling responses in the capture; the assertions below will fail if needed.
    }
  });

  await startAuthenticatedTextSession(page);
  await sendBuilderPrompt(page, PDF_PROMPT);

  const deadlineMs = Date.now() + HEAVY_BUILDER_TERMINAL_DEADLINE_MS;
  await page.waitForTimeout(8_000);

  const activeTaskResponsePromise = page.waitForResponse(
    (response) => isActiveTaskResponse(response),
    { timeout: 60_000 },
  );

  await page.reload({ waitUntil: 'domcontentloaded' });

  const interactionModeTablist = page.getByRole('tablist', { name: /interaction mode/i });
  if (!(await interactionModeTablist.isVisible({ timeout: 5_000 }).catch(() => false))) {
    const resumeBanner = page.getByRole('region', { name: /resume previous session/i }).first();
    if (await resumeBanner.isVisible({ timeout: 10_000 }).catch(() => false)) {
      const continueOverlayHint = page.getByText(/tap anywhere to continue/i).first();
      if (await continueOverlayHint.isVisible({ timeout: 2_000 }).catch(() => false)) {
        await page.mouse.click(40, 40);
      }

      await resumeBanner.getByRole('button', { name: /you left something unfinished|continue/i }).first().click({ force: true });
      await page.waitForURL(/\/session(\/|\?|$)/, { timeout: 45_000, waitUntil: 'commit' });
    }
  }

  await expect(interactionModeTablist).toBeVisible({ timeout: 60_000 });

  const activeTaskResponse = await activeTaskResponsePromise;
  const activeTaskPayload = await activeTaskResponse.json() as TaskResponsePayload | null;
  const activeTaskDebug = await page.evaluate(() => {
    const parseStoredState = (key: string) => {
      try {
        return JSON.parse(window.localStorage.getItem(key) ?? 'null') as Record<string, unknown> | null;
      } catch {
        return null;
      }
    };

    const sessionStore = parseStoredState('sophia-session-store');
    const messageMetadataStore = parseStoredState('sophia.message-metadata.v1');
    const session = sessionStore?.state && typeof sessionStore.state === 'object'
      ? (sessionStore.state as Record<string, unknown>).session as Record<string, unknown> | null
      : null;
    const metadataState = messageMetadataStore?.state && typeof messageMetadataStore.state === 'object'
      ? messageMetadataStore.state as Record<string, unknown>
      : null;

    return {
      pathname: window.location.pathname,
      sessionId: typeof session?.sessionId === 'string' ? session.sessionId : null,
      threadId: typeof session?.threadId === 'string' ? session.threadId : null,
      metadataSessionId: typeof metadataState?.currentSessionId === 'string' ? metadataState.currentSessionId : null,
      metadataThreadId: typeof metadataState?.currentThreadId === 'string' ? metadataState.currentThreadId : null,
    };
  });

  await testInfo.attach('builder-active-task-response.json', {
    body: JSON.stringify(activeTaskPayload, null, 2),
    contentType: 'application/json',
  });
  await testInfo.attach('builder-active-task-debug.json', {
    body: JSON.stringify({
      url: activeTaskResponse.url(),
      status: activeTaskResponse.status(),
      client: activeTaskDebug,
    }, null, 2),
    contentType: 'application/json',
  });

  expect(
    activeTaskPayload,
    `Expected /tasks/active to return a task snapshot after refresh. ${JSON.stringify({
      url: activeTaskResponse.url(),
      status: activeTaskResponse.status(),
      client: activeTaskDebug,
    })}`,
  ).toBeTruthy();
  expect(typeof activeTaskPayload?.task_id).toBe('string');
  expect(['running', 'completed']).toContain(activeTaskPayload?.status);

  const recoveredTaskId = activeTaskPayload?.task_id as string;

  if (activeTaskPayload?.status === 'running') {
    await expect(page.getByRole('progressbar', { name: 'Builder progress' })).toBeVisible({ timeout: 60_000 });
  } else {
    await expect(
      page.getByRole('button', { name: /deliverable (ready|complete)/i }).first(),
    ).toBeVisible({ timeout: 60_000 });
  }

  const terminalUpdate = await waitForTaskUpdate(
    page,
    taskUpdates,
    (taskUpdate) => taskUpdate.taskId === recoveredTaskId && BUILDER_TASK_TERMINAL_STATUSES.includes((taskUpdate.status ?? '') as typeof BUILDER_TASK_TERMINAL_STATUSES[number]),
    deadlineMs,
  );

  await attachTaskUpdates(testInfo, taskUpdates, 'builder-refresh-task-updates.json');

  const readyButton = page
    .getByRole('button', { name: /deliverable (ready|complete)/i })
    .filter({ hasText: PDF_ARTIFACT_FILE_NAME })
    .first();

  if (!terminalUpdate) {
    await expect(
      readyButton,
      `Expected either a terminal task poll or a visible deliverable after refresh. Last update: ${JSON.stringify(taskUpdates.at(-1) ?? null)}`,
    ).toBeVisible({ timeout: 90_000 });
    expect(taskUpdates.some((taskUpdate) => taskUpdate.taskId === recoveredTaskId)).toBe(true);
  } else {
    expect(terminalUpdate.status).toBe('completed');
    expect(terminalUpdate.builderResultPresent).toBe(true);
    await expect(readyButton).toBeVisible({ timeout: 90_000 });
  }

  const downloadLink = page.locator(`a[href*="${PDF_ARTIFACT_FILE_NAME}?download=true"]`).first();
  await expect(downloadLink).toBeVisible({ timeout: 15_000 });
  await expect(downloadLink).toHaveAttribute('href', /download=true/);

  const downloadHref = await downloadLink.getAttribute('href');
  expect(downloadHref).toBeTruthy();
  if (!downloadHref) {
    throw new Error('Expected builder artifact download link to include an href');
  }

  const pdfResponse = await page.request.get(downloadHref);
  expect(pdfResponse.ok(), 'Expected the browser-authenticated artifact download route to return the PDF.').toBeTruthy();
  expect(pdfResponse.headers()['content-type'] ?? '').toContain('application/pdf');

  const pdfBuffer = await pdfResponse.body();
  const pdfPageTexts = await readPdfTextPages(pdfBuffer);
  const pdfQuality = evaluatePdfQuality(pdfPageTexts);

  await testInfo.attach('builder-refresh-pdf-quality.json', {
    body: JSON.stringify(pdfQuality, null, 2),
    contentType: 'application/json',
  });

  expect(pdfQuality.issues).toEqual([]);
});