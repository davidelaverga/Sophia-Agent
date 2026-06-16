import type { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const KNOWN_ARTIFACT_ID = 'artifact_2f8254e3547d87ab29e56bef';
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

function makeRequest(path = '/api/artifacts/upsert', headers: HeadersInit = {}): NextRequest {
  return {
    nextUrl: new URL(`http://localhost:3000${path}`),
    headers: new Headers(headers),
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
    mocks.getAuthenticatedUserIdMock.mockReturnValue('user-123');
    mocks.getPrimaryGatewayUrlMock.mockReturnValue('https://gateway.example');
    mocks.getUserScopedAuthHeaderMock.mockReturnValue('Bearer test-token');
    mocks.refreshUserScopedAuthHeaderMock.mockReturnValue('');
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
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

  it('logs the upstream JSON envelope shape while preserving the list response body', async () => {
    mocks.getAuthenticatedUserIdMock.mockResolvedValue('krEDzdbKU9ingOR78XxYFLSI7iyQeF0h');
    mocks.getUserScopedAuthHeaderMock.mockResolvedValue('Bearer user-token');
    const body = {
      artifacts: [{ artifact_id: KNOWN_ARTIFACT_ID, filename: 'sophia_test.md' }],
      total: 1,
    };
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: {
          'content-length': '123',
          'content-type': 'application/json',
        },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

    const response = await proxyArtifactRegistryRequest(
      makeRequest('/api/artifacts?sort=updated', { 'x-sophia-artifact-trace-id': 'trace-list-1' }),
      '',
      { method: 'GET' },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(response.headers.get('content-length')).toBeNull();
    await expect(response.json()).resolves.toEqual(body);

    expect(fetchMock).toHaveBeenCalledWith(
      'https://gateway.example/api/artifacts?sort=updated',
      expect.objectContaining({
        method: 'GET',
        cache: 'no-store',
      }),
    );
    const requestInit = fetchMock.mock.calls[0][1] as RequestInit & {
      headers: Record<string, string>;
    };
    expect(requestInit.headers.Authorization).toBe('Bearer user-token');
    expect(requestInit.headers['x-sophia-artifact-trace-id']).toBe('trace-list-1');

    expect(infoSpy).toHaveBeenCalledWith(
      '[artifact-registry-list-proxy]',
      expect.objectContaining({
        event: 'artifact_registry_list_proxy_result',
        trace_id: 'trace-list-1',
        route: '/api/artifacts',
        method: 'GET',
        authenticated_session_present: true,
        backend_auth_header_present: true,
        upstream_status: 200,
        upstream_content_type: 'application/json',
        json_parse_ok: true,
        top_level_type: 'object',
        artifacts_length: 1,
        known_artifact_present: true,
        final_response_status: 200,
      }),
    );
    const diagnostic = infoSpy.mock.calls[0][1];
    expect(JSON.stringify(diagnostic)).not.toContain('krEDzdbKU9ingOR78XxYFLSI7iyQeF0h');
    expect((diagnostic as { authenticated_vercel_user_hash: string }).authenticated_vercel_user_hash).toHaveLength(12);
  });

  it('logs list JSON parse failure without consuming the browser response body', async () => {
    mocks.getAuthenticatedUserIdMock.mockResolvedValue('krEDzdbKU9ingOR78XxYFLSI7iyQeF0h');
    mocks.getUserScopedAuthHeaderMock.mockResolvedValue('Bearer user-token');
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('not-json', {
        status: 200,
        headers: {
          'content-type': 'text/plain',
        },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

    const response = await proxyArtifactRegistryRequest(
      makeRequest('/api/artifacts?sort=updated', { 'x-sophia-artifact-trace-id': 'trace-list-2' }),
      '',
      { method: 'GET' },
    );

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe('not-json');
    expect(infoSpy).toHaveBeenCalledWith(
      '[artifact-registry-list-proxy]',
      expect.objectContaining({
        event: 'artifact_registry_list_proxy_result',
        trace_id: 'trace-list-2',
        upstream_status: 200,
        upstream_content_type: 'text/plain',
        json_parse_ok: false,
        top_level_type: 'string',
        known_artifact_present: false,
        final_response_status: 200,
      }),
    );
  });
});
