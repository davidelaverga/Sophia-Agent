import type { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  class CapabilityError extends Error {
    constructor(readonly code: string, readonly status: number) {
      super(code);
    }
  }
  return {
    getAuthenticatedUserIdMock: vi.fn(() => 'user-1'),
    getUserScopedAuthHeaderMock: vi.fn(() => 'Bearer test-token'),
    refreshUserScopedAuthHeaderMock: vi.fn(() => ''),
    getPrimaryGatewayUrlMock: vi.fn(() => 'https://gateway.example'),
    getSessionReadCapabilityMock: vi.fn(),
    CapabilityError,
  };
});

vi.mock('../../app/lib/auth/server-auth', () => ({
  getAuthenticatedUserId: () => mocks.getAuthenticatedUserIdMock(),
  getUserScopedAuthHeader: () => mocks.getUserScopedAuthHeaderMock(),
  refreshUserScopedAuthHeader: () => mocks.refreshUserScopedAuthHeaderMock(),
}));

vi.mock('../../app/api/_lib/gateway-url', () => ({
  getPrimaryGatewayUrl: () => mocks.getPrimaryGatewayUrlMock(),
}));

vi.mock('../../server/voice-lab/capability', () => ({
  getVoiceLabSessionReadCapability: (...args: unknown[]) => mocks.getSessionReadCapabilityMock(...args),
  VOICE_LAB_CAPABILITY_HEADER: 'X-Sophia-Voice-Lab-Capability',
  VoiceLabCapabilityError: mocks.CapabilityError,
}));

import { GET as getArtifact } from '../../app/api/threads/[threadId]/artifacts/[...artifactPath]/route';
import { GET as listArtifacts } from '../../app/api/threads/[threadId]/artifacts/route';

describe('/api/threads/[threadId]/artifacts/[...artifactPath] proxy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getUserScopedAuthHeaderMock.mockReturnValue('Bearer test-token');
    mocks.getAuthenticatedUserIdMock.mockReturnValue('user-1');
    mocks.refreshUserScopedAuthHeaderMock.mockReturnValue('');
    mocks.getPrimaryGatewayUrlMock.mockReturnValue('https://gateway.example');
    mocks.getSessionReadCapabilityMock.mockResolvedValue(null);
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

    const response = await getArtifact(req, {
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
    expect((options.headers as Record<string, string>)['X-Sophia-Voice-Lab-Capability']).toBeUndefined();
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

    const response = await getArtifact(req, {
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

  it('forwards the HttpOnly exact-run read capability for list and content', async () => {
    mocks.getSessionReadCapabilityMock.mockResolvedValue('signed-read');
    const fetchMock = vi.spyOn(global, 'fetch')
      .mockResolvedValueOnce(Response.json({ thread_id: 'thread-lab', artifacts: [] }))
      .mockResolvedValueOnce(new Response('synthetic-artifact'));
    const listRequest = {
      method: 'GET',
      nextUrl: new URL('http://localhost:3000/api/threads/thread-lab/artifacts'),
    } as unknown as NextRequest;
    const contentRequest = {
      method: 'GET',
      nextUrl: new URL('http://localhost:3000/api/threads/thread-lab/artifacts/output.txt'),
    } as unknown as NextRequest;

    const listResponse = await listArtifacts(listRequest, {
      params: Promise.resolve({ threadId: 'thread-lab' }),
    });
    const contentResponse = await getArtifact(contentRequest, {
      params: Promise.resolve({ threadId: 'thread-lab', artifactPath: ['output.txt'] }),
    });

    expect(listResponse.status).toBe(200);
    expect(contentResponse.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(mocks.getUserScopedAuthHeaderMock).not.toHaveBeenCalled();
    expect(mocks.refreshUserScopedAuthHeaderMock).not.toHaveBeenCalled();
    for (const call of fetchMock.mock.calls) {
      const headers = call[1]?.headers as Record<string, string>;
      expect(headers['X-Sophia-Voice-Lab-Capability']).toBe('signed-read');
      expect(headers.Authorization).toBeUndefined();
    }
  });

  it('rejects an invalid run capability before artifact egress', async () => {
    mocks.getSessionReadCapabilityMock.mockRejectedValueOnce(
      new mocks.CapabilityError('voice_lab_capability_wrong_principal', 403),
    );
    const fetchMock = vi.spyOn(global, 'fetch');
    const req = {
      method: 'GET',
      nextUrl: new URL('http://localhost:3000/api/threads/thread-lab/artifacts/output.txt'),
    } as unknown as NextRequest;

    const response = await getArtifact(req, {
      params: Promise.resolve({ threadId: 'thread-lab', artifactPath: ['output.txt'] }),
    });

    expect(response.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
