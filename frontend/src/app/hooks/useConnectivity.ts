/**
 * useConnectivity Hook
 * Sprint 1+ - Offline Resilience (Optimized)
 * 
 * EVENT-DRIVEN offline detection to minimize backend calls.
 * 
 * Strategy:
 * 1. Navigator.onLine events → Instant browser-level detection
 * 2. Visibility change → Check when tab becomes visible (user returns)
 * 3. Request failures → Detect offline when actual requests fail
 * 4. Recovery polling → Only poll when OFFLINE (exponential backoff)
 * 
 * This reduces health checks from ~120,000/hour (1000 users polling)
 * to ~100/hour (only during offline recovery attempts).
 */

'use client';

import { useEffect, useRef, useCallback } from 'react';
import { useConnectivityStore, selectStatus, selectIsOnline } from '../stores/connectivity-store';
import { useChatStore } from '../stores/chat-store';

// ============================================================================
// CONFIGURATION
// ============================================================================

// Recovery polling - only when offline, with exponential backoff
const INITIAL_RECOVERY_INTERVAL = 5000;    // 5 seconds initially
const MAX_RECOVERY_INTERVAL = 60000;       // Max 1 minute between checks
const BACKOFF_MULTIPLIER = 1.5;            // Increase interval by 50% each failure
const HEALTH_CHECK_TIMEOUT = 5000;         // 5 second timeout

// Health endpoints - deep check actually pings the backend
const HEALTH_ENDPOINT_DEEP = '/api/health?deep=true';  // Verifies backend is reachable

// Visibility-based check throttle
const VISIBILITY_CHECK_THROTTLE = 30000;   // Don't check more than every 30 seconds

// ============================================================================
// HOOK
// ============================================================================

export function useConnectivity() {
  const status = useConnectivityStore(selectStatus);
  const isOnline = useConnectivityStore(selectIsOnline);
  const setOnline = useConnectivityStore((s) => s.setOnline);
  const setOffline = useConnectivityStore((s) => s.setOffline);
  const recordFailure = useConnectivityStore((s) => s.recordFailure);
  const recordSuccess = useConnectivityStore((s) => s.recordSuccess);
  const queueMessage = useConnectivityStore((s) => s.queueMessage);
  const messageQueue = useConnectivityStore((s) => s.messageQueue);
  const hasQueuedMessages = useConnectivityStore((s) => s.hasQueuedMessages);
  
  const mountedRef = useRef(true);
  const recoveryIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const currentBackoffRef = useRef(INITIAL_RECOVERY_INTERVAL);
  const lastVisibilityCheckRef = useRef(0);
  
  // Health check - verifies backend is actually reachable (deep check)
  const checkHealth = useCallback(async (): Promise<boolean> => {
    if (!mountedRef.current) return false;
    
    // First check browser connectivity
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      setOffline();
      return false;
    }
    
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), HEALTH_CHECK_TIMEOUT);
      
      const response = await fetch(HEALTH_ENDPOINT_DEEP, {
        method: 'GET',
        signal: controller.signal,
        cache: 'no-store',
      });
      
      clearTimeout(timeoutId);
      
      if (!mountedRef.current) return false;
      
      if (response.ok) {
        setOnline();
        currentBackoffRef.current = INITIAL_RECOVERY_INTERVAL; // Reset backoff
        return true;
      } else {
        // Backend unhealthy - mark as offline immediately
        setOffline();
        return false;
      }
    } catch {
      if (mountedRef.current) {
        setOffline();
      }
      return false;
    }
  }, [setOnline, setOffline]);
  
  // Start recovery polling when offline (exponential backoff)
  const startRecoveryPolling = useCallback(() => {
    // Clear any existing interval
    if (recoveryIntervalRef.current) {
      clearTimeout(recoveryIntervalRef.current);
    }
    
    const attemptRecovery = async () => {
      if (!mountedRef.current) return;
      
      const isBack = await checkHealth();
      
      if (!isBack && mountedRef.current) {
        // Still offline - schedule next attempt with backoff
        currentBackoffRef.current = Math.min(
          currentBackoffRef.current * BACKOFF_MULTIPLIER,
          MAX_RECOVERY_INTERVAL
        );
        recoveryIntervalRef.current = setTimeout(attemptRecovery, currentBackoffRef.current);
      }
      // If online, polling stops naturally
    };
    
    // Start first recovery attempt
    recoveryIntervalRef.current = setTimeout(attemptRecovery, currentBackoffRef.current);
  }, [checkHealth]);
  
  // Stop recovery polling
  const stopRecoveryPolling = useCallback(() => {
    if (recoveryIntervalRef.current) {
      clearTimeout(recoveryIntervalRef.current);
      recoveryIntervalRef.current = null;
    }
    currentBackoffRef.current = INITIAL_RECOVERY_INTERVAL;
  }, []);
  
  // Handle visibility change - only check when coming back to tab AND we think we're online
  // If we're offline, the recovery polling will handle it
  const handleVisibilityChange = useCallback(() => {
    if (document.visibilityState === 'visible') {
      const currentStatus = useConnectivityStore.getState().status;
      
      // Only check if we think we're online - if offline, recovery polling handles it
      if (currentStatus === 'online') {
        const now = Date.now();
        // Throttle visibility checks
        if (now - lastVisibilityCheckRef.current > VISIBILITY_CHECK_THROTTLE) {
          lastVisibilityCheckRef.current = now;
          checkHealth();
        }
      }
    }
  }, [checkHealth]);
  
  // Setup event listeners (no polling when online!)
  useEffect(() => {
    mountedRef.current = true;
    
    // Browser online/offline events
    const handleOnline = () => {
      // Browser says we're online - verify with backend
      checkHealth();
      stopRecoveryPolling();
      
      // Phase 4 Week 4: Attempt stream recovery when coming back online
      const chatStore = useChatStore.getState();
      if (chatStore.streamStatus === 'error' || chatStore.streamStatus === 'interrupted') {
        // Give backend a moment to complete any pending processing
        setTimeout(() => {
          useChatStore.getState().attemptRecovery();
        }, 2000);
      }
    };
    
    const handleOffline = () => {
      setOffline();
      startRecoveryPolling();
    };
    
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    
    // Initial state check (once, not polling)
    // Only check if browser appears offline or we have stale state
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      setOffline();
      startRecoveryPolling();
    }
    // If browser says online, trust it until a request fails
    
    return () => {
      mountedRef.current = false;
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      stopRecoveryPolling();
    };
  }, [checkHealth, setOffline, startRecoveryPolling, stopRecoveryPolling, handleVisibilityChange]);
  
  // React to status changes - start/stop recovery polling
  useEffect(() => {
    if (status === 'offline' || status === 'degraded') {
      startRecoveryPolling();
    } else {
      stopRecoveryPolling();
    }
  }, [status, startRecoveryPolling, stopRecoveryPolling]);
  
  return {
    status,
    isOnline,
    checkHealth,
    queueMessage,
    messageQueue,
    hasQueuedMessages: hasQueuedMessages(),
    recordSuccess,
    recordFailure,
  };
}

// ============================================================================
// UTILITY: Wrap fetch with connectivity tracking
// ============================================================================

export function createConnectivityAwareFetch(
  recordSuccess: () => void,
  recordFailure: () => void
) {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    try {
      const response = await fetch(input, init);
      
      if (response.ok || response.status < 500) {
        recordSuccess();
      } else if (response.status >= 500) {
        recordFailure();
      }
      
      return response;
    } catch (error) {
      recordFailure();
      throw error;
    }
  };
}
