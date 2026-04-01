/**
 * Client-Side Rate Limiter
 * P1 - Prevents API spam and protects backend from abuse
 * 
 * Features:
 * - Token bucket algorithm for smooth rate limiting
 * - Per-endpoint configuration
 * - Queuing with timeout
 * - User feedback when rate limited
 */

import { logger } from './error-logger';

// =============================================================================
// TYPES
// =============================================================================

export interface RateLimiterConfig {
  /** Max requests allowed in the window */
  maxRequests: number;
  /** Time window in milliseconds */
  windowMs: number;
  /** Whether to queue requests that exceed the limit */
  queueExcess?: boolean;
  /** Max queue size (default: 10) */
  maxQueueSize?: number;
  /** Callback when rate limited */
  onRateLimited?: (waitTime: number) => void;
}

interface TokenBucket {
  tokens: number;
  lastRefill: number;
  queue: Array<{
    resolve: (allowed: boolean) => void;
    timestamp: number;
  }>;
}

// =============================================================================
// RATE LIMITER CLASS
// =============================================================================

export class RateLimiter {
  private bucket: TokenBucket;
  private readonly maxTokens: number;
  private readonly refillRate: number; // tokens per ms
  private readonly queueExcess: boolean;
  private readonly maxQueueSize: number;
  private readonly onRateLimited?: (waitTime: number) => void;
  private processingQueue = false;

  constructor(config: RateLimiterConfig) {
    this.maxTokens = config.maxRequests;
    this.refillRate = config.maxRequests / config.windowMs;
    this.queueExcess = config.queueExcess ?? false;
    this.maxQueueSize = config.maxQueueSize ?? 10;
    this.onRateLimited = config.onRateLimited;

    this.bucket = {
      tokens: config.maxRequests,
      lastRefill: Date.now(),
      queue: [],
    };
  }

  /**
   * Refill tokens based on elapsed time
   */
  private refillTokens(): void {
    const now = Date.now();
    const elapsed = now - this.bucket.lastRefill;
    const tokensToAdd = elapsed * this.refillRate;

    this.bucket.tokens = Math.min(this.maxTokens, this.bucket.tokens + tokensToAdd);
    this.bucket.lastRefill = now;
  }

  /**
   * Calculate wait time until a token is available
   */
  private getWaitTime(): number {
    if (this.bucket.tokens >= 1) return 0;
    const tokensNeeded = 1 - this.bucket.tokens;
    return Math.ceil(tokensNeeded / this.refillRate);
  }

  /**
   * Process queued requests
   */
  private async processQueue(): Promise<void> {
    if (this.processingQueue) return;
    this.processingQueue = true;

    while (this.bucket.queue.length > 0) {
      this.refillTokens();

      if (this.bucket.tokens >= 1) {
        const item = this.bucket.queue.shift();
        if (item) {
          this.bucket.tokens -= 1;
          item.resolve(true);
        }
      } else {
        // Wait for next token
        const waitTime = this.getWaitTime();
        await new Promise(resolve => setTimeout(resolve, waitTime));
      }
    }

    this.processingQueue = false;
  }

  /**
   * Check if request is allowed (sync)
   * Returns true if allowed, false if rate limited
   */
  checkSync(): boolean {
    this.refillTokens();

    if (this.bucket.tokens >= 1) {
      this.bucket.tokens -= 1;
      return true;
    }

    const waitTime = this.getWaitTime();
    this.onRateLimited?.(waitTime);
    return false;
  }

  /**
   * Request permission to proceed (async)
   * Will queue if configured, otherwise returns immediately
   */
  async acquire(): Promise<boolean> {
    this.refillTokens();

    // If we have tokens, consume one and proceed
    if (this.bucket.tokens >= 1) {
      this.bucket.tokens -= 1;
      return true;
    }

    // No tokens available
    const waitTime = this.getWaitTime();
    this.onRateLimited?.(waitTime);

    // If not queueing, reject immediately
    if (!this.queueExcess) {
      return false;
    }

    // Check queue size
    if (this.bucket.queue.length >= this.maxQueueSize) {
      logger.debug('RateLimiter', 'Queue full, rejecting request');
      return false;
    }

    // Add to queue
    return new Promise<boolean>(resolve => {
      this.bucket.queue.push({
        resolve,
        timestamp: Date.now(),
      });
      this.processQueue();
    });
  }

  /**
   * Get current state (for debugging/UI)
   */
  getState(): {
    availableTokens: number;
    queueLength: number;
    waitTime: number;
  } {
    this.refillTokens();
    return {
      availableTokens: Math.floor(this.bucket.tokens),
      queueLength: this.bucket.queue.length,
      waitTime: this.getWaitTime(),
    };
  }

  /**
   * Reset the rate limiter
   */
  reset(): void {
    this.bucket.tokens = this.maxTokens;
    this.bucket.lastRefill = Date.now();
    // Resolve all queued items as rejected
    this.bucket.queue.forEach(item => item.resolve(false));
    this.bucket.queue = [];
  }
}

