import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const voiceLabBoundary = vi.hoisted(() => vi.fn());

vi.mock('@/server/voice-lab/ordinary-route-isolation', () => ({
  voiceLabOrdinaryProductBoundaryResponse: voiceLabBoundary,
}));

vi.mock('../../app/lib/auth/server-auth', () => ({
  getUserScopedAuthToken: vi.fn(),
}));

vi.mock('../../app/lib/rate-limiter', () => ({
  apiLimiters: {
    wsTicket: {
      checkSync: vi.fn(() => true),
      getState: vi.fn(() => ({ waitTime: 2000 })),
    },
  },
}));

import { POST } from '../../app/api/ws-ticket/route';
import { getUserScopedAuthToken } from '../../app/lib/auth/server-auth';
import { apiLimiters } from '../../app/lib/rate-limiter';

describe('/api/ws-ticket POST', () => {
  const request = () => new NextRequest('https://sophia.example.test/api/ws-ticket', { method: 'POST' });

  beforeEach(() => {
    vi.clearAllMocks();
    voiceLabBoundary.mockResolvedValue(null);
    vi.mocked(apiLimiters.wsTicket.checkSync).mockReturnValue(true);
  });

  it('denies a marker-free dedicated identity before limiter or token access', async () => {
    voiceLabBoundary.mockResolvedValue(Response.json(
      { error: 'voice_lab_ordinary_product_route_forbidden' },
      { status: 403 },
    ));

    const response = await POST(request());

    expect(response.status).toBe(403);
    expect(apiLimiters.wsTicket.checkSync).not.toHaveBeenCalled();
    expect(getUserScopedAuthToken).not.toHaveBeenCalled();
  });

  it('returns 429 when rate limited', async () => {
    vi.mocked(apiLimiters.wsTicket.checkSync).mockReturnValue(false);

    const response = await POST(request());
    const data = await response.json();

    expect(response.status).toBe(429);
    expect(data).toEqual({ error: 'Too many ws-ticket requests' });
    expect(response.headers.get('Retry-After')).toBeTruthy();

    vi.mocked(apiLimiters.wsTicket.checkSync).mockReturnValue(true);
  });

  it('returns 401 when unauthenticated', async () => {
    vi.mocked(getUserScopedAuthToken).mockResolvedValue('');

    const response = await POST(request());
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data).toEqual({ error: 'Not authenticated' });
  });

  it('returns token when authenticated', async () => {
    vi.mocked(getUserScopedAuthToken).mockResolvedValue('token-123');

    const response = await POST(request());
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data).toEqual({ token: 'token-123' });
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });
});
