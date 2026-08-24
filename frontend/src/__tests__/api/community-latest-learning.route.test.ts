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

import { GET } from '@/app/api/community/latest-learning/route';

describe('community latest-learning Voice Lab isolation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    delete process.env.BACKEND_API_URL;
    mocks.boundary.mockResolvedValue(null);
    mocks.getServerAuthToken.mockResolvedValue('ordinary-token');
  });

  it('denies a marker-free dedicated Voice Lab identity before auth or upstream allocation', async () => {
    const upstream = vi.fn();
    vi.stubGlobal('fetch', upstream);
    mocks.boundary.mockResolvedValue(
      Response.json(
        { error: 'voice_lab_ordinary_product_route_forbidden' },
        { status: 403 },
      ),
    );
    process.env.BACKEND_API_URL = 'https://gateway.example';

    const response = await GET(new Request('https://frontend.example/api/community/latest-learning') as never);

    expect(response.status).toBe(403);
    expect(mocks.getServerAuthToken).not.toHaveBeenCalled();
    expect(upstream).not.toHaveBeenCalled();
  });

  it('preserves the ordinary authenticated upstream request', async () => {
    const upstream = vi.fn().mockResolvedValue(
      Response.json({ title: 'ordinary learning' }),
    );
    vi.stubGlobal('fetch', upstream);
    process.env.BACKEND_API_URL = 'https://gateway.example';

    const response = await GET(new Request('https://frontend.example/api/community/latest-learning') as never);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ title: 'ordinary learning' });
    expect(upstream).toHaveBeenCalledWith(
      'https://gateway.example/api/community/latest-learning',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer ordinary-token' }),
      }),
    );
  });
});
