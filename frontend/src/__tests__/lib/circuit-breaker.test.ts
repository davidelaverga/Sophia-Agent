/**
 * Tests for Circuit Breaker
 * Validates state transitions and failure handling
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { CircuitBreaker, getCircuitBreaker, withCircuitBreaker } from '../../app/lib/circuit-breaker';

describe('CircuitBreaker', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('Basic state management', () => {
    it('should start in closed state', () => {
      const breaker = new CircuitBreaker();
      const state = breaker.getState();

      expect(state.state).toBe('closed');
      expect(state.failures).toBe(0);
      expect(breaker.canRequest()).toBe(true);
    });

    it('should allow requests in closed state', () => {
      const breaker = new CircuitBreaker();
      expect(breaker.canRequest()).toBe(true);
    });

    it('should track failures', () => {
      const breaker = new CircuitBreaker();
      breaker.recordFailure();
      breaker.recordFailure();

      const state = breaker.getState();
      expect(state.failures).toBe(2);
      expect(state.state).toBe('closed');
    });

    it('should reset failures on success in closed state', () => {
      const breaker = new CircuitBreaker({ failureThreshold: 5 });
      
      breaker.recordFailure();
      breaker.recordFailure();
      expect(breaker.getState().failures).toBe(2);
      
      breaker.recordSuccess();
      expect(breaker.getState().failures).toBe(0);
    });
  });

  describe('State transitions', () => {
    it('should open after threshold failures', () => {
      const breaker = new CircuitBreaker({ failureThreshold: 3 });

      breaker.recordFailure();
      breaker.recordFailure();
      expect(breaker.getState().state).toBe('closed');

      breaker.recordFailure();
      expect(breaker.getState().state).toBe('open');
      expect(breaker.canRequest()).toBe(false);
    });

    it('should transition to half-open after reset timeout', () => {
      const breaker = new CircuitBreaker({
        failureThreshold: 2,
        resetTimeout: 5000,
      });

      // Trigger open state
      breaker.recordFailure();
      breaker.recordFailure();
      expect(breaker.getState().state).toBe('open');

      // Advance time past reset timeout
      vi.advanceTimersByTime(6000);

      // Check state - should transition to half-open
      const state = breaker.getState();
      expect(state.state).toBe('half-open');
      expect(breaker.canRequest()).toBe(true);
    });

    it('should close after success threshold in half-open', () => {
      const breaker = new CircuitBreaker({
        failureThreshold: 2,
        resetTimeout: 1000,
        successThreshold: 2,
      });

      // Open the circuit
      breaker.recordFailure();
      breaker.recordFailure();

      // Transition to half-open
      vi.advanceTimersByTime(2000);
      breaker.getState(); // Trigger state check

      // Record successes
      breaker.recordSuccess();
      expect(breaker.getState().state).toBe('half-open');

      breaker.recordSuccess();
      expect(breaker.getState().state).toBe('closed');
    });

    it('should return to open on failure in half-open', () => {
      const breaker = new CircuitBreaker({
        failureThreshold: 2,
        resetTimeout: 1000,
      });

      // Open the circuit
      breaker.recordFailure();
      breaker.recordFailure();

      // Transition to half-open
      vi.advanceTimersByTime(2000);
      expect(breaker.getState().state).toBe('half-open');

      // Fail again
      breaker.recordFailure();
      expect(breaker.getState().state).toBe('open');
    });
  });

  describe('Reset functionality', () => {
    it('should reset to initial state', () => {
      const breaker = new CircuitBreaker({ failureThreshold: 2 });

      breaker.recordFailure();
      breaker.recordFailure();
      expect(breaker.getState().state).toBe('open');

      breaker.reset();

      const state = breaker.getState();
      expect(state.state).toBe('closed');
      expect(state.failures).toBe(0);
      expect(state.successes).toBe(0);
    });
  });
});

describe('getCircuitBreaker', () => {
  it('should return same instance for same name', () => {
    const breaker1 = getCircuitBreaker('test-service');
    const breaker2 = getCircuitBreaker('test-service');

    expect(breaker1).toBe(breaker2);
  });

  it('should return different instances for different names', () => {
    const breaker1 = getCircuitBreaker('service-a');
    const breaker2 = getCircuitBreaker('service-b');

    expect(breaker1).not.toBe(breaker2);
  });
});

describe('withCircuitBreaker', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should pass through successful calls', async () => {
    const breaker = new CircuitBreaker();
    const mockFn = vi.fn().mockResolvedValue('success');
    const wrapped = withCircuitBreaker(mockFn, breaker);

    const result = await wrapped();

    expect(result).toBe('success');
    expect(mockFn).toHaveBeenCalled();
  });

  it('should record success on successful call', async () => {
    const breaker = new CircuitBreaker();
    breaker.recordFailure(); // Start with one failure
    
    const mockFn = vi.fn().mockResolvedValue('success');
    const wrapped = withCircuitBreaker(mockFn, breaker);

    await wrapped();

    expect(breaker.getState().failures).toBe(0); // Reset after success
  });

  it('should record failure and rethrow on error', async () => {
    const breaker = new CircuitBreaker();
    const mockFn = vi.fn().mockRejectedValue(new Error('API error'));
    const wrapped = withCircuitBreaker(mockFn, breaker);

    await expect(wrapped()).rejects.toThrow('API error');
    expect(breaker.getState().failures).toBe(1);
  });

  it('should reject immediately when circuit is open', async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 2 });
    
    // Open the circuit
    breaker.recordFailure();
    breaker.recordFailure();

    const mockFn = vi.fn().mockResolvedValue('success');
    const wrapped = withCircuitBreaker(mockFn, breaker);

    await expect(wrapped()).rejects.toThrow('Circuit breaker is OPEN');
    expect(mockFn).not.toHaveBeenCalled();
  });

  it('should allow calls when circuit transitions to half-open', async () => {
    const breaker = new CircuitBreaker({
      failureThreshold: 2,
      resetTimeout: 1000,
    });

    // Open the circuit
    breaker.recordFailure();
    breaker.recordFailure();

    const mockFn = vi.fn().mockResolvedValue('success');
    const wrapped = withCircuitBreaker(mockFn, breaker);

    // Should fail while open
    await expect(wrapped()).rejects.toThrow('Circuit breaker is OPEN');

    // Advance time to transition to half-open
    vi.advanceTimersByTime(2000);

    // Should work now
    const result = await wrapped();
    expect(result).toBe('success');
  });
});
