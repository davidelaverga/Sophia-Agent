import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const pushMock = vi.fn();
const refreshOpenSessionsMock = vi.fn();
const syncSessionsMock = vi.fn();
const listSessionsMock = vi.fn(async (
  _userId?: string,
  _options?: { limit?: number; status?: 'open' | 'paused' | 'ended' },
) => ({ success: true, data: { sessions: [], total: 0 } }));

const sessionStoreState = {
  openSessions: [],
  session: null,
  refreshOpenSessions: refreshOpenSessionsMock,
  restoreOpenSession: vi.fn(),
  viewEndedSession: vi.fn(),
  removeOpenSession: vi.fn(),
  isLoadingSessions: false,
};

const historyStoreState = {
  sessions: [],
  removeSession: vi.fn(),
  syncSessions: syncSessionsMock,
};

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock }),
}));

vi.mock('../../app/hooks/useHaptics', () => ({
  haptic: vi.fn(),
}));

vi.mock('../../app/lib/auth/dev-bypass', () => ({
  authBypassEnabled: false,
  authBypassUserId: null,
}));

vi.mock('../../app/lib/api/sessions-api', () => ({
  listSessions: listSessionsMock,
}));

vi.mock('../../app/providers', () => ({
  useAuth: () => ({ user: { id: 'user-1' } }),
}));

vi.mock('../../app/stores/session-store', () => ({
  selectIsLoadingSessions: (state: typeof sessionStoreState) => state.isLoadingSessions,
  useSessionStore: (selector: (state: typeof sessionStoreState) => unknown) => selector(sessionStoreState),
}));

vi.mock('../../app/stores/session-history-store', () => ({
  useSessionHistoryStore: (selector: (state: typeof historyStoreState) => unknown) => selector(historyStoreState),
}));

vi.mock('../../app/lib/api/sessions-api', () => ({
  listSessions: listSessionsMock,
}));

vi.mock('../../app/components/dashboard/sweepLight', () => ({
  useSweepGlow: () => ({ current: null }),
}));

import { RecentSessionsSidebar } from '../../app/components/dashboard/DashboardSidebar';

describe('RecentSessionsSidebar toggle visibility', () => {
  beforeEach(() => {
    pushMock.mockReset();
    refreshOpenSessionsMock.mockReset();
    syncSessionsMock.mockReset();
    listSessionsMock.mockClear();
    sessionStoreState.openSessions = [];
    sessionStoreState.session = null;
    sessionStoreState.isLoadingSessions = false;
    historyStoreState.sessions = [];
  });

  it('does not render a duplicate sessions toggle while collapsed', () => {
    render(<RecentSessionsSidebar isExpanded={false} onToggle={vi.fn()} />);

    expect(screen.queryByPlaceholderText('Search sessions…')).not.toBeInTheDocument();
    expect(screen.queryByTitle('View sessions')).not.toBeInTheDocument();
  });

  it('renders sessions browser only when expanded', () => {
    render(<RecentSessionsSidebar isExpanded={true} onToggle={vi.fn()} />);

    expect(screen.getByPlaceholderText('Search sessions…')).toBeInTheDocument();
  });
});