/**
 * Session Store for Sophia V2
 * Sprint 1 - Week 1
 * 
 * Zustand store for managing ritual session state
 * Persists to localStorage for session recovery
 */

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { logger } from '../lib/error-logger';
import type {
  SessionClientStore,
  PresetType,
  ContextMode,
  RitualArtifacts,
  CompanionSessionContext,
  InvokeType,
  SessionMessage,
} from '../lib/session-types';
import { generateLocalId } from '../lib/utils';

// ============================================================================
// STORE STATE INTERFACE
// ============================================================================

interface SessionState {
  // Current session data
  session: SessionClientStore | null;
  
  // Loading states
  isInitializing: boolean;
  isEnding: boolean;
  
  // Error state
  error: string | null;
  
  // Actions
  createSession: (
    userId: string,
    presetType: PresetType,
    contextMode: ContextMode,
    options?: {
      gameName?: string;
      intention?: string;
      focusCue?: string;
      voiceMode?: boolean;
    }
  ) => SessionClientStore;
  
  updateSession: (updates: Partial<SessionClientStore>) => void;
  
  updateFromBackend: (sessionId: string, threadId: string) => SessionClientStore | null;

  pauseSession: () => void;

  resumeSession: () => void;
  
  endSession: () => void;
  
  clearSession: () => void;
  
  setError: (error: string | null) => void;
  
  setInitializing: (isInitializing: boolean) => void;
  
  setEnding: (isEnding: boolean) => void;
  
  // Companion tracking
  incrementCompanionInvokes: (invokeType: InvokeType) => void;
  
  // Artifacts
  storeArtifacts: (artifacts: RitualArtifacts, summary?: string) => void;
  
  // Messages (for session recovery)
  updateMessages: (messages: SessionMessage[]) => void;
  
  // Getters
  getSessionContext: () => CompanionSessionContext | null;
  
  isSessionActive: () => boolean;
}

// ============================================================================
// STORE IMPLEMENTATION
// ============================================================================

