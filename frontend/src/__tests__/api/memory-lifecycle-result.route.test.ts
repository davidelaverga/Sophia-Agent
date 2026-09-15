import { type NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { upstream } = vi.hoisted(() => ({ upstream: vi.fn() }));
vi.mock('../../app/api/_lib/sophia', () => ({ fetchSophiaApi: upstream, resolveSophiaUserId: async () => 'user-123', isSyntheticMemoryId: () => false }));
vi.mock('../../app/lib/error-logger', () => ({ logger: { logError: vi.fn() } }));
import { POST as forget } from '../../app/api/memories/[memoryId]/forget/route';
import { POST as restore } from '../../app/api/memories/[memoryId]/restore/route';
import { DELETE, PUT } from '../../app/api/memories/[memoryId]/route';
import { POST as createMemory } from '../../app/api/memories/route';
import { lifecycleResult } from '../lib/lifecycle-fixture';

beforeEach(() => upstream.mockReset());
describe.each(['create', 'edit'] as const)('%s canonical current-view response', action => {
  it('preserves the original receipt and separately validated current text', async () => {
    const value = lifecycleResult('restore', 'original-command-key', 'active');
    value.receipt.event_type = action === 'create' ? 'memory_manual_created' : 'memory_edited';
    upstream.mockResolvedValue(new Response(JSON.stringify(value)));
    const body = { text: 'SYNTHETIC_ORIGINAL_INPUT', idempotency_key: value.command_key,
      expected_content_revision: 2, expected_governance_revision: 4 };
    const request = { json: async () => body } as NextRequest;
    const response = action === 'create' ? await createMemory(request)
      : await PUT(request, { params: Promise.resolve({ memoryId: value.receipt.memory_id }) });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const result = await response.json();
    expect(result.receipt).toMatchObject(value.receipt);
    expect(result.current_view.memory.content).toBe('LATER_CANONICAL_TEXT');
    expect(JSON.stringify(result)).not.toContain('SYNTHETIC_ORIGINAL_INPUT');
    expect(upstream).toHaveBeenCalledTimes(1);
  });
});
describe.each([['forget', forget], ['restore', restore], ['delete', DELETE]] as const)('%s full historical receipt and independent current view', (action, handler) => {
  it.each(['active', 'forgotten', 'tombstoned', 'not_found', 'unavailable'])('validates %s independently of the original lifecycle', async state => {
    const value = lifecycleResult(action, 'original-command-key', state);
    upstream.mockResolvedValue(new Response(JSON.stringify(value)));
    const request = { json: async () => ({ expected_governance_revision: 3, idempotency_key: value.command_key }) } as NextRequest;
    const result = await handler(request, { params: Promise.resolve({ memoryId: value.receipt.memory_id }) });
    expect(result.status).toBe(action === 'delete' && ['active', 'forgotten'].includes(state) ? 503 : 200);
    expect(result.headers.get('Cache-Control')).toBe('no-store');
    const text = await result.text();
    if (result.status === 200) expect(JSON.parse(text).receipt).toMatchObject(value.receipt);
    else expect(text).not.toContain('LATER_CANONICAL_TEXT');
  });
  it.each(['owner', 'key', 'target', 'event', 'old_revision', 'false_erasure', 'missing_disposition', 'flat', 'outage'])('denies %s without fallback', async fault => {
    const value = lifecycleResult(action, 'original-command-key', action === 'delete' ? 'tombstoned' : 'active');
    if (fault === 'owner') value.owner_id = 'other-owner';
    if (fault === 'key') value.command_key = 'wrong-command-key';
    if (fault === 'target') value.receipt.memory_id = '10000000-0000-4000-8000-000000000002';
    if (fault === 'event') value.receipt.event_type = 'memory_manual_created';
    if (fault === 'old_revision') value.receipt.memory_governance_revision = 7;
    if (fault === 'false_erasure') value.privacy_disposition = { ...lifecycleResult('delete', 'unused').privacy_disposition, provider_cleanup: 'complete' };
    if (fault === 'missing_disposition') {
      if (action === 'delete') value.privacy_disposition = null;
      else value.privacy_disposition = lifecycleResult('delete', 'unused').privacy_disposition;
    }
    upstream.mockResolvedValue(new Response(JSON.stringify(fault === 'flat' ? { status: 'done' } : value), { status: fault === 'outage' ? 503 : 200 }));
    const request = { json: async () => ({ expected_governance_revision: 3, idempotency_key: 'original-command-key' }) } as NextRequest;
    const result = await handler(request, { params: Promise.resolve({ memoryId: lifecycleResult(action, 'unused').receipt.memory_id }) });
    expect(result.status).toBe(503);
    expect(result.headers.get('Cache-Control')).toBe('no-store');
    expect(await result.text()).not.toContain('LATER_CANONICAL_TEXT');
    expect(upstream).toHaveBeenCalledTimes(1);
  });
});
