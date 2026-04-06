/**
 * Tests for Fetch with Retry utility
 * Validates retry logic, exponential backoff, and error handling
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { fetchWithRetry, postJsonWithRetry } from '../../app/lib/fetch-with-retry';

describe('fetchWithRetry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('should return data on successful response', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ data: 'success' }),
    });

    const result = await fetchWithRetry<{ data: string }>('/api/test');

    expect(result.success).toBe(true);
    expect(result.data).toEqual({ data: 'success' });
    expect(result.attempts).toBe(1);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('should retry on 500 error and succeed', async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: () => Promise.resolve({ error: 'Server error' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ data: 'success' }),
      });

    const resultPromise = fetchWithRetry<{ data: string }>('/api/test', {}, {
      maxRetries: 3,
      baseDelay: 100,
    });

    // Fast-forward past the retry delay
    await vi.advanceTimersByTimeAsync(2000);

    const result = await resultPromise;

    expect(result.success).toBe(true);
    expect(result.attempts).toBe(2);
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it('should NOT retry on 400 error', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: () => Promise.resolve({ error: 'Bad request' }),
    });

    const result = await fetchWithRetry('/api/test', {}, { maxRetries: 3 });

    expect(result.success).toBe(false);
    expect(result.status).toBe(400);
    expect(result.attempts).toBe(1);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('should NOT retry on 401 error', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 401,
      json: () => Promise.resolve({ error: 'Unauthorized' }),
    });

    const result = await fetchWithRetry('/api/test', {}, { maxRetries: 3 });

    expect(result.success).toBe(false);
    expect(result.status).toBe(401);
    expect(result.attempts).toBe(1);
  });

  it('should NOT retry on 404 error', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 404,
      json: () => Promise.resolve({ error: 'Not found' }),
    });

    const result = await fetchWithRetry('/api/test', {}, { maxRetries: 3 });

    expect(result.success).toBe(false);
    expect(result.status).toBe(404);
    expect(result.attempts).toBe(1);
  });

  it('should retry on 429 (rate limit) error', async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        json: () => Promise.resolve({ error: 'Too many requests' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ data: 'success' }),
      });

    const resultPromise = fetchWithRetry<{ data: string }>('/api/test', {}, {
      maxRetries: 3,
      baseDelay: 100,
    });

    await vi.advanceTimersByTimeAsync(2000);
    const result = await resultPromise;

    expect(result.success).toBe(true);
    expect(result.attempts).toBe(2);
  });

  it('should exhaust all retries and return error', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      json: () => Promise.resolve({ error: 'Service unavailable' }),
    });

    const resultPromise = fetchWithRetry('/api/test', {}, {
      maxRetries: 2,
      baseDelay: 100,
    });

    // Advance through all retry delays
    await vi.advanceTimersByTimeAsync(10000);
    const result = await resultPromise;

    expect(result.success).toBe(false);
    expect(result.attempts).toBe(3); // 1 initial + 2 retries
    expect(global.fetch).toHaveBeenCalledTimes(3);
  });

  it('should call onRetry callback', async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: () => Promise.resolve({}),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ data: 'success' }),
      });

    const onRetry = vi.fn();

    const resultPromise = fetchWithRetry('/api/test', {}, {
      maxRetries: 2,
      baseDelay: 100,
      onRetry,
    });

    await vi.advanceTimersByTimeAsync(2000);
    await resultPromise;

    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith(1, expect.any(Error), expect.any(Number));
  });

  it('should handle timeout error', async () => {
    global.fetch = vi.fn().mockImplementation(() => 
      new Promise((_, reject) => {
        setTimeout(() => {
          reject(new DOMException('Aborted', 'AbortError'));
        }, 100);
      })
    );

    const resultPromise = fetchWithRetry('/api/test', {}, {
      maxRetries: 1,
      timeout: 50,
      baseDelay: 100,
    });

    await vi.advanceTimersByTimeAsync(5000);
    const result = await resultPromise;

    expect(result.success).toBe(false);
    expect(result.error?.message).toBe('Request timeout');
  });

  it('should handle network error', async () => {
    global.fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));

    const resultPromise = fetchWithRetry('/api/test', {}, {
      maxRetries: 1,
      baseDelay: 100,
    });

    await vi.advanceTimersByTimeAsync(5000);
    const result = await resultPromise;

    expect(result.success).toBe(false);
    expect(result.error?.message).toBe('Failed to fetch');
  });
});

describe('postJsonWithRetry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('should send POST request with JSON body', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ created: true }),
    });

    const result = await postJsonWithRetry<{ created: boolean }>(
      '/api/create',
      { name: 'test' }
    );

    expect(result.success).toBe(true);
    expect(result.data).toEqual({ created: true });
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/create',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ name: 'test' }),
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        }),
      })
    );
  });

  it('should retry POST on server error', async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 502,
        json: () => Promise.resolve({ error: 'Bad gateway' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ created: true }),
      });

    const resultPromise = postJsonWithRetry<{ created: boolean }>(
      '/api/create',
      { name: 'test' },
      {},
      { maxRetries: 2, baseDelay: 100 }
    );

    await vi.advanceTimersByTimeAsync(2000);
    const result = await resultPromise;

    expect(result.success).toBe(true);
    expect(result.attempts).toBe(2);
  });
});
