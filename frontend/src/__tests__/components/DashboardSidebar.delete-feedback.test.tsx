import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const pushMock = vi.fn();
const hapticMock = vi.fn();
const showToastMock = vi.fn();
const refreshOpenSessionsMock = vi.fn();
const setActiveSessionMock = vi.fn();
const viewEndedSessionMock = vi.fn();
const removeOpenSessionMock = vi.fn();
const removeEndedSessionMock = vi.fn();

const sessionStoreState = {
  openSessions: [],
  isLoadingSessions: false,
  refreshOpenSessions: refreshOpenSessionsMock,
  setActiveSession: setActiveSessionMock,
  viewEndedSession: viewEndedSessionMock,
  removeOpenSession: removeOpenSessionMock,
  session: null,
};

const historyStoreState = {
  sessions: [],
  removeSession: removeEndedSessionMock,
};

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock }),
}));

vi.mock('../../app/hooks/useHaptics', () => ({
  haptic: (...args: unknown[]) => hapticMock(...args),
}));

vi.mock('../../app/stores/ui-store', () => ({
  useUiStore: (selector: (state: { showToast: typeof showToastMock }) => unknown) => selector({ showToast: showToastMock }),
}));

vi.mock('../../app/stores/session-store', () => ({
  selectOpenSessions: (state: typeof sessionStoreState) => state.openSessions,
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
    refreshOpenSessionsMock.mockReset();
    setActiveSessionMock.mockReset();
    viewEndedSessionMock.mockReset();
    removeOpenSessionMock.mockReset();
    removeEndedSessionMock.mockReset();

    sessionStoreState.openSessions = [
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
    sessionStoreState.isLoadingSessions = false;
    sessionStoreState.session = null;
    historyStoreState.sessions = [];
  });

  it('shows deleting feedback and success toast when removing a session', async () => {
    removeOpenSessionMock.mockResolvedValue(true);
    const user = userEvent.setup();

    render(<RecentSessionsSidebar isExpanded={true} onToggle={vi.fn()} />);

    await user.click(screen.getByLabelText('Delete session'));
    await user.click(screen.getByLabelText('Confirm delete'));

    expect(screen.getByText('Deleting...')).toBeInTheDocument();

    await waitFor(() => {
      expect(removeOpenSessionMock).toHaveBeenCalledWith('sess-1');
    });

    expect(showToastMock).toHaveBeenCalledWith(expect.objectContaining({
      message: 'Deleted Preparing for investor meeting.',
      variant: 'success',
    }));
    expect(hapticMock).toHaveBeenCalledWith('success');
  });
});
