import { type NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { fetchApi, owner } = vi.hoisted(() => ({ fetchApi: vi.fn(), owner: vi.fn() }));
vi.mock('../../app/api/_lib/sophia', () => ({ fetchSophiaApi: fetchApi, resolveSophiaUserId: owner }));
vi.mock('../../server/voice-lab/ordinary-route-isolation', () => ({ voiceLabOrdinaryProductBoundaryResponse: vi.fn(async () => null) }));
import { GET } from '../../app/api/memory/commands/[key]/route';

const receipt = { event_id: '00000000-0000-4000-8000-000000000001', candidate_id: 'candidate-a',
  memory_id: '00000000-0000-4000-8000-000000000002', operation_id: 'original-operation', event_type: 'approved',
  resulting_lifecycle: 'active', content_revision: 1, memory_governance_revision: 1,
  user_catalog_generation: 3, user_revocation_epoch: 1, idempotent_replay: true };
const read = (key = 'original:key') => GET({} as NextRequest, { params: Promise.resolve({ key }) });

describe('historical memory command lookup', () => {
  beforeEach(() => { vi.clearAllMocks(); owner.mockResolvedValue('authenticated-owner'); });
  it('binds the authenticated owner and strips text while preserving historical mapping', async () => {
    fetchApi.mockResolvedValue(new Response(JSON.stringify({ status: 'committed', historical_result_only: true,
      receipt: { ...receipt, canonical_content: 'SCRUBBED_PRIVATE_TEXT', request_digest: 'secret' } })));
    const response = await read();
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ status: 'committed', historical_result_only: true, receipt });
    expect(fetchApi).toHaveBeenCalledTimes(1);
    expect(fetchApi).toHaveBeenCalledWith('/api/sophia/authenticated-owner/memories/commands/original%3Akey', { method: 'GET', cache: 'no-store' });
  });
  it('distinguishes absence from an unavailable lookup', async () => {
    fetchApi.mockResolvedValue(new Response(JSON.stringify({ status: 'not_found', historical_result_only: true, receipt: null })));
    expect((await read()).status).toBe(200);
    fetchApi.mockResolvedValue(new Response('PRIVATE_ERROR', { status: 500 }));
    const failed = await read();
    expect(failed.status).toBe(503);
    expect(failed.headers.get('cache-control')).toBe('no-store');
    expect(await failed.text()).not.toContain('PRIVATE_ERROR');
  });
  it.each([{}, { status: 'committed', historical_result_only: false, receipt },
    { status: 'committed', historical_result_only: true, receipt: { ...receipt, user_catalog_generation: -1 } }])('fails closed on malformed status %j', async (body) => {
    fetchApi.mockResolvedValue(new Response(JSON.stringify(body)));
    expect((await read()).status).toBe(503);
  });
  it('does not fetch without authentication or a valid key', async () => {
    owner.mockResolvedValue(null);
    expect((await read()).status).toBe(401);
    owner.mockResolvedValue('owner');
    expect((await read('short')).status).toBe(400);
    expect(fetchApi).not.toHaveBeenCalled();
  });
});
