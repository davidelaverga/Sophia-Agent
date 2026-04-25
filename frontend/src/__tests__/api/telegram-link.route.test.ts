import type { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const resolveSophiaUserIdMock = vi.fn();
const fetchSophiaApiMock = vi.fn();

vi.mock('../../app/api/_lib/sophia', () => ({
  resolveSophiaUserId: (...args: unknown[]) => resolveSophiaUserIdMock(...args),
  fetchSophiaApi: (...args: unknown[]) => fetchSophiaApiMock(...args),
}));

import {
  DELETE as telegramDELETE,
  GET as telegramGET,
  POST as telegramPOST,
} from '../../app/api/sophia/[userId]/telegram/link/route';

function makeRequest(userId: string): NextRequest {
  return {
    nextUrl: new URL(`http://localhost:3000/api/sophia/${userId}/telegram/link`),
    text: async () => '{}',
  } as unknown as NextRequest;
}

describe('telegram link proxy routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveSophiaUserIdMock.mockResolvedValue('user-1');
  });

  it('rejects POST when unauthenticated', async () => {
    resolveSophiaUserIdMock.mockResolvedValue(null);
    const response = await telegramPOST(makeRequest('user-1'), {
      params: Promise.resolve({ userId: 'user-1' }),
    });
    expect(response.status).toBe(401);
  });

  it('rejects POST when the path userId does not match the authenticated user', async () => {
    const response = await telegramPOST(makeRequest('user-2'), {
      params: Promise.resolve({ userId: 'user-2' }),
    });
    expect(response.status).toBe(403);
  });

  it('forwards POST to the gateway and returns the JSON body', async () => {
    const body = {
      url: 'https://t.me/Sophia_EI_bot?start=abc',
      token: 'abc',
      expires_at: 1234,
      bot_username: 'Sophia_EI_bot',
    };
    fetchSophiaApiMock.mockResolvedValueOnce(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const response = await telegramPOST(makeRequest('user-1'), {
      params: Promise.resolve({ userId: 'user-1' }),
    });

    expect(fetchSophiaApiMock).toHaveBeenCalledTimes(1);
    const [path, options] = fetchSophiaApiMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe('/api/sophia/user-1/telegram/link');
    expect(options.method).toBe('POST');
    expect(options.body).toBe('{}');
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(body);
  });

  it('forwards GET and returns linked status payload', async () => {
    const body = {
      linked: true,
      telegram_username: 'alice',
      telegram_chat_id: '42',
      bot_username: 'Sophia_EI_bot',
    };
    fetchSophiaApiMock.mockResolvedValueOnce(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const response = await telegramGET(makeRequest('user-1'), {
      params: Promise.resolve({ userId: 'user-1' }),
    });

    const [path, options] = fetchSophiaApiMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe('/api/sophia/user-1/telegram/link');
    expect(options.method).toBe('GET');
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(body);
  });

  it('forwards DELETE and returns 204 with no body', async () => {
    fetchSophiaApiMock.mockResolvedValueOnce(new Response(null, { status: 204 }));

    const response = await telegramDELETE(makeRequest('user-1'), {
      params: Promise.resolve({ userId: 'user-1' }),
    });

    const [path, options] = fetchSophiaApiMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe('/api/sophia/user-1/telegram/link');
    expect(options.method).toBe('DELETE');
    expect(response.status).toBe(204);
  });

  it('propagates error status codes from the gateway', async () => {
    fetchSophiaApiMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'upstream' }), {
        status: 502,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const response = await telegramPOST(makeRequest('user-1'), {
      params: Promise.resolve({ userId: 'user-1' }),
    });

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({ error: 'upstream' });
  });
});
