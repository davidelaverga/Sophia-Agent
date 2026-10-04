import { act } from '@testing-library/react';
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { downloadTextFileMock } = vi.hoisted(() => ({ downloadTextFileMock: vi.fn() }));
vi.mock('../../app/lib/download-file', () => ({ downloadTextFile: downloadTextFileMock }));
vi.mock('../../app/providers', () => ({
  useAuth: () => ({ user: { id: 'SENTINEL-OWNER-ID' }, loading: false }),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), forward: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/recap/poll-session',
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({ sessionId: 'poll-session' }),
}));

import { errorCopy } from '../../app/lib/error-copy';
import { applyRecapRequestObservation, createInitialRecapTelemetryState } from '../../app/lib/recap-telemetry-report';
import type { MemoryDecisionState, RecapArtifactsV1 } from '../../app/lib/recap-types';
import RecapPage from '../../app/recap/[sessionId]/page';
import { buildRecapDebugExport } from '../../app/recap/[sessionId]/recap-debug-export';
import type { RecapPageStatus } from '../../app/recap/[sessionId]/useRecapArtifactsLoader';
import { useRecapStore } from '../../app/stores/recap-store';
import type { SessionHistoryEntry } from '../../app/stores/session-history-store';
import { useUiStore } from '../../app/stores/ui-store';

import { canonicalCandidate, canonicalRecap } from './canonical-recap-fixture';

const SESSION = 'poll-session';
const RECAP_URL = `/api/sophia/sessions/${SESSION}/recap`;
const SENTINEL = 'SENTINEL';

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** Recap GETs answer from `recapBodies` in order (the last repeats); observability leaks sentinels to prove sanitizing. */
function installFetch(recapBodies: unknown[]) {
  let index = 0;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === RECAP_URL && (init?.method ?? 'GET') === 'GET') {
      const body = recapBodies[Math.min(index, recapBodies.length - 1)];
      index += 1;
      return json(body);
    }
    if (url === '/api/memory/observability') {
      return json({ schema: 'mem00.runtime-metrics.v1', raw_content: `${SENTINEL} provider text`, token: `${SENTINEL}-token` });
    }
    return json({ error: 'unexpected request' }, 500);
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

function recapGetCount(fetchMock: ReturnType<typeof installFetch>) {
  return fetchMock.mock.calls.filter(([input]) => String(input) === RECAP_URL).length;
}

async function flush() {
  await act(async () => {
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
  });
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
  await flush();
}

function button(container: HTMLElement, name: string): HTMLButtonElement {
  const match = Array.from(container.querySelectorAll('button'))
    .find((node) => node.getAttribute('aria-label') === name || node.textContent?.trim() === name);
  if (!match) throw new Error(`Button not found: ${name}`);
  return match;
}

