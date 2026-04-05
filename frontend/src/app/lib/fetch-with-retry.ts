/**
 * Fetch with Retry & Exponential Backoff
 * P0 - Network resilience layer
 * 
 * Features:
 * - Exponential backoff with jitter
 * - Configurable retry count
 * - Timeout support
 * - Smart retry logic (don't retry 4xx)
 * - Circuit breaker integration ready
 */

import { logger } from './error-logger';

// =============================================================================
// TYPES
// =============================================================================

export interface RetryConfig {
  /** Max number of retry attempts (default: 3) */
  maxRetries?: number;
  /** Base delay in ms (default: 1000) */
  baseDelay?: number;
  /** Max delay in ms (default: 10000) */
  maxDelay?: number;
  /** Request timeout in ms (default: 15000) */
  timeout?: number;
  /** Retry on these status codes (default: 5xx only) */
  retryOnStatus?: number[];
  /** Callback on retry attempt */
  onRetry?: (attempt: number, error: Error, delay: number) => void;
}

export interface FetchResult<T> {
  success: boolean;
  data?: T;
  error?: Error;
  status?: number;
  attempts: number;
}

// =============================================================================
// CONSTANTS
// =============================================================================

const DEFAULT_CONFIG: Required<Omit<RetryConfig, 'onRetry' | 'retryOnStatus'>> & Pick<RetryConfig, 'onRetry' | 'retryOnStatus'> = {
  maxRetries: 3,
  baseDelay: 1000,
  maxDelay: 10000,
  timeout: 15000,
  retryOnStatus: [500, 502, 503, 504, 429], // 5xx + rate limit
  onRetry: undefined,
};

// Status codes that should NOT be retried
const NON_RETRYABLE_STATUSES = [400, 401, 403, 404, 422];

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Calculate delay with exponential backoff + jitter
 */
function calculateDelay(attempt: number, baseDelay: number, maxDelay: number): number {
  // Exponential: 1s, 2s, 4s, 8s...
  const exponential = baseDelay * Math.pow(2, attempt);
  // Add jitter (0-1000ms) to prevent thundering herd
  const jitter = Math.random() * 1000;
  // Cap at maxDelay
  return Math.min(exponential + jitter, maxDelay);
}

/**
 * Check if error is retryable
 */
function isRetryableError(error: unknown): boolean {
  // Network errors are retryable
  if (error instanceof TypeError && error.message.includes('fetch')) {
    return true;
  }
  // Timeout errors are retryable
  if (error instanceof DOMException && error.name === 'TimeoutError') {
    return true;
  }
  return false;
}

/**
 * Check if status code should be retried
 */
function shouldRetryStatus(status: number, retryOnStatus: number[]): boolean {
  // Never retry client errors (except rate limit)
  if (NON_RETRYABLE_STATUSES.includes(status)) {
    return false;
  }
  // Retry if in the retry list
  return retryOnStatus.includes(status);
}

/**
 * Sleep for specified milliseconds
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// =============================================================================
// MAIN FUNCTION
// =============================================================================

/**
 * Fetch with automatic retry and exponential backoff
 * 
 * @example
 * // Basic usage
 * const result = await fetchWithRetry<UserData>('/api/user');
 * if (result.success) {
 *   debugLog('fetch-with-retry', 'result data', result.data);
 * }
 * 
 * @example
 * // With custom config
 * const result = await fetchWithRetry<Data>('/api/data', {
 *   method: 'POST',
 *   body: JSON.stringify({ foo: 'bar' }),
 * }, {
 *   maxRetries: 5,
 *   timeout: 30000,
 *   onRetry: (attempt, error) => debugLog('fetch-with-retry', `Retry ${attempt}`, { message: error.message }),
 * });
 */
export async function fetchWithRetry<T>(
  url: string,
  options: RequestInit = {},
  config: RetryConfig = {}
): Promise<FetchResult<T>> {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  let lastError: Error | undefined;
  let lastStatus: number | undefined;
  
  for (let attempt = 0; attempt <= cfg.maxRetries; attempt++) {
    try {
      // Create abort controller for timeout
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), cfg.timeout);
      
      // Make request
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
      });
      
      clearTimeout(timeoutId);
      lastStatus = response.status;
      
      // Success
      if (response.ok) {
        const data = await response.json() as T;
        return {
          success: true,
          data,
          status: response.status,
          attempts: attempt + 1,
        };
      }
      
      // Check if we should retry this status
      if (!shouldRetryStatus(response.status, cfg.retryOnStatus || DEFAULT_CONFIG.retryOnStatus!)) {
        // Non-retryable error
        const errorData = await response.json().catch(() => ({}));
        const errorMessage = (errorData as { error?: string; detail?: string }).error 
          || (errorData as { error?: string; detail?: string }).detail 
          || `HTTP ${response.status}`;
        
        return {
          success: false,
          error: new Error(errorMessage),
          status: response.status,
          attempts: attempt + 1,
        };
      }
      
      // Retryable status - continue to retry logic below
      lastError = new Error(`HTTP ${response.status}`);
      
    } catch (error) {
      // Handle abort (timeout)
      if (error instanceof DOMException && error.name === 'AbortError') {
        lastError = new Error('Request timeout');
      } else if (error instanceof Error) {
        lastError = error;
      } else {
        lastError = new Error(String(error));
      }
      
      // Check if error is retryable
      if (!isRetryableError(error) && !(error instanceof DOMException)) {
        // Non-retryable error, return immediately
        return {
          success: false,
          error: lastError,
          status: lastStatus,
          attempts: attempt + 1,
        };
      }
    }
    
    // If we haven't exhausted retries, wait and try again
    if (attempt < cfg.maxRetries) {
      const delay = calculateDelay(attempt, cfg.baseDelay, cfg.maxDelay);
      
      // Callback for retry notification
      cfg.onRetry?.(attempt + 1, lastError!, delay);
      
      logger.debug('fetchWithRetry', `Retry ${attempt + 1}/${cfg.maxRetries} in ${delay}ms`, {
        url,
        error: lastError?.message,
      });
      
      await sleep(delay);
    }
  }
  
  // All retries exhausted
  return {
    success: false,
    error: lastError || new Error('Unknown error'),
    status: lastStatus,
    attempts: cfg.maxRetries + 1,
  };
}

// =============================================================================
// CONVENIENCE WRAPPERS
// =============================================================================

/**
 * Fetch JSON with retry - throws on failure
 */
export async function fetchJsonWithRetry<T>(
  url: string,
  options: RequestInit = {},
  config: RetryConfig = {}
): Promise<T> {
  const result = await fetchWithRetry<T>(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      ...options.headers,
    },
  }, config);
  
  if (!result.success) {
    throw result.error || new Error('Request failed');
  }
  
  return result.data!;
}

/**
 * POST JSON with retry
 */
export async function postJsonWithRetry<T>(
  url: string,
  body: unknown,
  options: RequestInit = {},
  config: RetryConfig = {}
): Promise<FetchResult<T>> {
  return fetchWithRetry<T>(url, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      ...options.headers,
    },
    ...options,
  }, config);
}
