import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock('../../app/hooks/useHaptics', () => ({
  haptic: vi.fn(),
}));

vi.mock('../../app/components/dashboard/sweepLight', () => ({
  useSweepGlow: () => ({ current: null }),
}));

vi.mock('../../app/lib/auth/dev-bypass', () => ({
  authBypassEnabled: false,
  authBypassUserId: null,
}));

vi.mock('../../app/providers', () => ({
  useAuth: () => ({ user: { id: 'user-1' } }),
}));

const sessionStoreState = {
  openSessions: [],
  session: null,
  isLoadingSessions: false,
  refreshOpenSessions: vi.fn().mockResolvedValue(0),
  restoreOpenSession: vi.fn(),
  viewEndedSession: vi.fn(),
  removeOpenSession: vi.fn(),
};

const historyStoreState = {
  sessions: [],
  removeSession: vi.fn(),
};

vi.mock('../../app/stores/session-store', () => ({
  selectIsLoadingSessions: (state: typeof sessionStoreState) => state.isLoadingSessions,
  useSessionStore: (selector: (state: typeof sessionStoreState) => unknown) => selector(sessionStoreState),
}));

vi.mock('../../app/stores/session-history-store', () => ({
  useSessionHistoryStore: (selector: (state: typeof historyStoreState) => unknown) => selector(historyStoreState),
}));

import { RecentSessionsSidebar } from '../../app/components/dashboard/DashboardSidebar';
import { NavRail } from '../../app/components/dashboard/NavRail';

function DashboardNavigationHarness() {
  const [expanded, setExpanded] = React.useState(false);

  return (
    <>
      <NavRail
        onToggleSessions={() => setExpanded((value) => !value)}
        sessionsExpanded={expanded}
        sessionCount={0}
        onOpenSettings={vi.fn()}
      />
      <RecentSessionsSidebar isExpanded={expanded} onToggle={() => setExpanded(false)} />
    </>
  );
}


describe('Dashboard navigation contract', () => {
  it('uses NavRail as the only collapsed Sessions trigger and the sidebar as expanded content', async () => {
    const user = userEvent.setup();

    render(<DashboardNavigationHarness />);

    expect(screen.getByRole('button', { name: 'Sessions' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Collapse sessions' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Sessions' }));

    expect(screen.getByRole('button', { name: 'Collapse sessions' })).toBeInTheDocument();
  });
});