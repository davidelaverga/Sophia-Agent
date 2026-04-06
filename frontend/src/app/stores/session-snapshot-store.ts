/**
 * Session Snapshot Store
 * Phase 4 - Week 4: Resume Session
 * 
 * Zustand store for persisting and restoring the full UI state.
 * Persists on "safe moments" (done event, send, metadata change, unload)
 * NOT on every token - this is important for performance.
 * 
 * Storage key: sophia.session.snapshot.v1
 */

'use client';

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

import { logger } from '../lib/error-logger';
import type { ChatMessage } from '../types/conversation';
import type { 
  SessionSnapshot, 
  ActiveSessionMeta,
  LastViewType,
  SnapshotSummary,
} from '../types/session-snapshot';
import {
  SESSION_SNAPSHOT_STORAGE_KEY,
  SESSION_SNAPSHOT_SCHEMA_VERSION,
  isSnapshotStale,
  isSnapshotVersionValid,
  getSnapshotSummary,
} from '../types/session-snapshot';

import type { FocusMode } from './ui-store';

// =============================================================================
// STORE STATE INTERFACE
// =============================================================================

interface SessionSnapshotState {
  /** The current snapshot (persisted to localStorage) */
  snapshot: SessionSnapshot | null;
  
  /** Whether we've attempted to restore on app load */
  hasAttemptedRestore: boolean;
  
  /** Whether there's a valid snapshot that can be resumed */
  canResume: boolean;
  
  // =========================================================================
  // PERSIST ACTIONS (call on "safe moments")
  // =========================================================================
  
  /**
   * Persist the current state. Call this on:
   * - event: done (final assistant message)
   * - user sends a message
   * - session metadata changes
   * - beforeunload (best-effort)
   */
  persistSnapshot: (data: {
    conversationId?: string;
    messages: ChatMessage[];
    lastCompletedTurnId?: string;
    activeMode: FocusMode;
    activeSessionMeta?: ActiveSessionMeta;
    lastView?: LastViewType;
    lastRecapSessionId?: string;
    userId?: string;
  }) => void;
  
  /**
   * Update just the messages (called on done/send)
   */
  persistMessages: (messages: ChatMessage[], lastCompletedTurnId?: string) => void;
  
  /**
   * Update just the mode (called on mode switch)
   */
  persistMode: (mode: FocusMode) => void;
  
  /**
   * Update session metadata (called on ritual start/change)
   */
  persistSessionMeta: (meta: ActiveSessionMeta | undefined) => void;
  
  /**
   * Update last view (called on navigation)
   */
  persistLastView: (view: LastViewType, recapSessionId?: string) => void;
  
  // =========================================================================
  // RESTORE ACTIONS
  // =========================================================================
  
  /**
   * Load snapshot from localStorage and validate it
   * Returns the snapshot if valid, null otherwise
   */
  loadSnapshot: () => SessionSnapshot | null;
  
  /**
   * Mark that restore has been attempted (even if no snapshot found)
   */
  markRestoreAttempted: () => void;
  
  /**
   * Get summary for UI display
   */
  getSummary: () => SnapshotSummary;
  
  // =========================================================================
  // CLEAR ACTIONS
  // =========================================================================
  
  /**
   * Clear the snapshot completely (user chose "Start fresh")
   */
  clearSnapshot: () => void;
  
  /**
   * Mark session as ended but keep snapshot for recap access
   */
  markSessionEnded: () => void;
}

// =============================================================================
// STORE IMPLEMENTATION
// =============================================================================

