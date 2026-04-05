/**
 * Session Validation Hook
 * Week 4 - Session Resume Validation
 * 
 * SIMPLIFIED: Backend /validate endpoint doesn't exist.
 * This hook now just handles multi-tab detection via localStorage.
 */

'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useSessionStore, selectSession } from '../stores/session-store';

// =============================================================================
// TYPES
// =============================================================================

export type ValidationStatus = 
  | 'idle'
  | 'validating'
  | 'valid'
  | 'expired'
  | 'multi_tab'
  | 'error';

export interface SessionValidationState {
  status: ValidationStatus;
  errorMessage: string | null;
  lastValidated: Date | null;
}

export interface UseSessionValidationOptions {
  /** Auto-validate on mount */
  autoValidate?: boolean;
  /** Validation interval in ms (0 = disabled) - NOT USED */
  validationInterval?: number;
  /** Callback when session expires - NOT USED (no backend endpoint) */
  onExpired?: () => void;
  /** Callback on multi-tab conflict */
  onMultiTab?: () => void;
}

// =============================================================================
// CONSTANTS
// =============================================================================

const STORAGE_KEY = 'sophia-session-active-tab';

/**
 * Generate or retrieve a unique tab ID.
 * Uses sessionStorage so it persists across page refreshes but not across tabs.
 * This prevents false "multi-tab" detection when user just refreshes.
 */
function getTabId(): string {
  if (typeof window === 'undefined') return 'ssr';
  
  const TABID_KEY = 'sophia-tab-id';
  let tabId = sessionStorage.getItem(TABID_KEY);
  
  if (!tabId) {
    tabId = `tab-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    sessionStorage.setItem(TABID_KEY, tabId);
  }
  
  return tabId;
}

const TAB_ID = getTabId();

// =============================================================================
// HOOK
// =============================================================================

export function useSessionValidation(options: UseSessionValidationOptions = {}) {
  const { onMultiTab } = options;
  
  const session = useSessionStore(selectSession);
  const sessionId = session?.sessionId;
  
  const [state, setState] = useState<SessionValidationState>({
    status: 'valid', // Default to valid - no backend validation
    errorMessage: null,
    lastValidated: null,
  });
  
  const onMultiTabRef = useRef(onMultiTab);
  onMultiTabRef.current = onMultiTab;
  
  // Take over session from another tab
  const takeOverSession = useCallback(() => {
    if (!sessionId) return;
    
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      tabId: TAB_ID,
      sessionId: sessionId,
      timestamp: Date.now(),
    }));
    
    setState({
      status: 'valid',
      errorMessage: null,
      lastValidated: new Date(),
    });
  }, [sessionId]);
  
  // Clear error
  const clearError = useCallback(() => {
    setState(prev => ({
      ...prev,
      status: 'valid',
      errorMessage: null,
    }));
  }, []);
  
  // Multi-tab detection and claiming
  useEffect(() => {
    if (!sessionId) return;
    
    // Check for existing claim
    const activeTab = localStorage.getItem(STORAGE_KEY);
    if (activeTab) {
      try {
        const parsed = JSON.parse(activeTab);
        if (parsed.sessionId === sessionId && parsed.tabId !== TAB_ID) {
          setState({
            status: 'multi_tab',
            errorMessage: 'This session is active in another tab.',
            lastValidated: new Date(),
          });
          onMultiTabRef.current?.();
          return; // Don't claim if another tab has it
        }
      } catch {
        // Invalid storage, continue to claim
      }
    }
    
    // Claim this tab as active
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      tabId: TAB_ID,
      sessionId: sessionId,
      timestamp: Date.now(),
    }));
    
    setState({
      status: 'valid',
      errorMessage: null,
      lastValidated: new Date(),
    });
    
    // Listen for storage changes
    const handleStorageChange = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY && e.newValue) {
        try {
          const parsed = JSON.parse(e.newValue);
          if (parsed.tabId !== TAB_ID && parsed.sessionId === sessionId) {
            setState({
              status: 'multi_tab',
              errorMessage: 'Session taken over by another tab.',
              lastValidated: new Date(),
            });
            onMultiTabRef.current?.();
          }
        } catch {
          // Ignore
        }
      }
    };
    
    window.addEventListener('storage', handleStorageChange);
    
    // Cleanup
    return () => {
      window.removeEventListener('storage', handleStorageChange);
      // Clear claim if this tab owns it
      const current = localStorage.getItem(STORAGE_KEY);
      if (current) {
        try {
          const parsed = JSON.parse(current);
          if (parsed.tabId === TAB_ID) {
            localStorage.removeItem(STORAGE_KEY);
          }
        } catch {
          // Ignore
        }
      }
    };
  }, [sessionId]); // Only re-run when sessionId changes
  
  return {
    ...state,
    isExpired: state.status === 'expired',
    isMultiTab: state.status === 'multi_tab',
    isValid: state.status === 'valid',
    isValidating: state.status === 'validating',
    takeOverSession,
    clearError,
    // No-op for backwards compatibility
    validateSession: async () => true,
  };
}

export default useSessionValidation;
