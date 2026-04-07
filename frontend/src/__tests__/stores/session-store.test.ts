/**
 * Tests for Session Store
 * Critical: validates session lifecycle, persistence, and state management
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock error-logger before importing store
vi.mock('../../app/lib/error-logger', () => ({
  logger: {
    debug: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
  },
}));

// Import after mocking
import { useSessionStore } from '../../app/stores/session-store';

describe('Session Store', () => {
  beforeEach(() => {
    // Reset store state before each test
    const { clearSession, setError, setInitializing, setEnding } = useSessionStore.getState();
    clearSession();
    setError(null);
    setInitializing(false);
    setEnding(false);
    
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
