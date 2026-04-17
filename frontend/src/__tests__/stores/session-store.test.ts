/**
 * Tests for Session Store
 * Critical: validates session lifecycle, persistence, and state management
 */

import { waitFor } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';

const getOpenSessionsMock = vi.fn();
const listSessionsMock = vi.fn();
const deleteSessionRecordMock = vi.fn();
const endSessionMock = vi.fn();
const clearChatSessionMock = vi.fn();
const loadSessionMock = vi.fn();

// Mock error-logger before importing store
vi.mock('../../app/lib/error-logger', () => ({
  logger: {
    debug: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
  },
}));

vi.mock('../../app/lib/api/sessions-api', () => ({
  getOpenSessions: (...args: unknown[]) => getOpenSessionsMock(...args),
  listSessions: (...args: unknown[]) => listSessionsMock(...args),
  deleteSessionRecord: (...args: unknown[]) => deleteSessionRecordMock(...args),
  endSession: (...args: unknown[]) => endSessionMock(...args),
  isError: (result: { success: boolean }) => !result.success,
}));

vi.mock('../../app/stores/chat-store', () => ({
  useChatStore: {
    getState: () => ({
      clearSession: clearChatSessionMock,
      loadSession: loadSessionMock,
    }),
  },
}));

// Import after mocking
import { useSessionStore } from '../../app/stores/session-store';