// =============================================================================
// PRE-CONFIGURED LIMITERS FOR COMMON ENDPOINTS
// =============================================================================

const limiters = new Map<string, RateLimiter>();

/**
 * Get or create a rate limiter for a specific endpoint
 */
export function getRateLimiter(
  name: string,
  config?: RateLimiterConfig
): RateLimiter {
  if (!limiters.has(name) && config) {
    limiters.set(name, new RateLimiter(config));
  }
  return limiters.get(name)!;
}

// Pre-configured limiters for Sophia API endpoints
export const apiLimiters = {
  /**
   * Chat messages - 10 per 10 seconds
   * Prevents message spam
   */
  chat: getRateLimiter('chat', {
    maxRequests: 10,
    windowMs: 10_000,
    queueExcess: true,
    maxQueueSize: 5,
    onRateLimited: (waitTime) => {
      logger.debug('RateLimiter', `Chat rate limited, wait ${waitTime}ms`);
    },
  }),

  /**
   * Session start - 3 per minute
   * Prevents session spam
   */
  sessionStart: getRateLimiter('sessionStart', {
    maxRequests: 3,
    windowMs: 60_000,
    queueExcess: false,
    onRateLimited: (waitTime) => {
      logger.debug('RateLimiter', `Session start rate limited, wait ${waitTime}ms`);
    },
  }),

  /**
   * Session end - 5 per minute
   * Allows multiple end attempts (retries)
   */
  sessionEnd: getRateLimiter('sessionEnd', {
    maxRequests: 5,
    windowMs: 60_000,
    queueExcess: true,
    maxQueueSize: 3,
  }),

  /**
   * Feedback submission - 20 per minute
   * Generous for thumbs up/down
   */
  feedback: getRateLimiter('feedback', {
    maxRequests: 20,
    windowMs: 60_000,
    queueExcess: false,
  }),

  /**
   * Memory operations - 10 per minute
   * Memory commits are expensive
   */
  memory: getRateLimiter('memory', {
    maxRequests: 10,
    windowMs: 60_000,
    queueExcess: true,
    maxQueueSize: 5,
  }),

  /**
   * Companion invokes (reframe, breathe, etc.) - 6 per minute
   * Prevents abuse of AI features
   */
  companion: getRateLimiter('companion', {
    maxRequests: 6,
    windowMs: 60_000,
    queueExcess: true,
    maxQueueSize: 3,
    onRateLimited: (waitTime) => {
      logger.debug('RateLimiter', `Companion invoke rate limited, wait ${waitTime}ms`);
    },
  }),

  /**
   * Reflections - 5 per minute
   */
  reflections: getRateLimiter('reflections', {
    maxRequests: 5,
    windowMs: 60_000,
    queueExcess: false,
  }),

  /**
   * WS ticket issuance - 20 per minute
   * Limits token exposure surface while allowing reconnect bursts.
   */
  wsTicket: getRateLimiter('wsTicket', {
    maxRequests: 20,
    windowMs: 60_000,
    queueExcess: false,
    onRateLimited: (waitTime) => {
      logger.debug('RateLimiter', `WS ticket rate limited, wait ${waitTime}ms`);
    },
  }),
};

// =============================================================================
// THROTTLE HELPER (Simpler alternative)
// =============================================================================

const lastCallTimes = new Map<string, number>();

/**
 * Simple throttle check - returns true if enough time has passed
 * Use for simple cases where you just need minimum delay between calls
 */
export function throttle(key: string, minDelayMs: number): boolean {
  const now = Date.now();
  const lastCall = lastCallTimes.get(key) || 0;

  if (now - lastCall >= minDelayMs) {
    lastCallTimes.set(key, now);
    return true;
  }

  return false;
}

/**
 * Async throttle - waits until throttle clears
 */
export async function throttleAsync(key: string, minDelayMs: number): Promise<void> {
  const now = Date.now();
  const lastCall = lastCallTimes.get(key) || 0;
  const elapsed = now - lastCall;

  if (elapsed < minDelayMs) {
    await new Promise(resolve => setTimeout(resolve, minDelayMs - elapsed));
  }

  lastCallTimes.set(key, Date.now());
}

// =============================================================================
// DEBOUNCE HELPER
// =============================================================================

const debounceTimers = new Map<string, NodeJS.Timeout>();

/**
 * Debounce a function call
 * Returns a promise that resolves when the debounced call executes
 */
export function debounce<T>(
  key: string,
  fn: () => T | Promise<T>,
  delayMs: number
): Promise<T> {
  return new Promise((resolve, reject) => {
    // Clear existing timer
    const existingTimer = debounceTimers.get(key);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    // Set new timer
    const timer = setTimeout(async () => {
      debounceTimers.delete(key);
      try {
        const result = await fn();
        resolve(result);
      } catch (error) {
        reject(error);
      }
    }, delayMs);

    debounceTimers.set(key, timer);
  });
}

/**
 * Cancel a pending debounced call
 */
export function cancelDebounce(key: string): void {
  const timer = debounceTimers.get(key);
  if (timer) {
    clearTimeout(timer);
    debounceTimers.delete(key);
  }
}
