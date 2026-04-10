import type { NextRequest } from 'next/server';
import { describe, expect, it, vi, beforeEach } from 'vitest';

const getUserScopedAuthHeaderMock = vi.fn(() => 'Bearer test-token');
const refreshUserScopedAuthHeaderMock = vi.fn(() => '');

vi.mock('../../app/lib/auth/server-auth', () => ({
  getUserScopedAuthHeader: () => getUserScopedAuthHeaderMock(),
  refreshUserScopedAuthHeader: () => refreshUserScopedAuthHeaderMock(),
}));

import { GET, POST } from '../../app/api/sessions/[...path]/route';

describe('/api/sessions/[...path] proxy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getUserScopedAuthHeaderMock.mockReturnValue('Bearer test-token');
    refreshUserScopedAuthHeaderMock.mockReturnValue('');
  });

  it('forwards GET request with query params and auth header', async () => {
    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const req = {
      method: 'GET',
      nextUrl: new URL('http://localhost:3000/api/sessions/active?page=2&page_size=10'),
      text: async () => '',
    } as unknown as NextRequest;

    const response = await GET(req, { params: Promise.resolve({ path: ['active'] }) });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/api/v1/sessions/active');
    expect(url).toContain('page=2');
    expect(url).toContain('page_size=10');
    expect(options.method).toBe('GET');
    expect((options.headers as Record<string, string>).Authorization).toBe('Bearer test-token');

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data).toEqual({ ok: true });
  });

  it('forwards POST request body', async () => {
    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const payload = { session_type: 'prepare' };
    const req = {
      method: 'POST',
      nextUrl: new URL('http://localhost:3000/api/sessions/start'),
      text: async () => JSON.stringify(payload),
    } as unknown as NextRequest;

    const response = await POST(req, { params: Promise.resolve({ path: ['start'] }) });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(options.method).toBe('POST');
    expect(options.body).toBe(JSON.stringify(payload));
    expect(response.status).toBe(200);
  });

  it('returns an empty active-session payload when auth is unavailable', async () => {
    getUserScopedAuthHeaderMock.mockReturnValue('');

    const req = {
      method: 'GET',
      nextUrl: new URL('http://localhost:3000/api/sessions/active'),
      text: async () => '',
    } as unknown as NextRequest;

    const response = await GET(req, { params: Promise.resolve({ path: ['active'] }) });

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data).toEqual({ has_active_session: false });
  });

  it('normalizes backend 401 from active-session lookup into an empty payload', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const req = {
      method: 'GET',
      nextUrl: new URL('http://localhost:3000/api/sessions/active'),
      text: async () => '',
    } as unknown as NextRequest;

    const response = await GET(req, { params: Promise.resolve({ path: ['active'] }) });

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data).toEqual({ has_active_session: false });
  });

  it('retries a protected POST once with a refreshed auth header after backend 401', async () => {
    refreshUserScopedAuthHeaderMock.mockReturnValue('Bearer refreshed-token');

    const fetchMock = vi.spyOn(global, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'Unauthorized' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );

    const payload = { session_type: 'prepare' };
    const req = {
      method: 'POST',
      nextUrl: new URL('http://localhost:3000/api/sessions/start'),
      text: async () => JSON.stringify(payload),
    } as unknown as NextRequest;

    const response = await POST(req, { params: Promise.resolve({ path: ['start'] }) });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const secondCall = fetchMock.mock.calls[1] as [string, RequestInit];
    expect((secondCall[1].headers as Record<string, string>).Authorization).toBe('Bearer refreshed-token');
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data).toEqual({ ok: true });
  });

  it('returns a local fallback micro-briefing when the backend endpoint is missing', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'Not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const req = {
      method: 'POST',
      nextUrl: new URL('http://localhost:3000/api/sessions/micro-briefing'),
      text: async () => JSON.stringify({ intent: 'nudge', preset_context: 'life' }),
    } as unknown as NextRequest;

    const response = await POST(req, { params: Promise.resolve({ path: ['micro-briefing'] }) });
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data).toMatchObject({
      briefing_source: 'fallback',
      has_memory: false,
    });
    expect(data.assistant_text).toContain('check-in');
  });
});
