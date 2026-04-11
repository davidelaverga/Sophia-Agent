import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const resolveDashboardBootstrapStateMock = vi.fn();
const useSessionStoreMock = vi.fn();
const useConnectivityStoreMock = vi.fn();
const useUiStoreMock = vi.fn();
const showToastMock = vi.fn();
const startSessionMock = vi.fn();
const startSessionEntryMock = vi.fn();
const endSessionMock = vi.fn();
let sessionStartLoadingMock = false;

vi.mock('../../app/lib/dashboard-bootstrap-orchestration', () => ({
  resolveDashboardBootstrapState: (...args: unknown[]) => resolveDashboardBootstrapStateMock(...args),
}));

vi.mock('../../app/lib/recent-session-end', () => ({
  getRecentSessionEndHint: () => null,
  clearRecentSessionEndHint: vi.fn(),
  markRecentSessionEnd: vi.fn(),
}));

vi.mock('../../app/providers', () => ({
  useAuth: () => ({
    user: { id: 'user-1' },
    loading: false,
    signOut: vi.fn(),
  }),
}));

vi.mock('../../app/hooks/useConnectivity', () => ({
  useConnectivity: vi.fn(),
}));

vi.mock('../../app/hooks/useFocusTrap', () => ({
  useFocusTrap: () => ({ containerRef: { current: null } }),
}));

vi.mock('../../app/hooks/useHaptics', () => ({
  haptic: vi.fn(),
}));

vi.mock('../../app/ThemeBootstrap', () => ({
  setSophiaTheme: vi.fn(),
}));

vi.mock('../../app/lib/telemetry', () => ({
  emitTiming: vi.fn(),
}));

vi.mock('../../app/stores/ui-store', () => ({
  useUiStore: (selector: (state: { showToast: (...args: unknown[]) => void }) => unknown) => {
    const state = {
      showToast: showToastMock,
    };
    useUiStoreMock(selector);
    return selector(state);
  },
}));

vi.mock('../../app/stores/connectivity-store', () => ({
  selectStatus: (state: { status: string }) => state.status,
  useConnectivityStore: (selector: (state: { status: string }) => unknown) => {
    const state = { status: 'online' };
    useConnectivityStoreMock(selector);
    return selector(state);
  },
}));

vi.mock('../../app/stores/session-store', () => {
  const sessionState = {
    session: null,
    isInitializing: false,
    isEnding: false,
    error: null,
    createSession: vi.fn(),
    updateSession: vi.fn(),
    updateFromBackend: vi.fn(),
    pauseSession: vi.fn(),
    resumeSession: vi.fn(),
    endSession: vi.fn(),
    clearSession: vi.fn(),
    setError: vi.fn(),
    setInitializing: vi.fn(),
    setEnding: vi.fn(),
    incrementCompanionInvokes: vi.fn(),
    storeArtifacts: vi.fn(),
    updateMessages: vi.fn(),
    getSessionContext: vi.fn(),
    isSessionActive: () => false,
  };

  const selectIsSessionActive = (state: typeof sessionState) => state.session?.isActive ?? false;
  const selectSession = (state: typeof sessionState) => state.session;
  const selectSessionSummary = () => null;

  return {
    selectIsSessionActive,
    selectSession,
    selectSessionSummary,
    useSessionStore: (selector: (state: typeof sessionState) => unknown) => {
      useSessionStoreMock(selector);
      return selector(sessionState);
    },
  };
});

vi.mock('../../app/hooks/useSessionStart', () => ({
  useSessionStart: () => ({
    start: startSessionMock,
    startSessionEntry: startSessionEntryMock,
    checkActiveSession: vi.fn().mockResolvedValue({ has_active_session: false }),
    isLoading: sessionStartLoadingMock,
  }),
}));

vi.mock('../../app/lib/api/bootstrap-api', () => ({
  fetchBootstrapOpener: vi.fn(),
}));

vi.mock('../../app/lib/api/sessions-api', () => ({
  endSession: (...args: unknown[]) => endSessionMock(...args),
  isSuccess: (value: { success?: boolean } | null | undefined) => Boolean(value?.success),
}));

vi.mock('../../app/components/dashboard/EnhancedFieldBackground', () => ({
  EnhancedFieldBackground: () => <div data-testid="field-background" />,
}));

vi.mock('../../app/components/dashboard/RitualOrbit', () => ({
  RitualOrbit: () => <div data-testid="ritual-orbit" />,
}));

vi.mock('../../app/components/dashboard/ContextTabs', () => ({
  ContextTabs: () => <div data-testid="context-tabs" />,
}));

