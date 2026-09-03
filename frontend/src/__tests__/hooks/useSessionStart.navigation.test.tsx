import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  clearSession: vi.fn(),
  createSession: vi.fn(),
  getActiveSession: vi.fn(),
  haptic: vi.fn(),
  push: vi.fn(),
  restoreOpenSession: vi.fn(),
  setError: vi.fn(),
  setInitializing: vi.fn(),
  startSession: vi.fn(),
  updateFromBackend: vi.fn(),
  updateSession: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mocks.push }),
}));

vi.mock('../../app/hooks/useHaptics', () => ({
  haptic: mocks.haptic,
}));

vi.mock('../../app/lib/api/sessions-api', () => ({
  getActiveSession: mocks.getActiveSession,
  getErrorMessage: (result: { error?: string }) => result.error ?? 'Session start failed',
  isSuccess: (result: { success?: boolean }) => result.success === true,
  startSession: mocks.startSession,
}));

vi.mock('../../app/stores/session-store', () => {
  const state = {
    clearSession: mocks.clearSession,
    createSession: mocks.createSession,
    restoreOpenSession: mocks.restoreOpenSession,
    setError: mocks.setError,
    setInitializing: mocks.setInitializing,
    updateFromBackend: mocks.updateFromBackend,
    updateSession: mocks.updateSession,
  };
  const useSessionStore = Object.assign(
    (selector: (value: typeof state) => unknown) => selector(state),
    { getState: () => ({ session: { memoryHighlights: [] } }) },
  );

  return { useSessionStore };
});

import { useSessionStart } from '../../app/hooks/useSessionStart';

describe('useSessionStart navigation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.restoreOpenSession.mockResolvedValue(undefined);
  });

  it('navigates only after the successful start has committed its loading state', async () => {
    let resolveStart: ((value: unknown) => void) | undefined;
    mocks.startSession.mockReturnValue(new Promise((resolve) => {
      resolveStart = resolve;
    }));

    const hook = renderHook(() => useSessionStart());

    let startPromise: ReturnType<typeof hook.result.current.start> | undefined;
    await act(async () => {
      startPromise = hook.result.current.start('user-1', 'open', 'life', { voiceMode: true });
      await Promise.resolve();
    });

    expect(hook.result.current.isLoading).toBe(true);
    expect(mocks.push).not.toHaveBeenCalled();

    await act(async () => {
      resolveStart?.({
        success: true,
        data: {
          session_id: 'session-1',
          thread_id: 'thread-1',
          greeting_message: 'Hello',
          message_id: 'message-1',
          memory_highlights: [],
          is_resumed: false,
          briefing_source: 'none',
          has_memory: false,
          session_type: 'open',
          preset_context: 'life',
          started_at: '2026-09-03T00:00:00Z',
        },
      });
      await startPromise;
    });

    expect(hook.result.current.isLoading).toBe(false);
    expect(mocks.push).toHaveBeenCalledOnce();
    expect(mocks.push).toHaveBeenCalledWith('/session');
    const loadingClearedCall = mocks.setInitializing.mock.calls.findIndex(([value]) => value === false);
    expect(loadingClearedCall).toBeGreaterThanOrEqual(0);
    expect(mocks.push.mock.invocationCallOrder[0]).toBeGreaterThan(
      mocks.setInitializing.mock.invocationCallOrder[loadingClearedCall],
    );
    expect(mocks.haptic).toHaveBeenCalledWith('medium');
  });
});
