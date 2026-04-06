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

import { POST as endSessionPOST } from '../../app/api/sophia/end-session/route';
import { GET as recapGET } from '../../app/api/sophia/sessions/[sessionId]/recap/route';

describe('Sophia session routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveSophiaUserIdMock.mockResolvedValue('user-123');
  });

  it('proxies end-session and defaults thread_id from session_id', async () => {
    fetchSophiaApiMock.mockResolvedValue(
      new Response(JSON.stringify({ status: 'pipeline_queued', session_id: 'sess-1' }), {
        status: 202,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const request = {
      json: async () => ({ session_id: 'sess-1', offer_debrief: true }),
    } as unknown as NextRequest;

    const response = await endSessionPOST(request);

    expect(fetchSophiaApiMock).toHaveBeenCalledWith(
      '/api/sophia/user-123/end-session',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(JSON.parse(String(fetchSophiaApiMock.mock.calls[0][1].body))).toEqual({
      session_id: 'sess-1',
      offer_debrief: true,
      thread_id: 'sess-1',
    });
    expect(response.status).toBe(202);
  });

  it('proxies recap reads through the Sophia session recap endpoint', async () => {
    fetchSophiaApiMock.mockResolvedValue(
      new Response(JSON.stringify({ session_id: 'sess-2', status: 'ready' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const request = {
      nextUrl: new URL('http://localhost:3000/api/sophia/sessions/sess-2/recap'),
    } as unknown as NextRequest;

    const response = await recapGET(request, { params: Promise.resolve({ sessionId: 'sess-2' }) });

    expect(fetchSophiaApiMock).toHaveBeenCalledWith(
      '/api/sophia/user-123/sessions/sess-2/recap',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(response.status).toBe(200);
  });
});