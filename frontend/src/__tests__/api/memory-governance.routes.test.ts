import type { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchSophiaApiMock = vi.fn();
const resolveSophiaUserIdMock = vi.fn();

vi.mock('../../app/api/_lib/sophia', () => ({
  fetchSophiaApi: (...args: unknown[]) => fetchSophiaApiMock(...args),
  resolveSophiaUserId: (...args: unknown[]) => resolveSophiaUserIdMock(...args),
}));

vi.mock('../../app/lib/error-logger', () => ({
  logger: { logError: vi.fn() },
}));

import { POST as forgetMemory } from '../../app/api/memories/[memoryId]/forget/route';
import { POST as restoreMemory } from '../../app/api/memories/[memoryId]/restore/route';
import { POST as createMemory } from '../../app/api/memories/route';

describe('canonical memory management routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveSophiaUserIdMock.mockResolvedValue('owner-123');
  });

  it('forwards an explicit manual create to the owner-scoped gateway', async () => {
    const payload = {
      text: 'Explicit memory',
      category: 'fact',
      scope: 'global',
      tier: 'none',
      idempotency_key: 'manual-create-operation',
    };
    fetchSophiaApiMock.mockResolvedValue(new Response(JSON.stringify({ id: 'memory-1' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    const request = { json: async () => payload } as unknown as NextRequest;

    const response = await createMemory(request);

    expect(response.status).toBe(200);
    expect(fetchSophiaApiMock).toHaveBeenCalledWith(
      '/api/sophia/owner-123/memories',
      { method: 'POST', body: JSON.stringify(payload) },
    );
  });

  it.each([
    ['forget', forgetMemory],
    ['restore', restoreMemory],
  ] as const)('forwards revision-bound %s', async (operation, handler) => {
    const payload = {
      expected_governance_revision: 3,
      idempotency_key: `${operation}-operation`,
    };
    fetchSophiaApiMock.mockResolvedValue(new Response(JSON.stringify({ status: operation }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    const request = { json: async () => payload } as unknown as NextRequest;

    const response = await handler(request, {
      params: Promise.resolve({ memoryId: 'memory-1' }),
    });

    expect(response.status).toBe(200);
    expect(fetchSophiaApiMock).toHaveBeenCalledWith(
      `/api/sophia/owner-123/memories/memory-1/${operation}`,
      { method: 'POST', body: JSON.stringify(payload) },
    );
  });
});
