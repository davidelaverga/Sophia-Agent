/**
 * Session Store for Sophia V2
 * Sprint 1 - Week 1
 * 
 * Zustand store for managing ritual session state
 * Persists to localStorage for session recovery
 */

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

import { invalidateActiveSessionCache } from '../hooks/useSessionStart';
import {
  continueSession as continueSessionAPI,
  deleteAllSessionRecords,
  deleteSessionRecord,
  endSession as endSessionAPI,
  getOpenSessions as fetchOpenSessions,
  getSession,
  isError,
  listSessions,
  updateSession as updatePersistedSession,
} from '../lib/api/sessions-api';
import { logger } from '../lib/error-logger';
import type {
  SessionClientStore,
  PresetType,
  ContextMode,
  RitualArtifacts,
  CompanionSessionContext,
  InvokeType,
  SessionMessage,
  SessionInfo,
} from '../lib/session-types';
import { generateLocalId } from '../lib/utils';
import type { BuilderArtifactV1 } from '../types/builder-artifact';

// ============================================================================
// STORE STATE INTERFACE
// ============================================================================

interface SessionState {
  // Current session data (the one being displayed/interacted with)
  session: SessionClientStore | null;
  
  // Multi-session: all open sessions from backend
  openSessions: SessionInfo[];
  recentSessions: SessionInfo[];
  isLoadingSessions: boolean;
  lastOpenSessionsFetchAt: number | null;
  lastOpenSessionsUserId: string | null;
  /** ID of the last session removed — used by dashboard to clear resume banner */
  lastDeletedSessionId: string | null;
  
  // Loading states
  isInitializing: boolean;
  isEnding: boolean;
  
  // Error state
  error: string | null;
  
  // Multi-session actions
  refreshOpenSessions: (userId?: string) => Promise<number>;
  refreshRecentSessions: (userId?: string) => Promise<void>;
  restoreOpenSession: (sessionInfo: SessionInfo, userId?: string) => Promise<void>;
  viewEndedSession: (sessionId: string, presetType: PresetType, contextMode: ContextMode, userId?: string) => Promise<void>;
  continueEndedSession: (sessionId: string, presetType: PresetType, contextMode: ContextMode, userId?: string) => Promise<void>;
  removeOpenSession: (sessionId: string, userId?: string) => Promise<boolean>;
  removeRecentSession: (sessionId: string, userId?: string) => Promise<boolean>;
  removeAllSessions: (userId?: string) => Promise<{ deleted_count: number; session_ids: string[] } | null>;
  recordOpenSessionActivity: (sessionId: string, activity: {
    messagePreview?: string;
    title?: string | null;
    turnCount?: number;
    updatedAt?: string;
    status?: string | null;
    endedAt?: string | null;
  }) => void;
  
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
  storeBuilderArtifact: (builderArtifact: BuilderArtifactV1 | null) => void;
  
  // Messages (for session recovery)
  updateMessages: (messages: SessionMessage[]) => void;
  
  // Getters
  getSessionContext: () => CompanionSessionContext | null;
  
  isSessionActive: () => boolean;
}

// ============================================================================
// STORE IMPLEMENTATION
// ============================================================================

function normalizeSessionPreview(messagePreview: string): string {
  return messagePreview.trim().replace(/\s+/g, ' ').slice(0, 200);
}

function sortSessionsByUpdatedAt(sessions: SessionInfo[]): SessionInfo[] {
  return [...sessions].sort((left, right) => (
    new Date(right.updated_at).getTime() - new Date(left.updated_at).getTime()
  ));
}

function normalizeBackendSessionStatus(status: string | null | undefined): SessionInfo['status'] {
  if (status === 'open' || status === 'paused') {
    return status;
  }

  return 'ended';
}

function mapBackendStatusToClient(status: SessionInfo['status']): SessionClientStore['status'] {
  if (status === 'paused') {
    return 'paused';
  }

  if (status === 'ended') {
    return 'ended';
  }

  return 'active';
}

