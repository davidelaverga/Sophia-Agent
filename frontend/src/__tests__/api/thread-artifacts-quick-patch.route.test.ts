import type { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  class CapabilityError extends Error {
    constructor(readonly code: string, readonly status: number) {
      super(code);
    }
  }
  return {
    getAuthenticatedUserIdMock: vi.fn(() => 'user-1'),
    getUserScopedAuthHeaderMock: vi.fn(() => 'Bearer test-token'),
    refreshUserScopedAuthHeaderMock: vi.fn(() => ''),
    getPrimaryGatewayUrlMock: vi.fn(() => 'https://gateway.example'),
    getEndSessionCapabilityMock: vi.fn(),
    CapabilityError,
  };
});

vi.mock('../../app/lib/auth/server-auth', () => ({
  getAuthenticatedUserId: () => mocks.getAuthenticatedUserIdMock(),
  getUserScopedAuthHeader: () => mocks.getUserScopedAuthHeaderMock(),
  refreshUserScopedAuthHeader: () => mocks.refreshUserScopedAuthHeaderMock(),
}));

vi.mock('../../app/api/_lib/gateway-url', () => ({
  getPrimaryGatewayUrl: () => mocks.getPrimaryGatewayUrlMock(),
}));

vi.mock('../../server/voice-lab/capability', () => ({
  getVoiceLabEndSessionCapability: (...args: unknown[]) => mocks.getEndSessionCapabilityMock(...args),
  VOICE_LAB_CAPABILITY_HEADER: 'X-Sophia-Voice-Lab-Capability',
  VoiceLabCapabilityError: mocks.CapabilityError,
}));

import { POST } from '../../app/api/threads/[threadId]/artifacts/quick-html-patch/route';

describe('/api/threads/[threadId]/artifacts/quick-html-patch proxy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getAuthenticatedUserIdMock.mockReturnValue('user-1');
    mocks.getUserScopedAuthHeaderMock.mockReturnValue('Bearer test-token');
    mocks.refreshUserScopedAuthHeaderMock.mockReturnValue('');
    mocks.getPrimaryGatewayUrlMock.mockReturnValue('https://gateway.example');
    mocks.getEndSessionCapabilityMock.mockResolvedValue(null);
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

  it('forwards only the exact-run finalization capability for a synthetic patch', async () => {
    mocks.getEndSessionCapabilityMock.mockResolvedValueOnce('signed-finalize');
    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValueOnce(
      Response.json({ ok: true, result: 'patched', raw_html_excluded: true }),
    );
    const req = new Request(
      'http://localhost:3000/api/threads/thread-lab/artifacts/quick-html-patch',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          artifact_path: 'mnt/user-data/outputs/site.html',
          renderer_kind: 'html',
          user_update_request: 'Change title',
          quick_edit_kind: 'title',
        }),
      },
    ) as unknown as NextRequest;

    const response = await POST(req, {
      params: Promise.resolve({ threadId: 'thread-lab' }),
    });

    expect(response.status).toBe(200);
    const headers = fetchMock.mock.calls[0][1]?.headers as Record<string, string>;
    expect(headers['X-Sophia-Voice-Lab-Capability']).toBe('signed-finalize');
  });

  it('rejects invalid finalization context before reading the patch body or Gateway work', async () => {
    mocks.getEndSessionCapabilityMock.mockRejectedValueOnce(
      new mocks.CapabilityError('voice_lab_capability_wrong_principal', 403),
    );
    const fetchMock = vi.spyOn(global, 'fetch');
    const textMock = vi.fn();
    const req = {
      headers: new Headers({ 'Content-Type': 'application/json' }),
      text: textMock,
    } as unknown as NextRequest;

    const response = await POST(req, {
      params: Promise.resolve({ threadId: 'thread-lab' }),
    });

    expect(response.status).toBe(403);
    expect(textMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
