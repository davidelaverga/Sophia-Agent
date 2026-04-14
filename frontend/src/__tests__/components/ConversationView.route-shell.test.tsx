import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

const applyQuickPrompt = vi.fn()
const setMode = vi.fn()
const setManualOverride = vi.fn()

vi.mock('../../app/stores/chat-store', () => ({
  useChatStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      applyQuickPrompt,
      lastCompletedTurnId: 'turn-1',
      isLocked: false,
    }),
}))

vi.mock('../../app/hooks/useReflectionPrompt', () => ({
  useReflectionPrompt: () => ({ chunks: null, dismiss: vi.fn() }),
}))

vi.mock('../../app/stores/ui-store', () => ({
  useUiStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      mode: 'text',
      setMode,
      setManualOverride,
      isManualOverride: false,
    }),
}))

vi.mock('../../app/hooks/useModeSwitch', () => ({
  useModeSwitch: () => ({ canAutoSwitch: false }),
}))

vi.mock('../../app/stores/voice-store', () => ({
  useVoiceStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ shouldAutoFallback: () => false }),
}))

vi.mock('../../app/chat/useChatArtifactsPanelActions', () => ({
  useChatArtifactsPanelActions: () => ({
    memoryInlineFeedback: null,
    handleReflectionTap: vi.fn(),
    handleMemoryApprove: vi.fn(),
    handleMemoryReject: vi.fn(),
  }),
}))

vi.mock('../../app/copy', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock('../../app/lib/microphone-debug', () => ({
  diagnoseMicrophoneAccess: vi.fn(async () => ({})),
  isMicrophoneLikelySupported: vi.fn(() => ({ supported: true, issues: [] })),
}))

vi.mock('../../app/components/AppShell', () => ({
  AppShell: ({ actionBar, children }: { actionBar?: React.ReactNode; children: React.ReactNode }) => (
    <div>
      <div data-testid="action-bar">{actionBar}</div>
      <div data-testid="app-shell">{children}</div>
    </div>
  ),
}))

vi.mock('../../app/components/ErrorBoundary', () => ({
  ErrorBoundary: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

vi.mock('../../app/components/SessionFeedbackToast', () => ({
  SessionFeedbackToast: () => <div data-testid="session-feedback-toast" />,
}))

vi.mock('../../app/components/ModeToggle', () => ({
  ModeToggle: () => <div data-testid="mode-toggle" />,
}))

vi.mock('../../app/components/ConnectionStatusBanner', () => ({
  ConnectionStatusBanner: () => <div data-testid="connection-status-banner" />,
}))

vi.mock('../../app/components/DevDiagnosticsPanel', () => ({
  DevDiagnosticsPanel: () => <div data-testid="dev-diagnostics" />,
}))

vi.mock('../../app/components/session', () => ({
  ArtifactsPanel: () => <div data-testid="artifacts-panel" />,
}))

vi.mock('../../app/components/error-boundaries', () => ({
  ArtifactsPanelErrorBoundary: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

vi.mock('../../app/components/session/InterruptCard', () => ({
  InterruptCard: () => <div data-testid="interrupt-card" />,
}))

vi.mock('../../app/components/ui/RetryAction', () => ({
  RetryAction: () => <div data-testid="retry-action" />,
}))

vi.mock('../../app/components/chat', () => ({
  Transcript: () => <div data-testid="transcript" />,
  Composer: () => <div data-testid="composer" />,
}))

import { ConversationView } from '../../app/components/ConversationView'

describe('ConversationView route shell', () => {
  it('renders the chat shell from route experience outputs', () => {
    render(
      <ConversationView
        routeExperience={{
          conversationId: 'chat-1',
          threadId: 'thread-1',
          recapArtifacts: undefined,
          setRecapArtifacts: vi.fn(),
          chatArtifacts: { takeaway: 'Stay with the calmer thread.' },
          builderArtifact: null,
          builderTask: null,
          clearBuilderTask: vi.fn(),
          cancelBuilderTask: vi.fn(async () => undefined),
          isCancellingBuilderTask: false,
          voiceState: {
            stage: 'idle',
            hasRetryableVoiceTurn: () => false,
            retryLastVoiceTurn: async () => false,
            resetVoiceState: vi.fn(),
          } as never,
          pendingInterrupt: null,
          interruptQueue: [],
          isResuming: false,
          resumeError: null,
          canRetryResume: false,
          handleInterruptSelect: vi.fn(async () => undefined),
          handleInterruptSnooze: vi.fn(),
          handleInterruptDismiss: vi.fn(),
          handleResumeRetry: vi.fn(async () => undefined),
          clearResumeError: vi.fn(),
        }}
      />
    )

    expect(screen.getByTestId('connection-status-banner')).toBeInTheDocument()
    expect(screen.getByTestId('mode-toggle')).toBeInTheDocument()
    expect(screen.getByTestId('transcript')).toBeInTheDocument()
    expect(screen.getByTestId('artifacts-panel')).toBeInTheDocument()
    expect(screen.getByTestId('composer')).toBeInTheDocument()
  })
})