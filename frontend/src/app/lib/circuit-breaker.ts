/**
 * Circuit Breaker Pattern
 * P0 - Prevents cascading failures when backend is down
 * 
 * States:
 * - CLOSED: Normal operation, requests pass through
 * - OPEN: Backend is down, reject requests immediately
 * - HALF_OPEN: Testing if backend recovered
 */

import { logger } from './error-logger';

// =============================================================================
// TYPES
// =============================================================================

export type CircuitState = 'closed' | 'open' | 'half-open';

export interface CircuitBreakerConfig {
  /** Number of failures before opening circuit (default: 5) */
  failureThreshold?: number;
  /** Time to wait before trying again in ms (default: 30000) */
  resetTimeout?: number;
  /** Number of successful calls to close circuit (default: 2) */
  successThreshold?: number;
  /** Name for logging */
  name?: string;
}

export interface CircuitBreakerState {
  state: CircuitState;
  failures: number;
  successes: number;
  lastFailureTime: number | null;
  lastStateChange: number;
}

// =============================================================================
// IMPLEMENTATION
// =============================================================================

export class CircuitBreaker {
  private state: CircuitState = 'closed';
  private failures = 0;
  private successes = 0;
  private lastFailureTime: number | null = null;
  private lastStateChange = Date.now();
  
  private readonly failureThreshold: number;
  private readonly resetTimeout: number;
  private readonly successThreshold: number;
  private readonly name: string;
  
  constructor(config: CircuitBreakerConfig = {}) {
    this.failureThreshold = config.failureThreshold ?? 5;
    this.resetTimeout = config.resetTimeout ?? 30000;
    this.successThreshold = config.successThreshold ?? 2;
    this.name = config.name ?? 'default';
  }
  
  /**
   * Check if a request should be allowed
   */
  canRequest(): boolean {
    this.checkStateTransition();
    
    switch (this.state) {
      case 'closed':
        return true;
      case 'open':
        return false;
      case 'half-open':
        // Allow limited requests in half-open state
        return true;
      default:
        return true;
    }
  }
  
  /**
   * Record a successful request
   */
  recordSuccess(): void {
    this.checkStateTransition();
    
    if (this.state === 'half-open') {
      this.successes++;
      
      if (this.successes >= this.successThreshold) {
        this.transitionTo('closed');
        logger.debug('CircuitBreaker', `[${this.name}] Circuit CLOSED - backend recovered`);
      }
    } else if (this.state === 'closed') {
      // Reset failure count on success
      this.failures = 0;
    }
  }
  
  /**
   * Record a failed request
   */
  recordFailure(): void {
    this.failures++;
    this.lastFailureTime = Date.now();
    
    if (this.state === 'half-open') {
      // Any failure in half-open goes back to open
      this.transitionTo('open');
      logger.debug('CircuitBreaker', `[${this.name}] Circuit OPEN - still failing`);
    } else if (this.state === 'closed' && this.failures >= this.failureThreshold) {
      this.transitionTo('open');
      logger.warn(`[CircuitBreaker][${this.name}] Circuit OPEN - threshold reached (${this.failures} failures)`);
    }
  }
  
  /**
   * Get current state
   */
  getState(): CircuitBreakerState {
    this.checkStateTransition();
    
    return {
      state: this.state,
      failures: this.failures,
      successes: this.successes,
      lastFailureTime: this.lastFailureTime,
      lastStateChange: this.lastStateChange,
    };
  }
  
  /**
   * Force reset to closed state
   */
  reset(): void {
    this.transitionTo('closed');
    this.failures = 0;
    this.successes = 0;
    this.lastFailureTime = null;
  }
  
  /**
   * Check and perform state transitions
   */
  private checkStateTransition(): void {
    if (this.state === 'open' && this.lastFailureTime) {
      const elapsed = Date.now() - this.lastFailureTime;
      
      if (elapsed >= this.resetTimeout) {
        this.transitionTo('half-open');
        this.successes = 0;
        logger.debug('CircuitBreaker', `[${this.name}] Circuit HALF-OPEN - testing recovery`);
      }
    }
  }
  
  private transitionTo(newState: CircuitState): void {
    this.state = newState;
    this.lastStateChange = Date.now();
  }
}

// =============================================================================
// SINGLETON INSTANCES
// =============================================================================

// Global circuit breakers for different services
const circuitBreakers = new Map<string, CircuitBreaker>();

/**
 * Get or create a circuit breaker for a service
 */
export function getCircuitBreaker(name: string, config?: CircuitBreakerConfig): CircuitBreaker {
  if (!circuitBreakers.has(name)) {
    circuitBreakers.set(name, new CircuitBreaker({ name, ...config }));
  }
  return circuitBreakers.get(name);
}

// Pre-configured breakers for common services
export const apiCircuitBreaker = getCircuitBreaker('api', {
  failureThreshold: 5,
  resetTimeout: 30000,
});

export const streamCircuitBreaker = getCircuitBreaker('stream', {
  failureThreshold: 3,
  resetTimeout: 15000,
});

// =============================================================================
// HOC FOR FETCH
// =============================================================================

/**
 * Wrap a fetch function with circuit breaker protection
 */
export function withCircuitBreaker<T extends (...args: unknown[]) => Promise<unknown>>(
  fn: T,
  breaker: CircuitBreaker
): T {
  return (async (...args: Parameters<T>) => {
    if (!breaker.canRequest()) {
      const state = breaker.getState();
      throw new Error(`Circuit breaker is OPEN. Last failure: ${state.lastFailureTime ? new Date(state.lastFailureTime).toISOString() : 'unknown'}`);
    }
    
    try {
      const result = await fn(...args);
      breaker.recordSuccess();
      return result;
    } catch (error) {
      breaker.recordFailure();
      throw error;
    }
  }) as T;
}
