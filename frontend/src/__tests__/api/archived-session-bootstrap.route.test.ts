import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  boundary: vi.fn(),
  getServerAuthToken: vi.fn(),
}));

vi.mock('@/server/voice-lab/ordinary-route-isolation', () => ({
  voiceLabOrdinaryProductBoundaryResponse: mocks.boundary,
}));

vi.mock('@/app/lib/auth/server-auth', () => ({
  getServerAuthToken: mocks.getServerAuthToken,
}));

describe('archived session bootstrap Voice Lab isolation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    vi.unstubAllGlobals();
    process.env.RENDER_BACKEND_URL = 'https://gateway.example';
    delete process.env.NEXT_PUBLIC_API_URL;
    delete process.env.USE_MOCK_BOOTSTRAP;
    mocks.boundary.mockResolvedValue(null);
    mocks.getServerAuthToken.mockResolvedValue('ordinary-token');
  });

  it('denies a marker-free dedicated Voice Lab identity before parsing or upstream allocation', async () => {
    const upstream = vi.fn();
    vi.stubGlobal('fetch', upstream);
    mocks.boundary.mockResolvedValue(
      Response.json(
        { error: 'voice_lab_ordinary_product_route_forbidden' },
        { status: 403 },
      ),
    );
    const { GET } = await import('@/app/api/_archived_session/bootstrap/route');
    const request = new NextRequest(
      'https://frontend.example/api/_archived_session/bootstrap?user_id=spoofed-user',
    );

    const response = await GET(request);

    expect(response.status).toBe(403);
    expect(mocks.getServerAuthToken).not.toHaveBeenCalled();
    expect(upstream).not.toHaveBeenCalled();
  });

  it('preserves the ordinary authenticated bootstrap request', async () => {
    const upstream = vi.fn().mockResolvedValue(
      Response.json({ thread_id: 'ordinary-thread' }),
    );
    vi.stubGlobal('fetch', upstream);
    const { GET } = await import('@/app/api/_archived_session/bootstrap/route');
    const request = new NextRequest(
      'https://frontend.example/api/_archived_session/bootstrap?user_id=ordinary-user',
    );

    const response = await GET(request);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ thread_id: 'ordinary-thread' });
    expect(upstream).toHaveBeenCalledWith(
      'https://gateway.example/api/v1/session/bootstrap?user_id=ordinary-user',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer ordinary-token' }),
      }),
    );
  });
});
