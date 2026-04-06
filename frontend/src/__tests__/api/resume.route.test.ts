import type { NextRequest } from 'next/server';
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../../app/lib/auth/server-auth', () => ({
  getServerAuthToken: vi.fn(() => 'token-123'),
}));

import { OPTIONS, POST } from '../../app/api/resume/route';

describe('/api/resume POST', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 400 for missing required fields', async () => {
    const req = new Request('http://localhost:3000/api/resume', {
      method: 'POST',
      body: JSON.stringify({ thread_id: 't1' }),
      headers: { 'Content-Type': 'application/json' },
    }) as unknown as NextRequest;

    const response = await POST(req);
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(String(data.error || '')).toContain('Missing required fields');
  });

  it('maps backend 410 to INTERRUPT_EXPIRED', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(
      new Response('expired', { status: 410, statusText: 'Gone' })
    );

    const req = new Request('http://localhost:3000/api/resume', {
      method: 'POST',
      body: JSON.stringify({
        thread_id: 'thread-1',
        session_id: 'session-1',
        interrupt_kind: 'RESET_OFFER',
        selected_option_id: 'accept',
      }),
      headers: { 'Content-Type': 'application/json' },
    }) as unknown as NextRequest;

    const response = await POST(req);
    const data = await response.json();

    expect(response.status).toBe(410);
    expect(data.code).toBe('INTERRUPT_EXPIRED');
  });

  it('maps generic backend failure to 502', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(
      new Response('backend down', { status: 500, statusText: 'Internal Server Error' })
    );

    const req = new Request('http://localhost:3000/api/resume', {
      method: 'POST',
      body: JSON.stringify({
        thread_id: 'thread-1',
        session_id: 'session-1',
        interrupt_kind: 'RESET_OFFER',
        selected_option_id: 'accept',
      }),
      headers: { 'Content-Type': 'application/json' },
    }) as unknown as NextRequest;

    const response = await POST(req);
    const data = await response.json();

    expect(response.status).toBe(502);
    expect(data.error).toBe('Backend temporarily unavailable');
  });

  it('OPTIONS does not return wildcard CORS when no allowed origin is configured', async () => {
    const req = new Request('http://localhost:3000/api/resume', {
      method: 'OPTIONS',
      headers: { Origin: 'http://localhost:3000' },
    }) as unknown as NextRequest;

    const response = await OPTIONS(req);

    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('OPTIONS allows configured origin', async () => {
    process.env.CORS_ALLOWED_ORIGIN = 'http://localhost:3000';

    const req = new Request('http://localhost:3000/api/resume', {
      method: 'OPTIONS',
      headers: { Origin: 'http://localhost:3000' },
    }) as unknown as NextRequest;

    const response = await OPTIONS(req);

    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:3000');
    expect(response.headers.get('Vary')).toBe('Origin');

    delete process.env.CORS_ALLOWED_ORIGIN;
  });
});
