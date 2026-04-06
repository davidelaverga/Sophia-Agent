import type { NextRequest } from 'next/server';
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../../app/lib/auth/server-auth', () => ({
  getServerAuthHeader: vi.fn(() => 'Bearer test-token'),
}));

import { GET, POST } from '../../app/api/sessions/[...path]/route';

describe('/api/sessions/[...path] proxy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
});
