import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { upstream } = vi.hoisted(() => ({ upstream: vi.fn() }));
vi.mock('../../app/api/_lib/sophia', () => ({ fetchSophiaApi: upstream, resolveSophiaUserId: async () => 'user-123' }));
vi.mock('../../app/lib/error-logger', () => ({ logger: { logError: vi.fn() } }));
import { GET } from '../../app/api/journal/route';
import { poolFixture } from '../lib/pool-fixture';

beforeEach(() => upstream.mockReset());
describe('ordinary Pool proxy preserves complete canonical envelope', () => {
  it('keeps owner/snapshot/completeness and exact text', async () => {
    const value = poolFixture();
    upstream.mockResolvedValue(new Response(JSON.stringify(value)));
    const result = await GET(new NextRequest('https://synthetic.invalid/api/journal'));
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual(value);
    expect(result.headers.get('Cache-Control')).toBe('no-store');
  });
  it.each(['owner', 'view', 'partial', 'duplicate', 'count', 'missing_text', 'old_schema', 'mixed_authority', 'unknown_projection', 'empty_body'])('denies %s rather than returning a successful subset', async fault => {
    const value = poolFixture();
    if (fault === 'owner') value.owner_id = 'other-owner';
    if (fault === 'view') { value.view = 'forgotten'; value.entries[0].metadata.lifecycle = 'forgotten'; }
    if (fault === 'partial') value.snapshot_count = 2;
    if (fault === 'duplicate') { value.entries.push(value.entries[0]); value.count = value.snapshot_count = 2; }
    if (fault === 'count') value.count = 0;
    if (fault === 'missing_text') value.entries[0].content = '';
    const raw = value as unknown as Record<string, unknown>;
    if (fault === 'old_schema') delete raw.schema;
    if (fault === 'mixed_authority') (value.entries[0].metadata as Record<string, unknown>).authority = 'provider';
    if (fault === 'unknown_projection') raw.projection_status = 'active';
    upstream.mockResolvedValue(new Response(fault === 'empty_body' ? '' : JSON.stringify(value)));
    const result = await GET(new NextRequest('https://synthetic.invalid/api/journal'));
    expect(result.status).toBe(503);
    expect(result.headers.get('Cache-Control')).toBe('no-store');
    expect(await result.text()).not.toContain('CURRENT_SYNTHETIC_TEXT');
    expect(upstream).toHaveBeenCalledTimes(1);
  });
});
