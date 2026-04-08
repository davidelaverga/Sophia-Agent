/**
 * useSessionBootstrap Hook
 * Session Bootstrap Experience - "Sophia is present instantly"
 * 
 * Manages the bootstrap state for a session:
 * - Stores greeting message + message_id
 * - Stores memory highlights
 * - Persists to localStorage to survive refresh
 * - Prevents duplicate greetings on reload
 * 
 * This hook is the single source of truth for bootstrap data.
 */

'use client';

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';

import { logger } from '../lib/error-logger';
import { useSessionStore, selectSession } from '../stores/session-store';
import type { MemoryHighlight } from '../types/session';

// =============================================================================
// TYPES
// =============================================================================

export interface BootstrapData {
  /** The personalized greeting from Sophia */
  greetingMessage: string;
  /** Message ID for persistence and feedback */
  messageId: string;
  /** Memory highlights to display as cards */
  memoryHighlights: MemoryHighlight[];
  /** Session ID this bootstrap belongs to */
  sessionId: string;
  /** Thread ID from backend */
  threadId: string;
  /** Whether this is a resumed session */
  isResumed: boolean;
  /** Whether backend had memory for this user */
  hasMemory: boolean;
  /** Timestamp when bootstrap was fetched */
  bootstrapAt: string;
  /** Whether the greeting has been rendered to chat */
  greetingRendered: boolean;
}

export interface UseSessionBootstrapReturn {
  /** Current bootstrap data (null if not loaded) */
  bootstrap: BootstrapData | null;
  /** Whether bootstrap data exists and is valid for current session */
  hasBootstrap: boolean;
  /** Whether the greeting has been rendered to chat */
  greetingRendered: boolean;
  /** Mark the greeting as rendered (prevents duplicates) */
  markGreetingRendered: () => void;
  /** Clear bootstrap data (for session end) */
  clearBootstrap: () => void;
  /** Manually set bootstrap data (from session start response) */
  setBootstrapData: (data: Omit<BootstrapData, 'bootstrapAt' | 'greetingRendered'>) => void;
  /** Check if we should show bootstrap UI (has data, not yet rendered) */
  shouldShowBootstrap: boolean;
}

// =============================================================================
// STORAGE KEY
// =============================================================================

const BOOTSTRAP_STORAGE_KEY = 'sophia-session-bootstrap';

// =============================================================================
// STORAGE HELPERS
// =============================================================================

function loadBootstrapFromStorage(): BootstrapData | null {
  if (typeof window === 'undefined') return null;
  
  try {
    const stored = localStorage.getItem(BOOTSTRAP_STORAGE_KEY);
    if (!stored) return null;
    
    const data = JSON.parse(stored) as BootstrapData;
    
    // Validate structure
    if (!data.sessionId || !data.greetingMessage || !data.messageId) {
      return null;
    }
    
    return data;
  } catch {
    return null;
  }
}

function saveBootstrapToStorage(data: BootstrapData): void {
  if (typeof window === 'undefined') return;
  
  try {
    localStorage.setItem(BOOTSTRAP_STORAGE_KEY, JSON.stringify(data));
  } catch {
    logger.warn('Failed to persist bootstrap data', {
      component: 'useSessionBootstrap',
      action: 'persist_bootstrap',
    });
  }
}

function clearBootstrapFromStorage(): void {
  if (typeof window === 'undefined') return;
  
  try {
    localStorage.removeItem(BOOTSTRAP_STORAGE_KEY);
  } catch {
    // Ignore
  }
}

// =============================================================================
// HOOK IMPLEMENTATION
// =============================================================================

