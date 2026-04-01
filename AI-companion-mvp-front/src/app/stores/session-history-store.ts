/**
 * Session History Store
 * Phase 3 - Week 3
 * 
 * Stores completed session metadata for the history view.
 * Persisted in localStorage.
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { PresetType, ContextMode } from '../lib/session-types';

// =============================================================================
// TYPES
// =============================================================================

export interface SessionHistoryEntry {
  sessionId: string;
  presetType: PresetType;
  contextMode: ContextMode;
  startedAt: string;
  endedAt: string;
  messageCount: number;
  /** Preview of takeaway (first 100 chars) */
  takeawayPreview?: string;
  /** Whether recap has been viewed */
  recapViewed: boolean;
  /** Whether memories were approved */
  memoriesApproved: boolean;
}

interface SessionHistoryState {
  /** Recent sessions, newest first */
  sessions: SessionHistoryEntry[];
  
  /** Add a completed session to history */
  addSession: (entry: Omit<SessionHistoryEntry, 'recapViewed' | 'memoriesApproved'>) => void;
  
  /** Mark recap as viewed */
  markRecapViewed: (sessionId: string) => void;
  
  /** Mark memories as approved */
  markMemoriesApproved: (sessionId: string) => void;
  
  /** Get a session by ID */
  getSession: (sessionId: string) => SessionHistoryEntry | undefined;
  
  /** Get recent sessions (limit) */
  getRecentSessions: (limit?: number) => SessionHistoryEntry[];
  
  /** Clear all history */
  clearHistory: () => void;
}

// =============================================================================
// STORE
// =============================================================================

const MAX_HISTORY_ENTRIES = 50;

export const useSessionHistoryStore = create<SessionHistoryState>()(
  persist(
    (set, get) => ({
      sessions: [],
      
      addSession: (entry) => {
        set((state) => {
          // Check if session already exists
          const exists = state.sessions.some(s => s.sessionId === entry.sessionId);
          if (exists) return state;
          
          const newEntry: SessionHistoryEntry = {
            ...entry,
            recapViewed: false,
            memoriesApproved: false,
          };
          
          // Add to front, limit total entries
          const updated = [newEntry, ...state.sessions].slice(0, MAX_HISTORY_ENTRIES);
          return { sessions: updated };
        });
      },
      
      markRecapViewed: (sessionId) => {
        set((state) => ({
          sessions: state.sessions.map(s => 
            s.sessionId === sessionId 
              ? { ...s, recapViewed: true }
              : s
          ),
        }));
      },
      
      markMemoriesApproved: (sessionId) => {
        set((state) => ({
          sessions: state.sessions.map(s => 
            s.sessionId === sessionId 
              ? { ...s, memoriesApproved: true }
              : s
          ),
        }));
      },
      
      getSession: (sessionId) => {
        return get().sessions.find(s => s.sessionId === sessionId);
      },
      
      getRecentSessions: (limit = 5) => {
        return get().sessions.slice(0, limit);
      },
      
      clearHistory: () => {
        set({ sessions: [] });
      },
    }),
    {
      name: 'sophia-session-history',
      version: 1,
    }
  )
);

// =============================================================================
// SELECTORS
// =============================================================================

export const selectRecentSessions = (limit: number) => 
  (state: SessionHistoryState) => state.sessions.slice(0, limit);

export const selectHasHistory = (state: SessionHistoryState) => 
  state.sessions.length > 0;
