import type { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getUserScopedAuthHeaderMock: vi.fn(() => 'Bearer test-token'),
  refreshUserScopedAuthHeaderMock: vi.fn(() => ''),
  getPrimaryGatewayUrlMock: vi.fn(() => 'https://gateway.example'),
}));

vi.mock('../../app/lib/auth/server-auth', () => ({
  getUserScopedAuthHeader: () => mocks.getUserScopedAuthHeaderMock(),
  refreshUserScopedAuthHeader: () => mocks.refreshUserScopedAuthHeaderMock(),
}));

vi.mock('../../app/api/_lib/gateway-url', () => ({
  getPrimaryGatewayUrl: () => mocks.getPrimaryGatewayUrlMock(),
}));

import { POST } from '../../app/api/threads/[threadId]/artifacts/quick-html-patch/route';

describe('/api/threads/[threadId]/artifacts/quick-html-patch proxy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getUserScopedAuthHeaderMock.mockReturnValue('Bearer test-token');
    mocks.refreshUserScopedAuthHeaderMock.mockReturnValue('');
    mocks.getPrimaryGatewayUrlMock.mockReturnValue('https://gateway.example');
  });

  it('forwards quick patch JSON to the gateway with user auth', async () => {
    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValueOnce(
      Response.json({ ok: true, result: 'patched', raw_html_excluded: true }),
    );
    const body = {
      artifact_path: 'mnt/user-data/outputs/site.html',
      renderer_kind: 'html',
      user_update_request: 'Change the title',
      quick_edit_kind: 'title',
      target_fields: { titleText: 'New Title' },
    };

    const req = new Request(
      'http://localhost:3000/api/threads/thread-1/artifacts/quick-html-patch',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
    ) as unknown as NextRequest;

    const response = await POST(req, {
      params: Promise.resolve({ threadId: 'thread-1' }),
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://gateway.example/api/threads/thread-1/artifacts/quick-html-patch');
    expect((options.headers as Record<string, string>).Authorization).toBe('Bearer test-token');
    expect(options.method).toBe('POST');
    expect(options.body).toBe(JSON.stringify(body));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, result: 'patched' });
  });
});
