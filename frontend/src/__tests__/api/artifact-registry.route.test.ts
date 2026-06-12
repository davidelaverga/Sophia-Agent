import type { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const proxyArtifactRegistryRequestMock = vi.fn();

vi.mock('../../app/api/artifacts/_lib/proxy', () => ({
  proxyArtifactRegistryRequest: (...args: unknown[]) => proxyArtifactRegistryRequestMock(...args),
}));

import { GET as artifactContentGET } from '../../app/api/artifacts/[artifactId]/content/route';
import { GET as artifactDownloadGET } from '../../app/api/artifacts/[artifactId]/download/route';
import {
  DELETE as artifactDELETE,
  GET as artifactGET,
} from '../../app/api/artifacts/[artifactId]/route';

function makeRequest(): NextRequest {
  return {
    nextUrl: new URL('http://localhost:3000/api/artifacts/artifact-1'),
  } as unknown as NextRequest;
}

function params(artifactId = 'artifact 1') {
  return { params: Promise.resolve({ artifactId }) };
}

describe('artifact registry proxy routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    proxyArtifactRegistryRequestMock.mockResolvedValue(new Response('{}', { status: 200 }));
  });

  it('proxies artifact metadata requests by artifact id', async () => {
    const req = makeRequest();

    await artifactGET(req, params());

    expect(proxyArtifactRegistryRequestMock).toHaveBeenCalledWith(
      req,
      '/artifact%201',
      { method: 'GET' },
    );
  });

  it('proxies artifact delete requests by artifact id', async () => {
    const req = makeRequest();

    await artifactDELETE(req, params());

    expect(proxyArtifactRegistryRequestMock).toHaveBeenCalledWith(
      req,
      '/artifact%201',
      { method: 'DELETE' },
    );
  });

  it('proxies artifact content preview requests by artifact id', async () => {
    const req = makeRequest();

    await artifactContentGET(req, params());

    expect(proxyArtifactRegistryRequestMock).toHaveBeenCalledWith(
      req,
      '/artifact%201/content',
      { method: 'GET' },
    );
  });

  it('proxies artifact downloads by artifact id', async () => {
    const req = makeRequest();

    await artifactDownloadGET(req, params());

    expect(proxyArtifactRegistryRequestMock).toHaveBeenCalledWith(
      req,
      '/artifact%201/download',
      { method: 'GET' },
    );
  });
});
