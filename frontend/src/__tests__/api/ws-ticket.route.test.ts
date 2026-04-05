import { describe, expect, it, vi } from 'vitest';

vi.mock('../../app/lib/auth/server-auth', () => ({
  getServerAuthToken: vi.fn(),
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
import { getServerAuthToken } from '../../app/lib/auth/server-auth';
import { apiLimiters } from '../../app/lib/rate-limiter';

describe('/api/ws-ticket POST', () => {
  it('returns 429 when rate limited', async () => {
    vi.mocked(apiLimiters.wsTicket.checkSync).mockReturnValue(false);

    const response = await POST();
    const data = await response.json();

    expect(response.status).toBe(429);
    expect(data).toEqual({ error: 'Too many ws-ticket requests' });
    expect(response.headers.get('Retry-After')).toBeTruthy();

    vi.mocked(apiLimiters.wsTicket.checkSync).mockReturnValue(true);
  });

  it('returns 401 when unauthenticated', async () => {
    vi.mocked(getServerAuthToken).mockResolvedValue('');

    const response = await POST();
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data).toEqual({ error: 'Not authenticated' });
  });

  it('returns token when authenticated', async () => {
    vi.mocked(getServerAuthToken).mockResolvedValue('token-123');

    const response = await POST();
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data).toEqual({ token: 'token-123' });
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });
});
