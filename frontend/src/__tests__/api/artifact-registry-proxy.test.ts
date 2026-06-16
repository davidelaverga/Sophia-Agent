import type { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getAuthenticatedUserIdMock: vi.fn(() => 'user-123'),
  getPrimaryGatewayUrlMock: vi.fn(() => 'https://gateway.example'),
  getUserScopedAuthHeaderMock: vi.fn(() => 'Bearer test-token'),
  refreshUserScopedAuthHeaderMock: vi.fn(() => ''),
}));

vi.mock('../../app/lib/auth/server-auth', () => ({
  getAuthenticatedUserId: () => mocks.getAuthenticatedUserIdMock(),
  getUserScopedAuthHeader: () => mocks.getUserScopedAuthHeaderMock(),
  refreshUserScopedAuthHeader: () => mocks.refreshUserScopedAuthHeaderMock(),
}));

vi.mock('../../app/api/_lib/gateway-url', () => ({
  getPrimaryGatewayUrl: () => mocks.getPrimaryGatewayUrlMock(),
}));

import { proxyArtifactRegistryRequest } from '../../app/api/artifacts/_lib/proxy';

function makeRequest(path = '/api/artifacts/upsert'): NextRequest {
  return {
    nextUrl: new URL(`http://localhost:3000${path}`),
  } as unknown as NextRequest;
}

function upsertPayload() {
  return {
    thread_id: 'thread-1',
    parent_thread_id: 'thread-1',
    task_id: 'task-1',
    run_id: 'langgraph-run-1',
    user_id: 'user-123',
    filename: 'sophia_test.md',
    local_path: '/mnt/user-data/outputs/sophia_test.md',
  };
}

describe('artifact registry proxy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
    mocks.getAuthenticatedUserIdMock.mockReturnValue('user-123');
    mocks.getPrimaryGatewayUrlMock.mockReturnValue('https://gateway.example');
    mocks.getUserScopedAuthHeaderMock.mockReturnValue('Bearer test-token');
    mocks.refreshUserScopedAuthHeaderMock.mockReturnValue('');
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  it('forwards artifact upsert run_id as metadata', async () => {
    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ artifact_id: 'artifact-1' }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const body = JSON.stringify(upsertPayload());

    const response = await proxyArtifactRegistryRequest(makeRequest(), '/upsert', {
      method: 'POST',
      body,
    });

    expect(response.status).toBe(201);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://gateway.example/api/artifacts/upsert');
    expect(options.method).toBe('POST');
    expect((options.headers as Record<string, string>).Authorization).toBe('Bearer test-token');
    expect((options.headers as Record<string, string>)['x-sophia-artifact-trace-id']).toBeTruthy();
    expect(JSON.parse(String(options.body))).toMatchObject({
      task_id: 'task-1',
      run_id: 'langgraph-run-1',
    });
  });

  it('does not retry stale run_id thread-reference 403s by stripping run_id', async () => {
    const upstreamBody = JSON.stringify({ detail: 'Artifact references an unauthorized thread' });
    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValueOnce(
      new Response(upstreamBody, {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const response = await proxyArtifactRegistryRequest(makeRequest(), '/upsert', {
      method: 'POST',
      body: JSON.stringify(upsertPayload()),
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(options.body))).toMatchObject({
      run_id: 'langgraph-run-1',
    });
    expect(response.status).toBe(403);
    await expect(response.text()).resolves.toBe(upstreamBody);
    expect(console.warn).toHaveBeenCalledWith(
      '[artifact-proxy] upstream_non_2xx',
      expect.objectContaining({
        upstream_status: 403,
        payload: expect.objectContaining({
          run_id_present: true,
        }),
      }),
    );
  });

  it('returns upstream 500 responses unchanged', async () => {
    const upstreamBody = JSON.stringify({ detail: 'registry unavailable' });
    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValueOnce(
      new Response(upstreamBody, {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const response = await proxyArtifactRegistryRequest(makeRequest(), '/upsert', {
      method: 'POST',
      body: JSON.stringify(upsertPayload()),
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(500);
    expect(response.headers.get('content-type')).toBe('application/json');
    await expect(response.text()).resolves.toBe(upstreamBody);
  });
});
