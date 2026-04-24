import type { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const resolveSophiaUserIdMock = vi.fn();
const fetchSophiaApiMock = vi.fn();

vi.mock('../../app/api/_lib/sophia', () => ({
  resolveSophiaUserId: (...args: unknown[]) => resolveSophiaUserIdMock(...args),
  fetchSophiaApi: (...args: unknown[]) => fetchSophiaApiMock(...args),
}));

import { GET as activeTasksGET } from '../../app/api/sophia/tasks/active/route';

describe('Sophia active tasks route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveSophiaUserIdMock.mockResolvedValue('user-123');
  });

  it('returns null when thread_id is missing', async () => {
    const response = await activeTasksGET(
      {
        nextUrl: new URL('http://localhost:3000/api/sophia/tasks/active'),
      } as unknown as NextRequest,
    );

    expect(fetchSophiaApiMock).not.toHaveBeenCalled();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toBeNull();
  });

  it('returns 401 when there is no authenticated Sophia user', async () => {
    resolveSophiaUserIdMock.mockResolvedValue(null);

    const response = await activeTasksGET(
      {
        nextUrl: new URL('http://localhost:3000/api/sophia/tasks/active?thread_id=thread-1'),
      } as unknown as NextRequest,
    );

    expect(fetchSophiaApiMock).not.toHaveBeenCalled();
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'Not authenticated' });
  });

  it('proxies active task checks through the shared Sophia auth helper', async () => {
    fetchSophiaApiMock.mockResolvedValue(
      new Response(JSON.stringify({ task_id: 'task-1', state: 'running' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const response = await activeTasksGET(
      {
        nextUrl: new URL('http://localhost:3000/api/sophia/tasks/active?thread_id=thread-1&session_id=session-1'),
      } as unknown as NextRequest,
    );

    expect(fetchSophiaApiMock).toHaveBeenCalledWith(
      '/api/sophia/user-123/tasks/active?thread_id=thread-1&session_id=session-1',
      expect.objectContaining({
        method: 'GET',
        cache: 'no-store',
      }),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ task_id: 'task-1', state: 'running' });
  });

  it('returns null when the backend still rejects the task lookup', async () => {
    fetchSophiaApiMock.mockResolvedValue(
      new Response(JSON.stringify({ error: 'Not authenticated' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const response = await activeTasksGET(
      {
        nextUrl: new URL('http://localhost:3000/api/sophia/tasks/active?thread_id=thread-1'),
      } as unknown as NextRequest,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toBeNull();
  });
});