export const useSessionStore = create<SessionState>()(
  persist(
    (set, get) => ({
      // Initial state
      session: null,
      openSessions: [],
      recentSessions: [],
      isLoadingSessions: false,
      lastOpenSessionsFetchAt: null,
      lastOpenSessionsUserId: null,
      lastDeletedSessionId: null,
      isInitializing: false,
      isEnding: false,
      error: null,
      
      // Multi-session: fetch open sessions from backend
      refreshOpenSessions: async (userId) => {
        const normalizedUserId = typeof userId === 'string' && userId.trim()
          ? userId.trim()
          : null;
        const {
          isLoadingSessions,
          lastOpenSessionsFetchAt,
          lastOpenSessionsUserId,
          openSessions,
        } = get();
        const now = Date.now();
        const recentlyFetched = (
          lastOpenSessionsFetchAt !== null
          && lastOpenSessionsUserId === normalizedUserId
          && now - lastOpenSessionsFetchAt < 15000
        );

        if (isLoadingSessions) {
          return openSessions.length;
        }

        if (recentlyFetched) {
          return openSessions.length;
        }

        set({ isLoadingSessions: true });
        try {
          const result = await fetchOpenSessions(normalizedUserId ?? undefined);
          if (result.success) {
            set({
              openSessions: result.data.sessions,
              lastOpenSessionsFetchAt: now,
              lastOpenSessionsUserId: normalizedUserId,
            });
            return result.data.sessions.length;
          } else {
            logger.warn('SessionStore: Failed to load open sessions');
          }
        } catch (err) {
          logger.warn('SessionStore: Error fetching open sessions', { error: err });
        } finally {
          set({ isLoadingSessions: false });
        }
        return get().openSessions.length;
      },
      
      // Multi-session: fetch recent sessions (open + ended)
      refreshRecentSessions: async (userId) => {
        try {
          const normalizedUserId = typeof userId === 'string' && userId.trim()
            ? userId.trim()
            : undefined;
          const result = await listSessions(normalizedUserId, { limit: 30 });
          if (result.success) {
            set({ recentSessions: result.data.sessions });
          }
        } catch (err) {
          logger.warn('SessionStore: Error fetching recent sessions', { error: err });
        }
      },

      recordOpenSessionActivity: (sessionId, activity) => {
        const normalizedPreview = activity.messagePreview
          ? normalizeSessionPreview(activity.messagePreview)
          : undefined;
        const nextUpdatedAt = activity.updatedAt ?? new Date().toISOString();
        const normalizedStatus = typeof activity.status === 'string'
          ? normalizeBackendSessionStatus(activity.status)
          : undefined;
        const nextEndedAt = activity.endedAt;

        if (
          !normalizedPreview
          && activity.title === undefined
          && activity.turnCount === undefined
          && normalizedStatus === undefined
          && nextEndedAt === undefined
        ) {
          return;
        }

        set((state) => {
          const applyUpdate = (entry: SessionInfo): SessionInfo => ({
            ...entry,
            updated_at: nextUpdatedAt,
            turn_count: typeof activity.turnCount === 'number' ? activity.turnCount : entry.turn_count + 1,
            last_message_preview: normalizedPreview ?? entry.last_message_preview,
            title: activity.title !== undefined ? activity.title : entry.title,
            status: normalizedStatus ?? entry.status,
            ended_at: normalizedStatus === undefined
              ? entry.ended_at
              : normalizedStatus === 'ended'
                ? (nextEndedAt ?? entry.ended_at ?? nextUpdatedAt)
                : null,
          });

          const buildFromActiveSession = (): SessionInfo | null => {
            if (state.session?.sessionId !== sessionId) return null;
            const synthesizedStatus: SessionInfo['status'] = normalizedStatus ?? 'open';
            return {
              session_id: sessionId,
              thread_id: state.session.threadId,
              session_type: state.session.presetType,
              preset_context: state.session.contextMode,
              status: synthesizedStatus,
              started_at: state.session.startedAt,
              updated_at: nextUpdatedAt,
              ended_at: synthesizedStatus === 'ended' ? (nextEndedAt ?? nextUpdatedAt) : null,
              turn_count: typeof activity.turnCount === 'number' ? activity.turnCount : 1,
              title: activity.title,
              last_message_preview: normalizedPreview ?? null,
              platform: state.session.voiceMode ? 'voice' : 'text',
              intention: state.session.intention,
              focus_cue: state.session.focusCue,
            };
          };

          const nextOpenSessions = (() => {
            let found = false;
            const updated = state.openSessions.map((entry) => {
              if (entry.session_id !== sessionId) return entry;
              found = true;
              return applyUpdate(entry);
            });
            if (normalizedStatus === 'ended') {
              return sortSessionsByUpdatedAt(updated.filter((entry) => entry.session_id !== sessionId));
            }
            if (!found) {
              const synthesized = buildFromActiveSession();
              if (synthesized?.status !== 'ended') updated.unshift(synthesized);
            }
            return sortSessionsByUpdatedAt(updated);
          })();

          const nextRecentSessions = (() => {
            let found = false;
            const updated = state.recentSessions.map((entry) => {
              if (entry.session_id !== sessionId) return entry;
              found = true;
              return applyUpdate(entry);
            });
            if (!found) {
              const synthesized = buildFromActiveSession();
              if (synthesized) updated.unshift(synthesized);
            }
            return sortSessionsByUpdatedAt(updated);
          })();

          const nextSession = state.session?.sessionId === sessionId
            ? {
                ...state.session,
                lastActivityAt: nextUpdatedAt,
                ...(normalizedStatus === 'ended'
                  ? {
                      status: 'ended' as const,
                      isActive: false,
                      endedAt: nextEndedAt ?? nextUpdatedAt,
                      activeSegmentStartedAt: undefined,
                    }
                  : normalizedStatus === 'paused'
                    ? {
                        status: 'paused' as const,
                        isActive: true,
                        endedAt: undefined,
                        activeSegmentStartedAt: undefined,
                      }
                    : normalizedStatus === 'open'
                      ? {
                          status: 'active' as const,
                          isActive: true,
                          endedAt: undefined,
                          activeSegmentStartedAt: state.session.activeSegmentStartedAt ?? nextUpdatedAt,
                        }
                      : {}),
              }
            : state.session;

          return {
            session: nextSession,
            openSessions: nextOpenSessions,
            recentSessions: nextRecentSessions,
          };
        });
      },

      restoreOpenSession: async (sessionInfo, userId) => {
        const resolvedUserId = userId?.trim() || get().session?.userId || 'anonymous';
        let resolvedSessionInfo = sessionInfo;

        const latestSession = await getSession(sessionInfo.session_id, resolvedUserId);
        if (!isError(latestSession)) {
          resolvedSessionInfo = latestSession.data;
        }

        // If the session is ended, auto-reopen it on the backend so the user
        // can continue. Same thread_id → transcript and memory context stay
        // intact. Next finalization will dedupe against existing memories.
        const backendStatus = normalizeBackendSessionStatus(resolvedSessionInfo.status);
        if (backendStatus === 'ended') {
          const reopened = await updatePersistedSession(
            resolvedSessionInfo.session_id,
            { status: 'open' },
            resolvedUserId,
          );
          if (!isError(reopened)) {
            resolvedSessionInfo = reopened.data;
          } else {
            logger.warn('SessionStore: Failed to reopen ended session — continuing read-from-thread', {
              sessionId: resolvedSessionInfo.session_id,
              code: reopened.code,
              error: reopened.error,
            });
          }
        }

        const resolvedStatus = normalizeBackendSessionStatus(resolvedSessionInfo.status);
        const resolvedIsInteractive = resolvedStatus !== 'ended';
        const restored: SessionClientStore = {
          sessionId: resolvedSessionInfo.session_id,
          threadId: resolvedSessionInfo.thread_id,
          userId: resolvedUserId,
          presetType: (resolvedSessionInfo.session_type as PresetType) || 'open',
          contextMode: (resolvedSessionInfo.preset_context as ContextMode) || 'life',
          status: mapBackendStatusToClient(resolvedStatus),
          voiceMode: resolvedSessionInfo.platform === 'voice' || resolvedSessionInfo.platform === 'ios_voice',
          startedAt: resolvedSessionInfo.started_at,
          lastActivityAt: resolvedSessionInfo.updated_at,
          endedAt: resolvedStatus === 'ended' ? resolvedSessionInfo.ended_at ?? undefined : undefined,
          intention: resolvedSessionInfo.intention ?? undefined,
          focusCue: resolvedSessionInfo.focus_cue ?? undefined,
          isActive: resolvedIsInteractive,
          companionInvokesCount: 0,
          // Clear any stale messages carried over from a previous session —
          // loadSession() below will repopulate from the backend thread.
          messages: [],
        };

        set((state) => {
          const upsertSessions = (sessions: SessionInfo[]) => sortSessionsByUpdatedAt([
            resolvedSessionInfo,
            ...sessions.filter((entry) => entry.session_id !== resolvedSessionInfo.session_id),
          ]);

          return {
            session: restored,
            openSessions: resolvedIsInteractive
              ? upsertSessions(state.openSessions)
              : state.openSessions.filter((entry) => entry.session_id !== resolvedSessionInfo.session_id),
            recentSessions: upsertSessions(state.recentSessions),
            error: null,
          };
        });

        try {
          const { useChatStore } = await import('./chat-store');
          const loaded = await useChatStore.getState().loadSession(resolvedSessionInfo.session_id, resolvedUserId);
          if (!loaded) {
            logger.warn('SessionStore: loadSession returned false — messages may be missing', {
              sessionId: resolvedSessionInfo.session_id,
            });
          }
        } catch {
          logger.warn('SessionStore: Failed to restore messages for resumed session', {
            sessionId: resolvedSessionInfo.session_id,
          });
        }
      },
      
      // View an ended session's transcript without creating a continuation.
      // Previously this auto-continued via continueSessionAPI which polluted the
      // sidebar with duplicate rows (original ended + new open). Continuation is
      // now an explicit action (see continueEndedSession below).
      viewEndedSession: async (sessionId, _presetType, _contextMode, userId) => {
        const resolvedUserId = userId?.trim() || get().session?.userId || 'anonymous';
        const latest = await getSession(sessionId, resolvedUserId);
        if (isError(latest)) {
          throw new Error(latest.error || 'Failed to load ended session');
        }
        await get().restoreOpenSession(latest.data, resolvedUserId);
      },

      // Explicit continuation of an ended session — keeps the same thread_id so
      // history carries over, but creates a fresh session_id for the new chapter.
      continueEndedSession: async (sessionId, presetType, contextMode, userId) => {
        const resolvedUserId = userId?.trim() || get().session?.userId || 'anonymous';
        const currentSession = get().session;
        const platform = currentSession?.voiceMode ? 'voice' : 'text';

        const continuation = await continueSessionAPI(sessionId, {
          user_id: resolvedUserId,
          session_type: presetType,
          preset_context: contextMode,
          platform,
        });

        if (isError(continuation)) {
          throw new Error(continuation.error || 'Failed to continue ended session');
        }

        await get().restoreOpenSession(continuation.data.session, resolvedUserId);
      },

      removeOpenSession: async (sessionId, userId) => {
        const activeSession = get().session;
        const resolvedUserId = userId?.trim() || activeSession?.userId;

        // End the session first so it's no longer "open" on the backend
        // (prevents checkActiveSession from resurrecting it on refresh)
        try {
          await endSessionAPI({
            session_id: sessionId,
            user_id: resolvedUserId,
            offer_debrief: false,
          });
        } catch (error) {
          logger.warn('SessionStore: Failed to end session before deletion', {
            sessionId,
            userId: resolvedUserId,
            error,
          });
        }

        const result = await deleteSessionRecord(sessionId, resolvedUserId);

        // Treat 404 as success — session already gone from backend
        if (isError(result) && result.status !== 404) {
          logger.warn('SessionStore: Failed to delete persisted session', {
            sessionId,
            userId: resolvedUserId,
            code: result.code,
            error: result.error,
          });
          return false;
        }

        const deletingActiveSession = get().session?.sessionId === sessionId;
        set((state) => ({
          openSessions: state.openSessions.filter((session) => session.session_id !== sessionId),
          recentSessions: state.recentSessions.filter((session) => session.session_id !== sessionId),
          lastOpenSessionsFetchAt: null,
          lastOpenSessionsUserId: null,
          lastDeletedSessionId: sessionId,
          ...(deletingActiveSession ? { session: null } : {}),
        }));

        if (deletingActiveSession) {
          try {
            const { useChatStore } = await import('./chat-store');
            useChatStore.getState().clearSession();
          } catch (error) {
            logger.warn('SessionStore: Failed to clear chat state after session deletion', {
              sessionId,
              error,
            });
          }
        }

        // Invalidate the active-session cache so dashboard bootstrap
        // doesn't resurrect the session from stale cached data
        invalidateActiveSessionCache();

        return true;
      },

      removeRecentSession: async (sessionId, userId) => {
        const activeSession = get().session;
        const resolvedUserId = userId?.trim() || activeSession?.userId;
        const result = await deleteSessionRecord(sessionId, resolvedUserId);

        if (isError(result) && result.status !== 404) {
          logger.warn('SessionStore: Failed to delete persisted recent session', {
            sessionId,
            userId: resolvedUserId,
            code: result.code,
            error: result.error,
          });
          return false;
        }

        const deletingActiveSession = get().session?.sessionId === sessionId;
        set((state) => ({
          openSessions: state.openSessions.filter((session) => session.session_id !== sessionId),
          recentSessions: state.recentSessions.filter((session) => session.session_id !== sessionId),
          lastOpenSessionsFetchAt: null,
          lastOpenSessionsUserId: null,
          lastDeletedSessionId: sessionId,
          ...(deletingActiveSession ? { session: null } : {}),
        }));

        if (deletingActiveSession) {
          try {
            const { useChatStore } = await import('./chat-store');
            useChatStore.getState().clearSession();
          } catch (error) {
            logger.warn('SessionStore: Failed to clear chat state after recent session deletion', {
              sessionId,
              error,
            });
          }
        }

        invalidateActiveSessionCache();

        return true;
      },

      removeAllSessions: async (userId) => {
        const activeSession = get().session;
        const resolvedUserId = userId?.trim() || activeSession?.userId;
        const result = await deleteAllSessionRecords(resolvedUserId);

        if (isError(result)) {
          logger.warn('SessionStore: Failed to delete all persisted sessions', {
            userId: resolvedUserId,
            code: result.code,
            error: result.error,
          });
          return null;
        }

        const shouldClearCurrentSession = Boolean(activeSession);
        set({
          openSessions: [],
          recentSessions: [],
          lastOpenSessionsFetchAt: null,
          lastOpenSessionsUserId: null,
          lastDeletedSessionId: activeSession?.sessionId ?? null,
          ...(shouldClearCurrentSession ? { session: null } : {}),
        });

        if (shouldClearCurrentSession) {
          try {
            const { useChatStore } = await import('./chat-store');
            useChatStore.getState().clearSession();
          } catch (error) {
            logger.warn('SessionStore: Failed to clear chat state after bulk session deletion', {
              userId: resolvedUserId,
              error,
            });
          }
        }

        invalidateActiveSessionCache();

        return result.data;
      },

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
        const endedAt = session.endedAt ?? new Date(now).toISOString();
        const segmentStart = session.status === 'active' && session.activeSegmentStartedAt
          ? new Date(session.activeSegmentStartedAt).getTime()
          : null;
        const elapsedInSegment = segmentStart ? Math.max(0, Math.floor((now - segmentStart) / 1000)) : 0;
        const accumulated = (session.activeElapsedSeconds ?? 0) + elapsedInSegment;

        set((state) => {
          const existingSessionInfo = state.recentSessions.find((entry) => entry.session_id === session.sessionId)
            ?? state.openSessions.find((entry) => entry.session_id === session.sessionId);
          const nextTurnCount = existingSessionInfo?.turn_count
            ?? (Array.isArray(session.messages) ? session.messages.length : 0);

          const endedSessionInfo: SessionInfo = {
            session_id: session.sessionId,
            thread_id: existingSessionInfo?.thread_id ?? session.threadId,
            session_type: existingSessionInfo?.session_type ?? session.presetType,
            preset_context: existingSessionInfo?.preset_context ?? session.contextMode,
            status: 'ended',
            started_at: session.startedAt,
            updated_at: endedAt,
            ended_at: endedAt,
            turn_count: nextTurnCount,
            title: existingSessionInfo?.title ?? null,
            last_message_preview: existingSessionInfo?.last_message_preview ?? null,
            platform: existingSessionInfo?.platform ?? (session.voiceMode ? 'voice' : 'text'),
            intention: existingSessionInfo?.intention ?? session.intention ?? null,
            focus_cue: existingSessionInfo?.focus_cue ?? session.focusCue ?? null,
          };

          return {
            session: {
              ...session,
              status: 'ended',
              isActive: false,
              activeElapsedSeconds: accumulated,
              activeSegmentStartedAt: undefined,
              endedAt,
            },
            openSessions: state.openSessions.filter((entry) => entry.session_id !== session.sessionId),
            recentSessions: sortSessionsByUpdatedAt([
              endedSessionInfo,
              ...state.recentSessions.filter((entry) => entry.session_id !== session.sessionId),
            ]),
            lastOpenSessionsFetchAt: null,
            lastOpenSessionsUserId: null,
          };
        });

        invalidateActiveSessionCache();
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

      storeBuilderArtifact: (builderArtifact) => {
        const { session } = get();
        if (!session) return;

        set({
          session: {
            ...session,
            ...(builderArtifact ? { builderArtifact } : { builderArtifact: undefined }),
            lastActivityAt: new Date().toISOString(),
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
      
      // Only persist session data and open sessions, not loading states
      partialize: (state) => ({
        session: state.session,
        openSessions: state.openSessions,
        recentSessions: state.recentSessions,
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
export const selectBuilderArtifact = (state: SessionState) => state.session?.builderArtifact ?? null;
export const selectMessages = (state: SessionState) => state.session?.messages ?? [];

// Multi-session selectors
export const selectRecentSessions = (state: SessionState) => state.recentSessions;
export const selectIsLoadingSessions = (state: SessionState) => state.isLoadingSessions;
export const selectOpenSessionCount = (state: SessionState) => state.openSessions.length;

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
