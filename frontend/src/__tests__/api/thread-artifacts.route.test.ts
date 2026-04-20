import type { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getUserScopedAuthHeaderMock: vi.fn(() => 'Bearer test-token'),
  refreshUserScopedAuthHeaderMock: vi.fn(() => ''),
  getPrimaryGatewayUrlMock: vi.fn(() => 'https://gateway.example'),
}));

vi.mock('../../app/lib/auth/server-auth', () => ({
  getUserScopedAuthHeader: () => mocks.getUserScopedAuthHeaderMock(),
  refreshUserScopedAuthHeader: () => mocks.refreshUserScopedAuthHeaderMock(),
}));

vi.mock('../../app/api/_lib/gateway-url', () => ({
  getPrimaryGatewayUrl: () => mocks.getPrimaryGatewayUrlMock(),
}));

import { GET } from '../../app/api/threads/[threadId]/artifacts/[...artifactPath]/route';

describe('/api/threads/[threadId]/artifacts/[...artifactPath] proxy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getUserScopedAuthHeaderMock.mockReturnValue('Bearer test-token');
    mocks.refreshUserScopedAuthHeaderMock.mockReturnValue('');
    mocks.getPrimaryGatewayUrlMock.mockReturnValue('https://gateway.example');
  });

  it('preserves the artifact file extension from the raw pathname when params are truncated', async () => {
    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValueOnce(
      new Response('artifact-body', {
        status: 200,
        headers: {
          'Content-Type': 'text/markdown; charset=utf-8',
          'Content-Disposition': 'attachment; filename="SFV_Restaurant_Guide.md"',
        },
      }),
    );

    const req = {
      method: 'GET',
      nextUrl: new URL(
        'http://localhost:3000/api/threads/thread-1/artifacts/mnt/user-data/outputs/SFV_Restaurant_Guide.md?download=true',
      ),
    } as unknown as NextRequest;

    const response = await GET(req, {
      params: Promise.resolve({
        threadId: 'thread-1',
        artifactPath: ['mnt', 'user-data', 'outputs', 'SFV_Restaurant_Guide'],
      }),
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      'https://gateway.example/api/threads/thread-1/artifacts/mnt/user-data/outputs/SFV_Restaurant_Guide.md?download=true',
    );
    expect((options.headers as Record<string, string>).Authorization).toBe('Bearer test-token');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-disposition')).toContain('SFV_Restaurant_Guide.md');
    await expect(response.text()).resolves.toBe('artifact-body');
  });

  it('falls back to the route params when the pathname does not include the artifact prefix', async () => {
    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValueOnce(
      new Response('ok', {
        status: 200,
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
        },
      }),
    );

    const req = {
      method: 'GET',
      nextUrl: new URL('http://localhost:3000/unexpected?download=true'),
    } as unknown as NextRequest;

    const response = await GET(req, {
      params: Promise.resolve({
        threadId: 'thread-1',
        artifactPath: ['mnt', 'user-data', 'outputs', 'Quarterly Report v2.pdf'],
      }),
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      'https://gateway.example/api/threads/thread-1/artifacts/mnt/user-data/outputs/Quarterly%20Report%20v2.pdf?download=true',
    );
    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe('ok');
  });
});