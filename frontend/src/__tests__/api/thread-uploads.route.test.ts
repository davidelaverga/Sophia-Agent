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
    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValueOnce(
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

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://gateway.example/api/threads/thread-abc/uploads');
    const headers = init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer token-xyz');
    // CRITICAL: must NOT set Content-Type manually — fetch auto-sets
    // the multipart boundary. Setting it would break the boundary.
    expect(headers['Content-Type']).toBeUndefined();
    // Body should be a FormData with the file echoed under "files".
    expect(init?.body).toBeInstanceOf(FormData);
    const proxiedFd = init?.body as FormData;
    const proxied = proxiedFd.getAll('files').filter((entry) => entry instanceof File);
    expect(proxied).toHaveLength(1);
    expect((proxied[0]).name).toBe('photo.png');
  });

  it('bubbles up gateway error responses', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(
      new Response('boom', { status: 502 }),
    );
    const fd = new FormData();
    fd.append('files', new File([new Uint8Array([1])], 'x.png', { type: 'image/png' }));
    const res = await POST(makeRequest(fd), {
      params: Promise.resolve({ threadId: 'thread-abc' }),
    });
    expect(res.status).toBe(502);
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
