import type { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const getUserScopedAuthHeaderMock = vi.fn(() => 'Bearer test-token');
const refreshUserScopedAuthHeaderMock = vi.fn(() => '');
const logErrorMock = vi.fn();

vi.mock('../../app/lib/auth/server-auth', () => ({
  getUserScopedAuthHeader: () => getUserScopedAuthHeaderMock(),
  refreshUserScopedAuthHeader: () => refreshUserScopedAuthHeaderMock(),
}));

vi.mock('../../app/lib/error-logger', () => ({
  logger: {
    logError: (...args: unknown[]) => logErrorMock(...args),
  },
}));

import { GET } from '../../app/api/bootstrap/[...path]/route';

describe('/api/bootstrap/[...path] proxy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getUserScopedAuthHeaderMock.mockReturnValue('Bearer test-token');
    refreshUserScopedAuthHeaderMock.mockReturnValue('');
  });

  it('returns an empty opener payload when auth is unavailable', async () => {
    getUserScopedAuthHeaderMock.mockReturnValue('');

    const req = {
      method: 'GET',
      nextUrl: new URL('http://localhost:3000/api/bootstrap/opener'),
    } as unknown as NextRequest;

    const response = await GET(req, { params: Promise.resolve({ path: ['opener'] }) });

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data).toEqual({
      opener_text: '',
      suggested_ritual: null,
      emotional_context: null,
      has_opener: false,
    });
  });

  it('normalizes backend 401 from opener lookup into an empty payload', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const req = {
      method: 'GET',
      nextUrl: new URL('http://localhost:3000/api/bootstrap/opener'),
    } as unknown as NextRequest;

    const response = await GET(req, { params: Promise.resolve({ path: ['opener'] }) });

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data).toEqual({
      opener_text: '',
      suggested_ritual: null,
      emotional_context: null,
      has_opener: false,
    });
  });

  it('retries opener lookup once with a refreshed auth header before falling back', async () => {
    refreshUserScopedAuthHeaderMock.mockReturnValue('Bearer refreshed-token');

    const fetchMock = vi.spyOn(global, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'Unauthorized' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({
          opener_text: 'Welcome back',
          suggested_ritual: 'prepare',
          emotional_context: null,
          has_opener: true,
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );

    const req = {
      method: 'GET',
      nextUrl: new URL('http://localhost:3000/api/bootstrap/opener'),
    } as unknown as NextRequest;

    const response = await GET(req, { params: Promise.resolve({ path: ['opener'] }) });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const secondCall = fetchMock.mock.calls[1] as [string, RequestInit];
    expect((secondCall[1].headers as Record<string, string>).Authorization).toBe('Bearer refreshed-token');
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data).toEqual({
      opener_text: 'Welcome back',
      suggested_ritual: 'prepare',
      emotional_context: null,
      has_opener: true,
    });
  });

  it('returns an empty status payload when auth is unavailable', async () => {
    getUserScopedAuthHeaderMock.mockReturnValue('');

    const req = {
      method: 'GET',
      nextUrl: new URL('http://localhost:3000/api/bootstrap/status'),
    } as unknown as NextRequest;

    const response = await GET(req, { params: Promise.resolve({ path: ['status'] }) });

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data).toEqual({ has_opener: false, user_id: 'anonymous' });
  });
});