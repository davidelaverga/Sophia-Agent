/**
 * useSessionRestore Hook
 * Sprint 1+ - Resume sessions with thread_id continuity
 * 
 * Handles:
 * - Loading session snapshot from localStorage
 * - Checking if session is still valid (not too old)
 * - Providing resume/clear actions
 */

'use client';

import { useEffect, useState, useCallback } from 'react';
import { logger } from '../lib/error-logger';
import type { PresetType, ContextMode, SessionClientStore } from '../lib/session-types';

// =============================================================================
// TYPES
// =============================================================================

export interface SessionSnapshot {
  sessionId: string;
  threadId: string;
  userId: string;
  sessionType: PresetType;
  contextMode: ContextMode;
  startedAt: string;
  lastActivityAt: string;
  status: 'active' | 'paused' | 'ended';
  messageCount: number;
}

interface UseSessionRestoreOptions {
  /** Max age of session before it's considered stale (hours) */
  maxAgeHours?: number;
  /** Whether to auto-load on mount */
  autoLoad?: boolean;
}

interface UseSessionRestoreReturn {
  /** The restored session snapshot (if any) */
  snapshot: SessionSnapshot | null;
  /** Whether we're currently loading/checking */
  isRestoring: boolean;
  /** Whether there's an active session that can be resumed */
  hasActiveSession: boolean;
  /** Save a new snapshot */
  saveSnapshot: (session: SessionClientStore, messageCount: number) => void;
  /** Clear the stored snapshot */
  clearSnapshot: () => void;
  /** Manually trigger a restore check */
  checkForSession: () => void;
}

// =============================================================================
// CONSTANTS
// =============================================================================

const STORAGE_KEY = 'sophia.session.snapshot.v1';
const DEFAULT_MAX_AGE_HOURS = 24;

// =============================================================================
// HOOK IMPLEMENTATION
// =============================================================================

export function useSessionRestore(
  options: UseSessionRestoreOptions = {}
): UseSessionRestoreReturn {
  const { 
    maxAgeHours = DEFAULT_MAX_AGE_HOURS,
    autoLoad = true,
  } = options;
  
  const [snapshot, setSnapshot] = useState<SessionSnapshot | null>(null);
  const [isRestoring, setIsRestoring] = useState(autoLoad);
  
  /**
   * Check localStorage for a valid session snapshot
   */
  const checkForSession = useCallback(() => {
    setIsRestoring(true);
    
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      
      if (!stored) {
        setSnapshot(null);
        return;
      }
      
      const parsed: SessionSnapshot = JSON.parse(stored);
      
      // Validate required fields
      if (!parsed.sessionId || !parsed.threadId || !parsed.startedAt) {
        logger.warn('Invalid snapshot, clearing', {
          component: 'SessionRestore',
          action: 'restore_validate',
        });
        localStorage.removeItem(STORAGE_KEY);
        setSnapshot(null);
        return;
      }
      
      // Check if too old
      const lastActivity = new Date(parsed.lastActivityAt || parsed.startedAt);
      const ageHours = (Date.now() - lastActivity.getTime()) / (1000 * 60 * 60);
      
      if (ageHours > maxAgeHours) {
        logger.debug('SessionRestore', 'Session too old, clearing');
        localStorage.removeItem(STORAGE_KEY);
        setSnapshot(null);
        return;
      }
      
      // Check if already ended
      if (parsed.status === 'ended') {
        logger.debug('SessionRestore', 'Session already ended');
        setSnapshot(null);
        return;
      }
      
      // Valid session found
      logger.debug('SessionRestore', 'Found active session', { sessionId: parsed.sessionId });
      setSnapshot(parsed);
      
    } catch (error) {
      logger.logError(error, { component: 'SessionRestore', action: 'restore' });
      setSnapshot(null);
    } finally {
      setIsRestoring(false);
    }
  }, [maxAgeHours]);
  
  /**
   * Save a session snapshot for future restoration
   */
  const saveSnapshot = useCallback((session: SessionClientStore, messageCount: number) => {
    const newSnapshot: SessionSnapshot = {
      sessionId: session.sessionId,
      threadId: session.threadId,
      userId: session.userId,
      sessionType: session.presetType,
      contextMode: session.contextMode,
      startedAt: session.startedAt,
      lastActivityAt: new Date().toISOString(),
      status: session.isActive ? 'active' : 'ended',
      messageCount,
    };
    
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(newSnapshot));
      setSnapshot(newSnapshot);
      logger.debug('SessionRestore', 'Saved snapshot', { sessionId: newSnapshot.sessionId });
    } catch (error) {
      logger.logError(error, { component: 'SessionRestore', action: 'save' });
    }
  }, []);
  
  /**
   * Clear the stored snapshot
   */
  const clearSnapshot = useCallback(() => {
    try {
      localStorage.removeItem(STORAGE_KEY);
      setSnapshot(null);
      logger.debug('SessionRestore', 'Cleared snapshot');
    } catch (error) {
      logger.logError(error, { component: 'SessionRestore', action: 'clear' });
    }
  }, []);
  
  /**
   * Mark snapshot as ended (but don't remove for recap access)
   */
  const _markEnded = useCallback(() => {
    if (!snapshot) return;
    
    const updated: SessionSnapshot = {
      ...snapshot,
      status: 'ended',
      lastActivityAt: new Date().toISOString(),
    };
    
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
      setSnapshot(updated);
    } catch (error) {
      logger.logError(error, { component: 'SessionRestore', action: 'mark_ended' });
    }
  }, [snapshot]);
  
  // Auto-load on mount
  useEffect(() => {
    if (autoLoad) {
      checkForSession();
    }
  }, [autoLoad, checkForSession]);
  
  // Update last activity periodically (every 30 seconds if active)
  useEffect(() => {
    if (!snapshot || snapshot.status !== 'active') return;
    
    const interval = setInterval(() => {
      const updated: SessionSnapshot = {
        ...snapshot,
        lastActivityAt: new Date().toISOString(),
      };
      
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
      } catch {
        // Ignore write errors for activity updates
      }
    }, 30000); // Every 30 seconds
    
    return () => clearInterval(interval);
  }, [snapshot]);
  
  return {
    snapshot,
    isRestoring,
    hasActiveSession: snapshot !== null && snapshot.status === 'active',
    saveSnapshot,
    clearSnapshot,
    checkForSession,
  };
}

// =============================================================================
// UTILITY FUNCTIONS
// =============================================================================

/**
 * Get session snapshot without the hook (for SSR/initial load)
 */
export function getSessionSnapshot(): SessionSnapshot | null {
  if (typeof window === 'undefined') return null;
  
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return null;
    
    const parsed: SessionSnapshot = JSON.parse(stored);
    
    // Basic validation
    if (!parsed.sessionId || !parsed.threadId) return null;
    if (parsed.status === 'ended') return null;
    
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Check if there's an active session (quick check)
 */
export function hasActiveSessionSnapshot(): boolean {
  const snapshot = getSessionSnapshot();
  return snapshot !== null && snapshot.status === 'active';
}
