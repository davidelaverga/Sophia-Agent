import type { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchSophiaApiMock = vi.fn();
const resolveSophiaUserIdMock = vi.fn();
const isSyntheticMemoryIdMock = vi.fn();

vi.mock('../../app/api/_lib/sophia', () => ({
  fetchSophiaApi: (...args: unknown[]) => fetchSophiaApiMock(...args),
  resolveSophiaUserId: (...args: unknown[]) => resolveSophiaUserIdMock(...args),
  isSyntheticMemoryId: (...args: unknown[]) => isSyntheticMemoryIdMock(...args),
}));

vi.mock('../../app/lib/error-logger', () => ({
  logger: {
    logError: vi.fn(),
  },
}));

import {
  DELETE as deleteMemory,
  PUT as updateMemory,
} from '../../app/api/memories/[memoryId]/route';

describe('memory item route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveSophiaUserIdMock.mockResolvedValue('user-123');
    isSyntheticMemoryIdMock.mockReturnValue(false);
  });

  it('forwards PUT requests to the Sophia gateway', async () => {
    fetchSophiaApiMock.mockResolvedValue(
      new Response(JSON.stringify({ id: 'mem-123', content: 'Updated memory' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const request = {
      nextUrl: new URL('http://localhost:3000/api/memories/mem-123'),
      json: vi.fn().mockResolvedValue({ text: 'Updated memory' }),
    } as unknown as NextRequest;

    const response = await updateMemory(request, { params: Promise.resolve({ memoryId: 'mem-123' }) });
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.content).toBe('Updated memory');
    expect(fetchSophiaApiMock).toHaveBeenCalledWith(
      '/api/sophia/user-123/memories/mem-123',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ text: 'Updated memory' }),
      }),
    );
  });

  it('rejects PUT requests for synthetic memory ids', async () => {
    isSyntheticMemoryIdMock.mockReturnValue(true);

    const request = {
      nextUrl: new URL('http://localhost:3000/api/memories/candidate-1'),
      json: vi.fn().mockResolvedValue({ text: 'Ignored' }),
    } as unknown as NextRequest;

    const response = await updateMemory(request, { params: Promise.resolve({ memoryId: 'candidate-1' }) });
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload.error).toMatch(/Synthetic memories/);
    expect(fetchSophiaApiMock).not.toHaveBeenCalled();
  });

  it('forwards PUT requests for local review memory ids', async () => {
    isSyntheticMemoryIdMock.mockReturnValue(true);
    fetchSophiaApiMock.mockResolvedValue(
      new Response(JSON.stringify({ id: 'local:abc123', content: 'Updated local memory' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const request = {
      nextUrl: new URL('http://localhost:3000/api/memories/local:abc123'),
      json: vi.fn().mockResolvedValue({ text: 'Updated local memory' }),
    } as unknown as NextRequest;

    const response = await updateMemory(request, { params: Promise.resolve({ memoryId: 'local:abc123' }) });
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.content).toBe('Updated local memory');
    expect(fetchSophiaApiMock).toHaveBeenCalledWith(
      '/api/sophia/user-123/memories/local%3Aabc123',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ text: 'Updated local memory' }),
      }),
    );
  });

  it('passes DELETE responses through from the Sophia gateway', async () => {
    fetchSophiaApiMock.mockResolvedValue(new Response(null, { status: 204 }));

    const request = {
      nextUrl: new URL('http://localhost:3000/api/memories/mem-123'),
    } as unknown as NextRequest;

    const response = await deleteMemory(request, { params: Promise.resolve({ memoryId: 'mem-123' }) });

    expect(response.status).toBe(204);
    expect(fetchSophiaApiMock).toHaveBeenCalledWith(
      '/api/sophia/user-123/memories/mem-123',
      expect.objectContaining({ method: 'DELETE' }),
    );
  });

  it('forwards DELETE requests for local review memory ids', async () => {
    isSyntheticMemoryIdMock.mockReturnValue(true);
    fetchSophiaApiMock.mockResolvedValue(new Response(null, { status: 204 }));

    const request = {
      nextUrl: new URL('http://localhost:3000/api/memories/local:abc123'),
    } as unknown as NextRequest;

    const response = await deleteMemory(request, { params: Promise.resolve({ memoryId: 'local:abc123' }) });

    expect(response.status).toBe(204);
    expect(fetchSophiaApiMock).toHaveBeenCalledWith(
      '/api/sophia/user-123/memories/local%3Aabc123',
      expect.objectContaining({ method: 'DELETE' }),
    );
  });
});