export const useSessionStore = create<SessionState>()(
  persist(
    (set, get) => ({
      // Initial state
      session: null,
      isInitializing: false,
      isEnding: false,
      error: null,
      
      // Create a new session (Week 1: local IDs, Week 2: backend IDs)
      // TODO Week 2: Replace with POST /sessions/start API call
      // - Send: { user_id, preset_type, context_mode, game_name?, intention?, focus_cue? }
      // - Receive: { session_id, thread_id, greeting_message?, created_at }
      // - Update store with real backend IDs via updateFromBackend()
      createSession: (userId, presetType, contextMode, options = {}) => {
        const now = new Date().toISOString();
        
        const newSession: SessionClientStore = {
          // Generate local IDs (will be replaced by backend in Week 2)
          sessionId: generateLocalId('sess'),
          threadId: generateLocalId('thread'),
          userId,
          
          // Session config
          presetType,
          contextMode,
          status: 'active',
          
          // Voice mode (voice-first experience)
          voiceMode: options.voiceMode ?? false,
          
          // Timestamps
          startedAt: now,
          lastActivityAt: now,
          activeElapsedSeconds: 0,
          activeSegmentStartedAt: now,
          
          // Optional context
          gameName: options.gameName,
          intention: options.intention,
          focusCue: options.focusCue,
          
          // State flags
          isActive: true,
          companionInvokesCount: 0,
        };
        
        set({ session: newSession, error: null });
        
        return newSession;
      },
      
      // Update session with partial data
      updateSession: (updates) => {
        const { session } = get();
        if (!session) return;
        
        set({
          session: {
            ...session,
            ...updates,
            lastActivityAt: new Date().toISOString(),
          },
        });
      },
      
      // Update with real backend IDs (Week 2)
      updateFromBackend: (sessionId, threadId) => {
        const { session } = get();
        if (!session) {
          return null;
        }
        
        const updated: SessionClientStore = {
          ...session,
          sessionId,
          threadId,
          lastActivityAt: new Date().toISOString(),
        };
        
        set({ session: updated });
        
        return updated;
      },

      pauseSession: () => {
        const { session } = get();
        if (!session || !session.isActive || session.status !== 'active') return;

        const now = Date.now();
        const segmentStart = session.activeSegmentStartedAt
          ? new Date(session.activeSegmentStartedAt).getTime()
          : now;
        const elapsedInSegment = Math.max(0, Math.floor((now - segmentStart) / 1000));
        const accumulated = (session.activeElapsedSeconds ?? 0) + elapsedInSegment;

        set({
          session: {
            ...session,
            status: 'paused',
            activeElapsedSeconds: accumulated,
            activeSegmentStartedAt: undefined,
            lastActivityAt: new Date().toISOString(),
          },
        });
      },

      resumeSession: () => {
        const { session } = get();
        if (!session || !session.isActive || session.status !== 'paused') return;

        const now = new Date().toISOString();

        set({
          session: {
            ...session,
            status: 'active',
            activeElapsedSeconds: session.activeElapsedSeconds ?? 0,
            activeSegmentStartedAt: now,
            lastActivityAt: now,
          },
        });
      },
      
      // Mark session as ended
      endSession: () => {
        const { session } = get();
        if (!session) return;

        const now = Date.now();
        const segmentStart = session.status === 'active' && session.activeSegmentStartedAt
          ? new Date(session.activeSegmentStartedAt).getTime()
          : null;
        const elapsedInSegment = segmentStart ? Math.max(0, Math.floor((now - segmentStart) / 1000)) : 0;
        const accumulated = (session.activeElapsedSeconds ?? 0) + elapsedInSegment;
        
        set({
          session: {
            ...session,
            status: 'ended',
            isActive: false,
            activeElapsedSeconds: accumulated,
            activeSegmentStartedAt: undefined,
            endedAt: new Date().toISOString(),
          },
        });
      },
      
      // Clear session completely
      clearSession: () => {
        set({
          session: null,
          error: null,
          isInitializing: false,
          isEnding: false,
        });
      },
      
      // Error handling
      setError: (error) => set({ error }),
      
      // Loading states
      setInitializing: (isInitializing) => set({ isInitializing }),
      setEnding: (isEnding) => set({ isEnding }),
      
      // Track companion button usage
      incrementCompanionInvokes: (invokeType) => {
        const { session } = get();
        if (!session) return;
        
        logger.debug('SessionStore', `Companion invoke: ${invokeType}`);
        
        set({
          session: {
            ...session,
            companionInvokesCount: session.companionInvokesCount + 1,
            lastActivityAt: new Date().toISOString(),
          },
        });
      },
      
      // Store artifacts from session end
      storeArtifacts: (artifacts, summary) => {
        const { session } = get();
        if (!session) return;
        
        set({
          session: {
            ...session,
            artifacts,
            summary,
          },
        });
      },
      
      // Update messages (for session recovery)
      updateMessages: (messages) => {
        const { session } = get();
        if (!session) return;
        
        set({
          session: {
            ...session,
            messages,
            lastActivityAt: new Date().toISOString(),
          },
        });
      },
      
      // Get context for companion invoke
      getSessionContext: () => {
        const { session } = get();
        if (!session) return null;
        
        const elapsedMs = Date.now() - new Date(session.startedAt).getTime();
        
        return {
          session_id: session.sessionId,
          preset_type: session.presetType,
          context_mode: session.contextMode,
          game_name: session.gameName,
          intention: session.intention,
          elapsed_seconds: Math.floor(elapsedMs / 1000),
        };
      },
      
      // Check if session is active
      isSessionActive: () => {
        const { session } = get();
        return session?.isActive ?? false;
      },
    }),
    {
      name: 'sophia-session-store',
      storage: createJSONStorage(() => localStorage),
      
      // Only persist session data, not loading states
      partialize: (state) => ({
        session: state.session,
      }),
    }
  )
);

// ============================================================================
// SELECTORS
// ============================================================================

export const selectSession = (state: SessionState) => state.session;
export const selectIsSessionActive = (state: SessionState) => state.session?.isActive ?? false;
export const selectSessionStatus = (state: SessionState) => state.session?.status ?? null;
export const selectPresetType = (state: SessionState) => state.session?.presetType ?? null;
export const selectContextMode = (state: SessionState) => state.session?.contextMode ?? null;
export const selectArtifacts = (state: SessionState) => state.session?.artifacts ?? null;
export const selectMessages = (state: SessionState) => state.session?.messages ?? [];

// Session summary for ResumeBanner (unified approach - Week 4)
export const selectSessionSummary = (state: SessionState) => {
  const session = state.session;
  if (!session?.isActive) return null;
  
  const messages = session.messages ?? [];
  const lastMessage = messages.length > 0 ? messages[messages.length - 1] : null;
  
  return {
    sessionType: session.presetType,
    contextMode: session.contextMode,
    messageCount: messages.length,
    lastMessagePreview: lastMessage?.content 
      ? lastMessage.content.slice(0, 60) + (lastMessage.content.length > 60 ? '...' : '')
      : undefined,
    startedAt: session.startedAt,
    updatedAt: session.lastActivityAt,
  };
};
