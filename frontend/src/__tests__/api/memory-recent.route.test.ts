import type { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchSophiaApiMock = vi.fn();
const resolveSophiaUserIdMock = vi.fn();

vi.mock('../../app/api/_lib/sophia', () => ({
  fetchSophiaApi: (...args: unknown[]) => fetchSophiaApiMock(...args),
  resolveSophiaUserId: (...args: unknown[]) => resolveSophiaUserIdMock(...args),
}));

vi.mock('../../app/lib/error-logger', () => ({
  logger: {
    logError: vi.fn(),
  },
}));

import { GET as recentMemoriesGET } from '../../app/api/memory/recent/route';

describe('memory recent route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveSophiaUserIdMock.mockResolvedValue('user-123');
  });

  it('filters out reviewed memories when fallback uses the unfiltered list', async () => {
    fetchSophiaApiMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ memories: [], count: 0 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({
          memories: [
            {
              id: 'approved-1',
              memory: 'Already approved',
              metadata: { session_id: 'sess-1', status: 'approved' },
            },
            {
              id: 'discarded-1',
              memory: 'Already discarded',
              metadata: { session_id: 'sess-1', status: 'discarded' },
            },
            {
              id: 'pending-1',
              memory: 'Still pending',
              metadata: { session_id: 'sess-1', status: 'pending_review' },
            },
            {
              id: 'legacy-1',
              memory: 'Missing status',
              metadata: { session_id: 'sess-1' },
            },
          ],
          count: 4,
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

    const request = {
      nextUrl: new URL('http://localhost:3000/api/memory/recent?status=pending_review&session_id=sess-1'),
    } as unknown as NextRequest;

    const response = await recentMemoriesGET(request);
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.fallbackApplied).toBe(true);
    expect(payload.memories).toHaveLength(2);
    expect(payload.memories.map((memory: { id: string }) => memory.id)).toEqual(['pending-1', 'legacy-1']);
  });

  it('does not leak pending-review memories from a different session into recap fallback', async () => {
    fetchSophiaApiMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({
          memories: [
            {
              id: 'other-session-1',
              memory: 'Pending from a different session',
              metadata: { session_id: 'sess-other', status: 'pending_review' },
              created_at: '2026-03-03T19:55:00.000Z',
            },
          ],
          count: 1,
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({
          memories: [
            {
              id: 'other-session-1',
              memory: 'Pending from a different session',
              metadata: { session_id: 'sess-other', status: 'pending_review' },
              created_at: '2026-03-03T19:55:00.000Z',
            },
          ],
          count: 1,
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

    const request = {
      nextUrl: new URL('http://localhost:3000/api/memory/recent?status=pending_review&session_id=sess-target&started_at=2026-03-03T19:46:00.000Z&ended_at=2026-03-03T20:00:00.000Z'),
    } as unknown as NextRequest;

    const response = await recentMemoriesGET(request);
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.fallbackApplied).toBe(true);
    expect(payload.memories).toEqual([]);
  });
});