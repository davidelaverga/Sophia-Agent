import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const pushMock = vi.fn();
const hapticMock = vi.fn();
const showToastMock = vi.fn();
const refreshRecentSessionsMock = vi.fn();
const refreshOpenSessionsMock = vi.fn();
const listSessionsMock = vi.fn(async (
  _userId?: string,
  _options?: { limit?: number; status?: 'open' | 'paused' | 'ended' },
) => ({ success: true, data: { sessions: [], total: 0 } }));
const restoreOpenSessionMock = vi.fn();
const viewEndedSessionMock = vi.fn();
const clearSessionMock = vi.fn();
const removeAllSessionsMock = vi.fn();
const removeOpenSessionMock = vi.fn();
const removeRecentSessionMock = vi.fn();
const clearHistoryMock = vi.fn();
const removeHistorySessionMock = vi.fn();

const sessionStoreState = {
  openSessions: [],
  recentSessions: [],
  isLoadingSessions: false,
  refreshOpenSessions: refreshOpenSessionsMock,
  refreshRecentSessions: refreshRecentSessionsMock,
  restoreOpenSession: restoreOpenSessionMock,
  viewEndedSession: viewEndedSessionMock,
  clearSession: clearSessionMock,
  removeAllSessions: removeAllSessionsMock,
  removeOpenSession: removeOpenSessionMock,
  removeRecentSession: removeRecentSessionMock,
  session: null,
};

const historyStoreState = {
  sessions: [],
  clearHistory: clearHistoryMock,
  removeSession: removeHistorySessionMock,
  syncSessions: vi.fn(),
};

const authState = { user: { id: 'user-1' } };

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock }),
}));

vi.mock('../../app/hooks/useHaptics', () => ({
  haptic: (...args: unknown[]) => hapticMock(...args),
}));

vi.mock('../../app/stores/ui-store', () => ({
  useUiStore: (selector: (state: { showToast: typeof showToastMock }) => unknown) => selector({ showToast: showToastMock }),
}));

vi.mock('../../app/providers', () => ({
  useAuth: () => authState,
}));

vi.mock('../../app/lib/auth/dev-bypass', () => ({
  authBypassEnabled: false,
  authBypassUserId: null,
}));

vi.mock('../../app/lib/api/sessions-api', () => ({
  listSessions: listSessionsMock,
}));

vi.mock('../../app/stores/session-store', () => ({
  selectRecentSessions: (state: typeof sessionStoreState) => state.recentSessions,
  selectIsLoadingSessions: (state: typeof sessionStoreState) => state.isLoadingSessions,
  useSessionStore: (selector: (state: typeof sessionStoreState) => unknown) => selector(sessionStoreState),
}));

vi.mock('../../app/stores/session-history-store', () => ({
  useSessionHistoryStore: (selector: (state: typeof historyStoreState) => unknown) => selector(historyStoreState),
}));

vi.mock('../../app/components/dashboard/sweepLight', () => ({
  useSweepGlow: () => ({ current: null }),
}));

import { RecentSessionsSidebar } from '../../app/components/dashboard/DashboardSidebar';

describe('DashboardSidebar delete feedback', () => {
  beforeEach(() => {
    pushMock.mockReset();
    hapticMock.mockReset();
    showToastMock.mockReset();
    refreshRecentSessionsMock.mockReset();
    refreshOpenSessionsMock.mockReset();
    listSessionsMock.mockClear();
    restoreOpenSessionMock.mockReset();
    viewEndedSessionMock.mockReset();
    clearSessionMock.mockReset();
    removeAllSessionsMock.mockReset();
    removeOpenSessionMock.mockReset();
    removeRecentSessionMock.mockReset();
    clearHistoryMock.mockReset();
    removeHistorySessionMock.mockReset();

    sessionStoreState.recentSessions = [
      {
        session_id: 'sess-1',
        thread_id: 'thread-1',
        session_type: 'open',
        preset_context: 'life',
        status: 'open',
        started_at: '2026-04-15T00:00:00.000Z',
        updated_at: '2026-04-15T00:05:00.000Z',
        ended_at: null,
        turn_count: 2,
        title: 'Preparing for investor meeting',
        last_message_preview: 'I need to prepare for my investor meeting tomorrow',
        platform: 'text',
        intention: null,
        focus_cue: null,
      },
    ];
    sessionStoreState.openSessions = [...sessionStoreState.recentSessions];
    sessionStoreState.isLoadingSessions = false;
    sessionStoreState.session = null;
    historyStoreState.sessions = [];
    authState.user = { id: 'user-1' };
  });

  it('shows deleting feedback and success toast when removing a session', async () => {
    removeOpenSessionMock.mockResolvedValue(true);
    const user = userEvent.setup();

    render(<RecentSessionsSidebar isExpanded={true} onToggle={vi.fn()} />);

    await user.click(screen.getByLabelText('Delete session'));
    await user.click(screen.getByLabelText('Confirm delete'));

    expect(screen.getByText('Deleting...')).toBeInTheDocument();

    await waitFor(() => {
      expect(removeOpenSessionMock).toHaveBeenCalledWith('sess-1', undefined);
    });

    expect(showToastMock).toHaveBeenCalledWith(expect.objectContaining({
      message: 'Deleted Preparing for investor meeting.',
      variant: 'success',
    }));
    expect(hapticMock).toHaveBeenCalledWith('success');
  });

  it('shows clear-all confirmation and success toast when removing all sessions', async () => {
    removeAllSessionsMock.mockResolvedValue({ ok: true, deleted_count: 1, session_ids: ['sess-1'] });
    const user = userEvent.setup();

    render(<RecentSessionsSidebar isExpanded={true} onToggle={vi.fn()} />);

    await user.click(screen.getByLabelText('Clear all sessions'));
    await user.click(screen.getByLabelText('Confirm clear all sessions'));

    expect(screen.getByText('Clearing...')).toBeInTheDocument();

    await waitFor(() => {
      expect(removeAllSessionsMock).toHaveBeenCalledWith(undefined);
    });

    expect(clearHistoryMock).toHaveBeenCalledTimes(1);
    expect(showToastMock).toHaveBeenCalledWith(expect.objectContaining({
      message: 'Cleared 1 session.',
      variant: 'success',
    }));
    expect(hapticMock).toHaveBeenCalledWith('success');
  });
});