describe('Session Store', () => {
  beforeEach(() => {
    getOpenSessionsMock.mockReset();
    listSessionsMock.mockReset();
    deleteSessionRecordMock.mockReset();
    endSessionMock.mockReset();
    clearChatSessionMock.mockReset();
    loadSessionMock.mockReset();
    getOpenSessionsMock.mockResolvedValue({ success: true, data: { sessions: [], count: 0 } });
    listSessionsMock.mockResolvedValue({ success: true, data: { sessions: [], total: 0 } });
    deleteSessionRecordMock.mockResolvedValue({ success: true, data: { ok: true, session_id: 'sess-1' } });
    endSessionMock.mockResolvedValue({ success: true, data: { ended_at: '2026-04-15T00:10:00.000Z', turn_count: 2 } });
    loadSessionMock.mockResolvedValue(true);

    // Reset store state before each test
    const { clearSession, setError, setInitializing, setEnding } = useSessionStore.getState();
    clearSession();
    setError(null);
    setInitializing(false);
    setEnding(false);
    useSessionStore.setState({
      openSessions: [],
      recentSessions: [],
      isLoadingSessions: false,
      lastOpenSessionsFetchAt: null,
    });
    
    // Clear localStorage
    localStorage.clear();
  });

  describe('createSession', () => {
    it('should create a new session with required fields', () => {
      const { createSession } = useSessionStore.getState();
      
      const session = createSession('user-123', 'prepare', 'gaming');
      
      expect(session).toBeDefined();
      expect(session.userId).toBe('user-123');
      expect(session.presetType).toBe('prepare');
      expect(session.contextMode).toBe('gaming');
      expect(session.isActive).toBe(true);
      expect(session.sessionId).toBeDefined();
      expect(session.companionInvokesCount).toBe(0);
    });

    it('should create session with optional fields', () => {
      const { createSession } = useSessionStore.getState();
      
      const session = createSession('user-123', 'prepare', 'gaming', {
        gameName: 'Valorant',
        intention: 'Improve aim',
        focusCue: 'Stay calm',
        voiceMode: true,
      });
      
      expect(session.gameName).toBe('Valorant');
      expect(session.intention).toBe('Improve aim');
      expect(session.focusCue).toBe('Stay calm');
      expect(session.voiceMode).toBe(true);
    });

    it('should update store state after creating session', () => {
      const { createSession } = useSessionStore.getState();
      
      createSession('user-123', 'debrief', 'work');
      
      const state = useSessionStore.getState();
      expect(state.session).not.toBeNull();
      expect(state.session?.presetType).toBe('debrief');
    });
  });

  describe('updateSession', () => {
    it('should update existing session fields', () => {
      const { createSession, updateSession } = useSessionStore.getState();
      
      createSession('user-123', 'reset', 'life');
      const newTime = new Date().toISOString();
      updateSession({ lastActivityAt: newTime, voiceMode: true });
      
      const state = useSessionStore.getState();
      expect(state.session?.voiceMode).toBe(true);
      expect(state.session?.lastActivityAt).toBe(newTime);
    });

    it('should not update if no session exists', () => {
      const { updateSession } = useSessionStore.getState();
      
      // No session created
      updateSession({ voiceMode: true });
      
      const state = useSessionStore.getState();
      expect(state.session).toBeNull();
    });
  });

  describe('updateFromBackend', () => {
    it('should update session with backend IDs', () => {
      const { createSession, updateFromBackend } = useSessionStore.getState();
      
      createSession('user-123', 'vent', 'gaming');
      const updated = updateFromBackend('backend-session-id', 'backend-thread-id');
      
      expect(updated?.sessionId).toBe('backend-session-id');
      expect(updated?.threadId).toBe('backend-thread-id');
    });

    it('should return null if no session exists', () => {
      const { updateFromBackend } = useSessionStore.getState();
      
      const result = updateFromBackend('session-id', 'thread-id');
      
      expect(result).toBeNull();
    });
  });

  describe('endSession', () => {
    it('should mark session as inactive', () => {
      const { createSession, endSession } = useSessionStore.getState();
      
      createSession('user-123', 'prepare', 'work');
      endSession();
      
      const state = useSessionStore.getState();
      expect(state.session?.isActive).toBe(false);
      expect(state.session?.endedAt).toBeDefined();
    });
  });

  describe('removeOpenSession', () => {
    it('should delete the backend session record and clear local session state', async () => {
      const { createSession, updateFromBackend, removeOpenSession } = useSessionStore.getState();

      createSession('dev-user', 'prepare', 'gaming');
      updateFromBackend('sess-1', 'thread-1');
      useSessionStore.setState({
        openSessions: [
          {
            session_id: 'sess-1',
            thread_id: 'thread-1',
            session_type: 'prepare',
            preset_context: 'gaming',
            status: 'open',
            started_at: '2026-04-15T00:00:00.000Z',
            updated_at: '2026-04-15T00:05:00.000Z',
            turn_count: 2,
          },
        ],
        recentSessions: [
          {
            session_id: 'sess-1',
            thread_id: 'thread-1',
            session_type: 'prepare',
            preset_context: 'gaming',
            status: 'open',
            started_at: '2026-04-15T00:00:00.000Z',
            updated_at: '2026-04-15T00:05:00.000Z',
            turn_count: 2,
          },
        ],
        lastOpenSessionsFetchAt: Date.now(),
      });

      const deleted = await removeOpenSession('sess-1');

      expect(deleted).toBe(true);
      expect(endSessionMock).toHaveBeenCalledWith({
        session_id: 'sess-1',
        user_id: 'dev-user',
        offer_debrief: false,
      });
      expect(deleteSessionRecordMock).toHaveBeenCalledWith('sess-1', 'dev-user');
      expect(useSessionStore.getState().openSessions).toEqual([]);
      expect(useSessionStore.getState().recentSessions).toEqual([]);
      expect(useSessionStore.getState().session).toBeNull();
      expect(useSessionStore.getState().lastOpenSessionsFetchAt).toBeNull();
      expect(clearChatSessionMock).toHaveBeenCalledTimes(1);
    });

    it('should preserve local state when backend deletion fails', async () => {
      const { removeOpenSession } = useSessionStore.getState();
      deleteSessionRecordMock.mockResolvedValue({
        success: false,
        error: 'boom',
        code: 'SERVER_ERROR',
      });

      useSessionStore.setState({
        openSessions: [
          {
            session_id: 'sess-1',
            thread_id: 'thread-1',
            session_type: 'prepare',
            preset_context: 'gaming',
            status: 'open',
            started_at: '2026-04-15T00:00:00.000Z',
            updated_at: '2026-04-15T00:05:00.000Z',
            turn_count: 2,
          },
        ],
      });

      const deleted = await removeOpenSession('sess-1');

      expect(deleted).toBe(false);
      expect(useSessionStore.getState().openSessions).toHaveLength(1);
      expect(clearChatSessionMock).not.toHaveBeenCalled();
    });
  });

  describe('removeRecentSession', () => {
    it('should delete an ended backend session record and clear local session state', async () => {
      const { createSession, updateFromBackend, removeRecentSession } = useSessionStore.getState();

      createSession('dev-user', 'debrief', 'life');
      updateFromBackend('sess-ended', 'thread-ended');
      useSessionStore.setState({
        openSessions: [],
        recentSessions: [
          {
            session_id: 'sess-ended',
            thread_id: 'thread-ended',
            session_type: 'debrief',
            preset_context: 'life',
            status: 'ended',
            started_at: '2026-04-15T00:00:00.000Z',
            updated_at: '2026-04-15T00:10:00.000Z',
            ended_at: '2026-04-15T00:10:00.000Z',
            turn_count: 4,
          },
        ],
        lastOpenSessionsFetchAt: Date.now(),
      });

      const deleted = await removeRecentSession('sess-ended');

      expect(deleted).toBe(true);
      expect(deleteSessionRecordMock).toHaveBeenCalledWith('sess-ended', 'dev-user');
      expect(useSessionStore.getState().recentSessions).toEqual([]);
      expect(useSessionStore.getState().session).toBeNull();
      expect(useSessionStore.getState().lastOpenSessionsFetchAt).toBeNull();
      expect(clearChatSessionMock).toHaveBeenCalledTimes(1);
      expect(endSessionMock).not.toHaveBeenCalled();
    });
  });

  describe('restoreOpenSession', () => {
    it('restores an existing backend session without inventing a new session id', async () => {
      const { restoreOpenSession } = useSessionStore.getState();

      await restoreOpenSession({
        session_id: 'sess-existing',
        thread_id: 'thread-existing',
        session_type: 'prepare',
        preset_context: 'gaming',
        status: 'open',
        started_at: '2026-04-15T00:00:00.000Z',
        updated_at: '2026-04-15T00:05:00.000Z',
        ended_at: null,
        turn_count: 2,
        title: 'Preparing for ranked tonight',
        last_message_preview: 'I want to get ready for ranked tonight',
        platform: 'text',
        intention: 'Win two matches',
        focus_cue: 'Stay calm',
      }, 'dev-user');

      const state = useSessionStore.getState();
      expect(state.session?.sessionId).toBe('sess-existing');
      expect(state.session?.threadId).toBe('thread-existing');
      expect(state.openSessions[0]?.session_id).toBe('sess-existing');
      expect(state.recentSessions[0]?.session_id).toBe('sess-existing');

      await waitFor(() => {
        expect(loadSessionMock).toHaveBeenCalledWith('sess-existing', 'dev-user');
      });
    });
  });

  describe('recordOpenSessionActivity', () => {
    it('stores preview immediately and applies server title metadata when available', () => {
      const { recordOpenSessionActivity } = useSessionStore.getState();

      useSessionStore.setState({
        openSessions: [
          {
            session_id: 'sess-1',
            thread_id: 'thread-1',
            session_type: 'open',
            preset_context: 'life',
            status: 'open',
            started_at: '2026-04-15T00:00:00.000Z',
            updated_at: '2026-04-15T00:01:00.000Z',
            turn_count: 0,
            title: null,
            last_message_preview: null,
          },
        ],
      });

      recordOpenSessionActivity('sess-1', {
        messagePreview: 'i need to prepare for my investor meeting tomorrow',
      });

      let session = useSessionStore.getState().openSessions[0];
      expect(session.last_message_preview).toBe('i need to prepare for my investor meeting tomorrow');
      expect(session.title).toBeNull();
      expect(session.turn_count).toBe(1);

      recordOpenSessionActivity('sess-1', {
        messagePreview: 'i need to prepare for my investor meeting tomorrow',
        title: 'Preparing for my investor meeting tomorrow',
        turnCount: 1,
        updatedAt: '2026-04-15T00:02:00.000Z',
      });

      session = useSessionStore.getState().openSessions[0];
      expect(session.last_message_preview).toBe('i need to prepare for my investor meeting tomorrow');
      expect(session.title).toBe('Preparing for my investor meeting tomorrow');
      expect(session.turn_count).toBe(1);
    });
  });

  describe('clearSession', () => {
    it('should completely remove session', () => {
      const { createSession, clearSession } = useSessionStore.getState();
      
      createSession('user-123', 'prepare', 'gaming');
      clearSession();
      
      const state = useSessionStore.getState();
      expect(state.session).toBeNull();
    });
  });

  describe('storeArtifacts', () => {
    it('should store artifacts in session', () => {
      const { createSession, storeArtifacts } = useSessionStore.getState();
      
      createSession('user-123', 'debrief', 'gaming');
      
      const artifacts = {
        takeaway: 'Great performance today',
        reflection: { prompt: 'What went well?', tag: 'reflection' },
        memoryCreated: true,
      };
      
      storeArtifacts(artifacts, 'Session summary');
      
      const state = useSessionStore.getState();
      expect(state.session?.artifacts?.takeaway).toBe('Great performance today');
    });
  });

  describe('storeBuilderArtifact', () => {
    it('should store builder artifacts in session state', () => {
      const { createSession, storeBuilderArtifact } = useSessionStore.getState();

      createSession('user-123', 'debrief', 'gaming');
      storeBuilderArtifact({
        artifactTitle: 'Postmortem draft',
        artifactType: 'document',
        artifactPath: 'mnt/user-data/outputs/postmortem.md',
        decisionsMade: ['Removed the duplicate timeline'],
      });

      const state = useSessionStore.getState();
      expect(state.session?.builderArtifact).toMatchObject({
        artifactTitle: 'Postmortem draft',
        artifactType: 'document',
      });
    });
  });

  describe('incrementCompanionInvokes', () => {
    it('should track companion invocations', () => {
      const { createSession, incrementCompanionInvokes } = useSessionStore.getState();
      
      createSession('user-123', 'prepare', 'gaming');
      
      incrementCompanionInvokes('quick_question');
      incrementCompanionInvokes('tilt_reset');
      incrementCompanionInvokes('plan_reminder');
      
      const state = useSessionStore.getState();
      // Store tracks total count, not per-type counts
      expect(state.session?.companionInvokesCount).toBe(3);
    });
  });

  describe('isSessionActive', () => {
    it('should return true for active session', () => {
      const { createSession, isSessionActive } = useSessionStore.getState();
      
      createSession('user-123', 'reset', 'life');
      
      expect(isSessionActive()).toBe(true);
    });

    it('should return false after ending session', () => {
      const { createSession, endSession, isSessionActive } = useSessionStore.getState();
      
      createSession('user-123', 'vent', 'work');
      endSession();
      
      expect(isSessionActive()).toBe(false);
    });

    it('should return false with no session', () => {
      const { isSessionActive } = useSessionStore.getState();
      
      expect(isSessionActive()).toBe(false);
    });
  });

  describe('selectors', () => {
    it('selectSession should return session', async () => {
      const { createSession } = useSessionStore.getState();
      
      createSession('user-123', 'prepare', 'gaming');
      
      // Use the selector pattern
      const { selectSession } = await import('../../app/stores/session-store');
      const session = selectSession(useSessionStore.getState());
      
      expect(session?.presetType).toBe('prepare');
    });
  });

  describe('error handling', () => {
    it('should set and clear errors', () => {
      const { setError } = useSessionStore.getState();
      
      setError('Something went wrong');
      expect(useSessionStore.getState().error).toBe('Something went wrong');
      
      setError(null);
      expect(useSessionStore.getState().error).toBeNull();
    });
  });

  describe('loading states', () => {
    it('should track initializing state', () => {
      const { setInitializing } = useSessionStore.getState();
      
      setInitializing(true);
      expect(useSessionStore.getState().isInitializing).toBe(true);
      
      setInitializing(false);
      expect(useSessionStore.getState().isInitializing).toBe(false);
    });

    it('should track ending state', () => {
      const { setEnding } = useSessionStore.getState();
      
      setEnding(true);
      expect(useSessionStore.getState().isEnding).toBe(true);
      
      setEnding(false);
      expect(useSessionStore.getState().isEnding).toBe(false);
    });
  });
});
