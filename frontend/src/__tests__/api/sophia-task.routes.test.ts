import type { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const resolveSophiaUserIdMock = vi.fn();
const fetchSophiaApiMock = vi.fn();

vi.mock('../../app/api/_lib/sophia', () => ({
  resolveSophiaUserId: (...args: unknown[]) => resolveSophiaUserIdMock(...args),
  fetchSophiaApi: (...args: unknown[]) => fetchSophiaApiMock(...args),
}));

import { POST as cancelTaskPOST } from '../../app/api/sophia/tasks/[taskId]/cancel/route';
import { GET as taskStatusGET } from '../../app/api/sophia/tasks/[taskId]/route';

describe('Sophia task routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveSophiaUserIdMock.mockResolvedValue('user-123');
  });

  it('proxies task status requests through the shared Sophia auth helper', async () => {
    fetchSophiaApiMock.mockResolvedValue(
      new Response(JSON.stringify({ task_id: 'task-1', status: 'running' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const response = await taskStatusGET(
      {} as NextRequest,
      { params: Promise.resolve({ taskId: 'task-1' }) },
    );

    expect(fetchSophiaApiMock).toHaveBeenCalledWith(
      '/api/sophia/user-123/tasks/task-1',
      expect.objectContaining({
        method: 'GET',
        cache: 'no-store',
      }),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ task_id: 'task-1', status: 'running' });
  });

  it('returns 401 for task status when there is no authenticated Sophia user', async () => {
    resolveSophiaUserIdMock.mockResolvedValue(null);

    const response = await taskStatusGET(
      {} as NextRequest,
      { params: Promise.resolve({ taskId: 'task-1' }) },
    );

    expect(fetchSophiaApiMock).not.toHaveBeenCalled();
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'Not authenticated' });
  });

  it('proxies task cancellation through the shared Sophia auth helper', async () => {
    fetchSophiaApiMock.mockResolvedValue(
      new Response(JSON.stringify({ task_id: 'task-1', status: 'cancelled' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const response = await cancelTaskPOST(
      {} as NextRequest,
      { params: Promise.resolve({ taskId: 'task-1' }) },
    );

    expect(fetchSophiaApiMock).toHaveBeenCalledWith(
      '/api/sophia/user-123/tasks/task-1/cancel',
      expect.objectContaining({
        method: 'POST',
        cache: 'no-store',
      }),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ task_id: 'task-1', status: 'cancelled' });
  });
});