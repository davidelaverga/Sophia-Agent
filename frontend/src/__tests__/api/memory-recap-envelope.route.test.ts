import { type NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { upstream, owner } = vi.hoisted(() => ({ upstream: vi.fn(), owner: vi.fn() }));
vi.mock('../../app/api/_lib/sophia', () => ({ fetchSophiaApi: upstream, resolveSophiaUserId: owner }));
vi.mock('../../app/lib/error-logger', () => ({ logger: { logError: vi.fn() } }));

import { GET } from '../../app/api/sophia/sessions/[sessionId]/recap/route';
import { reviewFixture } from '../fixtures/memory-review';

const request = { nextUrl: new URL('https://synthetic.invalid/api/sophia/sessions/session/recap?cursor=next&page_size=100&user_id=wrong') } as NextRequest;
const params = { params: Promise.resolve({ sessionId: 'session' }) };

describe('canonical recap proxy', () => {
  beforeEach(() => { vi.clearAllMocks(); owner.mockResolvedValue('owner'); });

  it('binds authenticated owner and paging, strips competing copies, and forbids caching', async () => {
    const envelope = reviewFixture();
    upstream.mockResolvedValue(new Response(JSON.stringify({ memory_review: envelope,
      recap_artifacts: { memory_candidates: [{ text: 'COMPETING_PRIVATE_COPY' }] } })));
    const response = await GET(request, params);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(upstream).toHaveBeenCalledWith('/api/sophia/owner/sessions/session/recap?cursor=next&page_size=100',
      { method: 'GET', cache: 'no-store' });
    const body = await response.json();
    expect(body.memory_review).toEqual(envelope);
    expect(JSON.stringify(body)).not.toContain('COMPETING_PRIVATE_COPY');
  });

  it.each(['owner', 'session', 'finalization', 'coverage'])('denies invalid %s without exposing candidates', async (fault) => {
    const envelope = reviewFixture();
    if (fault === 'owner') envelope.owner_id = 'wrong-owner';
    if (fault === 'session') envelope.session_id = 'wrong-session';
    if (fault === 'finalization') envelope.finalization.event_id = null;
    if (fault === 'coverage') envelope.covered_message_count = 0;
    upstream.mockResolvedValue(new Response(JSON.stringify({ memory_review: envelope })));
    const response = await GET(request, params);
    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ error: 'Failed to load Sophia recap' });
  });

  it.each([409, 503])('preserves upstream %s without forwarding an untrusted error body', async (status) => {
    upstream.mockResolvedValue(new Response('PRIVATE_UPSTREAM_DETAIL', { status }));
    const response = await GET(request, params);
    expect(response.status).toBe(status);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.text()).not.toContain('PRIVATE_UPSTREAM_DETAIL');
  });

  it('does not call upstream without a trusted owner', async () => {
    owner.mockResolvedValue(null);
    const response = await GET(request, params);
    expect(response.status).toBe(401);
    expect(upstream).not.toHaveBeenCalled();
  });
});
