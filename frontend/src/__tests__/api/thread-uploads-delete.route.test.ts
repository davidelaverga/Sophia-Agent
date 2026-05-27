import type { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getAuthenticatedUserIdMock: vi.fn(async () => 'user_test'),
  getUserScopedAuthTokenMock: vi.fn(async () => 'token-xyz'),
  getPrimaryGatewayUrlMock: vi.fn(() => 'https://gateway.example'),
}));

vi.mock('../../app/lib/auth/server-auth', () => ({
  getAuthenticatedUserId: () => mocks.getAuthenticatedUserIdMock(),
  getUserScopedAuthToken: () => mocks.getUserScopedAuthTokenMock(),
}));

vi.mock('../../app/api/_lib/gateway-url', () => ({
  getPrimaryGatewayUrl: () => mocks.getPrimaryGatewayUrlMock(),
}));

import { DELETE } from '../../app/api/threads/[threadId]/uploads/[filename]/route';

function makeRequest(): NextRequest {
  return {} as unknown as NextRequest;
}

function mockOwnershipOk(threadId: string) {
  return vi.spyOn(global, 'fetch').mockResolvedValueOnce(
    new Response(
      JSON.stringify({ sessions: [{ thread_id: threadId, session_id: 's1' }], count: 1 }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ),
  );
}

describe('DELETE /api/threads/[threadId]/uploads/[filename] proxy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getAuthenticatedUserIdMock.mockResolvedValue('user_test');
    mocks.getUserScopedAuthTokenMock.mockResolvedValue('token-xyz');
    mocks.getPrimaryGatewayUrlMock.mockReturnValue('https://gateway.example');
  });

  it('rejects an unsafe threadId with 400', async () => {
    const res = await DELETE(makeRequest(), {
      params: Promise.resolve({ threadId: '../etc', filename: 'x.png' }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects only filenames the gateway upload route would also reject (Codex P2)', async () => {
    // Path separators + dotfiles + pseudo-paths. Anything else is a
    // legitimate filename the gateway upload sanitizer accepts and
    // we must let through (e.g. "Screenshot 2026-05-27 at 10.00.png"
    // — spaces are fine; an earlier strict allow-list rejected them
    // and left chips stuck in error).
    const rejected = ['../passwd', 'a/b.png', 'a\\b.png', '.hidden', '.', '..'];
    for (const filename of rejected) {
      const fetchSpy = vi.spyOn(global, 'fetch');
      const res = await DELETE(makeRequest(), {
        params: Promise.resolve({ threadId: 'thread-abc', filename }),
      });
      expect(res.status).toBe(400);
      expect(fetchSpy).not.toHaveBeenCalled();
      fetchSpy.mockRestore();
    }
  });

  it('accepts filenames the upload route also accepts: spaces, parens, brackets', async () => {
    // These are filesystem-legal and the gateway upload sanitizer
    // admits them (it only normalizes path separators via
    // ``Path(file.filename).name``). The DELETE proxy must too —
    // otherwise the user can't delete files they uploaded.
    const accepted = [
      'Screenshot 2026-05-27 at 10.00.png',
      'photo (1).png',
      'weird<tag>.png',
      "quote'inside.png",
      'a.b-c_d.png',
    ];
    for (const filename of accepted) {
      const fetchMock = mockOwnershipOk('thread-abc').mockResolvedValueOnce(
        new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
      const res = await DELETE(makeRequest(), {
        params: Promise.resolve({ threadId: 'thread-abc', filename }),
      });
      expect(res.status).toBe(200);
      // 2 calls: ownership lookup + DELETE forward.
      expect(fetchMock).toHaveBeenCalledTimes(2);
      fetchMock.mockRestore();
    }
  });

  it('rejects filenames with control characters (newline/NUL/etc.) with 400', async () => {
    const pathological = ['evil\n.png', 'a\0.png', 'tab\there.png'];
    for (const filename of pathological) {
      const fetchSpy = vi.spyOn(global, 'fetch');
      const res = await DELETE(makeRequest(), {
        params: Promise.resolve({ threadId: 'thread-abc', filename }),
      });
      expect(res.status).toBe(400);
      expect(fetchSpy).not.toHaveBeenCalled();
      fetchSpy.mockRestore();
    }
  });

  it('rejects unauthenticated callers with 401', async () => {
    mocks.getAuthenticatedUserIdMock.mockResolvedValueOnce(null);
    const res = await DELETE(makeRequest(), {
      params: Promise.resolve({ threadId: 'thread-abc', filename: 'x.png' }),
    });
    expect(res.status).toBe(401);
  });

  it('rejects DELETE on a thread the user does not own (403) — same gate as POST', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({ sessions: [{ thread_id: 'thread-owned' }], count: 1 }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const res = await DELETE(makeRequest(), {
      params: Promise.resolve({ threadId: 'thread-victim', filename: 'x.png' }),
    });
    expect(res.status).toBe(403);
  });

  it('forwards a valid DELETE to the gateway with the Bearer token + the right URL', async () => {
    const fetchMock = mockOwnershipOk('thread-abc').mockResolvedValueOnce(
      new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const res = await DELETE(makeRequest(), {
      params: Promise.resolve({ threadId: 'thread-abc', filename: 'photo.png' }),
    });

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [ownershipUrl] = fetchMock.mock.calls[0] as [string, RequestInit | undefined];
    expect(ownershipUrl).toMatch(/\/api\/v1\/sessions\/open\?/);

    const [deleteUrl, deleteInit] = fetchMock.mock.calls[1] as [string, RequestInit | undefined];
    expect(deleteUrl).toBe('https://gateway.example/api/threads/thread-abc/uploads/photo.png');
    expect(deleteInit?.method).toBe('DELETE');
    const headers = deleteInit?.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer token-xyz');
  });

  it('url-encodes the filename when forwarding (special-but-safe chars)', async () => {
    // Allow-list restricts to [A-Za-z0-9._-] but encodeURIComponent
    // is still applied — assertion guards the contract.
    const fetchMock = mockOwnershipOk('thread-abc').mockResolvedValueOnce(
      new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const res = await DELETE(makeRequest(), {
      params: Promise.resolve({ threadId: 'thread-abc', filename: 'a.b-c_d.png' }),
    });
    expect(res.status).toBe(200);
    const [deleteUrl] = fetchMock.mock.calls[1] as [string, RequestInit | undefined];
    expect(deleteUrl).toBe('https://gateway.example/api/threads/thread-abc/uploads/a.b-c_d.png');
  });

  it('bubbles up gateway error responses', async () => {
    mockOwnershipOk('thread-abc').mockResolvedValueOnce(
      new Response('not found', { status: 404 }),
    );
    const res = await DELETE(makeRequest(), {
      params: Promise.resolve({ threadId: 'thread-abc', filename: 'gone.png' }),
    });
    expect(res.status).toBe(404);
  });

  it('returns 502 when the gateway is unreachable', async () => {
    mockOwnershipOk('thread-abc').mockRejectedValueOnce(new Error('econnrefused'));
    const res = await DELETE(makeRequest(), {
      params: Promise.resolve({ threadId: 'thread-abc', filename: 'photo.png' }),
    });
    expect(res.status).toBe(502);
  });
});
