import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const resolveDashboardBootstrapStateMock = vi.fn();
const useSessionStoreMock = vi.fn();
const useConnectivityStoreMock = vi.fn();
const useUiStoreMock = vi.fn();
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
  useSupabase: () => ({
    user: { id: 'user-1' },
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
      showToast: vi.fn(),
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
    start: vi.fn(),
    startSessionEntry: vi.fn(),
    checkActiveSession: vi.fn().mockResolvedValue({ has_active_session: false }),
    isLoading: sessionStartLoadingMock,
  }),
}));

vi.mock('../../app/lib/api/bootstrap-api', () => ({
  fetchBootstrapOpener: vi.fn(),
}));

vi.mock('../../app/lib/api/sessions-api', () => ({
  endSession: vi.fn(),
  isSuccess: vi.fn(() => true),
}));

vi.mock('../../app/components/dashboard', () => ({
  CONTEXTS: [
    { value: 'gaming', title: 'Gaming', subtitle: 'sub' },
    { value: 'work', title: 'Work', subtitle: 'sub' },
    { value: 'life', title: 'Life', subtitle: 'sub' },
  ],
  RITUALS: [
    { type: 'prepare', labels: { gaming: { title: 'Prepare' }, work: { title: 'Prepare' }, life: { title: 'Prepare' } } },
    { type: 'debrief', labels: { gaming: { title: 'Debrief' }, work: { title: 'Debrief' }, life: { title: 'Debrief' } } },
    { type: 'reset', labels: { gaming: { title: 'Reset' }, work: { title: 'Reset' }, life: { title: 'Reset' } } },
    { type: 'vent', labels: { gaming: { title: 'Vent' }, work: { title: 'Vent' }, life: { title: 'Vent' } } },
  ],
  DashboardCosmicBackground: () => <div data-testid="bg" />,
  ContextTabs: () => <div data-testid="context-tabs" />,
  MicCTA: () => <button type="button">Mic</button>,
  RitualCard: ({ ritual }: { ritual: { type: string } }) => <div>{ritual.type}</div>,
}));

vi.mock('../../app/components/dashboard/DashboardSidebar', () => ({
  MobileFloatingButtons: () => <div data-testid="mobile-buttons" />,
}));

vi.mock('../../app/components/HistoryDrawer', () => ({
  HistoryDrawer: () => <div data-testid="history-drawer" />,
}));

vi.mock('../../app/components/session/ResumeBanner', () => ({
  ResumeBanner: () => <div data-testid="resume-banner">Resume banner visible</div>,
}));

import { VoiceFirstDashboard } from '../../app/components/VoiceFirstDashboard';

describe('VoiceFirstDashboard bootstrap UI precedence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStartLoadingMock = false;
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

    render(<VoiceFirstDashboard />);

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

    render(<VoiceFirstDashboard />);

    await waitFor(() => {
      expect(screen.getByText('Welcome back. Let us build momentum.')).toBeInTheDocument();
    });

    expect(screen.queryByTestId('resume-banner')).not.toBeInTheDocument();
    // Suggested ritual is auto-selected rather than displayed as separate text
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

    render(<VoiceFirstDashboard />);

    await waitFor(() => {
      expect(resolveDashboardBootstrapStateMock).not.toHaveBeenCalled();
    });

    expect(screen.queryByTestId('resume-banner')).not.toBeInTheDocument();
  });
});