describe('recap page while canonical extraction is processing', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    downloadTextFileMock.mockReturnValue({ ok: true, bytes: 1 });
    useRecapStore.setState({ artifacts: {}, decisions: {}, commitStatus: {} });
    useUiStore.setState({ toast: null });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => { root.unmount(); });
    container.remove();
    vi.useRealTimers();
  });

  async function renderPage() {
    await act(async () => { root.render(<RecapPage />); });
    await flush();
  }

  it('shows the complete review once extraction commits, with no load-failure copy (codex-054)', async () => {
    const fetchMock = installFetch([
      canonicalRecap(SESSION, 'processing'),
      canonicalRecap(SESSION, 'complete', { candidates: [canonicalCandidate(1, 'Synthetic committed candidate')] }),
    ]);
    await renderPage();

    expect(container.textContent).toContain('Your recap is still being prepared');
    expect(container.textContent).toContain('updates on its own');
    expect(container.textContent).not.toContain(errorCopy.recapLoadFailed);

    await advance(1500);
    await advance(500);

    expect(recapGetCount(fetchMock)).toBe(2);
    expect(container.textContent).toContain('Synthetic committed candidate');
    expect(container.textContent).not.toContain('Your recap is still being prepared');
    expect(container.textContent).toContain('from this session');
    expect(container.textContent).not.toContain('key takeaway');
  });

  it('keeps a decision made after candidates appear; nothing re-reads under the reviewer', async () => {
    const candidates = [canonicalCandidate(1, 'Synthetic first'), canonicalCandidate(2, 'Synthetic second')];
    const fetchMock = installFetch([
      canonicalRecap(SESSION, 'processing'),
      canonicalRecap(SESSION, 'processing', { candidates }),
      canonicalRecap(SESSION, 'complete', { candidates: [...candidates, canonicalCandidate(3)] }),
    ]);
    await renderPage();
    await advance(1500);
    await advance(500);
    expect(container.textContent).toContain('Synthetic first');

    await act(async () => {
      useRecapStore.getState().setDecision(SESSION, candidates[0].candidate_id, 'approved');
    });
    await advance(120_000);

    expect(recapGetCount(fetchMock)).toBe(2);
    expect(useRecapStore.getState().getDecisions(SESSION)).toEqual([
      expect.objectContaining({ candidateId: candidates[0].candidate_id, decision: 'approved', expectedCandidateRevision: 1 }),
    ]);
    expect(useRecapStore.getState().getArtifacts(SESSION)?.memoryCandidates?.map((item) => item.id))
      .toEqual(candidates.map((item) => item.candidate_id));
  });

  it('says the recap is still being prepared after the budget, and Refresh checks again', async () => {
    const fetchMock = installFetch([canonicalRecap(SESSION, 'processing')]);
    await renderPage();
    await advance(120_000);

    expect(recapGetCount(fetchMock)).toBe(12);
    expect(container.textContent).toContain('Your recap is still being prepared');
    expect(container.textContent).toContain('taking longer than usual');
    expect(container.textContent).not.toContain(errorCopy.recapLoadFailed);
    expect(container.textContent).not.toMatch(/unavailable|couldn.t/i);

    await advance(300_000);
    expect(recapGetCount(fetchMock)).toBe(12);

    await act(async () => { button(container, 'Refresh').click(); });
    await flush();
    expect(recapGetCount(fetchMock)).toBe(13);
    expect(container.textContent).toContain('updates on its own');
  });

  it('exports a sanitized debug report while processing', async () => {
    installFetch([canonicalRecap(SESSION, 'processing', { ownerId: 'SENTINEL-OWNER-ID' })]);
    await renderPage();

    await act(async () => { button(container, 'Export recap debug').click(); });
    await flush();

    expect(downloadTextFileMock).toHaveBeenCalledTimes(1);
    const [{ text, filename, mimeType }] = downloadTextFileMock.mock.calls[0] as [{ text: string; filename: string; mimeType: string }];
    expect(filename).toMatch(/^sophia-recap-telemetry-report-poll-session-.+\.json$/);
    expect(mimeType).toBe('application/json');
    const report = JSON.parse(text);
    expect(report).toMatchObject({ pageStatus: 'processing', processingAutoRefresh: true, recap: { status: 'composing' } });
    expect(text).not.toContain(SENTINEL);
    expect(useUiStore.getState().toast).toMatchObject({ message: 'Recap debug report exported.', variant: 'success' });
  });

  it('exports a sanitized debug report from the ready review', async () => {
    const candidate = canonicalCandidate(1, `${SENTINEL} private memory text`);
    installFetch([canonicalRecap(SESSION, 'complete', { candidates: [candidate], ownerId: 'SENTINEL-OWNER-ID' })]);
    await renderPage();
    await advance(500);
    expect(container.textContent).toContain(`${SENTINEL} private memory text`);
    await act(async () => {
      useRecapStore.getState().setDecision(SESSION, candidate.candidate_id, 'edited', `${SENTINEL} private edit`);
    });

    await act(async () => { button(container, 'Export recap debug').click(); });
    await flush();

    const [{ text }] = downloadTextFileMock.mock.calls[0] as [{ text: string }];
    expect(JSON.parse(text)).toMatchObject({ pageStatus: 'ready', processingAutoRefresh: null, artifacts: { memoryCandidateCount: 1, approvedDecisionCount: 1 } });
    expect(text).not.toContain(SENTINEL);
  });

  it('reports a failed export instead of silently doing nothing', async () => {
    downloadTextFileMock.mockReturnValue({ ok: false, bytes: 0 });
    installFetch([canonicalRecap(SESSION, 'processing')]);
    await renderPage();

    await act(async () => { button(container, 'Export recap debug').click(); });
    await flush();

    expect(useUiStore.getState().toast).toMatchObject({ message: 'Could not export recap debug report.', variant: 'error' });
  });
});

