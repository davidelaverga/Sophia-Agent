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
    });
  });
});
