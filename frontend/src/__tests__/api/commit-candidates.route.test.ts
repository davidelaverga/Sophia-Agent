import type { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchSophiaApiMock = vi.fn();
const resolveSophiaUserIdMock = vi.fn();

vi.mock('../../app/api/_lib/sophia', () => ({
  fetchSophiaApi: (...args: unknown[]) => fetchSophiaApiMock(...args),
  resolveSophiaUserId: (...args: unknown[]) => resolveSophiaUserIdMock(...args),
}));

vi.mock('../../server/voice-lab/ordinary-route-isolation', () => ({
  voiceLabOrdinaryProductBoundaryResponse: vi.fn(async () => null),
}));

vi.mock('../../app/lib/error-logger', () => ({
  logger: { logError: vi.fn() },
}));

import { POST } from '../../app/api/memory/commit-candidates/route';

describe('canonical memory candidate commit bridge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveSophiaUserIdMock.mockResolvedValue('owner-1');
  });

  it('forwards exact candidate revisions and idempotency keys in one bulk review', async () => {
    fetchSophiaApiMock.mockResolvedValue(new Response(JSON.stringify({
      results: [
        { id: 'candidate-a', action: 'approve', status: 'ok' },
        { id: 'candidate-b', action: 'discard', status: 'ok' },
      ],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const request = {
      json: async () => ({
        session_id: 'session-1',
        decisions: [
          {
            candidate_id: 'candidate-a',
            decision: 'approve',
            text: 'Canonical text',
            category: 'fact',
            source: 'recap',
            expected_candidate_revision: 3,
            idempotency_key: 'review-operation-a',
          },
          {
            candidate_id: 'candidate-b',
            decision: 'discard',
            text: 'Rejected text',
            source: 'recap',
            expected_candidate_revision: 5,
            idempotency_key: 'review-operation-b',
          },
        ],
      }),
    } as unknown as NextRequest;

    const response = await POST(request);
    expect(response.status).toBe(200);
    expect(fetchSophiaApiMock).toHaveBeenCalledWith(
      '/api/sophia/owner-1/memories/bulk-review',
      expect.objectContaining({ method: 'POST' }),
    );
    const body = JSON.parse(String(fetchSophiaApiMock.mock.calls[0][1].body));
    expect(body.items).toEqual([
      expect.objectContaining({
        id: 'candidate-a',
        action: 'approve',
        expected_candidate_revision: 3,
        idempotency_key: 'review-operation-a',
        reviewed_text: 'Canonical text',
      }),
      expect.objectContaining({
        id: 'candidate-b',
        action: 'discard',
        expected_candidate_revision: 5,
        idempotency_key: 'review-operation-b',
      }),
    ]);
    await expect(response.json()).resolves.toEqual({
      committed: ['candidate-a'],
      discarded: ['candidate-b'],
      errors: [],
      ambiguous: [],
      commands: [
        { candidate_id: 'candidate-a', idempotency_key: 'review-operation-a', expected_candidate_revision: 3 },
        { candidate_id: 'candidate-b', idempotency_key: 'review-operation-b', expected_candidate_revision: 5 },
      ],
    });
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });
});

// =============================================================================
// MEM00-C2 WP1 — identity-bound join, no-store and lost-response recovery
// =============================================================================

const decision = (id: string, overrides: Record<string, unknown> = {}) => ({
  candidate_id: id,
  decision: 'approve',
  text: 'Synthetic canonical text',
  category: 'fact',
  source: 'recap',
  expected_candidate_revision: 2,
  idempotency_key: `review-operation-${id}`,
  ...overrides,
});

const post = (decisions: unknown[]) => POST({
  json: async () => ({ session_id: 'session-1', decisions }),
} as unknown as NextRequest);

const upstream = (results: unknown) => fetchSophiaApiMock.mockResolvedValue(
  new Response(JSON.stringify({ results }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  }),
);

describe('MEM00-C2 WP1 canonical decision join and recovery contract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveSophiaUserIdMock.mockResolvedValue('owner-1');
  });

  it('joins upstream results by exact candidate identity, never by position', async () => {
    // Gateway returned the same decisions in a different order.
    upstream([
      { id: 'candidate-b', action: 'approve', status: 'ok' },
      { id: 'candidate-a', action: 'approve', status: 'ok' },
    ]);
    const response = await post([decision('candidate-a'), decision('candidate-b')]);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      committed: ['candidate-a', 'candidate-b'],
      errors: [],
      ambiguous: [],
    });
  });

  it('reports an unjoined outcome as ambiguous and keeps the original command key', async () => {
    // A lost/truncated successful response must not be reported as a failure
    // that invites a second mutation, and must not be claimed as success.
    upstream([{ id: 'candidate-a', action: 'approve', status: 'ok' }]);
    const response = await post([decision('candidate-a'), decision('candidate-b')]);
    const body = await response.json();
    expect(body).toMatchObject({
      committed: ['candidate-a'],
      discarded: [],
      errors: [],
      ambiguous: ['candidate-b'],
    });
    expect(body.commands).toContainEqual({
      candidate_id: 'candidate-b',
      idempotency_key: 'review-operation-candidate-b',
      expected_candidate_revision: 2,
    });
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });

  it('never presents a different acknowledged action as this decision outcome', async () => {
    upstream([{ id: 'candidate-a', action: 'discard', status: 'ok' }]);
    const response = await post([decision('candidate-a', { decision: 'approve' })]);
    await expect(response.json()).resolves.toMatchObject({
      committed: [],
      discarded: [],
      errors: [],
      ambiguous: ['candidate-a'],
    });
  });

  it('claims nothing when the upstream result identity is ambiguous', async () => {
    upstream([
      { id: 'candidate-a', action: 'approve', status: 'ok' },
      { id: 'candidate-a', action: 'approve', status: 'ok' },
    ]);
    const response = await post([decision('candidate-a')]);
    await expect(response.json()).resolves.toMatchObject({
      committed: [],
      errors: [],
      ambiguous: ['candidate-a'],
    });
  });

  it('keeps a definite upstream rejection an error, not an ambiguity', async () => {
    upstream([{ id: 'candidate-a', action: 'approve', status: 'error', error: 'StaleRevisionError' }]);
    const response = await post([decision('candidate-a')]);
    await expect(response.json()).resolves.toMatchObject({
      committed: [],
      ambiguous: [],
      errors: [{ candidate_id: 'candidate-a', message: 'StaleRevisionError' }],
    });
  });

  it('sets no-store on the memory-bearing error response too', async () => {
    fetchSophiaApiMock.mockResolvedValue(new Response('nope', { status: 502 }));
    const response = await post([decision('candidate-a')]);
    expect(response.status).toBe(500);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });

  it('refuses a decision that is not bound to an exact revision and command key', async () => {
    const noRevision = await post([decision('candidate-a', { expected_candidate_revision: undefined })]);
    expect(noRevision.status).toBe(400);
    expect(noRevision.headers.get('Cache-Control')).toBe('no-store');

    const shortKey = await post([decision('candidate-a', { idempotency_key: 'short' })]);
    expect(shortKey.status).toBe(400);
    expect(fetchSophiaApiMock).not.toHaveBeenCalled();
  });

  it('refuses two decisions for one candidate in a single review', async () => {
    const response = await post([decision('candidate-a'), decision('candidate-a', { decision: 'discard' })]);
    expect(response.status).toBe(400);
    expect(fetchSophiaApiMock).not.toHaveBeenCalled();
  });
});

