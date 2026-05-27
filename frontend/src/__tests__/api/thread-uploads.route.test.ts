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

import { POST } from '../../app/api/threads/[threadId]/uploads/route';

function makeRequest(formData: FormData, options: { failFormData?: boolean } = {}): NextRequest {
  // We bypass the real Request constructor here because round-tripping
  // a FormData containing File instances through `new Request({ body:
  // formData })` and then re-parsing via `.formData()` hangs in
  // vitest's undici-on-jsdom env (browser polyfill parses but with
  // a slow blocking File reader). The route only calls `formData()`
  // on the request, so this minimal shim is sufficient for the
  // contract under test.
  return {
    formData: async () => {
      if (options.failFormData) throw new Error('boom: bad multipart');
      return formData;
    },
  } as unknown as NextRequest;
}

/**
 * Default fetch mock for proxy tests that need both:
 *   1. The ownership-lookup call (GET /api/sessions/list)
 *   2. The upload-forward call (POST /api/threads/{id}/uploads)
 *
 * Returns the ownership response from the first call and the upload
 * response from the second. Tests that need to exercise the ownership
 * failure path mock `fetch` themselves before calling POST.
 */
function mockOwnershipAndUploadFetch(
  threadId: string,
  uploadResponse: Response,
): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(global, 'fetch')
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({ sessions: [{ thread_id: threadId, session_id: 's1' }], total: 1 }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    )
    .mockResolvedValueOnce(uploadResponse);
}