export function useSessionBootstrap(): UseSessionBootstrapReturn {
  // Get session from store
  const session = useSessionStore(selectSession);
  
  // Bootstrap state
  const [bootstrap, setBootstrap] = useState<BootstrapData | null>(null);
  
  // Track if we've loaded from storage (to prevent double-loading)
  const hasLoadedRef = useRef(false);
  
  // Load bootstrap from storage on mount
  useEffect(() => {
    if (hasLoadedRef.current) return;
    hasLoadedRef.current = true;
    
    const stored = loadBootstrapFromStorage();
    if (stored) {
      setBootstrap(stored);
    }
  }, []);
  
  // Sync bootstrap from session store if available
  // This handles the case where session start API returns data
  useEffect(() => {
    if (!session) return;
    
    // Check if session has bootstrap data from API
    if (session.greetingMessage && session.greetingMessageId) {
      // Check if we already have bootstrap for this session
      if (bootstrap?.sessionId === session.sessionId) {
        return; // Already have it
      }
      
      // Create bootstrap data from session
      const newBootstrap: BootstrapData = {
        greetingMessage: session.greetingMessage,
        messageId: session.greetingMessageId,
        memoryHighlights: session.memoryHighlights || [],
        sessionId: session.sessionId,
        threadId: session.threadId,
        isResumed: session.isResumed || false,
        hasMemory: session.hasMemory || false,
        bootstrapAt: new Date().toISOString(),
        greetingRendered: false,
      };
      
      setBootstrap(newBootstrap);
      saveBootstrapToStorage(newBootstrap);
    }
  }, [session, bootstrap?.sessionId]);
  
  // Validate bootstrap matches current session
  const hasBootstrap = useMemo(() => {
    if (!bootstrap || !session) return false;
    return bootstrap.sessionId === session.sessionId;
  }, [bootstrap, session]);
  
  // Check if we should show bootstrap UI
  const shouldShowBootstrap = useMemo(() => {
    return hasBootstrap && !bootstrap?.greetingRendered;
  }, [hasBootstrap, bootstrap?.greetingRendered]);
  
  // Mark greeting as rendered
  const markGreetingRendered = useCallback(() => {
    setBootstrap(prev => {
      if (!prev) return prev;
      
      const updated = { ...prev, greetingRendered: true };
      saveBootstrapToStorage(updated);
      return updated;
    });
  }, []);
  
  // Clear bootstrap (for session end)
  const clearBootstrap = useCallback(() => {
    setBootstrap(null);
    clearBootstrapFromStorage();
  }, []);
  
  // Manually set bootstrap data
  const setBootstrapData = useCallback((data: Omit<BootstrapData, 'bootstrapAt' | 'greetingRendered'>) => {
    const fullData: BootstrapData = {
      ...data,
      bootstrapAt: new Date().toISOString(),
      greetingRendered: false,
    };
    
    setBootstrap(fullData);
    saveBootstrapToStorage(fullData);
  }, []);
  
  return {
    bootstrap,
    hasBootstrap,
    greetingRendered: bootstrap?.greetingRendered ?? false,
    markGreetingRendered,
    clearBootstrap,
    setBootstrapData,
    shouldShowBootstrap,
  };
}

// =============================================================================
// UTILITY: Extract greeting as UIMessage
// =============================================================================

export interface BootstrapGreetingMessage {
  id: string;
  role: 'assistant';
  content: string;
  createdAt: string;
  isBootstrap: true;
}

/**
 * Convert bootstrap data to a message format that can be
 * inserted into the chat messages array.
 */
export function bootstrapToMessage(bootstrap: BootstrapData): BootstrapGreetingMessage {
  return {
    id: bootstrap.messageId,
    role: 'assistant',
    content: bootstrap.greetingMessage,
    createdAt: bootstrap.bootstrapAt,
    isBootstrap: true,
  };
}

/**
 * Check if a message ID matches the bootstrap greeting.
 * Used to prevent duplicate insertions.
 */
export function isBootstrapMessage(messageId: string, bootstrap: BootstrapData | null): boolean {
  if (!bootstrap) return false;
  return messageId === bootstrap.messageId;
}

export default useSessionBootstrap;
