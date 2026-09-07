import { beforeEach, describe, expect, it, vi } from 'vitest';

const { fetchApi, resolveOwner } = vi.hoisted(() => ({ fetchApi: vi.fn(), resolveOwner: vi.fn() }));
vi.mock('../../app/api/_lib/sophia', () => ({ fetchSophiaApi: fetchApi, resolveSophiaUserId: resolveOwner }));

import { GET } from '../../app/api/memory/observability/route';

describe('memory observation proxy', () => {
  beforeEach(() => { vi.clearAllMocks(); resolveOwner.mockResolvedValue('ordinary-owner'); });

  it('requires ordinary authentication without contacting the backend', async () => {
    resolveOwner.mockResolvedValue(null);
    expect((await GET()).status).toBe(401);
    expect(fetchApi).not.toHaveBeenCalled();
  });

  it.each([403, 404, 500])('preserves denial and suppresses raw upstream %s bodies', async (status) => {
    fetchApi.mockResolvedValue(new Response('private-error-sentinel', { status }));
    const response = await GET();
    expect(response.status).toBe(status === 500 ? 503 : status);
    expect(await response.json()).toEqual({ available: false });
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(fetchApi).toHaveBeenCalledWith('/api/sophia/ordinary-owner/memory-observability', { method: 'GET', cache: 'no-store' });
  });

  it('rejects successful HTTP carrying a malformed metrics body', async () => {
    fetchApi.mockResolvedValue(new Response(JSON.stringify({ content: 'private-sentinel' }), { status: 200 }));
    const response = await GET();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ available: false });
  });
});