export const useSessionSnapshotStore = create<SessionSnapshotState>()(
  persist(
    (set, get) => ({
      snapshot: null,
      hasAttemptedRestore: false,
      canResume: false,
      
      // -----------------------------------------------------------------------
      // PERSIST ACTIONS
      // -----------------------------------------------------------------------
      
      persistSnapshot: (data) => {
        const newSnapshot: SessionSnapshot = {
          schema_version: SESSION_SNAPSHOT_SCHEMA_VERSION,
          conversation_id: data.conversationId,
          messages: data.messages,
          last_completed_turn_id: data.lastCompletedTurnId,
          active_mode: data.activeMode,
          active_session_meta: data.activeSessionMeta,
          last_view: data.lastView,
          last_recap_session_id: data.lastRecapSessionId,
          updated_at: new Date().toISOString(),
          user_id: data.userId,
        };
        
        set({ 
          snapshot: newSnapshot,
          canResume: newSnapshot.messages.length > 0 && !isSnapshotStale(newSnapshot),
        });
        
        logger.debug('SessionSnapshotStore', 'Persisted snapshot', {
          messageCount: newSnapshot.messages.length,
          hasSessionMeta: !!newSnapshot.active_session_meta,
        });
      },
      
      persistMessages: (messages, lastCompletedTurnId) => {
        const current = get().snapshot;
        if (!current) {
          // No existing snapshot, create minimal one
          const newSnapshot: SessionSnapshot = {
            schema_version: SESSION_SNAPSHOT_SCHEMA_VERSION,
            messages,
            last_completed_turn_id: lastCompletedTurnId,
            active_mode: 'voice',
            updated_at: new Date().toISOString(),
          };
          set({ 
            snapshot: newSnapshot,
            canResume: messages.length > 0,
          });
          return;
        }
        
        set({
          snapshot: {
            ...current,
            messages,
            last_completed_turn_id: lastCompletedTurnId ?? current.last_completed_turn_id,
            updated_at: new Date().toISOString(),
          },
          canResume: messages.length > 0,
        });
      },
      
      persistMode: (mode) => {
        const current = get().snapshot;
        if (!current) return;
        
        set({
          snapshot: {
            ...current,
            active_mode: mode,
            updated_at: new Date().toISOString(),
          },
        });
      },
      
      persistSessionMeta: (meta) => {
        const current = get().snapshot;
        if (!current) {
          if (!meta) return;
          // Create snapshot with session meta
          const newSnapshot: SessionSnapshot = {
            schema_version: SESSION_SNAPSHOT_SCHEMA_VERSION,
            messages: [],
            active_mode: 'voice',
            active_session_meta: meta,
            updated_at: new Date().toISOString(),
          };
          set({ snapshot: newSnapshot });
          return;
        }
        
        set({
          snapshot: {
            ...current,
            active_session_meta: meta,
            updated_at: new Date().toISOString(),
          },
        });
      },
      
      persistLastView: (view, recapSessionId) => {
        const current = get().snapshot;
        if (!current) return;
        
        set({
          snapshot: {
            ...current,
            last_view: view,
            last_recap_session_id: recapSessionId,
            updated_at: new Date().toISOString(),
          },
        });
      },
      
      // -----------------------------------------------------------------------
      // RESTORE ACTIONS
      // -----------------------------------------------------------------------
      
      loadSnapshot: () => {
        const current = get().snapshot;
        
        // Already loaded from persist middleware
        if (current) {
          // Validate schema version
          if (!isSnapshotVersionValid(current)) {
            logger.debug('SessionSnapshotStore', 'Snapshot version mismatch, clearing');
            get().clearSnapshot();
            return null;
          }
          
          // Check if stale
          if (isSnapshotStale(current)) {
            logger.debug('SessionSnapshotStore', 'Snapshot is stale (>24h), clearing');
            get().clearSnapshot();
            return null;
          }
          
          // Check if session ended
          if (current.active_session_meta?.status === 'ended') {
            logger.debug('SessionSnapshotStore', 'Session already ended');
            // Don't auto-clear - might be useful for recap
            return current;
          }
          
          set({ canResume: current.messages.length > 0 });
          return current;
        }
        
        return null;
      },
      
      markRestoreAttempted: () => {
        set({ hasAttemptedRestore: true });
      },
      
      getSummary: () => {
        return getSnapshotSummary(get().snapshot);
      },
      
      // -----------------------------------------------------------------------
      // CLEAR ACTIONS
      // -----------------------------------------------------------------------
      
      clearSnapshot: () => {
        set({ 
          snapshot: null,
          canResume: false,
        });
        logger.debug('SessionSnapshotStore', 'Snapshot cleared');
      },
      
      markSessionEnded: () => {
        const current = get().snapshot;
        if (!current) return;
        
        set({
          snapshot: {
            ...current,
            active_session_meta: current.active_session_meta 
              ? { ...current.active_session_meta, status: 'ended' }
              : undefined,
            updated_at: new Date().toISOString(),
          },
          canResume: false, // Can't resume ended session
        });
      },
    }),
    {
      name: SESSION_SNAPSHOT_STORAGE_KEY,
      storage: createJSONStorage(() => localStorage),
      
      // Only persist the snapshot itself, not ephemeral state
      partialize: (state) => ({
        snapshot: state.snapshot,
      }),
      
      // Rehydrate canResume based on loaded snapshot
      onRehydrateStorage: () => (state) => {
        if (state?.snapshot) {
          const isValid = isSnapshotVersionValid(state.snapshot) && !isSnapshotStale(state.snapshot);
          state.canResume = isValid && state.snapshot.messages.length > 0;
        }
      },
    }
  )
);

// =============================================================================
// SELECTORS
// =============================================================================

export const selectSnapshot = (state: SessionSnapshotState) => state.snapshot;
export const selectCanResume = (state: SessionSnapshotState) => state.canResume;
export const selectHasAttemptedRestore = (state: SessionSnapshotState) => state.hasAttemptedRestore;

// =============================================================================
// UTILITY: Persist on beforeunload (best-effort)
// =============================================================================

/**
 * Call this once at app initialization to set up beforeunload persistence
 */
export function setupBeforeUnloadPersistence(
  getState: () => {
    conversationId?: string;
    messages: ChatMessage[];
    lastCompletedTurnId?: string;
    activeMode: FocusMode;
    activeSessionMeta?: ActiveSessionMeta;
    userId?: string;
  }
) {
  if (typeof window === 'undefined') return;
  
  const handleBeforeUnload = () => {
    const state = getState();
    if (state.messages.length > 0) {
      useSessionSnapshotStore.getState().persistSnapshot({
        conversationId: state.conversationId,
        messages: state.messages,
        lastCompletedTurnId: state.lastCompletedTurnId,
        activeMode: state.activeMode,
        activeSessionMeta: state.activeSessionMeta,
        lastView: 'conversation',
        userId: state.userId,
      });
    }
  };
  
  window.addEventListener('beforeunload', handleBeforeUnload);
  
  return () => {
    window.removeEventListener('beforeunload', handleBeforeUnload);
  };
}