describe('recap debug export content', () => {
  const artifacts: RecapArtifactsV1 = {
    sessionId: SESSION, threadId: 'thread-1', sessionType: 'open', contextMode: 'life', status: 'ready',
    endedAt: '2026-10-03T21:40:56Z',
    takeaway: `${SENTINEL} takeaway`,
    reflectionCandidate: { prompt: `${SENTINEL} reflection` },
    memoryCandidates: [{ id: 'candidate-1', text: `${SENTINEL} memory`, memory: `${SENTINEL} legacy memory`, reason: `${SENTINEL} reason`, category: 'fact', candidateRevision: 1 }],
    builderArtifact: {
      artifactTitle: `${SENTINEL} title`, artifactType: 'document', decisionsMade: [`${SENTINEL} decision`],
      artifactPath: `https://storage.invalid/${SENTINEL}?token=${SENTINEL}-signed`, companionSummary: `${SENTINEL} summary`,
    },
  };
  const decisions: MemoryDecisionState[] = [
    { candidateId: 'candidate-1', decision: 'edited', status: 'edited', editedText: `${SENTINEL} edit`, idempotencyKey: `${SENTINEL}-key`, timestamp: '2026-10-03T21:41:10Z' },
  ];
  const historyEntry: SessionHistoryEntry = {
    sessionId: SESSION, presetType: 'open', contextMode: 'life', startedAt: '2026-10-03T21:20:00Z', endedAt: '2026-10-03T21:40:56Z',
    messageCount: 12, takeawayPreview: `${SENTINEL} preview`, recapViewed: false, memoriesApproved: false,
  };
  const telemetry = applyRecapRequestObservation(createInitialRecapTelemetryState({ sessionId: SESSION }), {
    kind: 'recap', frontendPath: RECAP_URL, startedAt: '2026-10-03T21:41:03Z', completedAt: '2026-10-03T21:41:04Z', durationMs: 900,
    status: 200, ok: true, aborted: false, abortReason: null, timeoutMs: 5000,
    responseShapeKeys: ['ended_at', 'memory_review', 'session_id', 'status', 'thread_id'],
  });

  it.each<RecapPageStatus>(['processing', 'unavailable', 'not_found', 'no_pending', 'reviewed', 'source_excluded', 'ready'])(
    'carries pageStatus and no memory text, owner id or signed URL for %s',
    (pageStatus) => {
      const report = buildRecapDebugExport({
        memoryObservation: { available: true, snapshot: { raw_content: `${SENTINEL} provider`, owner_id: 'SENTINEL-OWNER-ID' } } as never,
        sessionId: SESSION,
        route: `/recap/${SESSION}`,
        pageStatus,
        autoRefreshing: pageStatus === 'processing',
        telemetry,
        artifacts,
        decisions,
        memoryCommitStatus: 'idle',
        historyEntry,
        exportedAt: '2026-10-03T21:42:00Z',
        sessionTelemetrySnapshot: null,
      });
      const text = JSON.stringify(report);
      expect(report.pageStatus).toBe(pageStatus);
      expect(report.processingAutoRefresh).toBe(pageStatus === 'processing' ? true : null);
      expect(report.memoryGovernance).toEqual({ available: false, reason: 'unavailable_or_not_authorized' });
      expect(text).not.toContain(SENTINEL);
      expect(text).not.toMatch(/token=|signed|https?:\/\//);
    },
  );
});