describe('/api/threads/[threadId]/uploads proxy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getAuthenticatedUserIdMock.mockResolvedValue('user_test');
    mocks.getUserScopedAuthTokenMock.mockResolvedValue('token-xyz');
    mocks.getPrimaryGatewayUrlMock.mockReturnValue('https://gateway.example');
  });

  it('rejects requests with an unsafe threadId', async () => {
    const fd = new FormData();
    fd.append('files', new File([new Uint8Array([1, 2, 3])], 'x.png', { type: 'image/png' }));
    const res = await POST(makeRequest(fd), {
      params: Promise.resolve({ threadId: '../etc/passwd' }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/Invalid threadId/i);
  });

  it('rejects unauthenticated callers with 401', async () => {
    mocks.getAuthenticatedUserIdMock.mockResolvedValueOnce(null);
    const fd = new FormData();
    fd.append('files', new File([new Uint8Array([1])], 'x.png', { type: 'image/png' }));
    const res = await POST(makeRequest(fd), {
      params: Promise.resolve({ threadId: 'thread-abc' }),
    });
    expect(res.status).toBe(401);
  });

  it('rejects empty file lists with 400', async () => {
    const fd = new FormData();
    fd.append('notes', 'not a file');
    const res = await POST(makeRequest(fd), {
      params: Promise.resolve({ threadId: 'thread-abc' }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/No files/i);
  });

  it('forwards multipart to the gateway with the user-scoped Bearer token', async () => {
    const fetchMock = mockOwnershipAndUploadFetch(
      'thread-abc',
      new Response(
        JSON.stringify({ success: true, files: [{ filename: 'photo.png', size: '3' }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    const fd = new FormData();
    fd.append('files', new File([new Uint8Array([1, 2, 3])], 'photo.png', { type: 'image/png' }));

    const res = await POST(makeRequest(fd), {
      params: Promise.resolve({ threadId: 'thread-abc' }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { files: Array<{ filename: string }> };
    expect(body.files[0]?.filename).toBe('photo.png');

    // Two fetches: ownership lookup + upload forward.
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const [ownershipUrl, ownershipInit] = fetchMock.mock.calls[0];
    expect(ownershipUrl).toBe('https://gateway.example/api/sessions/list?user_id=user_test&limit=100');
    expect((ownershipInit as RequestInit | undefined)?.method).toBe('GET');

    const [uploadUrl, uploadInit] = fetchMock.mock.calls[1] as [string, RequestInit | undefined];
    expect(uploadUrl).toBe('https://gateway.example/api/threads/thread-abc/uploads');
    const headers = uploadInit?.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer token-xyz');
    // CRITICAL: must NOT set Content-Type manually — fetch auto-sets
    // the multipart boundary. Setting it would break the boundary.
    expect(headers['Content-Type']).toBeUndefined();
    // Body should be a FormData with the file echoed under "files".
    expect(uploadInit?.body).toBeInstanceOf(FormData);
    const proxiedFd = uploadInit?.body as FormData;
    const proxied = proxiedFd.getAll('files').filter((entry) => entry instanceof File);
    expect(proxied).toHaveLength(1);
    expect((proxied[0]).name).toBe('photo.png');
  });

  it('bubbles up gateway error responses', async () => {
    mockOwnershipAndUploadFetch(
      'thread-abc',
      new Response('boom', { status: 502 }),
    );
    const fd = new FormData();
    fd.append('files', new File([new Uint8Array([1])], 'x.png', { type: 'image/png' }));
    const res = await POST(makeRequest(fd), {
      params: Promise.resolve({ threadId: 'thread-abc' }),
    });
    expect(res.status).toBe(502);
  });

  // ─── Codex P1 ownership check (PR #132) ────────────────────────────

  it('rejects uploads to a threadId the user does not own (403)', async () => {
    // Ownership lookup returns sessions OWNED BY user_test but none
    // matching the requested thread-victim.
    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          sessions: [{ thread_id: 'thread-owned-1', session_id: 's1' }],
          total: 1,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    const fd = new FormData();
    fd.append('files', new File([new Uint8Array([1])], 'evil.png', { type: 'image/png' }));

    const res = await POST(makeRequest(fd), {
      params: Promise.resolve({ threadId: 'thread-victim' }),
    });

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/not owned/i);

    // Must NOT have called the upload endpoint — short-circuited
    // at the ownership check.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [ownershipUrl] = fetchMock.mock.calls[0];
    expect(ownershipUrl).toBe('https://gateway.example/api/sessions/list?user_id=user_test&limit=100');
  });

  it('fails closed when the ownership lookup itself errors (403)', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(
      new Response('upstream down', { status: 500 }),
    );

    const fd = new FormData();
    fd.append('files', new File([new Uint8Array([1])], 'x.png', { type: 'image/png' }));
    const res = await POST(makeRequest(fd), {
      params: Promise.resolve({ threadId: 'thread-abc' }),
    });
    expect(res.status).toBe(403);
  });

  it('fails closed when the ownership lookup throws (403)', async () => {
    vi.spyOn(global, 'fetch').mockRejectedValueOnce(new Error('network reset'));

    const fd = new FormData();
    fd.append('files', new File([new Uint8Array([1])], 'x.png', { type: 'image/png' }));
    const res = await POST(makeRequest(fd), {
      params: Promise.resolve({ threadId: 'thread-abc' }),
    });
    expect(res.status).toBe(403);
  });

  it('fails closed when the ownership lookup returns malformed JSON', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ unexpected: 'shape' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const fd = new FormData();
    fd.append('files', new File([new Uint8Array([1])], 'x.png', { type: 'image/png' }));
    const res = await POST(makeRequest(fd), {
      params: Promise.resolve({ threadId: 'thread-abc' }),
    });
    expect(res.status).toBe(403);
  });

  it('accepts uploads when the threadId is in the user-owned session list', async () => {
    // Multi-session user — owned thread is in the list but not first.
    mockOwnershipAndUploadFetch(
      'thread-second',
      new Response(
        JSON.stringify({ success: true, files: [{ filename: 'shot.png', size: '5' }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    // Override the default ownership response with one that has the
    // target thread later in the list.
    vi.spyOn(global, 'fetch').mockReset();
    const fetchMock = vi.spyOn(global, 'fetch')
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            sessions: [
              { thread_id: 'thread-first', session_id: 's-a' },
              { thread_id: 'thread-second', session_id: 's-b' },
              { thread_id: 'thread-third', session_id: 's-c' },
            ],
            total: 3,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ success: true, files: [{ filename: 'shot.png', size: '5' }] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );

    const fd = new FormData();
    fd.append('files', new File([new Uint8Array([1])], 'shot.png', { type: 'image/png' }));
    const res = await POST(makeRequest(fd), {
      params: Promise.resolve({ threadId: 'thread-second' }),
    });
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('rejects oversized uploads with 413', async () => {
    // Fake a File with size > 60 MB cap without allocating real bytes —
    // the route reads `.size` for the cap check, not the actual buffer.
    const fakeBig: File = {
      name: 'big.png',
      size: 61 * 1024 * 1024,
      type: 'image/png',
    } as unknown as File;
    Object.setPrototypeOf(fakeBig, File.prototype);
    // We can't put a fake File through real FormData.append (it validates),
    // so use a Map-like stand-in that satisfies the route's `.getAll('files')`
    // contract.
    const fakeFd = {
      getAll: (key: string) => (key === 'files' ? [fakeBig] : []),
    } as unknown as FormData;
    const res = await POST(
      {
        formData: async () => fakeFd,
      } as unknown as NextRequest,
      { params: Promise.resolve({ threadId: 'thread-abc' }) },
    );
    expect(res.status).toBe(413);
  });

  it('returns 400 when the multipart body itself is malformed', async () => {
    const res = await POST(makeRequest(new FormData(), { failFormData: true }), {
      params: Promise.resolve({ threadId: 'thread-abc' }),
    });
    expect(res.status).toBe(400);
  });
});
