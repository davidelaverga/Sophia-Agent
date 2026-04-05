/**
 * Tests for Rate Limiter
 * Validates token bucket algorithm, throttling, and debouncing
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  RateLimiter,
  getRateLimiter,
  throttle,
  throttleAsync,
  debounce,
  cancelDebounce,
} from '../../app/lib/rate-limiter';

describe('RateLimiter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('Token Bucket Algorithm', () => {
    it('should allow requests up to maxRequests', () => {
      const limiter = new RateLimiter({
        maxRequests: 3,
        windowMs: 1000,
      });

      expect(limiter.checkSync()).toBe(true);
      expect(limiter.checkSync()).toBe(true);
      expect(limiter.checkSync()).toBe(true);
      expect(limiter.checkSync()).toBe(false); // Exhausted
    });

    it('should refill tokens over time', () => {
      const limiter = new RateLimiter({
        maxRequests: 3,
        windowMs: 3000, // 1 token per second
      });

      // Use all tokens
      limiter.checkSync();
      limiter.checkSync();
      limiter.checkSync();
      expect(limiter.checkSync()).toBe(false);

      // Wait 1 second - should get 1 token back
      vi.advanceTimersByTime(1000);
      expect(limiter.checkSync()).toBe(true);
      expect(limiter.checkSync()).toBe(false);
    });

    it('should not exceed maxTokens when refilling', () => {
      const limiter = new RateLimiter({
        maxRequests: 3,
        windowMs: 1000,
      });

      // Wait a long time
      vi.advanceTimersByTime(10000);

      // Should only have 3 tokens, not more
      expect(limiter.checkSync()).toBe(true);
      expect(limiter.checkSync()).toBe(true);
      expect(limiter.checkSync()).toBe(true);
      expect(limiter.checkSync()).toBe(false);
    });
  });

  describe('Rate Limited Callback', () => {
    it('should call onRateLimited when limit exceeded', () => {
      const onRateLimited = vi.fn();
      const limiter = new RateLimiter({
        maxRequests: 2,
        windowMs: 1000,
        onRateLimited,
      });

      limiter.checkSync();
      limiter.checkSync();
      expect(onRateLimited).not.toHaveBeenCalled();

      limiter.checkSync(); // This should trigger callback
      expect(onRateLimited).toHaveBeenCalledTimes(1);
      expect(onRateLimited).toHaveBeenCalledWith(expect.any(Number));
    });
  });

  describe('Async Acquire with Queue', () => {
    it('should queue requests when queueExcess is true', async () => {
      const limiter = new RateLimiter({
        maxRequests: 1,
        windowMs: 1000,
        queueExcess: true,
        maxQueueSize: 5,
      });

      // First request should be immediate
      const first = limiter.acquire();
      expect(await first).toBe(true);

      // Second request should queue
      const second = limiter.acquire();
      
      // Advance time to allow refill
      vi.advanceTimersByTime(1000);
      
      expect(await second).toBe(true);
    });

    it('should reject when queue is full', async () => {
      const limiter = new RateLimiter({
        maxRequests: 1,
        windowMs: 10000,
        queueExcess: true,
        maxQueueSize: 2,
      });

      // Use the token
      await limiter.acquire();

      // Queue 2 requests (don't await - they'll hang)
      limiter.acquire(); // queued 1
      limiter.acquire(); // queued 2

      // Third should be rejected (queue full)
      const rejected = await limiter.acquire();
      expect(rejected).toBe(false);
      
      // Reset to clean up pending promises
      limiter.reset();
    });

    it('should reject immediately when queueExcess is false', async () => {
      const limiter = new RateLimiter({
        maxRequests: 1,
        windowMs: 1000,
        queueExcess: false,
      });

      // Use the token
      expect(await limiter.acquire()).toBe(true);

      // Second should be rejected immediately
      expect(await limiter.acquire()).toBe(false);
    });
  });

  describe('getState', () => {
    it('should return current limiter state', () => {
      const limiter = new RateLimiter({
        maxRequests: 5,
        windowMs: 1000,
      });

      const state = limiter.getState();
      expect(state.availableTokens).toBe(5);
      expect(state.queueLength).toBe(0);
      expect(state.waitTime).toBe(0);

      // Use some tokens
      limiter.checkSync();
      limiter.checkSync();

      const newState = limiter.getState();
      expect(newState.availableTokens).toBe(3);
    });
  });

  describe('reset', () => {
    it('should reset tokens to max', () => {
      const limiter = new RateLimiter({
        maxRequests: 3,
        windowMs: 1000,
      });

      // Use all tokens
      limiter.checkSync();
      limiter.checkSync();
      limiter.checkSync();
      expect(limiter.getState().availableTokens).toBe(0);

      // Reset
      limiter.reset();
      expect(limiter.getState().availableTokens).toBe(3);
    });
  });
});

describe('getRateLimiter', () => {
  it('should return same instance for same name', () => {
    const limiter1 = getRateLimiter('test-limiter', {
      maxRequests: 5,
      windowMs: 1000,
    });
    const limiter2 = getRateLimiter('test-limiter');

    expect(limiter1).toBe(limiter2);
  });
});

describe('throttle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should allow first call', () => {
    expect(throttle('test-key', 1000)).toBe(true);
  });

  it('should block calls within delay', () => {
    throttle('throttle-test', 1000);
    expect(throttle('throttle-test', 1000)).toBe(false);
    expect(throttle('throttle-test', 1000)).toBe(false);
  });

  it('should allow calls after delay', () => {
    throttle('throttle-test-2', 1000);
    
    vi.advanceTimersByTime(1000);
    
    expect(throttle('throttle-test-2', 1000)).toBe(true);
  });

  it('should track different keys separately', () => {
    throttle('key-a', 1000);
    
    expect(throttle('key-a', 1000)).toBe(false);
    expect(throttle('key-b', 1000)).toBe(true);
  });
});

describe('throttleAsync', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should wait until throttle clears', async () => {
    // First call immediate
    const start = Date.now();
    await throttleAsync('async-test', 1000);
    
    // Second call should wait
    const secondPromise = throttleAsync('async-test', 1000);
    vi.advanceTimersByTime(1000);
    await secondPromise;
    
    // Should have waited
    expect(Date.now() - start).toBeGreaterThanOrEqual(1000);
  });
});

describe('debounce', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should delay function execution', async () => {
    const fn = vi.fn().mockReturnValue('result');
    
    const promise = debounce('debounce-test', fn, 500);
    
    // Function not called yet
    expect(fn).not.toHaveBeenCalled();
    
    // Advance time
    vi.advanceTimersByTime(500);
    
    const result = await promise;
    expect(fn).toHaveBeenCalledTimes(1);
    expect(result).toBe('result');
  });

  it('should reset timer on subsequent calls', async () => {
    const fn = vi.fn().mockReturnValue('final');
    
    // First call
    debounce('debounce-reset', fn, 500);
    
    // Advance partway
    vi.advanceTimersByTime(300);
    expect(fn).not.toHaveBeenCalled();
    
    // Second call resets timer
    const promise = debounce('debounce-reset', fn, 500);
    
    // Advance original time - still not called
    vi.advanceTimersByTime(300);
    expect(fn).not.toHaveBeenCalled();
    
    // Advance full new time
    vi.advanceTimersByTime(200);
    
    const result = await promise;
    expect(fn).toHaveBeenCalledTimes(1);
    expect(result).toBe('final');
  });

  it('should handle async functions', async () => {
    const fn = vi.fn().mockResolvedValue('async-result');
    
    const promise = debounce('debounce-async', fn, 500);
    vi.advanceTimersByTime(500);
    
    const result = await promise;
    expect(result).toBe('async-result');
  });
});

describe('cancelDebounce', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should cancel pending debounced call', async () => {
    const fn = vi.fn();
    
    debounce('cancel-test', fn, 500);
    
    // Cancel before execution
    cancelDebounce('cancel-test');
    
    // Advance past delay
    vi.advanceTimersByTime(1000);
    
    // Function should not have been called
    expect(fn).not.toHaveBeenCalled();
  });
});