vi.mock('../../app/components/ThemeToggle', () => ({
  ThemeToggle: () => <button type="button">Theme</button>,
}));

vi.mock('../../app/components/HistoryDrawer', () => ({
  HistoryDrawer: () => <div data-testid="history-drawer" />,
}));

vi.mock('../../app/components/dashboard/SettingsDrawer', () => ({
  SettingsDrawer: () => <div data-testid="settings-drawer" />,
}));

vi.mock('../../app/components/session/ResumeBanner', () => ({
  ResumeBanner: ({ onStartFresh }: { onStartFresh: () => void }) => (
    <div data-testid="resume-banner">
      Resume banner visible
      <button type="button" onClick={onStartFresh}>Start fresh from resume</button>
    </div>
  ),
}));

import { EnhancedFieldDashboard } from '../../app/components/EnhancedFieldDashboard';

describe('EnhancedFieldDashboard bootstrap UI precedence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStartLoadingMock = false;
    startSessionMock.mockReset();
    startSessionEntryMock.mockReset();
    endSessionMock.mockReset();
    showToastMock.mockReset();
  });

  it('renders ResumeBanner and suppresses opener when state resolves to resume-backend', async () => {
    resolveDashboardBootstrapStateMock.mockResolvedValue({
      mode: 'resume-backend',
      session: {
        session_id: 'sess-active',
        session_type: 'prepare',
        preset_context: 'gaming',
        started_at: new Date().toISOString(),
        turn_count: 2,
      },
    });

    render(<EnhancedFieldDashboard />);

    await waitFor(() => {
      expect(screen.getByTestId('resume-banner')).toBeInTheDocument();
    });

    expect(screen.queryByText(/i suggest a/i)).not.toBeInTheDocument();
  });

  it('renders opener and hides ResumeBanner when state resolves to opener', async () => {
    resolveDashboardBootstrapStateMock.mockResolvedValue({
      mode: 'opener',
      opener: {
        opener_text: 'Welcome back. Let us build momentum.',
        suggested_ritual: 'prepare',
        emotional_context: null,
        has_opener: true,
      },
    });

    render(<EnhancedFieldDashboard />);

    await waitFor(() => {
      expect(screen.getByText('Welcome back. Let us build momentum.')).toBeInTheDocument();
    });

    expect(screen.queryByTestId('resume-banner')).not.toBeInTheDocument();
  });

  it('keeps ResumeBanner hidden while a session launch is loading', async () => {
    sessionStartLoadingMock = true;
    resolveDashboardBootstrapStateMock.mockResolvedValue({
      mode: 'resume-backend',
      session: {
        session_id: 'sess-active',
        session_type: 'prepare',
        preset_context: 'gaming',
        started_at: new Date().toISOString(),
        turn_count: 2,
      },
    });

    render(<EnhancedFieldDashboard />);

    await waitFor(() => {
      expect(resolveDashboardBootstrapStateMock).not.toHaveBeenCalled();
    });

    expect(screen.queryByTestId('resume-banner')).not.toBeInTheDocument();
  });

  it('asks whether to reuse the ritual before starting fresh from resume', async () => {
    const user = userEvent.setup();
    resolveDashboardBootstrapStateMock.mockResolvedValue({
      mode: 'resume-backend',
      session: {
        session_id: 'sess-active',
        session_type: 'prepare',
        preset_context: 'gaming',
        started_at: new Date().toISOString(),
        turn_count: 2,
      },
    });
    endSessionMock.mockResolvedValue({
      success: true,
      data: {
        status: 'ended',
        session_id: 'sess-active',
        ended_at: new Date().toISOString(),
        duration_minutes: 3,
        turn_count: 2,
        offer_debrief: false,
      },
    });
    startSessionEntryMock.mockResolvedValue({
      success: true,
      sessionId: 'sess-new',
      threadId: 'thread-new',
      greetingMessage: 'Hello again.',
      messageId: 'msg-1',
      memoryHighlights: [],
      isResumed: false,
      hasMemory: false,
    });

    render(<EnhancedFieldDashboard />);

    await waitFor(() => {
      expect(screen.getByTestId('resume-banner')).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: 'Start fresh from resume' }));

    expect(screen.getByRole('dialog', { name: 'Start fresh' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Same ritual' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Choose ritual' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Same ritual' }));

    await waitFor(() => {
      expect(endSessionMock).toHaveBeenCalledWith({
        session_id: 'sess-active',
        offer_debrief: false,
      });
    });

    expect(startSessionEntryMock).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'user-1',
      preset: 'prepare',
      contextMode: 'gaming',
    }));
  });
});